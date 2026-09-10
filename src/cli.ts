#!/usr/bin/env node
// The Switchboard CLI — a THIN wrapper over the command registry (see
// docs/decisions/0008-one-command-definition-every-surface.md): every
// registered command as `npx tsx src/cli.ts <group> <verb>
// [args…] [--option value…] [--json]`, with the words, positionals, flags,
// usage and help all DERIVED from the typed definition by commandSurface.ts.
//   npx tsx src/cli.ts runs list --status all
//   npx tsx src/cli.ts runs get <run id> --include messages --json
//   npx tsx src/cli.ts runs stop <run id> --mode soft
//   npx tsx src/cli.ts friction propose --dry-run --top 3
//   npx tsx src/cli.ts runs get --help          # derived help
//   npx tsx src/cli.ts help                     # the catalogue
// Plus ONE built-in that is not a registry command: `ask` sends a
// message through the channel-agnostic dispatcher — the local test harness and
// the proof that the core is channel-agnostic. It is a CHANNEL (ConsoleIO),
// not a command: starting an agent run stays with `dispatch()`
// (docs/decisions/0002-dispatcher-is-the-only-orchestrator.md), the
// way mcp.ts keeps its hand-written `dispatch` tool beside the registry tools.
//   npx tsx src/cli.ts ask "what is 2+2"
//   npx tsx src/cli.ts ask "agent:coding model:openai/gpt-5 ship a PR that ..."
//   npx tsx src/cli.ts ask --thread cli:mywork "agent:coding continue where we left off"
// And a SECOND built-in that is not a registry command either: `start` runs the
// bot — the very process the container image runs (src/index.ts `runBot`),
// from the installation (the operator root: a checkout, or from the package
// SWITCHBOARD_HOME / a cwd that holds one / ~/.switchboard), so an operator with
// the npm package and no Docker has Slack from a laptop. It is the PROCESS, not a command: a command
// returns a value and exits, the bot runs until a signal drains it, and no
// registry command may start an agent run — the bot starts them all through
// `dispatch()`. Nothing of the CLI's own is wired for it: the registry, its
// config open and its capabilities are built only when an invocation reaches
// for them, so `start` opens the config exactly once, in the bot.
//   npx tsx src/cli.ts start
//   npx tsx src/cli.ts start --help          # what it starts, what it reads
// And ONE spelling shortcut, the front door the docs promise: a bare `init` is
// the registry's `setup init` — the same command, the same flags, no grammar of
// its own (`CLI_SHORTHANDS`).
//   npx tsx src/cli.ts init --organization acme --anthropic-key sk-ant-…
// Parsing is pure and unit-tested; `main()` only wires in-process deps. Exit
// codes: 0 ok; 2 the invocation was rejected — `usage` (no `<group> <verb>`,
// an unknown command, a malformed `ask`) or `invalid_input`, whether the
// grammar refused the tail (`error (invalid_input): unknown option --x` + the
// usage line) or the registry refused the parsed input (the same code every
// surface returns for that fault); 1 the command ran and failed with any other
// code — or, for `ask`, the run did not complete (a provider refusal such as a
// 401 on the key, a tool failure, a stop): a script can tell an answer from a
// failure. The caller is
// `cli:local` holding every scope — whoever can run this process can
// already read the config and the data directory.

import "./loadEnv.js";
import { Console } from "node:console";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR_ROOT } from "./deploy/host.js";
import { installationPath } from "./deploy/operatorRoot.js";
import { loadAppConfig, openConfigStore, type AppConfig, type ConfigStore } from "./config.js";
import { parseConfigLocation } from "./configDocument.js";
import { buildCoreCommands, unstampedStatus } from "./core/commandCatalogue.js";
import { coreCommandGroups } from "./core/commands/all.js";
import { CLI_ACTOR } from "./core/authz/actor.js";
import { ALL_CAPABILITIES, capabilitiesFrom, type Capabilities } from "./core/capabilities.js";
import { meatOnPath } from "./core/meatProcess.js";
import {
  CommandError,
  CommandRegistry,
  renderText,
  type Caller,
  type CommandInput,
  type CommandInvoker,
  type InvokeErrorCode,
} from "./core/commandRegistry.js";
import { catalogueText, cliWords, helpText, parseInvocation, type GrammarRejection } from "./core/commandSurface.js";
import { dispatch, type CoreDeps } from "./core/dispatcher.js";
import { startRequestRoot } from "./core/requestTrace.js";
import { systemClock } from "./core/trace/clock.js";
import { createRunHistoryWriter, NullRunHistoryWriter } from "./core/runHistoryWriter.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { buildRunStore, NullRunStore, type RunStore } from "./core/runStore.js";
import { mintGeneration, NullLedgerWriteThrough } from "./core/runLedger/writeThrough.js";
import { ThreadsElsewhere } from "./core/runLedger/threadsElsewhere.js";
import { buildMemoryStore, NullMemoryStore } from "./core/memory/index.js";
import { residentAdminFromConfig } from "./core/residentAdmin.js";
import { NO_FLEET, residentFleetWatcherFor, type ResidentFleetFacts } from "./core/residentFleet.js";
import type { ChannelIO, RunReceipt, StatusHandle, StatusUpdate } from "./core/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";
import { buildMcp } from "./mcp/index.js";
import { NullMcpToolSource } from "./mcp/source.js";
import { claimEntry } from "./invokedAsScript.js";
import { processSecrets, publicEnv, type EnvRecord, type Secrets } from "./secrets.js";

// The installation's files live under the operator root (src/deploy/operatorRoot.ts): the checkout,
// or from the package SWITCHBOARD_HOME / a cwd that holds one / ~/.switchboard — so `init`, `ask`,
// `start` and `deploy` agree on one place without a `cd` first.
const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? installationPath(OPERATOR_ROOT, "config/config.yaml");
const DATA_DIR = installationPath(OPERATOR_ROOT, "data");

export const CLI_CALLER: Caller = { kind: "cli", id: CLI_ACTOR.id, actor: CLI_ACTOR };

/** How the usage text spells this program: the checkout's `npx tsx src/cli.ts`
 *  when Node was started on a TypeScript file (tsx, `npm run cli`), else
 *  `switchboard` — the published package's bin and the image's entrypoint. */
export function programName(entry: string | undefined): string {
  return entry?.endsWith(".ts") ? "npx tsx src/cli.ts" : "switchboard";
}

const PROGRAM = programName(process.argv[1]);

export const USAGE = [
  `usage: ${PROGRAM} <group> <verb> [args…] [--option value…] [--json]`,
  `       ${PROGRAM} <group> <verb> --help`,
  `       ${PROGRAM} ask [--thread <key>] "[agent:name] [model:provider/model] your request"`,
  `       ${PROGRAM} start                            (the bot: Slack from the installation's .env and config/)`,
  `       ${PROGRAM} init [--option value…]          (= setup init: the installer)`,
  `       ${PROGRAM} help`,
].join("\n");

/** `start --help`: nothing is derived for a built-in, so this says what the
 *  process is and what it reads — the facts an operator needs before running it. */
export function startHelpText(program: string): string {
  return [
    `usage: ${program} start`,
    "",
    "Runs the bot: the same process the container image runs — Slack over Socket Mode (an outbound",
    "websocket, so no public address is needed) and, when PORT is set, the HTTP server on that port",
    "(/healthz, POST /ingress, POST /mcp, the dashboard under /runs) — until SIGINT or SIGTERM drains it.",
    "",
    "It reads, from the installation (SWITCHBOARD_HOME; else the directory it is run in when that holds",
    "one; else ~/.switchboard — a checkout is always its own):",
    "  .env                  the credentials; SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required, and a",
    "                        variable the shell already exports wins over the file",
    "  config/config.yaml    the config (or the file SWITCHBOARD_CONFIG names)",
    "  data/                 runtime overrides and, with `runHistory: { store: file }`, the run records",
    "  skills/               the bundled skills, when the directory exists (or SWITCHBOARD_SKILLS_DIR)",
    "The dashboard's built bundle comes with the program (or from SWITCHBOARD_WEB_DIST).",
    "",
    `\`${program} init\` writes .env and config/config.yaml; \`${program} ask "…"\` runs one request without Slack.`,
  ].join("\n");
}

/** One-word spellings of a registry command — `init` for the installer. The
 *  word is replaced by the command's `<group> <verb>` before parsing, so what
 *  follows is bound by the shared grammar exactly as the long form is. */
export const CLI_SHORTHANDS: Readonly<Record<string, string>> = { init: "setup.init" };

export type CliInvocation =
  /** A registry command, bound by the shared grammar. */
  | { kind: "command"; id: string; input: CommandInput; json: boolean }
  /** `<group> <verb> --help`: the command's derived help, naming the command as typed (`spelled`: `runs stop`, or the shorthand `init`). */
  | { kind: "command-help"; id: string; spelled: string }
  /** `help` / `--help` / no arguments: the catalogue. */
  | { kind: "catalogue" }
  /** The built-in harness: dispatch `text` on `threadKey`. */
  | { kind: "ask"; threadKey: string; text: string }
  /** The built-in process: run the bot from this directory (src/index.ts `runBot`). */
  | { kind: "start" }
  /** `start --help`: what the process is and what it reads. */
  | { kind: "start-help" }
  /** The command exists but its tail is malformed: the grammar's `invalid_input` (usage hint in `error`). */
  | GrammarRejection
  /** Nothing to bind: no `<group> <verb>`, an unknown command, a malformed `ask`. */
  | { kind: "usage"; error: string };

const WORD = /^[a-z][a-z0-9]*$/;

/**
 * argv → what to do. `--json` (anywhere) is the CLI's one output switch — a
 * transport concern, not grammar. `ask` and `start` are parsed here because
 * they are the CLI's own built-ins; everything else goes to `parseInvocation`
 * unchanged.
 */
export function parseCliArgv(
  argv: readonly string[],
  commands: Pick<CommandInvoker, "list" | "get">,
  now: () => number = Date.now,
): CliInvocation {
  // A bare `help` is the catalogue; `help show …` is the registered command like any other `<group> <verb>`.
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || (argv[0] === "help" && argv.length === 1))
    return { kind: "catalogue" };
  if (argv[0] === "ask") return parseAsk(argv.slice(1), now);
  if (argv[0] === "start") return parseStart(argv.slice(1));
  // A shorthand is the long form to the grammar; help and usage hints keep the word as typed.
  const shorthand = CLI_SHORTHANDS[argv[0]];
  const spelledShort = shorthand === undefined ? undefined : argv[0];
  if (shorthand !== undefined) argv = [...cliWords(shorthand), ...argv.slice(1)];
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const [group, verb, ...tail] = rest;
  if (!group || !verb || !WORD.test(group) || !WORD.test(verb))
    return { kind: "usage", error: `${USAGE}\n  expected <group> <verb>` };
  const id = `${group}.${verb}`;
  const spelled = spelledShort ?? `${group} ${verb}`;
  const cmd = commands.get(id);
  if (!cmd || !CommandRegistry.exposedTo(cmd, "cli"))
    return {
      kind: "usage",
      error: `${USAGE}\n  unknown command: ${group} ${verb}\n\ncommands:\n${cliCatalogue(commands)}`,
    };
  const bound = parseInvocation(cmd, tail, spelled);
  switch (bound.kind) {
    case "help":
      return { kind: "command-help", id, spelled };
    case "invalid":
      return bound;
    case "invoke":
      return { kind: "command", id, input: bound.input, json };
  }
}

/** `ask [--thread <key> | --thread=<key>] <words…>`: the text is the remaining
 *  words joined; the thread key defaults to an ephemeral `cli:<now>`. A stable
 *  key lets repeated invocations act as ONE thread (workspace reuse, resident
 *  re-attach / binding persistence). */
function parseAsk(argv: readonly string[], now: () => number): CliInvocation {
  const words: string[] = [];
  let thread: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread") {
      thread = argv[++i];
      if (thread === undefined) return { kind: "usage", error: `${USAGE}\n  --thread needs a value` };
    } else if (a.startsWith("--thread=")) thread = a.slice("--thread=".length);
    else words.push(a);
  }
  const text = words.join(" ").trim();
  if (!text) return { kind: "usage", error: `${USAGE}\n  ask needs a request` };
  return { kind: "ask", threadKey: thread || `cli:${now()}`, text };
}

/** `start` takes nothing: what the process reads is decided by the directory and the environment, never by a flag. */
function parseStart(argv: readonly string[]): CliInvocation {
  if (argv.length === 0) return { kind: "start" };
  if (argv[0] === "--help" || argv[0] === "-h") return { kind: "start-help" };
  return {
    kind: "usage",
    error: `${USAGE}\n  start takes no arguments: it reads the installation's .env and config/config.yaml — SWITCHBOARD_HOME, the directory you run in when it holds one, else ~/.switchboard (start --help)`,
  };
}

/** The list a usage error and `help` print: every command this surface exposes. */
export function cliCatalogue(commands: Pick<CommandInvoker, "list">): string {
  return catalogueText(commands.list().filter((c) => CommandRegistry.exposedTo(c, "cli")));
}

export interface CommandRunOutput {
  /** 0 ok · 1 failed · 2 the invocation was rejected · 75 `busy` (sysexits
   *  EX_TEMPFAIL — nothing to change, try the same thing later). */
  exitCode: 0 | 1 | 2 | 75;
  stdout: string;
  stderr: string;
}

/** The exit code for a failed invoke: one rule for every command, read by shells. */
function exitCodeFor(error: InvokeErrorCode): 1 | 2 | 75 {
  if (error === "invalid_input") return 2;
  if (error === "busy") return 75;
  return 1;
}

/** `error (<code>): <message>` — the one stderr shape for every refusal, whoever decided it. */
function errorLine(code: InvokeErrorCode, message: string): string {
  return `error (${code}): ${message}`;
}

/**
 * Run one bound registry command. Transport-free so the contract test drives
 * the very path `main()` uses: a failure is `error (<code>): <message>` on
 * stderr and nothing on stdout — exit 2 when the registry rejected the input
 * (`invalid_input`, the same exit the grammar's rejection gets), exit 75 when
 * the command was `busy` (a transient refusal — the caller retries the same
 * thing later), exit 1 for any other failure; success prints the exact
 * `invoke` JSON (`--json`) or `renderText` of it.
 */
export async function runCommand(
  commands: CommandInvoker,
  parsed: Extract<CliInvocation, { kind: "command" }>,
  caller: Caller,
  opts: { now?: number } = {},
): Promise<CommandRunOutput> {
  const cmd = commands.get(parsed.id);
  const result = await commands.invoke(parsed.id, parsed.input, caller);
  if (!result.ok)
    return {
      exitCode: exitCodeFor(result.error),
      stdout: "",
      stderr: errorLine(result.error, result.message),
    };
  return {
    exitCode: 0,
    stdout: parsed.json
      ? JSON.stringify(result.value, null, 2)
      : renderText(cmd ?? { id: parsed.id }, result.value, opts),
    stderr: "",
  };
}

/** What every invocation but the two processes (`ask`, `start`) prints — the pure half `main()` and the tests share. */
export async function runCli(
  commands: CommandInvoker,
  parsed: Exclude<CliInvocation, { kind: "ask" | "start" }>,
  caller: Caller,
  opts: { now?: number } = {},
): Promise<CommandRunOutput> {
  switch (parsed.kind) {
    case "usage":
      return { exitCode: 2, stdout: "", stderr: parsed.error };
    case "invalid":
      return { exitCode: 2, stdout: "", stderr: errorLine(parsed.code, parsed.error) };
    case "catalogue":
      return { exitCode: 0, stdout: `${USAGE}\n\ncommands:\n${cliCatalogue(commands)}`, stderr: "" };
    case "start-help":
      return { exitCode: 0, stdout: startHelpText(PROGRAM), stderr: "" };
    case "command-help": {
      const cmd = commands.get(parsed.id);
      return {
        exitCode: 0,
        stdout: cmd ? helpText(cmd, parsed.spelled) : `unknown command: ${parsed.spelled}`,
        stderr: "",
      };
    }
    case "command":
      return runCommand(commands, parsed, caller, opts);
  }
}

/** The harness channel: the reply to `out` (stdout), status lines to stderr,
 *  no history (one-shot). The reply is written to the stream directly, never
 *  through `console` — the `ask` process points `console` at stderr so the
 *  core's process log stays off stdout (`main`). */
export class ConsoleIO implements ChannelIO {
  /** The receipt of the run this request started, once it finished — undefined
   *  before that, and forever when no run was started (a config reply such as
   *  `help`, a refusal before a run existed). */
  finished: RunReceipt | undefined;
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}
  async reply(text: string): Promise<void> {
    this.out.write("\n" + text + "\n");
  }
  runFinished(receipt: RunReceipt): void {
    this.finished = receipt;
  }
  async status(initial: StatusUpdate): Promise<StatusHandle> {
    console.error(initial.title);
    return {
      update: (f) =>
        console.error([f.title, f.link?.url, f.detail].filter(Boolean).join(" | ").split("\n").join(" | ")),
      done: async (f) => console.error(f.title),
    };
  }
  async history(): Promise<[]> {
    return [];
  }
}

/** What the `ask` process exits with: 1 when the run it started ended in any
 *  state but `completed` — the code a command that ran and failed exits with
 *  (`exitCodeFor`), so a shell reads a refused key, a failed tool or a stop the
 *  same way; 0 for an answer, and for a request that started no run. */
export function askExitCode(finished: RunReceipt | undefined): 0 | 1 {
  return finished === undefined || finished.status === "completed" ? 0 : 1;
}

/** The bot config, loaded on first use — `deploy.*`, `env.*`, `friction
 *  analyze`, `schedule list`, `help show` never ask for it, so they run in a
 *  worktree, a fresh clone, or CI without the git-ignored `config/config.yaml`.
 *  A command that does ask for it in such a checkout fails `unavailable`
 *  naming the path and the env var, never with an ENOENT stack. */
export function missingBotConfig(configPath: string): CommandError {
  return new CommandError(
    "unavailable",
    `bot config not found at ${configPath} — set SWITCHBOARD_CONFIG to a config file or run from a checkout with config/config.yaml (deploy, env, friction analyze need none)`,
  );
}

export async function loadBotConfig(
  configPath: string,
  overridesPath: string,
  opts: {
    /** The public environment (`STATE_WORKER_URL`); default: the process's, without its secrets. */
    env?: EnvRecord;
    /** The credentials (`MEMORY_TOKEN`); default: the process's. */
    secrets?: Secrets;
    exists?: (path: string) => boolean;
    warn?: (message: string) => void;
    fetch?: typeof fetch;
  } = {},
): Promise<ConfigStore> {
  // A `state://` location is read from the state Worker (src/configDocument.ts); only a file can be missing here.
  if (parseConfigLocation(configPath).kind === "file" && !(opts.exists ?? existsSync)(configPath))
    throw missingBotConfig(configPath);
  // The same backing the bot uses (`runtimeOverrides.worker` → the ConfigDO), so
  // `config set` from the CLI and from Slack write ONE document; the file is
  // the fallback for a config without a state Worker.
  // No ingress tokens: the CLI is `cli:local` (every grant) and never resolves
  // an `http:`/`mcp:` actor; the command groups are what a browser session's
  // implicit reads span, the same way the bot passes them.
  return openConfigStore(configPath, {
    overridesPath,
    env: opts.env ?? publicEnv(),
    secrets: opts.secrets ?? processSecrets,
    warn: opts.warn ?? ((m) => console.error(m)),
    commandGroups: coreCommandGroups(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/** What `main()` binds the commands to: the bot config, opened ONCE. The open
 *  STARTS here (up front, so a command that needs the config pays no extra
 *  latency) but is awaited only by the accessor — i.e. by the first command
 *  that reaches for the config through its deps. A command that never
 *  does (`deploy plan`, `help`, `env`, …) never waits, whatever the state
 *  Worker is doing; nothing classifies commands. A missing file, a configured
 *  Worker without its bearer, or an unreachable Worker reach only the command
 *  that asked, as one `unavailable` line naming the cause. */
export function bindBotConfig(
  configPath: string,
  overridesPath: string,
  opts: {
    env?: EnvRecord;
    secrets?: Secrets;
    exists?: (path: string) => boolean;
    warn?: (message: string) => void;
    fetch?: typeof fetch;
  } = {},
): () => Promise<ConfigStore> {
  const opening = loadBotConfig(configPath, overridesPath, opts).then(
    (config) => ({ config }),
    (err: unknown) => ({
      error:
        err instanceof CommandError
          ? err
          : new CommandError(
              "unavailable",
              `bot config at ${configPath} could not be opened: ${err instanceof Error ? err.message : String(err)}`,
            ),
    }),
  );
  return async () => {
    const outcome = await opening;
    if ("error" in outcome) throw outcome.error;
    return outcome.config;
  };
}

/**
 * What the CLI's catalogue hides (docs/reference/specs/command-registry.md item 28),
 * resolved ONCE at startup from the config FILE — a synchronous read, so `help`
 * and the catalogue never wait on the state Worker. A config that is not
 * a readable file — a `state://` location, a missing or unparsable file — is
 * the FULL catalogue: hiding is a courtesy, and a command that needs the config
 * still fails `unavailable` naming the cause. `ask` resolves its own value from
 * the opened store (the exact one, `state://` included).
 */
export function cliCapabilities(
  configPath: string,
  env: EnvRecord,
  secrets: Secrets,
  opts: { exists?: (path: string) => boolean; load?: (path: string) => AppConfig } = {},
): Capabilities {
  if (parseConfigLocation(configPath).kind !== "file") return ALL_CAPABILITIES;
  if (!(opts.exists ?? existsSync)(configPath)) return ALL_CAPABILITIES;
  try {
    return capabilitiesFrom((opts.load ?? loadAppConfig)(configPath), env, secrets, { meatBinary: meatOnPath(env) });
  } catch {
    return ALL_CAPABILITIES;
  }
}

/** The CLI's own wiring — the registry over the bot config and the run store —
 *  built ONCE, and only when an invocation reaches for it (`wireCli` below):
 *  `start` never does, so the bot it runs is the one thing that opens the config. */
interface CliWiring {
  commands: CommandInvoker;
  bot: () => Promise<{ config: ConfigStore; runStore: RunStore }>;
  mcpWiring: () => Promise<ReturnType<typeof buildMcp>>;
}

function wireCli(): CliWiring {
  const warn = (m: string) => console.error(m);
  // The bot config and, from it, the run history store: a CLI `ask`
  // persists exactly like a bot run when `runHistory` is configured (null
  // store → history off); the registry commands read the same store. A fresh
  // process holds no live runs, so `runs list` here is persisted history.
  // The open starts now (see `bindBotConfig`) and is awaited only by the deps
  // that reach for it: `deploy plan`, `help`, `env`, … run at once whatever the
  // state Worker is doing; a command that needs the config and cannot have it
  // gets the `unavailable` error naming the cause.
  const botConfig = bindBotConfig(CONFIG_PATH, join(DATA_DIR, "cli-overrides.json"));
  let loaded: Promise<{ config: ConfigStore; runStore: RunStore }> | undefined;
  const bot = () =>
    (loaded ??= botConfig().then((config) => ({
      config,
      runStore:
        buildRunStore(config.config.runHistory, processSecrets, {
          dataDir: DATA_DIR,
          warn: (m) => warn(`[run-history] ${m}`),
        }) ?? new NullRunStore(),
    })));
  // MCP (docs/reference/specs/mcp-tools.md) rides the same config: entries are config scopes, secrets follow
  // the overrides backing; connect links point at the bot's PUBLIC_BASE_URL.
  // With `runtimeOverrides.worker` set the CLI and the bot share one ConfigDO
  // (entries, credentials, tickets), so a CLI-minted link completes on the
  // bot's page. Without it the CLI is its own deployment on purpose: its
  // overrides document is `cli-overrides.json` (above), so its secrets file is
  // the CLI's too — the two processes never write one JSON file, and a ticket
  // for an entry only the CLI's document holds is never offered to the bot.
  // Built on first use, behind the same async config open: `mcp list`
  // waits for it, `deploy plan` never asks.
  let mcpLoaded: Promise<ReturnType<typeof buildMcp>> | undefined;
  const mcpWiring = () =>
    (mcpLoaded ??= bot().then((b) =>
      buildMcp(b.config, processSecrets, {
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
        secretsPath: "./data/cli-mcp-secrets.json",
        warn: (m) => warn(`[mcp] ${m}`),
      }),
    ));
  const commands = buildCoreCommands(
    () => bot().then((b) => b.config),
    () => bot().then((b) => b.runStore),
    {
      registry: defaultRunRegistry,
      secrets: processSecrets,
      dataDir: "./data",
      warn,
      audit: () => {},
      capabilities: cliCapabilities(CONFIG_PATH, publicEnv(), processSecrets),
      mcp: async () => {
        const w = await mcpWiring();
        return w.service ?? { unavailable: w.unavailable ?? "MCP is not enabled" };
      },
    },
  );
  return { commands, bot, mcpWiring };
}

async function main(): Promise<void> {
  const warn = (m: string) => console.error(m);
  // The parser needs the catalogue only to bind a `<group> <verb>`; `ask`,
  // `start` and the bare `help` are decided before it is asked, so the wiring
  // happens behind these accessors, on the first invocation that binds a command.
  let wired: CliWiring | undefined;
  const wiring = () => (wired ??= wireCli());
  const commands: CommandInvoker = {
    list: () => wiring().commands.list(),
    get: (id) => wiring().commands.get(id),
    invoke: (...args) => wiring().commands.invoke(...args),
    settles: (id) => wiring().commands.settles(id),
    settle: (...args) => wiring().commands.settle(...args),
  };

  const parsed = parseCliArgv(process.argv.slice(2), commands);
  if (parsed.kind === "start") {
    // The bot's entry, loaded here and not at the top, for two reasons: its
    // module-level state (the process start time, the event-loop histogram)
    // belongs to the bot process alone, so an `ask` or a `deploy plan` never
    // pays for it; and the entry claim (src/invokedAsScript.ts) must be this
    // module's — a static import would evaluate index.ts first and, inside the
    // bundle where both share one import.meta.url, hand it the process.
    const { runBot } = await import("./index.js");
    await runBot();
    return;
  }
  if (parsed.kind !== "ask") {
    const out = await runCli(commands, parsed, CLI_CALLER);
    if (out.stdout) console.log(out.stdout);
    if (out.stderr) console.error(out.stderr);
    process.exit(out.exitCode);
  }

  const { bot, mcpWiring } = wiring();
  // The core writes its process log — `[run] …`, `[event] …`, `[done] …` — with
  // `console.log`: in the bot that IS the container's log. Here stdout is the
  // answer, so from this point every `console` line goes to stderr beside the
  // status lines; the reply reaches stdout through `ConsoleIO`'s own stream.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const { config, runStore } = await bot();
  const providers = new ProviderRegistry(config.config.providers);
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  // What is on in this process (src/core/capabilities.ts): the CLI's `ask`
  // resolves it once from the same config the bot would, so a run started here
  // carries the same prompt blocks and card notes as one started in Slack.
  const capabilities = capabilitiesFrom(config.config, publicEnv(), processSecrets, {
    meatBinary: meatOnPath(publicEnv()),
  });
  // Every optional subsystem is a real implementation or its Null Object
  // (docs/reference/specs/routing-and-config.md item 16), as in the bot. The CLI has no
  // run ledger: a one-shot process reclaims and resumes nothing.
  const mcp = (await mcpWiring()).source ?? new NullMcpToolSource();
  const memory =
    buildMemoryStore(config.config.memory, processSecrets, (m) => warn(`[memory] ${m}`)) ?? new NullMemoryStore();
  const runHistoryWriter = capabilities.runHistory
    ? createRunHistoryWriter({ store: runStore, warn, onPersisted: (id) => defaultRunRegistry.markPersisted(id) })
    : new NullRunHistoryWriter();
  // The resident fleet's cap for the About block (routing-and-config item 11):
  // one read for this one-shot process, from the admin plane the config names;
  // nothing to know without residents or without the admin bearer.
  const fleetWatcher = capabilities.residents
    ? residentFleetWatcherFor(residentAdminFromConfig(config, processSecrets), { warn })
    : undefined;
  await fleetWatcher?.refresh();
  const residentFleet: ResidentFleetFacts = fleetWatcher ?? NO_FLEET;
  // The chat fast path (`runs list`, `friction report`, …) answers from the same
  // catalogue the bot binds — without it those messages would go to the model.
  const deps: CoreDeps = {
    config,
    providers,
    capabilities,
    residentFleet,
    // The CLI's own identity for the About block: its package version, no stamp.
    build: (({ version, commit }) => ({ version, commit }))(unstampedStatus()),
    skills,
    mcp,
    memory,
    runHistoryWriter,
    runStore,
    runLedger: new NullLedgerWriteThrough(mintGeneration(), runStore),
    threadsElsewhere: new ThreadsElsewhere(),
    commands,
  };
  // The request's root (docs/reference/specs/tracing.md): the CLI's receipt is now.
  const receivedAt = systemClock();
  const trace = startRequestRoot(deps, { channel: "cli", receivedAt });
  const io = new ConsoleIO();
  await dispatch(
    deps,
    { channelId: "cli:local", userId: "cli:local", threadKey: parsed.threadKey, text: parsed.text, receivedAt },
    io,
    { trace },
  );
  // Wait for the record write to settle before exiting rather than dropping it.
  await runHistoryWriter.settled();
  // The exit code is set, not forced: the process ends when its last write has drained.
  process.exitCode = askExitCode(io.finished);
}

// Run only when invoked as a script (tsx/node src/cli.ts, the `switchboard`
// bin, the container's entrypoint), never on import (the parsing helpers above
// are unit-tested).
if (claimEntry(import.meta.url)) {
  main().catch((err) => {
    // `ask` without a bot config: the same one-line refusal the commands give, not a stack.
    console.error(err instanceof CommandError ? errorLine(err.code, err.message) : err);
    process.exit(1);
  });
}
