import type { WebClient } from "@slack/web-api";
import type { MaintenanceNotice } from "../core/maintenance.js";

/** Resolve an installation's channel name only when an operator posts a notice. */
export function slackMaintenancePoster(client: Pick<WebClient, "conversations" | "chat">) {
  return async (notice: MaintenanceNotice) => {
    let channel = notice.channel.replace(/^slack:/, "").replace(/^#/, "");
    if (!/^[CG][A-Z0-9]+$/.test(channel)) {
      const name = channel;
      let cursor: string | undefined;
      let found: string | undefined;
      do {
        const page = await client.conversations.list({
          exclude_archived: true,
          types: "public_channel",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        found = page.channels?.find((entry) => entry.name === name)?.id;
        cursor = page.response_metadata?.next_cursor;
      } while (!found && cursor);
      if (!found) throw new Error("The maintenance announcement channel is unavailable.");
      channel = found;
    }
    const sent = await client.chat.postMessage({
      channel,
      text: notice.text,
      ...(notice.threadTs ? { thread_ts: notice.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!sent.ok || !sent.ts || !sent.channel) throw new Error("Maintenance notice acknowledgement is unavailable.");
    const link = await client.chat.getPermalink({ channel: sent.channel, message_ts: notice.threadTs ?? sent.ts });
    if (!link.ok || !link.permalink) throw new Error("Maintenance thread link is unavailable.");
    return { channel: sent.channel, ts: notice.threadTs ?? sent.ts, url: link.permalink };
  };
}
