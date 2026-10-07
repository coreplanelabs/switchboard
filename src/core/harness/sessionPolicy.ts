import type { Identity } from "../../agents/registry.js";

/** The original launcher's logical command route, not a native table or
 * physical custody attestation. Absence remains unknown legacy evidence. */
export interface OriginalSessionPolicy {
  version: 1;
  commandRoute: "native" | "hosted-review";
  identity: Identity;
}

export function originalSessionPolicyOf(value: unknown): OriginalSessionPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 3 ||
    !["version", "commandRoute", "identity"].every((key) => Object.hasOwn(v, key)) ||
    v.version !== 1 ||
    (v.commandRoute !== "native" && v.commandRoute !== "hosted-review") ||
    (v.identity !== "none" && v.identity !== "read" && v.identity !== "write") ||
    (v.commandRoute === "hosted-review" && v.identity !== "read")
  )
    return undefined;
  return { version: 1, commandRoute: v.commandRoute, identity: v.identity };
}

/** Unknown or malformed originals do not become equal through normalization. */
export function sameOriginalSessionPolicy(a: unknown, b: unknown): boolean {
  const first = originalSessionPolicyOf(a);
  const second = originalSessionPolicyOf(b);
  return (
    first !== undefined &&
    second !== undefined &&
    first.commandRoute === second.commandRoute &&
    first.identity === second.identity
  );
}
