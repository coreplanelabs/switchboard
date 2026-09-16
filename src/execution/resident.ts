import type { OperationResult, Operations, OpName } from "../core/operations.js";
import { classifyError } from "../core/trace/classify.js";
import { tracedFetch } from "../core/trace/tracedFetch.js";
import type { Span } from "../core/trace/types.js";
import { redactSecrets, stripAnsi } from "../core/redact.js";
import { systemClock } from "../core/trace/clock.js";
import { isServiceable } from "./residentState.js";
import { residentState, sanitizeResidentBody } from "./residentText.js";
import {
  WAKE_POLL_MS,
  WAKE_PROBE_TIMEOUT_MS,
  containerGoneMessage,
  describeProbe,
  isContainerRolling,
  sandboxRestartedMessage,
  saysContainerGone,
  wakeDecision,
  wakeWaitBudget,
} from "./residentWake.js";
import type { ResidentStep } from "./residentStepTrace.js";
import { sanitizeGraftedSteps, withResidentTrace } from "./residentTrace.js";
import { repoResourceId } from "../core/residentAdmin.js";
import { EXEC_CALL_MARGIN_MS, clampBashTimeout } from "./bashTimeout.js";
import {
  BASH_TIMEOUT_MS,
  ExecInfraError,
  ExecSandboxRestartedError,
  decodeBase64Read,
  execDeadline,
  truncate,
  type ExecOptions,
  type Executor,
  type ReleaseMode,
  type ReleaseResult,
} from "./executor.js";
import type { ExecTraceOptions, ReleaseOptions } from "./executor.js";
import type { LeftBehind } from "./residentCleanliness.js";

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
//
// A `not-serviceable` refusal naming a container that just exited (the
// container rollout after a resident Worker deploy, docs/reference/specs/
// resident-repos.md item 65) is a pause, not a dead sandbox: the client reads
// the engine view (`GET /status`), waits for the wake while the engine says
// the container is coming back, re-attaches, re-issues the idempotent routes
// and hands /exec back as `ExecSandboxRestartedError` for the runner to
// settle (`awaitWake`). A definite non-recovering answer is the strike it
// always was.
//
// An answer that says the container under the thread is GONE — the
// resident's `runtime-replaced` (a deploy swapped the runtime under a command
// in flight, item 43) or the preflight's `worktree-missing` (the container
// disk was recycled since the last attach) — is the same typed
// `ExecSandboxRestartedError` on /exec, at once and before any recovery
// (`saysContainerGone`): every process the run had in that container died
// with it, so the pi harness ends the run for a restart from its request
// (harness-pi.md item 16) and nothing the recovery meets — a re-attach that
// blocks through the restore or is refused while the replacement reconciles
// — can stand in for that verdict. The command is never re-issued. The
// idempotent routes keep item 43's re-attach and retry.

/** /detach is a small control-plane POST the dispatcher makes once the answer
 *  is out: bound it tightly so a sick resident holds the run's slot for
 *  seconds, not a multi-minute exec budget. */
const DETACH_TIMEOUT_MS = 10_000;

/** Resolve after `ms`; reject the moment `signal` fires. A hard stop never
 *  sits out a wake, and the rejection is a plain error (not infra: nothing is
 *  wrong with the sandbox) that the runner's hard-stop path unwinds. */
function wakePause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () => new Error("stopped waiting for the resident to wake: the run was stopped");
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

export interface ResidentExecutorOptions {
  /** Base URL of the resident Worker. */
  baseUrl: string;
  /** Operator bearer (RESIDENT_OPERATOR_TOKEN secret). */
  token: string;
  /** Resource id, e.g. "repo:jshttp/vary". */
  resource: string;
  threadKey: string;
  /** Ref for a first attach. An existing thread binding wins over it, with one
   *  exception: a thread bound to the repo default for want of a named branch
   *  moves onto the head branch of the pull request its own run opened when
   *  `ownPr` names that PR (docs/reference/specs/resident-repos.md item 16). */
  refHint?: string;
  /** The pull request the thread's OWN run opened, and its head branch — the
   *  reason `refHint` is that branch (`ownPrOf`, resident-repos item 29). The
   *  resident may move a default-bound thread onto it, once per pull request,
   *  when the branch is the thread's own — remembered from a release, or a
   *  local branch of its surviving tree — and the mirror holds it; the tree
   *  is then provisioned at the branch, clean. A PR a person named is never
   *  sent here. Sent only when set, so an older resident sees the body it
   *  always did. */
  ownPr?: { number: number; ref: string };
  /** `refHint` is the resident's own default branch, bound because the message
   *  named none (item 30): the resident records the binding as made by
   *  default — the one kind that may later move. Sent only when true. */
  refByDefault?: boolean;
  /** Read-only run (docs/reference/specs/resident-repos.md item 50): the resident builds
   *  the worktree with no credential file and an unfetchable origin. Sent only
   *  when true, so an older resident sees the body it always did. */
  readonly?: boolean;
  /** The commit the caller expects the ref to be at — a PR head (docs/reference/specs/
   *  resident-repos.md item 51). The resident fetches its mirror when the ref's
   *  tip is not this commit instead of cloning a stale tip. Sent only when set,
   *  so an older resident sees the body it always did. */
  sha?: string;
  /** A resumed run's re-attach (docs/reference/specs/resident-repos.md item 66):
   *  the resident keeps the thread's worktree exactly as it stands (dirty or
   *  stale, that is the run's own work) and refuses by name a tree it cannot
   *  keep (`ResidentReuseRefusedError`) instead of wiping and recloning it.
   *  Sent only when true, so a fresh attach, and an older resident, see the
   *  body they always did. */
  reuse?: boolean;
}

/** What a successful /attach reports about the thread's worktree. */
export interface ResidentBinding {
  ref: string;
  sha: string;
  /** Absolute path of the thread's worktree inside the resident — the cwd of
   *  every /exec. Advisory (named to the model so it never goes looking for
   *  the repository); undefined if the attach answer lacked it. */
  workspace?: string;
  /** The pool user the resident runs every /exec of this thread as
   *  (`worker<N>`), reported for the record: nothing files by it — the pi
   *  harness roots a run's files in a directory of the run's own, whatever
   *  user runs the commands (docs/reference/specs/harness-pi.md item 4).
   *  Undefined if the attach answer lacked it. */
  user?: string;
  /** The identity of the container the worktree is in: the kernel's boot id
   *  of the resident's VM, read by the resident and memoized for the
   *  container's life (docs/reference/specs/harness-pi.md item 8): what a run's
   *  row records so the generation that comes back can tell the container its
   *  pi runs in from another. Undefined if the attach answer lacked it. */
  container?: string;
  /** The resident's own step trace for the attach (docs/reference/specs/tracing.md item
   *  19), sanitized at the parse; absent from a Worker predating it. */
  trace?: ResidentStep[];
  /** The resident's total for the attach (`attachMs`), for the clock-skew attr. */
  attachMs?: number;
  /** This attach moved the thread's binding onto the branch its own run opened
   *  a pull request on (docs/reference/specs/resident-repos.md item 16): from
   *  where, to where, which PR. Absent when the binding stood. */
  rebound?: { from: string; to: string; pr: number };
  /** The attach asked for that move and the resident kept the binding: the
   *  branch, the PR, the reason (`branch-absent`, `named-ref`,
   *  `already-rebound`) and the resident's sentence. The run goes on where the
   *  binding is; the card and the run's stream say so. */
  rebindRefused?: { to: string; pr: number; reason: string; why: string };
  /** This attach moved the thread's binding BACK to the repository's default
   *  branch (item 16's second movement): the branch a rebind had moved it onto
   *  is gone from the mirror — deleted after its pull request merged — so the
   *  run starts clean on the default instead of failing on a dead ref. From
   *  which branch, to which, for which PR. Absent on every other attach. */
  returned?: { from: string; to: string; pr: number };
}

/** The attach answer's `rebound` or `returned` (item 16) — the two moves share
 *  a shape — when well-formed; anything else reads as no move, so a resident
 *  answering an unexpected shape binds as before. Strings were sanitized at
 *  the parse. */
function reboundOf(value: unknown): ResidentBinding["rebound"] {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.from !== "string" || typeof v.to !== "string" || typeof v.pr !== "number") return undefined;
  if (!v.from || !v.to || !Number.isSafeInteger(v.pr) || v.pr <= 0) return undefined;
  return { from: v.from, to: v.to, pr: v.pr };
}

/** The attach answer's `rebindRefused` (item 16), when well-formed; else none. */
function rebindRefusedOf(value: unknown): ResidentBinding["rebindRefused"] {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.to !== "string" || typeof v.pr !== "number" || typeof v.reason !== "string") return undefined;
  if (!v.to || !v.reason || !Number.isSafeInteger(v.pr) || v.pr <= 0) return undefined;
  return { to: v.to, pr: v.pr, reason: v.reason, why: typeof v.why === "string" ? v.why : "" };
}

/** The detach answer's `leftBehind` (item 16a) — what the release discarded —
 *  when well-formed: two non-negative integers; anything else reads as
 *  nothing reported, so an older resident's answer, or an unexpected shape,
 *  logs as before. */
function leftBehindAnswerOf(value: unknown): LeftBehind | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!count(v.uncommittedChanges) || !count(v.unpushedCommits)) return undefined;
  return { uncommittedChanges: v.uncommittedChanges, unpushedCommits: v.unpushedCommits };
}

/** What one `/attach` answered: the binding, or the refusal as the service
 *  sent it (its resolved status and body). */
type AttachAnswer =
  { ok: true; binding: ResidentBinding } | { ok: false; status: number; data: Record<string, unknown> };

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

/** 409 needs:"recreate" from /attach: a resumed run asked the resident to keep
 *  this thread's worktree as it stands (`reuse`), and there is no tree it can
 *  keep (gone with a recycled disk or an eviction, unreadable, or built for
 *  the other mode). The resident touched nothing; the caller decides what a
 *  run without its workspace does (docs/reference/specs/run-history.md item 54).
 *  Never a fresh attach's error: without `reuse` the resident recreates. */
export class ResidentReuseRefusedError extends Error {
  constructor(
    readonly resource: string,
    /** The resident's own words for what it found. */
    readonly why: string,
  ) {
    super(`resident attach: ${resource} cannot reuse this thread's worktree (${why})`);
    this.name = "ResidentReuseRefusedError";
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
  /** Consecutive `runtime-replaced` answers on the idempotent routes (/read,
   *  /write) with no successful op between them. One is a deploy that swapped
   *  the resident isolate under a call (routine: re-attach and re-issue); two
   *  in a row is a flapping resident and becomes infra. /exec never counts
   *  here: its `runtime-replaced` is the typed restart (`opWithReattach`). */
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
   *  reported: the bound ref — the resident's word, not the hint's: a differing
   *  refHint is ignored unless `ownPr` names it as the thread's own pull
   *  request and the resident moves a default-bound thread onto it (item 16;
   *  `rebound` / `rebindRefused` say which) — and the sha the worktree is at. A
   *  200 without both fields is a malformed resident (the attach contract
   *  always carries them) and is an error, never a half-bound executor. */
  async attach(span?: Span): Promise<ResidentBinding> {
    const answer = await this.attachOnce(span);
    if (answer.ok) return answer.binding;
    throw this.attachRefusal(answer);
  }

  /** One `/attach`, answered rather than thrown: the binding on a 200, else
   *  the refusal's status and body, so the wake wait (item 65) can read the
   *  refusal's own words and keep waiting through a container still rolling.
   *  `timeoutMs` bounds the call; the default is the exec ceiling, since an
   *  attach may wait on a restore or a deps install. */
  private async attachOnce(span?: Span, timeoutMs?: number): Promise<AttachAnswer> {
    const body: Record<string, unknown> = {};
    if (this.opts.refHint) body.refHint = this.opts.refHint;
    if (this.opts.readonly) body.readonly = true;
    if (this.opts.sha) body.sha = this.opts.sha;
    if (this.opts.reuse) body.reuse = true;
    if (this.opts.ownPr) body.ownPr = this.opts.ownPr;
    if (this.opts.refByDefault) body.refByDefault = true;
    const answered = await this.call("/attach", body, timeoutMs, undefined, span);
    const data = answered.data;
    // Post-validation answers stream like /exec (heartbeat whitespace then one
    // JSON document over HTTP 200, item 59) so an attach that waits on a deps
    // install cannot lose the connection; a streamed refusal carries its
    // status IN the body. Pre-validation refusals (400/404) keep real statuses.
    const status =
      answered.status === 200 && typeof data.error === "string" && typeof data.status === "number"
        ? data.status
        : answered.status;
    if (status !== 200) return { ok: false, status, data };
    if (typeof data.ref !== "string" || typeof data.sha !== "string") {
      throw new Error(`resident attach: malformed answer for ${this.opts.resource} (missing ref/sha)`);
    }
    const trace = sanitizeGraftedSteps(data.trace);
    const rebound = reboundOf(data.rebound);
    const rebindRefused = rebindRefusedOf(data.rebindRefused);
    const returned = reboundOf(data.returned);
    this.lastBinding = {
      ref: data.ref,
      sha: data.sha,
      ...(typeof data.workspace === "string" && data.workspace ? { workspace: data.workspace } : {}),
      ...(typeof data.user === "string" && data.user ? { user: data.user } : {}),
      ...(typeof data.container === "string" && data.container ? { container: data.container } : {}),
      ...(trace.length > 0 ? { trace } : {}),
      ...(typeof data.attachMs === "number" && Number.isFinite(data.attachMs) ? { attachMs: data.attachMs } : {}),
      ...(rebound !== undefined ? { rebound } : {}),
      ...(rebindRefused !== undefined ? { rebindRefused } : {}),
      ...(returned !== undefined ? { returned } : {}),
    };
    return { ok: true, binding: this.lastBinding };
  }

  /** The legible error for a refused attach, by the refusal the service
   *  named: needs-ref typed for the ask-once flow, not onboarded, anything
   *  else with its own words. The steps the resident ran before refusing ride
   *  the error (docs/reference/specs/tracing.md item 19): the dispatcher grafts
   *  them under its attach span. */
  private attachRefusal(answer: { status: number; data: Record<string, unknown> }): Error {
    const { status, data } = answer;
    const err = String(data.error ?? `HTTP ${status}`);
    const failedTrace = sanitizeGraftedSteps(data.trace);
    const traced = (e: Error): Error => (failedTrace.length > 0 ? withResidentTrace(e, { steps: failedTrace }) : e);
    if (status === 409 && data.needs === "ref") {
      const defaultRef = typeof data.defaultRef === "string" && data.defaultRef ? data.defaultRef : undefined;
      return traced(new ResidentNeedsRefError(this.opts.resource, defaultRef));
    }
    if (status === 409 && data.needs === "recreate")
      return traced(new ResidentReuseRefusedError(this.opts.resource, err));
    if (status === 404) return traced(new Error(`resident attach: ${this.opts.resource} is not onboarded (${err})`));
    return traced(new Error(`resident attach failed for ${this.opts.resource}: ${err}`));
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
   *  sweep. A run starts from a clean tree, so the tree goes whatever it
   *  holds: "if-idle" (`force:false`) lets the resident keep it only while a
   *  command is still in flight in it and answers what the release discarded
   *  (`leftBehind`); "always" (`force:true`) ends what is in flight and
   *  releases now. The binding (ref) survives either way, so the next attach
   *  recreates the tree on the same ref. Best-effort by contract: never
   *  throws. */
  async release(mode: ReleaseMode, opts?: ReleaseOptions): Promise<ReleaseResult> {
    try {
      // What the run pushed rides along when there is something to hand over
      // (docs/reference/specs/resident-repos.md item 16a): the resident
      // remembers it on the binding before the tree goes. Sent only then, so
      // an older resident sees the body it always did.
      const body: Record<string, unknown> = { force: mode === "always" };
      if (opts?.pushed !== undefined && opts.pushed.length > 0) body.pushed = opts.pushed;
      const { status, data } = await this.call("/detach", body, DETACH_TIMEOUT_MS, undefined, opts?.span);
      if (status !== 200) return { released: false, reason: `HTTP ${status}: ${String(data.error ?? "")}` };
      const leftBehind = leftBehindAnswerOf(data.leftBehind);
      return {
        released: data.released === true,
        reason: typeof data.reason === "string" ? data.reason : undefined,
        ...(leftBehind !== undefined ? { leftBehind } : {}),
      };
    } catch (err) {
      return { released: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Run a route; on needs:"attach" for an evicted worktree (in-body for
   *  /exec, 409 for /read //write) re-attach ONCE and retry, then fail legibly.
   *
   *  An answer saying the container under the thread is gone
   *  (`saysContainerGone`: `reason:"runtime-replaced"`, the isolate was swapped
   *  by a deploy while the op ran; `worktree-missing`, the container disk was
   *  recycled since the last attach) is, on /exec, the typed
   *  `ExecSandboxRestartedError` at once — the word the pi harness keys on
   *  (harness-pi item 16) — before any recovery, so nothing the recovery
   *  meets can hide it; the command may have started and is never re-issued.
   *  On the idempotent routes (/read, /write) a `runtime-replaced` re-attaches
   *  once — proving the new isolate serves this thread — and re-issues the op;
   *  two such answers with no success between them are infra (a flapping
   *  resident).
   *
   *  A refusal naming a container that just exited (item 65) waits for the
   *  wake first (`awaitWake`): the refusal came before the command started, so
   *  nothing ran, and the wait ends with the resident back and this thread
   *  re-attached, or with the strike the two-strikes rule always had. The
   *  idempotent routes are then re-issued; /exec is handed back to the runner
   *  as a restart to settle, since the worktree it was aimed at is gone with
   *  the old container's disk. `waitBudgetMs` (the command's budget) bounds
   *  that wait; `callTimeoutMs` bounds each call. */
  private async opWithReattach(
    route: string,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal; callTimeoutMs?: number; waitBudgetMs?: number; span?: Span } = {},
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const { signal, span } = opts;
    const callTimeoutMs = opts.callTimeoutMs ?? BASH_TIMEOUT_MS;
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
    // The container under the thread is gone: on /exec the typed restart, now.
    const goneUnderThread = (data: Record<string, unknown>): void => {
      if (route === "/exec" && saysContainerGone(data))
        throw new ExecSandboxRestartedError(containerGoneMessage(String(data.error)), 0);
    };
    let r = await this.call(route, body, callTimeoutMs, signal, span);
    if (isContainerRolling(r.data.error)) {
      const woke = await this.awaitWake(route, String(r.data.error), { signal, budgetMs: opts.waitBudgetMs, span });
      if (route === "/exec") throw new ExecSandboxRestartedError(sandboxRestartedMessage(woke), woke.waitedMs);
      r = await this.call(route, body, callTimeoutMs, signal, span);
      if (isContainerRolling(r.data.error)) {
        throw classifyError(
          new ExecInfraError(
            `resident ${route}: ${String(r.data.error)}; the container vanished again right after it woke`,
          ),
          { kind: "infra", code: "container-exited" },
        );
      }
    }
    goneUnderThread(r.data);
    if (r.data.needs === "attach") {
      await this.attach(span); // the recovery rides the same trace as the op it rescues
      r = await this.call(route, body, callTimeoutMs, signal, span);
      goneUnderThread(r.data);
      if (r.data.needs === "attach") throw stillGone(r.data);
    }
    if (r.data.reason === "runtime-replaced") {
      // An idempotent route (/exec threw above): re-attach once and re-issue.
      this.noteRuntimeReplaced(route, r.data);
      await this.attach(span); // the recovery rides the same trace as the op it rescues
      r = await this.call(route, body, callTimeoutMs, signal, span);
      if (r.data.reason === "runtime-replaced") this.noteRuntimeReplaced(route, r.data);
      // Compound fault: the deploy also left the worktree evicted. The
      // re-attach above was this op's one re-attach, so name it precisely
      // instead of falling through to the generic status error.
      if (r.data.needs === "attach") throw stillGone(r.data);
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

  /** Item 65: the container is gone for a moment. One `/status` decides
   *  whether it is coming back (`wakeDecision`); then, until the budget is
   *  spent, poll every `WAKE_POLL_MS` and re-attach as soon as the engine
   *  says it serves (the attach's own hydrate is the wake when nothing else
   *  has started it; a refusal that still names a rolling container keeps
   *  the wait going). Answers the wait and the fresh binding. Throws the
   *  strike (an `ExecInfraError` the tracker counts) when nothing is
   *  recovering, when the resident goes down mid-wait, when a re-attach does
   *  not answer, or when the budget is spent; a hard stop rejects at once
   *  with a plain error the runner unwinds; any other attach refusal is the
   *  attach's own legible error. */
  private async awaitWake(
    route: string,
    refusal: string,
    opts: { signal?: AbortSignal; budgetMs?: number; span?: Span },
  ): Promise<{ waitedMs: number; ref: string; sha: string }> {
    const t0 = systemClock();
    const waited = () => systemClock() - t0;
    const strike = (why: string): ExecInfraError =>
      classifyError(new ExecInfraError(`resident ${route}: ${refusal}; ${why}`), {
        kind: "infra",
        code: "container-exited",
      });
    const probe = () =>
      ResidentExecutor.probeStatus(
        this.opts.baseUrl,
        this.opts.token,
        this.opts.resource,
        WAKE_PROBE_TIMEOUT_MS,
        opts.span,
      );
    let seen = await probe();
    const decision = wakeDecision(seen);
    if (!decision.wait) throw strike(decision.why);
    const budget = wakeWaitBudget(opts.budgetMs);
    for (;;) {
      const spent = waited();
      if (spent >= budget) {
        throw strike(
          `waited ${Math.round(spent / 1000)}s for the resident to wake (last seen ${describeProbe(seen)}) and gave up`,
        );
      }
      await wakePause(Math.min(WAKE_POLL_MS, budget - spent), opts.signal);
      seen = await probe();
      const again = wakeDecision(seen);
      if (!again.wait) throw strike(again.why);
      if (seen.kind !== "status" || !isServiceable(seen.state, seen.reason)) continue;
      let answer: AttachAnswer;
      try {
        answer = await this.attachOnce(opts.span, Math.max(budget - waited(), 1_000));
      } catch (err) {
        if (!(err instanceof ExecInfraError)) throw err;
        throw strike(`the re-attach after ${Math.round(waited() / 1000)}s did not answer (${err.message})`);
      }
      if (answer.ok) return { waitedMs: waited(), ref: answer.binding.ref, sha: answer.binding.sha };
      if (!isContainerRolling(answer.data.error)) throw this.attachRefusal(answer);
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
    // A caller's extra environment (docs/reference/specs/harness-pi.md item 4)
    // rides in the body as `env`, the same convention as timeoutMs: only when
    // given, so an older resident sees the body it always did; the Worker reads
    // it through the one validated reader and hands it to the exec's env option.
    if (opts?.env !== undefined) body.env = opts.env;
    const { status, data } = await this.opWithReattach("/exec", body, {
      signal: opts?.signal,
      callTimeoutMs: timeoutMs + EXEC_CALL_MARGIN_MS,
      // The wake wait (item 65) may take what the command itself could: the
      // tool layer already clipped this to the run's remaining wall clock.
      waitBudgetMs: timeoutMs,
      span: opts?.span,
    });
    // A pre-validation client rejection — a plain HTTP 400 with an {error} and NO
    // `needs` (e.g. command-too-long), nothing streamed — is agent-fixable, not a
    // sick resident. Surface it as a normal Error so it does NOT count toward the
    // fail-fast infra counter and false-trip the abort on a HEALTHY
    // resident. Discriminated on the same signals attach() uses: HTTP status +
    // absence of `needs`.
    if (status === 400 && typeof data.error === "string" && data.error && data.needs === undefined) {
      throw new Error(`resident /exec: ${data.error}`);
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
    const { status, data } = await this.opWithReattach("/read", { path }, { span: opts?.span });
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /read: ${String(data.error ?? `HTTP ${status}`)}`), {
        kind: "http",
        code: String(status),
      });
    }
    return truncate(String(data.content ?? ""));
  }

  /** The same `/read` route asked for `encoding: "base64"` (src/execution/binaryRead.ts),
   *  with the same re-attach on an evicted worktree; a missing file is the
   *  route's 404 as for `readFile`, an over-cap file and a Worker that predates
   *  binary reads are `decodeBase64Read`'s plain errors. */
  async readBytes(path: string, opts?: ExecTraceOptions): Promise<Uint8Array> {
    const { status, data } = await this.opWithReattach("/read", { path, encoding: "base64" }, { span: opts?.span });
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /read: ${String(data.error ?? `HTTP ${status}`)}`), {
        kind: "http",
        code: String(status),
      });
    }
    return decodeBase64Read(data, { where: "resident /read", path });
  }

  async writeFile(path: string, content: string, opts?: ExecTraceOptions): Promise<string> {
    const { status, data } = await this.opWithReattach("/write", { path, content }, { span: opts?.span });
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /write: ${String(data.error ?? `HTTP ${status}`)}`), {
        kind: "http",
        code: String(status),
      });
    }
    return `Wrote ${path}`;
  }
}
