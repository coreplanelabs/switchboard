import { z } from "zod";
import { bindingSchema, identitySchema, personIdSchema } from "./contract.js";

const text = identitySchema.shape.subject;
const instant = bindingSchema.shape.changedAt;
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().regex(/^link:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const accessIdentity = identitySchema.extend({ tenant: z.null() });
const ownerSchema = z
  .object({ identity: accessIdentity, audience: text, browserHash: digest, proofVersion: version })
  .strict();
const authSchema = ownerSchema.extend({ expiresAt: instant });
const slackPolicySchema = z
  .object({ tenant: text, audience: text, callbackUri: z.url().startsWith("https://") })
  .strict();
const slackProofSchema = z
  .object({
    identity: identitySchema.extend({ issuer: z.literal("https://slack.com"), tenant: text }),
    audience: text,
    callbackUri: slackPolicySchema.shape.callbackUri,
    nonceHash: digest,
    expiresAt: instant,
    expectedRevision: revision,
  })
  .strict();
const addressed = { id, auth: authSchema };
const mutation = { ...addressed, expectedRevision: revision };

/** These are assertions from an authenticated, authorized internal caller.
 * Hashes are SHA-256 projections, never browser secrets or OAuth credentials.
 * No production caller exists; this seam cannot authenticate a human itself. */
export const linkCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("begin"),
      auth: authSchema,
      accessRevision: revision,
      slackPolicy: slackPolicySchema,
      stateHash: digest,
      nonceHash: digest,
      expiresAt: instant,
      resultExpiresAt: instant,
    })
    .strict(),
  z.object({ action: z.literal("claim"), ...mutation, stateHash: digest }).strict(),
  z.object({ action: z.literal("prove"), ...mutation, proof: slackProofSchema }).strict(),
  z.object({ action: z.literal("commit"), ...mutation, consent: z.boolean() }).strict(),
  z.object({ action: z.literal("cancel"), ...mutation }).strict(),
  z.object({ action: z.literal("interrupt"), ...mutation }).strict(),
  z.object({ action: z.literal("read"), ...addressed }).strict(),
]);
export type LinkCommand = z.infer<typeof linkCommandSchema>;
const failureSchema = z.enum(["conflict", "stale", "revoked", "failed", "cancelled", "expired"]);
export type LinkFailure = z.infer<typeof failureSchema>;
const successes = ["created", "linked", "already-linked"] as const;
const outcomeSchema = z.enum([...successes, ...failureSchema.options]);
function successful(outcome: z.infer<typeof outcomeSchema>): boolean {
  return successes.some((value) => value === outcome);
}
const observationSchema = z
  .object({
    identity: identitySchema,
    beforeRevision: revision,
    afterRevision: bindingSchema.shape.revision.or(z.literal(0)),
  })
  .strict();
export const linkAuditSchema = z
  .object({
    id,
    actor: accessIdentity,
    access: observationSchema,
    slack: observationSchema.nullable(),
    personId: personIdSchema.nullable(),
    consent: z.boolean(),
    outcome: outcomeSchema,
    proofVersion: version,
    at: instant,
  })
  .strict()
  .refine((a) => {
    if (JSON.stringify(a.actor) !== JSON.stringify(a.access.identity)) return false;
    if (!successful(a.outcome)) return a.personId === null;
    if (
      !a.personId ||
      !a.slack ||
      !a.consent ||
      a.slack.identity.issuer !== "https://slack.com" ||
      a.slack.identity.tenant === null
    )
      return false;
    const revisions = [a.access, a.slack];
    if (revisions.some((r) => r.afterRevision !== (r.beforeRevision || 1))) return false;
    const missing = revisions.filter((r) => r.beforeRevision === 0).length;
    return a.outcome === "created" ? missing === 2 : a.outcome === "linked" ? missing === 1 : missing === 0;
  });
export type LinkAudit = z.infer<typeof linkAuditSchema>;
const commonIntent = {
  id,
  owner: ownerSchema,
  revision,
  createdAt: instant,
  expiresAt: instant,
  resultExpiresAt: instant,
};
const activeSchema = z
  .object({
    ...commonIntent,
    state: z.enum(["pending", "exchanging", "awaiting-consent"]),
    accessRevision: revision,
    slackPolicy: slackPolicySchema,
    stateHash: digest,
    nonceHash: digest,
    slack: slackProofSchema.nullable(),
  })
  .strict()
  .refine((i) => (i.state === "awaiting-consent") === (i.slack !== null))
  .refine((i) => i.revision === (i.state === "pending" ? 1 : i.state === "exchanging" ? 2 : 3))
  .refine(
    (i) =>
      !i.slack ||
      (i.slack.identity.tenant === i.slackPolicy.tenant &&
        i.slack.audience === i.slackPolicy.audience &&
        i.slack.callbackUri === i.slackPolicy.callbackUri &&
        i.slack.nonceHash === i.nonceHash &&
        i.expiresAt <= i.slack.expiresAt),
  );
const terminalSchema = z
  .object({
    ...commonIntent,
    state: z.enum(["committed", "failed", "cancelled", "expired"]),
    outcome: outcomeSchema,
    receipt: linkAuditSchema,
  })
  .strict()
  .refine((i) =>
    i.state === "committed"
      ? successful(i.outcome)
      : i.state === "failed"
        ? ["conflict", "stale", "revoked", "failed"].includes(i.outcome)
        : i.state === i.outcome,
  )
  .refine((i) => (i.state === "committed" ? i.revision === 4 : i.revision >= 2 && i.revision <= 4))
  .refine(
    (i) =>
      i.receipt.id === i.id &&
      i.receipt.outcome === i.outcome &&
      JSON.stringify(i.receipt.actor) === JSON.stringify(i.owner.identity) &&
      i.receipt.proofVersion === i.owner.proofVersion,
  );
export const linkIntentSchema = z
  .union([activeSchema, terminalSchema])
  .refine((i) => i.createdAt < i.expiresAt && i.expiresAt <= i.resultExpiresAt && i.revision > 0);
export type LinkIntent = z.infer<typeof linkIntentSchema>;
export type ActiveLinkIntent = z.infer<typeof activeSchema>;
export type LinkView = Pick<LinkIntent, "id" | "state" | "revision" | "expiresAt">;
export type LinkResult =
  | { status: "ok" | "claimed"; intent: LinkView }
  | { status: "committed"; receipt: LinkAudit }
  | {
      status:
        LinkFailure | "not_found" | "invalid" | "unavailable" | "already_claimed" | "not_ready" | "consent_required";
    };
