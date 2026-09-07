// A Slack Web API stand-in for `load:cards`: `chat.postMessage`, `chat.update`
// and `conversations.replies` with Slack's published limits enforced — the
// Tier 3 per-app budget for `chat.update` (~50 a minute) and the ~1 edit per
// second per channel the status coalescer's comment cites — answering
// `ratelimited` with a Retry-After like the real API, and recording how long
// each card frame waited from production to acceptance. In-process and
// clock-injected: the cards driver calls these methods directly.

import { percentile } from "./aggregate.js";

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(private readonly opts: { capacity: number; refillPerSecond: number; now: () => number }) {
    this.tokens = opts.capacity;
    this.lastRefillAt = opts.now();
  }

  tryTake(): { ok: true } | { ok: false; retryAfterS: number } {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    const deficit = 1 - this.tokens;
    return { ok: false, retryAfterS: Math.max(1, Math.ceil(deficit / this.opts.refillPerSecond)) };
  }

  private refill(): void {
    const now = this.opts.now();
    const elapsedS = Math.max(0, now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsedS * this.opts.refillPerSecond);
    this.lastRefillAt = now;
  }
}

export interface FakeSlackOptions {
  now?: () => number;
  /** `chat.update` budget per app (Slack Tier 3 ≈ 50/min). */
  perAppPerMinute?: number;
  /** `chat.update` budget per channel (the coalescer's ~1/s). */
  perChannelPerSecond?: number;
}

type Ok = { ok: true; channel: string; ts: string };
type Err = { ok: false; error: string; retryAfterS?: number };

interface Message {
  channel: string;
  ts: string;
  thread_ts?: string;
  text: string;
}

export interface FakeSlackStats {
  posts: number;
  updates: number;
  ratelimited: number;
  /** Distinct cards edited at least once. */
  cards: number;
  /** Frame lag: acceptance time minus the frame's production time, over accepted updates. */
  lagMs: { p50: number; p95: number; p99: number; max: number };
}

export class FakeSlack {
  private readonly now: () => number;
  private readonly app: TokenBucket;
  private readonly channels = new Map<string, TokenBucket>();
  private readonly perChannelPerSecond: number;
  private readonly messages = new Map<string, Message>();
  private seq = 0;
  private posts = 0;
  private updates = 0;
  private ratelimited = 0;
  private readonly edited = new Set<string>();
  private readonly lags: number[] = [];

  constructor(opts: FakeSlackOptions = {}) {
    this.now = opts.now ?? Date.now;
    const perMinute = opts.perAppPerMinute ?? 50;
    this.app = new TokenBucket({ capacity: perMinute, refillPerSecond: perMinute / 60, now: this.now });
    this.perChannelPerSecond = opts.perChannelPerSecond ?? 1;
  }

  postMessage(args: { channel: string; thread_ts?: string; text: string }): Ok | Err {
    this.posts++;
    this.seq++;
    const ts = `${Math.floor(this.now() / 1000)}.${String(this.seq).padStart(6, "0")}`;
    this.messages.set(key(args.channel, ts), { channel: args.channel, ts, thread_ts: args.thread_ts, text: args.text });
    return { ok: true, channel: args.channel, ts };
  }

  /** `frameAt`: when the caller produced this frame (epoch ms) — lag is measured from it. */
  update(args: { channel: string; ts: string; text: string; frameAt: number }): Ok | Err {
    const existing = this.messages.get(key(args.channel, args.ts));
    if (!existing) return { ok: false, error: "message_not_found" };
    const channelBucket = this.channelBucket(args.channel);
    const perChannel = channelBucket.tryTake();
    if (!perChannel.ok) {
      this.ratelimited++;
      return { ok: false, error: "ratelimited", retryAfterS: perChannel.retryAfterS };
    }
    const perApp = this.app.tryTake();
    if (!perApp.ok) {
      this.ratelimited++;
      return { ok: false, error: "ratelimited", retryAfterS: perApp.retryAfterS };
    }
    existing.text = args.text;
    this.updates++;
    this.edited.add(key(args.channel, args.ts));
    this.lags.push(Math.max(0, this.now() - args.frameAt));
    return { ok: true, channel: args.channel, ts: args.ts };
  }

  replies(args: { channel: string; ts: string }): { ok: true; messages: Message[] } {
    const list = [...this.messages.values()]
      .filter((m) => m.channel === args.channel && (m.thread_ts === args.ts || m.ts === args.ts))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return { ok: true, messages: list };
  }

  stats(): FakeSlackStats {
    const sorted = [...this.lags].sort((a, b) => a - b);
    return {
      posts: this.posts,
      updates: this.updates,
      ratelimited: this.ratelimited,
      cards: this.edited.size,
      lagMs: {
        p50: nanToZero(percentile(sorted, 50)),
        p99: nanToZero(percentile(sorted, 99)),
        p95: nanToZero(percentile(sorted, 95)),
        max: sorted.length ? sorted[sorted.length - 1] : 0,
      },
    };
  }

  private channelBucket(channel: string): TokenBucket {
    let b = this.channels.get(channel);
    if (!b) {
      b = new TokenBucket({
        capacity: this.perChannelPerSecond,
        refillPerSecond: this.perChannelPerSecond,
        now: this.now,
      });
      this.channels.set(channel, b);
    }
    return b;
  }
}

const key = (channel: string, ts: string) => `${channel}:${ts}`;
const nanToZero = (n: number) => (Number.isNaN(n) ? 0 : n);
