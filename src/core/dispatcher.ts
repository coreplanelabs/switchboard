import type { ConfigStore, Scope } from "../config.js";
import { AGENTS, getAgent } from "../agents/registry.js";
import { lastThreadDirectives, parseDirectives } from "../directives.js";
import { runAgent } from "../runner.js";
import { makeExecutor } from "../execution/factory.js";
import { parseModelRef, type ChatMessage, type ContentPart } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChannelIO, HistoryItem, ImageAttachment, IncomingMessage } from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps {
  config: ConfigStore;
  providers: ProviderRegistry;
  /** where runtime state (sandboxes.json) lives; default ./data */
  dataDir?: string;
}

const STATUS_UPDATE_MIN_MS = 3000;

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;
export function activeRunCount(): number {
  return activeRuns;
}

export async function dispatch(deps: CoreDeps, msg: IncomingMessage, io: ChannelIO): Promise<void> {
  try {
    // Config commands are answered inline, never sent to a model.
    const configReply = handleConfigCommand(deps.config, msg);
    if (configReply) {
      await io.reply(configReply);
      return;
    }

    const directives = parseDirectives(msg.text);
    // Thread stickiness: a follow-up without explicit directives runs on the
    // agent/model this thread already established (last directive in the
    // thread's history), not the channel/global default — otherwise "continue"
    // in an agent:coding thread silently lands on the toolless default agent.
    // Derived from history on every message, never stored: restart-safe, and
    // consistent with how the Slack adapter re-derives thread participation.
    const history = await io.history();
    const sticky = lastThreadDirectives(history);
    const resolved = deps.config.resolve({
      channelId: msg.channelId,
      userId: msg.userId,
      request: {
        agent: directives.agent ?? sticky.agent,
        model: directives.model ?? sticky.model,
      },
    });

    // Authorization gate: checked against the *resolved* agent and invoking
    // user, so no config layer (directives, user or channel scope) bypasses it.
    if (!deps.config.canRunAgent(msg.userId, resolved.agentName)) {
      await io.reply(
        `🚫 You're not on the allowlist for the \`${resolved.agentName}\` agent. Ask ${deps.config.adminsHint()} for access.`,
      );
      return;
    }

    const agent = getAgent(resolved.agentName);
    const { provider: providerName, model } = parseModelRef(resolved.modelRef);
    const provider = deps.providers.get(providerName);

    const messages = buildMessages(history, directives.text, msg.images);

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref will carry resident-repo inference in later milestones.
    const executor = await makeExecutor(
      {
        execution: deps.config.config.execution,
        workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
        dataDir: deps.dataDir ?? "./data",
      },
      { threadKey: msg.threadKey, agent },
    );

    const label = `*${agent.name}* on \`${resolved.modelRef}\``;
    console.log(`[run] ${msg.threadKey} user=${msg.userId} agent=${agent.name} model=${resolved.modelRef}`);
    const startedAt = Date.now();
    const spinner = ["◐", "◓", "◑", "◒"];
    let frame = 0;
    const title = (icon?: string) =>
      `${icon ?? spinner[frame++ % spinner.length]} ${label} · ${Math.round((Date.now() - startedAt) / 1000)}s`;
    const status = await io.status({ title: title() });
    let lastToolAt = Date.now();
    // The card body is the agent's own checklist (via the update_status tool),
    // not a raw command stream — commands go to stdout for operators only.
    let checklist: string | undefined;
    const currentFrame = () => {
      const quiet = Date.now() - lastToolAt;
      const thinking = quiet > 20_000 ? ` — thinking (${Math.round(quiet / 1000)}s since last tool)` : "";
      return { title: title() + thinking, detail: checklist };
    };
    const onProgress = (note: string) => {
      console.log(`[tool] ${msg.threadKey} ${note}`);
      lastToolAt = Date.now();
    };
    const reportProgress = (list: string) => {
      checklist = list.trim() || undefined;
      status.update(currentFrame());
    };
    // Heartbeat: the card ticks every 5s no matter what. A ticking timer means
    // the run is alive; a stopped timer means the process died — the reader
    // can always tell the difference.
    const heartbeat = setInterval(() => status.update(currentFrame()), 5000);

    activeRuns++;
    let answer: string;
    try {
      answer = await runAgent({
        provider,
        model,
        agent,
        messages,
        toolContext: { executor, reportProgress },
        onProgress,
      });
    } catch (err) {
      await status.done({ title: title("❌"), detail: checklist });
      throw err;
    } finally {
      activeRuns--;
      clearInterval(heartbeat);
    }

    console.log(`[done] ${msg.threadKey} ${answer.length} chars`);
    await status.done({ title: title("✅"), detail: checklist });
    await io.reply(answer);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await io.reply(`⚠️ ${errMsg}`).catch(() => {});
  }
}

/** Prefixes the core stamps on status text — adapters use this to filter their
 *  own status noise out of history. */
export const STATUS_PREFIXES = ["⏳", "✅", "◐", "◓", "◑", "◒"];

function buildMessages(
  history: HistoryItem[],
  currentText: string,
  currentImages?: ImageAttachment[],
): ChatMessage[] {
  const messages: ChatMessage[] = history.map((h) => ({
    role: h.role,
    content: turnContent(h.text, h.images),
  }));
  messages.push({ role: "user", content: turnContent(currentText, currentImages) });
  return normalizeAlternation(messages);
}

/** Images first, then text — a turn always has at least one part. */
function turnContent(text: string, images?: ImageAttachment[]): ContentPart[] {
  const parts: ContentPart[] = (images ?? []).map((img) => ({
    type: "image" as const,
    mediaType: img.mediaType,
    data: img.data,
  }));
  if (text) parts.push({ type: "text", text });
  if (parts.length === 0) parts.push({ type: "text", text: "(empty message)" });
  return parts;
}

/** Providers require user-first and behave best with merged consecutive roles. */
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

// ---- config commands --------------------------------------------------------
// "config show" | "config set channel k=v ..." | "config set me k=v ..."
// "config clear channel|me" | "help"

function handleConfigCommand(config: ConfigStore, msg: IncomingMessage): string | null {
  const text = msg.text.trim();
  if (/^help$/i.test(text)) return helpText();
  const m = text.match(/^config\s+(show|set|clear)\s*(.*)$/is);
  if (!m) return null;
  const [, verb, rest] = m;

  if (verb === "show") return config.describe(msg.channelId, msg.userId);

  const scopeMatch = rest.trim().match(/^(channel|me)\s*(.*)$/is);
  if (!scopeMatch) return `Usage: \`config ${verb} channel|me ...\``;
  const [, scopeName, args] = scopeMatch;

  // Channel-scope changes affect everyone in the channel — gate them.
  // "me" scope stays open: pointing yourself at a restricted agent is harmless
  // because the run-time agent gate still applies to you.
  if (scopeName === "channel" && !config.canEditChannelConfig(msg.userId)) {
    return `🚫 Channel config changes are restricted. Ask ${config.adminsHint()}.`;
  }

  if (verb === "clear") {
    if (scopeName === "channel") config.clearChannelOverride(msg.channelId);
    else config.clearUserOverride(msg.userId);
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
      ? config.setChannelOverride(msg.channelId, patch)
      : config.setUserOverride(msg.userId, patch);
  return `Updated ${scopeName === "channel" ? "channel" : "your"} scope. Now: ${JSON.stringify(effective)}`;
}

function helpText(): string {
  const agents = Object.values(AGENTS)
    .map((a) => `• \`${a.name}\` — ${a.description}`)
    .join("\n");
  return [
    "*Switchboard* — send me a request. Agents:",
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
