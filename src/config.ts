import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import type { ProviderConfig } from "./providers/types.js";
import type { MemoryConfig } from "./core/memory/types.js";
import type { SelfImprovementConfig } from "./core/selfImprovement.js";
import type { SchedulesConfig } from "./core/scheduleStore.js";
import { AGENTS } from "./agents/registry.js";

// Configuration is layered. Lowest to highest precedence:
//   1. defaults (config.yaml `defaults`, incl. per-agent default models)
//   2. channel overrides (config.yaml `channels` merged with runtime store)
//   3. user overrides    (config.yaml `users`    merged with runtime store)
//   4. per-request directives parsed from the message (agent:x model:p/m)
// Runtime overrides set via chat commands persist to data/overrides.json.

export interface Scope {
  /** Force which agent handles requests in this scope. */
  agent?: string;
  /** Force a model (provider/model) regardless of agent. */
  model?: string;
  /** Per-agent model overrides for this scope. */
  models?: Record<string, string>;
  /**
   * Free-text custom instructions folded into the system prompt as ADVISORY
   * content only (#107 phase 2). Channel text applies to every run in the
   * channel; user text applies only to runs that user requests. Never read by
   * `resolve()` or any permission gate. Capped at MAX_INSTRUCTIONS_LENGTH
   * because it rides every turn.
   */
  instructions?: string;
}

/** Upper bound on one scope's `instructions` text (prepended to every turn). */
export const MAX_INSTRUCTIONS_LENGTH = 2000;

export interface Permissions {
  /** Users who bypass all restrictions below. */
  admins?: string[];
  /** If an agent is listed, only these users (+ admins) may run it. */
  agents?: Record<string, string[]>;
  /**
   * If present, only these users (+ admins) may run `config set channel` /
   * `config clear channel`. Empty list = admins only. Absent = everyone.
   */
  channelConfig?: string[];
  /**
   * Per-repo access for resident environments (repo slug -> allowed user
   * IDs). Open-when-absent (KD7): no map, or a repo not listed in it, means
   * every allowed coding-agent user may use that repo. A configured allowlist
   * refuses non-listed users BY NAME (never a silent per-thread fallback).
   */
  repos?: Record<string, string[]>;
  /**
   * Who may run repo-management commands (`repo onboard/offboard/reconfigure/
   * rebuild`). FAIL-CLOSED (KTD9): key absent or empty = ADMINS ONLY —
   * deliberately diverging from channelConfig's open-when-absent, because
   * onboarding provisions billable always-on compute and binds GitHub
   * credentials. `repo list` is never gated.
   */
  repoManagement?: string[];
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  defaults: {
    agent: string;
    /** default model per agent, e.g. { general: "anthropic/claude-opus-5" } */
    models: Record<string, string>;
    maxTokens?: number;
  };
  channels?: Record<string, Scope>;
  users?: Record<string, Scope>;
  permissions?: Permissions;
  execution?: import("./execution/factory.js").ExecutionConfig;
  workspaceDir?: string;
  /** Output-formatting behavior (channel-formatter feature, #76). */
  output?: OutputConfig;
  /**
   * Cross-session self-learning memory (Area 7c, #85). Absent or `enabled:
   * false` (the default) → the dispatcher uses a NullMemoryStore and model
   * input is byte-identical to memory-off. See features/memory.md.
   */
  memory?: MemoryConfig;
  /**
   * Self-improvement proposals (Area 7b, #84): where `friction propose` files
   * issues and how it clusters. Absent → runs are still recorded to the
   * friction ledger, but `friction propose` refuses until `repo` is set.
   * See features/self-improvement.md.
   */
  selfImprovement?: SelfImprovementConfig;
  /**
   * Scheduled jobs (#244): where the Worker shim's cron firings are recorded
   * (the state Worker's ScheduleDO) so the /runs "Scheduled" panel can show last
   * fire / outcome / run. Absent → the panel lists the schedules without firing
   * history. See features/live-view.md item 14.
   */
  schedules?: SchedulesConfig;
  /**
   * Spend reporting (`GET /costs`): which Cloudflare Workers / container apps
   * / Anthropic workspace make up each named group. Validated at startup by
   * `parseCostsConfig` (src/core/costs.ts); absent → the view answers 503.
   */
  costs?: unknown;
  /** Slack adapter behavior that is not pure transport. */
  slack?: SlackConfig;
}

export interface SlackConfig {
  /**
   * Reconnect catch-up (#184): on every Socket Mode (re)connect, re-read
   * recent history of every channel the bot is in and dispatch mentions /
   * follow-ups that carry no receipt from us (no 👀, no bot reply after them).
   * Absent = enabled with a 20-minute window.
   */
  catchUp?: {
    enabled?: boolean;
    /** Messages older than this are left alone even if unanswered. */
    windowMinutes?: number;
  };
}

export interface OutputConfig {
  /**
   * When true, an agent's answer is converted to a channel-agnostic structured
   * representation, zod-validated with fixed-retry self-heal, then rendered by
   * the target channel's ChannelFormatter (Slack → mrkdwn, CLI/HTTP/MCP →
   * plain). Default false → today's behavior exactly (the Markdown answer is
   * sent via `io.reply`, which each channel converts as before).
   */
  structured?: boolean;
}

export interface Overrides {
  channels: Record<string, Scope>;
  users: Record<string, Scope>;
}

export interface ResolvedRequest {
  agentName: string;
  modelRef: string; // provider/model
}

export class ConfigStore {
  readonly config: AppConfig;
  private overrides: Overrides;
  private overridesPath: string;

  constructor(configPath: string, overridesPath: string) {
    const raw = readFileSync(resolve(configPath), "utf8");
    this.config = YAML.parse(raw) as AppConfig;
    validateConfig(this.config);

    this.overridesPath = resolve(overridesPath);
    this.overrides = existsSync(this.overridesPath)
      ? (JSON.parse(readFileSync(this.overridesPath, "utf8")) as Overrides)
      : { channels: {}, users: {} };
    this.overrides.channels ??= {};
    this.overrides.users ??= {};
    // The chat command enforces the cap on write; a hand-edited overrides.json
    // is the one way around it, so hold it to the same bound at load.
    validateInstructions(this.overrides, `overrides (${this.overridesPath})`);
  }

  private channelScope(channelId: string): Scope {
    return { ...this.config.channels?.[channelId], ...this.overrides.channels[channelId] };
  }

  private userScope(userId: string): Scope {
    return { ...this.config.users?.[userId], ...this.overrides.users[userId] };
  }

  /**
   * The effective channel and user scopes (static config merged with runtime
   * overrides) — what `resolve()` layers on top of the defaults. Read-only
   * view for the dispatcher's system-prompt config block.
   */
  scopes(channelId: string, userId: string): { channel: Scope; user: Scope } {
    return { channel: this.channelScope(channelId), user: this.userScope(userId) };
  }

  /**
   * Resolve which agent and model serve a request.
   * Agent: request directive > user scope > channel scope > default.
   * Model: request directive > (user > channel) forced model
   *        > (user > channel > defaults) per-agent model.
   */
  resolve(opts: {
    channelId: string;
    userId: string;
    request: { agent?: string; model?: string };
  }): ResolvedRequest {
    const ch = this.channelScope(opts.channelId);
    const us = this.userScope(opts.userId);

    const agentName =
      opts.request.agent ?? us.agent ?? ch.agent ?? this.config.defaults.agent;

    const modelRef =
      opts.request.model ??
      us.model ??
      ch.model ??
      us.models?.[agentName] ??
      ch.models?.[agentName] ??
      this.config.defaults.models[agentName] ??
      this.config.defaults.models["general"];

    if (!modelRef) {
      throw new Error(
        `No model configured for agent "${agentName}" — set defaults.models.${agentName} in config.yaml`,
      );
    }
    return { agentName, modelRef };
  }

  // ---- permissions ---------------------------------------------------------
  // Absent config = open. Enforcement happens at run time against the
  // *resolved* agent, so no config layer (including "config set me") can
  // bypass an agent allowlist.

  private isAdmin(userId: string): boolean {
    return this.config.permissions?.admins?.includes(userId) ?? false;
  }

  canRunAgent(userId: string, agentName: string): boolean {
    const allowlist = this.config.permissions?.agents?.[agentName];
    if (!allowlist) return true; // agent not restricted
    return this.isAdmin(userId) || allowlist.includes(userId);
  }

  /** Per-repo access for resident environments (KD7: open-when-absent). */
  canUseRepo(userId: string, slug: string): boolean {
    const allowlist = this.config.permissions?.repos?.[slug];
    if (!allowlist) return true; // repo (or the whole map) not restricted
    return this.isAdmin(userId) || allowlist.includes(userId);
  }

  canEditChannelConfig(userId: string): boolean {
    const allowlist = this.config.permissions?.channelConfig;
    if (!allowlist) return true; // key absent = everyone
    return this.isAdmin(userId) || allowlist.includes(userId);
  }

  /**
   * Repo-management gate (KTD9): FAIL-CLOSED, deliberately diverging from
   * canEditChannelConfig's open-when-absent — no `repoManagement` config means
   * admins only, because `repo onboard`/`rebuild` provision billable always-on
   * compute and bind GitHub credentials. Session-settled decision (KTD9).
   */
  canManageRepos(userId: string): boolean {
    if (this.isAdmin(userId)) return true;
    return this.config.permissions?.repoManagement?.includes(userId) ?? false;
  }

  /** Who to ask when denied — for actionable error messages. */
  adminsHint(): string {
    const admins = this.config.permissions?.admins ?? [];
    return admins.length > 0 ? admins.map((u) => `<@${u}>`).join(", ") : "an admin";
  }

  /** Agents restricted by allowlist that this user cannot run. */
  restrictedAgentsFor(userId: string): string[] {
    const agents = this.config.permissions?.agents ?? {};
    return Object.keys(agents).filter((a) => !this.canRunAgent(userId, a));
  }

  /**
   * Merge a patch into a scope's runtime override. A key set to `undefined`
   * in the patch is DELETED from the override (not stored as undefined), so
   * the in-memory scope and the reloaded-from-disk scope agree: the static
   * config.yaml value for that key shows through again in both.
   */
  setChannelOverride(channelId: string, patch: Scope): Scope {
    this.overrides.channels[channelId] = mergeScope(this.overrides.channels[channelId], patch);
    this.save();
    return this.channelScope(channelId);
  }

  setUserOverride(userId: string, patch: Scope): Scope {
    this.overrides.users[userId] = mergeScope(this.overrides.users[userId], patch);
    this.save();
    return this.userScope(userId);
  }

  clearChannelOverride(channelId: string): void {
    delete this.overrides.channels[channelId];
    this.save();
  }

  clearUserOverride(userId: string): void {
    delete this.overrides.users[userId];
    this.save();
  }

  describe(channelId: string, userId: string): string {
    const resolved = this.resolve({ channelId, userId, request: {} });
    const lines = [
      `*Effective for you in this channel:* agent \`${resolved.agentName}\`, model \`${resolved.modelRef}\``,
      `*Defaults:* agent \`${this.config.defaults.agent}\`, models ${fmtModels(this.config.defaults.models)}`,
      `*Channel scope:* ${fmtScope(this.channelScope(channelId))}`,
      `*Your scope:* ${fmtScope(this.userScope(userId))}`,
    ];
    const channelInstructions = this.channelScope(channelId).instructions?.trim();
    if (channelInstructions) lines.push(`*Channel instructions:* ${channelInstructions}`);
    const userInstructions = this.userScope(userId).instructions?.trim();
    if (userInstructions) lines.push(`*Your instructions:* ${userInstructions}`);
    const denied = this.restrictedAgentsFor(userId);
    if (denied.length > 0) {
      lines.push(`*Not available to you:* ${denied.map((a) => `\`${a}\``).join(", ")} (ask ${this.adminsHint()})`);
    }
    if (!this.canEditChannelConfig(userId)) {
      lines.push(`*Note:* channel config changes are restricted (ask ${this.adminsHint()})`);
    }
    return lines.join("\n");
  }

  private save(): void {
    mkdirSync(dirname(this.overridesPath), { recursive: true });
    writeFileSync(this.overridesPath, JSON.stringify(this.overrides, null, 2));
  }
}

/** Every scope's `instructions` (both kinds, either file) must be a string within the cap. */
function validateInstructions(layer: { channels?: Record<string, Scope>; users?: Record<string, Scope> }, source: string): void {
  for (const [kind, scopes] of [["channels", layer.channels], ["users", layer.users]] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) {
      if (scope.instructions !== undefined && typeof scope.instructions !== "string") {
        throw new Error(`${source}: ${kind}.${id}.instructions must be a string`);
      }
      if ((scope.instructions?.length ?? 0) > MAX_INSTRUCTIONS_LENGTH) {
        throw new Error(`${source}: ${kind}.${id}.instructions exceeds ${MAX_INSTRUCTIONS_LENGTH} characters`);
      }
    }
  }
}

function mergeScope(current: Scope | undefined, patch: Scope): Scope {
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as Scope;
}

function fmtScope(s: Scope): string {
  const parts: string[] = [];
  if (s.agent) parts.push(`agent \`${s.agent}\``);
  if (s.model) parts.push(`model \`${s.model}\``);
  if (s.models && Object.keys(s.models).length > 0) parts.push(`models ${fmtModels(s.models)}`);
  return parts.length > 0 ? parts.join(", ") : "_none_";
}

function fmtModels(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `\`${k}=${v}\``)
    .join(" ");
}

function validateConfig(cfg: AppConfig): void {
  if (!cfg.providers || Object.keys(cfg.providers).length === 0) {
    throw new Error("config.yaml must define at least one provider");
  }
  if (!cfg.defaults?.agent || !cfg.defaults?.models) {
    throw new Error("config.yaml must define defaults.agent and defaults.models");
  }
  if (!AGENTS[cfg.defaults.agent]) {
    throw new Error(`defaults.agent "${cfg.defaults.agent}" is not a known agent`);
  }
  // Static instructions ride every turn too — hold them to the same cap the
  // chat command enforces, and fail loudly at load rather than silently truncate.
  validateInstructions(cfg, "config.yaml");
  // Normalize permissions.repos keys to lowercase once at load: every caller
  // looks the repo up by a lowercased slug (parseSlug/slugOf/repoResourceId),
  // so a mixed-case allowlist key (e.g. "octocat/Hello-World") would otherwise
  // never match and silently grant open access instead of restricting.
  if (cfg.permissions?.repos) {
    cfg.permissions.repos = Object.fromEntries(
      Object.entries(cfg.permissions.repos).map(([slug, users]) => [slug.toLowerCase(), users]),
    );
  }
}
