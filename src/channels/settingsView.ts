import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ChannelScopeIndexRow, ConfigDescription, Scope } from "../config.js";
import { authorize } from "../core/authz/authorize.js";
import type { Capabilities } from "../core/capabilities.js";
import type { Caller, CommandInvoker, InvokeResult } from "../core/commandRegistry.js";
import type { InstallationView } from "../core/installationSettings.js";
import type { McpServerView } from "../mcp/registry.js";
import type { AccessIdentity } from "./accessAuth.js";
import type { ChannelScopeView, SettingsSeed, SettingsTab, SettingsVocabulary } from "./webSeed.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";

// The settings page (docs/decisions/0041, docs/reference/specs/settings-page.md):
// `GET /settings` and its three tabs, behind the dashboard gate like every
// other section. The view is an adapter over the command registry and nothing
// more: each tab's seed is the answer of the registry commands invoked AS THE
// VIEWER (`mcp list`, `config overrides`, `config show --channel`), so the page
// can see exactly what the same identity could read on the CLI; the write
// rights it carries (`canWrite`) are the same `authorize` questions the write
// handlers ask, and the page uses them to disable controls, never to decide.
// Every button on the page is one `POST /api/<group>.<verb>` (commandHttp.ts).
//
// The dashboard configures the SHARED tiers — org and channel. There is no
// `me` here: a browser session is `access:<sub>`, a run is requested as a chat
// user, and the config and MCP handlers refuse a `me` write from the Access
// surface (record 0041). The Installation tab is a projection of the running
// config by allow-list (src/core/installationSettings.ts), gated on `config:read`.

export type SettingsRoute =
  { tab: "home" } | { tab: "mcps"; channel?: string } | { tab: "channels"; channel?: string } | { tab: "installation" };

/** Platform-namespaced channel ids as the config scopes key them (`slack:C…`, `http:ops`). */
const CHANNEL_ID_RE = /^[a-z]+:[A-Za-z0-9_.:-]{1,80}$/;

/** `/settings`, `/settings/<tab>` and `/settings/channels/<channel id>`; a
 *  `?channel=` on the MCPs tab lists that channel's tier beside org and own.
 *  Anything else under `/settings` is not a route here: the handler returns
 *  false and the gated chain in src/index.ts falls through to its plain `ok`,
 *  as for every other section's unmatched path. */
export function parseSettingsRoute(pathname: string, search = ""): SettingsRoute | null {
  if (pathname === "/settings" || pathname === "/settings/") return { tab: "home" };
  const m = /^\/settings\/(mcps|channels|installation)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return null;
  const [, tab, rest] = m;
  if (tab === "installation") return rest ? null : { tab: "installation" };
  let channel: string | undefined;
  if (tab === "channels" && rest !== undefined) {
    try {
      channel = decodeURIComponent(rest);
    } catch {
      return null;
    }
    if (!CHANNEL_ID_RE.test(channel)) return null;
    return { tab: "channels", channel };
  }
  if (rest !== undefined) return null;
  if (tab === "mcps") {
    const q = new URLSearchParams(search).get("channel");
    if (q !== null) {
      if (!CHANNEL_ID_RE.test(q)) return null;
      channel = q;
    }
    return channel ? { tab: "mcps", channel } : { tab: "mcps" };
  }
  return { tab: "channels" };
}

export interface SettingsViewDeps {
  /** The bound registry: the page reads through the same commands the CLI runs. */
  commands: CommandInvoker;
  /** The `/api` caller for the gate's identity (commandHttp's `callerFor`). */
  callerFor(identity: AccessIdentity): Caller;
  /** The Installation tab's rows: the running config projected by allow-list. */
  installation(): InstallationView;
  vocabulary: SettingsVocabulary;
  capabilities: Capabilities;
}

export interface SettingsViewContext {
  identity: AccessIdentity;
}

const UPSTREAM_REASON_MAX = 400;

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(body);
}

const failureText = (r: Extract<InvokeResult, { ok: false }>) => r.message;

/** `config show`'s answer as the page shows it: no viewer scope, no `mcpServers`. */
export function channelScopeView(description: ConfigDescription): ChannelScopeView {
  const { user: _user, channel, org, ...rest } = description;
  const strip = (s: Scope | undefined): Omit<Scope, "mcpServers"> | undefined => {
    if (!s) return undefined;
    const { mcpServers: _servers, ...kept } = s;
    return kept;
  };
  return { ...rest, channel: strip(channel) ?? {}, ...(org ? { org: strip(org) } : {}) };
}

/** The tab `/settings` opens on: MCPs where the capability is on, else Channels. */
export function homeTab(caps: Capabilities): SettingsTab {
  return caps.mcp ? "mcps" : "channels";
}

export function createSettingsViewHandler(
  deps: SettingsViewDeps,
  shell: ShellRenderer,
): (req: HttpRequest, res: ServerResponse, ctx: SettingsViewContext) => boolean {
  const canWrite = (caller: Caller, action: "mcp:write" | "config:write", kind: "org" | "channel", id?: string) =>
    authorize(
      caller.actor,
      action,
      kind === "org" ? { type: "config-scope", kind: "org" } : { type: "config-scope", kind: "channel", id: id ?? "" },
    ).allow;

  async function mcpsSeed(caller: Caller, channel: string | undefined): Promise<NonNullable<SettingsSeed["mcps"]>> {
    const listed = await deps.commands.invoke("mcp.list", channel ? { options: { channel } } : {}, caller);
    const write = {
      org: canWrite(caller, "mcp:write", "org"),
      channel: channel !== undefined && canWrite(caller, "mcp:write", "channel", channel),
    };
    if (!listed.ok)
      return { ...(channel ? { channel } : {}), servers: [], unavailable: failureText(listed), canWrite: write };
    const servers = ((listed.value as { servers?: McpServerView[] }).servers ?? []) as McpServerView[];
    return { ...(channel ? { channel } : {}), servers, canWrite: write };
  }

  async function channelsSeed(
    caller: Caller,
    channel: string | undefined,
  ): Promise<NonNullable<SettingsSeed["channels"]>> {
    const [indexed, shown] = await Promise.all([
      deps.commands.invoke("config.overrides", {}, caller),
      channel ? deps.commands.invoke("config.show", { options: { channel } }, caller) : Promise.resolve(undefined),
    ]);
    const out: NonNullable<SettingsSeed["channels"]> = indexed.ok
      ? { index: ((indexed.value as { channels?: ChannelScopeIndexRow[] }).channels ?? []) as ChannelScopeIndexRow[] }
      : { index: [], unavailable: failureText(indexed) };
    if (channel && shown) {
      const write = canWrite(caller, "config:write", "channel", channel);
      out.selected = shown.ok
        ? { channelId: channel, scope: channelScopeView(shown.value as unknown as ConfigDescription), canWrite: write }
        : { channelId: channel, refused: failureText(shown), canWrite: write };
    }
    return out;
  }

  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseSettingsRoute(url.pathname, url.search);
    if (!route) return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      plain(res, 405, "method not allowed", { allow: "GET" });
      return true;
    }
    const caller = deps.callerFor(ctx.identity);
    const tab: SettingsTab = route.tab === "home" ? homeTab(deps.capabilities) : route.tab;
    const base: SettingsSeed = { page: "settings", tab, viewer: caller.id, vocabulary: deps.vocabulary };
    const failed = (err: unknown) => {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, UPSTREAM_REASON_MAX);
      // A failure after the 200 was written (the shell threw mid-render) can
      // no longer change the status: close the response rather than throw a
      // second writeHead inside the catch and leave the rejection unhandled.
      if (res.headersSent) {
        console.error(`[settings] render failed after the head was sent: ${reason}`);
        res.end();
        return;
      }
      plain(res, 502, `settings unavailable: ${reason}`);
    };
    const render = (seed: SettingsSeed) => {
      res.writeHead(200, WEB_HTML_HEADERS);
      res.end(shell("Settings", seed));
    };
    const channel = "channel" in route ? route.channel : undefined;
    if (tab === "installation") {
      // The projection is the process's own config, not a command: gated on the
      // read every browser session holds and a credential must be granted.
      if (!authorize(caller.actor, "config:read", { type: "command", id: "config.show" }).allow) {
        plain(res, 403, "forbidden");
        return true;
      }
      render({ ...base, installation: deps.installation() });
      return true;
    }
    const build = tab === "mcps" ? mcpsSeed(caller, channel) : channelsSeed(caller, channel);
    build
      .then((part) =>
        render(
          tab === "mcps"
            ? { ...base, mcps: part as SettingsSeed["mcps"] }
            : { ...base, channels: part as SettingsSeed["channels"] },
        ),
      )
      .catch(failed);
    return true;
  };
}
