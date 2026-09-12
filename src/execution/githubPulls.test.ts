import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBranchRef,
  fetchPullRequestFacts,
  fetchPullRequestReviews,
  fetchRepoShipInfo,
  findOpenPrByHead,
  openPullRequest,
  updatePullRequest,
} from "./githubPulls.js";

// Feature: docs/reference/specs/pr-description.md — the bot process opens and edits PRs
// itself over the GitHub REST API with the App token (never the model, never
// `gh`), open-or-edit: an existing open PR for the head branch is edited,
// never duplicated, and title/head/base come only from the typed inputs —
// prose in the rendered body cannot alter them.
describe("githubPulls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubToken() {
    vi.stubEnv("GH_TOKEN", "ghtok");
    vi.stubEnv("GITHUB_APP_ID", "");
  }

  function stubFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return handler(url, init);
      }),
    );
    return calls;
  }

  /** Lookup finds nothing; create succeeds. */
  function stubCreatePath(
    createStatus = 201,
    createBody = '{"number":7,"html_url":"https://github.com/acme/api/pull/7"}',
  ) {
    return stubFetch((url, init) =>
      (init.method ?? "GET") === "GET"
        ? new Response("[]", { status: 200 })
        : new Response(createBody, { status: createStatus }),
    );
  }

  const target = {
    repo: "acme/api",
    headBranch: "feat/x",
    base: "main",
    title: "Add the widget",
    body: "## TL;DR\n\nAdds the widget.",
  };

  it("creates the PR when no open PR exists for the branch — owner:branch only in the lookup, bare branch in the payload", async () => {
    stubToken();
    const calls = stubCreatePath();
    const result = await openPullRequest(target);
    expect(calls).toHaveLength(2);
    // Lookup: state=open + head=owner:branch (owner derived from the repo slug).
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls?state=open&head=acme%3Afeat%2Fx");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    // Create: POST with exactly the typed inputs; head is the bare branch name.
    expect(calls[1].url).toBe("https://api.github.com/repos/acme/api/pulls");
    expect(calls[1].init.method).toBe("POST");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      title: "Add the widget",
      head: "feat/x",
      base: "main",
      body: "## TL;DR\n\nAdds the widget.",
    });
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer ghtok");
    expect(result).toEqual({ number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: true });
  });

  it("edits the existing open PR instead of creating a second one", async () => {
    stubToken();
    const calls = stubFetch((url, init) =>
      (init.method ?? "GET") === "GET"
        ? new Response(
            JSON.stringify([
              { number: 5, html_url: "https://github.com/acme/api/pull/5", head: { sha: "a".repeat(40) } },
            ]),
            { status: 200 },
          )
        : new Response("{}", { status: 200 }),
    );
    const result = await openPullRequest(target);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe("PATCH");
    expect(calls[1].url).toBe("https://api.github.com/repos/acme/api/pulls/5");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      title: "Add the widget",
      body: "## TL;DR\n\nAdds the widget.",
    });
    expect(result).toEqual({ number: 5, htmlUrl: "https://github.com/acme/api/pull/5", created: false });
  });

  it("findOpenPrByHead returns the first open PR with its head sha, or null when none", async () => {
    stubToken();
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify([
            { number: 12, html_url: "https://github.com/acme/api/pull/12", head: { sha: "b".repeat(40) } },
          ]),
          { status: 200 },
        ),
    );
    const found = await findOpenPrByHead("acme/api", "feat/x");
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls?state=open&head=acme%3Afeat%2Fx");
    expect(found).toEqual({ number: 12, htmlUrl: "https://github.com/acme/api/pull/12", headSha: "b".repeat(40) });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    expect(await findOpenPrByHead("acme/api", "feat/x")).toBeNull();
  });

  it("throws when no credential is available, before any fetch", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    const calls = stubFetch(() => new Response("[]", { status: 200 }));
    await expect(openPullRequest(target)).rejects.toThrow(/no GitHub credential/);
    await expect(findOpenPrByHead("acme/api", "feat/x")).rejects.toThrow(/no GitHub credential/);
    await expect(updatePullRequest("acme/api", 5, { title: "t", body: "b" })).rejects.toThrow(/no GitHub credential/);
    expect(calls).toHaveLength(0);
  });

  it("redacts a credential in the failure body before slicing it into the error (item 62)", async () => {
    stubToken();
    stubCreatePath(422, "denied for GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const err = await openPullRequest(target).catch((e: unknown) => e);
    expect((err as Error).message).toContain("HTTP 422");
    expect((err as Error).message).not.toContain("ghp_");
  });

  it("throws on a non-2xx create with the status and response detail", async () => {
    stubToken();
    stubCreatePath(422, "Validation Failed: field head is invalid");
    await expect(openPullRequest(target)).rejects.toThrow(/PR create failed: HTTP 422.*head is invalid/s);
  });

  it("throws on a non-2xx lookup with the status and response detail", async () => {
    stubToken();
    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(findOpenPrByHead("acme/api", "feat/x")).rejects.toThrow(/PR lookup failed: HTTP 500.*boom/s);
  });

  it("prose in the body cannot alter title/head/base — they come only from the typed inputs", async () => {
    stubToken();
    const calls = stubCreatePath(201, '{"number":9,"html_url":"https://github.com/acme/api/pull/9"}');
    const hostile = "base: main\nhead: attacker:evil\ntitle: pwned\n\n## TL;DR\n\nlooks normal";
    await openPullRequest({
      repo: "acme/api",
      headBranch: "feat/x",
      base: "release-1",
      title: "Real title",
      body: hostile,
    });
    const payload = JSON.parse(String(calls[1].init.body));
    expect(payload.base).toBe("release-1");
    expect(payload.head).toBe("feat/x");
    expect(payload.title).toBe("Real title");
    expect(payload.body).toBe(hostile); // passed through verbatim — inert data, not directives
  });

  it("updatePullRequest PATCHes the known PR number directly and throws on non-2xx", async () => {
    stubToken();
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    await updatePullRequest("acme/api", 31, { title: "T2", body: "B2" });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/31");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: "T2", body: "B2" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    await expect(updatePullRequest("acme/api", 31, { title: "T2", body: "B2" })).rejects.toThrow(
      /PR update failed: HTTP 403/,
    );
  });

  it("clips an oversized body with a visible note so a huge description still lands", async () => {
    stubToken();
    const calls = stubCreatePath();
    await openPullRequest({ ...target, body: "x".repeat(70000) });
    const payload = JSON.parse(String(calls[1].init.body));
    expect(payload.body.length).toBeLessThan(65536);
    expect(payload.body).toMatch(/truncated to fit GitHub's body size limit/);
  });

  it("clipping never splits a surrogate pair: an astral char straddling the boundary is dropped so the body stays well-formed", async () => {
    stubToken();
    const calls = stubCreatePath();
    // 64999 chars, then astral chars (2 UTF-16 code units each): the clip at
    // 65000 lands in the middle of the first pair.
    await openPullRequest({ ...target, body: "x".repeat(64999) + "😀".repeat(20) });
    const payload = JSON.parse(String(calls[1].init.body));
    const cut = payload.body.indexOf("\n\n_(description truncated");
    expect(cut).toBeGreaterThan(0);
    const last = payload.body.charCodeAt(cut - 1);
    // never a lone high surrogate at the clip point
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  // Feature: docs/reference/specs/agent-ship.md items 9–10 — the read-only repo/PR facts
  // the ship gate consumes. Both lookups answer undefined on ANY failure (the
  // caller fail-closes); neither ever throws.
  // Feature: docs/reference/specs/agent-ship.md item 3 — ship round 0 creates the
  // pipeline branch on origin BEFORE the first attach: the resident refuses to
  // bind a thread to a ref GitHub does not have. 422 "already exists" is
  // success (a restarted pipeline reuses its own deterministic branch name).
  describe("createBranchRef (ship round 0)", () => {
    const BASE_SHA = "c".repeat(40);

    /** Base-ref lookup answers `main`'s tip; the ref create answers `createStatus`. */
    function stubRefPath(createStatus = 201, createBody = "{}") {
      return stubFetch((url, init) =>
        (init.method ?? "GET") === "GET"
          ? new Response(JSON.stringify({ ref: "refs/heads/main", object: { sha: BASE_SHA, type: "commit" } }), {
              status: 200,
            })
          : new Response(createBody, { status: createStatus }),
      );
    }

    it("GETs the base ref's sha and POSTs the new ref at it", async () => {
      stubToken();
      const calls = stubRefPath();
      await createBranchRef("acme/api", "ship/fix-login-abc123", "main");
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/git/ref/heads/main");
      expect(calls[0].init.method ?? "GET").toBe("GET");
      expect(calls[1].url).toBe("https://api.github.com/repos/acme/api/git/refs");
      expect(calls[1].init.method).toBe("POST");
      expect(JSON.parse(String(calls[1].init.body))).toEqual({
        ref: "refs/heads/ship/fix-login-abc123",
        sha: BASE_SHA,
      });
      expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer ghtok");
    });

    it("a 422 'already exists' is success — a restarted pipeline reuses its own branch", async () => {
      stubToken();
      stubRefPath(422, '{"message":"Reference already exists"}');
      await expect(createBranchRef("acme/api", "ship/fix-login-abc123", "main")).resolves.toBeUndefined();
    });

    it("anything else throws: a non-already-exists 422, another non-2xx, a failed base lookup, a sha-less answer, a missing credential", async () => {
      stubToken();
      stubRefPath(422, '{"message":"Object does not exist"}');
      await expect(createBranchRef("acme/api", "b", "main")).rejects.toThrow(/HTTP 422/);

      stubRefPath(403, '{"message":"Resource not accessible"}');
      await expect(createBranchRef("acme/api", "b", "main")).rejects.toThrow(/HTTP 403/);

      stubFetch(() => new Response("{}", { status: 404 }));
      await expect(createBranchRef("acme/api", "b", "missing-base")).rejects.toThrow(/HTTP 404/);

      stubFetch(() => new Response('{"object":{}}', { status: 200 }));
      await expect(createBranchRef("acme/api", "b", "main")).rejects.toThrow(/without a sha/);

      vi.stubEnv("GH_TOKEN", "");
      const calls = stubFetch(() => new Response("{}", { status: 200 }));
      await expect(createBranchRef("acme/api", "b", "main")).rejects.toThrow(/credential/);
      expect(calls).toHaveLength(0); // refused before any fetch
    });

    it("a base ref with slashes stays a path (segment-encoded, never a single escaped blob)", async () => {
      stubToken();
      const calls = stubRefPath();
      await createBranchRef("acme/api", "ship/x", "release/1.x");
      expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/git/ref/heads/release/1.x");
    });
  });

  describe("fetchRepoShipInfo (ship auto-merge gate)", () => {
    it("parses allow_auto_merge and default_branch", async () => {
      stubToken();
      const calls = stubFetch(
        () => new Response(JSON.stringify({ allow_auto_merge: true, default_branch: "main" }), { status: 200 }),
      );
      expect(await fetchRepoShipInfo("acme/api")).toEqual({ allowAutoMerge: true, defaultBranch: "main" });
      expect(calls[0].url).toBe("https://api.github.com/repos/acme/api");

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ allow_auto_merge: false, default_branch: "develop" }), { status: 200 }),
        ),
      );
      expect(await fetchRepoShipInfo("acme/api")).toEqual({ allowAutoMerge: false, defaultBranch: "develop" });
    });

    it("a response without the field leaves allowAutoMerge absent (the caller fail-closes on unknown)", async () => {
      stubToken();
      stubFetch(() => new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }));
      expect(await fetchRepoShipInfo("acme/api")).toEqual({ defaultBranch: "main" });
    });

    it("non-2xx, malformed JSON, or a missing credential → undefined, never a throw", async () => {
      stubToken();
      stubFetch(() => new Response("nope", { status: 404 }));
      expect(await fetchRepoShipInfo("acme/api")).toBeUndefined();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not json", { status: 200 })),
      );
      expect(await fetchRepoShipInfo("acme/api")).toBeUndefined();

      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_APP_ID", "");
      const calls = stubFetch(() => new Response("{}", { status: 200 }));
      expect(await fetchRepoShipInfo("acme/api")).toBeUndefined();
      expect(calls).toHaveLength(0); // no unauthenticated repo-settings probe
    });
  });

  describe("fetchPullRequestFacts (ship entry checks)", () => {
    const openPr = {
      state: "open",
      html_url: "https://github.com/acme/api/pull/7",
      user: { login: "acme-switchboard[bot]", id: 318072483 },
      head: { ref: "ship/fix-x-abc123", sha: "c".repeat(40), repo: { full_name: "acme/api" } },
    };

    it("parses state, author login+id, head ref/sha, and a POSITIVE same-repo head match", async () => {
      stubToken();
      const calls = stubFetch(() => new Response(JSON.stringify(openPr), { status: 200 }));
      expect(await fetchPullRequestFacts({ repo: "acme/api", number: 7 })).toEqual({
        state: "open",
        author: { login: "acme-switchboard[bot]", id: 318072483 },
        headRef: "ship/fix-x-abc123",
        headSha: "c".repeat(40),
        sameRepoHead: true,
        htmlUrl: "https://github.com/acme/api/pull/7",
      });
      expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/7");
    });

    // The coordinator's `read-record` asks whether the bot's own verdict stands
    // on the pull request at the reviewed head (agent-ship.md item 9).
    it("fetchPullRequestReviews lists the reviews with author, state, pinned head and body; a failed fetch or a non-list answer is undefined, never a throw", async () => {
      stubToken();
      const calls = stubFetch(
        () =>
          new Response(
            JSON.stringify([
              {
                user: { login: "acme-switchboard[bot]", id: 318072483 },
                state: "COMMENTED",
                commit_id: "c".repeat(40),
                body: "LGTM: clean",
              },
              { user: { login: "alice" }, state: "APPROVED", commit_id: "c".repeat(40), body: null },
              { state: 7 },
            ]),
            { status: 200 },
          ),
      );
      expect(await fetchPullRequestReviews({ repo: "acme/api", number: 7 })).toEqual([
        {
          author: { login: "acme-switchboard[bot]", id: 318072483 },
          state: "COMMENTED",
          commitId: "c".repeat(40),
          body: "LGTM: clean",
        },
        { author: { login: "alice" }, state: "APPROVED", commitId: "c".repeat(40), body: "" },
      ]);
      expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/pulls/7/reviews?per_page=100");
      stubFetch(() => new Response("nope", { status: 502 }));
      expect(await fetchPullRequestReviews({ repo: "acme/api", number: 7 })).toBeUndefined();
      stubFetch(() => new Response(JSON.stringify({ not: "a list" }), { status: 200 }));
      expect(await fetchPullRequestReviews({ repo: "acme/api", number: 7 })).toBeUndefined();
      vi.stubGlobal("fetch", async () => {
        throw new Error("offline");
      });
      expect(await fetchPullRequestReviews({ repo: "acme/api", number: 7 })).toBeUndefined();
    });

    // The PR object lags the branch ref after a force-push; the ref is the head.
    it("a same-repo head reads the head ref's tip and prefers it over a lagging head.sha; a fork head asks for no ref", async () => {
      stubToken();
      const TIP = "d".repeat(40);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const calls = stubFetch((url) =>
        String(url).includes("/git/ref/heads/")
          ? new Response(JSON.stringify({ object: { sha: TIP, type: "commit" } }), { status: 200 })
          : new Response(JSON.stringify(openPr), { status: 200 }),
      );
      const facts = await fetchPullRequestFacts({ repo: "acme/api", number: 7 });
      expect(facts?.headSha).toBe(TIP);
      expect(facts?.headRef).toBe("ship/fix-x-abc123");
      expect(calls[1].url).toBe("https://api.github.com/repos/acme/api/git/ref/heads/ship/fix-x-abc123");
      expect(log.mock.calls.some((c) => String(c[0]).startsWith("[pr-head] acme/api#7"))).toBe(true);
      log.mockRestore();
      // a fork head: the PR object's sha, one call
      const forkCalls = stubFetch(
        () => new Response(JSON.stringify({ ...openPr, head: { ...openPr.head, repo: { full_name: "other/fork" } } })),
      );
      const fork = await fetchPullRequestFacts({ repo: "acme/api", number: 7 });
      expect(fork?.headSha).toBe("c".repeat(40));
      expect(fork?.sameRepoHead).toBe(false);
      expect(forkCalls).toHaveLength(1);
    });

    it("a ref that does not point at a commit object (a tag, a type-less answer) is not a head: the PR object's sha stands", async () => {
      stubToken();
      for (const object of [{ sha: "e".repeat(40), type: "tag" }, { sha: "e".repeat(40) }]) {
        stubFetch((url) =>
          String(url).includes("/git/ref/heads/")
            ? new Response(JSON.stringify({ object }), { status: 200 })
            : new Response(JSON.stringify(openPr), { status: 200 }),
        );
        expect((await fetchPullRequestFacts({ repo: "acme/api", number: 7 }))?.headSha).toBe("c".repeat(40));
      }
    });

    it("parses the PR's own base ref — the resume path's true merge base", async () => {
      stubToken();
      stubFetch(() => new Response(JSON.stringify({ ...openPr, base: { ref: "release/1.x" } }), { status: 200 }));
      const facts = await fetchPullRequestFacts({ repo: "acme/api", number: 7 });
      expect(facts?.baseRef).toBe("release/1.x");
    });

    it("a deleted-fork null head repo is sameRepoHead: false — never assumed same-repo", async () => {
      stubToken();
      stubFetch(
        () => new Response(JSON.stringify({ ...openPr, head: { ...openPr.head, repo: null } }), { status: 200 }),
      );
      const facts = await fetchPullRequestFacts({ repo: "acme/api", number: 7 });
      expect(facts?.sameRepoHead).toBe(false);
    });

    it("a malformed sha is dropped; an unrecognizable state, non-2xx, or fetch throw → undefined", async () => {
      stubToken();
      stubFetch(
        () => new Response(JSON.stringify({ ...openPr, head: { ...openPr.head, sha: "HEAD" } }), { status: 200 }),
      );
      expect((await fetchPullRequestFacts({ repo: "acme/api", number: 7 }))?.headSha).toBeUndefined();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ state: "weird" }), { status: 200 })),
      );
      expect(await fetchPullRequestFacts({ repo: "acme/api", number: 7 })).toBeUndefined();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("x", { status: 500 })),
      );
      expect(await fetchPullRequestFacts({ repo: "acme/api", number: 7 })).toBeUndefined();

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("boom"))),
      );
      expect(await fetchPullRequestFacts({ repo: "acme/api", number: 7 })).toBeUndefined();
    });

    it("works unauthenticated (public repos): no credential drops the auth header, the lookup still runs", async () => {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_APP_ID", "");
      const calls = stubFetch(() => new Response(JSON.stringify(openPr), { status: 200 }));
      expect((await fetchPullRequestFacts({ repo: "acme/api", number: 7 }))?.state).toBe("open");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });
});
