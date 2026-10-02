import { describe, expect, it, vi } from "vitest";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { RunView } from "../runsService.js";
import type { RunLedger } from "../runLedger/ledger.js";
import { sessionKey } from "../runLedger/sessionLog.js";
import { testSessionSources, testSlackReceipt } from "../testing/slackSources.js";
import { readOperatorNotes } from "./operatorNotes.js";
import type { ContextDependencies } from "../references/contextDependencies.js";

const msg: IncomingMessage = { userId: "slack:UA", channelId: "slack:CA", threadKey: "slack:CA:1.0", text: "continue" };
const known = { version: 1 as const, status: "known" as const, revision: 0, origins: [], slack: [], mcp: [] };
const sources = (message = msg, receipts = [] as ReturnType<typeof testSlackReceipt>[]) => ({
  ...testSessionSources(message, receipts),
  context: { ...known, slack: receipts },
});
const checkKnown = async () => ({ ok: true as const });
const key = sessionKey(msg.threadKey, "coding");
const run = (over: Partial<RunView> = {}): RunView => ({
  id: "run-a",
  agent: "coding",
  userId: msg.userId,
  channelId: msg.channelId,
  threadKey: msg.threadKey,
  startedAt: 1,
  finished: true,
  eventCount: 0,
  session: { key, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
  ...over,
});
const transcript = { complete: true as const, turns: 0, messages: [], compactions: [] };
function ledger(over: Partial<Pick<RunLedger, "readSessionTail" | "readNotepad">> = {}) {
  return {
    readNotepad: vi.fn(async () => ({ text: "The retries use exponential backoff.", updatedAt: 9 })),
    readSessionTail: vi.fn(async () => ({ from: 0, transcript, sources: sources() })),
    ...over,
  };
}

describe("operator working notes", () => {
  it("normalizes canonical note origins before a long session reaches the dependency limit", async () => {
    const runs = Array.from({ length: 72 }, (_, i) => run({ id: `run-${i}` }));
    const latest = {
      ...known,
      revision: 72,
      origins: [
        {
          runId: "run-71",
          requester: msg.userId,
          channelId: msg.channelId,
          threadKey: msg.threadKey,
          checkpoint: "a".repeat(64),
        },
      ],
    };
    const store = ledger({
      readSessionTail: async () => ({ from: 72, transcript, sources: { ...sources(), context: latest } }),
    });
    const validateDependencies = vi.fn(checkKnown);
    const normalizeDependencies = vi.fn(
      async (contexts: readonly ContextDependencies[], candidates: readonly ContextDependencies[]) => {
        expect(validateDependencies).not.toHaveBeenCalled();
        expect(contexts).toHaveLength(73);
        expect(contexts.every((c) => c.status === "known")).toBe(true);
        expect(contexts.flatMap((c) => c.origins.map((o) => o.runId))).toContain("run-0");
        expect(candidates).toEqual([latest]);
        return [latest];
      },
    );
    const result = await readOperatorNotes({
      ledger: store,
      runs,
      msg,
      io: {} as ChannelIO,
      validateDependencies,
      normalizeDependencies,
    });
    expect(result.notes).toHaveLength(1);
    expect(result.context?.origins).toEqual(latest.origins);
    expect(normalizeDependencies).toHaveBeenCalledOnce();
    expect(validateDependencies).toHaveBeenCalledExactlyOnceWith(latest);
  });
  it("uses the current full envelope when the legacy direct source tracker is unknown", async () => {
    const store = ledger({
      readSessionTail: async () => ({
        from: 0,
        transcript,
        requiresFreshSources: true,
        sources: { version: 1, status: "unknown", context: known },
      }),
    });
    const validateDependencies = vi.fn(checkKnown);
    const result = await readOperatorNotes({
      ledger: store,
      runs: [run()],
      msg,
      io: {} as ChannelIO,
      validateDependencies,
    });
    expect(result.notes).toHaveLength(1);
    expect(validateDependencies).toHaveBeenCalledWith(
      expect.objectContaining({
        origins: [{ runId: "run-a", requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey }],
      }),
    );
  });

  it("allows another public producer only through its exact canonical origin and current source check", async () => {
    const producer = { ...msg, userId: "slack:UB" };
    const origin = { runId: "public", requester: producer.userId, channelId: msg.channelId, threadKey: msg.threadKey };
    const context = { ...known, origins: [origin] };
    const store = ledger({
      readSessionTail: async () => ({ from: 0, transcript, sources: { ...sources(producer), context } }),
    });
    const validateDependencies = vi.fn(checkKnown);
    const result = await readOperatorNotes({
      ledger: store,
      runs: [run({ id: "public", userId: producer.userId })],
      msg,
      io: {} as ChannelIO,
      validateDependencies,
    });
    expect(result.notes).toHaveLength(1);
    expect(validateDependencies).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ origins: [origin] }));
    store.readSessionTail = async () => ({ from: 0, transcript, sources: testSessionSources(producer, []) });
    expect(
      (
        await readOperatorNotes({
          ledger: store,
          runs: [run({ id: "public", userId: producer.userId })],
          msg,
          io: {} as ChannelIO,
          validateDependencies,
        })
      ).notes,
    ).toEqual([]);
    expect(validateDependencies).toHaveBeenCalledOnce();
  });

  it("reads the current requester's canonical session notes once", async () => {
    const store = ledger();
    const result = await readOperatorNotes({
      ledger: store,
      runs: [run(), run({ id: "run-b" })],
      msg,
      io: {} as ChannelIO,
      validateDependencies: checkKnown,
    });
    expect(result).toMatchObject({
      notes: [{ session: key, text: "The retries use exponential backoff.", updatedAt: 9 }],
      unavailable: [],
      context: {
        status: "known",
        origins: [
          { runId: "run-a", requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
          { runId: "run-b", requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
        ],
      },
    });
    expect(store.readNotepad).toHaveBeenCalledExactlyOnceWith(key);
  });

  it("uses a canonical unit lane without inventing a legacy fallback or another requester's session", async () => {
    const store = ledger();
    const canonical = "instance:task:coding";
    const result = await readOperatorNotes({
      ledger: store,
      runs: [
        run({ session: { key: canonical, seedFrom: 0, request: 0, range: { from: 0, to: 1 } } }),
        run({ id: "no-session", session: undefined }),
        run({ id: "foreign", userId: "slack:UB", channelId: "slack:CB" }),
      ],
      msg,
      io: {} as ChannelIO,
      validateDependencies: checkKnown,
    });
    expect(result.notes.map((note) => note.session)).toEqual([canonical]);
    expect(store.readNotepad).toHaveBeenCalledExactlyOnceWith(canonical);
  });

  it("reads the note snapshot before source metadata and retains notes across compaction", async () => {
    const calls: string[] = [];
    const store = ledger({
      readNotepad: async () => {
        calls.push("notes");
        return { text: "Retained decision", updatedAt: 9 };
      },
      readSessionTail: async () => {
        calls.push("sources");
        return {
          from: 70,
          transcript: { ...transcript, compactions: [{ before: 0, entry: { summary: "Old conversation" } }] },
          sources: sources(),
        };
      },
    });
    const result = await readOperatorNotes({
      ledger: store,
      runs: [run()],
      msg,
      io: {} as ChannelIO,
      validateDependencies: checkKnown,
    });
    expect(result.notes[0].text).toBe("Retained decision");
    expect(calls).toEqual(["notes", "sources"]);
  });

  it("revalidates current source receipts and omits denied notes while retaining safe sessions", async () => {
    const other = "instance:task:review";
    const check = vi.fn(async (context) =>
      context.slack.length ? { ok: false as const, code: "slack-source-unverified" as const } : { ok: true as const },
    );
    const store = ledger({
      readSessionTail: async (session) => ({
        from: 0,
        transcript,
        sources: sources(msg, session === key ? [testSlackReceipt(msg)] : []),
      }),
    });
    const result = await readOperatorNotes({
      ledger: store,
      runs: [run(), run({ id: "review", session: { key: other, seedFrom: 0, request: 0, range: { from: 0, to: 1 } } })],
      msg,
      io: {} as ChannelIO,
      validateDependencies: check,
    });
    expect(result.notes.map((note) => note.session)).toEqual([other]);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ status: "known", slack: [testSlackReceipt(msg)] }));
    expect(result.unavailable.join(" ")).toContain("slack-source-unverified");
  });

  it("admits known receipts only after the canonical revalidator accepts their exact binding", async () => {
    const check = vi.fn(checkKnown);
    const store = ledger({
      readSessionTail: async () => ({ from: 0, transcript, sources: sources(msg, [testSlackReceipt(msg)]) }),
    });
    expect(
      (await readOperatorNotes({ ledger: store, runs: [run()], msg, io: {} as ChannelIO, validateDependencies: check }))
        .notes,
    ).toHaveLength(1);
    expect((await readOperatorNotes({ ledger: store, runs: [run()], msg, io: {} as ChannelIO })).notes).toEqual([]);
    store.readSessionTail = async () => ({
      from: 0,
      transcript,
      sources: testSessionSources(msg, []),
    });
    expect(
      (await readOperatorNotes({ ledger: store, runs: [run()], msg, io: {} as ChannelIO, validateDependencies: check }))
        .notes,
    ).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("omits unknown, revoked and unsupported provenance without trusting source-free prose", async () => {
    for (const metadata of [
      {},
      { sources: testSessionSources(msg, []) },
      { sources: { version: 1 as const, status: "unknown" as const } },
      { sources: { version: 1 as const, status: "revoked" as const } },
    ]) {
      const store = ledger({ readSessionTail: async () => ({ from: 0, transcript, ...metadata }) });
      const result = await readOperatorNotes({
        ledger: store,
        runs: [run()],
        msg,
        io: {} as ChannelIO,
        validateDependencies: checkKnown,
      });
      expect(result.notes).toEqual([]);
      expect(result.unavailable).toHaveLength(1);
    }
  });

  it("rechecks a private destination before returning notes and isolates a failed read", async () => {
    const direct: IncomingMessage = {
      ...msg,
      channelId: "slack:DA",
      threadKey: "slack:DA:1.0",
      directAudience: {
        kind: "slack-unshared-im",
        userId: msg.userId,
        channelId: "slack:DA",
        threadKey: "slack:DA:1.0",
      },
    };
    const store = ledger({
      readSessionTail: async () => ({ from: 0, transcript, sources: sources(direct) }),
    });
    const io = {
      directAudience: () => direct.directAudience,
      verifyDirectAudience: async () => ({ ok: false as const, code: "direct-audience-denied" as const }),
    } as unknown as ChannelIO;
    const result = await readOperatorNotes({
      ledger: store,
      runs: [run({ channelId: direct.channelId, threadKey: direct.threadKey })],
      msg: direct,
      io,
      validateDependencies: checkKnown,
    });
    expect(result.notes).toEqual([]);
    expect(result.unavailable.join(" ")).toContain("direct-audience-denied");
    const broken = await readOperatorNotes({
      ledger: ledger({
        readNotepad: async () => {
          throw new Error("down");
        },
      }),
      runs: [run()],
      msg,
      io: {} as ChannelIO,
      validateDependencies: checkKnown,
    });
    expect(broken.notes).toEqual([]);
    expect(broken.unavailable).toHaveLength(1);
  });
});
