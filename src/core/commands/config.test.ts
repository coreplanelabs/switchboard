import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, MAX_INSTRUCTIONS_LENGTH } from "../../config.js";
import { CommandRegistry, bindCommands, renderText, type Caller, type CommandInvoker } from "../commandRegistry.js";
import { parseInvocation, tokenize } from "../commandSurface.js";
import { configCommands, registerConfigCommands, type ConfigCommandDeps } from "./config.js";

// Feature: features/routing-and-config.md items 5, 9 / features/command-registry.md
// (phase 4b): `config show|set|clear|instructions` as registry commands. The
// caller's channel is the default target; `me` is always open; the `channel`
// scope rides `channelConfig` (open when unconfigured) inside the handler;
// dotted options (`--models.coding x`) nest; none of it reaches a model.

const YAML = `
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
permissions:
  admins: ["slack:UADMIN"]
  agents:
    coding: ["slack:UADMIN"]
`;

function store(yaml = YAML): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-cfgcmd-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return new ConfigStore(join(dir, "config.yaml"), join(dir, "overrides.json"));
}

function bind(config: ConfigStore): CommandInvoker {
  const registry = new CommandRegistry<ConfigCommandDeps>({ audit: () => {} });
  registerConfigCommands(registry);
  return bindCommands(registry, { config: { ...configDeps(config), agentNames: () => ["general", "review", "coding"] } });
}

function configDeps(config: ConfigStore) {
  return {
    describeConfig: (c: string, u: string) => config.describeConfig(c, u),
    scopes: (c: string, u: string) => config.scopes(c, u),
    setChannelOverride: (c: string, p: Parameters<ConfigStore["setChannelOverride"]>[1]) => config.setChannelOverride(c, p),
    setUserOverride: (u: string, p: Parameters<ConfigStore["setUserOverride"]>[1]) => config.setUserOverride(u, p),
    clearChannelOverride: (c: string) => config.clearChannelOverride(c),
    clearUserOverride: (u: string) => config.clearUserOverride(u),
  };
}

const chat = (config: ConfigStore, userId: string, channelId = "slack:CX"): Caller => ({
  kind: "chat",
  id: userId,
  scopes: new Set(),
  chatGate: config.chatGateFor(userId),
  origin: { channelId, threadKey: `${channelId}:1.0` },
});
const mcp = (...scopes: string[]): Caller => ({ kind: "mcp", id: "mcp:alice", scopes: new Set(scopes) });

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
    expect(text).toContain("*Not available to you:* `coding` (ask <@slack:UADMIN>)");
    expect(res.ok && res.value).toMatchObject({ effective: { agent: "general" }, restrictedAgents: ["coding"], channelConfigRestricted: false });
  });

  it("--channel names another channel; a machine caller must name one (no origin) and needs config:read", async () => {
    const config = store();
    config.setChannelOverride("slack:COTHER", { agent: "review" });
    const commands = bind(config);
    expect((await say(commands, "config show --channel slack:COTHER", chat(config, "slack:UX"))).text).toContain("agent `review`");
    expect(await commands.invoke("config.show", {}, mcp("config:read"))).toMatchObject({ ok: false, error: "invalid_input", message: "channel: required on this surface — pass --channel <id>" });
    expect((await commands.invoke("config.show", { options: { channel: "slack:COTHER" } }, mcp("config:read"))).ok).toBe(true);
    expect(await commands.invoke("config.show", { options: { channel: "slack:COTHER" } }, mcp("dispatch"))).toMatchObject({ ok: false, error: "unauthorized" });
  });
});

describe("config set", () => {
  it("`me` is open: --agent/--model/--effort and the dotted --models.<agent>/--efforts.<agent> land on the user scope; the reply summarizes it", async () => {
    const config = store();
    const commands = bind(config);
    const { text } = await say(commands, "config set me --agent review --models.coding anthropic/opus --effort low --efforts.review high", chat(config, "slack:UX"));
    expect(text).toBe('Updated your scope. Now: {"agent":"review","models":{"coding":"anthropic/opus"},"effort":"low","efforts":{"review":"high"}}');
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ agent: "review", models: { coding: "anthropic/opus" }, effort: "low", efforts: { review: "high" } });
    expect(config.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} })).toMatchObject({ agentName: "review", effort: "low" });
  });

  it("`channel` targets the caller's channel (or --channel) and rides channelConfig: open when unconfigured, admins + the list when configured", async () => {
    const open = store();
    const openCmds = bind(open);
    expect((await say(openCmds, "config set channel --model openai/gpt-5", chat(open, "slack:UX"))).text).toBe('Updated channel scope. Now: {"model":"openai/gpt-5"}');
    expect(open.scopes("slack:CX", "slack:UX").channel).toEqual({ model: "openai/gpt-5" });
    await say(openCmds, "config set channel --agent review --channel slack:COTHER", chat(open, "slack:UX"));
    expect(open.scopes("slack:COTHER", "slack:UX").channel).toEqual({ agent: "review" });

    const gated = store(YAML.replace("permissions:\n", "permissions:\n  channelConfig: []\n"));
    const gatedCmds = bind(gated);
    const refused = await gatedCmds.invoke("config.set", { args: ["channel"], options: { agent: "review" } }, chat(gated, "slack:UX"));
    expect(refused).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler", message: "Channel config changes are restricted." });
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({});
    expect((await gatedCmds.invoke("config.set", { args: ["channel"], options: { agent: "review" } }, chat(gated, "slack:UADMIN"))).ok).toBe(true);
    // `me` stays open under the gate: the run-time agent gate still applies.
    expect((await gatedCmds.invoke("config.set", { args: ["me"], options: { agent: "coding" } }, chat(gated, "slack:UX"))).ok).toBe(true);
  });

  it("semantic checks are the handler's `invalid_input`, naming the expectation and never the value: unknown agent, bad effort, nothing to set, bad scope word", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    expect(await commands.invoke("config.set", { args: ["me"], options: { agent: "wizard" } }, me)).toMatchObject({ ok: false, error: "invalid_input", message: "agent: expected one of general, review, coding" });
    expect(await commands.invoke("config.set", { args: ["me"], options: { models: { wizard: "x/y" } } }, me)).toMatchObject({ ok: false, error: "invalid_input", message: "models.wizard: expected an agent name (one of general, review, coding)" });
    expect(await commands.invoke("config.set", { args: ["me"], options: { effort: "turbo" } }, me)).toMatchObject({ ok: false, error: "invalid_input", message: 'effort: expected one of "low", "medium", "high", "xhigh", "max"' });
    expect(await commands.invoke("config.set", { args: ["me"], options: { efforts: { coding: "turbo" } } }, me)).toMatchObject({ ok: false, error: "invalid_input", message: expect.stringMatching(/^efforts\.coding: expected one of/) });
    expect(await commands.invoke("config.set", { args: ["me"] }, me)).toMatchObject({ ok: false, error: "invalid_input", message: expect.stringMatching(/^nothing to set/) });
    expect(await commands.invoke("config.set", { args: ["everyone"], options: { agent: "review" } }, me)).toMatchObject({ ok: false, error: "invalid_input", message: 'scope: expected one of "channel", "me"' });
    expect(JSON.stringify(await commands.invoke("config.set", { args: ["me"], options: { agent: "wizard" } }, me))).not.toContain("wizard");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("the legacy `key=value` spelling is a usage error (the grammar is `--key value`), and `instructions` is its own command", () => {
    const commands = bind(store());
    expect(parseInvocation(commands.get("config.set")!, ["me", "agent=review"])).toMatchObject({ kind: "usage", error: expect.stringContaining("unexpected argument: config set takes at most 1") });
    expect(parseInvocation(commands.get("config.set")!, ["me", "--instructions", "x"])).toMatchObject({ kind: "usage", error: expect.stringContaining("unknown option --instructions") });
    expect(parseInvocation(commands.get("config.set")!, ["me", "--models.coding", "x/y"])).toEqual({ kind: "invoke", input: { args: ["me"], options: { models: { coding: "x/y" } } } });
  });

  it("machine callers need config:write; a browser Access session without an operators entry cannot write", async () => {
    const commands = bind(store());
    expect(await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, mcp("config:read"))).toMatchObject({ ok: false, error: "unauthorized" });
    expect((await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, mcp("config:write"))).ok).toBe(true);
    expect(await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, { kind: "access", id: "access:u", scopes: new Set() })).toMatchObject({ ok: false, error: "unauthorized" });
  });
});

describe("config clear", () => {
  it("clears the user's or the channel's runtime overrides (channel gated), so static config shows through again", async () => {
    const config = store(`${YAML}users:\n  "slack:UX":\n    model: anthropic/static\n`);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await commands.invoke("config.set", { args: ["me"], options: { model: "anthropic/runtime" } }, me);
    await commands.invoke("config.set", { args: ["channel"], options: { agent: "review" } }, me);
    expect((await say(commands, "config clear me", me)).text).toBe("Cleared your overrides.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ model: "anthropic/static" });
    expect((await say(commands, "config clear channel", me)).text).toBe("Cleared channel overrides.");
    expect(config.scopes("slack:CX", "slack:UX").channel).toEqual({});
    const gated = store(YAML.replace("permissions:\n", "permissions:\n  channelConfig: []\n"));
    expect(await bind(gated).invoke("config.clear", { args: ["channel"] }, chat(gated, "slack:UX"))).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler" });
  });
});

describe("config instructions", () => {
  it("sets the text (quoted or bare, smart quotes normalized), shows it, clears it with \"\"; the user's text never touches agent/model", async () => {
    const config = store();
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await commands.invoke("config.set", { args: ["me"], options: { agent: "review" } }, me);
    const set = await say(commands, 'config instructions me "Always sign off as Dan."', me);
    expect(set.text).toBe("Updated your instructions (advisory prompt content — they never change agent, model, or permissions):\n> Always sign off as Dan.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ agent: "review", instructions: "Always sign off as Dan." });
    expect((await say(commands, "config instructions me “Be terse”", me)).res.ok).toBe(true);
    expect(config.scopes("slack:CX", "slack:UX").user.instructions).toBe("Be terse");
    expect((await say(commands, "config instructions me", me)).text).toBe('Current your instructions:\n> Be terse\nTo clear: `config instructions me ""`');
    expect((await say(commands, 'config instructions me ""', me)).text).toBe("Cleared your instructions.");
    expect(config.scopes("slack:CX", "slack:UX").user).toEqual({ agent: "review" });
    expect((await say(commands, "config instructions me", me)).text).toBe('No your instructions are set. Example: `config instructions me "Always reply in bullet points"`');
  });

  it("a peek never clears; clearing runtime text says when static config.yaml text shows through; too long is `invalid_input` naming the cap", async () => {
    const config = store(`${YAML}users:\n  "slack:UX":\n    instructions: "Prefer British spelling."\n`);
    const commands = bind(config);
    const me = chat(config, "slack:UX");
    await say(commands, 'config instructions me "runtime"', me);
    await say(commands, "config instructions me", me);
    expect(config.scopes("slack:CX", "slack:UX").user.instructions).toBe("runtime");
    expect((await say(commands, 'config instructions me ""', me)).text).toBe("Cleared your instructions. The static config text now applies:\n> Prefer British spelling.");
    const long = await commands.invoke("config.instructions", { args: ["me", "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1)] }, me);
    expect(long).toMatchObject({ ok: false, error: "invalid_input", message: expect.stringContaining(`capped at ${MAX_INSTRUCTIONS_LENGTH} characters`) });
    expect(JSON.stringify(long)).not.toContain("xxxxxxxxxx");
  });

  it("channel instructions ride the channelConfig gate and target the caller's channel (or --channel); the peek is ungated", async () => {
    const gated = store(YAML.replace("permissions:\n", "permissions:\n  channelConfig: []\n"));
    const commands = bind(gated);
    expect(await commands.invoke("config.instructions", { args: ["channel", "Be French."] }, chat(gated, "slack:UX"))).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler", message: "Channel config changes are restricted." });
    expect(gated.scopes("slack:CX", "slack:UX").channel).toEqual({});
    const admin = chat(gated, "slack:UADMIN");
    expect((await say(commands, "config instructions channel This channel is about billing.", admin)).text).toContain("Updated channel instructions");
    expect(gated.scopes("slack:CX", "slack:UADMIN").channel.instructions).toBe("This channel is about billing.");
    expect((await say(commands, "config instructions channel", chat(gated, "slack:UX"))).text).toBe('Current channel instructions:\n> This channel is about billing.\nTo clear: `config instructions channel ""`');
    await commands.invoke("config.instructions", { args: ["channel", "Elsewhere."], options: { channel: "slack:COTHER" } }, admin);
    expect(gated.scopes("slack:COTHER", "slack:UADMIN").channel.instructions).toBe("Elsewhere.");
    expect((await say(commands, "config instructions channel", chat(gated, "slack:UX", "slack:CEMPTY"))).text).toMatch(/^No channel instructions are set/);
  });

  it("declares the gates and scopes: show is config:read/open, the writers are config:write with the chat gate open (the channel scope is decided inside)", () => {
    const byId = Object.fromEntries(configCommands.map((c) => [c.id, c]));
    expect(byId["config.show"]).toMatchObject({ scope: "config:read", chatGate: "open", effect: "read" });
    for (const id of ["config.set", "config.clear", "config.instructions"]) expect(byId[id], id).toMatchObject({ scope: "config:write", chatGate: "open", effect: "write" });
  });
});
