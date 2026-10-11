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
import { DAY_MS, MINUTE_MS } from "../budgets.js";
import type { ReviewsService } from "../reviewsService.js";
import { systemClock } from "../trace/clock.js";
import { FeedbackQueryInputError, type ReviewFeedbackReport } from "../reviewFeedbackReport.js";
import { isPublicationRepo } from "../branchPublication.js";

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
    /** The review report's service (record 0097); off, its Null Object answers `unavailable`. */
    reviews(): Promise<ReviewsService>;
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
  return [
    head,
    tileLine,
    ...(byAgent.length === 0 ? ["(no runs in this range)"] : byAgent.map(line)),
    ...feedbackLines(o.feedback as unknown as ReviewFeedbackReport | undefined),
    footer,
  ].join("\n");
}

function feedbackLines(report: ReviewFeedbackReport | undefined): string[] {
  if (!report) return [];
  if (report.status === "unavailable") return ["• Human review feedback is unavailable."];
  if (report.status === "not_applicable") return ["• Human review feedback applies to the review agent."];
  const c = report.total;
  const score = c.helpfulClearShare === null ? "—" : pct(c.helpfulClearShare);
  return [
    `• Review feedback: ${c.positiveOnly} positive-only reviews · ${c.negativeOnly} negative-only · ${c.mixed} mixed`,
    `• Helpful among clear ratings: ${score} (${c.positiveOnly}/${c.positiveOnly + c.negativeOnly}); rating coverage ${c.ratedReviews}/${c.freshComplete}; current reads ${c.freshComplete}/${c.eligible}; ${c.distinctRaters} raters on ${c.distinctPrs} PRs`,
    ...report.weekly.map(
      (g) =>
        `• Published ${g.key}: ${g.counts.positiveOnly} positive-only · ${g.counts.negativeOnly} negative-only · ${g.counts.mixed} mixed · ${g.counts.freshComplete}/${g.counts.eligible} checked`,
    ),
    "Current ratings of reviews published in each week; later votes and removals revise the trend.",
  ];
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
    "The run trend from the metrics dataset: runs, failure rate, p50/p95 wall and dollars per day and per agent over the range, weighted for sampling as text or JSON; review dashboard tabs use metrics reviews; nothing written.",
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
      throw new CommandError("unavailable", `metrics by run unavailable: ${kind}: ${message}`);
    }
  },
});

/** A whole UTC day, `YYYY-MM-DD`. */
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The review report's default range in whole UTC days ending today. */
const REVIEWS_DEFAULT_DAYS = 7;

const minutes = (ms: unknown): string => `${Math.round(num(ms) / MINUTE_MS)}m`;

/** A tile as `good of total (ratio)`. */
function tileText(label: string, t: unknown): string {
  const o = (t ?? {}) as JsonObject;
  return `${label} ${num(o.good)} of ${num(o.total)} (${pct(o.ratio)})`;
}

/** The text surfaces' review report: a header naming the range and the
 *  dataset; one usage bullet; the four tiles as good of total; one line per
 *  requester, most runs first; the footer sentence. */
function renderReviews(output: JsonValue): string {
  const o = output as JsonObject;
  const range = (o.range ?? {}) as JsonObject;
  const usage = (o.usage ?? {}) as JsonObject;
  const system = (o.system ?? {}) as JsonObject;
  const tiles = (system.tiles ?? {}) as JsonObject;
  const duration = (usage.duration ?? {}) as JsonObject;
  const verdicts = (usage.verdicts ?? {}) as JsonObject;
  const requesters = (Array.isArray(usage.byRequester) ? usage.byRequester : []) as JsonObject[];
  const reviews = num(verdicts.approved) + num(verdicts.changes_requested);
  const prs = num(usage.pullRequests);
  const lastDay = typeof range.toMs === "number" ? range.toMs - DAY_MS : undefined;
  return [
    `metrics reviews · ${day(range.fromMs)} → ${day(lastDay)} (${String(range.days)}d) · dataset ${String(o.dataset)}`,
    `• ${num(usage.runs)} review runs · ${num(usage.succeeded)} succeeded · ${reviews} reviews over ${prs} pull request${prs === 1 ? "" : "s"}` +
      ` · ${minutes(usage.wallMs)} running · p50 ${minutes(duration.p50Ms)} · p95 ${minutes(duration.p95Ms)}`,
    `• ${[
      tileText("run success", tiles.runSuccessRate),
      tileText("warm start", tiles.warmStartShare),
      tileText("lost at setup", tiles.lostAtSetup),
      tileText("reviews with a verdict", tiles.reviewsWithVerdict),
    ].join(" · ")}`,
    ...(requesters.length === 0
      ? ["(no review runs in this range)"]
      : requesters.map(
          (r) =>
            `• ${String(r.requester)} — ${num(r.runs)} runs · ${num(r.succeeded)} succeeded · ${minutes(r.wallMs)} running`,
        )),
    `bucketed by ${String(range.bucket)} · counted ${String(range.completeness)}`,
  ].join("\n");
}

/** `--from`/`--to` as a half-open millisecond range: whole UTC days, both included. */
export function reviewsRangeOf(options: { from?: string; to?: string }, now: number): { fromMs: number; toMs: number } {
  // A real calendar day only: `Date.parse` rolls a day the month lacks
  // forward (February 29 of a common year reads as March 1), so the parsed
  // day must spell the same date back.
  const dayStart = (d: string): number => {
    const ms = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d ? ms : Number.NaN;
  };
  const toMs = options.to !== undefined ? dayStart(options.to) + DAY_MS : now - (now % DAY_MS) + DAY_MS;
  const fromMs = options.from !== undefined ? dayStart(options.from) : toMs - REVIEWS_DEFAULT_DAYS * DAY_MS;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs))
    throw new CommandError("invalid_input", "--from and --to are UTC days, YYYY-MM-DD");
  if (toMs <= fromMs) throw new CommandError("invalid_input", "--from must be on or before --to");
  if (toMs - fromMs > METRICS_MAX_DAYS * DAY_MS)
    throw new CommandError("invalid_input", `a review report covers at most ${METRICS_MAX_DAYS} days`);
  return { fromMs, toMs };
}

export const metricsReviews = defineCommand({
  id: "metrics.reviews",
  options: z.object({
    from: z
      .string()
      .regex(UTC_DAY)
      .optional()
      .describe("the first UTC day, YYYY-MM-DD (default: seven days ending today)"),
    to: z.string().regex(UTC_DAY).optional().describe("the last UTC day, YYYY-MM-DD, included (default: today)"),
  }),
  action: "metrics:read",
  effect: "read",
  enabledWhen: (caps) => caps.metrics,
  describe:
    "The review dashboard's report from the metrics dataset: review runs by requester and surface, time spent, reviews per pull request, verdicts and findings, and the system tiles (run success, warm starts, setup losses), weighted for sampling; nothing written.",
  render: renderReviews,
  handler: async ({ options, deps }) => {
    const range = reviewsRangeOf(options, systemClock());
    const service = await deps.metrics.reviews();
    try {
      return (await service.reviews(range)) as unknown as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === METRICS_OFF_MESSAGE) throw new CommandError("unavailable", message);
      const kind = err instanceof Error ? err.name : "Error";
      throw new CommandError("unavailable", `review metrics unavailable: ${kind}: ${message}`);
    }
  },
});

const feedbackOptions = z
  .object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(METRICS_MAX_DAYS)
      .optional()
      .describe("publication range in whole UTC days, 1..90; cannot be combined with an exact run lookup"),
    repo: z.string().refine(isPublicationRepo, "repo must be owner/name").optional().describe("only this repository"),
    pr: z.coerce.number().int().positive().safe().optional().describe("only this pull request; requires repo"),
    rating: z
      .enum(["positive", "negative", "mixed", "unrated"])
      .optional()
      .describe(
        "effective human votes; positive/negative include mixed and last-known ratings; state complete selects current data",
      ),
    state: z
      .enum(["complete", "missing_identity", "pending", "stale", "unavailable", "content_changed"])
      .optional()
      .describe("only this read state"),
    limit: z.coerce.number().int().min(1).max(100).optional().describe("reviews per page, 1..100 (default 20)"),
    after: z.string().min(1).max(512).optional().describe("nextCursor from the previous page of the same query"),
    run: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        "exact review run ID; returns the retained publication and reaction snapshot across the full 90-day retention",
      ),
  })
  .superRefine((value, ctx) => {
    if (value.pr !== undefined && !value.repo)
      ctx.addIssue({ code: "custom", path: ["pr"], message: "pr requires repo" });
    if (value.run && Object.keys(value).some((k) => k !== "run"))
      ctx.addIssue({
        code: "custom",
        path: ["run"],
        message: "An exact run lookup cannot be combined with list filters",
      });
  });

export const metricsFeedback = defineCommand({
  id: "metrics.feedback",
  options: feedbackOptions,
  action: "metrics:read",
  effect: "read",
  enabledWhen: (caps) => caps.metrics,
  describe:
    "Find human feedback on native PR reviews or retrieve an exact retained reaction snapshot by run ID. Returns PR/review links, reviewed head, snapshot status and stable reaction/actor IDs for investigation. Stored reads only; no review, model run or GitHub write is started.",
  render: (output) => {
    const result = output as JsonObject;
    const rows = (result.reviews ?? []) as JsonObject[];
    return [
      `Review feedback: ${num(result.matching)} matching reviews`,
      ...rows.map(
        (r) =>
          `• ${String(r.repo)}#${num(r.pr)} · ${String(r.state)} · 👍 ${num(r.positiveVotes)} / 👎 ${num(r.negativeVotes)} · run ${String(r.runId)}${r.url ? ` · ${String(r.url)}` : ""}`,
      ),
      ...(result.nextCursor ? [`Next page: repeat this query with after=${String(result.nextCursor)}`] : []),
      String(result.evidenceLimit),
    ].join("\n");
  },
  handler: async ({ options, deps }) => {
    const parsed = feedbackOptions.safeParse(options);
    if (!parsed.success) throw new CommandError("invalid_input", parsed.error.issues.map((i) => i.message).join("; "));
    try {
      return (await (await deps.metrics.service()).feedback(parsed.data)) as unknown as JsonValue;
    } catch (error) {
      if (error instanceof FeedbackQueryInputError) throw new CommandError("invalid_input", error.message);
      throw new CommandError(
        "unavailable",
        "Human review feedback is unavailable; collection must be enabled and its retained data accessible.",
      );
    }
  },
});

export const metricsCommands: readonly CommandDef<MetricsCommandDeps>[] = [
  metricsTrend,
  metricsReviews,
  metricsFeedback,
] as unknown as CommandDef<MetricsCommandDeps>[];

export function registerMetricsCommands<D extends MetricsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of metricsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
