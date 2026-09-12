// The conformance suite's world, shared. `src/core/commandConformance.test.ts`
// (docs/reference/specs/command-registry.md item 25) drives every command × variant ×
// surface against ONE generic in-memory fixture — `fixture()` here: a
// `RunRegistry` with a live run, an `InMemoryRunStore` with two persisted runs,
// a `ConfigStore` with a power user and a nobody, and `fakeDeps`, a recording
// stub for every executing dependency the catalogue declares — through the
// REAL adapters (`httpGet`/`httpPost`/`mcp`/`cli`/`chat` below). A suite that
// needs the same world under different assumptions imports it from here rather
// than rebuilding it: one place builds the world, every suite reads it, and a
// new deps slice in `CoreCommandDeps` is a compile error on `fakeDeps` for all
// of them at once.
//
// Nothing real runs: every executing dependency records into `executed` and
// answers a plausible shape. Each test file disarms `node:child_process` and
// `fetch` for itself (`vi.mock` is hoisted per file), so a command that reached
// a real runner fails there, not here. No production code imports this module
// (src/core/testing/ is excluded from the build).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapResult } from "../../agentEnv/bootstrap.js";
import { AGENTS } from "../../agents/registry.js";
import { CLI_CALLER, parseCliArgv, runCli } from "../../cli.js";
import { ConfigStore } from "../../config.js";
import { createCommandHttpHandler } from "../../channels/commandHttp.js";
import { handleMcpRequest } from "../../channels/mcp.js";
import { NO_GRANTS, type Grants } from "../authz/types.js";
import { ALL_GRANTS } from "../authz/grants.js";
import { callerWith } from "./callers.js";
import type { DeployPlan } from "../../deploy/plan.js";
import type { RestartPlan } from "../../deploy/restart.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES } from "../../deploy/testing/profile.js";
import type { ImageCopy } from "../../deploy/images.js";
import {
  PROJECT_FACTS_FILE,
  renderSiteConfig,
  renderWorkerConfigs,
  TEMPLATE_FILE,
} from "../../deploy/wranglerTemplate.js";
import type { DeployRunResult, RestartRunResult } from "../../deploy/run.js";
import type { PlannedFile } from "../../setup/plan.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { InMemoryIssueTracker } from "../../execution/githubIssues.js";
import { createDeliveryService, InMemoryDeliverySource, type PullRequestFacts } from "../delivery.js";
import { invokeChatCommand, parseChatCommand } from "../commandChat.js";
import { ReviewAbridger } from "../reviewAbridge.js";
import {
  bindCommands,
  CommandRegistry,
  parseInput,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_PREAMBLE,
  type Caller,
  type CommandDef,
  type CommandInput,
  type CommandInvoker,
  type InvokeErrorCode,
  type InvokeResult,
} from "../commandRegistry.js";
import { cliFlag, mcpToolName, namedToInput, toSurfaceNames } from "../commandSurface.js";
import { coreCommandGroups, registerCoreCommands, type CoreCommandDeps } from "../commands/all.js";
import type { CoreDeps } from "../dispatcher.js";
import { ALL_CAPABILITIES, type Capabilities } from "../capabilities.js";
import { RunStoreFrictionLedger } from "../frictionLedger.js";
import { InMemoryMemoryStore } from "../memory/stores.js";
import type { MemoryRecord } from "../memory/types.js";
import type { Operations } from "../operations.js";
import type { ResidentAdminClient } from "../residentAdmin.js";
import type { RunEvent } from "../runEvents.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunRecord } from "../runRecord.js";
import { RunRegistry } from "../runRegistry.js";
import { InMemoryRunStore } from "../runStore.js";
import { createRunsService } from "../runsService.js";
import { SCHEDULES } from "../schedules.js";
import { InMemoryScheduleStore } from "../scheduleStore.js";
import {
  importCredentialKey,
  InMemoryMcpClient,
  InMemoryMcpSecretStore,
  McpService,
  type McpServerEntry,
} from "../../mcp/index.js";
import { InMemoryOverridesBacking, type Overrides } from "../../config.js";
import {
  AUTHZ_GRANTS,
  AUTHZ_INGRESS_TOKENS,
  AUTHZ_ROLES,
  carriedBy,
  exposedOn,
  FIXTURE,
  forCaller,
  SURFACE_METAS,
  toArgv,
  toChatText,
  toKebabQuery,
  type AuthzRole,
  type Named,
  type SurfaceMeta,
  type Variant,
} from "./commandConformance.js";
import { expect } from "vitest";
import { secretsFrom } from "../../secrets.js";
export const NOW = 1_700_000_000_000;

/** `deploy init`'s world: one template for every Worker dir and the site's, the project facts the site
 *  renders from (a made-up project), and each rendered file already equal to its render. */
export const FIXTURE_TEMPLATE = '{ "name": "{{script}}", "account_id": "{{account}}" }\n';
export const FIXTURE_FACTS = JSON.stringify({
  name: "switchboard",
  docs: "https://docs.example.test",
  images: TEST_PUBLISHED_IMAGES.names,
});
export const FIXTURE_RENDERED: ReadonlyMap<string, string> = (() => {
  const r = renderWorkerConfigs(TEST_PROFILE, () => FIXTURE_TEMPLATE, TEST_PUBLISHED_IMAGES);
  if (!r.ok) throw new Error(r.problems.join("; "));
  const site = renderSiteConfig(TEST_PROFILE, FIXTURE_FACTS, () => FIXTURE_TEMPLATE);
  if (!site.ok) throw new Error(site.problems.join("; "));
  return new Map([...r.files.map((f): [string, string] => [f.path, f.text]), [site.path, site.text]]);
})();
/** Stored free text: must leave a machine surface wrapped as untrusted, or not at all. */
export const PLANTED_TEXT = "PLANTED-FREE-TEXT-5b7e";
/** A secret that lives in the process (env) — must never reach any output. */
export const PLANTED_ENV_SECRET = "PLANTED-ENV-SECRET-2d9a";
/** Every substring no output may ever contain. Filled per fixture with the live run's token. */
export const SECRET_FRAGMENTS = ["tok-", PLANTED_ENV_SECRET, "9f3c1e", "4242424242"];

export const POWER = "slack:UPOWER";
export const NOBODY = "slack:UNOBODY";
/** The channel a chat caller speaks from (its `origin`) — deliberately not the fixture's `--channel`. */
export const CHAT_CHANNEL = "slack:CX";

/** `contract render`'s plan: one unit naming one spec row. */
export const CONTRACT_PLAN = [
  "# Fixture plan",
  "",
  "## Implementation Units",
  "",
  "### U16. The child contract",
  "",
  "- **Goal**: A coding child never starts from a free-text task alone.",
  "- **Files**: `src/core/ship/contract.ts`; `docs/reference/specs/agent-ship.md` item 4.",
  "- **Approach**: build the object, render it under fixed headings.",
  "- **Test scenarios**: a contract renders under the fixed headings.",
  "",
].join("\n");
/** The spec that plan names, with the item and one row naming it. */
export const CONTRACT_SPEC = [
  "# Agent: ship",
  "",
  "## Behavior",
  "",
  "4. **Round 0 = the PR gate end to end.** The coding child implements, pushes, and submits.",
  "",
  "## Validation criteria",
  "",
  "| Criterion | Proof |",
  "|---|---|",
  "| Round 0 opens the PR (item 4) | `[unit]` `src/core/dispatcher.test.ts::agent:ship (pipeline)::LGTM round 1…` |",
  "",
].join("\n");
export const CONTRACT_RULES = "# Agents\n\nRun only what the Commands table names.";

/** `setup init`'s `.env.example` stand-in: the lines the installer fills, as the real file spells them. */
export const SETUP_ENV_TEMPLATE = [
  "SLACK_BOT_TOKEN=xoxb-...",
  "SLACK_APP_TOKEN=xapp-...",
  "ANTHROPIC_API_KEY=sk-ant-...",
  "OPENAI_API_KEY=sk-...",
  "# GITHUB_APP_ID=123456",
  "# GITHUB_APP_INSTALLATION_ID=12345678",
  '# GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----"',
  "",
].join("\n");
/** `setup init`'s `config.example.yaml` stand-in: both example providers and the three default models. */
export const SETUP_CONFIG_TEMPLATE = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
  openai:
    type: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/general-model
    review: anthropic/general-model
execution:
  type: local
`;

export const BASE_YAML = `
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

/** The generic fixture's deployment: one Slack admin and the HTTP power caller, both granted everything (`adminsHint`, folded by caller id in the
 *  cross-surface comparison, names Slack admins only, so the hint reads the same on every surface); the plain Slack user is granted
 *  `config:write`, so the channel-scoped `config.*` happy inputs are admitted for them by the handler exactly as the table admits them. */
export const CONFIG_YAML = `${BASE_YAML}grants:
  "${POWER}":
    actions: all
    channels: all
    repos: all
  "access:power":
    actions: all
    channels: all
    repos: all
  "${NOBODY}":
    actions: [config:write]
`;

/** The authorization matrix's deployment: `AUTHZ_GRANTS`, spelled as config.yaml (a JSON flow mapping is YAML). */
export const AUTHZ_YAML = `${BASE_YAML}grants: ${JSON.stringify(AUTHZ_GRANTS)}
`;

export const CONFIG_DIR = (() => {
  const dir = mkdtempSync(join(tmpdir(), "swb-conformance-"));
  writeFileSync(join(dir, "config.yaml"), CONFIG_YAML);
  writeFileSync(join(dir, "authz.yaml"), AUTHZ_YAML);
  return dir;
})();
export let configN = 0;
/** A fresh config store per fixture: overrides are on-disk state a write changes.
ss *  The store knows the catalogue's groups (the browser-session reads), as the bot's does at startup. */
export function freshConfig(yaml: "config" | "authz" = "config"): { store: ConfigStore; overridesPath: string } {
  const overridesPath = join(CONFIG_DIR, `overrides-${++configN}.json`);
  return {
    store: new ConfigStore(join(CONFIG_DIR, `${yaml}.yaml`), overridesPath, { commandGroups: coreCommandGroups() }),
    overridesPath,
  };
}

// ---- the generic fixture ----------------------------------------------------------------------------

/** Every caller id the suite drives a command as — each gets its own memory scope. */
export const CALLER_IDS = [
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

export const RESIDENTS = {
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

export function record(id: string, finishedAt: number): RunRecord {
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
    userId: "slack:UALICE",
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

/** The head `REVIEW_HEAD` at `REVIEW_BASE` on `FIXTURE.repo`: what the seeded
 *  review's `run_meta` and git artifact name, and what the fixture's GitHub
 *  double answers a compare for. */
export const REVIEW_HEAD = "e".repeat(40);
export const REVIEW_BASE = "main";
export const REVIEW_DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";

/** A finished PR review that recorded its git reading diff — `review abridge`'s
 *  one happy input (a coding run has no such artifact and is refused by name). */
export function reviewRecord(id: string, finishedAt: number): RunRecord {
  const events: RunEvent[] = [
    { type: "input", text: `agent:review https://github.com/${FIXTURE.repo}/pull/42 ${PLANTED_TEXT}`, seq: 1 },
    { type: "run_meta", agent: "review", repo: FIXTURE.repo, ref: "patch-1", pr: 42, headSha: REVIEW_HEAD, seq: 2 },
    {
      type: "review_artifact",
      artifact: "reading_diff",
      poweredBy: "git",
      baseRef: REVIEW_BASE,
      diff: REVIEW_DIFF,
      truncated: false,
      seq: 3,
    },
    { type: "answer", text: `LGTM: looks correct ${PLANTED_TEXT}`, seq: 4 },
  ];
  return {
    ...record(id, finishedAt),
    label: `review · ${FIXTURE.repo} PR 42`,
    agent: "review",
    repo: FIXTURE.repo,
    eventCount: events.length,
    storedEventCount: events.length,
    events,
    diagnosis: analyzeRunFriction(events),
  };
}

/** The fixture's abridger: the REAL `ReviewAbridger` over the fixture store,
 *  GitHub's compare answered by the in-memory double and meat by a
 *  deterministic fake (a marker summary; nothing spawned), the pinned clock —
 *  so every surface's `review abridge` answers byte-identically. */
export function fakeAbridger(store: InMemoryRunStore): ReviewAbridger {
  const github = new InMemoryGithubApi({
    [FIXTURE.repo]: { compares: { [`${REVIEW_BASE}...${REVIEW_HEAD}`]: REVIEW_DIFF } },
  });
  return new ReviewAbridger({
    store,
    github: () => github,
    meat: async (run) => ({
      ok: true,
      result: {
        diff: `abridged ${run.diff.length}`,
        summary: `one line ${PLANTED_TEXT}`,
        inputTokens: 9,
        outputTokens: 3,
      },
    }),
    defaultModel: () => "claude-opus-5",
    timeoutMs: () => 240_000,
    clock: () => NOW,
    warn: () => {},
  });
}

export function memoryRecord(scopeKey: string): MemoryRecord {
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
export const MEMORY_SEED = [
  ...CALLER_IDS.map((id) => `user:${id}`),
  "org:acme",
  `repo:${FIXTURE.repo}`,
  `channel:${CHAT_CHANNEL}`,
].map(memoryRecord);

export interface Recorded {
  id: string;
  input: CommandInput;
  caller: Caller;
  result: InvokeResult;
}

export interface Fixture {
  /** The bound catalogue every adapter is handed — records each `invoke`. */
  commands: CommandInvoker;
  recorded: Recorded[];
  config: ConfigStore;
  /** What is on in this world (src/core/capabilities.ts) — everything, unless the suite says otherwise. */
  capabilities: Capabilities;
  liveId: string;
  liveToken: string;
  /** Every call a stubbed executor received (resident admin writes, ops, deploys, bootstraps). */
  executed: string[];
  /** Everything a read command could change, as one string. */
  fingerprint(): Promise<string>;
}

export function recording(inner: CommandInvoker, recorded: Recorded[]): CommandInvoker {
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

export interface Stubs {
  reg: RunRegistry;
  store: InMemoryRunStore;
  abridger: ReviewAbridger;
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
/** The MCP service over a THROWAWAY config store per call: the seeded
 *  `linear` server (auth none) exists in the org tier, the fixture channel, and
 *  every caller's own tier — so each surface's caller finds "its" server under
 *  the default `me` scope and the outputs fold by caller id like memory's —
 *  and a write (`mcp add`) lands in a document nobody else reads, so `add`
 *  never conflicts with itself across surfaces and `remove` leaves the seed
 *  for the next one. In-memory client (no network); fixed nonce + clock so
 *  `connect`/`add` answer identically everywhere. */
export function fakeMcpService(): McpService {
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
  const config = new ConfigStore(join(CONFIG_DIR, "config.yaml"), { backing, initial: structuredClone(doc) });
  return new McpService({
    config,
    secrets: new InMemoryMcpSecretStore(),
    key: importCredentialKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    factory: () =>
      new InMemoryMcpClient([{ name: "search_issues", inputSchema: {}, annotations: { readOnlyHint: true } }]),
    publicBaseUrl: "https://switchboard.test",
    bearers: secretsFrom({}),
    fetch: async () => new Response("", { status: 401 }), // auth detection → bearer (item 18)
    now: () => NOW,
    nonce: () => "fixed-nonce-0123456789abcdef",
  });
}

export function fakeDeps(s: Stubs): CoreCommandDeps {
  // `deploy images` copied the sandbox image into this fixture's registry (the listing then shows it).
  let imagesCopied = false;
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
  const runs = async () => createRunsService({ registry: s.reg, store: s.store, clock: () => NOW });
  // `delivery report`: one merged pull request of the fixture repo, reviewed
  // twice by a bot the fixture names, merged in the week of the pinned clock —
  // read from memory, never from GitHub (`fetch` is disarmed here).
  const merged = new Date(NOW).toISOString();
  const delivery = createDeliveryService(
    {
      repos: [FIXTURE.repo],
      reviewers: ["acme-review[bot]"],
      agentLogins: [],
      agentCoauthors: [],
      snapshot: { everyMinutes: 60 },
    },
    new InMemoryDeliverySource({
      [FIXTURE.repo]: [
        {
          number: 42,
          title: "fix the build",
          author: "acme-coding[bot]",
          createdAt: new Date(NOW - 3_600_000).toISOString(),
          mergedAt: merged,
          firstHeadSha: "0123456789abcdef0123456789abcdef01234567",
          ci: [
            {
              headSha: "0123456789abcdef0123456789abcdef01234567",
              trigger: "pull_request",
              conclusion: "success",
              attempt: 1,
              createdAt: new Date(NOW - 3_500_000).toISOString(),
            },
          ],
          reviews: [
            {
              author: "acme-review[bot]",
              state: "commented",
              submittedAt: new Date(NOW - 2_400_000).toISOString(),
              body: "Changes requested: one thing.\n- [minor] F1 src/x.ts — a nit worth fixing",
            },
            {
              author: "acme-review[bot]",
              state: "commented",
              submittedAt: new Date(NOW - 600_000).toISOString(),
              body: "LGTM: fixed.",
            },
          ],
          pushes: [
            { actor: "acme-coding[bot]", at: new Date(NOW - 1_200_000).toISOString(), kind: "force", coauthors: [] },
          ],
          issue: { number: 7, title: "the build is broken", createdAt: new Date(NOW - 7_200_000).toISOString() },
        } satisfies PullRequestFacts,
      ],
    }),
    { now: () => new Date(NOW) },
  );
  return {
    delivery: { service: async () => delivery },
    help: {
      agents: () => Object.values(AGENTS).map((a) => ({ name: a.name, description: a.description })),
      commands: () => s.commands(),
    },
    status: {
      snapshot: () => ({
        version: "0.0.0-test",
        commit: "0123456789abcdef0123456789abcdef01234567",
        builtAt: "2026-01-01T00:00:00.000Z",
        startedAt: NOW,
        inFlight: 1,
        draining: false,
      }),
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
    runs, // a live run's friction window ends at the pinned clock on every surface
    review: { abridger: async () => s.abridger, runs },
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
      // Probes of the host and the fleet, not executors: not recorded in `executed`.
      host: { root: { mode: "checkout", path: "/work/switchboard" }, hasNodeModules: () => true },
      profile: async () => ({ profile: TEST_PROFILE, origin: "profile", path: "deploy/profile.json" }),
      // `deploy init`: every template is the fixture template and every rendered file is already its
      // render (so `--check` passes); a write is the command's effect and is recorded.
      files: {
        read: async (path) =>
          path.endsWith(TEMPLATE_FILE)
            ? FIXTURE_TEMPLATE
            : path === PROJECT_FACTS_FILE
              ? FIXTURE_FACTS
              : FIXTURE_RENDERED.get(path),
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
      // `deploy images`: the account registry already holds the bot's and the resident's images at the
      // fixture version and not the sandbox's, so under a `registry` profile one copy would be the effect
      // and is recorded; the fixture's profile builds its images, so the command answers with nothing to
      // copy and reads nothing. The credential is here; a read of the registry is a probe, not an executor.
      images: {
        registry: async () => ({
          value: [
            { name: "switchboard", tags: [TEST_PUBLISHED_IMAGES.version, "latest"] },
            { name: "switchboard-resident", tags: [TEST_PUBLISHED_IMAGES.version] },
            { name: "switchboard-sandbox", tags: [TEST_PUBLISHED_IMAGES.version] },
          ].filter((r) => r.name !== "switchboard-sandbox" || imagesCopied),
        }),
        credential: async () => ({ ok: true }),
        copy: async (copy: ImageCopy) => {
          imagesCopied = true;
          return exec(`deploy.images copy ${copy.source} → ${copy.target}`, {
            ok: true,
            report: { digest: `sha256:${"0".repeat(64)}`, blobs: 1, uploaded: 1, bytes: 1 },
          });
        },
      },
      cliVersion: () => TEST_PUBLISHED_IMAGES.version,
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
    // `setup init`: the templates are small stand-ins for the checked-in examples (the real ones are
    // the planner's own tests' fixture); nothing exists yet, the working directory is a checkout, a
    // private-key file has content, there is no terminal, and a write is the effect and is recorded.
    setup: {
      templates: async () => ({
        env: SETUP_ENV_TEMPLATE,
        config: SETUP_CONFIG_TEMPLATE,
        profile: '{ "configSource": "config/config.yaml" }\n',
      }),
      exists: async () => false,
      write: async (file: PlannedFile) => {
        exec(`setup.init write ${file.path} mode=${file.mode.toString(8)}`, undefined);
      },
      readFile: async () => "-----BEGIN RSA PRIVATE KEY-----\nFIXTURE\n-----END RSA PRIVATE KEY-----\n",
      inCheckout: () => true,
      root: () => undefined,
      image: () => "ghcr.io/example/switchboard",
      package: () => undefined,
      env: {},
    },
    // `contract render`: reads, not executors (not recorded in `executed`) — the one-unit plan for
    // whatever plan path a variant spells, the spec it names, AGENTS.md as the rules file.
    contract: {
      readFile: async (path) => {
        if (path.endsWith("AGENTS.md")) return CONTRACT_RULES;
        if (path.endsWith("CLAUDE.md")) return undefined;
        if (path.includes(join("docs", "reference", "specs")))
          return path.endsWith("agent-ship.md") ? CONTRACT_SPEC : undefined;
        return CONTRACT_PLAN;
      },
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

/** `extra` registers commands beside the catalogue (the fence's self-test); `yaml` picks the deployment;
 *  `capabilities` is what is on in this world — the all-on value unless a suite injects another. */
export async function fixture(
  extra: (registry: CommandRegistry<CoreCommandDeps>) => void = () => {},
  yaml: "config" | "authz" = "config",
  capabilities: Capabilities = ALL_CAPABILITIES,
): Promise<Fixture> {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `live-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const live = reg.create("coding · acme/live", {
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:t",
    channelVisibility: "public",
  });
  expect(live.id).toBe(FIXTURE.liveRun);
  reg.publish(live.id, { type: "input", text: `live request ${PLANTED_TEXT}` });
  reg.publish(live.id, { type: "tool_call", tool: "bash", summary: "$ pwd" });
  const store = new InMemoryRunStore({ now: () => NOW });
  await store.put(record(FIXTURE.persistedRun, NOW - 1000));
  await store.put(record("fin-2", NOW - 2000));
  await store.put(reviewRecord(FIXTURE.reviewRun, NOW - 3000));
  const abridger = fakeAbridger(store);
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
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {}, logError: () => {}, capabilities });
  registerCoreCommands(registry);
  extra(registry);
  const executed: string[] = [];
  const raw = bindCommands(
    registry,
    fakeDeps({
      reg,
      store,
      abridger,
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
    capabilities,
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
export const CATALOGUE: CommandDef<unknown>[] = (() => {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  return registry.list() as CommandDef<unknown>[];
})();

/** What the MCP `nobody` bearer's actor holds: dispatch and nothing else. */
export const DISPATCH_ONLY: Grants = { actions: new Set(["dispatch"]), channels: new Set(), repos: new Set() };

// ---- the surfaces ---------------------------------------------------------------------------------

export type Who = "power" | "nobody";

export interface Outcome {
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

export interface Surface {
  meta: SurfaceMeta;
  /** The caller the adapter must resolve for this identity. */
  caller(who: Who): { kind: Caller["kind"]; id: string };
  run(f: Fixture, cmd: CommandDef<unknown>, named: Named, who: Who): Promise<Outcome>;
}

export const meta = (key: SurfaceMeta["key"]): SurfaceMeta => SURFACE_METAS.find((m) => m.key === key)!;

export function fakeReqRes(method: string, url: string, body?: string, headers: IncomingHttpHeaders = {}) {
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

export function httpOutcome(status: number, text: string): Outcome {
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

export const httpIdentity = (who: Who) => (who === "power" ? { sub: "power" } : { sub: "", commonName: "svc-none" });
export const httpCaller = (who: Who) => ({
  kind: "access" as const,
  id: who === "power" ? "access:power" : "access:svc:svc-none",
});
export const httpOptions = (f: Fixture) => ({
  grantsFor: (id: string) => f.config.grantsFor(id),
  devBypassActive: false,
});
export const httpHandler = (f: Fixture) => createCommandHttpHandler(f.commands, httpOptions(f));

export const httpGet: Surface = {
  meta: meta("httpGet"),
  caller: httpCaller,
  async run(f, cmd, named, who) {
    const t = fakeReqRes("GET", `${toSurfaceNames(cmd.id).http}?${toKebabQuery(named).toString()}`);
    await httpHandler(f)(t.req, t.res, httpIdentity(who));
    return httpOutcome(t.status(), t.text());
  },
};

export const httpPost: Surface = {
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

export const mcp: Surface = {
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
            power: { subject: "power" },
            nobody: { subject: "nobody" },
          },
        },
        commands: f.commands,
        grantsFor: (id) => (id === "mcp:power" ? ALL_GRANTS : DISPATCH_ONLY),
      },
    );
    return mcpOutcome(res.body);
  },
};

export function mcpOutcome(raw: unknown): Outcome {
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
export const cliCaller = (who: Who): Caller =>
  who === "power"
    ? CLI_CALLER
    : { kind: "cli", id: "cli:nobody", actor: { kind: "service", id: "cli:nobody", grants: NO_GRANTS } };

export const cli: Surface = {
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

export const chat: Surface = {
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

export const SURFACES: Surface[] = [httpGet, httpPost, mcp, cli, chat];
expect(SURFACES.map((s) => s.meta.key)).toEqual(SURFACE_METAS.map((m) => m.key));

// ---- the fixed actor set, driven through the surface that carries each id ------------------

/** The Access identity an `access:` role authenticates as: a service token by common_name, else a browser sub. */
export function httpIdentityOf(role: AuthzRole): { sub: string; commonName?: string } {
  return role.id.startsWith("access:svc:")
    ? { sub: "", commonName: role.id.slice("access:svc:".length) }
    : { sub: role.id.slice("access:".length) };
}

/** Drive `cmd` with `named` as `role` on the surface its id is carried by. */
export async function runAsRole(f: Fixture, cmd: CommandDef<unknown>, named: Named, role: AuthzRole): Promise<Outcome> {
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
export function registryRefused(f: Fixture, out: Outcome): boolean {
  if (out.code !== "unauthorized") return false;
  const last = f.recorded[f.recorded.length - 1];
  return last === undefined || (!last.result.ok && last.result.decidedBy === "registry");
}

export function surfacesFor(cmd: CommandDef<unknown>, variant?: Variant): Surface[] {
  return SURFACES.filter((s) => exposedOn(cmd, s.meta, variant));
}

/** Drive a surface with the variant's input spelled for THIS surface's caller. */
export function runOn(
  surface: Surface,
  f: Fixture,
  cmd: CommandDef<unknown>,
  named: Named,
  who: Who,
): Promise<Outcome> {
  return surface.run(f, cmd, forCaller(named, surface.caller(who).id), who);
}

/** The reference caller: the local CLI's every-grant actor, so the reference JSON is the unrestricted view. */
export const powerCaller: Caller = callerWith("cli", "cli:reference", "all");

/** `invoke` with the by-name input split by the definition, as this caller. */
export async function reference(
  f: Fixture,
  cmd: CommandDef<unknown>,
  named: Named,
  caller: Caller,
): Promise<InvokeResult> {
  const input = namedToInput(cmd, forCaller(named, caller.id), "camel");
  if ("error" in input) throw new Error(input.error);
  return f.commands.invoke(cmd.id, input, caller);
}

/** The last recorded invoke: the Caller the adapter resolved and the parsed `{ args, options }` the registry saw. */
export function lastInvoke(f: Fixture, cmd: CommandDef<unknown>): { caller: Caller; parsed: unknown } {
  const last = f.recorded[f.recorded.length - 1];
  expect(last?.id, `${cmd.id}: the adapter invoked`).toBe(cmd.id);
  const parsed = parseInput(cmd, last.input);
  expect(parsed.ok, `${cmd.id}: recorded input parses`).toBe(true);
  return { caller: last.caller, parsed: parsed.ok ? { args: parsed.args, options: parsed.options } : undefined };
}

/** Chat renders in a proportional font (Slack): a run of two or more spaces
 *  between words is a padded column that will collapse into ragged whitespace
 *  (seen live for `help`, then `<group> help` and `runs list`). Leading
 *  indentation is allowed; interior padding is not. */
export function assertChatShape(text: string, label: string): void {
  const padded = text.split("\n").filter((line) => /\S {2,}\S/.test(line));
  expect(
    padded,
    `${label}: chat text pads columns (collapses in a proportional font) — give the command a chat shape: ${JSON.stringify(padded[0])}`,
  ).toEqual([]);
}

export function assertNoSecrets(wire: string, f: Fixture, label: string): void {
  for (const fragment of [...SECRET_FRAGMENTS, f.liveToken])
    expect(wire, `${label}: leaks ${fragment}`).not.toContain(fragment);
}

/** Every string in `value` that carries stored free text is wrapped as untrusted. */
export function assertUntrusted(value: unknown, label: string): void {
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

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The field a parse error must name — in the error itself, not the usage line
 *  a grammar refusal appends (that names every option) — as a WHOLE token in
 *  one of its surface spellings: `camelCase`, `--kebab-case`, `<name>`, or
 *  `name:`. Word-bounded, so a short name (`id`) inside another word
 *  (`invalid`, `provided`) does not count. */
export function namesField(message: string, field: string): boolean {
  const error = message.split("\nusage:")[0];
  const spellings = [field, cliFlag(field)].map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\w-])(?:${spellings})(?![\\w-])`).test(error);
}

// ---- existence, per adapter ----------------------------------------------------------------------

export type AdapterKind = "http" | "mcp" | "cli" | "chat";
export const ADAPTER_KINDS: readonly AdapterKind[] = ["http", "mcp", "cli", "chat"];

/** The `Caller["kind"]` each adapter resolves — what `CommandRegistry.exposedTo` is asked with. */
export const ADAPTER_CALLER_KIND: Readonly<Record<AdapterKind, Caller["kind"]>> = {
  http: "access",
  mcp: "mcp",
  cli: "cli",
  chat: "chat",
};

/** The tool names `tools/list` answers the power bearer with (the built-in `dispatch` included). */
export async function mcpToolNames(f: Fixture): Promise<string[]> {
  const res = await handleMcpRequest(
    {
      method: "POST",
      headers: { authorization: "Bearer power" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
    {} as CoreDeps,
    { auth: { tokens: { power: { subject: "power" } } }, commands: f.commands, grantsFor: () => ALL_GRANTS },
  );
  return (res.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

/**
 * Whether each adapter admits that `cmd` EXISTS for the power caller — the
 * question a hidden command must answer "no" to on every surface
 * (docs/reference/specs/capabilities.md item 3): HTTP answers `/api/<id>` with anything but
 * 404 (a write gets an empty body, so a refusal of the input still counts as
 * present), `tools/list` names the tool, the CLI grammar knows the words, chat
 * recognises the form. Opted-out surfaces answer "no" too — presence is what the
 * adapter shows, not what the definition declares.
 */
export async function presenceOf(f: Fixture, cmd: CommandDef<unknown>): Promise<Record<AdapterKind, boolean>> {
  const names = toSurfaceNames(cmd.id);
  const t = fakeReqRes(cmd.effect === "write" ? "POST" : "GET", names.http, cmd.effect === "write" ? "{}" : undefined, {
    "content-type": "application/json",
  });
  await httpHandler(f)(t.req, t.res, { sub: "power" });
  return {
    http: t.status() !== 404,
    mcp: (await mcpToolNames(f)).includes(mcpToolName(cmd.id)),
    cli: parseCliArgv([...names.cli, "--help"], f.commands).kind === "command-help",
    chat: parseChatCommand(`${names.chat} --help`, f.commands)?.kind === "reply",
  };
}
