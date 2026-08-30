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

import { pathToFileURL } from "node:url";
import { ConfigStore } from "./config.js";
import { buildCoreCommands } from "./core/commandCatalogue.js";
import { CommandRegistry, renderText, type Caller, type CommandInput, type CommandInvoker, type InvokeErrorCode } from "./core/commandRegistry.js";
import { catalogueText, chatForm, helpText, parseInvocation, type GrammarRejection } from "./core/commandSurface.js";
import { dispatch } from "./core/dispatcher.js";
import { createRunHistoryWriter } from "./core/runHistoryWriter.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { buildRunStore } from "./core/runStore.js";
import { PlainTextFormatter } from "./core/structuredMessage.js";
import type { ChannelIO, StatusHandle, StatusUpdate } from "./core/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";

export const CLI_CALLER: Caller = { kind: "cli", id: "cli:local", scopes: "all" };

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
export function parseCliArgv(argv: readonly string[], commands: Pick<CommandInvoker, "list" | "get">, now: () => number = Date.now): CliInvocation {
  // A bare `help` is the catalogue; `help show …` is the registered command like any other `<group> <verb>`.
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || (argv[0] === "help" && argv.length === 1)) return { kind: "catalogue" };
  if (argv[0] === "ask") return parseAsk(argv.slice(1), now);
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const [group, verb, ...tail] = rest;
  if (!group || !verb || !WORD.test(group) || !WORD.test(verb)) return { kind: "usage", error: `${USAGE}\n  expected <group> <verb>` };
  const id = `${group}.${verb}`;
  const cmd = commands.get(id);
  if (!cmd || !CommandRegistry.exposedTo(cmd, "cli")) return { kind: "usage", error: `${USAGE}\n  unknown command: ${group} ${verb}\n\ncommands:\n${cliCatalogue(commands)}` };
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
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/** `error (<code>): <message>` — the one stderr shape for every refusal, whoever decided it. */
function errorLine(code: InvokeErrorCode, message: string): string {
  return `error (${code}): ${message}`;
}

/**
 * Run one bound registry command. Transport-free so the contract test drives
 * the very path `main()` uses: a failure is `error (<code>): <message>` on
 * stderr and nothing on stdout — exit 2 when the registry rejected the input
 * (`invalid_input`, the same exit the grammar's rejection gets), exit 1 for
 * any other failure; success prints the exact `invoke` JSON (`--json`) or
 * `renderText` of it.
 */
export async function runCommand(commands: CommandInvoker, parsed: Extract<CliInvocation, { kind: "command" }>, caller: Caller, opts: { now?: number } = {}): Promise<CommandRunOutput> {
  const cmd = commands.get(parsed.id);
  const result = await commands.invoke(parsed.id, parsed.input, caller);
  if (!result.ok) return { exitCode: result.error === "invalid_input" ? 2 : 1, stdout: "", stderr: errorLine(result.error, result.message) };
  return { exitCode: 0, stdout: parsed.json ? JSON.stringify(result.value, null, 2) : renderText(cmd ?? { id: parsed.id }, result.value, opts), stderr: "" };
}

/** What every non-`ask` invocation prints — the pure half `main()` and the tests share. */
export async function runCli(commands: CommandInvoker, parsed: Exclude<CliInvocation, { kind: "ask" }>, caller: Caller, opts: { now?: number } = {}): Promise<CommandRunOutput> {
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
  /** Structured output renders as plain text for the terminal. */
  readonly formatter = new PlainTextFormatter();

  async reply(text: string): Promise<void> {
    console.log("\n" + text);
  }
  async status(initial: StatusUpdate): Promise<StatusHandle> {
    console.error(initial.title);
    return {
      update: (f) => console.error([f.title, f.detail].filter(Boolean).join(" | ").split("\n").join(" | ")),
      done: async (f) => console.error(f.title),
    };
  }
  async history(): Promise<[]> {
    return [];
  }
}

async function main(): Promise<void> {
  const config = new ConfigStore(CONFIG_PATH, "./data/cli-overrides.json");
  const warn = (m: string) => console.error(m);
  // Run history (#157): a CLI `ask` persists exactly like a bot run when
  // `runHistory` is configured (null store → history off); the registry
  // commands read the same store. A fresh process holds no live runs, so
  // `runs list` here is persisted history.
  const runStore = buildRunStore(config.config.runHistory, process.env, { dataDir: "./data", warn: (m) => warn(`[run-history] ${m}`) });
  const commands = buildCoreCommands(config, runStore, { registry: defaultRunRegistry, env: process.env, dataDir: "./data", warn, audit: () => {} });

  const parsed = parseCliArgv(process.argv.slice(2), commands);
  if (parsed.kind !== "ask") {
    const out = await runCli(commands, parsed, CLI_CALLER);
    if (out.stdout) console.log(out.stdout);
    if (out.stderr) console.error(out.stderr);
    process.exit(out.exitCode);
  }

  const providers = new ProviderRegistry(config.config.providers);
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  const runHistoryWriter = runStore
    ? createRunHistoryWriter({ store: runStore, warn, onPersisted: (id) => defaultRunRegistry.markPersisted(id) })
    : undefined;
  // The chat fast path (`runs list`, `friction report`, …) answers from the same
  // catalogue the bot binds — without it those messages would go to the model.
  await dispatch({ config, providers, skills, runHistoryWriter, commands }, { channelId: "cli:local", userId: "cli:local", threadKey: parsed.threadKey, text: parsed.text }, new ConsoleIO());
  // Wait for the record write to settle before exiting rather than dropping it.
  await runHistoryWriter?.settled();
}

// Run only when invoked as a script (tsx/node src/cli.ts), never on import
// (the parsing helpers above are unit-tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
