import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigStore } from "../config.js";
import { CommandError, CommandRegistry, bindCommands, commandDefiner, type CommandDef } from "./commandRegistry.js";
import { handleChatCommand, HELP_COMMAND_ID, invokeChatCommand, parseChatCommand, type ChatCommands } from "./commandChat.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import { RunRegistry } from "./runRegistry.js";
import { InMemoryRunStore } from "./runStore.js";
import { createRunsService } from "./runsService.js";
import { registerRunsCommands, type RunsCommandDeps } from "./commands/runs.js";

// Feature: features/command-registry.md — the chat adapter (U13, KTD18/KTD19/
// KTD21): `<group> <verb> <args…> [--kebab-flag value…]` recognized for
// registered, chat-exposed, non-reserved ids and bound by the SAME grammar the
// CLI uses; a recognized form with a malformed tail is a usage reply; help is
// derived; the plain-text reply is `renderText` — no Slack escaping in the core.

const NOW = 1_700_000_000_000;

type Deps = { hits: string[] };
const define = commandDefiner<Deps>();

const echo = define({
  id: "demo.echo",
  options: z.object({ status: z.enum(["active", "finished", "all"]).describe("which"), limit: z.coerce.number().int().positive().optional().describe("how many") }),
  action: "runs:read",
  effect: "read",
  describe: "echoes its parsed options",
  handler: async ({ options, deps }) => {
    deps.hits.push("echo");
    return { status: options.status, limit: options.limit ?? null };
  },
});

const hidden = define({
  id: "demo.hidden",
  action: "runs:read",
  effect: "read",
  surfaces: { chat: false },
  describe: "not for chat",
  handler: async () => ({ ok: true }),
});

const missing = define({
  id: "demo.missing",
  args: [{ name: "id", schema: z.string(), describe: "an id" }],
  action: "runs:read",
  effect: "read",
  describe: "always not found",
  handler: async () => {
    throw new CommandError("not_found", "thing not found");
  },
});

const config = define({
  id: "config.show",
  action: "config:read",
  effect: "read",
  describe: "pretends to be the legacy config command",
  handler: async () => ({ shadowed: true }),
});

const whoami = define({
  id: "demo.whoami",
  action: "help:read",
  effect: "read",
  describe: "the caller as the adapter resolved it",
  handler: async ({ caller }) => ({ kind: caller.kind, id: caller.id, actor: caller.actor ? `${caller.actor.kind} ${caller.actor.id}` : null }),
});

const say = define({
  id: "demo.say",
  args: [
    { name: "scope", schema: z.enum(["me", "channel"]), describe: "scope" },
    { name: "text", schema: z.string().optional(), describe: "free text", rest: true },
  ],
  action: "runs:read",
  effect: "read",
  describe: "echoes free text",
  handler: async ({ args }) => ({ scope: args.scope, text: args.text ?? null }),
});

const url = define({
  id: "demo.url",
  options: z.object({ url: z.string().url().describe("an http(s) url") }),
  action: "runs:read",
  effect: "read",
  describe: "takes a url option — what Slack link markup must not break",
  handler: async ({ options }) => ({ url: options.url }),
});

function demoRegistry() {
  const registry = new CommandRegistry<Deps>({ audit: () => {} });
  for (const cmd of [echo, hidden, missing, config, whoami, say, url] as CommandDef<Deps>[]) registry.register(cmd);
  return registry;
}


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

  it("recognizes a registered `<group> <verb>` and binds --kebab flags (value, =value, quoted) into camelCase options", () => {
    expect(parseChatCommand("demo echo --status all --limit 5", registry)).toEqual({ kind: "invoke", id: "demo.echo", input: { args: [], options: { status: "all", limit: "5" } } });
    expect(parseChatCommand('  demo echo --status="all"  ', registry)).toEqual({ kind: "invoke", id: "demo.echo", input: { args: [], options: { status: "all" } } });
    expect(parseChatCommand("demo echo --status 'all'", registry)).toEqual({ kind: "invoke", id: "demo.echo", input: { args: [], options: { status: "all" } } });
    expect(parseChatCommand("demo echo", registry)).toEqual({ kind: "invoke", id: "demo.echo", input: { args: [], options: {} } });
  });

  it("unwraps Slack link markup before binding: `<url>`, auto-link `<url|label>` and a custom-labelled link all bind the bare url, with `&amp;`/`&lt;`/`&gt;` restored; a mention stays out of the tail", () => {
    // Slack delivers every pasted URL as `<https://…>` (and a client that
    // renders labels as `<url|label>`) — a `--url` value must survive that.
    expect(parseChatCommand("demo url --url <https://mcp.example.com/mcp>", registry)).toEqual({ kind: "invoke", id: "demo.url", input: { args: [], options: { url: "https://mcp.example.com/mcp" } } });
    expect(parseChatCommand("demo url --url <https://mcp.example.com/mcp|mcp.example.com/mcp>", registry)).toEqual({ kind: "invoke", id: "demo.url", input: { args: [], options: { url: "https://mcp.example.com/mcp" } } });
    expect(parseChatCommand("demo url --url <https://mcp.example.com/mcp?a=1&amp;b=2|the server>", registry)).toEqual({ kind: "invoke", id: "demo.url", input: { args: [], options: { url: "https://mcp.example.com/mcp?a=1&b=2" } } });
    // All three entities Slack escapes in message text are restored, not just `&amp;`.
    expect(parseChatCommand("demo url --url <https://mcp.example.com/mcp?q=a&lt;b&gt;c&amp;d>", registry)).toEqual({ kind: "invoke", id: "demo.url", input: { args: [], options: { url: "https://mcp.example.com/mcp?q=a<b>c&d" } } });
    // Only http(s) links unwrap; a leading mention (or any other `<…>`) is left to the grammar as before.
    expect(parseChatCommand("demo say me see <@U123> and <#C456|general>", registry)).toEqual({ kind: "invoke", id: "demo.say", input: { args: ["me", "see <@U123> and <#C456|general>"], options: {} } });
  });

  it("binds positionals, including free text with Slack smart quotes", () => {
    expect(parseChatCommand("demo say me be terse, always", registry)).toEqual({ kind: "invoke", id: "demo.say", input: { args: ["me", "be terse, always"], options: {} } });
    expect(parseChatCommand("demo say channel “quoted  text”", registry)).toEqual({ kind: "invoke", id: "demo.say", input: { args: ["channel", "quoted  text"], options: {} } });
    expect(parseChatCommand("demo missing abc", registry)).toEqual({ kind: "invoke", id: "demo.missing", input: { args: ["abc"], options: {} } });
  });

  it("prose is never a command: a mid-sentence mention, an unknown verb or group, a chat-hidden id → null; no form is reserved for a legacy parser any more", () => {
    expect(parseChatCommand("can you run demo echo for me", registry)).toBeNull();
    expect(parseChatCommand("what does demo echo do?", registry)).toBeNull();
    expect(parseChatCommand("demo nope", registry)).toBeNull();
    expect(parseChatCommand("other echo", registry)).toBeNull();
    expect(parseChatCommand("hello there", registry)).toBeNull();
    expect(parseChatCommand("demo hidden", registry)).toBeNull();
    expect(parseChatCommand("config show", registry)).toEqual({ kind: "invoke", id: "config.show", input: { args: [], options: {} } });
  });

  it("the bare word `help` is `help show` when it is registered and chat-exposed — else prose (KTD25)", () => {
    expect(parseChatCommand("help", registry)).toBeNull();
    expect(parseChatCommand("help me", registry)).toBeNull();
    const withHelp = demoRegistry();
    withHelp.register(define({ id: HELP_COMMAND_ID, action: "help:read", effect: "read", describe: "help", handler: async () => ({}) }));
    expect(parseChatCommand("help", withHelp)).toEqual({ kind: "invoke", id: "help.show", input: { args: [], options: {} } });
    expect(parseChatCommand("  Help  ", withHelp)).toEqual({ kind: "invoke", id: "help.show", input: { args: [], options: {} } });
    expect(parseChatCommand("help show", withHelp)).toEqual({ kind: "invoke", id: "help.show", input: { args: [], options: {} } });
    expect(parseChatCommand("help me", withHelp)).toBeNull();
    const hiddenHelp = demoRegistry();
    hiddenHelp.register(define({ id: HELP_COMMAND_ID, action: "help:read", effect: "read", surfaces: { chat: false }, describe: "help", handler: async () => ({}) }));
    expect(parseChatCommand("help", hiddenHelp)).toBeNull();
  });

  it("a recognized command with a malformed tail is an `invalid_input` reply (the registry's own code, one vocabulary) naming the flag/argument — never a model turn, never the value", () => {
    expect(parseChatCommand("demo echo please", registry)).toEqual({ kind: "reply", error: "invalid_input", text: "⚠️ `demo echo`: demo echo takes no arguments\nusage: demo echo --status <active|finished|all> [--limit <integer>]" });
    expect(parseChatCommand("demo echo --status", registry)).toMatchObject({ kind: "reply", error: "invalid_input", text: expect.stringContaining("option --status needs a value") });
    expect(parseChatCommand("demo echo --bogus s3cret", registry)).toMatchObject({ kind: "reply", error: "invalid_input", text: expect.stringContaining("unknown option --bogus") });
    expect(JSON.stringify(parseChatCommand("demo echo --bogus s3cret", registry))).not.toContain("s3cret");
    expect(parseChatCommand("demo echo status=all", registry)).toMatchObject({ kind: "reply", error: "invalid_input", text: expect.stringContaining("takes no arguments") });
    expect(parseChatCommand("demo missing", registry)).toMatchObject({ kind: "reply", error: "invalid_input", text: expect.stringContaining("missing argument <id>") });
    expect(parseChatCommand('demo say me "open quote', registry)).toEqual({ kind: "reply", error: "invalid_input", text: "⚠️ `demo say`: unterminated quote" });
    // A help reply carries no code.
    expect(parseChatCommand("demo echo --help", registry)).not.toHaveProperty("error");
  });

  it("help is derived: `<group> <verb> --help` gives the command's help, `<group> help` lists the group's chat commands", () => {
    expect(parseChatCommand("demo echo --help", registry)).toEqual({
      kind: "reply",
      text: ["echoes its parsed options", "usage: demo echo --status <active|finished|all> [--limit <integer>]", "options:", "  --status <active|finished|all>  which (required)", "  --limit <integer>               how many"].join("\n"),
    });
    const group = parseChatCommand("demo help", registry);
    expect(group).toMatchObject({ kind: "reply", text: expect.stringMatching(/^demo commands:\n/) });
    expect((group as { text: string }).text).toContain("demo echo");
    expect((group as { text: string }).text).not.toContain("demo hidden");
    expect(parseChatCommand("nothing help", registry)).toBeNull();
  });

  it("a group's verbs are recognized independently: a registered verb binds, an unregistered sibling is prose", () => {
    const repo = new CommandRegistry<Deps>({ audit: () => {} });
    repo.register(define({ id: "repo.list", action: "repo:read", effect: "read", describe: "list", handler: async () => ({}) }));
    expect(parseChatCommand("repo list", repo)).toEqual({ kind: "invoke", id: "repo.list", input: { args: [], options: {} } });
    expect(parseChatCommand("repo onboard acme/api", repo)).toBeNull();
  });
});

describe("chatCallerFor", () => {
  it("carries the message's channel + thread as `origin` (context, never authority) and the lazy repo resolver when given", async () => {
    const { chatCallerFor } = await import("./commandChat.js");
    const config = configStore(ADMIN_YAML);
    const c = chatCallerFor(msg("x", "slack:UX"), config);
    expect(c.origin).toEqual({ channelId: "slack:CX", threadKey: "slack:CX:1.0" });
    expect(c).not.toHaveProperty("channel");
    const resolve = async () => "acme/api";
    expect(chatCallerFor(msg("x"), config, resolve).origin?.repo).toBe(resolve);
  });

  it("carries the message's user as the Actor the table decides on (plan U2/U4): admin → everything, a plain user → the open chat commands + the unrestricted agents, a machine channel's user → a service actor", async () => {
    const { chatCallerFor } = await import("./commandChat.js");
    const { ALL_GRANTS, CHAT_OPEN_ACTIONS } = await import("./authz/grants.js");
    const config = configStore(ADMIN_YAML);
    expect(chatCallerFor(msg("x", "slack:UADMIN"), config).actor).toEqual({ kind: "user", id: "slack:UADMIN", grants: ALL_GRANTS, origin: { channelId: "slack:CX", threadKey: "slack:CX:1.0" } });
    const plain = chatCallerFor(msg("x", "slack:UX"), config).actor;
    expect(plain).toMatchObject({ kind: "user", id: "slack:UX", grants: { channels: new Set(), repos: new Set() } });
    // The `open` chat gate as grants, `config:write` (no channelConfig key), and — no agent being restricted in ADMIN_YAML — every registered agent (canRunAgent today).
    for (const a of [...CHAT_OPEN_ACTIONS, "config:write", "agent:run:general"]) expect(plain.grants.actions, a).toContain(a);
    expect([...(plain.grants.actions as Set<string>)].every((a) => a.startsWith("agent:run:") || a === "config:write" || CHAT_OPEN_ACTIONS.includes(a))).toBe(true);
    expect(plain.grants.actions).not.toContain("runs:read");
    const machine = chatCallerFor({ userId: "http:cron", channelId: "http:cron", threadKey: "http:cron:t" }, config);
    expect(machine).not.toHaveProperty("channel");
    expect(machine.actor).toMatchObject({ kind: "service", id: "http:cron", origin: { channelId: "http:cron", threadKey: "http:cron:t" } });
    // A schedule firing that reaches chat as its `schedule:` actor (R9): the registry's declared grants, kind `schedule`.
    const schedule = chatCallerFor({ userId: "schedule:self-improvement", channelId: "http:cron", threadKey: "http:cron:t" }, config);
    expect(schedule.actor).toMatchObject({ kind: "schedule", id: "schedule:self-improvement", grants: { actions: new Set(["friction:read", "friction:write"]), channels: "all" } });
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
    const parsed = parseChatCommand(text, commands);
    if (!parsed) throw new Error(`not a command: ${text}`);
    return handleChatCommand({ commands, parsed, msg: msg(text, userId), config });
  }

  it("a non-admin gets the restricted wording other commands use; the handler never runs", async () => {
    const { commands, deps, config } = setup();
    const reply = await run(commands, config, "demo echo --status all", "slack:UX");
    expect(reply).toBe("🚫 `demo echo` is restricted. Ask <@slack:UADMIN>.");
    expect(deps.hits).toEqual([]);
  });

  it("an admin's command is coerced, invoked, and rendered through renderCompact as plain key: value lines", async () => {
    const { commands, deps, config } = setup();
    const reply = await run(commands, config, "demo echo --status all --limit 5", "slack:UADMIN");
    expect(reply).toBe("status: all\nlimit: 5");
    expect(deps.hits).toEqual(["echo"]);
  });

  it("invalid input → one line naming the option, never echoing the value", async () => {
    const { commands, config } = setup();
    const reply = await run(commands, config, "demo echo --status bogus", "slack:UADMIN");
    expect(reply).toBe('⚠️ `demo echo`: status: expected one of "active", "finished", "all"');
    expect(reply).not.toContain("bogus");
  });

  it("a refusal the HANDLER decided carries its reason; one the registry decided is the fixed restricted line", async () => {
    const registry = demoRegistry();
    registry.register(
      define({
        id: "demo.mine",
        action: "help:read",
        effect: "read",
        describe: "refuses on data",
        handler: async () => {
          throw new CommandError("unauthorized", "You're not on the allowlist for the `acme/api` repo environment.");
        },
      }),
    );
    const commands = bindCommands(registry, { hits: [] });
    const config = configStore(ADMIN_YAML);
    expect(await run(commands, config, "demo mine", "slack:UX")).toBe("🚫 `demo mine`: You're not on the allowlist for the `acme/api` repo environment. Ask <@slack:UADMIN>.");
    expect(await run(commands, config, "demo echo --status all", "slack:UX")).toBe("🚫 `demo echo` is restricted. Ask <@slack:UADMIN>.");
  });

  it("not_found → one line with the handler's message; a rejected/help parse is replied as-is without invoking, the rejection carrying `invalid_input` like a registry refusal would", async () => {
    const { commands, deps, config } = setup();
    expect(await run(commands, config, "demo missing x", "slack:UADMIN")).toBe("⚠️ `demo missing`: thing not found");
    expect(await run(commands, config, "demo echo please", "slack:UX")).toContain("takes no arguments");
    expect(await run(commands, config, "demo echo --help", "slack:UX")).toContain("usage: demo echo");
    const rejected = await invokeChatCommand({ commands, parsed: parseChatCommand("demo echo please", commands)!, msg: msg("demo echo please", "slack:UX"), config });
    expect(rejected).toMatchObject({ ok: false, error: "invalid_input", text: expect.stringContaining("takes no arguments") });
    const help = await invokeChatCommand({ commands, parsed: parseChatCommand("demo echo --help", commands)!, msg: msg("demo echo --help", "slack:UX"), config });
    expect(help.ok).toBe(false);
    expect(help).not.toHaveProperty("error");
    expect(deps.hits).toEqual([]);
  });

  it("every chat caller carries its Actor and no channel pin: a machine credential speaking as text (`http:`/`mcp:`) is a service actor whose grants — not the channel it speaks in — decide what it may run and see (authorization.md item 7)", async () => {
    // A machine identity's text command needs the grant its tool call would (the native `grants` block names it).
    const { commands, config } = setup(`${ADMIN_YAML}grants:\n  "http:ops":\n    actions: [help:read]\n  "mcp:alice":\n    actions: [help:read]\n`);
    const parsed = parseChatCommand("demo whoami", commands)!;
    const via = (channelId: string, userId: string) => handleChatCommand({ commands, parsed, msg: { channelId, userId, threadKey: `${channelId}:t` }, config });
    expect(await via("http:ops", "http:ops")).toBe("kind: chat\nid: http:ops\nactor: service http:ops");
    expect(await via("mcp:alice", "mcp:alice")).toBe("kind: chat\nid: mcp:alice\nactor: service mcp:alice");
    expect(await via("slack:CX", "slack:UX")).toBe("kind: chat\nid: slack:UX\nactor: user slack:UX");
    expect(await via("cli:local", "cli:local")).toBe("kind: chat\nid: cli:local\nactor: user cli:local");
  });

  it("a caller with no admins configured is refused (no admins → nobody holds runs:read; fail-closed)", async () => {
    const { commands, deps, config } = setup(ADMIN_YAML.replace('  admins: ["slack:UADMIN"]\n', ""));
    const reply = await run(commands, config, "demo echo --status all", "slack:UX");
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
      channelVisibility: "unknown",
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
    const commands = bindCommands(registry, { runs: async () => createRunsService({ registry: reg, store }) });
    reg.create("review · acme/api <!channel>", { agent: "review", channelId: "slack:D0PRIVATE", userId: "slack:UOWNER", threadKey: "slack:D0PRIVATE:t" });
    return { commands, config: configStore(ADMIN_YAML) };
  }

  it("an admin's `runs list --status all` renders short id · agent · status · duration only — no channel, user, thread, label, or token", async () => {
    const { commands, config } = await setup();
    const parsed = parseChatCommand("runs list --status all", commands);
    expect(parsed).toEqual({ kind: "invoke", id: "runs.list", input: { args: [], options: { status: "all" } } });
    const reply = await handleChatCommand({ commands, parsed: parsed!, msg: msg("runs list --status all", "slack:UADMIN"), config, now: NOW });
    expect(reply.split("\n")).toEqual(["live0001  review    active        0s", "fin00001  coding    completed     1m 5s"]);
    expect(reply).not.toMatch(/slack:D|UOWNER|threadKey|acme|<!channel>|tok-secret|please do/);
  });

  it("a non-admin's `runs list` is refused", async () => {
    const { commands, config } = await setup();
    const parsed = parseChatCommand("runs list --status all", commands)!;
    expect(await handleChatCommand({ commands, parsed, msg: msg("runs list --status all", "slack:UX"), config })).toBe("🚫 `runs list` is restricted. Ask <@slack:UADMIN>.");
  });

  it("`runs get/events/friction <id>` are not chat commands (opt-out); `runs stop <id> --mode soft` is", async () => {
    const { commands } = await setup();
    expect(parseChatCommand("runs get fin00001", commands)).toBeNull();
    expect(parseChatCommand("runs events fin00001", commands)).toBeNull();
    expect(parseChatCommand("runs friction fin00001", commands)).toBeNull();
    expect(parseChatCommand("runs stop live0001 --mode soft", commands)).toEqual({ kind: "invoke", id: "runs.stop", input: { args: ["live0001"], options: { mode: "soft" } } });
  });
});
