import { DAY_MS, REVIEWS_CACHE_OPEN_MS } from "./budgets.js";
import type { MetricsConfig, MetricsSource } from "./metrics.js";
import { METRICS_OFF_MESSAGE } from "./metricsService.js";
import { buildReviewsReport, reviewsQueries, type ReviewsRange, type ReviewsReport } from "./reviewsReport.js";
import { systemClock } from "./trace/clock.js";

// The review dashboard's service (record 0097, "The reader and the page"):
// what `metrics reviews`, the review tabs and their JSON twin talk to. One
// report per range: the eight queries in parallel against the run-metrics
// source, the pure builder over their rows. Each answer is cached, five
// minutes while its range is still filling and a day once it ended before
// today, so a page someone keeps open costs a handful of reads an hour.

/** How long an answer for a range that ended before today is reused. */
export const REVIEWS_CACHE_CLOSED_MS = DAY_MS;
/** How many distinct ranges the cache holds; the oldest answer goes first. */
export const REVIEWS_CACHE_SIZE = 32;

export type ReviewsReportWithDataset = ReviewsReport & { dataset: string };

export interface ReviewsService {
  /** The review report for `[fromMs, toMs)`, at most 90 days. */
  reviews(range: ReviewsRange): Promise<ReviewsReportWithDataset>;
}

export class NullReviewsService implements ReviewsService {
  reviews(): Promise<ReviewsReportWithDataset> {
    return Promise.reject(new Error(METRICS_OFF_MESSAGE));
  }
}

export function createReviewsService(
  cfg: Pick<MetricsConfig, "dataset">,
  source: MetricsSource,
  deps: { now?: () => number } = {},
): ReviewsService {
  const now = deps.now ?? systemClock;
  const cache = new Map<string, { until: number; report: Promise<ReviewsReportWithDataset> }>();
  return {
    reviews(range) {
      // The texts are built first, so a bad range is refused before any read.
      const queries = reviewsQueries(range, cfg.dataset);
      const at = now();
      const key = `${range.fromMs}:${range.toMs}`;
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > at) return hit.report;
      const todayStart = at - (at % DAY_MS);
      const report = (async () => {
        const [
          runs,
          durationByRequester,
          durationBySurface,
          durationOverall,
          durationHistogram,
          reviews,
          setup,
          byWorkspace,
        ] = await Promise.all([
          source.query(queries.runs),
          source.query(queries.durationByRequester),
          source.query(queries.durationBySurface),
          source.query(queries.durationOverall),
          source.query(queries.durationHistogram),
          source.query(queries.reviews),
          source.query(queries.setup),
          source.query(queries.byWorkspace),
        ]);
        return {
          dataset: cfg.dataset,
          ...buildReviewsReport(
            {
              runs,
              durationByRequester,
              durationBySurface,
              durationOverall,
              durationHistogram,
              reviews,
              setup,
              byWorkspace,
            },
            range,
          ),
        };
      })();
      cache.delete(key);
      cache.set(key, {
        until: at + (range.toMs <= todayStart ? REVIEWS_CACHE_CLOSED_MS : REVIEWS_CACHE_OPEN_MS),
        report,
      });
      // A failed read is never reused: the next ask reads again.
      report.catch(() => {
        if (cache.get(key)?.report === report) cache.delete(key);
      });
      while (cache.size > REVIEWS_CACHE_SIZE) cache.delete(cache.keys().next().value!);
      return report;
    },
  };
}
