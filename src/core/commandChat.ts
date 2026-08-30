import type { ConfigStore } from "../config.js";
import { renderText, toSurfaceNames, type Caller, type CommandSurfaces, type CommandInvoker, type InvokeErrorCode } from "./commandRegistry.js";
import type { IncomingMessage } from "./types.js";

// The chat adapter for the command registry (#157 U13 — R7, KTD18, KTD19).
// Chat is the one surface where a command shares its namespace with prose, so
// recognition is deliberately narrow: a message IS a command only when the
// whole message is `<group> <verb> [key=value …]` for an id that is registered
// AND exposed to chat AND whose `<group> <verb>` form no legacy parser still
// owns. Everything else — prose, an unknown verb, a mid-sentence mention, a
// reserved form — is null, and the dispatcher carries on to the next stage.
// Natural language is never recognized here (KD3: never guess); that stays
// with `recognizeOperation`.
//
// Like every adapter it holds no command logic: it builds the `Caller`, hands
// the raw string arguments to `invoke` (the zod schema coerces them), renders
// the JSON result through the shared `renderText`, and maps the error code
// to one line. The reply is PLAIN TEXT — Slack escaping is the channel's job
// (`SlackIO.reply` → `mdToMrkdwn`), never the core's (invariant 1).

export interface ParsedChatCommand {
  id: string;
  /** Raw `key=value` arguments, values unquoted but otherwise untouched. */
  input: Record<string, string>;
}

/** The slice of a registry the parser needs: ids and their surface opt-outs. */
export interface ChatCommandCatalog {
  list(): ReadonlyArray<{ id: string; surfaces?: CommandSurfaces }>;
}

/** A registry bound to its deps — the same `CommandInvoker` every adapter
 *  receives (`bindCommands` in commandRegistry.ts); the dispatcher carries one
 *  as `CoreDeps.commands` and never learns the deps type. */
export type ChatCommands = CommandInvoker;

/** `<group> <verb>` chat forms a legacy parser still owns (KTD19): the config
 *  verbs (dispatcher `handleConfigCommand`), the mutating repo verbs
 *  (`handleRepoCommand`, behind `canManageRepos`), and the `repo test/build`
 *  ops (`recognizeOperation`). Reservation is per form, not per group, so
 *  `repo list` (registry `repo.list`) shares its group with `repo onboard`.
 *  Migrating a verb onto the registry removes its form here. */
export const RESERVED_CHAT_COMMANDS: ReadonlySet<string> = new Set([
  "config show",
  "config set",
  "config clear",
  "repo onboard",
  "repo offboard",
  "repo reconfigure",
  "repo rebuild",
  "repo test",
  "repo build",
]);

// Whole-message anchored: `<group> <verb>` then zero or more `key=value` pairs
// (value: double-quoted, single-quoted, or one unbroken token), nothing else.
const CHAT_COMMAND = /^\s*([a-z][a-z0-9]*)\s+([a-z][a-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']+))*)\s*$/;
const CHAT_ARG = /([A-Za-z][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;

/**
 * `<group> <verb> key=value …` → the command id and its raw arguments, or null
 * when the message is not a chat command: prose, an id that is not registered,
 * one that opted out of chat (`surfaces.chat: false`), or a reserved
 * `<group> <verb>` form.
 */
export function parseChatCommand(text: string, catalog: ChatCommandCatalog, reserved: ReadonlySet<string>): ParsedChatCommand | null {
  const m = CHAT_COMMAND.exec(text);
  if (!m) return null;
  const [, group, verb, args] = m;
  if (reserved.has(`${group} ${verb}`)) return null;
  const id = `${group}.${verb}`;
  const cmd = catalog.list().find((c) => c.id === id);
  if (!cmd || cmd.surfaces?.chat === false) return null;
  const input: Record<string, string> = {};
  for (const arg of args.matchAll(CHAT_ARG)) input[arg[1]] = arg[2] ?? arg[3] ?? arg[4] ?? "";
  return { id, input };
}

export interface HandleChatCommandArgs {
  commands: ChatCommands;
  parsed: ParsedChatCommand;
  /** The message's identity: `userId` becomes the caller id; `channelId` pins a
   *  machine caller (`http:`/`mcp:`) to its channel (see `chatCallerFor`). */
  msg: Pick<IncomingMessage, "userId" | "channelId">;
  config: Pick<ConfigStore, "chatGateFor" | "adminsHint">;
  /** Clock for live-run durations; defaults to `Date.now()`. */
  now?: number;
  /** Per-error reply overrides for a legacy chat form that keeps its historical
   *  wording (frictionCommands.ts). Absent → the shared wording below. */
  wording?: Partial<Record<InvokeErrorCode, (message: string) => string>>;
}

/** Channels whose messages come from a machine credential — an ingress token
 *  (`POST /ingress`, `http:<subject>`) or an MCP session (`mcp:<subject>`).
 *  Such a caller is pinned to its own channel (KTD10): the structured MCP tools
 *  already pin it, and a command sent as TEXT through the same credential must
 *  see exactly the same runs — never the org's. Slack humans (and the local CLI
 *  harness) are people the chat gates already vet; they stay unpinned. */
export function isMachineChannel(channelId: string): boolean {
  return channelId.startsWith("http:") || channelId.startsWith("mcp:");
}

/** The `Caller` a chat message resolves to: the message's user as the id, the
 *  config's chat gates, and — for a machine channel — the channel pin. */
export function chatCallerFor(msg: Pick<IncomingMessage, "userId" | "channelId">, config: Pick<ConfigStore, "chatGateFor">): Caller {
  return {
    kind: "chat",
    id: msg.userId,
    scopes: new Set(),
    chatGate: config.chatGateFor(msg.userId),
    ...(isMachineChannel(msg.channelId) ? { channel: msg.channelId } : {}),
  };
}

/** The reply text plus whether the command succeeded — a caller that records
 *  the invocation as a run (dispatcher `runInlineCommandRun`) derives the run's
 *  outcome from `ok`, never from the text. */
export interface ChatCommandResult {
  text: string;
  ok: boolean;
}

/** Invoke a parsed chat command as the message's user. */
export async function invokeChatCommand({ commands, parsed, msg, config, now, wording = {} }: HandleChatCommandArgs): Promise<ChatCommandResult> {
  const caller = chatCallerFor(msg, config);
  const res = await commands.invoke(parsed.id, parsed.input, caller);
  const name = toSurfaceNames(parsed.id).chat;
  if (res.ok) return { ok: true, text: renderText(commands.get(parsed.id) ?? { id: parsed.id }, res.value, now === undefined ? {} : { now }) };
  const custom = wording[res.error];
  if (custom) return { ok: false, text: custom(res.message) };
  switch (res.error) {
    case "unauthorized":
      return { ok: false, text: `🚫 \`${name}\` is restricted. Ask ${config.adminsHint()}.` };
    case "internal":
      return { ok: false, text: `⚠️ \`${name}\` failed: ${res.message}` };
    default:
      return { ok: false, text: `⚠️ \`${name}\`: ${res.message}` };
  }
}

/** Text-only view of `invokeChatCommand` for callers that need just the reply. */
export async function handleChatCommand(args: HandleChatCommandArgs): Promise<string> {
  return (await invokeChatCommand(args)).text;
}
