import { MINUTE_MS, minutesToMs, PACE_WINDOW_MINUTES } from "./budgets.js";

// The stall signal (docs/reference/specs/live-view.md item 32; the stall-signal ask): a
// hung bash call and a slow suite must read apart. One pure rule for the run's
// pace — events per minute over the last five minutes, or "no tool call for N
// min" once nothing has landed for a window — and for a tool call past its
// declared bound. Shared by the status card (the run loop) and the runs-index
// row (web/src/lib/indexRow.ts), so the two surfaces can never say it
// differently. Node-free deliberately: the web bundle compiles it too.

/** The pace window: the rate is counted over the last five minutes, and a run
 *  with no tool call for a whole window reads as stalled. */
export const PACE_WINDOW_MS = minutesToMs(PACE_WINDOW_MINUTES);

/** The pace facts a live row carries (`RunSummary`/`RunView`): the events
 *  published in the last window at the time the summary was built, and the
 *  clock stamp of the newest `tool_call`. Both absent on a persisted row and
 *  on a row an older writer built — no signal is never mistaken for a stall. */
export interface PaceFacts {
  startedAt: number;
  /** The newest `tool_call`'s clock stamp; absent while the run has made none. */
  lastToolCallAt?: number;
  /** Content events published within the last `PACE_WINDOW_MS`. */
  eventsLast5m?: number;
}

/** The tool call in flight — opened by a `tool_call`, closed by its
 *  `tool_result` — with the bound the call itself declared, when it did
 *  (a bash `timeout`, in ms). What the bound-exceeded mark is judged from. */
export interface InFlightCall {
  tool: string;
  /** The `tool_call`'s clock stamp. */
  since: number;
  /** The call's own declared bound in ms; absent when it declared none. */
  boundMs?: number;
}

/** How long the run has gone without a tool call, once that is a whole window
 *  or more — the stall predicate; undefined for a healthy run and for a row
 *  without the pace fact (an older writer's, a persisted one). A run that
 *  never called a tool counts from its start. */
export function stalledFor(run: PaceFacts, now: number): number | undefined {
  if (run.eventsLast5m === undefined) return undefined;
  const quiet = now - (run.lastToolCallAt ?? run.startedAt);
  return quiet >= PACE_WINDOW_MS ? quiet : undefined;
}

/** The pace line: `no tool call for N min` once stalled, else the events per
 *  minute over the last window (`2.8/min`; a run younger than the window rates
 *  over its own age, floored at a minute). Empty for a row without the fact. */
export function paceText(run: PaceFacts, now: number): string {
  if (run.eventsLast5m === undefined) return "";
  const quiet = stalledFor(run, now);
  if (quiet !== undefined) return `no tool call for ${Math.floor(quiet / MINUTE_MS)} min`;
  const minutes = Math.min(PACE_WINDOW_MS, Math.max(MINUTE_MS, now - run.startedAt)) / MINUTE_MS;
  const rate = Math.round((run.eventsLast5m / minutes) * 10) / 10;
  return `${rate}/min`;
}

/** The bound-exceeded mark — `bash 2083s, bound 600s` — once a call has run
 *  past the bound it declared; undefined inside the bound and for a call that
 *  declared none (pi runs those until the loop's end cuts them). */
export function boundText(call: InFlightCall, now: number): string | undefined {
  if (call.boundMs === undefined || now - call.since <= call.boundMs) return undefined;
  return `${call.tool} ${Math.round((now - call.since) / 1000)}s, bound ${Math.round(call.boundMs / 1000)}s`;
}

/** Count the stamps inside the window — the registry's rule for
 *  `eventsLast5m`, and the run loop's for the card's pace. `ats` ascending. */
export function eventsInWindow(ats: readonly number[], now: number): number {
  const cut = now - PACE_WINDOW_MS;
  let n = 0;
  for (let i = ats.length - 1; i >= 0 && ats[i] > cut; i--) n++;
  return n;
}
