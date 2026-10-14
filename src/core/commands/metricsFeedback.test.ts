import { describe, expect, it } from "vitest";
import { metricsFeedback } from "./metrics.js";
import { createMetricsService, NullMetricsService } from "../metricsService.js";
import { InMemoryReviewFeedbackStore, type ReviewFeedbackPublication } from "../reviewFeedback.js";

const now = Date.UTC(2026, 0, 14, 12);
const publication = (index: number): ReviewFeedbackPublication => ({
  runId: `review-${index}`,
  repo: "acme/api",
  pr: index + 1,
  head: "a".repeat(40),
  bodyHash: "b".repeat(64),
  format: 1,
  findings: 1,
  publishedAt: now - index - 100,
  review: {
    id: String(100 + index),
    nodeId: `PRR_sample_${index}`,
    url: `https://github.com/acme/api/pull/${index + 1}#pullrequestreview-${100 + index}`,
    publishedAt: now - index - 100,
  },
});
async function fixture(count: number, negativeAt: number[] = []) {
  const store = new InMemoryReviewFeedbackStore(() => now);
  for (let i = 0; i < count; i++) store.retain(publication(i));
  for (let i = 0; i < count; i++) {
    const [claim] = await store.claim(now, 1);
    const index = Number(claim.publication.runId.slice("review-".length));
    await store.complete(
      claim,
      {
        status: "complete",
        checkedAt: now,
        votes: [
          {
            id: `reaction-${index}`,
            actorId: "person-one",
            actorType: "User",
            content: negativeAt.includes(index) ? "down" : "up",
          },
        ],
      },
      now,
    );
  }
  const source = {
    query: async () => {
      throw new Error("Feedback must not read sampled Analytics Engine data");
    },
  };
  const service = createMetricsService(
    { dataset: "runs", days: 30, feedback: { enabled: true, excludedActorIds: [], excludedPullRequests: [] } },
    source,
    { now: () => now, feedback: store },
  );
  return { service, store };
}
const invoke = (service: ReturnType<typeof createMetricsService>, options: Record<string, unknown> = {}) =>
  metricsFeedback.handler({ args: [], options, deps: { metrics: { service: async () => service } } } as never);

describe("metrics.feedback", () => {
  it("finds negative feedback beyond the dashboard's latest 100 and returns the exact native identity for investigation", async () => {
    const { service } = await fixture(105, [104]);
    const result = await invoke(service, { rating: "negative" });
    expect(result).toMatchObject({
      matching: 1,
      total: { eligible: 105, negativeOnly: 1 },
      reviews: [
        {
          runId: "review-104",
          repo: "acme/api",
          pr: 105,
          negativeVotes: 1,
          url: "https://github.com/acme/api/pull/105#pullrequestreview-204",
        },
      ],
    });
    const detail = await invoke(service, { run: "review-104" });
    expect(detail).toMatchObject({
      matching: 1,
      detail: {
        publication: {
          runId: "review-104",
          repo: "acme/api",
          pr: 105,
          head: "a".repeat(40),
          bodyHash: "b".repeat(64),
          review: { id: "204", nodeId: "PRR_sample_104" },
        },
        snapshot: {
          status: "complete",
          checkedAt: now,
          completedAt: now,
          votes: [{ id: "reaction-104", actorId: "person-one", actorType: "User", content: "down" }],
        },
      },
    });
  });
  it("pages matching reviews in publication order and narrows by repository and PR", async () => {
    const { service } = await fixture(4, [0, 1, 2, 3]);
    const first = await invoke(service, { rating: "negative", limit: 2 });
    expect(first).toMatchObject({
      matching: 4,
      nextCursor: "review-1",
      reviews: [{ runId: "review-0" }, { runId: "review-1" }],
    });
    const second = await invoke(service, { rating: "negative", limit: 2, after: "review-1" });
    expect(second).toMatchObject({ matching: 4, reviews: [{ runId: "review-2" }, { runId: "review-3" }] });
    expect(second).not.toHaveProperty("nextCursor");
    expect(await invoke(service, { repo: "ACME/API", pr: 3 })).toMatchObject({
      matching: 1,
      reviews: [{ runId: "review-2" }],
    });
    expect(await invoke(service, { run: "not-tracked" })).toMatchObject({ matching: 0, reviews: [], detail: null });
  });
  it("retrieves an exact retained review older than the default discovery range", async () => {
    const { service, store } = await fixture(0);
    const old = publication(60 * 86_400_000);
    store.retain(old);
    expect(await invoke(service, {})).toMatchObject({ matching: 0, reviews: [] });
    expect(await invoke(service, { run: old.runId })).toMatchObject({
      matching: 1,
      detail: { publication: { runId: old.runId, head: "a".repeat(40), review: { id: old.review!.id } } },
    });
  });
  it("shows stale evidence as last-known feedback and keeps it out of current usefulness counts", async () => {
    const { service, store } = await fixture(1, [0]);
    const [claim] = await store.claim(now + 3_600_001, 1);
    await store.complete(claim, { status: "unavailable", checkedAt: now + 3_600_001 }, now + 3_600_001);
    const result = await invoke(service, { rating: "negative" });
    expect(result).toMatchObject({
      matching: 1,
      total: { freshComplete: 0, ratedReviews: 0, unavailable: 1 },
      reviews: [{ state: "unavailable", negativeVotes: 1, lastCompleteAt: now }],
    });
    expect(await invoke(service, { rating: "negative", state: "complete" })).toMatchObject({
      matching: 0,
      reviews: [],
    });
  });
  it("refuses disabled collection and bad query inputs without a model run or GitHub write", async () => {
    await expect(invoke(new NullMetricsService())).rejects.toMatchObject({ code: "unavailable" });
    const { service } = await fixture(1);
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { days: 91 },
      { repo: "../api" },
      { after: "gone" },
      { run: "review-0", rating: "negative" },
    ]) {
      await expect(invoke(service, options)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await invoke(service, {})).toMatchObject({ matching: 1, reviews: [{ runId: "review-0" }] });
  });
  it("records a redacted store failure while returning only a safe unavailable response", async () => {
    const feedback = new InMemoryReviewFeedbackStore(() => now);
    feedback.list = async () => {
      throw new Error("HTTP 503\nBearer samplecredential123456");
    };
    const warnings: string[] = [];
    const service = createMetricsService(
      { dataset: "runs", days: 30, feedback: { enabled: true, excludedActorIds: [], excludedPullRequests: [] } },
      { query: async () => [] },
      { now: () => now, feedback, warn: (message) => warnings.push(message) },
    );
    await expect(invoke(service, {})).rejects.toMatchObject({
      code: "unavailable",
      message: "Human review feedback is unavailable; collection must be enabled and its retained data accessible.",
    });
    expect(warnings).toEqual(["Human review feedback unavailable: Error: HTTP 503 Bearer «redacted»"]);
  });
});
