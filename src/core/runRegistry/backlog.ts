import { isHeadMaterial, serializedOnce, type RunEvent } from "../runEvents.js";
import { capEvent, MAX_EVENT_BYTES, utf8ByteLength } from "../runRecord.js";
import { activityOf } from "./activity.js";
import type { RunState } from "./state.js";

// The per-run backlog: the newest events a run keeps while it is live, bounded
// by count and by bytes with a protected head that the bounds never trim, and
// the replay window a late subscriber is offered from it within a budget. The
// writer (`appendToBacklog`) and the reader (`replayWindow`) share one
// invariant — the backlog is `seq`-ascending and its first `headLen` entries
// are the head — so they live together. Both read only the slice of `RunState`
// they name.

/** Default per-run backlog bounds: count and bytes. The registry
 *  backlog is the ONLY per-run event store — the friction diagnosis and the run
 *  record are built from it — so it is bounded generously and by both axes. */
export const DEFAULT_BACKLOG_LIMIT = 8000;
export const DEFAULT_BACKLOG_BYTES = 4 * 1024 * 1024;

/** The protected head (docs/reference/specs/tracing.md; live-view item 2): the events that
 *  say what a run is — its request, its context, its meta, the setup spans and
 *  the notes about missing tools or dropped setup — are never trimmed by the
 *  count or byte bound, up to this many bytes. Past the budget, or once any
 *  other event has been published, later head material is ordinary. Head
 *  events are capped to `MAX_EVENT_BYTES` at publish so one giant `context`
 *  cannot spend the whole budget. */
export const HEAD_BUDGET_BYTES = 512 * 1024;

/** The replay budget a late subscriber gets from the retained backlog
 *  (docs/reference/specs/live-view.md item 5): at most this many events and at most
 *  `DEFAULT_REPLAY_BYTES` of UTF-8 JSON, the newest first. The backlog keeps
 *  more than a browser needs to follow a live run, and a page must not stall on
 *  a 4 MiB burst; what the budget leaves out is reported as `elided`, never
 *  silently dropped. */
export const DEFAULT_REPLAY_LIMIT = 2000;
export const DEFAULT_REPLAY_BYTES = 1024 * 1024;

/** The two bounds a registry applies to every run's backlog (`RunRegistryOptions.backlogLimit`/`backlogBytes`). */
export interface BacklogBounds {
  limit: number;
  bytes: number;
}

/** The slice of a run's state the backlog writes: the buffer, its sizes and
 *  total, the protected head, and the activity line refreshed per event. */
export type BacklogState = Pick<
  RunState,
  "backlog" | "backlogSizes" | "backlogBytes" | "headLen" | "headBytes" | "activity"
>;

/** Append one stamped event to the run's bounded backlog and refresh its
 *  activity line. Head material published while the backlog holds nothing
 *  but head joins the protected head (capped per event, bounded in total);
 *  the trim then drops the oldest event AFTER the head, never the head, and
 *  always keeps the newest. */
export function appendToBacklog(run: BacklogState, bounds: BacklogBounds, published: RunEvent): void {
  const headEligible =
    run.backlog.length === run.headLen && isHeadMaterial(published) && run.headBytes < HEAD_BUDGET_BYTES;
  // A head event is capped at publish (docs/reference/specs/tracing.md): the cap is the
  // record's per-event cap, so what the head holds is what a record would.
  const stamped = headEligible ? capEvent(published, MAX_EVENT_BYTES).event : published;
  const bytes = utf8ByteLength(serializedOnce(stamped)); // memoized: the SSE frame reuses this string
  run.backlog.push(stamped);
  run.backlogSizes.push(bytes);
  run.backlogBytes += bytes;
  if (headEligible && run.headBytes + bytes <= HEAD_BUDGET_BYTES) {
    run.headLen++;
    run.headBytes += bytes;
  }
  // The one-line "what is it doing" the index shows (item 20). Narration wins
  // over the tool call it explains only until the next call arrives.
  const activity = activityOf(stamped);
  if (activity !== undefined) run.activity = activity;
  while (
    run.backlog.length > run.headLen + 1 &&
    (run.backlog.length > bounds.limit || run.backlogBytes > bounds.bytes)
  ) {
    run.backlog.splice(run.headLen, 1);
    run.backlogBytes -= run.backlogSizes.splice(run.headLen, 1)[0] ?? 0;
  }
}

/** What a subscriber is replayed from the backlog, as index ranges: the first
 *  `head` entries (the protected head, on a fresh subscribe), then every entry
 *  from `start` to the end; `elided` is the contiguous `seq` range between
 *  them that the budget skipped, absent when nothing was. */
export interface ReplayWindow {
  head: number;
  start: number;
  elided?: { fromSeq: number; toSeq: number };
}

/** The replay window for a subscriber resuming after `afterSeq` (0 = the whole
 *  retained backlog) under a `limit`/`byteLimit` budget: the newest offered
 *  events, the newest admitted unconditionally. */
export function replayWindow(
  run: Pick<RunState, "backlog" | "backlogSizes" | "headLen">,
  afterSeq: number,
  limit: number,
  byteLimit: number,
): ReplayWindow {
  const { backlog, backlogSizes } = run;
  // The backlog is `seq`-ascending: the offered events are one suffix, and the
  // replayed ones a suffix of that. A fresh subscribe (no cursor) always gets
  // the protected head first (docs/reference/specs/tracing.md), and the budget then buys
  // the newest of the rest; a resume re-sends nothing from the head. Walk
  // newest-first, admitting an event while both bounds hold; the newest is
  // admitted unconditionally.
  let first = backlog.findIndex((e) => (e.seq ?? 0) > afterSeq);
  if (first === -1) first = backlog.length;
  const head = afterSeq === 0 ? Math.min(run.headLen, backlog.length) : 0;
  let headBytes = 0;
  for (let i = 0; i < head; i++) headBytes += backlogSizes[i] ?? 0;
  const restFirst = Math.max(first, head);
  let start = backlog.length;
  let bytes = headBytes;
  while (start > restFirst) {
    const next = start - 1;
    const count = head + (backlog.length - next);
    const size = backlogSizes[next] ?? 0;
    if (count > head + 1 && (count > limit || bytes + size > byteLimit)) break;
    bytes += size;
    start = next;
  }
  const elided =
    start > restFirst ? { fromSeq: backlog[restFirst]!.seq ?? 0, toSeq: backlog[start - 1]!.seq ?? 0 } : undefined;
  return { head, start, ...(elided ? { elided } : {}) };
}
