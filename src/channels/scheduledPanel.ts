import type { RunSummary } from "../core/runRegistry.js";
import { nextFire, type FiringOutcome, type ScheduleAction, type ScheduleDef, type ScheduleFiring, type ScheduleWorker } from "../core/schedules.js";

// The "Scheduled" panel on the Access-gated /runs index (#244): what is armed
// (from the schedule registry — the same list the Worker shim fires from), when
// each fires next (computed from the cron expression, UTC), and what the last
// firing did (from the ScheduleStore: fired-at, outcome, the run it created).
// Anyone who can load /runs sees the jobs running — no wrangler access needed.
//
// Pure: `buildScheduledRows` turns registry + firings + live runs into rows;
// `renderScheduledPanel` turns rows into server-rendered HTML with every dynamic
// string escaped (labels/details come from replies and could carry markup).

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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

/** The "Runs" cell for non-run actions (a `run` shows its command + identity). */
const ACTION_LABEL: Record<Exclude<ScheduleAction["type"], "run">, string> = {
  healthz: "container health check",
  watchdog: "resident watchdog",
};

const OUTCOME_LABEL: Record<FiringOutcome, string> = {
  completed: "completed",
  failed: "failed",
  stopped_soft: "stopped (soft)",
  stopped_hard: "stopped (hard)",
  "no-run": "no run created",
  "ingress-error": "ingress error",
  misconfigured: "misconfigured — nothing ran",
};

const OUTCOME_CLASS: Record<FiringOutcome, "ok" | "bad" | "warn"> = {
  completed: "ok",
  failed: "bad",
  stopped_soft: "warn",
  stopped_hard: "warn",
  "no-run": "warn",
  "ingress-error": "bad",
  misconfigured: "bad",
};

/** Drop into the runs index <style>. Inherits the page's dark monospace shell. */
export const SCHEDULED_PANEL_CSS = `
  #scheduled { margin-top: 1.25rem; border-top: 1px solid #2a2f3a; padding-top: .75rem; }
  #scheduled h2 { font-size: .9rem; margin: 0 0 .5rem; font-weight: 600; }
  #scheduled table { border-collapse: collapse; width: 100%; font-size: .8rem; }
  #scheduled th { text-align: left; color: #8b93a7; font-weight: 500; padding: .25rem .5rem; border-bottom: 1px solid #1b1f28; }
  #scheduled td { padding: .35rem .5rem; vertical-align: top; border-bottom: 1px solid #1b1f28; }
  #scheduled td.name { color: #9ecbff; font-weight: 600; white-space: nowrap; }
  #scheduled code { background: #161b22; padding: 0 .3em; border-radius: 3px; }
  #scheduled .muted { color: #8b93a7; }
  #scheduled .outcome.ok { color: #2ea043; }
  #scheduled .outcome.warn { color: #d29922; }
  #scheduled .outcome.bad { color: #f85149; }
  #scheduled a { color: #9ecbff; }
  #scheduled .note { color: #8b93a7; font-size: .75rem; margin: .35rem 0 0; }
`;

/** Server-rendered `<section id="scheduled">`: one row per schedule. */
export function renderScheduledPanel(rows: ScheduledRow[], firings: FiringsState, now: number): string {
  const body = rows
    .map((r) => {
      const what = r.action.type === "run" ? `<code>${esc(r.action.command)}</code> <span class="muted">as</span> <code>${esc(r.action.identity)}</code>` : `<span class="muted">${esc(ACTION_LABEL[r.action.type])} — not a run</span>`;
      const next = r.nextFireAt !== undefined ? `${esc(formatUtc(r.nextFireAt))} <span class="muted">(${esc(formatRelative(r.nextFireAt, now))})</span>` : `<span class="muted">never</span>`;
      let last: string;
      if (r.last) {
        const run = r.last.runId
          ? r.last.runHref
            ? ` · <a href="${esc(r.last.runHref)}">run ${esc(r.last.runId.slice(0, 8))}</a>`
            : ` · run ${esc(r.last.runId.slice(0, 8))}`
          : "";
        const detail = r.last.detail ? `<div class="muted">${esc(r.last.detail)}</div>` : "";
        last =
          `${esc(formatUtc(r.last.firedAt))} <span class="muted">(${esc(formatRelative(r.last.firedAt, now))})</span><br>` +
          `<span class="outcome ${OUTCOME_CLASS[r.last.outcome]}">${esc(OUTCOME_LABEL[r.last.outcome])}</span>${run}${detail}`;
      } else {
        last = `<span class="muted">${firings.ok ? "never fired" : "unknown"}</span>`;
      }
      return (
        `<tr data-schedule="${esc(r.name)}">` +
        `<td class="name" title="${esc(r.description)}">${esc(r.name)}</td>` +
        `<td><code>${esc(r.cron)}</code> <span class="muted">UTC</span></td>` +
        `<td><code>${esc(r.worker)}</code></td>` +
        `<td>${what}</td>` +
        `<td>${next}</td>` +
        `<td>${last}</td>` +
        `</tr>`
      );
    })
    .join("");
  const note = firings.ok ? "" : `<p class="note">Firing history unavailable: ${esc(firings.reason)}</p>`;
  return (
    `<section id="scheduled" aria-label="Scheduled jobs"><h2>Scheduled</h2>` +
    `<table><thead><tr><th>Schedule</th><th>Cron</th><th>Worker</th><th>Runs</th><th>Next fire</th><th>Last fire</th></tr></thead>` +
    `<tbody>${body}</tbody></table>${note}</section>`
  );
}
