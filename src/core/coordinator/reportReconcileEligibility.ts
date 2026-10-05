import { coordinatorPublicDeliveryReference, readCoordinatorPublicDelivery } from "./reportPublicDelivery.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import type { RecoveryAction } from "./recoveryHistory.js";
import {
  coordinatorReportAdmission,
  isCoordinatorReportAdmission,
  readCoordinatorReport,
  sameCoordinatorReportAdmission,
  sameCoordinatorReportOwner,
  type CoordinatorReportLedger,
  type CoordinatorReportOwner,
} from "./reportContext.js";

/** Discovery must not reserve an outbox obligation that cannot finish from the
 * original identity and bytes. Ineligible historical rows remain untouched. */
export async function coordinatorReportCanReconcile(
  ledger: Pick<CoordinatorReportLedger, "readSessionEntry">,
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  action?: RecoveryAction,
): Promise<boolean> {
  if (!isCoordinatorInstance(instance) || !isCoordinatorUnit(unit) || unit.instanceId !== instance.id) return false;
  if (!unit.ending) return true;
  const rawId = unit.ending.deliveryId;
  if (typeof rawId !== "string" || !STEP_NAME_PATTERN.test(rawId)) return false;
  const owner: CoordinatorReportOwner = {
    instanceId: instance.id,
    unit: unit.unit,
    attempt: instance.attempt ?? 0,
    requester: instance.userId,
    channelId: instance.channelId,
    threadKey: unit.workBrief ? privateWorkerThreadKey(unit) : (unit.threadKey ?? instance.threadKey),
    deliveryId: action ? `recovery:${action.workflowId}:${rawId}` : rawId,
  };
  const admission = unit.reportDelivery;
  if (
    admission !== undefined &&
    (!isCoordinatorReportAdmission(admission) || !sameCoordinatorReportOwner(admission.owner, owner))
  )
    return false;
  try {
    const frozen = await readCoordinatorReport(ledger, owner);
    const report =
      frozen ??
      (typeof unit.ending.threadReport === "string"
        ? { text: unit.ending.report, threadText: unit.ending.threadReport }
        : undefined);
    if (!report || report.text !== unit.ending.report) return false;
    if (admission === undefined) return true;
    if (!(await sameCoordinatorReportAdmission(admission, await coordinatorReportAdmission(owner, report))))
      return false;
    if (!unit.workBrief)
      await readCoordinatorPublicDelivery(
        ledger,
        await coordinatorPublicDeliveryReference(admission, report.threadText),
      );
    return true;
  } catch {
    return false;
  }
}
