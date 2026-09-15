import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import type { AssembledTranscript } from "../runLedger/transcript.js";
import type { HistoryItem } from "../types.js";
import { SEED_BUDGET_BYTES, SEED_BUDGET_TOKENS, sessionSeed, sessionSeedFor } from "./seed.js";

// docs/reference/specs/session-log.md item 9: a follow-up on the pi harness
// seeds from its session's log — the tail within the seed budget, cut at a
// turn that begins with a user text turn, thinking dropped, calls in flight
// settled, then the channel's user lines since the previous run ended, then
// the request — and the seed says which rows of the log it reuses.

const user = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, command: string): ChatMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "bash", input: { command } }],
});
const result = (id: string, text: string): ChatMessage => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content: text }],
});

const complete = (messages: ChatMessage[], from: number, compactions: AssembledTranscript["compactions"] = []) => ({
  from,
  transcript: { complete: true as const, turns: messages.length + compactions.length, messages, compactions },
});

const tail4 = [user("fix the flaky test"), call("c1", "npm test"), result("c1", "1 failed"), assistant("fixed it")];
const history: HistoryItem[] = [
  { role: "user", text: "fix the flaky test", at: 1_000 },
  { role: "assistant", text: "fixed it", at: 4_000 },
  { role: "user", text: "also check the lockfile", at: 6_000 },
  { role: "user", text: "(no clock on this one)" },
];
const request = { text: "and bump the version" };
const previous = { finishedAt: 5_000, broken: false };

describe("sessionSeed — the tail, the lines since, the request", () => {
  it("the budget is 60,000 tokens at four characters a token", () => {
    expect(SEED_BUDGET_TOKENS).toBe(60_000);
    expect(SEED_BUDGET_BYTES).toBe(240_000);
  });

  it("reuses the tail's rows as they are, then the user lines written after the previous run ended, then the request; the log range names the rows reused", () => {
    const seed = sessionSeed({ tail: complete(tail4, 10), previous, history, request })!;
    expect(seed.messages).toEqual([...tail4, user("also check the lockfile"), user("and bump the version")]);
    expect(seed.log).toEqual({ from: 10, turns: 4 });
    expect(seed.summary).toBeUndefined();
    expect(seed.notes).toEqual([]);
  });

  it("the bot's own lines and lines the previous run saw are not since-lines; a line with no clock is not one either", () => {
    const seed = sessionSeed({ tail: complete(tail4, 0), previous, history, request })!;
    const since = seed.messages.slice(4, -1);
    expect(since).toEqual([user("also check the lockfile")]);
  });

  it("cuts the tail forward to the first user turn that carries text, so no tool call is parted from its result and the conversation opens as providers require", () => {
    const messages = [result("c0", "earlier result"), assistant("noted"), ...tail4];
    const seed = sessionSeed({ tail: complete(messages, 20), previous, history, request })!;
    expect(seed.messages.slice(0, 4)).toEqual(tail4);
    expect(seed.log).toEqual({ from: 22, turns: 4 });
  });

  it("drops thinking blocks from the tail and keeps every row's place: an assistant turn of only thinking keeps one text part in its stead", () => {
    const thought: ChatMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "fixed it" },
      ],
    };
    const onlyThought: ChatMessage = {
      role: "assistant",
      content: [{ type: "redacted_thinking", data: "opaque" }],
    };
    const messages = [user("go"), thought, user("more"), onlyThought];
    const seed = sessionSeed({ tail: complete(messages, 0), previous, history: [], request })!;
    expect(seed.messages.slice(0, 4)).toEqual([
      user("go"),
      assistant("fixed it"),
      user("more"),
      { role: "assistant", content: [{ type: "text", text: "(reasoning omitted)" }] },
    ]);
    expect(seed.log).toEqual({ from: 0, turns: 4 });
  });

  it("a tail that ends on calls in flight gets each answered with a note that the run ended before the result landed, so no dangling call reaches a provider", () => {
    const messages = [user("go"), call("c1", "npm test")];
    const seed = sessionSeed({ tail: complete(messages, 0), previous, history: [], request })!;
    expect(seed.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "c1",
          content: expect.stringContaining("ended before this bash call's result"),
          isError: true,
        },
      ],
    });
    expect(seed.messages[3]).toEqual(user("and bump the version"));
    expect(seed.log).toEqual({ from: 0, turns: 2 }); // the settlement is a new row, not a reused one
  });

  it("begins after the newest compaction row and carries that entry's summary for the prompt, never as a row", () => {
    const messages = [user("first"), assistant("one"), user("second"), assistant("two")];
    const compactions = [{ before: 2, entry: { summary: "so far: one" } }];
    const seed = sessionSeed({ tail: complete(messages, 100, compactions), previous, history: [], request })!;
    expect(seed.messages.slice(0, 2)).toEqual([user("second"), assistant("two")]);
    // messages 0 and 1 are rows 100 and 101; the compaction row is 102; the tail begins at 103.
    expect(seed.log).toEqual({ from: 103, turns: 2 });
    expect(seed.summary).toBe("so far: one");
  });

  it("a previous run whose log ends short (`broken`) gets a gap marker before the lines since, as a new row", () => {
    const seed = sessionSeed({
      tail: complete(tail4, 0),
      previous: { finishedAt: 5_000, broken: true },
      history,
      request,
    })!;
    expect(seed.messages.slice(4)).toEqual([
      user(expect.stringContaining("ends short of what the previous run saw") as unknown as string),
      user("also check the lockfile"),
      user("and bump the version"),
    ]);
    expect(seed.log).toEqual({ from: 0, turns: 4 });
  });

  it("without the previous run's end, no line since can be told apart: the tail, then the request, and a note says so", () => {
    const seed = sessionSeed({ tail: complete(tail4, 0), previous: undefined, history, request })!;
    expect(seed.messages).toEqual([...tail4, user("and bump the version")]);
    expect(seed.notes).toEqual([expect.stringContaining("lines written since")]);
  });

  it("a newest turn alone over the budget yields no tail: the request alone, the log range empty at the tail, and a note", () => {
    const seed = sessionSeed({ tail: complete([], 57), previous, history, request })!;
    expect(seed.messages).toEqual([user("also check the lockfile"), user("and bump the version")]);
    expect(seed.log).toEqual({ from: 57, turns: 0 });
    expect(seed.notes).toEqual([expect.stringContaining("over the seed budget")]);
  });

  it("a tail with no user text turn at all is no tail either", () => {
    const seed = sessionSeed({
      tail: complete([result("c9", "x"), assistant("y")], 30),
      previous,
      history: [],
      request,
    })!;
    expect(seed.messages).toEqual([user("and bump the version")]);
    expect(seed.log).toEqual({ from: 32, turns: 0 });
    expect(seed.notes).toHaveLength(1);
  });

  it("a log with no rows is no session: undefined, so the run seeds from the channel", () => {
    expect(sessionSeed({ tail: complete([], 0), previous: undefined, history, request })).toBeUndefined();
  });

  it("the request keeps its attachments", () => {
    const seed = sessionSeed({
      tail: complete(tail4, 0),
      previous,
      history: [],
      request: { text: "look", images: [{ mediaType: "image/png", data: "aGk=" }] },
    })!;
    expect(seed.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "text", text: "look" },
      ],
    });
  });
});

describe("sessionSeedFor — the seed read from the ledger, with the notepad", () => {
  const ledgerOver = (over: {
    tail?: ReturnType<typeof complete>;
    notepad?: { text: string; updatedAt: number } | null;
    notepadThrows?: boolean;
  }) => ({
    readSessionTail: async () => over.tail ?? complete(tail4, 0),
    readNotepad: async () => {
      if (over.notepadThrows) throw new Error("no route");
      return over.notepad ?? null;
    },
  });
  const input = { threadKey: "slack:C1:1.0", agent: "coding", thread: [], history, request };

  it("reads the log's tail under the budget by the thread-and-agent key, then the notepad, which rides the seed for the prompt and never as a row", async () => {
    const calls: string[] = [];
    const ledger = {
      readSessionTail: async (key: string, maxBytes: number) => {
        calls.push(`tail ${key} ${maxBytes}`);
        return complete(tail4, 0);
      },
      readNotepad: async (key: string) => {
        calls.push(`notepad ${key}`);
        return { text: "decided: keep the helper", updatedAt: 5_000 };
      },
    };
    const { seed, notes } = await sessionSeedFor({ ledger, ...input });
    expect(calls).toEqual([`tail slack:C1:1.0:coding ${SEED_BUDGET_BYTES}`, "notepad slack:C1:1.0:coding"]);
    expect(seed!.notepad).toBe("decided: keep the helper");
    expect(seed!.messages).toEqual([...tail4, user("and bump the version")]); // no thread page: no previous end, no lines since
    expect(notes).toEqual([expect.stringContaining("lines written since")]);
  });

  it("an empty or absent notepad leaves the seed without one; a notepad read that fails is a note and the seed stands; an empty log reads no notepad and is no session", async () => {
    expect((await sessionSeedFor({ ledger: ledgerOver({ notepad: null }), ...input })).seed!.notepad).toBeUndefined();
    expect(
      (await sessionSeedFor({ ledger: ledgerOver({ notepad: { text: "   ", updatedAt: 1 } }), ...input })).seed!
        .notepad,
    ).toBeUndefined();
    const failed = await sessionSeedFor({ ledger: ledgerOver({ notepadThrows: true }), ...input });
    expect(failed.seed!.messages.length).toBeGreaterThan(0);
    expect(failed.notes).toEqual([
      expect.stringContaining("lines written since"),
      expect.stringContaining("notepad of slack:C1:1.0:coding could not be read (no route)"),
    ]);
    const none = await sessionSeedFor({ ledger: ledgerOver({ tail: complete([], 0), notepadThrows: true }), ...input });
    expect(none).toEqual({ notes: [] });
  });
});
