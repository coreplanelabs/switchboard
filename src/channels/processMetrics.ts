import { monitorEventLoopDelay } from "node:perf_hooks";

// Process metrics for `/healthz` (features/slack-channel.md item 8): the bot is
// one Node process on a small container, and under many concurrent runs the
// first failure is the process itself (heap, then the event loop) — invisible
// from Slack, and container stdout is not in Workers Logs. RSS and heap come
// from `process.memoryUsage()`; event-loop lag is the p99 of the sampling
// histogram since the previous read, so consecutive `/healthz` polls read
// consecutive windows.

export interface ProcessMetrics {
  rssMb: number;
  heapUsedMb: number;
  /** p99 event-loop delay over the window since the last read, in ms. */
  eventLoopLagP99Ms: number;
}

/** Start the event-loop histogram; the returned sampler reads and resets it. */
export function startProcessMetrics(): () => ProcessMetrics {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return () => {
    const mem = process.memoryUsage();
    // The histogram reports nanoseconds; an empty window reads 0.
    const p99 = histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
    histogram.reset();
    return {
      rssMb: Math.round(mem.rss / 1_048_576),
      heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
      eventLoopLagP99Ms: Math.round(p99 * 10) / 10,
    };
  };
}
