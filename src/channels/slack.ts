import bolt from "@slack/bolt";
import { dispatch, STATUS_PREFIXES, type CoreDeps } from "../core/dispatcher.js";
import { mdToMrkdwn } from "./mrkdwn.js";
import type { ChannelIO, HistoryItem, StatusHandle, StatusUpdate } from "../core/types.js";

// Slack channel adapter: pure transport. Wires Bolt (Socket Mode) events into
// the core dispatcher and implements ChannelIO on top of the Slack Web API.
// No routing, config, or agent logic lives here.

const { App } = bolt;
type SlackClient = bolt.webApi.WebClient;

const PLATFORM = "slack";
const SLACK_MSG_LIMIT = 3500;

// Rotating inline-status phrases (assistant.threads.setStatus loading_messages).
// Switchboard-flavored; Slack cycles through them while a turn runs.
const LOADING_PHRASES = [
  "is patching you through…",
  "is untangling the cords…",
  "is ringing the exchange…",
  "is consulting the operators…",
  "is rerouting the trunk lines…",
  "is holding the line…",
  "is splicing the wires…",
  "is checking the jacks…",
  "is dialing long distance…",
  "is clearing the static…",
];

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
    for (const chunk of chunkText(mdToMrkdwn(text), SLACK_MSG_LIMIT)) {
      await this.client.chat.postMessage({
        channel: this.ev.channel,
        thread_ts: this.ev.threadTs,
        text: chunk,
      });
    }
  }

  async status(initial: StatusUpdate): Promise<StatusHandle> {
    // Native Slack shimmer: rotating loading phrases shown inline in the
    // thread ("Switchboard is <phrase>"). Works in channel threads since
    // March 2026 with chat:write; auto-clears when the bot replies, times out
    // after ~2 min idle, so re-up every 75s during long turns.
    const setShimmer = () =>
      this.client.assistant.threads
        .setStatus({
          channel_id: this.ev.channel,
          thread_ts: this.ev.threadTs,
          status: LOADING_PHRASES[0],
          loading_messages: LOADING_PHRASES,
        })
        .catch((err: Error) => console.error(`[shimmer] ${err.message}`));

    // Post the activity card FIRST: any bot message in the thread auto-clears
    // the inline status, so the shimmer must be set after the card exists
    // (edits to the card don't clear it; only new messages do).
    const posted = await this.client.chat.postMessage({
      channel: this.ev.channel,
      thread_ts: this.ev.threadTs,
      ...render(initial),
    });
    await setShimmer();
    const shimmerTimer = setInterval(() => void setShimmer(), 75_000);
    const ts = posted.ts as string;
    const edit = (frame: StatusUpdate) =>
      this.client.chat
        .update({ channel: this.ev.channel, ts, ...render(frame) })
        .catch(() => {});
    return {
      update: (frame) => void edit(frame),
      done: async (frame) => {
        clearInterval(shimmerTimer);
        await edit(frame);
        // reply auto-clears the shimmer; clear explicitly for error paths
        await this.client.assistant.threads
          .setStatus({ channel_id: this.ev.channel, thread_ts: this.ev.threadTs, status: "" })
          .catch(() => {});
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

/** Status frames render as Block Kit: context headline + preformatted activity. */
function render(frame: StatusUpdate): { text: string; blocks: object[] } {
  const blocks: object[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: frame.title }] },
  ];
  if (frame.detail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: frame.detail.slice(0, 2900) },
    });
  }
  return { text: frame.title, blocks };
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
