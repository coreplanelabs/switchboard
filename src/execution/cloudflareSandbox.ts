import { BASH_TIMEOUT_MS, clampBashTimeout } from "./bashTimeout.js";
import { ExecCapacityError, ExecInfraError, truncate, type ExecOptions, type Executor } from "./executor.js";
import {
  FLEET_BUSY_BACKOFF_MS,
  FLEET_BUSY_REASON,
  FLEET_BUSY_WAIT_MAX_MS,
  fleetBusyExhaustedMessage,
} from "./sandboxErrors.js";

// Remote execution in a Cloudflare Sandbox, via the authenticated proxy Worker
// in deploy/cloudflare-sandbox/ (the Sandbox SDK only runs inside Workers).
// One sandbox per thread — the Worker keys the Durable Object on X-Thread-Key,
// so reconnection is implicit and there is no local state file to maintain.
// Expired/slept sandboxes lose disk; repos re-clone on the next request.

export interface CloudflareSandboxOptions {
  /** Base URL of the deployed proxy Worker. */
  url: string;
  /** Bearer token shared with the Worker (SANDBOX_TOKEN secret). */
  token: string;
  threadKey: string;
  /** Env vars forwarded into the sandbox (e.g. GH_TOKEN), resolved on EVERY
   *  call — the Worker injects them inline per command, so each command
   *  carries the credential current at its own start, never one captured
   *  when the run began (2026-09-07: a run-start token expired under a
   *  20-minute first command and every later command carried it dead). */
  resolveEnvs: () => Promise<Record<string, string>>;
  /** resident repo/ref context — reserved for resident environments (not yet used) */
  repo?: string;
  ref?: string;
}

/** The Worker named a full fleet (features/execution.md item 14): in-body on
 *  the streamed /exec answer, or as an HTTP 503 on /read and /write. Matched on
 *  the machine token only — an older Worker's bare SDK message stays an
 *  ordinary in-body error (infra), so a bot deployed ahead of its Worker
 *  changes nothing. */
function isFleetBusyAnswer(res: Response, data: Record<string, unknown>): boolean {
  return (res.ok || res.status === 503) && data.reason === FLEET_BUSY_REASON;
}

/** Resolve after `ms`, or reject with `ExecCapacityError` the moment `signal`
 *  fires — a hard stop (#101) must not sit out a fleet wait. */
function waitForSlot(ms: number, waitedMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () =>
      new ExecCapacityError(
        `sandbox fleet busy — stopped waiting for a free per-thread sandbox after ${Math.round(waitedMs / 1000)}s: the run was stopped`,
      );
    if (signal?.aborted) return reject(stopped());
    const onAbort = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class CloudflareSandboxExecutor implements Executor {
  constructor(private opts: CloudflareSandboxOptions) {}

  /** One request to the Worker, with the transport-level retries, and the
   *  fleet-busy wait around it: a busy answer re-sends the IDENTICAL request
   *  (same route, body, headers — the envs resolved once here, so the wait
   *  never mints a new credential mid-command) after 10 s, 20 s, then 30 s,
   *  until the total wait reaches `waitBudgetMs` capped at
   *  FLEET_BUSY_WAIT_MAX_MS; then throws `ExecCapacityError` (never
   *  `ExecInfraError` — a full fleet is not a dead sandbox, item 14). Safe to
   *  re-send by construction: the Worker answers busy only when session
   *  creation failed, before the command or file op ever started. */
  private async call(
    route: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    waitBudgetMs: number = BASH_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.token}`,
      "x-thread-key": this.opts.threadKey,
    };
    for (const [k, v] of Object.entries(await this.opts.resolveEnvs())) headers[`x-env-${k}`] = v;

    const budget = Math.min(waitBudgetMs, FLEET_BUSY_WAIT_MAX_MS);
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const answer = await this.send(route, body, headers, signal);
      if (answer.kind === "ok") return answer.data;
      if (waited >= budget) throw new ExecCapacityError(fleetBusyExhaustedMessage(waited));
      const delay = Math.min(
        FLEET_BUSY_BACKOFF_MS[Math.min(attempt, FLEET_BUSY_BACKOFF_MS.length - 1)],
        budget - waited,
      );
      await waitForSlot(delay, waited, signal);
      waited += delay;
    }
  }

  /** One send with the transport-level retries. Returns the parsed answer, or
   *  `busy` when the Worker named a full fleet; every other failure throws
   *  `ExecInfraError` here, after exactly one send for an in-body error. */
  private async send(
    route: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ kind: "ok"; data: Record<string, unknown> } | { kind: "busy" }> {
    // Sandbox cold starts can 5xx on a thread's first command — retry briefly.
    const delays = [0, 3000, 6000, 12000];
    let lastErr = "";
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      let res: Response;
      try {
        res = await fetch(`${this.opts.url.replace(/\/$/, "")}${route}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          // A hard run stop (#101) drops the bot-side request. The sandbox
          // Worker has no kill route, so the command itself runs on to its own
          // `timeout` inside the sandbox — the runner has already moved on.
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        // Network-level failure ("fetch failed"): undici drops the connection
        // after ~300s without response headers, so a command that outlives the
        // sandbox's COMMAND_TIMEOUT_MS margin surfaces here, not as exit 124.
        // Don't retry — the command may have side effects and may still be
        // running in the sandbox; give the agent a legible error instead. Infra
        // (not a command exit): the runner counts these toward fail-fast (#92).
        throw new ExecInfraError(
          `sandbox worker ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
            "The command may still be running or have been killed mid-flight in the sandbox; " +
            "re-check its effects before re-running it.",
        );
      }
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // A full fleet is the ONE answer that is re-sent (by `call`): the Worker
      // names it only when no session could be created, so nothing ran.
      if (isFleetBusyAnswer(res, data)) return { kind: "busy" };
      // A success body has no `error` key at all, so a PRESENT but empty
      // `error` is the Worker's failure shape with its text missing — infra,
      // not a command exit. 2026-09-07 (#569): a thread placed on a
      // previous-image container during a rollout got `{error: ""}` for every
      // command; the truthy check below let it through as a plain `exit 127`,
      // the health tracker counted a success, and the model reported its
      // shell "down". A bare exit 127 with no output and NO error key is not
      // this: `foo 2>/dev/null` is a legitimate silent 127.
      if (res.ok && "error" in data && data.error === "") {
        throw new ExecInfraError(
          `sandbox worker ${route}: failure with an empty message (the Worker's failure shape with its text missing)`,
        );
      }
      // /exec streams its response (heartbeat whitespace + one JSON document,
      // always HTTP 200 since headers are sent before the outcome is known),
      // so failures arrive as {error} in an ok response. Not retried: by the
      // time an in-body error arrives the command may have run — replaying a
      // possibly side-effectful command is worse than reporting the failure.
      if (res.ok && typeof data.error === "string" && data.error) {
        // In-body worker failure — the sandbox's "Command execution failed" /
        // exitCode-127 signal (a wedged sandbox reports this for every command,
        // even a bare echo). Infra, not a command exit — counts toward fail-fast.
        throw new ExecInfraError(`sandbox worker ${route}: ${data.error}`);
      }
      if (res.ok) return { kind: "ok", data };
      lastErr = `sandbox worker ${route} HTTP ${res.status}: ${String(data.error ?? "")}`;
      if (res.status < 500) break; // 4xx is not retryable
    }
    // Exhausted retries against an unreachable worker — infra, not a command exit.
    throw new ExecInfraError(lastErr);
  }

  async exec(command: string, opts?: ExecOptions): Promise<string> {
    // Per-call budget (features/execution.md item 11): rides in the body only
    // when the caller asked for one, so an older sandbox Worker sees the body
    // it always did (it enforces its tuned 280s limit); the Worker clamps
    // server-side with the same [1s, 20 min] bounds — never this number alone.
    const body: Record<string, unknown> = { command };
    if (opts?.timeoutMs !== undefined) body.timeoutMs = clampBashTimeout(opts.timeoutMs);
    // The fleet wait may spend up to the command's own budget (item 14) — a
    // command the run gave 60 s should not wait five minutes for a slot.
    const r = await this.call("/exec", body, opts?.signal, clampBashTimeout(opts?.timeoutMs));
    const parts = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = Number(r.exitCode ?? 0);
    if (exitCode !== 0) return truncate(`exit ${exitCode}:\n${parts}`);
    return truncate(parts || "(no output)");
  }

  async readFile(path: string): Promise<string> {
    const r = await this.call("/read", { path });
    return truncate(String(r.content ?? ""));
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.call("/write", { path, content });
    return `Wrote ${path}`;
  }
}
