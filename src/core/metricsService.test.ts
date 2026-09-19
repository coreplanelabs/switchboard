import { describe, expect, it } from "vitest";
import { DAY_MS } from "./budgets.js";
import { parseMetricsConfig, type MetricsSource } from "./metrics.js";
import { createMetricsService, METRICS_OFF_MESSAGE, NullMetricsService } from "./metricsService.js";

// The metrics service (docs/reference/specs/run-metrics.md item 9): one report
// per read — the three queries against the source, the pure builder over their
// rows — and the Null Object for a process without the reader.

const NOW = Date.UTC(2026, 0, 8, 15, 30); // mid-afternoon UTC

function recordingSource(): { source: MetricsSource; queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    source: {
      query: (sql) => {
        queries.push(sql);
        return Promise.resolve([]);
      },
    },
  };
}

describe("createMetricsService", () => {
  const cfg = parseMetricsConfig({ dataset: "runs_v1", days: 7 })!;

  it("reports over whole UTC days ending today (today included), the default range from config", async () => {
    const { source, queries } = recordingSource();
    const report = await createMetricsService(cfg, source, { now: () => NOW }).report();
    expect(queries).toHaveLength(3);
    const until = Date.UTC(2026, 0, 9); // end of the 8th
    expect(report.range.untilMs).toBe(until);
    expect(report.range.sinceMs).toBe(until - 7 * DAY_MS);
    expect(report.range.days).toBe(7);
    expect(report.dataset).toBe("runs_v1");
    expect(report.byDay).toHaveLength(7);
    // The last row is today — the day the window's exclusive end closes.
    expect(report.byDay[6].day).toBe(new Date(until - DAY_MS).toISOString().slice(0, 10));
  });

  it("takes --days and --agent through to the queries; a range outside 1..90 is refused", async () => {
    const { source, queries } = recordingSource();
    const service = createMetricsService(cfg, source, { now: () => NOW });
    const report = await service.report({ days: 2, agent: "coding" });
    expect(report.range.days).toBe(2);
    expect(report.range.agent).toBe("coding");
    expect(report.byDay).toHaveLength(2);
    for (const sql of queries) expect(sql).toContain("index1 = 'coding'");
    await expect(service.report({ days: 0 })).rejects.toThrow(/between 1 and 90/);
    await expect(service.report({ days: 91 })).rejects.toThrow(/between 1 and 90/);
    await expect(service.report({ days: 1.5 })).rejects.toThrow(/between 1 and 90/);
  });

  it("the window's until is the next UTC midnight whatever the hour", async () => {
    const { source } = recordingSource();
    const atMidnight = await createMetricsService(cfg, source, { now: () => Date.UTC(2026, 0, 8) }).report({
      days: 1,
    });
    expect(atMidnight.range.untilMs).toBe(Date.UTC(2026, 0, 9));
    const lateNight = await createMetricsService(cfg, source, { now: () => Date.UTC(2026, 0, 8, 23, 59) }).report({
      days: 1,
    });
    expect(lateNight.range.untilMs).toBe(Date.UTC(2026, 0, 9));
  });
});

describe("NullMetricsService", () => {
  it("answers the off message, the sentence the command turns into `unavailable`", async () => {
    await expect(new NullMetricsService().report()).rejects.toThrow(METRICS_OFF_MESSAGE);
  });
});
