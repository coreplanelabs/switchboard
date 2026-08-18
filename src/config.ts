import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import type { ProviderConfig } from "./providers/types.js";
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
}

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
  }

  private channelScope(channelId: string): Scope {
    return { ...this.config.channels?.[channelId], ...this.overrides.channels[channelId] };
  }

  private userScope(userId: string): Scope {
    return { ...this.config.users?.[userId], ...this.overrides.users[userId] };
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

  canEditChannelConfig(userId: string): boolean {
    const allowlist = this.config.permissions?.channelConfig;
    if (!allowlist) return true; // key absent = everyone
    return this.isAdmin(userId) || allowlist.includes(userId);
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

  setChannelOverride(channelId: string, patch: Scope): Scope {
    this.overrides.channels[channelId] = { ...this.overrides.channels[channelId], ...patch };
    this.save();
    return this.channelScope(channelId);
  }

  setUserOverride(userId: string, patch: Scope): Scope {
    this.overrides.users[userId] = { ...this.overrides.users[userId], ...patch };
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
}
