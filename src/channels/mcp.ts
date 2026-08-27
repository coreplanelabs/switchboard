import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { dispatch as realDispatch, type CoreDeps } from "../core/dispatcher.js";
import type { ChannelIO, HistoryItem, IncomingMessage, StatusHandle, StatusUpdate } from "../core/types.js";
import {
  authenticate,
  MAX_BODY_BYTES,
  readBody,
  type DispatchFn,
  type IngressConfig,
  type IngressIdentity,
} from "./http.js";

// MCP channel adapter: adapter #4. Like Slack, the CLI, and HTTP ingress, it is
// pure transport — it turns an inbound MCP tool call into an IncomingMessage,
// calls the channel-agnostic core dispatch(), and provides a ChannelIO to reply
// through. Nothing about routing, config, permissions, or agents lives here.
//
// Transport: a MINIMAL MCP server over streamable-HTTP — JSON-RPC 2.0 over a
// single POST /mcp with one JSON response per request (no SSE; request/response
// tool calls don't need it). We hand-implement the small JSON-RPC subset rather
// than take the MCP SDK as a dependency. Methods handled: initialize,
// tools/list, tools/call (one tool: `dispatch`), and JSON-RPC notifications
// (accepted, no response). Anything else is a proper JSON-RPC error.
//
// Auth is REUSED wholesale from the HTTP ingress adapter (http.ts): the same
// fail-closed, constant-time bearer-token machinery and the same
// SWITCHBOARD_INGRESS_TOKENS env config (one token map for both surfaces). The
// only difference is the identity namespace: MCP callers are `mcp:` so they are
// distinct from `http:` callers, and the existing canUseRepo/canRunAgent gates
// apply unchanged. See handleMcpRequest below for the gating order.

const PLATFORM = "mcp";
const DEFAULT_CHANNEL = "default";
const DEFAULT_THREAD = "default";

/** Protocol version we speak. Advertised at initialize. */
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "switchboard", version: "0.1.0" } as const;

/** The single tool this server exposes. */
const DISPATCH_TOOL = {
  name: "dispatch",
  description: "send a request to Switchboard",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "the request to send to Switchboard" },
      thread: { type: "string", description: "conversation thread key (optional; defaults to a single thread)" },
      channel: { type: "string", description: "config/permission scope (optional; a token may pin this)" },
    },
    required: ["text"],
  },
} as const;

// JSON-RPC 2.0 error codes (spec-defined) plus one server-defined auth code.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** Server-defined (the -32000..-32099 range is reserved for implementations). */
const AUTH_ERROR = -32001;

export interface McpOptions {
  auth: IngressConfig;
  /** Defaults to the real core dispatch(); overridden in tests. */
  dispatch?: DispatchFn;
  /** Max body size in bytes (node wrapper enforces at read time). */
  maxBodyBytes?: number;
}

type JsonRpcId = string | number | null;

interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
}

interface JsonRpcResultBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

/** A validated JSON-RPC request envelope. */
interface JsonRpcRequest {
  id?: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

/** ChannelIO for a single-shot MCP tool call: reply() collects, status() is a
 *  no-op (no live surface to edit in one shot), history() is empty (a tool call
 *  carries no prior turns — conversation state, if any, rides on threadKey). */
export class McpIO implements ChannelIO {
  private replies: string[] = [];

  async reply(text: string): Promise<void> {
    this.replies.push(text);
  }

  async status(_initial: StatusUpdate): Promise<StatusHandle> {
    return {
      update: () => {},
      done: async () => {},
    };
  }

  async history(): Promise<HistoryItem[]> {
    return [];
  }

  /** The collected reply text — becomes the MCP tool result content. */
  collected(): string {
    return this.replies.join("\n\n");
  }
}

/** Build the `mcp:`-namespaced IncomingMessage from an authed identity + the
 *  tool arguments. Mirrors http.ts's namespacing (invariant 4) but with the
 *  `mcp:` prefix so MCP and HTTP callers are distinct scopes. A token's pinned
 *  channel wins over the arguments'; otherwise the arguments choose, else the
 *  default scope. */
function toIncomingMessage(
  identity: IngressIdentity,
  args: { text: string; channel?: string; thread?: string },
): IncomingMessage {
  const channel = identity.channel ?? args.channel ?? DEFAULT_CHANNEL;
  const thread = args.thread ?? DEFAULT_THREAD;
  return {
    userId: `${PLATFORM}:${identity.subject}`,
    channelId: `${PLATFORM}:${channel}`,
    threadKey: `${PLATFORM}:${channel}:${thread}`,
    text: args.text,
  };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResultBody {
  return { jsonrpc: "2.0", id, result };
}

function err(id: JsonRpcId, code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export interface McpRequest {
  /** HTTP method; only POST is accepted. */
  method?: string;
  headers: IncomingHttpHeaders;
  /** Raw request body: a single JSON-RPC 2.0 message. */
  body: string;
}

export interface McpResponse {
  /** HTTP status. Transport gating uses 405/401/503; everything past the gate
   *  is 200 with a JSON-RPC envelope, except an accepted notification (202,
   *  empty body). */
  status: number;
  /** JSON-RPC response envelope, or undefined for an accepted notification. */
  body?: JsonRpcResultBody | JsonRpcErrorBody;
}

/** Extract the JSON-RPC id from a parsed message if it is a valid id type. */
function readId(msg: Record<string, unknown>): JsonRpcId {
  const id = msg.id;
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  return null;
}

/**
 * Route one validated JSON-RPC request to its handler. Transport-free (no
 * socket, no HTTP concepts): a parsed request + an already-authed identity in,
 * a JSON-RPC response envelope out. This is the pure MCP method surface;
 * handleMcpRequest wraps it with HTTP gating, auth, and JSON parsing.
 */
async function route(
  req: JsonRpcRequest,
  identity: IngressIdentity,
  deps: CoreDeps,
  options: McpOptions,
): Promise<JsonRpcResultBody | JsonRpcErrorBody> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "tools/list":
      return ok(id, { tools: [DISPATCH_TOOL] });

    case "tools/call": {
      const name = req.params.name;
      if (name !== DISPATCH_TOOL.name) {
        return err(id, INVALID_PARAMS, `unknown tool: ${typeof name === "string" ? name : "(none)"}`);
      }
      const rawArgs = req.params.arguments;
      const args = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
      if (typeof args.text !== "string" || args.text.trim() === "") {
        return err(id, INVALID_PARAMS, "`text` is required and must be a non-empty string");
      }
      if (args.channel !== undefined && typeof args.channel !== "string") {
        return err(id, INVALID_PARAMS, "`channel` must be a string");
      }
      if (args.thread !== undefined && typeof args.thread !== "string") {
        return err(id, INVALID_PARAMS, "`thread` must be a string");
      }
      const msg = toIncomingMessage(identity, {
        text: args.text,
        channel: args.channel as string | undefined,
        thread: args.thread as string | undefined,
      });
      const io = new McpIO();
      const dispatchFn = options.dispatch ?? realDispatch;
      await dispatchFn(deps, msg, io);
      return ok(id, { content: [{ type: "text", text: io.collected() }] });
    }

    default:
      return err(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

/**
 * Core request handler, decoupled from node's http so it is fully unit-testable
 * (no socket). Ordering mirrors http.ts's handleIngressRequest and is
 * deliberate:
 *   1. non-POST                -> 405
 *   2. no tokens configured    -> 503 disabled   (FAIL-CLOSED: never open)
 *   3. missing/unknown token   -> 401 unauthorized
 *   4. malformed JSON          -> 200 + JSON-RPC parse error (-32700)
 *   5. not a JSON-RPC request  -> 200 + invalid request (-32600)
 *   6. notification (no id)    -> 202, no body (never answered per JSON-RPC)
 *   7. valid request           -> 200 + JSON-RPC result/error from route()
 * Auth is the SAME fail-closed, constant-time bearer machinery as http.ts;
 * only the identity namespace differs (`mcp:`). Body-size enforcement (413)
 * happens upstream in the node wrapper, before the body is ever fully buffered.
 */
export async function handleMcpRequest(req: McpRequest, deps: CoreDeps, options: McpOptions): Promise<McpResponse> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    return { status: 405, body: err(null, INVALID_REQUEST, "method not allowed; POST only") };
  }
  // Fail-closed: with no tokens configured the endpoint is disabled, never open.
  if (Object.keys(options.auth.tokens).length === 0) {
    return { status: 503, body: err(null, AUTH_ERROR, "disabled: no ingress tokens configured") };
  }
  const identity = authenticate(req.headers, options.auth);
  if (!identity) {
    return { status: 401, body: err(null, AUTH_ERROR, "unauthorized") };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return { status: 200, body: err(null, PARSE_ERROR, "parse error: invalid JSON") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: 200, body: err(null, INVALID_REQUEST, "invalid request: expected a JSON-RPC object") };
  }
  const msg = parsed as Record<string, unknown>;
  if (typeof msg.method !== "string") {
    return { status: 200, body: err(readId(msg), INVALID_REQUEST, "invalid request: `method` is required") };
  }

  // A JSON-RPC notification (no `id`) is never answered; accept it (202).
  if (!("id" in msg)) {
    return { status: 202 };
  }

  const params =
    typeof msg.params === "object" && msg.params !== null && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};
  const request: JsonRpcRequest = { id: readId(msg), method: msg.method, params };
  const body = await route(request, identity, deps, options);
  return { status: 200, body };
}

/**
 * node:http adapter around handleMcpRequest: reads the body (size-capped), runs
 * the handler, and writes the response. Wire this at POST /mcp in the server
 * (src/index.ts). Mirrors http.ts's createIngressHandler.
 */
export function createMcpHandler(
  deps: CoreDeps,
  options: McpOptions,
): (req: HttpRequest, res: ServerResponse) => void {
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const write = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };
  return (req, res) => {
    void (async () => {
      try {
        const read = await readBody(req, maxBytes);
        if (!read.ok) {
          write(res, 413, err(null, INVALID_REQUEST, "request body too large"));
          req.destroy();
          return;
        }
        const result = await handleMcpRequest(
          { method: req.method, headers: req.headers, body: read.body },
          deps,
          options,
        );
        write(res, result.status, result.body);
      } catch (e) {
        // dispatch() catches its own errors and replies, so reaching here means
        // a transport fault. Answer honestly; never leak internals.
        console.error(`[mcp] ${e instanceof Error ? e.message : String(e)}`);
        write(res, 500, err(null, INTERNAL_ERROR, "internal error"));
      }
    })();
  };
}
