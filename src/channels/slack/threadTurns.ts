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

/**
 * Map a thread page to turns. Drops the triggering message (by `skipTs`), the
 * bot's own status cards (`STATUS_PREFIXES`), and any message left with neither
 * text nor a user's files; strips the bot mention; stamps `at` from `ts`.
 */
export function threadTurns(messages: readonly SlackThreadMessage[], opts: ThreadTurnsOptions): ThreadTurn[] {
  const kept: ThreadTurn[] = [];
  for (const mm of messages) {
    if (opts.skipTs !== undefined && mm.ts === opts.skipTs) continue;
    const raw = mm.text ?? "";
    const text = opts.botUserId ? raw.replaceAll(`<@${opts.botUserId}>`, "").trim() : raw;
    if (STATUS_PREFIXES.some((p) => text.startsWith(p))) continue;
    const files = mm.bot_id ? undefined : mm.files;
    if (!text && !files?.length) continue;
    const at = mm.ts !== undefined && Number.isFinite(Number(mm.ts)) ? Math.round(Number(mm.ts) * 1000) : undefined;
    kept.push({
      role: mm.bot_id ? "assistant" : "user",
      text,
      ...(at !== undefined ? { at } : {}),
      ...(mm.user !== undefined ? { user: mm.user } : {}),
      ...(mm.bot_id !== undefined ? { botId: mm.bot_id } : {}),
      files,
    });
  }
  return kept;
}
