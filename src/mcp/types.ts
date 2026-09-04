// External MCP servers as agent tools (#394, features/mcp-tools.md). The core
// depends on these interfaces only: `McpClient` (one server: list + call) and
// `McpToolSource` (per run: the bridged tools for an agent). Two clients ship
// (`StreamableHttpMcpClient` in client.ts, `InMemoryMcpClient` in fake.ts —
// AGENTS.md invariant 2); the wire types below are the MCP subset we speak.

/** A configured server, credentials already resolved (never the env var name). */
export interface McpServerSpec {
  /** Registry servers carry their `<scopeKey>/<name>` id — the client/cache
   *  key, so an org and a user server with one name are two clients. Config
   *  servers have none (their name is the key). */
  id?: string;
  /** Slug, `^[a-z0-9][a-z0-9-]*$`, ≤ 32 chars — the middle of every bridged tool name. */
  name: string;
  /** Streamable-HTTP endpoint (http/https; SSRF-checked at load and at connect). */
  url: string;
  /** Static bearer for PR1. Absent → no Authorization header. */
  auth?: { type: "bearer"; token: string };
  /** Agents whose runs may see this server's tools (default general + research). */
  agents: string[];
}

/** One tool as the server describes it (`tools/list`). Everything here is
 *  attacker-controlled text — the bridge treats it that way. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** A `tools/call` result. `content` parts are text or something else we name
 *  but do not carry (images, resources); `isError` is the server saying the
 *  call failed at the tool level (not a JSON-RPC error). */
export interface McpCallResult {
  content: McpContentPart[];
  isError?: boolean;
  structuredContent?: unknown;
}

export type McpContentPart = { type: "text"; text: string } | { type: string; [k: string]: unknown };

export interface McpClient {
  listTools(opts?: { signal?: AbortSignal }): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<McpCallResult>;
}

/** Builds the client for one server. Production binds the SSRF-pinned fetch;
 *  tests hand in an `InMemoryMcpClient`. */
export type McpClientFactory = (server: McpServerSpec) => McpClient;

/** A JSON-RPC error from the server, or a protocol fault the client detected
 *  (bad handshake, over-cap body). `code` is the JSON-RPC code when there was
 *  one; the client's own faults use the string codes. */
export class McpError extends Error {
  constructor(
    public readonly code: number | "transport" | "protocol" | "too_large" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}
