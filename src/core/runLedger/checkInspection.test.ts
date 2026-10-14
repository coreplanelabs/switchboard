import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "../runFriction.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { checkStateFixture } from "../testing/checkState.js";
import type { RunRecord } from "../runRecord.js";
import type { ClaimRequest } from "./types.js";

const id = "check-run",
  thread = "slack:private:1";
const owner = { runId: id, threadKey: thread, requester: "slack:alice", repo: "acme/repo" };
const selector = { runId: id, callId: "call-1", phase: "command" as const };
const request = (gen = "g1"): ClaimRequest => ({
  runId: id,
  threadKey: thread,
  gen,
  startedAt: 1000,
  leaseMs: 10000,
  system: "",
  tools: [],
  meta: {
    userId: owner.requester,
    channelId: "slack:private",
    channelVisibility: "private",
    threadKey: thread,
    repo: owner.repo,
  },
});
const record = (): RunRecord =>
  ({
    id,
    userId: owner.requester,
    channelId: "slack:private",
    channelVisibility: "private",
    threadKey: thread,
    repo: owner.repo,
    startedAt: 1000,
    finishedAt: 2000,
    sealedAt: 2000,
    status: "completed",
    events: [],
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    diagnosis: analyzeRunFriction([]),
  }) as RunRecord;

describe("canonical check terminal custody", () => {
  it("captures the fenced source privately and does not trust a changed final visibility", async () => {
    const ledger = new InMemoryRunLedger(() => 3000);
    await ledger.claim(request());
    await ledger.setState(id, "g1", { checkExecutions: await checkStateFixture(owner) });
    expect(
      await ledger.finish(id, "g1", { ...record(), channelVisibility: "public", channelId: "slack:public" }),
    ).toEqual({ ok: true, stored: true });
    expect(await ledger.readCheckSource(selector)).toMatchObject({
      kind: "source",
      source: {
        state: "terminal",
        resource: { channelVisibility: "private", channelId: "slack:private" },
        result: { stdout: "saved original output" },
      },
    });
    expect(JSON.stringify(ledger.finished.get(id))).not.toContain("saved original output");
    expect(ledger.live.has(id)).toBe(false);
  });
  it("refuses a forged archive and malformed state before deleting the live owner", async () => {
    const ledger = new InMemoryRunLedger(() => 3000);
    await ledger.claim(request());
    const checks = await checkStateFixture(owner, { unknown: true });
    await ledger.setState(id, "g1", { checkExecutions: checks });
    expect(await ledger.finish(id, "g1", { ...record(), checkArchive: { sealed: true } } as RunRecord)).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await ledger.readCheckSource(selector)).toMatchObject({
      kind: "source",
      source: { state: "live", operation: checks.receipts[0].checkOperation },
    });
    ledger.live.get(id)!.state.checkExecutions = { version: 1, receipts: [{ callId: "lost" }] };
    await expect(ledger.finish(id, "g1", record())).rejects.toThrow("canonical check state is unreadable");
    expect(ledger.live.get(id)?.state.checkExecutions).toEqual({ version: 1, receipts: [{ callId: "lost" }] });
  });
  it("replaces a restart snapshot with the final owner state before sealing", async () => {
    const ledger = new InMemoryRunLedger(() => 3000);
    await ledger.claim(request());
    const early = await checkStateFixture(owner);
    await ledger.setState(id, "g1", { checkExecutions: early });
    expect(await ledger.finish(id, "g1", { ...record(), restarting: true, restartUntil: 9000 })).toEqual({
      ok: true,
      stored: true,
    });
    expect(await ledger.readCheckSource(selector)).toEqual({ kind: "unavailable" });
    await ledger.claim(request("g2"));
    expect(await ledger.readCheckSource(selector)).toMatchObject({
      kind: "source",
      source: { state: "live", result: { stdout: "saved original output" } },
    });
    const latest = await checkStateFixture(owner, {
      initial: early,
      callId: "call-2",
      output: "later original output",
    });
    await ledger.setState(id, "g2", { checkExecutions: latest });
    expect(await ledger.finish(id, "g2", record())).toEqual({ ok: true, stored: true });
    expect(await ledger.readCheckSource({ ...selector, callId: "call-2" })).toMatchObject({
      kind: "source",
      source: { state: "terminal", result: { stdout: "later original output" } },
    });
    expect(await ledger.readCheckSource(selector)).toMatchObject({
      kind: "source",
      source: { result: { stdout: "saved original output" } },
    });
  });
});
