import { generateKeyPairSync, sign } from "node:crypto";
import { assert, describe, expect, it, vi } from "vitest";
import { LinkCeremony } from "../core/identity/linkCeremony.js";
import { InMemoryPersonDirectory } from "../core/identity/memory.js";
import { AccessHumanProofAdapter } from "./linkProofAccess.js";
import type { AccessJwk } from "./accessAuth.js";

const now = 1_800_000_000_000;
const config = { teamDomain: "proof.cloudflareaccess.com", aud: "application" };
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key: AccessJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "key-a", alg: "RS256", use: "sig" };
function jwt(claims: Record<string, unknown>, header: Record<string, unknown> = {}, signer = pair.privateKey) {
  const input = [JSON.stringify({ alg: "RS256", kid: "key-a", ...header }), JSON.stringify(claims)]
    .map((v) => Buffer.from(v).toString("base64url"))
    .join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), signer).toString("base64url")}`;
}
const accessClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${config.teamDomain}`,
  aud: config.aud,
  sub: "human-a",
  email: "display@example.test",
  iat: now / 1000,
  nbf: now / 1000,
  exp: now / 1000 + 3600,
  ...over,
});
const evidence = (token: unknown) => ({ strategy: "access", token });
function access(keys = [key]) {
  return new AccessHumanProofAdapter(config, { now: () => now, fetchJwks: async () => keys });
}

describe("Access human proof", () => {
  it("projects only signed human metadata from the application JWT", async () => {
    expect(await access().verify(evidence(jwt(accessClaims())))).toEqual({
      kind: "human",
      identity: { issuer: `https://${config.teamDomain}`, tenant: null, subject: "human-a" },
      audience: config.aud,
      issuedAt: now,
      expiresAt: now + 3600_000,
    });
  });
  it("rejects issuer audience time and human service ambiguity", async () => {
    for (const over of [
      { iss: "https://foreign.test" },
      { aud: "other" },
      { aud: [config.aud, 3] },
      { exp: now / 1000 },
      { exp: 1e300 },
      { exp: "later" },
      { iat: undefined },
      { iat: now / 1000 + 61 },
      { iat: "now" },
      { nbf: "now" },
      { nbf: now / 1000 + 61 },
      { sub: "" },
      { sub: " " },
      { sub: undefined },
      { common_name: "service" },
      { sub: "", common_name: "service" },
      { type: "service" },
    ])
      expect(await access().verify(evidence(jwt(accessClaims(over))))).toBeNull();
  });
  it("rejects unsigned email header synthetic and view-as evidence", async () => {
    for (const input of [
      evidence(accessClaims()),
      evidence("human@example.test"),
      evidence(undefined),
      { strategy: "token", token: jwt(accessClaims()) },
      { strategy: "none", token: jwt(accessClaims()) },
      { ...evidence(jwt(accessClaims())), viewAs: "slack:someone" },
      evidence(jwt(accessClaims(), { alg: "none" })),
      evidence(jwt(accessClaims(), { kid: "unknown" })),
      evidence(jwt(accessClaims(), { crit: ["unrecognized"] })),
      evidence(jwt(accessClaims()).slice(0, -20)),
    ])
      expect(await access().verify(input)).toBeNull();
  });
  it("refreshes a warm key cache for real rotation and rejects a foreign signing key", async () => {
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let keys = [key],
      clock = now;
    const adapter = new AccessHumanProofAdapter(config, { now: () => clock, fetchJwks: async () => keys });
    const first = await adapter.verify(evidence(jwt(accessClaims())));
    expect(first).not.toBeNull();
    expect(await adapter.verify(evidence(jwt(accessClaims(), {}, rotated.privateKey)))).toBeNull();
    keys = [{ ...rotated.publicKey.export({ format: "jwk" }), kid: "key-b", alg: "RS256", use: "sig" }];
    clock += 61_000;
    expect(await adapter.verify(evidence(jwt(accessClaims(), { kid: "key-b" }, rotated.privateKey)))).toEqual(first);
  });
  it("accepts trusted key rotation without changing identity and rejects unsafe keys", async () => {
    const adapter = access([{ ...key, kid: "key-b" }]);
    expect(await adapter.verify(evidence(jwt(accessClaims(), { kid: "key-b" })))).toMatchObject({
      identity: { subject: "human-a" },
    });
    for (const bad of [
      { ...key, use: "enc" },
      { ...key, alg: "HS256" },
      { ...key, key_ops: ["encrypt"] },
    ])
      expect(await access([bad]).verify(evidence(jwt(accessClaims())))).toBeNull();
  });
});

import { SlackOidcProofAdapter, SLACK_OIDC } from "./linkProofSlack.js";
import { proofDigest } from "../core/identity/humanProof.js";
const policy = { tenant: "TDEMO", audience: "client-a", callbackUri: "https://app.test/link/callback" };
const nonce = "n".repeat(43);
const state = "s".repeat(43);
const slackClaims = (over: Record<string, unknown> = {}) => ({
  iss: "https://slack.com",
  aud: policy.audience,
  sub: "UDEMO",
  nonce,
  "https://slack.com/team_id": policy.tenant,
  "https://slack.com/user_id": "UDEMO",
  iat: now / 1000,
  exp: now / 1000 + 600,
  ...over,
});
const discovery = {
  issuer: "https://slack.com",
  authorization_endpoint: SLACK_OIDC.authorize,
  token_endpoint: SLACK_OIDC.token,
  jwks_uri: SLACK_OIDC.keys,
  response_modes_supported: ["query"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: ["openid", "profile", "email"],
};
function slack(
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    token?: string;
    discovery?: object;
    keys?: AccessJwk[];
    fail?: boolean;
  } = {},
) {
  const requests: { url: string; init: RequestInit }[] = [];
  const adapter = new SlackOidcProofAdapter(
    { ...policy, teams: [policy.tenant], clientSecret: () => "client-secret" },
    {
      now: () => now,
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (options.fail) throw new Error("code-secret refresh-secret jwt-secret");
        const body =
          url === SLACK_OIDC.discovery
            ? (options.discovery ?? discovery)
            : url === SLACK_OIDC.keys
              ? { keys: options.keys ?? [key] }
              : {
                  ok: true,
                  id_token: options.token ?? jwt(slackClaims(options.claims), options.header),
                  access_token: "access-secret",
                  refresh_token: "refresh-secret",
                };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    },
  );
  return { adapter, requests };
}
const exchange = { code: "code-secret", policy, nonceHash: proofDigest(nonce), createdAt: now };

describe("Slack OIDC human proof", () => {
  it("pins query discovery and exchanges once as a confidential client with the exact redirect", async () => {
    const h = slack();
    const url = new URL((await h.adapter.authorization({ policy, state, nonce }))!);
    expect(url.origin + url.pathname).toBe(SLACK_OIDC.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: policy.audience,
      redirect_uri: policy.callbackUri,
      response_type: "code",
      response_mode: "query",
      scope: "openid profile",
      state,
      nonce,
      team: policy.tenant,
    });
    expect(await h.adapter.exchange(exchange)).toEqual({
      identity: { issuer: "https://slack.com", tenant: policy.tenant, subject: "UDEMO" },
      audience: policy.audience,
      callbackUri: policy.callbackUri,
      nonceHash: proofDigest(nonce),
      expiresAt: now + 600_000,
    });
    const req = h.requests.find((r) => r.url === SLACK_OIDC.token)!;
    expect(req.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(req.init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("client-a:client-secret").toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(req.init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "code-secret",
      redirect_uri: policy.callbackUri,
    });
  });
  it("rejects Slack signature key issuer audience time nonce team and user mismatches", async () => {
    for (const claims of [
      { iss: "https://evil.test" },
      { aud: "other" },
      { aud: [policy.audience, 7] },
      { aud: [policy.audience, "other"] },
      { azp: "other" },
      { nonce: "other" },
      { nonce: undefined },
      { exp: now / 1000 },
      { exp: "never" },
      { exp: 1e300 },
      { iat: undefined },
      { iat: now / 1000 + 61 },
      { iat: now / 1000 - 61 },
      { nbf: now / 1000 + 61 },
      { "https://slack.com/team_id": "TOTHER" },
      { "https://slack.com/team_id": undefined },
      { "https://slack.com/user_id": "UOTHER" },
      { "https://slack.com/user_id": undefined },
      { sub: "" },
      { sub: "BDEMO", "https://slack.com/user_id": "BDEMO" },
      { is_bot: true },
      { is_app_user: true },
      { bot_id: "BDEMO" },
      { sub: undefined, email: "display@example.test", email_verified: true },
    ])
      expect(await slack({ claims }).adapter.exchange(exchange), JSON.stringify(claims)).toBeNull();
    for (const header of [{ alg: "HS256" }, { alg: "none" }, { kid: "unknown" }, { crit: ["unknown"] }])
      expect(await slack({ header }).adapter.exchange(exchange)).toBeNull();
    for (const keys of [[{ ...key, use: "enc" }], [key, key], []])
      expect(await slack({ keys }).adapter.exchange(exchange)).toBeNull();
    for (const token of ["xoxb-bot-token", jwt(slackClaims()).slice(0, -20), JSON.stringify(slackClaims())])
      expect(await slack({ token }).adapter.exchange(exchange)).toBeNull();
  });
  it("accepts authorized multi-audience and rotated trusted keys", async () => {
    expect(
      await slack({ claims: { aud: [policy.audience, "other"], azp: policy.audience } }).adapter.exchange(exchange),
    ).not.toBeNull();
    expect(
      await slack({ keys: [{ ...key, kid: "rotated" }], header: { kid: "rotated" } }).adapter.exchange(exchange),
    ).not.toBeNull();
  });
  it("fails closed on discovery redirect or workspace-policy drift without exchanging a code", async () => {
    for (const change of [
      { response_modes_supported: ["form_post"] },
      { response_modes_supported: ["query", "form_post"] },
      { issuer: "https://evil.test" },
      { token_endpoint: "https://evil.test/token" },
      { authorization_endpoint: "https://evil.test/auth" },
      { jwks_uri: "https://evil.test/keys" },
      { token_endpoint_auth_methods_supported: ["none"] },
      { id_token_signing_alg_values_supported: ["HS256"] },
    ]) {
      const h = slack({ discovery: { ...discovery, ...change } });
      expect(await h.adapter.authorization({ policy, state, nonce })).toBeNull();
      expect(await h.adapter.exchange(exchange)).toBeNull();
      expect(h.requests.every((r) => r.url === SLACK_OIDC.discovery)).toBe(true);
    }
    for (const change of [{ callbackUri: policy.callbackUri + "/" }, { tenant: "TOTHER" }, { audience: "other" }]) {
      const h = slack();
      expect(await h.adapter.exchange({ ...exchange, policy: { ...policy, ...change } })).toBeNull();
      expect(h.requests).toHaveLength(0);
    }
  });
  it("suppresses provider errors and drops all response credentials", async () => {
    expect(await slack({ fail: true }).adapter.exchange(exchange)).toBeNull();
    const result = await slack().adapter.exchange(exchange);
    expect(JSON.stringify(result)).not.toMatch(/code-secret|access-secret|refresh-secret|id_token|email/);
  });
});

describe("verified proof handoff", () => {
  it("carries real signed Access and Slack proofs through consent without persisting credentials", async () => {
    const options: { claims?: Record<string, unknown> } = {};
    const provider = slack(options);
    const directory = new InMemoryPersonDirectory(() => now);
    const commands = vi.spyOn(directory, "link");
    const ceremony = new LinkCeremony({ directory, access: access(), slack: provider.adapter, now: () => now }, policy);
    const token = jwt(accessClaims());
    const begun = await ceremony.begin(evidence(token));
    assert(begun.status === "started");
    const query = new URL(begun.authorizationUrl).searchParams;
    options.claims = { nonce: query.get("nonce") };
    const callback = await ceremony.callback({
      session: begun.session,
      evidence: evidence(token),
      method: "GET",
      callbackUri: policy.callbackUri,
      query: new URLSearchParams({ state: query.get("state")!, code: "code-secret" }),
    });
    expect(callback.result).toMatchObject({ status: "ok", intent: { state: "awaiting-consent" } });
    expect(await ceremony.commit(begun.session, evidence(token), 3, true)).toMatchObject({
      status: "committed",
      receipt: { actor: { subject: "human-a" }, slack: { identity: { tenant: "TDEMO", subject: "UDEMO" } } },
    });
    const serialized = JSON.stringify(commands.mock.calls);
    for (const secret of [
      token,
      "code-secret",
      "access-secret",
      "refresh-secret",
      begun.session.browser,
      query.get("nonce")!,
      query.get("state")!,
    ])
      expect(serialized).not.toContain(secret);
    commands.mockRestore();
  });
});
