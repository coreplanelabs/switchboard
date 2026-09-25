import {
  bindingSchema,
  personIdSchema,
  receiptSchema,
  type BindingChange,
  type BindingResolution,
  type ChangeResult,
  type ExternalIdentity,
  type Person,
  type PersonBinding,
  type ReceiptsResult,
} from "./contract.js";

/** An encoded tuple has no delimiter collisions and preserves case and null tenant. */
export function identityKey(identity: ExternalIdentity): string {
  return JSON.stringify([identity.issuer, identity.tenant, identity.subject]);
}
export function mintPerson(now: number): Person {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid directory clock");
  return { id: personIdSchema.parse(`person:${crypto.randomUUID()}`), createdAt: now };
}
export type StoredBinding = { status: "present"; binding: PersonBinding } | { status: "unknown" | "conflict" };

/** A corrupt row must not become an absent row that a fresh link could overwrite. */
export function readBinding(
  raw: unknown,
  identity: ExternalIdentity,
  personExists: (id: string) => boolean,
): StoredBinding {
  if (raw === undefined) return { status: "unknown" };
  const parsed = bindingSchema.safeParse(raw);
  if (
    !parsed.success ||
    identityKey(parsed.data.identity) !== identityKey(identity) ||
    !personExists(parsed.data.personId)
  )
    return { status: "conflict" };
  return { status: "present", binding: parsed.data };
}
export function resolution(current: StoredBinding): BindingResolution {
  if (current.status !== "present") return current;
  return current.binding.state === "active"
    ? { status: "bound", binding: current.binding }
    : { status: "revoked", revision: current.binding.revision };
}

/** Called with validated input while the implementation holds its transaction. */
export function decideChange(current: StoredBinding, change: BindingChange, now: number): ChangeResult {
  if (current.status === "conflict") return { status: "conflict" };
  const previous = current.status === "present" ? current.binding : undefined;
  if (previous && previous.personId !== change.personId) return { status: "conflict" };
  if ((previous?.revision ?? 0) !== change.expectedRevision) return { status: "stale" };
  if (!previous && change.action !== "link") return { status: "unknown" };
  if (change.action === "recover" && previous?.state !== "revoked") return { status: "invalid" };
  if (change.action !== "recover" && previous?.state === "revoked") return { status: "revoked" };
  if (!Number.isSafeInteger(now) || now < 0) return { status: "invalid" };
  return {
    status: "changed",
    binding: {
      identity: change.identity,
      personId: change.personId,
      state: change.action === "revoke" ? "revoked" : "active",
      revision: change.expectedRevision + 1,
      proof: change.proof,
      changedAt: now,
    },
  };
}

export function readReceipts(rows: unknown[], identity: ExternalIdentity): ReceiptsResult {
  const parsed = receiptSchema.array().safeParse(rows);
  if (!parsed.success || parsed.data.some((r) => identityKey(r.binding.identity) !== identityKey(identity)))
    return { status: "conflict" };
  return { status: "ok", receipts: parsed.data };
}
