// The ledger seam (docs/reference/specs/run-history.md item 28): what the bot calls, with
// two implementations — `WorkerRunLedger` (HTTPS to the state Worker; the
// production choice) and `InMemoryRunLedger` (tests, and the shape every
// decision is checked against). The step write's order is part of the
// contract: transcript turns first, then the step record, so a record present
// means the transcript is complete up to it.

import type { RunRecord } from "../runRecord.js";
import type { AssembledTranscript } from "./transcript.js";
import type { Notepad, SessionHit } from "./types.js";
import type {
  InboxItem,
  AppendableEvent,
  ClaimRequest,
  ClaimResult,
  FenceResult,
  IntakeQuery,
  IntakeReceipt,
  IntakeWriteResult,
  LivePhase,
  LiveRunRow,
  ReclaimedRun,
  RunState,
  StepRecord,
  StopMode,
  TranscriptTurn,
} from "./types.js";

export interface HeartbeatResult {
  ok: boolean;
  reason?: "fenced" | "unknown-run";
  /** What another generation asked for since the last heartbeat. */
  stop?: StopMode | null;
  phase?: LivePhase;
}

export interface FinishResult {
  ok: boolean;
  reason?: "fenced" | "unknown-run";
  /** Whether the finished record is retained under the store's policy. */
  stored?: boolean;
}

export interface RunLedger {
  /** One live run per thread; refused with the live run when the thread is
   *  taken. The Worker implementation is two requests (the history claim, then
   *  the transcript owner); a failure between them leaves a claimed run whose
   *  transcript answers `unknown-run`. The owner's re-claim is idempotent and
   *  re-runs the owner write, so the caller's convention is: retry the whole
   *  `claim` on failure, never proceed past a claim that did not resolve `ok`. */
  claim(req: ClaimRequest): Promise<ClaimResult>;
  /** The seed prefix, written once at start (chunked by the implementation).
   *  With `session`, the rows go to that session log at their log indices
   *  (docs/reference/specs/session-log.md item 2); without, to the run's own
   *  transcript object — the path a row claimed before the log existed keeps. */
  seed(runId: string, gen: string, turns: TranscriptTurn[], session?: string): Promise<FenceResult>;
  /** The one awaited write per step: `turns` land first, then `record`. `session` as for `seed`. */
  step(runId: string, gen: string, record: StepRecord, turns: TranscriptTurn[], session?: string): Promise<FenceResult>;
  /** The index a session log's next row lands at: 0 for a log no run has written. */
  sessionTail(key: string): Promise<number>;
  /** Own the session log for the run: its writes land, every other generation's are fenced.
   *  Taken after the history claim, so a refused claim never steals a live run's log.
   *  `maxBytes` is the log's byte budget (session-log item 5); absent, the implementation's
   *  configured budget, else the policy default — the object enforces it on every write. */
  claimSession(key: string, runId: string, gen: string, maxBytes?: number): Promise<void>;
  /** The owner releases the log at its finish; only the owner may (`fenced` otherwise). */
  releaseSession(key: string, runId: string, gen: string): Promise<FenceResult>;
  /** The rows `[from, to]` (the tail when `to` is absent) as a conversation counted from `from`. */
  readSession(key: string, from: number, to?: number): Promise<AssembledTranscript>;
  /** The newest whole turns within `maxBytes` and the index they start at (item 4). */
  readSessionTail(key: string, maxBytes: number): Promise<{ from: number; transcript: AssembledTranscript }>;
  /** The rows whose text matches `query`, in relevance order, at most `limit`,
   *  and the gap markers that lie between the oldest and the newest hit — what
   *  `recall` answers (item 10). */
  searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }>;
  /** The session's notepad, or null when nothing has written it (item 10). */
  readNotepad(key: string): Promise<Notepad | null>;
  /** Replace the notepad whole under the owner's fence (item 10); `text` is at
   *  most `NOTEPAD_MAX_BYTES` — the caller refuses more before asking. */
  writeNotepad(key: string, gen: string, text: string): Promise<FenceResult>;
  heartbeat(runId: string, gen: string, leaseMs: number): Promise<HeartbeatResult>;
  append(runId: string, gen: string, events: AppendableEvent[]): Promise<FenceResult>;
  setState(runId: string, gen: string, state: RunState): Promise<FenceResult>;
  /** Any generation: a steer arrives on whichever container is up. */
  pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }>;
  /** The inbox items with `seq > afterSeq`, in seq order — the resume's re-read
   *  at adopt time (run-history item 40), so a steer that landed after the
   *  reclaim's snapshot is not lost. Empty for an unknown run. */
  readInbox(runId: string, afterSeq: number): Promise<InboxItem[]>;
  /** Any generation; `ownerLive` says whether the owner's lease is current. */
  requestStop(runId: string, mode: StopMode): Promise<{ ok: boolean; ownerLive?: boolean }>;
  /** SIGTERM: mark this generation's runs for the next one. */
  handoff(gen: string, runIds: string[]): Promise<{ marked: string[] }>;
  /** CAS `live → finishing`, taken before the reply. */
  finishing(runId: string, gen: string): Promise<FenceResult>;
  /** The finished record replaces the live rows in one transaction. Fenced by
   *  generation only, NOT by phase: the owner may finish from any phase, because
   *  a reclaim closes an unresumable run as `interrupted` straight from `live`
   *  and a handing-off generation whose run completes in its last seconds has
   *  a true finish to record. The double-answer protection is `finishing`,
   *  which the reply path MUST take first; `finish` does not check it. */
  finish(runId: string, gen: string, record: RunRecord): Promise<FinishResult>;
  /** The live rows go with NO record (item 42): a run reserved at admission
   *  whose dispatch ended before its prompt existed — a refusal, a failed
   *  attach — never started, so there is nothing to record and nothing to
   *  restart. Fenced by generation like `finish`. */
  abandon(runId: string, gen: string): Promise<FenceResult>;
  /** Take over expired and handed-off runs; the transcript owner is updated before this resolves. */
  reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]>;
  listLive(): Promise<LiveRunRow[]>;
  /** The intake receipt for a message key (item 59), insert-if-absent: the
   *  first writer's row stands and every caller acts on `stored`. Satisfies
   *  the intake seam (`IntakeLedger` in `src/core/intake.ts`) structurally. */
  recordIntake(key: string, receipt: IntakeReceipt): Promise<IntakeWriteResult>;
  /** The stored receipt, or none — the read the gate and the catch-up make
   *  before deciding (item 59). */
  readIntake(key: string): Promise<IntakeReceipt | undefined>;
  /** The receipts of a thread, or since an instant, oldest first (item 59) —
   *  what the live false-silence ratio reads. */
  listIntake(query: IntakeQuery): Promise<IntakeReceipt[]>;
  readTranscript(runId: string): Promise<AssembledTranscript>;
  /** The events appended so far for a LIVE run, in `seq` order — what a
   *  reclaim closes an unresumable run's record with (the finished-runs routes
   *  never see a live run). Empty for an unknown run. */
  readEvents(runId: string): Promise<AppendableEvent[]>;
}
