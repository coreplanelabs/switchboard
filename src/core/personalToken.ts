/** Persisted personal MCP credential metadata. The bearer is never stored. */
export interface PersonalToken {
  digest: string;
  subject: string;
  email: string;
  createdAt: number;
}

export const PERSONAL_TOKEN_DIGEST = /^[a-f0-9]{64}$/;
export const personalSubject = (accessSub: string): string => `personal:${accessSub}`;

export function isPersonalToken(value: unknown): value is PersonalToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.digest === "string" &&
    PERSONAL_TOKEN_DIGEST.test(v.digest) &&
    typeof v.subject === "string" &&
    v.subject.startsWith("personal:") &&
    v.subject.length > "personal:".length &&
    v.subject.length <= 265 &&
    typeof v.email === "string" &&
    v.email.includes("@") &&
    typeof v.createdAt === "number" &&
    Number.isFinite(v.createdAt)
  );
}
