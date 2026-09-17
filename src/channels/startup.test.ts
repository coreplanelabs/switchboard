import { describe, expect, it } from "vitest";
import { channelsToStart, linearBridgeBaseUrl } from "./startup.js";
import { RemoteLinearInbox } from "./linear/bridge.js";

describe("channel startup", () => {
  it("routes Linear intake to a separate local edge while keeping the bot's public origin", async () => {
    const env = { LINEAR_BRIDGE_URL: "http://localhost:8080", PUBLIC_BASE_URL: "http://localhost:8082" };
    let requested: string | undefined;
    const inbox = new RemoteLinearInbox({
      baseUrl: linearBridgeBaseUrl(env),
      token: "bridge",
      fetch: async (url) => {
        requested = String(url);
        return Response.json({ result: null });
      },
    });
    await inbox.claim();
    expect(requested).toBe("http://localhost:8080/internal/linear");
    expect(env.PUBLIC_BASE_URL).toBe("http://localhost:8082");
    expect(linearBridgeBaseUrl({ PUBLIC_BASE_URL: "https://bot.example" })).toBe("https://bot.example");
  });
  it("rejects missing or unsafe Linear bridge configuration before starting the consumer", () => {
    expect(() => linearBridgeBaseUrl({})).toThrow("LINEAR_BRIDGE_URL or PUBLIC_BASE_URL");
    for (const url of [
      "http://remote.example",
      "https://user:secret@bot.example",
      "https://bot.example/path",
      "https://bot.example?token=x",
      "invalid",
    ]) {
      expect(() => linearBridgeBaseUrl({ LINEAR_BRIDGE_URL: url, PUBLIC_BASE_URL: "https://bot.example" })).toThrow(
        "LINEAR_BRIDGE_URL",
      );
    }
  });
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
