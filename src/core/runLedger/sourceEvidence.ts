import { sourceHash } from "../references/receipts.js";
import { isOrchestratorOwner, type OrchestratorOwner } from "../dispatch/orchestratorDecisions.js";
import { DURABLE_INBOX_MAX_BYTES, inboxCustodyOf, type InboxTarget } from "./inboxMessage.js";
import {
  sourceContentOf,
  sourceEventRecordOf,
  sourceEventReceiptOf,
  sourceSnapshot,
  type SourceEvent,
  type SourceEventContent,
  type SourceEventReceipt,
} from "./sourceEvents.js";

interface SourceEvidenceFields {
  kind: "source-evidence";
  source: Pick<SourceEvent, "sourceId" | "deliveryId" | "objectId" | "changeId" | "occurredAt"> & {
    authorId: string | null;
  };
  receipt: SourceEventReceipt;
}
interface LegacySourceEvidenceMessage extends SourceEvidenceFields {
  version: 1;
  decision: { runId: string; id: string };
  text: string;
}
export type SourceInputRouting =
  | { kind: "notice"; owner: OrchestratorOwner }
  | { kind: "fold"; owner: OrchestratorOwner; decision: { runId: string; id: string } };
export interface CommonSourceEvidenceMessage extends SourceEvidenceFields {
  version: 2;
  source: SourceEvidenceFields["source"] & { kind: "source-evidence" | "source-fact" };
  routing: SourceInputRouting;
  content: SourceEventContent;
}
export type SourceEvidenceMessage = LegacySourceEvidenceMessage | CommonSourceEvidenceMessage;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function decisionReferenceOf(value: unknown): { runId: string; id: string } | undefined {
  if (!object(value) || !closed(value, ["runId", "id"]) || !identity(value.runId) || !identity(value.id)) return;
  const invocation: unknown = JSON.parse(value.id);
  if (Array.isArray(invocation) && invocation.length === 2 && invocation[0] === value.runId && identity(invocation[1]))
    return { runId: value.runId, id: value.id };
}

function sourceRoutingOf(value: unknown): SourceInputRouting | undefined {
  if (!object(value) || !isOrchestratorOwner(value.owner)) return;
  if (value.kind === "notice" && closed(value, ["kind", "owner"])) return { kind: "notice", owner: value.owner };
  if (value.kind === "fold" && closed(value, ["kind", "owner", "decision"])) {
    const decision = decisionReferenceOf(value.decision);
    if (decision?.runId === value.owner.runId) return { kind: "fold", owner: value.owner, decision };
  }
}

/** Decode data, not authority. A consumer must separately verify the canonical
 * source and saved decision. Current runtimes still hold this message kind. */
export async function prepareSourceEvidenceMessage(
  value: unknown,
  target?: InboxTarget & { requester: string },
): Promise<SourceEvidenceMessage | undefined> {
  try {
    const snapshot = sourceSnapshot(value);
    if (
      !object(snapshot) ||
      (snapshot.version !== 1 && snapshot.version !== 2) ||
      !closed(snapshot, [
        "version",
        "kind",
        "source",
        "receipt",
        "target",
        ...(snapshot.version === 1 ? ["decision", "text"] : ["routing", "content"]),
      ]) ||
      snapshot.kind !== "source-evidence" ||
      !object(snapshot.source)
    )
      return;
    const source = snapshot.source;
    if (
      !closed(source, [
        "sourceId",
        "deliveryId",
        "objectId",
        "changeId",
        "authorId",
        "occurredAt",
        ...(snapshot.version === 2 ? ["kind"] : []),
      ]) ||
      !identity(source.sourceId) ||
      !/^[a-z][a-z0-9-]*:/.test(source.sourceId) ||
      !identity(source.deliveryId) ||
      !identity(source.objectId) ||
      !identity(source.changeId) ||
      (source.authorId !== null && !identity(source.authorId)) ||
      (source.occurredAt !== undefined && (!Number.isSafeInteger(source.occurredAt) || Number(source.occurredAt) < 0))
    )
      return;
    const receipt = sourceEventReceiptOf(snapshot.receipt);
    if (!receipt) return;
    if (target) {
      const custody = inboxCustodyOf(snapshot.target);
      if (
        !custody ||
        !object(snapshot.target) ||
        !closed(snapshot.target, ["version", "runId", "channelId", "threadKey", "requester", "producerGen"]) ||
        custody.runId !== target.runId ||
        custody.channelId !== target.channelId ||
        custody.threadKey !== target.threadKey ||
        custody.requester !== target.requester
      )
        return;
    } else if (snapshot.target !== undefined) return;
    const fields: SourceEvidenceFields = {
      kind: "source-evidence",
      source: {
        sourceId: source.sourceId,
        deliveryId: source.deliveryId,
        objectId: source.objectId,
        changeId: source.changeId,
        authorId: source.authorId,
        ...(source.occurredAt !== undefined ? { occurredAt: Number(source.occurredAt) } : {}),
      },
      receipt,
    };
    let message: SourceEvidenceMessage;
    if (snapshot.version === 1) {
      const decision = decisionReferenceOf(snapshot.decision);
      if (!decision || typeof snapshot.text !== "string") return;
      message = { version: 1, ...fields, decision, text: snapshot.text };
    } else {
      if (source.kind !== "source-evidence" && source.kind !== "source-fact") return;
      const routing = sourceRoutingOf(snapshot.routing),
        content = sourceContentOf(snapshot.content, source.kind);
      if (!routing || !content) return;
      if (
        routing.kind === "notice" &&
        target &&
        (routing.owner.runId !== target.runId ||
          routing.owner.requesterId !== target.requester ||
          routing.owner.channelId !== target.channelId ||
          routing.owner.threadKey !== target.threadKey)
      )
        return;
      message = { version: 2, ...fields, source: { ...fields.source, kind: source.kind }, routing, content };
    }
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > DURABLE_INBOX_MAX_BYTES) return;
    if (receipt.key !== `source:${await sourceHash([source.sourceId, source.deliveryId])}`) return;
    return message;
  } catch {
    return;
  }
}

/** Project common content from a receipt-consistent stored record. The caller
 * must load the canonical record and verify routing and current access. */
export async function sourceEvidenceMessageFromRecord(
  value: unknown,
  routing: SourceInputRouting,
): Promise<CommonSourceEvidenceMessage | undefined> {
  try {
    const snapshot = sourceSnapshot({ record: value, routing });
    if (!object(snapshot)) return;
    const record = await sourceEventRecordOf(snapshot.record);
    if (!record || record.event.version !== 2 || record.event.kind === "request") return;
    const { sourceId, deliveryId, objectId, changeId, authorId, occurredAt, kind, content } = record.event;
    const message = await prepareSourceEvidenceMessage({
      version: 2,
      kind: "source-evidence",
      receipt: record.receipt,
      routing: snapshot.routing,
      content,
      source: {
        sourceId,
        deliveryId,
        objectId,
        changeId,
        kind,
        authorId: authorId ?? null,
        ...(occurredAt !== undefined ? { occurredAt } : {}),
      },
    });
    return message?.version === 2 ? message : undefined;
  } catch {
    return;
  }
}
