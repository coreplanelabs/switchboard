// The thread data plane's error shapes, and the builders that answer a throw
// no route named. Pure over `(err, route)`: the predicates only the Worker can
// supply — the pinned SDK's (its package imports `cloudflare:workers`, which
// plain Node cannot load) and the resident's own replacement classifier and
// vouch, which read the SDK's typed classes — are handed in
// (`threadErrBuilders`), so this module runs under plain Node
// (threadErr.test.ts, with the SDK's real sentences) where the entry runs only
// under workerd and its scans can read the wiring alone.
import {
  isRuntimeUnreachableReason,
  isRuntimeUnreachableSignal,
  selfAndCauses,
} from "../../src/execution/residentRefresh.js";
import type { ResidentLifecycleState } from "../../src/execution/residentState.js";
import type { ResidentStep } from "../../src/execution/residentStepTrace.js";
import type { RefusalCause } from "../../src/core/refusal.js";

// The cause-chain walker has one home, beside the wording lists; the Worker
// takes it from here with the rest of the thread data plane's shapes.
export { selfAndCauses };

/** The routes whose pending Durable Object call `threadRejectionErr` answers for. */
export type ThreadDataRoute = "/exec" | "/read" | "/write";

/** The message of whatever was thrown. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Named, RPC-cloneable error shape for the thread data plane. The Worker
 *  maps `status` to the HTTP status; extra fields (`needs`, `state`,
 *  `reason`) ride along into the body. */
export interface ThreadErr {
  error: string;
  status: number;
  /** Beside `state` on a 503 that carries the lifecycle state: the lifecycle
   *  REASON (`getStatus().reason`), kept apart from `reason`, which is the
   *  answer's own word (`mirror-busy`, `disk-pressure`, `image-stale`). The
   *  client reads the pair to decide whether the resident is coming back
   *  (execution.md item 9); reading `reason` there would take a busy mirror on
   *  a degraded-but-serviceable resident for a repo failure. */
  stateReason?: string;
  /** On the 500 for a throw no route named (`catchAllErr`, at the fetch
   *  handler's catch-all, a streamed route's rejection, a route's own catch
   *  around its body, the thread data plane's last resort): whether the throw
   *  it wrapped was the platform's own transient (`isTransientPlatformThrow`)
   *  — a re-probe clears it — or a deterministic throw in the route, judged at
   *  once. */
  transient?: boolean;
  /** The steps the request ran before it failed (docs/reference/specs/tracing.md item 19):
   *  a failed attach's trace is the one that says which step blew the budget. */
  trace?: ResidentStep[];
  needs?: string;
  /** With needs:"ref" — the resident's default branch, so the caller can bind by default. */
  defaultRef?: string;
  state?: ResidentLifecycleState;
  reason?: string;
  /** Why the route refused, in the seam's three classes (record 0054), so the
   *  caller reads a field instead of the words: a bad ref or a missing binding
   *  is `request`, a repository the App cannot see is `policy`, and the
   *  machinery's own failure is `system`. The words stay for the person; the
   *  cause is what the bot's command surfaces render by. */
  cause?: RefusalCause;
}

/** Where a replacement or a reset was met: the command's spawn or its collect
 *  inside the Durable Object, or the Worker's own call into it (`call`: a
 *  rejected stub, before the method could answer — a command on `/exec`, a
 *  read or a write on the file routes, so the wording says "request" there). */
export type FailurePhase = "spawn" | "collect" | "call";

/** The clause naming the moment, and the subject whose outcome is spoken of. */
function met(phase: FailurePhase): { while: string; whose: string } {
  if (phase === "spawn") return { while: "this command was starting", whose: "the command's" };
  if (phase === "collect") return { while: "this command was running", whose: "the command's" };
  return { while: "this request was pending at the Worker", whose: "the request's" };
}

/** The resident runtime (the Sandbox SDK's control session to the container)
 *  was replaced while a command was in flight — in practice a `wrangler deploy`
 *  swapping this DO's isolate mid-run (which otherwise surfaces as a fake
 *  "OOM" on the run). `phase` says where the SDK failed: `"spawn"` (the start
 *  RPC itself; the SDK never proves the process did NOT start), `"collect"` (a
 *  `StaleProcessHandleError` on an already-running process), or `"call"` (the
 *  Worker's stub call rejected before the method answered). In every case the
 *  command may have run, so the resident never re-issues it; the thread routes
 *  answer the NAMED `runtime-replaced` error and the client decides (idempotent
 *  read/write retry; exec is handed to the model). */
export class RuntimeReplacedError extends Error {
  constructor(
    readonly phase: FailurePhase,
    readonly cause: unknown,
    /** Whether the replacement was KNOWN where the failure was classified
     *  (`replacementKnown`): the SDK vouched the runtime moved, or a restore is
     *  under way for this resident. One decision, made once at the exec choke
     *  point, and it gates the word on `/exec` alone (`replacedExecAnswer`) —
     *  the incarnation swap is unconditional there. Unknown, the failure only
     *  says the container is down or the transport was lost — a merely asleep
     *  or starting container, or a network blip, say the same — so the answer
     *  is the SDK's words and the harness's one more command decides. At the
     *  Worker's call the SDK's vouch is the one half the Worker can make
     *  (`sdkVouchesRuntimeMoved` judges text, which survives the stub
     *  boundary); the restore half is the DO's alone. */
    readonly known: boolean,
  ) {
    const m = met(phase);
    super(
      `runtime-replaced: the resident runtime was replaced (a deploy) while ${m.while}; ${
        phase === "call" ? "its outcome is unknown" : "its output is lost"
      } (${messageOf(cause)})`,
    );
    this.name = "RuntimeReplacedError";
  }
}

/** The resident's own Durable Object was reset while a command was in flight —
 *  a `wrangler deploy` of the Worker code (not the container image) supersedes
 *  this DO's isolate, so the SDK's control session to the container is lost
 *  mid-command (`isDurableObjectCodeUpdateReset`). This is NOT a runtime
 *  replacement: the container and every process the run holds in it are exactly
 *  as they were — only the DO that was driving them reset. The command's
 *  outcome is unknown (the reset may have raced its start or its finish), so
 *  the resident never re-issues it here; the thread routes answer the NAMED
 *  `control-reset` error and the client re-sends an idempotent op or resolves a
 *  write by pi's echo (docs/reference/specs/harness-pi.md item 16). Distinct
 *  from `RuntimeReplacedError` precisely so the harness never mistakes a DO
 *  reset over a live pi for a replaced container and orphans that pi. */
export class ControlResetError extends Error {
  constructor(
    readonly phase: FailurePhase,
    readonly cause: unknown,
  ) {
    const m = met(phase);
    super(
      `control-reset: the resident's Durable Object was reset (a deploy) while ${m.while}; ` +
        `the container and its processes are as they were; ${m.whose} outcome is unknown (${messageOf(cause)})`,
    );
    this.name = "ControlResetError";
  }
}

/** The named ThreadErr every thread route (exec/read/write) answers for a
 *  runtime replacement, so the client can classify it (409 like the other
 *  recoverable thread states; `reason` is the discriminator). On `/exec` the
 *  answer goes through `replacedExecAnswer` first: the word only when the
 *  replacement was known where `run()` classified the failure. On `/read` and
 *  `/write` the word stays unconditional on purpose: those routes reach the
 *  same `run()` and can meet the same down wordings, but there the word drives
 *  the client's re-attach-and-retry (the attach is what wakes a container that
 *  is asleep or starting), never a verdict — nothing relaunches on it, and the
 *  harness never reads or writes through them (its seam runs every operation
 *  as an `/exec` script). Gating them would trade a spare re-attach for a read
 *  that fails outright while the container starts. */
export function runtimeReplacedErr(err: RuntimeReplacedError): ThreadErr {
  return { error: err.message, status: 409, reason: "runtime-replaced", cause: "system" };
}

/** The named ThreadErr a DO code-update reset answers with — its own `reason`
 *  the client keys on, distinct from `runtime-replaced`: the container is
 *  unchanged and the command's outcome is unknown, so the client re-sends an
 *  idempotent op or resolves a write by echo (harness-pi item 16), never the
 *  replaced verdict. */
export function controlResetErr(err: ControlResetError): ThreadErr {
  return { error: err.message, status: 409, reason: "control-reset", cause: "system" };
}

/** The platform's transient sentences the pinned SDK's own predicate does not
 *  name. `isPlatformTransientError` covers the code-update reset, a lost
 *  connection, the storage-startup reset (`internal error while starting up
 *  durable object storage caused object to be reset`) and the typed
 *  `retryable` flag, so those are read from the SDK, never from a table of
 *  ours. Four remain, each anchored to its sentence so a git or GitHub failure
 *  that embeds the same words never matches:
 *  - the platform's bare `internal error` — workerd's own catch-all when a
 *    stub call died for a platform-internal reason — anchored to the WHOLE
 *    message, where git's `fatal: internal error` is not, and read on the
 *    TOP-LEVEL throw alone (`PLATFORM_INTERNAL_ERROR_WORDING`, never on the
 *    cause chain): a Worker's own failed outbound `fetch()` carries exactly
 *    that message too, so a route's wrapped GitHub or mirror subrequest
 *    failure — the fetch error as the route's `cause` — is that route's
 *    deterministic failure, never a blip a re-probe clears; the SDK's
 *    predicate types the bare message only where workerd set its `retryable`
 *    flag on it, and nothing in the SDK's source or a live receipt says it
 *    always does (an assumption about the platform, named);
 *  - the memory-limit reset, `Durable Object's isolate exceeded its memory
 *    limit and was reset.` (the platform's text as an assumption too, not in
 *    the SDK's source; its predicate carries no pattern for it);
 *  - the Durable Object reset by a storage operation that did not complete
 *    (`Durable Object storage operation exceeded timeout which caused object
 *    to be reset.`, an assumption about the text carried from the first
 *    typing of the catch-all — anchored to the sentence's tail, so a route's
 *    own `storage operation failed` is not it);
 *  - the Durable Object overloaded. The SDK's retry predicate EXCLUDES that
 *    sentence (`isErrorRetryable`: an in-process retry only adds to a queue
 *    that is full); it is typed transient here because the client's
 *    `worker-unavailable` is a re-probe after the harness's bounded wait
 *    (`replacedVerdict`, `PROBE_WAIT_MAX_MS`), never a tight retry, and a full
 *    queue drains. */
export const TRANSIENT_PLATFORM_WORDING =
  /exceeded its memory limit and was reset|storage operation exceeded timeout which caused object to be reset|durable object is overloaded/i;

/** The platform's bare `internal error`, the whole message — read on the
 *  top-level throw only (see above): one link down it is a Worker's own failed
 *  subrequest, wrapped by the route that made it. */
export const PLATFORM_INTERNAL_ERROR_WORDING = /^internal error\.?$/i;

/** What only the Worker knows about a throw, handed in so the rules below stay
 *  pure: the pinned SDK's predicates (`isDurableObjectCodeUpdateReset` as
 *  `isControlReset`, `isPlatformTransientError`) and the resident's own
 *  replacement classifier and vouch, which read the SDK's typed classes
 *  beside the wording lists this module could import. */
export interface ThrowPredicates {
  /** The SDK's own code-update reset predicate. */
  isControlReset(err: unknown): boolean;
  /** The resident's replacement classifier: the SDK's typed classes, an RPC
   *  transport loss, or the replacement wording anywhere in the cause chain. */
  isRuntimeReplacement(err: unknown): boolean;
  /** The resident's vouch that the runtime MOVED (the SDK's typed classes and
   *  `RUNTIME_MOVED_WORDING`), never a mere down wording. */
  sdkVouchesRuntimeMoved(err: unknown): boolean;
  /** The SDK's own platform-transient predicate. */
  isPlatformTransientError(err: unknown): boolean;
}

/** What a caller may already know of a throw, so the verdict does not walk the
 *  cause chain for it again: `threadRejectionErr` settles the reset and the
 *  replacement before it reaches the typed 500 and hands both in. */
export interface KnownVerdicts {
  controlReset?: boolean;
  runtimeReplacement?: boolean;
}

export interface ThreadErrBuilders {
  /** Whether a throw no route named is the platform's own transient — the
   *  Durable Object reset by a deploy, the runtime replaced under the call,
   *  the SDK's own platform-transient signal, the container's runtime
   *  unreachable, or a remainder sentence — against a deterministic throw in
   *  the route itself (a bug, a bad argument). The client reads the answer's
   *  `transient` field to re-probe the first and judge the second at once
   *  (execution.md item 9), never the words. `known` skips a predicate the
   *  caller settled. */
  isTransientPlatformThrow(err: unknown, known?: KnownVerdicts): boolean;
  /** The 500 for a throw no route named, at whichever catch met it — the fetch
   *  handler's catch-all, a streamed route's rejection mapper, a route's own
   *  catch around its body (`prefix`: `attach-failed`, `op-failed`), the thread
   *  data plane's last resort: the words, and whether the throw was the
   *  platform's transient (`transient`), typed here so the client decides by a
   *  field and never by which catch met the throw. A failure a route DID name
   *  — a step that failed, a mirror held — is that route's own answer and
   *  never comes here. */
  catchAllErr(err: unknown, prefix?: string, known?: KnownVerdicts): ThreadErr;
  /** A thread data-plane route's pending Durable Object call that REJECTED —
   *  the stub, not the method: the DO reset by a code update before or while
   *  the method ran, the runtime replaced or unreachable, a storage operation
   *  that did not complete — answered as the DO answers the same fact when it
   *  catches it inside (`execThreadImpl`, the file methods). A control reset is
   *  the DO's own word, `control-reset` on a 409: the container and its
   *  processes are as they were and the outcome is unknown, so the client
   *  resolves it by its own rule and never waits on it as the resident
   *  unavailable. A runtime replacement is answered by route, as the methods
   *  answer it, with the DO's own gate (`replacementKnown`) applied as far as
   *  it reaches: its first half, the SDK vouching the runtime moved, judges the
   *  moved sentences that survive the stub boundary as text, so it is made
   *  here by the same rule; its other half, a restore under way
   *  (`knowsContainerGone`), is the DO's alone. So on `/exec` the word is said
   *  where the SDK vouched and WITHHELD where only the DO could have — that
   *  gate's unknown branch, the SDK's words on a 409 with no word, for the
   *  harness's one more command to judge; on `/read` and `/write` the word is
   *  said either way (`runtimeReplacedErr`, unconditional there on purpose),
   *  since it drives the client's one re-attach-and-retry and never a verdict.
   *  Anything else is the typed 500. */
  threadRejectionErr(err: unknown, route: ThreadDataRoute): ThreadErr;
}

/** The builders over the predicates only the Worker can supply. */
export function threadErrBuilders(p: ThrowPredicates): ThreadErrBuilders {
  const isTransientPlatformThrow = (err: unknown, known: KnownVerdicts = {}): boolean => {
    const controlReset = known.controlReset ?? p.isControlReset(err);
    const runtimeReplacement = known.runtimeReplacement ?? p.isRuntimeReplacement(err);
    if (controlReset || runtimeReplacement || p.isPlatformTransientError(err)) return true;
    // The platform's bare `internal error`: the top-level throw alone — a
    // wrapped one is a route's own failed subrequest (a GitHub or mirror fetch).
    if (PLATFORM_INTERNAL_ERROR_WORDING.test(messageOf(err))) return true;
    // One walk of ours (the SDK's predicates above walk their own): the
    // container's runtime unreachable — the SDK's connect abort by its
    // `AbortError` name or its sentence (`isRuntimeUnreachableSignal`), or the
    // resident's own renamed word `runtime-unreachable:` (`run()` renames the
    // abort before it escapes a method, so that word is what crosses the stub;
    // `isRuntimeUnreachableReason`) — and the remainder sentences.
    for (const link of selfAndCauses(err)) {
      if (isRuntimeUnreachableSignal(link)) return true;
      const message = messageOf(link);
      if (isRuntimeUnreachableReason(message) || TRANSIENT_PLATFORM_WORDING.test(message)) return true;
    }
    return false;
  };
  const catchAllErr = (err: unknown, prefix?: string, known?: KnownVerdicts): ThreadErr => {
    const words = messageOf(err);
    return {
      error: prefix ? `${prefix}: ${words}` : words,
      status: 500,
      transient: isTransientPlatformThrow(err, known),
      // A throw no route named is the machinery's own: system.
      cause: "system",
    };
  };
  const threadRejectionErr = (err: unknown, route: ThreadDataRoute): ThreadErr => {
    const controlReset = p.isControlReset(err);
    if (controlReset) return controlResetErr(new ControlResetError("call", err));
    const runtimeReplacement = p.isRuntimeReplacement(err);
    if (runtimeReplacement) {
      const vouched = p.sdkVouchesRuntimeMoved(err);
      if (route === "/exec" && !vouched) return { error: messageOf(err), status: 409, cause: "system" };
      return runtimeReplacedErr(new RuntimeReplacedError("call", err, vouched));
    }
    // The two verdicts just settled ride into the typed 500, so its walk of the
    // cause chain is for the transient alone.
    return catchAllErr(err, undefined, { controlReset, runtimeReplacement });
  };
  return { isTransientPlatformThrow, catchAllErr, threadRejectionErr };
}

/** /exec's failure document, in the item-3 dual shape (`error` beside
 *  `stdout: ""`, `stderr`, `exitCode: 127`) so old and new executors both
 *  render it. The ThreadErr's fields ride beside the words, as the JSON routes
 *  carry them: `needs`; the lifecycle pair (`state`, `stateReason`); the
 *  answer's own word (`reason`, kept independent of `state` — `runtimeReplacedErr()`
 *  sets `reason: "runtime-replaced"` with NO state, and the client's
 *  deploy-vs-dead-transport check reads it); the answer's `status`; the
 *  catch-all's `transient`. The client types a streamed failure by these fields
 *  (execution.md item 9), and a document that dropped them would make every
 *  /exec failure a deterministic answer over HTTP 200. One builder for both of
 *  the stream's paths: a failure the Durable Object named, and a pending
 *  result that rejected. */
export function execFailureDocument(failure: ThreadErr): object {
  return {
    error: failure.error,
    ...(failure.needs ? { needs: failure.needs } : {}),
    ...(failure.state ? { state: failure.state } : {}),
    ...(typeof failure.stateReason === "string" ? { stateReason: failure.stateReason } : {}),
    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(failure.cause ? { cause: failure.cause } : {}),
    status: failure.status,
    ...(typeof failure.transient === "boolean" ? { transient: failure.transient } : {}),
    stdout: "",
    stderr: failure.error,
    exitCode: 127,
  };
}
