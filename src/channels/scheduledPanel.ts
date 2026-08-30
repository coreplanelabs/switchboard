import type { RunSummary } from "../core/runRegistry.js";
import { nextFire, type FiringOutcome, type ScheduleAction, type ScheduleDef, type ScheduleFiring, type ScheduleWorker } from "../core/schedules.js";

// The "Scheduled" tab of the Access-gated /runs page (#244, `/runs/scheduled`): what is armed
// (from the schedule registry — the same list the Worker shim fires from), when
// each fires next (computed from the cron expression, UTC), and what the last
// firing did (from the ScheduleStore: fired-at, outcome, the run it created).
// Anyone who can load /runs sees the jobs running — no wrangler access needed.
//
// Pure: `buildScheduledRows` turns registry + firings + live runs into rows —
// the seed the web page (web/src/pages/ScheduledPage.vue) renders; the label
// maps and formatters here are the one vocabulary both sides share.

/** What the panel knows about firing history: the store's answer, or why there is none. */
export type FiringsState = { ok: true; firings: ScheduleFiring[] } | { ok: false; reason: string };

export interface ScheduledRow {
  name: string;
  worker: ScheduleWorker;
  action: ScheduleAction;
  cron: string;
  description: string;
  /** ms UTC of the next firing strictly after `now`; undefined when the expression never fires. */
  nextFireAt?: number;
  last?: {
    firedAt: number;
    outcome: FiringOutcome;
    runId?: string;
    /** `/runs/<id>?t=…` while the run is live in the registry (the index is Access-gated,
     *  so the capability link is fine here — same as the run rows); a bare `/runs/<id>`
     *  otherwise (resolves once run history lands, #157). */
    runHref?: string;
    detail?: string;
  };
}

/** One row per schedule an operator can act on: `internal` plumbing (the
 *  container keep-alive) is never listed. */
export function buildScheduledRows(schedules: readonly ScheduleDef[], firings: FiringsState, liveRuns: RunSummary[], now: number): ScheduledRow[] {
  const byName = new Map<string, ScheduleFiring>();
  if (firings.ok) for (const f of firings.firings) byName.set(f.schedule, f);
  const live = new Map(liveRuns.map((r) => [r.id, r]));
  return schedules.filter((s) => !s.internal).map((s) => {
    const f = byName.get(s.name);
    const row: ScheduledRow = { name: s.name, worker: s.worker, action: s.action, cron: s.cron, description: s.description };
    const next = nextFire(s.cron, now);
    if (next !== undefined) row.nextFireAt = next;
    if (f) {
      const liveRun = f.runId ? live.get(f.runId) : undefined;
      row.last = {
        firedAt: f.firedAt,
        outcome: f.outcome,
        ...(f.runId !== undefined ? { runId: f.runId } : {}),
        ...(f.runId !== undefined
          ? { runHref: liveRun ? `/runs/${encodeURIComponent(f.runId)}?t=${encodeURIComponent(liveRun.token)}` : `/runs/${encodeURIComponent(f.runId)}` }
          : {}),
        ...(f.detail !== undefined ? { detail: f.detail } : {}),
      };
    }
    return row;
  });
}

/** `2026-08-31 14:00 UTC` */
export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `in 2d 3h` / `in 45m` / `in <1m` / `3h ago` — coarse, for a glance. */
export function formatRelative(ms: number, now: number): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  const m = Math.floor(abs / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const span = d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m` : "<1m";
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

/** The "Runs" cell for non-run actions (a `run` shows its command + identity).
 *  Exported for the web page, which renders the same vocabulary. */
export const ACTION_LABEL: Record<Exclude<ScheduleAction["type"], "run">, string> = {
  healthz: "container health check",
  watchdog: "resident watchdog",
};

export const OUTCOME_LABEL: Record<FiringOutcome, string> = {
  completed: "succeeded",
  failed: "failed",
  stopped_soft: "stopped early",
  stopped_hard: "killed",
  "no-run": "no run created",
  "ingress-error": "ingress error",
  misconfigured: "misconfigured — nothing ran",
};

export const OUTCOME_CLASS: Record<FiringOutcome, "ok" | "bad" | "warn"> = {
  completed: "ok",
  failed: "bad",
  stopped_soft: "warn",
  stopped_hard: "warn",
  "no-run": "warn",
  "ingress-error": "bad",
  misconfigured: "bad",
};

/** How much of a firing's detail the one-line cell shows before an ellipsis;
 *  the full text stays on the cell's `title`. */
const DETAIL_SHOWN = 120;

/** The detail as the panel shows it: the reply's facts, not its title. Drops a
 *  leading emoji/symbol run and a leading `*Title* —` (the head line of a
 *  command reply names the command before its numbers — the row already names
 *  the command), collapses whitespace, and cuts at `DETAIL_SHOWN` with `…`
 *  (pre-item-16 records flattened a whole multi-line reply into one line). */
export function firingDetailSummary(detail: string): string {
  let s = detail.replace(/\s+/g, " ").trim();
  s = s.replace(/^[^\p{L}\p{N}*_`<[(]+/u, ""); // leading emoji / symbols
  s = s.replace(/^\*[^*]{1,60}\*\s+[—–-]\s+/, ""); // `*Friction proposals* — `
  s = s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  // A legacy record's flattened body starts with its numbered list (" 1. `…"):
  // the head line ends where the list begins.
  s = s.replace(/\s+1\.\s+`[\s\S]*$/, "");
  return s.length > DETAIL_SHOWN ? `${s.slice(0, DETAIL_SHOWN)}…` : s;
}
