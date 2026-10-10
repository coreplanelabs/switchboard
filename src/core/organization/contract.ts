import { z } from "zod";
import { identitySchema } from "../identity/contract.js";

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
    contentExpiresAt: instant.optional(),
    context: z
      .array(z.object({ kind: z.enum(["unit", "pipeline", "thread", "run", "pull-request"]), key: text }).strict())
      .max(8),
  })
  .strict()
  .refine((e) => e.actor.kind === "human" || e.actor.stream === null || e.actor.onBehalfOf !== null);
export type OrganizationEnvelope = z.infer<typeof envelopeSchema>;
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
export const stateSchema = z
  .object({
    version: z.literal(1),
    organization: text,
    orchestrator: text,
    revision,
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
export const limitsSchema = z
  .object({
    pendingPerActor: z.number().int().positive().max(10_000),
    pendingPerSource: z.number().int().positive().max(100_000),
    pendingPerOrganization: z.number().int().positive().max(100_000),
    reservedReconciliation: z.number().int().positive().max(10_000),
    contentTtlMs: z.number().int().positive(),
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
  z.object({ action: z.literal("wake"), ...addressed }).strict(),
  z.object({ action: z.literal("claim"), ...addressed, owner: text, leaseMs: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("complete"), ...owned, through: revision }).strict(),
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
      reason: text.nullable(),
      reply: z.string().max(32_768).nullable(),
      contentTtlMs: z.number().int().positive(),
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
  z.object({ action: z.literal("expire"), ...addressed }).strict(),
]);
export type OrganizationCommand = z.infer<typeof commandSchema>;
export const resultSchema = z.discriminatedUnion("status", [
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
      entries: z.array(streamEntrySchema),
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
