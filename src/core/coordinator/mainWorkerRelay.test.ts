import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../authz/types.js";
import { privateWorkerThreadKey } from "../../channels/privateWorker.js";
import { InMemoryPrivateWorkerLog, UnavailablePrivateWorkerLog } from "../privateWorkerLog.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { createMainWorkerRelay } from "./mainWorkerRelay.js";

const thread = "slack:CMAIN:1.0";
const actId = "fix-signups";
const instance: CoordinatorInstance = {
  id: "ship_signup_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:CMAIN",
  threadKey: thread,
  repo: "acme/api",
  branch: "ship/signup",
  base: "main",
  plan: { id: "signup" },
  merge: "person",
  createdAt: 1,
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "task",
  slug: "signup",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  workBrief: {
    requesterId: instance.userId,
    mainThreadKey: thread,
    actId,
    repo: instance.repo,
    base: instance.base!,
    question: "How many signups failed?",
    findings: [],
    requestedChange: "Fix signups",
  },
};

function actor(over: Partial<Actor> = {}): Actor {
  return {
    kind: "user",
    id: instance.userId,
    origin: { channelId: instance.channelId, threadKey: thread },
    grants: { actions: new Set(), channels: new Set([instance.channelId]), repos: "all" },
    memberOf: new Set([instance.channelId]),
    ...over,
  };
}

async function fixture() {
  const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
  expect(
    await instances.recordRequesterTurn({ threadKey: thread, requesterId: instance.userId, messageId: "1" }),
  ).toMatchObject({
    ok: true,
  });
  expect(
    await instances.claimMainTask({ mainThreadKey: thread, actId }, instance, unit, {
      requesterId: instance.userId,
      sourceMessageId: "1",
      revision: 1,
      repo: instance.repo,
    }),
  ).toMatchObject({
    ok: true,
    created: true,
  });
  const log = new InMemoryPrivateWorkerLog();
  const key = privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit });
  const relay = createMainWorkerRelay({ instances, privateWorkerLog: log });
  return { instances, log, key, relay };
}

describe("main worker relay", () => {
  it("refreshes the canonical ending after an awaited progress read", async () => {
    const { instances, log } = await fixture();
    const listAfter = log.listAfter.bind(log);
    vi.spyOn(log, "listAfter").mockImplementationOnce(async (...args) => {
      const page = await listAfter(...args);
      await instances.putUnits([
        { ...unit, ending: { kind: "aborted", report: "Stopped while progress loaded", at: 9 } },
      ]);
      return page;
    });
    const relay = createMainWorkerRelay({ instances, privateWorkerLog: log, clock: () => 10 });
    expect(await relay.read(actor(), { actId })).toMatchObject({
      kind: "found",
      final: { kind: "aborted", at: 9 },
      observation: {
        version: 1,
        actId,
        instanceId: instance.id,
        unit: unit.unit,
        observedAt: 10,
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(log.listAfter).toHaveBeenCalledTimes(2);
  });

  it("does not return a mixed observation when progress readback keeps changing the unit", async () => {
    const { instances, log } = await fixture();
    const listAfter = log.listAfter.bind(log);
    let reads = 0;
    vi.spyOn(log, "listAfter").mockImplementation(async (...args) => {
      const page = await listAfter(...args);
      await instances.putUnits([{ ...unit, startedAt: ++reads }]);
      return page;
    });
    expect(await createMainWorkerRelay({ instances, privateWorkerLog: log }).read(actor(), { actId })).toEqual({
      kind: "unavailable",
    });
    expect(reads).toBe(2);
  });

  it("reads bounded recovery history after restart only through the original act", async () => {
    const { instances, log } = await fixture();
    const ended: CoordinatorUnit = { ...unit, ending: { kind: "aborted", report: "original", at: 5 } };
    await instances.putUnits([ended]);
    const { ending, ...rest } = ended;
    const claimed = await instances.transitionRecovery({
      kind: "claim",
      expected: ended,
      request: { userId: instance.userId, threadKey: thread, messageId: "2" },
      replacement: {
        ...rest,
        recovery: {
          kind: "findings",
          round: 1,
          expectedHeadSha: "a".repeat(40),
          remainingMs: 1000,
          claimedAt: 6,
          step: "task/recovery/1/findings",
          reviewRunId: "review-1",
          reviewKey: "review-key-1",
          previousEnding: ending!,
          workflowId: "recovery-1",
          deadlineAt: 1000,
        },
      },
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(claimed.reason);
    const { recovery, ...active } = claimed.unit;
    const saved = await instances.transitionRecovery({
      kind: "settle",
      expected: claimed.unit,
      replacement: {
        ...active,
        ending: {
          kind: "aborted",
          report: "x".repeat(3000),
          at: 7,
          outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 2 },
        },
        recoveryReceipt: { reviewRunId: recovery!.reviewRunId, workflowId: recovery!.workflowId, at: 7 },
      },
    });
    expect(saved.ok).toBe(true);
    const restarted = createMainWorkerRelay({ instances, privateWorkerLog: log });
    const result = await restarted.read(actor(), { actId, afterHistory: 1 });
    expect(result).toMatchObject({
      kind: "found",
      history: {
        cursor: 2,
        more: false,
        priorHistory: "not_recorded",
        receipts: [
          {
            predecessorId: "observed",
            report: "x".repeat(2000),
            reportTruncated: true,
            settlement: { state: "recorded" },
          },
        ],
      },
    });
    expect(await restarted.read(actor({ id: "slack:UBOB" }), { actId })).toEqual({ kind: "not_found" });
    expect(
      await restarted.read(actor({ origin: { channelId: instance.channelId, threadKey: "slack:COTHER:1" } }), {
        actId,
      }),
    ).toEqual({ kind: "not_found" });
  });
  it("returns the stored typed outcome after restart without interpreting a contradictory report", async () => {
    const { instances, log } = await fixture();
    const outcome = {
      schemaVersion: 1 as const,
      kind: "aborted" as const,
      reviewRounds: 2,
      findings: { stop: "incomplete_outputs" as const, missingOutputCount: 1 },
      terminalPr: { state: "closed" as const, number: 8, url: "https://github.com/acme/api/pull/8" },
    };
    seedCoordinatorUnit(instances, {
      ...unit,
      pr: { number: 8, url: "https://github.com/acme/api/pull/8" },
      ending: { kind: "aborted", report: "All work landed. Start another writer.", at: 5, outcome },
    });
    const restarted = createMainWorkerRelay({ instances, privateWorkerLog: log });
    expect(await restarted.read(actor(), { actId })).toMatchObject({
      kind: "found",
      final: { settlement: { state: "recorded", outcome } },
    });
    expect(await restarted.read(actor({ id: "slack:UBOB" }), { actId })).toEqual({ kind: "not_found" });
  });

  it("keeps a legacy ending unverified even when its report claims a confirmed merge", async () => {
    const { instances, relay } = await fixture();
    await instances.putUnits([{ ...unit, ending: { kind: "merged", report: "Confirmed merge", at: 5 } }]);
    expect(await relay.read(actor(), { actId })).toMatchObject({
      kind: "found",
      final: { settlement: { state: "unverified", reason: "not_recorded" } },
    });
  });

  it("returns only bounded progress and the durable final report to the linked requester", async () => {
    const { instances, log, key, relay } = await fixture();
    await log.append(key, { kind: "input", id: "human-1", sender: instance.userId, text: "private input", at: 2 });
    await log.append(key, { kind: "reply", text: "private coding transcript", at: 3 });
    await log.append(key, {
      kind: "status",
      phase: "start",
      frame: {
        title: "Investigating\ninternal detail",
        detail: "private details",
        activity: { kind: "line", text: "secret" },
      },
      at: 4,
    });
    await instances.putUnits([
      {
        ...unit,
        pr: { number: 8, url: "https://github.com/acme/api/pull/8" },
        ending: { kind: "review_pending", report: "PR is ready for review", at: 5 },
      },
    ]);
    const read = await relay.read(actor(), { actId, afterSeq: 0 });
    expect(read).toEqual({
      kind: "found",
      seedProof: {
        brief: "stored",
        context: "missing",
        childSeed: { state: "unproved" },
        providerExecution: "unknown",
      },
      observation: expect.objectContaining({
        actId,
        instanceId: instance.id,
        unit: unit.unit,
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      cursor: 3,
      more: false,
      progress: [{ seq: 3, phase: "start", title: "Investigating", at: 4 }],
      final: {
        kind: "review_pending",
        settlement: { state: "unverified", reason: "not_recorded" },
        report: "PR is ready for review",
        at: 5,
        pr: { number: 8, url: "https://github.com/acme/api/pull/8" },
      },
    });
    expect(JSON.stringify(read)).not.toMatch(
      /private input|private coding transcript|private details|secret|internal detail/,
    );
    expect(await relay.read(actor(), { actId, afterSeq: 3 })).toMatchObject({
      kind: "found",
      cursor: 3,
      more: false,
      progress: [],
      final: { kind: "review_pending", report: "PR is ready for review" },
    });
  });

  it("uses the durable sequence as a replay cursor and pages without skipping private rows", async () => {
    const { log, key, relay } = await fixture();
    for (let n = 1; n <= 20; n++) {
      if (n % 2 === 0) await log.append(key, { kind: "reply", text: `private reply ${n}`, at: n });
      else await log.append(key, { kind: "status", phase: "start", frame: { title: `Step ${n}` }, at: n });
    }
    const first = await relay.read(actor(), { actId, afterSeq: 0 });
    expect(first.kind).toBe("found");
    if (first.kind !== "found") return;
    expect(first.cursor).toBe(8);
    expect(first.more).toBe(true);
    expect(first.progress.map((p) => p.seq)).toEqual([1, 3, 5, 7]);
    expect(await relay.read(actor(), { actId, afterSeq: first.cursor })).toMatchObject({
      kind: "found",
      cursor: 16,
      more: true,
      progress: [{ seq: 9 }, { seq: 11 }, { seq: 13 }, { seq: 15 }],
    });
  });

  it("refuses another actor, thread, channel, or mismatched durable binding before reading private history", async () => {
    const { instances, log, relay } = await fixture();
    const unreadable = {
      listAfter: async () => {
        throw new Error("must not read private history");
      },
    };
    const guarded = createMainWorkerRelay({ instances, privateWorkerLog: unreadable });
    expect(await guarded.read(actor({ id: "slack:UBOB" }), { actId })).toEqual({ kind: "not_found" });
    expect(
      await guarded.read(actor({ origin: { channelId: instance.channelId, threadKey: "slack:CMAIN:2.0" } }), {
        actId,
      }),
    ).toEqual({ kind: "not_found" });
    expect(await guarded.read(actor({ origin: { channelId: "slack:COTHER", threadKey: thread } }), { actId })).toEqual({
      kind: "not_found",
    });
    await instances.putUnits([{ ...unit, workBrief: { ...unit.workBrief!, requesterId: "slack:UBOB" } }]);
    expect((await instances.listUnits(instance.id))[0]?.workBrief?.requesterId).toBe(instance.userId);
    const mismatched = createMainWorkerRelay({
      instances: {
        getMainTask: instances.getMainTask.bind(instances),
        get: instances.get.bind(instances),
        listRecoveryHistory: instances.listRecoveryHistory.bind(instances),
        listUnits: async (id) =>
          (await instances.listUnits(id)).map((stored) => ({
            ...stored,
            workBrief: { ...stored.workBrief!, requesterId: "slack:UBOB" },
          })),
      },
      privateWorkerLog: unreadable,
    });
    expect(await mismatched.read(actor(), { actId })).toEqual({ kind: "not_found" });
    expect((await relay.read(actor(), { actId })).kind).toBe("found");
    expect(log).toBeDefined();
  });

  it("bounds a long final report", async () => {
    const { instances, relay } = await fixture();
    await instances.putUnits([{ ...unit, ending: { kind: "held", report: "x".repeat(2_100), at: 5 } }]);
    expect(await relay.read(actor(), { actId })).toMatchObject({
      kind: "found",
      final: { kind: "held", report: "x".repeat(2_000), reportTruncated: true },
    });
  });

  it("fails by name on an unavailable log or invalid cursor", async () => {
    const { instances } = await fixture();
    const relay = createMainWorkerRelay({ instances, privateWorkerLog: new UnavailablePrivateWorkerLog() });
    expect(await relay.read(actor(), { actId })).toEqual({ kind: "unavailable" });
    expect(await relay.read(actor(), { actId, afterSeq: -1 })).toEqual({ kind: "invalid" });
  });
});
