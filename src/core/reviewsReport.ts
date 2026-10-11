import type { Predicate } from "./authz/types.js";
import { DAY_MS, MINUTE_MS, REVIEWS_HISTOGRAM_OPEN_MS } from "./budgets.js";
import { METRICS_DATASET_NAME, METRICS_MAX_DAYS, metricsPredicate, type MetricsRow } from "./metrics.js";
import {
  blobColumn,
  doubleColumn,
  POINT_COLUMNS,
  POINT_SCHEMA,
  REVIEW_POINT_COLUMNS,
  REVIEW_POINT_SCHEMA,
  type ReviewBlobName,
  type ReviewDoubleName,
} from "./runMetrics.js";
import { FALLBACK_WORDS, LOST_WORDS } from "./runSetup.js";

// The review dashboard's reader (record 0097, "The reader and the page"): the
// eight query texts over the run and review rows, and the pure report built
// from their rows. Every count is `sum(_sample_interval)` and every quantile
// `quantileExactWeighted`, as the run-metrics reader writes them. Every
// aggregate filters and groups on the row's `finished at`, never its write
// time; the scan is bounded by write time widened a day on each side so the
// platform can prune. Column positions come from `POINT_COLUMNS` and
// `REVIEW_POINT_COLUMNS`, never a magic number; the only values interpolated
// are integers and the two schema words.

/** A report's half-open range, epoch milliseconds, at most `METRICS_MAX_DAYS`. */
export interface ReviewsRange {
  fromMs: number;
  toMs: number;
}

/** The eight query texts, keyed by what each answers. */
export interface ReviewsQueries {
  /** Review run rows by finish day, outcome, surface and requester: counts, time spent, the largest sample interval. */
  runs: string;
  /** Weighted p50/p95 duration of successful review runs, by requester. */
  durationByRequester: string;
  /** The same by surface. */
  durationBySurface: string;
  /** The same over every successful review run in range. */
  durationOverall: string;
  /** Review runs per duration bucket (whole minutes, the last bucket open). */
  durationHistogram: string;
  /** Review rows by repository, pull request and verdict, with findings by severity. */
  reviews: string;
  /** Review run rows by finish day, workspace, setup reason and error type. */
  setup: string;
  /** Weighted p50 duration and time to ready of review runs, by workspace. */
  byWorkspace: string;
}

/** The histogram's last bucket: runs of this many minutes or more. */
export const HISTOGRAM_OPEN_MINUTES = REVIEWS_HISTOGRAM_OPEN_MS / MINUTE_MS;

const runBlob = (name: (typeof POINT_COLUMNS.blobs)[number]): string => blobColumn(name);
const runDouble = (name: (typeof POINT_COLUMNS.doubles)[number]): string => doubleColumn(name);
const reviewBlob = (name: ReviewBlobName): string => `blob${REVIEW_POINT_COLUMNS.blobs.indexOf(name) + 1}`;
const reviewDouble = (name: ReviewDoubleName): string => `double${REVIEW_POINT_COLUMNS.doubles.indexOf(name) + 1}`;

const RUN_INDEX = `index${POINT_COLUMNS.index.length}`;
const WALL = runDouble("wall");
const READY = runDouble("getting ready");

/** A row's UTC finish day, from its own `finished at` double (milliseconds). */
const finishDay = (finishedAt: string): string =>
  `toStartOfInterval(toDateTime(intDiv(${finishedAt}, 1000)), INTERVAL '1' DAY)`;

/** The eight report queries over `dataset` for `range` — the ONLY place their
 *  text is built. */
export function reviewsQueries(range: ReviewsRange, dataset: string, visibleTo?: Predicate): ReviewsQueries {
  if (!METRICS_DATASET_NAME.test(dataset)) throw new Error(`not an Analytics Engine dataset name: ${dataset}`);
  const { fromMs, toMs } = range;
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs)
    throw new Error("a reviews range is two whole-millisecond timestamps, from before to");
  if (toMs - fromMs > METRICS_MAX_DAYS * DAY_MS) throw new Error(`a reviews range is at most ${METRICS_MAX_DAYS} days`);
  // The scan's write-time bound, a day wider on each side: a row is written
  // seconds after its finish, never a day late.
  const scan =
    `timestamp >= toDateTime(${Math.floor((fromMs - DAY_MS) / 1000)}) ` +
    `AND timestamp < toDateTime(${Math.ceil((toMs + DAY_MS) / 1000)})`;
  const runFinish = runDouble("finished at");
  const reviewFinish = reviewDouble("finished at");
  const runs =
    `${scan} AND ${runBlob("schema")} = '${POINT_SCHEMA}' AND ${RUN_INDEX} = 'review' ` +
    `AND ${runFinish} >= ${fromMs} AND ${runFinish} < ${toMs}` +
    (visibleTo
      ? ` AND ${metricsPredicate(visibleTo, { requester: runBlob("requester"), channel: runBlob("channel"), repository: runBlob("repository"), channelVisibility: "unknown", normalizeRepository: true })}`
      : "");
  const successes = `${runs} AND ${runBlob("outcome")} = 'success'`;
  const reviews =
    `${scan} AND ${reviewBlob("schema")} = '${REVIEW_POINT_SCHEMA}' ` +
    `AND ${reviewFinish} >= ${fromMs} AND ${reviewFinish} < ${toMs}` +
    (visibleTo
      ? ` AND ${metricsPredicate(visibleTo, { requester: reviewBlob("requester"), repository: reviewBlob("repository"), normalizeRepository: true })}`
      : "");
  const quantiles =
    `sum(_sample_interval) AS runs, ` +
    `quantileExactWeighted(0.5)(${WALL}, _sample_interval) AS p50Ms, ` +
    `quantileExactWeighted(0.95)(${WALL}, _sample_interval) AS p95Ms`;
  return {
    runs:
      `SELECT ${finishDay(runFinish)} AS day, ${runBlob("outcome")} AS outcome, ${runBlob("surface")} AS surface, ` +
      `${runBlob("requester")} AS requester, sum(_sample_interval) AS runs, sum(${WALL} * _sample_interval) AS wallMs, ` +
      `max(_sample_interval) AS maxInterval ` +
      `FROM ${dataset} WHERE ${runs} GROUP BY day, outcome, surface, requester ORDER BY day ASC`,
    durationByRequester: `SELECT ${runBlob("requester")} AS requester, ${quantiles} FROM ${dataset} WHERE ${successes} GROUP BY requester`,
    durationBySurface: `SELECT ${runBlob("surface")} AS surface, ${quantiles} FROM ${dataset} WHERE ${successes} GROUP BY surface`,
    durationOverall: `SELECT ${quantiles} FROM ${dataset} WHERE ${successes}`,
    durationHistogram:
      // `if`, never `least`: only the functions the SQL reference documents run.
      `SELECT if(${WALL} >= ${REVIEWS_HISTOGRAM_OPEN_MS}, ${HISTOGRAM_OPEN_MINUTES}, intDiv(${WALL}, ${MINUTE_MS})) AS minute, ` +
      `sum(_sample_interval) AS runs ` +
      `FROM ${dataset} WHERE ${runs} GROUP BY minute ORDER BY minute ASC`,
    reviews:
      `SELECT ${reviewBlob("repository")} AS repository, ${reviewBlob("pull request number")} AS pr, ` +
      `${reviewBlob("verdict")} AS verdict, sum(_sample_interval) AS reviews, ` +
      `sum(${reviewDouble("findings")} * _sample_interval) AS findings, ` +
      `sum(${reviewDouble("blocking")} * _sample_interval) AS blocking, ` +
      `sum(${reviewDouble("major")} * _sample_interval) AS major, ` +
      `sum(${reviewDouble("minor")} * _sample_interval) AS minor, ` +
      `sum(${reviewDouble("nit")} * _sample_interval) AS nit, max(_sample_interval) AS maxInterval ` +
      `FROM ${dataset} WHERE ${reviews} GROUP BY repository, pr, verdict`,
    setup:
      `SELECT ${finishDay(runFinish)} AS day, ${runBlob("workspace")} AS workspace, ` +
      `${runBlob("setup reason")} AS setupReason, ${runBlob("error type")} AS errorType, sum(_sample_interval) AS runs ` +
      `FROM ${dataset} WHERE ${runs} GROUP BY day, workspace, setupReason, errorType ORDER BY day ASC`,
    byWorkspace:
      `SELECT ${runBlob("workspace")} AS workspace, sum(_sample_interval) AS runs, ` +
      `quantileExactWeighted(0.5)(${WALL}, _sample_interval) AS p50Ms, ` +
      `quantileExactWeighted(0.5)(${READY}, _sample_interval) AS p50ReadyMs ` +
      `FROM ${dataset} WHERE ${runs} GROUP BY workspace`,
  };
}

/** The rows each query answered, keyed as `reviewsQueries` keys them. */
export type ReviewsRows = Record<keyof ReviewsQueries, MetricsRow[]>;

/** Why a setup reason happened: by design, a defect, or a run that got no
 *  workspace (record 0097's constant map; every lost word is a failure). */
export type SetupReasonClass = "design" | "defect" | "failure";

const DESIGN_WORDS = new Set<string>([
  "fleet_draining",
  "deploy_fence",
  "workspace_preserved",
  "settlement_pending",
  "recreate_in_progress",
  "not_resident",
  "reattach_refused",
]);

/** A setup reason's class: a lost word is a failure, a fallback word is by
 *  design or a defect by the record's map, and an unknown word is a defect. */
export function setupReasonClass(reason: string): SetupReasonClass {
  if ((LOST_WORDS as readonly string[]).includes(reason)) return "failure";
  if (DESIGN_WORDS.has(reason)) return "design";
  return "defect";
}

/** The workspace words a warm start counts: a resident, restored or not. */
const WARM_WORKSPACES = ["resident", "resident_restored"] as const;

/** The workspace words of a run that requested a resident and got a
 *  workspace: the warm ones and every Cloudflare sandbox that stood in for
 *  one. A local or E2B run counts too when its setup reason is a fallback
 *  word (`standsInForResident`): that word says a resident was requested. */
const RESIDENT_REQUESTED_WORKSPACES = [
  ...WARM_WORKSPACES,
  "sandbox_snapshot",
  "sandbox_fresh",
  "sandbox_seed_failed",
] as const;

/** A local or E2B run that stood in for a requested resident: its setup
 *  reason is a fallback word. Without one it ran on the backend its class
 *  asked for, and is no warm-start candidate. */
function standsInForResident(workspace: string, setupReason: string): boolean {
  return (workspace === "local" || workspace === "e2b") && (FALLBACK_WORDS as readonly string[]).includes(setupReason);
}

/** A tile: good events over total events, and their ratio (0 over none). */
export interface ReviewsTile {
  good: number;
  total: number;
  ratio: number;
}

const tile = (good: number, total: number): ReviewsTile => ({ good, total, ratio: total > 0 ? good / total : 0 });

export interface ReviewsDuration {
  runs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ReviewsReport {
  range: { fromMs: number; toMs: number; days: number; bucket: "finish time"; completeness: "at most once" };
  /** The largest `_sample_interval` seen; above 1, the rows were sampled. */
  maxSampleInterval: number;
  usage: {
    runs: number;
    succeeded: number;
    /** Time spent running reviews, summed over every review run. */
    wallMs: number;
    duration: ReviewsDuration;
    byDay: Array<{ day: string; runs: number; bySurface: Record<string, number> }>;
    byRequester: Array<
      { requester: string; runs: number; succeeded: number; wallMs: number } & Omit<ReviewsDuration, "runs">
    >;
    bySurface: Array<{ surface: string; runs: number; durationRuns?: number } & Omit<ReviewsDuration, "runs">>;
    histogram: Array<{ minute: number; runs: number }>;
    pullRequests: number;
    /** Reviews per pull request, as a distribution; absent when the rows were sampled. */
    reviewsPerPullRequest?: Array<{ reviews: number; pullRequests: number }>;
    verdicts: { approved: number; changes_requested: number };
    findings: { total: number; blocking: number; major: number; minor: number; nit: number };
  };
  system: {
    tiles: {
      runSuccessRate: ReviewsTile;
      warmStartShare: ReviewsTile;
      lostAtSetup: ReviewsTile;
      reviewsWithVerdict: ReviewsTile;
    };
    /** Runs no outcome row explains, counted beside the success rate. */
    unclassified: number;
    /** Rows written before the outcome existed. */
    outcomeNotRecorded: number;
    outcomes: Record<string, number>;
    byDay: Array<{ day: string; byWorkspace: Record<string, number> }>;
    setupReasons: Array<{ reason: string; class: SetupReasonClass; runs: number }>;
    errorTypes: Array<{ errorType: string; runs: number }>;
    byWorkspace: Array<{ workspace: string; runs: number; p50Ms: number; p50ReadyMs: number }>;
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const dayOf = (v: unknown): string => str(v).slice(0, 10);
const add = (m: Record<string, number>, key: string, n: number): void => {
  m[key] = (m[key] ?? 0) + n;
};
const byCount = <T extends { runs: number }>(rows: T[]): T[] => rows.sort((a, b) => b.runs - a.runs);

/** Pure: the report over the eight queries' rows. Empty rows are a zero
 *  report with every UTC day in range present, never an error. */
export function buildReviewsReport(rows: ReviewsRows, range: ReviewsRange): ReviewsReport {
  const maxSampleInterval = Math.max(1, ...[...rows.runs, ...rows.reviews].map((r) => num(r.maxInterval)));

  // Usage: review runs by day, surface, requester and outcome.
  const surfacesOfDay = new Map<string, Record<string, number>>();
  const requesters = new Map<string, { runs: number; succeeded: number; wallMs: number }>();
  const outcomes: Record<string, number> = {};
  let runs = 0;
  let wallMs = 0;
  for (const r of rows.runs) {
    const n = num(r.runs);
    runs += n;
    wallMs += num(r.wallMs);
    const day = dayOf(r.day);
    const perDay = surfacesOfDay.get(day) ?? {};
    add(perDay, str(r.surface), n);
    surfacesOfDay.set(day, perDay);
    const outcome = str(r.outcome);
    add(outcomes, outcome === "" ? "not recorded" : outcome, n);
    const who = requesters.get(str(r.requester)) ?? { runs: 0, succeeded: 0, wallMs: 0 };
    who.runs += n;
    who.wallMs += num(r.wallMs);
    if (outcome === "success") who.succeeded += n;
    requesters.set(str(r.requester), who);
  }
  const days: string[] = [];
  for (let ms = range.fromMs - (range.fromMs % DAY_MS); ms < range.toMs; ms += DAY_MS)
    days.push(new Date(ms).toISOString().slice(0, 10));
  const quantilesOf = (list: MetricsRow[], key: string) =>
    new Map(list.map((r) => [str(r[key]), { p50Ms: num(r.p50Ms), p95Ms: num(r.p95Ms) }]));
  const byRequesterQ = quantilesOf(rows.durationByRequester, "requester");
  const bySurfaceQ = quantilesOf(rows.durationBySurface, "surface");
  const surfaceDurationRuns = new Map(
    rows.durationBySurface.map((r) => [str(r.surface), r.runs === undefined ? undefined : num(r.runs)]),
  );
  const surfaceRuns: Record<string, number> = {};
  for (const perDay of surfacesOfDay.values()) for (const [s, n] of Object.entries(perDay)) add(surfaceRuns, s, n);
  const overall = rows.durationOverall[0] ?? {};

  // Review rows: per pull request in TypeScript, since a pull request's
  // verdicts arrive as separate groups.
  const perPr = new Map<string, number>();
  const verdicts = { approved: 0, changes_requested: 0 };
  const findings = { total: 0, blocking: 0, major: 0, minor: 0, nit: 0 };
  let reviewRows = 0;
  for (const r of rows.reviews) {
    const n = num(r.reviews);
    reviewRows += n;
    if (str(r.verdict) === "approved") verdicts.approved += n;
    if (str(r.verdict) === "changes_requested") verdicts.changes_requested += n;
    findings.total += num(r.findings);
    findings.blocking += num(r.blocking);
    findings.major += num(r.major);
    findings.minor += num(r.minor);
    findings.nit += num(r.nit);
    if (str(r.pr) !== "") {
      const key = `${str(r.repository)}#${str(r.pr)}`;
      perPr.set(key, (perPr.get(key) ?? 0) + n);
    }
  }
  const distribution = new Map<number, number>();
  for (const n of perPr.values()) distribution.set(n, (distribution.get(n) ?? 0) + 1);

  // System: workspaces, setup reasons and error types.
  const workspacesOfDay = new Map<string, Record<string, number>>();
  const reasons: Record<string, number> = {};
  const errorTypes: Record<string, number> = {};
  const workspaces: Record<string, number> = {};
  let standInBackends = 0;
  for (const r of rows.setup) {
    const n = num(r.runs);
    const workspace = str(r.workspace) === "" ? "not recorded" : str(r.workspace);
    if (standsInForResident(workspace, str(r.setupReason))) standInBackends += n;
    add(workspaces, workspace, n);
    const perDay = workspacesOfDay.get(dayOf(r.day)) ?? {};
    add(perDay, workspace, n);
    workspacesOfDay.set(dayOf(r.day), perDay);
    if (str(r.setupReason) !== "") add(reasons, str(r.setupReason), n);
    if (str(r.errorType) !== "") add(errorTypes, str(r.errorType), n);
  }
  const warm = WARM_WORKSPACES.reduce((s, w) => s + (workspaces[w] ?? 0), 0);
  const askedForResident =
    RESIDENT_REQUESTED_WORKSPACES.reduce((s, w) => s + (workspaces[w] ?? 0), 0) + standInBackends;
  const counted = runs - (outcomes.cancellation ?? 0) - (outcomes["not recorded"] ?? 0);
  const sampled = maxSampleInterval > 1;

  return {
    range: {
      fromMs: range.fromMs,
      toMs: range.toMs,
      days: days.length,
      bucket: "finish time",
      completeness: "at most once",
    },
    maxSampleInterval,
    usage: {
      runs,
      succeeded: outcomes.success ?? 0,
      wallMs,
      duration: { runs: num(overall.runs), p50Ms: num(overall.p50Ms), p95Ms: num(overall.p95Ms) },
      byDay: days.map((day) => {
        const bySurface = surfacesOfDay.get(day) ?? {};
        return { day, runs: Object.values(bySurface).reduce((s, n) => s + n, 0), bySurface };
      }),
      byRequester: byCount(
        [...requesters.entries()].map(([requester, r]) => ({
          requester,
          ...r,
          p50Ms: byRequesterQ.get(requester)?.p50Ms ?? 0,
          p95Ms: byRequesterQ.get(requester)?.p95Ms ?? 0,
        })),
      ),
      bySurface: byCount(
        Object.entries(surfaceRuns).map(([surface, n]) => ({
          surface,
          runs: n,
          ...(!surfaceDurationRuns.has(surface)
            ? { durationRuns: 0 }
            : surfaceDurationRuns.get(surface) === undefined
              ? {}
              : { durationRuns: surfaceDurationRuns.get(surface) }),
          p50Ms: bySurfaceQ.get(surface)?.p50Ms ?? 0,
          p95Ms: bySurfaceQ.get(surface)?.p95Ms ?? 0,
        })),
      ),
      histogram: rows.durationHistogram.map((r) => ({ minute: num(r.minute), runs: num(r.runs) })),
      pullRequests: perPr.size,
      ...(sampled
        ? {}
        : {
            reviewsPerPullRequest: [...distribution.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([reviews, pullRequests]) => ({ reviews, pullRequests })),
          }),
      verdicts,
      findings,
    },
    system: {
      tiles: {
        runSuccessRate: tile(outcomes.success ?? 0, counted),
        warmStartShare: tile(warm, askedForResident),
        lostAtSetup: tile(workspaces.none ?? 0, runs),
        reviewsWithVerdict: tile(reviewRows, runs),
      },
      unclassified: errorTypes.unclassified ?? 0,
      outcomeNotRecorded: outcomes["not recorded"] ?? 0,
      outcomes,
      byDay: days.map((day) => ({ day, byWorkspace: workspacesOfDay.get(day) ?? {} })),
      setupReasons: byCount(
        Object.entries(reasons).map(([reason, n]) => ({ reason, class: setupReasonClass(reason), runs: n })),
      ),
      errorTypes: byCount(Object.entries(errorTypes).map(([errorType, n]) => ({ errorType, runs: n }))),
      byWorkspace: byCount(
        rows.byWorkspace.map((r) => ({
          workspace: str(r.workspace) === "" ? "not recorded" : str(r.workspace),
          runs: num(r.runs),
          p50Ms: num(r.p50Ms),
          p50ReadyMs: num(r.p50ReadyMs),
        })),
      ),
    },
  };
}
