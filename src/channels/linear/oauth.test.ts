import { describe, expect, it, vi } from "vitest";
import { LinearOAuth, LinearTokenProvider } from "./oauth.js";
import { InMemoryLinearStore, type LinearInstallation } from "./store.js";

function fixture(baseUrl = "https://bot.example") {
  const store = new InMemoryLinearStore();
  let now = 100_000;
  const fetcher = vi.fn<typeof fetch>();
  const oauth = new LinearOAuth({
    baseUrl,
    clientId: "client",
    clientSecret: "secret",
    store,
    fetch: fetcher,
    clock: () => now,
  });
  return {
    store,
    fetcher,
    oauth,
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function begin(f: ReturnType<typeof fixture>, baseUrl = "https://bot.example") {
  const res = await f.oauth.handle(new Request(`${baseUrl}/oauth/linear/authorize`));
  const url = new URL(res.headers.get("location")!);
  return { res, url, state: url.searchParams.get("state")!, cookie: res.headers.get("set-cookie")!.split(";")[0] };
}

const tokenResponse = () =>
  Response.json({ access_token: "access-private", refresh_token: "refresh-private", expires_in: 86400 });
const identityResponse = () => Response.json({ data: { viewer: { id: "app" }, organization: { id: "org" } } });

describe("Linear OAuth", () => {
  it("uses app scopes, a trusted callback, browser-bound state and PKCE", async () => {
    const f = fixture();
    const { res, url, state } = await begin(f);
    expect(res.status).toBe(302);
    expect(url.origin).toBe("https://linear.app");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(["read", "write", "app:assignable", "app:mentionable"]);
    expect(url.searchParams.get("redirect_uri")).toBe("https://bot.example/oauth/linear/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(state).toHaveLength(43);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("allows local HTTP but rejects insecure remote origins and URL credentials", async () => {
    const local = fixture("http://localhost:8080");
    const { url, res } = await begin(local, "http://localhost:8080");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8080/oauth/linear/callback");
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
    for (const origin of [
      "http://example.com",
      "https://secret@bot.example",
      "https://bot.example/path",
      "https://bot.example?x=1",
    ]) {
      expect(() => fixture(origin)).toThrow("LINEAR_PUBLIC_BASE_URL");
    }
  });
  it("refuses missing, mismatched, expired and replayed state before token exchange", async () => {
    const f = fixture();
    const { state, cookie } = await begin(f);
    const request = (suffix: string, header?: string) =>
      new Request(`https://bot.example/oauth/linear/callback?code=c${suffix}`, {
        headers: header ? { cookie: header } : {},
      });
    expect((await f.oauth.handle(request(`&state=${state}`))).status).toBe(400);
    expect((await f.oauth.handle(request("&state=wrong", cookie))).status).toBe(400);
    f.setNow(1_000_000);
    expect((await f.oauth.handle(request(`&state=${state}`, cookie))).status).toBe(400);
    f.setNow(100_000);
    expect((await f.oauth.handle(request(`&state=${state}`, cookie))).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("persists workspace and app identity before success and never returns credentials", async () => {
    const f = fixture();
    const { state, cookie } = await begin(f);
    f.fetcher.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(identityResponse());
    const callback = new Request(`https://bot.example/oauth/linear/callback?code=code&state=${state}`, {
      headers: { cookie },
    });
    const res = await f.oauth.handle(callback);
    expect(res.status).toBe(200);
    const stored = await f.store.getInstallation("org");
    expect(stored).toMatchObject({
      organizationId: "org",
      appUserId: "app",
      accessToken: "access-private",
      refreshToken: "refresh-private",
      expiresAt: 86_500_000,
    });
    const body = await res.text();
    expect(body).not.toMatch(/access-private|refresh-private|secret|code=/);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const exchange = new URLSearchParams(f.fetcher.mock.calls[0][1]?.body as URLSearchParams);
    expect(exchange.get("code_verifier")).toHaveLength(43);
    expect(exchange.get("redirect_uri")).toBe("https://bot.example/oauth/linear/callback");
    expect((await f.oauth.handle(callback)).status).toBe(400);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not disclose upstream errors or save an incomplete installation", async () => {
    const f = fixture();
    const { state, cookie } = await begin(f);
    f.fetcher.mockResolvedValueOnce(new Response("secret-access-private", { status: 401 }));
    const res = await f.oauth.handle(
      new Request(`https://bot.example/oauth/linear/callback?code=c&state=${state}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Linear installation failed. Start the installation again.");
    expect(await f.store.getInstallation("org")).toBeUndefined();
  });
  it("rejects methods and unknown paths without creating state or making requests", async () => {
    const f = fixture();
    expect(
      (await f.oauth.handle(new Request("https://bot.example/oauth/linear/authorize", { method: "POST" }))).status,
    ).toBe(405);
    expect((await f.oauth.handle(new Request("https://bot.example/oauth/linear/other"))).status).toBe(404);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("Linear token refresh", () => {
  const installation: LinearInstallation = {
    organizationId: "org",
    appUserId: "app",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 0,
    version: "v1",
  };
  it("shares concurrent refresh and persists both replacement tokens", async () => {
    const f = fixture();
    await f.store.putInstallation(installation);
    f.fetcher.mockResolvedValueOnce(tokenResponse());
    const tokens = new LinearTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      store: f.store,
      fetch: f.fetcher,
      clock: () => 100_000,
    });
    expect(await Promise.all([tokens.accessToken("org"), tokens.accessToken("org")])).toEqual([
      "access-private",
      "access-private",
    ]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await f.store.getInstallation("org")).toMatchObject({
      refreshToken: "refresh-private",
      expiresAt: 86_500_000,
    });
    expect(await tokens.accessToken("org")).toBe("access-private");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not resurrect an installation revoked during refresh", async () => {
    const f = fixture();
    await f.store.putInstallation(installation);
    f.fetcher.mockImplementationOnce(async () => {
      await f.store.replaceInstallation("org", "v1", undefined);
      return tokenResponse();
    });
    const tokens = new LinearTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      store: f.store,
      fetch: f.fetcher,
      clock: () => 100_000,
    });
    await expect(tokens.accessToken("org")).rejects.toThrow("linear_installation_changed");
    expect(await f.store.getInstallation("org")).toBeUndefined();
  });
});
