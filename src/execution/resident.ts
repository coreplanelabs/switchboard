import { DRAIN } from "../core/budgets.js";
import { refusalOf, residentErrorCause, RefusalError } from "../core/refusal.js";
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
  isWakeable,
  sandboxRestartedMessage,
  saysContainerGone,
  saysControlReset,
  wakeDecision,
  wakeWaitBudget,
  type WakeDecision,
} from "./residentWake.js";
import type { ResidentStep } from "./residentStepTrace.js";
import { sanitizeGraftedSteps, withResidentTrace } from "./residentTrace.js";
import { repoResourceId } from "../core/residentAdmin.js";
import { EXEC_CALL_MARGIN_MS, attachBoundWithinRun, clampBashTimeout } from "./bashTimeout.js";
import type { ResidentLiveStateObserver } from "../core/runLiveState.js";
import { DISK_PRESSURE_REASON } from "./residentDiskBudget.js";
import {
  MEMORY_PRESSURE_REASON,
  RUNTIME_BUSY_BACKOFF_MS,
  RUNTIME_BUSY_REASON,
  RUNTIME_BUSY_WAIT_MAX_MS,
  runtimeBusyExhaustedMessage,
} from "./sandboxErrors.js";
import {
  BASH_TIMEOUT_MS,
  BASH_TIMEOUT_MAX_MS,
  ExecCapacityError,
  ExecControlResetError,
  ExecInfraError,
  ExecSandboxRestartedError,
  decodeBase64Read,
  execDeadline,
  infraReasonOfRequestFailure,
  infraReasonOfStatus,
  requestFailedMessage,
  type ExecInfraReason,
  truncate,
  type ExecOptions,
  type Executor,
  type ReleaseMode,
  type ReleaseResult,
} from "./executor.js";
import { isDeadlineMiss, type ExecTraceOptions, type MoveOptions, type ReleaseOptions } from "./executor.js";
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

/** The typed reason for a resident answer the client got no result from,
 *  decided by the fields the resident types on it, never by its prose
 *  (execution.md item 9). A 5xx that carries the resident's `state` — the
 *  hydrate path's `not-serviceable` answers, the mirror mutex held by a refresh
 *  (`mirror-busy`), attach's `image-stale` — is the resident unavailable
 *  (`worker-unavailable`, a wait may clear it) when that state says the
 *  resident is coming back (`isWakeable`: restoring, serviceable, a degraded
 *  reason the engine retries — the same decision the wake path makes), and a
 *  refusal no wait clears otherwise (`down`, `onboarding`, a repo failure) —
 *  as is `reason: "unregistered"` (no record or facts to serve from). A 5xx
 *  with a body but no state — the fetch handler's catch-all 500 for an
 *  unnamed throw, `read-failed`, `attach-failed at <step>`, `op-failed` — is
 *  deterministic: the resident answered, so its words decide at the harness's
 *  seam (`answered`) and the failure stands at once instead of being re-run for
 *  five minutes. A bare 5xx with nothing (an edge error page) is the Worker
 *  unavailable. A body on any other status is the resident's words — the
 *  SDK's text forwarded, a named refusal — read at the seam; a bare 4xx is
 *  refused. */
export function residentAnswerReason(status: number, data: Record<string, unknown>): ExecInfraReason {
  if (status >= 500 && status <= 599) {
    if (data.reason === "unregistered") return "refused";
    // The lifecycle pair the resident puts on the answer: `state` and
    // `stateReason`. Never the answer's OWN word in `reason` (`mirror-busy`,
    // `disk-pressure`, `image-stale`), which would read a busy mirror on a
    // degraded-but-serviceable resident as a repo failure. `lifecycleReasonOf`
    // holds the one reading, and the fallback for a Worker predating
    // `stateReason`, whose not-serviceable answers carried the lifecycle
    // reason in `reason`.
    if (typeof data.state === "string")
      return isWakeable(data.state, lifecycleReasonOf(data)) ? "worker-unavailable" : "refused";
    // The 500 for a throw no route named says whether the throw was the
    // platform's own transient (a Durable Object reset by a deploy, a lost
    // connection, a storage operation that did not complete), at whichever
    // catch met it: a re-probe clears those; every other stateless 5xx with a
    // body is deterministic.
    if (data.transient === true) return "worker-unavailable";
    if (typeof data.error === "string" && data.error) return "answered";
    return infraReasonOfStatus(status);
  }
  if (typeof data.error === "string" && data.error) return "answered";
  return infraReasonOfStatus(status);
}

/** The status a resident answer says. The streamed routes — `/exec`, `/attach`,
 *  `/await-restore` and `/op` write heartbeat whitespace then ONE JSON
 *  document, so a long command, a deps install, a restore or a suite cannot
 *  lose the connection — put a refusal's own status IN the body over HTTP 200,
 *  and that is the status the answer is typed by (`residentAnswerReason`,
 *  `isTransientRefusal`). Any other answer's status is the HTTP status: a
 *  body's `status` on a real 4xx/5xx, or on a success document (which carries
 *  no `error`), is never read. One rule for the four routes. */
export function answeredStatus(httpStatus: number, data: Record<string, unknown>): number {
  return httpStatus === 200 && typeof data.error === "string" && typeof data.status === "number"
    ? data.status
    : httpStatus;
}

/** Whether an attach refusal is the platform's transient, by its provenance —
 *  the rule `probeStatus` types a `/status` answer by, so both routes judge one
 *  provenance (execution.md item 9): a 5xx the Worker typed `transient: true`
 *  (the Durable Object reset or lost under the attach), or a 5xx carrying no
 *  Worker document at all — no string `error`, which every route's catch puts
 *  on its answer: the edge's own page, where the Worker never ran. The one
 *  rule at every site that judges a refusal (`attach`, `attachRefusal`, the
 *  wake wait's re-attach, `/op`'s reader), so a `transient` flag on any other
 *  status is never a reason to wait, and the Worker's own untyped 5xx never is. */
export function isTransientRefusal(answer: { status: number; data: Record<string, unknown> }): boolean {
  if (answer.status < 500 || answer.status > 599) return false;
  return answer.data.transient === true || typeof answer.data.error !== "string";
}

/** The fleet drain (docs/reference/specs/resident-repos.md item 69): `/attach`
 *  answers 503 with a `draining` record while a deploy waits for the runs in
 *  flight to end. A new run waits at its attach for the fleet to reopen — one
 *  re-attach per poll — under its own lease, never the wake budget (a drain
 *  lasts as long as the longest run in flight, tens of minutes; a wake is
 *  seconds). The refusal is read by its record, never by its words. */
export const DRAIN_POLL_MS: number = DRAIN.pollMs;
/** The most a run waits for a drain to lift with no lease to clip it (the CLI,
 *  staging): past a coding child's whole lease, like the deploy's own wait. */
export const DRAIN_WAIT_MAX_MS: number = DRAIN.waitMaxMs;
/** What the wait leaves of the run's lease for the attach and the work after
 *  it: a drained run that would start with less has nothing to start for. */
export const DRAIN_LEASE_RESERVE_MS: number = DRAIN.leaseReserveMs;
/** The drain wait where a fallback stands behind the attach (issue 2101): the
 *  factory's first attach falls to a seeded sandbox, which stands up in about
 *  two minutes, so the wait is bounded by the fallback's own cost — never the
 *  deploy's. Passed as `drainBoundMs`; an attach with no fallback (a resumed
 *  run's re-attach, a mid-run recovery) passes none and keeps the lease's bound. */
export const DRAIN_FALLBACK_WAIT_MS: number = DRAIN.fallbackWaitMs;

/** Stamp the drain's share of a failed wait on the error, so the factory's
 *  fallback can publish the run's `drain_wait` note even though the attach
 *  never answered a binding to carry it (issue 2101: the incident's run fell
 *  to the sandbox and `runs friction` counted `drain_wait: 0`). */
function stampDrainWait<E>(err: E, waitedMs: number): E {
  if (err !== null && typeof err === "object") (err as { drainWaitMs?: number }).drainWaitMs = waitedMs;
  return err;
}

/** The drain's share stamped on an error thrown out of the drain wait — the
 *  typed `ResidentDrainingError`, the attach's own refusal after the drain
 *  ended, or the wake hand-off's strike; undefined when the attach met no
 *  drain. */
export function drainSeedAdmittedOf(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { seedAdmitted?: unknown }).seedAdmitted === true;
}

export function drainWaitOf(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const stamped = (err as { drainWaitMs?: unknown }).drainWaitMs;
  return typeof stamped === "number" && stamped > 0 ? stamped : undefined;
}

export function isDrainingRefusal(answer: { status: number; data: Record<string, unknown> }): boolean {
  const d = answer.data.draining;
  return (
    answer.status === 503 && typeof d === "object" && d !== null && typeof (d as { until?: unknown }).until === "string"
  );
}

/** The drain's own end, as the record says it; undefined when unreadable. */
function drainingUntil(answer: { data: Record<string, unknown> }): string | undefined {
  const d = answer.data.draining as { until?: unknown } | undefined;
  return typeof d?.until === "string" ? d.until : undefined;
}

/** The wait for the fleet to reopen ran out — the run's lease, or the ceiling
 *  — with the fleet still drained. Typed `refused`: no wait clears it, and the
 *  factory reports it as the attach's own refusal, naming the drain. */
export class ResidentDrainingError extends ExecInfraError {
  constructor(
    readonly resource: string,
    readonly waitedMs: number,
    readonly until: string | undefined,
    words: string,
    readonly seedAdmitted = false,
  ) {
    super(
      `resident /attach: the fleet is drained for a deploy and did not reopen within the ${Math.round(waitedMs / 1000)}s this run could wait` +
        `${until ? ` (the drain ends by ${until})` : ""} — ${words}`,
      "refused",
    );
    this.name = "ResidentDrainingError";
    classifyError(this, { kind: "infra", code: "attach" });
  }
}

/** An attach this executor did not open: the run's lease is inside its
 *  write-up reserve, or has less past it than an attach needs
 *  (`attachBoundWithinRun` said `exhausted`; execution.md item 9). Thrown by
 *  every attach this executor opens for the run — a relaunch's re-attach, the
 *  wake wait's re-attach, the recovery attaches an `/exec`, `/read` or
 *  `/write` opens on `needs: attach`, a control reset or a replaced runtime.
 *  Typed `refused` — no wait clears it, so the harness's one more command
 *  never holds a run on it — and read apart by class where the run's end is
 *  decided: a relaunch's re-attach ends the run on its budget
 *  (`WorkspaceReattachLeaseSpentError` in the factory); on a command of the
 *  wind-down or a post-step it is that command's own failure, never the
 *  container's verdict (`identity` answers no name on a `refused`). `note` is
 *  the bound's own sentence, worded by the bound that refused. */
export class ResidentLeaseSpentError extends ExecInfraError {
  constructor(
    route: string,
    readonly note: string,
    /** The run's wall clock left when the attach was not opened. */
    readonly leftMs: number,
  ) {
    super(`resident ${route}: ${note}`, "refused");
    this.name = "ResidentLeaseSpentError";
    classifyError(this, { kind: "infra", code: "attach" });
  }
}

/** A refusal's words for the card and the strike: the Worker's `error`, or
 *  the status alone when no Worker document answered. */
function refusalWords(answer: { status: number; data: Record<string, unknown> }): string {
  return typeof answer.data.error === "string"
    ? answer.data.error
    : `HTTP ${answer.status} with no Worker document in the answer`;
}

/** The words a resident answer uses for ITSELF in `reason` on a 5xx that
 *  carries `state` — never a lifecycle reason: the mirror held
 *  (`mirror-busy`), the disk full (`disk-pressure`), the container restarting
 *  (`image-stale`). The answer's other own words never reach this reading:
 *  `unregistered` is refused before it (`residentAnswerReason`), and
 *  `runtime-replaced` and `control-reset` are 409s carrying no state. */
const ANSWER_OWN_WORDS: ReadonlySet<string> = new Set([
  "mirror-busy",
  DISK_PRESSURE_REASON,
  "image-stale",
  RUNTIME_BUSY_REASON,
  MEMORY_PRESSURE_REASON,
]);

/** The lifecycle reason on a resident answer: `stateReason` where the Worker
 *  names it (every 503 that carries `state`); on a Worker that predates the
 *  field, the `reason` its not-serviceable answers carried the lifecycle
 *  reason in — unless it is one of the answer's own words, which
 *  say nothing about the lifecycle. So a bot deployed ahead of its resident
 *  still waits through a `degraded (github-unreachable)` resident's
 *  not-serviceable 503 instead of refusing every degraded answer for the skew
 *  window; only the old Worker's mirror-busy on a degraded resident stays
 *  unreadable (no lifecycle reason on it at all). */
function lifecycleReasonOf(data: Record<string, unknown>): string {
  if (typeof data.stateReason === "string") return data.stateReason;
  if (typeof data.reason === "string" && !ANSWER_OWN_WORDS.has(data.reason)) return data.reason;
  return "";
}

/** What the wake path's strike says to the harness's one more command, from
 *  the last engine view (`isWakeable`): the resident still coming back is
 *  `worker-unavailable` — the harness's bound is the longer clock — and a
 *  definite view, or a Worker that did not answer `/status`, is `refused`. The
 *  one decision for the budget strike and for a re-attach that failed as infra
 *  inside the wait (whose own verdict was made under this client's clipped
 *  timeout, not by the resident); a stop stays `aborted`. */
export function wakeStrikeReason(last: ResidentStatusProbe, transient = false): ExecInfraReason {
  // A wait that a transient refusal began (the Durable Object reset or lost
  // under the attach) and whose Worker never answered `/status`: the same
  // blip, and nothing definite was ever seen — the resident unavailable, for
  // a longer clock to wait on; never a refusal. A 4xx is an answer, definite.
  if (transient && isUnansweredProbe(last)) return "worker-unavailable";
  return last.kind === "status" && isWakeable(last.state, last.reason) ? "worker-unavailable" : "refused";
}

/** A `/status` probe nothing answered: the transport failed, or the answer
 *  was the platform's transient — a 5xx the Worker typed so (the Durable
 *  Object reset or lost under an attach loses the probe too), or a 5xx with no
 *  Worker document at all, the edge's own error page where the Worker never
 *  ran. A 4xx is an answer (an operator token no longer accepted), and so is a
 *  5xx the Worker answered without typing it transient — a throw in the status
 *  route; neither is this. The one rule the wake wait's transient mode, its
 *  strike and the selection probe's wait read a view by. */
export function isUnansweredProbe(
  view: ResidentStatusProbe,
): view is Extract<ResidentStatusProbe, { kind: "unreachable" }> {
  // Typed by its provenance (`probeStatus`; execution.md item 9), never by the
  // status class alone: `transient` says the answer was the platform's — the
  // Worker's word, or no Worker document to carry one. No skew clause here, on
  // purpose: a resident Worker from before the typing (1.245.0 carries it)
  // answers a platform throw as an untyped 5xx, which this rule strikes at
  // once — one cold run, where a clause admitting it would re-admit a route's
  // own throw as the blip for as long as it stayed.
  return view.kind === "unreachable" && (view.transport || view.transient === true);
}

/** What began a wake wait, and so what its strike says happened: a refusal
 *  naming a container gone for a moment (`container-exited`, waited "to wake"),
 *  or a refusal the Worker typed as the platform's transient — the Durable
 *  Object reset or lost under an attach, no container exited
 *  (`transient-refusal`, waited "to come back"). The strike's classification
 *  code and its sentence are the origin's. */
export type WakeOrigin = "container-exited" | "transient-refusal";

/** The strike after the wake budget ran out, as `awaitWake` throws it: how long
 *  was waited, what the engine last said, and the reason `wakeStrikeReason`
 *  draws from that view. Exported so the seam's parity test builds the strike
 *  through the same decision this client makes. */
export function residentWakeBudgetStrike(
  route: string,
  refusal: string,
  spentMs: number,
  last: ResidentStatusProbe,
  wait: {
    /** What began the wait: the strike's code and sentence. A container's exit when absent. */
    origin?: WakeOrigin;
    /** The wait runs in transient mode (an unanswered last view is the same blip, not a refusal):
     *  the origin's unless a transient re-attach inside a container-exit wait set it. */
    transient?: boolean;
  } = {},
): ExecInfraError {
  const origin = wait.origin ?? "container-exited";
  const transient = wait.transient ?? origin === "transient-refusal";
  const waitedFor = origin === "container-exited" ? "to wake" : "to come back";
  return residentWakeStrike(
    route,
    refusal,
    `waited ${Math.round(spentMs / 1000)}s for the resident ${waitedFor} (last seen ${describeProbe(last)}) and gave up`,
    wakeStrikeReason(last, transient),
    origin,
  );
}

/** The strike after the wake wait (item 65): the refusal that named a
 *  container gone for a moment, why the wait ended without it back, and what
 *  that says to the harness's one more command. A wait that ran out while the
 *  resident was still coming back (`isWakeable` on the last engine view: a
 *  restore under way, a starting container) is the resident unavailable
 *  (`worker-unavailable`): this client's budget is the command's own, and the
 *  harness's restore-window bound (`PROBE_WAIT_MAX_MS`) is a different, longer
 *  clock — one restore must get one wait whatever route the resident answered
 *  by (harness.md item 6). A definite engine view (`down`, `onboarding`, a
 *  Worker that did not answer `/status`) is `refused`: nothing says the
 *  container is coming back. Classified `infra` with the wait's origin as the
 *  code — `container-exited` for the wait a container's exit began, the one
 *  the tracker counts, `transient-refusal` for the wait a transient refusal
 *  began, where no container exited. Exported so the seam's tests build the
 *  strike as this client throws it. */
export function residentWakeStrike(
  route: string,
  refusal: string,
  why: string,
  reason: ExecInfraReason,
  origin: WakeOrigin = "container-exited",
): ExecInfraError {
  return classifyError(new ExecInfraError(`resident ${route}: ${refusal}; ${why}`, reason), {
    kind: "infra",
    code: origin,
  });
}

/** The wake wait's end by the run's own stop during a pause or a probe: the
 *  stop's one typed shape — `ExecInfraError` with reason `aborted`, classified
 *  as the transport, exactly what `call` throws when the stop drops a send
 *  (the re-attach's own case) — so a caller that counts infra failures sees
 *  the same thing from every stop point, and nothing waits on a run that was
 *  stopped. */
export const wakeStopped = (route: string): ExecInfraError =>
  classifyError(
    new ExecInfraError(`resident ${route}: stopped waiting for the resident to wake: the run was stopped`, "aborted"),
    { kind: "transport" },
  );

/** The busy wait's end by the run's own stop during a pause: the same one
 *  typed shape as the wake wait's (`wakeStopped`), naming this wait. */
export const busyStopped = (route: string): ExecInfraError =>
  classifyError(
    new ExecInfraError(
      `resident ${route}: stopped waiting for the container to accept the connection: the run was stopped`,
      "aborted",
    ),
    { kind: "transport" },
  );

/** Resolve after `ms`, or reject with the stop's typed error the moment
 *  `signal` fires — a hard stop must not sit out a busy wait. */
function pauseUnlessStopped(route: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(busyStopped(route));
    const onAbort = () => {
      clearTimeout(timer);
      reject(busyStopped(route));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolve after `ms`; reject the moment `signal` fires. A hard stop never
 *  sits out a wake, and the rejection is `wakeStopped`. */
function wakePause(ms: number, signal: AbortSignal | undefined, route: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(wakeStopped(route));
    const onAbort = () => {
      clearTimeout(timer);
      reject(wakeStopped(route));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The wake path's ONE loop over `/status` views (item 65; execution.md item
 *  9) — the wake wait's (`awaitWake`, which re-attaches inside it) and the
 *  selection probe's wait through a blip (the factory's) both run here, so one
 *  pause (`WAKE_POLL_MS`, clipped to the budget), one stop check and one
 *  budget rule serve both; each caller's `probe` keeps its own deadline (the
 *  wake's `WAKE_PROBE_TIMEOUT_MS`, the selection's configured one) and is
 *  handed the run's stop. `judge` reads the view in hand — `{ end }` finishes
 *  with that value, `"wait"` pauses then probes again, `"again"` probes again
 *  at once (a view worth re-reading without a pause). The budget bounds the
 *  PROBING, on a clock that starts where the caller's wait did (`since`:
 *  before the probe that produced `first`, so the strike's `spentMs` is the
 *  whole wait, never short by one probe): when it is spent before the next
 *  probe, `spent` answers (or throws) from the last view. The run's stop,
 *  riding into the pause and every probe, ends the loop with `wakeStopped`'s
 *  typed error. */
export async function waitOnStatus<T>(input: {
  first: ResidentStatusProbe;
  /** When the wait began — the caller's clock before the probe that produced `first`; now when absent. */
  since?: number;
  probe: (signal: AbortSignal | undefined) => Promise<ResidentStatusProbe>;
  budgetMs: number;
  signal?: AbortSignal;
  route: string;
  /** Reads the view in hand; `spent()` is the wait's one clock, read whenever a message or a verdict needs it. */
  judge: (view: ResidentStatusProbe, spent: () => number) => Promise<{ end: T } | "wait" | "again">;
  spent: (last: ResidentStatusProbe, spentMs: number) => T;
}): Promise<T> {
  const t0 = input.since ?? systemClock();
  const spent = (): number => systemClock() - t0;
  let view = input.first;
  for (;;) {
    const verdict = await input.judge(view, spent);
    if (verdict !== "wait" && verdict !== "again") return verdict.end;
    const spentMs = spent();
    if (spentMs >= input.budgetMs) return input.spent(view, spentMs);
    if (verdict === "wait")
      await wakePause(Math.min(WAKE_POLL_MS, input.budgetMs - spentMs), input.signal, input.route);
    view = await input.probe(input.signal);
    // The run's stop rides into the probe as into every send: a stop during one
    // is the stop's own typed error, as the pause throws it — never a verdict on
    // an "unreachable" view the stop itself produced.
    if (input.signal?.aborted) throw wakeStopped(input.route);
  }
}

export interface ResidentExecutorOptions {
  /** Base URL of the resident Worker. */
  baseUrl: string;
  /** Operator bearer (RESIDENT_OPERATOR_TOKEN secret). */
  token: string;
  /** Resource id, e.g. "repo:jshttp/vary". */
  resource: string;
  threadKey: string;
  /** Stable identity of this run for persisted drain-seed admission. A caller
   *  without a run (load tools and legacy clients) falls back to threadKey. */
  admissionKey?: string;
  /** Ref for an attach. A ref the request names is authoritative and replaces
   *  an older sticky binding; the sticky binding is only a fallback when the
   *  request names none (`refByDefault` is true, `ownPr` derived the hint, or
   *  this field is absent). The resident persists the named ref on the binding
   *  (item 16). */
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
  /** The run's remaining wall clock (`RunControl.remainingMs`, the dispatch's
   *  hand-off; undefined until the harness starts the lease), read at the
   *  moment each attach this executor opens: every attach request — the first
   *  of an `attach()`, each re-attach inside a wake wait, a recovery attach —
   *  is bounded by the attach's own default clipped to it, and inside the
   *  write-up reserve none is opened (`attachBoundWithinRun`; execution.md item
   *  9). Never sent to the Worker. Absent for an executor built with no run
   *  (staging, the CLI): the default alone bounds. */
  remainingMs?: () => number | undefined;
  /** The run's commit identity pairs (`gitIdentityEnvs`; record 0062),
   *  resolved on EVERY exec and sent in the `/exec` body's `env` under a
   *  caller's own variables — the Worker reads the map through its one
   *  validated reader and injects its own variables over it. The resident
   *  holds its GitHub credential itself, so this carries the pairs only,
   *  never a token. Absent (a test, the CLI), the body carries only what a
   *  caller gave. */
  resolveEnvs?: () => Promise<Record<string, string>>;
  /** Awaited, typed observations for the two resident waits it alone witnesses. */
  onLiveStateObservation?: ResidentLiveStateObserver;
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
  /** How long `attach` waited for the resident to wake before this binding
   *  answered (execution.md item 9: a refusal the Worker typed transient enters
   *  the wake wait). Set by the client, never by the resident; absent when the
   *  first answer bound. The card names it. */
  wokeAfterMs?: number;
  /** How much of `wokeAfterMs` was spent waiting out a fleet drain (item 69;
   *  issue 2044) — the run was admitted onto a drained fleet and waited for
   *  the deploy to finish. Set by the client beside `wokeAfterMs`; absent when
   *  no drain was met. The dispatch publishes it as the run's `drain_wait`
   *  note, so `runs friction` names the drain as the wait's category. */
  drainWaitMs?: number;
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
   *  branch (item 16's second movement): the branch it was on — one a rebind
   *  had moved it onto, or one this thread itself pushed — is gone from the
   *  mirror, deleted after its pull request merged, so the run starts clean on
   *  the default instead of failing on a dead ref. From which branch, to
   *  which, and for which PR when the resident names one. Absent on every
   *  other attach. */
  returned?: { from: string; to: string; pr?: number };
}

/** The attach answer's `rebound` (item 16) when well-formed; anything else
 *  reads as no move, so a resident answering an unexpected shape binds as
 *  before. Strings were sanitized at the parse. */
function reboundOf(value: unknown): ResidentBinding["rebound"] {
  const move = returnedOf(value);
  return move !== undefined && move.pr !== undefined ? { from: move.from, to: move.to, pr: move.pr } : undefined;
}

/** The attach answer's `returned` (item 16's second movement) when
 *  well-formed: the two branches always, the pull request when the resident
 *  named one — the card then says which PR's branch is gone, and says only
 *  that the branch is gone when it did not, never inventing a number. */
function returnedOf(value: unknown): ResidentBinding["returned"] {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.from !== "string" || typeof v.to !== "string" || !v.from || !v.to) return undefined;
  if (v.pr === undefined) return { from: v.from, to: v.to };
  if (typeof v.pr !== "number" || !Number.isSafeInteger(v.pr) || v.pr <= 0) return undefined;
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
  /** How long the wake wait ran before this refusal, when the attach met one
   *  (a transient refusal cleared, then the resident asked for a ref): the
   *  factory's retry by default draws on one budget across both attaches and
   *  the card names the total. */
  wokeAfterMs?: number;
  /** The resident's default branch when the Worker names one in the 409 body:
   *  the factory binds the thread to it (loudly) instead of asking. Undefined
   *  from a Worker predating that field → the dispatcher asks as before. */
  constructor(
    readonly resource: string,
    readonly defaultRef?: string,
  ) {
    super(`Which branch should the ${resource} resident use for this thread (for example, "main")?`);
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
          // (test/build) legitimately runs minutes — a long suite outlives the
          // per-command default — so the bound is the exec ceiling. A timeout
          // throws here and becomes the same legible error as any other
          // transport failure below.
          signal: AbortSignal.timeout(BASH_TIMEOUT_MAX_MS),
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
    if (err) {
      // A rejected op the Worker typed as the platform's transient (the Durable
      // Object reset or lost under it): one signal, the field, so the reader
      // can tell the resident unavailable for a moment from a failure in the
      // op and word it itself; the message stays the resident's words.
      return {
        kind: "error",
        message: `resident /op: ${err}`,
        // The one rule every reader of the field applies (`isTransientRefusal`):
        // a 5xx carrying it — the streamed document's own status, read by the
        // one rule (`answeredStatus`) as /exec's is; the flag on a named refusal
        // is never one. The second clause is deploy-skew code with a removal
        // trigger: a document with NO status at all is a resident Worker from
        // before `streamOp` carried it, whose typed 500 arrived with its status
        // shed, and the field alone is read there. Drop the clause once the
        // Worker release carrying `streamOp`'s status (the first after 1.245.0)
        // is live on every resident; from then a status-less document is a
        // named refusal on a 200, whose flag is never the signal.
        ...(isTransientRefusal({ status: answeredStatus(res.status, data), data }) ||
        (data.status === undefined && data.transient === true)
          ? { transient: true }
          : {}),
      };
    }
    // A non-2xx with no Worker document — the edge's own page over a real HTTP
    // 5xx — is the platform's blip by the same provenance rule (`isTransientRefusal`
    // over the HTTP status), so the reader words it as the resident unavailable
    // for a moment; a 4xx there is the plain failure it is.
    if (!res.ok) {
      return {
        kind: "error",
        message: `resident /op HTTP ${res.status}`,
        ...(isTransientRefusal({ status: res.status, data }) ? { transient: true } : {}),
      };
    }
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
 *  or timed out); of those, only a failure that is NOT `timedOut` may the
 *  factory's negative cache store (resident-repos.md item 25). */
export type ResidentStatusProbe =
  | { kind: "status"; state: string; reason: string; seed?: ResidentSeedHandle }
  | {
      kind: "unreachable";
      error: string;
      /** The request itself failed (nothing answered). `false` when something answered with a non-2xx, carried as `status`. */
      transport: boolean;
      /** Set with `transport` when what failed was the probe's own deadline:
       *  the host was reached and answered nothing in time. Slow is not gone —
       *  this dispatch falls cold, and the breaker stays closed for the rest. */
      timedOut?: true;
      status?: number;
      /** The non-2xx was the platform's transient, by its provenance: the Worker
       *  typed its own answer so (`catchAllErr` at the fetch handler: the Durable
       *  Object reset or lost under the probe), or a 5xx carried no Worker
       *  document at all — the edge's own error page, where the Worker never
       *  ran to type it. A re-probe clears either. */
      transient?: boolean;
      /** Set with `transient` when the 5xx carried no Worker document — the
       *  edge's own page. The selection's wait tells the two apart at its end
       *  (resident-repos.md item 25): a whole wait on the edge's page is the
       *  platform not answering and arms the outage window; a whole wait on
       *  the Worker's typed blip is the Durable Object's and does not. */
      edge?: true;
    };

/** The seed handle a resident's `/status` publishes (docs/reference/specs/execution.md
 *  item 25): the snapshot's checkout archive, the deps entry archive for its
 *  lockfile key when one has been taken, and the stamp they were taken at.
 *  Carried on the probe only when the body's `snapshot` has the shape. */
export interface ResidentSeedHandle {
  checkoutBackupId: string;
  depsBackupId?: string;
  ref: string;
  sha: string;
}

function seedHandleOf(snapshot: unknown): ResidentSeedHandle | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const s = snapshot as Record<string, unknown>;
  if (typeof s.checkoutBackupId !== "string" || typeof s.ref !== "string" || typeof s.sha !== "string")
    return undefined;
  return {
    checkoutBackupId: s.checkoutBackupId,
    ...(typeof s.depsBackupId === "string" ? { depsBackupId: s.depsBackupId } : {}),
    ref: s.ref,
    sha: s.sha,
  };
}

/** Answer of the one held POST /await-restore (docs/reference/specs/execution.md
 *  item 27): the state the resident landed on when its restore ended,
 *  `unsupported` for a Worker that predates the route (its 404), or the named
 *  failure. Never throws — every outcome is a value the factory turns into a
 *  card note. */
export type ResidentRestoreWait =
  | { kind: "status"; state: string; reason: string }
  | { kind: "unsupported" }
  | { kind: "unreachable"; error: string }
  /** The caller's own stop ended the hold (its signal rode in): the run is
   *  ending, and the caller answers the stop, never a cold fallback or a
   *  re-attach refusal on the view the stop produced. */
  | { kind: "stopped" };

/** The routes whose call is re-issued once when the resident answers
 *  `control-reset` (its Durable Object reset under the call; the container and
 *  the outcome unknown) — only a route whose second landing is harmless:
 *  `/read` is idempotent by shape, and `/write` is a full-content put (the path
 *  and the whole content, never an offset, an append, a mode change or a hook),
 *  so the same bytes landing twice are the file once. `/exec` is never here (it
 *  is the typed `ExecControlResetError` at once), and any route that ever
 *  writes by delta must leave this set — a control reset on it is then the
 *  unknown outcome, never a blind re-run. */
const CONTROL_RESET_REISSUE_ROUTES = new Set(["/read", "/write"]);

export class ResidentExecutor implements Executor {
  /** Consecutive `runtime-replaced` answers on the idempotent routes (/read,
   *  /write) with no successful op between them. One is a deploy that swapped
   *  the resident isolate under a call (routine: re-attach and re-issue); two
   *  in a row is a flapping resident and becomes infra. /exec never counts
   *  here: its `runtime-replaced` is the typed restart (`opWithReattach`). */
  private runtimeReplacedStreak = 0;

  private lastBinding?: ResidentBinding;
  private attachAttempt = 0;

  /** The thread's binding as the resident answered it on the most recent
   *  successful attach — including a mid-run re-attach after an eviction, which
   *  may land on a newer sha than the one the run started on. Undefined until
   *  the first attach succeeds; set only by attach(). */
  get binding(): ResidentBinding | undefined {
    return this.lastBinding;
  }

  /** Whether the next `/attach` carries `opts.sha` (item 51). The sha names the
   *  commit the run asked for and belongs to the attach that BINDS the run and
   *  to a `moveTo`; once an attach has succeeded, a recovery re-attach (a
   *  worktree evicted, a runtime replaced) re-attaches the branch as the run
   *  left it — its own pushes may have moved the tip past the sha it started
   *  on, and the resident would refuse that as `stale-tip`. */
  private shaPending: boolean;

  constructor(private opts: ResidentExecutorOptions) {
    this.shaPending = opts.sha !== undefined;
  }

  /** Attach-on-open: bind (or reuse) the thread's worktree before the first
   *  tool call, so needs-ref / not-onboarded surface at selection time as
   *  legible errors instead of mid-run tool failures. */
  static async open(opts: ResidentExecutorOptions): Promise<ResidentExecutor> {
    const ex = new ResidentExecutor(opts);
    await ex.attach();
    return ex;
  }

  /** One operator-scope GET /status, bounded by timeoutMs. Never throws. A
   *  deadline miss is flagged `timedOut` beside `transport`, so the factory
   *  falls cold for the one dispatch without arming its breaker. */
  static async probeStatus(
    baseUrl: string,
    token: string,
    resource: string,
    timeoutMs: number,
    span?: Span,
    /** The run's stop, where the caller has one (the wake wait's probes): it
     *  drops the request at once, as it does every other send. */
    signal?: AbortSignal,
  ): Promise<ResidentStatusProbe> {
    const url = `${baseUrl.replace(/\/$/, "")}/status?resource=${encodeURIComponent(resource)}`;
    let res: Response;
    try {
      res = await tracedFetch(
        span,
        url,
        { headers: { authorization: `Bearer ${token}` }, signal: execDeadline(timeoutMs, signal) },
        { route: "/status" },
      );
    } catch (err) {
      // Network failure or the probe's own deadline — not warm either way. The
      // deadline is named apart (`execDeadline` aborts with a TimeoutError): the
      // host answered slowly, and only a failure to reach it is negative-cacheable.
      return {
        kind: "unreachable",
        error: err instanceof Error ? err.message : String(err),
        transport: true,
        ...(isDeadlineMiss(err) ? { timedOut: true } : {}),
      };
    }
    if (res.status === 404) {
      // a definite answer (resource not onboarded), never a service failure
      return { kind: "status", state: "not-onboarded", reason: "" };
    }
    // Item 62: the probe has its own body read, so it sanitizes on its own,
    // and `state` is validated against the closed table (never echoed).
    const data = sanitizeResidentBody((await res.json().catch(() => ({}))) as Record<string, unknown>);
    if (!res.ok) {
      // Typed by provenance (execution.md item 9). The Worker's document — a
      // string `error`, which every route's catch puts on its answer — is the
      // Worker's answer: definite unless it typed the throw `transient`. A 5xx
      // with no Worker document (a non-JSON body, the edge's own error page:
      // the platform between us and the Worker, which never ran) is unanswered,
      // the same blip a re-probe clears. A 4xx is an answer either way.
      const answered = typeof data.error === "string";
      const edge = res.status >= 500 && !answered;
      const transient = edge || (res.status >= 500 && data.transient === true);
      return {
        kind: "unreachable",
        error: `probe HTTP ${res.status}: ${answered ? data.error : "no Worker document in the answer"}`,
        transport: false,
        status: res.status,
        ...(transient ? { transient: true } : {}),
        ...(edge ? { edge: true } : {}),
      };
    }
    const seed = seedHandleOf(data.snapshot);
    return {
      kind: "status",
      state: residentState(data.state),
      reason: String(data.reason ?? ""),
      ...(seed ? { seed } : {}),
    };
  }

  /** The one held request while the resident restores (item 27): POST
   *  /await-restore, which the resident's Durable Object holds until its state
   *  leaves `restoring` and the transition publishes — event-driven, no
   *  polling, no retry timer on either side. The answer streams heartbeat
   *  whitespace then one JSON document; `timeoutMs` bounds the whole wait so a
   *  restore that never ends becomes a named cold fallback. A 404 is an older
   *  Worker without the route. The caller's stop signal rides in — a run
   *  stopped during the hold is answered `stopped` at once, decided by the
   *  signal before the error's name, and holds nothing further. Never throws. */
  static async awaitRestore(
    baseUrl: string,
    token: string,
    resource: string,
    timeoutMs: number,
    span?: Span,
    signal?: AbortSignal,
  ): Promise<ResidentRestoreWait> {
    try {
      const res = await tracedFetch(
        span,
        `${baseUrl.replace(/\/$/, "")}/await-restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ resource }),
          signal: execDeadline(timeoutMs, signal),
        },
        { route: "/await-restore" },
      );
      if (res.status === 404) return { kind: "unsupported" };
      const data = await parseResidentBody(res);
      const status = answeredStatus(res.status, data);
      if (status !== 200 || typeof data.error === "string") {
        return { kind: "unreachable", error: `await-restore HTTP ${status}: ${String(data.error ?? "")}` };
      }
      return { kind: "status", state: residentState(data.state), reason: String(data.reason ?? "") };
    } catch (err) {
      if (signal?.aborted) return { kind: "stopped" };
      return { kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
    }
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
      // Network-level failure, a deadline abort mid-body, or the run's own
      // stop: the command may still be running (or have run) in the resident —
      // never blind-retry a possibly side-effectful call. Infra (not a command
      // exit): the runner counts these toward fail-fast. One decision for the
      // reason; the tracker's kind derives from it.
      const reason = infraReasonOfRequestFailure(err, signal);
      throw classifyError(new ExecInfraError(requestFailedMessage("resident", route, err), reason), {
        kind: reason === "deadline-passed" ? "timeout" : "transport",
      });
    }
  }

  /** Bind/reuse this thread's worktree. Legible errors for every named
   *  refusal the service can answer with. Answers the binding the resident
   *  reported: the bound ref — a named `refHint` must be that ref, while the
   *  sticky binding may answer a different ref only when the caller named none
   *  (`refByDefault` or an `ownPr`-derived hint). The Worker also persists a named ref as the new sticky
   *  binding (item 16). `rebound` / `rebindRefused` report the legacy own-PR
   *  movement, and the sha says which commit the worktree is at. A
   *  200 without both fields is a malformed resident (the attach contract
   *  always carries them) and is an error, never a half-bound executor. A
   *  refusal the Worker typed as the platform's transient (`isTransientRefusal`:
   *  the Durable Object reset or lost under the attach) is waited through
   *  here, for the run's first attach and every re-attach alike: the wake wait
   *  (item 65) probes `/status`, re-attaches as soon as the engine says it
   *  serves, and is bounded by `opts.budgetMs` under the wake ceiling; past the
   *  budget it throws the wake's strike (`worker-unavailable`), so a caller
   *  with a longer clock may still wait and the factory falls back cold naming
   *  the wait. A deterministic refusal is judged at once, with no probe.
   *  ONE bound for every attach request this call opens — the first request
   *  and each re-attach inside the wake wait alike, whoever opened the call:
   *  the attach's own default (`attachOnce`'s, the exec default
   *  `BASH_TIMEOUT_MS`), since an attach may clone and install deps and a
   *  request cut short strikes a resident still attaching; clipped to the
   *  run's remaining wall clock where this executor carries the run's
   *  (`attachBoundMs`), so no attach holds a run past its lease. `opts.budgetMs`
   *  bounds the wait's PROBING alone (item 65's ceiling too), never a request:
   *  an operation's wall clock is the command's, and a recovery attach is not
   *  the command. */
  async attach(
    span?: Span,
    opts: {
      signal?: AbortSignal;
      budgetMs?: number;
      drainBoundMs?: number;
      /** `offer` exposes one persisted drain-seed admission to the factory;
       *  `wait` is used after that admitted seed could not be restored. */
      drainSeedMode?: "offer" | "wait";
    } = {},
  ): Promise<ResidentBinding> {
    this.attachAttempt++;
    const answer = await this.attachOnce(span, this.attachBoundMs("/attach"), opts.signal);
    if (answer.ok) return answer.binding;
    if (isDrainingRefusal(answer)) {
      if (answer.data.seedAdmitted === true && opts.drainSeedMode !== "wait")
        throw new ResidentDrainingError(this.opts.resource, 0, drainingUntil(answer), refusalWords(answer), true);
      const reopened = await this.awaitDrainEnd(answer, opts, span);
      return { ...reopened.binding, wokeAfterMs: reopened.waitedMs, drainWaitMs: reopened.waitedMs };
    }
    if (isTransientRefusal(answer)) {
      const woke = await this.awaitWake("/attach", refusalWords(answer), {
        origin: "transient-refusal",
        signal: opts.signal,
        budgetMs: opts.budgetMs,
        drainBoundMs: opts.drainBoundMs,
        span,
      });
      // The spread keeps a `drainWaitMs` the wake path stamped when its
      // re-attach met the drain (item 69): the transient-then-draining
      // sequence carries the drain's share exactly as a first draining
      // answer does.
      return { ...woke.binding, wokeAfterMs: woke.waitedMs };
    }
    throw this.attachRefusal(answer);
  }

  /** The wait for a drained fleet to reopen (item 69): one re-attach every
   *  `DRAIN_POLL_MS` until the fleet admits the run, under the run's own lease
   *  less what the attach and the work need (`DRAIN_LEASE_RESERVE_MS`), or the
   *  ceiling with no lease — and under `drainBoundMs` where the caller has a
   *  fallback whose cost bounds the wait (issue 2101: the factory's first
   *  attach falls to a seeded sandbox in minutes, so it never waits out the
   *  deploy). The run's stop ends it at once (the pause and the re-attach both
   *  carry its signal). An answer that is no longer the drain is judged as
   *  `attach` judges a first answer: admitted, the platform's transient (handed
   *  to the wake wait with what the budget left), or the attach's own refusal.
   *  The budget ending with the fleet still drained is the typed
   *  `ResidentDrainingError`, naming how long the run could wait and when the
   *  drain says it ends. Every error thrown out of the wait carries the
   *  drain's share (`stampDrainWait`), so the fallback still publishes the
   *  run's `drain_wait` note. The wait is one child span under the attach span
   *  (`dispatch.workspace.attach.drain-wait`, issue 2101): an 18-minute hold
   *  with zero events between the attach's start and its end was the incident's
   *  shape; the span carries the typed error's classification — the refusal's
   *  words stay on the card note and the attach error (tracing.md item 2 keeps
   *  remote free text off spans). */
  private async awaitDrainEnd(
    first: { status: number; data: Record<string, unknown> },
    opts: {
      signal?: AbortSignal;
      budgetMs?: number;
      drainBoundMs?: number;
      /** The effective deadline an earlier drain wait opened. A wake hand-off
       *  carries it back here so no later drain can renew any allowance. */
      drainDeadlineMs?: number;
    },
    span?: Span,
  ): Promise<{ binding: ResidentBinding; waitedMs: number }> {
    const t0 = systemClock();
    const left = this.opts.remainingMs?.();
    const deadline = Math.min(
      opts.drainDeadlineMs ?? Number.POSITIVE_INFINITY,
      t0 + DRAIN_WAIT_MAX_MS,
      t0 + (opts.drainBoundMs ?? DRAIN_WAIT_MAX_MS),
      t0 + (left === undefined ? DRAIN_WAIT_MAX_MS : Math.max(0, left - DRAIN_LEASE_RESERVE_MS)),
    );
    let answer = first;
    await this.opts.onLiveStateObservation?.({
      state: "waiting_deploy",
      bound: deadline,
      reason: "deploy",
      attempt: this.attachAttempt,
    });
    const waitSpan = span?.start("dispatch.workspace.attach.drain-wait");
    try {
      for (;;) {
        const now = systemClock();
        if (now >= deadline)
          throw new ResidentDrainingError(this.opts.resource, now - t0, drainingUntil(answer), refusalWords(answer));
        await wakePause(Math.min(DRAIN_POLL_MS, deadline - now), opts.signal, "/attach");
        const next = await this.attachOnce(waitSpan ?? span, this.attachBoundMs("/attach"), opts.signal);
        if (next.ok) {
          waitSpan?.end("ok");
          return { binding: next.binding, waitedMs: systemClock() - t0 };
        }
        answer = next;
        if (isDrainingRefusal(answer)) continue;
        if (isTransientRefusal(answer)) {
          // The drain's own share ends here; the wake wait that follows is its
          // own span and its own budget's, and a failure inside it still
          // carries the drain's share for the fallback's note.
          const drainShareMs = systemClock() - t0;
          waitSpan?.end("ok");
          try {
            const woke = await this.awaitWake("/attach", refusalWords(answer), {
              origin: "transient-refusal",
              signal: opts.signal,
              budgetMs: Math.max(0, deadline - systemClock()),
              drainBoundMs: opts.drainBoundMs,
              drainDeadlineMs: deadline,
              span,
            });
            return { binding: woke.binding, waitedMs: systemClock() - t0 };
          } catch (err) {
            throw stampDrainWait(err, drainShareMs + (drainWaitOf(err) ?? 0));
          }
        }
        throw this.attachRefusal(answer);
      }
    } catch (err) {
      // The wake hand-off stamped the drain's own share already; everything
      // else — the typed draining error, the attach's refusal after the drain
      // ended, the run's stop — spent the whole wait on the drain.
      if (drainWaitOf(err) === undefined) stampDrainWait(err, systemClock() - t0);
      if (waitSpan !== undefined && !waitSpan.ended) {
        waitSpan.fail(err);
        waitSpan.end();
      }
      throw err;
    } finally {
      // The server assigns the next lifecycle boundary; the resident never clears a state itself.
    }
  }

  /** One `/attach`, answered rather than thrown: the binding on a 200, else
   *  the refusal's status and body, so the wake wait (item 65) can read the
   *  refusal's own words and keep waiting through a container still rolling.
   *  `timeoutMs` bounds the call; the default is the exec default
   *  (`BASH_TIMEOUT_MS`, `call`'s own), since an attach may wait on a restore
   *  or a deps install; `attach` clips it to the run's clock. `signal` is the run's
   *  stop where the caller has one (the wake wait's re-attach): it drops the
   *  request at once, and the failure is `aborted`, never the transport lost. */
  private async attachOnce(span?: Span, timeoutMs?: number, signal?: AbortSignal): Promise<AttachAnswer> {
    const body: Record<string, unknown> = {};
    if (this.opts.admissionKey) body.admissionKey = this.opts.admissionKey;
    if (this.opts.refHint) body.refHint = this.opts.refHint;
    if (this.opts.readonly) body.readonly = true;
    if (this.opts.sha && this.shaPending) body.sha = this.opts.sha;
    if (this.opts.reuse) body.reuse = true;
    if (this.opts.ownPr) body.ownPr = this.opts.ownPr;
    if (this.opts.refByDefault) body.refByDefault = true;
    const answered = await this.call("/attach", body, timeoutMs, signal, span);
    const data = answered.data;
    // Post-validation answers stream like /exec (heartbeat whitespace then one
    // JSON document over HTTP 200, item 59) so an attach that waits on a deps
    // install cannot lose the connection; a streamed refusal carries its
    // status IN the body. Pre-validation refusals (400/404) keep real statuses.
    const status = answeredStatus(answered.status, data);
    if (status !== 200) return { ok: false, status, data };
    if (typeof data.ref !== "string" || typeof data.sha !== "string") {
      throw new Error(`resident attach: malformed answer for ${this.opts.resource} (missing ref/sha)`);
    }
    const returned = returnedOf(data.returned);
    // A named ref is the spawn's branch, not a hint an older sticky binding may
    // override. Fail closed against a Worker predating that invariant rather
    // than let the child work and push from another attempt's branch. The two
    // typed fallback cases are not named-ref authority: ownPr may leave a
    // default-bound thread where it stood, and refByDefault names the resident's
    // fallback rather than a branch the requester chose.
    if (
      this.opts.refHint !== undefined &&
      !this.opts.refByDefault &&
      this.opts.ownPr === undefined &&
      data.ref !== this.opts.refHint
    ) {
      throw new Error(
        `resident attach: named ref mismatch for ${this.opts.resource} (asked for ${JSON.stringify(this.opts.refHint)}, got ${JSON.stringify(data.ref)})`,
      );
    }
    const trace = sanitizeGraftedSteps(data.trace);
    const rebound = reboundOf(data.rebound);
    const rebindRefused = rebindRefusedOf(data.rebindRefused);
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
    this.shaPending = false; // bound at the commit asked for; recovery re-attaches name none
    return { ok: true, binding: this.lastBinding };
  }

  /** The bound on one attach request this executor opens (`attachOnce`), by
   *  whether it carries the run's clock (execution.md item 9): the attach's own
   *  default clipped to the run's remaining wall clock (`attachBoundWithinRun`),
   *  or the default alone — `attachOnce`'s — with no run clock, or before the
   *  lease has started. Inside the write-up reserve, or with less past it than
   *  an attach needs (`ATTACH_REQUEST_MIN_MS`), no request is opened: the typed
   *  `refused` (`ResidentLeaseSpentError`), which no wait clears, naming the
   *  run's clock and the bound that refused — the resident would run the
   *  attach to its end for a run that is ending, and a request cut short would
   *  be struck as a rollout. */
  private attachBoundMs(route: string): number | undefined {
    const left = this.opts.remainingMs?.();
    if (left === undefined) return undefined;
    const bound = attachBoundWithinRun(left);
    if (bound.kind === "bounded") return bound.timeoutMs;
    throw new ResidentLeaseSpentError(route, bound.note, left);
  }

  /** The legible error for a refused attach, by the refusal the service
   *  named: needs-ref typed for the ask-once flow, not onboarded, anything
   *  else with its own words. The steps the resident ran before refusing ride
   *  the error (docs/reference/specs/tracing.md item 19): the dispatcher grafts
   *  them under its attach span. */
  private attachRefusal(answer: { status: number; data: Record<string, unknown> }): Error {
    const { status, data } = answer;
    const err = refusalWords(answer);
    const failedTrace = sanitizeGraftedSteps(data.trace);
    const traced = (e: Error): Error => (failedTrace.length > 0 ? withResidentTrace(e, { steps: failedTrace }) : e);
    if (status === 409 && data.needs === "ref") {
      const defaultRef = typeof data.defaultRef === "string" && data.defaultRef ? data.defaultRef : undefined;
      return traced(new ResidentNeedsRefError(this.opts.resource, defaultRef));
    }
    if (status === 409 && data.needs === "recreate")
      return traced(new ResidentReuseRefusedError(this.opts.resource, err));
    if (status === 404)
      // A registry fact, not the person's wording (record 0054): `system`.
      return traced(
        new RefusalError(
          refusalOf("resident_attach_failed", `resident attach: ${this.opts.resource} is not onboarded (${err})`),
        ),
      );
    // A deterministic refusal — `attach-failed at <step>`, a throw in the route,
    // a 4xx — is the attach's own legible error, judged at once. A refusal the
    // platform's transient (`isTransientRefusal`) never reaches here: every
    // caller waits on it first (`attach`, the wake wait's re-attach), and a
    // wait spent is the wake's strike.
    // The Worker's `error` prefix names the cause (record 0054): a wrong or
    // missing ref is the person's to fix; everything else is the machinery's.
    const cause = residentErrorCause(err);
    return traced(
      new RefusalError(
        refusalOf(
          cause === "request" ? "resident_attach_rejected" : "resident_attach_failed",
          `resident attach failed for ${this.opts.resource}: ${err}`,
        ),
      ),
    );
  }

  /** Move the thread's worktree to `sha` (agent-review.md item 12): one more
   *  `/attach` carrying the new expected head, so the resident fetches its
   *  mirror (item 51) and recreates the tree at the ref's tip — the same
   *  mechanism a re-review after a push uses, applied mid-run. The move's own
   *  attach carries the new sha; a later recovery re-attach names none (item
   *  51: the run's own pushes may move the tip). Answers the sha the worktree
   *  is at; throws like attach() on a refusal. The run's stop (`opts.signal`)
   *  rides into the attach and the wake wait a transient refusal begins, so a
   *  stopped round never sits out the wake ceiling. */
  async moveTo(sha: string, opts?: MoveOptions): Promise<{ sha: string }> {
    this.opts = { ...this.opts, sha };
    this.shaPending = true;
    const binding = await this.attach(opts?.span, { signal: opts?.signal });
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
          `this is a bug: resident ${route} still had no worktree after its automatic re-attach (${String(data.error ?? "")}); no further restore wait was scheduled`,
          "refused",
        ),
        { kind: "infra", code: "attach" },
      );
    // The container under the thread is gone: on /exec the typed restart, now.
    const goneUnderThread = (data: Record<string, unknown>): void => {
      if (route === "/exec" && saysContainerGone(data))
        throw new ExecSandboxRestartedError(containerGoneMessage(String(data.error)), 0);
    };
    // The resident's own DO reset under the command while the container kept
    // running (a Worker deploy, item 43): on /exec the typed control reset at
    // once — the container is unchanged and the command's outcome is unknown, so
    // the harness seam re-sends an idempotent op or resolves a write by pi's
    // echo (harness-pi item 16), never the replaced verdict. NOT a
    // replacement, so `swapIncarnation`/relaunch never fire off it. The
    // idempotent routes below re-attach once and re-issue, a re-read being safe.
    // The one rule for a control reset's re-issue: a route outside
    // `CONTROL_RESET_REISSUE_ROUTES` — `/exec`, whose command may have started
    // and must never run again blindly — is the typed unknown outcome at once;
    // a route inside it re-attaches once and re-issues below. Stated here alone,
    // so a route added to the call sites is judged by the set, not by the order
    // of the checks that follow.
    const controlResetUnderThread = (data: Record<string, unknown>): void => {
      if (!CONTROL_RESET_REISSUE_ROUTES.has(route) && saysControlReset(data))
        throw new ExecControlResetError(String(data.error).trim());
    };
    // One wake budget per operation, bounding the PROBING (never an attach
    // request, which runs under the attach's own timeout): the wait for a
    // rolling container and any recovery attach's wait for a transient refusal
    // draw on the same clock, so an op never probes twice the budget. The
    // clock starts at the first wait, never at the call that met the refusal:
    // that call's latency is the command's, not the wake's. Once running it
    // counts everything after — a call re-issued after the wake included — so
    // a later wait gets what is left of the op's wall clock, not a fresh budget.
    let waitStarted: number | undefined;
    const waitBudget = wakeWaitBudget(opts.waitBudgetMs);
    const waitLeft = (): number => {
      waitStarted ??= systemClock();
      return Math.max(0, waitBudget - (systemClock() - waitStarted));
    };
    // A refused connect (resident-repos.md item 68) is waited out around every
    // send this operation makes, inside the command's own budget.
    const busyBudgetMs = Math.min(opts.waitBudgetMs ?? BASH_TIMEOUT_MS, RUNTIME_BUSY_WAIT_MAX_MS);
    const send = () => this.callWaitingOutBusy(route, body, callTimeoutMs, busyBudgetMs, signal, span);
    // Every attach an operation opens from here — the rolling wake's re-attach,
    // which recreates the worktree from the mirror, and the three recovery
    // attaches — runs under the attach's own default clipped to the run's
    // remaining clock where this executor carries it (`attachBoundMs`): the
    // op's call bound is the command's, and the wake budget bounds the
    // probing alone.
    let r = await send();
    if (isContainerRolling(r.data.error)) {
      const woke = await this.awaitWake(route, String(r.data.error), {
        origin: "container-exited",
        signal,
        budgetMs: waitLeft(),
        span,
      });
      if (route === "/exec")
        throw new ExecSandboxRestartedError(
          sandboxRestartedMessage({ waitedMs: woke.waitedMs, ref: woke.binding.ref, sha: woke.binding.sha }),
          woke.waitedMs,
        );
      r = await send();
      if (isContainerRolling(r.data.error)) {
        throw classifyError(
          new ExecInfraError(
            `resident ${route}: ${String(r.data.error)}; the container vanished again right after it woke`,
            "refused",
          ),
          { kind: "infra", code: "container-exited" },
        );
      }
    }
    goneUnderThread(r.data);
    controlResetUnderThread(r.data);
    if (r.data.needs === "attach") {
      await this.attach(span, { signal, budgetMs: waitLeft() }); // the recovery rides the same trace as the op it rescues
      r = await send();
      goneUnderThread(r.data);
      controlResetUnderThread(r.data);
      if (r.data.needs === "attach") throw stillGone(r.data);
    }
    if (saysControlReset(r.data)) {
      // A route the set names (`controlResetUnderThread` threw for any other):
      // the DO is fresh after its reset, so re-attach once and re-issue — a
      // second landing is harmless here (`/read`, idempotent by shape; `/write`,
      // a full-content put). Still reset after the re-issue → the unknown outcome.
      await this.attach(span, { signal, budgetMs: waitLeft() }); // the recovery rides the same trace as the op it rescues
      r = await send();
      if (saysControlReset(r.data)) throw new ExecControlResetError(String(r.data.error).trim());
      // Compound fault: the reset also left the worktree evicted. The re-attach
      // above was this op's one re-attach, so name it precisely, as the
      // runtime-replaced path below does, instead of falling through to the
      // generic status error.
      if (r.data.needs === "attach") throw stillGone(r.data);
    }
    if (r.data.reason === "runtime-replaced") {
      // An idempotent route (/exec threw above): re-attach once and re-issue.
      this.noteRuntimeReplaced(route, r.data);
      await this.attach(span, { signal, budgetMs: waitLeft() }); // the recovery rides the same trace as the op it rescues
      r = await send();
      if (r.data.reason === "runtime-replaced") this.noteRuntimeReplaced(route, r.data);
      // Compound fault: the deploy also left the worktree evicted. The
      // re-attach above was this op's one re-attach, so name it precisely
      // instead of falling through to the generic status error.
      if (r.data.needs === "attach") throw stillGone(r.data);
    }
    if (typeof r.data.error !== "string" || !r.data.error) this.runtimeReplacedStreak = 0;
    return r;
  }

  /** One send, re-sent while the resident answers `runtime-busy`
   *  (docs/reference/specs/resident-repos.md item 68; the thread sandbox's
   *  execution.md item 28): the container is running but did not accept the
   *  SDK's connect because a command already running in it has its cores, so
   *  nothing ran and the IDENTICAL request is safe to re-send — after 3 s,
   *  5 s, then 10 s, until the total wait reaches `budgetMs` (the command's
   *  own, under the five-minute cap). Then `ExecCapacityError`, never
   *  `ExecInfraError`: a container that refused a connect is not a dead one. A hard stop ends
   *  the pause at once with the stop's typed error. Every other answer is
   *  returned as it came for the caller's own rules. */
  private async callWaitingOutBusy(
    route: string,
    body: Record<string, unknown>,
    callTimeoutMs: number,
    budgetMs: number,
    signal?: AbortSignal,
    span?: Span,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    let waited = 0;
    let attempt = 0;
    for (;;) {
      const r = await this.call(route, body, callTimeoutMs, signal, span);
      if (r.data.reason !== RUNTIME_BUSY_REASON) return r;
      if (waited >= budgetMs) throw new ExecCapacityError(runtimeBusyExhaustedMessage(waited));
      const step = RUNTIME_BUSY_BACKOFF_MS[Math.min(attempt, RUNTIME_BUSY_BACKOFF_MS.length - 1)];
      const delay = Math.min(step, budgetMs - waited);
      attempt++;
      await pauseUnlessStopped(route, delay, signal);
      waited += delay;
    }
  }

  private noteRuntimeReplaced(route: string, data: Record<string, unknown>): void {
    this.runtimeReplacedStreak++;
    if (this.runtimeReplacedStreak >= 2) {
      throw classifyError(
        new ExecInfraError(
          `resident ${route}: runtime replaced ${this.runtimeReplacedStreak} times in a row with no successful operation ` +
            `between (${String(data.error ?? "")}) — a deploy storm or a flapping resident, not a one-off deploy.`,
          "refused",
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
   *  the wait going, and a `draining` answer hands the wait to the drain
   *  wait, item 69: the drain record survives the Durable Object reset the
   *  deploy's own isolate swap lands during its drain, so the run waits out
   *  the drain under its lease, never this budget). Answers the wait and the
   *  fresh binding. Throws the
   *  strike (an `ExecInfraError` the tracker counts) when nothing is
   *  recovering, when the resident goes down mid-wait, when a re-attach does
   *  not answer, or when the budget is spent; a hard stop rejects at once with
   *  the stop's one typed shape (`wakeStopped`: `aborted`, the transport) from
   *  every stop point — the pause, the probe, the re-attach's own call; any
   *  other attach refusal is the attach's own legible error.
   *
   *  A wait a TRANSIENT refusal began (`opts.transient`, or a re-attach's
   *  transient 500 met inside it) reads an unreachable Worker differently: the
   *  Durable Object that reset or lost its connection under the attach loses
   *  `/status` too, so an unanswered probe is the same blip, waited through
   *  under the budget — never the definite "nothing says the container is
   *  coming back" a container's exit is judged by — and a wait spent with the
   *  Worker unreachable throughout ends in `worker-unavailable`, never
   *  `refused`. */
  private async awaitWake(
    route: string,
    refusal: string,
    opts: {
      /** What began this wait: its strike's code and sentence, and whether it starts in transient mode. */
      origin: WakeOrigin;
      signal?: AbortSignal;
      budgetMs?: number;
      /** The drain wait's bound where a fallback stands behind the attach
       *  (issue 2101): handed to the drain wait a re-attach's `draining`
       *  answer opens, so the hand-off keeps the fallback's bound too. */
      drainBoundMs?: number;
      /** The effective deadline of a drain wait that handed off to this wake.
       *  A later draining answer keeps this deadline rather than opening a new bound. */
      drainDeadlineMs?: number;
      span?: Span;
    },
  ): Promise<{ waitedMs: number; binding: ResidentBinding }> {
    // The attach's wake wait is one child span under the attach span (issue
    // 2101, as the drain wait is): the incident's run spent the wake budget
    // here with nothing on the timeline. Other routes' waits stay log-only —
    // their parent is the command's span, not the attach's.
    const waitSpan = route === "/attach" ? opts.span?.start("dispatch.workspace.attach.wake-wait") : undefined;
    const failWaitSpan = (err: unknown): void => {
      if (waitSpan !== undefined && !waitSpan.ended) {
        waitSpan.fail(err);
        waitSpan.end();
      }
    };
    // The wait's one clock, before the first probe: the loop reads it for its
    // budget check and hands it to `judge` as `spent()`, so every `waited Ns` —
    // the strikes', the binding's — is the whole wait, never short by one
    // probe, and a message after a re-attach counts the re-attach.
    const t0 = systemClock();
    const wakeBound = t0 + wakeWaitBudget(opts.budgetMs);
    await this.opts.onLiveStateObservation?.({
      state: "waiting_repository",
      bound: wakeBound,
      reason: "repository_container",
      attempt: this.attachAttempt,
    });
    let transient = opts.origin === "transient-refusal";
    /** A definite engine view — no wake recovers from it — or a Worker that did not answer: refused. */
    const definite = (why: string): ExecInfraError => residentWakeStrike(route, refusal, why, "refused", opts.origin);
    /** The engine view's verdict for this wait: after a transient refusal an
     *  unanswered probe (`isUnansweredProbe`, the strike's rule too) is the
     *  same blip and waits; else `wakeDecision`. */
    const decide = (view: ResidentStatusProbe): WakeDecision =>
      transient && isUnansweredProbe(view)
        ? {
            wait: true,
            why: `the resident Worker did not answer /status (${view.error}) after a transient refusal: the same blip, waited through`,
          }
        : wakeDecision(view);
    /** The one probe, for the first view and every re-probe: the wake's own deadline, the run's stop riding in. */
    const probe = (signal: AbortSignal | undefined): Promise<ResidentStatusProbe> =>
      ResidentExecutor.probeStatus(
        this.opts.baseUrl,
        this.opts.token,
        this.opts.resource,
        WAKE_PROBE_TIMEOUT_MS,
        opts.span,
        signal,
      );
    let first: ResidentStatusProbe;
    try {
      first = await probe(opts.signal);
      // The run's stop rides into the probe as into every send: a stop during
      // one is the stop's own typed error, as the pause throws it — never a
      // strike on an "unreachable" view the stop itself produced. (The loop
      // makes this check after each of its own probes.)
      if (opts.signal?.aborted) throw wakeStopped(route);
    } catch (err) {
      // The initial probe precedes `waitOnStatus`, but it is still part of the
      // visible wake wait and must close the same span on a stop or failure.
      failWaitSpan(err);
      throw err;
    }
    // Each turn of the wake path's one loop (`waitOnStatus`), the first view
    // included: judge the view — a definite one is the strike at once, before
    // any pause — then re-attach when it says the resident serves, else (or
    // after a re-attach the wait goes on from) pause and probe again, under
    // the budget. The very first view counts only in a wait a transient
    // refusal began — the engine was never told of an exit, so a serving view
    // is current and a blip the first probe already shows cleared costs no
    // pause and no second probe; after a container's exit the engine view lags
    // the exit, so the first re-attach follows the first pause, never a full
    // /attach into a container still starting.
    let firstView = true;
    const wait = waitOnStatus<{ waitedMs: number; binding: ResidentBinding }>({
      first,
      since: t0,
      probe,
      budgetMs: wakeWaitBudget(opts.budgetMs),
      signal: opts.signal,
      route,
      judge: async (view, spent) => {
        const verdict = decide(view);
        if (!verdict.wait) throw definite(verdict.why);
        if (view.kind === "status" && isServiceable(view.state, view.reason) && (transient || !firstView)) {
          // The one bound every attach request has, whoever opened the call
          // (`attach`): the attach's own default, clipped to the run's remaining
          // clock where this executor carries it — a re-attach may clone and
          // install deps, and clipped to the budget's remainder or the wake
          // ceiling it would strike a resident still attaching and provision
          // the run cold beside it. The budget bounds the probing this loop
          // does, never the request. Inside the write-up reserve the bound
          // refuses before any request opens — the typed `refused`, outside the
          // strike below, which reads a request's own failure.
          const bound = this.attachBoundMs(route);
          let answer: AttachAnswer;
          try {
            answer = await this.attachOnce(opts.span, bound, opts.signal);
          } catch (err) {
            if (!(err instanceof ExecInfraError)) throw err;
            // The run's own stop: its signal rides into the re-attach as into every
            // send, and the failure is the call's own — the stop as its request
            // site classified it — never a strike counted as a container exit.
            if (err.reason === "aborted") throw err;
            // The re-attach's own verdict — a deadline passed, the transport lost —
            // says nothing about the resident: the strike reads the last engine
            // view, as the budget strike does.
            throw residentWakeStrike(
              route,
              refusal,
              `the re-attach after ${Math.round(spent() / 1000)}s did not answer (${err.message})`,
              wakeStrikeReason(view, transient),
              opts.origin,
            );
          }
          if (answer.ok) return { end: { waitedMs: spent(), binding: answer.binding } };
          // A drained fleet answering the re-attach (item 69): the drain record
          // survives the Durable Object reset that began this wait — the
          // deploy's own isolate swap lands inside its own drain — so this is
          // the drain's case, not a wake failure. The wait moves under the
          // drain wait (the run's lease less the reserve), never the wake
          // budget, whose minute would strike exactly the requests the drain
          // exists to hold and fall them back cold; the binding carries the
          // whole wait, and a drain still in force past the drain budget is
          // the typed ResidentDrainingError, as a first draining answer's is.
          // The drain's share rides the binding as `drainWaitMs` (item 69,
          // issue 2044) from this path exactly as from a first draining
          // answer: `attach` folds the wake result into `wokeAfterMs` alone,
          // and a binding without the share would publish no `drain_wait`
          // note — the silence the field exists to end.
          if (isDrainingRefusal(answer)) {
            waitSpan?.end("ok");
            const reopened = await this.awaitDrainEnd(
              answer,
              {
                signal: opts.signal,
                drainBoundMs: opts.drainBoundMs,
                drainDeadlineMs: opts.drainDeadlineMs,
              },
              opts.span,
            );
            return {
              end: { waitedMs: spent(), binding: { ...reopened.binding, drainWaitMs: reopened.waitedMs } },
            };
          }
          // A 500 the Worker typed transient (the Durable Object reset or lost under
          // the re-attach): the resident is coming back as far as anyone can tell,
          // so the wait goes on — the next probe and re-attach follow — instead of
          // ending in the attach's own error; and from here an unreachable probe
          // is that same blip. A refusal still naming a rolling container waits on
          // too; anything else is the attach's own error, a needs-ref carrying the
          // wait so its caller's retry draws on one budget and names the total.
          if (isTransientRefusal(answer)) transient = true;
          else if (!isContainerRolling(answer.data.error)) {
            const refused = this.attachRefusal(answer);
            if (refused instanceof ResidentNeedsRefError) refused.wokeAfterMs = spent();
            throw refused;
          }
        }
        firstView = false;
        return "wait";
      },
      spent: (last, spentMs) => {
        throw residentWakeBudgetStrike(route, refusal, spentMs, last, { origin: opts.origin, transient });
      },
    });
    if (waitSpan === undefined) return wait;
    try {
      const out = await wait;
      waitSpan.end("ok");
      return out;
    } catch (err) {
      failWaitSpan(err);
      throw err;
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
    // there is one, so an older resident sees the body it always did; the
    // Worker reads it through the one validated reader and hands it to the
    // exec's env option. The run's commit identity pairs (record 0062) join it
    // on every exec, resolved fresh and winning a clash — the same order as
    // the sandbox's credential over a caller's variables.
    const identityEnv = this.opts.resolveEnvs ? await this.opts.resolveEnvs() : {};
    const env = { ...(opts?.env ?? {}), ...identityEnv };
    if (Object.keys(env).length > 0) body.env = env;
    const { status, data } = await this.opWithReattach("/exec", body, {
      signal: opts?.signal,
      callTimeoutMs: timeoutMs + EXEC_CALL_MARGIN_MS,
      // The wake wait (item 65) may probe for what the command itself could:
      // the tool layer already clipped this to the run's remaining wall clock.
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
      // fail-fast. Typed by the fields the resident put on the answer
      // (`residentAnswerReason`): /exec streams its failures over HTTP 200 with
      // the answer's own status IN the body (`answeredStatus`, the rule /attach
      // and /await-restore read by too), so a streamed 503 is read as the 503
      // it is — the resident unavailable for a moment unless it names a
      // refusal — and a streamed rejection as the catch-all's 500 it is, typed
      // by its `transient`; the resident's words on any other status — the
      // SDK's text forwarded, a named refusal — mean what they say, and the
      // harness's seam reads the container-down ones.
      const said = answeredStatus(status, data);
      throw classifyError(new ExecInfraError(`resident /exec: ${data.error}`, residentAnswerReason(said, data)), {
        kind: "infra",
      });
    }
    if (status !== 200) {
      throw classifyError(new ExecInfraError(`resident /exec HTTP ${status}`, residentAnswerReason(status, data)), {
        kind: "http",
        code: String(status),
      });
    }
    const parts = [data.stdout, data.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exitCode = Number(data.exitCode ?? 0);
    if (exitCode !== 0) return truncate(`exit ${exitCode}:\n${parts}`);
    return truncate(parts || "(no output)");
  }

  async readFile(path: string, opts?: ExecTraceOptions): Promise<string> {
    const { status, data } = await this.opWithReattach("/read", { path }, { span: opts?.span });
    if (status !== 200) {
      throw classifyError(
        new ExecInfraError(
          `resident /read: ${String(data.error ?? `HTTP ${status}`)}`,
          residentAnswerReason(status, data),
        ),
        { kind: "http", code: String(status) },
      );
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
      throw classifyError(
        new ExecInfraError(
          `resident /read: ${String(data.error ?? `HTTP ${status}`)}`,
          residentAnswerReason(status, data),
        ),
        { kind: "http", code: String(status) },
      );
    }
    return decodeBase64Read(data, { where: "resident /read", path });
  }

  async writeFile(path: string, content: string, opts?: ExecTraceOptions): Promise<string> {
    const { status, data } = await this.opWithReattach("/write", { path, content }, { span: opts?.span });
    if (status !== 200) {
      throw classifyError(
        new ExecInfraError(
          `resident /write: ${String(data.error ?? `HTTP ${status}`)}`,
          residentAnswerReason(status, data),
        ),
        { kind: "http", code: String(status) },
      );
    }
    return `Wrote ${path}`;
  }
}
