// Load-time validation of the configuration document and of a stored overrides
// document. Every finding names the key it is about and fails the load, so a
// typo never silently becomes "no cap", "no restriction" or "no setting".

import { TRACING_LOG_LEVELS } from "../core/trace/sinks.js";
import { EFFORT_LEVELS_HINT, isEffort } from "../effort.js";
import { isVerbosity, VERBOSITY_LEVELS_HINT } from "../core/verbosity.js";
import { INVOICE_APIS, WIRES, WIRE_ALIASES, parseModelRef, type ProviderConfig } from "../core/provider.js";
import { catalogExists } from "../core/installedModelRegistry.js";
import type { SelfImprovementConfig } from "../core/selfImprovement.js";
import type { RunHistoryConfig } from "../core/runStore.js";
import {
  ADDRESS_SEVERITIES,
  isAddressSeverity,
  SHIP_DEFAULT_MAX_ROUNDS,
  SHIP_DEFAULT_MAX_MINUTES,
  type ShipConfig,
} from "../core/shipPipeline.js";
import { ALLOWANCES, ASKS, fit, GRANT_RENEWALS_MAX, IDLE_DAYS_MAX, type Grant } from "../core/budgets.js";
import type { SpawnConfig } from "../core/dispatch/spawn.js";
import { validateDashboardConfig } from "../core/dashboardAuthConfig.js";
import { parseMetricsConfig } from "../core/metrics.js";
import { validateArtifacts } from "../artifacts/config.js";
import { parseGrantsConfig, parseRestrictConfig, type Restriction } from "../core/authz/grants.js";
import type { Grants } from "../core/authz/types.js";
import { AGENTS, IDENTITIES, MACHINE_CLASSES, type Identity, type MachineClass } from "../agents/registry.js";
import { HARNESS_NAMES, isHarnessName } from "../core/harness/roster.js";
import type { OpenCodeCompactionConfig } from "../core/harness/opencode/process.js";
import { CONFIRM_CLASSES, type Boundary, type ConfirmClass } from "./profile.js";
import { assertUrlAllowed } from "../tools/web.js";
import {
  isMcpServerEntry,
  MCP_HEADER_NAME_RE,
  MCP_SELF_SERVE_AGENTS,
  MCP_SERVER_NAME_MAX,
  MCP_SERVER_NAME_RE,
  MCP_SERVERS_PER_SCOPE_MAX,
} from "../mcp/registry.js";
import type {
  AppConfig,
  IntakeConfig,
  OpenCodeConfig,
  PiCompactionConfig,
  PiConfig,
  ReferencesConfig,
  ReviewConfig,
  RoutingConfig,
  Scope,
  SlackConfig,
  TracingConfig,
} from "../config.js";

/** Upper bound on one scope's `instructions` text (prepended to every turn). */
export const MAX_INSTRUCTIONS_LENGTH = 2000;

/** Every top-level key `config.yaml` defines — the type checker holds this
 *  equal to `AppConfig`, so a key added to the interface is accepted at load
 *  the moment it is declared, and a key the interface does not have fails the
 *  load by name (`unknownKeys`). */
const CONFIG_KEYS: Record<keyof AppConfig, true> = {
  organization: true,
  providers: true,
  defaults: true,
  channels: true,
  users: true,
  grants: true,
  restrict: true,
  execution: true,
  workspaceDir: true,
  memory: true,
  artifacts: true,
  selfImprovement: true,
  schedules: true,
  costs: true,
  metrics: true,
  delivery: true,
  dashboard: true,
  review: true,
  ship: true,
  spawn: true,
  routing: true,
  intake: true,
  references: true,
  harness: true,
  pi: true,
  opencode: true,
  slack: true,
  runHistory: true,
  runtimeOverrides: true,
  tracing: true,
  mcp: true,
};

/** The `selfImprovement` fields, held equal to `SelfImprovementConfig` the same way. */
const SELF_IMPROVEMENT_KEYS: Record<keyof SelfImprovementConfig, true> = {
  repo: true,
  label: true,
  minRuns: true,
  top: true,
};

/** The keys of `value` that `known` does not name, in document order. */
function unknownKeys(value: object, known: Record<string, true>): string[] {
  return Object.keys(value).filter((key) => !Object.hasOwn(known, key));
}

/** Every scope's `instructions` (both kinds, either file) must be a string within the cap. */
export function validateInstructions(
  layer: { channels?: Record<string, Scope>; users?: Record<string, Scope> },
  source: string,
): void {
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
  ] as const) {
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

/** Reject an effort value outside EFFORT_LEVELS wherever config can carry one
 *  (static scopes, `defaults.efforts`, a hand-edited overrides.json). The chat
 *  command validates on write; this holds the files to the same rule at load. */
export function validateScopeEfforts(
  layer: {
    channels?: Record<string, Scope>;
    users?: Record<string, Scope>;
    defaults?: { efforts?: Record<string, unknown> };
  },
  source: string,
): void {
  const check = (path: string, value: unknown) => {
    if (value !== undefined && !isEffort(value)) {
      throw new Error(`${source}: ${path} is "${String(value)}" — valid efforts: ${EFFORT_LEVELS_HINT}`);
    }
  };
  for (const [agent, value] of Object.entries(layer.defaults?.efforts ?? {})) check(`defaults.efforts.${agent}`, value);
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
  ] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) {
      check(`${kind}.${id}.effort`, scope.effort);
      for (const [agent, value] of Object.entries(scope.efforts ?? {})) check(`${kind}.${id}.efforts.${agent}`, value);
    }
  }
}

/** The keys a boundary may carry — held equal to `Boundary` by the type checker. */
const BOUNDARY_KEYS: Record<keyof Boundary, true> = {
  maxMinutes: true,
  maxIdentity: true,
  machines: true,
  confirm: true,
};

/** The smallest budget a boundary may set: the bash tool keeps a 60-second
 *  reserve before the deadline, so a shorter run could never run a command. */
export const MIN_BOUNDARY_MINUTES = 2;

/**
 * One boundary, wherever config can carry it: a mapping of the three run axes
 * and the door's `confirm`, nothing else — `maxMinutes` an integer of at least
 * `MIN_BOUNDARY_MINUTES`, `maxIdentity` one of `IDENTITIES`, `machines` a list
 * naming at least one of `MACHINE_CLASSES` (an empty list would refuse every
 * preset, which is a lockout, not a cap — `restrict.agents` is the tool for
 * that), `confirm` one of `CONFIRM_CLASSES` — `exec` and `never` refused with
 * their own reasons (record 0044: a test or build never asks; `never` waits on
 * the door's measured misbind rate). Every finding names the path; the caller
 * decides what to do with it (the load throws, the chat command refuses by name).
 */
export function boundaryProblem(path: string, raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${path} must be a mapping`;
  for (const key of unknownKeys(raw, BOUNDARY_KEYS)) return `${path}: unknown field ${key}`;
  const b = raw as Record<keyof Boundary, unknown>;
  if (
    b.maxMinutes !== undefined &&
    (!Number.isInteger(b.maxMinutes) || (b.maxMinutes as number) < MIN_BOUNDARY_MINUTES)
  )
    return `${path}.maxMinutes must be an integer >= ${MIN_BOUNDARY_MINUTES}`;
  if (b.maxIdentity !== undefined && !IDENTITIES.includes(b.maxIdentity as Identity))
    return `${path}.maxIdentity is "${String(b.maxIdentity)}" — valid identities: ${IDENTITIES.join(", ")}`;
  if (b.machines !== undefined) {
    if (!Array.isArray(b.machines)) return `${path}.machines must be a list of classes`;
    if (b.machines.length === 0) return `${path}.machines must name at least one class`;
    for (const m of b.machines as unknown[]) {
      if (!MACHINE_CLASSES.includes(m as MachineClass))
        return `${path}.machines names "${String(m)}" — valid classes: ${MACHINE_CLASSES.join(", ")}`;
    }
  }
  if (b.confirm !== undefined) {
    if (b.confirm === "exec") return `${path}.confirm is "exec" — a test or build never asks (record 0044)`;
    if (b.confirm === "never")
      return `${path}.confirm is "never" — not allowed until the door's write misbind rate has been measured over a period (record 0044, open question 2)`;
    if (!CONFIRM_CLASSES.includes(b.confirm as ConfirmClass))
      return `${path}.confirm is "${String(b.confirm)}" — valid classes: ${CONFIRM_CLASSES.join(", ")}`;
  }
  return undefined;
}

/** Reject a malformed boundary wherever config can carry one (`defaults`, the
 *  static scopes, a hand-edited overrides document), naming the path
 *  (docs/reference/specs/routing-and-config.md item 2). The chat command
 *  validates on write with the same rule; this holds the files to it at load. */
export function validateBoundaries(
  layer: {
    channels?: Record<string, Scope>;
    users?: Record<string, Scope>;
    defaults?: { boundary?: unknown };
  },
  source: string,
): void {
  const check = (path: string, raw: unknown) => {
    if (raw === undefined) return;
    const problem = boundaryProblem(path, raw);
    if (problem) throw new Error(`${source}: ${problem}`);
  };
  check("defaults.boundary", layer.defaults?.boundary);
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
  ] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) check(`${kind}.${id}.boundary`, scope.boundary);
  }
}

/**
 * Every `mcpServers` map a config layer can carry (docs/reference/specs/mcp-tools.md items
 * 11 + 14), static or stored: names are slugs, URLs http(s) and not an internal
 * address (the same guard `web_fetch` uses), agents known, `auth` known, a
 * bearer's `tokenEnv` a name — and a channel or user entry may reach the
 * self-serve agents only. The chat command enforces the same on write; this
 * holds files and stored documents to the rule at load.
 */
export function validateMcpServers(
  layer: {
    channels?: Record<string, Scope>;
    users?: Record<string, Scope>;
    defaults?: { mcpServers?: Record<string, unknown> } | Scope;
  },
  source: string,
): void {
  const check = (path: string, tier: "org" | "channel" | "user", servers: Record<string, unknown> | undefined) => {
    if (servers === undefined) return;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers))
      throw new Error(`${source}: ${path} must be a mapping of name → server`);
    if (Object.keys(servers).length > MCP_SERVERS_PER_SCOPE_MAX)
      throw new Error(`${source}: ${path} has more than ${MCP_SERVERS_PER_SCOPE_MAX} servers`);
    for (const [name, raw] of Object.entries(servers)) {
      if (!MCP_SERVER_NAME_RE.test(name))
        throw new Error(
          `${source}: ${path}.${name}: server names are slugs (lowercase letters, digits, dashes; ≤ ${MCP_SERVER_NAME_MAX} chars)`,
        );
      if (!isMcpServerEntry(raw))
        throw new Error(
          `${source}: ${path}.${name} must be { url, auth: none|bearer|oauth, agents?, tokenEnv?, headersEnv? }`,
        );
      try {
        assertUrlAllowed(raw.url);
      } catch (err) {
        throw new Error(
          `${source}: ${path}.${name}.url: ${err instanceof Error ? err.message : "not an http(s) URL"}`,
          {
            cause: err,
          },
        );
      }
      for (const a of raw.agents ?? []) {
        if (!AGENTS[a]) throw new Error(`${source}: ${path}.${name}.agents: unknown agent "${a}"`);
        if (tier !== "org" && !MCP_SELF_SERVE_AGENTS.includes(a)) {
          throw new Error(
            `${source}: ${path}.${name}.agents: a ${tier}-scoped server may name ${MCP_SELF_SERVE_AGENTS.join("/")} only — "${a}" takes an org-wide server (defaults.mcpServers)`,
          );
        }
      }
      if (raw.tokenEnv !== undefined && raw.auth !== "bearer")
        throw new Error(`${source}: ${path}.${name}.tokenEnv only applies to auth: bearer`);
      for (const header of Object.keys(raw.headersEnv ?? {})) {
        if (!MCP_HEADER_NAME_RE.test(header))
          throw new Error(`${source}: ${path}.${name}.headersEnv: "${header}" is not an HTTP header name`);
        if (header.toLowerCase() === "authorization")
          throw new Error(
            `${source}: ${path}.${name}.headersEnv: the Authorization header is \`auth\`'s — use auth: bearer with tokenEnv`,
          );
      }
    }
  };
  check("defaults.mcpServers", "org", layer.defaults?.mcpServers as Record<string, unknown> | undefined);
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
  ] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {}))
      check(
        `${kind}.${id}.mcpServers`,
        kind === "channels" ? "channel" : "user",
        scope.mcpServers as Record<string, unknown> | undefined,
      );
  }
}

/** Validates in place: throws on the first fatal finding. The one non-fatal
 *  findings live elsewhere (`loadAppConfigFrom` reports the document source). */
export function validateConfig(cfg: AppConfig): void {
  // A key the document does not define is a typo or a setting that no longer
  // exists; either way it must not read as a working setting.
  for (const key of unknownKeys(cfg, CONFIG_KEYS)) throw new Error(`config.yaml: unknown key \`${key}\``);
  validateScopeEfforts(cfg, "config.yaml");
  validateScopeVerbosity(cfg, "config.yaml");
  validateBoundaries(cfg, "config.yaml");
  validateScopeBlocks(cfg, "config.yaml");
  validateHarnessWords(cfg, "config.yaml");
  validateMcpServers(cfg, "config.yaml");
  if (typeof cfg.organization !== "string" || cfg.organization.trim() === "") {
    throw new Error(
      "config.yaml must name the organization this installation serves (organization: <GitHub org or user login>)",
    );
  }
  if (!cfg.providers || Object.keys(cfg.providers).length === 0) {
    throw new Error("config.yaml must define at least one provider");
  }
  validateProviders(cfg, "config.yaml");
  if (!cfg.defaults?.agent || !cfg.defaults?.models) {
    throw new Error("config.yaml must define defaults.agent and defaults.models");
  }
  if (!AGENTS[cfg.defaults.agent]) {
    throw new Error(`defaults.agent "${cfg.defaults.agent}" is not a known agent`);
  }
  // Static instructions ride every turn too — hold them to the same cap the
  // chat command enforces, and fail loudly at load rather than silently truncate.
  validateInstructions(cfg, "config.yaml");
  // The one authorization shape: `grants` + `restrict` (docs/reference/authorization.md).
  validateGrants(cfg.grants);
  validateRestrict(cfg.restrict);
  validateSelfImprovement(cfg.selfImprovement);
  // The `metrics:` reader block (docs/reference/specs/run-metrics.md): refused by
  // field at load, like the costs block its credential rides with.
  parseMetricsConfig(cfg.metrics);
  if (cfg.runHistory !== undefined) validateRunHistory(cfg.runHistory);
  if (cfg.tracing !== undefined) validateTracing(cfg.tracing);
  validateRuntimeOverrides(cfg.runtimeOverrides);
  if (cfg.review !== undefined) validateReview(cfg.review);
  if (cfg.ship !== undefined) validateShip(cfg.ship);
  if (cfg.spawn !== undefined) validateSpawn(cfg.spawn);
  if (cfg.routing !== undefined) validateRouting(cfg.routing, cfg.providers);
  validateIntake(cfg);
  if (cfg.references !== undefined) validateReferences(cfg.references);
  if (cfg.artifacts !== undefined) validateArtifacts(cfg.artifacts);
  if (cfg.pi !== undefined) validatePi(cfg.pi);
  if (cfg.opencode !== undefined) validateOpenCode(cfg.opencode);
  validateDashboardConfig(cfg.dashboard);
  validateSlack(cfg.slack);
}

/** A Slack bot id as the `bot_id` field carries it: `B` and the upper-case alphanumerics Slack mints. */
const SLACK_BOT_ID = /^B[A-Z0-9]+$/;

/** `slack` (docs/reference/specs/slack-channel.md item 13): `relayApps`, when
 *  present, is a list of Slack bot ids — the apps whose relay footer names the
 *  requester. Held to the id's shape at load: an entry spelled as the actor id
 *  (`slack:bot:B…`) or a display name would match no poster, and every request
 *  the relay posts would be billed to the app while the operator believed the
 *  footer was read. Exported for tests. */
export function validateSlack(slack: unknown): void {
  if (slack === undefined) return;
  if (typeof slack !== "object" || slack === null || Array.isArray(slack))
    throw new Error("config.yaml: slack must be a mapping");
  const { relayApps } = slack as SlackConfig;
  if (relayApps === undefined) return;
  if (!Array.isArray(relayApps)) throw new Error("config.yaml: slack.relayApps must be a list of Slack bot ids (B…)");
  relayApps.forEach((id, i) => {
    if (typeof id !== "string" || !SLACK_BOT_ID.test(id))
      throw new Error(`config.yaml: slack.relayApps[${i}] is "${String(id)}" — a Slack bot id looks like B0ABC123`);
  });
}

/** The `pi` block's keys and its `compaction` block's, held equal to the types the way the top-level keys are. */
const PI_KEYS: Record<keyof PiConfig, true> = { compaction: true };
const PI_COMPACTION_KEYS: Record<keyof PiCompactionConfig, true> = { reserveTokens: true, keepRecentTokens: true };

/** `pi` (docs/reference/specs/harness-pi.md item 4): a mapping whose only key
 *  today is `compaction`, itself a mapping of `reserveTokens` and
 *  `keepRecentTokens` to positive integers — pi's own settings, in tokens. A
 *  non-mapping, an unknown key at either level, and a value that is not a
 *  positive integer fail the load by name: a threshold that silently read as
 *  "pi's default" while the operator believed a run would compact sooner
 *  would leave a receipt waiting on a compaction that never comes. */
function validatePi(pi: unknown): void {
  if (typeof pi !== "object" || pi === null || Array.isArray(pi)) throw new Error("config.yaml: pi must be a mapping");
  for (const key of unknownKeys(pi, PI_KEYS)) throw new Error(`config.yaml: pi.${key} is not a known key`);
  const { compaction } = pi as PiConfig;
  if (compaction === undefined) return;
  if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction))
    throw new Error("config.yaml: pi.compaction must be a mapping");
  for (const key of unknownKeys(compaction, PI_COMPACTION_KEYS))
    throw new Error(`config.yaml: pi.compaction.${key} is not a known key`);
  for (const key of Object.keys(PI_COMPACTION_KEYS) as Array<keyof PiCompactionConfig>) {
    const value = compaction[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0))
      throw new Error(`config.yaml: pi.compaction.${key} must be a positive integer (tokens)`);
  }
}

/** The roster's words as the messages name them: `pi and opencode`, `pi or opencode`. */
const harnessWords = (joiner: string): string => HARNESS_NAMES.join(joiner);

/**
 * Every `harness` map a config layer can carry (docs/reference/specs/harness.md
 * item 8) — the deployment's top-level block, a channel's or a user's scope,
 * static or stored: a mapping of registered presets to a harness's name — the
 * words the roster has (`HARNESS_NAMES`), read here so the validator spells no
 * list of its own. A preset the registry does not know, and any value that is
 * not one of those words — `codex`, `native` (the loop that no longer exists),
 * a case slip, a non-string — fail by name, naming the path and the words that
 * exist; a non-mapping fails naming the shape. The chat command enforces the
 * same on write; this holds `config.yaml` and a hand-edited or stored overrides
 * document to the rule at load: a setting that read as "your runs are on X"
 * while nothing was would be the worst kind of silent. `defaults.harness` is
 * refused pointing at the top-level block, so the deployment's words have one
 * spelling.
 */
export function validateHarnessWords(
  layer: {
    harness?: unknown;
    /** The `defaults` block as loaded — read only for the `harness` key it must not carry. */
    defaults?: Record<string, unknown>;
    channels?: Record<string, Scope>;
    users?: Record<string, Scope>;
  },
  source: string,
): void {
  const check = (path: string, harness: unknown) => {
    if (harness === undefined) return;
    if (typeof harness !== "object" || harness === null || Array.isArray(harness))
      throw new Error(`${source}: ${path} must be a mapping of preset to a harness name (${harnessWords(" or ")})`);
    for (const [preset, value] of Object.entries(harness)) {
      if (!Object.hasOwn(AGENTS, preset)) throw new Error(`${source}: ${path}.${preset} is not a known agent`);
      if (!isHarnessName(value))
        throw new Error(
          `${source}: ${path}.${preset}: ${typeof value === "string" ? value : JSON.stringify(value)} is not a harness; the harnesses are ${harnessWords(" and ")}`,
        );
    }
  };
  if (layer.defaults?.harness !== undefined)
    throw new Error(
      `${source}: defaults.harness is not a key; the deployment's harness words are the top-level harness block (harness.<preset>: ${harnessWords(" or ")})`,
    );
  check("harness", layer.harness);
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
  ] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) {
      // A scope is a mapping of settings; a scalar or a list under an id is
      // refused by name here rather than read for a key it cannot carry.
      if (typeof scope !== "object" || scope === null || Array.isArray(scope))
        throw new Error(`${source}: ${kind}.${id} must be a mapping of settings`);
      check(`${kind}.${id}.harness`, scope.harness);
    }
  }
}

/** The `opencode` block's keys and its `compaction` block's, held equal to the types the way pi's are. */
const OPENCODE_KEYS: Record<keyof OpenCodeConfig, true> = { compaction: true };
const OPENCODE_COMPACTION_KEYS: Record<keyof OpenCodeCompactionConfig, true> = { buffer: true, keepTokens: true };

/** `opencode` (docs/reference/specs/harness.md item 8): a mapping whose only
 *  key today is `compaction`, itself a mapping of `buffer` and `keepTokens` to
 *  positive integers — OpenCode's own words, in tokens. The same shape rules
 *  as `pi`, for the same reason: a threshold that silently read as "OpenCode's
 *  default" would leave a receipt waiting on a compaction that never comes,
 *  and pi's words under this block are a mistake, not a synonym. */
function validateOpenCode(opencode: unknown): void {
  if (typeof opencode !== "object" || opencode === null || Array.isArray(opencode))
    throw new Error("config.yaml: opencode must be a mapping");
  for (const key of unknownKeys(opencode, OPENCODE_KEYS))
    throw new Error(`config.yaml: opencode.${key} is not a known key`);
  const { compaction } = opencode as OpenCodeConfig;
  if (compaction === undefined) return;
  if (typeof compaction !== "object" || compaction === null || Array.isArray(compaction))
    throw new Error("config.yaml: opencode.compaction must be a mapping");
  for (const key of unknownKeys(compaction, OPENCODE_COMPACTION_KEYS))
    throw new Error(`config.yaml: opencode.compaction.${key} is not a known key`);
  for (const key of Object.keys(OPENCODE_COMPACTION_KEYS) as Array<keyof OpenCodeCompactionConfig>) {
    const value = compaction[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0))
      throw new Error(`config.yaml: opencode.compaction.${key} must be a positive integer (tokens)`);
  }
}

/** The two ways the router's model may answer (`routing.answer`; routing-and-config item 21):
 *  `tool` — forced to call the `route` tool, whose input is the answer;
 *  `text` — the one-JSON-object text contract alone, for a provider that
 *  cannot take a forced tool call. */
export const ROUTE_ANSWER_MODES = ["tool", "text"] as const;
export type RouteAnswerMode = (typeof ROUTE_ANSWER_MODES)[number];

/** The operator's three modes (`routing.operator`; record 0057, plan
 *  the one-door plan's operator unit; routing-and-config item 29): `off` (the default) —
 *  the operator never runs; `shadow` — it runs once per admitted chat event
 *  ahead of stage A, its decision is written beside the routed request and
 *  nothing runs from it; `on` — its decision is what runs. */
export const OPERATOR_MODES = ["off", "shadow", "on"] as const;
export type OperatorMode = (typeof OPERATOR_MODES)[number];

/** The `references` block's keys, held equal to `ReferencesConfig` the way the top-level keys are. */
const REFERENCES_KEYS: Record<keyof ReferencesConfig, true> = { enabled: true };

/** `references` (record 0037): `enabled` is a boolean and nothing else — a
 *  `"yes"` or a `1` is refused by name, never read as on or as off. Any other
 *  key is refused by name. */
function validateReferences(references: ReferencesConfig): void {
  if (typeof references !== "object" || references === null || Array.isArray(references))
    throw new Error("config.yaml: references must be a mapping");
  for (const key of unknownKeys(references, REFERENCES_KEYS))
    throw new Error(`config.yaml: references.${key} is not a known key`);
  if (references.enabled !== undefined && typeof references.enabled !== "boolean")
    throw new Error("config.yaml: references.enabled must be true or false");
}

/** The `providers` block's keys, held equal to `ProviderConfig` the way the
 *  top-level keys are. */
const PROVIDER_KEYS: Record<keyof ProviderConfig, true> = {
  type: true,
  wire: true,
  vendor: true,
  catalog: true,
  models: true,
  passthrough: true,
  apiKeyEnv: true,
  baseUrl: true,
  invoiceApi: true,
  invoiceKeyEnv: true,
};

/** A `models.<id>` override's keys, and the shapes they are held to. */
const MODEL_OVERRIDE_KEYS: Record<string, true> = {
  levels: true,
  capField: true,
  window: true,
  inputs: true,
  cache: true,
  price: true,
  answers: true,
};
const INPUT_KINDS: Record<string, true> = { image: true, document: true };
const PRICE_KINDS: Record<string, true> = { input: true, output: true, cacheRead: true, cacheWrite: true };
export const CACHE_RULES = ["automatic", "markers", "none", "unknown"] as const;

/** One `models.<id>` override held to its shape: a malformed `levels` (an
 *  unknown tier, a non-word), a bad cap field, window, input kind, cache rule
 *  or price kind is refused by name, never read as absent. */
export function validateModelOverride(path: string, raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} must be a mapping`);
  const m = raw as Record<string, unknown>;
  for (const key of unknownKeys(m, MODEL_OVERRIDE_KEYS)) throw new Error(`${path}.${key} is not a known key`);
  if (m.levels !== undefined) {
    if (typeof m.levels !== "object" || m.levels === null || Array.isArray(m.levels))
      throw new Error(`${path}.levels must be a mapping of effort → wire word or null`);
    for (const [tier, word] of Object.entries(m.levels as Record<string, unknown>)) {
      if (!isEffort(tier))
        throw new Error(`${path}.levels.${tier} is not an effort — valid efforts: ${EFFORT_LEVELS_HINT}`);
      if (word !== null && (typeof word !== "string" || word === ""))
        throw new Error(`${path}.levels.${tier} must be a wire word or null`);
    }
  }
  if (m.capField !== undefined && (typeof m.capField !== "string" || m.capField === ""))
    throw new Error(`${path}.capField must be the body field the output cap is spelled with`);
  if (m.window !== undefined && (!Number.isInteger(m.window) || (m.window as number) <= 0))
    throw new Error(`${path}.window must be a positive integer of tokens`);
  if (m.inputs !== undefined) {
    if (typeof m.inputs !== "object" || m.inputs === null || Array.isArray(m.inputs))
      throw new Error(`${path}.inputs must be a mapping of input kind → true or false`);
    for (const [kind, v] of Object.entries(m.inputs as Record<string, unknown>)) {
      if (!Object.hasOwn(INPUT_KINDS, kind))
        throw new Error(`${path}.inputs.${kind} is not a known input kind (image, document)`);
      if (typeof v !== "boolean") throw new Error(`${path}.inputs.${kind} must be true or false`);
    }
  }
  if (m.cache !== undefined && !(CACHE_RULES as readonly unknown[]).includes(m.cache))
    throw new Error(`${path}.cache must be ${CACHE_RULES.join(", ")}`);
  if (m.answers !== undefined) {
    if (!Array.isArray(m.answers))
      throw new Error(`${path}.answers must be a list of answer shapes (${ROUTE_ANSWER_MODES.join(", ")})`);
    for (const shape of m.answers as unknown[]) {
      if (!(ROUTE_ANSWER_MODES as readonly unknown[]).includes(shape))
        throw new Error(
          `${path}.answers carries ${JSON.stringify(shape)}, which is not an answer shape (${ROUTE_ANSWER_MODES.join(", ")})`,
        );
    }
  }
  if (m.price !== undefined) {
    if (typeof m.price !== "object" || m.price === null || Array.isArray(m.price))
      throw new Error(`${path}.price must be a mapping of kind → USD per million tokens`);
    for (const [kind, v] of Object.entries(m.price as Record<string, unknown>)) {
      if (!Object.hasOwn(PRICE_KINDS, kind))
        throw new Error(`${path}.price.${kind} is not a known kind (input, output, cacheRead, cacheWrite)`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        throw new Error(`${path}.price.${kind} must be a finite number of USD per million tokens, 0 or more`);
    }
  }
}

/**
 * Every provider block held to the new grammar (record 0052): `wire`
 * declared (with `type` still loading as its alias for one release, but not
 * beside it), a vendor that is a name or `model`, a `catalog` naming a file
 * the pi registry ships or `none`, and every `models.<id>` override well
 * formed. The legacy `type` is derived for the consumers that still read it,
 * so nothing downstream changes in this slice.
 */
export function validateProviders(cfg: AppConfig, source: string): void {
  for (const [name, block] of Object.entries(cfg.providers ?? {})) {
    const path = `${source}: providers.${name}`;
    if (typeof block !== "object" || block === null || Array.isArray(block))
      throw new Error(`${path} must be a mapping`);
    const b = block as unknown as Record<string, unknown>;
    for (const key of unknownKeys(b, PROVIDER_KEYS)) throw new Error(`${path}.${key} is not a known key`);
    if (b.type === undefined && b.wire === undefined)
      throw new Error(`${path} must declare wire (${WIRES.join(", ")}); type is its legacy alias for one release`);
    if (b.type !== undefined && b.wire !== undefined)
      throw new Error(
        `${path} declares both type and wire; declare wire alone (type: ${String(b.type)} loads as its alias for one release)`,
      );
    if (b.type !== undefined && b.type !== "anthropic" && b.type !== "openai-compatible")
      throw new Error(`${path}.type must be anthropic or openai-compatible; wire is the new spelling`);
    if (b.wire !== undefined && !(WIRES as readonly unknown[]).includes(b.wire))
      throw new Error(`${path}.wire must be ${WIRES.join(", ")}`);
    if (b.vendor !== undefined && (typeof b.vendor !== "string" || b.vendor === ""))
      throw new Error(`${path}.vendor must be a vendor name or "model"`);
    if (b.catalog !== undefined) {
      if (typeof b.catalog !== "string" || b.catalog === "")
        throw new Error(`${path}.catalog must be a registry file name or "none"`);
      if (!catalogExists(b.catalog))
        throw new Error(`${path}.catalog names "${b.catalog}", which the pi registry does not ship (or "none")`);
    }
    if (
      b.passthrough !== undefined &&
      (typeof b.passthrough !== "object" || b.passthrough === null || Array.isArray(b.passthrough))
    )
      throw new Error(`${path}.passthrough must be a mapping of body fields`);
    if (b.apiKeyEnv !== undefined && typeof b.apiKeyEnv !== "string")
      throw new Error(`${path}.apiKeyEnv must be a string`);
    if (b.baseUrl !== undefined && typeof b.baseUrl !== "string") throw new Error(`${path}.baseUrl must be a string`);
    if (b.invoiceApi !== undefined && !(INVOICE_APIS as readonly unknown[]).includes(b.invoiceApi))
      throw new Error(`${path}.invoiceApi must be ${INVOICE_APIS.join(", ")}`);
    if (b.invoiceKeyEnv !== undefined && (typeof b.invoiceKeyEnv !== "string" || b.invoiceKeyEnv === ""))
      throw new Error(`${path}.invoiceKeyEnv must be an env var name`);
    if ((b.invoiceApi === undefined) !== (b.invoiceKeyEnv === undefined))
      throw new Error(`${path} must declare invoiceApi and invoiceKeyEnv together (costs.md item 4d)`);
    if (b.models !== undefined) {
      if (typeof b.models !== "object" || b.models === null || Array.isArray(b.models))
        throw new Error(`${path}.models must be a mapping of model id → overrides`);
      for (const [id, raw] of Object.entries(b.models as Record<string, unknown>)) {
        if (b.vendor === "model" && !id.includes("/"))
          throw new Error(`${path}.models.${id}: a vendor: model block names its models <vendor>/<id>`);
        validateModelOverride(`${path}.models.${id}`, raw);
      }
    }
    // Derive the legacy word for every consumer that still reads `type` (the
    // proxy's shape, the harness card) — this slice changes no run's outcome.
    const derived = b.wire ?? WIRE_ALIASES[String(b.type)];
    (block as ProviderConfig).type = derived === "anthropic-messages" ? "anthropic" : "openai-compatible";
  }
}

/** The `routing` block's keys, held equal to `RoutingConfig` the way the top-level keys are. */
const ROUTING_KEYS: Record<keyof RoutingConfig, true> = { auto: true, model: true, answer: true, operator: true };

/** `routing` (docs/reference/specs/routing-and-config.md item 21): `auto` is a
 *  boolean and nothing else — a `"yes"` or a `1` is refused by name, never read
 *  as on or as off — and `model` is a `<provider>/<model>` ref whose provider
 *  the config declares, so a router that cannot be built fails the load rather
 *  than silently never routing. Any other key is refused by name. */
function validateRouting(routing: RoutingConfig, providers: Record<string, unknown> | undefined): void {
  if (typeof routing !== "object" || routing === null || Array.isArray(routing))
    throw new Error("config.yaml: routing must be a mapping");
  for (const key of unknownKeys(routing, ROUTING_KEYS))
    throw new Error(`config.yaml: routing.${key} is not a known key`);
  if (routing.auto !== undefined && typeof routing.auto !== "boolean")
    throw new Error("config.yaml: routing.auto must be true or false");
  if (routing.answer !== undefined && !(ROUTE_ANSWER_MODES as readonly unknown[]).includes(routing.answer))
    throw new Error(`config.yaml: routing.answer must be ${ROUTE_ANSWER_MODES.join(" or ")}`);
  if (routing.operator !== undefined && !(OPERATOR_MODES as readonly unknown[]).includes(routing.operator))
    throw new Error(`config.yaml: routing.operator must be ${OPERATOR_MODES.join(", ")}`);
  if (routing.model !== undefined) {
    if (typeof routing.model !== "string" || !routing.model.includes("/"))
      throw new Error("config.yaml: routing.model must be a <provider>/<model> ref");
    const provider = parseModelRef(routing.model).provider;
    if (!providers || !Object.hasOwn(providers, provider))
      throw new Error(`config.yaml: routing.model names provider "${provider}", which providers does not define`);
  }
}

/** The `intake` block's keys, held equal to `IntakeConfig` the way the top-level keys are. */
const INTAKE_KEYS: Record<keyof IntakeConfig, true> = { threadReplies: true, model: true };

/** The thread-reply gate's modes (routing-and-config item 27, record 0058). */
export const INTAKE_MODES = ["mention", "classify", "always"] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];

/** The gate's default mode (routing-and-config item 27): `intake.threadReplies`
 *  where the block sets it, else `classify` — the one place the default lives;
 *  callers ask this, never the field. Defined beside the validator that checks
 *  the card under it, re-exported by `src/config.ts` for every other caller. */
export function defaultIntakeMode(config: AppConfig): IntakeMode {
  return config.intake?.threadReplies ?? "classify";
}

/** The verdict's model ref, resolved as the router's is: `intake.model`, else
 *  `routing.model`, else `defaults.models.general`; undefined when the config
 *  names none — the gate then cannot classify and says so at its caller. The
 *  one resolver: `validateIntake` checks the card of the ref it returns, and
 *  `decideIntake` calls the same ref at runtime (`src/config.ts` re-exports it). */
export function intakeModelRef(config: AppConfig): string | undefined {
  return config.intake?.model ?? config.routing?.model ?? config.defaults?.models?.["general"];
}

/** `intake` (docs/reference/specs/routing-and-config.md item 27): the mode is
 *  one of the three words and nothing else, `model` is a `<provider>/<model>`
 *  ref whose provider the config declares — the routing block's own check —
 *  and, when the effective default mode is `classify` (the code's default, so
 *  an absent block counts), the effective model's operator card must support
 *  at least one answer shape: a card declaring `answers: []` can neither take
 *  the forced tool call nor the text contract, so it is refused at load,
 *  never silenced at runtime. Any other key is refused by name. */
function validateIntake(cfg: AppConfig): void {
  const intake = cfg.intake;
  if (intake !== undefined) {
    if (typeof intake !== "object" || intake === null || Array.isArray(intake))
      throw new Error("config.yaml: intake must be a mapping");
    for (const key of unknownKeys(intake, INTAKE_KEYS))
      throw new Error(`config.yaml: intake.${key} is not a known key`);
    if (intake.threadReplies !== undefined && !(INTAKE_MODES as readonly unknown[]).includes(intake.threadReplies))
      throw new Error(
        `config.yaml: intake.threadReplies must be ${INTAKE_MODES.join(", ").replace(/, (\w+)$/, " or $1")}`,
      );
    if (intake.model !== undefined) {
      if (typeof intake.model !== "string" || !intake.model.includes("/"))
        throw new Error("config.yaml: intake.model must be a <provider>/<model> ref");
      const provider = parseModelRef(intake.model).provider;
      if (!cfg.providers || !Object.hasOwn(cfg.providers, provider))
        throw new Error(`config.yaml: intake.model names provider "${provider}", which providers does not define`);
    }
  }
  // The classify card check: under the default mode intake will make a model
  // call, so a card the operator declared unable to answer either shape must
  // fail here by name rather than fall silent on every unmentioned reply.
  if (defaultIntakeMode(cfg) !== "classify") return;
  const ref = intakeModelRef(cfg);
  if (typeof ref !== "string" || !ref.includes("/")) return;
  const { provider, model } = parseModelRef(ref);
  const answers = (cfg.providers?.[provider] as ProviderConfig | undefined)?.models?.[model]?.answers;
  if (answers !== undefined && !answers.includes("tool") && !answers.includes("text"))
    throw new Error(
      `config.yaml: intake defaults to classify, and its model ${ref} supports neither a forced tool call nor the ` +
        `text contract (providers.${provider}.models.${model}.answers) — set intake.threadReplies to mention or ` +
        `always, or pick a model that answers one`,
    );
}

/** `grants`: every finding names the actor id and axis it is about —
 *  an unknown namespace, a misspelled `all`, an unknown field — and the load
 *  fails, because a silently dropped entry would be a silently missing grant. */
export function validateGrants(raw: unknown): ReadonlyMap<string, Grants> {
  if (raw === undefined) return new Map();
  const parsed = parseGrantsConfig(raw);
  if (!parsed.ok) throw new Error(`config.yaml: ${parsed.errors.join("; ")}`);
  return parsed.grants;
}

/** `restrict`: registered agent names and `owner/name` slugs, or a load error naming the offender. */
export function validateRestrict(raw: unknown): Restriction {
  const parsed = parseRestrictConfig(raw, Object.keys(AGENTS));
  if (!parsed.ok) throw new Error(`config.yaml: ${parsed.errors.join("; ")}`);
  return parsed.restrict;
}

/** The `ship` block's keys, held equal to `ShipConfig` the way the top-level keys are. */
const SHIP_KEYS: Record<keyof ShipConfig, true> = {
  maxRounds: true,
  maxMinutes: true,
  grant: true,
  idleDays: true,
};

/** The keys a grant may carry — held equal to `Grant` by the type checker. */
const GRANT_KEYS: Record<keyof Grant, true> = { renewals: true, costCapUsd: true };

/**
 * One grant, wherever config can carry it (the org's `ship.grant`, a channel's
 * or a user's `ship.grant`): a mapping of `renewals` — an integer from 0 to
 * `GRANT_RENEWALS_MAX` — and `costCapUsd`, a positive number of dollars, nothing
 * else (decision 0046, the renewable lease). Every finding names the path; the
 * caller decides what to do with it.
 */
export function grantProblem(path: string, raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${path} must be a mapping`;
  for (const key of unknownKeys(raw, GRANT_KEYS)) return `${path}: unknown field ${key}`;
  const g = raw as Record<keyof Grant, unknown>;
  if (
    g.renewals !== undefined &&
    (!Number.isInteger(g.renewals) || (g.renewals as number) < 0 || (g.renewals as number) > GRANT_RENEWALS_MAX)
  )
    return `${path}.renewals must be an integer from 0 to ${GRANT_RENEWALS_MAX} (decision 0046)`;
  if (
    g.costCapUsd !== undefined &&
    (typeof g.costCapUsd !== "number" || !Number.isFinite(g.costCapUsd) || g.costCapUsd <= 0)
  )
    return `${path}.costCapUsd must be a positive number of dollars`;
  return undefined;
}

/** The idle flag, wherever config can carry it (the org's `ship.idleDays`, a
 *  channel's or a user's): an integer count of days from 0 to `IDLE_DAYS_MAX`
 *  (record 0051), refused naming the path — a typo never reads as "never
 *  idles" or "idles a year". */
export function idleDaysProblem(path: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= IDLE_DAYS_MAX
    ? undefined
    : `${path} must be an integer from 0 to ${IDLE_DAYS_MAX} (record 0051)`;
}

/** The lever's old home, refused by name wherever a config still carries it —
 *  the org block or a scope, `config.yaml` or the stored overrides — so a stale
 *  key is never ignored into "no gate" (docs/reference/migrations.md, 1.245.0). */
const ADDRESS_SEVERITY_MOVED = (path: string): string =>
  `${path} moved to ${path.replace(/ship\.addressSeverity$/, "review.addressSeverity")} — the severity to address now gates every review's verdict, not ship alone (docs/reference/migrations.md)`;

/** The severity to address is one of the ladder, or the path is refused by
 *  name (docs/reference/specs/agent-review.md item 5a). */
function addressSeverityProblem(path: string, value: unknown): string | undefined {
  return value !== undefined && !isAddressSeverity(value)
    ? `${path} must be one of ${ADDRESS_SEVERITIES.join(", ")} (docs/reference/specs/agent-review.md item 5a)`
    : undefined;
}

/** The deployment's `review` block: the org's severity to address on the ladder. */
export function validateReview(review: ReviewConfig): void {
  const problem = addressSeverityProblem("review.addressSeverity", review.addressSeverity);
  if (problem) throw new Error(`config.yaml: ${problem}`);
}

/** GitHub's login rule: 1 to 39 characters, alphanumerics and single hyphens,
 *  not leading or trailing (record 0062). Case-insensitive on GitHub's side. */
const GITHUB_LOGIN_RE = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;
const GITHUB_LOGIN_MAX = 39;
const GITHUB_LOGIN_RULE = "1 to 39 characters, alphanumerics and single hyphens, not leading or trailing";

/** The keys a `{ login, id }` binding may carry. */
const GITHUB_BINDING_KEYS: Record<string, true> = { login: true, id: true, via: true };

/** One `users.<id>.github` value held to its shape (authorization.md item 18):
 *  a login string or `{ login, id, via? }`; the login GitHub's rule, never an
 *  app's `[bot]` suffix; the id an integer. Every finding names the path. */
function githubBindingProblem(path: string, raw: unknown): string | undefined {
  const loginProblem = (login: unknown): string | undefined => {
    if (typeof login !== "string") return `${path}.login must be a GitHub login`;
    if (login.endsWith("[bot]"))
      return `${path} names "${login}", which ends in [bot] — an app's login, never a person's`;
    if (login.length === 0 || login.length > GITHUB_LOGIN_MAX || !GITHUB_LOGIN_RE.test(login))
      return `${path} names "${login}", which is not a GitHub login (${GITHUB_LOGIN_RULE})`;
    return undefined;
  };
  if (typeof raw === "string") return loginProblem(raw);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return `${path} must be a GitHub login or { login, id }`;
  for (const key of unknownKeys(raw, GITHUB_BINDING_KEYS)) return `${path}: unknown field ${key}`;
  const b = raw as { login?: unknown; id?: unknown; via?: unknown };
  const bad = loginProblem(b.login);
  if (bad) return bad;
  if (!Number.isInteger(b.id)) return `${path}.id must be the account's integer id`;
  if (b.via !== undefined && b.via !== "email") return `${path}.via must be "email"`;
  return undefined;
}

/** The github key of one users map, lowercased login and id per user id. */
function githubBindingsOf(users: Record<string, Scope> | undefined): Map<string, { login?: string; id?: number }> {
  const bindings = new Map<string, { login?: string; id?: number }>();
  for (const [id, scope] of Object.entries(users ?? {})) {
    const github = scope?.github;
    if (github === undefined) continue;
    if (typeof github === "string") bindings.set(id, { login: github.toLowerCase() });
    else if (typeof github === "object" && github !== null)
      bindings.set(id, {
        ...(typeof github.login === "string" ? { login: github.login.toLowerCase() } : {}),
        ...(Number.isInteger(github.id) ? { id: github.id } : {}),
      });
  }
  return bindings;
}

/** The refusal a would-be binding write earns under the load-time duplicate rule
 *  (routing-and-config item 30): one GitHub login and one id under ONE person
 *  across the overrides `layer` and the static `base` together. The write path
 *  asks this BEFORE storing (`ConfigStore.githubBindingConflict`), so `config
 *  set user` refuses by the same words `validateScopeBlocks` would throw at the
 *  next load instead of poisoning the stored document. Rebinding the same
 *  person replaces, never duplicates; where a user is in both layers the
 *  override wins, as `layerScope` reads it. */
export function githubBindingConflict(
  userId: string,
  binding: { login: string; id: number },
  layer: { users?: Record<string, Scope> },
  base?: { users?: Record<string, Scope> },
): string | undefined {
  const combined = githubBindingsOf(base?.users);
  for (const [id, b] of githubBindingsOf(layer.users)) combined.set(id, b);
  combined.delete(userId);
  const login = binding.login.toLowerCase();
  for (const [other, b] of combined) {
    if (b.login === login)
      return `users ${other} and ${userId} both bind GitHub login "${binding.login}" — one login binds one person`;
    if (b.id === binding.id)
      return `users ${other} and ${userId} both bind GitHub id ${binding.id} — one account binds one person`;
  }
  return undefined;
}

/** Reject a malformed `review.addressSeverity` or `ship.grant` on a channel's or
 *  a user's scope, naming the path (docs/reference/specs/routing-and-config.md
 *  item 2); the org's ride `validateReview` and `validateShip`. A grant without
 *  `renewals` reads as zero at resolution. The `github` author binding
 *  (record 0062) is held here too: valid only under `users`, its shape
 *  `githubBindingProblem`'s, and one login and one id under one person across
 *  `layer` and `base` together — the static config when a stored overrides
 *  document is validated, so the two layers cannot bind one GitHub account to
 *  two people between them (a user present in both counts once: the override wins). */
export function validateScopeBlocks(
  layer: { channels?: Record<string, Scope>; users?: Record<string, Scope>; threads?: Record<string, Scope> },
  source: string,
  base?: { users?: Record<string, Scope> },
): void {
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
    // The thread layer is runtime-only (`config set thread`, routing-and-config
    // item 27): config.yaml has no `threads:` key, so only a stored overrides
    // document reaches this arm — held to the same rule by name.
    ["threads", layer.threads],
  ] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) {
      const level = addressSeverityProblem(`${kind}.${id}.review.addressSeverity`, scope.review?.addressSeverity);
      if (level) throw new Error(`${source}: ${level}`);
      // The intake gate's scope field (routing-and-config item 27): the mode
      // alone — the model is the defaults layer's — refused by name so a typo
      // never reads as "the default".
      if (scope.intake !== undefined) {
        if (typeof scope.intake !== "object" || scope.intake === null || Array.isArray(scope.intake))
          throw new Error(`${source}: ${kind}.${id}.intake must be a mapping`);
        for (const key of unknownKeys(scope.intake, { threadReplies: true }))
          throw new Error(`${source}: ${kind}.${id}.intake.${key} is not a known key`);
        const mode = scope.intake.threadReplies;
        if (mode !== undefined && !(INTAKE_MODES as readonly unknown[]).includes(mode))
          throw new Error(
            `${source}: ${kind}.${id}.intake.threadReplies must be ${INTAKE_MODES.join(", ").replace(/, (\w+)$/, " or $1")}`,
          );
      }
      // A scope written before the key moved (`config set … --ship.addressSeverity`)
      // is named, never silently ignored into "no gate".
      if (scope.ship !== undefined && "addressSeverity" in scope.ship)
        throw new Error(`${source}: ${ADDRESS_SEVERITY_MOVED(`${kind}.${id}.ship.addressSeverity`)}`);
      const idle = idleDaysProblem(`${kind}.${id}.ship.idleDays`, scope.ship?.idleDays);
      if (idle) throw new Error(`${source}: ${idle}`);
      // The author binding is a users key: under a channel or a thread it
      // would be read by nothing, so it is refused by name (record 0062).
      if (scope.github !== undefined && kind !== "users")
        throw new Error(`${source}: ${kind}.${id}.github is a users key — a GitHub binding belongs to a person`);
      if (kind === "users" && scope.github !== undefined) {
        const problem = githubBindingProblem(`${kind}.${id}.github`, scope.github);
        if (problem) throw new Error(`${source}: ${problem}`);
      }
      const grant = scope.ship?.grant;
      if (grant === undefined) continue;
      const problem = grantProblem(`${kind}.${id}.ship.grant`, grant);
      if (problem) throw new Error(`${source}: ${problem}`);
    }
  }
  // One GitHub account binds one person, across both layers together: the
  // base's bindings under this layer's (the same user id counts once — the
  // override replaces the static value whole, as `layerScope` reads it).
  const combined = githubBindingsOf(base?.users);
  for (const [id, binding] of githubBindingsOf(layer.users)) combined.set(id, binding);
  const byLogin = new Map<string, string>();
  const byId = new Map<number, string>();
  for (const [userId, binding] of combined) {
    if (binding.login !== undefined) {
      const other = byLogin.get(binding.login);
      if (other !== undefined)
        throw new Error(
          `${source}: users ${other} and ${userId} both bind GitHub login "${binding.login}" — one login binds one person`,
        );
      byLogin.set(binding.login, userId);
    }
    if (binding.id !== undefined) {
      const other = byId.get(binding.id);
      if (other !== undefined)
        throw new Error(
          `${source}: users ${other} and ${userId} both bind GitHub id ${binding.id} — one account binds one person`,
        );
      byId.set(binding.id, userId);
    }
  }
}

/** Reject a verbosity outside VERBOSITY_LEVELS wherever config can carry one
 *  (docs/reference/specs/routing-and-config.md item 28: `defaults.verbosity`,
 *  a static scope, a hand-edited overrides document). The chat command
 *  validates on write; this holds the files to the same rule at load, so a
 *  typo never reads as "the default". */
export function validateScopeVerbosity(
  layer: {
    channels?: Record<string, Scope>;
    users?: Record<string, Scope>;
    defaults?: { verbosity?: unknown };
  },
  source: string,
): void {
  const check = (path: string, value: unknown) => {
    if (value !== undefined && !isVerbosity(value))
      throw new Error(`${source}: ${path} is "${String(value)}" — valid verbosity levels: ${VERBOSITY_LEVELS_HINT}`);
  };
  check("defaults.verbosity", layer.defaults?.verbosity);
  for (const [kind, scopes] of [
    ["channels", layer.channels],
    ["users", layer.users],
  ] as const) {
    for (const [id, scope] of Object.entries(scopes ?? {})) check(`${kind}.${id}.verbosity`, scope.verbosity);
  }
}

/** `ship` caps (docs/reference/specs/agent-ship.md item 8): both bounds enforced at load
 *  so a typo cannot silently become "no cap" (mirrors validateRunHistory). Any
 *  other key is refused by name — `coordinator` above all, the switch that once
 *  chose between the plan runner and an in-process loop: the runner is the one
 *  ship implementation now, so a config still carrying the key is told to drop
 *  it rather than left believing it chose anything (docs/reference/migrations.md). */
function validateShip(ship: ShipConfig): void {
  if (typeof ship !== "object" || ship === null) throw new Error("config.yaml: ship must be a mapping");
  for (const key of unknownKeys(ship, SHIP_KEYS)) {
    if (key === "coordinator")
      throw new Error(
        "config.yaml: ship.coordinator is no longer a key — every agent:ship request runs on the plan runner; remove it (docs/reference/migrations.md)",
      );
    if (key === "addressSeverity") throw new Error(`config.yaml: ${ADDRESS_SEVERITY_MOVED("ship.addressSeverity")}`);
    throw new Error(`config.yaml: ship.${key} is not a known key`);
  }
  const rounds = ship.maxRounds;
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1))
    throw new Error("config.yaml: ship.maxRounds must be an integer >= 1");
  // The pipeline holds the loop it allows (agent-ship item 8, decision 0046):
  // the fit — provisioning, the coding child at its ask, and the reserve for
  // every later round at its floor — is asserted here over the deployment's
  // numbers, so a pipeline that cannot hold its own loop is refused at load
  // naming the sum, never left to cap out on every unit.
  const minutes = ship.maxMinutes;
  if (minutes !== undefined && !Number.isInteger(minutes))
    throw new Error("config.yaml: ship.maxMinutes must be an integer (docs/reference/specs/agent-ship.md item 8)");
  const pipeline = {
    maxMinutes: minutes ?? SHIP_DEFAULT_MAX_MINUTES,
    maxRounds: (ship.maxRounds as number | undefined) ?? SHIP_DEFAULT_MAX_ROUNDS,
  };
  const held = fit(pipeline);
  if (!held.ok)
    throw new Error(
      `config.yaml: ship.maxMinutes ${pipeline.maxMinutes} cannot hold the loop ship.maxRounds ${pipeline.maxRounds} allows — ` +
        `${held.need} minutes are needed (${ALLOWANCES.provision} to provision, the coding child's ${ASKS.coding}, and the reserve for ` +
        `${pipeline.maxRounds} review rounds at their floors); raise ship.maxMinutes or lower ship.maxRounds (docs/reference/specs/agent-ship.md item 8)`,
    );
  // The grant (decision 0046): renewals within the module's ceiling, a positive cap.
  if (ship.grant !== undefined) {
    const problem = grantProblem("ship.grant", ship.grant);
    if (problem) throw new Error(`config.yaml: ${problem}`);
  }
  // The idle flag (record 0051): a count of days within the module's bounds.
  const idle = idleDaysProblem("ship.idleDays", ship.idleDays);
  if (idle) throw new Error(`config.yaml: ${idle}`);
}

/** The `spawn` block's keys, held equal to `SpawnConfig` the way the top-level keys are. */
const SPAWN_KEYS: Record<keyof SpawnConfig, true> = { maxChildren: true };

/** `spawn.maxChildren` (docs/reference/specs/agent-conductor.md item 5): the fan-out
 *  cap, enforced at load so a typo cannot silently become "no cap" — the same
 *  rule the ship caps are held to. */
function validateSpawn(spawn: SpawnConfig): void {
  if (typeof spawn !== "object" || spawn === null) throw new Error("config.yaml: spawn must be a mapping");
  for (const key of unknownKeys(spawn, SPAWN_KEYS)) throw new Error(`config.yaml: spawn.${key} is not a known key`);
  const v = spawn.maxChildren;
  if (v !== undefined && (!Number.isInteger(v) || v < 1))
    throw new Error("config.yaml: spawn.maxChildren must be an integer >= 1");
}

/** `tracing.log` (docs/reference/specs/tracing.md): the two verbosity levels the log sink
 *  knows; anything else is a typo, refused at load. */
function validateTracing(t: TracingConfig): void {
  if (typeof t !== "object" || t === null) throw new Error("config.yaml: tracing must be a mapping");
  if (t.log !== undefined && !TRACING_LOG_LEVELS.includes(t.log)) {
    throw new Error(`config.yaml: tracing.log must be one of ${TRACING_LOG_LEVELS.join(", ")}`);
  }
}

/** `runHistory` (docs/reference/specs/run-history.md): retention bounds are enforced
 *  at load so a typo cannot silently become "keep nothing"; the Worker URL must
 *  be https: because the bearer rides every request. */
function validateRunHistory(rh: RunHistoryConfig): void {
  if (typeof rh !== "object" || rh === null) throw new Error("config.yaml: runHistory must be a mapping");
  for (const key of ["retentionDays", "maxRuns"] as const) {
    const v = rh[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1))
      throw new Error(`config.yaml: runHistory.${key} must be an integer >= 1`);
  }
  for (const key of ["maxBytes", "sessionLogMaxBytes"] as const) {
    const v = rh[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1))
      throw new Error(`config.yaml: runHistory.${key} must be an integer >= 1`);
  }
  if (rh.store !== undefined && rh.store !== "worker" && rh.store !== "file")
    throw new Error('config.yaml: runHistory.store must be "worker" or "file"');
  if (rh.worker !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(String(rh.worker.baseUrl));
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== "https:")
      throw new Error("config.yaml: runHistory.worker.baseUrl must be an https: URL");
  }
}

/** `selfImprovement` (docs/reference/specs/self-improvement.md item 1): a mapping of
 *  `repo`/`label`/`minRuns`/`top`; the friction ledger is run history
 *  (`runHistory`), so the section has no ledger keys and an unknown field is
 *  refused by name, never ignored as if it did something. */
function validateSelfImprovement(si: AppConfig["selfImprovement"]): void {
  if (si === undefined) return;
  if (typeof si !== "object" || si === null) throw new Error("config.yaml: selfImprovement must be a mapping");
  for (const key of unknownKeys(si, SELF_IMPROVEMENT_KEYS))
    throw new Error(`config.yaml: selfImprovement: unknown field ${key}`);
}

/** `runtimeOverrides` (routing-and-config item 12): a mapping; `worker.baseUrl` https; `tokenEnv` a name. */
function validateRuntimeOverrides(ro: AppConfig["runtimeOverrides"]): void {
  if (ro !== undefined) {
    if (typeof ro !== "object" || ro === null || Array.isArray(ro))
      throw new Error("config.yaml: runtimeOverrides must be a mapping");
    if (ro.worker !== undefined) {
      if (typeof ro.worker !== "object" || ro.worker === null)
        throw new Error("config.yaml: runtimeOverrides.worker must be a mapping with baseUrl");
      let url: URL | undefined;
      try {
        url = new URL(String(ro.worker.baseUrl));
      } catch {
        url = undefined;
      }
      if (!url || url.protocol !== "https:")
        throw new Error("config.yaml: runtimeOverrides.worker.baseUrl must be an https: URL");
      if (ro.worker.tokenEnv !== undefined && (typeof ro.worker.tokenEnv !== "string" || !ro.worker.tokenEnv)) {
        throw new Error("config.yaml: runtimeOverrides.worker.tokenEnv must be an environment variable name");
      }
    }
  }
}
