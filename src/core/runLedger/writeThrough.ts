import { buildExpectedSeedManifest } from "./seedManifest.js";
import { PromotionPendingError, PromotionIdentityRefusal } from "./promotion.js";
import { sourceSeedReferenceMatches, type SourceSeedReference } from "./seedVerification.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { sameWorkspaceAllocation } from "./workspaceDurability.js";
import { allocationAckOf, UnknownAllocationClaimError } from "./allocationAck.js";
import { RefusalError, refusalOf } from "../refusal.js";
import type { OperationTarget } from "../repoContext.js";
import type { WorkspaceAllocationAck } from "./types.js";
import type { SessionCheckpointFailure } from "../mainContextRefusal.js";
import {
  applyContextCheckpoint,
  isContextCheckpointReceipt,
  type CanonicalCheckpointSource,
  type ContextCheckpointResult,
} from "../references/contextCheckpoint.js";
import { mergeSessionSources, sourceBinding, sourceHash, type SessionSources } from "../references/receipts.js";
import {
  isSourceResultReceipt,
  withSourceResults,
  type SourceResultReceipt,
} from "../references/sourceResultContext.js";
import {
  contextDependenciesOf,
  contextDependenciesHash,
  isContextDependencies,
  mergeContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
// The bot's write-through onto the run ledger (docs/reference/specs/run-history.md item
// 35): one `LedgerRun` per dispatched run that mirrors what the process holds
// in closures — the claim with the composed system prompt and tool
// definitions, the seed, a step record before each step's tools, the event
// stream in batches, the dispatcher's state, the finishing CAS, the finish —
// so the next container generation can pick the run up (the plan's D1–D3).
//
// Phase 2 rule: the ledger never changes what a run does. A refused or failed
// write detaches the run from the ledger (one warning, this run is not
// resumable) and the run goes on exactly as before; only the finish record is
// never dropped — it falls back to the plain store. The resume phase turns a
// fence refusal into a stop (a zombie must not keep working); this file is
// where that lands.

import { randomUUID } from "node:crypto";
import { systemClock } from "../trace/clock.js";
import { sealPausedHardStop } from "./pausedStop.js";
import type { SourceReadState } from "../../mcp/sourceReadState.js";
import type { StepReport } from "./stepReport.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ToolDef } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import type { RunRecord, RunSession } from "../runRecord.js";
import type { RecordSink } from "../runHistoryWriter.js";
import type { AssembledTranscript } from "./transcript.js";
import type { FenceResult, Notepad, SessionHit } from "./types.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "../runStoreWorker.js";
import { UncertainStoreError, type StoreRequestWitness } from "../storeFailure.js";
import { messageFromInbox } from "./inboxMessage.js";
import { createAppendFlusher } from "./flusher.js";
import type { HeartbeatFacts, RequesterTarget, RunLedger } from "./ledger.js";
import type { PlaneAckOutcome, PlaneAskAnswer, PlaneEffect, PlaneOutcomePost } from "../plane/decide.js";
import {
  isCoordinatorReconcileEffect,
  isCoordinatorReconcileReceipt,
  type CoordinatorReconcileEffect,
  type CoordinatorReconcileReceipt,
} from "../coordinator/workflowReconciliation.js";
import type { PlaneAdmitPost, PlaneLevelPost, PlaneObservePost } from "./ledger.js";
import { requestIndex, sessionKey, contextThreadSessionKey } from "./sessionLog.js";
import {
  APPEND_FLUSH_EVENTS,
  APPEND_FLUSH_MS,
  GEN_PATTERN,
  HEARTBEAT_MS,
  LEASE_MS,
  type AppendableEvent,
  type CardHandle,
  type IntakeReceipt,
  type IntakeWriteResult,
  type LiveRunMeta,
  type LiveRunRow,
  type LiveStateAssignRequest,
  type LiveStateAssignResult,
  type RunState,
  type StepRecord,
  type StopMode,
  type TranscriptTurn,
  type TranscriptRow,
  type InboxItem,
} from "./types.js";

/** The generation id: the process's fencing token, minted once at boot. Time
 *  first so a listing sorts by boot, then randomness so two containers booting
 *  in the same second (a rollout) never share one. Matches `GEN_PATTERN`. */
export function mintGeneration(now: () => number = Date.now, random: () => string = randomUUID): string {
  const stamp = new Date(now())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const gen = `${stamp}-${random().replace(/-/g, "").slice(0, 8)}`;
  if (!GEN_PATTERN.test(gen)) throw new Error(`minted generation ${gen} does not match GEN_PATTERN`);
  return gen;
}

/** Where a finished record goes: the ledger's `finish`, or the plain store —
 *  the history writer's own sink contract, `put` and the caller's final
 *  `abandoned` word (item 54). */
export type { RecordSink };

export interface LedgerWriteThroughOptions {
  ledger: RunLedger;
  gen: string;
  /** The plain run store, for a finish record the ledger cannot take (an older
   *  state Worker without the routes, a run the ledger never tracked, a fence). */
  fallback: RecordSink;
  warn: (message: string) => void;
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  flushMs?: number;
  flushEvents?: number;
  /** Attempts for the whole claim (the ledger's convention: retry the claim,
   *  never proceed past one that did not resolve `ok`). Default 3. */
  claimAttempts?: number;
  /** The plane's effect execution (record 0064, "The queue"): how an `admit`
   *  or already-durable `steer` riding a heartbeat answer runs — absent (an
   *  older wiring, tests), every effect defers and stays offered. `draining()`
   *  true defers both: a draining generation starts or wakes nothing. */
  planeEffects?: {
    draining(): boolean;
    admit(effect: Extract<PlaneEffect, { kind: "admit" }>): Promise<PlaneAckOutcome>;
    /** Finish the original coordinator report; no receipt defers its offer. */
    reconcile?(effect: CoordinatorReconcileEffect): Promise<CoordinatorReconcileReceipt | undefined>;
    /** Deliver an already-durable provider-recovery row to the live inbox.
     *  Absent on an older wiring: the effect remains offered. */
    steer?(effect: Extract<PlaneEffect, { kind: "steer" }>): Promise<PlaneAckOutcome>;
    /** The `probe` effect (record 0064): probe the resident's `/status`
     *  and forward its levels. Absent — a process without a resident — the
     *  probe is `skipped`; a drain never defers it (it starts no run). */
    probe?(effect: Extract<PlaneEffect, { kind: "probe" }>): Promise<PlaneAckOutcome>;
  };
  /** Injectable timers (tests). */
  sleep?: (ms: number) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

/** Put an already-durable steer into this generation's live inbox. The inbox's
 *  own durable-sequence set is the idempotency fence shared by a pushed
 *  effect, a heartbeat replay and a reclaimed row. */
export function deliverPlaneSteer(
  effect: Extract<PlaneEffect, { kind: "steer" }>,
  live:
    | {
        runId?: string;
        inbox: {
          readonly arrived: number;
          push(input: {
            text: string;
            at: number;
            userId: string;
            userName?: string;
            ledgerSeq: number;
            msg: {
              channelId: string;
              threadKey: string;
              text: string;
              userId: string;
              userName?: string;
            };
          }): void;
        };
      }
    | undefined,
): PlaneAckOutcome {
  if (live?.runId !== effect.runId) return "deferred";
  const message = effect.message;
  if (
    !Number.isSafeInteger(effect.seq) ||
    effect.seq < 1 ||
    typeof message.channelId !== "string" ||
    message.channelId.length === 0 ||
    typeof message.threadKey !== "string" ||
    message.threadKey.length === 0 ||
    typeof message.at !== "number" ||
    !Number.isFinite(message.at) ||
    message.userId !== "plane" ||
    message.userName !== "plane"
  )
    return "deferred";
  const restored = messageFromInbox(message, message.at, {
    runId: effect.runId,
    channelId: message.channelId,
    threadKey: message.threadKey,
  });
  if (restored?.control?.kind !== "provider-reissue") return "deferred";
  const before = live.inbox.arrived;
  live.inbox.push({
    text: restored.msg.text,
    at: restored.at,
    userId: restored.msg.userId,
    userName: restored.msg.userName,
    ledgerSeq: effect.seq,
    msg: restored.msg,
  });
  return live.inbox.arrived === before ? "skipped" : "done";
}

export interface OpenRunRequest {
  runId: string;
  threadKey: string;
  startedAt: number;
  meta: LiveRunMeta;
  card?: CardHandle | null;
  /** The composed system prompt, verbatim, and the tool definitions the run
   *  starts with — what a resume hands the model again. */
  system: string;
  tools: ToolDef[];
  state?: RunState;
  /** The conversation the run's model loop starts from (its `messages`);
   *  absent for a run without one loop of its own (a ship pipeline), which is
   *  tracked for the live index and the finish but closes `interrupted` at a
   *  reclaim. */
  seed?: {
    /** Canonical working lane selected from the persisted unit identity. */
    key?: string;
    /** Seeded notes for a new working lane. An established notepad always wins. */
    notepad?: string;
    context?: ContextDependencies;
    messages: ChatMessage[];
    /** The run's whole wall-clock budget (`agent.maxMinutes`), recorded as the
     *  seed record's `remainingMs` — paired with the messages so a seed can
     *  never be written without it. */
    budgetMs: number;
    /** A seed read from the session's own log (session-log item 9): the first
     *  `turns` messages are the log's rows from `from`, one row each, and are
     *  not written again — the row's `seedFrom` is `from` and its range begins
     *  at the log's tail. Named rows that do not end at the tail (the log moved
     *  under the seed) are written whole as new rows, with one warning. */
    log?: { from: number; turns: number };
    refusedRequests?: readonly number[];
    /** Platform-namespaced author ids, parallel to `messages`, for the rows
     *  the seed writes (absent entries and undefined mean no actor; record
     *  0057). Machine turns and reused log rows carry none. */
    actors?: readonly (string | undefined)[];
  };
  /** A stop another generation requested (`/runs/stop` on a different
   *  container), relayed by the heartbeat — once per mode. */
  onStop?: (mode: StopMode) => void;
  /** Another generation owns this run now (a write was `fenced`, plan D9): the
   *  caller must stop the run at once — it must not reply, and its next tool
   *  call would act on a run someone else is driving. Once per run. */
  onFenced?: () => void;
  /** The promotion's claim went untracked (failing retries or RouteMissingError)
   *  while a reservation stood: the row has been abandoned, the heartbeat
   *  stopped, and the run will run untracked — why, in the words the run's
   *  record gets (item 54). Called once, only when a `reservation` was given.
   *  A coordinator child's reservation is retained instead: the caller must
   *  fail setup through its same-id finalizer, never run it untracked. */
  onUntracked?: (why: string) => void;
  /** The run's reservation from admission (item 42), when it has one: the open
   *  promotes that row in place — same tracked run, same heartbeat — instead
   *  of claiming a new one. */
  reservation?: LedgerRun;
}

/** The row a run leaves at admission, before its prompt exists (item 42): the
 *  identity, the request it was admitted for, the card — so a kill during the
 *  workspace attach leaves something to restart from. */
export interface ReserveRunRequest {
  runId: string;
  threadKey: string;
  startedAt: number;
  /** With `request` set: the message in the durable inbox row's shape. */
  meta: LiveRunMeta;
  card?: CardHandle | null;
  onStop?: (mode: StopMode) => void;
  onFenced?: () => void;
}

/** How a reservation ended (item 42; item 54 for `untracked`): the tracked run
 *  with its heartbeat running; `untracked` with why — the thread's row is a run
 *  this process was closing and still stood after its finish settled, or is
 *  another run's for real, or the state Worker has no run-ledger routes, or the
 *  claim kept failing — for the run's own record, the warning in the bot log
 *  not being the only witness; `fenced` — this run's row is another
 *  generation's; `off` — the process has no ledger, nothing to say. */
export interface TerminalCommitmentHold {
  readonly version: 1;
  readonly runId: string;
  readonly gen: string;
  readonly threadKey: string;
  readonly requestDigest: string;
}

/** A caller must retain this original run through setup finalization. The
 * complete private request stays on the inherited uncertain-store witness. */
export class TerminalCommitmentUnknownError extends UncertainStoreError {
  readonly hold: TerminalCommitmentHold;
  constructor(hold: TerminalCommitmentHold, request: StoreRequestWitness) {
    super("the original terminal commitment remains unknown", request);
    this.hold = Object.freeze({ ...hold });
  }
}

/** Named typed boundary builder: the dispatcher preserves custody instead
 * of rendering this unknown operation as a settled refusal. */
export function terminalCommitmentUnknown(
  hold: TerminalCommitmentHold,
  request: StoreRequestWitness,
): TerminalCommitmentUnknownError {
  return new TerminalCommitmentUnknownError(hold, request);
}

export type ReserveOutcome =
  | { kind: "tracked"; run: LedgerRun; allocationAck?: WorkspaceAllocationAck }
  | { kind: "untracked"; why: string; refused?: "thread-live" }
  | { kind: "fenced" }
  | { kind: "off" }
  | { kind: "held"; hold: TerminalCommitmentHold; error: TerminalCommitmentUnknownError };

/** How `open` ended (record 0060; the same discriminants as `ReserveOutcome`):
 *  `tracked` with the run's handle; `untracked` with why — the machine word
 *  `thread-live` when the thread's row refused the claim (what the ship branch
 *  refuses by name), otherwise the reason in the words the run's record gets
 *  (item 54); `fenced` — the row is another generation's, this process must not
 *  drive the run; `off` — the process has no ledger; `held` retains an
 *  original uncertain terminal operation and its real private witness.
 *  It must not authorize untracked execution or setup finalization. */
export type OpenOutcome =
  | { kind: "tracked"; run: LedgerRun }
  | { kind: "untracked"; why: string }
  | { kind: "fenced" }
  | { kind: "off" }
  | { kind: "held"; hold: TerminalCommitmentHold; error: TerminalCommitmentUnknownError };

/** `finishing()`'s answer: `ok` — reply; `fenced` — another generation owns
 *  the run, do NOT reply (it will); `unavailable` — the ledger could not be
 *  asked or this run is untracked, reply as before (the run is this process's). */
export type FinishingGate = "ok" | "fenced" | "unavailable";

export type WriteBoundaryFailure =
  | {
      version: 1;
      runId: string;
      gen: string;
      kind: "step";
      requestDigest: string;
      expectedDigest: string;
      step: number;
    }
  | {
      version: 1;
      runId: string;
      gen: string;
      kind: "state";
      requestDigest: string;
      expectedDigest: string;
      stateVersion: number;
    };

/** One tracked run. Every method is safe to call after a detach. */
export interface LedgerRun {
  /** Canonical acknowledged original identity only; no disposal eligibility. */
  readonly allocationAck?: WorkspaceAllocationAck;
  readonly runId: string;
  /** False once a write was refused or failed for good: the ledger no longer
   *  mirrors this run (it is not resumable); the finish still lands. */
  tracked(): boolean;
  /** The runner's step hook: the step's turns, then its record — awaited. */
  step(report: StepReport): Promise<void>;
  /** A registry event, in publish order, with the registry's `seq`. */
  event(event: RunEvent, seq: number): void;
  /** Reconcile uncertain snapshots before a live-state assignment can change their canonical readback. */
  assignLiveState(assignment: LiveStateAssignRequest): Promise<LiveStateAssignResult>;
  /** Merge into the run's state and send it (coalesced: the newest wins). */
  setState(patch: RunState): void;
  /** Commit a security binding before the side effect it authorizes. */
  setStateAndFlush(patch: RunState): Promise<boolean>;
  /** The same state write, retaining ownership loss separately from unavailable storage. */
  commitState(patch: RunState): Promise<FinishingGate>;
  /** Persist trusted dependencies before source content reaches a model. */
  writeSources(sources: SessionSources): Promise<boolean>;
  /** Persist one controller-admitted result before handing its bytes to a model. */
  recordSourceResult(receipt: SourceResultReceipt): Promise<boolean>;
  /** Freeze an acknowledged source cursor in the owned live row before handoff. */
  checkpointSession(): Promise<{ key: string; through: number } | undefined>;
  /** Sanitized cause of the most recent failed checkpoint, for the run's failure event. */
  readonly lastCheckpointFailure: SessionCheckpointFailure | undefined;
  readonly writeBoundaryFailure: WriteBoundaryFailure | undefined;
  /** Once after the initial seed ACK, before provider execution. */
  normalizeContextOrigins(): Promise<ContextCheckpointResult>;
  /** `live → finishing`, before the reply — the double-answer gate (D9). */
  finishing(): Promise<FinishingGate>;
  /** A reserved run that never started (item 42): the row goes with no record,
   *  so nothing restarts it. A no-op for a detached run (fenced: another
   *  generation owns the row) and for an untracked one. */
  abandon(): Promise<void>;
  /** Preserve this one resumed run and its binding for the next generation after
   *  a readiness failure. No finish record or replacement workspace is made. */
  pauseForRetry(): Promise<boolean>;
  /** The pause side found an earlier hard stop and sealed the run. */
  readonly pauseStopped?: boolean;
  /** Confirmed by a fresh ledger read after the handoff and any stop seal. */
  readonly pauseRetained?: boolean;
  /** True when a resume could continue this run: its seed and seed record
   *  landed, it was adopted from a resume, or it is a hosted ship parent
   *  (record 0060) — a row with no process of its own that the next
   *  generation re-hosts, so SIGTERM hands it off like any resumable run. A
   *  detached run and a run whose seed failed are not. */
  readonly resumable: boolean;
  /** True once this generation handed the run to the next (SIGTERM). */
  readonly handedOff: boolean;
  /** The run's place in its session log (session-log item 2), once the claim
   *  set it — what the session tools read and write by (item 10); undefined
   *  for a run without a session or before its claim. */
  readonly session: RunSession | undefined;
  /** The log row a local index of the run's conversation lands on — `seedFrom`
   *  plus the index, the arithmetic every seed and step write uses — so what a
   *  `tool_call`'s and a `tool_result`'s `logIndex` is stamped with (run-history
   *  item 53) and the row the step wrote cannot disagree. Undefined for a run
   *  without a session: its rows are its own and no search reaches them. */
  logIndexOf(localIndex: number): number | undefined;
  /** The finish record's sink: the ledger's one-transaction `finish`, else the
   *  plain store — never both, never neither. Throws only a transient failure
   *  (the writer retries it; a repeated `finish` is idempotent). */
  readonly sink: RecordSink;
  /** Await this run's terminal ledger acknowledgement, bounded by the sink
   *  caller's retry policy. A plain-store fallback does not confirm removal
   *  of the live owner; `unstarted` confirms nothing either. */
  waitForFinish(): Promise<LandingOutcome | { kind: "unstarted" } | { kind: "off" }>;
  /** Stop the heartbeat and flush the events. Idempotent; `sink.put` does it too. */
  close(): Promise<void>;
}

export type { SessionCheckpointFailure } from "../mainContextRefusal.js";

/** A run this generation reclaimed at boot (docs/reference/specs/run-history.md item 37):
 *  its row is already ours — no claim, no seed — and its writes continue from
 *  where the previous generation stopped. */
export interface AdoptRunRequest {
  runId: string;
  threadKey: string;
  /** The row's meta and original start, so an adopted coding run keeps its
   *  heartbeat facts (record 0064) — the backpressure contract must survive a
   *  restart, not end at it. Absent only where the caller has no row to read. */
  meta?: LiveRunMeta;
  startedAt?: number;
  /** The row's state, so patches merge into what the previous generation recorded. */
  state: RunState;
  /** The last step record's number; the next step write is `lastStep + 1`. */
  lastStep: number;
  /** The highest event `seq` on the ledger; the next append continues past it. */
  lastSeq: number;
  /** Turn count from the boot-verified complete transcript, including a final
   * turn whose step record did not land. Restores the cursor when its separate
   * state acknowledgment was unavailable before handoff. */
  durableTurns?: number;
  /** The row's place in its session log (session-log item 2): the adopted run
   *  appends at its indices and its record closes the range. Absent for a row
   *  claimed before the log existed, which keeps writing its own object. */
  session?: RunSession;
  onStop?: (mode: StopMode) => void;
  onFenced?: () => void;
}

export interface LedgerWriteThrough {
  /** False only for the explicit no-ledger implementation, never for an outage. */
  readonly sessionPersistence: boolean;
  readonly gen: string;
  /** Current ledger owner receives a monotonic fence before resident attach. */
  claimResident(runId: string, threadKey: string): Promise<number | undefined>;
  /** Reserve the thread at admission (item 42): an `attaching` row with the
   *  request and no prompt, its heartbeat running — or why not (`ReserveOutcome`).
   *  The run is not resumable until `open` promotes it; a reclaim of the row
   *  restarts the run from its request. */
  reserve(req: ReserveRunRequest): Promise<ReserveOutcome>;
  /** Claim and seed. `tracked` with the run's handle; anything else and the
   *  run is not tracked: `untracked` when the thread has a live row already
   *  (`why: "thread-live"` — reclaim is the resume phase's), the routes are
   *  missing, or the claim kept failing; `fenced` when, with a reservation, the
   *  row was taken by another generation (the reservation is told through
   *  `onFenced`; this process must not run it). When a reservation is given and
   *  the promotion's claim goes untracked, `onUntracked` is called with why (in
   *  the record's words) before returning, and the reserved row is abandoned.
   *  A coordinator child keeps its reservation for the setup finalizer instead;
   *  its caller must not start the model without a tracked promotion. */
  open(req: OpenRunRequest): Promise<OpenOutcome>;
  /** Take up a reclaimed run: heartbeat, steps, events and state continue
   *  under this generation with no claim and no seed. Synchronous — the row is
   *  ours since the boot reclaim, and the heartbeat must start at once. */
  adopt(req: AdoptRunRequest): LedgerRun;
  /** The runs this generation is driving right now (opened or adopted, not yet finished). */
  liveRuns(): LedgerRun[];
  /** Internal canonical rows for source checks; never a public diagnostic projection. */
  readLiveRuns(): Promise<LiveRunRow[]>;
  readContextCheckpoint(runId: string): Promise<CanonicalCheckpointSource | undefined>;
  /** A durable copy of a steered follow-up (run-history item 40), under the
   *  run's row whichever generation holds it: the ledger's inbox seq, or
   *  undefined (with a warning) when the ledger refuses — the row is gone — or
   *  cannot be reached. Never fenced: a steer arrives on whichever container is
   *  up. */
  pushInbox(runId: string, message: Record<string, unknown>): Promise<number | undefined>;
  /** The run's durable inbox past `afterSeq` (run-history item 40) — the
   *  resume's re-read at adopt time. Empty, with a warning, when the ledger
   *  cannot be asked (a state Worker without the route included). */
  readInbox(runId: string, afterSeq: number): Promise<InboxItem[]>;
  /** A session log's newest whole turns within `maxBytes` (session-log item 4),
   *  oldest first, with the log index they start at — what a follow-up's seed
   *  is cut from (item 9). A log with no rows answers `from` 0 and no turns.
   *  Throws as the ledger does; the caller decides what a failed read means. */
  readSessionTail(
    key: string,
    maxBytes: number,
  ): Promise<{ from: number; transcript: AssembledTranscript; sources?: SessionSources; requiresFreshSources?: true }>;
  /** The rows `[from, to]` of a session log as a conversation counted from `from` (item 3) — one turn when `to` is `from`. */
  readSession(key: string, from: number, to?: number): Promise<AssembledTranscript>;
  readSessionEntry(key: string, rowId: string): Promise<readonly TranscriptRow[] | undefined>;
  /** The idempotent keyed append (session-log item 13): the parts of one turn
   *  at the log's tail under `rowId` — a fold row, a connector turn, a migrated
   *  row. A row id the log has seen appends nothing. Throws as the ledger does. */
  appendSession(
    key: string,
    rowId: string,
    rows: readonly { part: number; json: string }[],
    context?: ContextDependencies,
  ): Promise<{ ok: boolean; appended: boolean }>;
  /** The full-text search `recall` makes (item 10): hits in relevance order, and the gap markers between them. */
  searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }>;
  /** Actor-stamped thread target independent of the model transcript. */
  readRequesterTarget(key: string, actor: string): Promise<RequesterTarget | null>;
  checkpointRequesterTarget(key: string, actor: string, target: RequesterTarget): Promise<RequesterTarget>;
  /** The session's notepad, or null when nothing wrote it (item 10). */
  readNotepad(key: string): Promise<Notepad | null>;
  /** Replace the notepad whole under this generation's fence (item 10). */
  writeNotepad(key: string, text: string, runId?: string): Promise<FenceResult>;
  /** SIGTERM (plan D8): mark every resumable live run `handoff` on the ledger so
   *  the next generation takes it at once, whatever its lease. The runs keep
   *  running here until the process exits; their writes are fenced the moment
   *  the next generation reclaims them. Returns the run ids marked. */
  handoff(): Promise<{ marked: string[]; failed?: string }>;
  /** An intake receipt write with the claim's retry (run-history item 59): a
   *  lost response is retried after `RETRY_MS[0]` by READING the same row —
   *  the insert may have landed — and a row carrying this write's `gen` and
   *  `decidedAt` answers `inserted: true`, another writer's answers what it
   *  stored; a read that finds none inserts once more. `undefined` (with one
   *  warning) when the ledger cannot say — the route missing, a permanent
   *  refusal, or the retry failing too — the caller's degrade (record 0058). */
  recordIntake(key: string, receipt: IntakeReceipt): Promise<IntakeWriteResult | undefined>;
  /** The shadow outcome post (orchestration-plane; record 0064; orchestration-plane item 8): fire and
   *  forget — the dispatch's answer never waits on the plane, and a failed or
   *  missing route is one warning, never a throw. The caller gates on
   *  `plane.admission`; this seam only carries the post. */
  planeOutcome(post: PlaneOutcomePost): void;
  /** The admission-stage ask (record 0064, "The queue"): awaited — the door's
   *  answer IS the plane's. A failed or missing route answers `admitted` with
   *  one warning: the plane must never take the door down. */
  planeAdmit(post: PlaneAdmitPost): Promise<PlaneAskAnswer>;
  /** `runs stop` on a queued id: the waiting row goes withdrawn. */
  planeWithdraw(runId: string): Promise<{ withdrawn: boolean }>;
  /** A resident's level report (record 0064): awaited by the resident-stage ask so the
   *  decider judges the level just seen; a failed or missing route is one
   *  warning — the plane must never take the door down. */
  planeLevel(post: PlaneLevelPost): Promise<void>;
  /** A run parked on its provider (record 0064): fire and forget like the
   *  level post — a failure is one warning, the run's own lease still counts. */
  planePark(runId: string, provider: string): Promise<void>;
  /** A refusal-by-name met at attach or exec (record 0064): `reentered` false when the
   *  plane never held the run — the caller's own fallback stands. */
  planeObserve(post: PlaneObservePost): Promise<{ reentered: boolean }>;
}

/** The write-through of a process without a run ledger (a Null Object,
 *  routing-and-config item 16): nothing is claimed, so `open` answers as the
 *  real one does for an untracked run and every run goes on exactly as it did
 *  before the ledger existed; the inbox and the handoff hold nothing. `adopt`
 *  has nothing to adopt — a reclaim needs a ledger — and answers a detached run
 *  whose finish sink is the plain store, so a record can never vanish. */
export class NullLedgerWriteThrough implements LedgerWriteThrough {
  readonly sessionPersistence = false;
  constructor(
    readonly gen: string,
    private readonly fallback: RecordSink,
  ) {}
  async claimResident(_runId: string, _threadKey: string): Promise<number | undefined> {
    return undefined;
  }
  async reserve(_req: ReserveRunRequest): Promise<ReserveOutcome> {
    return { kind: "off" };
  }
  async open(_req: OpenRunRequest): Promise<OpenOutcome> {
    return { kind: "off" };
  }
  adopt(req: AdoptRunRequest): LedgerRun {
    return new NullLedgerRun(req.runId, this.fallback);
  }
  liveRuns(): LedgerRun[] {
    return [];
  }
  async readLiveRuns(): Promise<LiveRunRow[]> {
    return [];
  }
  async readContextCheckpoint(_runId: string): Promise<undefined> {
    return undefined;
  }
  async pushInbox(_runId: string, _message: Record<string, unknown>): Promise<number | undefined> {
    return undefined;
  }
  async readInbox(_runId: string, _afterSeq: number): Promise<InboxItem[]> {
    return [];
  }
  async readSessionTail(
    _key: string,
    _maxBytes: number,
  ): Promise<{ from: number; transcript: AssembledTranscript; sources?: SessionSources; requiresFreshSources?: true }> {
    return { from: 0, transcript: { complete: true, turns: 0, messages: [], compactions: [] } };
  }
  async readSession(_key: string, _from: number, _to?: number): Promise<AssembledTranscript> {
    return { complete: true, turns: 0, messages: [], compactions: [] };
  }
  async readSessionEntry(_key: string, _rowId: string): Promise<readonly TranscriptRow[] | undefined> {
    return undefined;
  }
  async appendSession(
    _key: string,
    _rowId: string,
    _rows: readonly { part: number; json: string }[],
    _context?: ContextDependencies,
  ): Promise<{ ok: boolean; appended: boolean }> {
    return { ok: false, appended: false };
  }
  async searchSession(_key: string, _query: string, _limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }> {
    return { hits: [], gaps: [] };
  }
  async readRequesterTarget(_key: string, _actor: string): Promise<RequesterTarget | null> {
    return null;
  }
  async checkpointRequesterTarget(_key: string, _actor: string, _target: RequesterTarget): Promise<RequesterTarget> {
    throw new PermanentStoreError("requester target checkpoint store is unavailable");
  }
  async readNotepad(_key: string): Promise<Notepad | null> {
    return null;
  }
  async writeNotepad(_key: string, _text: string): Promise<FenceResult> {
    return { ok: false, reason: "unknown-run" };
  }
  async handoff(): Promise<{ marked: string[]; failed?: string }> {
    return { marked: [] };
  }
  planeOutcome(_post: PlaneOutcomePost): void {
    // No ledger, no plane: the post has nowhere to land and shadow is moot.
  }
  async planeLevel(_post: PlaneLevelPost): Promise<void> {}

  async planePark(_runId: string, _provider: string): Promise<void> {}

  async planeObserve(_post: PlaneObservePost): Promise<{ reentered: boolean }> {
    return { reentered: false };
  }

  async planeAdmit(_post: PlaneAdmitPost): Promise<PlaneAskAnswer> {
    // No ledger, no queue: every ask proceeds as it did before the plane existed.
    return { kind: "admitted", reservation: "none" };
  }
  async planeWithdraw(_runId: string): Promise<{ withdrawn: boolean }> {
    return { withdrawn: false };
  }
  async recordIntake(_key: string, _receipt: IntakeReceipt): Promise<IntakeWriteResult | undefined> {
    return undefined;
  }
}

/** A run the null write-through was asked to adopt: untracked, not resumable,
 *  every mirror a no-op, its finish landing on the plain store. */
export class NullLedgerRun implements LedgerRun {
  async waitForFinish(): Promise<{ kind: "off" }> {
    return { kind: "off" };
  }
  readonly lastCheckpointFailure = undefined;
  readonly writeBoundaryFailure = undefined;
  async normalizeContextOrigins(): Promise<ContextCheckpointResult> {
    return { ok: false, reason: "checkpoint-unavailable" };
  }
  async checkpointSession(): Promise<undefined> {
    return undefined;
  }
  readonly resumable = false;
  readonly handedOff = false;
  readonly session = undefined;
  constructor(
    readonly runId: string,
    readonly sink: RecordSink,
  ) {}
  tracked(): boolean {
    return false;
  }
  logIndexOf(_localIndex: number): number | undefined {
    return undefined; // no session log holds this run's rows
  }
  async step(_report: StepReport): Promise<void> {
    // no ledger to mirror onto
  }
  event(_event: RunEvent, _seq: number): void {
    // no ledger to mirror onto
  }
  async assignLiveState(_assignment: LiveStateAssignRequest): Promise<LiveStateAssignResult> {
    return { ok: false, reason: "unknown-run" };
  }
  setState(_patch: RunState): void {
    // no ledger to mirror onto
  }
  async writeSources(_sources: SessionSources): Promise<boolean> {
    return false;
  }
  async recordSourceResult(_receipt: SourceResultReceipt): Promise<boolean> {
    return false;
  }
  async setStateAndFlush(_patch: RunState): Promise<boolean> {
    return false;
  }
  async commitState(_patch: RunState): Promise<FinishingGate> {
    return "unavailable";
  }
  async finishing(): Promise<FinishingGate> {
    return "unavailable";
  }
  async abandon(): Promise<void> {}
  async pauseForRetry(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {
    // nothing was open
  }
}

/** Backoff before a retry: the claim gets both, a step or state write the first. */
const RETRY_MS: readonly number[] = [200, 800];

/** How many finishes landed in this process the write-through remembers
 *  (item 54; the `landed` set): the newest ones, oldest out. A row naming an
 *  older finish is a stale row and is untracked in one claim. */
export const LANDED_MAX = 256;

/** The new producer retains inherited leaves and adds its own canonical origin. */
function seedSources(req: OpenRunRequest): SessionSources | undefined {
  const context = req.seed?.context ?? req.meta.childHandoff?.dependencies?.value;
  if (context === undefined) return undefined;
  return {
    version: 1,
    status: "known",
    binding: sourceBinding(req.meta),
    receipts: [],
    context: mergeContextDependencies(context, {
      version: 1,
      status: "known",
      revision: 0,
      origins: [
        { runId: req.runId, requester: req.meta.userId, channelId: req.meta.channelId, threadKey: req.meta.threadKey },
      ],
      slack: [],
      mcp: [],
    }),
  };
}

/** How a run's finish ended (item 54): the row went (`landed`), the ledger
 *  refused it and the record went to the plain store (`refused`), or the
 *  attempt sequence failed for good (`failed`, with the last error's words). */
export type LandingOutcome =
  | { kind: "landed" }
  | { kind: "refused" }
  | { kind: "failed"; why: string }
  | { kind: "unknown"; requestDigest: string };

/** A finish this process is landing (item 54): one entry per run from its
 *  first `put` to the outcome, settled once, awaited by a claim that met the
 *  run's row on the thread. */
interface Landing {
  settled: Promise<LandingOutcome>;
  resolve: (outcome: LandingOutcome) => void;
  record?: string;
  unknown: Array<{ record: string; request: StoreRequestWitness; hold: TerminalCommitmentHold }>;
}

/** Why a claim that waited for a finish ended untracked all the same (item
 *  54): the run's row still stood — or another run's row does now. */
function untrackedWhy(awaited: string, live: { runId: string }, outcome: LandingOutcome): string {
  if (live.runId !== awaited)
    return `the thread's live row belongs to run ${live.runId} now, not to run ${awaited}, whose finish this process landed or was landing`;
  const inFlight = `run ${awaited}, whose finish was in flight in this process, still holds the thread's row`;
  switch (outcome.kind) {
    case "unknown":
      return `${inFlight}: its original terminal commitment remains unknown`;
    case "failed":
      return `${inFlight}: its finish did not land (${outcome.why})`;
    case "refused":
      return `${inFlight}: the ledger refused its finish`;
    case "landed":
      return `run ${awaited}, whose finish landed in this process, still holds the thread's row: the row stands past its finish`;
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createLedgerWriteThrough(opts: LedgerWriteThroughOptions): LedgerWriteThrough {
  const { ledger, gen, fallback, warn } = opts;
  const now = opts.now ?? systemClock;
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startInterval =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const stopInterval = opts.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout));
  const claimAttempts = opts.claimAttempts ?? RETRY_MS.length + 1;
  let routeMissingWarned = false;
  const live = new Set<TrackedRun>();
  /** The finishes this process is landing right now, by run id (item 54): from
   *  the sink's first `put` to the outcome — landed, refused, or failed for
   *  good. A claim answered `thread-live` for a run named here awaits its
   *  `settled` — an event, no timer of the write-through's own — then claims
   *  once more. What bounds the wait is the finish's own attempt sequence:
   *  every ledger call in an attempt (the state flush, the append flush, the
   *  finish, the store fallback) aborts at the client's `AbortSignal.timeout`
   *  (`RUN_STORE_TIMEOUT_MS`), and between the history writer's attempts its
   *  fixed backoff; the entry lives until the caller's final word — the record
   *  landed or was refused, or the caller said `abandoned` (the writer at its
   *  give-up, a one-shot closer after its failed put) — so the sink never
   *  re-derives a retry policy, and no waiter outlives its caller. */
  const landing = new Map<string, Landing>();
  /** The runs whose finish landed in this process most recently (item 54): a
   *  `thread-live` naming one of them is the moment between the answer and the
   *  row's release, and is claimed once more at once; a row named neither here
   *  nor in `landing` is another run's for real and is untracked in one claim,
   *  as before. Capped at `LANDED_MAX`, oldest out (a `Set` keeps insertion
   *  order): an entry covers only the moment after its finish, and a resident
   *  roll finishes every live run within seconds, so the newest few hundred
   *  hold far more than that window ever needs — where an uncapped set, like
   *  the history writer's `finals`, would grow one id per finished run for the
   *  process's life. */
  const landed = new Set<string>();
  /** This generation's reservations not yet promoted, finished or abandoned for
   *  sure (item 42): a `thread-live` naming one of them, with no tracked run
   *  driving it, is this process's own dead reservation whose abandon did not
   *  reach the ledger — the claim abandons it again and claims once more
   *  (item 54), so no dispatch ordering in the finally has to be right. */
  const unpromoted = new Set<string>();
  const landingFor = (runId: string): Landing => {
    let entry = landing.get(runId);
    if (entry === undefined) {
      let resolve!: (outcome: LandingOutcome) => void;
      const settled = new Promise<LandingOutcome>((r) => (resolve = r));
      entry = { settled, resolve, unknown: [] };
      landing.set(runId, entry);
    }
    return entry;
  };
  const settleLanding = (runId: string, entry: Landing, outcome: LandingOutcome): void => {
    if (entry.unknown.length > 0 && outcome.kind !== "unknown") return;
    entry.resolve(outcome);
    if (outcome.kind === "unknown") return;
    if (landing.get(runId) === entry) landing.delete(runId);
    if (outcome.kind === "landed") {
      landed.delete(runId); // re-inserted as the newest
      landed.add(runId);
      while (landed.size > LANDED_MAX) landed.delete(landed.values().next().value!);
    }
  };

  const routeMissing = (): void => {
    if (routeMissingWarned) return;
    routeMissingWarned = true;
    warn(
      "[ledger] state Worker has no run-ledger routes — deploy it before this bot version; runs are not tracked until then",
    );
  };

  /** `untracked` carries why, in the words the run's own record gets (item 54);
   *  `refused` marks the thread-live case — the thread's row stood — apart from
   *  the missing-route and failed-claim ones, for `open`'s answer. */
  type Claimed =
    | { outcome: "ok"; session?: RunSession; allocationAck?: WorkspaceAllocationAck }
    | { outcome: "fenced" }
    | { outcome: "held"; hold: TerminalCommitmentHold; error: TerminalCommitmentUnknownError }
    | { outcome: "untracked"; why: string; refused?: "thread-live" };

  const heldLanding = (entry: Landing): Extract<Claimed, { outcome: "held" }> => {
    const original = entry.unknown[0];
    return {
      outcome: "held",
      hold: original.hold,
      error: terminalCommitmentUnknown(original.hold, original.request),
    };
  };

  /** `fenced`: the thread's row is THIS run under another generation — the
   *  reservation's lease lapsed and a reclaim took it (item 42); this process
   *  must not drive it. With a `seed`, the run is a range of its thread-and-
   *  agent session log (session-log item 2): the log's tail is read first,
   *  the row's meta names the range the seed will occupy, and the log's owner
   *  is taken AFTER the history claim — so a refused claim never steals a live
   *  run's log. The three requests are one claim: any failure retries them all. */
  async function claim(
    req: Omit<OpenRunRequest, "seed" | "reservation">,
    opts: {
      phase?: "attaching";
      seed?: readonly ChatMessage[];
      key?: string;
      log?: { from: number; turns: number };
      /** Only the validated, owned reservation supplies this private promotion witness. */
      originalAck?: WorkspaceAllocationAck;
    } = {},
  ): Promise<Claimed> {
    const allocationBearing = req.meta.workspaceAllocation !== undefined || opts.originalAck !== undefined;
    req = { ...req, meta: structuredClone(req.meta) };
    // The one re-claim made after a `thread-live` naming a run this process
    // finished or is finishing, and — when its finish was waited for — how
    // that finish ended: what the untracked note says.
    let claimedAgain = false;
    let awaited: { runId: string; outcome: LandingOutcome } | undefined;
    // This generation's own dead reservation met on the thread, abandoned again from here.
    let reabandoned: { runId: string; failed?: string } | undefined;
    // A restart that keeps its predecessor's run id (item 54) reaches here
    // while that run's finish may still be in flight: claiming now would be
    // the owner's idempotent re-claim of the CLOSING row — same run, same
    // generation — and the landing finish would then delete that row under
    // the restarted run. Await the landing first (bounded by the finish's own
    // calls, exactly as the thread-live wait below is), so the claim inserts
    // a fresh row for the run's new segment; a finish that failed leaves the
    // run's own row standing, and the idempotent re-claim keeps it.
    const priorFinish = landing.get(req.runId);
    if (priorFinish !== undefined) awaited = { runId: req.runId, outcome: await priorFinish.settled };
    if (awaited?.outcome.kind === "unknown") return heldLanding(landing.get(awaited.runId)!);
    for (let attempt = 1; ; attempt++) {
      let claimEntered = false,
        claimAccepted = false;
      try {
        let session: RunSession | undefined;
        if (opts.seed) {
          const key = opts.key ?? sessionKey(req.meta.threadKey, req.meta.agent);
          const next = await ledger.sessionTail(key);
          // A seed read from the log (session-log item 9) begins at its cut when
          // the rows it names end exactly at the tail; otherwise the log moved
          // under it and the whole seed is written as new rows from the tail.
          let seedFrom = next;
          if (opts.log) {
            if (opts.log.from + opts.log.turns === next) seedFrom = opts.log.from;
            else
              warn(
                `[ledger] ${req.threadKey} run ${req.runId}: the seed names log rows ${opts.log.from}..${opts.log.from + opts.log.turns - 1} but the log's tail is ${next} — the whole seed is written as new rows`,
              );
          }
          session = {
            key,
            threadSession: contextThreadSessionKey(req.meta.threadKey),
            seedFrom,
            request: seedFrom + requestIndex(opts.seed),
            range: { from: next },
          };
        }
        const request = {
          runId: req.runId,
          threadKey: req.threadKey,
          gen,
          leaseMs,
          startedAt: req.startedAt,
          meta: session ? { ...req.meta, session } : req.meta,
          card: req.card ?? null,
          system: req.system,
          tools: req.tools,
          ...(req.state !== undefined ? { state: req.state } : {}),
          ...(opts.phase ? { phase: opts.phase } : {}),
        };
        const expected = structuredClone(request);
        claimEntered = true;
        const result = await ledger.claim(request);
        if (result.ok) {
          claimAccepted = true;
          const allocationAck = allocationAckOf(result.allocationAck, expected);
          if (
            opts.originalAck &&
            (!allocationAck ||
              (opts.originalAck.allocation === null
                ? allocationAck.allocation !== null
                : !sameWorkspaceAllocation(opts.originalAck.allocation, allocationAck.allocation)))
          )
            throw new UnknownAllocationClaimError("the original promotion acknowledgment is unavailable");
          if (session) await ledger.claimSession(session.key, req.runId, gen);
          return { outcome: "ok", ...(session ? { session } : {}), ...(allocationAck ? { allocationAck } : {}) };
        }
        if (result.live.runId === req.runId) return { outcome: "fenced" };
        if (opts.originalAck)
          return { outcome: "untracked", why: "the original reservation's thread is occupied", refused: "thread-live" };
        // The thread's live row is a run this process is closing or has just
        // closed (item 54): a restart from its request, or the fresh turn for
        // its unconsumed follow-ups, is dispatched from that run's finally right
        // after its finish was handed to the history writer, so this claim can
        // reach the ledger ahead of that write — or in the moment after it
        // landed. Claim once more, once: after the finish when it is in flight
        // here (its `settled` in `landing`, an awaited event, bounded by the
        // finish's own calls, the writer's backoff and the caller's final word,
        // never a timer of ours), at once when it landed here already
        // (`landed`). A row named by neither is another run's for real, and
        // the claim is untracked in one round trip, as it always was. The
        // second answer is the last: a finish that failed or was refused
        // leaves the row standing, and the run goes on untracked, as any other
        // thread-live answer leaves it — every exit saying why, for the run's
        // own record.
        if (!claimedAgain) {
          const inFlight = landing.get(result.live.runId);
          if (inFlight !== undefined) {
            claimedAgain = true;
            awaited = { runId: result.live.runId, outcome: await inFlight.settled };
            if (awaited.outcome.kind === "unknown") return heldLanding(inFlight);
            attempt--; // the re-claim is not a failed attempt
            continue;
          }
          if (landed.has(result.live.runId)) {
            claimedAgain = true;
            awaited = { runId: result.live.runId, outcome: { kind: "landed" } };
            attempt--;
            continue;
          }
          // This generation's own reservation that never started, whose abandon
          // did not reach the ledger (item 42): nobody drives it here, nothing is
          // landing for it — abandon it again from here, then claim once more.
          if (unpromoted.has(result.live.runId) && ![...live].some((r) => r.runId === result.live.runId)) {
            claimedAgain = true;
            reabandoned = { runId: result.live.runId };
            try {
              await ledger.abandon(result.live.runId, gen);
              unpromoted.delete(result.live.runId); // gone, or another generation's: nothing of ours stands
            } catch (err) {
              reabandoned.failed = describe(err);
            }
            attempt--;
            continue;
          }
        }
        const why =
          awaited !== undefined
            ? untrackedWhy(awaited.runId, result.live, awaited.outcome)
            : reabandoned !== undefined && reabandoned.runId === result.live.runId
              ? `run ${reabandoned.runId} is this generation's own reservation that never started and still holds the thread's row: its abandon did not reach the ledger${reabandoned.failed !== undefined ? ` (${reabandoned.failed})` : ""}`
              : `the thread's live row belongs to run ${result.live.runId} (started ${new Date(result.live.startedAt).toISOString()}), whose finish is not in flight in this process — reclaim is the resume phase's`;
        warn(`[ledger] ${req.threadKey} not tracked: ${why}`);
        return { outcome: "untracked", why, refused: "thread-live" };
      } catch (err) {
        if (
          allocationBearing &&
          (claimAccepted ||
            (claimEntered &&
              (err instanceof UncertainStoreError || !(err instanceof PermanentStoreError)) &&
              !(err instanceof RouteMissingError)))
        )
          throw new UnknownAllocationClaimError(err);
        if (err instanceof RouteMissingError) {
          routeMissing();
          return { outcome: "untracked", why: "the state Worker has no run-ledger routes" };
        }
        if (err instanceof PermanentStoreError || attempt >= claimAttempts) {
          const why = `the claim failed after ${attempt} attempt(s): ${describe(err)}`;
          warn(`[ledger] ${req.threadKey} not tracked: ${why}`);
          return { outcome: "untracked", why };
        }
        await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length) - 1]);
      }
    }
  }

  /** The per-run state machine behind `LedgerRun`. */
  class TrackedRun implements LedgerRun {
    private readonly originalReservation?: ReserveRunRequest;
    validatePromotion(req: OpenRunRequest): WorkspaceAllocationAck | undefined {
      const original = this.originalReservation;
      const held = (): never => {
        throw new PromotionIdentityRefusal();
      };
      if (
        !original ||
        req.runId !== original.runId ||
        req.threadKey !== original.threadKey ||
        req.startedAt !== original.startedAt
      )
        held();
      const actor = [
        "userId",
        "channelId",
        "threadKey",
        "authenticatedAs",
        "postedBy",
        "agent",
        "parentRunId",
        "parentInstanceId",
        "coordinatorUnit",
        "idempotencyKey",
        "maintenanceActionId",
      ] as const;
      const target = ["repo", "ref", "pr"] as const;
      const ack = this.allocationAck;
      const originalTarget = original!.meta.operationTarget as OperationTarget | undefined;
      const promotedTarget = req.meta.operationTarget as OperationTarget | undefined;
      if (
        actor.some((key) => original!.meta[key] !== req.meta[key]) ||
        target.some((key) => original!.meta[key] !== undefined && original!.meta[key] !== req.meta[key]) ||
        (ack?.allocation?.headSha !== undefined && original!.meta.headSha !== req.meta.headSha) ||
        (originalTarget &&
          (originalTarget.repo !== promotedTarget?.repo ||
            originalTarget.ref !== promotedTarget?.ref ||
            originalTarget.prTarget?.number !== promotedTarget?.prTarget?.number)) ||
        (original!.meta.profile &&
          (original!.meta.profile.identity !== req.meta.profile?.identity ||
            !Number.isFinite(req.meta.profile?.minutes) ||
            req.meta.profile!.minutes <= 0 ||
            req.meta.profile!.minutes > original!.meta.profile.minutes)) ||
        (original!.meta.readonly !== undefined && original!.meta.readonly !== req.meta.readonly)
      )
        held();
      if (!ack) return undefined;
      const validated = allocationAckOf(ack, { ...original!, gen });
      if (
        !validated ||
        (req.meta.workspaceAllocation !== undefined &&
          !sameWorkspaceAllocation(validated.allocation, req.meta.workspaceAllocation))
      )
        held();
      return validated;
    }
    private acknowledgedAllocation?: WorkspaceAllocationAck;
    get allocationAck(): WorkspaceAllocationAck | undefined {
      return this.acknowledgedAllocation && structuredClone(this.acknowledgedAllocation);
    }
    bindAllocationAck(ack: WorkspaceAllocationAck | undefined): void {
      this.acknowledgedAllocation = ack && structuredClone(ack);
    }
    readonly runId: string;
    private readonly threadKey: string;
    private readonly onStop?: (mode: StopMode) => void;
    private readonly onFenced?: () => void;
    private fencedTold = false;
    /** Detached BY A FENCE (another generation took the row), as opposed to a
     *  write that failed for good while the run stayed ours. */
    private fencedOut = false;
    private detached = false;
    private finished = false;
    private finishLanding: Landing | undefined;
    async waitForFinish(): Promise<LandingOutcome | { kind: "unstarted" }> {
      return this.finishLanding ? this.finishLanding.settled : { kind: "unstarted" };
    }
    private seeded = false;
    private seedSystem: string | undefined;
    private seedNotepad: string | undefined;
    private adopted = false;
    handedOff = false;
    /** The run's place in its session log (session-log item 2); undefined for
     *  a run without a conversation of its own and for an adopted row claimed
     *  before the log existed. */
    private sessionRow: RunSession | undefined;
    private childHandoff: LiveRunMeta["childHandoff"];
    get session(): RunSession | undefined {
      return this.sessionRow;
    }
    /** Every row at its log index (session-log item 2): the run's local index
     *  plus where its seed began; a run without a session writes its own
     *  object from 0. The one arithmetic the seed, every step and `logIndexOf`
     *  share. */
    private rowIndex(localIndex: number): number {
      return (this.sessionRow?.seedFrom ?? 0) + localIndex;
    }
    logIndexOf(localIndex: number): number | undefined {
      return this.sessionRow ? this.rowIndex(localIndex) : undefined;
    }
    /** Turns of the run's conversation on the ledger, counted from its seed —
     *  the last step record's `turnIndex` — so the finish can close the range. */
    private turnsWritten: number | undefined;
    /** A detach left the log short of what the model saw: the record says `broken`. */
    private broken = false;
    private checkpointFailure: SessionCheckpointFailure | undefined;
    private stateWriteFailure: "state-permanent" | "state-route-missing" | "state-unknown" | undefined;
    private pendingBoundaries: Array<{
      failure: WriteBoundaryFailure;
      request: StoreRequestWitness;
      expected: unknown;
    }> = [];
    get writeBoundaryFailure(): WriteBoundaryFailure | undefined {
      const pending = this.pendingBoundaries[0];
      return pending && { ...pending.failure };
    }
    private async reconcilePendingBoundary(): Promise<boolean> {
      try {
        for (const pending of [...this.pendingBoundaries]) {
          const observed = await ledger.peekInbox(this.runId, gen, 0);
          if (!this.pendingBoundaries.includes(pending)) continue;
          if (!observed.ok) return false;
          const value = pending.failure.kind === "step" ? observed.boundary.lastStep : observed.boundary.state;
          if (value === undefined || value === null || (await sourceHash(value)) !== pending.failure.expectedDigest)
            return false;
          // Another reconciliation may have resolved this object, or an
          // already-started mutation may have added a different obligation.
          const index = this.pendingBoundaries.indexOf(pending);
          if (index < 0) continue;
          if (pending.failure.kind === "step") {
            const expected = pending.expected as StepRecord;
            this.turnsWritten = Math.max(this.turnsWritten ?? 0, expected.turnIndex);
          } else {
            this.acknowledgedStateVersion = Math.max(this.acknowledgedStateVersion, pending.failure.stateVersion);
          }
          this.pendingBoundaries.splice(index, 1);
        }
        if (this.pendingBoundaries.length > 0) return false;
        this.stateWriteFailure = undefined;
        this.checkpointFailure = undefined;
        return true;
      } catch {
        return false;
      }
    }
    get lastCheckpointFailure(): SessionCheckpointFailure | undefined {
      return this.checkpointFailure;
    }
    private stepNo: number;
    /** The row is a hosted ship parent's (record 0060): `meta.hosted` at the claim. */
    private readonly hosted: boolean;
    private lastSeq: number;
    private state: RunState;
    private stateSending: Promise<void> = Promise.resolve();
    private stepSending: Promise<void> = Promise.resolve();
    private stateDirty = false;
    private stateVersion = 0;
    private acknowledgedStateVersion = 0;
    private stopRelayed: StopMode | undefined;
    private heartbeat: { unref?(): void } | undefined;
    private readonly flusher = createAppendFlusher<AppendableEvent>({
      flushMs: opts.flushMs ?? APPEND_FLUSH_MS,
      maxEvents: opts.flushEvents ?? APPEND_FLUSH_EVENTS,
      send: async (batch) => {
        if (this.detached) return;
        const result = await ledger.append(this.runId, gen, batch);
        if (!result.ok && !this.finished) this.detach(`append refused (${result.reason})`, result.reason === "fenced");
      },
      onError: (err, batch) => {
        if (!this.finished) warn(`[ledger] ${this.threadKey} ${batch.length} event(s) not appended: ${err.message}`);
      },
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
    });

    /** The heartbeat body's raw material (record 0064): assembled from what
     *  this write-through already sees — the step reports, the event stream and
     *  the run's meta. Every stamp is one it was handed, never a clock read. */
    private readonly coding: boolean;
    private readonly runStartedAt: number;
    private factRound = 0;
    private factInFlight: HeartbeatFacts["inFlight"];
    private factLastEventAt: number | undefined;
    private factPushedHead: HeartbeatFacts["pushedHead"];
    /** Each in-flight call's dispatch stamp, from its `tool_call` event's `at`
     *  — pruned at every step write to the step's own calls, so it never grows. */
    private readonly factCallStarts = new Map<string, number>();

    constructor(
      req: Pick<OpenRunRequest, "runId" | "threadKey" | "state" | "onStop" | "onFenced"> & {
        meta?: LiveRunMeta;
        system?: string;
        startedAt?: number;
      },
      from: {
        stepNo: number;
        lastSeq: number;
        resumable?: boolean;
        session?: RunSession;
        durableTurns?: number;
        originalReservation?: ReserveRunRequest;
      } = {
        stepNo: 0,
        lastSeq: 0,
      },
    ) {
      this.originalReservation = from.originalReservation && {
        ...from.originalReservation,
        meta: structuredClone(from.originalReservation.meta),
        ...(from.originalReservation.card ? { card: structuredClone(from.originalReservation.card) } : {}),
      };
      this.seedSystem = req.system;
      this.hosted = req.meta?.hosted === true;
      this.coding = req.meta?.agent === "coding";
      this.runStartedAt = req.startedAt ?? 0;
      this.runId = req.runId;
      this.threadKey = req.threadKey;
      this.state = req.state ?? {};
      this.onStop = req.onStop;
      this.onFenced = req.onFenced;
      this.stepNo = from.stepNo;
      // An adopted run's next heartbeat says the round it is on, not round zero.
      this.factRound = from.stepNo;
      this.lastSeq = from.lastSeq;
      this.adopted = from.resumable === true;
      this.sessionRow = from.session;
      this.childHandoff = req.meta?.childHandoff;
      const checkpoint = this.state.contextCheckpoint as { key?: unknown; through?: unknown } | undefined;
      if (
        this.adopted &&
        this.sessionRow &&
        this.sessionRow.range !== "broken" &&
        checkpoint?.key === this.sessionRow.key &&
        Number.isSafeInteger(checkpoint.through) &&
        (checkpoint.through as number) >= this.sessionRow.seedFrom - 1
      ) {
        // This cursor was saved only after source rows landed. A shared log's
        // current tail may include another producer and is never a substitute.
        this.turnsWritten = (checkpoint.through as number) - this.sessionRow.seedFrom + 1;
      }
      if (
        this.adopted &&
        this.sessionRow !== undefined &&
        this.sessionRow.range !== "broken" &&
        typeof from.durableTurns === "number" &&
        Number.isSafeInteger(from.durableTurns) &&
        from.durableTurns >= 0
      ) {
        // Boot checked every transcript row against the last step. A stale
        // state cursor cannot hide later durable turns, and one ahead of the
        // verified transcript is not safe to publish from.
        if (this.turnsWritten !== undefined && this.turnsWritten > from.durableTurns) this.broken = true;
        else this.turnsWritten = from.durableTurns;
      }
    }

    /** A reservation learns its session when the prompt's claim promotes it. */
    bindSession(session: RunSession): void {
      this.sessionRow = session;
    }

    bindSeedSystem(system: string): void {
      this.seedSystem = system;
    }

    bindHandoff(handoff: LiveRunMeta["childHandoff"]): void {
      if (handoff !== undefined) this.childHandoff = handoff;
    }

    /** The state the promoting claim already wrote to the row, folded into this
     *  run's own so later patches merge into it rather than replace it. */
    adoptState(state: RunState): void {
      this.state = { ...this.state, ...state };
    }

    get resumable(): boolean {
      // A hosted ship parent has no seed — no process runs it here — but the
      // next generation re-hosts its row (record 0060), so it hands off too.
      return !this.detached && (this.seeded || this.adopted || this.hosted);
    }

    markHandedOff(): void {
      this.handedOff = true;
    }

    pauseStopped = false;
    pauseRetained = false;

    async pauseForRetry(): Promise<boolean> {
      if (!this.resumable || !this.tracked() || this.handedOff || this.finished || this.finishLanding) return false;
      try {
        await Promise.all([this.stateSending, this.stepSending]);
        await this.flusher.flush();
        if (!(await this.reconcilePendingBoundary())) return false;
        const { marked } = await ledger.handoff(gen, [this.runId], { pausedForRetry: true });
        if (!marked.includes(this.runId)) {
          // A completed handoff that did not mark this row refused its owner.
          // Storage failure throws instead; only a refusal silences this owner.
          this.detach("pause handoff refused (fenced)", true);
          return false;
        }
        this.markHandedOff();
        this.stopHeartbeat();
        live.delete(this);
        // A hard stop may have landed just before the handoff. Its caller
        // checked before this marker existed; this side closes the same row.
        try {
          this.pauseStopped = (await sealPausedHardStop(ledger, this.runId, gen, now)) === "sealed";
        } catch (err) {
          warn(`[ledger] ${this.threadKey} could not check stop for paused run ${this.runId}: ${describe(err)}`);
        }
        try {
          const row = (await ledger.listLive()).find((r) => r.runId === this.runId);
          this.pauseRetained = row?.ownerGen === gen && row.phase === "handoff" && row.state.pausedForRetry === true;
        } catch (err) {
          warn(`[ledger] ${this.threadKey} could not confirm paused run ${this.runId}: ${describe(err)}`);
        }
        return true;
      } catch (err) {
        warn(`[ledger] ${this.threadKey} could not pause run ${this.runId} for retry: ${describe(err)}`);
        return this.handedOff;
      }
    }

    /** The run's range as the finished record carries it (session-log item 2):
     *  closed at the last turn written, or `broken` after a detach — the log
     *  ends short of what the model saw, and the next run in the session must
     *  know. A run that wrote no turn leaves the range open. */
    private sessionOnRecord(): RunSession | undefined {
      if (!this.sessionRow) return undefined;
      if (this.broken) return { ...this.sessionRow, range: "broken" };
      const from = this.sessionRow.range === "broken" ? this.sessionRow.seedFrom : this.sessionRow.range.from;
      const to =
        this.turnsWritten !== undefined && this.turnsWritten > 0
          ? this.sessionRow.seedFrom + this.turnsWritten - 1
          : undefined;
      return { ...this.sessionRow, range: to !== undefined && to >= from ? { from, to } : { from } };
    }

    readonly sink: RecordSink = {
      put: async (plain) => {
        // Named in `landing` from the first attempt to the outcome, so a claim
        // meeting this run's row can await it and say why the row stood (item
        // 54). A failure here settles nothing: the caller decides whether it
        // tries again (the history writer's ladder) or is done — and says so
        // with `abandoned`, which is the one word that settles a failed finish.
        const entry = (this.finishLanding ??= landingFor(this.runId));
        if (entry.unknown.length > 0)
          throw new TerminalCommitmentUnknownError(entry.unknown[0].hold, entry.unknown[0].request);
        await Promise.all([this.stateSending, this.stepSending]);
        if (!(await this.reconcilePendingBoundary())) {
          for (const pending of this.pendingBoundaries)
            this.retainTerminalUnknown(entry, JSON.stringify(plain), pending.request);
          if (entry.unknown.length > 0)
            throw new TerminalCommitmentUnknownError(entry.unknown[0].hold, entry.unknown[0].request);
        }
        this.finished = true; // no event or state write after this point
        live.delete(this);
        entry.record = JSON.stringify(plain);
        try {
          const { value, outcome } = await this.land(plain);
          settleLanding(this.runId, entry, outcome);
          return value;
        } catch (err) {
          if (!(err instanceof UncertainStoreError)) throw err;
          const hold = this.retainTerminalUnknown(entry, entry.record, err.request);
          throw new TerminalCommitmentUnknownError(hold, err.request);
        }
      },
      abandoned: (record, why) => {
        if (record.id !== this.runId) return;
        const entry = this.finishLanding;
        if (entry !== undefined) settleLanding(this.runId, entry, { kind: "failed", why });
      },
      uncertain: (record, request) => {
        if (record.id !== this.runId) return;
        const entry = (this.finishLanding ??= landingFor(this.runId));
        this.retainTerminalUnknown(entry, JSON.stringify(record), request);
      },
    };

    private retainTerminalUnknown(
      entry: Landing,
      record: string,
      request: StoreRequestWitness,
    ): TerminalCommitmentHold {
      const existing = entry.unknown.find((pending) => pending.request.digest === request.digest);
      if (existing) return existing.hold;
      const hold: TerminalCommitmentHold = Object.freeze({
        version: 1,
        runId: this.runId,
        gen,
        threadKey: this.threadKey,
        requestDigest: request.digest,
      });
      entry.unknown.push({ record, request, hold });
      settleLanding(this.runId, entry, { kind: "unknown", requestDigest: request.digest });
      return hold;
    }

    /** The finish itself: the flush, then the ledger's one-transaction `finish`,
     *  else the plain store — and which of the two took the record. */
    private async land(plain: RunRecord): Promise<{ value: unknown; outcome: LandingOutcome }> {
      await this.close();
      const session = this.sessionOnRecord();
      // Row ingestion can taint dependencies independently of a source write.
      // Archive the final store envelope before finish removes the live owner.
      if (session && this.state.contextDependencies !== undefined) {
        try {
          const latest = await ledger.readSessionTail(session.key, 1);
          this.state.contextDependencies = mergeContextDependencies(
            this.state.contextDependencies as ContextDependencies,
            contextDependenciesOf(latest.sources),
          );
        } catch {
          this.state.contextDependencies = mergeContextDependencies(
            this.state.contextDependencies as ContextDependencies,
            contextDependenciesOf(undefined),
          );
        }
      }
      const record = {
        ...plain,
        ...(session ? { session } : {}),
        ...(this.childHandoff ? { childHandoff: this.childHandoff } : {}),
        ...(this.state.contextCheckpointReceipt !== undefined
          ? {
              contextCheckpointReceipt: structuredClone(
                this.state.contextCheckpointReceipt,
              ) as RunRecord["contextCheckpointReceipt"],
            }
          : {}),
        ...(this.state.sourceReads !== undefined
          ? { sourceReads: structuredClone(this.state.sourceReads) as SourceReadState }
          : {}),
        ...(this.state.workReads !== undefined
          ? { workReads: structuredClone(this.state.workReads) as RunRecord["workReads"] }
          : {}),
        ...(this.state.unitSeedReceipt !== undefined
          ? { unitSeedReceipt: structuredClone(this.state.unitSeedReceipt) as RunRecord["unitSeedReceipt"] }
          : {}),
        ...(this.state.contextDependencies !== undefined
          ? { contextDependencies: structuredClone(this.state.contextDependencies) as ContextDependencies }
          : {}),
      };
      if (this.finishLanding) this.finishLanding.record = JSON.stringify(record);
      let result: Awaited<ReturnType<RunLedger["finish"]>>;
      try {
        result = await ledger.finish(this.runId, gen, record);
      } catch (err) {
        if (!(err instanceof RouteMissingError)) throw err; // transient: the writer retries this sink
        routeMissing();
        return { value: await fallback.put(record), outcome: { kind: "refused" } };
      }
      if (result.ok) return { value: result, outcome: { kind: "landed" } };
      warn(`[ledger] ${this.threadKey} finish refused (${result.reason}) — record written to the store directly`);
      return { value: await fallback.put(record), outcome: { kind: "refused" } };
    }

    tracked(): boolean {
      return !this.detached;
    }

    /** One warning, then silence: the run continues untracked. */
    detach(reason: string, ownershipLost = false): void {
      if (this.detached) return;
      this.detached = true;
      this.broken = true; // the log ends short of what the model saw from here on
      warn(`[ledger] ${this.threadKey} run ${this.runId} detached: ${reason} — this run is not resumable`);
      this.stopHeartbeat();
      live.delete(this);
      // A fence means another generation owns the run now (it reclaimed the
      // row): this process must stop driving it, and must not reply (D9) —
      // `finishing()` answers `fenced` from here on, not `unavailable`.
      if (ownershipLost) {
        this.fencedOut = true;
        if (this.onFenced && !this.fencedTold) {
          this.fencedTold = true;
          this.onFenced();
        }
      }
    }

    async writeSources(sources: SessionSources): Promise<boolean> {
      if (this.detached || !this.sessionRow) return false;
      try {
        const receipt = this.state.contextCheckpointReceipt;
        if (isContextCheckpointReceipt(receipt)) {
          sources = { ...sources, context: applyContextCheckpoint(contextDependenciesOf(sources), receipt) };
        }
        const before = await ledger.readSessionTail(this.sessionRow.key, 1);
        const merged = mergeSessionSources(before.sources, sources, before.from === 0 && before.transcript.turns === 0);
        if (!(await ledger.writeSessionSources(this.sessionRow.key, this.runId, gen, merged)).ok) return false;
        const saved = await ledger.readSessionTail(this.sessionRow.key, 1);
        return await this.setStateAndFlush({ contextDependencies: contextDependenciesOf(saved.sources) });
      } catch {
        return false;
      }
    }

    async recordSourceResult(receipt: SourceResultReceipt): Promise<boolean> {
      if (!isSourceResultReceipt(receipt) || receipt.runId !== this.runId || !this.tracked()) return false;
      const previous = Array.isArray(this.state.sourceResults)
        ? this.state.sourceResults.filter(isSourceResultReceipt)
        : [];
      const same = previous.find((item) => item.callId === receipt.callId);
      if (same)
        return (
          JSON.stringify(same) === JSON.stringify(receipt) && (await this.setStateAndFlush({ sourceResults: previous }))
        );
      if (previous.length >= 256) return false;
      return this.setStateAndFlush({ sourceResults: [...previous, structuredClone(receipt)] });
    }

    async checkpointSession(): Promise<{ key: string; through: number } | undefined> {
      const unavailable = (reason: SessionCheckpointFailure): undefined => {
        this.checkpointFailure = reason;
        warn(`[ledger] ${this.threadKey} run ${this.runId} context checkpoint unavailable (${reason})`);
        return undefined;
      };
      if (this.detached) return unavailable("detached");
      if (this.finished) return unavailable("finished");
      if (!this.seeded && !this.adopted) return unavailable("unseeded");
      if (!this.sessionRow) return unavailable("session-missing");
      if (this.sessionRow.range === "broken" || this.broken) return unavailable("session-broken");
      if (this.turnsWritten === undefined) return unavailable("cursor-missing");
      const checkpoint = { key: this.sessionRow.key, through: this.sessionRow.seedFrom + this.turnsWritten - 1 };
      const saved = await this.commitState({ contextCheckpoint: checkpoint });
      if (saved !== "ok")
        return unavailable(
          saved === "fenced"
            ? "state-fenced"
            : this.detached
              ? "detached"
              : (this.stateWriteFailure ?? "state-unavailable"),
        );
      this.checkpointFailure = undefined;
      return checkpoint;
    }

    async normalizeContextOrigins(): Promise<ContextCheckpointResult> {
      const unavailable: ContextCheckpointResult = { ok: false, reason: "checkpoint-unavailable" };
      if (this.detached || this.finished) return unavailable;
      const committed = this.state.contextCheckpointReceipt;
      if (isContextCheckpointReceipt(committed)) return { ok: true, receipt: structuredClone(committed) };
      if (
        !this.seeded ||
        this.adopted ||
        this.stepNo !== 0 ||
        this.seedSystem === undefined ||
        !this.sessionRow ||
        this.sessionRow.range === "broken" ||
        this.broken ||
        this.turnsWritten === undefined ||
        !isContextDependencies(this.state.contextDependencies) ||
        this.state.contextDependencies.status !== "known"
      )
        return unavailable;
      try {
        const checkpoint = await this.checkpointSession();
        if (!checkpoint) return unavailable;
        const through = checkpoint.through;
        const transcript = await ledger.readSession(this.sessionRow.key, this.sessionRow.seedFrom, through);
        if (!transcript.complete || transcript.turns !== this.turnsWritten) return unavailable;
        const before = structuredClone(this.state.contextDependencies);
        const result = await ledger.normalizeContextOrigins({
          key: this.sessionRow.key,
          runId: this.runId,
          gen,
          expected: {
            beforeHash: await contextDependenciesHash(before),
            revision: before.revision,
            inputs: {
              transcriptHash: await sourceHash(transcript),
              systemHash: await sourceHash(this.seedSystem),
              notepadHash: await sourceHash(this.seedNotepad ?? ""),
            },
          },
        });
        if (result.ok) {
          if (
            !isContextCheckpointReceipt(result.receipt) ||
            result.receipt.runId !== this.runId ||
            result.receipt.ownerGen !== gen ||
            result.receipt.beforeHash !== (await contextDependenciesHash(before))
          )
            return unavailable;
          // The store committed both the receipt and source metadata before ACK.
          // Copy that state directly; a union would reintroduce covered origins.
          this.state = {
            ...this.state,
            contextDependencies: structuredClone(result.receipt.normalized),
            contextCheckpointReceipt: structuredClone(result.receipt),
          };
        }
        return result;
      } catch {
        return unavailable;
      }
    }

    assertOriginalPromotionActive(): void {
      if (this.finished || this.detached || this.fencedOut || this.stopRelayed === "hard")
        throw new PromotionPendingError(this.runId);
    }
    async seedOriginal(
      req: OpenRunRequest,
      session: RunSession,
      notes: string,
      sources: SessionSources,
    ): Promise<void> {
      this.assertOriginalPromotionActive();
      const seed = req.seed!;
      const savedSources = await ledger.writeSessionSources(session.key, this.runId, gen, sources);
      if (!savedSources.ok) throw new PromotionPendingError(this.runId);
      this.assertOriginalPromotionActive();
      if (session.range !== "broken" && session.range.from === 0 && !(await ledger.readNotepad(session.key))) {
        const savedNotes = await ledger.writeNotepad(session.key, gen, notes, this.runId);
        if (!savedNotes.ok) throw new PromotionPendingError(this.runId);
      }
      this.assertOriginalPromotionActive();
      const reused = session.range !== "broken" ? session.range.from - session.seedFrom : 0;
      const turns = seed.messages.slice(reused).map((message, i) => ({
        idx: session.seedFrom + reused + i,
        message,
        ...(seed.actors?.[reused + i] !== undefined ? { actor: seed.actors[reused + i] } : {}),
      }));
      const saved = await ledger.seed(this.runId, gen, turns, session.key);
      if (!saved.ok) throw new PromotionPendingError(this.runId);
      this.assertOriginalPromotionActive();
      const recorded = await ledger.step(
        this.runId,
        gen,
        {
          step: 0,
          seq: this.lastSeq,
          turnIndex: seed.messages.length,
          inFlight: [],
          inboxConsumedSeq: 0,
          remainingMs: seed.budgetMs,
          turn: 0,
          iteration: 0,
        },
        [],
        session.key,
      );
      if (!recorded.ok) throw new PromotionPendingError(this.runId);
    }
    adoptConfirmedOriginal(
      req: OpenRunRequest,
      session: RunSession,
      notes: string,
      context: ContextDependencies,
    ): void {
      this.assertOriginalPromotionActive();
      this.bindSession(session);
      this.bindHandoff(req.meta.childHandoff);
      this.bindSeedSystem(req.system);
      this.seedNotepad = notes;
      this.turnsWritten = req.seed!.messages.length;
      this.seeded = true;
      this.adoptState({ ...req.state, contextDependencies: context });
    }
    /** The seed, then the seed record: step 0 with no calls in flight and
     *  `turnIndex` = the seed's length, so a reclaim always has a step record
     *  to judge the transcript against (`transcriptCompleteness`) — a row with
     *  no record at all was killed before its conversation was stored and
     *  closes `interrupted`. */
    async seed(
      messages: ChatMessage[],
      budgetMs: number,
      actors?: readonly (string | undefined)[],
      notepad?: string,
      sources?: SessionSources,
    ): Promise<void> {
      this.seedNotepad = notepad;
      if (sources !== undefined && !(await this.writeSources(sources))) {
        this.detach("seed source dependencies could not be persisted");
        return;
      }
      // Every row at its log index (`rowIndex`). The messages the seed reused
      // from the log (item 9) — the rows between `seedFrom` and the range's
      // start — are there already and are skipped.
      const reused =
        this.sessionRow && this.sessionRow.range !== "broken"
          ? this.sessionRow.range.from - this.sessionRow.seedFrom
          : 0;
      const turns: TranscriptTurn[] = messages.slice(reused).map((message, i) => ({
        idx: this.rowIndex(reused + i),
        message,
        ...(actors?.[reused + i] !== undefined ? { actor: actors[reused + i] } : {}),
      }));
      try {
        if (
          notepad !== undefined &&
          this.sessionRow?.range !== "broken" &&
          this.sessionRow?.range.from === 0 &&
          !(await ledger.readNotepad(this.sessionRow.key))
        ) {
          const saved = await ledger.writeNotepad(this.sessionRow.key, gen, notepad, this.runId);
          if (!saved.ok) {
            this.detach(`seed notepad refused (${saved.reason})`, saved.reason === "fenced");
            return;
          }
        }
        const seeded = await ledger.seed(this.runId, gen, turns, this.sessionRow?.key);
        if (!seeded.ok) {
          this.detach(`seed refused (${seeded.reason})`, seeded.reason === "fenced");
          return;
        }
        this.turnsWritten = messages.length;
        // The record's write names the log too: a run with a session owns no
        // object of its own, so a write that names none is refused.
        const recorded = await ledger.step(
          this.runId,
          gen,
          {
            step: 0,
            seq: this.lastSeq,
            turnIndex: messages.length,
            inFlight: [],
            inboxConsumedSeq: 0,
            remainingMs: budgetMs,
            turn: 0,
            iteration: 0,
          },
          [],
          this.sessionRow?.key,
        );
        if (!recorded.ok) this.detach(`seed record refused (${recorded.reason})`, recorded.reason === "fenced");
        else this.seeded = true;
      } catch (err) {
        this.detach(`seed failed: ${describe(err)}`);
      }
    }

    step(report: StepReport): Promise<void> {
      if (this.finished || this.finishLanding) return Promise.resolve();
      const sending = this.sendStep(report);
      this.stepSending = Promise.allSettled([this.stepSending, sending]).then(() => {});
      return sending;
    }

    private async sendStep(report: StepReport): Promise<void> {
      if (this.detached) return;
      if (!(await this.reconcilePendingBoundary())) return;
      report = structuredClone(report);
      // Every row at its log index (`rowIndex`). A compaction entry rides as
      // the row after the step's turns and counts as a turn, so the
      // completeness rule sees one index per row.
      const turns: TranscriptTurn[] = await Promise.all(
        report.turns.map(async (message, i) => ({
          idx: this.rowIndex(report.firstIdx + i),
          message: await withSourceResults(message, this.state.sourceResults),
        })),
      );
      if (report.compaction)
        turns.push({ idx: this.rowIndex(report.firstIdx + report.turns.length), compaction: report.compaction });
      const record: StepRecord = {
        step: ++this.stepNo,
        seq: this.lastSeq,
        turnIndex: report.firstIdx + turns.length,
        inFlight: report.inFlight,
        inboxConsumedSeq: report.inboxConsumedSeq,
        ...(report.inboxDeferredSeqs?.length ? { inboxDeferredSeqs: report.inboxDeferredSeqs } : {}),
        remainingMs: report.remainingMs,
        turn: report.turn,
        iteration: report.iteration,
      };
      const expected = structuredClone(record);
      const expectedDigest = await sourceHash(expected);
      // The heartbeat body's step facts (record 0064): the round is the step
      // counter, and the call in flight is stamped from the stream's last move
      // — the step report lands as the assistant turn does, before the tools run.
      this.factRound = record.step;
      const kept = new Set(record.inFlight.map((c) => c.callId));
      for (const id of this.factCallStarts.keys()) if (!kept.has(id)) this.factCallStarts.delete(id);
      const call = record.inFlight[0];
      this.factInFlight = call
        ? {
            callId: call.callId,
            tool: call.tool,
            // The call's own dispatch stamp when its `tool_call` event already
            // landed; the stream's last move as a floor until it does (the
            // event corrects it below) — never a clock read.
            sinceAt: this.factCallStarts.get(call.callId) ?? this.factLastEventAt ?? this.runStartedAt,
            ...(call.boundMs !== undefined ? { boundMs: call.boundMs } : {}),
          }
        : undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await ledger.step(this.runId, gen, record, turns, this.sessionRow?.key);
          if (!result.ok) this.detach(`step ${record.step} refused (${result.reason})`, result.reason === "fenced");
          else this.turnsWritten = record.turnIndex;
          return;
        } catch (err) {
          if (err instanceof UncertainStoreError) {
            this.pendingBoundaries.push({
              failure: {
                version: 1,
                kind: "step",
                runId: this.runId,
                gen,
                step: expected.step,
                requestDigest: err.request.digest,
                expectedDigest,
              },
              request: err.request,
              expected,
            });
            this.checkpointFailure = "state-unavailable";
            warn(`[ledger] ${this.threadKey} step ${record.step} commitment is unknown — original boundary retained`);
            return;
          }
          if (err instanceof RouteMissingError || err instanceof PermanentStoreError || attempt >= 2) {
            this.detach(`step ${record.step} failed: ${describe(err)}`);
            return;
          }
          await sleep(RETRY_MS[0]); // a blip a microsecond later is still a blip
        }
      }
    }

    event(event: RunEvent, seq: number): void {
      if (this.detached || this.finished || seq <= this.lastSeq) return;
      this.lastSeq = seq;
      // The heartbeat body's stream facts (record 0064): the last event's
      // time and the newest pushed head with its `clean` fact ride each beat.
      const e = event as { type?: string; at?: number; ref?: string; sha?: string; clean?: boolean; callId?: string };
      if (typeof e.at === "number") this.factLastEventAt = e.at;
      // The in-flight fact tracks the call itself (record 0064): its dispatch
      // stamps `sinceAt`, and its result clears it — a call that finished must
      // never read as still running past its bound.
      if (e.type === "tool_call" && typeof e.callId === "string" && typeof e.at === "number") {
        this.factCallStarts.set(e.callId, e.at);
        if (this.factInFlight?.callId === e.callId) this.factInFlight = { ...this.factInFlight, sinceAt: e.at };
      }
      if (e.type === "tool_result" && typeof e.callId === "string") {
        this.factCallStarts.delete(e.callId);
        if (this.factInFlight?.callId === e.callId) this.factInFlight = undefined;
      }
      if (e.type === "pushed_head" && typeof e.ref === "string" && typeof e.sha === "string")
        this.factPushedHead = {
          ref: e.ref,
          sha: e.sha,
          at: e.at ?? this.factLastEventAt ?? this.runStartedAt,
          ...(e.clean !== undefined ? { clean: e.clean } : {}),
        };
      this.flusher.push({ ...event, seq });
    }

    async assignLiveState(assignment: LiveStateAssignRequest): Promise<LiveStateAssignResult> {
      if (this.detached || this.finished) return { ok: false, reason: "unknown-run" };
      if (this.finishLanding) return { ok: false, reason: "unavailable" };
      await this.flusher.flush();
      await Promise.all([this.stateSending, this.stepSending]);
      try {
        if (!(await this.reconcilePendingBoundary())) return { ok: false, reason: "unavailable" };
        const result = await ledger.assignLiveState(this.runId, gen, assignment);
        if (!result.ok) {
          if (result.reason === "fenced" || result.reason === "unknown-run")
            this.detach(`live state refused (${result.reason})`, result.reason === "fenced");
          return result;
        }
        this.state = {
          ...this.state,
          ...assignment.statePatch,
          liveState: result.liveState,
          liveStateSeq: result.liveStateSeq,
        };
        this.lastSeq = Math.max(this.lastSeq, result.liveStateSeq);
        return result;
      } catch (err) {
        warn(`[ledger] ${this.threadKey} live state not written: ${describe(err)}`);
        return { ok: false, reason: "unavailable" };
      }
    }

    setState(patch: RunState): void {
      if (this.detached || this.finished || this.finishLanding) return;
      this.state = { ...this.state, ...patch };
      this.stateDirty = true;
      this.stateVersion++;
      this.stateSending = this.stateSending.then(() => this.sendState());
    }

    async setStateAndFlush(patch: RunState): Promise<boolean> {
      return (await this.commitState(patch)) === "ok";
    }

    async commitState(patch: RunState): Promise<FinishingGate> {
      if (this.fencedOut || this.finished) return "fenced";
      if (this.detached || this.finishLanding) return "unavailable";
      this.setState(patch);
      const requestedVersion = this.stateVersion;
      await this.stateSending;
      if (this.fencedOut || this.finished) return "fenced";
      // Later dirty patches cannot revoke this patch's acknowledged snapshot.
      return this.detached || this.acknowledgedStateVersion < requestedVersion ? "unavailable" : "ok";
    }

    /** The merged snapshot, sent once per burst of patches; a transient failure
     *  is retried once after a backoff and, failing that, leaves the state
     *  dirty so the next patch carries it — the LAST state of a run (a verdict
     *  set near the end) must not be lost to one blip. */
    private async sendState(): Promise<void> {
      if (!this.stateDirty || this.detached || this.finished) return;
      if (!(await this.reconcilePendingBoundary())) return;
      this.stateDirty = false;
      const snapshot = structuredClone(this.state);
      const version = this.stateVersion;
      const expectedDigest = await sourceHash(snapshot);
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await ledger.setState(this.runId, gen, snapshot);
          if (!result.ok) this.detach(`state refused (${result.reason})`, true);
          else {
            this.acknowledgedStateVersion = version;
            this.stateWriteFailure = undefined;
          }
          return;
        } catch (err) {
          if (err instanceof UncertainStoreError) {
            this.pendingBoundaries.push({
              failure: {
                version: 1,
                kind: "state",
                runId: this.runId,
                gen,
                stateVersion: version,
                requestDigest: err.request.digest,
                expectedDigest,
              },
              request: err.request,
              expected: snapshot,
            });
            this.stateDirty = true;
            this.stateWriteFailure = "state-unknown";
            this.checkpointFailure = "state-unavailable";
            warn(`[ledger] ${this.threadKey} state commitment is unknown — original snapshot retained`);
            return;
          }
          if (err instanceof RouteMissingError || err instanceof PermanentStoreError || attempt >= 2) {
            this.stateDirty = true;
            this.stateWriteFailure =
              err instanceof RouteMissingError
                ? "state-route-missing"
                : err instanceof PermanentStoreError
                  ? "state-permanent"
                  : err instanceof TransientStoreError
                    ? undefined
                    : "state-unknown";
            warn(`[ledger] ${this.threadKey} state not written: ${describe(err)}`);
            return;
          }
          await sleep(RETRY_MS[0]);
        }
      }
    }

    async finishing(): Promise<FinishingGate> {
      // Detached by a fence: the run is another generation's now — no reply, no
      // record from here (item 39), whatever the fenced write was. Detached for
      // any other reason: the run is still ours and replies as before.
      if (this.detached) return this.fencedOut ? "fenced" : "unavailable";
      try {
        const result = await ledger.finishing(this.runId, gen);
        if (result.ok) return "ok";
        // Refused: another generation took the row (`fenced`), or the row is
        // gone (`unknown-run` — the other generation already finished it).
        // Either way this process must not answer the thread.
        warn(
          `[ledger] ${this.threadKey} finishing refused (${result.reason}) — another generation owns this run; no reply from here`,
        );
        this.detach(`finishing refused (fenced)`, true);
        return "fenced";
      } catch (err) {
        warn(`[ledger] ${this.threadKey} finishing failed: ${describe(err)}`);
        return "unavailable";
      }
    }

    async abandon(): Promise<void> {
      if (this.detached || this.finished || this.finishLanding) return;
      await Promise.all([this.stateSending, this.stepSending]);
      if (!(await this.reconcilePendingBoundary())) return;
      this.finished = true; // nothing is written after this
      live.delete(this);
      await this.close();
      try {
        const result = await ledger.abandon(this.runId, gen);
        // `unknown-run` is silence: the row is already gone (a stale
        // reservation never had one of its own); `fenced` names a row another
        // generation drives now. Either way nothing of ours stands to abandon.
        unpromoted.delete(this.runId);
        if (!result.ok && result.reason === "fenced")
          warn(`[ledger] ${this.threadKey} abandon refused (fenced) — the row is another generation's`);
      } catch (err) {
        // The row may still stand as this generation's dead reservation: it stays
        // in `unpromoted`, and the next claim that meets it abandons it again
        // (item 54) — no dispatch ordering has to be right for that.
        warn(
          `[ledger] ${this.threadKey} abandon failed: ${describe(err)} — the next claim on the thread abandons the row again, or the sweep takes it once its lease lapses`,
        );
      }
    }

    startHeartbeat(): void {
      if (this.detached || this.heartbeat) return;
      this.heartbeat = startInterval(() => void this.beat(), heartbeatMs);
    }

    private async beat(): Promise<void> {
      if (this.detached || this.finished) return;
      try {
        // The heartbeat body (record 0064): only a coding run with a known
        // start is judged for the checkpoint steer — a hosted parent or an
        // adopted row without its start still extends its lease, facts-less.
        const facts: HeartbeatFacts | undefined =
          this.coding && this.runStartedAt > 0
            ? {
                round: this.factRound,
                coding: true,
                startedAt: this.runStartedAt,
                ...(this.factInFlight !== undefined ? { inFlight: this.factInFlight } : {}),
                ...(this.factLastEventAt !== undefined ? { lastEventAt: this.factLastEventAt } : {}),
                ...(this.factPushedHead !== undefined ? { pushedHead: this.factPushedHead } : {}),
              }
            : undefined;
        const result = await ledger.heartbeat(this.runId, gen, leaseMs, facts);
        if (!result.ok) {
          this.detach(`heartbeat refused (${result.reason})`, result.reason === "fenced");
          return;
        }
        if (result.stop && this.stopRelayed !== result.stop && this.onStop) {
          this.stopRelayed = result.stop;
          this.onStop(result.stop);
        }
        // The plane's effects (orchestration-plane; record 0064; orchestration-plane item 7):
        // an `admit` runs through the restart-from-request path and a `steer`
        // puts its already-durable row into the owning live inbox. A draining
        // generation defers both; a process without the wiring defers every
        // executable effect, and the offer stays for a bot that can run it.
        // Best-effort: a failed ack leaves the offer standing.
        for (const effect of result.effects ?? []) {
          try {
            const executor = opts.planeEffects;
            // A probe starts no run, so a drain never defers it (record 0064:
            // a draining generation defers `admit` and executes the rest); a
            // process without a probe seam skips it and the offer closes.
            // A move effect (record 0064's watches: retitle, pr_open,
            // rebase_round, reissue) has no executor seam in this generation
            // yet: it defers and stays offered, bounded and harmless, for a
            // bot that can execute it — never a claim it was done.
            let reconciliation: CoordinatorReconcileReceipt | undefined;
            let outcome: PlaneAckOutcome;
            if (effect.kind === "coordinator_reconcile") {
              const receipt =
                isCoordinatorReconcileEffect(effect) && executor?.reconcile !== undefined && !executor.draining()
                  ? await executor.reconcile(effect)
                  : undefined;
              if (isCoordinatorReconcileReceipt(receipt)) {
                reconciliation = receipt;
                outcome = "done";
              } else outcome = "deferred";
            } else {
              outcome =
                effect.kind === "probe"
                  ? executor?.probe === undefined
                    ? "skipped"
                    : await executor.probe(effect)
                  : effect.kind === "steer"
                    ? executor?.steer === undefined || executor.draining()
                      ? "deferred"
                      : await executor.steer(effect)
                    : effect.kind !== "admit"
                      ? "deferred"
                      : executor === undefined || executor.draining()
                        ? "deferred"
                        : await executor.admit(effect);
            }
            await ledger.planeAck(
              effect.id,
              outcome,
              effect.kind === "steer" ? { runId: effect.runId, gen } : undefined,
              reconciliation,
            );
          } catch (err) {
            warn(`[ledger] plane ack failed for effect ${effect.id}: ${describe(err)} — it stays offered`);
          }
        }
      } catch (err) {
        warn(`[ledger] ${this.threadKey} heartbeat failed: ${describe(err)}`);
      }
    }

    private stopHeartbeat(): void {
      if (!this.heartbeat) return;
      stopInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    async close(): Promise<void> {
      this.stopHeartbeat();
      await Promise.all([this.stateSending, this.stepSending]);
      await this.flusher.close();
    }
  }

  async function promoteOriginal(
    req: OpenRunRequest,
    reserved: TrackedRun,
    originalAck: WorkspaceAllocationAck,
  ): Promise<OpenOutcome> {
    const hold = (): never => {
      throw new PromotionPendingError(req.runId);
    };
    if (
      !req.seed ||
      !req.seed.messages.length ||
      !ledger.originalPromotionBody ||
      !ledger.observeExpectedSeed ||
      !ledger.preparePromotion ||
      !ledger.readPromotion ||
      !ledger.verifyExpectedSeed ||
      !ledger.readExpectedSeed ||
      !ledger.confirmPromotion ||
      !ledger.releaseExpectedSeed
    )
      return hold();
    const resolved = {
      runId: req.runId,
      threadKey: req.threadKey,
      startedAt: req.startedAt,
      system: req.system,
      card: structuredClone(req.card ?? null),
      tools: structuredClone(req.tools),
      meta: structuredClone(req.meta),
      state: structuredClone(req.state ?? {}),
      seed: structuredClone(req.seed),
    };
    const originalSeed = resolved.seed,
      meta = resolved.meta;
    let sources = seedSources(resolved) ?? {
      version: 1 as const,
      status: "unknown" as const,
      context: UNKNOWN_CONTEXT_DEPENDENCIES,
    };
    let context = sources.context;
    if (!context) return hold();
    const key = originalSeed.key ?? sessionKey(meta.threadKey, meta.agent);
    const tail = await ledger.sessionTail(key);
    reserved.assertOriginalPromotionActive();
    const reuse =
      originalSeed.log && originalSeed.log.from + originalSeed.log.turns === tail ? originalSeed.log : undefined;
    const from = reuse?.from ?? tail;
    const session: RunSession = {
      key,
      threadSession: contextThreadSessionKey(meta.threadKey),
      seedFrom: from,
      request: from + requestIndex(originalSeed.messages),
      range: { from: tail },
    };
    const snapshot = await ledger.observeExpectedSeed(key, from, from + originalSeed.messages.length - 1);
    reserved.assertOriginalPromotionActive();
    if (snapshot.next !== tail) return hold();
    sources = mergeSessionSources(snapshot.sources, sources, tail === 0);
    context = sources.context;
    if (!context) return hold();
    const existingNotes = await ledger.readNotepad(key);
    if (snapshot.notepad !== (existingNotes?.text ?? "")) return hold();
    const notes = existingNotes?.text ?? (tail === 0 ? (originalSeed.notepad ?? "") : "");
    const input = {
      ...resolved,
      meta,
      seed: { ...originalSeed, context, notepad: notes, ...(reuse ? { log: reuse } : { log: undefined }) },
      state: { ...resolved.state, contextDependencies: context },
    };
    const request = {
      runId: resolved.runId,
      threadKey: resolved.threadKey,
      gen,
      leaseMs,
      startedAt: resolved.startedAt,
      meta: { ...meta, session },
      card: resolved.card,
      system: resolved.system,
      tools: resolved.tools,
      state: input.state,
    };
    if (reuse && snapshot.rows.some((row) => row.trimmed !== 0 && row.trimmed !== false)) return hold();
    const bodyJson = ledger.originalPromotionBody(request);
    const built = await buildExpectedSeedManifest({
      bodyJson,
      open: input,
      observation: {
        key,
        next: tail,
        ...(reuse?.turns
          ? {
              reused: {
                key,
                from,
                through: tail - 1,
                next: tail,
                rows: snapshot.rows.filter((row) => row.idx < tail).map(({ idx, part, json }) => ({ idx, part, json })),
                attachments: snapshot.attachments,
                context: snapshot.context!,
                notepad: snapshot.notepad,
                ...(snapshot.owner ? { owner: snapshot.owner } : {}),
              },
            }
          : {}),
      },
    });
    if (built.kind !== "built") return hold();
    const reference: SourceSeedReference = {
      storeKey: JSON.parse(bodyJson).storeKey,
      runId: request.runId,
      gen,
      bodySha256: built.manifest.bodySha256,
      expectedSeedSha256: built.digest,
    };
    const read = () => ledger.readPromotion!({ runId: request.runId, gen, bodySha256: reference.bodySha256 });
    const exact = (value: Awaited<ReturnType<typeof read>>) =>
      value.kind !== "held" &&
      value.preparation.bodyJson === bodyJson &&
      value.preparation.receipt.expectedSeedSha256 === built.digest;
    try {
      const prepared = await ledger.preparePromotion(bodyJson, built.manifest);
      reserved.assertOriginalPromotionActive();
      if (prepared.kind === "held" && prepared.reason === "fenced") {
        reserved.detach("promotion refused (fenced)", true);
        unpromoted.delete(reserved.runId);
        return { kind: "fenced" };
      }
      if (
        prepared.kind !== "prepared" ||
        prepared.receipt.bodySha256 !== reference.bodySha256 ||
        prepared.receipt.expectedSeedSha256 !== built.digest
      ) {
        const actual = await read();
        if (!exact(actual) || actual.kind !== "prepared") return hold();
      }
      let result: Awaited<ReturnType<RunLedger["claim"]>> | undefined;
      try {
        result = await ledger.claim(request, bodyJson);
      } catch {
        const actual = await read();
        if (!exact(actual) || actual.kind !== "committed")
          throw new UnknownAllocationClaimError("the original claim remains unconfirmed");
        result = { ok: true, allocationAck: actual.allocationAck, promotionCommit: actual.receipt };
      }
      reserved.assertOriginalPromotionActive();
      if (!result.ok) {
        if (result.live.runId === req.runId) {
          reserved.detach("promotion refused (fenced)", true);
          unpromoted.delete(reserved.runId);
          return { kind: "fenced" };
        }
        throw new PromotionIdentityRefusal();
      }
      const actualCommit = await read();
      if (!exact(actualCommit) || actualCommit.kind !== "committed")
        throw new UnknownAllocationClaimError("the original claim remains unconfirmed");
      const ack = allocationAckOf(actualCommit.allocationAck, request);
      if (
        !ack ||
        (originalAck.allocation === null
          ? ack.allocation !== null
          : !sameWorkspaceAllocation(originalAck.allocation, ack.allocation))
      )
        throw new UnknownAllocationClaimError("the original allocation acknowledgment is unavailable");
      try {
        await ledger.claimSession(key, req.runId, gen);
      } catch {
        const actual = await ledger.observeExpectedSeed(key, from, built.manifest.through);
        if (actual.owner?.runId !== req.runId || actual.owner.gen !== gen)
          throw new UnknownAllocationClaimError("the original source owner is unconfirmed");
      }
      reserved.assertOriginalPromotionActive();
      let seedUnknown: unknown;
      try {
        await reserved.seedOriginal(input, session, notes, sources);
      } catch (error) {
        if (error instanceof PromotionPendingError) throw error;
        seedUnknown = error;
      }
      reserved.assertOriginalPromotionActive();
      let verified: Awaited<ReturnType<NonNullable<RunLedger["verifyExpectedSeed"]>>> = {
        kind: "held",
        reason: "unknown",
      };
      try {
        verified = await ledger.verifyExpectedSeed(key, reference);
      } catch {
        /* Reconcile the original, never repeat the mutation. */
      }
      const actualSource = await ledger.readExpectedSeed(key, reference);
      if (
        (verified.kind !== "verified" && actualSource.kind !== "verified") ||
        actualSource.kind !== "verified" ||
        actualSource.release ||
        !sourceSeedReferenceMatches(actualSource.receipt, reference, key)
      )
        throw new UnknownAllocationClaimError(seedUnknown ?? "the original source is unconfirmed");
      reserved.assertOriginalPromotionActive();
      try {
        await ledger.confirmPromotion(reference);
      } catch {
        /* Exact canonical read resolves a lost reply. */
      }
      const confirmed = await read();
      if (
        !exact(confirmed) ||
        confirmed.kind !== "confirmed" ||
        !sourceSeedReferenceMatches(confirmed.receipt.source, reference, key)
      )
        throw new UnknownAllocationClaimError("the original seed confirmation is unknown");
      reserved.assertOriginalPromotionActive();
      try {
        await ledger.releaseExpectedSeed(key, reference);
      } catch {
        /* Exact own release read resolves a lost reply. */
      }
      const released = await ledger.readExpectedSeed(key, reference);
      const current = await read();
      if (
        released.kind !== "verified" ||
        !released.release ||
        !sourceSeedReferenceMatches(released.receipt, reference, key) ||
        !exact(current) ||
        current.kind !== "confirmed" ||
        JSON.stringify(released.release.confirmation) !== JSON.stringify(current.receipt)
      )
        throw new UnknownAllocationClaimError("the original release remains unconfirmed");
      reserved.assertOriginalPromotionActive();
      reserved.bindAllocationAck(ack);
      reserved.adoptConfirmedOriginal(input, session, notes, context);
      unpromoted.delete(reserved.runId);
      return { kind: "tracked", run: reserved };
    } catch (error) {
      if (
        error instanceof PromotionPendingError ||
        error instanceof UnknownAllocationClaimError ||
        error instanceof PromotionIdentityRefusal
      )
        throw error;
      throw new UnknownAllocationClaimError(error);
    }
  }

  return {
    gen,
    sessionPersistence: true,
    async claimResident(runId, threadKey) {
      const result = await ledger.residentClaim(runId, gen, threadKey);
      if (!result.ok) throw new Error(`resident claim refused: ${result.reason}`);
      return result.fence;
    },
    async reserve(req) {
      req = { ...req, meta: structuredClone(req.meta) };
      const claimed = await claim({ ...req, system: "", tools: [], state: {} }, { phase: "attaching" });
      // Every untracked exit says why (item 54): the row a run this process
      // closed still stood, another run's row, no routes, a claim that kept
      // failing — for the run's own record, not the bot log alone.
      if (claimed.outcome === "fenced") return { kind: "fenced" };
      if (claimed.outcome === "held") return { kind: "held", hold: claimed.hold, error: claimed.error };
      if (claimed.outcome === "untracked")
        return { kind: "untracked", why: claimed.why, ...(claimed.refused ? { refused: claimed.refused } : {}) };
      if (
        req.meta.workspaceAllocation?.version === 2 &&
        (claimed.allocationAck?.allocation?.version !== 2 ||
          !sameWorkspaceAllocation(req.meta.workspaceAllocation, claimed.allocationAck.allocation))
      )
        throw new UnknownAllocationClaimError("original v2 allocation acknowledgment unavailable");
      const run = new TrackedRun(req, { stepNo: 0, lastSeq: 0, originalReservation: req });
      run.bindAllocationAck(claimed.allocationAck);
      run.startHeartbeat();
      live.add(run);
      unpromoted.add(req.runId);
      return {
        kind: "tracked",
        run,
        ...(claimed.allocationAck ? { allocationAck: structuredClone(claimed.allocationAck) } : {}),
      };
    },
    async open(req) {
      req = { ...req, meta: structuredClone(req.meta) };
      // `untracked`'s why for the caller: the machine word for a thread-live
      // refusal — what the ship branch refuses by name (record 0060) — the
      // record's sentence for every other reason.
      const untracked = (claimed: { why: string; refused?: "thread-live" }): OpenOutcome => ({
        kind: "untracked",
        why: claimed.refused ?? claimed.why,
      });
      const reserved = req.reservation;
      const seed = req.seed?.messages;
      if (reserved?.allocationAck && !(reserved instanceof TrackedRun))
        throw new RefusalError(
          refusalOf("setup_failed", "The original reservation belongs to another owner; its saved work remains held."),
        );
      if (reserved instanceof TrackedRun) {
        // The promotion (item 42): the claim the dispatcher always made, now
        // landing on the row reserved at admission — same tracked run, its
        // heartbeat already running. A row another generation took meanwhile
        // fences this run (it is theirs to restart). An ordinary run may
        // continue untracked after a failed claim; a coordinator child must
        // keep its acknowledged identity and fail setup instead.
        if (!reserved.tracked()) return { kind: "untracked", why: "the run's reservation is already untracked" };
        const originalAck = reserved.validatePromotion(req);
        if (originalAck?.allocation) req.meta.workspaceAllocation = structuredClone(originalAck.allocation);
        if (originalAck) {
          try {
            return await promoteOriginal(req, reserved, originalAck);
          } catch (error) {
            if (
              error instanceof PromotionPendingError ||
              error instanceof UnknownAllocationClaimError ||
              error instanceof PromotionIdentityRefusal
            )
              throw error;
            throw new UnknownAllocationClaimError(error);
          }
        }
        const claimed = await claim(req, {
          ...(seed ? { seed, key: req.seed?.key, ...(req.seed?.log ? { log: req.seed.log } : {}) } : {}),
          ...(originalAck ? { originalAck } : {}),
        });
        if (claimed.outcome === "held") return { kind: "held", hold: claimed.hold, error: claimed.error };
        if (claimed.outcome === "fenced") {
          unpromoted.delete(reserved.runId); // the row is another generation's: nothing of ours to abandon
          reserved.detach("promotion refused (fenced)", true);
          return { kind: "fenced" };
        }
        if (claimed.outcome !== "ok") {
          if (originalAck)
            throw new RefusalError(
              refusalOf("setup_failed", "The original reservation could not be promoted; its saved work remains held."),
            );
          // For an ordinary run, abandon — not close (close only stops the heartbeat,
          // leaving the attaching row on the ledger where the reclaim sweep
          // would see it as an expired reservation and restart the run, while
          // the untracked original is still running). Abandon removes the row
          // and owns the `unpromoted` bookkeeping: an abandon that fails keeps
          // the run there, so the thread's next claim abandons the row again
          // (item 54) — the safety net the pre-delete would have defeated.
          // A coordinator's acknowledged id must have no durable gap between
          // reservation and failure. Keep its row and heartbeat for the setup
          // finalizer (or reclaim if this process dies before it can finish).
          if (req.meta.parentInstanceId === undefined) await reserved.abandon();
          req.onUntracked?.(claimed.why);
          return untracked(claimed);
        }
        reserved.bindAllocationAck(claimed.allocationAck);
        unpromoted.delete(reserved.runId); // promoted: no longer a reservation to abandon
        if (claimed.session) reserved.bindSession(claimed.session);
        reserved.bindHandoff(req.meta.childHandoff);
        reserved.bindSeedSystem(req.system);
        // The claim wrote the dispatcher's state onto the row (the workspace
        // binding, item 54); the reserved run merges it into its own, so the
        // first patch after the claim carries it on instead of writing over it.
        if (req.state) reserved.adoptState(req.state);
        if (req.seed)
          await reserved.seed(
            req.seed.messages,
            req.seed.budgetMs,
            req.seed.actors,
            req.seed.notepad,
            seedSources(req),
          );
        return { kind: "tracked", run: reserved };
      }
      const claimed = await claim(
        req,
        seed ? { seed, key: req.seed?.key, ...(req.seed?.log ? { log: req.seed.log } : {}) } : {},
      );
      if (claimed.outcome === "held") return { kind: "held", hold: claimed.hold, error: claimed.error };
      if (claimed.outcome === "fenced") {
        warn(`[ledger] ${req.threadKey} not tracked: run ${req.runId} is live under another generation`);
        return { kind: "fenced" };
      }
      if (claimed.outcome !== "ok") return untracked(claimed);
      const run = new TrackedRun(req, {
        stepNo: 0,
        lastSeq: 0,
        ...(claimed.session ? { session: claimed.session } : {}),
      });
      run.bindAllocationAck(claimed.allocationAck);
      if (req.seed)
        await run.seed(req.seed.messages, req.seed.budgetMs, req.seed.actors, req.seed.notepad, seedSources(req));
      run.startHeartbeat();
      live.add(run);
      return { kind: "tracked", run };
    },
    adopt(req) {
      const run = new TrackedRun(req, {
        stepNo: req.lastStep,
        lastSeq: req.lastSeq,
        resumable: true,
        ...(req.session ? { session: req.session } : {}),
        ...(req.durableTurns !== undefined ? { durableTurns: req.durableTurns } : {}),
      });
      run.startHeartbeat();
      live.add(run);
      return run;
    },
    liveRuns: () => [...live],
    readLiveRuns: () => ledger.listLive(),
    readContextCheckpoint: (runId) => ledger.readContextCheckpoint(runId),
    async pushInbox(runId, message) {
      try {
        const result = await ledger.pushInbox(runId, message);
        if (result.ok && result.seq !== undefined) return result.seq;
        warn(`[ledger] inbox push refused for run ${runId}: no live row — the follow-up rides in memory only`);
        return undefined;
      } catch (err) {
        if (err instanceof UncertainStoreError) throw err;
        warn(`[ledger] inbox push failed for run ${runId}: ${describe(err)} — the follow-up rides in memory only`);
        return undefined;
      }
    },

    async readInbox(runId, afterSeq) {
      try {
        return await ledger.readInbox(runId, afterSeq);
      } catch (err) {
        warn(
          err instanceof RouteMissingError
            ? `[ledger] state Worker has no inbox read route — run ${runId} resumes with the reclaim's inbox snapshot only`
            : `[ledger] inbox read failed for run ${runId}: ${describe(err)} — resuming with the reclaim's snapshot only`,
        );
        return [];
      }
    },
    readSessionTail: (key, maxBytes) => ledger.readSessionTail(key, maxBytes),
    readSession: (key, from, to) => ledger.readSession(key, from, to),
    readSessionEntry: (key, rowId) => ledger.readSessionEntry(key, rowId),
    appendSession: (key, rowId, rows, context) => ledger.appendSession(key, rowId, rows, context),
    searchSession: (key, query, limit) => ledger.searchSession(key, query, limit),
    readRequesterTarget: (key, actor) => ledger.readRequesterTarget(key, actor),
    checkpointRequesterTarget: (key, actor, target) => ledger.checkpointRequesterTarget(key, actor, target),
    readNotepad: (key) => ledger.readNotepad(key),
    writeNotepad: (key, text, runId) => ledger.writeNotepad(key, gen, text, runId),

    async handoff() {
      const candidates = [...live].filter((r) => r.resumable && r.tracked() && !r.handedOff);
      if (candidates.length === 0) return { marked: [] };
      try {
        const { marked } = await ledger.handoff(
          gen,
          candidates.map((r) => r.runId),
        );
        const markedSet = new Set(marked);
        for (const r of candidates) if (markedSet.has(r.runId)) r.markHandedOff();
        return { marked };
      } catch (err) {
        return { marked: [], failed: describe(err) };
      }
    },

    async planeAdmit(post) {
      try {
        return await ledger.planeAdmit(post);
      } catch (err) {
        // The plane must never take the door down: an unreachable object or an
        // older state Worker without the route admits, as before the queue.
        warn(`[ledger] plane admit failed for ${post.threadKey}: ${describe(err)} — the ask proceeds`);
        return { kind: "admitted", reservation: "unasked" };
      }
    },
    async planeWithdraw(runId) {
      return ledger.planeWithdraw(runId);
    },
    async planeLevel(post) {
      try {
        await ledger.planeLevel(post);
      } catch (err) {
        const subject = "resident" in post ? post.resident : post.provider;
        warn(`[ledger] plane level post failed for ${subject}: ${describe(err)} — the plane reads it stale`);
      }
    },
    async planePark(runId, provider) {
      try {
        await ledger.planePark(runId, provider);
      } catch (err) {
        warn(
          `[ledger] plane park failed for run ${runId} on ${provider}: ${describe(err)} — the run runs on its lease`,
        );
      }
    },
    async planeObserve(post) {
      try {
        return await ledger.planeObserve(post);
      } catch (err) {
        warn(
          `[ledger] plane observation failed for run ${post.runId}: ${describe(err)} — the caller's fallback stands`,
        );
        return { reentered: false };
      }
    },
    planeOutcome(post) {
      void ledger.planeOutcome(post).catch((err: unknown) => {
        warn(
          `[ledger] plane outcome post failed for ${post.threadKey}: ${describe(err)} — shadow loses one comparison`,
        );
      });
    },

    async recordIntake(key, receipt) {
      const degraded = (why: string): undefined => {
        warn(`[ledger] intake receipt ${key} not recorded: ${why} — acting on the verdict without one`);
        return undefined;
      };
      try {
        return await ledger.recordIntake(key, receipt);
      } catch (err) {
        if (err instanceof RouteMissingError) return degraded("the state Worker has no intake routes");
        if (err instanceof PermanentStoreError && !(err instanceof UncertainStoreError)) return degraded(describe(err));
        // A lost response: the insert may have landed. Retry by reading the
        // same row after the claim's backoff — this write's own row (its gen
        // and decidedAt) answers inserted, another writer's answers what it
        // stored; none at all means the insert never landed, so insert once.
        try {
          await sleep(RETRY_MS[0]);
          const stored = await ledger.readIntake(key);
          if (stored !== undefined) {
            return {
              inserted: stored.gen === receipt.gen && stored.decidedAt === receipt.decidedAt,
              stored,
            };
          }
          return await ledger.recordIntake(key, receipt);
        } catch (retryErr) {
          return degraded(`${describe(err)}; the retry failed too: ${describe(retryErr)}`);
        }
      }
    },
  };
}
