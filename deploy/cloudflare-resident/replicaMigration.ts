import { parseSpentPoolUsers } from "../../src/execution/residentPoolSpends.js";
import { liveDrain } from "./drain.js";

export interface ReplicaMaintenanceFence {
  since: string;
  until: string;
  swapVersion: string;
  swapAt: string;
}

/** Activation borrows the existing post-upload reconciliation permit. A
 * timeout or a second admitted operation leaves the pool pending. */
export function replicaMaintenanceFence(
  storedDrain: unknown,
  admissions: ReadonlyMap<string, unknown>,
  admissionId: string,
  now: number,
  expected?: ReplicaMaintenanceFence,
): ReplicaMaintenanceFence | undefined {
  const drain = liveDrain(storedDrain, now);
  const permit = admissions.get(`deploy:admission:${admissionId}`);
  if (
    !drain?.swapFence ||
    !drain.swapVersion ||
    !drain.swapAt ||
    admissions.size !== 1 ||
    !permit ||
    typeof permit !== "object" ||
    (permit as { kind?: unknown }).kind !== "reconcile"
  )
    return undefined;
  if (
    expected &&
    (drain.since !== expected.since ||
      drain.until !== expected.until ||
      drain.swapVersion !== expected.swapVersion ||
      drain.swapAt !== expected.swapAt)
  )
    return undefined;
  return { since: drain.since, until: drain.until, swapVersion: drain.swapVersion, swapAt: drain.swapAt };
}

/** Include evicted bindings, run fences and UID ownership reservations. A
 * failed attach can have custody before it has a completed thread binding. */
export function placementHistoryThreads(rows: ReadonlyMap<string, unknown>): string[] {
  const threads = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-z]{1,32}:[A-Za-z0-9._:-]{1,128}$/.test(value))
      throw new Error("resident placement history could not be verified");
    threads.add(value);
  };
  for (const [key, value] of rows) {
    const prefix = ["thread:", "runReg:", "runFence:"].find((p) => key.startsWith(p));
    if (prefix) add(key.slice(prefix.length));
    else if (key.startsWith("uid:") && key.includes(":user:")) {
      if (typeof value !== "string") throw new Error("resident UID history could not be verified");
      if (value.startsWith("thread:")) add(value.slice("thread:".length));
    } else if (key.startsWith("uid:") && key.includes(":owner:")) {
      const owner = value && typeof value === "object" ? (value as { owner?: unknown }).owner : undefined;
      if (typeof owner !== "string") throw new Error("resident UID history could not be verified");
      if (owner.startsWith("thread:")) add(owner.slice("thread:".length));
    } else if (key === "resident:spentPoolUsers") {
      const legacy = parseSpentPoolUsers(value);
      if (!legacy) throw new Error("resident UID history could not be verified");
      for (const owner of legacy.values()) {
        if (owner.startsWith("thread:")) add(owner.slice("thread:".length));
      }
    }
  }
  return [...threads].sort();
}
