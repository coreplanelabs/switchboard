import { DAY_MS } from "./budgets.js";
import {
  buildMetricsReport,
  metricsQueries,
  METRICS_MAX_DAYS,
  type MetricsConfig,
  type MetricsReport,
  type MetricsSource,
} from "./metrics.js";
import { systemClock } from "./trace/clock.js";
import type { ReviewFeedbackStore } from "./reviewFeedback.js";
import { buildReviewFeedbackReport, type ReviewFeedbackReport } from "./reviewFeedbackReport.js";
import { redactAndCap } from "./redact.js";

// The metrics service (docs/reference/specs/run-metrics.md): what `metrics
// trend`, the /metrics page and its JSON twin talk to. One `report` per read —
// three SQL queries for run metrics and optional retained snapshots for human
// feedback. GitHub collection happens outside page loads. A process without
// the run-metrics reader hands the Null Object.

export const METRICS_OFF_MESSAGE =
  "Metrics by run aren't configured — metrics.dataset in config (beside the costs block's Cloudflare account and analytics token) enables this view.";

export interface MetricsService {
  /** The trend report for the range: `days` (1..90; default from config) ending today, optionally one agent's runs. */
  report(opts?: { days?: number; agent?: string }): Promise<MetricsReport>;
}

export class NullMetricsService implements MetricsService {
  report(): Promise<MetricsReport> {
    return Promise.reject(new Error(METRICS_OFF_MESSAGE));
  }
}

/** The start of `ms`'s UTC day. */
function utcDayStart(ms: number): number {
  return ms - (ms % DAY_MS);
}

export function createMetricsService(
  cfg: MetricsConfig,
  source: MetricsSource,
  deps: { now?: () => number; feedback?: ReviewFeedbackStore; warn?: (message: string) => void } = {},
): MetricsService {
  const now = deps.now ?? systemClock;
  return {
    async report(opts = {}) {
      const days = opts.days ?? cfg.days;
      if (!Number.isInteger(days) || days < 1 || days > METRICS_MAX_DAYS)
        throw new Error(`metrics days must be a whole number between 1 and ${METRICS_MAX_DAYS}`);
      // The window is whole UTC days ending today (today included, still
      // filling): exactly `days` rows for the zero-filled day table.
      const untilMs = utcDayStart(now()) + DAY_MS;
      const sinceMs = untilMs - days * DAY_MS;
      const range = { sinceMs, untilMs, ...(opts.agent !== undefined ? { agent: opts.agent } : {}) };
      const queries = metricsQueries(range, cfg.dataset);
      const feedbackRead = async (): Promise<ReviewFeedbackReport | undefined> => {
        if (!cfg.feedback?.enabled) return undefined;
        const asOf = now();
        if (opts.agent !== undefined && opts.agent !== "review") return { status: "not_applicable", asOf };
        try {
          if (!deps.feedback) throw new Error("Feedback storage unavailable");
          const stored = await deps.feedback.list(sinceMs, untilMs);
          return buildReviewFeedbackReport(stored, range, now(), cfg.feedback);
        } catch (error) {
          const reason = redactAndCap(
            error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error",
            200,
          ).replace(/\s+/g, " ");
          deps.warn?.(`Human review feedback unavailable: ${reason}`);
          return { status: "unavailable", asOf };
        }
      };
      const [byDayStatus, byAgent, byDayAgentP50, feedback] = await Promise.all([
        source.query(queries.byDayStatus),
        source.query(queries.byAgent),
        source.query(queries.byDayAgentP50),
        feedbackRead(),
      ]);
      return {
        dataset: cfg.dataset,
        ...buildMetricsReport({ byDayStatus, byAgent, byDayAgentP50 }, { ...range, days }),
        ...(feedback ? { feedback } : {}),
      };
    },
  };
}
