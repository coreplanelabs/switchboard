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

// The metrics service (docs/reference/specs/run-metrics.md): what `metrics
// trend`, the /metrics page and its JSON twin talk to. One `report` per read —
// the three queries against the source, the pure builder over their rows; no
// snapshot and no refresh loop, because the SQL API answers three sub-second
// queries per read. A process without the reader hands the Null Object.

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
  deps: { now?: () => number } = {},
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
      const [byDayStatus, byAgent, byDayAgentP50] = await Promise.all([
        source.query(queries.byDayStatus),
        source.query(queries.byAgent),
        source.query(queries.byDayAgentP50),
      ]);
      return {
        dataset: cfg.dataset,
        ...buildMetricsReport({ byDayStatus, byAgent, byDayAgentP50 }, { ...range, days }),
      };
    },
  };
}
