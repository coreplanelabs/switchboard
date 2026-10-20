import { describe, expect, it } from "vitest";
import type { GithubCredentialSource } from "./githubApp.js";
import { GithubApiError, InMemoryGithubApi, MAX_FILE_CHARS, RestGithubApi, readTextCapped } from "./githubApi.js";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";

// Feature: features/github-tools.md — the GithubApi seam behind the github_*
// tools. RestGithubApi speaks the REST (+ one GraphQL mutation) API from the
// bot process with the App token, read-scoped for reads and write-scoped for
// writes (invariant 5); InMemoryGithubApi is the second implementation and the
// test double (invariant 2).

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(
  routes: (call: Call) =>
    | {
        status: number;
        body?: unknown;
        text?: string;
        stream?: ReadableStream<Uint8Array>;
        headers?: Record<string, string>;
      }
    | undefined,
) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url, method, headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    const r = routes(call) ?? { status: 404, body: { message: "Not Found" } };
    return new Response(r.stream ?? r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body)), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const scopes: string[] = [];
const token = async (scope: "read" | "write") => {
  scopes.push(scope);
  return `tok-${scope}`;
};
const api = (routes: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(routes);
  return { api: new RestGithubApi({ fetch: f.fetch, token }), calls: f.calls };
};

describe("pull request feedback", () => {
  it("reads inline comments and replies across every page with their native source and location", async () => {
    const raw = {
      id: 1,
      pull_request_review_id: 9,
      user: { login: "review[bot]", id: 11, type: "Bot" },
      body: "Keep the original owner",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      html_url: "https://github.com/acme/api/pull/7#discussion_r1",
      path: "src/queue.ts",
      commit_id: "a".repeat(40),
      original_commit_id: "b".repeat(40),
      diff_hunk: "@@ -1 +1 @@\n-owner\n+next",
      line: null,
      original_line: 4,
      start_line: null,
      start_side: null,
      side: "RIGHT",
      subject_type: "line",
    };
    const { api: gh, calls } = api(({ url }) => {
      if (url.includes("/pulls/7/comments"))
        return {
          status: 200,
          body: url.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 }))
            : [{ ...raw, id: 101, user: { login: "author", id: 12, type: "User" }, body: "Fixed", in_reply_to_id: 1 }],
        };
      return { status: 200, body: [] };
    });
    const result = await gh.getPullRequestFeedback("acme/api", 7);
    expect(result.reviewComments).toHaveLength(101);
    expect(result.reviewComments[100]).toEqual({
      id: 101,
      reviewId: 9,
      author: "author",
      authorId: 12,
      authorType: "User",
      body: "Fixed",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      url: raw.html_url,
      path: "src/queue.ts",
      head: "a".repeat(40),
      originalHead: "b".repeat(40),
      diffHunk: "@@ -1 +1 @@\n-owner\n+next",
      line: null,
      originalLine: 4,
      startLine: null,
      startSide: null,
      side: "RIGHT",
      subjectType: "line",
      inReplyToId: 1,
    });
    expect(calls.map((c) => ({ method: c.method, token: c.headers.authorization }))).toEqual([
      { method: "GET", token: "Bearer tok-read" },
      { method: "GET", token: "Bearer tok-read" },
      { method: "GET", token: "Bearer tok-read" },
      { method: "GET", token: "Bearer tok-read" },
    ]);
  });

  it.each(["failed", "malformed", "limit"])("refuses %s inline history rather than proving it empty", async (mode) => {
    const { api: gh } = api(({ url }) => {
      if (!url.includes("/pulls/7/comments")) return { status: 200, body: [] };
      if (mode === "failed") return { status: 503, body: { message: "unavailable" } };
      return { status: 200, body: mode === "malformed" ? [{}] : Array.from({ length: 100 }, () => ({})) };
    });
    await expect(gh.getPullRequestFeedback("acme/api", 7)).rejects.toThrow();
  });

  it("preserves file-level comments with no line or review association", async () => {
    const { api: gh } = api(({ url }) => ({
      status: 200,
      body: url.includes("/pulls/7/comments")
        ? [
            {
              id: 5,
              pull_request_review_id: null,
              user: { login: "reviewer", id: 12, type: "Mannequin" },
              body: "This file needs a guard",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              html_url: "https://github.com/acme/api/pull/7#discussion_r5",
              path: "src/queue.ts",
              commit_id: "a".repeat(40),
              original_commit_id: "a".repeat(40),
              diff_hunk: "",
              line: null,
              start_line: null,
              start_side: null,
              subject_type: "file",
            },
          ]
        : [],
    }));
    expect((await gh.getPullRequestFeedback("acme/api", 7)).reviewComments).toMatchObject([
      {
        id: 5,
        reviewId: null,
        authorId: 12,
        authorType: "Mannequin",
        subjectType: "file",
        line: null,
        startSide: null,
      },
    ]);
  });

  it.each([false, true])("retains an inline comment with a null native author (reply: %s)", async (reply) => {
    const raw = {
      id: 5,
      pull_request_review_id: 9,
      user: null,
      body: "Keep this source evidence",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      html_url: "https://github.com/acme/api/pull/7#discussion_r5",
      path: "src/queue.ts",
      commit_id: "a".repeat(40),
      original_commit_id: "a".repeat(40),
      diff_hunk: "@@ -1 +1 @@\n+guard",
      line: 1,
      ...(reply ? { in_reply_to_id: 1 } : {}),
    };
    const { api: gh } = api(({ url }) => ({ status: 200, body: url.includes("/pulls/7/comments") ? [raw] : [] }));
    const result = await gh.getPullRequestFeedback("acme/api", 7);
    expect(result.reviewComments).toMatchObject([
      { id: 5, reviewId: 9, author: null, authorId: null, authorType: null, body: "Keep this source evidence" },
    ]);
    expect(result.reviewComments[0]!.inReplyToId).toBe(reply ? 1 : undefined);
    for (const user of [undefined, {}]) {
      const malformed = api(({ url }) => ({
        status: 200,
        body: url.includes("/pulls/7/comments") ? [{ ...raw, user }] : [],
      })).api;
      await expect(malformed.getPullRequestFeedback("acme/api", 7)).rejects.toThrow();
    }
  });

  it("reads every review and conversation page with the read token", async () => {
    const raw = {
      id: 1,
      user: { login: "review[bot]", type: "Bot" },
      body: "finding",
      commit_id: "a".repeat(40),
      state: "COMMENTED",
      submitted_at: "2026-01-01T00:00:00Z",
    };
    const { api: gh, calls } = api(({ url }) => {
      if (url.includes("/pulls/7/comments")) return { status: 200, body: [] };
      if (url.includes("/pulls/7/reviews"))
        return {
          status: 200,
          body: url.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 }))
            : [{ ...raw, id: 101 }],
        };
      if (url.includes("/issues/7/comments"))
        return {
          status: 200,
          body: [
            {
              id: 102,
              user: { login: "author" },
              body: "Fixed F1 with unique write IDs",
              created_at: "2026-01-02T00:00:00Z",
            },
          ],
        };
    });
    const result = await gh.getPullRequestFeedback("acme/api", 7);
    expect(result.reviews).toHaveLength(101);
    expect(result.reviews[100]).toMatchObject({ id: 101, author: "review[bot]", head: raw.commit_id, body: "finding" });
    expect(result.comments).toMatchObject([{ id: 102, author: "author", body: "Fixed F1 with unique write IDs" }]);
    expect(calls.every((c) => c.method === "GET" && c.headers.authorization === "Bearer tok-read")).toBe(true);
  });

  it("refuses partial, malformed and over-limit history instead of returning an empty history", async () => {
    const raw = {
      id: 1,
      user: { login: "review[bot]", type: "Bot" },
      body: "finding",
      commit_id: "a".repeat(40),
      state: "COMMENTED",
      submitted_at: "2026-01-01T00:00:00Z",
    };
    for (const mode of ["partial", "malformed", "limit"]) {
      const { api: gh } = api(({ url }) => {
        if (mode === "malformed") return { status: 200, body: {} };
        if (url.includes("/pulls/7/reviews"))
          return {
            status: 200,
            body: mode === "partial" ? [] : Array.from({ length: 100 }, (_, i) => ({ ...raw, id: i + 1 })),
          };
        return { status: 503, body: { message: "unavailable" } };
      });
      await expect(gh.getPullRequestFeedback("acme/api", 7)).rejects.toThrow();
    }
  });
});

describe("RestGithubApi — reads use the read token", () => {
  it("readFile decodes base64 content and returns size/sha/url; the ref is passed", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url }) =>
      url.endsWith("/repos/acme/api/contents/features/x.md?ref=main")
        ? {
            status: 200,
            body: {
              type: "file",
              encoding: "base64",
              size: 5,
              sha: "abc",
              html_url: "https://github.com/acme/api/blob/main/features/x.md",
              content: Buffer.from("hello").toString("base64"),
            },
          }
        : undefined,
    );
    const f = await gh.readFile("acme/api", "features/x.md", "main");
    expect(f).toEqual({
      path: "features/x.md",
      content: "hello",
      size: 5,
      truncated: false,
      sha: "abc",
      url: "https://github.com/acme/api/blob/main/features/x.md",
    });
    expect(calls[0].headers.authorization).toBe("Bearer tok-read");
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
    expect(scopes).toEqual(["read"]);
  });

  it("readFile: a directory answer and a non-file type are 400s that name the other tool; >1 MB (encoding none) re-reads raw; binary is a note; long text is clipped", async () => {
    const big = "x".repeat(MAX_FILE_CHARS + 10);
    const { api: gh } = api(({ url, headers }) => {
      if (url.includes("/contents/dir")) return { status: 200, body: [{ path: "dir/a" }] };
      if (url.includes("/contents/link")) return { status: 200, body: { type: "symlink" } };
      if (url.includes("/contents/huge") && headers.accept === "application/vnd.github.raw+json")
        return { status: 200, text: big };
      if (url.includes("/contents/huge"))
        return { status: 200, body: { type: "file", encoding: "none", size: big.length, content: "" } };
      if (url.includes("/contents/bin"))
        return {
          status: 200,
          body: { type: "file", encoding: "base64", size: 3, content: Buffer.from([0, 1, 2]).toString("base64") },
        };
      return undefined;
    });
    await expect(gh.readFile("acme/api", "dir")).rejects.toMatchObject({
      status: 400,
      message: "dir is a directory — list it with github_tree",
    });
    await expect(gh.readFile("acme/api", "link")).rejects.toMatchObject({
      status: 400,
      message: "link is a symlink, not a file",
    });
    const huge = await gh.readFile("acme/api", "huge");
    expect(huge.truncated).toBe(true);
    expect(huge.content).toHaveLength(MAX_FILE_CHARS);
    // The caller's own bound: a reader that needs the whole document (the plan
    // runner) passes one and gets every character; a bound below the clip clips there.
    const whole = await gh.readFile("acme/api", "huge", undefined, { maxChars: big.length });
    expect(whole.truncated).toBe(false);
    expect(whole.content).toBe(big);
    const short = await gh.readFile("acme/api", "huge", undefined, { maxChars: 10 });
    expect(short).toMatchObject({ truncated: true, content: "xxxxxxxxxx" });
    expect((await gh.readFile("acme/api", "bin")).content).toBe("(binary file, 3 bytes — not shown)");
  });

  it("listTree maps entries (dirs, files with sizes) and refuses a file path; path segments are URL-encoded", async () => {
    const { api: gh, calls } = api(({ url }) => {
      if (url.endsWith("/contents/src%20x/a%20b"))
        return {
          status: 200,
          body: [
            { path: "src x/a b/one.ts", type: "file", size: 12 },
            { path: "src x/a b/sub", type: "dir" },
          ],
        };
      if (url.endsWith("/contents/README.md")) return { status: 200, body: { type: "file" } };
      return undefined;
    });
    expect(await gh.listTree("acme/api", "src x/a b")).toEqual([
      { path: "src x/a b/one.ts", type: "file", size: 12 },
      { path: "src x/a b/sub", type: "dir" },
    ]);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/contents/src%20x/a%20b");
    await expect(gh.listTree("acme/api", "README.md")).rejects.toMatchObject({
      status: 400,
      message: "README.md is a file — read it with github_file",
    });
  });

  it("searchCode scopes to a repo, asks for text matches, clamps the limit, and maps fragments", async () => {
    const { api: gh, calls } = api(() => ({
      status: 200,
      body: {
        items: [
          {
            path: "a.ts",
            html_url: "u",
            repository: { full_name: "acme/api" },
            text_matches: [{ fragment: "resident watchdog" }],
          },
        ],
      },
    }));
    const hits = await gh.searchCode("watchdog", "acme/api", 99);
    expect(hits).toEqual([{ repo: "acme/api", path: "a.ts", url: "u", fragments: ["resident watchdog"] }]);
    expect(calls[0].url).toBe(
      `https://api.github.com/search/code?q=${encodeURIComponent("watchdog repo:acme/api")}&per_page=30`,
    );
    expect(calls[0].headers.accept).toBe("application/vnd.github.text-match+json");
  });

  it("requires explicit current public metadata for the same repository on the read token", async () => {
    const bodies: Record<string, unknown> = {
      public: { full_name: "Acme/Public", private: false, visibility: "public" },
      private: { full_name: "acme/private", private: true, visibility: "private" },
      internal: { full_name: "acme/internal", private: false, visibility: "internal" },
      unknown: { full_name: "acme/unknown" },
      incomplete: { full_name: "acme/incomplete", visibility: "public" },
      renamed: { full_name: "other/public", private: false, visibility: "public" },
    };
    const { api: gh, calls } = api(({ url }) => ({ status: 200, body: bodies[url.split("/").at(-1)!] }));
    expect(await gh.isPublicRepo("acme/public")).toBe(true);
    for (const name of ["private", "internal", "unknown", "incomplete", "renamed"])
      expect(await gh.isPublicRepo(`acme/${name}`)).toBe(false);
    expect(calls.map((call) => call.headers.authorization)).toEqual(Array(6).fill("Bearer tok-read"));
    const memory = new InMemoryGithubApi({ "acme/public": { private: false }, "acme/private": {} });
    expect(await memory.isPublicRepo("ACME/PUBLIC")).toBe(true);
    expect(await memory.isPublicRepo("acme/private")).toBe(false);
    expect(await memory.isPublicRepo("acme/absent")).toBe(false);
  });

  it("listRepos pages the installation's repositories", async () => {
    const { api: gh } = api(({ url }) =>
      url.includes("page=1")
        ? {
            status: 200,
            body: {
              repositories: [
                { full_name: "acme/api", private: true, default_branch: "main", description: "d" },
                { full_name: "acme/unknown-visibility" },
              ],
            },
          }
        : { status: 200, body: { repositories: [] } },
    );
    expect(await gh.listRepos()).toEqual([
      { fullName: "acme/api", private: true, defaultBranch: "main", description: "d" },
      { fullName: "acme/unknown-visibility", private: true, defaultBranch: "main", description: null },
    ]);
  });

  it("reads current user permission on the App read token and treats missing or malformed proof as absent", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url }) => {
      if (url.endsWith("/acme/private/collaborators/ivy-dev/permission"))
        return { status: 200, body: { permission: "read", user: { login: "ivy-dev", id: 4242 } } };
      if (url.endsWith("/acme/malformed/collaborators/ivy-dev/permission"))
        return { status: 200, body: { permission: "read", user: { login: "ivy-dev" } } };
      return undefined;
    });
    expect(await gh.getUserRepoPermission("acme/private", "ivy-dev")).toEqual({
      permission: "read",
      user: { login: "ivy-dev", id: 4242 },
    });
    expect(await gh.getUserRepoPermission("acme/malformed", "ivy-dev")).toBeNull();
    expect(await gh.getUserRepoPermission("acme/absent", "ivy-dev")).toBeNull();
    expect(calls.every((call) => call.headers.authorization === "Bearer tok-read")).toBe(true);
    expect(scopes).toEqual(["read", "read", "read"]);
  });

  it("listRepos includes every connected repository beyond three pages", async () => {
    const { api: gh, calls } = api(({ url }) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return {
        status: 200,
        body: {
          total_count: 400,
          repositories: Array.from({ length: 100 }, (_, index) => ({
            full_name: `acme/repo-${(page - 1) * 100 + index}`,
            private: true,
            default_branch: "main",
          })),
        },
      };
    });
    const repos = await gh.listRepos();
    expect(repos).toHaveLength(400);
    expect(repos.at(-1)?.fullName).toBe("acme/repo-399");
    expect(calls).toHaveLength(4);
  });

  it("listIssues drops pull requests, passes state/labels/limit, and maps rows; getIssue fetches comments only when there are any and refuses a PR", async () => {
    const row = (n: number, extra: Record<string, unknown> = {}) => ({
      number: n,
      title: `t${n}`,
      state: "open",
      html_url: `u${n}`,
      labels: [{ name: "bug" }],
      assignees: [{ login: "j" }],
      user: { login: "matanya" },
      created_at: "c",
      updated_at: "u",
      body: "b",
      comments: 0,
      ...extra,
    });
    const { api: gh, calls } = api(({ url }) => {
      if (url.includes("/issues?")) return { status: 200, body: [row(1), row(2, { pull_request: {} })] };
      if (url.endsWith("/issues/7/comments?per_page=30"))
        return { status: 200, body: [{ user: { login: "x" }, created_at: "c1", body: "hi" }] };
      if (url.endsWith("/issues/7")) return { status: 200, body: row(7, { comments: 1 }) };
      if (url.endsWith("/issues/8")) return { status: 200, body: row(8, { pull_request: {} }) };
      return undefined;
    });
    const list = await gh.listIssues("acme/api", { state: "all", labels: ["bug", "p1"], limit: 5 });
    expect(list.map((i) => i.number)).toEqual([1]);
    expect(list[0]).toMatchObject({
      title: "t1",
      state: "open",
      labels: ["bug"],
      assignees: ["j"],
      author: "matanya",
      body: "b",
    });
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/api/issues?state=all&per_page=100&page=1&sort=updated&direction=desc&labels=bug%2Cp1",
    );
    const got = await gh.getIssue("acme/api", 7);
    expect(got.comments).toEqual([{ author: "x", createdAt: "c1", body: "hi" }]);
    await expect(gh.getIssue("acme/api", 8)).rejects.toMatchObject({
      status: 400,
      message: "#8 is a pull request, not an issue",
    });
  });

  it("listIssues keeps paging while pull requests crowd out issues, and stops at `limit` issues or the end of the list", async () => {
    const row = (n: number, extra: Record<string, unknown> = {}) => ({
      number: n,
      title: `t${n}`,
      state: "open",
      html_url: `u${n}`,
      labels: [],
      assignees: [],
      user: { login: "j" },
      created_at: "c",
      updated_at: "u",
      ...extra,
    });
    // Page 1: 100 rows, only #1 is an issue. Page 2: 10 rows, all issues (a short page = the end).
    const page1 = [row(1), ...Array.from({ length: 99 }, (_, i) => row(100 + i, { pull_request: {} }))];
    const page2 = Array.from({ length: 10 }, (_, i) => row(200 + i));
    const { api: gh, calls } = api(({ url }) => {
      const page = new URL(url).searchParams.get("page");
      if (url.includes("/issues?") && page === "1") return { status: 200, body: page1 };
      if (url.includes("/issues?") && page === "2") return { status: 200, body: page2 };
      return undefined;
    });
    const five = await gh.listIssues("acme/api", { limit: 5 });
    expect(five.map((i) => i.number)).toEqual([1, 200, 201, 202, 203]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
    // Everything: page 2 is short, so no page 3 is requested even under the 100 cap.
    calls.length = 0;
    expect((await gh.listIssues("acme/api", { limit: 100 })).map((i) => i.number)).toHaveLength(11);
    expect(calls).toHaveLength(2);
    // A PR-only repo stops at the page cap instead of paging forever.
    const prOnly = api(() => ({
      status: 200,
      body: Array.from({ length: 100 }, (_, i) => row(i, { pull_request: {} })),
    }));
    expect(await prOnly.api.listIssues("acme/api")).toEqual([]);
    expect(prOnly.calls).toHaveLength(3);
  });

  it("readFile's raw re-read streams only up to the clip: a multi-MB blob is cancelled once MAX_FILE_CHARS are in hand", async () => {
    const CHUNK = 50_000;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 200)
          controller.close(); // 10 MB if read to the end
        else controller.enqueue(new TextEncoder().encode("y".repeat(CHUNK)));
      },
    });
    const { api: gh } = api(({ url, headers }) => {
      if (url.includes("/contents/huge") && headers.accept === "application/vnd.github.raw+json")
        return { status: 200, stream };
      if (url.includes("/contents/huge"))
        return { status: 200, body: { type: "file", encoding: "none", size: 200 * CHUNK, content: "" } };
      return undefined;
    });
    const huge = await gh.readFile("acme/api", "huge");
    expect(huge.truncated).toBe(true);
    expect(huge.content).toHaveLength(MAX_FILE_CHARS);
    expect(huge.size).toBe(200 * CHUNK);
    expect(pulled).toBeLessThanOrEqual(Math.ceil((MAX_FILE_CHARS + 1) / CHUNK) + 1);
    // A body that cannot stream still reads, capped.
    expect(await readTextCapped(new Response("abcdef"), 3)).toBe("abc");
  });

  it("a failure body is redacted before it is sliced into the error (resident-repos item 62's GitHub half)", async () => {
    const { api: gh } = api(() => ({
      status: 500,
      body: { message: "upstream said GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    }));
    const err = await gh.listIssues("acme/api").catch((e: unknown) => e);
    expect((err as Error).message).toContain("HTTP 500");
    expect((err as Error).message).not.toContain("ghp_");
  });

  it("a non-2xx is a GithubApiError with the status and GitHub's message; no credential is a 401 before any request", async () => {
    const { api: gh, calls } = api(() => ({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    }));
    await expect(gh.listIssues("acme/api")).rejects.toMatchObject({
      status: 403,
      message:
        "GitHub GET /repos/acme/api/issues?state=open&per_page=100&page=1&sort=updated&direction=desc failed: HTTP 403 Resource not accessible by integration",
    });
    expect(calls).toHaveLength(1);
    const none = new RestGithubApi({ fetch: fakeFetch(() => ({ status: 200 })).fetch, token: async () => null });
    await expect(none.listRepos()).rejects.toMatchObject({ status: 401 });
    expect(await none.listRepos().catch((e: GithubApiError) => e.message)).toBe(
      "no GitHub credential available (configure the GitHub App or GH_TOKEN)",
    );
  });
});

describe("RestGithubApi — pull request reads", () => {
  it("reads every check page at the exact commit with the read credential", async () => {
    const sha = "a".repeat(40);
    const row = (id: number) => ({
      id,
      name: `check ${id}`,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/acme/api/runs/${id}`,
      details_url: "https://depot.dev/workflows/example",
    });
    const { api: gh, calls } = api((c) => ({
      status: 200,
      body: {
        total_count: 101,
        check_runs: c.url.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => row(i + 1)) : [row(101)],
      },
    }));
    const checks = await gh.getCommitChecks("acme/api", sha);
    expect(checks).toHaveLength(101);
    expect(checks[100]).toEqual({
      id: 101,
      name: "check 101",
      head: sha,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/api/runs/101",
      detailsUrl: "https://depot.dev/workflows/example",
    });
    expect(calls.map((c) => ({ url: c.url, method: c.method, auth: c.headers.authorization }))).toEqual(
      [1, 2].map((page) => ({
        url: `https://api.github.com/repos/acme/api/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
        method: "GET",
        auth: "Bearer tok-read",
      })),
    );
  });

  it.each(["missing", "partial", "wrong head", "duplicate", "over limit", "count changed", "invalid conclusion"])(
    "refuses %s check evidence instead of presenting an empty or complete CI result",
    async (mode) => {
      const sha = "a".repeat(40);
      const row = {
        id: 1,
        name: "CI",
        head_sha: mode === "wrong head" ? "b".repeat(40) : sha,
        status: "completed",
        conclusion: mode === "invalid conclusion" ? "unknown" : "success",
        html_url: "https://github.com/acme/api/runs/1",
        details_url: null,
      };
      const { api: gh } = api((c) => ({
        status: 200,
        body:
          mode === "missing"
            ? {}
            : {
                total_count:
                  mode === "over limit"
                    ? 301
                    : mode === "partial"
                      ? 2
                      : mode === "duplicate"
                        ? 2
                        : mode === "count changed"
                          ? c.url.endsWith("page=1")
                            ? 101
                            : 102
                          : 1,
                check_runs:
                  mode === "duplicate"
                    ? [row, row]
                    : mode === "count changed" && c.url.endsWith("page=1")
                      ? Array.from({ length: 100 }, (_, i) => ({ ...row, id: i + 1 }))
                      : [row],
              },
      }));
      await expect(gh.getCommitChecks("acme/api", sha)).rejects.toThrow("check");
    },
  );

  it.each([
    {
      scenario: "lagging same-repository metadata",
      state: "open",
      headRepo: "ACME/API",
      object: { type: "commit", sha: "b".repeat(40) },
      expected: "b".repeat(40),
      readsRef: true,
    },
    {
      scenario: "matching same-repository metadata",
      state: "open",
      headRepo: "acme/api",
      object: { type: "commit", sha: "a".repeat(40) },
      expected: "a".repeat(40),
      readsRef: true,
    },
    {
      scenario: "unreadable branch",
      state: "open",
      headRepo: "acme/api",
      status: 503,
      expected: "a".repeat(40),
      readsRef: true,
    },
    {
      scenario: "non-commit branch target",
      state: "open",
      headRepo: "acme/api",
      object: { type: "tag", sha: "b".repeat(40) },
      expected: "a".repeat(40),
      readsRef: true,
    },
    {
      scenario: "malformed branch commit",
      state: "open",
      headRepo: "acme/api",
      object: { type: "commit", sha: "HEAD" },
      expected: "a".repeat(40),
      readsRef: true,
    },
    {
      scenario: "missing branch object",
      state: "open",
      headRepo: "acme/api",
      expected: "a".repeat(40),
      readsRef: true,
    },
    {
      scenario: "fork head",
      state: "open",
      headRepo: "fork/api",
      object: { type: "commit", sha: "b".repeat(40) },
      expected: "a".repeat(40),
      readsRef: false,
    },
    {
      scenario: "deleted fork",
      state: "open",
      headRepo: "",
      object: { type: "commit", sha: "b".repeat(40) },
      expected: "a".repeat(40),
      readsRef: false,
    },
    {
      scenario: "closed PR with reused branch",
      state: "closed",
      headRepo: "acme/api",
      object: { type: "commit", sha: "b".repeat(40) },
      expected: "a".repeat(40),
      readsRef: false,
    },
  ])(
    "getPullRequest uses the authoritative head for $scenario",
    async ({ state, headRepo, object, status, expected, readsRef }) => {
      const { api: gh, calls } = api(({ url }) =>
        url.endsWith("/pulls/7")
          ? {
              status: 200,
              body: {
                number: 7,
                state,
                head: { repo: { full_name: headRepo }, ref: "fix/login", sha: "a".repeat(40) },
                base: { repo: { full_name: "acme/api" }, ref: "main" },
              },
            }
          : { status: status ?? 200, body: { object } },
      );
      expect((await gh.getPullRequest("acme/api", 7)).head.sha).toBe(expected);
      expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
        "/repos/acme/api/pulls/7",
        ...(readsRef ? ["/repos/acme/api/git/ref/heads/fix/login"] : []),
      ]);
      expect(calls.every((c) => c.headers.authorization === "Bearer tok-read")).toBe(true);
    },
  );

  it("getPullRequest preserves merge time so a merged PR is not reported as merely closed", async () => {
    const { api: gh } = api(() => ({
      status: 200,
      body: {
        number: 7,
        title: "Fix login",
        body: "",
        state: "closed",
        merged_at: "2026-09-29T01:02:03Z",
        draft: false,
        html_url: "https://github.com/acme/api/pull/7",
        user: { login: "ada" },
        updated_at: "2026-09-29T01:02:03Z",
        head: { ref: "fix/login", sha: "a".repeat(40), repo: { full_name: "acme/api" } },
        base: { ref: "main", repo: { full_name: "acme/api" } },
      },
    }));
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({
      state: "closed",
      mergedAt: "2026-09-29T01:02:03Z",
    });
  });

  it("getPullRequest reads title, body and exact refs with the read token", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url }) =>
      url.endsWith("/repos/acme/api/pulls/7")
        ? {
            status: 200,
            body: {
              number: 7,
              title: "Fix login",
              body: "Keep this context",
              state: "open",
              draft: false,
              html_url: "https://github.com/acme/api/pull/7",
              user: { login: "ada" },
              updated_at: "2026-09-29T00:00:00Z",
              head: { ref: "fix/login", sha: "a".repeat(40), repo: { full_name: "acme/api" } },
              base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "acme/api" } },
            },
          }
        : undefined,
    );
    expect(await gh.getPullRequest("acme/api", 7)).toEqual({
      number: 7,
      title: "Fix login",
      body: "Keep this context",
      state: "open",
      draft: false,
      url: "https://github.com/acme/api/pull/7",
      author: "ada",
      updatedAt: "2026-09-29T00:00:00Z",
      head: { repo: "acme/api", ref: "fix/login", sha: "a".repeat(40) },
      base: { repo: "acme/api", ref: "main", sha: "b".repeat(40) },
      headFacts: { title: "Fix login", body: "Keep this context", merged: false },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.headers.authorization === "Bearer tok-read")).toBe(true);
    expect(scopes).toEqual(["read", "read"]);
  });
});

describe("RestGithubApi — writes use the write token", () => {
  it("createIssue posts title/body/labels/assignees (omitting empties), clips a huge body, and maps the row", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url, method }) =>
      method === "POST" && url.endsWith("/repos/acme/api/issues")
        ? {
            status: 201,
            body: {
              number: 12,
              title: "foo",
              state: "open",
              html_url: "https://github.com/acme/api/issues/12",
              labels: [],
              assignees: [],
              user: { login: "switchboard[bot]" },
              created_at: "c",
              updated_at: "u",
            },
          }
        : undefined,
    );
    const issue = await gh.createIssue("acme/api", { title: "foo", body: "bar", labels: [], assignees: ["j"] });
    expect(issue).toMatchObject({ number: 12, url: "https://github.com/acme/api/issues/12" });
    expect(calls[0].body).toEqual({ title: "foo", body: "bar", assignees: ["j"] });
    expect(calls[0].headers.authorization).toBe("Bearer tok-write");
    expect(scopes).toEqual(["write"]);
    await gh.createIssue("acme/api", { title: "big", body: "y".repeat(70_000) });
    expect(String((calls[1].body as { body: string }).body)).toMatch(/clipped by Switchboard/);
  });

  it("updateIssue PATCHes only the given fields; commentIssue posts the body and returns the comment URL", async () => {
    const { api: gh, calls } = api(({ url, method }) => {
      if (method === "PATCH" && url.endsWith("/issues/3"))
        return { status: 200, body: { number: 3, title: "new", state: "closed", html_url: "u3" } };
      if (method === "POST" && url.endsWith("/issues/3/comments")) return { status: 201, body: { html_url: "u3#c1" } };
      return undefined;
    });
    expect(await gh.updateIssue("acme/api", 3, { state: "closed", title: "new" })).toMatchObject({
      number: 3,
      state: "closed",
      title: "new",
    });
    expect(calls[0].body).toEqual({ state: "closed", title: "new" });
    expect(await gh.commentIssue("acme/api", 3, "hello")).toEqual({ url: "u3#c1" });
    expect(calls[1].body).toEqual({ body: "hello" });
  });

  it("deleteIssue reads the node id (read token), then the GraphQL deleteIssue mutation (write token); GraphQL errors become a refusal, a PR is refused", async () => {
    scopes.length = 0;
    const gql: unknown[] = [];
    const { api: gh } = api(({ url, method, body }) => {
      if (url.endsWith("/issues/5")) return { status: 200, body: { number: 5, node_id: "I_kwDO" } };
      if (url.endsWith("/issues/6")) return { status: 200, body: { number: 6, node_id: "I_pr", pull_request: {} } };
      if (url.endsWith("/issues/9")) return { status: 200, body: { number: 9, node_id: "I_forbidden" } };
      if (url.endsWith("/issues/10")) return { status: 200, body: { number: 10, node_id: "I_viewer" } };
      if (method === "POST" && url.endsWith("/graphql")) {
        gql.push(body);
        const id = (body as { variables: { id: string } }).variables.id;
        if (id === "I_forbidden")
          return {
            status: 200,
            body: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] },
          };
        // What an App installation gets: no `type`, this message.
        if (id === "I_viewer")
          return { status: 200, body: { data: null, errors: [{ message: "Viewer not authorized to delete" }] } };
        return { status: 200, body: { data: { deleteIssue: { clientMutationId: null } } } };
      }
      return undefined;
    });
    await gh.deleteIssue("acme/api", 5);
    expect(gql).toEqual([
      { query: expect.stringContaining("deleteIssue(input: { issueId: $id })"), variables: { id: "I_kwDO" } },
    ]);
    expect(scopes).toEqual(["read", "write"]);
    await expect(gh.deleteIssue("acme/api", 6)).rejects.toMatchObject({
      status: 400,
      message: "#6 is a pull request, not an issue",
    });
    await expect(gh.deleteIssue("acme/api", 9)).rejects.toMatchObject({
      status: 403,
      message: "GitHub refused to delete acme/api#9: Resource not accessible by integration",
    });
    await expect(gh.deleteIssue("acme/api", 10)).rejects.toMatchObject({
      status: 403,
      message: "GitHub refused to delete acme/api#10: Viewer not authorized to delete",
    });
  });
});

describe("InMemoryGithubApi", () => {
  const mem = () =>
    new InMemoryGithubApi({
      "acme/api": {
        files: { "README.md": "# api\nresident watchdog", "features/x.md": "spec", "src/a.ts": "code" },
        issues: [
          {
            number: 1,
            title: "bug",
            state: "open",
            url: "https://github.com/acme/api/issues/1",
            labels: ["bug"],
            assignees: [],
            author: "j",
            createdAt: "c",
            updatedAt: "u",
            body: "b",
          },
        ],
      },
    });

  it("reads: files, trees (dirs derived from paths), code search; an unknown repo 404s like GitHub", async () => {
    const gh = mem();
    expect((await gh.readFile("acme/api", "features/x.md")).content).toBe("spec");
    expect(await gh.listTree("acme/api")).toEqual([
      { path: "features", type: "dir" },
      { path: "README.md", type: "file", size: 23 },
      { path: "src", type: "dir" },
    ]);
    expect(await gh.listTree("acme/api", "features")).toEqual([{ path: "features/x.md", type: "file", size: 4 }]);
    expect((await gh.searchCode("watchdog")).map((h) => h.path)).toEqual(["README.md"]);
    await expect(gh.readFile("other/repo", "x")).rejects.toMatchObject({ status: 404 });
    await expect(gh.readFile("acme/api", "features")).rejects.toMatchObject({ status: 400 });
  });

  it("reads a seeded pull request and 404s an unknown number", async () => {
    const pull = {
      number: 7,
      title: "Fix login",
      body: "Keep this context",
      state: "open",
      draft: false,
      url: "https://github.com/acme/api/pull/7",
      author: "ada",
      updatedAt: "2026-09-29T00:00:00Z",
      head: { repo: "acme/api", ref: "fix/login", sha: "a".repeat(40) },
      base: { repo: "acme/api", ref: "main" },
    };
    const gh = new InMemoryGithubApi({ "acme/api": { pulls: [pull] } });
    expect(await gh.getPullRequest("acme/api", 7)).toEqual(pull);
    await expect(gh.getPullRequest("acme/api", 8)).rejects.toMatchObject({ status: 404 });
  });

  it("issues: create numbers sequentially, update patches, comment counts, delete removes and records", async () => {
    const gh = mem();
    const created = await gh.createIssue("acme/api", { title: "foo", body: "bar" });
    expect(created).toMatchObject({
      number: 2,
      title: "foo",
      body: "bar",
      state: "open",
      url: "https://github.com/acme/api/issues/2",
    });
    expect((await gh.updateIssue("acme/api", 2, { state: "closed", labels: ["x"] })).labels).toEqual(["x"]);
    expect((await gh.listIssues("acme/api", { state: "closed" })).map((i) => i.number)).toEqual([2]);
    await gh.commentIssue("acme/api", 1, "hi");
    expect((await gh.getIssue("acme/api", 1)).comments).toHaveLength(1);
    await gh.deleteIssue("acme/api", 1);
    expect(gh.deleted).toEqual(["acme/api#1"]);
    await expect(gh.getIssue("acme/api", 1)).rejects.toMatchObject({ status: 404 });
  });

  it("issues list newest-updated first, like GitHub's sort=updated&direction=desc: a create, an update, or a comment moves an issue to the top", async () => {
    const gh = mem();
    await gh.createIssue("acme/api", { title: "second" });
    await gh.createIssue("acme/api", { title: "third" });
    expect((await gh.listIssues("acme/api")).map((i) => i.title)).toEqual(["third", "second", "bug"]);
    await gh.updateIssue("acme/api", 2, { labels: ["x"] });
    expect((await gh.listIssues("acme/api")).map((i) => i.title)).toEqual(["second", "third", "bug"]);
    await gh.commentIssue("acme/api", 1, "bump");
    expect((await gh.listIssues("acme/api")).map((i) => i.title)).toEqual(["bug", "second", "third"]);
  });
});
// Feature: features/tracing.md item 23 — a span-bound view of the client: each
// request is a `github.rest` child with the route word, never the path.
describe("RestGithubApi.withSpan", () => {
  it("a view's requests are github.rest children of the span with host/route/method/status and no path, query or token; the token resolver receives the span; the unbound client spans nothing; no traceparent leaves for GitHub", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 1_000 }).start("request", { sinks: [log] });
    const call = root.start("tool.github_file");
    const spansSeen: Array<string | undefined> = [];
    const f = fakeFetch((c) =>
      c.url.includes("/contents/")
        ? {
            status: 200,
            body: {
              type: "file",
              encoding: "base64",
              size: 2,
              content: Buffer.from("hi").toString("base64"),
              sha: "s",
              html_url: "u",
            },
          }
        : { status: 200, body: [] },
    );
    const client = new RestGithubApi({
      fetch: f.fetch,
      token: async (scope, span) => {
        spansSeen.push(span?.name);
        return `tok-${scope}`;
      },
    });
    const view = client.withSpan(call);
    await view.readFile("acme/web", "src/secret-path.ts", "main");
    await view.listIssues("acme/web", { limit: 5 });
    const rest = log.ends.filter((e) => e.name === "github.rest");
    expect(rest.map((r) => [r.parentSpanId, r.attrs])).toEqual([
      [call.id, { host: "api.github.com", route: "contents", method: "GET", httpStatus: 200 }],
      [call.id, { host: "api.github.com", route: "issues", method: "GET", httpStatus: 200 }],
    ]);
    expect(JSON.stringify(rest)).not.toMatch(/secret-path|tok-read|acme\/web|ref=/);
    expect(spansSeen).toEqual(["tool.github_file", "tool.github_file"]);
    for (const c of f.calls) expect(new Headers(c.headers as HeadersInit).has("traceparent")).toBe(false);
    // The shared client, unbound: the same calls, no span at all.
    await client.listIssues("acme/web", { limit: 5 });
    expect(log.ends.filter((e) => e.name === "github.rest")).toHaveLength(2);
    expect(spansSeen.at(-1)).toBeUndefined();
  });
});

// Feature: docs/reference/specs/reading-diff.md item 6 — the abridged reading diff's
// input is the COMPLETE unified diff, fetched from GitHub's compare endpoint
// with the read token, never a recorded (and possibly capped) copy.
describe("compareDiff — the unified diff of base...head", () => {
  const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

  it("GETs /repos/<repo>/compare/<base>...<head> with the diff media type on the read token, and returns the text whole", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url, headers }) =>
      url === "https://api.github.com/repos/acme/api/compare/main...e3b0c44298fc1c149afbf4c8996fb92427ae41e4" &&
      headers.accept === "application/vnd.github.diff"
        ? { status: 200, text: DIFF }
        : undefined,
    );
    await expect(gh.compareDiff("acme/api", "main", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4")).resolves.toEqual({
      diff: DIFF,
      complete: true,
    });
    expect(calls).toHaveLength(1);
    expect(scopes).toEqual(["read"]);
  });

  it("a base with a slash is percent-encoded into the path", async () => {
    const { api: gh, calls } = api(() => ({ status: 200, text: DIFF }));
    await gh.compareDiff("acme/api", "release/1.x", "abc");
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/compare/release%2F1.x...abc");
  });

  it("stops reading at the cap and says the diff was cut", async () => {
    const { api: gh } = api(() => ({ status: 200, text: "x".repeat(50) }));
    await expect(gh.compareDiff("acme/api", "main", "abc", 20)).resolves.toEqual({
      diff: "x".repeat(20),
      complete: false,
    });
    await expect(gh.compareDiff("acme/api", "main", "abc", 50)).resolves.toEqual({
      diff: "x".repeat(50),
      complete: true,
    });
  });

  it("GitHub's 404 (unknown ref) and 406 (too large to render as a diff) surface as GithubApiError with the status", async () => {
    const { api: gh } = api(({ url }) =>
      url.includes("gone...")
        ? { status: 404, body: { message: "Not Found" } }
        : { status: 406, body: { message: "Sorry, this diff is taking too long to generate." } },
    );
    await expect(gh.compareDiff("acme/api", "gone", "abc")).rejects.toMatchObject({ status: 404 });
    await expect(gh.compareDiff("acme/api", "main", "huge")).rejects.toMatchObject({
      status: 406,
      message: expect.stringContaining("406"),
    });
  });

  it("InMemoryGithubApi answers a seeded comparison, 404 for an unseeded one, and a seeded status as that error", async () => {
    const gh = new InMemoryGithubApi({
      "acme/api": { compares: { "main...abc": DIFF, "main...huge": { status: 406 } } },
    });
    await expect(gh.compareDiff("acme/api", "main", "abc")).resolves.toEqual({ diff: DIFF, complete: true });
    await expect(gh.compareDiff("acme/api", "main", "abc", 5)).resolves.toEqual({
      diff: DIFF.slice(0, 5),
      complete: false,
    });
    await expect(gh.compareDiff("acme/api", "main", "nope")).rejects.toMatchObject({ status: 404 });
    await expect(gh.compareDiff("acme/api", "main", "huge")).rejects.toMatchObject({ status: 406 });
    await expect(gh.compareDiff("acme/other", "main", "abc")).rejects.toMatchObject({ status: 404 });
  });
});

// docs/reference/specs/github-tools.md item 9: the Actions reads behind the
// triage tools. A run, its jobs with their steps, and one job's log — the log
// endpoint answers a 302 to a signed blob URL, which is followed WITHOUT the
// App credential (the URL is its own credential; the bearer must never reach a
// third host), and the text is read as a tail window so a multi-MB log costs
// the cap's memory and keeps its end, where a failed job's failure is.
describe("RestGithubApi — Actions reads use the read token", () => {
  const runRow = {
    id: 123,
    name: "CI",
    display_title: "fix: the thing",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "failure",
    event: "pull_request",
    head_branch: "fix-x",
    head_sha: "abcdef0123456789abcdef0123456789abcdef01",
    run_number: 77,
    run_attempt: 2,
    html_url: "https://github.com/acme/api/actions/runs/123",
    created_at: "2026-09-17T20:00:00Z",
    run_started_at: "2026-09-17T20:00:05Z",
    updated_at: "2026-09-17T20:04:17Z",
  };
  const jobRow = (id: number, name: string, conclusion: string | null = "failure") => ({
    id,
    run_id: 123,
    name,
    status: "completed",
    conclusion,
    html_url: `https://github.com/acme/api/actions/runs/123/job/${id}`,
    started_at: "2026-09-17T20:00:10Z",
    completed_at: "2026-09-17T20:03:11Z",
    runner_name: "depot-ubuntu-24.04-4",
    steps: [
      {
        number: 1,
        name: "Set up job",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-17T20:00:10Z",
        completed_at: "2026-09-17T20:00:12Z",
      },
      {
        number: 2,
        name: "Run npm test",
        status: "completed",
        conclusion,
        started_at: "2026-09-17T20:00:12Z",
        completed_at: "2026-09-17T20:03:10Z",
      },
    ],
  });

  it("getActionsRun GETs the run and its jobs (100-row pages until short, at most 3) on the read token and maps both", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => jobRow(1000 + i, `shard ${i}`, "success"));
    const { api: a, calls } = api((c) => {
      if (c.url === "https://api.github.com/repos/acme/api/actions/runs/123") return { status: 200, body: runRow };
      if (c.url === "https://api.github.com/repos/acme/api/actions/runs/123/jobs?per_page=100&page=1")
        return { status: 200, body: { total_count: 101, jobs: page1 } };
      if (c.url === "https://api.github.com/repos/acme/api/actions/runs/123/jobs?per_page=100&page=2")
        return { status: 200, body: { total_count: 101, jobs: [jobRow(456, "test 2 of 4")] } };
      return undefined;
    });
    const { run, jobs } = await a.getActionsRun("acme/api", 123);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET"]);
    for (const c of calls) expect(c.headers.authorization).toBe("Bearer tok-read");
    expect(run).toEqual({
      id: 123,
      name: "CI",
      displayTitle: "fix: the thing",
      workflowPath: ".github/workflows/ci.yml",
      status: "completed",
      conclusion: "failure",
      event: "pull_request",
      headBranch: "fix-x",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      runNumber: 77,
      runAttempt: 2,
      url: "https://github.com/acme/api/actions/runs/123",
      createdAt: "2026-09-17T20:00:00Z",
      runStartedAt: "2026-09-17T20:00:05Z",
      updatedAt: "2026-09-17T20:04:17Z",
    });
    expect(jobs).toHaveLength(101);
    expect(jobs[100]).toEqual({
      id: 456,
      runId: 123,
      name: "test 2 of 4",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/acme/api/actions/runs/123/job/456",
      startedAt: "2026-09-17T20:00:10Z",
      completedAt: "2026-09-17T20:03:11Z",
      runnerName: "depot-ubuntu-24.04-4",
      steps: [
        {
          number: 1,
          name: "Set up job",
          status: "completed",
          conclusion: "success",
          startedAt: "2026-09-17T20:00:10Z",
          completedAt: "2026-09-17T20:00:12Z",
        },
        {
          number: 2,
          name: "Run npm test",
          status: "completed",
          conclusion: "failure",
          startedAt: "2026-09-17T20:00:12Z",
          completedAt: "2026-09-17T20:03:10Z",
        },
      ],
    });
  });

  it("getActionsJob GETs one job; a missing run or job is a 404 GithubApiError", async () => {
    const { api: a, calls } = api((c) => {
      if (c.url === "https://api.github.com/repos/acme/api/actions/jobs/456")
        return { status: 200, body: jobRow(456, "test") };
      return undefined;
    });
    const job = await a.getActionsJob("acme/api", 456);
    expect(job.name).toBe("test");
    expect(job.steps).toHaveLength(2);
    expect(calls[0].headers.authorization).toBe("Bearer tok-read");
    await expect(a.getActionsJob("acme/api", 999)).rejects.toMatchObject({ status: 404 });
    await expect(a.getActionsRun("acme/api", 999)).rejects.toMatchObject({ status: 404 });
  });

  it("getActionsJobLog follows the 302 to the signed blob URL without the App credential and returns the text", async () => {
    const { api: a, calls } = api((c) => {
      if (c.url === "https://api.github.com/repos/acme/api/actions/jobs/456/logs")
        return { status: 302, text: "", headers: { location: "https://blob.example/logs/456?sig=abc" } };
      if (c.url === "https://blob.example/logs/456?sig=abc")
        return {
          status: 200,
          text: "2026-09-17T20:00:10.1234567Z ##[group]Run npm test\n2026-09-17T20:03:10.0000000Z ##[error]Process completed with exit code 1.\n",
        };
      return undefined;
    });
    const log = await a.getActionsJobLog("acme/api", 456);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.authorization).toBe("Bearer tok-read");
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(log).toEqual({
      text: "2026-09-17T20:00:10.1234567Z ##[group]Run npm test\n2026-09-17T20:03:10.0000000Z ##[error]Process completed with exit code 1.\n",
      complete: true,
    });
  });

  it("getActionsJobLog keeps the LAST maxChars of a log past the cap and says it is incomplete; a direct 200 body needs no second request", async () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(3, "0")}`).join("\n");
    const { api: a, calls } = api((c) => {
      if (c.url === "https://api.github.com/repos/acme/api/actions/jobs/456/logs") return { status: 200, text: body };
      return undefined;
    });
    const log = await a.getActionsJobLog("acme/api", 456, 40);
    expect(calls).toHaveLength(1);
    expect(log.complete).toBe(false);
    expect(log.text).toBe(body.slice(-40));
    expect(log.text.endsWith("line 049")).toBe(true);
  });

  it("getActionsJobLog on a missing job is a 404 GithubApiError, and a 302 without a location is an error naming the status", async () => {
    const { api: a } = api((c) => {
      if (c.url === "https://api.github.com/repos/acme/api/actions/jobs/1/logs") return { status: 302, text: "" };
      return undefined;
    });
    await expect(a.getActionsJobLog("acme/api", 999)).rejects.toMatchObject({ status: 404 });
    await expect(a.getActionsJobLog("acme/api", 1)).rejects.toMatchObject({ status: 502 });
  });
});

describe("InMemoryGithubApi — Actions", () => {
  const seeded = () =>
    new InMemoryGithubApi({
      "acme/api": {
        actions: [
          {
            id: 123,
            name: "CI",
            displayTitle: "fix: the thing",
            workflowPath: ".github/workflows/ci.yml",
            status: "completed",
            conclusion: "failure",
            event: "push",
            headBranch: "main",
            headSha: "abcdef0123456789abcdef0123456789abcdef01",
            runNumber: 77,
            runAttempt: 1,
            url: "https://github.com/acme/api/actions/runs/123",
            createdAt: "2026-09-17T20:00:00Z",
            runStartedAt: "2026-09-17T20:00:05Z",
            updatedAt: "2026-09-17T20:04:17Z",
            jobs: [
              {
                id: 456,
                runId: 123,
                name: "test",
                status: "completed",
                conclusion: "failure",
                url: "https://github.com/acme/api/actions/runs/123/job/456",
                startedAt: "2026-09-17T20:00:10Z",
                completedAt: "2026-09-17T20:03:11Z",
                runnerName: null,
                steps: [],
                log: "2026-09-17T20:03:10.0000000Z ##[error]boom\n",
              },
            ],
          },
        ],
      },
    });

  it("serves the seeded run, its jobs and a job's log; unknown run/job/repo → 404 like GitHub", async () => {
    const m = seeded();
    const { run, jobs } = await m.getActionsRun("acme/api", 123);
    expect(run.conclusion).toBe("failure");
    expect(jobs.map((j) => j.id)).toEqual([456]);
    expect((await m.getActionsJob("acme/api", 456)).name).toBe("test");
    expect(await m.getActionsJobLog("acme/api", 456)).toEqual({
      text: "2026-09-17T20:03:10.0000000Z ##[error]boom\n",
      complete: true,
    });
    expect(await m.getActionsJobLog("acme/api", 456, 5)).toEqual({ text: "boom\n", complete: false });
    await expect(m.getActionsRun("acme/api", 1)).rejects.toMatchObject({ status: 404 });
    await expect(m.getActionsJob("acme/api", 1)).rejects.toMatchObject({ status: 404 });
    await expect(m.getActionsJobLog("acme/api", 1)).rejects.toMatchObject({ status: 404 });
    await expect(m.getActionsRun("acme/other", 123)).rejects.toMatchObject({ status: 404 });
  });
});

describe("GitHub native read identities", () => {
  const row = {
    id: 101,
    number: 7,
    title: "Fix retries",
    body: "Context",
    state: "closed",
    merged: false,
    draft: false,
    html_url: "https://github.com/acme/api/pull/7",
    user: { login: "author" },
    updated_at: "2026-10-14T00:00:00Z",
    head: { ref: "fix/retry", sha: "a".repeat(40), repo: { id: 22, full_name: "fork/api" } },
    base: { ref: "main", repo: { id: 11, full_name: "acme/api" } },
  };

  it("binds concurrent reads to their own credential and keeps opaque tokens unknown", async () => {
    const source: GithubCredentialSource = { host: "github.com", appId: 1, installationId: 2 };
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const f = fakeFetch(() => ({ status: 200, body: row }));
    let calls = 0;
    const gh = new RestGithubApi({
      fetch: (async (url, init) => {
        if (String(url).endsWith("/7")) await firstPending;
        return f.fetch(url, init);
      }) as typeof fetch,
      token: async () =>
        ++calls === 1
          ? { token: "first", expiresAtMs: null, source }
          : { token: "second", expiresAtMs: null, source: { ...source, installationId: 3 } },
    });
    const first = gh.getPullRequest("acme/api", 7);
    const second = await gh.getPullRequest("acme/api", 8);
    finishFirst();
    expect(await first).toMatchObject({ id: 101, source: { host: "github.com", appId: 1, installationId: 2 } });
    expect(second).toMatchObject({ id: 101, source: { host: "github.com", appId: 1, installationId: 3 } });
    const unknown = await api(() => ({ status: 200, body: row })).api.getPullRequest("acme/api", 7);
    expect(unknown.id).toBe(101);
    expect(Object.hasOwn(unknown, "source")).toBe(false);
  });

  it("does not combine a PR with a branch tip read by another installation", async () => {
    const source: GithubCredentialSource = { host: "github.com", appId: 1, installationId: 2 };
    let rotate = true;
    const f = fakeFetch(({ url }) => ({
      status: 200,
      body: url.includes("/git/ref/")
        ? { object: { type: "commit", sha: "b".repeat(40) } }
        : { ...row, state: "open", head: { ...row.head, repo: { id: 11, full_name: "acme/api" } } },
    }));
    let n = 0;
    const gh = new RestGithubApi({
      fetch: f.fetch,
      token: async () => ({
        token: "read",
        expiresAtMs: null,
        source: { ...source, installationId: rotate && ++n % 2 === 0 ? 3 : 2 },
      }),
    });
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({ head: { sha: "a".repeat(40) }, source });
    rotate = false;
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({ head: { sha: "b".repeat(40) }, source });
  });

  it("refuses malformed supplied credential identity before reading source data", async () => {
    const source: GithubCredentialSource = { host: "github.com", appId: 1, installationId: 2 };
    const f = fakeFetch(() => ({ status: 200, body: row }));
    let installationId = 0;
    const gh = new RestGithubApi({
      fetch: f.fetch,
      token: async () => ({ token: "read", expiresAtMs: null, source: { ...source, installationId } }),
    });
    await expect(gh.getPullRequest("acme/api", 7)).rejects.toMatchObject({ status: 502 });
    expect(f.calls).toEqual([]);
    installationId = 2;
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({ id: 101, source });
    const memory = new InMemoryGithubApi({ "acme/api": { source: { ...source, installationId: 0 } } });
    await expect(memory.listRepos()).rejects.toMatchObject({ status: 502 });
  });

  it("retains the credential source of each repository page and the in-memory metadata", async () => {
    const source: GithubCredentialSource = { host: "github.com", appId: 1, installationId: 2 };
    let page = 0;
    const f = fakeFetch(({ url }) => ({
      status: 200,
      body: {
        repositories: url.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `acme/r${i}` }))
          : [{ id: 101, full_name: "acme/last" }],
      },
    }));
    const gh = new RestGithubApi({
      fetch: f.fetch,
      token: async () => ({
        token: "read",
        expiresAtMs: null,
        source: { ...source, installationId: ++page === 1 ? 2 : 3 },
      }),
    });
    const repos = await gh.listRepos();
    expect([repos[0], repos[100]]).toMatchObject([
      { id: 1, source: { host: "github.com", appId: 1, installationId: 2 } },
      { id: 101, source: { host: "github.com", appId: 1, installationId: 3 } },
    ]);
    const pull = { ...(await api(() => ({ status: 200, body: row })).api.getPullRequest("acme/api", 7)), source };
    const memory = new InMemoryGithubApi({ "acme/api": { id: 11, source, pulls: [pull] } });
    expect(await memory.getPullRequest("acme/api", 7)).toEqual(pull);
    expect(await memory.listRepos()).toMatchObject([{ id: 11, source }]);
  });

  it("retains distinct PR and fork/base repository IDs through the existing read route", async () => {
    const { api: gh, calls } = api(() => ({ status: 200, body: row }));
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({
      id: 101,
      number: 7,
      head: { repositoryId: 22, repo: "fork/api", sha: "a".repeat(40) },
      base: { repositoryId: 11, repo: "acme/api" },
    });
    expect(
      calls.map((call) => ({ url: call.url, method: call.method, authorization: call.headers.authorization })),
    ).toEqual([
      { url: "https://api.github.com/repos/acme/api/pulls/7", method: "GET", authorization: "Bearer tok-read" },
    ]);
  });

  it("keeps native IDs when the existing branch-tip policy selects a newer same-repository commit", async () => {
    const payload = { ...row, state: "open", head: { ...row.head, repo: { id: 11, full_name: "acme/api" } } };
    const { api: gh, calls } = api(({ url }) => ({
      status: 200,
      body: url.includes("/git/ref/heads/") ? { object: { type: "commit", sha: "b".repeat(40) } } : payload,
    }));
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({
      id: 101,
      number: 7,
      head: { repositoryId: 11, ref: "fix/retry", sha: "b".repeat(40) },
      base: { repositoryId: 11, ref: "main" },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/api/pulls/7",
      "https://api.github.com/repos/acme/api/git/ref/heads/fix/retry",
    ]);
  });

  it("keeps repository identity when its name changes", async () => {
    let name = "acme/api";
    const { api: gh } = api(() => ({
      status: 200,
      body: { repositories: [{ id: 11, full_name: name, private: true, default_branch: "main" }] },
    }));
    expect(await gh.listRepos()).toEqual([
      { id: 11, fullName: "acme/api", private: true, defaultBranch: "main", description: null },
    ]);
    name = "new-owner/new-api";
    expect(await gh.listRepos()).toEqual([
      { id: 11, fullName: "new-owner/new-api", private: true, defaultBranch: "main", description: null },
    ]);
  });

  it("preserves a deleted fork as null and does not guess its repository from the base", async () => {
    const { api: gh } = api(() => ({ status: 200, body: { ...row, head: { ...row.head, repo: null } } }));
    expect(await gh.getPullRequest("acme/api", 7)).toMatchObject({
      id: 101,
      number: 7,
      head: { repositoryId: null, repo: "", sha: "a".repeat(40) },
      base: { repositoryId: 11 },
    });
  });

  it("keeps old metadata readable without inventing missing IDs", async () => {
    const legacy = {
      number: 7,
      title: "Old metadata",
      state: "closed",
      head: { ref: "fix/retry", sha: "a".repeat(40), repo: { full_name: "fork/api" } },
      base: { ref: "main", repo: { full_name: "acme/api" } },
    };
    const { api: gh } = api(() => ({ status: 200, body: legacy }));
    const result = await gh.getPullRequest("acme/api", 7);
    expect(result).toMatchObject({
      number: 7,
      title: "Old metadata",
      head: { repo: "fork/api" },
      base: { repo: "acme/api" },
    });
    expect(Object.hasOwn(result, "id")).toBe(false);
    expect(Object.hasOwn(result.head, "repositoryId")).toBe(false);
    expect(Object.hasOwn(result.base, "repositoryId")).toBe(false);
  });

  it.each([0, -1, "101", null, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses a supplied malformed native PR ID (%s)",
    async (id) => {
      const { api: gh } = api(() => ({ status: 200, body: { ...row, id } }));
      await expect(gh.getPullRequest("acme/api", 7)).rejects.toMatchObject({
        status: 502,
        message: "Invalid GitHub native identity",
      });
    },
  );

  it("refuses malformed repository IDs in each read position", async () => {
    for (const bad of [
      { ...row, head: { ...row.head, repo: { ...row.head.repo, id: "22" } } },
      { ...row, base: { ...row.base, repo: { ...row.base.repo, id: 0 } } },
    ]) {
      const { api: gh } = api(() => ({ status: 200, body: bad }));
      await expect(gh.getPullRequest("acme/api", 7)).rejects.toMatchObject({ status: 502 });
    }
    const { api: gh } = api(() => ({ status: 200, body: { repositories: [{ id: null, full_name: "acme/api" }] } }));
    await expect(gh.listRepos()).rejects.toMatchObject({ status: 502 });
    const good = api(() => ({ status: 200, body: { repositories: [{ id: 11, full_name: "acme/api" }] } })).api;
    expect(await good.listRepos()).toMatchObject([{ id: 11, fullName: "acme/api" }]);
  });

  it("retains native IDs in the in-memory implementation and keeps legacy IDs absent", async () => {
    const pull = {
      id: 101,
      number: 7,
      title: "Fix retries",
      body: "Context",
      state: "closed",
      draft: false,
      url: row.html_url,
      author: "author",
      updatedAt: row.updated_at,
      head: { repositoryId: 22, repo: "fork/api", ref: "fix/retry", sha: "a".repeat(40) },
      base: { repositoryId: 11, repo: "acme/api", ref: "main" },
    };
    const gh = new InMemoryGithubApi({ "acme/api": { id: 11, pulls: [pull] }, "acme/legacy": {} });
    expect(await gh.listRepos()).toEqual([
      { id: 11, fullName: "acme/api", private: true, defaultBranch: "main", description: null },
      { fullName: "acme/legacy", private: true, defaultBranch: "main", description: null },
    ]);
    expect(await gh.getPullRequest("acme/api", 7)).toEqual(pull);
    const malformed = new InMemoryGithubApi({ "acme/api": { id: 0 } });
    await expect(malformed.listRepos()).rejects.toMatchObject({ status: 502 });
  });
});
