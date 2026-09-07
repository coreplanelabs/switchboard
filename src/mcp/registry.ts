// The MCP server contract shared by the config layer, the bot's service, and
// the state Worker (features/mcp-tools.md items 11–17). Node-free and I/O-free:
// `deploy/cloudflare-memory/worker.ts` imports the ticket and sealed-credential
// validators by relative path so both ends check one shape. A server is a
// `Scope` setting (`Scope.mcpServers[name]`, src/config.ts) — resolved through
// the same `defaults → channel → user` layers as models and instructions —
// never a record in a parallel store. Credentials are never part of an entry:
// they are sealed blobs keyed by `<scopeKey>/<name>`, opened only by the bot.

/** `none`: no Authorization header. `bearer`: a static token — `tokenEnv` on
 *  the bot, or one pasted on the connect page and sealed. `oauth`: OAuth 2.1
 *  (item 18) — the connect page sends the person to the server's authorization
 *  server; the sealed credential is the token set the callback exchanged. */
export type McpAuthKind = "none" | "bearer" | "oauth";

/** One server as a scope carries it. `tokenEnv` is the static-config way to
 *  supply a bearer (an env var on the bot); without it a bearer server's token
 *  is the sealed credential the connect page stored. */
export interface McpServerEntry {
  url: string;
  /** Agents whose runs may see it (default general + research). */
  agents?: string[];
  auth: McpAuthKind;
  tokenEnv?: string;
  /** Who added it at run time (`slack:U…`, `cli:local`); absent for static config. */
  addedBy?: string;
  addedAt?: number;
}

/** The three tiers a server can live in, in precedence order for a name clash. */
export type McpScopeKind = "org" | "channel" | "user";

/** `org` | `channel:<platform-namespaced id>` | `user:<platform-namespaced id>`
 *  — the first half of a credential key. */
export function mcpScopeKey(kind: McpScopeKind, id?: string): string {
  if (kind === "org") return "org";
  if (!id) throw new Error(`${kind} scope needs an id`);
  return `${kind}:${id}`;
}

export function parseMcpScopeKey(key: string): { kind: McpScopeKind; id?: string } | undefined {
  if (key === "org") return { kind: "org" };
  for (const kind of ["channel", "user"] as const) {
    const prefix = `${kind}:`;
    if (key.startsWith(prefix) && key.length > prefix.length) return { kind, id: key.slice(prefix.length) };
  }
  return undefined;
}

/** `<scopeKey>/<name>` — the credential and ticket key; unique across tiers. */
export function mcpCredentialKey(scopeKey: string, name: string): string {
  return `${scopeKey}/${name}`;
}

export function splitCredentialKey(key: string): { scopeKey: string; name: string } | undefined {
  const slash = key.lastIndexOf("/");
  if (slash <= 0) return undefined;
  const scopeKey = key.slice(0, slash);
  const name = key.slice(slash + 1);
  return parseMcpScopeKey(scopeKey) && MCP_SERVER_NAME_RE.test(name) ? { scopeKey, name } : undefined;
}

/** An encrypted credential as stored — opaque to the Worker. `keyId` names
 *  the KEK generation; the credential key is the GCM additional data. */
export interface SealedCredential {
  /** `<scopeKey>/<name>` */
  serverId: string;
  keyId: string;
  /** base64: 12-byte IV ‖ AES-256-GCM ciphertext+tag */
  sealed: string;
  updatedAt: number;
}

/** The connect flow's state machine (item 15). One ticket per `mcp add`/
 *  `mcp connect`; single use; bound to the requester. */
export type McpTicketState = "pending" | "opened" | "authorizing" | "completed" | "cancelled";
/** Every state, for the Worker's route validation — one list, both ends. */
export const MCP_TICKET_STATES: readonly McpTicketState[] = [
  "pending",
  "opened",
  "authorizing",
  "completed",
  "cancelled",
];

export interface McpTicket {
  nonce: string;
  /** `<scopeKey>/<name>` */
  serverId: string;
  /** The chat/CLI identity that asked (`slack:U…`, `cli:local`). */
  requesterId: string;
  /** Resolved when the channel could (Slack `users:read.email`); the connect
   *  page then requires the Access identity's email to match. */
  requesterEmail?: string;
  createdAt: number;
  expiresAt: number;
  state: McpTicketState;
  /** Without `requesterEmail`, the FIRST Access identity to open the page is
   *  bound and the completion must come from the same identity. */
  openedBy?: { sub: string; email?: string; at: number };
  completedBy?: { sub: string; email?: string; at: number };
  /** OAuth (item 18): the pending authorization — PKCE verifier, client id,
   *  `state`, endpoints — sealed under the bot's key (AAD `ticket:<nonce>`)
   *  while the person is at the authorization server. Set when the ticket
   *  enters `authorizing`; opaque to the Worker. */
  oauth?: { keyId: string; sealed: string };
  /** Set with `completed` (item 19): what the completion found, so the thread
   *  that asked can be told without re-probing — the bridged tool count, or
   *  the verify warning when the server could not be reached. */
  outcome?: { toolCount?: number; warning?: string };
}

export const MCP_TICKET_TTL_MS = 10 * 60_000;
export const MCP_SERVER_NAME_MAX = 32;
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MCP_URL_MAX = 2_048;
export const MCP_AGENTS_MAX = 8;
/** Agents a CHANNEL- or USER-scoped server may reach — never the code-writing
 *  or read-only-by-contract agents (item 14); only an org server (admins) may. */
export const MCP_SELF_SERVE_AGENTS: readonly string[] = ["general", "research"];
export const MCP_TOKEN_MAX_CHARS = 8_192;
export const MCP_SERVERS_PER_SCOPE_MAX = 32;

// ---- structural validators (both ends) --------------------------------------

const isStr = (v: unknown, max = 4_096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isOutcome(v: unknown): v is NonNullable<McpTicket["outcome"]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.toolCount === undefined || (isNum(o.toolCount) && o.toolCount >= 0)) &&
    (o.warning === undefined || isStr(o.warning, 1_024))
  );
}

/** Shape only (the config layer adds the semantic checks: SSRF, known agents, tier rules). */
export function isMcpServerEntry(v: unknown): v is McpServerEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    isStr(e.url, MCP_URL_MAX) &&
    (e.agents === undefined ||
      (Array.isArray(e.agents) &&
        e.agents.length > 0 &&
        e.agents.length <= MCP_AGENTS_MAX &&
        e.agents.every((a) => isStr(a, 32)))) &&
    (e.auth === "none" || e.auth === "bearer" || e.auth === "oauth") &&
    (e.tokenEnv === undefined || isStr(e.tokenEnv, 128)) &&
    (e.addedBy === undefined || isStr(e.addedBy, 260)) &&
    (e.addedAt === undefined || isNum(e.addedAt))
  );
}

export function isSealedCredential(v: unknown): v is SealedCredential {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return isStr(c.serverId, 400) && isStr(c.keyId, 64) && isStr(c.sealed, 64 * 1024) && isNum(c.updatedAt);
}

export function isMcpTicket(v: unknown): v is McpTicket {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  const actor = (a: unknown) =>
    a === undefined ||
    (!!a && typeof a === "object" && isStr((a as { sub?: unknown }).sub, 260) && isNum((a as { at?: unknown }).at));
  return (
    isStr(t.nonce, 128) &&
    /^[A-Za-z0-9_-]{16,128}$/.test(t.nonce) &&
    isStr(t.serverId, 400) &&
    isStr(t.requesterId, 260) &&
    (t.requesterEmail === undefined || isStr(t.requesterEmail, 320)) &&
    isNum(t.createdAt) &&
    isNum(t.expiresAt) &&
    MCP_TICKET_STATES.includes(t.state as McpTicketState) &&
    actor(t.openedBy) &&
    actor(t.completedBy) &&
    (t.oauth === undefined ||
      (!!t.oauth &&
        typeof t.oauth === "object" &&
        isStr((t.oauth as { keyId?: unknown }).keyId, 64) &&
        isStr((t.oauth as { sealed?: unknown }).sealed, 64 * 1024))) &&
    (t.outcome === undefined || isOutcome(t.outcome))
  );
}

/** A server as surfaces show it: never a credential, and the URL reduced to
 *  its origin + path (a query string could carry a key). */
export interface McpServerView {
  name: string;
  scope: McpScopeKind;
  scopeKey: string;
  url: string;
  agents: string[];
  auth: McpAuthKind;
  /** `static` = bearer from `tokenEnv` on the bot; `connected` = a sealed
   *  credential is stored (or no credential is needed); `awaiting_credential`
   *  = bearer, nothing stored yet. */
  state: "connected" | "awaiting_credential" | "static";
  source: "config" | "runtime";
  addedBy?: string;
  addedAt?: number;
}

export function serverView(
  scopeKey: string,
  name: string,
  entry: McpServerEntry,
  opts: { hasCredential: boolean; source: "config" | "runtime" },
): McpServerView {
  const parsed = parseMcpScopeKey(scopeKey);
  const state: McpServerView["state"] =
    entry.auth === "none"
      ? "connected"
      : entry.tokenEnv
        ? "static"
        : opts.hasCredential
          ? "connected"
          : "awaiting_credential";
  return {
    name,
    scope: parsed?.kind ?? "org",
    scopeKey,
    url: safeUrl(entry.url),
    agents: [...(entry.agents ?? MCP_SELF_SERVE_AGENTS)],
    auth: entry.auth,
    state,
    source: opts.source,
    ...(entry.addedBy ? { addedBy: entry.addedBy } : {}),
    ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
  };
}

export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}
