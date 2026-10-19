import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSourceTaskSnapshot, sourceTaskSnapshotOf } from "./sourceTaskSnapshot.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { LEASE_MS, type LiveRunMeta } from "../runLedger/types.js";
import { SOURCE_TASK_SNAPSHOT_MAX_BYTES } from "../budgets.js";
import { MAX_RECORD_BYTES, type RunRecord } from "../runRecord.js";
import { analyzeRunFriction } from "../runFriction.js";
import { toListItem } from "../runStore.js";

afterEach(() => vi.restoreAllMocks());
const owner = { runId: "root", requesterId: "cli:alice", channelId: "cli:main", threadKey: "cli:thread" };
const original = {
  version: 1 as const,
  owner,
  task: {
    repo: "fixture/api",
    ref: "accepted-branch",
    baseRef: "main",
    headSha: "a".repeat(40),
    pr: 7,
    operationTarget: {
      repo: "fixture/api",
      ref: "accepted-branch",
      prTarget: { number: 7, source: "request", quote: "Review PR 7" },
    },
    githubSource: null,
    recordTaskKey: "b".repeat(16),
  },
};
const meta: LiveRunMeta = {
  agent: "orchestrator",
  userId: "cli:alice",
  channelId: "cli:main",
  threadKey: "cli:thread",
  repo: "fixture/api",
  ref: "accepted-branch",
  baseRef: "main",
  headSha: "a".repeat(40),
  pr: 7,
  operationTarget: original.task.operationTarget,
  recordTaskKey: "b".repeat(16),
};
async function fixture() {
  const ledger = new InMemoryRunLedger(() => 100);
  await ledger.claim({
    runId: "root",
    threadKey: "cli:thread",
    gen: "g1",
    startedAt: 100,
    leaseMs: LEASE_MS,
    system: "Root",
    tools: [],
    meta,
  });
  return ledger;
}
function terminal(): RunRecord {
  return {
    id: "root",
    agent: "orchestrator",
    model: "fixture/model",
    userId: "cli:alice",
    channelId: "cli:main",
    threadKey: "cli:thread",
    channelVisibility: "unknown",
    repo: "fixture/api",
    targetPr: 7,
    headSha: "c".repeat(40),
    startedAt: 100,
    finishedAt: 200,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
  };
}

describe("retained source task snapshots", () => {
  it("captures all original task fields as detached data", () => {
    const row = { runId: "root", meta: structuredClone(meta) };
    const snapshot = captureSourceTaskSnapshot(row);
    row.meta.headSha = "c".repeat(40);
    row.meta.ref = "later-branch";
    expect(snapshot).toEqual(original);
    expect(sourceTaskSnapshotOf(snapshot)).toEqual(original);
  });
  it("requires a complete supported snapshot and rejects imported authority", () => {
    expect(sourceTaskSnapshotOf(original)).toEqual(original);
    for (const value of [
      { ...original, version: 2 },
      { ...original, authenticatedAs: "access:other" },
      { ...original, task: { ...original.task, headSha: "invalid" } },
      { ...original, task: { ...original.task, pr: 0 } },
      { ...original, task: { ...original.task, grants: ["write"] } },
      { ...original, task: { repo: "fixture/api" } },
    ])
      expect(sourceTaskSnapshotOf(value)).toBeUndefined();
  });
  it("cannot capture a delegate as its own original root", () => {
    expect(captureSourceTaskSnapshot({ runId: "root", meta })).toEqual(original);
    expect(captureSourceTaskSnapshot({ runId: "root", meta: { ...meta, agent: "review" } })).toBeUndefined();
    expect(captureSourceTaskSnapshot({ runId: "root", meta: { ...meta, parentRunId: "earlier" } })).toBeUndefined();
  });
  it("does not evaluate an accessor or truncate oversized task data", () => {
    expect(sourceTaskSnapshotOf(original)).toEqual(original);
    let reads = 0;
    const unsafe = { ...original };
    Object.defineProperty(unsafe, "task", {
      enumerable: true,
      get: () => {
        reads++;
        return original.task;
      },
    });
    expect(sourceTaskSnapshotOf(unsafe)).toBeUndefined();
    expect(reads).toBe(0);
    expect(
      sourceTaskSnapshotOf({
        ...original,
        task: { ...original.task, operationTarget: { note: "x".repeat(SOURCE_TASK_SNAPSHOT_MAX_BYTES) } },
      }),
    ).toBeUndefined();
  });
  it("retains the acknowledged task when a later state writer omits it", async () => {
    const ledger = await fixture();
    expect(await ledger.setState("root", "g1", { sourceTask: original })).toEqual({ ok: true });
    expect(await ledger.setState("root", "g1", {})).toEqual({ ok: true });
    expect((await ledger.listLive())[0]!.state.sourceTask).toEqual(original);
  });
  it("refuses a changed task or a copied owner instead of replacing the original", async () => {
    const ledger = await fixture();
    expect(await ledger.setState("root", "g1", { sourceTask: original })).toEqual({ ok: true });
    expect(
      await ledger.setState("root", "g1", {
        sourceTask: { ...original, task: { ...original.task, ref: "other-branch" } },
      }),
    ).toEqual({ ok: false, reason: "fenced" });
    expect((await ledger.listLive())[0]!.state.sourceTask).toEqual(original);
  });
  it("checks the first snapshot against the canonical task and owner", async () => {
    const ledger = await fixture();
    expect(
      await ledger.setState("root", "g1", { sourceTask: { ...original, task: { ...original.task, pr: 8 } } }),
    ).toEqual({ ok: false, reason: "fenced" });
    expect(
      await ledger.setState("root", "g1", {
        sourceTask: { ...original, owner: { ...owner, runId: "different-root" } },
      }),
    ).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.setState("root", "g1", { sourceTask: original })).toEqual({ ok: true });
  });
  it("archives the acknowledged original task separately from the final workspace head", async () => {
    const ledger = await fixture();
    await ledger.setState("root", "g1", { sourceTask: original });
    const record = { ...terminal(), sourceTask: original };
    expect(await ledger.finish("root", "g1", record)).toMatchObject({ ok: true, stored: true });
    const saved = ledger.finished.get("root")!;
    expect(saved.sourceTask).toEqual(original);
    expect(saved.headSha).toBe("c".repeat(40));
    expect(saved.sourceTask?.task.headSha).toBe("a".repeat(40));
    expect(toListItem(saved, 100)).toMatchObject({ id: "root", headSha: "c".repeat(40) });
    expect(toListItem(saved, 100)).not.toHaveProperty("sourceTask");
  });
  it("does not accept task proof supplied only by a terminal caller", async () => {
    const ledger = await fixture();
    expect(await ledger.finish("root", "g1", { ...terminal(), sourceTask: original })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect((await ledger.listLive())[0]!.meta.ref).toBe("accepted-branch");
  });
  it("keeps the acknowledged task live when archive capacity is exhausted", async () => {
    const ledger = await fixture();
    await ledger.setState("root", "g1", { sourceTask: original });
    await expect(ledger.finish("root", "g1", { ...terminal(), label: "x".repeat(MAX_RECORD_BYTES) })).rejects.toThrow(
      "source task evidence exceeds record byte limit",
    );
    expect((await ledger.listLive())[0]!.state.sourceTask).toEqual(original);
  });
});
