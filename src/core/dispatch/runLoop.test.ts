import { buildReviewPostBody, parseVerdictInput } from "../reviewVerdict.js";
import type { Verbosity } from "../verbosity.js";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ASKS } from "../budgets.js";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { TEST_GITHUB_CREDENTIALS } from "../../execution/testing/githubCredentials.js";
import { renderProviderFailure, type Provider } from "../provider.js";
import { ExecSandboxRestartedError, type Executor } from "../../execution/executor.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import { createLedgerWriteThrough, NullLedgerRun, NullLedgerWriteThrough } from "../runLedger/writeThrough.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { planResume, transcriptSource } from "../runLedger/resume.js";
import { localWorkspaceDir } from "../../execution/factory.js";
import { reattachWorkspace } from "./provision.js";
import { bearerHashOf, RunBearerStore } from "../modelProxy/runBearers.js";
import { RUN_BEARER_ENV } from "../harness/pi/process.js";
import {
  HarnessContainerReplacedError,
  HarnessGateBypassedError,
  HarnessMismatchError,
  openThroughSeam,
  type Finding,
  type Harness,
  type HarnessFacts,
  type HarnessRecord,
  type HarnessRun,
  type HarnessSession,
} from "../harness/contract.js";
import type { HarnessRoster } from "../harness/roster.js";
import { InMemoryRunStore, NullRunStore } from "../runStore.js";
import { createCardShell } from "../statusCardFrame.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO, IncomingMessage, StatusUpdate } from "../types.js";
import type { DispatchFollowUp } from "./admission.js";
import { buildMessages } from "./messages.js";
import { resolveRun } from "./resolve.js";
import type { HarnessProcessDeps, RunDeps } from "./run.js";
import { latestRunnerPublication, runLoop, type RunLoopOutcome, type RunOutcome } from "./runLoop.js";

/** The loop's answered outcome; an interruption fails the test naming its note. */
function answered(out: RunLoopOutcome): RunOutcome {
  if (out.kind !== "answered") throw new Error(`the loop was interrupted: ${out.note}`);
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
  ModelTransientFailureError,
  PiContainerReplacedError,
} from "../harness/pi/harness.js";
import { PiHarness } from "../harness/pi/piHarness.js";
import { OpenCodeHarness } from "../harness/opencode/harness.js";
import { HarnessInterruptedError } from "../harness/contract.js";
import { scriptOpenCodeServe } from "../harness/opencode/testing/driver.js";
import { openCodeReplacedCallNote } from "../harness/opencode/session.js";
import { FakeHarnessContainer } from "../harness/testing/fakeContainer.js";
import { scriptPiFromProvider } from "../harness/pi/testing/providerPi.js";
import { judgeToolCall, type ToolRuleContext } from "../harness/pi/toolRules.js";
import type { CoordinatorTag } from "../coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
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

// Feature: docs/reference/specs/harness-pi.md, docs/reference/specs/run-history.md
// items 20–22, docs/reference/specs/llm-output.md item 5 — the loop's own
// contract on the two ways it ends: a completed run whose answer is published
// and whose record is registered for the drain, and a failed run whose card is
// closed and whose workspace is released before the error propagates. The
// settle, the description turn and the PR post-step are proven through
// `dispatch()` in `src/core/dispatcher.test.ts` (`review post-step`, `coding
// PR post-step`).

const NOW = 10_000;
const THREAD = "slack:CX:1.0";

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

const msg = (text: string, userId = "slack:UX"): IncomingMessage => ({
  channelId: "slack:CX",
  userId,
  threadKey: THREAD,
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
    io?: Partial<ChannelIO>;
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
    /** The artifact store (record 0033), when the deployment configures one. */
    artifacts?: ArtifactStore;
    /** A pull-request review round: the head the dispatcher pinned and the seams the settle and the post-step call.
     *  `currentHead` is what GitHub answers for the PR's head during the run (the pinned head unless a test moves
     *  it); `commits` answers the compare lists the settle classifies a move by (unclassifiable unless given). */
    review?: {
      head: string;
      post: (target: ReviewCommentTarget, body: string) => Promise<void>;
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
    /** The registry's per-run backlog bound in events, when a test needs the run's early events evicted. */
    backlogLimit?: number;
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
          fetchPrCommits: async ({ sha }: { sha: string }) => opts.review!.commits?.(sha),
        }
      : {}),
  };
  const message = msg("hello there", opts.userId);
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
  });
  const run = registry.create(`${agentName} · #CX · UX`, {
    agent: agentName,
    model: resolved.modelRef,
    channelId: "slack:CX",
    userId: message.userId,
    threadKey: THREAD,
    receivedAt: NOW,
  });
  const trace = startRequestRoot({ clock: () => NOW }, { channel: channelOf(message.channelId), receivedAt: NOW });
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
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
    admitted: new ThreadAdmission<DispatchFollowUp>().claim(THREAD, { agent: agentName }).live,
    ledgerRun: undefined,
    resume: undefined,
    repoCtx: opts.repoCtx ?? {},
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
    channelVisibility: "unknown" as const,
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
  const WIP_COORDINATOR: CoordinatorTag = {
    parentInstanceId: "instance",
    idempotencyKey: "key",
    base: "main",
  };
  it("restores the newest runner publication matching the published branch and current head", () => {
    const receipt = (effectId: string, branch: string, after: string, occurredAt: number) => ({
      effectId,
      kind: "push" as const,
      outcome: "succeeded" as const,
      actor: "slack:UX",
      repository: "acme/api",
      resource: `acme/api#refs/heads/${branch}`,
      destination: `refs/heads/${branch}`,
      after,
      tree: after,
      endpoint: "https://github.com/acme/api.git",
      gates: [],
      by: "runner" as const,
      occurredAt,
    });
    const old = receipt("old", "feat/x", "a".repeat(40), 10);
    const wrongBranch = receipt("other", "feat/y", "b".repeat(40), 40);
    const current = receipt("current", "feat/x", "b".repeat(40), 30);
    const sameTimeNewer = receipt("same-time-newer", "feat/x", "b".repeat(40), 30);
    const staleLater = receipt("stale", "feat/x", "a".repeat(40), 50);
    expect(
      latestRunnerPublication({ old, wrongBranch, current, sameTimeNewer, staleLater }, "feat/x", "b".repeat(40)),
    ).toEqual(sameTimeNewer);
  });

  it("configuration refuses effects on when no durable run ledger can back the tool", () => {
    expect(() => configStore(`${YAML}\nharness:\n  effects: on\n`)).toThrow(
      /harness\.effects: on requires a Worker-backed run ledger; runHistory is missing/,
    );
  });

  it("does not resolve a push until the effect envelope's durable state write is acknowledged", async () => {
    const commands: string[] = [];
    const executor: Partial<Executor> = { exec: async (command) => (commands.push(command), "") };
    let durableWrites = 0;
    const ledgerRun = new NullLedgerRun("run-l", { put: async () => {}, abandoned: () => {} });
    ledgerRun.setStateDurable = async () => {
      durableWrites++;
      return false;
    };
    const effectHarness: Harness = {
      name: piHarness.name,
      history: piHarness.history,
      dispositions: piHarness.dispositions,
      effort: (tier) => piHarness.effort(tier),
      builtinTools: (identity) => piHarness.builtinTools(identity),
      open: async (_deps, harnessRun) => {
        let answer = "effect unexpectedly ran";
        try {
          await harnessRun.toolContext.effects!.execute({
            effectId: "push-1",
            command: {
              kind: "push",
              repository: "acme/api",
              branch: "feat/x",
              expectedHead: "a".repeat(40),
              base: "main",
              gateSet: "changed-set",
            },
          });
        } catch (err) {
          answer = err instanceof Error ? err.message : String(err);
        }
        return { answer, followUp: async () => "", remainingMs: () => 60_000, end: async () => {} };
      },
      find: async () => "alive-here",
      end: async () => {},
    };
    const s = setup("", {
      agent: "coding",
      coding: true,
      executor,
      harness: {
        ...({} as HarnessProcessDeps),
        harnesses: roster(effectHarness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
      yaml: `${YAML}\nrunHistory:\n  store: worker\n  worker:\n    baseUrl: https://state.example\nharness:\n  effects: on\n`,
      repoCtx: { repo: "acme/api", ref: "feat/x", baseRef: "main" },
      binding: {
        ref: "feat/x",
        sha: "a".repeat(40),
        verification: [{ name: "test", command: "pytest -q" }],
      },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, ledgerRun }));
    expect(out.answer).toContain("not durably persisted");
    expect(durableWrites).toBe(1);
    expect(commands).not.toContain("git remote get-url --push origin");
    expect(commands.some((command) => command.startsWith("git fetch ") || command.startsWith("git push "))).toBe(false);
    expect(commands).not.toContain("pytest -q");
  });

  it("binds shadow effects without a run ledger and records the complete decision", async () => {
    const A = "a".repeat(40);
    const C = "c".repeat(40);
    const TREE = "1".repeat(40);
    let head = A;
    const executor: Partial<Executor> = {
      exec: async (command) => {
        if (command === "git remote get-url --push origin") return "https://github.com/acme/api.git\n";
        if (command === "git symbolic-ref --quiet --short HEAD") return "feat/x\n";
        if (command === "git rev-parse HEAD") return `${head}\n`;
        if (command === "git rev-parse 'HEAD^{tree}'") return `${TREE}\n`;
        if (command.startsWith("status=$(git status --porcelain")) return "__SWITCHBOARD_CLEAN__\n";
        if (command.startsWith("git ls-remote")) return `${A}\trefs/heads/feat/x\n`;
        if (command === "git fetch origin 'main'") return "(no output)";
        if (command === "git rebase 'origin/main'") {
          head = C;
          return "Successfully rebased\n";
        }
        if (command === "pytest -q") return "passed\n";
        return "(no output)";
      },
    };
    const effectHarness: Harness = {
      name: piHarness.name,
      history: piHarness.history,
      dispositions: piHarness.dispositions,
      effort: (tier) => piHarness.effort(tier),
      builtinTools: (identity) => piHarness.builtinTools(identity),
      open: async (_deps, harnessRun) => {
        const result = await harnessRun.toolContext.effects!.execute({
          effectId: "push-shadow",
          command: {
            kind: "push",
            repository: "acme/api",
            branch: "feat/x",
            expectedHead: A,
            base: "main",
            gateSet: "changed-set",
          },
        });
        return {
          answer: JSON.stringify(result),
          followUp: async () => "",
          remainingMs: () => 60_000,
          end: async () => {},
        };
      },
      find: async () => "alive-here",
      end: async () => {},
    };
    const s = setup("", {
      agent: "coding",
      coding: true,
      userId: "slack:UADMIN",
      executor,
      harness: {
        ...({} as HarnessProcessDeps),
        harnesses: roster(effectHarness),
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => new FakeHarnessContainer(),
      },
      repoCtx: { repo: "acme/api", ref: "feat/x", baseRef: "main" },
      binding: { ref: "feat/x", sha: A, verification: [{ name: "test", command: "pytest -q" }] },
    });

    const out = answered(await runLoop(s.deps, s.ctx));
    expect(JSON.parse(out.answer)).toMatchObject({ outcome: "succeeded", after: C, shadow: true });
    const events: unknown[] = [];
    s.registry.subscribe("run-l", "tok", { onEvent: (event) => void events.push(event) });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "effect", result: expect.objectContaining({ shadow: true }) }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "run_note", kind: "effect_decision" }));
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

  it("a failed run: the error propagates, the registry is finished `failed`, the workspace is released first and the card closes with ❌; the drain writes the failed record", async () => {
    const s = setup(new Error("provider down"));
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow(renderProviderFailure("permanent"));
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
  it("a harness session whose end() throws with a call open — the end failed before it could cut or kill: the run fails on the end's error, the record is still read, under `failed`, and the workspace is torn down with the note", async () => {
    const s = endingIn(async (_deps, run) => {
      openToolCall(run);
      return sessionAnswering("done", async () => {
        throw new Error("the session's end failed: the transport would not close");
      });
    });
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the session's end failed");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["torn-down"]);
    expect(await tornDownNotes(s, undefined)).toEqual([expect.stringContaining("$ sleep 600")]);
  });

  // The loop's own failure with a live session — a re-review turn on the run's
  // session that the resident's reset cut — then a session whose end() throws
  // too: the release still runs and the loop's error is the one that propagates.
  it("the loop throws with a live session and the session's end() throws too in the catch: the workspace is still released, torn down for the open call, and the loop's own error is what propagates and what the record says", async () => {
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
        executor: { exec: async () => HEAD },
        repoCtx: { repo: "o/r", pr: 42, baseRef: "main" } as RepoContext,
        review: {
          head: HEAD,
          post: async () => {},
          currentHead: NEW,
          commits: (sha) =>
            sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"]),
        },
      },
    );
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("the re-review's steer was in flight");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["torn-down"]);
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
  it("an interrupted run whose session's end() throws stays interrupted: the status, the card and the outcome agree on the restart, and the workspace is torn down for the open call", async () => {
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
        executor: { exec: async () => HEAD },
        repoCtx: { repo: "o/r", pr: 42, baseRef: "main" } as RepoContext,
        review: {
          head: HEAD,
          post: async () => {},
          currentHead: NEW,
          commits: (sha) =>
            sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"]),
        },
      },
    );
    const out = await runLoop(s.deps, s.ctx);
    expect(out.kind).toBe("interrupted");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "interrupted" });
    expect(s.releases).toEqual(["torn-down"]);
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
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow(renderProviderFailure("permanent"));
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.status).toBe("failed");
    expect(rec.events.filter((e) => e.type === "run_note" && e.kind === "run_failed")).toEqual([
      expect.objectContaining({ summary: expect.stringContaining(renderProviderFailure("permanent")) }),
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
    await expect(runLoop(down.deps, down.ctx)).rejects.toThrow(renderProviderFailure("permanent"));
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
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("retry budget ended");
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!).toMatchObject({ status: "failed", failure: { kind: "provider_transient" } });
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
    expect(commands).toContain("git add -A");
    expect(commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
    expect(s.releases).toEqual(["paired"]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
    expect(rec.events).toContainEqual(
      expect.objectContaining({ type: "pushed_head", ref: BRANCH, sha: HEAD, by: "salvage" }),
    );
    expect(rec.events).not.toContainEqual(expect.objectContaining({ type: "run_note", kind: "work_left_behind" }));
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
    const commands: string[] = [];
    const finalTurn = watched(piHarness);
    finalTurn.harness.open = async () => ({
      answer: "the contract handoff is complete",
      followUp: async (turn) => {
        expect(turn.tools).toContain("bash");
        dirty = true;
        turn.toolContext.onPrDescription?.(DESCRIPTION);
        return "description submitted";
      },
      remainingMs: () => 20 * 60_000,
      end: async () => {},
    });
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
          if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
          if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
          if (/rev-parse @\{u\}/.test(cmd)) return `${HEAD}\n`;
          if (/ls-remote --exit-code origin/.test(cmd)) return `${HEAD}\trefs/heads/${BRANCH}\n`;
          if (/status --porcelain/.test(cmd)) return dirty ? " M src/work.ts\n" : "";
          if (/rev-list --count/.test(cmd)) return unpushed ? "1\n" : "0\n";
          if (/git commit -m/.test(cmd)) {
            dirty = false;
            unpushed = true;
            return "";
          }
          if (/git push origin/.test(cmd)) {
            unpushed = false;
            return "";
          }
          return "";
        },
      },
    });
    s.deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/o/r/pull/700" }));

    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("the contract handoff is complete");
    expect(commands).toContain("git add -A");
    expect(commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
    expect(out.prNote).toBeUndefined();
    expect(JSON.stringify(s.closes)).not.toContain("discarded at the run's end");
    await out.releaseWorkspace();
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
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
    expect(out.answer).toBe("the contract handoff is complete");
    expect(commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
    expect(commands.some((cmd) => cmd.startsWith("git commit --allow-empty"))).toBe(false);
    expect(JSON.stringify(s.closes)).not.toContain("discarded at the run's end");
    await out.releaseWorkspace();
    s.ending.drain(undefined);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.pushed).toEqual([{ ref: BRANCH, sha: HEAD, by: "salvage" }]);
    expect(rec.events).not.toContainEqual(expect.objectContaining({ type: "run_note", kind: "work_left_behind" }));
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
    expect(commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
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
    expect(commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
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
      const out = answered(await runLoop(s.deps, { ...s.ctx, clock: () => clock.now }));
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
    expect(pushed.commands).toContain("git add -A");
    expect(pushed.commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
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
    expect(lost.commands.some((c) => c.startsWith("git push") || c.startsWith("git commit"))).toBe(false);
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
            if (/^git commit /.test(cmd)) dirty = false;
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
    // The run continued past the failed compaction and answered.
    expect(tracked.out.answer).toBe("done");
    expect(tracked.commands).toContain("git add -A");
    expect(tracked.commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
    expect(tracked.notes.map((n) => n.summary)).toEqual([
      `the compaction failed (${REFUSAL}); the failed compaction left work in the tree — committed the uncommitted work and pushed to \`${BRANCH}\` (${HEAD.slice(0, 7)})`,
    ]);
    expect(tracked.pushed).toEqual([expect.objectContaining({ ref: BRANCH, sha: HEAD, by: "salvage" })]);
    // Nothing to commit: the note alone, no push and no pushed_head.
    const clean = await compacted({ dirty: false });
    expect(clean.out.answer).toBe("done");
    expect(clean.commands.some((c) => c.startsWith("git push") || c.startsWith("git commit"))).toBe(false);
    expect(clean.notes.map((n) => n.summary)).toEqual([
      `the compaction failed (${REFUSAL}); the compaction checkpoint found nothing to push: the tree is clean and \`${BRANCH}\` holds no unpushed commits`,
    ]);
    expect(clean.pushed).toEqual([]);
    // The context no longer fits: the round ends with the push already made.
    const overflowed = await compacted({ dirty: true, thenOverflow: true });
    expect(overflowed.out.failed).toContain(renderProviderFailure("permanent"));
    expect(overflowed.commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
    // The compaction checkpoint preserves the dirty tree; the abnormal ending
    // then adds its own WIP marker so the durable last push cannot look final.
    expect(overflowed.pushed).toHaveLength(2);
    expect(overflowed.pushed).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: BRANCH, sha: HEAD, by: "salvage" })]),
    );
    expect(overflowed.notes).toHaveLength(1);
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, clock: () => clock.now }));
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
    expect(commands.some((c) => c.startsWith("git commit --allow-empty -m"))).toBe(true);
    expect(commands).toContain(`git push origin 'HEAD:refs/heads/${BRANCH}'`);
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

  // harness-pi item 14, pr-description item 5: a coding run on pi whose loop
  // pushed onto a branch that heads an open PR and submitted no description
  // gets its description turn as a `prompt` on the same pi session — the
  // relayed `submit_pr_description` runs in the bot under the turn's own hook,
  // the post-step edits the PR from it, and pi is ended after the turn.
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
        settle("Refreshed the allowlist.");
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
      repoCtx: { repo: "acme/api", ref: "main" } as RepoContext,
      binding: { ref: "main", sha: HEAD, workspace: "/srv/wt/t", user: "worker2" },
      executor,
      coding: true,
    });
    const opened: Array<Record<string, unknown>> = [];
    s.deps.findOpenPrByHead = vi.fn(async () => ({ number: 700, htmlUrl: "https://github.com/acme/api/pull/700" }));
    s.deps.openPullRequest = async (target) => {
      opened.push({ ...target });
      return { number: 700, htmlUrl: "https://github.com/acme/api/pull/700", created: false };
    };
    s.deps.fetchRepoShipInfo = async () => ({ defaultBranch: "main" });
    const out = answered(await runLoop(s.deps, s.ctx));
    // one pi, two prompts on it — alive at the second — the follow-up naming the PR and the pushed head
    expect(container.starts).toHaveLength(1);
    expect(prompts).toBe(2);
    expect(killedWhenPrompted).toEqual([[], []]);
    const followUp = container.stdin
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((c) => c.type === "prompt")[1];
    expect(String(followUp.message)).toContain("https://github.com/acme/api/pull/700");
    expect(String(followUp.message)).toContain("submit_pr_description");
    expect(s.deps.findOpenPrByHead).toHaveBeenCalledWith("acme/api", BRANCH);
    // the run's answer is the loop's; the turn's description opened-or-edited the PR at the observed head
    expect(out.answer).toBe("Refreshed the allowlist.");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "acme/api", headBranch: BRANCH, base: "main", title: DESCRIPTION.title });
    expect(String(opened[0].body)).toContain(`blob/${HEAD}/`);
    expect(out.prNote).toContain("PR updated:");
    expect(out.prNote).not.toContain("body re-rendered"); // the quiet default keeps the link, not the head (item 28)
    expect(out.prNote).not.toContain("not resubmitted");
    // pi ended once, after the turn
    expect(container.killed).toEqual([4242]);
    expect(container.removed).toEqual(["/var/tmp/switchboard-pi-run-l"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
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
      ...thread
    }: {
      repoCtx: RepoContext;
      coordinator?: CoordinatorTag;
      binding?: ResidentBinding;
      instances?: InMemoryCoordinatorInstanceStore;
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
      branch: "fix/the-pr-head",
      protectedBranches: ["main"],
      effects: "shadow",
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
      protectedBranches: ["feat/trunk"],
      effects: "shadow",
      loopEndsIn: expect.any(Function),
    });
    expect(push(child, "unit/u26")).toBe("allowed");
    expect(push(child, "feat/trunk")).toBe("refused");
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
      branch: "unit/u27",
      protectedBranches: ["feat/trunk"],
      effects: "shadow",
      loopEndsIn: expect.any(Function),
    });
    expect(push(recovered, "unit/u27")).toBe("allowed");
    expect(push(recovered, "feat/trunk")).toBe("refused");
    // A plain thread bound at the repository's base: the run pushes a branch of its own making.
    const plain = await rulesOf({ repoCtx: { repo: "o/r", ref: "main" }, binding: { ref: "main", sha: "def" } });
    expect(plain).toEqual({
      identity: "write",
      checkout: "/workspace",
      protectedBranches: ["main"],
      effects: "shadow",
      loopEndsIn: expect.any(Function),
    });
    expect(push(plain, "feat/anything")).toBe("allowed");
    expect(push(plain, "main")).toBe("refused");
  });

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
  it("two deaths in one run: the container rolls under the living bot (a relaunch), then the bot rolls with pi inside its next call — the ledger the next generation reads back carries the settlement turn the relaunch's session started on, so planResume yields a transcript with a result for every call and pi restarts on it in a third container, the model handed a result after every tool_use", async () => {
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

    // pi restarts on it in a third container, and the model is handed a result after every call.
    const c = new FakeHarnessContainer();
    c.vm = "vm-third";
    const modelC = scriptPiFromProvider(c, { provider: provider("third time"), registry });
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
    );
    expect(third.answer).toBe("third time");
    await third.end();
    const view = modelC.requests[0]!.messages;
    expect(view).toHaveLength(5);
    for (const [i, m] of view.entries())
      for (const part of m.content)
        if (part.type === "tool_use")
          expect(view[i + 1]!.content.some((q) => q.type === "tool_result" && q.toolUseId === part.id)).toBe(true);
    expect(facts.at(-1)).toMatchObject({ relaunches: 1, container: "vm-third" });

    // Generation B, gone: its pending model call fails and its pi is ended where it ran.
    botDies();
    await expect(bOpen).rejects.toThrow(renderProviderFailure("permanent"));
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
    findings: [{ id: "F1", severity: "nit", file: "src/x.ts", line: 3, title: "a name" }],
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

  /** A review's pi: reads the head, tries an `edit` the gate refuses (the
   *  extension blocks it and pi ends it as an error — nothing ran), submits
   *  the verdict through the relay as the real extension does (`POST
   *  /harness/tool`), then answers. */
  function scriptedReviewPi(container: FakeHarnessContainer, registry: HarnessRegistry, finalText: string) {
    container.onStdin = (line, c) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === "set_auto_retry" || cmd.type === "get_state")
        c.emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { sessionFile: "s.jsonl" } });
      if (cmd.type !== "prompt") return;
      const live = registry.get("run-l")!;
      c.emit({ id: cmd.id, type: "response", command: "prompt", success: true }, { type: "agent_start" });
      const probe = { command: "git rev-parse HEAD" };
      const t1 = assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: probe }]);
      c.emit(
        { type: "message_end", message: t1 },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: probe },
      );
      authorizeToolCall(live, { toolCallId: "c1", tool: "bash", input: probe });
      c.emit(
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "bash",
          result: { content: [{ type: "text", text: HEAD }] },
          isError: false,
        },
        { type: "turn_end", message: t1, toolResults: [] },
      );
      const edit = { path: "src/x.ts", oldText: "a", newText: "b" };
      const t2 = assistant([{ type: "toolCall", id: "c2", name: "edit", arguments: edit }]);
      c.emit(
        { type: "message_end", message: t2 },
        { type: "tool_execution_start", toolCallId: "c2", toolName: "edit", args: edit },
      );
      const gate = authorizeToolCall(live, { toolCallId: "c2", tool: "edit", input: edit });
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
      review: { head: HEAD, post: async (target, body) => void posts.push({ target, body }) },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    expect(out.answer).toBe("The review: one nit, F1.");
    expect(providerCalls).toBe(0);
    // The process: pi's allowlist for a read identity, the readonly toolset's relays, the bearer, the framing.
    expect(container.starts).toHaveLength(1);
    const args = container.starts[0].args;
    const tools = args[args.indexOf("--tools") + 1].split(",");
    expect(tools.slice(0, 5)).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(tools).toEqual(expect.arrayContaining(["update_status", "submit_verdict", "diff_digest", "web_fetch"]));
    expect(tools).not.toContain("submit_pr_description");
    expect(tools).not.toContain("write_file");
    expect(container.starts[0].env.SWITCHBOARD_RUN_BEARER).toBe("sbr_run-l.s3cret");
    const system = container.files.get("/var/tmp/switchboard-pi-run-l/agent/SYSTEM.md")!;
    expect(system.startsWith("the system prompt\n\nHARNESS NOTE:")).toBe(true);
    expect(system).toContain("no `edit` and no `write`");
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
      "bash",
      "edit",
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
  it("a substantive head move mid-review on pi re-reviews as a prompt on the same pi session: one pi process, two prompts, the worktree moved first, the second verdict posted pinned to the new head, the second answer the run's, pi ended after the settle", async () => {
    const NEW = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    let worktreeHead = HEAD;
    const moves: string[] = [];
    const executor = {
      exec: async (command: string) => (command.includes("rev-parse") ? `${worktreeHead}\n` : ""),
      moveTo: async (sha: string) => {
        moves.push(sha);
        worktreeHead = sha;
        return { sha };
      },
    };
    const killedWhenPrompted: number[][] = [];
    // A review's pi answering TWO prompts on one session: the request with a
    // verdict at the pinned head, then the re-review's follow-up with a verdict
    // at the new head — each through the relay as the real extension submits it.
    let prompts = 0;
    container.onStdin = (line, c) => {
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
      harness: { harnesses: roster(), registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
      bearer: "sbr_run-l.s3cret",
      repoCtx: prThread.repoCtx,
      binding: prThread.binding,
      executor,
      review: {
        head: HEAD,
        post: async (target, body) => void posts.push({ target, body }),
        currentHead: NEW,
        commits: (sha) => (sha === HEAD ? list(["feat: the change"]) : list(["feat: the change", "fix: review nits"])),
      },
    });
    const out = answered(await runLoop(s.deps, s.ctx));
    // one pi, two prompts on it — pi still alive at the second — and the worktree moved before it
    expect(container.starts).toHaveLength(1);
    expect(prompts).toBe(2);
    expect(killedWhenPrompted).toEqual([[], []]);
    expect(moves).toEqual([NEW]);
    const followUp = container.stdin
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((c) => c.type === "prompt")[1];
    expect(String(followUp.message)).toContain("moved from a1b2c3d to d75b5a5");
    expect(String(followUp.message)).toContain("Switchboard has already moved your worktree to d75b5a5");
    // the second verdict and answer are the run's; posted once, pinned to the new head
    expect(out.answer).toBe("Second review: the new test is wrong.");
    expect(out.reviewHead).toBe(NEW);
    expect(posts).toEqual([
      {
        target: { repo: "o/r", number: 42, commitId: NEW },
        body: expect.stringContaining(
          "<summary>Full review</summary>\n\nSecond review: the new test is wrong.\n\n</details>",
        ),
      },
    ]);
    expect(posts[0].body.startsWith("Changes requested: the new test is wrong\n\n> [!WARNING]\n")).toBe(true);
    expect(s.published).toEqual(["answer:Second review: the new test is wrong."]);
    expect(s.replies.some((r) => r.startsWith("🔀 o/r#42 moved during the run"))).toBe(true);
    // pi ended once, after the settle
    expect(container.killed).toEqual([4242]);
    expect(container.removed).toEqual(["/var/tmp/switchboard-pi-run-l"]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "tool_call").map((e) => (e as { tool: string }).tool)).toEqual([
      "submit_verdict",
      "submit_verdict",
    ]);
    expect(rec.events.some((e) => e.type === "run_note" && (e as { kind: string }).kind === "head_moved")).toBe(true);
    expect(rec.events.filter((e) => e.type === "review_posted")).toEqual([
      expect.objectContaining({ type: "review_posted", head: NEW, verdict: "request_changes" }),
    ]);
  });
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
      const gate = authorizeToolCall(live, { toolCallId: "c1", tool: "bash", input: shell });
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
        const gate = authorizeToolCall(live, { toolCallId: "c1", tool: "bash", input: shell });
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
          seed: [
            { role: "user", text: "look into durable objects" },
            { role: "assistant", text: "Storage first: one research child." },
          ],
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
  const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  const VERDICT = {
    verdict: "approve",
    summary: "looks correct",
    head: HEAD,
    findings: [{ id: "F1", severity: "nit", file: "src/x.ts", line: 3, title: "a name" }],
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
      plan: { kind: "finish", messages, answer, inboxConsumedSeq: 0, step: 2, turn: 2, remainingMs: 240_000 },
      events,
      lastSeq: lastStep.seq,
      repoCtx: opts.repoCtx ?? {},
      inbox: [],
    };
  }
  const note = (kind: string, summary: string, seq: number, mode?: "soft" | "hard"): AppendableEvent => ({
    type: "run_note",
    kind: kind as "stopped",
    summary,
    ...(mode ? { mode } : {}),
    at: seq,
    seq,
  });

  it("the model is never called: the transcript's final turn is the answer, published and finished `completed`, and a `resumed` note on the stream says the loop had ended before the restart", async () => {
    const s = setup("", { provider: neverCalled() });
    const resume = finishing("The answer, written before the restart.");
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
    expect(budget.run.control.requested).toBeUndefined();
    expect(budget.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a review resumed with its answer in hand runs its post-steps: the verdict restored from the row is settled at the pinned head and posted, once", async () => {
    const posts: Array<{ target: ReviewCommentTarget; body: string }> = [];
    const s = setup("", {
      agent: "review",
      provider: neverCalled(),
      ...prThread,
      executor: { exec: async (command: string) => (command.includes("rev-parse") ? `${HEAD}\n` : "") },
      review: { head: HEAD, post: async (target, body) => void posts.push({ target, body }) },
    });
    const resume = finishing("The review: one nit, F1.", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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

  it("a review whose verdict a previous generation already posted (a `review_posted` event among the replayed events) posts nothing again: the settle does not run, the outcome on the record is the event's, and the reviewed head is the event's", async () => {
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
      review: { head: HEAD, post: async (target, body) => void posts.push({ target, body }) },
    });
    const resume = finishing("The review: one nit, F1.", {
      agent: "review",
      state: { verdict: VERDICT },
      repoCtx: prThread.repoCtx,
      events: [
        { type: "input", messageId: "m1", text: "hello there", at: 1, seq: 1 },
        { type: "review_posted", repo: "o/r", number: 42, head: HEAD, verdict: "approve", at: 2, seq: 2 },
      ],
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
    // The replayed events are not on this loop's stream (the registry replays
    // them at create); this generation published no review_posted of its own
    // and no review_not_posted note.
    expect(rec.events.filter((e) => e.type === "review_posted")).toHaveLength(0);
    expect(rec.events.some((e) => e.type === "run_note" && (e as { kind: string }).kind === "review_not_posted")).toBe(
      false,
    );
  });

  // agent-ship item 7: a default-bound coding run may cut and publish its own
  // feature branch. On resume the persisted runner receipt, not the resident's
  // original default binding, is the publication authority for the PR post-step.
  it("a resumed default-bound coding run restores its feature-branch publication receipt at the current head", async () => {
    const BRANCH = "feat/typed-effect";
    const AFTER = "b".repeat(40);
    const description: PrDescription = {
      title: "fix(core): restore typed publication receipts",
      tldr: "Restores a published feature branch after restart. The PR post-step keeps its publication authority.",
      why: "A default resident binding names main rather than the branch created by the run.",
      pointers: [
        { label: "Receipt restore", text: "Matches the run-owned ref.", anchor: { path: "src/a", from: 1, to: 2 } },
      ],
      feedbackWanted: "Check the resume boundary.",
      verified: "Focused regression.",
      decisions: [],
      risk: "Low.",
      validation: { criteria: [{ criterion: "resume", proof: "covered" }] },
    };
    const receipt = {
      effectId: "push-1",
      kind: "push" as const,
      outcome: "succeeded" as const,
      actor: "slack:UX",
      repository: "o/r",
      resource: `o/r#refs/heads/${BRANCH}`,
      destination: `refs/heads/${BRANCH}`,
      after: AFTER,
      tree: AFTER,
      endpoint: "https://github.com/o/r.git",
      gates: [],
      by: "runner" as const,
      occurredAt: NOW - 1_000,
    };
    const executor = {
      exec: async (cmd: string) => {
        if (/rev-parse --abbrev-ref HEAD/.test(cmd)) return `${BRANCH}\n`;
        if (cmd.includes(`refs/heads/${BRANCH}`)) return `${AFTER}\n`;
        if (/rev-parse HEAD/.test(cmd)) return `${AFTER}\n`;
        if (/rev-list --count/.test(cmd)) return "0\n";
        return ""; // the effect-only child cannot prove publication through ls-remote
      },
    };
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: `${YAML}\nrunHistory:\n  store: worker\n  worker:\n    baseUrl: https://state.example\nharness:\n  effects: on\n`,
      repoCtx: { repo: "o/r", baseRef: "main" },
      binding: { ref: "main", sha: "a".repeat(40), workspace: "/srv/wt/default" },
      executor,
      coding: true,
    });
    const opened: Array<Record<string, unknown>> = [];
    s.deps.commitsOverBase = async () => 1;
    s.deps.openPullRequest = async (target) => {
      opened.push({ ...target });
      return { number: 74, htmlUrl: "https://github.com/o/r/pull/74", created: true };
    };
    const resume = finishing("Done: published the feature branch.", {
      agent: "coding",
      state: {
        prDescription: description,
        pushedBranch: BRANCH,
        effects: { envelopes: {}, results: { "push-1": receipt } },
      },
    });

    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "o/r", headBranch: BRANCH, base: "main" });
    expect(out.prNote).toContain("PR opened");
  });

  // run-history item 48a: a coding child resumed after a bot roll whose tag
  // lost the plan's base — the spawn's dispatch options gone with the process —
  // reads `instance.base` from the coordinator store by parentInstanceId before
  // building its PR target, rather than letting the binding ref (the unit
  // branch itself) stand in.
  it("a coordinator child resumed with a description in hand and a tag without a base reads the plan's base from the coordinator store: the PR opens against instance.base, never against the unit branch", async () => {
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
    const opened: Array<Record<string, unknown>> = [];
    s.deps.openPullRequest = async (target) => {
      opened.push({ ...target });
      return { number: 9, htmlUrl: "https://github.com/o/r/pull/9", created: true };
    };
    s.deps.fetchRepoShipInfo = async () => {
      throw new Error("the default branch is not the plan's base and must not be asked for");
    };
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { prDescription: description, pushedBranch: BRANCH },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "o/r", headBranch: BRANCH, base: "feat/trunk" });
    expect(out.prNote).toContain("PR opened");
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(opened).toEqual([]);
    expect(out.prNote).toContain("the plan's base was lost across a roll");
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

  it("a resumed run whose ledger row records a pre-restart push of its own branch fires no start-state re-read: the rewrite is asked over an UNKNOWN start state naming the restart and fails closed, so nothing opens over the pre-restart commits", async () => {
    const { BRANCH, description, s, reads, startStates, opened } = startStateFixture();
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { prDescription: description, pushedBranch: BRANCH },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(reads).toEqual([]);
    expect(startStates).toEqual([
      { kind: "unknown", reason: expect.stringContaining(`pushed ${BRANCH} before a restart`) },
    ]);
    expect(opened).toEqual([]);
    expect(out.prNote).toContain("could not be verified");
  });

  it("a resumed run whose ledger row records NO push of the binding branch still reads the start state at attach: the rewrite judges over the read state and a clean branch opens", async () => {
    const { BRANCH, description, s, reads, startStates, opened } = startStateFixture();
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { prDescription: description },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(reads).toEqual([BRANCH]);
    expect(startStates).toEqual([{ kind: "known", commits: [] }]);
    expect(opened).toHaveLength(1);
    expect(out.prNote).toContain("PR opened");
  });

  it("on the pi harness no pi is started and the one the previous generation left is ended at its recorded pid and root (harness-pi item 8)", async () => {
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
      state: { harness: { pid: 777, logOffset: 10, root: "/tmp/switchboard-pi-old-build-run-l" } },
    });
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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

  it("on the pi harness a leftover pi whose facts name another container than this run was handed is not ended here: the pid is a stranger's in this container, and a note names the orphan (harness-pi item 8)", async () => {
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(out.answer).toBe("Done: pushed the fix.");
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
    const notes = s.registry
      .snapshotById("run-l")!
      .events.filter((e) => e.type === "run_note")
      .map((e) => (e as { summary: string }).summary);
    expect(notes).toContainEqual(
      "the run's pi process (pid 777) ran in container vm-old, not the one this run was handed (vm-fake): it was not ended here",
    );
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
    expect(out.answer).toBe("Resumed on OpenCode.");
    expect(oc.calls.open).toEqual([OPENCODE_ROW]);
    expect(pi.calls.open).toEqual([]);
    expect(container.starts).toEqual([]);
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
    const out = answered(await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }));
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
      review: { head: HEAD, post: async (target, body) => void posts.push({ target, body }) },
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
    const attachCtx = { threadKey: THREAD, agent, profile, repoCtx, root: trace.root, clock: () => NOW };

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
    expect(notes[1]!.summary).toMatch(
      /pi is elsewhere: the row's pi \(pid 4242\) ran in container vm-fake, not the one this run was handed \(vm-new\)/,
    );
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
