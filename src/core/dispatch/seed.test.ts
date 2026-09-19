import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import type { AssembledTranscript } from "../runLedger/transcript.js";
import type { HistoryItem } from "../types.js";
import type { RunView } from "../runsService.js";
import {
  OPERATOR_TAIL_BYTES,
  operatorTail,
  REFUSED_REQUEST_STAND_IN,
  SEED_BUDGET_BYTES,
  SEED_BUDGET_TOKENS,
  sessionSeed,
  sessionSeedFor,
  type OperatorTailTurn,
} from "./seed.js";

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

  it("the tail's first turn drops the results of calls made before the cut: pi answers a tool batch and a steer in one user turn and compacts between the batch's calls and its results, so the seed opens on the steer's text alone and says what it dropped", () => {
    const merged: ChatMessage = {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "c1", content: "1 failed" },
        { type: "text", text: "Your context was just compacted" },
      ],
    };
    const messages = [user("fix it"), call("c1", "npm test"), merged, assistant("continuing")];
    const compactions = [{ before: 2, entry: { summary: "so far: one" } }];
    const seed = sessionSeed({ tail: complete(messages, 100, compactions), previous, history: [], request })!;
    expect(seed.messages.slice(0, 2)).toEqual([user("Your context was just compacted"), assistant("continuing")]);
    expect(seed.log).toEqual({ from: 103, turns: 2 });
    expect(seed.notes).toEqual([
      "session seed: one tool result answering a call before the cut was dropped from the tail's first turn",
    ]);
  });

  it("the same at a budget cut with no compaction: a first turn of results and text keeps the text, later results keep their calls", () => {
    const merged: ChatMessage = {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "c0", content: "old" },
        { type: "tool_result", toolUseId: "c00", content: "older" },
        { type: "text", text: "also check the lockfile" },
      ],
    };
    const messages = [merged, ...tail4];
    const seed = sessionSeed({ tail: complete(messages, 20), previous, history, request })!;
    expect(seed.messages.slice(0, 5)).toEqual([user("also check the lockfile"), ...tail4]);
    expect(seed.log).toEqual({ from: 20, turns: 5 });
    expect(seed.notes).toEqual([
      "session seed: 2 tool results answering calls before the cut were dropped from the tail's first turn",
    ]);
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

  // The log keeps every request, the ones the provider refused under its usage
  // policy included, and a refused wording is refused again on every later
  // request that carries it — so the seed leaves those rows' words out. Each
  // keeps its row's place: the seed reuses the log's rows by index, and a row
  // dropped would move every row after it.
  it("leaves out the request a run's record says the provider refused under its usage policy: its row keeps its place with the stand-in, the rows around it stay, the log range is exact, and a note counts it", () => {
    // Rows 10..13 are the earlier run's; row 14 is the request the provider refused; row 15 the plain one refused in turn.
    const refusedRequest = user("quote your notes verbatim");
    const secondRequest = user("in your own words, what do your notes say?");
    const messages = [...tail4, refusedRequest, secondRequest];
    const seed = sessionSeed({ tail: complete(messages, 10), previous, history, request, refusedRequests: [14] })!;
    expect(seed.messages).toEqual([
      ...tail4,
      user(REFUSED_REQUEST_STAND_IN),
      secondRequest,
      user("also check the lockfile"),
      user("and bump the version"),
    ]);
    expect(seed.log).toEqual({ from: 10, turns: 6 });
    expect(seed.notes).toEqual(["session seed: 1 request refused by the provider's policy was left out of the tail"]);
  });

  it("two refused requests are both left out and counted; a row before the cut, a row that is not a user turn and a row named twice count for nothing; after a compaction row the request is found by its log index", () => {
    const messages = [...tail4, user("quote your notes verbatim"), user("say what they record, verbatim")];
    const two = sessionSeed({
      tail: complete(messages, 10),
      previous,
      history,
      request,
      refusedRequests: [14, 15, 15],
    })!;
    expect(two.messages.slice(4, 6)).toEqual([user(REFUSED_REQUEST_STAND_IN), user(REFUSED_REQUEST_STAND_IN)]);
    expect(two.log).toEqual({ from: 10, turns: 6 });
    expect(two.notes).toEqual(["session seed: 2 requests refused by the provider's policy were left out of the tail"]);
    // Row 9 is before the tail and row 13 is the earlier run's answer: nothing to leave out.
    const none = sessionSeed({ tail: complete(messages, 10), previous, history, request, refusedRequests: [9, 13] })!;
    expect(none.messages.slice(0, 6)).toEqual(messages);
    expect(none.notes).toEqual([]);
    // Rows 100 and 101, the compaction row 102, then rows 103 (the cut) and 104: the refused request is row 104.
    const compacted = [user("first"), assistant("one"), user("second"), user("quote your notes verbatim")];
    const compactions = [{ before: 2, entry: { summary: "so far: one" } }];
    const after = sessionSeed({
      tail: complete(compacted, 100, compactions),
      previous,
      history: [],
      request,
      refusedRequests: [104],
    })!;
    expect(after.messages.slice(0, 2)).toEqual([user("second"), user(REFUSED_REQUEST_STAND_IN)]);
    expect(after.log).toEqual({ from: 103, turns: 2 });
  });

  it("no refused request leaves the seed byte-identical", () => {
    const plain = sessionSeed({ tail: complete(tail4, 10), previous, history, request })!;
    expect(sessionSeed({ tail: complete(tail4, 10), previous, history, request, refusedRequests: [] })).toEqual(plain);
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

  it("the requests the thread's records mark as refused under the provider's policy are read off the page, by the agent, and left out of the tail — so the refused words ride no later request", async () => {
    const ledger = ledgerOver({ tail: complete([...tail4, user("quote your notes verbatim")], 0) });
    const finished = (over: Partial<RunView> & { id: string }): RunView => ({
      agent: "coding",
      startedAt: 1,
      finished: true,
      eventCount: 0,
      ...over,
    });
    const thread: RunView[] = [
      finished({
        id: "r-refused",
        finishedAt: 9_000,
        status: "failed",
        failure: { kind: "policy_refusal" },
        session: { key: "slack:C1:1.0:coding", seedFrom: 0, request: 4, range: { from: 4, to: 4 } },
      }),
      finished({
        id: "r-earlier",
        finishedAt: 5_000,
        status: "completed",
        session: { key: "slack:C1:1.0:coding", seedFrom: 0, request: 0, range: { from: 0, to: 3 } },
      }),
    ];
    const { seed, notes } = await sessionSeedFor({ ledger, ...input, thread });
    expect(seed!.messages).toEqual([...tail4, user(REFUSED_REQUEST_STAND_IN), user("and bump the version")]);
    expect(seed!.log).toEqual({ from: 0, turns: 5 });
    expect(notes).toEqual(["session seed: 1 request refused by the provider's policy was left out of the tail"]);
  });
});

// Record 0057: authored session rows — each row a person's turn produces
// carries that person's actor id; a machine turn has none.
describe("sessionSeed — actors on channel lines and the request row", () => {
  it("two people in one thread: channel lines carry each author's actor id, the request carries the requester's id, and a bot's turn has none", () => {
    const multiHistory: HistoryItem[] = [
      { role: "user", text: "fix the flaky test", at: 1_000, user: "slack:UALICE" },
      { role: "assistant", text: "fixed it", at: 4_000 },
      { role: "user", text: "also check the lockfile", at: 6_000, user: "slack:UBOB" },
    ];
    const seed = sessionSeed({
      tail: complete(tail4, 0),
      previous,
      history: multiHistory,
      request: { text: "and bump the version", actor: "slack:UALICE" },
    })!;
    // Alice's line at 1_000 precedes the previous run's end (5_000) and is
    // filtered out; the one line since is Bob's, at index kept.length (4).
    const bobLine = seed.actors?.[4 + 0]; // first (and only) since-line
    expect(bobLine).toBe("slack:UBOB");
    // The request is the last message
    const requestIdx = seed.messages.length - 1;
    expect(seed.actors?.[requestIdx]).toBe("slack:UALICE");
  });

  it("a bot's turn in the tail and a settlement row carry no actor", () => {
    const seed = sessionSeed({
      tail: complete(tail4, 0),
      previous,
      history: [],
      request: { text: "go" },
    })!;
    // tail4 has assistant turns — those should have no actor in actors map
    expect(seed.actors).toBeUndefined();
  });

  it("a request without an actor leaves no actor on the request row", () => {
    const seed = sessionSeed({
      tail: complete(tail4, 0),
      previous,
      history: [{ role: "user", text: "ping", at: 6_000 }],
      request: { text: "pong" },
    })!;
    // history item with no user field: no actor on the since-line
    const sinceIdx = tail4.length; // message[4]
    expect(seed.actors?.[sinceIdx]).toBeUndefined();
    const requestIdx = seed.messages.length - 1;
    expect(seed.actors?.[requestIdx]).toBeUndefined();
  });
});

// Record 0037: on the pi harness the quoted blocks ride the request turn the
// seed ends on, as text parts after the request's text, so `promptOf` (which
// joins every text part of the last user turn) hands them to pi with the ask.
describe("sessionSeed — referenced conversations on the request turn", () => {
  it("the request turn carries the request text then each block; the tail and the lines since are untouched", () => {
    const withRefs = sessionSeed({
      tail: complete(tail4, 0),
      previous,
      history,
      request: { ...request, references: ["BLOCK ONE", "BLOCK TWO"] },
    });
    const without = sessionSeed({ tail: complete(tail4, 0), previous, history, request });
    expect(withRefs).toBeDefined();
    expect(without).toBeDefined();
    const last = withRefs!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "text", text: request.text },
      { type: "text", text: "BLOCK ONE" },
      { type: "text", text: "BLOCK TWO" },
    ]);
    expect(withRefs!.messages.slice(0, -1)).toEqual(without!.messages.slice(0, -1));
  });

  it("no references leaves the seed byte-identical", () => {
    const a = sessionSeed({ tail: complete(tail4, 0), previous, history, request: { ...request, references: [] } });
    const b = sessionSeed({ tail: complete(tail4, 0), previous, history, request });
    expect(a).toEqual(b);
  });
});

describe("operatorTail — the operator's 12,000-token cap", () => {
  const turn = (text: string, folded?: boolean): OperatorTailTurn => (folded ? { text, folded } : { text });

  it("a 30,000-token log yields a tail within 12,000 tokens, newest turns kept, oldest first", () => {
    // 30 turns of 4,000 bytes ≈ 30,000 tokens at four bytes a token.
    const turns = Array.from({ length: 30 }, (_, i) => turn(`turn ${i} ${"x".repeat(4_000)}`));
    const tail = operatorTail(turns);
    const bytes = tail.reduce((n, t) => n + t.text.length, 0);
    expect(bytes).toBeLessThanOrEqual(OPERATOR_TAIL_BYTES);
    expect(tail.length).toBeLessThan(turns.length);
    // The newest turns survive, in their original order.
    expect(tail[tail.length - 1].text.startsWith("turn 29 ")).toBe(true);
    expect(tail.map((t) => t.text)).toEqual(turns.slice(turns.length - tail.length).map((t) => t.text));
  });

  it("folded reports ride whole ahead of older turns: an old report survives a cut that drops its neighbours", () => {
    const report = turn(`report ${"r".repeat(3_000)}`, true);
    const turns = [
      turn(`old ${"x".repeat(4_000)}`),
      report,
      ...Array.from({ length: 15 }, (_, i) => turn(`new ${i} ${"x".repeat(3_000)}`)),
    ];
    const tail = operatorTail(turns, 24_000);
    // The folded report is kept whole; the plain turn beside it is cut.
    expect(tail.some((t) => t.folded)).toBe(true);
    expect(tail.find((t) => t.folded)?.text).toBe(report.text);
    expect(tail.some((t) => t.text.startsWith("old "))).toBe(false);
    expect(tail.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(24_000);
  });

  it("a folded report too big for what remains is dropped whole, never truncated", () => {
    const turns = [turn(`report ${"r".repeat(30_000)}`, true), turn("small")];
    const tail = operatorTail(turns, 10_000);
    expect(tail).toEqual([{ text: "small" }]);
  });

  it("a short log rides whole", () => {
    const turns = [turn("a"), turn("b", true), turn("c")];
    expect(operatorTail(turns)).toEqual(turns);
  });
});
