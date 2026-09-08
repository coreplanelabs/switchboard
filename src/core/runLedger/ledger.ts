// The ledger seam (features/run-history.md item 28): what the bot calls, with
// two implementations — `WorkerRunLedger` (HTTPS to the state Worker; the
// production choice) and `InMemoryRunLedger` (tests, and the shape every
// decision is checked against). The step write's order is part of the
// contract: transcript turns first, then the step record, so a record present
// means the transcript is complete up to it.

import type { RunRecord } from "../runRecord.js";
import type { AssembledTranscript } from "./transcript.js";
import type {
  AppendableEvent,
  ClaimRequest,
  ClaimResult,
  FenceResult,
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
  /** The seed prefix, written once at start (chunked by the implementation). */
  seed(runId: string, gen: string, turns: TranscriptTurn[]): Promise<FenceResult>;
  /** The one awaited write per step: `turns` land first, then `record`. */
  step(runId: string, gen: string, record: StepRecord, turns: TranscriptTurn[]): Promise<FenceResult>;
  heartbeat(runId: string, gen: string, leaseMs: number): Promise<HeartbeatResult>;
  append(runId: string, gen: string, events: AppendableEvent[]): Promise<FenceResult>;
  setState(runId: string, gen: string, state: RunState): Promise<FenceResult>;
  /** Any generation: a steer arrives on whichever container is up. */
  pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }>;
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
  /** Take over expired and handed-off runs; the transcript owner is updated before this resolves. */
  reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]>;
  listLive(): Promise<LiveRunRow[]>;
  readTranscript(runId: string): Promise<AssembledTranscript>;
  /** The events appended so far for a LIVE run, in `seq` order — what a
   *  reclaim closes an unresumable run's record with (the finished-runs routes
   *  never see a live run). Empty for an unknown run. */
  readEvents(runId: string): Promise<AppendableEvent[]>;
}
