// Planning a resume (features/run-history.md item 37): what a new generation
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

import type { ChatMessage, ContentPart } from "../../providers/types.js";
import { transcriptCompleteness } from "./decisions.js";
import type { AssembledTranscript } from "./transcript.js";
import type { StepRecord } from "./types.js";

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
    };

/** The built-in tools that are safe to run again although they are not
 *  side-effect-free: `write_file` is idempotent (the resident already re-issues
 *  it after a runtime swap), `update_status` and the `submit_*` recorders only
 *  set dispatcher state. A closed list — anything else that mutates (a shell
 *  command, a GitHub write, a bridged MCP tool that creates a ticket) has
 *  effects a restart makes unknowable, and is never re-issued. */
export const RERUN_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "update_status",
  "submit_verdict",
  "submit_pr_description",
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
      // Nothing dispatched: killed between steps (or after the seed). The
      // conversation must end on a user turn for the model to continue.
      if (last?.role !== "user") {
        return {
          kind: "interrupted",
          why: "transcript ends with an assistant turn but the last step recorded nothing in flight",
        };
      }
      return {
        kind: "resume",
        messages,
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
  // dispatched — its tools simply run, all of them.
  if (calls.length === 0) {
    return { kind: "interrupted", why: "the next step's turns landed but its assistant turn has no tool calls" };
  }
  const bookkeepingOnly = calls.every((c) => c.name === "update_status");
  return {
    kind: "resume",
    messages,
    settlements: calls.map((c) => ({ toolUse: c, action: "rerun" as const })),
    stepRecorded: false,
    inboxConsumedSeq: lastStep.inboxConsumedSeq,
    step: lastStep.step + 1,
    turn: lastStep.turn + (bookkeepingOnly ? 0 : 1),
    iteration: lastStep.iteration + 1,
    remainingMs: lastStep.remainingMs,
  };
}
