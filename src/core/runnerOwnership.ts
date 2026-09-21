// The pull-sweep fence for a live ship runner. The process-local claims make
// new work visible at once; boot recovery rebuilds the same keys from the
// durable coordinator rows of every hosted runner that survived the process.

import type { CoordinatorInstanceStore } from "./coordinator/instanceStore.js";

export const runnerOwnedPullKey = (repo: string, prNumber: number): string => `${repo}#${prNumber}`;

/** Rebuild the pull requests owned by the named live runner instances. A unit
 * owns its pull request until it has a real ending; idle and segment boundaries
 * deliberately keep `ending` absent and therefore keep ownership. */
export interface RunnerPullOwner {
  instanceId: string;
  unit: string;
}

export async function recoverRunnerOwnedPullOwners(
  instanceIds: Iterable<string>,
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits">,
): Promise<Map<string, RunnerPullOwner>> {
  const owned = new Map<string, RunnerPullOwner>();
  for (const instanceId of new Set(instanceIds)) {
    const instance = await instances.get(instanceId);
    if (instance === null) continue;
    for (const unit of await instances.listUnits(instanceId)) {
      if (unit.pr !== undefined && unit.ending === undefined)
        owned.set(runnerOwnedPullKey(instance.repo, unit.pr.number), { instanceId, unit: unit.unit });
    }
  }
  return owned;
}

export async function recoverRunnerOwnedPulls(
  instanceIds: Iterable<string>,
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits">,
): Promise<Set<string>> {
  return new Set((await recoverRunnerOwnedPullOwners(instanceIds, instances)).keys());
}

interface OwnershipRecoveryOutcome {
  liveListingComplete: boolean;
  liveHosted: readonly { instanceId: string; until: number }[];
  resumable: readonly { kind?: string; hosting?: { instanceId: string; until: number } }[];
  liveElsewhere: readonly { hosting?: { instanceId: string; until: number } }[];
}

/** The sweep's fail-closed ownership view. Process-local claims are available
 * immediately, but no read may answer "unowned" after a restart until the run
 * ledger has supplied one complete live listing and the durable unit rows have
 * been rebuilt from it. */
export class RunnerOwnershipFence {
  private readonly claimed = new Set<string>();
  private readonly recovered = new Set<string>();
  private readonly claimedOwners = new Map<string, RunnerPullOwner>();
  private readonly recoveredOwners = new Map<string, RunnerPullOwner>();
  private readonly localRecoveredInstances = new Set<string>();
  private recoveryComplete: boolean;

  constructor(requiresRecovery: boolean) {
    this.recoveryComplete = !requiresRecovery;
  }

  claim(repo: string, prNumber: number, owner?: RunnerPullOwner): void {
    const key = runnerOwnedPullKey(repo, prNumber);
    this.claimed.add(key);
    if (owner !== undefined) this.claimedOwners.set(key, owner);
  }

  release(repo: string, prNumber: number): void {
    const key = runnerOwnedPullKey(repo, prNumber);
    this.claimed.delete(key);
    this.recovered.delete(key);
    this.claimedOwners.delete(key);
    this.recoveredOwners.delete(key);
  }

  owns(repo: string, prNumber: number): boolean {
    if (!this.recoveryComplete) throw new Error("runner ownership recovery is still in progress");
    const key = runnerOwnedPullKey(repo, prNumber);
    return this.claimed.has(key) || this.recovered.has(key);
  }

  owner(repo: string, prNumber: number): RunnerPullOwner | undefined {
    if (!this.recoveryComplete) throw new Error("runner ownership recovery is still in progress");
    const key = runnerOwnedPullKey(repo, prNumber);
    return this.claimedOwners.get(key) ?? this.recoveredOwners.get(key);
  }

  async recover(
    outcome: OwnershipRecoveryOutcome,
    instances: Pick<CoordinatorInstanceStore, "get" | "listUnits">,
  ): Promise<void> {
    // A rehost is ours by the next listing, so remember its durable instance
    // even when this pass's listing failed. The next complete pass can then
    // rebuild ownership without needing the row to be reclaimed again.
    for (const run of outcome.resumable) {
      if (run.kind === "rehost" && run.hosting !== undefined) this.localRecoveredInstances.add(run.hosting.instanceId);
    }
    if (!outcome.liveListingComplete) return;

    // A complete ledger answer starts a fresh durable rebuild. Fence reads
    // across its awaits too; if the coordinator store fails, the next reclaim
    // pass must retry rather than serving the previous process view as current.
    this.recoveryComplete = false;
    const activeRunnerInstances = new Set(this.localRecoveredInstances);
    for (const hosting of outcome.liveHosted) activeRunnerInstances.add(hosting.instanceId);
    for (const run of outcome.liveElsewhere) {
      if (run.hosting !== undefined) activeRunnerInstances.add(run.hosting.instanceId);
    }
    const recovered = await recoverRunnerOwnedPullOwners(activeRunnerInstances, instances);
    this.recovered.clear();
    this.recoveredOwners.clear();
    for (const [key, owner] of recovered) {
      this.recovered.add(key);
      this.recoveredOwners.set(key, owner);
    }
    this.recoveryComplete = true;
  }
}
