import { describe, expect, it } from "vitest";
import { DAY_MS, REVIEWS_CACHE_OPEN_MS } from "./budgets.js";
import { METRICS_OFF_MESSAGE } from "./metricsService.js";
import type { MetricsRow, MetricsSource } from "./metrics.js";
import {
  createReviewsService,
  NullReviewsService,
  REVIEWS_CACHE_CLOSED_MS,
  REVIEWS_CACHE_SIZE,
} from "./reviewsService.js";

// Feature: record 0097, "The reader and the page" — eight reads per report,
// cached five minutes while the range fills and a day once it has ended.

const TODAY = Date.UTC(2026, 9, 11);

function countingSource(fail = false): MetricsSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    query(sql: string): Promise<MetricsRow[]> {
      reads.push(sql);
      return fail ? Promise.reject(new Error("analytics engine sql 500: boom")) : Promise.resolve([]);
    },
  };
}

describe("createReviewsService", () => {
  it("answers one report from eight reads, naming its dataset", async () => {
    const source = countingSource();
    const svc = createReviewsService({ dataset: "switchboard_runs" }, source, { now: () => TODAY + 3_600_000 });
    const report = await svc.reviews({ fromMs: TODAY - 6 * DAY_MS, toMs: TODAY + DAY_MS });
    expect(source.reads).toHaveLength(8);
    expect(report.dataset).toBe("switchboard_runs");
    expect(report.usage.byDay).toHaveLength(7);
  });

  it("reuses a range that includes today for five minutes, and one that ended for a day", async () => {
    let at = TODAY + 3_600_000;
    const source = countingSource();
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => at });
    const open = { fromMs: TODAY - DAY_MS, toMs: TODAY + DAY_MS };
    const closed = { fromMs: TODAY - 7 * DAY_MS, toMs: TODAY };
    await svc.reviews(open);
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(16);
    at += REVIEWS_CACHE_OPEN_MS - 1;
    await svc.reviews(open);
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(16);
    at += 2;
    await svc.reviews(open);
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(24);
    at += REVIEWS_CACHE_CLOSED_MS;
    await svc.reviews(closed);
    expect(source.reads).toHaveLength(32);
  });

  it("never reuses a failed read, and refuses a bad range before reading", async () => {
    const source = countingSource(true);
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => TODAY });
    const range = { fromMs: TODAY - DAY_MS, toMs: TODAY };
    await expect(svc.reviews(range)).rejects.toThrow(/500/);
    await expect(svc.reviews(range)).rejects.toThrow(/500/);
    expect(source.reads).toHaveLength(16);
    expect(() => svc.reviews({ fromMs: TODAY, toMs: TODAY - DAY_MS })).toThrow(/range/);
    expect(source.reads).toHaveLength(16);
  });

  it("holds at most a bounded number of ranges", async () => {
    const source = countingSource();
    const svc = createReviewsService({ dataset: "d" }, source, { now: () => TODAY });
    for (let i = 0; i <= REVIEWS_CACHE_SIZE; i++)
      await svc.reviews({ fromMs: TODAY - (i + 2) * DAY_MS, toMs: TODAY - DAY_MS });
    // The first range was dropped to make room, so asking again reads again.
    const before = source.reads.length;
    await svc.reviews({ fromMs: TODAY - 2 * DAY_MS, toMs: TODAY - DAY_MS });
    expect(source.reads.length).toBe(before + 8);
  });
});

describe("NullReviewsService", () => {
  it("refuses with the metrics-off sentence", async () => {
    await expect(new NullReviewsService().reviews()).rejects.toThrow(METRICS_OFF_MESSAGE);
  });
});
