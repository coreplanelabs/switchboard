import { z } from "zod";
import { redactSecrets } from "../redact.js";
import { ORG_RECEIPT_TTL_MS } from "../budgets.js";
import { TRANSCRIPT_REQUEST_BYTES } from "./types.js";
import {
  envelopeSchema,
  ORGANIZATION_OWNER_STAGES,
  organizationDispatchResultSchema,
  organizationOwnerFailureFactSchema,
} from "../organization/contract.js";

const name = z.string().min(1).max(2048);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const unreadIngressProofSchema = z
  .object({
    ingressRunId: name,
    receiverRunId: name,
    receiverGen: name,
    inboxSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type UnreadIngressProof = z.infer<typeof unreadIngressProofSchema>;
const unreadIngressSchema = unreadIngressProofSchema.omit({ ingressRunId: true }).extend({
  status: z.enum(["pending", "claimed"]),
  organizationSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  organizationRepo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/)
    .optional(),
});
export const ingressRequestSchema = z
  .object({
    effectKey: name,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    requester: name,
    threadKey: name,
    request: z.record(z.string(), z.unknown()).refine((value) => {
      try {
        return new TextEncoder().encode(JSON.stringify(value)).length <= TRANSCRIPT_REQUEST_BYTES;
      } catch {
        return false;
      }
    }),
    contentExpiresAt: instant,
    /** Non-content original attribution. No context excerpts or grants survive here. */
    origin: envelopeSchema.refine((envelope) => envelope.content === "" && envelope.context.length === 0).optional(),
    originExpiresAt: instant.optional(),
    receiptId: name.optional(),
  })
  .strict();
export type IngressRequest = z.infer<typeof ingressRequestSchema>;
export const ingressRecordSchema = ingressRequestSchema
  .extend({
    version: z.literal(1),
    runId: name,
    request: ingressRequestSchema.shape.request.nullable(),
    status: z.enum(["dispatching", "completed", "uncertain"]),
    outcome: z.string().max(2048).nullable(),
    createdAt: instant,
    settledAt: instant.optional(),
    handlerOutcome: z.enum(["completed", "refused", "uncertain"]).optional(),
    dispatchResult: organizationDispatchResultSchema.optional(),
    ownerStage: z.enum(ORGANIZATION_OWNER_STAGES).optional(),
    failure: organizationOwnerFailureFactSchema.optional(),
    refusalPending: z.boolean().optional(),
    unread: unreadIngressSchema.optional(),
    launch: z
      .object({
        producerGeneration: name,
        launchId: z.string().uuid(),
        launchedAt: instant,
      })
      .strict()
      .optional(),
    terminal: z
      .object({
        producerGeneration: name,
        launchId: z.string().uuid(),
        outcome: z.enum(["completed", "refused"]),
        recordedAt: instant,
      })
      .strict()
      .optional(),
  })
  .strict();
export type IngressRecord = z.infer<typeof ingressRecordSchema>;
export const ingressLaunchSchema = z
  .object({
    effectKey: name,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    runId: name,
    receiptId: name,
    producerGeneration: name,
    launchId: z.string().uuid(),
  })
  .strict();
export type IngressLaunch = z.infer<typeof ingressLaunchSchema>;
/** Trusted owner/config metadata on the existing erasure operation. */
export const ingressClearProtectionSchema = z
  .object({ expiresAt: instant.optional(), receiptTtlMs: instant.positive() })
  .strict();
export type IngressClearProtection = z.infer<typeof ingressClearProtectionSchema>;
export function ingressDeletionDeadline(
  prior: IngressRecord | null,
  existing: number | undefined,
  protection: IngressClearProtection | undefined,
  now: number,
): number {
  if (existing !== undefined) return existing;
  return (
    prior?.originExpiresAt ??
    protection?.expiresAt ??
    Math.min(Number.MAX_SAFE_INTEGER, now + (protection?.receiptTtlMs ?? ORG_RECEIPT_TTL_MS))
  );
}
/** Expiry alone never settles uncertain work or an unacknowledged repair. */
export function retiredIngressCandidate(value: unknown, now: number): value is IngressRecord {
  const parsed = ingressRecordSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.status === "completed" &&
    !parsed.data.refusalPending &&
    parsed.data.unread?.status !== "pending" &&
    typeof parsed.data.outcome === "string" &&
    !!parsed.data.origin &&
    parsed.data.origin.digest === parsed.data.digest &&
    parsed.data.originExpiresAt !== undefined &&
    parsed.data.originExpiresAt <= now
  );
}
export type IngressResult =
  | { status: "unread"; records: IngressRecord[] }
  | { status: "refusals"; records: IngressRecord[] }
  | { status: "claimed" | "duplicate" | "record"; record: IngressRecord }
  | { status: "invalid" | "conflict" | "not_found" | "fenced" };
export const ingressSettlementSchema = z
  .object({
    effectKey: name,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    runId: name,
    status: z.enum(["completed", "uncertain"]),
    outcome: z.string().max(2048),
    handlerOutcome: z.enum(["completed", "refused", "uncertain"]).optional(),
    dispatchResult: organizationDispatchResultSchema.optional(),
    ownerStage: z.enum(ORGANIZATION_OWNER_STAGES).optional(),
    failure: organizationOwnerFailureFactSchema.optional(),
    refusalPending: z.boolean().optional(),
    producerGeneration: name.optional(),
    launchId: z.string().uuid().optional(),
  })
  .strict();
export type IngressSettlement = z.infer<typeof ingressSettlementSchema>;

/** The original run owner keeps the request even when routing dies before a run exists.
 * A duplicate never receives permission to route again. Dispatching after a crash
 * is uncertain; only evidence about this run can settle it. */
export function consumeIngress(prior: IngressRecord | null, input: IngressRequest, now: number): IngressResult {
  const parsed = ingressRequestSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  if (prior) {
    prior = ingressRecordSchema.parse(prior);
    if (prior.digest !== input.digest || prior.requester !== input.requester || prior.threadKey !== input.threadKey)
      return { status: "conflict" };
    return { status: "duplicate", record: retainedIngress(prior, now) };
  }
  if (input.contentExpiresAt <= now || (input.originExpiresAt !== undefined && input.originExpiresAt <= now))
    return { status: "invalid" };
  return {
    status: "claimed",
    record: ingressRecordSchema.parse({
      ...parsed.data,
      version: 1,
      runId: crypto.randomUUID(),
      request: structuredClone(parsed.data.request),
      status: "dispatching",
      outcome: null,
      createdAt: now,
    }),
  };
}
export function retainedIngress(record: IngressRecord, now: number): IngressRecord {
  record = ingressRecordSchema.parse(record);
  return {
    ...structuredClone(record),
    request: record.contentExpiresAt <= now ? null : structuredClone(record.request),
  };
}
export function launchIngress(prior: IngressRecord | null, input: IngressLaunch, now: number): IngressResult {
  const parsed = ingressLaunchSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  if (!prior) return { status: "not_found" };
  if (
    prior.effectKey !== input.effectKey ||
    prior.digest !== input.digest ||
    prior.runId !== input.runId ||
    prior.receiptId !== input.receiptId ||
    prior.origin?.digest !== input.digest ||
    prior.origin.sourceReference?.userId !== prior.requester ||
    prior.origin.sourceReference.threadKey !== prior.threadKey
  )
    return { status: "fenced" };
  if (prior.launch)
    return prior.launch.producerGeneration === input.producerGeneration && prior.launch.launchId === input.launchId
      ? { status: "record", record: retainedIngress(prior, now) }
      : { status: "fenced" };
  if (
    prior.status !== "dispatching" ||
    !prior.request ||
    prior.contentExpiresAt <= now ||
    (prior.originExpiresAt !== undefined && prior.originExpiresAt <= now)
  )
    return { status: "fenced" };
  return {
    status: "record",
    record: ingressRecordSchema.parse({
      ...retainedIngress(prior, now),
      launch: { producerGeneration: input.producerGeneration, launchId: input.launchId, launchedAt: now },
    }),
  };
}
export function finishIngress(prior: IngressRecord | null, input: IngressSettlement, now: number): IngressResult {
  const parsed = ingressSettlementSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" };
  const outcome = redactSecrets(parsed.data.outcome);
  if (outcome.length > 2048) return { status: "invalid" };
  if (!prior) return { status: "not_found" };
  if (input.digest !== prior.digest || input.runId !== prior.runId) return { status: "fenced" };
  if ((input.producerGeneration === undefined) !== (input.launchId === undefined)) return { status: "invalid" };
  if (
    (prior.launch !== undefined || input.launchId !== undefined) &&
    (prior.launch?.launchId !== input.launchId || prior.launch?.producerGeneration !== input.producerGeneration)
  )
    return { status: "fenced" };
  if (
    !["completed", "uncertain"].includes(input.status) ||
    typeof input.outcome !== "string" ||
    input.outcome.length > 2048
  )
    return { status: "invalid" };
  const terminal =
    input.launchId !== undefined &&
    input.status === "completed" &&
    (input.handlerOutcome === "completed" || input.handlerOutcome === "refused")
      ? {
          producerGeneration: input.producerGeneration!,
          launchId: input.launchId,
          outcome: input.handlerOutcome,
          recordedAt: now,
        }
      : undefined;
  if (prior.status === "completed")
    return {
      status: "record",
      record:
        terminal && !prior.terminal
          ? ingressRecordSchema.parse({ ...retainedIngress(prior, now), terminal })
          : retainedIngress(prior, now),
    };
  return {
    status: "record",
    record: ingressRecordSchema.parse({
      ...retainedIngress(prior, now),
      status: input.status,
      outcome,
      settledAt: now,
      ...(input.handlerOutcome ? { handlerOutcome: input.handlerOutcome } : {}),
      ...(input.dispatchResult ? { dispatchResult: input.dispatchResult } : {}),
      ...(input.ownerStage ? { ownerStage: input.ownerStage } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
      ...(input.refusalPending ? { refusalPending: true } : {}),
      ...(terminal && !prior.terminal ? { terminal } : {}),
    }),
  };
}

/** A continuation claim is never reissued. After a crash, its outcome is unknown
 * until the original run supplies evidence; another request cannot stand in. */
export function claimUnreadIngress(prior: IngressRecord | null, now: number): IngressResult {
  if (!prior) return { status: "not_found" };
  const record = retainedIngress(prior, now);
  if (
    record.status !== "uncertain" ||
    record.unread?.status !== "pending" ||
    !record.request ||
    record.refusalPending ||
    (record.originExpiresAt !== undefined && record.originExpiresAt <= now)
  )
    return { status: "fenced" };
  return {
    status: "claimed",
    record: ingressRecordSchema.parse({
      ...record,
      status: "uncertain",
      outcome: "The original unread input's continuation was claimed; its outcome is not yet confirmed.",
      unread: { ...record.unread, status: "claimed" },
    }),
  };
}
