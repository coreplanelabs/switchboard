import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { coordinatorReportAdmission, freezeCoordinatorReport, type CoordinatorReportOwner } from "./reportContext.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import { sourceHash } from "../references/receipts.js";
import { contextThreadSessionKey, storedTurnRow } from "../runLedger/sessionLog.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { appendCoordinatorPublicDelivery, coordinatorPublicDeliveryReference } from "./reportPublicDelivery.js";
import { coordinatorReportOwnerIdentity } from "./reportContext.js";
import { coordinatorReportCanReconcile } from "./reportReconcileEligibility.js";

// Feature: docs/reference/specs/orchestration-plane.md — report discovery admits only finishable original bytes.
const instance: CoordinatorInstance = {
  id: "report_original",
  kind: "ship",
  userId: "slack:UALPHA",
  channelId: "slack:C1",
  threadKey: "slack:C1:original",
  repo: "acme/api",
  base: "main",
  branch: "fix/original",
  createdAt: 1,
  admission: "created",
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "one",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  ending: {
    kind: "aborted",
    report: "Original detail",
    threadReport: "Original summary",
    deliveryId: "ONE/end",
    at: 2,
  },
};
const owner: CoordinatorReportOwner = {
  instanceId: instance.id,
  unit: unit.unit,
  attempt: 0,
  requester: instance.userId,
  channelId: instance.channelId,
  threadKey: instance.threadKey,
  deliveryId: unit.ending!.deliveryId!,
};
const proposal = { text: unit.ending!.report, threadText: unit.ending!.threadReport! };

describe("original report discovery eligibility", () => {
  it("allows a new conservative ending and retained original rendering without changing either row", async () => {
    const ledger = new InMemoryRunLedger();
    expect(await coordinatorReportCanReconcile(ledger, instance, { ...unit, ending: undefined })).toBe(true);
    const before = structuredClone(unit);
    expect(await coordinatorReportCanReconcile(ledger, instance, unit)).toBe(true);
    expect(unit).toEqual(before);
  });
  it("requires the original raw delivery identity and retained or canonical original bytes", async () => {
    const ledger = new InMemoryRunLedger();
    const { deliveryId: _id, ...unbound } = unit.ending!;
    expect(await coordinatorReportCanReconcile(ledger, instance, { ...unit, ending: unbound })).toBe(false);
    const { threadReport: _summary, ...missing } = unit.ending!;
    const legacy = { ...unit, ending: missing };
    expect(await coordinatorReportCanReconcile(ledger, instance, legacy)).toBe(false);
    await freezeCoordinatorReport(ledger, owner, proposal);
    expect(await coordinatorReportCanReconcile(ledger, instance, legacy)).toBe(true);
    expect(
      await coordinatorReportCanReconcile(ledger, instance, {
        ...legacy,
        ending: { ...missing, report: "Changed original bytes" },
      }),
    ).toBe(false);
  });
  it("rejects foreign admission, hash drift and malformed canonical reads without repairing saved bytes", async () => {
    const ledger = new InMemoryRunLedger();
    const admission = await coordinatorReportAdmission(owner, proposal);
    expect(await coordinatorReportCanReconcile(ledger, instance, { ...unit, reportDelivery: admission })).toBe(true);
    expect(
      await coordinatorReportCanReconcile(ledger, instance, {
        ...unit,
        reportDelivery: { ...admission, proposalHash: "b".repeat(64) },
      }),
    ).toBe(false);
    expect(
      await coordinatorReportCanReconcile(ledger, instance, {
        ...unit,
        reportDelivery: { ...admission, owner: { ...owner, requester: "slack:foreign" } },
      }),
    ).toBe(false);
    expect(
      await coordinatorReportCanReconcile(
        { readSessionEntry: async () => [{ idx: 1, part: 0, json: "invalid canonical bytes" }] },
        instance,
        unit,
      ),
    ).toBe(false);
    expect(
      await coordinatorReportCanReconcile(
        {
          readSessionEntry: async () => {
            throw new Error("read unavailable");
          },
        },
        instance,
        unit,
      ),
    ).toBe(false);
  });
  it("excludes malformed or conflicting original public ACKs without repairing bytes or reserving an offer", async () => {
    for (const mode of ["malformed", "conflicting"] as const) {
      const ledger = new InMemoryRunLedger();
      await freezeCoordinatorReport(ledger, owner, proposal);
      const admission = await coordinatorReportAdmission(owner, proposal);
      const key = contextThreadSessionKey(owner.threadKey);
      const rowId = `coordinator-public-delivery:${await sourceHash(coordinatorReportOwnerIdentity(owner))}`;
      if (mode === "malformed")
        await ledger.appendSession(
          key,
          rowId,
          [
            {
              part: 0,
              json: storedTurnRow({
                role: "assistant",
                text: "",
                silent: true,
                folded: true,
                context: UNKNOWN_CONTEXT_DEPENDENCIES,
              }),
            },
          ],
          UNKNOWN_CONTEXT_DEPENDENCIES,
        );
      else {
        const ref = await coordinatorPublicDeliveryReference(admission, proposal.threadText);
        expect(await appendCoordinatorPublicDelivery(ledger, { ...ref, threadHash: "c".repeat(64) })).toBeDefined();
      }
      const before = await ledger.readSessionEntry(key, rowId);
      expect(before).toBeDefined();
      expect(await coordinatorReportCanReconcile(ledger, instance, { ...unit, reportDelivery: admission })).toBe(false);
      expect(await ledger.readSessionEntry(key, rowId)).toEqual(before);
    }
  });
  it("keeps absent or exact public ACK retryable but refuses an unavailable ACK read", async () => {
    const ledger = new InMemoryRunLedger();
    await freezeCoordinatorReport(ledger, owner, proposal);
    const admission = await coordinatorReportAdmission(owner, proposal);
    const row = { ...unit, reportDelivery: admission };
    expect(await coordinatorReportCanReconcile(ledger, instance, row)).toBe(true);
    await appendCoordinatorPublicDelivery(
      ledger,
      await coordinatorPublicDeliveryReference(admission, proposal.threadText),
    );
    expect(await coordinatorReportCanReconcile(ledger, instance, row)).toBe(true);
    expect(
      await coordinatorReportCanReconcile(
        {
          readSessionEntry: (key, id) => {
            if (id.startsWith("coordinator-public-delivery:")) throw new Error("ACK read unavailable");
            return ledger.readSessionEntry(key, id);
          },
        },
        instance,
        row,
      ),
    ).toBe(false);
  });
  it("uses the private worker owner and raw reply identity rather than a wrapped or public delivery identity", async () => {
    const ledger = new InMemoryRunLedger();
    const privateUnit = {
      ...unit,
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: instance.threadKey,
        actId: "original-act",
        repo: instance.repo,
        base: instance.base!,
        question: "Original private question",
        findings: [],
        requestedChange: "Original private work",
      },
    };
    const privateOwner = { ...owner, threadKey: privateWorkerThreadKey(privateUnit) };
    const admission = await coordinatorReportAdmission(privateOwner, proposal);
    const row = { ...privateUnit, reportDelivery: admission };
    const before = structuredClone(row);
    expect(await coordinatorReportCanReconcile(ledger, instance, row)).toBe(true);
    expect(row).toEqual(before);
    expect(
      await coordinatorReportCanReconcile(ledger, instance, {
        ...row,
        ending: { ...row.ending!, deliveryId: "recovery:original:ONE/end" },
      }),
    ).toBe(false);
    expect(
      await coordinatorReportCanReconcile(ledger, instance, {
        ...row,
        reportDelivery: await coordinatorReportAdmission(owner, proposal),
      }),
    ).toBe(false);
  });
});
