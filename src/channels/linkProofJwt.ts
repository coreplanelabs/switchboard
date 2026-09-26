import { createPublicKey } from "node:crypto";
import { secondsToMs } from "../core/budgets.js";
import type { AccessJwk } from "./accessAuth.js";

/** These helpers never confer trust: only a successful signature check does. */
export function jwtParts(
  token: unknown,
): { header: Record<string, unknown>; claims: Record<string, unknown>; input: string; signature: Buffer } | null {
  if (typeof token !== "string" || token.length > 16384) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const [header, claims] = parts.slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
    if (![header, claims].every((v) => v && typeof v === "object" && !Array.isArray(v))) return null;
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !header.kid ||
      header.crit !== undefined ||
      header.b64 !== undefined
    )
      return null;
    return { header, claims, input: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
  } catch {
    return null;
  }
}
export function signingKeys(keys: AccessJwk[]): AccessJwk[] {
  return keys.filter((k) => {
    try {
      return (
        typeof k.kid === "string" &&
        keys.filter((v) => v.kid === k.kid).length === 1 &&
        k.kty === "RSA" &&
        (k.alg === undefined || k.alg === "RS256") &&
        (k.use === undefined || k.use === "sig") &&
        (k.key_ops === undefined || (Array.isArray(k.key_ops) && k.key_ops.includes("verify"))) &&
        (createPublicKey({ key: k, format: "jwk" }).asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
      );
    } catch {
      return false;
    }
  });
}
export function audienceValid(value: unknown, audience: string): boolean {
  return (
    value === audience ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => typeof v === "string" && v.length > 0) &&
      new Set(value).size === value.length &&
      value.includes(audience))
  );
}
export function tokenTimes(
  claims: Record<string, unknown>,
  now: number,
): { issuedAt: number; expiresAt: number } | null {
  const instant = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(secondsToMs(v)) && v >= 0;
  if (!instant(claims.exp) || !instant(claims.iat) || (claims.nbf !== undefined && !instant(claims.nbf))) return null;
  const issuedAt = secondsToMs(claims.iat),
    expiresAt = secondsToMs(claims.exp);
  if (
    expiresAt <= now ||
    issuedAt >= expiresAt ||
    issuedAt > now + secondsToMs(60) ||
    (typeof claims.nbf === "number" && (secondsToMs(claims.nbf) > now + secondsToMs(60) || claims.nbf >= claims.exp))
  )
    return null;
  return { issuedAt, expiresAt };
}
