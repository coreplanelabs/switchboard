import type { RunState } from "./types.js";

export const ORGANIZATION_RESUME_HOLD_REASONS = [
  "source_not_verified",
  "source_check_failed",
  "recovery_read_failed",
  "source_ineligible",
  "intake_completed",
  "stop_pending",
] as const;

export type OrganizationResumeHoldReason = (typeof ORGANIZATION_RESUME_HOLD_REASONS)[number];

export function isOrganizationResumeHoldReason(value: unknown): value is OrganizationResumeHoldReason {
  return typeof value === "string" && (ORGANIZATION_RESUME_HOLD_REASONS as readonly string[]).includes(value);
}

/** A released marker stays on the row so a late, older hold write cannot restore it. */
export interface OrganizationResumeHold {
  version: 1;
  revision: number;
  status: "held" | "released";
  reason: OrganizationResumeHoldReason;
  since: number;
  attempts: number;
  nextCheckAt: number;
}

export function organizationResumeHoldOf(state: RunState): OrganizationResumeHold | undefined {
  const value = state.organizationResumeHold;
  if (typeof value !== "object" || value === null) return;
  const hold = value as Record<string, unknown>;
  if (
    hold.version !== 1 ||
    !Number.isSafeInteger(hold.revision) ||
    (hold.revision as number) < 1 ||
    (hold.status !== "held" && hold.status !== "released") ||
    !isOrganizationResumeHoldReason(hold.reason) ||
    typeof hold.since !== "number" ||
    !Number.isFinite(hold.since) ||
    !Number.isSafeInteger(hold.attempts) ||
    (hold.attempts as number) < 1 ||
    typeof hold.nextCheckAt !== "number" ||
    !Number.isFinite(hold.nextCheckAt)
  )
    return;
  return hold as unknown as OrganizationResumeHold;
}
