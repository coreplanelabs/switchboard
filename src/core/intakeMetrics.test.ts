import { describe, expect, it } from "vitest";
import { intakePointOf, intakeTelemetryQueries, readIntakeTelemetry, INTAKE_POINT_COLUMNS } from "./intakeMetrics.js";
import type { IntakeReceipt } from "./runLedger/types.js";

const receipt = (verdict: "addressed" | "silent" = "silent"): IntakeReceipt => ({
  verdict,
  reason: "private conversation text must not be exported",
  source: "model",
  mode: "classify",
  model: "typesafe/jev-1.13.0",
  gen: 1,
  threadKey: "slack:C1:1.0",
  decidedAt: 1000,
  experiment: {
    id: "trial",
    messageKey: "C1:2.0",
    arm: "jev",
    elapsedMs: 150,
    calls: 1,
    inputTokens: 800,
    outputTokens: 42,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    knownCostUsd: 0.0000336,
    unpricedCalls: 0,
    missingUsageCalls: 0,
    servedModel: "typesafe/jev-1.13.0",
    probabilities: { addressed: 0.02, silent: 0.97, unsure: 0.01 },
    confidence: 0.96,
  },
});

describe("intake telemetry", () => {
  it("records addressed and silent classifier measurements without free text, and keeps full message identities", () => {
    for (const verdict of ["addressed", "silent"] as const) {
      const row = receipt(verdict);
      row.threadKey = "probe:" + "operator".repeat(20) + ":id";
      const point = intakePointOf(row)!;
      expect(point.indexes).toEqual(["trial"]);
      expect(point.blobs[0]).toBe("intake-1");
      expect(point.blobs[INTAKE_POINT_COLUMNS.blobs.indexOf("verdict")]).toBe(verdict);
      expect(point.blobs[INTAKE_POINT_COLUMNS.blobs.indexOf("thread")]).toBe(row.threadKey);
      expect(point.doubles[INTAKE_POINT_COLUMNS.doubles.indexOf("elapsedMs")]).toBe(150);
      expect(JSON.stringify(point)).not.toContain(row.reason);
    }
    const row = receipt();
    delete row.experiment;
    expect(intakePointOf(row)).toBeUndefined();
  });

  it("isolates intake schema, bounds the decision window, excludes probes, and weights counts and latency", () => {
    const q = intakeTelemetryQueries({
      dataset: "runs",
      experiment: "trial",
      sinceMs: 1000,
      untilMs: 9000,
      excludeThreads: ["slack:C1:1.0"],
    });
    for (const sql of Object.values(q)) {
      expect(sql).toContain("blob1 = 'intake-1'");
      expect(sql).toContain("blob2 = 'trial'");
      expect(sql).toContain("blob10 = 'live'");
      expect(sql).toContain("double14 >= 1000 AND double14 < 9000");
      expect(sql).toContain("blob8 NOT IN ('slack:C1:1.0')");
    }
    expect(q.summary).toContain("sum(_sample_interval)");
    expect(q.summary).toContain("quantileExactWeighted(0.95)(double1, _sample_interval)");
    expect(q.samples).toContain("LIMIT 200");
    expect(q.samples).toContain("ORDER BY decidedAt DESC");
    expect(() =>
      intakeTelemetryQueries({ dataset: "runs", experiment: "x' OR 1=1", sinceMs: 0, untilMs: 1 }),
    ).toThrow();
    expect(() =>
      intakeTelemetryQueries({ dataset: "bad-name", experiment: "trial", sinceMs: 0, untilMs: 1 }),
    ).toThrow();
    expect(() =>
      intakeTelemetryQueries({ dataset: "runs", experiment: "trial", sinceMs: Number.NaN, untilMs: 1 }),
    ).toThrow();
  });

  it("reports sampling and unknown cost honestly and queries samples only when requested", async () => {
    const queries: string[] = [];
    const source = {
      query: async (sql: string) => {
        queries.push(sql);
        return [
          {
            arm: "jev",
            model: "typesafe/jev-1.13.0",
            events: 20,
            threadsObserved: 2,
            addressed: 10,
            silent: 10,
            errors: 0,
            timeouts: 0,
            unsure: 0,
            p50Ms: 100,
            p90Ms: 150,
            p95Ms: 160,
            calls: 20,
            inputTokens: 16000,
            outputTokens: 840,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            knownCostUsd: 0,
            unpricedCalls: 20,
            missingUsageCalls: 0,
            maxSampleInterval: 10,
          },
        ];
      },
    };
    const report = await readIntakeTelemetry(source, {
      dataset: "runs",
      experiment: "trial",
      sinceMs: 0,
      untilMs: 2000,
    });
    expect(queries).toHaveLength(1);
    expect(report).toMatchObject({
      source: "analytics-engine",
      sampled: true,
      arms: [{ events: 20, threadsObserved: 2, estimatedUsdPer1000: null }],
    });
  });
});
