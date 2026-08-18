import bolt from "@slack/bolt";
import { dispatch, STATUS_PREFIXES, type CoreDeps } from "../core/dispatcher.js";
import type { ChannelIO, HistoryItem, StatusHandle } from "../core/types.js";

// Slack channel adapter: pure transport. Wires Bolt (Socket Mode) events into
// the core dispatcher and implements ChannelIO on top of the Slack Web API.
// No routing, config, or agent logic lives here.

const { App } = bolt;
type SlackClient = bolt.webApi.WebClient;

const PLATFORM = "slack";
const SLACK_MSG_LIMIT = 3500;

export function createSlackApp(deps: CoreDeps) {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  let botUserId: string | undefined;

  app.event("app_mention", async ({ event, client }) => {
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    await handle(deps, client, {
      channel: event.channel,
      user: event.user ?? "unknown",
      text: stripMention(event.text ?? "", botUserId),
      threadTs: event.thread_ts ?? event.ts,
      botUserId,
    });
  });

  // DMs to the bot
  app.message(async ({ message, client }) => {
    const m = message as {
      channel_type?: string;
      channel: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      bot_id?: string;
      subtype?: string;
    };
    if (m.channel_type !== "im" || m.bot_id || m.subtype) return;
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    await handle(deps, client, {
      channel: m.channel,
      user: m.user ?? "unknown",
      text: m.text ?? "",
      threadTs: m.thread_ts ?? m.ts,
      botUserId,
    });
  });

  return app;
}

interface SlackEvent {
  channel: string;
  user: string;
  text: string;
  threadTs: string;
  botUserId?: string;
}

async function handle(deps: CoreDeps, client: SlackClient, ev: SlackEvent): Promise<void> {
  await dispatch(
    deps,
    {
      channelId: `${PLATFORM}:${ev.channel}`,
      userId: `${PLATFORM}:${ev.user}`,
      threadKey: `${PLATFORM}:${ev.channel}:${ev.threadTs}`,
      text: ev.text,
    },
    new SlackIO(client, ev),
  );
}

class SlackIO implements ChannelIO {
  constructor(
    private client: SlackClient,
    private ev: SlackEvent,
  ) {}

  async reply(text: string): Promise<void> {
    for (const chunk of chunkText(text, SLACK_MSG_LIMIT)) {
      await this.client.chat.postMessage({
        channel: this.ev.channel,
        thread_ts: this.ev.threadTs,
        text: chunk,
      });
    }
  }

  async status(initial: string): Promise<StatusHandle> {
    const posted = await this.client.chat.postMessage({
      channel: this.ev.channel,
      thread_ts: this.ev.threadTs,
      text: initial,
    });
    const ts = posted.ts as string;
    const edit = (text: string) =>
      this.client.chat.update({ channel: this.ev.channel, ts, text }).catch(() => {});
    return {
      update: (note) => void edit(note),
      done: async (summary) => {
        await edit(summary);
      },
    };
  }

  async history(): Promise<HistoryItem[]> {
    const items: HistoryItem[] = [];
    try {
      const replies = await this.client.conversations.replies({
        channel: this.ev.channel,
        ts: this.ev.threadTs,
        limit: 50,
      });
      for (const m of replies.messages ?? []) {
        const mm = m as { bot_id?: string; text?: string; ts?: string };
        if (!mm.text) continue;
        // Skip the triggering message itself; the dispatcher appends it
        // (directive-stripped) as the current turn.
        if (mm.text === this.ev.text) continue;
        if (mm.ts === this.ev.threadTs && (replies.messages?.length ?? 0) === 1) continue;
        const text = this.ev.botUserId
          ? mm.text.replaceAll(`<@${this.ev.botUserId}>`, "").trim()
          : mm.text;
        if (!text || STATUS_PREFIXES.some((p) => text.startsWith(p))) continue;
        items.push({ role: mm.bot_id ? "assistant" : "user", text });
      }
    } catch {
      // best-effort; the dispatcher still has the current message
    }
    return items;
  }
}

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

function stripMention(text: string, botUserId?: string): string {
  const stripped = botUserId
    ? text.replaceAll(`<@${botUserId}>`, "")
    : text.replace(/<@[A-Z0-9]+>/, "");
  return stripped.trim();
}
