import { humanizeMessageText } from "../../core/dispatch/reply.js";
import type {
  ConversationClassification,
  ConversationReader,
  ConversationRef,
  ReferencedConversation,
  ReferencedMessage,
} from "../../core/references/types.js";
import { resolveTeamUrl, resolveUserName } from "./lookups.js";
import { threadTurns } from "./threadTurns.js";

// The Slack conversation reader (record 0037, the adapter contract): what the
// core's references step needs from Slack and nothing else. The URL grammar
// recognises this workspace's host alone (channel ids are per-workspace and
// look alike, so a link into another workspace must stay plain text); the
// classifier is one fresh `conversations.info` per call under a short cache,
// answering `never` for everything it cannot affirmatively place — a shared or
// external channel, a DM, a missing channel, an error; the fetch is text only
// and keeps the newest messages; the requester's standing is `users.info`'s
// guest flags. No new scope: `channels:history`, `groups:history`,
// `channels:read`, `groups:read` and `users:read` are already required.

/** How long one classification is served from the reader's own cache. Short
 *  on purpose: the directory's ten-minute cache is fail-open for a read (a
 *  channel flipped private reads public until it expires); thirty seconds is
 *  the stale-allow window the record accepts. */
export const CLASSIFY_CACHE_MS = 30_000;

/** One `conversations.replies` page covers any thread under this many replies;
 *  the reader keeps the newest of them under the caller's caps. */
const REPLIES_PAGE = 1000;

/** The slice of the Slack Web API the reader uses — structural, so a test fake satisfies it. */
export interface ReferenceClient {
  auth: { test(): Promise<{ url?: string }> };
  conversations: {
    info(args: { channel: string }): Promise<{
      channel?: {
        id?: string;
        name?: string;
        is_private?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_shared?: boolean;
        is_ext_shared?: boolean;
        is_org_shared?: boolean;
        is_pending_ext_shared?: boolean;
        is_member?: boolean;
      };
    }>;
    replies(args: {
      channel: string;
      ts: string;
      limit: number;
    }): Promise<{ messages?: { user?: string; bot_id?: string; text?: string; ts?: string }[] }>;
  };
  users: {
    info(args: { user: string }): Promise<{
      user?: {
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string; email?: string };
        is_restricted?: boolean;
        is_ultra_restricted?: boolean;
      };
    }>;
  };
}

const SLACK = "slack";
/** `p<16 digits>`: Slack's permalink ts, the message ts without its dot. */
const PERMALINK_TS = /^p(\d{10})(\d{6})$/;
const THREAD_TS = /^\d{10}\.\d{6}$/;

export class SlackConversationReader implements ConversationReader {
  readonly platform = SLACK;
  private host: string | undefined;
  private readonly readyP: Promise<void>;
  private readonly cache = new Map<string, { at: number; answer: ConversationClassification }>();

  constructor(
    private readonly client: ReferenceClient,
    private readonly now: () => number = Date.now,
  ) {
    // The host is this workspace's `auth.test` URL, read once per process
    // (`resolveTeamUrl`'s memo). Until it is known nothing parses: a guess
    // about which host is ours would be exactly the cross-workspace confusion
    // the grammar exists to refuse.
    this.readyP = resolveTeamUrl(client).then((url) => {
      if (url) this.host = new URL(url).host;
    });
  }

  /** Resolves once the workspace host is known (or known to be unreadable). */
  ready(): Promise<void> {
    return this.readyP;
  }

  parseConversationUrl(url: string): ConversationRef | undefined {
    if (!this.host) return undefined;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (u.protocol !== "https:" || u.host !== this.host) return undefined;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0] !== "archives") return undefined;
    const channel = parts[1];
    if (!/^[CGD][A-Z0-9_]+$/.test(channel)) return undefined;
    const m = PERMALINK_TS.exec(parts[2]);
    if (!m) return undefined;
    const messageTs = `${m[1]}.${m[2]}`;
    const threadTs = u.searchParams.get("thread_ts");
    const channelId = `${SLACK}:${channel}`;
    if (threadTs !== null) {
      if (!THREAD_TS.test(threadTs)) return undefined;
      // A reply's permalink names its thread: the whole thread is the reference.
      return { channelId, threadKey: `${channelId}:${threadTs}`, url };
    }
    // A bare permalink names one message. It may be a thread's parent (then
    // the thread is read) or a lone message (then that message alone).
    return { channelId, threadKey: `${channelId}:${messageTs}`, messageId: messageTs, url };
  }

  async classifyConversation(ref: ConversationRef): Promise<ConversationClassification> {
    const channel = ref.channelId.slice(SLACK.length + 1);
    const hit = this.cache.get(channel);
    if (hit && this.now() - hit.at < CLASSIFY_CACHE_MS) return hit.answer;
    let answer: ConversationClassification;
    try {
      const c = (await this.client.conversations.info({ channel })).channel;
      if (!c) return NEVER;
      // Everything the record says is never quotable across channels: a DM or
      // group DM, and a channel shared with another workspace in any state.
      if (c.is_im || c.is_mpim || c.is_shared || c.is_ext_shared || c.is_org_shared || c.is_pending_ext_shared) {
        return NEVER;
      }
      answer = {
        visibility: c.is_private ? "private" : "public",
        botIsMember: c.is_member === true,
        ...(c.name ? { channelName: c.name } : {}),
      };
    } catch {
      // A failure is `never` and is not cached, so a transient error costs one refusal, not thirty seconds of them.
      return NEVER;
    }
    this.cache.set(channel, { at: this.now(), answer });
    return answer;
  }

  async readConversation(
    ref: ConversationRef,
    caps: { maxMessages: number; maxBytes: number },
  ): Promise<ReferencedConversation> {
    const channel = ref.channelId.slice(SLACK.length + 1);
    const threadTs = ref.threadKey.slice(ref.channelId.length + 1);
    const [page, cls] = await Promise.all([
      this.client.conversations.replies({ channel, ts: threadTs, limit: REPLIES_PAGE }),
      this.classifyConversation(ref),
    ]);
    // The same mapping the current thread is read with: status cards dropped,
    // an empty message dropped, the author ids kept. No skip ts — a linked
    // thread has no triggering message — and no bot mention to strip.
    let turns = threadTurns(page.messages ?? [], {});
    // A bare permalink to a thread's own parent reads the thread; to a reply
    // or a lone message, exactly that message by its `ts` — and a permalink to
    // a message the mapping dropped (a status card) quotes nothing, never the
    // thread the link did not name.
    if (ref.messageId !== undefined && ref.messageId !== threadTs) turns = turns.filter((t) => t.ts === ref.messageId);
    // Newest kept: the parent stays, the newest replies fill the rest.
    if (turns.length > caps.maxMessages) turns = [turns[0], ...turns.slice(turns.length - (caps.maxMessages - 1))];
    const messages: ReferencedMessage[] = [];
    for (const t of turns) {
      const author = t.botId
        ? "app"
        : ((t.user && (await resolveUserName(this.client, t.user))) ?? t.user ?? "unknown");
      messages.push({ ...(t.at !== undefined ? { at: t.at } : {}), author, text: humanizeMessageText(t.text) });
    }
    return {
      kind: "reference",
      ref,
      channelName: cls.channelName ?? channel,
      permalink: ref.url,
      messages,
    };
  }

  async requesterIsFullMember(userId: string): Promise<boolean> {
    const user = userId.startsWith(`${SLACK}:`) ? userId.slice(SLACK.length + 1) : userId;
    try {
      const u = (await this.client.users.info({ user })).user;
      if (!u) return false;
      return u.is_restricted !== true && u.is_ultra_restricted !== true;
    } catch {
      return false;
    }
  }
}

const NEVER: ConversationClassification = Object.freeze({ visibility: "never", botIsMember: false });
