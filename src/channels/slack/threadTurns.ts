import { STATUS_PREFIXES } from "../../core/dispatch/reply.js";
import type { SlackFile } from "./attachments.js";

// The pure half of reading a Slack thread: one `conversations.replies` page in,
// the turns a model may see out. `SlackIO.history()` applies it to the current
// thread (then downloads the files it kept); the conversation reader of record
// 0037 applies it to a linked thread, so both read a thread with the same rules
// and a message dropped from one is dropped from the other.

/** One message as `conversations.replies` returns it — the fields the mapping reads. */
export interface SlackThreadMessage {
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

/** Slack appends "*Sent using* <@APP|Name>" as the LAST line of a message an
 *  app posts on a user's behalf (the Claude Slack plugin does this). It is
 *  platform chrome, not the user's words — left in, it breaks strict inline
 *  parsers (`repo onboard …` saw `*Sent` as a bad token) and, quoted from a
 *  linked thread, puts a stray mention token inside the fence. Only whole
 *  trailing footers of exactly that shape are removed (repeated for stacked
 *  footers); the phrase inside a user's own text is untouched. The footer is
 *  anchored to the END of the text, not to its own line: the raw event text
 *  arrives as `friction report *Sent using* <@UAPP>` — same line, no newline —
 *  so a line-anchored regex lets `*Sent` reach the command parser (`repo list`
 *  masks this because it ignores trailing text). An optional bracketed sender
 *  attribution after the mention is tolerated too. */
const APP_FOOTER_RE = /(?:^|\s)(?:\*Sent using\*|Sent using)\s+<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\[[^\]\n]*\])?\s*$/;

/** The other footer the Claude Slack app appends — to a message it posts from
 *  a Claude Code session: the source channel, a separator, the permalink of the
 *  person's own thread (`Sent by Claude in <#C…|name> · <permalink|thread>`).
 *  Chrome of the same kind, anchored to the end of the text the same way; the
 *  requester resolver (`slack/requester.ts`) reads it before it is stripped. */
export const RELAY_FOOTER_RE =
  /(?:^|\s)Sent by Claude in <#([CGD][A-Z0-9_]+)(?:\|[^>]*)?>\s*(?:·|•|-|—)\s*<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>\s*$/;

/**
 * Remove the app footer(s) from the end of a message's text and trim it.
 * Exactly the two `Sent using` shapes Slack emits (bold or plain — never
 * asymmetric) and the relay footer, as whole trailing lines; repeated because a
 * forwarded app message can stack two, and a message that is nothing but the
 * footer strips to "". Applied to the request text (`stripMention`) and to
 * every turn `threadTurns` keeps, so the current thread's history and a quoted
 * thread read the same words.
 */
export function stripAppFooter(text: string): string {
  let out = text.trim();
  let prev: string;
  do {
    prev = out;
    out = out.replace(APP_FOOTER_RE, "").replace(RELAY_FOOTER_RE, "").trim();
  } while (out !== prev);
  return out;
}

/**
 * Map a thread page to turns. Drops the triggering message (by `skipTs`), the
 * bot's own status cards (`STATUS_PREFIXES`), and any message left with neither
 * text nor a user's files; strips the bot mention and the app footer; stamps
 * `at` from `ts`.
 */
export function threadTurns(messages: readonly SlackThreadMessage[], opts: ThreadTurnsOptions): ThreadTurn[] {
  const kept: ThreadTurn[] = [];
  for (const mm of messages) {
    if (opts.skipTs !== undefined && mm.ts === opts.skipTs) continue;
    const raw = mm.text ?? "";
    const text = stripAppFooter(opts.botUserId ? raw.replaceAll(`<@${opts.botUserId}>`, "") : raw);
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
