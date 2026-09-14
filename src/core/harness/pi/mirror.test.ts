import { describe, expect, it } from "vitest";
import type { StepReport } from "../../../runner.js";
import type { ChatMessage } from "../../../providers/types.js";
import { PiMirror, chatMessageOf, piSessionFile } from "./mirror.js";

// Feature: docs/reference/specs/harness-pi.md item 8 — the transcript mirror:
// pi's messages become the runner's transcript through the same step records
// a native run writes, and a session file rebuilt from that transcript is
// what a restarted pi continues from.

const bashCall = {
  role: "assistant",
  content: [
    { type: "text", text: "Checking the tree." },
    { type: "thinking", thinking: "private" },
    { type: "toolCall", id: "call_0", name: "bash", arguments: { command: "git status --short" } },
  ],
  api: "anthropic-messages",
  provider: "switchboard",
  model: "claude-fable-5",
  usage: {},
  stopReason: "toolUse",
  timestamp: 1,
};
const bashResult = {
  role: "toolResult",
  toolCallId: "call_0",
  toolName: "bash",
  content: [{ type: "text", text: " M README.md" }],
  isError: false,
  timestamp: 2,
};
const final = { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 3 };

describe("chatMessageOf — pi's message in the runner's vocabulary", () => {
  it("maps user text and images, assistant text and tool calls (thinking dropped), and a tool result as a user turn", () => {
    expect(chatMessageOf({ role: "user", content: "go" })).toEqual({
      role: "user",
      content: [{ type: "text", text: "go" }],
    });
    expect(chatMessageOf({ role: "user", content: [{ type: "image", data: "AAA=", mimeType: "image/png" }] })).toEqual({
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: "AAA=" }],
    });
    expect(chatMessageOf(bashCall)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking the tree." },
        { type: "tool_use", id: "call_0", name: "bash", input: { command: "git status --short" } },
      ],
    });
    expect(chatMessageOf(bashResult)).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call_0", content: " M README.md" }],
    });
    expect(chatMessageOf({ ...bashResult, isError: true })).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call_0", content: " M README.md", isError: true }],
    });
    expect(chatMessageOf({ role: "bashExecution", command: "ls" })).toBeUndefined();
  });
});

describe("PiMirror — step records as the runner writes them", () => {
  function mirror(seedLength = 1) {
    const reports: StepReport[] = [];
    const m = new PiMirror({ onStep: async (r) => void reports.push(r), seedLength, remainingMs: () => 600_000 });
    return { m, reports };
  }

  it("skips the echoed seed, reports the assistant turn with its calls in flight before the results, then the results as one user turn with the next assistant turn", async () => {
    const { m, reports } = mirror();
    await m.onMessage({ role: "user", content: "go" }, 0); // the prompt echoed: the seed, already on the ledger
    await m.onMessage(bashCall, 1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      firstIdx: 1,
      inFlight: [{ callId: "call_0", tool: "bash" }],
      turn: 1,
      iteration: 0,
      remainingMs: 600_000,
      inboxConsumedSeq: 0,
    });
    expect(reports[0].turns).toEqual([chatMessageOf(bashCall)]);
    await m.onMessage(bashResult, 1);
    await m.onMessage({ role: "user", content: "also: run the tests" }, 1); // a steer, folded into the same user turn
    await m.onMessage(final, 1);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ firstIdx: 2, inFlight: [], iteration: 1 });
    expect(reports[1].turns).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_0", content: " M README.md" },
          { type: "text", text: "also: run the tests" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
  });

  it("without a step hook nothing is mirrored and nothing throws", async () => {
    const m = new PiMirror({ seedLength: 1, remainingMs: () => 1 });
    expect(m.wired).toBe(false);
    await m.onMessage(bashCall, 1);
  });
});

describe("piSessionFile — the session a restarted pi continues from", () => {
  it("writes the version-3 header and one linear branch: user, assistant with tool calls, one toolResult per result naming its tool", () => {
    const transcript: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      chatMessageOf(bashCall)!,
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call_0", content: " M README.md" },
          {
            type: "text",
            text: "The bot restarted while this bash call was in flight; its effects are unknown — re-check them.",
          },
        ],
      },
    ];
    const file = piSessionFile(transcript, {
      cwd: "/workspace/threads/t/main",
      model: { provider: "switchboard", id: "claude-fable-5", api: "anthropic-messages" },
      at: 1_700_000_000_000,
    });
    const lines = file
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: "/workspace/threads/t/main" });
    expect(String(lines[0].id)).toMatch(/^[0-9a-f-]{36}$/);
    const entries = lines.slice(1) as Array<{
      type: string;
      id: string;
      parentId: string | null;
      message: Record<string, unknown>;
    }>;
    expect(entries.map((e) => e.message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
    expect(entries[0].parentId).toBeNull();
    for (let i = 1; i < entries.length; i++) expect(entries[i].parentId).toBe(entries[i - 1].id);
    expect(entries[1].message).toMatchObject({
      role: "assistant",
      api: "anthropic-messages",
      provider: "switchboard",
      model: "claude-fable-5",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Checking the tree." },
        { type: "toolCall", id: "call_0", name: "bash", arguments: { command: "git status --short" } },
      ],
    });
    expect(entries[2].message).toMatchObject({
      role: "toolResult",
      toolCallId: "call_0",
      toolName: "bash",
      isError: false,
    });
    expect(entries[3].message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("restarted") }],
    });
  });
});
