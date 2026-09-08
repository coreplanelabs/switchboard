import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BootstrapResult } from "../agentEnv/bootstrap.js";
import { AGENTS } from "../agents/registry.js";
import { CLI_CALLER, parseCliArgv, runCli } from "../cli.js";
import { ConfigStore } from "../config.js";
import { callerFor, createCommandHttpHandler } from "../channels/commandHttp.js";
import { handleMcpRequest, toCaller } from "../channels/mcp.js";
import { resolveChatActor } from "./authz/actor.js";
import { authorize } from "./authz/authorize.js";
import { NO_GRANTS } from "./authz/types.js";
import { callerWith } from "./testing/callers.js";
import type { DeployPlan } from "../deploy/plan.js";
import type { RestartPlan } from "../deploy/restart.js";
import { TEST_PROFILE } from "../deploy/testing/profile.js";
import { renderWorkerConfigs, TEMPLATE_FILE } from "../deploy/wranglerTemplate.js";
import type { DeployRunResult, RestartRunResult } from "../deploy/run.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { buildCoreCommands } from "./commandCatalogue.js";
import { invokeChatCommand, parseChatCommand } from "./commandChat.js";
import {
  bindCommands,
  CommandError,
  CommandRegistry,
  commandDefiner,
  parseInput,
  renderText,
  resourceOf,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_PREAMBLE,
  type Caller,
  type CommandDef,
  type CommandInput,
  type CommandInvoker,
  type InvokeErrorCode,
  type InvokeResult,
} from "./commandRegistry.js";
import { cliFlag, jsonSchemaFor, namedToInput, tokenize, toSurfaceNames } from "./commandSurface.js";
import { coreCommandGroups, registerCoreCommands, type CoreCommandDeps } from "./commands/all.js";
import type { CoreDeps } from "./dispatcher.js";
import { RunStoreFrictionLedger } from "./frictionLedger.js";
import { InMemoryMemoryStore } from "./memory/stores.js";
import type { MemoryRecord } from "./memory/types.js";
import type { Operations } from "./operations.js";
import type { ResidentAdminClient } from "./residentAdmin.js";
import type { RunEvent } from "./runEvents.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import { RunRegistry } from "./runRegistry.js";
import { InMemoryRunStore } from "./runStore.js";
import { createRunsService } from "./runsService.js";
import { SCHEDULES } from "./schedules.js";
import { InMemoryScheduleStore } from "./scheduleStore.js";
import {
  importCredentialKey,
  InMemoryMcpClient,
  InMemoryMcpSecretStore,
  McpService,
  type McpServerEntry,
} from "../mcp/index.js";
import { InMemoryOverridesBacking, type Overrides } from "../config.js";
import {
  admits,
  AUTHZ_INGRESS_TOKENS,
  AUTHZ_PERMISSIONS,
  AUTHZ_ROLES,
  buildAuthorizationMatrix,
  buildConformanceMatrix,
  carriedBy,
  catalogueSnapshot,
  COMMAND_FIXTURES,
  CROSS_CUTTING_ASSERTIONS,
  expectedFlags,
  expectedRejection,
  exposedOn,
  fieldsOf,
  FIXTURE,
  forCaller,
  parseCatalogueTable,
  policyGaps,
  QUOTED_SAMPLE,
  quoteChatToken,
  renderAuthorizationMatrix,
  renderConformanceMatrix,
  renderVariantCell,
  roleActor,
  schemaPropertyNames,
  SURFACE_METAS,
  toArgv,
  toChatText,
  toKebabQuery,
  UNKNOWN_OPTION,
  variantsOf,
  withCallerToken,
  type AuthzRole,
  type Named,
  type SurfaceMeta,
  type Variant,
} from "./testing/commandConformance.js";

// Feature: features/command-registry.md item 25 — the REGISTRY-DRIVEN
// CONFORMANCE SUITE. Nothing below names a command: the catalogue is enumerated
// (`registerCoreCommands`, asserted identical to `buildCoreCommands`), every
// case is generated from each command's declared zod schemas
// (`exhaustiveVariants`), and ONE pattern is asserted per command × variant ×
// surface (HTTP GET/POST, MCP tools/call, CLI argv, chat text):
//   1. name mapping + round-trip: the adapter's route/tool/argv/text binds to
//      the same parsed `{ args, options }` on every surface;
//   2. the MCP inputSchema lists exactly the fields (enums/defaults survive);
//   3. help names every argument and option; a refusal carries the ONE code
//      every surface uses for that fault (`invalid_input`, whether the grammar
//      or the registry saw it first), names the field and never echoes the
//      submitted value;
//   4. auth: admission on every surface is `authorize(actor, action, resource)`
//      over the policy table — a fixed actor set × every command is derived from
//      the table and checked against the real adapters (R13); a credential with
//      no grants is refused before parse; writes are POST-only; reads never
//      mutate the fixture; the Caller the registry saw is the adapter's;
//   5. output hygiene: no capability token or planted secret; stored free text
//      wrapped as untrusted on machine surfaces;
//   6. every surface yields the identical `invoke` JSON (chat: `renderText` of it)
//      — identical MODULO THE CALLER'S OWN ID: a caller-scoped command (memory,
//      invariant 4) answers with the caller's own scope key, and each surface
//      resolves a different caller id (`access:…`, `mcp:…`, `cli:local`,
//      `slack:U…`), so the reference is `invoke` with that surface's caller and
//      the cross-surface comparison folds the id back to `{caller.id}`;
//   7. a sorted catalogue snapshot + the docs table fence the catalogue; the
//      matrix `scripts/command-conformance-matrix.ts` prints is the suite's own.
// A new command is covered the moment it is registered — or fails loudly here
// (no sample for a field, a happy path that does not succeed against the
// generic fixture, a missing docs row, a stale snapshot) until its author adds
// a `FIELD_HINTS` entry / `COMMAND_FIXTURES` row / docs row / snapshot update.
//
// Nothing real runs: every executing dependency is a recording stub (below),
// and `node:child_process` + `fetch` are disarmed for the whole file — a
// command that reached a real runner would fail here, not deploy something.

vi.mock("node:child_process", () => {
  const armed = (name: string) => () => {
    throw new Error(`conformance suite: node:child_process.${name} must never run — a command reached a real executor`);
  };
  return {
    spawn: armed("spawn"),
    spawnSync: armed("spawnSync"),
    exec: armed("exec"),
    execSync: armed("execSync"),
    execFile: armed("execFile"),
    execFileSync: armed("execFileSync"),
    fork: armed("fork"),
  };
});

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("conformance suite: fetch must never run — a command reached the network");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const NOW = 1_700_000_000_000;

/** `deploy init`'s world: one template for every Worker dir, and each rendered file already equal to its render. */
const FIXTURE_TEMPLATE = '{ "name": "{{script}}", "account_id": "{{account}}" }\n';
const FIXTURE_RENDERED: ReadonlyMap<string, string> = (() => {
  const r = renderWorkerConfigs(TEST_PROFILE, () => FIXTURE_TEMPLATE);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return new Map(r.files.map((f) => [f.path, f.text]));
})();
/** Stored free text: must leave a machine surface wrapped as untrusted, or not at all. */
const PLANTED_TEXT = "PLANTED-FREE-TEXT-5b7e";
/** A secret that lives in the process (env) — must never reach any output. */
const PLANTED_ENV_SECRET = "PLANTED-ENV-SECRET-2d9a";
/** Every substring no output may ever contain. Filled per fixture with the live run's token. */
const SECRET_FRAGMENTS = ["tok-", PLANTED_ENV_SECRET, "9f3c1e", "4242424242"];

const POWER = "slack:UPOWER";
const NOBODY = "slack:UNOBODY";
/** The channel a chat caller speaks from (its `origin`) — deliberately not the fixture's `--channel`. */
const CHAT_CHANNEL = "slack:CX";

const BASE_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
`;

/** The generic fixture's deployment: one Slack admin, no `channelConfig` (open-when-absent), and the
 *  HTTP power caller granted everything NATIVELY (`adminsHint`, folded by caller id in the
 *  cross-surface comparison, names Slack admins only, so the hint reads the same on every surface). */
const CONFIG_YAML = `${BASE_YAML}permissions:
  admins: ["${POWER}"]
  repoManagement: ["${POWER}"]
grants:
  "access:power":
    actions: all
    channels: all
    repos: all
`;

/** The authorization matrix's deployment: `AUTHZ_PERMISSIONS`, spelled as config.yaml. */
const AUTHZ_YAML = `${BASE_YAML}permissions:
  admins: ${JSON.stringify(AUTHZ_PERMISSIONS.admins)}
  repoManagement: ${JSON.stringify(AUTHZ_PERMISSIONS.repoManagement)}
  channelConfig: ${JSON.stringify(AUTHZ_PERMISSIONS.channelConfig)}
  operators: ${JSON.stringify(AUTHZ_PERMISSIONS.operators)}
  serviceTokens: ${JSON.stringify(AUTHZ_PERMISSIONS.serviceTokens)}
`;

const CONFIG_DIR = (() => {
  const dir = mkdtempSync(join(tmpdir(), "swb-conformance-"));
  writeFileSync(join(dir, "config.yaml"), CONFIG_YAML);
  writeFileSync(join(dir, "authz.yaml"), AUTHZ_YAML);
  return dir;
})();
let configN = 0;
/** A fresh config store per fixture: overrides are on-disk state a write changes.
 *  The store knows the catalogue's groups (operators, browser reads) and the
 *  matrix's ingress tokens, as the bot's does at startup. */
function freshConfig(yaml: "config" | "authz" = "config"): { store: ConfigStore; overridesPath: string } {
  const overridesPath = join(CONFIG_DIR, `overrides-${++configN}.json`);
  return {
    store: new ConfigStore(join(CONFIG_DIR, `${yaml}.yaml`), overridesPath, () => {}, {
      commandGroups: coreCommandGroups(),
      ingressTokens: AUTHZ_INGRESS_TOKENS,
    }),
    overridesPath,
  };
}

// ---- the generic fixture ----------------------------------------------------------------------------

/** Every caller id the suite drives a command as — each gets its own memory scope. */
const CALLER_IDS = [
  ...new Set([
    "access:power",
    "access:svc:svc-none",
    "mcp:power",
    "mcp:nobody",
    CLI_CALLER.id,
    "cli:nobody",
    "cli:reference",
    POWER,
    NOBODY,
    ...AUTHZ_ROLES.map((r) => r.id),
  ]),
];

const RESIDENTS = {
  cap: 6,
  count: 1,
  residents: [
    {
      resource: `repo:${FIXTURE.repo}`,
      defaultRef: "master",
      commands: { install: "npm ci", build: "npm run build", test: "npm test" },
      live: { state: "warm", reason: "", sha: "0123456789abcdef" },
    },
  ],
};

function record(id: string, finishedAt: number): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: `please do the thing ${PLANTED_TEXT}`, seq: 1 },
    { type: "tool_call", tool: "bash", summary: "$ pnpm install --frozen-lockfile", seq: 2, at: 10 },
    { type: "tool_result", tool: "bash", ok: false, summary: "ERR_PNPM_OUTDATED_LOCKFILE", seq: 3, at: 45_010 },
    { type: "answer", text: `all done ${PLANTED_TEXT}`, seq: 4 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: `slack:C1:${id}`,
    channelVisibility: "public", // public: every fixture caller may read it — conformance is about surfaces, not visibility
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
  };
}

function memoryRecord(scopeKey: string): MemoryRecord {
  return {
    id: `mem:${scopeKey}:1`,
    scopeKey,
    kind: "fact",
    text: `remembered ${PLANTED_TEXT}`,
    keywords: ["remembered"],
    sourceThreadKey: "slack:C1:t0",
    createdAt: NOW - 5000,
    useCount: 0,
    status: "active",
  };
}

/** Records in EVERY scope a command can reach: each caller's own, org, the fixture repo, the chat channel. */
const MEMORY_SEED = [
  ...CALLER_IDS.map((id) => `user:${id}`),
  "org:acme",
  `repo:${FIXTURE.repo}`,
  `channel:${CHAT_CHANNEL}`,
].map(memoryRecord);

interface Recorded {
  id: string;
  input: CommandInput;
  caller: Caller;
  result: InvokeResult;
}

interface Fixture {
  /** The bound catalogue every adapter is handed — records each `invoke`. */
  commands: CommandInvoker;
  recorded: Recorded[];
  config: ConfigStore;
  liveId: string;
  liveToken: string;
  /** Every call a stubbed executor received (resident admin writes, ops, deploys, bootstraps). */
  executed: string[];
  /** Everything a read command could change, as one string. */
  fingerprint(): Promise<string>;
}

function recording(inner: CommandInvoker, recorded: Recorded[]): CommandInvoker {
  return {
    list: () => inner.list(),
    get: (id) => inner.get(id),
    invoke: async (id, input, caller) => {
      const result = await inner.invoke(id, input, caller);
      recorded.push({ id, input, caller, result });
      return result;
    },
    settles: (id) => inner.settles(id),
    settle: (id, value, caller) => inner.settle(id, value, caller),
  };
}

interface Stubs {
  reg: RunRegistry;
  store: InMemoryRunStore;
  tracker: InMemoryIssueTracker;
  config: ConfigStore;
  memory: InMemoryMemoryStore;
  schedules: InMemoryScheduleStore;
  executed: string[];
  commands: () => ReadonlyArray<CommandDef<unknown>>;
}

/** ONE in-memory implementation of every dependency the catalogue declares
 *  (`CoreCommandDeps`). A new deps slice in `commands/all.ts` is a compile
 *  error on this object until it is faked here — the loud failure by design.
 *  Anything that would execute (resident admin writes, deterministic ops, the
 *  deploy runner, the env bootstrap, the run-stream source) RECORDS the call
 *  into `executed` and answers a plausible shape. */
/** The MCP service (#394) over a THROWAWAY config store per call: the seeded
 *  `linear` server (auth none) exists in the org tier, the fixture channel, and
 *  every caller's own tier — so each surface's caller finds "its" server under
 *  the default `me` scope and the outputs fold by caller id like memory's —
 *  and a write (`mcp add`) lands in a document nobody else reads, so `add`
 *  never conflicts with itself across surfaces and `remove` leaves the seed
 *  for the next one. In-memory client (no network); fixed nonce + clock so
 *  `connect`/`add` answer identically everywhere. */
function fakeMcpService(): McpService {
  // Bearer without a stored credential (`awaiting_credential`): `connect` mints a
  // link for it, `show` reports the missing credential, `remove` drops it.
  const linear = (addedBy: string): McpServerEntry => ({
    url: "https://mcp.linear.app/mcp",
    auth: "bearer",
    agents: ["general", "research"],
    addedBy,
    addedAt: NOW - 60_000,
  });
  const doc: Overrides = {
    org: { mcpServers: { linear: linear("slack:USEED") } },
    channels: { [FIXTURE.channel]: { mcpServers: { linear: linear("slack:USEED") } } },
    users: Object.fromEntries(CALLER_IDS.map((id) => [id, { mcpServers: { linear: linear(id) } }])),
  };
  const backing = new InMemoryOverridesBacking(doc);
  const config = new ConfigStore(join(CONFIG_DIR, "config.yaml"), { backing, initial: structuredClone(doc) }, () => {});
  return new McpService({
    config,
    secrets: new InMemoryMcpSecretStore(),
    key: importCredentialKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    factory: () =>
      new InMemoryMcpClient([{ name: "search_issues", inputSchema: {}, annotations: { readOnlyHint: true } }]),
    publicBaseUrl: "https://switchboard.test",
    env: {},
    fetch: async () => new Response("", { status: 401 }), // auth detection → bearer (item 18)
    now: () => NOW,
    nonce: () => "fixed-nonce-0123456789abcdef",
  });
}

function fakeDeps(s: Stubs): CoreCommandDeps {
  const exec = <T>(what: string, value: T): T => {
    s.executed.push(what);
    return value;
  };
  const admin: ResidentAdminClient = {
    onboard: async (body) => exec(`admin.onboard ${String(body.resource)}`, { status: 202, data: {} }),
    offboard: async (resource, dryRun) =>
      exec(`admin.offboard ${resource} dryRun=${dryRun}`, {
        status: 200,
        data: dryRun
          ? {
              wouldRemove: {
                schedules: 1,
                backupObjects: 2,
                snapshotBackupIds: ["b1", "b2"],
                r2Objects: 3,
                threadBindings: 0,
                container: "running",
              },
            }
          : {
              registryRemoved: true,
              schedulesCancelled: 1,
              containerStopped: true,
              storageCleared: true,
              backupObjectsDeleted: 2,
              r2ObjectsDeleted: 3,
              errors: [],
            },
      }),
    reconfigure: async (body) => exec(`admin.reconfigure ${String(body.resource)}`, { status: 200, data: {} }),
    status: async (resource) =>
      exec(`admin.status ${resource}`, { status: 200, data: { state: "warm", reason: "", inFlight: 0 } }),
    rebuild: async (resource, dryRun) =>
      exec(`admin.rebuild ${resource} dryRun=${dryRun}`, {
        status: dryRun ? 200 : 202,
        data: dryRun
          ? {
              from: { state: "warm" },
              discards: { backupObjects: 0 },
              reprovision: { defaultRef: "master", provisioningTimeoutMs: 600000 },
              keeps: { threadBindings: 0 },
            }
          : { backupObjectsDeleted: 0, reprovision: { defaultRef: "master" } },
      }),
    residents: async () => ({ status: 200, data: RESIDENTS }),
  };
  const operations: Operations = {
    run: async (op, req) =>
      exec(`ops.${op} ${req.repo}${req.ref ? `@${req.ref}` : ""}`, {
        kind: "result",
        ok: true,
        summary: `${op} passed`,
        output: `> ${op}\n\nok`,
      }),
  };
  return {
    help: {
      agents: () => Object.values(AGENTS).map((a) => ({ name: a.name, description: a.description })),
      commands: () => s.commands(),
    },
    config: {
      describeConfig: async (c, u) => s.config.describeConfig(c, u),
      scopes: async (c, u) => s.config.scopes(c, u),
      setChannelOverride: (c, p) => s.config.setChannelOverride(c, p),
      setUserOverride: (u, p) => s.config.setUserOverride(u, p),
      clearChannelOverride: (c) => s.config.clearChannelOverride(c),
      clearUserOverride: (u) => s.config.clearUserOverride(u),
      agentNames: () => Object.keys(AGENTS),
    },
    runs: async () => createRunsService({ registry: s.reg, store: s.store, clock: () => NOW }), // a live run's friction window ends at the pinned clock on every surface
    friction: {
      ledger: async () => new RunStoreFrictionLedger(s.store),
      tracker: s.tracker,
      config: async () => ({ repo: "acme/fixture" }),
      // A read of an input stream, not an executor: not recorded in `executed`.
      readSource: async () =>
        record("cap-1", NOW)
          .events.map((e) => JSON.stringify(e))
          .join("\n"),
    },
    repo: { admin: async () => admin, operations: async () => operations, canUseRepo: async () => true },
    memory: { config: async () => ({ enabled: true }), organization: async () => "acme", store: s.memory },
    mcp: { service: async () => fakeMcpService() },
    schedule: { schedules: SCHEDULES, store: s.schedules, now: () => NOW },
    deploy: {
      run: async (plan: DeployPlan): Promise<DeployRunResult> =>
        exec(`deploy.run ${plan.steps.map((st) => st.name).join(",")}`, {
          kind: "ran",
          ok: true,
          results: plan.steps.map((st) => ({
            name: st.name,
            script: st.script,
            versionId: "v1",
            live: "n/a",
            status: "deployed",
          })),
          notAttempted: [],
        }),
      restart: async (plan: RestartPlan): Promise<RestartRunResult> =>
        exec(`deploy.restart ${plan.target} force=${plan.force}`, {
          kind: "ran",
          ok: true,
          target: plan.target,
          previousStartedAt: "2026-08-30T10:00:00.000Z",
          startedAt: "2026-08-30T10:00:41.000Z",
          waitedMs: 41_000,
        }),
      // Probes of the checkout and the fleet, not executors: not recorded in `executed`.
      checkout: { hasNodeModules: () => true },
      profile: async () => ({ profile: TEST_PROFILE, origin: "profile", path: "deploy/profile.json" }),
      // `deploy init`: every template is the fixture template and every rendered file is already its
      // render (so `--check` passes); a write is the command's effect and is recorded.
      files: {
        read: async (path) => (path.endsWith(TEMPLATE_FILE) ? FIXTURE_TEMPLATE : FIXTURE_RENDERED.get(path)),
        write: async (path) => {
          exec(`deploy.init write ${path}`, undefined);
        },
      },
      // `deploy secrets`: a three-entry manifest whose values are all present; the put is the effect and is recorded.
      secrets: {
        manifest: async () => ({
          secrets: [
            { name: "SLACK_BOT_TOKEN", workers: ["bot"] },
            { name: "MEMORY_TOKEN", workers: ["bot", "resident", "memory"] },
            { name: "SANDBOX_TOKEN", workers: ["bot", "sandbox"] },
          ],
        }),
        present: async (_source, names) => ({ ok: true, present: new Set(names) }),
        put: async (_source, dir, name) => exec(`deploy.secrets put ${name} → ${dir}`, { code: 0, output: "" }),
      },
      // `deploy config`: the push is the effect and is recorded; the fake never reads a source.
      pushConfig: async (o) =>
        exec(`deploy.config push ${o.source} → ${o.key}@${o.stateWorkerUrl}`, {
          ok: true,
          how: `config from ${o.source}`,
          version: 1,
          sha256: "ab".repeat(32),
          bytes: 12,
        }),
      affected: async (opts) => ({
        head: "f".repeat(40),
        workers: [
          {
            name: "memory",
            decision: "deploy",
            base: opts.base ? { kind: "ref", ref: opts.base } : { kind: "live", commit: "a".repeat(40) },
            reasons: ["deploy/cloudflare-memory/worker.ts"],
          },
          { name: "bot", decision: "skip", base: { kind: "live", commit: "a".repeat(40) }, reasons: [] },
          { name: "resident", decision: "skip", base: { kind: "live", commit: "a".repeat(40) }, reasons: [] },
          { name: "sandbox", decision: "skip", base: { kind: "live", commit: "a".repeat(40) }, reasons: [] },
        ],
        selected: ["memory"],
        unclassified: [],
        deployAll: false,
        markdown: "(md)",
      }),
    },
    env: {
      bootstrap: async (opts, log): Promise<BootstrapResult> => {
        log(`plan: ${opts.service}.${opts.env}`);
        return exec(`env.bootstrap ${opts.service}.${opts.env} apply=${opts.apply}`, {
          applied: opts.apply,
          entries: [
            {
              env: opts.env,
              service: opts.service,
              name: "API_URL",
              ref: "op://vault/item/field",
              vault: "vault",
              item: "item",
              field: "field",
            },
          ],
        });
      },
    },
  };
}

/** `extra` registers commands beside the catalogue (the fence's self-test); `yaml` picks the deployment. */
async function fixture(
  extra: (registry: CommandRegistry<CoreCommandDeps>) => void = () => {},
  yaml: "config" | "authz" = "config",
): Promise<Fixture> {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `live-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const live = reg.create("coding · acme/live", {
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:t",
    channelVisibility: "public",
  });
  expect(live.id).toBe(FIXTURE.liveRun);
  reg.publish(live.id, { type: "input", text: `live request ${PLANTED_TEXT}` });
  reg.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ pwd" });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record(FIXTURE.persistedRun, NOW - 1000));
  await store.put(record("fin-2", NOW - 2000));
  const tracker = new InMemoryIssueTracker();
  const { store: config, overridesPath } = freshConfig(yaml);
  const memory = new InMemoryMemoryStore(
    MEMORY_SEED.map((r) => ({ ...r })),
    { now: () => NOW },
  );
  const schedules = new InMemoryScheduleStore();
  await schedules.record({
    schedule: "self-improvement",
    firedAt: NOW - 60_000,
    runId: "run-sched-1",
    outcome: "completed",
    detail: "filed 0 issues",
  });
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {}, logError: () => {} });
  registerCoreCommands(registry);
  extra(registry);
  const executed: string[] = [];
  const raw = bindCommands(
    registry,
    fakeDeps({
      reg,
      store,
      tracker,
      config,
      memory,
      schedules,
      executed,
      commands: () => registry.list() as CommandDef<unknown>[],
    }),
  );
  const recorded: Recorded[] = [];
  return {
    commands: recording(raw, recorded),
    recorded,
    config,
    liveId: live.id,
    liveToken: live.token,
    executed,
    fingerprint: async () =>
      JSON.stringify({
        store: await store.list({ limit: 100 }),
        live: reg.snapshotById(live.id),
        tracker: tracker.calls,
        overrides: existsSync(overridesPath) ? readFileSync(overridesPath, "utf8") : null,
        memory: await Promise.all(MEMORY_SEED.map((r) => memory.list(r.scopeKey, 50))),
        schedules: await schedules.latest(),
        executed,
      }),
  };
}

/** The catalogue under test, enumerated once at collection time. */
const CATALOGUE: CommandDef<unknown>[] = (() => {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  return registry.list() as CommandDef<unknown>[];
})();

const ALL_ACTIONS = [...new Set(CATALOGUE.map((c) => c.action))];

// ---- the surfaces ---------------------------------------------------------------------------------

type Who = "power" | "nobody";

interface Outcome {
  ok: boolean;
  /** The registry code (a grammar surface reports the same `invalid_input` for a malformed tail), the CLI's `usage` (no such command), or a transport code. */
  code?: InvokeErrorCode | "usage" | "not_found" | "method_not_allowed";
  status?: number;
  json?: unknown;
  /** The reply text for chat / plain CLI. */
  text?: string;
  /** Everything the caller could read. */
  wire: string;
}

interface Surface {
  meta: SurfaceMeta;
  /** The caller the adapter must resolve for this identity. */
  caller(who: Who): { kind: Caller["kind"]; id: string };
  run(f: Fixture, cmd: CommandDef<unknown>, named: Named, who: Who): Promise<Outcome>;
}

const meta = (key: SurfaceMeta["key"]): SurfaceMeta => SURFACE_METAS.find((m) => m.key === key)!;

function fakeReqRes(method: string, url: string, body?: string, headers: IncomingHttpHeaders = {}) {
  const req = {
    method,
    url,
    headers: { host: "bot.example.test", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    on: () => {},
    destroy: () => {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body);
    },
  };
  const out: string[] = [];
  let status = 0;
  const res = {
    writeHead: (s: number) => void (status = s),
    end: (c?: string) => {
      if (c) out.push(c);
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    status: () => status,
    text: () => out.join(""),
  };
}

function httpOutcome(status: number, text: string): Outcome {
  const json = text ? JSON.parse(text) : undefined;
  if (status === 200) return { ok: true, status, json, wire: text };
  return {
    ok: false,
    status,
    code: (json as { code: Outcome["code"] }).code,
    text: (json as { error: string }).error,
    wire: text,
  };
}

const httpIdentity = (who: Who) => (who === "power" ? { sub: "power" } : { sub: "", commonName: "svc-none" });
const httpCaller = (who: Who) => ({
  kind: "access" as const,
  id: who === "power" ? "access:power" : "access:svc:svc-none",
});
const httpOptions = (f: Fixture) => ({ grantsFor: (id: string) => f.config.grantsFor(id), devBypassActive: false });
const httpHandler = (f: Fixture) => createCommandHttpHandler(f.commands, httpOptions(f));

const httpGet: Surface = {
  meta: meta("httpGet"),
  caller: httpCaller,
  async run(f, cmd, named, who) {
    const t = fakeReqRes("GET", `${toSurfaceNames(cmd.id).http}?${toKebabQuery(named).toString()}`);
    await httpHandler(f)(t.req, t.res, httpIdentity(who));
    return httpOutcome(t.status(), t.text());
  },
};

const httpPost: Surface = {
  meta: meta("httpPost"),
  caller: httpCaller,
  async run(f, cmd, named, who) {
    const t = fakeReqRes("POST", toSurfaceNames(cmd.id).http, JSON.stringify(named), {
      "content-type": "application/json",
    });
    await httpHandler(f)(t.req, t.res, httpIdentity(who));
    return httpOutcome(t.status(), t.text());
  },
};

const mcp: Surface = {
  meta: meta("mcp"),
  caller: (who) => ({ kind: "mcp", id: `mcp:${who}` }),
  async run(f, cmd, named, who) {
    const res = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: `Bearer ${who}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: toSurfaceNames(cmd.id).mcp, arguments: named },
        }),
      },
      {} as CoreDeps,
      {
        auth: {
          tokens: {
            power: { subject: "power", scopes: ALL_ACTIONS },
            nobody: { subject: "nobody", scopes: ["dispatch"] },
          },
        },
        commands: f.commands,
      },
    );
    return mcpOutcome(res.body);
  },
};

function mcpOutcome(raw: unknown): Outcome {
  const wire = JSON.stringify(raw);
  const body = raw as {
    result?: { content: { text: string }[] };
    error?: { message: string; data?: { code: InvokeErrorCode } };
  };
  if (body.error) return { ok: false, code: body.error.data?.code, text: body.error.message, wire };
  const text = body.result!.content[0].text;
  return { ok: true, json: JSON.parse(text.slice(text.indexOf("\n") + 1)), wire };
}

/** The CLI has ONE real caller (`cli:local`, every grant); `cli:nobody` is a
 *  synthetic no-grants credential driven through this adapter so the
 *  registry's fail-closed path is exercised on this surface too. */
const cliCaller = (who: Who): Caller =>
  who === "power"
    ? CLI_CALLER
    : { kind: "cli", id: "cli:nobody", actor: { kind: "service", id: "cli:nobody", grants: NO_GRANTS } };

const cli: Surface = {
  meta: meta("cli"),
  caller: (who) => ({ kind: "cli", id: cliCaller(who).id }),
  async run(f, cmd, named, who) {
    const parsed = parseCliArgv([...toSurfaceNames(cmd.id).cli, ...toArgv(cmd, named), "--json"], f.commands);
    if (parsed.kind === "usage") return { ok: false, code: "usage", text: parsed.error, wire: parsed.error };
    if (parsed.kind !== "command" && parsed.kind !== "invalid")
      throw new Error(`cli parsed ${parsed.kind} for ${cmd.id}`);
    // Both a grammar rejection and a registry refusal leave through `runCli`'s one stderr shape.
    const out = await runCli(f.commands, parsed, cliCaller(who));
    const wire = out.stdout + out.stderr;
    if (out.exitCode !== 0) {
      const m = /^error \((\w+)\): (.*)$/s.exec(out.stderr);
      return { ok: false, code: m?.[1] as InvokeErrorCode, status: out.exitCode, text: m?.[2], wire };
    }
    return { ok: true, json: JSON.parse(out.stdout), wire };
  },
};

const chat: Surface = {
  meta: meta("chat"),
  caller: (who) => ({ kind: "chat", id: who === "power" ? POWER : NOBODY }),
  async run(f, cmd, named, who) {
    const text = toChatText(toSurfaceNames(cmd.id).cli, toArgv(cmd, named));
    const parsed = parseChatCommand(text, f.commands);
    if (!parsed) throw new Error(`chat did not recognize "${text}"`);
    if (parsed.kind === "reply") return { ok: false, code: parsed.error, text: parsed.text, wire: parsed.text };
    const before = f.recorded.length;
    const res = await invokeChatCommand({
      commands: f.commands,
      parsed,
      msg: { channelId: CHAT_CHANNEL, userId: who === "power" ? POWER : NOBODY, threadKey: `${CHAT_CHANNEL}:t1` },
      config: f.config,
      now: NOW,
    });
    const last = f.recorded[f.recorded.length - 1];
    const code = f.recorded.length > before && !last.result.ok ? last.result.error : undefined;
    return { ok: res.ok, code, text: res.text, wire: res.text };
  },
};

const SURFACES: Surface[] = [httpGet, httpPost, mcp, cli, chat];
expect(SURFACES.map((s) => s.meta.key)).toEqual(SURFACE_METAS.map((m) => m.key));

// ---- the fixed actor set (R13), driven through the surface that carries each id ------------------

/** The Access identity an `access:` role authenticates as: a service token by common_name, else a browser sub. */
function httpIdentityOf(role: AuthzRole): { sub: string; commonName?: string } {
  return role.id.startsWith("access:svc:")
    ? { sub: "", commonName: role.id.slice("access:svc:".length) }
    : { sub: role.id.slice("access:".length) };
}

/** Drive `cmd` with `named` as `role` on the surface its id is carried by. */
async function runAsRole(f: Fixture, cmd: CommandDef<unknown>, named: Named, role: AuthzRole): Promise<Outcome> {
  const input = forCaller(named, role.id);
  switch (carriedBy(role.id)) {
    case "chat": {
      const text = toChatText(toSurfaceNames(cmd.id).cli, toArgv(cmd, input));
      const parsed = parseChatCommand(text, f.commands);
      if (!parsed) throw new Error(`chat did not recognize "${text}"`);
      if (parsed.kind === "reply") return { ok: false, code: parsed.error, text: parsed.text, wire: parsed.text };
      const res = await invokeChatCommand({
        commands: f.commands,
        parsed,
        msg: { channelId: CHAT_CHANNEL, userId: role.id, threadKey: `${CHAT_CHANNEL}:t1` },
        config: f.config,
        now: NOW,
      });
      return { ok: res.ok, code: res.error, text: res.text, wire: res.text };
    }
    case "access": {
      const t =
        cmd.effect === "write"
          ? fakeReqRes("POST", toSurfaceNames(cmd.id).http, JSON.stringify(input), {
              "content-type": "application/json",
            })
          : fakeReqRes("GET", `${toSurfaceNames(cmd.id).http}?${toKebabQuery(input).toString()}`);
      await httpHandler(f)(t.req, t.res, httpIdentityOf(role));
      return httpOutcome(t.status(), t.text());
    }
    case "mcp": {
      const res = await handleMcpRequest(
        {
          method: "POST",
          headers: { authorization: `Bearer ${role.id.slice("mcp:".length)}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: toSurfaceNames(cmd.id).mcp, arguments: input },
          }),
        },
        {} as CoreDeps,
        { auth: { tokens: AUTHZ_INGRESS_TOKENS }, commands: f.commands, grantsFor: (id) => f.config.grantsFor(id) },
      );
      return mcpOutcome(res.body);
    }
    case "cli": {
      const parsed = parseCliArgv([...toSurfaceNames(cmd.id).cli, ...toArgv(cmd, input), "--json"], f.commands);
      if (parsed.kind !== "command" && parsed.kind !== "invalid")
        throw new Error(`cli parsed ${parsed.kind} for ${cmd.id}`);
      const out = await runCli(f.commands, parsed, CLI_CALLER);
      if (out.exitCode !== 0) {
        const m = /^error \((\w+)\): (.*)$/s.exec(out.stderr);
        return {
          ok: false,
          code: m?.[1] as InvokeErrorCode,
          status: out.exitCode,
          text: m?.[2],
          wire: out.stdout + out.stderr,
        };
      }
      return { ok: true, json: JSON.parse(out.stdout), wire: out.stdout + out.stderr };
    }
  }
}

/** Whether the REGISTRY refused this outcome (the table said no): `unauthorized`
 *  with nothing recorded (an HTTP refusal before the body) or a recorded
 *  `decidedBy: registry`. A handler's own `unauthorized` is not the table's. */
function registryRefused(f: Fixture, out: Outcome): boolean {
  if (out.code !== "unauthorized") return false;
  const last = f.recorded[f.recorded.length - 1];
  return last === undefined || (!last.result.ok && last.result.decidedBy === "registry");
}

function surfacesFor(cmd: CommandDef<unknown>, variant?: Variant): Surface[] {
  return SURFACES.filter((s) => exposedOn(cmd, s.meta, variant));
}

/** Drive a surface with the variant's input spelled for THIS surface's caller. */
function runOn(surface: Surface, f: Fixture, cmd: CommandDef<unknown>, named: Named, who: Who): Promise<Outcome> {
  return surface.run(f, cmd, forCaller(named, surface.caller(who).id), who);
}

/** The reference caller: the local CLI's every-grant actor, so the reference JSON is the unrestricted view. */
const powerCaller: Caller = callerWith("cli", "cli:reference", "all");

/** `invoke` with the by-name input split by the definition, as this caller. */
async function reference(f: Fixture, cmd: CommandDef<unknown>, named: Named, caller: Caller): Promise<InvokeResult> {
  const input = namedToInput(cmd, forCaller(named, caller.id), "camel");
  if ("error" in input) throw new Error(input.error);
  return f.commands.invoke(cmd.id, input, caller);
}

/** The last recorded invoke: the Caller the adapter resolved and the parsed `{ args, options }` the registry saw. */
function lastInvoke(f: Fixture, cmd: CommandDef<unknown>): { caller: Caller; parsed: unknown } {
  const last = f.recorded[f.recorded.length - 1];
  expect(last?.id, `${cmd.id}: the adapter invoked`).toBe(cmd.id);
  const parsed = parseInput(cmd, last.input);
  expect(parsed.ok, `${cmd.id}: recorded input parses`).toBe(true);
  return { caller: last.caller, parsed: parsed.ok ? { args: parsed.args, options: parsed.options } : undefined };
}

/** Chat renders in a proportional font (Slack): a run of two or more spaces
 *  between words is a padded column that will collapse into ragged whitespace
 *  (`help` 2026-08-30, `<group> help` and `runs list` 2026-09-04). Leading
 *  indentation is allowed; interior padding is not. */
function assertChatShape(text: string, label: string): void {
  const padded = text.split("\n").filter((line) => /\S {2,}\S/.test(line));
  expect(
    padded,
    `${label}: chat text pads columns (collapses in a proportional font) — give the command a chat shape: ${JSON.stringify(padded[0])}`,
  ).toEqual([]);
}

function assertNoSecrets(wire: string, f: Fixture, label: string): void {
  for (const fragment of [...SECRET_FRAGMENTS, f.liveToken])
    expect(wire, `${label}: leaks ${fragment}`).not.toContain(fragment);
}

/** Every string in `value` that carries stored free text is wrapped as untrusted. */
function assertUntrusted(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.includes(PLANTED_TEXT)) {
      expect(value.startsWith(UNTRUSTED_PREAMBLE), `${label}: free text unwrapped`).toBe(true);
      expect(value).toContain(UNTRUSTED_OPEN);
      expect(value.trimEnd().endsWith(UNTRUSTED_CLOSE)).toBe(true);
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => assertUntrusted(v, `${label}[${i}]`));
  else if (typeof value === "object" && value !== null)
    for (const [k, v] of Object.entries(value)) assertUntrusted(v, `${label}.${k}`);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The field a parse error must name — in the error itself, not the usage line
 *  a grammar refusal appends (that names every option) — as a WHOLE token in
 *  one of its surface spellings: `camelCase`, `--kebab-case`, `<name>`, or
 *  `name:`. Word-bounded, so a short name (`id`) inside another word
 *  (`invalid`, `provided`) does not count. */
function namesField(message: string, field: string): boolean {
  const error = message.split("\nusage:")[0];
  const spellings = [field, cliFlag(field)].map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\w-])(?:${spellings})(?![\\w-])`).test(error);
}

// ---- 7. the regression fences -------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

describe("command conformance — catalogue fences", () => {
  it("the suite tests the catalogue the bot and the CLI bind (buildCoreCommands ≡ registerCoreCommands)", async () => {
    const f = await fixture();
    const real = buildCoreCommands(freshConfig().store, new InMemoryRunStore(), {
      registry: new RunRegistry(),
      env: { MEMORY_TOKEN: PLANTED_ENV_SECRET },
      dataDir: CONFIG_DIR,
      warn: () => {},
      frictionLedger: new RunStoreFrictionLedger(new InMemoryRunStore()),
      tracker: new InMemoryIssueTracker(),
      audit: () => {},
    });
    expect(
      real
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(
      f.commands
        .list()
        .map((c) => c.id)
        .sort(),
    );
    expect(CATALOGUE.length).toBeGreaterThan(0);
  });

  it("catalogue snapshot: id, arguments, options (names + kinds + enum values), surfaces, action, policy target, effect — update deliberately", () => {
    expect(catalogueSnapshot(CATALOGUE)).toMatchSnapshot();
  });

  it("features/command-registry.md `## Catalogue` table lists exactly the registered commands", () => {
    const md = readFileSync(join(here, "..", "..", "features", "command-registry.md"), "utf8");
    expect(parseCatalogueTable(md)).toEqual(CATALOGUE.map((c) => c.id).sort());
  });

  it("every command has a sample for every field and a happy path that succeeds against the generic fixture (or a COMMAND_FIXTURES entry)", async () => {
    expect(await conformanceFailures(fixture)).toEqual([]);
  });

  it("every COMMAND_FIXTURES entry names a registered command (no stale escape hatches)", () => {
    const ids = new Set(CATALOGUE.map((c) => c.id));
    for (const id of Object.keys(COMMAND_FIXTURES))
      expect(ids.has(id), `COMMAND_FIXTURES["${id}"] names no registered command`).toBe(true);
  });

  it("authorization: every command's action has a policy row on the resource it authorizes (features/authorization.md item 4)", () => {
    expect(policyGaps(CATALOGUE)).toEqual([]);
  });

  it("authorization: a command whose action has no policy row fails loudly, by name", () => {
    const define = commandDefiner<CoreCommandDeps>();
    const orphan = define({
      id: "demo.norow",
      action: "demo:read",
      effect: "read",
      describe: "no row names demo:read",
      handler: async () => ({}),
    });
    const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
    registerCoreCommands(registry);
    registry.register(orphan);
    expect(policyGaps(registry.list() as CommandDef<unknown>[])).toEqual([
      expect.stringMatching(/^demo\.norow: no policy row for demo:read on command/),
    ]);
    // …and the registry refuses it for everyone, the local CLI included: no row → deny (R7).
    expect(authorize(CLI_CALLER.actor, orphan.action, { type: "command", id: orphan.id })).toEqual({
      allow: false,
      reason: "no-rule",
    });
  });

  it("authorization: the fixed actor set resolves through the real adapters to the actors the matrix decides for (grants from config, never from the adapter)", async () => {
    const f = await fixture(() => {}, "authz");
    for (const role of AUTHZ_ROLES) {
      const expected = roleActor(role);
      const resolved = (() => {
        switch (carriedBy(role.id)) {
          case "chat":
            return resolveChatActor(
              { userId: role.id, channelId: CHAT_CHANNEL, threadKey: `${CHAT_CHANNEL}:t1` },
              (id) => f.config.grantsFor(id),
            );
          case "access":
            return callerFor(httpIdentityOf(role), httpOptions(f)).actor;
          case "mcp":
            return toCaller(AUTHZ_INGRESS_TOKENS[role.id.slice("mcp:".length)]!, {
              auth: { tokens: AUTHZ_INGRESS_TOKENS },
              grantsFor: (id) => f.config.grantsFor(id),
            }).actor;
          case "cli":
            return CLI_CALLER.actor;
        }
      })();
      expect({ kind: resolved.kind, id: resolved.id, grants: resolved.grants }, role.column).toEqual({
        kind: expected.kind,
        id: expected.id,
        grants: expected.grants,
      });
    }
  });

  it("the fence is live: a command with an unfakeable dependency or an unsampleable field is listed by name", async () => {
    const define = commandDefiner<CoreCommandDeps>();
    // Real actions, so the real rows admit the power caller and the fence measures the FIXTURE, not the table.
    const needsDeps = define({
      id: "demo.needs",
      action: "runs:read",
      effect: "read",
      describe: "needs a dependency the fixture lacks",
      handler: async () => {
        throw new CommandError("unavailable", "demo store not configured");
      },
    });
    const unsampleable = define({
      id: "demo.strict",
      args: [{ name: "ticket", schema: z.string().regex(/^ZZ-\d{9}$/), describe: "ticket" }],
      action: "runs:read",
      effect: "read",
      describe: "an argument no generic sample satisfies",
      handler: async () => ({}),
    });
    const failures = await conformanceFailures(() =>
      fixture((registry) => {
        registry.register(needsDeps);
        registry.register(unsampleable);
      }),
    );
    expect(failures).toEqual([
      expect.stringMatching(/^demo\.needs: happy path .*unavailable/),
      expect.stringMatching(/^demo\.strict: no sample for ticket/),
    ]);
  });

  it("scripts/command-conformance-matrix.ts prints this suite's matrix: one row per variant the suite runs, one exercised cell per surface it drives, one authorization row per command", () => {
    const script = readFileSync(join(here, "..", "..", "scripts", "command-conformance-matrix.ts"), "utf8");
    expect(script).toContain("buildConformanceMatrix");
    expect(script).toContain("renderConformanceMatrix");
    expect(script).toContain("registerCoreCommands");
    const matrix = buildConformanceMatrix(CATALOGUE);
    let variants = 0;
    let cells = 0;
    for (const cmd of CATALOGUE) {
      const vs = variantsOf(cmd).variants;
      variants += vs.length;
      for (const v of vs) cells += surfacesFor(cmd, v).length;
      expect(
        matrix.commands.find((c) => c.id === cmd.id)?.rows.map((r) => r.variant),
        cmd.id,
      ).toEqual(vs.map((v) => v.name));
    }
    expect(matrix.summary).toEqual({ commands: CATALOGUE.length, surfaces: SURFACES.length, variants, cells });
    expect(matrix.authorization.rows.map((r) => r.id)).toEqual(CATALOGUE.map((c) => c.id).sort());
    const md = renderConformanceMatrix(matrix);
    expect(
      md
        .split("\n")
        .filter(
          (l) =>
            /^\| [^-|]/.test(l) &&
            !l.startsWith("| Variant") &&
            !l.startsWith("| Assertion") &&
            !l.startsWith("| Command"),
        ).length,
    ).toBe(variants + CATALOGUE.length + CROSS_CUTTING_ASSERTIONS.length);
    expect(md).toContain(renderAuthorizationMatrix(matrix.authorization).join("\n"));
  });

  it("one error vocabulary: no matrix row has two exposed cells that disagree — a rejected row names its one code and every exposed cell is ⛔, an accepted row is all ✅", () => {
    const matrix = buildConformanceMatrix(CATALOGUE);
    const rows = matrix.commands.flatMap((c) => c.rows.map((r) => ({ id: c.id, ...r })));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const exposed = Object.values(row.cells).filter((c) => c.kind !== "not-exposed");
      expect(exposed.length, `${row.id} [${row.variant}] runs nowhere`).toBeGreaterThan(0);
      expect(
        new Set(exposed.map((c) => JSON.stringify(c))).size,
        `${row.id} [${row.variant}]: ${JSON.stringify(row.cells)}`,
      ).toBe(1);
      expect(exposed[0].kind === "rejected" ? row.rejection : undefined, `${row.id} [${row.variant}]`).toBe(
        exposed[0].kind === "rejected" ? "invalid_input" : undefined,
      );
    }
    // The rendered rows say the same: every non-"—" cell of a row is the same glyph, and only a rejected row names a code.
    const rendered = renderConformanceMatrix(matrix)
      .split("\n")
      .map((l) => l.split(" | "))
      .filter(
        (cols) => cols.length === SURFACE_METAS.length + 2 && /^\| [^-|]/.test(cols[0]) && cols[0] !== "| Variant",
      );
    expect(rendered.length).toBe(rows.length);
    for (const cols of rendered) {
      const cells = cols
        .slice(2)
        .map((c) => c.replace(/\s*\|$/, ""))
        .filter((c) => c !== "—");
      expect(new Set(cells).size, cols.join(" | ")).toBe(1);
      expect(cols[0].includes("→ `invalid_input`"), cols.join(" | ")).toBe(cells[0] === "⛔");
    }
    expect(renderVariantCell({ variant: "unknown option", rejection: "invalid_input" })).toBe(
      "unknown option → `invalid_input`",
    );
    expect(renderVariantCell({ variant: "required-only" })).toBe("required-only");
  });

  it("toChatText quotes a token exactly as the tokenizer needs: whitespace, empty, an embedded \" or ' — and round-trips QUOTED_SAMPLE", () => {
    for (const t of [
      "plain",
      "",
      "two words",
      'say "hi"',
      "it's",
      `a"b'c`,
      QUOTED_SAMPLE,
      " lead",
      "trail ",
      `"`,
      "'",
    ]) {
      const quoted = quoteChatToken(t);
      expect(tokenize(quoted), JSON.stringify(t)).toEqual({ ok: true, tokens: [t] });
    }
    expect(quoteChatToken("plain")).toBe("plain");
    expect(quoteChatToken("two words")).toBe('"two words"');
    expect(quoteChatToken('say "hi"')).toBe(`'say "hi"'`);
    expect(tokenize(toChatText(["config", "instructions"], ["me", ...QUOTED_SAMPLE.split(" ")]))).toEqual({
      ok: true,
      tokens: ["config", "instructions", "me", ...QUOTED_SAMPLE.split(" ")],
    });
    // The suite exercises this on every command with a free-text field.
    expect(
      CATALOGUE.some((cmd) => variantsOf(cmd).variants.some((v) => v.name.endsWith(" with embedded quotes"))),
    ).toBe(true);
  });
});

/** One line per command the generic fixture cannot drive to success: a field
 *  with no acceptable sample, or a required-only invocation that does not
 *  come back `ok`. Each command gets a fresh fixture (a write must not taint
 *  the next command's run). */
async function conformanceFailures(build: () => Promise<Fixture>): Promise<string[]> {
  const failures: string[] = [];
  const cmds = (await build()).commands.list();
  for (const cmd of cmds) {
    const f = await build();
    const { variants, missingSamples } = variantsOf(cmd);
    if (missingSamples.length > 0) {
      failures.push(
        `${cmd.id}: no sample for ${missingSamples.join(", ")} — add a hint in FIELD_HINTS or a COMMAND_FIXTURES entry`,
      );
      continue;
    }
    const happy = variants.find((v) => v.name === "required-only")!;
    const res = await reference(f, cmd, happy.named, powerCaller);
    if (!res.ok)
      failures.push(
        `${cmd.id}: happy path ${JSON.stringify(happy.named)} failed: ${res.error} — ${res.message}; add a COMMAND_FIXTURES entry (hints/baseline) or fake its dependency in fakeDeps`,
      );
  }
  return failures;
}

// ---- 1–6. every command × every variant × every surface --------------------------------------------------

describe.each(CATALOGUE.map((cmd) => ({ id: cmd.id, cmd })))("command conformance — $id", ({ cmd }) => {
  const variants = variantsOf(cmd).variants;

  it("names derive mechanically: tools/list carries group_verb with the exact jsonSchemaFor; /api/<id>, argv words, and chat form all resolve to this command", async () => {
    const f = await fixture();
    const names = toSurfaceNames(cmd.id);
    expect(names).toEqual({
      http: `/api/${cmd.id}`,
      mcp: cmd.id.replace(".", "_"),
      cli: cmd.id.split("."),
      chat: cmd.id.replace(".", " "),
    });
    const list = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer power" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      },
      {} as CoreDeps,
      { auth: { tokens: { power: { subject: "power", scopes: ALL_ACTIONS } } }, commands: f.commands },
    );
    const tools = (list.body as { result: { tools: { name: string; inputSchema: unknown }[] } }).result.tools;
    const tool = tools.find((t) => t.name === names.mcp);
    if (cmd.surfaces?.mcp === false) expect(tool).toBeUndefined();
    else expect(tool?.inputSchema).toEqual(jsonSchemaFor(cmd));
    if (cmd.surfaces?.cli !== false)
      expect(parseCliArgv([...names.cli, "--help"], f.commands)).toEqual({ kind: "command-help", id: cmd.id });
    else expect(parseCliArgv([...names.cli, "--help"], f.commands).kind).toBe("usage");
    const chatParsed = parseChatCommand(`${names.chat} --help`, f.commands);
    if (cmd.surfaces?.chat !== false) expect(chatParsed?.kind).toBe("reply");
    else expect(chatParsed).toBeNull();
    const t = fakeReqRes(
      cmd.effect === "write" ? "POST" : "GET",
      names.http,
      cmd.effect === "write" ? "{}" : undefined,
      { "content-type": "application/json" },
    );
    await httpHandler(f)(t.req, t.res, { sub: "power" });
    if (cmd.surfaces?.http !== false) expect(t.status(), t.text()).not.toBe(404);
    else expect(t.status(), `${cmd.id}: opted out of http yet served`).toBe(404);
  });

  it("MCP inputSchema lists exactly the arguments and options, required = the non-optional ones, additionalProperties false; enum values and defaults survive", () => {
    const fields = fieldsOf(cmd);
    const schema = jsonSchemaFor(cmd) as {
      properties: Record<string, { enum?: unknown[]; default?: unknown; anyOf?: { enum?: unknown[] }[] }>;
      required?: string[];
      additionalProperties: boolean;
    };
    expect(schemaPropertyNames(cmd)).toEqual(fields.map((f) => f.name).sort());
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(
      fields
        .filter((f) => f.required)
        .map((f) => f.name)
        .sort(),
    );
    for (const f of fields) {
      const declaredEnum = (() => {
        const def = (
          f.schema as unknown as {
            _zod: { def: { type: string; innerType?: z.ZodType; entries?: Record<string, unknown> } };
          }
        )._zod.def;
        const inner =
          def.type === "optional" || def.type === "default"
            ? (def.innerType as unknown as { _zod: { def: { type: string; entries?: Record<string, unknown> } } })._zod
                .def
            : def;
        return inner.type === "enum" && inner.entries ? Object.values(inner.entries) : undefined;
      })();
      if (declaredEnum)
        expect(
          schema.properties[f.name].enum ?? schema.properties[f.name].anyOf?.flatMap((a) => a.enum ?? []),
          `${cmd.id}.${f.name} enum`,
        ).toEqual(declaredEnum);
      const def = (f.schema as unknown as { _zod: { def: { type: string; defaultValue?: unknown } } })._zod.def;
      if (def.type === "default")
        expect(schema.properties[f.name].default, `${cmd.id}.${f.name} default`).toEqual(def.defaultValue);
    }
  });

  it("help (CLI --help and chat --help) names every argument and every option flag", async () => {
    const f = await fixture();
    const fields = fieldsOf(cmd);
    const check = (text: string, where: string) => {
      for (const a of fields.filter((x) => x.kind === "arg"))
        expect(text, `${where} names <${a.name}>`).toContain(`<${a.name}>`);
      for (const flag of expectedFlags(cmd)) expect(text, `${where} names ${flag}`).toContain(flag);
      expect(text).toContain(cmd.describe);
    };
    if (cmd.surfaces?.cli !== false)
      check((await runCli(f.commands, { kind: "command-help", id: cmd.id }, CLI_CALLER)).stdout, "cli --help");
    if (cmd.surfaces?.chat !== false) {
      const parsed = parseChatCommand(`${toSurfaceNames(cmd.id).chat} --help`, f.commands);
      expect(parsed?.kind).toBe("reply");
      check(parsed?.kind === "reply" ? parsed.text : "", "chat --help");
      assertChatShape(parsed?.kind === "reply" ? parsed.text : "", "chat --help");
    }
  });

  it("every accepted variant binds to the same parsed { args, options } and yields the identical invoke JSON on every exposed surface (chat: renderText of it), modulo the caller's own id; the Caller is the adapter's; no token, no secret; free text wrapped", async () => {
    for (const variant of variants.filter((v) => v.expect.ok)) {
      const label = `${cmd.id} [${variant.name}]`;
      // Reads share one fixture and must leave it untouched; each write gets its own.
      const shared = cmd.effect === "read" ? await fixture() : undefined;
      const fresh = async () => shared ?? (await fixture());
      const before = shared ? await shared.fingerprint() : undefined;
      let firstParsed: unknown;
      let firstJson: unknown;
      for (const surface of surfacesFor(cmd, variant)) {
        const where = `${label} via ${surface.meta.column}`;
        const f = await fresh();
        f.recorded.length = 0;
        const out = await runOn(surface, f, cmd, variant.named, "power");
        expect(out.ok, `${where}: ${out.wire}`).toBe(true);
        const { caller, parsed } = lastInvoke(f, cmd);
        expect({ kind: caller.kind, id: caller.id }, `${where}: the Caller the registry saw`).toEqual(
          surface.caller("power"),
        );
        if (surface === chat) expect(caller.origin?.channelId, `${where}: chat origin`).toBe(CHAT_CHANNEL);
        // The reference: a direct `invoke` as the very caller the adapter resolved, on an equivalent fixture.
        const refFixture = await fresh();
        const ref = await reference(refFixture, cmd, variant.named, caller);
        expect(ref.ok, `${where}: reference invoke ${JSON.stringify(ref)}`).toBe(true);
        if (!ref.ok) continue;
        expect(parsed, `${where}: parsed input`).toEqual(lastInvoke(refFixture, cmd).parsed);
        const normalizedParsed = withCallerToken(parsed, caller.id);
        firstParsed ??= normalizedParsed;
        expect(normalizedParsed, `${where}: parsed input differs from the first surface's`).toEqual(firstParsed);
        if (surface.meta.machine) {
          expect(out.json, `${where}: invoke JSON`).toEqual(ref.value);
          assertUntrusted(out.json, where);
          const normalized = withCallerToken(out.json, caller.id);
          firstJson ??= normalized;
          expect(
            normalized,
            `${where}: invoke JSON differs from the first machine surface's (beyond the caller's own id)`,
          ).toEqual(firstJson);
        } else {
          expect(out.text, `${where}: chat reply`).toBe(renderText(cmd, ref.value, { now: NOW, surface: "chat" }));
          assertChatShape(out.text ?? "", `${where}: chat reply`);
        }
        assertNoSecrets(out.wire, f, where);
      }
      if (shared && before !== undefined)
        expect(await shared.fingerprint(), `${label}: a read command mutated the fixture`).toBe(before);
    }
  });

  it("every rejected variant (type mismatch per field, unknown option, missing argument) is refused on every surface with the ONE expected code — identical across surfaces — naming the field, never echoing the value", async () => {
    for (const variant of variants.filter((v) => !v.expect.ok)) {
      if (variant.expect.ok) continue;
      const { field } = variant.expect;
      const codes = new Map<string, string | undefined>();
      for (const surface of surfacesFor(cmd, variant)) {
        const f = await fixture();
        const out = await runOn(surface, f, cmd, variant.named, "power");
        const where = `${cmd.id} [${variant.name}] via ${surface.meta.column}`;
        expect(out.ok, `${where}: accepted ${out.wire}`).toBe(false);
        // One error vocabulary: a grammar surface that refuses before invoke reports the registry's own code for that fault.
        expect(out.code, `${where}: ${out.wire}`).toBe(expectedRejection(variant));
        codes.set(surface.meta.column, out.code);
        if (surface.meta.key === "cli") expect(out.status, `${where}: exit code`).toBe(2);
        expect(namesField(out.text ?? "", field), `${where}: "${out.text}" does not name ${field}`).toBe(true);
        if (variant.planted !== undefined)
          expect(out.wire, `${where}: echoes the submitted value`).not.toContain(
            typeof variant.planted === "string" ? variant.planted : JSON.stringify(variant.planted),
          );
        assertNoSecrets(out.wire, f, where);
        // Nothing ran: the fixture is untouched by a refused call.
        expect(f.recorded.filter((r) => r.result.ok)).toEqual([]);
        expect(f.executed, `${where}: an executor ran`).toEqual([]);
      }
      // The cells of this row agree: one code, whichever surface spelled the fault.
      expect(
        new Set(codes.values()).size,
        `${cmd.id} [${variant.name}]: codes differ across surfaces ${JSON.stringify([...codes])}`,
      ).toBe(1);
    }
  });

  it("auth: a credential without the grant is refused BEFORE parse on every machine surface (a malformed input still gets unauthorized, not invalid_input); chat admission is the table's decision for the message's actor; writes are POST-only", async () => {
    const happy = variants.find((v) => v.name === "required-only")!;
    const malformed: Named = { ...happy.named, [UNKNOWN_OPTION]: "x" };
    for (const surface of surfacesFor(cmd).filter((s) => s.meta.machine)) {
      const f = await fixture();
      // The CLI's grammar runs before invoke (its one real caller holds every grant), so it gets the well-formed input.
      const out = await runOn(surface, f, cmd, surface === cli ? happy.named : malformed, "nobody");
      expect(out.ok, `${cmd.id} via ${surface.meta.column}: nobody was admitted`).toBe(false);
      expect(out.code, `${cmd.id} via ${surface.meta.column}: ${out.wire}`).toBe("unauthorized");
      if (surface === httpGet || surface === httpPost) expect(out.status).toBe(403);
      expect(f.recorded.filter((r) => r.result.ok)).toEqual([]);
      expect(f.executed).toEqual([]);
      assertNoSecrets(out.wire, f, `${cmd.id} via ${surface.meta.column} (refused)`);
    }
    if (cmd.surfaces?.chat !== false) {
      const f = await fixture();
      // What the table says for the actor the chat adapter resolves for NOBODY (the plain Slack user's baseline grants).
      const msg = { userId: NOBODY, channelId: CHAT_CHANNEL, threadKey: `${CHAT_CHANNEL}:t1` };
      const nobody: Caller = {
        kind: "chat",
        id: NOBODY,
        actor: resolveChatActor(msg, (id) => f.config.grantsFor(id)),
        origin: msg,
      };
      const input = namedToInput(cmd, forCaller(happy.named, NOBODY), "camel");
      if ("error" in input) throw new Error(input.error);
      const admitted = authorize(nobody.actor, cmd.action, resourceOf(cmd, input, nobody)).allow;
      const out = await runOn(chat, f, cmd, happy.named, "nobody");
      expect(out.ok, `${cmd.id} (${cmd.action}): nobody admitted=${admitted}, got ${out.wire}`).toBe(admitted);
      if (!admitted) {
        expect(out.code).toBe("unauthorized");
        expect(out.text).toMatch(/^🚫 `.+` is restricted\. Ask /);
        expect(f.executed).toEqual([]);
      }
    }
    // A credential holding no grant at all is refused whatever the surface (fail-closed, R7) — driven as a CLI
    // caller, the one surface every command is exposed on.
    const bare = await reference(await fixture(), cmd, happy.named, {
      kind: "cli",
      id: "cli:nothing",
      actor: { kind: "service", id: "cli:nothing", grants: NO_GRANTS },
    });
    expect(bare).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    if (cmd.surfaces?.http !== false) {
      const f = await fixture();
      const t = fakeReqRes(
        "GET",
        `${toSurfaceNames(cmd.id).http}?${toKebabQuery(forCaller(happy.named, "access:power")).toString()}`,
      );
      await httpHandler(f)(t.req, t.res, { sub: "power" });
      if (cmd.effect === "write") expect(t.status(), `${cmd.id}: write over GET`).toBe(405);
      else expect(t.status(), `${cmd.id}: read over GET`).toBe(200);
      if (cmd.effect === "write") {
        expect(f.recorded).toEqual([]);
        expect(f.executed).toEqual([]);
      }
    }
  });

  it("authorization (R13): for every actor of the fixed set, the surface that carries it admits or refuses exactly as `authorize` over the policy table says; a refusal is `unauthorized` before parse with nothing executed", async () => {
    const happy = variants.find((v) => v.name === "required-only")!;
    const row = buildAuthorizationMatrix([cmd]).rows[0]!;
    for (const role of AUTHZ_ROLES.filter((r) => CommandRegistry.exposedTo(cmd, carriedBy(r.id)))) {
      const admitted = admits(cmd, role);
      expect(row.cells[role.id], `${cmd.id} × ${role.column}: matrix cell`).toBe(admitted);
      const f = await fixture(() => {}, "authz");
      const out = await runAsRole(f, cmd, happy.named, role);
      const where = `${cmd.id} (${cmd.action} on ${row.resource}) × ${role.column}`;
      if (admitted) {
        expect(registryRefused(f, out), `${where}: the table admits, the surface refused: ${out.wire}`).toBe(false);
      } else {
        expect(registryRefused(f, out), `${where}: the table refuses, the surface admitted: ${out.wire}`).toBe(true);
        if (carriedBy(role.id) === "access") expect(out.status, where).toBe(403);
        if (carriedBy(role.id) === "chat") expect(out.text, where).toMatch(/^🚫 `.+` is restricted\. Ask /);
        expect(
          f.recorded.filter((r) => r.result.ok),
          where,
        ).toEqual([]);
        expect(f.executed, where).toEqual([]);
        assertNoSecrets(out.wire, f, where);
      }
    }
  });
});
