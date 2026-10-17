import { z } from "zod";
import { checkOperationSchema } from "../execution/checkOperation.js";
import { EXEC_INFRA_REASONS } from "../execution/execResult.js";
import type { CheckExecutionOwner, CheckExecutionState } from "./checkExecutionTypes.js";

export const STREAM_CAP = 4_000;
export const COMMAND_CAP = 16_000;
export const RECEIPT_CAP = 32;
export const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const resultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().min(0).max(255),
  truncated: z.boolean(),
});
export const storedResultSchema = resultSchema.extend({
  stdout: z.string().max(STREAM_CAP),
  stderr: z.string().max(STREAM_CAP),
});
export const ownerSchema = z
  .object({
    runId: z.string().min(1),
    requester: z.string().min(1),
    threadKey: z.string().min(1),
    unit: z.string().min(1).optional(),
    repo: z.string().min(1),
  })
  .strict()
  .refine((owner) => !Object.hasOwn(owner, "unit") || owner.unit !== undefined);
export const receiptSchema = z
  .object({
    callId: z.string().min(1).max(200),
    checkOperation: checkOperationSchema.optional(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/),
    command: z.string().max(COMMAND_CAP),
    purpose: z.enum(["baseline", "verification"]),
    owner: ownerSchema,
    workspace: z.object({ cwd: z.string().min(1).max(4096), head: sha, fingerprint: sha }).strict(),
    timeoutMs: z.number().int().positive(),
    startedAt: z.number().finite(),
    completedAt: z.number().finite().optional(),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pending") }).strict(),
      z
        .object({
          kind: z.literal("not_started"),
          reason: z.enum(["command_refused", "budget_exhausted", "stopped", "capacity"]),
        })
        .strict(),
      storedResultSchema.extend({ kind: z.literal("completed") }).strict(),
      z
        .object({
          kind: z.literal("unknown"),
          reason: z.enum(["interrupted", "transport", "invalid_result"]),
          infrastructureReason: z.enum(EXEC_INFRA_REASONS).optional(),
          result: storedResultSchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export { receiptSchema as checkExecutionReceiptSchema };

export const stateSchema = z
  .object({
    version: z.literal(1),
    receipts: z.array(receiptSchema).max(RECEIPT_CAP),
    metadata: z
      .object({
        callId: z.string().min(1).max(200),
        inputHash: z.string().regex(/^[a-f0-9]{64}$/),
        owner: ownerSchema,
        workspace: z.string().min(1).max(4096),
        checkOperation: checkOperationSchema,
        result: storedResultSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Shared identity encoding; readers verify stored keys and never fill an absent one. */
export function checkOperationSeed(owner: CheckExecutionOwner, callId: string, inputHash: string): string {
  return JSON.stringify([
    owner.runId,
    owner.requester,
    owner.threadKey,
    owner.repo,
    owner.unit ?? null,
    callId,
    inputHash,
  ]);
}
export function checkMetadataOperationSeed(commandKey: string): string {
  return JSON.stringify([commandKey, "metadata"]);
}

/** The same owner, uniqueness and ending checks for execution and canonical readers. */
export function checkExecutionStateOf(value: unknown, owner: CheckExecutionOwner): CheckExecutionState | undefined {
  const parsed = stateSchema.safeParse(value);
  if (!ownerSchema.safeParse(owner).success || !parsed.success) return undefined;
  const sameOwner = (candidate: CheckExecutionOwner) =>
    (["runId", "requester", "threadKey", "repo", "unit"] as const).every((key) => candidate[key] === owner[key]) &&
    Object.hasOwn(candidate, "unit") === Object.hasOwn(owner, "unit");
  if (parsed.data.metadata && !sameOwner(parsed.data.metadata.owner)) return undefined;
  if (
    parsed.data.receipts.some(
      (receipt) =>
        !sameOwner(receipt.owner) ||
        (receipt.outcome.kind !== "pending" && !Number.isFinite(receipt.completedAt)) ||
        (receipt.outcome.kind === "completed" && [124, 137, 143].includes(receipt.outcome.exitCode)),
    )
  )
    return undefined;
  if (new Set(parsed.data.receipts.map((receipt) => receipt.callId)).size !== parsed.data.receipts.length)
    return undefined;
  return parsed.data;
}
