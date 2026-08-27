import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// App-layer Cloudflare Access (SSO) enforcement for the /runs* surface. The bot
// sits on a custom domain behind a Cloudflare Access edge rule on `/runs*`; that
// rule injects a signed RS256 JWT in the `Cf-Access-Jwt-Assertion` request
// header. This module re-verifies that identity in OUR OWN code and FAILS
// CLOSED, so `/runs*` refuses to serve without a valid Access JWT — even if the
// edge rule is ever misconfigured, removed, or a client spoofs the header.
//
// Security posture (mirrors channels/http.ts):
//   - Fail-closed: no Access config → /runs is denied (403), never open. The
//     only escape hatch is an explicit, loudly-documented local-dev bypass.
//   - Algorithm confusion is the critical defense: the header `alg` MUST be
//     RS256; `none`/`HS256`/anything else is rejected before any signature work,
//     and verification always uses RSA-SHA256 (never an attacker-named alg).
//   - The JWKS fetch is an injectable seam (real `httpJwksFetcher` + a test
//     impl), satisfying the AGENTS.md ≥2-implementations invariant. Signing keys
//     are cached by `kid` with a TTL and refreshed once on an unknown kid.
//   - Bad input never throws: every malformed token / claim yields `null`.
//
// Pure logic (verify + claim checks) is split from transport (the gate reads a
// header; index.ts writes the 403), so it is unit-testable without a socket.

const CERTS_PATH = "/cdn-cgi/access/certs";
const DEFAULT_JWKS_TTL_SECONDS = 3600;
/** Clock skew tolerance for nbf/iat, in seconds. */
const SKEW_SECONDS = 60;

/** Cloudflare Access application config. `teamDomain` is a bare host like
 *  `coreplane.cloudflareaccess.com`; `aud` is the application's AUD tag. */
export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

/** The identity carried by a verified Access JWT. */
export interface AccessIdentity {
  sub: string;
  email?: string;
}

/** A JWK with the `kid` field Access includes (the standard `JsonWebKey` lib
 *  type omits it). The string index signature keeps it assignable to node's
 *  `crypto.JsonWebKey` (which carries one) at the `createPublicKey` call site. */
export type AccessJwk = JsonWebKey & { kid?: string; [prop: string]: unknown };

/** JWKS provider seam: given the certs URL, return the JWK set's keys. Injected
 *  so tests never hit the network; the default is `httpJwksFetcher`. */
export type JwksFetcher = (certsUrl: string) => Promise<AccessJwk[]>;

/** Default JWKS fetcher over global `fetch` (Node 22). Cloudflare's certs
 *  endpoint returns `{ keys: JWK[], ... }`; we take `keys`. Throws on a non-OK
 *  response or a malformed body — the caller (verifyAccessJwt) treats a throw as
 *  fail-closed (null). */
export const httpJwksFetcher: JwksFetcher = async (certsUrl) => {
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new Error("JWKS response missing keys[]");
  return keys as AccessJwk[];
};

/**
 * A small `kid` → signing-key cache with a TTL. Dumb store: it holds no clock or
 * fetcher of its own; `verifyAccessJwt` drives the TTL and the one-refresh-on-
 * unknown-kid policy. Reused across verifies (index.ts constructs one) so a warm
 * kid is served without a network round-trip.
 */
export class JwksCache {
  private readonly entries = new Map<string, { jwk: AccessJwk; expiresAt: number }>();

  /** The fresh JWK for `kid`, or null if absent/expired (expired entries are
   *  evicted lazily). `now` is milliseconds. */
  get(kid: string, now: number): AccessJwk | null {
    const hit = this.entries.get(kid);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.entries.delete(kid);
      return null;
    }
    return hit.jwk;
  }

  /** Store every kid'd key from a freshly fetched JWKS with the given absolute
   *  expiry (ms). Keyless entries are skipped. */
  put(keys: AccessJwk[], expiresAt: number): void {
    for (const jwk of keys) {
      if (typeof jwk.kid === "string" && jwk.kid !== "") {
        this.entries.set(jwk.kid, { jwk, expiresAt });
      }
    }
  }
}

/** Verifier dependencies. `fetchJwks` + `now` are injectable for tests; an
 *  optional shared `cache` persists signing keys across verifies (index.ts and
 *  the caching tests supply one — omit it for a one-shot, single-fetch verify).
 *  `now` is milliseconds. */
export interface VerifyDeps {
  fetchJwks: JwksFetcher;
  now: () => number;
  cache?: JwksCache;
  /** Cached-key TTL in seconds. Default 3600. */
  ttlSeconds?: number;
}

/** base64url-decode to a Buffer, or null if the input is not valid base64url. */
function decodeBase64Url(part: string): Buffer | null {
  if (part === "" || /[^A-Za-z0-9_-]/.test(part)) return null;
  return Buffer.from(part, "base64url");
}

/** base64url-decode + JSON.parse into an object, or null on any failure. */
function decodeJsonSegment(part: string): Record<string, unknown> | null {
  const buf = decodeBase64Url(part);
  if (!buf) return null;
  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Resolve the signing key for `kid`, using the cache and refreshing at most
 *  once if the kid is unknown/expired. null if still not found or the fetch
 *  fails. One refresh attempt per verify. */
async function resolveKey(kid: string, config: AccessConfig, deps: VerifyDeps): Promise<AccessJwk | null> {
  const cache = deps.cache ?? new JwksCache();
  const cached = cache.get(kid, deps.now());
  if (cached) return cached;

  let keys: AccessJwk[];
  try {
    keys = await deps.fetchJwks(`https://${config.teamDomain}${CERTS_PATH}`);
  } catch {
    return null; // fail closed: a JWKS fetch failure is not a valid identity
  }
  const ttlMs = (deps.ttlSeconds ?? DEFAULT_JWKS_TTL_SECONDS) * 1000;
  cache.put(keys, deps.now() + ttlMs);
  return cache.get(kid, deps.now());
}

/** Validate the registered claims against the config + clock. `now` is ms. */
function claimsValid(claims: Record<string, unknown>, config: AccessConfig, now: number): boolean {
  const nowSec = Math.floor(now / 1000);

  if (claims.iss !== `https://${config.teamDomain}`) return false;

  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === config.aud : Array.isArray(aud) && aud.includes(config.aud);
  if (!audOk) return false;

  // exp is required and must be in the future.
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) return false;
  // nbf/iat, if present, must not be in the future beyond the skew tolerance.
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + SKEW_SECONDS) return false;
  if (typeof claims.iat === "number" && claims.iat > nowSec + SKEW_SECONDS) return false;

  return typeof claims.sub === "string" && claims.sub !== "";
}

/**
 * Verify a Cloudflare Access compact-JWS token. Returns the identity on success,
 * or `null` for ANY failure — malformed input, wrong/absent alg, unknown kid,
 * bad signature, or an invalid claim. Never throws on caller-controlled input.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  deps: VerifyDeps,
): Promise<AccessIdentity | null> {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = decodeJsonSegment(rawHeader);
  const payload = decodeJsonSegment(rawPayload);
  if (!header || !payload) return null;

  // Algorithm confusion defense: pin RS256. Reject `none`, `HS256`, or anything
  // else BEFORE touching the signature — and verification below is always
  // RSA-SHA256, never an alg named by the (attacker-controlled) header.
  if (header.alg !== "RS256") return null;
  if (typeof header.kid !== "string" || header.kid === "") return null;

  const signature = decodeBase64Url(rawSignature);
  if (!signature) return null;

  const jwk = await resolveKey(header.kid, config, deps);
  if (!jwk) return null;

  let signatureOk: boolean;
  try {
    const key = createPublicKey({ format: "jwk", key: jwk });
    signatureOk = cryptoVerify("RSA-SHA256", Buffer.from(`${rawHeader}.${rawPayload}`), key, signature);
  } catch {
    return null; // a malformed JWK / wrong key type is not a valid signature
  }
  if (!signatureOk) return null;

  if (!claimsValid(payload, config, deps.now())) return null;

  return {
    sub: payload.sub as string,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

/** Strip a leading http(s):// scheme and any trailing slashes from a host. */
function normalizeTeamDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/**
 * Read Access config from the environment. Returns the config only if BOTH
 * `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set and non-blank (trimmed); else
 * `null` — which the gate treats as "Access not configured" (fail-closed).
 * `teamDomain` is defensively normalized to a bare host.
 */
export function parseAccessConfig(env: NodeJS.ProcessEnv): AccessConfig | null {
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN ?? "");
  const aud = (env.ACCESS_AUD ?? "").trim();
  if (teamDomain === "" || aud === "") return null;
  return { teamDomain, aud };
}

/**
 * Parse the local-dev bypass flag. **LOCAL DEV ONLY** — when true AND no Access
 * config is present, `/runs*` is served WITHOUT any SSO check. Never set this in
 * a deployed environment; it exists so a developer running the bot locally
 * (without a Cloudflare Access app) can open the live-view page. Truthy values
 * are `"1"` and `"true"` (case-insensitive); everything else is false.
 */
export function parseAccessDevBypass(env: NodeJS.ProcessEnv): boolean {
  const v = (env.ACCESS_DEV_BYPASS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Options for the /runs gate: the (possibly null) Access config, the verifier
 *  deps, and the local-dev bypass flag. */
export interface RunsGateOptions {
  config: AccessConfig | null;
  verify: VerifyDeps;
  devBypass: boolean;
}

/** The gate result: allow (with identity) or deny (with a status + body). */
export type RunsGateResult =
  | { ok: true; identity: AccessIdentity }
  | { ok: false; status: number; body: string };

/**
 * The /runs* SSO gate, fail-closed:
 *   - No Access config: dev bypass → allow (dev-bypass identity); else → 403.
 *     `/runs` is NEVER exposed without SSO configured.
 *   - Access config present: a missing header or a token that fails
 *     verifyAccessJwt → 403; a valid token → allow with its identity.
 * This is the identity gate only; the live-view handler still applies its own
 * per-run capability-token check afterward (defense in depth).
 */
export async function requireAccessForRuns(
  headers: IncomingHttpHeaders,
  opts: RunsGateOptions,
): Promise<RunsGateResult> {
  if (opts.config === null) {
    if (opts.devBypass) return { ok: true, identity: { sub: "dev-bypass" } };
    return { ok: false, status: 403, body: "forbidden" };
  }

  // Node lowercases header keys; Cloudflare injects `Cf-Access-Jwt-Assertion`.
  const raw = headers["cf-access-jwt-assertion"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return { ok: false, status: 403, body: "forbidden" };

  const identity = await verifyAccessJwt(token, opts.config, opts.verify);
  if (!identity) return { ok: false, status: 403, body: "forbidden" };
  return { ok: true, identity };
}
