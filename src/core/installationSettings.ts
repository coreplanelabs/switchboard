import { ARTIFACT_DEFAULTS } from "../artifacts/config.js";
import { referencesOn, routingOn, type AppConfig } from "../config.js";
import { DEFAULT_WINDOW_MS } from "../channels/slackCatchUp.js";
import type { Capabilities } from "./capabilities.js";
import { parseDeliveryConfig, SNAPSHOT_EVERY_MINUTES } from "./delivery.js";
import { maxChildrenOf } from "./dispatch/spawn.js";
import { DEFAULT_SCOPE_CAP } from "./memory/engine.js";
import { DEFAULT_MEMORY_LIMIT, DEFAULT_MEMORY_TOKENS } from "./memory/scorer.js";
import { MEAT_TIMEOUT_S_DEFAULT } from "./readingDiff.js";
import { DEFAULT_RETENTION_POLICY } from "./runRecord.js";
import { resolveShipCaps } from "./shipPipeline.js";

// The Installation tab of the settings page (docs/reference/specs/settings-page.md
// item 3): what the running config.yaml says about the behaviour a customer
// can see, one row per knob, and which capabilities are on. A projection by
// ALLOW-LIST: every row below is written out by name, and nothing is iterated
// off the config object, so a block that names an env var, a Worker URL or an
// account beside its knob (memory.worker, runHistory.worker, costs, execution)
// contributes exactly the knob. A new config.yaml key is invisible here until
// someone adds its line; the test holds the rendered rows free of every shape a
// secret takes.
//
// Pure: config + capabilities in, one value out. The view (settingsView.ts)
// puts it on the seed; nothing here reads the environment.

/** How a knob changes: at run time with `config set` (a channel or user
 *  overrides the default), or in config.yaml followed by `deploy config` and a
 *  restart (the process keeps the config it started with). */
export type SettingRoute = "runtime" | "config";

export interface InstallationSetting {
  /** The dotted config.yaml key. */
  key: string;
  /** The value in force, rendered. */
  value: string;
  /** The key is absent from config.yaml and the built-in default is in force. */
  isDefault: boolean;
  how: SettingRoute;
  /** One line on what the knob does. */
  note: string;
}

export interface CapabilityRow {
  key: keyof Capabilities;
  /** On or off; the two non-boolean axes carry their mode. */
  on: boolean | string;
  /** The config.yaml block (and the shape of environment it needs) that turns it on, in words. */
  how: string;
}

export interface InstallationView {
  settings: InstallationSetting[];
  capabilities: CapabilityRow[];
}

const fmt = (v: unknown): string =>
  v === undefined || v === null ? "" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : String(v);

/** One row: the configured value when the key is set, else the default marked as such. */
function row(key: string, configured: unknown, dflt: unknown, how: SettingRoute, note: string): InstallationSetting {
  const isDefault = configured === undefined;
  return { key, value: fmt(isDefault ? dflt : configured), isDefault, how, note };
}

/** The sentence that turns each capability on, without an env var's name (the
 *  page is served to whoever the dashboard admits; the names live in the how-to). */
const CAPABILITY_HOW: Readonly<Record<keyof Capabilities, string>> = {
  execution:
    "execution.type: local (default), e2b with its key, or cloudflare with the sandbox Worker's URL and shared key",
  residents: "execution.resident.baseUrl plus the operator and admin bearers for the resident Worker",
  memory: "memory.enabled: true; durable with memory.worker.baseUrl and the state Worker's bearer",
  runHistory: "runHistory.store: file, or runHistory.worker.baseUrl with the state Worker's bearer",
  runLedger: "run history on the state Worker (worker, not file)",
  mcp: "an mcp block with its credential key in the environment",
  costs: "a costs block with the Cloudflare analytics key in the environment; optionally the Anthropic admin key",
  metrics: "a metrics block naming the dataset, beside the costs block and its Cloudflare analytics key",
  schedules: "schedules.worker.baseUrl with the state Worker's bearer, and the cron identity among the ingress bearers",
  github: "the GitHub App triple in the environment, or a personal GitHub key",
  ingress: "at least one ingress bearer in the environment, each granted under grants",
  readingDiffAbridge:
    "the meat binary on the bot host, the Anthropic provider's key, and review.readingDiff.provider not off",
  dashboardAuth: "dashboard.auth: access (with a Cloudflare Access app), a dashboard bearer, or none on localhost",
};

export function installationSettings(config: AppConfig, caps: Capabilities): InstallationView {
  const settings: InstallationSetting[] = [];
  const d = config.defaults;
  settings.push(
    row(
      "defaults.agent",
      d.agent,
      d.agent,
      "runtime",
      "the preset a plain message runs as when no channel, user or router says otherwise",
    ),
  );
  for (const [agent, model] of Object.entries(d.models).sort(([a], [b]) => a.localeCompare(b)))
    settings.push(row(`defaults.models.${agent}`, model, model, "runtime", `the model the ${agent} preset runs on`));
  for (const [agent, effort] of Object.entries(d.efforts ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    settings.push(
      row(
        `defaults.efforts.${agent}`,
        effort,
        effort,
        "runtime",
        `how hard the ${agent} preset's model thinks per turn`,
      ),
    );
  const boundary = d.boundary;
  settings.push(
    row(
      "defaults.boundary.maxMinutes",
      boundary?.maxMinutes,
      "uncapped",
      "runtime",
      "the most wall-clock minutes any run may have",
    ),
    row(
      "defaults.boundary.maxIdentity",
      boundary?.maxIdentity,
      "uncapped",
      "runtime",
      "the highest credential a run may act as (none, read, write)",
    ),
    row(
      "defaults.boundary.machines",
      boundary?.machines,
      "every class",
      "runtime",
      "the machine classes a run's tools may execute on",
    ),
  );

  const routing = config.routing;
  settings.push(
    row(
      "routing.auto",
      routing?.auto,
      routingOn(config),
      "config",
      "a plain message is routed to a preset by the fast model",
    ),
    row("routing.model", routing?.model, d.models.general, "config", "the model the router asks"),
    row(
      "routing.answer",
      routing?.answer,
      "tool",
      "config",
      "how the router's model answers: a forced tool call, or one JSON object as text",
    ),
    row(
      "references.enabled",
      config.references?.enabled,
      referencesOn(config),
      "config",
      "a permalink to a public thread is quoted onto the request",
    ),
  );

  const ship = resolveShipCaps(config.ship);
  settings.push(
    row("ship.maxRounds", config.ship?.maxRounds, ship.maxRounds, "config", "review rounds a ship unit may take"),
    row(
      "ship.maxMinutes",
      config.ship?.maxMinutes,
      ship.maxMinutes,
      "config",
      "the ship preset's wall-clock budget in minutes",
    ),
    row(
      "spawn.maxChildren",
      config.spawn?.maxChildren,
      maxChildrenOf(config.spawn),
      "config",
      "children a conductor run may have live at once",
    ),
  );

  const catchUp = config.slack?.catchUp;
  settings.push(
    row(
      "slack.catchUp.enabled",
      catchUp?.enabled,
      true,
      "config",
      "mentions posted while the bot was disconnected are run on reconnect",
    ),
    row(
      "slack.catchUp.windowMinutes",
      catchUp?.windowMinutes,
      DEFAULT_WINDOW_MS / 60_000,
      "config",
      "how far back the reconnect catch-up reads",
    ),
  );

  const readingDiff = config.review?.readingDiff;
  settings.push(
    row(
      "review.readingDiff.provider",
      readingDiff?.provider,
      "git",
      "config",
      "the reading diff a review records: git, meat (abridged after every review), or off",
    ),
    row(
      "review.readingDiff.meatModel",
      readingDiff?.meatModel,
      undefined,
      "config",
      "the model meat abridges with — required with provider: meat, no built-in model",
    ),
    row(
      "review.readingDiff.meatTimeoutS",
      readingDiff?.meatTimeoutS,
      MEAT_TIMEOUT_S_DEFAULT,
      "config",
      "meat's budget on the host, in seconds",
    ),
  );

  const history = config.runHistory;
  settings.push(
    row(
      "runHistory.retentionDays",
      history?.retentionDays,
      DEFAULT_RETENTION_POLICY.retentionDays,
      "config",
      "days a finished run stays readable",
    ),
    row("runHistory.maxRuns", history?.maxRuns, DEFAULT_RETENTION_POLICY.maxRuns, "config", "newest runs kept"),
    row(
      "runHistory.maxBytes",
      history?.maxBytes,
      DEFAULT_RETENTION_POLICY.maxBytes,
      "config",
      "total stored bytes kept",
    ),
    row(
      "runHistory.includeContext",
      history?.includeContext,
      true,
      "config",
      "the thread-context turns fed to the model are kept in the run stream",
    ),
  );

  const memory = config.memory;
  settings.push(
    row(
      "memory.enabled",
      memory?.enabled,
      false,
      "config",
      "cross-session memory: records distilled after a run, injected before the next",
    ),
    row("memory.limit", memory?.limit, DEFAULT_MEMORY_LIMIT, "config", "records injected per request at most"),
    row("memory.maxTokens", memory?.maxTokens, DEFAULT_MEMORY_TOKENS, "config", "the injected block's token budget"),
    row(
      "memory.maxRecordsPerScope",
      memory?.maxRecordsPerScope,
      DEFAULT_SCOPE_CAP,
      "config",
      "active records kept per scope before the least recently used are evicted",
    ),
    row("memory.model", memory?.model, "the run's own model", "config", "the model the reflection pass distills with"),
  );

  const artifacts = config.artifacts;
  settings.push(
    row(
      "artifacts.retentionDays",
      artifacts?.retentionDays,
      config.artifacts ? ARTIFACT_DEFAULTS.retentionDays : "no store",
      "config",
      "days a run's files stay in the artifact store",
    ),
    row(
      "artifacts.inbound.maxBytesPerMessage",
      artifacts?.inbound?.maxBytesPerMessage,
      config.artifacts ? ARTIFACT_DEFAULTS.maxBytesPerMessage : "no store",
      "config",
      "the most staged bytes one message may carry",
    ),
  );

  const self = config.selfImprovement;
  settings.push(
    row(
      "selfImprovement.repo",
      self?.repo,
      "unset (friction propose refuses)",
      "config",
      "the repository friction proposals are filed against",
    ),
    row(
      "selfImprovement.minRuns",
      self?.minRuns,
      2,
      "config",
      "a pattern must recur in at least this many runs to be proposed",
    ),
    row("selfImprovement.top", self?.top, 3, "config", "proposals filed per pass"),
  );

  const delivery = parseDeliveryConfig(config.delivery);
  settings.push(
    row(
      "delivery.repos",
      delivery?.repos.length ? delivery.repos : undefined,
      "none",
      "config",
      "the repositories the delivery page serves",
    ),
    row(
      "delivery.snapshot.everyMinutes",
      (config.delivery as { snapshot?: { everyMinutes?: number } } | undefined)?.snapshot?.everyMinutes,
      SNAPSHOT_EVERY_MINUTES.default,
      "config",
      "how often each repository's facts are read from GitHub",
    ),
  );

  const capabilities: CapabilityRow[] = (Object.keys(CAPABILITY_HOW) as (keyof Capabilities)[]).map((key) => ({
    key,
    on: caps[key],
    how: CAPABILITY_HOW[key],
  }));
  return { settings, capabilities };
}
