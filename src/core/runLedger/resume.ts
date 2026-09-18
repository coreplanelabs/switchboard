// Planning a resume (docs/reference/specs/run-history.md item 37): what a new generation
// does with a reclaimed run's transcript and last step record, decided purely
// so the rule is one place and testable without a runner. The runner then
// re-enters its loop from the plan (`RunOptions.resume`).
//
// The settlement rule (plan D4): the step in flight at the kill dispatched
// tool calls whose results were lost with the process. Never re-issue a
// command whose effects are unknown — `bash` and the GitHub writes get a
// synthetic result telling the model to re-check before re-running; every
// side-effect-free tool (reads, GitHub reads, web, skills), `write_file`
// (idempotent), `update_status` and the `submit_*` recorders are simply run
// again; a tool that no longer exists after the deploy gets a synthetic result
// saying so (D3). Every tool_use in the turn gets exactly one tool_result, so
// the conversation the model sees next is valid.
//
// A transcript that ends on the model's final answer (a text-only assistant
// turn, nothing in flight) is a loop that had ended: the plan is `finish`, the
// answer that turn's text, and the run loop skips the model and runs the
// post-steps with it. How the loop ended (a soft stop, a budget) is read back
// from the run's notes (`loopEndingOf`), and a verdict a previous generation
// already posted is read off its `review_posted` event (`reviewPostedBefore`)
// so the post-step never posts twice.

import type { ChatMessage, ContentPart } from "../chatMessage.js";
import type { ReviewPost } from "../reviewVerdict.js";
import type { RunEvent, RunNoteKind } from "../runEvents.js";
import { transcriptCompleteness } from "./decisions.js";
import type { AssembledCompaction, AssembledTranscript } from "./transcript.js";
import type { LiveRunMeta, StepRecord } from "./types.js";

/** Where a reclaimed run's rows are (docs/reference/specs/session-log.md item 3): its
 *  session log from the index its seed began at, or — for a row claimed before
 *  the log existed — the run's own transcript object. */
export type TranscriptSource = { kind: "session"; key: string; from: number } | { kind: "run" };

export function transcriptSource(meta: LiveRunMeta): TranscriptSource {
  return meta.session ? { kind: "session", key: meta.session.key, from: meta.session.seedFrom } : { kind: "run" };
}

/** The tool_use content part, as the runner names it. */
export type ToolUsePart = Extract<ContentPart, { type: "tool_use" }>;

/** What the planner needs to know about a tool: that it exists, and whether re-running it is safe. */
export interface KnownTool {
  name: string;
  sideEffectFree?: true;
}

export type Settlement =
  { toolUse: ToolUsePart; action: "rerun" } | { toolUse: ToolUsePart; action: "synthetic"; text: string };

export type ResumePlan =
  | { kind: "interrupted"; why: string }
  | {
      kind: "resume";
      /** The exact conversation the model had, from the ledger. */
      messages: ChatMessage[];
      /** pi's compaction entries among those messages (session-log item 6), so
       *  a rebuilt session file keeps each summary where pi wrote it. */
      compactions: AssembledCompaction[];
      /** The calls of the last assistant turn, each with how it is settled — empty
       *  when nothing was in flight (killed between steps, or before the first). */
      settlements: Settlement[];
      /** Whether the step being settled already has its record on the ledger
       *  (`resume`: yes; `run-step-fresh`: its turns landed, the record did not). */
      stepRecorded: boolean;
      /** The last record's inbox seq: the runner's counter starts there (item 40). */
      inboxConsumedSeq: number;
      /** The step number of the step being settled (or the seed record's, 0). */
      step: number;
      turn: number;
      iteration: number;
      remainingMs: number;
    }
  | {
      /** The model's loop had ended: the transcript's last turn is its final
       *  answer (text alone, nothing in flight). No model call is owed, only
       *  the post-steps and the reply, with that answer in hand. */
      kind: "finish";
      /** The conversation as the model left it, for a post-step that needs it (the settle's re-review turn). */
      messages: ChatMessage[];
      /** The final turn's text, unlabelled: the run loop puts the ending's label on it. */
      answer: string;
      /** The last record's inbox seq (item 40): follow-ups past it were never read by the loop. */
      inboxConsumedSeq: number;
      /** The final turn's step number and turn count, as the record has them or as an unrecorded step would. */
      step: number;
      turn: number;
      remainingMs: number;
    };

/** The built-in tools that are safe to run again although they are not
 *  side-effect-free: `update_status` and the `submit_*` recorders only set
 *  dispatcher state. A closed list — anything else that mutates (a shell
 *  command, a file write, a GitHub write, a bridged MCP tool that creates a
 *  ticket) has effects a restart makes unknowable, and is never re-issued. On
 *  the pi harness no call is re-run: the action decides the words of the
 *  restart note the rebuilt session ends on (harness-pi.md item 8). */
export const RERUN_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "update_status",
  "request_input",
  "submit_verdict",
  "submit_pr_description",
  "submit_handoff",
  "submit_dispositions",
]);

/** A call runs again iff its tool is side-effect-free or on the rerun-safe
 *  list; every other known tool gets the restart result; a tool that no longer
 *  exists gets the not-available result. The default is the synthetic result:
 *  re-running is the exception that must be earned. */
export function settlementFor(toolUse: ToolUsePart, tools: ReadonlyMap<string, KnownTool>): Settlement {
  const tool = tools.get(toolUse.name);
  if (!tool) {
    return {
      toolUse,
      action: "synthetic",
      text: `Tool ${toolUse.name} is not available after the bot restarted; continue without it.`,
    };
  }
  if (tool.sideEffectFree || RERUN_SAFE_TOOLS.has(toolUse.name)) return { toolUse, action: "rerun" };
  return {
    toolUse,
    action: "synthetic",
    text: `The bot restarted while this ${toolUse.name} call was in flight; its effects are unknown — re-check them before re-running it.`,
  };
}

const toolUsesOf = (message: ChatMessage | undefined): ToolUsePart[] =>
  message?.role === "assistant"
    ? (message.content as ContentPart[]).filter((p): p is ToolUsePart => p.type === "tool_use")
    : [];

/** The text of a turn as the runner collects an answer: the text parts joined by newlines, trimmed. */
const textOf = (message: ChatMessage): string =>
  (message.content as ContentPart[])
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();

/** How the model's loop ended, read back from the notes the previous
 *  generation published (the new generation's `RunControl` knows no stop and
 *  its deadline is not the run's): `answered` is a loop the model ended by
 *  itself; `soft_stop` is an operator's soft stop, which the run loop restores
 *  so the status and the label are the stop's; `written_up` is a forced
 *  write-up whose note names why, for the label. A hard stop is no ending here:
 *  it unwinds without a finale, so no answer turn ever follows it. */
export type LoopEnding =
  { kind: "answered" } | { kind: "soft_stop" } | { kind: "written_up"; note: WriteUpNote; summary: string };

export type WriteUpNote = Extract<
  RunNoteKind,
  "time_budget_exhausted" | "turn_budget_exhausted" | "stuck_loop" | "sandbox_dead"
>;
const WRITE_UP_NOTES: ReadonlySet<string> = new Set<WriteUpNote>([
  "time_budget_exhausted",
  "turn_budget_exhausted",
  "stuck_loop",
  "sandbox_dead",
]);

/** The last ending note wins: the loop ends once, and the note before its finale is the one that ended it. */
export function loopEndingOf(events: readonly RunEvent[]): LoopEnding {
  let ending: LoopEnding = { kind: "answered" };
  for (const e of events) {
    if (e.type !== "run_note") continue;
    if (e.kind === "stopped" && e.mode === "soft") ending = { kind: "soft_stop" };
    else if (WRITE_UP_NOTES.has(e.kind))
      ending = { kind: "written_up", note: e.kind as WriteUpNote, summary: e.summary };
  }
  return ending;
}

/** What a resumed review already posted (agent-review item 18): the last
 *  `review_posted` event on the replayed events is the post-step's outcome,
 *  so the post-step is not run again. Undefined when nothing was posted. */
export function reviewPostedBefore(events: readonly RunEvent[]): Extract<ReviewPost, { posted: true }> | undefined {
  let posted: Extract<ReviewPost, { posted: true }> | undefined;
  for (const e of events) {
    if (e.type !== "review_posted") continue;
    posted = {
      posted: true,
      target: { repo: e.repo, number: e.number },
      head: e.head,
      ...(e.verdict !== undefined ? { verdict: e.verdict } : {}),
    };
  }
  return posted;
}

export function planResume(input: {
  transcript: AssembledTranscript;
  lastStep: StepRecord | null;
  tools: Iterable<KnownTool>;
}): ResumePlan {
  const { transcript, lastStep } = input;
  if (!lastStep) return { kind: "interrupted", why: "no step record: killed before its conversation was stored" };
  if (!transcript.complete) return { kind: "interrupted", why: `transcript incomplete: ${transcript.gap}` };
  const completeness = transcriptCompleteness({
    lastStep,
    seedTurns: lastStep.turnIndex,
    transcriptTurns: transcript.turns,
  });
  if (completeness.kind === "interrupted") return completeness;
  const tools = new Map<string, KnownTool>();
  for (const t of input.tools) tools.set(t.name, t);
  const messages = transcript.messages;
  const last = messages[messages.length - 1];
  const calls = toolUsesOf(last);

  if (completeness.kind === "resume") {
    // The step's record landed, so its turns are all there; the calls named
    // in flight were dispatched and their results died with the process.
    if (lastStep.inFlight.length === 0) {
      // Nothing dispatched: killed between steps (or after the seed), or after
      // the model's final answer. A user turn (the seed, or a results turn) is
      // where the model continues; a text-only assistant turn is the answer
      // itself, the loop over and only the post-steps owed. An assistant turn
      // WITH calls the record does not know is neither: corruption.
      if (last?.role === "assistant") {
        if (calls.length > 0) {
          return {
            kind: "interrupted",
            why: "transcript ends with an assistant turn carrying tool calls but the last step recorded nothing in flight",
          };
        }
        return {
          kind: "finish",
          messages,
          answer: textOf(last),
          inboxConsumedSeq: lastStep.inboxConsumedSeq,
          step: lastStep.step,
          turn: lastStep.turn,
          remainingMs: lastStep.remainingMs,
        };
      }
      return {
        kind: "resume",
        messages,
        compactions: transcript.compactions,
        settlements: [],
        stepRecorded: true,
        inboxConsumedSeq: lastStep.inboxConsumedSeq,
        step: lastStep.step,
        turn: lastStep.turn,
        iteration: lastStep.iteration,
        remainingMs: lastStep.remainingMs,
      };
    }
    // The turn's calls and the recorded calls must be the same set: a call
    // the record does not know, or a recorded call the turn does not carry,
    // is corruption — the model must never be left with an unsettled call.
    const recorded = new Set(lastStep.inFlight.map((c) => c.callId));
    if (calls.length === 0 || calls.length !== recorded.size || !calls.every((c) => recorded.has(c.id))) {
      return {
        kind: "interrupted",
        why: `the last step's calls in flight (${[...recorded].join(", ")}) do not match the transcript's last assistant turn`,
      };
    }
    return {
      kind: "resume",
      messages,
      compactions: transcript.compactions,
      settlements: calls.map((c) => settlementFor(c, tools)),
      stepRecorded: true,
      inboxConsumedSeq: lastStep.inboxConsumedSeq,
      step: lastStep.step,
      turn: lastStep.turn,
      iteration: lastStep.iteration,
      remainingMs: lastStep.remainingMs,
    };
  }

  // run-step-fresh: the next step's turns landed (the previous results and
  // this assistant turn) but its record did not, so nothing of it was
  // dispatched — its tools simply run, all of them. A turn without calls is
  // the final answer whose record never landed: the same finish, the counters
  // advanced as for any unrecorded step.
  if (calls.length === 0) {
    if (last?.role !== "assistant") {
      return { kind: "interrupted", why: "the next step's turns landed but they do not end on an assistant turn" };
    }
    return {
      kind: "finish",
      messages,
      answer: textOf(last),
      inboxConsumedSeq: lastStep.inboxConsumedSeq,
      step: lastStep.step + 1,
      turn: lastStep.turn + 1,
      remainingMs: lastStep.remainingMs,
    };
  }
  const bookkeepingOnly = calls.every((c) => c.name === "update_status");
  return {
    kind: "resume",
    messages,
    compactions: transcript.compactions,
    settlements: calls.map((c) => ({ toolUse: c, action: "rerun" as const })),
    stepRecorded: false,
    inboxConsumedSeq: lastStep.inboxConsumedSeq,
    step: lastStep.step + 1,
    turn: lastStep.turn + (bookkeepingOnly ? 0 : 1),
    iteration: lastStep.iteration + 1,
    remainingMs: lastStep.remainingMs,
  };
}
