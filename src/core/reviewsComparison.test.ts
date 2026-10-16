import { describe, expect, it } from "vitest";
import { DAY_MS, MINUTE_MS } from "./budgets.js";
import { reviewsComparisonOf, reviewsComparisonRangesOf } from "./reviewsComparison.js";
import { buildReviewsReport, type ReviewsRange } from "./reviewsReport.js";
import type { ReviewsService } from "./reviewsService.js";

// docs/reference/specs/run-metrics.md item 12: the Week over week tab compares
// the range with the same range whole weeks earlier, cut at the same point.

const DAY0 = Date.UTC(2026, 0, 4);
const week = { fromMs: DAY0, toMs: DAY0 + 7 * DAY_MS };

describe("reviewsComparisonRangesOf", () => {
  it("cuts a range that includes today at the same five-minute mark one week earlier", () => {
    const now = DAY0 + 6 * DAY_MS + 9 * 60 * MINUTE_MS + 17 * MINUTE_MS + 4_000;
    const cut = DAY0 + 6 * DAY_MS + 9 * 60 * MINUTE_MS + 15 * MINUTE_MS;
    expect(reviewsComparisonRangesOf(week, now)).toEqual({
      shiftDays: 7,
      current: { fromMs: DAY0, toMs: cut },
      previous: { fromMs: DAY0 - 7 * DAY_MS, toMs: cut - 7 * DAY_MS },
    });
  });

  it("compares a closed range whole, and shifts by whole weeks so weekdays line up", () => {
    const now = DAY0 + 30 * DAY_MS;
    expect(reviewsComparisonRangesOf(week, now).current).toEqual(week);
    const eightDays = { fromMs: DAY0, toMs: DAY0 + 8 * DAY_MS };
    expect(reviewsComparisonRangesOf(eightDays, now)).toEqual({
      shiftDays: 14,
      current: eightDays,
      previous: { fromMs: DAY0 - 14 * DAY_MS, toMs: DAY0 - 6 * DAY_MS },
    });
  });

  it("keeps a non-empty window just after midnight", () => {
    const today = { fromMs: DAY0, toMs: DAY0 + DAY_MS };
    expect(reviewsComparisonRangesOf(today, DAY0 + 1_000).current).toEqual({ fromMs: DAY0, toMs: DAY0 + 1 });
  });

  it("names an earlier window the 90-day dataset no longer keeps instead of reading it", () => {
    const now = DAY0 + 90 * DAY_MS;
    const ninety = { fromMs: DAY0 + DAY_MS, toMs: now };
    expect(reviewsComparisonRangesOf(ninety, now)).toMatchObject({ shiftDays: 91, unavailable: "before_retention" });
  });
});

describe("reviewsComparisonOf", () => {
  const empty = {
    runs: [],
    durationByRequester: [],
    durationBySurface: [],
    durationOverall: [],
    durationHistogram: [],
    reviews: [],
    setup: [],
    byWorkspace: [],
  };
  const recording = () => {
    const asked: ReviewsRange[] = [];
    const service: ReviewsService = {
      reviews: async (range) => {
        asked.push(range);
        return { dataset: "d", feedback: { status: "unavailable", asOf: 0 }, ...buildReviewsReport(empty, range) };
      },
    };
    return { asked, service };
  };

  it("reads both windows through the service and drops the main report's dataset and feedback", async () => {
    const { asked, service } = recording();
    const out = await reviewsComparisonOf(service, week, DAY0 + 30 * DAY_MS);
    expect(asked).toEqual([week, { fromMs: DAY0 - 7 * DAY_MS, toMs: DAY0 }]);
    expect(out).toMatchObject({
      shiftDays: 7,
      current: { range: { fromMs: DAY0 } },
      previous: { range: { fromMs: DAY0 - 7 * DAY_MS } },
    });
    expect(out.current).not.toHaveProperty("dataset");
    expect(out.current).not.toHaveProperty("feedback");
  });

  it("reads only the current window when the earlier one is out of retention", async () => {
    const { asked, service } = recording();
    const now = DAY0 + 90 * DAY_MS;
    const out = await reviewsComparisonOf(service, { fromMs: DAY0 + DAY_MS, toMs: now }, now);
    expect(asked).toHaveLength(1);
    expect(out).toMatchObject({ unavailable: "before_retention" });
    expect(out).not.toHaveProperty("previous");
  });
});
