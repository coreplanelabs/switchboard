import { sourceHash } from "../references/receipts.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { InstanceStatusAnswer } from "./instancesRoute.js";
import {
  isRecoveryAction,
  recoveryActionRenewed,
  prepareRecoveryTransition,
  type RecoveryAction,
} from "./recoveryHistory.js";
import { isCoordinatorReportAdmission } from "./reportAdmission.js";
import {
  coordinatorReportAdmission,
  sameCoordinatorReportAdmission,
  sameCoordinatorReportOwner,
  type CoordinatorReportOwner,
} from "./reportContext.js";
import type { CoordinatorReportFinalizationInput } from "./reportFinalization.js";
import {
  coordinatorReconciliationEffect,
  coordinatorWorkflowCanReconcile,
  isCoordinatorReconcileEffect,
  isCoordinatorReconcileReceipt,
  type CoordinatorReconcileEffect,
  type CoordinatorReconcileReceipt,
} from "./workflowReconciliation.js";

export interface CoordinatorReconcileSettlement {
  parentInstanceId: string;
  unit: string;
  deliveryId: string;
  recoveryActionId?: string;
  recoveryWorkflowId?: string;
  ending: Omit<NonNullable<CoordinatorUnit["ending"]>, "at" | "deliveryId" | "threadReport"> & {
    threadReport: string;
  };
}
export interface CoordinatorReconcileExecutionDeps {
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "getRecoveryAction">;
  /** The existing exact-ID native status client; an unanswered read defers. */
  status(workflowId: string): Promise<InstanceStatusAnswer>;
  /** The existing unit-end transaction, with follow-up redispatch disabled. */
  settle(body: CoordinatorReconcileSettlement): Promise<boolean>;
  readReport(owner: CoordinatorReportOwner): Promise<{ text: string; threadText: string } | undefined>;
  finalize(
    input: CoordinatorReportFinalizationInput,
  ): Promise<{ report: { text: string; threadText: string }; receipt: CoordinatorReconcileReceipt } | undefined>;
}
interface Snapshot {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  action?: RecoveryAction;
}
const TERMINATED_REPORT = "This work stopped before its result was confirmed. Saved work remains protected.";
const DELIVERY_ID = "lifecycle/reconcile";

async function snapshot(
  effect: CoordinatorReconcileEffect,
  deps: CoordinatorReconcileExecutionDeps,
): Promise<Snapshot | undefined> {
  const instance = await deps.instances.get(effect.instanceId);
  const units = await deps.instances.listUnits(effect.instanceId);
  const matches = units.filter((unit) => unit.unit === effect.unit);
  if (!isCoordinatorInstance(instance) || matches.length !== 1 || !isCoordinatorUnit(matches[0])) return undefined;
  const unit = matches[0];
  if (unit.instanceId !== instance.id) return undefined;
  let action: RecoveryAction | undefined;
  if (effect.actionId) {
    const found = await deps.instances.getRecoveryAction(
      { instanceId: effect.instanceId, unit: effect.unit },
      effect.actionId,
    );
    if (
      !isRecoveryAction(found) ||
      found.id !== effect.actionId ||
      found.instanceId !== instance.id ||
      found.unit !== unit.unit ||
      found.workflowId !== effect.workflowId ||
      found.repo !== instance.repo ||
      found.base !== instance.base ||
      found.branch !== unit.branch ||
      found.mainThreadKey !== instance.threadKey ||
      found.workerThreadKey !== (unit.threadKey ?? instance.threadKey) ||
      (await recoveryActionRenewed(found)) === null
    )
      return undefined;
    action = found;
    if (action.state === "pending") {
      const claim = unit.recovery;
      if (
        !claim ||
        claim.actionId !== action.id ||
        claim.workflowId !== action.workflowId ||
        unit.ending ||
        unit.history?.receiptId !== action.predecessorId
      )
        return undefined;
      const prepared = await prepareRecoveryTransition({
        kind: "claim",
        expected: unit,
        replacement: { ...unit, recovery: { ...claim, actionId: undefined } },
        request: action.request,
      });
      if (
        prepared.actionId !== action.id ||
        prepared.payload !== action.payload ||
        prepared.payloadDigest !== action.payloadDigest
      )
        return undefined;
    } else if (
      action.state !== "settled" ||
      !unit.ending ||
      unit.recovery ||
      unit.history?.receiptId !== action.receiptId ||
      unit.recoveryReceipt?.workflowId !== action.workflowId ||
      (unit.recoveryReceipt.codingRunId ?? unit.recoveryReceipt.reviewRunId) !==
        (action.codingRunId ?? action.reviewRunId)
    )
      return undefined;
  } else if (unit.recovery || unit.recoveryReceipt) return undefined;
  const expected = await coordinatorReconciliationEffect(instance, unit, action);
  if ((await sourceHash(expected)) !== (await sourceHash(effect))) return undefined;
  const after = await deps.instances.get(instance.id);
  if ((await sourceHash(after)) !== (await sourceHash(instance))) return undefined;
  return { instance, unit, ...(action ? { action } : {}) };
}
function nativeStatus(answer: InstanceStatusAnswer): string | undefined {
  return answer.kind === "status" ? answer.status : answer.kind === "absent" ? "absent" : undefined;
}

/** Settle and finish only the offered original execution. Native completion
 * does not certify its work, and active effects retain their exact execution
 * attribution rather than being cleared by report recovery. */
export async function reconcileCoordinatorExecution(
  effect: unknown,
  deps: CoordinatorReconcileExecutionDeps,
): Promise<CoordinatorReconcileReceipt | undefined> {
  if (!isCoordinatorReconcileEffect(effect)) return undefined;
  try {
    const before = await snapshot(effect, deps);
    if (!before) return undefined;
    const status = nativeStatus(await deps.status(effect.workflowId));
    if (!coordinatorWorkflowCanReconcile(before.instance, before.unit, before.action, status)) return undefined;
    const confirmed = await snapshot(effect, deps);
    if (!confirmed || (await sourceHash(confirmed)) !== (await sourceHash(before))) return undefined;
    let current = confirmed;
    if (!current.unit.ending) {
      if (current.unit.currentEffect?.phase === "active") return undefined;
      const body: CoordinatorReconcileSettlement = {
        parentInstanceId: effect.instanceId,
        unit: effect.unit,
        deliveryId: DELIVERY_ID,
        ...(effect.actionId ? { recoveryActionId: effect.actionId, recoveryWorkflowId: effect.workflowId } : {}),
        ending: { kind: "terminated", report: TERMINATED_REPORT, threadReport: TERMINATED_REPORT },
      };
      // A lost response may still have committed. One reread can confirm that
      // exact settlement; it never grants a second write or replacement work.
      await deps.settle(body).catch(() => false);
      const settled = await snapshot(effect, deps);
      const ending = settled?.unit.ending;
      if (
        !settled ||
        ending?.kind !== body.ending.kind ||
        ending.report !== body.ending.report ||
        ending.threadReport !== body.ending.threadReport ||
        ending.deliveryId !== DELIVERY_ID
      )
        return undefined;
      current = settled;
    }
    if (current.unit.reportDelivery === undefined) {
      const ending = current.unit.ending;
      if (!ending?.deliveryId) return undefined;
      const owner: CoordinatorReportOwner = {
        instanceId: current.instance.id,
        unit: current.unit.unit,
        attempt: current.instance.attempt ?? 0,
        requester: current.instance.userId,
        channelId: current.instance.channelId,
        threadKey: current.unit.workBrief
          ? privateWorkerThreadKey({ instanceId: current.instance.id, unit: current.unit.unit })
          : (current.unit.threadKey ?? current.instance.threadKey),
        deliveryId: current.action ? `recovery:${effect.workflowId}:${ending.deliveryId}` : ending.deliveryId,
      };
      const saved = await deps.readReport(owner);
      const original =
        saved ??
        (typeof ending.threadReport === "string"
          ? { text: ending.report, threadText: ending.threadReport }
          : undefined);
      if (!original || original.text !== ending.report) return undefined;
      const observed = await snapshot(effect, deps);
      if (!observed || (await sourceHash(observed)) !== (await sourceHash(current))) return undefined;
      const { at: _at, deliveryId: _delivery, threadReport: _thread, ...producerEnding } = ending;
      await deps
        .settle({
          parentInstanceId: effect.instanceId,
          unit: effect.unit,
          deliveryId: ending.deliveryId,
          ...(current.action ? { recoveryActionId: current.action.id, recoveryWorkflowId: effect.workflowId } : {}),
          ending: { ...producerEnding, threadReport: original.threadText },
        })
        .catch(() => false);
      const admitted = await snapshot(effect, deps);
      if (
        !admitted ||
        (await sourceHash({ ...admitted, unit: { ...admitted.unit, reportDelivery: undefined } })) !==
          (await sourceHash(current)) ||
        !(await sameCoordinatorReportAdmission(
          admitted.unit.reportDelivery,
          await coordinatorReportAdmission(owner, original),
        ))
      )
        return undefined;
      current = admitted;
    }
    const { instance, unit } = current;
    const admission = unit.reportDelivery;
    if (!unit.ending || !isCoordinatorReportAdmission(admission)) return undefined;
    const owner = admission.owner;
    if (
      owner.instanceId !== instance.id ||
      owner.unit !== unit.unit ||
      owner.attempt !== (instance.attempt ?? 0) ||
      owner.requester !== instance.userId ||
      owner.channelId !== instance.channelId ||
      owner.threadKey !==
        (unit.workBrief
          ? privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit })
          : (unit.threadKey ?? instance.threadKey))
    )
      return undefined;
    if (
      unit.ending.deliveryId !== undefined &&
      owner.deliveryId !==
        (current.action ? `recovery:${effect.workflowId}:${unit.ending.deliveryId}` : unit.ending.deliveryId)
    )
      return undefined;
    const saved = await deps.readReport(owner);
    const proposed =
      saved ??
      (typeof unit.ending.threadReport === "string"
        ? { text: unit.ending.report, threadText: unit.ending.threadReport }
        : undefined);
    if (
      !proposed ||
      !(await sameCoordinatorReportAdmission(admission, await coordinatorReportAdmission(owner, proposed)))
    )
      return undefined;
    const finalized = await deps.finalize({ instance, unit, owner, proposed });
    if (
      !finalized ||
      !isCoordinatorReconcileReceipt(finalized.receipt) ||
      !(await sameCoordinatorReportAdmission(finalized.receipt.reportDelivery, admission)) ||
      !sameCoordinatorReportOwner(finalized.receipt.status, owner) ||
      (unit.workBrief && finalized.receipt.privateReplyId !== unit.ending.deliveryId)
    )
      return undefined;
    const after = await snapshot(effect, deps);
    if (
      !after ||
      (await sourceHash(after)) !== (await sourceHash(current)) ||
      !coordinatorWorkflowCanReconcile(
        after.instance,
        after.unit,
        after.action,
        nativeStatus(await deps.status(effect.workflowId)),
      )
    )
      return undefined;
    return finalized.receipt;
  } catch {
    return undefined;
  }
}
