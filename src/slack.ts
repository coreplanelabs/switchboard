import bolt from "@slack/bolt";
import type { ConfigStore, Scope } from "./config.js";
import { getAgent, AGENTS } from "./agents/registry.js";
import { parseDirectives } from "./directives.js";
import { runAgent } from "./runner.js";
import { ensureWorkspace } from "./tools/workspace.js";
import { parseModelRef, type ChatMessage } from "./providers/types.js";
import type { ProviderRegistry } from "./providers/registry.js";

const { App } = bolt;

export interface SlackDeps {
  config: ConfigStore;
  providers: ProviderRegistry;
}

export function createApp(deps: SlackDeps) {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  let botUserId: string | undefined;

  app.event("app_mention", async ({ event, client }) => {
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    await handleRequest(deps, client, {
      channel: event.channel,
      user: event.user ?? "unknown",
      text: stripMention(event.text ?? "", botUserId),
      threadTs: event.thread_ts ?? event.ts,
      botUserId,
    });
  });

  // DMs to the bot
  app.message(async ({ message, client }) => {
    const m = message as { channel_type?: string; channel: string; user?: string; text?: string; ts: string; thread_ts?: string; bot_id?: string; subtype?: string };
    if (m.channel_type !== "im" || m.bot_id || m.subtype) return;
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    await handleRequest(deps, client, {
      channel: m.channel,
      user: m.user ?? "unknown",
      text: m.text ?? "",
      threadTs: m.thread_ts ?? m.ts,
      botUserId,
    });
  });

  return app;
}

interface IncomingRequest {
  channel: string;
  user: string;
  text: string;
  threadTs: string;
  botUserId?: string;
}

type SlackClient = bolt.webApi.WebClient;

async function handleRequest(deps: SlackDeps, client: SlackClient, req: IncomingRequest) {
  const post = (text: string, threadTs?: string) =>
    client.chat.postMessage({ channel: req.channel, thread_ts: threadTs ?? req.threadTs, text });

  try {
    // Config commands are handled inline, not sent to a model.
    const configReply = handleConfigCommand(deps.config, req);
    if (configReply) {
      await post(configReply);
      return;
    }

    const directives = parseDirectives(req.text);
    const resolved = deps.config.resolve({
      channelId: req.channel,
      userId: req.user,
      request: { agent: directives.agent, model: directives.model },
    });
    const agent = getAgent(resolved.agentName);
    const { provider: providerName, model } = parseModelRef(resolved.modelRef);
    const provider = deps.providers.get(providerName);

    // Build conversation from the thread so follow-ups have context.
    const messages = await buildThreadMessages(client, req, directives.text);

    const workspaceDir = ensureWorkspace(
      deps.config.config.workspaceDir ?? "./workspaces",
      `${req.channel}-${req.threadTs}`,
    );

    // Status message that we update with tool activity while the agent works.
    const status = await client.chat.postMessage({
      channel: req.channel,
      thread_ts: req.threadTs,
      text: `:hourglass_flowing_sand: \`${agent.name}\` on \`${resolved.modelRef}\`...`,
    });
    let lastUpdate = 0;
    const onProgress = (note: string) => {
      const now = Date.now();
      if (now - lastUpdate < 3000) return; // rate-limit Slack updates
      lastUpdate = now;
      client.chat
        .update({
          channel: req.channel,
          ts: status.ts as string,
          text: `:hourglass_flowing_sand: \`${agent.name}\` on \`${resolved.modelRef}\`\n\`\`\`${note.replace(/`/g, "'")}\`\`\``,
        })
        .catch(() => {});
    };

    const answer = await runAgent({
      provider,
      model,
      agent,
      messages,
      toolContext: { workspaceDir },
      onProgress,
    });

    await client.chat.update({
      channel: req.channel,
      ts: status.ts as string,
      text: `:white_check_mark: \`${agent.name}\` on \`${resolved.modelRef}\``,
    });
    await postLong(client, req, answer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await post(`:warning: ${msg}`).catch(() => {});
  }
}

async function buildThreadMessages(
  client: SlackClient,
  req: IncomingRequest,
  currentText: string,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  try {
    const replies = await client.conversations.replies({
      channel: req.channel,
      ts: req.threadTs,
      limit: 50,
    });
    for (const m of replies.messages ?? []) {
      const mm = m as { user?: string; bot_id?: string; text?: string; ts?: string };
      if (!mm.text) continue;
      // Skip the triggering message itself; it's appended (directive-stripped) below.
      if (mm.text === req.text || mm.ts === req.threadTs && (replies.messages?.length ?? 0) === 1) continue;
      const role = mm.bot_id ? "assistant" : "user";
      const text = req.botUserId ? mm.text.replaceAll(`<@${req.botUserId}>`, "").trim() : mm.text;
      if (!text || text.startsWith(":hourglass") || text.startsWith(":white_check_mark:")) continue;
      messages.push({ role, content: [{ type: "text", text }] });
    }
  } catch {
    // Thread fetch is best-effort; fall through to just the current message.
  }
  // Merge consecutive same-role or just append current request
  messages.push({ role: "user", content: [{ type: "text", text: currentText || "(empty message)" }] });
  return normalizeAlternation(messages);
}

/** Anthropic requires user-first; both providers behave best with merged consecutive roles. */
function normalizeAlternation(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      out.push({ role: m.role, content: [...m.content] });
    }
  }
  while (out.length > 0 && out[0].role !== "user") out.shift();
  return out;
}

const SLACK_MSG_LIMIT = 3500;

async function postLong(client: SlackClient, req: IncomingRequest, text: string) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SLACK_MSG_LIMIT) {
    let cut = rest.lastIndexOf("\n", SLACK_MSG_LIMIT);
    if (cut < SLACK_MSG_LIMIT / 2) cut = SLACK_MSG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    await client.chat.postMessage({ channel: req.channel, thread_ts: req.threadTs, text: chunk });
  }
}

// ---- config commands -------------------------------------------------------
// "config show"
// "config set channel agent=review model=anthropic/claude-opus-5 models.coding=..."
// "config set me model=openai/gpt-5"
// "config clear channel" / "config clear me"
// "help"

function handleConfigCommand(config: ConfigStore, req: IncomingRequest): string | null {
  const text = req.text.trim();
  if (/^help$/i.test(text)) return helpText();
  const m = text.match(/^config\s+(show|set|clear)\s*(.*)$/is);
  if (!m) return null;
  const [, verb, rest] = m;

  if (verb === "show") return config.describe(req.channel, req.user);

  const scopeMatch = rest.trim().match(/^(channel|me)\s*(.*)$/is);
  if (!scopeMatch) return `Usage: \`config ${verb} channel|me ...\``;
  const [, scopeName, args] = scopeMatch;

  if (verb === "clear") {
    if (scopeName === "channel") config.clearChannelOverride(req.channel);
    else config.clearUserOverride(req.user);
    return `Cleared ${scopeName === "channel" ? "channel" : "your"} overrides.`;
  }

  // verb === "set"
  const patch: Scope = {};
  for (const token of args.split(/\s+/).filter(Boolean)) {
    const kv = token.match(/^([\w.]+)=(\S+)$/);
    if (!kv) return `Couldn't parse \`${token}\`. Use \`key=value\`, e.g. \`agent=review\`.`;
    const [, key, value] = kv;
    if (key === "agent") {
      if (!AGENTS[value]) return `Unknown agent \`${value}\`. Available: ${Object.keys(AGENTS).join(", ")}`;
      patch.agent = value;
    } else if (key === "model") {
      patch.model = value;
    } else if (key.startsWith("models.")) {
      const agentName = key.slice("models.".length);
      if (!AGENTS[agentName]) return `Unknown agent \`${agentName}\` in \`${key}\`.`;
      patch.models = { ...patch.models, [agentName]: value };
    } else {
      return `Unknown key \`${key}\`. Valid: agent, model, models.<agent>`;
    }
  }
  if (Object.keys(patch).length === 0) return `Nothing to set. Example: \`config set channel agent=review\``;

  const effective =
    scopeName === "channel"
      ? config.setChannelOverride(req.channel, patch)
      : config.setUserOverride(req.user, patch);
  return `Updated ${scopeName === "channel" ? "channel" : "your"} scope. Now: ${JSON.stringify(effective)}`;
}

function helpText(): string {
  const agents = Object.values(AGENTS)
    .map((a) => `• \`${a.name}\` — ${a.description}`)
    .join("\n");
  return [
    "*Switchboard* — mention me with a request. Agents:",
    agents,
    "",
    "*Per-request directives* (anywhere in the message):",
    "`agent:review model:anthropic/claude-opus-5 look at PR #42`",
    "",
    "*Config commands:*",
    "`config show` — effective settings here",
    "`config set channel agent=review` — channel default agent",
    "`config set me model=openai/gpt-5` — your personal model",
    "`config set channel models.coding=anthropic/claude-opus-5` — per-agent model for this channel",
    "`config clear channel` / `config clear me`",
  ].join("\n");
}

function stripMention(text: string, botUserId?: string): string {
  const stripped = botUserId ? text.replaceAll(`<@${botUserId}>`, "") : text.replace(/<@[A-Z0-9]+>/, "");
  return stripped.trim();
}
