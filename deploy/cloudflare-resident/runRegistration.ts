import { parsePoolBindings, parseSpentPoolUsers } from "../../src/execution/residentPoolSpends.js";
import { isAcknowledgedWorkspaceOwner } from "../../src/core/workspaceSettlement.js";

export function validRunOwner(runId: unknown, ownerGen: unknown, ownerFence: unknown): boolean {
  return (
    typeof runId === "string" &&
    runId.length > 0 &&
    runId.length <= 128 &&
    typeof ownerGen === "string" &&
    ownerGen.length > 0 &&
    ownerGen.length <= 128 &&
    typeof ownerFence === "number" &&
    Number.isSafeInteger(ownerFence) &&
    ownerFence > 0
  );
}

/** A command is counted separately. Between commands, a registration protects
 * the run only through its budget or the sweep's inactivity boundary. */
export function registeredRunNeedsProtection(
  lastAttachAt: string | undefined,
  opInFlight: number,
  cutoff: number,
  deadlineAt?: number,
  now?: number,
): boolean {
  if (opInFlight > 0) return false; // the operation counter already covers it
  if (deadlineAt !== undefined && now !== undefined && Number.isSafeInteger(deadlineAt)) return now <= deadlineAt;
  const last = Date.parse(lastAttachAt ?? "");
  return !Number.isFinite(last) || last >= cutoff;
}

/** Only a provably live registration owned by this run can bypass the gates
 * that keep new work off a draining or stale resident. */
export function registeredRunAllowsClaim(
  registration: { runId?: string; ownerGen?: string; ownerFence?: number } | undefined,
  runId: string | undefined,
  ownerGen: string | undefined,
  ownerFence?: number,
): boolean {
  if (!registration) return true;
  // An own property with an undefined value is still persisted owner evidence.
  // Only a row with no owner fields at all is an ownerless legacy row.
  const hasOwner =
    Object.hasOwn(registration, "runId") ||
    Object.hasOwn(registration, "ownerGen") ||
    Object.hasOwn(registration, "ownerFence");
  if (hasOwner) {
    if (
      !validRunOwner(registration.runId, registration.ownerGen, registration.ownerFence) ||
      !validRunOwner(runId, ownerGen, ownerFence)
    )
      return false;
    return (
      ownerFence! > registration.ownerFence! ||
      (ownerFence === registration.ownerFence && registration.runId === runId && registration.ownerGen === ownerGen)
    );
  }
  return ownerFence !== undefined; // first ledger-backed claim over an ownerless legacy row
}

export function registeredRunAllowsReattach(
  registration: { runId?: string; ownerGen?: string; ownerFence?: number; deadlineAt?: number } | undefined,
  runId: string | undefined,
  now: number,
  graceMs: number,
  ownerGen?: string,
  ownerFence?: number,
): boolean {
  const deadlineAt = registration?.deadlineAt;
  return (
    runId !== undefined &&
    registration?.runId === runId &&
    registeredRunAllowsClaim(registration, runId, ownerGen, ownerFence) &&
    deadlineAt !== undefined &&
    Number.isSafeInteger(deadlineAt) &&
    now <= deadlineAt + graceMs
  );
}

/** A release may affect only the registration opened by its run. Legacy
 * callers may release legacy registrations, but cannot release a named run. */
export function registeredRunOwnsRelease(
  registration: { runId?: string; ownerGen?: string; ownerFence?: number } | undefined,
  runId: string | undefined,
  ownerGen?: string,
  ownerFence?: number,
): boolean {
  if (!registration) return false;
  const hasOwner =
    Object.hasOwn(registration, "runId") ||
    Object.hasOwn(registration, "ownerGen") ||
    Object.hasOwn(registration, "ownerFence");
  if (!hasOwner) return runId === undefined && ownerGen === undefined && ownerFence === undefined;
  return (
    validRunOwner(registration.runId, registration.ownerGen, registration.ownerFence) &&
    validRunOwner(runId, ownerGen, ownerFence) &&
    registration.runId === runId &&
    registration.ownerGen === ownerGen &&
    registration.ownerFence === ownerFence
  );
}

/** Read-only deploy classification. Category and reason are fixed vocabulary:
 * the fenced live view can explain a legacy row without exposing its owner. */
export function classifyDeployRegistration(input: {
  threadKey: string;
  registration:
    | {
        threadKey: string;
        registeredAt?: string;
        deadlineAt?: number;
        runId?: string;
        ownerGen?: string;
        ownerFence?: number;
        legacyRetainedAt?: number;
      }
    | undefined;
  fence: unknown;
  lastRunOwner?: { runId?: string; ownerGen?: string; ownerFence?: number } | null;
  owner: unknown;
  lastAttachAt?: string;
  cutoff: number;
  now: number;
  graceMs: number;
  opInFlight: number;
}): {
  state: "none" | "executing" | "retained" | "unknown";
  category: "none" | "legacy" | "owned" | "unknown";
  reason: string;
} {
  const { registration, threadKey, fence, lastRunOwner, owner } = input;
  if (
    registration !== undefined &&
    (typeof registration !== "object" || registration === null || Array.isArray(registration))
  )
    return { state: "unknown", category: "unknown", reason: "malformed-registration" };
  const hasOwnerFields =
    registration !== undefined &&
    (Object.hasOwn(registration, "runId") ||
      Object.hasOwn(registration, "ownerGen") ||
      Object.hasOwn(registration, "ownerFence"));
  if (registration && !hasOwnerFields) {
    const deadlineAt = registration.deadlineAt;
    const hasLegacyMarker = Object.hasOwn(registration, "legacyRetainedAt");
    const legacyRetainedAt = registration.legacyRetainedAt;
    if (
      (hasLegacyMarker &&
        (typeof legacyRetainedAt !== "number" ||
          !Number.isSafeInteger(legacyRetainedAt) ||
          legacyRetainedAt > input.now)) ||
      registration.threadKey !== threadKey ||
      typeof registration.registeredAt !== "string" ||
      !Number.isFinite(Date.parse(registration.registeredAt)) ||
      Date.parse(registration.registeredAt) > input.now ||
      (deadlineAt !== undefined &&
        (!Number.isSafeInteger(deadlineAt) ||
          deadlineAt < Date.parse(registration.registeredAt) ||
          !Number.isSafeInteger(deadlineAt + input.graceMs)))
    )
      return { state: "unknown", category: "unknown", reason: "malformed-registration" };
    if (fence !== undefined || lastRunOwner != null || owner != null)
      return { state: "unknown", category: "unknown", reason: "owner-unverified" };
    if (input.opInFlight > 0) return { state: "executing", category: "legacy", reason: "operation-active" };
    if (
      registeredRunNeedsProtection(
        input.lastAttachAt,
        0,
        input.cutoff,
        deadlineAt === undefined ? undefined : deadlineAt + input.graceMs,
        input.now,
      )
    )
      return { state: "unknown", category: "legacy", reason: "legacy-protected" };
    return {
      state: "retained",
      category: "legacy",
      reason: registration.legacyRetainedAt === undefined ? "protection-elapsed" : "legacy-reconciled",
    };
  }
  const state = deployRegistrationState(input);
  if (state === "none") return { state, category: "none", reason: "no-registration" };
  if (state === "unknown")
    return {
      state,
      category: "unknown",
      reason:
        hasOwnerFields && !validRunOwner(registration?.runId, registration?.ownerGen, registration?.ownerFence)
          ? "malformed-registration"
          : "owner-unverified",
    };
  return { state, category: "owned", reason: state === "executing" ? "live-owner" : "terminal-owner" };
}

/** Deploy cannot call a terminal registration safe while its UID still lacks
 * the spent-ownership row needed to protect the retained private tree. */
export function classifyDeployRegistrationWithLedger(
  input: Parameters<typeof classifyDeployRegistration>[0] & {
    user: string;
    claimants: unknown;
    ledger: unknown;
    pool: readonly string[];
  },
): ReturnType<typeof classifyDeployRegistration> {
  const result = classifyDeployRegistration(input);
  if (result.state !== "retained") return result;
  const claimants = parsePoolBindings(input.claimants);
  if (!claimants || claimants.length !== 1 || claimants[0] !== input.threadKey)
    return { state: "unknown", category: "unknown", reason: "binding-conflict" };
  const spent = parseSpentPoolUsers(input.ledger, input.pool);
  if (!spent || spent.get(input.user) !== `thread:${input.threadKey}`)
    return { state: "unknown", category: "unknown", reason: "ledger-unverified" };
  return result;
}

/** A single retained binding can acquire missing durable evidence without
 * ever changing its user or treating an unidentified run as a named owner.
 * All refusal reasons are fixed vocabulary suitable for grouped readback. */
export function decideOwnerReconciliation(input: {
  binding: { threadKey: string; user: string; lastAttachAt?: string };
  registration: unknown;
  fence: unknown;
  lastRunOwner: unknown;
  owner: unknown;
  ledger: unknown;
  claimants: unknown;
  pool: readonly string[];
  now: number;
  cutoff: number;
  graceMs: number;
  opInFlight: number;
}): { action: "migrate" | "current"; legacy: boolean; spend: boolean } | { action: "refuse"; reason: string } {
  const refuse = (reason: string) => ({ action: "refuse" as const, reason });
  const { binding, registration } = input;
  if (!binding.threadKey || !input.pool.includes(binding.user)) return refuse("binding-invalid");
  const claimants = parsePoolBindings(input.claimants);
  if (!claimants || claimants.length !== 1 || claimants[0] !== binding.threadKey) return refuse("binding-conflict");
  const ledger = parseSpentPoolUsers(input.ledger, input.pool);
  if (!ledger) return refuse("ledger-unreadable");
  const prior = ledger.get(binding.user);
  if (prior && prior !== `thread:${binding.threadKey}`) return refuse("ledger-conflict");
  if (input.opInFlight > 0) return refuse("owner-active");
  if (!registration || typeof registration !== "object" || Array.isArray(registration))
    return refuse("registration-unreadable");
  const row = registration as Record<string, unknown>;
  if (row.threadKey !== binding.threadKey) return refuse("registration-mismatch");
  if (input.owner && typeof input.owner === "object" && (input.owner as { kind?: unknown }).kind === "live")
    return refuse("owner-active");
  const result = classifyDeployRegistration({
    threadKey: binding.threadKey,
    registration: row as { threadKey: string },
    fence: input.fence,
    lastRunOwner: input.lastRunOwner as { runId?: string } | null,
    owner: input.owner,
    lastAttachAt: binding.lastAttachAt,
    cutoff: input.cutoff,
    now: input.now,
    graceMs: input.graceMs,
    opInFlight: input.opInFlight,
  });
  if (result.state !== "retained")
    return refuse(result.reason === "legacy-protected" ? "owner-protected" : "owner-unverified");
  const legacy = result.category === "legacy";
  // A migrated marker is valid only for a positively elapsed, ownerless row.
  const marked = Object.hasOwn(row, "legacyRetainedAt");
  if (!legacy && marked) return refuse("registration-mismatch");
  const spend = prior === undefined;
  return {
    action: (legacy && !marked) || spend ? "migrate" : "current",
    legacy: legacy && !marked,
    spend,
  };
}

/** A retained workspace is not an executing run. Unknown ownership still
 * refuses a deploy; this decision never authorizes removal of the binding. */
export function deployRegistrationState(input: {
  threadKey: string;
  registration: { threadKey: string; runId?: string; ownerGen?: string; ownerFence?: number } | undefined;
  fence: unknown;
  lastRunOwner?: { runId?: string; ownerGen?: string; ownerFence?: number } | null;
  owner: unknown;
}): "none" | "executing" | "retained" | "unknown" {
  const { threadKey, registration, fence, lastRunOwner, owner } = input;
  if (!registration && fence === undefined && !lastRunOwner) return "none"; // legacy idle binding, no run claim
  if (
    !registration ||
    !validRunOwner(registration.runId, registration.ownerGen, registration.ownerFence) ||
    registration.threadKey !== threadKey ||
    typeof fence !== "object" ||
    fence === null
  )
    return "unknown";
  const f = fence as Record<string, unknown>;
  if (
    f.runId !== registration.runId ||
    f.ownerGen !== registration.ownerGen ||
    f.ownerFence !== registration.ownerFence
  )
    return "unknown";
  if (typeof owner !== "object" || owner === null) return "unknown";
  const observed = owner as Record<string, unknown>;
  if (observed.kind === "live") {
    const row = observed.row;
    if (typeof row !== "object" || row === null) return "unknown";
    const r = row as Record<string, unknown>;
    return r.runId === registration.runId && r.threadKey === threadKey && r.ownerGen === registration.ownerGen
      ? "executing"
      : "unknown";
  }
  if (
    isAcknowledgedWorkspaceOwner(observed, {
      runId: registration.runId!,
      ownerGen: registration.ownerGen!,
      ownerFence: registration.ownerFence!,
    })
  )
    return "retained";
  if (observed.kind !== "terminal") return "unknown";
  const row = observed.record;
  if (typeof row !== "object" || row === null) return "unknown";
  const r = row as Record<string, unknown>;
  return r.id === registration.runId &&
    r.threadKey === threadKey &&
    r.provisional !== true &&
    ["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"].includes(String(r.status))
    ? "retained"
    : "unknown";
}
