import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EFFORT_LEVELS_HINT, isEffort, type Effort } from "./effort.js";
import YAML from "yaml";
import type { ProviderConfig } from "./providers/types.js";
import type { MemoryConfig } from "./core/memory/types.js";
import type { SelfImprovementConfig } from "./core/selfImprovement.js";
import type { SchedulesConfig } from "./core/scheduleStore.js";
import type { RunHistoryConfig } from "./core/runStore.js";
import type { ChatGate } from "./core/commandRegistry.js";
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
  /** Force a model effort regardless of agent (same shape as `model`). */
  effort?: Effort;
  /** Per-agent effort overrides for this scope (same shape as `models`). */
  efforts?: Record<string, Effort>;
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
  /**
   * Cloudflare Access identities (`access:<sub>`) allowed `*:write` commands
   * over HTTP (`runs.stop`, …). Browser Access sessions hold every `*:read`
   * scope implicitly; writes require being listed here (KTD10). Chat
   * operators are `admins`, not this list.
   */
  operators?: string[];
  /**
   * Cloudflare Access service tokens (the machine credential for `/api/*`),
   * keyed by the token's `common_name` claim, each mapped to the exact command
   * scopes it holds (`runs:read`, `runs:write`, …). No implicit scopes: an
   * unlisted service token holds nothing (KTD10/KTD13).
   */
  serviceTokens?: Record<string, string[]>;
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  defaults: {
    agent: string;
    /** default model per agent, e.g. { general: "anthropic/claude-opus-5" } */
    models: Record<string, string>;
    /** default effort per agent, e.g. { coding: "medium" }; unset → the agent
     *  definition's effort, else the provider's default */
    efforts?: Record<string, Effort>;
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
  /**
   * Persistent run history (#157). Absent → history is OFF: finished runs stay
   * live-only, as before. `store: "file"` is an explicit host-disk opt-in;
   * otherwise `worker` names the RunHistoryDO on the state Worker. Retention
   * is `retentionDays` / `maxRuns` / `maxBytes`. See features/run-history.md.
   */
  runHistory?: RunHistoryConfig;
}

export interface SlackConfig {
  /**
   * Reconnect catch-up (#184): on every Socket Mode (re)connect, re-read
   * recent history of every channel the bot is in and dispatch mentions /
   * follow-ups that carry no receipt from us (no 👀, no bot reply after them).
   * Absent = enabled with a 30-minute window.
   */
  catchUp?: {
    enabled?: boolean;
    /**
     * Messages older than this are left alone even if unanswered. Must cover
     * the worst deploy blackout — the 15-min graceful-drain deadline plus a
     * cold start (`MIN_CATCH_UP_WINDOW_MS`, 20 min; #272). A smaller value is
     * kept as configured but warned about at startup.
     */
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
  /** Resolved through the config layers only; undefined = no layer set it (the
   *  agent definition, then the provider default, decide downstream). */
  effort?: Effort;
}

export class ConfigStore {
  readonly config: AppConfig;
  private overrides: Overrides;
  private overridesPath: string;

  /** `warn` receives non-fatal config findings (default: console.warn). */
  constructor(configPath: string, overridesPath: string, warn: (message: string) => void = (m) => console.warn(m)) {
    const raw = readFileSync(resolve(configPath), "utf8");
    this.config = YAML.parse(raw) as AppConfig;
    validateConfig(this.config, warn);

    this.overridesPath = resolve(overridesPath);
    this.overrides = existsSync(this.overridesPath)
      ? (JSON.parse(readFileSync(this.overridesPath, "utf8")) as Overrides)
      : { channels: {}, users: {} };
    this.overrides.channels ??= {};
    this.overrides.users ??= {};
    // The chat command enforces the cap on write; a hand-edited overrides.json
    // is the one way around it, so hold it to the same bound at load.
    validateInstructions(this.overrides, `overrides (${this.overridesPath})`);
    validateScopeEfforts(this.overrides, `overrides (${this.overridesPath})`);
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
   * Resolve which agent, model, and effort serve a request.
   * Agent:  request directive > user scope > channel scope > default.
   * Model:  request directive > (user > channel) forced model
   *         > (user > channel > defaults) per-agent model.
   * Effort: the same ladder as model; unset at every layer → undefined.
   */
  resolve(opts: {
    channelId: string;
    userId: string;
    request: { agent?: string; model?: string; effort?: Effort };
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

    const effort =
      opts.request.effort ??
      us.effort ??
      ch.effort ??
      us.efforts?.[agentName] ??
      ch.efforts?.[agentName] ??
      this.config.defaults.efforts?.[agentName];

    return { agentName, modelRef, ...(effort !== undefined ? { effort } : {}) };
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

  /**
   * The `operator` chat gate of the command registry (KTD10): FAIL-CLOSED —
   * true iff `permissions.admins` lists the user; no admins, no operators.
   * Public on purpose (unlike `isAdmin`) so the registry can name its gate.
   */
  isOperator(userId: string): boolean {
    return this.isAdmin(userId);
  }

  /** Resolves a command's `ChatGate` for one chat caller: `open` → everyone,
   *  `operator` → `isOperator`, `repoManager` → `canManageRepos`, `channelConfig`
   *  → `canEditChannelConfig` (open when unconfigured), `agentRun` →
   *  `canRunAgent(userId, "coding")`. */
  chatGateFor(userId: string): (gate: ChatGate) => boolean {
    return (gate) => {
      switch (gate) {
        case "open":
          return true;
        case "operator":
          return this.isOperator(userId);
        case "repoManager":
          return this.canManageRepos(userId);
        case "channelConfig":
          return this.canEditChannelConfig(userId);
        case "agentRun":
          return this.canRunAgent(userId, "coding");
      }
    };
  }

  /** `permissions.operators`: Access identities granted `*:write` over HTTP. */
  operatorIdentities(): string[] {
    return [...(this.config.permissions?.operators ?? [])];
  }

  /** `permissions.serviceTokens[<common_name>]`: the exact scopes an Access
   *  service token holds; `[]` (nothing) when it is not listed. */
  serviceTokenScopes(commonName: string): string[] {
    const scopes = this.config.permissions?.serviceTokens?.[commonName];
    return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
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

  /** What `config show` reports for one user in one channel — structured; the
   *  text surfaces render it with `formatConfigDescription`. */
  describeConfig(channelId: string, userId: string): ConfigDescription {
    const resolved = this.resolve({ channelId, userId, request: {} });
    return {
      effective: { agent: resolved.agentName, model: resolved.modelRef, ...(resolved.effort ? { effort: resolved.effort } : {}) },
      defaults: { agent: this.config.defaults.agent, models: this.config.defaults.models, ...(this.config.defaults.efforts ? { efforts: this.config.defaults.efforts } : {}) },
      channel: this.channelScope(channelId),
      user: this.userScope(userId),
      restrictedAgents: this.restrictedAgentsFor(userId),
      channelConfigRestricted: !this.canEditChannelConfig(userId),
      adminsHint: this.adminsHint(),
    };
  }

  /** `config show` as text. */
  describe(channelId: string, userId: string): string {
    return formatConfigDescription(this.describeConfig(channelId, userId));
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

export interface ConfigDescription {
  effective: { agent: string; model: string; effort?: Effort };
  defaults: { agent: string; models: Record<string, string>; efforts?: Record<string, Effort> };
  channel: Scope;
  user: Scope;
  restrictedAgents: string[];
  channelConfigRestricted: boolean;
  adminsHint: string;
}

/** The `config show` text (chat + CLI) for a `ConfigDescription`. */
export function formatConfigDescription(d: ConfigDescription): string {
  const effective = `agent \`${d.effective.agent}\`, model \`${d.effective.model}\`${d.effective.effort ? `, effort \`${d.effective.effort}\`` : ""}`;
  const defaults =
    `agent \`${d.defaults.agent}\`, models ${fmtModels(d.defaults.models)}` +
    (d.defaults.efforts && Object.keys(d.defaults.efforts).length > 0 ? `, efforts ${fmtModels(d.defaults.efforts)}` : "");
  const lines = [`*Effective for you in this channel:* ${effective}`, `*Defaults:* ${defaults}`, `*Channel scope:* ${fmtScope(d.channel)}`, `*Your scope:* ${fmtScope(d.user)}`];
  const channelInstructions = d.channel.instructions?.trim();
  if (channelInstructions) lines.push(`*Channel instructions:* ${channelInstructions}`);
  const userInstructions = d.user.instructions?.trim();
  if (userInstructions) lines.push(`*Your instructions:* ${userInstructions}`);
  if (d.restrictedAgents.length > 0) lines.push(`*Not available to you:* ${d.restrictedAgents.map((a) => `\`${a}\``).join(", ")} (ask ${d.adminsHint})`);
  if (d.channelConfigRestricted) lines.push(`*Note:* channel config changes are restricted (ask ${d.adminsHint})`);
  return lines.join("\n");
}

function fmtScope(s: Scope): string {
  const parts: string[] = [];
  if (s.agent) parts.push(`agent \`${s.agent}\``);
  if (s.model) parts.push(`model \`${s.model}\``);
  if (s.models && Object.keys(s.models).length > 0) parts.push(`models ${fmtModels(s.models)}`);
  if (s.effort) parts.push(`effort \`${s.effort}\``);
  if (s.efforts && Object.keys(s.efforts).length > 0) parts.push(`efforts ${fmtModels(s.efforts)}`);
  return parts.length > 0 ? parts.join(", ") : "_none_";
}

/** Reject an effort value outside EFFORT_LEVELS wherever config can carry one
 *  (static scopes, `defaults.efforts`, a hand-edited overrides.json). The chat
 *  command validates on write; this holds the files to the same rule at load. */
function validateScopeEfforts(
  layer: { channels?: Record<string, Scope>; users?: Record<string, Scope>; defaults?: { efforts?: Record<string, unknown> } },
  source: string,
): void {
  const check = (path: string, value: unknown) => {
    if (value !== undefined && !isEffort(value)) {
      throw new Error(`${source}: ${path} is "${String(value)}" — valid efforts: ${EFFORT_LEVELS_HINT}`);
    }
  };
  for (const [agent, value] of Object.entries(layer.defaults?.efforts ?? {})) check(`defaults.efforts.${agent}`, value);
  for (const [kind, scopes] of [["channels", layer.channels], ["users", layer.users]] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) {
      check(`${kind}.${id}.effort`, scope.effort);
      for (const [agent, value] of Object.entries(scope.efforts ?? {})) check(`${kind}.${id}.efforts.${agent}`, value);
    }
  }
}

function fmtModels(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `\`${k}=${v}\``)
    .join(" ");
}

function validateConfig(cfg: AppConfig, warn: (message: string) => void): void {
  validateScopeEfforts(cfg, "config.yaml");
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
  if (cfg.runHistory !== undefined) validateRunHistory(cfg.runHistory, cfg.selfImprovement, warn);
}

/** `runHistory` (features/run-history.md, KTD14): retention bounds are enforced
 *  at load so a typo cannot silently become "keep nothing"; the Worker URL must
 *  be https: because the bearer rides every request. */
function validateRunHistory(rh: RunHistoryConfig, si: SelfImprovementConfig | undefined, warn: (message: string) => void): void {
  if (typeof rh !== "object" || rh === null) throw new Error("config.yaml: runHistory must be a mapping");
  for (const key of ["retentionDays", "maxRuns"] as const) {
    const v = rh[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1)) throw new Error(`config.yaml: runHistory.${key} must be an integer >= 1`);
  }
  if (rh.maxBytes !== undefined && (!Number.isInteger(rh.maxBytes) || rh.maxBytes < 1)) throw new Error("config.yaml: runHistory.maxBytes must be an integer >= 1");
  if (rh.store !== undefined && rh.store !== "worker" && rh.store !== "file") throw new Error('config.yaml: runHistory.store must be "worker" or "file"');
  if (rh.worker !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(String(rh.worker.baseUrl));
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== "https:") throw new Error("config.yaml: runHistory.worker.baseUrl must be an https: URL");
  }
  if (si?.ledgerMax !== undefined) {
    warn(
      "config.yaml: selfImprovement.ledgerMax is set alongside runHistory — the friction ledger is now read from the run store, " +
        "so runHistory.retentionDays/maxRuns bound the friction population; ledgerMax only affects the legacy FrictionDO writes.",
    );
  }
}
