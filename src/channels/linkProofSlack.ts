import { createPublicKey, verify } from "node:crypto";
import { secondsToMs } from "../core/budgets.js";
import {
  proofDigest,
  type SlackHumanProof,
  type SlackPolicy,
  type SlackProofProvider,
  type SlackProofRequest,
} from "../core/identity/humanProof.js";
import type { AccessJwk } from "./accessAuth.js";
import { audienceValid, jwtParts, signingKeys, tokenTimes } from "./linkProofJwt.js";

export const SLACK_OIDC = Object.freeze({
  issuer: "https://slack.com",
  discovery: "https://slack.com/.well-known/openid-configuration",
  authorize: "https://slack.com/openid/connect/authorize",
  token: "https://slack.com/api/openid.connect.token",
  keys: "https://slack.com/openid/connect/keys",
});
interface SlackClient {
  audience: string;
  callbackUri: string;
  teams: readonly string[];
  clientSecret: () => string;
}
interface SlackDeps {
  now: () => number;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}
const transport: RequestInit = {
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer",
  credentials: "omit",
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid provider response");
  return value as Record<string, unknown>;
}

/** Not installed at startup. No bot token, user-info/email fallback, logger,
 * credential cache or token-bearing error escapes this confidential-client seam. */
export class SlackOidcProofAdapter implements SlackProofProvider {
  private readonly client: SlackClient;
  constructor(
    client: SlackClient,
    private readonly deps: SlackDeps,
  ) {
    this.client = { ...client, teams: [...client.teams] };
  }
  private policyMatches(policy: SlackPolicy): boolean {
    const url = new URL(this.client.callbackUri);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !!this.client.audience &&
      policy.audience === this.client.audience &&
      policy.callbackUri === this.client.callbackUri &&
      /^T[A-Z0-9]+$/.test(policy.tenant) &&
      this.client.teams.includes(policy.tenant)
    );
  }
  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.deps.fetch(url, { ...transport, ...init });
    if (!response.ok) throw new Error("provider unavailable");
    return object(await response.json());
  }
  private async protocol(): Promise<boolean> {
    const d = await this.json(SLACK_OIDC.discovery);
    const supports = (field: string, value: string) => Array.isArray(d[field]) && d[field].includes(value);
    return (
      d.issuer === SLACK_OIDC.issuer &&
      d.authorization_endpoint === SLACK_OIDC.authorize &&
      d.token_endpoint === SLACK_OIDC.token &&
      d.jwks_uri === SLACK_OIDC.keys &&
      JSON.stringify(d.response_modes_supported) === JSON.stringify(["query"]) &&
      JSON.stringify(d.id_token_signing_alg_values_supported) === JSON.stringify(["RS256"]) &&
      supports("response_types_supported", "code") &&
      supports("grant_types_supported", "authorization_code") &&
      supports("scopes_supported", "openid") &&
      supports("scopes_supported", "profile") &&
      supports("token_endpoint_auth_methods_supported", "client_secret_basic")
    );
  }
  async authorization(input: { policy: SlackPolicy; state: string; nonce: string }): Promise<string | null> {
    try {
      if (
        !this.policyMatches(input.policy) ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
        input.state === input.nonce ||
        !(await this.protocol())
      )
        return null;
      const params = new URLSearchParams({
        client_id: this.client.audience,
        redirect_uri: this.client.callbackUri,
        response_type: "code",
        response_mode: "query",
        scope: "openid profile",
        state: input.state,
        nonce: input.nonce,
        team: input.policy.tenant,
      });
      return `${SLACK_OIDC.authorize}?${params}`;
    } catch {
      return null;
    }
  }
  async exchange(input: SlackProofRequest): Promise<SlackHumanProof | null> {
    try {
      if (!this.policyMatches(input.policy) || !input.code || input.code.length > 4096 || !(await this.protocol()))
        return null;
      const secret = this.client.clientSecret();
      if (!secret) return null;
      // OAuth Basic encodes each component before joining; credentials never ride
      // the URL, follow a redirect, or enter a thrown provider error.
      const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
      const response = await this.json(SLACK_OIDC.token, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${encode(this.client.audience)}:${encode(secret)}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: this.client.callbackUri,
        }).toString(),
      });
      if (response.ok !== true) return null;
      const token = jwtParts(response.id_token);
      if (!token) return null;
      const jwks = await this.json(SLACK_OIDC.keys);
      if (!Array.isArray(jwks.keys)) return null;
      const jwk = signingKeys(jwks.keys as AccessJwk[]).find((k) => k.kid === token.header.kid);
      if (
        !jwk ||
        !verify("RSA-SHA256", Buffer.from(token.input), createPublicKey({ key: jwk, format: "jwk" }), token.signature)
      )
        return null;
      const c = token.claims;
      const times = tokenTimes(c, this.deps.now());
      if (
        !times ||
        times.issuedAt < input.createdAt - secondsToMs(60) ||
        c.iss !== SLACK_OIDC.issuer ||
        !audienceValid(c.aud, this.client.audience) ||
        (c.azp !== undefined && c.azp !== this.client.audience) ||
        (Array.isArray(c.aud) && c.aud.length > 1 && c.azp !== this.client.audience) ||
        typeof c.nonce !== "string" ||
        proofDigest(c.nonce) !== input.nonceHash ||
        c["https://slack.com/team_id"] !== input.policy.tenant ||
        typeof c.sub !== "string" ||
        !/^[UW][A-Z0-9]+$/.test(c.sub) ||
        c["https://slack.com/user_id"] !== c.sub ||
        (c.is_bot !== undefined && c.is_bot !== false) ||
        (c.is_app_user !== undefined && c.is_app_user !== false) ||
        c.bot_id !== undefined
      )
        return null;
      return {
        identity: { issuer: SLACK_OIDC.issuer, tenant: input.policy.tenant, subject: c.sub },
        audience: this.client.audience,
        callbackUri: this.client.callbackUri,
        nonceHash: input.nonceHash,
        expiresAt: times.expiresAt,
      };
    } catch {
      return null;
    }
  }
}
