import { describe, expect, it } from "vitest";
import type { RunSummary } from "../core/runRegistry.js";
import type { ScheduleDef, ScheduleFiring } from "../core/schedules.js";

/** A registry-shaped fixture: the panel tests must not depend on the production
 *  registry's cron values (which move for live receipts, e.g. #197 / #244). */
export const FIXTURE_SCHEDULES: readonly ScheduleDef[] = [
  { name: "keep-alive", cron: "* * * * *", worker: "bot", internal: true, description: "Container keep-alive. Not a run.", action: { type: "healthz" } },
  { name: "self-improvement", cron: "0 14 * * 1", worker: "bot", description: "Weekly self-improvement pass.", action: { type: "run", command: "friction propose", identity: "cron" } },
  { name: "resident-watchdog", cron: "*/10 * * * *", worker: "resident", description: "Resident watchdog pass.", action: { type: "watchdog" } },
];
import { buildScheduledRows, firingDetailSummary, formatRelative, formatUtc, renderScheduledPanel, type FiringsState } from "./scheduledPanel.js";

// Feature: features/live-view.md item 14 (#244): the /runs "Scheduled" panel —
// what is armed, next fire (computed), last fire + outcome, link to the run.

const NOW = Date.UTC(2026, 7, 29, 12, 34, 56); // Sat
const none: FiringsState = { ok: true, firings: [] };
const firing = (over: Partial<ScheduleFiring> = {}): ScheduleFiring => ({
  schedule: "self-improvement",
  firedAt: Date.UTC(2026, 7, 24, 14, 0, 3),
  outcome: "completed",
  runId: "run-abc12345",
  detail: "🔍 109 runs analyzed — filed 2",
  ...over,
});
const liveRun = (id: string): RunSummary => ({ id, token: "tok", finished: false, startedAt: NOW, eventCount: 1 });

describe("buildScheduledRows", () => {
  it("lists every non-internal schedule with worker, action, cron, and a computed next fire; internal plumbing (keep-alive) is hidden", () => {
    const rows = buildScheduledRows(FIXTURE_SCHEDULES, none, [], NOW);
    expect(rows.map((r) => r.name)).toEqual(["self-improvement", "resident-watchdog"]);
    const [si, wd] = rows;
    expect(si).toMatchObject({ worker: "bot", cron: "0 14 * * 1", action: { type: "run", command: "friction propose", identity: "cron" }, nextFireAt: Date.UTC(2026, 7, 31, 14, 0) });
    expect(si.last).toBeUndefined();
    expect(wd).toMatchObject({ worker: "resident", cron: "*/10 * * * *", action: { type: "watchdog" }, nextFireAt: Date.UTC(2026, 7, 29, 12, 40) });
  });

  it("a firing for a non-run schedule attaches without a run link", () => {
    const f = firing({ schedule: "resident-watchdog", runId: undefined, detail: "3/10 residents · 0 re-armed · 0 timed out · 0 errors" });
    const [, wd] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [f] }, [], NOW);
    expect(wd.last).toEqual({ firedAt: f.firedAt, outcome: "completed", detail: f.detail });
  });

  it("attaches the last firing: fired-at, outcome, run id, and a bare /runs/<id> link when the run is no longer live", () => {
    const [si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [], NOW);
    expect(si.last).toEqual({
      firedAt: Date.UTC(2026, 7, 24, 14, 0, 3),
      outcome: "completed",
      runId: "run-abc12345",
      runHref: "/runs/run-abc12345",
      detail: "🔍 109 runs analyzed — filed 2",
    });
  });

  it("links the run WITH its capability token while it is live in the registry", () => {
    const [si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [liveRun("run-abc12345")], NOW);
    expect(si.last?.runHref).toBe("/runs/run-abc12345?t=tok");
  });

  it("a firing without a run (misconfigured / ingress-error) has no run id or link", () => {
    const [si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ runId: undefined, outcome: "ingress-error", detail: "HTTP 503 disabled" })] }, [], NOW);
    expect(si.last).toEqual({ firedAt: firing().firedAt, outcome: "ingress-error", detail: "HTTP 503 disabled" });
  });

  it("ignores firings for schedules no longer in the registry; unavailable history → rows without `last`", () => {
    const rows = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ schedule: "retired" })] }, [], NOW);
    expect(rows.every((r) => r.last === undefined)).toBe(true);
    const unavailable = buildScheduledRows(FIXTURE_SCHEDULES, { ok: false, reason: "schedules.worker not configured" }, [], NOW);
    expect(unavailable.every((r) => r.last === undefined)).toBe(true);
  });

  it("an unparseable cron in a schedule yields no next fire rather than a crash", () => {
    const bad: ScheduleDef = { name: "broken", cron: "nope", worker: "bot", description: "x", action: { type: "healthz" } };
    expect(buildScheduledRows([bad], none, [], NOW)[0].nextFireAt).toBeUndefined();
  });

  it("URL-encodes a hostile run id in the href", () => {
    const [si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ runId: 'x"/><b>' })] }, [], NOW);
    expect(si.last?.runHref).toBe("/runs/x%22%2F%3E%3Cb%3E");
  });
});

describe("renderScheduledPanel", () => {
  it("renders one row per schedule with UTC times, relative hints, outcome class, and the run link", () => {
    const rows = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [], NOW);
    const html = renderScheduledPanel(rows, { ok: true, firings: [firing()] }, NOW);
    expect(html).toContain('<section id="scheduled"');
    expect(html).not.toContain('data-schedule="keep-alive"');
    expect(html).toContain('<li data-schedule="self-improvement">');
    expect(html).toContain("<code>friction propose</code>");
    expect(html).toContain("<code>cron</code>");
    expect(html).toContain('<li data-schedule="resident-watchdog">');
    expect(html).toContain("resident watchdog — not a run");
    expect(html).toContain('<span class="worker"><span class="lbl">on</span> <code>bot</code></span>');
    expect(html).toContain("<code>resident</code>");
    expect(html).toContain("<b>2026-08-31 14:00 UTC</b>");
    expect(html).toContain("(in 2d 1h)");
    expect(html).toContain('<span class="outcome ok">succeeded</span>');
    expect(html).toContain('<a href="/runs/run-abc12345">run run-abc1</a>');
    // Line 2 is ONE line: outcome · how long ago (exact UTC on hover) · run · the reply's facts (emoji dropped)
    expect(html).toContain(
      '<div class="fire"><span class="lbl">last</span> <span class="outcome ok">succeeded</span><span class="sep">·</span><span class="when" title="2026-08-24 14:00 UTC">4d 22h ago</span><span class="sep">·</span><a href="/runs/run-abc12345">run run-abc1</a><span class="sep">·</span><span class="detail" title="🔍 109 runs analyzed — filed 2">109 runs analyzed — filed 2</span></div>',
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Firing history unavailable");
  });

  it("the detail is the reply's facts, not its title: a leading `*Title* —` and emoji are dropped, long text is cut", () => {
    expect(firingDetailSummary("🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns · 1 filed")).toBe("244 runs analyzed · 23 recurring patterns · 1 filed");
    expect(firingDetailSummary("🔍 109 runs analyzed — filed 2")).toBe("109 runs analyzed — filed 2");
    expect(firingDetailSummary("HTTP 401 unauthorized")).toBe("HTTP 401 unauthorized");
    // legacy records flattened the whole reply into one line: cut at a sentence-ish width
    const legacy = "🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns 1. `slow_tool:npm test` — 22 runs · 23× · 29m 9s · high 2. `slow_tool:npm test, npm run build` — 18 runs · 18× · 27m 26s · high 3. more";
    expect(firingDetailSummary(legacy)).toBe("244 runs analyzed · 23 recurring patterns"); // the head ends where the list begins
    const long = firingDetailSummary("x".repeat(200));
    expect(long.length).toBe(121);
    expect(long.endsWith("…")).toBe(true);
    expect(firingDetailSummary("   ")).toBe("");
  });

  it("never fired → says so; unavailable history → a note with the reason and `unknown` cells", () => {
    expect(renderScheduledPanel(buildScheduledRows(FIXTURE_SCHEDULES, none, [], NOW), none, NOW)).toContain("never fired");
    const off: FiringsState = { ok: false, reason: "schedules.worker not configured" };
    const html = renderScheduledPanel(buildScheduledRows(FIXTURE_SCHEDULES, off, [], NOW), off, NOW);
    expect(html).toContain("Firing history unavailable: schedules.worker not configured");
    expect(html).toContain(">unknown<");
  });

  it("bad outcomes get the bad class and a plain-English label", () => {
    const f = firing({ runId: undefined, outcome: "misconfigured", detail: 'SWITCHBOARD_INGRESS_TOKENS has no entry with subject "cron"' });
    const html = renderScheduledPanel(buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [f] }, [], NOW), { ok: true, firings: [f] }, NOW);
    expect(html).toContain('<span class="outcome bad">misconfigured — nothing ran</span>');
    expect(html).toContain("has no entry with subject &quot;cron&quot;");
    expect(html).not.toContain("<a href");
  });

  it("escapes hostile detail/description text (no markup breakout)", () => {
    const f = firing({ detail: '<img src=x onerror=alert(1)>"' });
    const html = renderScheduledPanel(buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [f] }, [], NOW), { ok: true, firings: [f] }, NOW);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;");
  });
});

describe("time helpers", () => {
  it("formatUtc / formatRelative", () => {
    expect(formatUtc(Date.UTC(2026, 7, 31, 14, 0))).toBe("2026-08-31 14:00 UTC");
    expect(formatRelative(NOW + 30_000, NOW)).toBe("in <1m");
    expect(formatRelative(NOW + 45 * 60_000, NOW)).toBe("in 45m");
    expect(formatRelative(NOW + 3 * 3_600_000 + 60_000, NOW)).toBe("in 3h 1m");
    expect(formatRelative(NOW - 5 * 86_400_000, NOW)).toBe("5d 0h ago");
  });
});
