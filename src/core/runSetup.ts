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

/** What the run's repository and profile asked for. */
export type SetupRequested = "resident" | "cold" | "blank";

/** How a sandbox that stood in for a resident was filled. */
export type SetupSeeding = "snapshot" | "fresh_no_snapshot" | "fresh_after_seed_failure";

/** The run's **setup result** (record 0097): what workspace the run asked
 *  for and why it did not get it, written whenever the run asked for one.
 *  `WorkspaceBinding` stays the executor a resume consults; this says what a
 *  run with no workspace still has to say. Never derived from note text. */
export interface RunSetup {
  version: 1;
  requested: SetupRequested;
  /** Set only with a fallback word: the sandbox stood in for a resident. */
  seeding?: SetupSeeding;
  /** The resident was attached after the bot held its restore wait. */
  restored?: true;
  /** A fallback word (a sandbox for a requested resident) or a lost word (no workspace). */
  reason?: FallbackWord | LostWord;
  /** A same-id successor replaced the workspace after reattach was refused. */
  reallocated?: true;
  /** The per-thread backend when it is not the Cloudflare sandbox (a local
   *  or E2B deployment), so a workspace word never reads as a sandbox it was
   *  not; absent for the Cloudflare sandbox and the resident. */
  backend?: "local" | "e2b";
}

const SETUP_KEYS = ["version", "requested", "seeding", "restored", "reason", "reallocated", "backend"];

/** What a run's machine class asks for, read where the factory reads it: a
 *  `repo-resident` run asks for a resident only with a repository and a
 *  configured resident backend, otherwise for the cold sandbox it gets by
 *  configuration, not by fallback. A run with no machine asks for nothing. */
export function requestedWorkspaceOf(
  machine: string,
  repo: string | undefined,
  residentConfigured: boolean,
): SetupRequested | undefined {
  if (machine === "none") return undefined;
  if (machine === "blank") return "blank";
  if (machine === "repo-resident" && repo && residentConfigured) return "resident";
  return "cold";
}

/** One decoder for the ledger row, the recovered state and the stored record:
 *  a known shape whose fields agree with each other (record 0097's
 *  invariants), else undefined. */
export function runSetupOf(value: unknown): RunSetup | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || Object.keys(v).some((k) => !SETUP_KEYS.includes(k))) return undefined;
  if (v.requested !== "resident" && v.requested !== "cold" && v.requested !== "blank") return undefined;
  if (v.restored !== undefined && v.restored !== true) return undefined;
  if (v.reallocated !== undefined && v.reallocated !== true) return undefined;
  const fallback = typeof v.reason === "string" && (FALLBACK_WORDS as readonly string[]).includes(v.reason);
  const lost = typeof v.reason === "string" && (LOST_WORDS as readonly string[]).includes(v.reason);
  if (v.reason !== undefined && !fallback && !lost) return undefined;
  // A fallback word means a sandbox stood in for a requested resident.
  if (fallback && v.requested !== "resident") return undefined;
  if (v.seeding !== undefined) {
    if (!["snapshot", "fresh_no_snapshot", "fresh_after_seed_failure"].includes(v.seeding as string)) return undefined;
    if (!fallback) return undefined;
  }
  // A restore wait leads to a resident binding: no reason or other backend beside it.
  if (v.restored === true && (v.reason !== undefined || v.requested !== "resident" || v.backend !== undefined))
    return undefined;
  if (v.backend !== undefined && v.backend !== "local" && v.backend !== "e2b") return undefined;
  return {
    version: 1,
    requested: v.requested,
    ...(v.seeding !== undefined ? { seeding: v.seeding as SetupSeeding } : {}),
    ...(v.restored === true ? { restored: true as const } : {}),
    ...(v.reason !== undefined ? { reason: v.reason as FallbackWord | LostWord } : {}),
    ...(v.reallocated === true ? { reallocated: true as const } : {}),
    ...(v.backend !== undefined ? { backend: v.backend as "local" | "e2b" } : {}),
  };
}

/** Whether a setup word is a lost word: the run got no workspace. */
export function isLostWord(word: FallbackWord | LostWord | undefined): word is LostWord {
  return word !== undefined && (LOST_WORDS as readonly string[]).includes(word);
}

/** The setup result a same-id successor claims with (record 0097): its own
 *  allocation's result, marked `reallocated` when the claim restarts a run
 *  whose workspace could not be re-attached. */
export function reallocatedSetup(setup: RunSetup | undefined, restartOf: string | undefined): RunSetup | undefined {
  return setup !== undefined && restartOf !== undefined ? { ...setup, reallocated: true } : setup;
}
