import type { RunSummary } from "../core/runRegistry.js";
import { nextFire, type FiringOutcome, type ScheduleAction, type ScheduleDef, type ScheduleFiring, type ScheduleWorker } from "../core/schedules.js";

// The "Scheduled" tab of the Access-gated /runs page (#244, `/runs/scheduled`): what is armed
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
  completed: "succeeded",
  failed: "failed",
  stopped_soft: "stopped early",
  stopped_hard: "killed",
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

/** Drop into the runs page <style>. Inherits the dark monospace shell. Two
 *  flowing lines per schedule (definition, then the last firing) — no table
 *  columns, so nothing wraps into a stack and no gutter goes empty. */
export const SCHEDULED_PANEL_CSS = `
  #scheduled { margin: 0; }
  #scheduled ul.schedules { list-style: none; margin: 0; padding: 0; }
  #scheduled li { padding: .7rem .5rem .75rem; border-bottom: 1px solid #1b1f28; }
  /* Line 1 — the definition. Inline flow with a dot between facts; the name is
     the anchor, everything else sits back a step. */
  #scheduled .def { display: flex; flex-wrap: wrap; align-items: baseline; gap: .15rem .5rem; font-size: .8rem; color: #b6bcc8; }
  #scheduled .def .name { color: #e6e6e6; font-weight: 600; }
  #scheduled .def .next { font-variant-numeric: tabular-nums; }
  #scheduled .def .next b { color: #e6e6e6; font-weight: 500; }
  /* Line 2 — the last firing: one line, ellipsized, exact time on hover. */
  #scheduled .fire { margin-top: .3rem; font-size: .75rem; color: #8b93a7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #scheduled .fire .when { color: #b6bcc8; }
  #scheduled .lbl { color: #5f677a; text-transform: uppercase; letter-spacing: .06em; font-size: .62rem; margin-right: .15rem; }
  #scheduled code { background: #161b22; padding: .05em .35em; border-radius: 3px; color: #b6bcc8; }
  #scheduled .muted { color: #5f677a; }
  #scheduled .sep { color: #3b4252; margin: 0 .3rem; }
  #scheduled .outcome.ok { color: #7ee787; }
  #scheduled .outcome.warn { color: #d29922; }
  #scheduled .outcome.bad { color: #ff7b72; }
  #scheduled .detail { color: #8b93a7; }
  #scheduled a { color: #9ecbff; text-decoration: none; }
  #scheduled a:hover { text-decoration: underline; }
  #scheduled .note { color: #8b93a7; font-size: .75rem; margin: .6rem .5rem 0; }
`;

/** Server-rendered `<section id="scheduled">`: one `<li data-schedule>` per schedule. */
export function renderScheduledPanel(rows: ScheduledRow[], firings: FiringsState, now: number): string {
  const body = rows
    .map((r) => {
      const what = r.action.type === "run" ? `<code>${esc(r.action.command)}</code> <span class="muted">as</span> <code>${esc(r.action.identity)}</code>` : `<span class="muted">${esc(ACTION_LABEL[r.action.type])} — not a run</span>`;
      const next = r.nextFireAt !== undefined ? `<b>${esc(formatUtc(r.nextFireAt))}</b> <span class="muted">(${esc(formatRelative(r.nextFireAt, now))})</span>` : `<span class="muted">never</span>`;
      let last: string;
      if (r.last) {
        // outcome first (the one word you scan for), then how long ago (exact
        // UTC on hover), the run, and the reply's facts.
        const sep = `<span class="sep">·</span>`;
        const run = r.last.runId
          ? sep + (r.last.runHref ? `<a href="${esc(r.last.runHref)}">run ${esc(r.last.runId.slice(0, 8))}</a>` : `run ${esc(r.last.runId.slice(0, 8))}`)
          : "";
        const summary = r.last.detail ? firingDetailSummary(r.last.detail) : "";
        const detail = summary ? `${sep}<span class="detail" title="${esc(r.last.detail ?? "")}">${esc(summary)}</span>` : "";
        last =
          `<span class="outcome ${OUTCOME_CLASS[r.last.outcome]}">${esc(OUTCOME_LABEL[r.last.outcome])}</span>${sep}` +
          `<span class="when" title="${esc(formatUtc(r.last.firedAt))}">${esc(formatRelative(r.last.firedAt, now))}</span>${run}${detail}`;
      } else {
        last = `<span class="muted">${firings.ok ? "never fired" : "unknown"}</span>`;
      }
      // One schedule = one block of two flowing lines (no table columns — the
      // wide empty gutters were the problem): the definition — name · cron ·
      // what it runs · next fire — and under it the last firing — outcome ·
      // when · run · the reply's facts — as ONE line, ellipsized.
      const sep = `<span class="sep">·</span>`;
      return (
        `<li data-schedule="${esc(r.name)}">` +
        `<div class="def">` +
        `<span class="name" title="${esc(r.description)}">${esc(r.name)}</span>${sep}` +
        `<code>${esc(r.cron)}</code> <span class="muted">UTC</span>${sep}` +
        `<span class="worker"><span class="lbl">on</span> <code>${esc(r.worker)}</code></span>${sep}` +
        `${what}${sep}` +
        `<span class="next"><span class="lbl">next</span> ${next}</span>` +
        `</div>` +
        `<div class="fire"><span class="lbl">last</span> ${last}</div>` +
        `</li>`
      );
    })
    .join("");
  const note = firings.ok ? "" : `<p class="note">Firing history unavailable: ${esc(firings.reason)}</p>`;
  return `<section id="scheduled" aria-label="Scheduled jobs"><ul class="schedules">${body}</ul>${note}</section>`;
}
