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

  // session-log item 2, one index per row: a message that carries no parts would
  // write no row and still spend an index, and the next reclaim would read the
  // hole as an incomplete transcript — so it is not a turn at all.
  it("an assistant message with no parts is not a turn: no step, no index taken, the results pending ride the next turn", async () => {
    const { m, reports } = mirror();
    await m.onMessage({ role: "user", content: "go" }, 0);
    await m.onMessage(bashCall, 1);
    await m.onMessage(bashResult, 1);
    await m.onMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "stream ended" }, 1);
    expect(reports).toHaveLength(1);
    await m.onMessage(final, 2);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ firstIdx: 2, inFlight: [] });
    expect(reports[1].turns).toEqual([
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_0", content: " M README.md" }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
  });

  it("without a step hook nothing is mirrored and nothing throws", async () => {
    const m = new PiMirror({ seedLength: 1, remainingMs: () => 1 });
    expect(m.wired).toBe(false);
    await m.onMessage(bashCall, 1);
  });

  // docs/reference/specs/session-log.md item 6: pi's compaction entry is a row of
  // the log, written where it happened — after the results it followed and
  // before the next assistant turn — and the index moves past it.
  it("a compaction is its own step report: the pending results as the user turn, the entry as the row after them, nothing in flight; the next assistant turn lands after it", async () => {
    const { m, reports } = mirror();
    await m.onMessage({ role: "user", content: "go" }, 0);
    await m.onMessage(bashCall, 1);
    await m.onMessage(bashResult, 1);
    const entry = { summary: "the tree had one change", tokensBefore: 150_000, firstKeptEntryId: "abc123" };
    await m.onCompaction(entry, 1);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ firstIdx: 2, inFlight: [], compaction: entry, turn: 1 });
    expect(reports[1].turns).toEqual([
      { role: "user", content: [{ type: "tool_result", toolUseId: "call_0", content: " M README.md" }] },
    ]);
    await m.onMessage(final, 2);
    expect(reports[2]).toMatchObject({ firstIdx: 4, inFlight: [] });
    expect(reports[2].turns).toEqual([{ role: "assistant", content: [{ type: "text", text: "Done." }] }]);
    expect("compaction" in reports[2]).toBe(false);
  });

  it("a compaction with nothing pending is a report of the entry alone", async () => {
    const { m, reports } = mirror();
    await m.onMessage({ role: "user", content: "go" }, 0);
    await m.onCompaction({ summary: "nothing yet" }, 0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ firstIdx: 1, turns: [], inFlight: [], compaction: { summary: "nothing yet" } });
  });
});

describe("piSessionFile — a compaction entry where pi wrote it", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "second" }] },
  ];
  const opts = {
    cwd: "/w",
    model: { provider: "switchboard", id: "claude-fable-5", api: "anthropic-messages" },
    at: 1_700_000_000_000,
  };
  const parse = (file: string) =>
    file
      .trimEnd()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("renders the entry as pi's `compaction` between the messages it sat between, on the same branch; with the kept message known, firstKeptEntryId names that message's entry so pi's window keeps what pi kept", () => {
    const entry = { summary: "so far: go, first", tokensBefore: 42, firstKeptEntryId: "pi-id" };
    const entries = parse(piSessionFile(messages, opts, [{ before: 2, entry, keptBefore: 1 }]));
    expect(entries.map((e) => e.type)).toEqual(["message", "message", "compaction", "message", "message"]);
    for (let i = 1; i < entries.length; i++) expect(entries[i].parentId).toBe(entries[i - 1].id);
    expect(entries[2]).toMatchObject({ type: "compaction", summary: "so far: go, first", tokensBefore: 42 });
    expect(entries[2].firstKeptEntryId).toBe(entries[1].id);
  });

  it("without the kept message, firstKeptEntryId is pi's own id — which names no entry here, so pi's window is the summary and the turns after it", () => {
    const entry = { summary: "so far", firstKeptEntryId: "pi-id" };
    const entries = parse(piSessionFile(messages, opts, [{ before: 2, entry }]));
    expect(entries[2]).toMatchObject({ type: "compaction", firstKeptEntryId: "pi-id" });
    expect(entries.some((e) => e.id === "pi-id")).toBe(false);
    // Nothing known at all: still a well-formed entry.
    const bare = parse(piSessionFile(messages, opts, [{ before: 4, entry: { summary: "end" } }]));
    expect(bare.at(-1)).toMatchObject({ type: "compaction", summary: "end", tokensBefore: 0 });
    expect(typeof bare.at(-1)!.firstKeptEntryId).toBe("string");
  });

  it("no compactions renders the file exactly as before", () => {
    expect(piSessionFile(messages, opts, [])).toBe(piSessionFile(messages, opts));
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
