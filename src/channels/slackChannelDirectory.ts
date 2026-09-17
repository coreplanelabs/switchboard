import { STATIC_CHANNEL_DIRECTORY } from "../core/authz/channelDirectory.js";
import type { ChannelDirectory, ChannelVisibility } from "../core/authz/types.js";

// The Slack `ChannelDirectory`: the two adapter
// facts the static id mapping cannot supply. Visibility — whether a `slack:C…`
// (or `G…`) channel is public or private — asked of `conversations.info` once
// per channel per TTL and stamped on every run dispatched there, so a run in
// a public channel is readable by everyone (`member-of`'s public half) while a
// private channel or DM stays grants-only. Membership — which channels a
// person is in — asked of `users.conversations` once per person per TTL and
// put on the actor as `memberOf` when the actor is resolved. `authorize`
// never calls this: it reads the stamp and the actor.
//
// Fail-closed: any failure — an API error, a missing scope, an empty reply
// — is `unknown`, never a guess, and is remembered for the TTL so a failing
// channel costs one Slack call and one log line per window, not one per
// message. A `slack:D…` id is a DM by construction and never reaches the API
// (no `im:read` needed); non-Slack ids are the static directory's answer.
//
// Group DMs (`is_mpim`) are `dm`: the conversation is private to its members
// like a DM, and the memory write gate narrows an org fact from either to the
// requesting user's own scope — a group DM has no shared channel audience the
// org would otherwise be narrowed to.
//
// Membership is the other fact: `channelsOf(slack:U…)` asks
// `users.conversations` for the person — every public and private channel
// they are in THAT THE BOT IS ALSO IN (Slack answers for the token's own
// reach; a private channel the bot was never invited to is invisible, and no
// run was ever dispatched there), paged by cursor, cached per person for the
// same TTL, single-flight, bounded. Freshness is event-driven first: the bot
// (src/index.ts) forgets a person on `member_joined_channel` /
// `member_left_channel` and everyone on the events that move the bot's own
// reach (`channel_left`, `group_left`, archive, delete) and on every socket
// reconnect (events missed while the socket was down), so the TTL is the
// degraded path — what bounds a stale answer when an event never arrives. A
// stale-ALLOW after a member leaves lasts at most the TTL; a stale-DENY is
// impossible: `unknown` denies, and a fresh member's first read misses only
// until the join event lands (milliseconds) or the TTL runs out.

/** Default time a person's channel set is served from the cache: the bound on a
 *  missed membership event; the events above keep the cache fresh in practice. */
export const MEMBERSHIP_TTL_MS = 10 * 60_000;
/** `users.conversations` pages a person's channels 200 at a time (Slack's ceiling is 1000;
 *  200 keeps one page one round trip); more than this many pages is `unknown`, never a partial set
 *  presented as the whole. */
const MEMBERSHIP_PAGE_SIZE = 200;
const MEMBERSHIP_MAX_PAGES = 10;

/** Default time a channel's visibility is served from the cache. Channels
 *  rarely flip public ↔ private; a stale window of minutes is accepted and
 *  documented. A stale-DENY is impossible: `unknown` denies. */
export const CHANNEL_INFO_TTL_MS = 10 * 60_000;
/** Bound on cached channels, FIFO like the adapter's name caches. */
export const CHANNEL_INFO_CACHE_MAX = 1000;

/** The two Web API methods the directory needs; `app.client` satisfies both. */
export interface SlackDirectoryClient {
  conversations: {
    info(args: {
      channel: string;
    }): Promise<{ channel?: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean } }>;
  };
  users: {
    conversations(args: {
      user: string;
      types: string;
      exclude_archived: boolean;
      limit: number;
      cursor?: string;
    }): Promise<{ channels?: { id?: string }[]; response_metadata?: { next_cursor?: string } }>;
  };
}

export interface SlackChannelDirectoryOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Where a failed lookup is reported (once per channel per TTL). Default: `console.warn`. */
  warn?: (message: string) => void;
  /** Answers for ids the Slack API cannot describe (non-`slack:` ids, DMs, a non-Slack actor's membership). */
  fallback?: ChannelDirectory;
}

const SLACK_PREFIX = "slack:";
const SLACK_USER_PREFIX = `${SLACK_PREFIX}U`;

type Channels = ReadonlySet<string> | "unknown";

/** What `conversations.info` says a channel is: a DM or group DM → `dm`, else private or public. */
function visibilityOfInfo(channel: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean }): ChannelVisibility {
  if (channel.is_im || channel.is_mpim) return "dm";
  return channel.is_private ? "private" : "public";
}

export class SlackChannelDirectory implements ChannelDirectory {
  private readonly cache = new Map<string, { visibility: ChannelVisibility; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<{ visibility: ChannelVisibility }>>();
  /** A person's channels (`slack:U…` → the set), remembered for the TTL, FIFO-bounded like `cache`. */
  private readonly members = new Map<string, { channels: Channels; expiresAt: number }>();
  private readonly membersInFlight = new Map<string, Promise<Channels>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly fallback: ChannelDirectory;

  constructor(
    private readonly client: SlackDirectoryClient,
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
    if (!channelId.startsWith(SLACK_PREFIX) || channelId.startsWith(`${SLACK_PREFIX}D`))
      return this.fallback.info(channelId);
    const hit = this.cache.get(channelId);
    if (hit && hit.expiresAt > this.now()) return { visibility: hit.visibility };
    const pending = this.inFlight.get(channelId);
    if (pending) return pending;
    const lookup = this.lookup(channelId).finally(() => this.inFlight.delete(channelId));
    this.inFlight.set(channelId, lookup);
    return lookup;
  }

  /** In the channel, by the person's own channel set; a non-Slack actor is the fallback's answer. */
  async isMember(actorId: string, channelId: string): Promise<boolean | "unknown"> {
    if (!actorId.startsWith(SLACK_USER_PREFIX)) return this.fallback.isMember(actorId, channelId);
    const channels = await this.channelsOf(actorId);
    return channels === "unknown" ? "unknown" : channels.has(channelId);
  }

  /** Every channel the person is in that the bot can see: one paged
   *  `users.conversations` per person per TTL, concurrent first asks sharing one
   *  call; any failure is `unknown` for the TTL (one call, one `[authz]` line per
   *  window). Only a Slack person (`slack:U…`) is this adapter's to describe. */
  async channelsOf(actorId: string): Promise<Channels> {
    if (!actorId.startsWith(SLACK_USER_PREFIX)) return this.fallback.channelsOf(actorId);
    const hit = this.members.get(actorId);
    if (hit && hit.expiresAt > this.now()) return hit.channels;
    const pending = this.membersInFlight.get(actorId);
    if (pending) return pending;
    const lookup = this.lookupChannels(actorId).finally(() => this.membersInFlight.delete(actorId));
    this.membersInFlight.set(actorId, lookup);
    return lookup;
  }

  /** The person's cached channel set is stale: a membership event named them. The
   *  next ask goes to Slack. Nothing to forget is a no-op. */
  forgetMember(actorId: string): void {
    this.members.delete(actorId);
  }

  /** Every cached channel set is stale: the bot's own reach moved (it left, or a
   *  channel was archived or deleted) or the socket reconnected and events may
   *  have been missed. Visibility stays: a channel's kind did not move with it. */
  forgetAll(): void {
    this.members.clear();
  }

  private async lookup(channelId: string): Promise<{ visibility: ChannelVisibility }> {
    let visibility: ChannelVisibility = "unknown";
    try {
      const res = await this.client.conversations.info({ channel: channelId.slice(SLACK_PREFIX.length) });
      if (res.channel) visibility = visibilityOfInfo(res.channel);
      else
        this.warn(
          `[authz] conversations.info returned no channel for ${channelId} — treating it as unknown (grants-only) for ${this.ttlMs} ms`,
        );
    } catch (err) {
      this.warn(
        `[authz] conversations.info failed for ${channelId} — treating it as unknown (grants-only) for ${this.ttlMs} ms: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  private async lookupChannels(actorId: string): Promise<Channels> {
    const user = actorId.slice(SLACK_PREFIX.length);
    let channels: Channels = "unknown";
    try {
      const found = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (pages === MEMBERSHIP_MAX_PAGES) {
          this.warn(
            `[authz] users.conversations for ${actorId} ran past ${MEMBERSHIP_MAX_PAGES} pages — treating their membership as unknown (grants-only) for ${this.ttlMs} ms`,
          );
          found.clear();
          cursor = undefined;
          break;
        }
        const res = await this.client.users.conversations({
          user,
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: MEMBERSHIP_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        for (const channel of res.channels ?? []) if (channel.id) found.add(`${SLACK_PREFIX}${channel.id}`);
        cursor = res.response_metadata?.next_cursor || undefined;
        pages += 1;
      } while (cursor);
      if (pages < MEMBERSHIP_MAX_PAGES || found.size > 0) channels = found;
    } catch (err) {
      this.warn(
        `[authz] users.conversations failed for ${actorId} — treating their membership as unknown (grants-only) for ${this.ttlMs} ms: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.members.set(actorId, { channels, expiresAt: this.now() + this.ttlMs });
    if (this.members.size > this.maxEntries) {
      const oldest = this.members.keys().next().value;
      if (oldest !== undefined) this.members.delete(oldest);
    }
    return channels;
  }
}
