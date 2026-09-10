/** The resident's incarnation id and the durable leases judged against it
 *  (docs/reference/specs/resident-repos.md item 22), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker like residentRefresh — the tested code IS the shipped code.
 *
 *  Background: the mirror mutex was a promise chain in the Durable Object's
 *  memory, and so were the facts the watchdog read to tell a cycle in flight
 *  from a marker orphaned by a dead one (`refreshing` with nothing running).
 *  An isolate swap — a Worker deploy, a platform restart — drops both: the
 *  chain resolves as if nothing were held while the holder's process keeps
 *  writing into the tree, and the in-flight counters read zero the instant a
 *  cycle is killed, so the watchdog could only guess from a timestamp.
 *
 *  Shape: an **incarnation id** is minted each time the object starts in a
 *  fresh isolate or its container runtime is replaced under it; nothing that
 *  incarnation held survives its end. A **lease** is a keyed document
 *  `{holder, incarnation, expiresAt, step}`: who holds what, from which
 *  incarnation, until when. One predicate judges every lease — dead when its
 *  incarnation is not the current one, or its expiry has passed — so a
 *  holder killed by a swap is taken over without waiting, and the expiry (the
 *  step's own budget) stays as the backstop for a holder that hung without a
 *  swap. The mirror mutex is one lease; the per-key dependency install is
 *  another; the in-flight row holds the two the watchdog reads. */

/** The mirror mutex row. */
export const MIRROR_MUTEX_KEY = "resident:mirrorMutex";
/** One key per in-flight fact the watchdog reads (the refresh cycle, the
 *  hydration), never one shared row: two chains inside one object interleave
 *  at any await, so a read-modify-write of a shared row can lose the other
 *  chain's write. A key per fact is a plain put and a plain delete. */
export const IN_FLIGHT_KEY_PREFIX = "resident:inFlight:";
export function inFlightKey(kind: keyof InFlightRow): string {
  return `${IN_FLIGHT_KEY_PREFIX}${kind}`;
}
/** One lease per lockfile key while its store entry is being produced. */
export const DEPS_LEASE_KEY_PREFIX = "resident:depsLease:";

/** A `refreshing`/`restoring` marker older than this with nothing running is
 *  an orphan from an interrupted cycle; the watchdog normalizes it. Comfortably
 *  above the longest legitimate cycle. A hydration's lease expires here too:
 *  no restore approaches it (the hydrate's own cap is 25 minutes). */
export const STALE_MIDFLIGHT_MS = 30 * 60_000;

/** How long a refresh cycle's in-flight lease lives. Every step in a cycle is
 *  budgeted and the budgets sum below this, so a lease still held past it is
 *  a hung call into a container that was replaced under it — the one state the
 *  in-memory counter could never expose, because it stayed non-zero for as
 *  long as the promise never settled. Above the stale bound on purpose: a
 *  cycle that is merely slow must never read as dead. */
export const REFRESH_CYCLE_LEASE_MS = 2 * STALE_MIDFLIGHT_MS;

export interface Lease {
  /** Unique per take (`<incarnation>:<sequence>`); what a release compares. */
  holder: string;
  incarnation: string;
  /** When the holder's budget ends. A lease past it is dead whoever holds it. */
  expiresAt: number;
  /** The engine step the holder runs, for the operator's eyes. */
  step: string;
  /** The directory the holder's command writes into, when it has one: a taker
   *  that finds this lease dead sweeps the tree before it starts. */
  tree?: string;
}

/** A random id per isolate start; the caller may pass its own source. */
export function mintIncarnationId(random: () => string = () => crypto.randomUUID()): string {
  return random();
}

/** Dead when the holder's incarnation is gone or its budget has passed. */
export function leaseIsDead(lease: Lease, now: number, incarnation: string): boolean {
  return lease.incarnation !== incarnation || lease.expiresAt < now;
}

export type MutexDecision =
  /** Write `row`; `dead` is the lease taken over, if any (its tree may need a sweep). */
  | { action: "take"; why: "free" | "holder-incarnation-gone" | "holder-expired"; row: Lease; dead: Lease | undefined }
  /** A live holder of this incarnation: wait, at most `remainingMs`, then read again. */
  | { action: "wait"; row: Lease; remainingMs: number };

/** Decide over the stored row whether `holder` may take the mutex now. Pure:
 *  the caller writes the returned row. */
export function takeMutex(
  row: Lease | undefined,
  now: number,
  incarnation: string,
  budgetMs: number,
  step: string,
  holder: string,
  tree?: string,
): MutexDecision {
  const next: Lease = { holder, incarnation, expiresAt: now + budgetMs, step, ...(tree ? { tree } : {}) };
  if (!row) return { action: "take", why: "free", row: next, dead: undefined };
  if (row.incarnation !== incarnation) return { action: "take", why: "holder-incarnation-gone", row: next, dead: row };
  if (row.expiresAt < now) return { action: "take", why: "holder-expired", row: next, dead: row };
  return { action: "wait", row, remainingMs: row.expiresAt - now };
}

/** A holder releases only the row it took: a row another holder took over
 *  (this one was judged dead meanwhile) is left in place. */
export function releaseMutex(
  row: Lease | undefined,
  holder: string,
): { released: true; row: undefined } | { released: false; row: Lease | undefined } {
  if (row && row.holder === holder) return { released: true, row: undefined };
  return { released: false, row };
}

export interface InFlightRow {
  refresh: Lease | null;
  hydration: Lease | null;
}

/** Assemble the row from the two documents `inFlightKey` names. */
export function inFlightRow(refresh: Lease | null | undefined, hydration: Lease | null | undefined): InFlightRow {
  return { refresh: refresh ?? null, hydration: hydration ?? null };
}

/** Which in-flight facts are alive for the current incarnation right now. */
export function liveInFlight(
  row: InFlightRow | undefined,
  now: number,
  incarnation: string,
): { refresh: boolean; hydration: boolean } {
  const live = (lease: Lease | null | undefined) => lease != null && !leaseIsDead(lease, now, incarnation);
  return { refresh: live(row?.refresh), hydration: live(row?.hydration) };
}

const LOCKFILE_KEY_RE = /^[0-9a-f]{64}$/;

export function depsLeaseKey(key: string): string {
  if (!LOCKFILE_KEY_RE.test(key)) throw new Error(`deps lease: not a lockfile key: ${JSON.stringify(key)}`);
  return `${DEPS_LEASE_KEY_PREFIX}${key}`;
}
