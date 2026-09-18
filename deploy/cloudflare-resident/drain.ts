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
}

/** The longest a drain may run, and the default, from the one clock table
 *  (src/core/budgets.ts `DRAIN`): past a coding child's whole lease with room
 *  for the deploy itself, and short enough that a forgotten drain is an hour
 *  and a half, not a day. */
export const DRAIN_MAX_MINUTES: number = DRAIN.maxMinutes;
export const DRAIN_DEFAULT_MINUTES: number = DRAIN.defaultMinutes;
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
  return { since: r.since, until: r.until, by: r.by, reason: r.reason };
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
