import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../config.js";
import { MAX_INSTRUCTIONS_LENGTH } from "../../config/validate.js";
import { chatCallerFor, handleChatCommand, parseChatCommand } from "../commandChat.js";
import {
  CommandRegistry,
  bindCommands,
  renderText,
  type AuditEntry,
  type Caller,
  type CommandInvoker,
} from "../commandRegistry.js";
import { chatActorOf } from "../authz/actor.js";
import { effectiveGrants } from "../authz/authorize.js";
import { callerWith } from "../testing/callers.js";
import { EFFORT_LEVELS } from "../../effort.js";
import { HARNESS_NAMES } from "../harness/roster.js";
import { helpRows, parseInvocation, tokenize } from "../commandSurface.js";
import {
  configCommands,
  configSet,
  ME_GITHUB_MESSAGE,
  ME_ON_SERVICE_TOKEN_MESSAGE,
  registerConfigCommands,
  type ConfigCommandDeps,
} from "./config.js";

// Feature: docs/reference/specs/routing-and-config.md items 5, 9 / docs/reference/specs/command-registry.md
// (phase 4b): `config show|set|clear|instructions` as registry commands. The
// caller's channel is the default target; `me` is always open; the `channel`
// scope rides `config:write` (never a baseline: admins and the granted) inside the handler;
// dotted options (`--models.coding x`) nest; none of it reaches a model.

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    review: anthropic/review-model
    coding: anthropic/coding-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
restrict:
  agents: [coding]
`;
/** The fixture with UX granted `config:write` — channel-scope writes open to them. */
const OPEN_YAML = YAML.replace("restrict:\n", '  "slack:UX": { actions: [config:write] }\nrestrict:\n');

function store(yaml = YAML): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-cfgcmd-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
}

function bind(
  config: ConfigStore,
  channelVisibility?: ConfigCommandDeps["channelVisibility"],
  more: Pick<ConfigCommandDeps, "channels" | "names"> = {},
): CommandInvoker {
  const registry = new CommandRegistry<ConfigCommandDeps>({ audit: () => {} });
  registerConfigCommands(registry);
  return bindCommands(registry, {
    config: { ...configDeps(config), agentNames: () => ["general", "review", "coding"] },
    ...(channelVisibility ? { channelVisibility } : {}),
    ...more,
  });
}

function configDeps(config: ConfigStore) {
  return {
    describeConfig: async (c: string, u: string) => config.describeConfig(c, u),
    scopes: async (c: string, u: string) => config.scopes(c, u),
    setChannelOverride: (c: string, p: Parameters<ConfigStore["setChannelOverride"]>[1]) =>
      config.setChannelOverride(c, p),
    setUserOverride: (u: string, p: Parameters<ConfigStore["setUserOverride"]>[1]) => config.setUserOverride(u, p),
    setThreadOverride: (t: string, p: Parameters<ConfigStore["setThreadOverride"]>[1]) =>
      config.setThreadOverride(t, p),
    clearChannelOverride: (c: string) => config.clearChannelOverride(c),
    clearUserOverride: (u: string) => config.clearUserOverride(u),
    clearUserGithub: (u: string) => config.clearUserGithub(u),
    githubBindingConflict: async (u: string, b: { login: string; id: number }) => config.githubBindingConflict(u, b),
    clearThreadOverride: (t: string) => config.clearThreadOverride(t),
    setOrgOverride: (p: Parameters<ConfigStore["setOrgOverride"]>[0]) => config.setOrgOverride(p),
    setRepoOverride: (r: string, p: Parameters<ConfigStore["setRepoOverride"]>[1]) => config.setRepoOverride(r, p),
    clearRepoOverride: (r: string) => config.clearRepoOverride(r),
    channelsWithScope: async () => config.channelsWithScope(),
  };
}

/** The Caller the chat adapter resolves for a Slack person under this config (grants from `grantsFor`). */
const chat = (config: ConfigStore, userId: string, channelId = "slack:CX"): Caller =>
  chatCallerFor({ userId, channelId, threadKey: `${channelId}:1.0` }, config);
const mcp = (...actions: string[]): Caller => callerWith("mcp", "mcp:alice", actions);

/** A chat line through the shared grammar → the invoke result + rendered text. */
async function say(commands: CommandInvoker, text: string, caller: Caller) {
  const tokens = tokenize(text);
  if (!tokens.ok) throw new Error(tokens.error);
  const [group, verb, ...rest] = tokens.tokens;
  const id = `${group}.${verb}`;
  const bound = parseInvocation(commands.get(id)!, rest);
  if (bound.kind !== "invoke") throw new Error(JSON.stringify(bound));
  const res = await commands.invoke(id, bound.input, caller);
  return { res, text: res.ok ? renderText(commands.get(id)!, res.value) : `${res.error}: ${res.message}` };
}

describe("config show", () => {
  it("describes the caller's channel + user (the same text `ConfigStore.describe` produced) and is open to everyone", async () => {
    const config = store();
    const commands = bind(config);
    const { res, text } = await say(commands, "config show", chat(config, "slack:UX"));
    expect(res.ok).toBe(true);
    expect(text).toBe(config.describe("slack:CX", "slack:UX"));
    expect(text).toContain("*Effective for you in this channel:* agent `general`, model `anthropic/general-model`");
    expect(text).toContain("*Not available to you:* `coding` (ask slack:UADMIN)");
    expect(res.ok && res.value).toMatchObject({
      effective: { agent: "general" },
      restrictedAgents: ["coding"],
      channelConfigRestricted: true, // config:write is never a baseline
    });
  });

  it("channelConfigRestricted is decided for the CALLER's actor (the config:write row `config set channel` asks), not for an id the store looks up: the CLI's `all` is never restricted, a token without config:write is, the admin is not — under a `channelConfig: []` store", async () => {
    const gated = store();
    const commands = bind(gated);
    const show = (caller: Caller) =>
      commands.invoke("config.show", { args: [], options: { channel: "slack:CX" } }, caller);
    expect(await show(callerWith("cli", "cli:local", "all"))).toMatchObject({
      ok: true,
      value: { channelConfigRestricted: false },
    });
    expect(await show(mcp("config:read"))).toMatchObject({ ok: true, value: { channelConfigRestricted: true } });
    expect(await show(mcp("config:read", "config:write"))).toMatchObject({
      ok: true,
      value: { channelConfigRestricted: false },
    });
    expect(await show(chat(gated, "slack:UADMIN"))).toMatchObject({
      ok: true,
      value: { channelConfigRestricted: false },
    });
    expect(await show(chat(gated, "slack:UX"))).toMatchObject({ ok: true, value: { channelConfigRestricted: true } });
  });

  it("--channel names another (public) channel; a machine caller without one (no origin) gets its settings outside any channel — the defaults under its own scope, no channel scope, nothing channel-editable — and needs config:read", async () => {
    const config = store();
    await config.setChannelOverride("slack:COTHER", { agent: "review" });
    const commands = bind(config, async () => "public" as const);
    expect((await say(commands, "config show --channel slack:COTHER", chat(config, "slack:UX"))).text).toContain(
      "agent `review`",
    );
    const outside = await commands.invoke("config.show", {}, mcp("config:read"));
    expect(outside).toMatchObject({
      ok: true,
      value: { channel: {}, channelConfigRestricted: true, effective: { agent: "general" } },
    });
    expect((outside as unknown as { value: { channel: unknown } }).value.channel).toEqual({}); // never another channel's scope
    expect(
      (await commands.invoke("config.show", { options: { channel: "slack:COTHER" } }, mcp("config:read"))).ok,
    ).toBe(true);
    expect(
      await commands.invoke("config.show", { options: { channel: "slack:COTHER" } }, mcp("dispatch")),
    ).toMatchObject({ ok: false, error: "unauthorized" });
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 24: `config overrides`
// is the index of configured channels — setting names, never values — filtered
// by the same per-channel `config:read` question `config show --channel` asks,
// so it never names a channel whose scope the caller could not then read.
describe("config overrides — the index of configured channels", () => {
  const visibilityOf =
    (answers: Record<string, "public" | "private">, calls: string[] = []) =>
    async (channelId: string) => {
      calls.push(channelId);
      return answers[channelId] ?? ("unknown" as const);
    };

  it("an admin sees every configured channel with its setting names and source, and the directory is never asked", async () => {
    const config = store();
    await config.setChannelOverride("slack:CPRIVATE", { instructions: "Secret channel rules." });
    await config.setChannelOverride("slack:CPUBLIC", { agent: "review", models: { review: "anthropic/x" } });
    const calls: string[] = [];
    const commands = bind(config, visibilityOf({ "slack:CPUBLIC": "public", "slack:CPRIVATE": "private" }, calls));
    const { res, text } = await say(commands, "config overrides", chat(config, "slack:UADMIN"));
    expect(res).toMatchObject({
      ok: true,
      value: {
        channels: [
          { channelId: "slack:CPRIVATE", settings: ["instructions"], source: "runtime" },
          { channelId: "slack:CPUBLIC", settings: ["agent", "models"], source: "runtime" },
        ],
      },
    });
    expect(text).toBe("slack:CPRIVATE: instructions (runtime)\nslack:CPUBLIC: agent, models (runtime)");
    expect(text).not.toContain("Secret");
    expect(calls).toEqual([]);
  });

  it("a chat user without the grant sees public channels and the one they speak from; private and unknown ones are absent, not greyed", async () => {
    const config = store();
    await config.setChannelOverride("slack:CPRIVATE", { instructions: "Secret channel rules." });
    await config.setChannelOverride("slack:CPUBLIC", { agent: "review" });
    await config.setChannelOverride("slack:CX", { agent: "review" });
    await config.setChannelOverride("slack:CNOWHERE", { agent: "review" });
    const commands = bind(config, visibilityOf({ "slack:CPUBLIC": "public", "slack:CPRIVATE": "private" }));
    const { res } = await say(commands, "config overrides", chat(config, "slack:UX"));
    expect(
      (res as unknown as { value: { channels: { channelId: string }[] } }).value.channels.map((c) => c.channelId),
    ).toEqual(["slack:CPUBLIC", "slack:CX"]);
  });

  it("a machine caller needs config:read and, without a grant on the channels, sees only the public ones", async () => {
    const config = store();
    await config.setChannelOverride("slack:CPRIVATE", { agent: "review" });
    await config.setChannelOverride("slack:CPUBLIC", { agent: "review" });
    const commands = bind(config, visibilityOf({ "slack:CPUBLIC": "public", "slack:CPRIVATE": "private" }));
    expect(await commands.invoke("config.overrides", {}, mcp("dispatch"))).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    const reader = callerWith("mcp", "mcp:reader", { actions: new Set(["config:read"]) });
    expect(await commands.invoke("config.overrides", {}, reader)).toMatchObject({
      ok: true,
      value: { channels: [{ channelId: "slack:CPUBLIC" }] },
    });
    expect(await commands.invoke("config.overrides", {}, mcp("config:read"))).toMatchObject({
      ok: true,
      value: { channels: [{ channelId: "slack:CPRIVATE" }, { channelId: "slack:CPUBLIC" }] },
    });
  });

  it("renders the empty index as a sentence", async () => {
    const config = store(YAML);
    const { text } = await say(bind(config), "config overrides", chat(config, "slack:UADMIN"));
    expect(text).toBe("No channel carries a scope.");
  });
});

// Feature: docs/reference/specs/authorization.md item 4 (the channelConfig read
// half). `--channel` names another channel's scope — its instructions text
// included — so the read is the table's decision, not the caller's baseline: the
// `config:read` rows on `config-scope { channel }` admit a public channel from
// anywhere, a private one from inside it (the pointing actor's one membership)
// or by grant, and `unknown` (no directory, a failed lookup) like a private one.
describe("config channels — the channels a person may pick, by name", () => {
  const listed = async () =>
    [
      { id: "slack:CPUB", visibility: "public" as const },
      { id: "slack:CPRIV", visibility: "private" as const },
      { id: "slack:CX", visibility: "public" as const },
    ] as const;
  const names = {
    person: async () => undefined,
    channel: async (id: string) => ({ "slack:CPUB": "general", "slack:CPRIV": "leads", "slack:CX": "x" })[id],
  };

  it("an admin is offered every channel the bot is in plus every channel that carries a scope, named, sorted by name, with the listing's visibility — and the directory is asked for none of them", async () => {
    const config = store();
    await config.setChannelOverride("http:ops", { agent: "review" }); // a machine channel Slack never lists
    const calls: string[] = [];
    const commands = bind(config, async (id) => (calls.push(id), "unknown" as const), { channels: listed, names });
    const { res, text } = await say(commands, "config channels", chat(config, "slack:UADMIN"));
    expect(res).toMatchObject({
      ok: true,
      value: {
        listed: true,
        channels: [
          { channelId: "slack:CPUB", channelName: "general", visibility: "public" },
          { channelId: "http:ops", visibility: "unknown" },
          { channelId: "slack:CPRIV", channelName: "leads", visibility: "private" },
          { channelId: "slack:CX", channelName: "x", visibility: "public" },
        ],
      },
    });
    expect(text).toBe(
      "#general (slack:CPUB) · public\nhttp:ops · unknown\n#leads (slack:CPRIV) · private\n#x (slack:CX) · public",
    );
    expect(calls).toEqual([]);
  });

  it("a chat user without the grant is offered the public channels and the one they speak from, never a private one; the listing's visibility is trusted, so the directory is not asked again", async () => {
    const config = store();
    const calls: string[] = [];
    const commands = bind(config, async (id) => (calls.push(id), "unknown" as const), { channels: listed, names });
    const { res } = await say(commands, "config channels", chat(config, "slack:UX"));
    expect(
      (res as unknown as { value: { channels: { channelId: string }[] } }).value.channels.map((c) => c.channelId),
    ).toEqual(["slack:CPUB", "slack:CX"]);
    expect(calls).toEqual([]);
  });

  it("when the bot cannot list its channels, only the channels that carry a scope are offered and listed is false; without a name directory the rows carry ids alone", async () => {
    const config = store();
    await config.setChannelOverride("slack:CPUB", { agent: "review" });
    const commands = bind(config, async () => "public" as const, { channels: async () => "unknown" as const });
    const { res, text } = await say(commands, "config channels", chat(config, "slack:UX"));
    expect(res).toMatchObject({
      ok: true,
      value: { listed: false, channels: [{ channelId: "slack:CPUB", visibility: "unknown" }] },
    });
    expect(text).toContain("slack:CPUB · unknown");
    expect(text).toContain("could not be listed");
    expect((res as unknown as { value: { channels: object[] } }).value.channels[0]).not.toHaveProperty("channelName");
  });

  it("a failing listing is unknown, never an error; a caller without config:read is refused before any listing", async () => {
    const config = store();
    const commands = bind(config, undefined, {
      channels: async () => {
        throw new Error("slack down");
      },
    });
    const { res } = await say(commands, "config channels", chat(config, "slack:UX"));
    expect(res).toMatchObject({ ok: true, value: { listed: false, channels: [] } });
  });
});

describe("config show --channel is bound by the target channel's visibility", () => {
  const RESTRICTED = "That channel's config is restricted.";
  const visibilityOf =
    (answers: Record<string, "public" | "private" | "dm" | "unknown">, calls: string[] = []) =>
    async (channelId: string) => {
      calls.push(channelId);
      return answers[channelId] ?? ("unknown" as const);
    };

  it("a chat user reads a public channel's scope from anywhere, a private or unknown one only from inside it; every refusal is the same line", async () => {
    const config = store();
    await config.setChannelOverride("slack:COTHER", { agent: "review", instructions: "Secret channel rules." });
    const ux = chat(config, "slack:UX");
    const show = (commands: CommandInvoker, caller: Caller) =>
      say(commands, "config show --channel slack:COTHER", caller);

    expect((await show(bind(config, visibilityOf({ "slack:COTHER": "public" })), ux)).text).toContain("agent `review`");

    const refused = await Promise.all([
      show(bind(config, visibilityOf({ "slack:COTHER": "private" })), ux),
      show(bind(config, visibilityOf({ "slack:COTHER": "dm" })), ux),
      show(bind(config, visibilityOf({})), ux),
      show(bind(config), ux),
    ]);
    for (const r of refused) {
      expect(r.res).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler", message: RESTRICTED });
      expect(r.text).not.toContain("Secret channel rules.");
    }

    // From inside the channel the read needs no lookup: the pointing actor's one membership admits it.
    const calls: string[] = [];
    const inside = bind(config, visibilityOf({ "slack:COTHER": "private" }, calls));
    expect((await show(inside, chat(config, "slack:UX", "slack:COTHER"))).text).toContain("agent `review`");
    expect((await say(inside, "config show", chat(config, "slack:UX", "slack:COTHER"))).text).toContain(
      "agent `review`",
    );
    expect(calls).toEqual([]);
  });

  it("by grant: the admin and a credential holding config:write read a private channel's scope from anywhere; a credential on config:read alone reads only a public one", async () => {
    const config = store();
    await config.setChannelOverride("slack:COTHER", { agent: "review" });
    const priv = bind(config, visibilityOf({ "slack:COTHER": "private" }));
    const pub = bind(config, visibilityOf({ "slack:COTHER": "public" }));
    const show = (commands: CommandInvoker, caller: Caller) =>
      commands.invoke("config.show", { options: { channel: "slack:COTHER" } }, caller);
    const readOnly = callerWith("mcp", "mcp:alice", { actions: new Set(["config:read"]) });
    const writer = callerWith("mcp", "mcp:alice", { actions: new Set(["config:read", "config:write"]) });

    expect(await show(priv, chat(config, "slack:UADMIN"))).toMatchObject({ ok: true });
    expect(await show(priv, callerWith("cli", "cli:local", "all"))).toMatchObject({ ok: true });
    expect(await show(priv, writer)).toMatchObject({ ok: true });
    expect(await show(priv, readOnly)).toMatchObject({ ok: false, error: "unauthorized", message: RESTRICTED });
    expect(await show(pub, readOnly)).toMatchObject({ ok: true });
  });

  it("the instructions peek on another channel rides the same read rule: refused on a private channel from elsewhere, shown from inside or on a public one", async () => {
    const config = store();
    await config.setChannelOverride("slack:COTHER", { instructions: "Secret channel rules." });
    const peek = (commands: CommandInvoker, caller: Caller) =>
      commands.invoke("config.instructions", { args: ["channel"], options: { channel: "slack:COTHER" } }, caller);
    const ux = chat(config, "slack:UX");

    const res = await peek(bind(config, visibilityOf({ "slack:COTHER": "private" })), ux);
    expect(res).toMatchObject({ ok: false, error: "unauthorized", message: RESTRICTED });
    expect(JSON.stringify(res)).not.toContain("Secret channel rules.");
    expect(await peek(bind(config, visibilityOf({ "slack:COTHER": "public" })), ux)).toMatchObject({
      ok: true,
      value: { action: "show", instructions: "Secret channel rules." },
    });
    expect(
      await peek(bind(config, visibilityOf({ "slack:COTHER": "private" })), chat(config, "slack:UX", "slack:COTHER")),
    ).toMatchObject({ ok: true, value: { action: "show", instructions: "Secret channel rules." } });
  });
});

describe("config set", () => {
  it("`me` is open: --agent/--model/--effort and the dotted --models.<agent>/--efforts.<agent> land on the user scope; the reply summarizes it", async () => {
    const config = store();
    const commands = bind(config);
    const { text } = await say(
      commands,
      "config set me --agent review --models.coding anthropic/opus --effort low --efforts.review high",
      chat(config, "slack:UX"),
    );
    expect(text).toBe(
      "Updated your scope: agent `review`, models `coding=anthropic/opus`, effort `low`, efforts `review=high`.",
    );
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({
      agent: "review",
      models: { coding: "anthropic/opus" },
      effort: "low",
      efforts: { review: "high" },
    });
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} })).toMatchObject({
      agentName: "review",
      effort: "low",
    });
  });

  it("--verbosity lands on the scope and is held to the ladder (routing-and-config item 28)", async () => {
    const config = store();
    const commands = bind(config);
    const { text } = await say(commands, "config set me --verbosity debug", chat(config, "slack:UX"));
    expect(text).toBe("Updated your scope: verbosity `debug`.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ verbosity: "debug" });
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).verbosity).toBe("debug");
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UY", request: {} }).verbosity).toBe("quiet");
    const me = chat(config, "slack:UX");
    expect(await commands.invoke("config.set", { args: ["me"], options: { verbosity: "loud" } }, me)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'verbosity: expected one of "quiet", "verbose", "debug"',
    });
  });

  it("`channel` targets the caller's channel (or --channel) and rides config:write: refused unless granted (admins hold it through `all`)", async () => {
    const open = store(OPEN_YAML);
    const openCmds = bind(open);
    expect((await say(openCmds, "config set channel --model openai/gpt-5", chat(open, "slack:UX"))).text).toBe(
      "Updated channel scope: model `openai/gpt-5`.",
    );
    expect(open.scopes("slack:CX", "slack:UX").channel).toEqual({ model: "openai/gpt-5" });
    await say(openCmds, "config set channel --agent review --channel slack:COTHER", chat(open, "slack:UX"));
    expect(open.scopes("slack:COTHER", "slack:UX").channel).toEqual({ agent: "review" });

    const gated = store();
    const gatedCmds = bind(gated);
    const refused = await gatedCmds.invoke(
      "config.set",
      { args: ["channel"], options: { agent: "review" } },
      chat(gated, "slack:UX"),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: "unauthorized",
      decidedBy: "handler",
      message: "Channel config changes are restricted.",
    });
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({});
    expect(
      (
        await gatedCmds.invoke(
          "config.set",
          { args: ["channel"], options: { agent: "review" } },
          chat(gated, "slack:UADMIN"),
        )
      ).ok,
    ).toBe(true);
    // `me` stays open under the gate: the run-time agent gate still applies.
    expect(
      (await gatedCmds.invoke("config.set", { args: ["me"], options: { agent: "coding" } }, chat(gated, "slack:UX")))
        .ok,
    ).toBe(true);
  });

  it("a channel can set its default repository; user and thread scopes cannot", async () => {
    const config = store(OPEN_YAML);
    const commands = bind(config);
    const channel = await say(commands, "config set channel --repo acme/api", chat(config, "slack:UX"));
    expect(channel.text).toBe("Updated channel scope: repository `acme/api`.");
    expect(config.scopes("slack:CX", "slack:UX").channel).toEqual({ repo: "acme/api" });
    expect((await say(commands, "config show", chat(config, "slack:UX"))).text).toContain(
      "*Channel scope:* repository `acme/api`",
    );
    expect((await say(commands, "config set me --repo acme/api", chat(config, "slack:UX"))).text).toContain(
      "repo: a default repository belongs to a channel scope",
    );
  });

  it("semantic checks are the handler's `invalid_input`, naming the expectation and never the value: unknown agent, bad effort, nothing to set, bad scope word", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    expect(await commands.invoke("config.set", { args: ["me"], options: { agent: "wizard" } }, me)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "agent: expected one of general, review, coding",
    });
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { models: { wizard: "x/y" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "models.wizard: expected an agent name (one of general, review, coding)",
    });
    expect(await commands.invoke("config.set", { args: ["me"], options: { effort: "turbo" } }, me)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'effort: expected one of "low", "medium", "high", "xhigh", "max"',
    });
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { efforts: { coding: "turbo" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: expect.stringMatching(/^efforts\.coding: expected one of/),
    });
    expect(await commands.invoke("config.set", { args: ["me"] }, me)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: expect.stringMatching(/^nothing to set/),
    });
    expect(await commands.invoke("config.set", { args: ["everyone"], options: { agent: "review" } }, me)).toMatchObject(
      {
        ok: false,
        error: "invalid_input",
        message: 'scope: expected one of "channel", "me", "thread", "user", "org", "repo"',
      },
    );
    expect(
      JSON.stringify(await commands.invoke("config.set", { args: ["me"], options: { agent: "wizard" } }, me)),
    ).not.toContain("wizard");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("the derived help names every level of the effort ladder on --effort and --efforts.<agent> alike — from EFFORT_LEVELS, never hand-typed", () => {
    // `--efforts.<agent> low|medium|high` once shipped while the ladder already
    // had `xhigh` and `max`: help, the MCP tool schema and the HTTP schema all
    // told users about three levels of five.
    const options = helpRows(configSet).options;
    const describes = (flag: string) => options.find((r) => r.form.startsWith(`${flag} `))!.describe;
    for (const level of EFFORT_LEVELS) {
      expect(describes("--effort")).toMatch(new RegExp(`\\b${level}\\b`));
      expect(describes("--efforts")).toMatch(new RegExp(`\\b${level}\\b`));
    }
    expect(EFFORT_LEVELS.length).toBeGreaterThan(3);
  });

  it("a `key=value` spelling is rejected as `invalid_input` (the grammar is `--key value`), and `instructions` is its own command", async () => {
    const commands = bind(store());
    expect(parseInvocation(commands.get("config.set")!, ["me", "agent=review"])).toMatchObject({
      kind: "invalid",
      code: "invalid_input",
      error: expect.stringContaining("unexpected argument: config set takes at most 1"),
    });
    expect(parseInvocation(commands.get("config.set")!, ["me", "--instructions", "x"])).toMatchObject({
      kind: "invalid",
      code: "invalid_input",
      error: expect.stringContaining("unknown option --instructions"),
    });
    expect(parseInvocation(commands.get("config.set")!, ["me", "--models.coding", "x/y"])).toEqual({
      kind: "invoke",
      input: { args: ["me"], options: { models: { coding: "x/y" } } },
    });
  });

  it("a credential needs config:write for any scope; a chat person always has their own scope; a browser session writes its own `me` (the scope its chat runs read) and not `channel` (no grant); a service token has no `me`", async () => {
    const config = store();
    const commands = bind(config);
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, mcp("config:read")),
    ).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    expect(
      (await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, mcp("config:write"))).ok,
    ).toBe(true);
    // A dispatch-only token is refused before the scope is even looked at.
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, mcp("dispatch")),
    ).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    // An unlinked browser session's `me` is its own `access:<sub>` scope — the identity
    // the dashboard's chat requests its runs as (record 0043), so what it sets here is
    // what those runs read; the channel scope stays the channel-config right it never held.
    const browser = callerWith("access", "access:u", ["config:read"]);
    expect(await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, browser)).toMatchObject({
      ok: true,
      value: { scope: "me", effective: { agent: "review" } },
    });
    expect(await commands.invoke("config.instructions", { args: ["me", "Be brief."] }, browser)).toMatchObject({
      ok: true,
    });
    expect(config.scopes("web:u", "access:u").user).toEqual({ agent: "review", instructions: "Be brief." });
    expect(config.resolve({ channelId: "web:u", userId: "access:u", request: {} }).agentName).toBe("review");
    expect(await commands.invoke("config.instructions", { args: ["me"] }, browser)).toMatchObject({
      ok: true,
      value: { scope: "me", action: "show", instructions: "Be brief." },
    });
    expect(await commands.invoke("config.clear", { args: ["me"] }, browser)).toMatchObject({ ok: true });
    expect(config.scopes("web:u", "access:u").user).toEqual({});
    // A service token requests no run: its `me` is refused by the data, before any store is touched.
    const token = callerWith("access", "access:svc:ci", ["config:read", "config:write"]);
    for (const [id, input] of [
      ["config.set", { args: ["me"], options: { agent: "review" } }],
      ["config.clear", { args: ["me"] }],
      ["config.instructions", { args: ["me", "Be brief."] }],
    ] as const) {
      expect(await commands.invoke(id, input, token)).toMatchObject({
        ok: false,
        error: "unauthorized",
        decidedBy: "handler",
        message: ME_ON_SERVICE_TOKEN_MESSAGE,
      });
    }
    expect(config.scopes("", "access:svc:ci").user).toEqual({});
    expect(config.scopes("slack:CX", "access:u").user).toEqual({});
    expect(
      await commands.invoke(
        "config.set",
        { args: ["channel"], options: { agent: "review", channel: "slack:CX" } },
        browser,
      ),
    ).toMatchObject({
      ok: false,
      error: "unauthorized",
      decidedBy: "handler",
      message: "Channel config changes are restricted.",
    });
  });
});

describe("config clear", () => {
  it("clears the user's or the channel's runtime overrides (channel gated), so static config shows through again", async () => {
    const config = store(`${OPEN_YAML}users:\n  "slack:UX":\n    model: anthropic/static\n`);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await commands.invoke("config.set", { args: ["me"], options: { model: "anthropic/runtime" } }, me);
    await commands.invoke("config.set", { args: ["channel"], options: { agent: "review" } }, me);
    expect((await say(commands, "config clear me", me)).text).toBe("Cleared your overrides.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ model: "anthropic/static" });
    expect((await say(commands, "config clear channel", me)).text).toBe("Cleared channel overrides.");
    expect(config.scopes("slack:CX", "slack:UX").channel).toEqual({});
    const gated = store();
    expect(await bind(gated).invoke("config.clear", { args: ["channel"] }, chat(gated, "slack:UX"))).toMatchObject({
      ok: false,
      error: "unauthorized",
      decidedBy: "handler",
    });
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 27 (record 0058) — the
// thread scope: `config set thread --intake.threadReplies <mode>` and `config
// clear thread`, the target the caller's own thread (`--thread <key>` on a
// machine surface), gated by the `config-scope { thread }` row — the same
// channel-config right, so whoever may set the channel may set a thread in it.
describe("config set thread / config clear thread — the thread scope", () => {
  it("a typed `config set thread --intake.threadReplies <mode>` targets the caller's thread and runs at once; the store resolves it above a user and a channel mode; `config clear thread` drops it", async () => {
    const config = store(OPEN_YAML);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await commands.invoke("config.set", { args: ["channel"], options: { intake: { threadReplies: "always" } } }, me);
    await commands.invoke("config.set", { args: ["me"], options: { intake: { threadReplies: "classify" } } }, me);
    const { res, text } = await say(commands, "config set thread --intake.threadReplies mention", me);
    expect(res.ok).toBe(true);
    expect(text).toBe("Updated thread scope: intake `mention`.");
    expect(config.intakeModeFor("slack:CX:1.0", "slack:UX", "slack:CX")).toBe("mention");
    // Another thread resolves the user's mode: the thread layer is that thread's alone.
    expect(config.intakeModeFor("slack:CX:2.0", "slack:UX", "slack:CX")).toBe("classify");
    expect((await say(commands, "config clear thread", me)).text).toBe("Cleared thread overrides.");
    expect(config.intakeModeFor("slack:CX:1.0", "slack:UX", "slack:CX")).toBe("classify");
  });

  it("the thread scope rides the config-scope thread row: a caller without config:write is refused, on set and on clear alike", async () => {
    const config = store();
    const commands = bind(config);
    const refusal = { ok: false, error: "unauthorized", decidedBy: "handler" };
    expect(
      await commands.invoke(
        "config.set",
        { args: ["thread"], options: { intake: { threadReplies: "mention" } } },
        chat(config, "slack:UX"),
      ),
    ).toMatchObject(refusal);
    expect(await commands.invoke("config.clear", { args: ["thread"] }, chat(config, "slack:UX"))).toMatchObject(
      refusal,
    );
    // The admin holds it through `all`.
    expect(
      await commands.invoke(
        "config.set",
        { args: ["thread"], options: { intake: { threadReplies: "mention" } } },
        chat(config, "slack:UADMIN"),
      ),
    ).toMatchObject({ ok: true });
  });

  it("a machine surface has no origin thread: --thread <key> names one, and without it the write is `invalid_input` naming the option", async () => {
    const config = store();
    const commands = bind(config);
    const machine = mcp("config:write");
    expect(
      await commands.invoke(
        "config.set",
        { args: ["thread"], options: { intake: { threadReplies: "mention" } } },
        machine,
      ),
    ).toMatchObject({ ok: false, error: "invalid_input", message: expect.stringContaining("--thread <key>") });
    expect(
      await commands.invoke(
        "config.set",
        { args: ["thread"], options: { intake: { threadReplies: "mention" }, thread: "slack:CY:9.9" } },
        machine,
      ),
    ).toMatchObject({ ok: true });
    expect(config.intakeModeFor("slack:CY:9.9", "slack:UX", "slack:CY")).toBe("mention");
    expect(await commands.invoke("config.clear", { args: ["thread"] }, machine)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("an unknown mode is refused by name, never echoing the value; a thread scope takes only --intake.threadReplies", async () => {
    const config = store(OPEN_YAML);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    const bad = await say(commands, "config set thread --intake.threadReplies sometimes", me);
    expect(bad.res.ok).toBe(false);
    expect(bad.text).toMatch(/intake\.threadReplies: expected one of/);
    expect(bad.text).not.toContain("sometimes");
    const agent = await say(commands, "config set thread --agent review", me);
    expect(agent.res).toMatchObject({ ok: false, error: "invalid_input" });
    expect(agent.text).toContain("--intake.threadReplies");
    expect(config.scopes("slack:CX", "slack:UX").channel).toEqual({});
  });

  it("--intake.threadReplies is a scope setting: it lands on `me` and `channel` too, under the intake gate's layers", async () => {
    const config = store(OPEN_YAML);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    const set = await say(commands, "config set me --intake.threadReplies always", me);
    expect(set.res.ok).toBe(true);
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ intake: { threadReplies: "always" } });
    expect(config.intakeModeFor("slack:CX:1.0", "slack:UX", "slack:CX")).toBe("always");
  });
});

describe("config instructions", () => {
  it('sets the text (quoted or bare, smart quotes normalized), shows it, clears it with ""; the user\'s text never touches agent/model', async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, me);
    const set = await say(commands, 'config instructions me "Always sign off as Dan."', me);
    expect(set.text).toBe(
      "Updated your instructions (advisory prompt content — they never change agent, model, or permissions):\n> Always sign off as Dan.",
    );
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({
      agent: "review",
      instructions: "Always sign off as Dan.",
    });
    expect((await say(commands, "config instructions me “Be terse”", me)).res.ok).toBe(true);
    expect(config.scopes("slack:CX", "slack:UX").user.instructions).toBe("Be terse");
    expect((await say(commands, "config instructions me", me)).text).toBe(
      'Current your instructions:\n> Be terse\nTo clear: `config instructions me ""`',
    );
    expect((await say(commands, 'config instructions me ""', me)).text).toBe("Cleared your instructions.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ agent: "review" });
    expect((await say(commands, "config instructions me", me)).text).toBe(
      'No your instructions are set. Example: `config instructions me "Always reply in bullet points"`',
    );
  });

  it("a peek never clears; clearing runtime text says when static config.yaml text shows through; too long is `invalid_input` naming the cap", async () => {
    const config = store(`${YAML}users:\n  "slack:UX":\n    instructions: "Prefer British spelling."\n`);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await say(commands, 'config instructions me "runtime"', me);
    await say(commands, "config instructions me", me);
    expect(config.scopes("slack:CX", "slack:UX").user.instructions).toBe("runtime");
    expect((await say(commands, 'config instructions me ""', me)).text).toBe(
      "Cleared your instructions. The static config text now applies:\n> Prefer British spelling.",
    );
    const long = await commands.invoke(
      "config.instructions",
      { args: ["me", "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1)] },
      me,
    );
    expect(long).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: expect.stringContaining(`capped at ${MAX_INSTRUCTIONS_LENGTH} characters`),
    });
    expect(JSON.stringify(long)).not.toContain("xxxxxxxxxx");
  });

  it("channel instructions ride the config:write gate and target the caller's channel (or --channel); the peek is ungated", async () => {
    const gated = store();
    const commands = bind(gated);
    expect(
      await commands.invoke("config.instructions", { args: ["channel", "Be French."] }, chat(gated, "slack:UX")),
    ).toMatchObject({
      ok: false,
      error: "unauthorized",
      decidedBy: "handler",
      message: "Channel config changes are restricted.",
    });
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({});
    const admin = chat(gated, "slack:UADMIN");
    expect((await say(commands, "config instructions channel This channel is about billing.", admin)).text).toContain(
      "Updated channel instructions",
    );
    expect(gated.scopes("slack:CX", "slack:UADMIN").channel.instructions).toBe("This channel is about billing.");
    expect((await say(commands, "config instructions channel", chat(gated, "slack:UX"))).text).toBe(
      'Current channel instructions:\n> This channel is about billing.\nTo clear: `config instructions channel ""`',
    );
    await commands.invoke(
      "config.instructions",
      { args: ["channel", "Elsewhere."], options: { channel: "slack:COTHER" } },
      admin,
    );
    expect(gated.scopes("slack:COTHER", "slack:UADMIN").channel.instructions).toBe("Elsewhere.");
    expect((await say(commands, "config instructions channel", chat(gated, "slack:UX", "slack:CEMPTY"))).text).toMatch(
      /^No channel instructions are set/,
    );
  });

  it("declares the actions: show is config:read, the writers are config:write (the channel scope is decided inside, on config-scope/channel)", async () => {
    const byId = Object.fromEntries(configCommands.map((c) => [c.id, c]));
    expect(byId["config.show"]).toMatchObject({ action: "config:read", effect: "read" });
    for (const id of ["config.set", "config.clear", "config.instructions"]) {
      expect(byId[id], id).toMatchObject({ action: "config:write", effect: "write" });
      expect(byId[id].resource, id).toBeUndefined();
    }
  });
});

// Feature: docs/reference/specs/routing-and-config.md items 2 and 5 — a boundary
// is set from chat like every other scope setting: `--boundary.<axis>` on
// `config set`, the channel form under `config:write`, `me` self-service (a
// user boundary can only tighten what the channel and the defaults allow).
describe("config set --boundary.<axis> and config show's effective boundary", () => {
  it("`me` is self-service: the dotted axes land on the user scope as one boundary (machines split on commas) and the reply summarizes it", async () => {
    const config = store();
    const commands = bind(config);
    const { text } = await say(
      commands,
      "config set me --boundary.maxMinutes 45 --boundary.maxIdentity read --boundary.machines none,repo-cold",
      chat(config, "slack:UX"),
    );
    expect(text).toBe("Updated your scope: boundary maxMinutes=45 maxIdentity=read machines=none,repo-cold.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({
      boundary: { maxMinutes: 45, maxIdentity: "read", machines: ["none", "repo-cold"] },
    });
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).boundary).toEqual({
      maxMinutes: { value: 45, scope: "user" },
      maxIdentity: { value: "read", scope: "user" },
      machines: { value: ["none", "repo-cold"], by: [{ scope: "user", machines: ["none", "repo-cold"] }] },
    });
  });

  it("the channel form rides config:write like every channel write; the dotted form nests through the shared grammar", async () => {
    const gated = store();
    const commands = bind(gated);
    expect(parseInvocation(commands.get("config.set")!, ["channel", "--boundary.maxMinutes", "45"])).toEqual({
      kind: "invoke",
      input: { args: ["channel"], options: { boundary: { maxMinutes: "45" } } },
    });
    expect(
      await commands.invoke(
        "config.set",
        { args: ["channel"], options: { boundary: { maxMinutes: "45" } } },
        chat(gated, "slack:UX"),
      ),
    ).toMatchObject({ ok: false, error: "unauthorized", message: "Channel config changes are restricted." });
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({});
    expect(
      (
        await commands.invoke(
          "config.set",
          { args: ["channel"], options: { boundary: { maxMinutes: "45" } } },
          chat(gated, "slack:UADMIN"),
        )
      ).ok,
    ).toBe(true);
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({ boundary: { maxMinutes: 45 } });
  });

  it("an invalid axis value is refused as `invalid_input` by name, never echoing the value: minutes under 2, an unknown identity, an unknown class, an empty class list", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { maxMinutes: "1" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: expect.stringMatching(/^boundary\.maxMinutes: expected/),
    });
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { maxMinutes: "soon" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: expect.stringMatching(/^boundary\.maxMinutes: expected/),
    });
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { maxIdentity: "admin" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'boundary.maxIdentity: expected one of "none", "read", "write"',
    });
    const badClass = await commands.invoke(
      "config.set",
      { args: ["me"], options: { boundary: { machines: "none,laptop" } } },
      me,
    );
    expect(badClass).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "boundary.machines: expected a comma-separated list of none, blank, repo-cold, repo-resident",
    });
    expect(JSON.stringify(badClass)).not.toContain("laptop");
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { machines: "" } } }, me),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await commands.invoke("config.set", { args: ["me"], options: { boundary: {} } }, me)).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: expect.stringMatching(/^nothing to set/),
    });
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("config show prints the effective boundary once one is in force, the same text ConfigStore.describe produces", async () => {
    const config = store();
    const commands = bind(config);
    await say(commands, "config set me --boundary.maxMinutes 20", chat(config, "slack:UX"));
    const { res, text } = await say(commands, "config show", chat(config, "slack:UX"));
    expect(text).toContain("*Effective boundary:* maxMinutes 20 (user)");
    expect(text).toBe(config.describe("slack:CX", "slack:UX"));
    expect(res.ok && res.value).toMatchObject({
      effective: { boundary: { maxMinutes: { value: 20, scope: "user" } } },
    });
  });

  // record 0044, the confirm axis: the class rides the same dotted option as
  // the run axes and is held to the validator's rule on write, so `never` and
  // `exec` get the reasons the load-time check gives, never a schema message.
  it("config set me --boundary.confirm never and exec are refused as invalid_input with the validator's own reasons; an unknown class with the two classes", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { confirm: "never" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message:
        'boundary.confirm is "never" — not allowed until the door\'s write misbind rate has been measured over a period (record 0044, open question 2)',
    });
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { confirm: "exec" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'boundary.confirm is "exec" — a test or build never asks (record 0044)',
    });
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { boundary: { confirm: "read" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'boundary.confirm is "read" — valid classes: write, destructive',
    });
    const { text } = await say(commands, "config set me --boundary.confirm never", me);
    expect(text).toContain("not allowed until the door's write misbind rate has been measured over a period");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("config set me --boundary.confirm destructive lands on the scope as one boundary field, caps no run (resolve() carries no boundary), and config show prints the effective confirm with its scope — nothing, in text or value, under the built-in default", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    const before = await say(commands, "config show", me);
    expect(before.text).not.toMatch(/confirm/i);
    expect(before.res.ok && before.res.value).not.toHaveProperty("effective.confirm");
    const { text } = await say(commands, "config set me --boundary.confirm destructive", me);
    expect(text).toBe("Updated your scope: boundary confirm=destructive.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ boundary: { confirm: "destructive" } });
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).boundary).toBeUndefined();
    const shown = await say(commands, "config show", me);
    expect(shown.text).toContain("*Effective confirm:* `destructive` (user)");
    expect(shown.text).not.toContain("*Effective boundary:*");
    expect(shown.text).toMatch(/\*Your scope:\* boundary confirm=destructive/);
    expect(shown.text).not.toContain("(caps nothing)");
    expect(shown.text).toBe(config.describe("slack:CX", "slack:UX"));
    expect(shown.res.ok && shown.res.value).toMatchObject({
      effective: { confirm: { value: "destructive", scope: "user" } },
    });
  });
});

// Feature: docs/decisions/0042 — a dashboard session linked to its person writes and
// reads the PERSON's scope as `me`; an unlinked session is still refused (record 0041).
describe("config `me` for a linked dashboard session (record 0042)", () => {
  const linkedBrowser = (config: ConfigStore): Caller => {
    const base = callerWith("access", "access:u", ["config:read"]);
    void config;
    return {
      ...base,
      actor: { ...base.actor, self: ["access:u", "slack:UX"], asUser: { id: "slack:UX", name: "ux" } },
    };
  };

  it("config set|instructions|clear me act on the linked person's scope, which the person's chat runs read; the browser's own scope stays empty", async () => {
    const config = store();
    const commands = bind(config);
    const me = linkedBrowser(config);
    expect(await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, me)).toMatchObject({
      ok: true,
      value: { scope: "me", effective: { agent: "review" } },
    });
    expect(await commands.invoke("config.instructions", { args: ["me", "Be brief."] }, me)).toMatchObject({ ok: true });
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ agent: "review", instructions: "Be brief." });
    expect(config.scopes("slack:CX", "access:u").user).toEqual({});
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).agentName).toBe("review");
    // `config show` describes the person's scope for the linked session.
    const shown = await commands.invoke("config.show", { options: { channel: "slack:CX" } }, me);
    expect(shown).toMatchObject({ ok: true, value: { user: { agent: "review" } } });
    expect(await commands.invoke("config.clear", { args: ["me"] }, me)).toMatchObject({ ok: true });
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 5; harness.md item 8
// — the harness word is set from chat like every other scope setting:
// `--harness.<agent> pi|opencode` on `config set`, `me` self-service (a
// person's own runs move, nobody else's), the channel form under
// `config:write`; a word that is not a harness or a preset the registry does
// not know is refused by name without echoing the value; `config show`
// renders the effective harness with the scope that set it; `config clear me`
// drops it with the rest.
describe("config set --harness.<agent> and config show's effective harness", () => {
  it("`me` is self-service: the word lands on the user scope, resolves for that person's runs, shows with its scope, and clears with the rest", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    const { text } = await say(commands, "config set me --harness.coding opencode", me);
    expect(text).toBe("Updated your scope: harness `coding=opencode`.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ harness: { coding: "opencode" } });
    const coding = { channelId: "slack:CX", request: { agent: "coding" } };
    expect(config.resolve({ ...coding, userId: "slack:UX" }).harness).toEqual({ name: "opencode", scope: "user" });
    expect(config.resolve({ ...coding, userId: "slack:UY" }).harness).toBeUndefined(); // nobody else's runs move
    const shown = await say(commands, "config show", me);
    expect(shown.text).toContain("*Effective harness:* coding `opencode` (user)");
    expect(shown.text).toContain("*Your scope:* harness `coding=opencode`");
    expect(shown.text).toBe(config.describe("slack:CX", "slack:UX"));
    expect((await say(commands, "config clear me", me)).text).toBe("Cleared your overrides.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
    expect(config.resolve({ ...coding, userId: "slack:UX" }).harness).toBeUndefined();
    expect((await say(commands, "config show", me)).text).not.toContain("harness");
  });

  it("the channel form rides config:write like every channel write; the dotted form nests through the shared grammar", async () => {
    const gated = store();
    const commands = bind(gated);
    expect(parseInvocation(commands.get("config.set")!, ["channel", "--harness.coding", "opencode"])).toEqual({
      kind: "invoke",
      input: { args: ["channel"], options: { harness: { coding: "opencode" } } },
    });
    expect(
      await commands.invoke(
        "config.set",
        { args: ["channel"], options: { harness: { coding: "opencode" } } },
        chat(gated, "slack:UX"),
      ),
    ).toMatchObject({ ok: false, error: "unauthorized", message: "Channel config changes are restricted." });
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({});
    const { text } = await say(commands, "config set channel --harness.coding opencode", chat(gated, "slack:UADMIN"));
    expect(text).toBe("Updated channel scope: harness `coding=opencode`.");
    expect(gated.scopes("slack:CX", "slack:UY").channel).toEqual({ harness: { coding: "opencode" } });
    expect(gated.resolve({ channelId: "slack:CX", userId: "slack:UY", request: { agent: "coding" } }).harness).toEqual({
      name: "opencode",
      scope: "channel",
    });
  });

  it("a word that is not a harness and a preset the registry does not know are refused by name, never echoing the value; the derived help names the roster's words", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    const bad = await commands.invoke("config.set", { args: ["me"], options: { harness: { coding: "codex" } } }, me);
    expect(bad).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: 'harness.coding: expected one of "pi", "opencode"',
    });
    expect(JSON.stringify(bad)).not.toContain("codex");
    expect(
      await commands.invoke("config.set", { args: ["me"], options: { harness: { wizard: "pi" } } }, me),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "harness.wizard: expected an agent name (one of general, review, coding)",
    });
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
    const options = helpRows(configSet).options;
    const harness = options.find((r) => r.form.startsWith("--harness "))!;
    for (const word of HARNESS_NAMES) expect(harness.describe).toMatch(new RegExp(`\\b${word}\\b`));
    expect(configSet.describe).toContain("--harness.<agent>");
  });
});

// The severity to address (agent-review.md item 5a): `--review.addressSeverity`
// on `config set`, per channel (gated) and per user — the level every review's
// verdict parser holds an approve to, under a `severity:<level>` directive.
describe("config set --review.addressSeverity", () => {
  it("`me` is self-service: the level lands on the user scope beside the other settings, and a value outside the ladder is refused by name", async () => {
    const config = store();
    const commands = bind(config);
    const { text } = await say(commands, "config set me --review.addressSeverity major", chat(config, "slack:UX"));
    expect(text).toContain("severity `major`");
    expect(config.scopes("slack:CX", "slack:UX").user.review).toEqual({ addressSeverity: "major" });
    const bad = await say(commands, "config set me --review.addressSeverity huge", chat(config, "slack:UX"));
    expect(bad.text).toMatch(/addressSeverity/);
    expect(config.scopes("slack:CX", "slack:UX").user.review).toEqual({ addressSeverity: "major" });
  });
});

// Feature: docs/reference/specs/authorization.md item 18 / routing-and-config.md
// item 30 (record 0062) — the author binding: `users.<id>.github` is written by
// an `identity:write` holder through `config set user --user <id> --github
// <login>`, refused on `me` at the registry door by one sentence on every
// surface (reason `identity` on the audit line), preserved by `config clear
// me`, and read by no grant.
describe("config set user / config clear user — the author binding (record 0062)", () => {
  const IDENTITY_YAML = YAML.replace("grants:\n", 'grants:\n  "slack:UIDP": { actions: [identity:write] }\n');
  const pair = { login: "ivy-dev", id: 4242 };

  function bindWithIdentity(config: ConfigStore, resolveLogin?: ConfigCommandDeps["identity"]) {
    const audits: AuditEntry[] = [];
    const registry = new CommandRegistry<ConfigCommandDeps>({ audit: (e) => audits.push(e) });
    registerConfigCommands(registry);
    const commands = bindCommands(registry, {
      config: { ...configDeps(config), agentNames: () => ["general", "review", "coding"] },
      ...(resolveLogin ? { identity: resolveLogin } : {}),
    });
    return { commands, audits };
  }

  it("`config set me --github <login>` is refused at the door on every surface — Slack, the CLI, the dashboard chat, an admin included — with the one sentence and reason `identity` on the audit line; the handler never runs", async () => {
    const config = store();
    const { commands, audits } = bindWithIdentity(config);
    const callers = [
      chat(config, "slack:UADMIN"),
      callerWith("cli", "cli:local", "all"),
      callerWith("access", "access:sub", ["config:write"]),
    ];
    for (const caller of callers) {
      const res = await commands.invoke("config.set", { args: ["me"], options: { github: "ivy-dev" } }, caller);
      expect(res).toMatchObject({
        ok: false,
        error: "unauthorized",
        decidedBy: "door",
        message: ME_GITHUB_MESSAGE,
      });
      expect(audits.at(-1)).toMatchObject({ commandId: "config.set", outcome: "unauthorized", reason: "identity" });
    }
    // The chat grammar says the same words.
    const { text } = await say(commands, "config set me --github ivy-dev", chat(config, "slack:UX"));
    expect(text).toContain(ME_GITHUB_MESSAGE);
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("the chat surface prints the door's own sentence — never the restricted-admins hint — for `config set me --github` (the Slack reply)", async () => {
    const config = store();
    const { commands, audits } = bindWithIdentity(config);
    const parsed = parseChatCommand("config set me --github ivy-dev", commands);
    expect(parsed?.kind).toBe("invoke");
    const text = await handleChatCommand({
      commands,
      parsed: parsed!,
      msg: { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" },
      config,
    });
    expect(text).toBe(`🚫 \`config set\`: ${ME_GITHUB_MESSAGE}`);
    expect(text).not.toContain("is restricted");
    expect(audits.at(-1)).toMatchObject({ commandId: "config.set", outcome: "unauthorized", reason: "identity" });
  });

  it("`config clear me` removes the other overrides and keeps the binding", async () => {
    const config = store();
    const { commands } = bindWithIdentity(config);
    await config.setUserOverride("slack:UX", { models: { general: "anthropic/other" }, github: pair });
    const { text } = await say(commands, "config clear me", chat(config, "slack:UX"));
    expect(text).toBe("Cleared your overrides.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ github: pair });
  });

  it("`config set user --user <id> --github <login>` by an `identity:write` holder resolves the login (GET /users/<login>) and stores { login, id }; an admin's `all` holds it too", async () => {
    const config = store(IDENTITY_YAML);
    const resolved: string[] = [];
    const { commands } = bindWithIdentity(config, {
      resolveLogin: async (login) => {
        resolved.push(login);
        return login === "ivy-dev" ? pair : { login, id: 7 };
      },
    });
    const res = await commands.invoke(
      "config.set",
      { args: ["user"], options: { user: "slack:UONE", github: "ivy-dev" } },
      chat(config, "slack:UIDP"),
    );
    expect(res).toMatchObject({ ok: true });
    expect(resolved).toEqual(["ivy-dev"]);
    expect(config.scopes("slack:CX", "slack:UONE").user).toEqual({ github: pair });
    const asAdmin = await commands.invoke(
      "config.set",
      { args: ["user"], options: { user: "slack:UTWO", github: "ivy-two" } },
      chat(config, "slack:UADMIN"),
    );
    expect(asAdmin).toMatchObject({ ok: true });
  });

  it("a login GitHub answers 404 for is refused by name, and nothing is stored", async () => {
    const config = store(IDENTITY_YAML);
    const { commands } = bindWithIdentity(config, { resolveLogin: async () => undefined });
    const res = await commands.invoke(
      "config.set",
      { args: ["user"], options: { user: "slack:UONE", github: "no-such-login" } },
      chat(config, "slack:UIDP"),
    );
    expect(res).toMatchObject({ ok: false, error: "not_found", decidedBy: "handler" });
    expect(res.ok ? "" : res.message).toContain("no-such-login");
    expect(config.scopes("slack:CX", "slack:UONE").user).toEqual({});
  });

  it("a login or id already bound to another person is refused by the load-time validator's words — conflict, nothing stored — and rebinding the same person replaces", async () => {
    const config = store(IDENTITY_YAML);
    const { commands } = bindWithIdentity(config, {
      resolveLogin: async (login) =>
        login === "same-id" ? { login: "same-id", id: pair.id } : { login, id: login === "ivy-dev" ? pair.id : 9999 },
    });
    const idp = chat(config, "slack:UIDP");
    await commands.invoke("config.set", { args: ["user"], options: { user: "slack:UONE", github: "ivy-dev" } }, idp);
    const dupLogin = await commands.invoke(
      "config.set",
      { args: ["user"], options: { user: "slack:UTWO", github: "ivy-dev" } },
      idp,
    );
    expect(dupLogin).toMatchObject({ ok: false, error: "conflict", decidedBy: "handler" });
    expect(dupLogin.ok ? "" : dupLogin.message).toContain("one login binds one person");
    const dupId = await commands.invoke(
      "config.set",
      { args: ["user"], options: { user: "slack:UTWO", github: "same-id" } },
      idp,
    );
    expect(dupId).toMatchObject({ ok: false, error: "conflict" });
    expect(dupId.ok ? "" : dupId.message).toContain("one account binds one person");
    expect(config.scopes("slack:CX", "slack:UTWO").user).toEqual({});
    // Rebinding the SAME person is a replacement, never a duplicate.
    expect(
      await commands.invoke("config.set", { args: ["user"], options: { user: "slack:UONE", github: "ivy-dev" } }, idp),
    ).toMatchObject({ ok: true });
  });

  it("a binding config.yaml already holds for another person refuses the write too, naming both people", async () => {
    const config = store(`${IDENTITY_YAML}users:\n  "slack:USTATIC":\n    github: ivy-dev\n`);
    const { commands } = bindWithIdentity(config, { resolveLogin: async () => pair });
    const res = await commands.invoke(
      "config.set",
      { args: ["user"], options: { user: "slack:UONE", github: "ivy-dev" } },
      chat(config, "slack:UIDP"),
    );
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect(res.ok ? "" : res.message).toContain("slack:USTATIC");
    expect(config.scopes("slack:CX", "slack:UONE").user).toEqual({});
  });

  it("a `config:write`-only actor is refused the user scope by the table, on set and on clear", async () => {
    const config = store(OPEN_YAML);
    const { commands } = bindWithIdentity(config, { resolveLogin: async () => pair });
    const ux = chat(config, "slack:UX");
    expect(
      await commands.invoke("config.set", { args: ["user"], options: { user: "slack:UONE", github: "ivy-dev" } }, ux),
    ).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler" });
    expect(
      await commands.invoke("config.clear", { args: ["user"], options: { user: "slack:UONE" } }, ux),
    ).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler" });
  });

  it("the user scope carries the binding alone: another setting there, a missing --user, or --github under channel/thread are refused by name", async () => {
    const config = store(IDENTITY_YAML);
    const { commands } = bindWithIdentity(config, { resolveLogin: async () => pair });
    const idp = chat(config, "slack:UIDP");
    expect(
      await commands.invoke(
        "config.set",
        { args: ["user"], options: { user: "slack:UONE", github: "ivy-dev", model: "anthropic/x" } },
        idp,
      ),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await commands.invoke("config.set", { args: ["user"], options: { github: "ivy-dev" } }, idp)).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
    expect(
      await commands.invoke(
        "config.set",
        { args: ["channel"], options: { github: "ivy-dev" } },
        chat(config, "slack:UADMIN"),
      ),
    ).toMatchObject({
      ok: false,
      error: "invalid_input",
    });
  });

  it("`config clear user --user <id>` removes the binding and nothing else, for an `identity:write` holder", async () => {
    const config = store(IDENTITY_YAML);
    const { commands } = bindWithIdentity(config);
    await config.setUserOverride("slack:UONE", { model: "anthropic/kept", github: pair });
    const res = await commands.invoke(
      "config.clear",
      { args: ["user"], options: { user: "slack:UONE" } },
      chat(config, "slack:UIDP"),
    );
    expect(res).toMatchObject({ ok: true });
    expect(config.scopes("slack:CX", "slack:UONE").user).toEqual({ model: "anthropic/kept" });
  });

  it("no grant reads the binding: chatActorOf and effectiveGrants are identical with and without the key", () => {
    const withKey = store(`${YAML}users:\n  "slack:UX":\n    github: ivy-dev\n`);
    const without = store();
    const msg = { userId: "slack:UX", channelId: "slack:CX", threadKey: "slack:CX:1.0" };
    expect(chatActorOf(withKey, msg)).toEqual(chatActorOf(without, msg));
    expect(effectiveGrants(chatActorOf(withKey, msg))).toEqual(effectiveGrants(chatActorOf(without, msg)));
    expect(withKey.grantsFor("slack:UX")).toEqual(without.grantsFor("slack:UX"));
  });
});

describe("config set at org and repo scope — the pull-request watch (record 0071, mechanism three; routing-and-config item 32)", () => {
  it("an admin turns the watch on at org scope, a repository overrides it off, and the resolution reads repo over org over the default", async () => {
    const config = store();
    const commands = bind(config);
    // Default: off.
    expect(config.mergeWatchOf("acme/api").watch).toBe(false);
    const org = await say(commands, "config set org --pulls.watch on", chat(config, "slack:UADMIN"));
    expect(org.res.ok).toBe(true);
    expect(org.text).toBe("Updated org scope: watch `on`.");
    expect(config.mergeWatchOf("acme/api").watch).toBe(true);
    // The repository's word wins over the org's.
    const repo = await say(commands, "config set repo --repo acme/api --pulls.watch off", chat(config, "slack:UADMIN"));
    expect(repo.res.ok).toBe(true);
    expect(repo.text).toBe("Updated repository scope: watch `off`.");
    expect(config.mergeWatchOf("acme/api").watch).toBe(false);
    expect(config.mergeWatchOf("acme/web").watch).toBe(true);
    // And on over an org that never turned it on, once the org clears.
    await say(commands, "config clear org", chat(config, "slack:UADMIN"));
    expect(config.mergeWatchOf("acme/web").watch).toBe(false);
    await say(commands, "config set repo --repo acme/web --pulls.watch on", chat(config, "slack:UADMIN"));
    expect(config.mergeWatchOf("acme/web").watch).toBe(true);
    expect(config.mergeWatchOf("acme/api").watch).toBe(false);
  });

  it("the caps are configurable at both scopes and resolve per key", async () => {
    const config = store();
    const commands = bind(config);
    await say(
      commands,
      "config set org --pulls.watch on --pulls.rebaseInFlight 2 --pulls.spendLimitUsd 10",
      chat(config, "slack:UADMIN"),
    );
    expect(config.mergeWatchOf("acme/api")).toEqual({ watch: true, rebaseInFlight: 2, spendLimitUsd: 10 });
    await say(commands, "config set repo --repo acme/api --pulls.rebaseInFlight 1", chat(config, "slack:UADMIN"));
    expect(config.mergeWatchOf("acme/api")).toEqual({ watch: true, rebaseInFlight: 1, spendLimitUsd: 10 });
  });

  it("the org and repo scopes are gated on config:write; anyone else is refused by name", async () => {
    const config = store();
    const commands = bind(config);
    const refused = await say(commands, "config set org --pulls.watch on", chat(config, "slack:UX"));
    expect(refused.res.ok).toBe(false);
    expect(refused.text).toContain("Org and repository config changes are restricted.");
    const granted = store(OPEN_YAML);
    const open = bind(granted);
    expect((await say(open, "config set org --pulls.watch on", chat(granted, "slack:UX"))).res.ok).toBe(true);
  });

  it("the scopes carry the watch alone: no --pulls is named, another setting refused, repo requires --repo, and --pulls elsewhere points at org|repo", async () => {
    const config = store();
    const commands = bind(config);
    const none = await say(commands, "config set org", chat(config, "slack:UADMIN"));
    expect(none.text).toContain("org: pass --pulls.watch on|off");
    const other = await say(commands, "config set org --pulls.watch on --agent review", chat(config, "slack:UADMIN"));
    expect(other.text).toContain("only --pulls.* applies");
    const noRepo = await say(commands, "config set repo --pulls.watch on", chat(config, "slack:UADMIN"));
    expect(noRepo.text).toContain("repo: required — pass --repo <owner/name>");
    const misplaced = await say(commands, "config set me --pulls.watch on", chat(config, "slack:UADMIN"));
    expect(misplaced.text).toContain("config set org|repo --pulls.…");
  });

  it("config clear repo drops the repository's scope; config clear org drops the org's watch and nothing else", async () => {
    const config = store();
    const commands = bind(config);
    await say(commands, "config set org --pulls.watch on", chat(config, "slack:UADMIN"));
    await say(commands, "config set repo --repo acme/api --pulls.watch off", chat(config, "slack:UADMIN"));
    const cleared = await say(commands, "config clear repo --repo acme/api", chat(config, "slack:UADMIN"));
    expect(cleared.text).toBe("Cleared repository overrides.");
    expect(config.mergeWatchOf("acme/api").watch).toBe(true);
    await say(commands, "config clear org", chat(config, "slack:UADMIN"));
    expect(config.mergeWatchOf("acme/api").watch).toBe(false);
    // Clearing is gated the same way.
    const refused = await say(commands, "config clear org", chat(config, "slack:UX"));
    expect(refused.res.ok).toBe(false);
  });
});
