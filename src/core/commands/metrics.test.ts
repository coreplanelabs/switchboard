import { describe, expect, it } from "vitest";
import { CommandError, type Caller, type JsonValue } from "../commandRegistry.js";
import { MetricsSourceError, type MetricsReport } from "../metrics.js";
import { METRICS_OFF_MESSAGE, NullMetricsService, type MetricsService } from "../metricsService.js";
import { metricsTrend } from "./metrics.js";

// `metrics trend` (docs/reference/specs/run-metrics.md item 9): the trend
// report on every surface — its refusals (off, a failing source) and its text
// render (header, tiles, one line per agent largest first, the footer).

const caller = {
  kind: "chat",
  id: "slack:UCASEY",
  actor: { kind: "user", id: "slack:UCASEY", grants: { actions: "all", channels: "all", repos: "all" } },
} as Caller;

// The window's edges, formatted the way the fixture and the assertions need
// them — computed, so the fixture carries no literal dates.
const SINCE = Date.UTC(2026, 0, 2);
const UNTIL = Date.UTC(2026, 0, 9);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const REPORT: MetricsReport = {
  dataset: "switchboard_runs",
  tiles: {
    runs: 20,
    failed: 2,
    failureRate: 0.1,
    p50WallMs: 3_500,
    p95WallMs: 41_000,
    usd: 1.23,
    unpricedTokens: 0,
    turns: 87,
  },
  byDay: [{ day: isoDay(SINCE), runs: 20, byStatus: { completed: 18, failed: 2 } }],
  byAgent: [
    {
      agent: "coding",
      runs: 15,
      failed: 2,
      p50WallMs: 4_000,
      p95WallMs: 41_000,
      usd: 0.9,
      unpricedTokens: 0,
      turns: 60,
    },
    {
      agent: "review",
      runs: 5,
      failed: 0,
      p50WallMs: 200_000,
      p95WallMs: 300_000,
      usd: 0.33,
      unpricedTokens: 0,
      turns: 27,
    },
  ],
  p50ByDayAgent: [],
  range: {
    sinceMs: SINCE,
    untilMs: UNTIL,
    days: 7,
    agent: undefined as unknown as string,
    bucket: "write time",
    retentionDays: 90,
    pricing: "at finish",
    completeness: "at most once",
  },
};
delete (REPORT.range as unknown as Record<string, unknown>).agent;

const service = (report: () => Promise<MetricsReport>): MetricsService => ({ report });

const invoke = (svc: MetricsService, options: Record<string, unknown> = {}) =>
  metricsTrend.handler({ args: [], options, caller, deps: { metrics: { service: async () => svc } } } as never);

describe("metrics.trend", () => {
  it("answers the service's report — the JSON twin's shape — passing --days and --agent through", async () => {
    const asked: unknown[] = [];
    const svc = service(async () => REPORT);
    const spied: MetricsService = {
      report: (opts) => {
        asked.push(opts);
        return svc.report();
      },
    };
    const out = await invoke(spied, { days: 7, agent: "coding" });
    expect(out).toEqual(REPORT as unknown as JsonValue);
    expect(asked).toEqual([{ days: 7, agent: "coding" }]);
    await invoke(spied, {});
    expect(asked[1]).toEqual({});
  });

  it("off is `unavailable` with the off message", async () => {
    const err = await invoke(new NullMetricsService()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "unavailable", message: METRICS_OFF_MESSAGE });
  });

  it("a source error is `unavailable` naming the error's class, never the token", async () => {
    const err = await invoke(service(() => Promise.reject(new MetricsSourceError(403, "authentication error")))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "unavailable" });
    expect(String((err as Error).message)).toBe(
      "run metrics unavailable: MetricsSourceError: analytics engine sql 403: authentication error",
    );
  });

  it("renders the header, the tiles bullet with the failed share as a percentage (2 in 20 → 10%), one line per agent largest first, and the footer", () => {
    const text = metricsTrend.render!(REPORT as unknown as JsonValue);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`metrics trend · ${isoDay(SINCE)} → ${isoDay(UNTIL)} (7d) · dataset switchboard_runs`);
    expect(lines[1]).toBe("• 20 runs · failed 2 (10%) · p50 wall 3.5s · p95 wall 41.0s · LLM $1.23 · turns 87");
    expect(lines[2]).toBe("• coding — 15 runs · failed 2 (13%) · p50 4.0s · p95 41.0s · LLM $0.90 · turns 60");
    expect(lines[3]).toBe("• review — 5 runs · failed 0 (0%) · p50 3m · p95 5m · LLM $0.33 · turns 27");
    expect(lines[4]).toBe("bucketed by write time · priced at finish · counted at most once · kept 90 days");
    // Chat-safe on every surface: no aligned columns to collapse.
    expect(text).not.toMatch(/ {2,}/);
  });

  it("renders an agent-filtered, empty report with the filter in the header and no agent lines", () => {
    const empty: MetricsReport = {
      ...REPORT,
      byAgent: [],
      tiles: { ...REPORT.tiles, runs: 0, failed: 0, failureRate: 0, usd: 0, turns: 0, p50WallMs: 0, p95WallMs: 0 },
      range: { ...REPORT.range, agent: "coding" },
    };
    const text = metricsTrend.render!(empty as unknown as JsonValue);
    expect(text).toContain("· agent coding · dataset switchboard_runs");
    expect(text).toContain("(no runs in this range)");
  });
});
