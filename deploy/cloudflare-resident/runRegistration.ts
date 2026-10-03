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
  if (ownerFence !== undefined && registration.ownerFence !== undefined)
    return (
      ownerFence > registration.ownerFence ||
      (ownerFence === registration.ownerFence && registration.runId === runId && registration.ownerGen === ownerGen)
    );
  if (registration.ownerFence !== undefined) return false;
  if (ownerFence !== undefined) return true; // first ledger-backed claim over a legacy row
  return registration.runId === runId && registration.ownerGen === ownerGen;
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
  return (
    registration !== undefined &&
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
    if (
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
    return { state: "retained", category: "legacy", reason: "protection-elapsed" };
  }
  const state = deployRegistrationState(input);
  if (state === "none") return { state, category: "none", reason: "no-registration" };
  if (state === "unknown")
    return {
      state,
      category: "unknown",
      reason:
        hasOwnerFields &&
        (!registration?.runId || !registration.ownerGen || !Number.isSafeInteger(registration.ownerFence))
          ? "malformed-registration"
          : "owner-unverified",
    };
  return { state, category: "owned", reason: state === "executing" ? "live-owner" : "terminal-owner" };
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
    !registration?.runId ||
    !registration.ownerGen ||
    !Number.isSafeInteger(registration.ownerFence) ||
    Number(registration.ownerFence) < 0 ||
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
