import type { CheckExecutionReceipt } from "../checkExecutionTypes.js";
import { HarnessEndingUnconfirmedError } from "../harness/container.js";
import type { GithubWriteResult } from "../../execution/githubPulls.js";
import { findPullOwnersInRows } from "../coordinator/pullOwnership.js";
import { terminalPublicationRetentionRequired } from "../branchPublication.js";
import { parentContextOf } from "./handoff.js";
import { contextCapsuleOf } from "./unitContext.js";
import { MainContextCaptureError } from "./mainContextCapture.js";
import type { AudienceCheck } from "../audienceDecision.js";
import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { testSlackCapability } from "../testing/slackSources.js";
import type { RunLoopContext } from "./runLoop.js";
import { depotCiAuthorizations } from "../../execution/depotCiAuthorization.js";
import { buildReviewPostBody, parseVerdictInput } from "../reviewVerdict.js";
import type { Verbosity } from "../verbosity.js";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ASKS } from "../budgets.js";
import { RunEventLane } from "../runEventLane.js";
import { ConfigStore } from "../../config.js";
import { PLANE_ACTOR_ID } from "../authz/grants.js";
import { reissueSteerSentence } from "../plane/decide.js";
import { visibilityOf } from "../authz/channelDirectory.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { TEST_GITHUB_CREDENTIALS } from "../../execution/testing/githubCredentials.js";
import type { Provider } from "../provider.js";
import { ExecSandboxRestartedError, LocalExecutor, type Executor } from "../../execution/executor.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import type { RunEvent } from "../runEvents.js";
import { createRunsService } from "../runsService.js";
import {
  createLedgerWriteThrough,
  NullLedgerRun,
  NullLedgerWriteThrough,
  type LedgerRun,
} from "../runLedger/writeThrough.js";
import { PermanentStoreError, TransientStoreError } from "../runStoreWorker.js";
import type { PublicationSettlement } from "../publicationSettlement.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { planResume, transcriptSource } from "../runLedger/resume.js";
import { localWorkspaceDir, type ExecutorSelection } from "../../execution/factory.js";
import { reattachWorkspace } from "./provision.js";
import { bearerHashOf, RunBearerStore } from "../modelProxy/runBearers.js";
import { GitBindings, type GitPublicationClaim } from "../modelProxy/gitBindings.js";
import { RUN_BEARER_ENV } from "../harness/pi/process.js";
import {
  HarnessContainerReplacedError,
  HarnessGateBypassedError,
  HarnessMismatchError,
  RELAUNCH_CEILING,
  openThroughSeam,
  type Finding,
  type Harness,
  type HarnessFacts,
  type HarnessRecord,
  type HarnessRun,
  type HarnessSession,
} from "../harness/contract.js";
import type { HarnessRoster } from "../harness/roster.js";
import { FileRunStore, InMemoryRunStore, NullRunStore } from "../runStore.js";
import { createCardShell } from "../statusCardFrame.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO, IncomingMessage, StatusUpdate } from "../types.js";
import type { DispatchFollowUp } from "./admission.js";
import { buildMessages } from "./messages.js";
import { resolveRun } from "./resolve.js";
import type { HarnessProcessDeps, RunDeps } from "./run.js";
import { runLoop, type RunLoopOutcome, type RunOutcome } from "./runLoop.js";
import * as relaunchModule from "./relaunch.js";
import { bindSlackContext } from "./slackContextBinding.js";
import { deliverAnswer } from "./reply.js";
import { resumeMessage } from "../resumeLaunch.js";
import { windDownAnswer } from "../harness/windDown.js";
import { recoveredPrivateAudienceLatch, type PrivateAudienceLatch } from "./privateAudience.js";

/** The loop's answered outcome; an interruption fails the test naming its note. */
function answered(out: RunLoopOutcome): RunOutcome {
  if (out.kind !== "answered")
    throw new Error(`the loop did not answer: ${out.kind === "paused" ? out.message : out.note}`);
  return out;
}
import {
  HarnessRegistry,
  RelayedCalls,
  authorizeToolCall,
  relayToolCall,
  runRelayedTool,
  type LiveHarness,
  type RelayedToolAnswer,
  type ToolCallAsk,
} from "../harness/pi/relay.js";
import { spawnCapabilityFor, type SpawnCapability, type SpawnDeps } from "./spawn.js";
import type { SessionCapability } from "../../tools/session.js";
import {
  ModelPolicyRefusedError,
  ModelStreamIncompleteError,
  ModelTransientFailureError,
  PiContainerReplacedError,
  UNKNOWN_MODEL_TERMINAL_MESSAGE,
  settlementResults,
} from "../harness/pi/harness.js";
import { PiHarness } from "../harness/pi/piHarness.js";
import { OpenCodeHarness } from "../harness/opencode/harness.js";
import { HarnessInterruptedError } from "../harness/contract.js";
import { scriptOpenCodeServe } from "../harness/opencode/testing/driver.js";
import { judgeOpenCodeAsk } from "../harness/opencode/bridge.js";
import { openCodeReplacedCallNote } from "../harness/opencode/session.js";
import { FakeHarnessContainer } from "../harness/testing/fakeContainer.js";
import { scriptPiFromProvider } from "../harness/pi/testing/providerPi.js";
import { judgeToolCall, type ToolRuleContext } from "../harness/pi/toolRules.js";
import type { CoordinatorTag } from "../coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { PlaneService } from "../planeService.js";
import { InMemoryPrivateWorkerLog } from "../privateWorkerLog.js";
import { privateWorkerThreadKey } from "../../channels/privateWorker.js";
import type { RepoContext } from "../repoContext.js";
import type { BranchStartState } from "../../execution/identityRewrite.js";
import type { ResidentBinding } from "../../execution/resident.js";
import { InMemoryArtifactStore, type ArtifactStore } from "../../artifacts/store.js";
import type { ReviewCommentTarget } from "../../execution/githubComments.js";
import type { PrCommitList } from "../headMoved.js";
import type { PrDescription } from "../prDescription.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ResumeContext } from "./admission.js";
import type { AppendableEvent, LiveRunRow, StepRecord } from "../runLedger/types.js";
import type { RunRecord } from "../runRecord.js";
import { publicationReceiptsFromState, restoredPublicationHead } from "../publicationPush.js";
import { publishedHeadEvidence } from "../coordinator/publishedHeadAdoption.js";

// Feature: docs/reference/specs/harness-pi.md, docs/reference/specs/run-history.md
// items 20–22, docs/reference/specs/llm-output.md item 5 — the loop's own
// contract on the two ways it ends: a completed run whose answer is published
// and whose record is registered for the drain, and a failed run whose card is
// closed and whose workspace is released before the error propagates. The
// settle, the description turn and the PR post-step are proven through
// `dispatch()` in `src/core/dispatcher.test.ts` (`review post-step`, `coding
// PR post-step`).

/** Current coding fixtures have a real durable owner and explicit complete
 * producer projection. Legacy/untracked cases supply their own ledger. */
async function trackedCodingContext(
  s: { deps: RunDeps; ctx: RunLoopContext; store: InMemoryRunStore },
  ctx: RunLoopContext = s.ctx,
  ledgerThreadKey = ctx.msg.threadKey,
  captureLedger?: (ledger: InMemoryRunLedger) => void,
): Promise<RunLoopContext> {
  if ((!ctx.isCodingPrRun && ctx.agent.name !== "review") || ctx.ledgerRun !== undefined) return ctx;
  const state = {
    ...(ctx.resume?.row.state ?? {}),
    branchPublication: {
      version: 1,
      ...(ctx.repoCtx.repo !== undefined ? { repo: ctx.repoCtx.repo } : {}),
      branches: [],
      complete: true,
    },
  };
  if (ctx.resume) ctx.resume.row.state = state;
  const inner = new InMemoryRunLedger(() => NOW);
  captureLedger?.(inner);
  const finish = inner.finish.bind(inner);
  inner.finish = async (...args) => {
    const result = await finish(...args);
    const record = inner.finished.get(args[0]);
    if (result.ok && record) await s.store.put(record);
    return result;
  };
  const ledger = createLedgerWriteThrough({ ledger: inner, gen: "gen-T", fallback: s.store, warn: () => {} });
  s.deps.runLedger = ledger;
  const opened = await ledger.open({
    runId: ctx.run.id,
    threadKey: ledgerThreadKey,
    startedAt: NOW,
    meta: {
      agent: ctx.agent.name,
      channelId: ctx.msg.channelId,
      userId: ctx.msg.userId,
      threadKey: ctx.msg.threadKey,
      ...(ctx.repoCtx.repo ? { repo: ctx.repoCtx.repo } : {}),
      ...(ctx.repoCtx.pr !== undefined ? { pr: ctx.repoCtx.pr } : {}),
      ...(ctx.coordinator
        ? { parentInstanceId: ctx.coordinator.parentInstanceId, idempotencyKey: ctx.coordinator.idempotencyKey }
        : {}),
    },
    card: null,
    system: ctx.system,
    tools: [],
    state,
  });
  if (opened.kind !== "tracked") throw new Error("untracked coding fixture");
  s.ctx.ledgerRun = opened.run;
  return { ...ctx, ledgerRun: opened.run };
}

async function trackedReviewContext(
  s: { deps: RunDeps; ctx: RunLoopContext; store: InMemoryRunStore },
  ctx = s.ctx,
): Promise<RunLoopContext> {
  return ctx.agent.name === "review" ? trackedCodingContext(s, ctx) : ctx;
}

const NOW = 10_000;
const THREAD = "slack:CX:1.0";

/** Scripted calls known to be refused or allowed without a source read.
 * Fail the fixture if it starts exercising the asynchronous Door gate. */
function immediateToolVerdict(harness: LiveHarness, ask: ToolCallAsk) {
  const answer = authorizeToolCall(harness, ask);
  if (answer instanceof Promise) throw new Error("this scripted tool call needs an awaited publication gate");
  return answer;
}

const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
`;

function configStore(yaml = YAML): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-runloop-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  return new ConfigStore(path, join(dir, "overrides.json"));
}

/** The roster every test process drives runs with (harness.md item 8): pi with
 *  no deployment settings behind it, OpenCode beside it; the configuration word
 *  `harness.<preset>` picks, and a preset the block does not name runs on pi. */
const piHarness = new PiHarness();
const openCodeHarness = new OpenCodeHarness();
const roster = (pi: Harness = piHarness, opencode: Harness = openCodeHarness): HarnessRoster => ({ pi, opencode });

/** A harness of the roster with its three doors watched: `open` answers a
 *  scripted session without starting anything and records the resume facts it
 *  was handed, `find` answers what the test says, `end` records the facts it
 *  was asked to end. The object's declared tables are the real harness's. */
function watched(base: Harness, opts: { find?: Finding; answer?: string } = {}) {
  const calls: { open: Array<HarnessFacts | undefined>; find: HarnessFacts[]; end: HarnessFacts[] } = {
    open: [],
    find: [],
    end: [],
  };
  const harness: Harness = {
    name: base.name,
    history: base.history,
    dispositions: base.dispositions,
    effort: (tier) => base.effort(tier),
    builtinTools: (identity) => base.builtinTools(identity),
    open: async (_deps, run) => {
      calls.open.push(run.resume?.facts);
      return {
        answer: opts.answer ?? "Done.",
        followUp: async () => "",
        remainingMs: () => 20 * 60_000,
        end: async () => {},
      };
    },
    find: async (facts) => {
      calls.find.push(facts);
      return opts.find ?? "alive-here";
    },
    end: async (facts) => {
      calls.end.push(facts);
    },
  };
  return { harness, calls };
}

function provider(answer: string | Error): Provider {
  return {
    name: "fake",
    async complete() {
      if (answer instanceof Error) throw answer;
      return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
    },
  };
}

const msg = (text: string, userId = "slack:UX", channelId = "slack:CX", threadKey = THREAD): IncomingMessage => ({
  channelId,
  userId,
  threadKey,
  text,
});

/** Everything the loop is handed for one general-agent run, with a recording
 *  channel, card and registry, and a real writer over an in-memory store.
 *  `opts.agent` runs another preset with `opts.provider` scripting its turns,
 *  `opts.io` adds channel methods, `opts.executor` is the round's workspace. */
function setup(
  answer: string | Error,
  opts: {
    agent?: string;
    /** The request's verbosity directive (item 28); unset → the default, quiet. */
    verbosity?: Verbosity;
    provider?: Provider;
    io?: Partial<ChannelIO> & {
      verifyDirectAudience?: (audience: {
        kind: "slack-unshared-im";
        channelId: string;
        userId: string;
        threadKey: string;
      }) => Promise<AudienceCheck>;
    };
    directAudience?: { kind: "slack-unshared-im"; channelId: string; userId: string; threadKey: string };
    executor?: Partial<Executor>;
    /** The config to run under; the default names no harness block. */
    yaml?: string;
    /** The pi harness's process deps, when the test scripts pi itself; absent,
     *  a fake container whose pi is scripted from the run's provider; `null`,
     *  a process without them. */
    harness?: HarnessProcessDeps | null;
    /** The run's model-proxy bearer, as the dispatcher would hand it over;
     *  `null`, a run handed none. */
    bearer?: string | null;
    /** The thread's resolved repository context; nothing resolved by default. */
    repoCtx?: RepoContext;
    /** The coordinator's tag, when a coordinator spawned the run. */
    coordinator?: CoordinatorTag;
    /** The resident binding the round attached at, when the round ran on a resident. */
    binding?: ResidentBinding;
    /** The seeded sandbox's checked-out ref and head, when resident attach falls back. */
    seeded?: ExecutorSelection["seeded"];
    /** The verified cold clone when attach and seed were unavailable. */
    cold?: ExecutorSelection["cold"];
    /** The artifact store (record 0033), when the deployment configures one. */
    artifacts?: ArtifactStore;
    /** A pull-request review round: the head the dispatcher pinned and the seams the settle and the post-step call.
     *  `currentHead` is what GitHub answers for the PR's head during the run (the pinned head unless a test moves
     *  it); `commits` answers the compare lists the settle classifies a move by (unclassifiable unless given). */
    review?: {
      head: string;
      post: (target: ReviewCommentTarget, body: string) => Promise<GithubWriteResult | void>;
      currentHead?: string;
      commits?: (sha: string) => PrCommitList | undefined;
    };
    /** A writable coding run against a repository: the post-step observes the workspace and opens-or-edits the PR. */
    coding?: boolean;
    /** The run's spawn capability, as the dispatcher hands it to a conductor. */
    spawn?: SpawnCapability;
    /** The run's reach into its session log, as the dispatcher hands it to a run with a session. */
    session?: SessionCapability;
    /** Who asked; `slack:UX` unless a test needs a second person's scope. */
    userId?: string;
    channelId?: string;
    threadKey?: string;
    /** The registry's per-run backlog bound in events or bytes, when a test needs early events evicted. */
    backlogLimit?: number;
    backlogBytes?: number;
  } = {},
) {
  const config = configStore(opts.yaml);
  const agentName = opts.agent ?? "general";
  const store = new InMemoryRunStore();
  const writer = createRunHistoryWriter({ store, warn: () => {}, sleep: async () => {} });
  const runProvider = opts.provider ?? provider(answer);
  const harness: HarnessProcessDeps | null =
    opts.harness !== undefined
      ? opts.harness
      : {
          harnesses: roster(),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          loopbackUrl: "http://127.0.0.1:8080",
          containerFor: () => {
            const container = new FakeHarnessContainer();
            scriptPiFromProvider(container, {
              provider: runProvider,
              registry: harness!.registry,
              beforeModelCall: () => new Promise((r) => setTimeout(r, 10)),
            });
            return container;
          },
          pollMs: 1,
          tickMs: 5,
        };
  const deps: RunDeps = {
    config,
    runLedger: new NullLedgerWriteThrough("gen-T", new NullRunStore()),
    runHistoryWriter: writer,
    runStore: new NullRunStore(),
    githubApi: new InMemoryGithubApi(),
    githubCredentials: TEST_GITHUB_CREDENTIALS,
    ...(harness ? { harness } : {}),
    ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    ...(opts.review
      ? {
          postReviewComment: opts.review.post,
          fetchPrHead: async () => opts.review!.currentHead ?? opts.review!.head,
          fetchPrFacts: async () => ({
            state: "open" as const,
            sameRepoHead: true,
            headSha: opts.review!.currentHead ?? opts.review!.head,
            headBranchExists: true,
          }),
          fetchPrCommits: async ({ sha }: { sha: string }) => opts.review!.commits?.(sha),
        }
      : {}),
  };
  const message = {
    ...msg("hello there", opts.userId, opts.channelId, opts.threadKey),
    ...(opts.directAudience ? { directAudience: opts.directAudience } : {}),
  };
  const { resolved } = resolveRun(
    { config },
    {
      msg: message,
      directives: {
        text: "hello there",
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.verbosity ? { verbosity: opts.verbosity } : {}),
      },
      history: [],
    },
  );
  const agent = getAgent(resolved.agentName);
  const registry = new RunRegistry({
    genId: () => "run-l",
    genToken: () => "tok",
    ...(opts.backlogLimit !== undefined ? { backlogLimit: opts.backlogLimit } : {}),
    ...(opts.backlogBytes !== undefined ? { backlogBytes: opts.backlogBytes } : {}),
  });
  const run = registry.create(`${agentName} · #CX · UX`, {
    agent: agentName,
    model: resolved.modelRef,
    channelId: message.channelId,
    userId: message.userId,
    threadKey: message.threadKey,
    receivedAt: NOW,
  });
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
    ...(opts.directAudience ? { directAudience: () => opts.directAudience } : {}),
    ...opts.io,
  };
  const frames: StatusUpdate[] = [];
  const closes: StatusUpdate[] = [];
  const shell = createCardShell({ label: "*general* on `anthropic/general-model`", startedAt: NOW, now: () => NOW });
  const releases: string[] = [];
  const published: string[] = [];
  const ending = createRunEnding({ registry });
  const ctx = {
    msg: message,
    io,
    agent,
    profile: declaredProfile(agent),
    resolved,
    messages: buildMessages([], "hello there"),
    system: "the system prompt",
    mcpForRun: { tools: [], servers: [] },
    run,
    registry,
    round: {
      selection: {
        executor: (opts.executor ?? {}) as never,
        backend: "local" as const,
        ...(opts.binding ? { binding: opts.binding } : {}),
        ...(opts.seeded ? { seeded: opts.seeded } : {}),
        ...(opts.cold ? { cold: opts.cold } : {}),
      },
      release: async (opts: { hardStopped: boolean; commandInFlight?: boolean; gateBypassed?: boolean }) =>
        void releases.push(
          opts.hardStopped
            ? "hard"
            : opts.commandInFlight === true || opts.gateBypassed === true
              ? "torn-down"
              : "paired",
        ),
    },
    admitted: new ThreadAdmission<DispatchFollowUp>().claim(message.threadKey, { agent: agentName }).live,
    ledgerRun: undefined,
    resume: undefined,
    repoCtx: opts.repoCtx ?? {},
    ...(opts.bearer === null
      ? {}
      : { githubDoor: { baseUrl: "https://git.bot.test", bearer: opts.bearer ?? "sbr_run-l.s3cret" } }),
    isPrReview: opts.review !== undefined,
    isCodingPrRun: opts.coding ?? false,
    reviewHead: opts.review?.head,
    requestText: "",
    card: { update: (f: StatusUpdate) => void frames.push(f), done: async (f: StatusUpdate) => void closes.push(f) },
    shell,
    doneLines: () => ({}),
    clock: () => NOW,
    root: trace.root,
    startedAt: NOW,
    loopStartedAt: NOW,
    assertAdmissionBudget: () => {},
    channelVisibility: visibilityOf(message.channelId),
    addressSeverity: { level: "minor" as const, source: "org" as const },
    publishText: (type: "input" | "context" | "answer", text: string) => {
      published.push(`${type}:${text}`);
      registry.publish(run.id, type === "input" ? { type, messageId: "m1", text, at: NOW } : { type, text, at: NOW });
    },
    ending,
    ...(opts.bearer === null ? {} : { bearer: opts.bearer ?? "sbr_run-l.s3cret" }),
    ...(opts.coordinator ? { coordinator: opts.coordinator } : {}),
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.session ? { session: opts.session } : {}),
  };
  return { deps, ctx, registry, run, store, writer, replies, frames, closes, releases, published, ending };
}

describe("runLoop — the model turn and everything that rides on it", () => {
  it.each(["landed", "retried", "newer owner", "failed", "hard stop", "late hard stop"] as const)(
    "ordinary review release waits for its exact terminal ledger write (%s)",
    async (mode) => {
      const s = setup("The review is complete.", { agent: "review" });
      const inner = new InMemoryRunLedger();
      const finish = inner.finish.bind(inner);
      let unblock!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => (unblock = resolve));
      const entered = new Promise<void>((resolve) => (started = resolve));
      let attempts = 0;
      vi.spyOn(inner, "finish").mockImplementation(async (...args) => {
        started();
        await blocked;
        attempts++;
        if (mode === "failed") throw new PermanentStoreError("finish rejected");
        if (mode === "retried" && attempts === 1) throw new TransientStoreError("try again");
        return finish(...args);
      });
      const ledger = createLedgerWriteThrough({ ledger: inner, gen: "review", fallback: s.store, warn: () => {} });
      s.deps.runLedger = ledger;
      const opened = await ledger.open({
        runId: s.run.id,
        threadKey: s.ctx.msg.threadKey,
        startedAt: NOW,
        meta: {
          agent: "review",
          userId: s.ctx.msg.userId,
          channelId: s.ctx.msg.channelId,
          threadKey: s.ctx.msg.threadKey,
        },
        card: null,
        system: s.ctx.system,
        tools: [],
      });
      if (opened.kind !== "tracked") throw new Error("untracked fixture");
      const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run }));
      if (mode === "hard stop") s.run.control.requestStop("hard");
      const delivery = deliverAnswer({
        msg: s.ctx.msg,
        io: s.ctx.io,
        agent: s.ctx.agent,
        run: s.run,
        answer: out.answer,
        liveUrl: undefined,
        prNote: out.prNote,
        stopped: undefined,
        ledgerRun: opened.run,
        ending: s.ending,
        card: s.ctx.card,
        shell: s.ctx.shell,
        checklistAsLeft: out.checklistAsLeft,
        hasIncompleteToolEffects: out.hasIncompleteToolEffects,
        answerOutcome: out.answerOutcome,
        doneLines: s.ctx.doneLines,
        runDiagnosis: out.runDiagnosis,
        releaseWorkspace: out.releaseWorkspace,
        root: s.ctx.root,
      });
      try {
        await entered;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(s.replies).toHaveLength(1);
        expect(inner.live.has(s.run.id)).toBe(true);
        expect(s.releases).toEqual(mode === "hard stop" ? ["hard"] : []);
        if (mode === "newer owner") inner.live.get(s.run.id)!.ownerGen = "successor";
        if (mode === "late hard stop") {
          s.run.control.requestStop("hard");
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(inner.live.has(s.run.id)).toBe(true);
          expect(s.releases).toEqual(["hard"]);
        }
      } finally {
        unblock();
        await delivery;
        await s.writer.settled();
      }
      if (mode === "newer owner" || mode === "failed") {
        expect(inner.live.has(s.run.id)).toBe(true);
        if (mode === "newer owner") expect(inner.live.get(s.run.id)!.ownerGen).toBe("successor");
        expect(await s.store.get(s.run.id)).toMatchObject({ id: s.run.id, status: "completed" });
        expect(s.releases).toEqual([]);
      } else {
        expect(inner.live.has(s.run.id)).toBe(false);
        expect(s.releases).toEqual(mode === "hard stop" || mode === "late hard stop" ? ["hard"] : ["paired"]);
      }
    },
  );

  it.each(["general", "research"] as const)(
    "an all-checked source lookup without a write-up retains its work and records the missing answer (%s)",
    async (agent) => {
      const observed = watched(piHarness);
      observed.harness.open = async (_deps, run) => {
        run.toolContext.reportProgress?.("✓ Read request\n✓ Read source\n✓ Report findings");
        run.onEvent?.({ type: "run_note", kind: "resumed", summary: "resumed on the same run after a bot restart" });
        run.onEvent?.({ type: "tool_call", tool: "mcp_source_read", summary: "read source", callId: "source-1" });
        run.onEvent?.({
          type: "tool_result",
          tool: "mcp_source_read",
          ok: false,
          cut: true,
          summary: "source call cut",
          callId: "source-1",
        });
        run.onEvent?.({
          type: "run_note",
          kind: "time_budget_exhausted",
          summary: "the source read was cut at the loop end",
        });
        const ending = { kind: "time" as const, text: "" };
        return {
          answer: windDownAnswer(ending, run.agent.maxMinutes),
          ending,
          followUp: async () => "",
          remainingMs: () => 0,
          end: async () => {},
        };
      };
      const s = setup("unused", {
        agent,
        harness: {
          harnesses: roster(observed.harness),
          registry: new HarnessRegistry(),
          loopbackUrl: "http://127.0.0.1:8080",
        },
      });
      const out = answered(await runLoop(s.deps, { ...s.ctx, profile: { ...s.ctx.profile, minutes: 5 } }));
      expect(out.answer).toContain("could not verify");
      expect(out.answer).toContain("continue");
      expect(out.answer).not.toContain("Partial work may exist");
      await deliverAnswer({
        msg: s.ctx.msg,
        io: s.ctx.io,
        agent: s.ctx.agent,
        run: s.run,
        answer: out.answer,
        liveUrl: undefined,
        prNote: out.prNote,
        stopped: undefined,
        ledgerRun: undefined,
        ending: s.ending,
        card: s.ctx.card,
        shell: s.ctx.shell,
        checklistAsLeft: out.checklistAsLeft,
        hasIncompleteToolEffects: out.hasIncompleteToolEffects,
        answerOutcome: out.answerOutcome,
        doneLines: s.ctx.doneLines,
        runDiagnosis: out.runDiagnosis,
        releaseWorkspace: out.releaseWorkspace,
        root: s.ctx.root,
      });
      expect(s.replies.at(-1)).toBe(out.answer);
      expect(s.closes.at(-1)?.title).toContain("⚠");
      expect(s.closes.at(-1)?.detail).toBe("Answer not written.\n\n✓ Read request\n✓ Read source\n✓ Report findings");
      expect(out.answerOutcome).toEqual({ version: 1, ending: "time_budget", output: "absent" });
      s.ending.drain(true);
      await s.writer.settled();
      const rec = (await s.store.get("run-l"))!;
      expect(rec.answerOutcome).toEqual({ version: 1, ending: "time_budget", output: "absent" });
      expect(rec.replyOk).toBe(true);
      expect(rec.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "run_note", kind: "resumed" }),
          expect.objectContaining({ type: "tool_result", callId: "source-1", cut: true }),
          expect.objectContaining({ type: "answer", text: out.answer }),
        ]),
      );
    },
  );
  it("an all-checked budget lookup keeps a partial write-up without claiming a complete answer", async () => {
    const observed = watched(piHarness);
    observed.harness.open = async (_deps, run) => {
      run.toolContext.reportProgress?.("✓ Read sources");
      const ending = { kind: "time" as const, text: "One record verified; remaining causes are unknown." };
      return {
        answer: windDownAnswer(ending, run.agent.maxMinutes),
        ending,
        followUp: async () => "",
        remainingMs: () => 0,
        end: async () => {},
      };
    };
    const s = setup("unused", {
      harness: {
        harnesses: roster(observed.harness),
        registry: new HarnessRegistry(),
        loopbackUrl: "http://127.0.0.1:8080",
      },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    await deliverAnswer({ ...s.ctx, ...out, liveUrl: undefined, stopped: undefined });
    expect(out.answerOutcome).toEqual({ version: 1, ending: "time_budget", output: "present" });
    expect(out.answer).toContain("before finishing");
    expect(s.replies.at(-1)).toContain("remaining causes are unknown");
    expect(s.closes.at(-1)?.title).toContain("⚠");
    expect(s.closes.at(-1)?.detail).toBe("✓ Read sources");
  });

  it("a restarted source read cut at the budget answers without invented findings and leaves the unfinished checklist open", async () => {
    const observed = watched(piHarness);
    observed.harness.open = async (_deps, run) => {
      run.toolContext.reportProgress?.("✓ Read request\n✱ Read source\n○ Deliver count and records");
      run.onEvent?.({ type: "run_note", kind: "resumed", summary: "resumed on the same run after a bot restart" });
      run.onEvent?.({ type: "tool_call", tool: "mcp_source_read", summary: "read source", callId: "source-1" });
      run.onEvent?.({
        type: "tool_result",
        tool: "mcp_source_read",
        ok: false,
        cut: true,
        summary: "source call cut",
        callId: "source-1",
      });
      run.onEvent?.({
        type: "run_note",
        kind: "time_budget_exhausted",
        summary: "the source read was cut at the loop end",
      });
      const ending = { kind: "time" as const, text: "" };
      return {
        answer: windDownAnswer(ending, run.agent.maxMinutes),
        ending,
        followUp: async () => "",
        remainingMs: () => 0,
        end: async () => {},
      };
    };
    const s = setup("unused", {
      harness: {
        harnesses: roster(observed.harness),
        registry: new HarnessRegistry(),
        loopbackUrl: "http://127.0.0.1:8080",
      },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, profile: { ...s.ctx.profile, minutes: 5 } }));
    expect(out.answer).toContain("could not verify");
    expect(out.answer).toContain("continue");
    expect(out.answer).not.toContain("Partial work may exist");
    await deliverAnswer({
      msg: s.ctx.msg,
      io: s.ctx.io,
      agent: s.ctx.agent,
      run: s.run,
      answer: out.answer,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      answerOutcome: out.answerOutcome,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(s.replies.at(-1)).toBe(out.answer);
    expect(s.closes.at(-1)?.title).toContain("⚠");
    expect(s.closes.at(-1)?.detail).toBe(
      "Answer not written.\n\n✓ Read request\n✱ Read source\n○ Deliver count and records",
    );
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_note", kind: "resumed" }),
        expect.objectContaining({ type: "tool_result", callId: "source-1", cut: true }),
        expect.objectContaining({ type: "answer", text: out.answer }),
      ]),
    );
  });
  it("keeps a web main agent's tool result in the durable event stream", async () => {
    const harness = watched(piHarness);
    harness.harness.open = async (_deps, run) => {
      run.onEvent?.({
        type: "tool_result",
        tool: "lookup",
        ok: true,
        summary: "web result: 23",
        output: "web result: 23",
      });
      return { answer: "web result: 23", followUp: async () => "", remainingMs: () => 60_000, end: async () => {} };
    };
    const s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const sourceEvents: RunEvent[] = [];
    const ledgerRun = new NullLedgerRun("run-l", { put: (record) => s.store.put(record), abandoned: () => {} });
    ledgerRun.tracked = () => true;
    ledgerRun.assignLiveState = async (assignment) => {
      sourceEvents.push(...(assignment.sourceEvents ?? []));
      return { ok: false, reason: "stale-sequence" };
    };
    s.registry.commitLiveState("run-l", {
      ok: true,
      liveState: { state: "working", since: NOW, bound: NOW + 60_000, detail: "model turn" },
      liveStateSeq: 0,
    });
    const msg: IncomingMessage = {
      channelId: "web:chat-1",
      userId: "web:alice",
      threadKey: "web:chat-1:1",
      text: "question",
    };
    const out = answered(await runLoop(s.deps, { ...s.ctx, msg, ledgerRun, channelVisibility: "machine" }));
    expect(out.answer).toBe("web result: 23");
    expect(JSON.stringify(sourceEvents)).toContain("web result: 23");
  });

  it("revokes Slack context permanently when a relayed follow-up enters the live run", async () => {
    const directAudience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:UALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const msg: IncomingMessage = { ...directAudience, text: "What happened?", directAudience };
    const sourceRead = vi.fn(async () => "private source");
    const io: ChannelIO = {
      directAudience: () => directAudience,
      verifyDirectAudience: booleanAudienceVerifier(async () => true),
    } as unknown as ChannelIO;
    const binding = await bindSlackContext({
      agentName: "orchestrator",
      actor: { kind: "user", id: msg.userId, grants: { actions: new Set(), channels: new Set(), repos: new Set() } },
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, sourceRead),
    });
    expect(binding).toBeDefined();
    let result: unknown;
    let s!: ReturnType<typeof setup>;
    const harness = watched(piHarness);
    harness.harness.open = async (_deps, run) => {
      s.ctx.admitted.inbox.push({
        text: "read this for me",
        userId: msg.userId,
        at: NOW + 1,
        msg: { ...msg, text: "read this for me", relayedBy: "slack:bot:BOTHER" },
      });
      result = await run.toolContext.slackContext?.read({ kind: "thread" });
      return { answer: "done", followUp: async () => "", remainingMs: () => 20 * 60_000, end: async () => {} };
    };
    s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    answered(
      await runLoop(s.deps, {
        ...s.ctx,
        msg,
        io: { ...s.ctx.io, ...io },
        channelVisibility: "dm",
        slackContext: binding,
      }),
    );
    expect(result).toContain("no longer available");
    expect(sourceRead).not.toHaveBeenCalled();
    expect(await binding!.capability.read({ kind: "thread" })).toContain("no longer available");
  });

  it("keeps source revocation armed after the model turn until answer delivery", async () => {
    const directAudience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:UALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const msg: IncomingMessage = { ...directAudience, text: "What happened?", directAudience };
    const io = {
      directAudience: () => directAudience,
      verifyDirectAudience: booleanAudienceVerifier(async () => true),
    } as unknown as ChannelIO;
    const binding = await bindSlackContext({
      agentName: "orchestrator",
      actor: { kind: "user", id: msg.userId, grants: { actions: new Set(), channels: new Set(), repos: new Set() } },
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, async () => "private source"),
    });
    const s = setup("private source", { agent: "orchestrator" });
    answered(
      await runLoop(s.deps, {
        ...s.ctx,
        msg,
        io: { ...s.ctx.io, ...io },
        channelVisibility: "dm",
        slackContext: binding,
      }),
    );
    expect(await binding?.destinationStillPrivate()).toBe(true);
    s.ctx.admitted.inbox.push({
      text: "another source",
      userId: msg.userId,
      at: NOW + 1,
      msg: { ...msg, text: "another source", relayedBy: "slack:bot:BOTHER" },
    });
    expect(await binding?.destinationStillPrivate()).toBe(false);
  });

  it("offers the bound Slack read only to the main DM run and suppresses an answer after its audience changes", async () => {
    let privateDestination = true;
    const read = vi.fn(async () => "private fact");
    const opened: string[][] = [];
    const harness = watched(piHarness);
    harness.harness.open = async (_deps, run) => {
      opened.push(run.tools.map((tool) => tool.name));
      expect(run.toolContext.slackContext?.read).toBeDefined();
      expect(await run.toolContext.slackContext!.read({ kind: "thread" })).toBe("private fact");
      run.toolContext.reportProgress?.("✓ private fact from update_status");
      privateDestination = false;
      return { answer: "private fact", followUp: async () => "", remainingMs: () => 20 * 60_000, end: async () => {} };
    };
    const s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const out = answered(
      await runLoop(s.deps, {
        ...s.ctx,
        channelVisibility: "dm",
        slackContext: {
          initialize: async () => true,
          revalidate: async () => true,
          sourcesStillValid: async () => ({ ok: true }),
          capability: { read },
          destinationStillPrivate: async () => privateDestination,
          revoke: () => {},
        },
      }),
    );
    expect(opened[0]).toContain("slack_context");
    expect(read).toHaveBeenCalledOnce();
    expect(out.answer).not.toContain("private fact");
    expect(s.published.at(-1)).not.toContain("private fact");
    expect(JSON.stringify(s.frames)).not.toContain("private fact");
    expect(JSON.stringify(s.closes)).not.toContain("private fact");
  });

  it("keeps a resumed private Slack result out of cards, answer and reply after its DM becomes shared", async () => {
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:WALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const row: LiveRunRow = {
      runId: "run-l",
      threadKey: audience.threadKey,
      ownerGen: "old",
      leaseUntil: 0,
      startedAt: NOW,
      phase: "live",
      stop: null,
      meta: {
        channelId: audience.channelId,
        userId: audience.userId,
        threadKey: audience.threadKey,
        agent: "orchestrator",
        directAudience: audience,
      },
      card: null,
      system: "private context",
      tools: [],
      state: {},
    };
    const resumed = resumeMessage(row, "What happened?");
    const harness = watched(piHarness);
    harness.harness.open = async (_deps, run) => {
      run.toolContext.reportProgress?.("✓ private result from update_status");
      return {
        answer: "private result",
        followUp: async () => "",
        remainingMs: () => 20 * 60_000,
        end: async () => {},
      };
    };
    const s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const io: ChannelIO = {
      ...s.ctx.io,
      directAudience: () => audience,
      verifyDirectAudience: booleanAudienceVerifier(async () => false),
    };
    const out = answered(
      await runLoop(s.deps, {
        ...s.ctx,
        msg: resumed,
        io,
        channelVisibility: "dm",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "old-read", name: "slack_context", input: { kind: "thread" } }],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "old-read", content: "private result" }] },
        ],
      }),
    );
    expect(out.answer).not.toContain("private result");
    expect(s.published.at(-1)).not.toContain("private result");
    expect(JSON.stringify(s.frames)).not.toContain("private result");
    await deliverAnswer({
      msg: resumed,
      io,
      agent: s.ctx.agent,
      run: s.run,
      answer: out.answer,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(s.replies.at(-1)).not.toContain("private result");
    expect(JSON.stringify(s.closes)).not.toContain("private result");
  });

  it("seals a resumed private result after a relayed follow-up even while the DM stays private", async () => {
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:WALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const row: LiveRunRow = {
      runId: "run-l",
      threadKey: audience.threadKey,
      ownerGen: "old",
      leaseUntil: 0,
      startedAt: NOW,
      phase: "live",
      stop: null,
      meta: { ...audience, agent: "orchestrator", directAudience: audience },
      card: null,
      system: "private context",
      tools: [],
      state: {},
    };
    const resumed = resumeMessage(row, "What happened?");
    const harness = watched(piHarness);
    let s!: ReturnType<typeof setup>;
    harness.harness.open = async (_deps, run) => {
      s.ctx.admitted.inbox.push({
        text: "another source",
        userId: resumed.userId,
        at: NOW + 1,
        msg: { ...resumed, text: "another source", relayedBy: "slack:bot:BOTHER" },
      });
      run.toolContext.reportProgress?.("✓ private result from update_status");
      return {
        answer: "private result",
        followUp: async () => "",
        remainingMs: () => 20 * 60_000,
        end: async () => {},
      };
    };
    s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const io: ChannelIO = {
      ...s.ctx.io,
      directAudience: () => audience,
      verifyDirectAudience: booleanAudienceVerifier(async () => true),
    };
    const privateAudienceLatch = { revoked: false };
    const out = answered(
      await runLoop(s.deps, {
        ...s.ctx,
        msg: resumed,
        io,
        privateAudienceLatch,
        channelVisibility: "dm",
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "old-read", name: "slack_context", input: {} }] },
          { role: "user", content: [{ type: "tool_result", toolUseId: "old-read", content: "private result" }] },
        ],
      }),
    );
    expect(out.answer).not.toContain("private result");
    expect(JSON.stringify(s.published)).not.toContain("private result");
    expect(JSON.stringify(s.frames)).not.toContain("private result");
    expect(privateAudienceLatch.revoked).toBe(true);
    await deliverAnswer({
      msg: resumed,
      io,
      agent: s.ctx.agent,
      run: s.run,
      answer: "private result",
      privateAudienceLatch,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(JSON.stringify({ replies: s.replies, closes: s.closes })).not.toContain("private result");
  });

  it("seals a resumed private answer when an unverified follow-up is refused during audience verification", async () => {
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:WALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const row: LiveRunRow = {
      runId: "run-l",
      threadKey: audience.threadKey,
      ownerGen: "old",
      leaseUntil: 0,
      startedAt: NOW,
      phase: "live",
      stop: null,
      meta: { ...audience, agent: "orchestrator", directAudience: audience },
      card: null,
      system: "private context",
      tools: [],
      state: {},
    };
    const resumed = resumeMessage(row, "What happened?");
    const harness = watched(piHarness);
    harness.harness.open = async () => ({
      answer: "private result",
      followUp: async () => "",
      remainingMs: () => 20 * 60_000,
      end: async () => {},
    });
    const s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    let verifierStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verifierStarted = resolve;
    });
    let finishVerification!: (value: boolean) => void;
    const verifying = new Promise<boolean>((resolve) => {
      finishVerification = resolve;
    });
    const io: ChannelIO = {
      ...s.ctx.io,
      directAudience: () => audience,
      verifyDirectAudience: booleanAudienceVerifier(() => {
        verifierStarted();
        return verifying;
      }),
    };
    const privateAudienceLatch = { revoked: false };
    const running = runLoop(s.deps, {
      ...s.ctx,
      msg: resumed,
      io,
      privateAudienceLatch,
      channelVisibility: "dm",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "old-read", name: "slack_context", input: {} }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "old-read", content: "private result" }] },
      ],
    });
    await started;
    s.ctx.admitted.inbox.markUntrustedFollowUp();
    expect(s.ctx.admitted.inbox.drain()).toEqual([]);
    finishVerification(true);
    const out = answered(await running);
    expect(privateAudienceLatch.revoked).toBe(true);
    expect(out.answer).not.toContain("private result");
    expect(JSON.stringify({ published: s.published, frames: s.frames, closes: s.closes })).not.toContain(
      "private result",
    );
  });

  it.each(["checkpoint", "parent lookup", "report append"] as const)(
    "withholds the next report and answer event after a late untrusted follow-up (%s)",
    async (blockedAt) => {
      const audience = {
        kind: "slack-unshared-im" as const,
        channelId: "slack:DMAIN",
        userId: "slack:WALICE",
        threadKey: "slack:DMAIN:1.0",
      };
      const secret = "late private result";
      const harness = watched(piHarness, { answer: secret });
      const s = setup("unused", {
        agent: "general",
        ...audience,
        directAudience: audience,
        io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
        harness: {
          harnesses: roster(harness.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          loopbackUrl: "http://127.0.0.1:8080",
          containerFor: () => new FakeHarnessContainer(),
        },
      });
      const inner = new InMemoryRunLedger(() => NOW);
      const ledger = createLedgerWriteThrough({ ledger: inner, gen: "gen-T", fallback: s.store, warn: () => {} });
      s.deps.runLedger = ledger;
      const opened = await ledger.open({
        runId: s.run.id,
        threadKey: audience.threadKey,
        startedAt: NOW,
        meta: { agent: "general", ...audience, directAudience: audience },
        card: null,
        system: "test",
        tools: [],
        seed: {
          messages: s.ctx.messages,
          budgetMs: 60_000,
          context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
        },
      });
      if (opened.kind !== "tracked") throw new Error("untracked test");
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let resume!: () => void;
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const block = async () => {
        entered();
        await held;
      };
      if (blockedAt === "checkpoint") {
        const original = opened.run.checkpointSession.bind(opened.run);
        opened.run.checkpointSession = async () => {
          await block();
          return original();
        };
      } else if (blockedAt === "parent lookup") {
        s.deps.runStore.getSummary = async () => {
          await block();
          return {
            id: "parent",
            userId: audience.userId,
            channelId: audience.channelId,
            threadKey: "slack:DMAIN:parent",
          } as RunRecord;
        };
      } else {
        const original = ledger.appendSession.bind(ledger);
        ledger.appendSession = async (...args) => {
          const result = await original(...args);
          await block();
          return result;
        };
      }
      const privateAudienceLatch = { revoked: false };
      try {
        const running = runLoop(s.deps, {
          ...s.ctx,
          ledgerRun: opened.run,
          privateAudienceLatch,
          channelVisibility: "dm",
          ...(blockedAt !== "checkpoint" ? { parentRunId: "parent" } : {}),
        });
        await started;
        s.ctx.admitted.inbox.markUntrustedFollowUp();
        resume();
        const out = answered(await running);
        expect(privateAudienceLatch.revoked).toBe(true);
        expect(out.answer).not.toContain(secret);
        expect(JSON.stringify(s.published)).not.toContain(secret);
        const { contextThreadSessionKey } = await import("../runLedger/sessionLog.js");
        const parent = await ledger.readSession(contextThreadSessionKey("slack:DMAIN:parent"), 0);
        expect(JSON.stringify(parent.messages)).not.toContain(secret);
        if (blockedAt === "checkpoint") {
          const own = await ledger.readSession(contextThreadSessionKey(audience.threadKey), 0);
          expect(JSON.stringify(own.messages)).not.toContain(secret);
        }
      } finally {
        await opened.run.close();
        s.ending.drain(undefined);
        await s.writer.settled();
      }
    },
  );

  it("seals a recovered private result when a prior indirect follow-up was already consumed", async () => {
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:WALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const row: LiveRunRow = {
      runId: "run-l",
      threadKey: audience.threadKey,
      ownerGen: "old",
      leaseUntil: 0,
      startedAt: NOW,
      phase: "live",
      stop: null,
      meta: { ...audience, agent: "orchestrator", directAudience: audience },
      card: null,
      system: "private context",
      tools: [],
      state: {},
    };
    const resumed = resumeMessage(row, "What happened?");
    const harness = watched(piHarness);
    harness.harness.open = async () => ({
      answer: "private result from consumed follow-up",
      followUp: async () => "",
      remainingMs: () => 20 * 60_000,
      end: async () => {},
    });
    const s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const io: ChannelIO = {
      ...s.ctx.io,
      directAudience: () => audience,
      verifyDirectAudience: booleanAudienceVerifier(async () => true),
    };
    const privateAudienceLatch = recoveredPrivateAudienceLatch(resumed, true);
    const out = answered(
      await runLoop(s.deps, {
        ...s.ctx,
        msg: resumed,
        io,
        privateAudienceLatch,
        channelVisibility: "dm",
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "old-read", name: "slack_context", input: {} }] },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "old-read", content: "private result from consumed follow-up" },
            ],
          },
        ],
      }),
    );
    expect(privateAudienceLatch.revoked).toBe(true);
    expect(out.answer).not.toContain("private result");
    expect(out.answer).toContain("run restarted");
    expect(out.answer).not.toContain("verify this private conversation");
    expect(JSON.stringify({ published: s.published, frames: s.frames, closes: s.closes })).not.toContain(
      "private result",
    );
    await deliverAnswer({
      msg: resumed,
      io,
      agent: s.ctx.agent,
      run: s.run,
      answer: "private result from consumed follow-up",
      privateAudienceLatch,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(JSON.stringify({ replies: s.replies, closes: s.closes })).not.toContain("private result");
    expect(s.replies.at(-1)).toContain("run restarted");
  });

  it("keeps a live Slack context result out of durable source events and the finished run record", async () => {
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DMAIN",
      userId: "slack:WALICE",
      threadKey: "slack:DMAIN:1.0",
    };
    const msg: IncomingMessage = { ...audience, text: "How many signups failed?", directAudience: audience };
    const harness = watched(piHarness);
    harness.harness.open = async (_deps, run) => {
      run.onEvent?.({
        type: "tool_call",
        tool: "slack_context",
        summary: "read private signup count",
        callId: "private-read",
      });
      run.onEvent?.({
        type: "tool_result",
        tool: "slack_context",
        ok: true,
        summary: "private signup count: 17",
        output: "private signup count: 17",
        callId: "private-read",
      });
      return {
        answer: "private signup count: 17",
        followUp: async () => "",
        remainingMs: () => 20 * 60_000,
        end: async () => {},
      };
    };
    const s = setup("unused", {
      agent: "orchestrator",
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    // The setup default is a channel run; this case binds the run to the verified DM.
    s.registry.create(
      "main · private conversation",
      { ...audience, agent: "orchestrator", directAudience: audience },
      {
        id: s.run.id,
        token: s.run.token,
      },
    );
    const io: ChannelIO = {
      ...s.ctx.io,
      directAudience: () => audience,
      verifyDirectAudience: booleanAudienceVerifier(async () => true),
    };
    const sourceEvents: RunEvent[] = [];
    const ledgerRun = new NullLedgerRun("run-l", { put: (record) => s.store.put(record), abandoned: () => {} });
    ledgerRun.tracked = () => true;
    ledgerRun.assignLiveState = async (assignment) => {
      sourceEvents.push(...(assignment.sourceEvents ?? []));
      return { ok: false, reason: "stale-sequence" };
    };
    expect(
      s.registry.commitLiveState("run-l", {
        ok: true,
        liveState: { state: "working", since: NOW, bound: NOW + 60_000, detail: "model turn" },
        liveStateSeq: 0,
      }),
    ).toBe(true);
    const out = answered(await runLoop(s.deps, { ...s.ctx, msg, io, ledgerRun, channelVisibility: "dm" }));
    expect(out.answer).toBe("private signup count: 17");
    expect(JSON.stringify(sourceEvents)).not.toContain("private signup count");
    expect(JSON.stringify(s.registry.snapshotById(s.run.id))).not.toContain("private signup count");
    expect(JSON.stringify(s.frames)).not.toContain("private signup count");
    await deliverAnswer({
      msg,
      io,
      agent: s.ctx.agent,
      run: s.run,
      answer: out.answer,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    await s.writer.settled();
    expect(s.replies.at(-1)).toBe("private signup count: 17");
    expect(JSON.stringify(s.closes)).not.toContain("private signup count");
    expect(JSON.stringify(await s.store.get(s.run.id))).not.toContain("private signup count");
    const afterRehost = createRunsService({ registry: new RunRegistry(), store: s.store });
    const finished = await afterRehost.getRun(s.run.id, { include: "messages" });
    expect(finished.ok).toBe(true);
    expect(JSON.stringify(finished)).not.toContain("private signup count");
  });
  it("withdraws linked-work authority before a relayed follow-up reaches the model", async () => {
    let before: unknown;
    let after: unknown;
    let restored: unknown;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            before = await run.toolContext.mainWork?.status("fix-signup");
            expect(run.stageFollowUps).toBeDefined();
            await run.stageFollowUps!([
              { text: "stop that work", userId: "slack:UX", postedBy: "slack:bot:B1", at: 2_000 },
            ]);
            after = await run.toolContext.mainWork?.status("fix-signup");
            await run.stageFollowUps!([{ text: "What happened?", userId: "slack:UX", at: 2_001 }]);
            restored = await run.toolContext.mainWork?.status("fix-signup");
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    s.deps.plane = async () => ({}) as PlaneService;
    const channelId = "slack:DPRIVATE";
    const message = {
      ...s.ctx.msg,
      channelId,
      threadKey: `${channelId}:1.0`,
      directAudience: {
        kind: "slack-unshared-im" as const,
        channelId,
        threadKey: `${channelId}:1.0`,
        userId: s.ctx.msg.userId,
      },
    };
    await runLoop(s.deps, {
      ...s.ctx,
      msg: message,
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(before).toEqual({ kind: "not_found" });
    expect(after).toEqual({ kind: "unavailable" });
    expect(restored).toEqual({ kind: "unavailable" });
  });

  it("withdraws private work start before a relayed follow-up reaches the model", async () => {
    const started = vi.fn(async () => ({ kind: "refused" as const, reply: "fixture" }));
    let before: unknown;
    let after: unknown;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      userId: "slack:UADMIN",
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            const brief = { question: "What failed?", findings: [], requestedChange: "Fix it" };
            before = await run.toolContext.mainStart?.start("acme/api", brief, "fix it in acme/api");
            await run.stageFollowUps!([
              { text: "please start work", userId: "slack:UOTHER", postedBy: "slack:bot:B1", at: 2_000 },
            ]);
            after = await run.toolContext.mainStart?.start("acme/api", brief, "fix it in acme/api");
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.mainTaskStart = started;
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.recordRequesterTurn({ threadKey, requesterId: audience.userId, messageId: "1.0" });
    s.deps.coordinatorInstances = instances;
    await runLoop(s.deps, {
      ...s.ctx,
      captureUnitContext: async () =>
        contextCapsuleOf({
          version: 1,
          source: { runId: s.run.id, requester: audience.userId, channelId, threadKey },
          session: { key: `${threadKey}:@thread`, from: 0, to: -1 },
          assets: [],
        }),
      configuredRepo: "acme/api",
      msg: { ...s.ctx.msg, ...audience, directAudience: audience, messageId: "1.0", text: "fix it in acme/api" },
      requestText: "fix it in acme/api",
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(before).toEqual({ kind: "refused", reply: "fixture" });
    expect(after).toMatchObject({ kind: "refused" });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("persists a verified live follow-up before it can start work or revoke an older request", async () => {
    const runCase = async (initialText: string, followUpText: string, sourceMessage: string) => {
      const channelId = "slack:DPRIVATE";
      const threadKey = `${channelId}:1.0`;
      const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
      const instances = new InMemoryCoordinatorInstanceStore();
      await instances.recordRequesterTurn({
        threadKey,
        requesterId: audience.userId,
        messageId: "1.0",
      });
      const started = vi.fn(async () => ({
        kind: "accepted" as const,
        actId: "act-one",
        instanceId: "unit-one",
        reply: "started",
      }));
      let selected: unknown;
      let stored: unknown;
      const watchedPi = watched(piHarness);
      const s = setup("Done.", {
        agent: "orchestrator",
        userId: audience.userId,
        io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
        harness: {
          harnesses: roster({
            ...watchedPi.harness,
            open: async (deps, run) => {
              const input = {
                text: followUpText,
                userId: audience.userId,
                directAudience: audience,
                messageId: "2.0",
                at: 2_000,
              };
              await run.stageFollowUps!([input]);
              stored = await instances.latestRequesterTurn({ threadKey, requesterId: audience.userId });
              run.confirmedFollowUps?.([input]);
              selected = await run.toolContext.mainStart?.start(
                "acme/api",
                { question: "Why did signup fail?", findings: [], requestedChange: "Fix signup" },
                sourceMessage,
              );
              return watchedPi.harness.open(deps, run);
            },
          }),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          loopbackUrl: "http://127.0.0.1:8080",
          containerFor: () => new FakeHarnessContainer(),
        },
      });
      s.deps.coordinatorInstances = instances;
      s.deps.mainTaskStart = started;
      await runLoop(s.deps, {
        ...s.ctx,
        captureUnitContext: async () =>
          contextCapsuleOf({
            version: 1,
            source: { runId: s.run.id, requester: audience.userId, channelId, threadKey },
            session: { key: `${threadKey}:@thread`, from: 0, to: -1 },
            assets: [],
          }),
        configuredRepo: "acme/api",
        msg: { ...s.ctx.msg, channelId, threadKey, directAudience: audience, messageId: "1.0", text: initialText },
        requestText: initialText,
        channelVisibility: "dm",
      });
      s.ending.drain(undefined);
      await s.writer.settled();
      return { selected, stored, started };
    };

    const fix = await runCase("Why did signup fail in acme/api?", "fix it", "fix it");
    expect(fix.stored).toMatchObject({ messageId: "2.0", revision: 2 });
    expect(fix.selected).toMatchObject({ kind: "accepted" });
    expect(fix.started).toHaveBeenCalledTimes(1);

    const cancel = await runCase("fix signup in acme/api", "stop that work", "fix signup in acme/api");
    expect(cancel.stored).toMatchObject({ messageId: "2.0", revision: 2 });
    expect(cancel.selected).toMatchObject({ kind: "refused" });
    expect(cancel.started).not.toHaveBeenCalled();
  });

  it("keeps the latest work request valid when an earlier follow-up is already superseded", async () => {
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
    const instances = new InMemoryCoordinatorInstanceStore();
    for (const messageId of ["1.0", "2.0", "3.0"])
      await instances.recordRequesterTurn({ threadKey, requesterId: audience.userId, messageId });
    const started = vi.fn(async () => ({
      kind: "accepted" as const,
      actId: "act-one",
      instanceId: "unit-one",
      reply: "started",
    }));
    let earlier: unknown;
    let latest: unknown;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      userId: audience.userId,
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            const inputs = [
              { text: "fix first", userId: audience.userId, directAudience: audience, messageId: "2.0", at: 2_000 },
              { text: "fix latest", userId: audience.userId, directAudience: audience, messageId: "3.0", at: 3_000 },
            ];
            await run.stageFollowUps!(inputs);
            run.confirmedFollowUps?.(inputs);
            earlier = await run.toolContext.mainStart?.start(
              "acme/api",
              { question: "Why did signup fail?", findings: [], requestedChange: "Fix signup" },
              "fix first",
            );
            latest = await run.toolContext.mainStart?.start(
              "acme/api",
              { question: "Why did signup fail?", findings: [], requestedChange: "Fix signup" },
              "fix latest",
            );
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.coordinatorInstances = instances;
    s.deps.mainTaskStart = started;
    await runLoop(s.deps, {
      ...s.ctx,
      captureUnitContext: async () =>
        contextCapsuleOf({
          version: 1,
          source: { runId: s.run.id, requester: audience.userId, channelId, threadKey },
          session: { key: `${threadKey}:@thread`, from: 0, to: -1 },
          assets: [],
        }),
      configuredRepo: "acme/api",
      msg: {
        ...s.ctx.msg,
        channelId,
        threadKey,
        directAudience: audience,
        messageId: "1.0",
        text: "Why did signup fail?",
      },
      requestText: "Why did signup fail?",
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(earlier).toMatchObject({ kind: "refused" });
    expect(latest).toMatchObject({ kind: "accepted" });
    expect(started).toHaveBeenCalledTimes(1);
    expect(await instances.latestRequesterTurn({ threadKey, requesterId: audience.userId })).toMatchObject({
      messageId: "3.0",
      revision: 3,
    });
  });

  it("records a sanitized durable work context refusal without a child or private reply leak", async () => {
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.recordRequesterTurn({ threadKey, requesterId: audience.userId, messageId: "1.0" });
    const started = vi.fn(async () => ({ kind: "accepted" as const, actId: "a", instanceId: "i", reply: "ok" }));
    let result: unknown;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      userId: audience.userId,
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            result = await run.toolContext.mainStart?.start(
              "acme/api",
              { question: "Why?", findings: [], requestedChange: "Fix it" },
              "Fix it.",
            );
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.coordinatorInstances = instances;
    s.deps.mainTaskStart = started;
    const stateCommits: Record<string, unknown>[] = [];
    const ledgerRun = new NullLedgerRun("run-l", {
      put: async (record) => s.store.put(record),
      abandoned: () => {},
    });
    ledgerRun.commitState = async (patch) => {
      stateCommits.push(patch);
      return "ok";
    };
    await runLoop(s.deps, {
      ...s.ctx,
      ledgerRun,
      captureUnitContext: async () => {
        throw new MainContextCaptureError("checkpoint_state-fenced");
      },
      configuredRepo: "acme/api",
      msg: { ...s.ctx.msg, channelId, threadKey, directAudience: audience, messageId: "1.0", text: "Fix it." },
      requestText: "Fix it.",
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(result).toMatchObject({ kind: "refused", reply: expect.stringContaining("couldn't save") });
    expect(JSON.stringify(result)).not.toContain("state-fenced");
    expect(started).not.toHaveBeenCalled();
    expect(stateCommits).toEqual([{ contextRefusals: ["checkpoint_state-fenced"] }]);
    const events = (await s.store.get("run-l"))!.events;
    const note = events.find((event) => event.type === "run_note" && event.kind === "work_context_refused");
    expect(note).toMatchObject({
      type: "run_note",
      kind: "work_context_refused",
      contextReason: "checkpoint_state-fenced",
    });
    expect(Object.keys(note ?? {}).sort()).toEqual(["at", "contextReason", "kind", "seq", "summary", "type"]);
    expect(JSON.stringify(events)).not.toContain("Fix it.");
  });

  it("keeps every private context refusal category after the live backlog evicts its notes", async () => {
    for (const bound of [{ backlogLimit: 2 }, { backlogBytes: 220 }]) {
      const channelId = "slack:DPRIVATE";
      const threadKey = `${channelId}:1.0`;
      const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
      const instances = new InMemoryCoordinatorInstanceStore();
      await instances.recordRequesterTurn({ threadKey, requesterId: audience.userId, messageId: "1.0" });
      const started = vi.fn(async () => ({ kind: "accepted" as const, actId: "a", instanceId: "i", reply: "ok" }));
      const codes = [
        "precondition_untracked",
        "checkpoint_state-fenced",
        "snapshot_failed",
        "dependencies_failed",
        "validation_failed",
        "capsule_invalid",
        "capture_unknown",
      ] as const;
      let index = 0;
      const watchedPi = watched(piHarness);
      const s = setup("Done.", {
        agent: "orchestrator",
        userId: audience.userId,
        ...bound,
        io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
        harness: {
          harnesses: roster({
            ...watchedPi.harness,
            open: async (deps, run) => {
              for (const code of codes) {
                const result = await run.toolContext.mainStart?.start(
                  "acme/api",
                  { question: "Why?", findings: [], requestedChange: "Fix it" },
                  "Fix it.",
                );
                expect(result).toMatchObject({ kind: "refused", reply: expect.stringContaining("couldn't save") });
                expect(JSON.stringify(result)).not.toContain(code);
              }
              for (let i = 0; i < 3; i++)
                s.registry.publish(s.run.id, { type: "run_note", kind: "follow_up", summary: "later activity" });
              return watchedPi.harness.open(deps, run);
            },
          }),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          loopbackUrl: "http://127.0.0.1:8080",
          containerFor: () => new FakeHarnessContainer(),
        },
      });
      s.deps.coordinatorInstances = instances;
      s.deps.mainTaskStart = started;
      await runLoop(s.deps, {
        ...s.ctx,
        captureUnitContext: async () => {
          throw new MainContextCaptureError(codes[index++]);
        },
        configuredRepo: "acme/api",
        msg: { ...s.ctx.msg, channelId, threadKey, directAudience: audience, messageId: "1.0", text: "Fix it." },
        requestText: "Fix it.",
        channelVisibility: "dm",
      });
      s.ending.drain(undefined);
      await s.writer.settled();
      expect(index).toBe(codes.length);
      expect(started).not.toHaveBeenCalled();
      const record = (await s.store.get("run-l"))!;
      expect(record.events).not.toContainEqual(expect.objectContaining({ kind: "work_context_refused" }));
      expect(record.contextRefusals).toEqual(codes);
      expect(JSON.stringify(record)).not.toContain("Fix it.");
    }
  });

  it("records the private start source predicate without exposing its message or target", async () => {
    const runCase = async (
      fault: "quote" | "quote_missing" | "store" | "read" | "missing" | "superseded" | "repo_missing" | "repo_mismatch",
    ) => {
      const channelId = "slack:DPRIVATE";
      const threadKey = `${channelId}:1.0`;
      const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
      const instances = new InMemoryCoordinatorInstanceStore();
      if (fault !== "missing" && fault !== "store")
        await instances.recordRequesterTurn({
          threadKey,
          requesterId: audience.userId,
          messageId: fault === "superseded" ? "2.0" : "1.0",
        });
      if (fault === "read")
        vi.spyOn(instances, "latestRequesterTurn").mockRejectedValue(new Error("private store detail"));
      const started = vi.fn(async () => ({ kind: "accepted" as const, actId: "a", instanceId: "i", reply: "ok" }));
      let result: unknown;
      const watchedPi = watched(piHarness);
      const s = setup("Done.", {
        agent: "orchestrator",
        userId: audience.userId,
        io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
        harness: {
          harnesses: roster({
            ...watchedPi.harness,
            open: async (deps, run) => {
              result = await run.toolContext.mainStart?.start(
                "acme/api",
                { question: "Why?", findings: [], requestedChange: "Fix it" },
                fault === "quote" ? "Fix another thing" : fault === "quote_missing" ? "" : "Fix it.",
              );
              return watchedPi.harness.open(deps, run);
            },
          }),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          loopbackUrl: "http://127.0.0.1:8080",
          containerFor: () => new FakeHarnessContainer(),
        },
      });
      if (fault !== "store") s.deps.coordinatorInstances = instances;
      s.deps.mainTaskStart = started;
      await runLoop(s.deps, {
        ...s.ctx,
        ...(fault === "repo_missing" ? {} : { configuredRepo: fault === "repo_mismatch" ? "vendor/lib" : "acme/api" }),
        msg: { ...s.ctx.msg, channelId, threadKey, directAudience: audience, messageId: "1.0", text: "Fix it." },
        requestText: "Fix it.",
        channelVisibility: "dm",
      });
      s.ending.drain(undefined);
      await s.writer.settled();
      return { result, events: (await s.store.get("run-l"))!.events, started };
    };
    const reasons = {
      quote: "source_quote_mismatch",
      quote_missing: "source_quote_missing",
      store: "authority_store_unavailable",
      read: "requester_turn_read_failed",
      missing: "requester_turn_missing",
      superseded: "requester_turn_superseded",
      repo_missing: "repository_unconfigured",
      repo_mismatch: "repository_mismatch",
    } as const;
    for (const [fault, reason] of Object.entries(reasons) as Array<
      [keyof typeof reasons, (typeof reasons)[keyof typeof reasons]]
    >) {
      const { result, events, started } = await runCase(fault);
      expect(result).toMatchObject({ kind: "refused", sourceReason: reason });
      const note = events.find((event) => event.type === "run_note" && event.kind === "work_source_refused");
      expect(note).toMatchObject({ type: "run_note", kind: "work_source_refused", sourceReason: reason });
      expect(Object.keys(note ?? {}).sort()).toEqual(["at", "kind", "seq", "sourceReason", "summary", "type"]);
      expect(JSON.stringify(events)).not.toContain("private store detail");
      expect(started).not.toHaveBeenCalled();
    }
  });

  it("does not authorize work from an operator-joined prompt when the delivered reply says no", async () => {
    const started = vi.fn(async () => ({
      kind: "accepted" as const,
      actId: "act-one",
      instanceId: "unit-one",
      reply: "started",
    }));
    let result: unknown;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      userId: "slack:UADMIN",
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            result = await run.toolContext.mainStart?.start(
              "acme/api",
              { question: "What failed?", findings: [], requestedChange: "Fix signup" },
              "Please fix signup in acme/api",
            );
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.mainTaskStart = started;
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const audience = { kind: "slack-unshared-im" as const, channelId, threadKey, userId: "slack:UADMIN" };
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.recordRequesterTurn({ threadKey, requesterId: audience.userId, messageId: "1.0" });
    s.deps.coordinatorInstances = instances;
    await runLoop(s.deps, {
      ...s.ctx,
      msg: { ...s.ctx.msg, channelId, threadKey, directAudience: audience, messageId: "1.0", text: "no" },
      requestText: "Please fix signup in acme/api\nno",
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(result).toMatchObject({ kind: "refused" });
    expect(started).not.toHaveBeenCalled();
  });

  it("waits for an admitted stop before a revoked private follow-up reaches the model", async () => {
    let entered!: () => void;
    let release!: () => void;
    const stopping = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let followUpReachedModel = false;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            const effect = run.toolContext.mainWork!.stop("fix-signup");
            await stopping;
            s.ctx.admitted.inbox.markUntrustedFollowUp();
            const staged = run.stageFollowUps!([
              { text: "What happened?", userId: "slack:UX", postedBy: "slack:bot:B1", at: 2_000 },
            ]).then(() => (followUpReachedModel = true));
            await Promise.resolve();
            expect(followUpReachedModel).toBe(false);
            release();
            await effect;
            await staged;
            expect(followUpReachedModel).toBe(true);
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const instance = {
      id: "ship_signup_1",
      kind: "ship" as const,
      userId: s.ctx.msg.userId,
      channelId,
      threadKey,
      repo: "acme/api",
      branch: "ship/signup",
      base: "main",
      plan: { id: "signup" },
      merge: "person" as const,
      createdAt: 1_000,
      runId: "run-parent",
    };
    await instances.recordRequesterTurn({ threadKey, requesterId: instance.userId, messageId: "1" });
    expect(
      await instances.claimMainTask(
        { mainThreadKey: threadKey, actId: "fix-signup" },
        instance,
        {
          instanceId: instance.id,
          unit: "task",
          slug: "signup",
          branch: instance.branch,
          dependsOn: [],
          rounds: [],
          workBrief: {
            requesterId: instance.userId,
            mainThreadKey: threadKey,
            actId: "fix-signup",
            repo: instance.repo,
            base: instance.base,
            question: "How many users failed to sign up?",
            findings: [],
            requestedChange: "Fix signups",
          },
        },
        { requesterId: instance.userId, sourceMessageId: "1", revision: 1, repo: instance.repo },
      ),
    ).toMatchObject({ ok: true });
    s.deps.coordinatorInstances = instances;
    s.deps.plane = async () =>
      ({
        stop: async () => {
          entered();
          await held;
          return { kind: "stopped", instanceId: instance.id, runnerStopped: true, stopsSucceeded: true, children: [] };
        },
      }) as unknown as PlaneService;
    await runLoop(s.deps, {
      ...s.ctx,
      msg: {
        ...s.ctx.msg,
        channelId,
        threadKey,
        directAudience: { kind: "slack-unshared-im", channelId, threadKey, userId: s.ctx.msg.userId },
      },
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it("a plane provider-reissue control does not withdraw linked-work authority", async () => {
    let afterControl: unknown;
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            await run.stageFollowUps!([{ text: reissueSteerSentence("anthropic"), userId: PLANE_ACTOR_ID, at: 2_000 }]);
            afterControl = await run.toolContext.mainWork?.status("fix-signup");
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    s.deps.plane = async () => ({}) as PlaneService;
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const message = {
      ...s.ctx.msg,
      channelId,
      threadKey,
      directAudience: { kind: "slack-unshared-im" as const, channelId, threadKey, userId: s.ctx.msg.userId },
    };
    await runLoop(s.deps, {
      ...s.ctx,
      msg: message,
      channelVisibility: "dm",
    });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(afterControl).toEqual({ kind: "not_found" });
  });

  it("a delayed direct-audience check cannot restore a revoked run", async () => {
    let afterRace: unknown;
    let checks = 0;
    let checking!: () => void;
    let release!: (verified: boolean) => void;
    const started = new Promise<void>((resolve) => (checking = resolve));
    const verified = new Promise<boolean>((resolve) => (release = resolve));
    const watchedPi = watched(piHarness);
    const s = setup("Done.", {
      agent: "orchestrator",
      io: {
        verifyDirectAudience: booleanAudienceVerifier(async () => (++checks === 1 ? true : (checking(), verified))),
      } as Partial<ChannelIO>,
      harness: {
        harnesses: roster({
          ...watchedPi.harness,
          open: async (deps, run) => {
            const direct = run.stageFollowUps!([
              {
                text: "Check the work",
                userId: "slack:UX",
                directAudience: {
                  kind: "slack-unshared-im",
                  channelId: "slack:DPRIVATE",
                  threadKey: "slack:DPRIVATE:1.0",
                  userId: "slack:UX",
                },
                messageId: "2.0",
                at: 2_000,
              },
            ]);
            await started;
            await run.stageFollowUps!([{ text: "Stop it", userId: "slack:UX", postedBy: "slack:bot:B1", at: 2_001 }]);
            release(true);
            await direct;
            afterRace = await run.toolContext.mainWork?.status("fix-signup");
            return watchedPi.harness.open(deps, run);
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    s.deps.plane = async () => ({}) as PlaneService;
    const channelId = "slack:DPRIVATE";
    const threadKey = `${channelId}:1.0`;
    const message = {
      ...s.ctx.msg,
      channelId,
      threadKey,
      directAudience: { kind: "slack-unshared-im" as const, channelId, threadKey, userId: s.ctx.msg.userId },
    };
    await runLoop(s.deps, { ...s.ctx, msg: message, channelVisibility: "dm" });
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(afterRace).toEqual({ kind: "unavailable" });
  });

  it("offers linked-work tools to the model only in a direct requester Slack DM", async () => {
    const toolNames = async (
      channelId: string,
      visibility: "public" | "dm",
      postedBy?: string,
      attested = true,
      verify: "ok" | "deny" | "error" = "ok",
    ) => {
      const observed: string[] = [];
      const watchedPi = watched(piHarness);
      const s = setup("Done.", {
        agent: "orchestrator",
        io: {
          verifyDirectAudience: booleanAudienceVerifier(async () => {
            if (verify === "error") throw new Error("Slack lookup unavailable");
            return verify === "ok";
          }),
        } as Partial<ChannelIO>,
        harness: {
          harnesses: roster({
            ...watchedPi.harness,
            open: async (deps, run) => {
              observed.push(...run.tools.map((tool) => tool.name));
              return watchedPi.harness.open(deps, run);
            },
          }),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          loopbackUrl: "http://127.0.0.1:8080",
          containerFor: () => new FakeHarnessContainer(),
        },
      });
      s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
      s.deps.plane = async () => ({}) as PlaneService;
      const message = {
        ...s.ctx.msg,
        channelId,
        threadKey: `${channelId}:1.0`,
        ...(postedBy ? { postedBy } : {}),
        ...(attested
          ? {
              directAudience: {
                kind: "slack-unshared-im" as const,
                channelId,
                threadKey: `${channelId}:1.0`,
                userId: s.ctx.msg.userId,
              },
            }
          : {}),
      };
      await runLoop(s.deps, { ...s.ctx, msg: message, channelVisibility: visibility });
      s.ending.drain(undefined);
      await s.writer.settled();
      return observed;
    };

    expect(await toolNames("slack:CPUB", "public")).not.toContain("work_status");
    expect(await toolNames("slack:DPRIVATE", "dm", "slack:bot:B1")).not.toContain("work_steer");
    expect(await toolNames("slack:DSHARED", "dm", undefined, false)).not.toContain("work_status");
    expect(await toolNames("slack:DPRIVATE", "dm", undefined, true, "deny")).not.toContain("work_status");
    expect(await toolNames("slack:DPRIVATE", "dm", undefined, true, "error")).not.toContain("work_stop");
    expect(await toolNames("slack:DPRIVATE", "dm")).toEqual(
      expect.arrayContaining(["work_status", "work_steer", "work_stop"]),
    );
  });

  it("does not show the private progress tool to a model in a shared or unknown channel", async () => {
    let visible: string[] = [];
    const scripted: Provider = {
      name: "fake",
      async complete(req) {
        visible = req.tools?.map((tool) => tool.name) ?? [];
        return { content: [{ type: "text", text: "Status unavailable here." }], stopReason: "end_turn" };
      },
    };
    const s = setup("", { agent: "orchestrator", provider: scripted });
    s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    s.deps.privateWorkerLog = new InMemoryPrivateWorkerLog();
    answered(await runLoop(s.deps, s.ctx));
    expect(visible).toContain("plane_show");
    expect(visible).not.toContain("work_progress");
  });

  it("does not show private progress to a model in an unverified or newly shared Slack D conversation", async () => {
    for (const state of ["unverified", "shared", "external", "pending"]) {
      let visible: string[] = [];
      const s = setup("", {
        agent: "orchestrator",
        channelId: "slack:DMAIN",
        threadKey: "slack:DMAIN:1.0",
        directAudience:
          state === "unverified"
            ? undefined
            : { kind: "slack-unshared-im", channelId: "slack:DMAIN", userId: "slack:UX", threadKey: "slack:DMAIN:1.0" },
        io: { verifyDirectAudience: booleanAudienceVerifier(async () => false) },
        provider: {
          name: "fake",
          async complete(req) {
            visible = req.tools?.map((tool) => tool.name) ?? [];
            return { content: [{ type: "text", text: "Status unavailable here." }], stopReason: "end_turn" };
          },
        },
      });
      s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
      s.deps.privateWorkerLog = new InMemoryPrivateWorkerLog();
      answered(await runLoop(s.deps, s.ctx));
      expect(visible, state).not.toContain("work_progress");
    }
  });

  it("a later orchestrator turn reads only its linked private worker projection through the tool context", async () => {
    const dmThread = "slack:DMAIN:1.0";
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const instance = {
      id: "ship_signup_1",
      kind: "ship" as const,
      userId: "slack:UX",
      channelId: "slack:DMAIN",
      threadKey: dmThread,
      repo: "acme/api",
      branch: "ship/signup",
      base: "main",
      plan: { id: "signup" },
      merge: "person" as const,
      createdAt: 1,
    };
    const unit = {
      instanceId: instance.id,
      unit: "task",
      slug: "signup",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      workBrief: {
        requesterId: instance.userId,
        mainThreadKey: dmThread,
        actId: "fix-signups",
        repo: instance.repo,
        base: instance.base,
        question: "How many signups failed?",
        findings: [],
        requestedChange: "Fix signups",
      },
    };
    await instances.recordRequesterTurn({ threadKey: dmThread, requesterId: instance.userId, messageId: "1" });
    await instances.claimMainTask({ mainThreadKey: dmThread, actId: "fix-signups" }, instance, unit, {
      requesterId: instance.userId,
      sourceMessageId: "1",
      revision: 1,
      repo: instance.repo,
    });
    const log = new InMemoryPrivateWorkerLog();
    const key = privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit });
    await log.append(key, { kind: "reply", text: "private coding transcript", at: 2 });
    await log.append(key, {
      kind: "status",
      phase: "start",
      frame: { title: "Testing", detail: "private details" },
      at: 3,
    });
    let turn = 0;
    let visible: string[] = [];
    let modelContext = "";
    const scripted: Provider = {
      name: "fake",
      async complete(req) {
        visible = req.tools?.map((tool) => tool.name) ?? [];
        if (turn++ === 0)
          return {
            content: [
              { type: "tool_use", id: "progress-read", name: "work_progress", input: { actId: "fix-signups" } },
            ],
            stopReason: "tool_use",
          };
        modelContext = JSON.stringify(req.messages);
        return { content: [{ type: "text", text: "The worker is testing." }], stopReason: "end_turn" };
      },
    };
    const s = setup("", {
      agent: "orchestrator",
      provider: scripted,
      channelId: instance.channelId,
      threadKey: dmThread,
      directAudience: {
        kind: "slack-unshared-im",
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey: dmThread,
      },
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
    });
    s.deps.coordinatorInstances = instances;
    s.deps.privateWorkerLog = log;
    const inner = new InMemoryRunLedger();
    const ledger = createLedgerWriteThrough({ ledger: inner, gen: "work-read", fallback: s.store, warn: () => {} });
    s.deps.runLedger = ledger;
    const opened = await ledger.open({
      runId: s.run.id,
      threadKey: dmThread,
      startedAt: NOW,
      meta: { agent: "orchestrator", userId: instance.userId, channelId: instance.channelId, threadKey: dmThread },
      card: null,
      system: s.ctx.system,
      tools: [],
      seed: {
        messages: s.ctx.messages,
        budgetMs: 60_000,
        context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
      },
    });
    if (opened.kind !== "tracked") throw new Error("untracked fixture");
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run }));
    expect(out.answer).toContain("worker is testing");
    expect(visible).toContain("work_progress");
    s.ending.drain(true);
    await s.writer.settled();
    const record = inner.finished.get("run-l")!;
    const result = JSON.stringify(record.events.filter((event) => event.type === "tool_result"));
    expect(modelContext).toContain("Testing");
    expect(modelContext).not.toMatch(/private coding transcript|private details/);
    expect(result).not.toContain("Testing");
    expect(result).not.toMatch(/private coding transcript|private details/);
  });

  it.each(["stable", "changes again"] as const)("refreshes current work before the final answer (%s)", async (race) => {
    const threadKey = "slack:DMAIN:1.0",
      channelId = "slack:DMAIN",
      userId = "slack:UX";
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const instance = {
      id: "status-work",
      kind: "ship" as const,
      userId,
      channelId,
      threadKey,
      repo: "acme/api",
      branch: "ship/work",
      base: "main",
      plan: { id: "work" },
      merge: "person" as const,
      createdAt: 1,
    };
    const unit = {
      instanceId: instance.id,
      unit: "task",
      slug: "work",
      branch: instance.branch,
      dependsOn: [],
      rounds: [],
      startedAt: 2,
      workBrief: {
        requesterId: userId,
        mainThreadKey: threadKey,
        actId: "work",
        repo: instance.repo,
        base: "main",
        question: "What failed?",
        findings: [],
        requestedChange: "Fix it",
      },
    };
    await instances.recordRequesterTurn({ threadKey, requesterId: userId, messageId: "1" });
    await instances.claimMainTask({ mainThreadKey: threadKey, actId: "work" }, instance, unit, {
      requesterId: userId,
      sourceMessageId: "1",
      revision: 1,
      repo: instance.repo,
    });
    let turns = 0;
    const requests: import("../provider.js").CompletionRequest[] = [];
    const scripted: Provider = {
      name: "fake",
      async complete(req) {
        requests.push(req);
        if (turns++ === 0)
          return {
            content: [{ type: "tool_use", id: "status-read", name: "work_status", input: { actId: "work" } }],
            stopReason: "tool_use",
          };
        if (turns === 2) {
          await instances.putUnits([{ ...unit, ending: { kind: "aborted", at: 3, report: "Stopped" } }]);
          return { content: [{ type: "text", text: "The work is running." }], stopReason: "end_turn" };
        }
        expect(JSON.stringify(req.messages)).toContain("aborted");
        if (race === "changes again")
          await instances.putUnits([{ ...unit, ending: { kind: "aborted", at: 4, report: "Changed again" } }]);
        return { content: [{ type: "text", text: "The work was aborted." }], stopReason: "end_turn" };
      },
    };
    const s = setup("", {
      agent: "orchestrator",
      provider: scripted,
      channelId,
      threadKey,
      directAudience: { kind: "slack-unshared-im", channelId, threadKey, userId },
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
    });
    s.deps.coordinatorInstances = instances;
    s.deps.plane = async () => ({}) as PlaneService;
    const inner = new InMemoryRunLedger(),
      ledger = createLedgerWriteThrough({ ledger: inner, gen: "status-gen", fallback: s.store, warn: () => {} });
    s.deps.runLedger = ledger;
    const opened = await ledger.open({
      runId: s.run.id,
      threadKey,
      startedAt: NOW,
      meta: { agent: "orchestrator", userId, channelId, threadKey },
      card: null,
      system: s.ctx.system,
      tools: [],
      seed: {
        messages: s.ctx.messages,
        budgetMs: 60_000,
        context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
      },
    });
    if (opened.kind !== "tracked") throw new Error("untracked fixture");
    const privateAudienceLatch = { revoked: false };
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run, privateAudienceLatch }));
    expect(out.answer).toContain(race === "stable" ? "aborted" : "current state remains unconfirmed");
    expect(out.answer).not.toContain("is running");
    expect(privateAudienceLatch.revoked).toBe(false);
    expect(turns).toBe(3);
    const saved = (await ledger.readLiveRuns()).find((row) => row.runId === s.run.id);
    expect(saved?.state.workRefreshUsed).toBe(true);
    expect(saved?.state.workReads).toEqual([expect.objectContaining({ callId: "status-read", tool: "work_status" })]);
    s.ending.drain(true);
    await s.writer.settled();
    const record = inner.finished.get(s.run.id);
    expect(record?.workReads).toHaveLength(1);
    expect(JSON.stringify(record?.events.filter((e) => e.type === "answer"))).not.toContain("is running");
  });

  it("revokes private progress when an app follow-up folds into the live main run", async () => {
    const threadKey = "slack:DMAIN:1.0";
    const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
    const instance = {
      id: "ship_signup_2",
      kind: "ship" as const,
      userId: "slack:UX",
      channelId: "slack:DMAIN",
      threadKey,
      repo: "acme/api",
      branch: "ship/signup",
      base: "main",
      plan: { id: "signup" },
      merge: "person" as const,
      createdAt: 1,
    };
    await instances.recordRequesterTurn({ threadKey, requesterId: instance.userId, messageId: "1" });
    await instances.claimMainTask(
      { mainThreadKey: threadKey, actId: "fix-signups" },
      instance,
      {
        instanceId: instance.id,
        unit: "task",
        slug: "signup",
        branch: instance.branch,
        dependsOn: [],
        rounds: [],
        workBrief: {
          requesterId: instance.userId,
          mainThreadKey: threadKey,
          actId: "fix-signups",
          repo: instance.repo,
          base: instance.base,
          question: "How many signups failed?",
          findings: [],
          requestedChange: "Fix signups",
        },
      },
      {
        requesterId: instance.userId,
        sourceMessageId: "1",
        revision: 1,
        repo: instance.repo,
      },
    );
    const log = new InMemoryPrivateWorkerLog();
    await log.append(privateWorkerThreadKey({ instanceId: instance.id, unit: "task" }), {
      kind: "status",
      phase: "start",
      frame: { title: "Private progress" },
      at: 2,
    });
    let turn = 0;
    let modelResult = "";
    let s: ReturnType<typeof setup>;
    const scripted: Provider = {
      name: "fake",
      async complete(req) {
        if (turn++ === 0) {
          s.ctx.admitted.inbox.push({
            text: "fix it",
            userId: instance.userId,
            postedBy: "slack:bot:B1",
            at: NOW + 1,
            msg: {
              channelId: instance.channelId,
              userId: instance.userId,
              threadKey,
              text: "fix it",
              postedBy: "slack:bot:B1",
            },
          });
          return {
            content: [
              {
                type: "tool_use",
                id: "progress-after-followup",
                name: "work_progress",
                input: { actId: "fix-signups" },
              },
            ],
            stopReason: "tool_use",
          };
        }
        modelResult = JSON.stringify(req.messages);
        return { content: [{ type: "text", text: "I saw the follow-up." }], stopReason: "end_turn" };
      },
    };
    s = setup("", {
      agent: "orchestrator",
      provider: scripted,
      channelId: instance.channelId,
      threadKey,
      directAudience: { kind: "slack-unshared-im", channelId: instance.channelId, userId: instance.userId, threadKey },
      io: { verifyDirectAudience: booleanAudienceVerifier(async () => true) },
    });
    s.deps.coordinatorInstances = instances;
    s.deps.privateWorkerLog = log;
    answered(await runLoop(s.deps, s.ctx));
    s.ending.drain(true);
    await s.writer.settled();
    const events = (await s.store.get("run-l"))!.events;
    expect(modelResult).toContain("unavailable");
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "input", text: "Private request" })]),
    );
    expect(JSON.stringify(events)).not.toContain("Private progress");
    expect(s.ctx.admitted.inbox.hasOnlyDirectRequester(instance.userId)).toBe(false);
  });

  const WIP_COORDINATOR: CoordinatorTag = {
    parentInstanceId: "instance",
    idempotencyKey: "instance:U11/0/coding",
    base: "main",
  };
  it("a coding child reads Depot failure evidence through its repo-bound Worker bridge", async () => {
    vi.stubEnv("DEPOT_CI_BRIDGE_TOKEN", "internal-test-bearer");
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const { ticket } = JSON.parse(String(init.body));
        requests.push(depotCiAuthorizations.consume(ticket)!);
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer internal-test-bearer");
        return Response.json({
          attemptId: "attempt-one",
          complete: true,
          text: "FAIL parser: expected true got false",
        });
      }),
    );
    let turn = 0;
    const scripted: Provider = {
      name: "fake",
      async complete() {
        if (turn++ === 0)
          return {
            content: [
              {
                type: "tool_use",
                id: "depot-call",
                name: "depot_ci_logs",
                input: { workflow: "workflow-one", jobId: "test" },
              },
            ],
            stopReason: "tool_use",
          };
        return { content: [{ type: "text", text: "The parser assertion failed." }], stopReason: "end_turn" };
      },
    };
    try {
      const s = setup("", {
        agent: "coding",
        provider: scripted,
        repoCtx: { repo: "acme/api", ref: "work" },
        coordinator: WIP_COORDINATOR,
      });
      const out = answered(await runLoop(s.deps, s.ctx));
      expect(out.toolCalls).toBe(1);
      expect(requests).toEqual([
        {
          runId: "run-l",
          repo: "acme/api",
          operation: { operation: "logs", workflowId: "workflow-one", jobId: "test" },
        },
      ]);
      s.ending.drain(true);
      await s.writer.settled();
      const record = (await s.store.get("run-l"))!;
      const results = JSON.stringify(record.events.filter((e) => e.type === "tool_result"));
      expect(results).toContain("FAIL parser: expected true got false");
      expect(results).not.toContain("internal-test-bearer");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  // docs/reference/specs/agent-coding.md item 10: the thread's file upload
  // rides the tool context only when the channel has one — a coding run's
  // `attach_file` posts through the requesting thread's `attachFile`.
  it("a coding run's attach_file posts the workspace file through the channel's attachFile; without one the tool says the channel takes no files", async () => {
    const scripted = (): Provider => {
      let turn = 0;
      return {
        name: "fake",
        async complete() {
          if (turn++ === 0)
            return {
              content: [
                { type: "tool_use", id: "t1", name: "attach_file", input: { path: "shot.png", comment: "the page" } },
              ],
              stopReason: "tool_use",
            };
          return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
        },
      };
    };
    const executor: Partial<Executor> = { readBytes: async () => new Uint8Array([1, 2, 3]) };
    const files: string[] = [];
    const withUpload = setup("", {
      agent: "coding",
      provider: scripted(),
      executor,
      io: { attachFile: async (f) => void files.push(`${f.name}:${f.bytes.byteLength}:${f.lead}`) },
    });
    const toolResults = async (s: ReturnType<typeof setup>) => {
      s.ending.drain(true);
      await s.writer.settled();
      const rec = (await s.store.get("run-l"))!;
      return JSON.stringify(rec.events.filter((e) => e.type === "tool_result"));
    };
    const out = answered(await runLoop(withUpload.deps, withUpload.ctx));
    expect(out.toolCalls).toBe(1);
    expect(files).toEqual(["shot.png:3:the page"]);
    expect(await toolResults(withUpload)).toContain("attached shot.png (3 bytes) to the conversation");

    const without = setup("", { agent: "coding", provider: scripted(), executor });
    await runLoop(without.deps, without.ctx);
    expect(await toolResults(without)).toMatch(/this conversation's channel takes no file uploads/);
  });

  // record 0033: with a store in the deps the dispatcher binds the store path
  // (this run's keys, the channel's upload ticket, its `reply` for the lead) —
  // the file moves through the executor's commands, never through `readBytes`.
  it("with an artifact store the run's attach_file moves the file by reference: the executor PUTs and POSTs, the record carries the artifact event, the ticket is completed; without a ticket the lead goes through reply", async () => {
    const scripted = (): Provider => {
      let turn = 0;
      return {
        name: "fake",
        async complete() {
          if (turn++ === 0)
            return {
              content: [
                { type: "tool_use", id: "t1", name: "attach_file", input: { path: "shot.png", comment: "the page" } },
              ],
              stopReason: "tool_use",
            };
          return { content: [{ type: "text", text: "done" }], stopReason: "end_turn" };
        },
      };
    };
    const store = new InMemoryArtifactStore({ bucket: "test" });
    const commands: string[] = [];
    const executor: Partial<Executor> = {
      readBytes: async () => {
        throw new Error("the inline path must not run with a store");
      },
      exec: async (command) => {
        commands.push(command);
        if (command.startsWith("stat ")) return "3\n";
        if (command.startsWith("curl -fsS -T ")) {
          const url = new URL(/'([^']+)'$/.exec(command)![1]);
          store.put(decodeURIComponent(url.pathname.slice(1)), new Uint8Array([1, 2, 3]), "image/png");
        }
        return "";
      },
    };
    const completed: string[] = [];
    const ticketed = setup("", {
      agent: "coding",
      provider: scripted(),
      executor,
      artifacts: store,
      io: {
        uploadTicket: async () => ({
          url: "https://files.example/one-shot",
          complete: async (lead) => void completed.push(lead),
        }),
      },
    });
    await runLoop(ticketed.deps, ticketed.ctx);
    ticketed.ending.drain(true);
    await ticketed.writer.settled();
    const rec = (await ticketed.store.get("run-l"))!;
    expect(JSON.stringify(rec.events.filter((e) => e.type === "tool_result"))).toContain(
      "attached shot.png (3 bytes) to the conversation and the run page",
    );
    expect(rec.events.filter((e) => e.type === "artifact")).toMatchObject([
      {
        type: "artifact",
        direction: "out",
        key: "runs/run-l/out/1-shot.png",
        name: "shot.png",
        size: 3,
        contentType: "image/png",
      },
    ]);
    expect(commands.map((c) => c.split(" ")[0] + " " + c.split(" ").slice(1, 3).join(" "))).toEqual([
      "stat -c %s",
      "curl -fsS -T",
      "curl -fsS --upload-file",
    ]);
    expect(completed).toEqual(["the page"]);

    commands.length = 0;
    const store2 = new InMemoryArtifactStore({ bucket: "test" });
    const untied = setup("", {
      agent: "coding",
      provider: scripted(),
      executor: {
        ...executor,
        exec: async (command) => {
          commands.push(command);
          if (command.startsWith("stat ")) return "3\n";
          if (command.startsWith("curl -fsS -T ")) {
            const url = new URL(/'([^']+)'$/.exec(command)![1]);
            store2.put(decodeURIComponent(url.pathname.slice(1)), new Uint8Array([1, 2, 3]), "image/png");
          }
          return "";
        },
      },
      artifacts: store2,
    });
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example.com");
    try {
      await runLoop(untied.deps, untied.ctx);
    } finally {
      vi.unstubAllEnvs();
    }
    untied.ending.drain(true);
    await untied.writer.settled();
    expect(commands).toHaveLength(2); // stat + PUT: no POST without a ticket
    // The lead carries the file's own proxy link, tokened with THIS run's live token.
    expect(untied.replies).toContain(
      `the page\n📎 shot.png (3 bytes) — https://bot.example.com/runs/run-l/artifacts/runs/run-l/out/1-shot.png?t=${encodeURIComponent(untied.run.token)}`,
    );
  });

  it("a completed run: the answer comes back through the typed-output boundary and is published, the registry is finished `completed`, the record is registered for the drain, the workspace is NOT released here", async () => {
    const s = setup("the answer");
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("the answer");
    expect(out.toolCalls).toBe(0);
    expect(out.runDiagnosis).toBeDefined();
    expect(out.prNote).toBeUndefined();
    expect(s.published).toEqual(["answer:the answer"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    expect(s.releases).toEqual([]);
    expect(s.closes).toEqual([]);
    // The record is written by the drain that follows the reply — with the seal's stamps.
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec).toMatchObject({ id: "run-l", status: "completed", agent: "general", replyOk: true });
    expect(rec.events.map((e) => e.type)).toContain("answer");
    // A reply that threw AFTER the loop would have flipped it to failed instead.
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["paired"]);
  });

  it("sets the resident registration deadline from the harness lease", async () => {
    const remaining: number[] = [];
    const s = setup("the answer", { executor: { setRunDeadline: async (ms) => void remaining.push(ms) } });
    answered(await runLoop(s.deps, s.ctx));
    expect(remaining).toEqual([expect.any(Number)]);
    expect(remaining[0]).toBeGreaterThan(0);
    expect(remaining[0]).toBeLessThanOrEqual(s.ctx.profile.minutes * 60_000);
  });

  it("a failed run: the error propagates, the registry is finished `failed`, the workspace is released first and the card closes with ❌; the drain writes the failed record", async () => {
    const s = setup(new Error("provider down"));
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow(UNKNOWN_MODEL_TERMINAL_MESSAGE);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["paired"]);
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("❌");
    expect(s.published).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!.status).toBe("failed");
  });

  // docs/reference/specs/harness.md item 13: the workspace's release reads the
  // record. A command the run's ending may have left running in the workspace —
  // a call the ending cut (its result marked `cut`: pi's abort, OpenCode's
  // interrupt, the session's end), or a call open when the run failed or was
  // interrupted — tears the workspace down as after a hard stop rather than hold
  // it behind the command, and the record says so; a run that completed with a
  // call unpaired (a relayed tool that ran in the bot) left nothing running and
  // pairs the workspace as any orderly end does; a failure with nothing in
  // flight pairs it too; a gate bypass tears it down whatever the record shows.
  // The harness is a stub over the seam: what it puts on the record and how its
  // `open` ends are the ending's two facts, and the loop reads nothing else.
  const openToolCall = (run: HarnessRun): void =>
    run.onEvent?.({ type: "tool_call", tool: "bash", summary: "$ sleep 600", command: "sleep 600", callId: "c-open" });
  const settleToolCall = (run: HarnessRun): void =>
    run.onEvent?.({ type: "tool_result", tool: "bash", ok: true, summary: "exit 0", callId: "c-open" });
  // pi's aborted settle: the tool's own end after the loop's abort, which the
  // bridge marks `cut` — on the record before the session ends.
  const abortOpenCall = (run: HarnessRun): void =>
    run.onEvent?.({ type: "tool_result", tool: "bash", ok: false, summary: "aborted", callId: "c-open", cut: true });
  // What pi's `end()` does to every call still open (`closeOpenSpans`): a
  // failed result marked `cut`.
  const cutOpenCallAtEnd = (run: HarnessRun): void =>
    run.onEvent?.({
      type: "tool_result",
      tool: "bash",
      ok: false,
      summary: "the run ended",
      callId: "c-open",
      cut: true,
    });
  // A relayed tool's call the record never paired: it ran in the bot, nothing in the workspace.
  const openRelayedCall = (run: HarnessRun): void =>
    run.onEvent?.({ type: "tool_call", tool: "update_status", summary: "update_status", callId: "c-relayed" });
  const tornDownNotes = async (s: ReturnType<typeof setup>, ended: boolean | undefined) => {
    s.ending.drain(ended);
    await s.writer.settled();
    return (await s.store.get("run-l"))!.events
      .filter((e) => e.type === "run_note" && e.kind === "workspace_torn_down")
      .map((e) => (e.type === "run_note" ? e.summary : ""));
  };
  const endingIn = (open: Harness["open"], extra: Partial<Parameters<typeof setup>[1]> = {}) =>
    setup("", {
      agent: "coding",
      yaml: YAML + "harness:\n  coding: pi\n",
      ...extra,
      harness: {
        harnesses: roster({ ...watched(piHarness).harness, open }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      bearer: "sbr_run-l.s3cret",
    });
  const sessionAnswering = (
    answer: string,
    end: () => Promise<void> = async () => {},
    followUp: HarnessSession["followUp"] = async () => "",
  ): HarnessSession => ({
    answer,
    followUp,
    remainingMs: () => 0,
    end,
  });

  it.each(["kill", "transport", "hard", "in-flight"])(
    "an unconfirmed producer ending retains its original workspace (%s)",
    async (cause) => {
      const unknown = new Error(`unconfirmed ${cause}`);
      const s = endingIn(async (_deps, run) => {
        if (cause === "hard") run.control?.requestStop("hard");
        if (cause === "in-flight") openToolCall(run);
        return sessionAnswering("done", async () => {
          throw unknown;
        });
      });
      await expect(runLoop(s.deps, s.ctx)).rejects.toBe(unknown);
      expect(s.releases).toEqual([]);
      s.ending.drain(undefined);
      await s.writer.settled();
    },
  );
  it("a failed ending record drain retains the original workspace", async () => {
    const failure = new Error("ending record drain unavailable");
    let ending = false;
    const s = endingIn(async () =>
      sessionAnswering("done", async () => {
        ending = true;
      }),
    );
    const events = new RunEventLane((event) => s.registry.publish(s.ctx.run.id, event));
    const drain = events.drain.bind(events);
    vi.spyOn(events, "drain").mockImplementation(async () => {
      if (ending) throw failure;
      await drain();
    });
    await expect(runLoop(s.deps, { ...s.ctx, events })).rejects.toBe(failure);
    expect(s.releases).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it.each(["ordinary", "hard", "interrupted"])(
    "a typed unconfirmed opening ending retains the original workspace (%s)",
    async (mode) => {
      const opening =
        mode === "interrupted" ? new HarnessMismatchError("pi", "opencode") : new Error("original opening failure");
      const ending = new Error("local ending did not confirm");
      const s = endingIn(async (_deps, run) => {
        if (mode === "hard") run.control?.requestStop("hard");
        openToolCall(run);
        throw new HarnessEndingUnconfirmedError(run.runId, opening, ending);
      });
      if (mode === "interrupted") expect((await runLoop(s.deps, s.ctx)).kind).toBe("interrupted");
      else await expect(runLoop(s.deps, s.ctx)).rejects.toBe(opening);
      expect(s.releases).toEqual([]);
      s.ending.drain(undefined);
      await s.writer.settled();
    },
  );

  it("a settled original producer ending retains the existing release path", async () => {
    const s = endingIn(async () => sessionAnswering("done"));
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("done");
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["paired"]);
  });

  it.each(["saved", "unavailable", "hard", "release-lost", "store-secret", "release-secret"] as const)(
    "settles an unconfirmed first publication before sealing: %s",
    async (mode) => {
      const base = "a".repeat(40),
        source = "b".repeat(40),
        digest = "c".repeat(64),
        branch = "unit-work";
      const token = `ghp_${"z".repeat(24)}`;
      const signature = "signed-url-secret";
      const sensitiveReason = `${token} https://store.example/object?X-Amz-Signature=${signature}`;
      const receipts: PublicationSettlement[] = [];
      let committed = false;
      let released = false;
      const store = Object.assign(new InMemoryArtifactStore(), {
        head: async () => ({ size: 7, contentType: "application/octet-stream" }),
      });
      if (mode === "store-secret")
        store.presignPut = async () => {
          throw new Error(sensitiveReason);
        };
      const s = endingIn(
        async (_deps, run) => {
          if (mode === "hard") run.control?.requestStop("hard");
          throw new Error("unclassified model ending");
        },
        {
          coding: true,
          coordinator: WIP_COORDINATOR,
          repoCtx: { repo: "o/r", ref: branch, baseRef: "main" } as RepoContext,
          binding: { ref: branch, sha: base, workspace: "/srv/wt/u1" },
          ...(mode !== "unavailable" && mode !== "hard" ? { artifacts: store } : {}),
          executor: {
            exec: async (cmd: string) => {
              if (cmd.includes("symbolic-ref") || cmd.includes("rev-parse --abbrev-ref")) return branch;
              if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse 'refs/heads/"))
                return committed ? source : base;
              if (cmd.includes("status --porcelain")) return committed ? "" : " M tracked.ts\n?? new.test.ts";
              if (cmd.includes("rev-list")) return committed ? "1" : "0";
              if (cmd.includes("ls-remote")) return `${base}\trefs/heads/${branch}`;
              if (cmd.includes(" commit ")) {
                committed = true;
                return "";
              }
              if (cmd.includes(" bundle list-heads ")) return `${source} refs/heads/${branch}`;
              if (cmd.startsWith("sed -n")) return `# v2 git bundle\n-${base} base\n${source} refs/heads/${branch}\n\n`;
              if (cmd.startsWith("wc -c")) return "7";
              if (cmd.startsWith("sha256sum")) return `${digest}  checkpoint.bundle`;
              if (cmd.includes(" push ")) {
                expect(receipts.at(-1)).toMatchObject({
                  checkpoint: { kind: "created", head: source },
                  publication: { kind: "pending" },
                });
                return "exit 128: remote: not found";
              }
              return "";
            },
          },
        },
      );
      const ledgerRun = new NullLedgerRun("run-l", { put: (value) => s.store.put(value), abandoned: () => {} });
      ledgerRun.tracked = () => true;
      ledgerRun.setStateAndFlush = async (state) => {
        if (state.publicationSettlement)
          receipts.push(structuredClone(state.publicationSettlement) as PublicationSettlement);
        return true;
      };
      const round = {
        ...s.ctx.round,
        release: async () => {
          expect(receipts.at(-1)?.release.kind).toBe("pending");
          released = true;
          if (mode === "release-lost") throw new Error("release response lost");
          if (mode === "release-secret") return { released: false, reason: sensitiveReason };
          return { released: true, leftBehind: { uncommittedChanges: 0, unpushedCommits: 1 } };
        },
      };
      await expect(runLoop(s.deps, { ...s.ctx, ledgerRun, round })).rejects.toThrow("unclassified model ending");
      s.ending.drain(undefined);
      await s.writer.settled();
      const record = (await s.store.get("run-l"))!;
      expect(record.publicationSettlement).toMatchObject({
        checkpoint: { kind: "created", head: source },
        publication: { kind: "unknown" },
      });
      expect(record.publicationSettlement?.release.kind).toBe(
        ["unavailable", "store-secret"].includes(mode)
          ? "kept"
          : ["release-lost", "release-secret"].includes(mode)
            ? "unknown"
            : "released",
      );
      expect(released).toBe(!["unavailable", "store-secret"].includes(mode));
      const serialized = JSON.stringify({ receipts, record });
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(signature);
      expect(record.pushed).toBeUndefined();
      expect(record.headSha).toBe(source);
    },
  );

  it("serializes every streamed event behind durable tool projection and still publishes a tool event when projection fails", async () => {
    const s = endingIn(async (_deps, run) => {
      run.onEvent?.({ type: "tool_call", tool: "bash", summary: "$ true", callId: "ordered" });
      run.onEvent?.({ type: "assistant", text: "between the call and result" });
      run.onEvent?.({ type: "tool_result", tool: "bash", ok: true, summary: "exit 0", callId: "ordered" });
      return sessionAnswering("done");
    });
    expect(
      s.registry.commitLiveState("run-l", {
        ok: true,
        liveState: { state: "working", since: NOW, bound: NOW + 60_000, detail: "model turn" },
        liveStateSeq: 0,
      }),
    ).toBe(true);
    const ledgerRun = new NullLedgerRun("run-l", { put: async () => {}, abandoned: () => {} });
    ledgerRun.tracked = () => true;
    let sourceAssignments = 0;
    ledgerRun.assignLiveState = async (assignment) => {
      if (!assignment.sourceEvents?.length) return { ok: false, reason: "stale-sequence" };
      await new Promise((resolve) => setTimeout(resolve, 5));
      sourceAssignments++;
      if (sourceAssignments === 1) return { ok: false, reason: "stale-sequence" };
      return {
        ok: true,
        liveState: { state: "working", since: NOW, bound: assignment.bound!, detail: assignment.detail },
        liveStateSeq: assignment.sourceEvents.at(-1)!.seq,
      };
    };

    await runLoop(s.deps, { ...s.ctx, ledgerRun });

    expect(
      s.registry
        .snapshotById("run-l")!
        .events.filter(
          (event) =>
            (event.type === "tool_call" && event.callId === "ordered") ||
            (event.type === "tool_result" && event.callId === "ordered") ||
            (event.type === "assistant" && event.text === "between the call and result"),
        )
        .map((event) => event.type),
    ).toEqual(["tool_call", "assistant", "tool_result"]);
  });

  it("the tool the finale interrupted — the run ends with its wind-down's answer, the call open on the record until the session's end cuts it as pi's does: the workspace is released `always`, torn down, not paired behind the command still running, and the record says why", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      return sessionAnswering("the run ran out of time while a command was running", async () => cutOpenCallAtEnd(run));
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["torn-down"]);
    expect(await tornDownNotes(s, true)).toEqual([expect.stringContaining("$ sleep 600")]);
  });

  it("the tool pi's abort settled — its own end, aborted, on the record before the session ends: the workspace is torn down all the same, the aborted settle a cut and not a settle", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      abortOpenCall(run);
      return sessionAnswering("the run ran out of time while a command was running");
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["torn-down"]);
  });

  it("a clean completion with a relayed tool's call unpaired on the record — it ran in the bot, nothing in the workspace: the workspace is paired, released if idle, and nothing is said", async () => {
    const s = endingIn(async (_deps, run) => {
      openRelayedCall(run);
      return sessionAnswering("done");
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["paired"]);
    expect(await tornDownNotes(s, true)).toEqual([]);
  });

  it("a follow-up's steer unresolved with a command in flight: the failure propagates, the run is finished `failed`, the workspace is torn down and the record says why", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      throw new Error("the follow-up's steer was in flight when the resident's control plane reset under the run");
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the follow-up's steer");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["torn-down"]);
    expect(await tornDownNotes(s, undefined)).toEqual([expect.stringContaining("$ sleep 600")]);
  });

  it("a server gone silent with a call open: the failure propagates and the workspace is torn down", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      throw new Error("the feed carried nothing for the session past the bound");
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("carried nothing");
    expect(s.releases).toEqual(["torn-down"]);
  });

  it("the opening prompt unresolved — nothing in flight: the run fails by name and the workspace is paired, released if idle", async () => {
    const s = endingIn(async () => {
      throw new Error("the prompt was in flight when the resident's control plane reset under the run");
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the prompt was in flight");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["paired"]);
  });

  it("a gate bypass — the call already settled on the record, nothing in flight: the workspace is torn down all the same, what ran in it never vetted", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      settleToolCall(run);
      throw new HarnessGateBypassedError("the gate was bypassed: bash (call c-open) ran without asking the bot");
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the gate was bypassed");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["torn-down"]);
  });

  // The record the release reads is the registry's bounded backlog, which drops
  // its oldest events past the bound (runRegistry/backlog.ts): on a long run the
  // line of the command that hung early is gone by the end, its cut result not.
  it("a long run whose hung command's line the backlog evicted before the end — its cut result the only trace: the workspace is torn down all the same, the note naming the call by its tool and id", async () => {
    const s = endingIn(
      async (_deps, run) => {
        openToolCall(run);
        for (let i = 0; i < 40; i++) run.onEvent?.({ type: "assistant", text: `narration ${i}` });
        return sessionAnswering("the run ran out of time while a command was running", async () =>
          cutOpenCallAtEnd(run),
        );
      },
      { backlogLimit: 24 },
    );
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(s.registry.snapshot("run-l", "tok")!.events.some((e) => e.type === "tool_call")).toBe(false);
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["torn-down"]);
    expect(await tornDownNotes(s, true)).toEqual([expect.stringContaining("bash (call c-open)")]);
  });

  // What the ending left running is read once, when the harness session ends,
  // under the run's status at that moment — the ending's. A throw after a clean
  // end (the answer's publish here; nothing between the end and the try's close
  // may throw by design, and each such site is the same window) fails the run,
  // but does not re-read the record under `failed`.
  const answerPublishThrows = (s: ReturnType<typeof setup>): void => {
    const publish = s.ctx.publishText;
    s.ctx.publishText = (type, text) => {
      if (type === "answer") throw new Error("the answer's publish failed");
      publish(type, text);
    };
  };

  it("a throw after a clean harness end — a relayed tool's call unpaired on the record: the in-flight read stands as taken at the end, so the failed run's workspace is still paired and nothing claims a command may be running", async () => {
    const s = endingIn(async (_deps, run) => {
      openRelayedCall(run);
      return sessionAnswering("done");
    });
    answerPublishThrows(s);
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the answer's publish failed");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["paired"]);
    expect(await tornDownNotes(s, undefined)).toEqual([]);
  });

  it("a throw after a clean harness end that cut a call: the workspace is torn down and the record says why once, not once per read", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      return sessionAnswering("the run ran out of time while a command was running", async () => cutOpenCallAtEnd(run));
    });
    answerPublishThrows(s);
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the answer's publish failed");
    expect(s.releases).toEqual(["torn-down"]);
    expect(await tornDownNotes(s, undefined)).toEqual([expect.stringContaining("$ sleep 600")]);
  });

  // A session whose `end()` throws is not a clean end: pi may still be running
  // with its command, since the end failed before it could kill anything. The
  // read is taken all the same, under `failed` — the end's failure is the run's.
  it("a harness session whose end() throws with a call open — the end failed before it could cut or kill: the run fails on the end's error, the record is still read, under `failed`, and the workspace is retained with an unconfirmed ending", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      return sessionAnswering("done", async () => {
        throw new Error("the session's end failed: the transport would not close");
      });
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the session's end failed");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual([]);
    expect(await tornDownNotes(s, undefined)).toEqual([]);
  });

  // The loop's own failure with a live session — a re-review turn on the run's
  // session that the resident's reset cut — then a session whose end() throws
  // too: the release still runs and the loop's error is the one that propagates.
  it("the loop throws with a live session and the session's end() throws too in the catch: the workspace is retained for the unconfirmed ending, and the loop's own error is what propagates and what the record says", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const NEW = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
    const list = (subjects: string[]): PrCommitList => ({
      commits: subjects.map((message, i) => ({ sha: `${i + 1}`.repeat(40), message })),
      files: ["src/x.ts"],
      filesTruncated: false,
    });
    const s = endingIn(
      async (_deps, run) => {
        openToolCall(run);
        return sessionAnswering(
          "First review: fine.",
          async () => {
            throw new Error("the session's end failed: the transport would not close");
          },
          async () => {
            throw new Error(
              "the re-review's steer was in flight when the resident's control plane reset under the run",
            );
          },
        );
      },
      {
        agent: "review",
        yaml: YAML + "harness:\n  review: pi\n",
        // The workspace's head is the reviewed one, so the settle reads the PR's move and re-reviews on the session.
        executor: (() => {
          let head = HEAD;
          return {
            exec: async () => head,
            execResult: async () => ({ exitCode: 0, stdout: head + "\n", stderr: "", truncated: false }),
            moveTo: async (sha: string) => {
              head = sha;
              return { sha };
            },
          };
        })(),
        repoCtx: { repo: "o/r", pr: 42, baseRef: "main" } as RepoContext,
        review: {
          head: HEAD,
          post: async () => ({ state: "accepted" as const }),
          currentHead: NEW,
          commits: (sha) =>
            sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"]),
        },
      },
    );
    await expect(runLoop(s.deps, await trackedReviewContext(s))).rejects.toThrow("the re-review's steer was in flight");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "run_note" && e.kind === "run_failed")).toEqual([
      expect.objectContaining({ summary: expect.stringContaining("the re-review's steer was in flight") }),
    ]);
    // The end's own failure is on the record too, as the harness's error — not the run's.
    expect(
      rec.events
        .filter((e) => e.type === "run_note" && e.kind === "harness_error")
        .map((e) => (e.type === "run_note" ? e.summary : "")),
    ).toEqual([expect.stringContaining("the harness session's end failed after the loop's own error")]);
  });

  // An interruption from a post-turn (the container replaced under the run, a
  // row of another harness) followed by an end that throws: the run's status is
  // the interruption's, and the card must say so too — a ❌ card over an
  // `interrupted` status and a restart would contradict itself.
  it("an interrupted run whose session's end() throws stays interrupted: the status, the card and the outcome agree on the restart, and the workspace is retained for the unconfirmed ending", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const NEW = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
    const list = (subjects: string[]): PrCommitList => ({
      commits: subjects.map((message, i) => ({ sha: `${i + 1}`.repeat(40), message })),
      files: ["src/x.ts"],
      filesTruncated: false,
    });
    const s = endingIn(
      async (_deps, run) => {
        openToolCall(run);
        return sessionAnswering(
          "First review: fine.",
          async () => {
            throw new Error("the session's end failed: the transport would not close");
          },
          async () => {
            throw new HarnessMismatchError("pi", "opencode");
          },
        );
      },
      {
        agent: "review",
        yaml: YAML + "harness:\n  review: pi\n",
        executor: (() => {
          let head = HEAD;
          return {
            exec: async () => head,
            execResult: async () => ({ exitCode: 0, stdout: head + "\n", stderr: "", truncated: false }),
            moveTo: async (sha: string) => {
              head = sha;
              return { sha };
            },
          };
        })(),
        repoCtx: { repo: "o/r", pr: 42, baseRef: "main" } as RepoContext,
        review: {
          head: HEAD,
          post: async () => ({ state: "accepted" as const }),
          currentHead: NEW,
          commits: (sha) =>
            sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"]),
        },
      },
    );
    const out = await runLoop(s.deps, await trackedReviewContext(s));
    expect(out.kind).toBe("interrupted");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "interrupted" });
    expect(s.releases).toEqual([]);
    expect(s.closes).toHaveLength(1);
    const close = JSON.stringify(s.closes[0]);
    expect(close).toContain("🔁");
    expect(close).not.toContain("❌");
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.status).toBe("interrupted");
    expect(rec.events.filter((e) => e.type === "run_note" && e.kind === "run_failed")).toEqual([]);
  });

  // docs/reference/specs/run-history.md item 15: a failed run carries its reason
  // on the record itself, even when the reply is never delivered.
  it("a failed run leaves its reason on the record: the loop's throw is published as a `run_failed` run_note before the finish, so the run page says why", async () => {
    const s = setup(new Error("harness container: read failed — runtime-replaced"));
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow(UNKNOWN_MODEL_TERMINAL_MESSAGE);
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.status).toBe("failed");
    expect(rec.events.filter((e) => e.type === "run_note" && e.kind === "run_failed")).toEqual([
      expect.objectContaining({ summary: expect.stringContaining(UNKNOWN_MODEL_TERMINAL_MESSAGE) }),
    ]);
  });

  // docs/reference/specs/run-history.md item 57: the failure by name. The
  // provider's refusal reaches the loop as the harness's typed error, and the
  // record says so, so the session's next seed can leave the request out.
  it("a run whose model call the provider refused under its usage policy fails by name: the error is the refusal, the record says failure: policy_refusal beside status failed and the note keeps only the rendered cause; a run failed for any other reason carries no failure key", async () => {
    const refusing: Provider = {
      name: "fake",
      async complete() {
        return { content: [{ type: "text", text: "blocked by the provider's classifier" }], stopReason: "refusal" };
      },
    };
    const s = setup("unused", { provider: refusing });
    const err = await runLoop(s.deps, s.ctx).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ModelPolicyRefusedError);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec).toMatchObject({ status: "failed", failure: { kind: "policy_refusal" } });
    expect(rec.events.filter((e) => e.type === "run_note" && e.kind === "policy_refusal")).toEqual([
      expect.objectContaining({
        summary: "The model provider refused the call; the request ended without exposing the provider's response.",
      }),
    ]);

    const down = setup(new Error("provider down"));
    await expect(runLoop(down.deps, down.ctx)).rejects.toThrow(UNKNOWN_MODEL_TERMINAL_MESSAGE);
    down.ending.drain(undefined);
    await down.writer.settled();
    expect("failure" in (await down.store.get("run-l"))!).toBe(false);
  });

  // docs/reference/specs/run-history.md item 57 and agent-ship.md item 9: a
  // provider transient past the harness's retry ladder is the failure by name,
  // so a coordinator reading the child's record can re-run the round (issue 1932).
  it("a run whose model call spent the transport retry budget fails by name: the record says failure: provider_transient", async () => {
    const s = setup("", {
      agent: "coding",
      harness: {
        harnesses: roster({
          ...watched(piHarness).harness,
          open: async () => {
            throw new ModelTransientFailureError(
              "the model provider did not complete the call before the run's retry budget ended",
            );
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      bearer: "sbr_run-l.s3cret",
    });
    await expect(runLoop(s.deps, await trackedCodingContext(s))).rejects.toThrow("retry budget ended");
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!).toMatchObject({ status: "failed", failure: { kind: "provider_transient" } });
  });

  it("an exhausted local stream records model_stream_incomplete without claiming a provider failure", async () => {
    const s = setup("", {
      agent: "coding",
      harness: {
        harnesses: roster({
          ...watched(piHarness).harness,
          open: async () => {
            throw new ModelStreamIncompleteError();
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      bearer: "sbr_run-l.s3cret",
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("stream ended before a complete answer");
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!).toMatchObject({
      status: "failed",
      failure: { kind: "model_stream_incomplete" },
    });
  });

  it("a coding child whose transport retry budget is exhausted commits and pushes its interrupted workspace before teardown", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "unit-work";
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coordinator: WIP_COORDINATOR,
      harness: {
        harnesses: roster({
          ...watched(piHarness).harness,
          open: async () => {
            throw new ModelTransientFailureError(
              "the model provider did not complete the call before the run's retry budget ended",
            );
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/status --porcelain/.test(cmd)) return " M src/work.ts\n";
          if (/rev-list --count/.test(cmd)) return "0\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      },
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("retry budget ended");
    expect(commands).toContain("git -C '/srv/wt/u1' add -A");
    expect(commands).toContain(`git -C '/srv/wt/u1' push origin '${HEAD}:refs/heads/${BRANCH}'`);
    expect(s.releases).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
    expect(rec.events).toContainEqual(
      expect.objectContaining({ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "salvage" }),
    );
    expect(rec.events).not.toContainEqual(expect.objectContaining({ type: "run_note", kind: "work_left_behind" }));
  });

  it.each([
    { target: "ordinary branch", adopted: false, latest: "push" },
    { target: "existing PR", adopted: true, latest: "push" },
    { target: "ordinary branch", adopted: false, latest: "checkpoint" },
    { target: "existing PR", adopted: true, latest: "checkpoint" },
  ])(
    "reports the latest accepted head after compaction on $target with a later $latest",
    async ({ adopted, latest }) => {
      const base = "0".repeat(40);
      const first = "a".repeat(40);
      const last = "b".repeat(40);
      const ref = "fix/compaction";
      const report = "Changed the allowlist. Scoped test failed; full check skipped.";
      const publication = {
        repo: "o/r",
        pr: 7,
        headRef: ref,
        baseRef: "main",
        expectedHeadSha: base,
        publicationRef: ref,
        owner: { instanceId: "coord-p", unit: "U12" },
      };
      const bindings = new GitBindings();
      bindings.register(
        "run-l",
        { repo: "o/r", ref },
        { repo: "o/r", ref: `refs/heads/${ref}`, refConfirmed: true },
        async () => true,
        adopted,
      );
      const inner = new InMemoryRunLedger(() => NOW);
      const ledger = createLedgerWriteThrough({
        ledger: inner,
        gen: "gen-T",
        fallback: { put: async () => {}, abandoned: () => {} },
        warn: () => {},
      });
      const tracked = await ledger.open({
        runId: "run-l",
        threadKey: THREAD,
        startedAt: NOW,
        meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
        card: null,
        system: "test",
        tools: [],
        seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
      });
      if (tracked.kind !== "tracked") throw new Error("untracked test");
      let local = base,
        remote = base,
        dirty = false;
      const push = async () => {
        const update = { ref: `refs/heads/${ref}`, old: remote, next: local };
        const claim = adopted
          ? await bindings.beginPublication("run-l", update)
          : await bindings.beginBranch("run-l", update);
        expect(claim).toBeDefined();
        expect(await claim!.finish("accepted")).toBe(true);
        remote = local;
      };
      const s = endingIn(
        async (_deps, run) => {
          expect(run.onCompactionFailed).toBeDefined();
          for (const head of [first, last]) {
            local = head;
            const checkpoint = (head === last) === (latest === "checkpoint");
            if (checkpoint) {
              dirty = true;
              await run.onCompactionFailed!("the provider refused the summary");
            } else await push();
          }
          return sessionAnswering(report);
        },
        {
          coding: true,
          repoCtx: { repo: "o/r", ref, baseRef: "main", ...(adopted ? { pr: 7, headSha: base } : {}) },
          binding: { ref, sha: base, workspace: "/srv/wt/compaction" },
          coordinator: {
            parentInstanceId: "coord-p",
            idempotencyKey: "coord-p:U12/1/findings",
            base: "main",
            ...(adopted ? { publication } : {}),
          },
          executor: {
            publishBranch: async () => {
              await push();
              return "To https://git.bot.test/git/o/r";
            },
            exec: async (command) => {
              if (/rev-parse --abbrev-ref HEAD|symbolic-ref --quiet --short HEAD/.test(command)) return ref;
              if (/rev-parse HEAD/.test(command)) return local;
              if (/rev-parse @\{u\}/.test(command)) return remote;
              if (/ls-remote/.test(command)) return `${remote}\trefs/heads/${ref}`;
              if (/remote get-url origin/.test(command)) return "https://github.com/o/r.git";
              if (/status --porcelain/.test(command)) return dirty ? " M src/work.ts\n" : "";
              if (/rev-list --count/.test(command)) return local === remote ? "0" : "1";
              if (/git(?: -C '[^']+')? commit /.test(command)) dirty = false;
              if (/git(?: -C '[^']+')? push /.test(command)) await push();
              return "";
            },
          },
        },
      );
      s.deps.githubBindings = bindings;
      const bearers = new RunBearerStore({ clock: () => NOW });
      s.deps.runBearers = bearers;
      mintFor(bearers, s);
      s.deps.fetchPrFacts = async () => ({
        state: "open",
        sameRepoHead: true,
        headBranchExists: true,
        headRef: ref,
        baseRef: "main",
        headSha: remote,
        verifiedHead: { repo: "o/r", ref, sha: remote },
      });
      s.deps.findOpenPrByHead = async () => ({ number: 7, htmlUrl: "https://github.com/o/r/pull/7" });
      const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: tracked.run }));
      expect(out.answer).toContain(`Published \`${ref}\` at \`${last}\``);
      expect(out.answer).not.toContain(first);
      expect(out.answer).toContain(report);
      expect(out.answer).toContain("PR updated by the push: https://github.com/o/r/pull/7");
      expect(s.published).toContain(`answer:${out.answer}`);
      await deliverAnswer({ ...s.ctx, ...out, liveUrl: undefined, stopped: undefined });
      expect(s.replies).toHaveLength(1);
      expect(s.replies[0]).toContain(out.answer);
      s.ending.drain(true);
      await s.writer.settled();
      const record = inner.finished.get("run-l")!;
      expect(record.events).toContainEqual(expect.objectContaining({ type: "answer", text: out.answer }));
      expect(record.headSha).toBe(last);
      expect(record.pushed).toEqual([{ ref, sha: last, by: latest === "push" ? "push" : "salvage" }]);
    },
  );

  it("deployment publication smoke carries native updates through durable recording into original-head adoption", async () => {
    const base = "0".repeat(40),
      first = "a".repeat(40),
      final = "b".repeat(40);
    const branch = "smoke/publication";
    const instanceId = "smoke-native";
    const key = `${instanceId}:publication/0/coding`;
    const bindings = new GitBindings();
    expect(
      bindings.register(
        "run-l",
        { repo: "o/r", ref: branch },
        { repo: "o/r", ref: branch, refConfirmed: true },
        async () => true,
      ),
    ).toBe(true);
    let local = base,
      remote = base,
      dirty = false;
    const nativePush = async () => {
      const claim = await bindings.beginBranch("run-l", { ref: `refs/heads/${branch}`, old: remote, next: local });
      expect(claim).toBeDefined();
      expect(await claim!.finish("accepted")).toBe(true);
      remote = local;
    };
    const s = endingIn(
      async (_deps, run) => {
        local = first;
        await nativePush();
        dirty = true;
        run.control?.requestStop("hard");
        return sessionAnswering("Stopped after the recorded publication.");
      },
      {
        coding: true,
        repoCtx: { repo: "o/r", ref: branch, baseRef: "main" },
        binding: { ref: branch, sha: base, workspace: "/srv/wt/smoke" },
        coordinator: { parentInstanceId: instanceId, idempotencyKey: key, base: "main" },
        executor: {
          publishBranch: async () => {
            await nativePush();
            return "To https://git.bot.test/git/o/r";
          },
          exec: async (command) => {
            if (/rev-parse --abbrev-ref HEAD|symbolic-ref --quiet --short HEAD/.test(command)) return branch;
            if (/rev-parse HEAD/.test(command)) return local;
            if (/rev-parse @\{u\}/.test(command)) return remote;
            if (/ls-remote/.test(command)) return `${remote}\trefs/heads/${branch}`;
            if (/remote get-url origin/.test(command)) return "https://github.com/o/r.git";
            if (/status --porcelain/.test(command)) return dirty ? " M src/work.ts\n" : "";
            if (/rev-list --count/.test(command)) return local === remote ? "0" : "1";
            if (/git(?: -C '[^']+')? commit /.test(command)) {
              local = final;
              dirty = false;
            }
            if (/git(?: -C '[^']+')? push /.test(command)) await nativePush();
            return "";
          },
        },
      },
    );
    s.deps.githubBindings = bindings;
    const bearers = new RunBearerStore({ clock: () => NOW });
    s.deps.runBearers = bearers;
    mintFor(bearers, s);
    const ctx = await trackedCodingContext(s);
    const out = answered(await runLoop(s.deps, ctx));
    await deliverAnswer({ ...ctx, ...out, liveUrl: undefined, stopped: "hard" });
    s.ending.drain(undefined);
    await s.writer.settled();
    const sealed = (await s.store.get(s.run.id))!;
    const disk = new FileRunStore(mkdtempSync(join(tmpdir(), "smoke-publication-")), {
      now: () => sealed.finishedAt + 1,
    });
    expect(await disk.put(sealed)).toMatchObject({ ok: true, stored: true });
    const record = (await disk.get(s.run.id))!;
    expect(record.pr).toBeUndefined();
    expect(record.branchPushReceipts).toEqual([{ ref: branch, sha: final, by: "push" }]);
    expect(record.events.filter((event) => event.type === "pushed_head")).toEqual([
      expect.objectContaining({ ref: branch, sha: first, by: "push" }),
      expect.objectContaining({ ref: branch, sha: final, by: "push" }),
      expect.objectContaining({ ref: branch, sha: final, by: "salvage" }),
    ]);
    const run = { ...record, finished: true, persisted: true };
    const instance = {
      id: instanceId,
      repo: record.repo!,
      base: "main",
      userId: record.userId,
      threadKey: record.threadKey,
    };
    const row = {
      instanceId,
      unit: "publication",
      branch,
      startedAt: record.startedAt - 1,
      rounds: [{ index: 0, agent: "coding", outcome: "started", at: record.startedAt }],
      ending: { kind: "aborted", at: record.finishedAt + 1 },
    };
    expect(publishedHeadEvidence({ instance, row, run, runs: [run] })).toEqual({
      ok: true,
      head: final,
      runId: record.id,
    });
  });

  it("a coding child's final description turn checkpoints dirty work before release", async () => {
    const HEAD = "e1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "unit-work";
    const DESCRIPTION: PrDescription = {
      title: "fix(ship): preserve final-turn work",
      tldr: "Preserves work from the final description turn. The workspace can be released safely.",
      why: "The final turn can use workspace tools after the first completion checkpoint.",
      pointers: [
        { label: "Final checkpoint", text: "Runs after the last turn.", anchor: { path: "src/a", from: 1, to: 2 } },
      ],
      feedbackWanted: "The checkpoint placement.",
      verified: "Unit test.",
      decisions: [],
      risk: "none",
      validation: { criteria: [{ criterion: "final turn", proof: "green" }] },
    };
    let dirty = false;
    let unpushed = false;
    const checkpointHead = "c".repeat(40);
    let localHead = HEAD;
    let remoteHead = HEAD;
    const commands: string[] = [];
    const published: Array<Parameters<NonNullable<Executor["publishBranch"]>>[0]> = [];
    const bindings = new GitBindings();
    bindings.register("run-l", { repo: "o/r", ref: BRANCH }, undefined, async () => true);
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const tracked = await ledger.open({
      runId: "run-l",
      threadKey: THREAD,
      startedAt: NOW,
      meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
      card: null,
      system: "test",
      tools: [],
      seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
    });
    if (tracked.kind !== "tracked") throw new Error("untracked test");
    const finalTurn = watched(piHarness);
    finalTurn.harness.open = async () => {
      const claim = await bindings.beginBranch("run-l", {
        ref: `refs/heads/${BRANCH}`,
        old: "a".repeat(40),
        next: HEAD,
      });
      if (!claim || !(await claim.finish("accepted"))) throw new Error("initial accepted push was not recorded");
      return {
        answer: "the contract handoff is complete",
        followUp: async (turn) => {
          expect(turn.tools).toContain("bash");
          dirty = true;
          turn.toolContext.onPrDescription?.(DESCRIPTION);
          return "description submitted";
        },
        remainingMs: () => 20 * 60_000,
        end: async () => {},
      };
    };
    const s = setup("unused", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", ref: BRANCH, baseRef: "main" } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coordinator: WIP_COORDINATOR,
      harness: {
        harnesses: roster(finalTurn.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD|symbolic-ref --quiet --short HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${localHead}\n`;
          if (/rev-parse @\{u\}/.test(cmd)) return `${HEAD}\n`;
          if (/ls-remote --exit-code origin/.test(cmd)) return `${remoteHead}\trefs/heads/${BRANCH}\n`;
          if (/remote get-url origin/.test(cmd)) return "https://github.com/o/r.git";
          if (/status --porcelain/.test(cmd)) return dirty ? " M src/work.ts\n" : "";
          if (/rev-list --count/.test(cmd)) return unpushed ? "1\n" : "0\n";
          if (/git(?: -C '[^']+')? commit -m/.test(cmd)) {
            dirty = false;
            unpushed = true;
            localHead = checkpointHead;
            return "";
          }
          return "";
        },
        publishBranch: async (args: Parameters<NonNullable<Executor["publishBranch"]>>[0]) => {
          published.push(args);
          const claim = await bindings.beginBranch("run-l", {
            ref: `refs/heads/${BRANCH}`,
            old: args.old ?? "",
            next: args.next,
          });
          if (!claim || !(await claim.finish("accepted"))) throw new Error("checkpoint push was not recorded");
          unpushed = false;
          remoteHead = args.next;
          return "To https://git.bot.test/git/o/r";
        },
      },
    });
    s.deps.githubBindings = bindings;
    const bearers = new RunBearerStore({ clock: () => NOW });
    s.deps.runBearers = bearers;
    mintFor(bearers, s);
    s.deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/o/r/pull/700" }));

    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: tracked.run }));
    expect(out.answer).toContain(`Published \`${BRANCH}\` at \`${checkpointHead}\``);
    expect(commands).toContain("git -C '/srv/wt/u1' add -A");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ repo: "o/r", branch: BRANCH, old: HEAD, next: checkpointHead });
    expect(out.prNote).toBeUndefined();
    expect(JSON.stringify(s.closes)).not.toContain("discarded at the run's end");
    await out.releaseWorkspace();
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = inner.finished.get("run-l");
    if (!rec) throw new Error("tracked record missing");
    expect(rec).toMatchObject({
      headSha: checkpointHead,
      pushed: [{ ref: BRANCH, sha: checkpointHead, by: "salvage" }],
    });
    expect(rec.events).not.toContainEqual(expect.objectContaining({ type: "run_note", kind: "work_left_behind" }));
  });

  it("a coding child that ends with an unpushed commit checkpoints it before release and its card never says discarded", async () => {
    const HEAD = "d1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "unit-work";
    const commands: string[] = [];
    const s = setup("the contract handoff is complete", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coordinator: WIP_COORDINATOR,
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/status --porcelain/.test(cmd)) return "";
          if (/rev-list --count/.test(cmd)) return "1\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return "";
          return "";
        },
      },
    });

    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toContain(`Published \`${BRANCH}\` at \`${HEAD}\``);
    expect(commands).toContain(`git -C '/srv/wt/u1' push origin '${HEAD}:refs/heads/${BRANCH}'`);
    expect(commands.some((cmd) => /^git(?: -C '[^']+')? commit --allow-empty/.test(cmd))).toBe(false);
    expect(JSON.stringify(s.closes)).not.toContain("discarded at the run's end");
    await out.releaseWorkspace();
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
    expect(rec.events).not.toContainEqual(expect.objectContaining({ type: "run_note", kind: "work_left_behind" }));
  });

  it("gives an existing-PR writer the verified adoption receipt and does not invent a push from its clean checkout", async () => {
    const head = "a".repeat(40);
    const ref = "dependabot/deps";
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: ref,
      baseRef: "main",
      expectedHeadSha: head,
      publicationRef: ref,
      owner: { instanceId: "coord-p", unit: "U12" },
    };
    let system = "";
    const s = endingIn(
      async (_deps, run) => {
        system = run.system;
        return sessionAnswering("Stopped before edits.");
      },
      {
        coding: true,
        repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: head },
        binding: { ref, sha: head, workspace: "/srv/wt/existing" },
        coordinator: {
          parentInstanceId: "coord-p",
          idempotencyKey: "coord-p:U12/0/coding",
          base: "main",
          publication,
        },
        executor: {
          exec: async (cmd) => {
            if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse @{u}")) return head;
            if (cmd.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
            if (cmd.includes("rev-list --count")) return "0";
            return "";
          },
        },
      },
    );
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: ref,
      baseRef: "main",
      headSha: head,
      verifiedHead: { repo: "o/r", ref, sha: head },
    });
    const findOpenPr = vi.fn(async () => ({ number: 7, htmlUrl: "https://github.com/o/r/pull/7" }));
    const updatePr = vi.fn(async () => {});
    s.deps.findOpenPrByHead = findOpenPr;
    s.deps.updatePullRequest = updatePr;
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(system).toContain(`trusted adoption receipt for this run`);
    expect(system).toContain(`o/r#7, head ref ${ref}, base ref main, expected full head ${head}`);
    expect(out.prNote).toBeUndefined();
    expect(findOpenPr).not.toHaveBeenCalled();
    expect(updatePr).not.toHaveBeenCalled();
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.some((e) => e.type === "pushed_head" || e.type === "pr_opened")).toBe(false);
  });

  it("keeps an existing PR unchanged when its writer submits a description without pushing", async () => {
    const head = "a".repeat(40);
    const ref = "dependabot/deps";
    const description: PrDescription = {
      title: "fix(dispatcher): describe the existing PR",
      tldr: "The description alone does not prove source changes.",
      why: "The writer stopped before pushing.",
      pointers: [],
      feedbackWanted: "Check the source change.",
      verified: "None yet.",
      decisions: [],
      risk: "none",
      validation: { criteria: [] },
    };
    const s = endingIn(
      async (_deps, run) => {
        run.toolContext.onPrDescription?.(description);
        return sessionAnswering("Stopped before edits.");
      },
      {
        coding: true,
        repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: head },
        binding: { ref, sha: head, workspace: "/srv/wt/existing" },
        coordinator: {
          parentInstanceId: "coord-p",
          idempotencyKey: "coord-p:U12/0/coding",
          base: "main",
          publication: {
            repo: "o/r",
            pr: 7,
            headRef: ref,
            baseRef: "main",
            expectedHeadSha: head,
            publicationRef: ref,
            owner: { instanceId: "coord-p", unit: "U12" },
          },
        },
        executor: {
          exec: async (cmd) => {
            if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse @{u}")) return head;
            if (cmd.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
            if (cmd.includes("rev-list --count")) return "0";
            return "";
          },
        },
      },
    );
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: ref,
      baseRef: "main",
      headSha: head,
      verifiedHead: { repo: "o/r", ref, sha: head },
    });
    const findOpenPr = vi.fn(async () => ({ number: 7, htmlUrl: "https://github.com/o/r/pull/7" }));
    const updatePr = vi.fn(async () => {});
    const openPr = vi.fn(async () => ({ number: 7, htmlUrl: "https://github.com/o/r/pull/7", created: false }));
    s.deps.findOpenPrByHead = findOpenPr;
    s.deps.updatePullRequest = updatePr;
    s.deps.openPullRequest = openPr;
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toContain("no accepted push");
    expect(out.prNote).toBeUndefined();
    expect(findOpenPr).not.toHaveBeenCalled();
    expect(updatePr).not.toHaveBeenCalled();
    expect(openPr).not.toHaveBeenCalled();
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.some((e) => e.type === "pushed_head" || e.type === "pr_opened")).toBe(false);
  });

  it.each(["both", "inspection only", "publication only", "neither"])(
    "serves the runner-owned publication effect only with both typed capabilities: %s",
    async (capabilities) => {
      const bindings = new GitBindings();
      bindings.register("run-l", { repo: "o/r", ref: "refs/heads/fix/owned" }, undefined, async () => true);
      const bearers = new RunBearerStore({ clock: () => NOW });
      const s = endingIn(
        async (_deps, run) => {
          expect(!!run.tools.find((tool) => tool.name === "publish_branch")).toBe(capabilities === "both");
          expect(run.rules.noShellPush).toBe(true);
          return sessionAnswering("done");
        },
        {
          repoCtx: { repo: "o/r", baseRef: "main" },
          executor: {
            publishBranch: async () => "",
            ...(capabilities === "both" || capabilities === "inspection only"
              ? { execResult: async () => ({ stdout: "", stderr: "", exitCode: 0, truncated: false }) }
              : {}),
            ...(capabilities === "both" || capabilities === "publication only"
              ? { publishBranchResult: async () => ({ stdout: "", stderr: "", exitCode: 0, truncated: false }) }
              : {}),
          },
        },
      );
      s.deps.githubBindings = bindings;
      s.deps.runBearers = bearers;
      const bearer = mintFor(bearers, s);
      answered(await runLoop(s.deps, { ...s.ctx, bearer }));
      s.ending.drain(undefined);
      await s.writer.settled();
    },
  );

  it("binds a precreated Ship branch publication to the fetched workspace head", async () => {
    const branch = "plan/p/u1";
    const initial = "a".repeat(40);
    const next = "b".repeat(40);
    const updates: Array<{ old?: string; next: string }> = [];
    const bindings = new GitBindings();
    bindings.register("run-l", { repo: "o/r", ref: `refs/heads/${branch}` }, undefined, async () => true);
    const bearers = new RunBearerStore({ clock: () => NOW });
    const s = endingIn(
      async (_deps, run) => {
        const tool = run.tools.find((candidate) => candidate.name === "publish_branch");
        expect(tool).toBeDefined();
        await tool!.run({ branch }, { ...run.toolContext, callId: "publish-one" });
        return sessionAnswering("done");
      },
      {
        repoCtx: { repo: "o/r", ref: branch, baseRef: "main" },
        coordinator: { parentInstanceId: "p", idempotencyKey: "p:U12/0/coding", base: "main" },
        binding: { ref: branch, sha: initial, workspace: "/workspace/threads/t/wt" },
        executor: {
          exec: async () => "",
          execResult: async (command) => ({
            stdout:
              command.includes("symbolic-ref") || command.includes("check-ref-format")
                ? branch
                : command.includes("status")
                  ? ""
                  : command.includes("rev-parse")
                    ? next
                    : command.includes("remote get-url")
                      ? "https://git.bot.test/git/o/r.git"
                      : "",
            stderr: "",
            exitCode: 0,
            truncated: false,
          }),
          publishBranchResult: async (input) => {
            updates.push({ old: input.old, next: input.next });
            return { stdout: "", stderr: "known refusal", exitCode: 1, truncated: false };
          },
        },
      },
    );
    s.deps.githubBindings = bindings;
    s.deps.runBearers = bearers;
    const bearer = mintFor(bearers, s);
    answered(await runLoop(s.deps, { ...s.ctx, bearer }));
    expect(updates).toEqual([{ old: initial, next }]);
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it("leases the fetched head and selected path of an unseeded cold Ship clone", async () => {
    const branch = "plan/p/u1";
    const initial = "a".repeat(40);
    const next = "b".repeat(40);
    const commands: string[] = [];
    const updates: Array<{ old?: string; next: string }> = [];
    const bindings = new GitBindings();
    bindings.register("run-l", { repo: "o/r", ref: `refs/heads/${branch}` }, undefined, async () => true);
    const bearers = new RunBearerStore({ clock: () => NOW });
    const s = endingIn(
      async (_deps, run) => {
        const result = await run.tools
          .find((tool) => tool.name === "publish_branch")!
          .run({ branch }, { ...run.toolContext, callId: "cold-write" });
        expect(result).toContain("refused");
        return sessionAnswering("done");
      },
      {
        repoCtx: { repo: "o/r", ref: branch, baseRef: "main" },
        coordinator: { parentInstanceId: "p", idempotencyKey: "p:U12/0/coding", base: "main" },
        cold: { ref: branch, sha: initial, workspace: "/home/user/workspace/checkout" },
        executor: {
          exec: async () => "",
          execResult: async (command) => {
            commands.push(command);
            return {
              stdout:
                command.includes("symbolic-ref") || command.includes("check-ref-format")
                  ? branch
                  : command.includes("status")
                    ? ""
                    : command.includes("rev-parse")
                      ? next
                      : command.includes("remote get-url")
                        ? "https://git.bot.test/git/o/r.git"
                        : "",
              stderr: "",
              exitCode: 0,
              truncated: false,
            };
          },
          publishBranchResult: async (input) => {
            updates.push({ old: input.old, next: input.next });
            return { stdout: "", stderr: "known refusal", exitCode: 1, truncated: false };
          },
        },
      },
    );
    s.deps.githubBindings = bindings;
    s.deps.runBearers = bearers;
    const bearer = mintFor(bearers, s);
    answered(await runLoop(s.deps, { ...s.ctx, bearer }));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.startsWith("git -C '/home/user/workspace/checkout'"))).toBe(true);
    expect(updates).toEqual([{ old: initial, next }]);
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it("verifies a cold cloned checkout against a precreated PR before granting publication", async () => {
    const ref = "plan/p/u1";
    const head = "a".repeat(40);
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: ref,
      baseRef: "main",
      expectedHeadSha: head,
      publicationRef: ref,
      owner: { instanceId: "coord-p", unit: "U12" },
    };
    const s = endingIn(
      async (_deps, run) => {
        expect(run.rules.publication).toEqual({ authority: { ref, expectedHeadSha: head } });
        return sessionAnswering("done");
      },
      {
        repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: head },
        coordinator: { parentInstanceId: "coord-p", idempotencyKey: "coord-p:U12/0/coding", base: "main", publication },
        cold: { ref, sha: head, workspace: "/workspace/checkout" },
        executor: { exec: async () => "" },
      },
    );
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: ref,
      baseRef: "main",
      headSha: head,
      verifiedHead: { repo: "o/r", ref, sha: head },
    });
    answered(await runLoop(s.deps, s.ctx));
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it("refuses model-shell publication without opening a Door slot, including a literal owned push", async () => {
    const bindings = new GitBindings();
    const ref = "fix/owned";
    bindings.register("run-l", { repo: "o/r" }, undefined, async () => true);
    const s = endingIn(
      async (_deps, run) => {
        expect(bindings.toolPushIsRequired("run-l")).toBe(true);
        const harness: LiveHarness = {
          runId: run.runId,
          rules: { ...run.rules, identity: "write" },
          tools: [],
          toolContext: run.toolContext,
          admitPush: run.admitPush,
          emit: (e) => run.onEvent?.(e),
          gateSaw: () => {},
          toolSpan: () => undefined,
          toolsBlocked: () => undefined,
        };
        const spawn = `node -e 'require("child_process").execFileSync("git",process.argv.slice(1))' push origin ${ref}:${ref} & npm version patch`;
        expect(
          await authorizeToolCall(harness, { toolCallId: "spawn", tool: "bash", input: { command: spawn } }),
        ).toMatchObject({ allow: true });
        expect(bindings.hasToolPush("run-l")).toBe(false);
        // Scripts can run, but they never obtain a native publication slot,
        // including when they construct the executable and verb indirectly.
        const opaque = `node -e 'require("child_process").execFileSync(String.fromCharCode(103,105,116),["pu"+"sh","origin","${ref}:${ref}"])'`;
        expect(
          await authorizeToolCall(harness, { toolCallId: "opaque", tool: "bash", input: { command: opaque } }),
        ).toMatchObject({ allow: true });
        expect(bindings.hasToolPush("run-l")).toBe(false);
        for (const command of [`git push origin HEAD:${ref}`, `git push upstream ${ref}:main`])
          expect(
            await authorizeToolCall(harness, { toolCallId: "bad", tool: "bash", input: { command } }),
          ).toMatchObject({ allow: false });
        expect(
          await authorizeToolCall(harness, {
            toolCallId: "owned",
            tool: "bash",
            input: { command: `git push origin ${ref}:${ref}` },
          }),
        ).toMatchObject({ allow: false });
        expect(bindings.hasToolPush("run-l")).toBe(false);
        return sessionAnswering("done");
      },
      {
        repoCtx: { repo: "o/r", baseRef: "main" },
        executor: { exec: async () => "" },
      },
    );
    s.deps.githubBindings = bindings;
    answered(await runLoop(s.deps, s.ctx));
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it("commits a Git-door existing-PR intent before forwarding and its accepted head before reporting success", async () => {
    const old = "a".repeat(40);
    const head = "b".repeat(40);
    const ref = "fix/existing";
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: ref,
      baseRef: "main",
      expectedHeadSha: old,
      publicationRef: ref,
      owner: { instanceId: "coord-p", unit: "U12" },
    };
    const bindings = new GitBindings();
    expect(
      bindings.register(
        "run-l",
        { repo: "o/r", ref },
        { repo: "o/r", ref: `refs/heads/${ref}`, refConfirmed: true },
        async () => true,
        true,
      ),
    ).toBe(true);
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const opened = await ledger.open({
      runId: "run-l",
      threadKey: THREAD,
      startedAt: NOW,
      meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
      card: null,
      system: "test",
      tools: [],
      seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
    });
    if (opened.kind !== "tracked") throw new Error("untracked test");
    const working = { state: "working" as const, since: NOW, bound: NOW + 60_000 };
    const row = inner.live.get("run-l")!;
    row.liveState = working;
    row.liveStateSeq = 0;
    const s = endingIn(
      async () => {
        const update = { ref: `refs/heads/${ref}`, old, next: head };
        const claim = await bindings.beginPublication("run-l", update);
        expect(claim).toBeDefined();
        expect(inner.live.get("run-l")!.state.doorPublicationPending).toMatchObject({ update });
        expect(inner.live.get("run-l")!.state.publicationReceipts).toBeUndefined();
        expect(await claim!.finish("accepted")).toBe(true);
        expect(inner.live.get("run-l")!.state.doorPublicationPending).toBeNull();
        expect(inner.live.get("run-l")!.state.publicationReceipts).toContainEqual(
          expect.objectContaining({ type: "pushed_head", sha: head }),
        );
        return sessionAnswering("done");
      },
      {
        coding: true,
        repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: old },
        binding: { ref, sha: old, workspace: "/srv/wt/existing" },
        coordinator: {
          parentInstanceId: "coord-p",
          idempotencyKey: "coord-p:U12/1/findings",
          base: "main",
          publication,
        },
        executor: {
          exec: async (cmd) => {
            if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse @{u}")) return head;
            if (cmd.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
            return "";
          },
        },
      },
    );
    s.deps.githubBindings = bindings;
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: ref,
      baseRef: "main",
      headSha: old,
      verifiedHead: { repo: "o/r", ref, sha: old },
    });
    s.registry.commitLiveState("run-l", { ok: true, liveState: working, liveStateSeq: 0 });
    s.registry.subscribe("run-l", "tok", { onEvent: (event, seq) => opened.run.event(event, seq) });
    answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run }));
    await opened.run.close();
    expect(restoredPublicationHead(publicationReceiptsFromState(row.state.publicationReceipts), publication)).toBe(
      head,
    );
    s.ending.drain(undefined);
    await s.writer.settled();
  });

  it.each(["accepted", "unknown"] as const)(
    "keeps a forwarded Git-door %s outcome in the final record after the model ends",
    async (outcome) => {
      const old = "a".repeat(40);
      const head = "b".repeat(40);
      const ref = "fix/existing";
      const publication = {
        repo: "o/r",
        pr: 7,
        headRef: ref,
        baseRef: "main",
        expectedHeadSha: old,
        publicationRef: ref,
        owner: { instanceId: "coord-p", unit: "U12" },
      };
      const bindings = new GitBindings();
      expect(
        bindings.register(
          "run-l",
          { repo: "o/r", ref },
          { repo: "o/r", ref: `refs/heads/${ref}`, refConfirmed: true },
          async () => true,
          true,
        ),
      ).toBe(true);
      const inner = new InMemoryRunLedger(() => NOW);
      const ledger = createLedgerWriteThrough({
        ledger: inner,
        gen: "gen-T",
        fallback: { put: async () => {}, abandoned: () => {} },
        warn: () => {},
      });
      const opened = await ledger.open({
        runId: "run-l",
        threadKey: THREAD,
        startedAt: NOW,
        meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
        card: null,
        system: "test",
        tools: [],
        seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
      });
      if (opened.kind !== "tracked") throw new Error("untracked test");
      const working = { state: "working" as const, since: NOW, bound: NOW + 60_000 };
      inner.live.get("run-l")!.liveState = working;
      inner.live.get("run-l")!.liveStateSeq = 0;
      let claimReady!: (claim: GitPublicationClaim) => void;
      const claimed = new Promise<GitPublicationClaim>((resolve) => (claimReady = resolve));
      let waitEntered!: () => void;
      const waiting = new Promise<void>((resolve) => (waitEntered = resolve));
      const originalWait = bindings.waitForPublication.bind(bindings);
      vi.spyOn(bindings, "waitForPublication").mockImplementation(async (runId, timeoutMs) => {
        waitEntered();
        return originalWait(runId, timeoutMs);
      });
      const s = endingIn(
        async () => {
          const claim = await bindings.beginPublication("run-l", { ref: `refs/heads/${ref}`, old, next: head });
          expect(claim).toBeDefined();
          claimReady(claim!);
          return sessionAnswering("done");
        },
        {
          coding: true,
          repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: old },
          binding: { ref, sha: old, workspace: "/srv/wt/existing" },
          coordinator: {
            parentInstanceId: "coord-p",
            idempotencyKey: "coord-p:U12/1/findings",
            base: "main",
            publication,
          },
          executor: {
            exec: async (cmd) => {
              if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ref;
              if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse @{u}")) return old;
              if (cmd.includes("ls-remote")) return `${old}\trefs/heads/${ref}`;
              return "";
            },
          },
        },
      );
      s.deps.githubBindings = bindings;
      s.deps.fetchPrFacts = async () => ({
        state: "open",
        sameRepoHead: true,
        headBranchExists: true,
        headRef: ref,
        baseRef: "main",
        headSha: old,
        verifiedHead: { repo: "o/r", ref, sha: old },
      });
      s.registry.commitLiveState("run-l", { ok: true, liveState: working, liveStateSeq: 0 });
      s.registry.subscribe("run-l", "tok", { onEvent: (event, seq) => opened.run.event(event, seq) });
      const finishing = runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run });
      const claim = await claimed;
      await waiting;
      expect(inner.finished.has("run-l")).toBe(false);
      expect(await claim.finish(outcome)).toBe(outcome === "accepted");
      answered(await finishing);
      await opened.run.close();
      s.ending.drain(undefined);
      await s.writer.settled();
      expect(inner.live.has("run-l")).toBe(false);
      const record = inner.finished.get("run-l")!;
      if (outcome === "accepted") {
        expect(record.pushed).toContainEqual({ ref, sha: head, by: "push" });
        expect(record.doorPublicationPending).toBeUndefined();
      } else {
        expect(record.pushed ?? []).not.toContainEqual({ ref, sha: head, by: "push" });
        expect(record.doorPublicationPending).toMatchObject({
          repo: "o/r",
          pr: 7,
          owner: publication.owner,
          update: { ref: `refs/heads/${ref}`, old, next: head },
        });
        expect(record.events).toContainEqual(
          expect.objectContaining({ type: "run_note", kind: "publication_blocked" }),
        );
      }
    },
  );

  it.each(["accepted", "unknown", "settled-before-fence"] as const)(
    "keeps a forwarded branch Git-door %s outcome in the final record after the model ends",
    async (outcome) => {
      const old = "a".repeat(40);
      const head = "b".repeat(40);
      const ref = "unit-branch";
      const description: PrDescription = {
        title: "fix(core): retain the branch push outcome",
        tldr: "Keeps the unit PR unpublished until its push outcome is known.",
        why: "A model answer can arrive while Git is still forwarding a pack.",
        pointers: [
          { label: "Push result", text: "The durable intent remains.", anchor: { path: "src/a", from: 1, to: 2 } },
        ],
        feedbackWanted: "The run-seal fence.",
        risk: "A delayed PR until reconciliation.",
        verified: "Focused test.",
        decisions: [],
        validation: { criteria: [{ criterion: "pending push", proof: "PR unchanged" }] },
      };
      const bindings = new GitBindings();
      expect(
        bindings.register(
          "run-l",
          { repo: "o/r", ref },
          { repo: "o/r", ref: `refs/heads/${ref}`, refConfirmed: true },
          async () => true,
        ),
      ).toBe(true);
      const inner = new InMemoryRunLedger(() => NOW);
      const ledger = createLedgerWriteThrough({
        ledger: inner,
        gen: "gen-T",
        fallback: { put: async () => {}, abandoned: () => {} },
        warn: () => {},
      });
      const opened = await ledger.open({
        runId: "run-l",
        threadKey: THREAD,
        startedAt: NOW,
        meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
        card: null,
        system: "test",
        tools: [],
        seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
      });
      if (opened.kind !== "tracked") throw new Error("untracked test");
      const working = { state: "working" as const, since: NOW, bound: NOW + 60_000 };
      inner.live.get("run-l")!.liveState = working;
      inner.live.get("run-l")!.liveStateSeq = 0;
      let claimReady!: (claim: GitPublicationClaim) => void;
      const claimed = new Promise<GitPublicationClaim>((resolve) => (claimReady = resolve));
      let waitEntered!: () => void;
      const waiting = new Promise<void>((resolve) => (waitEntered = resolve));
      const originalWait = bindings.waitForPublication.bind(bindings);
      vi.spyOn(bindings, "waitForPublication").mockImplementation(async (runId, timeoutMs) => {
        waitEntered();
        return originalWait(runId, timeoutMs);
      });
      let forwardedClaim: GitPublicationClaim | undefined;
      let settledDuringObservation = false;
      const s = endingIn(
        async (_deps, run) => {
          run.toolContext.onPrDescription?.(description);
          const update = { ref: `refs/heads/${ref}`, old, next: head };
          const claim = await bindings.beginBranch("run-l", update);
          expect(claim).toBeDefined();
          expect(inner.live.get("run-l")!.state.doorPublicationPending).toMatchObject({ update });
          forwardedClaim = claim;
          claimReady(claim!);
          return sessionAnswering("done");
        },
        {
          coding: true,
          repoCtx: { repo: "o/r", ref },
          binding: { ref, sha: old, workspace: "/srv/wt/branch" },
          coordinator: { parentInstanceId: "coord-p", idempotencyKey: "coord-p:U12/1/coding", base: "main" },
          executor: {
            exec: async (cmd) => {
              if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ref;
              if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse @{u}")) return old;
              if (cmd.includes("ls-remote")) {
                if (outcome === "settled-before-fence" && forwardedClaim && !settledDuringObservation) {
                  settledDuringObservation = true;
                  expect(await forwardedClaim.finish("accepted")).toBe(true);
                }
                return `${old}\trefs/heads/${ref}`;
              }
              return "";
            },
          },
        },
      );
      s.deps.githubBindings = bindings;
      const open = vi.fn(async () => ({ number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true }));
      s.deps.openPullRequest = open;
      s.registry.commitLiveState("run-l", { ok: true, liveState: working, liveStateSeq: 0 });
      s.registry.subscribe("run-l", "tok", { onEvent: (event, seq) => opened.run.event(event, seq) });
      const finishing = runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run });
      const claim = await claimed;
      await waiting;
      expect(inner.finished.has("run-l")).toBe(false);
      if (outcome !== "settled-before-fence") expect(await claim.finish(outcome)).toBe(outcome === "accepted");
      else expect(settledDuringObservation).toBe(true);
      const out = answered(await finishing);
      expect(out.prNote).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
      await opened.run.close();
      s.ending.drain(undefined);
      await s.writer.settled();
      const record = inner.finished.get("run-l")!;
      if (outcome === "accepted" || outcome === "settled-before-fence") {
        expect(record.pushed).toContainEqual({ ref, sha: head, by: "push" });
        expect(record.doorPublicationPending).toBeUndefined();
      } else {
        expect(record.pushed ?? []).not.toContainEqual({ ref, sha: head, by: "push" });
        expect(record.doorPublicationPending).toMatchObject({
          repo: "o/r",
          owner: { instanceId: "coord-p", unit: "U12" },
          update: { ref: `refs/heads/${ref}`, old, next: head },
        });
        expect(record.doorPublicationPending).not.toHaveProperty("pr");
      }
    },
  );

  const receiptCommitModes = [
    "committed",
    "door-command",
    "trimmed",
    "delayed-tip",
    "failed-push",
    "rejected",
    "thrown",
    "unprojected",
    "detached",
  ] as const;
  it.each(receiptCommitModes)(
    "a gated findings push records its receipt only after an atomic commit: %s",
    async (mode) => {
      const trim = mode === "trimmed";
      const committed = mode === "committed" || mode === "door-command" || trim || mode === "delayed-tip";
      let startTip!: () => void;
      let releaseTip!: () => void;
      const tipStarted = new Promise<void>((resolve) => {
        startTip = resolve;
      });
      const tipReleased = new Promise<void>((resolve) => {
        releaseTip = resolve;
      });
      let localHead = "b".repeat(40);
      const old = "a".repeat(40),
        head = "b".repeat(40),
        ref = "fix/existing";
      const publication = {
        repo: "o/r",
        pr: 7,
        headRef: ref,
        baseRef: "main",
        expectedHeadSha: old,
        publicationRef: ref,
        owner: { instanceId: "coord-p", unit: "U12" },
      };
      let pushed = false;
      let receiptBeforeSalvage = false;
      let fence: ToolRuleContext["publication"];
      const inner = new InMemoryRunLedger(() => NOW);
      const ledger = createLedgerWriteThrough({
        ledger: inner,
        gen: "gen-T",
        fallback: { put: async () => {}, abandoned: () => {} },
        warn: () => {},
      });
      const opened = await ledger.open({
        runId: "run-l",
        threadKey: THREAD,
        startedAt: NOW,
        meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
        card: null,
        system: "test",
        tools: [],
        seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
      });
      if (opened.kind !== "tracked") throw new Error("untracked test");
      const working = { state: "working" as const, since: NOW, bound: NOW + 60_000 };
      const row = inner.live.get("run-l")!;
      row.liveState = working;
      row.liveStateSeq = 0;
      const assign = inner.assignLiveState.bind(inner);
      const assignments = vi.spyOn(inner, "assignLiveState").mockImplementation(async (id, gen, assignment) => {
        // A refused tool-call write detaches a previously tracked run before
        // the successful push result arrives. Local projection is not a commit.
        if (mode === "detached" && assignment.sourceEvents?.some((e) => e.type === "tool_call"))
          return { ok: false, reason: "unknown-run" };
        if (assignment.statePatch?.publicationReceipts !== undefined) {
          if (mode === "rejected") return { ok: false, reason: "stale-sequence" };
          if (mode === "thrown") throw new Error("receipt commit unavailable");
        }
        return assign(id, gen, assignment);
      });
      const s = endingIn(
        async (_deps, run) => {
          const command =
            mode === "door-command"
              ? `git -c http.postBuffer=52428800 push --force-with-lease=refs/heads/${ref}:${old} -u origin ${ref}:refs/heads/${ref}`
              : `git push --force-with-lease=refs/heads/${ref}:${old} origin ${ref}:${ref}`;
          expect(opened.run.tracked()).toBe(true);
          fence = run.rules.publication;
          const harness: LiveHarness = {
            runId: run.runId,
            rules: { ...run.rules, identity: "write" },
            tools: [],
            toolContext: run.toolContext,
            emit: (e) => run.onEvent?.(e),
            gateSaw: () => {},
            toolSpan: () => undefined,
            toolsBlocked: () => undefined,
          };
          expect(authorizeToolCall(harness, { toolCallId: "push", tool: "bash", input: { command } })).toEqual({
            allow: true,
          });
          run.onEvent?.({ type: "tool_call", tool: "bash", callId: "push", command, summary: "push" });
          pushed = mode !== "failed-push";
          if (mode === "delayed-tip") {
            // The gate's allowance starts the fence, not the delayed log of
            // the tool result. Even a parallel next ask cannot mutate the ref.
            expect(
              immediateToolVerdict(harness, {
                toolCallId: "parallel",
                tool: "bash",
                input: { command: `git update-ref -d refs/heads/${ref}` },
              }).allow,
            ).toBe(false);
          }
          run.onEvent?.({
            type: "tool_result",
            tool: "bash",
            callId: "push",
            ok: pushed,
            exitCode: pushed ? 0 : 1,
            summary: pushed ? "pushed" : "rejected",
            output: pushed
              ? `To https://git.bot.test/git/o/r.git\n + aaaaaaaa...bbbbbbbb ${ref} -> ${ref} (forced update)${mode === "door-command" ? `\nBranch '${ref}' set up to track remote branch '${ref}' from 'origin'.` : ""}`
              : "rejected",
          });
          if (mode === "delayed-tip") {
            await tipStarted;
            const command = `git update-ref -d refs/heads/${ref}`;
            const pi = immediateToolVerdict(harness, { toolCallId: "delete", tool: "bash", input: { command } });
            const oc = judgeOpenCodeAsk("shell", [command], harness.rules, new Set());
            if (pi.allow || oc.reply === "once") localHead = "";
            releaseTip();
            expect(pi.allow).toBe(false);
            expect(oc.reply).toBe("reject");
          }
          if (trim) for (let i = 0; i < 40; i++) run.onEvent?.({ type: "assistant", text: `test output ${i}` });
          return sessionAnswering("done");
        },
        {
          coding: true,
          ...(trim ? { backlogLimit: 24 } : {}),
          repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: old },
          binding: { ref, sha: old, workspace: "/srv/wt/existing" },
          coordinator: {
            parentInstanceId: "coord-p",
            idempotencyKey: "coord-p:U12/1/findings",
            base: "main",
            publication,
          },
          executor: {
            exec: async (cmd) => {
              if (cmd.includes("rev-parse refs/heads/")) {
                if (mode === "detached") expect(opened.run.tracked()).toBe(false);
                startTip();
                if (mode === "delayed-tip") await tipReleased;
                return localHead;
              }
              if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ref;
              if (cmd.includes("rev-parse HEAD") || cmd.includes("rev-parse @{u}")) return head;
              if (cmd.includes("status --porcelain")) {
                if (committed) {
                  expect(inner.live.get("run-l")!.state.publicationReceipts).toEqual([
                    expect.objectContaining({ type: "pushed_head", sha: head }),
                  ]);
                  expect(inner.events.get("run-l")).toContainEqual(
                    expect.objectContaining({ type: "pushed_head", sha: head }),
                  );
                }
                receiptBeforeSalvage ||= s.registry
                  .snapshot("run-l", "tok")!
                  .events.some((e) => e.type === "pushed_head" && e.sha === head);
                return "";
              }
              if (cmd.includes("rev-list --count")) return "0";
              if (cmd.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
              return "";
            },
          },
        },
      );
      s.deps.fetchPrFacts = async () => ({
        state: "open",
        sameRepoHead: true,
        headBranchExists: true,
        headRef: ref,
        baseRef: "main",
        headSha: pushed ? head : old,
        verifiedHead: { repo: "o/r", ref, sha: pushed ? head : old },
      });
      if (mode !== "unprojected")
        s.registry.commitLiveState("run-l", { ok: true, liveState: working, liveStateSeq: 0 });
      s.registry.subscribe("run-l", "tok", { onEvent: (e, seq) => opened.run.event(e, seq) });
      const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: opened.run }));
      // Flush later ordinary state writes too: none may smuggle an uncommitted
      // receipt into the row a fresh process uses to restore its push fence.
      await opened.run.close();
      const state = JSON.parse(JSON.stringify(inner.live.get("run-l")!.state));
      expect(restoredPublicationHead(publicationReceiptsFromState(state.publicationReceipts), publication)).toBe(
        committed ? head : undefined,
      );
      expect(receiptBeforeSalvage).toBe(committed);
      if (mode === "detached") {
        expect(assignments.mock.calls.some(([, , assignment]) => assignment.statePatch?.publicationReceipts)).toBe(
          false,
        );
        expect(s.registry.snapshot("run-l", "tok")!.events.some((e) => e.type === "pushed_head")).toBe(false);
      }
      expect(
        judgeOpenCodeAsk(
          "shell",
          ["git status --short"],
          { identity: "write", checkout: "/srv/wt/existing", publication: fence },
          new Set(),
        ).reply,
      ).toBe("once");
      s.ending.drain(undefined);
      await s.writer.settled();
      const record = inner.finished.get("run-l")!;
      if (committed) {
        expect(record.pushed).toContainEqual({ ref, sha: head, by: "push" });
        expect(record.events).toContainEqual(
          expect.objectContaining({
            type: "pushed_head",
            receipt: { callId: "push", previousHeadSha: old, repo: "o/r", pr: 7, owner: publication.owner },
          }),
        );
      } else if (mode === "failed-push") {
        expect(record.events.some((e) => e.type === "pushed_head" && e.receipt !== undefined)).toBe(false);
      } else {
        expect(record.pushed ?? []).toEqual([]);
        expect(record.events.some((e) => e.type === "pushed_head")).toBe(false);
      }
      expect(fence?.authority).toEqual(
        committed
          ? { ref, expectedHeadSha: head }
          : mode === "failed-push"
            ? { ref, expectedHeadSha: old }
            : { blocked: "the successful push receipt could not be committed durably" },
      );
      await out.releaseWorkspace();
    },
  );

  it("a blocked existing-PR publication keeps the local checkpoint attached and renders truthful partial status without an alternate push", async () => {
    const EXPECTED = "a".repeat(40);
    const MOVED = "b".repeat(40);
    const LOCAL = "c".repeat(40);
    const BRANCH = "fix/existing";
    const unit = `U${1}`;
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: BRANCH,
      baseRef: "main",
      expectedHeadSha: EXPECTED,
      publicationRef: BRANCH,
      owner: { instanceId: "coord-p", unit },
    };
    const commands: string[] = [];
    const s = setup("the local fix is complete", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", pr: 7, ref: BRANCH, baseRef: "main", headSha: EXPECTED },
      binding: { ref: BRANCH, sha: EXPECTED, workspace: "/srv/wt/existing" },
      coordinator: {
        parentInstanceId: "coord-p",
        idempotencyKey: `coord-p:${unit}/1/findings`,
        base: "main",
        publication,
      },
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${LOCAL}\n`;
          if (/rev-parse @\{u\}/.test(cmd)) return `${MOVED}\n`;
          if (/status --porcelain/.test(cmd)) return "";
          if (/rev-list --count/.test(cmd)) return "1\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return `${MOVED}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      },
    });
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: BRANCH,
      baseRef: "main",
      headSha: MOVED,
    });

    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toContain("Publication was refused");
    expect(commands.some((command) => /^git(?: -C '[^']+')? push/.test(command))).toBe(false);
    const card = `${s.ctx.shell.label}\n${JSON.stringify([...s.frames, ...s.closes])}`;
    expect(card).toContain("kept the local checkpoint");
    expect(card).toContain("retention beyond this run is unverified");
    expect(card).not.toContain("discarded at the run's end");
    await out.releaseWorkspace();
    expect(s.releases).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.headSha).toBe(LOCAL);
    expect(record.events).toContainEqual(
      expect.objectContaining({
        type: "run_note",
        kind: "publication_blocked",
        summary: expect.stringContaining(LOCAL.slice(0, 7)),
      }),
    );
    expect(record.pushed ?? []).toEqual([]);
  });

  it("a concurrent branch move that rejects the atomic lease keeps the unpublished checkpoint attached", async () => {
    const EXPECTED = "a".repeat(40);
    const MOVED = "c".repeat(40);
    const LOCAL = "b".repeat(40);
    const BRANCH = "fix/existing";
    const unit = `U${1}`;
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: BRANCH,
      baseRef: "main",
      expectedHeadSha: EXPECTED,
      publicationRef: BRANCH,
      owner: { instanceId: "coord-p", unit },
    };
    const commands: string[] = [];
    const s = setup("the local fix is complete", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", pr: 7, ref: BRANCH, baseRef: "main", headSha: EXPECTED },
      binding: { ref: BRANCH, sha: EXPECTED, workspace: "/srv/wt/existing" },
      coordinator: {
        parentInstanceId: "coord-p",
        idempotencyKey: `coord-p:${unit}/1/findings`,
        base: "main",
        publication,
      },
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (cmd.startsWith("git -C '/srv/wt/existing' push --force-with-lease="))
            throw new Error("rejected: stale info — the branch moved concurrently");
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${LOCAL}\n`;
          if (/rev-parse @\{u\}/.test(cmd)) return `${EXPECTED}\n`;
          if (/status --porcelain/.test(cmd)) return "";
          if (/rev-list --count/.test(cmd)) return "1\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return `${MOVED}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      },
    });
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: BRANCH,
      baseRef: "main",
      headSha: EXPECTED,
    });

    const out = answered(await runLoop(s.deps, s.ctx));
    expect(commands).toContain(
      `git -C '/srv/wt/existing' push --force-with-lease='refs/heads/${BRANCH}:${EXPECTED}' origin '${LOCAL}:refs/heads/${BRANCH}'`,
    );
    expect(out.answer).toContain("Publication outcome is unknown");
    await out.releaseWorkspace();
    expect(s.releases).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.events).toContainEqual(
      expect.objectContaining({
        type: "run_note",
        kind: "publication_blocked",
        summary: expect.stringContaining("atomic leased push did not return a confirmed result"),
      }),
    );
    expect(record.pushed ?? []).toEqual([]);
  });

  it("records a verified seeded patch and source head when cold workspace observation cannot find the checkout", async () => {
    const H0 = "a".repeat(40);
    const H1 = "c".repeat(40);
    const H2 = "b".repeat(40);
    const BRANCH = "fix/existing";
    const unit = `U${1}`;
    const commands: string[] = [];
    const artifacts = {
      presignPut: async () => "https://store.example/upload",
      head: async () => ({ size: 123, contentType: "text/plain" }),
    } as unknown as ArtifactStore;
    const s = setup("the local fix is complete", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", pr: 7, ref: BRANCH, baseRef: "main", headSha: H0 },
      artifacts,
      coordinator: {
        parentInstanceId: "coord-p",
        idempotencyKey: `coord-p:${unit}/1/findings`,
        base: "main",
        publication: {
          repo: "o/r",
          pr: 7,
          headRef: BRANCH,
          baseRef: "main",
          expectedHeadSha: H0,
          publicationRef: BRANCH,
          owner: { instanceId: "coord-p", unit },
        },
      },
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (cmd === "ls -d */.git 2>/dev/null") return "";
          if (cmd.startsWith("git ") && !cmd.startsWith("git -C ")) return "exit 128: fatal: not a git repository";
          if (cmd.includes("remote get-url origin")) return "https://github.com/o/r.git\n";
          if (cmd.includes("symbolic-ref --quiet --short HEAD")) return `${BRANCH}\n`;
          if (cmd.includes("status --porcelain")) return " M src/work.ts\n";
          if (cmd.includes("rev-list --count")) return "1\n";
          if (cmd.includes("ls-remote --exit-code origin")) return `${H1}\trefs/heads/${BRANCH}\n`;
          if (cmd.includes("rev-parse HEAD")) return `${H2}\n`;
          if (cmd.startsWith("wc -c")) return "123\n";
          if (cmd.startsWith("sha256sum")) return `${"d".repeat(64)}  /tmp/patch\n`;
          return "";
        },
      },
    });
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: BRANCH,
      baseRef: "main",
      headSha: H1,
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toContain("Publication was refused");
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.headSha).toBe(H2);
    expect(record.events).toContainEqual(
      expect.objectContaining({ type: "unfinished_patch", baseHeadSha: H0, targetHeadSha: H1, sourceHeadSha: H2 }),
    );
    expect(commands).toContain("git -C '/workspace/checkout' add -A");
    expect(commands.some((cmd) => cmd.includes(` diff --binary --full-index '${H0}' '${H2}'`))).toBe(true);
    expect(commands.some((cmd) => cmd.includes(" push"))).toBe(false);
  });

  it("a stopped coding child checkpoints its WIP before the hard-stop teardown", async () => {
    const HEAD = "c1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "unit-work";
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coordinator: WIP_COORDINATOR,
      harness: {
        harnesses: roster({
          ...watched(piHarness).harness,
          open: async (_deps, run) => {
            run.control?.requestStop("hard");
            return {
              answer: "⛔ Run aborted by an operator (hard stop).",
              followUp: async () => "",
              remainingMs: () => 1,
              end: async () => {},
            };
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/status --porcelain/.test(cmd)) return " M src/work.ts\n";
          if (/rev-list --count/.test(cmd)) return "0\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toContain("aborted by an operator");
    expect(commands).toContain(`git -C '/srv/wt/u1' push origin '${HEAD}:refs/heads/${BRANCH}'`);
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["hard"]);
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
  });

  it("a restarting coding child pushes a WIP checkpoint before release and its card never says the work was discarded", async () => {
    class RestartingChild extends HarnessInterruptedError {
      constructor() {
        super("the bot restarted while the coding child was running", "the bot restarted under the run", "bot_restart");
      }
    }
    const HEAD = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "unit-work";
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      coding: true,
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coordinator: WIP_COORDINATOR,
      harness: {
        harnesses: roster({
          ...watched(piHarness).harness,
          open: async () => {
            throw new RestartingChild();
          },
        }),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/status --porcelain/.test(cmd)) return " M src/work.ts\n";
          if (/rev-list --count/.test(cmd)) return "0\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      },
    });
    const out = await runLoop(s.deps, s.ctx);
    expect(out).toMatchObject({ kind: "interrupted", refusal: "bot_restart" });
    expect(commands).toContain(`git -C '/srv/wt/u1' push origin '${HEAD}:refs/heads/${BRANCH}'`);
    expect(JSON.stringify(s.closes)).not.toContain("left behind — discarded");
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
  });
});

// Feature: docs/reference/specs/harness-pi.md item 2 — the harness seam: when
// the run's preset is on pi, the loop hands the run to the pi harness in place
// of `runAgent`, and everything around it — the card, the stream, the answer's
// publish, the finish — is the same code; without the block, a run is the
// native loop byte for byte and pi is never started.
describe("the pi harness — every preset's runs, in the run's container", () => {
  const PI_YAML = YAML + "harness:\n  coding: pi\n";

  /** A pi that answers the harness's first prompt with one bash turn and a
   *  final text — its extension asking the gate for the call, as the real one does. */
  function scriptedPi(container: FakeHarnessContainer, registry: HarnessRegistry, finalText: string) {
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      const call = {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
        stopReason: "toolUse",
      };
      const done = { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop" };
      c.emit(
        { id: cmd.id, type: "response", command: "prompt", success: true },
        { type: "agent_start" },
        { type: "message_end", message: call },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
        },
        { type: "turn_end", message: call, toolResults: [] },
        { type: "message_end", message: done },
        { type: "turn_end", message: done, toolResults: [] },
        { type: "agent_settled" },
      );
      authorizeToolCall(registry.get("run-l")!, { toolCallId: "c1", tool: "bash", input: { command: "npm test" } });
    };
  }

  /** A pi that starts on the prompt and finishes only once a steer arrives — so the
   *  test sees the steer's text the way pi would, staged files and all. */
  function piFinishingOnSteer(container: FakeHarnessContainer, finalText: string) {
    const steers: string[] = [];
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type === "prompt")
        c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      if (cmd.type === "steer") {
        steers.push(String(cmd.message));
        const done = { role: "assistant", content: [{ type: "text", text: finalText }], stopReason: "stop" };
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          { type: "agent_settled" },
        );
      }
    };
    return steers;
  }

  const clip = {
    name: "clip.mp4",
    size: 3_120,
    type: "video/mp4",
    url: "https://files.slack.com/files-pri/T1-F1/clip.mp4",
    messageId: "1700000000.000300",
  };
  const steered = () => ({
    text: "and cut a contact sheet from this",
    userId: "slack:UX",
    at: NOW + 1,
    staged: [clip],
    msg: { channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, text: "and cut a contact sheet from this" },
  });

  // record 0033: on pi too, a follow-up steered into the live run that carries a
  // staged file is copied into the store and pulled into the container over the
  // run's executor BEFORE the steer pi reads, whose text ends with the line.
  it("a steered follow-up's staged file is copied and pulled before pi reads the steer; the steer's text ends with the attachments line; the record carries the `in` event", async () => {
    const container = new FakeHarnessContainer();
    const steers = piFinishingOnSteer(container, "sheet cut");
    const store = new InMemoryArtifactStore({
      bucket: "test",
      fetch: (async () =>
        new Response(new Uint8Array(clip.size), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })) as unknown as typeof fetch,
    });
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      provider: provider("unused"),
      yaml: PI_YAML,
      harness: {
        harnesses: roster(),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (command) => {
          commands.push(command);
          return "";
        },
      },
      artifacts: store,
    });
    s.ctx.admitted.inbox.push(steered());
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("sheet cut");
    expect(store.copies.map((c) => c.key)).toEqual(["threads/slack-CX-1.0/in/1700000000.000300/1-clip.mp4"]);
    expect(commands).toEqual([
      expect.stringMatching(/^mkdir -p attachments && curl -fsS -o 'attachments\/1-clip\.mp4' 'memory:\/\/test\//),
    ]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatch(
      /and cut a contact sheet from this[\s\S]*Attached files are in \.\/attachments\/: 1-clip\.mp4 \(3 KB, video\/mp4\)$/,
    );
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "artifact")).toMatchObject([
      {
        type: "artifact",
        direction: "in",
        key: "threads/slack-CX-1.0/in/1700000000.000300/1-clip.mp4",
        name: "clip.mp4",
        size: 3_120,
      },
    ]);
  });

  // agent-ship item 8, push-before-abort: a coordinator's coding child whose
  // loop ended at the time budget salvages what its tree holds to the unit's
  // branch — and nowhere when the plan's base cannot be named, since the
  // branch might then be the base.
  it("a coordinator's coding child at its time budget commits and pushes its tree to the unit's branch and says so; with the plan's base unknown the salvage is skipped, nothing is pushed, and the note says why", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "plan/p/u1";
    const budgeted = async (base: string | undefined) => {
      const clock = { now: NOW };
      const registry = new HarnessRegistry();
      const container = new FakeHarnessContainer();
      const commands: string[] = [];
      const pi = scriptPiFromProvider(container, {
        provider: {
          name: "budgeted",
          async complete() {
            // The budget runs out with this call under way: the harness notes it
            // and steers the write-up before the answer lands.
            clock.now = NOW + (ASKS.coding + 1) * 60_000;
            for (let i = 0; i < 200 && pi.steers.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
            return { content: [{ type: "text", text: "half done" }], stopReason: "end_turn" };
          },
        },
        registry,
      });
      const s = setup("", {
        agent: "coding",
        yaml: PI_YAML,
        coding: true,
        repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
        binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
        coordinator: {
          parentInstanceId: "coord-b",
          idempotencyKey: "coord-b:budgeted/0/coding",
          ...(base ? { base } : {}),
        },
        harness: {
          harnesses: roster(),
          registry,
          harnessUrl: "https://bot.example.com",
          containerFor: () => container,
          pollMs: 1,
          tickMs: 5,
        },
        bearer: "sbr_run-l.s3cret",
        executor: {
          exec: async (cmd: string) => {
            commands.push(cmd);
            if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
            if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
            if (/status --porcelain/.test(cmd)) return " M src/a.ts\n";
            if (/rev-list --count/.test(cmd)) return "0\n";
            return "";
          },
        },
      });
      // No instance in the store either: with no base on the tag, the base is lost.
      s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
      const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, clock: () => clock.now })));
      s.ending.drain(true);
      await s.writer.settled();
      const rec = (await s.store.get("run-l"))!;
      const salvage = rec.events.filter(
        (e) => e.type === "run_note" && (e as { kind: string }).kind === "budget_salvage",
      );
      return { out, commands, salvage };
    };
    const pushed = await budgeted("feat/trunk");
    // The answer is composed after the salvage (harness-pi item 6): it names
    // the branch and the head the salvage pushed, never "partial work may exist".
    expect(pushed.out.answer).toBe(
      `⚠️ _Hit the ${ASKS.coding}-minute budget before finishing. What the tree held was pushed to \`${BRANCH}\` at \`${HEAD.slice(0, 7)}\` by the budget salvage, unreviewed — a follow-up starts from it. No PR description was submitted. Findings so far:_\n\nhalf done`,
    );
    expect(pushed.commands).toContain("git -C '/srv/wt/u1' add -A");
    expect(pushed.commands).toContain(`git -C '/srv/wt/u1' push origin '${HEAD}:refs/heads/${BRANCH}'`);
    expect(pushed.salvage).toEqual([
      expect.objectContaining({
        summary: `the budget ended with work in the tree — committed the uncommitted work and pushed to \`${BRANCH}\` (${HEAD.slice(0, 7)})`,
      }),
    ]);
    const lost = await budgeted(undefined);
    // Nothing pushed: the answer says what the tree held and its fate — a
    // resident's tree is discarded at the run's end — never that work may exist.
    expect(lost.out.answer).toBe(
      `⚠️ _Hit the ${ASKS.coding}-minute budget before finishing. 1 uncommitted change(s) and 0 unpushed commit(s) were left in the tree and discarded at the run's end. No PR description was submitted. Findings so far:_\n\nhalf done`,
    );
    expect(lost.commands.some((c) => /^git(?: -C '[^']+')? (?:push|commit)/.test(c))).toBe(false);
    expect(lost.salvage).toEqual([
      expect.objectContaining({
        summary: `the budget-end salvage to \`${BRANCH}\` was skipped: the plan's base is unknown, so the branch cannot be told from it`,
      }),
    ]);
  });

  // harness-pi item 7 and run-history item 2: a failed compaction is a
  // checkpoint signal — the run loop commits and pushes the tree's tracked
  // work to the run's own branch the moment the harness reports the failure,
  // in the push-before-abort's shape, and the loop goes on.
  it("a coding child whose compaction fails for good checkpoints its tree: a tracked worktree is committed and pushed to the unit's branch with a pushed_head (by: salvage) and the run continues; a clean tree yields the note alone; a context that no longer fits ends the round with the push already made", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "plan/p/u1";
    const REFUSAL =
      "Auto-compaction failed: Turn prefix summarization failed: refused under the provider's usage policy";
    const compacted = async (opts: { dirty: boolean; thenOverflow?: boolean }) => {
      const registry = new HarnessRegistry();
      const container = new FakeHarnessContainer();
      const commands: string[] = [];
      let dirty = opts.dirty;
      container.onStdin = (line, c) => {
        const cmd = JSON.parse(line) as Record<string, unknown>;
        if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
          c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
        if (cmd.type !== "prompt") return;
        c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
        // The provider's classifier refuses pi's turn-prefix summary for good.
        c.emit({
          type: "compaction_end",
          reason: "threshold",
          result: undefined,
          aborted: false,
          errorMessage: REFUSAL,
        });
        if (opts.thenOverflow) {
          // The context no longer fits: the next model call fails and the round ends.
          c.emit(
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "input is over the model's context window",
              },
            },
            { type: "agent_settled" },
          );
          return;
        }
        const done = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          { type: "agent_settled" },
        );
      };
      const s = setup("", {
        agent: "coding",
        yaml: PI_YAML,
        coding: true,
        repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
        binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
        coordinator: { parentInstanceId: "coord-c", idempotencyKey: "coord-c:compacted/0/coding", base: "feat/trunk" },
        harness: {
          harnesses: roster(),
          registry,
          harnessUrl: "https://bot.example.com",
          containerFor: () => container,
          pollMs: 1,
          tickMs: 5,
        },
        bearer: "sbr_run-l.s3cret",
        executor: {
          exec: async (cmd: string) => {
            commands.push(cmd);
            if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
            if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
            if (/status --porcelain/.test(cmd)) return dirty ? " M src/a.ts\n" : "";
            if (/^git(?: -C '[^']+')? commit /.test(cmd)) dirty = false;
            if (/rev-list --count/.test(cmd)) return "0\n";
            return "";
          },
        },
      });
      const out = await runLoop(s.deps, s.ctx).then(
        (r) => ({ answer: answered(r).answer, failed: undefined as string | undefined }),
        (err: unknown) => ({ answer: undefined, failed: err instanceof Error ? err.message : String(err) }),
      );
      s.ending.drain(out.failed === undefined ? true : undefined);
      await s.writer.settled();
      const rec = (await s.store.get("run-l"))!;
      const notes = rec.events.filter(
        (e) => e.type === "run_note" && (e as { kind: string }).kind === "compaction_salvage",
      ) as { summary: string }[];
      const pushed = rec.events.filter((e) => e.type === "pushed_head" && (e as { by: string }).by === "salvage");
      return { out, commands, notes, pushed };
    };
    const tracked = await compacted({ dirty: true });
    // The run continued past the failed compaction and answered with the checkpoint's confirmed head.
    expect(tracked.out.answer).toContain(`Published \`${BRANCH}\` at \`${HEAD}\``);
    expect(tracked.commands).toContain("git -C '/srv/wt/u1' add -A");
    expect(tracked.commands).toContain(`git -C '/srv/wt/u1' push origin 'HEAD:refs/heads/${BRANCH}'`);
    expect(tracked.notes.map((n) => n.summary)).toEqual([
      `the compaction failed (${REFUSAL}); the failed compaction left work in the tree — committed the uncommitted work and pushed to \`${BRANCH}\` (${HEAD.slice(0, 7)})`,
    ]);
    expect(tracked.pushed).toEqual([expect.objectContaining({ ref: BRANCH, sha: HEAD, by: "salvage" })]);
    // Nothing to commit: the note alone, no push and no pushed_head.
    const clean = await compacted({ dirty: false });
    expect(clean.out.answer).toContain("No push was confirmed by this run.");
    expect(clean.out.answer).toContain("Work report (agent-written; publication claims here are unverified):\ndone");
    expect(clean.commands.some((c) => /^git(?: -C '[^']+')? (?:push|commit)/.test(c))).toBe(false);
    expect(clean.notes.map((n) => n.summary)).toEqual([
      `the compaction failed (${REFUSAL}); the compaction checkpoint found nothing to push: the tree is clean and \`${BRANCH}\` holds no unpushed commits`,
    ]);
    expect(clean.pushed).toEqual([]);
    // The context no longer fits: the round ends with the push already made.
    const overflowed = await compacted({ dirty: true, thenOverflow: true });
    expect(overflowed.out.failed).toContain(UNKNOWN_MODEL_TERMINAL_MESSAGE);
    expect(overflowed.commands).toContain(`git -C '/srv/wt/u1' push origin 'HEAD:refs/heads/${BRANCH}'`);
    // The compaction checkpoint preserves the dirty tree; the abnormal ending
    // then adds its own WIP marker so the durable last push cannot look final.
    expect(overflowed.pushed).toHaveLength(2);
    expect(overflowed.pushed).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: BRANCH, sha: HEAD, by: "salvage" })]),
    );
    expect(overflowed.notes).toHaveLength(1);
  });

  // execution item 30: an atomic rejection revokes the live harness's receipt,
  // not just the mechanical salvage paths that read the run-loop variable.
  it("a rejected compaction checkpoint revokes the open harness's publication receipt before the continuing model can push", async () => {
    const EXPECTED = "a".repeat(40);
    const LOCAL = "b".repeat(40);
    const BRANCH = "fix/existing";
    const unit = `U${1}`;
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: BRANCH,
      baseRef: "main",
      expectedHeadSha: EXPECTED,
      publicationRef: BRANCH,
      owner: { instanceId: "coord-p", unit },
    };
    const PUSH = `git push --force-with-lease=refs/heads/${BRANCH}:${EXPECTED} origin HEAD:refs/heads/${BRANCH}`;
    const registry = new HarnessRegistry();
    const container = new FakeHarnessContainer();
    const commands: string[] = [];
    let laterPush: Awaited<ReturnType<typeof authorizeToolCall>> | undefined;
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      c.emit(
        { id: cmd.id, type: "response", command: "prompt", success: true },
        { type: "agent_start" },
        {
          type: "compaction_end",
          reason: "threshold",
          result: undefined,
          aborted: false,
          errorMessage: "the provider refused the summary",
        },
      );
      void (async () => {
        for (
          let i = 0;
          i < 200 &&
          !commands.some((command) => command.startsWith("git -C '/srv/wt/existing' push --force-with-lease="));
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 1));
        const live = registry.get("run-l")!;
        const input = { command: PUSH };
        const call = {
          role: "assistant",
          content: [{ type: "toolCall", id: "p1", name: "bash", arguments: input }],
          stopReason: "toolUse",
        };
        c.emit(
          { type: "message_end", message: call },
          { type: "tool_execution_start", toolCallId: "p1", toolName: "bash", args: input },
        );
        laterPush = immediateToolVerdict(live, { toolCallId: "p1", tool: "bash", input });
        c.emit(
          {
            type: "tool_execution_end",
            toolCallId: "p1",
            toolName: "bash",
            result: { content: [{ type: "text", text: laterPush.allow ? "pushed" : laterPush.reason }] },
            isError: !laterPush.allow,
          },
          { type: "turn_end", message: call, toolResults: [] },
        );
        const done = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          { type: "agent_settled" },
        );
      })();
    };
    const s = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      coding: true,
      repoCtx: { repo: "o/r", pr: 7, ref: BRANCH, baseRef: "main", headSha: EXPECTED },
      binding: { ref: BRANCH, sha: EXPECTED, workspace: "/srv/wt/existing" },
      coordinator: {
        parentInstanceId: "coord-p",
        idempotencyKey: `coord-p:${unit}/1/findings`,
        base: "main",
        publication,
      },
      harness: {
        harnesses: roster(),
        registry,
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
        pollMs: 1,
        tickMs: 5,
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (command: string) => {
          commands.push(command);
          if (command.startsWith("git -C '/srv/wt/existing' push --force-with-lease="))
            throw new Error("rejected: stale info");
          if (/rev-parse --abbrev-ref HEAD/.test(command)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(command)) return `${LOCAL}\n`;
          if (/status --porcelain/.test(command)) return " M src/a.ts\n";
          if (/rev-list --count/.test(command)) return "1\n";
          return "";
        },
      },
    });
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: BRANCH,
      baseRef: "main",
      headSha: EXPECTED,
    });

    expect(answered(await runLoop(s.deps, s.ctx)).answer).toContain("Publication was refused");
    expect(laterPush).toEqual({
      allow: false,
      reason: expect.stringContaining(
        "existing-PR publication blocked: the atomic leased push did not return a confirmed result",
      ),
    });
    expect(
      commands.filter((command) => command.startsWith("git -C '/srv/wt/existing' push --force-with-lease=")),
    ).toHaveLength(1);
  });

  // harness-pi item 6: the finale answer reads what the ending established.
  // The loop's answer is composed AFTER the salvage, the description turn and
  // the PR post-step, from the ending the harness handed over: even a clean
  // tree gets an ending marker so its earlier ordinary push cannot be mistaken
  // for finished work, and the answer names that checkpoint and description.
  it("a coding child at its time budget marks a clean, already-pushed tree as WIP and names the checkpoint and submitted description", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "plan/p/u1";
    const DESCRIPTION: PrDescription = {
      title: "feat(seam): count every refusal",
      tldr: "Counts the refusals at the seam. The count is what the runner reads.",
      why: "The seam refused silently.",
      pointers: [{ label: "The count", text: "One counter.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "The counter's name.",
      verified: "Unit.",
      decisions: [{ title: "One counter", rationale: "One place to read." }],
      risk: "none",
      validation: { criteria: [{ criterion: "unit", proof: "green" }] },
    };
    const clock = { now: NOW };
    const registry = new HarnessRegistry();
    const container = new FakeHarnessContainer();
    const commands: string[] = [];
    let calls = 0;
    const pi = scriptPiFromProvider(container, {
      provider: {
        name: "budgeted-clean",
        async complete() {
          const n = calls++;
          if (n === 0) {
            // The budget runs out with the loop's first call under way: the
            // write-up is steered and answered with nothing (n === 1).
            clock.now = NOW + (ASKS.coding + 1) * 60_000;
            for (let i = 0; i < 200 && pi.steers.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
          }
          if (n <= 1) return { content: [{ type: "text", text: "" }], stopReason: "end_turn" };
          // The description turn: the relayed submit lands, then a line back.
          if (n === 2)
            return {
              content: [{ type: "tool_use", id: "d1", name: "submit_pr_description", input: DESCRIPTION }],
              stopReason: "tool_use",
            };
          return { content: [{ type: "text", text: "Description resubmitted." }], stopReason: "end_turn" };
        },
      },
      registry,
    });
    const s = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      coding: true,
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coordinator: { parentInstanceId: "coord-c", idempotencyKey: "coord-c:clean/0/coding", base: "feat/trunk" },
      harness: {
        harnesses: roster(),
        registry,
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
        pollMs: 1,
        tickMs: 5,
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/rev-parse @\{u\}/.test(cmd)) return `${HEAD}\n`;
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          if (/status --porcelain/.test(cmd)) return "";
          if (/rev-list --count/.test(cmd)) return "0\n";
          return "";
        },
      },
    });
    s.deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/o/r/pull/700" }));
    s.deps.openPullRequest = async () => ({ number: 700, htmlUrl: "https://github.com/o/r/pull/700", created: false });
    s.deps.fetchRepoShipInfo = async () => ({ defaultBranch: "feat/trunk" });
    const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, clock: () => clock.now })));
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    const notes = rec.events.filter((e) => e.type === "run_note") as Array<{ kind: string; summary: string }>;
    // The record's own order: the salvage marked the abnormal ending, the
    // description was asked for and submitted, the PR edited at the WIP head.
    expect(notes.filter((n) => n.kind === "budget_salvage").map((n) => n.summary)).toEqual([
      `the budget ended with work in the tree — created a WIP checkpoint commit and pushed to \`${BRANCH}\` (${HEAD.slice(0, 7)})`,
    ]);
    expect(notes.some((n) => n.kind === "description_turn")).toBe(true);
    expect(commands.some((c) => c.startsWith("git -C '/srv/wt/u1' commit --allow-empty -m"))).toBe(true);
    expect(commands).toContain(`git -C '/srv/wt/u1' push origin '${HEAD}:refs/heads/${BRANCH}'`);
    // The quiet default (routing-and-config item 28): the link, not the head it was rendered at.
    expect(out.prNote).toContain("PR updated: https://github.com/o/r/pull/700");
    expect(out.prNote).not.toContain("re-rendered");
    // The card reads what the ending established, in that order.
    expect(out.answer).toBe(
      `Stopped at the ${ASKS.coding}-minute budget without finishing. What the tree held was pushed to \`${BRANCH}\` at \`${HEAD.slice(0, 7)}\` by the budget salvage, unreviewed — a follow-up starts from it. The PR description was submitted.`,
    );
    expect(out.answer).not.toContain("Partial work may exist");
    // The record's answer event carries the same words.
    const answerEvent = rec.events.find((e) => e.type === "answer") as { text?: string } | undefined;
    expect(answerEvent?.text).toBe(out.answer);
  });

  it("without a store the pi steer is sent as before: no copy, no pull, no line", async () => {
    const container = new FakeHarnessContainer();
    const steers = piFinishingOnSteer(container, "done");
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      provider: provider("unused"),
      yaml: PI_YAML,
      harness: {
        harnesses: roster(),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
      bearer: "sbr_run-l.s3cret",
      executor: {
        exec: async (command) => {
          commands.push(command);
          return "";
        },
      },
    });
    s.ctx.admitted.inbox.push(steered());
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("done");
    expect(commands).toEqual([]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("and cut a contact sheet from this");
    expect(steers[0]).not.toContain("Attached files");
  });

  it("a preset the deployment moved to pi runs on the harness: pi's answer is the run's, its tool events are on the stream, the bearer reaches pi and the provider is never called", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    scriptedPi(container, registry, "pi says done");
    let providerCalls = 0;
    const provider: Provider = {
      name: "fake",
      async complete() {
        providerCalls++;
        return { content: [{ type: "text", text: "native answer" }], stopReason: "end_turn" };
      },
    };
    const s = setup("", {
      agent: "coding",
      provider,
      yaml: PI_YAML,
      harness: {
        harnesses: roster(),
        registry,
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
      bearer: "sbr_run-l.s3cret",
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("pi says done");
    expect(out.toolCalls).toBe(1);
    expect(providerCalls).toBe(0);
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0].env.SWITCHBOARD_RUN_BEARER).toBe("sbr_run-l.s3cret");
    expect(container.files.get("/var/tmp/switchboard-pi-run-l/agent/SYSTEM.md")).toContain("the system prompt");
    expect(container.killed).toEqual([4242]);
    expect(s.published).toEqual(["answer:pi says done"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "tool_call")).toEqual([
      expect.objectContaining({ tool: "bash", summary: "$ npm test", command: "npm test", callId: "c1" }),
    ]);
  });

  // The recorder commits an accepted head before the loop answers. Only that
  // write can start the second prompt; remote equality alone cannot.
  it("a coding run on pi whose push landed on an open PR without a description gets its description turn as a prompt on the same session: the relayed submit_pr_description lands, the PR is edited, the note and the description are on the record, pi is ended once after the turn", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const BRANCH = "dependabot/github_actions/actions-4c45254bbe";
    const DESCRIPTION: PrDescription = {
      title: "ci(deps): bump the action, refresh its hygiene allowlist",
      tldr: "Bumps the action and refreshes the allowlist lines its pin moved. CI is green again.",
      why: "Dependabot moved the pin; the allowlist matches lines by content.",
      pointers: [
        {
          label: "The allowlist",
          text: "Three entries at the new pin.",
          anchor: { path: "scripts/a", from: 1, to: 3 },
        },
      ],
      feedbackWanted: "Nothing in particular.",
      verified: "See validation.",
      decisions: [{ title: "Keep dependabot's notes", rationale: "They are still true; they moved into why." }],
      risk: "none",
      validation: { criteria: [{ criterion: "hygiene:check", proof: "ok — 201 files" }] },
    };
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    const bindings = new GitBindings();
    bindings.register("run-l", { repo: "acme/api", ref: BRANCH }, undefined, async () => true);
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const tracked = await ledger.open({
      runId: "run-l",
      threadKey: THREAD,
      startedAt: NOW,
      meta: { agent: "coding", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
      card: null,
      system: "test",
      tools: [],
      seed: { messages: [{ role: "user", content: [{ type: "text", text: "fix" }] }], budgetMs: 60_000 },
    });
    if (tracked.kind !== "tracked") throw new Error("untracked test");
    // The workspace as the post-step observes it: on the pushed branch, its tip on the remote.
    const executor = {
      exec: async (cmd: string) => {
        if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
        if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
        if (/rev-parse @\{u\}/.test(cmd)) return `${HEAD}\n`;
        if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
        return "";
      },
    };
    const killedWhenPrompted: number[][] = [];
    // A coding pi answering TWO prompts on one session: the request with a bare
    // answer (no description), then the description turn's follow-up with the
    // relayed submit_pr_description and a line back.
    let prompts = 0;
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      const n = prompts++;
      killedWhenPrompted.push([...container.killed]);
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const settle = (text: string) => {
        const done = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          { type: "agent_settled" },
        );
      };
      if (n === 0) {
        void bindings
          .beginBranch("run-l", {
            ref: `refs/heads/${BRANCH}`,
            old: "b".repeat(40),
            next: HEAD,
          })
          .then(async (claim) => {
            expect(claim).toBeDefined();
            expect(await claim!.finish("accepted")).toBe(true);
            settle("Refreshed the allowlist.");
          });
        return;
      }
      const live = registry.get("run-l")!;
      const call = {
        role: "assistant",
        content: [{ type: "toolCall", id: "d1", name: "submit_pr_description", arguments: DESCRIPTION }],
        stopReason: "toolUse",
      };
      c.emit(
        { type: "message_end", message: call },
        { type: "tool_execution_start", toolCallId: "d1", toolName: "submit_pr_description", args: DESCRIPTION },
      );
      authorizeToolCall(live, { toolCallId: "d1", tool: "submit_pr_description", input: DESCRIPTION });
      void runRelayedTool(live, { toolCallId: "d1", tool: "submit_pr_description", input: DESCRIPTION }).then(
        (answer) => {
          c.emit(
            {
              type: "tool_execution_end",
              toolCallId: "d1",
              toolName: "submit_pr_description",
              result: { content: answer.content },
              isError: answer.isError,
            },
            { type: "turn_end", message: call, toolResults: [] },
          );
          settle("Description resubmitted.");
        },
      );
    };
    const s = setup("", {
      agent: "coding",
      provider: provider("unused"),
      yaml: PI_YAML,
      harness: { harnesses: roster(), registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
      bearer: "sbr_run-l.s3cret",
      repoCtx: { repo: "acme/api", ref: BRANCH, baseRef: "main" } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/t", user: "worker2" },
      executor,
      coding: true,
    });
    s.deps.githubBindings = bindings;
    const opened: Array<Record<string, unknown>> = [];
    s.deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/acme/api/pull/700" }));
    s.deps.openPullRequest = async (target) => {
      opened.push({ ...target });
      return { number: 700, htmlUrl: "https://github.com/acme/api/pull/700", created: false };
    };
    s.deps.fetchRepoShipInfo = async () => ({ defaultBranch: "main" });
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: tracked.run }));
    expect(container.starts).toHaveLength(1);
    expect(prompts).toBe(2);
    expect(killedWhenPrompted).toEqual([[], []]);
    expect(s.deps.findOpenPrByHead).toHaveBeenCalledWith("acme/api", BRANCH);
    expect(out.answer).toContain(`Published \`${BRANCH}\` at \`${HEAD}\``);
    expect(out.answer).toContain("Refreshed the allowlist.");
    expect(out.answer).toContain("PR updated: https://github.com/acme/api/pull/700");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "acme/api", headBranch: BRANCH, base: "main", title: DESCRIPTION.title });
    expect(String(opened[0].body)).toContain(`blob/${HEAD}/`);
    expect(out.prNote).toBeUndefined();
    // pi ended once, after the turn
    expect(container.killed).toEqual([4242]);
    expect(container.removed).toEqual(["/var/tmp/switchboard-pi-run-l"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(true);
    await s.writer.settled();
    const rec = inner.finished.get("run-l");
    if (!rec) throw new Error("tracked run did not finish");
    const notes = rec.events.filter((e) => e.type === "run_note").map((e) => (e as { kind: string }).kind);
    expect(notes).toContain("description_turn");
    expect(rec.events.some((e) => e.type === "pr_description")).toBe(true);
    expect(rec.events.find((e) => e.type === "pr_opened")).toMatchObject({ number: 700, created: false });
    expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "submit_pr_description",
    ]);
  });

  // The resident's attach names the pool user every /exec runs as, and the
  // run's pi files go under the run's own root all the same: the root never
  // depends on knowing that user, present or not (harness-pi item 4).
  it("a run on a resident files its pi under the run's own root directly under /var/tmp, whatever pool user the attach binding names, and removes it when the run ends", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    scriptedPi(container, registry, "pi says done");
    const s = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      harness: { harnesses: roster(), registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
      bearer: "sbr_run-l.s3cret",
      binding: { ref: "main", sha: "abc", workspace: "/workspace/threads/t/main", user: "worker2" },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("pi says done");
    expect(container.starts[0].paths.dir).toBe("/var/tmp/switchboard-pi-run-l");
    expect(container.files.get("/var/tmp/switchboard-pi-run-l/agent/SYSTEM.md")).toContain("the system prompt");
    const roots = [...container.files.keys()].map((f) => f.split("/").slice(0, 4).join("/"));
    expect(new Set(roots)).toEqual(new Set(["/var/tmp/switchboard-pi-run-l"]));
    expect(container.removed).toEqual(["/var/tmp/switchboard-pi-run-l"]);
  });

  it("the gate's push rules follow the thread: a pull-request thread's or a unit child's bound branch is the run's own — the one push target, its base protected; a plain thread's binding is the protected base", async () => {
    const seen: ToolRuleContext[] = [];
    class RecordingRegistry extends HarnessRegistry {
      override register(harness: LiveHarness): () => void {
        seen.push(harness.rules);
        return super.register(harness);
      }
    }
    const rulesOf = async ({
      instances,
      freshHead,
      ...thread
    }: {
      repoCtx: RepoContext;
      coordinator?: CoordinatorTag;
      binding?: ResidentBinding;
      seeded?: ExecutorSelection["seeded"];
      instances?: InMemoryCoordinatorInstanceStore;
      freshHead?: string;
    }) => {
      const container = new FakeHarnessContainer();
      const registry = new RecordingRegistry();
      scriptedPi(container, registry, "done");
      const s = setup("", {
        agent: "coding",
        yaml: PI_YAML,
        harness: {
          harnesses: roster(),
          registry,
          harnessUrl: "https://bot.example.com",
          containerFor: () => container,
        },
        bearer: "sbr_run-l.s3cret",
        ...thread,
      });
      if (instances) s.deps.coordinatorInstances = instances;
      if (thread.coordinator?.publication !== undefined)
        s.deps.fetchPrFacts = async () => ({
          state: "open",
          sameRepoHead: true,
          headBranchExists: true,
          headRef: thread.coordinator!.publication!.headRef,
          baseRef: thread.coordinator!.publication!.baseRef,
          headSha: freshHead ?? thread.coordinator!.publication!.expectedHeadSha,
        });
      await runLoop(s.deps, s.ctx);
      return seen.pop()!;
    };
    const push = (rules: ToolRuleContext, branch: string) =>
      judgeToolCall("bash", { command: `git push origin ${branch}` }, rules).verdict;

    // A fix round: the thread came from a pull request and the resident is bound at its head branch.
    const fixRound = await rulesOf({
      repoCtx: { repo: "o/r", ref: "fix/the-pr-head", refFromPr: true, baseRef: "main" },
      binding: { ref: "fix/the-pr-head", sha: "abc", workspace: "/srv/wt/the-pr" },
    });
    expect(fixRound).toEqual({
      identity: "write",
      checkout: "/srv/wt/the-pr",
      outputDir: "/var/tmp/switchboard-pi-run-l/output",
      branch: "fix/the-pr-head",
      protectedBranches: ["main"],
      loopEndsIn: expect.any(Function),
    });
    expect(push(fixRound, "fix/the-pr-head")).toBe("allowed");
    expect(push(fixRound, "main")).toBe("refused");
    // A coordinator's unit child: dispatched at its unit branch, the tag naming the base.
    const child = await rulesOf({
      repoCtx: { repo: "o/r", ref: "unit/u26" },
      coordinator: { parentInstanceId: "coord-1", idempotencyKey: "k-1", base: "feat/trunk" },
    });
    expect(child).toEqual({
      identity: "write",
      checkout: "/workspace",
      branch: "unit/u26",
      outputDir: "/var/tmp/switchboard-pi-run-l/output",
      protectedBranches: ["feat/trunk"],
      loopEndsIn: expect.any(Function),
    });
    expect(push(child, "unit/u26")).toBe("allowed");
    expect(push(child, "feat/trunk")).toBe("refused");

    // An adopted existing PR carries a durable target and is re-read before
    // the harness opens. The same-head receipt permits only an atomic leased
    // push; movement blocks every publication without inventing another ref.
    const expected = "a".repeat(40);
    const unit = `U${1}`;
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: "fix/existing",
      baseRef: "main",
      expectedHeadSha: expected,
      publicationRef: "fix/existing",
      owner: { instanceId: "coord-p", unit },
    };
    const publicationTag: CoordinatorTag = {
      parentInstanceId: "coord-p",
      idempotencyKey: `coord-p:${unit}/1/findings`,
      base: "main",
      publication,
    };
    const existing = await rulesOf({
      repoCtx: { repo: "o/r", pr: 7, ref: "fix/existing", headSha: expected },
      binding: { ref: "fix/existing", sha: expected, workspace: "/srv/wt/existing" },
      coordinator: publicationTag,
    });
    expect(existing).toMatchObject({
      branch: "fix/existing",
      protectedBranches: ["main"],
      publication: { authority: { ref: "fix/existing", expectedHeadSha: expected } },
    });
    expect(
      judgeToolCall(
        "bash",
        {
          command: `git push --force-with-lease=refs/heads/fix/existing:${expected} origin fix/existing:refs/heads/fix/existing`,
        },
        existing,
      ),
    ).toEqual({ verdict: "allowed" });
    const seededCheckout = {
      slug: "o/r",
      ref: "fix/existing",
      sha: expected,
      workspace: "/workspace/checkout",
      cached: false,
      ms: 1,
    };
    const seeded = await rulesOf({
      repoCtx: { repo: "o/r", pr: 7, ref: "fix/existing", headSha: expected },
      seeded: seededCheckout,
      coordinator: publicationTag,
    });
    expect(seeded.publication).toMatchObject({ authority: { ref: "fix/existing", expectedHeadSha: expected } });
    const foreignSeed = await rulesOf({
      repoCtx: { repo: "o/r", pr: 7, ref: "fix/existing", headSha: expected },
      seeded: { ...seededCheckout, slug: "other/r" },
      coordinator: publicationTag,
    });
    expect(foreignSeed.publication).toMatchObject({ authority: { blocked: expect.any(String) } });
    const staleSeed = await rulesOf({
      repoCtx: { repo: "o/r", pr: 7, ref: "fix/existing", headSha: expected },
      seeded: { ...seededCheckout, sha: "c".repeat(40) },
      coordinator: publicationTag,
    });
    expect(staleSeed.publication).toMatchObject({ authority: { blocked: expect.stringContaining("head") } });
    const moved = await rulesOf({
      repoCtx: { repo: "o/r", pr: 7, ref: "fix/existing", headSha: expected },
      binding: { ref: "fix/existing", sha: expected, workspace: "/srv/wt/existing" },
      coordinator: publicationTag,
      freshHead: "b".repeat(40),
    });
    expect(moved.publication).toMatchObject({ authority: { blocked: expect.stringContaining("head moved") } });
    expect(push(moved, "fix/existing")).toBe("refused");
    expect(push(moved, "fix/alternate")).toBe("refused");
    // A unit child resumed from a row written before the tag carried a base
    // (run-history item 48a's second guard): the base is read from the
    // coordinator store BEFORE the session opens, so the push rules see it —
    // the unit branch is the run's own and the recovered base is protected,
    // never the unit branch itself.
    const fromStore = new InMemoryCoordinatorInstanceStore();
    await fromStore.put({
      id: "coord-2",
      kind: "ship",
      userId: "slack:UX",
      channelId: "slack:CX",
      threadKey: "slack:CX:1.0",
      repo: "o/r",
      branch: "unit/u27",
      base: "feat/trunk",
      createdAt: 0,
    });
    const recovered = await rulesOf({
      repoCtx: { repo: "o/r", ref: "unit/u27" },
      coordinator: { parentInstanceId: "coord-2", idempotencyKey: "coord-2:U27/0/coding" },
      instances: fromStore,
    });
    expect(recovered).toEqual({
      identity: "write",
      checkout: "/workspace",
      outputDir: "/var/tmp/switchboard-pi-run-l/output",
      branch: "unit/u27",
      protectedBranches: ["feat/trunk"],
      loopEndsIn: expect.any(Function),
    });
    expect(push(recovered, "unit/u27")).toBe("allowed");
    expect(push(recovered, "feat/trunk")).toBe("refused");
    // A plain thread bound at the repository's base: the run pushes a branch of its own making.
    const plain = await rulesOf({ repoCtx: { repo: "o/r", ref: "main" }, binding: { ref: "main", sha: "def" } });
    expect(plain).toEqual({
      identity: "write",
      checkout: "/workspace",
      outputDir: "/var/tmp/switchboard-pi-run-l/output",
      protectedBranches: ["main"],
      loopEndsIn: expect.any(Function),
    });
    expect(push(plain, "feat/anything")).toBe("allowed");
    expect(push(plain, "main")).toBe("refused");
  }, 15_000);

  it("a preset in a process without the harness roster, a public URL or a bearer fails the run naming what is missing", async () => {
    const noDeps = setup("", { agent: "coding", yaml: PI_YAML, harness: null, bearer: "sbr_x.y" });
    await expect(runLoop(noDeps.deps, noDeps.ctx)).rejects.toThrow(/no harness roster/);
    const noUrl = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      harness: { harnesses: roster(), registry: new HarnessRegistry() },
      bearer: "sbr_x.y",
    });
    await expect(runLoop(noUrl.deps, noUrl.ctx)).rejects.toThrow(/PUBLIC_BASE_URL/);
    const noBearer = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      harness: { harnesses: roster(), registry: new HarnessRegistry(), harnessUrl: "https://b" },
      bearer: null,
    });
    await expect(runLoop(noBearer.deps, noBearer.ctx)).rejects.toThrow(/model-proxy bearer/);
  });
});

// The relaunch tests' shared helpers, for pi's block and OpenCode's below.
/** A ledger run that records the row's state patches — the facts the relaunch writes — and the finish record its sink is handed. */
function recordingLedgerRun() {
  const states: Record<string, unknown>[] = [];
  const records: RunRecord[] = [];
  const ledgerRun = new NullLedgerRun("run-l", {
    put: async (record) => void records.push(record),
    abandoned: () => {},
  });
  ledgerRun.setState = (patch) => void states.push(patch as Record<string, unknown>);
  return { ledgerRun, states, record: () => records[0]! };
}
const harnessStates = (states: Record<string, unknown>[]) =>
  states.flatMap((s) => (s.harness ? [s.harness as Record<string, unknown>] : []));
const notesOf = (record: { events: unknown[] }) =>
  (record.events as Array<{ type: string; kind?: string; summary?: string }>)
    .filter((e) => e.type === "run_note" && (e.kind === "sandbox_restarted" || e.kind === "resumed"))
    .map((e) => ({ kind: e.kind!, summary: e.summary! }));
const harnessOver = (registry: HarnessRegistry, containerFor: () => FakeHarnessContainer): HarnessProcessDeps => ({
  harnesses: roster(),
  registry,
  harnessUrl: "https://bot.example.com",
  loopbackUrl: "http://127.0.0.1:8080",
  containerFor,
  pollMs: 1,
  tickMs: 5,
});
const mintFor = (bearers: RunBearerStore, s: ReturnType<typeof setup>) =>
  bearers.mint({
    runId: "run-l",
    modelRef: "anthropic/general-model",
    providerName: "anthropic",
    providerWire: "anthropic-messages",
    model: "general-model",
    maxTokens: 4096,
    maxTurns: 50,
    expiresAt: NOW + 60 * 60_000,
    span: s.ctx.root,
    publish: () => {},
  });

// Feature: docs/reference/specs/harness-pi.md item 10 — the review preset on
// the harness: `harness: { review: pi }` runs a review on pi under the read
// identity — pi's `--tools` holds no `edit` or `write`, the relayed tools are
// the readonly toolset's less the workspace tools, the framing is the
// dispatcher's composed review prompt with the read-only note, the gate
// refuses a write, and the verdict pi submits through the relay reaches the
// review post-step exactly as the native loop's does: the reviewed-head guard,
// the `LGTM:` line, a comment and never an approval. Without the block, or
// with `review: native`, a review is the native loop byte for byte.
// Feature: docs/reference/specs/harness.md item 6 (the survival clause's
// ceiling) and harness-pi.md item 16 (the floor beneath it) — the run stage on
// a container replaced under a living bot: the loop relaunches pi from the
// record in the container the run holds, the workspace re-attached or refused
// by name, the bearer rotated on its own meter with the row written inside the
// rotation, at most two relaunches; a refusal and the third finding close the
// run `interrupted` for the dispatcher's restart exactly as the floor did.
describe("the pi harness — the container replaced under a living bot: the relaunch ceiling", () => {
  /** A pi that opens one bash call and then meets the roll: the replacement names itself anew and the next log read is the executor's typed word. */
  function piThatMeetsTheRoll(registry: HarnessRegistry) {
    return (line: string, c: FakeHarnessContainer) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
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
      authorizeToolCall(registry.get("run-l")!, { toolCallId: "c1", tool: "bash", input: { command: "npm test" } });
      // The resident's container rolls under the run: the executor waits for
      // the wake, re-attaches to the replacement — which names itself anew —
      // and hands the next log read back as the restart (resident-repos item 65).
      c.vm = "vm-new";
      // The old container's pid is gone with it: the ask-2 probe on the word
      // finds it dead, so the verdict stands and the loop relaunches.
      c.alive = async () => false;
      const read = c.readLog.bind(c);
      c.readLog = async (path, offset, max) => {
        const chunk = await read(path, offset, max);
        if (chunk.length === 0)
          throw new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
        return chunk;
      };
    };
  }
  /** The run's workspace, re-attached on the local backend under a directory of the test's own. */
  const yamlWithWorkspace = () =>
    `${YAML}harness:\n  coding: pi\nworkspaceDir: ${mkdtempSync(join(tmpdir(), "swb-relaunch-"))}\n`;

  it("a living bot, the typed error from the log read: pi is relaunched in the replacement container from the record — nothing killed or removed for the old process, the workspace re-attached, the bearer rotated with its turns preserved and the row's hash the new secret's, one resumed note, relaunches = 1 — and the run completes with the model continuing from the rebuilt transcript", async () => {
    const registry = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: () => NOW });
    const a = new FakeHarnessContainer();
    a.onStdin = piThatMeetsTheRoll(registry);
    const b = new FakeHarnessContainer();
    b.vm = "vm-new";
    b.pid = 5151;
    const model = scriptPiFromProvider(b, {
      provider: provider("resumed and done"),
      registry,
      bearers,
      beforeModelCall: () => new Promise((r) => setTimeout(r, 10)),
    });
    const containers: FakeHarnessContainer[] = [];
    const s = setup("unused", {
      agent: "coding",
      yaml: yamlWithWorkspace(),
      harness: harnessOver(registry, () => {
        const c = containers.length === 0 ? a : b;
        containers.push(c);
        return c;
      }),
    });
    s.deps.runBearers = bearers;
    const bearer = mintFor(bearers, s);
    bearers.consumeTurn("run-l");
    bearers.consumeTurn("run-l");
    const { ledgerRun, states, record: recorded } = recordingLedgerRun();
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun, bearer }));
    expect(out.answer).toBe("resumed and done");
    expect(containers).toEqual([a, b]);
    // Nothing of the old process is judged, ended or removed in the replacement; the relaunched pi is ended as any run's is.
    expect(a.killed).toEqual([]);
    expect(a.removed).toEqual([]);
    expect(b.starts).toHaveLength(1);
    expect(b.killed).toEqual([5151]);
    // The rotation: the meter kept (two turns spent before, one by the relaunched pi), one secret — the new one, in pi's environment — and the old refused.
    expect(bearers.grantOf("run-l")).toMatchObject({ turns: 3, bearers: 1 });
    expect(bearers.verify(bearer)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-l" });
    const rotated = b.starts[0]!.env[RUN_BEARER_ENV]!;
    expect(rotated).not.toBe(bearer);
    expect(bearers.verify(rotated)).toMatchObject({ ok: true });
    // The row: the rotation's write carries the new hash and the count, and every save of the relaunched pi keeps both.
    const facts = harnessStates(states);
    expect(facts.find((f) => f.relaunches === 1)).toMatchObject({
      relaunches: 1,
      bearerHash: bearerHashOf(rotated),
      pid: 4242,
      container: "vm-fake",
    });
    expect(facts.at(-1)).toMatchObject({
      relaunches: 1,
      pid: 5151,
      container: "vm-new",
      bearerHash: bearerHashOf(rotated),
    });
    expect(
      facts.filter((f) => f.relaunches === 0).every((f) => f.pid === 4242 && f.bearerHash === bearerHashOf(bearer)),
    ).toBe(true);
    // The row learns the binding the relaunch re-attached on, as a resumed row does; the next relaunch re-attaches that one.
    expect(states.filter((p) => p.binding !== undefined)).toEqual([{ binding: { backend: "local" } }]);
    // The record: pi's verdict, then exactly one resumed note — the relaunch — and the call settled with the replaced note.
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = recorded();
    expect(record.status).toBe("completed");
    const notes = notesOf(record);
    expect(notes.map((n) => n.kind)).toEqual(["sandbox_restarted", "resumed"]);
    expect(notes[0]!.summary).toBe(
      "the container running pi was replaced (vm-fake → vm-new; the executor said: the sandbox restarted under the run (waited 42 s))",
    );
    expect(notes[1]!.summary).toBe(
      `relaunched after the container was replaced (vm-fake → vm-new): the row's pi (pid 4242) went with the old container and was neither probed nor ended here; pi restarted in the container the run holds on the mirrored transcript — 1 call(s) were in flight: 1 lost with the container, each answered with a restart note; ${ASKS.coding} min of budget left`,
    );
    expect(record.events.find((e) => e.type === "tool_result")).toMatchObject({
      tool: "bash",
      ok: false,
      callId: "c1",
      summary: expect.stringMatching(/^The container running pi was replaced while this bash call was in flight/),
    });
    // The model continued from the record: the request, the call, its settlement, then the continue.
    const req = model.requests[0]!.messages;
    expect(req[0]).toMatchObject({ role: "user" });
    expect(req[1]!.content).toEqual([{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } }]);
    const rest = req.slice(2).flatMap((m) => m.content);
    expect(rest[0]).toMatchObject({ type: "tool_result", toolUseId: "c1", isError: true });
    expect(rest.at(-1)).toMatchObject({ type: "text", text: expect.stringMatching(/^Continue where you left off/) });
    // The release the reply stage calls gives the dispatch's round back: the re-attach provisioned nothing of its own.
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["paired"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    expect(registry.get("run-l")).toBeUndefined();
    // A run no coordinator spawned publishes no child event on the roll it survived (run-history item 47a).
    expect(record.events.some((e) => e.type === "child_resumed" || e.type === "child_interrupted")).toBe(false);
  });

  it("observes a coding run after reattach in the new workspace instead of its old bound checkout", async () => {
    const registry = new HarnessRegistry();
    const old = new FakeHarnessContainer();
    old.onStdin = piThatMeetsTheRoll(registry);
    const replacement = new FakeHarnessContainer();
    replacement.vm = "vm-new";
    scriptPiFromProvider(replacement, {
      provider: provider("resumed and done"),
      registry,
      beforeModelCall: () => new Promise((resolve) => setTimeout(resolve, 10)),
    });
    const commands: string[] = [];
    const exec = vi.spyOn(LocalExecutor.prototype, "exec").mockImplementation(async (command) => {
      commands.push(command);
      return "";
    });
    try {
      let opens = 0;
      const s = setup("unused", {
        agent: "coding",
        coding: true,
        yaml: yamlWithWorkspace(),
        harness: harnessOver(registry, () => (opens++ === 0 ? old : replacement)),
        binding: { ref: "main", sha: "a".repeat(40), workspace: "/workspace/old-checkout" },
        repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
      });
      const out = answered(await runLoop(s.deps, s.ctx));
      expect(out.answer).toContain("resumed and done");
      expect(out.answer).toContain("No push was confirmed");
      expect(opens).toBe(2);
      expect(commands).toContain("git rev-parse HEAD");
      expect(commands.some((command) => command.includes("/workspace/old-checkout"))).toBe(false);
      await out.releaseWorkspace();
      s.ending.drain(undefined);
      await s.writer.settled();
    } finally {
      exec.mockRestore();
    }
  });

  it.each(["moved", "failed", "truncated", "stderr"])(
    "a canonical review rejects an unverified %s workspace before reopening its harness after container replacement",
    async (kind) => {
      const head = "a".repeat(40),
        moved = "b".repeat(40),
        ref = "fix/bound";
      const registry = new HarnessRegistry();
      const old = new FakeHarnessContainer();
      old.onStdin = piThatMeetsTheRoll(registry);
      const replacement = new FakeHarnessContainer();
      replacement.vm = "vm-new";
      const replacementProvider = provider("must not execute");
      scriptPiFromProvider(replacement, { provider: replacementProvider, registry });
      const publication = {
        repo: "o/r",
        pr: 42,
        headRef: ref,
        baseRef: "main",
        publicationRef: ref,
        expectedHeadSha: head,
        owner: { instanceId: "coord-p", unit: "ONE" },
      };
      const probe = vi.spyOn(LocalExecutor.prototype, "execResult").mockResolvedValue({
        exitCode: kind === "failed" ? 1 : 0,
        stdout: kind === "moved" ? moved : kind === "stderr" ? "" : head,
        stderr: kind === "stderr" ? head : "",
        truncated: kind === "truncated",
      });
      const exec = vi
        .spyOn(LocalExecutor.prototype, "exec")
        .mockImplementation(async (command) => (command.includes("rev-parse HEAD") ? moved : ""));
      try {
        let opens = 0;
        const s = setup("unused", {
          agent: "review",
          yaml: yamlWithWorkspace(),
          harness: harnessOver(registry, () => (opens++ === 0 ? old : replacement)),
          repoCtx: { repo: "o/r", pr: 42, ref, baseRef: "main", headSha: head },
          binding: { ref, sha: head, workspace: "/workspace/old-checkout" },
          coordinator: {
            parentInstanceId: "coord-p",
            idempotencyKey: "coord-p:ONE/1/review",
            base: "main",
            publication,
          },
          executor: {
            exec: async (command) => (command.includes("rev-parse HEAD") ? head : ""),
            execResult: async () => ({ exitCode: 0, stdout: head, stderr: "", truncated: false }),
          },
          review: { head, post: async () => ({ state: "accepted" as const }) },
        });
        s.deps.fetchPrFacts = async () => ({
          state: "open",
          headRef: ref,
          baseRef: "main",
          headSha: head,
          sameRepoHead: true,
          headBranchExists: true,
          verifiedHead: { repo: "o/r", ref, sha: head },
        });
        await expect(runLoop(s.deps, await trackedReviewContext(s))).rejects.toThrow("saved review target");
        expect(replacement.commands().filter((command) => command.type === "prompt")).toEqual([]);
      } finally {
        exec.mockRestore();
        probe.mockRestore();
      }
    },
  );

  it("a coordinator's child relaunched in the replacement container publishes child_resumed on its record — the roll survived under the run's own id, tag and budget, never a restart", async () => {
    const registry = new HarnessRegistry();
    const a = new FakeHarnessContainer();
    a.onStdin = piThatMeetsTheRoll(registry);
    const b = new FakeHarnessContainer();
    b.vm = "vm-new";
    scriptPiFromProvider(b, {
      provider: provider("resumed and done"),
      registry,
      beforeModelCall: () => new Promise((r) => setTimeout(r, 10)),
    });
    const coordinator = { parentInstanceId: "plan-p", idempotencyKey: "plan-p:u1/0/coding" };
    const containers: FakeHarnessContainer[] = [];
    const s = setup("unused", {
      agent: "coding",
      yaml: yamlWithWorkspace(),
      harness: harnessOver(registry, () => {
        const c = containers.length === 0 ? a : b;
        containers.push(c);
        return c;
      }),
      coordinator,
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("resumed and done");
    expect(containers).toEqual([a, b]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.status).toBe("completed");
    const resumed = record.events.filter((e) => e.type === "child_resumed");
    expect(resumed).toEqual([
      expect.objectContaining({
        type: "child_resumed",
        parentInstanceId: "plan-p",
        summary:
          "resumed after the container was replaced: the run's worktree was re-attached and its process relaunched from the record",
      }),
    ]);
    expect(record.events.some((e) => e.type === "child_interrupted")).toBe(false);
  });

  it("a coordinator's child that restarts from its request hands the dispatcher its coordinator tag with the interruption, so the restart is dispatched as the same instance's child — the unit branch its own, the plan's base protected", async () => {
    const registry = new HarnessRegistry();
    const a = new FakeHarnessContainer();
    a.onStdin = piThatMeetsTheRoll(registry);
    const coordinator = { parentInstanceId: "plan-p", idempotencyKey: "plan-p:u1/0/coding", base: "main" };
    const s = setup("unused", {
      agent: "coding",
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: harnessOver(registry, () => a),
      coordinator,
      binding: {
        ref: "plan/p/u1",
        sha: "0123456",
        workspace: "/workspace/threads/t/plan-p-u1",
        user: "worker2",
      } as ResidentBinding,
    });
    const round = { ...s.ctx.round, selection: { ...s.ctx.round.selection, backend: "resident" as const } };
    const out = await runLoop(s.deps, { ...s.ctx, round });
    expect(out).toMatchObject({
      kind: "interrupted",
      refusal: "workspace_lost",
      restart: { request: s.ctx.msg, restartOf: "run-l", coordinator },
    });
  });

  it("the worktree refused by name: no relaunch — the run closes interrupted with the refusal workspace_lost, the record saying why after pi's verdict, the relay forgotten, the workspace released, the card 🔁 — and the request runs again as a new run", async () => {
    const registry = new HarnessRegistry();
    const a = new FakeHarnessContainer();
    a.onStdin = piThatMeetsTheRoll(registry);
    const s = setup("unused", {
      agent: "coding",
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: harnessOver(registry, () => a),
      binding: {
        ref: "main",
        sha: "0123456",
        workspace: "/workspace/threads/t/main",
        user: "worker2",
      } as ResidentBinding,
    });
    // The round ran on a resident this process has no configuration for: the recorded binding cannot be re-attached here.
    const round = { ...s.ctx.round, selection: { ...s.ctx.round.selection, backend: "resident" as const } };
    const out = await runLoop(s.deps, { ...s.ctx, round });
    expect(out).toEqual({
      kind: "interrupted",
      reason: "workspace lost with the replaced container; restarting from the request",
      refusal: "workspace_lost",
      note: "the run's workspace could not be re-attached in the replacement container (no resident backend is configured in this process); the run restarts from its request under the same run id",
      restart: { request: s.ctx.msg, restartOf: "run-l" },
    });
    expect(a.starts).toHaveLength(1);
    expect(a.killed).toEqual([]);
    expect(a.removed).toEqual([]);
    expect(registry.get("run-l")).toBeUndefined();
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "interrupted" });
    expect(s.releases).toEqual(["paired"]);
    const close = JSON.stringify(s.closes[0]);
    expect(close).toContain("🔁");
    expect(close).toContain("workspace lost with the replaced container; restarting from the request");
    expect(close).not.toContain("❌");
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.status).toBe("interrupted");
    // The verdict, then the outcome, both the floor's kind: never a `resumed` note on a run that is not resumed.
    const notes = notesOf(record);
    expect(notes.map((n) => n.kind)).toEqual(["sandbox_restarted", "sandbox_restarted"]);
    expect(notes[0]!.summary).toBe(
      "the container running pi was replaced (vm-fake → vm-new; the executor said: the sandbox restarted under the run (waited 42 s))",
    );
    expect(notes[1]!.summary).toBe((out as { note: string }).note);
  });

  it("pauses a coding run on mid-run reattach refusal without finishing or releasing its recorded worktree", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const probe = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", probe);
    const registry = new HarnessRegistry();
    const container = new FakeHarnessContainer();
    container.onStdin = piThatMeetsTheRoll(registry);
    const s = setup("unused", {
      agent: "coding",
      yaml:
        YAML +
        "harness:\n  coding: pi\nexecution:\n  type: cloudflare\n  url: https://sandbox.example.com\n  resident:\n    baseUrl: https://resident.example.com\n",
      harness: harnessOver(registry, () => container),
      repoCtx: { repo: "acme/api", ref: "main" },
      binding: {
        ref: "main",
        sha: "0123456",
        workspace: "/workspace/threads/t/main",
        user: "worker2",
      } as ResidentBinding,
    });
    const { ledgerRun } = recordingLedgerRun();
    const pauseForRetry = vi.fn(async () => true);
    ledgerRun.pauseForRetry = pauseForRetry;
    const round = { ...s.ctx.round, selection: { ...s.ctx.round.selection, backend: "resident" as const } };
    const out = await runLoop(s.deps, {
      ...s.ctx,
      round,
      ledgerRun,
      preserveOnReattachRefusal: true,
      readyRequirementOverride: {
        testCommand: "npm test",
        dependencyDir: "node_modules",
        requiredTools: ["node", "npm"],
      },
    }).finally(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    expect(out).toMatchObject({ kind: "paused", reason: "backend_unavailable", handedOff: true });
    expect(probe).toHaveBeenCalledOnce();
    expect(pauseForRetry).toHaveBeenCalledOnce();
    expect(s.releases).toEqual([]);
    expect(s.registry.getById("run-l")).toBeNull();
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(await s.store.get("run-l")).toBeNull();
  });

  it("a refused pilot binding commit pauses before child resume or model continuation", async () => {
    const relaunch = vi.spyOn(relaunchModule, "prepareRelaunch").mockResolvedValueOnce({
      kind: "paused",
      reason: "check_failed",
      message: "The coding workspace binding could not be durably verified after re-attachment.",
    });
    const registry = new HarnessRegistry();
    const original = new FakeHarnessContainer();
    original.onStdin = piThatMeetsTheRoll(registry);
    const replacement = new FakeHarnessContainer();
    replacement.vm = "vm-new";
    const model = scriptPiFromProvider(replacement, {
      provider: provider("should not run"),
      registry,
      beforeModelCall: () => new Promise((resolve) => setTimeout(resolve, 10)),
    });
    const containers: FakeHarnessContainer[] = [];
    const s = setup("unused", {
      agent: "coding",
      yaml: yamlWithWorkspace(),
      coordinator: { parentInstanceId: "plan-p", idempotencyKey: "plan-p:u1/0/coding" },
      harness: harnessOver(registry, () => {
        const next = containers.length === 0 ? original : replacement;
        containers.push(next);
        return next;
      }),
    });
    const { ledgerRun } = recordingLedgerRun();
    const pauseForRetry = vi.fn(async () => true);
    ledgerRun.pauseForRetry = pauseForRetry;
    const publish = vi.spyOn(s.registry, "publish");
    const out = await runLoop(s.deps, {
      ...s.ctx,
      ledgerRun,
      preserveOnReattachRefusal: true,
    });
    expect(out).toMatchObject({ kind: "paused", reason: "check_failed", handedOff: true });
    expect(relaunch).toHaveBeenCalledOnce();
    expect(publish.mock.calls.some(([, event]) => event.type === "child_resumed")).toBe(false);
    expect(pauseForRetry).toHaveBeenCalledOnce();
    expect(containers).toEqual([original]);
    expect(replacement.starts).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(s.closes).toEqual([]);
    expect(s.releases).toEqual([]);
    expect(s.registry.getById("run-l")).toBeNull();
    s.ending.drain(undefined);
    await s.writer.settled();
    expect(await s.store.get("run-l")).toBeNull();
    relaunch.mockRestore();
  });

  it("pauses a pilot at the relaunch ceiling without finishing or releasing the run", async () => {
    const registry = new HarnessRegistry();
    const container = new FakeHarnessContainer();
    container.onStdin = piThatMeetsTheRoll(registry);
    const s = setup("unused", {
      agent: "coding",
      yaml: yamlWithWorkspace(),
      harness: harnessOver(registry, () => container),
    });
    const { ledgerRun, states } = recordingLedgerRun();
    const pauseForRetry = vi.fn(async () => true);
    ledgerRun.pauseForRetry = pauseForRetry;
    const out = await runLoop(s.deps, {
      ...s.ctx,
      round: { ...s.ctx.round, selection: { ...s.ctx.round.selection, backend: undefined } },
      ledgerRun,
      preserveOnReattachRefusal: true,
    });
    expect(out).toMatchObject({ kind: "paused", reason: "relaunch_ceiling", handedOff: true });
    expect(container.starts).toHaveLength(3);
    expect(Math.max(...harnessStates(states).map((f) => f.relaunches as number))).toBe(RELAUNCH_CEILING);
    expect(pauseForRetry).toHaveBeenCalledOnce();
    expect(s.releases).toEqual([]);
    expect(s.closes).toEqual([]);
    expect(s.registry.getById("run-l")).toBeNull();
  });

  it("the third finding closes the run interrupted naming the bound: two relaunches in a container that keeps dying under the run, no fourth start, the row counting each, the record carrying each verdict and relaunch, the relay forgotten, the card 🔁 — and the request runs again", async () => {
    const registry = new HarnessRegistry();
    const container = new FakeHarnessContainer();
    container.onStdin = piThatMeetsTheRoll(registry);
    const s = setup("unused", {
      agent: "coding",
      yaml: yamlWithWorkspace(),
      harness: harnessOver(registry, () => container),
    });
    const { ledgerRun, states, record: recorded } = recordingLedgerRun();
    const out = await runLoop(s.deps, { ...s.ctx, ledgerRun });
    expect(out).toEqual({
      kind: "interrupted",
      reason: "relaunch ceiling: 2 relaunches already; restarting from the request",
      refusal: "container_replaced",
      note: "the container was replaced under the run again and the relaunch ceiling is 2 (2 relaunches already), so pi is not started a fourth time; the run restarts from its request",
      restart: { request: s.ctx.msg, restartOf: "run-l" },
    });
    expect(container.starts).toHaveLength(3);
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
    const counts = harnessStates(states).map((f) => f.relaunches as number);
    expect(Math.max(...counts)).toBe(2);
    expect(counts).toEqual([...counts].sort((x, y) => x - y)); // the count never goes back
    expect(registry.get("run-l")).toBeUndefined();
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "interrupted" });
    expect(s.releases).toEqual(["paired"]);
    expect(JSON.stringify(s.closes[0])).toContain(
      "relaunch ceiling: 2 relaunches already; restarting from the request",
    );
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = recorded();
    expect(record.status).toBe("interrupted");
    expect(notesOf(record).map((n) => n.kind)).toEqual([
      "sandbox_restarted",
      "resumed",
      "sandbox_restarted",
      "resumed",
      "sandbox_restarted",
      "sandbox_restarted",
    ]);
    expect(record.events.filter((e) => e.type === "tool_result")).toHaveLength(3);
  });

  // The record clause across the roll order every image-changing release has
  // (harness.md item 6): the container rolls under the living bot (a relaunch,
  // rebuild one), then the bot rolls minutes later with pi inside its next
  // call (a resume from the ledger, rebuild two). The second rebuild is only
  // possible because the first wrote the settlement turn its session started
  // on onto the ledger.
  it("two deaths preserve the relaunch transcript while an unverified third container holds custody; pure settlement projection pairs every tool result", async () => {
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const seed: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "fix the failing test" }] }];
    const openedLedger = await ledger.open({
      runId: "run-l",
      threadKey: THREAD,
      startedAt: NOW,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: THREAD,
        agent: "coding",
        model: "anthropic/m",
        repo: "acme/api",
        ref: "main",
      },
      card: null,
      system: "the system prompt",
      tools: [],
      seed: { messages: seed, budgetMs: 45 * 60_000 },
    });
    if (openedLedger.kind !== "tracked") throw new Error("open answered untracked");
    const ledgerRun = openedLedger.run;
    const registry = new HarnessRegistry();
    const stub: Executor = { exec: async () => "ran", readFile: async () => "", writeFile: async () => "" };
    const facts: HarnessFacts[] = [];
    const agent = getAgent("coding");
    const runOf = (resume?: HarnessRun["resume"]): HarnessRun => ({
      runId: "run-l",
      agent,
      model: { id: "m", provider: "anthropic", providerType: "anthropic" },
      system: "the system prompt",
      messages: seed,
      tools: [],
      toolContext: { executor: stub },
      rules: { checkout: "/workspace/threads/t/main", protectedBranches: ["main"] },
      onEvent: () => {},
      onStep: ledgerRun.step.bind(ledgerRun),
      logIndexOf: ledgerRun.logIndexOf.bind(ledgerRun),
      saveFacts: (f) => {
        facts.push(f);
        ledgerRun.setState({ harness: f });
      },
      ...(resume ? { resume } : {}),
    });
    const depsFor = (container: FakeHarnessContainer) => ({
      container,
      bearer: "sbr_run-l.s3cret",
      harnessUrl: "https://bot.example.com",
      registry,
      clock: () => NOW,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1))),
      pollMs: 1,
      tickMs: 5,
    });
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(cond()).toBe(true);
    };

    // Death one: container A is replaced under the living bot with pi inside c1.
    const a = new FakeHarnessContainer();
    a.onStdin = piThatMeetsTheRoll(registry);
    const first = await openThroughSeam(piHarness, depsFor(a), runOf()).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(PiContainerReplacedError);
    const { deadline, ...record } = (first as PiContainerReplacedError).record;

    // The relaunch: container B, pi echoing the continue, opening c2, and the
    // bot dying inside B's next model call — after the step with c2 in flight
    // landed, before the result pi read reached any ledger row.
    const b = new FakeHarnessContainer();
    b.vm = "vm-new";
    b.pid = 5151;
    let botDies!: () => void;
    const dying = new Promise<never>((_, reject) => {
      botDies = () => reject(new Error("the bot died with this generation"));
    });
    let modelCalls = 0;
    const providerB: Provider = {
      name: "b",
      async complete() {
        modelCalls++;
        if (modelCalls === 1)
          return {
            content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "echo ok" } }],
            stopReason: "tool_use",
          };
        return dying;
      },
    };
    scriptPiFromProvider(b, { provider: providerB, registry });
    const bOpen = openThroughSeam(
      piHarness,
      depsFor(b),
      runOf({
        ...record,
        remainingMs: deadline - NOW,
        facts: { ...facts.at(-1)!, relaunches: 1 },
        relaunch: { from: "vm-fake", to: "vm-new" },
      }),
    );
    await until(() => (inner.steps.get("run-l") ?? []).some((st) => st.inFlight.some((c) => c.callId === "c2")));
    // The rejected call must be waiting before the bot dies, or no caller observes its failure.
    await until(() => modelCalls === 2);

    // Death two: the bot rolls. The next generation reads the ledger as the boot reclaim does.
    const source = transcriptSource(inner.live.get("run-l")!.meta);
    const transcript =
      source.kind === "session"
        ? await inner.readSession(source.key, source.from)
        : await inner.readTranscript("run-l");
    const plan = planResume({ transcript, lastStep: inner.steps.get("run-l")!.at(-1)!, tools: [] });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    expect(plan.messages).toEqual([
      seed[0],
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "c1",
            content: expect.stringMatching(/^The container running pi was replaced while this bash call was in flight/),
            isError: true,
          },
          { type: "text", text: expect.stringMatching(/^Continue where you left off/) },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "echo ok" } }] },
    ]);
    expect(plan.settlements.map((st) => st.toolUse.id)).toEqual(["c2"]);

    // B remains alive after the bot-only death. C has no replacement authority.
    const c = new FakeHarnessContainer();
    c.vm = "vm-third";
    const modelC = scriptPiFromProvider(c, { provider: provider("third time"), registry });
    const savedFacts = structuredClone(facts);
    const third = await openThroughSeam(
      piHarness,
      depsFor(c),
      runOf({
        messages: plan.messages,
        compactions: plan.compactions,
        settlements: plan.settlements,
        remainingMs: plan.remainingMs,
        turn: plan.turn,
        inboxConsumedSeq: plan.inboxConsumedSeq,
        facts: facts.at(-1)!,
      }),
    ).catch((error: unknown) => error);
    expect(third).toBeInstanceOf(HarnessEndingUnconfirmedError);
    expect(c.starts).toEqual([]);
    expect(c.killed).toEqual([]);
    expect(c.removed).toEqual([]);
    expect(modelC.requests).toEqual([]);
    expect(facts).toEqual(savedFacts);
    // Pure existing settlement projection: this is not a C model call or restore receipt.
    const settlement = settlementResults(plan.settlements);
    expect(settlement).toBeDefined();
    const view = [...plan.messages, settlement!];
    expect(view).toHaveLength(5);
    for (const [i, m] of view.entries())
      for (const part of m.content)
        if (part.type === "tool_use")
          expect(view[i + 1]!.content.some((q) => q.type === "tool_result" && q.toolUseId === part.id)).toBe(true);

    // Generation B, gone: its pending model call fails and its pi is ended where it ran.
    botDies();
    await expect(bOpen).rejects.toThrow(UNKNOWN_MODEL_TERMINAL_MESSAGE);
    expect(b.killed).toEqual([5151]);
    await ledgerRun.close();
  });

  it("a row write that throws inside the rotation fails the run: nothing is relaunched, no second start, both secrets still verify, the relay is forgotten and the workspace released — never a relaunch on a row that does not name the new secret", async () => {
    const registry = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: () => NOW });
    const a = new FakeHarnessContainer();
    a.onStdin = piThatMeetsTheRoll(registry);
    const s = setup("unused", { agent: "coding", yaml: yamlWithWorkspace(), harness: harnessOver(registry, () => a) });
    s.deps.runBearers = bearers;
    const bearer = mintFor(bearers, s);
    const { ledgerRun } = recordingLedgerRun();
    ledgerRun.setState = (patch) => {
      if ((patch.harness as { relaunches?: number } | undefined)?.relaunches === 1)
        throw new Error("the ledger is unreachable");
    };
    await expect(runLoop(s.deps, { ...s.ctx, ledgerRun, bearer })).rejects.toThrow("the ledger is unreachable");
    expect(a.starts).toHaveLength(1);
    expect(bearers.grantOf("run-l")).toMatchObject({ bearers: 2, revoked: false });
    expect(bearers.verify(bearer).ok).toBe(true);
    expect(registry.get("run-l")).toBeUndefined();
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["paired"]);
  });
});

// Feature: docs/reference/specs/harness.md items 6 and 8 — the relaunch ceiling on the
// second harness, reached through the configuration word: `harness: { coding: opencode }`
// puts the coding run on the roster's OpenCode; the fake serve replaces the container with
// a call in flight; the loop relaunches from the record into the replacement, the bearer
// rotated, `relaunches: 1` on the row, and the run completes on the continuation. The
// precondition of any preset's word being `opencode` (the plan's configuration-word unit).
describe("the OpenCode harness — the container replaced under a living bot, reached through the configuration word", () => {
  const yamlOnOpenCode = () =>
    `${YAML}harness:\n  coding: opencode\nworkspaceDir: ${mkdtempSync(join(tmpdir(), "swb-relaunch-oc-"))}\n`;
  const REPLACED = "vm-new";

  it("a living bot, the typed error from the feed read: OpenCode is relaunched in the replacement container from the record — nothing killed or removed for the old server, the workspace re-attached, the bearer rotated with its turns preserved and the row's hash the new secret's, one resumed note, relaunches = 1 — and the run completes with the model continuing from the imported record", async () => {
    const registry = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: () => NOW });
    // Container a: the first server. Its scripted model opens one bash call; the bot's gate
    // answers the ask; the container is replaced with the call in flight — the serve renames
    // the container and arms the next drained feed read with the executor's word.
    const a = new FakeHarnessContainer();
    const serveA = scriptOpenCodeServe(a, {
      registry,
      bearers,
      options: { replacedWord: REPLACED },
      script: {
        turns: [
          { content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } }] },
          { content: [{ type: "text", text: "never reached on the first server" }] },
        ],
        containerReplacedBeforeModelCall: 2,
      },
    });
    // Container b: the replacement. Its serve takes the record as an authored-session import
    // (the request, the call, its settlement) and plays the continuation.
    const b = new FakeHarnessContainer();
    b.vm = REPLACED;
    b.pid = 5151;
    const serveB = scriptOpenCodeServe(b, {
      registry,
      bearers,
      script: { turns: [{ content: [{ type: "text", text: "resumed and done" }] }] },
    });
    const containers: FakeHarnessContainer[] = [];
    const s = setup("unused", {
      agent: "coding",
      yaml: yamlOnOpenCode(),
      harness: harnessOver(registry, () => {
        const c = containers.length === 0 ? a : b;
        containers.push(c);
        return c;
      }),
    });
    s.deps.runBearers = bearers;
    const bearer = mintFor(bearers, s);
    bearers.consumeTurn("run-l");
    bearers.consumeTurn("run-l");
    const { ledgerRun, states, record: recorded } = recordingLedgerRun();
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun, bearer }));
    expect(out.answer).toBe("resumed and done");
    expect(containers).toEqual([a, b]);
    // The word picked OpenCode for the coding preset: both containers started `opencode` (and
    // its tailer), never `pi`.
    const servers = (c: FakeHarnessContainer) => c.starts.filter((st) => st.command === "opencode");
    expect(servers(a)).toHaveLength(1);
    expect(servers(b)).toHaveLength(1);
    expect([...a.starts, ...b.starts].some((st) => st.command === "pi")).toBe(false);
    // Nothing of the old server is judged, ended or removed in the replacement (`end` under
    // the replaced verdict kills and removes nothing); the relaunched server and its tailer
    // are ended as any run's are.
    expect(a.killed).toEqual([]);
    expect(a.removed).toEqual([]);
    expect(b.killed).toContain(5151);
    // The rotation: the meter kept (two turns spent before, one by each server), one secret —
    // the new one, in the server's environment — and the old refused.
    expect(bearers.grantOf("run-l")).toMatchObject({ turns: 4, bearers: 1 });
    expect(bearers.verify(bearer)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-l" });
    const rotated = servers(b)[0]!.env[RUN_BEARER_ENV]!;
    expect(rotated).not.toBe(bearer);
    expect(bearers.verify(rotated)).toMatchObject({ ok: true });
    // The row: OpenCode's facts — the rotation's write carries the new hash and the count, and
    // every save of the relaunched server keeps both.
    const facts = harnessStates(states);
    expect(facts.find((f) => f.relaunches === 1)).toMatchObject({
      harness: "opencode",
      relaunches: 1,
      bearerHash: bearerHashOf(rotated),
      container: "vm-fake",
    });
    expect(facts.at(-1)).toMatchObject({
      harness: "opencode",
      relaunches: 1,
      pid: 5151,
      container: REPLACED,
      bearerHash: bearerHashOf(rotated),
      sessionID: expect.any(String),
      port: expect.any(Number),
      root: "/var/tmp/switchboard-oc-run-l",
    });
    expect(facts.filter((f) => f.relaunches === 0).every((f) => f.bearerHash === bearerHashOf(bearer))).toBe(true);
    // The row learns the binding the relaunch re-attached on, as a resumed row does.
    expect(states.filter((p) => p.binding !== undefined)).toEqual([{ binding: { backend: "local" } }]);
    // The record: the harness's verdict, then exactly one resumed note — the relaunch — and the
    // call settled with the replaced note.
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = recorded();
    expect(record.status).toBe("completed");
    const notes = notesOf(record);
    expect(notes.map((n) => n.kind)).toEqual(["sandbox_restarted", "resumed"]);
    expect(notes[0]!.summary).toBe(
      `the container running OpenCode was replaced (vm-fake → ${REPLACED}; the executor said: harness container: read failed — runtime-replaced: the sandbox was replaced under the run)`,
    );
    expect(notes[1]!.summary).toMatch(
      /^relaunched after the container was replaced \(vm-fake → vm-new\); a fresh server was started on the record with \d+ min of budget left$/,
    );
    expect(record.events.find((e) => e.type === "tool_result")).toMatchObject({
      tool: "bash",
      ok: false,
      callId: "c1",
      summary: openCodeReplacedCallNote("bash"),
    });
    // The model continued from the record, imported into the replacement's store: the first
    // server saw only the request; the second's first call carries the call and its settlement.
    expect(serveA.modelCalls).toHaveLength(1);
    expect(serveB.modelCalls).toHaveLength(1);
    const imported = JSON.stringify(serveB.modelCalls[0]!.messages);
    expect(imported).toContain('"c1"');
    expect(imported).toContain(openCodeReplacedCallNote("bash"));
    // The release the reply stage calls gives the dispatch's round back: the re-attach provisioned nothing of its own.
    await out.releaseWorkspace();
    expect(s.releases).toEqual(["paired"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    expect(registry.get("run-l")).toBeUndefined();
  });
});

describe("the pi harness — the review preset", () => {
  const REVIEW_PI_YAML = YAML + "harness:\n  review: pi\n";
  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const VERDICT = {
    verdict: "approve",
    summary: "looks correct",
    head: HEAD,
    findings: [{ id: "F1", kind: "single", severity: "nit", file: "src/x.ts", line: 3, title: "a name" }],
  };
  const prThread = {
    repoCtx: { repo: "o/r", pr: 42, ref: "fix/the-pr-head", refFromPr: true, baseRef: "main" } as RepoContext,
    binding: { ref: "fix/the-pr-head", sha: HEAD, workspace: "/srv/wt/pr-42" } as ResidentBinding,
    executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
  };
  const assistant = (content: Record<string, unknown>[], stopReason = "toolUse") => ({
    role: "assistant",
    content,
    stopReason,
  });

  function seedReviewHistory(deps: RunDeps, currentHead: () => string) {
    const gh = new InMemoryGithubApi({
      "o/r": {
        pulls: [
          {
            number: 42,
            title: "Fix behavior",
            body: "",
            state: "open",
            draft: false,
            url: "https://github.com/o/r/pull/42",
            author: "author",
            updatedAt: "2026-01-01T00:00:00Z",
            head: { repo: "o/r", ref: "fix/the-pr-head", sha: HEAD },
            base: { repo: "o/r", ref: "main" },
          },
        ],
      },
    });
    const read = gh.getPullRequest.bind(gh);
    gh.getPullRequest = async (repo, number) => {
      const pr = await read(repo, number);
      return { ...pr, head: { ...pr.head, sha: currentHead() } };
    };
    deps.githubApi = gh;
  }

  async function scriptedHistoryRead(c: FakeHarnessContainer, live: LiveHarness, id: string) {
    const args = { repo: "o/r", number: 42, includeReviewHistory: true };
    const t = assistant([{ type: "toolCall", id, name: "github_pull_get", arguments: args }]);
    c.emit(
      { type: "message_end", message: t },
      { type: "tool_execution_start", toolCallId: id, toolName: "github_pull_get", args },
    );
    authorizeToolCall(live, { toolCallId: id, tool: "github_pull_get", input: args });
    const answer = await runRelayedTool(live, { toolCallId: id, tool: "github_pull_get", input: args });
    expect(answer.isError).toBe(false);
    expect(live.toolContext.reviewHistory?.snapshot?.head).toBeDefined();
    c.emit(
      {
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "github_pull_get",
        result: { content: answer.content },
        isError: answer.isError,
      },
      { type: "turn_end", message: t, toolResults: [] },
    );
  }

  /** A review's pi: reads the head, tries an `edit` the gate refuses (the
   *  extension blocks it and pi ends it as an error — nothing ran), submits
   *  the verdict through the relay as the real extension does (`POST
   *  /harness/tool`), then answers. */
  function scriptedReviewPi(container: FakeHarnessContainer, registry: HarnessRegistry, finalText: string) {
    container.onStdin = async (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      const live = registry.get("run-l")!;
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const probe = { command: "git rev-parse HEAD", purpose: "verification" };
      const t1 = assistant([{ type: "toolCall", id: "c1", name: "run_check", arguments: probe }]);
      c.emit(
        { type: "message_end", message: t1 },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "run_check", args: probe },
      );
      expect(await authorizeToolCall(live, { toolCallId: "c1", tool: "run_check", input: probe })).toEqual({
        allow: true,
      });
      const check = await runRelayedTool(live, { toolCallId: "c1", tool: "run_check", input: probe });
      expect(check.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("completed with exit 0") }),
      ]);
      c.emit(
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "run_check",
          result: { content: check.content },
          isError: check.isError,
        },
        { type: "turn_end", message: t1, toolResults: [] },
      );
      const edit = { path: "src/x.ts", oldText: "a", newText: "b" };
      const t2 = assistant([{ type: "toolCall", id: "c2", name: "edit", arguments: edit }]);
      c.emit(
        { type: "message_end", message: t2 },
        { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: edit },
      );
      const gate = immediateToolVerdict(live, { toolCallId: "c2", tool: "edit", input: edit });
      c.emit(
        {
          type: "tool_execution_end",
          toolCallId: "c2",
          toolName: "edit",
          result: { content: [{ type: "text", text: `Tool execution blocked: ${gate.allow ? "" : gate.reason}` }] },
          isError: true,
        },
        { type: "turn_end", message: t2, toolResults: [] },
      );
      await scriptedHistoryRead(c, live, "history");
      const t3 = assistant([{ type: "toolCall", id: "c3", name: "submit_verdict", arguments: VERDICT }]);
      c.emit(
        { type: "message_end", message: t3 },
        { type: "tool_execution_start", toolCallId: "c3", toolName: "submit_verdict", args: VERDICT },
      );
      authorizeToolCall(live, { toolCallId: "c3", tool: "submit_verdict", input: VERDICT });
      void runRelayedTool(live, { toolCallId: "c3", tool: "submit_verdict", input: VERDICT }).then((answer) => {
        c.emit(
          {
            type: "tool_execution_end",
            toolCallId: "c3",
            toolName: "submit_verdict",
            result: { content: answer.content },
            isError: answer.isError,
          },
          { type: "turn_end", message: t3, toolResults: [] },
        );
        const done = assistant([{ type: "text", text: finalText }], "stop");
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          {
            type: "agent_settled",
          },
        );
      });
    };
  }

  it("`harness: { review: pi }` runs the review on pi under the read identity: no edit or write on pi's allowlist, the readonly toolset relayed, the read-only note in the framing, a write refused by the gate with a tool_refused note, and the relayed verdict posted to the pull request as `LGTM:` behind the reviewed-head guard", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    scriptedReviewPi(container, registry, "The review: one nit, F1.");
    let providerCalls = 0;
    const provider: Provider = {
      name: "fake",
      async complete() {
        providerCalls++;
        return { content: [{ type: "text", text: "native answer" }], stopReason: "end_turn" };
      },
    };
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const s = setup("", {
      agent: "review",
      provider,
      yaml: REVIEW_PI_YAML,
      harness: { harnesses: roster(), registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
      bearer: "sbr_run-l.s3cret",
      ...prThread,
      executor: {
        ...prThread.executor,
        execResult: async (command: string) => ({
          stdout: command.startsWith("set -eu") ? `/srv/wt/pr-42\n${HEAD}\n${"b".repeat(40)}\n` : HEAD,
          stderr: "",
          exitCode: 0,
          truncated: false,
        }),
      },
      review: {
        head: HEAD,
        post: async (target, body) => {
          posts.push({ target, body });
          return { state: "accepted" as const };
        },
      },
    });
    seedReviewHistory(s.deps, () => HEAD);
    const ctx = await trackedCodingContext(s, s.ctx, s.ctx.msg.threadKey, (inner) => {
      const claim = inner.claim.bind(inner);
      inner.claim = (request) =>
        claim({ ...request, meta: { ...request.meta, readonly: true, profile: s.ctx.profile } });
    });
    const out = answered(await runLoop(s.deps, ctx));
    expect(out.answer).toBe("The review: one nit, F1.");
    expect(providerCalls).toBe(0);
    // The process: pi's allowlist for a read identity, the readonly toolset's relays, the bearer, the framing.
    expect(container.starts).toHaveLength(1);
    const args = container.starts[0].args;
    const tools = args[args.indexOf("--tools") + 1].split(",");
    expect(tools.slice(0, 4)).toEqual(["read", "grep", "find", "ls"]);
    expect(tools).not.toContain("bash");
    expect(tools).toContain("run_check");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(tools).toEqual(expect.arrayContaining(["update_status", "submit_verdict", "diff_digest", "web_fetch"]));
    expect(tools).not.toContain("submit_pr_description");
    expect(tools).not.toContain("write_file");
    expect(container.starts[0].env.SWITCHBOARD_RUN_BEARER).toBe("sbr_run-l.s3cret");
    const system = container.files.get("/var/tmp/switchboard-pi-run-l/agent/SYSTEM.md")!;
    expect(system.startsWith("the system prompt\n\nHARNESS NOTE:")).toBe(true);
    expect(system).toContain("Native `bash` is unavailable");
    expect(system).not.toContain("`write_file` use `write`");
    // The gate's rules read the preset's identity.
    // The verdict path: the same post-step, the same guard, the same first line — a comment, never an approval.
    expect(posts).toEqual([
      {
        target: { repo: "o/r", number: 42, commitId: HEAD },
        body: buildReviewPostBody("The review: one nit, F1.", parseVerdictInput(VERDICT)!, { repo: "o/r", head: HEAD }),
      },
    ]);
    expect(container.killed).toEqual([4242]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "run_check",
      "edit",
      "github_pull_get",
      "submit_verdict",
    ]);
    expect(rec.events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "tool_refused")).toEqual([
      expect.objectContaining({
        kind: "tool_refused",
        summary: "edit refused: edit is the `write-files` bundle, outside the read identity's reach",
      }),
    ]);
    expect(rec.events.filter((e) => e.type === "review_posted")).toEqual([
      expect.objectContaining({ type: "review_posted", repo: "o/r", number: 42, head: HEAD, verdict: "approve" }),
    ]);
    expect(rec.reviewPost).toEqual({
      posted: true,
      target: { repo: "o/r", number: 42 },
      head: HEAD,
      verdict: "approve",
    });
  });

  // harness-pi item 14, agent-review item 12: the PR's head moves substantively
  // while pi reviews it. The settle's one more turn is a `prompt` on the same
  // pi session — the process that reviewed, still alive on its transcript —
  // never a second pi and never the native loop; the second verdict, relayed
  // through the same registry entry under the turn's own capture, is the one
  // posted, pinned to the new head; pi is ended once the settle is done.
  it.each(["fresh matching history", "stale history in verdict-only follow-up"])(
    "a substantive head move mid-review on pi re-reviews as a prompt on the same pi session: the old SHA cannot authorize the new head (%s)",
    async (mode) => {
      const NEW = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
      const container = new FakeHarnessContainer();
      const registry = new HarnessRegistry();
      let worktreeHead = HEAD;
      const moves: string[] = [];
      const executor = {
        exec: async (command: string) => (command.includes("rev-parse") ? `${worktreeHead}\n` : ""),
        execResult: async () => ({ exitCode: 0, stdout: worktreeHead + "\n", stderr: "", truncated: false }),
        moveTo: async (sha: string) => {
          moves.push(sha);
          worktreeHead = sha;
          return { sha };
        },
      };
      let historyHead = HEAD;
      const refresh = mode === "fresh matching history";
      const killedWhenPrompted: number[][] = [];
      // A review's pi answering TWO prompts on one session: the request with a
      // verdict at the pinned head, then the re-review's follow-up with a verdict
      // at the new head — each through the relay as the real extension submits it.
      let prompts = 0;
      container.onStdin = async (line, c) => {
        const cmd = JSON.parse(line) as Record<string, unknown>;
        if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
          c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
        if (cmd.type !== "prompt") return;
        const n = prompts++;
        killedWhenPrompted.push([...container.killed]);
        const live = registry.get("run-l")!;
        c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
        const verdict =
          n === 0 ? VERDICT : { verdict: "request_changes", summary: "the new test is wrong", head: NEW, findings: [] };
        const reject = async (head: string, error: string) => {
          const args = { ...verdict, verdict: "approve", head };
          const callId = `stale-${n}-${head}-${error.length}`;
          authorizeToolCall(live, { toolCallId: callId, tool: "submit_verdict", input: args });
          const rejected = await runRelayedTool(live, { toolCallId: callId, tool: "submit_verdict", input: args });
          expect(JSON.stringify(rejected.content)).toContain(error);
          expect(posts).toEqual([]);
        };
        if (n === 1) {
          expect(worktreeHead).toBe(NEW);
          await reject("HEAD", "error: a valid reviewed commit head");
          await reject(HEAD, "error: reviewed head differs from the required review head");
          expect(live.toolContext.reviewHistory?.snapshot).toBeUndefined();
          expect(live.toolContext.reviewHistory?.progress).toBeUndefined();
          await reject(NEW, "error: read complete PR history");
          // Even a complete read that still returns A cannot bind the re-review at B.
          await scriptedHistoryRead(c, live, "history-stale");
          expect(live.toolContext.reviewHistory?.snapshot?.head).toBe(HEAD);
          await reject(HEAD, "error: reviewed head differs from the required review head");
          await reject(NEW, "error: reviewed head differs from the history snapshot");
          if (refresh) historyHead = NEW;
        }
        if (n === 2) {
          // The verdict-only prompt uses the original context, not the re-review's
          // copied sink. Its required head must still be B despite cached A history.
          expect(worktreeHead).toBe(NEW);
          expect(live.toolContext.reviewHistory?.snapshot?.head).toBe(HEAD);
          await reject(HEAD, "error: reviewed head differs from the required review head");
        }
        if (!refresh && n > 0) {
          const done = assistant([{ type: "text", text: "Second review: no valid verdict." }], "stop");
          c.emit(
            { type: "message_end", message: done },
            { type: "turn_end", message: done, toolResults: [] },
            { type: "agent_settled" },
          );
          return;
        }
        await scriptedHistoryRead(c, live, `history-${n}`);
        const id = `v${n}`;
        const t = assistant([{ type: "toolCall", id, name: "submit_verdict", arguments: verdict }]);
        c.emit(
          { type: "message_end", message: t },
          { type: "tool_execution_start", toolCallId: id, toolName: "submit_verdict", args: verdict },
        );
        authorizeToolCall(live, { toolCallId: id, tool: "submit_verdict", input: verdict });
        void runRelayedTool(live, { toolCallId: id, tool: "submit_verdict", input: verdict }).then((answer) => {
          c.emit(
            {
              type: "tool_execution_end",
              toolCallId: id,
              toolName: "submit_verdict",
              result: { content: answer.content },
              isError: answer.isError,
            },
            { type: "turn_end", message: t, toolResults: [] },
          );
          const done = assistant(
            [{ type: "text", text: n === 0 ? "First review: approve." : "Second review: the new test is wrong." }],
            "stop",
          );
          c.emit(
            { type: "message_end", message: done },
            { type: "turn_end", message: done, toolResults: [] },
            { type: "agent_settled" },
          );
        });
      };
      const list = (subjects: string[]): PrCommitList => ({
        commits: subjects.map((message, i) => ({ sha: `${i + 1}`.repeat(40), message })),
        files: ["src/x.ts"],
        filesTruncated: false,
      });
      const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
      const s = setup("", {
        agent: "review",
        // The re-review's note is an ack (item 28): asked for here so the thread shows it.
        verbosity: "verbose",
        provider: provider("unused"),
        yaml: REVIEW_PI_YAML,
        harness: {
          harnesses: roster(),
          registry,
          harnessUrl: "https://bot.example.com",
          containerFor: () => container,
        },
        bearer: "sbr_run-l.s3cret",
        repoCtx: prThread.repoCtx,
        binding: prThread.binding,
        executor,
        review: {
          head: HEAD,
          post: async (target, body) => {
            posts.push({ target, body });
            return { state: "accepted" as const };
          },
          currentHead: NEW,
          commits: (sha) =>
            sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"]),
        },
      });
      seedReviewHistory(s.deps, () => historyHead);
      const out = answered(await runLoop(s.deps, await trackedReviewContext(s)));
      // One pi survives the re-review and, if needed, the verdict-only prompt.
      expect(container.starts).toHaveLength(1);
      expect(prompts).toBe(refresh ? 2 : 3);
      expect(killedWhenPrompted).toEqual(refresh ? [[], []] : [[], [], []]);
      expect(moves).toEqual([NEW]);
      const followUp = container.stdin
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((c) => c.type === "prompt")[1];
      expect(String(followUp.message)).toContain("moved from a1b2c3d to d75b5a5");
      expect(String(followUp.message)).toContain("Switchboard has already moved your worktree to d75b5a5");
      // the second verdict and answer are the run's; posted once, pinned to the new head
      const answer = refresh ? "Second review: the new test is wrong." : "Second review: no valid verdict.";
      expect(out.answer).toBe(answer);
      expect(out.reviewHead).toBe(NEW);
      expect(posts).toEqual([
        {
          target: { repo: "o/r", number: 42, commitId: NEW },
          body: expect.stringContaining(`### Full review\n\n${answer}\n\n</details>`),
        },
      ]);
      expect(
        posts[0].body.startsWith(
          refresh ? "Changes requested: no issues found\n" : "No verdict submitted — not approving.",
        ),
      ).toBe(true);
      expect(s.published).toEqual([`answer:${answer}`]);
      expect(s.replies.some((r) => r.startsWith("🔀 o/r#42 moved during the run"))).toBe(true);
      // pi ended once, after the settle
      expect(container.killed).toEqual([4242]);
      expect(container.removed).toEqual(["/var/tmp/switchboard-pi-run-l"]);
      expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
      s.ending.drain(true);
      await s.writer.settled();
      const rec = (await s.store.get("run-l"))!;
      expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
        "github_pull_get",
        "submit_verdict",
        "github_pull_get",
        ...(refresh ? ["github_pull_get", "submit_verdict"] : []),
      ]);
      if (!refresh) {
        expect(rec.verdict).toBeUndefined();
        expect(posts[0].body).not.toMatch(/^LGTM:/);
        expect(rec.reviewPost).not.toHaveProperty("verdict");
      }
      expect(rec.events.some((e) => e.type === "run_note" && (e as { kind: string }).kind === "head_moved")).toBe(true);
      expect(rec.events.filter((e) => e.type === "review_posted")).toEqual([
        expect.objectContaining({
          type: "review_posted",
          head: NEW,
          ...(refresh ? { verdict: "request_changes" } : {}),
        }),
      ]);
    },
  );
});

// Feature: docs/reference/specs/harness-pi.md item 12: a preset without a
// workspace on the harness. `harness: { general: pi }` runs a general ask on
// pi as a child of the bot itself (the run's machine class is `none`, so
// there is no container to exec through, and the loopback URL is where pi
// reaches the bot's own server), with none of pi's own tools on its allowlist
// and the `assistant` toolset relayed; a built-in tool pi asks for all the
// same is refused by name; the record replays like a native run's. Without
// the key, or with `general: native`, a general ask is the native loop byte
// for byte and pi never starts.
describe("the pi harness — a preset without a workspace, as a child of the bot", () => {
  const GENERAL_PI_YAML = YAML + "harness:\n  general: pi\n";
  const assistant = (content: Record<string, unknown>[], stopReason = "toolUse") => ({
    role: "assistant",
    content,
    stopReason,
  });

  /** A pi that asks the gate for a shell it was never given (refused), then
   *  calls the relayed `update_status` through the bot as the real extension
   *  does (`POST /harness/tool`), then answers. */
  function scriptedGeneralPi(container: FakeHarnessContainer, registry: HarnessRegistry, finalText: string) {
    const refusals: Array<{ allow: boolean; reason?: string }> = [];
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      const live = registry.get("run-l")!;
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const shell = { command: "ls" };
      const t1 = assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: shell }]);
      c.emit(
        { type: "message_end", message: t1 },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: shell },
      );
      const gate = immediateToolVerdict(live, { toolCallId: "c1", tool: "bash", input: shell });
      refusals.push(gate);
      c.emit(
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "bash",
          result: { content: [{ type: "text", text: `Tool execution blocked: ${gate.allow ? "" : gate.reason}` }] },
          isError: true,
        },
        { type: "turn_end", message: t1, toolResults: [] },
      );
      const status = { checklist: "- [x] looked it up" };
      const t2 = assistant([{ type: "toolCall", id: "c2", name: "update_status", arguments: status }]);
      c.emit(
        { type: "message_end", message: t2 },
        { type: "tool_execution_start", toolCallId: "c2", toolName: "update_status", args: status },
      );
      authorizeToolCall(live, { toolCallId: "c2", tool: "update_status", input: status });
      void runRelayedTool(live, { toolCallId: "c2", tool: "update_status", input: status }).then((answer) => {
        c.emit(
          {
            type: "tool_execution_end",
            toolCallId: "c2",
            toolName: "update_status",
            result: { content: answer.content },
            isError: answer.isError,
          },
          { type: "turn_end", message: t2, toolResults: [] },
        );
        const done = assistant([{ type: "text", text: finalText }], "stop");
        c.emit(
          { type: "message_end", message: done },
          { type: "turn_end", message: done, toolResults: [] },
          { type: "agent_settled" },
        );
      });
    };
    return refusals;
  }

  it("`harness: { general: pi }` runs a general ask on pi on the bot host: the container is asked for by the `none` machine class, pi reaches the bot over loopback, its allowlist is the assistant toolset's relays and none of pi's own tools, the note says so, a shell pi asks for is refused by name, the relayed update_status runs in the bot, and pi's answer is the run's", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    const refusals = scriptedGeneralPi(container, registry, "General says done.");
    const asked: string[] = [];
    let providerCalls = 0;
    const provider: Provider = {
      name: "fake",
      async complete() {
        providerCalls++;
        return { content: [{ type: "text", text: "native answer" }], stopReason: "end_turn" };
      },
    };
    const s = setup("", {
      provider,
      yaml: GENERAL_PI_YAML,
      harness: {
        harnesses: roster(),
        registry,
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: (_executor, machine) => {
          asked.push(machine);
          return container;
        },
      },
      bearer: "sbr_run-l.s3cret",
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("General says done.");
    expect(providerCalls).toBe(0);
    expect(asked).toEqual(["none"]);
    expect(container.starts).toHaveLength(1);
    const start = container.starts[0];
    expect(start.env.SWITCHBOARD_HARNESS_URL).toBe("http://127.0.0.1:8080");
    expect(start.env.SWITCHBOARD_RUN_BEARER).toBe("sbr_run-l.s3cret");
    const tools = start.args[start.args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual([
      "web_fetch",
      "update_status",
      "github_repos",
      "github_file",
      "github_tree",
      "github_search_code",
      "github_issue_list",
      "github_issue_get",
      "github_pull_get",
      "github_actions_run",
      "github_actions_job_log",
      "github_issue_create",
      "github_issue_update",
      "github_issue_comment",
      "github_issue_delete",
    ]);
    for (const own of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(tools).not.toContain(own);
    const models = JSON.parse(container.files.get("/var/tmp/switchboard-pi-run-l/agent/models.json")!);
    expect(models.providers.switchboard.baseUrl).toBe("http://127.0.0.1:8080");
    const system = container.files.get("/var/tmp/switchboard-pi-run-l/agent/SYSTEM.md")!;
    expect(system.startsWith("the system prompt\n\nHARNESS NOTE:")).toBe(true);
    expect(system).toContain("none of pi's own tools");
    expect(refusals).toEqual([
      {
        allow: false,
        reason: "bash is the `shell` bundle: a run without a workspace (identity none) has none of pi's own tools",
      },
    ]);
    // The relayed tool ran in the bot with the run's own context: the card's checklist is its.
    expect(s.frames.some((f) => f.detail?.includes("looked it up"))).toBe(true);
    expect(container.killed).toEqual([4242]);
    expect(container.removed).toEqual(["/var/tmp/switchboard-pi-run-l"]);
    expect(s.published).toEqual(["answer:General says done."]);
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "bash",
      "update_status",
    ]);
    expect(rec.events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "tool_refused")).toEqual([
      expect.objectContaining({
        summary:
          "bash refused: bash is the `shell` bundle: a run without a workspace (identity none) has none of pi's own tools",
      }),
    ]);
  });

  it("a preset without a workspace on pi in a process without the loopback URL fails the run naming PORT: the public URL alone is not where a bot-host pi reaches the bot", async () => {
    const s = setup("", {
      yaml: GENERAL_PI_YAML,
      harness: { harnesses: roster(), registry: new HarnessRegistry(), harnessUrl: "https://bot.example.com" },
      bearer: "sbr_run-l.s3cret",
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow(/PORT/);
  });

  // harness-pi item 12, the research and conductor presets: the same bot-host
  // path as general, each with its own toolset relayed and nothing else; the
  // conductor's spawn through the relay (agent-conductor item 3).
  const RESEARCH_PI_YAML = YAML + "harness:\n  research: pi\n";
  const CONDUCTOR_PI_YAML = YAML + "harness:\n  conductor: pi\n";
  const GITHUB_READS = [
    "github_repos",
    "github_file",
    "github_tree",
    "github_search_code",
    "github_issue_list",
    "github_issue_get",
    "github_pull_get",
    "github_actions_run",
    "github_actions_job_log",
  ];
  const rpcAnswers = (cmd: Record<string, unknown>, c: FakeHarnessContainer) => {
    if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
      c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
  };
  const textOf = (answer: RelayedToolAnswer) => answer.content.map((p) => (p.type === "text" ? p.text : "")).join("");

  /** One relayed call as the extension makes it: announced by pi, asked of the
   *  gate, then asked of the relay until it answers; the call's end, its result
   *  as pi's own entry and the turn's end emitted after. */
  async function relayedTurn(
    c: FakeHarnessContainer,
    live: LiveHarness,
    calls: RelayedCalls,
    ask: ToolCallAsk,
    text?: string,
  ): Promise<RelayedToolAnswer> {
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
    return answer;
  }
  const settle = (c: FakeHarnessContainer, text: string) => {
    const done = assistant([{ type: "text", text }], "stop");
    c.emit(
      { type: "message_end", message: done },
      { type: "turn_end", message: done, toolResults: [] },
      { type: "agent_settled" },
    );
  };

  it("`harness: { research: pi }` runs a research ask on pi on the bot host: the container asked for by the `none` class, pi reaching the bot over loopback, the allowlist the web toolset's relays and none of pi's own tools, a shell refused by name, the relayed web_fetch run in the bot under its own URL guard, and pi's answer the run's", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    const asked: string[] = [];
    const refusals: Array<{ allow: boolean; reason?: string }> = [];
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      rpcAnswers(cmd, c);
      if (cmd.type !== "prompt") return;
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const live = registry.get("run-l")!;
      const calls = registry.calls("run-l")!;
      void (async () => {
        const shell = { command: "curl http://127.0.0.1:8080/secret" };
        const t1 = assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: shell }]);
        c.emit(
          { type: "message_end", message: t1 },
          { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: shell },
        );
        const gate = immediateToolVerdict(live, { toolCallId: "c1", tool: "bash", input: shell });
        refusals.push(gate);
        c.emit(
          {
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "bash",
            result: { content: [{ type: "text", text: `Tool execution blocked: ${gate.allow ? "" : gate.reason}` }] },
            isError: true,
          },
          { type: "turn_end", message: t1, toolResults: [] },
        );
        const fetched = await relayedTurn(c, live, calls, {
          toolCallId: "c2",
          tool: "web_fetch",
          input: { url: "http://127.0.0.1:8080/secret" },
        });
        settle(c, `Research says: ${textOf(fetched)}`);
      })();
    };
    const s = setup("", {
      agent: "research",
      yaml: RESEARCH_PI_YAML,
      harness: {
        harnesses: roster(),
        registry,
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: (_executor, machine) => {
          asked.push(machine);
          return container;
        },
      },
      bearer: "sbr_run-l.s3cret",
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toMatch(/^Research says: web_fetch refused: /);
    expect(asked).toEqual(["none"]);
    expect(container.starts).toHaveLength(1);
    const start = container.starts[0];
    expect(start.env.SWITCHBOARD_HARNESS_URL).toBe("http://127.0.0.1:8080");
    expect(start.env.SWITCHBOARD_RUN_BEARER).toBe("sbr_run-l.s3cret");
    const tools = start.args[start.args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(["web_fetch", "web_search", "update_status", ...GITHUB_READS]);
    for (const own of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(tools).not.toContain(own);
    expect(refusals).toEqual([
      {
        allow: false,
        reason: "bash is the `shell` bundle: a run without a workspace (identity none) has none of pi's own tools",
      },
    ]);
    expect(container.killed).toEqual([4242]);
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "bash",
      "web_fetch",
    ]);
  });

  /** A spawning run over the real stage with `dispatch()` stubbed: a dispatched child registers at once; what it was dispatched with is kept. */
  function stubbedSpawn() {
    const dispatched: Array<{ text: string; opts: unknown }> = [];
    const leads: string[] = [];
    const quiet: ChannelIO = {
      reply: async () => {},
      status: async () => ({ update: () => {}, done: async () => {} }),
      history: async () => [],
    };
    const deps: SpawnDeps = {
      core: {
        config: { config: {}, grantsFor: () => new Set(), canRunAgent: () => true },
        runStore: {},
        runLedger: { pushInbox: async () => ({ ok: true }) },
      } as unknown as SpawnDeps["core"],
      dispatch: async (_core, message, childIo, opts) => {
        dispatched.push({ text: message.text, opts });
        childIo.runStarted?.({ id: "run-child" });
        return { status: "completed" };
      },
      registry: { listActive: () => [] },
      clock: () => NOW,
    };
    const spawn = spawnCapabilityFor(deps, {
      runId: "run-l",
      depth: 0,
      agentName: "conductor",
      msg: msg("look into durable objects"),
      io: {
        ...quiet,
        openThread: async (lead) => {
          leads.push(lead);
          return { thread: { threadKey: "slack:CX:9.0" }, io: quiet };
        },
      },
    });
    return { spawn, dispatched, leads };
  }
  /** The conductor's session log as the harness reads it: the request, then what the conductor said before spawning. */
  const conductorLog: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "look into durable objects" }] },
    { role: "assistant", content: [{ type: "text", text: "Storage first: one research child." }] },
  ];
  const sessionWith = (readConversation: () => Promise<ChatMessage[]>): SessionCapability => ({
    session: { key: `${THREAD}:conductor`, seedFrom: 0, request: 0, range: { from: 1 } },
    search: async () => ({ hits: [], gaps: [] }),
    readTurn: async () => undefined,
    readConversation,
    readNotepad: async () => null,
    writeNotepad: async () => ({ ok: true }),
  });

  it("`harness: { conductor: pi }` runs the conductor on pi on the bot host with the conductor toolset relayed: a `coding` spawn is refused `spawn_identity` in the tool result and starts nothing; a `research` spawn reaches spawnChild with the text turns of the conversation the session log holds, so the child is dispatched with `seed` set; pi's answer is the run's", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    const asked: string[] = [];
    const { spawn, dispatched, leads } = stubbedSpawn();
    const results: string[] = [];
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      rpcAnswers(cmd, c);
      if (cmd.type !== "prompt") return;
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const live = registry.get("run-l")!;
      const calls = registry.calls("run-l")!;
      void (async () => {
        results.push(
          textOf(
            await relayedTurn(
              c,
              live,
              calls,
              {
                toolCallId: "t1",
                tool: "spawn_run",
                input: { preset: "coding", prompt: "fix the login test", repo: "acme/api" },
              },
              "Storage first: one research child.",
            ),
          ),
        );
        results.push(
          textOf(
            await relayedTurn(c, live, calls, {
              toolCallId: "t2",
              tool: "spawn_run",
              input: { preset: "research", prompt: "what is a Durable Object?" },
            }),
          ),
        );
        settle(c, results.join("\n"));
      })();
    };
    const s = setup("", {
      agent: "conductor",
      yaml: CONDUCTOR_PI_YAML,
      harness: {
        harnesses: roster(),
        registry,
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: (_executor, machine) => {
          asked.push(machine);
          return container;
        },
      },
      bearer: "sbr_run-l.s3cret",
      spawn,
      session: sessionWith(async () => conductorLog),
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(asked).toEqual(["none"]);
    const start = container.starts[0];
    expect(start.env.SWITCHBOARD_HARNESS_URL).toBe("http://127.0.0.1:8080");
    const tools = start.args[start.args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual([
      "spawn_run",
      "send_to_run",
      "await_runs",
      "list_runs",
      "get_run_status",
      "web_fetch",
      "update_status",
      ...GITHUB_READS,
    ]);
    for (const own of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(tools).not.toContain(own);
    expect(results[0]).toMatch(/^spawn refused \(spawn_identity\): `coding` runs as a `write` identity/);
    expect(results[1]).toContain("spawned a research run: run-child in thread slack:CX:9.0");
    expect(out.answer).toBe(results.join("\n"));
    // The coding spawn opened nothing; the research child was dispatched as the requester with the parent's text turns as its seed.
    expect(leads).toHaveLength(1);
    expect(leads[0]).toContain("*research*");
    expect(dispatched).toEqual([
      {
        text: "agent:research what is a Durable Object?",
        opts: {
          parent: { runId: "run-l", depth: 1, remainingMs: expect.any(Number) },
          parentContext: parentContextOf(conductorLog),
        },
      },
    ]);
    expect(container.killed).toEqual([4242]);
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "spawn_run",
      "spawn_run",
    ]);
  });
});

// Feature: docs/reference/specs/run-history.md item 37, the `finish` plan: a
// reclaimed run whose transcript ends on the model's final answer skips the
// model loop and runs the post-steps with that answer, the ending read back
// from its notes, a verdict already posted never posted twice.
describe("a resume with the answer in hand (the `finish` plan)", () => {
  const checkpointCoordinator = { parentInstanceId: "coord-p", idempotencyKey: "coord-p:U12/0/coding", base: "main" };

  it.each([false, true, "later auxiliary push"] as const)(
    "restores an ordinary unit's accepted checkpoint after restart with earlier branch receipt: %s",
    async (earlierPush) => {
      const ref = "unit-work";
      const old = "a".repeat(40);
      const head = "b".repeat(40);
      const receiptA = { type: "pushed_head" as const, ref, sha: old, by: "push" as const };
      const s = setup("", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        coordinator: checkpointCoordinator,
        repoCtx: { repo: "o/r", ref, baseRef: "main" },
        binding: { ref, sha: old, workspace: "/srv/wt/u1" },
        executor: {
          exec: async (command) => {
            if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (command.includes("rev-parse")) return head;
            if (command.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
            if (command.includes("rev-list --count")) return "0";
            return "";
          },
        },
      });
      const bindings = new GitBindings();
      bindings.register(s.run.id, { repo: "o/r", ref }, undefined, async () => true);
      s.deps.githubBindings = bindings;
      const settlement: PublicationSettlement = {
        version: 1,
        binding: {
          runId: s.run.id,
          instanceId: checkpointCoordinator.parentInstanceId,
          step: checkpointCoordinator.idempotencyKey,
          repo: "o/r",
          branch: ref,
          requester: s.ctx.msg.userId,
          threadKey: s.ctx.msg.threadKey,
          generation: "gen-T",
          baseHeadSha: old,
        },
        checkpoint: { kind: "created", head },
        publication: { kind: "accepted", head },
        preservation: { kind: "pending" },
        release: { kind: "pending" },
      };
      const description: PrDescription = {
        title: "fix(core): preserve checkpoint publication",
        tldr: "A saved checkpoint remains published after restart.",
        why: "The coordinator must see accepted work after a process rolls.",
        pointers: [{ label: "Checkpoint", text: "Durable accepted head.", anchor: { path: "src/a", from: 1, to: 2 } }],
        feedbackWanted: "Checkpoint authority.",
        risk: "Missing PR.",
        verified: "Focused test.",
        decisions: [],
        validation: { criteria: [{ criterion: "checkpoint", proof: "accepted settlement" }] },
      };
      const receiptB = { ...receiptA, ref: "assets/other", sha: "c".repeat(40) };
      const receiptEvents = earlierPush === true ? [{ ...receiptA, at: NOW, seq: 1 }] : [];
      for (const event of receiptEvents) s.registry.publish(s.run.id, event);
      const resume = finishing("Changed the allowlist; scoped check failed.", {
        agent: "coding",
        events: receiptEvents,
        state: {
          publicationSettlement: settlement,
          branchPushReceipts:
            earlierPush === "later auxiliary push" ? [receiptA, receiptB] : earlierPush ? [receiptA] : [],
          prDescription: description,
        },
      });
      const open = vi.fn(async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8", created: true }));
      s.deps.openPullRequest = open;
      const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
      expect(out.answer).toContain(`Published \`${ref}\` at \`${head}\``);
      expect(out.answer).toContain("scoped check failed");
      expect(open).toHaveBeenCalledOnce();
      s.ending.drain(undefined);
      await s.writer.settled();
      const record = (await s.store.get("run-l"))!;
      expect(record.headSha).toBe(head);
      expect(record.pushed?.find((p) => p.ref === ref)?.sha).toBe(head);
    },
  );

  it.each(["stale-event", "empty-backlog", "complete-backlog", "receiptless-salvage", "receiptless-push"] as const)(
    "restores the latest durable branch receipt without regressing %s",
    async (backlog) => {
      const ref = "fix/answer";
      const first = "a".repeat(40);
      const last = "b".repeat(40);
      const newer = "c".repeat(40);
      const receiptA = { type: "pushed_head" as const, ref, sha: first, by: "push" as const };
      const receiptB = { type: "pushed_head" as const, ref, sha: last, by: "push" as const };
      const later = { type: "pushed_head" as const, ref, sha: newer, by: "salvage" as const };
      const history =
        backlog === "empty-backlog"
          ? []
          : [
              receiptA,
              ...(backlog === "complete-backlog" ? [receiptB] : []),
              ...(backlog === "receiptless-salvage" ? [later] : []),
              ...(backlog === "receiptless-push" ? [{ ...later, by: "push" as const }] : []),
            ];
      const current = backlog.startsWith("receiptless-") ? newer : last;
      const s = setup("", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
        binding: { ref: "main", sha: first, workspace: "/srv/wt/fix" },
        executor: {
          exec: async (command) => {
            if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (command.includes("rev-parse")) return current;
            if (command.includes("ls-remote")) return `${current}\trefs/heads/${ref}`;
            if (command.includes("rev-list --count")) return "0";
            return "";
          },
        },
      });
      for (const [index, event] of history.entries())
        s.registry.publish(s.run.id, { ...event, at: NOW, seq: index + 1 });
      const resume = finishing("Changed the allowlist; scoped check failed.", {
        agent: "coding",
        events: history.map((event, index) => ({ ...event, at: NOW, seq: index + 1 })),
        state: { doorPublicationPending: null, branchPushReceipts: [receiptA, receiptB] },
      });
      const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
      if (backlog.startsWith("receiptless-")) {
        expect(out.answer).toContain("No push was confirmed");
        expect(out.answer).not.toContain(`Published \`${ref}\` at \`${current}\``);
      } else expect(out.answer).toContain(`Published \`${ref}\` at \`${current}\``);
      s.ending.drain(undefined);
      await s.writer.settled();
      const record = (await s.store.get("run-l"))!;
      expect(record.headSha).toBe(current); // observation, not proof of this run's publication
      expect(record.pushed?.find((p) => p.ref === ref)?.sha).toBe(backlog.startsWith("receiptless-") ? last : current);
    },
  );

  it.each([false, true])(
    "publication provenance probe: a retained event alone is not accepted write authority (earlier receipt: %s)",
    async (earlierReceipt) => {
      const ref = "fix/answer";
      const first = "a".repeat(40);
      const observed = "b".repeat(40);
      const legacyEvent = { type: "pushed_head" as const, ref, sha: observed, by: "push" as const, at: NOW, seq: 1 };
      const s = setup("", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
        binding: { ref: "main", sha: first, workspace: "/srv/wt/fix" },
        executor: {
          exec: async (command) => {
            if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (command.includes("rev-parse")) return observed;
            if (command.includes("ls-remote")) return `${observed}\trefs/heads/${ref}`;
            if (command.includes("rev-list --count")) return "0";
            return "";
          },
        },
      });
      s.registry.publish(s.run.id, legacyEvent);
      const resume = finishing("Changed the allowlist; scoped check failed.", {
        agent: "coding",
        events: [legacyEvent],
        state: {
          branchPushReceipts: earlierReceipt ? [{ type: "pushed_head", ref, sha: first, by: "push" }] : [],
        },
      });
      const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
      expect(out.answer).not.toContain(`Published \`${ref}\` at \`${observed}\``);
      expect(out.answer).toContain("No push was confirmed");
      expect(out.answer).toContain("scoped check failed");
    },
  );

  it("restores accepted receipts on other refs without replaying their earlier heads", async () => {
    const first = "a".repeat(40);
    const latest = "b".repeat(40);
    const ref = "fix/answer";
    const other = "fix/other";
    const s = setup("", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
      binding: { ref: "main", sha: first, workspace: "/srv/wt/fix" },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return latest;
          if (command.includes("ls-remote")) return `${latest}\trefs/heads/${ref}`;
          if (command.includes("rev-list --count")) return "0";
          return "";
        },
      },
    });
    const receipt = (branch: string, sha: string) => ({
      type: "pushed_head" as const,
      ref: branch,
      sha,
      by: "push" as const,
    });
    const resume = finishing("done", {
      agent: "coding",
      state: { branchPushReceipts: [receipt(other, first), receipt(ref, first), receipt(ref, latest)] },
    });
    await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume }));
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))?.pushed).toEqual([
      { ref: other, sha: first, by: "push" },
      { ref, sha: latest, by: "push" },
    ]);
  });

  it.each(["stale-event", "receiptless-event"] as const)(
    "restores an adopted PR's durable accepted receipt past %s",
    async (backlog) => {
      const ref = "fix/adopted";
      const first = "a".repeat(40);
      const last = "b".repeat(40);
      const rewritten = "c".repeat(40);
      const receiptA = {
        type: "pushed_head" as const,
        ref,
        sha: first,
        by: "push" as const,
        receipt: {
          callId: "door:a",
          previousHeadSha: "0".repeat(40),
          repo: "o/r",
          pr: 7,
          owner: { instanceId: "coord-p", unit: "U12" },
        },
      };
      const receiptB = {
        ...receiptA,
        sha: last,
        receipt: { ...receiptA.receipt, callId: "door:b", previousHeadSha: first },
      };
      const current = backlog === "receiptless-event" ? rewritten : last;
      const events = [
        { ...receiptA, at: NOW, seq: 1 },
        ...(backlog === "receiptless-event"
          ? [{ type: "pushed_head" as const, ref, sha: rewritten, by: "push" as const, at: NOW, seq: 2 }]
          : []),
      ];
      const s = setup("", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        coordinator: {
          parentInstanceId: "coord-p",
          idempotencyKey: "coord-p:U12/1/findings",
          base: "main",
          publication: {
            repo: "o/r",
            pr: 7,
            headRef: ref,
            baseRef: "main",
            expectedHeadSha: "0".repeat(40),
            publicationRef: ref,
            owner: receiptA.receipt.owner,
          },
        },
        repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: first },
        binding: { ref, sha: current, workspace: "/srv/wt/pr" },
        executor: {
          exec: async (command) => {
            if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (command.includes("rev-parse")) return current;
            if (command.includes("ls-remote")) return `${current}\trefs/heads/${ref}`;
            if (command.includes("rev-list --count")) return "0";
            return "";
          },
        },
      });
      s.deps.fetchPrFacts = async () => ({
        state: "open",
        sameRepoHead: true,
        headBranchExists: true,
        headRef: ref,
        baseRef: "main",
        headSha: current,
        verifiedHead: { repo: "o/r", ref, sha: current },
      });
      for (const event of events) s.registry.publish(s.run.id, event);
      const resume = finishing("done", {
        agent: "coding",
        events,
        state: { pushedBranch: ref, publicationReceipts: [receiptA, receiptB] },
      });
      const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
      if (backlog === "stale-event") expect(out.answer).toContain(`Published \`${ref}\` at \`${current}\``);
      else expect(out.answer).toContain("Publication was refused"); // the existing PR's exact-head fence rejects C
      s.ending.drain(undefined);
      await s.writer.settled();
      expect((await s.store.get("run-l"))?.pushed?.find((p) => p.ref === ref)?.sha).toBe(last);
    },
  );

  it("reports a runner-confirmed push and the real PR outcome instead of the coding model's stale no-push answer", async () => {
    const head = "b".repeat(40);
    const ref = "fix/answer";
    const s = setup("", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
      binding: { ref: "main", sha: "a".repeat(40), workspace: "/srv/wt/fix" },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return head;
          if (command.includes("rev-list --count")) return "0";
          if (command.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
          return "";
        },
      },
    });
    s.deps.findOpenPrByHead = async () => ({ number: 9, htmlUrl: "https://github.com/o/r/pull/9" });
    const resume = finishing("Changed the allowlist. Scoped test failed; full check skipped.", {
      agent: "coding",
      state: { branchPushReceipts: [{ type: "pushed_head", ref, sha: head, by: "push" }] },
    });
    const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
    expect(out.answer).toContain(`\`${ref}\` at \`${head}\``);
    expect(out.answer).toContain("Changed the allowlist. Scoped test failed; full check skipped.");
    expect(out.answer).toContain("PR updated by the push: https://github.com/o/r/pull/9");
    expect(out.prNote).toBeUndefined();
    expect(s.published).toContain(`answer:${out.answer}`);
    await deliverAnswer({
      msg: s.ctx.msg,
      io: s.ctx.io,
      agent: s.ctx.agent,
      run: s.run,
      answer: out.answer,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      answerOutcome: out.answerOutcome,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]).toContain(`\`${ref}\` at \`${head}\``);
    expect(s.replies[0]).toContain("PR updated by the push: https://github.com/o/r/pull/9");
    expect(s.replies[0]?.match(/PR updated by the push:/g)).toHaveLength(1);
    expect(s.replies[0]).toContain("Scoped test failed; full check skipped.");
  });

  it.each([
    ["invented push", "I pushed the branch; refreshed the allowlist."],
    ["neutral work", "Refreshed the allowlist; scoped test failed and full check was skipped."],
  ])("keeps the %s report distinct from unconfirmed publication", async (_kind, report) => {
    const s = setup("", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
      binding: { ref: "main", sha: "a".repeat(40), workspace: "/srv/wt/fix" },
      executor: { exec: async () => "" },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume: finishing(report, { agent: "coding" }) }));
    expect(out.answer).toContain("No push was confirmed");
    expect(out.answer).toContain(report);
    expect(out.answer.indexOf("No push was confirmed")).toBeLessThan(out.answer.indexOf(report));
    expect(s.published).toContain(`answer:${out.answer}`);
  });

  it.each(["pending", "rejected", "mismatched-ref"] as const)(
    "keeps an older durable accepted head historical after a newer %s write on a trimmed restart",
    async (latest) => {
      const ref = "fix/answer";
      const old = "a".repeat(40);
      const accepted = "b".repeat(40);
      const next = "c".repeat(40);
      const s = setup("", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        backlogLimit: 5,
        repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
        binding: { ref: "main", sha: old, workspace: "/srv/wt/fix" },
        executor: {
          exec: async (command) => {
            if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (command.includes("rev-parse")) return accepted;
            if (command.includes("ls-remote")) return `${accepted}\trefs/heads/${ref}`;
            if (command.includes("rev-list --count")) return "0";
            return "";
          },
        },
      });
      const receipt = {
        type: "pushed_head",
        ref: latest === "mismatched-ref" ? "fix/other" : ref,
        sha: accepted,
        by: "push",
      };
      const state = {
        pushedBranch: ref,
        branchPushReceipts: [receipt],
        ...(latest !== "mismatched-ref"
          ? {
              doorPublicationPending: {
                id: "later",
                update: { ref: `refs/heads/${ref}`, old: accepted, next },
                ...(latest === "rejected" ? { outcome: "rejected" } : {}),
              },
            }
          : {}),
      };
      const report = "Changed the allowlist; focused check failed and files remain local.";
      const out = answered(await runLoop(s.deps, { ...s.ctx, resume: finishing(report, { agent: "coding", state }) }));
      expect(out.answer).toContain(report);
      if (latest === "pending") expect(out.answer).toContain("Publication outcome is unknown");
      if (latest === "rejected") expect(out.answer).toContain("Publication was refused");
      if (latest === "mismatched-ref") expect(out.answer).toContain("No push was confirmed");
      expect(out.answer).not.toContain(`Published \`${ref}\``);
      if (latest !== "mismatched-ref") expect(out.answer).toContain(`\`${ref}\` at \`${accepted}\``);
      expect(s.published).toContain(`answer:${out.answer}`);
      s.ending.drain(undefined);
      await s.writer.settled();
      expect((await s.store.get("run-l"))?.events.filter((e) => e.type === "answer").at(-1)).toMatchObject({
        type: "answer",
        text: out.answer,
      });
    },
  );

  it("does not turn an unresolved publication attempt into a claim that nothing was pushed", async () => {
    const ref = "fix/answer";
    const s = setup("", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: "main", baseRef: "main" },
      binding: { ref: "main", sha: "a".repeat(40), workspace: "/srv/wt/fix" },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return "a".repeat(40);
          if (command.includes("rev-list --count")) return "0";
          return "";
        },
      },
    });
    const resume = finishing("I did not push the branch.", {
      agent: "coding",
      state: {
        doorPublicationPending: {
          id: "pending-1",
          update: { ref: `refs/heads/${ref}`, old: "a".repeat(40), next: "b".repeat(40) },
        },
      },
    });
    const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
    expect(out.answer).toContain("Publication outcome is unknown");
    expect(out.answer).toContain("I did not push the branch.");
    expect(s.published).toContain(`answer:${out.answer}`);
  });
  it.each(["pending", "created", "unknown", "invalid"] as const)(
    "does not replay an unsettled checkpoint after restart: %s",
    async (stage) => {
      const s = setup("", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        coordinator: checkpointCoordinator,
        repoCtx: { repo: "o/r", ref: "unit-work", baseRef: "main" } as RepoContext,
        binding: { ref: "unit-work", sha: "a".repeat(40), workspace: "/srv/wt/u1" },
        executor: {
          exec: async () => {
            throw new Error("checkpoint must not replay");
          },
        },
      });
      const receipt: PublicationSettlement = {
        version: 1,
        binding: {
          runId: "run-l",
          instanceId: checkpointCoordinator.parentInstanceId,
          step: checkpointCoordinator.idempotencyKey,
          repo: "o/r",
          branch: "unit-work",
          requester: s.ctx.msg.userId,
          threadKey: s.ctx.msg.threadKey,
          generation: "old-gen",
          baseHeadSha: "a".repeat(40),
        },
        checkpoint: stage === "pending" ? { kind: "pending" } : { kind: "created", head: "b".repeat(40) },
        publication:
          stage === "unknown" ? { kind: "unknown", reason: "acknowledgment lost" } : { kind: "not_attempted" },
        preservation: { kind: "pending" },
        release: { kind: "pending" },
      };
      const resume = finishing("unfinished", {
        agent: "coding",
        state: { publicationSettlement: stage === "invalid" ? {} : receipt },
      });
      await expect(
        runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
      ).rejects.toThrow("needs reconciliation");
      expect(s.releases).toEqual([]);
      if (stage === "invalid") {
        s.ending.drain(undefined);
        await s.writer.settled();
        expect((await s.store.get("run-l"))?.publicationSettlement).toBeNull();
      }
    },
  );
  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const VERDICT = {
    verdict: "approve",
    summary: "looks correct",
    head: HEAD,
    findings: [{ id: "F1", kind: "single", severity: "nit", file: "src/x.ts", line: 3, title: "a name" }],
  };
  const prThread = {
    repoCtx: { repo: "o/r", pr: 42, ref: "fix/the-pr-head", refFromPr: true, baseRef: "main" } as RepoContext,
    binding: { ref: "fix/the-pr-head", sha: HEAD, workspace: "/srv/wt/pr-42" } as ResidentBinding,
  };
  /** A provider that must never be asked: the model had already answered. */
  const neverCalled = (): Provider => ({
    name: "fake",
    async complete() {
      throw new Error("the model was called on a run that had already answered");
    },
  });
  const transcriptEndingOn = (answer: string): ChatMessage[] => [
    { role: "user", content: [{ type: "text", text: "hello there" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "c1", name: "bash", input: { command: "git rev-parse HEAD" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: HEAD }] },
    { role: "assistant", content: [{ type: "text", text: answer }] },
  ];
  /** The reclaimed row and its plan, as the launcher would hand them over. */
  /** A resume mid-loop (plan `resume`): the row's state as the previous generation left it, one user turn on the transcript, nothing in flight. */
  function reentering(state: Record<string, unknown>, agentName = "coding"): ResumeContext {
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hello there" }] }];
    const events: AppendableEvent[] = [{ type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 }];
    const row: LiveRunRow = {
      runId: "run-l",
      threadKey: THREAD,
      ownerGen: "gen-T",
      leaseUntil: NOW + 30_000,
      startedAt: NOW - 60_000,
      phase: "live",
      stop: null,
      meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, agent: agentName },
      card: null,
      system: "the system prompt",
      tools: [],
      state,
    };
    const lastStep: StepRecord = {
      step: 1,
      seq: 1,
      turnIndex: 1,
      inFlight: [],
      inboxConsumedSeq: 0,
      remainingMs: 240_000,
      turn: 1,
      iteration: 1,
    };
    return {
      row,
      lastStep,
      plan: {
        kind: "resume",
        messages,
        compactions: [],
        settlements: [],
        stepRecorded: true,
        inboxConsumedSeq: 0,
        step: 1,
        turn: 1,
        iteration: 1,
        remainingMs: 240_000,
      },
      events,
      lastSeq: 1,
      repoCtx: {},
      inbox: [],
    };
  }

  function finishing(
    answer: string,
    opts: { agent?: string; events?: AppendableEvent[]; state?: Record<string, unknown>; repoCtx?: RepoContext } = {},
  ): ResumeContext {
    const messages = transcriptEndingOn(answer);
    const events: AppendableEvent[] = opts.events ?? [
      { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
    ];
    const row: LiveRunRow = {
      runId: "run-l",
      threadKey: THREAD,
      ownerGen: "gen-T",
      leaseUntil: NOW + 30_000,
      startedAt: NOW - 60_000,
      phase: "live",
      stop: null,
      meta: { channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, agent: opts.agent ?? "general" },
      card: null,
      system: "the system prompt",
      tools: [],
      state: opts.state ?? {},
    };
    const lastStep: StepRecord = {
      step: 2,
      seq: events.at(-1)?.seq ?? 1,
      turnIndex: 4,
      inFlight: [],
      inboxConsumedSeq: 0,
      remainingMs: 240_000,
      turn: 2,
      iteration: 1,
    };
    return {
      row,
      lastStep,
      durableTurns: messages.length,
      plan: { kind: "finish", messages, answer, inboxConsumedSeq: 0, step: 2, turn: 2, remainingMs: 240_000 },
      events,
      lastSeq: lastStep.seq,
      repoCtx: opts.repoCtx ?? {},
      inbox: [],
    };
  }
  it.each([
    "accepted",
    "metadata only",
    "PR-only metadata",
    "metadata capacity",
    "invalid metadata PR",
    "observed capacity",
    "unmapped push",
    "unobservable push",
    "acceptance unavailable",
    "response lost",
    "untracked",
    "hard stop",
    "capacity",
    "legacy",
  ])("durable branch publication through the real run loop: %s", async (mode) => {
    const ref = mode === "PR-only metadata" ? "main" : "fix/owned";
    const head = "a".repeat(40);
    const description: PrDescription = {
      title: "fix(core): preserve accepted publication",
      tldr: "Keeps branch ownership after interruption.",
      why: "Display events are bounded.",
      pointers: [{ label: "Owner", text: "Persist it.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "Crash ordering.",
      verified: "Focused contract.",
      decisions: [],
      risk: "Publication loss.",
      validation: { criteria: [{ criterion: "owner survives", proof: "durable run state" }] },
    };
    const s = setup("", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      repoCtx: {
        repo: "o/r",
        ref,
        baseRef: "main",
        ...(mode === "PR-only metadata" ? { pr: 7, headSha: head, prFromRecord: true } : {}),
      },
      binding: { ref, sha: head, workspace: "/srv/wt/owned" },
      backlogLimit: 2,
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("ls-remote")) {
            if (mode === "unobservable push") throw new Error("remote head unavailable");
            return `${head}\trefs/heads/${ref}`;
          }
          if (mode === "unobservable push" && command.includes("@{u}")) throw new Error("upstream head unavailable");
          if (command.includes("rev-parse")) return head;
          return "0";
        },
      },
    });
    const resume = finishing("Done.", {
      agent: "coding",
      state: {
        ...(mode === "observed capacity" || mode === "unmapped push" ? {} : { prDescription: description }),
        branchPushReceipts:
          mode === "metadata only" ||
          mode === "PR-only metadata" ||
          mode === "metadata capacity" ||
          mode === "invalid metadata PR"
            ? []
            : [{ type: "pushed_head", ref, sha: head, by: "push" }],
        ...(mode === "legacy"
          ? {}
          : {
              branchPublication: {
                version: 1,
                repo: "o/r",
                complete: true,
                ...(mode === "metadata capacity"
                  ? { targets: Array.from({ length: 20 }, (_, i) => ({ pr: i + 10, headSha: head })) }
                  : {}),
                branches:
                  mode === "capacity" || mode === "observed capacity"
                    ? Array.from({ length: 20 }, (_, i) => ({ ref: `other/${i}`, pr: i + 1 }))
                    : [],
              },
            }),
      },
    });
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({ ledger: inner, gen: "gen-T", fallback: s.store, warn: () => {} });
    s.deps.runLedger = ledger;
    const opened = await ledger.open({
      runId: s.run.id,
      threadKey: THREAD,
      startedAt: NOW,
      meta: { agent: "coding", repo: "o/r", channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD },
      card: null,
      system: "test",
      tools: [],
      state: resume.row.state,
    });
    if (opened.kind !== "tracked") throw new Error("untracked fixture");
    if (mode === "acceptance unavailable") {
      const original = inner.setState.bind(inner);
      inner.setState = async (id, gen, state) => {
        const publication = state.branchPublication as { complete?: boolean; branches?: unknown[] } | undefined;
        if (publication?.complete === true && publication.branches?.length === 1)
          throw new Error("acceptance state unavailable");
        return original(id, gen, state);
      };
    }
    if (mode === "hard stop") {
      const original = inner.setState.bind(inner);
      inner.setState = async (id, gen, state) => {
        const result = await original(id, gen, state);
        if ((state.branchPublication as { pending?: unknown } | undefined)?.pending) s.run.control.requestStop("hard");
        return result;
      };
    }
    const open = vi.fn(async () => {
      expect(inner.live.get(s.run.id)?.state.branchPublication).toMatchObject({
        complete: false,
        pending: { ref, headSha: head },
      });
      if (mode === "response lost") throw new Error("response lost");
      return { number: 7, htmlUrl: "https://github.com/o/r/pull/7", created: true };
    });
    s.deps.openPullRequest = open;
    s.deps.findOpenPrByHead = async () =>
      mode === "unmapped push"
        ? null
        : { number: mode === "invalid metadata PR" ? 0 : 7, htmlUrl: "https://github.com/o/r/pull/7", headSha: head };
    const update = vi.fn(async () => undefined);
    s.deps.updatePullRequest = update;
    const release = vi.fn(async (_input?: unknown) => undefined);
    s.ctx.round.release = release;
    const out = answered(
      await runLoop(s.deps, {
        ...s.ctx,
        resume,
        ledgerRun:
          mode === "untracked"
            ? new NullLedgerRun(s.run.id, { put: (record) => s.store.put(record), abandoned: () => {} })
            : opened.run,
      }),
    );
    s.ending.drain(true);
    await s.writer.settled();
    const record = inner.finished.get(s.run.id) ?? (await s.store.get(s.run.id));
    await out.releaseWorkspace();
    if (mode === "accepted" || mode === "metadata only" || mode === "PR-only metadata") {
      expect(open).toHaveBeenCalledTimes(mode === "accepted" ? 1 : 0);
      expect(update).toHaveBeenCalledTimes(mode === "accepted" ? 0 : 1);
      if (mode === "accepted") expect(record?.events.some((event) => event.type === "pr_opened")).toBe(false);
      expect(record?.branchPublication).toEqual({
        version: 1,
        repo: "o/r",
        complete: true,
        branches: mode === "accepted" ? [{ ref, pr: 7 }] : [],
        ...(mode !== "accepted"
          ? { targets: [{ pr: 7, ...(mode === "metadata only" ? { ref } : {}), headSha: head }] }
          : {}),
      });
      if (mode === "accepted")
        expect(release).toHaveBeenCalledWith(expect.objectContaining({ pushed: [{ ref, pr: 7 }] }));
      else {
        expect(release).toHaveBeenCalledOnce();
        expect(release.mock.calls[0]?.[0]).not.toHaveProperty("pushed");
      }
    } else if (mode === "invalid metadata PR") {
      expect(open).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(record?.branchPublication?.pending).toBeUndefined();
    } else if (mode === "metadata capacity") {
      expect(open).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(record?.branchPublication).toMatchObject({
        complete: true,
        targets: Array.from({ length: 20 }, (_, i) => ({ pr: i + 10, headSha: head })),
      });
      expect(record?.branchPublication?.pending).toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
      expect(release.mock.calls[0]?.[0]).not.toHaveProperty("pushed");
    } else {
      expect(open).toHaveBeenCalledTimes(mode === "response lost" || mode === "acceptance unavailable" ? 1 : 0);
      if (mode !== "hard stop") expect(release).not.toHaveBeenCalled();
      expect(record?.branchPublication?.complete).not.toBe(true);
      if (mode === "response lost" || mode === "acceptance unavailable") {
        expect(record?.branchPublication?.pending).toMatchObject({ ref, headSha: head });
        expect(record).toMatchObject({ id: s.run.id, status: "completed" });
      }
    }
  });

  it("keeps a prior private capture refusal when a resumed run finishes after its note was lost", async () => {
    const audience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:DPRIVATE",
      threadKey: "slack:DPRIVATE:1.0",
      userId: "slack:UADMIN",
    };
    const s = setup("", {
      agent: "orchestrator",
      userId: audience.userId,
      channelId: audience.channelId,
      threadKey: audience.threadKey,
      directAudience: audience,
      provider: neverCalled(),
    });
    const resume = finishing("Done.", {
      agent: "orchestrator",
      state: { contextRefusals: ["checkpoint_state-fenced"] },
      events: [{ type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 }],
    });
    await runLoop(s.deps, { ...s.ctx, resume, channelVisibility: "dm" });
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.contextRefusals).toEqual(["checkpoint_state-fenced"]);
    expect(record.events).not.toContainEqual(expect.objectContaining({ kind: "work_context_refused" }));
  });
  const note = (kind: string, summary: string, seq: number, mode?: "soft" | "hard"): AppendableEvent => ({
    type: "run_note",
    kind: kind as "stopped",
    summary,
    ...(mode ? { mode } : {}),
    at: seq,
    seq,
  });

  it.each([
    ["finish", false],
    ["resume", false],
    ["resume", true],
  ] as const)(
    "a successful gated push receipt survives restart into %s (seeded: %s) without replaying the push or losing attribution",
    async (mode, seeded) => {
      const old = "a".repeat(40),
        head = "b".repeat(40),
        ref = "fix/existing";
      const publication = {
        repo: "o/r",
        pr: 7,
        headRef: ref,
        baseRef: "main",
        expectedHeadSha: old,
        publicationRef: ref,
        owner: { instanceId: "coord-p", unit: "U12" },
      };
      const receipt = {
        type: "pushed_head",
        ref,
        sha: head,
        by: "push",
        receipt: { callId: "push", previousHeadSha: old, repo: "o/r", pr: 7, owner: publication.owner },
      };
      const state = JSON.parse(JSON.stringify({ publicationReceipts: [receipt], pushedBranch: ref }));
      const resume = mode === "finish" ? finishing("done", { agent: "coding", state }) : reentering(state);
      const commands: string[] = [];
      const resumed = watched(piHarness);
      const open = resumed.harness.open;
      resumed.harness.open = async (deps, run) => {
        expect(run.rules.publication).toEqual({ authority: { ref, expectedHeadSha: head } });
        return open(deps, run);
      };
      const s = setup("done", {
        agent: "coding",
        coding: true,
        provider: neverCalled(),
        harness: {
          harnesses: roster(resumed.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example.com",
          containerFor: () => new FakeHarnessContainer(),
        },
        repoCtx: { repo: "o/r", pr: 7, ref, baseRef: "main", headSha: old },
        ...(seeded
          ? { seeded: { slug: "o/r", ref, sha: head, workspace: "/workspace/checkout", cached: true, ms: 0 } }
          : { binding: { ref, sha: head, workspace: "/srv/wt/existing" } }),
        coordinator: {
          parentInstanceId: "coord-p",
          idempotencyKey: "coord-p:U12/1/findings",
          base: "main",
          publication,
        },
        executor: {
          exec: async (command) => {
            commands.push(command);
            if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
            if (command.includes("rev-parse")) return head;
            if (command.includes("rev-list --count")) return "0";
            if (command.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
            return "";
          },
        },
      });
      s.deps.fetchPrFacts = async () => ({
        state: "open",
        sameRepoHead: true,
        headBranchExists: true,
        headRef: ref,
        baseRef: "main",
        headSha: head,
        verifiedHead: { repo: "o/r", ref, sha: head },
      });
      const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
      s.ending.drain(undefined);
      await s.writer.settled();
      const record = (await s.store.get("run-l"))!;
      expect(record.pushed).toEqual([{ ref, sha: head, by: "push" }]);
      expect(record.events.some((e) => e.type === "run_note" && e.kind === "publication_blocked")).toBe(false);
      expect(commands.some((command) => /^git(?: -C '[^']+')? push/.test(command))).toBe(false);
      if (seeded) {
        expect(commands).toContain("git -C '/workspace/checkout' status --porcelain");
        expect(commands).toContain("git -C '/workspace/checkout' rev-parse HEAD");
        expect(commands.some((command) => command.startsWith("git status") || command.startsWith("ls -d */.git"))).toBe(
          false,
        );
      }
      await out.releaseWorkspace();
    },
  );

  it("a resumed child keeps an earlier uncertain branch write on its finished record", async () => {
    const old = "a".repeat(40);
    const next = "b".repeat(40);
    const ref = "unit-branch";
    const pending = {
      id: "intent-before-restart",
      repo: "o/r",
      owner: { instanceId: "coord-p", unit: "U12" },
      update: { ref: `refs/heads/${ref}`, old, next },
    };
    const description: PrDescription = {
      title: "fix(core): hold an uncertain branch push",
      tldr: "Keeps the unit PR unpublished while the prior Git result is uncertain.",
      why: "A restarted child cannot infer that the earlier push was rejected.",
      pointers: [
        { label: "Push result", text: "The durable intent remains.", anchor: { path: "src/a", from: 1, to: 2 } },
      ],
      feedbackWanted: "The publication fence.",
      risk: "A delayed PR until reconciliation.",
      verified: "Focused test.",
      decisions: [],
      validation: { criteria: [{ criterion: "uncertain push", proof: "PR unchanged" }] },
    };
    const resume = finishing("done", {
      agent: "coding",
      state: { doorPublicationPending: pending, prDescription: description, pushedBranch: ref },
    });
    const s = setup("done", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref },
      binding: { ref, sha: old, workspace: "/srv/wt/branch" },
      coordinator: { parentInstanceId: "coord-p", idempotencyKey: "coord-p:U12/1/coding", base: "main" },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return old;
          if (command.includes("rev-list --count")) return "0";
          if (command.includes("ls-remote")) return `${old}\trefs/heads/${ref}`;
          return "";
        },
      },
    });
    const open = vi.fn(async () => ({ number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true }));
    s.deps.openPullRequest = open;
    const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
    expect(out.prNote).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!.doorPublicationPending).toMatchObject({
      ...pending,
      repo: "o/r",
      owner: { instanceId: "coord-p", unit: "U12" },
    });
  });

  it("a verification-blocked existing PR with a clean checkout performs no PR lookup, edit, or create", async () => {
    const EXPECTED = "a".repeat(40);
    const MOVED = "c".repeat(40);
    const BRANCH = "fix/existing";
    const unit = `U${1}`;
    const publication = {
      repo: "o/r",
      pr: 7,
      headRef: BRANCH,
      baseRef: "main",
      expectedHeadSha: EXPECTED,
      publicationRef: BRANCH,
      owner: { instanceId: "coord-p", unit },
    };
    const description: PrDescription = {
      title: "fix(core): fence existing PR publication",
      tldr: "Keeps existing pull requests unchanged after publication is blocked. This prevents stale intent from mutating or recreating them.",
      why: "The exact-head receipt no longer authorizes publication after the branch moves.",
      pointers: [
        { label: "Publication fence", text: "Skips every PR write.", anchor: { path: "src/a", from: 1, to: 2 } },
      ],
      feedbackWanted: "The fail-closed boundary.",
      risk: "Low.",
      verified: "Unit test.",
      decisions: [],
      validation: { criteria: [{ criterion: "blocked publication", proof: "green" }] },
    };
    const submitting = watched(piHarness);
    submitting.harness.open = async (_deps, run) => {
      run.toolContext.onPrDescription?.(description);
      return {
        answer: "the local fix is complete",
        followUp: async () => "",
        remainingMs: () => 20 * 60_000,
        end: async () => {},
      };
    };
    const s = setup("", {
      agent: "coding",
      coding: true,
      harness: {
        harnesses: roster(submitting.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      repoCtx: {
        repo: "o/r",
        pr: 7,
        prFromRecord: true,
        refFromPr: true,
        ref: BRANCH,
        baseRef: "main",
        headSha: EXPECTED,
      },
      binding: { ref: BRANCH, sha: EXPECTED, workspace: "/srv/wt/existing" },
      coordinator: {
        parentInstanceId: "coord-p",
        idempotencyKey: `coord-p:${unit}/1/findings`,
        base: "main",
        publication,
      },
      executor: {
        exec: async (cmd: string) => {
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${EXPECTED}\n`;
          if (/rev-parse @\{u\}/.test(cmd)) return `${EXPECTED}\n`;
          if (/status --porcelain/.test(cmd)) return "";
          if (/rev-list --count/.test(cmd)) return "0\n";
          if (/ls-remote --exit-code origin/.test(cmd)) return `${MOVED}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      },
    });
    s.deps.fetchPrFacts = async () => ({
      state: "open",
      sameRepoHead: true,
      headBranchExists: true,
      headRef: BRANCH,
      baseRef: "main",
      headSha: MOVED,
    });
    const find = vi.fn(async () => ({ number: 7, htmlUrl: "https://github.com/o/r/pull/7" }));
    const update = vi.fn(async () => {});
    const open = vi.fn(async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8", created: true }));
    s.deps.findOpenPrByHead = find;
    s.deps.updatePullRequest = update;
    s.deps.openPullRequest = open;

    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.prNote).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("the model is never called: the transcript's final turn is the answer, published and finished `completed`, and a `resumed` note on the stream says the loop had ended before the restart", async () => {
    const s = setup("", { provider: neverCalled() });
    const resume = finishing("The answer, written before the restart.");
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("The answer, written before the restart.");
    expect(s.published).toEqual(["answer:The answer, written before the restart."]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.status).toBe("completed");
    expect(rec.events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "resumed")).toEqual([
      expect.objectContaining({ kind: "resumed", summary: expect.stringMatching(/had already answered/) }),
    ]);
  });

  it("the ending is read from the run's notes, not from this generation's control: a soft-stopped run's answer wears the ⏹ label and finishes `stopped_soft`; a run that hit its time budget wears the ⚠️ budget label and finishes `completed`", async () => {
    const stopped = setup("", { provider: neverCalled() });
    const softStop = finishing("What I found before the stop.", {
      events: [
        { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
        note("stop_requested", "soft stop requested", 2, "soft"),
        note("stopped", "soft stop", 3, "soft"),
      ],
    });
    const stoppedOut = answered(
      await runLoop(stopped.deps, {
        ...stopped.ctx,
        resume: softStop,
        messages: softStop.plan.messages,
      }),
    );
    expect(stoppedOut.answer).toMatch(/^⏹ _Stopped early by an operator \(soft stop\)/);
    expect(stoppedOut.answer).toContain("What I found before the stop.");
    expect(stopped.run.control.requested).toBe("soft");
    expect(stopped.registry.getById("run-l")).toMatchObject({ finished: true, status: "stopped_soft" });

    const budget = setup("", { provider: neverCalled() });
    const timeBudget = finishing("What I found before the budget ran out.", {
      events: [
        { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
        note("time_budget_exhausted", "time budget exhausted", 2),
      ],
    });
    const budgetOut = answered(
      await runLoop(budget.deps, {
        ...budget.ctx,
        resume: timeBudget,
        messages: timeBudget.plan.messages,
      }),
    );
    expect(budgetOut.answer).toMatch(/^⚠️ _Hit the \d+-minute budget before finishing/);
    expect(budgetOut.answer).toContain("What I found before the budget ran out.");
    expect(budgetOut.answerOutcome.ending).toBe("time_budget");
    expect(budget.run.control.requested).toBeUndefined();
    expect(budget.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a budgeted source answer recovered after a restart keeps its original partial checklist on the reply card", async () => {
    const s = setup("", { provider: neverCalled() });
    const resume = finishing("One source record was verified; the remaining records were not read.", {
      state: { checklist: "✓ Verify one record\n✱ Read remaining records\n○ Deliver the full answer" },
      events: [
        { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
        note("resumed", "continued the same run and conversation after a restart", 2),
        note("time_budget_exhausted", "cut a source read at the loop end", 3),
      ],
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    await deliverAnswer({
      msg: s.ctx.msg,
      io: s.ctx.io,
      agent: s.ctx.agent,
      run: s.run,
      answer: out.answer,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      answerOutcome: out.answerOutcome,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(s.replies.at(-1)).toContain("One source record was verified");
    expect(s.closes.at(-1)?.title).toContain("⚠");
    expect(s.closes.at(-1)?.detail).toBe(
      "Answer completion unverified.\n\n✓ Verify one record\n✱ Read remaining records\n○ Deliver the full answer",
    );
  });

  it("a normally ended run retains a pre-restart tool refusal on its final card", async () => {
    const s = setup("", { provider: neverCalled() });
    const answerOutcome = { version: 1 as const, ending: "answered" as const, output: "present" as const };
    const resume = finishing("One record was verified; the requested check did not run.", {
      state: { answerOutcome, checklist: "✓ Verify one record\n✓ Run the requested check" },
      events: [
        { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
        { type: "tool_call", tool: "bash", summary: "run requested check", callId: "check-1", at: 2, seq: 2 },
        note("tool_refused", "bash refused before execution", 3),
        { type: "tool_result", tool: "bash", ok: false, summary: "refused", callId: "check-1", at: 4, seq: 4 },
      ],
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    await deliverAnswer({
      msg: s.ctx.msg,
      io: s.ctx.io,
      agent: s.ctx.agent,
      run: s.run,
      answer: out.answer,
      liveUrl: undefined,
      prNote: out.prNote,
      stopped: undefined,
      ledgerRun: undefined,
      ending: s.ending,
      card: s.ctx.card,
      shell: s.ctx.shell,
      checklistAsLeft: out.checklistAsLeft,
      hasIncompleteToolEffects: out.hasIncompleteToolEffects,
      answerOutcome: out.answerOutcome,
      doneLines: s.ctx.doneLines,
      runDiagnosis: out.runDiagnosis,
      releaseWorkspace: out.releaseWorkspace,
      root: s.ctx.root,
    });
    expect(s.replies.at(-1)).toContain("One record was verified");
    expect(s.closes.at(-1)?.title).toContain("⚠️");
    expect(s.closes.at(-1)?.detail).toContain("✓ Verify one record\n✓ Run the requested check");
  });

  it.each(["absent", "present"] as const)(
    "a recovered %s write-up uses its saved outcome rather than the nonempty answer text",
    async (output) => {
      const s = setup("", { provider: neverCalled() });
      const answerOutcome = { version: 1 as const, ending: "time_budget" as const, output };
      const resume = finishing("Rendered fallback or partial findings.", {
        state: { answerOutcome, checklist: "✓ Read sources" },
        events: [
          { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
          note("time_budget_exhausted", "time budget exhausted", 2),
        ],
      });
      const out = answered(
        await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
      );
      expect(out.answerOutcome).toEqual(answerOutcome);
      if (output === "absent") expect(out.answer).toContain("could not verify");
      else expect(out.answer).toContain("Rendered fallback or partial findings.");
      s.ending.drain(true);
      await s.writer.settled();
      expect((await s.store.get("run-l"))?.answerOutcome).toEqual(answerOutcome);
    },
  );

  it("admits exact original run review publication durably before native POST and records native acceptance", async () => {
    let posted = 0;
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: {
        head: HEAD,
        post: async () => {
          const rows = await s.deps.runLedger!.readLiveRuns();
          const row = rows.find((row) => row.runId === s.run.id)!;
          expect(row.state.reviewPublication).toMatchObject({
            runId: s.run.id,
            state: "pending",
            target: { repo: "o/r", number: 42, commitId: HEAD },
          });
          expect(row.state.branchPublication).toEqual({ version: 1, repo: "o/r", branches: [], complete: true });
          expect(JSON.stringify(row.state.reviewPublication)).not.toContain("original review bytes");
          posted++;
          return { state: "accepted" as const };
        },
      },
    });
    const resume = finishing("original review bytes", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(posted).toBe(1);
    expect(out.reviewPost).toMatchObject({ posted: true, head: HEAD });
  });

  it("an uncertain terminal review retains its receipt without reserving PR mutation ownership", async () => {
    const post = vi.fn(async () => ({ state: "uncertain" as const }));
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: { head: HEAD, post },
    });
    const resume = finishing("original review bytes", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.reviewPost).toMatchObject({ posted: false, uncertain: true });
    expect(post).toHaveBeenCalledTimes(1);
    s.ending.drain(true);
    await s.writer.settled();
    const record = (await s.store.get(s.run.id))!;
    expect(record.reviewPublication).toMatchObject({ state: "uncertain", runId: s.run.id });
    expect(terminalPublicationRetentionRequired(record)).toBe(true);
    expect(
      findPullOwnersInRows(
        { repo: "o/r", pr: 42 },
        {
          complete: true,
          units: [],
          effects: [],
          runs: [{ runId: record.id, repo: record.repo, live: false, publication: record.branchPublication }],
        },
      ),
    ).toEqual({ ok: true, owners: [] });
  });

  it("a hosted review retains its canonical conversation owner while the ledger uses a host key", async () => {
    const post = vi.fn(async () => ({ state: "accepted" as const }));
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: { head: HEAD, post },
    });
    const resume = finishing("original review bytes", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const ctx = await trackedCodingContext(
      s,
      { ...s.ctx, resume, messages: resume.plan.messages },
      "host:original-review",
    );
    const row = (await s.deps.runLedger!.readLiveRuns())[0]!;
    expect(row.threadKey).toBe("host:original-review");
    expect(row.meta.threadKey).toBe(s.ctx.msg.threadKey);
    expect(answered(await runLoop(s.deps, ctx)).reviewPost).toMatchObject({ posted: true, head: HEAD });
    expect(post).toHaveBeenCalledTimes(1);
    s.ending.drain(true);
    await s.writer.settled();
    expect((await s.store.get(s.run.id))?.reviewPublication).toMatchObject({ runId: s.run.id, state: "accepted" });
  });

  it("a soft stop after durable pending admission records confirmed refusal without native dispatch", async () => {
    const post = vi.fn(async () => ({ state: "accepted" as const }));
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: { head: HEAD, post },
    });
    const resume = finishing("original review bytes", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
    const commit = ctx.ledgerRun!.commitState.bind(ctx.ledgerRun!);
    let stopped = false;
    ctx.ledgerRun!.commitState = async (patch) => {
      const result = await commit(patch);
      if ((patch.reviewPublication as { state?: string } | undefined)?.state === "pending" && result === "ok") {
        stopped = true;
        s.run.control.requestStop("soft");
        s.registry.publish(s.run.id, {
          type: "run_note",
          kind: "stop_requested",
          summary: "soft stop requested",
          at: NOW,
        });
      }
      return result;
    };
    expect(answered(await runLoop(s.deps, ctx)).reviewPost).toMatchObject({
      posted: false,
      reason: "the review publication was refused",
    });
    expect(stopped).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.reviewPublication).toMatchObject({ state: "refused" });
  });

  it.each(["stored-null", "different-pr", "untracked"] as const)(
    "review publication never admits from %s original owner evidence",
    async (mode) => {
      const post = vi.fn(async () => ({ state: "accepted" as const }));
      const s = setup("", {
        agent: "review",
        provider: neverCalled(),
        ...prThread,
        executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
        review: { head: HEAD, post },
      });
      const resume = finishing("original review bytes", {
        agent: "review",
        state: { verdict: VERDICT },
        repoCtx: prThread.repoCtx,
      });
      const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
      if (mode === "untracked") ctx.ledgerRun = recordingLedgerRun().ledgerRun;
      else if (mode === "stored-null") await ctx.ledgerRun!.commitState({ reviewPublication: null });
      else {
        const read = s.deps.runLedger!.readLiveRuns.bind(s.deps.runLedger!);
        vi.spyOn(s.deps.runLedger!, "readLiveRuns").mockImplementation(async () =>
          (await read()).map((row) => ({ ...row, meta: { ...row.meta, pr: 99 } })),
        );
      }
      const out = answered(await runLoop(s.deps, ctx));
      expect(post).not.toHaveBeenCalled();
      expect(out.reviewPost).toMatchObject({ posted: false, uncertain: true });
    },
  );

  it("a fresh review that loses its original ledger owner stays uncertain without not-posted evidence", async () => {
    const post = vi.fn(async () => ({ state: "accepted" as const }));
    const s = setup("original review bytes", {
      agent: "review",
      ...prThread,
      executor: {
        exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : ""),
        execResult: async () => ({ exitCode: 0, stdout: `${HEAD}\n`, stderr: "", truncated: false }),
      },
      review: { head: HEAD, post },
    });
    let inner!: InMemoryRunLedger;
    const ctx = await trackedCodingContext(s, s.ctx, s.ctx.msg.threadKey, (ledger) => {
      inner = ledger;
    });
    const read = s.deps.fetchPrHead!;
    s.deps.fetchPrHead = async (target) => {
      inner.live.get(s.run.id)!.ownerGen = "gen-replacement";
      expect(await ctx.ledgerRun!.commitState({ ownerProbe: true })).toBe("fenced");
      expect(ctx.ledgerRun!.tracked()).toBe(false);
      return read(target);
    };
    const out = answered(await runLoop(s.deps, ctx));
    expect(out.reviewPost).toMatchObject({ posted: false, uncertain: true });
    expect(post).not.toHaveBeenCalled();
    expect(
      s.registry
        .snapshot(s.run.id, s.run.token)
        ?.events.some((event) => event.type === "run_note" && event.kind === "review_not_posted"),
    ).toBe(false);
  });

  it("a soft stop inside pending admission refuses before any review write", async () => {
    const post = vi.fn(async () => ({ state: "accepted" as const }));
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: { head: HEAD, post },
    });
    const resume = finishing("original review bytes", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
    const read = s.deps.runLedger!.readLiveRuns.bind(s.deps.runLedger!);
    let admissionReads = 0;
    let stopped = false;
    vi.spyOn(s.deps.runLedger!, "readLiveRuns").mockImplementation(async () => {
      const rows = await read();
      // The first check permits the request; the transaction's fresh read
      // observes the stop before committing pending or issuing native POST.
      if (admissionReads++ === 3) {
        stopped = true;
        s.run.control.requestStop("soft");
      }
      return rows;
    });
    const out = answered(await runLoop(s.deps, ctx));
    expect(stopped).toBe(true);
    expect(out.reviewPost).toEqual({ posted: false, reason: "the review publication was refused" });
    expect(post).not.toHaveBeenCalled();
    expect((await read())[0]!.state.reviewPublication).toBeUndefined();
  });

  it("a fresh untracked review refuses before native dispatch without inventing uncertainty", async () => {
    const post = vi.fn(async () => ({ state: "accepted" as const }));
    const s = setup("original review bytes", {
      agent: "review",
      ...prThread,
      executor: {
        exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : ""),
        execResult: async () => ({ exitCode: 0, stdout: `${HEAD}\n`, stderr: "", truncated: false }),
      },
      review: { head: HEAD, post },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.reviewPost).toMatchObject({ posted: false, reason: "the review publication owner is unavailable" });
    expect(post).not.toHaveBeenCalled();
    expect(
      s.registry
        .snapshot(s.run.id, s.run.token)
        ?.events.some((event) => event.type === "run_note" && event.kind === "review_not_posted"),
    ).toBe(true);
  });

  it("refuses review native POST when the original run owner changes after pending admission", async () => {
    const post = vi.fn(async () => ({ state: "accepted" as const }));
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: { head: HEAD, post },
    });
    const resume = finishing("original review bytes", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
    const read = s.deps.runLedger!.readLiveRuns.bind(s.deps.runLedger!);
    let changed = false;
    vi.spyOn(s.deps.runLedger!, "readLiveRuns").mockImplementation(async () =>
      (await read()).map((row) => {
        if (!row.state.reviewPublication) return row;
        changed = true;
        return { ...row, ownerGen: "gen-replacement" };
      }),
    );
    expect(answered(await runLoop(s.deps, ctx)).reviewPost).toMatchObject({ posted: false });
    expect(changed).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("a review resumed with its answer in hand runs its post-steps: the verdict restored from the row is settled at the pinned head and posted, once", async () => {
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: {
        head: HEAD,
        post: async (target, body) => {
          posts.push({ target, body });
          return { state: "accepted" as const };
        },
      },
    });
    const resume = finishing("The review: one nit, F1.", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("The review: one nit, F1.");
    expect(posts).toEqual([
      {
        target: { repo: "o/r", number: 42, commitId: HEAD },
        body: buildReviewPostBody("The review: one nit, F1.", parseVerdictInput(VERDICT)!, { repo: "o/r", head: HEAD }),
      },
    ]);
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.status).toBe("completed");
    expect(rec.reviewPost).toEqual({
      posted: true,
      target: { repo: "o/r", number: 42 },
      head: HEAD,
      verdict: "approve",
    });
  });

  it.each([
    ["general", false],
    ["review", false],
    ["general", true],
    ["review", true],
  ] as const)(
    "keeps a %s answer behind its final context checkpoint (persistent failure: %s)",
    async (agent, persistentFailure) => {
      const posts: string[] = [];
      const s = setup("", {
        agent,
        provider: neverCalled(),
        ...(agent === "review"
          ? {
              ...prThread,
              review: {
                head: HEAD,
                post: async (_target: ReviewCommentTarget, body: string) => {
                  posts.push(body);
                  return { state: "accepted" as const };
                },
              },
              executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
            }
          : {}),
      });
      const resume = finishing("Saved final answer.", {
        agent,
        ...(agent === "review" ? { state: { verdict: VERDICT }, repoCtx: prThread.repoCtx } : {}),
      });
      const laterVerdict = { ...VERDICT, verdict: "request_changes", summary: "needs correction" };
      if (agent === "review" && resume.plan.kind === "finish") {
        resume.plan.messages.splice(
          1,
          2,
          { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "submit_verdict", input: VERDICT }] },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "c1", content: "verdict recorded: approve (1 finding)" }],
          },
          ...(persistentFailure
            ? ([
                {
                  role: "assistant",
                  content: [{ type: "tool_use", id: "c2", name: "submit_verdict", input: laterVerdict }],
                },
                {
                  role: "user",
                  content: [
                    { type: "tool_result", toolUseId: "c2", content: "verdict recorded: request_changes (1 finding)" },
                  ],
                },
              ] as ChatMessage[])
            : []),
        );
        resume.durableTurns = resume.plan.messages.length;
        resume.lastStep.turnIndex = resume.plan.messages.length;
      }
      if (agent === "review")
        resume.row.state.branchPublication = { version: 1, repo: prThread.repoCtx.repo, branches: [], complete: true };
      const inner = new InMemoryRunLedger(() => NOW);
      let failState = false;
      let recoveredCheckpoint: unknown;
      const setState = inner.setState.bind(inner);
      inner.setState = async (runId, gen, state) => {
        if (failState && state.contextCheckpoint) throw new TransientStoreError("temporary state timeout");
        if (gen === "gen-R" && state.contextCheckpoint) recoveredCheckpoint = state.contextCheckpoint;
        return setState(runId, gen, state);
      };
      const ledger = createLedgerWriteThrough({
        ledger: inner,
        gen: "gen-T",
        fallback: s.store,
        warn: () => {},
        sleep: async () => {},
      });
      s.deps.runLedger = ledger;
      const opened = await ledger.open({
        runId: s.run.id,
        threadKey: s.ctx.msg.threadKey,
        startedAt: NOW,
        meta: {
          agent,
          channelId: s.ctx.msg.channelId,
          userId: s.ctx.msg.userId,
          threadKey: s.ctx.msg.threadKey,
          ...(s.ctx.repoCtx.repo ? { repo: s.ctx.repoCtx.repo } : {}),
          ...(s.ctx.repoCtx.pr !== undefined ? { pr: s.ctx.repoCtx.pr } : {}),
        },
        state: resume.row.state,
        card: null,
        system: s.ctx.system,
        tools: [],
        seed: {
          messages: resume.plan.messages,
          budgetMs: 60_000,
          context: { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
        },
      });
      if (opened.kind !== "tracked") throw new Error("the run was not tracked");
      s.registry.subscribe(s.run.id, s.run.token, { onEvent: (event, seq) => opened.run.event(event, seq) });
      if (persistentFailure)
        expect(
          await opened.run.setStateAndFlush({
            ...(agent === "review" ? { verdict: parseVerdictInput(VERDICT)! } : {}),
            contextCheckpoint: { key: opened.run.session!.key, through: opened.run.session!.seedFrom },
          }),
        ).toBe(true);
      const checkpoint = opened.run.checkpointSession.bind(opened.run);
      let checkpoints = 0;
      opened.run.checkpointSession = async () => {
        checkpoints++;
        failState = persistentFailure || checkpoints === 1;
        return checkpoint();
      };
      const running = runLoop(s.deps, {
        ...s.ctx,
        ledgerRun: opened.run,
        resume,
        messages: resume.plan.messages,
      });
      if (persistentFailure) {
        expect(await running).toMatchObject({ kind: "paused", reason: "checkpoint_unavailable", handedOff: true });
        expect(checkpoints).toBe(2);
        expect(s.published.some((event) => event.startsWith("answer:"))).toBe(false);
        expect(posts).toHaveLength(0);
        expect(s.registry.getById(s.run.id)).toBeNull();
        expect(inner.live.has(s.run.id)).toBe(true);
        expect(await s.store.get(s.run.id)).toBeNull();
        failState = false;
        const [taken] = await inner.reclaim("gen-R", NOW, 60_000);
        expect(taken?.reclaimedFrom).toBe("handoff");
        expect(await inner.readEvents(s.run.id)).toContainEqual(
          expect.objectContaining({ type: "run_note", kind: "checkpoint_deferred" }),
        );
        if (!taken?.lastStep || !taken.row.meta.session) throw new Error("the final answer was not recoverable");
        const transcript = await inner.readSession(taken.row.meta.session.key, taken.row.meta.session.seedFrom);
        const plan = planResume({ transcript, lastStep: taken.lastStep, tools: [] });
        expect(plan.kind).toBe("finish");
        if (plan.kind !== "finish") return;
        const resumed = setup("", {
          agent,
          provider: neverCalled(),
          ...(agent === "review"
            ? {
                ...prThread,
                review: {
                  head: HEAD,
                  post: async (_target: ReviewCommentTarget, body: string) => {
                    posts.push(body);
                    return { state: "accepted" as const };
                  },
                },
                executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
              }
            : {}),
        });
        const nextLedger = createLedgerWriteThrough({
          ledger: inner,
          gen: "gen-R",
          fallback: resumed.store,
          warn: () => {},
          sleep: async () => {},
        });
        resumed.deps.runLedger = nextLedger;
        const adopted = nextLedger.adopt({
          runId: taken.row.runId,
          threadKey: taken.row.threadKey,
          meta: taken.row.meta,
          startedAt: taken.row.startedAt,
          state: taken.row.state,
          lastStep: taken.lastStep.step,
          lastSeq: 0,
          session: taken.row.meta.session,
          durableTurns: transcript.turns,
        });
        const out = answered(
          await runLoop(resumed.deps, {
            ...resumed.ctx,
            ledgerRun: adopted,
            resume: {
              row: taken.row,
              lastStep: taken.lastStep,
              durableTurns: transcript.turns,
              plan,
              events: [],
              inbox: [],
              lastSeq: 0,
              repoCtx: resume.repoCtx,
            },
            messages: plan.messages,
          }),
        );
        expect(out.answer).toBe("Saved final answer.");
        expect(resumed.published.filter((event) => event.startsWith("answer:"))).toHaveLength(1);
        expect(recoveredCheckpoint).toEqual({
          key: taken.row.meta.session.key,
          through: taken.row.meta.session.seedFrom + transcript.turns - 1,
        });
        if (agent === "review") {
          expect(posts).toHaveLength(1);
          expect(posts[0]).toMatch(/^Changes requested:/);
        }
        return;
      }
      const out = answered(await running);
      expect(out.answer).toBe("Saved final answer.");
      expect(checkpoints).toBe(2);
      const saved = await ledger.readSessionTail(opened.run.session!.threadSession!, 8192);
      expect(JSON.stringify(saved.transcript)).toContain("Saved final answer.");
      if (agent === "review") expect(posts).toHaveLength(1);
      else expect(posts).toHaveLength(0);
    },
  );

  it.each(["head", "repo", "pr"])(
    "a canonical finish rejects a replayed review post with a different %s",
    async (drift) => {
      const publication = {
        repo: "o/r",
        pr: 42,
        headRef: "fix/the-pr-head",
        baseRef: "main",
        publicationRef: "fix/the-pr-head",
        expectedHeadSha: HEAD,
        owner: { instanceId: "coord-p", unit: "ONE" },
      };
      const post = vi.fn(async () => {});
      const s = setup("", {
        agent: "review",
        provider: neverCalled(),
        ...prThread,
        repoCtx: { ...prThread.repoCtx, headSha: HEAD },
        coordinator: { parentInstanceId: "coord-p", idempotencyKey: "coord-p:ONE/1/review", base: "main", publication },
        review: { head: HEAD, post },
        executor: { exec: async () => HEAD },
      });
      s.deps.fetchPrFacts = async () => ({
        state: "open",
        headRef: publication.headRef,
        baseRef: "main",
        headSha: HEAD,
        sameRepoHead: true,
        headBranchExists: true,
        verifiedHead: { repo: "o/r", ref: publication.headRef, sha: HEAD },
      });
      const resume = finishing("Saved review.", {
        agent: "review",
        state: { verdict: VERDICT },
        repoCtx: s.ctx.repoCtx,
        events: [
          {
            type: "review_posted",
            repo: drift === "repo" ? "other/repo" : "o/r",
            number: drift === "pr" ? 43 : 42,
            head: drift === "head" ? "b".repeat(40) : HEAD,
            at: NOW,
            seq: 1,
          },
        ],
      });
      await expect(runLoop(s.deps, { ...s.ctx, resume })).rejects.toThrow("saved review target");
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "pending", "uncertain"] as const)(
    "a replayed review event grants no posted credit or repost permission with canonical receipt %s",
    async (state) => {
      const post = vi.fn(async () => ({ state: "accepted" as const }));
      const s = setup("", {
        agent: "review",
        provider: neverCalled(),
        ...prThread,
        executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
        review: { head: HEAD, post },
      });
      const resume = finishing("Saved review.", {
        agent: "review",
        repoCtx: prThread.repoCtx,
        state: {
          verdict: VERDICT,
          ...(state === undefined
            ? {}
            : {
                reviewPublication:
                  state === null
                    ? null
                    : {
                        version: 1,
                        runId: s.run.id,
                        target: { repo: "o/r", number: 42, commitId: HEAD },
                        bodyHash: "c".repeat(64),
                        state,
                      },
              }),
        },
        events: [{ type: "review_posted", repo: "o/r", number: 42, head: HEAD, verdict: "approve", at: NOW, seq: 1 }],
      });
      const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
      expect(answered(await runLoop(s.deps, ctx)).reviewPost).toMatchObject({ posted: false, uncertain: true });
      expect(post).not.toHaveBeenCalled();
      s.ending.drain(true);
      await s.writer.settled();
      expect((await s.store.get(s.run.id))?.reviewPost).toMatchObject({ posted: false, uncertain: true });
    },
  );

  it("a review with canonical original-run acceptance skips settle and native POST even without a display event", async () => {
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const execs: string[] = [];
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: {
        exec: async (command: string) => {
          execs.push(command);
          return command.includes("rev-parse") ? `${HEAD}\n` : "";
        },
      },
      review: {
        head: HEAD,
        post: async (target, body) => {
          posts.push({ target, body });
          return { state: "accepted" as const };
        },
      },
    });
    const resume = finishing("The review: one nit, F1.", {
      agent: "review",
      state: {
        verdict: VERDICT,
        reviewPublication: {
          version: 1,
          runId: s.run.id,
          target: { repo: "o/r", number: 42, commitId: HEAD },
          bodyHash: "c".repeat(64),
          verdict: "approve",
          state: "accepted",
        },
      },
      repoCtx: prThread.repoCtx,
      events: [{ type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 }],
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(posts).toEqual([]);
    expect(execs.filter((c) => c.includes("rev-parse"))).toEqual([]);
    expect(out.reviewHead).toBe(HEAD);
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.status).toBe("completed");
    expect(rec.reviewPost).toEqual({
      posted: true,
      target: { repo: "o/r", number: 42 },
      head: HEAD,
      verdict: "approve",
    });
    // Canonical acceptance survives event trimming without a duplicate display event.
    expect(rec.events.filter((e) => e.type === "review_posted")).toHaveLength(0);
    expect(rec.events.some((e) => e.type === "run_note" && (e as { kind: string }).kind === "review_not_posted")).toBe(
      false,
    );
  });

  // run-history item 48a: a coding child resumed after a bot roll whose tag
  // lost the plan's base — the spawn's dispatch options gone with the process —
  // reads `instance.base` from the coordinator store by parentInstanceId before
  // building its PR target, rather than letting the binding ref (the unit
  // branch itself) stand in.
  it.each([false, true])(
    "keeps one successful unit PR and its base when private chat refusal is %s",
    async (refuseReply) => {
      const BRANCH = "plan/p/u1";
      const description: PrDescription = {
        title: "Fix the login redirect",
        tldr: "Restores the session cookie on login. Users can sign in again.",
        why: "The handler dropped the cookie; this restores it.",
        pointers: [{ label: "The fix", text: "The cookie is set again.", anchor: { path: "src/a", from: 1, to: 2 } }],
        feedbackWanted: "Nothing in particular.",
        verified: "See validation.",
        decisions: [{ title: "Keep it small", rationale: "One-line fix." }],
        risk: "none",
        validation: { criteria: [{ criterion: "tests", proof: "green" }] },
      };
      let checkoutReleased = false;
      const executor = {
        exec: async (cmd: string) => {
          expect(checkoutReleased, "final verification must precede destructive release").toBe(false);
          if (/rev-list --count/.test(cmd)) return "0\n";
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/rev-parse 'refs\/heads\//.test(cmd)) return `${HEAD}\n`;
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          return "";
        },
      };
      const privateAudienceLatch: PrivateAudienceLatch = { revoked: false };
      const directAudience = {
        kind: "slack-unshared-im" as const,
        channelId: "slack:DPRIVATE",
        userId: "slack:UX",
        threadKey: "slack:DPRIVATE:1.0",
      };
      const s = setup("", {
        channelId: directAudience.channelId,
        threadKey: directAudience.threadKey,
        directAudience,
        io: { verifyDirectAudience: async () => ({ ok: true }) },
        agent: "coding",
        provider: neverCalled(),
        repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
        binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
        executor,
        coding: true,
        coordinator: { parentInstanceId: "plan-p-2", idempotencyKey: "plan-p-2:U16/1/coding" },
      });
      const instances = new InMemoryCoordinatorInstanceStore();
      await instances.put({
        id: "plan-p-2",
        kind: "ship",
        userId: "slack:UX",
        channelId: "slack:CX",
        threadKey: THREAD,
        repo: "o/r",
        branch: BRANCH,
        base: "feat/trunk",
        createdAt: NOW,
      });
      s.deps.coordinatorInstances = instances;
      const bindings = new GitBindings();
      expect(
        bindings.register(
          "run-l",
          { repo: "o/r", ref: BRANCH },
          { repo: "o/r", ref: `refs/heads/${BRANCH}`, refConfirmed: true },
          async () => true,
        ),
      ).toBe(true);
      expect(bindings.setBranchRecorder("run-l", { begin: async () => true, finish: async () => true })).toBe(true);
      s.deps.githubBindings = bindings;
      s.ctx.round.release = async () => {
        checkoutReleased = true;
      };
      const opened: Array<Record<string, unknown>> = [];
      let lateAdmission = false;
      s.deps.openPullRequest = async (target) => {
        const claim = await bindings.beginBranch("run-l", {
          ref: `refs/heads/${BRANCH}`,
          old: HEAD,
          next: "c".repeat(40),
        });
        lateAdmission = claim !== undefined;
        if (claim) await claim.finish("not_forwarded");
        opened.push({ ...target });
        if (refuseReply) {
          privateAudienceLatch.revoked = true;
          privateAudienceLatch.code = "followup-indirect";
        }
        return { number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true };
      };
      s.deps.fetchRepoShipInfo = async () => {
        throw new Error("the default branch is not the plan's base and must not be asked for");
      };
      const resume = finishing("Done: pushed the fix.", {
        agent: "coding",
        state: {
          prDescription: description,
          pushedBranch: BRANCH,
          branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        },
      });
      const out = answered(
        await runLoop(
          s.deps,
          await trackedCodingContext(s, { ...s.ctx, privateAudienceLatch, resume, messages: resume.plan.messages }),
        ),
      );
      expect(opened).toHaveLength(1);
      expect(checkoutReleased).toBe(true);
      expect(lateAdmission).toBe(false);
      expect(opened[0]).toMatchObject({ repo: "o/r", headBranch: BRANCH, base: "feat/trunk" });
      if (refuseReply) expect(out.answer).not.toContain("PR opened");
      else expect(out.answer).toContain("PR opened");
      expect(out.prNote).toBeUndefined();
      await deliverAnswer({
        ...s.ctx,
        ...out,
        privateAudienceLatch,
        liveUrl: undefined,
        stopped: undefined,
        releaseWorkspace: out.releaseWorkspace,
      });
      await s.writer.settled();
      const record = await s.store.get(s.run.id);
      expect(record).toMatchObject({ status: "completed", replyOk: true, pr: { number: 9 } });
      expect(opened).toHaveLength(1);
      if (refuseReply) {
        expect(s.replies.join(" ")).not.toContain("PR opened");
        expect(record?.audienceRefusal).toEqual({
          version: 1,
          causeAt: "answer-event",
          withheldAt: "answer-event",
          code: "followup-indirect",
        });
      } else {
        expect(s.replies.join(" ")).toContain("PR opened");
        expect(record?.audienceRefusal).toBeUndefined();
      }
    },
  );

  it("opens the unit PR from the owned receipt even after an auxiliary accepted push", async () => {
    const ref = "plan/p/u1";
    const auxiliary = "assets/other";
    const head = "a".repeat(40);
    const receipt = (branch: string, sha: string) => ({
      type: "pushed_head" as const,
      ref: branch,
      sha,
      by: "push" as const,
    });
    const description: PrDescription = {
      title: "fix(core): keep the owned PR current",
      tldr: "Keeps a PR on the run's owned branch. Auxiliary pushes do not redirect it.",
      why: "The runner observed the owned branch after another write.",
      pointers: [{ label: "Owned branch", text: "Select its receipt.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "Receipt selection.",
      verified: "Focused test.",
      decisions: [],
      risk: "Missing PR.",
      validation: { criteria: [{ criterion: "owned ref", proof: "accepted receipt" }] },
    };
    const s = setup("", {
      agent: "coding",
      coding: true,
      provider: neverCalled(),
      coordinator: checkpointCoordinator,
      repoCtx: { repo: "o/r", ref, baseRef: "main" },
      binding: { ref, sha: head, workspace: "/srv/wt/u1" },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return head;
          if (command.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
          if (command.includes("rev-list --count")) return "0";
          return "";
        },
      },
    });
    const bindings = new GitBindings();
    bindings.register(s.run.id, { repo: "o/r", ref }, undefined, async () => true);
    s.deps.githubBindings = bindings;
    const open = vi.fn(async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8", created: true }));
    s.deps.openPullRequest = open;
    const resume = finishing("Scoped check passed.", {
      agent: "coding",
      state: {
        prDescription: description,
        branchPushReceipts: [receipt(ref, head), receipt(auxiliary, "b".repeat(40))],
      },
    });
    const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
    expect(open).toHaveBeenCalledOnce();
    expect(out.answer).toContain(`Published \`${ref}\` at \`${head}\``);
    expect(out.answer).toContain("PR opened");
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get(s.run.id))?.pr).toMatchObject({ number: 8 });
  });

  it("offers a description turn for the owned receipt after an auxiliary accepted push", async () => {
    const ref = "plan/p/u1";
    const head = "a".repeat(40);
    const description: PrDescription = {
      title: "fix(core): keep the owned PR current",
      tldr: "Keeps a PR on the run's owned branch. Auxiliary pushes do not redirect it.",
      why: "The runner observed the owned branch after another write.",
      pointers: [{ label: "Owned branch", text: "Select its receipt.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "Receipt selection.",
      verified: "Focused test.",
      decisions: [],
      risk: "Missing PR.",
      validation: { criteria: [{ criterion: "owned ref", proof: "accepted receipt" }] },
    };
    const harness = watched(piHarness);
    const followUp = vi.fn(async (turn: { toolContext: { onPrDescription?: (value: PrDescription) => void } }) => {
      turn.toolContext.onPrDescription?.(description);
      return "Description submitted.";
    });
    harness.harness.open = async () => ({ answer: "Done.", followUp, remainingMs: () => 60_000, end: async () => {} });
    const s = setup("", {
      agent: "coding",
      coding: true,
      coordinator: checkpointCoordinator,
      repoCtx: { repo: "o/r", ref, baseRef: "main" },
      binding: { ref, sha: head, workspace: "/srv/wt/u1" },
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return head;
          if (command.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
          if (command.includes("rev-list --count")) return "0";
          return "";
        },
      },
    });
    const find = vi.fn(async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8" }));
    s.deps.findOpenPrByHead = find;
    s.deps.openPullRequest = async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8", created: false });
    const resume = reentering({
      branchPushReceipts: [
        { type: "pushed_head", ref, sha: head, by: "push" },
        { type: "pushed_head", ref: "assets/other", sha: "b".repeat(40), by: "push" },
      ],
    });
    const out = answered(await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume })));
    expect(find).toHaveBeenCalledWith("o/r", ref);
    expect(followUp).toHaveBeenCalledOnce();
    expect(out.answer).toContain(`Published \`${ref}\` at \`${head}\``);
  });

  it("offers the description turn and opens the owned PR after a rejected auxiliary push", async () => {
    const ref = "plan/p/u1";
    const head = "a".repeat(40);
    const auxiliary = "assets/other";
    const description: PrDescription = {
      title: "fix(core): keep the owned PR current",
      tldr: "Keeps a PR on the run's owned branch. A rejected auxiliary write cannot move it.",
      why: "The runner observed the owned branch after an auxiliary rejection.",
      pointers: [{ label: "Owned branch", text: "Select its receipt.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "Receipt selection.",
      verified: "Focused test.",
      decisions: [],
      risk: "Missing PR.",
      validation: { criteria: [{ criterion: "owned ref", proof: "accepted receipt" }] },
    };
    const harness = watched(piHarness);
    const followUp = vi.fn(async (turn: { toolContext: { onPrDescription?: (value: PrDescription) => void } }) => {
      turn.toolContext.onPrDescription?.(description);
      return "Description submitted.";
    });
    harness.harness.open = async () => ({ answer: "Done.", followUp, remainingMs: () => 60_000, end: async () => {} });
    const s = setup("", {
      agent: "coding",
      coding: true,
      coordinator: checkpointCoordinator,
      repoCtx: { repo: "o/r", ref, baseRef: "main" },
      binding: { ref, sha: head, workspace: "/srv/wt/u1" },
      harness: {
        harnesses: roster(harness.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => new FakeHarnessContainer(),
      },
      executor: {
        exec: async (command) => {
          if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
          if (command.includes("rev-parse")) return head;
          if (command.includes("ls-remote")) return `${head}\trefs/heads/${ref}`;
          if (command.includes("rev-list --count")) return "0";
          return "";
        },
      },
    });
    const bindings = new GitBindings();
    bindings.register(s.run.id, { repo: "o/r", ref }, undefined, async () => true);
    s.deps.githubBindings = bindings;
    const find = vi.fn(async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8" }));
    const open = vi.fn(async () => ({ number: 8, htmlUrl: "https://github.com/o/r/pull/8", created: false }));
    s.deps.findOpenPrByHead = find;
    s.deps.openPullRequest = open;
    const out = answered(
      await runLoop(
        s.deps,
        await trackedCodingContext(s, {
          ...s.ctx,
          resume: reentering({
            branchPushReceipts: [{ type: "pushed_head", ref, sha: head, by: "push" }],
            doorPublicationPending: {
              id: "rejected-auxiliary",
              update: { ref: `refs/heads/${auxiliary}`, old: "b".repeat(40), next: "c".repeat(40) },
              outcome: "rejected",
            },
          }),
        }),
      ),
    );
    expect(find).toHaveBeenCalledWith("o/r", ref);
    expect(followUp).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(out.answer).toContain(`Published \`${ref}\` at \`${head}\``);
    expect(out.answer).toContain("PR updated");
  });

  it("opens the unit PR after an auxiliary branch push and a dirty auxiliary checkout", async () => {
    const BRANCH = "plan/p/u1";
    const AUX = "assets/screenshots";
    const AUX_HEAD = "b".repeat(40);
    const description: PrDescription = {
      title: "Fix the email copy",
      tldr: "Shortens the email while preserving the action.",
      why: "The existing email repeats itself.",
      pointers: [{ label: "The copy", text: "One paragraph.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "The wording.",
      verified: "Focused test passed.",
      decisions: [],
      risk: "copy only",
      validation: { criteria: [{ criterion: "email copy", proof: "focused test" }] },
    };
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      coding: true,
      coordinator: { parentInstanceId: "plan-p-2", idempotencyKey: "plan-p-2:U16/0/coding", base: "main" },
      executor: {
        exec: async (cmd: string) => {
          commands.push(cmd);
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${AUX}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${AUX_HEAD}\n`;
          if (/rev-parse 'refs\/heads\//.test(cmd)) return `${HEAD}\n`;
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          if (/status --porcelain/.test(cmd)) return " M assets/screenshot.png\n";
          if (/rev-list --count/.test(cmd)) return "1\n";
          return "";
        },
      },
    });
    const opened: Array<Record<string, unknown>> = [];
    s.deps.openPullRequest = async (target) => {
      opened.push({ ...target });
      return { number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true };
    };
    const resume = finishing("Done.", {
      agent: "coding",
      state: {
        prDescription: description,
        pushedBranch: AUX,
        branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
      },
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "o/r", headBranch: BRANCH, base: "main" });
    expect(String(opened[0].body)).toContain(`blob/${HEAD}/`);
    expect(out.answer).toContain("PR opened");
    expect(out.prNote).toBeUndefined();
    expect(commands.some((cmd) => /^git(?: -C '[^']+')? push/.test(cmd))).toBe(false);
  });

  it("a coordinator child whose plan base survived nowhere — no tag base, no instance in the store — opens nothing and publishes pr_not_opened saying the plan's base was lost across a roll", async () => {
    const BRANCH = "plan/p/u1";
    const description: PrDescription = {
      title: "Fix the login redirect",
      tldr: "Restores the session cookie on login. Users can sign in again.",
      why: "The handler dropped the cookie; this restores it.",
      pointers: [{ label: "The fix", text: "The cookie is set again.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "Nothing in particular.",
      verified: "See validation.",
      decisions: [{ title: "Keep it small", rationale: "One-line fix." }],
      risk: "none",
      validation: { criteria: [{ criterion: "tests", proof: "green" }] },
    };
    const executor = {
      exec: async (cmd: string) => {
        if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
        if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
        if (/rev-parse 'refs\/heads\//.test(cmd)) return `${HEAD}\n`;
        if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
        return "";
      },
    };
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: BRANCH } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      executor,
      coding: true,
      coordinator: { parentInstanceId: "plan-p-2", idempotencyKey: "plan-p-2:U16/1/coding" },
    });
    s.deps.coordinatorInstances = new InMemoryCoordinatorInstanceStore();
    const opened: unknown[] = [];
    s.deps.openPullRequest = async (target) => {
      opened.push(target);
      return { number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true };
    };
    s.deps.fetchRepoShipInfo = async () => ({ defaultBranch: "main" });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { prDescription: description, pushedBranch: BRANCH },
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(opened).toEqual([]);
    expect(out.answer).toContain("the plan's base was lost across a roll");
    expect(out.prNote).toBeUndefined();
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "pr_not_opened")).toEqual(
      [expect.objectContaining({ summary: "no PR opened: the plan's base was lost across a roll" })],
    );
  });

  // record 0062 — a resumed run's pre-restart pushes must never fold into the
  // start state: the ledger row's `pushedBranch` says the run itself pushed
  // the branch before the restart, so a re-read now would list the run's own
  // commits as "start state" and pass the rewrite unjudged.
  const startStateFixture = () => {
    const BRANCH = "plan/p/u1";
    const description: PrDescription = {
      title: "Fix the login redirect",
      tldr: "Restores the session cookie on login. Users can sign in again.",
      why: "The handler dropped the cookie; this restores it.",
      pointers: [{ label: "The fix", text: "The cookie is set again.", anchor: { path: "src/a", from: 1, to: 2 } }],
      feedbackWanted: "Nothing in particular.",
      verified: "See validation.",
      decisions: [{ title: "Keep it small", rationale: "One-line fix." }],
      risk: "none",
      validation: { criteria: [{ criterion: "tests", proof: "green" }] },
    };
    const executor = {
      exec: async (cmd: string) => {
        if (/rev-list --count/.test(cmd)) return "0\n";
        if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
        if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
        if (/rev-parse 'refs\/heads\//.test(cmd)) return `${HEAD}\n`;
        if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
        return "";
      },
    };
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      repoCtx: { repo: "o/r", ref: BRANCH, baseRef: "main" } as RepoContext,
      binding: { ref: BRANCH, sha: HEAD, workspace: "/srv/wt/u1" },
      executor,
      coding: true,
    });
    const reads: string[] = [];
    const startStates: BranchStartState[] = [];
    s.deps.identityRewrite = {
      readStartState: async (_repo, _base, branch): Promise<BranchStartState> => {
        reads.push(branch);
        return { kind: "known", commits: [] };
      },
      rewrite: async ({ startState }) => {
        startStates.push(startState);
        return startState.kind === "unknown"
          ? { kind: "unreadable", reason: `the branch's start state is unknown (${startState.reason ?? ""})` }
          : { kind: "clean" };
      },
      pullRequestHead: async () => undefined,
      isAssignable: async () => undefined,
      addAssignee: async () => undefined,
      requestedLogin: async () => undefined,
    };
    const opened: unknown[] = [];
    s.deps.openPullRequest = async (target) => {
      opened.push({ ...target });
      return { number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true };
    };
    return { BRANCH, description, s, reads, startStates, opened };
  };

  it.each(["seeded", "cold"] as const)(
    "refuses a receipt-only legacy %s checkout without recapturing its published head",
    async (mode) => {
      const { s, BRANCH, reads, description, opened } = startStateFixture();
      s.ctx.round.selection.binding = undefined;
      if (mode === "seeded")
        s.ctx.round.selection.seeded = {
          slug: "o/r",
          ref: BRANCH,
          sha: HEAD,
          workspace: "/workspace",
          cached: false,
          ms: 0,
        };
      else s.ctx.round.selection.cold = { ref: BRANCH, sha: HEAD, workspace: "/workspace/checkout" };
      const resume = finishing("Done", {
        agent: "coding",
        state: {
          prDescription: description,
          branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        },
      });
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages }));
      expect(reads).toEqual([]);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toBeUndefined();
      expect(opened).toEqual([]);
    },
  );

  it.each(["seeded", "cold"] as const)(
    "keeps a legacy pushed %s checkout without original evidence unknown",
    async (mode) => {
      const { s, BRANCH, reads, startStates, description, opened } = startStateFixture();
      s.ctx.round.selection.binding = undefined;
      if (mode === "seeded")
        s.ctx.round.selection.seeded = {
          slug: "o/r",
          ref: BRANCH,
          sha: HEAD,
          workspace: "/workspace",
          cached: false,
          ms: 0,
        };
      else s.ctx.round.selection.cold = { ref: BRANCH, sha: HEAD, workspace: "/workspace/checkout" };
      const resume = finishing("Done", {
        agent: "coding",
        state: {
          pushedBranch: BRANCH,
          prDescription: description,
          branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        },
      });
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages }));
      expect(reads).toEqual([]);
      expect(startStates).toEqual([{ kind: "unknown", reason: expect.stringContaining("before a restart") }]);
      expect(opened).toEqual([]);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toBeUndefined();
    },
  );

  it("uses carried original evidence on a same-ID request restart before opening writable tools", async () => {
    const { s, BRANCH, reads } = startStateFixture();
    const baseline = {
      version: 1 as const,
      binding: {
        runId: s.run.id,
        requester: s.ctx.msg.userId,
        threadKey: s.ctx.msg.threadKey,
        repo: "o/r",
        branch: BRANCH,
        base: "main",
        head: "b".repeat(40),
      },
      state: { kind: "known" as const, commits: [] },
    };
    const observed = watched(piHarness);
    s.deps.harness!.harnesses = roster(observed.harness);
    const ctx = await trackedCodingContext(s, {
      ...s.ctx,
      restartBranchIdentityBaseline: baseline,
      restartIdentityUncertain: true,
    });
    await runLoop(s.deps, ctx);
    expect(reads).toEqual([]);
    expect(observed.calls.open).toHaveLength(1);
    expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toEqual(baseline);
  });

  it.each(["seeded", "cold"] as const)(
    "restores an acknowledged %s baseline instead of recapturing its receipt-only published head",
    async (mode) => {
      const { s, BRANCH, reads, description, opened } = startStateFixture();
      s.ctx.round.selection.binding = undefined;
      if (mode === "seeded")
        s.ctx.round.selection.seeded = {
          slug: "o/r",
          ref: BRANCH,
          sha: HEAD,
          workspace: "/workspace",
          cached: false,
          ms: 0,
        };
      else s.ctx.round.selection.cold = { ref: BRANCH, sha: HEAD, workspace: "/workspace/checkout" };
      const baseline = {
        version: 1 as const,
        binding: {
          runId: s.run.id,
          requester: s.ctx.msg.userId,
          threadKey: s.ctx.msg.threadKey,
          repo: "o/r",
          branch: BRANCH,
          base: "main",
          head: "b".repeat(40),
        },
        state: { kind: "known" as const, commits: [] },
      };
      const resume = finishing("Done", {
        agent: "coding",
        state: {
          prDescription: description,
          branchIdentityBaseline: baseline,
          branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        },
      });
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages }));
      expect(reads).toEqual([]);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toEqual(baseline);
      expect(opened).toHaveLength(1);
    },
  );

  it.each(["auxiliary last", "PR receipt", "accepted checkpoint", "unresolved Door"] as const)(
    "does not read an advanced attachment from canonical history: %s",
    async (kind) => {
      const { s, BRANCH, reads, description, opened } = startStateFixture();
      const original = { parentInstanceId: "pipeline", idempotencyKey: "pipeline:ONE/0/coding", base: "main" };
      s.ctx.coordinator = original;
      const state: Record<string, unknown> = { prDescription: description };
      if (kind === "auxiliary last")
        Object.assign(state, {
          pushedBranch: "auxiliary",
          branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        });
      if (kind === "PR receipt")
        state.publicationReceipts = [
          {
            type: "pushed_head",
            ref: BRANCH,
            sha: HEAD,
            by: "push",
            receipt: {
              callId: "saved",
              previousHeadSha: "b".repeat(40),
              repo: "o/r",
              pr: 9,
              owner: { instanceId: "pipeline", unit: "ONE" },
            },
          },
        ];
      if (kind === "accepted checkpoint")
        state.publicationSettlement = {
          version: 1,
          binding: {
            runId: s.run.id,
            instanceId: "pipeline",
            step: original.idempotencyKey,
            repo: "o/r",
            branch: BRANCH,
            requester: s.ctx.msg.userId,
            threadKey: s.ctx.msg.threadKey,
            generation: "original",
          },
          checkpoint: { kind: "created", head: HEAD },
          publication: { kind: "accepted", head: HEAD },
          preservation: { kind: "pending" },
          release: { kind: "pending" },
        };
      if (kind === "unresolved Door")
        state.doorPublicationPending = {
          id: "pending",
          repo: "o/r",
          update: { ref: `refs/heads/${BRANCH}`, old: "b".repeat(40), next: HEAD },
        };
      const resume = finishing("Done", { agent: "coding", state });
      const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
      await runLoop(s.deps, ctx);
      expect(reads).toEqual([]);
      expect(opened).toEqual([]);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toBeUndefined();
    },
  );

  it.each(["canonical receipt", "unresolved Door", "malformed history"] as const)(
    "carries identity refusal through a live request interruption: %s",
    async (kind) => {
      const { s, BRANCH, reads } = startStateFixture();
      const state: Record<string, unknown> = {};
      if (kind === "canonical receipt")
        state.branchPushReceipts = [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }];
      if (kind === "unresolved Door")
        state.doorPublicationPending = {
          id: "pending",
          repo: "o/r",
          update: { ref: `refs/heads/${BRANCH}`, old: "b".repeat(40), next: HEAD },
        };
      if (kind === "malformed history") state.publicationReceipts = [{ malformed: true }];
      class Interrupted extends HarnessInterruptedError {
        constructor() {
          super("transport interrupted", "transport interrupted", "workspace_lost");
        }
      }
      const observed = watched(piHarness);
      s.deps.harness!.harnesses = roster({
        ...observed.harness,
        open: async () => {
          throw new Interrupted();
        },
      });
      const resume = reentering(state);
      const ctx = await trackedCodingContext(s, { ...s.ctx, resume });
      const outcome = await runLoop(s.deps, ctx);
      expect(outcome).toMatchObject({ kind: "interrupted", restart: { identityUncertain: true } });
      expect(reads).toEqual([]);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toBeUndefined();
    },
  );

  it("refuses a seeded checkout from another repository before capturing evidence or opening writable tools", async () => {
    const { s, BRANCH, reads, opened } = startStateFixture();
    s.ctx.round.selection.binding = undefined;
    s.ctx.round.selection.seeded = {
      slug: "other/repo",
      ref: BRANCH,
      sha: HEAD,
      workspace: "/workspace",
      cached: false,
      ms: 0,
    };
    const observed = watched(piHarness);
    s.deps.harness!.harnesses = roster(observed.harness);
    await expect(runLoop(s.deps, await trackedCodingContext(s))).rejects.toThrow("identity baseline is invalid");
    expect(reads).toEqual([]);
    expect(observed.calls.open).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("keeps an unbound model-cloned checkout unknown without comparing a mutable branch", async () => {
    const { s, BRANCH, reads, startStates, description, opened } = startStateFixture();
    s.ctx.round.selection.binding = undefined;
    const resume = finishing("Done", {
      agent: "coding",
      state: {
        prDescription: description,
        branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
      },
    });
    await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(reads).toEqual([]);
    expect(startStates).toEqual([expect.objectContaining({ kind: "unknown" })]);
    expect(opened).toEqual([]);
  });

  it("restores a standalone non-main PR base and original fingerprints after restart", async () => {
    const { s, BRANCH, reads, startStates, description, opened } = startStateFixture();
    s.ctx.repoCtx.baseRef = "release";
    const baseline = {
      version: 1 as const,
      binding: {
        runId: s.run.id,
        requester: s.ctx.msg.userId,
        threadKey: s.ctx.msg.threadKey,
        repo: "o/r",
        branch: BRANCH,
        base: "release",
        head: "b".repeat(40),
      },
      state: { kind: "known" as const, commits: [] },
    };
    const resume = finishing("Done", {
      agent: "coding",
      state: {
        prDescription: description,
        pushedBranch: BRANCH,
        branchIdentityBaseline: baseline,
        branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
      },
    });
    await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(reads).toEqual([]);
    expect(startStates).toEqual([baseline.state]);
    expect(opened).toEqual([expect.objectContaining({ base: "release" })]);
  });

  it("refuses a changed resolved PR base rather than replacing the saved identity binding", async () => {
    const { s, BRANCH, reads, description, opened } = startStateFixture();
    const resume = finishing("Done", {
      agent: "coding",
      state: {
        prDescription: description,
        branchIdentityBaseline: {
          version: 1,
          binding: {
            runId: s.run.id,
            requester: s.ctx.msg.userId,
            threadKey: s.ctx.msg.threadKey,
            repo: "o/r",
            branch: BRANCH,
            base: "release",
            head: "b".repeat(40),
          },
          state: { kind: "known", commits: [] },
        },
      },
    });
    await expect(
      runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    ).rejects.toThrow("identity baseline is invalid");
    expect(reads).toEqual([]);
    expect(opened).toEqual([]);
  });

  it.each(["resident", "seeded", "cold"] as const)(
    "awaits the frozen attachment read and its durable acknowledgment before opening writable tools (%s)",
    async (mode) => {
      const { s, BRANCH } = startStateFixture();
      if (mode !== "resident") {
        s.ctx.round.selection.binding = undefined;
        if (mode === "seeded")
          s.ctx.round.selection.seeded = {
            slug: "o/r",
            ref: BRANCH,
            sha: HEAD,
            workspace: "/workspace",
            cached: false,
            ms: 0,
          };
        else s.ctx.round.selection.cold = { ref: BRANCH, sha: HEAD, workspace: "/workspace/checkout" };
      }
      const observed = watched(piHarness);
      s.deps.harness!.harnesses = roster(observed.harness);
      let releaseRead!: () => void;
      let enterRead!: () => void;
      const reading = new Promise<void>((resolve) => {
        enterRead = resolve;
      });
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      s.deps.identityRewrite!.readStartState = async (_repo, _base, head) => {
        expect(head).toBe(HEAD);
        enterRead();
        await readGate;
        return { kind: "known", commits: [] };
      };
      const ctx = await trackedCodingContext(s);
      const commit = ctx.ledgerRun!.commitState.bind(ctx.ledgerRun!);
      let releaseAck!: () => void;
      let enterAck!: () => void;
      const acknowledging = new Promise<void>((resolve) => {
        enterAck = resolve;
      });
      const ackGate = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      vi.spyOn(ctx.ledgerRun!, "commitState").mockImplementation(async (patch) => {
        if (patch.branchIdentityBaseline !== undefined) {
          enterAck();
          await ackGate;
        }
        return commit(patch);
      });
      const task = runLoop(s.deps, ctx);
      await reading;
      expect(observed.calls.open).toEqual([]);
      releaseRead();
      await acknowledging;
      expect(observed.calls.open).toEqual([]);
      releaseAck();
      await task;
      expect(observed.calls.open).toHaveLength(1);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toMatchObject({
        binding: { head: HEAD, branch: BRANCH },
        state: { kind: "known", commits: [] },
      });
    },
  );

  it.each(["fenced", "unavailable"] as const)(
    "refuses writable tools when the identity baseline acknowledgment is %s",
    async (status) => {
      const { s, opened } = startStateFixture();
      const observed = watched(piHarness);
      s.deps.harness!.harnesses = roster(observed.harness);
      const ctx = await trackedCodingContext(s);
      const commit = ctx.ledgerRun!.commitState.bind(ctx.ledgerRun!);
      vi.spyOn(ctx.ledgerRun!, "commitState").mockImplementation(async (patch) =>
        patch.branchIdentityBaseline !== undefined ? status : commit(patch),
      );
      await expect(runLoop(s.deps, ctx)).rejects.toThrow("baseline could not be committed");
      expect(observed.calls.open).toEqual([]);
      expect(opened).toEqual([]);
      expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toBeUndefined();
    },
  );

  it("refuses writable tools without a durable ledger for the first identity baseline", async () => {
    const { s, opened } = startStateFixture();
    const observed = watched(piHarness);
    s.deps.harness!.harnesses = roster(observed.harness);
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("baseline could not be committed");
    expect(observed.calls.open).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("rejects a foreign restored identity baseline without rereading the advanced branch", async () => {
    const { s, reads, opened, description, BRANCH } = startStateFixture();
    const resume = finishing("Done", { agent: "coding", state: { prDescription: description, pushedBranch: BRANCH } });
    const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
    resume.row.state.branchIdentityBaseline = {
      version: 1,
      binding: {
        runId: "foreign",
        requester: s.ctx.msg.userId,
        threadKey: s.ctx.msg.threadKey,
        repo: "o/r",
        branch: BRANCH,
        base: "main",
        head: HEAD,
      },
      state: { kind: "known", commits: [] },
    };
    await expect(runLoop(s.deps, ctx)).rejects.toThrow("identity baseline is invalid");
    expect(reads).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("restores the original acknowledged identity baseline after a native push and restart", async () => {
    const { BRANCH, description, s, reads, startStates, opened } = startStateFixture();
    const state = {
      kind: "known" as const,
      commits: [
        {
          sha: "a".repeat(40),
          author: { name: "prior", email: "prior@example.test" },
          date: "2026-01-01T00:00:00Z",
          message: "Original inherited work",
        },
      ],
    };
    const branchIdentityBaseline = {
      version: 1 as const,
      binding: {
        runId: s.run.id,
        requester: s.ctx.msg.userId,
        threadKey: s.ctx.msg.threadKey,
        repo: "o/r",
        branch: BRANCH,
        base: "main",
        head: "b".repeat(40),
      },
      state,
    };
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: {
        prDescription: description,
        pushedBranch: BRANCH,
        branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        branchIdentityBaseline,
      },
    });
    const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
    const out = answered(await runLoop(s.deps, ctx));
    expect(reads).toEqual([]);
    expect(startStates).toEqual([state]);
    expect(opened).toHaveLength(1);
    expect(out.answer).toContain("https://github.com/o/r/pull/9");
    expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchIdentityBaseline).toEqual(branchIdentityBaseline);
  });

  it("a resumed run whose ledger row records a pre-restart push of its own branch fires no start-state re-read: the rewrite is asked over an UNKNOWN start state naming the restart and fails closed, so nothing opens over the pre-restart commits", async () => {
    const { BRANCH, description, s, reads, startStates, opened } = startStateFixture();
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: {
        prDescription: description,
        pushedBranch: BRANCH,
        branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
      },
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(reads).toEqual([]);
    expect(startStates).toEqual([{ kind: "unknown", reason: expect.stringContaining("before a restart") }]);
    expect(opened).toEqual([]);
    expect(out.answer).toContain("could not be verified");
    expect(out.prNote).toBeUndefined();
  });

  it("a resumed run whose ledger row records NO push of the binding branch still reads the start state at attach: the rewrite judges over the read state and a clean branch opens", async () => {
    const { description, s, reads, startStates, opened } = startStateFixture();
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { prDescription: description },
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(reads).toEqual([HEAD]);
    expect(startStates).toEqual([]); // No accepted write: the PR post-step never rewrites or opens.
    expect(opened).toHaveLength(0);
    expect(out.answer).toContain("No push was confirmed");
    expect(out.prNote).toBeUndefined();
  });

  it("malformed restored push history refuses a later native push and preserves the original evidence", async () => {
    const { BRANCH, description, s, opened } = startStateFixture();
    const bindings = new GitBindings();
    expect(bindings.register(s.run.id, { repo: "o/r", ref: BRANCH }, undefined)).toBe(true);
    s.deps.githubBindings = bindings;
    const raw = [{ type: "pushed_head", ref: BRANCH, sha: "unreadable-sha", by: "push", opaque: "retained fixture" }];
    const resume = finishing("Done", {
      agent: "coding",
      state: { prDescription: description, branchPushReceipts: raw },
    });
    const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
    ctx.githubDoor = { baseUrl: "https://door.example.com", bearer: "fixture-door" };
    let attempted = false;
    let nativeCalls = 0;
    const originalExec = ctx.round.selection.executor.exec.bind(ctx.round.selection.executor);
    ctx.round.selection.executor.exec = async (command, options) => {
      if (!attempted && bindings.isModelClosed(s.run.id)) {
        attempted = true;
        const claim = await bindings.beginPostStepPublication(s.run.id, {
          ref: `refs/heads/${BRANCH}`,
          old: HEAD,
          next: "f".repeat(40),
        });
        if (claim) {
          nativeCalls++;
          await claim.finish("accepted");
        }
      }
      return originalExec(command, options);
    };
    await runLoop(s.deps, ctx);
    expect(attempted).toBe(true);
    expect(nativeCalls).toBe(0);
    expect((await s.deps.runLedger!.readLiveRuns())[0]!.state.branchPushReceipts).toEqual(raw);
    expect(opened).toHaveLength(0);
    s.ending.drain(true);
    await s.writer.settled();
    expect(s.releases).toEqual([]);
  });

  it.each(["accepted", "accepted repo casing", "unknown", "stopped"] as const)(
    "identity ref publication uses the original run's durable Door recorder: %s",
    async (outcome) => {
      const { BRANCH, description, s, opened } = startStateFixture();
      const bindings = new GitBindings();
      expect(
        bindings.register(
          s.run.id,
          { repo: outcome === "accepted repo casing" ? "O/R" : "o/r", ref: BRANCH },
          undefined,
        ),
      ).toBe(true);
      s.deps.githubBindings = bindings;
      const next = "f".repeat(40);
      let nativeCalls = 0;
      s.deps.identityRewrite!.rewrite = async ({ refPublication }) => {
        const claim = await refPublication?.begin({
          repo: "o/r",
          update: { ref: `refs/heads/${BRANCH}`, old: HEAD, next },
        });
        if (!claim) return { kind: "unreadable", reason: "original publication refused" };
        const row = (await s.deps.runLedger!.readLiveRuns()).find((row) => row.runId === s.run.id)!;
        expect(row.state.doorPublicationPending).toMatchObject({
          repo: "o/r",
          update: { ref: `refs/heads/${BRANCH}`, old: HEAD, next },
        });
        nativeCalls++;
        const accepted = await claim.finish(outcome.startsWith("accepted") ? "accepted" : "unknown");
        const saved = (await s.deps.runLedger!.readLiveRuns()).find((row) => row.runId === s.run.id)!;
        if (outcome.startsWith("accepted")) {
          expect(accepted).toBe(true);
          expect(saved.state.doorPublicationPending).toBeNull();
          expect(saved.state.branchPushReceipts).toContainEqual({
            type: "pushed_head",
            ref: BRANCH,
            sha: next,
            by: "push",
          });
          return { kind: "rewritten", count: 1, replaced: ["author"], tip: next };
        }
        expect(accepted).toBe(false);
        expect(saved.state.doorPublicationPending).toMatchObject({ update: { next } });
        return { kind: "unreadable", reason: "original publication unconfirmed" };
      };
      s.deps.identityRewrite!.pullRequestHead = async () => next;
      const resume = finishing("Done", {
        agent: "coding",
        state: {
          prDescription: description,
          pushedBranch: BRANCH,
          branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
        },
      });
      const ctx = await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages });
      if (outcome === "stopped") {
        const read = s.deps.runLedger!.readLiveRuns.bind(s.deps.runLedger!);
        vi.spyOn(s.deps.runLedger!, "readLiveRuns").mockImplementation(async () =>
          (await read()).map((row) => (row.state.doorPublicationPending ? { ...row, stop: "hard" } : row)),
        );
      }
      await runLoop(s.deps, ctx);
      expect(nativeCalls).toBe(outcome === "stopped" ? 0 : 1);
      expect(opened).toHaveLength(outcome.startsWith("accepted") ? 1 : 0);
    },
  );

  it("records the identity rewrite's final pushed head for the coordinator's exact-head read", async () => {
    const { BRANCH, description, s } = startStateFixture();
    const rewrittenHead = "f".repeat(40);
    s.deps.identityRewrite!.rewrite = async () => ({
      kind: "rewritten",
      count: 1,
      replaced: ["author"],
      tip: rewrittenHead,
    });
    s.deps.identityRewrite!.pullRequestHead = async () => rewrittenHead;
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: {
        prDescription: description,
        pushedBranch: BRANCH,
        branchPushReceipts: [{ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "push" }],
      },
    });
    await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages }));
    s.ending.drain(true);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.headSha).toBe(rewrittenHead);
    expect(record.pushed).toEqual([{ ref: BRANCH, sha: rewrittenHead, by: "push" }]);
    expect(record.events.filter((event) => event.type === "pushed_head")).toEqual([
      expect.objectContaining({ ref: BRANCH, sha: rewrittenHead }),
    ]);
  });

  it("PR attribution uses the initiating requester and thread even without a binding or after a binding lookup failure", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example.com");
    for (const binding of ["ivy-dev", undefined, new Error("GitHub unavailable")]) {
      const { description, s, opened } = startStateFixture();
      const requestedLogin = vi.fn(async () => {
        if (binding instanceof Error) throw binding;
        return binding;
      });
      s.deps.identityRewrite!.requestedLogin = requestedLogin;
      const instances = new InMemoryCoordinatorInstanceStore();
      await instances.put({
        id: "plan-attribution",
        kind: "ship",
        userId: s.ctx.msg.userId,
        userName: "Ivy",
        channelId: "slack:C1",
        threadKey: "slack:C1:1.0",
        repo: "o/r",
        branch: "plan/p/u1",
        base: "main",
        createdAt: NOW,
      });
      s.deps.coordinatorInstances = instances;
      const resume = finishing("Done.", {
        agent: "coding",
        state: {
          prDescription: description,
          branchIdentityBaseline: {
            version: 1,
            binding: {
              runId: s.run.id,
              requester: s.ctx.msg.userId,
              threadKey: s.ctx.msg.threadKey,
              repo: "o/r",
              branch: "plan/p/u1",
              base: "main",
              head: "b".repeat(40),
              instanceId: "plan-attribution",
              step: "plan-attribution:U12/0/coding",
            },
            state: { kind: "known", commits: [] },
          },
          branchPushReceipts: [{ type: "pushed_head", ref: "plan/p/u1", sha: HEAD, by: "push" }],
        },
      });
      await runLoop(
        s.deps,
        await trackedCodingContext(s, {
          ...s.ctx,
          coordinator: {
            parentInstanceId: "plan-attribution",
            idempotencyKey: "plan-attribution:U12/0/coding",
            base: "main",
          },
          resume,
          messages: resume.plan.messages,
        }),
      );
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        body: expect.stringMatching(
          /^Requested by \*\*Ivy\*\* · \[Thread\]\(https:\/\/bot.example.com\/threads\/slack%3AC1%3A1.0\)/,
        ),
      });
      expect(requestedLogin).toHaveBeenCalledWith(s.ctx.msg.userId);
    }
  });

  it("on the pi harness no pi is started and the one the previous generation left is ended at its recorded pid and root (harness-pi item 8)", async () => {
    const container = new FakeHarnessContainer();
    container.alivePids.add(777); // Observed original producer, not a physical stop/capture ACK.
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harnesses: roster(),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { pid: 777, logOffset: 10, root: "/tmp/switchboard-pi-old-build-run-l" } },
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Done: pushed the fix.");
    expect(container.starts).toEqual([]);
    expect(container.stdin).toEqual([]);
    expect(container.killed).toEqual([777]);
    expect(container.removed).toEqual(["/tmp/switchboard-pi-old-build-run-l"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  // harness.md item 9: the seam rethrows the executor's word that the container
  // is gone; a `finish` plan reads it as nothing left to end, never a failure.
  it("on the pi harness a `finish` plan whose container is gone under the question — the seam rethrows the executor's typed word — ends nothing, notes it, and runs the post-steps with the answer", async () => {
    const container = new FakeHarnessContainer();
    container.identity = async () => {
      throw new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
    };
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harnesses: roster(),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { pid: 777, logOffset: 10, root: "/var/tmp/switchboard-pi-run-l", container: "vm-old" } },
    });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Done: pushed the fix.");
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
    const notes = s.registry
      .snapshotById("run-l")!
      .events.filter((e) => e.type === "run_note")
      .map((e) => (e as { summary: string }).summary);
    expect(notes).toContainEqual(
      "the container this run was handed is gone under the finish, so nothing of the run's pi process (pid 777) is here to end",
    );
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("on the pi harness a foreign original finish retains its workspace without ending the producer", async () => {
    const container = new FakeHarnessContainer();
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harnesses: roster(),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { pid: 777, logOffset: 10, root: "/var/tmp/switchboard-pi-run-l", container: "vm-old" } },
    });
    await expect(
      runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    ).rejects.toThrow(/original pi producer/);
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
    expect(container.starts).toEqual([]);
    expect(s.releases).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
  });

  // docs/reference/specs/harness.md item 8: the row's word wins. A resumed row
  // is judged, ended and driven by the harness its facts name, picked off the
  // roster — whatever the preset's configuration word says now — so a preset
  // flipped between generations never mismatches a run in flight.
  const OPENCODE_ROW = {
    harness: "opencode",
    pid: 9,
    port: 41000,
    logOffset: 0,
    sessionID: "ses_1",
    root: "/var/tmp/switchboard-oc-run-l",
    bearerHash: "h",
    container: "vm-1",
    relaunches: 0,
  };

  it("a `finish` plan whose row carries OpenCode's facts is judged and ended by the OpenCode harness off the roster, though the preset's word says pi: pi is asked nothing, no process is started, and the post-steps run with the answer", async () => {
    const container = new FakeHarnessContainer();
    const pi = watched(piHarness);
    const oc = watched(openCodeHarness);
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harnesses: roster(pi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", { agent: "coding", state: { harness: OPENCODE_ROW } });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Done: pushed the fix.");
    expect(oc.calls.find).toEqual([OPENCODE_ROW]);
    expect(oc.calls.end).toEqual([OPENCODE_ROW]);
    expect(pi.calls).toEqual({ open: [], find: [], end: [] });
    expect(container.starts).toEqual([]);
    expect(container.killed).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a `finish` plan whose judge answers another-harness — the roster's object disowns the row it was picked for — ends nothing and says so in a resumed note", async () => {
    const container = new FakeHarnessContainer();
    const oc = watched(openCodeHarness, { find: "another-harness" });
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      harness: {
        harnesses: roster(piHarness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", { agent: "coding", state: { harness: OPENCODE_ROW } });
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Done: pushed the fix.");
    expect(oc.calls.find).toEqual([OPENCODE_ROW]);
    expect(oc.calls.end).toEqual([]);
    const notes = s.registry
      .snapshotById("run-l")!
      .events.filter((e) => e.type === "run_note")
      .map((e) => (e as { summary: string }).summary);
    expect(notes).toContainEqual(
      "the run's row carries opencode harness facts (pid 9) that the opencode harness does not own: that process was neither judged nor ended here",
    );
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a resume mid-loop whose row carries OpenCode's facts opens on the OpenCode harness off the roster with the row's facts as its resume — the preset's word says pi now, and pi is never opened; the run completes on OpenCode's answer", async () => {
    const container = new FakeHarnessContainer();
    const pi = watched(piHarness);
    const oc = watched(openCodeHarness, { answer: "Resumed on OpenCode." });
    const s = setup("unused", {
      agent: "general",
      yaml: YAML + "harness:\n  general: pi\n",
      harness: {
        harnesses: roster(pi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => container,
      },
    });
    const resume = reentering({ harness: OPENCODE_ROW }, "general");
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Resumed on OpenCode.");
    expect(oc.calls.open).toEqual([OPENCODE_ROW]);
    expect(pi.calls.open).toEqual([]);
    expect(container.starts).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a resumed run sets its resident deadline from the saved lease remainder without a new lease event", async () => {
    const deadlines: number[] = [];
    const oc = watched(openCodeHarness, { answer: "Resumed." });
    const s = setup("unused", {
      agent: "general",
      executor: { setRunDeadline: async (ms) => void deadlines.push(ms) },
      harness: {
        harnesses: roster(piHarness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const resume = reentering({ harness: OPENCODE_ROW }, "general");
    answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(deadlines).toEqual([resume.plan.remainingMs]);
  });

  // harness.md item 8: the row's word wins over every scope's — a person who
  // moved their runs to OpenCode while one was in flight on pi resumes that run
  // on pi, and OpenCode is never opened for it.
  it("a resume mid-loop whose row carries pi's facts opens on pi with the row's facts, though the requester's own scope says opencode now; OpenCode is never opened", async () => {
    const container = new FakeHarnessContainer();
    const pi = watched(piHarness, { answer: "Resumed on pi." });
    const oc = watched(openCodeHarness);
    const s = setup("unused", {
      agent: "general",
      yaml: YAML + 'users:\n  "slack:UX":\n    harness:\n      general: opencode\n',
      harness: {
        harnesses: roster(pi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => container,
      },
    });
    const PI_ROW = { harness: "pi", pid: 4242, logOffset: 10, root: "/tmp/switchboard-pi-run-l", container: "vm-1" };
    const resume = reentering({ harness: PI_ROW }, "general");
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Resumed on pi.");
    expect(pi.calls.open).toEqual([expect.objectContaining(PI_ROW)]);
    expect(oc.calls.open).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  // docs/reference/specs/harness.md item 8: a row naming a harness this build
  // does not know (a rollback under a newer build's row, a harness removed) is
  // no facts, so the run is rebuilt on the preset's harness — and the record
  // says so, because that process is the one left running with no note.
  const CODEX_ROW = { harness: "codex", pid: 31, container: "vm-1", threadId: "thr_1" };

  it("a resume whose row names a harness this build does not know is rebuilt on the preset's harness with one resumed note naming the word, the pid and the container as neither judged nor ended here — and a finish with such a row runs its post-steps with the same note", async () => {
    const container = new FakeHarnessContainer();
    const pi = watched(piHarness, { answer: "Rebuilt on pi." });
    const oc = watched(openCodeHarness);
    const s = setup("unused", {
      agent: "general",
      harness: {
        harnesses: roster(pi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => container,
      },
    });
    const resume = reentering({ harness: CODEX_ROW }, "general");
    const out = answered(
      await runLoop(s.deps, await trackedCodingContext(s, { ...s.ctx, resume, messages: resume.plan.messages })),
    );
    expect(out.answer).toBe("Rebuilt on pi.");
    // The rebuild: the preset's harness, opened with no facts — the row's are no facts to it.
    expect(pi.calls.open).toEqual([undefined]);
    expect(oc.calls).toEqual({ open: [], find: [], end: [] });
    expect(pi.calls.find).toEqual([]);
    expect(pi.calls.end).toEqual([]);
    const notes = () =>
      s.registry
        .snapshotById("run-l")!
        .events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "resumed")
        .map((e) => (e as { summary: string }).summary);
    expect(notes()).toEqual([
      "the row names the codex harness, which this build does not know; its process (pid 31 in container vm-1) was neither judged nor ended here; the run was rebuilt on pi",
    ]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });

    // A finish plan with the same row: the answer is in hand, nothing is judged
    // or ended, and the same note says what was left running — the pid and
    // container `unknown` when the row did not record them.
    const finishPi = watched(piHarness);
    const t = setup("", {
      agent: "coding",
      provider: neverCalled(),
      harness: {
        harnesses: roster(finishPi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const finishResume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { harness: "codex" } },
    });
    const finished = answered(
      await runLoop(t.deps, { ...t.ctx, resume: finishResume, messages: finishResume.plan.messages }),
    );
    expect(finished.answer).toBe("Done: pushed the fix.");
    expect(finishPi.calls).toEqual({ open: [], find: [], end: [] });
    const finishNotes = t.registry
      .snapshotById("run-l")!
      .events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "resumed")
      .map((e) => (e as { summary: string }).summary);
    expect(finishNotes).toContainEqual(
      "the row names the codex harness, which this build does not know; its process (pid unknown in container unknown) was neither judged nor ended here; the run finished on the answer it already had",
    );
    expect(t.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });
});

// Feature: docs/reference/specs/harness.md item 8 — the configuration word
// `harness.<preset>` picks a fresh run's harness off the roster: the named
// preset opens on that object, every other preset on pi, and no block at all
// is pi everywhere. Nothing defaults to OpenCode.
describe("the configuration word — harness.<preset> picks a fresh run's harness off the roster", () => {
  const cases: Array<{ yaml: string; opens: "pi" | "opencode" }> = [
    { yaml: YAML + "harness:\n  general: opencode\n", opens: "opencode" },
    { yaml: YAML + "harness:\n  coding: opencode\n", opens: "pi" },
    { yaml: YAML + "harness:\n  general: pi\n", opens: "pi" },
    { yaml: YAML, opens: "pi" },
  ];

  it.each(cases)("$yaml → a general run opens on $opens", async ({ yaml, opens }) => {
    const pi = watched(piHarness, { answer: "from pi" });
    const oc = watched(openCodeHarness, { answer: "from opencode" });
    const s = setup("unused", {
      agent: "general",
      yaml,
      harness: {
        harnesses: roster(pi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    const picked = opens === "pi" ? pi : oc;
    const other = opens === "pi" ? oc : pi;
    expect(out.answer).toBe(`from ${opens}`);
    expect(picked.calls.open).toEqual([undefined]); // a fresh run: no facts to resume
    expect(other.calls.open).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });
});

// Feature: docs/reference/specs/harness.md item 8; routing-and-config.md item 2
// — the word is a scope setting: a user's or a channel's `harness.<preset>`
// picks a fresh run's harness ahead of the deployment's block, on the same
// ladder as the model (user > channel > defaults, an unset layer falling
// through, no word anywhere → pi), so one person moves their own runs without
// moving the deployment; two people's runs in one process open on different
// harnesses off one roster. A resumed row keeps the harness its facts name
// whatever the scopes say now.
// Feature: docs/reference/specs/execution.md item 9 — the run control's lease
// clock is started by the RUN LOOP on the harness's own `lease` event,
// whichever harness published it (pi and OpenCode both do), so every attach
// the run's resident executor opens is clipped to the run; a relaunch that
// finds the run inside its write-up reserve asks for no workspace and ends the
// run on its budget, never `workspace_lost`.
describe("the run control's lease clock — started by the run loop on the harness's lease event, read by the relaunch", () => {
  /** A harness of the roster whose `open` publishes the lease as the real ones
   *  do and reads the control's clock before and after it; `then` runs on the
   *  opened run before the scripted answer (a throw ends the open with it). */
  function leasing(base: Harness, endsInMs: number, seen: Array<number | undefined>, then?: (run: HarnessRun) => void) {
    const harness: Harness = {
      name: base.name,
      history: base.history,
      dispositions: base.dispositions,
      effort: (tier) => base.effort(tier),
      builtinTools: (identity) => base.builtinTools(identity),
      open: async (_deps, run) => {
        seen.push(run.control?.remainingMs());
        run.onEvent?.({ type: "lease", startedAt: NOW, endsAt: NOW + endsInMs, loopEndsAt: NOW + endsInMs, at: NOW });
        seen.push(run.control?.remainingMs());
        then?.(run);
        return { answer: "Done.", followUp: async () => "", remainingMs: () => endsInMs, end: async () => {} };
      },
      find: async () => "alive-here",
      end: async () => {},
    };
    return harness;
  }
  const harnessDeps = (h: Harness): HarnessProcessDeps => ({
    harnesses: roster(h, h),
    registry: new HarnessRegistry(),
    harnessUrl: "https://bot.example.com",
    loopbackUrl: "http://127.0.0.1:8080",
    containerFor: () => new FakeHarnessContainer(),
  });

  it("an OpenCode run: the control's clock is undefined before the harness's `lease` event and the lease's remainder after it — the run loop started it on the event; the harness never touched the control", async () => {
    const seen: Array<number | undefined> = [];
    const s = setup("unused", {
      agent: "general",
      yaml: YAML + "harness:\n  general: opencode\n",
      harness: harnessDeps(leasing(openCodeHarness, 5 * 60_000, seen)),
    });
    expect(s.run.control.remainingMs()).toBeUndefined(); // the dispatch's attach runs here, before the lease
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("Done.");
    expect(seen).toEqual([undefined, 5 * 60_000]);
    expect(s.run.control.remainingMs()).toBe(5 * 60_000);
  });

  it("a container replaced with the run inside its write-up reserve: the relaunch asks for no workspace and the run ends on its budget — the `time_budget_exhausted` note saying why, the budget's answer, the status `completed`; no `resumed`, no `sandbox_restarted` from the loop, no restart from the request", async () => {
    const record: HarnessRecord = {
      messages: [],
      compactions: [],
      settlements: [],
      turn: 1,
      inboxConsumedSeq: 0,
      deadline: NOW + 30_000,
    };
    const facts: HarnessFacts = {
      harness: "pi",
      pid: 4242,
      logOffset: 0,
      root: "/tmp/switchboard-pi-run-l",
      container: "vm-a",
      relaunches: 0,
    };
    const seen: Array<number | undefined> = [];
    let opens = 0;
    // The first open submits a PR description (the model's, before the death —
    // what the tail's PR post-step would act on) and dies with its container
    // after leaving its facts; a second open would be the relaunch the decision
    // must not make.
    const replaced = leasing(piHarness, 30_000, seen, (run) => {
      if (opens++ > 0) return;
      run.toolContext.onPrDescription?.({
        title: "fix(x): the thing",
        tldr: "Does the thing. It matters.",
        why: "Because.",
        pointers: [{ label: "The thing", text: "Here.", anchor: { path: "src/x.ts", from: 1, to: 2 } }],
        feedbackWanted: "Nothing.",
        verified: "Tests.",
        decisions: [],
        risk: "none",
        validation: { criteria: [] },
      });
      run.saveFacts?.(facts);
      throw new HarnessContainerReplacedError(
        "the container running pi was replaced (vm-a → vm-b)",
        "the sandbox restarted under the run (waited 42 s)",
        "vm-a",
        "vm-b",
        record,
      );
    });
    // A coding PR run: its round has a workspace to re-attach (the machine class
    // of `general` has none, and a run without one never reaches the re-attach),
    // and its tail would observe the workspace and salvage — both against the
    // replaced container's executor, whose worktree was never re-attached.
    const execs: string[] = [];
    const s = setup("unused", {
      agent: "coding",
      coding: true,
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: harnessDeps(replaced),
      binding: { ref: "main", sha: "abc", workspace: "/workspace/threads/t/main", user: "worker2" },
      executor: {
        exec: async (command) => {
          execs.push(command);
          return "";
        },
      },
    });
    const { ledgerRun, record: recorded } = recordingLedgerRun();
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun }));
    expect(opens).toBe(1);
    expect(seen).toEqual([undefined, 30_000]);
    // The budget's plain answer — the "without finishing" form, no label around
    // empty text — and nothing appended by a PR post-step that ran on an
    // observation that never happened.
    expect(out.answer).toBe(
      `Stopped at the ${s.ctx.agent.maxMinutes}-minute budget without finishing. Partial work may exist in the workspace — this is a bug: the task outlived its run budget and no automatic continuation was scheduled.`,
    );
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    // Nothing drove the replaced container's executor after the end: no workspace observation, no salvage, no post-step.
    expect(execs).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const notes = (recorded().events as Array<{ type: string; kind?: string; summary?: string }>).filter(
      (e) => e.type === "run_note",
    );
    expect(notes.filter((n) => n.kind === "time_budget_exhausted").map((n) => n.summary)).toEqual([
      "the container was replaced under the run: the run has 30s of wall clock left, inside the 60s write-up reserve, so no attach was opened; no write-up ran",
    ]);
    // The whole tail is skipped, as a hard stop skips it: no salvage, no
    // work-left-behind note, no PR post-step outcome for a tree nobody looked at.
    expect(
      notes.some(
        (n) =>
          n.kind === "resumed" ||
          n.kind === "sandbox_restarted" ||
          n.kind === "budget_salvage" ||
          n.kind === "work_left_behind",
      ),
    ).toBe(false);
    expect(out.prNote).toBeUndefined();
    expect((recorded().events as Array<{ type: string }>).some((e) => e.type === "pr_opened")).toBe(false);
  });

  it("a container replaced with a REVIEW run inside its write-up reserve: the review half of the tail is skipped too — no head settle on the replaced container, no verdict turn, no GitHub post of the budget's answer as a verdict", async () => {
    const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const record: HarnessRecord = {
      messages: [],
      compactions: [],
      settlements: [],
      turn: 1,
      inboxConsumedSeq: 0,
      deadline: NOW + 30_000,
    };
    const facts: HarnessFacts = {
      harness: "pi",
      pid: 4242,
      logOffset: 0,
      root: "/tmp/switchboard-pi-run-l",
      container: "vm-a",
      relaunches: 0,
    };
    const seen: Array<number | undefined> = [];
    let opens = 0;
    // The executor's commands, and how many had run when the container died:
    // the review's baseline reading diff runs before the model (start of the
    // run); nothing may run after the end.
    const execs: string[] = [];
    let execsAtDeath = -1;
    // The first open dies with its container before any verdict, leaving its
    // facts; a second open would be the relaunch the decision must not make.
    const replaced = leasing(piHarness, 30_000, seen, (run) => {
      if (opens++ > 0) return;
      execsAtDeath = execs.length;
      run.saveFacts?.(facts);
      throw new HarnessContainerReplacedError(
        "the container running pi was replaced (vm-a → vm-b)",
        "the sandbox restarted under the run (waited 42 s)",
        "vm-a",
        "vm-b",
        record,
      );
    });
    // A PR review on the resident: its round has a workspace to re-attach, and
    // its tail would settle the reviewed head (`git rev-parse HEAD` on the
    // replaced container's executor), ask the model for a verdict it never gave,
    // and post the answer to the pull request as a not-approving verdict.
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const s = setup("unused", {
      agent: "review",
      yaml: YAML + "harness:\n  review: pi\n",
      harness: harnessDeps(replaced),
      repoCtx: { repo: "o/r", pr: 42, ref: "fix/the-pr-head", refFromPr: true, baseRef: "main" } as RepoContext,
      binding: { ref: "fix/the-pr-head", sha: HEAD, workspace: "/srv/wt/pr-42" } as ResidentBinding,
      executor: {
        exec: async (command) => {
          execs.push(command);
          return `${HEAD}\n`;
        },
      },
      review: {
        head: HEAD,
        post: async (target, body) => {
          posts.push({ target, body });
          return { state: "accepted" as const };
        },
      },
    });
    const { ledgerRun, record: recorded } = recordingLedgerRun();
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun }));
    expect(opens).toBe(1);
    expect(seen).toEqual([undefined, 30_000]);
    expect(out.answer).toBe(
      `Stopped at the ${s.ctx.agent.maxMinutes}-minute budget without finishing. Partial work may exist in the workspace — this is a bug: the task outlived its run budget and no automatic continuation was scheduled.`,
    );
    // Nothing drove the replaced container's executor after the end: the
    // settle's HEAD read would have been a `needs: attach` the recovery refuses.
    // (The baseline reading diff ran before the model, as it does on every review.)
    expect(execsAtDeath).toBeGreaterThanOrEqual(0);
    expect(execs.slice(0, execsAtDeath).every((c) => c.startsWith("git diff "))).toBe(true);
    expect(execs.slice(execsAtDeath)).toEqual([]);
    // No verdict turn asked the model, and nothing reached the pull request:
    // the budget's answer is not a verdict.
    expect(posts).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(undefined);
    await s.writer.settled();
    const events = recorded().events as Array<{ type: string; kind?: string; summary?: string }>;
    expect(
      events.filter((e) => e.type === "run_note" && e.kind === "time_budget_exhausted").map((e) => e.summary),
    ).toEqual([
      "the container was replaced under the run: the run has 30s of wall clock left, inside the 60s write-up reserve, so no attach was opened; no write-up ran",
    ]);
    expect(events.some((e) => e.type === "review_posted")).toBe(false);
    // No post outcome either way: the step never ran, so the record carries
    // neither a `review_posted` nor a `review_not_posted` verdict on a review
    // that gave none.
    expect(events.some((e) => e.type === "run_note" && e.kind === "review_not_posted")).toBe(false);
    expect(recorded().reviewPost).toBeUndefined();
  });
});

describe("the harness word through the scopes — user beats channel beats the deployment's block", () => {
  const scoped = (block: string) => YAML + block;
  const roster2 = () => {
    const pi = watched(piHarness, { answer: "from pi" });
    const oc = watched(openCodeHarness, { answer: "from opencode" });
    return {
      pi,
      oc,
      harness: {
        harnesses: roster(pi.harness, oc.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
    };
  };
  const cases: Array<{ name: string; yaml: string; opens: "pi" | "opencode" }> = [
    { name: "the deployment's block alone", yaml: scoped("harness:\n  general: opencode\n"), opens: "opencode" },
    {
      name: "the channel's word beats the deployment's",
      yaml: scoped('harness:\n  general: opencode\nchannels:\n  "slack:CX":\n    harness:\n      general: pi\n'),
      opens: "pi",
    },
    {
      name: "the user's word beats the channel's",
      yaml: scoped(
        'channels:\n  "slack:CX":\n    harness:\n      general: pi\nusers:\n  "slack:UX":\n    harness:\n      general: opencode\n',
      ),
      opens: "opencode",
    },
    {
      name: "a user's word for another preset falls through to the channel's",
      yaml: scoped(
        'channels:\n  "slack:CX":\n    harness:\n      general: opencode\nusers:\n  "slack:UX":\n    harness:\n      coding: pi\n',
      ),
      opens: "opencode",
    },
    { name: "no word at any layer", yaml: YAML, opens: "pi" },
  ];

  it.each(cases)("$name → a general run opens on $opens", async ({ yaml, opens }) => {
    const { pi, oc, harness } = roster2();
    const s = setup("unused", { agent: "general", yaml, harness });
    const out = answered(await runLoop(s.deps, s.ctx));
    const picked = opens === "pi" ? pi : oc;
    const other = opens === "pi" ? oc : pi;
    expect(out.answer).toBe(`from ${opens}`);
    expect(picked.calls.open).toEqual([undefined]);
    expect(other.calls.open).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("two people in one process: the requester whose own scope says opencode opens on OpenCode, another person's run of the same preset opens on pi, off one roster", async () => {
    const { pi, oc, harness } = roster2();
    const yaml = scoped('users:\n  "slack:UX":\n    harness:\n      general: opencode\n');
    const mine = setup("unused", { agent: "general", yaml, harness });
    expect(answered(await runLoop(mine.deps, mine.ctx)).answer).toBe("from opencode");
    const theirs = setup("unused", { agent: "general", yaml, harness, userId: "slack:UY" });
    expect(answered(await runLoop(theirs.deps, theirs.ctx)).answer).toBe("from pi");
    expect(oc.calls.open).toEqual([undefined]);
    expect(pi.calls.open).toEqual([undefined]);
  });
});

// Feature: record 0038's first stage gate for the relaunch (harness.md item 6,
// the ceiling over harness-pi.md item 16's floor): before the run loop
// relaunches anything, the two pieces a live run could not reach are shown to
// work mid-run in the fakes — a recorded binding re-attached with no gate
// context (the same round back, nothing provisioned; a binding whose backend
// is not here refused by name), and pi started again in a replacement
// container from a session rebuilt from the run's ledger rows, the call in
// flight settled and the model continuing from it. Had this failed for a
// reason that holds live, the unit would have been withheld and the floor
// kept (the plan's execution note).
describe("the relaunch ceiling — the mid-run re-attach spike (the record's first gate)", () => {
  it("a recorded binding re-attaches mid-run with no gate context — the same round comes back on the local backend, the thread's directory made once; a resident binding with no resident configured is refused by name — and pi starts again in a replacement container from a session rebuilt from the ledger's rows, the call in flight settled with the restart note, the model continuing from the rebuilt transcript", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "swb-relaunch-"));
    const config = configStore(`${YAML}workspaceDir: ${workspaceDir}\n`);
    const provisionDeps = {
      config,
      dataDir: join(workspaceDir, "data"),
      githubCredentials: TEST_GITHUB_CREDENTIALS,
    };
    const agent = getAgent("coding");
    const profile = declaredProfile(agent);
    const repoCtx: RepoContext = { repo: "acme/api", ref: "main" };
    const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf("slack:CX"), receivedAt: NOW });
    const attachCtx = {
      threadKey: THREAD,
      agent,
      profile,
      repoCtx,
      root: trace.root,
      clock: () => NOW,
      githubDoor: { baseUrl: "https://git.bot.test", bearer: "sbr_run-l.s3cret" },
    };

    // The re-attach, mid-run, with nothing of the dispatch-time gate: the
    // recorded local backend answers the thread's own directory, made once.
    const dir = localWorkspaceDir(workspaceDir, THREAD);
    const first = await reattachWorkspace(provisionDeps, { ...attachCtx, reattach: { backend: "local" } });
    if (first.kind !== "attached") throw new Error(first.kind === "reattach_refused" ? first.why : first.kind);
    expect(first.round.selection.backend).toBe("local");
    expect(existsSync(dir)).toBe(true);
    expect((await first.round.selection.executor.exec("pwd")).trim().endsWith("slack_CX_1.0")).toBe(true);
    const again = await reattachWorkspace(provisionDeps, { ...attachCtx, reattach: { backend: "local" } });
    if (again.kind !== "attached") throw new Error(again.kind === "reattach_refused" ? again.why : again.kind);
    expect((await again.round.selection.executor.exec("pwd")).trim()).toBe(
      (await first.round.selection.executor.exec("pwd")).trim(),
    );
    await again.round.release({ hardStopped: false });
    // A binding whose backend is not in this process is refused by name, nothing provisioned in its place.
    expect(
      await reattachWorkspace(provisionDeps, {
        ...attachCtx,
        reattach: { backend: "resident", workspace: "/workspace/threads/t/main", user: "worker2" },
      }),
    ).toEqual({ kind: "reattach_refused", why: "no resident backend is configured in this process" });

    // The run's record on the ledger, as the harness's mirror writes it.
    const inner = new InMemoryRunLedger(() => NOW);
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "gen-T",
      fallback: { put: async () => {}, abandoned: () => {} },
      warn: () => {},
    });
    const seed: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "fix the failing test" }] }];
    const openedLedger = await ledger.open({
      runId: "run-l",
      threadKey: THREAD,
      startedAt: NOW,
      meta: {
        channelId: "slack:CX",
        userId: "slack:UX",
        threadKey: THREAD,
        agent: "coding",
        model: "anthropic/m",
        repo: "acme/api",
        ref: "main",
      },
      card: null,
      system: "the system prompt",
      tools: [],
      seed: { messages: seed, budgetMs: 45 * 60_000 },
    });
    if (openedLedger.kind !== "tracked") throw new Error("open answered untracked");
    const ledgerRun = openedLedger.run;
    expect(ledgerRun).toBeDefined();
    const registry = new HarnessRegistry();
    const bearers = new RunBearerStore({ clock: () => NOW });
    const grant = {
      runId: "run-l",
      modelRef: "anthropic/m",
      providerName: "anthropic",
      providerWire: "anthropic-messages" as const,
      model: "m",
      maxTokens: 4096,
      maxTurns: 50,
      expiresAt: NOW + 60 * 60_000,
      span: trace.root,
      publish: () => {},
    };
    const bearer = bearers.mint(grant);
    const facts: HarnessFacts[] = [];
    const events: import("../runEvents.js").RunEvent[] = [];
    const runOf = (messages: ChatMessage[], resume?: HarnessRun["resume"]): HarnessRun => ({
      runId: "run-l",
      agent,
      model: { id: "m", provider: "anthropic", providerType: "anthropic" },
      system: "the system prompt",
      messages,
      tools: [],
      toolContext: { executor: first.round.selection.executor },
      rules: { checkout: dir, protectedBranches: ["main"] },
      onEvent: (e) => void events.push(e),
      onStep: ledgerRun.step.bind(ledgerRun),
      logIndexOf: ledgerRun.logIndexOf.bind(ledgerRun),
      saveFacts: (f) => {
        facts.push(f);
        ledgerRun.setState({ harness: f });
      },
      ...(resume ? { resume } : {}),
    });
    const harnessDeps = (container: FakeHarnessContainer) => ({
      container,
      bearer,
      harnessUrl: "https://bot.example.com",
      registry,
      bearers,
      clock: () => NOW,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1))),
      pollMs: 1,
      tickMs: 5,
    });

    // Container A: pi opens one bash call, the mirror writes the step with the
    // call in flight, then the container is replaced under it — the executor's
    // typed word on the next log read.
    const a = new FakeHarnessContainer();
    a.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
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
      authorizeToolCall(registry.get("run-l")!, { toolCallId: "c1", tool: "bash", input: { command: "npm test" } });
      // The old container's pid is gone with it: the ask-2 probe on the word finds it dead.
      c.alive = async () => false;
      const read = c.readLog.bind(c);
      c.readLog = async (path, offset, max) => {
        const chunk = await read(path, offset, max);
        if (chunk.length === 0)
          throw new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
        return chunk;
      };
    };
    await expect(openThroughSeam(piHarness, harnessDeps(a), runOf(seed))).rejects.toBeInstanceOf(
      PiContainerReplacedError,
    );
    expect(a.killed).toEqual([]);
    expect(a.removed).toEqual([]);

    // The record: the ledger's rows and its last step name the call in flight,
    // exactly as a bot death's resume reads them.
    const lastStep = inner.steps.get("run-l")!.at(-1)!;
    expect(lastStep.inFlight).toEqual([{ callId: "c1", tool: "bash" }]);
    // Read as the boot reclaim reads it: from the session log the row names, else the run's own object.
    const source = transcriptSource(inner.live.get("run-l")!.meta);
    const transcript =
      source.kind === "session"
        ? await inner.readSession(source.key, source.from)
        : await inner.readTranscript("run-l");
    const plan = planResume({ transcript, lastStep, tools: [] });
    if (plan.kind !== "resume") throw new Error(plan.kind === "interrupted" ? plan.why : plan.kind);
    expect(plan.messages).toHaveLength(2);
    expect(plan.settlements.map((s) => s.toolUse.id)).toEqual(["c1"]);

    // Container B — the replacement, which names itself anew: pi starts there
    // on the rebuilt session and the model continues from it.
    const b = new FakeHarnessContainer();
    b.vm = "vm-new";
    const model = scriptPiFromProvider(b, { provider: provider("continued"), registry, bearers });
    const session = await openThroughSeam(
      piHarness,
      harnessDeps(b),
      runOf(seed, {
        messages: plan.messages,
        compactions: plan.compactions,
        settlements: plan.settlements,
        remainingMs: plan.remainingMs,
        turn: plan.turn,
        inboxConsumedSeq: plan.inboxConsumedSeq,
        // Protocol projection after the typed replacement above; not whole-capture authority.
        relaunch: { from: "vm-fake", to: "vm-new" },
        facts: facts.at(-1)!,
      }),
    );
    expect(session.answer).toBe("continued");
    await session.end();
    expect(b.starts).toHaveLength(1);
    expect(b.killed).toEqual([4242]); // the relaunched pi's own end
    const sessionPath = b.starts[0]!.args[b.starts[0]!.args.indexOf("--session") + 1]!;
    const entries = b.files
      .get(sessionPath)!
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(entries.slice(1).map((e) => (e.message as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const req = model.requests[0]!.messages;
    expect(req[0]).toEqual(seed[0]);
    expect(req[1]!.role).toBe("assistant");
    expect(req[1]!.content).toEqual([{ type: "tool_use", id: "c1", name: "bash", input: { command: "npm test" } }]);
    const parts = req.slice(2).flatMap((m) => m.content);
    expect(parts[0]).toMatchObject({ type: "tool_result", toolUseId: "c1", isError: true });
    expect(parts.at(-1)).toMatchObject({ type: "text", text: expect.stringMatching(/^Continue where you left off/) });
    const notes = events.filter((e) => e.type === "run_note").map((e) => e as { kind: string; summary: string });
    expect(notes.map((n) => n.kind)).toEqual(["sandbox_restarted", "resumed"]);
    expect(notes[1]!.summary).toMatch(/relaunched after the container was replaced \(vm-fake → vm-new\)/);
    // The record clause across two deaths (harness.md item 6): the ledger's
    // transcript after the rebuild holds the settlement turn pi's session
    // started on — a result for every call — so the next reclaim rebuilds a
    // transcript the model accepts, and the ledger's rows are what the model saw.
    if (source.kind !== "session") throw new Error("the row names no session log");
    const after = await inner.readSession(source.key, source.from);
    const rebuilt = planResume({ transcript: after, lastStep: inner.steps.get("run-l")!.at(-1)!, tools: [] });
    if (rebuilt.kind === "interrupted") throw new Error(rebuilt.why);
    const settlement = plan.settlements[0]!;
    expect(rebuilt.messages).toHaveLength(4);
    expect(rebuilt.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "c1",
          content: settlement.action === "synthetic" ? settlement.text : "",
          isError: true,
        },
        { type: "text", text: expect.stringMatching(/^Continue where you left off/) },
      ],
    });
    expect(rebuilt.messages[3]).toEqual({ role: "assistant", content: [{ type: "text", text: "continued" }] });
    expect(rebuilt.messages.slice(0, 3)).toEqual(req.slice(0, 3));
    await ledgerRun.close();
  });
});

// Feature: coding-checks.md — model selection precedes typed execution.
describe("runLoop adaptive coding checks", () => {
  it.each(["missing", "untracked"] as const)(
    "refuses recording before execution when the ledger is %s",
    async (ledger) => {
      const observed = watched(piHarness);
      const execResult = vi.fn(async () => ({
        stdout: `/workspace/threads/t/work\n${"a".repeat(40)}\n${"b".repeat(40)}\n`,
        stderr: "",
        exitCode: 0,
        truncated: false,
      }));
      observed.harness.open = async (_deps, request) => {
        request.onEvent?.({ type: "lease", startedAt: NOW, endsAt: NOW + 600_000, loopEndsAt: NOW + 600_000, at: NOW });
        const check = request.tools.find((tool) => tool.name === "run_check")!;
        const answer = await check.run(
          { command: "npm test", purpose: "baseline" },
          { ...request.toolContext, callId: "baseline-1" },
        );
        expect(answer).toContain("command did not start");
        expect(answer).not.toContain("persistence_failed");
        expect(execResult).not.toHaveBeenCalled();
        return {
          answer: "unrecorded fallback is available",
          followUp: async () => "",
          remainingMs: () => 60_000,
          end: async () => {},
        };
      };
      const s = setup("unused", {
        agent: "coding",
        executor: { execResult },
        repoCtx: { repo: "acme/api", ref: "work" },
        binding: {
          ref: "work",
          sha: "a".repeat(40),
          workspace: "/workspace/threads/t/work",
          user: "worker1",
          container: "vm1",
          depsKey: "deps1",
        },
        harness: {
          harnesses: roster(observed.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example",
          loopbackUrl: "http://127.0.0.1:8080",
        },
      });
      const ledgerRun = ledger === "untracked" ? recordingLedgerRun().ledgerRun : undefined;
      expect(answered(await runLoop(s.deps, { ...s.ctx, ledgerRun })).answer).toBe("unrecorded fallback is available");
    },
  );
  it.each(["pi", "opencode"] as const)(
    "binds typed checks for %s coding without a configured test command",
    async (name) => {
      const observed = watched(name === "pi" ? piHarness : openCodeHarness);
      const states: Record<string, unknown>[] = [];
      const execResult = vi.fn(async (command: string) => {
        const result = { stdout: "", stderr: "", exitCode: 0, truncated: false };
        if (command.startsWith("set -eu"))
          return { ...result, stdout: `/workspace/threads/t/work\n${"a".repeat(40)}\n${"b".repeat(40)}\n` };
        expect(states.at(-1)).toMatchObject({ checkExecutions: { receipts: [{ outcome: { kind: "pending" } }] } });
        expect(command).toContain("cd -- '/workspace/threads/t/work'");
        return { ...result, stdout: "one assertion failed", exitCode: 1 };
      });
      observed.harness.open = async (_deps, request) => {
        expect(execResult).not.toHaveBeenCalled();
        expect(request.tools.some((tool) => tool.name === "run_check")).toBe(true);
        expect(request.toolContext.checkExecution?.run).toBeTypeOf("function");
        request.onEvent?.({ type: "lease", startedAt: NOW, endsAt: NOW + 600_000, loopEndsAt: NOW + 600_000, at: NOW });
        const check = request.tools.find((tool) => tool.name === "run_check")!;
        // The relayed tool must apply the same command restrictions as bash.
        for (const command of ["env", "cat .git/github-credentials", "gh pr merge 1", "git push origin HEAD:work"])
          expect(
            await check.run({ command, purpose: "baseline" }, { ...request.toolContext, callId: command }),
          ).toContain("command_refused");
        expect(execResult).not.toHaveBeenCalled();
        const input = { command: "npm exec -- vitest run src/one.test.ts", purpose: "baseline" };
        const first = await check.run(input, { ...request.toolContext, callId: "baseline-1" });
        expect(first).toContain("completed with exit 1");
        expect(states.at(-1)).toMatchObject({
          checkExecutions: {
            receipts: [
              {
                owner: { runId: "run-l", requester: "slack:UX", repo: "acme/api" },
                outcome: { kind: "completed", exitCode: 1 },
              },
            ],
          },
        });
        expect(await check.run(input, { ...request.toolContext, callId: "baseline-1" })).toBe(first);
        expect(execResult).toHaveBeenCalledTimes(2);
        return {
          answer: "choose a scoped check",
          followUp: async () => "",
          remainingMs: () => 60_000,
          end: async () => {},
        };
      };
      const s = setup("unused", {
        agent: "coding",
        yaml: `${YAML}harness:\n  coding: ${name}\n`,
        executor: { execResult },
        repoCtx: { repo: "acme/api", ref: "work" },
        binding: {
          ref: "work",
          sha: "a".repeat(40),
          workspace: "/workspace/threads/t/work",
          user: "worker1",
          container: "vm1",
          depsKey: "deps1",
        },
        harness: {
          harnesses: name === "pi" ? roster(observed.harness) : roster(piHarness, observed.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example",
          loopbackUrl: "http://127.0.0.1:8080",
        },
      });
      const { ledgerRun } = recordingLedgerRun();
      ledgerRun.tracked = () => true;
      ledgerRun.setStateAndFlush = async (state) => {
        states.push(structuredClone(state));
        return true;
      };
      expect(answered(await runLoop(s.deps, { ...s.ctx, ledgerRun })).answer).toBe("choose a scoped check");
    },
  );
});

describe("tracked Review command receipt binding", () => {
  async function canonicalOwner(s: ReturnType<typeof setup>, adopt = false) {
    let now = NOW;
    const inner = new InMemoryRunLedger(() => now);
    const meta = {
      agent: s.ctx.agent.name,
      channelId: s.ctx.msg.channelId,
      userId: s.ctx.msg.userId,
      threadKey: s.ctx.msg.threadKey,
      repo: s.ctx.repoCtx.repo,
      readonly: s.ctx.profile.identity === "read",
      profile: s.ctx.profile,
      ...(s.ctx.coordinator
        ? {
            parentInstanceId: s.ctx.coordinator.parentInstanceId,
            idempotencyKey: s.ctx.coordinator.idempotencyKey,
            coordinatorUnit: s.ctx.coordinator.unit,
          }
        : {}),
    };
    const ledger = createLedgerWriteThrough({
      ledger: inner,
      gen: "review-current",
      fallback: s.store,
      warn: () => {},
    });
    s.deps.runLedger = ledger;
    let ledgerRun: LedgerRun;
    if (adopt) {
      await inner.claim({
        runId: s.run.id,
        threadKey: meta.threadKey,
        gen: "review-old",
        leaseMs: 1000,
        startedAt: now,
        meta,
        system: s.ctx.system,
        tools: [],
      });
      now += 2000;
      const [{ row }] = await inner.reclaim(ledger.gen, now, 1000);
      ledgerRun = ledger.adopt({
        runId: row.runId,
        threadKey: row.threadKey,
        meta: row.meta,
        startedAt: row.startedAt,
        state: row.state,
        lastStep: 0,
        lastSeq: 0,
      });
    } else {
      const opened = await ledger.open({
        runId: s.run.id,
        threadKey: meta.threadKey,
        startedAt: now,
        meta,
        card: null,
        system: s.ctx.system,
        tools: [],
      });
      if (opened.kind !== "tracked") throw new Error("canonical Review claim required");
      ledgerRun = opened.run;
    }
    return {
      ledgerRun,
      inner,
      takeover: async () => {
        now += 1_000_000;
        return inner.reclaim("review-next", now, 1000);
      },
    };
  }

  it.each(["pi", "opencode"] as const)("binds hosted %s Review through its original canonical ledger", async (name) => {
    const observed = watched(name === "pi" ? piHarness : openCodeHarness);
    const states: Record<string, unknown>[] = [];
    let canonical: Awaited<ReturnType<typeof canonicalOwner>>;
    const execResult = vi.fn(async (command: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.timeoutMs).toBeGreaterThan(0);
      if (command.startsWith("set -eu"))
        return {
          stdout: `/workspace/threads/t/work\n${"a".repeat(40)}\n${"b".repeat(40)}\n`,
          stderr: "",
          exitCode: 0,
          truncated: false,
        };
      expect(canonical.inner.live.get("run-l")!.state.checkExecutions).toMatchObject({
        receipts: [{ callId: "review-call", outcome: { kind: "pending" } }],
      });
      expect(command).toContain("cd -- '/workspace/threads/t/work'");
      return { stdout: "known failure", stderr: "", exitCode: 1, truncated: false };
    });
    observed.harness.open = async (_deps, request) => {
      expect(request.tools.some((tool) => tool.name === "run_check")).toBe(true);
      expect(request.commandPolicy).toBe("hosted-review");
      expect(request.toolContext.checkExecution?.run).toBeTypeOf("function");
      request.onEvent?.({ type: "lease", startedAt: NOW, endsAt: NOW + 600_000, loopEndsAt: NOW + 600_000, at: NOW });
      const live: LiveHarness = {
        runId: request.runId,
        tools: request.tools,
        toolContext: request.toolContext,
        commandPolicy: request.commandPolicy,
        checkControl: () => ({ signal: new AbortController().signal }),
        rules: { ...request.rules, identity: "read" },
        emit: () => {},
        toolSpan: () => undefined,
        gateSaw: () => {},
        toolsBlocked: () => undefined,
      };
      const answer = await runRelayedTool(live, {
        toolCallId: "review-call",
        tool: "run_check",
        input: { command: "git status --short", purpose: "verification" },
      });
      expect(answer.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("completed with exit 1") }),
      ]);
      const receipt = {
        kind: "recorded" as const,
        receipt: (
          canonical.inner.live.get(request.runId)!.state.checkExecutions as { receipts: CheckExecutionReceipt[] }
        ).receipts[0],
      };
      expect(receipt).toMatchObject({
        kind: "recorded",
        receipt: {
          owner: { runId: "run-l", requester: "slack:UX", threadKey: THREAD, repo: "acme/api" },
          outcome: { kind: "completed", exitCode: 1 },
        },
      });
      if (receipt.kind !== "recorded") throw new Error("expected canonical command observation");
      expect(Object.hasOwn(receipt.receipt.owner, "unit")).toBe(false);
      expect(
        states.map(
          (state) => (state.checkExecutions as { receipts: { outcome: { kind: string } }[] }).receipts[0].outcome.kind,
        ),
      ).toEqual(["pending", "completed"]);
      return {
        answer: "review capability observed",
        followUp: async () => "",
        remainingMs: () => 60000,
        end: async () => {},
      };
    };
    const s = setup("unused", {
      agent: "review",
      yaml: `${YAML}harness:\n  review: ${name}\n`,
      executor: { execResult },
      repoCtx: { repo: "acme/api", ref: "work" },
      binding: {
        ref: "work",
        sha: "a".repeat(40),
        workspace: "/workspace/threads/t/work",
        user: "worker1",
        container: "vm1",
        depsKey: "deps1",
      },
      harness: {
        harnesses: name === "pi" ? roster(observed.harness) : roster(piHarness, observed.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example",
        loopbackUrl: "http://127.0.0.1:8080",
      },
    });
    canonical = await canonicalOwner(s, name === "opencode");
    const setState = canonical.inner.setState.bind(canonical.inner);
    vi.spyOn(canonical.inner, "setState").mockImplementation(async (...args) => {
      const result = await setState(...args);
      if (result.ok && args[2].checkExecutions) states.push(structuredClone(args[2]));
      return result;
    });
    try {
      expect(answered(await runLoop(s.deps, { ...s.ctx, ledgerRun: canonical.ledgerRun })).answer).toBe(
        "review capability observed",
      );
      expect(execResult).toHaveBeenCalledTimes(2);
      expect(canonical.inner.live.get(s.run.id)!.ownerGen).toBe("review-current");
    } finally {
      await canonical.ledgerRun.close();
    }
  });

  it.each(["intent", "result"] as const)(
    "holds %s credit after actual write-through generation takeover",
    async (phase) => {
      const observed = watched(piHarness);
      let canonical: Awaited<ReturnType<typeof canonicalOwner>>;
      const execResult = vi.fn(async (command: string) => {
        if (command.startsWith("set -eu")) {
          if (phase === "intent") await canonical.takeover();
          return {
            stdout: `/workspace/threads/t/work\n${"a".repeat(40)}\n${"b".repeat(40)}\n`,
            stderr: "",
            exitCode: 0,
            truncated: false,
          };
        }
        await canonical.takeover();
        return { stdout: "", stderr: "", exitCode: 0, truncated: false };
      });
      observed.harness.open = async (_deps, request) => {
        request.onEvent?.({ type: "lease", startedAt: NOW, endsAt: NOW + 600_000, loopEndsAt: NOW + 600_000, at: NOW });
        const result = await request.toolContext.checkExecution!.run(
          { command: "git status --short", purpose: "verification" },
          "fenced-review",
        );
        expect(result).toEqual({ kind: "unavailable", reason: "persistence_failed" });
        const state = canonical.inner.live.get(request.runId)!.state.checkExecutions;
        if (phase === "result")
          expect(state).toMatchObject({ receipts: [{ callId: "fenced-review", outcome: { kind: "pending" } }] });
        else expect(state).toBeUndefined();
        return { answer: "generation held", followUp: async () => "", remainingMs: () => 60000, end: async () => {} };
      };
      const s = setup("unused", {
        agent: "review",
        executor: { execResult },
        repoCtx: { repo: "acme/api", ref: "work" },
        binding: {
          ref: "work",
          sha: "a".repeat(40),
          workspace: "/workspace/threads/t/work",
          user: "worker1",
          container: "vm1",
          depsKey: "deps1",
        },
        harness: {
          harnesses: roster(observed.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example",
        },
      });
      canonical = await canonicalOwner(s);
      try {
        await runLoop(s.deps, { ...s.ctx, ledgerRun: canonical.ledgerRun });
        expect(execResult).toHaveBeenCalledTimes(phase === "intent" ? 1 : 2);
        expect(canonical.inner.live.get(s.run.id)!.ownerGen).toBe("review-next");
      } finally {
        await canonical.ledgerRun.close();
      }
    },
  );

  it("preserves actual coordinator unit coding owner and its original command path", async () => {
    const observed = watched(piHarness);
    const key = "coding-plan:ONE/0/coding";
    const execResult = vi.fn(async (command: string) => ({
      stdout: command.startsWith("set -eu") ? `/workspace/threads/t/work\n${"a".repeat(40)}\n${"b".repeat(40)}\n` : "",
      stderr: "",
      exitCode: 0,
      truncated: false,
    }));
    observed.harness.open = async (_deps, request) => {
      expect(request.commandPolicy).toBeUndefined();
      request.onEvent?.({ type: "lease", startedAt: NOW, endsAt: NOW + 600_000, loopEndsAt: NOW + 600_000, at: NOW });
      expect(
        await request.toolContext.checkExecution!.run(
          { command: "git status --short", purpose: "verification" },
          "unit-coding",
        ),
      ).toMatchObject({
        kind: "recorded",
        receipt: { owner: { unit: key }, outcome: { kind: "completed", exitCode: 0 } },
      });
      return { answer: "unit retained", followUp: async () => "", remainingMs: () => 60000, end: async () => {} };
    };
    const s = setup("unused", {
      agent: "coding",
      executor: { execResult },
      repoCtx: { repo: "acme/api", ref: "work" },
      coordinator: { parentInstanceId: "coding-plan", idempotencyKey: key, unit: "ONE" },
      binding: {
        ref: "work",
        sha: "a".repeat(40),
        workspace: "/workspace/threads/t/work",
        user: "worker1",
        container: "vm1",
        depsKey: "deps1",
      },
      harness: {
        harnesses: roster(observed.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example",
      },
    });
    const canonical = await canonicalOwner(s);
    try {
      await runLoop(s.deps, { ...s.ctx, ledgerRun: canonical.ledgerRun });
      expect(execResult).toHaveBeenCalledTimes(2);
    } finally {
      await canonical.ledgerRun.close();
    }
  });

  it.each(["typed executor", "canonical actor", "canonical generation", "canonical unit"] as const)(
    "does not expose a command for unready %s evidence",
    async (missing) => {
      const observed = watched(piHarness);
      const execResult = vi.fn();
      observed.harness.open = async (_deps, request) => {
        expect(request.toolContext.checkExecution).toBeUndefined();
        expect(request.tools.some((tool) => tool.name === "run_check")).toBe(false);
        return { answer: "capability held", followUp: async () => "", remainingMs: () => 60000, end: async () => {} };
      };
      const s = setup("unused", {
        agent: "review",
        executor: missing === "typed executor" ? {} : { execResult },
        repoCtx: { repo: "acme/api", ref: "work" },
        binding: {
          ref: "work",
          sha: "a".repeat(40),
          workspace: "/workspace/threads/t/work",
          user: "worker1",
          container: "vm1",
          depsKey: "deps1",
        },
        harness: {
          harnesses: roster(observed.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example",
        },
      });
      const canonical = await canonicalOwner(s);
      if (missing === "canonical actor") canonical.inner.live.get(s.run.id)!.meta.userId = "slack:UOTHER";
      if (missing === "canonical unit")
        Object.assign(canonical.inner.live.get(s.run.id)!.meta, {
          parentInstanceId: "review-plan",
          idempotencyKey: "review-plan:ONE/0/review",
          coordinatorUnit: "ONE",
        });
      if (missing === "canonical generation") await canonical.takeover();
      try {
        await runLoop(s.deps, { ...s.ctx, ledgerRun: canonical.ledgerRun });
        expect(execResult).not.toHaveBeenCalled();
      } finally {
        await canonical.ledgerRun.close();
      }
    },
  );

  it.each(["repository", "checkout", "absolute checkout"] as const)(
    "does not bind tracked Review without a real %s",
    async (missing) => {
      const observed = watched(piHarness);
      const execResult = vi.fn();
      observed.harness.open = async (_deps, request) => {
        expect(request.toolContext.checkExecution).toBeUndefined();
        return { answer: "binding held", followUp: async () => "", remainingMs: () => 60000, end: async () => {} };
      };
      const s = setup("unused", {
        agent: "review",
        executor: { execResult },
        repoCtx: missing === "repository" ? {} : { repo: "acme/api", ref: "work" },
        ...(missing !== "checkout"
          ? {
              binding: {
                ref: "work",
                sha: "a".repeat(40),
                workspace: missing === "absolute checkout" ? "relative/work" : "/workspace/threads/t/work",
                user: "worker1",
                container: "vm1",
                depsKey: "deps1",
              },
            }
          : {}),
        harness: {
          harnesses: roster(observed.harness),
          registry: new HarnessRegistry(),
          harnessUrl: "https://bot.example",
        },
      });
      const { ledgerRun } = recordingLedgerRun();
      ledgerRun.tracked = () => true;
      expect(answered(await runLoop(s.deps, { ...s.ctx, ledgerRun })).answer).toBe("binding held");
      expect(execResult).not.toHaveBeenCalled();
    },
  );

  it("does not bind command recording to an untracked Review", async () => {
    const observed = watched(piHarness);
    observed.harness.open = async (_deps, request) => {
      expect(request.toolContext.checkExecution).toBeUndefined();
      return { answer: "untracked held", followUp: async () => "", remainingMs: () => 60000, end: async () => {} };
    };
    const s = setup("unused", {
      agent: "review",
      repoCtx: { repo: "acme/api", ref: "work" },
      harness: {
        harnesses: roster(observed.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example",
      },
    });
    expect(answered(await runLoop(s.deps, s.ctx)).answer).toBe("untracked held");
  });
});

describe("runLoop first coding test", () => {
  const ready = {
    testCommand: "npm exec -- vitest run src/one.test.ts",
    dependencyDir: "node_modules",
    requiredTools: ["node", "npm"],
    firstAction: { kind: "baseline_test" as const, policyVersion: "v1", timeoutMs: 30_000 },
  };
  const raw = { stdout: "", stderr: "", exitCode: 0, truncated: false };
  function baseline(result: typeof raw | Error = raw) {
    const order: string[] = [];
    let saved: unknown;
    const observed = watched(piHarness);
    observed.harness.open = async (_deps, request) => {
      order.push("model");
      expect(saved).toMatchObject({ outcome: { kind: "completed" } });
      expect(request.system).toContain("first baseline command");
      request.onEvent?.({ type: "tool_call", tool: "bash", summary: "model tool", callId: "m1" });
      order.push("tool");
      return { answer: "done", followUp: async () => "", remainingMs: () => 60_000, end: async () => {} };
    };
    const execResult = vi.fn(async (command: string) => {
      if (command === "cat /proc/sys/kernel/random/boot_id 2>/dev/null || true") {
        order.push("identity");
        return { ...raw, stdout: "vm1" };
      }
      if (command.startsWith("set -eu")) {
        order.push("preflight");
        return { ...raw, stdout: "workspace-hash" };
      }
      order.push("test");
      expect(saved).toMatchObject({ outcome: { kind: "unknown", code: "execution_pending" } });
      if (result instanceof Error) throw result;
      return result;
    });
    const s = setup("unused", {
      agent: "coding",
      repoCtx: { repo: "acme/api", ref: "work" },
      executor: { execResult },
      binding: {
        ref: "work",
        sha: "a".repeat(40),
        workspace: "/workspace/threads/t/work",
        user: "worker1",
        container: "vm1",
        depsKey: "deps1",
      },
      harness: {
        harnesses: roster(observed.harness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example",
        loopbackUrl: "http://127.0.0.1:8080",
      },
    });
    const { ledgerRun } = recordingLedgerRun();
    ledgerRun.tracked = () => true;
    ledgerRun.setStateAndFlush = async (state) => {
      if (state.firstTest) {
        saved = structuredClone(state.firstTest);
        order.push(`persist:${(saved as { outcome: { kind: string } }).outcome.kind}`);
      }
      return true;
    };
    ledgerRun.pauseForRetry = vi.fn(async () => true);
    const ctx: RunLoopContext = {
      ...s.ctx,
      ledgerRun,
      readyRequirementOverride: ready,
      admissionRemainingMs: () => 60_000,
      round: { ...s.ctx.round, selection: { ...s.ctx.round.selection, backend: "resident" } },
    };
    return { ...s, ctx, order, observed, execResult, saved: () => saved, ledgerRun };
  }
  it.each([0, 1])("persists exit %s before the first provider or model tool event", async (exitCode) => {
    const s = baseline({ ...raw, exitCode });
    expect(answered(await runLoop(s.deps, s.ctx)).answer).toBe("done");
    expect(s.order.slice(0, 6)).toEqual(["preflight", "persist:unknown", "test", "persist:completed", "model", "tool"]);
  });
  it.each([new Error("transport lost"), { ...raw, exitCode: 124 }])(
    "holds unknown completion on the same run without a model or workspace release",
    async (result) => {
      const s = baseline(result);
      const out = await runLoop(s.deps, s.ctx);
      expect(out).toMatchObject({ kind: "paused", reason: "first_test_required", handedOff: true });
      expect(s.order).not.toContain("model");
      expect(s.releases).toEqual([]);
      expect(s.ledgerRun.pauseForRetry).toHaveBeenCalledOnce();
      expect(s.saved()).toMatchObject({ outcome: { kind: "unknown" } });
    },
  );
  it("a freshly restored sandbox seed reads current typed identity before its baseline and model", async () => {
    const s = baseline();
    s.ctx.round.selection = {
      ...s.ctx.round.selection,
      backend: "sandbox",
      binding: undefined,
      seeded: {
        slug: "acme/api",
        ref: "work",
        sha: "a".repeat(40),
        depsBackupId: "archive-a",
        workspace: "/workspace/checkout",
        cached: false,
        ms: 0,
      },
    };
    expect(answered(await runLoop(s.deps, s.ctx)).answer).toBe("done");
    expect(s.order.slice(0, 7)).toEqual([
      "identity",
      "preflight",
      "persist:unknown",
      "test",
      "persist:completed",
      "model",
      "tool",
    ]);
    expect(s.saved()).toMatchObject({
      checkout: { container: "vm1", backend: "sandbox" },
      outcome: { kind: "completed" },
    });
  });
  it("holds a cached initial seed before any baseline or model work", async () => {
    const s = baseline();
    s.ctx.round.selection = {
      ...s.ctx.round.selection,
      backend: "sandbox",
      binding: undefined,
      seeded: {
        slug: "acme/api",
        ref: "work",
        sha: "a".repeat(40),
        depsBackupId: "archive-a",
        workspace: "/workspace/checkout",
        cached: true,
        ms: 0,
      },
    };
    expect(await runLoop(s.deps, s.ctx)).toMatchObject({ kind: "paused", reason: "first_test_required" });
    expect(s.order).not.toContain("model");
    expect(s.execResult).not.toHaveBeenCalled();
    expect(s.saved()).toMatchObject({ outcome: { kind: "refused", code: "seed_identity_unverifiable" } });
  });
  it("does not opt an absent first-action policy into a test", async () => {
    const s = baseline();
    s.observed.harness.open = async () => ({
      answer: "ordinary",
      followUp: async () => "",
      remainingMs: () => 60_000,
      end: async () => {},
    });
    const { firstAction: _unused, ...readinessOnly } = ready;
    expect(answered(await runLoop(s.deps, { ...s.ctx, readyRequirementOverride: readinessOnly })).answer).toBe(
      "ordinary",
    );
    expect(s.execResult).not.toHaveBeenCalled();
    expect(s.saved()).toBeUndefined();
  });
});
