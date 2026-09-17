// Load-time validation of the configuration document and of a stored overrides
// document. Every finding names the key it is about and fails the load, so a
// typo never silently becomes "no cap", "no restriction" or "no setting".

import { TRACING_LOG_LEVELS } from "../core/trace/sinks.js";
import { EFFORT_LEVELS_HINT, isEffort } from "../effort.js";
import type { SelfImprovementConfig } from "../core/selfImprovement.js";
import type { RunHistoryConfig } from "../core/runStore.js";
import {
  ADDRESS_SEVERITIES,
  isAddressSeverity,
  SHIP_DEFAULT_MAX_ROUNDS,
  SHIP_DEFAULT_MAX_MINUTES,
  type ShipConfig,
} from "../core/shipPipeline.js";
import { ALLOWANCES, ASKS, fit } from "../core/budgets.js";
import type { SpawnConfig } from "../core/dispatch/spawn.js";
import { validateDashboardConfig } from "../core/dashboardAuthConfig.js";
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
  OpenCodeConfig,
  PiCompactionConfig,
  PiConfig,
  ReferencesConfig,
  RoutingConfig,
  Scope,
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
  delivery: true,
  dashboard: true,
  review: true,
  ship: true,
  spawn: true,
  routing: true,
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
  validateBoundaries(cfg, "config.yaml");
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
  if (cfg.runHistory !== undefined) validateRunHistory(cfg.runHistory);
  if (cfg.tracing !== undefined) validateTracing(cfg.tracing);
  validateRuntimeOverrides(cfg.runtimeOverrides);
  if (cfg.ship !== undefined) validateShip(cfg.ship);
  if (cfg.spawn !== undefined) validateSpawn(cfg.spawn);
  if (cfg.routing !== undefined) validateRouting(cfg.routing, cfg.providers);
  if (cfg.references !== undefined) validateReferences(cfg.references);
  if (cfg.artifacts !== undefined) validateArtifacts(cfg.artifacts);
  if (cfg.pi !== undefined) validatePi(cfg.pi);
  if (cfg.opencode !== undefined) validateOpenCode(cfg.opencode);
  validateDashboardConfig(cfg.dashboard);
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

/** The `routing` block's keys, held equal to `RoutingConfig` the way the top-level keys are. */
const ROUTING_KEYS: Record<keyof RoutingConfig, true> = { auto: true, model: true, answer: true };

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
  if (routing.model !== undefined) {
    if (typeof routing.model !== "string" || !routing.model.includes("/"))
      throw new Error("config.yaml: routing.model must be a <provider>/<model> ref");
    const provider = routing.model.slice(0, routing.model.indexOf("/"));
    if (!providers || !Object.hasOwn(providers, provider))
      throw new Error(`config.yaml: routing.model names provider "${provider}", which providers does not define`);
  }
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
const SHIP_KEYS: Record<keyof ShipConfig, true> = { maxRounds: true, maxMinutes: true, addressSeverity: true };

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
  // The severity gate: the level an approve's findings are held to.
  if (ship.addressSeverity !== undefined && !isAddressSeverity(ship.addressSeverity))
    throw new Error(
      `config.yaml: ship.addressSeverity must be one of ${ADDRESS_SEVERITIES.join(", ")} (docs/reference/specs/agent-ship.md item 9)`,
    );
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
