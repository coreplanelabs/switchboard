import { describe, expect, it } from "vitest";
import { channelsToStart } from "./startup.js";

describe("channel startup", () => {
  it("starts Linear without Slack credentials and retains combined installations", () => {
    expect(channelsToStart(new Set(["LINEAR_BRIDGE_TOKEN"]))).toEqual({ slack: false, linear: true });
    expect(channelsToStart(new Set(["LINEAR_BRIDGE_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]))).toEqual({
      slack: true,
      linear: true,
    });
    expect(channelsToStart(new Set(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]))).toEqual({ slack: true, linear: false });
  });
  it("names incomplete Slack credentials even when Linear is configured", () => {
    expect(() => channelsToStart(new Set(["SLACK_BOT_TOKEN", "LINEAR_BRIDGE_TOKEN"]))).toThrow("SLACK_APP_TOKEN");
    expect(() => channelsToStart(new Set(["SLACK_APP_TOKEN", "LINEAR_BRIDGE_TOKEN"]))).toThrow("SLACK_BOT_TOKEN");
    expect(() => channelsToStart(new Set())).toThrow("No channel configured");
  });
});
