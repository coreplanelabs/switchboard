import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature: features/execution.md — GitHub App identity: 1-hour installation
// tokens minted on demand, cached until 5 minutes before expiry, falling back
// to a static GH_TOKEN (or nothing) when the App isn't configured.
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
    return new Response(
      JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
      { status: 201 },
    );
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

  it("re-mints when the cached token is within 5 minutes of expiry", async () => {
    configureApp();
    const fetchMock = mockMint("ghs_shortlived", 4 * 60_000); // < 5-min buffer
    vi.stubGlobal("fetch", fetchMock);
    const mod = await freshModule();

    await mod.resolveGithubToken();
    await mod.resolveGithubToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
