import { describe, expect, it } from "vitest";
import { CommandError, CommandRegistry, bindCommands, renderCompact, type CommandInvoker } from "./core/commandRegistry.js";
import { registerRunsCommands, type RunsCommandDeps } from "./core/commands/runs.js";
import type { RunEvent } from "./core/runEvents.js";
import { analyzeRunFriction } from "./core/runFriction.js";
import { RunRegistry } from "./core/runRegistry.js";
import { InMemoryRunStore } from "./core/runStore.js";
import { createRunsService } from "./core/runsService.js";
import { bindBotConfig, CLI_CALLER, loadBotConfig, missingBotConfig, parseCliArgv, runCli, runCommand, type CliInvocation } from "./cli.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config.js";
import { buildCoreCommands } from "./core/commandCatalogue.js";
import { registerCoreCommands, type CoreCommandDeps } from "./core/commands/all.js";

// Feature: features/command-registry.md — the derived CLI (`npx tsx src/cli.ts
// <group> <verb> [args…] [--option value…] [--json]`, KTD21): argv goes through
// the SAME grammar chat uses; `runCli` is the transport-free path `main()` and
// the contract test share. Exit codes: 2 = the invocation was rejected (usage,
// or `invalid_input` from the grammar or the registry), 1 = command error. The one
// built-in beside the derived commands is `ask` (KTD22).

const NOW = 1_700_000_000_000;

async function fixture() {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `live-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const live = reg.create("coding · acme/live", { agent: "coding", channelId: "slack:C1", userId: "slack:U1", threadKey: "slack:C1:t" });
  const store = new InMemoryRunStore({ now: () => NOW });
  const events: RunEvent[] = [{ type: "input", text: "please", seq: 1 }];
  await store.put({
    id: "fin-1",
    agent: "coding",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:fin-1",
    startedAt: NOW - 11_000,
    finishedAt: NOW - 1000,
    status: "completed",
    eventCount: 1,
    storedEventCount: 1,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
  });
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const commands: CommandInvoker = bindCommands(registry, { runs: async () => createRunsService({ registry: reg, store }) });
  return { commands, live, reg };
}

describe("CLI_CALLER — the local operator", () => {
  it("is cli:local with every scope, and the same identity as the cli:local Actor holding every grant (plan U2)", () => {
    expect(CLI_CALLER).toEqual({ kind: "cli", id: "cli:local", scopes: "all", actor: { kind: "user", id: "cli:local", grants: { actions: "all", channels: "all", repos: "all" } } });
  });
});

describe("parseCliArgv", () => {
  it("parses <group> <verb> plus positionals and --kebab flags (value or =value) through the shared grammar; --json is the one switch", async () => {
    const { commands } = await fixture();
    expect(parseCliArgv(["runs", "list", "--status", "all", "--limit=10", "--json"], commands)).toEqual({
      kind: "command",
      id: "runs.list",
      input: { args: [], options: { status: "all", limit: "10" } },
      json: true,
    });
    expect(parseCliArgv(["runs", "get", "abc", "--include", "messages"], commands)).toEqual({ kind: "command", id: "runs.get", input: { args: ["abc"], options: { include: "messages" } }, json: false });
    expect(parseCliArgv(["runs", "stop", "abc", "--mode=soft"], commands)).toMatchObject({ kind: "command", input: { args: ["abc"], options: { mode: "soft" } } });
  });

  it("keeps '=' inside a value; an empty value is an empty string; kebab maps to camel (--since-ms → sinceMs)", async () => {
    const { commands } = await fixture();
    expect(parseCliArgv(["runs", "list", "--status=all", "--channel=slack:C1=x"], commands)).toMatchObject({ input: { options: { status: "all", channel: "slack:C1=x" } } });
    expect(parseCliArgv(["runs", "list", "--agent="], commands)).toMatchObject({ input: { options: { agent: "" } } });
    expect(parseCliArgv(["runs", "list", "--since-ms", "5", "--before-id", "abc"], commands)).toMatchObject({ input: { options: { sinceMs: "5", beforeId: "abc" } } });
  });

  it("usage errors (exit 2): no verb, a malformed word, an unknown command with the catalogue — the faults the registry has no code for", async () => {
    const { commands } = await fixture();
    for (const argv of [["runs"], ["Runs", "list"], ["runs", "list.all"], ["runs", "frobnicate"]]) {
      const res = parseCliArgv(argv, commands);
      expect(res.kind, argv.join(" ")).toBe("usage");
      if (res.kind === "usage") expect(res.error).toMatch(/usage/i);
    }
    const unknown = parseCliArgv(["runs", "frobnicate"], commands);
    expect(unknown).toMatchObject({ kind: "usage", error: expect.stringContaining("unknown command: runs frobnicate") });
    expect((unknown as { error: string }).error).toContain("runs list");
  });

  it("a malformed tail of a real command — a flag without a value, a stray positional, a short flag, an unknown option — is the registry's own `invalid_input` (one error vocabulary), with the usage hint as its message", async () => {
    const { commands } = await fixture();
    for (const argv of [["runs", "list", "--status"], ["runs", "list", "extra"], ["runs", "list", "-s", "all"], ["runs", "list", "--bogus", "s3cret"]]) {
      const res = parseCliArgv(argv, commands);
      expect(res, argv.join(" ")).toMatchObject({ kind: "invalid", code: "invalid_input", error: expect.stringContaining("usage: runs list") });
      expect(JSON.stringify(res)).not.toContain("s3cret");
    }
  });

  it("help: no args / help / --help → the catalogue; `<group> <verb> --help` → that command's derived help", async () => {
    const { commands } = await fixture();
    expect(parseCliArgv([], commands)).toEqual({ kind: "catalogue" });
    expect(parseCliArgv(["help"], commands)).toEqual({ kind: "catalogue" });
    expect(parseCliArgv(["--help"], commands)).toEqual({ kind: "catalogue" });
    expect(parseCliArgv(["runs", "stop", "--help"], commands)).toEqual({ kind: "command-help", id: "runs.stop" });
    const out = await runCli(commands, { kind: "command-help", id: "runs.stop" }, CLI_CALLER);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split("\n")[1]).toBe("usage: runs stop <id> --mode <soft|hard>");
    const cat = await runCli(commands, { kind: "catalogue" }, CLI_CALLER);
    expect(cat.stdout).toContain("runs list");
    expect(cat.stdout).toContain("ask [--thread <key>]");
  });
});

describe("parseCliArgv — the `ask` built-in (the channel harness, not a registry command)", () => {
  const now = () => 1234;
  it("--thread <key> is honored and stripped from the request text; --thread=<key> works too", async () => {
    const { commands } = await fixture();
    expect(parseCliArgv(["ask", "--thread", "cli:u5test", "agent:coding", "do it"], commands, now)).toEqual({ kind: "ask", threadKey: "cli:u5test", text: "agent:coding do it" });
    expect(parseCliArgv(["ask", "--thread=cli:u5test", "hello"], commands, now)).toEqual({ kind: "ask", threadKey: "cli:u5test", text: "hello" });
  });

  it("defaults to an ephemeral per-invocation key; the words are joined", async () => {
    const { commands } = await fixture();
    expect(parseCliArgv(["ask", "what", "is", "2+2"], commands, now)).toEqual({ kind: "ask", threadKey: "cli:1234", text: "what is 2+2" });
  });

  it("an empty request or a dangling --thread is a usage error", async () => {
    const { commands } = await fixture();
    expect(parseCliArgv(["ask"], commands, now)).toMatchObject({ kind: "usage", error: expect.stringContaining("ask needs a request") });
    expect(parseCliArgv(["ask", "hi", "--thread"], commands, now)).toMatchObject({ kind: "usage", error: expect.stringContaining("--thread needs a value") });
  });
});

describe("runCommand", () => {
  function command(argv: string[], commands: CommandInvoker) {
    const parsed = parseCliArgv(argv, commands);
    if (parsed.kind !== "command") throw new Error(JSON.stringify(parsed));
    return parsed;
  }

  it("--json prints the exact invoke JSON with exit 0 and no token", async () => {
    const { commands } = await fixture();
    const out = await runCommand(commands, command(["runs", "list", "--status", "all", "--json"], commands), CLI_CALLER);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    const direct = await commands.invoke("runs.list", { options: { status: "all" } }, CLI_CALLER);
    expect(JSON.parse(out.stdout)).toEqual(direct.ok ? direct.value : null);
    expect(out.stdout).not.toContain("tok-");
  });

  it("without --json prints renderCompact of the same object", async () => {
    const { commands } = await fixture();
    const out = await runCommand(commands, command(["runs", "list", "--status", "all"], commands), CLI_CALLER, { now: NOW });
    const direct = await commands.invoke("runs.list", { options: { status: "all" } }, CLI_CALLER);
    expect(out.stdout).toBe(renderCompact("runs.list", direct.ok ? direct.value : null, { now: NOW }));
    expect(out.stdout).toContain("live-1");
    expect(out.stdout).not.toContain("tok-");
  });

  it("a rejected input is exit 2 with `error (invalid_input): …` on stderr whether the registry or the grammar refused it; any other command failure is exit 1; nothing on stdout, never the value", async () => {
    const { commands } = await fixture();
    const out = await runCommand(commands, command(["runs", "list", "--status", "s3cret"], commands), CLI_CALLER);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/^error \(invalid_input\): status: /);
    expect(out.stderr).not.toContain("s3cret");
    const grammar = await runCli(commands, parseCliArgv(["runs", "list", "--bogus", "s3cret"], commands) as Extract<ReturnType<typeof parseCliArgv>, { kind: "invalid" }>, CLI_CALLER);
    expect(grammar).toEqual({ exitCode: 2, stdout: "", stderr: expect.stringMatching(/^error \(invalid_input\): unknown option --bogus\nusage: runs list/) });
    expect(grammar.stderr).not.toContain("s3cret");
    expect(await runCommand(commands, command(["runs", "get", "nope", "--json"], commands), CLI_CALLER)).toMatchObject({ exitCode: 1, stdout: "", stderr: expect.stringMatching(/^error \(not_found\)/) });
  });

  it("runs stop <id> --mode soft from the CLI records the cli:local actor", async () => {
    const { commands, live, reg } = await fixture();
    const out = await runCommand(commands, command(["runs", "stop", live.id, "--mode", "soft", "--json"], commands), CLI_CALLER);
    expect(out.exitCode).toBe(0);
    const note = reg.snapshotById(live.id)!.events.find((e) => e.type === "run_note" && e.kind === "stop_requested") as { actor?: unknown };
    expect(note.actor).toEqual({ kind: "cli", id: "cli:local" });
  });

  it("runCli routes a usage parse to exit 2 with nothing on stdout", async () => {
    const { commands } = await fixture();
    const out = await runCli(commands, parseCliArgv(["runs", "frobnicate"], commands) as Extract<ReturnType<typeof parseCliArgv>, { kind: "usage" }>, CLI_CALLER);
    expect(out).toMatchObject({ exitCode: 2, stdout: "" });
    expect(out.stderr).toContain("runs list");
  });
});

describe("buildCoreCommands — the one catalogue every in-process binding shares (index.ts, cli.ts)", () => {
  it("registers the full catalogue and serves runs.list from the given store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-cli-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, "providers:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\n");
    const config = new ConfigStore(cfg, join(dir, "overrides.json"));
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put({
      id: "fin-9",
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: "slack:C1:fin-9",
      startedAt: NOW - 11_000,
      finishedAt: NOW - 1000,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([]),
    });
    const commands = buildCoreCommands(config, store, { registry: new RunRegistry({ now: () => NOW }), env: {}, dataDir: dir, warn: () => {} });
    const expected = new CommandRegistry<CoreCommandDeps>();
    registerCoreCommands(expected);
    expect(commands.list().map((c) => c.id)).toEqual(expected.list().map((c) => c.id));
    const res = await commands.invoke("runs.list", { options: { status: "all" } }, CLI_CALLER);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect((res.value as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual(["fin-9"]);
  });

  it("phase 4b: the CLI catalogue carries every command — the former standalone scripts (`friction analyze`, `deploy all`, `env bootstrap`) included — and `deploy plan` runs from the CLI without touching a process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-cli-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, "providers:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\n");
    const commands = buildCoreCommands(new ConfigStore(cfg, join(dir, "overrides.json")), null, { registry: new RunRegistry({ now: () => NOW }), env: {}, dataDir: dir, warn: () => {} });
    const command = (argv: string[], c: CommandInvoker) => {
      const parsed = parseCliArgv(argv, c);
      if (parsed.kind !== "command") throw new Error(JSON.stringify(parsed));
      return parsed;
    };
    const cat = await runCli(commands, { kind: "catalogue" }, CLI_CALLER);
    for (const form of ["help show", "config show", "config set", "config instructions", "memory list", "memory forget", "repo onboard", "repo test", "schedule list", "friction analyze", "deploy plan", "deploy all", "env bootstrap"]) {
      expect(cat.stdout, form).toContain(form);
    }
    // Only a BARE `help` is the catalogue: `help show` is the registered command (the conformance suite found it unreachable).
    expect(parseCliArgv(["help", "show"], commands)).toMatchObject({ kind: "command", id: "help.show" });
    expect(parseCliArgv(["help", "show", "--help"], commands)).toEqual({ kind: "command-help", id: "help.show" });
    expect(parseCliArgv(["env", "bootstrap", "--env", "uat", "--service", "api"], commands)).toMatchObject({ kind: "command", id: "env.bootstrap", input: { args: [], options: { env: "uat", service: "api" } } });
    expect(parseCliArgv(["friction", "analyze", "run.sse", "--in-progress"], commands)).toMatchObject({ kind: "command", id: "friction.analyze", input: { args: ["run.sse"], options: { inProgress: true } } });
    const plan = await runCommand(commands, command(["deploy", "plan", "--only", "memory", "--json"], commands), CLI_CALLER);
    expect(plan.exitCode).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ dryRun: true, steps: [{ name: "memory" }] });
    // `config show` from the CLI needs a channel: the caller has no origin.
    const show = await runCommand(commands, command(["config", "show"], commands), CLI_CALLER);
    expect(show).toMatchObject({ exitCode: 2, stderr: "error (invalid_input): channel: required on this surface — pass --channel <id>" });
    const shown = await runCommand(commands, command(["config", "show", "--channel", "slack:C1"], commands), CLI_CALLER);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("*Effective for you in this channel:*");
  });

  it("a bare `runs list` lists the active runs (the spec's default) — no --status needed", async () => {
    const { commands, live } = await fixture();
    const parsed = parseCliArgv(["runs", "list"], commands);
    expect(parsed).toMatchObject({ kind: "command", id: "runs.list", input: { args: [], options: {} } });
    const out = await runCommand(commands, parsed as Extract<CliInvocation, { kind: "command" }>, CLI_CALLER, { now: NOW });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(live.id.slice(0, 8));
    expect(out.stdout).not.toContain("fin-1");
  });
});

describe("the CLI without config/config.yaml (a worktree, a fresh clone, CI)", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "swb-cli-noconfig-")), "config", "config.yaml");
  /** What `main()` binds: the bot config loaded on first use — here from a path that does not exist. */
  function bindWithoutConfig() {
    let hits = 0;
    const config = (): ConfigStore => {
      hits++;
      throw missingBotConfig(missing);
    };
    // As in `main()`: the run store is derived from the config, so it needs the file too.
    const store = () => {
      config();
      return null;
    };
    const commands = buildCoreCommands(config, store, { registry: new RunRegistry({ now: () => NOW }), env: {}, dataDir: join(missing, ".."), warn: () => {} });
    return { commands, hits: () => hits };
  }
  const command = (argv: string[], c: CommandInvoker) => {
    const parsed = parseCliArgv(argv, c);
    if (parsed.kind !== "command") throw new Error(JSON.stringify(parsed));
    return parsed;
  };

  it("loadBotConfig: a missing file is an `unavailable` CommandError naming the path, SWITCHBOARD_CONFIG, and the commands that need no config — never an ENOENT stack; an existing file loads", async () => {
    let err: unknown;
    try {
      await loadBotConfig(missing, "/dev/null");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe("unavailable");
    expect((err as CommandError).message).toBe(`bot config not found at ${missing} — set SWITCHBOARD_CONFIG to a config file or run from a checkout with config/config.yaml (deploy, env, friction analyze need none)`);
    const dir = mkdtempSync(join(tmpdir(), "swb-cli-config-"));
    writeFileSync(join(dir, "config.yaml"), "providers:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\n");
    expect(await loadBotConfig(join(dir, "config.yaml"), join(dir, "overrides.json"))).toBeInstanceOf(ConfigStore);
    expect(missingBotConfig(missing).message).toBe((err as CommandError).message);
  });

  it("bindBotConfig: a config.yaml whose overrides backing cannot be opened (runtimeOverrides.worker without its bearer) still lets `deploy plan` run; the command that needs it gets `unavailable` naming the cause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-cli-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(
      cfg,
      "providers:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\nruntimeOverrides:\n  worker:\n    baseUrl: https://state.example\n",
    );
    const config = bindBotConfig(cfg, join(dir, "overrides.json"), { env: {}, warn: () => {} });
    const commands = buildCoreCommands(config, () => null, { registry: new RunRegistry({ now: () => NOW }), env: {}, dataDir: dir, warn: () => {} });
    expect((await runCommand(commands, command(["deploy", "plan", "--only", "memory"], commands), CLI_CALLER)).exitCode).toBe(0);
    const show = await runCommand(commands, command(["config", "show", "--channel", "slack:C1"], commands), CLI_CALLER);
    expect(show).toEqual({ exitCode: 1, stdout: "", stderr: `error (unavailable): bot config at ${cfg} could not be opened: runtimeOverrides.worker is configured but MEMORY_TOKEN is not set` });
    // A missing file binds the same way it always did.
    const unbound = bindBotConfig(missing, "/dev/null", { env: {} });
    await expect(unbound()).rejects.toThrow(missingBotConfig(missing).message);
  });

  it("(a) `deploy plan` succeeds without ever asking for the bot config; so do `help show` and the catalogue", async () => {
    const { commands, hits } = bindWithoutConfig();
    const plan = await runCommand(commands, command(["deploy", "plan", "--only", "memory,bot"], commands), CLI_CALLER);
    expect(plan.exitCode).toBe(0);
    expect(plan.stdout).toContain("Checks: wrangler account = ");
    expect(plan.stdout).toContain("1. memory (switchboard-memory)");
    const json = await runCommand(commands, command(["deploy", "plan", "--json"], commands), CLI_CALLER);
    expect(JSON.parse(json.stdout)).toMatchObject({ dryRun: true, steps: [{ name: "memory" }, { name: "bot" }, { name: "resident" }, { name: "sandbox" }] });
    expect((await runCommand(commands, command(["help", "show"], commands), CLI_CALLER)).exitCode).toBe(0);
    expect((await runCli(commands, { kind: "catalogue" }, CLI_CALLER)).exitCode).toBe(0);
    expect(hits()).toBe(0);
  });

  it("(b) a command that needs the bot config fails with the one clear `unavailable` line on stderr, exit 1, nothing on stdout", async () => {
    const { commands } = bindWithoutConfig();
    for (const argv of [
      ["config", "show", "--channel", "slack:C1"],
      ["runs", "list"],
      ["memory", "list"],
      ["repo", "list"],
    ]) {
      const out = await runCommand(commands, command(argv, commands), CLI_CALLER);
      expect(out, argv.join(" ")).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `error (unavailable): bot config not found at ${missing} — set SWITCHBOARD_CONFIG to a config file or run from a checkout with config/config.yaml (deploy, env, friction analyze need none)`,
      });
    }
  });
});

// #409 — the config open is awaited only by the deps that reach for it.
describe("a command that never touches the config never waits for the open (#409)", () => {
  it("with a state Worker that never answers, `deploy plan` and `help show` return at once and never ask for the config; `config show` asks — and waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-cli-409-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, "providers:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\nruntimeOverrides:\n  worker:\n    baseUrl: https://state.example\n");
    const hanging: typeof fetch = () => new Promise(() => {}); // the Worker never answers
    let asked = 0;
    const config = bindBotConfig(cfg, join(dir, "overrides.json"), { env: { MEMORY_TOKEN: "t" }, warn: () => {}, fetch: hanging });
    const counted = () => {
      asked++;
      return config();
    };
    const commands = buildCoreCommands(counted, () => null, { registry: new RunRegistry({ now: () => NOW }), env: {}, dataDir: dir, warn: () => {} });
    const cmd = (argv: string[]) => {
      const parsed = parseCliArgv(argv, commands);
      if (parsed.kind !== "command") throw new Error(JSON.stringify(parsed));
      return parsed;
    };
    expect((await runCommand(commands, cmd(["deploy", "plan", "--only", "memory"]), CLI_CALLER)).exitCode).toBe(0);
    expect((await runCommand(commands, cmd(["help", "show"]), CLI_CALLER)).exitCode).toBe(0);
    expect(asked).toBe(0); // nothing reached for the config
    // A config-needing command DOES reach for it and, with this Worker, waits: prove the reach and the pending wait.
    const show = runCommand(commands, cmd(["config", "show", "--channel", "slack:C1"]), CLI_CALLER);
    const settled = await Promise.race([show.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 50))]);
    expect(settled).toBe(false);
    expect(asked).toBe(1);
  });
});
