import { DAY_MS, REVIEWS_CACHE_OPEN_MS } from "./budgets.js";
import { METRICS_MAX_DAYS } from "./metrics.js";
import type { ReviewsRange, ReviewsReport } from "./reviewsReport.js";
import type { ReviewsReadScope, ReviewsReportWithDataset, ReviewsService } from "./reviewsService.js";

// The review dashboard's Week over week tab (docs/reference/specs/run-metrics.md
// item 12): the selected range beside the same range whole weeks earlier, so
// the same weekdays line up. A range still filling is cut at the same point in
// both windows, so a partial today is compared with the same partial day one
// shift earlier. Both windows are ordinary review reports from the same
// service; nothing here reads a run or an event.

/** A range still filling is cut at this granularity, so the cut range's cache key
 *  changes no faster than an open answer is reused. */
export const REVIEWS_COMPARE_CUT_MS = REVIEWS_CACHE_OPEN_MS;

/** The two windows the tab compares. */
export interface ReviewsComparisonRanges {
  current: ReviewsRange;
  previous: ReviewsRange;
  /** How far back the previous window starts: whole weeks covering the range. */
  shiftDays: number;
}

/** Why there is no previous window. */
export type ReviewsComparisonUnavailable = "before_retention";

export type ReviewsComparison =
  | { shiftDays: number; current: ReviewsReport; previous: ReviewsReport }
  | { shiftDays: number; current: ReviewsReport; unavailable: ReviewsComparisonUnavailable };

/** The windows for `range` at `now`, or why the previous one cannot be read:
 *  it would start before the 90 days the dataset keeps. */
export function reviewsComparisonRangesOf(
  range: ReviewsRange,
  now: number,
): ReviewsComparisonRanges | { shiftDays: number; current: ReviewsRange; unavailable: ReviewsComparisonUnavailable } {
  const shiftDays = Math.ceil((range.toMs - range.fromMs) / DAY_MS / 7) * 7;
  const shift = shiftDays * DAY_MS;
  const cut = range.toMs > now ? Math.max(now - (now % REVIEWS_COMPARE_CUT_MS), range.fromMs + 1) : range.toMs;
  const current = { fromMs: range.fromMs, toMs: cut };
  const previous = { fromMs: range.fromMs - shift, toMs: cut - shift };
  if (previous.fromMs < now - METRICS_MAX_DAYS * DAY_MS) return { shiftDays, current, unavailable: "before_retention" };
  return { shiftDays, current, previous };
}

/** Both windows' reports, read in parallel through the review service and its cache. */
export async function reviewsComparisonOf(
  service: ReviewsService,
  range: ReviewsRange,
  now: number,
  scope?: ReviewsReadScope,
): Promise<ReviewsComparison> {
  const ranges = reviewsComparisonRangesOf(range, now);
  // The tab compares run aggregates; feedback and the dataset ride the main report.
  const bare = ({ dataset: _dataset, feedback: _feedback, ...report }: ReviewsReportWithDataset): ReviewsReport =>
    report;
  if ("unavailable" in ranges) {
    const current = await service.reviews(ranges.current, scope);
    return { shiftDays: ranges.shiftDays, current: bare(current), unavailable: ranges.unavailable };
  }
  const [current, previous] = await Promise.all([
    service.reviews(ranges.current, scope),
    service.reviews(ranges.previous, scope),
  ]);
  return { shiftDays: ranges.shiftDays, current: bare(current), previous: bare(previous) };
}
