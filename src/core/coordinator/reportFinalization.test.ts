import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import { contextThreadSessionKey } from "../runLedger/sessionLog.js";
import { seedCoordinatorUnit } from "../testing/coordinatorInstance.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { coordinatorReportAdmission, freezeCoordinatorReport, readCoordinatorReport } from "./reportContext.js";
import { readCoordinatorStatus } from "./unitStatus.js";
import { isCoordinatorReconcileReceipt } from "./workflowReconciliation.js";
import { finalizeCoordinatorReport } from "./reportFinalization.js";

// Feature: docs/reference/specs/orchestration-plane.md — original report
// finalization uses the existing committed admission, immutable session rows
// and private worker log; no replacement work or generated receipt identity.
async function fixture(privateWorker = false) {
  const ledger = new InMemoryRunLedger();
  const instances = new InMemoryCoordinatorInstanceStore(ledger);
  const instance: CoordinatorInstance = {
    id: "report-original",
    kind: "ship",
    userId: "slack:U1",
    channelId: "slack:C1",
    threadKey: "slack:C1:1.0",
    repo: "acme/api",
    base: "main",
    branch: "plan/report/unit",
    merge: "person",
    plan: { id: "report" },
    createdAt: 1,
  };
  const unit: CoordinatorUnit = {
    instanceId: instance.id,
    unit: "unit",
    slug: "unit",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    threadKey: privateWorker ? privateWorkerThreadKey({ instanceId: instance.id, unit: "unit" }) : instance.threadKey,
    ending: {
      kind: "stopped",
      report: "original detail",
      at: 2,
      deliveryId: "unit/0/end",
      outcome: { schemaVersion: 1, kind: "stopped", reviewRounds: 0 },
    },
  };
  const owner = {
    instanceId: instance.id,
    unit: unit.unit,
    attempt: 0,
    requester: instance.userId,
    channelId: instance.channelId,
    threadKey: unit.threadKey!,
    deliveryId: privateWorker ? "recovery:original:unit/0/end" : "unit/0/end",
  };
  const proposed = { text: "original detail", threadText: "original summary" };
  unit.reportDelivery = await coordinatorReportAdmission(owner, proposed);
  if (privateWorker) {
    unit.workBrief = {
      requesterId: instance.userId,
      mainThreadKey: instance.threadKey,
      actId: "act-1",
      repo: instance.repo,
      base: instance.base!,
      question: "What failed?",
      findings: [],
      requestedChange: "Fix the failure",
    };
    await instances.recordRequesterTurn({
      threadKey: instance.threadKey,
      requesterId: instance.userId,
      messageId: "1",
    });
    expect(
      await instances.claimMainTask(
        unit.workBrief,
        instance,
        { ...unit, ending: undefined, reportDelivery: undefined },
        {
          requesterId: instance.userId,
          sourceMessageId: "1",
          revision: 1,
          repo: instance.repo,
        },
      ),
    ).toMatchObject({ ok: true, created: true });
  } else {
    await instances.put(instance);
  }
  seedCoordinatorUnit(instances, unit);
  return { ledger, instances, instance, unit, owner, proposed };
}

describe("original coordinator report finalization", () => {
  it("freezes the admitted report and returns its independently readable immutable status", async () => {
    const f = await fixture();
    const result = await finalizeCoordinatorReport(f, f);
    expect(result?.report).toEqual(f.proposed);
    expect(result?.receipt.reportDelivery).toEqual(f.unit.reportDelivery);
    expect(isCoordinatorReconcileReceipt(result?.receipt)).toBe(true);
    expect(await readCoordinatorReport(f.ledger, f.owner)).toEqual(f.proposed);
    expect((await readCoordinatorStatus(f.ledger, result!.receipt.status))?.status).toEqual({
      state: "recorded",
      kind: "stopped",
    });
  });

  it("refuses uncommitted rows, mismatched owners or proposals before any report bytes are appended", async () => {
    const f = await fixture();
    const append = vi.spyOn(f.ledger, "appendSession");
    for (const input of [
      { ...f, unit: { ...f.unit, ending: { ...f.unit.ending!, at: 3 } } },
      { ...f, instance: { ...f.instance, userId: "slack:U2" } },
      { ...f, owner: { ...f.owner, deliveryId: "replacement" } },
      { ...f, proposed: { ...f.proposed, text: "regenerated" } },
    ])
      expect(await finalizeCoordinatorReport(f, input)).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
  });

  it("replays admitted frozen bytes instead of accepting freshly rendered replacement prose", async () => {
    const f = await fixture();
    await freezeCoordinatorReport(f.ledger, f.owner, f.proposed);
    const result = await finalizeCoordinatorReport(f, {
      ...f,
      proposed: { text: "new text", threadText: "new summary" },
    });
    expect(result?.report).toEqual(f.proposed);
    expect(result?.receipt.reportDelivery).toEqual(f.unit.reportDelivery);
    expect((await f.ledger.readSessionTail(contextThreadSessionKey(f.owner.threadKey), 100_000)).transcript.turns).toBe(
      2,
    );
  });

  it("requires the private callback to attest the original raw ending ID and canonical bytes", async () => {
    const f = await fixture(true);
    expect(await finalizeCoordinatorReport(f, f)).toBeUndefined();
    const deliveries: unknown[] = [];
    const deps = {
      ...f,
      deliverPrivate: async (input: unknown) => {
        deliveries.push(input);
        return "unit/0/end";
      },
    };
    const result = await finalizeCoordinatorReport(deps, f);
    expect(result?.receipt.privateReplyId).toBe("unit/0/end");
    expect(deliveries).toEqual([
      { instance: f.instance, unit: f.unit, owner: f.owner, deliveryId: "unit/0/end", report: f.proposed },
    ]);
    expect(f.owner.deliveryId).not.toBe(result?.receipt.privateReplyId);
    expect(await finalizeCoordinatorReport({ ...f, deliverPrivate: async () => "synthetic-id" }, f)).toBeUndefined();
  });

  it("does not certify a changed committed row after private delivery completes", async () => {
    const f = await fixture(true);
    const result = await finalizeCoordinatorReport(
      {
        ...f,
        deliverPrivate: async () => {
          seedCoordinatorUnit(f.instances, { ...f.unit, ending: { ...f.unit.ending!, at: 3 } });
          return "unit/0/end";
        },
      },
      f,
    );
    expect(result).toBeUndefined();
    expect(await readCoordinatorReport(f.ledger, f.owner)).toEqual(f.proposed);
  });

  it("does not deliver privately or return an ACK receipt when the immutable status write is unacknowledged", async () => {
    const f = await fixture(true);
    await freezeCoordinatorReport(f.ledger, f.owner, f.proposed);
    vi.spyOn(f.ledger, "appendSession").mockResolvedValue({ ok: false, appended: false });
    const deliverPrivate = vi.fn(async () => "unit/0/end");
    expect(await finalizeCoordinatorReport({ ...f, deliverPrivate }, f)).toBeUndefined();
    expect(deliverPrivate).not.toHaveBeenCalled();
  });

  it("retains invalid or unreadable frozen bytes without regenerating a report or delivering privately", async () => {
    const f = await fixture(true);
    await freezeCoordinatorReport(f.ledger, f.owner, { text: "unadmitted bytes", threadText: "different" });
    const deliverPrivate = vi.fn(async () => "unit/0/end");
    const append = vi.spyOn(f.ledger, "appendSession");
    expect(await finalizeCoordinatorReport({ ...f, deliverPrivate }, f)).toBeUndefined();
    expect(deliverPrivate).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
