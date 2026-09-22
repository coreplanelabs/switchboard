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
/** The gate's refusal of a bash call whose explicit timeout reaches past the
 *  loop's end (harness-pi item 7; the loop's end cuts what still runs, decision
 *  0046 unit seven): said before the command runs, in whole seconds, with the
 *  two ways forward — instead of the minutes a command that could never finish
 *  would spend before the cut told the model. `askedSecs` is the timeout the
 *  call named, `leftSecs` what remains before the loop ends. */
export const commandPastLoopEndRefusal = (askedSecs: number, leftSecs: number): string =>
  `budget — this command asked for a ${askedSecs} s timeout and the loop ends in ${leftSecs} s, so it could never finish. ` +
  `A timeout inside the ${leftSecs} s left can still finish; otherwise the current work and write-up stand, and CI owns full verification.`;
export const turnGuardNote = (pace: string): string =>
  `turn guard fired: ${pace}, a pace that looks like a loop — writing up findings so far`;
export const softStopNote = (): string => "soft stop — no further steps, writing up findings so far";
export const hardStopNote = (): string => "hard stop — the run was aborted, no summary written";
/** A model call that failed once the run was winding down — the finale bound's
 *  own abort of a call in flight included — is a note on the record, never the
 *  ending: the write-up's answer stands, and this says what failed under it. */
export const windDownFailureNote = (error: string, closes: "run" | "turn" = "run"): string =>
  `the model call failed during the wind-down (${error}); the ${closes} closes with its findings so far`;
/** The finale bound ending a wait that was not on a model call (harness.md
 *  items 5 and 13, OpenCode): a tool call open when the bound fell — the
 *  loop-end cut's tool with its interrupt still unanswered
 *  (`interruptUnanswered`), or a tool the write-up's own execution made —
 *  said as the wait it was, never as a model call that failed. `doing` is
 *  what the run was at (`doingWords`), `reason` the bound's own words. */
export const finaleWaitNote = (
  reason: string,
  doing: string | undefined,
  interruptUnanswered: boolean,
  closes: "run" | "turn" = "run",
): string =>
  `the finale bound ended the wait${doing ? ` while ${doing}` : ""}${interruptUnanswered ? ", the loop-end interrupt unanswered" : ""} (${reason}); the ${closes} closes with its findings so far`;
/** The card's line when the finale bound ends a write-up that never came. */
export const finaleTimedOutNote = (closes: "run" | "turn" = "run"): string =>
  `finale timed out — closing the ${closes} without a write-up`;
/** The card's line when the loop ended with its wrap-up instruction still held
 *  behind a prompt in doubt (harness-pi item 16): pi finished on its own and
 *  never saw it, so the answer wears no wind-down label. */
export const wrapUpUndeliveredNote = (kind: "time" | "turns" | "soft", closes: "run" | "turn" = "run"): string =>
  `the ${wrapUpName(kind)} wrap-up instruction never reached pi — held behind a prompt in doubt when pi settled — so the ${closes} closes on pi's own answer, unlabelled`;
/** How a never-posted wrap-up's wait ended (harness.md item 13): the loop-end
 *  interrupt found the session idle, the execution having `finished` on its
 *  own or `failed` on the provider during the round-trip; or the interrupt was
 *  never answered and the `finale` bound ended the wait. */
export type NeverPostedEnd = "finished" | "failed" | "finale";
/** The card's line when OpenCode's loop-end cut posted no wrap-up instruction
 *  (`NeverPostedEnd` says how the wait ended): the model never saw it, so the
 *  answer is its own and wears no wind-down label — the same rule as pi's
 *  undelivered wrap-up. */
export const wrapUpNeverPostedNote = (
  kind: "time" | "turns" | "soft",
  closes: "run" | "turn" = "run",
  ended: NeverPostedEnd = "finished",
): string =>
  `the ${wrapUpName(kind)} wrap-up instruction was never posted — ${
    ended === "finale"
      ? "the loop-end interrupt was never answered, the finale bound ending the wait"
      : `the loop-end interrupt found the session idle, the execution having ${ended === "failed" ? "failed on the provider" : "finished on its own"}`
  } — so the ${closes} closes on OpenCode's own answer, unlabelled`;
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
 *  model call (or, for OpenCode, a tool call) the wind-down waited on failed
 *  or the finale bound ended the wait: the thread reads why there are no
 *  findings while the run still ends by the wind-down's words. `onTool` true
 *  when the finale fell on a tool call, not a model call — the wording differs
 *  so the thread is not told a model call failed where none did. */
const noWriteUp = (failed: string | undefined, onTool?: true): string =>
  failed
    ? onTool
      ? `; the finale bound ended the wait on a tool call (${failed}), so no write-up came`
      : `; the model call failed during the wind-down (${failed}), so no write-up came`
    : "";

// ---- what the ending established (item 6) -----------------------------------
//
// The harness composes its answer when its loop ends, before the run loop's
// salvage, description turn and PR post-step have run — so the harness cannot
// know what the tree held or where it went. It hands the loop its ending
// instead (`WindDownEnding`, on `HarnessSession.ending`) and the loop composes
// the thread's answer from it once those steps have established the facts
// (`EndingFacts`), through the one composer below (`windDownAnswer`). The
// harness's own answer is the same composer with no facts, so a run whose tail
// never runs ends by the same words it always did.

/** What the run's tail established about its workspace, in the words the
 *  answer may use — never a guess where a measure was taken. */
export type WorkspaceAtEnd =
  /** The run had no workspace (machine class `none`). */
  | { kind: "none" }
  /** The tree was not read: the run observes no tree, or its tail was skipped. */
  | { kind: "unread" }
  /** A measure the observation could not take, so nothing is read as clean. */
  | { kind: "unmeasured" }
  /** Measured clean with nothing unpushed; `head` the tip when it was read —
   *  on the remote, since no commit of the branch is unpushed. */
  | { kind: "clean"; branch?: string; head?: string }
  /** The budget salvage pushed what the tree held to `branch`, at `head`. */
  | { kind: "salvaged"; branch: string; head?: string }
  /** Work measured in the tree that nothing pushed, and its fate: `kept` for
   *  the thread by a cold workspace's if-idle release, `discarded` at the
   *  run's end by a resident's (a run starts from a clean tree), `torn_down`
   *  when the ending may have left a command running in it. */
  | { kind: "left"; uncommitted: number; unpushed: number; fate: "kept" | "discarded" | "torn_down" };

/** The facts the run loop hands the composer once the post-steps have run, in
 *  the answer's precedence: the tree, then the description. Absent fields are
 *  facts the loop could not establish, and the words say only what is known. */
export interface EndingFacts {
  workspace?: WorkspaceAtEnd;
  /** Whether a PR description was submitted by the run's end — by the loop or
   *  by the description turn; absent for a run that submits none. */
  description?: "submitted" | "not_submitted";
}

/** A wind-down's ending as the harness hands it to the run loop: the label's
 *  kind, the text the model settled on (empty when no write-up came), and the
 *  failed call when that is why. `writeUpFailedOnTool` true when the finale
 *  bound fell on a tool call rather than a model call (OpenCode only), so the
 *  thread answer's clause is worded as a wait, not a failed model call. */
export type WindDownEnding =
  | { kind: "time"; text: string; writeUpFailed?: string; writeUpFailedOnTool?: true }
  | { kind: "turns"; pace: string; text: string; writeUpFailed?: string; writeUpFailedOnTool?: true }
  | { kind: "soft"; text: string; writeUpFailed?: string; writeUpFailedOnTool?: true }
  /** No wind-down label applies (the wrap-up never reached the model) but a
   *  failure ended the wait: what ended it is said (`unlabelledAnswer`). */
  | { kind: "unlabelled"; text: string; writeUpFailed: string; ended: "failed" | "finale" };

/** The ending a harness hands over beside its answer: the wind-down that
 *  labelled it, with the text and the failed call; the unlabelled ending when a
 *  failure ended a wait no label owns; nothing when the answer is the model's
 *  own. Each harness reads its wind-down state into this one shape.
 *  `writeUpFailedOnTool` true when the finale fell on a tool call (OpenCode). */
export function windDownEndingOf(
  writeUp: { kind: "time" } | { kind: "turns"; pace: string } | { kind: "soft" } | undefined,
  text: string,
  writeUpFailed: string | undefined,
  ended: "failed" | "finale" = "failed",
  writeUpFailedOnTool?: true,
): WindDownEnding | undefined {
  const failed =
    writeUpFailed !== undefined
      ? writeUpFailedOnTool
        ? { writeUpFailed, writeUpFailedOnTool }
        : { writeUpFailed }
      : {};
  if (writeUp?.kind === "time") return { kind: "time", text, ...failed };
  if (writeUp?.kind === "turns") return { kind: "turns", pace: writeUp.pace, text, ...failed };
  if (writeUp?.kind === "soft") return { kind: "soft", text, ...failed };
  if (writeUpFailed !== undefined) return { kind: "unlabelled", text, writeUpFailed, ended };
  return undefined;
}

/** The thread's answer for an ending, with the facts the run loop established
 *  (none: the harness's own words, before the tail ran). */
export function windDownAnswer(ending: WindDownEnding, maxMinutes: number, facts?: EndingFacts): string {
  switch (ending.kind) {
    case "time":
      return timeBudgetAnswer(ending.text, maxMinutes, ending.writeUpFailed, facts, ending.writeUpFailedOnTool);
    case "turns":
      return turnGuardAnswer(ending.text, ending.pace, ending.writeUpFailed, facts, ending.writeUpFailedOnTool);
    case "soft":
      return softStopAnswer(ending.text, ending.writeUpFailed, facts, ending.writeUpFailedOnTool);
    case "unlabelled":
      return unlabelledAnswer(ending.text, ending.writeUpFailed, ending.ended, facts);
  }
}

const TIME_ADVICE = "this is a bug: the task outlived its run budget and no automatic continuation was scheduled";
const TURN_ADVICE = "this is a bug: a retry loop spent the turn guard and no automatic recovery was scheduled";
const shortSha = (sha: string): string => sha.slice(0, 7);
const counted = (w: { uncommitted: number; unpushed: number }): string =>
  `${w.uncommitted} uncommitted change(s) and ${w.unpushed} unpushed commit(s)`;

/** The sentences of what was established, in the answer's precedence — the
 *  tree, then the description — or nothing when nothing was measured (no
 *  facts, `unread`, `none`). */
function established(facts: EndingFacts | undefined): string {
  const w = facts?.workspace;
  let tree = "";
  if (w?.kind === "unmeasured") tree = "The workspace could not be measured, so work may sit unpushed there.";
  else if (w?.kind === "clean")
    tree = `The tree was clean${w.branch ? ` and \`${w.branch}\` held no unpushed commits` : " with no unpushed commits"}${w.head ? ` — its head \`${shortSha(w.head)}\` is on the remote` : ""}.`;
  else if (w?.kind === "salvaged")
    tree = `What the tree held was pushed to \`${w.branch}\`${w.head ? ` at \`${shortSha(w.head)}\`` : ""} by the budget salvage, unreviewed — a follow-up starts from it.`;
  else if (w?.kind === "left")
    tree =
      w.fate === "kept"
        ? `${counted(w)} sit in the workspace, kept for this thread until it idles out — a follow-up here reuses them.`
        : w.fate === "discarded"
          ? `${counted(w)} were left in the tree and discarded at the run's end.`
          : `${counted(w)} were left in the tree, which is torn down since a command may still be running in it.`;
  const description =
    facts?.description === "submitted"
      ? "The PR description was submitted."
      : facts?.description === "not_submitted"
        ? "No PR description was submitted."
        : "";
  return [tree, description].filter((s) => s !== "").join(" ");
}

/** A gap is named only when work did not land anywhere a continuation can
 *  start from. It precedes the measured tree state so the answer closes on
 *  what the run loop established. */
function gapApplies(facts: EndingFacts | undefined): boolean {
  const w = facts?.workspace;
  return (
    w === undefined ||
    w.kind === "unread" ||
    w.kind === "unmeasured" ||
    w.kind === "none" ||
    (w.kind === "left" && w.fate !== "kept")
  );
}

/** The empty write-up's remaining sentences: the gap where recovery did not
 *  land, followed by what was established or the unmeasured-work guess. */
function nothingWritten(facts: EndingFacts | undefined, gap: string | undefined): string {
  const gapSentence = gap && gapApplies(facts) ? `${gap.charAt(0).toUpperCase()}${gap.slice(1)}.` : "";
  const known = established(facts);
  if (known) return ` ${[gapSentence, known].filter((s) => s !== "").join(" ")}`;
  if (facts?.workspace?.kind === "none") return gapSentence ? ` ${gapSentence}` : "";
  return ` Partial work may exist in the workspace${gap ? ` — ${gap}` : ""}.`;
}

/** The label's join before the write-up: the facts as sentences when there
 *  are any, else the dash the label always had. */
function beforeFindings(facts: EndingFacts | undefined): string {
  const known = established(facts);
  return known ? `. ${known} Findings so far:` : " — findings so far:";
}

/** The thread's answer when the wall clock ran out: the write-up under its
 *  label, or the reason alone — naming the failed model call (or tool wait for
 *  OpenCode) when that is why no write-up came (`writeUpFailed`) — and what
 *  the ending established (`facts`) where the run loop has it. */
export const timeBudgetAnswer = (
  text: string,
  maxMinutes: number,
  writeUpFailed?: string,
  facts?: EndingFacts,
  writeUpFailedOnTool?: true,
): string =>
  text
    ? `⚠️ _Hit the ${maxMinutes}-minute budget before finishing${beforeFindings(facts)}_\n\n${text}`
    : `Stopped at the ${maxMinutes}-minute budget without finishing${noWriteUp(writeUpFailed, writeUpFailedOnTool)}.${nothingWritten(facts, TIME_ADVICE)}`;
/** The thread's answer when the turn guard fired. */
export const turnGuardAnswer = (
  text: string,
  pace: string,
  writeUpFailed?: string,
  facts?: EndingFacts,
  writeUpFailedOnTool?: true,
): string =>
  text
    ? `⚠️ _Stopped after ${pace} — that pace looks like a loop${established(facts) ? beforeFindings(facts) : "; findings so far:"}_\n\n${text}`
    : `Stopped after ${pace} — that pace looks like a loop — without finishing${noWriteUp(writeUpFailed, writeUpFailedOnTool)}.${nothingWritten(facts, TURN_ADVICE)}`;

/** The thread's answer when no wind-down label applies — the wrap-up never
 *  reached the model (OpenCode's never-posted prompt) — with what ended the
 *  wait said when it was a failure (`writeUpFailed`, the reason): a model call
 *  that failed under the wind-down, or the finale bound ending a wait on an
 *  interrupt never answered (`ended`) — so what the record holds reaches the
 *  thread too: after the model's own last text when there is one, alone when
 *  there is none, then what the ending established. */
export const unlabelledAnswer = (
  text: string,
  writeUpFailed?: string,
  ended: "failed" | "finale" = "failed",
  facts?: EndingFacts,
): string => {
  if (!writeUpFailed) return text || "_(no response)_";
  if (ended === "finale")
    return text
      ? `${text}\n\n⚠️ _The write-up never started: the loop-end interrupt went unanswered and the finale bound ended the wait (${writeUpFailed}); this is the last answer before it._`
      : `⚠️ The write-up never started: the loop-end interrupt went unanswered and the finale bound ended the wait (${writeUpFailed}).${nothingWritten(facts, undefined)}`;
  return text
    ? `${text}\n\n⚠️ _The model call that followed failed (${writeUpFailed}); this is the last answer before it._`
    : `⚠️ The model call failed (${writeUpFailed}) and no answer came.${nothingWritten(facts, undefined)}`;
};
/** The thread's answer after a soft stop. */
export const softStopAnswer = (
  text: string,
  writeUpFailed?: string,
  facts?: EndingFacts,
  writeUpFailedOnTool?: true,
): string =>
  text
    ? `⏹ _Stopped early by an operator (soft stop)${beforeFindings(facts)}_\n\n${text}`
    : `⏹ Stopped early by an operator (soft stop) before any findings were written${noWriteUp(writeUpFailed, writeUpFailedOnTool)}.${nothingWritten(facts, undefined)}`;

function elapsedMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
