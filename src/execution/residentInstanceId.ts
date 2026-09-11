/** The refresh cycle as a cron-created Workflow instance — the id scheme, the
 *  per-resident lifecycle row and the cron's decision to create one
 *  (docs/reference/specs/resident-repos.md item 7), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker like residentRefresh — the tested code IS the shipped code.
 *
 *  Background: the refresh cycle used to be driven by a self-rearming alarm
 *  chain, and every failure between two re-arms ended the chain silently; a
 *  watchdog guessed from a timestamp. A Cloudflare Workflow instance is the
 *  durable fact the chain lacked: the engine records that a sequence is in
 *  progress and which step it reached, retries a failed step on a policy,
 *  and shows a failed instance by name. The port ran behind a per-resident
 *  flag for one release; the chain is gone now and Workflows is the one
 *  scheduler, so every row reads `workflow` whatever it stores.
 *
 *  Shape: a cycle is one SHORT instance, not a loop — the resident Worker's
 *  existing ten-minute cron creates one per eligible resident with a
 *  deterministic id per resident and ten-minute bucket, so a second firing in
 *  the same bucket is refused as a duplicate id and cycles stay serialized
 *  per resident. (A perpetual instance that slept between cycles was
 *  rejected by arithmetic: five steps every 600 s reaches the engine's
 *  10,000-step instance cap in about two weeks.) */

import { STALE_MIDFLIGHT_MS } from "./residentIncarnation.js";
import type { ResidentLifecycleState } from "./residentState.js";

// -- the lifecycle row ---------------------------------------------------------

/** Which scheduler drives a resident's refresh cycle: there is one. The row
 *  survives from the flagged rollout so `/status` can say so; an `alarm` value
 *  a flip left behind names a chain that no longer exists. */
export type ResidentLifecycle = "workflow";

export const DEFAULT_LIFECYCLE: ResidentLifecycle = "workflow";

export function parseLifecycle(value: unknown): ResidentLifecycle | undefined {
  return value === "workflow" ? value : undefined;
}

/** What a stored row means: `workflow`, whatever it says. */
export function lifecycleOf(stored: unknown): ResidentLifecycle {
  return parseLifecycle(stored) ?? DEFAULT_LIFECYCLE;
}

// -- the id ------------------------------------------------------------------

/** One bucket per cron firing: the resident cron fires every ten minutes. */
export const REFRESH_BUCKET_MS = 10 * 60_000;

/** The platform's instance id rule (Workflows limits: "Instance ID: 100
 *  characters", pattern `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`). */
export const INSTANCE_ID_MAX_LENGTH = 100;
export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

const ID_PREFIX = "refresh_";
const HASH_LENGTH = 8;

export function refreshBucket(atMs: number): number {
  return Math.floor(atMs / REFRESH_BUCKET_MS);
}

/** Owner and name lower-cased, every character outside `[A-Za-z0-9_-]` mapped
 *  to `-`, joined by `-` (the `/` between them is one such character). */
export function instanceSlug(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/** FNV-1a over the slug, as 8 hex digits: enough to tell two long names apart
 *  once the id has to be truncated, and pure (no async digest). */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(HASH_LENGTH, "0");
}

/** `refresh_<slug>_<bucket>`; when that would exceed the platform's length
 *  the slug is cut and a short hash of the whole slug is inserted before the
 *  bucket, so the id stays deterministic, legal and distinct per resident. */
export function refreshInstanceId(owner: string, name: string, atMs: number): string {
  const slug = instanceSlug(owner, name);
  const bucket = String(refreshBucket(atMs));
  const plain = `${ID_PREFIX}${slug}_${bucket}`;
  if (plain.length <= INSTANCE_ID_MAX_LENGTH) return plain;
  const hash = shortHash(slug);
  const keep = INSTANCE_ID_MAX_LENGTH - (ID_PREFIX.length + 1 + hash.length + 1 + bucket.length);
  return `${ID_PREFIX}${slug.slice(0, keep)}_${hash}_${bucket}`;
}

// -- the cron's decision -----------------------------------------------------

/** What the cron reads about one resident before creating its instance. */
export interface RefreshRow {
  state: ResidentLifecycleState;
  /** When the state last changed (epoch ms); null when the row never recorded one. */
  updatedAt: number | null;
  /** Set while the resident is idle (epoch ms), the way the facts record it. */
  idleSince: number | null;
  /** When the cron last created an instance for this resident (epoch ms). */
  lastInstanceAt: number | null;
  /** Whether the instance the row last recorded is still alive in the engine
   *  (queued, running, paused or waiting), read from the engine's own status.
   *  A step between retry attempts holds no lease and writes no state, so the
   *  marker's age alone would call a live cycle stale; the engine knows. */
  instanceRunning: boolean;
}

export interface RefreshCadence {
  /** The awake cadence (REFRESH_INTERVAL_S). */
  intervalS: number;
  /** The idle cadence (IDLE_REFRESH_INTERVAL_S). */
  idleIntervalS: number;
}

/** Why no cycle may start for a row right now, or null when one may: the
 *  resident is not serving (`onboarding` is provisioning's, `down` is a
 *  rebuild's); the engine still runs the last instance; or a `refreshing`
 *  marker younger than the stale bound says a cycle is live (an older one is
 *  an orphan the next cycle normalizes, exactly as the watchdog judges it).
 *  Shared by the cron's decision and the admin `refresh-now` op, which
 *  starts a cycle whether or not one is due but never beside a live one. */
export function refreshCycleBlocked(row: RefreshRow, nowMs: number): "not-serving" | "running" | "mid-cycle" | null {
  if (row.state === "onboarding" || row.state === "down") return "not-serving";
  if (row.instanceRunning) return "running";
  if (row.state === "refreshing" && row.updatedAt !== null && nowMs - row.updatedAt <= STALE_MIDFLIGHT_MS) {
    return "mid-cycle";
  }
  return null;
}

export type InstanceDecision =
  { create: true; why: "due" } | { create: false; why: "not-serving" | "mid-cycle" | "not-due" | "running" };

/** Create an instance only for a row no live cycle blocks (`refreshCycleBlocked`)
 *  whose cadence has elapsed since the last instance — counted in whole
 *  buckets so cron jitter never skips a due bucket: the awake cadence is one
 *  bucket, the idle cadence the row records (`idleSince` set) is the idle
 *  interval in buckets. */
export function shouldCreateRefreshInstance(row: RefreshRow, nowMs: number, cadence: RefreshCadence): InstanceDecision {
  const blocked = refreshCycleBlocked(row, nowMs);
  if (blocked) return { create: false, why: blocked };
  if (row.lastInstanceAt !== null) {
    const delayS = row.idleSince !== null ? cadence.idleIntervalS : cadence.intervalS;
    const dueBuckets = Math.max(1, Math.ceil((delayS * 1000) / REFRESH_BUCKET_MS));
    if (refreshBucket(nowMs) - refreshBucket(row.lastInstanceAt) < dueBuckets) return { create: false, why: "not-due" };
  }
  return { create: true, why: "due" };
}

// -- the step policy ----------------------------------------------------------

/** Every step's retry policy: six attempts, thirty seconds apart, doubling.
 *  The delays between attempts sum to 930 s, about 15.5 minutes — longer than
 *  the 3 to 10 minutes a resident Worker rollover takes to settle, so a deploy
 *  mid-cycle costs the cycle retries inside one step, never a failed instance. */
export const REFRESH_STEP_RETRIES = { limit: 6, delay: "30 seconds", backoff: "exponential" } as const;

/** The sum of the delays between `limit` attempts under the policy: the
 *  window a step keeps retrying inside. `delay` is the "<n> seconds" form the
 *  engine accepts. */
export function retryWindowMs(policy: { limit: number; delay: string; backoff: "exponential" | "constant" }): number {
  const m = /^(\d+) seconds?$/.exec(policy.delay);
  if (!m) throw new Error(`retry delay must be "<n> seconds", got ${JSON.stringify(policy.delay)}`);
  const first = Number(m[1]) * 1000;
  let total = 0;
  for (let i = 0; i < policy.limit - 1; i++) total += policy.backoff === "exponential" ? first * 2 ** i : first;
  return total;
}

/** The engine's ceiling on a step's configurable timeout ("30 minutes or
 *  less"); a step budget is the DO method's own, and never above this. */
export const STEP_TIMEOUT_MAX_MS = 30 * 60_000;

/** A step's timeout in ms: the method's budget, capped at the platform's. */
export function stepTimeoutMs(budgetMs: number): number {
  if (!(budgetMs > 0)) throw new Error(`step budget must be positive, got ${budgetMs}`);
  return Math.min(budgetMs, STEP_TIMEOUT_MAX_MS);
}
