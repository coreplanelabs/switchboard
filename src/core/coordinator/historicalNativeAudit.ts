import { branchPublicationOf } from "../branchPublication.js";
import { isPublicationSettlement, publicationSettlementForRun } from "../publicationSettlement.js";
import {
  branchPushReceiptsOf,
  MAX_RECORD_BYTES,
  RUN_EVENTS_MAX_PAGE,
  isRunWorkOwner,
  type RunRecord,
} from "../runRecord.js";
import type { RunEvent } from "../runEvents.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { isUnitCurrentEffect, type UnitCurrentEffect } from "./unitEffect.js";

const SHA = /^[a-f0-9]{40}$/;
const MAX_PROJECTION_BYTES = 64 * 1024;

/** A new original-owner audit, never a replacement for its producer settlement. */
export interface HistoricalNativeAudit {
  version: 1;
  firstHead: string;
  head: string;
  eventCount: number;
  eventDigest: string;
  spawn: UnitCurrentEffect;
  projection: string;
}

export function isHistoricalNativeAudit(value: unknown): value is HistoricalNativeAudit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 7 &&
    v.version === 1 &&
    typeof v.firstHead === "string" &&
    SHA.test(v.firstHead) &&
    typeof v.head === "string" &&
    SHA.test(v.head) &&
    v.head !== v.firstHead &&
    Number.isSafeInteger(v.eventCount) &&
    (v.eventCount as number) > 0 &&
    (v.eventCount as number) <= RUN_EVENTS_MAX_PAGE &&
    typeof v.eventDigest === "string" &&
    /^[a-f0-9]{64}$/.test(v.eventDigest) &&
    isUnitCurrentEffect(v.spawn) &&
    typeof v.projection === "string" &&
    v.projection.length > 0 &&
    new TextEncoder().encode(v.projection).byteLength <= MAX_PROJECTION_BYTES
  );
}

export interface HistoricalAuditInput {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  record: HistoricalOwnerRecord;
  events: readonly HistoricalOwnerEvent[];
}

export type HistoricalOwnerRecord = Omit<
  Pick<
    RunRecord,
    | "id"
    | "parentInstanceId"
    | "coordinatorUnit"
    | "coordinatorAttempt"
    | "idempotencyKey"
    | "agent"
    | "status"
    | "userId"
    | "channelId"
    | "threadKey"
    | "repo"
    | "startedAt"
    | "finishedAt"
    | "headSha"
    | "pushed"
    | "publicationSettlement"
    | "branchPublication"
    | "branchPushReceipts"
    | "doorPublicationPending"
    | "pr"
    | "provisional"
    | "restarting"
    | "eventCount"
    | "storedEventCount"
    | "truncated"
    | "session"
  >,
  "branchPublication" | "branchPushReceipts" | "doorPublicationPending"
> & { branchPublication?: unknown; branchPushReceipts?: unknown; doorPublicationPending?: unknown };
export const HISTORICAL_AUTHORITY_EVENT_TYPES = [
  "coordinator_tag",
  "run_meta",
  "publication_push_authorized",
  "pushed_head",
  "publication_settlement",
  "tool_call",
  "tool_result",
] as const;
export const HISTORICAL_AUTHORITY_EVENT_FIELDS = [
  "type",
  "parentInstanceId",
  "unit",
  "base",
  "agent",
  "repo",
  "ref",
  "headSha",
  "callId",
  "expectedHeadSha",
  "sha",
  "by",
  "receipt",
  "tool",
  "ok",
  "cut",
  "exitCode",
  "settlement",
] as const;
export type HistoricalOwnerEvent =
  | RunEvent
  | Extract<
      RunEvent,
      {
        type: "coordinator_tag" | "run_meta" | "publication_push_authorized" | "pushed_head" | "publication_settlement";
      }
    >
  | Omit<Extract<RunEvent, { type: "tool_call" }>, "summary">
  | Omit<Extract<RunEvent, { type: "tool_result" }>, "summary" | "output">
  | { type: "ignored"; seq?: number };

/** One ephemeral view of canonical typed facts, not another persisted truth. */
export function historicalOwnerRecord(record: HistoricalOwnerRecord): HistoricalOwnerRecord {
  return {
    id: record.id,
    parentInstanceId: record.parentInstanceId,
    coordinatorUnit: record.coordinatorUnit,
    coordinatorAttempt: record.coordinatorAttempt,
    idempotencyKey: record.idempotencyKey,
    agent: record.agent,
    status: record.status,
    userId: record.userId,
    channelId: record.channelId,
    threadKey: record.threadKey,
    repo: record.repo,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    headSha: record.headSha,
    pushed: record.pushed,
    publicationSettlement: record.publicationSettlement,
    branchPublication: record.branchPublication,
    branchPushReceipts: record.branchPushReceipts,
    doorPublicationPending: record.doorPublicationPending,
    pr: record.pr,
    provisional: record.provisional,
    restarting: record.restarting,
    eventCount: record.eventCount,
    session: record.session,
    storedEventCount: record.storedEventCount,
    truncated: record.truncated,
  };
}
/** Decode the compact SQLite view before any typed fact can grant authority. */
export function isHistoricalOwnerEvent(value: unknown): value is HistoricalOwnerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const text = (field: string) => typeof v[field] === "string";
  const optionalText = (field: string) => v[field] === undefined || text(field);
  if (v.seq !== undefined && (!Number.isSafeInteger(v.seq) || Number(v.seq) < 1)) return false;
  switch (v.type) {
    case "ignored":
      return true;
    case "coordinator_tag":
      return text("parentInstanceId") && text("unit") && optionalText("base");
    case "run_meta":
      return ["agent", "repo", "ref", "headSha"].every(optionalText);
    case "publication_push_authorized":
      return ["callId", "ref", "expectedHeadSha"].every(text);
    case "pushed_head":
      return text("ref") && text("sha") && (v.by === "push" || v.by === "salvage") && v.receipt === undefined;
    case "publication_settlement":
      return isPublicationSettlement(v.settlement);
    case "tool_call":
      return text("tool") && optionalText("callId");
    case "tool_result":
      return (
        text("tool") &&
        optionalText("callId") &&
        typeof v.ok === "boolean" &&
        (v.cut === undefined || v.cut === true) &&
        (v.exitCode === undefined || Number.isSafeInteger(v.exitCode))
      );
    default:
      return false;
  }
}
export function historicalOwnerEvent(event: HistoricalOwnerEvent): HistoricalOwnerEvent {
  switch (event.type) {
    case "coordinator_tag":
      return {
        type: event.type,
        seq: event.seq,
        parentInstanceId: event.parentInstanceId,
        unit: event.unit,
        base: event.base,
      };
    case "run_meta":
      return {
        type: event.type,
        seq: event.seq,
        agent: event.agent,
        repo: event.repo,
        ref: event.ref,
        headSha: event.headSha,
      };
    case "publication_push_authorized":
      return {
        type: event.type,
        seq: event.seq,
        callId: event.callId,
        ref: event.ref,
        expectedHeadSha: event.expectedHeadSha,
      };
    case "pushed_head":
      return { type: event.type, seq: event.seq, ref: event.ref, sha: event.sha, by: event.by, receipt: event.receipt };
    case "publication_settlement":
      return { type: event.type, seq: event.seq, settlement: event.settlement };
    case "tool_call":
      return { type: event.type, seq: event.seq, tool: event.tool, callId: event.callId };
    case "tool_result":
      return {
        type: event.type,
        seq: event.seq,
        tool: event.tool,
        callId: event.callId,
        ok: event.ok,
        cut: event.cut,
        exitCode: event.exitCode,
      };
    default:
      return { type: "ignored", seq: event.seq };
  }
}
export function isHistoricalOwnerRecord(value: unknown): value is HistoricalOwnerRecord {
  if (!isRunWorkOwner(value)) return false;
  const v = value as HistoricalOwnerRecord;
  return (
    typeof v.agent === "string" &&
    typeof v.status === "string" &&
    Number.isFinite(v.startedAt) &&
    Number.isFinite(v.finishedAt) &&
    Number.isSafeInteger(v.eventCount) &&
    Number.isSafeInteger(v.storedEventCount) &&
    typeof v.truncated === "boolean"
  );
}

/** Exact typed publication evidence for synchronous standing-owner checks.
 * Model prose, tool stdout and unrelated traces are not publication authority. */
function authorityProjection({ record, events }: HistoricalAuditInput): string {
  const evidence = events.flatMap<unknown>((e) => {
    switch (e.type) {
      case "coordinator_tag":
        return [{ seq: e.seq, type: e.type, parentInstanceId: e.parentInstanceId, unit: e.unit, base: e.base }];
      case "run_meta":
        return [{ seq: e.seq, type: e.type, agent: e.agent, repo: e.repo, ref: e.ref, headSha: e.headSha }];
      case "publication_push_authorized":
        return [{ seq: e.seq, type: e.type, callId: e.callId, ref: e.ref, expectedHeadSha: e.expectedHeadSha }];
      case "pushed_head":
        return [{ seq: e.seq, type: e.type, ref: e.ref, sha: e.sha, by: e.by, receipt: e.receipt }];
      case "tool_call":
        return [{ seq: e.seq, type: e.type, tool: e.tool, callId: e.callId }];
      case "tool_result":
        return [
          { seq: e.seq, type: e.type, tool: e.tool, callId: e.callId, ok: e.ok, cut: e.cut, exitCode: e.exitCode },
        ];
      case "publication_settlement":
        return [{ seq: e.seq, type: e.type, settlement: e.settlement }];
      default:
        return [];
    }
  });
  return JSON.stringify({
    record: {
      id: record.id,
      parentInstanceId: record.parentInstanceId,
      coordinatorUnit: record.coordinatorUnit,
      coordinatorAttempt: record.coordinatorAttempt,
      idempotencyKey: record.idempotencyKey,
      agent: record.agent,
      status: record.status,
      userId: record.userId,
      channelId: record.channelId,
      threadKey: record.threadKey,
      repo: record.repo,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      headSha: record.headSha,
      pushed: record.pushed,
      publicationSettlement: record.publicationSettlement,
      branchPublication: record.branchPublication,
      branchPushReceipts: record.branchPushReceipts,
    },
    events: evidence,
  });
}

/** Evaluate private canonical rows inside their owner transaction. No prose,
 * remote equality or claimed audit supplies evidence for a native transition. */
export function historicalNativeChain(
  input: HistoricalAuditInput,
  admitted = false,
): { firstHead: string; head: string } | undefined {
  const { instance, unit, record, events } = input;
  const thread = unit.threadKey ?? instance.threadKey;
  const step = `${instance.id}:${unit.unit}/0/coding`;
  const standing =
    admitted &&
    unit.adoption?.audit !== undefined &&
    isHistoricalNativeAudit(unit.adoption.audit) &&
    unit.adoption.runId === record.id &&
    unit.adoption.requester === instance.userId &&
    unit.adoption.threadKey === thread;
  if (
    instance.kind !== "ship" ||
    unit.instanceId !== instance.id ||
    (!standing && unit.ending === undefined) ||
    unit.startedAt === undefined ||
    (!standing &&
      (unit.idle !== undefined ||
        unit.recovery !== undefined ||
        unit.resume !== undefined ||
        unit.rounds.length === 0 ||
        unit.rounds.some((r) => r.agent !== "coding" || r.index !== 0))) ||
    (unit.pr !== undefined && unit.adoption?.state !== "bound") ||
    (unit.publication !== undefined && unit.adoption?.state !== "bound") ||
    record.agent !== "coding" ||
    record.provisional ||
    record.restarting ||
    !["completed", "failed", "interrupted", "stopped_soft", "stopped_hard"].includes(record.status) ||
    record.startedAt < unit.startedAt ||
    record.finishedAt > (standing ? unit.adoption!.claimedAt : unit.ending!.at) ||
    record.parentInstanceId !== instance.id ||
    record.coordinatorUnit !== unit.unit ||
    record.coordinatorAttempt !== (instance.attempt ?? 0) ||
    record.idempotencyKey !== step ||
    record.repo !== instance.repo ||
    record.userId !== instance.userId ||
    record.channelId !== instance.channelId ||
    record.threadKey !== thread ||
    record.pr !== undefined ||
    record.doorPublicationPending != null ||
    record.truncated !== false ||
    record.eventCount !== events.length ||
    record.storedEventCount !== events.length ||
    !events.length ||
    events.length > RUN_EVENTS_MAX_PAGE ||
    events.some((e, i) => e.seq !== i + 1) ||
    events.some(
      (e) => HISTORICAL_AUTHORITY_EVENT_TYPES.some((type) => type === e.type) && !isHistoricalOwnerEvent(e),
    ) ||
    new TextEncoder().encode(JSON.stringify(events)).byteLength > MAX_RECORD_BYTES
  )
    return;
  const effect = standing ? unit.adoption!.audit!.spawn : unit.currentEffect;
  if (
    effect?.id !== `${unit.unit}/0/coding` ||
    effect.phase !== "settled" ||
    effect.execution.workflowId !== instance.id ||
    effect.execution.recoveryActionId !== undefined ||
    effect.execution.maintenance !== undefined ||
    effect.target.repo !== instance.repo ||
    effect.target.ref !== unit.branch ||
    effect.target.base !== instance.base ||
    !SHA.test(effect.target.headSha ?? "") ||
    effect.calls.length !== 1 ||
    effect.calls[0]?.operation !== "spawn" ||
    effect.calls[0].state !== "accepted" ||
    effect.calls[0].runId !== record.id
  )
    return;
  const firstHead = effect.target.headSha!;
  const proof = publicationSettlementForRun(record.publicationSettlement, record);
  if (
    !proof ||
    proof.binding.instanceId !== instance.id ||
    proof.binding.step !== step ||
    proof.binding.branch !== unit.branch ||
    proof.binding.baseHeadSha !== firstHead ||
    proof.checkpoint.kind !== "clean" ||
    proof.publication.kind !== "not_attempted" ||
    proof.preservation.kind !== "pending" ||
    proof.release.kind !== "pending"
  )
    return;
  const publication = branchPublicationOf(record.branchPublication, instance.repo);
  if (
    !publication ||
    publication.complete ||
    publication.pending ||
    publication.branches.length ||
    publication.targets?.length
  )
    return;
  const receipts = branchPushReceiptsOf(record.branchPushReceipts);
  if (
    receipts?.length !== 1 ||
    receipts[0]?.ref !== unit.branch ||
    receipts[0].by !== "push" ||
    receipts[0].sha !== proof.checkpoint.head
  )
    return;
  const tags = events.filter((e) => e.type === "coordinator_tag");
  if (
    tags.length !== 1 ||
    tags[0]?.parentInstanceId !== instance.id ||
    tags[0].unit !== unit.unit ||
    tags[0].base !== instance.base
  )
    return;
  const settlements = events.filter((e) => e.type === "publication_settlement");
  const final = settlements.at(-1);
  if (
    !final ||
    JSON.stringify(final.settlement) !== JSON.stringify(proof) ||
    settlements.some(
      (e) =>
        JSON.stringify(e.settlement.binding) !== JSON.stringify(proof.binding) ||
        e.settlement.publication.kind !== "not_attempted" ||
        (e.settlement.checkpoint.kind !== "pending" && e.settlement.checkpoint.kind !== "clean") ||
        e.settlement.preservation.kind !== "pending" ||
        e.settlement.release.kind !== "pending",
    )
  )
    return;
  let head = firstHead;
  let attached = false;
  let active: { callId: string; authorized: boolean; next?: string } | undefined;
  const seen = new Set<string>();
  const heads = new Set([firstHead]);
  let transitions = 0;
  for (const event of events) {
    if (event.type === "run_meta") {
      if (
        active ||
        event.agent !== "coding" ||
        event.repo !== instance.repo ||
        event.ref !== unit.branch ||
        (event.headSha !== undefined && event.headSha !== head) ||
        (attached && event.headSha === undefined)
      )
        return;
      attached ||= event.headSha !== undefined;
    } else if (event.type === "tool_call" && event.tool === "publish_branch") {
      if (!attached || active || !event.callId || seen.has(event.callId)) return;
      seen.add(event.callId);
      active = { callId: event.callId, authorized: false };
    } else if (event.type === "publication_push_authorized") {
      if (
        !active ||
        active.authorized ||
        active.next ||
        event.callId !== active.callId ||
        event.ref !== unit.branch ||
        event.expectedHeadSha !== head
      )
        return;
      active.authorized = true;
    } else if (event.type === "pushed_head") {
      if (
        !active?.authorized ||
        active.next ||
        event.ref !== unit.branch ||
        event.by !== "push" ||
        event.receipt !== undefined ||
        !SHA.test(event.sha) ||
        heads.has(event.sha)
      )
        return;
      heads.add(event.sha);
      active.next = event.sha;
    } else if (
      event.type === "tool_result" &&
      (event.tool === "publish_branch" || (active !== undefined && event.callId === active.callId))
    ) {
      if (
        !active?.next ||
        event.tool !== "publish_branch" ||
        event.callId !== active.callId ||
        !event.ok ||
        event.cut ||
        (event.exitCode !== undefined && event.exitCode !== 0)
      )
        return;
      head = active.next;
      active = undefined;
      if (++transitions > 300) return;
    } else if (event.type === "tool_call" && (active || seen.has(event.callId ?? ""))) return;
  }
  if (
    !attached ||
    active ||
    !transitions ||
    head !== proof.checkpoint.head ||
    record.pushed?.length !== 1 ||
    record.pushed[0]?.ref !== unit.branch ||
    record.pushed[0].sha !== head ||
    record.pushed[0].by !== "push" ||
    (record.headSha !== undefined && record.headSha !== head) ||
    (!standing && unit.lastPush !== undefined && unit.lastPush !== head)
  )
    return;
  if (
    standing &&
    (unit.adoption!.audit!.firstHead !== firstHead ||
      unit.adoption!.audit!.head !== head ||
      unit.adoption!.headSha !== head ||
      unit.adoption!.audit!.eventCount !== events.length ||
      unit.adoption!.audit!.projection !== authorityProjection(input))
  )
    return;
  return { firstHead, head };
}

/** Hash before a synchronous transaction; its caller rechecks the identical
 * canonical rows inside the transaction before using the prepared result. */
export async function prepareHistoricalNativeAudit(
  input: HistoricalAuditInput,
  admitted = false,
): Promise<{ audit: HistoricalNativeAudit; snapshot: string } | undefined> {
  const chain = historicalNativeChain(input, admitted);
  if (!chain) return;
  const eventJson = JSON.stringify(input.events);
  const eventCount = input.events.length;
  const snapshot = JSON.stringify(input);
  const spawn = structuredClone(admitted ? input.unit.adoption!.audit!.spawn : input.unit.currentEffect!);
  const projection = authorityProjection(input);
  if (new TextEncoder().encode(projection).byteLength > MAX_PROJECTION_BYTES) return;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(eventJson)));
  const eventDigest = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { audit: { version: 1, ...chain, eventCount, eventDigest, spawn, projection }, snapshot };
}
