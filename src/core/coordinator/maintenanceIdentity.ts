/** Trusted entry points retain source facts after authorizing the resolved actor. */
export type MaintenanceIntent =
  | {
      kind: "command";
      requestId: string;
      actorId: string;
      userId: string;
      channelId: string;
      threadKey: string;
      authenticatedAs?: string;
      postedBy?: string;
    }
  | { kind: "watch"; eventId: string; instanceId: string; unit: string; requester: string };
export interface MaintenanceAdmissionInput {
  version: 1;
  intent: MaintenanceIntent;
  target: { repo: string; pr: number; ref: string; base: string; headSha: string };
  owner?: { instanceId: string; unit: string };
  createdAt: number;
  bounds: { leaseMinutes: number; spendCapUsd?: number };
}
export interface MaintenanceExecution {
  id: string;
  intent: MaintenanceIntent;
  admittedAt: number;
  bounds: MaintenanceAdmissionInput["bounds"];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const identity = (v: unknown): v is string => text(v) && /^[^:]+:.+/.test(v);
export const isMaintenanceActionId = (v: unknown): v is string => typeof v === "string" && /^m_[a-f0-9]{64}$/.test(v);
/** A logical maintenance parent has no native Workflow transport. */
export function validMaintenanceTransport(v: unknown): boolean {
  if (!object(v)) return false;
  return (
    v.maintenanceActionId === undefined ||
    (isMaintenanceActionId(v.maintenanceActionId) &&
      text(v.parentInstanceId) &&
      text(v.idempotencyKey) &&
      text(v.coordinatorUnit ?? v.unit) &&
      v.transportWorkflowId === undefined &&
      v.recovery === undefined)
  );
}
export function sameMaintenanceTransport(before: unknown, after: unknown): boolean {
  return (
    object(before) &&
    object(after) &&
    validMaintenanceTransport(before) &&
    validMaintenanceTransport(after) &&
    before.maintenanceActionId === after.maintenanceActionId &&
    (before.maintenanceActionId === undefined ||
      ["parentInstanceId", "idempotencyKey", "coordinatorUnit"].every((key) => before[key] === after[key]))
  );
}
export function maintenanceEventsMatch(meta: unknown, events: readonly unknown[]): boolean {
  if (!object(meta) || !validMaintenanceTransport(meta)) return false;
  return events.every(
    (event) =>
      !object(event) ||
      !["coordinator_tag", "run_meta"].includes(event.type as string) ||
      (event.maintenanceActionId === meta.maintenanceActionId &&
        (meta.maintenanceActionId === undefined ||
          event.type !== "coordinator_tag" ||
          (event.parentInstanceId === meta.parentInstanceId &&
            event.unit === meta.coordinatorUnit &&
            event.transportWorkflowId === undefined &&
            event.recovery === undefined))),
  );
}
/** Identity-bearing event slots cannot be overwritten with an event that erases the original transport. */
export function preserveMaintenanceEvent(meta: unknown, previous: unknown, next: unknown): boolean {
  return (
    !object(meta) ||
    meta.maintenanceActionId === undefined ||
    !object(previous) ||
    !["coordinator_tag", "run_meta"].includes(previous.type as string) ||
    (object(next) && next.type === previous.type && maintenanceEventsMatch(meta, [previous, next]))
  );
}
export function isMaintenanceIntent(v: unknown): v is MaintenanceIntent {
  if (!object(v)) return false;
  return v.kind === "command"
    ? keys(v, ["kind", "requestId", "actorId", "userId", "channelId", "threadKey", "authenticatedAs", "postedBy"]) &&
        identity(v.requestId) &&
        identity(v.actorId) &&
        identity(v.userId) &&
        identity(v.channelId) &&
        identity(v.threadKey) &&
        (v.authenticatedAs === undefined || identity(v.authenticatedAs)) &&
        (v.postedBy === undefined || identity(v.postedBy))
    : v.kind === "watch" &&
        keys(v, ["kind", "eventId", "instanceId", "unit", "requester"]) &&
        identity(v.eventId) &&
        text(v.instanceId) &&
        text(v.unit) &&
        identity(v.requester);
}
function bounds(v: unknown): v is MaintenanceAdmissionInput["bounds"] {
  return (
    object(v) &&
    keys(v, ["leaseMinutes", "spendCapUsd"]) &&
    typeof v.leaseMinutes === "number" &&
    Number.isFinite(v.leaseMinutes) &&
    v.leaseMinutes > 0 &&
    (v.spendCapUsd === undefined ||
      (typeof v.spendCapUsd === "number" && Number.isFinite(v.spendCapUsd) && v.spendCapUsd > 0))
  );
}
export function isMaintenanceExecution(v: unknown): v is MaintenanceExecution {
  return (
    object(v) &&
    keys(v, ["id", "intent", "admittedAt", "bounds"]) &&
    typeof v.id === "string" &&
    /^m_[a-f0-9]{64}$/.test(v.id) &&
    isMaintenanceIntent(v.intent) &&
    typeof v.admittedAt === "number" &&
    Number.isFinite(v.admittedAt) &&
    bounds(v.bounds)
  );
}
