import type { Clock } from "../../core/trace/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import type { LinearStore } from "./store.js";

export const LINEAR_AUTHORIZE_PATH = "/oauth/linear/authorize";
export const LINEAR_CALLBACK_PATH = "/oauth/linear/callback";
const STATE_TTL_MS = LINEAR_TIMING.oauthStateMs;
const REFRESH_MARGIN_MS = LINEAR_TIMING.refreshMarginMs;
const TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

interface TokenDeps {
  clientId: string;
  clientSecret: string;
  store: LinearStore;
  fetch: typeof fetch;
  clock: Clock;
}

export interface LinearOAuthDeps extends TokenDeps {
  /** Configured by the operator, not inferred from Host or query parameters. */
  baseUrl: string;
  /** Optional installation allowlist for deployments dedicated to one workspace. */
  organizationId?: string;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function configuredOrigin(raw: string): URL {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("LINEAR_PUBLIC_BASE_URL must be an HTTPS origin or an HTTP loopback origin");
  }
  return url;
}

/** Never include upstream response bodies: OAuth servers can echo credentials. */
async function exchange(deps: TokenDeps, fields: Record<string, string>) {
  const response = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: deps.clientId, client_secret: deps.clientSecret }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`linear_token_exchange_${response.status}`);
  const token = object(await response.json());
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    typeof token.refresh_token !== "string" ||
    !token.refresh_token ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new Error("linear_token_response_invalid");
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: deps.clock() + token.expires_in * 1000,
  };
}

/** OAuth transport shared by the production Worker and the local development host. */
export class LinearOAuth {
  private readonly redirectUri: string;
  private readonly cookieName: string;
  private readonly cookieFlags: string;

  constructor(private readonly deps: LinearOAuthDeps) {
    const origin = configuredOrigin(deps.baseUrl);
    this.redirectUri = new URL(LINEAR_CALLBACK_PATH, origin).href;
    const secure = origin.protocol === "https:";
    this.cookieName = secure ? "__Host-linear-oauth" : "linear-oauth";
    this.cookieFlags = `Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax`;
  }

  private answer(status: number, body: string, clearCookie = false): Response {
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        ...(clearCookie ? { "set-cookie": `${this.cookieName}=; Max-Age=0; ${this.cookieFlags}` } : {}),
      },
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== LINEAR_AUTHORIZE_PATH && url.pathname !== LINEAR_CALLBACK_PATH)
      return this.answer(404, "Not found");
    if (request.method !== "GET") return this.answer(405, "Method not allowed");
    if (url.pathname === LINEAR_AUTHORIZE_PATH) return this.authorize();
    return this.callback(request, url);
  }

  private async authorize(): Promise<Response> {
    const state = random();
    const verifier = random();
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    await this.deps.store.putState(state, {
      verifier,
      redirectUri: this.redirectUri,
      expiresAt: this.deps.clock() + STATE_TTL_MS,
    });
    const url = new URL("https://linear.app/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.deps.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      actor: "app",
      scope: "read,write,app:assignable,app:mentionable",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "consent",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        location: url.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "set-cookie": `${this.cookieName}=${state}; Max-Age=${STATE_TTL_MS / 1000}; ${this.cookieFlags}`,
      },
    });
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    const state = url.searchParams.get("state");
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.cookieName}=`))
      ?.slice(this.cookieName.length + 1);
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || cookie !== state)
      return this.answer(400, "Invalid OAuth state.");
    const pending = await this.deps.store.takeState(state);
    if (!pending || pending.expiresAt <= this.deps.clock() || pending.redirectUri !== this.redirectUri)
      return this.answer(400, "Invalid OAuth state.", true);
    if (url.searchParams.has("error")) return this.answer(400, "Linear authorization was not completed.", true);
    const code = url.searchParams.get("code");
    if (!code) return this.answer(400, "Missing authorization code.", true);
    try {
      const tokens = await exchange(this.deps, {
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        code_verifier: pending.verifier,
      });
      const response = await this.deps.fetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify({ query: "query SwitchboardInstallation { viewer { id } organization { id } }" }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("linear_identity_failed");
      const payload = object(await response.json());
      const data = object(payload.data);
      const appUserId = object(data.viewer).id;
      const organizationId = object(data.organization).id;
      if (
        payload.errors ||
        typeof appUserId !== "string" ||
        !appUserId ||
        typeof organizationId !== "string" ||
        !organizationId
      )
        throw new Error("linear_identity_invalid");
      if (this.deps.organizationId && organizationId !== this.deps.organizationId)
        return this.answer(403, "This Linear workspace is not enabled for this deployment.", true);
      await this.deps.store.putInstallation({ organizationId, appUserId, ...tokens, version: random() });
      return this.answer(200, "Switchboard is connected to Linear. You can close this window.", true);
    } catch {
      return this.answer(502, "Linear installation failed. Start the installation again.", true);
    }
  }
}

/** One provider per durable installation host; concurrent callers share a refresh. */
export class LinearTokenProvider {
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly deps: TokenDeps) {}

  accessToken(organizationId: string): Promise<string> {
    const pending = this.pending.get(organizationId);
    if (pending) return pending;
    const work = this.read(organizationId).finally(() => {
      this.pending.delete(organizationId);
    });
    this.pending.set(organizationId, work);
    return work;
  }

  private async read(organizationId: string): Promise<string> {
    const current = await this.deps.store.getInstallation(organizationId);
    if (!current) throw new Error("linear_not_installed");
    if (current.expiresAt - this.deps.clock() > REFRESH_MARGIN_MS) return current.accessToken;
    const tokens = await exchange(this.deps, { grant_type: "refresh_token", refresh_token: current.refreshToken });
    const next = { ...current, ...tokens, version: random() };
    if (!(await this.deps.store.replaceInstallation(organizationId, current.version, next)))
      throw new Error("linear_installation_changed");
    return next.accessToken;
  }
}
