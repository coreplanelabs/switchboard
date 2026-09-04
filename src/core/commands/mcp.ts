import { z } from "zod";
import { MCP_SERVER_NAME_PATTERN } from "../../mcp/config.js";
import { MCP_OFF_MESSAGE, McpServiceError, type McpActor, type McpService } from "../../mcp/service.js";
import { CommandError, commandDefiner, type Caller, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";

export { MCP_OFF_MESSAGE };

// The `mcp.*` registrations (#394, features/mcp-tools.md items 13–15): the
// self-serve MCP server surface on the typed model — thin writes into the
// config layers (`Scope.mcpServers`), the way `config instructions` is a thin
// write into `Scope.instructions`.
//   mcp list [--channel <id>]
//   mcp add <name> --url <url> [--scope <me|channel|org>] [--agents a,b] [--auth <oauth|bearer|none>] [--channel <id>]
//                                                      — auth omitted → detected from the server (item 18)
//   mcp connect <name> [--scope …] [--channel <id>]   — a fresh one-time credential/sign-in link
//   mcp show <name> [--scope …] [--channel <id>]      — the entry + a live tools/list probe
//   mcp remove <name> [--scope …] [--channel <id>]
// Scope `me` is self-serve; `channel` is the `channelConfig` gate (as `config
// set channel`); `org` needs admin rights (the fail-closed repo-management set,
// `cli:local`, or a machine token holding `mcp:write`). Both gates are decided
// by the DATA inside the handler (command-registry.md item 22), so the commands
// declare `open` and refuse inside. Credentials NEVER travel through a command:
// `add`/`connect` return a link to the Access-gated connect page. Nothing here
// starts a run (KTD16); the dispatcher records `add`/`connect`/`remove` as
// inline runs.

export interface McpCommandDeps {
  mcp: {
    /** The MCP service, or the operator-facing reason it is off. */
    service(): Promise<McpService | { unavailable: string }>;
  };
}

const defineCommand = commandDefiner<McpCommandDeps>();

const serverName = z.string().refine((s) => MCP_SERVER_NAME_PATTERN.test(s), "expected a slug: lowercase letters, digits, dashes (≤ 32 chars)");
const serverUrl = z.string().refine((s) => /^https?:\/\/\S+$/.test(s), "expected an http(s) URL");
const scopeOption = z.enum(["me", "channel", "org"]).optional().describe("whose server: yours (`me`, default), this channel's (`channel`, channel-config rights), or org-wide (`org`, admins)");
const channelOption = z.string().optional().describe("target channel for `--scope channel` and for `list` (default: the channel you are speaking in)");
const nameArg = { name: "name", schema: serverName, describe: "the server's name (see `mcp list`)" } as const;

async function serviceOf(deps: McpCommandDeps): Promise<McpService> {
  const svc = await deps.mcp.service();
  if ("unavailable" in svc) throw new CommandError("unavailable", svc.unavailable);
  return svc;
}

/** Who may manage ORG servers: the local CLI (every scope), a machine caller
 *  whose token an admin minted with `mcp:write`, or a chat caller the
 *  fail-closed repo-management gate admits. CHANNEL servers: the `channelConfig`
 *  gate for chat callers (open when unconfigured); machine callers already
 *  passed the command's write scope. */
function actorOf(caller: Caller): McpActor {
  const machineWrite = caller.scopes instanceof Set && caller.scopes.has("mcp:write");
  return {
    id: caller.id,
    orgAdmin: caller.scopes === "all" || machineWrite || caller.chatGate?.("repoManager") === true,
    channelAdmin: caller.kind !== "chat" || caller.chatGate?.("channelConfig") === true,
  };
}

function channelOf(caller: Caller, option: string | undefined): string | undefined {
  return option ?? caller.origin?.channelId;
}

/** Service decisions become the registry's codes; anything else is a store being unreachable. */
async function via<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpServiceError) throw new CommandError(err.code, err.message);
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
}

function renderServerLine(r: JsonObject): string {
  const state = r.state === "connected" ? "✅ connected" : r.state === "static" ? "✅ static (tokenEnv)" : "⏳ awaiting credential";
  const agents = Array.isArray(r.agents) ? r.agents.join(", ") : "";
  const pinned = r.source === "config" ? " · pinned in config.yaml" : "";
  return `• \`${String(r.name)}\` (${String(r.scope)}) ${state} — ${String(r.url)} · agents: ${agents} · auth: ${String(r.auth)}${pinned}`;
}

function renderList(output: JsonValue): string {
  const o = output as JsonObject;
  const servers = Array.isArray(o.servers) ? o.servers.map((s) => s as JsonObject) : [];
  if (servers.length === 0) return "No MCP servers reach your runs here. Add one for yourself with `mcp add <name> --url <url>`; channel-config holders add channel ones with `--scope channel`, admins org-wide ones with `--scope org`.";
  return servers.map(renderServerLine).join("\n");
}

function renderAdd(output: JsonValue): string {
  const o = output as JsonObject;
  const server = o.server as JsonObject;
  const head = renderServerLine(server);
  const detected = typeof o.detected === "string" ? `\nDetected auth: ${o.detected} (pass --auth to override).` : "";
  if (typeof o.connectUrl !== "string") return `${head}${detected}\nConnected — no credential needed.`;
  const minutes = typeof o.expiresInMinutes === "number" ? o.expiresInMinutes : 10;
  const step = server.auth === "oauth" ? "sign in to the server" : "paste the server's token";
  return `${head}${detected}\nTo finish, open this link and ${step} (only you can complete it; it expires in ${minutes} min): ${o.connectUrl}`;
}

function renderShow(output: JsonValue): string {
  const o = output as JsonObject;
  const lines = [renderServerLine(o)];
  const probe = o.probe as JsonObject | undefined;
  if (probe?.ok === true && Array.isArray(probe.tools)) {
    lines.push(`Tools (${probe.tools.length}):`);
    for (const t of probe.tools.map((x) => x as JsonObject)) lines.push(`  - \`${String(t.name)}\`${t.readOnly === true ? " (read-only)" : ""}${t.description ? ` — ${String(t.description)}` : ""}`);
  } else if (probe) {
    lines.push(`Probe failed: ${String(probe.error)}`);
  }
  return lines.join("\n");
}

export const mcpList = defineCommand({
  id: "mcp.list",
  options: z.object({ channel: channelOption }),
  scope: "mcp:read",
  chatGate: "open",
  effect: "read",
  describe: "External MCP servers your runs in this channel can use — org-wide, this channel's, and your own — with state and agents; never a credential.",
  render: renderList,
  handler: async ({ options, caller, deps }) => {
    const svc = await serviceOf(deps);
    const servers = await via(() => svc.list(actorOf(caller), channelOf(caller, options.channel)));
    return { servers } as unknown as JsonObject;
  },
});

export const mcpAdd = defineCommand({
  id: "mcp.add",
  args: [{ name: "name", schema: serverName, describe: "a short slug for the server (becomes the tool prefix mcp__<name>__)" }],
  options: z.object({
    url: serverUrl.describe("the server's Streamable-HTTP endpoint (https://…/mcp)"),
    scope: scopeOption,
    agents: z
      .string()
      .transform((s) => s.split(",").map((a) => a.trim()).filter(Boolean))
      .optional()
      .describe("comma-separated agents that may use it (default general,research; only org servers may name coding/review/ship)"),
    auth: z.enum(["oauth", "bearer", "none"]).optional().describe("how the server authenticates: `oauth` (you sign in on a one-time link), `bearer` (you paste a token on a one-time link), or `none`; omit to detect it from the server"),
    channel: channelOption,
  }),
  scope: "mcp:write",
  chatGate: "open",
  effect: "write",
  describe: "Register an external MCP server for yourself, this channel, or the org — auth is detected from the server; sign-in or a token happens on a one-time link, never in chat.",
  render: renderAdd,
  handler: async ({ args, options, caller, deps }) => {
    const svc = await serviceOf(deps);
    const actor = actorOf(caller);
    const target = await via(() => svc.target(actor, options.scope ?? "me", channelOf(caller, options.channel)));
    return (await via(() => svc.add(actor, target, { name: args.name, url: options.url, agents: options.agents, ...(options.auth ? { auth: options.auth } : {}) }))) as unknown as JsonObject;
  },
});

export const mcpConnect = defineCommand({
  id: "mcp.connect",
  args: [nameArg],
  options: z.object({ scope: scopeOption, channel: channelOption }),
  scope: "mcp:write",
  chatGate: "open",
  effect: "write",
  describe: "A fresh one-time link to sign in to an OAuth server or enter (or replace) a bearer server's token — only you can complete it; it expires in 10 minutes.",
  render: renderAdd,
  handler: async ({ args, options, caller, deps }) => {
    const svc = await serviceOf(deps);
    const actor = actorOf(caller);
    const target = await via(() => svc.target(actor, options.scope ?? "me", channelOf(caller, options.channel)));
    return (await via(() => svc.connect(actor, target, args.name))) as unknown as JsonObject;
  },
});

export const mcpShow = defineCommand({
  id: "mcp.show",
  args: [nameArg],
  options: z.object({ scope: scopeOption, channel: channelOption }),
  scope: "mcp:read",
  chatGate: "open",
  effect: "read",
  describe: "One MCP server's entry plus a live probe of the tools it offers (names, read-only flags); never a credential.",
  render: renderShow,
  handler: async ({ args, options, caller, deps }) => {
    const svc = await serviceOf(deps);
    const actor = actorOf(caller);
    // Seeing is open: org and channel entries are visible to everyone who can
    // run there, so `show` resolves the tier without the management gates.
    const word = options.scope ?? "me";
    const channelId = channelOf(caller, options.channel);
    const target = word === "org" ? { kind: "org" as const } : word === "channel" ? { kind: "channel" as const, id: channelId } : { kind: "user" as const, id: actor.id };
    if (target.kind === "channel" && !target.id) throw new CommandError("invalid_input", "channel: required on this surface — pass --channel <id>");
    return (await via(() => svc.show(actor, target, args.name))) as unknown as JsonObject;
  },
});

export const mcpRemove = defineCommand({
  id: "mcp.remove",
  args: [nameArg],
  options: z.object({ scope: scopeOption, channel: channelOption }),
  scope: "mcp:write",
  chatGate: "open",
  effect: "write",
  describe: "Remove an MCP server you added and its stored credential (yours freely; channel ones need channel-config rights, org-wide ones admin rights).",
  handler: async ({ args, options, caller, deps }) => {
    const svc = await serviceOf(deps);
    const actor = actorOf(caller);
    const target = await via(() => svc.target(actor, options.scope ?? "me", channelOf(caller, options.channel)));
    return (await via(() => svc.remove(actor, target, args.name))) as unknown as JsonObject;
  },
});

export const MCP_COMMANDS: CommandDef<McpCommandDeps>[] = [mcpList, mcpAdd, mcpConnect, mcpShow, mcpRemove];

export function registerMcpCommands(registry: CommandRegistry<McpCommandDeps>): void {
  for (const cmd of MCP_COMMANDS) registry.register(cmd);
}
