import { afterEach, describe, expect, it, vi } from "vitest";
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
