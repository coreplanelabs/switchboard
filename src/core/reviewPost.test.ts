import { describe, expect, it } from "vitest";
import { decideReviewPost, reviewPostIntended, reviewPostOptedOut } from "./reviewPost.js";

// One predicate for "is this verdict meant to be posted": the post-step
// (`decideReviewPost`) and the dispatcher's unknown-head refusal (agent-review.md
// item 11) both branch on it, so they can never disagree about which agent
// posts or what an opt-out looks like.
describe("reviewPostIntended", () => {
  it("true only for a review run that did not opt out", () => {
    expect(reviewPostIntended({ agentName: "review", requestText: "review https://github.com/a/b/pull/1" })).toBe(true);
    expect(reviewPostIntended({ agentName: "review", requestText: "review a/b#1 — slack only" })).toBe(false);
    expect(reviewPostIntended({ agentName: "coding", requestText: "review a/b#1" })).toBe(false);
  });
  it("decideReviewPost agrees with it: intended + resolved PR → target; not intended → null even with a PR", () => {
    expect(decideReviewPost({ agentName: "review", repo: "a/b", pr: 1, requestText: "review" })).toEqual({
      repo: "a/b",
      number: 1,
    });
    expect(decideReviewPost({ agentName: "review", repo: "a/b", pr: 1, requestText: "review, don't post" })).toBeNull();
    expect(decideReviewPost({ agentName: "general", repo: "a/b", pr: 1, requestText: "review" })).toBeNull();
  });
});

// Feature: features/agent-review.md — posting a review back to the PR is the
// DEFAULT for a review run against a resolved PR. These pin the pure decision
// (review + resolved PR + not-opted-out → post) and the opt-out parse, so the
// side-effect wiring in the dispatcher stays a thin call over tested logic.

describe("reviewPostOptedOut", () => {
  it("recognizes explicit don't-post phrasings", () => {
    for (const t of [
      "review this and don't post to the PR",
      "review this and do not post",
      "review it, dont post the comment",
      "just review, no post",
      "review PR 42 — no-post please",
      "review but skip posting the comment",
      "review without posting to github",
      "no need to comment on the PR, just review",
    ]) {
      expect(reviewPostOptedOut(t), t).toBe(true);
    }
  });

  it("recognizes slack-only intent", () => {
    for (const t of ["slack only please", "reply in slack-only mode", "SLACK ONLY"]) {
      expect(reviewPostOptedOut(t), t).toBe(true);
    }
  });

  it("recognizes a directive-style post:off token", () => {
    for (const t of ["review PR, post:off", "review post=no", "post:false review this"]) {
      expect(reviewPostOptedOut(t), t).toBe(true);
    }
  });

  it("does NOT fire on ordinary review requests that mention posting positively", () => {
    for (const t of [
      "review PR 42 and post the review as a comment",
      "review https://github.com/o/r/pull/1",
      "post the findings and rank them",
      "look at the diff and comment on any bugs",
      "",
    ]) {
      expect(reviewPostOptedOut(t), t).toBe(false);
    }
  });
});

describe("decideReviewPost", () => {
  const base = { agentName: "review", repo: "o/r", pr: 42, requestText: "review this PR" };

  it("review + resolved PR + not opted-out → posts to that PR", () => {
    expect(decideReviewPost(base)).toEqual({ repo: "o/r", number: 42 });
  });

  it("returns null for a non-review agent even with a resolved PR", () => {
    expect(decideReviewPost({ ...base, agentName: "coding" })).toBeNull();
  });

  it("returns null when no PR was resolved (repo only — nowhere to post)", () => {
    expect(decideReviewPost({ ...base, pr: undefined })).toBeNull();
  });

  it("returns null when no repo was resolved (pasted code review)", () => {
    expect(decideReviewPost({ ...base, repo: undefined, pr: undefined })).toBeNull();
  });

  it("returns null when the request opts out", () => {
    expect(decideReviewPost({ ...base, requestText: "review this but don't post" })).toBeNull();
  });
});
