import type { ConfigStore } from "../config.js";
import { resolveChatActor } from "./authz/actor.js";
import { renderText, type Caller, type CommandInput, type CommandInvoker, type CommandSurfaces, type InvokeErrorCode, type SettledOutcome } from "./commandRegistry.js";
import { catalogueText, chatForm, commandsInGroup, helpText, parseInvocation, tokenize, type CommandShape, type GrammarRejection } from "./commandSurface.js";
import type { IncomingMessage } from "./types.js";

// The chat adapter for the command registry (#157 U13 — R7, KTD18, KTD19,
// KTD21, KTD25). Chat is the one surface where a command shares its namespace
// with prose, so recognition is deliberately narrow: a message IS a command
// only when it starts with `<group> <verb>` for an id that is registered AND
// exposed to chat (plus the one word `help`, the chat spelling of `help show`).
// Everything else — prose, an unknown verb, a mid-sentence mention — is null,
// and the dispatcher carries on. Since phase 4b there is no legacy chat parser
// left: this is the ONLY thing that turns chat text into a command. Natural
// language is never recognized here (KD3: never guess); the dispatcher's
// `recognizeOperation` translates its few conservative forms INTO a registry
// invocation (`repo.test` / `repo.build`) instead of executing anything itself.
//
// The rest of the message is bound by the SAME grammar the CLI uses
// (`parseInvocation`): positionals, `--kebab-case` flags, quoted values. A
// recognized command with a malformed tail is an `invalid_input` reply — the
// registry's own code for that fault, worded as the usage hint — never a model
// turn: a command that is almost right must be corrected, not guessed at.
// `<group> help` and `<group> <verb> --help` reply with derived help.
//
// Like every adapter it holds no command logic: it builds the `Caller`, hands
// the untyped `{ args, options }` to `invoke` (the schemas coerce), renders the
// JSON result through the shared `renderText`, and maps the error code to one
// line. The reply is PLAIN TEXT — Slack escaping is the channel's job
// (`SlackIO.reply` → `mdToMrkdwn`), never the core's (invariant 1).

export type ParsedChatCommand =
  /** A well-formed command: invoke it. */
  | { kind: "invoke"; id: string; input: CommandInput }
  /** Help, or a rejected tail, for a recognized command form: reply, never
   *  invoke. A rejection carries the grammar's `error` code (`invalid_input`);
   *  a help reply has none. */
  | { kind: "reply"; text: string; error?: GrammarRejection["code"] };

/** The slice of a registry the parser needs: ids, descriptions, arguments, options, surface opt-outs. */
export interface ChatCommandCatalog {
  list(): ReadonlyArray<CommandShape & { surfaces?: CommandSurfaces }>;
}

/** A registry bound to its deps — the same `CommandInvoker` every adapter
 *  receives (`bindCommands` in commandRegistry.ts); the dispatcher carries one
 *  as `CoreDeps.commands` and never learns the deps type. */
export type ChatCommands = CommandInvoker;

/** The one-word chat spelling of `help show` (KTD25): what a person types first. */
export const HELP_COMMAND_ID = "help.show";

const WORD = /^[a-z][a-z0-9]*$/;

function chatExposed(cmd: { surfaces?: CommandSurfaces }): boolean {
  return cmd.surfaces?.chat !== false;
}

/** Slack wraps every URL a person types as `<url>` (or `<url|label>` when a
 *  client attaches a label), and escapes `&`, `<` and `>` inside it as
 *  `&amp;`, `&lt;` and `&gt;` — the only three entities Slack message text
 *  carries. A command value like `--url https://…` must bind to the bare url,
 *  so http(s) links are unwrapped — label dropped, those entities restored —
 *  before the grammar sees the text. Only http(s) links: mentions, channels and
 *  `<!here>` stay as they are (they are prose to the grammar, never a value). */
export function unwrapChatLinks(text: string): string {
  return text.replace(/<(https?:\/\/[^<>|\s]+)(?:\|[^<>]*)?>/g, (_m, url: string) => url.replace(/&(amp|lt|gt);/g, (_e, name: string) => SLACK_ENTITIES[name as keyof typeof SLACK_ENTITIES]));
}

const SLACK_ENTITIES = { amp: "&", lt: "<", gt: ">" } as const;

/**
 * `<group> <verb> …` → the command id and its bound input, a help/usage reply,
 * or null when the message is not a chat command: prose, an id that is not
 * registered, or one that opted out of chat (`surfaces.chat: false`). The bare
 * word `help` is `help show`; `<group> help` lists the group's chat commands.
 */
export function parseChatCommand(rawText: string, catalog: ChatCommandCatalog): ParsedChatCommand | null {
  const text = unwrapChatLinks(rawText);
  const trimmed = text.trim();
  const exposed = catalog.list().filter(chatExposed);
  if (/^help$/i.test(trimmed)) return exposed.some((c) => c.id === HELP_COMMAND_ID) ? { kind: "invoke", id: HELP_COMMAND_ID, input: { args: [], options: {} } } : null;
  const head = trimmed.split(/\s+/, 2);
  if (head.length < 2 || !WORD.test(head[0]) || !WORD.test(head[1])) return null;
  const [group, verb] = head;
  if (verb === "help") {
    const inGroup = commandsInGroup(exposed, group);
    if (inGroup.length === 0) return null;
    return { kind: "reply", text: `${group} commands:\n${catalogueText(inGroup)}` };
  }
  const id = `${group}.${verb}`;
  const cmd = exposed.find((c) => c.id === id);
  if (!cmd) return null;
  // A malformed tail (or an unterminated quote) is worded exactly like a
  // registry `invalid_input` (`chatErrorLine`'s default) and carries that code.
  const rejected = (message: string): ParsedChatCommand => ({ kind: "reply", error: "invalid_input", text: `⚠️ \`${chatForm(id)}\`: ${message}` });
  const tokens = tokenize(text);
  if (!tokens.ok) return rejected(tokens.error);
  const bound = parseInvocation(cmd, tokens.tokens.slice(2));
  switch (bound.kind) {
    case "help":
      return { kind: "reply", text: helpText(cmd) };
    case "invalid":
      return rejected(bound.error);
    case "invoke":
      return { kind: "invoke", id, input: bound.input };
  }
}

export interface HandleChatCommandArgs {
  commands: ChatCommands;
  parsed: ParsedChatCommand;
  /** The message's identity: `userId` becomes the caller id (and, namespaced,
   *  its `Actor`); channel + thread are the caller's `origin` — context, never
   *  authority: what the caller may SEE is its actor's grants (authorization.md). */
  msg: Pick<IncomingMessage, "userId" | "channelId" | "threadKey">;
  config: Pick<ConfigStore, "grantsFor" | "adminsHint">;
  /** Resolves the repo this thread is bound to, lazily — `Caller.origin.repo`
   *  for the commands that ask (the dispatcher supplies history + the
   *  production resolver). Absent → no repo scope. */
  resolveRepo?: () => Promise<string | undefined>;
  /** Clock for live-run durations; defaults to `Date.now()`. */
  now?: number;
}

/** The `Caller` a chat message resolves to: the message's user as the id and
 *  as the `Actor` the policy table decides on (its grants are what config names
 *  for that user id — `ConfigStore.grantsFor`), and the channel + thread it
 *  came from (`origin`). The adapter makes no authorization decision (KTD3):
 *  a machine credential speaking as text (`http:<subject>`, `mcp:<subject>`)
 *  is admitted by its grants like its tool call and sees the runs its grants
 *  name — not the channel it speaks in (authorization.md item 7), so one token
 *  gets one answer on every surface. */
export function chatCallerFor(msg: Pick<IncomingMessage, "userId" | "channelId" | "threadKey">, config: Pick<ConfigStore, "grantsFor">, resolveRepo?: () => Promise<string | undefined>): Caller {
  return {
    kind: "chat",
    id: msg.userId,
    actor: resolveChatActor(msg, (id) => config.grantsFor(id)),
    origin: { channelId: msg.channelId, threadKey: msg.threadKey, ...(resolveRepo ? { repo: resolveRepo } : {}) },
  };
}

/** The reply text plus whether the command succeeded — a caller that records
 *  the invocation as a run (dispatcher `runInlineCommandRun`) derives the run's
 *  outcome from `ok`, never from the text. */
export interface ChatCommandResult {
  text: string;
  ok: boolean;
  /** The error code when the invocation failed — the registry's, or the
   *  grammar's `invalid_input` for a malformed tail (a help reply has none). */
  error?: InvokeErrorCode;
  /** Present when the command succeeded AND has a deferred outcome
   *  (`CommandDef.settle`): awaiting it yields the follow-up to post in the
   *  same thread once the effect has settled (undefined = nothing to add). The
   *  caller posts `text` first, then awaits this. */
  followUp?: () => Promise<SettledOutcome | undefined>;
}

/** One line per error code; the shared wording every chat command uses. A
 *  refusal the registry decided (the policy table denied the caller the
 *  command's action) is the fixed "is restricted" line; one the command
 *  decided about the request (the channel scope, another user's memory, a repo
 *  allowlist) carries its reason. The deny reason itself never reaches a reply
 *  (KTD8): it is on the audit line. */
export function chatErrorLine(id: string, error: InvokeErrorCode, message: string, config: Pick<ConfigStore, "adminsHint">, decidedBy: "registry" | "handler" = "registry"): string {
  const name = chatForm(id);
  switch (error) {
    case "unauthorized":
      return decidedBy === "handler" ? `🚫 \`${name}\`: ${message} Ask ${config.adminsHint()}.` : `🚫 \`${name}\` is restricted. Ask ${config.adminsHint()}.`;
    case "internal":
      return `⚠️ \`${name}\` failed: ${message}`;
    default:
      return `⚠️ \`${name}\`: ${message}`;
  }
}

/** Invoke a parsed chat command as the message's user (a help or rejected parse is replied as-is, `ok: false`, with its code). */
export async function invokeChatCommand({ commands, parsed, msg, config, resolveRepo, now }: HandleChatCommandArgs): Promise<ChatCommandResult> {
  if (parsed.kind === "reply") return { ok: false, text: parsed.text, ...(parsed.error ? { error: parsed.error } : {}) };
  const caller = chatCallerFor(msg, config, resolveRepo);
  const res = await commands.invoke(parsed.id, parsed.input, caller);
  if (res.ok) {
    const text = renderText(commands.get(parsed.id) ?? { id: parsed.id }, res.value, { surface: "chat", ...(now === undefined ? {} : { now }) });
    const { id } = parsed;
    return { ok: true, text, ...(commands.settles(id) ? { followUp: () => commands.settle(id, res.value, caller) } : {}) };
  }
  return { ok: false, error: res.error, text: chatErrorLine(parsed.id, res.error, res.message, config, res.decidedBy) };
}

/** Text-only view of `invokeChatCommand` for callers that need just the reply. */
export async function handleChatCommand(args: HandleChatCommandArgs): Promise<string> {
  return (await invokeChatCommand(args)).text;
}
