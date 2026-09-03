import { assertUrlAllowed, BlockedUrlError } from "../tools/web.js";
import type { McpServerSpec } from "./types.js";

// Static MCP configuration (features/mcp-tools.md item 11): `mcp.servers[]` in
// config.yaml, validated loudly at load, the bearer read from the environment
// once (like provider `apiKeyEnv`) — never in the file, never logged.

export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const DEFAULT_MCP_AGENTS: readonly string[] = ["general", "research"];

export interface McpConfig {
  servers?: unknown;
}

export interface ParseMcpConfigOptions {
  env: Record<string, string | undefined>;
  /** Known agent names (`Object.keys(AGENTS)`); an unknown one is a typo we refuse. */
  knownAgents: readonly string[];
}

export function parseMcpConfig(raw: unknown, opts: ParseMcpConfigOptions): McpServerSpec[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("mcp: expected a mapping with `servers`");
  const servers = (raw as McpConfig).servers;
  if (servers === undefined) return [];
  if (!Array.isArray(servers)) throw new Error("mcp.servers: expected a list");
  const seen = new Set<string>();
  return servers.map((entry, i) => {
    const where = `mcp.servers[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where}: expected a mapping`);
    const e = entry as Record<string, unknown>;
    const name = e.name;
    if (typeof name !== "string" || !MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`${where}.name: expected a slug (lowercase letters, digits, dashes; ≤ 32 chars)`);
    }
    if (seen.has(name)) throw new Error(`${where}.name: duplicate server name "${name}"`);
    seen.add(name);
    const url = e.url;
    if (typeof url !== "string" || !url) throw new Error(`mcp.servers.${name}.url: expected an http(s) URL`);
    try {
      assertUrlAllowed(url);
    } catch (err) {
      const reason = err instanceof BlockedUrlError ? err.message : "not a valid URL";
      throw new Error(`mcp.servers.${name}.url: ${reason}`);
    }
    const agents = e.agents === undefined ? [...DEFAULT_MCP_AGENTS] : e.agents;
    if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => typeof a === "string")) {
      throw new Error(`mcp.servers.${name}.agents: expected a non-empty list of agent names`);
    }
    for (const a of agents as string[]) {
      if (!opts.knownAgents.includes(a)) throw new Error(`mcp.servers.${name}.agents: unknown agent "${a}"`);
    }
    const spec: McpServerSpec = { name, url, agents: [...new Set(agents as string[])] };
    if (e.auth !== undefined) {
      if (!e.auth || typeof e.auth !== "object") throw new Error(`mcp.servers.${name}.auth: expected a mapping`);
      const auth = e.auth as Record<string, unknown>;
      if (auth.type !== "bearer") throw new Error(`mcp.servers.${name}.auth.type: expected "bearer"`);
      if (typeof auth.tokenEnv !== "string" || !auth.tokenEnv) throw new Error(`mcp.servers.${name}.auth.tokenEnv: expected an environment variable name`);
      const token = opts.env[auth.tokenEnv];
      if (!token) throw new Error(`mcp.servers.${name}.auth: ${auth.tokenEnv} is not set`);
      spec.auth = { type: "bearer", token };
    }
    return spec;
  });
}
