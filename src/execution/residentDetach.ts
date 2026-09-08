/** The force-detach decision of the resident Worker's `detachThread`
 *  (deploy/cloudflare-resident/worker.ts), kept pure and dependency-free so
 *  it is unit-testable from src/ and imported across packages by the resident
 *  Worker (like shellQuote) — the tested code IS the shipped code.
 *
 *  Background: a hard stop makes the bot drop its `/exec` fetch
 *  and call `/detach {force:true}`, but the command keeps running in the
 *  container, so a busy guard alone would keep the pool user until the hourly
 *  sweep. Force therefore kills the thread's processes first; a non-force
 *  detach keeps the plain busy guard (never yank a tree from under a live
 *  command a concurrent run still cares about). */

export type ForceDetachPlan =
  /** Nothing in flight — go straight to the eviction path. */
  | { action: "proceed" }
  /** Kept; `reason` is what the caller reports. */
  | { action: "refuse"; reason: string }
  /** Kill every process owned by `user`, then wait for the in-flight count to drain. */
  | { action: "kill"; user: string; inFlight: number };

export function planForceDetach(input: {
  force: boolean;
  inFlight: number;
  /** The binding's pool user. */
  user: string;
  /** The Worker's pool (`THREAD_USERS`): the only users a kill may target. */
  poolUsers: readonly string[];
}): ForceDetachPlan {
  const { force, inFlight, user, poolUsers } = input;
  if (inFlight <= 0) return { action: "proceed" };
  if (!force) return { action: "refuse", reason: busyReason(inFlight) };
  // The kill runs `kill -9 -1` as this user — it must be a pool user and
  // nothing else (never root, never empty, never the build user), or the
  // blast radius is the whole container.
  if (!user || !poolUsers.includes(user)) {
    return { action: "refuse", reason: `${busyReason(inFlight)}; refusing to kill: "${user}" is not a pool user` };
  }
  return { action: "kill", user, inFlight };
}

export function busyReason(inFlight: number): string {
  return `busy: ${inFlight} operation(s) in flight on this thread — kept`;
}

/** After the kill, the in-flight count did not drain within the bound. */
export function busyAfterKillReason(inFlight: number): string {
  return `busy after kill: ${inFlight} op(s) still in flight — kept`;
}
