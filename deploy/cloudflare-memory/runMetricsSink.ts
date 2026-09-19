import type { RunMetricsPoint } from "../../src/core/runMetrics.ts";

// The run-metrics sink (docs/reference/specs/run-metrics.md): where the
// RunHistoryDO writes the one point of a run whose row turned final, after the
// record's commit. Two implementations behind one seam (AGENTS.md invariant 2):
// the Workers Analytics Engine dataset when the Worker is deployed with the
// optional `RUN_METRICS` binding, the null sink otherwise — so a Worker without
// the binding behaves byte-identically, the same shape as `SHIP_COORDINATOR?`.
// The write is advisory on the caller's side too: one try, one console.warn,
// never a failed put or finish.

export interface RunMetricsSink {
  write(point: RunMetricsPoint): void;
}

/** The dataset the deploy bound: `writeDataPoint` is synchronous and does not
 *  throw on a platform-side drop; the caller's try covers a missing or
 *  misconfigured binding. */
export class AnalyticsEngineSink implements RunMetricsSink {
  constructor(private readonly dataset: AnalyticsEngineDataset) {}
  write(point: RunMetricsPoint): void {
    this.dataset.writeDataPoint({ indexes: point.indexes, blobs: point.blobs, doubles: point.doubles });
  }
}

/** No binding: points are dropped — the off state. */
export class NullSink implements RunMetricsSink {
  write(): void {
    // nothing is written without the binding
  }
}
