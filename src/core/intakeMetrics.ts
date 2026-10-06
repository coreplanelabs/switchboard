import type { IntakeReceipt } from "./runLedger/types.js";
import type { RunMetricsPoint } from "./runMetrics.js";
import { METRICS_DATASET_NAME, type MetricsSource } from "./metrics.js";

export const INTAKE_POINT_SCHEMA = "intake-1";
export const INTAKE_POINT_COLUMNS = {
  blobs: [
    "schema",
    "experiment",
    "arm",
    "model",
    "servedModel",
    "verdict",
    "source",
    "thread",
    "message",
    "traffic",
    "abstained",
  ],
  doubles: [
    "elapsedMs",
    "calls",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "knownCostUsd",
    "unpricedCalls",
    "missingUsageCalls",
    "confidence",
    "addressedProbability",
    "silentProbability",
    "unsureProbability",
    "decidedAt",
  ],
} as const;

/** No prompt, message text or model-written reason crosses this boundary. */
export function intakePointOf(row: IntakeReceipt): RunMetricsPoint | undefined {
  const e = row.experiment;
  if (!e) return undefined;
  const blobs = [
    INTAKE_POINT_SCHEMA,
    e.id,
    e.arm,
    row.model,
    e.servedModel ?? "",
    row.verdict,
    row.source,
    row.threadKey,
    e.messageKey,
    row.threadKey.startsWith("probe:") ? "probe" : "live",
    row.source === "model" && row.reason.startsWith("unsure:") ? "yes" : "no",
  ];
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(e.id) ||
    blobs.reduce((n, value) => n + new TextEncoder().encode(value).length, 0) > 16_384
  )
    throw new Error("intake telemetry dimensions exceed the platform limits");
  return {
    indexes: [e.id],
    blobs,
    doubles: [
      e.elapsedMs,
      e.calls,
      e.inputTokens,
      e.outputTokens,
      e.cacheReadTokens,
      e.cacheWriteTokens,
      e.knownCostUsd,
      e.unpricedCalls,
      e.missingUsageCalls,
      e.confidence ?? -1,
      e.probabilities?.addressed ?? -1,
      e.probabilities?.silent ?? -1,
      e.probabilities?.unsure ?? -1,
      row.decidedAt,
    ],
  };
}

export interface IntakeTelemetryOptions {
  dataset: string;
  experiment: string;
  sinceMs: number;
  untilMs: number;
  excludeThreads?: readonly string[];
  includeProbes?: boolean;
  samples?: boolean;
  sampleLimit?: number;
}

/** Closed identifiers and integer timestamps are the only interpolated values.
 * Counts, sums and quantiles include Analytics Engine's sampling weights. */
export function intakeTelemetryQueries(o: IntakeTelemetryOptions) {
  if (!METRICS_DATASET_NAME.test(o.dataset) || !/^[a-zA-Z0-9_-]{1,64}$/.test(o.experiment))
    throw new Error("intake telemetry needs valid dataset and experiment names");
  if (!Number.isSafeInteger(o.sinceMs) || !Number.isSafeInteger(o.untilMs) || o.untilMs <= o.sinceMs)
    throw new Error("intake telemetry needs an increasing pair of finite timestamps");
  const limit = o.sampleLimit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("intake sample limit must be 1–1000");
  const excluded = o.excludeThreads ?? [];
  if (excluded.length > 100 || excluded.some((key) => !/^[a-zA-Z0-9:_./#-]{1,256}$/.test(key)))
    throw new Error("invalid excluded intake thread");
  const where = [
    `blob1 = '${INTAKE_POINT_SCHEMA}'`,
    `blob2 = '${o.experiment}'`,
    `double14 >= ${o.sinceMs} AND double14 < ${o.untilMs}`,
    ...(o.includeProbes ? [] : ["blob10 = 'live'"]),
    ...(excluded.length ? [`blob8 NOT IN (${excluded.map((key) => `'${key}'`).join(", ")})`] : []),
  ].join(" AND ");
  const sums = INTAKE_POINT_COLUMNS.doubles
    .slice(1, 9)
    .map((name, i) => `sum(double${i + 2} * _sample_interval) AS ${name}`);
  return {
    summary:
      `SELECT blob3 AS arm, blob4 AS model, sum(_sample_interval) AS events, count(DISTINCT blob8) AS threadsObserved, ` +
      `sumIf(_sample_interval, blob6 = 'addressed') AS addressed, sumIf(_sample_interval, blob6 = 'silent') AS silent, ` +
      `sumIf(_sample_interval, blob7 = 'error') AS errors, sumIf(_sample_interval, blob7 = 'timeout') AS timeouts, ` +
      `sumIf(_sample_interval, blob11 = 'yes') AS unsure, ` +
      [50, 90, 95].map((p) => `quantileExactWeighted(${p / 100})(double1, _sample_interval) AS p${p}Ms`).join(", ") +
      `, ${sums.join(", ")}, max(_sample_interval) AS maxSampleInterval FROM ${o.dataset} WHERE ${where} GROUP BY arm, model ORDER BY arm, model`,
    samples:
      `SELECT blob8 AS threadKey, blob9 AS messageKey, blob3 AS arm, blob4 AS model, blob5 AS servedModel, blob6 AS verdict, ` +
      `blob7 AS source, double1 AS elapsedMs, double10 AS confidence, double11 AS addressedProbability, double12 AS silentProbability, ` +
      `double13 AS unsureProbability, double14 AS decidedAt, _sample_interval AS sampleInterval FROM ${o.dataset} WHERE ${where} ORDER BY decidedAt DESC LIMIT ${limit}`,
  };
}

export async function readIntakeTelemetry(source: MetricsSource, o: IntakeTelemetryOptions) {
  const queries = intakeTelemetryQueries(o);
  const fields = [
    "events",
    "threadsObserved",
    "addressed",
    "silent",
    "errors",
    "timeouts",
    "unsure",
    "p50Ms",
    "p90Ms",
    "p95Ms",
    ...INTAKE_POINT_COLUMNS.doubles.slice(1, 9),
    "maxSampleInterval",
  ] as const;
  const arms = (await source.query(queries.summary)).map((row) => {
    if (!["control", "jev"].includes(String(row.arm)) || typeof row.model !== "string")
      throw new Error("invalid intake telemetry result");
    const values = Object.fromEntries(
      fields.map((field) => {
        const raw = row[field];
        const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
        if (!Number.isFinite(value) || value < 0) throw new Error(`invalid intake telemetry ${field}`);
        return [field, value];
      }),
    ) as Record<(typeof fields)[number], number>;
    return {
      arm: String(row.arm),
      model: row.model,
      ...values,
      estimatedUsdPer1000:
        values.unpricedCalls === 0 && values.events > 0 ? (values.knownCostUsd * 1000) / values.events : null,
    };
  });
  return {
    source: "analytics-engine" as const,
    experiment: o.experiment,
    dataset: o.dataset,
    sinceMs: o.sinceMs,
    untilMs: o.untilMs,
    sampled: arms.some((arm) => arm.maxSampleInterval > 1),
    threadCountMeaning: "Distinct threads observed; a lower bound if telemetry is sampled.",
    arms,
    ...(o.samples ? { samples: await source.query(queries.samples), sampleLimit: o.sampleLimit ?? 200 } : {}),
  };
}
