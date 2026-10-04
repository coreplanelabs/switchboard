import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { coordinatorReconciliationEffect } from "./workflowReconciliation.js";
import { coordinatorReportAdmission, freezeCoordinatorReport, readCoordinatorReport } from "./reportContext.js";
import type { CoordinatorReportFinalizationInput } from "./reportFinalization.js";
import type { CoordinatorReportOwner } from "./reportContext.js";
import { finalizeCoordinatorReport } from "./reportFinalization.js";
import { reconcileCoordinatorExecution, type CoordinatorReconcileSettlement } from "./reconcileExecution.js";
import { recoveryActionRenewed } from "./recoveryHistory.js";
import type { InstanceStatusAnswer } from "./instancesRoute.js";

// Feature: docs/reference/specs/orchestration-plane.md — bot reconciliation
// settles the original execution only, without replacement work or success
// credit from the Workflow's terminal status.
async function fixture() {
  const ledger = new InMemoryRunLedger();
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  const instance: CoordinatorInstance = {
    id: "reconcile_original",
    kind: "ship",
    userId: "cli:user",
    channelId: "cli:main",
    threadKey: "cli:main:1",
    repo: "acme/api",
    base: "main",
    branch: "fix/original",
    createdAt: 1,
    admission: "created",
  };
  let unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "ONE",
    slug: "one",
    branch: instance.branch,
    threadKey: instance.threadKey,
    dependsOn: [],
    rounds: [],
    startedAt: 2,
  };
  await instances.put(instance);
  seedCoordinatorUnit(instances, unit);
  const effect = await coordinatorReconciliationEffect(instance, unit);
  const settlements: CoordinatorReconcileSettlement[] = [];
  let native: InstanceStatusAnswer = { kind: "status", status: "complete" };
  const status = vi.fn(async (_id: string) => native);
  const finalize = vi.fn(async (input: CoordinatorReportFinalizationInput) =>
    finalizeCoordinatorReport({ ledger, instances }, input),
  );
  const settle = vi.fn(async (body: CoordinatorReconcileSettlement) => {
    settlements.push(body);
    const owner = {
      instanceId: instance.id,
      unit: unit.unit,
      attempt: 0,
      requester: instance.userId,
      channelId: instance.channelId,
      threadKey: unit.threadKey!,
      deliveryId: body.deliveryId,
    };
    const proposed = { text: body.ending.report, threadText: body.ending.threadReport };
    unit = {
      ...unit,
      ending: { ...body.ending, at: 3, deliveryId: body.deliveryId },
      reportDelivery: await coordinatorReportAdmission(owner, proposed),
    };
    seedCoordinatorUnit(instances, unit);
    await freezeCoordinatorReport(ledger, owner, proposed);
    return true;
  });
  const deps = {
    instances,
    status,
    settle,
    readReport: (owner: CoordinatorReportOwner) => readCoordinatorReport(ledger, owner),
    finalize,
  };
  return {
    ledger,
    instances,
    instance,
    get unit() {
      return unit;
    },
    setUnit: (next: CoordinatorUnit) => {
      unit = next;
      seedCoordinatorUnit(instances, next);
    },
    effect,
    settlements,
    deps,
    setStatus: (answer: InstanceStatusAnswer) => {
      native = answer;
    },
  };
}

describe("original execution reconciliation performer", () => {
  it.each(["complete", "errored", "terminated"])(
    "records a conservative ending for native %s and returns original report receipts",
    async (status) => {
      const f = await fixture();
      f.setStatus({ kind: "status", status });
      const receipt = await reconcileCoordinatorExecution(f.effect, f.deps);
      expect(receipt?.reportDelivery).toEqual(f.unit.reportDelivery);
      expect(f.settlements).toHaveLength(1);
      expect(f.settlements[0]).toMatchObject({
        parentInstanceId: f.instance.id,
        unit: "ONE",
        deliveryId: "lifecycle/reconcile",
        ending: { kind: "terminated" },
      });
      expect(f.unit.ending?.outcome).toBeUndefined();
      expect(f.deps.status.mock.calls.every(([id]) => id === f.instance.id)).toBe(true);
    },
  );

  it("does not settle malformed or changed admission identity, unavailable native status, or an unconfirmed absent execution", async () => {
    const f = await fixture();
    for (const effect of [
      { ...f.effect, admissionHash: "a".repeat(64) },
      { ...f.effect, report: "private bytes" },
    ])
      expect(await reconcileCoordinatorExecution(effect, f.deps)).toBeUndefined();
    for (const answer of [
      { kind: "unanswered", reason: "offline" },
      { kind: "absent" },
      { kind: "status", status: "running" },
    ] satisfies InstanceStatusAnswer[]) {
      f.setStatus(answer);
      expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    }
    expect(f.deps.settle).not.toHaveBeenCalled();
    expect(f.deps.finalize).not.toHaveBeenCalled();
  });

  it("retains active effects and original execution attribution instead of clearing an unfinished obligation", async () => {
    const f = await fixture();
    f.setUnit({
      ...f.unit,
      currentEffect: {
        version: 1,
        id: "ONE/branch",
        ordinal: 1,
        execution: { workflowId: f.instance.id },
        target: { repo: f.instance.repo, ref: f.unit.branch, base: "main", headSha: "a".repeat(40) },
        phase: "active",
        calls: [{ operation: "branch_create", state: "uncertain" }],
      },
    });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    f.setStatus({ kind: "absent" });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    expect(f.deps.settle).not.toHaveBeenCalled();
    expect(f.unit.currentEffect?.calls[0].state).toBe("uncertain");
  });

  it("finalizes a recorded report without resettling or regenerating its private rendering", async () => {
    const f = await fixture();
    await f.deps.settle({
      parentInstanceId: f.instance.id,
      unit: "ONE",
      deliveryId: "original/end",
      ending: { kind: "terminated", report: "saved raw detail", threadReport: "saved raw summary" },
    });
    f.deps.settle.mockClear();
    const result = await reconcileCoordinatorExecution(f.effect, f.deps);
    expect(result?.reportDelivery).toEqual(f.unit.reportDelivery);
    expect(f.deps.settle).not.toHaveBeenCalled();
    expect(f.deps.finalize.mock.calls[0]?.[0].proposed).toEqual({
      text: "saved raw detail",
      threadText: "saved raw summary",
    });
  });

  it("finishes a crash before freeze from the retained exact rendering after a process restart", async () => {
    const f = await fixture();
    const owner = {
      instanceId: f.instance.id,
      unit: f.unit.unit,
      attempt: 0,
      requester: f.instance.userId,
      channelId: f.instance.channelId,
      threadKey: f.instance.threadKey,
      deliveryId: "original/end",
    };
    const proposed = { text: "retained detail", threadText: "retained summary" };
    f.setUnit({
      ...f.unit,
      ending: {
        kind: "terminated",
        report: proposed.text,
        threadReport: proposed.threadText,
        deliveryId: owner.deliveryId,
        at: 3,
      },
      reportDelivery: await coordinatorReportAdmission(owner, proposed),
    });
    const result = await reconcileCoordinatorExecution(f.effect, {
      ...f.deps,
      finalize: (input) => finalizeCoordinatorReport({ ledger: f.ledger, instances: f.instances }, input),
    });
    expect(result?.reportDelivery).toEqual(f.unit.reportDelivery);
    expect(await readCoordinatorReport(f.ledger, owner)).toEqual(proposed);
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it("defers legacy missing canonical rendering and mismatched retained bytes", async () => {
    const f = await fixture();
    const owner = {
      instanceId: f.instance.id,
      unit: f.unit.unit,
      attempt: 0,
      requester: f.instance.userId,
      channelId: f.instance.channelId,
      threadKey: f.instance.threadKey,
      deliveryId: "original/end",
    };
    const admission = await coordinatorReportAdmission(owner, {
      text: "retained detail",
      threadText: "original summary",
    });
    f.setUnit({
      ...f.unit,
      ending: { kind: "terminated", report: "retained detail", deliveryId: owner.deliveryId, at: 3 },
      reportDelivery: admission,
    });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    f.setUnit({ ...f.unit, ending: { ...f.unit.ending!, threadReport: "changed summary" } });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it("admits the saved original ending after a crash before its first report admission without changing producer facts", async () => {
    const f = await fixture();
    const ending: NonNullable<CoordinatorUnit["ending"]> = {
      kind: "aborted",
      report: "original full report",
      threadReport: "original summary",
      at: 7,
      deliveryId: "original/end",
      cause: "step_threw",
      step: "ONE/code",
      round: 1,
      outcome: { schemaVersion: 1, kind: "aborted", reviewRounds: 1 },
    };
    f.setUnit({ ...f.unit, ending });
    f.deps.settle.mockImplementationOnce(async (body) => {
      expect(body.deliveryId).toBe(ending.deliveryId);
      expect(body.ending).toEqual({
        kind: ending.kind,
        report: ending.report,
        threadReport: ending.threadReport,
        cause: ending.cause,
        step: ending.step,
        round: ending.round,
        outcome: ending.outcome,
      });
      const owner = {
        instanceId: f.instance.id,
        unit: f.unit.unit,
        attempt: 0,
        requester: f.instance.userId,
        channelId: f.instance.channelId,
        threadKey: f.instance.threadKey,
        deliveryId: body.deliveryId,
      };
      f.setUnit({
        ...f.unit,
        reportDelivery: await coordinatorReportAdmission(owner, {
          text: body.ending.report,
          threadText: body.ending.threadReport,
        }),
      });
      return true;
    });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeDefined();
    expect(f.deps.settle).toHaveBeenCalledTimes(1);
    expect(f.unit.ending).toEqual(ending);
  });

  it("uses original frozen bytes for first admission and defers missing delivery identity or rendering", async () => {
    const f = await fixture();
    const ending = { kind: "aborted", report: "original full report", at: 7, deliveryId: "original/end" };
    const owner = {
      instanceId: f.instance.id,
      unit: f.unit.unit,
      attempt: 0,
      requester: f.instance.userId,
      channelId: f.instance.channelId,
      threadKey: f.instance.threadKey,
      deliveryId: ending.deliveryId,
    };
    f.setUnit({ ...f.unit, ending });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    expect(f.deps.settle).not.toHaveBeenCalled();
    await freezeCoordinatorReport(f.ledger, owner, { text: ending.report, threadText: "original frozen summary" });
    f.deps.settle.mockImplementationOnce(async (body) => {
      expect(body.ending.threadReport).toBe("original frozen summary");
      f.setUnit({
        ...f.unit,
        reportDelivery: await coordinatorReportAdmission(owner, {
          text: body.ending.report,
          threadText: body.ending.threadReport,
        }),
      });
      return true;
    });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeDefined();
    const { deliveryId: _delivery, ...unbound } = ending;
    f.setUnit({
      ...f.unit,
      ending: { ...unbound, threadReport: "original frozen summary" },
      reportDelivery: undefined,
    });
    f.deps.settle.mockClear();
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it("does not admit a report after its original row changes during the canonical report read", async () => {
    const f = await fixture();
    f.setUnit({
      ...f.unit,
      ending: {
        kind: "aborted",
        report: "original detail",
        threadReport: "original summary",
        deliveryId: "original/end",
        at: 7,
      },
    });
    expect(
      await reconcileCoordinatorExecution(f.effect, {
        ...f.deps,
        readReport: async () => {
          f.setUnit({ ...f.unit, title: "concurrent owner update" });
          return undefined;
        },
      }),
    ).toBeUndefined();
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it("settles the journaled recovery under its exact action and finalizes only its receipt", async () => {
    const f = await fixture();
    const prior = { ...f.unit, ending: { kind: "aborted", report: "prior report", at: 3 } };
    f.setUnit(prior);
    const { ending, ...rest } = prior;
    const request = { userId: f.instance.userId, threadKey: f.instance.threadKey, messageId: "original-request" };
    const claimed = await f.instances.transitionRecovery({
      kind: "claim",
      expected: prior,
      replacement: {
        ...rest,
        recovery: {
          kind: "review",
          round: 1,
          expectedHeadSha: "a".repeat(40),
          remainingMs: 1000,
          claimedAt: 4,
          step: "ONE/recovery/review",
          reviewRunId: "original-review",
          reviewKey: "original-review-key",
          previousEnding: ending,
          workflowId: "original-recovery",
          deadlineAt: 1000,
        },
      },
      request,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(claimed.reason);
    f.setUnit(claimed.unit);
    const action = await f.instances.getRecoveryAction({ instanceId: f.instance.id, unit: "ONE" }, request);
    expect(action).not.toBeNull();
    expect(await recoveryActionRenewed(action!)).not.toBeNull();
    f.setUnit({
      ...f.unit,
      currentEffect: {
        version: 1,
        id: "ONE/recovery/branch",
        ordinal: 1,
        execution: { workflowId: action!.workflowId, recoveryActionId: action!.id },
        target: { repo: f.instance.repo, ref: f.unit.branch, base: "main", headSha: "a".repeat(40) },
        phase: "settled",
        calls: [{ operation: "branch_create", state: "accepted", commitSha: "a".repeat(40) }],
      },
    });
    const effect = await coordinatorReconciliationEffect(f.instance, f.unit, action!);
    const settle = vi.fn(async (body: CoordinatorReconcileSettlement) => {
      expect(body.recoveryActionId).toBe(action!.id);
      expect(body.recoveryWorkflowId).toBe(action!.workflowId);
      const row = f.unit;
      const { recovery, ...retained } = row;
      const owner = {
        instanceId: f.instance.id,
        unit: row.unit,
        attempt: 0,
        requester: f.instance.userId,
        channelId: f.instance.channelId,
        threadKey: row.threadKey!,
        deliveryId: `recovery:${action!.workflowId}:${body.deliveryId}`,
      };
      const proposed = { text: body.ending.report, threadText: body.ending.threadReport };
      const result = await f.instances.transitionRecovery({
        kind: "settle",
        expected: row,
        replacement: {
          ...retained,
          ending: { ...body.ending, at: 5, deliveryId: body.deliveryId },
          recoveryReceipt: {
            workflowId: action!.workflowId,
            reviewRunId: recovery!.kind !== "coding" ? recovery!.reviewRunId : undefined,
            at: 5,
          },
          reportDelivery: await coordinatorReportAdmission(owner, proposed),
        },
      });
      if (!result.ok) return false;
      f.setUnit(result.unit);
      await freezeCoordinatorReport(f.ledger, owner, proposed);
      return true;
    });
    const receipt = await reconcileCoordinatorExecution(effect, { ...f.deps, settle });
    expect(receipt).toBeDefined();
    expect(receipt?.reportDelivery).toEqual(f.unit.reportDelivery);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(f.unit.recovery).toBeUndefined();
    expect(f.unit.history?.receiptId).toBe(action!.id);
    expect(f.deps.status.mock.calls.every(([id]) => id === action!.workflowId)).toBe(true);
    expect(await reconcileCoordinatorExecution(effect, { ...f.deps, settle })).toEqual(receipt);
    expect(settle).toHaveBeenCalledTimes(1);
    f.setUnit({ ...f.unit, history: { version: 1, receiptId: "different-history" } });
    expect(await reconcileCoordinatorExecution(effect, { ...f.deps, settle })).toBeUndefined();
  });

  it("does not settle after the row changes while native status is read", async () => {
    const f = await fixture();
    f.deps.status.mockImplementationOnce(async () => {
      f.setUnit({ ...f.unit, rounds: [{ index: 0, agent: "coding", outcome: "started", at: 4 }] });
      return { kind: "status", status: "complete" };
    });
    expect(await reconcileCoordinatorExecution(f.effect, f.deps)).toBeUndefined();
    expect(f.deps.settle).not.toHaveBeenCalled();
  });
});
