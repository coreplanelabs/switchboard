import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { onTestFinished } from "vitest";
import { ConfigStore } from "../../config.js";
import { SOURCE_READ_ELIGIBILITY_MS } from "../../core/budgets.js";
import { readTool } from "../../mcp/testing/sourceRead.js";
import type { SourceReadResponse } from "../../mcp/sourceReadProtocol.js";
import { ALL_GRANTS } from "../../core/authz/grants.js";
import { toolResultText } from "../../core/chatMessage.js";
import { unwrapUntrusted } from "../../core/untrusted.js";
import { capabilitiesFrom } from "../../core/capabilities.js";
import { buildCoreCommands } from "../../core/commandCatalogue.js";
import { createMainTaskStarter } from "../../core/coordinator/mainStart.js";
import { InMemoryCoordinatorInstanceStore } from "../../core/coordinator/instanceStore.js";
import { dispatch, type CoreDeps } from "../../core/dispatcher.js";
import { PiHarness } from "../../core/harness/pi/piHarness.js";
import { OpenCodeHarness } from "../../core/harness/opencode/harness.js";
import { scriptPiFromProvider } from "../../core/harness/pi/testing/providerPi.js";
import { HarnessRegistry } from "../../core/harness/pi/relay.js";
import { FakeHarnessContainer } from "../../core/harness/testing/fakeContainer.js";
import { NullMemoryStore } from "../../core/memory/index.js";
import { GitBindings } from "../../core/modelProxy/gitBindings.js";
import { RunBearerStore } from "../../core/modelProxy/runBearers.js";
import { InMemoryPrivateWorkerLog } from "../../core/privateWorkerLog.js";
import type { CompletionRequest, CompletionResult, Provider } from "../../core/provider.js";
import { NO_FLEET } from "../../core/residentFleet.js";
import { createRunHistoryWriter } from "../../core/runHistoryWriter.js";
import { InMemoryRunLedger } from "../../core/runLedger/inMemory.js";
import { ThreadsElsewhere } from "../../core/runLedger/threadsElsewhere.js";
import { createLedgerWriteThrough } from "../../core/runLedger/writeThrough.js";
import { RunRegistry } from "../../core/runRegistry.js";
import { FileRunStore } from "../../core/runStore.js";
import { createRunsService } from "../../core/runsService.js";
import { ThreadAdmission } from "../../core/threadAdmission.js";
import { createStatusBudget } from "../../core/statusBudget.js";
import { createTracer } from "../../core/trace/tracer.js";
import { TEST_GITHUB_CREDENTIALS } from "../../execution/testing/githubCredentials.js";
import { InMemoryMcpClient } from "../../mcp/index.js";
import { bridgeMcpTools, newRunBudget } from "../../mcp/bridge.js";
import { NullMcpToolSource, type McpRunCaller } from "../../mcp/source.js";
import { processSecrets, Secret } from "../../secrets.js";
import { COORDINATOR_ADMIN_PREFIX, handleCoordinatorRequest, type AdminCoordinatorDeps } from "../adminCoordinator.js";
import { receiveSlackMessage, resumeSlackIO, SlackIO } from "../slack.js";
import { SlackConversationReader } from "../slack/references.js";
import { createSlackContextCapability } from "../slack/context.js";
import { guardOutbound } from "./outboundGuard.js";

export const REQUESTER = "UALICE";
export const BOT = "UBOT";
export const SOURCE = {
  query: "SELECT count(*) FROM signups WHERE failed = true",
  result: "17 failures among 120 attempts",
  timeWindow: "2026-01-01T00:00:00Z/2026-01-02T00:00:00Z",
  sourceUrl: "https://metrics.example.test/signups",
};
export const SOURCE_QUERY = { resource: { project: "signups" }, input: { query: SOURCE.query } };
export function briefFromSource(source: typeof SOURCE) {
  return {
    schemaVersion: 1,
    question: "How many signups failed?",
    cause: { kind: "unknown", reason: "The query measures failures, not their cause" },
    evidence: { availability: "provided" },
    requirements: { analysis: "required", evidence: "required" },
    findings: [{ kind: "analysis", text: source.result, ...source }],
    requestedChange: "Fix failed signups and add a regression test",
    acceptance: "A reviewed PR explains the cause and includes a regression test",
  };
}

/** The scripted model receives evidence only through this exact tool result.
 * Missing fields produce no sourced answer or work proposal. */
export function sourceResult(request: CompletionRequest, toolUseId: string): typeof SOURCE | undefined {
  const result = request.messages
    .flatMap((message) => message.content)
    .reverse()
    .find((part) => part.type === "tool_result" && part.toolUseId === toolUseId);
  if (result?.type !== "tool_result") return undefined;
  const text = toolResultText(result.content);
  const data = unwrapUntrusted(text);
  if (data === text) throw new Error("Missing source-data envelope");
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null) return undefined;
  const envelope = value as Record<string, unknown>;
  const fields = (envelope.status === "succeeded" ? envelope.result : envelope) as Record<string, unknown>;
  if (!fields || typeof fields !== "object") return undefined;
  if (
    !["query", "result", "timeWindow", "sourceUrl"].every(
      (key) => typeof fields[key] === "string" && fields[key].trim() !== "",
    )
  )
    return undefined;
  return {
    query: fields.query as string,
    result: fields.result as string,
    timeWindow: fields.timeWindow as string,
    sourceUrl: fields.sourceUrl as string,
  };
}
export const answer = (text: string): CompletionResult => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
});
export const call = (name: string, input: Record<string, unknown>, id = name): CompletionResult => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

/** Disk checkpoints of the reference stores, not a substitute for the Worker
 * SQLite contract suite. No policy is reimplemented here. A new generation
 * constructs new stores and restores only data; clocks and methods stay new. */
function persisted<T extends object>(path: string, fresh: T): T {
  if (existsSync(path)) Object.assign(fresh, deserialize(readFileSync(path)));
  const save = () => {
    const data = Object.fromEntries(Object.entries(fresh).filter(([, v]) => typeof v !== "function"));
    writeFileSync(`${path}.next`, serialize(data));
    renameSync(`${path}.next`, path);
  };
  return new Proxy(fresh, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (result instanceof Promise) return result.finally(save);
        save();
        return result;
      };
    },
  });
}

type SlackRow = { ts: string; text: string; user: string; thread_ts?: string; bot_id?: string; blocks?: unknown[] };
export function goldenWorld(now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "swb-slack-golden-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const channel = `D${dir.split("-").at(-1)!.toUpperCase()}`;
  let tick = now();
  const stamp = () => `${Math.floor(++tick / 1000)}.${String(tick % 1000).padStart(3, "0")}000`;
  const root = stamp();
  const rows: SlackRow[] = [];
  const posts: Array<{ channel: string; thread_ts?: string; text?: string }> = [];
  const created: string[] = [];
  const sourceReads: Array<{ caller: McpRunCaller; input: Record<string, unknown> }> = [];
  const sourceActions = new Map<string, SourceReadResponse>();
  const sourceInspects: string[] = [];
  const state = {
    sourceAllowed: true,
    shared: false,
    revokeOnRead: false,
    loseCreateReply: false,
    sourceResponse: structuredClone(SOURCE) as Partial<typeof SOURCE>,
  };
  const client = guardOutbound({
    auth: { test: async () => ({ user_id: BOT, team_id: "TLOCAL", url: "https://team.example.test/" }) },
    users: {
      info: async ({ user }: { user: string }) => ({
        user: { id: user, name: user, team_id: "TLOCAL", is_restricted: false, is_ultra_restricted: false },
      }),
    },
    conversations: {
      info: async () => ({
        channel: {
          id: channel,
          user: REQUESTER,
          is_im: true,
          is_mpim: false,
          is_private: true,
          is_member: true,
          is_shared: state.shared,
          is_ext_shared: false,
          is_org_shared: false,
          is_pending_ext_shared: false,
        },
      }),
      replies: async () => ({ ok: true, messages: structuredClone(rows), has_more: false }),
      history: async () => ({ ok: true, messages: structuredClone(rows), has_more: false }),
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    chat: {
      postMessage: async (payload: { channel: string; thread_ts?: string; text?: string; blocks?: unknown[] }) => {
        posts.push(structuredClone(payload));
        const ts = stamp();
        rows.push({ ...payload, ts, text: payload.text ?? "", user: BOT, bot_id: "BBOT" });
        return { ok: true, ts, channel };
      },
      update: async (payload: { ts: string; text: string; blocks?: unknown[] }) => {
        Object.assign(rows.find((r) => r.ts === payload.ts) ?? {}, payload);
        return { ok: true, ts: payload.ts, channel };
      },
      getPermalink: async ({ message_ts }: { message_ts: string }) => ({
        permalink: `https://team.example.test/archives/${channel}/p${message_ts.replace(".", "")}`,
      }),
    },
  }) as unknown as ConstructorParameters<typeof SlackIO>[0];
  const event = (text: string, user = REQUESTER) => {
    const ts = rows.length === 0 ? root : stamp();
    rows.push({ text, user, ts, thread_ts: root });
    return { text, user, ts, channel, threadTs: root, botUserId: BOT, trigger: "dm" as const };
  };
  return {
    dir,
    channel,
    root,
    client,
    rows,
    posts,
    event,
    created,
    sourceReads,
    sourceActions,
    sourceInspects,
    state,
    now,
  };
}
export type GoldenWorld = ReturnType<typeof goldenWorld>;
export type ScriptStep = (request: CompletionRequest) => CompletionResult | Promise<CompletionResult>;

/** Rebuild the bot-side objects while Slack and disk remain independent. */
export function goldenProcess(world: GoldenWorld, generation: string, script: ScriptStep[]) {
  const cfgPath = join(world.dir, "config.yaml");
  writeFileSync(
    cfgPath,
    `
organization: acme
providers:
  anthropic: { type: anthropic, apiKeyEnv: ANTHROPIC_API_KEY }
defaults:
  agent: general
  verbosity: quiet
  models: { general: anthropic/general-model, coding: anthropic/coding-model, review: anthropic/review-model }
grants:
  "slack:${REQUESTER}": { actions: all, channels: all, repos: all }
  "slack:UMALLORY": { actions: all, channels: all, repos: all }
restrict: { agents: [coding] }
routing: { operator: on }
channels:
  "slack:${world.channel}": { agent: orchestrator, repo: acme/api }
workspaceDir: ${join(world.dir, "workspaces")}
`,
  );
  const config = new ConfigStore(cfgPath, join(world.dir, "overrides.json"));
  const ledger = persisted(join(world.dir, "ledger.bin"), new InMemoryRunLedger());
  const instances = persisted(join(world.dir, "instances.bin"), new InMemoryCoordinatorInstanceStore());
  const privateWorkerLog = persisted(join(world.dir, "private.bin"), new InMemoryPrivateWorkerLog());
  const runStore = new FileRunStore(join(world.dir, "runs"));
  const registry = new RunRegistry();
  const requests: CompletionRequest[] = [];
  const provider: Provider = {
    name: "scripted",
    async complete(req) {
      requests.push(structuredClone(req));
      const next = script.shift();
      if (!next) throw new Error(`Unexpected model turn ${requests.length}`);
      return next(req);
    },
  };
  class Source extends NullMcpToolSource {
    override async toolsFor(_agent: string, caller: McpRunCaller) {
      if (!world.state.sourceAllowed || caller.userId !== `slack:${REQUESTER}`) return { tools: [], servers: [] };
      const definition = {
        ...readTool,
        name: "signups",
        description: "Read signup failure totals",
        _meta: { sourceAction: { ...readTool._meta.sourceAction, operationId: "metrics.signups" } },
        inputSchema: {
          ...readTool.inputSchema,
          properties: {
            ...readTool.inputSchema.properties,
            input: {
              type: "object",
              additionalProperties: false,
              required: ["query"],
              properties: { query: { type: "string", minLength: 1 } },
            },
          },
        },
      };
      const remote = new InMemoryMcpClient([
        {
          ...definition,
          handler: async (input) => {
            const actionId = String(input.actionId);
            if (input.action === "inspect") {
              world.sourceInspects.push(actionId);
              return {
                content: [],
                structuredContent: world.sourceActions.get(actionId) ?? {
                  version: 1,
                  status: "refused",
                  actionId,
                  reason: "not_found",
                },
              };
            }
            let response = world.sourceActions.get(actionId);
            if (!response) {
              world.sourceReads.push({ caller: structuredClone(caller), input });
              const observed = world.now();
              response = {
                version: 1,
                actionId,
                operationId: "metrics.signups",
                operationRevision: "1",
                binding: {
                  id: `binding-${actionId}`,
                  revision: "fixture-revision",
                  subjectId: caller.userId,
                  sessionId: "session-original",
                  resource: structuredClone(input.resource) as Record<string, string>,
                  input: structuredClone(input.input) as Record<string, string>,
                  expiresAt: new Date(observed + SOURCE_READ_ELIGIBILITY_MS).toISOString(),
                },
                status: "succeeded",
                attempt: "completed",
                observedAt: new Date(observed).toISOString(),
                truncation: "none",
                result: structuredClone(world.state.sourceResponse),
              };
              world.sourceActions.set(actionId, response);
              if (world.state.revokeOnRead) world.state.sourceAllowed = false;
            }
            return { content: [], structuredContent: response };
          },
        },
      ]);
      const tools = bridgeMcpTools(
        {
          id: "golden-metrics",
          connectionRevision: "fixture-connection",
          name: "metrics",
          url: "https://metrics.example.test/mcp",
          agents: ["orchestrator"],
        },
        remote,
        [definition],
        {
          budget: newRunBudget(),
          currentSource: async () => world.state.sourceAllowed && caller.userId === `slack:${REQUESTER}`,
        },
      );
      return {
        tools,
        servers: [
          {
            server: "metrics",
            toolCount: tools.length,
            audience: `user:${caller.userId}/metrics`,
            revision: "fixture-source",
          },
        ],
      };
    }
  }
  const harnesses = new HarnessRegistry();
  const runBearers = new RunBearerStore({ clock: Date.now });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const deps: CoreDeps = {
    config,
    completions: { get: () => provider },
    runBearers,
    githubDoor: { baseUrl: "https://git.bot.test" },
    githubBindings: new GitBindings(),
    githubCredentials: TEST_GITHUB_CREDENTIALS,
    harness: {
      harnesses: { pi: new PiHarness(), opencode: new OpenCodeHarness() },
      registry: harnesses,
      harnessUrl: "https://bot.test",
      loopbackUrl: "http://127.0.0.1:8080",
      containerFor: () => {
        const container = new FakeHarnessContainer();
        scriptPiFromProvider(container, {
          provider,
          registry: harnesses,
          bearers: runBearers,
          beforeModelCall: () => sleep(10),
        });
        return container;
      },
      pollMs: 1,
      tickMs: 5,
      sleep,
    },
    capabilities: capabilitiesFrom(config.config, process.env, processSecrets),
    residentFleet: NO_FLEET,
    memory: new NullMemoryStore(),
    mcp: new Source(),
    runHistoryWriter: createRunHistoryWriter({ store: runStore, warn: console.warn, sleep: async () => {} }),
    runStore,
    runLedger: createLedgerWriteThrough({ ledger, gen: generation, fallback: runStore, warn: () => {} }),
    threadsElsewhere: new ThreadsElsewhere(),
    runRegistry: registry,
    admission: new ThreadAdmission(),
    coordinatorInstances: instances,
    privateWorkerLog,
    dataDir: world.dir,
    operatorModel: async () => {
      throw new Error("A private main conversation must not enter the routing model");
    },
  };
  deps.runs = createRunsService({ registry, store: runStore, ledger });
  const reader = new SlackConversationReader(world.client);
  const ready = reader.ready();
  deps.conversationReaders = [reader];
  deps.slackContextForRun = (actor, msg) => createSlackContextCapability({ client: world.client, reader, actor, msg });
  deps.commands = buildCoreCommands(config, runStore, {
    registry,
    secrets: processSecrets,
    dataDir: world.dir,
    warn: () => {},
    audit: () => {},
  });
  deps.mainTaskStart = createMainTaskStarter({
    instances,
    privateWorkerLog,
    readFile: async () => {
      throw new Error("The main task cannot read a seeded plan");
    },
    create: async (id) => {
      world.created.push(id);
      if (world.state.loseCreateReply) throw new Error("The workflow accepted the request but its reply was lost");
      return { kind: "created", id };
    },
    status: async (id) => (world.created.includes(id) ? { kind: "status", status: "running" } : { kind: "absent" }),
    repoInfo: async () => ({ defaultBranch: "main" }),
    canUseRepo: (actor, repo) => config.canUseRepo(actor, repo),
    canRunAgent: (actor, name) => config.canRunAgent(actor, name),
    adminsHint: () => "an admin",
    privateWorkerAvailable: true,
    caps: { maxRounds: 3, maxMinutes: 45 },
    clock: Date.now,
  });
  async function deliver(ev: ReturnType<GoldenWorld["event"]>, caughtUp = false) {
    await ready;
    const event = { ...ev, ...(caughtUp ? { caughtUp: true as const } : {}) };
    const span = createTracer({ clock: Date.now }).start("golden.receive", { sinks: [] });
    const received = await receiveSlackMessage(
      world.client,
      event,
      span,
      { verbosity: "quiet", staging: false, maxBytesPerMessage: 1024 },
      [],
    );
    span.end("ok");
    if (!received) return { status: "duplicate" as const };
    const out = await dispatch(
      deps,
      received.message,
      new SlackIO(world.client, event, {
        statusBudget: createStatusBudget({ perMinute: 10000, channelSpacingMs: 0 }),
      }),
    );
    await deps.runHistoryWriter.settled();
    // The fixture's reference ledger and file history remain separate, as in
    // dispatcher.test.ts. Production drains finished rows in the state Worker.
    for (const record of ledger.finished.values()) await runStore.put(record);
    return out;
  }
  const workerCalls: Array<{
    message: Parameters<AdminCoordinatorDeps["dispatch"]>[0];
    options: Parameters<AdminCoordinatorDeps["dispatch"]>[2];
    hasOpenThread: boolean;
  }> = [];
  async function spawnWorker(instanceId: string, unit: string, reply: string) {
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected external coordinator operation");
    };
    const pending: Promise<unknown>[] = [];
    const coordinator: AdminCoordinatorDeps = {
      tokens: new Secret(JSON.stringify({ "golden-coordinator": { subject: "golden-coordinator" } }), "fixture"),
      grantsFor: (id) => (id === "http:golden-coordinator" ? ALL_GRANTS : config.grantsFor(id)),
      instances,
      runs: deps.runs!,
      registry,
      ledgerRuns: () => [],
      privateWorkerLog,
      runHistoryWriter: deps.runHistoryWriter,
      channelVisibilityOf: async () => "dm",
      clock: Date.now,
      // The external worker is scripted; the production coordinator chooses
      // its message, contract and IO from the unit admitted by work_start.
      dispatch: (message, io, options) => {
        const work = (async () => {
          workerCalls.push({ message, options: structuredClone(options), hasOpenThread: io.openThread !== undefined });
          io.runStarted?.({ id: `worker-${instanceId}` });
          await io.reply(reply);
          return { status: "completed" as const };
        })();
        pending.push(work);
        return work;
      },
      ioFor: ({ threadKey, userId }) =>
        threadKey === `slack:${world.channel}:${world.root}` && userId === `slack:${REQUESTER}`
          ? resumeSlackIO(world.client, { channel: world.channel, threadTs: world.root, user: REQUESTER })
          : undefined,
      github: { readFile: unexpected, listIssues: unexpected, commentIssue: unexpected },
      findOpenPrByHead: unexpected,
      findMergedPrByHead: unexpected,
      openPullRequest: unexpected,
      commitsOverBase: unexpected,
      createBranchRef: unexpected,
      fetchPrReviews: unexpected,
      commenterAuthorized: unexpected,
      selfIdentity: unexpected,
      fetchPrFacts: unexpected,
      fetchCommitChecks: unexpected,
      fixupCommitSubjects: unexpected,
      mergePullRequest: unexpected,
    };
    const step = (name: string, body: Record<string, unknown>) =>
      handleCoordinatorRequest(
        {
          method: "POST",
          path: `${COORDINATOR_ADMIN_PREFIX}${name}`,
          headers: { authorization: "Bearer golden-coordinator" },
          body: JSON.stringify(body),
        },
        coordinator,
      );
    const started = await step("unit-start", { parentInstanceId: instanceId, unit });
    const instance = await instances.get(instanceId);
    const row = (await instances.listUnits(instanceId)).find((candidate) => candidate.unit === unit);
    if (!instance || !row) throw new Error("The admitted worker is missing");
    const spawned = await step("spawn", {
      parentInstanceId: instanceId,
      step: `${unit}/0/coding`,
      preset: "coding",
      brief: { kind: "contract", unit, rebase: { branch: row.branch, onto: instance.base } },
    });
    await Promise.all(pending);
    return { started, spawned };
  }
  return {
    deliver,
    spawnWorker,
    workerCalls,
    requests,
    ledger,
    instances,
    privateWorkerLog,
    deps,
    remaining: () => script.length,
  };
}
