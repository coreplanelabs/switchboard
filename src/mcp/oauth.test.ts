import { describe, expect, it } from "vitest";
import { fakeAuthorizationServer } from "./fake.js";
import {
  authorizationUrl,
  detectAuth,
  discover,
  exchangeCode,
  isOAuthCredential,
  needsRefresh,
  nonceOfState,
  OAUTH_MAX_EXPIRES_IN_MS,
  OAUTH_REFRESH_SKEW_MS,
  OAuthError,
  oauthState,
  parseStoredCredential,
  pkce,
  refreshCredential,
  registerClient,
  resourceMetadataHint,
  type OAuthDiscovery,
  type OAuthPending,
} from "./oauth.js";

// features/mcp-tools.md item 18: OAuth 2.1 against a fake authorization
// server shaped like Vanta's (RFC 9728 resource metadata at the root, RFC 8414
// metadata with the path inserted after the host, dynamic registration, PKCE
// S256 checked for real, authorization_code + refresh_token, public client).

const NOW = 1_700_000_000_000;
const SERVER = "https://mcp.example.com/mcp";
const CALLBACK = "https://switchboard.test/mcp/oauth/callback";

describe("detectAuth", () => {
  it("2xx → none; 401 with discoverable OAuth → oauth (with the discovery); 401 without → bearer; anything else → error naming --auth; unreachable → error", async () => {
    const oauth = fakeAuthorizationServer({ server: SERVER });
    expect(await detectAuth(oauth.fetch, SERVER)).toMatchObject({
      auth: "oauth",
      discovery: { tokenEndpoint: "https://as.example.com/oauth/token" },
    });
    expect(oauth.calls.filter((c) => c.url === SERVER).every((c) => !c.headers.authorization)).toBe(true);
    const open = fakeAuthorizationServer({ server: SERVER, initializeStatus: 200 });
    expect(await detectAuth(open.fetch, SERVER)).toEqual({ auth: "none" });
    const bearer = fakeAuthorizationServer({ server: SERVER, metadata: false });
    expect(await detectAuth(bearer.fetch, SERVER)).toEqual({ auth: "bearer" });
    const odd = fakeAuthorizationServer({ server: SERVER, initializeStatus: 500 });
    await expect(detectAuth(odd.fetch, SERVER)).rejects.toThrow(/HTTP 500.*--auth/);
    const down = fakeAuthorizationServer({ server: SERVER, down: true });
    await expect(detectAuth(down.fetch, SERVER)).rejects.toThrow(/could not be reached/);
  });

  it("reads the WWW-Authenticate resource_metadata hint, quoted or bare", () => {
    expect(
      resourceMetadataHint(
        'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(
      resourceMetadataHint("Bearer resource_metadata=https://x.example/.well-known/oauth-protected-resource, scope=a"),
    ).toBe("https://x.example/.well-known/oauth-protected-resource");
    expect(resourceMetadataHint(null)).toBeUndefined();
    expect(resourceMetadataHint("Bearer realm=x")).toBeUndefined();
  });
});

describe("discover", () => {
  it("resource metadata: the hinted URL first, then the path-inserted and root well-known forms; the authorization server's RFC 8414 document with the path inserted after the host (Vanta's shape); scopes from the resource", async () => {
    const as = fakeAuthorizationServer({ server: SERVER });
    expect(await discover(as.fetch, SERVER)).toEqual({
      resource: "https://mcp.example.com/mcp",
      issuer: "https://as.example.com/mcp",
      authorizationEndpoint: "https://as.example.com/oauth/authorize",
      tokenEndpoint: "https://as.example.com/oauth/token",
      registrationEndpoint: "https://as.example.com/oauth/register",
      scopes: ["mcp-api.all:write"],
    });
    const urls = as.calls.map((c) => c.url);
    expect(urls.indexOf("https://mcp.example.com/.well-known/oauth-protected-resource/mcp")).toBeLessThan(
      urls.indexOf("https://mcp.example.com/.well-known/oauth-protected-resource"),
    );
    expect(urls).toContain("https://as.example.com/.well-known/oauth-authorization-server/mcp");
    // With the hint, the hinted document is fetched first.
    const hinted = fakeAuthorizationServer({ server: SERVER });
    await discover(hinted.fetch, SERVER, "https://mcp.example.com/.well-known/oauth-protected-resource");
    expect(hinted.calls[0].url).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
  });

  it("a server that is its own authorization server (no resource metadata) is discovered from its origin; no metadata anywhere is an error (detection's `bearer` fallback)", async () => {
    const self = fakeAuthorizationServer({ server: SERVER, selfIssued: true });
    expect((await discover(self.fetch, SERVER)).tokenEndpoint).toBe("https://mcp.example.com/oauth/token");
    const none = fakeAuthorizationServer({ server: SERVER, metadata: false });
    await expect(discover(none.fetch, SERVER)).rejects.toThrow(/no OAuth metadata/);
  });

  it("refuses an authorization server without PKCE S256 or the authorization_code grant, http endpoints, and blocked hosts", async () => {
    await expect(
      discover(fakeAuthorizationServer({ server: SERVER, codeChallengeMethods: ["plain"] }).fetch, SERVER),
    ).rejects.toThrow(/PKCE S256/);
    await expect(
      discover(fakeAuthorizationServer({ server: SERVER, grantTypes: ["client_credentials"] }).fetch, SERVER),
    ).rejects.toThrow(/authorization_code/);
    await expect(
      discover(
        fakeAuthorizationServer({ server: SERVER, tokenEndpoint: "http://as.example.com/oauth/token" }).fetch,
        SERVER,
      ),
    ).rejects.toThrow(/must be https/);
    // Loopback gets no https exemption: the SSRF guard refuses it before the scheme is looked at.
    await expect(
      discover(
        fakeAuthorizationServer({ server: SERVER, tokenEndpoint: "http://localhost:8080/oauth/token" }).fetch,
        SERVER,
      ),
    ).rejects.toThrow(/token_endpoint: blocked host/);
    await expect(
      discover(
        fakeAuthorizationServer({ server: SERVER, tokenEndpoint: "http://127.0.0.1/oauth/token" }).fetch,
        SERVER,
      ),
    ).rejects.toThrow(/token_endpoint: blocked address/);
    await expect(
      discover(
        fakeAuthorizationServer({ server: SERVER, authorizationServers: ["https://169.254.169.254/"] }).fetch,
        SERVER,
      ),
    ).rejects.toThrow(OAuthError);
  });
});

describe("registerClient + PKCE + the authorization URL", () => {
  it("registers a public client with our callback as the only redirect URI and both grants; the authorization URL carries S256, state, resource and scope", async () => {
    const as = fakeAuthorizationServer({ server: SERVER });
    const d = await discover(as.fetch, SERVER);
    const client = await registerClient(as.fetch, d, CALLBACK, "https://switchboard.test");
    expect(client).toEqual({ clientId: "client-1" });
    expect(as.registrations[0]).toMatchObject({
      client_name: "Switchboard",
      client_uri: "https://switchboard.test",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp-api.all:write",
    });
    const { verifier, challenge } = await pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = oauthState("n".repeat(24));
    expect(nonceOfState(state)).toBe("n".repeat(24));
    expect(nonceOfState("no-dot")).toBeUndefined();
    const pending: OAuthPending = {
      state,
      codeVerifier: verifier,
      clientId: client.clientId,
      tokenEndpoint: d.tokenEndpoint,
      redirectUri: CALLBACK,
      resource: d.resource,
      scope: "mcp-api.all:write",
    };
    const u = new URL(authorizationUrl(d, pending, challenge));
    expect(u.origin + u.pathname).toBe("https://as.example.com/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: CALLBACK,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://mcp.example.com/mcp",
      scope: "mcp-api.all:write",
    });
  });

  it("no registration endpoint → a sentence; a refused registration names the status", async () => {
    const as = fakeAuthorizationServer({ server: SERVER });
    const d: OAuthDiscovery = { ...(await discover(as.fetch, SERVER)), registrationEndpoint: undefined };
    await expect(registerClient(as.fetch, d, CALLBACK)).rejects.toThrow(/dynamic client registration/);
    const refusing = fakeAuthorizationServer({ server: SERVER, registrationStatus: 400 });
    await expect(registerClient(refusing.fetch, await discover(refusing.fetch, SERVER), CALLBACK)).rejects.toThrow(
      /refused.*HTTP 400/,
    );
  });
});

describe("exchangeCode + refreshCredential", () => {
  const VERIFIER = "v".repeat(43);
  const pending = (): OAuthPending => ({
    state: `${"n".repeat(24)}.abc`,
    codeVerifier: VERIFIER,
    clientId: "client-1",
    tokenEndpoint: "https://as.example.com/oauth/token",
    redirectUri: CALLBACK,
    resource: "https://mcp.example.com/mcp",
    scope: "mcp-api.all:write",
  });

  it("exchanges the code with the verifier, client id, redirect URI and resource; the credential carries an absolute expiry, the refresh token, the scope", async () => {
    const as = fakeAuthorizationServer({ server: SERVER });
    const code = await as.codeFor(VERIFIER);
    const cred = await exchangeCode(as.fetch, pending(), code, NOW);
    expect(cred).toEqual({
      kind: "oauth",
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: NOW + 3600_000,
      clientId: "client-1",
      tokenEndpoint: "https://as.example.com/oauth/token",
      resource: "https://mcp.example.com/mcp",
      scope: "mcp-api.all:write",
    });
    expect(as.tokenRequests[0]).toEqual({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: "client-1",
      redirect_uri: CALLBACK,
      resource: "https://mcp.example.com/mcp",
    });
    expect(isOAuthCredential(cred)).toBe(true);
  });

  it("a wrong verifier, a used code, or a non-bearer token type is refused with the server's error; nothing is invented", async () => {
    const as = fakeAuthorizationServer({ server: SERVER });
    const code = await as.codeFor(VERIFIER);
    await expect(exchangeCode(as.fetch, { ...pending(), codeVerifier: "x".repeat(43) }, code, NOW)).rejects.toThrow(
      /invalid_grant/,
    );
    await exchangeCode(as.fetch, pending(), code, NOW);
    await expect(exchangeCode(as.fetch, pending(), code, NOW)).rejects.toThrow(/invalid_grant/);
    const mac = fakeAuthorizationServer({ server: SERVER, tokenType: "MAC" });
    await expect(exchangeCode(mac.fetch, pending(), await mac.codeFor(VERIFIER), NOW)).rejects.toThrow(/only bearer/);
  });

  it("expires_in is range-checked: zero or negative is an already-dead token and refused; an absurd value is clamped to the cap; a non-numeric one is ignored", async () => {
    const zero = fakeAuthorizationServer({ server: SERVER, expiresIn: 0 });
    await expect(exchangeCode(zero.fetch, pending(), await zero.codeFor(VERIFIER), NOW)).rejects.toThrow(
      /already expired/,
    );
    const negative = fakeAuthorizationServer({ server: SERVER, expiresIn: -5 });
    await expect(exchangeCode(negative.fetch, pending(), await negative.codeFor(VERIFIER), NOW)).rejects.toThrow(
      /already expired/,
    );
    const absurd = fakeAuthorizationServer({ server: SERVER, expiresIn: 1e15 });
    expect((await exchangeCode(absurd.fetch, pending(), await absurd.codeFor(VERIFIER), NOW)).expiresAt).toBe(
      NOW + OAUTH_MAX_EXPIRES_IN_MS,
    );
    const junk = fakeAuthorizationServer({ server: SERVER, expiresIn: "soon" as unknown as number });
    expect((await exchangeCode(junk.fetch, pending(), await junk.codeFor(VERIFIER), NOW)).expiresAt).toBeUndefined();
  });

  it("needsRefresh is true inside the skew before expiry and never without an expiry; refresh keeps the old refresh token unless the server rotates it; no refresh token or a revoked one is a sentence", async () => {
    const as = fakeAuthorizationServer({ server: SERVER });
    const cred = await exchangeCode(as.fetch, pending(), await as.codeFor(VERIFIER), NOW);
    expect(needsRefresh(cred, NOW)).toBe(false);
    expect(needsRefresh(cred, NOW + 3600_000 - OAUTH_REFRESH_SKEW_MS)).toBe(true);
    expect(needsRefresh({ ...cred, expiresAt: undefined }, NOW + 10 * 3600_000)).toBe(false);
    const later = NOW + 3600_000;
    const next = await refreshCredential(as.fetch, cred, later);
    expect(next).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1", expiresAt: later + 3600_000 });
    expect(as.tokenRequests.at(-1)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "client-1",
      resource: "https://mcp.example.com/mcp",
    });
    const rotating = fakeAuthorizationServer({ server: SERVER, rotateRefresh: true });
    const c2 = await exchangeCode(rotating.fetch, pending(), await rotating.codeFor(VERIFIER), NOW);
    expect((await refreshCredential(rotating.fetch, c2, later)).refreshToken).toBe("rt-2");
    await expect(refreshCredential(as.fetch, { ...cred, refreshToken: undefined }, later)).rejects.toThrow(
      /no refresh token/,
    );
    await expect(refreshCredential(as.fetch, { ...cred, refreshToken: "revoked" }, later)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});

describe("parseStoredCredential", () => {
  it("a raw string is a bearer token (even one starting with `{` that is not our JSON); our JSON is the OAuth set", () => {
    expect(parseStoredCredential("tok-1")).toEqual({ kind: "bearer", token: "tok-1" });
    expect(parseStoredCredential("{not json")).toEqual({ kind: "bearer", token: "{not json" });
    expect(parseStoredCredential('{"kind":"other"}')).toEqual({ kind: "bearer", token: '{"kind":"other"}' });
    const cred = {
      kind: "oauth",
      accessToken: "a",
      clientId: "c",
      tokenEndpoint: "https://as.example.com/oauth/token",
      resource: "https://mcp.example.com/mcp",
    };
    expect(parseStoredCredential(JSON.stringify(cred))).toEqual(cred);
  });
});
