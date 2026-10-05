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
import { coordinatorPublicDeliveryReference, readCoordinatorPublicDelivery } from "./reportPublicDelivery.js";
import { sourceHash } from "../references/receipts.js";
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
    userId: "slack:UALPHA",
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
  return { ledger, instances, instance, unit, owner, proposed, deliverPublic: vi.fn(async () => true) };
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

  it("records positive public delivery and suppresses a restarted finalizer's duplicate reply", async () => {
    const f = await fixture();
    const first = await finalizeCoordinatorReport(f, f);
    expect(first).toBeDefined();
    expect(f.deliverPublic).toHaveBeenCalledTimes(1);
    const restarted = vi.fn(async () => true);
    expect(await finalizeCoordinatorReport({ ...f, deliverPublic: restarted }, f)).toEqual(first);
    expect(restarted).not.toHaveBeenCalled();
  });

  it("retains the delivery ACK identity when decoded JSON properties change order", async () => {
    const f = await fixture();
    const result = await finalizeCoordinatorReport(f, f);
    const original = result!.receipt.publicDelivery!;
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    reordered.owner = Object.fromEntries(Object.entries(original.owner).reverse());
    expect(await readCoordinatorPublicDelivery(f.ledger, reordered as typeof original)).toEqual(original);
  });

  it("does not certify public delivery without a positive channel reply", async () => {
    const f = await fixture();
    expect(await finalizeCoordinatorReport({ ...f, deliverPublic: async () => false }, f)).toBeUndefined();
    expect(await finalizeCoordinatorReport({ ...f, deliverPublic: undefined }, f)).toBeUndefined();
  });

  it("retries only frozen public bytes when a positive reply has no durable ACK", async () => {
    const f = await fixture();
    const append = f.ledger.appendSession.bind(f.ledger);
    vi.spyOn(f.ledger, "appendSession").mockImplementation(async (key, id, rows, context) =>
      id.startsWith("coordinator-public-delivery:") ? { ok: false, appended: false } : append(key, id, rows, context),
    );
    expect(await finalizeCoordinatorReport(f, f)).toBeUndefined();
    expect(f.deliverPublic).toHaveBeenCalledTimes(1);
    vi.mocked(f.ledger.appendSession).mockImplementation(append);
    const retry = vi.fn(async () => true);
    const result = await finalizeCoordinatorReport(
      { ...f, deliverPublic: retry },
      {
        ...f,
        proposed: { text: "new full report", threadText: "new thread report" },
      },
    );
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ report: f.proposed }));
    expect(result?.receipt.publicDelivery).toEqual(
      await coordinatorPublicDeliveryReference(f.unit.reportDelivery!, f.proposed.threadText),
    );
    expect(await readCoordinatorPublicDelivery(f.ledger, result!.receipt.publicDelivery!)).toEqual(
      result?.receipt.publicDelivery,
    );
  });

  it("does not repeat a positive reply when its durable delivery ACK committed but the response was lost", async () => {
    const f = await fixture();
    const append = f.ledger.appendSession.bind(f.ledger);
    let lost = false;
    vi.spyOn(f.ledger, "appendSession").mockImplementation(async (key, id, rows, context) => {
      const result = await append(key, id, rows, context);
      if (id.startsWith("coordinator-public-delivery:") && !lost) {
        lost = true;
        throw new Error("ACK response lost after commit");
      }
      return result;
    });
    expect(await finalizeCoordinatorReport(f, f)).toBeUndefined();
    expect(f.deliverPublic).toHaveBeenCalledTimes(1);
    const result = await finalizeCoordinatorReport({ ...f, deliverPublic: undefined }, f);
    expect(result?.receipt.publicDelivery?.kind).toBe("reply");
    expect(f.deliverPublic).toHaveBeenCalledTimes(1);
  });

  it("recovers a producer crash after ending admission before public delivery", async () => {
    const f = await fixture();
    await freezeCoordinatorReport(f.ledger, f.owner, f.proposed);
    const result = await finalizeCoordinatorReport(f, f);
    expect(result?.report).toEqual(f.proposed);
    expect(f.deliverPublic).toHaveBeenCalledTimes(1);
    expect(await finalizeCoordinatorReport({ ...f, deliverPublic: undefined }, f)).toEqual(result);
  });

  it("records an empty admitted thread copy without requiring a channel", async () => {
    const f = await fixture();
    f.proposed.threadText = "";
    f.unit.reportDelivery = await coordinatorReportAdmission(f.owner, f.proposed);
    seedCoordinatorUnit(f.instances, f.unit);
    const result = await finalizeCoordinatorReport({ ...f, deliverPublic: undefined }, f);
    expect(result?.receipt.publicDelivery?.kind).toBe("empty");
    expect(result?.receipt.publicDelivery?.threadHash).toBe(await sourceHash(""));
    expect(f.deliverPublic).not.toHaveBeenCalled();
  });

  it("retains malformed public ACK bytes without replying or overwriting them", async () => {
    const f = await fixture();
    await f.ledger.appendSession(
      contextThreadSessionKey(f.owner.threadKey),
      `coordinator-public-delivery:${await sourceHash(f.owner)}`,
      [{ part: 0, json: '{"part":{"type":"text","text":""},"coordinatorPublicDelivery":{}}' }],
    );
    const append = vi.spyOn(f.ledger, "appendSession");
    expect(await finalizeCoordinatorReport(f, f)).toBeUndefined();
    expect(f.deliverPublic).not.toHaveBeenCalled();
    expect(append.mock.calls.every(([, id]) => !id.startsWith("coordinator-public-delivery:"))).toBe(true);
  });

  it("refuses uncommitted rows, mismatched owners or proposals before any report bytes are appended", async () => {
    const f = await fixture();
    const append = vi.spyOn(f.ledger, "appendSession");
    for (const input of [
      { ...f, unit: { ...f.unit, ending: { ...f.unit.ending!, at: 3 } } },
      { ...f, instance: { ...f.instance, userId: "slack:UBETA" } },
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
      3,
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
