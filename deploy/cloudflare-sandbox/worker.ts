// Sandbox proxy Worker: fronts per-thread Cloudflare Sandboxes with a minimal
// authenticated HTTP API the bot's CloudflareSandboxExecutor calls.
//
//   POST /exec   { command, timeoutMs?, env? } -> { stdout, stderr, exitCode }
//   POST /read   { path, env? }             -> { content }
//   POST /write  { path, content, env? }    -> { ok: true }
//   GET  /healthz                           -> { ok: true, build: { commit, builtAt? } }
//
// Every request carries:
//   Authorization: Bearer <SANDBOX_TOKEN>   (wrangler secret put SANDBOX_TOKEN)
//   X-Thread-Key: <threadKey>               (one sandbox per conversation thread)
// and the body's optional `env` ({ NAME: value }) is forwarded into the sandbox
// for that one command — in the body, never in headers, because Workers Logs
// record request headers (features/execution.md item 5, #447).
//
// The Sandbox SDK only runs inside Workers — that's why this proxy exists.
// Verify method names against https://developers.cloudflare.com/sandbox/ on
// first deploy; the SDK is young and its surface may shift.
import { getSandbox, Sandbox, type ExecOptions, type ExecResult } from "@cloudflare/sandbox";
import { BASH_TIMEOUT_MAX_MS, clampBashTimeout } from "../../src/execution/bashTimeout.js";
import {
  EXEC_KEEPALIVE_INTERVAL_MS,
  SANDBOX_SLEEP_AFTER,
  isRecycleError,
  recycledMidCommandMessage,
  withActivityKeepalive,
} from "../../src/execution/sandboxKeepalive.js";
import { envFromRequest } from "../../src/execution/sandboxEnv.js";
import { shellQuote } from "../../src/execution/shellQuote.js";
import {
  fleetBusyAnswer,
  fleetBusyExecAnswer,
  isContainerStarting,
  isFleetBusyError,
  legacyContainerError,
  thrownShape,
  thrownText,
} from "../../src/execution/sandboxErrors.js";
import { injectedBuildStamp } from "../../src/deploy/buildStamp.js";
import sandboxPkg from "./package.json" with { type: "json" };

/** The `@cloudflare/sandbox` version this Worker is built against — the pin
 *  `check:sandbox-pair` holds equal to the Dockerfile's image tag, so it is
 *  also the version a container on the CURRENT image reports. */
const SDK_PIN: string = sandboxPkg.dependencies["@cloudflare/sandbox"];

/** How long the one-shot heal waits for `destroy()` before retrying anyway.
 *  `destroy()` is unbounded: if the Containers control plane hangs, every
 *  coalesced caller hangs with it until the Durable Object is evicted, and
 *  the SDK's own docs tell callers who need a bound to race it. */
const LEGACY_DESTROY_WAIT_MS = 10_000;

export class SwitchboardSandbox extends Sandbox {
  // Idle lifetime of a thread's container (the SDK's own default is 10 min on
  // 0.12.x, 20 on 0.3.x). On the 0.0.28 containers base the activity clock was
  // renewed once per proxied fetch and the alarm loop SIGTERMed the container
  // the moment it expired, in-flight request or not — so on 2026-09-07 the
  // #521 review's first command (a 20-minute budget under a 20-minute default)
  // was killed at 20:00 exactly, surfaced as "Command execution failed", and
  // the next command found a fresh container with an empty /workspace. `exec`
  // below renews the clock every minute while a command runs, which makes
  // this a true idle timeout (features/execution.md item 2). The 0.3.x
  // containers base tracks in-flight requests itself, so the keepalive is now
  // belt-and-braces — kept until the live long-command receipt (#228). 5
  // minutes of idle frees the slot sooner while a prompt follow-up still
  // reuses the warm workspace.
  sleepAfter = SANDBOX_SLEEP_AFTER;

  // A Worker and its image deploy as two artifacts; until the rollout finishes
  // this Worker can be handed a container still on the PREVIOUS image
  // (features/execution.md item 6; 2026-09-07, #569: a 0.3.7 container under
  // the 0.12.9 SDK, every command a message-less 400 for 90 s). The SDK's own
  // check logs `container=unknown` at info and does nothing else; this one
  // names the skew at warn so the rollout is visible in the logs.
  //
  // LOG ONLY — never `destroy()` here: onStart runs inside
  // `blockConcurrencyWhile`, `destroy()` is unbounded and coalesced callers
  // hang until eviction, a fresh placement during a gradual wave can land on
  // the old image again (the incident's DO was brand new), and the
  // healthy-but-not-running state after a destroy takes the SDK's stale-state
  // path, which can `ctx.abort()` the DO. The exec path below heals instead,
  // once, when a command actually hits the legacy shape.
  override async onStart(): Promise<void> {
    await super.onStart();
    const v = await this.client.utils.getVersion().catch(() => "unknown");
    if (v !== SDK_PIN) {
      console.warn(
        `sandbox.version-skew container=${v} sdk=${SDK_PIN} — this instance may be on a previous image (Worker/image rollout in progress)`,
      );
    }
  }

  override async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return withActivityKeepalive(
      () => this.renewActivityTimeout(),
      () => this.execHealingLegacyContainer(command, options),
      EXEC_KEEPALIVE_INTERVAL_MS,
    );
  }

  /** `super.exec`, retried ONCE after a `destroy()` when the failure is the
   *  legacy-container shape (`legacyContainerError`: the base `SandboxError`
   *  with an empty message, no code and the old server's `{error}` body — a
   *  0.3.x server answering the 0.12.x client's `/api/execute` with a 400 it
   *  cannot parse). That 400 is pre-dispatch, so the command never ran and
   *  re-sending it is safe by construction. `destroy()` drops this thread's
   *  container so the Durable Object's next request gets one from the current
   *  image. It can hang, so it is raced against LEGACY_DESTROY_WAIT_MS — and
   *  the retry runs ONLY when the destroy finished inside that window: a retry
   *  over a still-pending destroy would be disconnected by its own heal. A
   *  destroy that fails or times out is logged and the original legacy error
   *  propagates for `thrownText` to name; so does a second legacy failure. A
   *  command concurrently pending on the same DO would be disconnected with
   *  the SDK's destroy text, which the recycle shapes cover (item 9). The
   *  match is shape-based (see `legacyContainerError`), which is why the heal
   *  is bounded to one destroy and one retry per exec. */
  private async execHealingLegacyContainer(command: string, options?: ExecOptions): Promise<ExecResult> {
    try {
      return await super.exec(command, options);
    } catch (err) {
      if (!legacyContainerError(err)) throw err;
      console.warn(
        `sandbox.legacy-container exec failed with the legacy-image shape (SandboxError, empty message, {error} body) — destroying this instance and retrying once`,
      );
      if (!(await this.destroyWithin(LEGACY_DESTROY_WAIT_MS))) throw err;
      return await super.exec(command, options);
    }
  }

  /** `destroy()` bounded by `waitMs`: true when it completed in time, false
   *  when it failed or is still pending (logged either way). */
  private async destroyWithin(waitMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), waitMs);
    });
    const done = this.destroy().then(
      () => true as const,
      (e: unknown) => {
        console.warn(`sandbox.legacy-container destroy failed: ${thrownText(thrownShape(e))}`);
        return false as const;
      },
    );
    const result = await Promise.race([done, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === false) {
      console.warn(
        `sandbox.legacy-container destroy did not finish within ${waitMs / 1000}s — not retrying over a pending destroy; the legacy error propagates`,
      );
    }
    return result;
  }

  // A fence from the 0.3.x days, kept until the live container-restart receipt
  // (#228) retires it: 0.3.x cached its default ExecutionSession in Durable
  // Object memory while the session lived in the container, so a container
  // restart under a live DO (image rollout, crash, sleep/wake) made every later
  // call fail with "Session '<id>' not found" forever. 0.12.x persists the
  // session id in DO storage, clears it itself in `onStop`, and its container
  // recreates a missing session on the next exec — so this should never run;
  // if it does, nulling the cached id only makes the SDK recreate the session,
  // which is what it would have done anyway. The workspace disk is gone either
  // way; repos re-clone — the same graceful degradation as an expired E2B
  // sandbox.
  resetDefaultSession(): void {
    (this as unknown as { defaultSession: unknown }).defaultSession = null;
  }
}

/** The 0.3.x stale-session text; see `resetDefaultSession`. */
const STALE_SESSION = /session '[^']*' not found/i;

/** Run a sandbox call and retry it ONCE when the failure says nothing ran: a
 *  stale session (0.3.x; reset the cached id first) or a container still
 *  booting (0.12.x's "Container is starting. Please retry in a moment.", after
 *  a short pause). Both fail before the command or file op executes, so the
 *  re-send is safe by construction. Anything else propagates: a failure whose
 *  command MAY have run (a session shell that exited mid-command, a container
 *  that stopped under the call) is never re-run here — /exec names it a
 *  recycle instead (features/execution.md item 9). */
const CONTAINER_STARTING_RETRY_DELAY_MS = 3_000;

async function withSessionRecovery<T>(
  sandbox: { resetDefaultSession(): void | Promise<void> },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const { message } = thrownShape(err);
    if (message && STALE_SESSION.test(message)) {
      await sandbox.resetDefaultSession();
      return await fn();
    }
    if (isContainerStarting(err)) {
      await new Promise((r) => setTimeout(r, CONTAINER_STARTING_RETRY_DELAY_MS));
      return await fn();
    }
    throw err;
  }
}

interface Env {
  Sandbox: DurableObjectNamespace<SwitchboardSandbox>;
  SANDBOX_TOKEN: string;
}

const WORKDIR = "/workspace";

// Default per-command time limit, enforced by coreutils `timeout` inside the
// sandbox. The tuned 280s applies when the body carries no timeoutMs (an older
// bot); a caller-supplied timeoutMs is clamped server-side to the shared
// [1s, 20 min] bounds (clampBashTimeout — never trust the client's number).
// Whatever the effective limit, it must stay BELOW the SDK backstop
// (COMMAND_TIMEOUT_MS in the Dockerfile, sized above the 20-min ceiling) so
// the real exit 124 wins. undici's 300s no-headers ceiling stopped mattering
// once /exec streamed heartbeats — headers go out immediately.
const EXEC_TIMEOUT_SECS = 280;

/** The commit this bundle was built from, injected by the deploy
 *  (`deploy/bin/build-stamp.mjs`) and answered on GET /healthz as `build`. */
const BUILD = injectedBuildStamp();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (!env.SANDBOX_TOKEN || auth !== `Bearer ${env.SANDBOX_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    // Build identity, behind the SAME bearer as everything else: this Worker
    // authenticates every request and gains no unauthenticated surface for a
    // stamp (features/execution.md item 13). It needs no thread, so it answers
    // before the X-Thread-Key check — and it is the one GET here.
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
      return json({ ok: true, build: BUILD });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    const threadKey = request.headers.get("x-thread-key");
    if (!threadKey) return json({ error: "missing X-Thread-Key" }, 400);

    // One sandbox per thread; the DO name is the thread key. getSandbox is
    // generic over the namespace's class since 0.12, so the subclass's
    // resetDefaultSession is callable over RPC without a cast.
    const sandbox = getSandbox(env.Sandbox, threadKey);

    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    // Optional env passthrough (e.g. GH_TOKEN), read from the BODY's `env`
    // (features/execution.md item 5). It then rides in the SDK's per-exec
    // `env` option, which the container applies to that one command and
    // restores afterwards (0.12.x; 0.3.7 ignored it, so the value used to be
    // an inline base64 `export` prefix — which put the live GH_TOKEN into every
    // "Command executed" line the SDK logs, #447). Nothing persists in the
    // sandbox beyond the command's lifetime, and the command text the SDK
    // logs never carries a credential.
    //
    // Body, never headers: Workers Logs record this invocation's request
    // headers and redact them by a name heuristic only — the 2026-09-07
    // receipt probe's per-variable env header was logged in clear. Bodies are
    // not recorded. The one-release per-variable-header fallback that carried a
    // body-only bot against a header-only Worker during the #597 rollout is
    // gone now that the body reader is live everywhere (#447), so the
    // credential rides only in the body and no request header is read as env.
    const envVars = envFromRequest({ body });

    try {
      switch (url.pathname) {
        case "/exec": {
          // Streamed with a whitespace heartbeat. A long command otherwise
          // holds a byteless HTTP request open for minutes, and some hop
          // between the bot and this Worker silently drops idle connections —
          // measured live: the container answered a 290s command at its 280s
          // timeout, but the bot's fetch died without ever seeing the
          // response (undici gives up 300s after sending a request that has
          // received no headers). Headers go out immediately and a heartbeat
          // byte flows every 15s, so no intermediary ever sees an idle
          // connection. Heartbeats are pure whitespace, which is legal around
          // a JSON document — the executor's res.json() on the full body
          // parses unchanged.
          //
          // The time limit is enforced with coreutils `timeout` INSIDE the
          // sandbox, not by the SDK: the SDK's COMMAND_TIMEOUT_MS rejection is
          // useless to callers — its exec handler wraps every failure as a
          // generic "Command execution failed" and buries the real message in
          // a field its client discards (measured live). Shell-level timeout
          // produces a real exit 124 through the normal result path, no error
          // classification needed. SIGKILL follows 10s after TERM for
          // stragglers. COMMAND_TIMEOUT_MS (Dockerfile) sits above this as a
          // pure backstop.
          //
          // Per-call budget (features/execution.md item 11): a numeric
          // timeoutMs in the body is clamped server-side to the shared
          // [1s, 20 min] bounds; absent (an older bot) → the tuned 280s
          // default this Worker has always used.
          const requested = body.timeoutMs;
          const execTimeoutSecs =
            typeof requested === "number" && Number.isFinite(requested)
              ? Math.ceil(clampBashTimeout(requested) / 1000)
              : EXEC_TIMEOUT_SECS;
          const full = `mkdir -p ${WORKDIR} && cd ${WORKDIR} && ${String(body.command ?? "")}`;
          return streamExec(
            sandbox,
            `timeout -k 10 ${execTimeoutSecs} bash -c ${shellQuote(full)}`,
            { env: envVars },
            execTimeoutSecs,
          );
        }
        case "/read": {
          const file = await withSessionRecovery(sandbox, () => sandbox.readFile(abs(String(body.path ?? ""))));
          return json({ content: typeof file === "string" ? file : (file?.content ?? "") });
        }
        case "/write": {
          await withSessionRecovery(sandbox, () =>
            sandbox.writeFile(abs(String(body.path ?? "")), String(body.content ?? "")),
          );
          return json({ ok: true });
        }
        default:
          return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      // Never an empty text (item 3): a message-less SDK error is named as
      // such, with the rollout hint (#569).
      const msg = thrownText(thrownShape(err));
      // A full fleet (features/execution.md item 14): the SDK could not get a
      // container instance for this thread's Durable Object, so no session
      // exists and the file op never started — re-sending is safe by
      // construction. Named so the executor waits instead of reading it as a
      // dead sandbox; 503 because that is what it is.
      if (isFleetBusyError(err)) return json(fleetBusyAnswer(msg), 503);
      return json({ error: msg }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/** Execute a command and stream the response: immediate headers, a whitespace
 *  heartbeat every 15s while the command runs, then one JSON document. All
 *  outcomes arrive in-body with HTTP 200 (headers are long gone by the time
 *  the result is known): a completed command as {stdout, stderr, exitCode},
 *  a sandbox-enforced timeout as exit 124, and any other failure as {error}. */
function streamExec(
  sandbox: {
    resetDefaultSession(): void | Promise<void>;
    exec(command: string, options?: ExecOptions): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  },
  command: string,
  options: ExecOptions,
  execTimeoutSecs: number,
): Response {
  const encoder = new TextEncoder();
  // Per ATTEMPT, not per request: withSessionRecovery may run the command a
  // second time after a stale-session reset, and a retry's own failure must be
  // judged on its own clock, not the first attempt's.
  let attemptStartedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(beat); // client went away; the exec promise still settles
        }
      }, 15_000);
      const finish = (payload: object) => {
        clearInterval(beat);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        } catch {
          // stream already errored/cancelled — nothing left to deliver to
        }
      };
      withSessionRecovery(sandbox, () => {
        attemptStartedAt = Date.now();
        return sandbox.exec(command, options);
      })
        .then((result) => {
          const exitCode = result.exitCode ?? 0;
          // coreutils `timeout` exits 124 when the deadline killed the
          // command (137 when the follow-up SIGKILL had to) — annotate so the
          // agent knows what happened and how to adapt.
          const timedOut = exitCode === 124 || exitCode === 137;
          const note = timedOut
            ? `command timed out in the sandbox after ${execTimeoutSecs}s (pass the bash tool's timeoutMs for longer commands, max ${BASH_TIMEOUT_MAX_MS} ms); ` +
              "re-run as smaller/faster steps or background it with nohup"
            : "";
          finish({
            stdout: result.stdout ?? "",
            stderr: [result.stderr ?? "", note].filter(Boolean).join("\n"),
            exitCode: timedOut ? 124 : exitCode,
          });
        })
        .catch((err: unknown) => {
          const shape = thrownShape(err);
          // The text that leaves the Worker is never empty (item 3): a
          // message-less SDK error — the legacy-image 400 of #569 after the
          // one-shot heal above failed too — is named, with the rollout hint.
          // The classifiers below still read the raw `shape`.
          const raw = thrownText(shape);
          // A full fleet (features/execution.md item 14): session creation
          // failed because no container instance was free, so the command
          // never started — re-sending it is safe by construction. The named
          // `reason` is what the executor waits on; the dual shape below is
          // kept so an older executor still renders it as exit 127.
          if (isFleetBusyError(err)) {
            finish(fleetBusyExecAnswer(raw));
            return;
          }
          // The container was replaced under the command (features/execution.md
          // item 2): certain when the SDK says so with a typed error, inferred
          // when a recycle-shaped text arrives minutes into this attempt. Say
          // so, and that /workspace is gone. Still exit 127: the workspace
          // really is gone.
          const certain = shape.name !== undefined && isRecycleError({ name: shape.name });
          const msg = recycledMidCommandMessage(Date.now() - attemptStartedAt, raw, certain);
          // Carry the failure in BOTH shapes so rollout order can't create
          // a silent-success window: a new executor throws on `error`, and
          // an executor that predates in-body errors (only checks exitCode)
          // still renders "exit 127: <message>" instead of "(no output)".
          finish({ error: msg, stdout: "", stderr: msg, exitCode: 127 });
        });
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

function abs(p: string): string {
  if (!p) throw new Error("missing path");
  const path = p.startsWith("/") ? p : `${WORKDIR}/${p}`;
  if (!path.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
