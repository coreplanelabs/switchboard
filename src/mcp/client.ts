import { McpError, type McpCallResult, type McpClient, type McpToolInfo } from "./types.js";

// Streamable-HTTP MCP client (features/mcp-tools.md items 2–4). JSON-RPC 2.0
// over POST; the server answers with JSON or an SSE stream (we take the frame
// carrying our request id). `initialize` + `notifications/initialized` run
// lazily once per client; the server's `Mcp-Session-Id` rides on every later
// request. Network I/O goes through the INJECTED fetch — production hands in
// the SSRF-pinned undici fetch from src/tools/web.ts — so no URL here can reach
// an internal address that guard refuses. Never a process, never stdio
// (AGENTS.md invariant 5).

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** One request's ceiling; the run's AbortSignal also cancels it. */
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
/** A response body larger than this is refused, streamed and cut — never a
 *  partial JSON parse. */
export const MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** `tools/list` pages are followed until this many tools; the rest is dropped. */
export const MCP_MAX_TOOLS_PER_SERVER = 100;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StreamableHttpMcpClientOptions {
  url: string;
  /** Extra headers on every request (the bearer lives here). */
  headers?: Record<string, string>;
  fetch: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTools?: number;
  clientInfo?: { name: string; version: string };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class StreamableHttpMcpClient implements McpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxTools: number;
  private readonly clientInfo: { name: string; version: string };
  private sessionId: string | undefined;
  private initialized: Promise<void> | undefined;
  private nextId = 1;

  constructor(opts: StreamableHttpMcpClientOptions) {
    this.url = opts.url;
    this.headers = { ...(opts.headers ?? {}) };
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES;
    this.maxTools = opts.maxTools ?? MCP_MAX_TOOLS_PER_SERVER;
    this.clientInfo = opts.clientInfo ?? { name: "switchboard", version: "1" };
  }

  async listTools(opts?: { signal?: AbortSignal }): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // Bounded by the tool cap: a server paging forever cannot spin us.
    for (let page = 0; page <= this.maxTools; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, opts?.signal)) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      const list = Array.isArray(result?.tools) ? result.tools : [];
      for (const raw of list) {
        const t = toToolInfo(raw);
        if (t) tools.push(t);
        if (tools.length >= this.maxTools) return tools;
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, opts?.signal)) as {
      content?: unknown;
      isError?: unknown;
      structuredContent?: unknown;
    };
    const content = Array.isArray(result?.content)
      ? result.content.filter((p): p is McpCallResult["content"][number] => typeof p === "object" && p !== null && typeof (p as { type?: unknown }).type === "string")
      : [];
    return {
      content,
      ...(result?.isError === true ? { isError: true } : {}),
      ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }

  // ---- protocol ---------------------------------------------------------------

  /** One JSON-RPC request with the session established first. A `404` on an
   *  established session means the server forgot it: re-initialize once. */
  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    await this.ensureInitialized(signal);
    try {
      return await this.rpc(method, params, signal);
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404 && this.sessionId) {
        this.sessionId = undefined;
        this.initialized = undefined;
        await this.ensureInitialized(signal);
        return this.rpc(method, params, signal);
      }
      throw err;
    }
  }

  private ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.initialize(signal).catch((err) => {
        // A failed handshake is retried on the next call, not cached forever.
        this.initialized = undefined;
        throw err;
      });
    }
    return this.initialized;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const result = (await this.rpc(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
      signal,
      { initializing: true },
    )) as { protocolVersion?: unknown } | undefined;
    if (!result || typeof result !== "object") throw new McpError("protocol", "initialize returned no result");
    // Fire-and-forget by spec (202 expected); a failure here is not fatal to
    // the session — the server already answered initialize.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => undefined);
  }

  private async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal, o?: { initializing?: boolean }): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal, o);
    const session = res.headers.get("mcp-session-id");
    if (session && o?.initializing) this.sessionId = session;
    const message = await this.readResponse(res, id, signal);
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : "protocol";
      throw new McpError(code, `${method}: ${String(message.error.message ?? "error")}`);
    }
    return message.result;
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal, o?: { initializing?: boolean }): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId && !o?.initializing) headers["mcp-session-id"] = this.sessionId;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combineSignals(AbortSignal.timeout(this.timeoutMs), signal),
      });
    } catch (err) {
      if (isTimeout(err)) throw new McpError("timeout", `MCP server did not answer within ${this.timeoutMs} ms`);
      throw new McpError("transport", `MCP transport failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok && res.status !== 202) {
      // Drain nothing: the body may be attacker-sized; the status is the fact.
      throw new HttpStatusError(res.status);
    }
    return res;
  }

  /** JSON or SSE, whichever the server chose; capped by bytes while streaming.
   *  The request timeout also covers the body: a stream held open past it is
   *  the same `timeout` error as a server that never answered. */
  private async readResponse(res: Response, id: number, signal?: AbortSignal): Promise<JsonRpcResponse> {
    let text: string;
    try {
      text = await readCapped(res, this.maxResponseBytes, signal);
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (isTimeout(err)) throw new McpError("timeout", `MCP server did not answer within ${this.timeoutMs} ms`);
      throw new McpError("transport", `MCP response body failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "text/event-stream") {
      for (const data of sseDataFrames(text)) {
        const parsed = tryParse(data);
        if (parsed && (parsed as JsonRpcResponse).id === id) return parsed as JsonRpcResponse;
      }
      throw new McpError("protocol", "SSE response carried no frame for the request");
    }
    const parsed = tryParse(text);
    if (!parsed || typeof parsed !== "object") throw new McpError("protocol", "response was not JSON-RPC");
    // Some servers answer a batch array; take our id.
    if (Array.isArray(parsed)) {
      const hit = parsed.find((m) => (m as JsonRpcResponse)?.id === id) as JsonRpcResponse | undefined;
      if (!hit) throw new McpError("protocol", "batch response carried no frame for the request");
      return hit;
    }
    return parsed as JsonRpcResponse;
  }
}

class HttpStatusError extends McpError {
  constructor(public readonly status: number) {
    super("transport", `MCP server returned HTTP ${status}`);
    this.name = "McpError";
  }
}

function toToolInfo(raw: unknown): McpToolInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name) return undefined;
  const schema = r.inputSchema && typeof r.inputSchema === "object" && !Array.isArray(r.inputSchema) ? (r.inputSchema as Record<string, unknown>) : {};
  const ann = r.annotations && typeof r.annotations === "object" ? (r.annotations as McpToolInfo["annotations"]) : undefined;
  return {
    name: r.name,
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    inputSchema: schema,
    ...(ann ? { annotations: ann } : {}),
  };
}

/** Read a body up to `max` bytes; one byte more is a refusal (the stream is
 *  cancelled), never a truncated parse. */
async function readCapped(res: Response, max: number, signal?: AbortSignal): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new McpError("timeout", "run aborted");
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => undefined);
          throw new McpError("too_large", `MCP response exceeded ${max} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** The `data:` payloads of an SSE text, one string per event (multi-line data
 *  joined with `\n`, per the SSE spec). */
export function sseDataFrames(text: string): string[] {
  const frames: string[] = [];
  let data: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      if (data.length > 0) frames.push(data.join("\n"));
      data = [];
      continue;
    }
    if (rawLine.startsWith(":")) continue;
    const idx = rawLine.indexOf(":");
    const field = idx === -1 ? rawLine : rawLine.slice(0, idx);
    if (field !== "data") continue;
    let value = idx === -1 ? "" : rawLine.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  }
  if (data.length > 0) frames.push(data.join("\n"));
  return frames;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** `AbortSignal.any` (Node ≥ 20.3; `engines.node` is ≥ 22) — the platform
 *  releases its listeners when the combined signal is collected, so a
 *  long-lived run signal never accumulates one listener per request. */
function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  return b ? AbortSignal.any([a, b]) : a;
}
