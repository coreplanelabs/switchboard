import { STATUS_PREFIXES } from "../../core/dispatch/reply.js";
import type { SlackFile } from "./attachments.js";

// The pure half of reading a Slack thread: fetched `conversations.replies` messages in,
// the turns a model may see out. `SlackIO.history()` applies it to the current
// thread (then downloads the files it kept); the conversation reader of record
// 0037 applies it to a linked thread, so both read a thread with the same rules
// and a message dropped from one is dropped from the other.

/** One message as `conversations.replies` returns it — the fields the mapping reads. */
export interface SlackThreadMessage {
  edited?: { ts?: string; user?: string };
  bot_id?: string;
  user?: string;
  text?: string;
  ts?: string;
  files?: SlackFile[];
}

/** A kept message: who said it (by id), what, when, and the user's files. */
export interface ThreadTurn {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms from Slack's fractional-seconds `ts`; absent when it does not parse. */
  at?: number;
  /** Slack's own `ts`, exactly as sent — the id a permalink names a message by. */
  ts?: string;
  /** The author's user id; absent on a bot's message. */
  user?: string;
  /** The posting app's bot id; a message with one is an `assistant` turn. */
  botId?: string;
  /** A user's attachments only — a bot's files never reach the model. */
  files?: SlackFile[];
}

export interface ThreadTurnsOptions {
  /** The triggering message's `ts`: dropped, because the dispatcher appends it as the current turn. */
  skipTs?: string;
  /** The bot's user id: its mention is stripped from every kept text. */
  botUserId?: string;
}

/** Slack app attribution is transport chrome. A mention or a matching Markdown
 *  emphasis pair on `Sent using` distinguishes an inline footer from prose;
 *  without either, a plain app label must occupy its own trailing line.
 *  Labels are bounded, regardless of the app's display name. */
const APP_MENTION_FOOTER_RE =
  /(?:^|\s)(?:(\*{1,3}|_{1,3})Sent using\1|Sent using)\s+<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\[[^\]\n]*\])?\s*$/i;
const APP_EMPHASIZED_LABEL_FOOTER_RE = /(?:^|[ \t])(\*{1,3}|_{1,3})Sent using\1[ \t]+(?!<@)\S[^\r\n]{0,119}$/i;
const APP_LABEL_FOOTER_RE = /(?:^|\r?\n)(?:(\*{1,3}|_{1,3})Sent using\1|Sent using)[ \t]+\S[^\r\n]{0,119}$/i;

/** The other footer the Claude Slack app appends — to a message it posts from
 *  a Claude Code session: the source channel, the person when the app names
 *  them, a separator, the permalink of the person's own thread
 *  (`Sent by Claude in <#C…|name> on behalf of <@U…> · <permalink|thread>`; the
 *  `on behalf of` part is absent on older posts). Slack delivers it in a
 *  `context` block, not in the message's `text`, so the adapter flattens the
 *  blocks into the text it reads (`rawTextOf`). Chrome of the same kind,
 *  anchored to the end of the text the same way; the requester resolver
 *  (`slack/requester.ts`) reads it before it is stripped. */
export const RELAY_FOOTER_RE =
  /(?:^|\s)Sent by Claude in <#([CGD][A-Z0-9_]+)(?:\|[^>]*)?>(?:\s+on behalf of <@([A-Z0-9]+)(?:\|[^>]*)?>)?\s*(?:·|•|-|—)\s*<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>\s*$/;

/**
 * Remove the app footer(s) from the end of a message's text and trim it.
 * A trailing app mention, a standalone `Sent using` attribution, or a relay
 * footer is removed until no footer remains. The same operation applies to the
 * request text (`stripMention`) and every kept thread turn, including linked
 * threads, so downstream parsers see only the person's request.
 */
export function stripAppFooter(text: string): string {
  let out = text.trim();
  let prev: string;
  do {
    prev = out;
    out = out.replace(APP_MENTION_FOOTER_RE, "");
    // A quoted last line is the person's example, not attribution on their request.
    if (!/^[ \t]*>/.test(out.slice(out.lastIndexOf("\n") + 1))) {
      out = out.replace(APP_EMPHASIZED_LABEL_FOOTER_RE, "");
    }
    out = out.replace(APP_LABEL_FOOTER_RE, "").replace(RELAY_FOOTER_RE, "").trim();
  } while (out !== prev);
  return out;
}

/** Connector posts may spell the bot's display name as plain text instead of
 * a Slack user mention. Only the leading address is transport chrome. */
export function stripBotNameAddress(text: string): string {
  return text.replace(/^\s*@switchboard(?=\s|$)\s*/i, "");
}

/**
 * Map fetched thread messages to turns. Drops the triggering message (by `skipTs`), the
 * bot's own status cards (`STATUS_PREFIXES`), and any message left with neither
 * text nor a user's files; strips the bot mention and the app footer; stamps
 * `at` from `ts`.
 */
export function threadTurns(messages: readonly SlackThreadMessage[], opts: ThreadTurnsOptions): ThreadTurn[] {
  const kept: ThreadTurn[] = [];
  for (const mm of messages) {
    if (opts.skipTs !== undefined && mm.ts === opts.skipTs) continue;
    const raw = mm.text ?? "";
    const text = stripAppFooter(opts.botUserId ? stripBotNameAddress(raw.replaceAll(`<@${opts.botUserId}>`, "")) : raw);
    if (STATUS_PREFIXES.some((p) => text.startsWith(p))) continue;
    const files = mm.bot_id ? undefined : mm.files;
    if (!text && !files?.length) continue;
    const at = mm.ts !== undefined && Number.isFinite(Number(mm.ts)) ? Math.round(Number(mm.ts) * 1000) : undefined;
    kept.push({
      role: mm.bot_id ? "assistant" : "user",
      text,
      ...(at !== undefined ? { at } : {}),
      ...(mm.ts !== undefined ? { ts: mm.ts } : {}),
      ...(mm.user !== undefined ? { user: mm.user } : {}),
      ...(mm.bot_id !== undefined ? { botId: mm.bot_id } : {}),
      files,
    });
  }
  return kept;
}
