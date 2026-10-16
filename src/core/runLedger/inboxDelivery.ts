import { sourceHash } from "../references/receipts.js";
import { DURABLE_INBOX_MAX_BYTES, inboxCustodyOf, type InboxTarget } from "./inboxMessage.js";
import { sourceSnapshot } from "./sourceEvents.js";
import type { InboxRowWitness } from "./types.js";

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

/** Correlate a verified ledger delivery response with an observed stored row.
 * This neither authenticates the delivery key nor proves native consumption,
 * first-claim identity or current execution authority. */
export async function inboxDeliveryWitness(
  receipt: unknown,
  item: unknown,
  target: InboxTarget & { requester: string },
): Promise<InboxRowWitness | undefined> {
  try {
    const parsed = inboxDeliveryResultOf({ kind: "duplicate", receipt: sourceSnapshot(receipt) });
    if (!parsed || parsed.kind === "refused" || parsed.receipt.runId !== target.runId) return;
    // Validate before copying; preserve property order because the row witness
    // hashes stored JSON, while the delivery hash uses canonical input JSON.
    sourceSnapshot(item);
    const row: unknown = JSON.parse(JSON.stringify(item));
    if (!object(row) || !closed(row, ["seq", "message", "witness"]) || !object(row.message)) return;
    const witness = row.witness;
    if (
      !object(witness) ||
      !closed(witness, ["version", "runId", "seq", "digest"]) ||
      witness.version !== 1 ||
      witness.runId !== target.runId ||
      row.seq !== parsed.receipt.seq ||
      witness.seq !== row.seq ||
      typeof witness.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(witness.digest)
    )
      return;
    const custody = inboxCustodyOf(row.message.target);
    if (
      !custody ||
      !object(row.message.target) ||
      !closed(row.message.target, ["version", "runId", "channelId", "threadKey", "requester", "producerGen"]) ||
      custody.runId !== target.runId ||
      custody.channelId !== target.channelId ||
      custody.threadKey !== target.threadKey ||
      custody.requester !== target.requester
    )
      return;
    const { target: _custody, ...message } = row.message;
    const [input, digest] = await Promise.all([
      prepareInboxDelivery({ version: 1, key: parsed.receipt.key, message }),
      sourceHash(row.message),
    ]);
    if (input?.bodyHash !== parsed.receipt.bodyHash || digest !== witness.digest) return;
    return { version: 1, runId: parsed.receipt.runId, seq: parsed.receipt.seq, digest };
  } catch {
    return;
  }
}
