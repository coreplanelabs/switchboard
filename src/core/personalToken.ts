/** Public identifiers pinned by a fresh, authenticated device approval.
 * This is standing delegation provenance, never a saved JWT or grants. */
export interface PersonalTokenApproval {
  version: 1;
  issuer: string;
  audience: string;
  organization: string;
  subject: string;
}

/** Persisted personal MCP credential metadata. The bearer is never stored. */
export interface PersonalToken {
  digest: string;
  subject: string;
  email: string;
  /** Exact authenticated Access account. Slack values are legacy metadata only. */
  userId?: string;
  createdAt: number;
  approval?: PersonalTokenApproval;
}

export const PERSONAL_TOKEN_DIGEST = /^[a-f0-9]{64}$/;
export const personalSubject = (accessSub: string): string => `personal:${accessSub}`;

export function isPersonalTokenApproval(value: unknown): value is PersonalTokenApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 5 || v.version !== 1) return false;
  for (const field of ["issuer", "audience", "organization", "subject"])
    if (
      typeof v[field] !== "string" ||
      !v[field] ||
      v[field].length > 512 ||
      v[field].trim() !== v[field] ||
      /\p{Cc}/u.test(v[field])
    )
      return false;
  if ((v.subject as string).length > 256 || (v.subject as string).includes(":")) return false;
  try {
    const issuer = new URL(v.issuer as string);
    return issuer.protocol === "https:" && issuer.origin === v.issuer;
  } catch {
    return false;
  }
}

/** Current host identity, supplied by the trusted adapter rather than a request. */
export type PersonalTokenApprovalPin = Pick<PersonalTokenApproval, "issuer" | "audience" | "organization">;

/** A stored approval supplies provenance only within this current host realm. */
export function personalTokenApprovalMatchesPin(
  approval: PersonalTokenApproval | undefined,
  pin: PersonalTokenApprovalPin | undefined,
): boolean {
  return (
    !!pin &&
    isPersonalTokenApproval(approval) &&
    approval.issuer === pin.issuer &&
    approval.audience === pin.audience &&
    approval.organization === pin.organization
  );
}

export function personalTokenApprovalMatches(first?: PersonalTokenApproval, second?: PersonalTokenApproval): boolean {
  return first === undefined || second === undefined
    ? first === second
    : first.version === second.version &&
        first.issuer === second.issuer &&
        first.audience === second.audience &&
        first.organization === second.organization &&
        first.subject === second.subject;
}

export function isPersonalToken(value: unknown): value is PersonalToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["digest", "subject", "email", "userId", "createdAt", "approval"].includes(key)))
    return false;
  return (
    typeof v.digest === "string" &&
    PERSONAL_TOKEN_DIGEST.test(v.digest) &&
    typeof v.subject === "string" &&
    v.subject.startsWith("personal:") &&
    v.subject.length > "personal:".length &&
    v.subject.length <= 265 &&
    typeof v.email === "string" &&
    v.email.includes("@") &&
    (v.userId === undefined || (typeof v.userId === "string" && /^(slack|access):[^:]+$/.test(v.userId))) &&
    (v.approval === undefined ||
      (isPersonalTokenApproval(v.approval) &&
        v.subject === personalSubject(v.approval.subject) &&
        v.userId === `access:${v.approval.subject}`)) &&
    typeof v.createdAt === "number" &&
    Number.isFinite(v.createdAt)
  );
}

/** The protected personal subject was minted from the approving Access sub.
 * Legacy absent ids can retain that exact account; an email match cannot
 * select a Slack account or replace an explicitly different stored identity. */
export function personalTokenForAuthentication(value: unknown): PersonalToken | null {
  if (!isPersonalToken(value)) return null;
  const userId = `access:${value.subject.slice("personal:".length)}`;
  return value.userId === undefined || value.userId === userId ? { ...structuredClone(value), userId } : null;
}

export function personalTokenCanReplace(prior: unknown, next: PersonalToken): boolean {
  if (prior === undefined) return true;
  const first = personalTokenForAuthentication(prior),
    second = personalTokenForAuthentication(next);
  return (
    !!first &&
    !!second &&
    first.subject === second.subject &&
    first.userId === second.userId &&
    personalTokenApprovalMatches(first.approval, second.approval)
  );
}

export class PersonalTokenBindingConflict extends Error {
  constructor() {
    super("This connection requires a new device approval.");
  }
}
