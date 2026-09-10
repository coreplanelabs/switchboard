/** The refresh cycle as a cron-created Workflow instance — the id scheme, the
 *  per-resident lifecycle flag and the cron's decision to create one
 *  (docs/reference/specs/resident-repos.md item 7), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker like residentRefresh — the tested code IS the shipped code.
 *
 *  Background: the refresh cycle is driven by a self-rearming alarm chain,
 *  and every failure between two re-arms ends the chain silently; a watchdog
 *  guesses from a timestamp. A Cloudflare Workflow instance is the durable
 *  fact the chain lacks: the engine records that a sequence is in progress
 *  and which step it reached, retries a failed step on a policy, and shows a
 *  failed instance by name. The port runs behind a per-resident flag,
 *  `lifecycle: alarm | workflow`, default `alarm`: one resident can run its
 *  cycles as instances while the fleet keeps the chain, and the two
 *  schedulers never both drive a cycle for the same resident.
 *
 *  Shape: a cycle is one SHORT instance, not a loop — the resident Worker's
 *  existing ten-minute cron creates one per eligible resident with a
 *  deterministic id per resident and ten-minute bucket, so a second firing in
 *  the same bucket is refused as a duplicate id and cycles stay serialized
 *  per resident the way the chain serialized them. (A perpetual instance
 *  that slept between cycles was rejected by arithmetic: five steps every
 *  600 s reaches the engine's 10,000-step instance cap in about two weeks.) */

import { STALE_MIDFLIGHT_MS } from "./residentIncarnation.js";
import { nextRefreshDelayS } from "./residentRefresh.js";
import type { ResidentLifecycleState } from "./residentState.js";

// -- the flag ----------------------------------------------------------------

/** Which scheduler drives a resident's refresh cycle. */
export type ResidentLifecycle = "alarm" | "workflow";

/** The alarm chain is the default; a row without the field reads as `alarm`. */
export const DEFAULT_LIFECYCLE: ResidentLifecycle = "alarm";

export function parseLifecycle(value: unknown): ResidentLifecycle | undefined {
  return value === "alarm" || value === "workflow" ? value : undefined;
}

/** What a stored row means: the two words, else the default. */
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

/** The engine refuses a `create` whose id names an instance still inside its
 *  retention ("If a provided id exists, an error will be thrown"); the cron
 *  treats that refusal as the no-op it is. Judged by wording because the
 *  error carries no code. */
export function isDuplicateInstanceError(message: string): boolean {
  return /already exists|duplicate/i.test(message);
}

// -- the cron's decision -----------------------------------------------------

/** What the cron reads about one resident before creating its instance. */
export interface RefreshRow {
  lifecycle: ResidentLifecycle;
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
  /** The awake cadence (the alarm's REFRESH_INTERVAL_S). */
  intervalS: number;
  /** The idle cadence (the alarm's IDLE_REFRESH_INTERVAL_S). */
  idleIntervalS: number;
}

export type InstanceDecision =
  | { create: true; why: "due" }
  | { create: false; why: "alarm-lifecycle" | "not-serving" | "mid-cycle" | "not-due" | "running" };

/** Create an instance only for a `workflow` row that is serving, is not in a
 *  live cycle (a `refreshing` marker younger than the stale bound; an older
 *  one is an orphan the next cycle normalizes, exactly as the watchdog
 *  judges it), and whose cadence has elapsed since the last instance —
 *  counted in whole buckets so cron jitter never skips a due bucket: the
 *  awake cadence is one bucket, the idle cadence the row records is
 *  `nextRefreshDelayS`'s idle interval in buckets. */
export function shouldCreateRefreshInstance(row: RefreshRow, nowMs: number, cadence: RefreshCadence): InstanceDecision {
  if (row.lifecycle !== "workflow") return { create: false, why: "alarm-lifecycle" };
  if (row.state === "onboarding" || row.state === "down") return { create: false, why: "not-serving" };
  if (row.instanceRunning) return { create: false, why: "running" };
  if (row.state === "refreshing" && row.updatedAt !== null && nowMs - row.updatedAt <= STALE_MIDFLIGHT_MS) {
    return { create: false, why: "mid-cycle" };
  }
  if (row.lastInstanceAt !== null) {
    const delayS = nextRefreshDelayS({
      outcome: row.idleSince !== null ? "idle" : "normal",
      intervalS: cadence.intervalS,
      idleIntervalS: cadence.idleIntervalS,
    });
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
