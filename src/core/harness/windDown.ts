// The wind-down wording (docs/reference/specs/harness-pi.md items 6 and 15):
// what the harness tells the model and the thread when a run is warned, cut
// off or stopped. Named once, so the steer pi is sent, the `run_note` the card
// shows and the label the thread's answer wears say the same thing — and so a
// resumed run's answer (`answerUnderEnding` in the run loop) is labelled as
// the loop that wrote it would have labelled it. The native turn loop said
// these words before record 0032's series deleted it; the harness kept them.

/** The one-line outcome of a hard stop: no write-up was run, so this IS the
 *  answer the thread gets. */
export const HARD_STOP_MESSAGE =
  "⛔ Run aborted by an operator (hard stop). No summary was written; partial work may exist in the workspace.";

/** The prompt a resumed process continues on after the bot restarted mid-run
 *  (harness-pi.md item 8): the same words for a process re-attached to and for
 *  one rebuilt from the record, on every harness, so the record reads one
 *  continue whichever way the run came back. */
export const CONTINUE_PROMPT =
  "Continue where you left off: the bot restarted mid-run, so re-check the effects of your last command before relying on them.";

/** The wrap-up warning's card and note text, at `minutesLeft`. */
export const wrapUpNote = (minutesLeft: number): string => `~${minutesLeft} min left — signaling wrap-up`;
/** The wrap-up warning as the model reads it, steered into the run once as the deadline nears. */
export const wrapUpInstruction = (minutesLeft: number): string =>
  `⏱ Time budget: about ${minutesLeft} minute(s) of tool time remain before cutoff. Finish your current check and start consolidating your answer; prefer writing up over starting new exploration.`;

/** What every forced write-up asks for, after the reason. */
export const WRITE_UP_REQUEST =
  "Write your final answer now from what you have learned so far: report your findings/results to date, then state plainly which parts of the task you did not get to and what a follow-up (in this thread, to reuse this workspace) should focus on.";
export const timeBudgetInstruction = (): string =>
  `You have reached the time budget and can make no more tool calls. ${WRITE_UP_REQUEST}`;
export const turnGuardInstruction = (pace: string): string =>
  `You have hit the run's turn guard — ${pace}, a pace that looks like a loop — and can make no more tool calls. ${WRITE_UP_REQUEST}`;
export const SOFT_STOP_INSTRUCTION =
  "An operator has asked this run to stop. You can make no more tool calls. Write your final answer now from what " +
  "you have learned so far: report your findings/results to date, then state plainly which parts of the task you " +
  "did not get to and what a follow-up (in this thread, to reuse this workspace) should focus on.";

/** The turn guard's pace, as its note and its answer say it: `<N> model turn(s) in <M>`. */
export const turnGuardPace = (turns: number, elapsedMs: number): string =>
  `${turns} model turn${turns === 1 ? "" : "s"} in ${elapsedMinutes(elapsedMs)}`;
export const timeBudgetNote = (): string => "time budget exhausted — writing up findings so far";
export const turnGuardNote = (pace: string): string =>
  `turn guard fired: ${pace}, a pace that looks like a loop — writing up findings so far`;
export const softStopNote = (): string => "soft stop — no further steps, writing up findings so far";
export const hardStopNote = (): string => "hard stop — run aborted, no summary written";

/** The thread's answer when the wall clock ran out: the write-up under its label, or the reason alone. */
export const timeBudgetAnswer = (text: string, maxMinutes: number): string =>
  text
    ? `⚠️ _Hit the ${maxMinutes}-minute budget before finishing — findings so far:_\n\n${text}`
    : `Stopped at the ${maxMinutes}-minute budget without finishing. Partial work may exist in the workspace — narrow the task and try again.`;
/** The thread's answer when the turn guard fired. */
export const turnGuardAnswer = (text: string, pace: string): string =>
  text
    ? `⚠️ _Stopped after ${pace} — that pace looks like a loop; findings so far:_\n\n${text}`
    : `Stopped after ${pace} — that pace looks like a loop — without finishing. Partial work may exist in the workspace — look for a retry loop in the run's events before trying again.`;

/** The thread's answer after a soft stop. */
export const softStopAnswer = (text: string): string =>
  text
    ? `⏹ _Stopped early by an operator (soft stop) — findings so far:_\n\n${text}`
    : "⏹ Stopped early by an operator (soft stop) before any findings were written. Partial work may exist in the workspace.";

function elapsedMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
