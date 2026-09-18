import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsSeed, WebSeed } from "@core/channels/webSeed.js";
import type { McpServerView } from "@core/mcp/registry.js";
import ChannelsPanel from "../components/settings/ChannelsPanel.vue";
import McpServersPanel from "../components/settings/McpServersPanel.vue";
import { settingsTabs } from "../lib/settingsTabs";
import { browser } from "../lib/browser";
import SettingsPage from "./SettingsPage.vue";
import { ALL_ON, mountApp, pickSelect, selectDisabled, selectItem, selectValue } from "../testing/mount";

// Feature: docs/reference/specs/settings-page.md items 5–8 — the settings page
// paints one tab per seed, offers MCPs only where the capability is on, and
// every write it composes is one POST to /api/<group>.<verb> naming the org or
// channel tier — and `me` only for a session linked to its person (records
// 0041, 0042). A refusal is the handler's own sentence, shown as is;
// `canWrite` disables controls and decides nothing.

const VOCABULARY = {
  agents: ["general", "review", "coding"],
  efforts: ["low", "medium", "high"],
  identities: ["none", "read", "write"],
  machines: ["none", "blank", "repo-cold", "repo-resident"],
};

const LAKE: McpServerView = {
  name: "lake",
  scope: "org",
  scopeKey: "org",
  url: "https://vega.example.test/mcp",
  agents: ["general", "research", "coding"],
  auth: "none",
  state: "static",
  source: "config",
};
const NOTION: McpServerView = {
  name: "notion",
  scope: "channel",
  scopeKey: "channel:slack:C1",
  url: "https://mcp.notion.example/mcp",
  agents: ["general", "research"],
  auth: "oauth",
  state: "awaiting_credential",
  source: "runtime",
  addedBy: "access:me",
  addedAt: 1_700_000_000_000,
};

const base = (over: Partial<SettingsSeed>): SettingsSeed => ({
  page: "settings",
  tab: "channels",
  viewer: "access:me",
  vocabulary: VOCABULARY,
  ...over,
});

const island = (seed: SettingsSeed, caps: Partial<typeof ALL_ON> = {}): WebSeed => ({
  ...seed,
  title: "Settings",
  capabilities: { ...ALL_ON, ...caps },
});

/** A fetch that records every request and answers `answer`. */
function fakeFetch(answer: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; init: RequestInit | undefined; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchFn, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe("settingsTabs", () => {
  it("MCPs only where the capability is on (or the viewer is on it); Channels and Installation always", () => {
    expect(settingsTabs(ALL_ON, "channels").map((t) => t.id)).toEqual(["mcps", "channels", "installation"]);
    expect(settingsTabs({ ...ALL_ON, mcp: false }, "channels").map((t) => t.id)).toEqual(["channels", "installation"]);
    expect(settingsTabs({ ...ALL_ON, mcp: false }, "mcps").map((t) => t.id)).toEqual([
      "mcps",
      "channels",
      "installation",
    ]);
    expect(settingsTabs(null, "installation").map((t) => t.id)).toEqual(["channels", "installation"]);
  });
});

describe("SettingsPage", () => {
  it("paints the tab the seed names, marks it current, and lights the header's settings cog", () => {
    const wrapper = mountApp(SettingsPage, {
      seed: island(base({ tab: "installation", installation: { settings: [], capabilities: [] } })),
    });
    expect(wrapper.find("h1 .title").text()).toBe("Settings");
    expect(wrapper.find('nav.tabs a[aria-current="page"]').text()).toBe("Installation");
    // Settings is chrome, not a section: no nav entry is current, the header's cog is.
    expect(wrapper.find('nav.site a[aria-current="page"]').exists()).toBe(false);
    expect(wrapper.find('.settings-link[aria-current="page"]').attributes("href")).toBe("/settings");
  });

  it("without a seed renders an application error with a reload, never a crash and never a 'no data' state", () => {
    const wrapper = mountApp(SettingsPage, { seed: null });
    expect(wrapper.find(".error").attributes("role")).toBe("alert");
    expect(wrapper.find(".error").text()).toContain("could not be loaded");
    expect(wrapper.find(".error button").text()).toBe("Reload");
    expect(wrapper.find("p.empty").exists()).toBe(false);
  });

  it("Installation: one row per knob with its value and the default mark; capabilities with their state", () => {
    const wrapper = mountApp(SettingsPage, {
      seed: island(
        base({
          tab: "installation",
          installation: {
            settings: [
              { key: "routing.auto", value: "true", isDefault: true, how: "config", note: "the router" },
              { key: "ship.maxRounds", value: "5", isDefault: false, how: "config", note: "rounds" },
              { key: "defaults.agent", value: "general", isDefault: false, how: "runtime", note: "the preset" },
            ],
            capabilities: [
              { key: "mcp", on: true, how: "an mcp block" },
              { key: "costs", on: false, how: "a costs block" },
              { key: "execution", on: "cloudflare", how: "execution.type" },
            ],
          },
        }),
      ),
    });
    const rows = wrapper.findAll("tr.setting");
    expect(rows.map((r) => r.attributes("data-key"))).toEqual(["routing.auto", "ship.maxRounds", "defaults.agent"]);
    expect(rows[0].text()).toContain("default");
    expect(rows[1].text()).not.toContain("default");
    expect(rows[2].text()).toContain("Channels tab");
    const caps = wrapper.findAll("li.capability");
    expect(caps.map((c) => c.attributes("data-on"))).toEqual(["true", "false", "cloudflare"]);
    expect(caps[2].find(".state").text()).toBe("cloudflare");
  });
});

describe("McpServersPanel", () => {
  const mcps = (over: Partial<NonNullable<SettingsSeed["mcps"]>> = {}): NonNullable<SettingsSeed["mcps"]> => ({
    servers: [LAKE, NOTION],
    canWrite: { org: true, channel: true },
    channel: "slack:C1",
    ...over,
  });

  it("lists every tier's servers with state, agents and the viewer's own mark; a static one has no Remove", () => {
    const wrapper = mountApp(McpServersPanel, { props: { mcps: mcps(), vocabulary: VOCABULARY, viewer: "access:me" } });
    const rows = wrapper.findAll("tr.server");
    expect(rows.map((r) => r.attributes("data-name"))).toEqual(["lake", "notion"]);
    expect(rows[0].text()).toContain("pinned in config.yaml");
    expect(rows[0].text()).not.toContain("Remove");
    expect(rows[1].text()).toContain("awaiting credential");
    expect(rows[1].find("td.addedby").text()).toBe("you");
    expect(rows[0].find("td.addedby").text()).toBe("");
    expect(rows[1].text()).toContain("Remove");
    expect(rows[1].text()).toContain("Connect");
  });

  it("Add posts mcp.add with the tier picked and the agents joined", async () => {
    const { fetchFn, calls } = fakeFetch({
      body: { server: { name: "vanta" }, connectUrl: "https://sb.example/mcp/connect/n1" },
    });
    const wrapper = mountApp(McpServersPanel, {
      props: { mcps: mcps({ channel: undefined }), vocabulary: VOCABULARY, viewer: "access:me", fetch: fetchFn },
    });
    await pickSelect(wrapper, "#mcp-scope", "org");
    await wrapper.find("#mcp-name").setValue("vanta");
    await wrapper.find("#mcp-url").setValue("https://mcp.vanta.example/mcp");
    await wrapper.find('input[name="agent-coding"]').setValue(true);
    await wrapper.find("form.add").trigger("submit");
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/mcp.add");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].body).toEqual({
      name: "vanta",
      url: "https://mcp.vanta.example/mcp",
      scope: "org",
      agents: "general,research,coding",
    });
    const notice = wrapper.find("p.notice");
    expect(notice.text()).toContain("Added vanta");
    expect(notice.find("a.connect").attributes("href")).toBe("https://sb.example/mcp/connect/n1");
  });

  it("the channel tier names the channel; a refusal is the handler's sentence, shown as is", async () => {
    const { fetchFn, calls } = fakeFetch({
      status: 403,
      body: { error: "unauthorized", message: "channel MCP servers are restricted here (channel config rights)." },
    });
    const wrapper = mountApp(McpServersPanel, {
      props: { mcps: mcps(), vocabulary: VOCABULARY, viewer: "access:me", fetch: fetchFn },
    });
    await wrapper.find("#mcp-name").setValue("notion2");
    await wrapper.find("#mcp-url").setValue("https://mcp.notion.example/mcp");
    await pickSelect(wrapper, "#mcp-scope", "channel");
    await wrapper.find("form.add").trigger("submit");
    await flush();
    expect(calls[0].body).toMatchObject({ scope: "channel", channel: "slack:C1" });
    expect(wrapper.find("p.notice").text()).toBe("channel MCP servers are restricted here (channel config rights).");
  });

  it("without the write right the form is disabled for the shared tiers and says why; the rows still list; the viewer's own tier stays open", async () => {
    const wrapper = mountApp(McpServersPanel, {
      props: {
        mcps: mcps({ canWrite: { org: false, channel: false }, channel: undefined }),
        vocabulary: VOCABULARY,
        viewer: "access:x",
      },
    });
    expect(wrapper.findAll("tr.server")).toHaveLength(2);
    // `me` is every session's own to write: the form opens on it, enabled.
    expect(selectValue(wrapper, "#mcp-scope")).toBe("me");
    expect((wrapper.find("#mcp-name").element as HTMLInputElement).disabled).toBe(false);
    await pickSelect(wrapper, "#mcp-scope", "org");
    expect((wrapper.find("#mcp-name").element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.find("span.restricted").text()).toContain("admins");
    expect(wrapper.findAll("tr.server button").filter((b) => (b.element as HTMLButtonElement).disabled)).toHaveLength(
      2,
    );
  });

  it("Remove asks first, then posts mcp.remove for the row's tier and reloads; Connect posts mcp.connect and shows the link", async () => {
    vi.spyOn(browser, "confirm").mockReturnValue(true);
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const { fetchFn, calls } = fakeFetch({ body: { connectUrl: "https://sb.example/mcp/connect/n2" } });
    const wrapper = mountApp(McpServersPanel, {
      props: { mcps: mcps(), vocabulary: VOCABULARY, viewer: "access:me", fetch: fetchFn },
    });
    const buttons = wrapper.findAll("tr.server")[1].findAll("button");
    await buttons.find((b) => b.text() === "Connect")!.trigger("click");
    await flush();
    expect(calls[0]).toMatchObject({
      url: "/api/mcp.connect",
      body: { name: "notion", scope: "channel", channel: "slack:C1" },
    });
    expect(wrapper.find("p.notice a.connect").attributes("href")).toBe("https://sb.example/mcp/connect/n2");
    await buttons.find((b) => b.text() === "Remove")!.trigger("click");
    await flush();
    expect(calls[1]).toMatchObject({
      url: "/api/mcp.remove",
      body: { name: "notion", scope: "channel", channel: "slack:C1" },
    });
    expect(reload).toHaveBeenCalled();
  });

  it("Added by names the person when the service could, the id otherwise, `you` for the viewer's own; an admin sees Promote on a person's runtime row, asks first, posts mcp.promote with the owner and shows the org's connect link (record 0042)", async () => {
    vi.spyOn(browser, "confirm").mockReturnValue(true);
    const HERS: McpServerView = {
      name: "vanta",
      scope: "user",
      scopeKey: "user:slack:UHER",
      url: "https://mcp.vanta.com/mcp",
      agents: ["general", "research"],
      auth: "bearer",
      state: "connected",
      source: "runtime",
      addedBy: "slack:UHER",
      addedByName: "Hana",
    };
    const HIS: McpServerView = {
      ...HERS,
      name: "notes",
      scopeKey: "user:slack:UHIS",
      addedBy: "slack:UHIS",
      addedByName: undefined,
    };
    const { fetchFn, calls } = fakeFetch({
      body: { connectUrl: "https://sb.example/mcp/connect/n9", promotedFrom: "slack:UHER" },
    });
    const wrapper = mountApp(McpServersPanel, {
      props: {
        mcps: mcps({ servers: [LAKE, NOTION, HERS, HIS], allTiers: true }),
        vocabulary: VOCABULARY,
        viewer: "access:me",
        fetch: fetchFn,
      },
    });
    expect(wrapper.text()).toContain("every tier");
    const rows = wrapper.findAll("tr.server");
    expect(rows.map((r) => r.find("td.addedby").text())).toEqual(["", "you", "Hana", "slack:UHIS"]);
    expect(rows[2].find("span.owner").text()).toBe("slack:UHER");
    expect(rows[0].text()).not.toContain("Promote"); // an org row is not promotable
    expect(rows[1].text()).not.toContain("Promote"); // nor a channel row
    await rows[2]
      .findAll("button")
      .find((b) => b.text() === "Promote")!
      .trigger("click");
    await flush();
    expect(browser.confirm).toHaveBeenCalledWith(expect.stringContaining("credential is never copied"));
    expect(calls[0]).toMatchObject({ url: "/api/mcp.promote", body: { name: "vanta", from: "slack:UHER" } });
    expect(wrapper.find("p.notice").text()).toContain("org server awaiting your credential");
    expect(wrapper.find("p.notice a.connect").attributes("href")).toBe("https://sb.example/mcp/connect/n9");
    // Without the org right there is no Promote to press.
    const member = mountApp(McpServersPanel, {
      props: {
        mcps: mcps({ servers: [LAKE, HERS], canWrite: { org: false, channel: false } }),
        vocabulary: VOCABULARY,
        viewer: "access:me",
      },
    });
    expect(member.text()).not.toContain("Promote");
  });

  it("reads as people and chips: a user row's owner and `promoted from` show names when the view carries them, the id otherwise; agents are the run page's hue chips; a row a higher tier shadows is marked, dimmed and offers no Promote", () => {
    const HERS: McpServerView = {
      name: "vanta",
      scope: "user",
      scopeKey: "user:slack:UHER",
      url: "https://mcp.vanta.com/mcp",
      agents: ["general", "coding", "explore"],
      auth: "bearer",
      state: "connected",
      source: "runtime",
      addedBy: "slack:UHER",
      addedByName: "Hana",
      ownerName: "Hana",
      shadowedBy: "org",
    };
    const ORGS: McpServerView = {
      ...HERS,
      scope: "org",
      scopeKey: "org",
      state: "awaiting_credential",
      addedBy: "access:me",
      addedByName: undefined,
      ownerName: undefined,
      shadowedBy: undefined,
      promotedFrom: "slack:UHER",
      promotedFromName: "Hana",
    };
    const wrapper = mountApp(McpServersPanel, {
      props: { mcps: mcps({ servers: [ORGS, HERS], allTiers: true }), vocabulary: VOCABULARY, viewer: "access:me" },
    });
    const [org, hers] = wrapper.findAll("tr.server");
    expect(org.find("td.addedby").text()).toBe("youpromoted from Hana");
    expect(org.find("span.shadow").exists()).toBe(false);
    expect(hers.find("span.owner").text()).toBe("Hana");
    expect(hers.find("span.shadow").text()).toBe("shadowed by org");
    expect(hers.classes()).toContain("shadowed");
    expect(hers.text()).not.toContain("Promote");
    expect(hers.findAll("span.agent").map((c) => [c.text(), c.attributes("data-agent-hue")])).toEqual([
      ["general", "general"],
      ["coding", "coding"],
      ["explore", "other"],
    ]);
    expect(hers.find("span.agent").classes().join(" ")).toContain("text-info"); // the run page's `general` hue
    // Without names the ids stand.
    const plain = mountApp(McpServersPanel, {
      props: {
        mcps: mcps({ servers: [{ ...HERS, ownerName: undefined, shadowedBy: undefined, addedByName: undefined }] }),
        vocabulary: VOCABULARY,
        viewer: "access:me",
      },
    });
    expect(plain.find("span.owner").text()).toBe("slack:UHER");
    expect(plain.find("td.addedby").text()).toBe("slack:UHER");
    expect(plain.text()).toContain("Promote");
  });

  it("a connect link opens in a new tab and the page watches the row it was minted for: one mcp list every few seconds, a reload when its state changes, nothing after the link's life", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(browser, "confirm").mockReturnValue(true);
      const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
      const HERS: McpServerView = {
        name: "vanta",
        scope: "user",
        scopeKey: "user:slack:UHER",
        url: "https://mcp.vanta.com/mcp",
        agents: ["general"],
        auth: "bearer",
        state: "connected",
        source: "runtime",
        addedBy: "slack:UHER",
      };
      let orgState: McpServerView["state"] = "awaiting_credential";
      const calls: string[] = [];
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        const body =
          init?.method === "POST"
            ? { connectUrl: "https://sb.example/mcp/connect/n9", promotedFrom: "slack:UHER" }
            : { servers: [{ ...HERS, scope: "org", scopeKey: "org", state: orgState }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      });
      const wrapper = mountApp(McpServersPanel, {
        props: {
          mcps: mcps({ servers: [HERS], allTiers: true }),
          vocabulary: VOCABULARY,
          viewer: "access:me",
          fetch: fetchFn,
        },
      });
      await wrapper.findAll("tr.server button")[1].trigger("click");
      await vi.advanceTimersByTimeAsync(0);
      const link = wrapper.find("p.notice a.connect");
      expect(link.attributes("target")).toBe("_blank");
      expect(link.attributes("rel")).toBe("noopener");
      expect(wrapper.find("span.watching").exists()).toBe(true);
      expect(calls).toEqual(["POST /api/mcp.promote"]);
      // Two ticks while the org copy still awaits: asked, not reloaded.
      await vi.advanceTimersByTimeAsync(4_000);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(calls.slice(1)).toEqual(["GET /api/mcp.list?all=true", "GET /api/mcp.list?all=true"]);
      expect(reload).not.toHaveBeenCalled();
      // The admin completes the link in the other tab: the next tick sees the state change and reloads once.
      orgState = "connected";
      await vi.advanceTimersByTimeAsync(4_000);
      expect(reload).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(calls).toHaveLength(4); // the watch stopped with the reload
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MCP off: the reason in place of the table and no form", () => {
    const wrapper = mountApp(McpServersPanel, {
      props: {
        mcps: { servers: [], unavailable: "MCP is not enabled here.", canWrite: { org: false, channel: false } },
        vocabulary: VOCABULARY,
        viewer: "access:me",
      },
    });
    expect(wrapper.find("p.unavailable").text()).toBe("MCP is not enabled here.");
    expect(wrapper.find("form.add").exists()).toBe(false);
  });
});

describe("ChannelsPanel", () => {
  const INDEX = [
    { channelId: "slack:C1", settings: ["agent", "instructions"] as never[], source: "runtime" as const },
    { channelId: "slack:C2", settings: ["models"] as never[], source: "config" as const },
  ];
  const SCOPE = {
    effective: {
      agent: "review",
      model: "anthropic/review-model",
      effort: "medium" as const,
      verbosity: "quiet" as const,
    },
    defaults: { agent: "general", models: { general: "anthropic/general-model", review: "anthropic/review-model" } },
    channel: {
      agent: "review",
      instructions: "Be brief.",
      boundary: { maxMinutes: 45, machines: ["none", "blank"] as never[] },
    },
    restrictedAgents: ["coding"],
    channelConfigRestricted: false,
    adminsHint: "Ask an admin.",
  };
  const channels = (
    over: Partial<NonNullable<SettingsSeed["channels"]>> = {},
  ): NonNullable<SettingsSeed["channels"]> => ({
    index: INDEX,
    ...over,
  });

  it("shows the viewer's own settings first — what a run gets, the defaults, their own scope or the sentence that nothing is theirs yet; a refusal is shown as is (record 0041: never a 'no data' state)", () => {
    const VIEWER = {
      effective: {
        agent: "general",
        model: "anthropic/general-model",
        effort: "low" as const,
        verbosity: "quiet" as const,
      },
      defaults: { agent: "general", models: { general: "anthropic/general-model", review: "anthropic/review-model" } },
      restrictedAgents: ["coding"],
      user: { model: "anthropic/mine", effort: "low" as const },
    };
    const wrapper = mountApp(ChannelsPanel, {
      props: { channels: channels({ viewer: VIEWER }), vocabulary: VOCABULARY },
    });
    expect(wrapper.find("section.mine .effective").text()).toBe("agent general · anthropic/general-model · effort low");
    expect(wrapper.find("section.mine .defaults").text()).toContain("review → anthropic/review-model");
    expect(wrapper.find("section.mine .yours").text()).toBe("model anthropic/mineeffort low");
    const bare = mountApp(ChannelsPanel, {
      props: { channels: channels({ viewer: { ...VIEWER, user: {} }, index: [] }), vocabulary: VOCABULARY },
    });
    expect(bare.find("section.mine .yours").text()).toBe("Nothing of your own yet — the defaults apply.");
    expect(bare.find("ul.index").exists()).toBe(false);
    expect(bare.find("p.empty").text()).toContain("Every channel runs on the defaults");
    const refused = mountApp(ChannelsPanel, {
      props: { channels: channels({ viewerUnavailable: "config:read is missing" }), vocabulary: VOCABULARY },
    });
    expect(refused.find("section.mine").exists()).toBe(false);
    expect(refused.find("p.unavailable").text()).toBe("config:read is missing");
  });

  it("lists the configured channels as links with their setting names and source, and a placeholder until one is picked", () => {
    const wrapper = mountApp(ChannelsPanel, { props: { channels: channels(), vocabulary: VOCABULARY } });
    const items = wrapper.findAll("ul.index li");
    expect(items.map((i) => i.attributes("data-channel"))).toEqual(["slack:C1", "slack:C2"]);
    expect(items[0].find("a").attributes("href")).toBe("/settings/channels/slack%3AC1");
    expect(items[0].text()).toContain("agent, instructions · runtime");
    expect(items[1].text()).toContain("config.yaml");
    expect(wrapper.find(".placeholder").exists()).toBe(true);
  });

  it("the selected channel's scope fills the form; Save posts config.set with the channel and only the filled fields", async () => {
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const { fetchFn, calls } = fakeFetch({ body: { scope: "channel", effective: {} } });
    const wrapper = mountApp(ChannelsPanel, {
      props: {
        channels: channels({ selected: { channelId: "slack:C1", scope: SCOPE, canWrite: true } }),
        vocabulary: VOCABULARY,
        fetch: fetchFn,
      },
    });
    expect(wrapper.find(".effective").text()).toContain("review");
    expect(selectValue(wrapper, "#ch-agent")).toBe("review");
    expect((wrapper.find("#ch-minutes").element as HTMLInputElement).value).toBe("45");
    expect((wrapper.find("#ch-instructions").element as HTMLTextAreaElement).value).toBe("Be brief.");
    await wrapper.find('input[name="models.coding"]').setValue("anthropic/claude-opus-5");
    await pickSelect(wrapper, "#ch-identity", "read");
    await wrapper.find("form.agent-form").trigger("submit");
    await flush();
    expect(calls[0].url).toBe("/api/config.set");
    expect(calls[0].body).toEqual({
      scope: "channel",
      channel: "slack:C1",
      agent: "review",
      models: { coding: "anthropic/claude-opus-5" },
      boundary: { maxMinutes: 45, maxIdentity: "read", machines: "none,blank" },
    });
    expect(reload).toHaveBeenCalled();
  });

  it("instructions have their own save and clear (an empty text clears); Clear every override asks first, then posts config.clear", async () => {
    vi.spyOn(browser, "confirm").mockReturnValue(true);
    vi.spyOn(browser, "reload").mockImplementation(() => {});
    const { fetchFn, calls } = fakeFetch({ body: {} });
    const wrapper = mountApp(ChannelsPanel, {
      props: {
        channels: channels({ selected: { channelId: "slack:C1", scope: SCOPE, canWrite: true } }),
        vocabulary: VOCABULARY,
        fetch: fetchFn,
      },
    });
    await wrapper.find("#ch-instructions").setValue("Always reply in bullets.");
    await wrapper.find("form.instructions-form").trigger("submit");
    await flush();
    expect(calls[0]).toMatchObject({
      url: "/api/config.instructions",
      body: { scope: "channel", channel: "slack:C1", text: "Always reply in bullets." },
    });
    const buttons = wrapper.findAll("button");
    await buttons.find((b) => b.text() === "Clear instructions")!.trigger("click");
    await flush();
    expect(calls[1].body).toEqual({ scope: "channel", channel: "slack:C1", text: "" });
    await buttons.find((b) => b.text() === "Clear every override")!.trigger("click");
    await flush();
    expect(calls[2]).toMatchObject({ url: "/api/config.clear", body: { scope: "channel", channel: "slack:C1" } });
    for (const c of calls) expect(JSON.stringify(c.body)).not.toContain('"me"');
  });

  it("read-only for a viewer without the right: every control disabled, the hint shown; a refused channel shows the refusal", () => {
    const readOnly = mountApp(ChannelsPanel, {
      props: {
        channels: channels({ selected: { channelId: "slack:C1", scope: SCOPE, canWrite: false } }),
        vocabulary: VOCABULARY,
      },
    });
    expect(readOnly.find("p.restricted").text()).toContain("Ask an admin.");
    for (const el of readOnly.findAll("form.agent-form input, form.agent-form button"))
      expect((el.element as HTMLInputElement).disabled).toBe(true);
    // The styled selects are buttons too, disabled through their prop: every one of them.
    for (const id of ["#ch-agent", "#ch-effort", "#ch-identity"]) expect(selectDisabled(readOnly, id), id).toBe(true);
    const refused = mountApp(ChannelsPanel, {
      props: {
        channels: channels({
          selected: { channelId: "slack:C9", refused: "That channel's config is restricted.", canWrite: false },
        }),
        vocabulary: VOCABULARY,
      },
    });
    expect(refused.find(".refused").text()).toContain("That channel's config is restricted.");
  });

  it("a refusal on Save is shown as is, and nothing reloads", async () => {
    const reload = vi.spyOn(browser, "reload").mockImplementation(() => {});
    const { fetchFn } = fakeFetch({
      status: 403,
      body: { error: "unauthorized", message: "Channel config changes are restricted." },
    });
    const wrapper = mountApp(ChannelsPanel, {
      props: {
        channels: channels({ selected: { channelId: "slack:C1", scope: SCOPE, canWrite: true } }),
        vocabulary: VOCABULARY,
        fetch: fetchFn,
      },
    });
    await wrapper.find("form.agent-form").trigger("submit");
    await flush();
    expect(wrapper.find("p.notice").text()).toBe("Channel config changes are restricted.");
    expect(reload).not.toHaveBeenCalled();
  });

  it("the open field navigates to the channel's page", async () => {
    const navigate = vi.spyOn(browser, "navigate").mockImplementation(() => {});
    const wrapper = mountApp(ChannelsPanel, { props: { channels: channels(), vocabulary: VOCABULARY } });
    await wrapper.find("#channel-open").setValue("slack:C7");
    await wrapper.find("#channel-open").trigger("submit");
    await flush();
    expect(navigate).toHaveBeenCalledWith("/settings/channels/slack%3AC7");
  });
});

// Feature: docs/decisions/0042 — a session linked to its person gets the `me` tier on the MCPs tab.
describe("McpServersPanel for a linked session (record 0042)", () => {
  const MINE: McpServerView = {
    name: "mine",
    scope: "user",
    scopeKey: "user:slack:UME",
    url: "https://mcp.mine.example/mcp",
    agents: ["general", "research"],
    auth: "none",
    state: "connected",
    source: "runtime",
    addedBy: "slack:UME",
  };
  const seed = { servers: [LAKE, MINE], canWrite: { org: false, channel: false } };

  it("offers and defaults to the me tier, marks the person's row as mine and writable, and Add posts scope me", async () => {
    const { fetchFn, calls } = fakeFetch({ body: { server: { name: "notes" } } });
    const wrapper = mountApp(McpServersPanel, {
      props: {
        mcps: seed,
        vocabulary: VOCABULARY,
        viewer: "access:me",
        asUser: { id: "slack:UME", name: "me" },
        fetch: fetchFn,
      },
    });
    expect(selectValue(wrapper, "#mcp-scope")).toBe("me");
    const mine = wrapper.findAll("tr.server")[1];
    expect(mine.find("td.addedby").text()).toBe("you");
    expect(mine.findAll("button").filter((b) => (b.element as HTMLButtonElement).disabled)).toHaveLength(0);
    await wrapper.find("#mcp-name").setValue("notes");
    await wrapper.find("#mcp-url").setValue("https://mcp.notes.example/mcp");
    await wrapper.find("form.add").trigger("submit");
    await flush();
    expect(calls[0].body).toEqual({
      name: "notes",
      url: "https://mcp.notes.example/mcp",
      scope: "me",
      agents: "general,research",
    });
  });

  it("an unlinked session's me is its own (record 0043): offered and defaulted, Add posts scope me, its own row is mine and writable, the person's row read-only", async () => {
    const OWN: McpServerView = { ...MINE, name: "own", scopeKey: "user:access:x", addedBy: "access:x" };
    const { fetchFn, calls } = fakeFetch({ body: { server: { name: "notes" } } });
    const wrapper = mountApp(McpServersPanel, {
      props: {
        mcps: { ...seed, servers: [LAKE, MINE, OWN] },
        vocabulary: VOCABULARY,
        viewer: "access:x",
        fetch: fetchFn,
      },
    });
    expect(selectValue(wrapper, "#mcp-scope")).toBe("me");
    const option = selectItem(wrapper, "#mcp-scope", "me");
    expect(option.disabled ?? false).toBe(false);
    expect(option.label).toContain("your own runs from this dashboard");
    const [, theirs, own] = wrapper.findAll("tr.server");
    expect(theirs.find("td.addedby").text()).not.toBe("you");
    expect(theirs.findAll("button").filter((b) => (b.element as HTMLButtonElement).disabled).length).toBeGreaterThan(0);
    expect(own.find("td.addedby").text()).toBe("you");
    expect(own.findAll("button").filter((b) => (b.element as HTMLButtonElement).disabled)).toHaveLength(0);
    await wrapper.find("#mcp-name").setValue("notes");
    await wrapper.find("#mcp-url").setValue("https://mcp.notes.example/mcp");
    await wrapper.find("form.add").trigger("submit");
    await flush();
    expect(calls[0].body).toEqual({
      name: "notes",
      url: "https://mcp.notes.example/mcp",
      scope: "me",
      agents: "general,research",
    });
  });
});
