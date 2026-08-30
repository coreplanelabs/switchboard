import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigStore } from "../config.js";
import { CommandError, CommandRegistry, commandDefiner } from "./commandRegistry.js";
import { bindCommands } from "./commandRegistry.js";
import { handleChatCommand, parseChatCommand, RESERVED_CHAT_COMMANDS, type ChatCommands } from "./commandChat.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import { RunRegistry } from "./runRegistry.js";
import { InMemoryRunStore } from "./runStore.js";
import { createRunsService } from "./runsService.js";
import { registerRunsCommands, type RunsCommandDeps } from "./commands/runs.js";

// Feature: features/command-registry.md — the chat adapter (U13, KTD18/KTD19):
// `<group> <verb> key=value` parsing (registered ids only, whole-message
// anchored, reserved `<group> <verb>` forms refused) and the plain-text reply built from
// `renderCompact` — no Slack escaping in the core.

const NOW = 1_700_000_000_000;

type Deps = { hits: string[] };
const define = commandDefiner<Deps>();

const echo = define({
  id: "demo.echo",
  input: z.object({ status: z.enum(["active", "finished", "all"]), limit: z.coerce.number().int().positive().optional() }),
  scope: "demo:read",
  chatGate: "operator",
  effect: "read",
  describe: "echoes its parsed input",
  handler: async ({ input, deps }) => {
    deps.hits.push("echo");
    return { status: input.status, limit: input.limit ?? null };
  },
});

const hidden = define({
  id: "demo.hidden",
  input: z.object({}),
  scope: "demo:read",
  chatGate: "open",
  effect: "read",
  surfaces: { chat: false },
  describe: "not for chat",
  handler: async () => ({ ok: true }),
});

const missing = define({
  id: "demo.missing",
  input: z.object({ id: z.string() }),
  scope: "demo:read",
  chatGate: "open",
  effect: "read",
  describe: "always not found",
  handler: async () => {
    throw new CommandError("not_found", "thing not found");
  },
});

const config = define({
  id: "config.show",
  input: z.object({}),
  scope: "config:read",
  chatGate: "open",
  effect: "read",
  describe: "pretends to be the legacy config command",
  handler: async () => ({ shadowed: true }),
});

const whoami = define({
  id: "demo.whoami",
  input: z.object({}),
  scope: "demo:read",
  chatGate: "open",
  effect: "read",
  describe: "the caller as the adapter resolved it",
  handler: async ({ caller }) => ({ kind: caller.kind, id: caller.id, channel: caller.channel ?? null }),
});

function demoRegistry() {
  const registry = new CommandRegistry<Deps>({ audit: () => {} });
  for (const cmd of [echo, hidden, missing, config, whoami]) registry.register(cmd);
  return registry;
}

const RESERVED = new Set(["config show", "repo onboard"]);

function configStore(yaml: string): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-chatcmd-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

const ADMIN_YAML = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
permissions:
  admins: ["slack:UADMIN"]
`;

const msg = (text: string, userId = "slack:UX") => ({ channelId: "slack:CX", userId, threadKey: "slack:CX:1.0", text });

describe("parseChatCommand", () => {
  const registry = demoRegistry();

  it("recognizes a registered `<group> <verb>` with key=value args (quoted values allowed)", () => {
    expect(parseChatCommand("demo echo status=all limit=5", registry, RESERVED)).toEqual({ id: "demo.echo", input: { status: "all", limit: "5" } });
    expect(parseChatCommand('  demo echo status="all"  ', registry, RESERVED)).toEqual({ id: "demo.echo", input: { status: "all" } });
    expect(parseChatCommand("demo echo status='all'", registry, RESERVED)).toEqual({ id: "demo.echo", input: { status: "all" } });
    expect(parseChatCommand("demo echo", registry, RESERVED)).toEqual({ id: "demo.echo", input: {} });
  });

  it("is whole-message anchored: prose containing the command mid-sentence is not a command", () => {
    expect(parseChatCommand("can you run demo echo for me", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("demo echo please", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("demo echo status=all and then tell me", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("what does demo echo do?", registry, RESERVED)).toBeNull();
  });

  it("recognizes registered ids only — an unknown verb or group is prose", () => {
    expect(parseChatCommand("demo nope", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("other echo", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("hello there", registry, RESERVED)).toBeNull();
  });

  it("does not recognize a command that opted out of chat (surfaces.chat: false)", () => {
    expect(parseChatCommand("demo hidden", registry, RESERVED)).toBeNull();
  });

  it("refuses `<group> <verb>` forms a legacy parser still owns (reserved), even when the id is registered — per form, not per group", () => {
    expect(parseChatCommand("config show", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("config show", registry, new Set())).toEqual({ id: "config.show", input: {} });
    // `repo onboard` is reserved; `repo list` in the same group is not.
    const repo = new CommandRegistry<Deps>({ audit: () => {} });
    for (const id of ["repo.list", "repo.onboard"]) {
      repo.register(define({ id, input: z.object({}), scope: "repo:read", chatGate: "open", effect: "read", describe: id, handler: async () => ({}) }));
    }
    expect(parseChatCommand("repo list", repo, RESERVED)).toEqual({ id: "repo.list", input: {} });
    expect(parseChatCommand("repo onboard", repo, RESERVED)).toBeNull();
    expect(RESERVED_CHAT_COMMANDS.has("repo onboard")).toBe(true);
    expect(RESERVED_CHAT_COMMANDS.has("repo list")).toBe(false);
    expect([...RESERVED_CHAT_COMMANDS].some((f) => f.startsWith("friction "))).toBe(false);
  });

  it("a malformed argument list is not a command (bare word, missing value)", () => {
    expect(parseChatCommand("demo echo status", registry, RESERVED)).toBeNull();
    expect(parseChatCommand("demo echo status=", registry, RESERVED)).toBeNull();
  });
});

describe("handleChatCommand", () => {
  function setup(yaml = ADMIN_YAML) {
    const registry = demoRegistry();
    const deps: Deps = { hits: [] };
    const commands = bindCommands(registry, deps);
    return { commands, deps, config: configStore(yaml) };
  }

  async function run(commands: ChatCommands, config: ConfigStore, text: string, userId: string) {
    const parsed = parseChatCommand(text, commands, RESERVED);
    if (!parsed) throw new Error(`not a command: ${text}`);
    return handleChatCommand({ commands, parsed, msg: msg(text, userId), config });
  }

  it("a non-admin gets the restricted wording other commands use; the handler never runs", async () => {
    const { commands, deps, config } = setup();
    const reply = await run(commands, config, "demo echo status=all", "slack:UX");
    expect(reply).toBe("🚫 `demo echo` is restricted. Ask <@slack:UADMIN>.");
    expect(deps.hits).toEqual([]);
  });

  it("an admin's command is coerced, invoked, and rendered through renderCompact as plain key: value lines", async () => {
    const { commands, deps, config } = setup();
    const reply = await run(commands, config, "demo echo status=all limit=5", "slack:UADMIN");
    expect(reply).toBe("status: all\nlimit: 5");
    expect(deps.hits).toEqual(["echo"]);
  });

  it("invalid input → one line naming the field, never echoing the value", async () => {
    const { commands, config } = setup();
    const reply = await run(commands, config, "demo echo status=bogus", "slack:UADMIN");
    expect(reply).toBe('⚠️ `demo echo`: status: expected one of "active", "finished", "all"');
    expect(reply).not.toContain("bogus");
  });

  it("not_found → one line with the handler's message", async () => {
    const { commands, config } = setup();
    expect(await run(commands, config, "demo missing id=x", "slack:UADMIN")).toBe("⚠️ `demo missing`: thing not found");
  });

  it("a machine caller's chat command is channel-pinned: an `http:`/`mcp:` message pins `caller.channel` to its channelId; a Slack human stays unpinned", async () => {
    const { commands, config } = setup();
    const parsed = parseChatCommand("demo whoami", commands, RESERVED)!;
    const via = (channelId: string, userId: string) => handleChatCommand({ commands, parsed, msg: { channelId, userId }, config });
    expect(await via("http:ops", "http:ops")).toBe("kind: chat\nid: http:ops\nchannel: http:ops");
    expect(await via("mcp:alice", "mcp:alice")).toBe("kind: chat\nid: mcp:alice\nchannel: mcp:alice");
    expect(await via("slack:CX", "slack:UX")).toBe("kind: chat\nid: slack:UX\nchannel: null");
    expect(await via("cli:local", "cli:local")).toBe("kind: chat\nid: cli:local\nchannel: null");
  });

  it("a caller with no admins configured is refused (isOperator is fail-closed)", async () => {
    const { commands, deps, config } = setup(ADMIN_YAML.replace('  admins: ["slack:UADMIN"]\n', ""));
    const reply = await run(commands, config, "demo echo status=all", "slack:UX");
    expect(reply).toContain("🚫");
    expect(reply).toContain("Ask an admin");
    expect(deps.hits).toEqual([]);
  });
});

describe("runs list on chat (KTD18)", () => {
  function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
    const events = [
      { type: "input" as const, text: "please do the thing", seq: 1 },
      { type: "answer" as const, text: "all done", seq: 2 },
    ];
    return {
      id,
      label: `coding · acme/${id} <!channel> "please do the thing"`,
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:D0PRIVATE",
      userId: "slack:UOWNER",
      threadKey: `slack:D0PRIVATE:${id}`,
      startedAt: finishedAt - 65_000,
      finishedAt,
      status: "completed",
      eventCount: events.length,
      storedEventCount: events.length,
      truncated: false,
      events,
      diagnosis: analyzeRunFriction(events),
      ...over,
    };
  }

  async function setup() {
    const reg = new RunRegistry({ genId: () => "live0001", genToken: () => "tok-secret", now: () => NOW });
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put(record("fin00001", NOW - 1000));
    const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
    registerRunsCommands(registry);
    const commands = bindCommands(registry, { runs: createRunsService({ registry: reg, store }) });
    reg.create("review · acme/api <!channel>", { agent: "review", channelId: "slack:D0PRIVATE", userId: "slack:UOWNER", threadKey: "slack:D0PRIVATE:t" });
    return { commands, config: configStore(ADMIN_YAML) };
  }

  it("an admin's `runs list status=all` renders short id · agent · status · duration only — no channel, user, thread, label, or token", async () => {
    const { commands, config } = await setup();
    const parsed = parseChatCommand("runs list status=all", commands, RESERVED);
    expect(parsed).toEqual({ id: "runs.list", input: { status: "all" } });
    const reply = await handleChatCommand({ commands, parsed: parsed!, msg: msg("runs list status=all", "slack:UADMIN"), config, now: NOW });
    expect(reply.split("\n")).toEqual(["live0001  review    active        0s", "fin00001  coding    completed     1m 5s"]);
    expect(reply).not.toMatch(/slack:D|UOWNER|threadKey|acme|<!channel>|tok-secret|please do/);
  });

  it("a non-admin's `runs list` is refused", async () => {
    const { commands, config } = await setup();
    const parsed = parseChatCommand("runs list status=all", commands, RESERVED)!;
    expect(await handleChatCommand({ commands, parsed, msg: msg("runs list status=all", "slack:UX"), config })).toBe("🚫 `runs list` is restricted. Ask <@slack:UADMIN>.");
  });

  it("`runs get`/`events`/`friction`/`stop` are not chat commands (opt-out) except stop, which is", async () => {
    const { commands } = await setup();
    expect(parseChatCommand("runs get id=fin00001", commands, RESERVED)).toBeNull();
    expect(parseChatCommand("runs events id=fin00001", commands, RESERVED)).toBeNull();
    expect(parseChatCommand("runs friction id=fin00001", commands, RESERVED)).toBeNull();
    expect(parseChatCommand("runs stop id=live0001 mode=soft", commands, RESERVED)).toEqual({ id: "runs.stop", input: { id: "live0001", mode: "soft" } });
  });
});
