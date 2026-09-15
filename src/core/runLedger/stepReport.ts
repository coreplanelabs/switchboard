// One step of a run as the harness reports it to the ledger before the step's
// tools run (docs/reference/specs/run-history.md item 35; harness-pi.md item 8):
// the turns appended since the previous report, the calls about to be
// dispatched, the counters. The seed plus every report is exactly the
// conversation the model has seen, without gaps — the invariant the ledger's
// transcript rests on. The pi mirror writes these from pi's finished messages
// (`PiMirror`); `LedgerRun.step` takes them. A leaf, like the ledger's other
// vocabulary: the turn type and the compaction entry, nothing of Node.

import type { ChatMessage } from "../chatMessage.js";
import type { CompactionEntry } from "./types.js";

export interface StepReport {
  /** The messages appended since the previous report (or since the seed, for
   *  the first): the previous step's results turn and this step's assistant
   *  turn — every turn the model has seen, without gaps. */
  turns: ChatMessage[];
  /** The index of `turns[0]` in the run's conversation (the seed counts from 0). */
  firstIdx: number;
  /** pi's compaction entry, when the harness saw one since the previous report
   *  (docs/reference/specs/session-log.md item 6): the ledger stores it as the row
   *  after `turns`, and it counts as one turn of the conversation. */
  compaction?: CompactionEntry;
  /** The tool calls this step is about to dispatch, by call id. */
  inFlight: { callId: string; tool: string }[];
  turn: number;
  iteration: number;
  remainingMs: number;
  /** The highest run-ledger inbox seq among the follow-ups drained so far
   *  (run-history item 40): a resume folds in only what lies past it. */
  inboxConsumedSeq: number;
}
