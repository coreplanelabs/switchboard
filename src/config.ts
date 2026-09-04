import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EFFORT_LEVELS_HINT, isEffort, type Effort } from "./effort.js";
import YAML from "yaml";
import type { ProviderConfig } from "./providers/types.js";
import type { MemoryConfig } from "./core/memory/types.js";
import type { SelfImprovementConfig } from "./core/selfImprovement.js";
import type { SchedulesConfig } from "./core/scheduleStore.js";
import type { RunHistoryConfig } from "./core/runStore.js";
import type { ShipConfig } from "./core/shipPipeline.js";
import type { ChatGate } from "./core/commandRegistry.js";
import { AGENTS } from "./agents/registry.js";
import { assertUrlAllowed } from "./tools/web.js";
import { isMcpServerEntry, MCP_SELF_SERVE_AGENTS, MCP_SERVER_NAME_MAX, MCP_SERVER_NAME_RE, MCP_SERVERS_PER_SCOPE_MAX, type McpServerEntry } from "./mcp/registry.js";

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
  /**
   * External MCP servers this scope contributes to runs (features/mcp-tools.md
   * items 11–17), by name. Runs see the UNION of the org (`defaults`), channel,
   * and user tiers; a name present in more than one tier resolves to the
   * highest-trust tier (org > channel > user) — the opposite of the other
   * settings, because an org server is an admin's decision a user must not
   * shadow. Channel and user entries may name `general`/`research` only.
   * Static entries supply a bearer via `tokenEnv`; runtime entries (added with
   * `mcp add`) get their credential from the sealed secret store.
   */
  mcpServers?: Record<string, McpServerEntry>;
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
    /** Org-wide MCP servers pinned by the operator (features/mcp-tools.md item 11). */
    mcpServers?: Record<string, McpServerEntry>;
  };
  channels?: Record<string, Scope>;
  users?: Record<string, Scope>;
  permissions?: Permissions;
  execution?: import("./execution/factory.js").ExecutionConfig;
  workspaceDir?: string;
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
  /** Review-run behavior: the reading-diff artifact's provider switch
   *  (`git` | `meat` | `off`; env `SWITCHBOARD_READING_DIFF` overrides).
   *  See features/reading-diff.md. */
  review?: { readingDiff?: import("./core/readingDiff.js").ReadingDiffConfig };
  /**
   * agent:ship pipeline caps (features/agent-ship.md item 8): `maxRounds`
   * review rounds (default 3) and `maxMinutes` of pipeline wall clock
   * (default 120) — whichever hits first ends the loop, and each child round
   * runs its own agent budget clipped to the remaining pipeline time.
   * Deployment-level like `review`; validated at load.
   */
  ship?: ShipConfig;
  /** Slack adapter behavior that is not pure transport. */
  slack?: SlackConfig;
  /**
   * Persistent run history (#157). Absent → history is OFF: finished runs stay
   * live-only, as before. `store: "file"` is an explicit host-disk opt-in;
   * otherwise `worker` names the RunHistoryDO on the state Worker. Retention
   * is `retentionDays` / `maxRuns` / `maxBytes`. See features/run-history.md.
   */
  runHistory?: RunHistoryConfig;
  /**
   * Where chat-set runtime overrides (`config set`, `config instructions`, …)
   * persist (features/routing-and-config.md item 12). Absent → the JSON file
   * (`data/overrides.json`; ephemeral on Cloudflare Containers). `worker`
   * names the ConfigDO on the state Worker — the production choice; the bearer
   * comes from `tokenEnv` (default `MEMORY_TOKEN`). Validated at load.
   */
  runtimeOverrides?: { worker?: { baseUrl: string; tokenEnv?: string } };
  /**
   * External MCP servers as agent tools (#394, features/mcp-tools.md item 11):
   * `servers[]` of `{ name, url, auth?: { type: bearer, tokenEnv }, agents? }`.
   * Parsed and validated by `parseMcpConfig` (src/mcp/config.ts) at startup —
   * the bearer is read from the environment there, never stored here. Absent
   * → no MCP tools, requests byte-identical to before the feature.
   */
  mcp?: unknown;
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

export interface Overrides {
  channels: Record<string, Scope>;
  users: Record<string, Scope>;
  /** Org-wide runtime settings (today: `mcpServers` added with `mcp add --scope org`);
   *  layered over `defaults`. Optional so documents written before it existed load. */
  org?: Scope;
}

/**
 * Where runtime overrides live (features/routing-and-config.md item 12). Two
 * implementations behind one seam (AGENTS.md invariant 2): `FileOverridesBacking`
 * — a JSON file, the local-dev / single-host choice — and `WorkerOverridesBacking`
 * — the `ConfigDO` on the state Worker, the production choice, because the
 * container disk is wiped on every restart (invariant 6). `InMemoryOverridesBacking`
 * serves tests. The store loads the document ONCE at open and saves the whole
 * document on every write; documents are small (one entry per channel/user
 * that ever set something).
 */
export interface OverridesBacking {
  /** The stored document, or undefined when nothing was ever saved. */
  load(): Promise<Overrides | undefined>;
  /** Persist the whole document; throws on failure (the write is then rolled back). */
  save(overrides: Overrides): Promise<void>;
  /** Where it lives, for startup logs and error messages (never a secret). */
  describe(): string;
}

export class FileOverridesBacking implements OverridesBacking {
  private readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  /** Synchronous under the hood so the legacy `new ConfigStore(config, path)` can load it inline. */
  loadSync(): Overrides | undefined {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Overrides) : undefined;
  }
  async load(): Promise<Overrides | undefined> {
    return this.loadSync();
  }
  async save(overrides: Overrides): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(overrides, null, 2));
  }
  describe(): string {
    return `file ${this.path}`;
  }
}

export class InMemoryOverridesBacking implements OverridesBacking {
  saves = 0;
  /** When set, the next save throws with this message (tests of the rollback). */
  failNextSaveWith: string | undefined;
  /** When set, the next save is refused as stale: the stored document becomes
   *  this one (another writer's) and an `OverridesConflictError` is thrown. */
  conflictNextSaveWith: Overrides | undefined;
  /** When set, `conflictNextSaveWith` is re-armed with this after it fires (a second writer sneaks in during the rebase). */
  conflictAfterNextSaveWith: Overrides | undefined;
  constructor(public document: Overrides | undefined = undefined) {}
  async load(): Promise<Overrides | undefined> {
    return this.document ? structuredClone(this.document) : undefined;
  }
  async save(overrides: Overrides): Promise<void> {
    if (this.failNextSaveWith) {
      const m = this.failNextSaveWith;
      this.failNextSaveWith = undefined;
      throw new Error(m);
    }
    if (this.conflictNextSaveWith) {
      this.document = structuredClone(this.conflictNextSaveWith);
      this.conflictNextSaveWith = this.conflictAfterNextSaveWith;
      this.conflictAfterNextSaveWith = undefined;
      throw new OverridesConflictError();
    }
    this.saves++;
    this.document = structuredClone(overrides);
  }
  describe(): string {
    return "in-memory";
  }
}

/** A save refused because another writer saved first (the ConfigDO's 409).
 *  The store answers it by reloading and re-applying the change (`write`). */
export class OverridesConflictError extends Error {
  constructor() {
    super("config store: the overrides changed elsewhere since this process loaded them — retry the command");
    this.name = "OverridesConflictError";
  }
}

/** The one document key the overrides live under on the ConfigDO. */
export const OVERRIDES_DOCUMENT_KEY = "overrides";
export const CONFIG_WORKER_TIMEOUT_MS = 8_000;

export interface WorkerOverridesBackingOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/**
 * Route contract (JSON in/out, bearer = the Worker's MEMORY_TOKEN):
 *   POST /config/get {key}                          → {document: object | null, version: number}
 *   POST /config/put {key, document, expectedVersion} → {ok: true, version}  |  409 {error, version}
 * The version is optimistic concurrency: the bot is one instance, but the CLI
 * writes the same document, so a stale save is refused rather than clobbering.
 */
export class WorkerOverridesBacking implements OverridesBacking {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private version = 0;

  constructor(private readonly opts: WorkerOverridesBackingOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async load(): Promise<Overrides | undefined> {
    const body = await this.post("/config/get", { key: OVERRIDES_DOCUMENT_KEY });
    this.version = typeof body.version === "number" ? body.version : 0;
    const doc = body.document;
    if (doc === null || doc === undefined) return undefined;
    if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`config store returned a non-object overrides document`);
    return doc as Overrides;
  }

  async save(overrides: Overrides): Promise<void> {
    const body = await this.post("/config/put", { key: OVERRIDES_DOCUMENT_KEY, document: overrides, expectedVersion: this.version });
    this.version = typeof body.version === "number" ? body.version : this.version + 1;
  }

  describe(): string {
    return `state Worker ${this.baseUrl} (ConfigDO)`;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONFIG_WORKER_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`config store unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409) {
      // Another writer (the CLI, an earlier bot) saved first: take its version so
      // the NEXT save can go through; the store reloads the document and rebases.
      if (typeof body.version === "number") this.version = body.version;
      throw new OverridesConflictError();
    }
    if (!res.ok) throw new Error(`config store answered HTTP ${res.status} on ${path}`);
    return body;
  }
}

/** One MCP server as `mcpServersFor` resolves it for a run. */
export interface ResolvedMcpServer {
  name: string;
  kind: "org" | "channel" | "user";
  /** `org` | `channel:<id>` | `user:<id>` — with the name, the credential key. */
  scopeKey: string;
  entry: McpServerEntry;
  source: "config" | "runtime";
  /** Set when a higher-trust tier already contributed this name; this entry is not used. */
  shadowedBy?: string;
}

export interface ResolvedRequest {
  agentName: string;
  modelRef: string; // provider/model
  /** Resolved through the config layers only; undefined = no layer set it (the
   *  agent definition, then the provider default, decide downstream). */
  effort?: Effort;
}

/** Where runtime overrides are persisted, chosen from `config.yaml` (item 12):
 *  `runtimeOverrides.worker` names the state Worker's ConfigDO; absent → the
 *  JSON file at `overridesPath`. The Worker bearer comes from `tokenEnv`
 *  (default `MEMORY_TOKEN`); a configured Worker without its bearer is a
 *  startup error, never a silent fall back to the ephemeral file. */
export function overridesBackingFor(config: AppConfig, opts: { overridesPath: string; env: Record<string, string | undefined>; fetch?: typeof fetch }): OverridesBacking {
  const worker = config.runtimeOverrides?.worker;
  if (!worker) return new FileOverridesBacking(opts.overridesPath);
  const tokenEnv = worker.tokenEnv ?? "MEMORY_TOKEN";
  const token = opts.env[tokenEnv];
  if (!token) throw new Error(`runtimeOverrides.worker is configured but ${tokenEnv} is not set`);
  return new WorkerOverridesBacking({ baseUrl: worker.baseUrl, token, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

/** Read + validate `config.yaml` once; `warn` receives the non-fatal findings. */
export function loadAppConfig(configPath: string, warn: (message: string) => void): AppConfig {
  const config = YAML.parse(readFileSync(resolve(configPath), "utf8")) as AppConfig;
  validateConfig(config, warn);
  return config;
}

/** Open the store the way production does: parse + validate `config.yaml`,
 *  pick the overrides backing from it, load the document, construct. */
export async function openConfigStore(
  configPath: string,
  opts: { overridesPath: string; env: Record<string, string | undefined>; warn?: (message: string) => void; fetch?: typeof fetch },
): Promise<ConfigStore> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const config = loadAppConfig(configPath, warn);
  const backing = overridesBackingFor(config, opts);
  const initial = await backing.load();
  return new ConfigStore({ validated: config }, { backing, initial }, warn);
}

export class ConfigStore {
  readonly config: AppConfig;
  private overrides: Overrides;
  private readonly backing: OverridesBacking;
  /** Writes run one at a time (see `write`); a rejected write does not hold the queue. */
  private writes: Promise<void> = Promise.resolve();

  /** The first argument is the `config.yaml` path (read + validated here — dev,
   *  tests) or a config `openConfigStore` already validated. The second is a
   *  JSON file path (loaded inline) or a backing whose document was already
   *  loaded. `warn` receives non-fatal config findings (default: console.warn). */
  constructor(
    config: string | { validated: AppConfig },
    overrides: string | { backing: OverridesBacking; initial: Overrides | undefined },
    warn: (message: string) => void = (m) => console.warn(m),
  ) {
    this.config = typeof config === "string" ? loadAppConfig(config, warn) : config.validated;

    let initial: Overrides | undefined;
    if (typeof overrides === "string") {
      const file = new FileOverridesBacking(overrides);
      this.backing = file;
      initial = file.loadSync();
    } else {
      this.backing = overrides.backing;
      initial = overrides.initial;
    }
    this.overrides = this.checkedDocument(initial);
  }

  /** A loaded document, shaped and held to the chat path's caps: the chat
   *  command enforces them on write, so a hand-edited or otherwise-stored
   *  document is the one way around them — refuse it here, naming the backing. */
  private checkedDocument(loaded: Overrides | undefined): Overrides {
    const doc = loaded ?? { channels: {}, users: {} };
    doc.channels ??= {};
    doc.users ??= {};
    validateInstructions(doc, `overrides (${this.backing.describe()})`);
    validateScopeEfforts(doc, `overrides (${this.backing.describe()})`);
    validateMcpServers({ channels: doc.channels, users: doc.users, defaults: doc.org }, `overrides (${this.backing.describe()})`);
    return doc;
  }

  /** Where runtime overrides are persisted (for the startup log). */
  overridesLocation(): string {
    return this.backing.describe();
  }

  /** The org tier: static `defaults.mcpServers` under the runtime `org` override. */
  private orgScope(): Scope {
    return layerScope({ mcpServers: this.config.defaults.mcpServers }, this.overrides.org);
  }

  /** The RUNTIME half of one scope (what `mcp add|remove` edit), never the
   *  static config merged in — so removing a runtime server cannot "remove" a
   *  static one, and static entries never get copied into the document. */
  runtimeScope(kind: "org" | "channel" | "user", id?: string): Scope {
    if (kind === "org") return { ...this.overrides.org };
    if (!id) throw new Error(`${kind} scope needs an id`);
    return { ...(kind === "channel" ? this.overrides.channels[id] : this.overrides.users[id]) };
  }

  /** Whether an entry with this name exists in the STATIC config of the scope
   *  (so `mcp remove` can say "that one is pinned in config.yaml"). */
  isStaticMcpServer(kind: "org" | "channel" | "user", id: string | undefined, name: string): boolean {
    const scope = kind === "org" ? this.config.defaults : kind === "channel" ? this.config.channels?.[id ?? ""] : this.config.users?.[id ?? ""];
    return scope?.mcpServers?.[name] !== undefined;
  }

  async setOrgOverride(patch: Scope): Promise<Scope> {
    await this.write((o) => {
      o.org = mergeScope(o.org, patch);
    });
    return this.orgScope();
  }

  /**
   * The MCP servers a run in `channelId` requested by `userId` may use
   * (features/mcp-tools.md item 17): the union of the three tiers, highest
   * trust first; a name that appears in a lower tier too is reported once with
   * `shadowedBy` so the run notes can say why the user's copy was ignored.
   */
  mcpServersFor(channelId: string, userId: string): ResolvedMcpServer[] {
    const tiers: Array<{ kind: "org" | "channel" | "user"; scopeKey: string; scope: Scope; staticEntries: Record<string, McpServerEntry> | undefined }> = [
      { kind: "org", scopeKey: "org", scope: this.orgScope(), staticEntries: this.config.defaults.mcpServers },
      { kind: "channel", scopeKey: `channel:${channelId}`, scope: this.channelScope(channelId), staticEntries: this.config.channels?.[channelId]?.mcpServers },
      { kind: "user", scopeKey: `user:${userId}`, scope: this.userScope(userId), staticEntries: this.config.users?.[userId]?.mcpServers },
    ];
    const out: ResolvedMcpServer[] = [];
    const seen = new Map<string, string>(); // name → scopeKey that won
    for (const tier of tiers) {
      for (const [name, entry] of Object.entries(tier.scope.mcpServers ?? {})) {
        const winner = seen.get(name);
        const isStatic = tier.staticEntries?.[name] !== undefined && tier.staticEntries[name] === entry;
        const resolved: ResolvedMcpServer = { name, kind: tier.kind, scopeKey: tier.scopeKey, entry, source: isStatic ? "config" : "runtime" };
        if (winner) resolved.shadowedBy = winner;
        else seen.set(name, tier.scopeKey);
        out.push(resolved);
      }
    }
    return out;
  }

  private channelScope(channelId: string): Scope {
    return layerScope(this.config.channels?.[channelId], this.overrides.channels[channelId]);
  }

  private userScope(userId: string): Scope {
    return layerScope(this.config.users?.[userId], this.overrides.users[userId]);
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
  async setChannelOverride(channelId: string, patch: Scope): Promise<Scope> {
    await this.write((o) => {
      o.channels[channelId] = mergeScope(o.channels[channelId], patch);
    });
    return this.channelScope(channelId);
  }

  async setUserOverride(userId: string, patch: Scope): Promise<Scope> {
    await this.write((o) => {
      o.users[userId] = mergeScope(o.users[userId], patch);
    });
    return this.userScope(userId);
  }

  async clearChannelOverride(channelId: string): Promise<void> {
    await this.write((o) => {
      delete o.channels[channelId];
    });
  }

  async clearUserOverride(userId: string): Promise<void> {
    await this.write((o) => {
      delete o.users[userId];
    });
  }

  /** Apply a mutation to a COPY, persist it, then adopt it — so a failed save
   *  leaves the in-memory document exactly as it was (what the running bot
   *  uses is always what the store holds). The caller sees the error.
   *
   *  Writes are serialized: two `config set`s in flight at once would otherwise
   *  both copy the same base and the second save would drop the first change.
   *
   *  A save refused as stale (another writer — the CLI — saved first) is
   *  rebased, not retried blind: reload the current document, adopt it, apply
   *  the same mutation on top, save once more. A second refusal surfaces the
   *  conflict error with the store now holding the other writer's document, so
   *  the retry it asks for carries every writer's change. */
  private write(mutate: (o: Overrides) => void): Promise<void> {
    const run = this.writes.then(() => this.writeUnqueued(mutate));
    this.writes = run.catch(() => {});
    return run;
  }

  private async writeUnqueued(mutate: (o: Overrides) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const next = structuredClone(this.overrides);
      mutate(next);
      try {
        await this.backing.save(next);
        this.overrides = next;
        return;
      } catch (err) {
        if (!(err instanceof OverridesConflictError)) throw err;
        // Adopt what the other writer stored, so the rebase (or the caller's
        // retry) starts from the current document, never the stale snapshot.
        this.overrides = this.checkedDocument(await this.backing.load());
        if (attempt >= 1) throw err;
      }
    }
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
      org: this.orgScope(),
      restrictedAgents: this.restrictedAgentsFor(userId),
      channelConfigRestricted: !this.canEditChannelConfig(userId),
      adminsHint: this.adminsHint(),
    };
  }

  /** `config show` as text. */
  describe(channelId: string, userId: string): string {
    return formatConfigDescription(this.describeConfig(channelId, userId));
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

/**
 * One tier's effective scope: the static config under its runtime override.
 * Every setting is replaced whole by the override — except `mcpServers`, which
 * merges per name: the runtime map holds only what `mcp add` wrote (it never
 * copies the static entries in), so a plain spread would make the first
 * `mcp add` into a scope with pinned servers hide them from every run.
 */
function layerScope(stat: Scope | undefined, runtime: Scope | undefined): Scope {
  const mcpServers = { ...stat?.mcpServers, ...runtime?.mcpServers };
  const merged: Scope = { ...stat, ...runtime };
  if (Object.keys(mcpServers).length > 0) merged.mcpServers = mcpServers;
  else delete merged.mcpServers;
  return merged;
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
  /** The org tier's runtime-visible settings (today `mcpServers`), for `config show`. */
  org?: Scope;
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
  const orgMcp = d.org?.mcpServers && Object.keys(d.org.mcpServers).length > 0 ? `, mcp ${Object.keys(d.org.mcpServers).map((n) => `\`${n}\``).join(" ")}` : "";
  const lines = [`*Effective for you in this channel:* ${effective}`, `*Defaults:* ${defaults}${orgMcp}`, `*Channel scope:* ${fmtScope(d.channel)}`, `*Your scope:* ${fmtScope(d.user)}`];
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
  if (s.mcpServers && Object.keys(s.mcpServers).length > 0) parts.push(`mcp ${Object.keys(s.mcpServers).map((n) => `\`${n}\``).join(" ")}`);
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

/**
 * Every `mcpServers` map a config layer can carry (features/mcp-tools.md items
 * 11 + 14), static or stored: names are slugs, URLs http(s) and not an internal
 * address (the same guard `web_fetch` uses), agents known, `auth` known, a
 * bearer's `tokenEnv` a name — and a channel or user entry may reach the
 * self-serve agents only. The chat command enforces the same on write; this
 * holds files and stored documents to the rule at load.
 */
export function validateMcpServers(
  layer: { channels?: Record<string, Scope>; users?: Record<string, Scope>; defaults?: { mcpServers?: Record<string, unknown> } | Scope },
  source: string,
): void {
  const check = (path: string, tier: "org" | "channel" | "user", servers: Record<string, unknown> | undefined) => {
    if (servers === undefined) return;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error(`${source}: ${path} must be a mapping of name → server`);
    if (Object.keys(servers).length > MCP_SERVERS_PER_SCOPE_MAX) throw new Error(`${source}: ${path} has more than ${MCP_SERVERS_PER_SCOPE_MAX} servers`);
    for (const [name, raw] of Object.entries(servers)) {
      if (!MCP_SERVER_NAME_RE.test(name)) throw new Error(`${source}: ${path}.${name}: server names are slugs (lowercase letters, digits, dashes; ≤ ${MCP_SERVER_NAME_MAX} chars)`);
      if (!isMcpServerEntry(raw)) throw new Error(`${source}: ${path}.${name} must be { url, auth: none|bearer|oauth, agents?, tokenEnv? }`);
      try {
        assertUrlAllowed(raw.url);
      } catch (err) {
        throw new Error(`${source}: ${path}.${name}.url: ${err instanceof Error ? err.message : "not an http(s) URL"}`);
      }
      for (const a of raw.agents ?? []) {
        if (!AGENTS[a]) throw new Error(`${source}: ${path}.${name}.agents: unknown agent "${a}"`);
        if (tier !== "org" && !MCP_SELF_SERVE_AGENTS.includes(a)) {
          throw new Error(`${source}: ${path}.${name}.agents: a ${tier}-scoped server may name ${MCP_SELF_SERVE_AGENTS.join("/")} only — "${a}" takes an org-wide server (defaults.mcpServers)`);
        }
      }
      if (raw.tokenEnv !== undefined && raw.auth !== "bearer") throw new Error(`${source}: ${path}.${name}.tokenEnv only applies to auth: bearer`);
    }
  };
  check("defaults.mcpServers", "org", layer.defaults?.mcpServers as Record<string, unknown> | undefined);
  for (const [kind, scopes] of [["channels", layer.channels], ["users", layer.users]] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) check(`${kind}.${id}.mcpServers`, kind === "channels" ? "channel" : "user", scope.mcpServers as Record<string, unknown> | undefined);
  }
}

function fmtModels(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `\`${k}=${v}\``)
    .join(" ");
}

function validateConfig(cfg: AppConfig, warn: (message: string) => void): void {
  validateScopeEfforts(cfg, "config.yaml");
  validateMcpServers(cfg, "config.yaml");
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
  validateRuntimeOverrides(cfg.runtimeOverrides);
  if (cfg.ship !== undefined) validateShip(cfg.ship);
}

/** `ship` caps (features/agent-ship.md item 8): both bounds enforced at load
 *  so a typo cannot silently become "no cap" (mirrors validateRunHistory). */
function validateShip(ship: ShipConfig): void {
  if (typeof ship !== "object" || ship === null) throw new Error("config.yaml: ship must be a mapping");
  for (const key of ["maxRounds", "maxMinutes"] as const) {
    const v = ship[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) throw new Error(`config.yaml: ship.${key} must be an integer >= 1`);
  }
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

/** `runtimeOverrides` (routing-and-config item 12): a mapping; `worker.baseUrl` https; `tokenEnv` a name. */
function validateRuntimeOverrides(ro: AppConfig["runtimeOverrides"]): void {
  if (ro !== undefined) {
    if (typeof ro !== "object" || ro === null || Array.isArray(ro)) throw new Error("config.yaml: runtimeOverrides must be a mapping");
    if (ro.worker !== undefined) {
      if (typeof ro.worker !== "object" || ro.worker === null) throw new Error("config.yaml: runtimeOverrides.worker must be a mapping with baseUrl");
      let url: URL | undefined;
      try {
        url = new URL(String(ro.worker.baseUrl));
      } catch {
        url = undefined;
      }
      if (!url || url.protocol !== "https:") throw new Error("config.yaml: runtimeOverrides.worker.baseUrl must be an https: URL");
      if (ro.worker.tokenEnv !== undefined && (typeof ro.worker.tokenEnv !== "string" || !ro.worker.tokenEnv)) {
        throw new Error("config.yaml: runtimeOverrides.worker.tokenEnv must be an environment variable name");
      }
    }
  }
}
