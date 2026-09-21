import { describe, expect, it } from "vitest";
import type { ChannelScopeIndexRow, ConfigDescription } from "../config.js";
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "../core/capabilities.js";
import type { Caller, CommandInput, CommandInvoker, InvokeResult } from "../core/commandRegistry.js";
import type { InstallationView } from "../core/installationSettings.js";
import { callerWith } from "../core/testing/callers.js";
import type { McpServerView } from "../mcp/registry.js";
import type { AccessIdentity } from "./accessAuth.js";
import {
  channelScopeView,
  viewerSettingsView,
  createSettingsViewHandler,
  homeTab,
  parseSettingsRoute,
} from "./settingsView.js";
import { SEED_ELEMENT_ID, type SettingsSeed } from "./webSeed.js";
import { makePageSender } from "./webShell.js";

// Feature: docs/reference/specs/settings-page.md items 1, 2, 4 — the settings
// view: its routes, the seed each tab carries (the answers of the registry
// commands invoked as the viewer, plus `canWrite` from the same authorize
// questions the write handlers ask), the method and gate refusals. Rendering
// is tested in web/src/pages/settings.test.ts.

// ---- fixtures ---------------------------------------------------------------

const SERVER: McpServerView = {
  name: "lake",
  scope: "org",
  scopeKey: "org",
  url: "https://vega.example.test/mcp",
  agents: ["general", "research"],
  auth: "none",
  state: "static",
  source: "config",
};

const INDEX: ChannelScopeIndexRow[] = [
  { channelId: "slack:C1", settings: ["agent", "instructions"], source: "runtime" },
];

const DESCRIPTION: ConfigDescription = {
  effective: { agent: "review", model: "anthropic/review-model", verbosity: "quiet" },
  defaults: { agent: "general", models: { general: "anthropic/general-model" } },
  channel: {
    agent: "review",
    instructions: "Be brief.",
    mcpServers: {
      lake: { url: "https://vega.example.test/mcp", auth: "none", headersEnv: { "CF-Access-Client-Id": "X" } },
    },
  },
  user: { model: "anthropic/mine" },
  org: { mcpServers: { lake: { url: "https://vega.example.test/mcp", auth: "none" } } },
  restrictedAgents: ["coding"],
  channelConfigRestricted: false,
  adminsHint: "ask an admin",
};

const INSTALLATION: InstallationView = {
  settings: [{ key: "references.enabled", value: "false", isDefault: true, how: "config", note: "linked threads" }],
  capabilities: [{ key: "mcp", on: true, how: "an mcp block" }],
};

const VOCABULARY = {
  agents: ["general", "review"],
  efforts: ["low", "high"],
  identities: ["none", "read", "write"],
  machines: ["none", "blank"],
};

type Invoke = (id: string, input: CommandInput, caller: Caller) => InvokeResult;

/** A registry that answers by command id and records what it was asked. */
function fakeCommands(
  answer: Invoke,
): CommandInvoker & { calls: { id: string; input: CommandInput; caller: string }[] } {
  const calls: { id: string; input: CommandInput; caller: string }[] = [];
  return {
    calls,
    list: () => [],
    get: () => undefined,
    invoke: async (id, input, caller) => {
      calls.push({ id, input, caller: caller.id });
      return answer(id, input, caller);
    },
    settles: () => false,
    settle: async () => undefined,
  };
}

const ok = (value: unknown): InvokeResult => ({ ok: true, value: value as never });
const refused = (message: string): InvokeResult => ({
  ok: false,
  error: "unauthorized",
  status: 403,
  message,
  decidedBy: "handler",
});

const happy: Invoke = (id) => {
  switch (id) {
    case "mcp.list":
      return ok({ servers: [SERVER] });
    case "config.overrides":
      return ok({ channels: INDEX });
    case "config.show":
      return ok(DESCRIPTION);
    default:
      return refused(`no such command ${id}`);
  }
};

const page = makePageSender({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);
const ADMIN: AccessIdentity = { sub: "admin-sub", email: "admin@example.test" };
const MEMBER: AccessIdentity = { sub: "member-sub" };

function handler(
  answer: Invoke = happy,
  opts: {
    capabilities?: typeof ALL_CAPABILITIES;
    grants?: (sub: string) => "all" | readonly string[];
    /** Channel names the directory knows; a listed id answers, any other is undefined, `"!"` throws. */
    channelNames?: Record<string, string>;
  } = {},
) {
  const commands = fakeCommands(answer);
  const grants = opts.grants ?? ((sub) => (sub === ADMIN.sub ? "all" : ["config:read", "mcp:read"]));
  const view = createSettingsViewHandler(
    {
      commands,
      ...(opts.channelNames
        ? {
            names: {
              person: async () => undefined,
              channel: async (id: string) => {
                const name = opts.channelNames![id];
                if (name === "!") throw new Error("slack down");
                return name;
              },
            },
          }
        : {}),
      callerFor: async (identity) => callerWith("access", `access:${identity.sub}`, grants(identity.sub)),
      installation: () => INSTALLATION,
      vocabulary: VOCABULARY,
      capabilities: opts.capabilities ?? ALL_CAPABILITIES,
    },
    page,
  );
  return { view, commands };
}

async function get(view: ReturnType<typeof handler>["view"], url: string, identity = ADMIN, method = "GET") {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const res = {
    writeHead: (s: number, h: Record<string, string>) => {
      status = s;
      headers = h;
    },
    end: (b?: string) => {
      body = b ?? "";
    },
  };
  const handled = view({ url, method, headers: {} } as never, res as never, { identity });
  // The handler answers asynchronously for the command-backed tabs.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { handled, status, headers, body };
}

function seedOf(html: string): SettingsSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as SettingsSeed;
}

// ---- routes -----------------------------------------------------------------

describe("parseSettingsRoute", () => {
  it("the page, its three tabs, a channel under Channels, and a channel query on MCPs", () => {
    expect(parseSettingsRoute("/settings")).toEqual({ tab: "home" });
    expect(parseSettingsRoute("/settings/")).toEqual({ tab: "home" });
    expect(parseSettingsRoute("/settings/mcps")).toEqual({ tab: "mcps" });
    expect(parseSettingsRoute("/settings/mcps", "?channel=slack:C1")).toEqual({ tab: "mcps", channel: "slack:C1" });
    expect(parseSettingsRoute("/settings/channels")).toEqual({ tab: "channels" });
    expect(parseSettingsRoute("/settings/channels/slack:C1")).toEqual({ tab: "channels", channel: "slack:C1" });
    expect(parseSettingsRoute("/settings/channels/slack%3AC1")).toEqual({ tab: "channels", channel: "slack:C1" });
    expect(parseSettingsRoute("/settings/installation")).toEqual({ tab: "installation" });
  });

  it("anything else under /settings is not a route: an unknown tab, a channel under the wrong tab, a malformed id", () => {
    for (const p of [
      "/settings/other",
      "/settings/installation/x",
      "/settings/mcps/slack:C1",
      "/settings/channels/not-namespaced",
      "/settings/channels/slack:C1/more",
      "/settings/channels/%E0%A4%A",
      "/setting",
      "/runs",
    ])
      expect(parseSettingsRoute(p), p).toBeNull();
    expect(parseSettingsRoute("/settings/mcps", "?channel=nope")).toBeNull();
  });

  it("the home tab is MCPs where the capability is on, else Channels", () => {
    expect(homeTab(ALL_CAPABILITIES)).toBe("mcps");
    expect(homeTab(NO_CAPABILITIES)).toBe("channels");
  });
});

// ---- the seed ---------------------------------------------------------------

describe("channelScopeView", () => {
  it("drops the viewer's user scope and every mcpServers map, keeps the rest", () => {
    const view = channelScopeView(DESCRIPTION);
    expect(view).toEqual({
      effective: DESCRIPTION.effective,
      defaults: DESCRIPTION.defaults,
      channel: { agent: "review", instructions: "Be brief." },
      org: {},
      restrictedAgents: ["coding"],
      channelConfigRestricted: false,
      adminsHint: "ask an admin",
    });
    expect(JSON.stringify(view)).not.toContain("mine");
    expect(JSON.stringify(view)).not.toContain("CF-Access");
  });
});

describe("the settings view", () => {
  it("falls through for other paths and answers 405 to anything but GET", async () => {
    const { view } = handler();
    expect((await get(view, "/runs")).handled).toBe(false);
    const post = await get(view, "/settings/mcps", ADMIN, "POST");
    expect(post).toMatchObject({ handled: true, status: 405 });
    expect(post.headers.allow).toBe("GET");
  });

  it("MCPs: the seed is `mcp list` invoked as the viewer, with canWrite from the org and channel questions", async () => {
    const { view, commands } = handler();
    const page = await get(view, "/settings/mcps?channel=slack:C1");
    expect(page.status).toBe(200);
    const seed = seedOf(page.body);
    expect(seed).toMatchObject({
      page: "settings",
      tab: "mcps",
      viewer: "access:admin-sub",
      vocabulary: VOCABULARY,
      mcps: { channel: "slack:C1", servers: [SERVER], canWrite: { org: true, channel: true } },
    });
    // An admin's list is every tier (record 0042): `mcp list --all`, one call.
    expect(commands.calls).toEqual([
      { id: "mcp.list", input: { options: { all: true } }, caller: "access:admin-sub" },
      { id: "config.channels", input: {}, caller: "access:admin-sub" },
    ]);
    expect(seed.mcps?.allTiers).toBe(true);
    expect(seed.channels).toBeUndefined();
    expect(seed.installation).toBeUndefined();
  });

  it("MCPs (record 0042): a viewer without org rights lists the org's, the open channel's and their own, plus the channel tiers of every channel whose config they may read — config overrides decides which, one mcp list per channel", async () => {
    const OTHER: McpServerView = {
      ...SERVER,
      name: "hub",
      scope: "channel",
      scopeKey: "channel:slack:C2",
      source: "runtime",
    };
    const { view, commands } = handler((id, input) => {
      switch (id) {
        case "mcp.list":
          return ok({
            servers:
              (input as { options?: { channel?: string } }).options?.channel === "slack:C2"
                ? [SERVER, OTHER]
                : [SERVER],
          });
        case "config.overrides":
          return ok({
            channels: [
              { channelId: "slack:C1", settings: ["agent", "mcpServers"], source: "runtime" },
              { channelId: "slack:C2", settings: ["mcpServers"], source: "runtime" },
              { channelId: "slack:C3", settings: ["agent"], source: "config" }, // no tier to list
            ],
          });
        default:
          return refused(`no such command ${id}`);
      }
    });
    const seed = seedOf((await get(view, "/settings/mcps?channel=slack:C1", MEMBER)).body);
    expect(seed.mcps).toEqual({
      channel: "slack:C1",
      servers: [SERVER, OTHER],
      canWrite: { org: false, channel: false },
    });
    expect(commands.calls.map((c) => [c.id, c.input])).toEqual([
      ["mcp.list", { options: { channel: "slack:C1" } }],
      ["config.channels", {}],
      ["config.overrides", {}],
      ["mcp.list", { options: { channel: "slack:C2" } }],
    ]);
  });

  it("MCPs: a viewer without the grants sees the same rows read-only; without a channel the channel right is false", async () => {
    const { view } = handler();
    const seed = seedOf((await get(view, "/settings/mcps", MEMBER)).body);
    expect(seed.mcps).toEqual({ servers: [SERVER], canWrite: { org: false, channel: false } });
    const admin = seedOf((await get(view, "/settings/mcps", ADMIN)).body);
    expect(admin.mcps?.canWrite).toEqual({ org: true, channel: false });
    expect(admin.mcps?.allTiers).toBe(true);
  });

  it("MCPs: `mcp list` refusing (MCP off, no read) puts its sentence on the seed in place of rows", async () => {
    const { view } = handler((id) => (id === "mcp.list" ? refused("MCP is off here") : happy(id, {}, null as never)));
    const seed = seedOf((await get(view, "/settings/mcps")).body);
    expect(seed.mcps).toEqual({ servers: [], unavailable: "MCP is off here", canWrite: { org: true, channel: false } });
  });

  it("Channels: the index is `config overrides`; a selected channel is `config show --channel` stripped of the viewer scope and mcpServers, with its own canWrite", async () => {
    const { view, commands } = handler();
    const seed = seedOf((await get(view, "/settings/channels/slack:C1")).body);
    expect(seed.tab).toBe("channels");
    expect(seed.channels).toEqual({
      index: INDEX,
      viewer: viewerSettingsView(DESCRIPTION),
      selected: { channelId: "slack:C1", scope: channelScopeView(DESCRIPTION), canWrite: true },
    });
    // The viewer's own settings are read without a channel, every time (record 0041: never "no data").
    expect(commands.calls.map((c) => c.id).sort()).toEqual([
      "config.channels",
      "config.overrides",
      "config.show",
      "config.show",
    ]);
    expect(commands.calls.filter((c) => c.id === "config.show").map((c) => c.input)).toEqual([
      {},
      { options: { channel: "slack:C1" } },
    ]);
    const bare = seedOf((await get(view, "/settings/channels")).body);
    expect(bare.channels).toEqual({ index: INDEX, viewer: viewerSettingsView(DESCRIPTION) });
    expect(bare.channels?.viewer?.user).toEqual({ model: "anthropic/mine" }); // the viewer's scope, mcpServers stripped
  });

  it("Channels and MCPs carry the channels the viewer may pick (config channels) as pickable, on both tabs; a refused or failing config channels offers nothing and fails no tab", async () => {
    const PICK = {
      listed: true,
      channels: [
        { channelId: "slack:C1", channelName: "backend", visibility: "public" },
        { channelId: "slack:C7", visibility: "private" },
      ],
    };
    const withPick: Invoke = (id, input, caller) => (id === "config.channels" ? ok(PICK) : happy(id, input, caller));
    const { view, commands } = handler(withPick);
    const channels = seedOf((await get(view, "/settings/channels")).body);
    expect(channels.channels?.pickable).toEqual(PICK);
    const mcps = seedOf((await get(view, "/settings/mcps")).body);
    expect(mcps.mcps?.pickable).toEqual(PICK);
    expect(commands.calls.filter((c) => c.id === "config.channels")).toHaveLength(2);
    // Refused (the default fake refuses an unknown id): the tabs render as before, with no pickable.
    const plain = seedOf((await get(handler().view, "/settings/channels")).body);
    expect(plain.channels).not.toHaveProperty("pickable");
    expect(seedOf((await get(handler().view, "/settings/mcps")).body).mcps).not.toHaveProperty("pickable");
  });

  it("Channels and MCPs name their channels: the index rows, the selected channel and the MCPs tab's channel carry channelName when the directory answers; an unknown or failing lookup leaves the id alone", async () => {
    const { view } = handler(happy, { channelNames: { "slack:C1": "backend", "slack:C9": "!" } });
    const seed = seedOf((await get(view, "/settings/channels/slack:C1")).body);
    expect(seed.channels?.index).toEqual([{ ...INDEX[0], channelName: "backend" }]);
    expect(seed.channels?.selected).toMatchObject({ channelId: "slack:C1", channelName: "backend" });
    const unknown = seedOf((await get(view, "/settings/channels/slack:C2")).body);
    expect(unknown.channels?.selected).not.toHaveProperty("channelName");
    const failing = seedOf((await get(view, "/settings/channels/slack:C9")).body);
    expect(failing.channels?.selected).toMatchObject({ channelId: "slack:C9" });
    expect(failing.channels?.selected).not.toHaveProperty("channelName");
    const mcps = seedOf((await get(view, "/settings/mcps?channel=slack:C1")).body);
    expect(mcps.mcps).toMatchObject({ channel: "slack:C1", channelName: "backend" });
    const bare = seedOf((await get(view, "/settings/mcps")).body);
    expect(bare.mcps).not.toHaveProperty("channelName");
    // No directory at all: exactly the old seed.
    const plain = seedOf((await get(handler().view, "/settings/channels/slack:C1")).body);
    expect(plain.channels?.index).toEqual(INDEX);
    expect(plain.channels?.selected).not.toHaveProperty("channelName");
  });

  it("Channels: a refused config show for the viewer's own settings puts its sentence beside the index, never an empty tab", async () => {
    const { view } = handler((id, input, caller) =>
      id === "config.show" && !(input as { options?: { channel?: string } }).options?.channel
        ? refused("config:read is missing")
        : happy(id, input, caller),
    );
    const seed = seedOf((await get(view, "/settings/channels", MEMBER)).body);
    expect(seed.channels).toEqual({ index: INDEX, viewerUnavailable: "config:read is missing" });
  });

  it("Channels: a refused `config show` carries the refusal beside the channel id, and a member's canWrite is false", async () => {
    const { view } = handler((id, input, caller) =>
      id === "config.show" ? refused("That channel's config is restricted.") : happy(id, input, caller),
    );
    const seed = seedOf((await get(view, "/settings/channels/slack:C9", MEMBER)).body);
    expect(seed.channels?.selected).toEqual({
      channelId: "slack:C9",
      refused: "That channel's config is restricted.",
      canWrite: false,
    });
  });

  it("Installation: the projection, for a viewer holding config:read; 403 without it", async () => {
    const { view, commands } = handler();
    const page = await get(view, "/settings/installation");
    expect(seedOf(page.body)).toMatchObject({ tab: "installation", installation: INSTALLATION });
    expect(commands.calls).toEqual([]);
    const { view: gated } = handler(happy, { grants: () => [] });
    expect(await get(gated, "/settings/installation", MEMBER)).toMatchObject({ status: 403 });
  });

  it("/settings opens on MCPs where the capability is on, else on Channels", async () => {
    expect(seedOf((await get(handler().view, "/settings")).body).tab).toBe("mcps");
    const { view } = handler(happy, { capabilities: NO_CAPABILITIES });
    expect(seedOf((await get(view, "/settings")).body).tab).toBe("channels");
  });

  it("a page sender that throws before any head is one 502 with the reason, never a second head or an unhandled rejection", async () => {
    const commands = fakeCommands(happy);
    const view = createSettingsViewHandler(
      {
        commands,
        callerFor: async (identity) => callerWith("access", `access:${identity.sub}`, "all"),
        installation: () => INSTALLATION,
        vocabulary: VOCABULARY,
        capabilities: ALL_CAPABILITIES,
      },
      () => {
        throw new Error("sender exploded");
      },
    );
    const heads: number[] = [];
    let ended = 0;
    let body = "";
    const res = {
      headersSent: false,
      writeHead(s: number) {
        heads.push(s);
        this.headersSent = true;
      },
      end(b?: string) {
        ended += 1;
        body = b ?? "";
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      view({ url: "/settings/mcps", method: "GET", headers: {} } as never, res as never, { identity: ADMIN });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(heads).toEqual([502]);
    expect(ended).toBe(1);
    expect(body).toBe("settings unavailable: sender exploded");
    expect(unhandled).toEqual([]);
  });

  it("a response that fails after the 200 was written is closed, never given a second head", async () => {
    const { view } = handler(happy);
    const heads: number[] = [];
    let ended = 0;
    const res = {
      headersSent: false,
      writeHead(s: number) {
        heads.push(s);
        this.headersSent = true;
      },
      end() {
        ended += 1;
        if (ended === 1) throw new Error("socket gone");
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      view({ url: "/settings/mcps", method: "GET", headers: {} } as never, res as never, { identity: ADMIN });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(heads).toEqual([200]);
    expect(ended).toBe(2);
    expect(unhandled).toEqual([]);
  });

  it("a registry that throws is a 502 with a capped reason, never a 500", async () => {
    const { view } = handler(() => {
      throw new Error("x".repeat(1000));
    });
    const page = await get(view, "/settings/mcps");
    expect(page.status).toBe(502);
    expect(page.body.length).toBeLessThan(450);
    expect(page.body).toMatch(/^settings unavailable: x+$/);
  });
});
