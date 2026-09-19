import { DAY_MS } from "./budgets.js";
import { blobColumn, blobOf, doubleColumn, doubleOf, POINT_COLUMNS, type RunMetricsPoint } from "./runMetrics.js";

// The run-metrics reader (docs/reference/specs/run-metrics.md): the config
// block, the SQL-API source seam, the three report queries and the pure report
// builder behind `metrics trend` and the /metrics page. Every query is written
// WEIGHTED — Analytics Engine samples under load and `_sample_interval` is each
// row's weight — so a count is `sum(_sample_interval)`, never `count()`, and a
// quantile is `quantileExactWeighted`, never over raw rows. Column positions
// come from `POINT_COLUMNS` (`blobColumn`/`doubleColumn`), never a magic
// number. The only user string that can reach a query is the agent filter,
// validated against the agent-name rule before interpolation; the range is two
// integers.

/** The `metrics:` config block, parsed: the dataset the reader queries (the
 *  same name the deployment profile binds on the state Worker) and the default
 *  range in days. */
export interface MetricsConfig {
  dataset: string;
  /** The default `?days` / `--days` range; 1..90, 30 unless configured. */
  days: number;
}

/** Analytics Engine's own dataset-name rule (the profile's `metrics.dataset` holds the same). */
export const METRICS_DATASET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The agent filter's rule — the one user string a query may carry, validated
 *  before interpolation. Agent names are lowercase words (`coding`,
 *  `unknown`); nothing here can close a quoted SQL string. */
export const METRICS_AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** The dataset's own retention (the platform's three months), named in every report's footer. */
export const METRICS_RETENTION_DAYS = 90;

/** The widest range a report may cover — the retention window. */
export const METRICS_MAX_DAYS = 90;

export const METRICS_DEFAULT_DAYS = 30;

/** Validates the `metrics:` config block. Absent → undefined (the reader off).
 *  A malformed block throws at startup by field, never a half-wired reader. */
export function parseMetricsConfig(raw: unknown): MetricsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("metrics: must be a mapping");
  const r = raw as Record<string, unknown>;
  if (typeof r.dataset !== "string" || !METRICS_DATASET_NAME.test(r.dataset))
    throw new Error(
      "metrics.dataset must be an Analytics Engine dataset name: 1–64 letters, digits and underscores, not starting with a digit",
    );
  const days = r.days === undefined ? METRICS_DEFAULT_DAYS : r.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > METRICS_MAX_DAYS)
    throw new Error(`metrics.days must be a whole number of days between 1 and ${METRICS_MAX_DAYS}`);
  return { dataset: r.dataset, days };
}

/** One result row as the SQL API's `data` carries it: the query's aliases as keys. */
export type MetricsRow = Record<string, unknown>;

/** Where the report's rows come from — the SQL API in production,
 *  `InMemoryMetricsSource` in tests, `NullMetricsSource` when the reader is off. */
export interface MetricsSource {
  query(sql: string): Promise<MetricsRow[]>;
}

/** A source read that failed: the HTTP status and the response's words, never the token. */
export class MetricsSourceError extends Error {
  override readonly name = "MetricsSourceError";
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`analytics engine sql ${status}: ${detail}`);
  }
}

/** The half-open query window and the one optional filter. */
export interface MetricsRange {
  sinceMs: number;
  untilMs: number;
  agent?: string;
}

/** The three report queries' texts, keyed by what each answers. */
export interface MetricsQueries {
  /** Runs per UTC day per status — the stacked day chart and the tiles' counts. */
  byDayStatus: string;
  /** One row per agent: runs, failed, p50/p95 wall, dollars, unpriced tokens, turns. */
  byAgent: string;
  /** p50 wall per UTC day per agent — the trend line the page draws per agent. */
  byDayAgentP50: string;
}

// The reader's column aliases, resolved from `POINT_COLUMNS` once: `index1` is
// the point's one index (the agent), the blobs and doubles by name.
const AGENT = `index${POINT_COLUMNS.index.length}` as const;
const STATUS = blobColumn("status");
const WALL = doubleColumn("wall");
const DOLLARS = doubleColumn("dollars");
const UNPRICED = doubleColumn("unpriced tokens");
const TURNS = doubleColumn("turns");

const DAY = "toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day";

/** The three report queries over `dataset` for `range` — the ONLY place query
 *  text is built. The since/until interpolations are two integers (epoch
 *  seconds); the agent, when given, is validated against `METRICS_AGENT_NAME`
 *  and quoted. Every aggregate is `_sample_interval`-weighted. */
export function metricsQueries(range: MetricsRange, dataset: string): MetricsQueries {
  if (!METRICS_DATASET_NAME.test(dataset)) throw new Error(`not an Analytics Engine dataset name: ${dataset}`);
  const since = Math.floor(range.sinceMs / 1000);
  const until = Math.ceil(range.untilMs / 1000);
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until))
    throw new Error("metrics range must be two finite timestamps");
  let where = `timestamp >= toDateTime(${since}) AND timestamp < toDateTime(${until})`;
  if (range.agent !== undefined) {
    if (!METRICS_AGENT_NAME.test(range.agent))
      throw new Error("metrics agent filter must be an agent name: lowercase letters, digits, hyphens, underscores");
    where += ` AND ${AGENT} = '${range.agent}'`;
  }
  return {
    byDayStatus: `SELECT ${DAY}, ${STATUS} AS status, sum(_sample_interval) AS runs FROM ${dataset} WHERE ${where} GROUP BY day, status ORDER BY day ASC`,
    byAgent:
      `SELECT ${AGENT} AS agent, sum(_sample_interval) AS runs, ` +
      `sumIf(_sample_interval, ${STATUS} = 'failed') AS failed, ` +
      `quantileExactWeighted(0.5)(${WALL}, _sample_interval) AS p50WallMs, ` +
      `quantileExactWeighted(0.95)(${WALL}, _sample_interval) AS p95WallMs, ` +
      `sum(${DOLLARS} * _sample_interval) AS usd, ` +
      `sum(${UNPRICED} * _sample_interval) AS unpricedTokens, ` +
      `sum(${TURNS} * _sample_interval) AS turns ` +
      `FROM ${dataset} WHERE ${where} GROUP BY agent ORDER BY runs DESC`,
    byDayAgentP50: `SELECT ${DAY}, ${AGENT} AS agent, quantileExactWeighted(0.5)(${WALL}, _sample_interval) AS p50WallMs FROM ${dataset} WHERE ${where} GROUP BY day, agent ORDER BY day ASC`,
  };
}

const CF_API = "https://api.cloudflare.com/client/v4";

/** The production source: the query text POSTed to the account's Analytics
 *  Engine SQL endpoint with the bearer in the header ONLY and `FORMAT JSON`
 *  appended; `data` is the rows. A non-2xx answer is a `MetricsSourceError`
 *  carrying the status and the response's words — the token appears in no
 *  error and no query. */
export class AnalyticsEngineSqlSource implements MetricsSource {
  private readonly accountId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { accountId: string; token: string; fetchImpl?: typeof fetch }) {
    this.accountId = opts.accountId;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async query(sql: string): Promise<MetricsRow[]> {
    const res = await this.fetchImpl(`${CF_API}/accounts/${this.accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: `${sql} FORMAT JSON`,
    });
    if (res.status < 200 || res.status >= 300)
      throw new MetricsSourceError(res.status, (await res.text()).slice(0, 300));
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body.data) ? (body.data as MetricsRow[]) : [];
  }
}

/** The off state: the reader is never asked (the service in front answers first). */
export class NullMetricsSource implements MetricsSource {
  query(): Promise<MetricsRow[]> {
    return Promise.resolve([]);
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** ClickHouse's `quantileExactWeighted`: sort by value, walk the cumulative
 *  weight, answer the first value at or past `q` of the total. */
function quantileExactWeighted(q: number, pairs: readonly { value: number; weight: number }[]): number {
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return 0;
  let cum = 0;
  for (const p of sorted) {
    cum += p.weight;
    if (cum >= q * total) return p.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

/** A UTC day's `toStartOfInterval` spelling, as the SQL API returns it. */
function dayOf(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 10)} 00:00:00`;
}

/** The in-memory source: evaluates the three `metricsQueries` texts over held
 *  points, each stamped at its own `finished at` double (production's write
 *  time is within a heartbeat of it), every point at weight 1. It recognises
 *  the queries by their GROUP BY and reads the range and the agent filter back
 *  out of the text, so a test proves the texts and the arithmetic together. */
export class InMemoryMetricsSource implements MetricsSource {
  constructor(private readonly points: readonly RunMetricsPoint[]) {}

  query(sql: string): Promise<MetricsRow[]> {
    const times = [...sql.matchAll(/toDateTime\((\d+)\)/g)].map((m) => Number(m[1]) * 1000);
    const sinceMs = times[0] ?? 0;
    const untilMs = times[1] ?? 0;
    const agent = new RegExp(`${AGENT} = '([^']*)'`).exec(sql)?.[1];
    const points = this.points.filter((p) => {
      const at = doubleOf(p, "finished at");
      return at >= sinceMs && at < untilMs && (agent === undefined || p.indexes[0] === agent);
    });
    if (sql.includes("GROUP BY day, status")) {
      const rows = new Map<string, { day: string; status: string; runs: number }>();
      for (const p of points) {
        const day = dayOf(doubleOf(p, "finished at"));
        const status = blobOf(p, "status");
        const row = rows.get(`${day}\n${status}`) ?? { day, status, runs: 0 };
        row.runs += 1;
        rows.set(`${day}\n${status}`, row);
      }
      return Promise.resolve([...rows.values()].sort((a, b) => a.day.localeCompare(b.day)));
    }
    if (sql.includes("GROUP BY day, agent")) {
      const groups = new Map<string, { day: string; agent: string; walls: { value: number; weight: number }[] }>();
      for (const p of points) {
        const day = dayOf(doubleOf(p, "finished at"));
        const key = `${day}\n${p.indexes[0]}`;
        const g = groups.get(key) ?? { day, agent: p.indexes[0], walls: [] };
        g.walls.push({ value: doubleOf(p, "wall"), weight: 1 });
        groups.set(key, g);
      }
      return Promise.resolve(
        [...groups.values()]
          .sort((a, b) => a.day.localeCompare(b.day))
          .map((g) => ({ day: g.day, agent: g.agent, p50WallMs: quantileExactWeighted(0.5, g.walls) })),
      );
    }
    const groups = new Map<string, RunMetricsPoint[]>();
    for (const p of points) groups.set(p.indexes[0], [...(groups.get(p.indexes[0]) ?? []), p]);
    return Promise.resolve(
      [...groups.entries()]
        .map(([name, ps]) => {
          const walls = ps.map((p) => ({ value: doubleOf(p, "wall"), weight: 1 }));
          return {
            agent: name,
            runs: ps.length,
            failed: ps.filter((p) => blobOf(p, "status") === "failed").length,
            p50WallMs: quantileExactWeighted(0.5, walls),
            p95WallMs: quantileExactWeighted(0.95, walls),
            usd: ps.reduce((s, p) => s + doubleOf(p, "dollars"), 0),
            unpricedTokens: ps.reduce((s, p) => s + doubleOf(p, "unpriced tokens"), 0),
            turns: ps.reduce((s, p) => s + doubleOf(p, "turns"), 0),
          };
        })
        .sort((a, b) => b.runs - a.runs),
    );
  }
}

/** The report's headline numbers. `p50WallMs`/`p95WallMs` are the runs-weighted
 *  mean of the per-agent quantiles — the three queries carry no all-agents
 *  quantile, and a weighted mean of medians is honest enough for a tile. */
export interface MetricsTiles {
  runs: number;
  failed: number;
  /** `failed / runs`, 0 over an empty window — rendered as a percentage. */
  failureRate: number;
  p50WallMs: number;
  p95WallMs: number;
  usd: number;
  unpricedTokens: number;
  turns: number;
}

export interface MetricsByDayRow {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  runs: number;
  byStatus: Record<string, number>;
}

export interface MetricsByAgentRow {
  agent: string;
  runs: number;
  failed: number;
  p50WallMs: number;
  p95WallMs: number;
  usd: number;
  unpricedTokens: number;
  turns: number;
}

export interface MetricsP50Row {
  day: string;
  agent: string;
  p50WallMs: number;
}

/** The report's provenance sentence, spelled once: points are bucketed at
 *  write time, priced at finish, counted at most once, kept 90 days. */
export interface MetricsReportRange {
  sinceMs: number;
  untilMs: number;
  days: number;
  agent?: string;
  bucket: "write time";
  retentionDays: typeof METRICS_RETENTION_DAYS;
  pricing: "at finish";
  completeness: "at most once";
}

export interface MetricsReport {
  dataset: string;
  tiles: MetricsTiles;
  /** One row per UTC day in range, zero-filled: an empty day is a zero row, never a gap. */
  byDay: MetricsByDayRow[];
  /** Largest first by runs. */
  byAgent: MetricsByAgentRow[];
  p50ByDayAgent: MetricsP50Row[];
  range: MetricsReportRange;
}

/** The three queries' rows, keyed as `metricsQueries` keys them. */
export interface MetricsReportRows {
  byDayStatus: MetricsRow[];
  byAgent: MetricsRow[];
  byDayAgentP50: MetricsRow[];
}

/** Pure: the report over the three queries' rows. An empty result is a
 *  zero-filled report — every UTC day in range present with zero runs — never
 *  an error. Everything but the `dataset` name, which the service in front knows. */
export function buildMetricsReport(
  rows: MetricsReportRows,
  range: { sinceMs: number; untilMs: number; days: number; agent?: string },
): Omit<MetricsReport, "dataset"> {
  const byStatusOfDay = new Map<string, Record<string, number>>();
  for (const row of rows.byDayStatus) {
    const day = String(row.day ?? "").slice(0, 10);
    const status = String(row.status ?? "");
    const perDay = byStatusOfDay.get(day) ?? {};
    perDay[status] = (perDay[status] ?? 0) + num(row.runs);
    byStatusOfDay.set(day, perDay);
  }
  const byDay: MetricsByDayRow[] = [];
  for (let ms = range.sinceMs; ms < range.untilMs; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const byStatus = byStatusOfDay.get(day) ?? {};
    byDay.push({ day, runs: Object.values(byStatus).reduce((s, n) => s + n, 0), byStatus });
  }
  const byAgent: MetricsByAgentRow[] = rows.byAgent
    .map((r) => ({
      agent: String(r.agent ?? ""),
      runs: num(r.runs),
      failed: num(r.failed),
      p50WallMs: num(r.p50WallMs),
      p95WallMs: num(r.p95WallMs),
      usd: num(r.usd),
      unpricedTokens: num(r.unpricedTokens),
      turns: num(r.turns),
    }))
    .sort((a, b) => b.runs - a.runs);
  const runs = byAgent.reduce((s, r) => s + r.runs, 0);
  const failed = byAgent.reduce((s, r) => s + r.failed, 0);
  const weighted = (of: (r: MetricsByAgentRow) => number): number =>
    runs > 0 ? byAgent.reduce((s, r) => s + of(r) * r.runs, 0) / runs : 0;
  return {
    tiles: {
      runs,
      failed,
      failureRate: runs > 0 ? failed / runs : 0,
      p50WallMs: weighted((r) => r.p50WallMs),
      p95WallMs: weighted((r) => r.p95WallMs),
      usd: byAgent.reduce((s, r) => s + r.usd, 0),
      unpricedTokens: byAgent.reduce((s, r) => s + r.unpricedTokens, 0),
      turns: byAgent.reduce((s, r) => s + r.turns, 0),
    },
    byDay,
    byAgent,
    p50ByDayAgent: rows.byDayAgentP50.map((r) => ({
      day: String(r.day ?? "").slice(0, 10),
      agent: String(r.agent ?? ""),
      p50WallMs: num(r.p50WallMs),
    })),
    range: {
      sinceMs: range.sinceMs,
      untilMs: range.untilMs,
      days: range.days,
      ...(range.agent !== undefined ? { agent: range.agent } : {}),
      bucket: "write time",
      retentionDays: METRICS_RETENTION_DAYS,
      pricing: "at finish",
      completeness: "at most once",
    },
  };
}
