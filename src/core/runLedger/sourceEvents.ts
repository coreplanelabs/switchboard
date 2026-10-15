import { sourceHash } from "../references/receipts.js";
import { SOURCE_EVENT_MAX_BYTES } from "../budgets.js";

/** Source data has no worker destination or requester authority. */
export interface SourceEvent {
  version: 1;
  sourceId: string;
  deliveryId: string;
  objectId: string;
  changeId: string;
  kind: "request" | "source-evidence" | "source-fact";
  authorId?: string;
  occurredAt?: number;
  /** Opaque JSON data, validated and bounded before storage. */
  payload: unknown;
}
export interface SourceEventReceipt {
  version: 1;
  key: string;
  sequence: number;
  receivedAt: number;
  bodyHash: string;
}
export interface SourceEventJob {
  version: 1;
  eventKey: string;
  stage: "received";
  attempts: 0;
  nextAttemptAt: number;
}
export interface SourceEventRecord {
  event: SourceEvent;
  receipt: SourceEventReceipt;
  job: SourceEventJob;
}
export type SourceEventReceiveResult =
  | { kind: "received" | "duplicate"; receipt: SourceEventReceipt }
  | { kind: "refused"; reason: "invalid-event" | "delivery-conflict" | "capacity" };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const isSourceEventKey = (value: unknown): value is string =>
  typeof value === "string" && /^source:[a-f0-9]{64}$/.test(value);

/** Canonical JSON preserves arrays and rejects values that JSON would silently drop. */
function sourceJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new Error("Source data is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Invalid source data");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("Invalid source data");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Invalid source data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1) throw new Error("Invalid source array");
      const items = Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid source array");
        return sourceJson(descriptor.value, ancestors, depth + 1);
      });
      return `[${items.join(",")}]`;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return `{${Object.keys(descriptors)
      .sort()
      .map((key) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Invalid source data");
        return `${JSON.stringify(key)}:${sourceJson(descriptor.value, ancestors, depth + 1)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function prepareSourceEvent(value: unknown): Promise<
  | {
      event: SourceEvent;
      json: string;
      bytes: number;
      key: string;
      bodyHash: string;
    }
  | undefined
> {
  if (!object(value)) return;
  let json: string;
  let parsed: unknown;
  try {
    json = sourceJson(value);
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  if (
    bytes > SOURCE_EVENT_MAX_BYTES ||
    !object(parsed) ||
    parsed.version !== 1 ||
    !closed(parsed, [
      "version",
      "sourceId",
      "deliveryId",
      "objectId",
      "changeId",
      "kind",
      "authorId",
      "occurredAt",
      "payload",
    ])
  )
    return;
  const { sourceId, deliveryId, objectId, changeId, kind, authorId, occurredAt, payload } = parsed;
  if (
    !identity(sourceId) ||
    !/^[a-z][a-z0-9-]*:/.test(sourceId) ||
    !identity(deliveryId) ||
    !identity(objectId) ||
    !identity(changeId) ||
    (kind !== "request" && kind !== "source-evidence" && kind !== "source-fact") ||
    (authorId !== undefined && !identity(authorId)) ||
    (occurredAt !== undefined && !time(occurredAt)) ||
    !Object.hasOwn(parsed, "payload")
  )
    return;
  const event: SourceEvent = {
    version: 1,
    sourceId,
    deliveryId,
    objectId,
    changeId,
    kind,
    payload,
    ...(authorId !== undefined ? { authorId } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
  const [keyHash, bodyHash] = await Promise.all([sourceHash([sourceId, deliveryId]), sourceHash(parsed)]);
  return { event, json, bytes, key: `source:${keyHash}`, bodyHash };
}

export function sourceEventReceiptOf(value: unknown): SourceEventReceipt | undefined {
  if (
    !object(value) ||
    !closed(value, ["version", "key", "sequence", "receivedAt", "bodyHash"]) ||
    value.version !== 1 ||
    !isSourceEventKey(value.key) ||
    !time(value.sequence) ||
    value.sequence === 0 ||
    !time(value.receivedAt) ||
    typeof value.bodyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.bodyHash)
  )
    return;
  return {
    version: 1,
    key: value.key,
    sequence: value.sequence,
    receivedAt: value.receivedAt,
    bodyHash: value.bodyHash,
  };
}

export function receivedSourceEventJob(receipt: Pick<SourceEventReceipt, "key" | "receivedAt">): SourceEventJob {
  return { version: 1, eventKey: receipt.key, stage: "received", attempts: 0, nextAttemptAt: receipt.receivedAt };
}

export async function sourceEventRecordOf(value: unknown): Promise<SourceEventRecord | undefined> {
  if (!object(value) || !closed(value, ["event", "receipt", "job"])) return;
  const receipt = sourceEventReceiptOf(value.receipt);
  const prepared = await prepareSourceEvent(value.event);
  const job = value.job;
  if (
    !receipt ||
    !prepared ||
    prepared.key !== receipt.key ||
    prepared.bodyHash !== receipt.bodyHash ||
    !object(job) ||
    !closed(job, ["version", "eventKey", "stage", "attempts", "nextAttemptAt"]) ||
    job.version !== 1 ||
    job.eventKey !== receipt.key ||
    job.stage !== "received" ||
    job.attempts !== 0 ||
    !time(job.nextAttemptAt)
  )
    return;
  return {
    event: prepared.event,
    receipt,
    job: { version: 1, eventKey: receipt.key, stage: "received", attempts: 0, nextAttemptAt: job.nextAttemptAt },
  };
}

export function sourceEventReceiveResultOf(value: unknown): SourceEventReceiveResult | undefined {
  if (!object(value)) return;
  const reason = value.reason;
  if (
    value.kind === "refused" &&
    closed(value, ["kind", "reason"]) &&
    (reason === "invalid-event" || reason === "delivery-conflict" || reason === "capacity")
  )
    return { kind: "refused", reason };
  const receipt = sourceEventReceiptOf(value.receipt);
  if (receipt && closed(value, ["kind", "receipt"]) && (value.kind === "received" || value.kind === "duplicate"))
    return { kind: value.kind, receipt };
  return;
}
