import { contractFromPlan, DEFAULT_CONTRACT_MAX_CHARS, renderContract } from "./ship/contract.js";
import { NO_VERDICT_LINE } from "./reviewVerdict.js";
import { reviewTargetBlock } from "./reviewTarget.js";
import { SELF_DESCRIPTION_HEADER, selfDescriptionBlock } from "./selfDescription.js";
import { InMemoryGithubApi } from "../execution/githubApi.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processSecrets } from "../secrets.js";
import { ConfigStore } from "../config.js";
import { MAX_INSTRUCTIONS_LENGTH } from "../config/validate.js";
import type { ChatMessage } from "./chatMessage.js";
import type { CompletionRequest, CompletionResult, Provider } from "./provider.js";
import { AGENTS, getAgent } from "../agents/registry.js";
import { planResume } from "./runLedger/resume.js";
import { knownToolsFor, resumeMessage } from "./resumeLaunch.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { makeExecutor } from "../execution/factory.js";
import { InMemoryArtifactStore } from "../artifacts/store.js";
import { ExecSandboxRestartedError } from "../execution/executor.js";
import { ResidentNeedsRefError } from "../execution/resident.js";
import type { ChannelIO, HistoryItem, RunReceipt, StatusUpdate } from "./types.js";
import { activeRunCount, dispatch, type CoreDeps, type DispatchOutcome } from "./dispatcher.js";
import { setShutdownNotice } from "./dispatch/run.js";
import { durableInboxMessage, type DispatchFollowUp } from "./dispatch/admission.js";
import { CUSTOM_INSTRUCTIONS_HEADER } from "./customInstructions.js";
import { RunRegistry } from "./runRegistry.js";
import { activityOfEvents } from "./runRegistry/activity.js";
import type { IndexEvent } from "./runRegistry/indexFeed.js";
import { RunControl } from "./runRegistry/runControl.js";
import { createTracer } from "./trace/tracer.js";
import { classOf, isStreamed } from "./trace/streamSpans.js";
import { partition } from "./trace/partition.js";
import type { SpanRecord } from "./trace/types.js";
import { recordingSink } from "./testing/recordingSink.js";
import { withResidentTrace } from "../execution/residentTrace.js";
import { createAlsContext, createTickingClock, timedFakes, type Tick } from "./testing/tickingClock.js";
import { ThreadAdmission } from "./threadAdmission.js";
import { isHeadMaterial, isSpanRecord, type RunEvent } from "./runEvents.js";
import type { ConversationReader } from "./references/types.js";
import { REFERENCE_REFUSAL } from "./dispatch/references.js";
import type { ContentPart } from "./chatMessage.js";
import type { ReviewCommentTarget } from "../execution/githubComments.js";
import type { OpenedPullRequest, PullRequestFacts, PullRequestTarget } from "../execution/githubPulls.js";
import { shipTaskText } from "./ship/preflight.js";
import { generatedPlanId, unitBranch } from "./ship/coordinator.js";
import type { GithubIdentity } from "../execution/githubApp.js";
import { InMemoryMemoryStore, NullMemoryStore, type MemoryRecord } from "./memory/index.js";
import { drainReflections, pendingReflectionCount, REFLECT_MIN_TURNS, REFLECTION_SYSTEM } from "./memory/reflection.js";
import { matchesPredicate, NO_GRANTS, predicateFor, type Actor, type ChannelDirectory } from "./authz/index.js";
import { SlackChannelDirectory } from "../channels/slackChannelDirectory.js";
import { InMemorySkillStore, type Skill } from "../skills/index.js";
import { StaticMcpToolSource, InMemoryMcpClient } from "../mcp/index.js";
import { NullMcpToolSource } from "../mcp/source.js";
import { InMemoryFrictionLedger, RunStoreFrictionLedger, type FrictionLedger } from "./frictionLedger.js";
import { analyzeRunFriction } from "./runFriction.js";
import { InMemoryIssueTracker } from "../execution/githubIssues.js";
import { InMemoryRunStore, NullRunStore, type RunStore } from "./runStore.js";
import { createRunsService } from "./runsService.js";
import type { RepoContext } from "./repoContext.js";
import { isRunRecord, type RunRecord } from "./runRecord.js";
import { createRunHistoryWriter, NullRunHistoryWriter } from "./runHistoryWriter.js";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import { messageFromInbox } from "./runLedger/inboxMessage.js";
import { createLedgerWriteThrough, NullLedgerWriteThrough } from "./runLedger/writeThrough.js";
import { textTurnsOf } from "./dispatch/textTurns.js";
import { runPiHarnessOpen, type OpenPiSession } from "./harness/pi/harness.js";
import { HarnessRegistry, authorizeToolCall, relayToolCall, type ToolCallAsk } from "./harness/pi/relay.js";
import { FakePiContainer } from "./harness/pi/testing/fakeContainer.js";
import { scriptPiFromProvider } from "./harness/pi/testing/providerPi.js";
import { SOFT_STOP_INSTRUCTION } from "./harness/pi/windDown.js";
import { ThreadsElsewhere } from "./runLedger/threadsElsewhere.js";
import type { LiveRunRow, StepRecord } from "./runLedger/types.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "./runStoreWorker.js";
import { buildCoreCommands, defaultOperations } from "./commandCatalogue.js";
import { capabilitiesFrom } from "./capabilities.js";
import { NO_FLEET } from "./residentFleet.js";
import { InMemoryCoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import type { CoordinatorInstance } from "./coordinator/contract.js";
import type { Operations } from "./operations.js";
import type { ResidentAdminClient } from "./residentAdmin.js";
import { BEARER_MARGIN_MS, RunBearerStore } from "./modelProxy/runBearers.js";

/** `CoreDeps` plus the two backends the registry's `repo.*` commands reach
 *  through the catalogue wiring (tests inject them here; production resolves
 *  them from config) and the invoke spy `wireCommands` fills. */
type TestDeps = CoreDeps & {
  residentAdmin?: ResidentAdminClient;
  operations?: Operations;
  invoked: string[];
  /** The friction ledger the catalogue's `friction.*` commands read (wiring, not a CoreDeps slice since the dispatcher stopped writing one). */
  frictionLedger?: FrictionLedger;
};

/** The ONE catalogue src/index.ts hands the dispatcher (`buildCoreCommands`),
 *  bound over the CoreDeps slices — resident admin, operations backend, memory
 *  store read LAZILY (a test may set them after `makeDeps`); ledger, tracker,
 *  and run registry at wiring time (tests that set those call `wireCommands`
 *  again) — plus an invoke spy, so a test can assert which registry command a
 *  message reached. Every `makeDeps` wires it once: there is no chat command
 *  outside the registry. */
function wireCommands(deps: TestDeps): { invoked: string[] } {
  const bound = buildCoreCommands(deps.config, null, {
    registry: deps.runRegistry ?? new RunRegistry(),
    secrets: processSecrets,
    dataDir: deps.dataDir ?? mkdtempSync(join(tmpdir(), "swb-dispatch-cmds-")),
    warn: () => {},
    audit: () => {},
    frictionLedger: deps.frictionLedger,
    tracker: deps.issueTracker,
    memory: () => deps.memory,
    residentAdmin: () => deps.residentAdmin,
    // Never the network: an onboard here falls back to the npm table (and says so).
    repoInspector: async () => ({ ok: false, reason: "not inspected in tests" }),
    operations: (caller) => deps.operations ?? defaultOperations(deps.config, processSecrets, caller),
  });
  deps.invoked = [];
  const invoked = deps.invoked;
  deps.commands = {
    ...bound,
    invoke: (id, raw, caller, trace) => {
      invoked.push(id);
      return bound.invoke(id, raw, caller, trace);
    },
  };
  return { invoked };
}

// Feature: docs/reference/specs/routing-and-config.md — end-to-end dispatch: config
// commands, permission gates, and thread-sticky agent resolution.
// Feature: docs/reference/specs/execution.md, docs/reference/specs/agent-general.md — per-agent
// executor provisioning (general touches no sandbox).

// Pass-through spy: behavior is the real factory's, but calls/results are
// observable (the seam the executor-provisioning tests assert on).
vi.mock("../execution/factory.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../execution/factory.js")>();
  return { ...mod, makeExecutor: vi.fn(mod.makeExecutor) };
});

// Pass-through spy on the pi harness's open form, the entry the run loop takes
// (harness-pi item 14): the boundary suites assert each run's CLIPPED AgentDef
// on the harness it was handed to, the session-seed suite scripts one run's
// answer and reads the seed the dispatcher handed over; behavior everywhere
// else is the real harness's — over a fake container whose pi is scripted from
// the test's provider (`scriptPiFromProvider`), so a model script drives the
// real bridge, mirror, relay and gate.
vi.mock("./harness/pi/harness.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./harness/pi/harness.js")>();
  return { ...mod, runPiHarnessOpen: vi.fn(mod.runPiHarnessOpen) };
});

/** What a scripted pi run answers: the loop's answer with a session that takes no follow-up and ends at once. */
const piAnswered = (answer: string): OpenPiSession => ({ answer, followUp: async () => answer, end: async () => {} });

/** The process's own timer, taken before any test fakes them: the harness polls
 *  a scripted pi on it, so a test that advances fake timers around a model turn
 *  or a tool call still sees pi's records read. */
const realSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));

function makeDeps(fixtureYaml: string, provider: Provider): TestDeps {
  const dir = mkdtempSync(join(tmpdir(), "swb-dispatch-"));
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, fixtureYaml.replaceAll("__WORKDIR__", join(dir, "workspaces")));
  const config = new ConfigStore(cfgPath, join(dir, "overrides.json"));
  // The Null Objects a process without the subsystem is wired with (routing-and-
  // config item 16): a test that needs the real thing sets it after `makeDeps`.
  // One scripted provider answers the run's turns — as the model behind a
  // scripted pi in a fake container, one container per run — and the calls
  // made outside a run (`completions`: the router, reflection) unless a test
  // sets the second apart. The harness pieces are the process's: the relay
  // registry, the bearer store the proxy would meter, the bot's URLs, and a
  // fast poll so a scripted pi's records are read without waiting.
  const harnesses = new HarnessRegistry();
  const runBearers = new RunBearerStore({ clock: Date.now });
  const deps: TestDeps = {
    config,
    completions: { get: () => provider },
    runBearers,
    harness: {
      registry: harnesses,
      harnessUrl: "https://bot.test",
      loopbackUrl: "http://127.0.0.1:8080",
      containerFor: () => {
        const container = new FakePiContainer();
        scriptPiFromProvider(container, {
          provider,
          registry: harnesses,
          bearers: deps.runBearers, // whatever store the test wired, read when the run starts
          beforeModelCall: () => realSleep(10), // two harness ticks: the inbox drained, the budgets checked
        });
        return container;
      },
      pollMs: 1,
      tickMs: 5,
      sleep: realSleep,
    },
    capabilities: capabilitiesFrom(config.config, process.env, processSecrets),
    residentFleet: NO_FLEET,
    memory: new NullMemoryStore(),
    mcp: new NullMcpToolSource(),
    runHistoryWriter: new NullRunHistoryWriter(),
    runStore: new NullRunStore(),
    runLedger: new NullLedgerWriteThrough("test-gen", new NullRunStore()),
    threadsElsewhere: new ThreadsElsewhere(),
    dataDir: dir,
    invoked: [],
  };
  wireCommands(deps);
  return deps;
}

const YAML_FIXTURE = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    review: anthropic/review-model
    coding: anthropic/coding-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
restrict:
  agents: [coding]
# The router is on by default; these tests prove the paths under it, so the
# scripted provider is never asked to route — the router's own suite turns it on.
routing: { auto: false }
workspaceDir: __WORKDIR__
`;

/** The thread's newest run, finished with a session log: what a follow-up
 *  continues (routing-and-config item 3, by transcript — never an `agent:`
 *  token in the thread's history). */
async function threadWithFinishedRun(deps: TestDeps, agent: string, over: Partial<RunRecord> = {}) {
  const store = new InMemoryRunStore();
  await store.put({
    id: "run-prev",
    label: `${agent} · #CX`,
    agent,
    model: `anthropic/${agent}-model`,
    channelId: "slack:CX",
    userId: "slack:UADMIN",
    threadKey: "slack:CX:1.0",
    channelVisibility: "public",
    startedAt: Date.now() - 20_000, // near now: the store retains rows by age
    finishedAt: Date.now() - 10_000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
    seed: "channel",
    session: { key: `slack:CX:1.0:${agent}`, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
    ...over,
  });
  deps.runStore = store;
  deps.runs = createRunsService({ registry: deps.runRegistry ?? new RunRegistry(), store });
}

/** The run store as production reads it once the ledger has drained a finished
 *  run into it (run-history item 36): the in-memory pair keeps the two apart, so
 *  the ledger's finished records are copied over before every read. */
function ledgerBackedStore(ledger: InMemoryRunLedger, store: RunStore): RunStore {
  const drained = async () => {
    for (const record of ledger.finished.values()) await store.put(record);
  };
  return {
    put: (record, trace) => store.put(record, trace),
    get: async (id) => {
      await drained();
      return store.get(id);
    },
    getSummary: async (id) => {
      await drained();
      return store.getSummary(id);
    },
    list: async (opts) => {
      await drained();
      return store.list(opts);
    },
    events: async (id, opts) => {
      await drained();
      return store.events(id, opts);
    },
    delete: (id) => store.delete(id),
    usageByUser: (query) => store.usageByUser(query),
  };
}

function capturingProvider(answer = "answer"): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "fake",
    requests,
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
    },
  };
}

function fakeIO(history: HistoryItem[] = []) {
  const replies: string[] = [];
  const statuses: StatusUpdate[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async (initial) => {
      statuses.push(initial);
      return {
        update: (f: StatusUpdate) => void statuses.push(f),
        done: async (f: StatusUpdate) => void statuses.push(f),
      };
    },
    history: async () => history,
  };
  return { io, replies, statuses };
}

const msg = (text: string, user = "slack:UX") => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: "slack:CX:1.0",
  text,
});

// The bot host sets PUBLIC_BASE_URL in prod; tests must not inherit it from the
// ambient env — a set value puts the run link on every card AND on review
// verdict replies. Tests that want the link stub their own value, which wins
// over this default.
beforeEach(() => {
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

describe("dispatch", () => {
  it("answers config commands inline without calling a model", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("help"), io);
    expect(replies[0]).toContain("Switchboard");
    expect(provider.requests).toHaveLength(0);
  });

  it("denies restricted agents at run time against the resolved agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding do the thing"), io);
    expect(replies[0]).toContain("🚫");
    expect(provider.requests).toHaveLength(0);
  });

  it("runs the default agent for a plain message in a fresh thread", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(provider.requests[0].model).toBe("general-model");
    expect(replies).toContain("answer");
  });

  it("thread follow-ups stick to the agent the thread established — by transcript: the newest finished run's agent, not an agent: token in the history", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await threadWithFinishedRun(deps, "review");
    // The history names another agent: it decides nothing.
    const history: HistoryItem[] = [
      { role: "user", text: "agent:coding look at this PR" },
      { role: "assistant", text: "reviewed, LGTM" },
    ];
    const { io } = fakeIO(history);
    await dispatch(deps, msg("thanks — double-check the tests too"), io);
    expect(provider.requests[0].model).toBe("review-model");
  });

  it("an agent: token in the thread's history alone establishes nothing: with no finished run in the thread a plain follow-up resolves through the scopes", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const history: HistoryItem[] = [
      { role: "user", text: "agent:review look at this PR" },
      { role: "assistant", text: "reviewed, LGTM" },
    ];
    const { io } = fakeIO(history);
    await dispatch(deps, msg("thanks — double-check the tests too"), io);
    expect(provider.requests[0].model).toBe("general-model");
  });

  it("an explicit directive on the follow-up overrides the sticky agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await threadWithFinishedRun(deps, "review");
    const { io } = fakeIO([{ role: "user", text: "look at this PR" }]);
    await dispatch(deps, msg("agent:general summarize the thread"), io);
    expect(provider.requests[0].model).toBe("general-model");
  });

  it("sticky resolution still passes the permission gate", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    // Thread established coding by an allowed user; a non-allowed user's
    // follow-up must be denied, not smuggled through stickiness.
    await threadWithFinishedRun(deps, "coding");
    const { io, replies } = fakeIO([{ role: "user", text: "fix it" }]);
    await dispatch(deps, msg("keep going"), io);
    expect(replies[0]).toContain("🚫");
    expect(provider.requests).toHaveLength(0);
  });
});

// The answer path is deterministic: one model call, the answer replied
// verbatim through `io.reply` — no model ever sits between the run record and
// a surface (docs/reference/specs/llm-output.md item 7).
describe("answer reply path", () => {
  it("sends the answer verbatim via reply, with exactly one model call", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toEqual(["answer"]);
    expect(provider.requests).toHaveLength(1); // only the agent run — no extra pass
  });
});

// Remote execution configured (Cloudflare Sandbox), as in production.
const REMOTE_YAML_FIXTURE =
  YAML_FIXTURE +
  `
execution:
  type: cloudflare
  url: https://sandbox.example
`;

describe("executor provisioning by agent resources", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
  });

  it("a general ask with remote execution configured provisions no sandbox and still answers", async () => {
    // AE3: no credential is present and fetch is poisoned — any attempt to
    // provision or reconnect a sandbox would error the dispatch. General must
    // answer normally anyway.
    vi.stubEnv("SANDBOX_TOKEN", "");
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toContain("answer");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes the resolved agent to executor selection", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(makeExecutor).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ threadKey: "slack:CX:1.0", agent: { name: "general" } });
  });

  // docs/reference/specs/resident-repos.md item 51: the resolved PR head reaches executor
  // selection (→ the resident's /attach `sha`) so a mirror whose ref tip lags
  // the push is fetched — a re-review would review a stale tip otherwise.
  it("passes the resolved repo, ref and PR head to executor selection", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40) });
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ repo: "acme/api", ref: "patch-1", headSha: "e".repeat(40) });
  });

  it("releases the executor's workspace when the run ends: if-clean for a coding run, always for a read-only agent", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io } = fakeIO();
    const release = vi.fn(async () => ({ released: true }));
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("if-clean", {
      span: expect.objectContaining({ name: "post.workspace_release" }),
    });

    release.mockClear();
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:review look at it", "slack:UADMIN"), io);
    expect(release).toHaveBeenCalledWith("always", {
      span: expect.objectContaining({ name: "post.workspace_release" }),
    });
  });

  it("the answer reaches the thread BEFORE the workspace release round trip (a slow /detach never delays the reply)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const order: string[] = [];
    const { io } = fakeIO();
    const replyInner = io.reply;
    io.reply = async (t) => {
      order.push("reply");
      await replyInner(t);
    };
    const release = vi.fn(async () => {
      order.push("release");
      return { released: true };
    });
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(order).toEqual(["reply", "release"]);
  });

  it("the workspace is still released when sending the answer throws (a Slack failure never holds the pool user)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io } = fakeIO();
    io.reply = async () => {
      throw new Error("msg_too_long");
    };
    const release = vi.fn(async () => ({ released: true }));
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io); // dispatch reports the failure itself, never throws
    expect(release).toHaveBeenCalledTimes(1);
  });

  // Feature: docs/reference/specs/harness-pi.md item 6 — a HARD stop tears the
  // workspace down (`release("always")`, even for a coding run that would
  // otherwise keep dirty work), and the card/answer say the run was stopped.
  it("a hard stop from /runs releases the executor with 'always' and reports the abort", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    let hardSignal: AbortSignal | undefined;
    // A provider that hangs until the run is hard-stopped — the stop must cut it off.
    const provider: Provider = {
      name: "hang",
      complete: (req) =>
        new Promise((resolve) => {
          hardSignal = req.signal;
          req.signal?.addEventListener("abort", () =>
            resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }),
          );
        }),
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    const { io, replies, statuses } = fakeIO();
    const release = vi.fn(async () => ({ released: true }));
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    const run = dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    // Wait until the run is registered and the provider call is in flight.
    while (!hardSignal) await new Promise((r) => setTimeout(r, 5));
    expect(registry.requestStop("r1", "t1", "hard")).toEqual({ ok: true, mode: "hard" });
    await run;
    expect(release).toHaveBeenCalledWith("always", {
      span: expect.objectContaining({ name: "post.workspace_release" }),
    }); // coding run, but hard stop → tear down
    expect(replies.some((r) => r.includes("aborted"))).toBe(true);
    expect(replies.some((r) => r.includes("late"))).toBe(false);
    expect(statuses.at(-1)?.title).toContain("⛔");
    expect(registry.listActive()[0].stop).toEqual({ mode: "hard", state: "stopped" });
  });

  it("a soft stop keeps the normal release policy (if-clean for coding) and marks the card stopped", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    let calls = 0;
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (calls++ === 0) {
          registry.requestStop("r1", "t1", "soft");
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo" } }],
            stopReason: "tool_use",
          };
        }
        // the finale: the write-up instruction steered in as the last user turn (harness-pi item 6)
        const last = req.messages.at(-1)!;
        expect(last.role).toBe("user");
        expect(JSON.stringify(last.content)).toContain(SOFT_STOP_INSTRUCTION);
        return { content: [{ type: "text", text: "summary so far" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    const { io, replies, statuses } = fakeIO();
    const release = vi.fn(async () => ({ released: false, reason: "dirty" }));
    const fake = { exec: async () => "ok", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(release).toHaveBeenCalledWith("if-clean", {
      span: expect.objectContaining({ name: "post.workspace_release" }),
    });
    expect(replies.some((r) => r.includes("summary so far") && r.includes("Stopped early"))).toBe(true);
    expect(statuses.at(-1)?.title).toContain("⏹");
  });

  it("a release that throws never fails the run — the answer is still delivered", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    const fake = {
      exec: async () => "",
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => {
        throw new Error("boom");
      },
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
  });

  it("acknowledges the thread with a 👀 card BEFORE executor selection (no silence while a workspace is prepared)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    let statusesAtSelection = -1;
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    vi.mocked(makeExecutor).mockImplementationOnce(async () => {
      statusesAtSelection = statuses.length;
      return { executor: fake };
    });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(statusesAtSelection).toBe(1);
    expect(statuses[0].title).toContain("👀");
    expect(statuses[0].title).toContain("preparing workspace");
    // The same card then carries the run and ends ✅ — no second card is created.
    expect(statuses[statuses.length - 1].title).toContain("✅");
  });

  // Feature: docs/reference/specs/tracing.md item 7 — through a slow setup the card ticks
  // from the ack and names the step in flight, off the card sink's label.
  it("a slow attach shows on the card: the setup heartbeat paints `— attaching the workspace…` with the elapsed time, and the run's frames drop it", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const deps = makeDeps(REMOTE_YAML_FIXTURE, capturingProvider());
    const { io, statuses } = fakeIO();
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    vi.mocked(makeExecutor).mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(11_000); // two heartbeats pass while the workspace attaches
      return { executor: fake };
    });
    try {
      await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    } finally {
      vi.useRealTimers();
    }
    const setup = statuses.filter((s) => s.title.includes("— attaching the workspace…"));
    expect(setup.length).toBeGreaterThan(0);
    expect(setup[0].title).toMatch(/^[◐◓◑◒] \*coding\* on `[^`]+` · \d+s — attaching the workspace…$/u);
    // Once the run loop owns the card no frame names a setup step.
    const afterSetup = statuses.slice(statuses.indexOf(setup.at(-1)!) + 1);
    expect(afterSetup.length).toBeGreaterThan(0);
    expect(afterSetup.every((s) => !s.title.includes("—"))).toBe(true);
    expect(statuses.at(-1)!.title).toContain("✅");
  });

  // Feature: docs/reference/specs/tracing.md item 19 — a resident's attach steps graft
  // under the run's `dispatch.workspace.attach` span, rebased to its start.
  it("a resident attach's step trace lands on the run's stream as dispatch.workspace.attach.<step> spans under the attach span, clipped to the attach, with the resident backend and a clock-skew attr on the parent", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const registry = new RunRegistry({ genId: () => "run-g", genToken: () => "tok" });
    const deps = makeDeps(REMOTE_YAML_FIXTURE, capturingProvider());
    deps.runRegistry = registry;
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    vi.mocked(makeExecutor).mockImplementationOnce(async () => ({
      executor: fake,
      backend: "resident" as const,
      resident: true,
      binding: { ref: "main", sha: "abc", workspace: "/workspace/threads/x/main" },
      attachMs: 30,
      trace: [
        { name: "mutex_wait", startMs: 0, durationMs: 5, status: "ok" as const, waitedMs: 5 },
        { name: "clone", startMs: 5, durationMs: 20, status: "ok" as const, exitCode: 0 },
        { name: "install", startMs: 25, durationMs: 5_000, status: "error" as const, exitCode: 1, timedOut: true }, // runs past the attach: clipped
      ],
    }));
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    const events = registry.snapshot("run-g", "tok")!.events;
    const attach = events.find((e) => e.type === "span_end" && e.name === "dispatch.workspace.attach");
    if (!attach || attach.type !== "span_end") throw new Error("no attach span");
    const grafts = events.filter(
      (e): e is Extract<RunEvent, { type: "span_end" }> =>
        e.type === "span_end" && e.name.startsWith("dispatch.workspace.attach."),
    );
    expect(grafts.map((g) => [g.name, g.status, g.attrs, g.parentSpanId])).toEqual([
      ["dispatch.workspace.attach.mutex_wait", "ok", { backend: "resident", waitedMs: 5 }, attach.spanId],
      ["dispatch.workspace.attach.clone", "ok", { backend: "resident", exitCode: 0 }, attach.spanId],
      [
        "dispatch.workspace.attach.install",
        "error",
        { backend: "resident", exitCode: 1, timedOut: true },
        attach.spanId,
      ],
    ]);
    for (const g of grafts) {
      expect(g.startedAt).toBeGreaterThanOrEqual(attach.startedAt);
      expect(g.startedAt + g.durationMs).toBeLessThanOrEqual(attach.startedAt + attach.durationMs);
      expect(g.error).toBeUndefined(); // a graft carries a classification, never text
    }
    expect(grafts[0]!.startedAt).toBe(attach.startedAt); // rebased: the resident's start is the span's start
    expect(attach.attrs).toMatchObject({ backend: "resident", clockSkewMs: expect.any(Number) });
    // The request is published at the reservation, before the attach; the
    // grafts stream live after it and before the agent loop — head material
    // all the way, so the protected head runs from the root through the loop.
    const inputAt = events.findIndex((e) => e.type === "input");
    const loopAt = events.findIndex((e) => e.type === "span_start" && e.name === "run.agent");
    expect(events.indexOf(grafts[0]!)).toBeGreaterThan(inputAt);
    expect(events.indexOf(grafts[0]!)).toBeLessThan(loopAt);
    expect(events.slice(0, loopAt).every(isHeadMaterial)).toBe(true);
  });

  // Feature: docs/reference/specs/tracing.md item 19 — a resident attach that FAILS still
  // grafts the steps it ran under the (failed) attach span; no run exists, so
  // they reach the process sinks.
  it("a failed resident attach's step trace grafts under the failed dispatch.workspace.attach span, on the process sink", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const log = recordingSink();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, capturingProvider());
    deps.sinks = [log];
    vi.mocked(makeExecutor).mockImplementationOnce(async () => {
      throw withResidentTrace(new Error("resident attach failed for repo:acme/widgets: install timed out"), {
        steps: [
          { name: "mutex_wait", startMs: 0, durationMs: 5, status: "ok", waitedMs: 5 },
          { name: "install", startMs: 5, durationMs: 20, status: "error", exitCode: 124, timedOut: true },
        ],
      });
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies.join("\n")).toContain("install timed out");
    const attach = log.ends.find((e) => e.name === "dispatch.workspace.attach");
    expect(attach?.status).toBe("error");
    const grafts = log.ends.filter((e) => e.name.startsWith("dispatch.workspace.attach."));
    expect(grafts.map((g) => [g.name, g.status, g.attrs, g.parentSpanId, g.errorKind, g.errorMessage])).toEqual([
      [
        "dispatch.workspace.attach.mutex_wait",
        "ok",
        { backend: "resident", waitedMs: 5 },
        attach!.spanId,
        undefined,
        undefined,
      ],
      [
        "dispatch.workspace.attach.install",
        "error",
        { backend: "resident", exitCode: 124, timedOut: true },
        attach!.spanId,
        "infra",
        undefined,
      ],
    ]);
    // Grafted before the parent ended: they precede it on the sink.
    expect(log.ends.indexOf(grafts[0]!)).toBeLessThan(log.ends.indexOf(attach!));
  });

  it("closes the ack card with a reason when setup stops before the run (ask-once for a branch)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    vi.mocked(makeExecutor).mockRejectedValueOnce(new ResidentNeedsRefError("repo:acme/api"));
    await dispatch(deps, msg("agent:coding fix it in acme/api", "slack:UADMIN"), io);
    expect(statuses[0].title).toContain("👀");
    expect(statuses[statuses.length - 1].title).toContain("not started");
    expect(replies.some((r) => r.includes("Which branch"))).toBe(true);
  });

  it("closes the ack card with ❌ when setup throws, and still replies the error", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    vi.mocked(makeExecutor).mockRejectedValueOnce(new Error("sandbox worker unreachable"));
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(statuses[statuses.length - 1].title).toContain("❌ setup failed");
    expect(replies.some((r) => r.includes("sandbox worker unreachable"))).toBe(true);
  });

  it("a setup failure carrying remote text closes the card with one redacted line and redacts the reply (resident-repos item 62)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    // A bare token with a terminal escape mid-token: only strip-then-redact
    // catches it (the escape would otherwise split the credential shape).
    vi.mocked(makeExecutor).mockRejectedValueOnce(
      new Error(
        "resident attach failed: ghp_abcdefghijklmnop\x1b[31mqrstuvwxyz0123456789\nsecond line of remote output",
      ),
    );
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const title = statuses[statuses.length - 1].title;
    expect(title).toContain("❌ setup failed");
    expect(title).not.toContain("ghp_");
    expect(title).not.toContain("\n");
    expect(title).not.toContain("second line");
    expect(replies.some((r) => r.includes("resident attach failed"))).toBe(true);
    expect(replies.every((r) => !r.includes("ghp_abcdefghijklmnop"))).toBe(true);
    expect(replies.every((r) => !r.includes("\x1b"))).toBe(true);
  });

  it("a RUN failure keeps the run loop's ❌ card (label + checklist) — the outer catch does not relabel it as a setup failure", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        throw new Error("model exploded");
      },
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses, replies } = fakeIO();
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "" };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("❌");
    expect(last.title).toContain("*coding*");
    expect(last.title).not.toContain("setup failed");
    expect(statuses.some((f) => f.title.includes("setup failed"))).toBe(false); // never relabeled
    expect(replies.some((r) => r.includes("model exploded"))).toBe(true);
  });

  it("a coding ask still selects the configured remote backend", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", ""); // keep githubEnvs off the network
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    const { executor } = await vi.mocked(makeExecutor).mock.results[0].value;
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
  });
});

// Feature: docs/reference/specs/resident-repos.md — the per-repo gate (a refused user
// sees a NAMED refusal, never a silent per-thread fallback) and the
// fallback note surfacing on the status card.
const REPO_PERMS_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UDEV": { actions: [agent:run:coding] }
restrict:
  agents: [coding]
  repos: ["acme/api"]
routing: { auto: false }
workspaceDir: __WORKDIR__
`;

const RESIDENT_YAML_FIXTURE =
  REPO_PERMS_YAML +
  `execution:
  type: cloudflare
  url: https://sandbox.example
  resident:
    baseUrl: https://resident.example
`;

describe("resident repo dispatch", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
    (await import("../execution/factory.js")).resetResidentProbeCache();
  });

  it("a canUseRepo refusal is a named reply and no executor is created", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    const { io, replies } = fakeIO();
    // UDEV may run the coding agent but is NOT on acme/api's repo allowlist.
    await dispatch(deps, msg("agent:coding fix it", "slack:UDEV"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("an allowed user's repo context flows to executor selection as ctx.repo/ctx.ref", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ threadKey: "slack:CX:1.0", repo: "acme/api", ref: "main" });
  });

  // Over-fire fix: repo/ref resolution AND the canUseRepo gate run ONLY when
  // the resolved agent's machine class carries a checkout. An agent on `none`
  // (the general default) in a thread that MENTIONS a restricted repo must not
  // be refused — and must never even resolve or gate a repo.
  it("a no-repo agent (general) in a thread mentioning a restricted repo is NOT refused, and never resolves/gates a repo", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider); // acme/api restricted to UADMIN
    // If resolution ran for a no-repo agent this spy would record it; the whole
    // resolve+gate step must be skipped for an agent that declares no repo.
    const resolveSpy = vi.fn(() => ({ repo: "acme/api" }));
    deps.resolveRepoContext = resolveSpy;
    const history: HistoryItem[] = [{ role: "user", text: "earlier we were looking at acme/api" }];
    const { io, replies } = fakeIO(history);
    // UDEV is NOT on acme/api's allowlist, but the DEFAULT agent (general) has
    // no repo resource — the per-repo gate must not fire.
    await dispatch(deps, msg("give me a quick summary of the thread", "slack:UDEV"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("🚫"))).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
  });

  // A FRESH thread whose only repo signal is a bare slug the resident
  // registry rejected must not start a repo-less coding run (empty workspace,
  // `fatal: not a git repository`) — it says why the slug was ignored. The
  // resolver reports the refusal as `rejectedRepo`; a bound thread never sets
  // it (prose slugs there are ignored silently), and a no-repo agent
  // never resolves a repo at all.
  it("fresh thread + rejected bare slug + a repo-needing agent → one not-onboarded reply, no run", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    // The note is a resident installation's (item 16); the fixture names no resident Worker, so say there is one.
    deps.capabilities = { ...deps.capabilities, residents: true };
    deps.resolveRepoContext = () => ({ rejectedRepo: "acme/try-catch" });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding in acme/try-catch: say hi", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("acme/try-catch");
    expect(replies[0]).toContain("not onboarded");
    expect(replies[0]).toContain("repo onboard acme/try-catch");
    expect(replies[0]).not.toContain("Ask "); // an admin can run `repo onboard` themselves
    expect(replies[0]).toMatch(/github\.com/); // the URL form still binds a real repo
    expect(provider.requests).toHaveLength(0); // no model turn
    expect(makeExecutor).not.toHaveBeenCalled(); // no workspace of any kind
    expect(statuses[statuses.length - 1].title).toContain("not started");
  });

  // Feature: docs/reference/specs/routing-and-config.md item 16 — the note names `repo
  // onboard`, a command an installation without residents does not have: the
  // gate reads the capability, and a rejected slug is then no reason to stop.
  it("the not-onboarded note is a resident installation's: with residents off the same rejected slug starts no such refusal and never mentions `repo onboard`", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.capabilities = { ...deps.capabilities, residents: false };
    deps.resolveRepoContext = () => ({ rejectedRepo: "acme/try-catch" });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding in acme/try-catch: say hi", "slack:UADMIN"), io);
    expect(replies.some((r) => r.includes("not onboarded"))).toBe(false);
    expect(replies.some((r) => r.includes("repo onboard"))).toBe(false);
    expect(provider.requests.length).toBeGreaterThan(0); // the run went ahead in a per-thread workspace
  });

  // The registry did not ANSWER for the repo the message addressed.
  // Guessing — in a bound thread, the thread's old repo — is the wrong-repo
  // run addressing exists to end, so the dispatcher says so and stops.
  it("unverified repo (registry unreachable) + a repo-needing agent → one could-not-verify reply, no run", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.resolveRepoContext = () => ({ unverifiedRepo: "acme/web" });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding in acme/web: fix the consent page", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("couldn't verify");
    expect(replies[0]).toContain("acme/web");
    expect(replies[0]).not.toContain("not onboarded"); // silence is not a refusal
    expect(replies[0]).toMatch(/github\.com/); // the URL form still binds a real repo
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
    expect(statuses[statuses.length - 1].title).toContain("could not be verified");
  });

  // `repo onboard` is admin-gated (canManageRepos, fail-closed): a non-admin
  // told to run it would just hit 🚫 next — point them at the admins instead.
  it("a non-admin gets the not-onboarded reply with an ask-an-admin hint, never a command they cannot run", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    deps.capabilities = { ...deps.capabilities, residents: true };
    deps.resolveRepoContext = () => ({ rejectedRepo: "acme/try-catch" });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding in acme/try-catch: say hi", "slack:UDEV"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("not onboarded");
    expect(replies[0]).toContain("Ask <@slack:UADMIN> to onboard it (`repo onboard acme/try-catch`)");
    expect(replies[0]).toMatch(/github\.com/); // the self-serve path stays
    expect(provider.requests).toHaveLength(0);
  });

  it("the same rejected slug with a no-repo agent (general) runs unchanged", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    const resolveSpy = vi.fn(() => ({ rejectedRepo: "acme/try-catch" }));
    deps.resolveRepoContext = resolveSpy;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("say hi about acme/try-catch", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("not onboarded"))).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("a bound thread with a prose slug in the follow-up stays silent — the resolver keeps the repo, no message", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider);
    // What the production resolver answers for a bound thread + prose slug:
    // the thread's repo and NO rejectedRepo (the prose token is never probed).
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    const history: HistoryItem[] = [{ role: "user", text: "agent:coding in acme/api: fix the resolver" }];
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("wrapped it in try/catch, please continue", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("not onboarded"))).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it("a resident fallback note appears in the status frames and on the run's stream as a cold_sandbox note (named, never silent)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    // The /status probe answers restoring; the run then uses the per-thread
    // backend (no further RESIDENT calls happen before the fake provider ends —
    // the coding PR post-step's head/branch probe goes to the sandbox backend).
    const fetchSpy = vi.fn(
      async (_url: unknown) =>
        new Response(JSON.stringify({ state: "restoring", reason: "rehydrating" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const registry = new RunRegistry({ genId: () => "run-cold", genToken: () => "tok" });
    deps.runRegistry = registry;
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("resident.example"))).toHaveLength(1);
    expect(statuses.some((s) => s.title.includes("resident restoring (rehydrating) — using fresh sandbox"))).toBe(true);
    // …and on the run's stream: a `cold_sandbox` note with the same text, after
    // the attach and before the loop, head material like the rest of the setup
    // — so the run page, not only the card, says why this run went cold.
    const events = registry.snapshotById("run-cold")!.events;
    const noteAt = events.findIndex((e) => e.type === "run_note" && e.kind === "cold_sandbox");
    const attachEndAt = events.findIndex((e) => e.type === "span_end" && e.name === "dispatch.workspace.attach");
    const loopAt = events.findIndex((e) => e.type === "span_start" && e.name === "run.agent");
    expect(events[noteAt]).toMatchObject({ summary: "resident restoring (rehydrating) — using fresh sandbox" });
    expect(noteAt).toBeGreaterThan(attachEndAt);
    expect(noteAt).toBeLessThan(loopAt);
    expect(events.slice(0, loopAt).every(isHeadMaterial)).toBe(true);
  });
});

// Feature: docs/reference/specs/resident-repos.md — repo/ref resolved BEFORE the model
// turn (production default resolver), the needs-ref ask-once flow (one
// clarifying question, no model turn burned), and the resident prompt variant
// selected AFTER executor resolution via RunOptions.system.

/** Router-style fetch stub for the resident service: /status and /attach. */
function residentFetchStub(
  handlers: {
    status?: () => Response;
    attach?: (body: Record<string, unknown>) => Response;
    /** GitHub's REST API, for a resolution that fetches a pull request. */
    github?: (path: string) => Response;
  } = {},
) {
  const calls: Array<{ path: string; host: string; body?: Record<string, unknown> }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const { pathname: path, host } = new URL(String(url));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, host, body });
    if (host === "api.github.com" && handlers.github) return handlers.github(path);
    if (path === "/status") {
      return handlers.status?.() ?? new Response(JSON.stringify({ state: "warm", reason: "" }), { status: 200 });
    }
    if (path === "/attach") {
      return (
        handlers.attach?.(body ?? {}) ??
        new Response(
          JSON.stringify({ workspace: "/workspace/threads/t/main", ref: "main", sha: "abc", user: "worker2" }),
          { status: 200 },
        )
      );
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

// Feature: docs/reference/specs/resident-repos.md — repo-management commands are
// config-family (answered inline, never a model turn); all but `list` gated
// by canManageRepos (fail-closed).
describe("repo management commands", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function mockAdmin() {
    return {
      onboard: vi.fn(async () => ({ status: 202, data: { resource: "repo:acme/api", state: "onboarding" } })),
      offboard: vi.fn(async () => ({ status: 200, data: {} })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 202, data: {} })),
      residents: vi.fn(async () => ({
        status: 200,
        data: {
          cap: 8,
          count: 1,
          residents: [{ resource: "repo:jshttp/vary", defaultRef: "master", live: { state: "warm", reason: "" } }],
        },
      })),
      status: vi.fn(async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } })),
    };
  }

  it("`repo list` is answered inline by the registry (`repo.list`) without a model call, open to a non-admin", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.residentAdmin = mockAdmin();
    const { invoked } = wireCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo list", "slack:UX"), io);
    expect(replies).toEqual(["*Resident repos* (1/8):\n• `jshttp/vary` — *warm* · ref `master`"]);
    expect(invoked).toEqual(["repo.list"]);
    expect(provider.requests).toHaveLength(0);
  });

  it("repo list binds the admin client to the command's run.command span through withSpan (docs/reference/specs/tracing.md item 24)", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const base = mockAdmin();
    const bound: string[] = [];
    deps.residentAdmin = { ...base, withSpan: (span) => (bound.push(span.name), base) };
    wireCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo list", "slack:UX"), io);
    expect(replies).toHaveLength(1);
    expect(bound).toEqual(["run.command"]);
    expect(base.residents).toHaveBeenCalledTimes(1);
  });

  it("non-admin `repo onboard` → refusal naming admins; no model call, no resident call", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const admin = mockAdmin();
    deps.residentAdmin = admin;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo onboard acme/api", "slack:UX"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("<@slack:UADMIN>");
    expect(provider.requests).toHaveLength(0);
    expect(admin.onboard).not.toHaveBeenCalled();
  });

  it("admin `repo offboard --dry-run` reaches the resident client with dryRun", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const admin = mockAdmin();
    admin.offboard = vi.fn(async () => ({
      status: 200,
      data: {
        resource: "repo:acme/api",
        dryRun: true,
        wouldRemove: {
          registryRecord: true,
          schedules: 1,
          snapshotBackupIds: [],
          backupObjects: 4,
          r2Objects: 0,
          threadBindings: 0,
          container: "warm",
        },
      },
    }));
    deps.residentAdmin = admin;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo offboard acme/api --dry-run", "slack:UADMIN"), io);
    expect(admin.offboard).toHaveBeenCalledWith("repo:acme/api", true);
    expect(replies[0]).toContain("Nothing was changed");
    expect(provider.requests).toHaveLength(0);
  });
});

// Feature: docs/reference/specs/resident-repos.md, docs/reference/specs/routing-and-config.md — the
// deterministic ops fast-path: recognized ops answer with a real op
// execution and ZERO model turns, mirroring the config-command inline-reply
// shape. Only the model call is skipped — the implicit target agent (coding)
// passes canRunAgent and the repo passes canUseRepo BEFORE anything
// executes. Anything ambiguous or non-matching falls through to the agent
// (never guess).
describe("deterministic ops fast-path", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function fakeOps(result: import("./operations.js").OperationResult) {
    return {
      calls: [] as Array<{ op: string; req: { repo: string; ref?: string } }>,
      async run(op: import("./operations.js").OpName, req: { repo: string; ref?: string }) {
        this.calls.push({ op, req });
        return result;
      },
    };
  }

  const OK_RESULT = {
    kind: "result",
    ok: true,
    summary: "test passed on repo:acme/api @ main (abc12345) in 3s",
    output: "1 passing",
  } as const;

  it('F3: "run the tests on main" for an onboarded repo → op result posted, provider NEVER called', async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toEqual([{ op: "test", req: { repo: "acme/api", ref: "main" } }]);
    expect(replies[0]).toContain("✅");
    expect(replies[0]).toContain("test passed");
    expect(replies[0]).toContain("1 passing");
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("explicit `repo test <owner/name> <ref>` executes for an authorized user regardless of phrasing", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(ops.calls).toEqual([{ op: "test", req: { repo: "acme/api", ref: "main" } }]);
    expect(replies[0]).toContain("✅");
    expect(provider.requests).toHaveLength(0);
  });

  it("a user without coding-agent access is refused by the `agentRun` gate (the registry's shared restricted line); the op never executes", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider); // coding restricted to UADMIN
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UX"), io);
    expect(replies).toEqual(["🚫 `repo test` is restricted. Ask <@slack:UADMIN>."]);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("a canUseRepo refusal names the repo; the op never executes", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider); // acme/api restricted to UADMIN; UDEV may run coding
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UDEV"), io);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api");
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it('ambiguous phrasing ("can you check the tests seem fine?") falls through to the agent path', async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO([{ role: "user", text: "we are looking at acme/api" }]);
    await dispatch(deps, msg("can you check the tests seem fine?"), io);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(1); // the agent path served it
    expect(replies).toContain("answer");
  });

  it("a natural-language ref with shell metacharacters falls through silently (never reaches any backend)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io } = fakeIO();
    await dispatch(deps, msg("run the tests on main;rm in acme/api"), io);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });

  it("an explicit `repo test` with a hostile ref is a NAMED refusal before any backend", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main;rm", "slack:UADMIN"), io);
    expect(replies[0]).toMatch(/ref/i);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("an op failure (tests fail) is posted as ❌ with the named summary — a result, not an error path", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({
      kind: "result",
      ok: false,
      summary: "test failed (exit 1) on repo:acme/api @ main (abc12345)",
      output: "1 failing",
    });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(replies[0]).toContain("❌");
    expect(replies[0]).toContain("test failed (exit 1)");
    expect(provider.requests).toHaveLength(0);
  });

  it("a mutating command-table entry is refused on the modelless path with the named reason", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({
      kind: "refused",
      reason:
        'op-refused: the "test" command-table entry is marked effects: mutating — the modelless op path executes readonly entries only',
    });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(replies[0]).toMatch(/^⚠️ `repo test`: op-refused/);
    expect(replies[0]).toContain("mutating");
    expect(provider.requests).toHaveLength(0);
  });

  it("a non-onboarded repo natural-language ask falls through to the agent path; the command run is sealed with no reply attempted, the agent run after its reply", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    let n = 0;
    const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}` });
    deps.runRegistry = registry;
    const ops = fakeOps({ kind: "not-onboarded" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(1); // the op was attempted…
    expect(provider.requests).toHaveLength(1); // …and the agent path served the ask
    expect(replies).toContain("answer");
    const rows = registry.listActive().sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    expect(rows[0]).toMatchObject({ finished: true }); // the command run: sealed, no reply was attempted for it
    expect(rows[0].sealedAt).toBeDefined();
    expect(rows[0].replyOk).toBeUndefined();
    expect(rows[1]).toMatchObject({ finished: true, replyOk: true }); // the agent run: sealed after its reply
  });

  it("an explicit `repo test` on a non-onboarded repo gets a named reply (config-family commands never silently become a model turn)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "not-onboarded" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(replies[0]).toContain("not onboarded");
    expect(provider.requests).toHaveLength(0);
  });

  // Coverage gap (testing P2): the fast-path `case "error"` (a failing OR
  // throwing backend) — untested for BOTH forms, though its not-onboarded
  // sibling covers both. Explicit `repo test/build` is config-family → always
  // a named ⚠️ reply; natural language is an accelerator → falls through so the
  // agent can still serve the ask.
  it("an explicit `repo test` whose op returns kind:error gets a named ⚠️ reply (never silently a model turn)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.operations = fakeOps({ kind: "error", message: "resident /op request failed (timeout)" });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(replies[0]).toContain("⚠️");
    expect(replies[0]).toContain("resident /op request failed (timeout)");
    expect(provider.requests).toHaveLength(0);
  });

  it("a natural-language ask whose op returns kind:error falls through to the agent path", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps({ kind: "error", message: "resident /op HTTP 500" });
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(1); // the op was attempted…
    expect(provider.requests).toHaveLength(1); // …and the agent path served the ask
    expect(replies).toContain("answer");
  });

  it("a THROWING op on the explicit path is caught (.catch → kind:error) and reported as ⚠️, never an unhandled crash", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = {
      calls: [] as Array<{ op: string; req: { repo: string; ref?: string } }>,
      async run(op: import("./operations.js").OpName, req: { repo: string; ref?: string }) {
        this.calls.push({ op, req });
        throw new Error("backend exploded");
      },
    };
    deps.operations = ops;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(1);
    expect(replies[0]).toContain("⚠️");
    expect(replies[0]).toContain("backend exploded");
    expect(provider.requests).toHaveLength(0);
  });

  it("an explicit agent directive skips the natural-language fast-path (the user picked a model path)", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const ops = fakeOps(OK_RESULT);
    deps.operations = ops;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });
});

// Coverage gap (testing P1): defaultOperations() — the REAL backend picker
// behind the modelless fast-path — is otherwise never exercised (every test in
// the fast-path describe injects deps.operations). Driven here through
// dispatch() WITHOUT injecting deps.operations, so the real selection logic
// runs: resident-backed when execution.resident is configured, local for local
// execution, none for a per-thread remote backend.
describe("defaultOperations backend selection (real, not injected)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
  });

  it("execution.resident configured (+ operator token) → ResidentOperations POSTs /op with the operator bearer", async () => {
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ path: new URL(String(url)).pathname, init: init ?? {} });
      return new Response(
        JSON.stringify({ ok: true, summary: "test passed on repo:acme/api @ main", stdout: "1 passing", exitCode: 0 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider); // deps.operations NOT injected
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(calls.map((c) => c.path)).toEqual(["/op"]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer rtok");
    expect(replies[0]).toContain("✅");
    expect(replies[0]).toContain("test passed");
    expect(provider.requests).toHaveLength(0);
  });

  it("local execution → LocalOperations runs against the thread's local workspace (no network)", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider); // execution absent → local; deps.operations NOT injected
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    // no checkout exists → LocalOperations' distinctive "no local workspace" result
    expect(replies[0]).toContain("no local workspace");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
  });

  it("a per-thread remote backend with no resident → no ops backend; an explicit op says so", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider); // cloudflare, no resident; deps.operations NOT injected
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(replies[0]).toContain("Deterministic ops need a backend");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("repo/ref resolution + resident prompt selection", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
    (await import("../execution/factory.js")).resetResidentProbeCache();
  });

  it("the production default resolver (no injection) extracts repo/ref from the message text", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REPO_PERMS_YAML, provider); // resolveRepoContext NOT injected
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api on branch fix/login", "slack:UADMIN"), io);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx).toMatchObject({ repo: "acme/api", ref: "fix/login" });
  });

  it("needs-ref from attach → ONE clarifying question; no model turn; the ack card closes as not started", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({
      attach: () =>
        new Response(JSON.stringify({ error: "needs-ref: this thread has no ref binding yet", needs: "ref" }), {
          status: 409,
        }),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/branch/i);
    expect(replies[0]).toContain("acme/api");
    expect(replies[0]).not.toContain("⚠️"); // a question, not an error surface
    expect(provider.requests).toHaveLength(0); // no model turn burned
    // The 👀 ack card was posted before attach and is closed with the reason —
    // no spinner is left behind and no run card was ever opened.
    expect(statuses[0].title).toContain("👀");
    expect(statuses[statuses.length - 1].title).toContain("not started");
    expect(statuses.some((f) => f.title.includes("✅"))).toBe(false);
  });

  it("needs-ref WITH a defaultRef → bound to the repo default with a loud note, no question, the run proceeds", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    let attaches = 0;
    residentFetchStub({
      attach: (body) => {
        attaches++;
        if (!body.refHint) {
          return new Response(
            JSON.stringify({
              error: "needs-ref: this thread has no ref binding yet",
              needs: "ref",
              defaultRef: "main",
            }),
            { status: 409 },
          );
        }
        return new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t/main",
            ref: String(body.refHint),
            sha: "f2fe51e2204",
            user: "worker2",
          }),
          { status: 200 },
        );
      },
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api", "slack:UADMIN"), io);
    expect(attaches).toBe(2);
    expect(replies.some((r) => /which branch/i.test(r))).toBe(false); // no question asked
    expect(provider.requests).toHaveLength(1); // the run happened
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.title).toContain("resident · acme/api · main@f2fe51e (repo default — no branch named)");
  });

  it('the thread answer "on main" rebinds via re-attach and runs', async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub();
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    await threadWithFinishedRun(deps, "coding", { repo: "acme/api" }); // the thread's coding run: sticky by transcript
    const history: HistoryItem[] = [
      { role: "user", text: "fix the login bug in acme/api" },
      { role: "assistant", text: "🌿 Which branch of `acme/api` should this thread work on?" },
    ];
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("on main", "slack:UADMIN"), io);
    const attach = calls.find((c) => c.path === "/attach");
    expect(attach?.body).toMatchObject({ resource: "repo:acme/api", refHint: "main" });
    expect(provider.requests).toHaveLength(1); // sticky agent:coding thread ran
    expect(provider.requests[0].model).toBe("coding-model");
    expect(replies).toContain("answer");
  });

  // docs/reference/specs/resident-repos.md items 16 and 29: a follow-up in a thread
  // whose own run opened a pull request runs on that PR's head branch — the
  // record's PR binds the ref, and rides the attach as the reason for the hint,
  // so the resident may move a default-bound thread onto it; the card says so.
  it("a follow-up in a thread whose newest finished run opened a pull request attaches with that PR as ownPr beside its head branch, and the card says the resident rebound the thread", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const SHA = "f".repeat(40);
    const { calls } = residentFetchStub({
      attach: (body) =>
        new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t/main",
            ref: body.refHint,
            sha: SHA,
            user: "worker2",
            ...(body.ownPr ? { rebound: { from: "main", to: "fix/x", pr: 7, at: "2026-01-01T00:00:00.000Z" } } : {}),
          }),
          { status: 200 },
        ),
      github: (path) =>
        path === "/repos/acme/api/pulls/7"
          ? new Response(
              JSON.stringify({
                state: "open",
                head: { ref: "fix/x", sha: SHA, repo: { full_name: "acme/api" } },
                base: { ref: "main" },
              }),
              { status: 200 },
            )
          : new Response("{}", { status: 404 }),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const registry = new RunRegistry({ genId: () => "run-follow", genToken: () => "tok" });
    const store = new InMemoryRunStore();
    deps.runRegistry = registry;
    deps.runStore = store;
    deps.runs = createRunsService({ registry, store });
    // The thread's newest finished run: a coding run on acme/api whose post-step
    // opened PR 7 (timestamps near now: the store retains rows by age).
    const nowMs = Date.now();
    await store.put({
      id: "run-prev",
      label: "coding · acme/api",
      agent: "coding",
      model: "anthropic/coding-model",
      channelId: "slack:CX",
      userId: "slack:UADMIN",
      threadKey: "slack:CX:1.0",
      channelVisibility: "public",
      startedAt: nowMs - 20_000,
      finishedAt: nowMs - 10_000,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([]),
      repo: "acme/api",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      // Finished with a session log: what makes the run's agent sticky by transcript (routing-and-config item 3).
      session: { key: "slack:CX:1.0:coding", seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
    });
    const history: HistoryItem[] = [
      { role: "user", text: "fix the login bug in acme/api", at: nowMs - 30_000 },
      { role: "assistant", text: "PR opened: https://github.com/acme/api/pull/7", at: nowMs - 10_000 },
    ];
    const { io, replies, statuses } = fakeIO(history);
    await dispatch(deps, msg("add the tests' names to the PR description", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    const attach = calls.find((c) => c.path === "/attach");
    expect(attach?.body).toEqual({
      resource: "repo:acme/api",
      threadKey: "slack:CX:1.0",
      refHint: "fix/x",
      sha: SHA,
      ownPr: { number: 7, ref: "fix/x" },
    });
    expect(
      statuses.some((s) =>
        s.title.includes("resident · acme/api · fix/x@fffffff · rebound to fix/x (this thread's PR #7)"),
      ),
    ).toBe(true);
  });

  it("a rebind the resident refused is said on the card and on the run's stream as a rebind_refused note, and the run goes on where the binding is", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const SHA = "f".repeat(40);
    const why =
      "the worktree has uncommitted changes on the bound branch; the binding stands until they are committed or discarded";
    residentFetchStub({
      attach: () =>
        new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t/main",
            ref: "main",
            sha: "abc1234def",
            user: "worker2",
            rebindRefused: { to: "fix/x", pr: 7, reason: "dirty", why },
          }),
          { status: 200 },
        ),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const registry = new RunRegistry({ genId: () => "run-kept", genToken: () => "tok" });
    deps.runRegistry = registry;
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      ref: "fix/x",
      refFromPr: true,
      pr: 7,
      prFromRecord: true,
      headSha: SHA,
    });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding add the tests' names to the PR description", "slack:UADMIN"), io);
    expect(replies).toContain("answer");
    expect(
      statuses.some((s) =>
        s.title.includes("resident · acme/api · main@abc1234 · rebind to fix/x (this thread's PR #7) refused: dirty"),
      ),
    ).toBe(true);
    // …and on the run's stream, head material like the cold-sandbox note: the
    // run page says why this follow-up runs on main and not on the thread's PR.
    const events = registry.snapshotById("run-kept")!.events;
    const noteAt = events.findIndex((e) => e.type === "run_note" && e.kind === "rebind_refused");
    const loopAt = events.findIndex((e) => e.type === "span_start" && e.name === "run.agent");
    expect(events[noteAt]).toMatchObject({
      summary: `kept on main — rebind to fix/x (this thread's PR #7) refused: dirty — ${why}`,
    });
    expect(noteAt).toBeLessThan(loopAt);
    expect(events.slice(0, loopAt).every(isHeadMaterial)).toBe(true);
  });

  it("a resident run gets the agent's resident system variant naming the repo", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub();
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api on branch main", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.coding.residentSystem!);
    expect(system).toContain("acme/api"); // the resolved repo is named
    expect(system).not.toMatch(/clone the relevant repository/i);
    expect(system).not.toContain("gh pr create");
  });

  // Feature: docs/reference/specs/agent-review.md item 9 — a review run with a resolved PR
  // is TOLD its target (repo, PR, head branch/commit, base) in the system
  // prompt, on both paths, from RepoContext — never left to find it.
  it("a resident review of a resolved PR gets the REVIEW TARGET block with the resolved head sha", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub();
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40), baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    deps.postReviewComment = vi.fn(async () => {});
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.review.residentSystem!);
    // The stub attaches at the malformed sha "abc": nothing to verify against,
    // so the block carries the worktree path but no verified-at-attach claim.
    expect(system).toContain(reviewTargetBlock({ ...ctx, resident: true, workspace: "/workspace/threads/t/main" }));
    expect(system).toContain(`Head commit: ${"e".repeat(40)}`);
    expect(system).not.toMatch(/verified it before this run/);
  });

  // Feature: docs/reference/specs/agent-review.md item 10 — the dispatcher compares
  // the sha the resident ATTACHED the worktree at with the PR head it resolved,
  // before any model turn. Left to probe on its own, an agent that wanders out
  // of the worktree (`cd /workspace`, `find … .git`) finds the resident's warm
  // default-branch checkout and reports ITS HEAD as a mismatch. So the agent is
  // told the worktree path and that the attach was verified; a real mismatch
  // never reaches the model at all.
  it("a resident review attached AT the PR head: the block names the worktree path and says the attach was verified", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const head = "e".repeat(40);
    residentFetchStub({
      attach: () =>
        new Response(
          JSON.stringify({ workspace: "/workspace/threads/t-9f/patch-1", ref: "patch-1", sha: head, user: "worker3" }),
          {
            status: 200,
          },
        ),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: head, baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    deps.postReviewComment = vi.fn(async () => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(2); // the review ran, then its verdict turn (this fake submits no verdict)
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(
      reviewTargetBlock({
        ...ctx,
        resident: true,
        workspace: "/workspace/threads/t-9f/patch-1",
        verifiedAtAttach: true,
      }),
    );
    expect(system).toContain("`/workspace/threads/t-9f/patch-1`");
    expect(system).toMatch(/verified it before this run/);
    expect(system).toMatch(/never `cd` out of it/i);
    // The coding/review resident preamble names the path too — every resident run, not only reviews.
    expect(system).toMatch(/Your shell starts in the worktree `\/workspace\/threads\/t-9f\/patch-1`/);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  it("a resident review attached at ANOTHER commit than the PR head is not started: named reply, no model turn, worktree released", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const head = "e".repeat(40);
    const attached = "4dd3832099140ee5c76022a525bbc5e7629d5ada";
    // Own stub: the shared one has no /detach route, and the release is the point here.
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ path, body });
        if (path === "/status") return new Response(JSON.stringify({ state: "warm", reason: "" }), { status: 200 });
        if (path === "/attach") {
          return new Response(
            JSON.stringify({
              workspace: "/workspace/threads/t-9f/patch-1",
              ref: "patch-1",
              sha: attached,
              user: "worker3",
            }),
            {
              status: 200,
            },
          );
        }
        if (path === "/detach") return new Response(JSON.stringify({ released: true }), { status: 200 });
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: head, baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    const post = vi.fn(async () => {});
    deps.postReviewComment = post;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(0); // no model turn burned on a guaranteed-refused review
    expect(post).not.toHaveBeenCalled();
    const reply = replies.find((r) => /not started/i.test(r)) ?? "";
    expect(reply).toContain("acme/api#42");
    expect(reply).toContain("`4dd3832`"); // what the resident attached
    expect(reply).toContain("`eeeeeee`"); // what the PR head is
    expect(reply).toMatch(/re-send/i);
    const last = statuses[statuses.length - 1];
    expect(last.title).toMatch(/not started/);
    // Before refusing, the PR's current head is asked once (item 12) — here the
    // GET fails (unknown) — then the pool user goes back.
    expect(calls.map((c) => c.path)).toEqual(["/status", "/attach", "/repos/acme/api/pulls/42", "/detach"]);
    expect(calls[3]?.body).toMatchObject({ force: true });
  });

  // agent-review.md item 12: the resident's attach fetches the mirror to the
  // ref's tip, so "attached ≠ resolved" is usually "a push raced the request
  // and the worktree is at the PR's head NOW". One GET decides: attached = the
  // current head → the run reviews it (the block names it as verified) instead
  // of refusing and asking the user to re-send.
  it("a resident review attached at a commit that IS the PR's current head (moved since resolution) runs, reviewing the attached head", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const resolvedHead = "e".repeat(40);
    const attached = "4dd3832099140ee5c76022a525bbc5e7629d5ada";
    residentFetchStub({
      attach: () =>
        new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t-9f/patch-1",
            ref: "patch-1",
            sha: attached,
            user: "worker3",
          }),
          {
            status: 200,
          },
        ),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    const registry = new RunRegistry({ genId: () => "run-adopt", genToken: () => "tok" });
    deps.runRegistry = registry;
    const ctx = { repo: "acme/api", ref: "patch-1", pr: 42, headSha: resolvedHead, baseRef: "main" };
    deps.resolveRepoContext = () => ctx;
    deps.fetchPrHead = async () => attached;
    const post = vi.fn(async () => {});
    deps.postReviewComment = post;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(2); // the review ran, then its verdict turn (this fake submits no verdict)
    // The run's meta went out at the reservation with the head as resolved, and
    // again at the adoption with the head attached — readers take the latest,
    // so the record and the page name the head actually reviewed.
    const metaHeads = registry
      .snapshotById("run-adopt")!
      .events.filter((e) => e.type === "run_meta")
      .map((e) => (e as { headSha?: string }).headSha);
    expect(metaHeads).toEqual([resolvedHead, attached]);
    // A resident run: its card note is the positive `resident · acme/api · …`,
    // and nothing on the stream claims the run went cold.
    expect(
      registry.snapshotById("run-adopt")!.events.some((e) => e.type === "run_note" && e.kind === "cold_sandbox"),
    ).toBe(false);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(
      reviewTargetBlock({
        ...ctx,
        headSha: attached,
        resident: true,
        workspace: "/workspace/threads/t-9f/patch-1",
        verifiedAtAttach: true,
      }),
    );
    expect(system).not.toContain(`Head commit: ${resolvedHead}`);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
    // The shared stub has no /exec route, so the workspace HEAD is unobservable
    // and no head was reported: the guard fails closed as always.
    expect(replies.some((r) => r.includes("reviewed head unknown"))).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  // When the PR head goes unresolved at resolution time and the run starts
  // anyway, the resident attaches a stale worktree, the model burns its turns
  // discovering the new head is not there and writes a `request_changes`
  // "cannot review" verdict, and the reviewed-head guard then refuses the post.
  // Every step downstream of an unknown head is a guaranteed refusal, so the
  // run is not started: one named reply, no attach, no model turn.
  it("a review of a PR whose head could not be resolved is not started: named reply, no attach, no model turn", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub({});
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 42 }); // fetch failed: pr named, no headSha
    const post = vi.fn(async () => {});
    deps.postReviewComment = post;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path === "/attach")).toHaveLength(0);
    const reply = replies.find((r) => /not started/i.test(r)) ?? "";
    expect(reply).toContain("acme/api#42");
    expect(reply).toMatch(/head/i);
    expect(reply).toMatch(/re-send/i);
    expect(statuses[statuses.length - 1].title).toMatch(/not started/);
  });

  it("a review whose INHERITED PR head is unreachable is not started the same way", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({});
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "unreachable" } });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review please", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(0);
    expect(replies.find((r) => /not started/i.test(r)) ?? "").toContain("acme/api#42");
  });

  it("a review whose inherited PR is CLOSED still runs (Slack-only, as before) — only an unknown head refuses", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({});
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      ref: "patch-1",
      prUnpostable: { number: 42, reason: "closed" },
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review please", "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(1);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  it("a coding run attached at a commit other than the PR head still runs — the pre-run head check is review-only", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({
      attach: () =>
        new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t-9f/patch-1",
            ref: "patch-1",
            sha: "4dd3832099140ee5c76022a525bbc5e7629d5ada",
            user: "worker3",
          }),
          { status: 200 },
        ),
    });
    const provider = capturingProvider();
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      ref: "patch-1",
      pr: 42,
      headSha: "e".repeat(40),
      baseRef: "main",
    });
    const { io, replies } = fakeIO();
    await dispatch(
      deps,
      msg("agent:coding https://github.com/acme/api/pull/42 fix the failing test", "slack:UADMIN"),
      io,
    );
    expect(provider.requests).toHaveLength(1);
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  it("a sandbox-path review of a resolved PR gets the sandbox variant of the REVIEW TARGET block", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider); // no resident configured
    const ctx = { repo: "acme/api", pr: 42, headSha: "e".repeat(40) };
    deps.resolveRepoContext = () => ctx;
    deps.postReviewComment = vi.fn(async () => {});
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.review.system);
    expect(system).toContain(reviewTargetBlock({ ...ctx, resident: false }));
    expect(system).toContain("`gh pr checkout 42`");
  });

  it("no REVIEW TARGET block for a coding run on a PR, nor for a review with no resolved PR", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    const coding = capturingProvider();
    const deps1 = makeDeps(REMOTE_YAML_FIXTURE, coding);
    deps1.resolveRepoContext = () => ({ repo: "acme/api", pr: 42, headSha: "e".repeat(40) });
    await dispatch(deps1, msg("agent:coding fix acme/api#42", "slack:UADMIN"), fakeIO().io);
    expect(coding.requests[0].system ?? "").not.toContain("REVIEW TARGET (resolved by Switchboard");

    const review = capturingProvider();
    const deps2 = makeDeps(REMOTE_YAML_FIXTURE, review);
    deps2.resolveRepoContext = () => ({ repo: "acme/api" });
    await dispatch(deps2, msg("agent:review look at acme/api", "slack:UADMIN"), fakeIO().io);
    expect(review.requests[0].system ?? "").not.toContain("REVIEW TARGET (resolved by Switchboard");
  });

  it("the per-thread fallback path keeps the agent's own system prompt (regression)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GH_TOKEN", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider); // no resident configured
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login bug in acme/api", "slack:UADMIN"), io);
    const system = provider.requests[0].system ?? "";
    expect(system).toContain(AGENTS.coding.system);
    expect(system).not.toContain(AGENTS.coding.residentSystem!);
  });
});

// Feature: docs/reference/specs/agent-review.md — the deterministic review post-step:
// a `review` run against a resolved PR posts its findings back to that PR
// by default (no "and post to the PR" needed). The system decides and posts (via
// the injected postReviewComment seam — no real network here); opt-out and
// no-PR reviews post nowhere; a post failure never fails the dispatch.
describe("review post-step", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function postSpy() {
    const calls: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const fn = vi.fn(async (target: ReviewCommentTarget, body: string) => {
      calls.push({ target, body });
    });
    return { calls, fn };
  }

  const PR_HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
  const OTHER_HEAD = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
  const THIRD_HEAD = "0123456789abcdef0123456789abcdef01234567";

  /** An executor whose workspace is a checkout at `head` (`git rev-parse HEAD`
   *  answers it); `head` undefined = a cwd that is not a git repo (the cold
   *  sandbox's workspace root). Records the order of exec/release calls. */
  function headExecutor(head: string | undefined) {
    const order: string[] = [];
    const executor = {
      exec: async (cmd: string) => {
        order.push(`exec:${cmd}`);
        if (/git rev-parse HEAD/.test(cmd))
          return head ? `${head}\n` : "fatal: not a git repository (or any of the parent directories): .git\nexit 128";
        return "";
      },
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => {
        order.push("release");
        return { released: true };
      },
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor });
    return { executor, order };
  }

  it("a review of a resolved PR posts the review back to the PR by default", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer"); // Slack still gets the review
    // No submit_verdict call → fail-closed: the body leads with the explicit
    // non-approving line, never "LGTM".
    expect(spy.calls).toEqual([
      { target: { repo: "acme/api", number: 42, commitId: PR_HEAD }, body: `${NO_VERDICT_LINE}\n\nanswer` },
    ]);
  });

  // agent-review.md item 5, verdictTurn.ts: a review whose loop ends with no
  // submit_verdict is given ONE more turn asking for it; the verdict the turn
  // submits builds the posted body's first line, the review's text stays the
  // loop's write-up, and the turn's note and tool call are on the record.
  it("a review whose loop ended without submit_verdict gets ONE verdict turn; the verdict it submits leads the posted body, the write-up stays the review's text", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        n++;
        if (n === 1)
          return {
            content: [{ type: "text", text: "Verdict: approve — the change is sound." }],
            stopReason: "end_turn",
          };
        if (n === 2)
          return {
            content: [
              {
                type: "tool_use",
                id: "v2",
                name: "submit_verdict",
                input: { verdict: "approve", summary: "the change is sound", head: PR_HEAD },
              },
            ],
            stopReason: "tool_use",
          };
        return { content: [{ type: "text", text: "Verdict submitted." }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const registry = new RunRegistry({ genId: () => "rv1", genToken: () => "tv1" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    // The verdict came from the turn: the body leads with LGTM over the loop's own write-up, never the turn's line.
    expect(spy.calls).toEqual([
      {
        target: { repo: "acme/api", number: 42, commitId: PR_HEAD },
        body: `LGTM: the change is sound\n\nVerdict: approve — the change is sound.`,
      },
    ]);
    expect(replies.some((r) => r.includes("Verdict: approve — the change is sound."))).toBe(true);
    expect(replies.some((r) => r.includes("Verdict submitted."))).toBe(false);
    const events = registry.snapshot("rv1", "tv1")?.events ?? [];
    const turnNotes = events.filter((e) => e.type === "run_note" && e.kind === "verdict_turn");
    expect(turnNotes).toHaveLength(1);
    if (turnNotes[0]?.type === "run_note") expect(turnNotes[0].summary).toContain("acme/api#42");
    // the turn's own tool call is in the record like any other
    expect(events.some((e) => e.type === "tool_call" && e.tool === "submit_verdict")).toBe(true);
  });

  // docs/reference/specs/agent-review.md item 10: a push that lands mid-run makes the
  // posted review one of an outdated commit — still posted, still pinned to
  // the reviewed head (so auto-approve skips it), but the thread is TOLD.
  describe("head-moved note (item 10)", () => {
    function reviewDeps(fetchPrHead: CoreDeps["fetchPrHead"]) {
      const provider = capturingProvider();
      const deps = makeDeps(YAML_FIXTURE, provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(PR_HEAD);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      deps.fetchPrHead = fetchPrHead;
      return { deps, spy };
    }
    const MOVED_NOTE =
      "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5. " +
      "The review was posted pinned to e8e43f4 and will not auto-approve — re-request to review d75b5a5.";

    it("PR head moved during the run → review still posted pinned to the reviewed head, and the thread gets the note", async () => {
      const asked: Array<{ repo: string; number: number }> = [];
      const { deps, spy } = reviewDeps(async (pr) => {
        asked.push(pr);
        return OTHER_HEAD;
      });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([PR_HEAD]);
      // Asked twice: at detection (item 12 — unclassifiable here, no fetchPrCommits answer) and after the post.
      expect(asked).toEqual([
        { repo: "acme/api", number: 42 },
        { repo: "acme/api", number: 42 },
      ]);
      expect(replies).toContain(MOVED_NOTE);
    });

    it("PR head unchanged → no note", async () => {
      const { deps, spy } = reviewDeps(async () => PR_HEAD);
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls).toHaveLength(1);
      expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
    });

    // docs/reference/specs/run-history.md item 2: the verdict the review
    // submitted and the head it reviewed ride the run's record — what a
    // coordinator's `read-record` answers for a review child.
    it("the review run's record carries the submitted verdict (findings included) and the reviewed head", async () => {
      let n = 0;
      const provider: Provider = {
        name: "fake",
        async complete(): Promise<CompletionResult> {
          n++;
          if (n === 1)
            return {
              content: [
                {
                  type: "tool_use",
                  id: "v1",
                  name: "submit_verdict",
                  input: {
                    verdict: "request_changes",
                    summary: "one nit",
                    head: PR_HEAD,
                    findings: [{ id: "F1", severity: "nit", file: "src/a.ts", line: 3, title: "off by one" }],
                  },
                },
              ],
              stopReason: "tool_use",
            };
          return { content: [{ type: "text", text: "Changes requested: one nit." }], stopReason: "end_turn" };
        },
      };
      const deps = makeDeps(YAML_FIXTURE, provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(PR_HEAD);
      deps.postReviewComment = postSpy().fn;
      deps.fetchPrHead = async () => PR_HEAD;
      deps.runRegistry = new RunRegistry({ genId: () => "r-verdict", genToken: () => "t-verdict" });
      const store = new InMemoryRunStore();
      deps.runHistoryWriter = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), fakeIO().io);
      await deps.runHistoryWriter.settled();
      const rec = (await store.get("r-verdict"))!;
      expect(rec.verdict).toEqual({
        verdict: "request_changes",
        summary: "one nit",
        head: PR_HEAD,
        findings: [{ id: "F1", severity: "nit", file: "src/a.ts", line: 3, title: "off by one" }],
      });
      expect(rec.reviewHead).toBe(PR_HEAD);
      expect("dispositions" in rec).toBe(false);
      // docs/reference/specs/agent-review.md item 18 — the post is a fact of the
      // record, so a reader woken by the finish never asks GitHub for it: the
      // record says the review landed, on which pull request, at which head.
      expect(rec.reviewPost).toEqual({
        posted: true,
        target: { repo: "acme/api", number: 42 },
        head: PR_HEAD,
        verdict: "request_changes",
      });
      expect(rec.events.filter((e) => e.type === "review_posted")).toEqual([
        expect.objectContaining({ type: "review_posted", repo: "acme/api", number: 42, head: PR_HEAD }),
      ]);
    });

    it("the record is written AFTER the post: the review_posted event and the reviewPost fact are on the record the store receives, and the record lands after the GitHub post was made (item 18)", async () => {
      const order: string[] = [];
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(PR_HEAD);
      deps.postReviewComment = async () => void order.push("post");
      deps.fetchPrHead = async () => PR_HEAD;
      deps.runRegistry = new RunRegistry({ genId: () => "r-order", genToken: () => "t-order" });
      const inner = new InMemoryRunStore();
      const store: RunStore = {
        put: async (r) => {
          order.push(`record:${r.status}`);
          return inner.put(r);
        },
        get: (id) => inner.get(id),
        getSummary: (id) => inner.getSummary(id),
        list: (o) => inner.list(o),
        events: (id, o) => inner.events(id, o),
        delete: (id) => inner.delete(id),
        usageByUser: (q) => inner.usageByUser(q),
      };
      deps.runHistoryWriter = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), fakeIO().io);
      await deps.runHistoryWriter.settled();
      // The start tombstone (run-history item 27) lands at create; the finish
      // record — the one the runner reads — lands after the post.
      expect(order).toEqual(["record:interrupted", "post", "record:completed"]);
      const rec = (await inner.get("r-order"))!;
      expect(rec.reviewPost).toMatchObject({ posted: true, head: PR_HEAD, verdict: "approve" });
    });

    it("a post the reviewed-head guard refused is recorded as a skip with its reason, beside a review_not_posted note — the record says the verdict is Slack-only, not that GitHub is slow (item 18)", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "looks great"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(OTHER_HEAD);
      deps.postReviewComment = postSpy().fn;
      deps.runRegistry = new RunRegistry({ genId: () => "r-skip", genToken: () => "t-skip" });
      const store = new InMemoryRunStore();
      deps.runHistoryWriter = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
      vi.spyOn(console, "log").mockImplementation(() => {});
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), fakeIO().io);
      await deps.runHistoryWriter.settled();
      const rec = (await store.get("r-skip"))!;
      expect(rec.reviewPost).toEqual({ posted: false, reason: expect.stringContaining("is not the PR head") });
      expect(rec.events.filter((e) => e.type === "run_note" && e.kind === "review_not_posted")).toHaveLength(1);
      vi.restoreAllMocks();
    });

    // docs/reference/specs/agent-ship.md item 13 — a coordinator's review child is
    // dispatched with the same contract object its coding child was handed: the
    // block enters the system prompt right after the REVIEW TARGET block, and
    // the review's user turn is unchanged.
    it("a review run dispatched with a contract carries the rendered block in its system prompt after the REVIEW TARGET block, its user turn unchanged", async () => {
      const contract = contractFromPlan({
        planMarkdown: "### U1. do the unit\n\ndo the unit\n",
        unitId: "U1",
        readSpec: () => undefined,
        rebase: { branch: "plan/p/u10", onto: "main" },
      });
      const block = renderContract(contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text;
      const { deps } = reviewDeps(async () => PR_HEAD);
      const provider = deps.completions.get("anthropic") as Provider & { requests: CompletionRequest[] };
      const text = "agent:review https://github.com/acme/api/pull/42";
      await dispatch(deps, msg(text), fakeIO().io, { contract });
      const system = provider.requests[0].system ?? "";
      expect(system).toContain(block);
      expect(system.indexOf("REVIEW TARGET")).toBeGreaterThan(-1);
      expect(system.indexOf(block)).toBeGreaterThan(system.indexOf("REVIEW TARGET"));
      const first = provider.requests[0].messages.find((m) => m.role === "user")!;
      expect(first.content.flatMap((p) => (p.type === "text" ? [p.text] : []))).toEqual([
        "https://github.com/acme/api/pull/42",
      ]);
    });

    it("current head unknown (fetch fails or answers nothing) → no note, never a false alarm", async () => {
      for (const fetchPrHead of [
        async () => undefined,
        async () => {
          throw new Error("boom");
        },
      ]) {
        const { deps, spy } = reviewDeps(fetchPrHead);
        const { io, replies } = fakeIO();
        await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
        expect(spy.calls).toHaveLength(1);
        expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
        vi.mocked(makeExecutor).mockClear();
      }
    });

    it("guard refused (reviewed head is neither the resolved nor the current PR head) → nothing posted, no note; the current head was asked once, before refusing", async () => {
      const asked: unknown[] = [];
      const { deps, spy } = reviewDeps(async (pr) => {
        asked.push(pr);
        return THIRD_HEAD;
      });
      vi.mocked(makeExecutor).mockReset();
      headExecutor(OTHER_HEAD); // workspace HEAD is not the PR head → guard skips the post
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls).toHaveLength(0);
      expect(asked).toHaveLength(1);
      expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
      expect(replies.some((r) => r.includes("reviewed head d75b5a5 is not the PR head e8e43f4"))).toBe(true);
    });
  });

  // docs/reference/specs/agent-review.md item 12: a head that moved while the review ran
  // is classified from GitHub's compare lists — a rebase of the same commits
  // carries the review to the new head; anything else makes the SAME run
  // re-review at the new head before posting. Unknown → item 10's pinned post
  // + note. Before either guard refuses, the current head is consulted.
  describe("head moved during the run (item 12)", () => {
    const THIRD = THIRD_HEAD;
    const MOVED_NOTE =
      "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5. " +
      "The review was posted pinned to e8e43f4 and will not auto-approve — re-request to review d75b5a5.";
    const list = (msgs: string[], files: string[]) => ({
      commits: msgs.map((message, i) => ({ sha: `${(i + 1).toString(16)}`.repeat(40).slice(0, 40), message })),
      files,
      filesTruncated: false,
    });
    const SAME = {
      [PR_HEAD]: list(["feat: catalog", "fix: nits"], ["src/a.ts"]),
      [OTHER_HEAD]: list(["feat: catalog", "fix: nits"], ["src/a.ts"]),
    };
    const CHANGED = {
      [PR_HEAD]: list(["feat: catalog"], ["src/a.ts"]),
      [OTHER_HEAD]: list(["feat: catalog", "fix: review nits"], ["src/a.ts", "src/a.test.ts"]),
    };

    /** A review-agent provider answering a sequence of turns: each entry is
     *  either a plain answer or a verdict call followed by an answer. */
    function turnsProvider(turns: Array<{ verdict?: { verdict: string; head: string }; answer: string }>) {
      const requests: CompletionRequest[] = [];
      let i = 0;
      let pendingAnswer: string | undefined;
      const provider: Provider & { requests: CompletionRequest[] } = {
        name: "fake",
        requests,
        async complete(req): Promise<CompletionResult> {
          // Snapshot: the runner keeps appending to the same messages array.
          requests.push({ ...req, messages: [...req.messages] });
          if (pendingAnswer !== undefined) {
            const a = pendingAnswer;
            pendingAnswer = undefined;
            return { content: [{ type: "text", text: a }], stopReason: "end_turn" };
          }
          const t = turns[i++];
          if (!t) throw new Error("provider asked for more turns than scripted");
          if (t.verdict) {
            pendingAnswer = t.answer;
            return {
              content: [
                { type: "tool_use", id: `v${i}`, name: "submit_verdict", input: { ...t.verdict, summary: "ok" } },
              ],
              stopReason: "tool_use",
            };
          }
          return { content: [{ type: "text", text: t.answer }], stopReason: "end_turn" };
        },
      };
      return provider;
    }

    /** The provider requests that open a review turn: the last message is a
     *  user TEXT message (the request, or the re-review follow-up) — tool_result
     *  continuations within a turn are not counted. */
    const reviewTurns = (provider: { requests: CompletionRequest[] }) =>
      provider.requests.filter((r) => {
        const last = r.messages.at(-1);
        return last?.role === "user" && last.content.every((p) => p.type === "text");
      });

    /** An executor whose HEAD is a mutable cell; `moveTo` (when present) sets it. */
    function movableExecutor(initial: string, opts: { moveTo?: boolean; moveLandsAt?: string } = { moveTo: true }) {
      const state = {
        head: initial,
        moves: [] as string[],
        released: 0,
        probeSpans: [] as string[],
        moveSpans: [] as string[],
      };
      const executor: Record<string, unknown> = {
        // The settle's probe and move carry their span (docs/reference/specs/tracing.md item 17): recorded by name.
        exec: async (cmd: string, opts?: { span?: { name: string } }) => {
          if (!/git rev-parse HEAD/.test(cmd)) return "";
          state.probeSpans.push(opts?.span?.name ?? "none");
          return `${state.head}\n`;
        },
        readFile: async () => "",
        writeFile: async () => "",
        release: async () => {
          state.released++;
          return { released: true };
        },
      };
      if (opts.moveTo) {
        executor.moveTo = async (sha: string, o?: { span?: { name: string } }) => {
          state.moves.push(sha);
          state.moveSpans.push(o?.span?.name ?? "none");
          state.head = opts.moveLandsAt ?? sha;
          return { sha: state.head };
        };
      }
      vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: executor as never });
      return state;
    }

    function setup(input: {
      provider: Provider;
      heads: string[]; // successive answers of fetchPrHead
      commits?: Record<string, ReturnType<typeof list>>;
      executor?: ReturnType<typeof movableExecutor>;
    }) {
      const deps = makeDeps(YAML_FIXTURE, input.provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD, baseRef: "main" });
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const heads = [...input.heads];
      const headAsks: number[] = [];
      deps.fetchPrHead = async () => {
        headAsks.push(1);
        return heads.length > 1 ? heads.shift() : heads[0];
      };
      const commitAsks: Array<{ base: string; sha: string }> = [];
      deps.fetchPrCommits = async (q) => {
        commitAsks.push({ base: q.base, sha: q.sha });
        return input.commits?.[q.sha];
      };
      return { deps, spy, headAsks, commitAsks };
    }

    it("rebase-only move → ONE model turn, review posted pinned to the NEW head with the carried footer, thread told, no worktree move", async () => {
      const provider = turnsProvider([{ verdict: { verdict: "approve", head: PR_HEAD }, answer: "Looks solid." }]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy, commitAsks } = setup({ provider, heads: [OTHER_HEAD], commits: SAME });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(reviewTurns(provider)).toHaveLength(1); // no re-review
      expect(ex.moves).toEqual([]);
      expect(ex.probeSpans.length).toBeGreaterThan(0);
      expect(new Set(ex.probeSpans)).toEqual(new Set(["run.settle_reviewed_head"]));
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: OTHER_HEAD });
      expect(spy.calls[0].body).toMatch(
        /^LGTM: ok\n\nLooks solid\.\n\n_Reviewed at e8e43f4; the head moved to d75b5a5 during the review — a rebase of the same 2 commits — so this review is posted against d75b5a5\._$/,
      );
      expect(commitAsks).toEqual([
        { base: "main", sha: PR_HEAD },
        { base: "main", sha: OTHER_HEAD },
      ]);
      expect(replies).toContain(
        "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5 — a rebase of the same 2 commits (same messages, same files). The review applies unchanged and was posted pinned to d75b5a5.",
      );
      expect(replies.some((r) => r.includes("re-request"))).toBe(false);
    });

    it("substantive move → the same run re-reviews: note + card, worktree moved, second turn sees the new head and the follow-up, post pinned to the new head with the NEW verdict", async () => {
      const provider = turnsProvider([
        { verdict: { verdict: "approve", head: PR_HEAD }, answer: "First review: approve." },
        { verdict: { verdict: "request_changes", head: OTHER_HEAD }, answer: "Second review: the new test is wrong." },
      ]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy, headAsks } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
      deps.runRegistry = registry;
      const { io, replies, statuses } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      // Two review turns (each: verdict call + answer) in ONE run.
      expect(ex.moves).toEqual([OTHER_HEAD]);
      expect(ex.moveSpans).toEqual(["run.settle_reviewed_head"]);
      const userTurns = reviewTurns(provider);
      expect(userTurns).toHaveLength(2);
      const second = userTurns[1];
      // The follow-up rides as a new user turn after the first review, in the same conversation.
      const last = second.messages.at(-1)!;
      const followUp = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      expect(followUp).toContain("moved from e8e43f4 to d75b5a5 while you were reviewing");
      expect(followUp).toContain("Switchboard has already moved your worktree to d75b5a5");
      expect(followUp).toContain("- 2222222 fix: review nits");
      expect(second.messages.at(-2)).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "First review: approve." }],
      });
      // pi reads its system prompt once, at load: the REVIEW TARGET block stays the
      // session's and the follow-up alone names the new head (harness-pi item 14).
      expect(second.system).toContain(`Head commit: ${PR_HEAD}`);
      expect(second.system).not.toContain(`Head commit: ${OTHER_HEAD}`);
      // Posted once, pinned to the new head, with the SECOND verdict and answer — the first approve is void.
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: OTHER_HEAD });
      expect(spy.calls[0].body).toBe("Changes requested: ok\n\nSecond review: the new test is wrong.");
      // The thread: the 🔀 note at detection, the second answer as the reply, no stale-pin note.
      expect(replies).toContain(
        "🔀 acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5 — 1 → 2 commits (+ “fix: review nits”). Re-reviewing at d75b5a5 before posting.",
      );
      expect(replies).toContain("Second review: the new test is wrong.");
      expect(replies).not.toContain("First review: approve.");
      expect(replies.some((r) => r.includes("re-request"))).toBe(false);
      // The card said so while it happened, and the run stream carries the note.
      expect(statuses.some((s) => /head moved → d75b5a5/.test(s.title))).toBe(true);
      const snap = registry.snapshot("r1", "t1");
      expect(
        snap?.events.some((e) => e.type === "run_note" && e.kind === "head_moved" && /d75b5a5/.test(e.summary)),
      ).toBe(true);
      // Only the final answer is the run's answer.
      expect(snap?.events.filter((e) => e.type === "answer").map((e) => (e as { text: string }).text)).toEqual([
        "Second review: the new test is wrong.",
      ]);
      // Head asked: once at detection, once after the re-review (still d75b5a5), once after the post.
      expect(headAsks.length).toBeGreaterThanOrEqual(2);
    });

    it("substantive move on an executor without moveTo (sandbox clone): the follow-up tells the model to fetch + check out the new head", async () => {
      const provider = turnsProvider([
        { answer: "first" },
        { verdict: { verdict: "approve", head: OTHER_HEAD }, answer: "second" },
      ]);
      const ex = movableExecutor(PR_HEAD, { moveTo: false });
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(ex.moves).toEqual([]);
      const userTurns = reviewTurns(provider);
      expect(userTurns).toHaveLength(2);
      const followUp = userTurns[1].messages
        .at(-1)!
        .content.map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      expect(followUp).toContain(`git fetch origin ${OTHER_HEAD} && git checkout ${OTHER_HEAD}`);
      // The workspace HEAD is still the old commit (this fake model never ran the checkout), but the
      // verdict reports the new head: observed wins → the post is refused, said in the thread.
      expect(spy.calls).toHaveLength(0);
    });

    it("compare unavailable (classifier has no verdict) → item 10 behaviour: pinned to the reviewed head, re-request note, one turn", async () => {
      const provider = turnsProvider([{ verdict: { verdict: "approve", head: PR_HEAD }, answer: "ok" }]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD] }); // fetchPrCommits → undefined
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(ex.moves).toEqual([]);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([PR_HEAD]);
      expect(replies).toContain(MOVED_NOTE);
    });

    it("the head moves AGAIN after the re-review → re-reviewed once only; posted pinned to the re-reviewed head with the re-request note for the newest", async () => {
      const provider = turnsProvider([
        { answer: "first" },
        { verdict: { verdict: "approve", head: OTHER_HEAD }, answer: "second" },
      ]);
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD, THIRD, THIRD], commits: CHANGED });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(ex.moves).toEqual([OTHER_HEAD]);
      expect(reviewTurns(provider)).toHaveLength(2);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([OTHER_HEAD]);
      expect(replies.some((r) => r.includes("reviewed d75b5a5, head is now 0123456") && r.includes("re-request"))).toBe(
        true,
      );
    });

    it("worktree move fails (resident refuses) → the model is told to check the new head out itself; the run continues", async () => {
      const provider = turnsProvider([{ answer: "first" }, { answer: "second" }]);
      const state = { head: PR_HEAD };
      vi.mocked(makeExecutor).mockResolvedValueOnce({
        executor: {
          exec: async (cmd: string) => (/git rev-parse HEAD/.test(cmd) ? `${state.head}\n` : ""),
          readFile: async () => "",
          writeFile: async () => "",
          moveTo: async () => {
            throw new Error("not-serviceable: refreshing");
          },
        } as never,
      });
      const { deps } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      const userTurns = reviewTurns(provider);
      const followUp = userTurns[1].messages
        .at(-1)!
        .content.map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      expect(followUp).toContain("git fetch origin");
    });

    it("reviewed head ≠ resolved head but = the PR's CURRENT head (the resident re-attached at a newer tip) → posted, pinned to it, no refusal", async () => {
      const provider = turnsProvider([{ verdict: { verdict: "approve", head: OTHER_HEAD }, answer: "ok" }]);
      movableExecutor(OTHER_HEAD);
      const { deps, spy } = setup({ provider, heads: [OTHER_HEAD] });
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls.map((c) => c.target.commitId)).toEqual([OTHER_HEAD]);
      expect(spy.calls[0].body.startsWith("LGTM:")).toBe(true);
      expect(replies.some((r) => r.includes("not posted"))).toBe(false);
      expect(replies.some((r) => r.includes("moved during the run"))).toBe(false);
    });

    it("a hard-stopped review never classifies, moves or re-reviews", async () => {
      const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
      let signal: AbortSignal | undefined;
      const provider: Provider = {
        name: "hang",
        complete: (req) =>
          new Promise((resolve) => {
            signal = req.signal;
            req.signal?.addEventListener("abort", () =>
              resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }),
            );
          }),
      };
      const ex = movableExecutor(PR_HEAD);
      const { deps, spy, headAsks, commitAsks } = setup({ provider, heads: [OTHER_HEAD], commits: CHANGED });
      deps.runRegistry = registry;
      const { io } = fakeIO();
      const run = dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      while (!signal) await new Promise((r) => setTimeout(r, 5));
      registry.requestStop("r1", "t1", "hard");
      await run;
      expect(spy.calls).toEqual([]);
      expect(ex.moves).toEqual([]);
      expect(headAsks).toEqual([]);
      expect(commitAsks).toEqual([]);
    });
  });

  // Feature: docs/reference/specs/harness-pi.md item 6 — a HARD-stopped review has no
  // findings (its answer is the abort line), so nothing is posted to the PR.
  it("a hard-stopped review posts nothing to the PR", async () => {
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    let hardSignal: AbortSignal | undefined;
    const provider: Provider = {
      name: "hang",
      complete: (req) =>
        new Promise((resolve) => {
          hardSignal = req.signal;
          req.signal?.addEventListener("abort", () =>
            resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }),
          );
        }),
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40) });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    const run = dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    while (!hardSignal) await new Promise((r) => setTimeout(r, 5));
    registry.requestStop("r1", "t1", "hard");
    await run;
    expect(replies.some((r) => r.includes("aborted"))).toBe(true); // Slack still learns why it ended
    expect(spy.calls).toEqual([]); // …but the PR gets no "review"
  });

  /** A review-agent provider that calls submit_verdict, then answers. */
  function verdictThenAnswer(verdict: string, summary: string, answer = "the findings", head?: string): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "v1",
                name: "submit_verdict",
                input: head ? { verdict, summary, head } : { verdict, summary },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  it("an `approve` verdict makes the posted body start with the exact `LGTM:` token (deterministic, not prose)", async () => {
    const deps = makeDeps(
      YAML_FIXTURE,
      verdictThenAnswer("approve", "no blocking issues", "Looks solid.\n- nit: naming"),
    );
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: "c".repeat(40) });
    headExecutor("c".repeat(40));
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].body).toBe("LGTM: no blocking issues\n\nLooks solid.\n- nit: naming");
    // pinned to the reviewed head so the workflow's stale-review guard can bite
    expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: "c".repeat(40) });
  });

  it("a `request_changes` verdict never yields an LGTM-prefixed body, even when the prose says LGTM", async () => {
    const deps = makeDeps(
      YAML_FIXTURE,
      verdictThenAnswer("request_changes", "null deref", "LGTM except for the null deref"),
    );
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(spy.calls[0].body.startsWith("Changes requested: null deref\n\n")).toBe(true);
    expect(spy.calls[0].body.startsWith("LGTM")).toBe(false);
    expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: PR_HEAD });
  });

  it("a verdict from a non-review agent is impossible: the tool is not in the coding toolset", async () => {
    const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "x"));
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding https://github.com/acme/api/pull/42 fix it", "slack:UADMIN"), io);
    expect(spy.fn).not.toHaveBeenCalled();
  });

  it("opt-out ('don't post' / 'slack only') suppresses the GitHub post; Slack still gets it", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42 — don't post, slack only"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
  });

  it("a review with no resolved PR (pasted code / repo-only) posts nowhere — no crash", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" }); // repo but no PR number
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review look at the diff in acme/api"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
    // The skip is never silent: a review that lands only in Slack says why.
    expect(log.mock.calls.map((c) => c.map(String).join(" "))).toContainEqual(
      expect.stringMatching(/^\[review-post\] .* skipped: no PR resolved/),
    );
    log.mockRestore();
  });

  it("a bound PR that could not be posted to (closed / unreachable) is said out loud in the thread", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "closed" } });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
    expect(replies.some((r) => /not posted to acme\/api#42/.test(r) && /closed/.test(r))).toBe(true);
  });

  it("an explicit opt-out wins over an unpostable bound PR: no thread note (the user already knows it's Slack-only)", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "closed" } });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review, slack only"), io);
    expect(replies).toContain("answer");
    expect(spy.fn).not.toHaveBeenCalled();
    expect(replies.some((r) => /not posted to/.test(r))).toBe(false);
    expect(log.mock.calls.map((c) => c.map(String).join(" "))).toContainEqual(
      expect.stringMatching(/^\[review-post\] .* skipped: opted out/),
    );
    log.mockRestore();
  });

  it("an unreachable bound PR never reaches the post-step: the run is refused up front, with no model turn", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "unreachable" } });
    deps.postReviewComment = postSpy().fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review re-review"), io);
    expect(provider.requests).toHaveLength(0);
    const reply = replies.find((r) => /not started/i.test(r)) ?? "";
    expect(reply).toContain("acme/api#42");
    expect(reply).not.toMatch(/GitHub was down|could not be reached/); // never claims an outage it cannot prove
  });

  it("an unknown head with an explicit 'slack only' opt-out still runs — the user asked for an unpinned, Slack-only verdict", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42 — slack only"), io);
    expect(provider.requests).toHaveLength(1);
    expect(spy.fn).not.toHaveBeenCalled();
    expect(replies.some((r) => /not started/i.test(r))).toBe(false);
  });

  // Feature: docs/reference/specs/agent-review.md item 8 — the reviewed-head guard.
  // An agent that fetches another PR's branch and reviews it would otherwise
  // have its LGTM posted (and auto-approved) on the wrong PR. The post-step
  // refuses to post unless the head the agent actually reviewed IS the PR
  // head resolved for the run. Fail-closed.
  describe("reviewed-head guard", () => {
    it("the workspace HEAD is not the PR head → no post, the thread is told both shas", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "looks great"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(OTHER_HEAD);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(replies).toContain("the findings"); // Slack still gets the review
      const note = replies.find((r) => /not posted to acme\/api#42/.test(r));
      expect(note).toMatch(
        new RegExp(`reviewed head ${OTHER_HEAD.slice(0, 7)} is not the PR head ${PR_HEAD.slice(0, 7)}`),
      );
      expect(log.mock.calls.map((c) => c.map(String).join(" "))).toContainEqual(
        expect.stringMatching(/^\[review-post\] .* skipped: reviewed head .* is not the PR head/),
      );
      log.mockRestore();
    });

    it("the workspace HEAD is observed BEFORE the workspace is released (a re-attach would show the ref's current tip, not what was reviewed)", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      const { order } = headExecutor(PR_HEAD);
      deps.postReviewComment = postSpy().fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      const rev = order.findIndex((o) => /rev-parse HEAD/.test(o));
      const rel = order.indexOf("release");
      expect(rev).toBeGreaterThanOrEqual(0);
      expect(rel).toBeGreaterThan(rev);
    });

    it("the PR head is unknown (resolution-time fetch failed) → the run is not started at all; nothing posted", async () => {
      const provider = verdictThenAnswer("approve", "ok");
      const deps = makeDeps(YAML_FIXTURE, provider);
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 }); // no headSha
      vi.mocked(makeExecutor).mockClear();
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(makeExecutor).not.toHaveBeenCalled(); // no workspace provisioned, no head probe
      expect(replies.some((r) => /not started/i.test(r) && /acme\/api#42/.test(r) && /head/i.test(r))).toBe(true);
    });

    it("no git in the workspace cwd (cold sandbox root) → the agent-reported head decides: match posts, pinned", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok", "fine", PR_HEAD.slice(0, 12)));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(undefined);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0].target).toEqual({ repo: "acme/api", number: 42, commitId: PR_HEAD });
      expect(spy.calls[0].body.startsWith("LGTM: ok")).toBe(true);
    });

    it("no git in the cwd and the reported head mismatches → no post", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok", "fine", OTHER_HEAD));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(undefined);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(replies.some((r) => /not posted to acme\/api#42/.test(r))).toBe(true);
    });

    it("no git in the cwd and no reported head → no post (reviewed head unknown)", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok"));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(undefined);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io, replies } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
      expect(replies.some((r) => /not posted to acme\/api#42/.test(r) && /reviewed head unknown/.test(r))).toBe(true);
    });

    it("a matching reported head cannot override a mismatching observed HEAD", async () => {
      const deps = makeDeps(YAML_FIXTURE, verdictThenAnswer("approve", "ok", "fine", PR_HEAD));
      deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
      headExecutor(OTHER_HEAD);
      const spy = postSpy();
      deps.postReviewComment = spy.fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
      expect(spy.fn).not.toHaveBeenCalled();
    });

    it("a non-PR review (no post target) never runs the head probe", async () => {
      const deps = makeDeps(YAML_FIXTURE, capturingProvider());
      deps.resolveRepoContext = () => ({ repo: "acme/api" });
      const { order } = headExecutor(PR_HEAD);
      deps.postReviewComment = postSpy().fn;
      const { io } = fakeIO();
      await dispatch(deps, msg("agent:review look at acme/api"), io);
      expect(order.some((o) => /rev-parse HEAD/.test(o))).toBe(false);
    });
  });

  it("a non-review agent never posts, even when a PR is resolved", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42 });
    const spy = postSpy();
    deps.postReviewComment = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding acme/api#42 fix it", "slack:UADMIN"), io);
    expect(spy.fn).not.toHaveBeenCalled();
  });

  it("a post failure is swallowed — the dispatch still completes and Slack gets the review", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    headExecutor(PR_HEAD);
    deps.postReviewComment = vi.fn(async () => {
      throw new Error("HTTP 403 forbidden");
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review acme/api#42"), io);
    expect(replies).toContain("answer");
    expect(deps.postReviewComment).toHaveBeenCalledTimes(1);
    // …and the thread is told, so a Slack-only verdict is never mistaken for a posted one.
    expect(replies.some((r) => /not posted to acme\/api#42/.test(r) && /403/.test(r))).toBe(true);
  });
});

// Feature: docs/reference/specs/pr-description.md item 5, docs/reference/specs/agent-coding.md item 2 —
// the coding PR post-step: after a writable coding run pushed a branch and
// submitted its typed PrDescription, the DISPATCHER observes the pushed head +
// branch in the workspace (before release), renders the body at that head, and
// opens or edits the PR in the bot process (via the injected openPullRequest
// seam — no real network here) — from typed values only. Failure honesty: no
// description / no observable push / a failed open never fabricates a URL; the
// thread gets the branch compare URL and a plain reason.
describe("coding PR post-step (docs/reference/specs/pr-description.md)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

  const DESCRIPTION = {
    title: "Fix the login redirect",
    tldr: "Restores the session cookie on login. Users can sign in again.",
    whatWhy: "The handler dropped the cookie after the redirect change; this restores it.",
    tour: [
      {
        title: "The fix",
        description: "The cookie is set on the redirect response again.",
        anchor: { path: "src/login.ts", from: 10, to: 20 },
      },
    ],
    remaining: [],
    decisions: [{ title: "Keep the cookie name", rationale: "renaming would log everyone out" }],
    risks: "none — covered by the auth suite",
    validation: { criteria: [{ criterion: "auth suite green", proof: "npm test — 24 passing" }] },
  };

  /** A coding-agent provider that submits the description (when given), then answers. */
  function describeThenAnswer(desc: Record<string, unknown> | undefined, answer = "Done — branch pushed."): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (desc && n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "d1", name: "submit_pr_description", input: desc }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  /** A workspace checkout: `git rev-parse HEAD` answers `head`, `--abbrev-ref
   *  HEAD` answers `branch`, `ls-remote origin refs/heads/<branch>` answers
   *  `remoteHead` (defaults to `head` — a pushed, up-to-date branch; `null` =
   *  the remote has no such branch, exit 2), `remote get-url origin` answers
   *  `remote`; any undefined = the command fails. With `cloneDir` the
   *  workspace root is NOT a repo (the cold path cloned into that
   *  subdirectory): root git probes fail, `ls -d *\/.git` finds the clone, and
   *  only `git -C '<cloneDir>' …` probes answer — and, like the real cold
   *  clone (`gh repo clone … -- --depth 50`, single-branch), `@{u}` never
   *  resolves there even after a successful push); a resident tree is a
   *  full clone, so its `@{u}` answers `remoteHead`. A `bindingRef` makes the
   *  selection a resident one bound to that ref. With `pushed`, the agent's
   *  own `git push` answers git's status block for that branch (the run's
   *  push, as the runner records it), `rev-parse 'refs/heads/<b>'`
   *  answers its tip and the remote holds it at `pushed.remoteHead`
   *  (defaults to the tip; `null` = not on the remote) — while `branch`/`head`
   *  stay the CHECKOUT, which may have moved on. Records the order of
   *  exec/release calls. */
  function codingExecutor(
    opts: {
      head?: string;
      branch?: string;
      remoteHead?: string | null;
      remote?: string;
      cloneDir?: string;
      bindingRef?: string;
      pushed?: { branch: string; head: string; remoteHead?: string | null };
    } = {},
  ) {
    const order: string[] = [];
    const remoteHead = opts.remoteHead === null ? undefined : (opts.remoteHead ?? opts.head);
    const pushedRemoteHead =
      opts.pushed?.remoteHead === null ? undefined : (opts.pushed?.remoteHead ?? opts.pushed?.head);
    const notARepo = "fatal: not a git repository\nexit 128";
    const pushBlock = opts.pushed
      ? `remote: \nremote: Create a pull request for '${opts.pushed.branch}' on GitHub by visiting:\nremote:      https://github.com/acme/api/pull/new/${opts.pushed.branch}\nremote: \nTo https://github.com/acme/api.git\n * [new branch]      ${opts.pushed.branch} -> ${opts.pushed.branch}\nbranch '${opts.pushed.branch}' set up to track 'origin/${opts.pushed.branch}'.\n`
      : "";
    const git = (cmd: string) => {
      // The push itself prints the block; so does `cat push.log` — a transcript
      // of it, which must NOT count as a push.
      if (/^git push\b/.test(cmd) || /^cat push\.log\b/.test(cmd)) return pushBlock;
      if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return opts.branch ? `${opts.branch}\n` : notARepo;
      if (/rev-parse @\{u\}/.test(cmd)) {
        if (opts.cloneDir)
          return `exit 128:\nfatal: upstream branch 'refs/heads/${opts.branch}' not stored as a remote-tracking branch\n`;
        return remoteHead ? `${remoteHead}\n` : "exit 128:\nfatal: no upstream configured for branch\n";
      }
      if (/rev-parse '[^']+@\{u\}'/.test(cmd))
        return "exit 128:\nfatal: upstream branch not stored as a remote-tracking branch\n";
      if (/rev-parse HEAD/.test(cmd)) return opts.head ? `${opts.head}\n` : notARepo;
      const tip = /rev-parse 'refs\/heads\/([^']+)'/.exec(cmd);
      if (tip)
        return opts.pushed && tip[1] === opts.pushed.branch
          ? `${opts.pushed.head}\n`
          : `exit 128:\nfatal: ambiguous argument '${tip[0]}': unknown revision\n`;
      const lsRemote = /ls-remote --exit-code origin 'refs\/heads\/([^']+)'/.exec(cmd);
      if (lsRemote) {
        if (opts.pushed && lsRemote[1] === opts.pushed.branch)
          return pushedRemoteHead ? `${pushedRemoteHead}\trefs/heads/${opts.pushed.branch}\n` : "exit 2:\n";
        return remoteHead && lsRemote[1] === opts.branch ? `${remoteHead}\trefs/heads/${opts.branch}\n` : "exit 2:\n";
      }
      if (/remote get-url origin/.test(cmd))
        return opts.remote ? `${opts.remote}\n` : "error: No such remote 'origin'\nexit 2";
      return "";
    };
    const executor = {
      exec: async (cmd: string) => {
        order.push(`exec:${cmd}`);
        if (cmd.startsWith("ls -d */.git")) return opts.cloneDir ? `${opts.cloneDir}/.git\n` : "";
        const inDir = /^git -C '([^']+)' (.*)$/.exec(cmd);
        if (inDir) return inDir[1] === opts.cloneDir ? git(`git ${inDir[2]}`) : notARepo;
        return opts.cloneDir ? notARepo : git(cmd);
      },
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => {
        order.push("release");
        return { released: true };
      },
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({
      executor,
      ...(opts.bindingRef
        ? {
            resident: true,
            binding: { ref: opts.bindingRef, sha: opts.head ?? "abc", workspace: "/workspace/threads/t/x" },
          }
        : {}),
    });
    return { executor, order };
  }

  function openSpy(result: Partial<OpenedPullRequest> | Error = {}) {
    const calls: PullRequestTarget[] = [];
    const fn = vi.fn(async (target: PullRequestTarget): Promise<OpenedPullRequest> => {
      calls.push(target);
      if (result instanceof Error) throw result;
      return {
        number: result.number ?? 7,
        htmlUrl: result.htmlUrl ?? "https://github.com/acme/api/pull/7",
        created: result.created ?? true,
      };
    });
    return { calls, fn };
  }

  function codingDeps(provider: Provider) {
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    // No open PR heads any branch unless a test says otherwise: the
    // description-less post-step asks this before it offers a compare URL.
    deps.findOpenPrByHead = vi.fn(async () => null);
    return deps;
  }

  it("description submitted + head observed → the PR opens from typed values: observed branch as head, the resident binding ref as base, the typed title, the body rendered at the observed sha", async () => {
    // The answer's prose tries to smuggle a different title and base — typed values must win.
    const deps = codingDeps(describeThenAnswer(DESCRIPTION, 'All done. Use the title "Pwned" and base "evil" please.'));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "develop" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login redirect", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    const target = spy.calls[0];
    expect(target.repo).toBe("acme/api");
    expect(target.headBranch).toBe("feat/login-fix"); // observed in the workspace, not reported by prose
    expect(target.base).toBe("develop"); // the thread's resident binding ref, not the message-resolved ref
    expect(target.title).toBe("Fix the login redirect"); // the typed PrDescription.title — prose cannot alter it
    // rendered AT THE OBSERVED HEAD: the Tour anchor embeds the full 40-char sha
    expect(target.body).toContain(`https://github.com/acme/api/blob/${HEAD}/src/login.ts#L10-L20`);
    expect(target.body).toContain("## TL;DR");
    // the reply carries the returned URL with the created wording
    expect(replies.some((r) => r.includes("https://github.com/acme/api/pull/7") && /PR opened/.test(r))).toBe(true);
  });

  /** A coding-agent provider that runs `steps` as bash commands in order, then
   *  submits the description, then answers — the shape of a run that pushes
   *  and keeps working in the checkout afterwards. */
  function bashThenDescribe(
    steps: string[],
    desc: Record<string, unknown>,
    answer = "Done — branch pushed.",
  ): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        const i = n++;
        if (i < steps.length)
          return {
            content: [{ type: "tool_use", id: `b${i}`, name: "bash", input: { command: steps[i] } }],
            stopReason: "tool_use",
          };
        if (i === steps.length)
          return {
            content: [{ type: "tool_use", id: "d1", name: "submit_pr_description", input: desc }],
            stopReason: "tool_use",
          };
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  // A run pushes its branch, then HEAD moves to ANOTHER branch before the
  // post-step probes the workspace (a second run's `git checkout -b` in the
  // shared sandbox — or the agent itself checking out another branch after
  // its push). A post-step that read the checkout's branch would ask the
  // remote for THAT one and report "not found on the remote": the pushed work
  // orphaned without a PR. So the head branch is the branch the run's own
  // `git push` named, read off its bash result as the events stream by; the
  // checkout is only the fallback.
  it("HEAD moved to another branch after the push → the PR still opens from the PUSHED branch, the body rendered at that branch's tip", async () => {
    const OTHER = "0123456789abcdef0123456789abcdef01234567";
    const deps = codingDeps(
      bashThenDescribe(["git push -u origin feat/login-fix", "git checkout -b chore/other"], DESCRIPTION),
    );
    // The checkout ended on chore/other at a different commit; feat/login-fix was pushed at HEAD.
    codingExecutor({
      head: OTHER,
      branch: "chore/other",
      pushed: { branch: "feat/login-fix", head: HEAD },
      bindingRef: "main",
    });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix the login redirect", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].headBranch).toBe("feat/login-fix"); // the pushed branch, not the checkout
    expect(spy.calls[0].base).toBe("main");
    expect(spy.calls[0].body).toContain(`https://github.com/acme/api/blob/${HEAD}/src/login.ts#L10-L20`); // at the pushed tip, never the checkout's commit
    expect(spy.calls[0].body).not.toContain(OTHER);
    expect(replies.some((r) => /PR opened/.test(r) && r.includes("`feat/login-fix`"))).toBe(true);
  });

  // A description-only follow-up in a thread whose own run opened the pull
  // request (docs/reference/specs/resident-repos.md item 29): the workspace
  // sits on the base — the binding still the repo default because a dirty
  // tree kept the resident from moving it, and the tree recreated there — and
  // the run pushed nothing. The description is for the thread's own PR: it is
  // edited by number and rendered at ITS head, never refused as "the branch
  // is the base", never rendered at the base's tip the workspace shows.
  it("a description resubmitted from the base branch in a thread whose own run opened the PR → that PR is edited by number with the body at its head; no open call, no base-branch refusal", async () => {
    const PR_HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    const deps = codingDeps(describeThenAnswer(DESCRIPTION, "Resubmitted."));
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      ref: "docs/seed-header",
      refFromPr: true,
      pr: 41,
      prFromRecord: true,
      headSha: PR_HEAD,
      baseRef: "main",
    });
    codingExecutor({ head: HEAD, branch: "main", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const updated: Array<{ repo: string; number: number; title: string; body: string }> = [];
    deps.updatePullRequest = vi.fn(async (repo: string, number: number, patch: { title: string; body: string }) => {
      updated.push({ repo, number, ...patch });
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding add the tests' names to the PR description", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ repo: "acme/api", number: 41, title: "Fix the login redirect" });
    expect(updated[0].body).toContain(`https://github.com/acme/api/blob/${PR_HEAD}/src/login.ts#L10-L20`);
    expect(updated[0].body).not.toContain(HEAD);
    // The link is matched as a regex with a digit guard, never as a URL substring check.
    expect(
      replies.some((r) => /PR updated/.test(r) && /https:\/\/github\.com\/acme\/api\/pull\/41(?!\d)/.test(r)),
    ).toBe(true);
    expect(replies.some((r) => /base branch/.test(r))).toBe(false);
  });

  // The thread's own pull request was merged before the follow-up ran, and the
  // thread is bound to that pull request's head branch: the resolver binds no
  // `pr` (fail-closed, a review never posts to it) but hands the post-step the
  // record's PR as closed, so the description still edits its body by number
  // — never "the branch is the base branch", which the head branch is not.
  it("a description resubmitted in a thread whose own pull request is merged, the thread bound to its head branch → that PR is edited by number and the reply says it is merged; no open call, no base-branch refusal", async () => {
    const PR_HEAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    const deps = codingDeps(describeThenAnswer(DESCRIPTION, "Resubmitted."));
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      prUnpostable: { number: 41, reason: "closed" },
      closedRecordPr: { number: 41, headSha: PR_HEAD, merged: true },
    });
    codingExecutor({ head: PR_HEAD, branch: "docs/seed-header", bindingRef: "docs/seed-header" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const updated: Array<{ repo: string; number: number; title: string; body: string }> = [];
    deps.updatePullRequest = vi.fn(async (repo: string, number: number, patch: { title: string; body: string }) => {
      updated.push({ repo, number, ...patch });
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding add the tests' names to the PR description", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ repo: "acme/api", number: 41, title: "Fix the login redirect" });
    expect(updated[0].body).toContain(`https://github.com/acme/api/blob/${PR_HEAD}/src/login.ts#L10-L20`);
    // The link is matched by its path with a digit guard — never a host-bearing regex or substring.
    const updatedReply = replies.find((r) => r.includes("PR updated:"));
    expect(updatedReply).toBeDefined();
    expect(updatedReply).toMatch(/\/pull\/41(?!\d)/);
    expect(updatedReply).toContain("the pull request is merged");
    expect(replies.some((r) => /base branch/.test(r))).toBe(false);
  });

  it("the pushed branch is gone from the remote while the checkout moved on → the note names BOTH branches, no PR call", async () => {
    const deps = codingDeps(
      bashThenDescribe(["git push -u origin feat/login-fix", "git checkout -b chore/other"], DESCRIPTION),
    );
    // Neither branch is on the remote any more: the checkout never was, the pushed one was deleted after the push.
    codingExecutor({
      head: HEAD,
      branch: "chore/other",
      remoteHead: null,
      pushed: { branch: "feat/login-fix", head: HEAD, remoteHead: null },
      bindingRef: "main",
    });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("was not found on the remote"));
    expect(note).toBeDefined();
    expect(note).toContain("`feat/login-fix`"); // the branch the push named…
    expect(note).toContain("`chore/other`"); // …and the branch the workspace sat on
    expect(note).not.toContain("github.com");
  });

  // The block is read only from a `git push` call's
  // own result, paired by callId — a transcript printed by another command is
  // not a push, so the run falls back to the checkout exactly as if nothing
  // had been pushed.
  it("a push block printed by `cat push.log` (not a git push) is not a push → the checkout stays the head branch", async () => {
    const deps = codingDeps(bashThenDescribe(["cat push.log", "git checkout -b chore/other"], DESCRIPTION));
    codingExecutor({
      head: HEAD,
      branch: "chore/other",
      pushed: { branch: "feat/login-fix", head: HEAD },
      bindingRef: "main",
    });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].headBranch).toBe("chore/other"); // the checkout — the transcript named no push
  });

  it("no push observed in the run → the checkout is the head branch, exactly as before", async () => {
    const deps = codingDeps(bashThenDescribe(["git status --short"], DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].headBranch).toBe("feat/login-fix");
  });

  it("an existing open PR is edited (open-or-edit): created:false → the reply says updated, not opened", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy({ number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: false });
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding address the review findings", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    const note = replies.find((r) => r.includes("https://github.com/acme/api/pull/7"));
    expect(note).toBeDefined();
    expect(note).toContain("PR updated");
    expect(note).not.toContain("PR opened");
  });

  it("no resident binding → base falls back to the dispatch's resolved ref", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION)); // resolves ref: "main"
    codingExecutor({ head: HEAD, branch: "feat/x" }); // no bindingRef → cold path
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].base).toBe("main");
  });

  // The plan runner's coding child (docs/reference/specs/http-ingress.md item 9)
  // is dispatched AT the unit branch so the resident attaches there — the
  // binding ref IS the branch the child pushes. Without the plan's base on the
  // tag, the base resolved to that same branch and the post-step read the push
  // as "the branch is the base": no PR, no event, a unit ending at round 0
  // without a pull request. The tag carries the plan's base; the post-step
  // opens against it.
  it("a coordinator's child dispatched at the unit branch (the resident binding ref IS the branch) with a tag carrying the plan's base → the PR opens against that base from the unit branch, pr_opened in the record", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "plan/p/u1", bindingRef: "plan/p/u1" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const registry = new RunRegistry({ genId: () => "r-u1", genToken: () => "t-u1" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding in acme/api on branch plan/p/u1: do the unit", "slack:UADMIN"), io, {
      coordinator: { parentInstanceId: "plan-p", idempotencyKey: "plan-p:u1/0/coding", base: "main" },
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].headBranch).toBe("plan/p/u1");
    expect(spy.calls[0].base).toBe("main"); // the plan's base from the tag — not the binding ref, which is the branch itself
    const events = registry.snapshot("r-u1", "t-u1")?.events ?? [];
    expect(events.find((e) => e.type === "pr_opened")).toMatchObject({ number: 7, created: true });
    expect(events.some((e) => e.type === "run_note" && e.kind === "pr_not_opened")).toBe(false);
    expect(replies.some((r) => /PR opened/.test(r) && r.includes("`plan/p/u1` → `main`"))).toBe(true);
  });

  // resident-repos item 16: the release hands the resident the branch the run
  // pushed and the PR it heads — read off the run's own `pr_opened` event, so
  // the thread remembers the branch after its clean tree is released and a
  // follow-up can rebind onto it; a run that pushed nothing hands nothing.
  it("a coding run that opened a pull request releases its workspace with `pushed` naming the branch and the PR; a run that opened none releases without it", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    const { executor } = codingExecutor({ head: HEAD, branch: "fix/x", bindingRef: "main" });
    const releases: Array<{ mode: string; pushed?: unknown }> = [];
    Object.assign(executor, {
      release: async (mode: string, opts?: { pushed?: unknown }) => {
        releases.push({ mode, ...(opts?.pushed !== undefined ? { pushed: opts.pushed } : {}) });
        return { released: true };
      },
    });
    deps.openPullRequest = openSpy({ number: 41 }).fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(releases).toEqual([{ mode: "if-clean", pushed: [{ ref: "fix/x", pr: 41 }] }]);

    const none = codingDeps(describeThenAnswer(undefined));
    const bare = codingExecutor({ head: HEAD, bindingRef: "main" }); // no branch, no push
    const bareReleases: Array<{ mode: string; pushed?: unknown }> = [];
    Object.assign(bare.executor, {
      release: async (mode: string, opts?: { pushed?: unknown }) => {
        bareReleases.push({ mode, ...(opts?.pushed !== undefined ? { pushed: opts.pushed } : {}) });
        return { released: true };
      },
    });
    await dispatch(none, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    expect(bareReleases).toEqual([{ mode: "if-clean" }]);
  });

  it("the same child without a coordinator tag: the binding ref is the branch, so the branch is the base — no PR call, and instead of silence the record carries a `pr_not_opened` note and the reply says the branch is the base", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "plan/p/u1", bindingRef: "plan/p/u1" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const registry = new RunRegistry({ genId: () => "r-u1", genToken: () => "t-u1" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding in acme/api on branch plan/p/u1: do the unit", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const events = registry.snapshot("r-u1", "t-u1")?.events ?? [];
    expect(events.find((e) => e.type === "pr_opened")).toBeUndefined();
    expect(events.find((e) => e.type === "run_note" && e.kind === "pr_not_opened")).toMatchObject({
      type: "run_note",
      kind: "pr_not_opened",
      summary: expect.stringContaining("plan/p/u1"),
    });
    const note = replies.find((r) => r.includes("no PR was opened"));
    expect(note).toBeDefined();
    expect(note).toContain("`plan/p/u1`");
    expect(note).toContain("is the base branch");
    expect(note).not.toContain("/compare/");
  });

  // A bare issue-link coding run resolves no
  // ref and no PR, and the resident attach fails for a reason OTHER than
  // needs-ref (an infra fault, not-onboarded, a probe outage) — so the
  // fresh-sandbox fallback carries no binding either. All three of the
  // post-step's base fields are undefined even though the run genuinely
  // pushed. The fix: the repo's own default branch, fetched from GitHub
  // (fetchRepoShipInfo, shared with agent:ship's identical last resort), is
  // consulted before giving up.
  it("no ref/PR/binding resolves a base, but GitHub's default branch does → the PR opens against it", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({ repo: "acme/api" }); // no ref resolved
    deps.fetchRepoShipInfo = vi.fn(async () => ({ defaultBranch: "main" }));
    codingExecutor({ head: HEAD, branch: "feat/x" }); // no bindingRef → no binding ref either
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].base).toBe("main");
    expect(replies.some((r) => /PR opened/.test(r))).toBe(true);
  });

  // Characterization: the no-base branch of the post-step
  // survives even the GitHub last resort — the repo lookup itself found no
  // default branch (or failed). Honest note naming the missing base, the
  // compare URL (the push WAS proven), and no PR call.
  it("description submitted + pushed branch but NO base resolvable, even from GitHub → no PR call; the note says no base branch is known, with the compare URL", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({ repo: "acme/api" }); // no ref resolved
    deps.fetchRepoShipInfo = vi.fn(async () => undefined); // the last resort also comes up empty
    codingExecutor({ head: HEAD, branch: "feat/x" }); // no bindingRef → no binding ref either
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("no base branch"));
    expect(note).toBeDefined();
    expect(note).toContain("no PR was opened");
    expect(note).toContain("https://github.com/acme/api/compare/feat/x");
  });

  it("no description submitted but a pushed branch is observable → no PR call; the reply states it plainly with the compare URL", async () => {
    const deps = codingDeps(describeThenAnswer(undefined, "I implemented the fix on feat/login-fix."));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    // The compare URL is offered only after GitHub said no open PR heads the branch.
    expect(deps.findOpenPrByHead).toHaveBeenCalledWith("acme/api", "feat/login-fix");
    const note = replies.find((r) => r.includes("https://github.com/acme/api/compare/feat/login-fix"));
    expect(note).toBeDefined();
    expect(note).toContain("no PR description");
    expect(note).toContain("No PR was opened");
  });

  // The shape of a follow-up on an existing PR (a dependabot branch, a PR the
  // thread was bound to): the run repushes the PR's OWN head branch and — by
  // its own judgement — submits no description, so the PR body is left alone.
  // The push updated that PR; the reader must be told that, not sent to open
  // a duplicate from a compare URL.
  it("no description submitted, the pushed branch already heads an open PR → the reply names that PR as updated by the push, no compare URL, no PR call, pr_opened created:false in the record", async () => {
    const deps = codingDeps(describeThenAnswer(undefined, "Refreshed the allowlist for the bumped action."));
    codingExecutor({ head: HEAD, branch: "dependabot/github_actions/actions-4c45254bbe", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/acme/api/pull/700" }));
    const registry = new RunRegistry({ genId: () => "r700", genToken: () => "t700" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding consistency check failing on acme/api#700", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0); // nothing to render — the body is not touched
    expect(deps.findOpenPrByHead).toHaveBeenCalledWith("acme/api", "dependabot/github_actions/actions-4c45254bbe");
    const note = replies.find((r) => r.includes("https://github.com/acme/api/pull/700"));
    expect(note).toBeDefined();
    expect(note).toContain("PR updated by the push");
    expect(note).toContain(HEAD.slice(0, 7));
    expect(note).toContain("description was not resubmitted"); // the missing resubmit is flagged, not accepted
    expect(note).not.toContain("No PR was opened");
    expect(note).not.toContain("/compare/");
    // In the snapshot ⇒ published before finish() (a publish on a finished run is a silent no-op).
    const opened = registry.snapshot("r700", "t700")?.events.find((e) => e.type === "pr_opened");
    expect(opened).toMatchObject({
      type: "pr_opened",
      number: 700,
      created: false,
      url: "https://github.com/acme/api/pull/700",
    });
  });

  it("no description submitted and the open-PR lookup fails → the honest compare-URL note stands (never a throw, never a fabricated PR)", async () => {
    const deps = codingDeps(describeThenAnswer(undefined, "Pushed."));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    deps.findOpenPrByHead = vi.fn(async () => {
      throw new Error("PR lookup failed: HTTP 502");
    });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("https://github.com/acme/api/compare/feat/login-fix"));
    expect(note).toBeDefined();
    expect(note).toContain("No PR was opened");
    expect(note).not.toContain("/pull/");
    expect(statuses[statuses.length - 1].title).toContain("✅"); // the run itself completed
  });

  /** A coding provider whose FIRST loop answers without a description, then —
   *  on the description turn — submits one and answers in a line. The shape of
   *  a run that skipped the description and is asked for it. */
  function answerThenDescribeOnTurn(desc: Record<string, unknown>, answer = "Refreshed the allowlist."): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        n++;
        if (n === 1) return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
        if (n === 2)
          return {
            content: [{ type: "tool_use", id: "d2", name: "submit_pr_description", input: desc }],
            stopReason: "tool_use",
          };
        return { content: [{ type: "text", text: "Description resubmitted." }], stopReason: "end_turn" };
      },
    };
  }

  // The description turn (pr-description.md item 5, descriptionTurn.ts): the
  // dependabot shape — a push onto a bot's PR branch, no description — is no
  // longer reported and left; the run is given one more turn, the turn submits,
  // and the post-step opens-or-edits exactly as for a run that had submitted.
  it("a description-less push onto a branch that heads an open PR → ONE description turn; its submitted description edits the PR (updated wording), and pr_description + pr_opened + the description_turn note land in the record", async () => {
    const deps = codingDeps(answerThenDescribeOnTurn(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "dependabot/github_actions/actions-4c45254bbe", bindingRef: "main" });
    const spy = openSpy({ number: 700, htmlUrl: "https://github.com/acme/api/pull/700", created: false });
    deps.openPullRequest = spy.fn;
    deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/acme/api/pull/700" }));
    const registry = new RunRegistry({ genId: () => "r701", genToken: () => "t701" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding consistency check failing on acme/api#700", "slack:UADMIN"), io);
    // The turn's description reached the post-step: open-or-edit ran from typed values at the observed head.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({
      repo: "acme/api",
      headBranch: "dependabot/github_actions/actions-4c45254bbe",
      title: DESCRIPTION.title,
    });
    expect(spy.calls[0].body).toContain(`blob/${HEAD}/`);
    const note = replies.find((r) => r.includes("https://github.com/acme/api/pull/700"));
    expect(note).toContain("PR updated:");
    expect(note).toContain("body re-rendered");
    expect(note).not.toContain("not resubmitted");
    expect(replies.some((r) => r.includes("Refreshed the allowlist."))).toBe(true); // the run's own answer still lands
    const events = registry.snapshot("r701", "t701")?.events ?? [];
    const turnNote = events.find((e) => e.type === "run_note" && e.kind === "description_turn");
    expect(turnNote).toBeDefined();
    if (turnNote?.type === "run_note") expect(turnNote.summary).toContain("acme/api#700");
    expect(events.some((e) => e.type === "pr_description")).toBe(true);
    expect(events.find((e) => e.type === "pr_opened")).toMatchObject({ number: 700, created: false });
    // the turn's own tool call is in the record like any other
    expect(events.some((e) => e.type === "tool_call" && e.tool === "submit_pr_description")).toBe(true);
  });

  it("the description turn still submits nothing → the ⚠️ note says the turn was given; the note is published once", async () => {
    // Every completion is a bare answer: the first loop skips the description, and so does the turn.
    const deps = codingDeps(describeThenAnswer(undefined, "Pushed the fix."));
    codingExecutor({ head: HEAD, branch: "dependabot/github_actions/actions-4c45254bbe", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/acme/api/pull/700" }));
    const registry = new RunRegistry({ genId: () => "r702", genToken: () => "t702" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("https://github.com/acme/api/pull/700"));
    expect(note).toContain("⚠️ PR updated by the push");
    expect(note).toContain("even in the dedicated description turn this run was given");
    const events = registry.snapshot("r702", "t702")?.events ?? [];
    expect(events.filter((e) => e.type === "run_note" && e.kind === "description_turn")).toHaveLength(1);
    expect(events.some((e) => e.type === "pr_description")).toBe(false);
    expect(events.find((e) => e.type === "pr_opened")).toMatchObject({ number: 700, created: false });
  });

  it("no description turn when a description was submitted, when the push is unproven, or when no open PR heads the branch", async () => {
    // (a) submitted: the first loop described → open-or-edit runs, no turn asked
    let deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    let registry = new RunRegistry({ genId: () => "ra", genToken: () => "ta" });
    deps.runRegistry = registry;
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    expect(deps.findOpenPrByHead).not.toHaveBeenCalled(); // open-or-edit does its own lookup inside openPullRequest
    expect(
      registry.snapshot("ra", "ta")?.events.some((e) => e.type === "run_note" && e.kind === "description_turn"),
    ).toBe(false);
    // (b) unproven: the remote has no such branch → nothing to ask about
    deps = codingDeps(describeThenAnswer(undefined, "Pushed."));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", remoteHead: null, bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    registry = new RunRegistry({ genId: () => "rb", genToken: () => "tb" });
    deps.runRegistry = registry;
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    expect(deps.findOpenPrByHead).not.toHaveBeenCalled();
    expect(
      registry.snapshot("rb", "tb")?.events.some((e) => e.type === "run_note" && e.kind === "description_turn"),
    ).toBe(false);
    // (c) proven push, no open PR: the compare-URL note, no turn
    deps = codingDeps(describeThenAnswer(undefined, "Pushed."));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    registry = new RunRegistry({ genId: () => "rc", genToken: () => "tc" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(replies.some((r) => r.includes("No PR was opened") && r.includes("/compare/feat/login-fix"))).toBe(true);
    expect(
      registry.snapshot("rc", "tc")?.events.some((e) => e.type === "run_note" && e.kind === "description_turn"),
    ).toBe(false);
  });

  it("openPullRequest throws → the reply reports the failure with the compare URL; the run still completes normally", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", bindingRef: "main" });
    const spy = openSpy(new Error("PR create failed: HTTP 422 Validation Failed"));
    deps.openPullRequest = spy.fn;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    const note = replies.find((r) => r.includes("HTTP 422"));
    expect(note).toBeDefined();
    expect(note).toContain("https://github.com/acme/api/compare/feat/login-fix");
    expect(note).not.toContain("/pull/"); // never a fabricated PR URL
    expect(replies.some((r) => r.includes("Done — branch pushed."))).toBe(true); // the answer still lands
    expect(statuses[statuses.length - 1].title).toContain("✅"); // the run itself completed
  });

  it("description submitted but the pushed head is unobservable → honest failure note, no PR call, and no compare URL (an unproven push implies no remote branch)", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ branch: "feat/x", bindingRef: "main" }); // rev-parse HEAD fails
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("could not be observed"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com"); // the compare URL is offered only when the remote's head matched HEAD
  });

  it("description submitted but no branch is observable (failed probe / detached) → honest failure note without a fabricated URL, no PR call", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, bindingRef: "main" }); // abbrev-ref fails → no branch
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("could not be observed"));
    expect(note).toBeDefined();
    expect(note).toContain("branch");
    expect(note).not.toContain("github.com"); // no branch → no compare URL to fabricate
  });

  it("the workspace sat on the base branch (nothing pushed) → no PR call and no compare-URL note", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION, "Which login flow did you mean?"));
    codingExecutor({ head: HEAD, branch: "main", bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    expect(replies.some((r) => r.includes("/compare/"))).toBe(false);
  });

  it("a readonly review run with a verdict never triggers the PR post-step", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "v1",
                name: "submit_verdict",
                input: { verdict: "approve", summary: "ok", head: HEAD },
              },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "review done" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: HEAD, baseRef: "main" });
    codingExecutor({ head: HEAD, branch: "patch-1" });
    deps.postReviewComment = vi.fn(async () => {});
    deps.fetchPrHead = async () => HEAD;
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(deps.postReviewComment).toHaveBeenCalledTimes(1); // the review path ran to its own post…
    expect(spy.calls).toHaveLength(0); // …and the PR post-step never fired
  });

  it("the head and branch are observed BEFORE the workspace is released", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    const { order } = codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const release = order.indexOf("release");
    const head = order.findIndex((o) => /rev-parse HEAD/.test(o));
    const branch = order.findIndex((o) => /abbrev-ref/.test(o));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(branch).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(head);
    expect(release).toBeGreaterThan(branch);
  });

  it("the accepted description is published on the run stream as a typed pr_description event, redacted", async () => {
    const leaky = { ...DESCRIPTION, risks: `uses ghp_${"a".repeat(24)} for auth — rotated after` };
    const deps = codingDeps(describeThenAnswer(leaky));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const registry = new RunRegistry({ genId: () => "r9", genToken: () => "t9" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const snap = registry.snapshot("r9", "t9");
    const ev = snap?.events.find((e) => e.type === "pr_description");
    if (ev?.type !== "pr_description") throw new Error("pr_description event missing");
    expect(ev.description.title).toBe("Fix the login redirect");
    expect(ev.description.tour[0].anchor).toEqual({ path: "src/login.ts", from: 10, to: 20 });
    expect(ev.description.risks).toContain("«redacted-github-token»");
    expect(ev.description.risks).not.toContain("ghp_");
  });

  it("redaction walks every string leaf: a secret-shaped token in a tour anchor PATH is redacted on the published event too", async () => {
    const leaky = {
      ...DESCRIPTION,
      tour: [{ title: "The fix", description: "d.", anchor: { path: `src/ghp_${"a".repeat(24)}.ts`, from: 1, to: 2 } }],
    };
    const deps = codingDeps(describeThenAnswer(leaky));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const registry = new RunRegistry({ genId: () => "r10", genToken: () => "t10" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const snap = registry.snapshot("r10", "t10");
    const ev = snap?.events.find((e) => e.type === "pr_description");
    if (ev?.type !== "pr_description") throw new Error("pr_description event missing");
    expect(ev.description.tour[0].anchor.path).toContain("«redacted-github-token»");
    expect(ev.description.tour[0].anchor.path).not.toContain("ghp_");
    expect(ev.description.tour[0].anchor.from).toBe(1); // numbers ride unchanged
  });

  // docs/reference/specs/agent-coding.md item 9, run-history.md item 2 — a plain
  // coding run's submitted handoff (the by-hand receipt: a `## Contract` block
  // pasted into the request, no plan runner) is recorded on the run's record,
  // redacted, and posted nowhere; a run that submitted none carries no key.
  it("a submitted handoff rides the run record, redacted; a coding run that submitted none carries no handoff key", async () => {
    const token = `ghp_${"a".repeat(24)}`;
    const handoff = {
      deviations: [{ from: "an empty handoff records nothing", to: "it is recorded as empty", why: `see ${token}` }],
      followUps: [],
      unproven: [{ criterion: "the board comment lands live", why: "no runner posts it yet" }],
    };
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        n++;
        if (n === 1)
          return {
            content: [{ type: "tool_use", id: "h1", name: "submit_handoff", input: handoff }],
            stopReason: "tool_use",
          };
        if (n === 2)
          return {
            content: [{ type: "tool_use", id: "d1", name: "submit_pr_description", input: DESCRIPTION }],
            stopReason: "tool_use",
          };
        return { content: [{ type: "text", text: "Done — branch pushed." }], stopReason: "end_turn" };
      },
    };
    const deps = codingDeps(provider);
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    const registry = new RunRegistry({ genId: () => "r11", genToken: () => "t11" });
    deps.runRegistry = registry;
    const store = new InMemoryRunStore();
    deps.runHistoryWriter = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    await deps.runHistoryWriter.settled();
    const rec = (await store.get("r11"))!;
    expect(rec.handoff).toEqual({
      deviations: [
        { from: "an empty handoff records nothing", to: "it is recorded as empty", why: "see «redacted-github-token»" },
      ],
      followUps: [],
      unproven: [{ criterion: "the board comment lands live", why: "no runner posts it yet" }],
    });
    expect(JSON.stringify(rec)).not.toContain("ghp_");
    // the tool's ack reached the model as a recorded handoff
    const ack = rec.events.find((e) => e.type === "tool_result" && /handoff recorded/.test(e.summary ?? ""));
    expect(ack).toBeDefined();

    const plain = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    plain.openPullRequest = openSpy().fn;
    plain.runRegistry = new RunRegistry({ genId: () => "r12", genToken: () => "t12" });
    const store2 = new InMemoryRunStore();
    plain.runHistoryWriter = createRunHistoryWriter({ store: store2, warn: () => {}, sleep: async () => {} });
    await dispatch(plain, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    await plain.runHistoryWriter.settled();
    expect("handoff" in (await store2.get("r12"))!).toBe(false);
  });

  // docs/reference/specs/run-history.md item 2, agent-ship.md item 6 — every
  // coding run records what it submits through `submit_dispositions` on its
  // record, whatever ids it names: the plan runner matches the set to the
  // round's findings when it reads the record. A run that submitted none
  // carries no key.
  it("a coding run records the dispositions it submits, the ids the review issued or not, and the last set wins; a coding run that submitted none carries no dispositions key", async () => {
    const dispositionsProvider = (set: unknown[]): Provider => {
      let n = 0;
      return {
        name: "fake",
        async complete(): Promise<CompletionResult> {
          n++;
          if (n === 1)
            return {
              content: [
                {
                  type: "tool_use",
                  id: "x1",
                  name: "submit_dispositions",
                  input: { dispositions: [{ findingId: "F9", disposition: "fixed", note: "?" }] },
                },
              ],
              stopReason: "tool_use",
            };
          if (n === 2)
            return {
              content: [{ type: "tool_use", id: "x2", name: "submit_dispositions", input: { dispositions: set } }],
              stopReason: "tool_use",
            };
          if (n === 3)
            return {
              content: [{ type: "tool_use", id: "d1", name: "submit_pr_description", input: DESCRIPTION }],
              stopReason: "tool_use",
            };
          return { content: [{ type: "text", text: "Done — branch pushed." }], stopReason: "end_turn" };
        },
      };
    };
    const set = [{ findingId: "F1", disposition: "declined", note: "the loop is exclusive" }];
    const deps = codingDeps(dispositionsProvider(set));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    deps.runRegistry = new RunRegistry({ genId: () => "r-findings", genToken: () => "t-findings" });
    const store = new InMemoryRunStore();
    deps.runHistoryWriter = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
    // No option names the review's ids: the run is a plain `agent:coding` dispatch, as the findings step's is.
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    await deps.runHistoryWriter.settled();
    const rec = (await store.get("r-findings"))!;
    expect(rec.dispositions).toEqual(set);
    const dispositionAcks = (events: RunEvent[]) =>
      events.flatMap((e) => (e.type === "tool_result" && e.tool === "submit_dispositions" ? [e.summary] : []));
    const acks = dispositionAcks(rec.events);
    expect(acks).toHaveLength(2);
    expect(acks[0]).toMatch(/dispositions recorded: 1/); // F9, an id no review issued, is recorded as submitted
    expect(acks[1]).toMatch(/dispositions recorded: 1/);
    expect(acks.some((a) => /not recorded|unknown finding id/.test(a ?? ""))).toBe(false);

    const plain = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    plain.openPullRequest = openSpy().fn;
    plain.runRegistry = new RunRegistry({ genId: () => "r-plain", genToken: () => "t-plain" });
    const store2 = new InMemoryRunStore();
    plain.runHistoryWriter = createRunHistoryWriter({ store: store2, warn: () => {}, sleep: async () => {} });
    await dispatch(plain, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    await plain.runHistoryWriter.settled();
    const rec2 = (await store2.get("r-plain"))!;
    expect("dispositions" in rec2).toBe(false);
    expect(dispositionAcks(rec2.events)).toEqual([]);
  });

  // docs/reference/specs/agent-ship.md item 13 — a coordinator's coding child is
  // dispatched with the unit's contract (`DispatchOptions.contract`): the
  // rendered block is the first user turn's last text part, the request's
  // text first, exactly as the ship pipeline's coding round places it.
  it("a coding run dispatched with a contract carries the rendered block as its first user turn's last text part; without one the turn is the request alone", async () => {
    const contract = contractFromPlan({
      planMarkdown: "### U1. do the unit\n\ndo the unit\n",
      unitId: "U1",
      readSpec: () => undefined,
      rebase: { branch: "plan/p/u10", onto: "main" },
    });
    const block = renderContract(contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text;
    /** The description-then-answer provider with its requests recorded (a snapshot of each message list). */
    const recording = () => {
      const inner = describeThenAnswer(DESCRIPTION);
      const requests: CompletionRequest[] = [];
      const provider: Provider & { requests: CompletionRequest[] } = {
        name: "fake",
        requests,
        async complete(req) {
          requests.push({ ...req, messages: [...req.messages] });
          return inner.complete(req);
        },
      };
      return provider;
    };
    const firstUserTexts = (requests: CompletionRequest[]) => {
      const first = requests[0]!.messages.find((m) => m.role === "user")!;
      return first.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
    };
    const provider = recording();
    const deps = codingDeps(provider);
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy().fn;
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io, { contract });
    // The request turn reaches pi as one prompt: its text parts joined with a blank line (harness-pi item 9).
    const texts = firstUserTexts(provider.requests);
    expect(texts).toEqual([`fix it\n\n${block}`]);
    expect(block).toContain("## Contract");
    expect(block).toContain("Rebase `plan/p/u10` onto `main`");

    const plainProvider = recording();
    const plain = codingDeps(plainProvider);
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    plain.openPullRequest = openSpy().fn;
    await dispatch(plain, msg("agent:coding fix it", "slack:UADMIN"), fakeIO().io);
    expect(firstUserTexts(plainProvider.requests)).toEqual(["fix it"]);
  });

  it("a thread bound to an existing PR's head branch: the base is the PR's TRUE base ref, so a fix-round repush opens/edits instead of reading as 'nothing pushed'", async () => {
    const deps = makeDeps(YAML_FIXTURE, describeThenAnswer(DESCRIPTION));
    // The thread inherited PR acme/api#42 (head feat/x, true base main); the
    // resident binding follows the PR's HEAD branch — base === branch without
    // the PR's own baseRef.
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "feat/x", pr: 42, headSha: HEAD, baseRef: "main" });
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "feat/x" });
    const spy = openSpy({ number: 42, htmlUrl: "https://github.com/acme/api/pull/42", created: false });
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding address the review findings", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].base).toBe("main"); // the PR's true base — never the bound head branch
    expect(spy.calls[0].headBranch).toBe("feat/x");
    expect(replies.some((r) => /PR updated/.test(r))).toBe(true);
  });

  it("the remote has no such branch → the branch does not count as pushed: no PR call, an honest note, no compare URL", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", remoteHead: null, bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("was not found on the remote"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com"); // no proof the branch exists on the remote
  });

  it("the remote branch behind the workspace HEAD → not pushed: no PR call, the note says the branch has unpushed commits", async () => {
    const STALE = "0123456789abcdef0123456789abcdef01234567";
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", remoteHead: STALE, bindingRef: "main" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("unpushed commits"));
    expect(note).toBeDefined();
    expect(note).not.toContain("/pull/"); // never a fabricated PR URL
  });

  it("cold path: the clone lives in a subdirectory of the workspace root — the probes discover it and the PR still opens", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/login-fix", cloneDir: "api" }); // no bindingRef → cold executor; root probes fail
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].headBranch).toBe("feat/login-fix");
    expect(spy.calls[0].body).toContain(`/blob/${HEAD}/`); // rendered at the head observed IN the clone
    expect(replies.some((r) => r.includes("https://github.com/acme/api/pull/7") && /PR opened/.test(r))).toBe(true);
  });

  it("no git repository anywhere in the workspace → honest note, no PR call", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({}); // root is not a repo and `ls -d */.git` finds nothing
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("could not be observed"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com");
  });

  it("dispatch resolved no repo slug (agent-discovered repo): the PR-open repo comes from the workspace's origin remote", async () => {
    const deps = makeDeps(YAML_FIXTURE, describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({ ref: "main" }); // a ref but no repo — the run discovered the repo itself
    codingExecutor({ head: HEAD, branch: "feat/x", cloneDir: "api", remote: "git@github.com:Acme/API.git" });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].repo).toBe("acme/api"); // parsed from the ssh remote, lowercased
    expect(spy.calls[0].base).toBe("main");
    expect(replies.some((r) => /PR opened/.test(r))).toBe(true);
  });

  it("no repo anywhere — dispatch resolved none and the origin remote is unparseable → honest note, no PR call, no fabricated URL", async () => {
    const deps = makeDeps(YAML_FIXTURE, describeThenAnswer(DESCRIPTION));
    deps.resolveRepoContext = () => ({});
    codingExecutor({
      head: HEAD,
      branch: "feat/x",
      cloneDir: "api",
      remote: "https://gitlab.example.com/acme/api.git",
    });
    const spy = openSpy();
    deps.openPullRequest = spy.fn;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    expect(spy.calls).toHaveLength(0);
    const note = replies.find((r) => r.includes("no repository"));
    expect(note).toBeDefined();
    expect(note).not.toContain("github.com");
  });

  it("the PR outcome is a fact of the run: a typed pr_opened event (url/number/created) is published BEFORE the stream finishes", async () => {
    const deps = codingDeps(describeThenAnswer(DESCRIPTION));
    codingExecutor({ head: HEAD, branch: "feat/x", bindingRef: "main" });
    deps.openPullRequest = openSpy({ number: 7, htmlUrl: "https://github.com/acme/api/pull/7", created: true }).fn;
    const registry = new RunRegistry({ genId: () => "r7", genToken: () => "t7" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    // A publish on a finished run is a silent no-op, so presence in the
    // snapshot IS the proof the open ran before finish().
    const snap = registry.snapshot("r7", "t7");
    const ev = snap?.events.find((e) => e.type === "pr_opened");
    if (ev?.type !== "pr_opened") throw new Error("pr_opened event missing");
    expect(ev.url).toBe("https://github.com/acme/api/pull/7");
    expect(ev.number).toBe(7);
    expect(ev.created).toBe(true);
  });
});

// Feature: docs/reference/specs/live-view.md — the dispatcher registers every run in the
// RunRegistry, publishes each RunEvent to it (feeding the external /runs
// stream), finishes it in the run-loop finally, and puts the per-run capability
// link on the status card ONLY when PUBLIC_BASE_URL is set (graceful otherwise).
/** A stream's shape with its span records named: `+name` opens, `-name` closes (docs/reference/specs/tracing.md). */
const shapeOf = (events: readonly RunEvent[]) =>
  events.map((e) => (e.type === "span_start" ? `+${e.name}` : e.type === "span_end" ? `-${e.name}` : e.type));
/** The shape without the setup steps (`dispatch.*`), whose number and order depend on the fixture's fakes. */
const runShapeOf = (events: readonly RunEvent[]) => shapeOf(events).filter((x) => !/^[+-]dispatch\./.test(x));
/** The content events: what a reader of the run's story sees (span records are timing). */
const contentOf = (events: readonly RunEvent[]) => events.filter((e) => !isSpanRecord(e));
const answerOf = (events: readonly RunEvent[]) => events.find((e) => e.type === "answer");

describe("live run-view wiring (Area 2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  /** A provider that requests one tool then answers — so the runner emits
   *  run events (tool_call + tool_result) the dispatcher forwards. The default
   *  general agent is toolless, so the tool is "unknown" and the result is
   *  ok:false; two events are emitted either way, which is all we assert. */
  function toolThenAnswer(): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
  }

  it("registers the run, publishes its events, and finishes it", async () => {
    const events: RunEvent[] = [];
    const log: string[] = [];
    const spy = {
      mintId: () => "run-x",
      create() {
        log.push("create");
        return { id: "run-x", token: "tok-x", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
      },
      finish() {
        log.push("finish");
      },
      has: () => true,
      snapshot: () => null, // the finish reads the backlog for the card's shape (docs/reference/specs/tracing.md)
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;

    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = spy;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);

    expect(log).toEqual(["create", "finish"]); // created before the run, finished after
    // The general agent's `bash` call is an unknown tool (its toolset has no
    // shell), so the pair is a failed tool result and the next turn answers.
    // The record is bookended by the request (`input`, live-view item 12) and
    // the final answer (the run record is the source of truth; Slack is a
    // projection of it), the latter before the run finishes.
    // Spans, not `turn` events, carry the timing (docs/reference/specs/tracing.md): the
    // run's root opens the stream, the setup steps (`dispatch.*`, filtered
    // here) precede the request, the loop is `run.agent`, each model call a
    // `model.turn`, the tool call a `tool.bash` around its pair; after the
    // answer the card close and the reply are spans too. This spy never seals,
    // so the root's close reaches it as well; a real registry drops it.
    expect(runShapeOf(events)).toEqual([
      "+request",
      "input",
      "run_meta",
      "+run.agent",
      "+model.turn",
      "-model.turn",
      "+tool.bash",
      "tool_call",
      "run_note", // the gate's refusal: general holds no shell (harness-pi item 12)
      "tool_result",
      "-tool.bash",
      "+model.turn",
      "-model.turn",
      "-run.agent",
      "answer",
      "+post.card_close",
      "-post.card_close",
      "+post.reply",
      "-post.reply",
      "-request",
    ]);
    // The stream opens with the root and the setup steps that ran before the
    // reservation; the request follows (published at the reservation, before
    // the attach); the rest of the setup — the attach above all — streams live
    // between the request and the loop. Every event before the loop is head
    // material, so the protected head runs unbroken from the root through the
    // request (run-history item 42).
    const inputAt = events.findIndex((e) => e.type === "input");
    const loopAt = events.findIndex((e) => e.type === "span_start" && e.name === "run.agent");
    const before = shapeOf(events.slice(0, inputAt));
    expect(before[0]).toBe("+request");
    expect(before.slice(1).every((x) => /^[+-]dispatch\./.test(x))).toBe(true);
    const setupEnded = shapeOf(events.slice(0, loopAt)).filter((x) => x.startsWith("-dispatch."));
    expect(new Set(setupEnded.map((x) => x.slice(1)))).toEqual(
      new Set([
        "dispatch.history",
        "dispatch.repo_context",
        "dispatch.memory_read",
        "dispatch.ack_card",
        "dispatch.workspace.attach",
        "dispatch.mcp_discovery",
        "dispatch.compose",
        "dispatch.channel_visibility",
      ]),
    );
    const attachEndAt = events.findIndex((e) => e.type === "span_end" && e.name === "dispatch.workspace.attach");
    expect(attachEndAt).toBeGreaterThan(inputAt); // the attach streams live, after the request…
    expect(attachEndAt).toBeLessThan(loopAt); // …and before the loop
    expect(events.slice(0, loopAt).every(isHeadMaterial)).toBe(true);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  // Feature: docs/reference/specs/run-visibility.md item 5 — the final answer is a run
  // event: published to the registry (SoT) BEFORE the channel reply, with the
  // same redaction as every other event, so the run page shows what the thread
  // got — including a soft stop's "findings so far".
  it("publishes the final answer as a redacted `answer` event before finishing the run and before replying", async () => {
    const order: string[] = [];
    const events: RunEvent[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        return {
          content: [{ type: "text", text: "done — token was ghp_abcdefghijklmnopqrstuvwxyz0123" }],
          stopReason: "end_turn",
        };
      },
    };
    const spy = {
      mintId: () => "run-a",
      create() {
        return { id: "run-a", token: "tok-a", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
        order.push(`publish:${e.type}`);
      },
      finish() {
        order.push("finish");
      },
      has: () => true,
      snapshot: () => null, // the finish reads the backlog for the card's shape (docs/reference/specs/tracing.md)
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = spy;
    const replies: string[] = [];
    const io: ChannelIO = {
      reply: async (t) => {
        replies.push(t);
        order.push("reply");
      },
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    await dispatch(deps, msg("hello there"), io);
    const answer = events.find((e) => e.type === "answer");
    expect(answer).toBeDefined();
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).toContain("done — token was «redacted-github-token»"); // redacted like every event
    // Intentional: the channel reply is NOT a run event, so it carries the model's
    // text verbatim — only the run-visibility stream (card, /runs, friction) is
    // redacted. Do not "fix" this assertion to expect redaction.
    expect(replies[0]).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(order.indexOf("publish:answer")).toBeLessThan(order.indexOf("finish"));
    expect(order.indexOf("publish:answer")).toBeLessThan(order.indexOf("reply"));
  });

  // Feature: docs/reference/specs/live-view.md item 12 — the request is the first event of
  // the run record (`input`), published straight after create() so the run page
  // can show it above the log; redacted like everything in the stream.
  it("publishes the request as a redacted `input` event before any tool event, with an attachment suffix", async () => {
    const events: RunEvent[] = [];
    const spy = {
      mintId: () => "run-i",
      create() {
        return { id: "run-i", token: "tok-i", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
      },
      finish() {},
      has: () => true,
      snapshot: () => null, // the finish reads the backlog for the card's shape (docs/reference/specs/tracing.md)
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = spy;
    const png = { name: "a.png", mediaType: "image/png" as const, data: "AAAA" };
    await dispatch(
      deps,
      {
        ...msg("agent:general please rotate ghp_abcdefghijklmnopqrstuvwxyz0123 now"),
        channelName: "general",
        userName: "alice",
        sourceUrl: "https://acme.slack.com/archives/CX/p10",
        images: [png, png],
        documents: [{ name: "spec.pdf", mediaType: "application/pdf" as const, data: "AAAA" }],
      },
      fakeIO().io,
    );
    // Spans, not `turn` events, carry the timing (docs/reference/specs/tracing.md): the
    // run's root opens the stream, the setup steps (`dispatch.*`, filtered
    // here) precede the request, the loop is `run.agent`, each model call a
    // `model.turn`, the tool call a `tool.bash` around its pair; after the
    // answer the card close and the reply are spans too. This spy never seals,
    // so the root's close reaches it as well; a real registry drops it.
    expect(runShapeOf(events)).toEqual([
      "+request",
      "input",
      "run_meta",
      "+run.agent",
      "+model.turn",
      "-model.turn",
      "+tool.bash",
      "tool_call",
      "run_note", // the gate's refusal: general holds no shell (harness-pi item 12)
      "tool_result",
      "-tool.bash",
      "+model.turn",
      "-model.turn",
      "-run.agent",
      "answer",
      "+post.card_close",
      "-post.card_close",
      "+post.reply",
      "-post.reply",
      "-request",
    ]);
    // The setup spans that ran before the reservation precede the request; the
    // attach and the rest stream live after it, before the loop; all of it is
    // head material (the same partition the wiring test above pins).
    const inputAt = events.findIndex((e) => e.type === "input");
    const loopAt = events.findIndex((e) => e.type === "span_start" && e.name === "run.agent");
    const before = shapeOf(events.slice(0, inputAt));
    expect(before[0]).toBe("+request");
    expect(before.slice(1).every((x) => /^[+-]dispatch\./.test(x))).toBe(true);
    expect(events.findIndex((e) => e.type === "span_end" && e.name === "dispatch.workspace.attach")).toBeGreaterThan(
      inputAt,
    );
    expect(events.slice(0, loopAt).every(isHeadMaterial)).toBe(true);
    const input = events.find((e) => e.type === "input")!;
    if (input.type !== "input") throw new Error("unreachable");
    expect(input.text).toBe("please rotate «redacted-github-token» now [+2 images, 1 document]"); // directives stripped, redacted
    expect(input.at).toEqual(expect.any(Number));
    // where it came from, for the Request block's `#channel · user · open thread` line
    expect(input.source).toEqual({
      url: "https://acme.slack.com/archives/CX/p10",
      channel: "general",
      user: "alice",
    });
    // what the run is about, right after the request (live-view item 19): the
    // resolved agent + model; no repo context for a repo-less general run;
    // the request's trace id (docs/reference/specs/tracing.md)
    const meta = events.find((e) => e.type === "run_meta")!;
    if (meta.type !== "run_meta") throw new Error("unreachable");
    expect(meta).toEqual({
      type: "run_meta",
      agent: "general",
      agentSource: "directive",
      model: expect.stringContaining("/"),
      traceId: expect.any(String),
      at: expect.any(Number),
    });
  });

  it("omits `source` from the `input` event entirely when the adapter supplied no origin hints (HTTP/MCP)", async () => {
    const events: RunEvent[] = [];
    const spy = {
      mintId: () => "run-i",
      create() {
        return { id: "run-i", token: "tok-i", control: new RunControl() };
      },
      publish(_id: string, e: RunEvent) {
        events.push(e);
      },
      finish() {},
      has: () => true,
      snapshot: () => null, // the finish reads the backlog for the card's shape (docs/reference/specs/tracing.md)
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = spy;
    await dispatch(deps, msg("agent:general hi"), fakeIO().io);
    const input = events.find((e) => e.type === "input")!;
    if (input.type !== "input") throw new Error("unreachable");
    expect("source" in input).toBe(false);
  });

  it("shows an `assistant` turn on the status card as a one-line 💬 excerpt (capped), never the full text", async () => {
    const long = "Let me look at the failing test first. ".repeat(6);
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [
              { type: "text", text: long },
              { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
            ],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    deps.statusUpdateMinMs = 0; // every frame reaches the channel; the 💬 one is superseded within ms otherwise
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    const trace = statuses.map((s) => s.detail ?? "").find((d) => d.includes("💬"));
    expect(trace).toBeDefined();
    expect(trace).toContain("💬 Let me look at the failing test first.");
    expect(trace).toContain("…");
    expect(trace).not.toContain(long.trim());
  });

  it("puts the per-run capability link on the status card when PUBLIC_BASE_URL is set", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example/");
    const registry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    // Trailing slash is trimmed; id/token are the capability URL's path/query.
    // The link rides on the structured `link` field (each channel renders it
    // its own way — Slack as a one-line hyperlink), NEVER inline in `detail`:
    // the bare URL wrapped to 4 lines and pushed the Slack card past the
    // "Show more" fold, where every edit flashed it open and shut.
    const withLink = statuses.filter((s) => s.link);
    expect(withLink.length).toBeGreaterThan(0);
    for (const s of withLink)
      expect(s.link).toEqual({ url: "https://bot.example/runs/abc?t=secret", label: "Live run" });
    expect(statuses.some((s) => s.detail?.includes("/runs/"))).toBe(false);
    // The FINAL ✅ frame keeps the link too — the run page outlives the run
    // (it shows the final answer), so the closed card must still lead to it.
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.link?.url).toBe("https://bot.example/runs/abc?t=secret");
  });

  it("omits the link entirely when PUBLIC_BASE_URL is unset (graceful degradation, no crash)", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", ""); // explicitly unset — link must be omitted
    const registry = new RunRegistry({ genId: () => "abc", genToken: () => "secret" });
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = registry;
    const { io, statuses, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(statuses.some((s) => s.detail?.includes("/runs/"))).toBe(false);
    expect(statuses.some((s) => s.link)).toBe(false);
  });
});

// Feature: docs/reference/specs/run-visibility.md item 2 — the closed ✅ card keeps the
// checklist with EVERY item checked off (the run completing is the proof they
// happened), and an empty update_status never erases progress.
// Feature: docs/reference/specs/agent-review.md item 13 — the review verdict reply carries
// the run link at the projection layer only: never in the `answer` event or
// the GitHub post body.
const REVIEW_PR_HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";

/** An executor at a checkout of the PR head, so the reviewed-head guard and
 *  the reading-diff baseline both pass without touching the host. */
function prHeadExecutor() {
  const executor = {
    exec: async (cmd: string) => (/git rev-parse HEAD/.test(cmd) ? `${REVIEW_PR_HEAD}\n` : ""),
    readFile: async () => "",
    writeFile: async () => "",
    release: async () => ({ released: true }),
  };
  vi.mocked(makeExecutor).mockResolvedValueOnce({ executor });
}

/** Review-run deps against a resolved PR with a benign post spy — the minimal
 *  harness for tests that exercise the answer path of a review run. */
function reviewRunDeps(provider: Provider) {
  const deps = makeDeps(YAML_FIXTURE, provider);
  deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: REVIEW_PR_HEAD });
  prHeadExecutor();
  deps.postReviewComment = vi.fn(async () => {});
  deps.fetchPrHead = async () => REVIEW_PR_HEAD;
  return deps;
}

describe("closed-card checklist and review verdict run link", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  /** A review provider that walks its checklist through update_status turns
   *  (each entry = one checklist payload) and then answers. */
  function checklistProvider(updates: string[], answer = "answer"): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        const i = n++;
        if (i < updates.length) {
          return {
            content: [{ type: "tool_use", id: `t${i}`, name: "update_status", input: { checklist: updates[i] } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
      },
    };
  }

  it("the ✅ close checks every checklist item off — ✱/○ become ✓, ✓ stays", async () => {
    const deps = reviewRunDeps(checklistProvider(["○ Read the diff\n○ Run tests", "✓ Read the diff\n✱ Run tests"]));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.detail).toBe("✓ Read the diff\n✓ Run tests");
  });

  it("an empty update_status never erases the checklist — the closed card keeps the last real one", async () => {
    const deps = reviewRunDeps(checklistProvider(["✱ Read the diff\n○ Run tests", "  "]));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("✅");
    expect(last.detail).toBe("✓ Read the diff\n✓ Run tests");
  });

  it("a failed run keeps the honest partial checklist — nothing is checked off", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "t0",
                name: "update_status",
                input: { checklist: "✱ Read the diff\n○ Run tests" },
              },
            ],
            stopReason: "tool_use",
          };
        }
        throw new Error("model exploded");
      },
    };
    const deps = reviewRunDeps(provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const last = statuses[statuses.length - 1];
    expect(last.title).toContain("❌");
    expect(last.detail).toBe("✱ Read the diff\n○ Run tests");
  });

  it("appends the run link to the review verdict reply — and ONLY to the projection: the answer event and the PR post stay link-free", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const events: RunEvent[] = [];
    const spy = {
      mintId: () => "run-x",
      create: () => ({ id: "run-x", token: "tok-x", control: new RunControl() }),
      publish: (_id: string, e: RunEvent) => void events.push(e),
      finish: () => {},
      has: () => true,
      snapshot: () => null, // the finish reads the backlog for the card's shape (docs/reference/specs/tracing.md)
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
    const deps = reviewRunDeps(capturingProvider());
    deps.runRegistry = spy;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer\n\n[Live run](https://bot.example/runs/run-x?t=tok-x)");
    const answerEvent = events.find((e) => e.type === "answer");
    if (answerEvent?.type !== "answer") throw new Error("unreachable");
    expect(answerEvent.text).toBe("answer"); // the run record is the source of truth, link-free
    const posted = vi.mocked(deps.postReviewComment!).mock.calls.map((c) => c[1]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain("Live run");
  });

  it("a non-review answer gets no run link even with PUBLIC_BASE_URL set — the card already carries it", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toContain("answer");
    expect(replies.some((r) => r.includes("Live run"))).toBe(false);
  });

  it("a failed run's error reply carries the run link — the transcript is one click from the thread", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        throw new Error("model exploded");
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    const fail = replies.find((r) => r.includes("model exploded"));
    // The harness names the failed call before the provider's words (harness-pi item 6).
    expect(fail).toMatch(
      /⚠️ the model call failed: model exploded\n\n\[Live run\]\(https:\/\/bot\.example\/runs\/.+\)/,
    );
  });

  // harness-pi item 6: a call the provider refused under its usage policy is
  // the failure by name, and the thread reads how to go on — never the
  // provider's words, which the run page keeps.
  it("a run the provider refused under its usage policy replies the one sentence that says how to go on, with the run link and none of the provider's words; any other provider error keeps the harness's text", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        return { content: [{ type: "text", text: "blocked by the provider's classifier" }], stopReason: "refusal" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    const fail = replies.find((r) => r.startsWith("⚠️"));
    expect(fail).toMatch(
      /^⚠️ the model refused this request under its usage policy — rephrase it and the thread continues\n\n\[Live run\]\(https:\/\/bot\.example\/runs\/.+\)$/,
    );
    expect(replies.join("\n")).not.toContain("classifier");
  });

  it("a review with no PUBLIC_BASE_URL replies the bare answer (graceful degradation)", async () => {
    const deps = reviewRunDeps(capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    expect(replies).toContain("answer");
  });
});

// Feature: docs/reference/specs/llm-output.md item 5 — the answer is canonicalized ONCE at
// the typed-output boundary: the answer event, the channel reply, and the
// GitHub post body all carry the canonical Markdown; the model's raw text
// rides on the event only when normalization changed it (redacted, and dropped
// when it would blow the per-event byte budget).
describe("typed answer output (docs/reference/specs/llm-output.md)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  function spyRegistry(events: RunEvent[]) {
    return {
      mintId: () => "run-t",
      create: () => ({ id: "run-t", token: "tok-t", control: new RunControl() }),
      publish: (_id: string, e: RunEvent) => void events.push(e),
      finish: () => {},
      has: () => true,
      snapshot: () => null, // the finish reads the backlog for the card's shape (docs/reference/specs/tracing.md)
      subscribe: () => () => {},
      size: () => 1,
    } as unknown as RunRegistry;
  }

  it("canonicalizes the answer for the event AND the reply, keeping the raw on the event", async () => {
    const events: RunEvent[] = [];
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("*Verdict: approve* — fine"));
    deps.runRegistry = spyRegistry(events);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies).toContain("**Verdict: approve** — fine");
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).toBe("**Verdict: approve** — fine");
    expect(answer.raw).toBe("*Verdict: approve* — fine");
  });

  it("omits `raw` when normalization changed nothing — the common case", async () => {
    const events: RunEvent[] = [];
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("plain **bold** answer"));
    deps.runRegistry = spyRegistry(events);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).toBe("plain **bold** answer");
    expect("raw" in answer).toBe(false);
  });

  it("redacts the raw like the text — a secret never survives on either copy", async () => {
    const events: RunEvent[] = [];
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("*token* is ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    deps.runRegistry = spyRegistry(events);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(answer.raw).toBeDefined();
    expect(answer.raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("drops `raw` (keeping the canonical text) when it would blow the per-event byte budget", async () => {
    const events: RunEvent[] = [];
    const big = `*x* ${"a".repeat(70_000)}`; // canonical differs; event with raw would exceed MAX_EVENT_BYTES
    const deps = makeDeps(YAML_FIXTURE, capturingProvider(big));
    deps.runRegistry = spyRegistry(events);
    await dispatch(deps, msg("hello there"), fakeIO().io);
    const answer = events.find((e) => e.type === "answer");
    if (answer?.type !== "answer") throw new Error("unreachable");
    expect(answer.text.startsWith("**x**")).toBe(true);
    expect("raw" in answer).toBe(false);
  });

  it("posts the canonical answer to GitHub too — every projection reads one dialect", async () => {
    const deps = reviewRunDeps(capturingProvider("*ok* — ship it"));
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42"), io);
    const posted = vi.mocked(deps.postReviewComment!).mock.calls.map((c) => c[1]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("**ok** — ship it");
    expect(posted[0]).not.toContain("*ok* —");
  });
});

// Feature: docs/reference/specs/memory.md — cross-session memory READ path.
// The load-bearing guarantee: with memory off (or a NullMemoryStore) the request
// sent to the provider is byte-identical to today; when enabled with a seeded
// store the advisory block rides on the system prompt, never in history.
const MEMORY_ON_YAML =
  YAML_FIXTURE +
  `
memory:
  enabled: true
`;

function memRecord(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem:org:acme:0",
    scopeKey: "org:acme",
    kind: "fact",
    text: "the deploy command is npm run deploy",
    keywords: ["deploy", "command", "npm"],
    sourceThreadKey: "slack:CX:9.9",
    createdAt: Date.now(),
    useCount: 0,
    status: "active",
    ...over,
  };
}

describe("cross-session memory READ path", () => {
  const ask = "what is the deploy command?";

  it("disabled path is byte-identical to memory-off (NullMemoryStore guarantee)", async () => {
    const off = capturingProvider();
    const offDeps = makeDeps(YAML_FIXTURE, off);
    await dispatch(offDeps, msg(ask), fakeIO().io);

    const on = capturingProvider();
    // The About block names memory when the capability is on — a different,
    // truthful sentence; what this test pins is that the memory BLOCK
    // contributes nothing, so both runs describe the same installation.
    const onDeps: CoreDeps = {
      ...makeDeps(MEMORY_ON_YAML, on),
      memory: new NullMemoryStore(),
      capabilities: offDeps.capabilities,
    };
    await dispatch(onDeps, msg(ask), fakeIO().io);

    expect(off.requests).toHaveLength(1);
    expect(on.requests).toHaveLength(1);
    // Full request (system + messages + tools + budgets) is byte-identical.
    // The runner still resolves the agent's own system prompt; what must not
    // differ is any memory block — and here there is none in either request.
    expect(JSON.stringify(on.requests[0])).toBe(JSON.stringify(off.requests[0]));
    expect(on.requests[0].system).not.toContain("Background memory");
  });

  it("memory off (default) injects nothing onto the system prompt", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg(ask), fakeIO().io);
    const sys = provider.requests[0].system;
    expect(sys).not.toContain("Background memory");
    // The config block + the agent's own prompt, nothing else ahead of them.
    expect(sys!.startsWith("Switchboard runtime config")).toBe(true);
    expect(sys).toContain(AGENTS.general.system);
  });

  it("enabled with a seeded store prepends the advisory block, preserving the agent prompt", async () => {
    const provider = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]);
    const deps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, provider), memory: store };
    await dispatch(deps, msg(ask), fakeIO().io);

    const sys = provider.requests[0].system;
    expect(sys).toBeDefined();
    // The block names every scope read: the org, then the requesting user's.
    expect(
      sys!.startsWith(
        "Background memory for org:acme + channel:slack:CX + user:slack:UX (may be outdated — verify before acting):",
      ),
    ).toBe(true);
    expect(sys).toContain("the deploy command is npm run deploy");
    expect(sys).toContain("You are Switchboard"); // the general agent's own prompt is still there
  });

  it("keeps the block out of history — it never appears in the messages array", async () => {
    const provider = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]);
    const deps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, provider), memory: store };
    await dispatch(deps, msg(ask), fakeIO().io);
    expect(JSON.stringify(provider.requests[0].messages)).not.toContain("Background memory");
  });

  it("enabled but nothing relevant → no block, request identical to memory-off", async () => {
    const off = capturingProvider();
    const offDeps = makeDeps(YAML_FIXTURE, off);
    await dispatch(offDeps, msg("tell me a joke"), fakeIO().io);

    const on = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]); // has a deploy fact, irrelevant here
    // Same installation described (see above): only the memory block is under test.
    const onDeps: CoreDeps = { ...makeDeps(MEMORY_ON_YAML, on), memory: store, capabilities: offDeps.capabilities };
    await dispatch(onDeps, msg("tell me a joke"), fakeIO().io);

    expect(JSON.stringify(on.requests[0])).toBe(JSON.stringify(off.requests[0]));
    expect(on.requests[0].system).not.toContain("Background memory");
  });
});

// Feature: docs/reference/specs/skills.md — progressive disclosure. When a skill
// store is on CoreDeps, the dispatcher appends the calling agent's scoped skill
// name+description list to its system prompt (bodies load on demand via
// use_skill, never dumped) and passes the store to the tool context. An agent
// with no scoped skills (general) is left untouched; scoping keeps review skills
// out of coding's list and vice-versa.
function skillFixture(over: Partial<Skill> = {}): Skill {
  return { name: "s", description: "d", body: "b", agents: ["review"], ...over };
}

function skillStore(): InMemorySkillStore {
  return new InMemorySkillStore([
    skillFixture({
      name: "code-review-and-quality",
      description: "review methodology",
      agents: ["review"],
      body: "REVIEW SKILL BODY",
    }),
    skillFixture({
      name: "test-driven-development",
      description: "coding methodology",
      agents: ["coding"],
      body: "CODING SKILL BODY",
    }),
  ]);
}

describe("skill loading / progressive disclosure", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  it("a review run's system prompt gains the review skill list, excluding coding skills", async () => {
    const provider = capturingProvider();
    const deps: CoreDeps = { ...makeDeps(YAML_FIXTURE, provider), skills: skillStore() };
    await dispatch(deps, msg("agent:review look at the code"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain("You are Switchboard"); // the agent's own prompt is preserved
    expect(sys).toContain("use_skill"); // the load instruction
    expect(sys).toContain("code-review-and-quality");
    expect(sys).toContain("review methodology");
    expect(sys).not.toContain("test-driven-development"); // a coding skill, out of scope
    expect(sys).not.toContain("REVIEW SKILL BODY"); // bodies load on demand, never in-prompt
  });

  it("the default (general, no scoped skills) run's system prompt is unchanged even with a store present", async () => {
    const withStore = capturingProvider();
    await dispatch({ ...makeDeps(YAML_FIXTURE, withStore), skills: skillStore() }, msg("hello there"), fakeIO().io);
    const withoutStore = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, withoutStore), msg("hello there"), fakeIO().io);
    // General declares no skills → block is undefined → byte-identical request.
    expect(JSON.stringify(withStore.requests[0])).toBe(JSON.stringify(withoutStore.requests[0]));
    expect(withStore.requests[0].system).not.toContain("use_skill");
  });

  it("no store on CoreDeps → no skill block (skilled agents unchanged)", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("agent:review look at the code"), fakeIO().io);
    // The harness note names every relayed tool, `use_skill` among them; the block is what a store adds.
    expect(provider.requests[0].system).not.toContain("## Skills");
    expect(provider.requests[0].system).not.toContain("SKILL BODY");
  });

  it("passes the store to the tool context: use_skill returns the body into the run", async () => {
    // Provider requests use_skill, then answers — so the runner dispatches the
    // tool with the injected store + agent name and appends its body to context.
    let n = 0;
    const provider: Provider & { requests: CompletionRequest[] } = {
      name: "fake",
      requests: [],
      async complete(req): Promise<CompletionResult> {
        this.requests.push({ ...req, messages: structuredClone(req.messages) });
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "s1", name: "use_skill", input: { name: "code-review-and-quality" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const deps: CoreDeps = { ...makeDeps(YAML_FIXTURE, provider), skills: skillStore() };
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review load the review skill"), io);
    expect(replies).toContain("done");
    // The 2nd model call sees the loaded skill body in the tool result.
    expect(JSON.stringify(provider.requests[1].messages)).toContain("REVIEW SKILL BODY");
  });
});

// Feature: docs/reference/specs/memory.md — cross-session memory WRITE path.
// After the reply lands, a qualifying run (used tools, or a long thread) fires
// ONE async reflection call on `memory.model`; disabled → nothing; fast paths
// (config/deterministic) never reflect; reflection failures never touch the
// user reply. The reflection promise is awaited only by the shutdown drain
// (`drainReflections`), which tests use to observe the write.
const MEMORY_WRITE_YAML =
  YAML_FIXTURE +
  `
memory:
  enabled: true
  model: anthropic/cheap-model
`;

const REFLECTION_REPLY = JSON.stringify({
  facts: [{ text: "the deploy command is npm run deploy", confidence: 0.9 }],
  summary: "User asked how to deploy; the deploy command was confirmed.",
});

/** A directory that calls the fixture's `slack:CX` a PUBLIC channel. The static
 *  default knows a Slack `C…` id only as `unknown`, and the write gate
 *  (docs/reference/specs/authorization.md item 8) never lets an unknown origin write the
 *  org scope (the fact is narrowed to the channel's), so the routing tests
 *  that expect org writes speak from a public channel — as the deployed bot's
 *  Slack directory would say of one. */
const PUBLIC_CHANNEL: ChannelDirectory = {
  info: async () => ({ visibility: "public" }),
  isMember: async () => "unknown",
};

/** Provider that answers the run (optionally after one tool call) and then the
 *  reflection request — keeping both requests observable. */
function runThenReflect(opts: { toolFirst?: boolean; failReflection?: boolean } = {}) {
  const requests: CompletionRequest[] = [];
  const order: string[] = [];
  let toolAsked = false;
  const provider: Provider = {
    name: "fake",
    async complete(req): Promise<CompletionResult> {
      requests.push(req);
      if (req.system === REFLECTION_SYSTEM) {
        order.push("reflect");
        if (opts.failReflection) throw new Error("extractor down");
        return { content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" };
      }
      if (opts.toolFirst && !toolAsked) {
        toolAsked = true;
        return {
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
          stopReason: "tool_use",
        };
      }
      order.push("answer");
      return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
    },
  };
  return { provider, requests, order };
}

const longHistory: HistoryItem[] = Array.from({ length: REFLECT_MIN_TURNS }, (_, i) => ({
  role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
  text: `turn ${i} about the deploy command`,
}));

describe("cross-session memory WRITE path", () => {
  async function run(yaml: string, history: HistoryItem[], opts: Parameters<typeof runThenReflect>[0] = {}) {
    const { provider, requests, order } = runThenReflect(opts);
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(yaml, provider), memory: store, channelDirectory: PUBLIC_CHANNEL };
    const { io, replies } = fakeIO(history);
    await dispatch(deps, msg("how do we deploy?"), io);
    await drainReflections();
    const written = await store.retrieve({ scopeKey: "org:acme", query: "deploy command", limit: 10 });
    return { requests, order, replies, written, store };
  }

  it("a run that used tools reflects once on memory.model, after the reply, and writes to the store", async () => {
    const { requests, order, replies, written } = await run(MEMORY_WRITE_YAML, [], { toolFirst: true });
    const reflections = requests.filter((r) => r.system === REFLECTION_SYSTEM);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].model).toBe("cheap-model");
    expect(order).toEqual(["answer", "reflect"]);
    // The user sees exactly one reply — the run's answer (the general agent's
    // 1-turn budget prefixes a wrap-up note after a tool call; irrelevant here).
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("answer");
    expect(written.map((r) => r.kind).sort()).toEqual(["fact", "summary"]);
    expect(written[0].sourceThreadKey).toBe("slack:CX:1.0");
    expect(written.every((r) => typeof r.sourceRunId === "string" && r.sourceRunId.length > 0)).toBe(true);
  });

  // Feature: docs/reference/specs/memory.md item 12 — a reflection's outcome is
  // observable: one `[memory] <threadKey>` line on stdout says what it wrote,
  // so the rate of rejections against successes can be read off the log.
  it("each reflection's outcome is one `[memory] <threadKey>` info line on stdout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(MEMORY_WRITE_YAML, [], { toolFirst: true });
    const lines = log.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith("[memory] "));
    log.mockRestore();
    expect(lines).toEqual(["[memory] slack:CX:1.0 reflection wrote 1 fact(s), summary"]);
  });

  // Feature: docs/reference/specs/memory.md item 11, harness-pi.md item 13 —
  // reflection's one call goes through pi's model library: the provider is
  // read off `completions` by the ref's name, never off the loop's `providers`.
  it("reflection's one call is made through `completions` — the table on pi's library — and the run's own provider never sees it", async () => {
    const { provider, requests } = runThenReflect({ toolFirst: true });
    const reflections: CompletionRequest[] = [];
    const asked: string[] = [];
    const reflector: Provider = {
      name: "anthropic",
      async complete(req): Promise<CompletionResult> {
        reflections.push(req);
        return { content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = {
      ...makeDeps(MEMORY_WRITE_YAML, provider),
      completions: {
        get: (name) => {
          asked.push(name);
          return reflector;
        },
      },
      memory: store,
      channelDirectory: PUBLIC_CHANNEL,
    };
    await dispatch(deps, msg("how do we deploy?"), fakeIO().io);
    await drainReflections();
    expect(asked).toEqual(["anthropic"]);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].model).toBe("cheap-model");
    expect(reflections[0].system).toBe(REFLECTION_SYSTEM);
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    const written = await store.retrieve({ scopeKey: "org:acme", query: "deploy command", limit: 10 });
    expect(written.map((r) => r.kind).sort()).toEqual(["fact", "summary"]);
  });

  // Feature: docs/reference/specs/memory.md §10 — a `review` run never reflects: its
  // findings land on the PR, and distilling them floods org memory with
  // per-PR ephemera. Other agents keep the work-based gate.
  it("a `review` run that used tools in a long thread does NOT reflect — no extra model call, nothing written", async () => {
    const { provider, requests } = runThenReflect({ toolFirst: true });
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    await dispatch(deps, msg("agent:review how do we deploy?"), fakeIO(longHistory).io);
    await drainReflections();
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    expect(await store.retrieve({ scopeKey: "org:acme", query: "deploy command", limit: 10 })).toEqual([]);
  });

  it("a `coding` run that used tools still reflects", async () => {
    const { provider, requests } = runThenReflect({ toolFirst: true });
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    await dispatch(deps, msg("agent:coding how do we deploy?", "slack:UADMIN"), fakeIO().io);
    await drainReflections();
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(1);
  });

  it("a long toolless thread qualifies too", async () => {
    const { requests, written } = await run(MEMORY_WRITE_YAML, longHistory);
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(1);
    expect(written.length).toBeGreaterThan(0);
  });

  it("a short toolless chat does NOT reflect (no extra model call, nothing written)", async () => {
    const { requests, written } = await run(MEMORY_WRITE_YAML, []);
    expect(requests).toHaveLength(1);
    expect(written).toEqual([]);
  });

  // Feature: docs/reference/specs/harness-pi.md item 6 — a HARD-stopped run has no
  // summary to distill (its answer is the abort line), so it never reflects even
  // when the gate (long thread) would otherwise qualify it.
  it("a hard-stopped run does NOT reflect, even when the gate would qualify it", async () => {
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    const requests: CompletionRequest[] = [];
    let hardSignal: AbortSignal | undefined;
    const provider: Provider = {
      name: "hang-then-reflect",
      complete: (req) => {
        requests.push(req);
        if (req.system === REFLECTION_SYSTEM) {
          return Promise.resolve({ content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" });
        }
        return new Promise((resolve) => {
          hardSignal = req.signal;
          req.signal?.addEventListener("abort", () =>
            resolve({ content: [{ type: "text", text: "late" }], stopReason: "end_turn" }),
          );
        });
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store, runRegistry: registry };
    const { io, replies } = fakeIO(longHistory);
    const run = dispatch(deps, msg("how do we deploy?"), io);
    while (!hardSignal) await new Promise((r) => setTimeout(r, 5));
    expect(registry.requestStop("r1", "t1", "hard")).toEqual({ ok: true, mode: "hard" });
    await run;
    await drainReflections();
    expect(replies.some((r) => r.includes("aborted"))).toBe(true);
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    expect(await store.retrieve({ scopeKey: "org:acme", query: "deploy command", limit: 10 })).toEqual([]);
  });

  // Feature: docs/reference/specs/memory.md — user-scoped memory end to end: a
  // `user`-audience fact from alice's run lands in alice's scope, surfaces on
  // her next request, and never on bob's; org facts reach both.
  it("user-scoped memory: a user's own records surface for them and never for another user", async () => {
    const reply = JSON.stringify({
      facts: [
        { text: "the deploy command is npm run deploy", confidence: 0.9, audience: "org" },
        { text: "this user wants a preview link before every deploy", confidence: 0.9, audience: "user" },
      ],
      summary: "",
    });
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        if (req.system === REFLECTION_SYSTEM)
          return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = {
      ...makeDeps(MEMORY_WRITE_YAML, provider),
      memory: store,
      channelDirectory: PUBLIC_CHANNEL,
    };

    await dispatch(deps, msg("how do we deploy?", "slack:UALICE"), fakeIO(longHistory).io);
    await drainReflections();
    expect(
      (await store.retrieve({ scopeKey: "user:slack:UALICE", query: "preview link deploy", limit: 10 })).map(
        (r) => r.text,
      ),
    ).toEqual(["this user wants a preview link before every deploy"]);
    expect((await store.list("org:acme", 10)).map((r) => r.text)).toEqual(["the deploy command is npm run deploy"]);
    expect(await store.retrieve({ scopeKey: "user:slack:UBOB", query: "preview link deploy", limit: 10 })).toEqual([]);

    requests.length = 0;
    await dispatch(deps, msg("deploy preview link?", "slack:UALICE"), fakeIO().io);
    const u1System = requests[0].system!;
    expect(u1System).toContain("Background memory for org:acme + channel:slack:CX + user:slack:UALICE");
    expect(u1System).toContain("this user wants a preview link before every deploy");
    expect(u1System).toContain("the deploy command is npm run deploy");

    requests.length = 0;
    await dispatch(deps, msg("deploy preview link?", "slack:UBOB"), fakeIO().io);
    const u2System = requests[0].system!;
    expect(u2System).toContain("Background memory for org:acme + channel:slack:CX + user:slack:UBOB");
    expect(u2System).not.toContain("preview link before every deploy");
    expect(u2System).toContain("the deploy command is npm run deploy");
  });

  // Feature: docs/reference/specs/authorization.md item 8, docs/reference/specs/memory.md §23
  // (deliberate change c) — end to end: the run's stamped channel visibility is
  // the origin the write gate decides under. A DM (`slack:D…`, dm by the static
  // directory) may not write the org scope: its `org` fact lands in the
  // requesting user's own scope, org stays empty, one `[memory]` line names the
  // reason token, and the channel fact keeps its scope (the audience is
  // narrowed, never widened). The same run from a public channel writes org.
  it("dm-origin memory: an `org` fact from a DM is narrowed to the user's scope, never org — and the same fact from a public channel reaches org", async () => {
    const reply = JSON.stringify({
      facts: [
        { text: "the deploy command is npm run deploy", confidence: 0.9, audience: "org" },
        { text: "this conversation is about deploys", confidence: 0.9, audience: "channel" },
      ],
      summary: "",
    });
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (req.system === REFLECTION_SYSTEM)
          return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dispatch(
      deps,
      { ...msg("how do we deploy?", "slack:UALICE"), channelId: "slack:D0AB", threadKey: "slack:D0AB:1.0" },
      fakeIO(longHistory).io,
    );
    await drainReflections();
    expect((await store.list("org:acme", 10)).map((r) => r.text)).toEqual([]);
    expect((await store.list("user:slack:UALICE", 10)).map((r) => r.text)).toEqual([
      "the deploy command is npm run deploy",
    ]);
    expect((await store.list("channel:slack:D0AB", 10)).map((r) => r.text)).toEqual([
      "this conversation is about deploys",
    ]);
    const lines = warn.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith("[memory] slack:D0AB:1.0"));
    expect(lines).toEqual([expect.stringContaining("1× org → user (origin-visibility)")]);
    expect(lines[0]).not.toContain("deploy command");
    warn.mockRestore();

    const pub = new InMemoryMemoryStore();
    const publicDeps: CoreDeps = {
      ...makeDeps(MEMORY_WRITE_YAML, provider),
      memory: pub,
      channelDirectory: PUBLIC_CHANNEL,
    };
    await dispatch(publicDeps, msg("how do we deploy?", "slack:UALICE"), fakeIO(longHistory).io);
    await drainReflections();
    expect((await pub.list("org:acme", 10)).map((r) => r.text)).toEqual(["the deploy command is npm run deploy"]);
    expect(await pub.list("user:slack:UALICE", 10)).toEqual([]);
  });

  // Feature: docs/reference/specs/memory.md §21–23 — repo + channel scopes end to end:
  // a repo-bound coding run writes a `repo` fact into `repo:acme/api` and a
  // `channel` fact into this channel's scope; a request from another channel
  // still gets the org fact but not the channel fact.
  it("repo/channel-scoped memory: a repo-bound run writes into repo + channel scopes; another channel never sees the channel fact", async () => {
    const reply = JSON.stringify({
      facts: [
        { text: "the deploy command is npm run deploy", confidence: 0.9, audience: "org" },
        { text: "acme/api deploys with make release", confidence: 0.9, audience: "repo" },
        { text: "this channel coordinates acme deploys", confidence: 0.9, audience: "channel" },
      ],
      summary: "",
    });
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        if (req.system === REFLECTION_SYSTEM)
          return { content: [{ type: "text", text: reply }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = {
      ...makeDeps(MEMORY_WRITE_YAML, provider),
      memory: store,
      channelDirectory: PUBLIC_CHANNEL,
    };
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });

    await dispatch(deps, msg("agent:coding how do we deploy?", "slack:UADMIN"), fakeIO(longHistory).io);
    await drainReflections();
    expect((await store.list("repo:acme/api", 10)).map((r) => r.text)).toEqual(["acme/api deploys with make release"]);
    expect((await store.list("channel:slack:CX", 10)).map((r) => r.text)).toEqual([
      "this channel coordinates acme deploys",
    ]);
    expect((await store.list("org:acme", 10)).map((r) => r.text)).toEqual(["the deploy command is npm run deploy"]);

    requests.length = 0;
    await dispatch(deps, msg("acme deploy release?", "slack:UBOB"), fakeIO().io); // same channel (slack:CX), toolless general
    const sameChannel = requests[0].system!;
    expect(sameChannel).toContain("Background memory for org:acme + channel:slack:CX + user:slack:UBOB");
    expect(sameChannel).toContain("this channel coordinates acme deploys");
    expect(sameChannel).not.toContain("make release"); // no repo bound on a toolless general run

    requests.length = 0;
    await dispatch(
      deps,
      { ...msg("acme deploy release?", "slack:UBOB"), channelId: "slack:CY", threadKey: "slack:CY:1.0" },
      fakeIO().io,
    );
    const otherChannel = requests[0].system!;
    expect(otherChannel).toContain("Background memory for org:acme + channel:slack:CY + user:slack:UBOB");
    expect(otherChannel).not.toContain("coordinates acme deploys");
    expect(otherChannel).toContain("the deploy command is npm run deploy");
  });

  it("memory disabled → no reflection even on a qualifying run (zero behavior change)", async () => {
    const { requests, written } = await run(YAML_FIXTURE, longHistory, { toolFirst: true });
    expect(requests.filter((r) => r.system === REFLECTION_SYSTEM)).toHaveLength(0);
    expect(written).toEqual([]);
  });

  it("memory.model absent → reflection falls back to the run's own resolved model (never a hardcoded ref)", async () => {
    const { requests } = await run(MEMORY_ON_YAML, longHistory);
    const reflections = requests.filter((r) => r.system === REFLECTION_SYSTEM);
    expect(reflections).toHaveLength(1);
    expect(reflections[0].model).toBe("general-model");
  });

  it("a reflection failure never touches the user reply", async () => {
    const { replies, written } = await run(MEMORY_WRITE_YAML, longHistory, { failReflection: true });
    expect(replies).toEqual(["answer"]); // no ⚠️ reply, answer intact
    expect(written).toEqual([]);
  });

  it("dispatch returns without awaiting the reflection (fire-and-forget; only the drain awaits it)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (req.system === REFLECTION_SYSTEM) {
          await gate;
          return { content: [{ type: "text", text: REFLECTION_REPLY }], stopReason: "end_turn" };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = {
      ...makeDeps(MEMORY_WRITE_YAML, provider),
      memory: store,
      channelDirectory: PUBLIC_CHANNEL,
    };
    const { io, replies } = fakeIO(longHistory);
    await dispatch(deps, msg("how do we deploy?"), io);
    expect(replies).toEqual(["answer"]);
    expect(pendingReflectionCount()).toBe(1); // still in flight after dispatch returned
    release();
    await drainReflections();
    expect(pendingReflectionCount()).toBe(0);
    expect(await store.retrieve({ scopeKey: "org:acme", query: "deploy command", limit: 10 })).not.toEqual([]);
  });

  it("the run stays counted in flight through the reply and reflection scheduling (drain cannot see 0/0 in between)", async () => {
    const { provider } = runThenReflect();
    const store = new InMemoryMemoryStore();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: store };
    const seen: Array<{ runs: number; reflections: number }> = [];
    const io: ChannelIO = {
      ...fakeIO(longHistory).io,
      reply: async () => {
        seen.push({ runs: activeRunCount(), reflections: pendingReflectionCount() });
      },
    };
    await dispatch(deps, msg("how do we deploy?"), io);
    // While the reply is being delivered the run loop has ended but the run is
    // still counted, so activeRuns + pendingReflections is never 0 before the
    // reflection is scheduled.
    expect(seen).toEqual([{ runs: 1, reflections: 0 }]);
    expect(activeRunCount()).toBe(0); // released once dispatch returns
    expect(pendingReflectionCount()).toBe(1); // ...and the reflection is what's in flight now
    await drainReflections();
  });

  // Drain race: a mentioned reply is 👀-acked and `dispatch()` entered, then
  // SIGTERM lands a second later — a count that started only after resolution,
  // the setup card and the executor attach would let the drain log "0 run(s)
  // in flight". A dispatch is in flight from its first line.
  it("a dispatch is counted in flight from entry — before history, the setup card or any attach (drain race)", async () => {
    const { provider } = runThenReflect();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: new InMemoryMemoryStore() };
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((r) => (releaseHistory = r));
    const base = fakeIO(longHistory);
    const io: ChannelIO = { ...base.io, history: () => historyGate.then(() => longHistory) };
    expect(activeRunCount()).toBe(0);
    const running = dispatch(deps, msg("how do we deploy?"), io);
    // The increment is synchronous: the count is already 1 when `dispatch()`
    // hands back its promise, with no tick needed — which is what the adapter's
    // fire-and-forget call and the drain's poll rely on.
    expect(activeRunCount()).toBe(1); // visible to the drain before anything slow
    expect(base.statuses).toHaveLength(0); // ...and before the setup card exists
    releaseHistory();
    await running;
    expect(activeRunCount()).toBe(0); // released once dispatch returns
    await drainReflections();
  });

  it("an early-return path (config command) releases the count: 0 after dispatch", async () => {
    const { provider } = runThenReflect();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: new InMemoryMemoryStore() };
    const running = dispatch(deps, msg("config show"), fakeIO(longHistory).io);
    expect(activeRunCount()).toBe(1); // held synchronously, even on the fast path
    await running;
    expect(activeRunCount()).toBe(0);
    await drainReflections();
  });

  it("config-command fast path never reflects", async () => {
    const { provider, requests } = runThenReflect();
    const deps: CoreDeps = { ...makeDeps(MEMORY_WRITE_YAML, provider), memory: new InMemoryMemoryStore() };
    await dispatch(deps, msg("config show"), fakeIO(longHistory).io);
    await dispatch(deps, msg("help"), fakeIO(longHistory).io);
    await drainReflections();
    expect(requests).toHaveLength(0);
  });
});

// Feature: docs/reference/specs/routing-and-config.md behavior 8 — config awareness. The
// regression: asked "what are your settings, can I tune them?", the toolless
// general agent answered "stateless, no per-user/per-channel tuning" — false;
// the config system existed, the model was simply never told. Every run's
// system prompt now carries the RESOLVED agent/model/scope and how to tune it.
describe("self-description in the system prompt (routing-and-config behavior 11) and the github_* tools (docs/reference/specs/github-tools.md)", () => {
  it("every run's prompt carries the About block right after the config block, naming the agents, residents, and the repo + specs", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("how does your resident system work?"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain(selfDescriptionBlock(AGENTS, "acme", deps.capabilities, undefined));
    expect(sys.indexOf("Switchboard runtime config")).toBeLessThan(sys.indexOf(SELF_DESCRIPTION_HEADER));
    expect(sys.indexOf(SELF_DESCRIPTION_HEADER)).toBeLessThan(sys.indexOf("You are Switchboard"));
    expect(sys.split(SELF_DESCRIPTION_HEADER)).toHaveLength(2); // exactly once
  });

  it("the About block follows the process's capabilities and the resident Worker's own cap: residents off → no onboarding paragraph; residents on → the fleet facts' number", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.capabilities = { ...deps.capabilities, residents: false };
    await dispatch(deps, msg("how does your resident system work?"), fakeIO().io);
    const off = provider.requests[0].system ?? "";
    expect(off).toContain("no resident (always-warm) repo environments");
    expect(off).not.toContain("repo onboard");
    const on = makeDeps(YAML_FIXTURE, provider);
    on.capabilities = { ...on.capabilities, residents: true };
    on.residentFleet = { cap: () => 4 };
    await dispatch(on, msg("how does your resident system work?"), fakeIO().io);
    const sys = provider.requests[1].system ?? "";
    expect(sys).toContain("capped at 4 residents");
    expect(sys).toContain("`repo onboard <owner/name>`");
  });

  it("a plain mention opens an issue through github_issue_create on the injected API, and the answer carries the tool's number + URL", async () => {
    let n = 0;
    const provider: Provider & { requests: CompletionRequest[] } = {
      name: "fake",
      requests: [],
      async complete(req): Promise<CompletionResult> {
        provider.requests.push(req);
        if (n++ === 0)
          return {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "github_issue_create",
                input: { repo: "acme/api", title: "foo", body: "bar" },
              },
            ],
            stopReason: "tool_use",
          };
        const result = req.messages.at(-1)?.content;
        const text = Array.isArray(result)
          ? result.map((c) => ("content" in c && typeof c.content === "string" ? c.content : "")).join("")
          : String(result);
        return { content: [{ type: "text", text: `Done: ${text}` }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const api = new InMemoryGithubApi({ "acme/api": {} });
    deps.githubApi = api;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('open an issue on the switchboard app with the title "foo" and the body "bar"'), io);
    expect(provider.requests[0].tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["github_issue_create", "github_file", "github_repos", "web_fetch"]),
    );
    expect(provider.requests[0].tools?.map((t) => t.name)).not.toContain("bash");
    expect((await api.listIssues("acme/api")).map((i) => ({ title: i.title, body: i.body }))).toEqual([
      { title: "foo", body: "bar" },
    ]);
    expect(replies.at(-1)).toContain("Opened acme/api#1: foo\nhttps://github.com/acme/api/issues/1");
  });

  it("the issue write is gated by restrict.repos for the requesting user — refused before the API, allowed for a granted user", async () => {
    const gated = YAML_FIXTURE.replace("restrict:\n", 'restrict:\n  repos: ["acme/api"]\n');
    const call = (): Provider => {
      let n = 0;
      return {
        name: "fake",
        async complete(req): Promise<CompletionResult> {
          if (n++ === 0)
            return {
              content: [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "github_issue_create",
                  input: { repo: "acme/api", title: "foo" },
                },
              ],
              stopReason: "tool_use",
            };
          const result = req.messages.at(-1)?.content;
          const text = Array.isArray(result)
            ? result.map((c) => ("content" in c && typeof c.content === "string" ? c.content : "")).join("")
            : String(result);
          return { content: [{ type: "text", text }], stopReason: "end_turn" };
        },
      };
    };
    const api = new InMemoryGithubApi({ "acme/api": {} });
    const denied = makeDeps(gated, call());
    denied.githubApi = api;
    const d = fakeIO();
    await dispatch(denied, msg("open an issue", "slack:UX"), d.io);
    expect(d.replies.at(-1)).toContain(
      "github_issue_create: you are not allowed to write to acme/api (it is restricted and you hold no grant for it)",
    );
    expect(await api.listIssues("acme/api")).toEqual([]);
    const allowed = makeDeps(gated, call());
    allowed.githubApi = api;
    const a = fakeIO();
    await dispatch(allowed, msg("open an issue", "slack:UADMIN"), a.io);
    expect(a.replies.at(-1)).toContain("Opened acme/api#1: foo");
  });
});

describe("config awareness in the system prompt", () => {
  const CHANNEL_FORCED_YAML =
    YAML_FIXTURE +
    `
channels:
  "slack:CX":
    agent: review
`;

  it("a default dispatch names the resolved agent+model and says config is tunable", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("what are your current settings?"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain("agent `general`");
    expect(sys).toContain("model `anthropic/general-model`");
    expect(sys).toMatch(/using defaults/i);
    expect(sys).toContain("`config set me");
    expect(sys).toContain("`config show`");
    // Rides ahead of the agent's own instructions, exactly once.
    expect(sys.indexOf("Switchboard runtime config")).toBeLessThan(sys.indexOf("You are Switchboard"));
    expect(sys.match(/Switchboard runtime config/g)).toHaveLength(1);
    expect(sys).toContain(AGENTS.general.system);
  });

  it("a `config set me` override is reflected as the actual resolved model on the next run", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --model anthropic/my-model"), io);
    expect(replies[0]).toMatch(/Updated your scope/);
    expect(provider.requests).toHaveLength(0); // config commands never reach a model

    await dispatch(deps, msg("what model are you?"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("my-model");
    expect(sys).toContain("model `anthropic/my-model`");
    expect(sys).toContain("user override: model `anthropic/my-model`");
    expect(sys).not.toMatch(/using defaults/i);
  });

  it("effort resolves like model: `effort:` directive → provider request + awareness block; `config set me effort=` sticks per user", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("effort:low quick answer please"), fakeIO().io);
    expect(provider.requests[0].effort).toBe("low");
    expect(JSON.stringify(provider.requests[0].messages.at(-1)?.content)).not.toMatch(/effort:low/); // stripped from the text the model sees
    expect(provider.requests[0].system).toContain("at effort `low`");
    expect(provider.requests[0].system).toContain("This message's `effort:low` directive");

    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --effort medium"), io);
    expect(replies[0]).toMatch(/Updated your scope.*"effort":"medium"/);
    await dispatch(deps, msg("and now?"), fakeIO().io);
    expect(provider.requests[1].effort).toBe("medium");
    expect(provider.requests[1].system).toContain("user override: effort `medium`");

    await dispatch(deps, msg("config set me --efforts.general high"), fakeIO().io);
    await dispatch(deps, msg("config set me --effort low"), fakeIO().io);
    await dispatch(deps, msg("forced wins over per-agent"), fakeIO().io);
    expect(provider.requests[2].effort).toBe("low");
  });

  it("effort is thread-sticky: a directive-free follow-up keeps the thread's effort and says so", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("continue"), fakeIO([{ role: "user", text: "effort:low start here" }]).io);
    expect(provider.requests[0].effort).toBe("low");
    expect(provider.requests[0].system).toContain("A `effort:low` directive earlier in this thread");
  });

  it("an unset effort leaves the provider request without one (the agent/provider default), and bad values are refused inline", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(deps, msg("hello"), fakeIO().io);
    expect(provider.requests[0].effort).toBeUndefined();
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --effort turbo"), io);
    expect(replies[0]).toBe('⚠️ `config set`: effort: expected one of "low", "medium", "high", "xhigh", "max"');
    await dispatch(deps, msg("config set me --efforts.nope low"), io);
    expect(replies[1]).toMatch(/^⚠️ `config set`: efforts\.nope: expected an agent name \(one of /);
    await dispatch(deps, msg("effort:turbo hi"), io);
    expect(replies[2]).toMatch(/Unknown effort "turbo"/);
    expect(provider.requests).toHaveLength(1);
  });

  it("a channel-forced agent is reported as a channel override with the agent that actually ran", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(CHANNEL_FORCED_YAML, provider), msg("hello"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("review-model");
    expect(sys).toContain("agent `review`");
    expect(sys).toContain("model `anthropic/review-model`");
    expect(sys).toContain("channel override: agent `review`");
    expect(sys).toContain(AGENTS.review.system);
  });

  it("per-message agent:/model: directives are reflected as the resolved state, attributed to the message", async () => {
    const provider = capturingProvider();
    await dispatch(
      makeDeps(YAML_FIXTURE, provider),
      msg("agent:review model:anthropic/x-model what are you running on?"),
      fakeIO().io,
    );
    const sys = provider.requests[0].system ?? "";
    expect(provider.requests[0].model).toBe("x-model");
    expect(sys).toContain("agent `review`");
    expect(sys).toContain("model `anthropic/x-model`");
    expect(sys).toMatch(/this message's `agent:review model:anthropic\/x-model` directive/i);
    expect(sys).not.toContain("general-model"); // never the default when a directive won
  });

  it("a sticky thread directive is attributed to the thread, not this message", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await threadWithFinishedRun(deps, "review"); // the thread's review run: sticky by transcript
    const history: HistoryItem[] = [
      { role: "user", text: "effort:low look at this" },
      { role: "assistant", text: "looked" },
    ];
    await dispatch(deps, msg("and now?"), fakeIO(history).io);
    const sys = provider.requests[0].system ?? "";
    expect(sys).toContain("agent `review`");
    expect(sys).toMatch(/The thread's earlier `review` run set the agent for this run \(thread stickiness/);
    expect(sys).toMatch(/A `effort:low` directive earlier in this thread set the model\/effort/);
    expect(sys).not.toMatch(/this message's/i);
  });

  it("channel-config gating is stated per the invoking user", async () => {
    const gatedYaml = YAML_FIXTURE; // config:write is never a baseline: gated unless granted
    const user = capturingProvider();
    await dispatch(makeDeps(gatedYaml, user), msg("hi"), fakeIO().io);
    expect(user.requests[0].system).toMatch(/config set channel[^\n]*restricted for this user/i);

    const admin = capturingProvider();
    await dispatch(makeDeps(gatedYaml, admin), msg("hi", "slack:UADMIN"), fakeIO().io);
    expect(admin.requests[0].system).not.toMatch(/restricted for this user/i);
  });

  it("does not regress the memory or skills blocks: memory still leads, skills still trail", async () => {
    const provider = capturingProvider();
    const deps: CoreDeps = {
      ...makeDeps(MEMORY_ON_YAML, provider),
      memory: new InMemoryMemoryStore([memRecord()]),
      skills: skillStore(),
    };
    await dispatch(deps, msg("agent:review what is the deploy command?", "slack:UADMIN"), fakeIO().io);
    const sys = provider.requests[0].system ?? "";
    const iMem = sys.indexOf("Background memory");
    const iCfg = sys.indexOf("Switchboard runtime config");
    const iAgent = sys.indexOf(AGENTS.review.system);
    const iSkills = sys.indexOf("use_skill");
    expect(iMem).toBe(0);
    expect(iCfg).toBeGreaterThan(iMem);
    expect(iAgent).toBeGreaterThan(iCfg);
    expect(iSkills).toBeGreaterThan(iAgent);
  });
});

describe("self-improvement wiring", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function toolThenAnswer(): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
  }

  it("every finished run's friction diagnosis reaches the ledger through run history — the record's diagnosis, keyed by the registry run id", async () => {
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ genId: () => "run-friction-1", genToken: () => "tok" });
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    const { io } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();

    const [rec] = await new RunStoreFrictionLedger(store).recent();
    expect(rec.runId).toBe("run-friction-1");
    expect(rec.agent).toBe("general");
    expect(rec.label).toContain("general");
    expect(rec.diagnosis.eventCount).toBe(3); // the gate's tool_refused note, tool_call, tool_result (the narrative events are not steps)
    // The general agent has no shell: its `bash` call is an unknown tool → a failed_tool finding.
    expect(rec.diagnosis.byCategory.failed_tool.count).toBe(1);
  });

  // Feature: docs/reference/specs/memory.md §24 — `memory list`/`memory forget` are
  // config-family: answered inline from the store, never a model turn.
  it("`memory list` is answered inline from the memory store through the registry — no model turn, no repo resolution unless the repo scope is asked for", async () => {
    const provider = capturingProvider();
    const store = new InMemoryMemoryStore([memRecord()]);
    const deps = makeDeps(MEMORY_ON_YAML, provider);
    deps.memory = store;
    let repoResolutions = 0;
    deps.resolveRepoContext = () => {
      repoResolutions++;
      return { repo: "acme/api" };
    };
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("memory list --scope org"), io);
    expect(provider.requests).toHaveLength(0);
    expect(deps.invoked).toEqual(["memory.list"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("mem:org:acme:0");
    expect(repoResolutions).toBe(0);
    // `all` (the default) includes the repo scope, so the thread's repo is resolved — lazily, through the caller's origin.
    await dispatch(deps, msg("memory list"), io);
    expect(repoResolutions).toBe(1);
    expect(replies[1]).toContain("*this repo's records* (`repo:acme/api`): no active records.");
    expect(replies[1]).toContain("*this channel's records* (`channel:slack:CX`): no active records.");
  });

  it("`memory forget` is an inline run (a durable mutation) while `memory list` is a plain reply", async () => {
    const store = new InMemoryMemoryStore([memRecord({ id: "mem:user:slack:UX:0", scopeKey: "user:slack:UX" })]);
    const deps = makeDeps(MEMORY_ON_YAML, capturingProvider());
    deps.memory = store;
    deps.runRegistry = new RunRegistry({ genId: () => "mem-1", genToken: () => "tok" });
    const receipts: RunReceipt[] = [];
    const { io, replies } = fakeIO();
    io.runFinished = (r) => void receipts.push(r);
    await dispatch(deps, msg("memory list"), io);
    expect(receipts).toEqual([]);
    await dispatch(deps, msg("memory forget mem:user:slack:UX:0"), io);
    expect(replies[1]).toMatch(/^🧹 Forgot `mem:user:slack:UX:0`/);
    expect(receipts).toEqual([{ id: "mem-1", status: "completed" }]);
    expect(contentOf(deps.runRegistry.snapshot("mem-1", "tok")!.events).map((e) => e.type)).toEqual([
      "input",
      "run_meta",
      "answer",
    ]);
  });

  it("`friction report` is answered inline from the ledger through the registry — no model turn, no executor", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.frictionLedger = new InMemoryFrictionLedger();
    const { invoked } = wireCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("friction report"), io);
    expect(replies).toEqual([
      "🔍 0 runs analyzed — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs).",
    ]);
    expect(invoked).toEqual(["friction.report"]);
    expect(provider.requests).toEqual([]);
    expect(makeExecutor).not.toHaveBeenCalled();
  });

  it("`friction propose` is gated (admins only when unconfigured) with the shared restricted wording and files through the injected tracker", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(`${YAML_FIXTURE}\nselfImprovement:\n  repo: o/r\n`, provider);
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.issueTracker = new InMemoryIssueTracker();
    wireCommands(deps);
    const denied = fakeIO();
    await dispatch(deps, msg("friction propose"), denied.io);
    expect(denied.replies).toEqual(["🚫 `friction propose` is restricted. Ask <@slack:UADMIN>."]);
    const allowed = fakeIO();
    await dispatch(deps, msg("friction propose", "slack:UADMIN"), allowed.io);
    expect(allowed.replies[0]).toContain("0 runs analyzed");
    expect(provider.requests).toEqual([]);
  });
});

// Feature: docs/reference/specs/routing-and-config.md behavior 9 — per-scope custom
// instructions folded into the system prompt at the same seam
// as memory/skills/config-awareness. Advisory only.
describe("custom instructions in the system prompt", () => {
  // Pinned to the renderer's own header so a wording change in the
  // awareness block (which mentions "custom instructions" too) cannot make
  // these negative matches pass or fail by accident.
  const INSTRUCTIONS_BLOCK = new RegExp(`^${CUSTOM_INSTRUCTIONS_HEADER}`, "m");

  it("with no instructions set, the system prompt carries no instructions block (byte-identical path)", async () => {
    const provider = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, provider), msg("hello"), fakeIO().io);
    expect(provider.requests[0].system ?? "").not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it('`config instructions me "..."` applies to that user\'s runs only, never to other requesters', async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('config instructions me "Always sign off as Dan."'), io);
    expect(replies[0]).toMatch(/Updated your instructions/);
    expect(replies[0]).toContain("Always sign off as Dan.");
    expect(provider.requests).toHaveLength(0);

    await dispatch(deps, msg("hi"), fakeIO().io);
    const mine = provider.requests[0].system ?? "";
    expect(mine).toMatch(/Requester's instructions \(set by the requesting user\):\nAlways sign off as Dan\./);
    expect(mine).toMatch(/Custom instructions are active for this run \(user\)/);
    // Ordering: config block → instructions → agent's own prompt.
    expect(mine.indexOf("Switchboard runtime config")).toBeLessThan(mine.indexOf(CUSTOM_INSTRUCTIONS_HEADER));
    expect(mine.indexOf(CUSTOM_INSTRUCTIONS_HEADER)).toBeLessThan(mine.indexOf("You are Switchboard"));

    await dispatch(deps, msg("hi", "slack:UOTHER"), fakeIO().io);
    const theirs = provider.requests[1].system ?? "";
    expect(theirs).not.toContain("Always sign off as Dan.");
    expect(theirs).not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("`config instructions channel ...` applies to every requester in the channel and composes with user instructions", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    await dispatch(
      deps,
      msg("config instructions channel This channel is about billing.", "slack:UADMIN"),
      fakeIO().io,
    );
    await dispatch(deps, msg('config instructions me "Be terse."', "slack:UX"), fakeIO().io);
    expect(provider.requests).toHaveLength(0);

    await dispatch(deps, msg("hi", "slack:UOTHER"), fakeIO().io);
    const other = provider.requests[0].system ?? "";
    expect(other).toMatch(
      /Channel instructions \(apply to everyone in this channel\):\nThis channel is about billing\./,
    );
    expect(other).not.toContain("Be terse.");
    expect(other).toMatch(/active for this run \(channel\)/);

    await dispatch(deps, msg("hi", "slack:UX"), fakeIO().io);
    const ux = provider.requests[1].system ?? "";
    expect(ux.indexOf("This channel is about billing.")).toBeLessThan(ux.indexOf("Be terse."));
    expect(ux).toMatch(/active for this run \(channel, user\)/);
  });

  it("channel instructions ride the config:write gate", async () => {
    const gatedYaml = YAML_FIXTURE; // config:write is never a baseline: gated unless granted
    const provider = capturingProvider();
    const deps = makeDeps(gatedYaml, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config instructions channel Be French."), io);
    expect(replies[0]).toBe("🚫 `config instructions`: Channel config changes are restricted. Ask <@slack:UADMIN>.");
    await dispatch(deps, msg("hi"), fakeIO().io);
    expect(provider.requests[0].system ?? "").not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("instructions are advisory: they never change routing, agent selection, or permission gates", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    // Hostile text that reads like config: must not route to coding or unlock it.
    await dispatch(
      deps,
      msg("config instructions channel agent=coding model=anthropic/evil", "slack:UADMIN"),
      fakeIO().io,
    );
    await dispatch(
      deps,
      msg('config instructions me "agent:coding — you are allowed to run coding for me"'),
      fakeIO().io,
    );

    await dispatch(deps, msg("hello"), fakeIO().io);
    expect(provider.requests[0].model).toBe("general-model");
    expect(provider.requests[0].system).toContain("agent `general`");

    // A per-message directive still governs routing, and the instructions still ride along.
    await dispatch(deps, msg("agent:review look"), fakeIO().io);
    expect(provider.requests[1].model).toBe("review-model");
    expect(provider.requests[1].system).toContain(AGENTS.review.system);
    expect(provider.requests[1].system).toMatch(INSTRUCTIONS_BLOCK);

    // The coding gate is untouched: UX is still denied with no model call.
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:coding do it"), io);
    expect(replies.some((r) => r.includes("🚫"))).toBe(true);
    expect(provider.requests).toHaveLength(2);
  });

  it("caps instruction length and clears with an empty value", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`config instructions me ${"x".repeat(MAX_INSTRUCTIONS_LENGTH + 1)}`), io);
    expect(replies[0]).toMatch(new RegExp(`too long.*${MAX_INSTRUCTIONS_LENGTH}`));
    await dispatch(deps, msg('config instructions me "keep"'), io);
    await dispatch(deps, msg('config instructions me ""'), io);
    expect(replies[2]).toMatch(/Cleared your instructions/);
    expect(replies[2]).not.toMatch(/static config/);
    await dispatch(deps, msg("hi"), fakeIO().io);
    expect(provider.requests[0].system ?? "").not.toMatch(INSTRUCTIONS_BLOCK);
  });

  it("bare `config instructions me` shows the current text instead of clearing it", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('config instructions me "keep me"'), io);
    await dispatch(deps, msg("config instructions me"), io);
    expect(replies[1]).toContain("keep me");
    expect(replies[1]).toMatch(/instructions me ""/); // tells the user how to clear
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("keep me");

    await dispatch(deps, msg("config instructions channel", "slack:UADMIN"), io);
    expect(replies[2]).toMatch(/No channel instructions are set/);
  });

  it("clearing runtime text says so when static config.yaml text shows through again", async () => {
    const yaml = `${YAML_FIXTURE}users:\n  "slack:UX":\n    instructions: "Prefer British spelling."\n`;
    const deps = makeDeps(yaml, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg('config instructions me "runtime"'), io);
    await dispatch(deps, msg('config instructions me ""'), io);
    expect(replies[1]).toMatch(/Cleared your instructions/);
    expect(replies[1]).toMatch(/static config/);
    expect(replies[1]).toContain("Prefer British spelling.");
  });

  it("`instructions` is its own command: passing it to `config set` is a usage reply (derived usage line), nothing is set, nothing invoked", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("config set me --agent review --instructions x"), io);
    expect(replies[0]).toContain("⚠️ `config set`: unknown option --instructions");
    expect(replies[0]).toContain("usage: config set <scope>");
    expect(deps.invoked).toEqual([]);
    expect(deps.config.scopes("slack:CX", "slack:UX").user).toEqual({});
  });

  it("k=v replies elide the instructions text instead of echoing it", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    const long = "Always reply in haiku. ".repeat(20).trim();
    await dispatch(deps, msg(`config instructions me ${long}`), io);
    await dispatch(deps, msg("config set me --agent review"), io);
    expect(replies[1]).toMatch(/Updated your scope/);
    expect(replies[1]).toContain('"agent":"review"');
    expect(replies[1]).not.toContain(long);
    expect(replies[1]).toMatch(new RegExp(`instructions.*${long.length} chars`));
  });

  it("quotes are the shared grammar's: a quoted span is one token, smart quotes normalize, and quotes never survive into the text", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    await dispatch(deps, msg('config instructions me "a" or "b"'), fakeIO().io);
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("a or b");
    await dispatch(deps, msg("config instructions me \u201cSmart quoted.\u201d"), fakeIO().io);
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("Smart quoted.");
    await dispatch(deps, msg('config instructions me "keep  two spaces"'), fakeIO().io);
    expect(deps.config.scopes("slack:CX", "slack:UX").user.instructions).toBe("keep  two spaces");
  });
});

// Feature: docs/reference/specs/slack-channel.md item 8 \u2014 a run that is still in flight when
// the process is told to shut down (SIGTERM from a deploy rollout) says so on
// its live card, so a reader can tell "finishing before a restart" from a run
// that is simply slow. The closed card never carries the notice.
describe("shutdown notice on the live status card", () => {
  afterEach(() => {
    setShutdownNotice(undefined);
    vi.useRealTimers();
  });

  it("the heartbeat frame carries the notice once set; the closed card does not", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        // Mid-run: the drain announces the restart, then a heartbeat tick passes.
        setShutdownNotice("\u23f8 deploy in progress \u2014 this run continues through the bot restart");
        await vi.advanceTimersByTimeAsync(5_000);
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    const live = statuses.filter((s) => s.title.includes("deploy in progress"));
    expect(live.length).toBeGreaterThan(0);
    expect(live[0].title).toMatch(/^[\u25d0\u25d3\u25d1\u25d2] .* \u00b7 \u23f8 deploy in progress/u);
    const closed = statuses.at(-1)!;
    expect(closed.title).toMatch(/^\u2705/);
    expect(closed.title).not.toContain("deploy in progress");
  });

  it("no notice set (the normal case): heartbeat frames are unchanged", async () => {
    vi.useFakeTimers();
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        await vi.advanceTimersByTimeAsync(5_000);
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(statuses.some((s) => /^[\u25d0\u25d3\u25d1\u25d2] /u.test(s.title))).toBe(true);
    expect(statuses.every((s) => !s.title.includes("deploy in progress"))).toBe(true);
  });
});

// Feature: docs/reference/specs/run-visibility.md item 2 — the live card's title suffix
// tells model time from tool time: a `pnpm typecheck` in flight for an hour
// must never render as `thinking (3601s since last tool)`.
describe("in-flight tool label on the live status card", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  it("a tool running past 20 s is labelled `running bash (Ns)` on the heartbeat frames — never `thinking` — and the label returns to thinking once its result is in", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    let calls = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (calls++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "pnpm typecheck" } }],
            stopReason: "tool_use",
          };
        }
        await vi.advanceTimersByTimeAsync(25_000); // model time after the result: heartbeats tick past 20 s
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { io, statuses } = fakeIO();
    const fake = {
      exec: async () => {
        await vi.advanceTimersByTimeAsync(30_000); // the tool runs for 30 s: heartbeats tick past 20 s
        return "ok";
      },
      readFile: async () => "",
      writeFile: async () => "",
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);

    const running = statuses.flatMap((s, i) => (/ — running bash \(\d+s\)/u.test(s.title) ? [i] : []));
    const thinking = statuses.flatMap((s, i) => (/ — thinking \(\d+s since last tool\)/u.test(s.title) ? [i] : []));
    expect(running.length).toBeGreaterThan(0);
    expect(thinking.length).toBeGreaterThan(0);
    // Every running frame precedes every thinking frame: while the tool was in
    // flight the card never claimed the model was thinking.
    expect(Math.max(...running)).toBeLessThan(Math.min(...thinking));
    for (const i of running) expect(statuses[i].title).not.toMatch(/thinking/);
    // The closed card carries neither suffix.
    expect(statuses.at(-1)!.title).toMatch(/^✅/);
    expect(statuses.at(-1)!.title).not.toMatch(/running bash|thinking/);
  });
});

// Feature: docs/reference/specs/self-improvement.md item 7 + docs/reference/specs/live-view.md item 13
// — `friction report|propose` are RUNS \u2014 a registry record (input \u2192
// answer), listed on /runs, with a receipt to the channel \u2014 so a scheduled
// firing arriving through /ingress as `http:cron` leaves the same trace as
// any other run. Agent runs report a receipt too. Config replies do not.
describe("inline command runs + run receipts", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function receiptIO() {
    const base = fakeIO();
    const receipts: RunReceipt[] = [];
    base.io.runFinished = (r) => void receipts.push(r);
    return { ...base, receipts };
  }

  function sequentialRegistry(prefix: string) {
    let i = 0;
    return new RunRegistry({ genId: () => `${prefix}-${++i}`, genToken: () => "tok" });
  }

  it("`friction report` is a run: input + answer events, finished, labeled, receipt `completed`", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, { ...msg("friction report"), channelName: "cron", userName: "cron" }, io);

    const snap = deps.runRegistry.snapshot("fr-1", "tok")!;
    expect(snap.finished).toBe(true);
    // A command run's content: the request, its meta (agent `command`, the
    // trace id, no model), the answer — around `run.command` and the reply's spans.
    expect(contentOf(snap.events).map((e) => e.type)).toEqual(["input", "run_meta", "answer"]);
    expect(runShapeOf(snap.events)).toEqual([
      "+request",
      "input",
      "run_meta",
      "+run.command",
      "-run.command",
      "answer",
      "+post.reply",
      "-post.reply",
    ]);
    // A channel with no message id (the test's fake) names the request by the run id.
    expect(contentOf(snap.events)[0]).toMatchObject({ type: "input", messageId: "fr-1", text: "friction report" });
    expect(answerOf(snap.events)).toMatchObject({ type: "answer", text: replies[0] });
    expect(deps.runRegistry.listActive()[0].label).toBe('friction \u00b7 #cron \u00b7 cron \u00b7 "friction report"');
    expect(receipts).toEqual([{ id: "fr-1", status: "completed" }]);
  });

  it("`friction report --min-runs 2` is the same run (input + answer, receipt) — a run is about the work, not the syntax", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.runRegistry = sequentialRegistry("fr");
    const { invoked } = wireCommands(deps);
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, msg("friction report --min-runs 2"), io);
    expect(invoked).toEqual(["friction.report"]);
    const snap = deps.runRegistry.snapshot("fr-1", "tok")!;
    expect(snap.finished).toBe(true);
    expect(contentOf(snap.events)).toEqual([
      expect.objectContaining({ type: "input", messageId: "fr-1", text: "friction report --min-runs 2" }),
      expect.objectContaining({ type: "run_meta", agent: "command" }),
      expect.objectContaining({ type: "answer", text: replies[0] }),
    ]);
    expect(receipts).toEqual([{ id: "fr-1", status: "completed" }]);
  });

  it("a refused `friction propose` (non-admin, no friction:write grant) is a run that finished `failed`; the \ud83d\udeab reply is its answer", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, { ...msg("friction propose"), userId: "http:cron", channelId: "http:cron" }, io);
    expect(replies[0]).toMatch(/^\ud83d\udeab/);
    expect(receipts).toEqual([{ id: "fr-1", status: "failed" }]);
    expect(answerOf(deps.runRegistry.snapshot("fr-1", "tok")!.events)).toMatchObject({
      type: "answer",
      text: replies[0],
    });
  });

  it("`http:cron` granted friction:write may `friction propose` \u2014 the run completes", async () => {
    const deps = makeDeps(
      YAML_FIXTURE.replace(
        "grants:\n",
        'selfImprovement:\n  repo: o/r\ngrants:\n  "http:cron": { actions: [friction:write] }\n',
      ),
      capturingProvider(),
    );
    deps.frictionLedger = new InMemoryFrictionLedger();
    deps.issueTracker = new InMemoryIssueTracker();
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, { ...msg("friction propose"), userId: "http:cron", channelId: "http:cron" }, io);
    expect(replies[0]).toContain("0 runs analyzed");
    expect(receipts).toEqual([{ id: "fr-1", status: "completed" }]);
  });

  it("a firing while a previous firing is still in flight: two concurrent commands \u2192 two distinct runs, two receipts", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    deps.frictionLedger = {
      recent: async () => {
        await gate;
        return [];
      },
    };
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry; bound after the ledger/tracker are set
    const a = receiptIO();
    const b = receiptIO();
    const both = Promise.all([
      dispatch(deps, msg("friction report"), a.io),
      dispatch(deps, msg("friction report"), b.io),
    ]);
    await new Promise((r) => setTimeout(r, 0)); // let both dispatches reach the ledger read (each awaits the repo-command check first)
    expect(deps.runRegistry.listActive().map((r) => [r.id, r.finished])).toEqual([
      ["fr-2", false],
      ["fr-1", false],
    ]);
    release();
    await both;
    expect(a.receipts).toEqual([{ id: "fr-1", status: "completed" }]);
    expect(b.receipts).toEqual([{ id: "fr-2", status: "completed" }]);
  });

  it("a command that throws still finishes its run as `failed`, then the error reaches the dispatcher's handler", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.frictionLedger = {
      recent: async () => {
        throw new Error("ledger exploded");
      },
    };
    deps.runRegistry = sequentialRegistry("fr");
    wireCommands(deps); // friction.* lives on the registry; bound after the ledger/tracker are set
    const { io, replies, receipts } = receiptIO();
    await dispatch(deps, msg("friction report"), io);
    expect(deps.runRegistry.listActive()[0].finished).toBe(true);
    expect(receipts).toEqual([{ id: "fr-1", status: "failed" }]);
    expect(replies.join("\n")).toContain("ledger exploded");
    // The record explains the `failed` status: the error reply is its answer,
    // byte-identical to what the channel got (the reply is a projection of it).
    const snap = deps.runRegistry.snapshot("fr-1", "tok")!;
    expect(contentOf(snap.events).map((e) => e.type)).toEqual(["input", "run_meta", "answer"]);
    expect(answerOf(snap.events)).toMatchObject({ type: "answer", text: "⚠️ `friction report`: ledger exploded" });
    expect(replies).toEqual(["⚠️ `friction report`: ledger exploded"]);
  });

  it("an agent run reports its receipt (`completed`) with the registry's run id, after the run is finished", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runRegistry = sequentialRegistry("agent");
    const { io, receipts } = receiptIO();
    let finishedAtReceipt: boolean | undefined;
    io.runFinished = (r) => {
      receipts.push(r);
      finishedAtReceipt = deps.runRegistry!.listActive()[0].finished;
    };
    await dispatch(deps, msg("hello there"), io);
    expect(receipts).toEqual([{ id: "agent-1", status: "completed" }]);
    expect(finishedAtReceipt).toBe(true);
  });

  it("a config reply (`help`) creates no run and no receipt", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runRegistry = sequentialRegistry("cfg");
    const { io, receipts } = receiptIO();
    await dispatch(deps, msg("help"), io);
    expect(deps.runRegistry.listActive()).toEqual([]);
    expect(receipts).toEqual([]);
  });
});

// Feature: docs/reference/specs/run-visibility.md \u2014 the exchange in the run stream:
// the stream carries the full exchange \u2014 the request (`input`), the thread
// context fed to the model (`context`), the reply (`answer`) \u2014 as redacted,
// uncapped events, so the live page and the run record show what the model saw
// and said, never a secret, never an attachment body.
describe("input / context / answer events in the run stream", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(makeExecutor).mockClear();
  });

  type TextEvent = Extract<RunEvent, { type: "input" | "context" | "answer" }>;
  const textEventsOf = (events: RunEvent[]) =>
    events.filter((e): e is TextEvent => e.type === "input" || e.type === "context" || e.type === "answer");
  const contextOf = (events: RunEvent[]) => textEventsOf(events).filter((m) => m.type === "context");
  const inputOf = (events: RunEvent[]) => textEventsOf(events).find((m) => m.type === "input");

  function registryFor(id = "run-m") {
    return new RunRegistry({ genId: () => id, genToken: () => "tok" });
  }
  async function runWith(
    text: string,
    opts: { history?: HistoryItem[]; yaml?: string; message?: Partial<Parameters<typeof dispatch>[1]> } = {},
  ) {
    const registry = registryFor();
    const deps = makeDeps(opts.yaml ?? YAML_FIXTURE, capturingProvider());
    deps.runRegistry = registry;
    const { io, replies } = fakeIO(opts.history ?? []);
    await dispatch(deps, { ...msg(text), ...opts.message }, io);
    const snap = registry.snapshot("run-m", "tok");
    if (!snap) throw new Error("run not in registry");
    return { events: snap.events, replies, snap };
  }

  it("the answer is in the registry snapshot (published BEFORE finish \u2014 a post-finish publish would be dropped), after the request", async () => {
    const { events, snap } = await runWith("hello there");
    expect(snap.finished).toBe(true);
    const types = textEventsOf(events).map((m) => m.type);
    expect(types).toEqual(["input", "answer"]);
    expect(textEventsOf(events)[0].text).toBe("hello there");
    expect(textEventsOf(events)[1].text).toBe("answer");
    // every event is seq-stamped in publish order
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("a 20 KB request is published whole \u2014 the record is the source of truth, no publish-time cap", async () => {
    const { events } = await runWith("a".repeat(20_000));
    expect(inputOf(events)?.text).toBe("a".repeat(20_000));
  });

  it("a PEM block, a multi-line .env paste and a JSON password inside a 16 KB message never reach the stream", async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----`;
    const env = `PORT=3000\nDATABASE_PASSWORD=hunter2hunter2\nSLACK_TOKEN=xoxb-1234567890-abcdefghij\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY`;
    const json = `{"password":"correct-horse-battery"}`;
    const pad = "lorem ipsum ".repeat(1300); // \u2248 15.6 KB of filler so the secrets sit inside a near-cap message
    const { events } = await runWith(`${pem}\n${env}\n${json}\n${pad}`);
    const dump = JSON.stringify(events);
    for (const leak of [
      "MIIEowIBAAKCAQEA7",
      "hunter2hunter2",
      "xoxb-1234567890-abcdefghij",
      "wJalrXUtnFEMIK7MDENGbPxRfiCY",
      "correct-horse-battery",
    ]) {
      expect(dump).not.toContain(leak);
    }
    expect(dump).toContain("\u00abredacted-private-key\u00bb");
    expect(dump).toContain("PORT=3000"); // ordinary config survives
  });

  it("attachments become metadata (name/mime/size lines in context, a count suffix on the request): no base64 and no file body in any event", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    const body = "SELECT * FROM secrets_table_contents;";
    const history: HistoryItem[] = [
      { role: "user", text: "look at this", images: [{ mediaType: "image/png", data: base64, name: "shot.png" }] },
      { role: "assistant", text: "I see a chart." },
    ];
    const { events } = await runWith("and this file", {
      history,
      message: { documents: [{ mediaType: "text/plain", data: body, name: "query.sql" }] },
    });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(base64);
    expect(dump).not.toContain(body);
    const ctx = contextOf(events);
    expect(ctx).toHaveLength(2);
    expect(ctx[0].text).toContain("look at this");
    expect(ctx[0].text).toMatch(/shot\.png.*image\/png.*\d+ bytes/);
    expect(ctx[1].text).toContain("I see a chart.");
    expect(inputOf(events)?.text).toBe("and this file [+1 document]");
  });

  it("a 50-message thread yields at most 20 context events (the newest) within 256 KB total", async () => {
    const history: HistoryItem[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i} ` + "x".repeat(20_000),
    }));
    const { events } = await runWith("now", { history });
    const ctx = contextOf(events);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.length).toBeLessThanOrEqual(20);
    const total = ctx.reduce((n, m) => n + Buffer.byteLength(m.text, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(256 * 1024);
    // The newest turns are the ones kept, in thread order, each prefixed with its role.
    expect(ctx[ctx.length - 1].text.startsWith("assistant: turn 49 ")).toBe(true);
    const nums = ctx.map((m) => Number(/^(?:user|assistant): turn (\d+) /.exec(m.text)?.[1]));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  }, 20_000);

  it("`runHistory.includeContext: false` suppresses context events; the request and answer still flow", async () => {
    const history: HistoryItem[] = [
      { role: "user", text: "earlier" },
      { role: "assistant", text: "reply" },
    ];
    const off = await runWith("now", { history, yaml: `${YAML_FIXTURE}\nrunHistory:\n  includeContext: false\n` });
    expect(textEventsOf(off.events).map((m) => m.type)).toEqual(["input", "answer"]);
    const on = await runWith("now", { history });
    // The request leads the record; the context it was asked against follows it.
    expect(textEventsOf(on.events).map((m) => m.type)).toEqual(["input", "context", "context", "answer"]);
  });

  it("input and context text is humanized before publish: Slack `<url|label>`/`<url>`/mention/channel markup unwrapped and `&amp; &lt; &gt;` unescaped once; the answer is untouched", async () => {
    const history: HistoryItem[] = [{ role: "user", text: "earlier: 1 &lt; 2 &amp;&amp; <@U777|dana> in <#C9|dev>" }];
    const { events } = await runWith(
      "<https://github.com/o/r/pull/1|github.com/o/r/pull/1> please review &amp; fix <@U123> in <#C1|general>, see <https://example.com/x> &lt;now&gt;",
      { history },
    );
    const [input, context, answer] = textEventsOf(events);
    expect(input.type).toBe("input");
    expect(context.type).toBe("context");
    expect(answer.type).toBe("answer");
    expect(context.text).toBe("user: earlier: 1 < 2 && @dana in #dev");
    expect(input.text).toBe(
      "https://github.com/o/r/pull/1 please review & fix @user in #general, see https://example.com/x <now>",
    );
    expect(input.text).not.toMatch(/<[^ ]+\|/);
    expect(input.text).not.toMatch(/&(amp|lt|gt);/);
    expect(answer.text).toBe("answer");
  });

  it("humanizing maps mrkdwn bold to Markdown: `*bold*` → `**bold**` on word edges only; globs, arithmetic and code are untouched (item 18)", async () => {
    const { events } = await runWith(
      "*No behavior change.* (*ok*) rm -rf src/*.ts and 2 * 3 * 4 run `echo *x*` then ``` *raw* &amp; ```",
    );
    const [input] = textEventsOf(events);
    // entities are unescaped everywhere (that pass predates this one); emphasis leaves code alone
    expect(input.text).toBe(
      "**No behavior change.** (**ok**) rm -rf src/*.ts and 2 * 3 * 4 run `echo *x*` then ``` *raw* & ```",
    );
  });

  it("humanizing is Slack-only: an `http:` caller's request and context are recorded exactly as dispatched (mrkdwn markup and entities untouched)", async () => {
    const raw = "<https://github.com/o/r/pull/1|github.com/o/r/pull/1> please review &amp; fix <@U123> &lt;now&gt;";
    const history: HistoryItem[] = [{ role: "user", text: "earlier: 1 &lt; 2 <@U777|dana>" }];
    const { events } = await runWith(raw, {
      history,
      message: { channelId: "http:ops", userId: "http:ops", threadKey: "http:ops:1" },
    });
    const [input, context] = textEventsOf(events);
    expect(input.type).toBe("input");
    expect(input.text).toBe(raw);
    expect(context.type).toBe("context");
    expect(context.text).toBe("user: earlier: 1 &lt; 2 <@U777|dana>");
  });

  it("`<url|label>`: Slack's auto-link label (url minus scheme/www./trailing slash) collapses to the full url; a custom label keeps both as `label (url)`", async () => {
    const { events } = await runWith(
      "<https://www.example.com/docs/|example.com/docs> vs <https://example.com/docs|the docs> vs <https://example.com/x|https://example.com/x>",
    );
    expect(inputOf(events)?.text).toBe(
      "https://www.example.com/docs/ vs the docs (https://example.com/docs) vs https://example.com/x",
    );
  });

  it("the model's own answer is never entity-unescaped (it is not Slack mrkdwn)", async () => {
    const registry = registryFor();
    const deps = makeDeps(YAML_FIXTURE, capturingProvider("code: `a &amp;&amp; b`"));
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg("go"), io);
    const snap = registry.snapshot("run-m", "tok")!;
    expect(snap.events.find((e) => e.type === "answer")?.text).toBe("code: `a &amp;&amp; b`");
  });

  it("a multi-line request produces exactly one log line (type/bytes only \u2014 no text), and never touches the card trace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const registry = registryFor();
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("line one\nline two\nline three SECRET_LINE_MARKER"), io);
    const eventLines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[event]"));
    expect(eventLines.filter((l) => l.includes("type=input"))).toHaveLength(1);
    for (const line of eventLines) {
      expect(line).not.toContain("\n");
      expect(line).not.toContain("SECRET_LINE_MARKER");
      expect(line).toMatch(/bytes=\d+/);
    }
    expect(statuses.some((s) => s.detail?.includes("line one"))).toBe(false);
  });
});

// Feature: docs/reference/specs/live-view.md \u2014 one backlog: the dispatcher's
// friction diagnosis is computed from the registry snapshot, not a second ring.
describe("friction diagnosis reads the registry backlog", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  it("the run record's diagnosis — what the friction ledger reads — equals analyzeRunFriction(registry.snapshot(...).events)", async () => {
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ genId: () => "run-f", genToken: () => "tok" });
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    const [rec] = await new RunStoreFrictionLedger(store).recent();
    const snap = registry.snapshot("run-f", "tok");
    expect(snap).not.toBeNull();
    // The record's diagnosis is the finish-site one: over the run's window
    // (the registry row's stamps), so it carries the shape (docs/reference/specs/tracing.md).
    const row = registry.getById("run-f")!;
    expect(rec.diagnosis).toEqual(
      analyzeRunFriction(snap!.events, {
        finished: true,
        window: { start: row.receivedAt ?? row.startedAt, end: row.finishedAt! },
      }),
    );
    expect(rec.diagnosis.shape).toBeDefined();
    expect(rec.diagnosis.eventCount).toBe(3); // the gate's tool_refused note, tool_call, tool_result; the narrative events do not count
  });
});

// Feature: docs/reference/specs/run-history.md — the dispatcher write path:
// the run record is built synchronously at finish (inside the run's try/catch,
// so failed runs take the same path) and handed to the history writer only
// AFTER the reply is sent; the write never delays or fails the reply.
describe("run history write path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(makeExecutor).mockClear();
  });

  type TextEvent = Extract<RunEvent, { type: "input" | "context" | "answer" }>;
  const textEventsOf = (events: RunEvent[]) =>
    events.filter((e): e is TextEvent => e.type === "input" || e.type === "context" || e.type === "answer");

  function toolThenAnswer(onFirst?: () => void): Provider {
    let n = 0;
    return {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          onFirst?.();
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
  }

  function wired(
    provider: Provider,
    over: { registry?: RunRegistry; store?: RunStore; sleep?: (ms: number) => Promise<void>; yaml?: string } = {},
  ) {
    const registry = over.registry ?? new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const store = over.store ?? new InMemoryRunStore();
    const warnings: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: (m) => warnings.push(m),
      onPersisted: (id) => registry.markPersisted(id),
      sleep: over.sleep ?? (async () => {}),
    });
    const deps = makeDeps(over.yaml ?? YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    return { deps, registry, store, writer, warnings };
  }

  it("the record carries where the run came from and what it was last doing (live-view item 21): sourceUrl from the message, activity from the stored events; neither when absent", async () => {
    const { deps, store, writer } = wired(capturingProvider());
    await dispatch(
      deps,
      { ...msg("hello there"), sourceUrl: "https://acme.slack.com/archives/CX/p10", userName: "alice" },
      fakeIO().io,
    );
    await writer.settled();
    const rec = (await store.get("run-h"))!;
    expect(rec.sourceUrl).toBe("https://acme.slack.com/archives/CX/p10");
    expect(rec.userName).toBe("alice");
    expect(rec.activity).toBe(activityOfEvents(rec.events));
    expect(rec.activity).toEqual(expect.any(String));
    expect(isRunRecord(rec)).toBe(true);

    const bare = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-b", genToken: () => "tok" }),
    });
    await dispatch(bare.deps, msg("hello there"), fakeIO().io);
    await bare.writer.settled();
    const bareRec = await bare.store.get("run-b");
    expect(bareRec).not.toHaveProperty("sourceUrl");
    expect(bareRec).not.toHaveProperty("userName");
  });

  it("channel visibility stamp: the run's meta and its record carry what the channel directory says at dispatch — the static default maps the id (slack:C… → unknown, slack:D… → dm, http: → machine); an injected directory is asked once per run; a failing directory stamps `unknown`", async () => {
    const { deps, store, writer, registry } = wired(capturingProvider());
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    expect(registry.getById("run-h")?.channelVisibility).toBe("unknown"); // the fixture speaks in a slack:C… channel
    expect((await store.get("run-h"))!.channelVisibility).toBe("unknown");

    const dm = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-dm", genToken: () => "tok" }),
    });
    await dispatch(dm.deps, { ...msg("hello there"), channelId: "slack:D0AB", threadKey: "slack:D0AB:1" }, fakeIO().io);
    await dm.writer.settled();
    expect((await dm.store.get("run-dm"))!.channelVisibility).toBe("dm");

    const asked: string[] = [];
    const injected = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-i", genToken: () => "tok" }),
    });
    injected.deps.channelDirectory = {
      info: async (id) => (asked.push(id), { visibility: "public" }),
      isMember: async () => "unknown",
    };
    await dispatch(injected.deps, msg("hello there"), fakeIO().io);
    await injected.writer.settled();
    expect(asked).toEqual(["slack:CX"]);
    expect(injected.registry.getById("run-i")?.channelVisibility).toBe("public");
    expect((await injected.store.get("run-i"))!.channelVisibility).toBe("public");

    const failing = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-f", genToken: () => "tok" }),
    });
    failing.deps.channelDirectory = {
      info: async () => {
        throw new Error("slack down");
      },
      isMember: async () => "unknown",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await dispatch(failing.deps, msg("hello there"), fakeIO().io);
    await failing.writer.settled();
    expect((await failing.store.get("run-f"))!.channelVisibility).toBe("unknown");
    expect(
      warn.mock.calls.some(([line]) => String(line).includes("[authz] channel directory failed for slack:CX")),
    ).toBe(true);
  });

  // Feature: docs/reference/specs/authorization.md item 7 — the Slack directory behind
  // the stamp: `conversations.info` decides a `slack:C…` channel's visibility, so
  // a run in a PUBLIC channel is readable by every actor (`member-of`'s public
  // half) while a private channel's or a DM's stays grants-only; one Slack call
  // per channel, however many runs.
  it("Slack directory stamp: a public-channel run is visible to a plain Slack user's run reads, a private-channel or DM run is not; conversations.info is asked once per channel across runs", async () => {
    const info = vi.fn(async ({ channel }: { channel: string }) => ({ channel: { is_private: channel === "CPRIV" } }));
    const directory = new SlackChannelDirectory({ conversations: { info } }, { now: () => 0 });
    const plainUser: Actor = { kind: "user", id: "slack:UIVY", grants: NO_GRANTS };
    const readable = predicateFor(plainUser, "runs:read", "run");
    const records: RunRecord[] = [];
    for (const [id, channel] of [
      ["run-pub", "slack:CPUB"],
      ["run-pub2", "slack:CPUB"],
      ["run-priv", "slack:CPRIV"],
      ["run-dm", "slack:D0AB"],
    ] as const) {
      const w = wired(capturingProvider(), { registry: new RunRegistry({ genId: () => id, genToken: () => "tok" }) });
      w.deps.channelDirectory = directory;
      await dispatch(
        w.deps,
        { ...msg("hello there", "slack:UALICE"), channelId: channel, threadKey: `${channel}:1` },
        fakeIO().io,
      );
      await w.writer.settled();
      records.push((await w.store.get(id))!);
    }
    expect(records.map((r) => r.channelVisibility)).toEqual(["public", "public", "private", "dm"]);
    expect(records.map((r) => matchesPredicate(readable, r))).toEqual([true, true, false, false]);
    expect(info.mock.calls.map(([a]) => a.channel)).toEqual(["CPUB", "CPRIV"]); // cached for the second CPUB run; the DM never asks
  });

  it("a slow channel directory cannot hold a reply: past `channelDirectoryTimeoutMs` the run is stamped `unknown` and proceeds", async () => {
    const { deps, store, writer } = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-slow", genToken: () => "tok" }),
    });
    deps.channelDirectory = { info: () => new Promise(() => {}), isMember: async () => "unknown" }; // never answers
    deps.channelDirectoryTimeoutMs = 20;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { io, replies } = fakeIO();
    // Without the bound this dispatch would never return (the test's own timeout is the proof).
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    expect(replies).toEqual(["answer"]);
    expect((await store.get("run-slow"))!.channelVisibility).toBe("unknown");
    expect(
      warn.mock.calls.some(([line]) =>
        String(line).includes("[authz] channel directory timed out after 20 ms for slack:CX"),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  // The `ChannelDirectory` seam admits implementations that reject (both shipped
  // ones catch internally). A rejection that arrives AFTER the timeout has
  // already stamped `unknown` must be swallowed — never an unhandled rejection —
  // and one that arrives before it stamps `unknown` at once, by the same path.
  it("a directory that rejects AFTER the timeout fired raises no unhandled rejection; the run is already stamped `unknown`", async () => {
    const { deps, store, writer } = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-late", genToken: () => "tok" }),
    });
    deps.channelDirectory = {
      info: () => new Promise((_, reject) => setTimeout(() => reject(new Error("slack down, late")), 60)),
      isMember: async () => "unknown",
    };
    deps.channelDirectoryTimeoutMs = 20;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatch(deps, msg("hello there"), fakeIO().io);
      await writer.settled();
      expect((await store.get("run-late"))!.channelVisibility).toBe("unknown");
      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes("[authz] channel directory timed out after 20 ms for slack:CX"),
        ),
      ).toBe(true);
      await new Promise((r) => setTimeout(r, 120)); // let the late rejection land
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      warn.mockRestore();
    }
  });

  it("a directory that rejects BEFORE the timeout stamps `unknown` at once — the failure path, not the timeout path", async () => {
    const { deps, store, writer } = wired(capturingProvider(), {
      registry: new RunRegistry({ genId: () => "run-early", genToken: () => "tok" }),
    });
    deps.channelDirectory = {
      info: () => new Promise((_, reject) => setTimeout(() => reject(new Error("slack down, early")), 5)),
      isMember: async () => "unknown",
    };
    deps.channelDirectoryTimeoutMs = 500;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    expect(Date.now() - started).toBeLessThan(500);
    expect((await store.get("run-early"))!.channelVisibility).toBe("unknown");
    const lines = warn.mock.calls.map(([l]) => String(l)).filter((l) => l.startsWith("[authz] channel directory"));
    expect(lines).toEqual([
      expect.stringContaining("[authz] channel directory failed for slack:CX — stamping unknown: slack down, early"),
    ]);
    warn.mockRestore();
  });

  it("a completed run ends as one stored record: status completed, eventCount = published count, events include the user and assistant messages, identity fields set", async () => {
    const { deps, store, writer, registry } = wired(capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    const all = await store.list({});
    expect(all).toHaveLength(1);
    const rec = await store.get("run-h");
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("completed");
    // The record carries the window's opening (docs/reference/specs/tracing.md): the same
    // `receivedAt` the registry row has, so every reader's window starts there.
    expect(rec!.receivedAt).toBeDefined();
    expect(rec!.receivedAt).toBe(registry.getById("run-h")!.receivedAt);
    expect(rec!.eventCount).toBe(registry.snapshot("run-h", "tok")!.eventCount);
    expect(rec!.storedEventCount).toBe(rec!.events.length);
    expect(rec!.eventCount).toBe(rec!.events.length);
    expect(rec!.truncated).toBe(false);
    expect(rec!.schema).toBe(2); // the stream carries spans, never `turn` events (docs/reference/specs/tracing.md)
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input", "answer"]);
    expect(textEventsOf(rec!.events)[1].text).toBe("answer");
    expect(rec!.channelId).toBe("slack:CX");
    expect(rec!.userId).toBe("slack:UX");
    expect(rec!.threadKey).toBe("slack:CX:1.0");
    expect(rec!.agent).toBe("general");
    expect(rec!.model).toBe("anthropic/general-model");
    expect(rec!.label).toContain("general");
    expect(rec!.finishedAt).toBeGreaterThanOrEqual(rec!.startedAt);
    expect(rec!.diagnosis).toEqual(
      analyzeRunFriction(rec!.events, {
        finished: true,
        window: { start: rec!.receivedAt ?? rec!.startedAt, end: rec!.finishedAt },
      }),
    );
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(registry.listActive()[0].persisted).toBe(true);
    expect(writer.pending()).toBe(0);
  });

  it("a soft-stopped run is stored as stopped_soft, and the registry summary carries the same status (finish() is handed it)", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const { deps, store, writer } = wired(
      toolThenAnswer(() => registry.requestStop("run-h", "tok", "soft")),
      { registry },
    );
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    expect((await store.get("run-h"))?.status).toBe("stopped_soft");
    expect(registry.getById("run-h")).toMatchObject({
      finished: true,
      status: "stopped_soft",
      finishedAt: expect.any(Number),
    });
  });

  it("a completed run's registry summary says `completed`; a truncated backlog stamps the diagnosis `truncatedInput` (a full one does not)", async () => {
    const full = wired(capturingProvider());
    await dispatch(full.deps, msg("hello there"), fakeIO().io);
    await full.writer.settled();
    expect(full.registry.getById("run-h")?.status).toBe("completed");
    expect("truncatedInput" in (await full.store.get("run-h"))!.diagnosis).toBe(false);

    const registry = new RunRegistry({ genId: () => "run-t", genToken: () => "tok", backlogLimit: 3 });
    const cut = wired(toolThenAnswer(), { registry });
    const history: HistoryItem[] = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i}`,
    }));
    await dispatch(cut.deps, msg("hello there"), fakeIO(history).io);
    await cut.writer.settled();
    const rec = await cut.store.get("run-t");
    expect(rec!.truncated).toBe(true);
    expect(rec!.diagnosis.truncatedInput).toBe(true);
  });

  it("an inline `friction report` run is persisted like an agent run: agent `command`, the caller's identity, status from `ok`, events [input, answer] — the `http:cron` identity holds `friction:read` (a machine identity's text command needs the grant its tool call would, docs/reference/specs/authorization.md)", async () => {
    let n = 0;
    const registry = new RunRegistry({ genId: () => `cmd-${++n}`, genToken: () => "tok" });
    const { deps, store, writer } = wired(capturingProvider(), {
      registry,
      yaml: YAML_FIXTURE.replace("grants:\n", 'grants:\n  "http:cron":\n    actions: [friction:read]\n'),
    });
    deps.frictionLedger = new InMemoryFrictionLedger();
    wireCommands(deps);
    const ok = fakeIO();
    await dispatch(
      deps,
      { ...msg("friction report"), channelId: "http:cron", userId: "http:cron", threadKey: "http:cron:1" },
      ok.io,
    );
    await writer.settled();
    const rec = await store.get("cmd-1");
    expect(rec).toMatchObject({
      id: "cmd-1",
      agent: "command",
      channelId: "http:cron",
      userId: "http:cron",
      threadKey: "http:cron:1",
      status: "completed",
      // the root's start, the channel-visibility pair, input, run_meta, the
      // run.command pair, answer, the post.reply pair (docs/reference/specs/tracing.md)
      eventCount: 10,
      truncated: false,
    });
    expect(rec!.label).toBe('friction · #cron · cron · "friction report"');
    expect(contentOf(rec!.events).map((e) => e.type)).toEqual(["input", "run_meta", "answer"]);
    expect(contentOf(rec!.events)[0]).toMatchObject({ type: "input", messageId: "cmd-1", text: "friction report" });
    expect(answerOf(rec!.events)).toMatchObject({ type: "answer", text: ok.replies[0] });
    expect(registry.getById("cmd-1")).toMatchObject({
      agent: "command",
      channelId: "http:cron",
      status: "completed",
      finishedAt: expect.any(Number),
    });

    // A refused `friction propose` is a persisted `failed` run whose answer is the refusal.
    const denied = fakeIO();
    await dispatch(
      deps,
      { ...msg("friction propose"), channelId: "http:cron", userId: "http:cron", threadKey: "http:cron:1" },
      denied.io,
    );
    await writer.settled();
    const failed = await store.get("cmd-2");
    expect(failed?.status).toBe("failed");
    expect(answerOf(failed!.events)).toMatchObject({ type: "answer", text: denied.replies[0] });
    expect(denied.replies[0]).toMatch(/^\ud83d\udeab/);
  });

  it("a provider throw yields status failed, the record is still written, and the failure reply is still sent", async () => {
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        throw new Error("provider exploded");
      },
    };
    const { deps, store, writer } = wired(provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("failed");
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input"]);
    expect(replies.some((r) => r.includes("provider exploded"))).toBe(true);
    expect(activeRunCount()).toBe(0);
  });

  it("a reply that throws after the run loop completed yields status failed (not completed) and seals the run once with replyOk false; a stop keeps its stopped_* status", async () => {
    const sealing = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const sealSpy = vi.spyOn(sealing, "seal");
    const { deps, store, writer } = wired(capturingProvider(), { registry: sealing });
    const { io } = fakeIO();
    const throwing: ChannelIO = {
      ...io,
      reply: async () => {
        throw new Error("slack is down");
      },
    };
    await dispatch(deps, msg("hello there"), throwing);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("failed");
    expect(rec?.replyOk).toBe(false); // the first reply attempt threw
    expect(rec?.sealedAt).toBeGreaterThanOrEqual(rec!.finishedAt);
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input", "answer"]); // the loop did finish
    expect(activeRunCount()).toBe(0);
    // Sealed once with the reply's outcome (the writer re-reads the result; the
    // error reply's wrap and the backstop find nothing left to seal).
    expect(sealSpy.mock.calls.filter(([, o]) => o?.replyOk !== undefined)).toEqual([["run-h", { replyOk: false }]]);
    expect(sealing.getById("run-h")).toMatchObject({ finished: true, replyOk: false, status: "completed" });
    expect(await store.get("run-h")).toMatchObject({ sealedAt: sealing.getById("run-h")!.sealedAt });

    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const stopped = wired(
      toolThenAnswer(() => registry.requestStop("run-h", "tok", "soft")),
      { registry },
    );
    await dispatch(stopped.deps, msg("hello there"), throwing);
    await stopped.writer.settled();
    expect((await stopped.store.get("run-h"))?.status).toBe("stopped_soft");
  });

  it("a delivered run is sealed after its reply with replyOk true, and the record and the registry row carry the same sealedAt", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const { deps, store, writer } = wired(capturingProvider(), { registry });
    const { io } = fakeIO();
    let sealedDuringReply: number | undefined;
    const observing: ChannelIO = {
      ...io,
      reply: async (t) => {
        sealedDuringReply = registry.getById("run-h")?.sealedAt;
        return io.reply(t);
      },
    };
    await dispatch(deps, msg("hello there"), observing);
    await writer.settled();
    expect(sealedDuringReply).toBeUndefined(); // the seal comes after the reply, never before
    const row = registry.getById("run-h")!;
    expect(row).toMatchObject({ finished: true, replyOk: true });
    const rec = await store.get("run-h");
    expect(rec).toMatchObject({ status: "completed", replyOk: true, sealedAt: row.sealedAt });
    expect(rec!.sealedAt).toBeGreaterThanOrEqual(rec!.finishedAt);
  });

  it("the record and the friction row carry the registry's redacted label — a pasted token in the request never reaches either", async () => {
    const { deps, store, writer } = wired(capturingProvider());
    await dispatch(deps, msg("please rotate ghp_abcdefghijklmnopqrstuvwxyz0123 now"), fakeIO().io);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec!.label).toContain("«redacted-github-token»");
    expect(rec!.label).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    const [row] = await new RunStoreFrictionLedger(store).recent();
    expect(row.label).toContain("«redacted-github-token»");
    expect(row.label).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(JSON.stringify(await store.list({}))).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("a reply slower than the registry TTL: the finished run stays unsealed (readable, its stream open) through the reply, is sealed after it with replyOk true, and its full record carries the seal; the TTL then runs from the seal", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok", ttlMs: 10 });
    const { deps, store, writer } = wired(toolThenAnswer(), { registry });
    const { io, replies } = fakeIO();
    let unsealedDuringReply: boolean | undefined;
    const slow: ChannelIO = {
      ...io,
      reply: async (t) => {
        await new Promise((r) => setTimeout(r, 40));
        unsealedDuringReply =
          registry.getById("run-h")?.finished === true && registry.getById("run-h")?.sealedAt === undefined;
        replies.push(t);
      },
    };
    await dispatch(deps, msg("hello there"), slow);
    await writer.settled();
    expect(unsealedDuringReply).toBe(true); // the 15-minute hold, not the TTL, governs a finished-unsealed run
    const row = registry.getById("run-h");
    expect(row).toMatchObject({ finished: true, replyOk: true });
    expect(row!.sealedAt).toBeGreaterThanOrEqual(row!.finishedAt!);
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("completed");
    expect(rec).toMatchObject({ sealedAt: row!.sealedAt, replyOk: true });
    await new Promise((r) => setTimeout(r, 15));
    expect(registry.snapshot("run-h", "tok")).toBeNull(); // evicted at sealedAt + TTL
    expect(textEventsOf(rec!.events).map((m) => m.type)).toEqual(["input", "answer"]);
    expect(rec!.events.length).toBeGreaterThan(2);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  it("more published events than the backlog holds: eventCount is the published total, storedEventCount the backlog length, truncated true — and the protected head (input, context, run_meta) is what survives, with the newest events after it", async () => {
    // The head — the root's start, the setup spans, the input, 12 context turns,
    // the run meta — is about 30 events; a 36-event backlog leaves room for a
    // few of the run's own, so the trim drops from after the head.
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok", backlogLimit: 36 });
    const { deps, store, writer } = wired(toolThenAnswer(), { registry });
    const history: HistoryItem[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `turn ${i}`,
    }));
    await dispatch(deps, msg("hello there"), fakeIO(history).io);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec!.eventCount).toBeGreaterThan(rec!.storedEventCount);
    expect(rec!.eventCount).toBe(registry.snapshot("run-h", "tok")!.eventCount);
    expect(rec!.storedEventCount).toBe(rec!.events.length);
    expect(rec!.truncated).toBe(true);
    // The head is intact: the root, the setup spans, the input, the meta, every context turn.
    const headEnd = rec!.events.findIndex((e) => !isHeadMaterial(e));
    expect(headEnd).toBeGreaterThan(27);
    expect(shapeOf(rec!.events)[0]).toBe("+request");
    const head = rec!.events.slice(0, headEnd);
    expect(head.filter((e) => e.type === "context")).toHaveLength(12);
    expect(head.some((e) => e.type === "input")).toBe(true);
    expect(head.some((e) => e.type === "run_meta")).toBe(true);
    // The middle went (the loop's opening span), the newest survive (the answer and the post spans).
    expect(rec!.events.some((e) => e.type === "span_start" && e.name === "run.agent")).toBe(false);
    expect(rec!.events.some((e) => e.type === "answer")).toBe(true);
    expect(rec!.events.at(-1)).toMatchObject({ type: "span_end", name: "post.reply" });
  });

  it("the record's events equal the registry snapshot taken at finish, even though the record is assembled after the reply", async () => {
    const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
    const { deps, store, writer } = wired(toolThenAnswer(), { registry });
    const { io } = fakeIO();
    let snapAtReply: RunEvent[] | undefined;
    const observing: ChannelIO = {
      ...io,
      reply: async () => {
        // The run has finished (the reply comes after finish) and the finish
        // record is not written yet — only the start-of-run tombstone.
        snapAtReply = registry.snapshot("run-h", "tok")!.events;
        expect((await store.get("run-h"))?.status).toBe("interrupted");
      },
    };
    await dispatch(deps, msg("hello there"), observing);
    await writer.settled();
    const rec = await store.get("run-h");
    expect(rec?.status).toBe("completed"); // a throw inside the observing reply would have made it `failed`
    expect(snapAtReply).toBeDefined();
    expect(snapAtReply!.length).toBeGreaterThan(2);
    // The record is the snapshot at finish plus the seal delta: the reply's
    // own span end, which landed after the reply returned (docs/reference/specs/tracing.md).
    expect(rec!.events.slice(0, snapAtReply!.length)).toEqual(snapAtReply);
    expect(rec!.events.slice(snapAtReply!.length).map((e) => (e.type === "span_end" ? `-${e.name}` : e.type))).toEqual([
      "-post.reply",
    ]);
    expect(rec!.storedEventCount).toBe(rec!.events.length);
  });

  it("the finish write happens after the reply: only the provisional tombstone has been put when io.reply runs", async () => {
    let putsAtReply = -1;
    const puts: RunRecord[] = [];
    const store = {
      put: async (r: RunRecord) => {
        puts.push(r);
        return { ok: true as const, retained: 1, stored: true, rewritten: false };
      },
    } as unknown as RunStore;
    const { deps, writer } = wired(toolThenAnswer(), { store });
    const { io } = fakeIO();
    const observing: ChannelIO = {
      ...io,
      reply: async () => {
        putsAtReply = puts.length;
      },
    };
    await dispatch(deps, msg("hello there"), observing);
    await writer.settled();
    expect(putsAtReply).toBe(1); // the start-of-run tombstone, never the finish record
    expect(puts.map((p) => p.status)).toEqual(["interrupted", "completed"]);
  });

  it("put 503 twice then 200: exactly one record, pending back to 0, no failure counted", async () => {
    const inner = new InMemoryRunStore();
    let fails = 2;
    const store = {
      put: async (r: RunRecord) => {
        if (fails-- > 0) throw new TransientStoreError("run store /runs/put HTTP 503");
        return inner.put(r);
      },
      list: (o: Parameters<RunStore["list"]>[0]) => inner.list(o),
    } as unknown as RunStore;
    const { deps, writer } = wired(toolThenAnswer(), { store });
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await writer.settled();
    expect(await inner.list({})).toHaveLength(1);
    expect(writer.pending()).toBe(0);
    expect(writer.failures()).toBe(0);
  });

  it("a 413 (PermanentStoreError) is not retried: one attempt, one warn, failures +1; the reply is unaffected", async () => {
    let attempts = 0;
    const store = {
      put: async () => {
        attempts++;
        throw new PermanentStoreError("run store /runs/put HTTP 413");
      },
    } as unknown as RunStore;
    const { deps, writer, warnings } = wired(toolThenAnswer(), { store });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    expect(attempts).toBe(2); // tombstone + finish record: one un-retried attempt each
    expect(warnings).toHaveLength(2);
    expect(writer.failures()).toBe(2);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    expect(replies.some((r) => r.includes("413"))).toBe(false);
  });

  it("a 404 (RouteMissingError) logs once, is not retried, sets degraded; the runs are still counted", async () => {
    let attempts = 0;
    const store = {
      put: async () => {
        attempts++;
        throw new RouteMissingError("run store /runs/put HTTP 404");
      },
    } as unknown as RunStore;
    const { deps, writer, warnings } = wired(toolThenAnswer(), { store });
    await dispatch(deps, msg("hello there"), fakeIO().io);
    await dispatch(deps, msg("hello again"), fakeIO().io);
    await writer.settled();
    // The fixture registry mints ONE id for both runs (unique in production),
    // so the second tombstone is dropped by final-beats-provisional — that id's
    // final record was already enqueued: tombstone + finish, finish.
    expect(attempts).toBe(3);
    expect(writer.degraded()).toBe(true);
    expect(writer.failures()).toBe(3);
    expect(warnings.filter((w) => w.includes("state Worker has no /runs/put"))).toHaveLength(1);
  });

  it("without a writer nothing is written and the run behaves as before", async () => {
    const deps = makeDeps(YAML_FIXTURE, toolThenAnswer());
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("hello there"), io);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
  });

  describe("tombstone-first provisional records", () => {
    it("a provisional interrupted record is written at run start — finishedAt = startedAt, the request/context events — and the finish write replaces it", async () => {
      const inner = new InMemoryRunStore();
      const puts: RunRecord[] = [];
      const store = {
        put: async (r: RunRecord) => {
          puts.push(r);
          return inner.put(r);
        },
        get: (id: string) => inner.get(id),
        list: (o: Parameters<RunStore["list"]>[0]) => inner.list(o),
      } as unknown as RunStore;
      const { deps, writer } = wired(toolThenAnswer(), { store });
      const history: HistoryItem[] = [{ role: "user", text: "earlier turn" }];
      await dispatch(
        deps,
        { ...msg("hello there"), sourceUrl: "https://acme.slack.com/archives/CX/p10", userName: "alice" },
        fakeIO(history).io,
      );
      await writer.settled();

      expect(puts.map((p) => p.status)).toEqual(["interrupted", "completed"]);
      const tomb = puts[0];
      expect(tomb.id).toBe("run-h");
      expect(tomb.finishedAt).toBe(tomb.startedAt); // provisional: nobody knows a crash's real death time
      expect(runShapeOf(tomb.events)).toEqual(["+request", "input", "run_meta", "context"]);
      expect(tomb).toMatchObject({
        agent: "general",
        model: "anthropic/general-model",
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        sourceUrl: "https://acme.slack.com/archives/CX/p10",
        userName: "alice",
        truncated: false,
      });
      expect(isRunRecord(tomb)).toBe(true);

      // The finish write is an upsert of the SAME id: the store holds one row, the final record.
      expect(await inner.list({})).toHaveLength(1);
      const rec = (await inner.get("run-h"))!;
      expect(rec.status).toBe("completed");
      expect(rec.events.map((e) => e.type)).toContain("answer");
      expect(rec.finishedAt).toBeGreaterThanOrEqual(rec.startedAt);
    });

    it("the provisional write never marks the run persisted: a run whose finish write is lost keeps `persisted` unset", async () => {
      const registry = new RunRegistry({ genId: () => "run-h", genToken: () => "tok" });
      let n = 0;
      const store = {
        put: async () => {
          // The tombstone put succeeds; the finish put is permanently lost.
          if (++n === 2) throw new PermanentStoreError("run store /runs/put HTTP 413");
          return { ok: true as const, retained: 1, stored: true, rewritten: false };
        },
      } as unknown as RunStore;
      const { deps, writer } = wired(toolThenAnswer(), { registry, store });
      await dispatch(deps, msg("hello there"), fakeIO().io);
      await writer.settled();
      expect(n).toBe(2);
      expect(registry.getById("run-h")).not.toHaveProperty("persisted"); // the tombstone's success set nothing
      expect(writer.failures()).toBe(1);
    });
  });
});

// Feature: docs/reference/specs/command-registry.md (chat adapter) / docs/reference/specs/routing-and-config.md
// item 10 — the registry chat parse is the LAST text-only fast path:
// as the whole of stage A, before io.history()/recognizeOperation. EVERY
// chat command is registry-owned; the adapter is the only chat parser.
describe("registry chat commands in the fast-path chain", () => {
  function withCommands(deps: TestDeps) {
    const reg = new RunRegistry({ genId: () => "live0001", genToken: () => "tok-secret" });
    reg.create("coding · acme/api <!channel>", {
      agent: "coding",
      channelId: "slack:D0PRIV",
      userId: "slack:UOWNER",
      threadKey: "slack:D0PRIV:t",
    });
    deps.runRegistry = reg;
    return wireCommands(deps);
  }

  it("`runs list` from an admin replies inline with the compact list — no model turn, no history fetch, no identifying fields", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const { io, replies } = fakeIO();
    const history = vi.fn(io.history);
    io.history = history;
    await dispatch(deps, msg("runs list --status active", "slack:UADMIN"), io);
    expect(invoked).toEqual(["runs.list"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^• `live0001` — coding · active · \d+s$/);
    expect(replies[0]).not.toMatch(/slack:D|UOWNER|<!channel>|tok-secret/);
    expect(provider.requests).toHaveLength(0);
    expect(history).not.toHaveBeenCalled();
  });

  it("`runs list` from a non-admin gets the restricted refusal, never a model turn", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("runs list --status active", "slack:UX"), io);
    expect(replies).toEqual(["🚫 `runs list` is restricted. Ask <@slack:UADMIN>."]);
    expect(provider.requests).toHaveLength(0);
  });

  it("`runs get <id>` is not a chat command (surfaces.chat false): it falls through to the agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const { io } = fakeIO();
    await dispatch(deps, msg("runs get live0001", "slack:UADMIN"), io);
    expect(invoked).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("`friction report --min-runs 2` and `friction report --limit 5` (one grammar, kebab flags) both reach `friction.report` exactly once, for a non-admin", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.frictionLedger = new InMemoryFrictionLedger();
    const { invoked } = withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("friction report --min-runs 2", "slack:UX"), io);
    await dispatch(deps, msg("friction report --limit 5", "slack:UX"), io);
    expect(replies).toEqual([
      "🔍 0 runs analyzed — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs).",
      "🔍 0 runs analyzed — no recurring friction pattern found (a pattern must recur across ≥2 distinct runs).",
    ]);
    expect(invoked).toEqual(["friction.report", "friction.report"]);
    expect(provider.requests).toHaveLength(0);
  });

  it("every repo verb is the registry's: `repo onboard x` is the schema's named refusal (no resident call), `repo onboard acme/api` and `repo list` invoke — the registry's adapter is the only chat parser", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const admin: ResidentAdminClient = {
      onboard: vi.fn(async () => ({ status: 202, data: {} })),
      offboard: vi.fn(async () => ({ status: 200, data: {} })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 200, data: {} })),
      residents: vi.fn(async () => ({ status: 200, data: { cap: 8, count: 0, residents: [] } })),
      status: vi.fn(async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } })),
    };
    deps.residentAdmin = admin;
    const { invoked } = withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo onboard x", "slack:UADMIN"), io);
    expect(replies).toEqual(["⚠️ `repo onboard`: slug: expected a GitHub owner/name slug"]);
    expect(invoked).toEqual(["repo.onboard"]);
    expect(admin.onboard).not.toHaveBeenCalled();
    await dispatch(deps, msg("repo onboard acme/api", "slack:UADMIN"), io);
    expect(admin.onboard).toHaveBeenCalledTimes(1);
    expect(replies[1]).toMatch(/^🏗️ Onboarding `acme\/api` on `main`/);
    // Item 52: the accepted onboard settles (here: warm at the first poll) as a
    // SECOND reply in the thread, off the request path.
    await vi.waitFor(() => expect(replies[2]).toBe("✅ `acme/api` is warm — provisioned and attach-ready."));
    expect(admin.status).toHaveBeenCalledWith("repo:acme/api");
    await dispatch(deps, msg("repo list", "slack:UADMIN"), io);
    expect(invoked).toEqual(["repo.onboard", "repo.onboard", "repo.list"]);
    expect(admin.residents).toHaveBeenCalledTimes(1);
    expect(replies[3]).toBe("No repos onboarded (0/8). Onboard one with `repo onboard <owner/name>`.");
    expect(provider.requests).toHaveLength(0);
  });

  it("item 52: a provisioning that fails after the acknowledgement is reported in the thread with the resident's reason; a dry-run rebuild posts no follow-up", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    const admin: ResidentAdminClient = {
      onboard: vi.fn(async () => ({ status: 202, data: {} })),
      offboard: vi.fn(async () => ({ status: 200, data: {} })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({
        status: 200,
        data: { dryRun: true, from: { state: "warm" }, discards: {}, reprovision: {}, keeps: {} },
      })),
      residents: vi.fn(async () => ({ status: 200, data: { cap: 8, count: 0, residents: [] } })),
      status: vi.fn(async () => ({
        status: 200,
        data: {
          state: "down",
          reason: "provision-failed at install: exit 254: npm error enoent Could not read package.json",
          inFlight: 0,
        },
      })),
    };
    deps.residentAdmin = admin;
    withCommands(deps);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("repo onboard acme/infra", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    await vi.waitFor(() =>
      expect(replies[1]).toBe(
        "❌ `acme/infra` failed to provision: provision-failed at install: exit 254: npm error enoent Could not read package.json\n" +
          'Fix the command table with `repo reconfigure acme/infra --install "…" --build "…" --test "…"`, then `repo rebuild acme/infra`.',
      ),
    );
    await dispatch(deps, msg("repo rebuild acme/infra --dry-run", "slack:UADMIN"), io);
    expect(replies[2]).toMatch(/^🧪 \*Dry run\*/);
    await new Promise((r) => setTimeout(r, 20));
    expect(replies).toHaveLength(3);
    expect(admin.status).toHaveBeenCalledTimes(1);
  });

  it("a mutating repo verb is an inline run with a receipt; `repo list` and a usage reply are not", async () => {
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.residentAdmin = {
      onboard: vi.fn(async () => ({ status: 202, data: {} })),
      offboard: vi.fn(async () => ({ status: 200, data: { registryRemoved: true } })),
      reconfigure: vi.fn(async () => ({ status: 200, data: {} })),
      rebuild: vi.fn(async () => ({ status: 200, data: {} })),
      residents: vi.fn(async () => ({ status: 200, data: { cap: 8, count: 0, residents: [] } })),
      status: vi.fn(async () => ({ status: 200, data: { state: "warm", reason: "", inFlight: 0 } })),
    };
    let n = 0;
    deps.runRegistry = new RunRegistry({ genId: () => `repo-${++n}`, genToken: () => "tok" });
    wireCommands(deps);
    const receipts: RunReceipt[] = [];
    const { io } = fakeIO();
    io.runFinished = (r) => void receipts.push(r);
    await dispatch(deps, msg("repo list", "slack:UADMIN"), io);
    await dispatch(deps, msg("repo offboard --nope", "slack:UADMIN"), io);
    expect(receipts).toEqual([]);
    await dispatch(deps, msg("repo offboard acme/api", "slack:UADMIN"), io);
    expect(receipts).toEqual([{ id: "repo-1", status: "completed" }]);
    expect(
      deps.runRegistry.listActive()[0]?.label ?? deps.runRegistry.snapshot("repo-1", "tok")?.events[0],
    ).toBeTruthy();
    await dispatch(deps, msg("repo offboard acme/api", "slack:UX"), io); // refused → a failed run, still a receipt
    expect(receipts[1]).toEqual({ id: "repo-2", status: "failed" });
  });

  it("prose that mentions a command mid-sentence is not a command: it goes to the model", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const { io } = fakeIO();
    await dispatch(deps, msg("can you run runs list for me", "slack:UADMIN"), io);
    expect(invoked).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("the explicit `repo test` form and the natural-language form reach the SAME registry command (`repo.test`), once each; the ops backend runs once per ask", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { invoked } = withCommands(deps);
    const ops = {
      calls: [] as string[],
      async run(op: string) {
        this.calls.push(op);
        return { kind: "result", ok: true, summary: "test passed", output: "" } as const;
      },
    };
    deps.operations = ops as unknown as Operations;
    const { io, replies } = fakeIO();
    const history = vi.fn(io.history);
    io.history = history;
    await dispatch(deps, msg("repo test acme/api main", "slack:UADMIN"), io);
    expect(ops.calls).toEqual(["test"]);
    expect(invoked).toEqual(["repo.test"]);
    expect(history).not.toHaveBeenCalled(); // the explicit form is stage A: no history fetch
    await dispatch(deps, msg("run the tests on main in acme/api", "slack:UADMIN"), io);
    expect(ops.calls).toEqual(["test", "test"]);
    expect(invoked).toEqual(["repo.test", "repo.test"]);
    expect(history).toHaveBeenCalledTimes(1); // natural language needs the thread (stage B)
    await dispatch(deps, msg("runs list --status all", "slack:UADMIN"), io);
    expect(invoked).toEqual(["repo.test", "repo.test", "runs.list"]);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toBe(replies[1]);
    expect(provider.requests).toHaveLength(0);
  });

  it("without a bound command set, every text is ordinary prose: `runs list`, `help`, `config show`, and the natural-language op all go to the model", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.commands = undefined;
    const { io } = fakeIO();
    for (const text of ["runs list --status all", "help", "config show", "run the tests on main in acme/api"])
      await dispatch(deps, msg(text, "slack:UADMIN"), io);
    expect(provider.requests).toHaveLength(4);
  });
});

// Feature: docs/reference/specs/reading-diff.md item 4 — a PR review run publishes ONE
// `review_artifact` reading diff into its own stream (before the answer, so it
// lands in the run record); a coding run never does, and `off` disables it.
describe("reading-diff artifact on review runs", () => {
  function reviewRun(
    env: string | undefined,
    meatExec?: (cmd: string) => Promise<string>,
    ctxOver: Partial<RepoContext> = {},
  ) {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    if (env === undefined) vi.stubEnv("SWITCHBOARD_READING_DIFF", "");
    else vi.stubEnv("SWITCHBOARD_READING_DIFF", env);
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    const deps = makeDeps(REMOTE_YAML_FIXTURE, capturingProvider("looks correct"));
    deps.runRegistry = registry;
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      ref: "patch-1",
      pr: 42,
      headSha: "e".repeat(40),
      baseRef: "main",
      ...ctxOver,
    });
    deps.postReviewComment = vi.fn(async () => {});
    const fake = {
      // The run's executor serves the artifact productions AND the
      // reviewed-head probe — answer each by command.
      exec: async (cmd: string) => {
        if (cmd.startsWith("git diff")) return "diff --git a/f b/f\n+x";
        if (cmd.startsWith("timeout") && cmd.includes("meat"))
          return meatExec ? meatExec(cmd) : "exit 127: meat: command not found";
        return "e".repeat(40);
      },
      readFile: async () => "",
      writeFile: async () => "",
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    return { registry, deps };
  }

  it("a review of a resolved PR publishes a git-powered reading diff before the answer", async () => {
    const { registry, deps } = reviewRun(undefined); // default provider: git
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const events = registry.snapshotById("r1")!.events;
    const artifacts = events.filter((e) => e.type === "review_artifact");
    expect(artifacts).toEqual([
      {
        type: "review_artifact",
        artifact: "reading_diff",
        poweredBy: "git",
        baseRef: "main",
        diff: "diff --git a/f b/f\n+x",
        truncated: false,
        at: expect.any(Number),
        seq: expect.any(Number),
      },
    ]);
    const answerSeq = events.find((e) => e.type === "answer")?.seq ?? -1;
    expect(artifacts[0].seq!).toBeLessThan(answerSeq); // in the record, not after finish
  });

  it("meat provider → the run still records ONLY the git baseline and never runs meat in its executor; the abridging is the host's, after persistence", async () => {
    const commands: string[] = [];
    const { registry, deps } = reviewRun("meat", async (cmd) => {
      commands.push(cmd);
      return JSON.stringify({ smart_diff: "abridged", summary: "s" });
    });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(replies.some((r) => r.includes("looks correct"))).toBe(true); // the review replied
    const artifacts = registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact");
    expect(
      artifacts.map((e) => (e.type === "review_artifact" && e.artifact === "reading_diff" ? e.poweredBy : "?")),
    ).toEqual(["git"]);
    expect(commands).toEqual([]); // no meat command ever reached the run's executor
  });

  it("SWITCHBOARD_READING_DIFF=off → a review publishes no artifact", async () => {
    const { registry, deps } = reviewRun("off");
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact")).toEqual([]);
  });

  it("a coding run publishes no artifact — neither the diff nor the PR description it did not open", async () => {
    const { registry, deps } = reviewRun(undefined, undefined, { prDescription: PR_FACTS });
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:coding fix https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact")).toEqual([]);
  });

  // Feature: docs/reference/specs/reading-diff.md item 7 — beside the diff, a PR review
  // carries the PR's description as data: the object a coding run submitted for
  // the reviewed head when the run store holds one, else the body parsed back.
  const REVIEWED = "e".repeat(40);
  const PR_BODY = [
    "## TL;DR",
    "",
    `Two sentences, one of them holding ghp_${"a".repeat(30)}.`,
    "",
    "## Tour",
    "",
    "### 1. The gate",
    "",
    "Closes on a bad token.",
    "",
    `https://github.com/acme/api/blob/${REVIEWED}/src/gate.ts#L10-L20`,
    "",
    "### 2. Remaining changes",
    "",
    "- none — every touched file is covered by a step above",
  ].join("\n");
  const PR_FACTS = { title: "Fix the gate", body: PR_BODY, truncated: false };
  function storedSubmitted(headSha: string): RunRecord {
    const events: RunEvent[] = [
      {
        type: "review_artifact",
        artifact: "pr_description",
        origin: "submitted",
        repo: "acme/api",
        pr: 42,
        headSha,
        title: "Fix the gate (submitted)",
        body: "## TL;DR\n\nsubmitted",
        tldr: "submitted",
        tour: [
          { title: "The gate", description: "d", anchor: { path: "src/gate.ts", from: 10, to: 20, sha: headSha } },
        ],
        remaining: [],
        decisions: [{ title: "Fail closed", rationale: "safer" }],
        complete: true,
        problems: [],
        truncated: false,
        at: 1,
        seq: 1,
      },
    ];
    return {
      id: "coding-run",
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UADMIN",
      threadKey: "slack:C1:9",
      channelVisibility: "public",
      repo: "acme/api",
      startedAt: Date.now() - 5000, // inside the store's retention window
      finishedAt: Date.now() - 1000,
      status: "completed",
      eventCount: 1,
      storedEventCount: 1,
      truncated: false,
      events: events as RunRecord["events"],
      diagnosis: analyzeRunFriction(events),
    };
  }
  const descriptionArtifacts = (registry: RunRegistry) =>
    registry
      .snapshotById("r1")!
      .events.filter((e) => e.type === "review_artifact" && e.artifact === "pr_description")
      .map((e) => (e.type === "review_artifact" && e.artifact === "pr_description" ? e : undefined)!);

  it("no submitted object in the store → the PR body is parsed into the artifact before the answer, redacted, the reviewed head beside the anchors", async () => {
    const { registry, deps } = reviewRun(undefined, undefined, { prDescription: PR_FACTS });
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const [artifact, ...rest] = descriptionArtifacts(registry);
    expect(rest).toEqual([]);
    expect(artifact).toMatchObject({
      origin: "parsed",
      repo: "acme/api",
      pr: 42,
      headSha: REVIEWED,
      title: "Fix the gate",
      tldr: "Two sentences, one of them holding «redacted-github-token».",
      tour: [
        {
          title: "The gate",
          description: "Closes on a bad token.",
          anchor: { path: "src/gate.ts", from: 10, to: 20, sha: REVIEWED },
        },
      ],
      remaining: [],
      complete: false, // the body has no What & why / Decisions / Risks / Validation
      truncated: false,
    });
    expect(artifact.body).not.toContain("ghp_");
    const events = registry.snapshotById("r1")!.events;
    const answerSeq = events.find((e) => e.type === "answer")?.seq ?? -1;
    expect(artifact.seq!).toBeLessThan(answerSeq); // joined before the answer: in the record
    expect(events.filter((e) => e.type === "review_artifact")).toHaveLength(2); // the diff is still there
  });

  it("the store holds the submitted object for the reviewed head → it is published instead of the parse, re-stamped, naming the coding run", async () => {
    const { registry, deps } = reviewRun(undefined, undefined, { prDescription: PR_FACTS });
    const store = new InMemoryRunStore();
    await store.put(storedSubmitted(REVIEWED));
    deps.runStore = store;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    const [artifact, ...rest] = descriptionArtifacts(registry);
    expect(rest).toEqual([]);
    expect(artifact).toMatchObject({
      origin: "submitted",
      fromRunId: "coding-run",
      title: "Fix the gate (submitted)",
      tldr: "submitted",
      decisions: [{ title: "Fail closed", rationale: "safer" }],
      complete: true,
    });
    expect(artifact.at).not.toBe(1);
  });

  it("the store's submitted object is for ANOTHER head → the body is parsed (anchors at a stale head are not passed off as this head's)", async () => {
    const { registry, deps } = reviewRun(undefined, undefined, { prDescription: PR_FACTS });
    const store = new InMemoryRunStore();
    await store.put(storedSubmitted("d".repeat(40)));
    deps.runStore = store;
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(descriptionArtifacts(registry).map((a) => a.origin)).toEqual(["parsed"]);
  });

  it("no PR facts (the head fetch failed) and nothing stored → the review carries the diff but no description artifact", async () => {
    const { registry, deps } = reviewRun(undefined);
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:review https://github.com/acme/api/pull/42", "slack:UADMIN"), io);
    expect(descriptionArtifacts(registry)).toEqual([]);
    expect(registry.snapshotById("r1")!.events.filter((e) => e.type === "review_artifact")).toHaveLength(1);
  });
});

// Feature: docs/reference/specs/agent-ship.md — the agent:ship pipeline: one dispatch,
// one card, one run record; strictly serial coding → review → fix child
// rounds on clipped budgets; typed artifacts end to end; never a merge.
describe("agent:ship (the hand-off to the plan runner)", () => {
  const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const PR_URL = "https://github.com/acme/api/pull/7";
  const TASK_MSG = "agent:ship in acme/api: fix the login redirect";
  const SHIP_PLAN_ID = generatedPlanId(shipTaskText("in acme/api: fix the login redirect", "acme/api"), "slack:CX:1.0");
  const SHIP_BRANCH = unitBranch(SHIP_PLAN_ID, "u1");

  const SHIP_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    review: anthropic/review-model
    coding: anthropic/coding-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UDEV": { actions: [agent:run:coding] }
  "slack:UREV": { repos: ["acme/api"] }
restrict:
  agents: [coding]
  repos: ["acme/api"]
routing: { auto: false }
workspaceDir: __WORKDIR__
`;

  /** The identity the tests' bot acts as (agent-ship.md item 10) — injected, never a name the code knows. */
  const SHIP_BOT: GithubIdentity = { login: "acme-switchboard[bot]", id: 4242 };
  const openBotPr = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
    state: "open",
    author: { ...SHIP_BOT },
    headRef: SHIP_BRANCH,
    headSha: HEAD_A,
    sameRepoHead: true,
    htmlUrl: PR_URL,
    ...over,
  });

  /** The dispatcher's deps for a ship request: a provider that must never be
   *  asked (the runner's children are runs of their own, none of them here),
   *  the preflight's GitHub facts, and the runner's seams — its records and its
   *  shim — as doubles that remember what was written and created. */
  function shipDeps(yaml = SHIP_YAML) {
    const provider = capturingProvider("never asked");
    const deps = makeDeps(yaml, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    deps.statusUpdateMinMs = 0;
    deps.fetchRepoShipInfo = vi.fn(async () => ({ defaultBranch: "main" }));
    deps.fetchPrFacts = vi.fn(async () => openBotPr());
    const instances = new InMemoryCoordinatorInstanceStore();
    const created: string[] = [];
    deps.coordinatorInstances = instances;
    deps.createCoordinatorInstance = vi.fn(async (id: string) => {
      created.push(id);
      return { kind: "created" as const, id };
    });
    deps.fetchCoordinatorInstanceStatus = vi.fn(async () => ({ kind: "absent" as const }));
    return { deps, provider, instances, created };
  }

  /** The one generated plan instance a request became, with its U1 row — what
   *  the runner is handed. The instance's id is content-derived (`plan-<id>`),
   *  so it is found by the run id stamped on it. */
  async function handed(instances: InMemoryCoordinatorInstanceStore, runId: string) {
    const rows = (instances as unknown as { rows: Map<string, string> }).rows;
    for (const text of rows.values()) {
      const instance = JSON.parse(text) as CoordinatorInstance;
      if (instance.runId === runId) return { instance, unit: (await instances.listUnits(instance.id))[0] };
    }
    return { instance: null, unit: undefined };
  }

  // Every scenario runs under a fetch guard: the branch's GitHub reads go ONLY
  // through the injected typed seams, so any direct network call trips the
  // guard and fails the test. Nothing here may attach a workspace or run a
  // model turn either — the runner's children do that as runs of their own.
  let fetchGuard: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
    fetchGuard = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected network call: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchGuard);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    expect(makeExecutor).not.toHaveBeenCalled();
    expect(runPiHarnessOpen).not.toHaveBeenCalled();
    vi.mocked(makeExecutor).mockReset();
    vi.mocked(runPiHarnessOpen).mockClear();
  });

  it("channel guard: agent:ship over an HTTP/MCP-originated dispatch is refused with a run-page pointer, nothing handed to the runner", async () => {
    const { deps, provider, created } = shipDeps();
    // An unrestricted repo (open-when-absent), so the CHANNEL refusal is the
    // one that fires — not the repo allowlist, which has its own test above.
    deps.resolveRepoContext = () => ({ repo: "acme/web" });
    const { io, replies } = fakeIO();
    await dispatch(
      deps,
      { channelId: "http:ingress", userId: "http:token-ci", threadKey: "http:ingress:t1", text: TASK_MSG },
      io,
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("Slack or the CLI");
    expect(replies[0]).toContain("/runs");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("permission: user allowed ship but not coding → refused naming coding, nothing handed to the runner", async () => {
    const { deps, provider, created } = shipDeps();
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UREV"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("`coding`");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("allowed all three agents but denied the target repo → the dispatcher's repo gate refuses before the fork, nothing handed to the runner", async () => {
    const { deps, provider, created } = shipDeps();
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UDEV"), io); // UDEV: coding-allowed, NOT on acme/api's repo list
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("a failed repository lookup refuses nothing — no auto-merge gate remains; a fresh task with no base lands on the hand-off's own 'no base branch is known' refusal", async () => {
    const { deps, provider, created } = shipDeps();
    deps.fetchRepoShipInfo = vi.fn(async () => undefined);
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toContain("auto-merge");
    expect(replies[0]).not.toContain("could not verify");
    expect(replies[0]).toContain("no base branch is known");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("a task the preflight admits is handed to the runner as a generated one-unit plan instance named by the task and the thread: the U1 row carries the deterministic plan branch off the default branch and no resume, the reply says where it runs, the card closes ✅, no workspace is attached and no model turn runs here", async () => {
    const { deps, provider, instances, created } = shipDeps();
    const registry = new RunRegistry({ genId: () => "run-ship1", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(created).toEqual([`plan-${SHIP_PLAN_ID}`]);
    const { instance, unit } = await handed(instances, "run-ship1");
    expect(instance).toMatchObject({
      kind: "ship",
      userId: "slack:UADMIN",
      channelId: "slack:CX",
      threadKey: "slack:CX:1.0",
      repo: "acme/api",
      branch: SHIP_BRANCH,
      base: "main",
      caps: { maxRounds: 3, maxMinutes: 120 },
      runId: "run-ship1",
    });
    expect(unit).toMatchObject({ unit: "U1", slug: "u1", branch: SHIP_BRANCH, dependsOn: [], rounds: [] });
    expect("resume" in unit!).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toBe(
      `🧭 Handed to the plan runner \`plan-${SHIP_PLAN_ID}\`: plan \`${SHIP_PLAN_ID}\`, 1 unit in dependency order — U1. ` +
        `the unit runs on \`${SHIP_BRANCH}\` in this thread under your grants; this card follows it and the report lands here.`,
    );
    // The instance is marked as a generated plan — an id, no path — and no
    // `ship/…` branch appears anywhere in the hand-off.
    expect(instance?.plan).toEqual({ id: SHIP_PLAN_ID });
    expect(SHIP_BRANCH.startsWith("plan/")).toBe(true);
    for (const r of replies) expect(r).not.toContain("`ship/");
    expect(statuses[statuses.length - 1]!.title).toContain("✅");
    expect(registry.getById("run-ship1")).toMatchObject({ finished: true, status: "completed", agent: "ship" });
    expect(provider.requests).toHaveLength(0);
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  // docs/reference/specs/agent-ship.md item 16 — a task request is a generated
  // one-unit plan: no `ship/…` branch exists anywhere any more.
  it("a task request hands off a `plan-…` instance and no `ship/` branch appears in the reply, the card or the record", async () => {
    const { deps, instances, created } = shipDeps();
    const registry = new RunRegistry({ genId: () => "run-shiprate", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg("agent:ship in acme/api: add a rate limit", "slack:UADMIN"), io);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^plan-add-a-rate-limit-[0-9a-f]{6}$/);
    const { instance, unit } = await handed(instances, "run-shiprate");
    expect(instance?.plan).toEqual({ id: created[0]!.slice("plan-".length) });
    expect(unit?.branch).toBe(`plan/${instance!.plan!.id}/u1`);
    const surfaces = [
      ...replies,
      ...statuses.map((s) => JSON.stringify(s)),
      JSON.stringify(registry.getById("run-shiprate")),
    ];
    for (const text of surfaces) expect(text).not.toContain("ship/");
  });

  it("a channel boundary clips the pipeline's wall clock: the preset's 120 becomes the channel's 10 in the caps handed to the runner, the card names the clip and the record carries the ship profile", async () => {
    const { deps, instances } = shipDeps(SHIP_YAML + 'channels:\n  "slack:CX":\n    boundary:\n      maxMinutes: 10\n');
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ genId: () => "run-shipb", genToken: () => "tok" });
    deps.runRegistry = registry;
    deps.runHistoryWriter = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    await deps.runHistoryWriter.settled();
    expect(replies[0]).toContain("Handed to the plan runner");
    expect((await handed(instances, "run-shipb")).instance?.caps).toEqual({ maxRounds: 3, maxMinutes: 10 });
    expect(
      statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes("budget 10 min (channel boundary; preset asks 120)")),
    ).toBe(true);
    const profile = { preset: "ship", machine: "repo-resident", identity: "write", minutes: 10, boundedBy: "channel" };
    expect((await store.get("run-shipb"))!.profile).toEqual(profile);
    expect(AGENTS.ship.maxMinutes).toBe(120); // the shared def is never mutated
  });

  it("`agent:ship budget:10` clips the pipeline's wall clock as the caller's own boundary; `ship.maxMinutes` stays the preset's declared budget the card names; the block's rounds cap rides unclipped", async () => {
    const { deps, instances } = shipDeps(SHIP_YAML + "ship:\n  maxMinutes: 60\n  maxRounds: 2\n");
    const registry = new RunRegistry({ genId: () => "run-shipd", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("agent:ship budget:10 in acme/api: fix the login redirect", "slack:UADMIN"), io);
    expect((await handed(instances, "run-shipd")).instance?.caps).toEqual({ maxRounds: 2, maxMinutes: 10 });
    expect(
      statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes("budget 10 min (budget directive; preset asks 60)")),
    ).toBe(true);
  });

  it("a repo-shaped repoCtx.ref never becomes the pipeline base — the default branch is the base the runner is handed", async () => {
    const { deps, instances } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "acme/api" }); // the "on <slug>" misparse shape
    const registry = new RunRegistry({ genId: () => "run-shipr", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect((await handed(instances, "run-shipr")).instance?.base).toBe("main"); // never the slug
  });

  it("thread with user-named open PR and no new task text → a resume at review: the runner is handed the one task unit with the pull request, its head and url on the row, on the pull request's own head branch", async () => {
    const { deps, instances, created } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    const registry = new RunRegistry({ genId: () => "run-shipres", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    expect(created[0]).toMatch(/^plan-implement-the-task-this-[0-9a-f]{6}$/);
    const { instance, unit } = await handed(instances, "run-shipres");
    expect(instance).toMatchObject({ branch: SHIP_BRANCH, base: "main" });
    expect(unit?.resume).toEqual({ pr: 7, headSha: HEAD_A, url: PR_URL });
    expect(replies[replies.length - 1]).toContain(`the review loop of ${PR_URL} resumes at its next review round`);
  });

  it("a bare reference to a person's open PR resumes at review — the bot-authorship check is gone (agent-ship item 10)", async () => {
    const { deps, instances } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ author: { login: "alice", id: 42 } }));
    const registry = new RunRegistry({ genId: () => "run-shiphres", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    const { instance, unit } = await handed(instances, "run-shiphres");
    expect(instance).toMatchObject({ branch: SHIP_BRANCH, base: "main" });
    expect(unit?.resume).toEqual({ pr: 7, headSha: HEAD_A, url: PR_URL });
    expect(replies[replies.length - 1]).toContain(`the review loop of ${PR_URL} resumes at its next review round`);
    expect(replies[replies.length - 1]).not.toContain("not ship's to drive");
  });

  it("thread PR open + new task text → the generated plan ADOPTS the pull request: the one unit row's branch is the PR's head, the base its own, the reply names the PR and no new branch", async () => {
    const { deps, instances, created } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ baseRef: "release/1.x" }));
    const registry = new RunRegistry({ genId: () => "run-shipadopt", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:ship also add rate limiting", "slack:UADMIN"), io);
    expect(created).toHaveLength(1);
    const { instance, unit } = await handed(instances, "run-shipadopt");
    expect(instance).toMatchObject({ branch: SHIP_BRANCH, base: "release/1.x" });
    expect(unit).toMatchObject({ branch: SHIP_BRANCH });
    expect("resume" in unit!).toBe(false);
    expect(replies[replies.length - 1]).toContain(`adopts ${PR_URL}`);
    expect(replies[replies.length - 1]).toContain("no new branch");
    expect(replies[replies.length - 1]).not.toContain("still open");
  });

  it("an adopted person-authored PR behaves identically, and the reply names auto-merge when the PR carries it (agent-ship item 9)", async () => {
    const { deps, instances } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ author: { login: "alice", id: 42 }, autoMergeEnabled: true }));
    const registry = new RunRegistry({ genId: () => "run-shipadopt2", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:ship also add rate limiting", "slack:UADMIN"), io);
    const { instance } = await handed(instances, "run-shipadopt2");
    expect(instance).toMatchObject({ branch: SHIP_BRANCH, base: "main" });
    expect(replies[replies.length - 1]).toContain(
      "Auto-merge is on for this pull request: the approval merges it once checks pass.",
    );
  });

  it("a seeded plan request in the same pull-request thread stays seeded: the rows keep the graph plan branches, the PR is context", async () => {
    const { deps, instances } = shipDeps();
    deps.githubApi = new InMemoryGithubApi({
      "acme/api": { files: { "docs/plans/fixture.md": "### U10. First unit\n- **Dependencies**: none\n" } },
    });
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    const registry = new RunRegistry({ genId: () => "run-shipseed", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:ship in acme/api: plan docs/plans/fixture.md", "slack:UADMIN"), io);
    const { instance, unit } = await handed(instances, "run-shipseed");
    expect(instance).toMatchObject({ plan: { id: "fixture", path: "docs/plans/fixture.md" }, merge: "runner" });
    expect(unit?.branch).toBe("plan/fixture/u10-first-unit");
    expect(replies[replies.length - 1]).not.toContain("adopts");
  });

  // The routed door (routing-and-config item 21; agent-ship item 16): ship is
  // in the router's table, a routed ship runs the request as a generated plan
  // whose merge is a person's, and the seeded form stays behind the directive.
  const SHIP_ROUTED_YAML = SHIP_YAML.replace("routing: { auto: false }", "routing: { auto: true }");
  const shipRouter = () => vi.fn(async () => JSON.stringify({ preset: "ship", reason: "a change to land" }));

  it("a routed ship on a task hands off merge: person — the card reads `ship … routed:` and the instance is the generated plan's", async () => {
    const { deps, instances, created } = shipDeps(SHIP_ROUTED_YAML);
    deps.routeModel = shipRouter();
    const registry = new RunRegistry({ genId: () => "run-shiprouted", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("fix the login redirect", "slack:UADMIN"), io);
    expect(deps.routeModel).toHaveBeenCalledTimes(1);
    expect(statuses[0].title).toContain("*ship*");
    expect(statuses[0].title).toContain("routed: a change to land");
    const { instance, unit } = await handed(instances, "run-shiprouted");
    expect(instance).toMatchObject({ merge: "person" });
    expect(instance?.plan?.id).toBe(
      generatedPlanId(shipTaskText("fix the login redirect", "acme/api"), "slack:CX:1.0"),
    );
    expect(unit).toBeDefined();
    expect(created).toHaveLength(1);
    const meta = registry.snapshotById("run-shiprouted")?.events.find((e) => e.type === "run_meta") as
      { agentSource?: string } | undefined;
    expect(meta?.agentSource).toBe("route");
  });

  it("a routed seeded request (`plan <path>.md`) is refused naming `agent:ship`, nothing written", async () => {
    const { deps, instances, created } = shipDeps(SHIP_ROUTED_YAML);
    deps.githubApi = new InMemoryGithubApi({
      "acme/api": { files: { "docs/plans/fixture.md": "### U10. First unit\n- **Dependencies**: none\n" } },
    });
    deps.routeModel = shipRouter();
    const registry = new RunRegistry({ genId: () => "run-shiproutedseed", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("plan docs/plans/fixture.md", "slack:UADMIN"), io);
    expect(replies[replies.length - 1]).toContain("🚫");
    expect(replies[replies.length - 1]).toContain("`agent:ship plan docs/plans/fixture.md`");
    expect(created).toEqual([]);
    const { instance } = await handed(instances, "run-shiproutedseed");
    expect(instance).toBeNull();
  });

  it("a resume prefers the PR's OWN base ref over the repo default (non-default-base ship PR): the runner is handed that base", async () => {
    const { deps, instances } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, ref: SHIP_BRANCH }); // thread text names no base
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ baseRef: "release/1.x" }));
    const registry = new RunRegistry({ genId: () => "run-shipbase", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    const { instance, unit } = await handed(instances, "run-shipbase");
    expect(instance?.base).toBe("release/1.x");
    expect(unit?.resume).toMatchObject({ pr: 7 });
  });

  it("new task text citing a human-authored open PR does NOT bind it — the runner is handed a task off the default branch on the task's own ship branch, no resume, no refusal", async () => {
    const TASK = "investigate the review-agent bug seen on acme/api#508";
    const { deps, instances } = shipDeps();
    // resolveRepoContext resolves the cited PR's head and binds it as `ref`
    // (repoContext.ts: `if (head?.ref) ref = head.ref`) — the head branch of
    // the human PR (SHIP_BRANCH here, matching openBotPr's headRef). The mock
    // MUST carry that ref AND the `refFromPr` flag the resolver sets with it, or
    // it hides the fall-through re-basing the task on the stranger's head branch.
    // `prFromMessage` marks the reference as in-message (not inherited).
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      pr: 508,
      prFromMessage: true,
      ref: SHIP_BRANCH,
      refFromPr: true,
      headSha: HEAD_A,
      baseRef: "main",
    });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ author: { login: "alice", id: 42 } }));
    const branch = unitBranch(generatedPlanId(shipTaskText(TASK, "acme/api"), "slack:CX:1.0"), "u1");
    const registry = new RunRegistry({ genId: () => "run-shipcite", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${TASK}`, "slack:UADMIN"), io);
    const { instance, unit } = await handed(instances, "run-shipcite");
    // The task branches from the repo default branch — NEVER the cited PR's
    // head branch (SHIP_BRANCH), which would carry the stranger's commits.
    expect(instance).toMatchObject({ branch, base: "main" });
    expect(unit).toMatchObject({ branch });
    expect("resume" in unit!).toBe(false);
    for (const r of replies) expect(r).not.toContain("not ship's to drive");
  });

  it("in-message cited PR + new task text + FAILING prFacts fetch → the task is handed off the DEFAULT branch, no refusal", async () => {
    const TASK = "investigate the review-agent bug seen on acme/api#508";
    const { deps, instances } = shipDeps();
    // The resolver flagged the cited PR as in-message (prFromMessage) with its
    // head ref bound (refFromPr). Ship's OWN facts fetch then fails transiently
    // — the unlucky case. prFromMessage + task text is the fall-through, so
    // ship must NOT refuse; and because facts.headRef is now UNKNOWN, only
    // refFromPr keeps the task off the stranger's PR head branch.
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      pr: 508,
      prFromMessage: true,
      ref: SHIP_BRANCH,
      refFromPr: true,
      headSha: HEAD_A,
      baseRef: "main",
    });
    deps.fetchPrFacts = vi.fn(async () => undefined); // transient fetch failure
    const branch = unitBranch(generatedPlanId(shipTaskText(TASK, "acme/api"), "slack:CX:1.0"), "u1");
    const registry = new RunRegistry({ genId: () => "run-shipfail", genToken: () => "tok" });
    deps.runRegistry = registry;
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${TASK}`, "slack:UADMIN"), io);
    const { instance, unit } = await handed(instances, "run-shipfail");
    expect(instance).toMatchObject({ branch, base: "main" });
    expect("resume" in unit!).toBe(false);
    for (const r of replies) expect(r).not.toContain("PR unverifiable");
    for (const r of replies) expect(r).not.toContain("refusing fail-closed");
  });

  it("inherited unreachable PR (prUnpostable) + new task text → still refused fail-closed (inherited PRs stay closed)", async () => {
    const { deps, provider, created } = shipDeps();
    // An INHERITED thread PR that could not be fetched — prFromMessage is unset,
    // so the fall-through never applies; the thread's own in-flight PR stays
    // fail-closed even with new task text beside it.
    deps.resolveRepoContext = () => ({ repo: "acme/api", prUnpostable: { number: 42, reason: "unreachable" } });
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("agent:ship also add rate limiting", "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("acme/api#42");
    expect(replies[0]).toContain("could not be fetched");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("in-message cited PR + NO task text + failing prFacts fetch → still refused (a bare reference is a resume attempt)", async () => {
    const { deps, provider, created } = shipDeps();
    // In-message, but no task text — a bare URL is a resume request, so the PR
    // MUST be verified before resuming; a failed fetch stays fail-closed.
    deps.resolveRepoContext = () => ({
      repo: "acme/api",
      pr: 508,
      prFromMessage: true,
      ref: SHIP_BRANCH,
      refFromPr: true,
      headSha: HEAD_A,
    });
    deps.fetchPrFacts = vi.fn(async () => undefined); // transient fetch failure
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("🚫");
    expect(replies[0]).toContain("Could not fetch acme/api#508");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("a fork-head PR is refused on adopt and on resume (the fork check runs on both)", async () => {
    const { deps, provider, created } = shipDeps();
    deps.resolveRepoContext = () => ({ repo: "acme/api", pr: 7, headSha: HEAD_A, baseRef: "main", ref: SHIP_BRANCH });
    deps.fetchPrFacts = vi.fn(async () => openBotPr({ sameRepoHead: false }));
    const bare = fakeIO();
    await dispatch(deps, msg(`agent:ship ${PR_URL}`, "slack:UADMIN"), bare.io);
    expect(bare.replies[0]).toContain("lives on a fork");
    const adopt = fakeIO();
    await dispatch(deps, msg("agent:ship also add rate limiting", "slack:UADMIN"), adopt.io);
    expect(adopt.replies[0]).toContain("lives on a fork");
    expect(provider.requests).toHaveLength(0);
    expect(created).toEqual([]);
  });

  it("a deployment without the runner's prerequisites is refused naming the missing one — here `PUBLIC_BASE_URL` — the card closes ⚠️, and nothing runs some other way", async () => {
    const { deps, provider } = shipDeps();
    delete deps.createCoordinatorInstance;
    delete deps.fetchCoordinatorInstanceStatus;
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    expect(replies).toEqual([
      "⚠️ The plan runner could not be started: PUBLIC_BASE_URL is not set — the bot cannot address its own shim. Nothing ran; re-issue the request to try again.",
    ]);
    expect(statuses[statuses.length - 1]!.title).toContain("⚠️");
    expect(provider.requests).toHaveLength(0);
    expect(fetchGuard).not.toHaveBeenCalled(); // the shim is never addressed without its URL
  });

  it("the ship request is claimed on the run ledger without a seed (item 35) and finishes through it: the live row goes, the record lands in the ledger, the plain store is never the fallback", async () => {
    const registry = new RunRegistry({ genId: () => "rship-l", genToken: () => "tship-l" });
    const store = new InMemoryRunStore();
    const ledger = new InMemoryRunLedger();
    const fallbackPuts: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const { deps } = shipDeps();
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-ship",
      fallback: { put: async (r) => void fallbackPuts.push(r.id) },
      warn: () => {},
    });
    let phaseAtReply: string | undefined;
    let rowSeen: ReturnType<InMemoryRunLedger["live"]["get"]>;
    const io: ChannelIO = {
      reply: async () => {
        rowSeen ??= structuredClone(ledger.live.get("rship-l"));
        phaseAtReply = ledger.live.get("rship-l")?.phase;
      },
      status: async () => ({ handle: { channel: "CX", ts: "9.9" }, update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    await writer.settled();
    expect(rowSeen).toMatchObject({
      threadKey: "slack:CX:1.0",
      ownerGen: "gen-ship",
      card: { channel: "CX", ts: "9.9" },
      system: "",
      tools: [],
      meta: { agent: "ship", channelId: "slack:CX", userId: "slack:UADMIN" },
    });
    expect(phaseAtReply).toBe("finishing"); // the CAS was taken before the final reply
    expect(ledger.live.has("rship-l")).toBe(false);
    expect(ledger.finished.get("rship-l")?.status).toBe("completed");
    expect(fallbackPuts).toEqual([]);
    expect((await store.get("rship-l"))?.status).toBe("interrupted"); // only the start tombstone went to the plain store
  });

  it("a final reply that throws writes the run record as `failed`, never `completed` (the thread never saw where the plan runs)", async () => {
    const registry = new RunRegistry({ genId: () => "rship-w", genToken: () => "tship-w" });
    const store = new InMemoryRunStore();
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const { deps } = shipDeps();
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    const io: ChannelIO = {
      reply: async () => {
        throw new Error("slack outage");
      },
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    await dispatch(deps, msg(TASK_MSG, "slack:UADMIN"), io);
    await writer.settled();
    expect((await store.get("rship-w"))?.status).toBe("failed");
    expect((await store.get("rship-w"))?.replyOk).toBe(false); // sealed with the reply's outcome, like the main path
    expect(registry.getById("rship-w")).toMatchObject({ finished: true, replyOk: false });
  });

  it("card close is truthful: the runner took it → ✅; the runner refused it by name → ⚠️ with the reason in the reply, the run still completed", async () => {
    const taken = shipDeps();
    const takenIO = fakeIO();
    await dispatch(taken.deps, msg(TASK_MSG, "slack:UADMIN"), takenIO.io);
    expect(takenIO.statuses[takenIO.statuses.length - 1]!.title).toContain("✅");

    const refusedRun = shipDeps();
    refusedRun.deps.createCoordinatorInstance = vi.fn(async (id: string) => ({
      kind: "failed" as const,
      id,
      reason: "engine down",
    }));
    const registry = new RunRegistry({ genId: () => "run-shipref", genToken: () => "tok" });
    refusedRun.deps.runRegistry = registry;
    const refusedIO = fakeIO();
    await dispatch(refusedRun.deps, msg(TASK_MSG, "slack:UADMIN"), refusedIO.io);
    expect(refusedIO.statuses[refusedIO.statuses.length - 1]!.title).toContain("⚠️");
    expect(refusedIO.replies[0]).toContain("The plan runner could not be started: engine down");
    expect(registry.getById("run-shipref")).toMatchObject({ finished: true, status: "completed" });
  });
});

describe("MCP tools (docs/reference/specs/mcp-tools.md)", () => {
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
  });

  function trackedRegistry() {
    const registry = new RunRegistry();
    const runIds = new Set<string>();
    const create = registry.create.bind(registry);
    registry.create = (...args) => {
      const h = create(...args);
      runIds.add(h.id);
      return h;
    };
    return { registry, runIds };
  }

  function mcpSource(opts: { fail?: string } = {}) {
    const client = new InMemoryMcpClient([
      {
        name: "search_issues",
        description: "Search Linear issues",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        annotations: { readOnlyHint: true },
        handler: async (args) => ({ content: [{ type: "text", text: `LINEAR RESULT for ${String(args.q)}` }] }),
      },
    ]);
    if (opts.fail) client.failListWith = opts.fail;
    const source = new StaticMcpToolSource(
      [{ name: "linear", url: "https://mcp.linear.app/mcp", agents: ["general", "research"] }],
      { factory: () => client },
    );
    return { client, source };
  }

  it("a general run gets the bridged tools + the MCP block; the model's call reaches the server and the result the next turn", async () => {
    let n = 0;
    const provider: Provider & { requests: CompletionRequest[] } = {
      name: "fake",
      requests: [],
      async complete(req): Promise<CompletionResult> {
        this.requests.push({ ...req, messages: structuredClone(req.messages) });
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "m1", name: "mcp__linear__search_issues", input: { q: "login bug" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "3 issues match" }], stopReason: "end_turn" };
      },
    };
    const { client, source } = mcpSource();
    const { registry, runIds } = trackedRegistry();
    const deps: CoreDeps = { ...makeDeps(YAML_FIXTURE, provider), mcp: source, runRegistry: registry };
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("find the login bug in linear"), io);
    expect(replies.join("\n")).toContain("3 issues match");
    // Tools + block on the first request.
    // general's own `assistant` toolset (docs/reference/specs/github-tools.md item 5) comes first; the bridged MCP tool rides after it.
    const names = provider.requests[0].tools?.map((t) => t.name) ?? [];
    expect(names.at(-1)).toBe("mcp__linear__search_issues");
    expect(names).toEqual(expect.arrayContaining(["web_fetch", "github_repos", "github_issue_create"]));
    expect(names).not.toContain("bash");
    expect(provider.requests[0].tools?.find((t) => t.name === "mcp__linear__search_issues")?.description).toContain(
      'external MCP server "linear"',
    );
    expect(provider.requests[0].system).toContain("## External MCP tools");
    expect(provider.requests[0].system).toContain("- linear: 1 tool");
    // The call reached the server with the model's arguments; the result came back wrapped.
    expect(client.calls).toEqual([{ name: "search_issues", args: { q: "login bug" } }]);
    expect(JSON.stringify(provider.requests[1].messages)).toContain("LINEAR RESULT for login bug");
    expect(JSON.stringify(provider.requests[1].messages)).toContain("UNTRUSTED CONTENT");
    // The run stream carries the remote call as an `mcp.<server>.<tool>` span
    // under the tool call's own span, between the generic pair (docs/reference/specs/tracing.md).
    const events = [...runIds].flatMap((id) => registry.snapshotById(id)?.events ?? []);
    const call = events.findIndex((e) => e.type === "tool_call");
    const use = events.findIndex((e) => e.type === "span_end" && e.name === "mcp.linear.search_issues");
    const result = events.findIndex((e) => e.type === "tool_result");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(use).toBeGreaterThan(call);
    expect(result).toBeGreaterThan(use);
    const toolCall = events[call] as { spanId?: string };
    expect(events[use]).toMatchObject({
      type: "span_end",
      status: "ok",
      parentSpanId: toolCall.spanId,
      attrs: { ok: true, bytes: expect.any(Number) },
    });
  });

  it("no source, or no server scoped to the agent → the request is byte-identical", async () => {
    const withSource = capturingProvider();
    await dispatch(
      { ...makeDeps(YAML_FIXTURE, withSource), mcp: mcpSource().source },
      msg("agent:review look at the code"),
      fakeIO().io,
    );
    const without = capturingProvider();
    await dispatch(makeDeps(YAML_FIXTURE, without), msg("agent:review look at the code"), fakeIO().io);
    expect(JSON.stringify(withSource.requests[0])).toBe(JSON.stringify(without.requests[0]));
    expect(withSource.requests[0].system).not.toContain("External MCP tools");
    expect(withSource.requests[0].tools?.some((t) => t.name.startsWith("mcp__"))).toBe(false);
  });

  it("a failing server → mcp_unavailable note, the block says so, the run proceeds without its tools", async () => {
    const provider = capturingProvider("still answered");
    const { registry, runIds } = trackedRegistry();
    const deps: CoreDeps = {
      ...makeDeps(YAML_FIXTURE, provider),
      mcp: mcpSource({ fail: "HTTP 503" }).source,
      runRegistry: registry,
    };
    const { io, replies } = fakeIO();
    await dispatch(deps, msg("anything"), io);
    expect(replies.join("\n")).toContain("still answered");
    // general keeps its own `assistant` toolset; no bridged tool is offered.
    expect(provider.requests[0].tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(["web_fetch", "github_repos"]),
    );
    expect(provider.requests[0].tools?.some((t) => t.name.startsWith("mcp__"))).toBe(false);
    expect(provider.requests[0].system).toContain("- linear: unavailable (HTTP 503)");
    const events = [...runIds].flatMap((id) => registry.snapshotById(id)?.events ?? []);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "run_note",
        kind: "mcp_unavailable",
        summary: "MCP server linear unavailable: HTTP 503",
      }),
    );
  });
});

// Feature: docs/reference/specs/thread-admission.md — ONE live run per thread. A thread
// reply while a run is in flight is steered into that run (its inbox; the
// runner reads it at the next step) or refused with a pointer to the live run —
// never started as a second, rival run in the same thread/workspace. What the
// run never consumed is run as a fresh turn when it ends by itself, and
// answered with a note when an operator stopped it.
describe("thread admission (docs/reference/specs/thread-admission.md)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  /** A provider whose FIRST call waits until the test settles it (answer or
   *  throw; a hard stop's abort settles it with a late answer); every later
   *  call answers `answer <n>` at once. Requests are snapshotted per call. */
  function gatedProvider() {
    const requests: CompletionRequest[] = [];
    let calls = 0;
    let settle!: { answer: (text: string) => void; fail: (err: Error) => void };
    const first = new Promise<CompletionResult>((resolve, reject) => {
      settle = {
        answer: (text) => resolve({ content: [{ type: "text", text }], stopReason: "end_turn" }),
        fail: reject,
      };
    });
    let onFirst!: () => void;
    const firstStarted = new Promise<void>((r) => (onFirst = r));
    const provider: Provider = {
      name: "gated",
      async complete(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        if (calls++ === 0) {
          req.signal?.addEventListener("abort", () => settle.answer("late"));
          onFirst();
          return first;
        }
        return { content: [{ type: "text", text: `answer ${calls}` }], stopReason: "end_turn" };
      },
    };
    return { provider, requests, firstStarted, settle: () => settle };
  }

  const threadMsg = (text: string, user = "slack:UX") => ({
    ...msg(text, user),
    sourceUrl: "https://slack.example/p2",
    userName: user.slice(6).toLowerCase(),
  });
  /** The follow-up reached the live run: the harness drained it on its next tick and steered pi (harness-pi item 6). */
  const foldedIn = (registry: RunRegistry, id: string, text: string) =>
    vi.waitFor(() =>
      expect(registry.snapshotById(id)?.events ?? []).toContainEqual(
        expect.objectContaining({ type: "input", text: expect.stringContaining(text) }),
      ),
    );

  it("a thread reply while a run is in flight is steered: no second run, the follow-up reaches the live run at its next step, the reply says where it went", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://sb.example");
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted; // the run is registered and its first model call is in flight
    const second = fakeIO();
    await dispatch(deps, threadMsg("and also include the numbers", "slack:UY"), second.io);
    // No rival run: still exactly one, and the follow-up got the ack, not a card.
    expect(registry.listActive().map((r) => r.id)).toEqual(["r1"]);
    expect(second.statuses).toEqual([]);
    expect(second.replies).toHaveLength(1);
    expect(second.replies[0]).toMatch(/^↪ Folded into the \*general\* run already in flight/);
    expect(second.replies[0]).toContain(" · https://sb.example/runs/r1?t=t"); // bare URL: the reply path escapes mrkdwn <url|label>
    // The live run reads it at its next step: the answer it was writing is
    // superseded, the follow-up is the next user turn, the run's answer follows it.
    await foldedIn(registry, "r1", "and also include the numbers");
    settle().answer("first draft");
    await run;
    expect(requests).toHaveLength(2);
    const last = requests[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content[0] as { text: string }).text).toContain("and also include the numbers");
    expect(first.replies).toEqual(["answer 2"]);
    // On the record: the follow-up as an `input` (from whom) and the note.
    const events = registry.snapshotById("r1")?.events ?? [];
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "input",
        text: "and also include the numbers",
        source: expect.objectContaining({ user: "uy" }),
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "run_note", kind: "follow_up" }));
    expect(deps.admission!.size).toBe(0); // released
  });

  it("a follow-up naming a DIFFERENT agent is refused with a pointer to the live run — no second run", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted;
    const second = fakeIO();
    await dispatch(deps, threadMsg("agent:research look up the numbers"), second.io);
    expect(registry.listActive()).toHaveLength(1);
    expect(second.statuses).toEqual([]);
    expect(second.replies[0]).toMatch(/^⏳ A \*general\* run is already in flight/);
    expect(second.replies[0]).toContain("`agent:research`");
    settle().answer("done");
    await run;
    expect(requests).toHaveLength(1); // nothing was folded in
    expect(first.replies).toEqual(["done"]);
  });

  it("a re-review sent into a LIVE review run is folded in, not refused: one run, the follow-up on its next model turn, one review posted", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://sb.example");
    const PR_HEAD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "patch-1", pr: 42, headSha: PR_HEAD });
    deps.fetchPrHead = vi.fn(async () => PR_HEAD);
    deps.fetchPrCommits = vi.fn(async () => undefined);
    vi.mocked(makeExecutor).mockResolvedValueOnce({
      executor: {
        exec: async (cmd: string) => (/git rev-parse HEAD/.test(cmd) ? `${PR_HEAD}\n` : ""),
        readFile: async () => "",
        writeFile: async () => "",
        release: async () => ({ released: true }),
      },
    } as Awaited<ReturnType<typeof makeExecutor>>);
    const posts: string[] = [];
    deps.postReviewComment = vi.fn(async (_target: ReviewCommentTarget, body: string) => void posts.push(body));
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("agent:review https://github.com/acme/api/pull/42"), first.io);
    await firstStarted; // the review's first model call is in flight
    const second = fakeIO();
    await dispatch(
      deps,
      threadMsg(
        "agent:review https://github.com/acme/api/pull/42 — re-review: rebased onto main, also check the migration",
      ),
      second.io,
    );
    // Same agent as the live run → a nudge, not a rival run: one run, no
    // second card, the steer ack with the run link.
    expect(registry.listActive().map((r) => r.id)).toEqual(["r1"]);
    expect(second.statuses).toEqual([]);
    expect(second.replies).toEqual([expect.stringMatching(/^↪ Folded into the \*review\* run already in flight/)]);
    expect(second.replies[0]).toContain(" · https://sb.example/runs/r1?t=t");
    await foldedIn(registry, "r1", "also check the migration");
    settle().answer("verdict draft");
    await run;
    // The review turn, the folded follow-up's turn, then the verdict turn (this
    // fake answered "verdict draft" without calling submit_verdict).
    expect(requests).toHaveLength(3);
    const last = requests[1].messages.at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content[0] as { text: string }).text).toContain("also check the migration");
    expect(posts).toHaveLength(1); // one review run → one post, carrying the answer that heard the follow-up
    expect(posts[0]).toContain("answer 2");
    expect(deps.admission!.size).toBe(0); // released
  });

  it("registry commands still answer inline while a run is in flight in the thread (they never start a run)", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted;
    const second = fakeIO();
    await dispatch(deps, threadMsg("help"), second.io);
    expect(second.replies).toHaveLength(1);
    expect(second.replies[0]).not.toMatch(/^↪/);
    expect(second.replies[0]).toContain("help");
    settle().answer("done");
    await run;
  });

  it("the follow-up's sender must be allowed to run the live agent — the allowlist refusal, never a steer", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const fake = {
      exec: async () => "",
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => ({ released: true }),
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("agent:coding fix it", "slack:UADMIN"), first.io);
    await firstStarted;
    const second = fakeIO();
    await dispatch(deps, threadMsg("also fix the tests", "slack:UX"), second.io); // UX may not run coding
    expect(second.replies[0]).toContain("not on the allowlist");
    expect(deps.admission!.get("slack:CX:1.0")?.inbox.size).toBe(0);
    settle().answer("done");
    await run;
    expect(requests).toHaveLength(1);
  });

  it("what the run never consumed runs as a fresh turn when the run ends by itself (here: it failed before its next step)", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted;
    const second = fakeIO();
    await dispatch(deps, threadMsg("and also the numbers", "slack:UY"), second.io);
    expect(second.replies[0]).toMatch(/^↪/);
    await foldedIn(registry, "r1", "and also the numbers"); // steered into pi, which then never reads it
    settle().fail(new Error("provider exploded"));
    await run;
    // The first run failed and said so; the follow-up was NOT lost with it: it
    // ran as its own turn, on its own sender's channel handle.
    expect(first.replies.some((r) => r.includes("provider exploded"))).toBe(true);
    expect(second.replies.at(-1)).toBe("answer 2");
    expect(second.statuses.length).toBeGreaterThan(0); // its own card
    expect(requests).toHaveLength(2);
    expect((requests[1].messages.at(-1)!.content[0] as { text: string }).text).toBe("and also the numbers");
    const runs = registry.listActive();
    expect(runs.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(runs.find((r) => r.id === "r2")?.userId).toBe("slack:UY");
    expect(deps.admission!.size).toBe(0);
  });

  it("after an operator stop, an unconsumed follow-up is not run — its sender is told the run was stopped before reading it", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted;
    const second = fakeIO();
    await dispatch(deps, threadMsg("and also the numbers", "slack:UY"), second.io);
    expect(registry.requestStop("r1", "t", "hard")).toEqual({ ok: true, mode: "hard" });
    await run;
    expect(first.replies.some((r) => r.includes("aborted"))).toBe(true);
    expect(second.replies).toHaveLength(2);
    expect(second.replies[1]).toMatch(/^⛔ .*stopped before it read this follow-up/);
    expect(requests).toHaveLength(1);
    expect(registry.listActive().map((r) => r.id)).toEqual(["r1"]);
  });

  it("two follow-ups during one run: both folded, one ack each; the fresh turn after a failure merges them into ONE request", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted;
    const a = fakeIO();
    const b = fakeIO();
    await dispatch(deps, threadMsg("add the numbers", "slack:UY"), a.io);
    await dispatch(deps, threadMsg("and a chart", "slack:UZ"), b.io);
    expect(a.replies[0]).toMatch(/^↪/);
    expect(b.replies[0]).toMatch(/^↪/);
    await foldedIn(registry, "r1", "and a chart");
    settle().fail(new Error("boom"));
    await run;
    expect(requests).toHaveLength(2);
    expect((requests[1].messages.at(-1)!.content[0] as { text: string }).text).toMatch(
      /^add the numbers\s+and a chart$/,
    );
    expect(b.replies.at(-1)).toBe("answer 2"); // the most recent sender's handle carries the fresh turn
    expect(a.replies).toHaveLength(1);
    expect(registry.listActive().find((r) => r.id === "r2")?.userId).toBe("slack:UZ");
  });

  it("a run that THREW after an operator stop was requested still counts as stopped: its follow-up is not run", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const { provider, requests, firstStarted, settle } = gatedProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = fakeIO();
    const run = dispatch(deps, threadMsg("write the report"), first.io);
    await firstStarted;
    const second = fakeIO();
    await dispatch(deps, threadMsg("and also the numbers", "slack:UY"), second.io);
    expect(registry.requestStop("r1", "t", "soft")).toEqual({ ok: true, mode: "soft" });
    settle().fail(new Error("finale exploded")); // the in-flight call fails AFTER the stop
    await run;
    expect(first.replies.some((r) => r.includes("finale exploded"))).toBe(true);
    expect(second.replies).toHaveLength(2);
    expect(second.replies[1]).toMatch(/^⛔ .*stopped before it read this follow-up/);
    expect(requests).toHaveLength(1); // no fresh turn
    expect(registry.listActive().map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("run ledger write-through (docs/reference/specs/run-history.md item 35)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(makeExecutor).mockClear();
  });

  function wired(provider: Provider, over: { ledger?: InMemoryRunLedger; gen?: string; yaml?: string } = {}) {
    const registry = new RunRegistry({ genId: () => "run-l", genToken: () => "tok" });
    const store = new InMemoryRunStore();
    const ledger = over.ledger ?? new InMemoryRunLedger();
    const warnings: string[] = [];
    const fallbackPuts: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: (m) => warnings.push(m),
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const deps = makeDeps(over.yaml ?? YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: over.gen ?? "gen-T",
      fallback: { put: async (r) => void fallbackPuts.push(r.id) },
      warn: (m) => warnings.push(m),
    });
    return { deps, registry, store, ledger, writer, warnings, fallbackPuts };
  }

  /** A status handle that names its message, like the Slack adapter's. */
  function ioWithCard(onReply?: () => void) {
    const replies: string[] = [];
    const io: ChannelIO = {
      reply: async (t) => {
        onReply?.();
        replies.push(t);
      },
      status: async () => ({ handle: { channel: "CX", ts: "1.2" }, update: () => {}, done: async () => {} }),
      history: async () => [{ role: "user", text: "earlier question" }],
    };
    return { io, replies };
  }

  it("claims the run once its prompt exists (system, tools, card, meta, seed), records each step before its tools, appends events, takes finishing before the reply and finishes through the ledger", async () => {
    const seen: {
      rowAtFirstCall?: ReturnType<InMemoryRunLedger["live"]["get"]>;
      transcriptAtFirstCall?: number;
      firstRequestTurns?: number;
      stepsAtSecondCall?: unknown;
      transcriptAtSecondCall?: Awaited<ReturnType<InMemoryRunLedger["readTranscript"]>>;
      stateAtSecondCall?: unknown;
      phaseAtReply?: string;
    } = {};
    let n = 0;
    const ledger = new InMemoryRunLedger();
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (n++ === 0) {
          seen.rowAtFirstCall = structuredClone(ledger.live.get("run-l"));
          seen.transcriptAtFirstCall = (await ledger.readSession("slack:CX:1.0:general", 0)).turns;
          seen.firstRequestTurns = req.messages.length;
          return {
            content: [
              { type: "tool_use", id: "s1", name: "update_status", input: { checklist: "○ look around" } },
              { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
            ],
            stopReason: "tool_use",
          };
        }
        seen.stepsAtSecondCall = structuredClone(ledger.steps.get("run-l"));
        seen.transcriptAtSecondCall = await ledger.readSession("slack:CX:1.0:general", 0);
        seen.stateAtSecondCall = structuredClone(ledger.live.get("run-l")?.state);
        return { content: [{ type: "text", text: "all done" }], stopReason: "end_turn" };
      },
    };
    const { deps, store, writer, warnings, fallbackPuts } = wired(provider, { ledger });
    const { io, replies } = ioWithCard(() => {
      seen.phaseAtReply = ledger.live.get("run-l")?.phase;
    });
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();

    // The claim: everything a resume must hand the model again.
    const row = seen.rowAtFirstCall!;
    expect(row).toMatchObject({
      threadKey: "slack:CX:1.0",
      ownerGen: "gen-T",
      phase: "live",
      card: { channel: "CX", ts: "1.2" },
      meta: {
        agent: "general",
        model: "anthropic/general-model",
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        readonly: false,
        selection: "sandbox",
        // The run's place in its session log (session-log item 2): a thread's
        // first run of the agent starts the log at 0 and appends from there.
        session: { key: "slack:CX:1.0:general", seedFrom: 0, range: { from: 0 } },
      },
    });
    expect(row.system.length).toBeGreaterThan(0);
    expect(row.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["update_status", "web_fetch"]));
    expect(row.tools.every((t) => !("run" in t))).toBe(true); // definitions only, never the runnable
    // The seed: exactly the conversation the first model call carried, before it was made.
    expect(seen.transcriptAtFirstCall).toBe(seen.firstRequestTurns);
    const seedTurns = seen.firstRequestTurns!;
    // The step record, written before the tools ran, names both calls; the
    // transcript grew by this step's assistant turn (and, by the second call,
    // its results turn is not yet written — that rides with the next step).
    expect(seen.stepsAtSecondCall).toEqual([
      expect.objectContaining({ step: 0, turnIndex: seedTurns, inFlight: [], remainingMs: 5 * 60_000 }), // general: 5 min
      expect.objectContaining({
        step: 1,
        turnIndex: seedTurns + 1,
        inFlight: [
          { callId: "s1", tool: "update_status" },
          { callId: "t1", tool: "bash" },
        ],
        turn: 1,
        iteration: 0,
      }),
    ]);
    expect(seen.transcriptAtSecondCall).toMatchObject({ complete: true, turns: seedTurns + 1 });
    expect(seen.transcriptAtSecondCall!.messages[seedTurns].role).toBe("assistant");
    // The dispatcher's state: the checklist landed while the run was live.
    expect(seen.stateAtSecondCall).toMatchObject({ checklist: "○ look around" }); // beside the harness facts
    // finishing was taken before anything reached the thread.
    expect(seen.phaseAtReply).toBe("finishing");
    expect(replies.at(-1)).toBe("all done");
    // The finish: live rows gone, the record in the ledger, every event appended in seq order.
    expect(ledger.live.has("run-l")).toBe(false);
    expect(ledger.steps.has("run-l")).toBe(false);
    expect(ledger.finished.get("run-l")).toMatchObject({ id: "run-l", status: "completed" });
    // The record's range: the seed rows, then the first assistant turn, the
    // results turn and the final answer — the mirror writes every turn pi
    // finished as a row (harness-pi item 8) — closed at finish, kept in the log.
    expect(ledger.finished.get("run-l")!.session).toEqual({
      key: "slack:CX:1.0:general",
      seedFrom: 0,
      request: seedTurns - 1,
      range: { from: 0, to: seedTurns + 2 },
    });
    expect((await ledger.readSession("slack:CX:1.0:general", 0)).turns).toBe(seedTurns + 3); // every finished turn a row
    const appended = ledger.events.get("run-l")!;
    expect(appended.map((e) => e.type)).toEqual(
      expect.arrayContaining(["input", "run_meta", "context", "tool_call", "tool_result", "answer"]),
    );
    expect(appended.map((e) => e.seq)).toEqual([...appended].map((e) => e.seq).sort((a, b) => a - b));
    expect(fallbackPuts).toEqual([]);
    expect((await store.get("run-l"))?.status).toBe("interrupted"); // only the start tombstone went to the plain store
    expect(warnings).toEqual([]);
  });

  it("a thread whose ledger row belongs to another run leaves this run untracked: it runs and replies as before, its record goes to the store, one warning", async () => {
    const ledger = new InMemoryRunLedger();
    await ledger.claim({
      runId: "stale",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 1,
      meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" },
      system: "",
      tools: [],
    });
    const { deps, store, writer, warnings, fallbackPuts } = wired(capturingProvider("still answered"), { ledger });
    const { io, replies } = ioWithCard();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    expect(replies.at(-1)).toBe("still answered");
    expect(ledger.live.has("run-l")).toBe(false);
    expect(ledger.live.has("stale")).toBe(true);
    expect(ledger.finished.has("run-l")).toBe(false);
    expect((await store.get("run-l"))?.status).toBe("completed"); // the writer's own store, not the fallback sink
    expect(fallbackPuts).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("belongs to run stale");
  });

  it("the finish reaches the ledger BEFORE the workspace release completes (item 36), and the final status rides on the row before finishing: a slow sandbox teardown never keeps the thread's row live after the reply", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const ledger = new InMemoryRunLedger();
    const order: string[] = [];
    let stateAtReply: unknown;
    let phaseAtReply: string | undefined;
    const { deps, writer, fallbackPuts } = wired(capturingProvider("fixed"), { ledger, yaml: REMOTE_YAML_FIXTURE });
    const { io } = fakeIO();
    io.reply = async () => {
      order.push("reply");
      stateAtReply = structuredClone(ledger.live.get("run-l")?.state);
      phaseAtReply = ledger.live.get("run-l")?.phase;
    };
    const release = vi.fn(async () => {
      order.push("release-start");
      await new Promise((r) => setTimeout(r, 25)); // a slow /detach: the finish must not be behind it
      order.push(`release-end(live=${ledger.live.has("run-l")}, finished=${ledger.finished.has("run-l")})`);
      return { released: true };
    });
    const fake = { exec: async () => "", readFile: async () => "", writeFile: async () => "", release };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fake });
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    await writer.settled();
    expect(order).toEqual(["reply", "release-start", "release-end(live=false, finished=true)"]);
    expect(stateAtReply).toMatchObject({ finalStatus: "completed" }); // beside the harness facts (harness-pi item 8)
    expect(phaseAtReply).toBe("finishing");
    expect(fallbackPuts).toEqual([]);
  });

  it("the run is reserved on the ledger BEFORE the workspace attach (item 42): an attaching row with the request (text, sender, link, attachments), the card and no prompt, under the id the run will have, and the registry row — label, token, the same start — exists from that moment too; the claim once the prompt exists promotes that row in place — one row, one id — and the finish clears it", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    let rowAtAttach: ReturnType<InMemoryRunLedger["live"]["get"]>;
    let registryAtAttach: ReturnType<RunRegistry["getById"]> = null;
    let indexAtAttach: ReturnType<RunRegistry["listActive"]> = [];
    let streamAtAttach: RunEvent[] = [];
    const real = vi.mocked(makeExecutor).getMockImplementation()!;
    vi.mocked(makeExecutor).mockImplementationOnce(async (...args) => {
      rowAtAttach = structuredClone(ledger.live.get("run-l"));
      registryAtAttach = registry.getById("run-l");
      indexAtAttach = registry.listActive();
      streamAtAttach = registry.snapshotById("run-l")?.events ?? [];
      return real(...args);
    });
    let rowAtFirstCall: ReturnType<InMemoryRunLedger["live"]["get"]>;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        rowAtFirstCall ??= structuredClone(ledger.live.get("run-l"));
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer, warnings } = wired(provider, { ledger });
    const { io, replies } = ioWithCard();
    await dispatch(
      deps,
      {
        ...msg("hello there"),
        userName: "ux",
        sourceUrl: "https://s/1",
        images: [{ mediaType: "image/png", data: "QUJD", name: "chart.png" }],
      },
      io,
    );
    await writer.settled();
    // At the attach: the registry row is the run's from the reservation on —
    // its label, its token (the index links the page from second zero), the
    // reservation's start — so the runs index never sees a labelless ledger
    // row for a run this process holds.
    expect(registryAtAttach).toMatchObject({
      id: "run-l",
      token: "tok",
      label: 'general · #CX · ux · "hello there"',
      agent: "general",
      finished: false,
      startedAt: rowAtAttach!.startedAt,
    });
    expect(indexAtAttach.map((r) => r.id)).toEqual(["run-l"]);
    // …and its stream is already live at the attach: the setup spans so far
    // (the attach itself still open, its start streamed live), then the
    // request and its meta. The record's first CONTENT event is still `input`,
    // and everything ahead of it is head material — the protected head runs
    // unbroken from the first event through the request.
    expect(streamAtAttach.filter((e) => !isSpanRecord(e)).map((e) => e.type)).toEqual(["input", "run_meta", "context"]);
    // The attach span has started (its start streamed live, the mock runs inside it).
    expect(streamAtAttach.map((e) => (e.type === "span_start" ? e.name : e.type))).toEqual(
      expect.arrayContaining(["dispatch.ack_card", "input", "run_meta", "dispatch.workspace.attach"]),
    );
    const firstContentAt = streamAtAttach.findIndex((e) => !isSpanRecord(e));
    expect(firstContentAt).toBeGreaterThan(0); // setup spans precede the request…
    expect(streamAtAttach.slice(0, firstContentAt).every(isHeadMaterial)).toBe(true); // …and every one is head material
    expect(streamAtAttach.find((e) => e.type === "input")).toMatchObject({ text: "hello there [+1 image]" });
    // At the attach: reserved — identity, request, card; no prompt yet.
    expect(rowAtAttach).toMatchObject({
      runId: "run-l",
      threadKey: "slack:CX:1.0",
      ownerGen: "gen-T",
      phase: "attaching",
      system: "",
      tools: [],
      card: { channel: "CX", ts: "1.2" },
      meta: {
        agent: "general",
        model: "anthropic/general-model",
        channelId: "slack:CX",
        userId: "slack:UX",
        readonly: false,
        request: {
          channelId: "slack:CX",
          userId: "slack:UX",
          threadKey: "slack:CX:1.0",
          text: "hello there",
          userName: "ux",
          sourceUrl: "https://s/1",
          images: [{ mediaType: "image/png", data: "QUJD", name: "chart.png" }],
        },
      },
    });
    // At the first model call: the same row, promoted — the prompt landed, the request kept, the start unchanged.
    expect(rowAtFirstCall).toMatchObject({
      runId: "run-l",
      phase: "live",
      startedAt: rowAtAttach!.startedAt,
      card: { channel: "CX", ts: "1.2" },
      meta: { selection: "sandbox", request: { text: "hello there" } },
    });
    expect(rowAtFirstCall!.system.length).toBeGreaterThan(0);
    expect(rowAtFirstCall!.tools.length).toBeGreaterThan(0);
    expect(replies.at(-1)).toBe("done");
    expect(ledger.live.size).toBe(0);
    expect(ledger.finished.get("run-l")?.status).toBe("completed");
    expect(warnings).toEqual([]);
  });

  // docs/reference/specs/run-history.md item 48; docs/reference/specs/thread-admission.md
  // item 8: a coordinator's child carries its instance and its spawn's key on
  // every row — the reservation, the claim, the registry summary, the finish
  // record — and a second spawn onto the unit's thread while the child is live
  // is refused by name with nothing said in the thread.
  it("a coordinator's child (DispatchOptions.coordinator) carries parentInstanceId and idempotencyKey on the reserved row, the claimed row, the live summary and the finish record; a second coordinator dispatch onto the live thread is refused coordinator_thread_live and says nothing", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const tag = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
    let rowAtAttach: ReturnType<InMemoryRunLedger["live"]["get"]>;
    const real = vi.mocked(makeExecutor).getMockImplementation()!;
    vi.mocked(makeExecutor).mockImplementationOnce(async (...args) => {
      rowAtAttach = structuredClone(ledger.live.get("run-l"));
      return real(...args);
    });
    let rowAtFirstCall: ReturnType<InMemoryRunLedger["live"]["get"]>;
    let summaryAtFirstCall: ReturnType<RunRegistry["getById"]> = null;
    let secondOutcome: DispatchOutcome | undefined;
    const second = ioWithCard();
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        rowAtFirstCall ??= structuredClone(ledger.live.get("run-l"));
        summaryAtFirstCall ??= registry.getById("run-l");
        // A retried spawn lands while the child is live: refused, nothing steered.
        secondOutcome ??= await dispatch(deps, msg("hello again"), second.io, { coordinator: tag });
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer, warnings } = wired(provider, { ledger });
    deps.admission = new ThreadAdmission<DispatchFollowUp>();
    const { io, replies } = ioWithCard();
    const outcome = await dispatch(deps, msg("hello there"), io, { coordinator: tag });
    await writer.settled();
    expect(outcome).toEqual({ status: "completed" });
    expect(rowAtAttach).toMatchObject({ runId: "run-l", phase: "attaching", meta: tag });
    expect(rowAtFirstCall).toMatchObject({ runId: "run-l", phase: "live", meta: tag });
    expect(summaryAtFirstCall).toMatchObject({ id: "run-l", ...tag });
    expect(ledger.finished.get("run-l")).toMatchObject({ id: "run-l", status: "completed", ...tag });
    expect(isRunRecord(ledger.finished.get("run-l")!)).toBe(true);
    expect(replies.at(-1)).toBe("done");
    expect(secondOutcome).toEqual({ status: "refused", refusal: "coordinator_thread_live" });
    expect(second.replies).toEqual([]);
    expect(ledger.live.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("a dispatch that ends before its prompt exists — here the attach's ask-once branch refusal — abandons its reservation and discards its registry row (item 42): both go with no record and no warning, the index feed sees the row come and go, so nothing restarts or lists a run that never started", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const ledger = new InMemoryRunLedger(() => 10_000);
    let rowAtAttach: ReturnType<InMemoryRunLedger["live"]["get"]>;
    let liveAtAttach: string[] = [];
    vi.mocked(makeExecutor).mockImplementationOnce(async () => {
      rowAtAttach = structuredClone(ledger.live.get("run-l"));
      liveAtAttach = registry.listActive().map((r) => r.id);
      throw new ResidentNeedsRefError("repo:acme/api");
    });
    const { deps, registry, writer, warnings } = wired(capturingProvider("must not run"), {
      ledger,
      yaml: REMOTE_YAML_FIXTURE,
    });
    const index: IndexEvent[] = [];
    registry.subscribeIndex((ev) => index.push(ev));
    const { io, replies } = ioWithCard();
    await dispatch(deps, msg("agent:coding fix it in acme/api", "slack:UADMIN"), io);
    await writer.settled();
    expect(rowAtAttach?.phase).toBe("attaching");
    expect(liveAtAttach).toEqual(["run-l"]);
    expect(replies.some((r) => r.includes("Which branch"))).toBe(true);
    expect(ledger.live.size).toBe(0);
    expect(ledger.finished.size).toBe(0);
    expect(registry.listActive()).toEqual([]);
    // The row came (the create, then one upsert per content event published at
    // the reservation — request, meta, context) and went (the discard), and
    // nothing came after the removal.
    expect(index[0]?.type).toBe("upsert");
    expect(index.at(-1)).toEqual({ type: "removed", id: "run-l" });
    expect(index.filter((ev) => ev.type === "removed")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("a run reserved at admission whose owner died is restarted under its own id (item 42): the request is dispatched again from the row, the card is the row's, the follow-ups steered in meanwhile are folded in with no second ack, this generation promotes the row and the finish closes it — the record keeps the original start", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const request = durableInboxMessage({ ...msg("hello there"), userName: "ux" }, "hello there", 5_000);
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      phase: "attaching",
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
        request,
      },
      card: { channel: "CX", ts: "1.2" },
      system: "",
      tools: [],
    });
    await ledger.pushInbox(
      "run-old",
      durableInboxMessage(msg("and also the numbers", "slack:UY"), "and also the numbers", 6_000),
    );
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    expect(reclaimed.reclaimedFrom).toBe("attaching");
    let n = 0;
    let rowAtFirstCall: ReturnType<InMemoryRunLedger["live"]["get"]>;
    let secondRequestTail: unknown;
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        if (n++ === 0) {
          rowAtFirstCall = structuredClone(ledger.live.get("run-old"));
          return {
            content: [{ type: "tool_use", id: "s1", name: "update_status", input: { checklist: "○ restarted" } }],
            stopReason: "tool_use",
          };
        }
        secondRequestTail = structuredClone(req.messages.at(-1));
        return { content: [{ type: "text", text: "restarted and done" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer, warnings } = wired(provider, { ledger });
    const { io, replies } = ioWithCard();
    const restored = messageFromInbox(reclaimed.row.meta.request!, 5_000)!;
    await dispatch(deps, restored.msg, io, { restart: { row: reclaimed.row, inbox: reclaimed.inbox } });
    await writer.settled();
    expect(replies).toEqual(["restarted and done"]); // the carried follow-up gets no second ack
    expect(rowAtFirstCall).toMatchObject({
      runId: "run-old",
      ownerGen: "gen-T",
      phase: "live",
      startedAt: 5_000,
      card: { channel: "CX", ts: "1.2" },
      meta: { agent: "general", request: { text: "hello there" } },
    });
    expect(rowAtFirstCall!.system.length).toBeGreaterThan(0);
    expect(JSON.stringify(secondRequestTail)).toContain("and also the numbers"); // folded in at the first step boundary
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-old"]); // one run, the row's id
    expect(ledger.live.has("run-old")).toBe(false);
    const record = ledger.finished.get("run-old")!;
    expect(record.status).toBe("completed");
    expect(record.startedAt).toBe(5_000);
    expect(record.events.filter((e) => e.type === "input").map((e) => (e as { text: string }).text)).toEqual([
      "hello there",
      "and also the numbers",
    ]);
    expect(warnings).toEqual([]);
  });

  it("a restarted routed run (item 42) reuses the row's decision: the card carries the routed line and the footer, the record gets its route event and run_meta says route, and the router is never asked again", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const request = durableInboxMessage({ ...msg("what is this repo") }, "what is this repo", 5_000);
    await ledger.claim({
      runId: "run-routed",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      phase: "attaching",
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "review",
        model: "anthropic/review-model",
        request,
        route: { preset: "review", reason: "a review ask", model: "anthropic/general-model" },
      },
      card: { channel: "CX", ts: "1.2" },
      system: "",
      tools: [],
    });
    ledger.live.get("run-routed")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    expect(reclaimed.reclaimedFrom).toBe("attaching");
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        return { content: [{ type: "text", text: "restarted and done" }], stopReason: "end_turn" };
      },
    };
    const { deps, writer } = wired(provider, { ledger });
    deps.routeModel = vi.fn(async () => JSON.stringify({ preset: "general", reason: "never asked" }));
    const statuses: StatusUpdate[] = [];
    const io: ChannelIO = {
      reply: async () => {},
      status: async (initial) => {
        statuses.push(initial);
        return {
          handle: { channel: "CX", ts: "1.2" },
          update: (f: StatusUpdate) => void statuses.push(f),
          done: async (f: StatusUpdate) => void statuses.push(f),
        };
      },
      history: async () => [],
    };
    const restored = messageFromInbox(reclaimed.row.meta.request!, 5_000)!;
    await dispatch(deps, restored.msg, io, { restart: { row: reclaimed.row, inbox: reclaimed.inbox } });
    await writer.settled();
    expect(deps.routeModel).not.toHaveBeenCalled();
    expect(statuses[0].title).toContain("*review* on `anthropic/review-model` · routed: a review ask");
    expect(statuses.at(-1)!.detail?.split("\n").at(-1)).toBe(
      "wrong preset? reply agent:<preset> to run it another way",
    );
    const record = ledger.finished.get("run-routed")!;
    expect(record.agent).toBe("review");
    expect(record.events.filter((e) => e.type === "route")).toEqual([
      expect.objectContaining({
        type: "route",
        preset: "review",
        reason: "a review ask",
        model: "anthropic/general-model",
      }),
    ]);
    expect((record.events.find((e) => e.type === "run_meta") as { agentSource?: string }).agentSource).toBe("route");
  });

  it("a restart onto a thread that has a newer run in flight closes the reserved row interrupted with no reply and no run (item 42)", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      phase: "attaching",
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        request: durableInboxMessage(msg("hello there"), "hello there", 5_000),
      },
      system: "",
      tools: [],
    });
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    const { deps, registry, writer } = wired(capturingProvider("must not run"), { ledger });
    deps.admission = new ThreadAdmission();
    deps.admission.claim("slack:CX:1.0", { agent: "general" }); // the user re-mentioned the bot after the kill
    const { io, replies } = ioWithCard();
    await dispatch(deps, msg("hello there"), io, { restart: { row: reclaimed.row, inbox: reclaimed.inbox } });
    await writer.settled();
    expect(replies).toEqual([]);
    expect(registry.listActive()).toEqual([]);
    expect(ledger.live.has("run-old")).toBe(false);
    expect(ledger.finished.get("run-old")).toMatchObject({ status: "interrupted", startedAt: 5_000 });
  });

  it("a routed run's row carries the router's decision (item 35), written at the claim, so another generation can repaint the card from the row alone", async () => {
    let rowAtCall: LiveRunRow | undefined;
    const ledger = new InMemoryRunLedger(() => 10_000);
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        rowAtCall ??= structuredClone([...ledger.live.values()][0]);
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const { deps, writer } = wired(provider, {
      ledger,
      yaml: YAML_FIXTURE.replace("routing: { auto: false }\n", "routing: { auto: true }\n"),
    });
    deps.routeModel = vi.fn(async () => JSON.stringify({ preset: "review", reason: "a review ask" }));
    const { io } = ioWithCard();
    await dispatch(deps, msg("review it for me"), io);
    await writer.settled();
    expect(deps.routeModel).toHaveBeenCalledTimes(1);
    expect(rowAtCall?.meta.agent).toBe("review");
    expect(rowAtCall?.meta.route).toEqual({
      preset: "review",
      reason: "a review ask",
      model: "anthropic/general-model",
    });
  });

  it("a resumed run whose row carries the route repaints the routed line from the first frame and closes with the override footer (items 38 and routing-and-config 21); the router is not asked again and no second route event is published", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const transcript: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "what is this repo" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "s1", name: "update_status", input: { checklist: "○ resumed" } },
        ],
      },
    ];
    await ledger.claim({
      runId: "run-routed",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
        route: { preset: "general", reason: "a plain question", model: "anthropic/general-model" },
      },
      card: { channel: "CX", ts: "1.2" },
      system: "the stored prompt, verbatim",
      tools: [],
      state: {},
    });
    await ledger.seed("run-routed", "gen-OLD", [{ idx: 0, message: transcript[0] }]);
    await ledger.step(
      "run-routed",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    await ledger.step(
      "run-routed",
      "gen-OLD",
      {
        step: 1,
        seq: 3,
        turnIndex: 2,
        inFlight: [{ callId: "s1", tool: "update_status" }],
        inboxConsumedSeq: 0,
        remainingMs: 240_000,
        turn: 1,
        iteration: 0,
      },
      [{ idx: 1, message: transcript[1] }],
    );
    await ledger.append("run-routed", "gen-OLD", [
      { type: "input", messageId: "m1", text: "what is this repo", at: 1, seq: 1 },
      { type: "run_meta", agent: "general", model: "anthropic/general-model", agentSource: "route", at: 2, seq: 2 },
      { type: "route", preset: "general", reason: "a plain question", model: "anthropic/general-model", at: 3, seq: 3 },
    ]);
    ledger.live.get("run-routed")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        return { content: [{ type: "text", text: "resumed and done" }], stopReason: "end_turn" };
      },
    };
    const { deps, writer } = wired(provider, { ledger });
    deps.routeModel = vi.fn(async () => JSON.stringify({ preset: "review", reason: "never asked" }));
    const plan = planResume({
      transcript: { complete: true, turns: 2, messages: transcript, compactions: [] },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("general")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const events = await ledger.readEvents("run-routed");
    const statuses: StatusUpdate[] = [];
    const io: ChannelIO = {
      reply: async () => {},
      status: async (initial) => {
        statuses.push(initial);
        return {
          handle: { channel: "CX", ts: "1.2" },
          update: (f: StatusUpdate) => void statuses.push(f),
          done: async (f: StatusUpdate) => void statuses.push(f),
        };
      },
      history: async () => [],
    };
    await dispatch(deps, resumeMessage(reclaimed.row, "what is this repo"), io, {
      resume: { row: reclaimed.row, lastStep: reclaimed.lastStep!, plan, events, lastSeq: 3, repoCtx: {}, inbox: [] },
    });
    await writer.settled();
    expect(deps.routeModel).not.toHaveBeenCalled();
    expect(statuses[0].title).toContain("*general* on `anthropic/general-model` · routed: a plain question");
    const closed = statuses.at(-1)!;
    expect(closed.title).toContain("✅");
    expect(closed.detail?.split("\n").at(-1)).toBe("wrong preset? reply agent:<preset> to run it another way");
    const record = ledger.finished.get("run-routed")!;
    expect(record.events.filter((e) => e.type === "route")).toHaveLength(1);
  });

  it("a reclaimed run resumes under its own id (item 38): the row is adopted at admission, the transcript is the conversation, the calls in flight are settled before the first model call, the earlier events are replayed under their seqs, and the finish closes the same row", async () => {
    // The previous generation's run: claimed, seeded, one step in flight (an
    // update_status the general agent has, and a bash it does not), events 1–4.
    const ledger = new InMemoryRunLedger(() => 10_000);
    const transcript: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello there" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "s1", name: "update_status", input: { checklist: "○ resumed" } },
          { type: "tool_use", id: "b1", name: "bash", input: { command: "make" } },
        ],
      },
    ];
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
      },
      card: { channel: "CX", ts: "1.2" },
      system: "the stored prompt, verbatim",
      tools: [],
      state: { checklist: "○ before" },
    });
    await ledger.seed("run-old", "gen-OLD", [{ idx: 0, message: transcript[0] }]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    await ledger.step(
      "run-old",
      "gen-OLD",
      {
        step: 1,
        seq: 4,
        turnIndex: 2,
        inFlight: [
          { callId: "s1", tool: "update_status" },
          { callId: "b1", tool: "bash" },
        ],
        inboxConsumedSeq: 0,
        remainingMs: 240_000,
        turn: 1,
        iteration: 0,
      },
      [{ idx: 1, message: transcript[1] }],
    );
    await ledger.append("run-old", "gen-OLD", [
      { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
      { type: "run_meta", agent: "general", model: "anthropic/general-model", at: 2, seq: 2 },
      { type: "tool_call", tool: "update_status", summary: "s", at: 3, seq: 3 },
      { type: "tool_call", tool: "bash", summary: "make", at: 4, seq: 4 },
    ]);
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    expect(reclaimed.row.ownerGen).toBe("gen-T");

    let firstRequest: ChatMessage[] | undefined;
    let stateAtFirstCall: unknown;
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        firstRequest ??= structuredClone(req.messages);
        stateAtFirstCall ??= structuredClone(ledger.live.get("run-old")?.state);
        return { content: [{ type: "text", text: "resumed and done" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer, fallbackPuts, warnings } = wired(provider, { ledger });
    const plan = planResume({
      transcript: { complete: true, turns: 2, messages: transcript, compactions: [] },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("general")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const events = await ledger.readEvents("run-old");
    const { io, replies } = ioWithCard();
    await dispatch(deps, resumeMessage(reclaimed.row, "hello there"), io, {
      resume: { row: reclaimed.row, lastStep: reclaimed.lastStep!, plan, events, lastSeq: 4, repoCtx: {}, inbox: [] },
    });
    await writer.settled();

    expect(replies.at(-1)).toBe("resumed and done");
    // The model saw the stored prompt and the transcript plus the settlement's results turn:
    // update_status re-ran (it exists), bash got the not-available result (general has no bash).
    expect(firstRequest!.slice(0, 2)).toEqual(transcript);
    expect(firstRequest![2].role).toBe("user");
    // The settlement turn: one result per call in flight, then pi's continue prompt as text (harness-pi item 8).
    const results = (firstRequest![2].content as Array<{ type: string; toolUseId: string; content: unknown }>).filter(
      (p) => p.type === "tool_result",
    );
    expect(results.map((r) => r.toolUseId)).toEqual(["s1", "b1"]);
    expect(String(results[1].content)).toContain("not available after the bot restarted");
    // No call is re-run on pi (harness-pi item 8): the settlement is the restart note, so the row's state stands as recorded.
    expect(stateAtFirstCall).toMatchObject({ checklist: "○ before" });
    // Same run id everywhere; the record carries the replayed events and the new ones as one stream.
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-old"]);
    expect(ledger.live.has("run-old")).toBe(false);
    const record = ledger.finished.get("run-old")!;
    expect(record.status).toBe("completed");
    expect(record.startedAt).toBe(5_000); // the original start, not the resume
    expect(record.events.slice(0, 4).map((e) => e.type)).toEqual(["input", "run_meta", "tool_call", "tool_call"]);
    expect(record.events.map((e) => e.seq)).toEqual(
      [...record.events].map((e) => e.seq).sort((a, b) => (a ?? 0) - (b ?? 0)),
    );
    expect(record.events.filter((e) => e.type === "input")).toHaveLength(1); // no second request event
    expect(record.events.some((e) => e.type === "run_note" && e.kind === "resumed")).toBe(true);
    // Only this generation's events were appended (the earlier ones were on the ledger already).
    expect(ledger.events.get("run-old")!.map((e) => e.seq)).toEqual([
      1,
      2,
      3,
      4,
      ...ledger.events
        .get("run-old")!
        .slice(4)
        .map((e) => e.seq),
    ]);
    expect(
      Math.min(
        ...ledger.events
          .get("run-old")!
          .slice(4)
          .map((e) => e.seq),
      ),
    ).toBeGreaterThan(4);
    expect(fallbackPuts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // run-history item 37, the `finish` plan: the previous generation died after
  // the model's final answer and before the reply. The reclaimed run is not
  // closed interrupted; it finishes with that answer, under the status and the
  // label its own notes say, and the model is never asked again.
  it("a reclaimed run whose transcript ends on the model's final answer finishes instead of closing interrupted: no model call, the answer reaches the thread under the soft stop's label its notes record, the record says stopped_soft, and the row is closed", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const transcript: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello there" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "s1", name: "update_status", input: { checklist: "○ looking" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "s1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "What I found before the stop." }] },
    ];
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
      },
      card: { channel: "CX", ts: "1.2" },
      system: "the stored prompt, verbatim",
      tools: [],
      state: { checklist: "○ looking" },
    });
    await ledger.seed("run-old", "gen-OLD", [{ idx: 0, message: transcript[0] }]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      {
        step: 1,
        seq: 3,
        turnIndex: 2,
        inFlight: [{ callId: "s1", tool: "update_status" }],
        inboxConsumedSeq: 0,
        remainingMs: 240_000,
        turn: 1,
        iteration: 0,
      },
      [{ idx: 1, message: transcript[1] }],
    );
    // The final, text-only turn as its own step with nothing in flight (the
    // shape the pi mirror writes for pi's answer).
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 2, seq: 6, turnIndex: 4, inFlight: [], inboxConsumedSeq: 0, remainingMs: 200_000, turn: 2, iteration: 1 },
      [
        { idx: 2, message: transcript[2] },
        { idx: 3, message: transcript[3] },
      ],
    );
    await ledger.append("run-old", "gen-OLD", [
      { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
      { type: "run_meta", agent: "general", model: "anthropic/general-model", at: 2, seq: 2 },
      { type: "tool_call", tool: "update_status", summary: "s", at: 3, seq: 3 },
      { type: "run_note", kind: "stop_requested", summary: "soft stop requested", mode: "soft", at: 4, seq: 4 },
      { type: "run_note", kind: "stopped", summary: "soft stop", mode: "soft", at: 5, seq: 5 },
      { type: "tool_result", tool: "update_status", ok: true, summary: "ok", at: 6, seq: 6 },
    ]);
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);

    let providerCalls = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        providerCalls++;
        return { content: [{ type: "text", text: "never" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer, fallbackPuts, warnings } = wired(provider, { ledger });
    const plan = planResume({
      transcript: { complete: true, turns: 4, messages: transcript, compactions: [] },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("general")),
    });
    expect(plan).toMatchObject({ kind: "finish", answer: "What I found before the stop.", step: 2 });
    if (plan.kind !== "finish") throw new Error(plan.kind);
    const events = await ledger.readEvents("run-old");
    const { io, replies } = ioWithCard();
    await dispatch(deps, resumeMessage(reclaimed.row, "hello there"), io, {
      resume: { row: reclaimed.row, lastStep: reclaimed.lastStep!, plan, events, lastSeq: 6, repoCtx: {}, inbox: [] },
    });
    await writer.settled();

    expect(providerCalls).toBe(0);
    expect(replies.at(-1)).toMatch(/^⏹ _Stopped early by an operator \(soft stop\)/);
    expect(replies.at(-1)).toContain("What I found before the stop.");
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-old"]);
    expect(ledger.live.has("run-old")).toBe(false);
    const record = ledger.finished.get("run-old")!;
    expect(record.status).toBe("stopped_soft");
    expect(record.startedAt).toBe(5_000);
    expect(record.events.filter((e) => e.type === "input")).toHaveLength(1);
    expect(record.events.filter((e) => e.type === "answer")).toEqual([
      expect.objectContaining({ type: "answer", text: expect.stringContaining("What I found before the stop.") }),
    ]);
    expect(record.events.filter((e) => e.type === "run_note" && e.kind === "resumed")).toEqual([
      expect.objectContaining({ kind: "resumed", summary: expect.stringMatching(/had already answered/) }),
    ]);
    expect(fallbackPuts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a resume onto a thread that has a newer run in flight is never steered or refused as a follow-up: the reclaimed row is closed interrupted with no reply and no run", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
      },
      system: "sys",
      tools: [],
    });
    await ledger.seed("run-old", "gen-OLD", [
      { idx: 0, message: { role: "user", content: [{ type: "text", text: "hello there" }] } },
    ]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    await ledger.append("run-old", "gen-OLD", [{ type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 }]);
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    const { deps, registry, writer } = wired(capturingProvider("must not run"), { ledger });
    deps.admission = new ThreadAdmission();
    deps.admission.claim("slack:CX:1.0", { agent: "general" }); // the user re-mentioned the bot after the kill
    const plan = planResume({
      transcript: {
        complete: true,
        compactions: [],
        turns: 1,
        messages: reclaimed.row ? [{ role: "user", content: [{ type: "text", text: "hello there" }] }] : [],
      },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("general")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const { io, replies } = ioWithCard();
    await dispatch(deps, resumeMessage(reclaimed.row, "hello there"), io, {
      resume: {
        row: reclaimed.row,
        lastStep: reclaimed.lastStep!,
        plan,
        events: await ledger.readEvents("run-old"),
        lastSeq: 1,
        repoCtx: {},
        inbox: [],
      },
    });
    await writer.settled();
    expect(replies).toEqual([]); // no steer-ack, no refusal
    expect(registry.listActive()).toEqual([]);
    expect(ledger.live.has("run-old")).toBe(false);
    expect(ledger.finished.get("run-old")).toMatchObject({ status: "interrupted", eventCount: 1 });
  });

  it("a resumed dispatch that ends before its run starts (a repo refusal) closes the adopted row interrupted instead of leaving it for the sweep to relaunch forever", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      // UDEV may run the coding agent but is NOT on acme/api's repo allowlist (REPO_PERMS_YAML).
      meta: {
        channelId: "slack:CX",
        userId: "slack:UDEV",
        threadKey: "slack:CX:1.0",
        agent: "coding",
        model: "anthropic/coding-model",
        repo: "acme/api",
      },
      system: "sys",
      tools: [],
    });
    await ledger.seed("run-old", "gen-OLD", [
      { idx: 0, message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
    ]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    const provider = capturingProvider("must not run");
    const { deps, registry, writer } = wired(provider, { ledger, yaml: REPO_PERMS_YAML });
    const plan = planResume({
      transcript: {
        complete: true,
        compactions: [],
        turns: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }],
      },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("coding")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const { io, replies } = ioWithCard();
    await dispatch(deps, resumeMessage(reclaimed.row, "fix it"), io, {
      resume: {
        row: reclaimed.row,
        lastStep: reclaimed.lastStep!,
        plan,
        events: [],
        lastSeq: 0,
        repoCtx: { repo: "acme/api" },
        inbox: [],
      },
    });
    await writer.settled();
    expect(replies[0]).toContain("🚫"); // the refusal is still said, as for any dispatch
    expect(provider.requests).toEqual([]);
    expect(registry.listActive()).toEqual([]);
    expect(ledger.live.has("run-old")).toBe(false);
    expect(ledger.finished.get("run-old")?.status).toBe("interrupted");
  });

  // Feature: docs/reference/specs/run-history.md item 54: the row records where
  // the run's workspace is, a resume re-attaches there in reuse-only mode, and a
  // workspace that cannot be re-attached restarts the run explicitly: the resumed
  // row closes with the note that says why, no sandbox is provisioned in its
  // place, and the request runs again as a new run in the thread.
  it("the claim records the workspace binding on the row's state: the backend, the resident's worktree, pool user and container (item 54)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    residentFetchStub({
      attach: () =>
        new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t/main",
            ref: "main",
            sha: "abc",
            user: "worker2",
            container: "vm-1",
          }),
          { status: 200 },
        ),
    });
    const ledger = new InMemoryRunLedger(() => 10_000);
    let stateAtFirstCall: unknown;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        stateAtFirstCall ??= structuredClone(ledger.live.get("run-l")?.state);
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const { deps, writer } = wired(provider, { ledger, yaml: RESIDENT_YAML_FIXTURE });
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const { io } = ioWithCard();
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    await writer.settled();
    expect(stateAtFirstCall).toMatchObject({
      binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2", container: "vm-1" },
    });
  });

  it("a resume re-attaches its recorded resident worktree in reuse-only mode and continues the transcript; the row's binding is refreshed (item 54)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub({
      attach: (body) => {
        if (body.reuse !== true) throw new Error("a resume must attach in reuse-only mode");
        return new Response(
          JSON.stringify({
            workspace: "/workspace/threads/t/main",
            ref: "main",
            sha: "abc",
            user: "worker2",
            container: "vm-1",
            recreated: false,
          }),
          { status: 200 },
        );
      },
    });
    const ledger = new InMemoryRunLedger(() => 10_000);
    const request = msg("agent:coding fix it", "slack:UADMIN");
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UADMIN",
        threadKey: "slack:CX:1.0",
        agent: "coding",
        model: "anthropic/coding-model",
        repo: "acme/api",
        ref: "main",
        request: durableInboxMessage(request, request.text, 4_000),
      },
      system: "sys",
      tools: [],
      // A row from before the container was recorded: the re-attach completes it.
      state: { binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2" } },
    });
    await ledger.seed("run-old", "gen-OLD", [
      { idx: 0, message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
    ]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    let stateAtFirstCall: unknown;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        stateAtFirstCall ??= structuredClone(ledger.live.get("run-old")?.state);
        return { content: [{ type: "text", text: "resumed and done" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer } = wired(provider, { ledger, yaml: RESIDENT_YAML_FIXTURE });
    const plan = planResume({
      transcript: {
        complete: true,
        compactions: [],
        turns: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }],
      },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("coding")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const { io, replies } = ioWithCard();
    await dispatch(deps, resumeMessage(reclaimed.row, "fix it"), io, {
      resume: {
        row: reclaimed.row,
        lastStep: reclaimed.lastStep!,
        plan,
        events: [],
        lastSeq: 0,
        repoCtx: { repo: "acme/api", ref: "main" },
        inbox: [],
      },
    });
    await writer.settled();
    expect(replies.at(-1)).toBe("resumed and done");
    const attaches = calls.filter((c) => c.path === "/status" || c.path === "/attach");
    expect(attaches.map((c) => c.path)).toEqual(["/status", "/attach"]);
    expect(attaches[1].body).toMatchObject({ reuse: true, refHint: "main" });
    expect(stateAtFirstCall).toMatchObject({
      binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2", container: "vm-1" },
    });
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-old"]);
    expect(ledger.finished.get("run-old")?.status).toBe("completed");
  });

  it("a resume whose recorded resident refuses to reuse the worktree provisions no sandbox: the resumed row closes interrupted with the note that says why, and the request runs again as a new run once the thread is free (item 54)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub({
      attach: (body) =>
        body.reuse === true
          ? new Response(
              JSON.stringify({ error: "reuse-refused: no worktree at /workspace/threads/t/main", needs: "recreate" }),
              { status: 409 },
            )
          : new Response(
              JSON.stringify({ workspace: "/workspace/threads/t/main", ref: "main", sha: "abc", user: "worker3" }),
              { status: 200 },
            ),
    });
    const ledger = new InMemoryRunLedger(() => 10_000);
    const request = msg("agent:coding fix it", "slack:UADMIN");
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UADMIN",
        threadKey: "slack:CX:1.0",
        agent: "coding",
        model: "anthropic/coding-model",
        repo: "acme/api",
        ref: "main",
        request: durableInboxMessage(request, request.text, 4_000),
      },
      system: "sys",
      tools: [],
      state: { binding: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2" } },
    });
    await ledger.seed("run-old", "gen-OLD", [
      { idx: 0, message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
    ]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    await ledger.append("run-old", "gen-OLD", [{ type: "input", messageId: "m1", text: "fix it", at: 1, seq: 1 }]);
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    const provider = capturingProvider("started over and done");
    const { deps, registry, writer } = wired(provider, { ledger, yaml: RESIDENT_YAML_FIXTURE });
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const plan = planResume({
      transcript: {
        complete: true,
        compactions: [],
        turns: 1,
        messages: [{ role: "user", content: [{ type: "text", text: "fix it" }] }],
      },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("coding")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const events = await ledger.readEvents("run-old");
    const { io, replies } = ioWithCard();
    const outcome = await dispatch(deps, resumeMessage(reclaimed.row, "fix it"), io, {
      resume: {
        row: reclaimed.row,
        lastStep: reclaimed.lastStep!,
        plan,
        events,
        lastSeq: 1,
        repoCtx: { repo: "acme/api", ref: "main" },
        inbox: [],
      },
    });
    await writer.settled();
    // The resumed dispatch itself ran nothing: refused by name, its row closed with the note in its record.
    expect(outcome.status).toBe("refused");
    expect(outcome.refusal).toBe("workspace_lost");
    const closed = ledger.finished.get("run-old");
    expect(closed?.status).toBe("interrupted");
    const note = closed?.events.find((e) => e.type === "run_note") as { kind: string; summary: string } | undefined;
    expect(note).toMatchObject({ kind: "resumed" });
    expect(note?.summary).toContain("could not be re-attached");
    expect(note?.summary).toContain("reuse-refused: no worktree at /workspace/threads/t/main");
    expect(note?.summary).toContain("restarts from its request as a new run");
    // Never a sandbox for the resumed run: the resident alone was asked, in reuse-only mode; then the
    // restarted run attached as a fresh run does (no reuse), on its own id, and answered the thread.
    const attaches = calls.filter((c) => c.path === "/status" || c.path === "/attach");
    expect(attaches.map((c) => c.path)).toEqual(["/status", "/attach", "/status", "/attach"]);
    expect(attaches[1].body).toMatchObject({ reuse: true });
    expect(attaches[3].body).not.toHaveProperty("reuse");
    expect(calls.every((c) => c.host === "resident.example")).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(replies.at(-1)).toBe("started over and done");
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-l"]);
    expect(ledger.finished.get("run-l")?.status).toBe("completed");
    expect(ledger.live.has("run-old")).toBe(false);
  });

  // Feature: docs/reference/specs/harness-pi.md item 16 — a container replaced
  // under a live pi run ends the way a refused re-attach does (item 54): the
  // row closes `interrupted` with the note that says why, no failure reply,
  // and the request runs again as a new run once the thread is free.
  it("a live pi run whose resident container is replaced under it closes interrupted with the sandbox_restarted note and no ❌, and its request runs again as a new run once the thread is free — the outcome a refused re-attach has (item 54)", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const { calls } = residentFetchStub();
    const ledger = new InMemoryRunLedger(() => 10_000);
    const provider = capturingProvider("started over and done");
    let n = 0;
    const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}` });
    const store = new InMemoryRunStore();
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const deps = makeDeps(RESIDENT_YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-T",
      fallback: { put: async () => {} },
      warn: () => {},
    });
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const harnesses = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: Date.now });
    deps.runBearers = bearers;
    /** The first run's pi opens one bash call and dies with its container, which names itself anew; the restarted run's pi is scripted from the provider. */
    const containers: FakePiContainer[] = [];
    deps.harness = {
      registry: harnesses,
      harnessUrl: "https://bot.test",
      loopbackUrl: "http://127.0.0.1:8080",
      containerFor: () => {
        const container = new FakePiContainer();
        containers.push(container);
        if (containers.length > 1) {
          scriptPiFromProvider(container, {
            provider,
            registry: harnesses,
            bearers,
            beforeModelCall: () => realSleep(10),
          });
          return container;
        }
        container.onStdin = (line, c) => {
          const cmd = JSON.parse(line) as Record<string, unknown>;
          if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
            c.emit({
              id: cmd.id,
              type: "response",
              command: cmd.type,
              success: true,
              data: { sessionFile: "s.jsonl" },
            });
          if (cmd.type !== "prompt") return;
          const call = {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
            stopReason: "toolUse",
          };
          c.emit(
            { id: cmd.id, type: "response", command: "prompt", success: true },
            { type: "agent_start" },
            { type: "message_end", message: call },
            { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
          );
          authorizeToolCall(harnesses.get("run-1")!, {
            toolCallId: "c1",
            tool: "bash",
            input: { command: "npm test" },
          });
          // The resident's container rolls under the run: the executor waits for the wake, re-attaches to the
          // replacement — which names itself anew — and hands the probe back as the restart (resident-repos item 65).
          c.vm = "vm-new";
          c.alive = async () => {
            throw new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
          };
        };
        return container;
      },
      pollMs: 1,
      tickMs: 5,
      sleep: realSleep,
    };
    const { io, replies } = ioWithCard();
    const outcome = await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    await writer.settled();
    // The interrupted run: the same outcome shape as a refused re-attach, its row closed with the note in its record, no failure reply.
    expect(outcome).toEqual({ status: "refused", refusal: "container_replaced" });
    const closed = ledger.finished.get("run-1");
    expect(closed?.status).toBe("interrupted");
    const note = closed?.events.find((e) => e.type === "run_note") as { kind: string; summary: string } | undefined;
    expect(note).toMatchObject({
      kind: "sandbox_restarted",
      summary:
        "the container running pi was replaced (vm-fake → vm-new; the executor said: the sandbox restarted under the run (waited 42 s)); the run restarts from its request",
    });
    expect(closed?.events.find((e) => e.type === "tool_result")).toMatchObject({
      tool: "bash",
      ok: false,
      callId: "c1",
    });
    expect(replies.some((r) => r.startsWith("❌"))).toBe(false);
    expect(containers[0]!.killed).toEqual([]); // a pid in the new container is a stranger's
    // The restarted run: the original request, attached as a fresh run is, on its own id, answering the thread.
    expect(containers).toHaveLength(2);
    expect(provider.requests).toHaveLength(1);
    expect(textTurnsOf(provider.requests[0]!.messages).at(-1)).toMatchObject({
      role: "user",
      text: expect.stringContaining("fix it"),
    });
    expect(replies.at(-1)).toBe("started over and done");
    const attaches = calls.filter((c) => c.path === "/status" || c.path === "/attach");
    expect(attaches.map((c) => c.path)).toEqual(["/status", "/attach", "/status", "/attach"]);
    expect(attaches[1]!.body).not.toHaveProperty("reuse");
    expect(attaches[3]!.body).not.toHaveProperty("reuse");
    expect(ledger.finished.get("run-2")?.status).toBe("completed");
    expect(ledger.live.has("run-1")).toBe(false);
    expect(registry.getById("run-1")).toMatchObject({ finished: true, status: "interrupted" });
    expect(registry.getById("run-2")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a steered follow-up is written to the run's durable inbox with its seq, and the next step record says the run consumed it (thread-admission item 5, run-history item 40)", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const stepRecords: StepRecord[] = [];
    const origStep = ledger.step.bind(ledger);
    ledger.step = async (runId, gen, record, turns) => {
      stepRecords.push(record);
      return origStep(runId, gen, record, turns);
    };
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        calls++;
        if (calls === 1) {
          firstStarted();
          await gate;
        }
        if (calls <= 2) {
          return {
            content: [{ type: "tool_use", id: `s${calls}`, name: "update_status", input: { checklist: `○ ${calls}` } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const { deps, registry, writer } = wired(provider, { ledger });
    deps.admission = new ThreadAdmission();
    const first = ioWithCard();
    const run = dispatch(deps, msg("write the report"), first.io);
    await started; // the run is registered, its row claimed, its first model call in flight
    const second = fakeIO();
    await dispatch(
      deps,
      {
        ...msg("and also the numbers", "slack:UY"),
        userName: "uy",
        sourceUrl: "https://s/2",
        images: [{ mediaType: "image/png", data: "QUJD", name: "chart.png" }],
      },
      second.io,
    );
    expect(second.replies[0]).toMatch(/^↪ Folded into the \*general\* run already in flight/);
    // The durable copy: the message with its (small) attachment, under the ledger's seq.
    expect(ledger.inbox.get("run-l")!.map((i) => [i.seq, i.message])).toEqual([
      [
        1,
        expect.objectContaining({
          text: "and also the numbers",
          userId: "slack:UY",
          userName: "uy",
          sourceUrl: "https://s/2",
          threadKey: "slack:CX:1.0",
          channelId: "slack:CX",
          images: [{ mediaType: "image/png", data: "QUJD", name: "chart.png" }],
        }),
      ],
    ]);
    release();
    await run;
    await writer.settled();
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-l"]); // no rival run
    expect(first.replies.at(-1)).toBe("done");
    // Step 1's record precedes the boundary the follow-up rode; step 2's, the
    // turn after pi echoed the steer, says it was consumed; the mirror records
    // the final text turn as a step of its own (harness-pi item 8).
    expect(stepRecords.map((s) => [s.step, s.inboxConsumedSeq])).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
    ]);
    expect(
      ledger.finished.get("run-l")!.events.some((e) => e.type === "input" && e.text === "and also the numbers"),
    ).toBe(true);
  });

  it("a follow-up on a thread whose live run is on the ledger but not in this process (the boot gap) is steered into that run's durable inbox and acked — no card, no second run; a row the ledger no longer has means a fresh run and the thread is forgotten", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    await ledger.claim({
      runId: "run-far",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0", agent: "general" },
      card: null,
      system: "sys",
      tools: [],
    });
    const { deps, registry } = wired(capturingProvider("fresh answer"), { ledger });
    const elsewhere = new ThreadsElsewhere();
    elsewhere.replace([{ threadKey: "slack:CX:1.0", runId: "run-far", startedAt: 5_000, meta: { agent: "general" } }]);
    deps.threadsElsewhere = elsewhere;
    deps.admission = new ThreadAdmission();
    const a = fakeIO();
    await dispatch(deps, { ...msg("and also the numbers", "slack:UY"), userName: "uy" }, a.io);
    expect(a.statuses).toEqual([]); // no card
    expect(registry.listActive()).toEqual([]); // no run here
    expect(a.replies).toHaveLength(1);
    expect(a.replies[0]).toMatch(/^↪ Folded into the \*general\* run already in flight in this thread/);
    expect(a.replies[0]).not.toContain(" · "); // no run link: the run page token is the other generation's
    expect(ledger.inbox.get("run-far")!.map((i) => [i.seq, i.message.text, i.message.userName])).toEqual([
      [1, "and also the numbers", "uy"],
    ]);
    expect(deps.admission.size).toBe(0); // the in-process slot was released
    // The map is stale — the other generation finished the run — so the push is
    // refused; the message runs fresh and the thread is forgotten.
    ledger.live.delete("run-far");
    const b = fakeIO();
    await dispatch(deps, msg("start over", "slack:UY"), b.io);
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-l"]);
    expect(b.replies.at(-1)).toBe("fresh answer");
    expect(elsewhere.get("slack:CX:1.0")).toBeUndefined();
  });

  // routing-and-config item 20: a redispatch is a request of its own, but the
  // same message — a spawned child that takes the boot-gap path stays its
  // parent's child.
  it("a spawned child whose thread the boot-gap map names with a row the ledger no longer has is redispatched WITH its parent and its seed: the fresh run carries parentRunId, the parent's clock as its boundary, and starts from the parent's turns", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const provider = capturingProvider("child answer");
    const { deps, registry, store, writer } = wired(provider, { ledger });
    const elsewhere = new ThreadsElsewhere();
    // A stale entry for the child's thread: the row is gone, so the durable push
    // is refused and the message runs fresh (the redispatch).
    elsewhere.replace([
      { threadKey: "slack:CX:9.0", runId: "run-gone", startedAt: 5_000, meta: { agent: "research" } },
    ]);
    deps.threadsElsewhere = elsewhere;
    deps.admission = new ThreadAdmission();
    const io = fakeIO();
    await dispatch(
      deps,
      { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:9.0", text: "agent:research what changed?" },
      io.io,
      {
        parent: { runId: "run-p", depth: 1, remainingMs: 5 * 60_000 },
        seed: [{ role: "user", text: "look into durable objects" }],
      },
    );
    await writer.settled();
    expect(io.replies.at(-1)).toBe("child answer");
    expect(registry.getById("run-l")).toMatchObject({ agent: "research", parentRunId: "run-p", seed: "parent" });
    expect(await store.get("run-l")).toMatchObject({
      parentRunId: "run-p",
      seed: "parent",
      profile: { preset: "research", machine: "none", identity: "none", minutes: 5, boundedBy: "parent" },
    });
    // The redispatch carried the seed: the fresh run's model started from the parent's turn, then the request.
    expect(provider.requests).toHaveLength(1);
    // The two text parts reach pi as one prompt, joined with a blank line (harness-pi item 9).
    const opening = provider.requests[0].messages[0].content as Array<{ type: string; text?: string }>;
    expect(opening.map((p) => p.text)).toEqual(["look into durable objects\n\nwhat changed?"]);
    expect(elsewhere.get("slack:CX:9.0")).toBeUndefined();
  });

  it("a resumed run inherits the follow-ups the durable inbox holds past its last record (item 40) — the reclaim's snapshot plus what landed before the launch, re-read at adopt: folded in at its first boundary, recorded as inputs; the ack was the admitting generation's, none is sent again", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    const transcript: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hello there" }] }];
    await ledger.claim({
      runId: "run-old",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
      },
      card: { channel: "CX", ts: "1.2" },
      system: "the stored prompt, verbatim",
      tools: [],
      state: {},
    });
    await ledger.seed("run-old", "gen-OLD", [{ idx: 0, message: transcript[0] }]);
    await ledger.step(
      "run-old",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    await ledger.append("run-old", "gen-OLD", [{ type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 }]);
    await ledger.pushInbox("run-old", {
      channelId: "slack:CX",
      userId: "slack:UY",
      userName: "uy",
      threadKey: "slack:CX:1.0",
      text: "and also the numbers",
      sourceUrl: "https://s/2",
      at: 9_000,
    });
    await ledger.pushInbox("run-old", { garbage: true }); // an item the parser cannot read is skipped, not fatal
    ledger.live.get("run-old")!.leaseUntil = 0;
    const [reclaimed] = await ledger.reclaim("gen-T", 10_000, 30_000);
    expect(reclaimed.inbox.map((i) => i.seq)).toEqual([1, 2]);
    // Landed AFTER the reclaim's snapshot, before the launch (the boot gap's
    // durable steer): the resume re-reads the inbox at adopt time (review F1).
    await ledger.pushInbox("run-old", {
      channelId: "slack:CX",
      userId: "slack:UZ",
      threadKey: "slack:CX:1.0",
      text: "and the dates",
      at: 9_500,
    });
    const requests: ChatMessage[][] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(structuredClone(req.messages));
        return {
          content: [{ type: "text", text: requests.length === 1 ? "resumed" : "with the numbers" }],
          stopReason: "end_turn",
        };
      },
    };
    const { deps, writer } = wired(provider, { ledger });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plan = planResume({
      transcript: { complete: true, turns: 1, messages: transcript, compactions: [] },
      lastStep: reclaimed.lastStep!,
      tools: knownToolsFor(getAgent("general")),
    });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    const { io, replies } = ioWithCard();
    await dispatch(deps, resumeMessage(reclaimed.row, "hello there"), io, {
      resume: {
        row: reclaimed.row,
        lastStep: reclaimed.lastStep!,
        plan,
        events: await ledger.readEvents("run-old"),
        lastSeq: 1,
        repoCtx: {},
        inbox: reclaimed.inbox,
      },
    });
    await writer.settled();
    // The first answer was superseded by the pending follow-up (thread-admission
    // item 3); the second model call saw it as the next user turn.
    expect(requests).toHaveLength(2);
    const last = requests[1].at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("and also the numbers");
    expect(JSON.stringify(last.content)).toContain("and the dates"); // the late item, folded in with the snapshot's
    expect(replies.filter((r) => r.startsWith("↪"))).toEqual([]); // no second ack
    expect(replies.at(-1)).toBe("with the numbers");
    const record = ledger.finished.get("run-old")!;
    expect(record.events.filter((e) => e.type === "input").map((e) => e.text)).toEqual([
      "hello there",
      "and also the numbers",
      "and the dates",
    ]);
    expect(record.events.find((e) => e.type === "input" && e.text === "and also the numbers")).toMatchObject({
      source: { user: "uy", url: "https://s/2" },
    });
    expect(
      warnSpy.mock.calls.some((c) => /inbox item 2 has a shape this build cannot read — skipped/.test(String(c[0]))),
    ).toBe(true);
    warnSpy.mockRestore();
  });

  it("a steer whose run finished during the durable push does not land on a dead slot: the follow-up runs fresh instead (review F2)", async () => {
    const inner = new InMemoryRunLedger(() => 10_000);
    let releasePush!: () => void;
    const pushGate = new Promise<void>((r) => (releasePush = r));
    let pushReached!: () => void;
    const pushStarted = new Promise<void>((r) => (pushReached = r));
    const ledger = new Proxy(inner, {
      get(target, prop) {
        if (prop === "pushInbox") {
          return async (runId: string, message: Record<string, unknown>) => {
            pushReached();
            await pushGate;
            return target.pushInbox(runId, message);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as InMemoryRunLedger;
    let calls = 0;
    let answerFirst!: () => void;
    const firstGate = new Promise<void>((r) => (answerFirst = r));
    let firstReached!: () => void;
    const firstStarted = new Promise<void>((r) => (firstReached = r));
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (++calls === 1) {
          firstReached();
          await firstGate;
        }
        return { content: [{ type: "text", text: `answer ${calls}` }], stopReason: "end_turn" };
      },
    };
    const { deps, writer } = wired(provider, { ledger });
    let n = 0;
    const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => "tok" });
    deps.runRegistry = registry;
    deps.admission = new ThreadAdmission();
    const first = ioWithCard();
    const run1 = dispatch(deps, msg("write the report"), first.io);
    await firstStarted;
    const second = fakeIO();
    const steer = dispatch(deps, msg("and also the numbers", "slack:UY"), second.io);
    await pushStarted; // the steer is inside the ledger round trip, holding nothing but a reference to the slot
    answerFirst();
    await run1; // the run finished and released the thread meanwhile
    releasePush();
    await steer;
    await writer.settled();
    // No ack for a fold-in that could never happen; the follow-up ran as its own run.
    expect(second.replies.some((r) => r.startsWith("↪"))).toBe(false);
    expect(second.replies.at(-1)).toBe("answer 2");
    expect(
      registry
        .listActive()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["run-1", "run-2"]);
    expect(registry.snapshotById("run-2")!.events.find((e) => e.type === "input")).toMatchObject({
      text: "and also the numbers",
    });
  });

  it("the boot-gap steer holds no slot across the ledger round trip; a resume that claims the thread meanwhile names its run id at the claim, so a push landing after its re-read reaches it in memory — folded in once (review F1's window at the launch edge)", async () => {
    // The row a resume is about to take up: claimed, seeded, one record, one
    // event; reclaimed by this generation and (as the sweep would) listed in
    // the map until the launch claims the thread in-process.
    const inner = new InMemoryRunLedger(() => 10_000);
    const transcript: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hello there" }] }];
    await inner.claim({
      runId: "run-far",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: "slack:CX:1.0",
        agent: "general",
        model: "anthropic/general-model",
      },
      card: { channel: "CX", ts: "1.2" },
      system: "the stored prompt, verbatim",
      tools: [],
      state: {},
    });
    await inner.seed("run-far", "gen-OLD", [{ idx: 0, message: transcript[0] }]);
    await inner.step(
      "run-far",
      "gen-OLD",
      { step: 0, seq: 0, turnIndex: 1, inFlight: [], inboxConsumedSeq: 0, remainingMs: 300_000, turn: 0, iteration: 0 },
      [],
    );
    await inner.append("run-far", "gen-OLD", [{ type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 }]);
    inner.live.get("run-far")!.leaseUntil = 0;
    const [reclaimed] = await inner.reclaim("gen-T", 10_000, 30_000);
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const requests: ChatMessage[][] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(structuredClone(req.messages));
        return {
          content: [{ type: "text", text: requests.length === 1 ? "resumed" : "with the numbers" }],
          stopReason: "end_turn",
        };
      },
    };
    let deps!: CoreDeps;
    let resumeRun: Promise<DispatchOutcome> | undefined;
    let slotAtResumeClaim: "free" | "taken" | undefined;
    // The resumed dispatch is held between its claim (and re-read) and its card
    // — in production the card, the repo resolution and the workspace attach
    // take seconds, and the registry row (whose id would name the run on the
    // slot) is created only after them. Here nothing else would take time.
    let landed!: () => void;
    const pushLanded = new Promise<void>((r) => (landed = r));
    const base = ioWithCard();
    const resumeIo = {
      replies: base.replies,
      io: {
        ...base.io,
        status: async (...args: Parameters<ChannelIO["status"]>) => {
          await pushLanded;
          return base.io.status(...args);
        },
      } satisfies ChannelIO,
    };
    let reread = false;
    let atPush: { slot: boolean; registryRow: boolean; slotStartedAt: number | undefined } | undefined;
    const ledger = new Proxy(inner, {
      get(target, prop) {
        if (prop === "readInbox") {
          return async (runId: string, afterSeq: number) => {
            const items = await target.readInbox(runId, afterSeq);
            reread = true;
            return items;
          };
        }
        if (prop === "pushInbox") {
          return async (runId: string, message: Record<string, unknown>) => {
            // The resume launches while the steer's push is in flight — the
            // production interleaving (`launchResumes` follows the sweep at
            // once). Its dispatch must find the thread FREE; it claims and
            // re-reads the inbox BEFORE this push lands, so only the hand-off can
            // deliver the item — and only if the slot already names the run.
            slotAtResumeClaim = admission.get("slack:CX:1.0") ? "taken" : "free";
            const plan = planResume({
              transcript: { complete: true, turns: 1, messages: transcript, compactions: [] },
              lastStep: reclaimed.lastStep!,
              tools: knownToolsFor(getAgent("general")),
            });
            if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
            resumeRun = dispatch(deps, resumeMessage(reclaimed.row, "hello there"), resumeIo.io, {
              resume: {
                row: reclaimed.row,
                lastStep: reclaimed.lastStep!,
                plan,
                events: await inner.readEvents("run-far"),
                lastSeq: 1,
                repoCtx: {},
                inbox: reclaimed.inbox,
              },
            });
            // Until the resume has claimed the thread and named its run on the slot.
            for (let i = 0; !reread; i++) {
              if (i > 1_000) throw new Error("the resume never re-read the inbox");
              await new Promise((r) => setTimeout(r, 0));
            }
            // Observed here, asserted below: an assertion thrown inside a ledger
            // call would be swallowed by the write-through's own try/catch.
            atPush = {
              slot: admission.get("slack:CX:1.0") !== undefined,
              registryRow: !!deps.runRegistry?.getById("run-far"),
              slotStartedAt: admission.get("slack:CX:1.0")?.startedAt,
            };
            const result = await target.pushInbox(runId, message);
            landed();
            return result;
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as InMemoryRunLedger;
    const wiredDeps = wired(provider, { ledger });
    deps = wiredDeps.deps;
    const elsewhere = new ThreadsElsewhere();
    elsewhere.replace([{ threadKey: "slack:CX:1.0", runId: "run-far", startedAt: 5_000, meta: { agent: "general" } }]);
    deps.threadsElsewhere = elsewhere;
    deps.admission = admission;
    const a = fakeIO();
    await dispatch(deps, { ...msg("and also the numbers", "slack:UY"), userName: "uy" }, a.io);
    expect(slotAtResumeClaim).toBe("free"); // released before the round trip
    // The push landed after the claim, before the registry row; the slot carries the
    // row's ORIGINAL start (5_000), so a steer ack's elapsed time is the run's, not the resume's.
    expect(atPush).toEqual({ slot: true, registryRow: false, slotStartedAt: 5_000 });
    expect(a.replies).toEqual([expect.stringMatching(/^↪ Folded into the \*general\* run/)]);
    await resumeRun;
    await wiredDeps.writer.settled();
    // The resumed run got the follow-up exactly once — by the hand-off, since
    // its re-read ran before the push landed — and answered the thread once.
    expect(requests).toHaveLength(2); // "resumed" superseded by the pending follow-up, then the answer
    expect(JSON.stringify(requests[1].at(-1)!.content)).toContain("and also the numbers");
    const record = inner.finished.get("run-far")!;
    expect(record.status).toBe("completed");
    expect(record.events.filter((e) => e.type === "input").map((e) => e.text)).toEqual([
      "hello there",
      "and also the numbers",
    ]);
    expect(resumeIo.replies.at(-1)).toBe("with the numbers");
    expect(resumeIo.replies.filter((r) => r.startsWith("↪"))).toEqual([]); // the steer's ack was the only one
  });

  it("a row live elsewhere whose meta names no agent is not steered into — the no-agent-switch gate cannot be judged, so the message runs fresh (review F3)", async () => {
    const ledger = new InMemoryRunLedger(() => 10_000);
    await ledger.claim({
      runId: "run-far",
      threadKey: "slack:CX:1.0",
      gen: "gen-OLD",
      leaseMs: 30_000,
      startedAt: 5_000,
      meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: "slack:CX:1.0" },
      card: null,
      system: "sys",
      tools: [],
    });
    const { deps, registry } = wired(capturingProvider("fresh answer"), { ledger });
    const elsewhere = new ThreadsElsewhere();
    elsewhere.replace([{ threadKey: "slack:CX:1.0", runId: "run-far", startedAt: 5_000, meta: {} }]);
    deps.threadsElsewhere = elsewhere;
    deps.admission = new ThreadAdmission();
    const a = fakeIO();
    await dispatch(deps, msg("and also the numbers", "slack:UY"), a.io);
    expect(a.replies.at(-1)).toBe("fresh answer");
    expect(registry.listActive().map((r) => r.id)).toEqual(["run-l"]);
    expect(ledger.inbox.get("run-far")).toBeUndefined();
  });

  it("a fenced finishing means another generation owns the run: nothing more reaches the thread and no record is written from here — the run is theirs (D9)", async () => {
    const inner = new InMemoryRunLedger();
    const ledger = new Proxy(inner, {
      get(target, prop) {
        // The other generation holds the row: finishing AND finish are fenced here.
        if (prop === "finishing" || prop === "finish") return async () => ({ ok: false, reason: "fenced" });
        const v = target[prop as keyof InMemoryRunLedger];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as InMemoryRunLedger;
    const { deps, writer, fallbackPuts, warnings } = wired(capturingProvider("the answer"), { ledger });
    const { io, replies } = ioWithCard();
    await dispatch(deps, msg("hello there"), io);
    await writer.settled();
    expect(replies).toEqual([]); // the other generation answers
    expect(warnings.some((w) => /another generation owns this run; no reply from here/.test(w))).toBe(true);
    // No record from here either: the run is the other generation's now, and its record is theirs to write —
    // a partial record from this process would race (and could clobber) the real finish.
    expect(fallbackPuts).toEqual([]);
    expect(inner.finished.has("run-l")).toBe(false);
    // The stream here is still sealed — by the outer finally's backstop, with
    // no reply attempted from this generation.
    const row = deps.runRegistry!.getById("run-l"); // `wired` hands the dispatch its registry
    expect(row).toMatchObject({ finished: true });
    expect(row?.sealedAt).toBeDefined();
    expect(row?.replyOk).toBeUndefined();
  });

  it("a review's verdict lands in the run's ledger state as it is submitted", async () => {
    const ledger = new InMemoryRunLedger();
    let stateAtSecondCall: unknown;
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0)
          return {
            content: [
              {
                type: "tool_use",
                id: "v1",
                name: "submit_verdict",
                input: { verdict: "request_changes", summary: "two findings" },
              },
            ],
            stopReason: "tool_use",
          };
        stateAtSecondCall = structuredClone(ledger.live.get("run-l")?.state);
        return { content: [{ type: "text", text: "findings" }], stopReason: "end_turn" };
      },
    };
    const { deps, writer } = wired(provider, { ledger });
    await dispatch(deps, msg("agent:review look at this", "slack:UADMIN"), ioWithCard().io);
    await writer.settled();
    expect(stateAtSecondCall).toMatchObject({ verdict: { verdict: "request_changes", summary: "two findings" } }); // beside the harness facts
    expect(ledger.finished.get("run-l")?.status).toBe("completed");
  });
});

// Feature: docs/reference/specs/tracing.md — the no-gaps test. Every awaited fake runs
// under a `span(fn)` (a `null` span is a gap), the clock advances only when a
// fake settles, and the window then partitions into exactly the ticks each
// bucket's spans spent: overhead is the ticks under uncounted spans that no
// counted span covers (none on these paths) plus the background-only time.
describe("no gaps: every awaited step runs inside a span (docs/reference/specs/tracing.md)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  function traced(provider: Provider, fixture = YAML_FIXTURE) {
    const clock = createTickingClock(1_700_000_000_000);
    const als = createAlsContext();
    const { ticks, timed } = timedFakes(clock, als);
    const log = recordingSink();
    const deps = makeDeps(fixture, {
      name: provider.name,
      complete: timed("provider.complete", (req: CompletionRequest) => provider.complete(req)),
    });
    deps.clock = clock.now;
    deps.tracer = createTracer({ clock: clock.now, context: als.context });
    deps.sinks = [log];
    const registry = new RunRegistry({ genId: () => "run-g", genToken: () => "tok", now: clock.now });
    deps.runRegistry = registry;
    const replies: string[] = [];
    const statuses: StatusUpdate[] = [];
    const io: ChannelIO = {
      reply: timed("io.reply", async (t: string) => void replies.push(t)),
      status: timed("io.status", async (initial: StatusUpdate) => {
        statuses.push(initial);
        return {
          update: (f: StatusUpdate) => void statuses.push(f),
          done: timed("card.done", async (f: StatusUpdate) => void statuses.push(f)),
        };
      }),
      history: timed("io.history", async () => []),
    };
    return { clock, ticks, log, deps, registry, io, replies, statuses, timed };
  }

  /** The bucket a tick's time lands in: its span's class, or its nearest streamed ancestor's. */
  function bucketOf(tick: Tick, records: readonly SpanRecord[]): string {
    const byId = new Map(records.map((r) => [r.spanId, r]));
    let cur = tick.spanId ? byId.get(tick.spanId) : undefined;
    while (cur && !isStreamed(cur.name)) cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
    if (!cur) return "gap";
    const c = classOf(cur.name, "agent");
    return c?.kind === "counted" ? c.bucket : (c?.kind ?? "gap");
  }

  /** The partition over the request's streamed spans and its window; the ticks
   *  inside the window, by bucket, are what it must sum to. */
  function check(log: ReturnType<typeof recordingSink>, ticks: Tick[], window: { start: number; end: number }) {
    const streamed = log.ends.filter((r) => isStreamed(r.name) && r.name !== "request");
    const p = partition(streamed, { window, owner: "agent", finished: true, losses: [] });
    // A tick's second starts at its `at` (the clock advances after the fake settles).
    const inWindow = ticks.filter((t) => t.at >= window.start && t.at < window.end);
    const spent = (bucket: string) => inWindow.filter((t) => bucketOf(t, log.ends) === bucket).length * 1000;
    expect(ticks.every((t) => t.span !== null)).toBe(true); // the load-bearing line: no await outside a span
    expect(p).toMatchObject({
      windowMs: window.end - window.start,
      gettingReadyMs: spent("getting_ready"),
      thinkingMs: spent("thinking"),
      toolsMs: spent("tools"),
      finishingUpMs: spent("finishing_up"),
      overheadMs: spent("uncounted") + p.backgroundOnlyMs,
    });
    return p;
  }

  it("a general run: history, ack, the model turn, the card close and the reply each under their span; the window is getting ready + thinking, no overhead", async () => {
    const { ticks, log, deps, registry, io } = traced(capturingProvider("answer"));
    await dispatch(deps, msg("hello there"), io);
    expect(ticks.map((t) => [t.dep, t.span])).toEqual([
      ["io.history", "dispatch.history"],
      ["io.status", "dispatch.ack_card"],
      ["provider.complete", "model.turn"],
      ["card.done", "post.card_close"],
      ["io.reply", "post.reply"],
    ]);
    const root = log.ended("request")!;
    expect(root.attrs).toEqual({ channel: "slack", runId: "run-g", status: "completed" });
    const run = registry.getById("run-g")!;
    expect(run.receivedAt).toBe(root.startedAt);
    const p = check(log, ticks, { start: root.startedAt, end: run.finishedAt! });
    expect(p).toMatchObject({ gettingReadyMs: 2000, thinkingMs: 1000, overheadMs: 0 });
    // The post-finish ticks (the close, the reply) are outside the window by construction.
    expect(root.endedAt).toBeGreaterThan(run.finishedAt!);
  });

  it("a coding run with a tool: the attach, the tool's executor call and the workspace probes land in getting ready, tools and finishing up", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    let n = 0;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        if (n++ === 0) {
          return {
            content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }],
            stopReason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
      },
    };
    const { ticks, log, deps, registry, io, timed } = traced(provider, REMOTE_YAML_FIXTURE);
    const executor = {
      exec: timed("executor.exec", async () => ""),
      readFile: async () => "",
      writeFile: async () => "",
    };
    vi.mocked(makeExecutor).mockImplementationOnce(
      timed("makeExecutor", async () => ({ executor, backend: "sandbox" as const })),
    );
    await dispatch(deps, msg("agent:coding fix it", "slack:UADMIN"), io);
    const pairs = new Set(ticks.map((t) => `${t.dep} → ${t.span}`));
    expect(pairs).toEqual(
      new Set([
        "io.history → dispatch.history",
        "io.status → dispatch.ack_card",
        "makeExecutor → dispatch.workspace.attach",
        "provider.complete → model.turn",
        "executor.exec → exec.exec", // the tool's own call: log-only, under tool.bash
        "executor.exec → run.observe_workspace", // the post-run probes
        "card.done → post.card_close",
        "io.reply → post.reply",
      ]),
    );
    const root = log.ended("request")!;
    const run = registry.getById("run-g")!;
    const p = check(log, ticks, { start: root.startedAt, end: run.finishedAt! });
    expect(p.gettingReadyMs).toBe(3000);
    expect(p.thinkingMs).toBe(2000);
    expect(p.toolsMs).toBe(1000);
    expect(p.finishingUpMs).toBeGreaterThan(0);
    expect(p.overheadMs).toBe(0);
    expect(log.ended("dispatch.workspace.attach")!.attrs).toEqual({ backend: "sandbox" });
  });

  it("a refusal (the agent allowlist): the reply is a dispatch.refuse span, the root ends refused with no run", async () => {
    const { ticks, log, deps, io } = traced(capturingProvider());
    await dispatch(deps, msg("agent:coding fix it"), io); // slack:UX may not run coding
    expect(ticks.map((t) => [t.dep, t.span])).toEqual([
      ["io.history", "dispatch.history"],
      ["io.reply", "dispatch.refuse"],
    ]);
    const root = log.ended("request")!;
    expect(root.attrs).toEqual({ channel: "slack", status: "refused" });
    expect(log.ended("dispatch.refuse")!.attrs).toEqual({ outcome: "agent_allowlist" });
    const p = check(log, ticks, { start: root.startedAt, end: root.endedAt! });
    expect(p).toMatchObject({ gettingReadyMs: 2000, overheadMs: 0 });
  });

  it("a command answered without a run (help): the command body is run.command, the reply post.reply; the root completes with no run", async () => {
    const { ticks, log, deps, io, replies } = traced(capturingProvider());
    wireCommands(deps);
    await dispatch(deps, msg("help"), io);
    expect(replies).toHaveLength(1);
    expect(ticks.map((t) => [t.dep, t.span])).toEqual([["io.reply", "post.reply"]]);
    const root = log.ended("request")!;
    expect(root.attrs).toEqual({ channel: "slack", status: "completed" });
    expect(log.ended("run.command")!.attrs).toEqual({ command: "help.show" });
  });

  it("a fresh turn for unconsumed follow-ups is a request of its own: the first root ended before it started, and it carries how long the follow-up waited", async () => {
    let calls = 0;
    let fail!: (err: Error) => void;
    const first = new Promise<CompletionResult>((_, reject) => (fail = reject));
    let onFirst!: () => void;
    const firstStarted = new Promise<void>((r) => (onFirst = r));
    const provider: Provider = {
      name: "gated",
      async complete() {
        if (calls++ === 0) {
          onFirst();
          return first;
        }
        return { content: [{ type: "text", text: `answer ${calls}` }], stopReason: "end_turn" };
      },
    };
    const { ticks, log, deps, io, clock } = traced(provider);
    let ids = 0;
    deps.runRegistry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t", now: clock.now });
    deps.admission = new ThreadAdmission();
    const run = dispatch(deps, msg("write the report"), io);
    await firstStarted;
    const { io: second } = traced(capturingProvider()); // the follow-up's own channel handle
    // The follow-up carries its platform stamp (a Slack `ts`): the fresh turn
    // must not turn that into a `queued … before we saw it`.
    await dispatch(deps, { ...msg("and also the numbers", "slack:UY"), originAt: clock.now() - 5_000 }, second);
    clock.tick(250_000); // the follow-up waits behind the run
    fail(new Error("provider exploded"));
    await run;
    // Three requests: the first run's, the steered follow-up's own (no run), the fresh turn's.
    const roots = log.ends.filter((r) => r.name === "request");
    expect(roots.map((r) => r.attrs)).toEqual([
      { channel: "slack", status: "completed", queuedBeforeMs: 5_000 }, // the follow-up's own dispatch: steered; its platform delay is its own
      { channel: "slack", runId: "r1", status: "failed" },
      { channel: "slack", runId: "r2", status: "completed", queuedBehindMs: expect.any(Number) },
    ]);
    const [, firstRoot, fresh] = roots;
    expect(firstRoot!.endedAt).toBeLessThanOrEqual(fresh!.startedAt);
    expect(fresh!.attrs.queuedBehindMs).toBeGreaterThanOrEqual(250_000);
    // The queued numbers are on the roots AT START — the record's `request`
    // span_start is the only streamed event of a root, and the page's caption
    // reads it (tracing item 18): the follow-up's own root started with its
    // platform delay, the fresh turn's with its wait behind the run.
    const starts = log.starts.filter((r) => r.name === "request");
    expect(starts.map((r) => r.attrs)).toEqual([
      { channel: "slack" }, // the first run's request: no platform stamp in this fixture
      { channel: "slack", queuedBeforeMs: 5_000 }, // the steered follow-up's own request
      { channel: "slack", queuedBehindMs: fresh!.attrs.queuedBehindMs }, // the fresh turn
    ]);
    expect(ticks.every((t) => t.span !== null)).toBe(true);
    // The steered follow-up's ack was an admission span on the first request.
    expect(log.ends.filter((r) => r.name === "dispatch.admission").map((r) => r.attrs)).toEqual([
      { outcome: "steered" },
    ]);
  });
});

// Feature: docs/reference/specs/routing-and-config.md items 2 and 4 — a boundary
// on a scope caps what any run in it may have (record 0026): the profile gate
// refuses an identity or a machine class above a cap before any executor
// exists, and clips a budget above it. Proven end to end with the factory
// stubbed, the way "no registry command starts a run" is proven: never called
// on a refused profile, always called with the intersected one.
describe("boundaries: the profile gate, before any executor exists", () => {
  const BOUNDED_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
    review: anthropic/review-model
channels:
  "slack:CREAD":
    boundary:
      maxIdentity: read
  "slack:CSHORT":
    boundary:
      maxMinutes: 10
  "slack:CNOMACHINE":
    boundary:
      machines: [none]
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
routing: { auto: false }
workspaceDir: __WORKDIR__
`;
  const inChannel = (channel: string, text: string, user = "slack:UADMIN") => ({
    channelId: `slack:${channel}`,
    userId: user,
    threadKey: `slack:${channel}:1.0`,
    text,
  });
  /** A provider that answers at once and records the ledger's row and step records as they stood at its first call. */
  function observingProvider(ledger: InMemoryRunLedger, runId: string) {
    const requests: CompletionRequest[] = [];
    const seen: { row?: ReturnType<InMemoryRunLedger["live"]["get"]>; steps?: unknown } = {};
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        if (requests.length === 1) {
          seen.row = structuredClone(ledger.live.get(runId));
          seen.steps = structuredClone(ledger.steps.get(runId));
        }
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    return { provider, requests, seen };
  }
  /** The deps of a run under `BOUNDED_YAML`: a fixed run id, a recording store and ledger, a resolved repository. */
  function bounded(runId: string) {
    const ledger = new InMemoryRunLedger();
    const observed = observingProvider(ledger, runId);
    const registry = new RunRegistry({ genId: () => runId, genToken: () => "tok" });
    const store = new InMemoryRunStore();
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const deps = makeDeps(BOUNDED_YAML, observed.provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-B",
      fallback: { put: async () => {} },
      warn: () => {},
    });
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    return { deps, store, writer, ledger, ...observed };
  }

  beforeEach(() => {
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
  });
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
  });

  it("identity above the cap: `agent:coding` in a channel bounded to `read` is refused by name before any card, thread claim, ledger row or executor; `agent:review` in the same channel is admitted with its declared profile", async () => {
    const ledger = new InMemoryRunLedger();
    const provider = capturingProvider();
    const deps = makeDeps(BOUNDED_YAML, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const claim = vi.spyOn(admission, "claim");
    deps.admission = admission;
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-B",
      fallback: { put: async () => {} },
      warn: () => {},
    });
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, inChannel("CREAD", "agent:coding fix it"), io);
    expect(replies).toEqual([
      "🚫 `coding` needs a `write` credential; this channel's boundary caps runs at `read`. Run it in a channel that allows `write`, or ask <@slack:UADMIN> to raise this channel's boundary.",
    ]);
    expect(statuses).toEqual([]); // refused before the ack card: nothing to close
    expect(claim).not.toHaveBeenCalled(); // no thread claimed
    expect(ledger.live.size).toBe(0); // no row reserved
    expect(makeExecutor).not.toHaveBeenCalled(); // no executor of any kind
    expect(provider.requests).toHaveLength(0);
    // review declares `read`: admitted, and the factory gets exactly its declared profile.
    const second = fakeIO();
    await dispatch(deps, inChannel("CREAD", "agent:review look at it"), second.io);
    expect(provider.requests).toHaveLength(1);
    expect(makeExecutor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(makeExecutor).mock.calls[0][1].profile).toEqual({
      machine: "repo-resident",
      identity: "read",
      minutes: 25,
    });
  });

  it("machine class outside the set: coding (repo-resident) in a channel whose boundary allows only `none` is refused naming the class and the scope; a general ask in the same channel runs", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(BOUNDED_YAML, provider);
    deps.resolveRepoContext = () => ({ repo: "acme/api" });
    const { io, replies } = fakeIO();
    await dispatch(deps, inChannel("CNOMACHINE", "agent:coding fix it"), io);
    expect(replies).toEqual([
      "🚫 `coding` runs on a `repo-resident` machine; this channel's boundary allows only `none`. Run it in a channel that allows `repo-resident`, or ask <@slack:UADMIN> to raise this channel's boundary.",
    ]);
    expect(makeExecutor).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
    const second = fakeIO();
    await dispatch(deps, inChannel("CNOMACHINE", "hello there"), second.io);
    expect(second.replies).toContain("answer");
  });

  it("a budget above the cap is clipped, never refused: the factory, the ledger row and its seed, the runner, the card and the record all carry the intersected profile, and the shared preset is untouched", async () => {
    const { deps, store, writer, requests, seen } = bounded("run-b");
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, inChannel("CSHORT", "agent:coding fix it"), io);
    await writer.settled();
    expect(requests).toHaveLength(1);
    expect(replies.some((r) => r.includes("answer"))).toBe(true);
    const profile = { machine: "repo-resident", identity: "write", minutes: 10, boundedBy: "channel" };
    expect(vi.mocked(makeExecutor).mock.calls[0][1].profile).toEqual(profile);
    expect(vi.mocked(runPiHarnessOpen).mock.calls[0][1].agent.maxMinutes).toBe(10); // the runner's deadline is the clipped budget
    expect(AGENTS.coding.maxMinutes).toBe(45); // the shared def is never mutated
    // The ledger row and its seed carry the clip, so a resume runs on it (run-history's resume rule).
    expect(seen.row?.meta).toMatchObject({ agent: "coding", readonly: false, profile });
    expect(seen.steps).toEqual([expect.objectContaining({ step: 0, remainingMs: 10 * 60_000 })]);
    const rec = (await store.get("run-b"))!;
    expect(rec.profile).toEqual({ preset: "coding", ...profile });
    expect(
      statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes("budget 10 min (channel boundary; preset asks 45)")),
    ).toBe(true);
  });

  it("with no boundary on the path a request provisions exactly as before: the factory gets the preset's declared profile, the record says so without a clip, and the card carries no budget line", async () => {
    const { deps, store, writer, seen } = bounded("run-u");
    const { io, statuses } = fakeIO();
    await dispatch(deps, inChannel("CX", "agent:coding fix it"), io);
    await writer.settled();
    const declared = { machine: "repo-resident", identity: "write", minutes: 45 };
    expect(vi.mocked(makeExecutor).mock.calls[0][1].profile).toEqual(declared);
    expect(vi.mocked(runPiHarnessOpen).mock.calls[0][1].agent.maxMinutes).toBe(45);
    expect(seen.row?.meta).toMatchObject({ agent: "coding", readonly: false, profile: declared });
    expect(seen.steps).toEqual([expect.objectContaining({ step: 0, remainingMs: 45 * 60_000 })]);
    expect((await store.get("run-u"))!.profile).toEqual({ preset: "coding", ...declared });
    expect(statuses.map((s) => JSON.stringify(s)).some((s) => s.includes("budget"))).toBe(false);
  });
});

// docs/reference/specs/agent-explore.md — the first `repo-cold` preset end to
// end through dispatch(): the cold path PR 1 built gets its first real user.
describe("agent:explore — the first repo-cold preset", () => {
  /** A deployment with a Cloudflare sandbox AND a resident fleet: a `repo-resident`
   *  preset would probe the registry here; `explore` must never. */
  const EXPLORE_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    explore: anthropic/explore-model
execution:
  type: cloudflare
  url: https://sandbox.example
  resident:
    baseUrl: https://resident.example
channels:
  "slack:CSHORT":
    boundary:
      maxMinutes: 45
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
routing: { auto: false }
workspaceDir: __WORKDIR__
`;
  const inChannel = (channel: string, text: string) => ({
    channelId: `slack:${channel}`,
    userId: "slack:UADMIN",
    threadKey: `slack:${channel}:1.0`,
    text,
  });
  /** Every URL the dispatch fetches: GitHub's repository lookup answers 200,
   *  anything else — the resident Worker above all — is an unexpected call. */
  function recordingFetch() {
    const urls: string[] = [];
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url === "https://api.github.com/repos/acme/api") return new Response("{}", { status: 200 });
      throw new Error(`unexpected network call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    return urls;
  }
  /** The deps of an explore run: a fixed run id, a recording store, the production repo resolver. */
  function exploreDeps(runId: string, provider: Provider) {
    const registry = new RunRegistry({ genId: () => runId, genToken: () => "tok" });
    const store = new InMemoryRunStore();
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const deps = makeDeps(EXPLORE_YAML, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    return { deps, store, writer };
  }

  beforeEach(() => {
    // The read-scoped vet and the sandbox env mint from GH_TOKEN (no App
    // configured); the sandbox client is constructed with its bearer, never called.
    vi.stubEnv("GH_TOKEN", "ghp_read_only_fixture");
    vi.stubEnv("SANDBOX_TOKEN", "sbx");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "res-op");
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
  });

  it("agent:explore against a deployment with a resident fleet reaches the factory with `repo-cold` and identity `read`, vets the repository against GitHub once, and never calls the resident Worker", async () => {
    const urls = recordingFetch();
    const provider = capturingProvider("11 of 16 claims hold");
    const { deps, store, writer } = exploreDeps("run-x", provider);
    const { io, replies } = fakeIO();
    await dispatch(deps, inChannel("CX", "agent:explore in acme/api: how long does the test suite take?"), io);
    await writer.settled();
    expect(replies).toContain("11 of 16 claims hold");
    expect(makeExecutor).toHaveBeenCalledTimes(1);
    const ctx = vi.mocked(makeExecutor).mock.calls[0][1];
    expect(ctx.agent.name).toBe("explore");
    expect(ctx.repo).toBe("acme/api");
    expect(ctx.profile).toEqual({ machine: "repo-cold", identity: "read", minutes: 120 });
    await expect(vi.mocked(makeExecutor).mock.results[0].value).resolves.toMatchObject({ backend: "sandbox" });
    // The runner ran the explore preset's own def — 120 minutes, the explore toolset.
    expect(vi.mocked(runPiHarnessOpen).mock.calls[0][1].agent).toMatchObject({ name: "explore", maxMinutes: 120 });
    // One GitHub lookup with the run's credential; the resident registry and Worker untouched.
    expect(urls).toEqual(["https://api.github.com/repos/acme/api"]);
    expect(urls.some((u) => u.includes("resident.example"))).toBe(false);
    expect((await store.get("run-x"))!.profile).toEqual({
      preset: "explore",
      machine: "repo-cold",
      identity: "read",
      minutes: 120,
    });
  });

  // docs/reference/specs/routing-and-config.md items 1–4: the `budget:`
  // directive is the caller's own boundary on one run — it narrows and never
  // widens, the card says what it did, and the record carries the clip.
  it("`agent:explore budget:30` runs 30 minutes as `boundedBy: directive` — at the factory, on the runner's def, on the card and on the record", async () => {
    recordingFetch();
    const provider = capturingProvider();
    const { deps, store, writer } = exploreDeps("run-b30", provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, inChannel("CX", "agent:explore budget:30 in acme/api: time the suite"), io);
    await writer.settled();
    expect(provider.requests).toHaveLength(1);
    const profile = { machine: "repo-cold", identity: "read", minutes: 30, boundedBy: "directive" };
    expect(vi.mocked(makeExecutor).mock.calls[0][1].profile).toEqual(profile);
    expect(vi.mocked(runPiHarnessOpen).mock.calls[0][1].agent.maxMinutes).toBe(30);
    expect(AGENTS.explore.maxMinutes).toBe(120); // the shared def is never mutated
    expect((await store.get("run-b30"))!.profile).toEqual({ preset: "explore", ...profile });
    expect(
      statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes("budget 30 min (budget directive; preset asks 120)")),
    ).toBe(true);
    // The model is told what set its budget: the directive line and the clip line of the config block.
    const system = provider.requests[0].system ?? "";
    expect(system).toContain("This message's `agent:explore budget:30` directive");
    expect(system).toContain("Budget: 30 min (clipped by the budget directive; the preset asks 120).");
  });

  it("`agent:explore budget:200` runs the preset's 120 — a directive never widens — and the card says the directive narrowed nothing", async () => {
    recordingFetch();
    const provider = capturingProvider();
    const { deps, store, writer } = exploreDeps("run-b200", provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, inChannel("CX", "agent:explore budget:200 in acme/api: time the suite"), io);
    await writer.settled();
    expect(vi.mocked(makeExecutor).mock.calls[0][1].profile).toEqual({
      machine: "repo-cold",
      identity: "read",
      minutes: 120,
    });
    expect(vi.mocked(runPiHarnessOpen).mock.calls[0][1].agent.maxMinutes).toBe(120);
    expect((await store.get("run-b200"))!.profile).toEqual({
      preset: "explore",
      machine: "repo-cold",
      identity: "read",
      minutes: 120,
    });
    expect(
      statuses.map((s) => JSON.stringify(s)).some((s) => s.includes("budget:200 narrowed nothing (preset asks 120)")),
    ).toBe(true);
    expect(provider.requests[0].system ?? "").toContain("This message's `budget:200` narrowed nothing");
  });

  it("`agent:explore` in a channel bounded to 45 minutes runs 45 and the record says `channel`; a `budget:30` under that cap is the directive's clip", async () => {
    recordingFetch();
    const provider = capturingProvider();
    const { deps, store, writer } = exploreDeps("run-c45", provider);
    const { io, statuses } = fakeIO();
    await dispatch(deps, inChannel("CSHORT", "agent:explore in acme/api: time the suite"), io);
    await writer.settled();
    const clipped = { machine: "repo-cold", identity: "read", minutes: 45, boundedBy: "channel" };
    expect(vi.mocked(makeExecutor).mock.calls[0][1].profile).toEqual(clipped);
    expect((await store.get("run-c45"))!.profile).toEqual({ preset: "explore", ...clipped });
    expect(
      statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes("budget 45 min (channel boundary; preset asks 120)")),
    ).toBe(true);
    // A directive above the channel's cap changes nothing, and the card says so beside the channel's clip.
    const second = exploreDeps("run-c45b", capturingProvider());
    const io2 = fakeIO();
    await dispatch(second.deps, inChannel("CSHORT", "agent:explore budget:60 in acme/api: time the suite"), io2.io);
    expect(
      io2.statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes("budget 45 min (channel boundary; preset asks 120; budget:60 narrowed nothing)")),
    ).toBe(true);
    // A directive under the cap is the tighter one: the directive's clip.
    const third = exploreDeps("run-c45c", capturingProvider());
    const io3 = fakeIO();
    await dispatch(third.deps, inChannel("CSHORT", "agent:explore budget:30 in acme/api: time the suite"), io3.io);
    expect(vi.mocked(makeExecutor).mock.calls[2][1].profile).toEqual({
      machine: "repo-cold",
      identity: "read",
      minutes: 30,
      boundedBy: "directive",
    });
  });

  it("`budget:1` is refused inline naming the rule — no card, no model call, no executor", async () => {
    recordingFetch();
    const provider = capturingProvider();
    const { deps } = exploreDeps("run-bad", provider);
    const { io, replies, statuses } = fakeIO();
    await dispatch(deps, inChannel("CX", "agent:explore budget:1 in acme/api: time the suite"), io);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/Invalid budget "1"/);
    expect(replies[0]).toMatch(/budget:<minutes> takes a whole number of minutes, at least 2/);
    expect(statuses).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(makeExecutor).not.toHaveBeenCalled();
  });
});

// Feature: docs/reference/specs/agent-conductor.md; docs/reference/specs/routing-and-config.md
// item 20 (the child pipeline); docs/reference/specs/thread-admission.md item 6
// (a child is its own thread); docs/reference/specs/run-history.md item 46
// (`parentRunId`). A conductor's child is a `dispatch()` run as the requesting
// user through the full pipeline — the agent gate, the profile gate with the
// parent's remaining budget intersected, admission on the child's own thread —
// and a refusal at any gate reaches the parent as a named tool result.
describe("agent:conductor — a run that spawns child runs through dispatch()", () => {
  const CONDUCTOR_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    conductor: anthropic/conductor-model
    research: anthropic/research-model
    coding: anthropic/coding-model
    explore: anthropic/explore-model
channels:
  "slack:CNONE":
    boundary:
      maxIdentity: none
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
restrict:
  agents: [explore]
routing: { auto: false }
workspaceDir: __WORKDIR__
`;
  const PARENT_THREAD = "slack:CX:1.0";
  const CHILD_THREAD = "slack:CX:9.0";
  const inChannel = (channel: string, text: string, user = "slack:UADMIN") => ({
    channelId: `slack:${channel}`,
    userId: user,
    userName: "alice",
    threadKey: `slack:${channel}:1.0`,
    text,
    sourceUrl: "https://acme.slack.com/archives/CX/p10",
  });
  /** The texts of a request's tool results — what the model was told a tool answered. */
  const toolResultTexts = (req: CompletionRequest): string[] => {
    const last = req.messages.at(-1);
    if (!last || typeof last.content === "string") return [];
    return last.content
      .filter((p) => p.type === "tool_result")
      .map((p) => (typeof p.content === "string" ? p.content : JSON.stringify(p.content)));
  };
  /**
   * A scripted provider for a tree: a request holding `spawn_run` is a
   * conductor's — its first turn spawns what `spawns` lists (one call each),
   * its next turn echoes the tool results as its answer; any other request is a
   * child's, answered with `childAnswer`. Every request is kept, and the
   * admission slots are read at the child's turn so the test can see the
   * parent's slot untouched while the child runs.
   */
  function treeProvider(
    spawns: Array<Record<string, unknown>>,
    childAnswer: string,
    admission?: ThreadAdmission<DispatchFollowUp>,
  ) {
    const requests: CompletionRequest[] = [];
    const slotsAtChildTurn: Record<string, string | undefined> = {};
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        const conducts = req.tools?.some((t) => t.name === "spawn_run") ?? false;
        const firstText = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        const isChildConductor = conducts && firstText.includes("[child]");
        if (conducts && toolResultTexts(req).length === 0) {
          const asks = isChildConductor ? [{ preset: "research", prompt: "grandchild?" }] : spawns;
          return {
            content: asks.map((input, i) => ({ type: "tool_use" as const, id: `t${i + 1}`, name: "spawn_run", input })),
            stopReason: "tool_use",
          };
        }
        if (conducts)
          return { content: [{ type: "text", text: toolResultTexts(req).join("\n") }], stopReason: "end_turn" };
        if (admission) {
          slotsAtChildTurn.parent = admission.get(PARENT_THREAD)?.agent;
          slotsAtChildTurn.child = admission.get(CHILD_THREAD)?.agent;
        }
        return { content: [{ type: "text", text: childAnswer }], stopReason: "end_turn" };
      },
    };
    return { provider, requests, slotsAtChildTurn };
  }
  /** A parent channel whose `openThread` hands out one recording child channel on `CHILD_THREAD`. */
  function treeIO() {
    const parent = fakeIO();
    // The child's thread as a person later finds it: the lead the spawn posted
    // is its first message, so a reply there is a reply in an existing thread.
    const childHistory: HistoryItem[] = [];
    const child = fakeIO(childHistory);
    const leads: string[] = [];
    parent.io.openThread = async (lead) => {
      leads.push(lead);
      childHistory.push({ role: "assistant", text: lead });
      return { thread: { threadKey: CHILD_THREAD, sourceUrl: "https://acme.slack.com/archives/CX/p90" }, io: child.io };
    };
    return { parent, child, leads };
  }
  /** The deps of a tree: ids minted in order (the parent, then the child), a recording store, the process admission map. */
  function treeDeps(
    provider: Provider,
    minted: readonly string[] = ["run-parent", "run-child", "run-third"],
    yaml: string = CONDUCTOR_YAML,
  ) {
    const ids = [...minted];
    const registry = new RunRegistry({ genId: () => ids.shift() ?? "run-more", genToken: () => "tok" });
    const store = new InMemoryRunStore();
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const deps = makeDeps(yaml, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    deps.admission = admission;
    // The one runs service every surface reads, over the store the writer
    // writes — the run tools' reads reach a finished child's record through it.
    deps.runStore = store;
    // The session log: what a conductor's spawn hands its child as the seed
    // (agent-conductor item 3 — the parent's text turns, read off the log);
    // a finished run's record lands on it, where the runs service reads it.
    const ledger = new InMemoryRunLedger();
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-C",
      fallback: { put: async () => {} },
      warn: () => {},
    });
    deps.runs = createRunsService({ registry, store: ledgerBackedStore(ledger, store), ledger });
    return { deps, registry, store, writer, admission, ledger };
  }
  const agentsProvisioned = () => vi.mocked(makeExecutor).mock.calls.map((c) => c[1].agent.name);

  beforeEach(() => {
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
  });
  afterEach(() => {
    vi.mocked(makeExecutor).mockClear();
    vi.mocked(runPiHarnessOpen).mockClear();
  });

  it("spawns a research child as the requester in a thread of its own: the child runs the full pipeline with its budget clipped to the parent's remaining minutes as `parent`, its record and live summary carry parentRunId, the parent's tool result names the child, and the parent's own thread slot is untouched", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { provider, requests, slotsAtChildTurn } = treeProvider(
      [{ preset: "research", prompt: "what is a Durable Object?" }],
      "A Durable Object is a single-instance coordination point.",
      admission,
    );
    const t = treeDeps(provider);
    t.deps.admission = admission;
    const { parent, child, leads } = treeIO();
    // `budget:6` on the conductor: the child's research preset asks 8 minutes,
    // the parent has at most 6 left at the spawn, so the child runs the whole
    // minutes the parent had — 6, or 5 once a millisecond of the parent's clock
    // has gone — as `parent`.
    await dispatch(t.deps, inChannel("CX", "agent:conductor budget:6 look into durable objects"), parent.io);
    await vi.waitFor(() => expect(t.registry.getById("run-child")?.finished).toBe(true));
    await t.writer.settled();
    const childMinutes = (await t.ledger.finished.get("run-child"))!.profile!.minutes;
    expect([5, 6]).toContain(childMinutes);

    // The parent's answer echoes the tool result: the child's id, thread and link.
    expect(parent.replies).toHaveLength(1);
    expect(parent.replies[0]).toContain("spawned a research run: run-child in thread slack:CX:9.0");
    expect(parent.replies[0]).toContain("https://acme.slack.com/archives/CX/p90");
    // The lead in the channel names the child, the requester and the parent.
    expect(leads).toHaveLength(1);
    expect(leads[0]).toContain("*research*");
    expect(leads[0]).toContain("alice");
    // The child answered in its own thread; the parent's thread saw none of it.
    expect(child.replies).toEqual(["A Durable Object is a single-instance coordination point."]);
    // Both runs were provisioned, each on its own class (`none`), the child as the requester.
    expect(agentsProvisioned()).toEqual(["conductor", "research"]);
    const childRecord = (await t.ledger.finished.get("run-child"))!;
    expect(childRecord).toMatchObject({
      agent: "research",
      userId: "slack:UADMIN",
      channelId: "slack:CX",
      threadKey: CHILD_THREAD,
      status: "completed",
      parentRunId: "run-parent",
      seed: "parent",
      profile: { preset: "research", machine: "none", identity: "none", minutes: childMinutes, boundedBy: "parent" },
    });
    expect(t.registry.getById("run-child")).toMatchObject({ parentRunId: "run-parent", agent: "research" });
    expect("parentRunId" in (await t.ledger.finished.get("run-parent"))!).toBe(false);
    expect((await t.ledger.finished.get("run-parent"))!.seed).toBe("channel");
    // The card and the config block say what clipped the child.
    expect(
      child.statuses
        .map((s) => JSON.stringify(s))
        .some((s) => s.includes(`budget ${childMinutes} min (parent run's budget; preset asks 8)`)),
    ).toBe(true);
    const childRequest = requests.find((r) => !r.tools?.some((tool) => tool.name === "spawn_run"))!;
    expect(childRequest.system).toContain(
      `Budget: ${childMinutes} min (clipped by the parent run's budget; the preset asks 8).`,
    );
    expect(
      vi.mocked(runPiHarnessOpen).mock.calls.find((c) => c[1].agent.name === "research")![1].agent.maxMinutes,
    ).toBe(childMinutes);
    // Admission: the parent held its own slot while the child ran on a slot of its own.
    expect(slotsAtChildTurn).toEqual({ parent: "conductor", child: "research" });
    expect(admission.get(PARENT_THREAD)).toBeUndefined();
    expect(admission.get(CHILD_THREAD)).toBeUndefined();
  });

  it("a child for a requester without `agent:run:<preset>` ends at the agent gate: the allowlist refusal in the child's thread, the parent's tool result naming `agent_allowlist`, and the child never reaches the factory", async () => {
    const { provider } = treeProvider([{ preset: "explore", prompt: "time the suite", repo: "acme/api" }], "unused");
    const t = treeDeps(provider);
    const { parent, child } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor time the suite in acme/api", "slack:UX"), parent.io);
    expect(child.replies).toHaveLength(1);
    expect(child.replies[0]).toContain("You're not on the allowlist for the `explore` agent");
    expect(child.statuses).toEqual([]); // refused before any card
    expect(parent.replies[0]).toContain("spawn refused (agent_allowlist)");
    expect(parent.replies[0]).toContain("not on the allowlist");
    expect(agentsProvisioned()).toEqual(["conductor"]);
    expect(t.registry.getById("run-child")).toBeNull();
  });

  it("a child whose preset needs `read` in a channel bounded to `none` ends at the profile gate — the parent, identity `none`, runs there — and the parent is told by the gate's name", async () => {
    const { provider } = treeProvider([{ preset: "explore", prompt: "time the suite", repo: "acme/api" }], "unused");
    const t = treeDeps(provider);
    const { parent, child } = treeIO();
    await dispatch(t.deps, inChannel("CNONE", "agent:conductor time the suite in acme/api"), parent.io);
    expect(child.replies).toHaveLength(1);
    expect(child.replies[0]).toContain("`explore` needs a `read` credential");
    expect(child.replies[0]).toContain("this channel's boundary");
    expect(parent.replies[0]).toContain("spawn refused (profile_bounded)");
    expect(agentsProvisioned()).toEqual(["conductor"]);
    expect(t.registry.getById("run-child")).toBeNull();
  });

  // docs/reference/specs/agent-conductor.md item 3: a child is a reader — a
  // preset that writes is refused by the stage itself, before the child has
  // a thread, so nothing in the channel or the registry records the attempt.
  it("a `coding` child is refused `spawn_identity` before anything is opened — no thread in the channel, no run, the factory never asked — and the parent's tool result names the gate", async () => {
    const { provider } = treeProvider([{ preset: "coding", prompt: "fix the login test", repo: "acme/api" }], "unused");
    const t = treeDeps(provider);
    const { parent, child, leads } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor fix the login test in acme/api"), parent.io);
    expect(leads).toEqual([]);
    expect(child.replies).toEqual([]);
    expect(parent.replies).toHaveLength(1);
    expect(parent.replies[0]).toContain("spawn refused (spawn_identity)");
    expect(parent.replies[0]).toContain("`coding`");
    expect(agentsProvisioned()).toEqual(["conductor"]);
    expect(t.registry.getById("run-child")).toBeNull();
  });

  // docs/reference/specs/routing-and-config.md item 20: a spawned child starts
  // from what its parent's conversation said — every text turn so far, then
  // its own prompt — and its record says where it started.
  /** Each message's role and text parts, as the child's model saw them. */
  const textTurns = (req: CompletionRequest): Array<[string, string[]]> =>
    req.messages.map((m) => [
      m.role,
      typeof m.content === "string"
        ? [m.content]
        : (m.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? ""),
    ]);
  it("a research child's model sees the parent's text turns — the request and what the conductor said before spawning, never its tool call — then the child's prompt as the one new turn; the child's record names `seed: parent` with those turns as its context, the parent's record `seed: channel`", async () => {
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        const conducts = req.tools?.some((t) => t.name === "spawn_run") ?? false;
        if (conducts && toolResultTexts(req).length === 0)
          return {
            content: [
              { type: "text", text: "Storage first: one research child." },
              {
                type: "tool_use",
                id: "t1",
                name: "spawn_run",
                input: { preset: "research", prompt: "what is a Durable Object?" },
              },
            ],
            stopReason: "tool_use",
          };
        if (conducts)
          return { content: [{ type: "text", text: toolResultTexts(req).join("\n") }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "A single-instance coordination point." }], stopReason: "end_turn" };
      },
    };
    const t = treeDeps(provider);
    const { parent, child } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor look into durable objects"), parent.io);
    await vi.waitFor(() => expect(t.registry.getById("run-child")?.finished).toBe(true));
    await t.writer.settled();
    expect(child.replies).toEqual(["A single-instance coordination point."]);
    const childRequest = requests.find((r) => !r.tools?.some((tool) => tool.name === "spawn_run"))!;
    expect(textTurns(childRequest)).toEqual([
      ["user", ["look into durable objects"]],
      ["assistant", ["Storage first: one research child."]],
      ["user", ["what is a Durable Object?"]],
    ]);
    const childRecord = (await t.ledger.finished.get("run-child"))!;
    expect(childRecord.seed).toBe("parent");
    expect(childRecord.events.filter((e) => e.type === "context").map((e) => (e as { text: string }).text)).toEqual([
      "user: look into durable objects",
      "assistant: Storage first: one research child.",
    ]);
    expect(childRecord.events.filter((e) => e.type === "input").map((e) => (e as { text: string }).text)).toEqual([
      "what is a Durable Object?",
    ]);
    expect((await t.ledger.finished.get("run-parent"))!.seed).toBe("channel");
    expect(agentsProvisioned()).toEqual(["conductor", "research"]);
  });

  // docs/reference/specs/harness-pi.md item 12; agent-conductor item 3: the
  // conductor on pi. Its run tools are relays into the bot; the spawn relay
  // reads the parent's conversation off its session log, so the child seeds
  // from the parent's text turns exactly as a native conductor's child does,
  // and a write preset's refusal reaches the tool result by name.
  it("`harness: { conductor: pi }` runs the conductor on pi as a child of the bot: a `coding` spawn relayed through the bot is refused `spawn_identity` in the tool result and opens nothing; a `research` spawn reaches spawnChild with the parent's text turns read off its session log, so the child's record says `seed: parent` with the request and what the conductor said as its context; the relayed await_runs returns the child's reply; the parent's answer carries all three", async () => {
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        return { content: [{ type: "text", text: "A single-instance coordination point." }], stopReason: "end_turn" };
      },
    };
    const t = treeDeps(provider, undefined, CONDUCTOR_YAML + "harness:\n  conductor: pi\n");
    const ledger = new InMemoryRunLedger();
    t.deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-P",
      fallback: { put: async () => {} },
      warn: () => {},
    });
    t.deps.runs = createRunsService({ registry: t.registry, store: t.store, ledger });
    const container = new FakePiContainer();
    const harnesses = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: Date.now });
    let starts = 0;
    t.deps.harness = {
      registry: harnesses,
      harnessUrl: "https://bot.test",
      loopbackUrl: "http://127.0.0.1:8080",
      // The first pi is the scripted conductor below; the research child's is scripted from the provider.
      containerFor: () => {
        if (starts++ === 0) return container;
        const child = new FakePiContainer();
        scriptPiFromProvider(child, { provider, registry: harnesses, bearers, beforeModelCall: () => realSleep(10) });
        return child;
      },
      pollMs: 1,
      tickMs: 5,
      sleep: realSleep,
    };
    t.deps.runBearers = bearers;
    const assistant = (content: Record<string, unknown>[], stopReason = "toolUse") => ({
      role: "assistant",
      content,
      stopReason,
    });
    const results: string[] = [];
    /** A scripted pi conductor: three relayed calls as the extension makes them, then the answer. */
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const live = harnesses.get("run-parent")!;
      const calls = harnesses.calls("run-parent")!;
      const relay = async (ask: ToolCallAsk, text?: string) => {
        const msg = assistant([
          ...(text ? [{ type: "text", text }] : []),
          { type: "toolCall", id: ask.toolCallId, name: ask.tool, arguments: ask.input },
        ]);
        c.emit(
          { type: "message_end", message: msg },
          { type: "tool_execution_start", toolCallId: ask.toolCallId, toolName: ask.tool, args: ask.input },
        );
        authorizeToolCall(live, ask);
        let progress = await relayToolCall(live, calls, ask);
        while (!progress.done) progress = await relayToolCall(live, calls, ask);
        const answer = progress.answer;
        results.push(answer.content.map((p) => (p.type === "text" ? p.text : "")).join(""));
        c.emit(
          {
            type: "tool_execution_end",
            toolCallId: ask.toolCallId,
            toolName: ask.tool,
            result: { content: answer.content },
            isError: answer.isError,
          },
          {
            type: "message_end",
            message: { role: "toolResult", toolCallId: ask.toolCallId, toolName: ask.tool, content: answer.content },
          },
          { type: "turn_end", message: msg, toolResults: [] },
        );
      };
      void (async () => {
        await relay(
          {
            toolCallId: "t1",
            tool: "spawn_run",
            input: { preset: "coding", prompt: "fix the login test", repo: "acme/api" },
          },
          "Storage first: one research child.",
        );
        await relay({
          toolCallId: "t2",
          tool: "spawn_run",
          input: { preset: "research", prompt: "what is a Durable Object?" },
        });
        const childId = /run: (\S+) in thread/.exec(results[1])?.[1] ?? "run-child";
        await relay({ toolCallId: "t3", tool: "await_runs", input: { ids: [childId] } });
        const done = assistant([{ type: "text", text: results.join("\n---\n") }], "stop");
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          { type: "agent_settled" },
        );
      })();
    };
    const { parent, child, leads } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor look into durable objects"), parent.io);
    await vi.waitFor(() => expect(t.registry.getById("run-child")?.finished).toBe(true));
    await t.writer.settled();
    // The three relayed results, as the model read them.
    expect(results[0]).toMatch(/^spawn refused \(spawn_identity\): `coding` runs as a `write` identity/);
    expect(results[1]).toContain("spawned a research run: run-child in thread slack:CX:9.0");
    expect(JSON.parse(results[2])).toMatchObject({
      ended: "all_ended",
      runs: [
        {
          id: "run-child",
          status: "completed",
          finalReply: expect.stringContaining("A single-instance coordination point."),
        },
      ],
    });
    expect(parent.replies).toEqual([results.join("\n---\n")]);
    // The coding spawn opened nothing; the research child ran in its own thread as the requester.
    expect(leads).toHaveLength(1);
    expect(leads[0]).toContain("*research*");
    expect(child.replies).toEqual(["A single-instance coordination point."]);
    expect(agentsProvisioned()).toEqual(["conductor", "research"]);
    // The child seeded from the parent's text turns, read off the parent's session log.
    const childRecord = ledger.finished.get("run-child")!;
    expect(childRecord).toMatchObject({
      agent: "research",
      parentRunId: "run-parent",
      seed: "parent",
      status: "completed",
    });
    expect(childRecord.events.filter((e) => e.type === "context").map((e) => (e as { text: string }).text)).toEqual([
      "user: look into durable objects",
      "assistant: Storage first: one research child.",
    ]);
    expect(childRecord.events.filter((e) => e.type === "input").map((e) => (e as { text: string }).text)).toEqual([
      "what is a Durable Object?",
    ]);
    const parentRecord = ledger.finished.get("run-parent")!;
    expect(parentRecord.seed).toBe("channel");
    expect(parentRecord.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "spawn_run",
      "spawn_run",
      "await_runs",
    ]);
    // pi ran once, as a child of the bot, reaching it over loopback.
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0].env.SWITCHBOARD_HARNESS_URL).toBe("http://127.0.0.1:8080");
    expect(vi.mocked(runPiHarnessOpen).mock.calls.map((c) => c[1].agent.name)).toEqual(["conductor", "research"]);
  });

  it("a child cannot spawn: a conductor child's own spawn_run is refused `spawn_depth`, and no grandchild exists", async () => {
    const { provider } = treeProvider([{ preset: "conductor", prompt: "[child] spawn something" }], "unused");
    const t = treeDeps(provider);
    const { parent, child } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor delegate this"), parent.io);
    await vi.waitFor(() => expect(t.registry.getById("run-child")?.finished).toBe(true));
    expect(parent.replies[0]).toContain("spawned a conductor run: run-child");
    // The child conductor's answer echoes ITS tool result: the depth refusal.
    expect(child.replies).toHaveLength(1);
    expect(child.replies[0]).toContain("spawn refused (spawn_depth)");
    expect(child.replies[0]).toContain("itself a child");
    expect(agentsProvisioned()).toEqual(["conductor", "conductor"]);
    expect(t.registry.getById("run-third")).toBeNull();
  });

  // docs/reference/specs/agent-conductor.md item 8, thread-admission item 7:
  // steer and await, end to end through the real runner, registry and inbox.
  /** The text parts of a request's last user turn — where a drained follow-up rides. */
  const lastUserTexts = (req: CompletionRequest): string[] => {
    const last = req.messages.at(-1);
    if (!last || last.role !== "user" || typeof last.content === "string") return [];
    return (last.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "");
  };
  /**
   * A conductor that spawns one research child, then steers it and awaits it
   * in one turn, then answers with what the tools returned; a child whose
   * first turn is held until the steer sits in its inbox — so the steer rides
   * its first results turn and its answer quotes it.
   */
  function steerAndAwaitProvider(admission: ThreadAdmission<DispatchFollowUp>) {
    const requests: CompletionRequest[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        requests.push(req);
        const conducts = req.tools?.some((t) => t.name === "spawn_run") ?? false;
        if (conducts) {
          const results = toolResultTexts(req);
          const spawned = results.find((r) => r.startsWith("spawned a research run: "));
          if (results.length === 0)
            return {
              content: [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "spawn_run",
                  input: { preset: "research", prompt: "what is a DO?" },
                },
              ],
              stopReason: "tool_use",
            };
          if (spawned && results.length === 1) {
            const childId = /run: (\S+) in thread/.exec(spawned)![1];
            return {
              content: [
                {
                  type: "tool_use",
                  id: "t2",
                  name: "send_to_run",
                  input: { id: childId, text: "narrow it to Workers" },
                },
                { type: "tool_use", id: "t3", name: "await_runs", input: { ids: [childId] } },
              ],
              stopReason: "tool_use",
            };
          }
          return { content: [{ type: "text", text: results.join("\n---\n") }], stopReason: "end_turn" };
        }
        // The child: the first turn waits for the parent's steer to land (the
        // harness drains and steers it on its next tick, so the inbox's arrival
        // count is the signal, not its size), then makes one bookkeeping call
        // so the steer rides the next user turn.
        if (!req.messages.some((m) => m.role === "assistant")) {
          await vi.waitFor(() => expect(admission.get(CHILD_THREAD)?.inbox.arrived).toBe(1));
          return {
            content: [{ type: "tool_use", id: "c1", name: "update_status", input: { checklist: "○ reading" } }],
            stopReason: "tool_use",
          };
        }
        const heard = lastUserTexts(req).some((t) => t.includes("narrow it to Workers"));
        return {
          content: [{ type: "text", text: `heard: ${heard ? "narrow it to Workers" : "nothing"}` }],
          stopReason: "end_turn",
        };
      },
    };
    return { provider, requests };
  }

  it("send_to_run steers a live child through the inbox a thread reply takes — the child reads it at its next step as the requester's follow-up, its record's `input` names the parent run — and await_runs returns when the child's end frame lands, with its final reply as data", async () => {
    const admission = new ThreadAdmission<DispatchFollowUp>();
    const { provider, requests } = steerAndAwaitProvider(admission);
    const t = treeDeps(provider);
    t.deps.admission = admission;
    const { parent, child } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor look into durable objects"), parent.io);
    await t.writer.settled();
    // The child heard the steer on its next step and answered from it, in its own thread.
    expect(child.replies).toEqual(["heard: narrow it to Workers"]);
    const childRecord = (await t.ledger.finished.get("run-child"))!;
    const inputs = childRecord.events.filter((e) => e.type === "input");
    expect(inputs).toHaveLength(2); // the request, then the steer
    expect(inputs[1]).toMatchObject({
      type: "input",
      text: "narrow it to Workers",
      source: { user: "alice", run: "run-parent", url: "https://acme.slack.com/archives/CX/p10" },
    });
    expect(childRecord.status).toBe("completed");
    // The child's request carried the steer with the follow-up header, and nothing was acked in the child's thread.
    const childSteerTurn = requests.find(
      (r) => !r.tools?.some((x) => x.name === "spawn_run") && lastUserTexts(r).some((x) => /Follow-up/.test(x)),
    );
    expect(childSteerTurn).toBeDefined();
    // The parent's answer echoes both tool results: the steer folded in, the await's report with the child's reply.
    expect(parent.replies).toHaveLength(1);
    expect(parent.replies[0]).toContain("steered: folded into the research run run-child");
    const report = JSON.parse(parent.replies[0].split("\n---\n").find((s) => s.startsWith("{"))!) as {
      ended: string;
      runs: Array<Record<string, unknown>>;
    };
    expect(report.ended).toBe("all_ended");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      id: "run-child",
      status: "completed",
      agent: "research",
      parentRunId: "run-parent",
    });
    expect(String(report.runs[0].finalReply)).toContain("heard: narrow it to Workers");
    expect(String(report.runs[0].finalReply)).toMatch(/untrusted/i);
    expect(agentsProvisioned()).toEqual(["conductor", "research"]);
    expect(admission.get(PARENT_THREAD)).toBeUndefined();
    expect(admission.get(CHILD_THREAD)).toBeUndefined();
  });

  /** A conductor that only awaits the given ids, then answers with the report. */
  function awaitOnlyProvider(ids: string[]) {
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        const results = toolResultTexts(req);
        if (results.length === 0)
          return {
            content: [{ type: "tool_use", id: "t1", name: "await_runs", input: { ids } }],
            stopReason: "tool_use",
          };
        return { content: [{ type: "text", text: results.join("\n") }], stopReason: "end_turn" };
      },
    };
    return provider;
  }

  it("a parent awaiting a child that another generation finished (a store record, no registry frame) returns from the record; a child that closed `interrupted` comes back as `interrupted` and nothing restarts it", async () => {
    const t = treeDeps(awaitOnlyProvider(["run-far", "run-cut"]));
    const record = (id: string, status: RunRecord["status"], text?: string): RunRecord => {
      const events: RunEvent[] = text ? [{ type: "answer", text, seq: 1 }] : [];
      return {
        id,
        label: "research · child",
        agent: "research",
        model: "anthropic/research-model",
        channelId: "slack:CX",
        userId: "slack:UADMIN",
        threadKey: `slack:CX:${id}`,
        channelVisibility: "public",
        // Recent, so the store's retention keeps the record (the store runs on the real clock here).
        startedAt: Date.now() - 20_000,
        finishedAt: Date.now() - 10_000,
        status,
        eventCount: events.length,
        storedEventCount: events.length,
        truncated: false,
        events,
        diagnosis: analyzeRunFriction(events),
        parentRunId: "run-parent",
      };
    };
    await t.store.put(record("run-far", "completed", "Workers are isolates."));
    await t.store.put(record("run-cut", "interrupted"));
    const { parent } = treeIO();
    const startedAt = Date.now();
    await dispatch(t.deps, inChannel("CX", "agent:conductor collect the write-ups"), parent.io);
    expect(Date.now() - startedAt).toBeLessThan(4_000); // decided on the first read, no poll
    expect(parent.replies).toHaveLength(1);
    const report = JSON.parse(parent.replies[0]) as { ended: string; runs: Array<Record<string, unknown>> };
    expect(report.ended).toBe("all_ended");
    expect(report.runs.map((r) => [r.id, r.status])).toEqual([
      ["run-far", "completed"],
      ["run-cut", "interrupted"],
    ]);
    expect(String(report.runs[0].finalReply)).toContain("Workers are isolates.");
    expect("finalReply" in report.runs[1]).toBe(false);
    // Nothing was restarted: one run provisioned (the conductor), no run for either id anywhere live.
    expect(agentsProvisioned()).toEqual(["conductor"]);
    expect(t.registry.getById("run-far")).toBeNull();
    expect(t.registry.getById("run-cut")).toBeNull();
    expect((await t.store.get("run-cut"))!.status).toBe("interrupted");
  });

  // docs/reference/specs/agent-conductor.md item 10: a child is its thread. A
  // person's reply in a spawned thread is a run of the same child — the
  // parent's id on its record, depth 1, seeded from the thread — and the
  // parent, while it lives, hears the reply as a follow-up from that child.
  /** A person's reply in a child's thread, on the child's own channel handle. */
  const replyIn = (threadKey: string, text: string, url: string) => ({
    channelId: "slack:CX",
    userId: "slack:UADMIN",
    userName: "alice",
    threadKey,
    text,
    sourceUrl: url,
  });

  it("a person's reply in a spawned thread after the child ended is a run of the same child — its agent, sticky by transcript, continuing its session (`seed: session`): its record carries the parent's id, its budget is its own (no parent clock to inherit), and a parent that already ended is told nothing", async () => {
    const { provider } = treeProvider(
      [{ preset: "research", prompt: "what is a Durable Object?" }],
      "A Durable Object is a single-instance coordination point.",
    );
    const t = treeDeps(provider);
    const { parent, child } = treeIO();
    await dispatch(t.deps, inChannel("CX", "agent:conductor look into durable objects"), parent.io);
    await vi.waitFor(() => expect(t.registry.getById("run-child")?.finished).toBe(true));
    await t.writer.settled();
    // Both runs have ended; the person replies in the child's thread.
    await dispatch(
      t.deps,
      replyIn(CHILD_THREAD, "actually, I meant Workflows", "https://acme.slack.com/archives/CX/p91"),
      child.io,
    );
    await t.writer.settled();
    const third = (await t.ledger.finished.get("run-third"))!;
    // The continuation is the child's agent (routing-and-config item 3: the thread's newest finished run is
    // sticky by transcript, a spawned thread's included) and seeds from the child's session log.
    expect(third).toMatchObject({
      agent: "research",
      threadKey: CHILD_THREAD,
      userId: "slack:UADMIN",
      parentRunId: "run-parent",
      seed: "session",
      status: "completed",
    });
    expect(third.profile).toMatchObject({ preset: "research", minutes: AGENTS.research.maxMinutes });
    expect(third.profile!.boundedBy).not.toBe("parent");
    expect(t.registry.getById("run-third")).toMatchObject({ parentRunId: "run-parent", agent: "research" });
    expect(child.replies).toHaveLength(2); // the child's answer, then the continuation's, both in the child's thread
    expect(agentsProvisioned()).toEqual(["conductor", "research", "research"]);
    // The parent had ended: one input on its record, nothing more in its thread.
    const parentRecord = (await t.ledger.finished.get("run-parent"))!;
    expect(parentRecord.events.filter((e) => e.type === "input")).toHaveLength(1);
    expect(parent.replies).toHaveLength(1);
  });

  /** A parent channel whose `openThread` hands out one recording child channel per thread named, in order. */
  function forestIO(threads: ReadonlyArray<{ key: string; url: string }>) {
    const parent = fakeIO();
    const children = threads.map((th) => {
      const history: HistoryItem[] = [];
      return { ...th, ...fakeIO(history), history };
    });
    let n = 0;
    parent.io.openThread = async (lead) => {
      const c = children[n++]!;
      c.history.push({ role: "assistant", text: lead }); // the lead is the thread's first message
      return { thread: { threadKey: c.key, sourceUrl: c.url }, io: c.io };
    };
    return { parent, children };
  }
  /** Every user text part of a request, in order. */
  const userTexts = (req: CompletionRequest): string =>
    req.messages
      .filter((m) => m.role === "user")
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : (m.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? ""),
      )
      .join("\n");
  /**
   * The scenario that motivated item 10: a conductor spawns two children, one slow ([A],
   * held until the test releases it) and one quick ([B]); the requester
   * corrects [B] in its thread while the conductor awaits. The conductor awaits
   * again whenever a wait ended on a follow-up, and answers with the last
   * report. A run in [B]'s thread that carries the correction answers it.
   */
  function continuedThreadProvider(releaseA: Promise<void>) {
    const requests: CompletionRequest[] = [];
    let ids: string[] = [];
    const provider: Provider = {
      name: "fake",
      async complete(req): Promise<CompletionResult> {
        // The runner hands its provider the live conversation array; a snapshot keeps each request's own last turn.
        requests.push({ ...req, messages: [...req.messages] });
        const conducts = req.tools?.some((t) => t.name === "spawn_run") ?? false;
        if (conducts) {
          const results = toolResultTexts(req);
          if (results.length === 0)
            return {
              content: [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "spawn_run",
                  input: { preset: "research", prompt: "[A] what is a Durable Object?" },
                },
                {
                  type: "tool_use",
                  id: "t2",
                  name: "spawn_run",
                  input: { preset: "research", prompt: "[B] what is a Workflow?" },
                },
              ],
              stopReason: "tool_use",
            };
          const spawned = results.filter((r) => r.startsWith("spawned a research run: "));
          if (spawned.length === 2) ids = spawned.map((s) => /run: (\S+) in thread/.exec(s)![1]);
          const report = results.find((r) => r.startsWith("{"));
          const cutByFollowUp = report !== undefined && (JSON.parse(report) as { ended: string }).ended === "follow_up";
          if (spawned.length === 2 || cutByFollowUp)
            return {
              content: [{ type: "tool_use", id: `w${requests.length}`, name: "await_runs", input: { ids } }],
              stopReason: "tool_use",
            };
          return { content: [{ type: "text", text: results.join("\n---\n") }], stopReason: "end_turn" };
        }
        const asked = userTexts(req);
        if (asked.includes("[A]")) {
          await releaseA;
          return {
            content: [{ type: "text", text: "A: a Durable Object is a coordination point." }],
            stopReason: "end_turn",
          };
        }
        if (asked.includes("actually"))
          return { content: [{ type: "text", text: "B: the grants live in config.yaml." }], stopReason: "end_turn" };
        return { content: [{ type: "text", text: "B: a Workflow is a durable execution." }], stopReason: "end_turn" };
      },
    };
    return { provider, requests };
  }

  it(
    "a person's reply in a child's thread while the parent awaits: the reply reaches the parent as a follow-up from that child (the wait ends `follow_up`), the new run of the child carries the parent's id, and the parent's next await reports the child under its id with `continuedBy` and the thread's newest reply — never the first answer alone",
    { timeout: 20_000 },
    async () => {
      let releaseA!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const admission = new ThreadAdmission<DispatchFollowUp>();
      const { provider, requests } = continuedThreadProvider(held);
      const t = treeDeps(provider, ["run-parent", "run-A", "run-B", "run-B2"]);
      t.deps.admission = admission;
      const THREAD_A = "slack:CX:9.0";
      const THREAD_B = "slack:CX:9.1";
      const { parent, children } = forestIO([
        { key: THREAD_A, url: "https://acme.slack.com/archives/CX/p90" },
        { key: THREAD_B, url: "https://acme.slack.com/archives/CX/p91" },
      ]);
      const [ioA, ioB] = children;
      const parentDone = dispatch(t.deps, inChannel("CX", "agent:conductor look into DOs and Workflows"), parent.io);
      // [B] answers at once; [A] is held, so the parent sits in await_runs by the time B has
      // replied (its spawn results came back at registration, long before). B's record is
      // flushed to the store so the reply below finds B however the registry has aged it.
      await vi.waitFor(() => expect(ioB.replies).toEqual(["B: a Workflow is a durable execution."]));
      await t.writer.settled();
      // …and the parent is in its wait: the reply below must land while it awaits.
      await vi.waitFor(() =>
        expect(
          (t.registry.snapshotById("run-parent")?.events ?? []).some(
            (e) => e.type === "tool_call" && (e as { tool: string }).tool === "await_runs",
          ),
        ).toBe(true),
      );
      // The requester corrects [B] in its thread. The child ended, so this is a new run of it.
      await dispatch(
        t.deps,
        replyIn(THREAD_B, "actually, I meant Switchboard admins", "https://acme.slack.com/archives/CX/p911"),
        ioB.io,
      );
      expect(ioB.replies).toEqual(["B: a Workflow is a durable execution.", "B: the grants live in config.yaml."]);
      releaseA();
      await parentDone;
      await t.writer.settled();

      // The continuation is a run of the same child: the child's agent, sticky by transcript, seeded from its
      // session log (routing-and-config item 3), the parent's id on its record.
      const b2 = (await t.ledger.finished.get("run-B2"))!;
      expect(b2).toMatchObject({
        agent: "research",
        threadKey: THREAD_B,
        parentRunId: "run-parent",
        seed: "session",
        status: "completed",
      });
      expect(b2.profile!.boundedBy).not.toBe("parent");
      // The parent heard the reply as a follow-up from the child, linked to the reply, naming the new run.
      const parentRecord = (await t.ledger.finished.get("run-parent"))!;
      const inputs = parentRecord.events.filter((e) => e.type === "input");
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toMatchObject({
        type: "input",
        source: { user: "alice", run: "run-B", url: "https://acme.slack.com/archives/CX/p911" },
      });
      expect(String((inputs[1] as { text: string }).text)).toContain("actually, I meant Switchboard admins");
      expect(String((inputs[1] as { text: string }).text)).toContain("run-B2");
      expect(String((inputs[1] as { text: string }).text)).toMatch(/thread of your research child/);
      // Its wait ended on the follow-up, and it awaited again before compiling.
      const cut = requests.find((r) => toolResultTexts(r).some((x) => /ended\W+follow_up/.test(x)));
      expect(cut).toBeDefined();
      expect(lastUserTexts(cut!).some((x) => /Follow-up from the thread/.test(x))).toBe(true);
      // The compiled answer reports [B] under its own id, continued by the new run, with the thread's newest reply.
      expect(parent.replies).toHaveLength(1);
      const report = JSON.parse(parent.replies[0]) as { ended: string; runs: Array<Record<string, unknown>> };
      expect(report.ended).toBe("all_ended");
      expect(report.runs.map((r) => [r.id, r.status])).toEqual([
        ["run-A", "completed"],
        ["run-B", "completed"],
      ]);
      expect(report.runs[1]).toMatchObject({ continuedBy: "run-B2", agent: "research", parentRunId: "run-parent" });
      expect(String(report.runs[1].finalReply)).toContain("B: the grants live in config.yaml.");
      expect(String(report.runs[1].finalReply)).not.toContain("durable execution");
      expect("continuedBy" in report.runs[0]).toBe(false);
      expect(String(report.runs[0].finalReply)).toContain("coordination point");
      expect(ioA.replies).toEqual(["A: a Durable Object is a coordination point."]);
      expect(agentsProvisioned()).toEqual(["conductor", "research", "research", "research"]);
      expect(admission.get(PARENT_THREAD)).toBeUndefined();
      expect(admission.get(THREAD_B)).toBeUndefined();
    },
  );
});

// Feature: docs/reference/specs/model-proxy.md — the run-scoped bearer's life
// through a dispatch: minted as the executor is provisioned, valid through the
// model turn, revoked the moment the run finishes.
describe("the model proxy's run bearer through dispatch()", () => {
  it("is minted for the run before its first model turn, pinned to the resolved model and the preset's caps and hung under the request root, and is revoked once the run finishes", async () => {
    const clock = { now: 1_700_000_000_000 };
    const store = new RunBearerStore({ clock: () => clock.now });
    const seen: Array<{ runId: string | undefined; verified: boolean; turns: number | undefined }> = [];
    let runId: string | undefined;
    const provider: Provider = {
      name: "fake",
      async complete(): Promise<CompletionResult> {
        // Mid-turn: the run's entry exists, a bearer issued on it verifies, and the meter has spent this one turn.
        const issued = runId ? store.issue(runId) : undefined;
        const verdict = issued ? store.verify(issued.token) : undefined;
        seen.push({ runId, verified: verdict?.ok === true, turns: verdict?.ok ? verdict.turns : undefined });
        return { content: [{ type: "text", text: "answer" }], stopReason: "end_turn" };
      },
    };
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runBearers = store;
    deps.clock = () => clock.now;
    const base = fakeIO();
    const io: ChannelIO = { ...base.io, runStarted: ({ id }) => void (runId = id) };
    await dispatch(deps, msg("hello there"), io);
    expect(base.replies).toContain("answer");
    expect(seen).toEqual([{ runId, verified: true, turns: 1 }]);
    const facts = store.grantOf(runId!);
    expect(facts).toMatchObject({
      runId,
      modelRef: "anthropic/general-model",
      providerName: "anthropic",
      providerType: "anthropic",
      model: "general-model",
      maxTurns: 30, // the general preset's turn guard: its five minutes × RUNAWAY_TURNS_PER_MINUTE
      maxTokens: 16000,
      turns: 1, // the one model call, metered as the proxy meters it
      revoked: true,
      expiresAt: clock.now + 5 * 60_000 + BEARER_MARGIN_MS, // the general preset's five minutes, plus the margin
    });
    expect(store.issue(runId!)).toBeUndefined(); // nothing buys a call after the run's end
  });

  it("a dispatch that ends without a run — a refused agent — mints nothing, and a process without a store runs exactly as before", async () => {
    const store = new RunBearerStore({ clock: () => 1 });
    const deps = makeDeps(YAML_FIXTURE, capturingProvider());
    deps.runBearers = store;
    await dispatch(deps, msg("agent:coding do the thing"), fakeIO().io);
    expect(store.size()).toBe(0);
    const bare = makeDeps(YAML_FIXTURE, capturingProvider());
    const { io, replies } = fakeIO();
    await dispatch(bare, msg("hello there"), io);
    expect(replies).toContain("answer");
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 21 — the request
// router through dispatch(): off is today; a directive always wins; a plain
// message runs as the routed preset with the reason on the card and the
// `route` event on the record; every routed preset dispatches at once.
describe("the request router (docs/reference/specs/routing-and-config.md item 21)", () => {
  const ROUTING_OFF = "routing: { auto: false }\n";
  /** The fixture with the router turned on by name. */
  const routingOn = (yaml: string) => yaml.replace(ROUTING_OFF, "routing: { auto: true }\n");
  /** The fixture with no `routing` block at all: the default — on. */
  const routingUnset = (yaml: string) => yaml.replace(ROUTING_OFF, "");
  const ROUTED_YAML = routingOn(YAML_FIXTURE);
  const FOOTER = "wrong preset? reply agent:<preset> to run it another way";
  /** A scripted router: a change to make is coding, a review ask is review, anything else general. */
  const router = () =>
    vi.fn(async (prompt: { user: string }) => {
      const text = prompt.user;
      const preset = /fix|implement/i.test(text) ? "coding" : /review/i.test(text) ? "review" : "general";
      return JSON.stringify({ preset, reason: `${preset} fits the request` });
    });
  const routeEvents = (registry: RunRegistry, id: string) =>
    (registry.snapshotById(id)?.events ?? []).filter((e) => e.type === "route");
  const metaOf = (registry: RunRegistry, id: string) =>
    (registry.snapshotById(id)?.events ?? []).find((e) => e.type === "run_meta") as
      { agentSource?: string } | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });

  it("turned off (`routing: { auto: false }`): a plain message runs defaults.agent as before the router — never called, no route event, no routed line, no override hint", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    deps.runRegistry = registry;
    deps.routeModel = router();
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("review it for me"), io);
    expect(deps.routeModel).not.toHaveBeenCalled();
    expect(provider.requests[0].model).toBe("general-model");
    expect(routeEvents(registry, "r1")).toEqual([]);
    expect(metaOf(registry, "r1")?.agentSource).toBe("default");
    expect(statuses.every((s) => !s.title.includes("routed:"))).toBe(true);
    expect(statuses.every((s) => !s.detail?.includes(FOOTER))).toBe(true);
  });

  it("on by default: with no `routing` block a plain message routes — to review on its own model, the routed line on the card, the route event on the record, and the closed card ending with how to override", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const provider = capturingProvider();
    const deps = makeDeps(routingUnset(YAML_FIXTURE), provider);
    expect(deps.config.config.routing).toBeUndefined();
    deps.runRegistry = registry;
    deps.routeModel = router();
    const { io, statuses, replies } = fakeIO();
    await dispatch(deps, msg("review it for me"), io);
    expect(deps.routeModel).toHaveBeenCalledTimes(1);
    expect(provider.requests[0].model).toBe("review-model");
    expect(replies).toContain("answer");
    expect(statuses[0].title).toContain("*review* on `anthropic/review-model` · routed: review fits the request");
    expect(routeEvents(registry, "r1")).toEqual([
      expect.objectContaining({ type: "route", preset: "review", model: "anthropic/general-model" }),
    ]);
    expect(metaOf(registry, "r1")?.agentSource).toBe("route");
    // The hint rides the close alone: a reply into the live thread would be a follow-up.
    const closed = statuses.at(-1)!;
    expect(closed.title).toContain("✅");
    expect(closed.detail?.split("\n").at(-1)).toBe(FOOTER);
    expect(statuses.slice(0, -1).every((s) => !s.detail?.includes(FOOTER))).toBe(true);
  });

  it("routing on, a directive on the message: untouched — the router is never called and the run is the directive's", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const provider = capturingProvider();
    const deps = makeDeps(ROUTED_YAML, provider);
    deps.runRegistry = registry;
    deps.routeModel = router();
    const { io } = fakeIO();
    await dispatch(deps, msg("agent:general review it for me"), io);
    expect(deps.routeModel).not.toHaveBeenCalled();
    expect(provider.requests[0].model).toBe("general-model");
    expect(metaOf(registry, "r1")?.agentSource).toBe("directive");
    expect(routeEvents(registry, "r1")).toEqual([]);
  });

  it("routing on, a bare message: routed to review — its own model, the card's `routed:` line from the first paint, the record's route event, and it runs at once", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const provider = capturingProvider();
    const deps = makeDeps(ROUTED_YAML, provider);
    deps.runRegistry = registry;
    deps.routeModel = router();
    const { io, statuses, replies } = fakeIO();
    await dispatch(deps, msg("review it for me"), io);
    expect(deps.routeModel).toHaveBeenCalledTimes(1);
    expect(provider.requests[0].model).toBe("review-model");
    expect(replies).toContain("answer");
    expect(statuses[0].title).toContain("*review* on `anthropic/review-model` · routed: review fits the request");
    expect(routeEvents(registry, "r1")).toEqual([
      expect.objectContaining({
        type: "route",
        preset: "review",
        reason: "review fits the request",
        model: "anthropic/general-model",
      }),
    ]);
    expect(metaOf(registry, "r1")?.agentSource).toBe("route");
  });

  it("a route to ship is a real route: the router answering ship resolves the ship preset — the route event, agentSource route, the routed card line — and the ship pipeline takes it (its own gate refuses here, never a silent fall to the default)", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const provider = capturingProvider();
    const deps = makeDeps(ROUTED_YAML, provider);
    deps.runRegistry = registry;
    deps.routeModel = vi.fn(async () => JSON.stringify({ preset: "ship", reason: "land it" }));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("land the login fix", "slack:UADMIN"), io);
    expect(deps.routeModel).toHaveBeenCalledTimes(1);
    // Ship never runs a provider turn of its own; this harness has none of the
    // runner's seams, so the pipeline's own gate closes the card — the route
    // itself is on the record. The full hand-off (merge: person) is proven in
    // the ship suite.
    expect(provider.requests).toHaveLength(0);
    expect(statuses[0].title).toContain("*ship*");
    expect(statuses[0].title).toContain("routed: land it");
    // The record-level route event and `agentSource: route` on a routed ship
    // run are proven in the ship suite, where the ledger the ship path claims
    // on is wired.
  });

  it("coding is never routed: a router answering coding leaves an admin's change request on defaults.agent, with no route event", async () => {
    let ids = 0;
    const registry = new RunRegistry({ genId: () => `r${++ids}`, genToken: () => "t" });
    const provider = capturingProvider();
    const deps = makeDeps(ROUTED_YAML, provider);
    deps.runRegistry = registry;
    deps.routeModel = router(); // fix → coding, which left the table when ship took its seat
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("fix the flaky login test", "slack:UADMIN"), io);
    expect(deps.routeModel).toHaveBeenCalledTimes(1);
    expect(provider.requests[0].model).toBe("general-model");
    expect(routeEvents(registry, "r1")).toEqual([]);
    expect(metaOf(registry, "r1")?.agentSource).toBe("default");
    expect(statuses.every((s) => !s.title.includes("routed:"))).toBe(true);
  });

  it("a route the requester may not run is no route: ship restricted for the plain user runs defaults.agent", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(ROUTED_YAML.replace("agents: [coding]", "agents: [coding, ship]"), provider);
    deps.routeModel = vi.fn(async () => JSON.stringify({ preset: "ship", reason: "land it" }));
    const { io, statuses } = fakeIO();
    await dispatch(deps, msg("land the login fix"), io); // slack:UX may not run the restricted ship preset
    expect(provider.requests[0].model).toBe("general-model");
    expect(statuses.every((s) => !s.title.includes("routed:"))).toBe(true);
  });

  // The compound form (routing-and-config item 21, "Compound requests";
  // agent-conductor item 9): a plain message with two independent parts runs
  // as one conductor whose brief lists the parts; the conductor spawns one
  // child per part through `dispatch()`, each on its part's preset with a
  // directive of its own, under the requester's permissions and the parent's
  // clock. The card and the record say what was split and why.
  describe("a compound request routes to the conductor", () => {
    const COMPOUND_YAML = routingOn(
      YAML_FIXTURE.replace(
        "    review: anthropic/review-model\n",
        "    review: anthropic/review-model\n    conductor: anthropic/conductor-model\n    research: anthropic/research-model\n",
      ),
    );
    const PARTS = [
      { text: "summarize the open issues in acme/api", preset: "general" },
      { text: "find out why the staging resident went down last night", preset: "research" },
    ];
    /** A router that splits a message carrying "and also" into the two parts above, else routes general. */
    const splitter = () =>
      vi.fn(async (prompt: { user: string }) =>
        /and also/.test(prompt.user)
          ? JSON.stringify({ preset: "conductor", parts: PARTS, reason: "two independent asks" })
          : JSON.stringify({ preset: "general", reason: "general fits" }),
      );
    /** The texts of a request's tool results. */
    const toolResultTexts = (req: CompletionRequest): string[] => {
      const last = req.messages.at(-1);
      if (!last || typeof last.content === "string") return [];
      return last.content
        .filter((p) => p.type === "tool_result")
        .map((p) => (typeof p.content === "string" ? p.content : JSON.stringify(p.content)));
    };
    const firstUserText = (req: CompletionRequest): string => {
      const first = req.messages[0];
      if (!first) return "";
      return typeof first.content === "string"
        ? first.content
        : first.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    };
    /**
     * A conductor that does what its brief says: the first turn reads the
     * numbered `<preset>`: <text> lines under the compound heading and spawns
     * exactly those; the next turn echoes the tool results. A child (no
     * spawn_run tool) answers with one line.
     */
    function briefFollowingProvider() {
      const requests: CompletionRequest[] = [];
      const provider: Provider = {
        name: "fake",
        async complete(req): Promise<CompletionResult> {
          requests.push(req);
          const conducts = req.tools?.some((t) => t.name === "spawn_run") ?? false;
          if (conducts && toolResultTexts(req).length === 0) {
            const lines = [...firstUserText(req).matchAll(/^\d+\. `(\w+)`: (.+)$/gm)];
            return {
              content: lines.map((m, i) => ({
                type: "tool_use" as const,
                id: `t${i + 1}`,
                name: "spawn_run",
                input: { preset: m[1], prompt: m[2] },
              })),
              stopReason: "tool_use",
            };
          }
          if (conducts)
            return { content: [{ type: "text", text: toolResultTexts(req).join("\n") }], stopReason: "end_turn" };
          return { content: [{ type: "text", text: "child done" }], stopReason: "end_turn" };
        },
      };
      return { provider, requests };
    }
    /** A parent channel whose `openThread` hands out one recording child channel per call. */
    function treeIO() {
      const parent = fakeIO();
      const children: Array<ReturnType<typeof fakeIO> & { threadKey: string }> = [];
      const leads: string[] = [];
      parent.io.openThread = async (lead) => {
        leads.push(lead);
        const child = { ...fakeIO(), threadKey: `slack:CX:9.${children.length + 1}` };
        children.push(child);
        return { thread: { threadKey: child.threadKey }, io: child.io };
      };
      return { parent, children, leads };
    }
    function treeDeps(yaml: string, provider: Provider) {
      const ids = ["run-parent", "run-child-1", "run-child-2", "run-child-3"];
      const registry = new RunRegistry({ genId: () => ids.shift() ?? "run-more", genToken: () => "tok" });
      const store = new InMemoryRunStore();
      const writer = createRunHistoryWriter({
        store,
        warn: () => {},
        onPersisted: (id) => registry.markPersisted(id),
        sleep: async () => {},
      });
      const deps = makeDeps(yaml, provider);
      deps.runRegistry = registry;
      deps.runHistoryWriter = writer;
      deps.admission = new ThreadAdmission<DispatchFollowUp>();
      deps.runStore = store;
      const ledger = new InMemoryRunLedger();
      deps.runLedger = createLedgerWriteThrough({
        ledger,
        gen: "gen-C",
        fallback: { put: async () => {} },
        warn: () => {},
      });
      deps.runs = createRunsService({ registry, store: ledgerBackedStore(ledger, store), ledger });
      return { deps, registry, store, writer, ledger };
    }
    const compoundMsg = (user = "slack:UADMIN") => ({
      ...msg(
        "summarize the open issues in acme/api and also look into why the staging resident went down last night",
        user,
      ),
      userName: "alice",
    });

    it("two independent parts: one conductor run with the routed line and the parts on its card, the route event with the parts, and two children spawned through dispatch() — each on its part's preset with a directive of its own, parentRunId set, the router never asked again", async () => {
      const { provider, requests } = briefFollowingProvider();
      const t = treeDeps(COMPOUND_YAML, provider);
      t.deps.routeModel = splitter();
      const { parent, children, leads } = treeIO();
      await dispatch(t.deps, compoundMsg(), parent.io);
      for (const id of ["run-child-1", "run-child-2"])
        await vi.waitFor(() => expect(t.registry.getById(id)?.finished).toBe(true));
      await t.writer.settled();

      // One router call — the parent's; a child carries its directive and is never routed.
      expect(t.deps.routeModel).toHaveBeenCalledTimes(1);
      // The parent ran as the conductor on its own model; its brief is the message then the parts.
      const parentRequest = requests.find((r) => r.tools?.some((tool) => tool.name === "spawn_run"))!;
      expect(parentRequest.model).toBe("conductor-model");
      const brief = firstUserText(parentRequest);
      expect(
        brief.startsWith(
          "summarize the open issues in acme/api and also look into why the staging resident went down last night\n",
        ),
      ).toBe(true);
      expect(brief).toContain("Routed as a compound request: 2 independent parts");
      expect(brief).toContain("1. `general`: summarize the open issues in acme/api");
      expect(brief).toContain("2. `research`: find out why the staging resident went down last night");
      // The card: the routed line in the label, one line per part under it, from the first paint.
      expect(parent.statuses[0].title).toContain(
        "*conductor* on `anthropic/conductor-model` · routed: two independent asks",
      );
      expect(parent.statuses[0].detail).toBe(
        "general: summarize the open issues in acme/api\nresearch: find out why the staging resident went down last night",
      );
      // The record: run_meta says route, the route event carries the parts.
      expect(metaOf(t.registry, "run-parent")?.agentSource).toBe("route");
      expect(routeEvents(t.registry, "run-parent")).toEqual([
        expect.objectContaining({
          type: "route",
          preset: "conductor",
          reason: "two independent asks",
          model: "anthropic/general-model",
          parts: PARTS,
        }),
      ]);
      expect((await t.ledger.finished.get("run-parent"))!.events.filter((e) => e.type === "input")).toEqual([
        expect.objectContaining({
          text: "summarize the open issues in acme/api and also look into why the staging resident went down last night",
        }),
      ]);
      // Two children, one per part, each on its part's preset with its directive, as the requester, under the parent.
      expect(leads).toHaveLength(2);
      expect(leads[0]).toContain("*general*");
      expect(leads[1]).toContain("*research*");
      const kids = await Promise.all([t.ledger.finished.get("run-child-1"), t.ledger.finished.get("run-child-2")]);
      expect(kids.map((k) => k!.agent).sort()).toEqual(["general", "research"]);
      for (const kid of kids) {
        expect(kid).toMatchObject({ userId: "slack:UADMIN", parentRunId: "run-parent", status: "completed" });
        // The parent's remaining clock is one more boundary on the child; these
        // presets' own budgets (5 and 8 min) are the tighter ones under a fresh conductor.
        expect(kid!.profile).toMatchObject({ preset: kid!.agent, minutes: AGENTS[kid!.agent!].maxMinutes });
        // The child's message carried `agent:<preset>` (the record's input is
        // directive-stripped, so it is the part's text alone) and resolved as
        // a directive: the router was never asked and no route event exists.
        const part = PARTS.find((p) => p.preset === kid!.agent)!;
        expect(kid!.events.find((e) => e.type === "input")).toMatchObject({ text: part.text });
        expect(kid!.events.find((e) => e.type === "run_meta")).toMatchObject({ agentSource: "directive" });
        expect(kid!.events.some((e) => e.type === "route")).toBe(false);
      }
      expect(children.map((c) => c.replies)).toEqual([["child done"], ["child done"]]);
      expect(
        vi
          .mocked(makeExecutor)
          .mock.calls.map((c) => c[1].agent.name)
          .sort(),
      ).toEqual(["conductor", "general", "research"]);
      // The parent's answer echoes both spawns.
      expect(parent.replies[0]).toContain("spawned a general run: run-child-1");
      expect(parent.replies[0]).toContain("spawned a research run: run-child-2");
    });

    it("a requester who may not run the conductor is never offered the form: the message runs defaults.agent, no child is spawned, and the record's route event keeps the rejection", async () => {
      const { provider, requests } = briefFollowingProvider();
      const t = treeDeps(COMPOUND_YAML.replace("agents: [coding]", "agents: [coding, conductor]"), provider);
      t.deps.routeModel = splitter();
      const { parent, children } = treeIO();
      await dispatch(t.deps, compoundMsg("slack:UX"), parent.io);
      expect(t.deps.routeModel).toHaveBeenCalledTimes(1);
      expect(vi.mocked(t.deps.routeModel).mock.calls[0][0].system).not.toMatch(/conductor|compound/i);
      expect(requests[0].model).toBe("general-model");
      expect(children).toHaveLength(0);
      expect(parent.statuses.every((s) => !s.title.includes("routed:"))).toBe(true);
      expect(metaOf(t.registry, "run-parent")?.agentSource).toBe("default");
      expect(routeEvents(t.registry, "run-parent")).toEqual([
        expect.objectContaining({
          type: "route",
          preset: "general",
          reason: "compound_rejected: the compound form was not offered",
          model: "anthropic/general-model",
        }),
      ]);
    });

    it("a part on a preset the requester may not run rejects the whole compound: the plain user's message runs defaults.agent with the rejection recorded", async () => {
      const { provider, requests } = briefFollowingProvider();
      const t = treeDeps(COMPOUND_YAML, provider);
      t.deps.routeModel = vi.fn(async () =>
        JSON.stringify({
          preset: "conductor",
          parts: [PARTS[0], { text: "fix the flaky login test", preset: "coding" }],
          reason: "a review and a fix",
        }),
      );
      const { parent, children } = treeIO();
      await dispatch(t.deps, compoundMsg("slack:UX"), parent.io);
      expect(requests[0].model).toBe("general-model");
      expect(children).toHaveLength(0);
      expect(routeEvents(t.registry, "run-parent")[0]).toMatchObject({
        preset: "general",
        reason: 'compound_rejected: part 2 names "coding", which is not in the table',
      });
    });

    it("a compound answer with a ship part collapses to one ship run: no child is spawned, the card names the collapse, the route event carries it and no parts", async () => {
      const { provider, requests } = briefFollowingProvider();
      const t = treeDeps(COMPOUND_YAML, provider);
      t.deps.routeModel = vi.fn(async () =>
        JSON.stringify({
          preset: "conductor",
          parts: [
            { text: "review the login PR", preset: "review" },
            { text: "fix the flaky login test", preset: "ship" },
          ],
          reason: "a review and a fix",
        }),
      );
      const { parent, children } = treeIO();
      const text = "review the login PR and fix the flaky login test it touches";
      await dispatch(t.deps, { ...msg(text, "slack:UADMIN"), userName: "alice" }, parent.io);
      await t.writer.settled();
      expect(t.deps.routeModel).toHaveBeenCalledTimes(1);
      // Ship runs the plan runner, never a provider turn of its own; this
      // harness carries none of the runner's seams, so its own gate closes the
      // run — the collapse decision is what this scenario proves, and the full
      // routed hand-off (merge: person) is the ship suite's.
      expect(requests).toHaveLength(0);
      expect(children).toHaveLength(0);
      // The card: the routed line names the collapse; no part lines under it.
      expect(parent.statuses[0].title).toContain("*ship*");
      expect(parent.statuses[0].title).toContain("routed: a review and a fix (compound collapsed: review+ship)");
      expect(parent.statuses[0].detail).toBeUndefined();
      // The collapse decision itself (the event's `collapsed.presets`, no
      // `parts`) is proven at the route stage in route.test.ts; the routed
      // hand-off's record (merge: person, agentSource route) in the ship
      // suite. This harness has no repository bound, so the ship pipeline
      // refuses before a run is claimed — no record to read here.
    });

    it("a decoy — one ask with several steps — the router keeps single: no conductor, no parts, the single route's card and event", async () => {
      const { provider } = briefFollowingProvider();
      const t = treeDeps(COMPOUND_YAML, provider);
      t.deps.routeModel = splitter();
      const { parent, children } = treeIO();
      await dispatch(
        t.deps,
        { ...msg("clone acme/api, run the suite, then tell me what fails", "slack:UADMIN") },
        parent.io,
      );
      expect(children).toHaveLength(0);
      expect(parent.statuses[0].title).toContain("*general* on `anthropic/general-model` · routed: general fits");
      expect(parent.statuses[0].detail).toBeUndefined();
      expect(routeEvents(t.registry, "run-parent")[0]).not.toHaveProperty("parts");
    });
  });
});

// Feature: docs/reference/specs/execution.md item 20 (record 0033) — inbound staging
// through the dispatcher: a file the message carries by reference is copied
// into the store after admission (overlapping the workspace attach) and pulled
// into `attachments/` over the run's executor before the model's first read,
// whose turn ends with the line naming it; a workspace-less agent copies
// nothing and is told where the file can be worked with; a refused steer
// copies nothing; without a store nothing is staged.
describe("inbound staging (record 0033)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(makeExecutor).mockClear();
  });
  const clip = {
    name: "clip.mp4",
    size: 3_120,
    type: "video/mp4",
    url: "https://files.slack.com/files-pri/T1-F1/clip.mp4",
    messageId: "1700000000.000200",
  };
  /** A store whose copies are served by a fake Slack answering exactly the declared size. */
  const storeWithSlack = () =>
    new InMemoryArtifactStore({
      bucket: "test",
      fetch: (async () =>
        new Response(new Uint8Array(clip.size), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })) as unknown as typeof fetch,
    });
  const recordingExecutor = () => {
    const commands: string[] = [];
    const executor = {
      exec: async (command: string) => {
        commands.push(command);
        return "";
      },
      readFile: async () => "",
      writeFile: async () => "",
      release: async () => ({ released: true }),
    };
    return { commands, executor };
  };
  const lastUserText = (provider: ReturnType<typeof capturingProvider>) => {
    const user = provider.requests[0]!.messages.filter((m) => m.role === "user").at(-1)!;
    return typeof user.content === "string"
      ? user.content
      : user.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
  };

  it("a coding run: the copy starts after admission and before the attach, the pull runs over the run's executor, the first user turn ends with the line, and the record carries the `in` event", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const store = storeWithSlack();
    deps.artifacts = store;
    let copiesAtAttach = -1;
    const { commands, executor } = recordingExecutor();
    vi.mocked(makeExecutor).mockImplementationOnce(async () => {
      copiesAtAttach = store.copies.length; // the copy was asked for before the workspace attach
      return { executor };
    });
    const { io } = fakeIO();
    await dispatch(deps, { ...msg("agent:coding cut a contact sheet from this", "slack:UADMIN"), staged: [clip] }, io);
    expect(copiesAtAttach).toBe(1);
    expect(store.copies).toEqual([
      { url: clip.url, size: clip.size, key: "threads/slack-CX-1.0/in/1700000000.000200/1-clip.mp4" },
    ]);
    expect(await store.head("threads/slack-CX-1.0/in/1700000000.000200/1-clip.mp4")).toEqual({
      size: clip.size,
      contentType: "video/mp4",
    });
    // The pull, over the run's executor, into attachments/ — before the model's first read.
    const pull = commands.find((c) => c.includes("'attachments/1-clip.mp4'"));
    expect(pull).toMatch(/^mkdir -p attachments && curl -fsS -o 'attachments\/1-clip\.mp4' 'memory:\/\/test\/threads/);
    expect(lastUserText(provider)).toMatch(
      /Attached files are in \.\/attachments\/: 1-clip\.mp4 \(3 KB, video\/mp4\)$/,
    );
  });

  it("a general run copies nothing and its turn says the agent has no workspace for the file", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const store = storeWithSlack();
    deps.artifacts = store;
    const { io } = fakeIO();
    await dispatch(deps, { ...msg("what is in this video?"), staged: [clip] }, io);
    expect(store.copies).toEqual([]);
    expect(lastUserText(provider)).toContain(
      "this agent has no workspace for clip.mp4 (3 KB, video/mp4); ask `agent:coding` to work with it",
    );
  });

  it("without a store nothing is staged: no pull, and the turn carries no line", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const { commands, executor } = recordingExecutor();
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor });
    const { io } = fakeIO();
    await dispatch(deps, { ...msg("agent:coding fix it", "slack:UADMIN"), staged: [clip] }, io);
    expect(commands.some((c) => c.includes("attachments/"))).toBe(false);
    expect(lastUserText(provider)).not.toContain("attachments/");
  });

  // The thread's earlier files: a later run in the thread finds the files dropped
  // on earlier messages too — the prior runs' records name them by key, the store
  // is asked by HEAD, nothing is copied again, and the new record carries them.
  it("a later run in the thread pulls the files dropped on earlier messages: the prior record's `in` events name the keys, each is HEAD-checked and pulled before the message's own file, none is re-copied, the new record carries the event, and an expired key is named", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", "");
    const provider = capturingProvider();
    const deps = makeDeps(REMOTE_YAML_FIXTURE, provider);
    const store = storeWithSlack();
    deps.artifacts = store;
    const registry = new RunRegistry({ genId: () => "r1", genToken: () => "t1" });
    deps.runRegistry = registry;
    const earlierKey = "threads/slack-CX-1.0/in/1700000000.000100/1-earlier.mp4";
    const goneKey = "threads/slack-CX-1.0/in/1700000000.000100/2-gone.mp4";
    store.put(earlierKey, new Uint8Array(4_096), "video/mp4");
    const priorEvents: RunEvent[] = [
      {
        type: "artifact",
        direction: "in",
        key: earlierKey,
        name: "earlier.mp4",
        size: 4_096,
        contentType: "video/mp4",
        messageId: "1700000000.000100",
        at: 1,
        seq: 1,
      },
      {
        type: "artifact",
        direction: "in",
        key: goneKey,
        name: "gone.mp4",
        size: 8_192,
        contentType: "video/mp4",
        messageId: "1700000000.000100",
        at: 2,
        seq: 2,
      },
    ];
    const runStore = new InMemoryRunStore();
    await runStore.put({
      id: "earlier-run",
      agent: "coding",
      channelId: "slack:CX",
      userId: "slack:UADMIN",
      threadKey: "slack:CX:1.0",
      channelVisibility: "public",
      startedAt: Date.now() - 5000,
      finishedAt: Date.now() - 1000,
      status: "completed",
      eventCount: 2,
      storedEventCount: 2,
      truncated: false,
      events: priorEvents as RunRecord["events"],
      diagnosis: analyzeRunFriction(priorEvents),
    });
    deps.runStore = runStore;
    const { commands, executor } = recordingExecutor();
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor });
    const { io } = fakeIO([
      { role: "user", text: "here is the clip" },
      { role: "assistant", text: "got it" },
    ]);
    await dispatch(deps, { ...msg("agent:coding now cut a contact sheet", "slack:UADMIN"), staged: [clip] }, io);
    // The message's own file takes 1- (its copy was asked for first), the thread's earlier file 2-;
    // the expired key is never pulled.
    expect(commands.filter((c) => c.includes("attachments/")).map((c) => /attachments\/([^']+)'/.exec(c)![1])).toEqual([
      "1-clip.mp4",
      "2-earlier.mp4",
    ]);
    // Only the message's own file is copied; the thread's earlier file is already in the store.
    expect(store.copies.map((c) => c.key)).toEqual(["threads/slack-CX-1.0/in/1700000000.000200/1-clip.mp4"]);
    const text = lastUserText(provider);
    expect(text).toContain("1-clip.mp4 (3 KB, video/mp4)");
    expect(text).toContain("2-earlier.mp4 (4 KB, video/mp4, from earlier in the thread)");
    expect(text).toContain("gone.mp4 could not be staged: the store no longer holds it (its retention passed)");
    // The prompt lists the thread's files (record 0033) — the same catalogue the re-pull read — one line
    // each with where the file is for this run; this run's own file is the turn's, not the list's.
    const system = provider.requests[0].system ?? "";
    expect(system).toContain("FILES OF THIS THREAD");
    expect(system).toContain(
      "- earlier.mp4 (4 KB, video/mp4) — received on this thread; in this workspace at ./attachments/2-earlier.mp4",
    );
    expect(system).toContain(
      "- gone.mp4 (8 KB, video/mp4) — received on this thread; no longer in the store (its retention passed)",
    );
    expect(system).not.toContain("clip.mp4 (3 KB");
    // The new record names the earlier key as its own `in` event — the run page serves only keys the run
    // names; the copy and the HEAD answer concurrently, so the two events' order is not fixed.
    const mine = registry.snapshotById("r1")!.events.filter((e) => e.type === "artifact");
    expect(mine.map((e) => (e.type === "artifact" ? e.key : "")).sort()).toEqual(
      [earlierKey, "threads/slack-CX-1.0/in/1700000000.000200/1-clip.mp4"].sort(),
    );
  });
});

// docs/reference/specs/session-log.md item 9 (records 0034 and 0035): a
// follow-up in a thread whose newest run is on the pi harness continues that
// run's agent by transcript and starts from the session log — its tail, the
// lines written since, the request — instead of the thread's Slack history.
describe("a follow-up seeds from its session (docs/reference/specs/session-log.md item 9)", () => {
  const THREAD = "slack:CX:1.0";
  const KEY = `${THREAD}:coding`;
  const PI_YAML = REMOTE_YAML_FIXTURE + "harness:\n  coding: pi\n";
  const NOW = Date.now();
  const PREVIOUS_END = NOW - 10_000;
  const user = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });
  const assistant = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] });
  /** The previous coding run's conversation, rows 0..3 of the session log. */
  const tail: ChatMessage[] = [
    user("fix the flaky test"),
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "1 failed" }] },
    assistant("fixed it"),
  ];
  /** The thread as Slack shows it: the earlier ask and answer, then a line a person wrote after the run ended. */
  const history: HistoryItem[] = [
    { role: "user", text: "fix the flaky test", at: NOW - 20_000 },
    { role: "assistant", text: "fixed it", at: NOW - 11_000 },
    { role: "user", text: "also check the lockfile", at: NOW - 5_000 },
  ];
  const followUp = { channelId: "slack:CX", userId: "slack:UADMIN", threadKey: THREAD, text: "and bump the version" };
  /** The coding run's workspace: a fake executor that answers every command with nothing. */
  const fakeExecutor = () => ({
    exec: async () => "",
    readFile: async () => "",
    writeFile: async () => "",
    release: async () => ({ released: true }),
  });

  /** A thread whose newest run is a finished coding run: its record in the store, its rows in the session log. */
  async function threadWithSession(yaml: string) {
    const registry = new RunRegistry({ genId: () => "run-next", genToken: () => "tok" });
    const store = new InMemoryRunStore();
    const ledger = new InMemoryRunLedger();
    const warnings: string[] = [];
    const writer = createRunHistoryWriter({
      store,
      warn: () => {},
      onPersisted: (id) => registry.markPersisted(id),
      sleep: async () => {},
    });
    const provider = capturingProvider();
    const deps = makeDeps(yaml, provider);
    deps.runRegistry = registry;
    deps.runHistoryWriter = writer;
    deps.runStore = store;
    deps.runs = createRunsService({ registry, store });
    deps.runLedger = createLedgerWriteThrough({
      ledger,
      gen: "gen-S",
      fallback: { put: async () => {} },
      warn: (m) => warnings.push(m),
    });
    deps.harness = { registry: new HarnessRegistry(), harnessUrl: "https://bot.test" };
    deps.runBearers = new RunBearerStore({ clock: () => NOW });
    deps.resolveRepoContext = () => ({ repo: "acme/api", ref: "main" });
    await ledger.claimSession(KEY, "run-prev", "gen-R");
    await ledger.seed(
      "run-prev",
      "gen-R",
      tail.map((message, idx) => ({ idx, message })),
      KEY,
    );
    // The previous run kept notes (session-log item 10): they ride the next run's prompt.
    await ledger.writeNotepad(KEY, "gen-R", "decided: keep the helper; head green at abc123");
    await ledger.releaseSession(KEY, "run-prev", "gen-R");
    await store.put({
      id: "run-prev",
      label: "coding · acme/api",
      agent: "coding",
      model: "anthropic/coding-model",
      channelId: "slack:CX",
      userId: "slack:UADMIN",
      threadKey: THREAD,
      channelVisibility: "public",
      startedAt: NOW - 20_000,
      finishedAt: PREVIOUS_END,
      status: "completed",
      eventCount: 0,
      storedEventCount: 0,
      truncated: false,
      events: [],
      diagnosis: analyzeRunFriction([]),
      repo: "acme/api",
      seed: "channel",
      session: { key: KEY, seedFrom: 0, request: 0, range: { from: 0, to: 3 } },
      // The run's post-step opened a pull request (run-history item 2): the
      // fact a follow-up's target resolution reads (resident-repos item 29).
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    });
    return { deps, registry, store, ledger, writer, warnings, provider };
  }

  // The pass-through spy keeps the real harness as its default; a test scripts
  // one call with `mockImplementationOnce`, which the call consumes.
  beforeEach(() => {
    vi.mocked(runPiHarnessOpen).mockClear();
    vi.mocked(makeExecutor).mockClear();
  });

  it("a follow-up in a thread whose newest run is a coding run on pi continues coding without a directive and seeds from the session log: the pi harness is handed the log's tail, the line written since and the request; the record says seed: session with seedFrom inside the earlier run's range and range.from at the tail, and its context events are the tail's text turns", async () => {
    const t = await threadWithSession(PI_YAML);
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fakeExecutor() });
    let handed: ChatMessage[] | undefined;
    let agentOnPi: string | undefined;
    let systemOnPi: string | undefined;
    let notepadOnPi: string | undefined;
    let sessionTools: string[] = [];
    vi.mocked(runPiHarnessOpen).mockImplementationOnce(async (_deps, run) => {
      handed = run.messages;
      agentOnPi = run.agent.name;
      systemOnPi = run.system;
      notepadOnPi = (await run.notepad?.())?.text;
      sessionTools = run.tools.map((tool) => tool.name).filter((name) => name === "recall" || name === "notes");
      return piAnswered("bumped");
    });
    const { io, replies } = fakeIO(history);
    await dispatch(t.deps, followUp, io);
    await t.writer.settled();
    expect(agentOnPi).toBe("coding");
    expect(handed).toEqual([...tail, user("also check the lockfile"), user("and bump the version")]);
    // The notepad rides the prompt (session-log item 10), never a row; the harness can read it for
    // the compaction steer; the two session tools are relayed to pi.
    expect(systemOnPi).toContain("YOUR NOTES FOR THIS THREAD");
    expect(systemOnPi).toContain("decided: keep the helper; head green at abc123");
    expect(notepadOnPi).toBe("decided: keep the helper; head green at abc123");
    expect(sessionTools).toEqual(["recall", "notes"]);
    expect(replies.at(-1)).toBe("bumped");
    // The router was never asked and the scripted provider never called: the agent came from the thread's transcript.
    expect(t.provider.requests).toHaveLength(0);
    // The finish lands on the ledger (the history store in production); the plain store keeps the tombstone.
    const record = t.ledger.finished.get("run-next")!;
    expect(record).toMatchObject({ agent: "coding", seed: "session", status: "completed", threadKey: THREAD });
    expect(record.session).toEqual({ key: KEY, seedFrom: 0, request: 5, range: { from: 4, to: 5 } });
    const meta = record.events.find((e) => e.type === "run_meta") as { agentSource?: string } | undefined;
    expect(meta?.agentSource).toBe("sticky");
    expect(record.events.filter((e) => e.type === "context").map((e) => (e as { text: string }).text)).toEqual([
      "user: fix the flaky test",
      "assistant: fixed it",
      "user: also check the lockfile",
    ]);
    // The log: the tail's rows once, then the line since and the request as the run's own first rows.
    const log = await t.ledger.readSession(KEY, 0);
    expect(log.messages).toEqual([...tail, user("also check the lockfile"), user("and bump the version")]);
    expect(t.warnings).toEqual([]);
  });

  // docs/reference/specs/routing-and-config.md item 21: a sticky-by-transcript
  // follow-up in a routed thread carries the thread's route — the receipt on
  // the card, the decision on the record — while the router stays unasked, no
  // route event is published and `run_meta.agentSource` stays `sticky`.
  it("a sticky follow-up in a routed thread carries the thread's route: the card's routed line and override footer, the record's route field with parts and collapse stripped, no route event, agentSource sticky, the router never asked", async () => {
    const t = await threadWithSession(PI_YAML);
    const prev = (await t.store.get("run-prev"))!;
    await t.store.put({
      ...prev,
      route: {
        preset: "coding",
        reason: "an imperative ask in a repo thread",
        model: "anthropic/fast",
        collapsed: { presets: ["review", "coding"] },
      },
    });
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fakeExecutor() });
    vi.mocked(runPiHarnessOpen).mockImplementationOnce(async () => piAnswered("carried"));
    const { io, statuses } = fakeIO(history);
    await dispatch(t.deps, followUp, io);
    await t.writer.settled();
    // The card says why the preset was chosen, from the first paint, without the earlier run's collapse.
    expect(statuses[0].title).toContain(
      "*coding* on `anthropic/coding-model` · routed: an imperative ask in a repo thread",
    );
    expect(statuses[0].title).not.toContain("compound collapsed");
    expect(statuses.at(-1)!.detail?.split("\n").at(-1)).toBe(
      "wrong preset? reply agent:<preset> to run it another way",
    );
    // The router was never asked: the preset is the transcript's.
    expect(t.provider.requests).toHaveLength(0);
    // The record: the carried decision on `route`, no `route` event, `agentSource` sticky —
    // so the NEXT follow-up reads the same receipt off this record.
    const record = t.ledger.finished.get("run-next")!;
    expect(record.route).toEqual({
      preset: "coding",
      reason: "an imperative ask in a repo thread",
      model: "anthropic/fast",
    });
    expect(record.events.some((e) => e.type === "route")).toBe(false);
    const meta = record.events.find((e) => e.type === "run_meta") as { agentSource?: string } | undefined;
    expect(meta?.agentSource).toBe("sticky");
  });

  it("a log that cannot be read seeds from the channel with a seed note naming it, and the agent is still the thread's", async () => {
    const t = await threadWithSession(PI_YAML);
    t.deps.runLedger.readSessionTail = async () => {
      throw new Error("no such route");
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fakeExecutor() });
    let handed: ChatMessage[] | undefined;
    vi.mocked(runPiHarnessOpen).mockImplementationOnce(async (_deps, run) => {
      handed = run.messages;
      return piAnswered("done anyway");
    });
    const { io } = fakeIO(history);
    await dispatch(t.deps, followUp, io);
    await t.writer.settled();
    // The finish lands on the ledger (the history store in production); the plain store keeps the tombstone.
    const record = t.ledger.finished.get("run-next")!;
    expect(record).toMatchObject({ agent: "coding", seed: "channel", status: "completed" });
    expect(handed?.map((m) => m.role)).toEqual(["user", "assistant", "user"]); // the channel's history, merged, then the request
    const notes = record.events.filter((e) => e.type === "run_note") as Array<{ kind: string; summary: string }>;
    expect(notes.map((n) => n.kind)).toContain("seed");
    expect(notes.find((n) => n.kind === "seed")!.summary).toContain(`the log ${KEY} could not be read (no such route)`);
  });

  it("the thread's pull request rides the target resolution (docs/reference/specs/resident-repos.md item 29): the newest run's record names the PR it opened, and the resolver is handed it beside the message and the history", async () => {
    const t = await threadWithSession(PI_YAML);
    const handedRecords: unknown[] = [];
    t.deps.resolveRepoContext = (_msg, _history, records) => {
      handedRecords.push(records);
      return { repo: "acme/api", ref: "fix/x", refFromPr: true, pr: 7, headSha: "a".repeat(40), baseRef: "main" };
    };
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fakeExecutor() });
    vi.mocked(runPiHarnessOpen).mockImplementationOnce(async () => piAnswered("done"));
    const { io } = fakeIO(history);
    await dispatch(t.deps, followUp, io);
    await t.writer.settled();
    expect(handedRecords).toEqual([{ pr: { repo: "acme/api", number: 7, at: PREVIOUS_END } }]);
  });

  // docs/reference/specs/harness-pi.md item 4: the config's `pi.compaction` reaches the harness deps for a run on pi.
  it("the deployment's compaction thresholds ride from the config into the pi harness's deps; a config without the block hands none", async () => {
    const t = await threadWithSession(PI_YAML + "pi:\n  compaction:\n    reserveTokens: 150000\n");
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fakeExecutor() });
    let compaction: unknown = "unset";
    vi.mocked(runPiHarnessOpen).mockImplementationOnce(async (deps) => {
      compaction = deps.compaction;
      return piAnswered("done");
    });
    const { io } = fakeIO(history);
    await dispatch(t.deps, followUp, io);
    await t.writer.settled();
    expect(compaction).toEqual({ reserveTokens: 150_000 });

    const plain = await threadWithSession(PI_YAML);
    vi.mocked(makeExecutor).mockResolvedValueOnce({ executor: fakeExecutor() });
    let none: unknown = "unset";
    vi.mocked(runPiHarnessOpen).mockImplementationOnce(async (deps) => {
      none = deps.compaction;
      return piAnswered("done");
    });
    await dispatch(plain.deps, followUp, fakeIO(history).io);
    await plain.writer.settled();
    expect(none).toBeUndefined();
  });
});

// Record 0037: the references step through `dispatch()` — the flag gate lives
// here, not in the step, so this is where "off means no adapter call" and "on
// means the block reaches the model on the request turn" are proven.
describe("the references step in dispatch (record 0037)", () => {
  const PERMALINK = "https://team.example/archives/C_PUB/p1700000000000100";
  function fakeReader() {
    const calls = { classify: 0, read: 0, member: 0 };
    const reader: ConversationReader = {
      platform: "slack",
      parseConversationUrl: (u) =>
        u === PERMALINK ? { channelId: "slack:C_PUB", threadKey: "slack:C_PUB:1700000000.000100", url: u } : undefined,
      classifyConversation: async () => {
        calls.classify++;
        return { visibility: "public", botIsMember: true, channelName: "frontend" };
      },
      readConversation: async (ref) => {
        calls.read++;
        return {
          kind: "reference",
          ref,
          channelName: "frontend",
          permalink: ref.url,
          messages: [{ at: 1_700_000_000_000, author: "teammate", text: "we concluded: ship it" }],
        };
      },
      requesterIsFullMember: async () => {
        calls.member++;
        return true;
      },
    };
    return { reader, calls };
  }
  const lastUserTexts = (req: CompletionRequest) => {
    const last = [...req.messages].reverse().find((m) => m.role === "user")!;
    return last.content
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
  };

  it("with references.enabled off (the default) a registered reader is never called and the model sees the request alone", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE, provider);
    const { reader, calls } = fakeReader();
    deps.conversationReaders = [reader];
    const { io, replies } = fakeIO();
    await dispatch(deps, msg(`what did we conclude? ${PERMALINK}`), io);
    expect(calls).toEqual({ classify: 0, read: 0, member: 0 });
    expect(provider.requests).toHaveLength(1);
    expect(lastUserTexts(provider.requests[0])).toEqual([`what did we conclude? ${PERMALINK}`]);
    expect(replies.some((r) => r.includes("I can't read that thread"))).toBe(false);
  });

  it("with references.enabled on, the quoted block reaches the model as a text part after the request's text, and its event is head material", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE + "references: { enabled: true }\n", provider);
    const { reader, calls } = fakeReader();
    deps.conversationReaders = [reader];
    const { io } = fakeIO();
    await dispatch(deps, msg(`what did we conclude? ${PERMALINK}`), io);
    expect(calls).toEqual({ classify: 1, read: 1, member: 1 });
    // The request turn reaches pi as one prompt: the request, then the quoted block, joined with a blank line (harness-pi item 9).
    const [prompt, ...rest] = lastUserTexts(provider.requests[0]);
    expect(rest).toEqual([]);
    expect(prompt).toMatch(
      new RegExp(
        `^what did we conclude\\? ${PERMALINK.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\n\nReferenced thread · #frontend · 1 message · https://team\\.example`,
      ),
    );
    expect(prompt).toContain("teammate: we concluded: ship it");
    expect(
      isHeadMaterial({
        type: "reference",
        url: PERMALINK,
        channelId: "slack:C_PUB",
        channelName: "frontend",
        messages: 1,
        text: "…",
      }),
    ).toBe(true);
  });

  it("a refused reference posts the one refusal line after the run's card opened, once, and the model still runs", async () => {
    const provider = capturingProvider();
    const deps = makeDeps(YAML_FIXTURE + "references: { enabled: true }\n", provider);
    const { reader, calls } = fakeReader();
    reader.classifyConversation = async () => {
      calls.classify++;
      return { visibility: "never", botIsMember: false };
    };
    deps.conversationReaders = [reader];
    // The channel's calls in the order they were made: the card is `status`,
    // a reply is `reply:<text>`. The refusal must not be the thread's first post.
    const order: string[] = [];
    const { io: inner, replies } = fakeIO();
    const io: ChannelIO = {
      ...inner,
      reply: async (t) => {
        order.push(`reply:${t}`);
        await inner.reply(t);
      },
      status: async (initial) => {
        order.push("status");
        return inner.status(initial);
      },
    };
    await dispatch(deps, msg(`what did we conclude? ${PERMALINK}`), io);
    expect(calls).toEqual({ classify: 1, read: 0, member: 1 });
    expect(replies.filter((r) => r === REFERENCE_REFUSAL)).toHaveLength(1);
    expect(order.indexOf("status")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`reply:${REFERENCE_REFUSAL}`)).toBeGreaterThan(order.indexOf("status"));
    expect(provider.requests).toHaveLength(1);
    expect(lastUserTexts(provider.requests[0])).toEqual([`what did we conclude? ${PERMALINK}`]);
  });
});
