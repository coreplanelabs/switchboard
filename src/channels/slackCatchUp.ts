import { classifyMessage, threadIncludesBot } from "./slackTriggers.js";

// Reconnect catch-up (#184). Socket Mode does not queue events while the app
// is disconnected, so every bot rollover (deploy → container swap → websocket
// down for the drain + cold start) silently drops whatever was posted in that
// window: no 👀, no run, the caller waits forever. On every (re)connect the
// adapter re-reads recent channel history and dispatches what it never saw.
//
// Slack itself is the durable "was this handled" record (invariant 6 — no
// in-memory state a restart loses, and no host-disk last-seen ts that an
// ephemeral container forgets): a message is handled when it carries the
// bot's own 👀 acceptance reaction, or when the bot has posted in its thread
// after it (the ack can be lost — missing reactions:write — but a status card
// or reply cannot). A same-process seen-set additionally keeps a message that
// arrived live AND appears in the scan from running twice.

/** Bot's acceptance reaction — must match the one `handle()` adds. */
export const ACK_EMOJI = "eyes";

/** Messages posted inside this window with no receipt from us are re-run. Must
 *  cover the worst blackout: the 15 min graceful-drain deadline plus a cold
 *  start. Older un-acked mentions are left alone — re-running a request from
 *  an hour ago is worse than the human re-posting it. */
export const DEFAULT_WINDOW_MS = 20 * 60_000;
/** How far back to scan for thread PARENTS whose threads had activity inside
 *  the window — a follow-up can land in a days-old PR thread. */
export const DEFAULT_PARENT_LOOKBACK_MS = 7 * 86_400_000;
const HISTORY_PAGE = 200;
const MAX_HISTORY_PAGES = 5;
const REPLIES_LIMIT = 200;
const MAX_REPLIES_PAGES = 5;

export interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  /** Optional in Slack's response types; a message without one is skipped. */
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: unknown[];
  reactions?: Array<{ name?: string; users?: string[]; count?: number }>;
}

/** A message the bot never saw live; shaped for the adapter's `handle()`. */
export interface MissedMessage {
  channel: string;
  user: string;
  /** Raw text, mention included — the caller strips it like the live path. */
  text: string;
  ts: string;
  threadTs: string;
  files: unknown[] | undefined;
}

/** The slice of the Slack Web API the catch-up needs — structural so the real
 *  WebClient and a test mock both satisfy it. */
export interface CatchUpClient {
  users: {
    conversations(args: {
      types: string;
      exclude_archived: boolean;
      limit: number;
      cursor?: string;
    }): Promise<{ channels?: Array<{ id?: string }>; response_metadata?: { next_cursor?: string } }>;
  };
  conversations: {
    history(args: {
      channel: string;
      oldest: string;
      limit: number;
      cursor?: string;
    }): Promise<{ messages?: SlackHistoryMessage[]; response_metadata?: { next_cursor?: string } }>;
    replies(args: {
      channel: string;
      ts: string;
      limit: number;
      cursor?: string;
    }): Promise<{ messages?: SlackHistoryMessage[]; response_metadata?: { next_cursor?: string } }>;
  };
}

const tsMs = (ts: string): number => Number(ts) * 1000;
const tsNum = (ts: string | undefined): number => Number(ts ?? 0);

/** Does the message carry the bot's own acceptance reaction? */
export function isAckedByBot(m: SlackHistoryMessage, botUserId: string): boolean {
  return (m.reactions ?? []).some((r) => r.name === ACK_EMOJI && (r.users ?? []).includes(botUserId));
}

const isFromBot = (m: SlackHistoryMessage, botUserId: string): boolean =>
  Boolean(m.bot_id) || m.user === botUserId;

/** Has the bot posted in this thread after `m` — a status card or a reply? */
function botRepliedAfter(thread: SlackHistoryMessage[], m: SlackHistoryMessage, botUserId: string): boolean {
  return thread.some((r) => isFromBot(r, botUserId) && tsNum(r.ts) > tsNum(m.ts));
}

export interface FindMissedInput {
  channel: string;
  botUserId: string;
  /** Messages at or after this instant are eligible (epoch ms). */
  cutoffMs: number;
  /** Top-level channel messages (what conversations.history returns). */
  parents: SlackHistoryMessage[];
  /** Full replies (parent first) for each thread that had activity in the window, by parent ts. */
  threads: Map<string, SlackHistoryMessage[]>;
  /** Same-process dedupe: did this process already accept (channel, ts) live? */
  alreadyHandled: (channel: string, ts: string) => boolean;
}

/** Pure selection: which fetched messages should have started a run and did
 *  not. Mirrors the live triggers exactly — a top-level message needs a
 *  mention; a thread reply needs a mention OR a bot-participating thread;
 *  bot/subtyped (non-file_share) messages never count. Oldest first. */
export function findMissed(input: FindMissedInput): MissedMessage[] {
  const { channel, botUserId, cutoffMs, alreadyHandled } = input;
  const out: MissedMessage[] = [];
  const mentionsBot = (m: SlackHistoryMessage) => (m.text ?? "").includes(`<@${botUserId}>`);
  const eligible = (m: SlackHistoryMessage): m is SlackHistoryMessage & { ts: string } =>
    typeof m.ts === "string" &&
    tsMs(m.ts) >= cutoffMs &&
    !isFromBot(m, botUserId) &&
    (!m.subtype || m.subtype === "file_share") &&
    !isAckedByBot(m, botUserId) &&
    !alreadyHandled(channel, m.ts);
  const push = (m: SlackHistoryMessage & { ts: string }, threadTs: string) =>
    out.push({ channel, user: m.user ?? "unknown", text: m.text ?? "", ts: m.ts, threadTs, files: m.files });

  for (const p of input.parents) {
    if (!p.ts || (p.thread_ts && p.thread_ts !== p.ts)) continue; // a broadcast reply; handled via its thread
    const thread = input.threads.get(p.ts) ?? [];
    if (eligible(p) && mentionsBot(p) && !botRepliedAfter(thread, p, botUserId)) push(p, p.ts);
  }
  for (const [parentTs, thread] of input.threads) {
    const botInThread = threadIncludesBot(thread, botUserId);
    for (const r of thread) {
      if (r.ts === parentTs || !eligible(r)) continue;
      const decision = mentionsBot(r) ? "handle" : classifyMessage(r, botUserId);
      const wanted = decision === "handle" || (decision === "handle-if-bot-in-thread" && botInThread);
      if (wanted && !botRepliedAfter(thread, r, botUserId)) push(r, parentTs);
    }
  }
  return out.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
}

export interface CatchUpOptions {
  client: CatchUpClient;
  botUserId: string;
  alreadyHandled: (channel: string, ts: string) => boolean;
  /** Called once per missed message, oldest first, awaited; a rejection is logged and skipped. */
  onMissed: (m: MissedMessage) => void | Promise<void>;
  now?: number;
  windowMs?: number;
  parentLookbackMs?: number;
  log?: (line: string) => void;
}

/** Scan every channel the bot is a member of and re-dispatch what it missed.
 *  Never throws: per-channel API failures are logged and that channel skipped,
 *  so one bad channel cannot block catch-up of the others or the connect. */
export async function catchUpMissedMentions(opts: CatchUpOptions): Promise<{ channels: number; missed: number }> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const lookbackMs = opts.parentLookbackMs ?? DEFAULT_PARENT_LOOKBACK_MS;
  const log = opts.log ?? ((line) => console.log(line));
  const cutoffMs = now - windowMs;
  const { client, botUserId } = opts;

  let channels: string[] = [];
  try {
    channels = await listChannels(client);
  } catch (err) {
    log(`[catch-up] cannot list channels: ${errMsg(err)}`);
    return { channels: 0, missed: 0 };
  }

  let missed = 0;
  for (const channel of channels) {
    let found: MissedMessage[];
    try {
      const parents = await fetchParents(client, channel, (now - lookbackMs) / 1000);
      const threads = new Map<string, SlackHistoryMessage[]>();
      for (const p of parents) {
        if (!p.ts || !p.latest_reply || (p.reply_count ?? 0) === 0 || tsMs(p.latest_reply) < cutoffMs) continue;
        threads.set(p.ts, await fetchReplies(client, channel, p.ts));
      }
      found = findMissed({ channel, botUserId, cutoffMs, parents, threads, alreadyHandled: opts.alreadyHandled });
    } catch (err) {
      log(`[catch-up] ${channel}: scan failed, skipped: ${errMsg(err)}`);
      continue;
    }
    if (found.length === 0) continue;
    missed += found.length;
    log(`[catch-up] ${channel}: ${found.length} missed message(s) re-dispatched (ts ${found.map((m) => m.ts).join(", ")})`);
    for (const m of found) {
      try {
        await opts.onMissed(m);
      } catch (err) {
        log(`[catch-up] ${channel}:${m.ts}: dispatch failed: ${errMsg(err)}`);
      }
    }
  }
  log(`[catch-up] scanned ${channels.length} channel(s): ${missed} missed message(s)`);
  return { channels: channels.length, missed };
}

async function listChannels(client: CatchUpClient): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.users.conversations({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: HISTORY_PAGE,
      cursor,
    });
    for (const c of res.channels ?? []) if (c.id) ids.push(c.id);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

async function fetchParents(client: CatchUpClient, channel: string, oldestSec: number): Promise<SlackHistoryMessage[]> {
  const out: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const res = await client.conversations.history({ channel, oldest: oldestSec.toFixed(6), limit: HISTORY_PAGE, cursor });
    out.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** The whole thread, paged oldest-first. Slack returns replies oldest-first, so a
 *  single page of a long thread would drop exactly the newest — in-window —
 *  messages; the full thread is also what `threadIncludesBot` / `botRepliedAfter`
 *  need to judge participation. */
async function fetchReplies(client: CatchUpClient, channel: string, ts: string): Promise<SlackHistoryMessage[]> {
  const out: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_REPLIES_PAGES; page++) {
    const res = await client.conversations.replies({ channel, ts, limit: REPLIES_LIMIT, cursor });
    out.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
