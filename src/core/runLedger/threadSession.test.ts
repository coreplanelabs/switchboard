import type { ContextDependencies } from "../references/contextDependencies.js";
import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { storedTurnRow, contextThreadSessionKey as threadSessionKey } from "./sessionLog.js";
import { appendRunReport, appendThreadTurn, migrateThreadSession } from "./threadSession.js";

describe("thread session — durable turns and legacy context", () => {
  const threadKey = "slack:C1:1.0";
  const coding = `${threadKey}:coding`;
  const review = `${threadKey}:review`;
  const run = (agent: string, startedAt: number, from: number, to: number) => ({
    agent,
    startedAt,
    session: { key: `${threadKey}:${agent}`, seedFrom: from, request: from, range: { from, to } },
  });
  const append = (ledger: InMemoryRunLedger, key: string, rowId: string, text: string, actor?: string) =>
    ledger.appendSession(key, rowId, [
      { part: 0, json: storedTurnRow({ role: actor ? "user" : "assistant", text, actor }) },
    ]);

  it("folds a child report once into its canonical parent's thread with original dependencies", async () => {
    const ledger = new InMemoryRunLedger();
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [{ runId: "child", requester: "slack:U11", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    };
    const report = {
      runId: "child",
      threadKey,
      requester: "slack:U11",
      channelId: "slack:C1",
      text: "full child report",
      context,
      parentRunId: "parent",
    };
    const parent = async () => ({
      id: "parent",
      threadKey: "slack:C1:parent",
      userId: "slack:U11",
      channelId: "slack:C1",
    });
    expect(await appendRunReport(ledger, report, parent)).toEqual({ parent: "appended" });
    await appendRunReport(ledger, report, parent);
    const tail = await ledger.readSessionTail(threadSessionKey("slack:C1:parent"), 100_000);
    expect(tail.transcript.messages).toHaveLength(1);
    expect(tail.transcript.marks).toEqual([{ folded: true }]);
    expect(tail.sources?.context?.origins).toEqual(context.origins);
    expect(
      await appendRunReport(ledger, report, async () => ({
        ...(await parent()),
        userId: "slack:OTHER",
        threadKey: "slack:C1:foreign",
      })),
    ).toEqual({ parent: "unavailable" });
    expect((await ledger.readSession(threadSessionKey("slack:C1:foreign"), 0)).messages).toEqual([]);
  });

  it("rechecks publication after a blocked parent lookup before handing over parent bytes", async () => {
    const ledger = new InMemoryRunLedger();
    let allowed = true;
    let entered!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const report = {
      runId: "child",
      threadKey,
      requester: "slack:U11",
      channelId: "slack:C1",
      text: "source-bearing report",
      parentRunId: "parent",
      context: { version: 1 as const, status: "known" as const, revision: 0, origins: [], slack: [], mcp: [] },
      canPublish: async () => allowed,
    };
    const running = appendRunReport(ledger, report, async () => {
      entered();
      await held;
      return { id: "parent", threadKey: "slack:C1:parent", userId: "slack:U11", channelId: "slack:C1" };
    });
    await lookupStarted;
    allowed = false;
    resume();
    expect(await running).toEqual({ parent: "withheld" });
    expect((await ledger.readSession(threadSessionKey("slack:C1:parent"), 0)).messages).toEqual([]);
    expect((await ledger.readSession(threadSessionKey(threadKey), 0)).messages).toHaveLength(1);
  });

  it("keeps silent turns and complete child reports once with their metadata", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const silent = {
      threadKey,
      rowId: "message",
      role: "user" as const,
      text: "later detail",
      actor: "slack:U11",
      silent: true,
    };
    await appendThreadTurn(ledger, silent);
    await appendThreadTurn(ledger, silent);
    await appendThreadTurn(ledger, {
      threadKey,
      rowId: "run:child",
      role: "assistant",
      text: "complete report",
      folded: true,
    });
    const read = await ledger.readSession(threadSessionKey(threadKey), 0);
    expect(read.messages.map((m) => m.content)).toEqual([
      [{ type: "text", text: "later detail" }],
      [{ type: "text", text: "complete report" }],
    ]);
    expect(read.actors).toEqual(["slack:U11", undefined]);
    expect(read.marks).toEqual([{ silent: true }, { folded: true }]);
  });

  it("atomically keeps report dependencies before rows and never heals missing provenance", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    const context: ContextDependencies = {
      version: 1,
      status: "known",
      revision: 0,
      origins: [{ runId: "source", requester: "slack:U11", channelId: "slack:C1", threadKey }],
      slack: [],
      mcp: [],
    };
    const input = { threadKey, rowId: "report", role: "assistant" as const, text: "report", context };
    await appendThreadTurn(ledger, input);
    expect((await ledger.readSessionTail(threadSessionKey(threadKey), 100_000)).sources?.context).toMatchObject({
      status: "known",
      origins: context.origins,
    });
    await appendThreadTurn(ledger, input);
    expect((await ledger.readSessionTail(threadSessionKey(threadKey), 100_000)).sources?.context?.status).toBe("known");
    await expect(appendThreadTurn(ledger, { ...input, context: undefined })).rejects.toThrow("refused");
    await appendThreadTurn(ledger, { ...input, rowId: "legacy", context: undefined });
    const after = (await ledger.readSessionTail(threadSessionKey(threadKey), 100_000)).sources?.context;
    expect(after).toMatchObject({ status: "unknown", origins: context.origins });
    await appendThreadTurn(ledger, { ...input, rowId: "next" });
    expect((await ledger.readSessionTail(threadSessionKey(threadKey), 100_000)).sources?.context?.status).toBe(
      "unknown",
    );
    const stored = await ledger.readSession(threadSessionKey(threadKey), 0);
    expect(stored.contexts?.map((context) => context?.status)).toEqual(["known", "unknown", "known"]);
    expect(stored.messages.map((message) => message.content[0])).toEqual(
      Array(3).fill({ type: "text", text: "report" }),
    );
    await expect(appendThreadTurn(ledger, { ...input, text: "changed bytes" })).rejects.toThrow("refused");
  });

  it("interleaves legacy working logs in run order and replays safely after a later finish", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    await append(ledger, coding, "c0", "request", "slack:U11");
    await append(ledger, coding, "c1", "first code report", "slack:U11");
    await append(ledger, coding, "c2", "second code report", "slack:U11");
    await append(ledger, review, "r0", "review report", "slack:U11");
    const runs = [run("coding", 30, 2, 2), run("review", 20, 0, 0), run("coding", 10, 0, 1)];
    const input = {
      threadKey,
      runs,
      maxBytes: 100_000,
      verifiedIngress: [
        { sessionKey: coding, index: 0, actor: "slack:U11", text: "request" },
        { sessionKey: coding, index: 1, actor: "slack:U11", text: "first code report" },
        { sessionKey: coding, index: 2, actor: "slack:U11", text: "second code report" },
        { sessionKey: coding, index: 3, actor: "slack:U11", text: "late finish" },
        { sessionKey: review, index: 0, actor: "slack:U11", text: "review report" },
      ],
    };
    expect(await migrateThreadSession(ledger, input)).toMatchObject({ appended: 4 });
    expect(await migrateThreadSession(ledger, input)).toMatchObject({ appended: 0 });
    expect((await ledger.readSessionTail(threadSessionKey(threadKey), 100_000)).sources?.context?.status).toBe("known");
    expect((await ledger.readSession(threadSessionKey(threadKey), 0)).messages.map((m) => m.content[0])).toEqual([
      { type: "text", text: "request" },
      { type: "text", text: "first code report" },
      { type: "text", text: "review report" },
      { type: "text", text: "second code report" },
    ]);
    await append(ledger, coding, "c3", "late finish", "slack:U11");
    expect(await migrateThreadSession(ledger, input)).toMatchObject({ appended: 1 });
    expect((await ledger.readSession(threadSessionKey(threadKey), 0)).messages.at(-1)?.content[0]).toEqual({
      type: "text",
      text: "late finish",
    });
  });

  it("does not copy private source results or quoted reference parts into operator context", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    await ledger.appendSession(coding, "source", [
      {
        part: 0,
        json: JSON.stringify({ role: "user", actor: "slack:U11", part: { type: "text", text: "original request" } }),
      },
      {
        part: 1,
        json: JSON.stringify({ role: "user", actor: "slack:U11", part: { type: "text", text: "private reference" } }),
      },
    ]);
    await append(ledger, coding, "answer", "private answer");
    const safeLedger = {
      appendSession: ledger.appendSession.bind(ledger),
      readSessionTail: async (key: string, bytes: number) => ({
        ...(await ledger.readSessionTail(key, bytes)),
        requiresFreshSources: true as const,
      }),
    };
    const migrated = await migrateThreadSession(safeLedger, {
      threadKey,
      runs: [run("coding", 10, 0, 1)],
      verifiedIngress: [{ sessionKey: coding, index: 0, actor: "slack:U11", text: "original request" }],
      maxBytes: 100_000,
    });
    expect(migrated).toMatchObject({ legacyKeys: [coding], omittedTurns: 1, omittedParts: 2 });
    const read = await ledger.readSession(threadSessionKey(threadKey), 0);
    expect(read.messages).toEqual([{ role: "user", content: [{ type: "text", text: "original request" }] }]);
    expect(read.actors).toEqual(["slack:U11"]);
  });

  it("treats absent metadata and actor stamps as unknown without independent ingress proof", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    await append(ledger, coding, "actor", "derived private text", "slack:U11");
    await append(ledger, coding, "assistant", "private answer");
    const input = { threadKey, runs: [run("coding", 1, 0, 1)], maxBytes: 100_000 };
    expect(await migrateThreadSession(ledger, input)).toEqual({
      appended: 0,
      legacyKeys: [coding],
      omittedTurns: 2,
      omittedParts: 2,
    });
    expect(
      await migrateThreadSession(ledger, {
        ...input,
        verifiedIngress: [{ sessionKey: coding, index: 0, actor: "slack:OTHER", text: "derived private text" }],
      }),
    ).toMatchObject({ appended: 0 });
    expect(
      await migrateThreadSession(ledger, {
        ...input,
        verifiedIngress: [{ sessionKey: coding, index: 0, actor: "slack:U11", text: "different bytes" }],
      }),
    ).toMatchObject({ appended: 0 });
    expect((await ledger.readSession(coding, 0)).messages).toHaveLength(2);
  });

  it("leaves canonical unit lanes out of the legacy migration", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    await append(ledger, "plan-p:unit:coding", "unit", "unit private evidence");
    expect(
      await migrateThreadSession(ledger, {
        threadKey,
        runs: [
          {
            ...run("coding", 1, 0, 0),
            session: { key: "plan-p:unit:coding", seedFrom: 0, request: 0, range: { from: 0, to: 0 } },
          },
        ],
        maxBytes: 100_000,
      }),
    ).toMatchObject({ appended: 0 });
  });

  it("does not migrate post-cutover working turns already recorded as connector and report events", async () => {
    const ledger = new InMemoryRunLedger(() => 1);
    await append(ledger, coding, "old", "old report", "slack:U11");
    await append(ledger, coding, "new", "new report", "slack:U11");
    const unified = run("coding", 20, 1, 1);
    const result = await migrateThreadSession(ledger, {
      threadKey,
      verifiedIngress: [
        { sessionKey: coding, index: 0, actor: "slack:U11", text: "old report" },
        { sessionKey: coding, index: 1, actor: "slack:U11", text: "new report" },
      ],
      runs: [
        { ...unified, session: { ...unified.session, threadSession: threadSessionKey(threadKey) } },
        run("coding", 10, 0, 0),
      ],
      maxBytes: 100_000,
    });
    expect(result.appended).toBe(1);
    expect((await ledger.readSession(threadSessionKey(threadKey), 0)).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "old report" }] },
    ]);
  });
});
