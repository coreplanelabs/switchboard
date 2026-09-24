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
  private readonly reservations = new Map<string, symbol>();
  private readonly localRecoveredInstances = new Set<string>();
  private recoveryComplete: boolean;

  constructor(requiresRecovery: boolean) {
    this.recoveryComplete = !requiresRecovery;
  }

  /** Claim without displacing a different live runner. The read and write are
   * synchronous, so a caller owns the process-local fence before its next
   * awaited durable transition. Repeating the same owner's claim is idempotent. */
  claim(repo: string, prNumber: number, owner?: RunnerPullOwner): boolean {
    const key = runnerOwnedPullKey(repo, prNumber);
    const current = this.claimedOwners.get(key) ?? this.recoveredOwners.get(key);
    const alreadyOwned = this.claimed.has(key) || this.recovered.has(key);
    if (this.reservations.has(key)) return false;
    if (
      alreadyOwned &&
      (owner === undefined ||
        current === undefined ||
        current.instanceId !== owner.instanceId ||
        current.unit !== owner.unit)
    )
      return false;
    this.claimed.add(key);
    if (owner !== undefined) this.claimedOwners.set(key, owner);
    return true;
  }

  /** Exclusively reserve an unowned pull request across an awaited durable
   * transition. Even the same runner identity cannot reserve it twice: the
   * returned token, not the owner fields, identifies the one caller. */
  reserve(repo: string, prNumber: number, owner: RunnerPullOwner): symbol | undefined {
    const key = runnerOwnedPullKey(repo, prNumber);
    if (this.claimed.has(key) || this.recovered.has(key) || this.reservations.has(key)) return undefined;
    const token = Symbol(key);
    this.reservations.set(key, token);
    this.claimed.add(key);
    this.claimedOwners.set(key, owner);
    return token;
  }

  /** Move an exclusive recovery reservation to the durable attempt that is
   * about to start. Both the unforgeable token and the currently recorded
   * owner must still match; a stale caller can neither displace nor adopt a
   * successor. The transfer consumes the reservation but retains ownership. */
  transferReservation(
    repo: string,
    prNumber: number,
    token: symbol,
    currentOwner: RunnerPullOwner,
    nextOwner: RunnerPullOwner,
  ): boolean {
    const key = runnerOwnedPullKey(repo, prNumber);
    const current = this.claimedOwners.get(key);
    if (
      this.reservations.get(key) !== token ||
      !this.claimed.has(key) ||
      current?.instanceId !== currentOwner.instanceId ||
      current.unit !== currentOwner.unit
    )
      return false;
    this.reservations.delete(key);
    this.claimedOwners.set(key, nextOwner);
    return true;
  }

  releaseReservation(repo: string, prNumber: number, token: symbol): boolean {
    const key = runnerOwnedPullKey(repo, prNumber);
    if (this.reservations.get(key) !== token) return false;
    this.reservations.delete(key);
    this.claimed.delete(key);
    this.claimedOwners.delete(key);
    return true;
  }

  /** Release unconditionally for the runner's ordinary end, or conditionally
   * for a provisional claim whose cleanup must not erase a successor. */
  release(repo: string, prNumber: number, owner?: RunnerPullOwner): boolean {
    const key = runnerOwnedPullKey(repo, prNumber);
    if (owner !== undefined) {
      const current = this.claimedOwners.get(key) ?? this.recoveredOwners.get(key);
      if (current?.instanceId !== owner.instanceId || current.unit !== owner.unit) return false;
    }
    this.reservations.delete(key);
    this.claimed.delete(key);
    this.recovered.delete(key);
    this.claimedOwners.delete(key);
    this.recoveredOwners.delete(key);
    return true;
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
