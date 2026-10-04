import { sourceHash } from "../references/receipts.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import {
  freezeAdmittedCoordinatorReport,
  readCoordinatorReport,
  sameCoordinatorReportOwner,
  type CoordinatorReportLedger,
  type CoordinatorReportOwner,
} from "./reportContext.js";
import { isCoordinatorReportAdmission } from "./reportAdmission.js";
import { appendCoordinatorStatus, readCoordinatorStatus } from "./unitStatus.js";
import type { CoordinatorReconcileReceipt } from "./workflowReconciliation.js";

export interface CoordinatorReportFinalizationInput {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  owner: CoordinatorReportOwner;
  proposed: { text: string; threadText: string };
}
export interface CoordinatorReportFinalizationDeps {
  ledger: CoordinatorReportLedger;
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "getMainTask">;
  /** The original worker's idempotent log append. Return its actual raw ID,
   * never a report-owner wrapper or a newly generated delivery identity. */
  deliverPrivate?(input: {
    instance: CoordinatorInstance;
    unit: CoordinatorUnit;
    owner: CoordinatorReportOwner;
    deliveryId: string;
    report: { text: string; threadText: string };
  }): Promise<string | undefined>;
}

/** Finish only the committed original report using existing immutable session
 * rows and private delivery. Unknown writes retain the existing offer; the
 * state Worker independently verifies these receipts before its outbox ACK. */
export async function finalizeCoordinatorReport(
  deps: CoordinatorReportFinalizationDeps,
  input: CoordinatorReportFinalizationInput,
): Promise<{ report: { text: string; threadText: string }; receipt: CoordinatorReconcileReceipt } | undefined> {
  const { instance, unit, owner } = input;
  const admission = unit.reportDelivery;
  if (
    !isCoordinatorInstance(instance) ||
    !isCoordinatorUnit(unit) ||
    !isCoordinatorReportAdmission(admission) ||
    !sameCoordinatorReportOwner(admission.owner, owner) ||
    unit.instanceId !== instance.id ||
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
  const deliveryId = unit.ending?.deliveryId;
  if (
    unit.workBrief &&
    (deps.deliverPrivate === undefined || typeof deliveryId !== "string" || !STEP_NAME_PATTERN.test(deliveryId))
  )
    return undefined;
  const committed = async (): Promise<boolean> => {
    const before = await deps.instances.get(instance.id);
    const rows = await deps.instances.listUnits(instance.id);
    const after = await deps.instances.get(instance.id);
    const actual = rows.filter((row) => row.unit === unit.unit);
    return (
      before !== undefined &&
      after !== undefined &&
      actual.length === 1 &&
      (await sourceHash(before)) === (await sourceHash(instance)) &&
      (await sourceHash(after)) === (await sourceHash(instance)) &&
      (await sourceHash(actual[0])) === (await sourceHash(unit))
    );
  };
  try {
    if (!(await committed())) return undefined;
    // Replays use the frozen bytes even if today's renderer proposes different
    // prose. Missing or corrupt saved bytes never authorize replacement text.
    const previous = await readCoordinatorReport(deps.ledger, owner);
    const proposed = previous ?? input.proposed;
    if (unit.ending && unit.ending.report !== proposed.text) return undefined;
    const report = await freezeAdmittedCoordinatorReport(deps.ledger, admission, owner, proposed);
    const status = await appendCoordinatorStatus(deps, { instance, unit, owner });
    if (!status) return undefined;
    let privateReplyId: string | undefined;
    if (unit.workBrief) {
      privateReplyId = await deps.deliverPrivate!({ instance, unit, owner, deliveryId: deliveryId!, report });
      if (privateReplyId !== deliveryId) return undefined;
    }
    if (!(await committed()) || !(await readCoordinatorStatus(deps.ledger, status))) return undefined;
    const confirmed = await readCoordinatorReport(deps.ledger, owner);
    if (!confirmed || (await sourceHash(confirmed)) !== (await sourceHash(report))) return undefined;
    return { report, receipt: { reportDelivery: admission, status, ...(privateReplyId ? { privateReplyId } : {}) } };
  } catch {
    return undefined;
  }
}
