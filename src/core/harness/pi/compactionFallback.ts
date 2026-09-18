// The compaction the bot writes for pi when pi's own summary could not be
// (docs/reference/specs/harness-pi.md item 7). pi compacts by asking the model
// for a summary of the turns it drops, and that call can fail for good: the
// provider's classifier refuses the serialized turns under its usage policy,
// the summary hits its token cap, the model answers with a tool call. pi
// tries again at every turn boundary while the window stays over the
// threshold, each try costing the summary calls that precede the failing one
// and none of them ever succeeding, until the context overflows and the run
// dies. Record 0035 already decided that a compaction is a pointer, never a
// loss: every dropped turn stays in the session log behind `recall`, and the
// notepad carries what the agent chose to keep. So the fallback is not a
// second model: after a compaction failed for good (the harness judges the
// failure, `isTransientProviderError` ruling out the blips pi's next try
// would ride out), the next compaction's summary is this pointer, written
// deterministically from what the extension's `session_before_compact` hook
// hands over — the trigger, the size, the summary the compaction before it
// left, pi's own file lists — and handed back to pi as the extension's
// compaction. The window shrinks, the row lands on the log like any other
// compaction, the steer that follows carries the notes, and pi's own summary
// is tried again at the compaction after.

import { redactAndCap } from "../../runEvents.js";

/** What the extension tells the bot about the compaction pi is about to
 *  write, read off pi's `CompactionPreparation`. */
export interface CompactionAsk {
  /** pi's trigger: the context threshold, an overflow, a manual compact. */
  reason: string;
  tokensBefore: number;
  /** The summary the compaction before this one left, when there was one. */
  previousSummary?: string;
  /** pi's own file lists for the dropped turns (its `computeFileLists`): the
   *  files only read, and the files written or edited. */
  readFiles: string[];
  modifiedFiles: string[];
}

/** The bot's word on the compaction: the summary pi writes it with, or
 *  nothing — pi's own summary is tried. */
export interface CompactionAnswer {
  summary?: string;
}

/** The fixed opening of every pointer summary: the bridge reads it off pi's
 *  `compaction_end` to say whose summary the compaction carries. */
export const POINTER_SUMMARY_PREFIX =
  "The earlier turns of this session were dropped from the window without a summary";

/** The route's reading of the extension's body: the shape above or nothing. */
export function compactionAskOf(body: unknown): CompactionAsk | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.reason !== "string") return undefined;
  if (typeof b.tokensBefore !== "number" || !Number.isFinite(b.tokensBefore)) return undefined;
  if (b.previousSummary !== undefined && typeof b.previousSummary !== "string") return undefined;
  const list = (v: unknown): string[] | undefined => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((f) => typeof f !== "string")) return undefined;
    return v as string[];
  };
  const readFiles = list(b.readFiles);
  const modifiedFiles = list(b.modifiedFiles);
  if (!readFiles || !modifiedFiles) return undefined;
  return {
    reason: b.reason,
    tokensBefore: b.tokensBefore,
    ...(b.previousSummary !== undefined ? { previousSummary: b.previousSummary } : {}),
    readFiles,
    modifiedFiles,
  };
}

/** The pointer summary: why pi's own could not be written (the failure's
 *  words, redacted and capped), where the dropped turns are, the summary the
 *  compaction before this one left, and pi's file lists in pi's own tags. */
export function pointerSummary(ask: CompactionAsk, failure: string): string {
  const parts = [
    `${POINTER_SUMMARY_PREFIX}: pi's summary of them could not be written (${redactAndCap(failure, 300)}). ` +
      "Nothing is lost — every one of those turns is in the session log: `recall` searches them by words or reads one whole " +
      "by its number, and your notes for this thread (`notes`) are the place to keep what you still need from them.",
  ];
  const previous = ask.previousSummary?.trim();
  if (previous) parts.push(`The summary the compaction before this one left:\n${previous}`);
  if (ask.readFiles.length > 0) parts.push(`<read-files>\n${ask.readFiles.join("\n")}\n</read-files>`);
  if (ask.modifiedFiles.length > 0) parts.push(`<modified-files>\n${ask.modifiedFiles.join("\n")}\n</modified-files>`);
  return parts.join("\n\n");
}
