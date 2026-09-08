import type { ConfigStore } from "../config.js";
import { makeWebCapability } from "../tools/web.js";
import type { FetchLike } from "./client.js";
import { StreamableHttpMcpClient } from "./client.js";
import { parseMcpSettings } from "./config.js";
import { importCredentialKey, type CredentialKey } from "./sealed.js";
import { FileMcpSecretStore, WorkerMcpSecretStore, type McpSecretStore } from "./secretStore.js";
import { MCP_OFF_MESSAGE, McpService } from "./service.js";
import type { McpToolSource } from "./source.js";
import type { McpClientFactory, McpServerSpec } from "./types.js";

export * from "./types.js";
export * from "./registry.js";
export {
  StreamableHttpMcpClient,
  MCP_REQUEST_TIMEOUT_MS,
  MCP_MAX_RESPONSE_BYTES,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_PROTOCOL_VERSION,
} from "./client.js";
export { InMemoryMcpClient, fakeMcpServerFetch } from "./fake.js";
export {
  bridgeMcpTools,
  mcpToolName,
  MCP_MAX_CALLS_PER_RUN,
  MCP_RESULT_CAP,
  MCP_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_PREFIX,
} from "./bridge.js";
export {
  StaticMcpToolSource,
  CompositeMcpToolSource,
  DiscoveringMcpToolSource,
  mcpGuidanceBlock,
  MCP_TOOLS_CACHE_TTL_MS,
  type McpToolSource,
  type McpToolsForRun,
  type McpServerOutcome,
} from "./source.js";
export { parseMcpSettings, DEFAULT_MCP_KEY_ENV, MCP_SERVER_NAME_PATTERN, type McpSettings } from "./config.js";
export {
  InMemoryMcpSecretStore,
  FileMcpSecretStore,
  WorkerMcpSecretStore,
  type McpSecretStore,
} from "./secretStore.js";
export {
  McpService,
  McpServiceError,
  ConfigMcpToolSource,
  MCP_OFF_MESSAGE,
  type McpActor,
  type McpTarget,
} from "./service.js";
export {
  importCredentialKey,
  sealCredential,
  openCredential,
  generateCredentialKeyBase64,
  randomNonce,
  type CredentialKey,
} from "./sealed.js";
export { newTicket, planOpen, planComplete, identityMatches, refusalMessage } from "./connect.js";

/** What startup wiring produces: the per-run tool source for the dispatcher and
 *  the service behind the `mcp.*` commands + the connect page. Both undefined
 *  when config.yaml has no `mcp` block. */
export interface McpWiring {
  source?: McpToolSource;
  service?: McpService;
  /** Why MCP is off, for the commands' `unavailable` reply. */
  unavailable?: string;
}

/**
 * Startup wiring shared by the bot and the CLI (docs/reference/specs/mcp-tools.md item 13):
 * servers come from the config store's scopes (already loaded); sealed
 * credentials and tickets go where the runtime overrides go — the state
 * Worker's ConfigDO when `runtimeOverrides.worker` is set, else a JSON file
 * beside the overrides file; the sealing key from `mcp.credentialKeyEnv`.
 * One client factory over the SSRF-pinned web fetch.
 */
export function buildMcp(
  config: ConfigStore,
  env: Record<string, string | undefined>,
  opts: {
    publicBaseUrl?: string;
    secretsPath?: string;
    resolveEmail?: (userId: string) => Promise<string | undefined>;
    warn?: (m: string) => void;
    fetch?: typeof fetch;
  } = {},
): McpWiring {
  const settings = parseMcpSettings(config.config.mcp);
  if (!settings) return { unavailable: MCP_OFF_MESSAGE };
  const worker = config.config.runtimeOverrides?.worker;
  let secrets: McpSecretStore;
  if (worker) {
    const tokenEnv = worker.tokenEnv ?? "MEMORY_TOKEN";
    const token = env[tokenEnv];
    if (!token) throw new Error(`runtimeOverrides.worker is configured but ${tokenEnv} is not set`);
    secrets = new WorkerMcpSecretStore({
      baseUrl: worker.baseUrl,
      token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  } else {
    secrets = new FileMcpSecretStore(settings.secretsPath ?? opts.secretsPath ?? "./data/mcp-secrets.json");
  }
  const rawKey = env[settings.credentialKeyEnv];
  let key: CredentialKey | undefined;
  if (rawKey) key = importCredentialKey(rawKey);
  else
    opts.warn?.(
      `${settings.credentialKeyEnv} is not set — bearer MCP servers without tokenEnv cannot be added or used until it is (openssl rand -base64 32)`,
    );
  const webFetch = makeWebCapability(env).fetch;
  const service = new McpService({
    config,
    secrets,
    key,
    factory: httpMcpClientFactory(webFetch),
    fetch: webFetch,
    publicBaseUrl: opts.publicBaseUrl,
    env,
    resolveEmail: opts.resolveEmail,
  });
  return { source: service.source, service };
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
