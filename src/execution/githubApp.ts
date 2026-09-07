import { createSign } from "node:crypto";
import { BASH_TIMEOUT_MAX_MS } from "./bashTimeout.js";

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
// Env vars (all three required to activate; otherwise GH_TOKEN is used as-is):
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
//             agent): it can read/clone a private repo and read its PRs, but
//             physically CANNOT comment, review, push, or otherwise write —
//             even if the model or a prompt-injected diff tries. This closes
//             the double-post / injection hole at the token, not the prompt.
export type GithubTokenScope = "write" | "read";

// Subset of the installation's permissions for a read-scoped token: enough for
// `gh pr view`/`gh pr diff` and `git clone`/checkout on a PRIVATE repo, nothing
// that writes. contents:read → clone/checkout; pull_requests:read → PR
// metadata + diff; issues:read → the `github_issue_list/get` tools
// (features/github-tools.md) on the read path; metadata:read → always
// required by GitHub.
const READ_ONLY_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  issues: "read",
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
 *  Why not "5 minutes before expiry" (the original rule): 2026-09-07, review
 *  of #521 — the cache handed a token minted 51 minutes earlier to a run whose
 *  first command then ran for the full 20-minute ceiling; the token expired
 *  under it and every later command in the run got `401 Bad credentials`. */
export const TOKEN_REUSE_MARGIN_MS = BASH_TIMEOUT_MAX_MS + 5 * 60_000;

export function githubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID,
  );
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
export async function resolveGithubToken(scope: GithubTokenScope = "write"): Promise<string | null> {
  if (githubAppConfigured()) return mintInstallationToken(scope);
  return process.env.GH_TOKEN ?? null;
}

async function mintInstallationToken(scope: GithubTokenScope): Promise<string> {
  // Reuse only while the token outlives the longest possible command; the
  // executors call this per command, so no run is ever pinned to one token.
  const cached = cache.get(scope);
  if (cached && Date.now() < cached.expiresAtMs - TOKEN_REUSE_MARGIN_MS) return cached.token;

  const appId = process.env.GITHUB_APP_ID!;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID!;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");

  // A read-scoped token requests a permissions subset; the write scope omits
  // the field to receive the full installation grant (unchanged behavior).
  const body = scope === "read" ? JSON.stringify({ permissions: READ_ONLY_PERMISSIONS }) : undefined;
  const headers: Record<string, string> = {
    authorization: `Bearer ${appJwt(appId, privateKey)}`,
    accept: "application/vnd.github+json",
    "user-agent": "switchboard",
  };
  if (body) headers["content-type"] = "application/json";

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers,
    ...(body ? { body } : {}),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`GitHub App token mint failed: HTTP ${res.status} ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  cache.set(scope, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
  return data.token;
}

/** Short-lived RS256 JWT proving we are the app (max 10 min per GitHub docs). */
function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s to absorb clock drift
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}
