import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { type AccessConfig, type AccessIdentity, type VerifyDeps, verifyAccessJwt } from "./accessAuth.js";
import {
  DEFAULT_DASHBOARD_TOKEN_ENV,
  resolveDashboardAuthMode,
  tokenSubjectOf,
  type DashboardAuthMode,
  type DashboardConfig,
} from "../core/dashboardAuthConfig.js";

// Dashboard authentication is a Strategy: `config.yaml`'s `dashboard.auth`
// picks ONE verifier, and index.ts asks it one question per request — who is
// this, or why not — before anything under /runs*, /residents*, /costs*,
// /mcp/connect/* or /api/* is served. Three strategies, one interface:
//
//   access — the Cloudflare Access JWT the edge injects (accessAuth.ts), for a
//            deployment behind an Access application (ACCESS_TEAM_DOMAIN and
//            ACCESS_AUD stay the env inputs).
//   token  — a bearer read from a named env var, resolving to one configured
//            actor id: an Access-free deployment fronted by anything that can
//            add an Authorization header (a reverse proxy, curl, a script).
//   none   — no credential at all, so the one rule is WHERE the request comes
//            from: a loopback socket on a localhost deployment. Anything else
//            is refused — `none` never serves a remote caller.
//
// Interface segregation: the verifier is `verify(req) → identity | refusal`,
// not the whole Access module — index.ts, the tests and a future strategy see
// nothing else. The identity every strategy produces is the shape the actor
// resolver keys on (`accessActor` in commandHttp.ts): a browser-shaped
// `{ sub }` is the actor `access:<sub>`, whatever proved it. The selection
// rule and the config block live in src/core/dashboardAuthConfig.ts, shared
// with the capabilities value so `caps.dashboardAuth` names this strategy.

/** The actor id the `none` strategy serves as: a local operator, granted like
 *  any other browser session (`grants.access:loopback` adds to the reads). */
export const LOOPBACK_SUBJECT = "loopback";

/** What a verifier reads from a request: the headers and the socket's peer
 *  address — never the body, never the URL. */
export interface DashboardRequest {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string };
}

/** The one answer: who (an identity the actor resolver keys on) or why not
 *  (a status + body index.ts writes as-is). */
export type DashboardVerdict = { ok: true; identity: AccessIdentity } | { ok: false; status: number; body: string };

export interface DashboardVerifier {
  readonly mode: DashboardAuthMode;
  /** One clause for the startup log — the mode and what it checks, never a secret. */
  describe(): string;
  verify(req: DashboardRequest): Promise<DashboardVerdict>;
}

const FORBIDDEN: DashboardVerdict = { ok: false, status: 403, body: "forbidden" };

/** The first value of a header node may have folded into an array. */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

// ── access ───────────────────────────────────────────────────────────────────

/**
 * The Cloudflare Access strategy: the edge rule on the dashboard paths
 * authenticates the user and injects a signed RS256 JWT in
 * `Cf-Access-Jwt-Assertion`; we re-verify it here (accessAuth.ts) and fail
 * closed, so a client that reaches the origin directly with a missing, forged
 * or expired token is refused even if the edge rule is misconfigured.
 */
export function accessVerifier(config: AccessConfig, deps: VerifyDeps): DashboardVerifier {
  return {
    mode: "access",
    describe: () => `access (Cloudflare Access SSO, ${config.teamDomain})`,
    async verify(req) {
      // Node lowercases header keys; Cloudflare injects `Cf-Access-Jwt-Assertion`.
      const token = header(req.headers, "cf-access-jwt-assertion");
      if (!token) return FORBIDDEN;
      const identity = await verifyAccessJwt(token, config, deps);
      return identity ? { ok: true, identity } : FORBIDDEN;
    },
  };
}

// ── token ────────────────────────────────────────────────────────────────────

/** Constant-time equality of two secrets of any lengths: both are hashed first,
 *  so the comparison neither leaks the length nor short-circuits on a prefix. */
function secretsEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface TokenVerifierOptions {
  /** The bearer, as read from the env var. */
  token: string;
  /** The env var it came from — named in the startup log, never its value. */
  env: string;
  /** The `sub` a matching bearer resolves to (`tokenSubjectOf(actor)`). */
  subject: string;
}

/**
 * The bearer strategy: `Authorization: Bearer <token>` compared in constant
 * time against the one configured secret; a match is the one configured actor.
 * Anything else — no header, another scheme, a wrong or empty token — is 403.
 */
export function tokenVerifier(opts: TokenVerifierOptions): DashboardVerifier {
  return {
    mode: "token",
    describe: () => `token (bearer from $${opts.env} → access:${opts.subject})`,
    async verify(req) {
      const auth = header(req.headers, "authorization");
      if (!auth) return FORBIDDEN;
      const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
      if (!m) return FORBIDDEN;
      return secretsEqual(m[1], opts.token) ? { ok: true, identity: { sub: opts.subject } } : FORBIDDEN;
    },
  };
}

// ── none (loopback only) ─────────────────────────────────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for the v4/v6/mapped loopback addresses node reports on
 *  `socket.remoteAddress`. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr !== undefined && LOOPBACK.has(addr);
}

/**
 * The ONE localhost rule: unset `PUBLIC_BASE_URL` → a localhost deployment;
 * otherwise its host must be `localhost`, `127.0.0.1` or `[::1]` (any port). A
 * malformed value (no scheme, not a URL) is NOT localhost and never throws —
 * boot must not crash on a typo, it must fail closed.
 */
export function isLocalhostBase(publicBaseUrl: string | undefined): boolean {
  if (!publicBaseUrl) return true;
  const hostname = (() => {
    try {
      return new URL(publicBaseUrl).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  })();
  return hostname !== undefined && LOCALHOST_HOSTS.has(hostname);
}

export const LOOPBACK_ONLY_BODY = "dashboard auth is none: served to loopback callers on a localhost deployment only";

/**
 * The no-credential strategy. Its one rule: the request must arrive on a
 * loopback socket AND the deployment must be localhost (`PUBLIC_BASE_URL` unset
 * or naming localhost). A remote caller, or any caller of a deployment that
 * has a public address, is refused with 403 — `none` is a local developer's
 * setting, never an open dashboard. The identity is the local operator
 * `access:loopback`.
 */
export function loopbackVerifier(publicBaseUrl: string | undefined): DashboardVerifier {
  const localDeployment = isLocalhostBase(publicBaseUrl);
  return {
    mode: "none",
    describe: () => "none (no credential — loopback callers on a localhost deployment only)",
    async verify(req) {
      if (!localDeployment || !isLoopbackAddress(req.socket?.remoteAddress)) {
        return { ok: false, status: 403, body: LOOPBACK_ONLY_BODY };
      }
      return { ok: true, identity: { sub: LOOPBACK_SUBJECT } };
    },
  };
}

// ── composition ──────────────────────────────────────────────────────────────

export interface BuildDashboardVerifierInputs {
  dashboard: DashboardConfig | undefined;
  /** `parseAccessConfig(env)`: null when ACCESS_TEAM_DOMAIN / ACCESS_AUD are not both set. */
  access: AccessConfig | null;
  env: NodeJS.ProcessEnv;
  /** The JWT verifier's deps (JWKS fetcher, clock, shared cache) for `access`. */
  verify: VerifyDeps;
  publicBaseUrl: string | undefined;
}

/**
 * Compose the configured strategy from config + environment, failing fast by
 * name on a strategy whose inputs are missing: `access` without ACCESS_*,
 * `token` without its env var or actor, an explicit `none` on a deployment
 * with a public address (it would refuse every request — say so at boot, not
 * one 403 at a time). The implicit `none` (no key, no ACCESS_*) never throws:
 * a deployed installation that never configured the dashboard boots and, with
 * its public PUBLIC_BASE_URL, refuses every request exactly as before; only a
 * localhost deployment now admits its loopback callers without a variable.
 */
export function buildDashboardVerifier(inputs: BuildDashboardVerifierInputs): DashboardVerifier {
  const { dashboard, access, env, publicBaseUrl } = inputs;
  const mode = resolveDashboardAuthMode(dashboard?.auth, access !== null);
  switch (mode) {
    case "access": {
      if (!access) {
        throw new Error(
          "dashboard.auth is access but ACCESS_TEAM_DOMAIN and ACCESS_AUD are not both set — set them, or choose token or none",
        );
      }
      return accessVerifier(access, inputs.verify);
    }
    case "token": {
      const envName = dashboard?.token?.env ?? DEFAULT_DASHBOARD_TOKEN_ENV;
      const actor = dashboard?.token?.actor;
      const subject = actor === undefined ? undefined : tokenSubjectOf(actor);
      if (subject === undefined) {
        throw new Error("dashboard.auth is token: dashboard.token.actor must name the bearer's actor as access:<name>");
      }
      const token = (env[envName] ?? "").trim();
      if (token === "") throw new Error(`dashboard.auth is token but ${envName} is not set`);
      return tokenVerifier({ token, env: envName, subject });
    }
    case "none": {
      if (dashboard?.auth === "none" && !isLocalhostBase(publicBaseUrl)) {
        throw new Error(
          `dashboard.auth is none, which serves loopback callers on a localhost deployment only, but PUBLIC_BASE_URL is ${publicBaseUrl} — choose access or token`,
        );
      }
      return loopbackVerifier(publicBaseUrl);
    }
  }
}
