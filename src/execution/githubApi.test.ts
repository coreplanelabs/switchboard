import { describe, expect, it } from "vitest";
import { GithubApiError, InMemoryGithubApi, MAX_FILE_CHARS, RestGithubApi, readTextCapped } from "./githubApi.js";

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

function fakeFetch(routes: (call: Call) => { status: number; body?: unknown; text?: string; stream?: ReadableStream<Uint8Array> } | undefined) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { url, method, headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    const r = routes(call) ?? { status: 404, body: { message: "Not Found" } };
    return new Response(r.stream ?? r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body)), { status: r.status, headers: { "content-type": "application/json" } });
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

describe("RestGithubApi — reads use the read token", () => {
  it("readFile decodes base64 content and returns size/sha/url; the ref is passed", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url }) =>
      url.endsWith("/repos/acme/api/contents/features/x.md?ref=main") ? { status: 200, body: { type: "file", encoding: "base64", size: 5, sha: "abc", html_url: "https://github.com/acme/api/blob/main/features/x.md", content: Buffer.from("hello").toString("base64") } } : undefined,
    );
    const f = await gh.readFile("acme/api", "features/x.md", "main");
    expect(f).toEqual({ path: "features/x.md", content: "hello", size: 5, truncated: false, sha: "abc", url: "https://github.com/acme/api/blob/main/features/x.md" });
    expect(calls[0].headers.authorization).toBe("Bearer tok-read");
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
    expect(scopes).toEqual(["read"]);
  });

  it("readFile: a directory answer and a non-file type are 400s that name the other tool; >1 MB (encoding none) re-reads raw; binary is a note; long text is clipped", async () => {
    const big = "x".repeat(MAX_FILE_CHARS + 10);
    const { api: gh } = api(({ url, headers }) => {
      if (url.includes("/contents/dir")) return { status: 200, body: [{ path: "dir/a" }] };
      if (url.includes("/contents/link")) return { status: 200, body: { type: "symlink" } };
      if (url.includes("/contents/huge") && headers.accept === "application/vnd.github.raw+json") return { status: 200, text: big };
      if (url.includes("/contents/huge")) return { status: 200, body: { type: "file", encoding: "none", size: big.length, content: "" } };
      if (url.includes("/contents/bin")) return { status: 200, body: { type: "file", encoding: "base64", size: 3, content: Buffer.from([0, 1, 2]).toString("base64") } };
      return undefined;
    });
    await expect(gh.readFile("acme/api", "dir")).rejects.toMatchObject({ status: 400, message: "dir is a directory — list it with github_tree" });
    await expect(gh.readFile("acme/api", "link")).rejects.toMatchObject({ status: 400, message: "link is a symlink, not a file" });
    const huge = await gh.readFile("acme/api", "huge");
    expect(huge.truncated).toBe(true);
    expect(huge.content).toHaveLength(MAX_FILE_CHARS);
    expect((await gh.readFile("acme/api", "bin")).content).toBe("(binary file, 3 bytes — not shown)");
  });

  it("listTree maps entries (dirs, files with sizes) and refuses a file path; path segments are URL-encoded", async () => {
    const { api: gh, calls } = api(({ url }) => {
      if (url.endsWith("/contents/src%20x/a%20b")) return { status: 200, body: [{ path: "src x/a b/one.ts", type: "file", size: 12 }, { path: "src x/a b/sub", type: "dir" }] };
      if (url.endsWith("/contents/README.md")) return { status: 200, body: { type: "file" } };
      return undefined;
    });
    expect(await gh.listTree("acme/api", "src x/a b")).toEqual([{ path: "src x/a b/one.ts", type: "file", size: 12 }, { path: "src x/a b/sub", type: "dir" }]);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/contents/src%20x/a%20b");
    await expect(gh.listTree("acme/api", "README.md")).rejects.toMatchObject({ status: 400, message: "README.md is a file — read it with github_file" });
  });

  it("searchCode scopes to a repo, asks for text matches, clamps the limit, and maps fragments", async () => {
    const { api: gh, calls } = api(() => ({ status: 200, body: { items: [{ path: "a.ts", html_url: "u", repository: { full_name: "acme/api" }, text_matches: [{ fragment: "resident watchdog" }] }] } }));
    const hits = await gh.searchCode("watchdog", "acme/api", 99);
    expect(hits).toEqual([{ repo: "acme/api", path: "a.ts", url: "u", fragments: ["resident watchdog"] }]);
    expect(calls[0].url).toBe(`https://api.github.com/search/code?q=${encodeURIComponent("watchdog repo:acme/api")}&per_page=30`);
    expect(calls[0].headers.accept).toBe("application/vnd.github.text-match+json");
  });

  it("listRepos pages the installation's repositories", async () => {
    const { api: gh } = api(({ url }) => (url.includes("page=1") ? { status: 200, body: { repositories: [{ full_name: "acme/api", private: true, default_branch: "main", description: "d" }] } } : { status: 200, body: { repositories: [] } }));
    expect(await gh.listRepos()).toEqual([{ fullName: "acme/api", private: true, defaultBranch: "main", description: "d" }]);
  });

  it("listIssues drops pull requests, passes state/labels/limit, and maps rows; getIssue fetches comments only when there are any and refuses a PR", async () => {
    const row = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `t${n}`, state: "open", html_url: `u${n}`, labels: [{ name: "bug" }], assignees: [{ login: "j" }], user: { login: "matanya" }, created_at: "c", updated_at: "u", body: "b", comments: 0, ...extra });
    const { api: gh, calls } = api(({ url }) => {
      if (url.includes("/issues?")) return { status: 200, body: [row(1), row(2, { pull_request: {} })] };
      if (url.endsWith("/issues/7/comments?per_page=30")) return { status: 200, body: [{ user: { login: "x" }, created_at: "c1", body: "hi" }] };
      if (url.endsWith("/issues/7")) return { status: 200, body: row(7, { comments: 1 }) };
      if (url.endsWith("/issues/8")) return { status: 200, body: row(8, { pull_request: {} }) };
      return undefined;
    });
    const list = await gh.listIssues("acme/api", { state: "all", labels: ["bug", "p1"], limit: 5 });
    expect(list.map((i) => i.number)).toEqual([1]);
    expect(list[0]).toMatchObject({ title: "t1", state: "open", labels: ["bug"], assignees: ["j"], author: "matanya", body: "b" });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/issues?state=all&per_page=100&page=1&sort=updated&direction=desc&labels=bug%2Cp1");
    const got = await gh.getIssue("acme/api", 7);
    expect(got.comments).toEqual([{ author: "x", createdAt: "c1", body: "hi" }]);
    await expect(gh.getIssue("acme/api", 8)).rejects.toMatchObject({ status: 400, message: "#8 is a pull request, not an issue" });
  });

  it("listIssues keeps paging while pull requests crowd out issues, and stops at `limit` issues or the end of the list", async () => {
    const row = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `t${n}`, state: "open", html_url: `u${n}`, labels: [], assignees: [], user: { login: "j" }, created_at: "c", updated_at: "u", ...extra });
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
    const prOnly = api(() => ({ status: 200, body: Array.from({ length: 100 }, (_, i) => row(i, { pull_request: {} })) }));
    expect(await prOnly.api.listIssues("acme/api")).toEqual([]);
    expect(prOnly.calls).toHaveLength(3);
  });

  it("readFile's raw re-read streams only up to the clip: a multi-MB blob is cancelled once MAX_FILE_CHARS are in hand", async () => {
    const CHUNK = 50_000;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 200) controller.close(); // 10 MB if read to the end
        else controller.enqueue(new TextEncoder().encode("y".repeat(CHUNK)));
      },
    });
    const { api: gh } = api(({ url, headers }) => {
      if (url.includes("/contents/huge") && headers.accept === "application/vnd.github.raw+json") return { status: 200, stream };
      if (url.includes("/contents/huge")) return { status: 200, body: { type: "file", encoding: "none", size: 200 * CHUNK, content: "" } };
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

  it("a non-2xx is a GithubApiError with the status and GitHub's message; no credential is a 401 before any request", async () => {
    const { api: gh, calls } = api(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    await expect(gh.listIssues("acme/api")).rejects.toMatchObject({ status: 403, message: "GitHub GET /repos/acme/api/issues?state=open&per_page=100&page=1&sort=updated&direction=desc failed: HTTP 403 Resource not accessible by integration" });
    expect(calls).toHaveLength(1);
    const none = new RestGithubApi({ fetch: fakeFetch(() => ({ status: 200 })).fetch, token: async () => null });
    await expect(none.listRepos()).rejects.toMatchObject({ status: 401 });
    expect(await none.listRepos().catch((e: GithubApiError) => e.message)).toBe("no GitHub credential available (configure the GitHub App or GH_TOKEN)");
  });
});

describe("RestGithubApi — writes use the write token", () => {
  it("createIssue posts title/body/labels/assignees (omitting empties), clips a huge body, and maps the row", async () => {
    scopes.length = 0;
    const { api: gh, calls } = api(({ url, method }) => (method === "POST" && url.endsWith("/repos/acme/api/issues") ? { status: 201, body: { number: 12, title: "foo", state: "open", html_url: "https://github.com/acme/api/issues/12", labels: [], assignees: [], user: { login: "switchboard[bot]" }, created_at: "c", updated_at: "u" } } : undefined));
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
      if (method === "PATCH" && url.endsWith("/issues/3")) return { status: 200, body: { number: 3, title: "new", state: "closed", html_url: "u3" } };
      if (method === "POST" && url.endsWith("/issues/3/comments")) return { status: 201, body: { html_url: "u3#c1" } };
      return undefined;
    });
    expect(await gh.updateIssue("acme/api", 3, { state: "closed", title: "new" })).toMatchObject({ number: 3, state: "closed", title: "new" });
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
        if (id === "I_forbidden") return { status: 200, body: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] } };
        // The live answer for an App installation (2026-09-03): no `type`, this message.
        if (id === "I_viewer") return { status: 200, body: { data: null, errors: [{ message: "Viewer not authorized to delete" }] } };
        return { status: 200, body: { data: { deleteIssue: { clientMutationId: null } } } };
      }
      return undefined;
    });
    await gh.deleteIssue("acme/api", 5);
    expect(gql).toEqual([{ query: expect.stringContaining("deleteIssue(input: { issueId: $id })"), variables: { id: "I_kwDO" } }]);
    expect(scopes).toEqual(["read", "write"]);
    await expect(gh.deleteIssue("acme/api", 6)).rejects.toMatchObject({ status: 400, message: "#6 is a pull request, not an issue" });
    await expect(gh.deleteIssue("acme/api", 9)).rejects.toMatchObject({ status: 403, message: "GitHub refused to delete acme/api#9: Resource not accessible by integration" });
    await expect(gh.deleteIssue("acme/api", 10)).rejects.toMatchObject({ status: 403, message: "GitHub refused to delete acme/api#10: Viewer not authorized to delete" });
  });
});

describe("InMemoryGithubApi", () => {
  const mem = () =>
    new InMemoryGithubApi({
      "acme/api": {
        files: { "README.md": "# api\nresident watchdog", "features/x.md": "spec", "src/a.ts": "code" },
        issues: [{ number: 1, title: "bug", state: "open", url: "https://github.com/acme/api/issues/1", labels: ["bug"], assignees: [], author: "j", createdAt: "c", updatedAt: "u", body: "b" }],
      },
    });

  it("reads: files, trees (dirs derived from paths), code search; an unknown repo 404s like GitHub", async () => {
    const gh = mem();
    expect((await gh.readFile("acme/api", "features/x.md")).content).toBe("spec");
    expect(await gh.listTree("acme/api")).toEqual([{ path: "features", type: "dir" }, { path: "README.md", type: "file", size: 23 }, { path: "src", type: "dir" }]);
    expect(await gh.listTree("acme/api", "features")).toEqual([{ path: "features/x.md", type: "file", size: 4 }]);
    expect((await gh.searchCode("watchdog")).map((h) => h.path)).toEqual(["README.md"]);
    await expect(gh.readFile("other/repo", "x")).rejects.toMatchObject({ status: 404 });
    await expect(gh.readFile("acme/api", "features")).rejects.toMatchObject({ status: 400 });
  });

  it("issues: create numbers sequentially, update patches, comment counts, delete removes and records", async () => {
    const gh = mem();
    const created = await gh.createIssue("acme/api", { title: "foo", body: "bar" });
    expect(created).toMatchObject({ number: 2, title: "foo", body: "bar", state: "open", url: "https://github.com/acme/api/issues/2" });
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
