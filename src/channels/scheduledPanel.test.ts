import { describe, expect, it } from "vitest";
import { NO_GRANTS } from "../core/authz/types.js";
import type { RunSummary } from "../core/runRegistry.js";
import type { ScheduleDef, ScheduleFiring } from "../core/schedules.js";

/** A registry-shaped fixture: the panel tests must not depend on the production
 *  registry's cron values (which move whenever a schedule is retimed). */
export const FIXTURE_SCHEDULES: readonly ScheduleDef[] = [
  {
    name: "keep-alive",
    cron: "* * * * *",
    worker: "bot",
    internal: true,
    description: "Container keep-alive. Not a run.",
    action: { type: "healthz" },
  },
  {
    name: "self-improvement",
    cron: "0 14 * * 1",
    worker: "bot",
    description: "Weekly self-improvement pass.",
    action: {
      type: "run",
      command: "friction propose",
      identity: "cron",
      actor: { kind: "schedule", id: "schedule:self-improvement", grants: NO_GRANTS },
    },
  },
  {
    name: "resident-watchdog",
    cron: "*/10 * * * *",
    worker: "resident",
    description: "Resident watchdog pass.",
    action: { type: "watchdog" },
  },
];
import { buildScheduledRows, firingDetailSummary, formatRelative, type FiringsState } from "./scheduledPanel.js";

// Feature: features/live-view.md item 14: the /runs "Scheduled" panel —
// what is armed, next fire (computed), last fire + outcome, link to the run.
// Rendering lives in web/src/pages/ScheduledPage.vue (tested there); these
// tests own the pure row model both sides share.

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
    expect(si).toMatchObject({
      worker: "bot",
      cron: "0 14 * * 1",
      action: { type: "run", command: "friction propose", identity: "cron" },
      nextFireAt: Date.UTC(2026, 7, 31, 14, 0),
    });
    expect(si.last).toBeUndefined();
    expect(wd).toMatchObject({
      worker: "resident",
      cron: "*/10 * * * *",
      action: { type: "watchdog" },
      nextFireAt: Date.UTC(2026, 7, 29, 12, 40),
    });
  });

  it("a firing for a non-run schedule attaches without a run link", () => {
    const f = firing({
      schedule: "resident-watchdog",
      runId: undefined,
      detail: "3/10 residents · 0 re-armed · 0 timed out · 0 errors",
    });
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

  it("carries the firing's trace id when the recorder stored one, and omits the key otherwise (features/tracing.md item 22)", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const [withTrace] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ traceId })] }, [], NOW);
    expect(withTrace.last?.traceId).toBe(traceId);
    const [without] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing()] }, [], NOW);
    expect(without.last).not.toHaveProperty("traceId");
  });

  it("links the run WITH its capability token while it is live in the registry", () => {
    const [si] = buildScheduledRows(
      FIXTURE_SCHEDULES,
      { ok: true, firings: [firing()] },
      [liveRun("run-abc12345")],
      NOW,
    );
    expect(si.last?.runHref).toBe("/runs/run-abc12345?t=tok");
  });

  it("a firing without a run (misconfigured / ingress-error) has no run id or link", () => {
    const [si] = buildScheduledRows(
      FIXTURE_SCHEDULES,
      { ok: true, firings: [firing({ runId: undefined, outcome: "ingress-error", detail: "HTTP 503 disabled" })] },
      [],
      NOW,
    );
    expect(si.last).toEqual({ firedAt: firing().firedAt, outcome: "ingress-error", detail: "HTTP 503 disabled" });
  });

  it("ignores firings for schedules no longer in the registry; unavailable history → rows without `last`", () => {
    const rows = buildScheduledRows(
      FIXTURE_SCHEDULES,
      { ok: true, firings: [firing({ schedule: "retired" })] },
      [],
      NOW,
    );
    expect(rows.every((r) => r.last === undefined)).toBe(true);
    const unavailable = buildScheduledRows(
      FIXTURE_SCHEDULES,
      { ok: false, reason: "schedules.worker not configured" },
      [],
      NOW,
    );
    expect(unavailable.every((r) => r.last === undefined)).toBe(true);
  });

  it("an unparseable cron in a schedule yields no next fire rather than a crash", () => {
    const bad: ScheduleDef = {
      name: "broken",
      cron: "nope",
      worker: "bot",
      description: "x",
      action: { type: "healthz" },
    };
    expect(buildScheduledRows([bad], none, [], NOW)[0].nextFireAt).toBeUndefined();
  });

  it("URL-encodes a hostile run id in the href", () => {
    const [si] = buildScheduledRows(FIXTURE_SCHEDULES, { ok: true, firings: [firing({ runId: 'x"/><b>' })] }, [], NOW);
    expect(si.last?.runHref).toBe("/runs/x%22%2F%3E%3Cb%3E");
  });
});

describe("firingDetailSummary", () => {
  it("the detail is the reply's facts, not its title: a leading `*Title* —` and emoji are dropped, long text is cut", () => {
    expect(firingDetailSummary("🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns · 1 filed")).toBe(
      "244 runs analyzed · 23 recurring patterns · 1 filed",
    );
    expect(firingDetailSummary("🔍 109 runs analyzed — filed 2")).toBe("109 runs analyzed — filed 2");
    expect(firingDetailSummary("HTTP 401 unauthorized")).toBe("HTTP 401 unauthorized");
    // legacy records flattened the whole reply into one line: cut at a sentence-ish width
    const legacy =
      "🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns 1. `slow_tool:npm test` — 22 runs · 23× · 29m 9s · high 2. `slow_tool:npm test, npm run build` — 18 runs · 18× · 27m 26s · high 3. more";
    expect(firingDetailSummary(legacy)).toBe("244 runs analyzed · 23 recurring patterns"); // the head ends where the list begins
    const long = firingDetailSummary("x".repeat(200));
    expect(long.length).toBe(121);
    expect(long.endsWith("…")).toBe(true);
    expect(firingDetailSummary("   ")).toBe("");
  });
});

describe("outcome vocabulary (shared with the web page)", () => {
  it("labels every outcome in plain English with its tone class", async () => {
    const { OUTCOME_CLASS, OUTCOME_LABEL } = await import("./scheduledPanel.js");
    expect(OUTCOME_LABEL.completed).toBe("succeeded");
    expect(OUTCOME_LABEL.misconfigured).toBe("misconfigured — nothing ran");
    expect(OUTCOME_LABEL.stopped_hard).toBe("killed");
    expect(OUTCOME_CLASS.completed).toBe("ok");
    expect(OUTCOME_CLASS.failed).toBe("bad");
    expect(OUTCOME_CLASS.stopped_soft).toBe("warn");
    expect(OUTCOME_CLASS["ingress-error"]).toBe("bad");
  });
});

describe("time helpers", () => {
  it("formatRelative", () => {
    expect(formatRelative(NOW + 30_000, NOW)).toBe("in <1m");
    expect(formatRelative(NOW + 45 * 60_000, NOW)).toBe("in 45m");
    expect(formatRelative(NOW + 3 * 3_600_000 + 60_000, NOW)).toBe("in 3h 1m");
    expect(formatRelative(NOW - 5 * 86_400_000, NOW)).toBe("5d 0h ago");
  });
});
