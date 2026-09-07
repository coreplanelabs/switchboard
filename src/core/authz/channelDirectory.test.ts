import { describe, expect, it } from "vitest";
import { STATIC_CHANNEL_DIRECTORY, StaticChannelDirectory, visibilityOf } from "./channelDirectory.js";
import type { ChannelDirectory } from "./types.js";

// Feature: features/authorization.md item 7 (U3) — the channel-facts seam and
// its static first cut: what a platform-namespaced id alone establishes about
// a channel's visibility. `unknown` is the fail-closed answer (R7).

describe("visibilityOf — the static id mapping", () => {
  it("http:*/mcp:* are machine channels; a Slack DM is dm; a Slack private group is private", () => {
    expect(visibilityOf("http:ops")).toBe("machine");
    expect(visibilityOf("http:cron")).toBe("machine");
    expect(visibilityOf("mcp:alice")).toBe("machine");
    expect(visibilityOf("slack:D0123ABC")).toBe("dm");
    expect(visibilityOf("slack:G0123ABC")).toBe("private");
  });

  it("a Slack C… channel may be public or private and the id cannot say — `unknown` (never public) until a Slack directory asks conversations.info", () => {
    expect(visibilityOf("slack:C0123ABC")).toBe("unknown");
  });

  it("anything else — the CLI, a foreign namespace, a bare id — is unknown", () => {
    for (const id of ["cli:local", "discord:general", "C0123ABC", "", "slack:", "slack:X1"])
      expect(visibilityOf(id), id).toBe("unknown");
  });
});

describe("StaticChannelDirectory", () => {
  const directory: ChannelDirectory = new StaticChannelDirectory();

  it("implements the seam over visibilityOf and resolves at once", async () => {
    expect(await directory.info("mcp:ops")).toEqual({ visibility: "machine" });
    expect(await directory.info("slack:D1")).toEqual({ visibility: "dm" });
    expect(await directory.info("slack:C1")).toEqual({ visibility: "unknown" });
  });

  it("knows no members: isMember is `unknown` for every actor and channel (not a member, R7)", async () => {
    expect(await directory.isMember("slack:U1", "slack:C1")).toBe("unknown");
    expect(await directory.isMember("http:ops", "http:ops")).toBe("unknown");
  });

  it("STATIC_CHANNEL_DIRECTORY is the shared default instance", async () => {
    expect(STATIC_CHANNEL_DIRECTORY).toBeInstanceOf(StaticChannelDirectory);
    expect(await STATIC_CHANNEL_DIRECTORY.info("http:x")).toEqual({ visibility: "machine" });
  });
});
