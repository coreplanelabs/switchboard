// One status-card edit budget for the whole process (docs/reference/specs/run-visibility.md
// item 8). Slack rates `chat.update` per app, not per card: N live runs each
// editing a card every few seconds share ONE allowance of about 50 edits a
// minute, and past it every edit is a 429 whose retry pauses the client's
// whole queue. The budget is a token bucket at that published rate, with three
// rules on top:
//
// - Progress frames (heartbeats, tool lines) draw from it only while a reserve
//   is left, only up to each card's FAIR SHARE — the progress rate split across
//   the live cards — so a card that ticks after its siblings still paints, and
//   at most one per channel per second (the per-channel limit the coalescer
//   cites); a refused frame is dropped (the next heartbeat repaints anyway).
// - Terminal frames (the done close) RESERVE a slot: taken now when a token is
//   left and the channel is free, otherwise the bucket goes negative, the
//   channel's next free second is booked, and the caller is told how long
//   until the reservation is funded. Progress frames yield until the bucket is
//   back above the reserve, so the frame a reader waits for is never the one
//   the budget refuses and never collides with a sibling's.
//
// Only the Slack status handle draws from it; the no-op handles (HTTP, MCP,
// CLI) never do.

/** Slack's published `chat.update` allowance per app (Tier 3, about 50 a minute) — the process budget's rate. */
export const STATUS_EDITS_PER_MINUTE = 50;

/** The floor between two edits in one channel (the ~1 a second per channel the coalescer cites). */
export const STATUS_EDIT_CHANNEL_SPACING_MS = 1_000;

/** A live card asks for a token at least every heartbeat (5 s); one silent for this long is swept from the share. */
export const LIVE_CARD_WINDOW_MS = 60_000;

/** How many times a rate-limited terminal frame is re-sent (each after Slack's Retry-After) before it is given up. */
export const TERMINAL_RESENDS = 10;

export interface StatusBudget {
  /** A card came live: it shares the progress rate from here on. */
  open(card: string): void;
  /** The card closed: its share returns to the others. (A card whose run died
   *  without closing is swept once it has not asked for `LIVE_CARD_WINDOW_MS`.) */
  close(card: string): void;
  /** A progress frame for `card` in `channel` asks for a token. `false` when
   *  only the terminal reserve is left, the card painted within its fair share,
   *  or the channel was edited within the spacing: drop the frame. */
  tryProgress(card: string, channel: string): boolean;
  /** A terminal frame in `channel` reserves a slot. `0`: taken now, send at
   *  once. Otherwise the milliseconds until the reservation is funded: send then. */
  takeTerminal(channel: string): number;
  /** Tokens available now, after refill; negative while terminal reservations are outstanding (diagnostics). */
  tokens(): number;
}

export interface StatusBudgetOptions {
  /** The rate: Slack's published `chat.update` allowance per app. Also the burst capacity. */
  perMinute: number;
  /** Tokens progress frames must leave for terminal frames (default a fifth of the rate). */
  reserve?: number;
  /** Floor between two edits in one channel (default `STATUS_EDIT_CHANNEL_SPACING_MS`). */
  channelSpacingMs?: number;
  now?: () => number;
}

export function createStatusBudget(opts: StatusBudgetOptions): StatusBudget {
  const now = opts.now ?? Date.now;
  const capacity = opts.perMinute;
  const reserve = opts.reserve ?? Math.ceil(opts.perMinute / 5);
  const spacing = opts.channelSpacingMs ?? STATUS_EDIT_CHANNEL_SPACING_MS;
  const perMs = opts.perMinute / 60_000;
  const progressPerMs = (opts.perMinute - reserve) / 60_000;
  let tokens = capacity;
  let refilledAt = now();
  /** Live cards → when each last painted a progress frame, and when it last
   *  asked. A live card asks at least every heartbeat; one that has not asked
   *  within `LIVE_CARD_WINDOW_MS` belongs to a run that died without `close`
   *  and is swept out, so a leaked card never widens the others' share for good. */
  const live = new Map<string, { painted: number; asked: number }>();
  /** Channel → when it was (or is booked to be) last edited. */
  const channelEditedAt = new Map<string, number>();

  const refill = () => {
    const t = now();
    // A clock that steps backwards credits nothing now and nothing again when it
    // recovers: the high-water mark stays, so an interval is only ever credited once.
    if (t <= refilledAt) return;
    tokens = Math.min(capacity, tokens + (t - refilledAt) * perMs);
    refilledAt = t;
  };
  const sweep = (t: number) => {
    for (const [card, c] of live) if (t - c.asked > LIVE_CARD_WINDOW_MS) live.delete(card);
  };
  /** One progress edit per card per this long keeps N cards inside the progress rate together. */
  const fairIntervalMs = () => Math.max(1, live.size) / progressPerMs;

  return {
    open(card) {
      if (!live.has(card)) live.set(card, { painted: -Infinity, asked: now() });
    },
    close(card) {
      live.delete(card);
    },
    tryProgress(card, channel) {
      refill();
      const t = now();
      const c = live.get(card);
      if (c) c.asked = t;
      sweep(t);
      if (tokens - 1 < reserve) return false;
      if (c && t - c.painted < fairIntervalMs()) return false;
      const channelLast = channelEditedAt.get(channel);
      if (channelLast !== undefined && t - channelLast < spacing) return false;
      tokens -= 1;
      if (c) c.painted = t;
      channelEditedAt.set(channel, t);
      return true;
    },
    takeTerminal(channel) {
      refill();
      tokens -= 1;
      const t = now();
      const tokenAt = tokens >= 0 ? t : t + Math.ceil(-tokens / perMs);
      const channelLast = channelEditedAt.get(channel);
      const channelAt = channelLast === undefined ? t : Math.max(t, channelLast + spacing);
      const at = Math.max(tokenAt, channelAt);
      channelEditedAt.set(channel, at);
      return at - t;
    },
    tokens() {
      refill();
      return tokens;
    },
  };
}
