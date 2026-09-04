import { assertUrlAllowed, type FetchLike } from "../tools/web.js";
import { MCP_PROTOCOL_VERSION } from "./client.js";
import type { McpAuthKind } from "./registry.js";

// OAuth 2.1 for external MCP servers (features/mcp-tools.md item 18). Every
// step is a deterministic HTTP exchange the SERVICE drives — the browser only
// ever visits the authorization endpoint and comes back to our callback; no
// model is involved and no token travels through chat. The pieces:
//
//   detectAuth        — one unauthenticated `initialize`: 2xx → `none`; 401/403
//                       with discoverable OAuth metadata → `oauth`; 401/403
//                       without → `bearer`. What `mcp add` runs when `--auth`
//                       is not given.
//   discover          — RFC 9728 protected-resource metadata (the
//                       `WWW-Authenticate: resource_metadata` hint first, then
//                       the well-known candidates) → the authorization server →
//                       RFC 8414 / OIDC metadata → endpoints + scopes.
//   registerClient    — RFC 7591 dynamic client registration, public client
//                       (`token_endpoint_auth_method: none`), our callback as
//                       the only redirect URI.
//   pkce / authorizationUrl — S256, `state` carrying the ticket nonce.
//   exchangeCode / refresh  — the token endpoint, form-encoded, RFC 8707
//                       `resource` on both.
//
// Every URL (metadata, endpoints) passes `assertUrlAllowed` (SSRF) and must be
// https; every response body is size-capped and parsed strictly. Errors are
// `OAuthError`s with a sentence the connect page can show.

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface OAuthDiscovery {
  /** The MCP server URL as the protected resource (RFC 8707 `resource`). */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** From the resource metadata (preferred) or the server metadata. */
  scopes?: string[];
}

/** What the ticket carries between the redirect and the callback — sealed at rest. */
export interface OAuthPending {
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  scope?: string;
}

/** The stored credential (sealed JSON). A bearer credential is the raw token
 *  string; `parseStoredCredential` tells them apart. */
export interface OAuthCredential {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server sent no `expires_in`. */
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
  scope?: string;
}

export type StoredCredential = { kind: "bearer"; token: string } | OAuthCredential;

export function parseStoredCredential(plaintext: string): StoredCredential {
  if (plaintext.startsWith("{")) {
    try {
      const v = JSON.parse(plaintext) as unknown;
      if (isOAuthCredential(v)) return v;
    } catch {
      // a bearer token that happens to start with "{" — fall through
    }
  }
  return { kind: "bearer", token: plaintext };
}

export function isOAuthCredential(v: unknown): v is OAuthCredential {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    c.kind === "oauth" &&
    str(c.accessToken) &&
    (c.refreshToken === undefined || str(c.refreshToken)) &&
    (c.expiresAt === undefined || (typeof c.expiresAt === "number" && Number.isFinite(c.expiresAt))) &&
    str(c.clientId) &&
    (c.clientSecret === undefined || str(c.clientSecret)) &&
    str(c.tokenEndpoint) &&
    str(c.resource) &&
    (c.scope === undefined || typeof c.scope === "string")
  );
}

export function isOAuthPending(v: unknown): v is OAuthPending {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return str(p.state) && str(p.codeVerifier) && str(p.clientId) && (p.clientSecret === undefined || str(p.clientSecret)) && str(p.tokenEndpoint) && str(p.redirectUri) && str(p.resource) && (p.scope === undefined || typeof p.scope === "string");
}

const str = (v: unknown, max = 8_192): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Bodies we parse (metadata, registration, tokens) are small; anything past
 *  this is not a well-behaved server. */
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
/** Refresh this long before the access token expires, so a run never starts on
 *  a token that dies mid-call. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;
/** The longest `expires_in` we believe (30 days): anything past it is clamped,
 *  so a server's typo cannot make a token immortal. */
export const OAUTH_MAX_EXPIRES_IN_MS = 30 * 24 * 3600_000;

// ---- detection ----------------------------------------------------------------

export type DetectedAuth = { auth: "none" } | { auth: "bearer" } | { auth: "oauth"; discovery: OAuthDiscovery };

/** One unauthenticated `initialize` decides how the server authenticates. A
 *  server that cannot be reached, or answers anything but 2xx/401/403, is an
 *  error — `mcp add` then asks for an explicit `--auth`. */
export async function detectAuth(fetchImpl: FetchLike, serverUrl: string): Promise<DetectedAuth> {
  assertUrlAllowed(serverUrl);
  let res: Response;
  try {
    res = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "switchboard", version: "0" } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(`the server could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.ok || res.status === 202) return { auth: "none" };
  if (res.status !== 401 && res.status !== 403) throw new OAuthError(`the server answered HTTP ${res.status} to an unauthenticated initialize; pass --auth explicitly`);
  const hinted = resourceMetadataHint(res.headers.get("www-authenticate"));
  try {
    return { auth: "oauth", discovery: await discover(fetchImpl, serverUrl, hinted) };
  } catch (err) {
    if (err instanceof NoOAuthMetadata) return { auth: "bearer" };
    throw err;
  }
}

/** `WWW-Authenticate: Bearer …, resource_metadata="https://…"` → the URL. */
export function resourceMetadataHint(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header) ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(header);
  return m?.[1];
}

// ---- discovery ------------------------------------------------------------------

/** "No OAuth metadata anywhere" — distinct from a fault, so detection can fall back to `bearer`. */
class NoOAuthMetadata extends OAuthError {}

const PRM_SUFFIX = "/.well-known/oauth-protected-resource";
const AS_SUFFIX = "/.well-known/oauth-authorization-server";
const OIDC_SUFFIX = "/.well-known/openid-configuration";

/** RFC 8414 §3 (path inserted after the host) first, then the root form. */
function wellKnownCandidates(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  const out = [`${base.origin}${suffix}${path}`];
  if (path) out.push(`${base.origin}${suffix}`);
  return out;
}

export async function discover(fetchImpl: FetchLike, serverUrl: string, hintedMetadataUrl?: string): Promise<OAuthDiscovery> {
  const server = assertUrlAllowed(serverUrl);
  const resource = `${server.origin}${server.pathname.replace(/\/+$/, "")}`;
  const candidates = [...(hintedMetadataUrl ? [hintedMetadataUrl] : []), ...wellKnownCandidates(server, PRM_SUFFIX)];
  let prm: Record<string, unknown> | undefined;
  for (const url of candidates) {
    prm = await getJson(fetchImpl, url, "resource metadata");
    if (prm) break;
  }
  // The MCP spec lets a server skip RFC 9728 and BE its own authorization server.
  const authServers = prm && Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === "string") : [];
  const asBase = assertHttpsUrl(authServers[0] ?? `${server.origin}`, "authorization server");
  let meta: Record<string, unknown> | undefined;
  for (const url of [...wellKnownCandidates(asBase, AS_SUFFIX), ...wellKnownCandidates(asBase, OIDC_SUFFIX)]) {
    meta = await getJson(fetchImpl, url, "authorization server metadata");
    if (meta) break;
  }
  if (!meta) throw new NoOAuthMetadata(`no OAuth metadata at ${asBase.origin} (RFC 8414 / OpenID discovery)`);
  const authorizationEndpoint = endpoint(meta.authorization_endpoint, "authorization_endpoint");
  const tokenEndpoint = endpoint(meta.token_endpoint, "token_endpoint");
  const registrationEndpoint = meta.registration_endpoint === undefined ? undefined : endpoint(meta.registration_endpoint, "registration_endpoint");
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : undefined;
  if (methods && !methods.includes("S256")) throw new OAuthError("the authorization server does not support PKCE S256");
  const grants = Array.isArray(meta.grant_types_supported) ? meta.grant_types_supported : undefined;
  if (grants && !grants.includes("authorization_code")) throw new OAuthError("the authorization server does not offer the authorization_code grant");
  const scopes = strList(prm?.scopes_supported) ?? strList(meta.scopes_supported);
  return {
    resource,
    issuer: typeof meta.issuer === "string" ? meta.issuer : asBase.origin,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}

function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 256) : undefined;
}

function endpoint(v: unknown, name: string): string {
  if (typeof v !== "string") throw new OAuthError(`authorization server metadata has no ${name}`);
  return assertHttpsUrl(v, name).toString();
}

function assertHttpsUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = assertUrlAllowed(raw);
  } catch (err) {
    throw new OAuthError(`${what}: ${err instanceof Error ? err.message : "not an http(s) URL"}`);
  }
  if (u.protocol !== "https:") throw new OAuthError(`${what} must be https`);
  return u;
}

/** GET a JSON document; `undefined` when the server has none there (404/410 or
 *  a non-JSON answer), a thrown error when it could not be reached. */
async function getJson(fetchImpl: FetchLike, url: string, what: string): Promise<Record<string, unknown> | undefined> {
  try {
    assertUrlAllowed(url);
  } catch {
    return undefined;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new OAuthError(`${what} at ${url} could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const parsed = await readJson(res);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await readCapped(res);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OAuthError(`response larger than ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

// ---- registration -------------------------------------------------------------------

export const OAUTH_CLIENT_NAME = "Switchboard";

/** RFC 7591: a public client with our callback as its only redirect URI. A
 *  server without a registration endpoint cannot be connected self-serve. */
export async function registerClient(fetchImpl: FetchLike, discovery: OAuthDiscovery, redirectUri: string, clientUri?: string): Promise<{ clientId: string; clientSecret?: string }> {
  if (!discovery.registrationEndpoint) throw new OAuthError("the authorization server does not offer dynamic client registration; Switchboard cannot register itself");
  let res: Response;
  try {
    res = await fetchImpl(discovery.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: OAUTH_CLIENT_NAME,
        ...(clientUri ? { client_uri: clientUri } : {}),
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(discovery.scopes ? { scope: discovery.scopes.join(" ") } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(`client registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await readJson(res)) as Record<string, unknown> | undefined;
  if (!res.ok || !body || !str(body.client_id, 1024)) {
    throw new OAuthError(`client registration was refused (HTTP ${res.status}${body && typeof body.error === "string" ? `, ${body.error}` : ""})`);
  }
  return { clientId: body.client_id, ...(str(body.client_secret, 4096) ? { clientSecret: body.client_secret } : {}) };
}

// ---- PKCE + the authorization request ------------------------------------------------

/** RFC 7636: a 43-char base64url verifier and its S256 challenge. */
export async function pkce(random: (bytes: number) => Uint8Array = randomBytes): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(random(32));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** `state` = `<nonce>.<random>`: the callback finds the ticket by the nonce and
 *  the sealed pending record proves the random half. */
export function oauthState(nonce: string, random: (bytes: number) => Uint8Array = randomBytes): string {
  return `${nonce}.${b64url(random(24))}`;
}

export function nonceOfState(state: string): string | undefined {
  const dot = state.indexOf(".");
  return dot > 0 ? state.slice(0, dot) : undefined;
}

export function authorizationUrl(discovery: OAuthDiscovery, pending: OAuthPending, challenge: string): string {
  const u = new URL(discovery.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", pending.clientId);
  u.searchParams.set("redirect_uri", pending.redirectUri);
  u.searchParams.set("state", pending.state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", pending.resource);
  if (pending.scope) u.searchParams.set("scope", pending.scope);
  return u.toString();
}

// ---- the token endpoint ---------------------------------------------------------------

export async function exchangeCode(fetchImpl: FetchLike, pending: OAuthPending, code: string, now: number): Promise<OAuthCredential> {
  const tokens = await tokenRequest(fetchImpl, pending.tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
    code_verifier: pending.codeVerifier,
    resource: pending.resource,
  });
  return credentialFrom(tokens, { clientId: pending.clientId, clientSecret: pending.clientSecret, tokenEndpoint: pending.tokenEndpoint, resource: pending.resource, scope: pending.scope }, now);
}

/** Whether `specFor` must refresh before handing the token to a run. */
export function needsRefresh(cred: OAuthCredential, now: number): boolean {
  return cred.expiresAt !== undefined && now >= cred.expiresAt - OAUTH_REFRESH_SKEW_MS;
}

export async function refreshCredential(fetchImpl: FetchLike, cred: OAuthCredential, now: number): Promise<OAuthCredential> {
  if (!cred.refreshToken) throw new OAuthError("the access token expired and the server issued no refresh token — run `mcp connect` to sign in again");
  const tokens = await tokenRequest(fetchImpl, cred.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: cred.refreshToken,
    client_id: cred.clientId,
    ...(cred.clientSecret ? { client_secret: cred.clientSecret } : {}),
    resource: cred.resource,
  });
  // A server that rotates refresh tokens sends a new one; one that does not
  // keeps the old one valid.
  return { ...credentialFrom(tokens, cred, now), refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : cred.refreshToken };
}

async function tokenRequest(fetchImpl: FetchLike, tokenEndpoint: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  assertHttpsUrl(tokenEndpoint, "token endpoint");
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OAuthError(`the token endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await readJson(res)) as Record<string, unknown> | undefined;
  if (!res.ok || !body) {
    const why = body && typeof body.error === "string" ? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}` : `HTTP ${res.status}`;
    throw new OAuthError(`the token endpoint refused the request (${why})`);
  }
  return body;
}

function credentialFrom(tokens: Record<string, unknown>, base: { clientId: string; clientSecret?: string; tokenEndpoint: string; resource: string; scope?: string }, now: number): OAuthCredential {
  if (!str(tokens.access_token)) throw new OAuthError("the token endpoint returned no access token");
  const type = typeof tokens.token_type === "string" ? tokens.token_type.toLowerCase() : "bearer";
  if (type !== "bearer") throw new OAuthError(`the token endpoint issued a "${type}" token; only bearer tokens can be sent to an MCP server`);
  const expiresInMs = expiresInOf(tokens.expires_in);
  return {
    kind: "oauth",
    accessToken: tokens.access_token,
    ...(str(tokens.refresh_token) ? { refreshToken: tokens.refresh_token } : {}),
    ...(expiresInMs !== undefined ? { expiresAt: now + expiresInMs } : {}),
    clientId: base.clientId,
    ...(base.clientSecret ? { clientSecret: base.clientSecret } : {}),
    tokenEndpoint: base.tokenEndpoint,
    resource: base.resource,
    ...(typeof tokens.scope === "string" ? { scope: tokens.scope } : base.scope ? { scope: base.scope } : {}),
  };
}

/** RFC 6749 `expires_in` (seconds, a number or a digit string) → ms, range-
 *  checked: absent or unparseable → `undefined` (no expiry known); zero or
 *  negative → the server issued a dead token, refused; past the cap → clamped. */
function expiresInOf(v: unknown): number | undefined {
  const seconds = typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : undefined;
  if (seconds === undefined) return undefined;
  if (seconds <= 0) throw new OAuthError(`the token endpoint issued an already expired token (expires_in ${seconds})`);
  return Math.min(seconds * 1000, OAUTH_MAX_EXPIRES_IN_MS);
}

// ---- helpers ----------------------------------------------------------------------------

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The auth kinds `mcp add --auth` accepts, in the order help lists them. */
export const MCP_AUTH_KINDS: readonly McpAuthKind[] = ["oauth", "bearer", "none"];
