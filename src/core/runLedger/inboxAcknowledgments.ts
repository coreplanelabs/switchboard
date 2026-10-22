import { sourceHash } from "../references/receipts.js";
import { DURABLE_INBOX_MAX_BYTES } from "./inboxMessage.js";
import { sourceSnapshot } from "./sourceEvents.js";
import type { InboxItem, InboxRowWitness, StepRecord } from "./types.js";

export interface PreparedInboxAcknowledgments {
  witnesses: InboxRowWitness[];
  rows: { seq: number; json: string }[];
}

/** Positive normal-input confirmation, never a cursor or source admission.
 * Capture witnesses before native delivery; a later row cannot replace them. */
export function inboxAcknowledgedRowsOf(value: unknown): InboxRowWitness[] | undefined {
  try {
    const raw = sourceSnapshot(value);
    if (!Array.isArray(raw) || new TextEncoder().encode(JSON.stringify(raw)).byteLength > DURABLE_INBOX_MAX_BYTES)
      return;
    const rows: InboxRowWitness[] = [];
    const seen = new Set<number>();
    for (const item of raw) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).length !== 4 ||
        !["version", "runId", "seq", "digest"].every((key) => Object.hasOwn(item, key)) ||
        item.version !== 1 ||
        typeof item.runId !== "string" ||
        item.runId.length < 1 ||
        item.runId.length > 512 ||
        /[\r\n\0]/.test(item.runId) ||
        !Number.isSafeInteger(item.seq) ||
        Number(item.seq) <= 0 ||
        seen.has(Number(item.seq)) ||
        typeof item.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.digest)
      )
        return;
      seen.add(Number(item.seq));
      rows.push({ version: 1, runId: item.runId, seq: Number(item.seq), digest: item.digest });
    }
    return rows.sort((a, b) => a.seq - b.seq);
  } catch {
    return;
  }
}

/** Verify original row bytes before a step clears a normal deferral. The owning
 * store compares these bytes and its prior boundary again at the final commit. */
export async function prepareInboxAcknowledgments(
  runId: string,
  record: Pick<StepRecord, "inboxAcknowledgedRows">,
  inbox: readonly InboxItem[],
): Promise<PreparedInboxAcknowledgments | undefined> {
  if (record.inboxAcknowledgedRows === undefined) return { witnesses: [], rows: [] };
  const witnesses = inboxAcknowledgedRowsOf(record.inboxAcknowledgedRows);
  if (!witnesses) return;
  const rows: PreparedInboxAcknowledgments["rows"] = [];
  for (const witness of witnesses) {
    const raw = inbox.find((item) => item.seq === witness.seq);
    if (witness.runId !== runId || !raw) return;
    sourceSnapshot(raw.message);
    const item: InboxItem = JSON.parse(JSON.stringify({ seq: raw.seq, message: raw.message }));
    // Every source version uses its own native receipt contract. Even a legacy
    // or unsupported source cannot become an ordinary-input acknowledgment.
    if (item.message.kind === "source-evidence" || (await sourceHash(item.message)) !== witness.digest) return;
    rows.push({ seq: item.seq, json: JSON.stringify(item) });
  }
  return { witnesses, rows };
}

export function inboxAcknowledgmentRowsUnchanged(
  rows: PreparedInboxAcknowledgments["rows"],
  read: (seq: number) => InboxItem | undefined,
): boolean {
  return rows.every(({ seq, json }) => {
    const item = read(seq);
    return !!item && JSON.stringify({ seq: item.seq, message: item.message }) === json;
  });
}
