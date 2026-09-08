// The Switchboard CLI — a THIN wrapper over the command registry (#157 KTD20/
// KTD21): every registered command as `npx tsx src/cli.ts <group> <verb>
// [args…] [--option value…] [--json]`, with the words, positionals, flags,
// usage and help all DERIVED from the typed definition by commandSurface.ts.
//   npx tsx src/cli.ts runs list --status all
//   npx tsx src/cli.ts runs get <run id> --include messages --json
//   npx tsx src/cli.ts runs stop <run id> --mode soft
//   npx tsx src/cli.ts friction propose --dry-run --top 3
//   npx tsx src/cli.ts runs get --help          # derived help
//   npx tsx src/cli.ts help                     # the catalogue
// Plus ONE built-in that is not a registry command (KTD22): `ask` sends a
// message through the channel-agnostic dispatcher — the local test harness and
// the proof that the core is channel-agnostic. It is a CHANNEL (ConsoleIO),
// not a command: starting an agent run stays with `dispatch()` (KTD16), the
// way mcp.ts keeps its hand-written `dispatch` tool beside the registry tools.
//   npx tsx src/cli.ts ask "what is 2+2"
//   npx tsx src/cli.ts ask "agent:coding model:openai/gpt-5 ship a PR that ..."
//   npx tsx src/cli.ts ask --thread cli:mywork "agent:coding continue where we left off"
// Parsing is pure and unit-tested; `main()` only wires in-process deps. Exit
// codes: 0 ok; 2 the invocation was rejected — `usage` (no `<group> <verb>`,
// an unknown command, a malformed `ask`) or `invalid_input`, whether the
// grammar refused the tail (`error (invalid_input): unknown option --x` + the
// usage line) or the registry refused the parsed input (the same code every
// surface returns for that fault); 1 the command (or dispatch) ran and failed
// with any other code. The caller is
// `cli:local` holding every scope (KTD10) — whoever can run this process can
// already read the config and the data directory.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAppConfig, openConfigStore, type AppConfig, type ConfigStore } from "./config.js";
import { parseConfigLocation } from "./configDocument.js";
import { buildCoreCommands } from "./core/commandCatalogue.js";
import { coreCommandGroups } from "./core/commands/all.js";
import { CLI_ACTOR } from "./core/authz/actor.js";
import { ALL_CAPABILITIES, capabilitiesFrom, type Capabilities } from "./core/capabilities.js";
import {
  CommandError,
  CommandRegistry,
  renderText,
  type Caller,
  type CommandInput,
  type CommandInvoker,
  type InvokeErrorCode,
} from "./core/commandRegistry.js";
import { catalogueText, chatForm, helpText, parseInvocation, type GrammarRejection } from "./core/commandSurface.js";
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
import { NO_FLEET, watchResidentFleet, type ResidentFleetFacts } from "./core/residentFleet.js";
import type { ChannelIO, StatusHandle, StatusUpdate } from "./core/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";
import { buildMcp } from "./mcp/index.js";
import { NullMcpToolSource } from "./mcp/source.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";

export const CLI_CALLER: Caller = { kind: "cli", id: CLI_ACTOR.id, actor: CLI_ACTOR };

export const USAGE = [
  "usage: npx tsx src/cli.ts <group> <verb> [args…] [--option value…] [--json]",
  "       npx tsx src/cli.ts <group> <verb> --help",
  '       npx tsx src/cli.ts ask [--thread <key>] "[agent:name] [model:provider/model] your request"',
  "       npx tsx src/cli.ts help",
].join("\n");

export type CliInvocation =
  /** A registry command, bound by the shared grammar. */
  | { kind: "command"; id: string; input: CommandInput; json: boolean }
  /** `<group> <verb> --help`: the command's derived help. */
  | { kind: "command-help"; id: string }
  /** `help` / `--help` / no arguments: the catalogue. */
  | { kind: "catalogue" }
  /** The built-in harness: dispatch `text` on `threadKey`. */
  | { kind: "ask"; threadKey: string; text: string }
  /** The command exists but its tail is malformed: the grammar's `invalid_input` (usage hint in `error`). */
  | GrammarRejection
  /** Nothing to bind: no `<group> <verb>`, an unknown command, a malformed `ask`. */
  | { kind: "usage"; error: string };

const WORD = /^[a-z][a-z0-9]*$/;

/**
 * argv → what to do. `--json` (anywhere) is the CLI's one output switch — a
 * transport concern, not grammar. `ask` is parsed here because it is the CLI's
 * own built-in; everything else goes to `parseInvocation` unchanged.
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
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const [group, verb, ...tail] = rest;
  if (!group || !verb || !WORD.test(group) || !WORD.test(verb))
    return { kind: "usage", error: `${USAGE}\n  expected <group> <verb>` };
  const id = `${group}.${verb}`;
  const cmd = commands.get(id);
  if (!cmd || !CommandRegistry.exposedTo(cmd, "cli"))
    return {
      kind: "usage",
      error: `${USAGE}\n  unknown command: ${group} ${verb}\n\ncommands:\n${cliCatalogue(commands)}`,
    };
  const bound = parseInvocation(cmd, tail);
  switch (bound.kind) {
    case "help":
      return { kind: "command-help", id };
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

/** What every non-`ask` invocation prints — the pure half `main()` and the tests share. */
export async function runCli(
  commands: CommandInvoker,
  parsed: Exclude<CliInvocation, { kind: "ask" }>,
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
    case "command-help": {
      const cmd = commands.get(parsed.id);
      return { exitCode: 0, stdout: cmd ? helpText(cmd) : `unknown command: ${chatForm(parsed.id)}`, stderr: "" };
    }
    case "command":
      return runCommand(commands, parsed, caller, opts);
  }
}

/** The harness channel: replies to stdout, status lines to stderr, no history (one-shot). */
class ConsoleIO implements ChannelIO {
  async reply(text: string): Promise<void> {
    console.log("\n" + text);
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
    env?: Record<string, string | undefined>;
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
    env: opts.env ?? process.env,
    warn: opts.warn ?? ((m) => console.error(m)),
    commandGroups: coreCommandGroups(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/** What `main()` binds the commands to: the bot config, opened ONCE. The open
 *  STARTS here (up front, so a command that needs the config pays no extra
 *  latency) but is awaited only by the accessor — i.e. by the first command
 *  that reaches for the config through its deps (#409). A command that never
 *  does (`deploy plan`, `help`, `env`, …) never waits, whatever the state
 *  Worker is doing; nothing classifies commands. A missing file, a configured
 *  Worker without its bearer, or an unreachable Worker reach only the command
 *  that asked, as one `unavailable` line naming the cause. */
export function bindBotConfig(
  configPath: string,
  overridesPath: string,
  opts: {
    env?: Record<string, string | undefined>;
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
 * What the CLI's catalogue hides (features/command-registry.md item 27),
 * resolved ONCE at startup from the config FILE — a synchronous read, so `help`
 * and the catalogue never wait on the state Worker (#409). A config that is not
 * a readable file — a `state://` location, a missing or unparsable file — is
 * the FULL catalogue: hiding is a courtesy, and a command that needs the config
 * still fails `unavailable` naming the cause. `ask` resolves its own value from
 * the opened store (the exact one, `state://` included).
 */
export function cliCapabilities(
  configPath: string,
  env: NodeJS.ProcessEnv,
  opts: { exists?: (path: string) => boolean; load?: (path: string) => AppConfig } = {},
): Capabilities {
  if (parseConfigLocation(configPath).kind !== "file") return ALL_CAPABILITIES;
  if (!(opts.exists ?? existsSync)(configPath)) return ALL_CAPABILITIES;
  try {
    return capabilitiesFrom((opts.load ?? loadAppConfig)(configPath), env);
  } catch {
    return ALL_CAPABILITIES;
  }
}

async function main(): Promise<void> {
  const warn = (m: string) => console.error(m);
  // The bot config and, from it, the run history store (#157): a CLI `ask`
  // persists exactly like a bot run when `runHistory` is configured (null
  // store → history off); the registry commands read the same store. A fresh
  // process holds no live runs, so `runs list` here is persisted history.
  // The open starts now (see `bindBotConfig`) and is awaited only by the deps
  // that reach for it: `deploy plan`, `help`, `env`, … run at once whatever the
  // state Worker is doing; a command that needs the config and cannot have it
  // gets the `unavailable` error naming the cause.
  const botConfig = bindBotConfig(CONFIG_PATH, "./data/cli-overrides.json");
  let loaded: Promise<{ config: ConfigStore; runStore: RunStore }> | undefined;
  const bot = () =>
    (loaded ??= botConfig().then((config) => ({
      config,
      runStore:
        buildRunStore(config.config.runHistory, process.env, {
          dataDir: "./data",
          warn: (m) => warn(`[run-history] ${m}`),
        }) ?? new NullRunStore(),
    })));
  // MCP (#394) rides the same config: entries are config scopes, secrets follow
  // the overrides backing; connect links point at the bot's PUBLIC_BASE_URL.
  // With `runtimeOverrides.worker` set the CLI and the bot share one ConfigDO
  // (entries, credentials, tickets), so a CLI-minted link completes on the
  // bot's page. Without it the CLI is its own deployment on purpose: its
  // overrides document is `cli-overrides.json` (above), so its secrets file is
  // the CLI's too — the two processes never write one JSON file, and a ticket
  // for an entry only the CLI's document holds is never offered to the bot.
  // Built on first use, behind the same async config open (#409): `mcp list`
  // waits for it, `deploy plan` never asks.
  let mcpLoaded: Promise<ReturnType<typeof buildMcp>> | undefined;
  const mcpWiring = () =>
    (mcpLoaded ??= bot().then((b) =>
      buildMcp(b.config, process.env, {
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
      env: process.env,
      dataDir: "./data",
      warn,
      audit: () => {},
      capabilities: cliCapabilities(CONFIG_PATH, process.env),
      mcp: async () => {
        const w = await mcpWiring();
        return w.service ?? { unavailable: w.unavailable ?? "MCP is not enabled" };
      },
    },
  );

  const parsed = parseCliArgv(process.argv.slice(2), commands);
  if (parsed.kind !== "ask") {
    const out = await runCli(commands, parsed, CLI_CALLER);
    if (out.stdout) console.log(out.stdout);
    if (out.stderr) console.error(out.stderr);
    process.exit(out.exitCode);
  }

  const { config, runStore } = await bot();
  const providers = new ProviderRegistry(config.config.providers);
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  // What is on in this process (src/core/capabilities.ts): the CLI's `ask`
  // resolves it once from the same config the bot would, so a run started here
  // carries the same prompt blocks and card notes as one started in Slack.
  const capabilities = capabilitiesFrom(config.config, process.env);
  // Every optional subsystem is a real implementation or its Null Object
  // (features/routing-and-config.md item 16), as in the bot. The CLI has no
  // run ledger: a one-shot process reclaims and resumes nothing.
  const mcp = (await mcpWiring()).source ?? new NullMcpToolSource();
  const memory =
    buildMemoryStore(config.config.memory, process.env, (m) => warn(`[memory] ${m}`)) ?? new NullMemoryStore();
  const runHistoryWriter = capabilities.runHistory
    ? createRunHistoryWriter({ store: runStore, warn, onPersisted: (id) => defaultRunRegistry.markPersisted(id) })
    : new NullRunHistoryWriter();
  // The resident fleet's cap for the About block (routing-and-config item 11):
  // one read for this one-shot process, from the admin plane the config names;
  // nothing to know without residents or without the admin bearer.
  const residentAdmin = capabilities.residents ? residentAdminFromConfig(config, process.env) : undefined;
  const fleetWatcher =
    residentAdmin && !("unavailable" in residentAdmin) ? watchResidentFleet(residentAdmin, { warn }) : undefined;
  await fleetWatcher?.refresh();
  const residentFleet: ResidentFleetFacts = fleetWatcher ?? NO_FLEET;
  // The chat fast path (`runs list`, `friction report`, …) answers from the same
  // catalogue the bot binds — without it those messages would go to the model.
  const deps: CoreDeps = {
    config,
    providers,
    capabilities,
    residentFleet,
    skills,
    mcp,
    memory,
    runHistoryWriter,
    runLedger: new NullLedgerWriteThrough(mintGeneration(), runStore),
    threadsElsewhere: new ThreadsElsewhere(),
    commands,
  };
  // The request's root (features/tracing.md): the CLI's receipt is now.
  const receivedAt = systemClock();
  const trace = startRequestRoot(deps, { channel: "cli", receivedAt });
  await dispatch(
    deps,
    { channelId: "cli:local", userId: "cli:local", threadKey: parsed.threadKey, text: parsed.text, receivedAt },
    new ConsoleIO(),
    { trace },
  );
  // Wait for the record write to settle before exiting rather than dropping it.
  await runHistoryWriter.settled();
}

// Run only when invoked as a script (tsx/node src/cli.ts), never on import
// (the parsing helpers above are unit-tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // `ask` without a bot config: the same one-line refusal the commands give, not a stack.
    console.error(err instanceof CommandError ? errorLine(err.code, err.message) : err);
    process.exit(1);
  });
}
