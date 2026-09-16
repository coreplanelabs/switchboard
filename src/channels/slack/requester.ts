// Who asked (docs/reference/specs/slack-channel.md item 13). A Slack message
// normally names its sender in `user`; a message an app posted has none — only
// a `bot_id` and the name the app chose. Those runs used to be billed to
// `slack:unknown`, and by September 2026 that was the largest "requester" in
// the history: every review a Claude Code session asked for from its own thread.
// The person is still findable, and finding them is the adapter's job, not
// the reader's: the request's requester is the human it was made for, resolved
// in this order —
//
//   1. the message's own `user` (a person typed it);
//   2. the relay footer an app appends when it posts for someone —
//      `Sent by Claude in <#C…|name> · <permalink|thread>` — whose permalink is
//      the person's own thread: its parent's `user` is the requester;
//   3. a bot's reply inside a thread a person started: that person;
//   4. the app itself, named (`slack:bot:<bot_id>`, the app's display name) —
//      never `unknown`.
//
// A resolved relay keeps the poster as `relayedBy`, so a record can say
// "alice, via Claude [fixing the build]" without lying about either.

import { RELAY_FOOTER_RE, type SlackThreadMessage } from "./threadTurns.js";

const PLATFORM = "slack";

/** The app that posted a message, as Slack names it (`bot_id`, then the
 *  `username` the app chose or its profile's name). */
export interface SlackPoster {
  botId?: string;
  name?: string;
}

/** Where a relayed request came from: the person's own conversation, and the
 *  person themselves when the footer names them (`on behalf of <@U…>`). */
export interface RelayFooter {
  channel: string;
  threadTs: string;
  onBehalfOf?: string;
}

/** The slice of a Slack Block Kit block the flattener reads: a section's text,
 *  a context block's elements, a rich_text block's nested runs (text, link, user). */
export interface SlackBlock {
  type?: string;
  text?: { type?: string; text?: string } | string;
  elements?: SlackBlock[];
  /** A rich_text `link` run's target — its text when it has no label. */
  url?: string;
  /** A rich_text `user` run's subject — rendered as the mention the message text carries. */
  user_id?: string;
}

/** Every text a message's blocks carry, one line per block. Slack puts an app's
 *  footer in a `context` block and leaves the message's `text` as the request
 *  alone, so the requester and the strippers must read the blocks too. A
 *  context block's elements are separate fragments and join with a space; a
 *  rich_text block's runs are one line and join as written. A run renders as
 *  the message text would: a `text` run as its text, a `link` run as its label
 *  or else its URL, a `user` run as `<@U…>`; unknown shapes contribute nothing. */
export function textOfBlocks(blocks: readonly SlackBlock[] | undefined): string {
  if (!blocks) return "";
  const lines: string[] = [];
  for (const b of blocks) {
    const parts: string[] = [];
    const walk = (e: SlackBlock): void => {
      if (typeof e.text === "string") parts.push(e.text);
      else if (e.text && typeof e.text.text === "string") parts.push(e.text.text);
      else if (typeof e.url === "string") parts.push(e.url);
      else if (typeof e.user_id === "string") parts.push(`<@${e.user_id}>`);
      for (const c of e.elements ?? []) walk(c);
    };
    walk(b);
    const line = parts.join(b.type === "context" ? " " : "").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/** A text reduced to the words a person reads: mentions dropped, a `<url|label>`
 *  link as its label, a bare `<url>` as the url, URL schemes dropped (Slack
 *  labels a bare link without its scheme), whitespace collapsed — so a block's
 *  rendering and the message's mrkdwn compare as the same words. */
function plainWordsOf(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, "$2")
    .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1")
    .replace(/https?:\/\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text the adapter reads a message by: its `text`, then the block lines
 *  that say something the text does not (the footer) — never the request a
 *  second time in the block's rendering. */
export function rawTextOf(text: string | undefined, blocks: readonly SlackBlock[] | undefined): string {
  const base = text ?? "";
  const fromBlocks = textOfBlocks(blocks);
  if (!fromBlocks) return base;
  const known = plainWordsOf(base);
  const extra = fromBlocks.split("\n").filter((line) => {
    const words = plainWordsOf(line);
    return words.length > 0 && !known.includes(words);
  });
  return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}

const PERMALINK_TS = /^p(\d{10})(\d{6})$/;
const THREAD_TS = /^\d{10}\.\d{6}$/;

/** The relay footer's source thread, or undefined when the text carries none
 *  (or one whose permalink does not parse — a footer is chrome, never trusted
 *  blindly). The permalink's `thread_ts` names the thread when the relayed
 *  message was a reply; a bare `p<ts>` is the thread's parent itself. Slack
 *  HTML-escapes `&` inside message text, so `&amp;` is unescaped first. */
export function parseRelayFooter(text: string): RelayFooter | undefined {
  const m = RELAY_FOOTER_RE.exec(text);
  if (!m) return undefined;
  let url: URL;
  try {
    url = new URL(m[3].replaceAll("&amp;", "&"));
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "archives" || !/^[CGD][A-Z0-9_]+$/.test(parts[1])) return undefined;
  const ts = PERMALINK_TS.exec(parts[2]);
  if (!ts) return undefined;
  const threadTs = url.searchParams.get("thread_ts") ?? `${ts[1]}.${ts[2]}`;
  if (!THREAD_TS.test(threadTs)) return undefined;
  return { channel: parts[1], threadTs, ...(m[2] ? { onBehalfOf: m[2] } : {}) };
}

/** How the requester was found — on the record's span for forensics, and so a
 *  test can say which rule fired. */
export type RequesterResolution = "message" | "relay-footer" | "thread-parent" | "bot";

export interface SlackRequester {
  /** Platform-namespaced (`slack:U…` for a person, `slack:bot:B…` for an app nobody could be found behind). */
  userId: string;
  /** The person's Slack user id when the requester is a person — the display-name lookup's input. */
  slackUserId?: string;
  /** A name the resolution already knows (an app's display name); a person's name is looked up by the caller. */
  userName?: string;
  /** The app that posted the message for the person, when it was not their own message — its display name. */
  relayedBy?: string;
  /** The same app as an actor id (`slack:bot:<bot_id>`), for authorization: the app acts on the person's behalf. */
  postedBy?: string;
  resolvedBy: RequesterResolution;
}

/** The slice of the Slack Web API the resolver reads — a thread's first message. */
export interface RequesterClient {
  conversations: {
    replies(args: { channel: string; ts: string; limit?: number }): Promise<{ messages?: SlackThreadMessage[] }>;
  };
}

export interface RequesterEvent {
  channel: string;
  ts: string;
  threadTs: string;
  user?: string;
  /** The raw text, footer included — the relay footer is read before the mention stripper removes it. */
  text: string;
  poster?: SlackPoster;
  /** The thread's page when the handler already fetched it (a follow-up); its first message is the parent. */
  thread?: SlackThreadMessage[];
}

// The person behind a relay thread, remembered: one Claude Code session posts
// many requests from one thread, and a thread's parent never changes author.
// Bounded FIFO like the name caches; a failed read is never cached.
const RELAY_CACHE_MAX = 1000;
const relayParentCache = new Map<string, string>();

function rememberParent(key: string, user: string): void {
  relayParentCache.set(key, user);
  if (relayParentCache.size > RELAY_CACHE_MAX) {
    const oldest = relayParentCache.keys().next().value;
    if (oldest !== undefined) relayParentCache.delete(oldest);
  }
}

/** Exported for tests: forgets every remembered relay parent. */
export function resetRelayParentCache(): void {
  relayParentCache.clear();
}

/** The person who posted a thread's parent message, when that parent is a
 *  person's (a `user`, no `bot_id`); undefined when the thread cannot be read
 *  or its parent is an app's. */
async function threadParentUser(
  client: RequesterClient,
  channel: string,
  threadTs: string,
  prefetched?: SlackThreadMessage[],
): Promise<string | undefined> {
  const key = `${channel}:${threadTs}`;
  const hit = relayParentCache.get(key);
  if (hit !== undefined) return hit;
  let parent: SlackThreadMessage | undefined = prefetched?.find((m) => m.ts === threadTs);
  if (!parent) {
    try {
      parent = (await client.conversations.replies({ channel, ts: threadTs, limit: 1 })).messages?.[0];
    } catch {
      return undefined;
    }
  }
  if (!parent || parent.ts !== threadTs || parent.bot_id || !parent.user) return undefined;
  rememberParent(key, parent.user);
  return parent.user;
}

const botActorId = (poster: SlackPoster | undefined): string => `${PLATFORM}:bot:${poster?.botId ?? "unknown"}`;

const personRequester = (user: string, resolvedBy: RequesterResolution, relay?: SlackPoster): SlackRequester => ({
  userId: `${PLATFORM}:${user}`,
  slackUserId: user,
  ...(relay !== undefined ? { relayedBy: relay.name ?? "an app", postedBy: botActorId(relay) } : {}),
  resolvedBy,
});

/** The requester of a Slack message, by the rules above. Never throws and never
 *  answers `unknown`: an app nobody can be found behind is the requester under
 *  its own name. */
export async function resolveSlackRequester(client: RequesterClient, ev: RequesterEvent): Promise<SlackRequester> {
  if (ev.user) return personRequester(ev.user, "message");
  const poster: SlackPoster = ev.poster ?? {};
  const relay = parseRelayFooter(ev.text);
  if (relay) {
    // The footer names the person outright on current posts; older posts name
    // only their thread, whose parent the person started.
    if (relay.onBehalfOf) return personRequester(relay.onBehalfOf, "relay-footer", poster);
    const user = await threadParentUser(client, relay.channel, relay.threadTs);
    if (user) return personRequester(user, "relay-footer", poster);
  }
  if (ev.threadTs !== ev.ts) {
    const user = await threadParentUser(client, ev.channel, ev.threadTs, ev.thread);
    if (user) return personRequester(user, "thread-parent", poster);
  }
  return {
    userId: botActorId(poster),
    ...(poster.name !== undefined ? { userName: poster.name } : {}),
    resolvedBy: "bot",
  };
}
