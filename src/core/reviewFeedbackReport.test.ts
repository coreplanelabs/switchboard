import { describe, expect, it } from "vitest";
import { buildReviewFeedbackReport } from "./reviewFeedbackReport.js";
import type { ReviewFeedbackEntry, ReviewFeedbackVote } from "./reviewFeedback.js";
import { DAY_MS, REVIEW_FEEDBACK_HOURLY_MS as HOUR_MS } from "./budgets.js";

const now = Date.UTC(2026, 0, 14, 12);
const vote = (actorId: string, content: "up" | "down" = "up"): ReviewFeedbackVote => ({
  id: `${actorId}-${content}`,
  actorId,
  actorType: "User",
  content,
});
function row(id: string, votes: ReviewFeedbackVote[] = []): ReviewFeedbackEntry {
  return {
    publication: {
      runId: id,
      repo: "acme/api",
      pr: 7,
      head: "a".repeat(40),
      bodyHash: "b".repeat(64),
      format: 1,
      findings: 1,
      publishedAt: now - DAY_MS,
      review: {
        id: String(id.charCodeAt(0)),
        nodeId: `PRR_${id}`,
        url: `https://github.com/acme/api/pull/7#pullrequestreview-${id.charCodeAt(0)}`,
        publishedAt: now - DAY_MS,
      },
    },
    snapshot: { status: "complete", checkedAt: now, completedAt: now, votes },
  };
}
const report = (entries: ReviewFeedbackEntry[], options = {}) =>
  buildReviewFeedbackReport(
    { entries, collectionStartedAt: now - DAY_MS },
    { sinceMs: now - 30 * DAY_MS, untilMs: now + 1 },
    now,
    options,
  );
describe("human review feedback report", () => {
  it("bounds the detail list while preserving exact totals for the complete publication cohort", () => {
    const entries = Array.from({ length: 101 }, (_, i) => {
      const entry = row("x", [vote("one-person")]);
      const p = entry.publication;
      p.runId = String(i);
      p.publishedAt += i;
      p.review = {
        id: String(100 + i),
        nodeId: `PRR_sample_${i}`,
        publishedAt: p.publishedAt,
        url: `https://github.com/acme/api/pull/7#pullrequestreview-${100 + i}`,
      };
      return entry;
    });
    const r = report(entries);
    expect(r.total).toMatchObject({ eligible: 101, ratedReviews: 101, positiveOnly: 101, distinctRaters: 1 });
    expect(r.reviews).toHaveLength(100);
    expect([r.reviews[0].runId, r.reviews.at(-1)!.runId]).toEqual(["100", "1"]);
  });
  it("counts each review once, shows mixed ratings and uses the same complete fresh subset for every ratio", () => {
    const positive = row(
        "a",
        [1, 2, 3, 4, 5].map((i) => vote(`popular-${i}`)),
      ),
      negative = row("b", [vote("negative", "down")]),
      mixed = row("c", [vote("mixed-up"), vote("mixed-down", "down")]),
      ambiguous = row("d", [vote("both"), vote("both", "down")]),
      unknown = row("e", [{ id: "deleted", actorType: "Unknown", content: "down" }]),
      bot = row("f", [{ ...vote("bot"), actorType: "Bot" }]),
      clean = row("g", [vote("approval")]),
      missing = row("h"),
      failed = row("i", [vote("last-known")]);
    clean.publication.findings = 0;
    delete missing.publication.review;
    failed.snapshot!.status = "unavailable";
    const r = report([positive, negative, mixed, ambiguous, unknown, bot, clean, missing, failed]);
    expect(r.total).toMatchObject({
      eligible: 9,
      registered: 8,
      freshComplete: 7,
      positiveOnly: 2,
      negativeOnly: 1,
      mixed: 1,
      ambiguousOnly: 1,
      unknownOnly: 1,
      unrated: 1,
      positiveVotes: 7,
      negativeVotes: 2,
      ambiguousPairs: 1,
      unknownReactions: 1,
      excludedReactions: 1,
      ratedReviews: 4,
      distinctPrs: 1,
      distinctRaters: 10,
      missingIdentity: 1,
      unavailable: 1,
      lastKnownRated: 1,
      helpfulClearShare: 2 / 3,
      helpfulVoteShare: 7 / 9,
      ratingCoverage: 4 / 7,
      trackingCoverage: 8 / 9,
      syncCoverage: 7 / 9,
    });
    expect(r.byKind.map((g) => [g.key, g.counts.eligible, g.counts.ratedReviews])).toEqual([
      ["findings", 8, 3],
      ["clean", 1, 1],
    ]);
  });
  it("keeps pending, stale, inaccessible and changed reviews out of unrated counts; no ratings have no usefulness score", () => {
    const pending = row("a"),
      stale = row("b", [vote("old")]),
      changed = row("c"),
      empty = row("d");
    delete pending.snapshot;
    stale.snapshot!.completedAt = now - 3 * HOUR_MS;
    changed.snapshot!.status = "content_changed";
    const r = report([pending, stale, changed, empty]);
    expect(r.total).toMatchObject({
      eligible: 4,
      freshComplete: 1,
      unrated: 1,
      pending: 1,
      stale: 1,
      contentChanged: 1,
      ratedReviews: 0,
      helpfulClearShare: null,
      helpfulVoteShare: null,
      ratingCoverage: 0,
      lastKnownRated: 1,
    });
    expect(r.reviews.map((v) => v.state).sort()).toEqual(["complete", "content_changed", "pending", "stale"]);
  });
  it("excludes configured acceptance PRs and automation identities; older reviews use their daily freshness budget", () => {
    const old = row("a", [vote("human"), vote("automation", "down")]),
      excluded = row("b", [vote("test")]);
    old.publication.publishedAt = now - 10 * DAY_MS;
    old.publication.review!.publishedAt = old.publication.publishedAt;
    old.snapshot!.completedAt = now - 25 * HOUR_MS;
    excluded.publication.repo = "acme/test";
    excluded.publication.review!.url = `https://github.com/acme/test/pull/7#pullrequestreview-${excluded.publication.review!.id}`;
    const r = report([old, excluded], { excludedActorIds: ["automation"], excludedPullRequests: ["acme/test#7"] });
    expect(r.total).toMatchObject({
      eligible: 1,
      freshComplete: 1,
      positiveOnly: 1,
      negativeVotes: 0,
      positiveVotes: 1,
      excludedReactions: 1,
    });
    old.snapshot!.completedAt = now - 27 * HOUR_MS;
    expect(report([old]).total).toMatchObject({ freshComplete: 0, stale: 1, helpfulClearShare: null });
  });
  it("revises a publication-week cohort when a current vote changes or is removed", () => {
    const publicationWeek = `${new Date(Date.UTC(2026, 0, 12)).toISOString().slice(0, 10)} · format 1`;
    const entry = row("a", [vote("human")]);
    expect(report([entry]).weekly.map((g) => [g.key, g.counts.positiveOnly, g.counts.negativeOnly])).toEqual([
      [publicationWeek, 1, 0],
    ]);
    entry.snapshot!.votes = [vote("human", "down")];
    expect(report([entry]).weekly.map((g) => [g.key, g.counts.positiveOnly, g.counts.negativeOnly])).toEqual([
      [publicationWeek, 0, 1],
    ]);
    entry.snapshot!.votes = [];
    expect(report([entry]).total).toMatchObject({ eligible: 1, unrated: 1, helpfulClearShare: null });
  });
});
