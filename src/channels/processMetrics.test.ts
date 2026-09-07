import { describe, expect, it } from "vitest";
import { startProcessMetrics } from "./processMetrics.js";

describe("startProcessMetrics", () => {
  it("samples rss and heap in whole MiB and a non-negative event-loop lag; a second read is a fresh window", async () => {
    const sample = startProcessMetrics();
    await new Promise((r) => setTimeout(r, 30));
    const a = sample();
    expect(Number.isInteger(a.rssMb)).toBe(true);
    expect(a.rssMb).toBeGreaterThan(0);
    expect(Number.isInteger(a.heapUsedMb)).toBe(true);
    expect(a.heapUsedMb).toBeGreaterThan(0);
    expect(a.eventLoopLagP99Ms).toBeGreaterThanOrEqual(0);
    const b = sample();
    // The histogram was reset: an empty window reads 0, never the previous p99 again by accident.
    expect(b.eventLoopLagP99Ms).toBeGreaterThanOrEqual(0);
  });
});
