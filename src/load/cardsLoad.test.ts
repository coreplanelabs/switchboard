import { describe, expect, it } from "vitest";
import { simulateCards } from "./cardsLoad.js";

// `load:cards` (docs/reference/specs/load-harness.md item 9): the real coalescer, the real
// process budget, the fake Slack limits, virtual time. One card is well-behaved;
// fifty cards on the pre-budget client blow through the Tier 3 budget — the
// plan's second tipping point, as a number — and the same fifty on the shipped
// (budgeted) client never see a refusal and land every terminal frame.

describe("simulateCards", () => {
  it("one card for a minute: every frame is accepted without a rate limit, lag stays under the coalescer floor, the terminal frame lands", () => {
    const out = simulateCards({ cards: 1, holdMs: 60_000 });
    expect(out.client).toBe("budgeted");
    expect(out.stats.cards).toBe(1);
    expect(out.stats.ratelimited).toBe(0);
    expect(out.budgetDropped).toBe(0);
    expect(out.terminalAccepted).toBe(1);
    // 11 heartbeats + 8 tool events + the terminal frame produced; coalescing sends fewer.
    expect(out.framesProduced).toBe(20);
    expect(out.stats.updates).toBeLessThan(out.framesProduced);
    expect(out.stats.updates).toBeGreaterThan(5);
    expect(out.stats.lagMs.p95).toBeLessThanOrEqual(3_000);
    expect(out.spanMs).toBeGreaterThanOrEqual(60_000);
  });

  it("the pre-budget client, fifty cards for ten minutes at the published limits: edits are refused, retries burn on stale frames, most cards starve, and terminal frames are LOST", () => {
    const out = simulateCards({ cards: 50, holdMs: 600_000, channels: 5, client: "retrying" });
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
    // That adapter's `done` swallowed a failed edit; a card whose terminal
    // frame was refused past the retry budget stayed a spinner forever.
    expect(out.givenUp).toBeGreaterThan(0);
    expect(out.terminalAccepted).toBeLessThan(50);
  });

  it("the shipped (budgeted) client, the same fifty cards: Slack refuses nothing, every card paints, every terminal frame lands, and the reply path never waits", () => {
    const out = simulateCards({ cards: 50, holdMs: 600_000, channels: 5 });
    expect(out.stats.ratelimited).toBe(0);
    expect(out.retries).toBe(0);
    expect(out.terminalResent).toBe(0);
    expect(out.stats.cards).toBe(50);
    expect(out.terminalAccepted).toBe(50);
    // The budget, not Slack, does the refusing: fifty cards at the dispatcher's
    // cadence produce ~10k frames and the app allowance admits ~450 in ten
    // minutes; the rest are held back before they reach the API.
    expect(out.budgetDropped).toBeGreaterThan(8_000);
    expect(out.stats.updates).toBeLessThanOrEqual(50 * 10 + 50); // ≤ the Tier 3 rate over the hold, plus the burst
    // Fifty terminal frames at one instant: 45 wait for a funded slot (sent off
    // the reply path within the budget's own timing), none is lost.
    expect(out.terminalWaited).toBe(45);
    expect(out.stats.lagMs.p95).toBeLessThanOrEqual(10_000);
  });

  it("today's production shape — seven cards over two channels — paints every card and lands every terminal frame with no refusal", () => {
    const out = simulateCards({ cards: 7, holdMs: 600_000, channels: 2 });
    expect(out.stats.ratelimited).toBe(0);
    expect(out.stats.cards).toBe(7);
    expect(out.terminalAccepted).toBe(7);
    expect(out.stats.lagMs.p95).toBeLessThanOrEqual(3_000);
  });

  it("with the limits lifted the budgeted client sends exactly what it sends under the limits — the budget is the pacing, Slack's limit is never touched", () => {
    const under = simulateCards({ cards: 50, holdMs: 600_000, channels: 5 });
    const lifted = simulateCards({
      cards: 50,
      holdMs: 600_000,
      channels: 5,
      perAppPerMinute: 1_000_000,
      perChannelPerSecond: 1_000_000,
    });
    expect(lifted.stats.updates).toBe(under.stats.updates);
    expect(lifted.budgetDropped).toBe(under.budgetDropped);
    expect(lifted.terminalAccepted).toBe(50);
  });

  it("is deterministic", () => {
    const a = simulateCards({ cards: 12, holdMs: 120_000, channels: 3 });
    const b = simulateCards({ cards: 12, holdMs: 120_000, channels: 3 });
    expect(a).toEqual(b);
  });
});
