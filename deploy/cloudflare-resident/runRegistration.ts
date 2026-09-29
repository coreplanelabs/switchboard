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
