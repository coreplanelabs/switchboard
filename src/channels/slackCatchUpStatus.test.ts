import { beforeEach, describe, expect, it } from "vitest";
import {
  getCatchUpStatus,
  missingBotScopes,
  recordCatchUpOutcome,
  recordMissingScopes,
  REQUIRED_BOT_SCOPES,
  resetCatchUpStatus,
} from "./slackCatchUpStatus.js";

// Feature: features/slack-channel.md item 7 — the reconnect catch-up's last
// outcome and the bot token's missing scopes are observable without container
// logs (#271): live 2026-08-30 the scan was a silent no-op for hours because
// `users.conversations` answered `missing_scope` and the only trace was a
// console.log in container stdout.

beforeEach(() => resetCatchUpStatus());

describe("catch-up status record (in-process, live-only)", () => {
  it("starts empty", () => {
    expect(getCatchUpStatus()).toEqual({});
  });

  it("records the last outcome — a successful scan has no error", () => {
    recordCatchUpOutcome({ at: 1_788_040_800_000, channels: 3, missed: 1, skippedChannels: 0 });
    expect(getCatchUpStatus()).toEqual({
      lastRunAt: "2026-08-29T22:00:00.000Z",
      channels: 3,
      missed: 1,
      skippedChannels: 0,
    });
  });

  it("records a whole-scan failure as `error` and clears it on the next clean run", () => {
    recordCatchUpOutcome({ at: 1_788_040_800_000, channels: 0, missed: 0, skippedChannels: 0, error: "missing_scope" });
    expect(getCatchUpStatus().error).toBe("missing_scope");
    recordCatchUpOutcome({ at: 1_788_040_860_000, channels: 2, missed: 0, skippedChannels: 1 });
    expect(getCatchUpStatus()).toEqual({
      lastRunAt: "2026-08-29T22:01:00.000Z",
      channels: 2,
      missed: 0,
      skippedChannels: 1,
    });
  });

  it("keeps missingScopes across outcomes (the scope check runs once, at startup)", () => {
    recordMissingScopes(["channels:read", "groups:read"]);
    recordCatchUpOutcome({ at: 1_788_040_800_000, channels: 0, missed: 0, skippedChannels: 0, error: "missing_scope" });
    expect(getCatchUpStatus().missingScopes).toEqual(["channels:read", "groups:read"]);
  });

  it("an empty missing list is recorded as absent, not []", () => {
    recordMissingScopes([]);
    expect(getCatchUpStatus()).toEqual({});
  });
});

describe("missingBotScopes (pure comparison against the adapter's required set)", () => {
  it("the required set is exactly what the adapter needs", () => {
    expect(REQUIRED_BOT_SCOPES).toEqual([
      "app_mentions:read",
      "chat:write",
      "channels:history",
      "groups:history",
      "files:read",
      "files:write",
      "reactions:write",
      "channels:read",
      "groups:read",
      "users:read",
    ]);
  });

  it("nothing missing when every required scope is granted (extras ignored)", () => {
    expect(missingBotScopes([...REQUIRED_BOT_SCOPES, "im:history"])).toEqual([]);
  });

  it("names the missing ones, in required order (the 2026-08-30 token lacked channels:read and groups:read)", () => {
    const granted = REQUIRED_BOT_SCOPES.filter((s) => s !== "channels:read" && s !== "groups:read");
    expect(missingBotScopes(granted)).toEqual(["channels:read", "groups:read"]);
  });

  it("accepts Slack's comma-separated header form too", () => {
    expect(missingBotScopes(REQUIRED_BOT_SCOPES.join(","))).toEqual([]);
  });

  it("unknown granted set (no metadata on the response) → cannot judge, reports nothing missing", () => {
    expect(missingBotScopes(undefined)).toEqual([]);
  });
});
