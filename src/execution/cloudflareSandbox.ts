import { BASH_TIMEOUT_MS, EXEC_CALL_MARGIN_MS, clampBashTimeout } from "./bashTimeout.js";
import {
  ExecCapacityError,
  ExecInfraError,
  execDeadline,
  truncate,
  type ExecOptions,
  type Executor,
} from "./executor.js";
import type { ExecTraceOptions } from "./executor.js";
import {
  FLEET_BUSY_BACKOFF_MS,
  FLEET_BUSY_REASON,
  FLEET_BUSY_WAIT_MAX_MS,
  fleetBusyExhaustedMessage,
} from "./sandboxErrors.js";
import { tracedFetch } from "../core/trace/tracedFetch.js";
import type { Span } from "../core/trace/types.js";

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
   *  call and sent as `env` in the request body — the Worker applies them to
   *  that one command, so each command carries the credential current at its
   *  own start, never one captured when the run began (a run-start token
   *  that expires under a 20-minute first command would leave every later
   *  command carrying it dead). */
  resolveEnvs: () => Promise<Record<string, string>>;
  /** resident repo/ref context — reserved for resident environments (not yet used) */
  repo?: string;
  ref?: string;
}

/** The Worker named a full fleet (docs/reference/specs/execution.md item 14): in-body on
 *  the streamed /exec answer, or as an HTTP 503 on /read and /write. Matched on
 *  the machine token only — an older Worker's bare SDK message stays an
 *  ordinary in-body error (infra), so a bot deployed ahead of its Worker
 *  changes nothing. */
function isFleetBusyAnswer(res: Response, data: Record<string, unknown>): boolean {
  return (res.ok || res.status === 503) && data.reason === FLEET_BUSY_REASON;
}

/** The bot-side wait for ONE send: the operation's budget plus the margin
 *  that lets the Worker's own answer (a streamed exit 124 at the command
 *  budget) win the race against this deadline (docs/reference/specs/execution.md item
 *  11). Every route has one: without it a single `/exec` whose sandbox
 *  container is gone can wait for hours — the Worker keeps heartbeating while
 *  its exec promise never settles, and a body read with no deadline sits out
 *  the whole thing. */
function sendDeadlineMs(budgetMs: number): number {
  return budgetMs + EXEC_CALL_MARGIN_MS;
}

/** The infra error for a send the Worker never answered inside its deadline:
 *  names both numbers, so the reader sees which budget the wait was sized
 *  from, and says what may still be true inside the sandbox. */
function noAnswerMessage(route: string, budgetMs: number): string {
  const secs = (ms: number) => Math.round(ms / 1000);
  const exec = route === "/exec";
  return (
    `sandbox worker ${route} gave no answer within ${secs(sendDeadlineMs(budgetMs))}s ` +
    `(${exec ? "command budget" : "budget"} ${secs(budgetMs)}s + ${secs(EXEC_CALL_MARGIN_MS)}s margin) — ` +
    `the sandbox may be gone; ${exec ? "the command may still be running in it" : "the operation may still have run in it"}`
  );
}

/** Resolve after `ms`, or reject with `ExecCapacityError` the moment `signal`
 *  fires — a hard stop must not sit out a fleet wait. */
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
   *  (same route, body — env included —, headers; the envs resolved once
   *  here, so the wait never mints a new credential mid-command) after 10 s,
   *  20 s, then 30 s, until the total wait reaches `budgetMs` capped at
   *  FLEET_BUSY_WAIT_MAX_MS; then throws `ExecCapacityError` (never
   *  `ExecInfraError` — a full fleet is not a dead sandbox, item 14). Safe to
   *  re-send by construction: the Worker answers busy only when session
   *  creation failed, before the command or file op ever started.
   *
   *  `budgetMs` is the operation's own budget — the command's clamped
   *  `timeoutMs` for /exec, BASH_TIMEOUT_MS for a file op (the bound the
   *  resident client gives its file routes) — and sizes two waits: the fleet
   *  wait above, and the per-SEND deadline (`budgetMs` + EXEC_CALL_MARGIN_MS)
   *  each send runs under. Time spent waiting for a slot never eats into a
   *  send's deadline: nothing ran during it. */
  private async call(
    route: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    budgetMs: number = BASH_TIMEOUT_MS,
    span?: Span,
  ): Promise<Record<string, unknown>> {
    const envs = await this.opts.resolveEnvs();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.token}`,
      "x-thread-key": this.opts.threadKey,
    };
    // The env map rides in the BODY on every route (the Worker uses it only
    // for /exec, but one shape everywhere) — the ONLY channel. Workers Logs
    // record an invocation's request headers and redact them by a name
    // heuristic only — a per-variable header whose name does not look
    // sensitive is logged in clear — while bodies are not recorded. So no
    // credential ever rides in a header.
    const sent: Record<string, unknown> = { ...body, env: envs };

    const budget = Math.min(budgetMs, FLEET_BUSY_WAIT_MAX_MS);
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      const answer = await this.send(route, sent, headers, budgetMs, signal, span);
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
   *  `ExecInfraError` here, after exactly one send for an in-body error.
   *  Each attempt — headers AND body — runs under its own deadline of
   *  `budgetMs` + EXEC_CALL_MARGIN_MS joined with the hard-stop signal. */
  private async send(
    route: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    budgetMs: number,
    signal?: AbortSignal,
    span?: Span,
  ): Promise<{ kind: "ok"; data: Record<string, unknown> } | { kind: "busy" }> {
    // Sandbox cold starts can 5xx on a thread's first command — retry briefly.
    const delays = [0, 3000, 6000, 12000];
    let lastErr = "";
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      let res: Response;
      let text: string;
      // The deadline covers the whole exchange: `/exec` answers HTTP 200 at
      // once and streams heartbeat whitespace until the command's outcome, so
      // a Worker whose sandbox died mid-command keeps the body open forever
      // — the body read is where that wait sits, not the headers.
      const deadline = execDeadline(sendDeadlineMs(budgetMs), signal);
      try {
        // One `http.client` span per send under the caller's (docs/reference/specs/tracing.md
        // item 21); the trace context rides only because the sandbox is ours.
        res = await tracedFetch(
          span,
          `${this.opts.url.replace(/\/$/, "")}${route}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            // A hard run stop drops the bot-side request. The sandbox
            // Worker has no kill route, so the command itself runs on to its own
            // `timeout` inside the sandbox — the runner has already moved on.
            signal: deadline,
          },
          { route },
        );
        text = await res.text();
      } catch (err) {
        // The Worker gave no answer inside the deadline (and the run was not
        // stopped): the sandbox may be gone, or its Durable Object hung —
        // either way an infra failure that fail-fast counts, never an
        // indefinite wait. A hard stop takes the generic path below: the
        // runner has already moved on and does not read the message.
        if (deadline.aborted && !signal?.aborted) throw new ExecInfraError(noAnswerMessage(route, budgetMs));
        // Network-level failure ("fetch failed"): undici drops the connection
        // after ~300s without response headers, so a command that outlives the
        // sandbox's COMMAND_TIMEOUT_MS margin surfaces here, not as exit 124.
        // Don't retry — the command may have side effects and may still be
        // running in the sandbox; give the agent a legible error instead. Infra
        // (not a command exit): the runner counts these toward fail-fast.
        throw new ExecInfraError(
          `sandbox worker ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
            "The command may still be running or have been killed mid-flight in the sandbox; " +
            "re-check its effects before re-running it.",
        );
      }
      // Heartbeat whitespace around one JSON document parses unchanged; a
      // non-JSON body (an edge error page) is {} and the status speaks below.
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text.trim() || "{}") as Record<string, unknown>;
      } catch {
        // fall through with {} — the HTTP status decides
      }
      // A full fleet is the ONE answer that is re-sent (by `call`): the Worker
      // names it only when no session could be created, so nothing ran.
      if (isFleetBusyAnswer(res, data)) return { kind: "busy" };
      // A success body has no `error` key at all, so a PRESENT but empty
      // `error` is the Worker's failure shape with its text missing — infra,
      // not a command exit. A thread placed on a previous-image container
      // during a rollout gets `{error: ""}` for every command; a truthy check
      // would let it through as a plain `exit 127`, the health tracker would
      // count a success, and the model would report its shell "down". A bare
      // exit 127 with no output and NO error key is not
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
    // Per-call budget (docs/reference/specs/execution.md item 11): rides in the body only
    // when the caller asked for one, so an older sandbox Worker sees the body
    // it always did (it enforces its tuned 280s limit); the Worker clamps
    // server-side with the same [1s, 20 min] bounds — never this number alone.
    const body: Record<string, unknown> = { command };
    if (opts?.timeoutMs !== undefined) body.timeoutMs = clampBashTimeout(opts.timeoutMs);
    // The fleet wait may spend up to the command's own budget (item 14) — a
    // command the run gave 60 s should not wait five minutes for a slot.
    const r = await this.call("/exec", body, opts?.signal, clampBashTimeout(opts?.timeoutMs), opts?.span);
    const parts = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = Number(r.exitCode ?? 0);
    if (exitCode !== 0) return truncate(`exit ${exitCode}:\n${parts}`);
    return truncate(parts || "(no output)");
  }

  async readFile(path: string, opts?: ExecTraceOptions): Promise<string> {
    const r = await this.call("/read", { path }, undefined, undefined, opts?.span);
    return truncate(String(r.content ?? ""));
  }

  async writeFile(path: string, content: string, opts?: ExecTraceOptions): Promise<string> {
    await this.call("/write", { path, content }, undefined, undefined, opts?.span);
    return `Wrote ${path}`;
  }
}
