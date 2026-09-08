/** The one definition of a run's duration (docs/reference/specs/tracing.md; live-view item
 *  22). Every surface that prints one — the run page header and timeline lede,
 *  the runs index row, `runs list`, the history seed, the Slack card — calls
 *  this, so no two of them can disagree.
 *
 *  The window opens when our process saw the message (`receivedAt`), falling
 *  back to the registry's `startedAt` for a run that predates the stamp, and
 *  closes at `finishedAt`; a live run closes at the caller's `now`. A finished
 *  run with no `finishedAt` and no `now` (a tombstone) has no duration and
 *  renders blank, as today. Pure leaf module: the dashboard bundle imports it
 *  through `@core/*`. */

export interface RunStamps {
  /** Our process saw the message (a fresh turn: the fresh dispatch started). */
  receivedAt?: number;
  /** The run was registered. */
  startedAt: number;
  /** The agent stopped working. Absent while live and on a tombstone. */
  finishedAt?: number;
}

export function runDurationMs(stamps: RunStamps, now?: number): number | undefined {
  const end = stamps.finishedAt ?? now;
  if (end === undefined) return undefined;
  return Math.max(0, end - (stamps.receivedAt ?? stamps.startedAt));
}
