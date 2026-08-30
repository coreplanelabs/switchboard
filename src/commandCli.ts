// Generic CLI adapter for the command registry (#157 U7 — R7/KTD2): every
// registered command as `npx tsx src/commandCli.ts <group> <verb> [--key=value …] [--json]`.
//   npx tsx src/commandCli.ts runs list --status=all
//   npx tsx src/commandCli.ts runs get --id=<run id> --include=messages --json
//   npx tsx src/commandCli.ts runs stop --id=<run id> --mode=soft
// Like cli.ts and frictionCli.ts: parsing is pure and unit-tested, `main()` only
// wires in-process deps, and exit codes are 1 (the command failed) / 2 (usage).
// The caller is `cli:local` holding every scope (KTD10) — whoever can run this
// process can already read the config and the data directory.
//
// No command logic lives here (features/command-registry.md §10): raw `--key=value`
// strings go to `invoke` unchanged (the schema coerces), and output is either the
// JSON object `invoke` returned or `renderCompact` of that same object.

import { pathToFileURL } from "node:url";
import { ConfigStore } from "./config.js";
import {
  CommandRegistry,
  bindCommands,
  renderCompact,
  toSurfaceNames,
  type Caller,
  type CommandInvoker,
} from "./core/commandRegistry.js";
import { registerRunsCommands, type RunsCommandDeps } from "./core/commands/runs.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { buildRunStore } from "./core/runStore.js";
import { createRunsService } from "./core/runsService.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";

export const CLI_CALLER: Caller = { kind: "cli", id: "cli:local", scopes: "all" };

export const USAGE = "usage: npx tsx src/commandCli.ts <group> <verb> [--key=value ...] [--json]";

export interface ParsedCommandArgs {
  ok: true;
  /** `<group>.<verb>` — the registry id. */
  id: string;
  /** Raw string arguments; the command's schema coerces them. */
  input: Record<string, string>;
  json: boolean;
}

export type ParseCommandArgsResult = ParsedCommandArgs | { ok: false; error: string };

const WORD = /^[a-z][a-z0-9]*$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

export function parseCommandArgs(argv: string[]): ParseCommandArgsResult {
  const positional: string[] = [];
  const input: Record<string, string> = {};
  let json = false;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq < 0) return { ok: false, error: `${USAGE}\n  flags take the form --key=value (got ${a})` };
      const key = a.slice(2, eq);
      if (!KEY.test(key)) return { ok: false, error: `${USAGE}\n  bad flag name: ${a}` };
      input[key] = a.slice(eq + 1);
    } else if (a.startsWith("-")) {
      return { ok: false, error: `${USAGE}\n  unknown option: ${a}` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return { ok: false, error: `${USAGE}\n  expected exactly <group> <verb>` };
  const [group, verb] = positional;
  if (!WORD.test(group) || !WORD.test(verb)) return { ok: false, error: `${USAGE}\n  <group> and <verb> are lowercase words` };
  return { ok: true, id: `${group}.${verb}`, input, json };
}

export interface CommandRunOutput {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/** The list a usage error prints: every command this surface exposes. */
function catalogue(commands: CommandInvoker): string {
  return commands
    .list()
    .filter((c) => CommandRegistry.exposedTo(c, "cli"))
    .map((c) => `  ${toSurfaceNames(c.id).cli.join(" ")}  — ${c.describe}`)
    .join("\n");
}

/**
 * Run one parsed invocation against a bound registry. Transport-free so the
 * contract test drives the very path `main()` uses. An unknown or CLI-hidden
 * command is a USAGE error (2); a command that ran and failed is 1.
 */
export async function runCommand(commands: CommandInvoker, parsed: ParsedCommandArgs, caller: Caller, opts: { now?: number } = {}): Promise<CommandRunOutput> {
  const cmd = commands.get(parsed.id);
  if (!cmd || !CommandRegistry.exposedTo(cmd, "cli")) {
    return { exitCode: 2, stdout: "", stderr: `${USAGE}\n  unknown command: ${parsed.id.replace(".", " ")}\n\ncommands:\n${catalogue(commands)}` };
  }
  const result = await commands.invoke(parsed.id, parsed.input, caller);
  if (!result.ok) return { exitCode: 1, stdout: "", stderr: `error (${result.error}): ${result.message}` };
  return { exitCode: 0, stdout: parsed.json ? JSON.stringify(result.value, null, 2) : renderCompact(parsed.id, result.value, opts), stderr: "" };
}

/** In-process deps, mirroring cli.ts: the run store from `runHistory` config
 *  (null → live-only; this fresh process holds no live runs, so persisted
 *  history is what the CLI sees) and the same `defaultRunRegistry`. */
function buildDeps(): RunsCommandDeps {
  const config = new ConfigStore(CONFIG_PATH, "./data/cli-overrides.json");
  const store = buildRunStore(config.config.runHistory, process.env, { dataDir: "./data", warn: (m) => console.error(`[run-history] ${m}`) });
  return { runs: createRunsService({ registry: defaultRunRegistry, store }) };
}

/** The registry needs no config, so the catalogue (and a usage error for an
 *  unknown command) never depends on one; deps are built on the first invoke. */
function buildCommands(): CommandInvoker {
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  let bound: CommandInvoker | undefined;
  return {
    list: () => registry.list(),
    get: (id) => registry.get(id),
    invoke: (id, rawInput, caller) => (bound ??= bindCommands(registry, buildDeps())).invoke(id, rawInput, caller),
  };
}

async function main(): Promise<void> {
  const parsed = parseCommandArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(2);
  }
  const out = await runCommand(buildCommands(), parsed, CLI_CALLER);
  if (out.stdout) console.log(out.stdout);
  if (out.stderr) console.error(out.stderr);
  process.exit(out.exitCode);
}

// Run only when invoked as a script, never on import (the helpers are unit-tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
