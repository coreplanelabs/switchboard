import { createSign } from "node:crypto";
import { redactAndCap } from "../core/redact.js";
import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";
import { systemClock } from "../core/trace/clock.js";
import { tracedFetch } from "../core/trace/tracedFetch.js";
import type { Span } from "../core/trace/types.js";
import { processSecrets, type Secret } from "../secrets.js";

// GitHub App authentication: the idiomatic org-owned bot identity.
// No machine user, no seat, no long-lived PAT. The bot holds the app's
// private key and mints 1-hour installation tokens on demand; the token is
// injected into sandboxes as GH_TOKEN, where gh and git (via the credential
// helper) accept it exactly like a PAT. PRs are authored as <app-name>[bot].
//
// Freshness contract: a token is handed out only while it has at least
// TOKEN_REUSE_MARGIN_MS to live, and the sandbox executors ask for it per
// COMMAND (resolveEnvs), never once per run — so a command that starts on a
// token always finishes on it, however long the run has been going.
//
// Secrets (all three required to activate; otherwise GH_TOKEN is used as-is),
// each read through src/secrets.ts and revealed only into the JWT, the mint URL
// and the Authorization header:
//   GITHUB_APP_ID               numeric app id
//   GITHUB_APP_PRIVATE_KEY      PEM; literal "\n" sequences are unescaped
//   GITHUB_APP_INSTALLATION_ID  from the install URL: .../installations/<id>

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Token scope decides the installation token's permissions at mint time:
//   "write" — the full installation grant (coding agent, and the bot process's
//             deterministic review post via githubComments.ts).
//   "read"  — least-privilege for a read-only agent's SANDBOX (the review
//             agent): it can read/clone a private repo and read its PRs,
//             issues and CI results, but physically CANNOT comment, review,
//             push, or otherwise write — even if the model or a
//             prompt-injected diff tries. This closes the double-post /
//             injection hole at the token, not the prompt.
export type GithubTokenScope = "write" | "read";

// Subset of the installation's permissions for a read-scoped token: enough to
// clone and read a PRIVATE repo, its PRs and issues, and its CI results —
// nothing that writes. Every value is "read"; GitHub refuses a request for a
// permission the installation does not hold, so each of these must stay in the
// App's grant (docs/reference/specs/execution.md item 5).
//   contents:read      → `git clone`/checkout, file reads at any ref.
//   pull_requests:read → `gh pr view`/`gh pr diff`, PR metadata and reviews.
//   issues:read        → the `github_issue_list/get` tools
//                        (docs/reference/specs/github-tools.md) on the read path.
//   actions:read       → workflow runs, jobs and their logs, the Actions cache
//                        list (`gh run list/view --log`, `gh cache list`), so a
//                        review can read why CI is red instead of guessing.
//   checks:read        → check-runs and check-suites on a commit (the PR's
//                        checks tab; `gh pr checks` reads these).
//   metadata:read      → always required by GitHub for any installation token.
// Not requested: `statuses` (the legacy commit-status API — GitHub Actions
// reports through check-runs, so a repository built on Actions never needs it;
// one whose CI posts commit statuses instead would need it added here for those
// rows to show in `gh pr checks`); `workflows` (that grant only exists as
// write: editing workflow files is a push, which contents:read already forbids).
const READ_ONLY_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  issues: "read",
  actions: "read",
  checks: "read",
  metadata: "read",
} as const;

// One cache slot per scope: a write token must never be handed out where a read
// token was requested (or vice-versa), so they can't share a slot.
const cache = new Map<GithubTokenScope, CachedToken>();

/** A cached token is reused only while it has at least this long to live: the
 *  longest single command a caller can run (BASH_TIMEOUT_MAX_MS) plus slack
 *  for the exec transport and clock skew. Anything shorter re-mints. With
 *  1-hour tokens that is one mint per ~35 minutes per scope.
 *
 *  Why not a fixed "5 minutes before expiry": a token handed out with, say,
 *  9 minutes left to a command that runs for the full 20-minute ceiling
 *  expires under it, and every later command in the run gets `401 Bad
 *  credentials`. A command that STARTS on a token must FINISH on it. */
export const TOKEN_REUSE_MARGIN_MS = BASH_TIMEOUT_MAX_MS + 5 * 60_000;

/** The App triple, wrapped; undefined unless all three are set. */
function appCredentials(): { appId: Secret; privateKey: Secret; installationId: Secret } | undefined {
  const appId = processSecrets.get("GITHUB_APP_ID");
  const privateKey = processSecrets.get("GITHUB_APP_PRIVATE_KEY");
  const installationId = processSecrets.get("GITHUB_APP_INSTALLATION_ID");
  return appId && privateKey && installationId ? { appId, privateKey, installationId } : undefined;
}

export function githubAppConfigured(): boolean {
  return appCredentials() !== undefined;
}

/**
 * Resolve the GitHub credential to inject into sandboxes:
 * a freshly-minted installation token when a GitHub App is configured,
 * else the static GH_TOKEN, else null (agents without GitHub needs).
 *
 * `scope` (default "write") selects the minted token's permissions — pass
 * "read" for a read-only agent's sandbox so it cannot write from inside.
 * NOTE: the static GH_TOKEN fallback cannot be scoped down (it's an opaque PAT),
 * so least-privilege for the review sandbox requires the GitHub App — the
 * production configuration.
 */
export async function resolveGithubToken(scope: GithubTokenScope = "write", span?: Span): Promise<string | null> {
  if (githubAppConfigured()) return mintInstallationToken(scope, span);
  // Revealed here: the caller's contract is the credential itself (a sandbox env, a header).
  return processSecrets.get("GH_TOKEN")?.reveal() ?? null;
}

/** The GitHub user this process acts as: what its commits, PRs and comments are attributed to. */
export interface GithubIdentity {
  /** `<app-slug>[bot]` for a GitHub App; the account's login for a static token. */
  login: string;
  /** The immutable numeric user id — matched alongside the login, which can be renamed. */
  id: number;
}

let identity: Promise<GithubIdentity | undefined> | undefined;

/**
 * Resolve the GitHub identity this process acts as — the App's bot user
 * (`GET /app` for the slug, then the `<slug>[bot]` user) when a GitHub App is
 * configured, else the static GH_TOKEN's user (`GET /user`), else undefined.
 * Nothing in the code names an installation's bot: ship compares a PR's author
 * against THIS (agent-ship.md item 10), so the same image serves every
 * installation. Resolved once per process (an identity does not change); a
 * failed lookup answers undefined once and is retried on the next call.
 */
export function resolveGithubIdentity(): Promise<GithubIdentity | undefined> {
  identity ??= lookupIdentity().catch((err) => {
    console.warn(`[github] identity lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    identity = undefined;
    return undefined;
  });
  return identity;
}

async function lookupIdentity(): Promise<GithubIdentity | undefined> {
  const credentials = appCredentials();
  if (credentials) {
    const app = (await githubJson("https://api.github.com/app", appJwt(credentials))) as { slug?: string };
    if (typeof app.slug !== "string" || app.slug === "") throw new Error("GET /app answered without a slug");
    const login = `${app.slug}[bot]`;
    const user = (await githubJson(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      await mintInstallationToken("read"),
    )) as { login?: string; id?: number };
    if (typeof user.id !== "number") throw new Error(`GET /users/${login} answered without an id`);
    return { login: typeof user.login === "string" ? user.login : login, id: user.id };
  }
  const staticToken = processSecrets.get("GH_TOKEN");
  if (staticToken) {
    const user = (await githubJson("https://api.github.com/user", staticToken.reveal())) as {
      login?: string;
      id?: number;
    };
    if (typeof user.login !== "string" || typeof user.id !== "number")
      throw new Error("GET /user answered without login and id");
    return { login: user.login, id: user.id };
  }
  return undefined;
}

async function githubJson(url: string, bearer: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/vnd.github+json", "user-agent": "switchboard" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url.replace("https://api.github.com", "")}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** The mint as the caller's `github.token_mint` child when it has a span
 *  (docs/reference/specs/tracing.md item 23): `scope`, whether the cache answered, and how
 *  long the token lives. Without a span the same work, unmeasured. */
async function mintInstallationToken(scope: GithubTokenScope, span?: Span): Promise<string> {
  if (!span) return mintCore(scope);
  return span.span("github.token_mint", (s) => mintCore(scope, s), { attrs: { scope } });
}

async function mintCore(scope: GithubTokenScope, span?: Span): Promise<string> {
  // Reuse only while the token outlives the longest possible command; the
  // executors call this per command, so no run is ever pinned to one token.
  const cached = cache.get(scope);
  if (cached && systemClock() < cached.expiresAtMs - TOKEN_REUSE_MARGIN_MS) {
    span?.setAttrs({ cached: true, expiresInMs: cached.expiresAtMs - systemClock() });
    return cached.token;
  }

  const credentials = appCredentials();
  if (!credentials) throw new Error("GitHub App token mint: the App is not configured");

  // A read-scoped token requests a permissions subset; the write scope omits
  // the field to receive the full installation grant (unchanged behavior).
  const body = scope === "read" ? JSON.stringify({ permissions: READ_ONLY_PERMISSIONS }) : undefined;
  const headers: Record<string, string> = {
    authorization: `Bearer ${appJwt(credentials)}`,
    accept: "application/vnd.github+json",
    "user-agent": "switchboard",
  };
  if (body) headers["content-type"] = "application/json";

  // One `github.rest` child under the mint (never a `traceparent`: GitHub is not one of our hosts).
  const res = await tracedFetch(
    span,
    `https://api.github.com/app/installations/${credentials.installationId.reveal()}/access_tokens`,
    { method: "POST", headers, ...(body ? { body } : {}) },
    { route: "app_installation_token", name: "github.rest" },
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`GitHub App token mint failed: HTTP ${res.status} ${redactAndCap(errBody, 300)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  const expiresAtMs = Date.parse(data.expires_at);
  cache.set(scope, { token: data.token, expiresAtMs });
  span?.setAttrs({ cached: false, expiresInMs: expiresAtMs - systemClock() });
  return data.token;
}

/** Short-lived RS256 JWT proving we are the app (max 10 min per GitHub docs). The
 *  key and the id are revealed here, into the signer and the claims, and nowhere else. */
function appJwt(credentials: { appId: Secret; privateKey: Secret }): string {
  const now = Math.floor(systemClock() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s to absorb clock drift
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: credentials.appId.reveal() }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  // A PEM pasted into an env file arrives with literal "\n" sequences; unescape them.
  const pem = credentials.privateKey.reveal().replace(/\\n/g, "\n");
  const signature = signer.sign(pem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}
