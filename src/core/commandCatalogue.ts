import { readFileSync } from "node:fs";
import { AGENTS } from "../agents/registry.js";
import { bootstrapOnHost } from "../agentEnv/host.js";
import type { ConfigStore } from "../config.js";
import type { AffectedReport } from "../deploy/affected.js";
import type { LoadedProfile } from "../deploy/profile.js";
import {
  computeAffectedOnHost,
  hasNodeModules,
  hostDeployFiles,
  loadProfileOnHost,
  runBotRestart,
  runDeployPlan,
} from "../deploy/run.js";
import { hostSecretsIO } from "../deploy/secretsHost.js";
import { LocalOperations } from "../execution/executor.js";
import { localWorkspaceDir } from "../execution/factory.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { ResidentOperations } from "../execution/resident.js";
import {
  CommandRegistry,
  bindCommands,
  type Caller,
  type CommandInvoker,
  type CommandRegistryOptions,
} from "./commandRegistry.js";
import { registerCoreCommands, type CoreCommandDeps } from "./commands/all.js";
import { selectFrictionLedger, type FrictionLedger } from "./frictionLedger.js";
import { buildFrictionLedger } from "./frictionLedgerWorker.js";
import type { MemoryStore } from "./memory/types.js";
import { MCP_OFF_MESSAGE, type McpService } from "../mcp/service.js";
import type { Operations } from "./operations.js";
import { residentAdminFromConfig, type ResidentAdminClient } from "./residentAdmin.js";
import type { RunRegistry } from "./runRegistry.js";
import type { RunStore } from "./runStore.js";
import { createRunsService, type RunsService } from "./runsService.js";
import { SCHEDULES } from "./schedules.js";
import { githubRepoInspector, type RepoInspector } from "../execution/githubRepoInspect.js";
import type { ScheduleStore } from "./scheduleStore.js";

// THE one catalogue every in-process binding shares — src/index.ts (bot) and
// src/cli.ts (the derived CLI): `registerCoreCommands` bound over the run store
// from `runHistory` config (null → live-only), the same `RunRegistry`, the
// friction ledger selected the way the bot selects it (run store when
// configured, legacy rows unioned), the resident admin client from
// `execution.resident` + its bearer, the deterministic-op backend the execution
// config implies, the memory store, and the schedule store. A surface that
// binds anything else would answer `runs list` differently from the others.
// Every dep is resolved per call where config can reload.

/** How an in-process binding reaches the catalogue's deps. */
export interface CoreCommandWiring {
  /** The live registry — `defaultRunRegistry` in every real process, so the
   *  commands see the runs the dispatcher creates. */
  registry: RunRegistry;
  env: Record<string, string | undefined>;
  /** Where the host-disk fallbacks (friction JSONL) live. */
  dataDir: string;
  warn: (message: string) => void;
  /** Reuse an already-built service (index.ts shares ONE RunsService with the /runs pages). */
  runs?: RunsService;
  /** Reuse an already-selected ledger (index.ts shares it with `record()`). */
  frictionLedger?: FrictionLedger;
  /** Where `friction.propose` files (index.ts passes the dispatcher's `issueTracker`); default: GitHub REST. */
  tracker?: IssueTracker;
  /** The process's memory store (index.ts shares the one the reflection pass
   *  writes to); absent → the in-process fallback when memory is enabled. */
  memory?: () => MemoryStore | undefined;
  /** `deploy plan|all --affected`'s selection; default: the host probe over this checkout and the live fleet (tests inject a report). */
  affected?: (opts: { base?: string }) => Promise<AffectedReport>;
  /** The deployment profile — the host's `deploy/profile.json` unless a test supplies one. */
  profile?: () => Promise<LoadedProfile>;
  /** Where scheduled firings are recorded; absent → `schedule list` shows no history. */
  scheduleStore?: ScheduleStore;
  /** The MCP service (#394) behind `mcp.*`, or why MCP is off; absent → the
   *  commands answer `unavailable` with the standard sentence. */
  mcp?: () => Promise<McpService | { unavailable: string }> | McpService | { unavailable: string };
  /** The resident admin client; default: from `execution.resident` + its bearer (per call). */
  residentAdmin?: () => ResidentAdminClient | undefined;
  /** `repo onboard`'s root inspection (resident-repos item 52); default: GitHub
   *  REST with the App's read token. */
  repoInspector?: RepoInspector;
  /** The deterministic-op backend; default: resident-backed when a resident is
   *  configured, local for local execution, none otherwise (per call). */
  operations?: (caller: Caller) => Operations | null;
  /** The registry's audit sink; default: the registry's console line. */
  audit?: CommandRegistryOptions["audit"];
  now?: () => number;
}

/** Default Operations backend, mirroring executor selection's config reads:
 *  resident-backed wherever a resident service is configured (operator
 *  bearer), local for local execution (the caller's thread workspace — dev/CLI),
 *  else none (a per-thread remote backend has no deterministic-op surface). */
export function defaultOperations(
  config: ConfigStore,
  env: Record<string, string | undefined>,
  caller: Caller,
): Operations | null {
  const execution = config.config.execution;
  const resident = execution?.resident;
  if (resident?.baseUrl) {
    const token = env[resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN"];
    return token ? new ResidentOperations({ baseUrl: resident.baseUrl, token }) : null;
  }
  if (!execution?.type || execution.type === "local") {
    return new LocalOperations(
      localWorkspaceDir(config.config.workspaceDir ?? "./workspaces", caller.origin?.threadKey ?? caller.id),
    );
  }
  return null;
}

/** `friction analyze`'s input: a file, or stdin for `-`. */
function readSource(source: string): Promise<string> {
  return Promise.resolve(readFileSync(source === "-" ? 0 : source, "utf8"));
}

/** A dependency handed in ready, or produced on first use. The CLI hands the
 *  bot config (and the run store derived from it) in lazily: `deploy.*`,
 *  `env.*`, `friction analyze`, `schedule list` and `help show` never touch
 *  them, so those run in a checkout without `config/config.yaml`; a command
 *  that does touch them gets whatever the accessor throws (the CLI throws a
 *  clear `unavailable` CommandError) as its result. */
export type Provided<T> = T | (() => T | Promise<T>);

/** Resolve once, on first use, asynchronously: the config's overrides backing
 *  may be the state Worker, so opening it is an await — and because every
 *  config-backed dep below reaches for it through this accessor, a command that
 *  never touches the config never waits for the open (#409), with nothing to
 *  classify. A rejected open is NOT cached: the next command retries. */
function once<T>(provided: Provided<T>): () => Promise<T> {
  if (typeof provided !== "function") {
    const ready = Promise.resolve(provided);
    return () => ready;
  }
  const make = provided as () => T | Promise<T>;
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= Promise.resolve()
      .then(make)
      .catch((err: unknown) => {
        pending = undefined;
        throw err;
      }));
}

export function buildCoreCommands(
  config: Provided<ConfigStore>,
  store: Provided<RunStore | null>,
  wiring: CoreCommandWiring,
): CommandInvoker {
  const registry = new CommandRegistry<CoreCommandDeps>(wiring.audit ? { audit: wiring.audit } : {});
  registerCoreCommands(registry);
  const warn = (prefix: string) => (m: string) => wiring.warn(`[${prefix}] ${m}`);
  const cfg = once(config);
  const runStore = once(store);
  const ledger = once(
    async () =>
      wiring.frictionLedger ??
      selectFrictionLedger(
        await runStore(),
        buildFrictionLedger((await cfg()).config.selfImprovement, wiring.env, {
          dataDir: wiring.dataDir,
          warn: warn("friction"),
        }),
        warn("friction"),
      ),
  );
  const runs = once(
    async () => wiring.runs ?? createRunsService({ registry: wiring.registry, store: await runStore() }),
  );
  const admin = async (): Promise<ResidentAdminClient | { unavailable: string }> =>
    wiring.residentAdmin?.() ?? residentAdminFromConfig(await cfg(), wiring.env);
  const deps: CoreCommandDeps = {
    help: {
      agents: () => Object.values(AGENTS).map((a) => ({ name: a.name, description: a.description })),
      commands: () => registry.list(),
    },
    config: {
      describeConfig: async (c, u) => (await cfg()).describeConfig(c, u),
      scopes: async (c, u) => (await cfg()).scopes(c, u),
      setChannelOverride: async (c, p) => (await cfg()).setChannelOverride(c, p),
      setUserOverride: async (u, p) => (await cfg()).setUserOverride(u, p),
      clearChannelOverride: async (c) => (await cfg()).clearChannelOverride(c),
      clearUserOverride: async (u) => (await cfg()).clearUserOverride(u),
      agentNames: () => Object.keys(AGENTS),
    },
    runs,
    friction: {
      ledger,
      tracker: wiring.tracker,
      config: async () => (await cfg()).config.selfImprovement,
      readSource,
    },
    repo: {
      admin,
      operations: async (caller) =>
        wiring.operations ? wiring.operations(caller) : defaultOperations(await cfg(), wiring.env, caller),
      canUseRepo: async (callerId, slug) => (await cfg()).canUseRepo(callerId, slug),
      inspect: wiring.repoInspector ?? githubRepoInspector(),
    },
    memory: {
      config: async () => (await cfg()).config.memory,
      get store() {
        return wiring.memory?.();
      },
    },
    mcp: { service: async () => (await wiring.mcp?.()) ?? { unavailable: MCP_OFF_MESSAGE } },
    schedule: { schedules: SCHEDULES, store: wiring.scheduleStore, now: wiring.now ?? Date.now },
    deploy: {
      run: (plan) =>
        runDeployPlan(plan, {
          log: (l) => console.log(l),
          warn: (l) => console.error(l),
          stream: (c) => process.stdout.write(c),
        }),
      restart: (plan) => runBotRestart(plan, { log: (l) => console.log(l), warn: (l) => console.error(l) }),
      checkout: { hasNodeModules },
      affected: wiring.affected ?? computeAffectedOnHost,
      profile: wiring.profile ?? loadProfileOnHost,
      files: hostDeployFiles,
      secrets: hostSecretsIO,
    },
    env: { bootstrap: bootstrapOnHost },
  };
  return bindCommands(registry, deps);
}
