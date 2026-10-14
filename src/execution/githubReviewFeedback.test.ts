import { describe, expect, it, vi } from "vitest";
import { REVIEW_FEEDBACK_READ_MS } from "../core/budgets.js";
import { GithubReviewFeedbackSource } from "./githubReviewFeedback.js";
import { sourceHash } from "../core/references/receipts.js";
import type { ReviewFeedbackPublication } from "../core/reviewFeedback.js";

const publication = async (): Promise<ReviewFeedbackPublication> => ({
  runId: "r1",
  repo: "acme/api",
  pr: 7,
  head: "a".repeat(40),
  bodyHash: await sourceHash("Original review"),
  format: 1,
  findings: 1,
  publishedAt: 1000,
  review: {
    id: "42",
    nodeId: "PRR_one",
    url: "https://github.com/acme/api/pull/7#pullrequestreview-42",
    publishedAt: 1000,
  },
});
const node = {
  id: "PRR_one",
  fullDatabaseId: "42",
  body: "Original review",
  commit: { oid: "a".repeat(40) },
  repository: { nameWithOwner: "acme/api" },
  pullRequest: { number: 7 },
};
const human = { __typename: "User", id: "U_one" };

describe("native review-body reactions", () => {
  it("bounds token acquisition inside the read deadline", async () => {
    vi.useFakeTimers();
    try {
      const source = new GithubReviewFeedbackSource({ token: () => new Promise(() => {}) });
      let outcome: unknown = "pending";
      void source.read(await publication()).then(
        (v) => {
          outcome = v;
        },
        (e) => {
          outcome = { kind: e.kind };
        },
      );
      await vi.advanceTimersByTimeAsync(REVIEW_FEEDBACK_READ_MS);
      expect(outcome).toEqual({ kind: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("reads every page, preserves actor identity and ignores unrelated emoji", async () => {
    const requests: unknown[] = [];
    const source = new GithubReviewFeedbackSource({
      token: async () => "test",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)).variables);
        const first = requests.length === 1;
        return Response.json({
          data: {
            node: {
              ...node,
              reactions: {
                totalCount: 3,
                pageInfo: { hasNextPage: first, endCursor: first ? "next" : null },
                nodes: first
                  ? [{ id: "reaction-one", content: "THUMBS_UP", user: human }]
                  : [
                      { id: "reaction-two", content: "THUMBS_DOWN", user: null },
                      { id: "reaction-three", content: "HEART", user: human },
                    ],
              },
            },
          },
        });
      },
    });
    expect(await source.read(await publication())).toEqual([
      { id: "reaction-one", actorId: "U_one", actorType: "User", content: "up" },
      { id: "reaction-two", actorType: "Unknown", content: "down" },
    ]);
    expect(requests).toEqual([
      { id: "PRR_one", after: null },
      { id: "PRR_one", after: "next" },
    ]);
  });
  it.each([
    "wrong-head",
    "wrong-database-id",
    "wrong-pr",
    "wrong-repo",
    "edited-body",
    "partial-errors",
    "missing-node",
    "changing-count",
    "looping-cursor",
  ])("refuses an incomplete or unbound read: %s", async (mode) => {
    let calls = 0;
    const source = new GithubReviewFeedbackSource({
      token: async () => "test",
      fetch: async () => {
        calls++;
        const current = {
          ...node,
          ...(mode === "wrong-database-id" ? { fullDatabaseId: "43" } : {}),
          ...(mode === "wrong-head" ? { commit: { oid: "b".repeat(40) } } : {}),
          ...(mode === "wrong-pr" ? { pullRequest: { number: 8 } } : {}),
          ...(mode === "wrong-repo" ? { repository: { nameWithOwner: "other/api" } } : {}),
          ...(mode === "edited-body" ? { body: "Edited review" } : {}),
          reactions: {
            totalCount: mode === "changing-count" && calls > 1 ? 2 : 1,
            nodes: calls === 1 ? [{ id: "reaction-one", content: "THUMBS_UP", user: human }] : [],
            pageInfo: { hasNextPage: true, endCursor: "same" },
          },
        };
        return Response.json({
          data: { node: mode === "missing-node" ? null : current },
          ...(mode === "partial-errors" ? { errors: [{ message: "partial" }] } : {}),
        });
      },
    });
    await expect(source.read(await publication())).rejects.toMatchObject({
      kind: mode === "edited-body" ? "content_changed" : "unavailable",
    });
  });
  it("turns a rate-limit reset into a bounded collector cooldown without returning an empty rating", async () => {
    const source = new GithubReviewFeedbackSource({
      token: async () => "test",
      now: () => 1000,
      fetch: async () => new Response("", { status: 429, headers: { "x-ratelimit-reset": "9" } }),
    });
    await expect(source.read(await publication())).rejects.toMatchObject({ kind: "unavailable", retryAt: 9000 });
  });
  it("honors secondary Retry-After and GraphQL HTTP-200 rate errors", async () => {
    for (const response of [
      () => new Response("", { status: 403, headers: { "retry-after": "60" } }),
      () => Response.json({ errors: [{ type: "RATE_LIMITED", message: "rate limit" }] }),
    ]) {
      const source = new GithubReviewFeedbackSource({
        token: async () => "test",
        now: () => 1000,
        fetch: async () => response(),
      });
      await expect(source.read(await publication())).rejects.toMatchObject({
        kind: "unavailable",
        retryAt: expect.any(Number),
      });
    }
  });
});
