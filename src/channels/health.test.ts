import { describe, expect, it } from "vitest";
import { DRAIN_DEADLINE_MS } from "../core/drain.js";
import { healthPayload, readBuildInfo, UNKNOWN_BUILD } from "./health.js";

// Feature: features/slack-channel.md item 8 — deployed ≠ live: `/healthz`
// carries the build identity (`build: { commit, builtAt }`) baked into the
// image by `deploy/cloudflare/write-build.mjs`, so `deploy:all`'s live gate can
// tell the NEW container from the old one still draining.
describe("build identity on /healthz", () => {
  it("readBuildInfo parses build.json; a missing/malformed file or a blank commit is `unknown`, never a throw", () => {
    const files: Record<string, string> = {
      good: JSON.stringify({ commit: "e6af1aa0b7c3", builtAt: "2026-08-30T05:00:00.000Z" }),
      noBuiltAt: JSON.stringify({ commit: "abc1234" }),
      blank: JSON.stringify({ commit: "" }),
      junk: "<html>",
      array: "[1]",
    };
    const read = (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    };
    expect(readBuildInfo("good", read)).toEqual({ commit: "e6af1aa0b7c3", builtAt: "2026-08-30T05:00:00.000Z" });
    expect(readBuildInfo("noBuiltAt", read)).toEqual({ commit: "abc1234" });
    for (const p of ["blank", "junk", "array", "missing"]) expect(readBuildInfo(p, read), p).toEqual(UNKNOWN_BUILD);
    expect(UNKNOWN_BUILD).toEqual({ commit: "unknown" });
  });

  it("healthPayload carries `build` when given (builtAt omitted when absent) and no key when not", () => {
    expect(healthPayload({ inFlight: 0, draining: false, build: { commit: "abc1234", builtAt: "2026-08-30T05:00:00.000Z" } }).build).toEqual({
      commit: "abc1234",
      builtAt: "2026-08-30T05:00:00.000Z",
    });
    expect(healthPayload({ inFlight: 0, draining: false, build: UNKNOWN_BUILD }).build).toEqual({ commit: "unknown" });
    expect(healthPayload({ inFlight: 0, draining: false })).not.toHaveProperty("build");
  });
});

// Feature: features/slack-channel.md item 8 — `deploy restart` restarts the
// container without a build, so `build.commit` is unchanged; `startedAt`
// (process start, ISO) is how its live gate tells the new instance from the old.
describe("startedAt on /healthz", () => {
  it("is the process start as ISO when given, and absent otherwise", () => {
    expect(healthPayload({ inFlight: 0, draining: false, startedAt: Date.UTC(2026, 7, 30, 10, 0, 41) }).startedAt).toBe("2026-08-30T10:00:41.000Z");
    expect(healthPayload({ inFlight: 0, draining: false })).not.toHaveProperty("startedAt");
  });
});

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

// Feature: features/slack-channel.md item 7 (#271) — /healthz also carries the
// reconnect catch-up's last outcome and the bot token's missing scopes, so a
// silent catch-up is visible without container logs.
describe("healthPayload — catchUp", () => {
  it("includes the catch-up status with undefined fields omitted", () => {
    const p = healthPayload({
      inFlight: 0,
      draining: false,
      catchUp: { lastRunAt: "2026-08-29T22:00:00.000Z", channels: 3, missed: 0, skippedChannels: 0, error: undefined, missingScopes: undefined },
    });
    expect(p.catchUp).toEqual({ lastRunAt: "2026-08-29T22:00:00.000Z", channels: 3, missed: 0, skippedChannels: 0 });
    expect(Object.keys(p.catchUp ?? {})).toEqual(["lastRunAt", "channels", "missed", "skippedChannels"]);
  });

  it("carries error and missingScopes when set", () => {
    const p = healthPayload({ inFlight: 0, draining: false, catchUp: { error: "missing_scope", missingScopes: ["channels:read"] } });
    expect(p.catchUp).toEqual({ error: "missing_scope", missingScopes: ["channels:read"] });
  });

  it("a bot that has not scanned yet reports an empty catchUp object", () => {
    expect(healthPayload({ inFlight: 0, draining: false, catchUp: {} }).catchUp).toEqual({});
  });
});
