import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../providers/types.js";
import { planResume, settlementFor, type KnownTool, type ToolUsePart } from "./resume.js";
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

const complete = (messages: ChatMessage[]) => ({ complete: true as const, turns: messages.length, messages });

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

  it("interrupted: no step record; an incomplete transcript; a partial step write; in-flight calls that do not match the last turn; an assistant turn with nothing recorded in flight; a fresh step without tool calls", () => {
    const base = { transcript: complete([user("go")]), tools: TOOLS };
    expect(planResume({ ...base, lastStep: null })).toMatchObject({ kind: "interrupted", why: /no step record/ });
    expect(
      planResume({
        transcript: { complete: false, turns: 1, messages: [user("go")], gap: "turn 1 is missing" },
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
    expect(
      planResume({
        transcript: complete([user("go"), { role: "assistant", content: [text("done?")] }]),
        lastStep: step({ turnIndex: 2, inFlight: [] }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: /nothing in flight/ });
    expect(
      planResume({
        transcript: complete([
          user("go"),
          assistantCalling(call("a", "bash")),
          results("a"),
          { role: "assistant", content: [text("hm")] },
        ]),
        lastStep: step({ turnIndex: 2, inFlight: [{ callId: "a", tool: "bash" }] }),
        tools: TOOLS,
      }),
    ).toMatchObject({ kind: "interrupted", why: /no tool calls/ });
  });
});
