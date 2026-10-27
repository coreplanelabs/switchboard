import { RUN_ID_PATTERN } from "./runIdentity.js";

export type StorageScope =
  | "store"
  | "session"
  | "coordinator"
  | "private-worker"
  | "source-event"
  | "intake"
  | "ingress"
  | "decision-record"
  | "plane"
  | "config";
export type StorageRequestContext =
  | { readonly scope: "runs"; readonly runIds: readonly string[]; readonly ownerGen?: string }
  | { readonly scope: StorageScope }
  | { readonly scope: "unresolved"; readonly reason: "unknown-operation" | "malformed-target" | "legacy-identity" };

type Body = Record<string, unknown>;
type Run = { runId: string; gen?: string; ownerGen?: string };
type Codec<T> = {
  scope: StorageScope | "runs";
  targets(body: T): readonly unknown[];
  owner?(body: T): unknown;
  empty?: StorageScope | "runs";
  legacy?: boolean;
};
const object = (v: unknown): Body => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : {});
const nested = (v: unknown): Run => object(v) as Run;
const codec = <T>(targets: Codec<T>["targets"], owner?: Codec<T>["owner"], empty?: Codec<T>["empty"]): Codec<T> => ({
  scope: "runs",
  targets,
  owner,
  empty,
});
const nonRun = (scope: StorageScope): Codec<Body> => ({ scope, targets: () => [] });
const runId = codec<Run>(
  (b) => [b.runId],
  (b) => b.gen ?? b.ownerGen,
);
const id = codec<{ id: string } & Body>((b) => [b.id]);
const record = codec<{ record: { id: string } } & Body>((b) => [object(b.record).id]);
const ids = codec<{ ids: readonly string[]; force?: boolean } & Body>(
  (b) => (Array.isArray(b.ids) ? b.ids : [undefined]),
  undefined,
  "runs",
);
const runIds = codec<{ runIds: readonly string[] } & Body>(
  (b) => (Array.isArray(b.runIds) ? b.runIds : [undefined]),
  (b) => b.gen,
  "runs",
);
const outcomes = codec<{ outcomes: readonly Run[] } & Body>(
  (b) => (Array.isArray(b.outcomes) ? b.outcomes.map((v) => nested(v).runId) : [undefined]),
  undefined,
  "runs",
);
const claimRun = codec<{ run: Run } & Body>(
  (b) => [nested(b.run).runId],
  (b) => nested(b.run).gen,
);
const claim = codec<({ run: Run; confirm?: never } | { confirm: Run; run?: never }) & Body>(
  (b) => (b.run !== undefined && b.confirm !== undefined ? [undefined] : [nested(b.run ?? b.confirm).runId]),
  (b) => nested(b.run ?? b.confirm).gen,
);
const seedRead = codec<{ reference: Run } & Body>(
  (b) => [nested(b.reference).runId],
  (b) => nested(b.reference).gen,
);
const seedReference = codec<({ reference: Run; release?: never } | { release: Run; reference?: never }) & Body>(
  (b) =>
    b.reference !== undefined && b.release !== undefined ? [undefined] : [nested(b.reference ?? b.release).runId],
  (b) => nested(b.reference ?? b.release).gen,
);
const allocation = codec<{ allocation: Run } & Body>((b) => [nested(b.allocation).runId]);
allocation.legacy = true;
const selector = codec<{ selector: { runId: string } } & Body>((b) => [object(b.selector).runId]);
selector.legacy = true;
const observation = codec<{ observation: Run } & Body>(
  (b) => [nested(b.observation).runId],
  (b) => nested(b.observation).gen,
);
const cancellation = codec<{ cancellation: Run } & Body>(
  (b) => [nested(b.cancellation).runId],
  (b) => nested(b.cancellation).ownerGen,
);
const cancellationFinish = codec<{ cancellation: Run; record: { id: string } } & Body>(
  (b) => (nested(b.cancellation).runId === object(b.record).id ? [nested(b.cancellation).runId] : [undefined]),
  (b) => nested(b.cancellation).ownerGen,
);
const retirement = codec<{ target: { scope: { owner: Run } } } & Body>((b) => [
  nested(object(object(b.target).scope).owner).runId,
]);
retirement.legacy = true;
const requestRun = { ...codec<{ request: { runId: string } } & Body>((b) => [object(b.request).runId]), legacy: true };
const unread = codec<{ proof: { ingressRunId: string; receiverRunId: string; receiverGen: string } } & Body>(
  (b) => [object(b.proof).ingressRunId, object(b.proof).receiverRunId],
  (b) => object(b.proof).receiverGen,
);
unread.legacy = true;
const relevance = codec<{ request: { result: { context: { runId: string } } } } & Body>((b) => [
  object(object(object(b.request).result).context).runId,
]);
relevance.legacy = true;
const unreadClaim = { ...runId, legacy: true };
const sessionWrite = codec<
  (
    | { runId: string; sourceRunId?: unknown; sources?: undefined }
    | { sourceRunId: string; runId?: unknown; sources: unknown }
  ) &
    Body
>(
  (b) => (b.sources !== undefined ? [b.sourceRunId] : b.runId === undefined ? [] : [b.runId]),
  (b) => b.gen,
  "session",
);
sessionWrite.legacy = true;
const optionalRun = codec<{ runId?: string } & Body>(
  (b) => (b.runId === undefined ? [] : [b.runId]),
  (b) => b.gen,
  "session",
);
const optionalPlaneRun = { ...optionalRun, empty: "plane" as const };
const optionalNotepadRun = { ...optionalRun, legacy: true };
const optionalOwner = codec<{ owner?: Run } & Body>(
  (b) => (b.reconciliation !== undefined || b.owner === undefined ? [] : [nested(b.owner).runId]),
  (b) => nested(b.owner).gen,
  "plane",
);
const privateEvent = codec<{ event: Body } & Body>(
  (b) => (object(b.event).kind === "reply" && object(b.event).runId !== undefined ? [object(b.event).runId] : []),
  undefined,
  "private-worker",
);
privateEvent.legacy = true;
const finish = codec<Run & { record: { id: string } }>(
  (b) => (object(b.record).id !== b.runId ? [undefined] : [b.runId]),
  (b) => b.gen,
);

/** Existing owning validators remain authoritative for legacy identifier syntax.
 * Noncanonical strings are unresolved metadata, never new permission.
 * Each operation selects its own identity contract. Arbitrary payload fields never supply targets. */
export const STORAGE_OPERATIONS = {
  "/plane/ack": optionalOwner,
  "/plane/admit": nonRun("plane"),
  "/plane/deploy": nonRun("plane"),
  "/plane/level": nonRun("plane"),
  "/plane/observe": runId,
  "/plane/outcome": optionalPlaneRun,
  "/plane/park": runId,
  "/plane/queued": runId,
  "/plane/reclaimed": outcomes,
  "/plane/steer/fence": runId,
  "/plane/withdraw": runId,
  "/runs/abandon": runId,
  "/runs/append": runId,
  "/runs/cancellation/finish": cancellationFinish,
  "/runs/cancellation/prepare": runId,
  "/runs/cancellation/read": cancellation,
  "/runs/check-source": selector,
  "/runs/original": runId,
  "/runs/write-receipt": codec<{ selector: Run } & Body>(
    (b) => [nested(b.selector).runId],
    (b) => nested(b.selector).gen,
  ),
  "/runs/claim": claim,
  "/runs/claim-observations/list": nonRun("store"),
  "/runs/claim-observations/record": observation,
  "/runs/context-checkpoint": runId,
  "/runs/coordinator/admission/confirm": nonRun("coordinator"),
  "/runs/coordinator/events/append": nonRun("coordinator"),
  "/runs/coordinator/events/list": nonRun("coordinator"),
  "/runs/coordinator/events/mark-consumed": nonRun("coordinator"),
  "/runs/coordinator/get": nonRun("coordinator"),
  "/runs/coordinator/list": nonRun("coordinator"),
  "/runs/coordinator/main-task/claim": nonRun("coordinator"),
  "/runs/coordinator/main-task/get": nonRun("coordinator"),
  "/runs/coordinator/maintenance/admit": nonRun("coordinator"),
  "/runs/coordinator/pull-owners": nonRun("coordinator"),
  "/runs/coordinator/put": nonRun("coordinator"),
  "/runs/coordinator/reconcile/offer": nonRun("coordinator"),
  "/runs/coordinator/recovery/action": nonRun("coordinator"),
  "/runs/coordinator/recovery/history": nonRun("coordinator"),
  "/runs/coordinator/recovery/transition": nonRun("coordinator"),
  "/runs/coordinator/replace": nonRun("coordinator"),
  "/runs/coordinator/requester-turn/latest": nonRun("coordinator"),
  "/runs/coordinator/requester-turn/record": nonRun("coordinator"),
  "/runs/coordinator/stop": nonRun("coordinator"),
  "/runs/coordinator/units/adoption-audit": runId,
  "/runs/coordinator/units/claim-legacy-continuation": nonRun("coordinator"),
  "/runs/coordinator/units/effect-transition": nonRun("coordinator"),
  "/runs/coordinator/units/list": nonRun("coordinator"),
  "/runs/coordinator/units/list-many": nonRun("coordinator"),
  "/runs/coordinator/units/list-active-recoveries": nonRun("coordinator"),
  "/runs/coordinator/units/put": nonRun("coordinator"),
  "/runs/coordinator/wake": nonRun("coordinator"),
  "/runs/decision-record/reserve": nonRun("decision-record"),
  "/runs/delete": id,
  "/runs/deletion-identity": id,
  "/runs/deleted": ids,
  "/runs/events": id,
  "/runs/finish": finish,
  "/runs/finishing": runId,
  "/runs/get": id,
  "/runs/handoff": runIds,
  "/runs/heartbeat": runId,
  "/runs/inbox": runId,
  "/runs/inbox/deliver": runId,
  "/runs/inbox/read": runId,
  "/runs/ingress/by-run": runId,
  "/runs/ingress/clear": nonRun("ingress"),
  "/runs/ingress/consume": nonRun("ingress"),
  "/runs/ingress/launch": nonRun("ingress"),
  "/runs/ingress/finish": requestRun,
  "/runs/ingress/read": nonRun("ingress"),
  "/runs/ingress/refusal-ack": requestRun,
  "/runs/ingress/refusals": nonRun("ingress"),
  "/runs/ingress/unread": nonRun("ingress"),
  "/runs/ingress/unread-claim": unreadClaim,
  "/runs/ingress/unread-hold": unread,
  "/runs/intake": nonRun("intake"),
  "/runs/intake/delivery/claim": nonRun("intake"),
  "/runs/intake/delivery/finish": nonRun("intake"),
  "/runs/intake/list": nonRun("intake"),
  "/runs/intake/read": nonRun("intake"),
  "/runs/list": nonRun("store"),
  "/runs/live": nonRun("store"),
  "/runs/live-events": runId,
  "/runs/live-state": runId,
  "/runs/metrics-health": nonRun("store"),
  "/runs/native-retirement/prepare": retirement,
  "/runs/preservation-owner": runId,
  "/runs/private-worker/append": privateEvent,
  "/runs/private-worker/list": nonRun("private-worker"),
  "/runs/private-worker/list-after": nonRun("private-worker"),
  "/runs/promotion/prepare": claimRun,
  "/runs/promotion/read": runId,
  "/runs/put": record,
  "/runs/reclaim": nonRun("store"),
  "/runs/resident-claim": runId,
  "/runs/review-feedback/claim": nonRun("store"),
  "/runs/review-feedback/complete": runId,
  "/runs/review-feedback/cooldown": nonRun("store"),
  "/runs/review-feedback/list": nonRun("store"),
  "/runs/session/append": nonRun("session"),
  "/runs/session/checkpoint": runId,
  "/runs/session/clear-owner": runId,
  "/runs/session/entry": nonRun("session"),
  "/runs/session/expected-seed/read": seedRead,
  "/runs/session/expected-seed/verify": seedReference,
  "/runs/session/notepad": nonRun("session"),
  "/runs/session/notepad/write": optionalNotepadRun,
  "/runs/session/owner": runId,
  "/runs/session/read": nonRun("session"),
  "/runs/session/read-tail": nonRun("session"),
  "/runs/session/requester-target": nonRun("session"),
  "/runs/session/requester-target/write": nonRun("session"),
  "/runs/session/search": nonRun("session"),
  "/runs/session/tail": nonRun("session"),
  "/runs/session/write": sessionWrite,
  "/runs/shutdown": record,
  "/runs/source-events/claim": nonRun("source-event"),
  "/runs/source-events/read": nonRun("source-event"),
  "/runs/source-events/receive": nonRun("source-event"),
  "/runs/source-events/release": nonRun("source-event"),
  "/runs/source-events/relevance": relevance,
  "/runs/state": runId,
  "/runs/source-input/checkpoint": runId,
  "/runs/step": runId,
  "/runs/stop": runId,
  "/runs/summary": id,
  "/runs/transcript/clear": runId,
  "/runs/transcript/owner": runId,
  "/runs/transcript/read": runId,
  "/runs/transcript/write": runId,
  "/runs/usage": nonRun("store"),
  "/runs/workspace-ack": runId,
  "/runs/workspace-disposition": allocation,
} as const;
export type StorageOperation = keyof typeof STORAGE_OPERATIONS;
export type StorageOperationBody<O extends StorageOperation> = Parameters<
  (typeof STORAGE_OPERATIONS)[O]["targets"]
>[0] &
  Body;

/** Capture only identity primitives before dispatch; never retain the request object. */
export function storageRequestContext(operation: string, body: unknown): StorageRequestContext {
  if (operation === "/config/get" || operation === "/config/put") return Object.freeze({ scope: "config" });
  if (!Object.hasOwn(STORAGE_OPERATIONS, operation))
    return Object.freeze({ scope: "unresolved", reason: "unknown-operation" });
  const contract = STORAGE_OPERATIONS[operation as StorageOperation] as Codec<Body>;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Object.freeze({ scope: "unresolved", reason: "malformed-target" });
  if (contract.scope !== "runs") return Object.freeze({ scope: contract.scope });
  const values = contract.targets(body as Body);
  if (values.some((v) => typeof v !== "string" || !RUN_ID_PATTERN.test(v))) {
    if (contract.legacy && values.every((value) => typeof value === "string"))
      return Object.freeze({ scope: "unresolved", reason: "legacy-identity" });
    return Object.freeze({ scope: "unresolved", reason: "malformed-target" });
  }
  if (!values.length && !contract.empty) return Object.freeze({ scope: "unresolved", reason: "malformed-target" });
  if (!values.length && contract.empty !== "runs") return Object.freeze({ scope: contract.empty! });
  const owner = contract.owner?.(body as Body);
  return Object.freeze({
    scope: "runs",
    runIds: Object.freeze([...new Set(values as string[])]),
    ...(typeof owner === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(owner) ? { ownerGen: owner } : {}),
  });
}
