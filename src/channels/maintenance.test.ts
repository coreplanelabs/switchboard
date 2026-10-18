import { describe, expect, it } from "vitest";
import { slackMaintenancePoster } from "./maintenance.js";

describe("maintenance Slack notices", () => {
  it("resolves a public channel name and posts later updates in the original thread", async () => {
    const messages: unknown[] = [];
    const post = slackMaintenancePoster({
      conversations: { list: async () => ({ ok: true, channels: [{ id: "COPS", name: "ops" }] }) },
      chat: {
        postMessage: async (payload: unknown) => {
          messages.push(payload);
          return { ok: true, channel: "COPS", ts: "2.0" };
        },
        getPermalink: async () => ({ ok: true, permalink: "https://example.slack.com/archives/COPS/p1000000" }),
      },
    } as unknown as Parameters<typeof slackMaintenancePoster>[0]);
    expect(await post({ channel: "#ops", text: "Maintenance is planned." })).toEqual({
      channel: "COPS",
      ts: "2.0",
      url: "https://example.slack.com/archives/COPS/p1000000",
    });
    expect(await post({ channel: "COPS", threadTs: "1.0", text: "Maintenance has started." })).toEqual({
      channel: "COPS",
      ts: "1.0",
      url: "https://example.slack.com/archives/COPS/p1000000",
    });
    expect(messages).toEqual([
      { channel: "COPS", text: "Maintenance is planned.", unfurl_links: false, unfurl_media: false },
      { channel: "COPS", thread_ts: "1.0", text: "Maintenance has started.", unfurl_links: false, unfurl_media: false },
    ]);
  });
});
