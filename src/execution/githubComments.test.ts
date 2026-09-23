import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewPostBody, MAX_REVIEW_POST_CODE_POINTS, parseVerdictInput } from "../core/reviewVerdict.js";
import { postReviewComment } from "./githubComments.js";

// Feature: docs/reference/specs/agent-review.md — the bot-process post is a COMMENT-event
// pull-request review (what the auto-approve workflow listens to), pinned to
// the reviewed commit, and never an APPROVE/REQUEST_CHANGES event.
describe("postReviewComment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubFetch(status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(status === 200 ? "{}" : "nope", { status });
      }),
    );
    return calls;
  }

  it("posts a COMMENT-event review to /pulls/{n}/reviews with commit_id when given", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    await postReviewComment({ repo: "acme/api", number: 42, commitId: "b".repeat(40) }, "LGTM: fine\n\nbody");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/42/reviews");
    const payload = JSON.parse(String(calls[0].init.body));
    expect(payload).toEqual({ event: "COMMENT", body: "LGTM: fine\n\nbody", commit_id: "b".repeat(40) });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer ghtok");
  });

  it("keeps the typed verdict marker when real publication fits an oversized review to GitHub's limit", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    const head = "b".repeat(40);
    const verdict = parseVerdictInput({ verdict: "approve", summary: "fine", head, findings: [] })!;

    await postReviewComment(
      { repo: "acme/api", number: 42, commitId: head },
      buildReviewPostBody(`review ${"x".repeat(70_000)}`, verdict, { repo: "acme/api", head }),
    );

    const payload = JSON.parse(String(calls[0].init.body)) as { body: string };
    expect([...payload.body].length).toBeLessThanOrEqual(MAX_REVIEW_POST_CODE_POINTS);
    expect(payload.body).toMatch(/^LGTM: fine\n/);
    expect(payload.body).toContain('<!-- switchboard:verdict {"verdict":"approve"');
    expect(payload.body).toContain("review truncated to fit GitHub's review size limit");
  });

  it("fails closed before the GitHub write when fixed verdict sections alone exceed the limit", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    const head = "b".repeat(40);
    const verdict = parseVerdictInput({
      verdict: "approve",
      summary: "x".repeat(MAX_REVIEW_POST_CODE_POINTS),
      head,
      findings: [],
    })!;
    const body = buildReviewPostBody("", verdict, { repo: "acme/api", head });

    expect([...body].length).toBeGreaterThan(MAX_REVIEW_POST_CODE_POINTS);
    await expect(postReviewComment({ repo: "acme/api", number: 42, commitId: head }, body)).rejects.toThrow(
      /refusing to clip the structured verdict/,
    );
    expect(calls).toHaveLength(0);
  });

  it("fails closed through real publication when fixed sections fit but leave no visible review budget", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    const head = "b".repeat(40);
    const finding = {
      id: "F2",
      severity: "minor" as const,
      title: "Review text must remain visible",
      file: "src/a.ts",
    };
    const seed = parseVerdictInput({ verdict: "approve", summary: "x", head, findings: [finding] })!;
    const seedFixedLength = [...buildReviewPostBody("", seed, { repo: "acme/api", head })].length;
    const verdict = parseVerdictInput({
      verdict: "approve",
      summary: "x".repeat(MAX_REVIEW_POST_CODE_POINTS - seedFixedLength),
      head,
      findings: [finding],
    })!;
    const fixedBody = buildReviewPostBody("", verdict, { repo: "acme/api", head });
    const body = buildReviewPostBody("F2: the bounded review remains visible.", verdict, { repo: "acme/api", head });

    expect([...fixedBody]).toHaveLength(MAX_REVIEW_POST_CODE_POINTS - 1);
    expect([...body].length).toBeGreaterThan(MAX_REVIEW_POST_CODE_POINTS);
    expect(body).toMatch(/^Changes requested:/);
    expect(body).toContain('<!-- switchboard:verdict {"verdict":"request_changes"');
    await expect(postReviewComment({ repo: "acme/api", number: 42, commitId: head }, body)).rejects.toThrow(
      /refusing to clip the structured verdict/,
    );
    expect(calls).toHaveLength(0);
  });

  it("omits commit_id when no head SHA was resolved", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    await postReviewComment({ repo: "acme/api", number: 1 }, "x");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ event: "COMMENT", body: "x" });
  });

  it("throws on a non-2xx so the caller can log the failure", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    stubFetch(422);
    await expect(postReviewComment({ repo: "acme/api", number: 1 }, "x")).rejects.toThrow(/HTTP 422/);
  });

  it("throws when no credential is available", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    stubFetch();
    await expect(postReviewComment({ repo: "acme/api", number: 1 }, "x")).rejects.toThrow(/no GitHub credential/);
  });
});
