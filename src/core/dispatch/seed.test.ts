import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import type { AssembledTranscript } from "../runLedger/transcript.js";
import { RequiredTranscriptError } from "../runLedger/transcript.js";
import type { HistoryItem } from "../types.js";
import type { RunView } from "../runsService.js";
import type { SessionSources } from "../references/receipts.js";
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
  it("holds unreadable required transcript bytes instead of falling back to channel history", async () => {
    const common = {
      threadKey: "slack:channel:1",
      agent: "coding",
      thread: [],
      history: [{ role: "user" as const, text: "Channel fallback" }],
      request: { text: "Continue" },
    };
    const ledger = {
      readSessionTail: async () => {
        throw new RequiredTranscriptError("corrupt chunk");
      },
      readNotepad: async () => null,
    };
    await expect(sessionSeedFor({ ...common, ledger })).rejects.toThrow("required transcript: corrupt chunk");
    const missing = {
      ...ledger,
      readSessionTail: async () => {
        throw new Error("legacy route unavailable");
      },
    };
    expect(await sessionSeedFor({ ...common, ledger: missing })).toMatchObject({
      notes: [expect.stringContaining("run seeds from the channel")],
    });
  });
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

  it("continues a long run from its exact request, independent checkpoint, notes and complete recent exchange", async () => {
    const key = "slack:C1:1.0:coding";
    const original = user("Fix the retry bug. Keep the public API. Do not repeat the pending push.");
    const recent = [
      result("old", "orphan"),
      call("c1", "git status"),
      result("c1", "clean"),
      assistant("Push is still unconfirmed."),
    ];
    const ledger = {
      readSessionTail: async () => ({
        ...complete(recent, 30),
        checkpoint: {
          index: 29,
          entry: {
            summary: "Retry fixed; verify the pending push before any retry.",
            keptFrom: 30,
            scope: "continuation" as const,
          },
        },
      }),
      readSession: async () => ({ ...complete([original], 0).transcript, actors: ["slack:UALICE"] }),
      readNotepad: async () => ({ text: "Decision: retain the public API. Push outcome unknown.", updatedAt: 5 }),
    };
    const thread: RunView[] = [
      {
        id: "previous",
        agent: "coding",
        startedAt: 1,
        finished: true,
        finishedAt: 5_000,
        eventCount: 1,
        session: { key, seedFrom: 0, request: 0, range: { from: 0, to: 33 } },
      },
    ];
    const { seed } = await sessionSeedFor({ ...input, history: [], thread, ledger });
    expect(seed?.messages).toEqual([original, ...recent.slice(1), user("and bump the version")]);
    expect(seed?.summary).toContain("Retry fixed; verify the pending push before any retry.");
    expect(seed?.summary).toContain("conversation log turns 30 through 30 are not retained verbatim here");
    expect(seed?.notepad).toBe("Decision: retain the public API. Push outcome unknown.");
    expect(seed?.actors?.[0]).toBe("slack:UALICE");
    expect(seed?.log).toEqual({ from: 34, turns: 0 });
    expect(seed?.notes).toContain(
      "conversation context: loaded the previous request and recent history with a saved summary",
    );
  });

  it("recovers legacy context without a summary and preserves refused-request substitution", async () => {
    const key = "slack:C1:1.0:coding";
    const ledger = {
      readSessionTail: async () =>
        complete([result("old", "orphan"), assistant("Check the existing operation before retrying.")], 30),
      readSession: async () => complete([user("refused wording")], 0).transcript,
      readNotepad: async () => ({ text: "Operation outcome unknown.", updatedAt: 5 }),
    };
    const thread: RunView[] = [
      {
        id: "previous",
        agent: "coding",
        startedAt: 1,
        finished: true,
        finishedAt: 5_000,
        eventCount: 1,
        failure: { kind: "policy_refusal" },
        session: { key, seedFrom: 0, request: 0, range: { from: 0, to: 31 } },
      },
    ];
    const { seed, notes } = await sessionSeedFor({ ...input, history: [], thread, ledger });
    expect(seed?.messages).toEqual([
      user(REFUSED_REQUEST_STAND_IN),
      assistant("Check the existing operation before retrying."),
      user("and bump the version"),
    ]);
    expect(seed?.notepad).toBe("Operation outcome unknown.");
    expect(seed?.summary).toContain("conversation log turns 1 through 30 are not retained verbatim here");
    expect(notes).toContain(
      "conversation context: loaded the previous request and recent history; no saved summary was available",
    );
    expect(notes).toContain(
      "conversation context: earlier log turns 1 through 30 are not loaded; the agent can check omitted details with recall",
    );
  });

  it("reports only the prior context actually loaded when no saved summary is available", async () => {
    const key = "slack:C1:1.0:coding";
    const original = user("Check the pending operation before repeating it.");
    const thread: RunView[] = [
      {
        id: "previous",
        agent: "coding",
        startedAt: 1,
        finished: true,
        finishedAt: 5_000,
        eventCount: 1,
        session: { key, seedFrom: 0, request: 10, range: { from: 0, to: 30 } },
      },
    ];
    const ledger = {
      readSessionTail: async () => complete([result("cut-call", "orphaned result")], 30),
      readSession: async () => complete([original], 0).transcript,
      readNotepad: async () => null,
    };
    const onlyRequest = await sessionSeedFor({ ...input, history: [], thread, ledger });
    expect(onlyRequest.seed?.messages).toEqual([original, user("and bump the version")]);
    expect(onlyRequest.notes).toContain(
      "conversation context: loaded the previous request; no saved summary was available",
    );
    expect(onlyRequest.seed?.summary).toContain(
      "conversation log turns 0 through 9, 11 through 30 are not retained verbatim here",
    );
    expect(onlyRequest.notes).toContain(
      "conversation context: earlier log turns 0 through 9, 11 through 30 are not loaded; the agent can check omitted details with recall",
    );
    ledger.readSessionTail = async () => complete([assistant("Operation outcome remains unknown.")], 30);
    const withHistory = await sessionSeedFor({ ...input, history: [], thread, ledger });
    expect(withHistory.seed?.messages).toEqual([
      original,
      assistant("Operation outcome remains unknown."),
      user("and bump the version"),
    ]);
    expect(withHistory.notes).toContain(
      "conversation context: loaded the previous request and recent history; no saved summary was available",
    );
    expect(withHistory.seed?.summary).toContain(
      "conversation log turns 0 through 9, 11 through 29 are not retained verbatim here",
    );
    expect(withHistory.notes).toContain(
      "conversation context: earlier log turns 0 through 9, 11 through 29 are not loaded; the agent can check omitted details with recall",
    );
  });

  it("logs omitted ranges by source session without source text and emits no omission event for a complete view", async () => {
    const logs: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => logs.push(JSON.parse(String(line))));
    const messages = [user("private request text"), assistant("private answer text")];
    const ledger = {
      readSessionTail: async (key: string) => (key === "canonical:coding" ? complete([], 0) : complete(messages, 10)),
      readNotepad: async () => ({ text: "private working notes", updatedAt: 5 }),
    };
    try {
      const omitted = await sessionSeedFor({
        ...input,
        history: [],
        ledger,
        sessionKey: "canonical:coding",
        legacySessionKey: "slack:C1:1.0:coding",
      });
      expect(omitted.seed?.messages).toEqual([...messages, user("and bump the version")]);
      expect(logs).toEqual([
        { event: "conversation_context_omitted_ranges", sessionKey: "slack:C1:1.0:coding", omittedRanges: [[0, 9]] },
      ]);

      ledger.readSessionTail = async () => complete(messages, 0);
      const retained = await sessionSeedFor({ ...input, history: [], ledger });
      expect(retained.seed?.messages).toEqual([...messages, user("and bump the version")]);
      expect(logs).toEqual([
        { event: "conversation_context_omitted_ranges", sessionKey: "slack:C1:1.0:coding", omittedRanges: [[0, 9]] },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses continuation when the canonical request cannot be recovered or protected context exceeds the budget", async () => {
    const key = "slack:C1:1.0:coding";
    const thread: RunView[] = [
      {
        id: "previous",
        agent: "coding",
        startedAt: 1,
        finished: true,
        finishedAt: 5_000,
        eventCount: 1,
        session: { key, seedFrom: 0, request: 0, range: { from: 0, to: 30 } },
      },
    ];
    const ledger = {
      readSessionTail: async () => complete([assistant("Operation pending.")], 30),
      readSession: async () => complete([user("Original task")], 0).transcript,
      readNotepad: async () => null,
    };
    const recovered = await sessionSeedFor({ ...input, history: [], thread, ledger });
    expect(recovered.seed?.messages[0]).toEqual(user("Original task"));
    const warnings: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation((line) => {
      warnings.push(String(line));
    });
    try {
      await expect(
        sessionSeedFor({
          ...input,
          thread,
          ledger: {
            ...ledger,
            readSession: async () => {
              throw new Error("unavailable");
            },
          },
        }),
      ).rejects.toThrow("previous request could not be read");
      await expect(
        sessionSeedFor({
          ...input,
          thread,
          ledger: { ...ledger, readSession: async () => complete([user("x".repeat(240_001))], 0).transcript },
        }),
      ).rejects.toThrow("exceed the history byte budget");
      expect(warnings.map((line) => JSON.parse(line))).toMatchObject([
        {
          event: "conversation_context_refused",
          reason: "previous_request_unreadable",
          previousRunId: "previous",
          requestIndex: 0,
          budgetBytes: 239_488,
        },
        {
          event: "conversation_context_refused",
          reason: "protected_context_over_budget",
          previousRunId: "previous",
          requestIndex: 0,
          budgetBytes: 239_488,
        },
      ]);
      expect(JSON.parse(warnings[1]).measuredContextBytes).toBeGreaterThan(239_488);
    } finally {
      warning.mockRestore();
    }
  });

  it("shares the history budget with summary and notes even when the tail has user text, and names the actual cut", async () => {
    const key = "slack:C1:1.0:coding";
    const original = user("Keep the API. Do not repeat the pending operation.");
    const ledger = {
      readSessionTail: async () => ({
        ...complete([user("x".repeat(210_000)), assistant("Operation outcome unknown.")], 10),
        checkpoint: { index: 5, entry: { summary: "s".repeat(50_000), scope: "continuation" as const } },
      }),
      readSession: async () => complete([original], 0).transcript,
      readNotepad: async () => ({ text: "Keep the existing authority limits.", updatedAt: 5 }),
    };
    const thread: RunView[] = [
      {
        id: "previous",
        agent: "coding",
        startedAt: 1,
        finished: true,
        finishedAt: 5_000,
        eventCount: 1,
        session: { key, seedFrom: 0, request: 0, range: { from: 0, to: 11 } },
      },
    ];
    const { seed } = await sessionSeedFor({ ...input, thread, history: [], ledger });
    expect(seed?.messages).toEqual([original, assistant("Operation outcome unknown."), user("and bump the version")]);
    expect(seed?.summary).toContain("conversation log turns 6 through 10 are not retained verbatim here");
    const bytes = new TextEncoder().encode(
      JSON.stringify(seed!.messages.slice(0, -1)) + seed!.summary + seed!.notepad,
    ).byteLength;
    expect(bytes).toBeLessThanOrEqual(240_000);
  });

  it("names missing kept rows for an ordinary compaction even when the tail is reused", async () => {
    const ledger = {
      readSessionTail: async () => ({
        ...complete([user("Keep the API."), assistant("Operation pending.")], 10),
        checkpoint: { index: 5, entry: { summary: "Earlier task summary.", keptFrom: 3 } },
      }),
      readNotepad: async () => null,
    };
    const { seed } = await sessionSeedFor({ ...input, history: [], ledger });
    expect(seed?.messages).toEqual([
      user("Keep the API."),
      assistant("Operation pending."),
      user("and bump the version"),
    ]);
    expect(seed?.log).toEqual({ from: 10, turns: 2 });
    expect(seed?.summary).toContain("conversation log turns 3 through 9 are not retained verbatim here");
  });

  it("retains original and tool-result image payloads under their attachment limits instead of the text-history cap", async () => {
    const data = "a".repeat(3 * 1024 * 1024);
    const image = { type: "image" as const, mediaType: "image/png", data };
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "Inspect the image." }, image] },
      { role: "assistant", content: [{ type: "tool_use", id: "shot", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "shot", content: [image] }] },
      assistant("Image inspected."),
    ];
    const ledger = { readSessionTail: async () => complete(messages, 0), readNotepad: async () => null };
    const { seed } = await sessionSeedFor({ ...input, ledger, history: [] });
    expect(seed?.messages[0].content[1]).toEqual({ type: "image", mediaType: "image/png", data });
    expect(seed?.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "shot", content: [{ type: "image", mediaType: "image/png", data }] }],
    });
    expect(seed?.messages.at(-1)).toEqual(user("and bump the version"));
    expect(seed?.log).toEqual({ from: 0, turns: 4 });
  });

  it("never moves an older correction after the recovered newest request when the byte cut forces copying", async () => {
    const key = "slack:C1:1.0:coding";
    const ledger = {
      readSessionTail: async () => ({
        ...complete(
          [
            user("x".repeat(210_000)),
            user("Production changes are allowed."),
            assistant("Old answer."),
            user("Staging only."),
            assistant("No production change made."),
          ],
          10,
        ),
        checkpoint: { index: 5, entry: { summary: "s".repeat(50_000), scope: "continuation" as const } },
      }),
      readSession: async () => complete([user("Staging only.")], 13).transcript,
      readNotepad: async () => null,
    };
    const thread: RunView[] = [
      {
        id: "previous",
        agent: "coding",
        startedAt: 1,
        finished: true,
        finishedAt: 5_000,
        eventCount: 1,
        session: { key, seedFrom: 0, request: 13, range: { from: 0, to: 14 } },
      },
    ];
    const { seed } = await sessionSeedFor({ ...input, thread, history: [], ledger });
    expect(seed?.messages).toEqual([
      user("Staging only."),
      assistant("No production change made."),
      user("and bump the version"),
    ]);
    expect(seed?.summary).toContain("conversation log turns 6 through 12 are not retained verbatim here");
  });

  it("captures the cumulative dependency envelope after reading mutable notes", async () => {
    let sources: SessionSources = {
      version: 1,
      status: "unknown",
      context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
    };
    const ledger = {
      readSessionTail: async () => ({ ...complete(tail4, 0), sources: structuredClone(sources) }),
      readNotepad: async () => {
        sources = { version: 1, status: "revoked", context: { ...sources.context!, status: "revoked", revision: 1 } };
        return { text: "notes updated during the read", updatedAt: 5 };
      },
    };
    const { seed } = await sessionSeedFor({ ...input, ledger });
    expect(seed?.notepad).toBe("notes updated during the read");
    expect(seed?.sources?.context?.status).toBe("revoked");
  });

  it("reads an explicit working lane and ignores another session's refused request indices", async () => {
    const key = "plan-p:unit:coding";
    const calls: string[] = [];
    const ledger = {
      readSessionTail: async (readKey: string) => {
        calls.push(readKey);
        return complete(tail4, 0);
      },
      readNotepad: async (readKey: string) => {
        calls.push(readKey);
        return { text: "lane decisions", updatedAt: 5 };
      },
    };
    const thread: RunView[] = [
      {
        id: "other",
        agent: "coding",
        startedAt: 1,
        finished: true,
        eventCount: 0,
        finishedAt: 2,
        failure: { kind: "policy_refusal" },
        session: { key: "slack:C1:1.0:coding", seedFrom: 0, request: 0, range: { from: 0, to: 3 } },
      },
    ];
    const { seed } = await sessionSeedFor({ ...input, thread, ledger, sessionKey: key });
    expect(calls).toEqual([key, key, key]);
    expect(seed?.messages[0]).toEqual(tail4[0]);
    expect(seed?.notepad).toBe("lane decisions");
  });

  it("copies a legacy working seed once without reusing its row indices in the new lane", async () => {
    const key = "plan-p:unit:coding";
    const legacy = "slack:C1:1.0:coding";
    const calls: string[] = [];
    const ledger = {
      readSessionTail: async (readKey: string) => {
        calls.push(readKey);
        return readKey === key
          ? complete([], 0)
          : {
              ...complete(tail4, 10),
              transcript: {
                ...complete(tail4, 10).transcript,
                actors: ["slack:UALICE", undefined, undefined, undefined],
              },
            };
      },
      readNotepad: async () => ({ text: "keep the helper", updatedAt: 5 }),
    };
    const migrated = await sessionSeedFor({ ...input, ledger, sessionKey: key, legacySessionKey: legacy });
    expect(calls).toEqual([key, legacy, legacy]);
    expect(migrated.seed?.messages.slice(0, 4)).toEqual(tail4);
    expect(migrated.seed?.log).toEqual({ from: 0, turns: 0 });
    expect(migrated.seed?.notepad).toBe("keep the helper");
    expect(migrated.seed?.actors?.[0]).toBe("slack:UALICE");
    expect(migrated.notes).toContain(`working context: copied legacy log ${legacy} into ${key}`);
    calls.length = 0;
    ledger.readSessionTail = async (readKey: string) => {
      calls.push(readKey);
      return complete(tail4, 0);
    };
    await sessionSeedFor({ ...input, ledger, sessionKey: key, legacySessionKey: legacy });
    expect(calls).toEqual([key, key]);
  });

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
    expect(calls).toEqual([
      `tail slack:C1:1.0:coding ${SEED_BUDGET_BYTES}`,
      "notepad slack:C1:1.0:coding",
      "tail slack:C1:1.0:coding 1",
    ]);
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
