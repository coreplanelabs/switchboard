import { AGENTS } from "../agents/registry.js";
import { makeWebCapability } from "../tools/web.js";
import type { FetchLike } from "./client.js";
import { StreamableHttpMcpClient } from "./client.js";
import { parseMcpConfig } from "./config.js";
import { ConfigMcpToolSource } from "./source.js";
import type { McpClientFactory, McpServerSpec } from "./types.js";

export * from "./types.js";
export { StreamableHttpMcpClient, MCP_REQUEST_TIMEOUT_MS, MCP_MAX_RESPONSE_BYTES, MCP_MAX_TOOLS_PER_SERVER, MCP_PROTOCOL_VERSION } from "./client.js";
export { InMemoryMcpClient, fakeMcpServerFetch } from "./fake.js";
export { bridgeMcpTools, mcpToolName, MCP_MAX_CALLS_PER_RUN, MCP_RESULT_CAP, MCP_MAX_DESCRIPTION_CHARS, MCP_TOOL_PREFIX } from "./bridge.js";
export { ConfigMcpToolSource, mcpGuidanceBlock, MCP_TOOLS_CACHE_TTL_MS, type McpToolSource, type McpToolsForRun, type McpServerOutcome } from "./source.js";
export { parseMcpConfig, DEFAULT_MCP_AGENTS, MCP_SERVER_NAME_PATTERN } from "./config.js";

/** Startup wiring shared by the bot and the CLI (features/mcp-tools.md item
 *  11): parse + validate `mcp.servers` (throws on a bad entry — a misconfigured
 *  server stops startup rather than silently serving nothing), then ONE source
 *  whose clients ride the SSRF-pinned web fetch. No servers → undefined. */
export function buildMcpToolSource(raw: unknown, env: Record<string, string | undefined>): ConfigMcpToolSource | undefined {
  const servers = parseMcpConfig(raw, { env, knownAgents: Object.keys(AGENTS) });
  if (servers.length === 0) return undefined;
  return new ConfigMcpToolSource(servers, { factory: httpMcpClientFactory(makeWebCapability(env).fetch) });
}

/** The production factory: one Streamable-HTTP client per server over the
 *  given fetch — callers pass the SSRF-pinned fetch from `makeWebCapability`. */
export function httpMcpClientFactory(fetchImpl: FetchLike): McpClientFactory {
  return (server: McpServerSpec) =>
    new StreamableHttpMcpClient({
      url: server.url,
      fetch: fetchImpl,
      ...(server.auth?.type === "bearer" ? { headers: { authorization: `Bearer ${server.auth.token}` } } : {}),
    });
}
