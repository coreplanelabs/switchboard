import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderCompact, type CommandInvoker } from "./core/commandRegistry.js";
import { registerRunsCommands, type RunsCommandDeps } from "./core/commands/runs.js";
import type { RunEvent } from "./core/runEvents.js";
import { analyzeRunFriction } from "./core/runFriction.js";
import { RunRegistry } from "./core/runRegistry.js";
import { InMemoryRunStore } from "./core/runStore.js";
import { createRunsService } from "./core/runsService.js";
import { buildCoreCommands, CLI_CALLER, parseCommandArgs, runCommand } from "./commandCli.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "./config.js";
import { registerCoreCommands, type CoreCommandDeps } from "./core/commands/all.js";

// Feature: features/command-registry.md — the generic CLI adapter
// (`npx tsx src/commandCli.ts <group> <verb> [--key=value …] [--json]`). Pure
// parsing + a `runCommand` that the contract test drives through the same path
// `main()` uses. Exit codes follow cli.ts/frictionCli.ts: 1 = command error, 2 = usage.

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
  const commands: CommandInvoker = bindCommands(registry, { runs: createRunsService({ registry: reg, store }) });
  return { commands, live, reg };
}

describe("parseCommandArgs", () => {
  it("parses <group> <verb> plus --key=value flags into a raw string input; --json is a switch", () => {
    expect(parseCommandArgs(["runs", "list", "--status=all", "--limit=10", "--json"])).toEqual({
      ok: true,
      id: "runs.list",
      input: { status: "all", limit: "10" },
      json: true,
    });
    expect(parseCommandArgs(["runs", "get", "--id=abc"])).toEqual({ ok: true, id: "runs.get", input: { id: "abc" }, json: false });
  });

  it("keeps '=' inside a value; an empty value is an empty string", () => {
    expect(parseCommandArgs(["runs", "list", "--status=all", "--channel=slack:C1=x"])).toMatchObject({ ok: true, input: { status: "all", channel: "slack:C1=x" } });
    expect(parseCommandArgs(["runs", "list", "--agent="])).toMatchObject({ ok: true, input: { agent: "" } });
  });

  it("usage errors: missing verb, a flag without '=', a stray positional, a malformed group/verb", () => {
    for (const argv of [[], ["runs"], ["runs", "list", "--status"], ["runs", "list", "extra"], ["Runs", "list"], ["runs", "list.all"], ["runs", "list", "-s=all"]]) {
      const res = parseCommandArgs(argv);
      expect(res.ok, argv.join(" ")).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/usage/i);
    }
  });
});

describe("runCommand", () => {
  it("--json prints the exact invoke JSON with exit 0 and no token", async () => {
    const { commands } = await fixture();
    const parsed = parseCommandArgs(["runs", "list", "--status=all", "--json"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const out = await runCommand(commands, parsed, CLI_CALLER);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    const direct = await commands.invoke("runs.list", { status: "all" }, CLI_CALLER);
    expect(JSON.parse(out.stdout)).toEqual(direct.ok ? direct.value : null);
    expect(out.stdout).not.toContain("tok-");
  });

  it("without --json prints renderCompact of the same object", async () => {
    const { commands } = await fixture();
    const parsed = parseCommandArgs(["runs", "list", "--status=all"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const out = await runCommand(commands, parsed, CLI_CALLER, { now: NOW });
    const direct = await commands.invoke("runs.list", { status: "all" }, CLI_CALLER);
    expect(out.stdout).toBe(renderCompact("runs.list", direct.ok ? direct.value : null, { now: NOW }));
    expect(out.stdout).toContain("live-1");
    expect(out.stdout).not.toContain("tok-");
  });

  it("an unknown verb (runs frobnicate) is a usage error: exit 2 listing the available commands", async () => {
    const { commands } = await fixture();
    const parsed = parseCommandArgs(["runs", "frobnicate"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const out = await runCommand(commands, parsed, CLI_CALLER);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/usage/i);
    expect(out.stderr).toContain("runs list");
  });

  it("a command error (bad input, not found) is exit 1 with the code on stderr and nothing on stdout", async () => {
    const { commands } = await fixture();
    const bad = parseCommandArgs(["runs", "list", "--status=s3cret"]);
    if (!bad.ok) throw new Error(bad.error);
    const out = await runCommand(commands, bad, CLI_CALLER);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("invalid_input");
    expect(out.stderr).toContain("status");
    expect(out.stderr).not.toContain("s3cret");
    const missing = parseCommandArgs(["runs", "get", "--id=nope", "--json"]);
    if (!missing.ok) throw new Error(missing.error);
    expect(await runCommand(commands, missing, CLI_CALLER)).toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("runs stop from the CLI records the cli:local actor", async () => {
    const { commands, live, reg } = await fixture();
    const parsed = parseCommandArgs(["runs", "stop", `--id=${live.id}`, "--mode=soft", "--json"]);
    if (!parsed.ok) throw new Error(parsed.error);
    const out = await runCommand(commands, parsed, CLI_CALLER);
    expect(out.exitCode).toBe(0);
    const note = reg.snapshotById(live.id)!.events.find((e) => e.type === "run_note" && e.kind === "stop_requested") as { actor?: unknown };
    expect(note.actor).toEqual({ kind: "cli", id: "cli:local" });
  });
});

describe("buildCoreCommands — the one catalogue every in-process binding shares (index.ts, cli.ts, commandCli.ts)", () => {
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
    const res = await commands.invoke("runs.list", { status: "all" }, CLI_CALLER);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect((res.value as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual(["fin-9"]);
  });
});
