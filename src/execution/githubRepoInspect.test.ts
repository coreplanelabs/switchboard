import { describe, expect, it } from "vitest";
import { githubRepoInspector } from "./githubRepoInspect.js";

// Feature: features/resident-repos.md item 52 — the root inspection behind
// `repo onboard`'s command detection: two REST reads with the read-scoped App
// token; every failure is a named reason, never a guess.

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(routes: (url: string) => { status: number; body?: unknown; text?: string } | undefined) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes(url) ?? { status: 404, body: { message: "Not Found" } };
    return new Response(r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body)), { status: r.status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const token = async () => "tok-read";
const TREE = { tree: [{ path: "package.json", type: "blob" }, { path: "pnpm-lock.yaml", type: "blob" }, { path: "apps", type: "tree" }] };

describe("githubRepoInspector", () => {
  it("reads the tree and package.json with the bearer, returning entries + the deciding fields only", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/git/trees/main")) return { status: 200, body: TREE };
      if (url.endsWith("/contents/package.json?ref=main")) return { status: 200, text: JSON.stringify({ name: "x", packageManager: "pnpm@10.10.0", scripts: { test: "turbo test" }, dependencies: { a: "1" } }) };
      return undefined;
    });
    const r = await githubRepoInspector({ fetch, token })("coreplanelabs/nominal", "main");
    expect(r).toEqual({ ok: true, facts: { entries: ["package.json", "pnpm-lock.yaml", "apps"], packageJson: { scripts: { test: "turbo test" }, packageManager: "pnpm@10.10.0" } } });
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/coreplanelabs/nominal/git/trees/main", "https://api.github.com/repos/coreplanelabs/nominal/contents/package.json?ref=main"]);
    for (const c of calls) expect(c.headers.authorization).toBe("Bearer tok-read");
    expect(calls[1].headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("no package.json at the root → one call, entries only", async () => {
    const { fetch, calls } = fakeFetch((url) => (url.includes("/git/trees/") ? { status: 200, body: { tree: [{ path: "Taskfile.yaml" }, { path: "terrateam" }] } } : undefined));
    expect(await githubRepoInspector({ fetch, token })("coreplanelabs/infrastructure", "main")).toEqual({ ok: true, facts: { entries: ["Taskfile.yaml", "terrateam"] } });
    expect(calls).toHaveLength(1);
  });

  it("a 404 names the two causes (outside the installation / no such ref); other statuses carry the code", async () => {
    const r404 = await githubRepoInspector({ fetch: fakeFetch(() => ({ status: 404 })).fetch, token })("acme/api", "develop");
    expect(r404).toEqual({ ok: false, reason: "GitHub answered 404 for acme/api@develop — the repo is outside the App installation, or the ref does not exist" });
    expect(await githubRepoInspector({ fetch: fakeFetch(() => ({ status: 502 })).fetch, token })("acme/api", "main")).toEqual({ ok: false, reason: "GitHub tree lookup failed: HTTP 502" });
  });

  it("no credential → a named reason, no request; a throwing fetch → named too", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: TREE }));
    expect(await githubRepoInspector({ fetch, token: async () => null })("acme/api", "main")).toEqual({ ok: false, reason: "no GitHub credential configured (GitHub App or GH_TOKEN)" });
    expect(calls).toHaveLength(0);
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await githubRepoInspector({ fetch: boom, token })("acme/api", "main")).toEqual({ ok: false, reason: "GitHub request failed (ECONNRESET)" });
  });

  it("an unparseable package.json is reported as null, not a failure", async () => {
    const { fetch } = fakeFetch((url) => (url.includes("/git/trees/") ? { status: 200, body: TREE } : { status: 200, text: "{ not json" }));
    expect(await githubRepoInspector({ fetch, token })("acme/api", "main")).toEqual({ ok: true, facts: { entries: ["package.json", "pnpm-lock.yaml", "apps"], packageJson: null } });
  });

  it("the ref is URL-encoded", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { tree: [] } }));
    await githubRepoInspector({ fetch, token })("acme/api", "feature/x");
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/api/git/trees/feature%2Fx");
  });
});
