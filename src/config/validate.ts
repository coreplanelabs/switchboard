// Load-time validation of the configuration document and of a stored overrides
// document. Every finding names the key it is about and fails the load, so a
// typo never silently becomes "no cap", "no restriction" or "no setting".

import { TRACING_LOG_LEVELS } from "../core/trace/sinks.js";
import { EFFORT_LEVELS_HINT, isEffort } from "../effort.js";
import type { SelfImprovementConfig } from "../core/selfImprovement.js";
import type { RunHistoryConfig } from "../core/runStore.js";
import type { ShipConfig } from "../core/shipPipeline.js";
import { validateDashboardConfig } from "../core/dashboardAuthConfig.js";
import { parseGrantsConfig, parseRestrictConfig, type Restriction } from "../core/authz/grants.js";
import type { Grants } from "../core/authz/types.js";
import { AGENTS } from "../agents/registry.js";
import { assertUrlAllowed } from "../tools/web.js";
import {
  isMcpServerEntry,
  MCP_SELF_SERVE_AGENTS,
  MCP_SERVER_NAME_MAX,
  MCP_SERVER_NAME_RE,
  MCP_SERVERS_PER_SCOPE_MAX,
} from "../mcp/registry.js";
import type { AppConfig, Scope, TracingConfig } from "../config.js";

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
  selfImprovement: true,
  schedules: true,
  costs: true,
  delivery: true,
  dashboard: true,
  review: true,
  ship: true,
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
        throw new Error(`${source}: ${path}.${name} must be { url, auth: none|bearer|oauth, agents?, tokenEnv? }`);
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
  validateDashboardConfig(cfg.dashboard);
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

/** `ship` caps (docs/reference/specs/agent-ship.md item 8): both bounds enforced at load
 *  so a typo cannot silently become "no cap" (mirrors validateRunHistory). */
function validateShip(ship: ShipConfig): void {
  if (typeof ship !== "object" || ship === null) throw new Error("config.yaml: ship must be a mapping");
  for (const key of ["maxRounds", "maxMinutes"] as const) {
    const v = ship[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 1))
      throw new Error(`config.yaml: ship.${key} must be an integer >= 1`);
  }
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
  if (rh.maxBytes !== undefined && (!Number.isInteger(rh.maxBytes) || rh.maxBytes < 1))
    throw new Error("config.yaml: runHistory.maxBytes must be an integer >= 1");
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
