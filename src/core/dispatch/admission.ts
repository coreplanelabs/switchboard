// The admission stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// who may hold the thread. The claim — ONE live run per thread — a steer into
// the run in flight, a refusal, the boot-gap steer to a run live on another
// generation; then taking up a resumed or restarted run's row and the durable
// inbox it carried. The fast paths that answer a message before any of this
// are fastPath.ts.
//
// The stage is three functions because each thing it takes hold of — the
// thread slot, a ledger row, a reservation — is handed back to `dispatch()`
// before the next step that can throw, so its outer `finally` releases
// exactly what the inline code used to.
import type { ConfigStore } from "../../config.js";
import type { LedgerRun, LedgerWriteThrough } from "../runLedger/writeThrough.js";
import type { AppendableEvent, InboxItem, LiveRunRow, StepRecord } from "../runLedger/types.js";
import type { ThreadsElsewhere } from "../runLedger/threadsElsewhere.js";
import type { ResumePlan } from "../runLedger/resume.js";
import { messageFromInbox } from "../runLedger/inboxMessage.js";
import { systemClock } from "../trace/index.js";
import type { Clock } from "../trace/types.js";
import type { RepoContext } from "../repoContext.js";
import { ThreadAdmission, type FollowUpInput } from "../threadAdmission.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { reclaimedRunRecord } from "./record.js";

/** What thread admission reads off the dispatcher's dependencies. `CoreDeps`
 *  extends this; a caller's shape is unchanged. */
export interface AdmissionDeps {
  config: ConfigStore;
  /** The wall clock (docs/reference/specs/tracing.md): `systemClock` in production, a ticking clock in tests. */
  clock?: Clock;
  /**
   * Thread admission (docs/reference/specs/thread-admission.md): the per-process map of
   * threads with a run in flight, so a follow-up in such a thread is steered
   * into that run or refused instead of starting a rival one. Defaults to the
   * process-wide singleton; injectable for tests.
   */
  admission?: ThreadAdmission<DispatchFollowUp>;
  /**
   * The run ledger's write-through (docs/reference/specs/run-history.md item 35): every
   * agent run and ship pipeline is claimed on the state Worker's ledger when
   * its run is created, mirrors its steps/events/state while it runs, takes
   * `finishing` before the reply and finishes through the ledger's one
   * transaction (`runHistoryWriter.write(record, { via })`). Without a ledger
   * it is the `NullLedgerWriteThrough`: nothing is claimed and the run goes on
   * exactly as before the ledger existed. Production wires
   * `createLedgerWriteThrough` beside the run store (src/index.ts), so a
   * ledger always comes with a writer: without one the finish never reaches the
   * ledger and a claimed row closes only by lease expiry (a test-only pairing).
   */
  runLedger: LedgerWriteThrough;
  /** The threads whose live run is on the ledger but not in this process
   *  (thread-admission item 5), fed by the reclaim sweep: a follow-up on one
   *  is steered into that run's durable inbox instead of starting a rival.
   *  Empty in a process without a ledger. */
  threadsElsewhere: Pick<ThreadsElsewhere, "get" | "forget">;
}

/** A follow-up as the dispatcher admits it: the runner's `FollowUpInput` plus
 *  the message and channel handle it arrived on — what a fresh turn needs if
 *  the live run ends without consuming it (docs/reference/specs/thread-admission.md item 4). */
export type DispatchFollowUp = FollowUpInput & { msg: IncomingMessage; io: ChannelIO };

/** The process-wide admission map (one bot process = one map; the registry's
 *  singleton is the same shape of default). */
export const defaultAdmission = new ThreadAdmission<DispatchFollowUp>();

/** A run this generation reclaimed at boot and is continuing (docs/reference/specs/
 *  run-history.md item 38): the ledger row as it stands, the last step record,
 *  the resume plan built from the transcript, the events published before the
 *  restart (replayed into the registry under their seqs), and the repo context
 *  rebuilt from the row's meta. */
export interface ResumeContext {
  row: LiveRunRow;
  lastStep: StepRecord;
  plan: Extract<ResumePlan, { kind: "resume" }>;
  events: AppendableEvent[];
  /** The highest event seq on the ledger; appends continue past it. */
  lastSeq: number;
  repoCtx: RepoContext;
  /** The durable inbox past the last record (item 40): folded in at the run's first boundary. */
  inbox: InboxItem[];
}

/** A run reserved at admission whose owner died while attaching (item 42):
 *  dispatched again from its request under the row's id and card. The row is
 *  still `attaching` and this generation's; the inbox holds the follow-ups
 *  steered in meanwhile. */
export interface RestartContext {
  row: LiveRunRow;
  inbox: InboxItem[];
}

export { DURABLE_INBOX_MAX_BYTES, durableInboxMessage } from "../runLedger/inboxMessage.js";

/** A durable inbox item back as a follow-up for the resumed run, on the
 *  resume's channel handle; undefined when the stored shape is not one this
 *  build wrote (skipped, never fatal). */
export function followUpFromInbox(item: InboxItem, io: ChannelIO, fallbackAt: number): DispatchFollowUp | undefined {
  const restored = messageFromInbox(item.message, fallbackAt);
  if (!restored) return undefined;
  const { msg, at } = restored;
  return {
    text: msg.text,
    userId: msg.userId,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.images !== undefined ? { images: msg.images } : {}),
    ...(msg.documents !== undefined ? { documents: msg.documents } : {}),
    at,
    ledgerSeq: item.seq,
    msg,
    io,
  };
}

/** Close a restart's row this dispatch will never run (item 42): the thread
 *  has a newer run — the user re-mentioned after the kill — so the reserved
 *  run is closed `interrupted` with a record of its identity and request,
 *  through an adopted handle so the ledger's finish removes the row.
 *  Best-effort, like `closeResumedRow` below. */
export async function closeRestartRow(adopted: LedgerRun, restart: RestartContext, why: string): Promise<void> {
  try {
    await adopted.sink.put(
      reclaimedRunRecord({ row: restart.row, events: [], status: "interrupted", finishedAt: systemClock() }),
    );
  } catch (err) {
    console.warn(
      `[restart] ${restart.row.runId} could not be closed (${why}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Close a reclaimed row this dispatch adopted but will never finish (item
 *  38): the record is the row plus the events published before the restart,
 *  status `interrupted`, through the adopted run's sink so the ledger's finish
 *  removes the row. Best-effort: a failure is a warning, the sweep's next pass
 *  finds the row again. */
export async function closeResumedRow(adopted: LedgerRun, resume: ResumeContext, why: string): Promise<void> {
  try {
    await adopted.sink.put(
      reclaimedRunRecord({ row: resume.row, events: resume.events, status: "interrupted", finishedAt: systemClock() }),
    );
  } catch (err) {
    console.warn(
      `[resume] ${resume.row.runId} could not be closed (${why}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
