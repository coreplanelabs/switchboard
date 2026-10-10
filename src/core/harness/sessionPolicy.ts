import type { Identity } from "../../agents/registry.js";
import { HARNESS_NAMES, isHarnessName } from "./names.js";

/** Intent is recorded before a producer exists. Begun is irreversible: an
 * absent start receipt never authorizes another launch. */
export interface HarnessLaunchIntent {
  version: 1;
  harness: (typeof HARNESS_NAMES)[number];
  phase: "prepared" | "begun";
  ordinal: number;
  sessionPolicy: OriginalSessionPolicy;
}

export function commandRouteForLaunch(
  agent: string,
  identity: Identity,
  repo: string | undefined,
  checkout: string | undefined,
): OriginalSessionPolicy["commandRoute"] {
  return agent === "review" &&
    identity === "read" &&
    !!repo &&
    checkout !== undefined &&
    checkout.startsWith("/") &&
    checkout.length <= 4096 &&
    !/[\r\n\0]/.test(checkout)
    ? "hosted-review"
    : "native";
}

export function preparedHarnessLaunch(
  harness: (typeof HARNESS_NAMES)[number],
  identity: Identity,
  commandRoute: OriginalSessionPolicy["commandRoute"],
): HarnessLaunchIntent {
  return { version: 1, harness, phase: "prepared", ordinal: 0, sessionPolicy: { version: 1, commandRoute, identity } };
}

export function harnessLaunchIntentOf(value: unknown): HarnessLaunchIntent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 5 ||
    !["version", "harness", "phase", "ordinal", "sessionPolicy"].every((key) => Object.hasOwn(v, key))
  )
    return undefined;
  const sessionPolicy = originalSessionPolicyOf(v.sessionPolicy);
  if (
    v.version !== 1 ||
    !isHarnessName(v.harness) ||
    (v.phase !== "prepared" && v.phase !== "begun") ||
    !Number.isSafeInteger(v.ordinal) ||
    (v.ordinal as number) < 0 ||
    !sessionPolicy
  )
    return undefined;
  return { version: 1, harness: v.harness, phase: v.phase, ordinal: v.ordinal as number, sessionPolicy };
}

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
