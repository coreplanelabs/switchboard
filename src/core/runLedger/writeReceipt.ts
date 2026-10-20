import { z } from "zod";
import { originalMetaSchema } from "./originalEvidence.js";
import { RUN_ID_PATTERN } from "../runIdentity.js";
import { GEN_PATTERN } from "./types.js";

export const WRITE_RECEIPT_LIMIT = 256;
export const WRITE_RECEIPT_BYTES = 4096;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const writeReceiptSelectorSchema = z
  .object({
    runId: z.string().regex(RUN_ID_PATTERN),
    gen: z.string().regex(GEN_PATTERN),
    operation: z.enum(["/runs/live-state", "/runs/session/write"]),
    requestId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    digest: hash,
  })
  .strict();
export type WriteReceiptSelector = z.infer<typeof writeReceiptSelectorSchema>;
const resultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      liveStateSeq: count.optional(),
      bytes: count.optional(),
      sourcesSaved: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum([
        "fenced",
        "unknown-run",
        "unavailable",
        "stale-sequence",
        "terminal",
        "invalid-transition",
        "bound-required",
        "invalid-bound",
        "cause-required",
      ]),
    })
    .strict(),
]);
export const writeComponentsSchema = z
  .object({
    stateWritten: z.boolean(),
    eventsWritten: count,
    contextPinningApplied: z.boolean(),
    rowsWritten: count,
    attachmentsWritten: count,
    sourcesWritten: z.boolean(),
    sourceOwnerWritten: z.boolean(),
    sourceTainted: z.boolean(),
    bytePolicyApplied: z.boolean(),
  })
  .strict();
export type WriteComponents = z.infer<typeof writeComponentsSchema>;
export function emptyWriteComponents(): WriteComponents {
  return {
    stateWritten: false,
    eventsWritten: 0,
    contextPinningApplied: false,
    rowsWritten: 0,
    attachmentsWritten: 0,
    sourcesWritten: false,
    sourceOwnerWritten: false,
    sourceTainted: false,
    bytePolicyApplied: false,
  };
}
export const writeReceiptRecordSchema = writeReceiptSelectorSchema
  .extend({
    version: z.literal(1),
    effectDigest: hash,
    result: resultSchema,
    components: writeComponentsSchema,
  })
  .strict();
export type WriteReceiptRecord = z.infer<typeof writeReceiptRecordSchema>;
// The reader binding remains private to the owning store and its authorized adapter.
export const storedWriteReceiptSchema = writeReceiptRecordSchema.extend({ reader: originalMetaSchema }).strict();
export type StoredWriteReceipt = z.infer<typeof storedWriteReceiptSchema>;
export type TrustedWriteRequest = Pick<WriteReceiptSelector, "requestId" | "digest"> & {
  reader?: z.infer<typeof originalMetaSchema>;
};
export const writeReceiptObservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("recorded"), record: writeReceiptRecordSchema }).strict(),
  z
    .object({ state: z.literal("unknown"), reason: z.enum(["missing", "unsupported", "fenced", "changed", "corrupt"]) })
    .strict(),
]);
export type WriteReceiptObservation = z.infer<typeof writeReceiptObservationSchema>;
const resource = originalMetaSchema
  .omit({ threadKey: true })
  .extend({ type: z.literal("run"), id: z.string().regex(RUN_ID_PATTERN) })
  .strict();
const readSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable") }).strict(),
  z
    .object({
      kind: z.literal("source"),
      resource,
      threadKey: originalMetaSchema.shape.threadKey,
      receipt: writeReceiptObservationSchema,
    })
    .strict(),
]);
export type WriteReceiptRead = z.infer<typeof readSchema>;
export function sameWriteReceipt(a: WriteReceiptSelector, b: WriteReceiptSelector): boolean {
  return (
    a.runId === b.runId &&
    a.gen === b.gen &&
    a.operation === b.operation &&
    a.requestId === b.requestId &&
    a.digest === b.digest
  );
}
export function writeReceiptReadOf(value: unknown, selector: WriteReceiptSelector): WriteReceiptRead | undefined {
  const parsed = readSchema.safeParse(value);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > WRITE_RECEIPT_BYTES) return;
  const v = parsed.data;
  if (
    v.kind === "source" &&
    (v.resource.id !== selector.runId ||
      (v.receipt.state === "recorded" && !sameWriteReceipt(v.receipt.record, selector)))
  )
    return;
  return v;
}
