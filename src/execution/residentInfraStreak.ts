// A refresh cycle that keeps failing in the resident's OWN steps heals itself
// (docs/reference/specs/resident-repos.md item 67). Pure: the Worker's
// `refreshFailed` bumps the row and acts on the rung; the cycle's gate asks
// `parksOnRepeat` before it counts a degraded reason toward the park streak.
//
// The split this module draws: a step that runs the repository's own command
// (the onboard-time command table — install, build, test) failing is evidence
// about the repository, and the right response is to park and wait for the
// head to be fixed, which is what the park streak does. Every other step is
// the resident's machinery — git against the mirror, the probes, the markers,
// the restores — and a failure there that repeats is the container or the
// disk gone wrong, which a rebuild does fix. Item 64 already climbs this
// ladder for one signature (the control port that never answers); this is
// the same ladder for every other resident-step failure.

import { STALE_SWEEP_SUFFIX } from "./residentSteps.js";

/** The steps that run the repository's own commands. */
export const REPO_COMMAND_STEPS: ReadonlySet<string> = new Set(["deps-install", "build", "test"]);

/** Whether a failed step ran the repository's command (evidence about the
 *  repo) rather than the resident's own machinery. The stale-process sweep
 *  that precedes a repo step is ours. */
export function isRepoCommandStep(step: string): boolean {
  if (step.endsWith(STALE_SWEEP_SUFFIX)) return false;
  return REPO_COMMAND_STEPS.has(step);
}

/** The step named by a `<step>-failed:` reason (`classifyRefreshFailure`'s
 *  plain-failure shape), or null for every other reason. */
export function stepOfFailedReason(reason: string): string | null {
  const m = /^([a-z][a-z0-9-]*)-failed:/.exec(reason);
  return m ? m[1] : null;
}

/** Whether a repeated degraded reason should PARK the resident (the 6-hour
 *  cadence, `DEGRADED_PARK_AFTER_CYCLES`): only evidence about the repository
 *  or about GitHub — a repo-command step's failure, or a reason that names no
 *  step at all (`github-unreachable`). A resident-step failure never parks:
 *  the ladder below is its escalation, and parking would only slow it. */
export function parksOnRepeat(reason: string): boolean {
  const step = stepOfFailedReason(reason);
  return step === null || isRepoCommandStep(step);
}

/** The ladder's rungs: consecutive cycles failed in resident steps. */
export const INFRA_STREAK_RECREATE_AT = 3;
export const INFRA_STREAK_DOWN_AT = 5;

export type InfraStreakRung = "count" | "recreate" | "down";

/** Count 1–2: record and let the next cycle try. Count 3: destroy the
 *  container, snapshots kept — the next cycle restores from the snapshot onto
 *  a fresh disk (item 64's rung 3). Count 4: the recreated container's one
 *  cycle of its own. Count ≥ 5: a fresh container failed the same way; `down`
 *  with a rehydration-flavored reason, so item 36's transition rebuild is the
 *  exit. */
export function infraStreakRung(count: number): InfraStreakRung {
  if (!Number.isFinite(count) || count < 1) {
    throw new RangeError(`infra-streak rung needs a count of at least 1, got ${count}`);
  }
  if (count >= INFRA_STREAK_DOWN_AT) return "down";
  if (count === INFRA_STREAK_RECREATE_AT) return "recreate";
  return "count";
}

/** The persisted row (`resident:infraStreak`): the last failing step, the
 *  consecutive count and the span. */
export interface InfraStreakRow {
  step: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

const INFRA_STREAK_ACTION: Readonly<Record<Exclude<InfraStreakRung, "count">, string>> = {
  recreate: "the container was destroyed, snapshots kept; the next cycle restores from the snapshot",
  down: "a recreated container failed the same way; rebuilding",
};

/** The reason a rung records: `infra-streak:` so the gate, the serviceability
 *  check and item 36's eligibility all read it as the resident's, never the repo's. */
export function infraStreakReason(row: InfraStreakRow, rung: Exclude<InfraStreakRung, "count">): string {
  return `infra-streak: ${row.count} consecutive cycles failed in the resident's own steps (last: ${row.step}, since ${row.firstAt}) — ${INFRA_STREAK_ACTION[rung]}`;
}

export function isInfraStreakReason(reason: string): boolean {
  return /^infra-streak: /.test(reason);
}
