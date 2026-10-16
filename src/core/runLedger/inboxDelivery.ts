import { sourceHash } from "../references/receipts.js";
import { DURABLE_INBOX_MAX_BYTES } from "./inboxMessage.js";
import { sourceSnapshot } from "./sourceEvents.js";

export interface InboxDeliveryReceipt {
  version: 1;
  runId: string;
  key: string;
  seq: number;
  bodyHash: string;
}
export type InboxDeliveryResult =
  | { kind: "delivered" | "duplicate"; receipt: InboxDeliveryReceipt }
  | {
      kind: "refused";
      reason: "invalid-delivery" | "delivery-conflict" | "not-live" | "capacity" | "unsupported-receipt";
    };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/** Capture caller input before hashing. This adds no requester or destination authority. */
export async function prepareInboxDelivery(value: unknown) {
  try {
    const snapshot = sourceSnapshot(value);
    if (
      !object(snapshot) ||
      !closed(snapshot, ["version", "key", "message"]) ||
      snapshot.version !== 1 ||
      !identity(snapshot.key) ||
      !object(snapshot.message) ||
      snapshot.message.target !== undefined
    )
      return;
    if (new TextEncoder().encode(JSON.stringify(snapshot.message)).byteLength > DURABLE_INBOX_MAX_BYTES) return;
    return { key: snapshot.key, message: snapshot.message, bodyHash: await sourceHash(snapshot.message) };
  } catch {
    return;
  }
}

export function inboxDeliveryResultOf(value: unknown): InboxDeliveryResult | undefined {
  if (!object(value)) return;
  if (value.kind === "refused") {
    const reason = (
      ["invalid-delivery", "delivery-conflict", "not-live", "capacity", "unsupported-receipt"] as const
    ).find((reason) => reason === value.reason);
    if (closed(value, ["kind", "reason"]) && reason) return { kind: "refused", reason };
    return;
  }
  if ((value.kind !== "delivered" && value.kind !== "duplicate") || !closed(value, ["kind", "receipt"])) return;
  const receipt = value.receipt;
  if (
    !object(receipt) ||
    !closed(receipt, ["version", "runId", "key", "seq", "bodyHash"]) ||
    receipt.version !== 1 ||
    !identity(receipt.runId) ||
    !identity(receipt.key) ||
    !Number.isSafeInteger(receipt.seq) ||
    Number(receipt.seq) <= 0 ||
    typeof receipt.bodyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.bodyHash)
  )
    return;
  return {
    kind: value.kind,
    receipt: {
      version: 1,
      runId: receipt.runId,
      key: receipt.key,
      seq: Number(receipt.seq),
      bodyHash: receipt.bodyHash,
    },
  };
}

export function replayInboxDelivery(
  value: unknown,
  runId: string,
  input: { key: string; bodyHash: string },
): InboxDeliveryResult {
  const parsed = inboxDeliveryResultOf({ kind: "duplicate", receipt: value });
  if (!parsed || parsed.kind === "refused" || parsed.receipt.runId !== runId || parsed.receipt.key !== input.key)
    return { kind: "refused", reason: "unsupported-receipt" };
  return parsed.receipt.bodyHash === input.bodyHash ? parsed : { kind: "refused", reason: "delivery-conflict" };
}
