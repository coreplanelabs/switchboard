import type { ErrorKind } from "../trace/types.js";
import { z } from "zod";
import { identitySchema } from "../identity/contract.js";
import { nativeMediaSchema, nativeMediaDigestSchema } from "../nativeMedia.js";

const text = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\P{Cc}+$/u);
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const sourceSchema = z.enum(["browser", "slack", "github", "cli", "http", "mcp"]);
export type OrganizationSource = z.infer<typeof sourceSchema>;
export const actorSchema = z
  .object({
    identity: identitySchema,
    kind: z.enum(["human", "service"]),
    principal: text,
    stream: text.nullable(),
    bindingRevision: revision,
    onBehalfOf: identitySchema.nullable(),
  })
  .strict();
export type OrganizationActor = z.infer<typeof actorSchema>;
/** Immutable authenticated lookup facts. Grants and membership are resolved afresh. */
export const sourceReferenceSchema = z
  .object({
    /** Digest of the exact original credential; never its bearer bytes. */
    credentialDigest: digest.optional(),
    browserRevision: revision.optional(),
    /** Server-attested private source and its retained-data policy at admission. */
    privateSource: z.literal(true).optional(),
    capturedPrivateEpoch: digest.optional(),
    /** One source-bound repository selected and authorized by the host. */
    sourceRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    questionOwnership: z
      .object({ unitKey: text, questionDigest: digest, requester: identitySchema })
      .strict()
      .optional(),
    actorId: text,
    userId: text,
    authenticatedAs: text.optional(),
    postedBy: text.optional(),
    channelId: text,
    threadKey: text,
    messageId: text.optional(),
    approvalConnection: z
      .object({ id: text, credentialId: text, requestHash: text, mode: z.literal("form").optional() })
      .strict()
      .optional(),
  })
  .strict();
export type OrganizationSourceReference = z.infer<typeof sourceReferenceSchema>;
/** A verified provider deletion names a source address, never a claimed user. */
export const sourceDeletionAddressSchema = z
  .object({
    source: sourceSchema,
    issuer: text,
    tenant: text.nullable(),
    channelId: text,
    messageId: text,
  })
  .strict();
export type SourceDeletionAddress = z.infer<typeof sourceDeletionAddressSchema>;
export const sourceDeletionSchema = z
  .object({
    address: sourceDeletionAddressSchema,
    deletedAt: instant,
    expiresAt: instant,
    complete: z.boolean(),
    after: text.optional(),
  })
  .strict();
export function sourceDeletionAddressOf(
  value: Pick<OrganizationEnvelope, "source" | "actor" | "sourceReference">,
): SourceDeletionAddress | undefined {
  const parsed = sourceDeletionAddressSchema.safeParse({
    source: value.source,
    issuer: value.actor.identity.issuer,
    tenant: value.actor.identity.tenant,
    channelId: value.sourceReference?.channelId,
    messageId: value.sourceReference?.messageId,
  });
  return parsed.success ? parsed.data : undefined;
}
export const sourceDeletionKey = (address: SourceDeletionAddress): string =>
  JSON.stringify([address.source, address.issuer, address.tenant, address.channelId, address.messageId]);
export const envelopeSchema = z
  .object({
    version: z.literal(1),
    organization: text,
    source: sourceSchema,
    sourceEvent: text,
    actor: actorSchema,
    key: text,
    digest,
    destination: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("broad") }).strict(),
      z.object({ kind: z.literal("thread"), thread: text }).strict(),
    ]),
    workload: z.enum(["message", "act", "reconciliation"]),
    target: z.object({ key: text, revision }).strict().nullable(),
    content: z.string().max(32_768),
    nativeMedia: nativeMediaSchema.optional(),
    nativeMediaDigest: nativeMediaDigestSchema.optional(),
    contentExpiresAt: instant.optional(),
    context: z
      .array(
        z
          .object({ kind: z.enum(["unit", "pipeline", "thread", "run", "pull-request", "repository"]), key: text })
          .strict(),
      )
      .max(8),
    sourceReference: sourceReferenceSchema.optional(),
    continuation: z
      .object({ kind: z.enum(["confirm", "cancel"]), id: z.string().uuid() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((e) => e.actor.kind === "human" || e.actor.stream === null || e.actor.onBehalfOf !== null)
  .refine(
    (e) =>
      !e.nativeMedia ||
      (e.source === "slack" &&
        !!e.nativeMediaDigest &&
        e.nativeMedia.channelId === e.sourceReference?.channelId &&
        e.nativeMedia.userId === e.sourceReference?.userId &&
        e.nativeMedia.threadKey === e.sourceReference?.threadKey &&
        e.nativeMedia.messageId === e.sourceReference?.messageId),
  )
  .refine((e) => !e.continuation || (e.content === "" && e.workload === "act"));
export type OrganizationEnvelope = z.infer<typeof envelopeSchema>;
export const sourceProvenanceSchema = z
  .object({
    receiptId: text,
    source: sourceSchema,
    actor: actorSchema,
    sourceReference: sourceReferenceSchema.optional(),
    admissionSequence: revision.optional(),
    retentionDeadline: instant.optional(),
  })
  .strict();
export const replyAddressSchema = z
  .object({ receiptId: text, envelope: envelopeSchema, ownerRunId: text, expiresAt: instant })
  .strict();
export const replyKeySchema = z.object({ key: z.string().min(1).max(8192), digest, expiresAt: instant }).strict();
export const receiptSchema = z
  .object({
    version: z.literal(1),
    id: text,
    organization: text,
    source: sourceSchema,
    sourceEvent: text,
    actor: actorSchema,
    key: text,
    digest,
    status: z.enum(["pending", "accepted", "rejected", "stale", "throttled"]),
    reason: text.nullable(),
    revision,
    target: text.nullable(),
    currentRevision: revision.nullable(),
    effectKey: text.nullable(),
    ownerRunId: text.optional(),
    createdAt: instant,
    settledAt: instant.nullable(),
    expiresAt: instant,
  })
  .strict();
export type OrganizationReceipt = z.infer<typeof receiptSchema>;
export const streamEntrySchema = z
  .object({
    version: z.literal(1),
    sequence: revision,
    /** Every reply inherits the original request's cross-source sharing boundary. */
    admissionSequence: revision.optional(),
    stream: text,
    receiptId: text,
    source: sourceSchema,
    sourceEvent: text,
    identity: identitySchema,
    onBehalfOf: identitySchema.nullable(),
    role: z.enum(["user", "assistant", "receipt"]),
    content: z.string().max(32_768),
    createdAt: instant,
    expiresAt: instant,
  })
  .strict();
export type OrganizationStreamEntry = z.infer<typeof streamEntrySchema>;
/** Read-only attribution after current source proof; never stored on a stream row. */
export const streamReadEntrySchema = streamEntrySchema.extend({ authorId: text.optional() });
export const stateSchema = z
  .object({
    version: z.literal(1),
    organization: text,
    orchestrator: text,
    revision,
    accessRevision: revision.default(0),
    sourcePolicyRevision: revision.default(0),
    wakeSequence: revision,
    reconciledSequence: revision,
    streamSequence: revision,
    laneCursor: text.nullable(),
    lease: z
      .object({ owner: text, generation: revision, expiresAt: instant, through: revision, admissionRevision: revision })
      .strict()
      .nullable(),
  })
  .strict();
export type OrganizationState = z.infer<typeof stateSchema>;
export const bindingCutoffSchema = z.object({ version: z.literal(1), sequence: revision }).strict();
export const limitsSchema = z
  .object({
    pendingPerActor: z.number().int().positive().max(10_000),
    pendingPerSource: z.number().int().positive().max(100_000),
    pendingPerOrganization: z.number().int().positive().max(100_000),
    reservedReconciliation: z.number().int().positive().max(10_000),
    contentTtlMs: z.number().int().positive(),
    sourceSnapshotTtlMs: z.number().int().positive().optional(),
    receiptTtlMs: z.number().int().positive(),
  })
  .strict();
export type OrganizationLimits = z.infer<typeof limitsSchema>;
const addressed = { organization: text };
const owned = { ...addressed, owner: text, generation: revision };
export const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("issue"),
      organization: text,
      source: sourceSchema,
      actor: actorSchema,
      ttlMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ action: z.literal("access"), organization: text, identity: identitySchema, allowed: z.boolean() })
    .strict(),
  z.object({ action: z.literal("identities"), organization: text, personId: text }).strict(),
  z.object({ action: z.literal("get"), ...addressed }).strict(),
  z
    .object({ action: z.literal("submission"), ...addressed, source: sourceSchema, actor: actorSchema, key: text })
    .strict(),
  z.object({ action: z.literal("provenance"), ...addressed, actor: actorSchema, receiptId: text }).strict(),
  z
    .object({
      action: z.literal("source-catalogue"),
      ...addressed,
      actor: actorSchema,
      limit: z.number().int().positive().max(200),
      paged: z.literal(true).optional(),
      after: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("source-policy-observe"),
      ...addressed,
      actor: actorSchema,
      expectedRevision: revision,
      observations: z
        .array(
          z
            .object({
              authority: z.string().min(1),
              fingerprint: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("owner-clears"),
      ...addressed,
      limit: z.number().int().positive().max(100),
      sourceMessage: sourceDeletionAddressSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal("owner-cleared"), ...addressed, receiptId: text, effectKey: text }).strict(),
  z
    .object({
      action: z.literal("owner-refused"),
      ...addressed,
      receiptId: text,
      ownerRunId: text,
      reason: text,
      target: z.object({ key: text, revision }).strict().nullable().optional(),
    })
    .strict(),
  z.object({ action: z.literal("wake"), ...addressed }).strict(),
  z.object({ action: z.literal("claim"), ...addressed, owner: text, leaseMs: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("complete"), ...owned, through: revision }).strict(),
  z.object({ action: z.literal("yield"), ...owned }).strict(),
  z.object({ action: z.literal("effect"), ...owned, source: sourceSchema, key: text, actor: actorSchema }).strict(),
  z.object({ action: z.literal("observe"), ...addressed, target: text, revision }).strict(),
  z.object({ action: z.literal("admit"), envelope: envelopeSchema, limits: limitsSchema }).strict(),
  z.object({ action: z.literal("pending"), ...owned, limit: z.number().int().positive().max(100) }).strict(),
  z
    .object({
      action: z.literal("settle"),
      ...owned,
      receiptId: text,
      status: z.enum(["accepted", "rejected"]),
      ownerRunId: text.optional(),
      reason: text.nullable(),
      reply: z.string().max(32_768).nullable(),
      contentTtlMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reply"),
      organization: text,
      receiptId: text,
      actor: actorSchema,
      ownerRunId: text,
      replyKey: text,
      digest,
      content: z.string().max(32_768),
      contentTtlMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("execution"),
      organization: text,
      receiptId: text,
      actor: actorSchema,
      ownerRunId: text,
    })
    .strict(),
  z
    .object({
      action: z.literal("tail"),
      organization: text,
      stream: text,
      actor: actorSchema,
      before: revision.optional(),
      limit: z.number().int().positive().max(200),
      identities: z.array(identitySchema).max(100),
    })
    .strict(),
  z
    .object({
      action: z.literal("stream"),
      ...addressed,
      stream: text,
      actor: actorSchema,
      after: revision,
      limit: z.number().int().positive().max(200),
      identities: z.array(identitySchema).max(100),
    })
    .strict(),
  z.object({ action: z.literal("delete"), ...addressed, stream: text, actor: actorSchema, receiptId: text }).strict(),
  z
    .object({
      action: z.literal("delete-source"),
      ...addressed,
      address: sourceDeletionAddressSchema,
      ttlMs: z.number().int().positive(),
    })
    .strict(),
  z.object({ action: z.literal("source-deletes"), ...addressed, limit: z.number().int().positive().max(100) }).strict(),
  z.object({ action: z.literal("expire"), ...addressed }).strict(),
]);
export type OrganizationCommand = z.infer<typeof commandSchema>;
export const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("source-deletes"), addresses: z.array(sourceDeletionAddressSchema).max(100) }).strict(),
  z.object({ status: z.literal("source-policies-observed"), revision, accessRevision: revision }).strict(),
  z.object({ status: z.literal("submission"), envelope: envelopeSchema, receipt: receiptSchema }).strict(),
  z.object({ status: z.literal("provenance"), provenance: sourceProvenanceSchema }).strict(),
  z
    .object({
      status: z.literal("source-catalogue"),
      accessRevision: revision,
      revision: revision.optional(),
      next: z.string().min(1).optional(),
      entries: z
        .array(
          z
            .object({
              authority: z.string().min(1),
              source: sourceSchema,
              actor: actorSchema,
              sourceReference: sourceReferenceSchema.optional(),
              allowed: z.boolean(),
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  z
    .object({
      status: z.literal("owner-clears"),
      items: z.array(z.object({ receiptId: text, effectKey: text, expiresAt: instant.optional() }).strict()),
    })
    .strict(),
  z
    .object({
      status: z.literal("stream_tail"),
      revision,
      entries: z.array(streamReadEntrySchema),
      cursor: revision,
      beforeCursor: revision,
      hasMore: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal("key"), key: text, expiresAt: instant }).strict(),
  z.object({ status: z.literal("identities"), identities: z.array(identitySchema) }).strict(),
  z.object({ status: z.literal("state"), state: stateSchema }).strict(),
  z.object({ status: z.literal("receipt"), receipt: receiptSchema, duplicate: z.boolean() }).strict(),
  z
    .object({ status: z.literal("pending"), envelopes: z.array(envelopeSchema), receipts: z.array(receiptSchema) })
    .strict(),
  z
    .object({
      status: z.literal("stream"),
      revision,
      entries: z.array(streamReadEntrySchema),
      cursor: revision,
      hasMore: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal("ok"), removed: revision }).strict(),
  z.object({ status: z.enum(["invalid", "unavailable", "fenced", "busy", "conflict", "not_found", "stale"]) }).strict(),
]);
export type OrganizationResult = z.infer<typeof resultSchema>;
/** Authenticated internal seam. Adapters cannot submit commands directly. */
export interface OrganizationStore {
  execute(command: OrganizationCommand): Promise<OrganizationResult>;
}

/** Closed owner-task diagnostics carry no source content or execution authority. */
export const ORGANIZATION_HISTORY_FAILURE_CODES = [
  "history_conversation_unavailable",
  "history_epoch_unavailable",
  "history_tail_unavailable",
  "history_after_tail_unavailable",
  "history_after_context_unavailable",
  "history_provenance_unavailable",
  "history_producer_unavailable",
  "history_context_unavailable",
] as const;
export type OrganizationHistoryFailureCode = (typeof ORGANIZATION_HISTORY_FAILURE_CODES)[number];

export type OrganizationOwnerStage =
  | "actor"
  | "authorization"
  | "execution-fence"
  | "source-snapshot"
  | "request"
  | "sink"
  | "execute"
  | "settlement"
  | "uncertain-settlement"
  | "schedule";
interface OwnerFailure {
  stage: OrganizationOwnerStage;
  kind: ErrorKind;
  code?: OrganizationHistoryFailureCode;
}
export interface OrganizationOwnerFailure {
  runId: string;
  receiptId: string;
  requestDigest: string;
  branch: "dispatch" | "answer" | "confirm";
  failure: OwnerFailure;
  firstFailure?: OwnerFailure;
}
