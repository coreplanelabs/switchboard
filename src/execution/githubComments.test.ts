import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewPostBody, MAX_REVIEW_POST_CODE_POINTS, parseVerdictInput } from "../core/reviewVerdict.js";
import { branchPublicationOf } from "../core/branchPublication.js";
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

  it("does not follow a redirected native review write or credit its destination", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch(307);
    expect(
      await postReviewComment({ repo: "acme/api", number: 42, commitId: "b".repeat(40) }, "original review"),
    ).toEqual({ state: "uncertain" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
  });
  it("refuses dot-segment repositories in both retained producer evidence and the native review target", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    for (const repo of ["./api", "../api", "acme/.", "acme/.."]) {
      expect(branchPublicationOf({ version: 1, repo, branches: [], complete: true })).toBeUndefined();
      expect(await postReviewComment({ repo, number: 42, commitId: "b".repeat(40) }, "original review")).toEqual({
        state: "refused",
      });
    }
    expect(calls).toHaveLength(0);
    expect(branchPublicationOf({ version: 1, repo: "acme/lib.v2", branches: [], complete: true })).toMatchObject({
      repo: "acme/lib.v2",
    });
  });

  it.each(["accepted", "wrong-head", "wrong-pr", "missing-receipt", "unreadable"])(
    "requires exact positive native review receipt: %s",
    async (mode) => {
      vi.stubEnv("GH_TOKEN", "ghtok");
      vi.stubEnv("GITHUB_APP_ID", "");
      const head = "b".repeat(40),
        body = "original review";
      const response = {
        id: 71,
        state: "COMMENTED",
        body,
        commit_id: head,
        pull_request_url: "https://api.github.com/repos/acme/api/pulls/42",
      };
      if (mode === "wrong-head") response.commit_id = "c".repeat(40);
      if (mode === "wrong-pr") response.pull_request_url = "https://api.github.com/repos/acme/api/pulls/43";
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              mode === "unreadable" ? "not json" : JSON.stringify(mode === "missing-receipt" ? {} : response),
              { status: 201 },
            ),
        ),
      );
      expect(await postReviewComment({ repo: "acme/api", number: 42, commitId: head }, body)).toEqual({
        state: mode === "accepted" ? "accepted" : "uncertain",
      });
    },
  );

  it.each([422, 408, 500])("distinguishes definitive native refusal from uncertain HTTP %s", async (status) => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    stubFetch(status);
    expect(
      await postReviewComment({ repo: "acme/api", number: 42, commitId: "b".repeat(40) }, "original review"),
    ).toEqual(status === 422 ? { state: "refused", status } : { state: "uncertain" });
  });

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
    await expect(postReviewComment({ repo: "acme/api", number: 42, commitId: head }, body)).resolves.toEqual({
      state: "refused",
    });
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
    await expect(postReviewComment({ repo: "acme/api", number: 42, commitId: head }, body)).resolves.toEqual({
      state: "refused",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses before dispatch when the complete commit target is missing", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch();
    expect(await postReviewComment({ repo: "acme/api", number: 1 }, "x")).toEqual({ state: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("returns a definitive refusal for native rejection", async () => {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    stubFetch(422);
    expect(await postReviewComment({ repo: "acme/api", number: 1, commitId: "b".repeat(40) }, "x")).toEqual({
      state: "refused",
      status: 422,
    });
  });

  it("refuses before dispatch when no credential is available", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    stubFetch();
    expect(await postReviewComment({ repo: "acme/api", number: 1, commitId: "b".repeat(40) }, "x")).toEqual({
      state: "refused",
    });
  });
});
