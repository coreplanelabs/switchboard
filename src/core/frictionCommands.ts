import type { ConfigStore } from "../config.js";
import { invokeChatCommand, type ChatCommandResult, type ChatCommands } from "./commandChat.js";
import type { IncomingMessage } from "./types.js";

// The LEGACY chat form of the self-improvement trigger (Area 7b / #84):
// `friction report [--min-runs N]` / `friction propose [--dry-run] [--top N]
// [--min-runs N] [--repo owner/name]`. Since #157 R13 the commands themselves
// live on the command registry (`friction.report` / `friction.propose`,
// src/core/commands/friction.ts); this module only translates the flag syntax
// into a registry invocation so the syntax people already type — and the
// exact replies they get — stay unchanged. It contains no command logic: the
// registry authorizes (chat gate `open` / `repoManager`), parses, runs, and
// renders; this adapter only keeps the historical wording of two error
// replies (the 🚫 refusal and the ⚠️ precondition line). The registry's own
// `friction report minRuns=3` form works too, through parseChatCommand — and
// the friction path claims EVERY message whose first word is `friction`, so a
// mixed or misspelled command is a usage line, never a model turn.

export type FrictionCommand =
  | { verb: "report" | "propose"; dryRun: boolean; top?: number; minRuns?: number; repo?: string }
  | { error: string };

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

const KEY_VALUE = /^[A-Za-z][A-Za-z0-9_]*=/;

/**
 * Parses a message whose first word is `friction`. The friction path CLAIMS
 * every such message — a command that is almost right must get a usage error,
 * never a model turn (which would also bypass the repo-manager gate on
 * `propose`). Three outcomes:
 *   - `friction report|propose [--flags]` → the parsed legacy command;
 *   - `friction report|propose key=value …` (EVERY argument in the registry's
 *     own form) → null: parseChatCommand takes it next and names a bad key;
 *   - anything else starting with `friction` — an unknown verb, a bare
 *     `friction`, a `--flag`/`key=value` mix, a stray word — → `{ error }`, the
 *     deterministic usage line.
 * Text that merely mentions friction (`what friction did we see?`,
 * `frictionless`) is not a friction command and passes through.
 */
export function parseFrictionCommand(text: string): FrictionCommand | null {
  const words = text.trim().split(/\s+/);
  if (words.length === 0 || words[0].toLowerCase() !== "friction") return null;
  const verbWord = words[1];
  const verb = verbWord?.toLowerCase();
  if (verb !== "report" && verb !== "propose") {
    const got = verbWord === undefined ? "`friction`" : `\`friction ${verbWord}\``;
    return { error: `${got} is not a friction command — use \`friction report [--min-runs <n>]\` or \`friction propose [--dry-run] [--top <n>] [--min-runs <n>] [--repo <owner/name>]\`.` };
  }
  const cmd: Extract<FrictionCommand, { verb: string }> = { verb, dryRun: false };
  const tokens = words.slice(2);
  // Every argument in the registry's `key=value` form → parseChatCommand's message, not this parser's.
  if (tokens.length > 0 && tokens.every((t) => KEY_VALUE.test(t))) return null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--dry-run") {
      cmd.dryRun = true;
      continue;
    }
    const repoFlag = /^--repo(?:=(.*))?$/.exec(t);
    if (repoFlag) {
      const raw = repoFlag[1] ?? tokens[++i];
      if (!raw || !REPO_SLUG.test(raw)) return { error: `\`--repo\` expects an \`owner/name\` slug, got \`${raw ?? ""}\`.` };
      cmd.repo = raw;
      continue;
    }
    const flag = /^--(top|min-runs)(?:=(.*))?$/.exec(t);
    if (!flag) {
      const accepts = `\`friction ${verb}\` accepts \`--dry-run\`, \`--top <n>\`, \`--min-runs <n>\`, \`--repo <owner/name>\``;
      // A `key=value` here means the two syntaxes were mixed: say so, naming both forms.
      const mixed = KEY_VALUE.test(t) ? `, or the \`key=value\` form alone (\`friction ${verb} minRuns=2\`); the two cannot be mixed` : "";
      return { error: `Unknown option \`${t}\` — ${accepts}${mixed}.` };
    }
    const raw = flag[2] ?? tokens[++i];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return { error: `\`--${flag[1]}\` expects a positive integer, got \`${raw ?? ""}\`.` };
    if (flag[1] === "top") cmd.top = n;
    else cmd.minRuns = n;
  }
  return cmd;
}

/** The registry invocation a parsed legacy command stands for: id + raw string
 *  inputs (the command's schema coerces them, exactly as a chat `key=value`
 *  would). `report` takes only `minRuns` — `--top`/`--dry-run` never affected
 *  it and are still accepted silently, as they always were. */
export function toRegistryInvocation(cmd: Extract<FrictionCommand, { verb: string }>): { id: string; input: Record<string, string> } {
  const input: Record<string, string> = {};
  if (cmd.minRuns !== undefined) input.minRuns = String(cmd.minRuns);
  if (cmd.verb === "report") return { id: "friction.report", input };
  if (cmd.dryRun) input.dryRun = "true";
  if (cmd.top !== undefined) input.top = String(cmd.top);
  if (cmd.repo !== undefined) input.repo = cmd.repo;
  return { id: "friction.propose", input };
}

/** The outcome of a friction command: the reply text plus whether the step
 *  actually ran (`ok`) or was refused/misconfigured/failed — the run record
 *  (and a scheduled firing's outcome) is derived from `ok`, not from the text. */
export type FrictionCommandResult = ChatCommandResult;

/** Runs an already-parsed legacy-form friction command through the registry. */
export async function runFrictionCommand(
  config: Pick<ConfigStore, "chatGateFor" | "adminsHint">,
  msg: IncomingMessage,
  commands: ChatCommands,
  cmd: FrictionCommand,
): Promise<FrictionCommandResult> {
  if ("error" in cmd) return { text: cmd.error, ok: false };
  return invokeChatCommand({
    commands,
    parsed: toRegistryInvocation(cmd),
    msg,
    config,
    wording: {
      unauthorized: () => `🚫 Filing friction proposals (\`friction propose\`) is restricted. Ask ${config.adminsHint()}.`,
      unavailable: (message) => `⚠️ ${message}`,
    },
  });
}

/** Handles a legacy-form friction command through the registry, or returns
 *  null when `text` is not one. Text-only view of `runFrictionCommand`. */
export async function handleFrictionCommand(
  config: Pick<ConfigStore, "chatGateFor" | "adminsHint">,
  msg: IncomingMessage,
  commands: ChatCommands,
  cmd: FrictionCommand | null = parseFrictionCommand(msg.text),
): Promise<string | null> {
  if (!cmd) return null;
  return (await runFrictionCommand(config, msg, commands, cmd)).text;
}

