import type { FetchLike } from "./client.js";
import { MCP_PROTOCOL_VERSION } from "./client.js";
import type { McpCallResult, McpClient, McpToolInfo } from "./types.js";

// The second McpClient implementation (AGENTS.md invariant 2) and the test
// doubles: `InMemoryMcpClient` serves a fixed tool table with handlers, and
// `fakeMcpServerFetch` is a fetch that speaks Streamable HTTP for the real
// client's own tests (JSON or SSE framing, session ids, error injection).

export interface InMemoryTool extends McpToolInfo {
  handler?: (args: Record<string, unknown>) => Promise<McpCallResult> | McpCallResult;
}

export class InMemoryMcpClient implements McpClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  listCalls = 0;
  /** When set, `listTools` throws with this message (a server down for discovery). */
  failListWith: string | undefined;

  constructor(private readonly tools: InMemoryTool[]) {}

  async listTools(): Promise<McpToolInfo[]> {
    this.listCalls++;
    if (this.failListWith) throw new Error(this.failListWith);
    return this.tools.map(({ handler: _h, ...meta }) => meta);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.calls.push({ name, args });
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
    if (!tool.handler) return { content: [{ type: "text", text: `${name} ok` }] };
    return tool.handler(args);
  }
}

export interface FakeServerOptions {
  tools?: McpToolInfo[];
  /** Answer every `tools/call` with this (or throw a JSON-RPC error via `rpcError`). */
  onCall?: (name: string, args: Record<string, unknown>) => McpCallResult;
  /** Frame responses as SSE instead of JSON. */
  sse?: boolean;
  /** Session id to assign on initialize; requests without it (after init) get 404. */
  sessionId?: string;
  /** Page `tools/list` in chunks of this size. */
  pageSize?: number;
  /** HTTP status to answer with for every request (error injection). */
  status?: number;
  /** JSON-RPC error to answer `tools/call` with. */
  rpcError?: { code: number; message: string };
  /** Return this raw body for the FIRST response (protocol-fault injection). */
  rawFirstBody?: string;
  /** Delay every response by this many ms (timeout tests). */
  delayMs?: number;
  /** Answer with headers but a body that never ends (an SSE stream held open);
   *  the body errors with a TimeoutError when the request signal aborts, as
   *  undici's does. */
  hangBody?: boolean;
  /** After `forgetSessionAfter` requests, the session id stops being valid (404 once). */
  forgetSessionAfter?: number;
}

export interface FakeServer {
  fetch: FetchLike;
  requests: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>;
}

/** A Streamable-HTTP MCP server as a fetch function. */
export function fakeMcpServerFetch(opts: FakeServerOptions = {}): FakeServer {
  const requests: FakeServer["requests"] = [];
  let sessionValid = true;
  let served = 0;
  let first = true;
  const respond = (payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response => {
    const headers = new Headers(init.headers ?? {});
    let body: string;
    if (opts.sse) {
      headers.set("content-type", "text/event-stream");
      body =
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { noise: true } })}\n\n` +
        `data: ${JSON.stringify(payload)}\n\n`;
    } else {
      headers.set("content-type", "application/json");
      body = JSON.stringify(payload);
    }
    return new Response(body, { status: init.status ?? 200, headers });
  };
  const fetch: FetchLike = async (_url, init) => {
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted");
          e.name = "TimeoutError";
          reject(e);
        });
      });
    }
    const headers = lowerHeaders(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ headers, body });
    if (opts.status && opts.status !== 200) return new Response("", { status: opts.status });
    if (opts.hangBody) {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: message\n"));
          signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "TimeoutError";
            controller.error(e);
          });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (first && opts.rawFirstBody !== undefined) {
      first = false;
      return new Response(opts.rawFirstBody, { status: 200, headers: { "content-type": "application/json" } });
    }
    first = false;
    const method = body.method as string;
    const id = body.id as number | undefined;
    if (method === "initialize") {
      sessionValid = true;
      served = 0;
      return respond(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "0" },
          },
        },
        { headers: opts.sessionId ? { "mcp-session-id": opts.sessionId } : {} },
      );
    }
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (opts.sessionId) {
      // The session expires once `forgetSessionAfter` requests have been served
      // on it; the next one is a 404 until the client initializes again.
      if (opts.forgetSessionAfter !== undefined && served >= opts.forgetSessionAfter) sessionValid = false;
      if (headers["mcp-session-id"] !== opts.sessionId || !sessionValid) return new Response("", { status: 404 });
      served++;
    }
    if (method === "tools/list") {
      const all = opts.tools ?? [];
      const size = opts.pageSize ?? all.length;
      const params = (body.params ?? {}) as { cursor?: string };
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return respond({ jsonrpc: "2.0", id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } });
    }
    if (method === "tools/call") {
      if (opts.rpcError) return respond({ jsonrpc: "2.0", id, error: opts.rpcError });
      const params = body.params as { name: string; arguments?: Record<string, unknown> };
      const result = opts.onCall?.(params.name, params.arguments ?? {}) ?? {
        content: [{ type: "text", text: `${params.name} ok` }],
      };
      return respond({ jsonrpc: "2.0", id, result });
    }
    return respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  };
  return { fetch, requests };
}

function lowerHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

// ---- a fake authorization server (item 18) --------------------------------------------
//
// Shaped like Vanta's: RFC 9728 resource metadata at the ROOT well-known path
// (the path-inserted form 404s), RFC 8414 metadata with the path inserted
// after the host, dynamic registration, PKCE S256 checked for real,
// authorization_code + refresh_token, `token_endpoint_auth_methods_supported:
// ["none"]`. There is no browser: a test mints the code the authorization
// endpoint would have redirected with — `issueCode(authorizationUrl)` binds it
// to that request's `code_challenge`, `codeFor(verifier)` to a verifier the
// test picked. Tokens are `at-<n>` / `rt-<n>`; every request is recorded.

export interface FakeAuthorizationServerOptions {
  /** The MCP server URL (the protected resource). */
  server: string;
  /** What the server answers to an unauthenticated initialize (default 401 with a resource_metadata hint). */
  initializeStatus?: number;
  /** No metadata anywhere (a plain bearer server). */
  metadata?: boolean;
  /** The server is its own authorization server: no resource metadata, RFC 8414 at the server's origin. */
  selfIssued?: boolean;
  /** Override the `authorization_servers` list in the resource metadata. */
  authorizationServers?: string[];
  codeChallengeMethods?: string[];
  grantTypes?: string[];
  tokenEndpoint?: string;
  registrationStatus?: number;
  tokenType?: string;
  /** Issue a new refresh token on every refresh. */
  rotateRefresh?: boolean;
  /** Every request fails at the transport. */
  down?: boolean;
  /** `expires_in` on token responses (default 3600). */
  expiresIn?: number;
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export function fakeAuthorizationServer(opts: FakeAuthorizationServerOptions) {
  const server = new URL(opts.server);
  const serverPath = server.pathname.replace(/\/+$/, "");
  const asOrigin = opts.selfIssued ? server.origin : "https://as.example.com";
  const asPath = opts.selfIssued ? "" : "/mcp";
  const tokenEndpoint = opts.tokenEndpoint ?? `${asOrigin}/oauth/token`;
  const calls: FakeCall[] = [];
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: Record<string, string>[] = [];
  /** code → the S256 challenge it was issued for */
  const codes = new Map<string, string>();
  const refreshTokens = new Set<string>(["rt-1"]);
  let issued = 0;
  let tokens = 0;
  let refreshes = 1;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const s256 = async (verifier: string) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    let s = "";
    for (const b of digest) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  /** What the authorization endpoint would redirect with for this request. */
  const issueCode = (authorizationUrl: string): string => {
    const challenge = new URL(authorizationUrl).searchParams.get("code_challenge");
    if (!challenge) throw new Error("authorization URL carries no code_challenge");
    const code = `code-${++issued}`;
    codes.set(code, challenge);
    return code;
  };
  const codeFor = async (verifier: string): Promise<string> => {
    const code = `code-${++issued}`;
    codes.set(code, await s256(verifier));
    return code;
  };

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: input, method, headers, ...(body !== undefined ? { body } : {}) });
    if (opts.down) throw new Error("ECONNREFUSED");
    const u = new URL(input);
    const path = `${u.origin}${u.pathname}`;
    // The MCP server itself.
    if (path === `${server.origin}${serverPath}`) {
      const status = opts.initializeStatus ?? 401;
      if (status >= 200 && status < 300)
        return json(status, {
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } },
        });
      const hint =
        opts.metadata === false || opts.selfIssued
          ? ""
          : `, resource_metadata="${server.origin}/.well-known/oauth-protected-resource"`;
      return json(
        status,
        { error: "invalid_token" },
        status === 401 || status === 403 ? { "www-authenticate": `Bearer error="invalid_token"${hint}` } : {},
      );
    }
    if (opts.metadata === false) return json(404, { error: "not_found" });
    // RFC 9728 — root form only (the path-inserted form is not served, like Vanta).
    if (!opts.selfIssued && path === `${server.origin}/.well-known/oauth-protected-resource`) {
      return json(200, {
        resource: server.origin,
        authorization_servers: opts.authorizationServers ?? [`${asOrigin}${asPath}`],
        scopes_supported: ["mcp-api.all:write"],
      });
    }
    // RFC 8414 — path inserted after the host.
    if (path === `${asOrigin}/.well-known/oauth-authorization-server${asPath}`) {
      return json(200, {
        issuer: `${asOrigin}${asPath}`,
        authorization_endpoint: `${asOrigin}/oauth/authorize`,
        token_endpoint: tokenEndpoint,
        registration_endpoint: `${asOrigin}/oauth/register`,
        scopes_supported: ["mcp-api.all:write"],
        response_types_supported: ["code"],
        grant_types_supported: opts.grantTypes ?? ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: opts.codeChallengeMethods ?? ["S256"],
      });
    }
    if (path === `${asOrigin}/oauth/register`) {
      const req = JSON.parse(body ?? "{}") as Record<string, unknown>;
      registrations.push(req);
      if (opts.registrationStatus && opts.registrationStatus >= 400)
        return json(opts.registrationStatus, { error: "invalid_client_metadata" });
      return json(201, { client_id: "client-1", redirect_uris: req.redirect_uris });
    }
    if (path === tokenEndpoint.replace(/\?.*$/, "")) {
      const form = Object.fromEntries(new URLSearchParams(body ?? "")) as Record<string, string>;
      tokenRequests.push(form);
      const issue = (refresh: string) => {
        tokens += 1;
        return json(200, {
          access_token: `at-${tokens}`,
          token_type: opts.tokenType ?? "Bearer",
          expires_in: opts.expiresIn ?? 3600,
          refresh_token: refresh,
          scope: "mcp-api.all:write",
        });
      };
      if (form.grant_type === "authorization_code") {
        const challenge = form.code ? codes.get(form.code) : undefined;
        if (!challenge || !form.code_verifier || (await s256(form.code_verifier)) !== challenge)
          return json(400, { error: "invalid_grant", error_description: "bad code or verifier" });
        if (form.client_id !== "client-1" || !form.redirect_uri) return json(400, { error: "invalid_client" });
        codes.delete(form.code); // single use
        return issue("rt-1");
      }
      if (form.grant_type === "refresh_token") {
        if (!form.refresh_token || !refreshTokens.has(form.refresh_token))
          return json(400, { error: "invalid_grant", error_description: "unknown refresh token" });
        if (opts.rotateRefresh) {
          refreshTokens.delete(form.refresh_token);
          refreshes += 1;
          refreshTokens.add(`rt-${refreshes}`);
          return issue(`rt-${refreshes}`);
        }
        return issue(form.refresh_token);
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    return json(404, { error: "not_found" });
  };

  return {
    fetch: fetchImpl,
    calls,
    registrations,
    tokenRequests,
    issueCode,
    codeFor,
    /** Every refresh token stops working (the person revoked access). */
    revokeRefreshTokens: () => refreshTokens.clear(),
    tokenEndpoint,
    authorizationEndpoint: `${asOrigin}/oauth/authorize`,
  };
}
