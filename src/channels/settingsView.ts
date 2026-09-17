import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ChannelScopeIndexRow, ConfigDescription, Scope } from "../config.js";
import type { PickableChannel } from "../core/commands/config.js";
import { authorize } from "../core/authz/authorize.js";
import type { Capabilities } from "../core/capabilities.js";
import type { Caller, CommandInvoker, InvokeResult } from "../core/commandRegistry.js";
import type { InstallationView } from "../core/installationSettings.js";
import { NO_NAMES, namesOf, type NameDirectory } from "../core/names.js";
import type { McpServerView } from "../mcp/registry.js";
import type { AccessIdentity } from "./accessAuth.js";
import type { ChannelScopeView, ViewerSettingsView, SettingsSeed, SettingsTab, SettingsVocabulary } from "./webSeed.js";
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
// The dashboard configures the SHARED tiers — org and channel — and the
// viewer's own: a session linked to its Slack person writes the person's scope
// (record 0042), an unlinked one its own `access:<sub>` scope, the identity the
// dashboard's chat requests its runs as (record 0043). The Installation tab is
// a projection of the running config by allow-list
// (src/core/installationSettings.ts), gated on `config:read`.

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
  /** Display names for the ids the tabs show (channels, people); absent → ids. */
  names?: NameDirectory;
  /** The bound registry: the page reads through the same commands the CLI runs. */
  commands: CommandInvoker;
  /** The `/api` caller for the gate's identity (commandHttp's `callerFor`), linked to its person when the email names one. */
  callerFor(identity: AccessIdentity): Promise<Caller>;
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

/** The viewer's settings for the Channels tab's head: `config show` without a channel, the
 *  channel half dropped (there is none) and the `mcpServers` maps left to the MCPs tab. */
export function viewerSettingsView(description: ConfigDescription): ViewerSettingsView {
  const strip = (s: Scope | undefined): Omit<Scope, "mcpServers"> | undefined => {
    if (!s) return undefined;
    const { mcpServers: _servers, ...kept } = s;
    return kept;
  };
  return {
    effective: description.effective,
    defaults: description.defaults,
    restrictedAgents: description.restrictedAgents,
    user: strip(description.user) ?? {},
    ...(description.org ? { org: strip(description.org) } : {}),
  };
}

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

  const serversOf = (answer: InvokeResult): McpServerView[] =>
    answer.ok ? (((answer.value as { servers?: McpServerView[] }).servers ?? []) as McpServerView[]) : [];

  /** The rows (record 0042): an admin sees every tier (`mcp list --all`); anyone else sees
   *  the org's, the open channel's and their own, plus the channel tiers of every channel whose
   *  config they may read — the same per-channel question `config overrides` answers — the
   *  honest cut until membership exists. */
  const names = deps.names ?? NO_NAMES;
  /** The channels the viewer may pick (`config channels`); a refusal or failure offers nothing rather than failing the tab. */
  async function pickableFor(caller: Caller): Promise<{ channels: PickableChannel[]; listed: boolean } | undefined> {
    const answer = await deps.commands.invoke("config.channels", {}, caller);
    if (!answer.ok) return undefined;
    const value = answer.value as unknown as { channels: PickableChannel[]; listed: boolean };
    return { channels: value.channels, listed: value.listed };
  }
  /** One channel's name, when the directory knows it — never a throw, never a hash. */
  const channelNameOf = (id: string): Promise<string | undefined> => names.channel(id).catch(() => undefined);

  async function mcpsSeed(caller: Caller, channel: string | undefined): Promise<NonNullable<SettingsSeed["mcps"]>> {
    const write = {
      org: canWrite(caller, "mcp:write", "org"),
      channel: channel !== undefined && canWrite(caller, "mcp:write", "channel", channel),
    };
    // The channel's name is asked beside the list, never before it: one round trip, not two.
    const [channelName, listed, pickable] = await Promise.all([
      channel ? channelNameOf(channel) : Promise.resolve(undefined),
      deps.commands.invoke(
        "mcp.list",
        write.org ? { options: { all: true } } : channel ? { options: { channel } } : {},
        caller,
      ),
      pickableFor(caller),
    ]);
    const named = (rest: Omit<NonNullable<SettingsSeed["mcps"]>, "channel" | "channelName" | "pickable">) => ({
      ...(channel ? { channel } : {}),
      ...(channelName ? { channelName } : {}),
      ...(pickable ? { pickable } : {}),
      ...rest,
    });
    if (!listed.ok) return named({ servers: [], unavailable: failureText(listed), canWrite: write });
    if (write.org) return named({ allTiers: true, servers: serversOf(listed), canWrite: write });
    const servers = serversOf(listed);
    const readable = await deps.commands.invoke("config.overrides", {}, caller);
    const others = (readable.ok ? ((readable.value as { channels?: ChannelScopeIndexRow[] }).channels ?? []) : [])
      .filter((r) => r.channelId !== channel && r.settings.includes("mcpServers"))
      .map((r) => r.channelId);
    const tiers = await Promise.all(
      others.map((id) => deps.commands.invoke("mcp.list", { options: { channel: id } }, caller)),
    );
    for (const answer of tiers) for (const s of serversOf(answer)) if (s.scope === "channel") servers.push(s);
    return named({ servers, canWrite: write });
  }

  async function channelsSeed(
    caller: Caller,
    channel: string | undefined,
  ): Promise<NonNullable<SettingsSeed["channels"]>> {
    const [indexed, mine, shown, pickable] = await Promise.all([
      deps.commands.invoke("config.overrides", {}, caller),
      // The viewer's own settings, always: a settings page never has "no data" (record 0041).
      deps.commands.invoke("config.show", {}, caller),
      channel ? deps.commands.invoke("config.show", { options: { channel } }, caller) : Promise.resolve(undefined),
      // The channels the viewer may open, by name (item 7): the picker's options.
      pickableFor(caller),
    ]);
    const rows = indexed.ok
      ? (((indexed.value as { channels?: ChannelScopeIndexRow[] }).channels ?? []) as ChannelScopeIndexRow[])
      : [];
    // Names beside ids (record 0042, the dashboard reads names): one directory ask per channel, concurrent.
    const channelNames = await namesOf(channelNameOf, [...rows.map((r) => r.channelId), ...(channel ? [channel] : [])]);
    const withName = <T extends { channelId: string }>(row: T): T & { channelName?: string } => {
      const name = channelNames.get(row.channelId);
      return name ? { ...row, channelName: name } : row;
    };
    const out: NonNullable<SettingsSeed["channels"]> = indexed.ok
      ? { index: rows.map(withName) }
      : { index: [], unavailable: failureText(indexed) };
    if (mine.ok) out.viewer = viewerSettingsView(mine.value as unknown as ConfigDescription);
    else out.viewerUnavailable = failureText(mine);
    if (pickable) out.pickable = pickable;
    if (channel && shown) {
      const write = canWrite(caller, "config:write", "channel", channel);
      out.selected = withName(
        shown.ok
          ? {
              channelId: channel,
              scope: channelScopeView(shown.value as unknown as ConfigDescription),
              canWrite: write,
            }
          : { channelId: channel, refused: failureText(shown), canWrite: write },
      );
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
    const tab: SettingsTab = route.tab === "home" ? homeTab(deps.capabilities) : route.tab;
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
    // The caller is resolved once per request, linked to its person when the
    // session's email names one (record 0042) — the same resolution `/api` makes.
    deps
      .callerFor(ctx.identity)
      .then(async (caller) => {
        const base: SettingsSeed = {
          page: "settings",
          tab,
          viewer: caller.id,
          ...(caller.actor.asUser ? { asUser: caller.actor.asUser } : {}),
          vocabulary: deps.vocabulary,
        };
        if (tab === "installation") {
          // The projection is the process's own config, not a command: gated on the
          // read every browser session holds and a credential must be granted.
          if (!authorize(caller.actor, "config:read", { type: "command", id: "config.show" }).allow) {
            plain(res, 403, "forbidden");
            return;
          }
          render({ ...base, installation: deps.installation() });
          return;
        }
        const part = tab === "mcps" ? await mcpsSeed(caller, channel) : await channelsSeed(caller, channel);
        render(
          tab === "mcps"
            ? { ...base, mcps: part as SettingsSeed["mcps"] }
            : { ...base, channels: part as SettingsSeed["channels"] },
        );
      })
      .catch(failed);
    return true;
  };
}
