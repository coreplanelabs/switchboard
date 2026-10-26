import { authorize } from "../core/authz/authorize.js";
import { nullChannelIO } from "../core/nullChannelIo.js";
import { createSpanLog } from "../core/trace/spanLog.js";
import { startRequestRoot } from "../core/requestTrace.js";
import { handleAdminTraceLog, TRACE_LOG_PATH } from "./adminTraceLog.js";
import { Secret } from "../secrets.js";
import { NO_GRANTS } from "../core/authz/types.js";
import type { OrganizationOwnerFailure } from "../core/organization/ownerFailure.js";
import { runAgentSmoke, type SmokeScenario } from "../deploy/agentSmoke.js";
import { handleModelProxyRequest, ANTHROPIC_MESSAGES_PATH } from "./modelProxy.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { createOrganizationNativeSources } from "./organizationNativeSources.js";
import { buildDashboardVerifier, tokenVerifier } from "./dashboardAuth.js";
import { contextAccessForMessage } from "../core/dispatch/contextAccess.js";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { buildCoreCommands } from "../core/commandCatalogue.js";
import { secretsFrom } from "../secrets.js";
// Feature: docs/reference/specs/browser-home.md — production composition preserves original execution owners.
import { DatabaseSync } from "node:sqlite";
import { SqliteOrganizationStore } from "../core/organization/sqlite.js";
import type { DirectorySqlStorage } from "../core/identity/sqlite.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIngressRequest } from "./http.js";
import { InMemoryPersonalTokenStore, digestBearer } from "../mcp/personalTokens.js";
import type { Provider, CompletionRequest } from "../core/provider.js";
import * as executorFactory from "../execution/factory.js";
import { TEST_GITHUB_CREDENTIALS } from "../execution/testing/githubCredentials.js";
import { operatorSettingsEvidence } from "../core/testing/operatorSettings.js";
import { OPERATOR_READ_TOOLS } from "../core/dispatch/operator.js";
import { ThreadAdmission } from "../core/threadAdmission.js";
import { InMemoryGithubApi } from "../execution/githubApi.js";
import { createOriginalUnitRecipient } from "./originalUnitRecipient.js";
import { createHomeRepositories } from "./homeRepositories.js";
import { createMainTaskStarter } from "../core/coordinator/mainStart.js";
import { createHomeService } from "../core/home/service.js";
import { createHomeConditionReader } from "../core/home/conditions.js";
import { resolveWorkViewScope, withWorkViewScope } from "./workViewScope.js";
import { InMemoryPrivateWorkerLog, privateWorkerThreadKey } from "../core/privateWorkerLog.js";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { GitBindings } from "../core/modelProxy/gitBindings.js";
import { HarnessRegistry } from "../core/harness/pi/relay.js";
import { OpenCodeHarness } from "../core/harness/opencode/harness.js";
import { PiHarness } from "../core/harness/pi/piHarness.js";
import { FakeHarnessContainer } from "../core/harness/testing/fakeContainer.js";
import { scriptPiFromProvider } from "../core/harness/pi/testing/providerPi.js";
import { createLedgerWriteThrough } from "../core/runLedger/writeThrough.js";
import { createMcpApprovalView } from "./mcpApprovalView.js";
import { createMcpHandler, handleMcpRequest, type McpOptions } from "./mcp.js";
import { ConfigStore, operatorModeOf } from "../config.js";
import { NullMcpToolSource } from "../mcp/source.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { ThreadsElsewhere } from "../core/runLedger/threadsElsewhere.js";
import type { Grants } from "../core/authz/types.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import { unitProgressBasis } from "../core/coordinator/unitProgress.js";
import { contextCapsuleOf } from "../core/dispatch/unitContext.js";
import { createHomeViewHandler } from "./homeView.js";
import { DAY_MS } from "../core/budgets.js";
import { nativeMediaDigest } from "../core/nativeMedia.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { InMemoryConfirmationStore } from "../core/confirmations.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import { seedCoordinatorInstance, seedCoordinatorUnit } from "../core/testing/coordinatorInstance.js";
import { readableRuns } from "./liveView/viewer.js";
import { matchesPredicate } from "../core/authz/predicate.js";
import { dispatch, dispatchClick, type CoreDeps } from "../core/dispatcher.js";
import { withOriginalOrganizationDispatch } from "../core/dispatch/privateDestination.js";
import { withChatActor } from "../core/authz/actor.js";
import { NullMemoryStore } from "../core/memory/stores.js";
import { NO_FLEET } from "../core/residentFleet.js";
import { InMemoryOrganizationStore } from "../core/organization/memory.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { NullLedgerWriteThrough } from "../core/runLedger/writeThrough.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { NullRunHistoryWriter, createRunHistoryWriter } from "../core/runHistoryWriter.js";
import { createRunsService } from "../core/runsService.js";
import type { RunRecord } from "../core/runRecord.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { HomeSession } from "./homeSeed.js";
import type { HomeRuntimeContext } from "./homeRuntime.js";
import { createOrganizationAuthentication } from "./organizationAuthentication.js";
import { classifyError } from "../core/trace/classify.js";
import { createBrowserHomeInstallation, type BrowserHomeInstallationOptions } from "./browserHomeInstallation.js";
// The SDK's legacy latest-version export differs from its modern form handler.
const FORM_PROTOCOL_VERSION = ["2026", "07", "28"].join("-");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const identity = { issuer: "https://access.fixture.test", tenant: null, subject: "alice" };
const thread = "web:alice:unit";
const instance: CoordinatorInstance = {
  id: "fixture",
  kind: "ship",
  userId: "access:alice",
  channelId: "web:alice",
  threadKey: thread,
  repo: "sample/api",
  branch: "codex/original",
  createdAt: 1000,
};
const unit: CoordinatorUnit = {
  instanceId: "fixture",
  unit: "original",
  slug: "original",
  title: "Original unit",
  branch: "codex/original",
  dependsOn: [],
  rounds: [],
  threadKey: thread,
  idle: {
    why: "human_gated",
    at: 1000,
    renewalsLeft: 1,
    wakes: 0,
    spendUsd: null,
    humanGate: {
      assignedTo: "access:alice",
      pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
      round: 1,
      verdict: "approve",
      findings: [],
      askedAt: 1000,
    },
  },
};
async function fixture(
  linkedSlack = false,
  privateSlack = false,
  provider?: Provider,
  productionRetention = false,
  metadataRecipient = false,
  personalApproved = false,
  observationBatchSize = 10,
  sqlOrganization = false,
  materializeNativeMedia?: BrowserHomeInstallationOptions["materializeNativeMedia"],
  nativeMcp?: ReturnType<typeof createOrganizationNativeSources>,
  configureCore?: (core: CoreDeps, github: InMemoryGithubApi) => void,
  personByEmail?: (email: string) => Promise<{ id: string; name?: string } | undefined>,
) {
  let now = 1000,
    policy = "config";
  let mergeRead: BrowserHomeInstallationOptions["mergeFacts"] = async () => undefined;
  const targetThread = linkedSlack ? "slack:D1:1" : thread;
  const path = mkdtempSync(join(tmpdir(), "browser-installation-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  writeFileSync(
    join(path, "config.yaml"),
    `organization: fixture\nproviders:\n  anthropic: { type: anthropic, apiKeyEnv: UNSET_FIXTURE_PROVIDER }\ndefaults:\n  agent: general\n  verbosity: debug\n  models: { general: anthropic/general-model, coding: anthropic/coding-model }\ngrants:\n  "access:alice": { actions: all, channels: all, repos: all, organizations: all }\n  "http:bot": { actions: all, channels: all, repos: all, organizations: all }\n  "mcp:bot": { actions: all, channels: all, repos: all, organizations: all }\n  "mcp:personal:alice": { actions: all, channels: all, repos: all, organizations: all }\n  "slack:UALICE": { actions: all, channels: all, repos: all, organizations: all }\nrouting: { operator: off }\nworkspaceDir: ${path}/workspaces\n`,
  );
  const config = new ConfigStore(join(path, "config.yaml"), join(path, "overrides.json"));
  const database = sqlOrganization ? new DatabaseSync(":memory:") : undefined;
  if (database) cleanups.push(() => database.close());
  const storage: DirectorySqlStorage | undefined = database
    ? {
        sql: {
          exec<T>(query: string, ...bindings: unknown[]) {
            const statement = database.prepare(query);
            const values = bindings as (string | number | null)[];
            return (statement.columns().length ? statement.all(...values) : (statement.run(...values), [])) as T[];
          },
        },
        transactionSync: (callback) => {
          database.exec("BEGIN");
          try {
            const value = callback();
            database.exec("COMMIT");
            return value;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      }
    : undefined;
  const store = storage ? new SqliteOrganizationStore(storage, () => now) : new InMemoryOrganizationStore(() => now),
    ledger = new InMemoryRunLedger(() => now);
  const registry = new RunRegistry({ now: () => now });
  const runStore = new InMemoryRunStore({ now: () => now });
  // Production's record and ledger readers share the same immutable archive.
  const fallbackRead = runStore.get.bind(runStore);
  runStore.get = async (id) => (ledger.finished.has(id) ? structuredClone(ledger.finished.get(id)!) : fallbackRead(id));
  const coordinator = new InMemoryCoordinatorInstanceStore(ledger);
  const github = new InMemoryGithubApi({
    "sample/api": { private: false },
    "sample/web": { private: false },
    "sample/private": { private: true },
  });
  const repoChoices = createHomeRepositories({ config, github });
  const confirmations = new InMemoryConfirmationStore({ clock: () => now });
  const personalTokens = new InMemoryPersonalTokenStore();
  await personalTokens.put({
    digest: digestBearer("c".repeat(64)),
    subject: "personal:alice",
    email: "alice@example.test",
    userId: "access:alice",
    createdAt: now,
    ...(personalApproved
      ? {
          approval: {
            version: 1 as const,
            issuer: identity.issuer,
            audience: "access-app",
            organization: "fixture",
            subject: identity.subject,
          },
        }
      : {}),
  });
  const ownerFailures: OrganizationOwnerFailure[] = [];
  const effects: string[] = [];
  const nativeReplies: string[] = [];
  const nativeReplyThreads: string[] = [];
  const tokens = { "native-token": { subject: "bot", channel: "ops", email: "alice@example.test" } };
  const commands = new CommandRegistry<null>({ audit: () => {} });
  commands.register({
    id: "memory.forget",
    action: "memory:read",
    effect: "read",
    describe: "Read-only fixture command",
    handler: async ({ caller }) => {
      effects.push(caller.actor.id);
      return { text: "Read-only command completed." };
    },
    render: (result) => String((result as { text: string }).text),
  });
  const bound = bindCommands(commands, null);
  const runs = createRunsService({ registry, store: runStore, units: coordinator });
  const nudges: { id: string; type: string }[] = [];
  const core: CoreDeps = {
    config,
    capabilities: ALL_CAPABILITIES,
    threadsElsewhere: new ThreadsElsewhere(),
    completions: {
      get: () => {
        if (provider) return provider;
        throw new Error("No model may run for an owned answer or saved command.");
      },
    },
    mcp: new NullMcpToolSource(),
    memory: new NullMemoryStore(),
    residentFleet: NO_FLEET,
    runRegistry: registry,
    runStore,
    runHistoryWriter: new NullRunHistoryWriter(),
    runLedger: new NullLedgerWriteThrough("fixture", runStore),
    commands: bound,
    confirmations,
    coordinatorInstances: coordinator,
    clock: () => now,
    ...(privateSlack
      ? {
          slackContextForRun: () => ({
            originAudience: async () => "dm" as const,
            canReadSource: async () => true,
            readSource: async () => {
              throw new Error("Unexpected raw Slack text read");
            },
            revalidateSource: async () => false,
            verifyDirectOrigin: async () => true,
          }),
        }
      : {}),
    workflow: {
      get: async (id: string) => ({
        sendEvent: async (event: { type: string }) => {
          nudges.push({ id, type: event.type });
        },
      }),
    } as CoreDeps["workflow"],
  };
  const created: string[] = [];
  const privateWorkerLog = new InMemoryPrivateWorkerLog();
  if (provider) {
    const harnesses = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: () => now });
    core.runBearers = bearers;
    core.githubDoor = { baseUrl: "https://git.fixture.test" };
    core.githubBindings = new GitBindings();
    core.harness = {
      harnesses: { pi: new PiHarness(), opencode: new OpenCodeHarness() },
      registry: harnesses,
      harnessUrl: "https://bot.fixture.test",
      loopbackUrl: "http://127.0.0.1:8080",
      containerFor: () => {
        const container = new FakeHarnessContainer();
        scriptPiFromProvider(container, { provider, registry: harnesses, bearers });
        return container;
      },
      pollMs: 1,
      tickMs: 5,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    core.githubApi = github;
    core.runLedger = createLedgerWriteThrough({ ledger, gen: "fixture-main", fallback: runStore, warn: () => {} });
    core.runHistoryWriter = createRunHistoryWriter({ store: runStore, warn: () => {}, sleep: async () => {} });
    core.mainTaskStart = createMainTaskStarter({
      instances: coordinator,
      privateWorkerLog,
      readFile: async () => ({ content: "" }),
      create: async (id) => {
        created.push(id);
        return { kind: "created", id };
      },
      status: async () => ({ kind: "status", status: "running" }),
      repoInfo: async () => ({ defaultBranch: "main" }),
      canUseRepo: (actor, repo) => config.canUseRepo(actor, repo),
      canRunAgent: (actor, name) => config.canRunAgent(actor, name),
      adminsHint: () => "An administrator",
      privateWorkerAvailable: true,
      caps: { maxRounds: 3, maxMinutes: 45 },
      clock: () => now,
    });
  }
  if (nativeMcp) {
    core.runLedger = createLedgerWriteThrough({ ledger, gen: "sso-original", fallback: runStore, warn: () => {} });
    core.runHistoryWriter = createRunHistoryWriter({ store: runStore, warn: () => {}, sleep: async () => {} });
  }
  configureCore?.(core, github);
  const slackIdentity = { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" };
  const mappings = [
    { source: "http" as const, issuer: "installation:fixture:http", tenant: null, organization: "fixture" },
    { source: "mcp" as const, issuer: "installation:fixture:mcp", tenant: null, organization: "fixture" },
    { source: "browser" as const, issuer: identity.issuer, tenant: null, organization: "fixture" },
    { source: "slack" as const, issuer: slackIdentity.issuer, tenant: slackIdentity.tenant, organization: "fixture" },
  ];
  if (nativeMcp) mappings.push({ source: "mcp", issuer: nativeMcp.mcpIssuer, tenant: null, organization: "fixture" });
  if (linkedSlack) {
    const person = await store.directory.createPerson();
    if (person.status !== "created") throw new Error("No fixture person");
    for (const linked of [identity, slackIdentity]) {
      const result = await store.directory.change({
        action: "link",
        identity: linked,
        personId: person.person.id,
        expectedRevision: 0,
        actor: identity,
        proof: { method: "dual-authentication", version: 1 },
      });
      expect(result.status).toBe("changed");
    }
  }
  let installation!: ReturnType<typeof createBrowserHomeInstallation>;
  const nativeCounts = { browser: 0, slack: 0, active: 0, max: 0 };
  let available = true,
    slackAvailable = true,
    writable = true;
  let slackReadHook: (() => void | Promise<void>) | undefined;
  let browserGrants: Grants = ALL_GRANTS;
  let contextReadable = true;
  let currentMcpVerifier = nativeMcp?.currentMcp;
  const authentication = createOrganizationAuthentication({
    organization: "fixture",
    mappings,
    grantsFor: (id) => (id === "access:alice" ? browserGrants : ALL_GRANTS),
    auth: () => ({ tokens }),
    personalTokens,
    personByEmail,
    currentMcp: (...args) =>
      currentMcpVerifier ? currentMcpVerifier(...args) : Promise.resolve({ status: "unavailable" as const }),
    ...(personalApproved ? { personalApproval: { issuer: identity.issuer, audience: "access-app" } } : {}),
    directory: store.directory,
    store,
    ledger,
    currentBrowser: async () => {
      nativeCounts.browser++;
      return available
        ? {
            status: "verified",
            identity,
            actorId: "access:alice",
            kind: "human",
            organizationMember: true,
            privateSource: true,
            epoch: "native-session",
          }
        : { status: "unavailable" };
    },
    currentSlack: async (_identity, _attestation, ref) => {
      nativeCounts.slack++;
      nativeCounts.active++;
      nativeCounts.max = Math.max(nativeCounts.max, nativeCounts.active);
      await Promise.resolve();
      await slackReadHook?.();
      nativeCounts.active--;
      if (!slackAvailable) return { status: "fenced" };
      return available && linkedSlack
        ? {
            status: "verified",
            identity: slackIdentity,
            actorId: "slack:UALICE",
            kind: "human",
            organizationMember: true,
            privateSource: privateSlack,
            ...(privateSlack && ref
              ? {
                  directAudience: {
                    kind: "slack-unshared-im" as const,
                    channelId: ref.channelId,
                    userId: ref.userId,
                    threadKey: ref.threadKey,
                  },
                }
              : {}),
            epoch: "native-slack",
          }
        : { status: "unavailable" };
    },
    questionOwner: (key) => installation.questionOwner(key),
  });
  installation = createBrowserHomeInstallation({
    organizationId: "fixture",
    store,
    ledger,
    authentication,
    core,
    runs,
    coordinator,
    privateWorkerLog,
    commands: bound,
    reportOwnerFailure: (report) => {
      ownerFailures.push(report);
    },
    mappings,
    limits: {
      pendingPerActor: 10,
      pendingPerSource: 20,
      pendingPerOrganization: 30,
      reservedReconciliation: 1,
      contentTtlMs: (productionRetention ? 90 : 1) * DAY_MS,
      receiptTtlMs: (productionRetention ? 365 : 1) * DAY_MS,
    },
    retention: { retentionDays: 30 },
    owner: "fixture-process",
    leaseMs: DAY_MS,
    batchSize: observationBatchSize,
    contentTtlMs: (productionRetention ? 90 : 1) * DAY_MS,
    ...(productionRetention ? { sourceSnapshotTtlMs: 30 * DAY_MS } : {}),
    now: () => now,
    policyEpoch: () => policy,
    launch: (task) => tasks.push(task),
    sourceIo: (request) => ({
      // Native HTTP/MCP rehosting uses the same logical job-thread handle.
      ...(request.envelope.source === "mcp" ? { openThread: nullChannelIO(request.msg.threadKey).openThread } : {}),
      ...(request.msg.directAudience
        ? {
            directAudience: () => request.msg.directAudience,
            verifyDirectAudience: async () => ({ ok: true as const }),
          }
        : {}),
      reply: async (text) => {
        if (request.envelope.source === "browser")
          throw new Error("Browser outputs must use the durable private stream.");
        nativeReplies.push(text);
        nativeReplyThreads.push(request.msg.threadKey);
      },
      history: async () => [{ role: "user", text: "Untrusted raw source history" }],
      status: async () => ({ update() {}, done: async () => {} }),
    }),
    ...(materializeNativeMedia ? { materializeNativeMedia } : {}),
    canReadContext: async (ctx, ref) => {
      if (!contextReadable) return false;
      if (ref.kind === "repository") return repoChoices.authorize(ctx.actor, ref.key);
      const predicate = readableRuns(ctx.actor);
      if (ref.kind === "unit") return (await runs.listUnitRuns(ref.key, predicate)).ok;
      if (ref.kind === "pipeline") return (await runs.listInstanceUnits(ref.key, predicate)).length > 0;
      if (ref.kind === "run") {
        const read = await runs.getRun(ref.key);
        return read.ok && matchesPredicate(predicate, read.value);
      }
      if (ref.kind === "pull-request") {
        const match = /^([^#]+)#([1-9][0-9]*)$/.exec(ref.key);
        return !!match && (await runs.listFindings({ repo: match[1]!, number: Number(match[2]) }, predicate)).ok;
      }
      return false;
    },
    repositories: (ctx) => repoChoices.read(ctx.actor),
    sourceRepository: (ctx, input) => {
      if (ctx.authentication.source !== "browser") return Promise.resolve("sample/api");
      const selected = input.context.filter((ref) => ref.kind === "repository");
      if (new Set(selected.map((ref) => ref.key.toLowerCase())).size > 1) return Promise.resolve(undefined);
      return repoChoices.sourceChoice(ctx.actor, {
        selected: selected[0]?.key,
      });
    },
    ...(metadataRecipient
      ? {
          originalUnitRecipientPhase: (groups, authentication) =>
            createOriginalUnitRecipient({
              organizationId: "fixture",
              ledger,
              store,
              organization: installation.organization,
              coordinator,
              authentication,
              now: () => now,
            }).metadataPhase(groups, authentication),
          originalUnitRecipient: (key: import("../core/coordinator/instanceStore.js").UnitEventKey) =>
            createOriginalUnitRecipient({
              organizationId: "fixture",
              ledger,
              store,
              organization: installation.organization,
              coordinator,
              authentication,
              now: () => now,
            }).read(key),
        }
      : {}),
    canWriteThread: async () => writable,
    provedActorIds: async () => ["access:alice", ...(linkedSlack ? ["slack:UALICE"] : [])],
    mergeLogin: async (id) => (id === "access:alice" ? "alice" : undefined),
    mergeFacts: (...args) => mergeRead!(...args),
  });
  core.revalidateNativeMediaSource = installation.revalidateNativeMediaSource;
  core.guardOrganizationConfirmation = (row, chooser, purpose) =>
    installation.guardOrganizationConfirmation(row, chooser, purpose);
  const tasks: (() => Promise<void>)[] = [];
  const resolved = await authentication.resolveBrowser(identity, {
    channelId: "web:alice",
    userId: "access:alice",
    threadKey: "web:alice:organization",
    text: "",
  });
  if (resolved.status !== "resolved") throw new Error("No fixture source proof");
  const context: HomeRuntimeContext = { actor: resolved.actor, authentication: resolved.authentication };
  async function request(method: string, url: string, input?: unknown, viewer: HomeRuntimeContext = context) {
    const req = Readable.from(input === undefined ? [] : [JSON.stringify(input)]) as IncomingMessage;
    Object.assign(req, {
      method,
      url,
      headers: { host: "fixture.test", origin: "http://fixture.test", "content-type": "application/json" },
    });
    let status = 0,
      text = "";
    const res = {
      writeHead(value: number) {
        status = value;
      },
      end(value?: string) {
        text = value ?? "";
      },
      setHeader() {},
    } as unknown as ServerResponse;
    expect(installation.handler(req, res, viewer)).toBe(true);
    for (let i = 0; i < 100 && !text; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    if (!text) throw new Error("No handler response");
    return {
      status,
      body: JSON.parse(text) as HomeSession & {
        status: string;
        duplicate?: boolean;
        receipt: { id: string; ownerRunId: string; effectKey: string };
      },
    };
  }
  async function execute() {
    for (let i = 0; i < 100 && !tasks.length; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const task = tasks.shift();
    if (!task) throw new Error("No original owner task");
    await task();
    await core.runHistoryWriter.settled();
  }
  async function seedQuestion(recordFacts: Partial<RunRecord> = {}) {
    seedCoordinatorInstance(
      coordinator,
      linkedSlack ? { ...instance, userId: "slack:UALICE", channelId: "slack:D1", threadKey: targetThread } : instance,
    );
    seedCoordinatorUnit(
      coordinator,
      linkedSlack
        ? {
            ...unit,
            threadKey: targetThread,
            idle: { ...unit.idle!, humanGate: { ...unit.idle!.humanGate!, assignedTo: "slack:UALICE" } },
          }
        : unit,
    );
    const record: RunRecord = {
      id: "original-child",
      channelId: linkedSlack ? "slack:D1" : "web:alice",
      channelVisibility: "dm",
      userId: linkedSlack ? "slack:UALICE" : "access:alice",
      threadKey: targetThread,
      parentInstanceId: "fixture",
      idempotencyKey: "fixture:original-child",
      agent: "coding",
      startedAt: 1000,
      finishedAt: 1000,
      status: "completed",
      eventCount: 1,
      storedEventCount: 1,
      truncated: false,
      diagnosis: analyzeRunFriction([]),
      events: [{ type: "input", text: "Original task", messageId: "original", seq: 1 }],
      ...recordFacts,
    };
    expect((await runStore.put(record)).stored).toBe(true);
  }
  cleanups.push(() => installation.handler.dispose());
  return {
    installation,
    setSourceGrants: (next: Grants) => {
      browserGrants = next;
    },
    replaceMcpVerifier: (next: NonNullable<typeof currentMcpVerifier>) => {
      currentMcpVerifier = next;
    },
    ownerFailures,
    setMergeRead: (read: NonNullable<BrowserHomeInstallationOptions["mergeFacts"]>) => {
      mergeRead = read;
    },
    authentication,
    nativeCounts,
    runs,
    denyContext: () => {
      contextReadable = false;
    },
    core,
    path,
    created,
    nudges,
    privateWorkerLog,
    github,
    runStore,
    setPolicy: () => {
      policy = "changed";
    },
    expire: () => {
      now = DAY_MS + 1001;
    },
    expireSourceSnapshot: () => {
      now = 31 * DAY_MS + 1001;
    },
    tokens,
    personalTokens,
    nativeReplies,
    nativeReplyThreads,
    request,
    execute,
    seedQuestion,
    store,
    ledger,
    registry,
    coordinator,
    effects,
    confirmations,
    context,
    targetThread,
    tasks,
    denyWrites: () => {
      writable = false;
    },
    allowWrites: () => {
      writable = true;
    },
    denyNativeReads: () => {
      browserGrants = {
        actions: new Set([
          "organization:read",
          "organization:send",
          "runs:read",
          "steer:write",
          "repo:use",
          "agent:run:coding",
        ]),
        channels: new Set(["web:alice"]),
        repos: new Set(["sample/api"]),
        organizations: new Set(["fixture"]),
      };
    },
    onSlackRead: (hook?: () => void | Promise<void>) => {
      slackReadHook = hook;
    },
    revokeSlack: () => {
      slackAvailable = false;
    },
    restoreSlack: () => {
      slackAvailable = true;
    },
    revoke: () => {
      available = false;
    },
    restoreSource: () => {
      available = true;
    },
  };
}
async function nativeImageInput(text = "memory forget", id = "1000.93") {
  const image = { mediaType: "image/png", name: "screen.png", data: "AAA=" };
  const nativeMedia: import("../core/nativeMedia.js").NativeMedia = {
    version: 1 as const,
    channelId: "slack:D1",
    userId: "slack:UALICE",
    threadKey: "slack:D1:media-proof",
    messageId: id,
    rawTextDigest: await nativeMediaDigest(text),
    sourceFilesDigest: await nativeMediaDigest("fixture-source-files"),
    files: [
      {
        id: "slack:file:FIMAGE",
        kind: "image" as const,
        index: 0,
        slot: 0,
        mediaType: image.mediaType,
        name: image.name,
        size: 2,
        representationDigest: await nativeMediaDigest(image.data),
      },
    ],
  };
  return {
    image,
    msg: {
      ...nativeMedia,
      text,
      images: [image],
      nativeMedia,
      nativeMediaDigest: await nativeMediaDigest(nativeMedia),
    },
    evidence: {
      source: "slack" as const,
      identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
    },
  };
}
async function privatePipelines(s: Awaited<ReturnType<typeof fixture>>, count: number, distinct: boolean) {
  const sourceIdentity = { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" };
  for (let i = 0; i < count; i++) {
    const msg = {
      userId: "slack:UALICE",
      channelId: "slack:D1",
      threadKey: distinct ? `slack:D1:${i + 1}` : "slack:D1:1",
      messageId: `${i + 1}`,
      text: "Read-only source",
    };
    const native = await s.authentication.resolveNative(msg, { source: "slack", identity: sourceIdentity });
    if (native.status !== "resolved") throw new Error("No native source");
    const auth = {
      ...native.authentication,
      sourceReference: {
        ...native.authentication.sourceReference!,
        privateSource: true as const,
        capturedPrivateEpoch: "a".repeat(64),
        sourceRepository: "sample/api",
      },
    };
    const key = `source-${i}`;
    const admission = await s.installation.organization.admit(auth, {
      key,
      sourceEvent: key,
      content: msg.text,
      context: [],
      target: null,
      destination: { kind: "broad" },
      workload: "message",
    });
    if (admission.status !== "receipt") throw new Error(`No source admission: ${admission.status}`);
    const resolved = await s.installation.organization.resolve(auth);
    if (!resolved) throw new Error("No source actor");
    const submission = await s.store.execute({ action: "submission", ...resolved, source: "slack", key });
    if (submission.status !== "submission") throw new Error("No source envelope");
    const lease = await s.store.execute({ action: "claim", organization: "fixture", owner: "setup", leaseMs: DAY_MS });
    if (lease.status !== "state") throw new Error("No source lease");
    const owned = { organization: "fixture", owner: "setup", generation: lease.state.lease!.generation };
    const effect = await s.store.execute({ action: "effect", ...owned, source: "slack", key, actor: resolved.actor });
    if (effect.status !== "receipt" || !effect.receipt.effectKey) throw new Error("No source effect");
    const origin = { ...submission.envelope, content: "", context: [] };
    const ingress = await s.ledger.consumeIngress({
      effectKey: effect.receipt.effectKey,
      digest: admission.receipt.digest,
      requester: msg.userId,
      threadKey: msg.threadKey,
      request: {},
      contentExpiresAt: DAY_MS,
      origin,
      originExpiresAt: admission.receipt.expiresAt,
      receiptId: admission.receipt.id,
    });
    if (ingress.status !== "claimed") throw new Error(`No source owner: ${ingress.status}`);
    const runId = ingress.record.runId;
    await s.ledger.finishIngress({
      effectKey: ingress.record.effectKey,
      digest: ingress.record.digest,
      runId,
      status: "completed",
      outcome: "Original source completed",
    });
    await s.store.execute({
      action: "settle",
      ...owned,
      receiptId: admission.receipt.id,
      status: "accepted",
      ownerRunId: runId,
      reason: null,
      reply: null,
      contentTtlMs: DAY_MS,
    });
    await s.store.execute({ action: "complete", ...owned, through: lease.state.lease!.through });
    const instance: CoordinatorInstance = {
      id: `private-${i}`,
      kind: "ship",
      userId: msg.userId,
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      repo: "sample/api",
      branch: `work-${i}`,
      base: "main",
      merge: "person",
      plan: { id: `private-${i}` },
      createdAt: 1000,
      runId,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "task",
      slug: "task",
      title: `Private task ${i}`,
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      threadKey: privateWorkerThreadKey({ instanceId: instance.id, unit: "task" }),
      workBrief: {
        requesterId: msg.userId,
        mainThreadKey: msg.threadKey,
        actId: `act-${i}`,
        repo: instance.repo,
        base: "main",
        question: "Private task question",
        findings: [],
        requestedChange: "Fix it",
      },
      context: contextCapsuleOf({
        version: 1,
        source: { runId, requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
        session: { key: "source", from: 0, to: -1 },
        assets: [],
      }),
      idle: {
        why: "awaiting human",
        at: 1000,
        renewalsLeft: 1,
        wakes: 0,
        spendUsd: null,
        humanGate: {
          assignedTo: "slack:UALICE",
          pr: { number: 42, url: "https://github.com/sample/api/pull/42" },
          round: 1,
          verdict: "approve",
          findings: [],
          askedAt: 1000,
        },
      },
    };
    const messageId = `browser:${admission.receipt.revision}:${encodeURIComponent(msg.messageId)}`;
    const turn = await s.coordinator.recordRequesterTurn({
      requesterId: msg.userId,
      threadKey: msg.threadKey,
      messageId,
    });
    if (!turn.ok) throw new Error("No requester turn");
    const created = await s.coordinator.claimMainTask(
      { mainThreadKey: msg.threadKey, actId: `act-${i}` },
      instance,
      unit,
      { requesterId: msg.userId, sourceMessageId: messageId, revision: turn.turn.revision, repo: instance.repo },
    );
    if (!created.ok) throw new Error("No canonical private task");
  }
}
async function privateHome(s: Awaited<ReturnType<typeof fixture>>, enrichment?: () => void | Promise<void>) {
  const home = createHomeService({
    organizationId: "fixture",
    instances: s.coordinator,
    conditions: createHomeConditionReader(s.coordinator),
  });
  let resolve!: (value: { status: number; text: string }) => void;
  const output = new Promise<{ status: number; text: string }>((done) => {
    resolve = done;
  });
  let status = 0;
  const handler = createHomeViewHandler(
    home,
    (_req, res, code, _actor, _title, seed) => {
      res.writeHead(code);
      res.end(JSON.stringify(seed));
    },
    "fixture",
    {
      privateRead: (context) => s.installation.privateRead(context.home!),
      answers: async () => {
        await enrichment?.();
        return {};
      },
    },
  );
  const req = Object.assign(Readable.from([]), { method: "GET", url: "/home", headers: {} }) as IncomingMessage;
  const res = {
    writeHead(code: number) {
      status = code;
    },
    setHeader() {},
    end(text: string) {
      resolve({ status, text });
    },
  } as unknown as ServerResponse;
  expect(
    handler(req, res, {
      actor: s.context.actor,
      organization: "fixture",
      attentionRecipients: ["access:alice", "slack:UALICE"],
      home: s.context,
    }),
  ).toBe(true);
  return output;
}
describe("browser installation", () => {
  it.each([false, true])(
    "guards the next original bearer model request after plain-text deletion: %s",
    async (remove) => {
      let entered: () => void = () => {},
        release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const copied = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const modelRequests: import("../core/provider.js").CompletionRequest[] = [];
      const provider: Provider = {
        name: "fixture",
        complete: async (request) => {
          modelRequests.push(structuredClone(request));
          if (modelRequests.length === 2) {
            entered();
            await held;
          }
          return { content: [{ type: "text", text: "Recorded answer" }], stopReason: "end_turn" };
        },
      };
      const s = await fixture(false, false, provider);
      const mintChecks: Promise<boolean>[] = [];
      const originalBearers = new Map<string, string>();
      const store = s.core.runBearers!;
      const mint = store.mint.bind(store);
      vi.spyOn(store, "mint").mockImplementation((grant, options) => {
        const token = mint(grant, options);
        originalBearers.set(grant.runId, token);
        // Real dispatch mint, before attach or trusted run-loop binding.
        mintChecks.push(store.sourceGuardFor(grant.runId).check());
        return token;
      });
      async function send(text: string) {
        const home = (await s.request("GET", "/home/session")).body;
        const input = {
          key: home.submissionKey,
          revision: home.destination.revision,
          destination: { kind: "broad" as const },
          context: [],
          text,
        };
        expect((await s.request("POST", "/home/send", input)).status).toBe(200);
        const result = await s.installation.organization.receiptStatus(s.context.authentication, input.key);
        if (result.status !== "receipt" || !result.receipt.ownerRunId) throw new Error("No original owner");
        return { input, receipt: result.receipt };
      }
      const sourceA = await send("Private note A");
      await s.execute();
      const sourceB = await send("Continue B");
      const executing = s.execute();
      await copied;
      const forwarded: string[] = [],
        logs: string[] = [];
      expect(await Promise.all(mintChecks)).toEqual([false, false]);
      const token = originalBearers.get(sourceB.receipt.ownerRunId!);
      if (!token) throw new Error("No original model bearer");
      const body = JSON.stringify({
        model: "ignored",
        max_tokens: 64,
        messages: [{ role: "user", content: "Private note A\nContinue B" }],
      });
      const proxy = () =>
        handleModelProxyRequest(
          {
            method: "POST",
            path: ANTHROPIC_MESSAGES_PATH,
            headers: { authorization: `Bearer ${token}` },
            body: (async function* () {
              yield Buffer.from(body);
            })(),
          },
          {
            bearers: store,
            providers: () => s.core.config.config.providers,
            secrets: secretsFrom({ UNSET_FIXTURE_PROVIDER: "fixture-only-provider-key" }),
            clock: () => 1000,
            log: (line) => {
              logs.push(line);
            },
            fetch: (async (_url, init) => {
              forwarded.push(String(init?.body));
              return new Response(
                JSON.stringify({
                  id: "fixture-message",
                  type: "message",
                  role: "assistant",
                  model: "fixture-model",
                  content: [{ type: "text", text: "Proxy answer" }],
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 1 },
                }),
                { headers: { "content-type": "application/json" } },
              );
            }) as typeof fetch,
          },
        );
      try {
        expect(JSON.stringify(modelRequests[1].messages)).toContain("Private note A");
        const first = await proxy();
        expect(first.status).toBe(200);
        if (remove)
          expect(
            (await s.installation.runtime.deleteContent(s.context.authentication, sourceA.receipt.id)).status,
          ).toBe("ok");
        const second = await proxy();
        expect(second.status).toBe(remove ? 403 : 200);
        expect(forwarded).toHaveLength(remove ? 1 : 2);
        expect(forwarded[0]).toContain("Private note A");
        expect(JSON.stringify(logs)).not.toContain("Private note A");
        expect(JSON.stringify(logs)).not.toContain(token);
      } finally {
        release();
        await executing;
      }
      const replay = await s.installation.organization.receiptStatus(s.context.authentication, sourceB.input.key);
      expect(replay).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { id: sourceB.receipt.id, ownerRunId: sourceB.receipt.ownerRunId },
      });
    },
  );
  it.each([false, true])(
    "reads a thousand private generated pipelines with bounded fresh metadata phases (distinct sources: %s)",
    async (distinct) => {
      const s = await fixture(true, true, undefined, false, true, false, 10, true);
      await privatePipelines(s, 1000, distinct);
      const units = vi.spyOn(s.coordinator, "listUnits"),
        get = vi.spyOn(s.coordinator, "get");
      const catalogue = vi.spyOn(s.store, "execute");
      s.nativeCounts.slack = 0;
      s.nativeCounts.max = 0;
      const read = await privateHome(s);
      expect(read.status).toBe(200);
      const seed = JSON.parse(read.text);
      expect(seed.snapshot.needsYou).toHaveLength(1000);
      expect(seed.snapshot.needsYou[0].unit.title).toContain("Private task");
      expect(read.text).not.toContain("Private task question");
      expect(units).toHaveBeenCalledTimes(3000);
      expect(get).toHaveBeenCalledTimes(2000);
      expect(catalogue.mock.calls.filter(([command]) => command.action === "source-catalogue")).toHaveLength(
        distinct ? 10 : 2,
      );
      expect(s.nativeCounts.slack).toBe(distinct ? 4000 : 4);
      expect(s.nativeCounts.max).toBe(distinct ? 8 : 1);
      expect((await privateHome(s, () => s.revoke())).status).toBe(404);
    },
    60000,
  );
  it("rechecks only serialized private rows after a bounded projection omits another owned unit", async () => {
    const s = await fixture(true, true, undefined, false, true);
    await privatePipelines(s, 2, true);
    const groups = await Promise.all(
      ["private-0", "private-1"].map(async (id) => {
        const instance = await s.coordinator.get(id);
        if (!instance) throw new Error("No private pipeline");
        return { instance, units: await s.coordinator.listUnits(id) };
      }),
    );
    const guard = s.installation.privateRead(s.context);
    expect(await guard.begin()).toBe(true);
    expect([...(await guard.readMany(groups))]).toEqual([
      ["private-0:task", true],
      ["private-1:task", true],
    ]);
    guard.include!(["private-0:task"]);
    const omitted = groups[1]!.units[0]!;
    expect(
      (
        await s.coordinator.compareAndReplaceUnit(omitted, {
          ...omitted,
          idle: { ...omitted.idle!, humanGate: { ...omitted.idle!.humanGate!, assignedTo: "access:bob" } },
        })
      ).ok,
    ).toBe(true);
    const reads = vi.spyOn(s.coordinator, "get");
    expect(await guard.canEmit()).toBe(true);
    expect(reads.mock.calls).toEqual([["private-0"], ["private-0"]]);
  });
  it("starts the request source fence before projecting an inventory with no private rows", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const positive = await privateHome(s);
    expect(positive.status).toBe(200);
    expect(JSON.parse(positive.text).snapshot.needsYou[0].unit.title).toBe("Original unit");
    expect(await privateHome(s, () => s.setPolicy())).toEqual({ status: 404, text: "not found" });
  });
  it("fences private metadata after exact source or canonical ownership changes without releasing history", async () => {
    const s = await fixture(true, true, undefined, false, true);
    await privatePipelines(s, 2, true);
    const positive = await privateHome(s);
    expect(positive.status).toBe(200);
    expect(JSON.parse(positive.text).snapshot.needsYou).toHaveLength(2);
    const instance = await s.coordinator.get("private-0"),
      unit = (await s.coordinator.listUnits("private-0"))[0]!;
    if (!instance) throw new Error("No canonical private pipeline");
    expect(await s.installation.canReadPrivateUnit(s.context, instance, unit, true)).toBe(false);
    const progress = await privateHome(s, async () => {
      const recorded = await s.coordinator.compareAndReplaceUnit(unit, {
        ...unit,
        recordedProgress: {
          version: 1,
          revision: 1,
          workflowId: instance.id,
          ownerRunId: instance.runId,
          step: "check-build",
          at: 1000,
          basis: unitProgressBasis(unit),
          waiting: { kind: "retry" },
        },
      });
      // A diagnostic update carries no replacement recipient authority.
      if (!recorded.ok) throw new Error("No diagnostic update");
    });
    expect(progress.status).toBe(200);
    const current = (await s.coordinator.listUnits("private-0"))[0]!;
    const revoked = await privateHome(s, () => s.revokeSlack());
    expect(revoked).toEqual({ status: 404, text: "not found" });
    const denied = await privateHome(s);
    expect(denied.status).toBe(200);
    expect(JSON.parse(denied.text).snapshot.needsYou).toEqual([]);
    expect(denied.text).not.toContain("Private task 0");
    s.restoreSlack();
    let changed = false;
    const stale = await privateHome(s, () =>
      s.onSlackRead(async () => {
        if (changed) return;
        changed = true;
        const replaced = await s.coordinator.compareAndReplaceUnit(current, {
          ...current,
          idle: { ...current.idle!, humanGate: { ...current.idle!.humanGate!, assignedTo: "access:bob" } },
        });
        expect(replaced.ok).toBe(true);
      }),
    );
    expect(stale).toEqual({ status: 404, text: "not found" });
    s.onSlackRead();
    expect((await privateHome(s)).status).toBe(200);
  });
  it("gives real Core current quoted attached work metadata without changing the authored request or broad receiver", async () => {
    const completions: import("../core/provider.js").CompletionRequest[] = [];
    const provider: Provider = {
      name: "fixture",
      complete: async (request) => {
        completions.push(structuredClone(request));
        return {
          content: [{ type: "text", text: "The recorded unit remains on its original branch." }],
          stopReason: "end_turn",
        };
      },
    };
    const s = await fixture(false, false, provider);
    await s.seedQuestion({ repo: "sample/api", pr: { number: 42, url: "https://github.com/sample/api/pull/42" } });
    seedCoordinatorUnit(s.coordinator, { ...unit, pr: { number: 42, url: "https://github.com/sample/api/pull/42" } });
    const home = (await s.request("GET", "/home/session")).body;
    const input = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" as const },
      text: "Explain this unit",
      context: [
        { kind: "unit" as const, key: "fixture:original" },
        { kind: "run" as const, key: "original-child" },
        { kind: "pull-request" as const, key: "sample/api#42" },
        { kind: "pipeline" as const, key: "fixture" },
      ],
    };
    expect((await s.request("POST", "/home/send", input)).status).toBe(200);
    await s.execute();
    expect(completions).toHaveLength(1);
    const metadata = completions[0]!.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text.includes("Attached work metadata")),
    );
    const text = metadata?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? "";
    expect(text).toContain("UNTRUSTED CONTENT");
    expect(text).toContain('"title":"Original unit"');
    expect(text).toContain('"branch":"codex/original"');
    expect(text).toContain('"url":"/runs/unit/fixture%3Aoriginal"');
    expect(text).toContain('"url":"/runs/original-child"');
    expect(text).toContain('"url":"https://github.com/sample/api/pull/42"');
    expect(text).toContain('"url":"/pipelines/fixture"');
    expect(completions[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "Explain this unit" }],
    });
    const replay = await s.installation.organization.replay(s.context.authentication, {
      key: input.key,
      revision: input.revision,
      content: input.text,
      context: input.context,
      destination: input.destination,
    });
    expect(replay).toMatchObject({ status: "receipt", receipt: { status: "accepted" }, duplicate: true });
    if (replay?.status !== "receipt" || !replay.receipt.ownerRunId) throw new Error("No original owner");
    expect(await s.installation.originalPrivateSourceHistory(replay.receipt.ownerRunId)).toEqual([
      { role: "user", text: "Explain this unit", user: "access:alice" },
    ]);
    const row = await s.ledger.readIngressByRun(replay.receipt.ownerRunId);
    expect(row).toMatchObject({
      status: "record",
      record: {
        origin: {
          destination: { kind: "broad" },
          sourceReference: { actorId: "access:alice", userId: "access:alice", threadKey: "web:alice:organization" },
        },
      },
    });
    expect(s.created).toEqual([]);
    const stream = await s.installation.organization.streamTail(s.context.authentication);
    expect(stream).toMatchObject({ status: "stream_tail" });
    if (stream.status !== "stream_tail") throw new Error("No private stream");
    expect(stream.entries.map((entry) => entry.content)).toEqual([
      "Explain this unit",
      "The recorded unit remains on its original branch.",
    ]);
  });

  it("quotes only current owned private-unit facts through real Core without reading its work brief", async () => {
    let read = false,
      turns = 0;
    const requests: import("../core/provider.js").CompletionRequest[] = [];
    const provider: Provider = {
      name: "fixture",
      complete: async (request) => {
        requests.push(structuredClone(request));
        if (!read && ++turns <= 2)
          return {
            content: [
              {
                type: "tool_use",
                id: `start-context-${turns}`,
                name: "work_start",
                input: {
                  repo: "sample/api",
                  question: "Own private task",
                  schemaVersion: 1,
                  cause: { kind: "unknown", reason: "Private implementation details outside metadata" },
                  evidence: { availability: "unavailable", reason: "Code-only change" },
                  requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
                  acceptance: "A reviewed change",
                  findings: [],
                  requestedChange: "Own private task",
                  sourceMessage: "Start own task",
                },
              },
            ],
            stopReason: "tool_use",
          };
        return {
          content: [{ type: "text", text: read ? "The unit remains on its recorded branch." : "Owned work started." }],
          stopReason: "end_turn",
        };
      },
    };
    const s = await fixture(false, false, provider, true, true);
    const first = (await s.request("GET", "/home/session")).body;
    expect(
      (
        await s.request("POST", "/home/send", {
          key: first.submissionKey,
          revision: first.destination.revision,
          destination: { kind: "broad" },
          text: "Start own task",
          context: [{ kind: "repository", key: "sample/api" }],
        })
      ).status,
    ).toBe(200);
    await s.execute();
    expect(s.created).toHaveLength(1);
    const units = await s.coordinator.listUnits(s.created[0]!);
    expect(units).toHaveLength(1);
    expect(units[0]!.workBrief?.cause).toEqual({
      kind: "unknown",
      reason: "Private implementation details outside metadata",
    });
    read = true;
    const last = (await s.request("GET", "/home/session")).body;
    const key = `${s.created[0]}:${units[0]!.unit}`;
    expect(
      (
        await s.request("POST", "/home/send", {
          key: last.submissionKey,
          revision: last.destination.revision,
          destination: { kind: "broad" },
          text: "Explain this unit",
          context: [{ kind: "unit", key }],
        })
      ).status,
    ).toBe(200);
    await s.execute();
    const context = requests
      .at(-1)!
      .messages.filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      .find((text) => text.includes("Attached work metadata"));
    expect(context).toContain('"title":"Own private task"');
    expect(context).toContain('"repository":"sample/api"');
    expect(context).not.toContain("Private implementation details outside metadata");
    expect(context).not.toContain("workBrief");
    expect(s.created).toHaveLength(1);
  });

  it("reads queued input B's exact attachments through its guarded IO without inheriting input A metadata", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const admit = async (
      text: string,
      context: import("../core/organization/service.js").OrganizationAdmissionInput["context"],
    ) => {
      const home = (await s.request("GET", "/home/session")).body;
      expect(
        (
          await s.request("POST", "/home/send", {
            key: home.submissionKey,
            revision: home.destination.revision,
            destination: { kind: "broad" },
            text,
            context,
          })
        ).status,
      ).toBe(200);
      const resolved = await s.installation.organization.resolve(s.context.authentication);
      if (!resolved) throw new Error("No own source");
      const saved = await s.store.execute({
        action: "submission",
        ...resolved,
        source: "browser",
        key: home.submissionKey,
      });
      if (saved.status !== "submission" || !saved.receipt.ownerRunId) throw new Error("No retained owner");
      const owned = await s.installation.originalBinding(saved.receipt.ownerRunId);
      if (!owned) throw new Error("No protected original input");
      return owned;
    };
    const a = await admit("Explain the attached unit", [{ kind: "unit", key: "fixture:original" }]);
    const b = await admit("Explain the attached run", [{ kind: "run", key: "original-child" }]);
    const message = withOriginalOrganizationDispatch(b.msg, {
      ingressRunId: b.runId,
      organizationSequence: b.receipt.revision,
    });
    const history = await a.io.authoritativePrivateHistory!(message);
    const metadata = history.find((turn) => turn.text.includes("Attached work metadata"));
    expect(metadata?.text).toContain('"kind":"run","key":"original-child"');
    expect(metadata?.text).not.toContain('"title":"Original unit"');
    expect(metadata?.user).toBeUndefined();
    const rehosted = await a.io.rehostOrganizationInput!(message);
    expect(rehosted?.msg).toMatchObject({
      text: "Explain the attached run",
      userId: "access:alice",
      threadKey: "web:alice:organization",
    });
    expect(await rehosted!.io.authoritativePrivateHistory!(rehosted!.msg)).toEqual(history);
    expect(await s.installation.originalPrivateSourceHistory(b.runId)).toEqual([
      { role: "user", text: "Explain the attached unit", user: "access:alice" },
      { role: "user", text: "Explain the attached run", user: "access:alice" },
    ]);
    expect(s.created).toEqual([]);
  });
  it("holds the accepted original request if an attached entity loses read permission during metadata loading", async () => {
    const completions: import("../core/provider.js").CompletionRequest[] = [];
    const provider: Provider = {
      name: "fixture",
      complete: async (request) => {
        completions.push(request);
        return { content: [{ type: "text", text: "Must not read revoked metadata" }], stopReason: "end_turn" };
      },
    };
    const s = await fixture(false, false, provider);
    await s.seedQuestion();
    const home = (await s.request("GET", "/home/session")).body;
    const input = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" as const },
      text: "Explain this run",
      context: [{ kind: "run" as const, key: "original-child" }],
    };
    const posted = await s.request("POST", "/home/send", input);
    expect(posted.status).toBe(200);
    const read = s.runs.getRun.bind(s.runs);
    vi.spyOn(s.runs, "getRun").mockImplementation(async (id, opts) => {
      const result = await read(id, opts);
      if (id === "original-child") s.denyContext();
      return result;
    });
    await s.execute();
    expect(completions).toEqual([]);
    const resolved = await s.installation.organization.resolve(s.context.authentication);
    if (!resolved) throw new Error("No own source");
    const saved = await s.store.execute({ action: "submission", ...resolved, source: "browser", key: input.key });
    expect(saved).toMatchObject({ status: "submission", receipt: { status: "accepted" } });
    if (saved.status !== "submission" || !saved.receipt.ownerRunId) throw new Error("No retained original owner");
    expect(await s.ledger.readIngressByRun(saved.receipt.ownerRunId)).toMatchObject({
      status: "record",
      record: { receiptId: saved.receipt.id, status: "uncertain" },
    });
    expect(s.created).toEqual([]);
  });

  it("approves an own unmarked personal registry offer through current native proof without lending a foreign viewer consent", async () => {
    const s = await fixture(false, false, undefined, false, false, true);
    const live = s.registry.create("Own typed stop target", {
      channelId: "mcp:default",
      threadKey: "mcp:default:owned",
      userId: "access:alice",
      channelVisibility: "machine",
    });
    const commands = buildCoreCommands(s.core.config, s.runStore, {
      registry: s.registry,
      runs: createRunsService({ registry: s.registry, store: s.runStore, units: s.coordinator }),
      secrets: secretsFrom({}),
      dataDir: s.path,
      warn: () => {},
      audit: () => {},
    });
    s.core.commands = commands;
    const pin = () => ({ issuer: identity.issuer, audience: "access-app", organization: "fixture" });
    const options = {
      auth: { tokens: s.tokens },
      personalTokens: s.personalTokens,
      personalApprovalPin: pin,
      commands,
      grantsFor: (id: string) => s.core.config.grantsFor(id),
      approvalsEnabled: true,
      publicBaseUrl: "https://fixture.test",
    };
    const rpc = (name: string, args: unknown, meta = {}) =>
      handleMcpRequest(
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${"c".repeat(64)}`,
            ...(Object.hasOwn(meta, "_meta")
              ? { "mcp-protocol-version": FORM_PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": name }
              : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args, ...meta },
          }),
        },
        s.core,
        options,
      );
    const offered = await rpc(
      "runs_stop",
      { id: live.id },
      {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: FORM_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "fixture-client", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        },
      },
    );
    expect(offered.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
    const id = (offered.body as { result: { requestState: string } }).result.requestState;
    const row = await s.confirmations.get(id);
    expect(row).toMatchObject({
      kind: "run",
      command: "runs.stop",
      message: { userId: "access:alice", authenticatedAs: "mcp:personal:alice" },
    });
    expect(row?.originalOrganization).toBeUndefined();
    const view = createMcpApprovalView(s.core, {
      ...options,
      resolveApprovalSource: (credential, saved) =>
        s.installation.approvalSource(
          saved,
          credential.sub === "alice" ? s.context.actor : { ...s.context.actor, id: `access:${credential.sub}` },
        ),
    });
    async function approve(sub: string, offerId = id) {
      const req = Readable.from(["action=approve"]) as IncomingMessage;
      Object.assign(req, {
        method: "POST",
        url: `/settings/approve?id=${offerId}`,
        headers: {
          host: "fixture.test",
          origin: "https://fixture.test",
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      let status = 0,
        body = "";
      const res = {
        writeHead(value: number) {
          status = value;
        },
        end(value: string) {
          body = value;
        },
      } as unknown as ServerResponse;
      expect(view(req, res, { sub })).toBe(true);
      for (let i = 0; i < 100 && !body; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      return { status, body };
    }
    expect((await approve("other")).status).toBe(404);
    expect((await s.confirmations.get(id))?.browserApproved).toBeUndefined();
    expect(live.control.hardSignal.aborted).toBe(false);
    expect(await approve("alice")).toMatchObject({
      status: 200,
      body: expect.stringContaining("Approved. Return to your MCP client"),
    });
    expect((await s.confirmations.get(id))?.approvedBy).toBe("browser");
    expect(live.control.hardSignal.aborted).toBe(false);
    const resumed = await rpc("approval_resume", { id });
    expect(resumed.body).toMatchObject({
      result: {
        content: [{ type: "text", text: expect.stringContaining("Stop requested. Shutdown is not confirmed.") }],
      },
    });
    expect(live.control.hardSignal.aborted).toBe(true);
    expect(await s.confirmations.get(id)).toBeUndefined();
    const second = s.registry.create("Another own typed stop target", {
      channelId: "mcp:default",
      threadKey: "mcp:default:second",
      userId: "access:alice",
      channelVisibility: "machine",
    });
    const held = await rpc(
      "runs_stop",
      { id: second.id },
      {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: FORM_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "fixture-client", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
        },
      },
    );
    expect(held.body).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
    const heldId = (held.body as { result: { requestState: string } }).result.requestState;
    const original = await s.personalTokens.get(digestBearer("c".repeat(64)));
    if (!original) throw new Error("No original personal token");
    await s.personalTokens.put({ ...original, digest: digestBearer("d".repeat(64)) });
    expect(await s.personalTokens.delete(original.digest, original.subject)).toBe(true);
    expect((await approve("alice", heldId)).status).toBe(404);
    expect((await s.confirmations.get(heldId))?.approvedBy).toBeUndefined();
    expect(second.control.hardSignal.aborted).toBe(false);
  });
  it("holds a pending canonical answer through target-proof outage and answers once after fresh proof", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const read = await s.installation.readThread(s.context, thread);
    if (!read?.target) throw new Error("No saved question target");
    const issued = await s.installation.organization.issue(s.context.authentication, DAY_MS);
    if (issued.status !== "key") throw new Error("No submission key");
    const key = issued.key;
    const authentication = {
      ...s.context.authentication,
      sourceReference: { ...s.context.authentication.sourceReference!, messageId: `browser:${key}`, threadKey: thread },
    };
    const input = {
      key,
      sourceEvent: `browser:${key}`,
      content: "Proceed with the saved question",
      workload: "act" as const,
      destination: { kind: "thread" as const, thread },
      target: read.target,
      context: [],
    };
    await s.store.execute({
      action: "observe",
      organization: "fixture",
      target: read.target.key,
      revision: read.target.revision,
    });
    const admitted = await s.installation.organization.admit(authentication, input);
    if (admitted.status !== "receipt") throw new Error(`Not admitted: ${admitted.status}`);
    const resolve = s.authentication.resolveAuthorization;
    s.authentication.resolveAuthorization = async (input) =>
      input.action === "read" ? { status: "unavailable" } : resolve(input);
    await s.installation.runtime.reconcile("fixture");
    s.authentication.resolveAuthorization = resolve;
    expect(await s.installation.organization.admit(authentication, input)).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "pending" },
    });
    expect(await s.ledger.readIngress(admitted.receipt.effectKey!)).toEqual({ status: "not_found" });
    await s.installation.runtime.reconcile("fixture");
    await s.execute();
    const events = await s.coordinator.listEvents({ instanceId: "fixture", unit: "original" });
    expect(events).toMatchObject([
      { text: "Proceed with the saved question", sender: "access:alice", id: `browser:${key}` },
    ]);
    expect(events).toHaveLength(1);
    expect(await s.installation.readOriginalRun(events[0]!.organizationIngressRunId!)).toEqual({
      status: "completed",
      outcome: "Original answer recorded.",
    });
    await s.installation.runtime.reconcile("fixture");
    expect(await s.coordinator.listEvents({ instanceId: "fixture", unit: "original" })).toHaveLength(1);
    const denied = await fixture();
    await denied.seedQuestion();
    denied.denyWrites();
    expect((await denied.installation.readThread(denied.context, thread))?.canWrite).toBe(false);
  });
  it("restores only the current unit recipient after source snapshot erasure without restoring input or execution", async () => {
    const s = await fixture();
    const home = (await s.request("GET", "/home/session")).body;
    expect(
      (
        await s.request("POST", "/home/send", {
          key: home.submissionKey,
          revision: home.destination.revision,
          destination: { kind: "broad" },
          text: "memory forget",
          context: [],
        })
      ).status,
    ).toBe(200);
    await s.execute();
    const resolved = await s.installation.organization.resolve(s.context.authentication);
    if (!resolved) throw new Error("No current organization");
    const saved = await s.store.execute({
      action: "submission",
      ...resolved,
      source: "browser",
      key: home.submissionKey,
    });
    if (saved.status !== "submission" || !saved.receipt.ownerRunId || !saved.receipt.effectKey)
      throw new Error("No original owner");
    const id = saved.receipt.ownerRunId;
    const original = await s.installation.originalBinding(id);
    if (!original) throw new Error("No retained source before erasure");
    expect(await s.installation.originalPrivateSourceHistory(id)).toEqual([
      { role: "user", text: "memory forget", user: "access:alice" },
    ]);
    await s.ledger.clearIngressContent(saved.receipt.effectKey);
    expect(await s.installation.originalBinding(id)).toBeUndefined();
    expect(await s.installation.originalPrivateSourceHistory(id)).toBeUndefined();
    const io = await s.installation.originalAudienceIO(id, {
      threadKey: original.msg.threadKey,
      userId: original.msg.userId,
    });
    const recipient = io?.organizationPrivateAudience?.();
    expect(recipient).toEqual({
      kind: "organization-private",
      organization: "fixture",
      stream: 'browser:["https://access.fixture.test",null,"alice"]',
      actorId: "access:alice",
      userId: "access:alice",
      channelId: "web:alice",
      threadKey: "web:alice:organization",
    });
    expect(recipient && (await io!.verifyOrganizationPrivateAudience!(recipient))).toEqual({ ok: true });
    await expect(io!.authoritativePrivateHistory!(original.msg)).rejects.toThrow(
      "The original private input is unavailable.",
    );
    expect(await io!.rehostOrganizationInput!(original.msg)).toBeUndefined();
    expect(
      await s.installation.originalAudienceIO(id, { threadKey: original.msg.threadKey, userId: "access:bob" }),
    ).toBeUndefined();
    s.setPolicy();
    expect(
      await s.installation.originalAudienceIO(id, { threadKey: original.msg.threadKey, userId: original.msg.userId }),
    ).toBeUndefined();
  });
  it("retains owned unit facts after linking and unlinking without exposing the old private journal", async () => {
    let turn = 0;
    const provider: Provider = {
      name: "fixture",
      complete: async () =>
        ++turn === 1
          ? {
              content: [
                {
                  type: "tool_use",
                  id: "start-owned-facts",
                  name: "work_start",
                  input: {
                    repo: "sample/api",
                    question: "Build selected repository",
                    schemaVersion: 1,
                    cause: { kind: "unknown", reason: "Not investigated" },
                    evidence: { availability: "unavailable", reason: "Code-only change" },
                    requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
                    acceptance: "A reviewed change",
                    findings: [],
                    requestedChange: "Build selected repository",
                    sourceMessage: "Build selected repository",
                  },
                },
              ],
              stopReason: "tool_use",
            }
          : { content: [{ type: "text", text: "Started owned unit" }], stopReason: "end_turn" },
    };
    const s = await fixture(false, false, provider, false, true);
    const home = (await s.request("GET", "/home/session")).body;
    expect(
      (
        await s.request("POST", "/home/send", {
          key: home.submissionKey,
          revision: home.destination.revision,
          destination: { kind: "broad" },
          text: "Build selected repository",
          context: [{ kind: "repository", key: "sample/api" }],
        })
      ).status,
    ).toBe(200);
    await s.execute();
    const owner = await s.coordinator.get(s.created[0]!);
    const [createdRow] = await s.coordinator.listUnits(s.created[0]!);
    if (!owner || !createdRow) throw new Error("No canonical private unit");
    const row = {
      ...createdRow,
      threadKey: privateWorkerThreadKey({ instanceId: createdRow.instanceId, unit: createdRow.unit }),
    };
    await s.coordinator.compareAndReplaceUnit(createdRow, row);
    await s.privateWorkerLog.append(row.threadKey, {
      kind: "reply",
      id: "old-mixed-journal",
      text: "OLD_MIXED_PRIVATE_OUTPUT",
      at: 1000,
    });
    expect(
      (await s.installation.readThread(s.context, row.threadKey))?.entries.map((entry) => entry.content),
    ).toContain("OLD_MIXED_PRIVATE_OUTPUT");
    const person = await s.store.directory.createPerson();
    if (person.status !== "created") throw new Error("No new person");
    expect(
      (
        await s.store.directory.change({
          action: "link",
          identity,
          personId: person.person.id,
          expectedRevision: 0,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        })
      ).status,
    ).toBe("changed");
    expect(await s.installation.canReadPrivateUnit(s.context, owner, row)).toBe(true);
    expect(await s.installation.readThread(s.context, row.threadKey)).toBeUndefined();
    expect(
      (
        await s.store.directory.change({
          action: "revoke",
          identity,
          personId: person.person.id,
          expectedRevision: 1,
          actor: identity,
          proof: { method: "dual-authentication", version: 1 },
        })
      ).status,
    ).toBe("changed");
    expect(await s.installation.canReadPrivateUnit(s.context, owner, row)).toBe(true);
    expect(await s.installation.readThread(s.context, row.threadKey)).toBeUndefined();
    expect(
      await s.installation.originalAudienceIO(row.context!.handoff.source.runId, {
        threadKey: owner.threadKey,
        userId: owner.userId,
      }),
    ).toBeUndefined();
  });
  it("starts a verified personal MCP request as one human-owned unit and answers its question in the browser before linking", async () => {
    let turns = 0;
    const provider: Provider = {
      name: "fixture",
      complete: async () =>
        ++turns === 1
          ? {
              content: [
                {
                  type: "tool_use",
                  id: "start-personal-work",
                  name: "work_start",
                  input: {
                    repo: "sample/api",
                    question: "Build selected repository",
                    schemaVersion: 1,
                    cause: { kind: "unknown", reason: "Not investigated" },
                    evidence: { availability: "unavailable", reason: "Code-only change" },
                    requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
                    acceptance: "A reviewed change",
                    findings: [],
                    requestedChange: "Build selected repository",
                    sourceMessage: "Build selected repository",
                  },
                },
              ],
              stopReason: "tool_use",
            }
          : { content: [{ type: "text", text: "The work request is processed." }], stopReason: "end_turn" },
    };
    const s = await fixture(false, false, provider, false, true, true);
    expect(await s.store.directory.resolve(identity)).toEqual({ status: "unknown" });
    const admitted = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: `Bearer ${"c".repeat(64)}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "dispatch",
            arguments: { text: "Build selected repository", idempotencyKey: "personal-work" },
          },
        }),
      },
      s.core,
      {
        auth: { tokens: s.tokens },
        personalTokens: s.personalTokens,
        admit: (msg, _io, evidence) => s.installation.admitNative(msg, evidence),
      },
    );
    expect(admitted.body).toMatchObject({
      result: { structuredContent: { admission: { status: "accepted", runId: expect.any(String) } } },
    });
    const sourceRunId = (admitted.body as { result: { structuredContent: { admission: { runId: string } } } }).result
      .structuredContent.admission.runId;
    expect(await s.ledger.readIngressByRun(sourceRunId)).toMatchObject({
      status: "record",
      record: {
        origin: {
          actor: { kind: "service", identity: { subject: "personal:alice" }, onBehalfOf: identity },
          sourceReference: { actorId: "mcp:personal:alice", userId: "access:alice" },
        },
      },
    });
    await s.execute();
    expect((await s.installation.originalBinding(sourceRunId))?.actor).toMatchObject({
      kind: "service",
      id: "mcp:personal:alice",
      self: ["mcp:personal:alice"],
      onBehalfOf: { id: "access:alice" },
    });
    expect(s.created).toHaveLength(1);
    const owner = await s.coordinator.get(s.created[0]!);
    const [created] = await s.coordinator.listUnits(s.created[0]!);
    expect(owner).toMatchObject({ userId: "access:alice", authenticatedAs: "mcp:personal:alice" });
    if (!owner || !created) throw new Error("No personal work");
    const unitThread = privateWorkerThreadKey({ instanceId: created.instanceId, unit: created.unit });
    const asked = {
      ...created,
      threadKey: unitThread,
      idle: { ...unit.idle!, humanGate: { ...unit.idle!.humanGate!, assignedTo: owner.userId } },
    };
    expect((await s.coordinator.compareAndReplaceUnit(created, asked)).ok).toBe(true);
    const focused = await s.request("POST", "/home/focus", { thread: unitThread });
    expect(focused.status).toBe(200);
    expect(focused.body.destination).toMatchObject({ kind: "thread", thread: unitThread, canWrite: true });
    const answered = await s.request("POST", "/home/send", {
      key: focused.body.submissionKey,
      revision: focused.body.destination.revision,
      destination: { kind: "thread", thread: unitThread },
      text: "Proceed with this reviewed head",
      context: [],
    });
    expect(answered.status).toBe(200);
    await s.execute();
    expect(
      (await s.coordinator.listEvents({ instanceId: created.instanceId, unit: created.unit })).map((event) => ({
        sender: event.sender,
        text: event.text,
      })),
    ).toEqual([{ sender: "access:alice", text: "Proceed with this reviewed head" }]);
    expect(await s.store.directory.resolve(identity)).toEqual({ status: "unknown" });
  });

  it("binds the first browser coding request to its selected public repository and starts one canonical private unit through real Core", async () => {
    let turns = 0;
    const provider: Provider = {
      name: "fixture",
      complete: async () => {
        turns++;
        return turns <= 2
          ? {
              content: [
                {
                  type: "tool_use",
                  id: `start-${turns}`,
                  name: "work_start",
                  input: {
                    repo: "sample/web",
                    question: "Build selected repository",
                    schemaVersion: 1,
                    cause: { kind: "unknown", reason: "Not investigated" },
                    evidence: { availability: "unavailable", reason: "Code-only change" },
                    requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
                    acceptance: "A reviewed change",
                    findings: [],
                    requestedChange: "Build the requested public repository change",
                    sourceMessage: "Build selected repository",
                  },
                },
              ],
              stopReason: "tool_use",
            }
          : { content: [{ type: "text", text: "The original private work is started." }], stopReason: "end_turn" };
      },
    };
    const s = await fixture(false, false, provider, true);
    const home = (await s.request("GET", "/home/session")).body;
    expect(home.repositories).toEqual({
      status: "complete",
      repositories: [{ repo: "sample/api" }, { repo: "sample/web" }],
    });
    const conflict = await s.request("POST", "/home/send", {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" },
      text: "Build selected repository",
      context: [
        { kind: "repository", key: "sample/web" },
        { kind: "repository", key: "sample/api" },
      ],
    });
    expect(conflict.status).toBe(404);
    expect(s.created).toEqual([]);
    const fresh = (await s.request("GET", "/home/session")).body;
    const input = {
      key: fresh.submissionKey,
      revision: fresh.destination.revision,
      destination: { kind: "broad" },
      text: "Build selected repository",
      context: [{ kind: "repository", key: "sample/web" }],
    };
    expect((await s.request("POST", "/home/send", input)).status).toBe(200);
    await s.execute();
    expect(s.created).toHaveLength(1);
    const rows = await s.coordinator.listUnits(s.created[0]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instanceId: s.created[0],
      workBrief: { requesterId: "access:alice", mainThreadKey: "web:alice:organization", repo: "sample/web" },
    });
    expect((await s.coordinator.get(s.created[0]!))?.repo).toBe("sample/web");
    const replay = await s.installation.organization.replay(s.context.authentication, {
      key: input.key,
      content: input.text,
      context: [{ kind: "repository", key: "sample/web" }],
      destination: { kind: "broad" },
      revision: input.revision,
    });
    expect(replay).toMatchObject({ status: "receipt", duplicate: true, receipt: { status: "accepted" } });
    if (replay?.status !== "receipt" || !replay.receipt.ownerRunId) throw new Error("No original owner receipt");
    const original = await s.ledger.readIngressByRun(replay.receipt.ownerRunId);
    expect(original).toMatchObject({
      status: "record",
      record: {
        contentExpiresAt: 1000 + 30 * DAY_MS,
        originExpiresAt: 1000 + 365 * DAY_MS,
        request: { envelope: { content: "Build selected repository", contentExpiresAt: 1000 + 30 * DAY_MS } },
        origin: { content: "", context: [], contentExpiresAt: 1000 + 90 * DAY_MS },
      },
    });
    expect((await s.installation.originalBinding(replay.receipt.ownerRunId))?.msg.text).toBe(
      "Build selected repository",
    );
    expect((await s.request("POST", "/home/send", input)).body.duplicate).toBe(true);
    expect(s.created).toHaveLength(1);
    const privateUnit = rows[0]!;
    const question = {
      ...unit.idle!.humanGate!,
      pr: { number: 42, url: "https://github.com/sample/web/pull/42" },
      findings: [
        {
          id: "F1",
          severity: "minor" as const,
          file: "app.ts",
          title: "Choose release behavior",
          humanGated: true as const,
        },
      ],
      primaryAction: { label: "Merge", text: "Merge the reviewed pull request" },
    };
    expect(
      await s.coordinator.putUnits([
        {
          ...privateUnit,
          threadKey: privateWorkerThreadKey({ instanceId: privateUnit.instanceId, unit: privateUnit.unit }),
          idle: { ...unit.idle!, humanGate: question },
        },
      ]),
    ).toEqual({
      ok: true,
    });
    const homeService = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const reader = {
      actorId: "access:alice",
      visibleTo: { kind: "all" as const },
      readPrivateUnit: (instance: CoordinatorInstance, row: CoordinatorUnit) =>
        s.installation.canReadPrivateUnit(s.context, instance, row),
    };
    const attention = await homeService.snapshot(reader);
    expect(attention.needsYou).toMatchObject([
      {
        unit: {
          title: "Build the requested public repository change",
          threads: { coding: expect.stringMatching(/^worker:/) },
        },
        conditions: [{ owner: { kind: "person", id: "access:alice" }, summary: "F1: Choose release behavior" }],
      },
    ]);
    const answers = await s.installation.answers(s.context, attention.needsYou);
    expect(Object.values(answers)).toMatchObject([
      {
        primaryAction: { label: "Merge", text: "Merge the reviewed pull request" },
        question: expect.stringContaining("Choose release behavior"),
      },
    ]);
    const target = answers[privateUnit.instanceId + ":" + privateUnit.unit]!;
    const everyoneActor = { ...s.context.actor };
    withWorkViewScope(
      everyoneActor,
      resolveWorkViewScope(everyoneActor, { organization: "fixture", mode: "everyone" }),
    );
    const everyone = { ...s.context, actor: everyoneActor };
    const allAttention = await homeService.snapshot({
      ...reader,
      readPrivateUnit: (instance: CoordinatorInstance, row: CoordinatorUnit) =>
        s.installation.canReadPrivateUnit(everyone, instance, row),
    });
    expect(allAttention.needsYou).toMatchObject([
      {
        unit: { title: "Build the requested public repository change" },
        conditions: [{ owner: { kind: "person", id: "access:alice" } }],
      },
    ]);
    expect(await s.installation.answers(everyone, allAttention.needsYou)).toEqual(answers);
    const allSession = await s.request("GET", "/home/session", undefined, everyone);
    expect(allSession.status).toBe(200);
    expect(allSession.body.entries.map((entry) => entry.content)).toContain("Build selected repository");
    s.denyWrites();
    expect(await s.installation.answers(s.context, attention.needsYou)).toEqual({});
    expect((await s.installation.readThread(s.context, target.thread))?.canWrite).toBe(false);
    s.allowWrites();
    const focus = await s.request("POST", "/home/focus", { thread: target.thread }, everyone);
    expect(focus.status).toBe(200);
    const answerBody = {
      key: focus.body.submissionKey,
      revision: target.revision,
      destination: { kind: "thread", thread: target.thread },
      text: "Merge the reviewed pull request",
      context: [],
    };
    expect((await s.request("POST", "/home/send", answerBody, everyone)).status).toBe(200);
    await s.execute();
    const admittedAnswer = await s.coordinator.listEvents(
      { instanceId: privateUnit.instanceId, unit: privateUnit.unit },
      true,
    );
    expect(admittedAnswer).toMatchObject([
      { sender: "access:alice", text: "Merge the reviewed pull request", mode: "wake", seq: 1 },
    ]);
    expect(s.nudges).toEqual([{ id: s.created[0], type: `unit-nudge-${s.created[0]}-${privateUnit.unit}` }]);
    const answered = await homeService.snapshot(reader);
    expect(answered.needsYou).toEqual([]);
    expect(answered.waiting).toMatchObject([{ unit: { title: "Build the requested public repository change" } }]);
    expect(turns).toBe(3);
    expect(s.created).toHaveLength(1);
    expect(
      (await s.installation.readThread(s.context, target.thread))?.entries.map((entry) => entry.content),
    ).toContain("Merge the reviewed pull request");
    const legacy = await homeService.snapshot({ actorId: "access:alice", visibleTo: { kind: "all" } });
    expect(JSON.stringify(legacy)).not.toContain("Choose release behavior");
    expect(JSON.stringify(legacy)).not.toContain("Build the requested public repository change");
    expect((await s.installation.readThread(everyone, target.thread))?.entries.map((entry) => entry.content)).toContain(
      "Merge the reviewed pull request",
    );
    expect(
      await s.installation.readThread(
        { ...s.context, actor: { ...s.context.actor, viewingAs: { id: "access:bob" } } },
        target.thread,
      ),
    ).toBeUndefined();
    const foreign = {
      ...s.context,
      actor: { ...s.context.actor, id: "access:foreign", self: ["access:foreign"] },
      authentication: {
        ...s.context.authentication,
        identity: { ...identity, subject: "foreign" },
        sourceReference: {
          ...s.context.authentication.sourceReference!,
          actorId: "access:foreign",
          userId: "access:foreign",
        },
      },
    };
    const hidden = await homeService.snapshot({
      ...reader,
      actorId: "access:foreign",
      readPrivateUnit: (instance: CoordinatorInstance, row: CoordinatorUnit) =>
        s.installation.canReadPrivateUnit(foreign, instance, row),
    });
    expect(JSON.stringify(hidden)).not.toContain("Choose release behavior");
    expect(JSON.stringify(hidden)).not.toContain("Build the requested public repository change");
    expect(await s.installation.readThread(foreign, target.thread)).toBeUndefined();
    s.revoke();
    const revoked = await homeService.snapshot(reader);
    expect(JSON.stringify(revoked)).not.toContain("Choose release behavior");
    expect(JSON.stringify(revoked)).not.toContain("Build the requested public repository change");
    await expect(s.installation.readThread(s.context, target.thread)).rejects.toThrow(
      "Current source proof is unavailable.",
    );
    s.restoreSource();
    s.github.repos.delete("sample/web");
    const changed = (await s.request("GET", "/home/session")).body;
    const refused = await s.request("POST", "/home/send", { ...input, key: changed.submissionKey });
    expect(refused.status).toBe(404);
    expect(s.created).toHaveLength(1);
  });
  it("shows and answers a private Slack worker question only through the current proved browser recipient", async () => {
    let calls = 0;
    const provider: Provider = {
      name: "fixture",
      complete: async () => {
        calls++;
        return calls === 1
          ? {
              content: [
                {
                  type: "tool_use",
                  id: "private-start",
                  name: "work_start",
                  input: {
                    repo: "sample/api",
                    question: "Private native change",
                    schemaVersion: 1,
                    cause: { kind: "unknown", reason: "Not investigated" },
                    evidence: { availability: "unavailable", reason: "Code-only change" },
                    requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
                    findings: [],
                    acceptance: "A reviewed change",
                    requestedChange: "Build the private native change",
                    sourceMessage: "Private native change",
                  },
                },
              ],
              stopReason: "tool_use",
            }
          : { content: [{ type: "text", text: "Private work started" }], stopReason: "end_turn" };
      },
    };
    const s = await fixture(true, true, provider, true);
    const native = await s.installation.admitNative(
      {
        userId: "slack:UALICE",
        channelId: "slack:D1",
        threadKey: "slack:D1:1.0",
        messageId: "1.1",
        text: "Private native change",
      },
      { source: "slack", identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" } },
    );
    expect(native).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
    await s.execute();
    expect(s.created).toHaveLength(1);
    const stored = (await s.coordinator.listUnits(s.created[0]!))[0]!;
    const worker = privateWorkerThreadKey({ instanceId: stored.instanceId, unit: stored.unit });
    const gate = {
      ...unit.idle!.humanGate!,
      assignedTo: "slack:UALICE",
      primaryAction: { label: "Confirm", text: "confirm" },
      findings: [
        {
          id: "F1",
          severity: "minor" as const,
          file: "app.ts",
          title: "Choose private release",
          humanGated: true as const,
        },
      ],
    };
    expect(
      await s.coordinator.putUnits([{ ...stored, threadKey: worker, idle: { ...unit.idle!, humanGate: gate } }]),
    ).toEqual({ ok: true });
    const home = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const reader = {
      actorId: "access:alice",
      attentionRecipients: ["access:alice", "slack:UALICE"],
      visibleTo: { kind: "all" as const },
      readPrivateUnit: (instance: CoordinatorInstance, row: CoordinatorUnit) =>
        s.installation.canReadPrivateUnit(s.context, instance, row),
    };
    const mine = await home.snapshot(reader);
    expect(mine.needsYou).toMatchObject([
      {
        unit: { title: "Build the private native change", threads: { coding: worker } },
        conditions: [{ owner: { kind: "person", id: "slack:UALICE" } }],
      },
    ]);
    const answers = await s.installation.answers(s.context, mine.needsYou);
    expect(Object.values(answers)).toMatchObject([
      { thread: worker, primaryAction: { label: "Confirm", text: "confirm" } },
    ]);
    const focused = await s.request("POST", "/home/focus", { thread: worker });
    expect(focused.status).toBe(200);
    const answer = {
      key: focused.body.submissionKey,
      revision: Object.values(answers)[0]!.revision,
      destination: { kind: "thread", thread: worker },
      text: "confirm",
      context: [],
    };
    expect((await s.request("POST", "/home/send", answer)).status).toBe(200);
    await s.execute();
    expect(await s.coordinator.listEvents({ instanceId: stored.instanceId, unit: stored.unit }, true)).toMatchObject([
      { sender: "slack:UALICE", authenticatedAs: "access:alice", text: "confirm", mode: "wake" },
    ]);
    expect(s.nudges).toEqual([{ id: s.created[0], type: `unit-nudge-${s.created[0]}-${stored.unit}` }]);
    expect(calls).toBe(2);
    expect(s.created).toHaveLength(1);
    s.setPolicy();
    expect((await home.snapshot(reader)).needsYou).toEqual([]);
    expect(await s.installation.readThread(s.context, worker)).toBeUndefined();
  });
  it("bounds simultaneous merge reads across refreshes and advances the next owned units after slots clear", async () => {
    const s = await fixture(false, false, undefined, false, false, false, 2);
    await s.seedQuestion();
    const { idle: _question, ...base } = unit;
    for (let i = 1; i <= 4; i++) {
      const pr = { number: i, url: `https://github.com/sample/api/pull/${i}` };
      seedCoordinatorUnit(s.coordinator, {
        ...base,
        unit: `task-${i}`,
        slug: `u${i}`,
        pr,
        lastPush: "a".repeat(40),
        ending: { kind: "merge_ready", report: `Reviewed ${i}.`, at: 900 },
        mergeAttention: { assignedTo: "access:alice", pr, headSha: "a".repeat(40), at: 900 },
      });
    }
    const home = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const reader = { actorId: "access:alice", visibleTo: { kind: "all" as const } };
    const rows = (await home.snapshot(reader)).needsYou.filter((row) => row.unit.id.startsWith("task-"));
    const blocked: Array<{ pr: number; release: () => void }> = [];
    s.setMergeRead(
      async (_context, _instance, row) =>
        new Promise((resolve) =>
          blocked.push({
            pr: row.pr!.number,
            release: () => resolve({ headSha: "a".repeat(40), mergeCommitSha: "b".repeat(40), mergedAt: 1000 }),
          }),
        ),
    );
    s.installation.queueMergeObservations(s.context, rows);
    const first = s.tasks.splice(0).map((task) => task());
    await vi.waitFor(() => expect(blocked.map((row) => row.pr)).toEqual([1, 2]));
    s.installation.queueMergeObservations(s.context, rows);
    s.installation.queueMergeObservations(s.context, rows);
    expect(s.tasks).toEqual([]);
    expect(await s.installation.observeMerge(s.context, "fixture:task-3")).toBe("held");
    expect(blocked.map((row) => row.pr)).toEqual([1, 2]);
    blocked.forEach((row) => row.release());
    await Promise.all(first);
    expect((await home.history(reader)).units.map((row) => row.unit.id)).toEqual(["task-1", "task-2"]);
    const foreground = s.installation.observeMerge(s.context, "fixture:task-3");
    await vi.waitFor(() => expect(blocked.map((row) => row.pr)).toEqual([1, 2, 3]));
    expect(await s.installation.observeMerge(s.context, "fixture:task-3")).toBe("held");
    s.installation.queueMergeObservations(s.context, rows);
    const second = s.tasks.splice(0).map((task) => task());
    expect(second).toHaveLength(1);
    await vi.waitFor(() => expect(blocked.map((row) => row.pr)).toEqual([1, 2, 3, 4]));
    blocked.slice(2).forEach((row) => row.release());
    expect(await foreground).toBe("observed");
    await Promise.all(second);
    expect((await home.history(reader)).units.map((row) => row.unit.id)).toEqual([
      "task-1",
      "task-2",
      "task-3",
      "task-4",
    ]);
  });
  it("observes a manual merge with no watch or live driver and holds changed, revoked or raced source proof", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const { idle: _question, ...base } = unit;
    const ready: CoordinatorUnit = {
      ...base,
      pr: unit.idle!.humanGate!.pr,
      lastPush: "a".repeat(40),
      ending: { kind: "merge_ready", report: "Original review report.", at: 900 },
      mergeAttention: { assignedTo: "access:alice", pr: unit.idle!.humanGate!.pr, headSha: "a".repeat(40), at: 900 },
    };
    seedCoordinatorUnit(s.coordinator, ready);
    const home = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const reader = { actorId: "access:alice", visibleTo: { kind: "all" as const } };
    expect((await home.snapshot(reader)).needsYou.map((row) => row.unit.unit)).toEqual(["fixture:original"]);
    const merged = { headSha: "a".repeat(40), mergeCommitSha: "b".repeat(40), mergedAt: 899 };
    s.setMergeRead(async () => ({ ...merged, headSha: "c".repeat(40) }));
    expect(await s.installation.observeMerge(s.context, "fixture:original")).toBe("held");
    s.setMergeRead(async () => {
      s.revoke();
      return merged;
    });
    expect(await s.installation.observeMerge(s.context, "fixture:original")).toBe("held");
    s.restoreSource();
    s.setMergeRead(async () => {
      seedCoordinatorUnit(s.coordinator, { ...ready, title: "A concurrent record change" });
      return merged;
    });
    expect(await s.installation.observeMerge(s.context, "fixture:original")).toBe("held");
    expect((await home.history(reader)).units).toEqual([]);
    seedCoordinatorUnit(s.coordinator, ready);
    s.setMergeRead(async () => merged);
    const attention = await home.snapshot(reader);
    s.installation.queueMergeObservations(s.context, attention.needsYou);
    expect((await home.snapshot(reader)).needsYou).toHaveLength(1);
    expect(s.tasks).toHaveLength(1);
    await s.execute();
    expect((await home.snapshot(reader)).needsYou).toEqual([]);
    expect((await home.history(reader)).units[0]?.unit).toMatchObject({
      mergeCompletion: { at: 899, sha: "b".repeat(40) },
      ending: { kind: "merge_ready", report: "Original review report.", at: 900 },
    });
    expect(await s.installation.observeMerge(s.context, "fixture:original")).toBe("unchanged");
    expect(s.created).toEqual([]);
    expect(s.nudges).toEqual([]);
  });
  it("projects a hundred owned merge actions from one current canonical pipeline read", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const { idle: _question, ...base } = unit;
    for (let i = 1; i <= 100; i++) {
      const pr = { number: i, url: `https://github.com/sample/api/pull/${i}` };
      seedCoordinatorUnit(s.coordinator, {
        ...base,
        unit: `task-${i}`,
        slug: `task-${i}`,
        pr,
        lastPush: "a".repeat(40),
        ending: { kind: "merge_ready", report: "Review completed.", at: 900 },
        mergeAttention: { assignedTo: "access:alice", pr, headSha: "a".repeat(40), at: 900 },
      });
    }
    const home = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const snapshot = await home.snapshot({ actorId: "access:alice", visibleTo: { kind: "all" } });
    const reads = vi.spyOn(s.coordinator, "listUnits");
    const actions = await s.installation.mergeActions(s.context, snapshot.needsYou);
    expect(Object.keys(actions)).toHaveLength(100);
    expect(actions["fixture:task-1"]).toEqual({ kind: "merge", pr: "sample/api#1", head: "a".repeat(40) });
    expect(actions["fixture:task-100"]).toEqual({ kind: "merge", pr: "sample/api#100", head: "a".repeat(40) });
    expect(reads).toHaveBeenCalledTimes(1);
  });
  it("offers a merge command only to the current saved recipient with their own grants in Mine or All", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const { idle: _question, ...base } = unit;
    const ready: CoordinatorUnit = {
      ...base,
      pr: unit.idle!.humanGate!.pr,
      lastPush: "a".repeat(40),
      ending: { kind: "merge_ready", report: "Ready.", at: 1000 },
      mergeAttention: { assignedTo: "access:alice", pr: unit.idle!.humanGate!.pr, headSha: "a".repeat(40), at: 1000 },
    };
    seedCoordinatorUnit(s.coordinator, ready);
    const home = createHomeService({
      organizationId: "fixture",
      instances: s.coordinator,
      conditions: createHomeConditionReader(s.coordinator),
    });
    const snapshot = await home.snapshot({ actorId: "access:alice", visibleTo: { kind: "all" } });
    expect(await s.installation.mergeActions(s.context, snapshot.needsYou)).toEqual({
      "fixture:original": { kind: "merge", pr: "sample/api#42", head: "a".repeat(40) },
    });
    withWorkViewScope(
      s.context.actor,
      resolveWorkViewScope(s.context.actor, { organization: "fixture", mode: "everyone" }),
    );
    expect(await s.installation.mergeActions(s.context, snapshot.needsYou)).toHaveProperty("fixture:original");
    expect(
      await s.installation.mergeActions(
        { ...s.context, actor: { ...s.context.actor, viewingAs: { id: "access:bob" } } },
        snapshot.needsYou,
      ),
    ).toEqual({});
    seedCoordinatorUnit(s.coordinator, {
      ...ready,
      mergeAttention: { ...ready.mergeAttention!, assignedTo: "access:bob" },
    });
    expect(await s.installation.mergeActions(s.context, snapshot.needsYou)).toEqual({});
    seedCoordinatorUnit(s.coordinator, ready);
    s.denyNativeReads();
    expect(await s.installation.mergeActions(s.context, snapshot.needsYou)).toEqual({});
    s.restoreSource();
    s.revoke();
    expect(await s.installation.mergeActions(s.context, snapshot.needsYou)).toEqual({});
  });
  it("projects only a recorded canonical question action and keeps generic approved questions labeled Confirm", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const generic = await s.installation.readThread(s.context, s.targetThread);
    expect(generic?.primaryAction).toEqual({ label: "Confirm", text: "confirm" });
    seedCoordinatorUnit(s.coordinator, {
      ...unit,
      idle: {
        ...unit.idle!,
        humanGate: { ...unit.idle!.humanGate!, primaryAction: { label: "Merge", text: "merge" } },
      },
    });
    const recorded = await s.installation.readThread(s.context, s.targetThread);
    expect(recorded?.primaryAction).toEqual({ label: "Merge", text: "merge" });
    expect(recorded?.revision).not.toBe(generic?.revision);
    expect(recorded?.target?.key).not.toBe(generic?.target?.key);
    const rows = [
      {
        unit: {
          unit: "fixture:original",
          instanceId: "fixture",
          id: "original",
          branch: "codex/fixture",
          threads: { coding: s.targetThread },
          sourceUrls: {},
          rounds: [],
        },
        instance: { id: "fixture", repo: "sample/api", createdAt: 1000 },
        conditions: [],
        nextAction: { kind: "recorded" as const, text: "Answer the recorded question" },
      },
    ];
    expect(await s.installation.answers(s.context, rows)).toMatchObject({
      "fixture:original": {
        thread: s.targetThread,
        revision: recorded!.revision,
        primaryAction: { label: "Merge", text: "merge" },
      },
    });
  });
  it("admits a browser-approved native saved proposal under a distinct choice owner and replays it after the saved row is consumed", async () => {
    const s = await fixture();
    const admit = (
      msg: import("../core/types.js").IncomingMessage,
      _io: import("../core/types.js").ChannelIO,
      evidence: import("./organizationAuthentication.js").OrganizationNativeEvidence,
      choice?: import("../core/organization/service.js").OrganizationAdmissionInput["continuation"],
    ) => s.installation.admitNative(msg, evidence, choice);
    const options = {
      auth: { tokens: s.tokens },
      personalTokens: s.personalTokens,
      admit,
      replayChoice: s.installation.replayNativeChoice,
      approvalsEnabled: true,
      publicBaseUrl: "https://fixture.test",
    };
    const rpc = (name: string, args: unknown) =>
      handleMcpRequest(
        {
          method: "POST",
          headers: { authorization: `Bearer ${"c".repeat(64)}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        },
        s.core,
        options,
      );
    const first = await rpc("dispatch", { text: "memory forget", idempotencyKey: "original-offer" });
    expect(first.body).toMatchObject({
      result: { structuredContent: { admission: { status: "accepted", runId: expect.any(String) } } },
    });
    await s.execute();
    const firstId = (first.body as { result: { structuredContent: { admission: { runId: string } } } }).result
      .structuredContent.admission.runId;
    const original = await s.installation.originalBinding(firstId);
    if (!original) throw new Error("No completed native offer owner");
    const id = "00000000-0000-4000-8000-000000000011";
    const row = await s.confirmations.put(
      {
        kind: "redispatch",
        id,
        message: { ...original.msg, text: "memory forget" },
        line: "memory forget",
        evidence: "Explicit saved fixture action",
        code: "fixture",
      },
      DAY_MS,
    );
    expect(row.originalOrganization?.ingressRunId).toBe(firstId);
    const view = createMcpApprovalView(s.core, {
      ...options,
      resolveApprovalSource: (_identity, row) => s.installation.approvalSource(row, s.context.actor),
    });
    const req = Readable.from(["action=approve"]) as IncomingMessage;
    Object.assign(req, {
      method: "POST",
      url: `/settings/approve?id=${id}`,
      headers: {
        host: "fixture.test",
        origin: "https://fixture.test",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    let approvalStatus = 0,
      approvalBody = "";
    const res = {
      writeHead(status: number) {
        approvalStatus = status;
      },
      end(body: string) {
        approvalBody = body;
      },
    } as unknown as ServerResponse;
    expect(view(req, res, { sub: "alice", email: "changed-display@example.test" })).toBe(true);
    for (let i = 0; i < 100 && !approvalBody; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approvalStatus).toBe(200);
    expect(approvalBody).toContain("Approved. Return to your MCP client");
    expect((await s.confirmations.get(id))?.browserApproved).toBe(true);
    const choice = await rpc("approval_resume", { id });
    expect(choice.body).toMatchObject({
      result: { structuredContent: { admission: { status: "accepted", runId: expect.any(String) } } },
    });
    const secondId = (choice.body as { result: { structuredContent: { admission: { runId: string } } } }).result
      .structuredContent.admission.runId;
    expect(secondId).not.toBe(firstId);
    await s.execute();
    expect(await s.ledger.readIngressByRun(secondId)).toMatchObject({
      status: "record",
      record: { status: "completed" },
    });
    expect(s.effects).toEqual(["mcp:personal:alice", "mcp:personal:alice"]);
    expect(s.registry.getById(firstId)?.status).toBe("completed");
    expect(s.registry.getById(secondId)?.status).toBe("completed");
    const replayed = await rpc("approval_resume", { id });
    expect(replayed.body).toMatchObject({
      result: { structuredContent: { admission: { status: "accepted", duplicate: true, runId: secondId } } },
    });
    expect(s.effects).toEqual(["mcp:personal:alice", "mcp:personal:alice"]);
    await s.personalTokens.delete(digestBearer("c".repeat(64)), "personal:alice");
    expect((await rpc("approval_resume", { id })).status).toBe(401);
  });
  it("rehosts an uncertain service input with its original owner and only proved source-owned machine history", async () => {
    const s = await fixture();
    const admit = (
      msg: import("../core/types.js").IncomingMessage,
      _io: import("../core/types.js").ChannelIO,
      evidence: import("./organizationAuthentication.js").OrganizationNativeEvidence,
    ) => s.installation.admitNative(msg, evidence);
    const send = (key: string) =>
      handleIngressRequest(
        {
          method: "POST",
          headers: { authorization: "Bearer native-token" },
          body: JSON.stringify({ text: "memory forget", idempotencyKey: key }),
        },
        s.core,
        { auth: { tokens: s.tokens }, admit },
      );
    expect((await send("first-machine")).status).toBe(202);
    await s.execute();
    const foreign: RunRecord = {
      id: "foreign-human",
      label: "Private human",
      channelId: "http:ops",
      threadKey: "http:ops:default",
      userId: "access:alice",
      channelVisibility: "unknown",
      agent: "general",
      startedAt: 900,
      finishedAt: 901,
      status: "completed",
      eventCount: 2,
      storedEventCount: 2,
      truncated: false,
      diagnosis: analyzeRunFriction([]),
      events: [
        { type: "input", text: "Private human history", messageId: "foreign-human", seq: 1 },
        { type: "answer", text: "Private human answer", seq: 2 },
      ],
    };
    expect((await s.runStore.put(foreign)).stored).toBe(true);
    const second = await send("second-machine");
    expect(second.status).toBe(202);
    const id = (second.body as { runId: string }).runId;
    const binding = await s.installation.originalBinding(id);
    expect(binding).toMatchObject({
      originalStatus: "dispatching",
      actor: { id: "http:bot", kind: "service" },
      envelope: { actor: { stream: null } },
      msg: { text: "memory forget", userId: "http:bot" },
    });
    if (!binding) throw new Error("No original service binding");
    expect(await binding.io.rehostOrganizationInput!(binding.msg)).toBeUndefined();
    await s.ledger.finishIngress({
      effectKey: binding.receipt.effectKey!,
      digest: binding.envelope.digest,
      runId: id,
      status: "uncertain",
      outcome: "The original owner returned this unread input.",
    });
    // The original scheduled invocation handed back the input; it cannot run in parallel.
    s.tasks.shift();
    const owned = await binding.io.rehostOrganizationInput!(binding.msg);
    expect(owned?.msg).toMatchObject({ text: "memory forget", userId: "http:bot", threadKey: "http:ops:default" });
    if (!owned) throw new Error("No original unread machine input");
    const history = await owned.io.authoritativePrivateHistory!(owned.msg);
    expect(history).toMatchObject([
      { role: "user", text: "memory forget" },
      { role: "assistant", text: "Read-only command completed." },
    ]);
    expect(history).toHaveLength(2);
    await dispatch(s.core, owned.msg, owned.io, {
      ingressRunId: id,
      organizationSequence: binding.receipt.revision,
      authoritativeHistory: true,
      organizationConversation: true,
      seed: history,
    });
    expect(s.effects).toEqual(["http:bot", "http:bot"]);
    expect(s.registry.getById(id)?.status).toBe("completed");
    const forged = withOriginalOrganizationDispatch(
      { ...owned.msg, text: "Changed unread bytes" },
      { ingressRunId: id, organizationSequence: binding.receipt.revision },
    );
    expect(await owned.io.rehostOrganizationInput!(forged)).toBeUndefined();
    s.expire();
    expect(await s.installation.originalBinding(id)).toBeUndefined();
    expect(s.effects).toEqual(["http:bot", "http:bot"]);
  });
  it.each(["retained", "deleted", "revoked"] as const)(
    "executes a saved private code proposal once under choice B with fresh source A (%s)",
    async (state) => {
      const requests: import("../core/provider.js").CompletionRequest[] = [];
      let original = true;
      const provider: Provider = {
        name: "fixture",
        complete: async (request) => {
          requests.push(structuredClone(request));
          if (original) {
            original = false;
            return { content: [{ type: "text", text: "Original source A answer." }], stopReason: "end_turn" };
          }
          return requests.length === 1
            ? {
                content: [
                  {
                    type: "tool_use",
                    id: "start-saved-choice",
                    name: "work_start",
                    input: {
                      repo: "sample/api",
                      question: "Build selected repository",
                      schemaVersion: 1,
                      cause: { kind: "unknown", reason: "Not investigated" },
                      evidence: { availability: "unavailable", reason: "Code-only change" },
                      requirements: { analysis: "not_required", evidence: "may_be_unavailable" },
                      acceptance: "A reviewed change",
                      findings: [],
                      requestedChange: "Build the requested public repository change",
                      sourceMessage: "Build selected repository",
                    },
                  },
                ],
                stopReason: "tool_use",
              }
            : { content: [{ type: "text", text: "Saved choice B work started." }], stopReason: "end_turn" };
        },
      };
      const s = await fixture(false, false, provider);
      const home = (await s.request("GET", "/home/session")).body;
      const inputA = {
        key: home.submissionKey,
        revision: home.destination.revision,
        destination: { kind: "broad" as const },
        text: "agent:general Record the original source",
        context: [{ kind: "repository" as const, key: "sample/api" }],
      };
      expect((await s.request("POST", "/home/send", inputA)).status).toBe(200);
      await s.execute();
      requests.length = 0;
      const replayA = await s.installation.organization.replay(s.context.authentication, {
        key: inputA.key,
        revision: inputA.revision,
        destination: inputA.destination,
        content: inputA.text,
        context: inputA.context,
      });
      if (replayA?.status !== "receipt" || !replayA.receipt.ownerRunId) throw new Error("No original source A");
      const sourceA = await s.installation.originalBinding(replayA.receipt.ownerRunId);
      if (!sourceA) throw new Error("No current source A");
      expect(await sourceA.io.authoritativePrivateSourceHistory?.(sourceA.runId)).toEqual([
        { role: "user", text: "agent:general Record the original source", user: "access:alice" },
      ]);
      expect(await sourceA.io.authoritativePrivateSourceHistory?.("foreign-source")).toBeUndefined();
      const id = "00000000-0000-4000-8000-000000000022";
      await s.confirmations.put(
        {
          kind: "redispatch",
          id,
          message: { ...sourceA.msg, text: "Build selected repository" },
          line: "Build selected repository",
          evidence: "Explicit code proposal",
          code: "fixture",
        },
        DAY_MS,
      );
      const next = (await s.request("GET", "/home/session")).body;
      const inputB = {
        key: next.submissionKey,
        revision: next.destination.revision,
        destination: { kind: "broad" as const },
        confirmation: { kind: "confirm" as const, id },
        context: [],
      };
      expect((await s.request("POST", "/home/send", inputB)).status).toBe(200);
      const replayB = await s.installation.organization.replay(s.context.authentication, {
        key: inputB.key,
        revision: inputB.revision,
        destination: inputB.destination,
        continuation: inputB.confirmation,
        content: "",
        context: inputB.context,
      });
      if (replayB?.status !== "receipt" || !replayB.receipt.ownerRunId) throw new Error("No original choice B");
      if (state === "deleted")
        expect((await s.installation.runtime.deleteContent(s.context.authentication, replayA.receipt.id)).status).toBe(
          "ok",
        );
      if (state === "revoked") s.setPolicy();
      await s.execute();
      if (state !== "retained") {
        expect(s.created).toEqual([]);
        expect(requests).toEqual([]);
        expect((await s.confirmations.get(id))?.id).toBe(id);
        return;
      }
      expect(s.created).toHaveLength(1);
      const spawned = await s.coordinator.get(s.created[0]!);
      const units = await s.coordinator.listUnits(s.created[0]!);
      expect(spawned).toMatchObject({ userId: "access:alice", repo: "sample/api" });
      expect(units[0]).toMatchObject({
        workBrief: {
          requesterId: "access:alice",
        },
        context: { handoff: { source: { runId: replayB.receipt.ownerRunId } } },
      });
      const linked = await s.coordinator.getMainTask({
        mainThreadKey: units[0]!.workBrief!.mainThreadKey,
        actId: units[0]!.workBrief!.actId,
      });
      expect(linked?.authority?.sourceMessageId).toBe(`browser:${replayB.receipt.revision}:browser%3A${inputB.key}`);
      expect(JSON.stringify(requests[0].messages)).toContain("Record the original source");
      expect(JSON.stringify(requests[0].messages)).toContain("Build selected repository");
      expect(JSON.stringify(requests)).not.toContain("Untrusted raw source history");
      const originalB = await s.ledger.readIngressByRun(replayB.receipt.ownerRunId);
      expect(originalB).toMatchObject({
        status: "record",
        record: {
          runId: replayB.receipt.ownerRunId,
          origin: { sourceReference: { messageId: `browser:${inputB.key}`, actorId: "access:alice" } },
        },
      });
      expect(s.registry.snapshotById(replayB.receipt.ownerRunId)).toMatchObject({
        organizationIngressRunId: replayB.receipt.ownerRunId,
        authoritativeHistory: true,
      });
      expect(s.registry.getById(replayB.receipt.ownerRunId)?.userId).toBe("access:alice");
      const stream = await s.installation.organization.streamTail(s.context.authentication, 100);
      if (stream.status !== "stream_tail") throw new Error("No private output");
      expect(
        stream.entries
          .filter((entry) => entry.content.includes("Saved choice B work started."))
          .map((entry) => entry.receiptId),
      ).toEqual([replayB.receipt.id]);
      expect((await s.request("POST", "/home/send", inputB)).body.duplicate).toBe(true);
      expect(s.created).toEqual([s.created[0]]);
      expect(await s.confirmations.get(id)).toBeUndefined();
    },
  );
  it("keeps saved source A context separate from choice B receipt and exact execution owner", async () => {
    const s = await fixture(false, false, {
      name: "fixture",
      complete: async () => ({
        content: [{ type: "text", text: "Original source A answer." }],
        stopReason: "end_turn",
      }),
    });
    const home = (await s.request("GET", "/home/session")).body;
    const inputA = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" as const },
      text: "agent:general Record the original source",
      context: [],
    };
    expect((await s.request("POST", "/home/send", inputA)).status).toBe(200);
    await s.execute();
    const replayA = await s.installation.organization.replay(s.context.authentication, {
      ...inputA,
      content: inputA.text,
    });
    if (replayA?.status !== "receipt" || !replayA.receipt.ownerRunId) throw new Error("No offer source owner");
    const sourceA = await s.installation.originalBinding(replayA.receipt.ownerRunId);
    if (!sourceA) throw new Error("No source A");
    const id = "00000000-0000-4000-8000-000000000021";
    await s.confirmations.put(
      {
        kind: "run",
        id,
        message: sourceA.msg,
        command: "memory.forget",
        input: { args: [], options: {} },
        receipt: "Run saved source action",
        risk: "No external effect",
        model: "fixture/unused",
      },
      DAY_MS,
    );
    const next = (await s.request("GET", "/home/session")).body;
    const inputB = {
      key: next.submissionKey,
      revision: next.destination.revision,
      destination: { kind: "broad" as const },
      confirmation: { kind: "confirm" as const, id },
      context: [],
    };
    expect((await s.request("POST", "/home/send", inputB)).status).toBe(200);
    const replayB = await s.installation.organization.replay(s.context.authentication, {
      key: inputB.key,
      revision: inputB.revision,
      destination: inputB.destination,
      continuation: inputB.confirmation,
      content: "",
      context: [],
    });
    if (replayB?.status !== "receipt" || !replayB.receipt.ownerRunId) throw new Error("No choice B owner");
    await s.execute();
    const stream = await s.installation.organization.streamTail(s.context.authentication, 100);
    if (stream.status !== "stream_tail") throw new Error("No current private stream");
    expect(
      stream.entries
        .filter((entry) => entry.role === "assistant" && entry.content.includes("Read-only command completed."))
        .map((entry) => entry.receiptId),
    ).toEqual([replayB.receipt.id]);
    expect(s.registry.getById(replayB.receipt.ownerRunId)?.status).toBe("completed");
    expect(await s.ledger.readIngressByRun(replayB.receipt.ownerRunId)).toMatchObject({
      status: "record",
      record: { status: "completed", origin: { continuation: { kind: "confirm", id } } },
    });
    expect((await s.request("POST", "/home/send", inputB)).body.duplicate).toBe(true);
    expect(s.effects).toEqual(["access:alice"]);
  });
  it("restores a completed offer source without restarting it and fences its exact saved choice before consume when source policy changes", async () => {
    const s = await fixture();
    const home = (await s.request("GET", "/home/session")).body;
    const text = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" as const },
      text: "memory forget",
      context: [],
    };
    await s.request("POST", "/home/send", text);
    await s.execute();
    const receipt = await s.installation.organization.replay(s.context.authentication, {
      key: text.key,
      revision: text.revision,
      destination: text.destination,
      content: text.text,
      context: [],
    });
    if (receipt?.status !== "receipt") throw new Error("No original completed owner");
    const binding = await s.installation.originalBinding(receipt.receipt.ownerRunId!);
    expect(binding).toMatchObject({
      originalStatus: "completed",
      msg: { text: "memory forget", userId: "access:alice" },
      runId: receipt.receipt.ownerRunId,
    });
    if (!binding) throw new Error("No completed source binding");
    const put = (id: string) =>
      s.confirmations.put(
        {
          kind: "run",
          id,
          message: { ...binding.msg, text: "Saved proposal differs from the original phrase" },
          command: "memory.forget",
          input: { args: [], options: {} },
          receipt: "Run the exact saved fixture action",
          risk: "No external effect",
          model: "fixture/unused",
          derivation: {
            kind: "operator",
            context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
          },
        },
        DAY_MS,
      );
    const id = "00000000-0000-4000-8000-000000000009";
    const saved = await put(id);
    expect((await s.request("GET", "/home/session")).body.offer?.id).toBe(id);
    expect((await s.installation.readThread(s.context, binding.msg.threadKey))?.offer?.id).toBe(id);
    expect(saved.originalOrganization).toMatchObject({
      ingressRunId: binding.runId,
      organizationSequence: binding.receipt.revision,
    });
    const foreign = { ...binding.actor, id: "access:other" };
    expect(await s.installation.guardOrganizationConfirmation(saved, foreign)).toBeUndefined();
    const proof = await s.installation.guardOrganizationConfirmation(saved, binding.actor);
    expect(proof?.actor.id).toBe("access:alice");
    expect(await proof!.io.authoritativePrivateHistory!()).toEqual([]);
    const visible: string[] = [];
    const io = {
      reply: async (text: string) => {
        visible.push(text);
      },
      history: async () => [],
      status: async () => ({ update() {}, done: async () => {} }),
    };
    await dispatchClick(s.core, { kind: "confirm", id, actor: binding.actor, io });
    expect(s.effects).toEqual(["access:alice", "access:alice"]);
    await dispatchClick(s.core, { kind: "confirm", id, actor: binding.actor, io });
    expect(s.effects).toEqual(["access:alice", "access:alice"]);
    const staleId = "00000000-0000-4000-8000-000000000010";
    await put(staleId);
    s.setPolicy();
    expect((await s.request("GET", "/home/session")).body.offer).toBeUndefined();
    expect((await s.installation.readThread(s.context, binding.msg.threadKey))?.offer).toBeUndefined();
    await dispatchClick(s.core, { kind: "confirm", id: staleId, actor: binding.actor, io });
    expect(s.effects).toEqual(["access:alice", "access:alice"]);
    expect((await s.confirmations.get(staleId))?.id).toBe(staleId);
    expect(await s.installation.originalBinding(binding.runId)).toBeUndefined();
    expect(s.registry.getById(binding.runId)?.status).toBe("completed");
  });
  it.each(["image", "text"] as const)(
    "executes a saved small %s proposal with A as its read source and distinct B as its model and output owner",
    async (kind) => {
      const input = await nativeImageInput("Describe the original file.");
      const document = { mediaType: "text/csv", name: "rows.csv", data: "id,total\n7,9" };
      if (kind === "text") {
        delete (input.msg as Partial<typeof input.msg>).images;
        Object.assign(input.msg, { documents: [document] });
        input.msg.nativeMedia.files[0] = {
          ...input.msg.nativeMedia.files[0]!,
          kind: "document",
          mediaType: document.mediaType,
          name: document.name,
          size: document.data.length,
          representationDigest: await nativeMediaDigest(document.data),
        };
        input.msg.nativeMediaDigest = await nativeMediaDigest(input.msg.nativeMedia);
      }
      const requests: import("../core/provider.js").CompletionRequest[] = [];
      const provider: Provider = {
        name: "fixture",
        complete: async (request) => {
          requests.push(request);
          const text = request.messages
            .at(-1)!
            .content.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: text.includes("Describe the saved file.")
                  ? "Saved media handled by choice B."
                  : text.includes("Describe the original file.")
                    ? "Original media handled by A."
                    : "Earlier result handled by C.",
              },
            ],
            stopReason: "end_turn",
          };
        },
      };
      const s = await fixture(true, true, provider, false, false, false, 10, false, async () =>
        kind === "image" ? { images: [input.image] } : { documents: [document] },
      );
      const a = await s.installation.admitNative(input.msg, input.evidence);
      expect(a).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      await s.execute();
      if (a.status !== "receipt" || !a.receipt.ownerRunId) throw new Error("No source A");
      const source = await s.installation.originalBinding(a.receipt.ownerRunId);
      if (!source) throw new Error("No original A binding");
      const id = "00000000-0000-4000-8000-000000000025";
      const proposal = "Describe the saved file.";
      await s.confirmations.put(
        {
          kind: "redispatch",
          id,
          message: { ...source.msg, text: proposal },
          line: proposal,
          evidence: "Original file",
          code: "saved_file_proposal",
        },
        DAY_MS,
      );
      const choice = {
        channelId: input.msg.channelId,
        userId: input.msg.userId,
        threadKey: input.msg.threadKey,
        messageId: "1000.95",
        text: `confirm ${id}`,
      };
      const b = await s.installation.admitNative(choice, input.evidence, { kind: "confirm", id });
      expect(b).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      if (b.status !== "receipt" || !b.receipt.ownerRunId) throw new Error("No choice B");
      expect(b.receipt.ownerRunId).not.toBe(a.receipt.ownerRunId);
      await s.execute();
      expect(s.nativeReplies.at(-1)).toBe("Saved media handled by choice B.");
      const parts = requests.at(-1)!.messages.at(-1)!.content;
      if (kind === "image")
        expect(parts.find((part) => part.type === "image")).toEqual({
          type: "image",
          mediaType: "image/png",
          data: "AAA=",
        });
      else
        expect(
          parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ).toContain("id,total\n7,9");
      expect(
        parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ).toContain(proposal);
      expect(await s.ledger.readIngressByRun(b.receipt.ownerRunId)).toMatchObject({
        status: "record",
        record: { status: "completed", origin: { continuation: { kind: "confirm", id } } },
      });
      expect(s.registry.getById(b.receipt.ownerRunId)?.status).toBe("completed");
      const closed = await s.core.runStore.get(b.receipt.ownerRunId);
      expect(closed?.contextDependencies?.version).toBe(3);
      expect(closed?.contextDependencies?.nativeMediaSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executionRunId: b.receipt.ownerRunId,
            reference: expect.objectContaining({
              kind: "confirmed",
              sourceRunId: a.receipt.ownerRunId,
              confirmationId: id,
            }),
          }),
          expect.objectContaining({
            executionRunId: a.receipt.ownerRunId,
            reference: expect.objectContaining({ kind: "original", sourceRunId: a.receipt.ownerRunId }),
          }),
        ]),
      );
      expect((await s.core.runLedger.readLiveRuns()).some((row) => row.runId === b.receipt.ownerRunId)).toBe(false);
      const c = await s.installation.admitNative(
        { ...choice, messageId: "1000.96", text: "Explain the earlier result." },
        input.evidence,
      );
      expect(c).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      if (c.status !== "receipt" || !c.receipt.ownerRunId) throw new Error("No reader C");
      const reader = await s.installation.originalBinding(c.receipt.ownerRunId);
      if (!reader) throw new Error("No current C proof");
      const access = contextAccessForMessage(s.core, { msg: reader.msg, io: reader.io });
      const inherited = await access.readRunDependencies(b.receipt.ownerRunId);
      expect(inherited?.version).toBe(3);
      expect(inherited?.nativeMediaSources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executionRunId: b.receipt.ownerRunId,
            reference: expect.objectContaining({ sourceRunId: a.receipt.ownerRunId }),
          }),
        ]),
      );
      const canonical = closed!.contextDependencies!;
      const leaf = canonical.nativeMediaSources!.find((leaf) => leaf.executionRunId === b.receipt.ownerRunId)!;
      expect(
        await access.validateDependencies({
          ...canonical,
          nativeMediaSources: [{ ...leaf, executionSequence: leaf.executionSequence + 1 }],
        }),
      ).toMatchObject({ ok: false });
      expect(
        await access.validateDependencies({
          ...canonical,
          nativeMediaSources: [{ ...leaf, reference: { ...leaf.reference, intentDigest: "c".repeat(64) } }],
        }),
      ).toMatchObject({ ok: false });
      const foreign = contextAccessForMessage(s.core, {
        msg: withChatActor(reader.msg, { ...reader.actor, id: "slack:UOTHER", self: [] }),
        io: reader.io,
      });
      expect(await foreign.readRunDependencies(b.receipt.ownerRunId)).toBeUndefined();
      const beforeHealthyC = requests.length;
      await s.execute();
      expect(requests).toHaveLength(beforeHealthyC + 1);
      expect(s.registry.getById(c.receipt.ownerRunId)?.status).toBe("completed");
      const read = s.core.runStore.get.bind(s.core.runStore);
      const pruned = vi
        .spyOn(s.core.runStore, "get")
        .mockImplementation(async (id) => (id === c.receipt.ownerRunId ? null : read(id)));
      const missingC = await s.installation.admitNative(
        { ...choice, messageId: "1000.99", text: "Explain the earlier result after its record was pruned." },
        input.evidence,
      );
      expect(missingC).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      const beforePruned = requests.length;
      await s.execute();
      expect(requests).toHaveLength(beforePruned);
      expect(s.ownerFailures.at(-1)).toMatchObject({
        runId: missingC.status === "receipt" ? missingC.receipt.ownerRunId : null,
        branch: "dispatch",
        failure: { stage: "execute", kind: "refused", code: "history_producer_unavailable" },
      });
      pruned.mockRestore();
      await s.ledger.clearIngressContent(a.receipt.effectKey!);
      expect(await access.readRunDependencies(b.receipt.ownerRunId)).toBeUndefined();
      const d = await s.installation.admitNative(
        { ...choice, messageId: "1000.98", text: "Explain the earlier result again." },
        input.evidence,
      );
      expect(d).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      const beforeC = requests.length;
      await s.execute();
      expect(requests).toHaveLength(beforeC);

      const count = requests.length;
      expect(await s.installation.admitNative(choice, input.evidence, { kind: "confirm", id })).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { ownerRunId: b.receipt.ownerRunId },
      });
      expect(requests).toHaveLength(count);
    },
  );
  it("holds saved proposal B before its first model prompt when source A is deleted during launch", async () => {
    const input = await nativeImageInput("Describe the original file.");
    const requests: import("../core/provider.js").CompletionRequest[] = [];
    const provider: Provider = {
      name: "fixture",
      complete: async (request) => {
        requests.push(request);
        return { content: [{ type: "text", text: "Must not consume deleted media." }], stopReason: "end_turn" };
      },
    };
    const s = await fixture(true, true, provider, false, false, false, 10, false, async () => ({
      images: [input.image],
    }));
    const a = await s.installation.admitNative(input.msg, input.evidence);
    expect(a).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
    await s.execute();
    if (a.status !== "receipt" || !a.receipt.ownerRunId) throw new Error("No A owner");
    const source = await s.installation.originalBinding(a.receipt.ownerRunId);
    if (!source) throw new Error("No source A");
    const id = "00000000-0000-4000-8000-000000000027";
    const proposal = "Describe the saved file.";
    await s.confirmations.put(
      {
        kind: "redispatch",
        id,
        message: { ...source.msg, text: proposal },
        line: proposal,
        evidence: "Original file",
        code: "saved_file_proposal",
      },
      DAY_MS,
    );
    const choice = {
      channelId: input.msg.channelId,
      userId: input.msg.userId,
      threadKey: input.msg.threadKey,
      messageId: "1000.97",
      text: `confirm ${id}`,
    };
    const b = await s.installation.admitNative(choice, input.evidence, { kind: "confirm", id });
    expect(b).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
    if (b.status !== "receipt" || !b.receipt.ownerRunId) throw new Error("No B owner");
    const open = PiHarness.prototype.open;
    const spy = vi.spyOn(PiHarness.prototype, "open").mockImplementation(function (this: PiHarness, deps, run) {
      const start = deps.container.start.bind(deps.container);
      deps.container.start = async (...args) => {
        const result = await start(...args);
        await s.ledger.clearIngressContent(a.receipt.effectKey!);
        return result;
      };
      return open.call(this, deps, run);
    });
    const beforeB = requests.length;
    try {
      await s.execute();
    } finally {
      spy.mockRestore();
    }
    expect(requests).toHaveLength(beforeB);
    expect(s.registry.getById(b.receipt.ownerRunId)?.status).toBe("failed");
    expect(await s.installation.originalBinding(a.receipt.ownerRunId)).toBeUndefined();
    expect(await s.installation.admitNative(choice, input.evidence, { kind: "confirm", id })).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { ownerRunId: b.receipt.ownerRunId },
    });
    expect(s.tasks).toEqual([]);
  });
  it("reads and cancels a saved native media action without redownloading source A, and rechecks A for typed execution", async () => {
    const input = await nativeImageInput();
    let downloads = 0;
    const s = await fixture(true, true, undefined, false, false, false, 10, false, async () => {
      downloads++;
      return { images: [input.image] };
    });
    const accepted = await s.installation.admitNative(input.msg, input.evidence);
    expect(accepted).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
    await s.execute();
    if (accepted.status !== "receipt" || !accepted.receipt.ownerRunId) throw new Error("No original source owner");
    const binding = await s.installation.originalBinding(accepted.receipt.ownerRunId);
    if (!binding) throw new Error("No original binding");
    const put = (id: string) =>
      s.confirmations.put(
        {
          kind: "run",
          id,
          message: binding.msg,
          command: "memory.forget",
          input: { args: [], options: {} },
          receipt: "Run saved action",
          risk: "Fixture only",
          model: "fixture/unused",
        },
        DAY_MS,
      );
    const canceled = await put("00000000-0000-4000-8000-000000000021");
    const beforeRead = downloads;
    expect((await s.installation.guardOrganizationConfirmation(canceled, binding.actor, "read"))?.actor.id).toBe(
      "slack:UALICE",
    );
    expect(downloads).toBe(beforeRead);
    await dispatchClick(s.core, { kind: "cancel", id: canceled.id, actor: binding.actor, io: binding.io });
    expect(s.nativeReplies.at(-1)).toBe("Cancelled; nothing ran");
    expect(downloads).toBe(beforeRead);
    expect(s.effects).toEqual(["slack:UALICE"]);
    expect(await s.confirmations.get(canceled.id)).toBeUndefined();
    const confirmed = await put("00000000-0000-4000-8000-000000000022");
    await dispatchClick(s.core, { kind: "confirm", id: confirmed.id, actor: binding.actor, io: binding.io });
    expect(s.effects).toEqual(["slack:UALICE", "slack:UALICE"]);
    expect(downloads).toBeGreaterThan(beforeRead);
    await dispatchClick(s.core, { kind: "confirm", id: confirmed.id, actor: binding.actor, io: binding.io });
    expect(s.effects).toEqual(["slack:UALICE", "slack:UALICE"]);
  });
  it.each(["deleted", "expired", "revoked", "changed representation"] as const)(
    "refuses delayed native media after source %s without executing or replacing the original owner",
    async (failure) => {
      const input = await nativeImageInput();
      let reads = 0;
      let changed = false;
      const s = await fixture(true, true, undefined, true, false, false, 10, false, async () => {
        reads++;
        return { images: [{ ...input.image, ...(changed ? { data: "AQI=" } : {}) }] };
      });
      const accepted = await s.installation.admitNative(input.msg, input.evidence);
      expect(accepted).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      if (accepted.status !== "receipt" || !accepted.receipt.ownerRunId) throw new Error("No original source owner");
      if (failure === "deleted") await s.ledger.clearIngressContent(accepted.receipt.effectKey!);
      else if (failure === "expired") s.expireSourceSnapshot();
      else if (failure === "revoked") s.revokeSlack();
      else changed = true;
      await s.execute();
      expect(s.effects).toEqual([]);
      const retained = await s.ledger.readIngressByRun(accepted.receipt.ownerRunId);
      expect(retained).toMatchObject({
        status: "record",
        record: {
          status: "completed",
          receiptId: accepted.receipt.id,
          outcome:
            failure === "deleted"
              ? "The original source snapshot is unavailable."
              : failure === "expired"
                ? "Access, retention or the original target changed."
                : "Current actor could not be verified.",
        },
      });
      expect(await s.installation.originalBinding(accepted.receipt.ownerRunId)).toBeUndefined();
      const beforeRetry = reads;
      const retry = await s.installation.admitNative(input.msg, input.evidence);
      if (failure !== "revoked")
        expect(retry).toMatchObject({
          status: "receipt",
          duplicate: true,
          receipt: { ownerRunId: accepted.receipt.ownerRunId },
        });
      expect(reads).toBe(beforeRetry);
      expect(s.created).toEqual([]);
    },
  );
  it.each(["image", "text"] as const)(
    "delivers the exact source-bound %s representation to the existing model owner",
    async (kind) => {
      const data = kind === "image" ? "a".repeat(3 * 1024 * 1024) : "row,7\n".repeat(1000);
      const asset = {
        mediaType: kind === "image" ? "image/png" : "text/csv",
        name: kind === "image" ? "screen.png" : "rows.csv",
        data,
      };
      const materialized = kind === "image" ? { images: [asset] } : { documents: [asset] };
      const requests: import("../core/provider.js").CompletionRequest[] = [];
      const provider: Provider = {
        name: "fixture",
        complete: async (request) => {
          requests.push(request);
          return { content: [{ type: "text", text: "Handled original media." }], stopReason: "end_turn" };
        },
      };
      const s = await fixture(true, true, provider, true, false, false, 10, false, async () => materialized);
      const text = "Describe the attached media.";
      const nativeMedia = {
        version: 1 as const,
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: "slack:D1:model-media",
        messageId: "1000.91",
        rawTextDigest: await nativeMediaDigest(text),
        sourceFilesDigest: await nativeMediaDigest("fixture-source-files"),
        files: [
          {
            id: "slack:file:FMODEL",
            kind: kind === "image" ? ("image" as const) : ("document" as const),
            index: 0,
            slot: 0,
            mediaType: asset.mediaType,
            name: asset.name,
            size: kind === "image" ? (data.length * 3) / 4 : data.length,
            representationDigest: await nativeMediaDigest(data),
          },
        ],
      };
      const accepted = await s.installation.admitNative(
        { ...nativeMedia, text, ...materialized, nativeMedia, nativeMediaDigest: await nativeMediaDigest(nativeMedia) },
        { source: "slack", identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" } },
      );
      expect(accepted).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      await s.execute();
      expect(s.nativeReplies).toEqual(["Handled original media."]);
      const parts = requests.flatMap((request) =>
        request.messages.filter((message) => message.role === "user").flatMap((message) => message.content),
      );
      if (kind === "image")
        expect(parts.find((part) => part.type === "image")).toEqual({ type: "image", mediaType: "image/png", data });
      else
        expect(
          parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .includes(data),
        ).toBe(true);
      if (accepted.status !== "receipt" || !accepted.receipt.ownerRunId) throw new Error("No owner");
      const owner = await s.ledger.readIngressByRun(accepted.receipt.ownerRunId);
      expect(owner).toMatchObject({ status: "record", record: { status: "completed" } });
      const record = await s.core.runStore.get(accepted.receipt.ownerRunId);
      expect(record?.contextDependencies).toMatchObject({
        version: 3,
        nativeMediaSources: [
          {
            executionRunId: accepted.receipt.ownerRunId,
            reference: {
              kind: "original",
              sourceRunId: accepted.receipt.ownerRunId,
              sourceSequence: accepted.receipt.revision,
            },
          },
        ],
      });
      const next = {
        channelId: nativeMedia.channelId,
        userId: nativeMedia.userId,
        threadKey: nativeMedia.threadKey,
        messageId: "1000.92",
        text: "Explain the earlier result.",
      };
      const evidence = {
        source: "slack" as const,
        identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
      };
      const c = await s.installation.admitNative(next, evidence);
      expect(c).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      const count = requests.length;
      await s.execute();
      expect(requests).toHaveLength(count + 1);
      const read = s.core.runStore.get.bind(s.core.runStore);
      const missing = vi
        .spyOn(s.core.runStore, "get")
        .mockImplementation(async (id) => (id === accepted.receipt.ownerRunId ? null : read(id)));
      const withheld = await s.installation.admitNative({ ...next, messageId: "1000.93" }, evidence);
      expect(withheld).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      const beforePruned = requests.length;
      await s.execute();
      expect(requests).toHaveLength(beforePruned);
      missing.mockRestore();
      if (kind === "image") await s.ledger.clearIngressContent(accepted.receipt.effectKey!);
      else s.expireSourceSnapshot();
      const d = await s.installation.admitNative({ ...next, messageId: "1000.94" }, evidence);
      expect(d).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
      const beforeLoss = requests.length;
      await s.execute();
      expect(requests).toHaveLength(beforeLoss);
      s.revokeSlack();
      expect(await s.installation.originalBinding(accepted.receipt.ownerRunId)).toBeUndefined();
      expect(await s.installation.admitNative({ ...next, messageId: "1000.96" }, evidence)).toMatchObject({
        status: "fenced",
      });
      expect(requests).toHaveLength(beforeLoss);
      expect(s.tasks).toEqual([]);
    },
  );
  it("admits a source-bound image larger than the retained request ceiling without storing its bytes and retries only its receipt", async () => {
    const image = { mediaType: "image/png", data: "a".repeat(3 * 1024 * 1024), name: "screen.png" };
    let reads = 0;
    const s = await fixture(true, true, undefined, false, false, false, 10, false, async () => {
      reads++;
      return { images: [image] };
    });
    const nativeMedia = {
      version: 1 as const,
      channelId: "slack:D1",
      userId: "slack:UALICE",
      threadKey: "slack:D1:media",
      messageId: "1000.9",
      rawTextDigest: await nativeMediaDigest("memory forget"),
      sourceFilesDigest: await nativeMediaDigest("fixture-source-files"),
      files: [
        {
          id: "slack:file:FIMAGE",
          slot: 0,
          index: 0,
          kind: "image" as const,
          mediaType: "image/png",
          name: "screen.png",
          size: ((3 * 1024 * 1024) / 4) * 3,
          representationDigest: await nativeMediaDigest(image.data),
        },
      ],
    };
    const digest = await nativeMediaDigest(nativeMedia);
    const msg = { ...nativeMedia, text: "memory forget", images: [image], nativeMedia, nativeMediaDigest: digest };
    const evidence = {
      source: "slack" as const,
      identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
    };
    const accepted = await s.installation.admitNative(msg, evidence);
    expect(accepted).toMatchObject({ status: "receipt", receipt: { status: "accepted" } });
    await s.execute();
    if (accepted.status !== "receipt" || !accepted.receipt.ownerRunId) throw new Error("Missing original owner");
    const original = await s.ledger.readIngressByRun(accepted.receipt.ownerRunId);
    expect(original.status).toBe("record");
    if (original.status !== "record") throw new Error("Missing source snapshot");
    expect(JSON.stringify(original.record.request).length).toBeLessThan(10000);
    expect(original.record.origin?.nativeMedia).toBeUndefined();
    expect(original.record.origin?.nativeMediaDigest).toBe(digest);
    const binding = await s.installation.originalBinding(accepted.receipt.ownerRunId);
    expect(binding?.msg.images).toEqual([image]);
    const readsBeforeRetry = reads;
    expect(await s.installation.admitNative(msg, evidence)).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { ownerRunId: accepted.receipt.ownerRunId },
    });
    expect(reads).toBe(readsBeforeRetry);
    expect(s.effects).toEqual(["slack:UALICE"]);
  });
  it.each(["unit", "child"] as const)(
    "keeps an existing %s DM destination and addressed output out of the broad stream across exact retries",
    async (kind) => {
      const s = await fixture(true, true);
      const localThread = kind === "unit" ? s.targetThread : "slack:D1:child";
      await s.seedQuestion({ threadKey: localThread });
      const msg = {
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: localThread,
        messageId: "1000.5",
        text: "memory forget",
        threadReply: true,
      };
      const evidence = {
        source: "slack" as const,
        identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
      };
      const admitted = await s.installation.admitNative(msg, evidence);
      expect(admitted.status).toBe("receipt");
      const resolved = await s.authentication.resolveNative(msg, evidence);
      if (resolved.status !== "resolved") throw new Error("No source proof");
      const addressed = await s.installation.organization.resolve(resolved.authentication);
      if (!addressed) throw new Error("No organization");
      const saved = await s.store.execute({
        action: "submission",
        ...addressed,
        source: "slack",
        key: "slack:D1:1000.5",
      });
      expect(saved).toMatchObject({
        status: "submission",
        envelope: { destination: { kind: "thread", thread: localThread } },
      });
      await s.execute();
      expect(s.nativeReplies).toEqual(["Read-only command completed."]);
      expect(s.nativeReplyThreads).toEqual([localThread]);
      expect(s.effects).toEqual(["slack:UALICE"]);
      expect((await s.request("GET", "/home/session")).body.entries).toEqual([]);
      const binding =
        admitted.status === "receipt" && admitted.receipt.ownerRunId
          ? await s.installation.originalBinding(admitted.receipt.ownerRunId)
          : undefined;
      expect(binding?.msg.threadKey).toBe(localThread);
      expect(await binding?.io.history()).toEqual([{ role: "user", text: "Untrusted raw source history" }]);
      seedCoordinatorUnit(s.coordinator, {
        ...unit,
        threadKey: "slack:D1:changed",
        ending: { kind: "terminated", at: 1001, report: "Changed after delivery" },
      });
      const retried = await s.installation.admitNative(msg, evidence);
      expect(retried).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { ownerRunId: admitted.status === "receipt" ? admitted.receipt.ownerRunId : "missing" },
      });
      expect(s.effects).toEqual(["slack:UALICE"]);
      expect(s.nativeReplies).toEqual(["Read-only command completed."]);
      expect(await s.installation.admitNative({ ...msg, threadKey: "slack:D1:other" }, evidence)).toEqual({
        status: "conflict",
      });
    },
  );
  it("holds an unknown DM ownership read instead of copying its reply into broad history", async () => {
    const s = await fixture(true, true);
    vi.spyOn(s.runs, "listRuns").mockRejectedValue(new Error("source history unavailable"));
    const result = await s.installation.admitNative(
      {
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: s.targetThread,
        messageId: "1000.5",
        text: "memory forget",
      },
      { source: "slack", identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" } },
    );
    expect(result).toEqual({ status: "unavailable" });
    expect(s.tasks).toEqual([]);
  });
  it("joins only proved private Slack input to the linked broad stream and retains its native reply address", async () => {
    const s = await fixture(true, true);
    const msg = {
      channelId: "slack:D1",
      userId: "slack:UALICE",
      threadKey: "slack:D1:1",
      messageId: "1000.1",
      text: "memory forget",
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId: "slack:D1",
        userId: "slack:UALICE",
        threadKey: "slack:D1:1",
      },
    };
    const evidence = {
      source: "slack" as const,
      identity: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
    };
    const missingPayload = await s.installation.admitNative(
      { ...msg, images: [{ data: "fixture", mediaType: "image/png" }] },
      evidence,
    );
    expect(missingPayload).toEqual({ status: "unavailable" });
    const admitted = await s.installation.admitNative(msg, evidence);
    expect(admitted).toMatchObject({
      status: "receipt",
      duplicate: false,
      receipt: { status: "accepted", source: "slack", actor: { bindingRevision: 1 }, ownerRunId: expect.any(String) },
    });
    await s.execute();
    expect(s.effects).toEqual(["slack:UALICE"]);
    expect(s.nativeReplies).toEqual(["Read-only command completed."]);
    const home = (await s.request("GET", "/home/session")).body;
    expect(home.entries.filter((entry) => entry.role !== "receipt").map((entry) => entry.content)).toEqual([
      "memory forget",
      "Read-only command completed.",
    ]);
    const again = await s.installation.admitNative(msg, evidence);
    expect(again).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { ownerRunId: admitted.status === "receipt" ? admitted.receipt.ownerRunId : "unavailable" },
    });
    expect(s.effects).toEqual(["slack:UALICE"]);
    s.revoke();
    expect(await s.installation.admitNative({ ...msg, messageId: "1000.2" }, evidence)).toEqual({
      status: "unavailable",
    });
  });
  async function ssoInstallation(
    mode: "access" | "oauth" | "token" | "hex",
    provider?: Provider,
    configureCore?: (core: CoreDeps, github: InMemoryGithubApi) => void,
    profileByEmail?: (email: string) => Promise<{ id: string; name?: string } | undefined>,
  ) {
    let clock = 1000,
      unavailable = false,
      revoked = false;
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const unsigned = [
      { alg: "RS256", kid: "fixture-sso" },
      {
        iss: "https://team.cloudflareaccess.com",
        aud: "fixture-app",
        sub: "alice",
        email: "alice@example.test",
        exp: 301,
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    const access = { teamDomain: "team.cloudflareaccess.com", aud: "fixture-app" };
    const bearer = mode === "hex" ? "d".repeat(64) : "dashboard-credential";
    const verifier =
      mode === "access" || mode === "oauth"
        ? buildDashboardVerifier({
            dashboard: { auth: "access" },
            access,
            secrets: secretsFrom({}),
            publicBaseUrl: undefined,
            verify: {
              now: () => clock,
              fetchJwks: async () => [{ ...publicKey.export({ format: "jwk" }), kid: "fixture-sso" }],
            },
          })
        : tokenVerifier({ token: bearer, env: "FIXTURE_DASHBOARD_TOKEN", subject: "alice" });
    const sso = {
      ...verifier,
      verify: (req: Parameters<typeof verifier.verify>[0]) =>
        revoked
          ? Promise.resolve({ ok: false as const, status: 403, body: "credential revoked" })
          : unavailable
            ? Promise.resolve({ ok: false as const, status: 503, body: "authentication unavailable" })
            : verifier.verify(req),
    };
    const nativeOptions: Parameters<typeof createOrganizationNativeSources>[0] = {
      organization: "fixture",
      dashboard: sso,
      access,
      slack: {
        auth: { test: async () => ({}) },
        users: { info: async () => ({}) },
        conversations: { info: async () => ({}) },
      },
    };
    let currentNative = createOrganizationNativeSources(nativeOptions);
    const native = {
      ...currentNative,
      currentMcp: (...args: Parameters<typeof currentNative.currentMcp>) => currentNative.currentMcp(...args),
    };
    const personByEmail = profileByEmail ?? (async () => ({ id: "slack:UALICE" }));
    const s = await fixture(
      false,
      false,
      provider,
      false,
      false,
      false,
      10,
      false,
      undefined,
      native,
      configureCore,
      personByEmail,
    );
    const options: McpOptions = {
      auth: { tokens: s.tokens },
      sso,
      personalTokens: s.personalTokens,
      personByEmail,
      commands: s.core.commands,
      approvalsEnabled: true,
      publicBaseUrl: "https://fixture.test",
      replayChoice: s.installation.replayNativeChoice,
      admit: (msg, _io, evidence, choice, trace) => s.installation.admitNative(msg, evidence, choice, trace),
    };
    const headers: Record<string, string> =
      mode === "access" || mode === "oauth"
        ? {
            "cf-access-jwt-assertion": assertion,
            ...(mode === "oauth" ? { authorization: "Bearer oauth:opaque" } : {}),
          }
        : { authorization: `Bearer ${bearer}` };
    async function send(
      args: Record<string, unknown>,
      overrides: Record<string, string> = {},
      name = "dispatch",
      opts = options,
      modern?: Record<string, unknown>,
    ) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, ...(modern ?? {}) },
      });
      const req = Object.assign(Readable.from([Buffer.from(body)]), {
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
          ...overrides,
          ...(modern
            ? { "mcp-protocol-version": FORM_PROTOCOL_VERSION, "mcp-method": "tools/call", "mcp-name": name }
            : {}),
        },
      });
      let status = 0,
        response = "";
      await new Promise<void>((resolve) => {
        const res = {
          writeHead(code: number) {
            status = code;
          },
          on() {},
          write(chunk: string | Uint8Array) {
            response += Buffer.from(chunk).toString();
            return true;
          },
          end(chunk?: string) {
            response += chunk ?? "";
            resolve();
          },
        };
        createMcpHandler(s.core, opts)(req as IncomingMessage, res as unknown as ServerResponse);
      });
      const wire = JSON.parse(
        response.includes("data: ")
          ? response
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .at(-1)!
              .slice(6)
          : response,
      );
      return { status, wire };
    }
    return {
      ...s,
      native,
      nativeOptions,
      credentials: [assertion, bearer, "oauth:opaque"],
      restartNative: () => {
        currentNative = createOrganizationNativeSources(nativeOptions);
      },
      rotatedHeaders: () => {
        const [header, payload] = unsigned.split(".");
        const updated = { ...JSON.parse(Buffer.from(payload!, "base64url").toString()), exp: 302 };
        const value = header + "." + Buffer.from(JSON.stringify(updated)).toString("base64url");
        return {
          "cf-access-jwt-assertion":
            value + "." + sign("RSA-SHA256", Buffer.from(value), privateKey).toString("base64url"),
        };
      },
      options,
      send,
      expireSession: () => {
        clock = 400000;
      },
      fault: (value: boolean) => {
        unavailable = value;
      },
      revokeSession: () => {
        revoked = true;
      },
    };
  }
  it.each(["omitted", "on", "off", "shadow"] as const)(
    "uses the loaded %s operator mode for new MCP Review context",
    async (mode) => {
      const s = await ssoInstallation("access", undefined, (core) => {
        const workspace = core.config.config.workspaceDir;
        if (!workspace) throw new Error("Fixture workspace is unavailable");
        const path = join(workspace, "..", "config.yaml");
        const yaml = readFileSync(path, "utf8").replace(
          "routing: { operator: off }",
          mode === "omitted" ? "routing: {}" : `routing: { operator: ${mode} }`,
        );
        writeFileSync(path, yaml);
        core.config = new ConfigStore(path, join(workspace, "..", "overrides.json"));
      });
      expect(s.core.config.config.routing?.operator).toBe(mode === "omitted" ? undefined : mode);
      expect(Object.hasOwn(s.core.config.config.routing ?? {}, "operator")).toBe(mode !== "omitted");
      expect(operatorModeOf(s.core.config.config)).toBe(mode === "omitted" ? "on" : mode);
      await s.core.config.setOrgOverride({ verbosity: "debug" });
      expect(Object.hasOwn(s.core.config.config.routing ?? {}, "operator")).toBe(mode !== "omitted");
      const log = createSpanLog();
      s.core.spanLog = log;
      const response = await s.send({
        text: "agent:review review-context:fresh model:anthropic/general-model effort:high https://github.com/sample/api/pull/42",
        thread: "new-loaded-mode",
        idempotencyKey: "new-loaded-review",
      });
      expect(response.wire.result).toMatchObject({
        structuredContent: { admission: { status: "accepted", runId: expect.any(String) } },
      });
      const owned = await s.ledger.readIngressByRun(response.wire.result.structuredContent.admission.runId);
      expect(owned.status).toBe("record");
      if (owned.status !== "record") throw new Error("No original admission record");
      expect(owned.record.origin?.sourceReference?.contextMode).toBe(
        mode === "omitted" || mode === "on" ? "request" : undefined,
      );
      expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe(
        mode === "omitted" || mode === "on" ? "selected" : "routing",
      );
    },
  );
  it("reports the dispatch refusal for an accepted MCP Review with no Review run", async () => {
    const s = await ssoInstallation("access");
    const response = await s.send({
      text: "agent:review review https://github.com/sample/api/pull/999",
      idempotencyKey: "diagnose-refused-review",
    });
    expect(response.wire.result?.structuredContent?.admission).toMatchObject({
      status: "accepted",
      runId: expect.any(String),
    });
    const id = response.wire.result.structuredContent.admission.runId;
    await s.execute();
    expect((await s.runStore.get(id))?.agent).toBe("door");
    expect(await s.ledger.readIngressByRun(id)).toMatchObject({
      status: "record",
      record: {
        status: "uncertain",
        dispatchResult: { status: "refused", cause: "system", refusalCode: "pr_head_unknown" },
      },
    });
  });
  it("retains private history after restart and login renewal without unlocking the old execution", async () => {
    const s = await ssoInstallation("access", {
      name: "fixture",
      complete: async () => ({ content: [{ type: "text", text: "Saved decision." }], stopReason: "end_turn" }),
    });
    const text = "agent:general State the saved decision";
    const first = await s.send({ text, thread: "renewed-context", idempotencyKey: "prior-login" });
    const oldId = first.wire.result.structuredContent.admission.runId;
    await s.execute();
    const old = await s.ledger.readIngressByRun(oldId);
    if (old.status !== "record" || !old.record.origin) throw new Error("No original source");
    const before = await s.authentication.evaluateSourceIdentity(
      old.record.origin.actor.identity,
      old.record.origin.sourceReference,
      old.record.origin.actor.onBehalfOf,
    );
    expect(before.status).toBe("allowed");
    s.restartNative();
    const next = await s.send(
      {
        text: "agent:review https://github.com/sample/api/pull/42",
        thread: "renewed-context",
        idempotencyKey: "renewed-login",
      },
      s.rotatedHeaders(),
    );
    expect(next.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
    const binding = await s.installation.originalBinding(next.wire.result.structuredContent.admission.runId);
    expect(await binding?.io.authoritativePrivateHistory?.()).toMatchObject([
      { role: "user", text, user: "access:alice" },
      { role: "assistant", text: "Saved decision.", context: { status: "known" } },
    ]);
    expect(await s.authentication.resolveEnvelope(old.record.origin)).toEqual({ status: "unavailable" });
    if (!binding || before.status !== "allowed") throw new Error("No renewed source proof");
    const current = await s.authentication.resolveEnvelope(binding.envelope);
    if (current.status !== "resolved") throw new Error("No current reader");
    expect(
      await s.authentication.evaluateSourceIdentity(
        old.record.origin.actor.identity,
        old.record.origin.sourceReference,
        old.record.origin.actor.onBehalfOf,
        current.authentication,
      ),
    ).toEqual(before);
    const other = await s.send(
      { text: "memory forget", thread: "unrelated-conversation", idempotencyKey: "unrelated-source" },
      s.rotatedHeaders(),
    );
    const unrelated = await s.installation.originalBinding(other.wire.result.structuredContent.admission.runId);
    expect(await unrelated?.io.authoritativePrivateHistory?.()).toEqual([]);
    expect(
      (await s.send({ text, thread: "renewed-context", idempotencyKey: "prior-login" }, s.rotatedHeaders())).wire
        .result,
    ).toMatchObject({ isError: true, structuredContent: { admission: { status: "conflict" } } });
    if (!binding) throw new Error("No renewed source");
    const execute = s.store.execute.bind(s.store);
    const missing = vi
      .spyOn(s.store, "execute")
      .mockImplementation((request) =>
        request.action === "submission" && request.key === old.record.origin!.key
          ? Promise.resolve({ status: "not_found" as const })
          : execute(request),
      );
    await expect(binding.io.authoritativePrivateHistory!()).rejects.toThrow(
      "retained history producer could not be verified",
    );
    missing.mockRestore();
    s.setSourceGrants({ ...ALL_GRANTS, repos: new Set(), repoAccess: new Set() });
    const reader = await s.authentication.resolveEnvelope(binding.envelope);
    if (reader.status !== "resolved") throw new Error("No current reader identity");
    expect(
      await s.authentication.evaluateSourceIdentity(
        old.record.origin.actor.identity,
        old.record.origin.sourceReference,
        old.record.origin.actor.onBehalfOf,
        reader.authentication,
      ),
    ).toEqual({ status: "denied" });
  });
  it("retains a routing question as verified history for a normal MCP review", async () => {
    const s = await ssoInstallation(
      "access",
      {
        name: "fixture",
        complete: async () => ({ content: [{ type: "text", text: "Unused worker reply." }], stopReason: "end_turn" }),
      },
      (core) => {
        core.config.config.routing!.operator = "on";
        core.operatorModel = async () => ({ tool: "ask", input: { text: "Which behavior should I check?" } });
      },
    );
    const first = await s.send({
      text: "agent:review https://github.com/sample/api/pull/42",
      thread: "review-question",
      idempotencyKey: "question",
    });
    const producer = first.wire.result.structuredContent.admission.runId;
    await s.execute();
    expect(s.nativeReplies).toEqual(["Which behavior should I check?"]);
    const next = await s.send({
      text: "agent:review https://github.com/sample/api/pull/42 Check access loss",
      thread: "review-question",
      idempotencyKey: "answer-question",
    });
    expect(next.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
    const binding = await s.installation.originalBinding(next.wire.result.structuredContent.admission.runId);
    if (!binding) throw new Error("No follow-up source");
    const history = await binding.io.authoritativePrivateHistory!();
    expect(history).toMatchObject([
      { role: "user", text: "agent:review https://github.com/sample/api/pull/42", user: "access:alice" },
      {
        role: "assistant",
        text: "Which behavior should I check?",
        context: { status: "known", origins: [expect.objectContaining({ runId: producer })] },
      },
    ]);
    const original = await s.runStore.get(producer);
    expect(original).toMatchObject({
      id: producer,
      agent: "door",
      organizationIngressRunId: producer,
      contextDependencies: { status: "known" },
    });
    expect((await s.runStore.put({ ...original!, contextDependencies: undefined })).stored).toBe(true);
    await expect(binding.io.authoritativePrivateHistory!()).rejects.toThrow("history source could not be verified");
  });
  it("lets a later MCP Review omit a failed setup reply from its history", async () => {
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const s = await ssoInstallation("access", undefined, (core) => {
      core.githubCredentials = TEST_GITHUB_CREDENTIALS;
      core.resolveRepoContext = () => ({
        repo: "sample/api",
        ref: "patch-1",
        baseRef: "main",
        baseSha: base,
        pr: 42,
        headSha: head,
      });
      core.fetchPrHead = async () => head;
      core.fetchPrBase = async () => ({ baseRef: "main", baseSha: base });
      core.fetchPrFacts = async () => ({
        state: "open",
        headRef: "patch-1",
        baseRef: "main",
        baseSha: base,
        headSha: head,
        headBranchExists: true,
        sameRepoHead: true,
        verifiedHead: { repo: "sample/api", ref: "patch-1", sha: head },
      });
    });
    const text = "agent:review https://github.com/sample/api/pull/42";
    const first = await s.send({ text, thread: "failed-review-setup", idempotencyKey: "first-review" });
    const firstId = first.wire.result.structuredContent.admission.runId;
    await s.execute();
    const failed = await s.runStore.get(firstId);
    expect(failed?.status).toBe("failed");
    expect(failed?.events).toContainEqual(expect.objectContaining({ type: "refusal", code: "setup_failed" }));

    const second = await s.send({ text, thread: "failed-review-setup", idempotencyKey: "second-review" });
    const binding = await s.installation.originalBinding(second.wire.result.structuredContent.admission.runId);
    if (!binding) throw new Error("No second Review source");
    expect(await binding.io.authoritativePrivateHistory!()).toEqual([{ role: "user", text, user: "access:alice" }]);
  });
  it.each(["missing", "unknown"] as const)("withholds retained command output with %s source proof", async (proof) => {
    const s = await ssoInstallation("access");
    const first = await s.send({ text: "memory forget", thread: "command-sources", idempotencyKey: "command" });
    expect(first.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
    await s.execute();
    expect(s.nativeReplies).toContain("Read-only command completed.");
    const command = (await s.runStore.list({})).find((row) => row.agent === "command");
    const old = command ? await s.runStore.get(command.id) : undefined;
    if (!old) throw new Error("No command archive");
    expect(
      (
        await s.runStore.put({
          ...old,
          ...(proof === "unknown"
            ? { contextDependencies: { version: 1, status: "unknown", revision: 0, origins: [], slack: [], mcp: [] } }
            : { contextDependencies: undefined }),
        })
      ).stored,
    ).toBe(true);
    expect((await s.runStore.get(old.id))?.contextDependencies?.status).toBe(
      proof === "unknown" ? "unknown" : undefined,
    );
    const next = await s.send({
      text: "agent:review https://github.com/sample/api/pull/42",
      thread: "command-sources",
      idempotencyKey: "review-command-output",
    });
    const binding = await s.installation.originalBinding(next.wire.result.structuredContent.admission.runId);
    if (!binding) throw new Error("No follow-up source");
    await expect(binding.io.authoritativePrivateHistory!()).rejects.toThrow(
      "saved history source could not be verified",
    );
  });
  it("admits a fresh request-only Review after restart and a new signed credential", async () => {
    const s = await ssoInstallation("access");
    const log = createSpanLog();
    s.core.spanLog = log;
    const first = await s.send({ text: "memory forget", thread: "reauth", idempotencyKey: "prior-credential" });
    expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe("routing");
    const oldRun = first.wire.result.structuredContent.admission.runId;
    const old = await s.ledger.readIngressByRun(oldRun);
    if (old.status !== "record" || !old.record.origin) throw new Error("No original fixture owner");
    s.restartNative();
    expect(await s.authentication.resolveEnvelope(old.record.origin)).toEqual({ status: "unavailable" });
    s.core.config.config.routing!.operator = "on";
    const result = await s.send(
      {
        text: "agent:review review-context:fresh model:anthropic/general-model effort:high https://github.com/sample/api/pull/42",
        thread: "reauth",
        idempotencyKey: "new-credential-review",
      },
      s.rotatedHeaders(),
    );
    expect(result.wire.result).toMatchObject({
      structuredContent: {
        admission: { status: "accepted", receiptId: expect.stringMatching(/^organization:fixture:\d+$/) },
      },
    });
    expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe("selected");
    const fresh = await s.ledger.readIngressByRun(result.wire.result.structuredContent.admission.runId);
    expect(result.wire.result.structuredContent.admission.receiptId).not.toBe(
      first.wire.result.structuredContent.admission.receiptId,
    );
    expect(fresh).toMatchObject({
      status: "record",
      record: { origin: { sourceReference: { contextMode: "request" } } },
    });
    const owned = await s.installation.originalBinding(result.wire.result.structuredContent.admission.runId);
    if (!owned) throw new Error("No new original owner");
    expect(await owned.io.authoritativePrivateHistory!(owned.msg)).toEqual([]);
    const repeat = await s.send(
      {
        text: "agent:review review-context:fresh model:anthropic/general-model effort:high https://github.com/sample/api/pull/42",
        thread: "reauth",
        idempotencyKey: "new-credential-review",
      },
      s.rotatedHeaders(),
    );
    expect(repeat.wire.result).toMatchObject({
      structuredContent: {
        admission: { status: "accepted", duplicate: true, runId: result.wire.result.structuredContent.admission.runId },
      },
    });
    expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe("retained_request");
    expect(
      (
        await s.send(
          { text: "memory forget", thread: "reauth", idempotencyKey: "prior-credential" },
          s.rotatedHeaders(),
        )
      ).wire.result,
    ).toMatchObject({ isError: true, structuredContent: { admission: { status: "conflict" } } });
    expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe("existing_key");
    expect(await s.authentication.resolveEnvelope(old.record.origin)).toEqual({ status: "unavailable" });
    expect(await s.ledger.readIngressByRun(oldRun)).toMatchObject({
      status: "record",
      record: { origin: old.record.origin, status: "dispatching" },
    });
    expect(s.effects).toEqual([]);
  });
  it.each(["fresh", "owned-thread", "wrong-stage", "revoked-before-start", "revoked-after-records"] as const)(
    "admits only a fresh current-request Ship review: %s",
    async (variant) => {
      const head = "e".repeat(40);
      const created: string[] = [];
      const log = createSpanLog();
      const s = await ssoInstallation("access", undefined, (core) => {
        core.sinks = [log.sink];
        core.githubCredentials = TEST_GITHUB_CREDENTIALS;
        core.fetchRepoShipInfo = async () => ({ defaultBranch: "main" });
        core.fetchRefExists = async () => true;
        core.resolveRepoContext = () => ({
          repo: "sample/api",
          pr: 42,
          ref: "patch-1",
          headSha: head,
          baseRef: "main",
        });
        core.fetchPrFacts = async () => {
          if (variant === "revoked-before-start") s.revokeSession();
          return { state: "open", headRef: "patch-1", headSha: head, baseRef: "main", sameRepoHead: true };
        };
        core.createCoordinatorInstance = async (id) => {
          created.push(id);
          return { kind: "created", id };
        };
        core.operatorModel = async () => ({
          tool: "bind_preset",
          input: {
            preset: "ship",
            shipEntry: variant === "wrong-stage" ? "work" : "review",
            repo: "sample/api",
            ...(variant === "wrong-stage"
              ? {}
              : {
                  prTarget: { number: 42, source: "request", quote: "https://github.com/sample/api/pull/42" },
                }),
            reason: "Review the requested PR",
            settingsEvidence: operatorSettingsEvidence(),
          },
        });
      });
      if (variant === "revoked-after-records") {
        const put = s.coordinator.putUnits.bind(s.coordinator);
        vi.spyOn(s.coordinator, "putUnits").mockImplementation(async (rows) => {
          const result = await put(rows);
          s.revokeSession();
          return result;
        });
      }
      const prior = await s.send({ text: "memory forget OLD-PRIVATE-MARKER", idempotencyKey: "prior-ship-source" });
      const oldId = prior.wire.result.structuredContent.admission.runId;
      const old = await s.ledger.readIngressByRun(oldId);
      if (old.status !== "record" || !old.record.origin) throw new Error("No original source");
      // The old invocation remains owned and unread after the adapter restart.
      s.tasks.shift();
      s.restartNative();
      s.core.config.config.routing!.operator = "on";
      expect(await s.authentication.resolveEnvelope(old.record.origin)).toEqual({ status: "unavailable" });
      if (variant === "owned-thread") {
        await s.seedQuestion({ channelId: "mcp:default", threadKey: "mcp:default:fresh-ship", repo: "sample/api" });
        seedCoordinatorUnit(s.coordinator, { ...unit, threadKey: "mcp:default:fresh-ship" });
      }
      const originalUnits = await s.coordinator.listUnits("fixture");
      const result = await s.send(
        {
          text: "agent:ship review-context:fresh review https://github.com/sample/api/pull/42",
          thread: "fresh-ship",
          idempotencyKey: "fresh-ship-review",
        },
        s.rotatedHeaders(),
      );
      expect(result.wire.result).toMatchObject({
        structuredContent: { admission: { status: "accepted", runId: expect.any(String) } },
      });
      const id = result.wire.result.structuredContent.admission.runId;
      const binding = await s.installation.originalBinding(id);
      if (!binding) throw new Error("No original Ship binding");
      expect(binding.envelope.sourceReference?.contextMode).toBe("request");
      expect(await binding.io.authoritativePrivateHistory!(binding.msg)).toEqual([]);
      await s.execute();
      if (variant === "fresh") {
        expect(created).toHaveLength(1);
        expect(await s.coordinator.get(created[0]!)).toMatchObject({ repo: "sample/api", runId: id, merge: "person" });
        const rows = await s.coordinator.listUnits(created[0]!);
        expect(rows).toMatchObject([
          {
            branch: "patch-1",
            resume: { pr: 42, headSha: head },
            publication: { repo: "sample/api", pr: 42, headRef: "patch-1", expectedHeadSha: head },
            rounds: [],
          },
        ]);
        expect(JSON.stringify(rows)).not.toContain("OLD-PRIVATE-MARKER");
      } else {
        expect(created).toEqual([]);
        if (variant === "owned-thread") {
          expect(s.nativeReplies.at(-1)).toBe(
            "The original work retains this thread. A new Ship request cannot continue it without its verified context.",
          );
          expect(log.read({ span: "request" }).lines.at(-1)?.attrs).toMatchObject({
            requestContextGate: "thread_owner",
            requestContextReason: "thread_occupied",
            status: "refused",
          });
          expect(log.read({ span: "dispatch.refuse" }).lines.at(-1)?.attrs).toMatchObject({
            requestContextGate: "thread_owner",
            requestContextReason: "thread_occupied",
            outcome: "setup_failed",
          });
          expect(await s.coordinator.listUnits("fixture")).toEqual(originalUnits);
          const refusals = await s.runStore.list({ agent: "door", threadKey: "mcp:default:fresh-ship" });
          expect(refusals).toHaveLength(1);
          expect(
            (await s.runStore.get(refusals[0]!.id))?.events.filter((event) => event.type === "refusal"),
          ).toMatchObject([{ type: "refusal", code: "setup_failed" }]);
        } else if (variant === "wrong-stage") expect(s.nativeReplies.join("\n")).toContain("could not be bound");
        else
          expect((await s.runStore.get(id))?.events).toContainEqual(
            expect.objectContaining({
              type: "answer",
              text:
                variant === "revoked-after-records"
                  ? "Current source access could not be verified; the saved Ship unit remains held."
                  : "Current source access could not be verified; no worker started.",
            }),
          );
      }
      expect(await s.ledger.readIngressByRun(oldId)).toEqual(old);
    },
  );
  it.each(["client-marker", "machine-credential"] as const)(
    "keeps %s from selecting request-only context",
    async (variant) => {
      const s = await ssoInstallation(variant === "machine-credential" ? "token" : "access");
      const log = createSpanLog();
      s.core.spanLog = log;
      s.core.config.config.routing!.operator = "on";
      const result = await s.send({
        text:
          variant === "machine-credential"
            ? "agent:review review-context:fresh https://github.com/sample/api/pull/42"
            : "memory forget",
        idempotencyKey: "unmarked-request",
        contextMode: "request",
        sourceReference: { contextMode: "request" },
      });
      expect(result.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
      const stored = await s.ledger.readIngressByRun(result.wire.result.structuredContent.admission.runId);
      expect(stored).toMatchObject({ status: "record", record: { origin: { source: "mcp" } } });
      if (stored.status !== "record") throw new Error("No original request");
      expect(stored.record.origin?.sourceReference?.contextMode).toBeUndefined();
      expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe(
        variant === "machine-credential" ? "actor" : "context",
      );
      expect(s.effects).toEqual([]);
    },
  );
  it.each(["sync", "async", "mutation"] as const)(
    "keeps a selected request-only admission when its %s observer fails",
    async (mode) => {
      const s = await ssoInstallation("access");
      const log = createSpanLog();
      s.core.spanLog = log;
      s.core.config.config.routing!.operator = "on";
      const admit = s.options.admit!;
      const result = await s.send(
        {
          text: "agent:review review-context:fresh https://github.com/sample/api/pull/42 PRIVATE-SELECTION-MARKER",
          idempotencyKey: "selection-observer",
        },
        {},
        "dispatch",
        {
          ...s.options,
          admit: (message, io, evidence, choice, trace) => {
            if (trace?.span) {
              const set = trace.span.setAttrs.bind(trace.span);
              trace.span.setAttrs = (attrs) => {
                if (attrs.requestContextSelection !== undefined) {
                  if (mode === "mutation") {
                    Reflect.set(attrs, "requestContextSelection", "wrong-mode");
                    return set(attrs);
                  }
                  if (mode === "sync") throw new Error("PRIVATE-SELECTION-OBSERVER");
                  return Promise.reject(new Error("PRIVATE-SELECTION-OBSERVER"));
                }
                return set(attrs);
              };
            }
            return admit(message, io, evidence, choice, trace);
          },
        },
      );
      expect(result.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
      expect(await s.ledger.readIngressByRun(result.wire.result.structuredContent.admission.runId)).toMatchObject({
        status: "record",
        record: { origin: { sourceReference: { contextMode: "request" } } },
      });
      expect(s.tasks).toHaveLength(1);
      expect(s.effects).toEqual([]);
      expect(JSON.stringify(log.read())).not.toMatch(/PRIVATE-SELECTION/);
    },
  );
  it("records media as the request-only selection decline without admitting a second request", async () => {
    const s = await ssoInstallation("access");
    const log = createSpanLog();
    s.core.spanLog = log;
    s.core.config.config.routing!.operator = "on";
    const text = "agent:review review-context:fresh https://github.com/sample/api/pull/42 PRIVATE-SELECTION-MARKER";
    expect((await s.send({ text, idempotencyKey: "selection-control" })).wire.result).toMatchObject({
      structuredContent: { admission: { status: "accepted" } },
    });
    expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe("selected");
    const admit = s.options.admit!;
    const rejected = await s.send({ text, idempotencyKey: "selection-media" }, {}, "dispatch", {
      ...s.options,
      admit: (message, io, evidence, choice, trace) =>
        admit({ ...message, images: [{ mediaType: "image/png", data: "AA==" }] }, io, evidence, choice, trace),
    });
    expect(rejected.wire.result).toMatchObject({
      isError: true,
      structuredContent: { admission: { status: "unavailable" } },
    });
    expect(log.read({ span: "request" }).lines.at(-1)?.attrs.requestContextSelection).toBe("media");
    expect(JSON.stringify(log.read())).not.toMatch(/PRIVATE-SELECTION|sample\/api/);
    expect(s.tasks).toHaveLength(1);
    expect(s.effects).toEqual([]);
  });
  it.each(["healthy", "throws"] as const)(
    "records an invalid request-only context when its trace observer %s",
    async (observer) => {
      const log = createSpanLog();
      const s = await ssoInstallation("access", undefined, (core) => {
        core.sinks = [
          log.sink,
          {
            onEnd() {
              if (observer === "throws") throw new Error("Observer failed");
            },
          },
        ];
      });
      const replies: string[] = [];
      const result = await dispatch(
        s.core,
        {
          channelId: "mcp:default",
          userId: "access:alice",
          threadKey: "mcp:default:invalid-context",
          text: "agent:review review-context:fresh https://github.com/sample/api/pull/42 PRIVATE-REQUEST-MARKER",
        },
        {
          reply: async (text) => {
            replies.push(text);
          },
          history: async () => [],
          status: async () => ({ update() {}, async done() {} }),
        },
        {
          contextMode: "request",
          ...(observer === "healthy" ? { trace: startRequestRoot(s.core, { channel: "mcp", receivedAt: 1000 }) } : {}),
        },
      );
      expect(result).toEqual({ status: "refused", refusal: "setup_failed" });
      expect(replies).toEqual(["This Review could not be verified as a new request."]);
      expect(log.read({ span: "dispatch.refuse" }).lines[0]?.attrs).toMatchObject({
        requestContextGate: "input",
        requestContextReason: "invalid_input",
        refusal: "setup_failed",
      });
      expect(log.read({ span: "request" }).lines[0]?.attrs).toMatchObject({
        status: "refused",
        requestContextGate: "input",
      });
      expect(JSON.stringify(log.read())).not.toMatch(/PRIVATE-REQUEST-MARKER|sample\/api/);
      expect(s.effects).toEqual([]);
    },
  );
  it.each([
    "plain",
    "normal-followup",
    "general-followup",
    "coding-followup",
    "default-on",
    "multiline-request",
    "long-request",
    "prior-child",
    "read-first",
    "expires-at-door",
    "revoked-at-door",
    "rights-loss",
    "directory-rebind",
    "operator-off",
    "operator-shadow",
    "context-stuck",
    "wrong-target",
    "same-pr-live",
    "same-pr-unknown",
    "unrelated-held",
    "late-local-live",
    "late-local-unknown",
    "late-remote-live",
    "late-remote-unnamed",
    "context-observer-fails",
  ] as const)(
    "selects the requested Review context and rechecks its current authority: %s",
    async (variant) => {
      const head = "e".repeat(40);
      const baseSha = "b".repeat(40);
      const followupAgent =
        variant === "general-followup" ? "general" : variant === "coding-followup" ? "coding" : undefined;
      const normalFollowup = variant === "normal-followup" || followupAgent !== undefined;
      const succeeds = [
        "plain",
        "normal-followup",
        "default-on",
        "multiline-request",
        "long-request",
        "prior-child",
        "read-first",
        "unrelated-held",
      ].includes(variant);
      let phase: "old" | "fresh" = "old";
      let operatorCalls = 0;
      const contextLog = createSpanLog();
      const admission = new ThreadAdmission<import("../core/dispatch/admission.js").DispatchFollowUp>();
      const elsewhere = new ThreadsElsewhere();
      let held: ReturnType<typeof admission.get>;
      const heldId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const installLateOwner = () => {
        if (variant.startsWith("late-remote")) {
          elsewhere.remember("mcp:default:reused-review", {
            runId: heldId,
            startedAt: 1000,
            ...(variant === "late-remote-live" ? { agent: "review" } : {}),
          });
        } else if (variant.startsWith("late-local") && !held) {
          const claim = admission.claim("mcp:default:reused-review", { agent: "review", now: 1000 });
          if (claim.kind !== "start") throw new Error("Occupied late fixture slot");
          claim.live.runId = heldId;
          if (variant === "late-local-unknown") claim.live.unknownClaim = { runId: heldId };
          held = claim.live;
        }
      };
      const requests: { phase: string; request: CompletionRequest }[] = [];
      const provider: Provider = {
        name: "fixture",
        async complete(request) {
          requests.push({ phase, request: { ...request, messages: structuredClone(request.messages) } });
          if (phase === "fresh" && followupAgent)
            return {
              content: [{ type: "text", text: "Follow-up uses saved Review evidence." }],
              stopReason: "end_turn",
            };
          const results = request.messages
            .flatMap((m) => m.content)
            .filter((p) => p.type === "tool_result")
            .map((p) => p.toolUseId);
          const call = (id: string, name: string, input: Record<string, unknown>) => ({
            content: [{ type: "tool_use" as const, id, name, input }],
            stopReason: "tool_use" as const,
          });
          if (!results.includes("github-source"))
            return call("github-source", "github_pull_get", {
              repo: "sample/api",
              number: 42,
              includeReviewHistory: true,
            });
          if (phase === "old" && !results.includes("old-notes"))
            return call("old-notes", "notes", { text: "OLD-NOTEPAD-MARKER" });
          if (!results.includes("verdict"))
            return call("verdict", "submit_verdict", {
              verdict: "approve",
              findings: [],
              summary: phase === "old" ? "OLD-SUMMARY-MARKER" : "Current Review passes.",
              head,
            });
          return {
            content: [{ type: "text", text: phase === "old" ? "OLD-ANSWER-MARKER" : "Current Review passes." }],
            stopReason: "end_turn",
          };
        },
      };
      const posts: { target: unknown; body: string }[] = [];
      const s = await ssoInstallation("access", provider, (core) => {
        core.sinks = [
          contextLog.sink,
          {
            onEnd(record) {
              if (variant === "context-observer-fails" && record.attrs.requestContextGate)
                throw new Error("Context observer failed");
            },
          },
        ];
        core.admission = admission;
        core.threadsElsewhere = elsewhere;
        core.githubCredentials = TEST_GITHUB_CREDENTIALS;
        core.resolveRepoContext = () => {
          if (phase === "fresh") installLateOwner();
          return { repo: "sample/api", ref: "patch-1", baseRef: "main", baseSha, pr: 42, headSha: head };
        };
        core.fetchPrHead = async () => head;
        core.fetchPrBase = async () => ({ baseRef: "main", baseSha: "a".repeat(40) });
        core.fetchPrFacts = async () => ({
          state: "open",
          headRef: "patch-1",
          baseRef: "main",
          baseSha,
          headSha: head,
          headBranchExists: true,
          sameRepoHead: true,
          verifiedHead: { repo: "sample/api", ref: "patch-1", sha: head },
        });
        core.postReviewComment = async (target, body) => {
          posts.push({ target, body });
          return { state: "accepted" };
        };
        core.operatorModel = async () => {
          operatorCalls++;
          if (variant === "expires-at-door") s.expireSession();
          if (variant === "revoked-at-door") s.revokeSession();
          if (variant === "rights-loss") s.setSourceGrants(NO_GRANTS);
          if (variant === "directory-rebind") {
            const person = await s.store.directory.createPerson();
            if (person.status !== "created") throw new Error("No replacement fixture person");
            const id = { issuer: s.native.mcpIssuer, tenant: null, subject: "alice" };
            expect(
              await s.store.directory.change({
                action: "recover",
                identity: id,
                personId: person.person.id,
                expectedRevision: 1,
                actor: id,
                proof: { method: "administrator-recovery", version: 1 },
              }),
            ).toMatchObject({ status: "changed", binding: { revision: 2 } });
          }
          if (variant === "context-stuck" || (variant === "read-first" && operatorCalls === 1))
            return { tool: OPERATOR_READ_TOOLS.threadState, input: {} };
          return {
            tool: "bind_preset",
            input: {
              preset: "review",
              model: "anthropic/general-model",
              repo: "sample/api",
              prTarget: { number: 42, source: "request", quote: "https://github.com/sample/api/pull/42" },
              reason: "New current request",
              effort: "high",
              settingsEvidence: operatorSettingsEvidence({ effort: { intent: "requested", quote: "effort:high" } }),
              ...(["wrong-target", "context-observer-fails"].includes(variant)
                ? { prTarget: { number: 43, source: "request", quote: "https://github.com/sample/api/pull/43" } }
                : {}),
            },
          };
        };
      });
      const factory = vi.spyOn(executorFactory, "makeExecutor").mockResolvedValue({
        executor: {
          exec: async (command) => (command.includes("rev-parse") ? head + "\n" : ""),
          execResult: async (command) => ({
            exitCode: 0,
            stdout: command.includes("@@diff_digest:range@@")
              ? `@@diff_digest:range@@\n${baseSha}\n${head}\n1\t0\tsrc/a.ts\n@@diff_digest:name-status@@\nM\tsrc/a.ts\n`
              : command.includes("rev-parse")
                ? head + "\n"
                : "",
            stderr: "",
            truncated: false,
          }),
          readFile: async () => "",
          writeFile: async () => "",
          release: async () => ({ released: true }),
        },
      });
      cleanups.push(() => factory.mockRestore());
      const repo = s.github.repos.get("sample/api")!;
      repo.private = true;
      repo.pulls = [
        {
          id: 42,
          number: 42,
          title: "Current change",
          body: "OLD-GITHUB-RESULT-MARKER",
          state: "open",
          draft: false,
          url: "https://github.com/sample/api/pull/42",
          author: "alice",
          updatedAt: "2026-01-01T00:00:00Z",
          head: { repo: "sample/api", ref: "patch-1", sha: head },
          base: { repo: "sample/api", ref: "main", sha: baseSha },
        },
      ];
      const text = `agent:review ${normalFollowup ? "" : "review-context:fresh "}model:anthropic/general-model effort:high review-head:${head} https://github.com/sample/api/pull/42`;
      const historyReads = vi.spyOn(s.installation.organization, "streamTail");
      const prior = await s.send({
        text: text + " OLD-REQUEST-MARKER",
        thread: "reused-review",
        idempotencyKey: "completed-review",
      });
      const oldId = prior.wire.result.structuredContent.admission.runId;
      await s.execute();
      const old = await s.runStore.get(oldId);
      expect(old).toMatchObject({
        status: "completed",
        reviewPost: { posted: true, head },
        contextDependencies: { status: "known", executionGithub: [expect.objectContaining({ runId: oldId })] },
      });
      if (!old) throw new Error("No completed Review");
      expect(historyReads.mock.calls.length).toBeGreaterThan(0);
      historyReads.mockClear();
      if (variant === "prior-child") {
        const { contextCheckpointReceipt: _checkpoint, reviewPublication: _publication, ...metadata } = old;
        expect(
          (
            await s.runStore.put({
              ...metadata,
              id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
              parentRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            })
          ).stored,
        ).toBe(true);
      }
      phase = "fresh";
      const inboxWrites = vi.spyOn(s.core.runLedger, "pushInbox");
      if (variant === "directory-rebind") {
        const person = await s.store.directory.createPerson();
        if (person.status !== "created") throw new Error("No initial fixture person");
        const id = { issuer: s.native.mcpIssuer, tenant: null, subject: "alice" };
        expect(
          await s.store.directory.change({
            action: "link",
            identity: id,
            personId: person.person.id,
            expectedRevision: 0,
            actor: id,
            proof: { method: "dual-authentication", version: 1 },
          }),
        ).toMatchObject({ status: "changed", binding: { revision: 1 } });
      }
      repo.pulls[0]!.body = "FRESH-GITHUB-DATA";
      s.restartNative();
      if (variant === "default-on") {
        const path = join(s.path, "config.yaml");
        writeFileSync(path, readFileSync(path, "utf8").replace("routing: { operator: off }", "routing: {}"));
        const loaded = new ConfigStore(path, join(s.path, "overrides.json"));
        expect(Object.hasOwn(loaded.config.routing ?? {}, "operator")).toBe(false);
        s.core.config.config.routing = loaded.config.routing;
        expect(operatorModeOf(s.core.config.config)).toBe("on");
      } else s.core.config.config.routing!.operator = "on";
      const freshText = followupAgent
        ? `agent:${followupAgent} model:anthropic/general-model ${followupAgent === "coding" ? "Fix" : "Explain"} the saved Review findings in sample/api`
        : variant === "multiline-request"
          ? text.replace(" https://", " Please review the change below.\nhttps://")
          : variant === "long-request"
            ? text.replace(" https://", ` ${"Please check this change. ".repeat(20)}https://`)
            : text;
      const fresh = await s.send(
        { text: freshText, thread: "reused-review", idempotencyKey: "reauthenticated-review" },
        s.rotatedHeaders(),
      );
      expect(fresh.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
      const freshId = fresh.wire.result.structuredContent.admission.runId;
      if (variant === "operator-off" || variant === "operator-shadow")
        s.core.config.config.routing!.operator = variant === "operator-off" ? "off" : "shadow";
      if (["same-pr-live", "same-pr-unknown", "unrelated-held"].includes(variant)) {
        const key = variant === "unrelated-held" ? "mcp:default:unrelated-review" : "mcp:default:reused-review";
        const claim = admission.claim(key, { agent: "review", now: 1000 });
        if (claim.kind !== "start") throw new Error("Occupied fixture slot");
        claim.live.runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        if (variant !== "same-pr-live") claim.live.unknownClaim = { runId: claim.live.runId };
        held = claim.live;
      }
      await s.execute();
      const record = await s.runStore.get(freshId);
      if (followupAgent) {
        expect(record).toMatchObject({
          status: "completed",
          agent: followupAgent,
          profile: { identity: followupAgent === "general" ? "none" : "write" },
          contextDependencies: { status: "known", executionGithub: [expect.objectContaining({ runId: oldId })] },
        });
        expect(s.nativeReplies.at(-1)).toBe(
          followupAgent === "coding"
            ? "No push was confirmed by this run.\n\nWork report (agent-written; publication claims here are unverified):\nFollow-up uses saved Review evidence."
            : "Follow-up uses saved Review evidence.",
        );
        expect(JSON.stringify(requests.filter((r) => r.phase === "fresh"))).toContain("OLD-SUMMARY-MARKER");
        expect(posts).toHaveLength(1);
        expect(await s.runStore.get(oldId)).toEqual(old);
        return;
      }
      const refusedGate =
        variant === "operator-off" || variant === "operator-shadow"
          ? "operator_mode"
          : ["context-stuck", "wrong-target", "context-observer-fails"].includes(variant)
            ? "operator_decision"
            : variant.startsWith("late-local")
              ? "local_owner"
              : variant.startsWith("late-remote")
                ? "remote_owner"
                : ["same-pr-live", "same-pr-unknown"].includes(variant)
                  ? "typed_route"
                  : undefined;
      if (refusedGate) {
        const diagnostic = contextLog.read().lines.find((line) => line.attrs.requestContextGate === refusedGate);
        expect(diagnostic?.attrs).toMatchObject({
          requestContextGate: refusedGate,
          requestContextReason:
            refusedGate === "operator_mode"
              ? "routing_disabled"
              : refusedGate.endsWith("owner")
                ? "thread_occupied"
                : "invalid_bind",
        });
        expect(JSON.stringify(diagnostic?.attrs)).not.toMatch(/sample\/api|OLD-|https:|credential|New current request/);
        if (refusedGate !== "operator_mode") {
          const doors = await s.runStore.list({ agent: "door", threadKey: "mcp:default:reused-review" });
          expect(doors).toHaveLength(1);
          const door = await s.runStore.get(doors[0]!.id);
          const decision = door?.events.filter((event) => event.type === "operator");
          expect(decision).toMatchObject([
            { type: "operator", outcome: refusedGate === "operator_decision" ? "non_decision" : "binds" },
          ]);
          if (refusedGate === "operator_decision")
            expect(decision?.[0]).toMatchObject({
              attempts: [{ outcome: "violation" }, { outcome: "violation" }, { outcome: "violation" }],
            });
          expect(door?.events.filter((event) => event.type === "refusal")).toMatchObject([
            {
              type: "refusal",
              code:
                refusedGate === "local_owner"
                  ? "follow_up_refused"
                  : refusedGate === "remote_owner"
                    ? "elsewhere_follow_up_refused"
                    : "setup_failed",
            },
          ]);
          expect(door).toMatchObject({ agent: "door", status: "completed" });
        }
      }
      if (variant !== "normal-followup") expect(historyReads.mock.calls.length).toBe(0);
      if (held) expect(held.inbox.size).toBe(0);
      expect(inboxWrites.mock.calls.length).toBe(0);
      if (variant.startsWith("late-local")) expect(admission.get("mcp:default:reused-review")).toBe(held);
      if (variant.startsWith("late-remote"))
        expect(elsewhere.get("mcp:default:reused-review")).toEqual({
          runId: heldId,
          startedAt: 1000,
          ...(variant === "late-remote-live" ? { agent: "review" } : {}),
        });
      if (!succeeds) {
        expect(posts).toHaveLength(1);
        expect(record?.reviewPost?.posted).not.toBe(true);
        expect(requests.filter((r) => r.phase === "fresh")).toEqual([]);
        expect(s.effects).toEqual([]);
        if (variant === "context-stuck" || variant === "context-observer-fails") {
          expect(operatorCalls).toBe(3);
          expect(await s.ledger.readIngressByRun(freshId)).toMatchObject({
            status: "record",
            record: { status: "completed", outcome: "setup_failed" },
          });
          if (variant === "context-observer-fails")
            expect(s.nativeReplies.at(-1)).toBe("This Review could not be bound to the current request.");
        }
        expect(await s.runStore.get(oldId)).toEqual(old);
        return;
      }
      expect(record).toMatchObject({
        status: "completed",
        agent: "review",
        model: "anthropic/general-model",
        reviewPost: { posted: true, target: { repo: "sample/api", number: 42 }, head },
      });
      expect(posts).toHaveLength(2);
      expect(record?.parentRunId).toBeUndefined();
      expect(record?.session?.key).not.toBe(old.session?.key);
      if (variant !== "normal-followup")
        expect(JSON.stringify(requests.filter((r) => r.phase === "fresh"))).not.toMatch(
          /OLD-(?:REQUEST|ANSWER|SUMMARY|NOTEPAD|GITHUB-RESULT)-MARKER/,
        );
      expect(JSON.stringify(requests.filter((r) => r.phase === "fresh"))).toContain("FRESH-GITHUB-DATA");
      if (variant === "normal-followup") {
        expect(JSON.stringify(requests.filter((r) => r.phase === "fresh"))).toContain("OLD-SUMMARY-MARKER");
        expect((await s.ledger.readContextCheckpoint(freshId))?.members).toContain(oldId);
        expect(record?.contextDependencies?.executionGithub).toContainEqual(expect.objectContaining({ runId: oldId }));
      } else
        expect(record?.events).toContainEqual(
          expect.objectContaining({
            type: "run_note",
            kind: "seed",
            summary: "This Review uses your current request and GitHub. Earlier conversation context is not included.",
          }),
        );
      if (variant === "read-first") expect(operatorCalls).toBe(2);
      expect(await s.runStore.get(oldId)).toEqual(old);
      if (variant === "default-on") {
        const original = await s.ledger.readIngressByRun(oldId);
        if (original.status !== "record" || !original.record.origin) throw new Error("No retained original source");
        expect(await s.authentication.resolveEnvelope(original.record.origin)).toEqual({ status: "unavailable" });
      }
    },
    30_000,
  );
  it.each(["access", "oauth", "token", "hex"] as const)(
    "admits the actual %s MCP account through Node and the original-owner installation",
    async (mode) => {
      const s = await ssoInstallation(mode);
      const args = { text: "memory forget", idempotencyKey: "sso-original", async: mode === "oauth" };
      const { status, wire } = await s.send(args);
      expect(status).toBe(200);
      expect(wire).toMatchObject({
        result: {
          structuredContent: { admission: { status: "accepted", duplicate: false, runId: expect.any(String) } },
        },
      });
      const owner = wire.result.structuredContent.admission.runId;
      const recorded = await s.ledger.readIngressByRun(owner);
      expect(recorded).toMatchObject({
        status: "record",
        record: {
          runId: owner,
          origin: {
            source: "mcp",
            actor: {
              kind: mode === "access" || mode === "oauth" ? "human" : "service",
              identity: {
                issuer:
                  mode === "access" || mode === "oauth"
                    ? "installation:fixture:mcp:sso:access:1590d5d5850c04f3296f06c6e543f78f50e879a2af4ab563ba42463236480951"
                    : "installation:fixture:mcp:sso:token:21c1e4447cfed904f1338046ae18106ffa5483cafd7afbc057dd4c46fb68a699",
                subject: "alice",
              },
            },
            sourceReference: {
              actorId: "access:alice",
              userId: "access:alice",
              authenticatedAs: "access:alice",
              channelId: "mcp:default",
              threadKey: "mcp:default:default",
            },
          },
        },
      });
      if (recorded.status !== "record" || !recorded.record.origin) throw new Error("Missing original owner");
      expect(recorded.record.origin.actor.stream === null).toBe(mode === "token" || mode === "hex");
      for (const credential of s.credentials) expect(JSON.stringify(recorded)).not.toContain(credential);
      expect(JSON.stringify(recorded.record.origin)).not.toContain("slack:UALICE");
      expect(await s.send(args)).toMatchObject({
        wire: { result: { structuredContent: { admission: { status: "accepted", duplicate: true, runId: owner } } } },
      });
      expect(await s.send({ ...args, text: "changed text" })).toMatchObject({
        wire: { result: { structuredContent: { admission: { status: "conflict" } }, isError: true } },
      });
      await s.execute();
      expect(s.effects).toEqual(["access:alice"]);
      expect(s.nativeReplies).toEqual(["Read-only command completed."]);
      const savedRun = await s.runStore.get(owner);
      expect(savedRun).toMatchObject({
        userId: "access:alice",
      });
      if (mode === "access" || mode === "oauth") expect(savedRun).toMatchObject({ requesterProfileId: "slack:UALICE" });
      else expect(savedRun?.requesterProfileId).toBeUndefined();
      expect(await s.send(args)).toMatchObject({
        wire: { result: { structuredContent: { admission: { status: "accepted", duplicate: true, runId: owner } } } },
      });
      expect(s.effects).toEqual(["access:alice"]);
    },
  );
  it("records the verified Access email on an MCP run when no Slack profile matches", async () => {
    const s = await ssoInstallation("access", undefined, undefined, async () => undefined);
    const { wire } = await s.send({ text: "memory forget", idempotencyKey: "unmatched-profile" });
    const id = wire.result.structuredContent.admission.runId;
    await s.execute();
    expect(await s.runStore.get(id)).toMatchObject({
      userId: "access:alice",
      userName: "alice@example.test",
      authenticatedAs: "access:alice",
    });
  });
  describe("native admission recovery", () => {
    it.each([
      ["different-credential", "unavailable"],
      ["foreign-subject", "denied"],
      ["foreign-issuer", "denied"],
      ["foreign-tenant", "denied"],
      ["foreign-credential-binding", "denied"],
      ["foreign-actor", "denied"],
      ["foreign-connection", "denied"],
      ["expired", "denied"],
      ["revoked", "denied"],
    ] as const)("keeps %s fenced after verifier lookup", async (change, status) => {
      const s = await ssoInstallation("access");
      const first = await s.send({ text: "memory forget", idempotencyKey: "negative-original" });
      const id = first.wire.result.structuredContent.admission.runId;
      const original = await s.ledger.readIngressByRun(id);
      if (original.status !== "record" || !original.record.origin?.sourceReference) throw new Error("No original");
      const origin = original.record.origin;
      const reference = structuredClone(origin.sourceReference!);
      const sourceIdentity = structuredClone(origin.actor.identity);
      if (change === "different-credential") {
        reference.credentialDigest = "a".repeat(64);
        reference.approvalConnection!.id = reference.credentialDigest;
      }
      if (change === "foreign-subject") sourceIdentity.subject = "foreign";
      if (change === "foreign-issuer") sourceIdentity.issuer = "https://foreign.test";
      if (change === "foreign-tenant") sourceIdentity.tenant = "foreign";
      if (change === "foreign-credential-binding") reference.approvalConnection!.credentialId = "access:foreign";
      if (change === "foreign-actor") reference.actorId = "access:foreign";
      if (change === "foreign-connection") reference.approvalConnection!.id = "b".repeat(64);
      if (change === "expired") s.expireSession();
      if (change === "revoked")
        vi.spyOn(s.options.sso!, "verify").mockResolvedValue({ ok: false, status: 403, body: "revoked fixture" });
      expect(await s.authentication.evaluateSourceIdentity(sourceIdentity, reference)).toEqual({ status });
      expect(await s.ledger.readIngressByRun(id)).toMatchObject({
        status: "record",
        record: { runId: id, status: "dispatching", outcome: null },
      });
      expect(s.effects).toEqual([]);
    });
    it.each(["fenced", "conflict"] as const)("does not replace an explicit final %s with a receipt", async (status) => {
      const s = await ssoInstallation("access");
      const execute = s.store.execute.bind(s.store);
      let admitted = false;
      vi.spyOn(s.store, "execute").mockImplementation(async (command) => {
        const result = await execute(command);
        if (command.action === "admit" && result.status === "receipt") admitted = true;
        if (admitted && command.action === "submission") return { status };
        return result;
      });
      const result = await s.send({ text: "memory forget", idempotencyKey: "explicit-final" });
      expect(result.wire.result).toMatchObject({ isError: true, structuredContent: { admission: { status } } });
      expect(result.wire.result.structuredContent.admission.receiptId).toBeUndefined();
      expect(s.tasks).toHaveLength(1);
      expect(s.effects).toEqual([]);
    });
    it("retains an explicit final denial after the credential is revoked during admission", async () => {
      const s = await ssoInstallation("access");
      const execute = s.store.execute.bind(s.store);
      let receiptObserved = false;
      vi.spyOn(s.store, "execute").mockImplementation(async (command) => {
        const result = await execute(command);
        if (command.action === "admit" && result.status === "receipt") {
          receiptObserved = true;
          vi.spyOn(s.options.sso!, "verify").mockResolvedValue({ ok: false, status: 403, body: "revoked fixture" });
        }
        return result;
      });
      const result = await s.send({ text: "memory forget", idempotencyKey: "revoked-after-admit" });
      expect(receiptObserved).toBe(true);
      expect(result.wire.result).toMatchObject({
        isError: true,
        structuredContent: {
          admission: { status: "not_found" },
          diagnostic: { receiptObserved: true },
        },
      });
      expect(result.wire.result.structuredContent.admission.receiptId).toBeUndefined();
      expect(s.tasks).toEqual([]);
      expect(s.effects).toEqual([]);
    });
    it("rebuilds current grants for the immutable original context after cached verification", async () => {
      const s = await ssoInstallation("access");
      const first = await s.send({
        text: "memory forget",
        thread: "original-context",
        idempotencyKey: "grant-original",
      });
      const id = first.wire.result.structuredContent.admission.runId;
      const original = await s.ledger.readIngressByRun(id);
      if (original.status !== "record" || !original.record.origin?.sourceReference) throw new Error("No original");
      const before = await s.authentication.resolveEnvelope(original.record.origin);
      if (before.status !== "resolved") throw new Error("No verified source");
      const repo = { type: "repo" as const, owner: "sample", name: "api" };
      expect(authorize(before.actor, "repo:use", repo).allow).toBe(true);
      s.setSourceGrants(NO_GRANTS);
      const current = await s.authentication.resolveEnvelope(original.record.origin);
      if (current.status !== "resolved") throw new Error("No current native proof");
      expect(current.actor.origin).toEqual({
        channelId: original.record.origin.sourceReference.channelId,
        threadKey: original.record.origin.sourceReference.threadKey,
      });
      expect(current.actor.grants).toEqual(NO_GRANTS);
      expect(authorize(current.actor, "repo:use", repo)).toMatchObject({ allow: false });
      expect(await s.ledger.readIngressByRun(id)).toMatchObject({
        status: "record",
        record: { origin: original.record.origin, status: "dispatching" },
      });
      expect(s.effects).toEqual([]);
    });
    it("retains renewed-credential history and returns its actual admission trace", async () => {
      const s = await ssoInstallation("access");
      const log = createSpanLog();
      s.core.spanLog = log;
      const first = await s.send({ text: "memory forget", idempotencyKey: "rotation-original" });
      const id = first.wire.result.structuredContent.admission.runId;
      const original = await s.ledger.readIngressByRun(id);
      if (original.status !== "record" || !original.record.origin?.sourceReference) throw new Error("No original");
      const native = createOrganizationNativeSources(s.nativeOptions);
      let verified = false;
      s.replaceMcpVerifier(async (...args) => {
        const proof = await native.currentMcp(...args);
        if (args[1] && proof.status === "verified") verified = true;
        return proof;
      });
      let current: import("../core/types.js").IncomingMessage | undefined;
      const admit = s.options.admit!;
      const result = await s.send(
        { text: "private trace input", idempotencyKey: "rotation-fresh" },
        s.rotatedHeaders(),
        "dispatch",
        {
          ...s.options,
          admit: async (message, ...args) => {
            current = message;
            return admit(message, ...args);
          },
        },
      );
      expect(verified).toBe(true);
      expect(current!.approvalConnection!.id).not.toBe(original.record.origin.sourceReference.credentialDigest);
      expect(result.wire.result).toMatchObject({
        structuredContent: { admission: { status: "accepted" } },
      });
      const latest = log.read().lines.at(-1)!;
      expect.soft(result.wire.result.structuredContent).toMatchObject({
        diagnostic: {
          traceId: latest.traceId,
          stage: "refresh",
          receiptObserved: true,
        },
      });
      expect.soft(latest).toMatchObject({
        span: "request",
        status: "ok",
        attrs: { outcome: "accepted", admissionStage: "refresh", receiptObserved: true },
      });
      let responseStatus = 0,
        body = "";
      handleAdminTraceLog(
        {
          method: "GET",
          url: `${TRACE_LOG_PATH}?traceId=${latest.traceId}`,
          headers: { authorization: "Bearer fixture-reader" },
        } as IncomingMessage,
        {
          writeHead: (status: number) => {
            responseStatus = status;
          },
          end: (value: string) => {
            body = value;
          },
        } as unknown as ServerResponse,
        {
          spanLog: log,
          tokens: new Secret(JSON.stringify({ "fixture-reader": { subject: "reader" } }), "SWITCHBOARD_INGRESS_TOKENS"),
          grantsFor: () => ({ actions: new Set(["trace:read"]), channels: new Set(), repos: new Set() }),
        },
      );
      expect(responseStatus).toBe(200);
      const readback = JSON.parse(body) as { ok: boolean; lines: { traceId: string }[] };
      expect.soft(readback).toMatchObject({
        ok: true,
        lines: expect.arrayContaining([
          expect.objectContaining({
            span: "request",
            status: "ok",
            attrs: expect.objectContaining({ admissionStage: "refresh" }),
          }),
        ]),
      });
      expect(readback.lines.every((line) => line.traceId === latest.traceId)).toBe(true);
      expect(body).not.toContain("private trace input");
      for (const credential of s.credentials) expect(body).not.toContain(credential);
      expect(await s.ledger.readIngressByRun(id)).toMatchObject({
        status: "record",
        record: { runId: id, status: "dispatching" },
      });
      expect(await s.authentication.resolveEnvelope(original.record.origin)).toEqual({ status: "unavailable" });
      expect(s.effects).toEqual([]);
    });
    it.each(["plain", "transport"] as const)("returns the actual trace for a %s admission exception", async (kind) => {
      const s = await ssoInstallation("access");
      const log = createSpanLog();
      s.core.spanLog = log;
      const result = await s.send({ text: "private input", idempotencyKey: "exception" }, {}, "dispatch", {
        ...s.options,
        admit: async () => {
          const error = new Error("private exception TOKEN=private-credential");
          throw kind === "transport" ? classifyError(error, { kind: "transport" }) : error;
        },
      });
      const line = log.read().lines.at(-1)!;
      expect(result.wire.result).toMatchObject({
        isError: true,
        structuredContent: {
          admission: { status: "unavailable" },
          diagnostic: { traceId: line.traceId, reason: "exception", receiptObserved: false },
        },
      });
      expect(line).toMatchObject({
        span: "request",
        status: "error",
        attrs: {
          outcome: "exception",
          admissionExceptionKind: kind === "transport" ? "transport" : "unclassified-exception",
        },
      });
      expect(JSON.stringify(result.wire)).not.toContain("private exception");
      expect(JSON.stringify(log.read())).not.toContain("private-credential");
      expect(s.tasks).toEqual([]);
    });
    it("keeps concurrent unavailable traces on their own requests", async () => {
      const s = await ssoInstallation("access");
      const log = createSpanLog();
      s.core.spanLog = log;
      let release: () => void = () => {},
        entered = 0;
      const together = new Promise<void>((resolve) => {
        release = resolve;
      });
      const options: McpOptions = {
        ...s.options,
        admit: async (message, _io, _evidence, _choice, trace) => {
          trace?.span?.setAttrs({ admissionStage: message.text === "private one" ? "native-proof" : "source-lookup" });
          if (++entered === 2) release();
          await together;
          return { status: "unavailable" };
        },
      };
      const [a, b] = await Promise.all([
        s.send({ text: "private one", idempotencyKey: "one" }, {}, "dispatch", options),
        s.send({ text: "private two", idempotencyKey: "two" }, {}, "dispatch", options),
      ]);
      expect
        .soft(a.wire.result.structuredContent)
        .toMatchObject({ diagnostic: { stage: "native-proof", receiptObserved: false } });
      expect
        .soft(b.wire.result.structuredContent)
        .toMatchObject({ diagnostic: { stage: "source-lookup", receiptObserved: false } });
      expect
        .soft(a.wire.result.structuredContent.diagnostic?.traceId)
        .not.toBe(b.wire.result.structuredContent.diagnostic?.traceId);
      expect(a.wire.result).toMatchObject({ isError: true, content: [{ text: "Admission could not be confirmed." }] });
      expect(JSON.stringify(log.read())).not.toContain("private one");
      expect(JSON.stringify(log.read())).not.toContain("private two");
    });
    it.each(["sync", "async", "mutation"] as const)(
      "a %s trace observer failure cannot change admission or execution",
      async (mode) => {
        const s = await ssoInstallation("access");
        const admit = s.options.admit!;
        const result = await s.send({ text: "memory forget", idempotencyKey: "report-failure" }, {}, "dispatch", {
          ...s.options,
          admit: async (message, io, evidence, choice, trace) => {
            if (!trace?.span) return admit(message, io, evidence, choice, trace);
            const set = trace.span.setAttrs.bind(trace.span);
            trace.span.setAttrs = (attrs) => {
              if (mode === "mutation") {
                Reflect.set(attrs, "organizationReceiptId", "wrong-receipt");
                return set(attrs);
              }
              if (mode === "sync") throw new Error("private observer failure");
              return Promise.reject(new Error("private observer failure"));
            };
            return admit(message, io, evidence, choice, trace);
          },
        });
        expect(result.wire.result).toMatchObject({ structuredContent: { admission: { status: "accepted" } } });
        expect(s.tasks).toHaveLength(1);
        await s.execute();
        expect(s.effects).toEqual(["access:alice"]);
      },
    );

    it.each(["store", "native-proof", "store-exception", "classified-store"] as const)(
      "retains an observed receipt when only the final refresh is unavailable: %s",
      async (failure) => {
        const s = await ssoInstallation("access");
        const log = createSpanLog();
        s.core.spanLog = log;
        let first: import("../core/organization/contract.js").OrganizationReceipt | undefined;
        let final: import("../core/organization/contract.js").OrganizationReceipt | undefined;
        let lost = false;
        const execute = s.store.execute.bind(s.store);
        vi.spyOn(s.store, "execute").mockImplementation(async (command) => {
          const result = await execute(command);
          if (command.action === "admit" && result.status === "receipt") first = structuredClone(result.receipt);
          if (command.action === "submission" && first && !lost && result.status === "submission") {
            lost = true;
            final = structuredClone(result.receipt);
            if (failure === "store") return { status: "unavailable" };
            if (failure === "store-exception") throw new Error("private store failure details");
            if (failure === "classified-store")
              throw classifyError(new Error("private store failure details"), { kind: "transport" });
            s.fault(true);
          }
          return result;
        });
        const sent = await s.send({ text: "memory forget", thread: "receipt-red", idempotencyKey: "receipt-red" });
        expect(first).toMatchObject({ status: "pending" });
        expect(final).toMatchObject({ id: first!.id, status: "accepted", ownerRunId: expect.any(String) });
        expect.soft(sent.wire).toMatchObject({
          result: {
            structuredContent: {
              admission: {
                status: "pending",
                receiptId: first!.id,
                duplicate: false,
              },
            },
          },
        });
        expect(s.tasks).toHaveLength(1);
        expect(log.read().lines.at(-1)).toMatchObject({
          span: "request",
          attrs: {
            admissionStage: "refresh",
            admissionReason: "refresh-unavailable",
            receiptObserved: true,
            organizationReceiptId: first!.id,
            admissionRefreshFailure:
              failure === "store"
                ? "unavailable-result"
                : failure === "classified-store"
                  ? "transport"
                  : "unclassified-exception",
          },
        });
        expect(JSON.stringify(log.read())).not.toContain("private store failure details");
        expect(s.effects).toEqual([]);
        s.fault(false);
        await s.execute();
        expect(s.effects).toEqual(["access:alice"]);
        expect(s.nativeReplies).toEqual(["Read-only command completed."]);
        expect(s.tasks).toEqual([]);
      },
    );
    it.each(["same-thread", "new-thread"] as const)(
      "fresh exact-credential SSO admission survives retained authority after restart: %s",
      async (context) => {
        const s = await ssoInstallation("access");
        const first = await s.send({
          text: "memory forget",
          thread: "restart-red",
          idempotencyKey: "restart-red-original",
        });
        const ownerId = first.wire.result.structuredContent.admission.runId;
        const original = await s.ledger.readIngressByRun(ownerId);
        if (original.status !== "record" || !original.record.origin?.sourceReference)
          throw new Error("No original fixture owner");
        const origin = original.record.origin;
        const reference = origin.sourceReference!;
        const native = createOrganizationNativeSources(s.nativeOptions);
        let freshSignedProof = false;
        s.replaceMcpVerifier(async (...args) => {
          const result = await native.currentMcp(...args);
          if (args[1] && result.status === "verified") freshSignedProof = true;
          return result;
        });
        expect(await s.authentication.resolveEnvelope(origin)).toEqual({ status: "unavailable" });
        let currentMessage: import("../core/types.js").IncomingMessage | undefined;
        const admit = s.options.admit!;
        const fresh = await s.send(
          {
            text: "memory forget",
            thread: context === "same-thread" ? "restart-red" : "restart-red-new",
            idempotencyKey: "restart-red-fresh",
          },
          {},
          "dispatch",
          {
            ...s.options,
            admit: async (message, ...args) => {
              currentMessage = message;
              return admit(message, ...args);
            },
          },
        );
        expect(freshSignedProof).toBe(true);
        expect(currentMessage?.approvalConnection?.id).toBe(reference.credentialDigest);
        expect(currentMessage?.approvalConnection?.requestHash).not.toBe(reference.approvalConnection?.requestHash);
        expect(await native.currentMcp(origin.actor.identity, undefined, reference)).toMatchObject({
          status: "verified",
          actorId: "access:alice",
        });
        expect(
          await native.currentMcp(origin.actor.identity, undefined, {
            ...reference,
            channelId: currentMessage!.channelId,
            threadKey: currentMessage!.threadKey,
            approvalConnection: currentMessage!.approvalConnection,
          }),
        ).toMatchObject({ status: "verified", actorId: "access:alice" });
        const machine = await handleIngressRequest(
          {
            method: "POST",
            headers: { authorization: "Bearer native-token" },
            body: JSON.stringify({
              text: "memory forget",
              channel: "ops",
              thread: "machine-red",
              async: true,
              idempotencyKey: "machine-red",
            }),
          },
          s.core,
          { auth: { tokens: s.tokens }, admit: s.options.admit },
        );
        expect(machine.status).toBe(202);
        expect(machine.body).toMatchObject({ admission: { status: "accepted", runId: expect.any(String) } });
        expect(await s.ledger.readIngressByRun(ownerId)).toMatchObject({
          status: "record",
          record: {
            runId: ownerId,
            status: "dispatching",
            outcome: null,
            origin,
          },
        });
        expect(s.effects).toEqual([]);
        expect.soft(fresh.wire).toMatchObject({ result: { structuredContent: { admission: { status: "accepted" } } } });
      },
    );
  });
  it("holds the original SSO owner on current proof outage and refuses expired proof without another actor", async () => {
    const s = await ssoInstallation("access");
    const { wire } = await s.send({ text: "memory forget", idempotencyKey: "sso-held" });
    const owner = wire.result.structuredContent.admission.runId;
    const saved = await s.ledger.readIngressByRun(owner);
    if (saved.status !== "record" || !saved.record.origin) throw new Error("Missing original owner");
    s.fault(true);
    expect(await s.authentication.resolveEnvelope(saved.record.origin)).toEqual({ status: "unavailable" });
    expect(await s.send({ text: "memory forget", idempotencyKey: "sso-held" })).toMatchObject({ status: 503 });
    s.fault(false);
    expect(await s.authentication.resolveEnvelope(saved.record.origin)).toMatchObject({
      status: "resolved",
      actor: { id: "access:alice" },
    });
    s.expireSession();
    expect(await s.authentication.resolveEnvelope(saved.record.origin)).toEqual({ status: "fenced" });
    expect(await s.send({ text: "memory forget", idempotencyKey: "sso-held" })).toMatchObject({ status: 401 });
    await s.execute();
    expect(await s.ledger.readIngressByRun(owner)).toMatchObject({
      status: "record",
      record: { runId: owner, status: "completed" },
    });
    expect(s.effects).toEqual([]);
  });
  it("keeps static and personal MCP credentials authoritative beside valid Access SSO", async () => {
    const s = await ssoInstallation("access");
    for (const [authorization, actor, key] of [
      ["Bearer native-token", "mcp:bot", "static-original"],
      [`Bearer ${"c".repeat(64)}`, "mcp:personal:alice", "personal-original"],
    ]) {
      const { wire } = await s.send({ text: "memory forget", idempotencyKey: key }, { authorization });
      expect(wire).toMatchObject({
        result: { structuredContent: { admission: { status: "accepted", duplicate: false } } },
      });
      const owner = wire.result.structuredContent.admission.runId;
      const record = await s.ledger.readIngressByRun(owner);
      expect(record).toMatchObject({
        status: "record",
        record: {
          origin: {
            actor: { kind: "service", identity: { issuer: "installation:fixture:mcp" } },
            sourceReference: { actorId: actor },
          },
        },
      });
      await s.execute();
    }
    expect(s.effects).toEqual(["mcp:bot", "mcp:personal:alice"]);
    await s.personalTokens.delete(digestBearer("c".repeat(64)), "personal:alice");
    expect(
      await s.send(
        { text: "memory forget", idempotencyKey: "revoked-original" },
        { authorization: `Bearer ${"c".repeat(64)}` },
      ),
    ).toMatchObject({ status: 401 });
    expect(s.effects).toEqual(["mcp:bot", "mcp:personal:alice"]);
  });
  it.each([false, true])(
    "retains the original SSO receipt after an uncertain Node response (async %s)",
    async (async) => {
      const s = await ssoInstallation("oauth");
      let first = true;
      const options = {
        ...s.options,
        admit: async (...args: Parameters<NonNullable<McpOptions["admit"]>>) => {
          const result = await s.options.admit!(...args);
          if (first) {
            first = false;
            throw new Error("response interrupted after admission");
          }
          return result;
        },
      };
      const args = { text: "memory forget", idempotencyKey: "lost-response", async };
      const lost = await s.send(args, {}, "dispatch", options);
      expect(lost.wire.result?.isError ?? !!lost.wire.error).toBe(true);
      expect(s.tasks).toHaveLength(1);
      const retry = await s.send(args, {}, "dispatch", options);
      expect(retry.wire).toMatchObject({
        result: {
          structuredContent: { admission: { status: "accepted", duplicate: true, runId: expect.any(String) } },
        },
      });
      expect(s.tasks).toHaveLength(1);
      await s.execute();
      expect(s.effects).toEqual(["access:alice"]);
      expect(s.nativeReplies).toEqual(["Read-only command completed."]);
    },
  );
  it("preserves actual SSO registry reads without giving the durable owner an email alias", async () => {
    const s = await ssoInstallation("access");
    expect(await s.send({}, {}, "memory_forget")).toMatchObject({
      wire: {
        result: { content: [{ type: "text", text: 'memory.forget: ok\n{"text":"Read-only command completed."}' }] },
      },
    });
    expect(s.effects).toEqual(["access:alice"]);
    expect(s.tasks).toHaveLength(0);
  });
  it("keeps browser history readable and holds an SSO original after adapter restart", async () => {
    const s = await ssoInstallation("access");
    const sent = await s.send({ text: "memory forget", idempotencyKey: "restart-proof" });
    const owner = sent.wire.result.structuredContent.admission.runId;
    const saved = await s.ledger.readIngressByRun(owner);
    if (saved.status !== "record" || !saved.record.origin) throw new Error("Missing original owner");
    expect(
      await s.authentication.evaluateSourceIdentity(identity, s.context.authentication.sourceReference),
    ).toMatchObject({ status: "allowed" });
    const freshNative = createOrganizationNativeSources(s.nativeOptions);
    const afterRestart = createOrganizationAuthentication({
      organization: "fixture",
      store: s.store,
      directory: s.store.directory,
      auth: () => ({ tokens: s.tokens }),
      personalTokens: s.personalTokens,
      grantsFor: () => ALL_GRANTS,
      mappings: [
        { source: "mcp", issuer: "installation:fixture:mcp", tenant: null, organization: "fixture" },
        { source: "mcp", issuer: freshNative.mcpIssuer, tenant: null, organization: "fixture" },
      ],
      currentBrowser: freshNative.currentBrowser,
      currentSlack: freshNative.currentSlack,
      currentMcp: freshNative.currentMcp,
    });
    expect(await afterRestart.resolveEnvelope(saved.record.origin)).toEqual({ status: "unavailable" });
    expect(await s.authentication.resolveEnvelope(saved.record.origin)).toMatchObject({
      status: "resolved",
      actor: { id: "access:alice" },
    });
    expect(s.effects).toEqual([]);
  });
  it("keeps ordinary SSO form consent on its original connection with production admission installed", async () => {
    const s = await ssoInstallation("token");
    let changed = 0;
    const registry = new CommandRegistry({ audit: () => {} });
    registry.register({
      id: "repo.offboard",
      action: "repo:write",
      effect: "write",
      annotations: { destructive: true },
      describe: "Remove the fixture repository",
      handler: async () => ({ removed: ++changed }),
    });
    const bound = bindCommands(registry, {});
    s.core.commands = bound;
    const options = { ...s.options, commands: bound };
    const meta = {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: FORM_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: "fixture-client", version: "1" },
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
    };
    const offered = await s.send({}, {}, "repo_offboard", options, meta);
    expect(offered.wire).toMatchObject({ result: { inputRequests: { approval: { params: { mode: "form" } } } } });
    expect(changed).toBe(0);
    const consent = {
      ...meta,
      requestState: offered.wire.result.requestState,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    };
    expect(
      await s.send({}, { authorization: "Bearer another-session" }, "repo_offboard", options, consent),
    ).toMatchObject({ status: 401 });
    expect(changed).toBe(0);
    const done = await s.send({}, {}, "repo_offboard", options, consent);
    expect(done.wire).toMatchObject({ result: { content: [{ text: expect.stringContaining("removed: 1") }] } });
    expect(changed).toBe(1);
    expect(await s.send({}, {}, "repo_offboard", options, consent)).toMatchObject({
      wire: { error: { code: -32001 } },
    });
    expect(changed).toBe(1);
    expect(s.tasks).toHaveLength(0);
  });
  it("keeps an SSO native saved choice on the actual Access owner and replays its consumed receipt", async () => {
    const s = await ssoInstallation("access", {
      name: "fixture",
      complete: async () => ({
        content: [{ type: "text", text: "Original source A answer." }],
        stopReason: "end_turn",
      }),
    });
    const meta = {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: FORM_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: "fixture-client", version: "1" },
        [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
      },
    };
    const first = await s.send(
      { text: "agent:general Record the original source", idempotencyKey: "sso-offer" },
      {},
      "dispatch",
      s.options,
      meta,
    );
    const owner = first.wire.result.structuredContent.admission.runId;
    await s.execute();
    const original = await s.installation.originalBinding(owner);
    if (!original) throw new Error("Missing saved source owner");
    const id = "00000000-0000-4000-8000-000000000012";
    const row = await s.confirmations.put(
      {
        kind: "redispatch",
        id,
        message: { ...original.msg, text: "memory forget" },
        line: "memory forget",
        evidence: "Explicit saved fixture action",
        code: "fixture",
      },
      DAY_MS,
    );
    expect(row.originalOrganization?.ingressRunId).toBe(owner);
    const consent = {
      ...meta,
      requestState: id,
      inputResponses: { approval: { action: "accept", content: { decision: "approve" } } },
    };
    const choice = await s.send({ id }, {}, "approval_resume", s.options, consent);
    expect(choice.wire).toMatchObject({
      result: { structuredContent: { admission: { status: "accepted", duplicate: false, runId: expect.any(String) } } },
    });
    const choiceOwner = choice.wire.result.structuredContent.admission.runId;
    expect(choiceOwner).not.toBe(owner);
    await s.execute();
    expect(await s.ledger.readIngressByRun(choiceOwner)).toMatchObject({
      status: "record",
      record: { status: "completed" },
    });
    expect(s.nativeReplies).toEqual(["Original source A answer.", "Read-only command completed."]);
    expect(s.effects).toEqual(["access:alice"]);
    expect(await s.send({ id }, {}, "approval_resume", s.options)).toMatchObject({
      wire: {
        result: { structuredContent: { admission: { status: "accepted", duplicate: true, runId: choiceOwner } } },
      },
    });
    expect(s.effects).toEqual(["access:alice"]);
  });
  it.each([
    "retained",
    "body",
    "context",
    "other active owner",
    "completed",
    "expired",
    "revoked",
    "replacement owner",
    "sequence",
  ] as const)("keeps fresh machine history bound to its original source: %s", async (state) => {
    const s = await fixture();
    const send = (key: string) =>
      handleIngressRequest(
        {
          method: "POST",
          headers: { authorization: "Bearer native-token" },
          body: JSON.stringify({ text: "memory forget", idempotencyKey: key }),
        },
        s.core,
        { auth: { tokens: s.tokens }, admit: (msg, _io, evidence) => s.installation.admitNative(msg, evidence) },
      );
    expect((await send("prior-history")).status).toBe(202);
    await s.execute();
    const next = await send("fresh-history");
    expect(next.status).toBe(202);
    const id = (next.body as { runId: string }).runId;
    const binding = await s.installation.originalBinding(id);
    if (!binding) throw new Error("No fresh machine binding");
    expect(binding.originalStatus).toBe("dispatching");
    let message = binding.msg;
    if (state === "body") message = { ...message, text: "different original bytes" };
    if (state === "sequence")
      message = withOriginalOrganizationDispatch(message, {
        ingressRunId: id,
        organizationSequence: binding.receipt.revision + 1,
      });
    if (state === "other active owner") {
      const other = await send("different-owner");
      const owned = await s.installation.originalBinding((other.body as { runId: string }).runId);
      if (!owned) throw new Error("No distinct active owner");
      expect(owned.originalStatus).toBe("dispatching");
      expect(owned.actor.id).toBe(binding.actor.id);
      expect(owned.runId).not.toBe(id);
      message = owned.msg;
    }
    if (state === "completed") await s.execute();
    if (state === "expired") s.expire();
    if (state === "revoked") delete (s.tokens as Record<string, unknown>)["native-token"];
    if (state === "context") {
      const read = s.ledger.readIngressByRun.bind(s.ledger);
      vi.spyOn(s.ledger, "readIngressByRun").mockImplementation(async (runId) => {
        const result = await read(runId);
        if (runId !== id || result.status !== "record" || !result.record.request) return result;
        return {
          ...result,
          record: {
            ...result.record,
            request: {
              ...result.record.request,
              envelope: {
                ...(result.record.request.envelope as object),
                context: [{ kind: "run", key: "foreign-context" }],
              },
            },
          },
        };
      });
    }
    if (state === "replacement owner") {
      const execute = s.store.execute.bind(s.store);
      vi.spyOn(s.store, "execute").mockImplementation(async (command) => {
        const result = await execute(command);
        return command.action === "submission" &&
          result.status === "submission" &&
          result.receipt.id === binding.receipt.id
          ? { ...result, receipt: { ...result.receipt, ownerRunId: "replaced-owner" } }
          : result;
      });
    }
    const history = binding.io.authoritativePrivateHistory!(message);
    if (state === "retained")
      expect(await history).toMatchObject([
        { role: "user", text: "memory forget" },
        { role: "assistant", text: "Read-only command completed." },
      ]);
    else await expect(history).rejects.toThrow("original machine input");
  });
  it("checks an active native HTTP Review without requiring recovery custody", async () => {
    const url = "https://github.com/sample/api/pull/42";
    const head = "a".repeat(40);
    const s = await fixture(
      false,
      false,
      {
        name: "fixture",
        complete: async () => ({
          content: [
            {
              type: "tool_use",
              id: "route-review",
              name: "bind_preset",
              input: {
                preset: "review",
                model: "anthropic/general-model",
                repo: "sample/api",
                prTarget: { number: 42, source: "request", quote: url },
                reason: "Review the requested change",
                settingsEvidence: operatorSettingsEvidence(),
              },
            },
          ],
          stopReason: "tool_use",
        }),
      },
      false,
      false,
      false,
      10,
      false,
      undefined,
      undefined,
      (core) => {
        core.fetchPrHead = async () => head;
        core.fetchPrBase = async () => ({ baseRef: "main", baseSha: "a".repeat(40) });
        core.resolveRepoContext = () => ({
          repo: "sample/api",
          ref: "patch-1",
          baseRef: "main",
          pr: 42,
          headSha: head,
        });
        core.fetchPrFacts = async () => ({
          state: "open",
          headRef: "patch-1",
          baseRef: "main",
          headSha: head,
          headBranchExists: true,
          sameRepoHead: true,
          verifiedHead: { repo: "sample/api", ref: "patch-1", sha: head },
        });
      },
    );
    s.core.config.config.routing!.operator = "on";
    const accepted = await handleIngressRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer native-token" },
        body: JSON.stringify({
          text: `agent:review Review ${url} at head ${head}. Publish the review.`,
          channel: "ops",
          thread: "service-review-proof",
          async: true,
          idempotencyKey: "service-review-proof",
        }),
      },
      s.core,
      { auth: { tokens: s.tokens }, admit: (msg, _io, evidence) => s.installation.admitNative(msg, evidence) },
    );
    expect(accepted.status).toBe(202);
    const receipt = (accepted.body as { admission: { status: string; runId: string } }).admission;
    expect(receipt.status).toBe("accepted");
    const binding = await s.installation.originalBinding(receipt.runId);
    if (!binding) throw new Error("No original service binding");
    expect(binding).toMatchObject({ originalStatus: "dispatching", actor: { id: "http:bot", kind: "service" } });
    expect(await binding.io.authoritativePrivateHistory!(binding.msg)).toEqual([]);
    expect(await binding.io.rehostOrganizationInput!(binding.msg)).toBeUndefined();
    // This proof stops after routing; it does not claim a published review.
    const executor = vi
      .spyOn(executorFactory, "makeExecutor")
      .mockRejectedValue(new Error("Controlled executor boundary stop"));
    try {
      await s.execute();
    } finally {
      executor.mockRestore();
    }
    expect(await s.runStore.get(receipt.runId)).toMatchObject({
      id: receipt.runId,
      operator: {
        outcome: "binds",
        binds: [expect.objectContaining({ preset: "review", repo: "sample/api" })],
        attempts: [{ outcome: "accepted" }],
      },
    });
  });

  it("routes the exported smoke answer through native HTTP to its original General owner", async () => {
    const modelRequests: import("../core/provider.js").CompletionRequest[] = [];
    const s = await fixture(false, false, {
      name: "fixture",
      complete: async (request) => {
        modelRequests.push(structuredClone(request));
        return { content: [{ type: "text", text: "4" }], stopReason: "end_turn" };
      },
    });
    s.core.config.config.defaults.efforts = { general: "high" };
    let first: { scenario: SmokeScenario; thread: string } | undefined;
    // Capture the exported smoke's authored request, without inventing a producer record.
    await runAgentSmoke({
      config: {
        disposable: true,
        channel: "ops",
        subject: "bot",
        repo: "sample/api",
        model: "anthropic/general-model",
        workspace: { path: "SMOKE.md", answer: "fixture" },
        review: { number: 42, head: "a".repeat(40) },
        maxObservedUsd: 1,
      },
      thread: "smoke-routing",
      transport: {
        health: async () => ({ commit: "b".repeat(40) }),
        request: async (scenario, thread) => {
          first = { scenario, thread };
          return {};
        },
        readRun: async () => {
          throw new Error("No admission during prompt capture");
        },
      },
    });
    if (!first) throw new Error("No authored smoke answer");
    const { scenario, thread: key } = first;
    const body = JSON.stringify({ text: scenario.text, channel: "ops", thread: key, async: true, idempotencyKey: key });
    const options = {
      auth: { tokens: s.tokens },
      admit: (
        msg: import("../core/types.js").IncomingMessage,
        _io: import("../core/types.js").ChannelIO,
        evidence: import("./organizationAuthentication.js").OrganizationNativeEvidence,
      ) => s.installation.admitNative(msg, evidence),
    };
    const post = () =>
      handleIngressRequest(
        { method: "POST", headers: { authorization: "Bearer native-token" }, body },
        s.core,
        options,
      );
    const accepted = await post();
    expect(accepted.status).toBe(202);
    const receipt = (accepted.body as { admission: { status: string; receiptId: string; runId: string } }).admission;
    expect(receipt.status).toBe("accepted");
    expect(await s.ledger.readIngressByRun(receipt.runId)).toMatchObject({
      status: "record",
      record: { status: "dispatching" },
    });
    const binding = await s.installation.originalBinding(receipt.runId);
    expect(binding).toMatchObject({
      originalStatus: "dispatching",
      actor: { id: "http:bot", kind: "service" },
      envelope: { actor: { stream: null } },
    });
    if (!binding) throw new Error("No original service binding");
    expect(await binding.io.authoritativePrivateHistory!(binding.msg)).toEqual([]);
    expect(await binding.io.rehostOrganizationInput!(binding.msg)).toBeUndefined();
    await s.execute();
    const original = await s.ledger.readIngressByRun(receipt.runId);
    expect(original).toMatchObject({
      status: "record",
      record: {
        runId: receipt.runId,
        receiptId: receipt.receiptId,
        status: "completed",
        requester: "http:bot",
        threadKey: "http:ops:smoke-routing-answer",
        request: { envelope: { content: scenario.text } },
      },
    });
    const record = await s.runStore.get(receipt.runId);
    expect(record).toMatchObject({
      id: receipt.runId,
      organizationIngressRunId: receipt.runId,
      userId: "http:bot",
      channelId: "http:ops",
      threadKey: "http:ops:smoke-routing-answer",
      agent: "general",
      model: "anthropic/general-model",
      status: "completed",
      profile: { minutes: 4 },
    });
    expect(record?.events.find((event) => event.type === "run_meta")).toMatchObject({ effort: "high" });
    expect(modelRequests).toHaveLength(1);
    expect(s.nativeReplies).toEqual(["4"]);
    const replay = await post();
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({
      admission: { status: "accepted", duplicate: true, receiptId: receipt.receiptId, runId: receipt.runId },
    });
    expect(modelRequests).toHaveLength(1);
    expect(s.tasks).toEqual([]);
    await expect(binding.io.authoritativePrivateHistory!(binding.msg)).rejects.toThrow("original machine input");
  });
  it("admits authenticated HTTP and MCP calls under their own durable owners without email stream joins", async () => {
    const s = await fixture();
    const admit = (
      msg: import("../core/types.js").IncomingMessage,
      _io: import("../core/types.js").ChannelIO,
      evidence: import("./organizationAuthentication.js").OrganizationNativeEvidence,
    ) => s.installation.admitNative(msg, evidence);
    const http = await handleIngressRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer native-token" },
        body: JSON.stringify({ text: "memory forget", idempotencyKey: "same-call" }),
      },
      s.core,
      { auth: { tokens: s.tokens }, admit },
    );
    expect(http.status).toBe(202);
    expect(http.body).toMatchObject({
      runId: expect.any(String),
      runUrl: expect.stringMatching(/^\/runs\//),
      threadKey: "http:ops:default",
    });
    expect(http.body).toMatchObject({ admission: { status: "accepted", duplicate: false, runId: expect.any(String) } });
    await s.execute();
    expect(s.effects).toEqual(["http:bot"]);
    expect(s.nativeReplies).toEqual(["Read-only command completed."]);
    const retried = await handleIngressRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer native-token" },
        body: JSON.stringify({ text: "memory forget", idempotencyKey: "same-call" }),
      },
      s.core,
      { auth: { tokens: s.tokens }, admit },
    );
    expect(retried.body).toMatchObject({ admission: { status: "accepted", duplicate: true } });
    expect(s.effects).toEqual(["http:bot"]);
    const conflict = await handleIngressRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer native-token" },
        body: JSON.stringify({ text: "different body", idempotencyKey: "same-call" }),
      },
      s.core,
      { auth: { tokens: s.tokens }, admit },
    );
    expect(conflict).toEqual({
      status: 409,
      body: {
        admission: { status: "conflict" },
        diagnostic: { traceId: expect.stringMatching(/^[0-9a-f]{32}$/), stage: "host", receiptObserved: false },
      },
    });
    const mcp = await handleMcpRequest(
      {
        method: "POST",
        headers: { authorization: "Bearer native-token" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "dispatch", arguments: { text: "memory forget", idempotencyKey: "mcp-call" } },
        }),
      },
      s.core,
      { auth: { tokens: s.tokens }, admit },
    );
    expect(mcp.body).toMatchObject({
      result: { structuredContent: { admission: { status: "accepted", duplicate: false, runId: expect.any(String) } } },
    });
    await s.execute();
    expect(s.effects).toEqual(["http:bot", "mcp:bot"]);
    const state = await s.store.execute({ action: "get", organization: "fixture" });
    expect(state.status).toBe("state");
    const native = await s.installation.organization.resolve({
      source: "http",
      identity: { issuer: "installation:fixture:http", tenant: null, subject: "bot" },
      kind: "service",
      organizations: ["fixture"],
    });
    expect(native?.actor.stream).toBeNull();
  });
  it("dispatches a private browser command through the real Core exactly once under its original ingress run", async () => {
    const s = await fixture();
    const home = (await s.request("GET", "/home/session")).body;
    const input = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" },
      text: "memory forget",
      context: [],
    };
    const sent = await s.request("POST", "/home/send", input);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("pending");
    await s.execute();
    const history = (await s.request("GET", "/home/session")).body;
    expect(history.entries.map((entry) => entry.content)).toContain("Read-only command completed.");
    const receipt = await s.installation.organization.replay(s.context.authentication, {
      key: input.key,
      revision: input.revision,
      destination: { kind: "broad" },
      content: "memory forget",
      context: [],
    });
    expect(receipt).toMatchObject({ status: "receipt", duplicate: true, receipt: { status: "accepted" } });
    if (receipt?.status !== "receipt") throw new Error("No retained receipt");
    expect(s.registry.getById(receipt.receipt.ownerRunId!)?.status).toBe("completed");
    expect(s.effects).toEqual(["access:alice"]);
    await s.request("POST", "/home/send", input);
    await s.installation.runtime.reconcile("fixture");
    expect(s.effects).toEqual(["access:alice"]);
  });
  it("answers the full saved question as one original-unit event and restores that exact event after restart", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const home = (await s.request("POST", "/home/focus", { thread })).body;
    expect(home.destination.canWrite).toBe(true);
    const sent = await s.request("POST", "/home/send", {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "thread", thread },
      text: "Proceed with this reviewed head",
      context: [],
    });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("pending");
    await s.execute();
    const events = await s.coordinator.listEvents({ instanceId: "fixture", unit: "original" });
    expect(events.map((event) => ({ text: event.text, sender: event.sender, id: event.id }))).toEqual([
      { text: "Proceed with this reviewed head", sender: "access:alice", id: `browser:${home.submissionKey}` },
    ]);
    const runId = events[0]!.organizationIngressRunId!;
    expect(await s.installation.readOriginalRun(runId)).toEqual({
      status: "completed",
      outcome: "Original answer recorded.",
    });
    expect(await s.installation.readOriginalRun("unknown-run")).toEqual({ status: "unknown" });
  });
  it("does not turn a readable assigned question into write permission when target policy denies replies", async () => {
    const s = await fixture();
    await s.seedQuestion();
    s.denyWrites();
    const read = await s.installation.readThread(s.context, thread);
    expect(read?.entries.map((entry) => entry.content).join("\n")).toContain(
      "Review requested for https://github.com/sample/api/pull/42.",
    );
    expect(read?.canWrite).toBe(false);
    expect((await s.request("POST", "/home/focus", { thread })).status).toBe(404);
  });
  it("keeps a consumed original run uncertain while native proof is missing and never launches it again", async () => {
    const s = await fixture();
    const home = (await s.request("GET", "/home/session")).body;
    await s.request("POST", "/home/send", {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" },
      text: "memory forget",
      context: [],
    });
    s.revoke();
    await s.execute();
    s.restoreSource();
    const prior = await s.installation.organization.replay(s.context.authentication, {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" },
      content: "memory forget",
      context: [],
    });
    expect(prior).toMatchObject({ status: "receipt", duplicate: true, receipt: { status: "accepted" } });
    if (prior?.status !== "receipt") throw new Error("No retained original owner");
    expect(await s.ledger.readIngress(prior.receipt.effectKey!)).toMatchObject({
      status: "record",
      record: {
        runId: prior.receipt.ownerRunId,
        status: "uncertain",
        outcome: "The original actor's current proof is unavailable.",
      },
    });
    await s.installation.runtime.reconcile("fixture");
    expect(await s.installation.readOriginalRun(prior.receipt.ownerRunId!)).toEqual({ status: "unknown" });
    expect(s.tasks).toEqual([]);
    expect(s.effects).toEqual([]);
  });
  it("refuses a changed complete question before its effect and preserves exact observed-revision replay", async () => {
    const s = await fixture();
    await s.seedQuestion();
    const home = (await s.request("POST", "/home/focus", { thread })).body;
    await s.request("POST", "/home/send", {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "thread", thread },
      text: "Answer original question",
      context: [],
    });
    seedCoordinatorUnit(s.coordinator, {
      ...unit,
      idle: { ...unit.idle!, humanGate: { ...unit.idle!.humanGate!, askedAt: 2000, headSha: "b".repeat(40) } },
    });
    await s.execute();
    const original = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "thread" as const, thread },
      content: "Answer original question",
      context: [],
    };
    expect(await s.installation.organization.replay(s.context.authentication, original)).toMatchObject({
      status: "receipt",
      duplicate: true,
      receipt: { status: "rejected" },
    });
    expect(
      await s.installation.organization.replay(s.context.authentication, {
        ...original,
        revision: original.revision + 1,
      }),
    ).toEqual({ status: "conflict" });
    expect(await s.coordinator.listEvents({ instanceId: "fixture", unit: "original" })).toEqual([]);
    expect(s.effects).toEqual([]);
  });
  it("consumes only the exact saved confirmation through the real Core and original ingress identity", async () => {
    const s = await fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    await s.confirmations.put(
      {
        kind: "run",
        id,
        message: {
          channelId: "web:alice",
          userId: "access:alice",
          threadKey: "web:alice:organization",
          text: "memory forget",
        },
        command: "memory.forget",
        input: { args: [], options: {} },
        receipt: "Run the saved fixture command",
        risk: "No external effect",
        model: "fixture/unused",
      },
      DAY_MS,
    );
    const home = (await s.request("GET", "/home/session")).body;
    expect(home.offer?.id).toBe(id);
    const input = {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" },
      confirmation: { kind: "confirm", id },
      context: [],
    };
    expect((await s.request("POST", "/home/send", input)).status).toBe(200);
    await s.execute();
    const original = await s.installation.organization.replay(s.context.authentication, {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "broad" },
      continuation: { kind: "confirm", id },
      content: "",
      context: [],
    });
    expect(original).toMatchObject({ status: "receipt", duplicate: true, receipt: { status: "accepted" } });
    if (original?.status !== "receipt") throw new Error("No original choice owner");
    expect(s.registry.getById(original.receipt.ownerRunId!)?.status).toBe("completed");
    expect(await s.confirmations.get(id)).toBeUndefined();
    expect(s.effects).toEqual(["access:alice"]);
    expect((await s.request("POST", "/home/send", input)).body.duplicate).toBe(true);
    expect(s.effects).toEqual(["access:alice"]);
  });
  it("uses a current two-source question proof without replacing the real browser credential or source", async () => {
    const s = await fixture(true);
    await s.seedQuestion();
    const home = (await s.request("POST", "/home/focus", { thread: s.targetThread })).body;
    expect(home.destination.canWrite).toBe(true);
    await s.request("POST", "/home/send", {
      key: home.submissionKey,
      revision: home.destination.revision,
      destination: { kind: "thread", thread: s.targetThread },
      text: "Answer as the proved requester",
      context: [],
    });
    await s.execute();
    const events = await s.coordinator.listEvents({ instanceId: "fixture", unit: "original" });
    expect(
      events.map((event) => ({ sender: event.sender, authenticatedAs: event.authenticatedAs, text: event.text })),
    ).toEqual([{ sender: "slack:UALICE", authenticatedAs: "access:alice", text: "Answer as the proved requester" }]);
    const prior = await s.ledger.readIngressByRun(events[0]!.organizationIngressRunId!);
    expect(prior).toMatchObject({
      status: "record",
      record: {
        origin: {
          source: "browser",
          actor: { identity },
          sourceReference: {
            actorId: "access:alice",
            userId: "slack:UALICE",
            authenticatedAs: "access:alice",
            channelId: "web:alice",
            threadKey: s.targetThread,
            messageId: `browser:${home.submissionKey}`,
            browserRevision: home.destination.revision,
            questionOwnership: {
              unitKey: "fixture:original",
              requester: { issuer: "https://slack.com", tenant: "fixture-team", subject: "UALICE" },
            },
          },
        },
      },
    });
    expect(s.context.actor.self).toEqual(["access:alice"]);
  });
  it("keeps proved source aliases inside the current raw permission predicate when native thread access is withdrawn", async () => {
    const s = await fixture(true);
    await s.seedQuestion();
    const visible = await s.request("POST", "/home/focus", { thread: s.targetThread });
    expect(visible.status).toBe(200);
    expect(visible.body.entries.map((entry) => entry.content).join("\n")).toContain("Original task");
    s.denyNativeReads();
    expect((await s.request("POST", "/home/focus", { thread: s.targetThread })).status).toBe(404);
    expect(s.context.actor.self).toEqual(["access:alice"]);
    expect(await s.coordinator.listEvents({ instanceId: "fixture", unit: "original" })).toEqual([]);
  });
  it("keeps queued native media without a durable receiver sequence uncertain after that receiver ends and reconciliation runs", async () => {
    const inputA = await nativeImageInput("Describe the first image", "1000.96");
    const inputB = await nativeImageInput("Describe the next image", "1000.97");
    let openReceiver!: () => void;
    const opened = new Promise<void>((resolve) => {
      openReceiver = resolve;
    });
    let endReceiver!: () => void;
    const ended = new Promise<void>((resolve) => {
      endReceiver = resolve;
    });
    let queuedText: string[] = [];
    let openings = 0;
    // The native transport boundary reports no acknowledgment for the queued
    // input. Separate harness tests exercise the actual OpenCode ACK handling.
    const receiver = vi.spyOn(PiHarness.prototype, "open").mockImplementation(async (_deps, run) => {
      openings++;
      openReceiver();
      await ended;
      queuedText = run.inbox!.drain().map((input) => input.text);
      run.inbox!.markUntrustedFollowUp();
      return {
        answer: "First request finished",
        followUp: async () => "Unused",
        remainingMs: () => 1000,
        end: async () => {},
      };
    });
    const provider: Provider = {
      name: "fixture",
      complete: async () => {
        throw new Error("The controlled receiver owns this input.");
      },
    };
    const s = await fixture(true, true, provider, false, false, false, 10, false, async () => ({
      images: [inputA.image],
    }));
    const first = await s.installation.admitNative(inputA.msg, inputA.evidence);
    expect(first.status).toBe("receipt");
    const running = s.execute();
    await opened;
    const noSequence = vi.spyOn(s.core.runLedger, "pushInbox").mockResolvedValue(undefined);
    try {
      const second = await s.installation.admitNative(inputB.msg, inputB.evidence);
      if (second.status !== "receipt" || !second.receipt.ownerRunId) throw new Error("No original queued owner");
      await s.execute();
      expect(noSequence).toHaveBeenCalledOnce();
      expect(await s.ledger.readIngressByRun(second.receipt.ownerRunId)).toMatchObject({
        status: "record",
        record: { status: "uncertain" },
      });
      endReceiver();
      await running;
      expect(queuedText).toEqual(["Describe the next image"]);
      expect(openings).toBe(1);
      await s.installation.runtime.reconcile("fixture");
      expect(s.tasks).toEqual([]);
      expect(await s.ledger.readIngressByRun(second.receipt.ownerRunId)).toMatchObject({
        status: "record",
        record: { status: "uncertain" },
      });
      expect(await s.installation.admitNative(inputB.msg, inputB.evidence)).toMatchObject({
        status: "receipt",
        duplicate: true,
        receipt: { ownerRunId: second.receipt.ownerRunId },
      });
      expect(openings).toBe(1);
      expect(s.tasks).toEqual([]);
    } finally {
      endReceiver();
      await running;
      noSequence.mockRestore();
      receiver.mockRestore();
    }
  });
});
