import { describe, expect, it } from "vitest";
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

  it("listRepos pages the installation's repositories", async () => {
    const { api: gh } = api(({ url }) =>
      url.includes("page=1")
        ? {
            status: 200,
            body: {
              repositories: [{ full_name: "acme/api", private: true, default_branch: "main", description: "d" }],
            },
          }
        : { status: 200, body: { repositories: [] } },
    );
    expect(await gh.listRepos()).toEqual([
      { fullName: "acme/api", private: true, defaultBranch: "main", description: "d" },
    ]);
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
