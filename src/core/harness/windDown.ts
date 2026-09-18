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
/** What a bridge says the run was at when no tool call is open and the model
 *  has a turn under way (`doingNow`): the same words on every harness. */
export const MODEL_CALL_IN_FLIGHT = "a model call was in flight";
/** The budget's note, at the loop's end — the lease's end less the write-up
 *  and the post-step it holds back (decision 0046); `doing` is what the run
 *  was at (the open tool calls by name, or `MODEL_CALL_IN_FLIGHT`), when the
 *  bridge can say. */
export const timeBudgetNote = (doing?: string): string =>
  doing
    ? `the loop's time is up while ${doing} — writing up findings so far inside the lease`
    : "the loop's time is up — writing up findings so far inside the lease";
/** The loop's end found a tool call in flight and ended it (decision 0046,
 *  unit seven): the write-up keeps its whole allowance instead of waiting the
 *  command out; `doing` is the bridge's `running <tools>`. */
export const toolCutNote = (doing: string): string =>
  `the loop's end cut the command in flight (${doing}) so the write-up keeps its allowance`;
export const turnGuardNote = (pace: string): string =>
  `turn guard fired: ${pace}, a pace that looks like a loop — writing up findings so far`;
export const softStopNote = (): string => "soft stop — no further steps, writing up findings so far";
export const hardStopNote = (): string => "hard stop — run aborted, no summary written";
/** A model call that failed once the run was winding down — the finale bound's
 *  own abort of a call in flight included — is a note on the record, never the
 *  ending: the write-up's answer stands, and this says what failed under it. */
export const windDownFailureNote = (error: string, closes: "run" | "turn" = "run"): string =>
  `the model call failed during the wind-down (${error}); the ${closes} closes with its findings so far`;
/** The card's line when the finale bound ends a write-up that never came. */
export const finaleTimedOutNote = (closes: "run" | "turn" = "run"): string =>
  `finale timed out — closing the ${closes} without a write-up`;
/** The card's line when the loop ended with its wrap-up instruction still held
 *  behind a prompt in doubt (harness-pi item 16): pi finished on its own and
 *  never saw it, so the answer wears no wind-down label. */
export const wrapUpUndeliveredNote = (kind: "time" | "turns" | "soft", closes: "run" | "turn" = "run"): string =>
  `the ${wrapUpName(kind)} wrap-up instruction never reached pi — held behind a prompt in doubt when pi settled — so the ${closes} closes on pi's own answer, unlabelled`;
/** The card's line when OpenCode's loop-end cut found the session idle (the
 *  tool completed and the execution finished on its own during the interrupt's
 *  round-trip; harness.md item 13): the wrap-up instruction was never posted,
 *  so the answer is the model's own and wears no wind-down label — the same
 *  rule as pi's undelivered wrap-up. */
export const wrapUpNeverPostedNote = (kind: "time" | "turns" | "soft", closes: "run" | "turn" = "run"): string =>
  `the ${wrapUpName(kind)} wrap-up instruction was never posted — the loop-end interrupt found the session idle, the execution having finished on its own — so the ${closes} closes on OpenCode's own answer, unlabelled`;
/** The card's line when the wrap-up instruction's write failed with the
 *  control plane's reset (harness-pi item 16): a steer is never resolved by a
 *  re-send, so the finale's clock is not started on an instruction pi may
 *  never have got; the loop asks again, and the clock starts when that lands. */
export const wrapUpWriteFailedNote = (kind: "time" | "turns" | "soft", closes: "run" | "turn" = "run"): string =>
  `the ${wrapUpName(kind)} wrap-up instruction's write failed with the control plane's reset; the ${closes} asks again once re-attached, and its finale clock starts when that instruction lands`;
/** The record's line when an abort was dropped — nothing kept it, so pi was
 *  never told to stop (harness-pi item 16). No path reaches it today; the note
 *  is what makes a swallowed stop seen rather than assumed. */
export const ABORT_DROPPED_NOTE = "the abort was dropped: no transport kept it, so pi was never told to stop";
/** The record's line when an abort's write failed with the control plane's
 *  reset (harness-pi item 16): the run's loop or a follow-up turn (`closes`)
 *  owes pi the stop and asks again on every tick until it lands. Written once,
 *  at the FIRST failure of a stop; the re-asks that fail after it write
 *  nothing, and `abortReaskedNote` closes the series with the count — two
 *  lines, never one per tick. */
export const abortWriteFailedNote = (closes: "run" | "turn" = "run"): string =>
  `the abort's write failed with the control plane's reset; the ${closes} asks pi to stop again on every tick until the stop lands`;
/** The record's closing line of a stop the loop or turn (`closes`) had to ask
 *  again for (harness-pi item 16), written once: when a stop `landed` — any
 *  sender's, the re-ask's or another's — a `stop_landed` note, since it says
 *  the series closed well; or when the loop or turn ended with the stop still
 *  `unheard` — owed with no tick yet run to ask, or no stop in flight to hear
 *  — a `harness_error`; each saying how many times the tick asked. With
 *  `abortWriteFailedNote` at the first failure these are the series' two
 *  lines; a re-ask is never a line. */
export const abortReaskedNote = (
  times: number,
  outcome: "landed" | "unheard",
  closes: "run" | "turn" = "run",
): string => {
  const asked = timesWord(times);
  if (outcome === "landed")
    return times === 0
      ? `the stop landed before the ${closes} could ask again`
      : `the stop landed after the ${closes} asked pi to stop again ${asked}`;
  return times === 0
    ? `the ${closes} ended with the stop still unheard, before it could ask again`
    : `the ${closes} ended with the stop still unheard, after asking pi to stop again ${asked}`;
};
/** The record's line when a stop sent while the loop or turn (`closes`) was
 *  live failed its write only after the loop or turn had ended — the hard
 *  stop's or a gate bypass's abort, which the same tick sends and breaks on;
 *  the recovery's deadline abort on a run its throw ends; the last re-ask of a
 *  series still in flight when pi settled by itself (harness-pi item 16): the
 *  ended loop asks nothing again, so this one line is what makes the swallowed
 *  stop seen — the series' closing line, with its count of re-asks (`times`) —
 *  and the run's end kills pi. */
export const abortFailedAfterEndNote = (closes: "run" | "turn" = "run", times = 0): string =>
  `the stop's write failed with the control plane's reset after the ${closes} ended${times === 0 ? "" : `, after asking pi to stop again ${timesWord(times)}`}; nothing asks again, and the run's end kills pi`;
/** The record's line, written by the session's end BEFORE the run is marked
 *  finished, when a stop the loop or a turn (`closes`) sent is still in flight
 *  as the session ends (harness-pi item 16): its landing is unheard, and a
 *  landing after this line is not recorded — the registry drops content on a
 *  finished run — so this is the last word on the stop. What ended pi is the
 *  `ending`: the session's kill, or — on a container replaced under the run,
 *  where no kill runs — the replacement, whose relaunch the run loop carries
 *  on with. With the count of re-asks (`times`) on it, as the series' other
 *  closing lines carry. */
export const abortUnheardAtEndNote = (
  closes: "run" | "turn" = "run",
  times = 0,
  ending: "kill" | "replaced" = "kill",
): string => {
  const asked = times === 0 ? "" : `, after asking pi to stop again ${timesWord(times)}`;
  return ending === "kill"
    ? `the run ended with the ${closes}'s stop still in flight, its landing unheard${asked}; the kill ended pi`
    : `the container was replaced with the ${closes}'s stop still in flight, its landing unheard${asked}; the relaunch carries on`;
};
/** How many times, as the abort series' lines say it — one word for all the series' lines, so they cannot drift. */
const timesWord = (n: number): string => (n === 1 ? "once" : `${n} times`);
const wrapUpName = (kind: "time" | "turns" | "soft"): string =>
  kind === "time" ? "time-budget" : kind === "turns" ? "turn-guard" : "soft-stop";
/** The failed call's words when the finale bound itself is why no write-up
 *  came — the harness aborted the call in flight at the bound — for
 *  `windDownFailureNote` and the answer's `writeUpFailed` clause. */
export const finaleAbortReason = (boundMs: number): string =>
  `aborted at the finale bound (${elapsedMinutes(boundMs)})`;

/** The clause a wind-down answer carries when no write-up came because the
 *  model call the wind-down waited on failed: the thread reads why there are no
 *  findings while the run still ends by the wind-down's words. */
const noWriteUp = (failed: string | undefined): string =>
  failed ? `; the model call failed during the wind-down (${failed}), so no write-up came` : "";

/** The thread's answer when the wall clock ran out: the write-up under its
 *  label, or the reason alone — naming the failed model call when that is why
 *  no write-up came (`writeUpFailed`). */
export const timeBudgetAnswer = (text: string, maxMinutes: number, writeUpFailed?: string): string =>
  text
    ? `⚠️ _Hit the ${maxMinutes}-minute budget before finishing — findings so far:_\n\n${text}`
    : `Stopped at the ${maxMinutes}-minute budget without finishing${noWriteUp(writeUpFailed)}. Partial work may exist in the workspace — narrow the task and try again.`;
/** The thread's answer when the turn guard fired. */
export const turnGuardAnswer = (text: string, pace: string, writeUpFailed?: string): string =>
  text
    ? `⚠️ _Stopped after ${pace} — that pace looks like a loop; findings so far:_\n\n${text}`
    : `Stopped after ${pace} — that pace looks like a loop — without finishing${noWriteUp(writeUpFailed)}. Partial work may exist in the workspace — look for a retry loop in the run's events before trying again.`;

/** The thread's answer after a soft stop. */
export const softStopAnswer = (text: string, writeUpFailed?: string): string =>
  text
    ? `⏹ _Stopped early by an operator (soft stop) — findings so far:_\n\n${text}`
    : `⏹ Stopped early by an operator (soft stop) before any findings were written${noWriteUp(writeUpFailed)}. Partial work may exist in the workspace.`;

function elapsedMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
