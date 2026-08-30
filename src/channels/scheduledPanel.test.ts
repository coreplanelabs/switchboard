import { describe, expect, it } from "vitest";
import type { RunSummary } from "../core/runRegistry.js";
import type { ScheduleDef, ScheduleFiring } from "../core/schedules.js";

/** A registry-shaped fixture: the panel tests must not depend on the production
 *  registry's cron values (which move for live receipts, e.g. #197 / #244). */
export const FIXTURE_SCHEDULES: readonly ScheduleDef[] = [
  { name: "keep-alive", cron: "* * * * *", kind: "keep-alive", description: "Container keep-alive. Not a run." },
  { name: "self-improvement", cron: "0 14 * * 1", kind: "run", description: "Weekly self-improvement pass.", command: "friction propose", identity: "cron" },
];
import { buildScheduledRows, formatRelative, formatUtc, renderScheduledPanel, type FiringsState } from "./scheduledPanel.js";

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
  it("lists every registry schedule with kind, cron, command/identity, and a computed next fire", () => {
    const rows = buildScheduledRows(FIXTURE_SCHEDULES, none, [], NOW);
    expect(rows.map((r) => r.name)).toEqual(["keep-alive", "self-improvement"]);
    const [keepAlive, si] = rows;
    expect(keepAlive).toMatchObject({ kind: "keep-alive", cron: "* * * * *", nextFireAt: Date.UTC(2026, 7, 29, 12, 35) });
    expect(keepAlive.command).toBeUndefined();
    expect(si).toMatchObject({ kind: "run", cron: "0 14 * * 1", command: "friction propose", identity: "cron", nextFireAt: Date.UTC(2026, 7, 31, 14, 0) });
    expect(si.last).toBeUndefined();
  });

  it("attaches the last firing: fired-at, outcome, run id, and a bare /runs/<id> link when the run is no longer live", () => {
    const [, si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [], NOW);
    expect(si.last).toEqual({
      firedAt: Date.UTC(2026, 7, 24, 14, 0, 3),
      outcome: "completed",
      runId: "run-abc12345",
      runHref: "/runs/run-abc12345",
      detail: "🔍 109 runs analyzed — filed 2",
    });
  });

  it("links the run WITH its capability token while it is live in the registry", () => {
    const [, si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [liveRun("run-abc12345")], NOW);
    expect(si.last?.runHref).toBe("/runs/run-abc12345?t=tok");
  });

  it("a firing without a run (misconfigured / ingress-error) has no run id or link", () => {
    const [, si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ runId: undefined, outcome: "ingress-error", detail: "HTTP 503 disabled" })] }, [], NOW);
    expect(si.last).toEqual({ firedAt: firing().firedAt, outcome: "ingress-error", detail: "HTTP 503 disabled" });
  });

  it("ignores firings for schedules no longer in the registry; unavailable history → rows without `last`", () => {
    const rows = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ schedule: "retired" })] }, [], NOW);
    expect(rows.every((r) => r.last === undefined)).toBe(true);
    const unavailable = buildScheduledRows(FIXTURE_SCHEDULES, { ok: false, reason: "schedules.worker not configured" }, [], NOW);
    expect(unavailable.every((r) => r.last === undefined)).toBe(true);
  });

  it("an unparseable cron in a schedule yields no next fire rather than a crash", () => {
    const bad: ScheduleDef = { name: "broken", cron: "nope", kind: "keep-alive", description: "x" };
    expect(buildScheduledRows([bad], none, [], NOW)[0].nextFireAt).toBeUndefined();
  });

  it("URL-encodes a hostile run id in the href", () => {
    const [, si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ runId: 'x"/><b>' })] }, [], NOW);
    expect(si.last?.runHref).toBe("/runs/x%22%2F%3E%3Cb%3E");
  });
});

describe("renderScheduledPanel", () => {
  it("renders one row per schedule with UTC times, relative hints, outcome class, and the run link", () => {
    const rows = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [], NOW);
    const html = renderScheduledPanel(rows, { ok: true, firings: [firing()] }, NOW);
    expect(html).toContain('<section id="scheduled"');
    expect(html).toContain('<tr data-schedule="keep-alive">');
    expect(html).toContain("keep-alive — not a run");
    expect(html).toContain('<tr data-schedule="self-improvement">');
    expect(html).toContain("<code>friction propose</code>");
    expect(html).toContain("<code>cron</code>");
    expect(html).toContain("2026-08-31 14:00 UTC");
    expect(html).toContain("(in 2d 1h)");
    expect(html).toContain("2026-08-24 14:00 UTC");
    expect(html).toContain('<span class="outcome ok">completed</span>');
    expect(html).toContain('<a href="/runs/run-abc12345">run run-abc1</a>');
    expect(html).toContain("🔍 109 runs analyzed — filed 2");
    expect(html).not.toContain("Firing history unavailable");
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
