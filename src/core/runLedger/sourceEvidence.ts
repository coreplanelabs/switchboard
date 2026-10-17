import { sourceHash } from "../references/receipts.js";
import { DURABLE_INBOX_MAX_BYTES, inboxCustodyOf, type InboxTarget } from "./inboxMessage.js";
import { sourceEventReceiptOf, sourceSnapshot, type SourceEvent, type SourceEventReceipt } from "./sourceEvents.js";

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

export type SourceEvidenceMessage = LegacySourceEvidenceMessage;

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
      !closed(snapshot, ["version", "kind", "source", "receipt", "decision", "text", "target"]) ||
      snapshot.version !== 1 ||
      snapshot.kind !== "source-evidence" ||
      typeof snapshot.text !== "string" ||
      !object(snapshot.source) ||
      !object(snapshot.decision)
    )
      return;
    const source = snapshot.source,
      decision = snapshot.decision;
    if (
      !closed(source, ["sourceId", "deliveryId", "objectId", "changeId", "authorId", "occurredAt"]) ||
      !identity(source.sourceId) ||
      !/^[a-z][a-z0-9-]*:/.test(source.sourceId) ||
      !identity(source.deliveryId) ||
      !identity(source.objectId) ||
      !identity(source.changeId) ||
      (source.authorId !== null && !identity(source.authorId)) ||
      (source.occurredAt !== undefined &&
        (!Number.isSafeInteger(source.occurredAt) || Number(source.occurredAt) < 0)) ||
      !closed(decision, ["runId", "id"]) ||
      !identity(decision.runId) ||
      !identity(decision.id)
    )
      return;
    const reference = decisionReferenceOf(decision);
    if (!reference) return;
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
    const message: SourceEvidenceMessage = {
      version: 1,
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
      decision: reference,
      text: snapshot.text,
    };
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > DURABLE_INBOX_MAX_BYTES) return;
    if (receipt.key !== `source:${await sourceHash([source.sourceId, source.deliveryId])}`) return;
    return message;
  } catch {
    return;
  }
}
