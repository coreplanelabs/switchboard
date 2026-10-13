import { describe, expect, it } from "vitest";
import { WorkerRunLedger } from "../../src/core/runLedgerWorker.ts";
import { fetchMemoryTest } from "./testFetch.ts";

describe("durable harness launch in SQLite", () => {
  it.each(["pi", "opencode"] as const)("preserves %s permissions and fences launch rollback", async (harness) => {
    const client = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "test-token",
      storeKey: `runs:launch:${crypto.randomUUID()}`,
      fetch: (url, init) => fetchMemoryTest(String(url), init),
    });
    const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const policy = { version: 1, commandRoute: "hosted-review", identity: "read" };
    const prepared = { version: 1, harness, phase: "prepared", ordinal: 0, sessionPolicy: policy };
    expect(
      await client.claim({
        runId: id,
        threadKey: "mcp:fixture:launch",
        gen: "g1",
        startedAt: 1,
        leaseMs: 10000,
        system: "original",
        tools: [],
        meta: { channelId: "mcp:fixture", userId: "slack:fixture", threadKey: "mcp:fixture:launch" },
        state: { harnessLaunch: prepared },
      }),
    ).toMatchObject({ ok: true });
    expect(await client.setState(id, "g1", { checklist: "original" })).toEqual({ ok: true });
    const read = await client.peekInbox(id, "g1", 0);
    if (!read.ok) throw new Error("original state unavailable");
    expect(read.boundary.state).toEqual({ checklist: "original", harnessLaunch: prepared });
    const begun = { ...prepared, phase: "begun" };
    expect(await client.setState(id, "g1", { harnessLaunch: begun })).toEqual({ ok: true });
    const saved = await client.peekInbox(id, "g1", 0);
    for (const replacement of [
      prepared,
      { ...begun, sessionPolicy: { version: 1, commandRoute: "native", identity: "read" } },
    ]) {
      expect(await client.setState(id, "g1", { harnessLaunch: replacement })).toEqual({ ok: false, reason: "fenced" });
      expect(await client.peekInbox(id, "g1", 0)).toEqual(saved);
    }
    expect(await client.setState(id, "foreign", { harnessLaunch: begun })).toEqual({ ok: false, reason: "fenced" });
    expect(await client.peekInbox(id, "g1", 0)).toEqual(saved);
    const producer = {
      harness,
      pid: 42,
      logOffset: 0,
      launchOrdinal: 0,
      sessionPolicy: policy,
      root: "/workspace/owned",
      container: "vm-original",
      processBirth: "original",
    };
    expect(await client.setState(id, "g1", { harnessLaunch: begun, harness: producer })).toEqual({ ok: true });
    const ended = { ...producer, ended: true };
    expect(await client.setState(id, "g1", { harnessLaunch: begun, harness: ended })).toEqual({ ok: true });
    const confirmed = await client.peekInbox(id, "g1", 0);
    for (const stale of [producer, { ...ended, pid: 43 }, { ...ended, processBirth: "foreign" }]) {
      expect(await client.setState(id, "g1", { harnessLaunch: begun, harness: stale })).toEqual({
        ok: false,
        reason: "fenced",
      });
      expect(await client.peekInbox(id, "g1", 0)).toEqual(confirmed);
    }
    const postTurn = { ...prepared, ordinal: 1, clockKind: "turn" };
    expect(await client.setState(id, "g1", { harnessLaunch: postTurn })).toEqual({ ok: true });
    const successor = await client.peekInbox(id, "g1", 0);
    if (!successor.ok) throw new Error("successor state unavailable");
    expect(successor.boundary.state.harness).toMatchObject({ pid: 42, ended: true });
    expect(successor.boundary.state.harnessLaunch).toMatchObject({
      phase: "prepared",
      ordinal: 1,
      clockKind: "turn",
      sessionPolicy: { version: 1, commandRoute: "hosted-review", identity: "read" },
    });
    expect(await client.setState(id, "g1", { harnessLaunch: { ...prepared, ordinal: 1 } })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await client.peekInbox(id, "g1", 0)).toEqual(successor);
  });
});
