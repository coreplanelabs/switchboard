import { createSign } from "node:crypto";

// GitHub App authentication: the idiomatic org-owned bot identity.
// No machine user, no seat, no long-lived PAT. The bot holds the app's
// private key and mints 1-hour installation tokens on demand; the token is
// injected into sandboxes as GH_TOKEN, where gh and git (via the credential
// helper) accept it exactly like a PAT. PRs are authored as <app-name>[bot].
//
// Env vars (all three required to activate; otherwise GH_TOKEN is used as-is):
//   GITHUB_APP_ID               numeric app id
//   GITHUB_APP_PRIVATE_KEY      PEM; literal "\n" sequences are unescaped
//   GITHUB_APP_INSTALLATION_ID  from the install URL: .../installations/<id>

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cache: CachedToken | null = null;

export function githubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID,
  );
}

/**
 * Resolve the GitHub credential to inject into sandboxes:
 * a freshly-minted installation token when a GitHub App is configured,
 * else the static GH_TOKEN, else null (agents without GitHub needs).
 */
export async function resolveGithubToken(): Promise<string | null> {
  if (githubAppConfigured()) return mintInstallationToken();
  return process.env.GH_TOKEN ?? null;
}

async function mintInstallationToken(): Promise<string> {
  // Reuse until 5 minutes before expiry — sandbox runs are minutes-long, so a
  // token minted at request start comfortably outlives the run.
  if (cache && Date.now() < cache.expiresAtMs - 5 * 60_000) return cache.token;

  const appId = process.env.GITHUB_APP_ID!;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID!;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(appId, privateKey)}`,
        accept: "application/vnd.github+json",
        "user-agent": "switchboard",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub App token mint failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  cache = { token: data.token, expiresAtMs: Date.parse(data.expires_at) };
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
