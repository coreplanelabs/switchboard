import { resolve } from "node:path";
import type { ConfigStore, Scope } from "../config.js";
import { AGENTS, getAgent } from "../agents/registry.js";
import { lastThreadDirectives, parseDirectives } from "../directives.js";
import { runAgent } from "../runner.js";
import { makeExecutor } from "../execution/factory.js";
import { ResidentExecutor, ResidentNeedsRefError, ResidentOperations } from "../execution/resident.js";
import { LocalOperations } from "../execution/executor.js";
import { parseModelRef, type ChatMessage, type ContentPart } from "../providers/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { resolveRepoContext, type RepoContext } from "./repoContext.js";
import { handleRepoCommand, type ResidentAdminClient } from "./repoCommands.js";
import { recognizeOperation, type Operations, type RecognizedOp } from "./operations.js";
import type { ChannelIO, HistoryItem, ImageAttachment, IncomingMessage } from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps {
  config: ConfigStore;
  providers: ProviderRegistry;
  /** where runtime state (sandboxes.json) lives; default ./data */
  dataDir?: string;
  /**
   * Resolves the target repo/ref for a message (resident environments).
   * Defaults to the production resolver in repoContext.ts (explicit repo/PR/
   * branch signals in the message, then the thread-established repo from
   * history); injectable for tests. No repo signal → {} → the per-thread
   * executor path with no resident probe (total input contract).
   */
  resolveRepoContext?: (
    msg: IncomingMessage,
    history: HistoryItem[],
  ) => Promise<RepoContext> | RepoContext;
  /**
   * Admin client for the resident Worker's repo-management routes (U8);
   * injectable for tests. Default: a fetch client built per command from
   * execution.resident.baseUrl + the RESIDENT_ADMIN_TOKEN env bearer.
   */
  residentAdmin?: ResidentAdminClient;
  /**
   * Deterministic-operations backend behind the modelless fast-path (U6,
   * KTD8); injectable for tests. Default per dispatch: resident-backed when
   * execution.resident is configured (operator bearer), local when execution
   * is local, else none — the recognizer then falls through to the agent.
   */
  operations?: Operations;
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

    // Repo-management commands (U8) are config-family too: answered inline,
    // never a model turn. Gated inside — canManageRepos is KTD9 fail-closed
    // for everything but `repo list`.
    const repoReply = await handleRepoCommand(deps.config, msg, deps.residentAdmin);
    if (repoReply) {
      await io.reply(repoReply);
      return;
    }

    const directives = parseDirectives(msg.text);
    const history = await io.history();

    // Deterministic ops fast-path (U6, KTD8): explicit `repo test/build`
    // commands and conservative natural-language forms answer with a REAL op
    // execution and zero model turns, mirroring the config-command
    // inline-reply shape. Only the model call is skipped — the implicit
    // target agent (coding) passes canRunAgent and the repo passes canUseRepo
    // (KD7) before anything executes. Anything ambiguous or non-matching
    // falls through to the agent below (KD3: never guess); on the
    // natural-language path so do not-onboarded repos and backend failures
    // (the agent can still serve the ask), while explicit commands are
    // config-family and always get a reply. An explicit agent:/model:
    // directive disables natural recognition — the user picked a model path.
    const opAsk = recognizeOperation(msg.text, history, {
      allowNatural: !directives.agent && !directives.model,
    });
    if (opAsk) {
      const opReply = await runOperationFastPath(deps, msg, opAsk);
      if (opReply !== null) {
        await io.reply(opReply);
        return;
      }
    }

    // Thread stickiness: a follow-up without explicit directives runs on the
    // agent/model this thread already established (last directive in the
    // thread's history), not the channel/global default — otherwise "continue"
    // in an agent:coding thread silently lands on the toolless default agent.
    // Derived from history on every message, never stored: restart-safe, and
    // consistent with how the Slack adapter re-derives thread participation.
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

    // Target repo/ref for resident environments, resolved BEFORE the model
    // turn (U7): explicit signals in the message, else the repo this thread
    // already established (from history — restart-safe, never stored).
    const repoCtx = (await (deps.resolveRepoContext ?? resolveRepoContext)(msg, history)) ?? {};

    // Per-repo access gate (KD7): open when permissions.repos is absent or
    // the repo is unlisted; a configured allowlist refuses BY NAME — a
    // refused user must see why, never get a silent per-thread fallback.
    if (repoCtx.repo && !deps.config.canUseRepo(msg.userId, repoCtx.repo)) {
      await io.reply(
        `🚫 You're not on the allowlist for the \`${repoCtx.repo}\` repo environment. Ask ${deps.config.adminsHint()} for access.`,
      );
      return;
    }

    const messages = buildMessages(history, directives.text, msg.images);

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref carry resident-repo inference. A resident fallback comes
    // back with a named note (KTD10) that rides on every status frame below.
    let selection: Awaited<ReturnType<typeof makeExecutor>>;
    try {
      selection = await makeExecutor(
        {
          execution: deps.config.config.execution,
          workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
          dataDir: deps.dataDir ?? "./data",
        },
        { threadKey: msg.threadKey, agent, repo: repoCtx.repo, ref: repoCtx.ref },
      );
    } catch (err) {
      // Ask-once (KTD6): the resident has no ref binding for this thread and
      // the message named no branch — binding is explicit-or-ask-once, never
      // a silent guess. ONE clarifying question, no model turn burned (mirrors
      // the named-refusal reply shape). The user's answer in the thread (e.g.
      // "on main") carries the ref on the next message and re-attach binds it.
      if (err instanceof ResidentNeedsRefError) {
        await io.reply(
          `🌿 Which branch of \`${repoCtx.repo}\` should this thread work on? ` +
            `No branch is bound yet — reply naming one (e.g. "on main" or "on branch fix/login") and I'll pick it up from there.`,
        );
        return;
      }
      throw err;
    }
    const { executor, note } = selection;

    // Effective system prompt, composed AFTER executor resolution (via
    // RunOptions.system, U1): a resident-path run swaps in the agent's
    // resident variant — the workspace is a ready worktree, no cloning, no
    // installs — with the resolved repo named. Every other path keeps the
    // agent's own prompt. The shared AgentDef is never mutated (concurrent
    // dispatches share it).
    const system =
      executor instanceof ResidentExecutor && agent.residentSystem
        ? `${agent.residentSystem}\n\nTarget repository: ${repoCtx.repo}. The worktree is already on this thread's bound branch (confirm with \`git branch --show-current\`).`
        : undefined;

    const label = `*${agent.name}* on \`${resolved.modelRef}\`` + (note ? ` · ${note}` : "");
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
        system,
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

// ---- deterministic ops fast-path (U6, KTD8) ---------------------------------

/** Gate + execute one recognized op. Returns the reply text, or null to fall
 *  through to the agent path. Refusals are replies (a refused user must see
 *  why), and only the model call is ever skipped — never the permission
 *  machinery. */
async function runOperationFastPath(
  deps: CoreDeps,
  msg: IncomingMessage,
  ask: RecognizedOp,
): Promise<string | null> {
  // The implicit target agent for a deterministic op is coding (KTD8): the
  // exact refusal a normal coding-agent request would get, op never executed.
  if (!deps.config.canRunAgent(msg.userId, "coding")) {
    return `🚫 You're not on the allowlist for the \`coding\` agent. Ask ${deps.config.adminsHint()} for access.`;
  }
  if (!deps.config.canUseRepo(msg.userId, ask.repo)) {
    return `🚫 You're not on the allowlist for the \`${ask.repo}\` repo environment. Ask ${deps.config.adminsHint()} for access.`;
  }
  const ops = deps.operations ?? defaultOperations(deps, msg.threadKey);
  if (!ops) {
    return ask.explicit
      ? "⚠️ Deterministic ops need a backend: configure `execution.resident` (with its operator token) or local execution."
      : null;
  }
  console.log(
    `[op] ${msg.threadKey} user=${msg.userId} op=${ask.op} repo=${ask.repo} ref=${ask.ref ?? "(default)"} explicit=${ask.explicit}`,
  );
  const result = await ops
    .run(ask.op, { repo: ask.repo, ...(ask.ref ? { ref: ask.ref } : {}) })
    .catch((err: unknown) => ({ kind: "error" as const, message: err instanceof Error ? err.message : String(err) }));
  switch (result.kind) {
    case "result": {
      const icon = result.ok ? "✅" : "❌";
      const output = result.output?.trim();
      return output ? `${icon} ${result.summary}\n\`\`\`\n${clipOpOutput(output)}\n\`\`\`` : `${icon} ${result.summary}`;
    }
    case "refused":
      return `🚫 ${result.reason}`;
    case "not-onboarded":
      return ask.explicit
        ? `⚠️ \`${ask.repo}\` is not onboarded as a resident, so \`repo ${ask.op}\` has nothing to run against — \`repo onboard ${ask.repo}\` first, or ask the coding agent directly.`
        : null; // natural language: the agent path can still serve the ask
    case "error":
      return ask.explicit ? `⚠️ ${result.message}` : null;
  }
}

/** Default Operations backend, mirroring executor selection's config reads:
 *  resident-backed wherever a resident service is configured, local for local
 *  execution (the thread's local workspace dir — dev/CLI), else none. */
function defaultOperations(deps: CoreDeps, threadKey: string): Operations | null {
  const execution = deps.config.config.execution;
  const resident = execution?.resident;
  if (resident?.baseUrl) {
    const tokenEnv = resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN";
    const token = process.env[tokenEnv];
    return token ? new ResidentOperations({ baseUrl: resident.baseUrl, token }) : null;
  }
  if (!execution?.type || execution.type === "local") {
    const safe = threadKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return new LocalOperations(resolve(deps.config.config.workspaceDir ?? "./workspaces", safe));
  }
  return null; // per-thread remote backends have no deterministic-op surface
}

/** Failures usually speak from the END of the output — keep the tail. */
function clipOpOutput(output: string): string {
  const MAX = 3000;
  return output.length > MAX ? `…${output.slice(-MAX)}` : output;
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
    "",
    "*Repo commands* (resident environments; management verbs admin-gated):",
    "`repo list` — onboarded repos + lifecycle state",
    '`repo onboard <owner/name> [ref=<branch>] [test="<cmd>"] [build="<cmd>"] [install="<cmd>"]`',
    '`repo reconfigure <owner/name> [ref=…] [test="…"] [build="…"] [install="…"]`',
    "`repo offboard <owner/name> [--dry-run]` / `repo rebuild <owner/name> [--dry-run]`",
    "`repo test <owner/name> [<ref>]` / `repo build <owner/name> [<ref>]` — run the repo's onboarded command with no model turn (also: \"run the tests on <ref> in <owner/name>\")",
  ].join("\n");
}
