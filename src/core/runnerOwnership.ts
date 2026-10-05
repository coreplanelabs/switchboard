// Routing reads the canonical durable owner; it neither caches ownership nor
// grants publication authority. Writes use the original unit and effect CAS.

import type { CoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import { isPullOwnersResult, type PullOwnersResult } from "./coordinator/pullOwnership.js";

/** The original durable unit, including its exact recovery action when present. */
export interface RunnerPullOwner {
  instanceId: string;
  unit: string;
  /** The durable action distinguishes successive recoveries of the same unit. */
  recoveryActionId?: string;
}

export type RunnerPullOwnerResult = { ok: true; owner?: RunnerPullOwner } | Extract<PullOwnersResult, { ok: false }>;

/** A read can route outside input, never reserve a pull or authorize a write. */
export function runnerPullOwnerOf(result: unknown): RunnerPullOwnerResult {
  if (!isPullOwnersResult(result)) return { ok: false, reason: "unavailable" };
  if (!result.ok) return result;
  if (result.owners.length === 0) return { ok: true };
  const owner = result.owners[0];
  if (result.owners.length !== 1 || owner?.kind !== "unit") return { ok: false, reason: "incomplete" };
  return {
    ok: true,
    owner: {
      instanceId: owner.instanceId,
      unit: owner.unit,
      ...(owner.actionId === undefined ? {} : { recoveryActionId: owner.actionId }),
    },
  };
}

/** Every request reads the existing canonical owner, including unhosted units
 * and unresolved effects retained after an ending or process restart. */
export async function findRunnerPullOwner(
  instances: Pick<CoordinatorInstanceStore, "findPullOwners">,
  repo: string,
  prNumber: number,
): Promise<RunnerPullOwnerResult> {
  try {
    return runnerPullOwnerOf(await instances.findPullOwners({ repo, pr: prNumber }));
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
