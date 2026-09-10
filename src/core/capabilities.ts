import type { AppConfig } from "../config.js";
import { parseMcpSettings } from "../mcp/config.js";
import { parseCostsConfig } from "./costs.js";
import { resolveDashboardAuthMode, type DashboardAuthMode } from "./dashboardAuthConfig.js";
import { parseIngressTokenMap } from "./ingressTokens.js";
import type { EnvRecord, Secrets } from "../secrets.js";

// What is ON in this process — Fowler's feature toggles, resolved ONCE at
// startup (src/index.ts, src/cli.ts) from the config and the environment, and
// handed down through `CoreDeps.capabilities`. Every surface reads THIS value:
// the command registry hides what is off (`CommandDef.enabledWhen`), the web
// seed carries it so the dashboard paints only the tabs that exist, the
// self-description block describes only what is wired, the deploy plan
// iterates the profile's Workers. No surface reads `config.memory?.enabled`
// or probes an env var of its own — a scattered `if (config.x)` is the smell
// this module exists to remove. Adding a capability is one field here plus
// the `enabledWhen` predicates that name it; nothing else changes.
//
// Pure: config + env in, one value out. The rules mirror the builders that
// select each subsystem's implementation (`buildRunStore`, `buildRunLedger`,
// `buildScheduleStore`, `buildMcp`, `residentAdminFromConfig`, the costs
// wiring) — a test pins each axis to its builder so the two cannot drift.

export interface Capabilities {
  /** Where a run's tools execute (`execution.type`; `local` when unset). */
  execution: "local" | "e2b" | "cloudflare";
  /** Resident repo environments: `execution.resident.baseUrl` names the resident Worker. */
  residents: boolean;
  /** Cross-session memory: `memory.enabled` is true. */
  memory: boolean;
  /** Durable run history: a `runHistory` block that selects a store (`store: file`, or a `worker` with its bearer in the env). */
  runHistory: boolean;
  /** The run ledger (reclaim, resume, handoff): run history on a state Worker — a file store has no ledger. */
  runLedger: boolean;
  /** External MCP servers as tools and the `mcp.*` self-serve commands: an `mcp` block. */
  mcp: boolean;
  /** The spend dashboard: a `costs` block AND its Cloudflare analytics token in the env. */
  costs: boolean;
  /** Scheduled firings recorded: `schedules.worker.baseUrl` with its bearer in the env. */
  schedules: boolean;
  /** A GitHub credential: the App triple (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID`) or the static `GH_TOKEN`. */
  github: boolean;
  /** The HTTP and MCP ingress surfaces: `SWITCHBOARD_INGRESS_TOKENS` names at least one bearer. */
  ingress: boolean;
  /**
   * The dashboard auth strategy that gates the dashboards (docs/reference/specs/access-gate.md):
   * `config.dashboard.auth` when set; else `access` when a Cloudflare Access app
   * is configured (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`, the JWT re-verified
   * in-process), else `none` (no credential — loopback callers on a localhost
   * deployment only). `token` is a bearer from a named env var resolving to one
   * configured actor. The same rule (`resolveDashboardAuthMode`) composes the
   * verifier in src/index.ts, so this value names the strategy that actually runs.
   */
  dashboardAuth: DashboardAuthMode;
}

/** Everything on — the catalogue as the reference docs render it, and the shape a fixture starts from. */
export const ALL_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  execution: "cloudflare",
  residents: true,
  memory: true,
  runHistory: true,
  runLedger: true,
  mcp: true,
  costs: true,
  schedules: true,
  github: true,
  ingress: true,
  dashboardAuth: "access",
});

/** The minimal installation: Slack plus a provider, tools on the bot host, nothing optional configured. */
export const NO_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  execution: "local",
  residents: false,
  memory: false,
  runHistory: false,
  runLedger: false,
  mcp: false,
  costs: false,
  schedules: false,
  github: false,
  ingress: false,
  dashboardAuth: "none",
});

const DEFAULT_STATE_TOKEN_ENV = "MEMORY_TOKEN";

const present = (value: string | undefined): boolean => typeof value === "string" && value.trim() !== "";

/** A `{ baseUrl, tokenEnv? }` Worker reference the env can honour: the URL is
 *  named and its bearer is set (the rule every state-Worker builder applies). */
function workerReachable(worker: { baseUrl?: string; tokenEnv?: string } | undefined, secrets: Secrets): boolean {
  return present(worker?.baseUrl) && secrets.named(worker?.tokenEnv ?? DEFAULT_STATE_TOKEN_ENV) !== undefined;
}

/**
 * The one computation. Throws exactly where the builders it mirrors throw — a
 * malformed `costs` or `mcp` block — so a bad config is a startup error here as
 * it is there, never a capability silently read as off.
 */
export function capabilitiesFrom(config: AppConfig, env: EnvRecord, secrets: Secrets): Capabilities {
  const runHistory = config.runHistory;
  const runHistoryOn =
    runHistory !== undefined && (runHistory.store === "file" || workerReachable(runHistory.worker, secrets));
  const costs = parseCostsConfig(config.costs);
  const ingress = parseIngressTokenMap(secrets.get("SWITCHBOARD_INGRESS_TOKENS")?.reveal());
  const accessConfigured = present(env.ACCESS_TEAM_DOMAIN) && present(env.ACCESS_AUD);
  return {
    execution: config.execution?.type ?? "local",
    residents: present(config.execution?.resident?.baseUrl),
    memory: config.memory?.enabled === true,
    runHistory: runHistoryOn,
    runLedger: runHistoryOn && runHistory?.store !== "file",
    mcp: parseMcpSettings(config.mcp) !== undefined,
    costs: costs !== undefined && secrets.named(costs.cloudflareTokenEnv) !== undefined,
    schedules: workerReachable(config.schedules?.worker, secrets),
    github:
      (secrets.get("GITHUB_APP_ID") !== undefined &&
        secrets.get("GITHUB_APP_PRIVATE_KEY") !== undefined &&
        secrets.get("GITHUB_APP_INSTALLATION_ID") !== undefined) ||
      secrets.get("GH_TOKEN") !== undefined,
    ingress: ingress.ok && Object.keys(ingress.tokens).length > 0,
    dashboardAuth: resolveDashboardAuthMode(config.dashboard?.auth, accessConfigured),
  };
}
