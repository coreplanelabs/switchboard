import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

// Feature: features/execution.md item 5 — GitHub App identity: 1-hour
// installation tokens minted on demand, reused only while they have at least
// TOKEN_REUSE_MARGIN_MS of life left (the longest single command plus slack),
// falling back to a static GH_TOKEN (or nothing) when the App isn't configured.
//
// The module keeps its token cache in module state, so each test imports a
// fresh copy via vi.resetModules() + dynamic import.

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

function mockMint(token: string, expiresInMs: number) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    void url;
    void init;
    return new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }), {
      status: 201,
    });
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("resolveGithubToken", () => {
  it("falls back to static GH_TOKEN when the App is not configured", async () => {
    process.env.GH_TOKEN = "ghp_static";
    const mod = await freshModule();
    expect(await mod.resolveGithubToken()).toBe("ghp_static");
  });

  it("returns null with neither App nor GH_TOKEN", async () => {
    const mod = await freshModule();
    expect(await mod.resolveGithubToken()).toBeNull();
  });

  it("mints an installation token with an App JWT and caches it", async () => {
    configureApp();
    const fetchMock = mockMint("ghs_minted", 60 * 60_000);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();

    expect(await mod.resolveGithubToken()).toBe("ghs_minted");
    expect(await mod.resolveGithubToken()).toBe("ghs_minted");
    // Cache hit: one mint for two resolutions.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth).toMatch(/^Bearer /);
    // RS256 JWT: three dot-separated base64url segments, iss = app id.
    const [header, payload] = auth.slice("Bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "RS256" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: "12345" });
  });

  // Feature: features/tracing.md item 23 — the mint under the caller's span.
  it("under a span the mint is a github.token_mint child carrying scope, cached and expiresInMs, with the access_tokens request as its github.rest child; a cache hit is a mint span with cached: true and no request", async () => {
    configureApp();
    const fetchMock = mockMint("ghs_traced", 60 * 60_000);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();
    const { createTracer } = await import("../core/trace/tracer.js");
    const { recordingSink } = await import("../core/testing/recordingSink.js");
    const log = recordingSink();
    const root = createTracer({ clock: () => Date.now() }).start("request", { sinks: [log] });
    const call = root.start("tool.github_file");
    expect(await mod.resolveGithubToken("read", call)).toBe("ghs_traced");
    expect(await mod.resolveGithubToken("read", call)).toBe("ghs_traced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mints = log.ends.filter((e) => e.name === "github.token_mint");
    expect(mints).toHaveLength(2);
    expect(mints[0]!.parentSpanId).toBe(call.id);
    expect(mints[0]!.attrs).toMatchObject({ scope: "read", cached: false });
    expect(mints[0]!.attrs.expiresInMs).toBeGreaterThan(0);
    expect(mints[1]!.attrs).toMatchObject({ scope: "read", cached: true });
    const rest = log.ends.filter((e) => e.name === "github.rest");
    expect(rest.map((r) => [r.parentSpanId, r.attrs.route, r.attrs.method, r.attrs.httpStatus])).toEqual([
      [mints[0]!.spanId, "app_installation_token", "POST", 201],
    ]);
    expect(JSON.stringify(log.ends)).not.toContain("ghs_traced");
  });

  it("mints a READ-scoped token with a least-privilege permissions subset", async () => {
    configureApp();
    const fetchMock = mockMint("ghs_read", 60 * 60_000);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();

    expect(await mod.resolveGithubToken("read")).toBe("ghs_read");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The read token requests read-only permissions — it physically cannot
    // write (no comment/review/push) even though the sandbox has `gh`.
    expect(JSON.parse(String(init.body))).toEqual({
      permissions: { contents: "read", pull_requests: "read", issues: "read", metadata: "read" },
    });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("the default (write) scope requests NO permissions restriction — the full grant", async () => {
    configureApp();
    const fetchMock = mockMint("ghs_write", 60 * 60_000);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();

    expect(await mod.resolveGithubToken("write")).toBe("ghs_write");
    expect(await mod.resolveGithubToken()).toBe("ghs_write"); // default === "write"
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // default shares the write cache slot
  });

  it("read and write tokens cache in separate slots (one mint per scope)", async () => {
    configureApp();
    const fetchMock = mockMint("ghs_scoped", 60 * 60_000);
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();

    await mod.resolveGithubToken("read");
    await mod.resolveGithubToken("write");
    await mod.resolveGithubToken("read");
    await mod.resolveGithubToken("write");
    expect(fetchMock).toHaveBeenCalledTimes(2); // one mint each, then cache hits
  });

  // 2026-09-07 (review of #521): a token minted 51 minutes earlier was handed
  // to a run whose first command then took the full 20-minute ceiling — the
  // token expired under it and every later command got 401 Bad credentials.
  // The reuse margin must cover the longest single command plus slack, so a
  // command that STARTS on a token always FINISHES on it.
  it("the reuse margin covers the longest single command (BASH_TIMEOUT_MAX_MS) plus slack", async () => {
    const mod = await freshModule();
    expect(mod.TOKEN_REUSE_MARGIN_MS).toBeGreaterThanOrEqual(BASH_TIMEOUT_MAX_MS + 5 * 60_000);
  });

  it("re-mints when the cached token has less than the reuse margin left", async () => {
    configureApp();
    const mod = await freshModule();
    const fetchMock = mockMint("ghs_shortlived", mod.TOKEN_REUSE_MARGIN_MS - 60_000);
    vi.stubGlobal("fetch", fetchMock);

    await mod.resolveGithubToken();
    await mod.resolveGithubToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached token while it still has at least the reuse margin left", async () => {
    configureApp();
    const mod = await freshModule();
    const fetchMock = mockMint("ghs_fresh", mod.TOKEN_REUSE_MARGIN_MS + 60_000);
    vi.stubGlobal("fetch", fetchMock);

    await mod.resolveGithubToken();
    await mod.resolveGithubToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts a credential in the mint failure body before slicing it into the error (item 62)", async () => {
    configureApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bad credentials GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", { status: 401 }),
      ),
    );
    const mod = await freshModule();
    const err = await mod.resolveGithubToken().catch((e: unknown) => e);
    expect((err as Error).message).toContain("HTTP 401");
    expect((err as Error).message).not.toContain("ghp_");
  });

  it("surfaces mint failures with the HTTP status", async () => {
    configureApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad credentials", { status: 401 })),
    );
    const mod = await freshModule();
    await expect(mod.resolveGithubToken()).rejects.toThrow(/HTTP 401/);
  });

  it("githubAppConfigured requires all three env vars", async () => {
    const mod = await freshModule();
    expect(mod.githubAppConfigured()).toBe(false);
    configureApp();
    expect(mod.githubAppConfigured()).toBe(true);
  });
});
