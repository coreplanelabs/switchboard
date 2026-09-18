// The door report (docs/reference/specs/load-harness.md item 19; record 0044,
// the counts before anything is built): how many routed writes the door
// handed back as a line to paste, and how many of those lines were pasted, per
// day and per command — read off the run store's command records alone. A
// hand-back is a command run whose `route` event carries `outcome: "hand_back"`;
// a paste is one carrying `outcome: "pasted"` and `handBackRunId`, joined to
// its hand-back by that id and counted under the hand-back's day and command,
// whatever day the paste landed. Nothing here invokes anything: the list and
// the per-run events are the inputs, and a store that cannot be read is said
// so on the report rather than guessed around.
import { COMMAND_RUN_AGENT } from "../core/runOwner.js";
import { causeOf, REFUSAL_CODES, type RefusalCause, type RefusalCode } from "../core/refusal.js";
import { RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunListCursor, RunsService, RunView } from "../core/runsService.js";

/** One day's counts for one command. */
export interface DoorRow {
  /** The hand-back's finish day, `YYYY-MM-DD` in UTC. */
  day: string;
  /** The command the door bound (`config.set`, …). */
  command: string;
  handBacks: number;
  /** Pastes joined to this bucket's hand-backs by `handBackRunId`. */
  pastes: number;
}

/** One day's refusal count for one code (record 0054): a run whose `route`
 *  event carries `outcome: "refused"` and the code, counted by day, cause and code.
 *  No writer produces such records yet ([run-history.md] item 2's gap: the confirm
 *  path's refusals return no row to record), so this section counts zero until it
 *  lands; the report's footer names the recordless gate refusals meanwhile. */
export interface RefusalRow {
  day: string;
  cause: RefusalCause | "unknown";
  code: string;
  count: number;
}

export interface DoorReport {
  handBacks: number;
  /** Pastes whose hand-back is among the hand-backs read. */
  pastes: number;
  /** Pastes whose `handBackRunId` names no hand-back read — one before
   *  `sinceMs`, or a record the store no longer holds. Counted, joined to nothing. */
  unmatchedPastes: number;
  /** Command runs whose events were read, door decisions or not. */
  commandRuns: number;
  /** The store threw on a list: the counts are the live registry's rows alone. */
  storeUnavailable: boolean;
  /** Sorted by day, then command. */
  rows: DoorRow[];
  /** Refused records, sorted by day, then cause, then code. */
  refusals: RefusalRow[];
}

export interface DoorReportOptions {
  /** Only runs finished at or after this epoch ms. */
  sinceMs?: number;
  /** Rows per list page; default and cap `RUN_LIST_MAX_LIMIT`. */
  pageSize?: number;
  /** Pages read at most; default 50. */
  maxPages?: number;
}

type RouteEvent = Extract<RunEvent, { type: "route" }>;

/** The day a run finished, as the report buckets it. */
function dayOf(run: RunView): string {
  return new Date(run.finishedAt ?? run.startedAt).toISOString().slice(0, 10);
}

/** Every finished command run in the window, newest first, through the
 *  list's own cursor; a store the list could not reach ends the read where it
 *  stands and is reported. */
async function commandRuns(
  runs: Pick<RunsService, "listRuns">,
  opts: DoorReportOptions,
): Promise<{ runs: RunView[]; storeUnavailable: boolean }> {
  const limit = Math.min(RUN_LIST_MAX_LIMIT, Math.max(1, opts.pageSize ?? RUN_LIST_MAX_LIMIT));
  const maxPages = opts.maxPages ?? 50;
  const out: RunView[] = [];
  let storeUnavailable = false;
  let before: RunListCursor | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await runs.listRuns({
      status: "finished",
      visibleTo: { kind: "all" },
      agent: COMMAND_RUN_AGENT,
      limit,
      ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
      ...(before !== undefined ? { before: before.finishedAt, beforeId: before.id } : {}),
    });
    out.push(...result.runs);
    if (result.storeUnavailable) storeUnavailable = true;
    if (!result.nextBefore) break;
    before = result.nextBefore;
  }
  return { runs: out, storeUnavailable };
}

/** The run's `route` event, when its record has one. */
async function routeOf(runs: Pick<RunsService, "getRunEvents">, id: string): Promise<RouteEvent | undefined> {
  const page = await runs.getRunEvents(id, {});
  if (!page.ok) return undefined;
  const route = page.value.events.find((e) => e.type === "route");
  return route?.type === "route" ? route : undefined;
}

/**
 * The report over one runs service: the window's command runs, each one's
 * `route` event read, the hand-backs bucketed by day and command and the
 * pastes joined to them by `handBackRunId`. A routed read (a route with no
 * outcome) and a typed inline run (no route) are read and left out.
 */
export async function doorReport(
  runs: Pick<RunsService, "listRuns" | "getRunEvents">,
  opts: DoorReportOptions = {},
): Promise<DoorReport> {
  const listed = await commandRuns(runs, opts);
  const handBacks = new Map<string, { day: string; command: string }>();
  const pastes: string[] = [];
  const refusalBuckets = new Map<string, RefusalRow>();
  for (const run of listed.runs) {
    const route = await routeOf(runs, run.id);
    if (!route) continue;
    if (route.outcome === "refused") {
      // The record's cause comes from the one code→cause table; a code the
      // table does not know (a record from a newer bot) counts as `unknown`.
      const code = route.refusalCode ?? "unknown";
      const cause = (REFUSAL_CODES as readonly string[]).includes(code) ? causeOf(code as RefusalCode) : "unknown";
      const id = `${dayOf(run)}/${cause}/${code}`;
      const row = refusalBuckets.get(id) ?? { day: dayOf(run), cause, code, count: 0 };
      row.count++;
      refusalBuckets.set(id, row);
      continue;
    }
    if (route.command === undefined) continue;
    if (route.outcome === "hand_back") handBacks.set(run.id, { day: dayOf(run), command: route.command });
    else if (route.outcome === "pasted" && route.handBackRunId !== undefined) pastes.push(route.handBackRunId);
  }
  const buckets = new Map<string, DoorRow>();
  const bucket = (key: { day: string; command: string }): DoorRow => {
    const id = `${key.day}/${key.command}`;
    let row = buckets.get(id);
    if (!row) {
      row = { ...key, handBacks: 0, pastes: 0 };
      buckets.set(id, row);
    }
    return row;
  };
  for (const key of handBacks.values()) bucket(key).handBacks++;
  let joined = 0;
  for (const handBackRunId of pastes) {
    const key = handBacks.get(handBackRunId);
    if (!key) continue;
    bucket(key).pastes++;
    joined++;
  }
  const rows = [...buckets.values()].sort((a, b) =>
    a.day === b.day ? (a.command < b.command ? -1 : a.command > b.command ? 1 : 0) : a.day < b.day ? -1 : 1,
  );
  const refusals = [...refusalBuckets.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.cause.localeCompare(b.cause) || a.code.localeCompare(b.code),
  );
  return {
    refusals,
    handBacks: handBacks.size,
    pastes: joined,
    unmatchedPastes: pastes.length - joined,
    commandRuns: listed.runs.length,
    storeUnavailable: listed.storeUnavailable,
    rows,
  };
}

/** The paste-through rate as the report prints it: `pastes / handBacks`, a dash over no hand-backs. */
export function pasteRate(handBacks: number, pastes: number): string {
  if (handBacks === 0) return "—";
  return `${Math.round((pastes / handBacks) * 1000) / 10}%`;
}

/** The report as lines: the totals with the rate, then each day with its
 *  commands under it, and a last line when the store could not be read. */
export function renderDoor(report: DoorReport): string[] {
  const lines = [
    `door: ${report.handBacks} hand-back(s), ${report.pastes} paste(s) joined (${pasteRate(report.handBacks, report.pastes)} pasted), ${report.unmatchedPastes} paste(s) whose hand-back is outside the window; ${report.commandRuns} command run(s) read`,
  ];
  const days = new Map<string, DoorRow[]>();
  for (const row of report.rows) days.set(row.day, [...(days.get(row.day) ?? []), row]);
  for (const [day, rows] of days) {
    const handBacks = rows.reduce((n, r) => n + r.handBacks, 0);
    const pastes = rows.reduce((n, r) => n + r.pastes, 0);
    lines.push(`- ${day}: hand-backs ${handBacks}, pastes ${pastes} (${pasteRate(handBacks, pastes)})`);
    for (const r of rows)
      lines.push(
        `  - ${r.command}: hand-backs ${r.handBacks}, pastes ${r.pastes} (${pasteRate(r.handBacks, r.pastes)})`,
      );
  }
  // The refusals the store recorded (record 0054): per day, per cause and
  // per code. Only refusals after a command was bound are records; the rest are
  // root spans — the footer names the telemetry query that counts those.
  if (report.refusals.length > 0) {
    const total = report.refusals.reduce((n, r) => n + r.count, 0);
    lines.push(`refusals recorded: ${total}`);
    const refusalDays = new Map<string, RefusalRow[]>();
    for (const row of report.refusals) refusalDays.set(row.day, [...(refusalDays.get(row.day) ?? []), row]);
    for (const [day, rows] of refusalDays) {
      lines.push(`- ${day}: ${rows.reduce((n, r) => n + r.count, 0)} refusal(s)`);
      for (const r of rows) lines.push(`  - ${r.cause}/${r.code}: ${r.count}`);
    }
  }
  if (report.storeUnavailable)
    lines.push("the run store could not be read: the counts above are the live registry's alone");
  lines.push(
    "gate refusals (no record): count root spans with the `refusal` and `cause` attributes over the retention window",
  );
  return lines;
}
