import { LIVE_CARD_PREFIXES } from "../core/dispatcher.js";
import type { StatusUpdate } from "../core/types.js";
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
//
// The same scan sweeps ORPHANED STATUS CARDS (features/slack-channel.md item
// 8): a card still showing a live glyph whose process is gone — a deploy
// rollout killed the container before its drain finished (live 2026-08-29
// 23:51Z: PR #214's review card froze at "153s — thinking" for good, and the
// run vanished from /runs). The card is the only durable trace of that run, so
// the next connect closes it as interrupted with what to do. Cards this
// process owns are never touched — a websocket reconnect without a restart
// must not close a running run's card.

/** Bot's acceptance reaction — must match the one `handle()` adds. */
export const ACK_EMOJI = "eyes";

/** A live card younger than this is an orphan candidate. Wider than the
 *  mention window: a long run's card was posted at run START, and the thread
 *  may have had no new message since; anything older is a run that would have
 *  hit the 15 min drain deadline anyway or a card from a much earlier era —
 *  left alone rather than mislabeled. */
export const ORPHAN_CARD_WINDOW_MS = 2 * 3_600_000;

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

/** A status card the bot posted whose run is no longer running anywhere. */
export interface OrphanedCard {
  channel: string;
  ts: string;
  /** The card's current text (Slack history form: mrkdwn, entities escaped). */
  text: string;
}

export interface FindOrphanedInput {
  channel: string;
  botUserId: string;
  /** Cards posted at or after this instant are candidates (epoch ms). */
  cutoffMs: number;
  /** Full replies (parent first) per thread, by parent ts. */
  threads: Map<string, SlackHistoryMessage[]>;
  /** Does THIS process currently own the live card (channel, ts)? Those are running, not orphaned. */
  ownedHere: (channel: string, ts: string) => boolean;
}

/** Pure selection: the bot's own cards still wearing a live glyph, inside the
 *  window, not owned by this process. Bot-authored only — a human can type a
 *  spinner too. */
export function findOrphanedCards(input: FindOrphanedInput): OrphanedCard[] {
  const { channel, botUserId, cutoffMs, ownedHere } = input;
  const out: OrphanedCard[] = [];
  for (const thread of input.threads.values()) {
    for (const m of thread) {
      if (typeof m.ts !== "string" || tsMs(m.ts) < cutoffMs) continue;
      if (!isFromBot(m, botUserId)) continue;
      const text = m.text ?? "";
      if (!LIVE_CARD_PREFIXES.some((p) => text.startsWith(p))) continue;
      if (ownedHere(channel, m.ts)) continue;
      out.push({ channel, ts: m.ts, text });
    }
  }
  return out;
}

const THINKING_SUFFIX = / — thinking \(\d+s since last tool\)$/u;
const LIVE_GLYPH_PREFIX = new RegExp(`^(?:${LIVE_CARD_PREFIXES.map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*`, "u");

/** The closed frame for an orphaned card: the run label and elapsed time it
 *  reached are kept (they are the only record of how far it got), the spinner
 *  and the transient "thinking" suffix go, and the detail says what happened
 *  and what to do. History text comes back mrkdwn-escaped; un-escape so the
 *  adapter's render() does not double-escape `&amp;` → `&amp;amp;`. */
export function interruptedCardFrame(cardText: string): StatusUpdate {
  // `&amp;` last, so a literal `&amp;lt;` in the label un-escapes once (to `&lt;`), not twice.
  const label = cardText
    .replace(LIVE_GLYPH_PREFIX, "")
    .replace(THINKING_SUFFIX, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
  return {
    title: `❌ interrupted · ${label}`,
    detail: "The bot restarted (a deploy) while this run was in flight, so the run was lost and this card stopped updating. Re-send your request to run it again.",
  };
}

export interface CatchUpOptions {
  client: CatchUpClient;
  botUserId: string;
  alreadyHandled: (channel: string, ts: string) => boolean;
  /** Called once per missed message, oldest first, awaited; a rejection is logged and skipped. */
  onMissed: (m: MissedMessage) => void | Promise<void>;
  /** Orphaned-card sweep — both must be given to turn it on. `ownedHere`: does
   *  this process own the live card (channel, ts)? `onOrphanedCard`: close the
   *  card with the given frame (the adapter's `chat.update`); awaited, a
   *  rejection is logged and the sweep continues. */
  ownedHere?: (channel: string, ts: string) => boolean;
  onOrphanedCard?: (card: OrphanedCard, frame: StatusUpdate) => void | Promise<void>;
  now?: number;
  windowMs?: number;
  orphanWindowMs?: number;
  parentLookbackMs?: number;
  log?: (line: string) => void;
}

/** Scan every channel the bot is a member of: re-dispatch what it missed and
 *  close the status cards a dead process left spinning.
 *  Never throws: per-channel API failures are logged and that channel skipped,
 *  so one bad channel cannot block catch-up of the others or the connect. */
export async function catchUpMissedMentions(opts: CatchUpOptions): Promise<{ channels: number; missed: number; orphans: number }> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const lookbackMs = opts.parentLookbackMs ?? DEFAULT_PARENT_LOOKBACK_MS;
  const log = opts.log ?? ((line) => console.log(line));
  const cutoffMs = now - windowMs;
  const sweep = opts.ownedHere && opts.onOrphanedCard ? { ownedHere: opts.ownedHere, close: opts.onOrphanedCard } : undefined;
  const orphanCutoffMs = now - (opts.orphanWindowMs ?? ORPHAN_CARD_WINDOW_MS);
  // Threads are fetched once for both jobs: active since the EARLIER cutoff.
  const threadCutoffMs = sweep ? Math.min(cutoffMs, orphanCutoffMs) : cutoffMs;
  const { client, botUserId } = opts;

  let channels: string[] = [];
  try {
    channels = await listChannels(client);
  } catch (err) {
    log(`[catch-up] cannot list channels: ${errMsg(err)}`);
    return { channels: 0, missed: 0, orphans: 0 };
  }

  let missed = 0;
  let orphans = 0;
  for (const channel of channels) {
    let found: MissedMessage[];
    let orphaned: OrphanedCard[] = [];
    try {
      const parents = await fetchParents(client, channel, (now - lookbackMs) / 1000);
      const threads = new Map<string, SlackHistoryMessage[]>();
      for (const p of parents) {
        if (!p.ts || !p.latest_reply || (p.reply_count ?? 0) === 0 || tsMs(p.latest_reply) < threadCutoffMs) continue;
        threads.set(p.ts, await fetchReplies(client, channel, p.ts));
      }
      found = findMissed({ channel, botUserId, cutoffMs, parents, threads, alreadyHandled: opts.alreadyHandled });
      if (sweep) orphaned = findOrphanedCards({ channel, botUserId, cutoffMs: orphanCutoffMs, threads, ownedHere: sweep.ownedHere });
    } catch (err) {
      log(`[catch-up] ${channel}: scan failed, skipped: ${errMsg(err)}`);
      continue;
    }
    if (sweep && orphaned.length > 0) {
      // Counted per successful close, so the summary never claims a card the
      // update failed on; each failure is logged by itself.
      let closed = 0;
      for (const card of orphaned) {
        try {
          await sweep.close(card, interruptedCardFrame(card.text));
          closed++;
        } catch (err) {
          log(`[catch-up] ${channel}:${card.ts}: closing orphaned card failed: ${errMsg(err)}`);
        }
      }
      orphans += closed;
      log(`[catch-up] ${channel}: ${closed} of ${orphaned.length} orphaned status card(s) closed as interrupted (ts ${orphaned.map((c) => c.ts).join(", ")})`);
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
  log(`[catch-up] scanned ${channels.length} channel(s): ${missed} missed message(s), ${orphans} orphaned card(s)`);
  return { channels: channels.length, missed, orphans };
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
