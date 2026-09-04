import { STATIC_CHANNEL_DIRECTORY } from "../core/authz/channelDirectory.js";
import type { ChannelDirectory, ChannelVisibility } from "../core/authz/types.js";

// The Slack `ChannelDirectory` (authorization plan R10, KTD4, U5): the adapter
// fact the static id mapping cannot supply — whether a `slack:C…` (or `G…`)
// channel is public or private — asked of `conversations.info` once per
// channel per TTL and stamped on every run dispatched there (KTD7), so a run in
// a public channel is readable by everyone (`member-of`'s public half) while a
// private channel or DM stays grants-only. `authorize` never calls this: it
// reads the stamp.
//
// Fail-closed (R7): any failure — an API error, a missing scope, an empty reply
// — is `unknown`, never a guess, and is remembered for the TTL so a failing
// channel costs one Slack call and one log line per window, not one per
// message. A `slack:D…` id is a DM by construction and never reaches the API
// (no `im:read` needed); non-Slack ids are the static directory's answer.
//
// Group DMs (`is_mpim`) are `dm`: the conversation is private to its members
// like a DM, and the memory write gate narrows an org fact from either to the
// requesting user's own scope — a group DM has no shared channel audience the
// org would otherwise be narrowed to. Membership (`isMember`) is NOT
// enumerated in this cut: the seam answers `unknown` (not a member) until
// `conversations.members` lands behind it — features/authorization.md [gap].

/** Default time a channel's visibility is served from the cache. Channels
 *  rarely flip public ↔ private; a stale window of minutes is accepted and
 *  documented (KTD4). A stale-DENY is impossible: `unknown` denies. */
export const CHANNEL_INFO_TTL_MS = 10 * 60_000;
/** Bound on cached channels, FIFO like the adapter's name caches. */
export const CHANNEL_INFO_CACHE_MAX = 1000;

/** The one Web API method the directory needs; `app.client` satisfies it. */
export interface ConversationInfoClient {
  conversations: {
    info(args: { channel: string }): Promise<{ channel?: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean } }>;
  };
}

export interface SlackChannelDirectoryOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Where a failed lookup is reported (once per channel per TTL). Default: `console.warn`. */
  warn?: (message: string) => void;
  /** Answers for ids the Slack API cannot describe (non-`slack:` ids, DMs, membership). */
  fallback?: ChannelDirectory;
}

const SLACK_PREFIX = "slack:";

/** What `conversations.info` says a channel is: a DM or group DM → `dm`, else private or public. */
function visibilityOfInfo(channel: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean }): ChannelVisibility {
  if (channel.is_im || channel.is_mpim) return "dm";
  return channel.is_private ? "private" : "public";
}

export class SlackChannelDirectory implements ChannelDirectory {
  private readonly cache = new Map<string, { visibility: ChannelVisibility; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<{ visibility: ChannelVisibility }>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly fallback: ChannelDirectory;

  constructor(
    private readonly client: ConversationInfoClient,
    options: SlackChannelDirectoryOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? CHANNEL_INFO_TTL_MS;
    this.maxEntries = options.maxEntries ?? CHANNEL_INFO_CACHE_MAX;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((m) => console.warn(m));
    this.fallback = options.fallback ?? STATIC_CHANNEL_DIRECTORY;
  }

  async info(channelId: string): Promise<{ visibility: ChannelVisibility }> {
    // Only a Slack channel or group needs the API: a DM's id already says `dm`,
    // and a non-Slack id is not this adapter's to describe.
    if (!channelId.startsWith(SLACK_PREFIX) || channelId.startsWith(`${SLACK_PREFIX}D`)) return this.fallback.info(channelId);
    const hit = this.cache.get(channelId);
    if (hit && hit.expiresAt > this.now()) return { visibility: hit.visibility };
    const pending = this.inFlight.get(channelId);
    if (pending) return pending;
    const lookup = this.lookup(channelId).finally(() => this.inFlight.delete(channelId));
    this.inFlight.set(channelId, lookup);
    return lookup;
  }

  /** Membership is not enumerated yet: the fallback's `unknown` — not a member (R7). */
  isMember(actorId: string, channelId: string): Promise<boolean | "unknown"> {
    return this.fallback.isMember(actorId, channelId);
  }

  private async lookup(channelId: string): Promise<{ visibility: ChannelVisibility }> {
    let visibility: ChannelVisibility = "unknown";
    try {
      const res = await this.client.conversations.info({ channel: channelId.slice(SLACK_PREFIX.length) });
      if (res.channel) visibility = visibilityOfInfo(res.channel);
      else this.warn(`[authz] conversations.info returned no channel for ${channelId} — treating it as unknown (grants-only) for ${this.ttlMs} ms`);
    } catch (err) {
      this.warn(`[authz] conversations.info failed for ${channelId} — treating it as unknown (grants-only) for ${this.ttlMs} ms: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.remember(channelId, visibility);
    return { visibility };
  }

  private remember(channelId: string, visibility: ChannelVisibility): void {
    this.cache.set(channelId, { visibility, expiresAt: this.now() + this.ttlMs });
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
