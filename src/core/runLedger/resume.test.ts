import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import {
  loopEndingOf,
  planResume,
  reviewPostedBefore,
  settlementFor,
  transcriptSource,
  type KnownTool,
  type ToolUsePart,
} from "./resume.js";
import type { StepRecord } from "./types.js";

// The resume plan (docs/reference/specs/run-history.md item 37): the pure rule for what a
// new generation does with a reclaimed transcript and step record, and the D4
// settlement of the calls that were in flight at the kill.

const text = (t: string) => ({ type: "text" as const, text: t });
const user = (t: string): ChatMessage => ({ role: "user", content: [text(t)] });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ToolUsePart => ({
  type: "tool_use",
  id,
  name,
  input,
});
const assistantCalling = (...calls: ToolUsePart[]): ChatMessage => ({
  role: "assistant",
  content: [text("working"), ...calls],
});
const results = (...ids: string[]): ChatMessage => ({
  role: "user",
  content: ids.map((id) => ({ type: "tool_result" as const, toolUseId: id, content: "ok" })),
});

const TOOLS: KnownTool[] = [
  { name: "bash" },
  { name: "write_file" },
  { name: "read_file", sideEffectFree: true },
  { name: "web_fetch", sideEffectFree: true },
  { name: "github_file", sideEffectFree: true },
  { name: "github_issue_comment" },
  { name: "update_status" },
  { name: "submit_verdict" },
  { name: "submit_handoff" },
  { name: "mcp_jira_create_ticket" }, // a bridged tool that mutates: known, not side-effect-free, not on the safe list
];
const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

const step = (over: Partial<StepRecord>): StepRecord => ({
  step: 1,
  seq: 5,
  turnIndex: 2,
  inFlight: [],
  inboxConsumedSeq: 7,
  remainingMs: 500_000,
  turn: 1,
  iteration: 0,
  ...over,
});

const complete = (messages: ChatMessage[]) => ({
  complete: true as const,
  turns: messages.length,
  messages,
  compactions: [],
});

describe("settlementFor — D4", () => {
  it("the default is the restart result: bash, GitHub writes and any other mutating tool (a bridged MCP tool) get it; only side-effect-free tools and the rerun-safe list run again; an unknown tool gets the not-available result", () => {
    expect(settlementFor(call("c", "bash", { command: "rm -rf build" }), toolMap)).toMatchObject({
      action: "synthetic",
      text: expect.stringMatching(/restarted while this bash call was in flight.*re-check/),
    });
    expect(settlementFor(call("c", "github_issue_comment"), toolMap)).toMatchObject({ action: "synthetic" });
    expect(settlementFor(call("c", "mcp_jira_create_ticket"), toolMap)).toMatchObject({
      action: "synthetic",
      text: expect.stringMatching(/restarted while this mcp_jira_create_ticket call was in flight/),
    });
    for (const name of [
      "read_file",
      "web_fetch",
      "github_file",
      "write_file",
      "update_status",
      "submit_verdict",
      "submit_handoff",
    ]) {
      expect(settlementFor(call("c", name), toolMap)).toEqual({ toolUse: call("c", name), action: "rerun" });
    }
    expect(settlementFor(call("c", "mcp_acme_search"), toolMap)).toMatchObject({
      action: "synthetic",
      text: "Tool mcp_acme_search is not available after the bot restarted; continue without it.",
    });
  });

  // docs/reference/specs/agent-conductor.md item 8: a wait is a read and runs
  // again; a steer pushed into a child's inbox is a mutation whose effect the
  // restart made unknowable, so it gets the restart result — never a second push.
  it("the run tools settle by the same rule: `await_runs` (side-effect free) runs again at a resume; `send_to_run` and `spawn_run` get the restart result", () => {
    const withRunTools = new Map<string, KnownTool>([
      ...toolMap,
      ["await_runs", { name: "await_runs", sideEffectFree: true }],
      ["send_to_run", { name: "send_to_run" }],
      ["spawn_run", { name: "spawn_run" }],
    ]);
    const awaited = call("a", "await_runs", { ids: ["run-1", "run-2"] });
    expect(settlementFor(awaited, withRunTools)).toEqual({ toolUse: awaited, action: "rerun" });
    expect(settlementFor(call("s", "send_to_run", { id: "run-1", text: "narrow it" }), withRunTools)).toMatchObject({
      action: "synthetic",
      text: expect.stringMatching(/restarted while this send_to_run call was in flight.*re-check/),
    });
    expect(settlementFor(call("p", "spawn_run", { preset: "research", prompt: "x" }), withRunTools)).toMatchObject({
      action: "synthetic",
      text: expect.stringMatching(/restarted while this spawn_run call was in flight/),
    });
  });
});

describe("planResume", () => {
  it("resume: the step's record landed and its calls were in flight — every call of the last assistant turn is settled by the D4 rule, the record's counters carry over", () => {
    const messages = [
      user("go"),
      assistantCalling(call("a", "read_file"), call("b", "bash"), call("c", "github_issue_comment")),
    ];
    const plan = planResume({
      transcript: complete(messages),
      lastStep: step({
        turnIndex: 2,
        inFlight: [
          { callId: "a", tool: "read_file" },
          { callId: "b", tool: "bash" },
          { callId: "c", tool: "github_issue_comment" },
        ],
        turn: 1,
        iteration: 0,
        remainingMs: 400_000,
      }),
      tools: TOOLS,
    });
    expect(plan).toMatchObject({
      kind: "resume",
      stepRecorded: true,
      step: 1,
      turn: 1,
      iteration: 0,
      remainingMs: 400_000,
      inboxConsumedSeq: 7, // the last record's: the runner's counter starts there (item 40)
    });
    if (plan.kind !== "resume") throw new Error("unreachable");
    expect(plan.messages).toBe(messages);
    expect(plan.settlements.map((s) => [s.toolUse.id, s.action])).toEqual([
      ["a", "rerun"],
      ["b", "synthetic"],
      ["c", "synthetic"],
    ]);
  });

  it("resume with nothing in flight (killed between steps, or right after the seed): no settlement, the loop simply continues from a user turn", () => {
    const messages = [user("go")];
    const plan = planResume({
      transcript: complete(messages),
      lastStep: step({ step: 0, turnIndex: 1, turn: 0 }),
      tools: TOOLS,
    });
    expect(plan).toMatchObject({
      kind: "resume",
      settlements: [],
      stepRecorded: true,
      step: 0,
      turn: 0,
      inboxConsumedSeq: 7,
    });
  });

  it("run-step-fresh: the next step's turns landed but its record did not — all of its calls run fresh, the counters advance, the step is unrecorded", () => {
    const messages = [
      user("go"),
      assistantCalling(call("a", "bash")),
      results("a"),
      assistantCalling(call("b", "bash"), call("c", "read_file")),
    ];
    const plan = planResume({
      transcript: complete(messages),
      lastStep: step({ turnIndex: 2, inFlight: [{ callId: "a", tool: "bash" }], turn: 1, iteration: 0 }),
      tools: TOOLS,
    });
    expect(plan).toMatchObject({ kind: "resume", stepRecorded: false, step: 2, turn: 2, iteration: 1 });
    if (plan.kind !== "resume") throw new Error("unreachable");
    expect(plan.settlements.map((s) => [s.toolUse.id, s.action])).toEqual([
      ["b", "rerun"], // fresh: nothing was dispatched, even bash runs
      ["c", "rerun"],
    ]);
  });

  it("a fresh step made only of update_status calls does not consume a turn (the runner's own rule)", () => {
    const messages = [
      user("go"),
      assistantCalling(call("a", "read_file")),
      results("a"),
      assistantCalling(call("s", "update_status")),
    ];
    const plan = planResume({
      transcript: complete(messages),
      lastStep: step({ turnIndex: 2, inFlight: [{ callId: "a", tool: "read_file" }], turn: 1, iteration: 0 }),
      tools: TOOLS,
    });
    expect(plan).toMatchObject({ kind: "resume", turn: 1, iteration: 1, step: 2 });
  });

  // The model's loop is over when its last turn is text alone: nothing was
  // dispatched, nothing is owed but the post-steps and the reply. The row the
  // pi mirror writes (harness-pi item 8) and the row the native loop would
  // write are one shape, so one rule reads both.
  it("finish: a transcript ending on the model's final answer (a text-only assistant turn) with nothing in flight is a loop that ended: the plan carries that turn's text as the answer and the record's counters, whether the final turn's step record landed or only its turns did", () => {
    const messages = [
      user("go"),
      assistantCalling(call("a", "read_file")),
      results("a"),
      { role: "assistant" as const, content: [text("The change is sound."), text("LGTM.")] },
    ];
    // The record landed (the mirror writes a text-only turn as a step with nothing in flight).
    const recorded = planResume({
      transcript: complete(messages),
      lastStep: step({ step: 2, turnIndex: 4, inFlight: [], turn: 2, iteration: 1, remainingMs: 300_000 }),
      tools: TOOLS,
    });
    expect(recorded).toEqual({
      kind: "finish",
      messages,
      answer: "The change is sound.\nLGTM.",
      inboxConsumedSeq: 7,
      step: 2,
      turn: 2,
      remainingMs: 300_000,
    });
    // The final turn's rows landed but its record did not (a run-step-fresh
    // shape with no calls): the same answer, the counters advanced as for any
    // unrecorded step.
    const fresh = planResume({
      transcript: complete(messages),
      lastStep: step({ step: 1, turnIndex: 2, inFlight: [{ callId: "a", tool: "read_file" }], turn: 1, iteration: 0 }),
      tools: TOOLS,
    });
    expect(fresh).toMatchObject({ kind: "finish", answer: "The change is sound.\nLGTM.", step: 2, turn: 2 });
    // The seed alone is not an answer: a text-only USER turn still continues (the case below).
    expect(
      planResume({
        transcript: complete([user("go")]),
        lastStep: step({ step: 0, turnIndex: 1, turn: 0 }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "resume", settlements: [] });
  });

  it("interrupted: no step record; an incomplete transcript; a partial step write; in-flight calls that do not match the last turn; an assistant turn carrying tool calls the record does not know", () => {
    const base = { transcript: complete([user("go")]), tools: TOOLS };
    expect(planResume({ ...base, lastStep: null })).toMatchObject({ kind: "interrupted", why: /no step record/ });
    expect(
      planResume({
        transcript: { complete: false, turns: 1, messages: [user("go")], compactions: [], gap: "turn 1 is missing" },
        lastStep: step({ turnIndex: 2 }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: "transcript incomplete: turn 1 is missing" });
    expect(
      planResume({
        transcript: complete([user("go"), assistantCalling(call("a", "bash"))]),
        lastStep: step({ turnIndex: 1 }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: /partial step write/ });
    expect(
      planResume({
        transcript: complete([user("go"), assistantCalling(call("a", "bash"))]),
        lastStep: step({ turnIndex: 2, inFlight: [{ callId: "zzz", tool: "bash" }] }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: /do not match/ });
    // The converse: a recorded call the turn does not carry is corruption too.
    expect(
      planResume({
        transcript: complete([user("go"), assistantCalling(call("a", "bash"))]),
        lastStep: step({
          turnIndex: 2,
          inFlight: [
            { callId: "a", tool: "bash" },
            { callId: "ghost", tool: "bash" },
          ],
        }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: /do not match/ });
    // An assistant turn WITH tool calls whose record says nothing was in
    // flight is not an answer and not a settled step: corruption.
    expect(
      planResume({
        transcript: complete([user("go"), assistantCalling(call("a", "bash"))]),
        lastStep: step({ turnIndex: 2, inFlight: [] }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: /tool calls.*nothing in flight/ });
  });

  // The new generation's RunControl knows no stop and no budget: how the loop
  // ended is read back from the notes the previous one published, so the
  // finish carries the status and the label the thread would have seen.
  it("loopEndingOf reads how the model's loop ended from the run's notes: a soft `stopped` note is a soft stop, the budget, guard, stuck-loop and dead-sandbox notes are a write-up with the note's summary, the last such note wins, and no note (or only a hard stop, which leaves no answer) is a plain answer", () => {
    const note = (kind: string, summary: string, mode?: "soft" | "hard") => ({
      type: "run_note" as const,
      kind: kind as "stopped",
      summary,
      ...(mode ? { mode } : {}),
      seq: 1,
    });
    expect(loopEndingOf([])).toEqual({ kind: "answered" });
    expect(loopEndingOf([{ type: "input", text: "go", seq: 1 }, note("wrap_up", "3 min left")])).toEqual({
      kind: "answered",
    });
    expect(
      loopEndingOf([note("stop_requested", "soft stop requested", "soft"), note("stopped", "soft stop", "soft")]),
    ).toEqual({
      kind: "soft_stop",
    });
    expect(loopEndingOf([note("stopped", "hard stop", "hard")])).toEqual({ kind: "answered" });
    expect(loopEndingOf([note("time_budget_exhausted", "time budget exhausted")])).toEqual({
      kind: "written_up",
      note: "time_budget_exhausted",
      summary: "time budget exhausted",
    });
    expect(loopEndingOf([note("turn_budget_exhausted", "turn guard fired: 30 model turns in 5 min")])).toEqual({
      kind: "written_up",
      note: "turn_budget_exhausted",
      summary: "turn guard fired: 30 model turns in 5 min",
    });
    expect(loopEndingOf([note("stuck_loop", "stuck loop")])).toMatchObject({ kind: "written_up", note: "stuck_loop" });
    expect(loopEndingOf([note("sandbox_dead", "3 exec failures")])).toMatchObject({
      kind: "written_up",
      note: "sandbox_dead",
      summary: "3 exec failures",
    });
    // The last ending note wins: a budget note after a stop is the loop's actual end.
    expect(
      loopEndingOf([note("stopped", "soft stop", "soft"), note("time_budget_exhausted", "time budget exhausted")]),
    ).toMatchObject({ kind: "written_up", note: "time_budget_exhausted" });
  });

  // agent-review.md item 18: the post is a fact on the record. A resumed review
  // that already posted must not post twice, and the record's outcome is the
  // event's, not a fresh post-step's.
  it("reviewPostedBefore: the last `review_posted` event on the replayed events is the outcome a resumed review already has, verdict included when the event carries one; without one there is nothing", () => {
    expect(reviewPostedBefore([])).toBeUndefined();
    expect(
      reviewPostedBefore([{ type: "run_note", kind: "review_not_posted", summary: "no PR", seq: 1 }]),
    ).toBeUndefined();
    expect(
      reviewPostedBefore([
        { type: "input", text: "review it", seq: 1 },
        { type: "review_posted", repo: "acme/api", number: 12, head: "a".repeat(40), verdict: "approve", seq: 9 },
      ]),
    ).toEqual({ posted: true, target: { repo: "acme/api", number: 12 }, head: "a".repeat(40), verdict: "approve" });
    expect(
      reviewPostedBefore([
        { type: "review_posted", repo: "acme/api", number: 12, head: "a".repeat(40), verdict: "approve", seq: 9 },
        { type: "review_posted", repo: "acme/api", number: 12, head: "b".repeat(40), seq: 12 },
      ]),
    ).toEqual({ posted: true, target: { repo: "acme/api", number: 12 }, head: "b".repeat(40) });
  });

  it("the budget a resume runs on is the step record's remainingMs — the seed carries the run's EFFECTIVE budget (a clipped one included), so nothing is ever re-derived from a preset", () => {
    const messages = [user("go")];
    const plan = planResume({
      transcript: complete(messages),
      // The seed record of a run admitted with a 10-minute budget under a channel boundary (the preset asks 45).
      lastStep: step({ step: 0, turnIndex: 1, inFlight: [], remainingMs: 10 * 60_000, turn: 0 }),
      tools: TOOLS,
    });
    expect(plan).toMatchObject({ kind: "resume", remainingMs: 10 * 60_000, settlements: [], step: 0 });
  });

  // docs/reference/specs/session-log.md item 3: the rows a resume rebuilds come
  // from the run's session log from `seedFrom`, or — for a row claimed before
  // the log existed — from the run's own transcript object.
  it("transcriptSource: a row with a session reads the log from its seedFrom; a row without one reads its own object", () => {
    const meta = { channelId: "slack:C1", userId: "u", threadKey: "slack:C1:1.0" };
    expect(
      transcriptSource({
        ...meta,
        session: { key: "slack:C1:1.0:coding", seedFrom: 148, request: 213, range: { from: 213 } },
      }),
    ).toEqual({ kind: "session", key: "slack:C1:1.0:coding", from: 148 });
    expect(transcriptSource(meta)).toEqual({ kind: "run" });
  });

  it("the plan carries the transcript's compaction rows, so a rebuilt session keeps pi's summary where it sat", () => {
    const compactions = [{ before: 1, entry: { summary: "so far", tokensBefore: 10 } }];
    const plan = planResume({
      transcript: { complete: true, turns: 3, messages: [user("go"), user("results")], compactions },
      lastStep: step({ step: 1, turnIndex: 3, inFlight: [] }),
      tools: TOOLS,
    });
    expect(plan).toMatchObject({ kind: "resume", compactions });
  });
});
