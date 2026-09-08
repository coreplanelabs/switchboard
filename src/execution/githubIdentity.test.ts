import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature: features/agent-ship.md item 10 — the identity ship's own PRs are
// authored by is RESOLVED from GitHub, never named in the code: the App's bot
// user (`GET /app` → `<slug>[bot]` → its immutable id) when an App is
// configured, the static token's user otherwise, undefined with neither. The
// module caches the answer in module state, so each test imports a fresh copy.

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID", "GH_TOKEN"];
const saved: Record<string, string | undefined> = {};

function configureApp() {
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_APP_INSTALLATION_ID = "67890";
}

async function freshModule() {
  vi.resetModules();
  return import("./githubApp.js");
}

type Route = (init?: RequestInit) => Response;

/** A fetch answering by URL; every call is recorded (URL + Authorization header). */
function routes(table: Record<string, Route>) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") ?? undefined });
    const route = table[url];
    if (!route) return new Response("not found", { status: 404 });
    return route(init);
  });
  return { fetchMock, calls };
}

const json =
  (body: unknown, status = 200): Route =>
  () =>
    new Response(JSON.stringify(body), { status });

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveGithubIdentity", () => {
  it("with a GitHub App: GET /app with the App JWT for the slug, then the `<slug>[bot]` user with a read token — cached for the process", async () => {
    configureApp();
    const { fetchMock, calls } = routes({
      "https://api.github.com/app": json({ id: 12345, slug: "acme-switchboard" }),
      "https://api.github.com/app/installations/67890/access_tokens": json(
        { token: "ghs_read", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        201,
      ),
      "https://api.github.com/users/acme-switchboard%5Bbot%5D": json({ login: "acme-switchboard[bot]", id: 4242 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    expect(await mod.resolveGithubIdentity()).toEqual({ login: "acme-switchboard[bot]", id: 4242 });
    // /app is proven with the App JWT (three dot-separated segments), the user
    // lookup with the minted installation token.
    expect(calls[0].url).toBe("https://api.github.com/app");
    expect(calls[0].auth?.replace(/^Bearer /, "").split(".")).toHaveLength(3);
    expect(calls.at(-1)).toEqual({
      url: "https://api.github.com/users/acme-switchboard%5Bbot%5D",
      auth: "Bearer ghs_read",
    });
    const before = fetchMock.mock.calls.length;
    expect(await mod.resolveGithubIdentity()).toEqual({ login: "acme-switchboard[bot]", id: 4242 });
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("with only a static GH_TOKEN: that token's user", async () => {
    process.env.GH_TOKEN = "ghp_static";
    const { fetchMock, calls } = routes({
      "https://api.github.com/user": json({ login: "release-bot", id: 77 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    expect(await mod.resolveGithubIdentity()).toEqual({ login: "release-bot", id: 77 });
    expect(calls).toEqual([{ url: "https://api.github.com/user", auth: "Bearer ghp_static" }]);
  });

  it("with neither: undefined, and no network call", async () => {
    const { fetchMock } = routes({});
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    expect(await mod.resolveGithubIdentity()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed lookup answers undefined (named in a warning) and is retried on the next call, never cached", async () => {
    process.env.GH_TOKEN = "ghp_static";
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      return attempts === 1
        ? new Response("bad credentials", { status: 401 })
        : new Response(JSON.stringify({ login: "release-bot", id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    expect(await mod.resolveGithubIdentity()).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain("/user: HTTP 401");
    expect(await mod.resolveGithubIdentity()).toEqual({ login: "release-bot", id: 77 });
    expect(attempts).toBe(2);
  });

  it("an App answer without a slug, or a user without an id, is a failure — never a half identity", async () => {
    configureApp();
    const { fetchMock } = routes({
      "https://api.github.com/app": json({ id: 12345 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    expect(await mod.resolveGithubIdentity()).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain("without a slug");
  });
});
