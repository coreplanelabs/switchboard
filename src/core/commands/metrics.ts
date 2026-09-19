import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { METRICS_AGENT_NAME, METRICS_MAX_DAYS } from "../metrics.js";
import { METRICS_OFF_MESSAGE, type MetricsService } from "../metricsService.js";

// `metrics.trend` (docs/reference/specs/run-metrics.md item 9): the run trend
// over the Analytics Engine dataset every finished run's point lands in — the
// tiles, the per-day counts and the by-agent table, weighted for sampling, the
// same report the /metrics page and its JSON twin serve. Derived forms:
// `metrics trend` in chat and on the CLI, `GET /api/metrics.trend`, the
// `metrics_trend` MCP tool. Action `metrics:read`, the `costs.by` grant shape:
// a browser session's baseline, a grant for a Slack user or a token, never a
// chat baseline. Off (`caps.metrics`) is hidden; a source that fails answers
// `unavailable` naming the error's class.

export interface MetricsCommandDeps {
  metrics: {
    /** The service; a process without the reader hands the Null Object, whose report is `unavailable`. */
    service(): Promise<MetricsService>;
  };
}

const defineCommand = commandDefiner<MetricsCommandDeps>();

const money = (v: unknown): string => (typeof v === "number" ? `$${v.toFixed(2)}` : "-");

const pct = (rate: unknown): string => `${Math.round((typeof rate === "number" ? rate : 0) * 100)}%`;

/** A wall time for a tile: seconds under two minutes, minutes above. */
function wall(v: unknown): string {
  const seconds = (typeof v === "number" && Number.isFinite(v) ? v : 0) / 1000;
  return seconds < 120 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`;
}

const day = (ms: unknown): string => (typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "-");

/** The text surfaces' report: a header naming the range, the agent filter and
 *  the dataset; the tiles as one ` · `-joined bullet; one line per agent row
 *  largest first; the footer sentence naming the bucket, the pricing and the
 *  completeness. Bullets on every surface — columns would collapse in chat. */
function renderTrend(output: JsonValue): string {
  const o = output as JsonObject;
  const range = (o.range ?? {}) as JsonObject;
  const tiles = (o.tiles ?? {}) as JsonObject;
  const byAgent = (Array.isArray(o.byAgent) ? o.byAgent : []) as JsonObject[];
  const head =
    `metrics trend · ${day(range.sinceMs)} → ${day(range.untilMs)} (${String(range.days)}d)` +
    (typeof range.agent === "string" ? ` · agent ${range.agent}` : "") +
    ` · dataset ${String(o.dataset)}`;
  const tileLine =
    `• ${num(tiles.runs)} runs · failed ${num(tiles.failed)} (${pct(tiles.failureRate)})` +
    ` · p50 wall ${wall(tiles.p50WallMs)} · p95 wall ${wall(tiles.p95WallMs)}` +
    ` · LLM ${money(tiles.usd)} · turns ${num(tiles.turns)}` +
    (num(tiles.unpricedTokens) > 0 ? ` · ${num(tiles.unpricedTokens)} unpriced tokens` : "");
  const line = (r: JsonObject) =>
    `• ${String(r.agent)} — ${num(r.runs)} runs · failed ${num(r.failed)} (${pct(num(r.runs) > 0 ? num(r.failed) / num(r.runs) : 0)})` +
    ` · p50 ${wall(r.p50WallMs)} · p95 ${wall(r.p95WallMs)} · LLM ${money(r.usd)} · turns ${num(r.turns)}`;
  const footer = `bucketed by ${String(range.bucket)} · priced ${String(range.pricing)} · counted ${String(range.completeness)} · kept ${String(range.retentionDays)} days`;
  return [head, tileLine, ...(byAgent.length === 0 ? ["(no runs in this range)"] : byAgent.map(line)), footer].join(
    "\n",
  );
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const metricsTrend = defineCommand({
  id: "metrics.trend",
  options: z.object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(METRICS_MAX_DAYS)
      .optional()
      .describe(`the range in whole UTC days ending today (default 30, at most ${METRICS_MAX_DAYS})`),
    agent: z
      .string()
      .regex(METRICS_AGENT_NAME)
      .optional()
      .describe("only this agent's runs (the point's index; an agent name)"),
  }),
  action: "metrics:read",
  effect: "read",
  enabledWhen: (caps) => caps.metrics,
  describe:
    "The run trend from the metrics dataset: runs, failure rate, p50/p95 wall and dollars per day and per agent over the range, weighted for sampling — the /metrics page's report as text or JSON; nothing written.",
  render: renderTrend,
  handler: async ({ options, deps }) => {
    const service = await deps.metrics.service();
    try {
      const report = await service.report({
        ...(options.days === undefined ? {} : { days: options.days }),
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      });
      return report as unknown as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === METRICS_OFF_MESSAGE) throw new CommandError("unavailable", message);
      // A source that failed names its class (run-metrics.md item 9): the
      // status rides the message, the token never does.
      const kind = err instanceof Error ? err.name : "Error";
      throw new CommandError("unavailable", `run metrics unavailable: ${kind}: ${message}`);
    }
  },
});

export const metricsCommands: readonly CommandDef<MetricsCommandDeps>[] = [
  metricsTrend,
] as unknown as CommandDef<MetricsCommandDeps>[];

export function registerMetricsCommands<D extends MetricsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of metricsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
