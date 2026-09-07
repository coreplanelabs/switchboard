// The `mcp` block of config.yaml (features/mcp-tools.md item 13). Servers
// themselves are NOT here — they are `mcpServers` on the config scopes
// (`defaults`, `channels.<id>`, `users.<id>`; src/config.ts) so they layer
// like every other setting. This block only names the deployment-level knobs:
// the env var holding the credential-sealing key. Sealed credentials and
// tickets follow `runtimeOverrides` (the state Worker's ConfigDO, or a file).

export const DEFAULT_MCP_KEY_ENV = "MCP_CREDENTIAL_KEY";
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface McpSettings {
  /** Env var holding the 32-byte base64 AES key that seals stored credentials. */
  credentialKeyEnv: string;
  /** Where `FileMcpSecretStore` writes when no state Worker is configured. */
  secretsPath?: string;
}

/** Absent → undefined (MCP off: no tools, `mcp.*` commands answer `unavailable`).
 *  `mcp: {}` turns it on with the defaults. */
export function parseMcpSettings(raw: unknown): McpSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("mcp: expected a mapping");
  const m = raw as Record<string, unknown>;
  if (m.servers !== undefined)
    throw new Error(
      "mcp.servers moved: declare servers as `defaults.mcpServers`, `channels.<id>.mcpServers`, or `users.<id>.mcpServers` (features/mcp-tools.md item 11)",
    );
  const credentialKeyEnv = m.credentialKeyEnv === undefined ? DEFAULT_MCP_KEY_ENV : m.credentialKeyEnv;
  if (typeof credentialKeyEnv !== "string" || !credentialKeyEnv)
    throw new Error("mcp.credentialKeyEnv: expected an environment variable name");
  if (m.secretsPath !== undefined && (typeof m.secretsPath !== "string" || !m.secretsPath))
    throw new Error("mcp.secretsPath: expected a file path");
  return { credentialKeyEnv, ...(typeof m.secretsPath === "string" ? { secretsPath: m.secretsPath } : {}) };
}
