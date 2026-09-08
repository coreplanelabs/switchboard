import { describe, expect, it } from "vitest";
import { FakeSlack, TokenBucket } from "./fakeSlack.js";

// `load:cards` (docs/reference/specs/load-harness.md item 7) measures the status-card path
// against Slack's published limits without touching Slack: `chat.update` is a
// Tier 3 method (~50 calls a minute per app) and the coalescer's own comment
// cites ~1 edit per second per channel. This fake enforces both, answers
// `ratelimited` with a Retry-After like the real API, and records how long each
// card frame waited from production to acceptance — the lag D10 bounds.

describe("TokenBucket", () => {
  it("allows `capacity` takes at once, then refuses with the seconds until the next token", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => t });
    expect(b.tryTake()).toEqual({ ok: true });
    expect(b.tryTake()).toEqual({ ok: true });
    expect(b.tryTake()).toEqual({ ok: false, retryAfterS: 1 });
    t = 1_000;
    expect(b.tryTake()).toEqual({ ok: true });
  });

  it("refill never exceeds capacity after a long idle", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 10, now: () => t });
    t = 60_000;
    expect(b.tryTake().ok).toBe(true);
    expect(b.tryTake().ok).toBe(true);
    expect(b.tryTake().ok).toBe(false);
  });
});

describe("FakeSlack — chat.postMessage / chat.update / conversations.replies", () => {
  it("postMessage answers ok with a ts and the channel; update on that ts answers ok and records the frame", () => {
    let t = 0;
    const slack = new FakeSlack({ now: () => t });
    const posted = slack.postMessage({ channel: "C1", thread_ts: "1.0", text: "⏳ starting" });
    expect(posted).toEqual({ ok: true, channel: "C1", ts: expect.any(String) });
    if (!posted.ok) throw new Error("unreachable");
    t = 500;
    const updated = slack.update({ channel: "C1", ts: posted.ts, text: "⚡ step 1", frameAt: 100 });
    expect(updated).toEqual({ ok: true, channel: "C1", ts: posted.ts });
    expect(slack.stats().updates).toBe(1);
    expect(slack.stats().lagMs.max).toBe(400);
  });

  it("update on an unknown ts answers the API's message_not_found error", () => {
    const slack = new FakeSlack({ now: () => 0 });
    expect(slack.update({ channel: "C1", ts: "9.9", text: "x", frameAt: 0 })).toEqual({
      ok: false,
      error: "message_not_found",
    });
  });

  it("the per-channel limit refuses the second edit in the same second with ratelimited + retryAfterS", () => {
    let t = 0;
    const slack = new FakeSlack({ now: () => t, perChannelPerSecond: 1, perAppPerMinute: 1_000 });
    const a = slack.postMessage({ channel: "C1", thread_ts: "1.0", text: "a" });
    const b = slack.postMessage({ channel: "C1", thread_ts: "2.0", text: "b" });
    if (!a.ok || !b.ok) throw new Error("unreachable");
    t = 5_000;
    expect(slack.update({ channel: "C1", ts: a.ts, text: "a2", frameAt: t }).ok).toBe(true);
    const refused = slack.update({ channel: "C1", ts: b.ts, text: "b2", frameAt: t });
    expect(refused).toEqual({ ok: false, error: "ratelimited", retryAfterS: 1 });
    expect(slack.stats().ratelimited).toBe(1);
    t = 6_000;
    expect(slack.update({ channel: "C1", ts: b.ts, text: "b2", frameAt: 5_000 }).ok).toBe(true);
    // The refused frame's lag counts from when it was produced, not from the retry.
    expect(slack.stats().lagMs.max).toBe(1_000);
  });

  it("the per-app limit spans channels: the 51st update in a minute is refused even on a fresh channel", () => {
    let t = 0;
    const slack = new FakeSlack({ now: () => t, perAppPerMinute: 50, perChannelPerSecond: 1_000 });
    const cards: string[] = [];
    for (let i = 0; i < 51; i++) {
      const p = slack.postMessage({ channel: `C${i}`, thread_ts: "1.0", text: "x" });
      if (p.ok) cards.push(p.ts);
    }
    // postMessage does not draw from the update budget.
    let refused = 0;
    for (let i = 0; i < 51; i++) {
      t += 10;
      const r = slack.update({ channel: `C${i}`, ts: cards[i], text: "y", frameAt: t });
      if (!r.ok && r.error === "ratelimited") refused++;
    }
    expect(refused).toBe(1);
  });

  it("replies returns the thread's posted messages oldest-first, as the catch-up scan expects", () => {
    const slack = new FakeSlack({ now: () => 0 });
    slack.postMessage({ channel: "C1", thread_ts: "1.0", text: "first" });
    slack.postMessage({ channel: "C1", thread_ts: "1.0", text: "second" });
    slack.postMessage({ channel: "C1", thread_ts: "2.0", text: "other thread" });
    const r = slack.replies({ channel: "C1", ts: "1.0" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("stats carry posts, updates, ratelimited, distinct cards, and the lag percentiles", () => {
    let t = 0;
    const slack = new FakeSlack({ now: () => t });
    const p = slack.postMessage({ channel: "C1", thread_ts: "1.0", text: "a" });
    if (!p.ok) throw new Error("unreachable");
    for (const lag of [100, 200, 300]) {
      t += 5_000;
      slack.update({ channel: "C1", ts: p.ts, text: `f${lag}`, frameAt: t - lag });
    }
    expect(slack.stats()).toEqual({
      posts: 1,
      updates: 3,
      ratelimited: 0,
      cards: 1,
      lagMs: { p50: 200, p95: 300, p99: 300, max: 300 },
    });
  });
});
