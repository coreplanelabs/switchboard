import {
  DAY_MS,
  REVIEW_FEEDBACK_RECENT_MS,
  REVIEW_FEEDBACK_RECENT_FRESH_MS,
  REVIEW_FEEDBACK_OLDER_FRESH_MS,
} from "./budgets.js";
import {
  isReviewFeedbackEntry,
  validFeedbackRange,
  type ReviewFeedbackEntry,
  type ReviewFeedbackWindow,
} from "./reviewFeedback.js";

export type FeedbackBucket = "positiveOnly" | "negativeOnly" | "mixed" | "ambiguousOnly" | "unknownOnly" | "unrated";
export type FeedbackState = "complete" | "missing_identity" | "pending" | "stale" | "unavailable" | "content_changed";
export interface FeedbackReview {
  runId: string;
  repo: string;
  pr: number;
  format: number;
  findings: number;
  publishedAt: number;
  url?: string;
  state: FeedbackState;
  lastCompleteAt?: number;
  bucket?: FeedbackBucket;
  positiveVotes: number;
  negativeVotes: number;
  ambiguousPairs: number;
  unknownReactions: number;
  excludedReactions: number;
}
export interface FeedbackCounts {
  eligible: number;
  registered: number;
  freshComplete: number;
  missingIdentity: number;
  pending: number;
  stale: number;
  unavailable: number;
  contentChanged: number;
  lastKnownRated: number;
  positiveOnly: number;
  negativeOnly: number;
  mixed: number;
  ambiguousOnly: number;
  unknownOnly: number;
  unrated: number;
  positiveVotes: number;
  negativeVotes: number;
  ambiguousPairs: number;
  unknownReactions: number;
  excludedReactions: number;
  ratedReviews: number;
  distinctPrs: number;
  distinctRaters: number;
  helpfulClearShare: number | null;
  helpfulVoteShare: number | null;
  ratingCoverage: number | null;
  trackingCoverage: number | null;
  syncCoverage: number | null;
}
export interface FeedbackGroup {
  key: string;
  counts: FeedbackCounts;
}
export interface AvailableReviewFeedbackReport {
  status: "available";
  asOf: number;
  collectionStartedAt?: number;
  range: { sinceMs: number; untilMs: number };
  freshness: { recentWindowMs: number; recentMaxAgeMs: number; olderMaxAgeMs: number };
  total: FeedbackCounts;
  weekly: FeedbackGroup[];
  byRepository: FeedbackGroup[];
  byKind: FeedbackGroup[];
  reviews: FeedbackReview[];
}
export type ReviewFeedbackReport =
  AvailableReviewFeedbackReport | { status: "unavailable"; asOf: number } | { status: "not_applicable"; asOf: number };

type ClassifiedReview = FeedbackReview & { raters: string[] };
const REVIEW_DETAILS_LIMIT = 100;
const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);
function classify(entry: ReviewFeedbackEntry, now: number, excluded: Set<string>): ClassifiedReview {
  const { publication: p, snapshot: s } = entry;
  const actors = new Map<string, Set<string>>(),
    reactions = new Set<string>();
  let positiveVotes = 0,
    negativeVotes = 0,
    ambiguousPairs = 0,
    unknownReactions = 0,
    excludedReactions = 0;
  for (const vote of s?.votes ?? []) {
    if (reactions.has(vote.id)) continue;
    reactions.add(vote.id);
    if (vote.actorType === "Bot" || (vote.actorId && excluded.has(vote.actorId))) {
      excludedReactions++;
      continue;
    }
    if (vote.actorType !== "User" || !vote.actorId) {
      unknownReactions++;
      continue;
    }
    const signs = actors.get(vote.actorId) ?? new Set<string>();
    signs.add(vote.content);
    actors.set(vote.actorId, signs);
  }
  for (const signs of actors.values()) {
    if (signs.size === 2) ambiguousPairs++;
    else if (signs.has("up")) positiveVotes++;
    else negativeVotes++;
  }
  const limit =
    now - p.publishedAt <= REVIEW_FEEDBACK_RECENT_MS ? REVIEW_FEEDBACK_RECENT_FRESH_MS : REVIEW_FEEDBACK_OLDER_FRESH_MS;
  const state: FeedbackState = !p.review
    ? "missing_identity"
    : !s
      ? "pending"
      : s.status !== "complete"
        ? s.status
        : !s.completedAt || s.completedAt > now
          ? "unavailable"
          : now - s.completedAt > limit
            ? "stale"
            : "complete";
  const bucket: FeedbackBucket =
    positiveVotes && negativeVotes
      ? "mixed"
      : positiveVotes
        ? "positiveOnly"
        : negativeVotes
          ? "negativeOnly"
          : ambiguousPairs
            ? "ambiguousOnly"
            : unknownReactions
              ? "unknownOnly"
              : "unrated";
  return {
    runId: p.runId,
    repo: p.repo,
    pr: p.pr,
    format: p.format,
    findings: p.findings,
    publishedAt: p.publishedAt,
    ...(p.review ? { url: p.review.url } : {}),
    state,
    ...(s?.completedAt ? { lastCompleteAt: s.completedAt } : {}),
    ...(state === "complete" ? { bucket } : {}),
    positiveVotes,
    negativeVotes,
    ambiguousPairs,
    unknownReactions,
    excludedReactions,
    raters: [...actors.keys()],
  };
}
function summarize(rows: ClassifiedReview[]): FeedbackCounts {
  const fresh = rows.filter((r) => r.state === "complete");
  const count = (bucket: FeedbackBucket) => fresh.filter((r) => r.bucket === bucket).length;
  const positiveOnly = count("positiveOnly"),
    negativeOnly = count("negativeOnly"),
    mixed = count("mixed");
  const positiveVotes = fresh.reduce((sum, r) => sum + r.positiveVotes, 0),
    negativeVotes = fresh.reduce((sum, r) => sum + r.negativeVotes, 0);
  const ratedReviews = positiveOnly + negativeOnly + mixed;
  const registered = rows.filter((r) => r.url !== undefined).length;
  return {
    eligible: rows.length,
    registered,
    freshComplete: fresh.length,
    missingIdentity: rows.filter((r) => r.state === "missing_identity").length,
    pending: rows.filter((r) => r.state === "pending").length,
    stale: rows.filter((r) => r.state === "stale").length,
    unavailable: rows.filter((r) => r.state === "unavailable").length,
    contentChanged: rows.filter((r) => r.state === "content_changed").length,
    lastKnownRated: rows.filter(
      (r) => r.state !== "complete" && r.lastCompleteAt && r.positiveVotes + r.negativeVotes > 0,
    ).length,
    positiveOnly,
    negativeOnly,
    mixed,
    ambiguousOnly: count("ambiguousOnly"),
    unknownOnly: count("unknownOnly"),
    unrated: count("unrated"),
    positiveVotes,
    negativeVotes,
    ambiguousPairs: fresh.reduce((sum, r) => sum + r.ambiguousPairs, 0),
    unknownReactions: fresh.reduce((sum, r) => sum + r.unknownReactions, 0),
    excludedReactions: fresh.reduce((sum, r) => sum + r.excludedReactions, 0),
    ratedReviews,
    distinctPrs: new Set(rows.map((r) => `${r.repo.toLowerCase()}#${r.pr}`)).size,
    distinctRaters: new Set(fresh.flatMap((r) => r.raters)).size,
    helpfulClearShare: ratio(positiveOnly, positiveOnly + negativeOnly),
    helpfulVoteShare: ratio(positiveVotes, positiveVotes + negativeVotes),
    ratingCoverage: ratio(ratedReviews, fresh.length),
    trackingCoverage: ratio(registered, rows.length),
    syncCoverage: ratio(fresh.length, rows.length),
  };
}
function groups(rows: ClassifiedReview[], key: (r: ClassifiedReview) => string): FeedbackGroup[] {
  const grouped = new Map<string, ClassifiedReview[]>();
  for (const row of rows) {
    const k = key(row),
      values = grouped.get(k) ?? [];
    values.push(row);
    grouped.set(k, values);
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => ({ key, counts: summarize(values) }));
}
function week(ms: number): string {
  const day = new Date(ms),
    start = ms - (ms % DAY_MS) - ((day.getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(start).toISOString().slice(0, 10);
}

/** Current votes of a publication cohort; sampled run telemetry never enters these denominators. */
export function buildReviewFeedbackReport(
  window: ReviewFeedbackWindow,
  range: { sinceMs: number; untilMs: number },
  now: number,
  opts: { excludedActorIds?: string[]; excludedPullRequests?: string[] } = {},
): AvailableReviewFeedbackReport {
  if (!validFeedbackRange(range.sinceMs, range.untilMs) || !window.entries.every(isReviewFeedbackEntry))
    throw new Error("Invalid review feedback report input");
  const excludedPrs = new Set(opts.excludedPullRequests?.map((p) => p.toLowerCase())),
    seen = new Set<string>();
  const entries = window.entries.filter(
    ({ publication: p }) =>
      p.publishedAt >= range.sinceMs &&
      p.publishedAt < Math.min(range.untilMs, now + 1) &&
      !excludedPrs.has(`${p.repo.toLowerCase()}#${p.pr}`),
  );
  for (const { publication: p } of entries) {
    const key = p.review ? `${p.repo.toLowerCase()}#${p.review.id}` : p.runId;
    if (seen.has(key)) throw new Error("Duplicate review feedback publication");
    seen.add(key);
  }
  const rows = entries.map((entry) => classify(entry, now, new Set(opts.excludedActorIds)));
  const byKind = ["findings", "clean"].flatMap((key) => {
    const values = rows.filter((r) => (key === "findings" ? r.findings > 0 : r.findings === 0));
    return values.length ? [{ key, counts: summarize(values) }] : [];
  });
  return {
    status: "available",
    asOf: now,
    ...(window.collectionStartedAt ? { collectionStartedAt: window.collectionStartedAt } : {}),
    range,
    freshness: {
      recentWindowMs: REVIEW_FEEDBACK_RECENT_MS,
      recentMaxAgeMs: REVIEW_FEEDBACK_RECENT_FRESH_MS,
      olderMaxAgeMs: REVIEW_FEEDBACK_OLDER_FRESH_MS,
    },
    total: summarize(rows),
    weekly: groups(rows, (r) => `${week(r.publishedAt)} · format ${r.format}`),
    byRepository: groups(rows, (r) => `${r.repo} · format ${r.format}`),
    byKind,
    reviews: rows
      .sort((a, b) => b.publishedAt - a.publishedAt || a.runId.localeCompare(b.runId))
      .slice(0, REVIEW_DETAILS_LIMIT)
      .map(({ raters: _raters, ...row }) => row),
  };
}
