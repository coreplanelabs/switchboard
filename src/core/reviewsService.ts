import type { Predicate } from "./authz/types.js";
import { DAY_MS, REVIEWS_CACHE_OPEN_MS } from "./budgets.js";
import type { MetricsConfig, MetricsSource } from "./metrics.js";
import { METRICS_OFF_MESSAGE } from "./metricsService.js";
import { buildReviewsReport, reviewsQueries, type ReviewsRange, type ReviewsReport } from "./reviewsReport.js";
import type { ReviewFeedbackStore } from "./reviewFeedback.js";
import { buildReviewFeedbackReport, type ReviewFeedbackReport } from "./reviewFeedbackReport.js";
import { systemClock } from "./trace/clock.js";

// The review dashboard's service (record 0097, "The reader and the page"):
// what `metrics reviews`, the review tabs and their JSON twin talk to. One
// report per range: the eight queries in parallel against the run-metrics
// source, the pure builder over their rows. SQL answers are cached for five
// minutes while the range is still filling and a day once it ended. Mutable
// human feedback is read separately on each request.

/** How long an answer for a range that ended before today is reused. */
export const REVIEWS_CACHE_CLOSED_MS = DAY_MS;
/** How many distinct ranges the cache holds; the oldest answer goes first. */
export const REVIEWS_CACHE_SIZE = 32;

export type ReviewsReportWithDataset = ReviewsReport & { dataset: string; feedback?: ReviewFeedbackReport };

/** Caller and current read predicate are host facts, never request parameters. */
export interface ReviewsReadScope {
  subject: string;
  visibleTo: Predicate;
}

export interface ReviewsService {
  /** The review report for `[fromMs, toMs)`, at most 90 days. */
  reviews(range: ReviewsRange, scope?: ReviewsReadScope): Promise<ReviewsReportWithDataset>;
}

export class NullReviewsService implements ReviewsService {
  reviews(): Promise<ReviewsReportWithDataset> {
    return Promise.reject(new Error(METRICS_OFF_MESSAGE));
  }
}

export function createReviewsService(
  cfg: Pick<MetricsConfig, "dataset" | "feedback">,
  source: MetricsSource,
  deps: { now?: () => number; feedback?: ReviewFeedbackStore } = {},
): ReviewsService {
  const now = deps.now ?? systemClock;
  const cache = new Map<string, { until: number; report: Promise<ReviewsReportWithDataset> }>();
  return {
    reviews(range, scope) {
      if (scope && (!scope.subject || scope.subject.length > 2048 || /\p{Cc}/u.test(scope.subject)))
        throw new Error("invalid reviews read subject");
      // The texts are built first, so a bad range is refused before any read.
      if (scope && !scope.visibleTo) throw new Error("invalid reviews read scope");
      const queries = reviewsQueries(range, cfg.dataset, scope?.visibleTo);
      const at = now();
      const key = JSON.stringify([scope?.subject ?? null, cfg.dataset, range.fromMs, range.toMs, queries]);
      // Feedback is mutable after the report range closes. Reuse the SQL rows,
      // but read current retained votes on each page or JSON request.
      const currentFeedback = async (): Promise<ReviewFeedbackReport | undefined> => {
        if (!cfg.feedback?.enabled) return undefined;
        if (scope && scope.visibleTo.kind !== "all") return { status: "unavailable", asOf: now() };
        try {
          if (!deps.feedback) throw new Error("Feedback storage unavailable");
          const stored = await deps.feedback.list(range.fromMs, range.toMs);
          return buildReviewFeedbackReport(stored, { sinceMs: range.fromMs, untilMs: range.toMs }, now(), cfg.feedback);
        } catch {
          return { status: "unavailable", asOf: now() };
        }
      };
      const withFeedback = async (report: Promise<ReviewsReportWithDataset>) => {
        const [rows, feedback] = await Promise.all([report, currentFeedback()]);
        return feedback ? { ...rows, feedback } : rows;
      };
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > at) return withFeedback(hit.report);
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
          source.query(queries.runs, scope?.visibleTo),
          source.query(queries.durationByRequester, scope?.visibleTo),
          source.query(queries.durationBySurface, scope?.visibleTo),
          source.query(queries.durationOverall, scope?.visibleTo),
          source.query(queries.durationHistogram, scope?.visibleTo),
          source.query(queries.reviews, scope?.visibleTo),
          source.query(queries.setup, scope?.visibleTo),
          source.query(queries.byWorkspace, scope?.visibleTo),
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
      return withFeedback(report);
    },
  };
}
