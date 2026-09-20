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
import type { StepReport } from "./stepReport.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ToolDef } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import type { RunRecord, RunSession } from "../runRecord.js";
import type { RecordSink } from "../runHistoryWriter.js";
import type { AssembledTranscript } from "./transcript.js";
import type { FenceResult, Notepad, SessionHit } from "./types.js";
import { PermanentStoreError, RouteMissingError } from "../runStoreWorker.js";
import { createAppendFlusher } from "./flusher.js";
import type { HeartbeatFacts, RunLedger } from "./ledger.js";
import type { PlaneAckOutcome, PlaneAskAnswer, PlaneEffect, PlaneOutcomePost } from "../plane/decide.js";
import type { PlaneAdmitPost, PlaneLevelPost, PlaneObservePost } from "./ledger.js";
import { requestIndex, sessionKey } from "./sessionLog.js";
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
  type RunState,
  type StepRecord,
  type StopMode,
  type TranscriptTurn,
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
  leaseMs?: number;
  heartbeatMs?: number;
  flushMs?: number;
  flushEvents?: number;
  /** Attempts for the whole claim (the ledger's convention: retry the claim,
   *  never proceed past one that did not resolve `ok`). Default 3. */
  claimAttempts?: number;
  /** The plane's effect execution (record 0064, "The queue"): how an `admit`
   *  riding a heartbeat answer runs — absent (an older wiring, tests), every
   *  effect defers and stays offered. `draining()` true defers `admit` too: a
   *  draining generation starts nothing it cannot finish. */
  planeEffects?: {
    draining(): boolean;
    admit(effect: Extract<PlaneEffect, { kind: "admit" }>): Promise<PlaneAckOutcome>;
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
   *  record gets (item 54). Called once, only when a `reservation` was given. */
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
export type ReserveOutcome =
  { kind: "tracked"; run: LedgerRun } | { kind: "untracked"; why: string } | { kind: "fenced" } | { kind: "off" };

/** How `open` ended (record 0060; the same discriminants as `ReserveOutcome`):
 *  `tracked` with the run's handle; `untracked` with why — the machine word
 *  `thread-live` when the thread's row refused the claim (what the ship branch
 *  refuses by name), otherwise the reason in the words the run's record gets
 *  (item 54); `fenced` — the row is another generation's, this process must not
 *  drive the run; `off` — the process has no ledger. Every caller treats a
 *  non-tracked answer as it treated `undefined` before: the run goes on
 *  untracked. */
export type OpenOutcome =
  { kind: "tracked"; run: LedgerRun } | { kind: "untracked"; why: string } | { kind: "fenced" } | { kind: "off" };

/** `finishing()`'s answer: `ok` — reply; `fenced` — another generation owns
 *  the run, do NOT reply (it will); `unavailable` — the ledger could not be
 *  asked or this run is untracked, reply as before (the run is this process's). */
export type FinishingGate = "ok" | "fenced" | "unavailable";

/** One tracked run. Every method is safe to call after a detach (a no-op). */
export interface LedgerRun {
  readonly runId: string;
  /** False once a write was refused or failed for good: the ledger no longer
   *  mirrors this run (it is not resumable); the finish still lands. */
  tracked(): boolean;
  /** The runner's step hook: the step's turns, then its record — awaited. */
  step(report: StepReport): Promise<void>;
  /** A registry event, in publish order, with the registry's `seq`. */
  event(event: RunEvent, seq: number): void;
  /** Merge into the run's state and send it (coalesced: the newest wins). */
  setState(patch: RunState): void;
  /** `live → finishing`, before the reply — the double-answer gate (D9). */
  finishing(): Promise<FinishingGate>;
  /** A reserved run that never started (item 42): the row goes with no record,
   *  so nothing restarts it. A no-op for a detached run (fenced: another
   *  generation owns the row) and for an untracked one. */
  abandon(): Promise<void>;
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
  /** Stop the heartbeat and flush the events. Idempotent; `sink.put` does it too. */
  close(): Promise<void>;
}

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
  /** The row's place in its session log (session-log item 2): the adopted run
   *  appends at its indices and its record closes the range. Absent for a row
   *  claimed before the log existed, which keeps writing its own object. */
  session?: RunSession;
  onStop?: (mode: StopMode) => void;
  onFenced?: () => void;
}

export interface LedgerWriteThrough {
  readonly gen: string;
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
   *  the record's words) before returning, and the reserved row is abandoned. */
  open(req: OpenRunRequest): Promise<OpenOutcome>;
  /** Take up a reclaimed run: heartbeat, steps, events and state continue
   *  under this generation with no claim and no seed. Synchronous — the row is
   *  ours since the boot reclaim, and the heartbeat must start at once. */
  adopt(req: AdoptRunRequest): LedgerRun;
  /** The runs this generation is driving right now (opened or adopted, not yet finished). */
  liveRuns(): LedgerRun[];
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
  readSessionTail(key: string, maxBytes: number): Promise<{ from: number; transcript: AssembledTranscript }>;
  /** The rows `[from, to]` of a session log as a conversation counted from `from` (item 3) — one turn when `to` is `from`. */
  readSession(key: string, from: number, to?: number): Promise<AssembledTranscript>;
  /** The idempotent keyed append (session-log item 13): the parts of one turn
   *  at the log's tail under `rowId` — a fold row, a connector turn, a migrated
   *  row. A row id the log has seen appends nothing. Throws as the ledger does. */
  appendSession(
    key: string,
    rowId: string,
    rows: readonly { part: number; json: string }[],
  ): Promise<{ ok: boolean; appended: boolean }>;
  /** The full-text search `recall` makes (item 10): hits in relevance order, and the gap markers between them. */
  searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }>;
  /** The session's notepad, or null when nothing wrote it (item 10). */
  readNotepad(key: string): Promise<Notepad | null>;
  /** Replace the notepad whole under this generation's fence (item 10). */
  writeNotepad(key: string, text: string): Promise<FenceResult>;
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
  constructor(
    readonly gen: string,
    private readonly fallback: RecordSink,
  ) {}
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
  async pushInbox(_runId: string, _message: Record<string, unknown>): Promise<number | undefined> {
    return undefined;
  }
  async readInbox(_runId: string, _afterSeq: number): Promise<InboxItem[]> {
    return [];
  }
  async readSessionTail(_key: string, _maxBytes: number): Promise<{ from: number; transcript: AssembledTranscript }> {
    return { from: 0, transcript: { complete: true, turns: 0, messages: [], compactions: [] } };
  }
  async readSession(_key: string, _from: number, _to?: number): Promise<AssembledTranscript> {
    return { complete: true, turns: 0, messages: [], compactions: [] };
  }
  async appendSession(
    _key: string,
    _rowId: string,
    _rows: readonly { part: number; json: string }[],
  ): Promise<{ ok: boolean; appended: boolean }> {
    return { ok: false, appended: false };
  }
  async searchSession(_key: string, _query: string, _limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }> {
    return { hits: [], gaps: [] };
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
  setState(_patch: RunState): void {
    // no ledger to mirror onto
  }
  async finishing(): Promise<FinishingGate> {
    return "unavailable";
  }
  async abandon(): Promise<void> {}
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

/** How a run's finish ended (item 54): the row went (`landed`), the ledger
 *  refused it and the record went to the plain store (`refused`), or the
 *  attempt sequence failed for good (`failed`, with the last error's words). */
type LandingOutcome = { kind: "landed" } | { kind: "refused" } | { kind: "failed"; why: string };

/** A finish this process is landing (item 54): one entry per run from its
 *  first `put` to the outcome, settled once, awaited by a claim that met the
 *  run's row on the thread. */
interface Landing {
  settled: Promise<LandingOutcome>;
  resolve: (outcome: LandingOutcome) => void;
}

/** Why a claim that waited for a finish ended untracked all the same (item
 *  54): the run's row still stood — or another run's row does now. */
function untrackedWhy(awaited: string, live: { runId: string }, outcome: LandingOutcome): string {
  if (live.runId !== awaited)
    return `the thread's live row belongs to run ${live.runId} now, not to run ${awaited}, whose finish this process landed or was landing`;
  const inFlight = `run ${awaited}, whose finish was in flight in this process, still holds the thread's row`;
  switch (outcome.kind) {
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
      entry = { settled, resolve };
      landing.set(runId, entry);
    }
    return entry;
  };
  const settleLanding = (runId: string, entry: Landing, outcome: LandingOutcome): void => {
    entry.resolve(outcome);
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
    | { outcome: "ok"; session?: RunSession }
    | { outcome: "fenced" }
    | { outcome: "untracked"; why: string; refused?: "thread-live" };

  /** `fenced`: the thread's row is THIS run under another generation — the
   *  reservation's lease lapsed and a reclaim took it (item 42); this process
   *  must not drive it. With a `seed`, the run is a range of its thread-and-
   *  agent session log (session-log item 2): the log's tail is read first,
   *  the row's meta names the range the seed will occupy, and the log's owner
   *  is taken AFTER the history claim — so a refused claim never steals a live
   *  run's log. The three requests are one claim: any failure retries them all. */
  async function claim(
    req: Omit<OpenRunRequest, "seed" | "reservation">,
    opts: { phase?: "attaching"; seed?: readonly ChatMessage[]; log?: { from: number; turns: number } } = {},
  ): Promise<Claimed> {
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
    for (let attempt = 1; ; attempt++) {
      try {
        let session: RunSession | undefined;
        if (opts.seed) {
          const key = sessionKey(req.threadKey, req.meta.agent);
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
          session = { key, seedFrom, request: seedFrom + requestIndex(opts.seed), range: { from: next } };
        }
        const result = await ledger.claim({
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
        });
        if (result.ok) {
          if (session) await ledger.claimSession(session.key, req.runId, gen);
          return session ? { outcome: "ok", session } : { outcome: "ok" };
        }
        if (result.live.runId === req.runId) return { outcome: "fenced" };
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
    private seeded = false;
    private adopted = false;
    handedOff = false;
    /** The run's place in its session log (session-log item 2); undefined for
     *  a run without a conversation of its own and for an adopted row claimed
     *  before the log existed. */
    private sessionRow: RunSession | undefined;
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
    private stepNo: number;
    /** The row is a hosted ship parent's (record 0060): `meta.hosted` at the claim. */
    private readonly hosted: boolean;
    private lastSeq: number;
    private state: RunState;
    private stateSending: Promise<void> = Promise.resolve();
    private stateDirty = false;
    private stopRelayed: StopMode | undefined;
    private heartbeat: { unref?(): void } | undefined;
    private readonly flusher = createAppendFlusher<AppendableEvent>({
      flushMs: opts.flushMs ?? APPEND_FLUSH_MS,
      maxEvents: opts.flushEvents ?? APPEND_FLUSH_EVENTS,
      send: async (batch) => {
        if (this.detached) return;
        const result = await ledger.append(this.runId, gen, batch);
        if (!result.ok && !this.finished) this.detach(`append refused (${result.reason})`);
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
        startedAt?: number;
      },
      from: { stepNo: number; lastSeq: number; resumable?: boolean; session?: RunSession } = {
        stepNo: 0,
        lastSeq: 0,
      },
    ) {
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
    }

    /** A reservation learns its session when the prompt's claim promotes it. */
    bindSession(session: RunSession): void {
      this.sessionRow = session;
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
        this.finished = true; // no event or state write after this point
        live.delete(this);
        // Named in `landing` from the first attempt to the outcome, so a claim
        // meeting this run's row can await it and say why the row stood (item
        // 54). A failure here settles nothing: the caller decides whether it
        // tries again (the history writer's ladder) or is done — and says so
        // with `abandoned`, which is the one word that settles a failed finish.
        const entry = landingFor(this.runId);
        const { value, outcome } = await this.land(plain);
        settleLanding(this.runId, entry, outcome);
        return value;
      },
      abandoned: (record, why) => {
        if (record.id !== this.runId) return;
        const entry = landing.get(this.runId);
        if (entry !== undefined) settleLanding(this.runId, entry, { kind: "failed", why });
      },
    };

    /** The finish itself: the flush, then the ledger's one-transaction `finish`,
     *  else the plain store — and which of the two took the record. */
    private async land(plain: RunRecord): Promise<{ value: unknown; outcome: LandingOutcome }> {
      await this.close();
      const session = this.sessionOnRecord();
      const record = session ? { ...plain, session } : plain;
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
    detach(reason: string): void {
      if (this.detached) return;
      this.detached = true;
      this.broken = true; // the log ends short of what the model saw from here on
      warn(`[ledger] ${this.threadKey} run ${this.runId} detached: ${reason} — this run is not resumable`);
      this.stopHeartbeat();
      live.delete(this);
      // A fence means another generation owns the run now (it reclaimed the
      // row): this process must stop driving it, and must not reply (D9) —
      // `finishing()` answers `fenced` from here on, not `unavailable`.
      if (reason.includes("(fenced)")) {
        this.fencedOut = true;
        if (this.onFenced && !this.fencedTold) {
          this.fencedTold = true;
          this.onFenced();
        }
      }
    }

    /** The seed, then the seed record: step 0 with no calls in flight and
     *  `turnIndex` = the seed's length, so a reclaim always has a step record
     *  to judge the transcript against (`transcriptCompleteness`) — a row with
     *  no record at all was killed before its conversation was stored and
     *  closes `interrupted`. */
    async seed(messages: ChatMessage[], budgetMs: number, actors?: readonly (string | undefined)[]): Promise<void> {
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
        const seeded = await ledger.seed(this.runId, gen, turns, this.sessionRow?.key);
        if (!seeded.ok) {
          this.detach(`seed refused (${seeded.reason})`);
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
        if (!recorded.ok) this.detach(`seed record refused (${recorded.reason})`);
        else this.seeded = true;
      } catch (err) {
        this.detach(`seed failed: ${describe(err)}`);
      }
    }

    async step(report: StepReport): Promise<void> {
      if (this.detached) return;
      // Every row at its log index (`rowIndex`). A compaction entry rides as
      // the row after the step's turns and counts as a turn, so the
      // completeness rule sees one index per row.
      const turns: TranscriptTurn[] = report.turns.map((message, i) => ({
        idx: this.rowIndex(report.firstIdx + i),
        message,
      }));
      if (report.compaction)
        turns.push({ idx: this.rowIndex(report.firstIdx + report.turns.length), compaction: report.compaction });
      const record: StepRecord = {
        step: ++this.stepNo,
        seq: this.lastSeq,
        turnIndex: report.firstIdx + turns.length,
        inFlight: report.inFlight,
        inboxConsumedSeq: report.inboxConsumedSeq,
        remainingMs: report.remainingMs,
        turn: report.turn,
        iteration: report.iteration,
      };
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
          if (!result.ok) this.detach(`step ${record.step} refused (${result.reason})`);
          else this.turnsWritten = record.turnIndex;
          return;
        } catch (err) {
          if (err instanceof RouteMissingError || err instanceof PermanentStoreError || attempt >= 2) {
            this.detach(`step ${record.step} failed: ${describe(err)}`);
            return;
          }
          await sleep(RETRY_MS[0]); // a blip a microsecond later is still a blip
        }
      }
    }

    event(event: RunEvent, seq: number): void {
      if (this.detached || this.finished) return;
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

    setState(patch: RunState): void {
      if (this.detached) return;
      this.state = { ...this.state, ...patch };
      this.stateDirty = true;
      this.stateSending = this.stateSending.then(() => this.sendState());
    }

    /** The merged snapshot, sent once per burst of patches; a transient failure
     *  is retried once after a backoff and, failing that, leaves the state
     *  dirty so the next patch carries it — the LAST state of a run (a verdict
     *  set near the end) must not be lost to one blip. */
    private async sendState(): Promise<void> {
      if (!this.stateDirty || this.detached || this.finished) return;
      this.stateDirty = false;
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await ledger.setState(this.runId, gen, this.state);
          if (!result.ok) this.detach(`state refused (${result.reason})`);
          return;
        } catch (err) {
          if (err instanceof RouteMissingError || err instanceof PermanentStoreError || attempt >= 2) {
            this.stateDirty = true;
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
        this.detach(`finishing refused (fenced)`);
        return "fenced";
      } catch (err) {
        warn(`[ledger] ${this.threadKey} finishing failed: ${describe(err)}`);
        return "unavailable";
      }
    }

    async abandon(): Promise<void> {
      if (this.detached || this.finished) return;
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
          this.detach(`heartbeat refused (${result.reason})`);
          return;
        }
        if (result.stop && this.stopRelayed !== result.stop && this.onStop) {
          this.stopRelayed = result.stop;
          this.onStop(result.stop);
        }
        // The plane's effects (orchestration-plane; record 0064; orchestration-plane item 7):
        // an `admit` runs through the wired executor — the restart-from-request
        // path under the plane's id — unless this generation is draining, which
        // defers it (it starts nothing it cannot finish); a process without the
        // wiring defers everything, and the offer stays for a bot that can.
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
            const outcome: PlaneAckOutcome =
              effect.kind === "probe"
                ? executor?.probe === undefined
                  ? "skipped"
                  : await executor.probe(effect)
                : effect.kind !== "admit"
                  ? "deferred"
                  : executor === undefined || executor.draining()
                    ? "deferred"
                    : await executor.admit(effect);
            await ledger.planeAck(effect.id, outcome);
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
      await this.stateSending;
      await this.flusher.close();
    }
  }

  return {
    gen,
    async reserve(req) {
      const claimed = await claim({ ...req, system: "", tools: [], state: {} }, { phase: "attaching" });
      // Every untracked exit says why (item 54): the row a run this process
      // closed still stood, another run's row, no routes, a claim that kept
      // failing — for the run's own record, not the bot log alone.
      if (claimed.outcome === "untracked") return { kind: "untracked", why: claimed.why };
      if (claimed.outcome === "fenced") return { kind: "fenced" };
      const run = new TrackedRun(req);
      run.startHeartbeat();
      live.add(run);
      unpromoted.add(req.runId);
      return { kind: "tracked", run };
    },
    async open(req) {
      // `untracked`'s why for the caller: the machine word for a thread-live
      // refusal — what the ship branch refuses by name (record 0060) — the
      // record's sentence for every other reason.
      const untracked = (claimed: { why: string; refused?: "thread-live" }): OpenOutcome => ({
        kind: "untracked",
        why: claimed.refused ?? claimed.why,
      });
      const reserved = req.reservation;
      const seed = req.seed?.messages;
      if (reserved instanceof TrackedRun) {
        // The promotion (item 42): the claim the dispatcher always made, now
        // landing on the row reserved at admission — same tracked run, its
        // heartbeat already running. A row another generation took meanwhile
        // fences this run (it is theirs to restart); an untracked answer means
        // the thread's row is someone else's (a stale reservation) — the run
        // goes on untracked, as an open without a reservation would.
        if (!reserved.tracked()) return { kind: "untracked", why: "the run's reservation is already untracked" };
        const claimed = await claim(req, seed ? { seed, ...(req.seed?.log ? { log: req.seed.log } : {}) } : {});
        if (claimed.outcome === "fenced") {
          unpromoted.delete(reserved.runId); // the row is another generation's: nothing of ours to abandon
          reserved.detach("promotion refused (fenced)");
          return { kind: "fenced" };
        }
        if (claimed.outcome !== "ok") {
          // Abandon the row — not close (close only stops the heartbeat,
          // leaving the attaching row on the ledger where the reclaim sweep
          // would see it as an expired reservation and restart the run, while
          // the untracked original is still running). Abandon removes the row
          // and owns the `unpromoted` bookkeeping: an abandon that fails keeps
          // the run there, so the thread's next claim abandons the row again
          // (item 54) — the safety net the pre-delete would have defeated.
          await reserved.abandon();
          req.onUntracked?.(claimed.why);
          return untracked(claimed);
        }
        unpromoted.delete(reserved.runId); // promoted: no longer a reservation to abandon
        if (claimed.session) reserved.bindSession(claimed.session);
        // The claim wrote the dispatcher's state onto the row (the workspace
        // binding, item 54); the reserved run merges it into its own, so the
        // first patch after the claim carries it on instead of writing over it.
        if (req.state) reserved.adoptState(req.state);
        if (req.seed) await reserved.seed(req.seed.messages, req.seed.budgetMs, req.seed.actors);
        return { kind: "tracked", run: reserved };
      }
      const claimed = await claim(req, seed ? { seed, ...(req.seed?.log ? { log: req.seed.log } : {}) } : {});
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
      if (req.seed) await run.seed(req.seed.messages, req.seed.budgetMs, req.seed.actors);
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
      });
      run.startHeartbeat();
      live.add(run);
      return run;
    },
    liveRuns: () => [...live],
    async pushInbox(runId, message) {
      try {
        const result = await ledger.pushInbox(runId, message);
        if (result.ok && result.seq !== undefined) return result.seq;
        warn(`[ledger] inbox push refused for run ${runId}: no live row — the follow-up rides in memory only`);
        return undefined;
      } catch (err) {
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
    appendSession: (key, rowId, rows) => ledger.appendSession(key, rowId, rows),
    searchSession: (key, query, limit) => ledger.searchSession(key, query, limit),
    readNotepad: (key) => ledger.readNotepad(key),
    writeNotepad: (key, text) => ledger.writeNotepad(key, gen, text),

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
        if (err instanceof PermanentStoreError) return degraded(describe(err));
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
