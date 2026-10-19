import { z } from "zod";
import { CHANNEL_VISIBILITIES } from "../runRecord.js";
import { RUN_ID_PATTERN } from "../runIdentity.js";
import { GEN_PATTERN } from "./types.js";

// Edge Workers use this codec without the storage reader's bot harness dependencies.
/** These limits apply before a storage value crosses into the diagnostic reader. */
export const ORIGINAL_CELL_BYTES = 1024 * 1024;
export const ORIGINAL_RECEIPT_BYTES = 64 * 1024;
export const ORIGINAL_REPLY_BYTES = 8 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const originalSelectorSchema = z
  .object({ runId: z.string().regex(RUN_ID_PATTERN), gen: z.string().regex(GEN_PATTERN) })
  .strict();
export type OriginalSelector = z.infer<typeof originalSelectorSchema>;
export const originalUnavailableSchema = z
  .object({
    state: z.literal("unavailable"),
    reason: z.enum(["missing", "legacy", "fenced", "mismatch", "corrupt", "oversize", "unknown"]),
  })
  .strict();
export type OriginalUnavailable = z.infer<typeof originalUnavailableSchema>;
const digestSchema = z.union([
  originalUnavailableSchema,
  z.object({ state: z.literal("recorded"), digest: hash }).strict(),
]);
const evidenceSchema = z.discriminatedUnion("availability", [
  z
    .object({
      version: z.literal(1),
      runId: z.string().regex(RUN_ID_PATTERN),
      gen: z.string().regex(GEN_PATTERN),
      availability: z.literal("unavailable"),
      reason: z.enum(["fenced", "changed"]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      runId: z.string().regex(RUN_ID_PATTERN),
      gen: z.string().regex(GEN_PATTERN),
      availability: z.literal("observed"),
      selection: z.literal("current-original"),
      consistency: z.literal("per-boundary"),
      state: digestSchema,
      step: z.union([
        originalUnavailableSchema,
        z
          .object({
            state: z.literal("recorded"),
            digest: hash,
            step: count,
            seq: count,
            turnIndex: count,
            inFlight: count,
          })
          .strict(),
      ]),
      contextCheckpoint: digestSchema,
      promotion: z.union([
        originalUnavailableSchema,
        z
          .object({
            state: z.enum(["prepared-recorded", "commit-recorded", "confirmation-recorded"]),
            bodySha256: hash,
            expectedSeedSha256: hash.optional(),
          })
          .strict(),
      ]),
      source: z.union([
        originalUnavailableSchema,
        z.object({ state: z.enum(["verification-recorded", "release-recorded-matched"]) }).strict(),
      ]),
      launch: z.union([
        originalUnavailableSchema,
        z.object({ state: z.literal("recorded"), phase: z.enum(["prepared", "begun"]), ordinal: count }).strict(),
      ]),
      producer: z.union([
        originalUnavailableSchema,
        z
          .object({ state: z.literal("recorded"), digest: hash, harness: z.enum(["pi", "opencode"]), ordinal: count })
          .strict(),
      ]),
      eventThrough: count.nullable(),
      appendAcknowledgement: z.literal("not-recorded"),
      failedRequestBinding: z.literal("unknown"),
      physicalEnding: z.literal("not-assessed"),
    })
    .strict(),
]);
export type OriginalEvidence = z.infer<typeof evidenceSchema>;
export const originalMetaSchema = z
  .object({
    userId: z.string().min(1).max(512),
    channelId: z.string().min(1).max(512),
    channelVisibility: z.enum(CHANNEL_VISIBILITIES).default("unknown"),
    repo: z.string().min(1).max(512).optional(),
    threadKey: z.string().min(1).max(512),
  })
  .strict();
export type OriginalMeta = z.infer<typeof originalMetaSchema>;
const resourceSchema = originalMetaSchema
  .omit({ threadKey: true })
  .extend({ type: z.literal("run"), id: z.string().regex(RUN_ID_PATTERN) })
  .strict();
export const originalReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), reason: z.enum(["missing", "corrupt", "oversize"]) }).strict(),
  z
    .object({
      kind: z.literal("source"),
      resource: resourceSchema,
      threadKey: z.string().min(1).max(512),
      evidence: evidenceSchema,
    })
    .strict(),
]);
export type OriginalRead = z.infer<typeof originalReadSchema>;
export const originalUnavailable = (reason: OriginalUnavailable["reason"]): OriginalUnavailable => ({
  state: "unavailable",
  reason,
});
/** A strict read codec cannot turn unexpected backend fields into operator output. */
export function originalReadOf(value: unknown): OriginalRead | undefined {
  const parsed = originalReadSchema.safeParse(value);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > ORIGINAL_REPLY_BYTES)
    return;
  return parsed.data;
}
