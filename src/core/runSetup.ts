// The run's setup words (docs/decisions/0097-every-run-row-carries-its-outcome-and-workspace-and-the-review-dashboard-is-six-queries-over-them.md,
// "The workspace facts"): why a run that asked for a resident got a sandbox (a
// fallback word), and why a run got no workspace at all (a lost word). One
// list per set, shared by the resident Worker that names its refusal and the
// bot that records it, so neither side spells a word the other cannot read.
// Node-free like `runRecord.ts`: the Worker imports it.

/** Why a sandbox was used when a resident was requested: one word per resident
 *  refusal class or bot-side decision, and `fallback_other` for a refusal no
 *  word names yet. */
export const FALLBACK_WORDS = [
  "workload_full",
  "workload_unverified",
  "fleet_draining",
  "deploy_fence",
  "workspace_preserved",
  "settlement_pending",
  "recreate_in_progress",
  "image_stale",
  "memory_pressure",
  "owner_unverified",
  "attach_failed",
  "not_resident",
  "resident_unreachable",
  "restore_failed",
  "resident_not_serviceable",
  "reattach_refused",
  "fallback_other",
] as const;

/** Why a run got no workspace, and `lost_other` for a loss no word names yet. */
export const LOST_WORDS = [
  "sandbox_start_timeout",
  "stopped_in_drain",
  "resident_claim_error",
  "ref_unresolved",
  "registration_mismatch",
  "seed_claim_refused",
  "lost_other",
] as const;

export type FallbackWord = (typeof FALLBACK_WORDS)[number];
export type LostWord = (typeof LOST_WORDS)[number];

/** The fallback words the resident Worker itself answers as an attach
 *  refusal's `code`; the rest are decided by the bot (a probe it could not
 *  make, a restore it could not wait for, a registration without a resident). */
export const RESIDENT_REFUSAL_CODES = [
  "workload_full",
  "workload_unverified",
  "fleet_draining",
  "deploy_fence",
  "workspace_preserved",
  "settlement_pending",
  "recreate_in_progress",
  "image_stale",
  "memory_pressure",
  "owner_unverified",
  "attach_failed",
  "resident_not_serviceable",
] as const satisfies readonly FallbackWord[];

export type ResidentRefusalCode = (typeof RESIDENT_REFUSAL_CODES)[number];

/** The resident's `code` as the bot reads it off an attach answer: a code it
 *  knows, or `fallback_other` for an absent or unknown one — never a guess
 *  from the refusal's sentence, so the Worker and the bot deploy in either order. */
export function residentRefusalCodeOf(code: unknown): ResidentRefusalCode | "fallback_other" {
  return typeof code === "string" && (RESIDENT_REFUSAL_CODES as readonly string[]).includes(code)
    ? (code as ResidentRefusalCode)
    : "fallback_other";
}
