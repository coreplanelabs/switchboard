import { describe, expect, it } from "vitest";
import { simulateCards } from "./cardsLoad.js";

// `load:cards` (features/load-harness.md item 9): the real coalescer, the fake
// Slack limits, virtual time. One card is well-behaved; fifty cards at the
// dispatcher's cadence blow through the Tier 3 budget — the plan's second
// tipping point, as a number.

describe("simulateCards", () => {
  it("one card for a minute: every frame is accepted without a rate limit, lag stays under the coalescer floor, the terminal frame lands", () => {
    const out = simulateCards({ cards: 1, holdMs: 60_000 });
    expect(out.stats.cards).toBe(1);
    expect(out.stats.ratelimited).toBe(0);
    expect(out.retries).toBe(0);
    expect(out.terminalAccepted).toBe(1);
    // 11 heartbeats + 8 tool events + the terminal frame produced; coalescing sends fewer.
    expect(out.framesProduced).toBe(20);
    expect(out.stats.updates).toBeLessThan(out.framesProduced);
    expect(out.stats.updates).toBeGreaterThan(5);
    expect(out.stats.lagMs.p95).toBeLessThanOrEqual(3_000);
    expect(out.spanMs).toBeGreaterThanOrEqual(60_000);
  });

  it("fifty cards for ten minutes at the published limits: edits are refused, retries burn on stale frames, most cards starve, and terminal frames are LOST", () => {
    const out = simulateCards({ cards: 50, holdMs: 600_000, channels: 5 });
    // Retries are served first-come: the cards that got a token keep getting
    // it and the rest starve — under the limits not every card is ever edited.
    expect(out.stats.cards).toBeGreaterThan(0);
    expect(out.stats.cards).toBeLessThan(50);
    expect(out.stats.ratelimited).toBeGreaterThan(0);
    expect(out.retries).toBeGreaterThan(0);
    expect(out.staleDropped).toBeGreaterThan(0);
    // Lag is measured over ACCEPTED frames only, so starvation hides in it:
    // the surviving frames waited past the coalescer floor, but the headline
    // is the cards that never updated at all and the terminal frames lost.
    expect(out.stats.lagMs.p95).toBeGreaterThan(3_000);
    // The Slack adapter's `done` swallows a failed edit the same way; a card
    // whose terminal frame is refused past the retry budget stays a spinner
    // forever. This is the number the plan's status budget (D3) has to fix.
    expect(out.givenUp).toBeGreaterThan(0);
    expect(out.terminalAccepted).toBeLessThan(50);
  });

  it("with the limits lifted the same fifty cards see no refusals, sub-floor lag, and every terminal frame — the limit, not the coalescer, is the ceiling", () => {
    const out = simulateCards({
      cards: 50,
      holdMs: 600_000,
      channels: 5,
      perAppPerMinute: 1_000_000,
      perChannelPerSecond: 1_000_000,
    });
    expect(out.stats.ratelimited).toBe(0);
    expect(out.stats.lagMs.p95).toBeLessThanOrEqual(3_000);
    expect(out.terminalAccepted).toBe(50);
  });

  it("is deterministic: the same parameters give the same numbers", () => {
    const a = simulateCards({ cards: 8, holdMs: 120_000 });
    const b = simulateCards({ cards: 8, holdMs: 120_000 });
    expect(a).toEqual(b);
  });
});
