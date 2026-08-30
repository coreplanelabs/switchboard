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
// JSON object `invoke` returned or `renderText` of that same object.

import { pathToFileURL } from "node:url";
import { ConfigStore } from "./config.js";
import {
  CommandRegistry,
  bindCommands,
  renderText,
  toSurfaceNames,
  type Caller,
  type CommandInvoker,
  type CommandRegistryOptions,
} from "./core/commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "./core/commands/all.js";
import { selectFrictionLedger, type FrictionLedger } from "./core/frictionLedger.js";
import type { IssueTracker } from "./execution/githubIssues.js";
import { buildFrictionLedger } from "./core/frictionLedgerWorker.js";
import { residentAdminFromConfig } from "./core/repoCommands.js";
import { defaultRunRegistry, type RunRegistry } from "./core/runRegistry.js";
import { buildRunStore, type RunStore } from "./core/runStore.js";
import { createRunsService, type RunsService } from "./core/runsService.js";

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
  return { exitCode: 0, stdout: parsed.json ? JSON.stringify(result.value, null, 2) : renderText(cmd, result.value, opts), stderr: "" };
}

/** How an in-process binding reaches the catalogue's deps. */
export interface CoreCommandWiring {
  /** The live registry — `defaultRunRegistry` in every real process, so the
   *  commands see the runs the dispatcher creates. */
  registry: RunRegistry;
  env: Record<string, string | undefined>;
  /** Where the host-disk fallbacks (friction JSONL) live. */
  dataDir: string;
  warn: (message: string) => void;
  /** Reuse an already-built service (index.ts shares ONE RunsService with the /runs pages). */
  runs?: RunsService;
  /** Reuse an already-selected ledger (index.ts shares it with `record()`). */
  frictionLedger?: FrictionLedger;
  /** Where `friction.propose` files (index.ts passes the dispatcher's `issueTracker`); default: GitHub REST. */
  tracker?: IssueTracker;
  /** The registry's audit sink; default: the registry's console line. */
  audit?: CommandRegistryOptions["audit"];
}

/**
 * THE one catalogue every in-process binding shares — src/index.ts (bot),
 * src/cli.ts (chat harness) and this CLI: `registerCoreCommands` bound over
 * the run store from `runHistory` config (null → live-only), the same
 * `RunRegistry`, the friction ledger selected the way the bot selects it (run
 * store when configured, legacy rows unioned), and the resident admin client
 * from `execution.resident` + its bearer. A surface that binds anything else
 * would answer `runs list` differently from the others.
 */
export function buildCoreCommands(config: ConfigStore, store: RunStore | null, wiring: CoreCommandWiring): CommandInvoker {
  const registry = new CommandRegistry<CoreCommandDeps>(wiring.audit ? { audit: wiring.audit } : {});
  registerCoreCommands(registry);
  const warn = (prefix: string) => (m: string) => wiring.warn(`[${prefix}] ${m}`);
  const ledger =
    wiring.frictionLedger ??
    selectFrictionLedger(store, buildFrictionLedger(config.config.selfImprovement, wiring.env, { dataDir: wiring.dataDir, warn: warn("friction") }), warn("friction"));
  return bindCommands(registry, {
    runs: wiring.runs ?? createRunsService({ registry: wiring.registry, store }),
    friction: { ledger, tracker: wiring.tracker, config: () => config.config.selfImprovement },
    repo: { admin: () => residentAdminFromConfig(config) },
  });
}

/** This process's binding: the config file, the run store it names, the shared
 *  registry (empty here — a fresh process holds no live runs, so persisted
 *  history is what the CLI sees), a silent audit (the output IS the audit). */
function buildCommands(): CommandInvoker {
  const config = new ConfigStore(CONFIG_PATH, "./data/cli-overrides.json");
  const warn = (m: string) => console.error(m);
  const store = buildRunStore(config.config.runHistory, process.env, { dataDir: "./data", warn: (m) => warn(`[run-history] ${m}`) });
  return buildCoreCommands(config, store, { registry: defaultRunRegistry, env: process.env, dataDir: "./data", warn, audit: () => {} });
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
