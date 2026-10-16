import { z } from "zod";
import { actorSchema, sourceReferenceSchema, sourceSchema } from "./contract.js";
import type { OrganizationActor, OrganizationSource, OrganizationSourceReference } from "./contract.js";

export const sourcePolicySchema = z
  .object({
    version: z.literal(1),
    authority: z.string().min(1),
    source: sourceSchema,
    actor: actorSchema,
    sourceReference: sourceReferenceSchema.optional(),
    observedFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
/** Protected authority metadata, without message, content, or per-request revisions. */
export function sourceAuthority(
  source: OrganizationSource,
  actor: Pick<OrganizationActor, "identity" | "onBehalfOf">,
  reference?: OrganizationSourceReference,
): string {
  return JSON.stringify([
    source,
    actor.identity,
    actor.onBehalfOf ?? null,
    reference
      ? [
          reference.actorId,
          reference.userId,
          reference.authenticatedAs ?? null,
          reference.postedBy ?? null,
          reference.credentialDigest ?? null,
          reference.approvalConnection
            ? [reference.approvalConnection.id, reference.approvalConnection.credentialId]
            : null,
          reference.channelId,
          reference.threadKey,
          reference.questionOwnership
            ? [reference.questionOwnership.unitKey, reference.questionOwnership.requester]
            : null,
        ]
      : null,
  ]);
}
