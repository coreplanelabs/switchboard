import type { OperationResult, Operations, OpName } from "../core/operations.js";
import { classifyError } from "../core/trace/classify.js";
import { tracedFetch } from "../core/trace/tracedFetch.js";
import type { Span } from "../core/trace/types.js";
import { redactSecrets, stripAnsi } from "../core/redact.js";
import { residentState, sanitizeResidentBody } from "./residentText.js";
import type { ResidentStep } from "./residentStepTrace.js";
import { sanitizeGraftedSteps, withResidentTrace } from "./residentTrace.js";
import { repoResourceId } from "../core/residentAdmin.js";
import { EXEC_CALL_MARGIN_MS, clampBashTimeout } from "./bashTimeout.js";
import {
  BASH_TIMEOUT_MS,
  ExecInfraError,
  execDeadline,
  truncate,
  type ExecOptions,
  type Executor,
  type ReleaseMode,
  type ReleaseResult,
} from "./executor.js";
import type { ExecTraceOptions } from "./executor.js";

// Remote execution against a resident repo environment — the always-warm
// per-repo service behind the resident Worker (deploy/cloudflare-resident/).
// Unlike the per-thread sandbox Worker, every route POSTs a JSON body carrying
// {resource, threadKey} (never thread/env headers — the resident ignores
// x-env-* by design), and per-thread state is a git worktree bound to a sticky
// ref inside the resident, not a whole sandbox.
//
// Route contracts this client implements:
//   /attach {resource, threadKey, refHint?, readonly?, sha?} → 200 attach result
//     | 409 {needs:"ref"} (thread has no ref binding — ask the user)
//     | 400 unknown-ref/pattern | 404 not onboarded | 503 mirror-busy | 429 pool
//   /exec {resource, threadKey, command, timeoutMs?} → streamed HTTP 200: whitespace
//     heartbeats then ONE JSON document {stdout, stderr, exitCode, truncated};
//     post-validation failures arrive IN-BODY as {error, needs?, exitCode:127}
//     — parse the body, never trust the status.
//   /read {resource, threadKey, path} → {content, truncated} | 409 needs-attach
//   /write {resource, threadKey, path, content} → {ok, bytes} | same errors
//
// needs:"attach" means the worktree was evicted or the container disk was
// recycled; the binding survives in the resident's storage, so one re-attach
// recreates the tree on the same ref — this client auto-re-attaches ONCE and
// retries, then fails legibly.

/** /detach is a small control-plane POST the dispatcher makes once the answer
 *  is out: bound it tightly so a sick resident holds the run's slot for
 *  seconds, not a multi-minute exec budget. */
const DETACH_TIMEOUT_MS = 10_000;

export interface ResidentExecutorOptions {
  /** Base URL of the resident Worker. */
  baseUrl: string;
  /** Operator bearer (RESIDENT_OPERATOR_TOKEN secret). */
  token: string;
  /** Resource id, e.g. "repo:jshttp/vary". */
  resource: string;
  threadKey: string;
  /** Ref for a first attach; an existing thread binding always wins over it. */
  refHint?: string;
  /** Read-only run (docs/reference/specs/resident-repos.md item 50): the resident builds
   *  the worktree with no credential file and an unfetchable origin. Sent only
   *  when true, so an older resident sees the body it always did. */
  readonly?: boolean;
  /** The commit the caller expects the ref to be at — a PR head (docs/reference/specs/
   *  resident-repos.md item 51). The resident fetches its mirror when the ref's
   *  tip is not this commit instead of cloning a stale tip. Sent only when set,
   *  so an older resident sees the body it always did. */
  sha?: string;
}

/** What a successful /attach reports about the thread's worktree. */
export interface ResidentBinding {
  ref: string;
  sha: string;
  /** Absolute path of the thread's worktree inside the resident — the cwd of
   *  every /exec. Advisory (named to the model so it never goes looking for
   *  the repository); undefined if the attach answer lacked it. */
  workspace?: string;
  /** The resident's own step trace for the attach (docs/reference/specs/tracing.md item
   *  19), sanitized at the parse; absent from a Worker predating it. */
  trace?: ResidentStep[];
  /** The resident's total for the attach (`attachMs`), for the clock-skew attr. */
  attachMs?: number;
}

/** 409 needs:"ref" from /attach — the thread has no ref binding yet (a
 *  binding is explicit or asked for once, never a silent guess). Typed so the
 *  dispatcher can catch it and ask the user ONE clarifying question
 *  instead of surfacing a raw error; the user's answer in the thread carries
 *  the ref on the next message and re-attach binds it. */
export class ResidentNeedsRefError extends Error {
  readonly needs = "ref";
  /** The resident's default branch when the Worker names one in the 409 body:
   *  the factory binds the thread to it (loudly) instead of asking. Undefined
   *  from a Worker predating that field → the dispatcher asks as before. */
  constructor(
    readonly resource: string,
    readonly defaultRef?: string,
  ) {
    super(
      `the ${resource} resident needs a branch for this thread: no ref is bound yet. ` +
        `Name the branch to work on (e.g. "on main") and try again.`,
    );
    this.name = "ResidentNeedsRefError";
  }
}

/** Tolerant body parse shared by every resident route: read the FULL body as
 *  text first (streamed routes send heartbeat whitespace, then exactly one
 *  JSON document), tolerate a non-JSON body (edge error page) as {} — the
 *  caller then surfaces the HTTP status. */
async function parseResidentBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text.trim() || "{}") as Record<string, unknown>;
  } catch {
    // non-JSON body (edge error page) — the caller falls back to the status
  }
  // Item 62: every resident string is made safe here, at the one parse the
  // operator routes share, so no caller downstream can show it raw.
  return sanitizeResidentBody(data);
}

/** Deterministic-ops client for the resident Worker's POST /op:
 *  a name from the fixed op enum resolves resident-side ONLY through the
 *  onboard-time command table and runs in a disposable per-op checkout —
 *  never a thread's attached worktree, so no threadKey rides in the body.
 *  Post-validation responses stream like /exec (heartbeat whitespace + ONE
 *  JSON document over HTTP 200 — parse the body, never the status);
 *  pre-validation refusals use real statuses (400/404/409). A failing op is
 *  a RESULT (ok:false), not an error. */
export class ResidentOperations implements Operations {
  constructor(private opts: { baseUrl: string; token: string }) {}

  async run(op: OpName, req: { repo: string; ref?: string }, traceOpts?: ExecTraceOptions): Promise<OperationResult> {
    let res: Response;
    try {
      res = await tracedFetch(
        traceOpts?.span,
        `${this.opts.baseUrl.replace(/\/$/, "")}/op`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
          body: JSON.stringify({ resource: repoResourceId(req.repo), op, ...(req.ref ? { ref: req.ref } : {}) }),
          // Bound the request so a hung resident can't stall the dispatch; an op
          // (test/build) legitimately runs minutes, so use the exec ceiling. A
          // timeout throws here and becomes the same legible error as any other
          // transport failure below.
          signal: AbortSignal.timeout(BASH_TIMEOUT_MS),
        },
        { route: "/op" },
      );
    } catch (err) {
      return {
        kind: "error",
        message: `resident /op request failed (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    if (res.status === 404) return { kind: "not-onboarded" };
    const data = await parseResidentBody(res);
    const err = typeof data.error === "string" ? data.error : "";
    if (err.startsWith("op-refused")) return { kind: "refused", reason: err };
    if (err) return { kind: "error", message: `resident /op: ${err}` };
    if (!res.ok) return { kind: "error", message: `resident /op HTTP ${res.status}` };
    const ok = data.ok === true;
    const summary =
      typeof data.summary === "string" && data.summary ? data.summary : `${op} ${ok ? "succeeded" : "failed"}`;
    // Item 62: op output reaches a Slack reply, so it is stripped and redacted
    // BEFORE the clip (a cut mid-token would defeat the redaction).
    const output = [data.stdout, data.stderr]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .map((s) => redactSecrets(stripAnsi(s)))
      .join("\n--- stderr ---\n");
    const trace = sanitizeGraftedSteps(data.trace);
    return {
      kind: "result",
      ok,
      summary,
      ...(output ? { output: truncate(output) } : {}),
      ...(trace.length > 0 ? { trace } : {}),
      ...(typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
        ? { residentMs: data.durationMs }
        : {}),
    };
  }
}

/** Result of a /status probe: a definite lifecycle answer, or an unreachable
 *  marker. `transport: true` means the failure was network-level (fetch threw
 *  or timed out) — the only kind the factory's negative cache may store. */
export type ResidentStatusProbe =
  { kind: "status"; state: string; reason: string } | { kind: "unreachable"; error: string; transport: boolean };

export class ResidentExecutor implements Executor {
  /** Consecutive `runtime-replaced` outcomes with no successful op between
   *  them. One is a deploy that swapped the resident isolate under a command
   *  (routine, recoverable); two in a row is a flapping resident and becomes
   *  infra so the runner's fail-fast still has teeth. */
  private runtimeReplacedStreak = 0;

  private lastBinding?: ResidentBinding;

  /** The thread's binding as the resident answered it on the most recent
   *  successful attach — including a mid-run re-attach after an eviction, which
   *  may land on a newer sha than the one the run started on. Undefined until
   *  the first attach succeeds; set only by attach(). */
  get binding(): ResidentBinding | undefined {
    return this.lastBinding;
  }

  constructor(private opts: ResidentExecutorOptions) {}

  /** Attach-on-open: bind (or reuse) the thread's worktree before the first
   *  tool call, so needs-ref / not-onboarded surface at selection time as
   *  legible errors instead of mid-run tool failures. */
  static async open(opts: ResidentExecutorOptions): Promise<ResidentExecutor> {
    const ex = new ResidentExecutor(opts);
    await ex.attach();
    return ex;
  }

  /** One operator-scope GET /status, bounded by timeoutMs. Never throws. */
  static async probeStatus(
    baseUrl: string,
    token: string,
    resource: string,
    timeoutMs: number,
    span?: Span,
  ): Promise<ResidentStatusProbe> {
    const url = `${baseUrl.replace(/\/$/, "")}/status?resource=${encodeURIComponent(resource)}`;
    let res: Response;
    try {
      res = await tracedFetch(
        span,
        url,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) },
        { route: "/status" },
      );
    } catch (err) {
      // network failure or probe timeout — not-warm, and negative-cacheable
      return { kind: "unreachable", error: err instanceof Error ? err.message : String(err), transport: true };
    }
    if (res.status === 404) {
      // a definite answer (resource not onboarded), never a service failure
      return { kind: "status", state: "not-onboarded", reason: "" };
    }
    // Item 62: the probe has its own body read, so it sanitizes on its own,
    // and `state` is validated against the closed table (never echoed).
    const data = sanitizeResidentBody((await res.json().catch(() => ({}))) as Record<string, unknown>);
    if (!res.ok) {
      return { kind: "unreachable", error: `probe HTTP ${res.status}: ${String(data.error ?? "")}`, transport: false };
    }
    return { kind: "status", state: residentState(data.state), reason: String(data.reason ?? "") };
  }

  /** POST one route; resource + threadKey ride in every body. Reads the FULL
   *  body as text before parsing: /exec streams heartbeat whitespace and then
   *  exactly one JSON document, always over HTTP 200. */
  private async call(
    route: string,
    body: Record<string, unknown>,
    timeoutMs: number = BASH_TIMEOUT_MS,
    signal?: AbortSignal,
    span?: Span,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Response;
    try {
      // One `http.client` span under the caller's (docs/reference/specs/tracing.md item 21);
      // the trace context rides only because the resident is one of our hosts.
      res = await tracedFetch(
        span,
        `${this.opts.baseUrl.replace(/\/$/, "")}${route}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.token}`,
          },
          body: JSON.stringify({ resource: this.opts.resource, threadKey: this.opts.threadKey, ...body }),
          // Bound every route so a hung resident can't stall the dispatch; /exec
          // streams and can legitimately run minutes, so it passes its command
          // budget plus EXEC_CALL_MARGIN_MS (the server's own exit-124 answer
          // must win the race); control-plane routes pass a short bound. A timeout throws
          // here and is translated into the legible request-failed error below,
          // never an unhandled throw. A hard run stop joins the deadline:
          // it drops the bot-side request; the resident's own `timeout` still
          // bounds the command inside the container.
          signal: execDeadline(timeoutMs, signal),
        },
        { route },
      );
      // The body read is under the SAME deadline: /exec streams heartbeats, so
      // a resident whose exec promise never settles hangs HERE, past the
      // headers, not on the fetch — read it inside the try so that abort is the
      // legible request-failed error below and NOT a raw TimeoutError.
      return { status: res.status, data: await parseResidentBody(res) };
    } catch (err) {
      // Network-level failure or a deadline abort mid-body: the command may
      // still be running (or have run) in the resident — never blind-retry a
      // possibly side-effectful call. Infra (not a command exit): the runner
      // counts these toward fail-fast.
      throw classifyError(
        new ExecInfraError(
          `resident worker ${route} request failed (${err instanceof Error ? err.message : String(err)}). ` +
            "The operation may still have run in the resident; re-check its effects before re-running it.",
        ),
        { kind: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "transport" },
      );
    }
  }

  /** Bind/reuse this thread's worktree. Legible errors for every named
   *  refusal the service can answer with. Answers the binding the resident
   *  reported: the bound ref (authoritative — a differing refHint is ignored)
   *  and the sha the worktree is at. A 200 without both fields is a
   *  malformed resident (the attach contract always carries them) and is an
   *  error, never a half-bound executor. */
  async attach(span?: Span): Promise<ResidentBinding> {
    const body: Record<string, unknown> = {};
    if (this.opts.refHint) body.refHint = this.opts.refHint;
    if (this.opts.readonly) body.readonly = true;
    if (this.opts.sha) body.sha = this.opts.sha;
    const answered = await this.call("/attach", body, undefined, undefined, span);
    const data = answered.data;
    // Post-validation answers stream like /exec (heartbeat whitespace then one
    // JSON document over HTTP 200, item 59) so an attach that waits on a deps
    // install cannot lose the connection; a streamed refusal carries its
    // status IN the body. Pre-validation refusals (400/404) keep real statuses.
    const status =
      answered.status === 200 && typeof data.error === "string" && typeof data.status === "number"
        ? data.status
        : answered.status;
    if (status === 200) {
      if (typeof data.ref !== "string" || typeof data.sha !== "string") {
        throw new Error(`resident attach: malformed answer for ${this.opts.resource} (missing ref/sha)`);
      }
      const trace = sanitizeGraftedSteps(data.trace);
      this.lastBinding = {
        ref: data.ref,
        sha: data.sha,
        ...(typeof data.workspace === "string" && data.workspace ? { workspace: data.workspace } : {}),
        ...(trace.length > 0 ? { trace } : {}),
        ...(typeof data.attachMs === "number" && Number.isFinite(data.attachMs) ? { attachMs: data.attachMs } : {}),
      };
      return this.lastBinding;
    }
    const err = String(data.error ?? `HTTP ${status}`);
    // The steps the resident ran before refusing ride the error (docs/reference/specs/
    // tracing.md item 19): the dispatcher grafts them under its attach span.
    const failedTrace = sanitizeGraftedSteps(data.trace);
    const fail = (e: Error): never => {
      throw failedTrace.length > 0 ? withResidentTrace(e, { steps: failedTrace }) : e;
    };
    if (status === 409 && data.needs === "ref") {
      const defaultRef = typeof data.defaultRef === "string" && data.defaultRef ? data.defaultRef : undefined;
      return fail(new ResidentNeedsRefError(this.opts.resource, defaultRef));
    }
    if (status === 404) {
      return fail(new Error(`resident attach: ${this.opts.resource} is not onboarded (${err})`));
    }
    return fail(new Error(`resident attach failed for ${this.opts.resource}: ${err}`));
  }

  /** Move the thread's worktree to `sha` (agent-review.md item 12): one more
   *  `/attach` carrying the new expected head, so the resident fetches its
   *  mirror (item 51) and recreates the tree at the ref's tip — the same
   *  mechanism a re-review after a push uses, applied mid-run. Every later
   *  attach (an eviction recovery) carries the new sha too. Answers the sha the
   *  worktree is at; throws like attach() on a refusal. */
  async moveTo(sha: string, opts?: ExecTraceOptions): Promise<{ sha: string }> {
    this.opts = { ...this.opts, sha };
    const binding = await this.attach(opts?.span);
    return { sha: binding.sha };
  }

  /** POST /detach: return this thread's pool user (and remove its worktree)
   *  now that the run is over, instead of holding both until the inactivity
   *  sweep. `force` (mode "always") skips the resident's clean check; "if-clean"
   *  lets the resident keep a worktree with uncommitted/unpushed work — the
   *  binding (ref) survives either way, so the next attach recreates
   *  the tree on the same ref. Best-effort by contract: never throws. */
  async release(mode: ReleaseMode, opts?: ExecTraceOptions): Promise<ReleaseResult> {
    try {
      const { status, data } = await this.call(
        "/detach",
        { force: mode === "always" },
        DETACH_TIMEOUT_MS,
        undefined,
        opts?.span,
      );
      if (status !== 200) return { released: false, reason: `HTTP ${status}: ${String(data.error ?? "")}` };
      return { released: data.released === true, reason: typeof data.reason === "string" ? data.reason : undefined };
    } catch (err) {
      return { released: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Run a route; on needs:"attach" (evicted/recycled worktree, in-body for
   *  /exec, 409 for /read //write) re-attach ONCE and retry, then fail legibly.
   *
   *  A `reason:"runtime-replaced"` answer (the resident isolate was swapped by
   *  a deploy while the op ran) also re-attaches once — proving the new isolate
   *  serves this thread — but the op is re-issued only for the idempotent
   *  routes (/read, /write). /exec is handed back to the caller as-is: the
   *  command may have started, so it is never blind-retried. Two such answers
   *  with no success between them are infra (a flapping resident). */
  private async opWithReattach(
    route: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    callTimeoutMs: number = BASH_TIMEOUT_MS,
    span?: Span,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    // Worktree still gone after a re-attach — the resident is unhealthy
    // (mid-restore or worse). Infra, not a command exit: counts toward
    // fail-fast so the run doesn't keep dispatching into it.
    const stillGone = (data: Record<string, unknown>): ExecInfraError =>
      classifyError(
        new ExecInfraError(
          `resident ${route}: worktree still unavailable after a re-attach (${String(data.error ?? "")}) — ` +
            "the resident may be mid-restore; try again shortly.",
        ),
        { kind: "infra", code: "attach" },
      );
    let r = await this.call(route, body, callTimeoutMs, signal, span);
    if (r.data.needs === "attach") {
      await this.attach(span); // the recovery rides the same trace as the op it rescues
      r = await this.call(route, body, callTimeoutMs, signal, span);
      if (r.data.needs === "attach") throw stillGone(r.data);
    }
    if (r.data.reason === "runtime-replaced") {
      this.noteRuntimeReplaced(route, r.data);
      await this.attach(span); // the recovery rides the same trace as the op it rescues
      if (route === "/read" || route === "/write") {
        r = await this.call(route, body, callTimeoutMs, signal, span);
        if (r.data.reason === "runtime-replaced") this.noteRuntimeReplaced(route, r.data);
        // Compound fault: the deploy also left the worktree evicted. The
        // re-attach above was this op's one re-attach, so name it precisely
        // instead of falling through to the generic status error.
        if (r.data.needs === "attach") throw stillGone(r.data);
      }
    }
    if (typeof r.data.error !== "string" || !r.data.error) this.runtimeReplacedStreak = 0;
    return r;
  }

  private noteRuntimeReplaced(route: string, data: Record<string, unknown>): void {
    this.runtimeReplacedStreak++;
    if (this.runtimeReplacedStreak >= 2) {
      throw classifyError(
        new ExecInfraError(
          `resident ${route}: runtime replaced ${this.runtimeReplacedStreak} times in a row with no successful operation ` +
            `between (${String(data.error ?? "")}) — a deploy storm or a flapping resident, not a one-off deploy.`,
        ),
        { kind: "infra", code: "runtime-replaced" },
      );
    }
  }

  async exec(command: string, opts?: ExecOptions): Promise<string> {
    // Per-call budget (docs/reference/specs/execution.md item 11). It rides in the body
    // only when the caller asked for one, so an older resident Worker sees the
    // body it always did (same convention as attach's readonly/sha); the
    // resident clamps server-side with the same [1s, 20 min] bounds and never
    // trusts this number. The HTTP wait is the budget plus a margin so the
    // resident's own streamed exit-124 answer arrives instead of the client
    // aborting the transport at the same instant.
    const timeoutMs = clampBashTimeout(opts?.timeoutMs);
    const body: Record<string, unknown> = { command };
    if (opts?.timeoutMs !== undefined) body.timeoutMs = timeoutMs;
    const { status, data } = await this.opWithReattach(
      "/exec",
      body,
      opts?.signal,
      timeoutMs + EXEC_CALL_MARGIN_MS,
      opts?.span,
    );
    // A pre-validation client rejection — a plain HTTP 400 with an {error} and NO
    // `needs` (e.g. command-too-long), nothing streamed — is agent-fixable, not a
    // sick resident. Surface it as a normal Error so it does NOT count toward the
    // fail-fast infra counter and false-trip the abort on a HEALTHY
    // resident. Discriminated on the same signals attach() uses: HTTP status +
    // absence of `needs`.
    if (status === 400 && typeof data.error === "string" && data.error && data.needs === undefined) {
      throw new Error(`resident /exec: ${data.error}`);
    }
    if (data.reason === "runtime-replaced") {
      // One deploy swapped the resident isolate under this command. The command
      // may have started and had effects, so opWithReattach did not re-run it;
      // hand the named outcome to the model as ordinary output (not infra — a
      // single deploy must never count toward fail-fast) so it re-checks state
      // before deciding whether to re-run.
      return (
        `${String(data.error)}\n` +
        "The command may have started; re-check its effects (e.g. git status, the files it writes) before re-running it."
      );
    }
    if (typeof data.error === "string" && data.error) {
      // post-validation failure (exitCode 127 shape) — legible, never retried.
      // Infra (the exec transport failed), not a command exit: counts toward
      // fail-fast.
      throw classifyError(new ExecInfraError(`resident /exec: ${data.error}`), { kind: "infra" });
    }
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /exec HTTP ${status}`), { kind: "http", code: String(status) });
    }
    const parts = [data.stdout, data.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = Number(data.exitCode ?? 0);
    if (exitCode !== 0) return truncate(`exit ${exitCode}:\n${parts}`);
    return truncate(parts || "(no output)");
  }

  async readFile(path: string, opts?: ExecTraceOptions): Promise<string> {
    const { status, data } = await this.opWithReattach("/read", { path }, undefined, undefined, opts?.span);
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /read: ${String(data.error ?? `HTTP ${status}`)}`), {
        kind: "http",
        code: String(status),
      });
    }
    return truncate(String(data.content ?? ""));
  }

  async writeFile(path: string, content: string, opts?: ExecTraceOptions): Promise<string> {
    const { status, data } = await this.opWithReattach("/write", { path, content }, undefined, undefined, opts?.span);
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /write: ${String(data.error ?? `HTTP ${status}`)}`), {
        kind: "http",
        code: String(status),
      });
    }
    return `Wrote ${path}`;
  }
}
