// The fleet drain (docs/reference/specs/resident-repos.md item 69): one record
// in the registry Durable Object that closes `POST /attach` to NEW runs while a
// deploy waits for the runs already in flight to end — a run registered from
// its attach to its release re-attaches through it (a rolled container, an
// evicted worktree, a resumed run), so the drain never refuses a run it waits for. Pure over its inputs so
// it runs under plain Node (drain.test.ts); the Worker holds the storage and
// the routes, and the deploy runner (src/deploy/residentDrain.ts) the other end.
//
// Why a record with an end and not a flag: Durable Object storage survives the
// isolate swap the deploy performs, so a drain nobody lifted — a runner that
// died mid-step — would close the fleet for good. Every drain carries `until`;
// past it the record is nothing, whoever forgot it.

import { DRAIN, minutesToMs } from "../../src/core/budgets.js";

/** The drain as the registry stores it. */
export interface DrainRecord {
  /** ISO time the drain began. */
  since: string;
  /** ISO time it ends by itself, whether or not anyone lifts it. */
  until: string;
  /** Who asked (the deploy names its commit). */
  by: string;
  /** Why, in the words the attach refusal repeats. */
  reason: string;
  /** The residents whose containers still run the pre-deploy image (issue
   *  1931): the deploy's reconcile marks the Durable Objects but the platform
   *  replaces the container processes asynchronously, so "reconciled" is not
   *  "swapped" — each hold stands until that resident reports its running
   *  container on the deploy's image, and the fleet reopens on the LAST
   *  report, a fact, never a wait. Absent or empty: no swap outstanding. */
  holds?: string[];
  /** The hold's own liveness bound (issue 2044): stamped when the first hold
   *  lands, the cycle's measured bound out (`DRAIN.cycleBoundMinutes`, clamped
   *  to `until`). The gate asked the containers to cycle, so it owns the
   *  outcome: past this time a cycle that never happened reopens the fleet
   *  anyway — `liveDrain` reads the record as no drain — with the stale
   *  containers named in the registry's warning, never a silence to `until`.
   *  A record without it (an older build's) keeps `until` as its only end. */
  holdsUntil?: string;
  /** Whether `POST /undrain` already asked for the lift while holds stood:
   *  the record then clears itself on the last hold's report instead of
   *  waiting for a second lift. */
  liftAsked?: boolean;
}

/** The longest a drain may run, and the default, from the one clock table
 *  (src/core/budgets.ts `DRAIN`): past a coding child's whole lease with room
 *  for the deploy itself, and short enough that a forgotten drain is an hour
 *  and a half, not a day. */
export const DRAIN_MAX_MINUTES: number = DRAIN.maxMinutes;
export const DRAIN_DEFAULT_MINUTES: number = DRAIN.defaultMinutes;
/** The post-deploy container cycle's measured bound (issue 2044): a hold that
 *  outlives it reopens the fleet with the container named stale. */
export const HOLD_CYCLE_BOUND_MINUTES: number = DRAIN.cycleBoundMinutes;
const REASON_MAX = 200;
const BY_MAX = 80;

export type DrainRequest = { ok: true; record: DrainRecord } | { ok: false; error: string };

/** `POST /drain`'s body → the record, or the refusal by name. `minutes` is an
 *  integer in [1, DRAIN_MAX_MINUTES] (default DRAIN_DEFAULT_MINUTES); `reason`
 *  and `by` are short strings with defaults. A malformed value is refused,
 *  never clamped silently: a drain is an operator's act and its words are read
 *  back by every run it refuses. */
export function parseDrainRequest(body: Record<string, unknown>, now: number): DrainRequest {
  let minutes = DRAIN_DEFAULT_MINUTES;
  if (body.minutes !== undefined) {
    if (typeof body.minutes !== "number" || !Number.isInteger(body.minutes))
      return { ok: false, error: "minutes must be an integer number of minutes" };
    if (body.minutes < 1 || body.minutes > DRAIN_MAX_MINUTES)
      return { ok: false, error: `minutes must be between 1 and ${DRAIN_MAX_MINUTES}` };
    minutes = body.minutes;
  }
  const word = (v: unknown, name: string, max: number, fallback: string): string | { error: string } => {
    if (v === undefined) return fallback;
    if (typeof v !== "string" || v.trim() === "") return { error: `${name} must be a non-empty string` };
    const trimmed = v.trim();
    if (trimmed.length > max) return { error: `${name} must be at most ${max} characters` };
    return trimmed;
  };
  const reason = word(body.reason, "reason", REASON_MAX, "a deploy");
  if (typeof reason !== "string") return { ok: false, error: reason.error };
  const by = word(body.by, "by", BY_MAX, "admin");
  if (typeof by !== "string") return { ok: false, error: by.error };
  return {
    ok: true,
    record: {
      since: new Date(now).toISOString(),
      until: new Date(now + minutesToMs(minutes)).toISOString(),
      by,
      reason,
    },
  };
}

/** The drain in force at `now`: the stored record when it is well-formed and
 *  its `until` is still ahead; null for none, an expired one, or a record this
 *  build cannot read (a shape from another build reads as no drain, never as a
 *  closed fleet). */
export function liveDrain(stored: unknown, now: number): DrainRecord | null {
  if (typeof stored !== "object" || stored === null) return null;
  const r = stored as Record<string, unknown>;
  if (
    typeof r.since !== "string" ||
    typeof r.until !== "string" ||
    typeof r.by !== "string" ||
    typeof r.reason !== "string"
  )
    return null;
  const until = Date.parse(r.until);
  if (!Number.isFinite(until) || until <= now) return null;
  const holds = Array.isArray(r.holds) ? r.holds.filter((h): h is string => typeof h === "string") : [];
  const holdsUntil = typeof r.holdsUntil === "string" ? r.holdsUntil : undefined;
  // The hold's liveness (issue 2044): holds whose cycle bound has passed are a
  // cycle that never happened — the fleet reopens by construction, whoever
  // died between the reconcile and the lift; `staleHolds` names the containers.
  if (holds.length > 0 && holdsUntil !== undefined) {
    const bound = Date.parse(holdsUntil);
    if (Number.isFinite(bound) && bound <= now) return null;
  }
  return {
    since: r.since,
    until: r.until,
    by: r.by,
    reason: r.reason,
    ...(holds.length > 0 ? { holds } : {}),
    ...(holds.length > 0 && holdsUntil !== undefined ? { holdsUntil } : {}),
    ...(r.liftAsked === true ? { liftAsked: true } : {}),
  };
}

/** The stale containers of a stored record whose hold bound has passed while
 *  its `until` had not (issue 2044): what `liveDrain` just reopened past, for
 *  the registry's warning — the reopen is never silent about who never cycled.
 *  Null when the record is not that case (no holds, bound still ahead, or the
 *  record expired on `until` itself). */
export function staleHolds(stored: unknown, now: number): string[] | null {
  if (typeof stored !== "object" || stored === null) return null;
  const r = stored as Record<string, unknown>;
  const until = Date.parse(typeof r.until === "string" ? r.until : "");
  if (!Number.isFinite(until) || until <= now) return null;
  const holds = Array.isArray(r.holds) ? r.holds.filter((h): h is string => typeof h === "string") : [];
  const bound = Date.parse(typeof r.holdsUntil === "string" ? r.holdsUntil : "");
  if (holds.length === 0 || !Number.isFinite(bound) || bound > now) return null;
  return holds;
}

/** The record with the named residents held (issue 1931): the deploy's
 *  reconcile could not verify their running containers on the new image, so
 *  the fleet must not reopen onto them until each reports. Deduplicated;
 *  an empty set changes nothing. The first hold stamps the record's cycle
 *  bound (issue 2044): the reconcile just asked each container to cycle, so
 *  the cycle either lands within its measured bound or is not coming — past
 *  `holdsUntil` the fleet reopens with the holdouts named, `until` staying
 *  the last resort for a record from before the bound. */
export function holdDrain(record: DrainRecord, resources: readonly string[], now: number): DrainRecord {
  const holds = [...new Set([...(record.holds ?? []), ...resources])];
  if (holds.length === 0) return record;
  const bound = Math.min(Date.parse(record.until), now + minutesToMs(HOLD_CYCLE_BOUND_MINUTES));
  const holdsUntil = record.holdsUntil ?? new Date(bound).toISOString();
  return { ...record, holds, holdsUntil };
}

/** `POST /undrain`'s decision over the stored record: with no holds the drain
 *  clears; with holds outstanding the fleet STAYS closed — the record keeps
 *  standing with `liftAsked`, so the last container's new-image report lifts
 *  it (a fact, never a timer; `until` remains the backstop for a report that
 *  never comes). */
export function liftDrain(record: DrainRecord): { cleared: true } | { cleared: false; record: DrainRecord } {
  const holds = record.holds ?? [];
  if (holds.length === 0) return { cleared: true };
  return { cleared: false, record: { ...record, liftAsked: true } };
}

/** One resident's word that its running container is on the deploy's image:
 *  its hold drops; when it was the last hold and the lift was already asked,
 *  the drain lifts here — the reopen fires on the last container's report. */
export function reportImageCurrent(
  record: DrainRecord,
  resource: string,
): { lifted: boolean; record: DrainRecord | null } {
  const holds = (record.holds ?? []).filter((h) => h !== resource);
  const next: DrainRecord = { ...record, ...(holds.length > 0 ? { holds } : {}) };
  if (holds.length === 0) {
    delete next.holds;
    delete next.holdsUntil;
  }
  if (holds.length === 0 && record.liftAsked === true) return { lifted: true, record: null };
  return { lifted: false, record: next };
}

/** The `/attach` answer while the fleet is drained: a 503 whose body carries
 *  the record, so the bot waits for `until` at most and the card says why the
 *  run has not started. The `error` word `draining:` is the client's key. */
export function drainRefusal(drain: DrainRecord): {
  error: string;
  status: 503;
  draining: DrainRecord;
} {
  return {
    error:
      `draining: the resident fleet is closed to new runs for ${drain.reason} (asked by ${drain.by} at ${drain.since}, ` +
      `ends by ${drain.until}) — the run waits at its attach and starts when the fleet reopens`,
    status: 503,
    draining: drain,
  };
}
