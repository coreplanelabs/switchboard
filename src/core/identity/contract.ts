import { z } from "zod";
import type { LinkCommand, LinkResult } from "./linkContract.js";

// Persistence only: callers authenticate subjects and authorize link/recovery
// ceremonies before using this seam. No adapter or policy consumes it yet.
const component = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^\P{Cc}+$/u);
export const personIdSchema = z
  .string()
  .regex(/^person:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .brand<"PersonId">();
export type PersonId = z.infer<typeof personIdSchema>;
export const identitySchema = z
  .object({ issuer: component, tenant: component.nullable(), subject: component })
  .strict();
export type ExternalIdentity = z.infer<typeof identitySchema>;
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const proofSchema = z
  .object({
    method: z.enum(["authenticated-human", "dual-authentication", "administrator-recovery"]),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const bindingSchema = z
  .object({
    identity: identitySchema,
    personId: personIdSchema,
    state: z.enum(["active", "revoked"]),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    proof: proofSchema,
    changedAt: instant,
  })
  .strict();
export type PersonBinding = z.infer<typeof bindingSchema>;
export interface Person {
  id: PersonId;
  createdAt: number;
}
export const changeSchema = z
  .object({
    action: z.enum(["link", "revoke", "recover"]),
    identity: identitySchema,
    personId: personIdSchema,
    expectedRevision: revision,
    actor: identitySchema,
    proof: proofSchema,
  })
  .strict()
  .refine((c) => c.action !== "recover" || c.proof.method === "administrator-recovery")
  .refine((c) => c.action !== "link" || c.proof.method === "dual-authentication");
export type BindingChange = z.infer<typeof changeSchema>;
export const receiptSchema = z
  .object({
    action: z.enum(["link", "revoke", "recover"]),
    actor: identitySchema,
    binding: bindingSchema,
  })
  .strict();
export type BindingReceipt = z.infer<typeof receiptSchema>;
export type BindingResolution =
  | { status: "bound"; binding: PersonBinding }
  | { status: "revoked"; revision: number }
  | { status: "unknown" | "conflict" | "invalid" | "unavailable" };
export type ChangeResult =
  | { status: "changed"; binding: PersonBinding }
  | { status: "conflict" | "stale" | "revoked" | "unknown" | "unknown_person" | "invalid" | "unavailable" };
export type CreatePersonResult = { status: "created"; person: Person } | { status: "unavailable" };
export type ReceiptsResult =
  { status: "ok"; receipts: BindingReceipt[] } | { status: "invalid" | "conflict" | "unavailable" };

/** Trusted internal storage boundary, not an account-linking or authorization API. */
export interface PersonDirectory {
  createPerson(): Promise<CreatePersonResult>;
  resolve(identity: ExternalIdentity): Promise<BindingResolution>;
  change(change: BindingChange): Promise<ChangeResult>;
  receipts(identity: ExternalIdentity): Promise<ReceiptsResult>;
  /** Disabled dual-identity intent lifecycle; every command is one transaction. */
  link(command: LinkCommand): Promise<LinkResult>;
}

/** The missing dependency is unavailable, never a guessed person or a new local store. */
export async function resolvePerson(
  directory: PersonDirectory | undefined,
  identity: ExternalIdentity,
): Promise<BindingResolution> {
  if (!directory) return { status: "unavailable" };
  try {
    return await directory.resolve(identity);
  } catch {
    return { status: "unavailable" };
  }
}

/** Whitelist for later run attribution; identity subjects and proof payloads never ride it. */
export function runBindingAttribution(value: unknown):
  | {
      personId: PersonId;
      bindingRevision: number;
      proofMethod: PersonBinding["proof"]["method"];
      proofVersion: number;
    }
  | undefined {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success || parsed.data.state !== "active") return undefined;
  const b = parsed.data;
  return {
    personId: b.personId,
    bindingRevision: b.revision,
    proofMethod: b.proof.method,
    proofVersion: b.proof.version,
  };
}
