import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_MS } from "../channels/slackCatchUp.js";
import { COLD_START_ALLOWANCE_MS, DRAIN_DEADLINE_MS, MIN_CATCH_UP_WINDOW_MS, catchUpWindowWarning } from "./drain.js";

// Feature: features/slack-channel.md item 7 — the reconnect catch-up window is
// the ONLY recovery for mentions posted while a deploy-time drain holds the
// socket closed (#272), so it must cover the whole drain deadline plus a cold
// start. Lowering DEFAULT_WINDOW_MS below that is a silent blackout regression.
describe("catch-up window vs drain deadline", () => {
  it("the default window covers the drain deadline plus the cold-start allowance", () => {
    expect(MIN_CATCH_UP_WINDOW_MS).toBe(DRAIN_DEADLINE_MS + COLD_START_ALLOWANCE_MS);
    expect(DEFAULT_WINDOW_MS).toBeGreaterThanOrEqual(MIN_CATCH_UP_WINDOW_MS);
  });

  it("the deadline is the 15 min Cloudflare rollout grace and the default window is 30 min", () => {
    expect(DRAIN_DEADLINE_MS).toBe(15 * 60_000);
    expect(DEFAULT_WINDOW_MS).toBe(30 * 60_000);
  });
});

describe("catchUpWindowWarning (slack.catchUp.windowMinutes)", () => {
  it("is silent when unset (default applies) or at/above the safe minimum", () => {
    expect(catchUpWindowWarning(undefined)).toBeUndefined();
    expect(catchUpWindowWarning(20)).toBeUndefined();
    expect(catchUpWindowWarning(30)).toBeUndefined();
  });

  it("names the drain deadline and the minimum when the configured window is below it, without changing the value", () => {
    const w = catchUpWindowWarning(10);
    expect(w).toContain("10 min");
    expect(w).toContain("15 min drain deadline");
    expect(w).toContain("20 min");
  });

  it("calls out a non-positive or non-finite window as unusable", () => {
    expect(catchUpWindowWarning(0)).toContain("positive");
    expect(catchUpWindowWarning(-5)).toContain("positive");
    expect(catchUpWindowWarning(Number.NaN)).toContain("positive");
  });
});
