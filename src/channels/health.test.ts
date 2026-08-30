import { describe, expect, it } from "vitest";
import { healthPayload } from "./health.js";

// Feature: features/slack-channel.md item 8 — `GET /healthz` is the bot deploy
// preflight's source of truth (deploy/cloudflare/preflight.mjs): it must say
// how many runs are in flight and whether a drain is already under way.
describe("healthPayload", () => {
  it("reports ok with the in-flight count and the draining flag", () => {
    expect(healthPayload({ inFlight: 0, draining: false })).toEqual({ ok: true, inFlight: 0, draining: false });
    expect(healthPayload({ inFlight: 2, draining: true })).toEqual({ ok: true, inFlight: 2, draining: true });
  });
});
