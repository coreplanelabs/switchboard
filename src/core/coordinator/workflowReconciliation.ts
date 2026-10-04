import { INSTANCE_ID_PATTERN, UNIT_PATTERN, type CoordinatorInstance, type CoordinatorUnit } from "./contract.js";
import { sourceHash } from "../references/receipts.js";
import { isUnitStatusReference, type UnitStatusReference } from "../references/unitStatusReference.js";
import { isCoordinatorReportAdmission, type CoordinatorReportAdmission } from "./reportAdmission.js";
import type { RecoveryAction } from "./recoveryHistory.js";

/** An offer to finish the original execution's report. It carries no private prose
 * and grants no authority to run a child or repeat an external mutation. */
export interface CoordinatorReconcileEffect {
  id: string;
  kind: "coordinator_reconcile";
  instanceId: string;
  unit: string;
  workflowId: string;
  actionId?: string;
  admissionHash: string;
}

/** Existing durable report receipts, verified again before the outbox is closed. */
export interface CoordinatorReconcileReceipt {
  reportDelivery: CoordinatorReportAdmission;
  status: UnitStatusReference;
  privateReplyId?: string;
}
/** Absence can retire only an attributable saved execution, never an
 * unanswered create. Unknown begun calls remain settlement obligations. */
export function coordinatorWorkflowCanReconcile(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  action: RecoveryAction | undefined,
  status: string | undefined,
): boolean {
  const begun = coordinatorExecutionWasStarted(unit, action?.workflowId ?? instance.id, action?.id);
  if (["complete", "errored", "terminated"].includes(status ?? "")) {
    if (action === undefined) return instance.admission === "created" || begun;
    return (
      begun ||
      (action.state === "settled" &&
        action.consumed &&
        action.receiptId === unit.history?.receiptId &&
        action.id === unit.history?.receiptId &&
        unit.recoveryReceipt?.workflowId === action.workflowId &&
        unit.ending !== undefined)
    );
  }
  return status === "absent" && instance.admission === "created" && Number.isFinite(unit.startedAt) && begun;
}
export function coordinatorExecutionWasStarted(unit: CoordinatorUnit, workflowId: string, actionId?: string): boolean {
  const effect = unit.currentEffect;
  return (
    effect !== undefined &&
    effect.execution.workflowId === workflowId &&
    effect.execution.recoveryActionId === actionId &&
    effect.calls.some(
      (call) =>
        call.state === "pending" ||
        call.state === "accepted" ||
        call.state === "uncertain" ||
        (call.state === "refused" && call.cause === "external_refused"),
    )
  );
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function isCoordinatorReconcileEffect(v: unknown): v is CoordinatorReconcileEffect {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      ["id", "kind", "instanceId", "unit", "workflowId", "actionId", "admissionHash"].includes(k),
    ) &&
    typeof v.id === "string" &&
    /^coordinator-reconcile:[a-f0-9]{64}$/.test(v.id) &&
    v.kind === "coordinator_reconcile" &&
    typeof v.instanceId === "string" &&
    INSTANCE_ID_PATTERN.test(v.instanceId) &&
    typeof v.unit === "string" &&
    UNIT_PATTERN.test(v.unit) &&
    typeof v.workflowId === "string" &&
    INSTANCE_ID_PATTERN.test(v.workflowId) &&
    (v.actionId === undefined || (typeof v.actionId === "string" && /^r_[a-f0-9]{64}$/.test(v.actionId))) &&
    digest(v.admissionHash)
  );
}
export function isCoordinatorReconcileReceipt(v: unknown): v is CoordinatorReconcileReceipt {
  return (
    object(v) &&
    Object.keys(v).every((k) => ["reportDelivery", "status", "privateReplyId"].includes(k)) &&
    isCoordinatorReportAdmission(v.reportDelivery) &&
    isUnitStatusReference(v.status) &&
    (v.privateReplyId === undefined ||
      (typeof v.privateReplyId === "string" && v.privateReplyId.length > 0 && v.privateReplyId.length <= 512))
  );
}

/** Hash only immutable admission identity. Mutable progress and report fields
 * must still be checked against the actual owner; this digest is not evidence. */
export async function coordinatorReconciliationEffect(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  action?: RecoveryAction,
): Promise<CoordinatorReconcileEffect> {
  const workflowId = action?.workflowId ?? instance.id;
  const admissionHash = await sourceHash({
    instanceId: instance.id,
    unit: unit.unit,
    createdAt: instance.createdAt,
    requester: instance.userId,
    authenticatedAs: instance.authenticatedAs,
    postedBy: instance.postedBy,
    channelId: instance.channelId,
    threadKey: instance.threadKey,
    repo: instance.repo,
    base: instance.base,
    branch: unit.branch,
    plan: instance.plan,
    merge: instance.merge,
    attempt: instance.attempt,
    grant: instance.grant,
    grantSource: instance.grantSource,
    caps: instance.caps,
    generatedSource: instance.generatedTaskSource,
    generatedTaskHash: unit.generatedTask?.sha256,
    mainTask:
      unit.workBrief === undefined
        ? undefined
        : { actId: unit.workBrief.actId, mainThreadKey: unit.workBrief.mainThreadKey },
    action:
      action === undefined
        ? undefined
        : { id: action.id, workflowId: action.workflowId, payloadDigest: action.payloadDigest },
  });
  const identity = {
    instanceId: instance.id,
    unit: unit.unit,
    workflowId,
    ...(action ? { actionId: action.id } : {}),
    admissionHash,
  };
  return { id: `coordinator-reconcile:${await sourceHash(identity)}`, kind: "coordinator_reconcile", ...identity };
}
