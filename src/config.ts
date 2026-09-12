import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { TracingLogLevel } from "./core/trace/sinks.js";
import { dirname, resolve } from "node:path";
import type { Effort } from "./effort.js";
import YAML from "yaml";
import type { ProviderConfig } from "./providers/types.js";
import type { MemoryConfig } from "./core/memory/types.js";
import type { SelfImprovementConfig } from "./core/selfImprovement.js";
import type { SchedulesConfig } from "./core/scheduleStore.js";
import type { RunHistoryConfig } from "./core/runStore.js";
import type { ShipConfig } from "./core/shipPipeline.js";
import type { SpawnConfig } from "./core/dispatch/spawn.js";
import type { DashboardConfig } from "./core/dashboardAuthConfig.js";
import { hasAction } from "./core/authz/authorize.js";
import {
  grantsIn,
  grantsTable,
  mayRunAgent,
  mayUseRepo,
  type GrantsConfig,
  type GrantsTable,
  type RestrictConfig,
} from "./core/authz/grants.js";
import { ConfigDocumentClient, parseConfigLocation, stateWorkerFrom } from "./configDocument.js";
import type { EnvRecord, Secrets } from "./secrets.js";
import type { Grants } from "./core/authz/types.js";
import { isRunSchedule, SCHEDULES } from "./core/schedules.js";
import { AGENTS } from "./agents/registry.js";
import type { McpServerEntry } from "./mcp/registry.js";
import {
  validateBoundaries,
  validateConfig,
  validateGrants,
  validateInstructions,
  validateMcpServers,
  validateRestrict,
  validateScopeEfforts,
} from "./config/validate.js";
import {
  intersectBoundaries,
  type Boundary,
  type BoundaryScope,
  type EffectiveBoundary,
  type ScopedBoundary,
} from "./config/profile.js";

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
   * A cap on what any run in this scope may have (docs/decisions/0026-capability-profiles-and-request-routing.md):
   * `maxMinutes`, `maxIdentity` (`none < read < write`), `machines`. Unlike
   * every other setting, which the most specific scope replaces, boundaries
   * INTERSECT across the layers (`resolve()`), so a user's boundary can only
   * tighten the channel's and the defaults'. A boundary never grants: the
   * policy table's answer (who may run a preset) is untouched by it.
   * Validated at load (`validateBoundaries`) and on write (`config set`).
   */
  boundary?: Boundary;
  /**
   * Free-text custom instructions folded into the system prompt as ADVISORY
   * content only. Channel text applies to every run in the
   * channel; user text applies only to runs that user requests. Never read by
   * `resolve()` or any permission gate. Capped at MAX_INSTRUCTIONS_LENGTH
   * because it rides every turn.
   */
  instructions?: string;
  /**
   * External MCP servers this scope contributes to runs (docs/reference/specs/mcp-tools.md
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

export interface AppConfig {
  /**
   * The GitHub organization (or user) this installation serves — the account
   * its GitHub App is installed on. Required: it names the shared memory scope
   * (`org:<organization>`, docs/reference/specs/memory.md item 4) and the About block every
   * model run carries (routing-and-config item 11). The code never assumes one.
   */
  organization: string;
  providers: Record<string, ProviderConfig>;
  defaults: {
    agent: string;
    /** default model per agent, e.g. { general: "anthropic/claude-opus-5" } */
    models: Record<string, string>;
    /** default effort per agent, e.g. { coding: "medium" }; unset → the agent
     *  definition's effort, else the provider's default */
    efforts?: Record<string, Effort>;
    maxTokens?: number;
    /** Org-wide MCP servers pinned by the operator (docs/reference/specs/mcp-tools.md item 11). */
    mcpServers?: Record<string, McpServerEntry>;
    /** The installation-wide boundary: the cap every run meets first (`Scope.boundary`). */
    boundary?: Boundary;
  };
  channels?: Record<string, Scope>;
  users?: Record<string, Scope>;
  /**
   * The one authorization shape (docs/reference/specs/authorization.md item 9; see
   * docs/decisions/0007-authorization-policy-table.md): actor id (`slack:U…`,
   * `http:<subject>`, `mcp:<subject>`, `access:<sub>`,
   * `access:svc:<cn>`, `schedule:<name>`, or `<ns>:*` for everyone authenticated
   * on a surface — `access:*` is the org Access admits) → `{ actions, channels,
   * repos }`, each a list of names or the explicit word `all`; an absent axis is
   * the empty set. A `slack:` entry adds to the baseline every Slack user holds
   * (the open chat commands, every unrestricted agent); a browser entry adds to
   * every group's read; every other entry is exactly what it declares; a
   * surface entry is unioned into every actor of that surface on top of its own.
   * `ConfigStore.grantsFor` is the one lookup.
   */
  grants?: GrantsConfig;
  /**
   * What is CLOSED unless a grant covers it: agents (run only by a holder of
   * `agent:run:<name>`) and repos (`owner/name`, used only by a holder whose
   * `repos` names it). Everything unlisted is open to everyone who can reach
   * the bot. Repo management (`repo:write`) and channel config (`config:write`)
   * need no entry here — they are closed by construction (held only where
   * `grants` say so, admins through `actions: all`).
   */
  restrict?: RestrictConfig;
  execution?: import("./execution/factory.js").ExecutionConfig;
  workspaceDir?: string;
  /**
   * Cross-session self-learning memory. Absent or `enabled:
   * false` (the default) → the dispatcher uses a NullMemoryStore and model
   * input is byte-identical to memory-off. See docs/reference/specs/memory.md.
   */
  memory?: MemoryConfig;
  /**
   * Self-improvement proposals: where `friction propose` files
   * issues and how it clusters. Absent → every run's diagnosis still lands in
   * run history, but `friction propose` refuses until `repo` is set.
   * See docs/reference/specs/self-improvement.md.
   */
  selfImprovement?: SelfImprovementConfig;
  /**
   * Scheduled jobs: where the Worker shim's cron firings are recorded
   * (the state Worker's ScheduleDO) so the /runs "Scheduled" panel can show last
   * fire / outcome / run. Absent → the panel lists the schedules without firing
   * history. See docs/reference/specs/live-view.md item 14.
   */
  schedules?: SchedulesConfig;
  /**
   * Spend reporting (`GET /costs`): which Cloudflare Workers / container apps
   * / Anthropic workspace make up each named group. Validated at startup by
   * `parseCostsConfig` (src/core/costs.ts); absent → the view answers 503.
   */
  costs?: unknown;
  /**
   * Delivery indicators (`GET /delivery`, `delivery report`): the repositories
   * the page serves and the identities the indicators judge by (the review
   * agent's login, agent logins, agent co-author names). Validated at startup by
   * `parseDeliveryConfig` (src/core/delivery.ts); absent → no default repository
   * (the command still takes `--repo`).
   */
  delivery?: unknown;
  /**
   * Dashboard authentication (docs/reference/specs/access-gate.md, plan D5): which
   * credential gates `/runs*`, `/residents*`, `/costs*`, `/mcp/connect/*` and
   * `/api/*` — `auth: access | token | none`, plus the `token` strategy's `env`
   * (default `DASHBOARD_TOKEN`) and `actor` (`access:<name>`). Absent → `access`
   * when ACCESS_TEAM_DOMAIN + ACCESS_AUD are set, else `none` (loopback callers
   * on a localhost deployment only). Validated at load
   * (src/core/dashboardAuthConfig.ts); composed in src/index.ts.
   */
  dashboard?: DashboardConfig;
  /** Review-run behavior: the reading-diff artifact's provider switch
   *  (`git` | `meat` | `off`; env `SWITCHBOARD_READING_DIFF` overrides).
   *  See docs/reference/specs/reading-diff.md. */
  review?: { readingDiff?: import("./core/readingDiff.js").ReadingDiffConfig };
  /**
   * agent:ship pipeline caps (docs/reference/specs/agent-ship.md item 8): `maxRounds`
   * review rounds (default 3) and `maxMinutes`, the ship preset's declared
   * wall-clock budget (default the registry's 120) — a profile field, so a
   * scope's boundary or a `budget:` directive clips it per run; whichever cap
   * hits first ends the loop, and each child round runs its own agent budget
   * clipped to the remaining pipeline time. Deployment-level like `review`;
   * validated at load.
   */
  ship?: ShipConfig;
  /**
   * The fan-out cap a spawning run meets (docs/reference/specs/agent-conductor.md
   * item 5): `maxChildren` live children per run (default 3, at least 1); a
   * spawn past it is refused by name until one finishes. Deployment-level like
   * `ship`; validated at load.
   */
  spawn?: SpawnConfig;
  /** Slack adapter behavior that is not pure transport. */
  slack?: SlackConfig;
  /**
   * Persistent run history. Absent → history is OFF: finished runs stay
   * live-only, as before. `store: "file"` is an explicit host-disk opt-in;
   * otherwise `worker` names the RunHistoryDO on the state Worker. Retention
   * is `retentionDays` / `maxRuns` / `maxBytes`. See docs/reference/specs/run-history.md.
   */
  runHistory?: RunHistoryConfig;
  /**
   * Where chat-set runtime overrides (`config set`, `config instructions`, …)
   * persist (docs/reference/specs/routing-and-config.md item 12). Absent → the JSON file
   * (`data/overrides.json`; ephemeral on Cloudflare Containers). `worker`
   * names the ConfigDO on the state Worker — the production choice; the bearer
   * comes from `tokenEnv` (default `MEMORY_TOKEN`). Validated at load.
   */
  runtimeOverrides?: { worker?: { baseUrl: string; tokenEnv?: string } };
  /**
   * Span log verbosity (docs/reference/specs/tracing.md): `roots` prints one JSON line per
   * root span (a request, a cron firing); `slow` adds every span of 1 s or
   * more. Absent → `roots`. Never text, summary or output on a line.
   */
  tracing?: TracingConfig;
  /**
   * External MCP servers as agent tools (docs/reference/specs/mcp-tools.md item 11):
   * `servers[]` of `{ name, url, auth?: { type: bearer, tokenEnv }, agents? }`.
   * Parsed and validated by `parseMcpConfig` (src/mcp/config.ts) at startup —
   * the bearer is read from the environment there, never stored here. Absent
   * → no MCP tools, requests byte-identical to before the feature.
   */
  mcp?: unknown;
}

export interface SlackConfig {
  /**
   * Reconnect catch-up (docs/decisions/0012-reconnect-catch-up-as-recovery.md):
   * on every Socket Mode (re)connect, re-read
   * recent history of every channel the bot is in and dispatch mentions /
   * follow-ups that carry no receipt from us (no 👀, no bot reply after them).
   * Absent = enabled with a 30-minute window.
   */
  catchUp?: {
    enabled?: boolean;
    /**
     * Messages older than this are left alone even if unanswered. Must cover
     * the worst deploy blackout — the 15-min graceful-drain deadline plus a
     * cold start (`MIN_CATCH_UP_WINDOW_MS`, 20 min). A smaller value is
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
 * Where runtime overrides live (docs/reference/specs/routing-and-config.md item 12). Two
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
  /** Synchronous under the hood so `new ConfigStore(config, path)` can load it inline. */
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
    if (typeof doc !== "object" || Array.isArray(doc))
      throw new Error(`config store returned a non-object overrides document`);
    return doc as Overrides;
  }

  async save(overrides: Overrides): Promise<void> {
    const body = await this.post("/config/put", {
      key: OVERRIDES_DOCUMENT_KEY,
      document: overrides,
      expectedVersion: this.version,
    });
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
      throw new Error(`config store unreachable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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
  /** The boundaries on the request's path, intersected (`defaults`, then the
   *  channel, then the user — each axis naming the scope whose cap won).
   *  Absent when no layer sets one: the request then resolves exactly as it
   *  did before boundaries existed. The effective profile is computed from it
   *  once the preset is known (`src/core/dispatch/resolve.ts`). */
  boundary?: EffectiveBoundary;
}

/** Where runtime overrides are persisted, chosen from `config.yaml` (item 12):
 *  `runtimeOverrides.worker` names the state Worker's ConfigDO; absent → the
 *  JSON file at `overridesPath`. The Worker bearer comes from `tokenEnv`
 *  (default `MEMORY_TOKEN`); a configured Worker without its bearer is a
 *  startup error, never a silent fall back to the ephemeral file. */
export function overridesBackingFor(
  config: AppConfig,
  opts: { overridesPath: string; secrets: Secrets; fetch?: typeof fetch },
): OverridesBacking {
  const worker = config.runtimeOverrides?.worker;
  if (!worker) return new FileOverridesBacking(opts.overridesPath);
  const tokenEnv = worker.tokenEnv ?? "MEMORY_TOKEN";
  const token = opts.secrets.named(tokenEnv);
  if (!token) throw new Error(`runtimeOverrides.worker is configured but ${tokenEnv} is not set`);
  return new WorkerOverridesBacking({
    baseUrl: worker.baseUrl,
    token: token.reveal(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/** Parse + validate config YAML text; throws naming the first fatal finding. */
export function parseAppConfigText(text: string): AppConfig {
  const config = YAML.parse(text) as AppConfig;
  validateConfig(config);
  return config;
}

/** Read + validate `config.yaml` once. */
export function loadAppConfig(configPath: string): AppConfig {
  return parseAppConfigText(readFileSync(resolve(configPath), "utf8"));
}

/**
 * The config from wherever `SWITCHBOARD_CONFIG` points (src/configDocument.ts):
 * a file path, or `state://base` — the document `deploy config` pushed to the
 * state Worker named by `STATE_WORKER_URL`, read with `MEMORY_TOKEN`. On
 * Cloudflare the image carries no config, so production reads the document;
 * local dev reads the file. A missing document, variable, or Worker is a
 * startup error naming what to do — never a silent empty config.
 */
export async function loadAppConfigFrom(
  location: string,
  opts: { env: EnvRecord; secrets: Secrets; warn: (message: string) => void; fetch?: typeof fetch },
): Promise<AppConfig> {
  const parsed = parseConfigLocation(location);
  if (parsed.kind === "file") return loadAppConfig(parsed.path);
  const worker = stateWorkerFrom(opts.env, opts.secrets);
  if (!worker.ok) throw new Error(`SWITCHBOARD_CONFIG=${location}: ${worker.problem}`);
  const client = new ConfigDocumentClient({
    baseUrl: worker.baseUrl,
    token: worker.token.reveal(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const read = await client.readBase(parsed.key);
  if (!read.ok) throw new Error(`SWITCHBOARD_CONFIG=${location}: ${read.problem}`);
  if (!read.document)
    throw new Error(
      `SWITCHBOARD_CONFIG=${location}: no "${parsed.key}" document on ${client.describe()} — push one with \`deploy config\``,
    );
  opts.warn(
    `[config] base document "${parsed.key}" v${read.version} from ${read.document.source} (sha256 ${read.document.sha256.slice(0, 12)}, pushed ${read.document.pushedAt})`,
  );
  return parseAppConfigText(read.document.yaml);
}

/** What the grants table needs beyond config.yaml: the registered command
 *  groups (an Access browser session holds every group's read). Absent = none:
 *  a store built without them gives a browser session no actions — fail-closed,
 *  never widened. The CLI never resolves a browser actor; the bot passes the
 *  groups at startup. */
export interface ConfigStoreOptions {
  commandGroups?: readonly string[];
}

/** Open the store the way production does: parse + validate `config.yaml`,
 *  pick the overrides backing from it, load the document, construct. */
export async function openConfigStore(
  configPath: string,
  opts: {
    overridesPath: string;
    /** The public environment (`STATE_WORKER_URL` for a `state://` location). */
    env: EnvRecord;
    /** The credentials: the state Worker bearer the location and `runtimeOverrides.worker` read. */
    secrets: Secrets;
    warn?: (message: string) => void;
    fetch?: typeof fetch;
  } & ConfigStoreOptions,
): Promise<ConfigStore> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const config = await loadAppConfigFrom(configPath, {
    env: opts.env,
    secrets: opts.secrets,
    warn,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const backing = overridesBackingFor(config, opts);
  const initial = await backing.load();
  return new ConfigStore({ validated: config }, { backing, initial }, { commandGroups: opts.commandGroups });
}

export class ConfigStore {
  readonly config: AppConfig;
  private overrides: Overrides;
  private readonly backing: OverridesBacking;
  /** Writes run one at a time (see `write`); a rejected write does not hold the queue. */
  private writes: Promise<void> = Promise.resolve();
  private readonly grants: GrantsTable;

  /** The first argument is the `config.yaml` path (read + validated here — dev,
   *  tests) or a config `openConfigStore` already validated. The second is a
   *  JSON file path (loaded inline) or a backing whose document was already
   *  loaded. `options` is what the grants table needs beyond the file (`ConfigStoreOptions`). */
  constructor(
    config: string | { validated: AppConfig },
    overrides: string | { backing: OverridesBacking; initial: Overrides | undefined },
    options: ConfigStoreOptions = {},
  ) {
    this.config = typeof config === "string" ? loadAppConfig(config) : config.validated;
    // Both blocks already passed `validateConfig` (either path above); these parses just build the table.
    this.grants = grantsTable({
      grants: validateGrants(this.config.grants),
      restrict: validateRestrict(this.config.restrict),
      agentNames: Object.keys(AGENTS),
      commandGroups: options.commandGroups,
      // The schedule registry's declared actors: the floor for `schedule:<name>` ids.
      schedules: SCHEDULES.filter(isRunSchedule).map((s) => s.action.actor),
    });

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
    validateBoundaries(doc, `overrides (${this.backing.describe()})`);
    validateMcpServers(
      { channels: doc.channels, users: doc.users, defaults: doc.org },
      `overrides (${this.backing.describe()})`,
    );
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
    const scope =
      kind === "org"
        ? this.config.defaults
        : kind === "channel"
          ? this.config.channels?.[id ?? ""]
          : this.config.users?.[id ?? ""];
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
   * (docs/reference/specs/mcp-tools.md item 17): the union of the three tiers, highest
   * trust first; a name that appears in a lower tier too is reported once with
   * `shadowedBy` so the run notes can say why the user's copy was ignored.
   */
  mcpServersFor(channelId: string, userId: string): ResolvedMcpServer[] {
    const tiers: Array<{
      kind: "org" | "channel" | "user";
      scopeKey: string;
      scope: Scope;
      staticEntries: Record<string, McpServerEntry> | undefined;
    }> = [
      { kind: "org", scopeKey: "org", scope: this.orgScope(), staticEntries: this.config.defaults.mcpServers },
      {
        kind: "channel",
        scopeKey: `channel:${channelId}`,
        scope: this.channelScope(channelId),
        staticEntries: this.config.channels?.[channelId]?.mcpServers,
      },
      {
        kind: "user",
        scopeKey: `user:${userId}`,
        scope: this.userScope(userId),
        staticEntries: this.config.users?.[userId]?.mcpServers,
      },
    ];
    const out: ResolvedMcpServer[] = [];
    const seen = new Map<string, string>(); // name → scopeKey that won
    for (const tier of tiers) {
      for (const [name, entry] of Object.entries(tier.scope.mcpServers ?? {})) {
        const winner = seen.get(name);
        const isStatic = tier.staticEntries?.[name] !== undefined && tier.staticEntries[name] === entry;
        const resolved: ResolvedMcpServer = {
          name,
          kind: tier.kind,
          scopeKey: tier.scopeKey,
          entry,
          source: isStatic ? "config" : "runtime",
        };
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
   * Resolve which agent, model, and effort serve a request, and the boundary
   * every run on this path meets.
   * Agent:    request directive > user scope > channel scope > default.
   * Model:    request directive > (user > channel) forced model
   *           > (user > channel > defaults) per-agent model.
   * Effort:   the same ladder as model; unset at every layer → undefined.
   * Boundary: NOT a ladder — the defaults', the channel's and the user's
   *           boundaries intersect (the smallest budget, the lowest identity,
   *           the classes every layer allows), so a scope can only tighten what
   *           the layers below it allow; no layer set → absent.
   */
  resolve(opts: {
    channelId: string;
    userId: string;
    request: { agent?: string; model?: string; effort?: Effort };
  }): ResolvedRequest {
    const ch = this.channelScope(opts.channelId);
    const us = this.userScope(opts.userId);

    const agentName = opts.request.agent ?? us.agent ?? ch.agent ?? this.config.defaults.agent;
    const boundary = intersectBoundaries(this.boundaryLayers(ch, us));

    const modelRef =
      opts.request.model ??
      us.model ??
      ch.model ??
      us.models?.[agentName] ??
      ch.models?.[agentName] ??
      this.config.defaults.models[agentName] ??
      this.config.defaults.models["general"];

    if (!modelRef) {
      throw new Error(`No model configured for agent "${agentName}" — set defaults.models.${agentName} in config.yaml`);
    }

    const effort =
      opts.request.effort ??
      us.effort ??
      ch.effort ??
      us.efforts?.[agentName] ??
      ch.efforts?.[agentName] ??
      this.config.defaults.efforts?.[agentName];

    return {
      agentName,
      modelRef,
      ...(effort !== undefined ? { effort } : {}),
      ...(boundary !== undefined ? { boundary } : {}),
    };
  }

  /** The boundary layers on a path, in resolution order, keeping only the
   *  scopes that set one — `intersectBoundaries` names each axis's scope from it. */
  private boundaryLayers(channel: Scope, user: Scope): ScopedBoundary[] {
    const layers: Array<[BoundaryScope, Boundary | undefined]> = [
      ["defaults", this.config.defaults.boundary],
      ["channel", channel.boundary],
      ["user", user.boundary],
    ];
    return layers.flatMap(([scope, boundary]) => (boundary ? [{ scope, boundary }] : []));
  }

  // ---- authorization gates ----------------------------------------------------
  // Every gate reads the grants table (authorization.md item 9): what an actor
  // holds, plus `restrict` for the two resources that are open unless listed.
  // Enforcement happens at run time against the *resolved* agent and repo, so
  // no config layer (including "config set me") can bypass a restriction.

  /** Every agent is open unless `restrict.agents` names it; a restricted agent
   *  runs only for a holder of `agent:run:<name>` (admins through `all`). */
  canRunAgent(actorId: string, agentName: string): boolean {
    return mayRunAgent(this.grants, this.grantsFor(actorId), agentName);
  }

  /** Every repo is open unless `restrict.repos` names it; a restricted repo is
   *  used only by a holder whose `repos` axis names it (admins through `all`).
   *  A refused actor is refused BY NAME — never a silent per-thread fallback. */
  canUseRepo(actorId: string, slug: string): boolean {
    return mayUseRepo(this.grants, this.grantsFor(actorId), slug);
  }

  /** The channel-config right, as the policy table's `config:write` row on
   *  `config-scope { channel }` reads it: held only where `grants` say so. */
  canEditChannelConfig(userId: string): boolean {
    return hasAction(this.grantsFor(userId).actions, "config:write");
  }

  /**
   * Repo-management gate: FAIL-CLOSED — the `repo:write` grant, which
   * admins hold through `all`; no grant means admins only, because `repo
   * onboard`/`rebuild` provision billable always-on compute and bind GitHub
   * credentials.
   */
  canManageRepos(userId: string): boolean {
    return hasAction(this.grantsFor(userId).actions, "repo:write");
  }

  /** The one grants lookup: what `grants[<actorId>]` declares
   *  on top of its namespace's baseline (the chat `open` commands and every
   *  unrestricted agent for a Slack user, every group's read for a browser
   *  session), else that baseline alone, else nothing — unioned with the
   *  surface's `<ns>:*` entry when config has one. Attached to every
   *  `Caller.actor`: the ONLY thing `authorize` reads about a caller. */
  grantsFor(actorId: string): Grants {
    return grantsIn(this.grants, actorId);
  }

  /** Who to ask when denied — for actionable error messages: the Slack users
   *  who hold everything, in the table's order. Slack only because
   *  the hint is a `<@…>` mention in a chat reply; a credential granted
   *  everything (`access:`, `http:`) is not someone to ask. */
  adminsHint(): string {
    const admins = [...this.grants.grants]
      .filter(([id, g]) => id.startsWith("slack:") && holdsEverything(g))
      .map(([id]) => id);
    return admins.length > 0 ? admins.map((u) => `<@${u}>`).join(", ") : "an admin";
  }

  /** The restricted agents this actor holds no grant for (what `config show` lists as unavailable). */
  restrictedAgentsFor(actorId: string): string[] {
    return [...this.grants.restrict.agents].filter((a) => !this.canRunAgent(actorId, a));
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
   *  text surfaces render it with `formatConfigDescription`. Everything but
   *  `channelConfigRestricted`: that is the policy table's answer for the
   *  caller's ACTOR (`config:write` on `config-scope { channel }`), which the
   *  store cannot see — the `config.show` handler adds it. */
  describeConfig(channelId: string, userId: string): Omit<ConfigDescription, "channelConfigRestricted"> {
    const resolved = this.resolve({ channelId, userId, request: {} });
    return {
      effective: {
        agent: resolved.agentName,
        model: resolved.modelRef,
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resolved.boundary ? { boundary: resolved.boundary } : {}),
      },
      defaults: {
        agent: this.config.defaults.agent,
        models: this.config.defaults.models,
        ...(this.config.defaults.efforts ? { efforts: this.config.defaults.efforts } : {}),
      },
      channel: this.channelScope(channelId),
      user: this.userScope(userId),
      org: this.orgScope(),
      restrictedAgents: this.restrictedAgentsFor(userId),
      adminsHint: this.adminsHint(),
    };
  }

  /** `config show` as text for a Slack user id (whose actor IS the store's grants for it). */
  describe(channelId: string, userId: string): string {
    return formatConfigDescription({
      ...this.describeConfig(channelId, userId),
      channelConfigRestricted: !this.canEditChannelConfig(userId),
    });
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
  /** The boundary is the intersection of every scope's, each axis naming the scope that set it. */
  effective: { agent: string; model: string; effort?: Effort; boundary?: EffectiveBoundary };
  defaults: { agent: string; models: Record<string, string>; efforts?: Record<string, Effort> };
  channel: Scope;
  user: Scope;
  /** The org tier's runtime-visible settings (today `mcpServers`), for `config show`. */
  org?: Scope;
  restrictedAgents: string[];
  /** The caller may not `config set channel` here — `authorize(caller.actor, "config:write", config-scope { channel })` denied. */
  channelConfigRestricted: boolean;
  adminsHint: string;
}

/** The `config show` text (chat + CLI) for a `ConfigDescription`. */
export function formatConfigDescription(d: ConfigDescription): string {
  const effective = `agent \`${d.effective.agent}\`, model \`${d.effective.model}\`${d.effective.effort ? `, effort \`${d.effective.effort}\`` : ""}`;
  const defaults =
    `agent \`${d.defaults.agent}\`, models ${fmtModels(d.defaults.models)}` +
    (d.defaults.efforts && Object.keys(d.defaults.efforts).length > 0
      ? `, efforts ${fmtModels(d.defaults.efforts)}`
      : "");
  const orgMcp =
    d.org?.mcpServers && Object.keys(d.org.mcpServers).length > 0
      ? `, mcp ${Object.keys(d.org.mcpServers)
          .map((n) => `\`${n}\``)
          .join(" ")}`
      : "";
  const lines = [
    `*Effective for you in this channel:* ${effective}`,
    ...(d.effective.boundary ? [`*Effective boundary:* ${fmtEffectiveBoundary(d.effective.boundary)}`] : []),
    `*Defaults:* ${defaults}${orgMcp}`,
    `*Channel scope:* ${fmtScope(d.channel)}`,
    `*Your scope:* ${fmtScope(d.user)}`,
  ];
  const channelInstructions = d.channel.instructions?.trim();
  if (channelInstructions) lines.push(`*Channel instructions:* ${channelInstructions}`);
  const userInstructions = d.user.instructions?.trim();
  if (userInstructions) lines.push(`*Your instructions:* ${userInstructions}`);
  if (d.restrictedAgents.length > 0)
    lines.push(`*Not available to you:* ${d.restrictedAgents.map((a) => `\`${a}\``).join(", ")} (ask ${d.adminsHint})`);
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
  if (s.mcpServers && Object.keys(s.mcpServers).length > 0)
    parts.push(
      `mcp ${Object.keys(s.mcpServers)
        .map((n) => `\`${n}\``)
        .join(" ")}`,
    );
  if (s.boundary) parts.push(`boundary ${fmtBoundary(s.boundary)}`);
  return parts.length > 0 ? parts.join(", ") : "_none_";
}

/** One scope's own boundary, axis by axis: `maxMinutes=45 maxIdentity=read machines=none,repo-cold`. */
function fmtBoundary(b: Boundary): string {
  const parts: string[] = [];
  if (b.maxMinutes !== undefined) parts.push(`maxMinutes=${b.maxMinutes}`);
  if (b.maxIdentity !== undefined) parts.push(`maxIdentity=${b.maxIdentity}`);
  if (b.machines !== undefined) parts.push(`machines=${b.machines.join(",")}`);
  return parts.length > 0 ? parts.join(" ") : "(caps nothing)";
}

/** The intersected boundary with each axis's scope: what `config show` and the
 *  awareness block print. Shared so the two surfaces cannot drift. */
export function fmtEffectiveBoundary(b: EffectiveBoundary): string {
  const parts: string[] = [];
  if (b.maxMinutes) parts.push(`maxMinutes ${b.maxMinutes.value} (${b.maxMinutes.scope})`);
  if (b.maxIdentity) parts.push(`maxIdentity \`${b.maxIdentity.value}\` (${b.maxIdentity.scope})`);
  if (b.machines)
    parts.push(
      `machines ${b.machines.value.map((m) => `\`${m}\``).join(", ")} (${b.machines.by.map((l) => l.scope).join(", ")})`,
    );
  return parts.join(", ");
}

function fmtModels(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `\`${k}=${v}\``)
    .join(" ");
}

/** `all` on every axis — an admin (`ALL_GRANTS`). */
function holdsEverything(g: Grants): boolean {
  return g.actions === "all" && g.channels === "all" && g.repos === "all";
}

export interface TracingConfig {
  log?: TracingLogLevel;
}
