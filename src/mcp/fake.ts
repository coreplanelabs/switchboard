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
      body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { noise: true } })}\n\n` + `data: ${JSON.stringify(payload)}\n\n`;
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
        { jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } },
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
      const result = opts.onCall?.(params.name, params.arguments ?? {}) ?? { content: [{ type: "text", text: `${params.name} ok` }] };
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
