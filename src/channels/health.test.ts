import { describe, expect, it } from "vitest";
import { DRAIN_DEADLINE_MS } from "../core/drain.js";
import { healthPayload } from "./health.js";

// Feature: features/slack-channel.md item 8 — `GET /healthz` is the bot deploy
// preflight's source of truth (deploy/cloudflare/preflight.mjs): it must say
// how many runs are in flight and whether a drain is already under way; and
// item 7 (#272) — an operator must be able to see how long the Slack blackout
// a drain causes can last.
describe("healthPayload", () => {
  it("reports ok with the in-flight count, the draining flag and the drain deadline", () => {
    expect(healthPayload({ inFlight: 0, draining: false })).toEqual({
      ok: true,
      inFlight: 0,
      draining: false,
      drainDeadlineMs: DRAIN_DEADLINE_MS,
    });
  });

  it("adds drainStartedAt (ISO) only while draining", () => {
    const startedAt = Date.UTC(2026, 7, 30, 12, 0, 0);
    expect(healthPayload({ inFlight: 2, draining: true, drainStartedAt: startedAt })).toEqual({
      ok: true,
      inFlight: 2,
      draining: true,
      drainDeadlineMs: DRAIN_DEADLINE_MS,
      drainStartedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(healthPayload({ inFlight: 0, draining: false, drainStartedAt: startedAt })).not.toHaveProperty("drainStartedAt");
  });
});
