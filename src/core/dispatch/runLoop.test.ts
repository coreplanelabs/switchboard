import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../config.js";
import { getAgent } from "../../agents/registry.js";
import { declaredProfile } from "../../config/profile.js";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import type { Provider } from "../provider.js";
import { ExecSandboxRestartedError, type Executor } from "../../execution/executor.js";
import { channelOf, startRequestRoot } from "../requestTrace.js";
import { createRunEnding } from "../runEnding.js";
import { createRunHistoryWriter } from "../runHistoryWriter.js";
import { RunRegistry } from "../runRegistry.js";
import { NullLedgerWriteThrough } from "../runLedger/writeThrough.js";
import { InMemoryRunStore, NullRunStore } from "../runStore.js";
import { createCardShell } from "../statusCardFrame.js";
import { ThreadAdmission } from "../threadAdmission.js";
import type { ChannelIO, IncomingMessage, StatusUpdate } from "../types.js";
import type { DispatchFollowUp } from "./admission.js";
import { buildMessages } from "./messages.js";
import { resolveRun } from "./resolve.js";
import type { HarnessProcessDeps, RunDeps } from "./run.js";
import { runLoop } from "./runLoop.js";
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
import { HarnessInterruptedError, HarnessMismatchError } from "../harness/contract.js";
import { ModelPolicyRefusedError, PiContainerReplacedError } from "../harness/pi/harness.js";
import { PiHarness } from "../harness/pi/piHarness.js";
import { FakeHarnessContainer } from "../harness/testing/fakeContainer.js";
import { scriptPiFromProvider } from "../harness/pi/testing/providerPi.js";
import { judgeToolCall, type ToolRuleContext } from "../harness/pi/toolRules.js";
import type { CoordinatorTag } from "../coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { RepoContext } from "../repoContext.js";
import type { ResidentBinding } from "../../execution/resident.js";
import { InMemoryArtifactStore, type ArtifactStore } from "../../artifacts/store.js";
import type { ReviewCommentTarget } from "../../execution/githubComments.js";
import type { PrCommitList } from "../headMoved.js";
import type { PrDescription } from "../prDescription.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ResumeContext } from "./admission.js";
import type { AppendableEvent, LiveRunRow, StepRecord } from "../runLedger/types.js";

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

/** The harness every test process drives runs with (harness.md item 7): pi, with no deployment settings behind it. */
const piHarness = new PiHarness();

function provider(answer: string | Error): Provider {
  return {
    name: "fake",
    async complete() {
      if (answer instanceof Error) throw answer;
      return { content: [{ type: "text", text: answer }], stopReason: "end_turn" };
    },
  };
}

const msg = (text: string): IncomingMessage => ({ channelId: "slack:CX", userId: "slack:UX", threadKey: THREAD, text });

/** Everything the loop is handed for one general-agent run, with a recording
 *  channel, card and registry, and a real writer over an in-memory store.
 *  `opts.agent` runs another preset with `opts.provider` scripting its turns,
 *  `opts.io` adds channel methods, `opts.executor` is the round's workspace. */
function setup(
  answer: string | Error,
  opts: {
    agent?: string;
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
          harness: piHarness,
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
  const message = msg("hello there");
  const { resolved } = resolveRun(
    { config },
    { msg: message, directives: { text: "hello there", ...(opts.agent ? { agent: opts.agent } : {}) }, history: [] },
  );
  const agent = getAgent(resolved.agentName);
  const registry = new RunRegistry({ genId: () => "run-l", genToken: () => "tok" });
  const run = registry.create(`${agentName} · #CX · UX`, {
    agent: agentName,
    model: resolved.modelRef,
    channelId: "slack:CX",
    userId: "slack:UX",
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
      release: async (opts: { hardStopped: boolean }) => void releases.push(opts.hardStopped ? "hard" : "paired"),
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
    const out = await runLoop(withUpload.deps, withUpload.ctx);
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
    const out = await runLoop(s.deps, s.ctx);
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
    await expect(runLoop(s.deps, s.ctx)).rejects.toThrow("provider down");
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "failed" });
    expect(s.releases).toEqual(["paired"]);
    expect(s.closes).toHaveLength(1);
    expect(JSON.stringify(s.closes[0])).toContain("❌");
    expect(s.published).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    expect((await s.store.get("run-l"))!.status).toBe("failed");
  });

  // docs/reference/specs/run-history.md item 57: the failure by name. The
  // provider's refusal reaches the loop as the harness's typed error, and the
  // record says so, so the session's next seed can leave the request out.
  it("a run whose model call the provider refused under its usage policy fails by name: the error is the refusal, the record says failure: policy_refusal beside status failed and the note keeps the provider's words; a run failed for any other reason carries no failure key", async () => {
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
      expect.objectContaining({ summary: expect.stringContaining("blocked by the provider's classifier") }),
    ]);

    const down = setup(new Error("provider down"));
    await expect(runLoop(down.deps, down.ctx)).rejects.toThrow("provider down");
    down.ending.drain(undefined);
    await down.writer.settled();
    expect("failure" in (await down.store.get("run-l"))!).toBe(false);
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
        harness: piHarness,
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
    const out = await runLoop(s.deps, s.ctx);
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

  it("without a store the pi steer is sent as before: no copy, no pull, no line", async () => {
    const container = new FakeHarnessContainer();
    const steers = piFinishingOnSteer(container, "done");
    const commands: string[] = [];
    const s = setup("", {
      agent: "coding",
      provider: provider("unused"),
      yaml: PI_YAML,
      harness: {
        harness: piHarness,
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
    const out = await runLoop(s.deps, s.ctx);
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
        harness: piHarness,
        registry,
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
      bearer: "sbr_run-l.s3cret",
    });
    const out = await runLoop(s.deps, s.ctx);
    expect(out.answer).toBe("pi says done");
    expect(out.toolCalls).toBe(1);
    expect(providerCalls).toBe(0);
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0].env.SWITCHBOARD_RUN_BEARER).toBe("sbr_run-l.s3cret");
    expect(container.files.get("/tmp/switchboard-pi-run-l/agent/SYSTEM.md")).toContain("the system prompt");
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
      whatWhy: "Dependabot moved the pin; the allowlist matches lines by content.",
      tour: [
        {
          title: "The allowlist",
          description: "Three entries at the new pin.",
          anchor: { path: "scripts/a", from: 1, to: 3 },
        },
      ],
      remaining: [],
      decisions: [{ title: "Keep dependabot's notes", rationale: "They are still true; they moved into whatWhy." }],
      risks: "none",
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
      harness: { harness: piHarness, registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
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
    const out = await runLoop(s.deps, s.ctx);
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
    expect(out.prNote).toContain("body re-rendered");
    expect(out.prNote).not.toContain("not resubmitted");
    // pi ended once, after the turn
    expect(container.killed).toEqual([4242]);
    expect(container.removed).toEqual(["/tmp/switchboard-pi-run-l"]);
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
  it("a run on a resident files its pi under the run's own root directly under /tmp, whatever pool user the attach binding names, and removes it when the run ends", async () => {
    const container = new FakeHarnessContainer();
    const registry = new HarnessRegistry();
    scriptedPi(container, registry, "pi says done");
    const s = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      harness: { harness: piHarness, registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
      bearer: "sbr_run-l.s3cret",
      binding: { ref: "main", sha: "abc", workspace: "/workspace/threads/t/main", user: "worker2" },
    });
    const out = await runLoop(s.deps, s.ctx);
    expect(out.answer).toBe("pi says done");
    expect(container.starts[0].paths.dir).toBe("/tmp/switchboard-pi-run-l");
    expect(container.files.get("/tmp/switchboard-pi-run-l/agent/SYSTEM.md")).toContain("the system prompt");
    const roots = [...container.files.keys()].map((f) => f.split("/").slice(0, 3).join("/"));
    expect(new Set(roots)).toEqual(new Set(["/tmp/switchboard-pi-run-l"]));
    expect(container.removed).toEqual(["/tmp/switchboard-pi-run-l"]);
  });

  it("the gate's push rules follow the thread: a pull-request thread's or a unit child's bound branch is the run's own — the one push target, its base protected; a plain thread's binding is the protected base", async () => {
    const seen: ToolRuleContext[] = [];
    class RecordingRegistry extends HarnessRegistry {
      override register(harness: LiveHarness): () => void {
        seen.push(harness.rules);
        return super.register(harness);
      }
    }
    const rulesOf = async (thread: {
      repoCtx: RepoContext;
      coordinator?: CoordinatorTag;
      binding?: ResidentBinding;
    }) => {
      const container = new FakeHarnessContainer();
      const registry = new RecordingRegistry();
      scriptedPi(container, registry, "done");
      const s = setup("", {
        agent: "coding",
        yaml: PI_YAML,
        harness: {
          harness: piHarness,
          registry,
          harnessUrl: "https://bot.example.com",
          containerFor: () => container,
        },
        bearer: "sbr_run-l.s3cret",
        ...thread,
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
      branch: "fix/the-pr-head",
      protectedBranches: ["main"],
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
    });
    expect(push(child, "unit/u26")).toBe("allowed");
    expect(push(child, "feat/trunk")).toBe("refused");
    // A plain thread bound at the repository's base: the run pushes a branch of its own making.
    const plain = await rulesOf({ repoCtx: { repo: "o/r", ref: "main" }, binding: { ref: "main", sha: "def" } });
    expect(plain).toEqual({ identity: "write", checkout: "/workspace", protectedBranches: ["main"] });
    expect(push(plain, "feat/anything")).toBe("allowed");
    expect(push(plain, "main")).toBe("refused");
  });

  it("a preset on pi in a process without the harness deps, a public URL or a bearer fails the run naming what is missing", async () => {
    const noDeps = setup("", { agent: "coding", yaml: PI_YAML, harness: null, bearer: "sbr_x.y" });
    await expect(runLoop(noDeps.deps, noDeps.ctx)).rejects.toThrow(/no harness deps/);
    const noUrl = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      harness: { harness: piHarness, registry: new HarnessRegistry() },
      bearer: "sbr_x.y",
    });
    await expect(runLoop(noUrl.deps, noUrl.ctx)).rejects.toThrow(/PUBLIC_BASE_URL/);
    const noBearer = setup("", {
      agent: "coding",
      yaml: PI_YAML,
      harness: { harness: piHarness, registry: new HarnessRegistry(), harnessUrl: "https://b" },
      bearer: null,
    });
    await expect(runLoop(noBearer.deps, noBearer.ctx)).rejects.toThrow(/model-proxy bearer/);
  });
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
// Feature: docs/reference/specs/harness-pi.md item 16 — the run stage reads the
// harness's replaced-container verdict as an interruption, never a failure:
// the terminal shape a refused re-attach leaves (run-history item 54), so the
// dispatcher runs the request again as a new run.
describe("the pi harness — the container replaced under a live run", () => {
  it("a run whose pi container is replaced under it ends `interrupted`, not failed: the replaced-container error propagates for the dispatcher's restart, the registry and the record say interrupted with the sandbox_restarted note and the settled call, the workspace is released, and the card closes 🔁 saying the run restarts from its request — never ❌", async () => {
    const registry = new HarnessRegistry();
    const container = new FakeHarnessContainer();
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
      c.emit(
        { id: cmd.id, type: "response", command: "prompt", success: true },
        { type: "agent_start" },
        { type: "message_end", message: call },
        { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" } },
      );
      authorizeToolCall(registry.get("run-l")!, { toolCallId: "c1", tool: "bash", input: { command: "npm test" } });
      // The resident's container rolls under the run: the executor waits for
      // the wake, re-attaches to the replacement — which names itself anew —
      // and hands the probe back as the restart (resident-repos item 65).
      c.vm = "vm-new";
      c.alive = async () => {
        throw new ExecSandboxRestartedError("the sandbox restarted under the run (waited 42 s)", 42_000);
      };
    };
    const s = setup("unused", {
      agent: "coding",
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harness: piHarness,
        registry,
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => container,
        pollMs: 1,
        tickMs: 5,
      },
    });
    const err = await runLoop(s.deps, s.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiContainerReplacedError);
    // The seam's interruption vocabulary (harness.md item 7): the loop and the dispatcher read the reason and the refusal off it.
    expect(err).toBeInstanceOf(HarnessInterruptedError);
    expect(err).toMatchObject({
      reason: "container replaced under the run; restarting from the request",
      refusal: "container_replaced",
    });
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "interrupted" });
    expect(s.releases).toEqual(["paired"]);
    expect(s.closes).toHaveLength(1);
    const close = JSON.stringify(s.closes[0]);
    expect(close).toContain("🔁");
    expect(close).toContain("container replaced under the run; restarting from the request");
    expect(close).not.toContain("❌");
    expect(s.published).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.status).toBe("interrupted");
    const note = record.events.find((e) => e.type === "run_note") as { kind: string; summary: string };
    expect(note).toMatchObject({
      kind: "sandbox_restarted",
      summary:
        "the container running pi was replaced (vm-fake → vm-new; the executor said: the sandbox restarted under the run (waited 42 s)); the run restarts from its request",
    });
    expect(record.events.find((e) => e.type === "tool_result")).toMatchObject({
      tool: "bash",
      ok: false,
      callId: "c1",
      summary: expect.stringMatching(/^The container running pi was replaced while this bash call was in flight/),
    });
    expect(container.killed).toEqual([]);
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
      harness: { harness: piHarness, registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
      bearer: "sbr_run-l.s3cret",
      ...prThread,
      review: { head: HEAD, post: async (target, body) => void posts.push({ target, body }) },
    });
    const out = await runLoop(s.deps, s.ctx);
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
    const system = container.files.get("/tmp/switchboard-pi-run-l/agent/SYSTEM.md")!;
    expect(system.startsWith("the system prompt\n\nHARNESS NOTE:")).toBe(true);
    expect(system).toContain("no `edit` and no `write`");
    expect(system).not.toContain("`write_file` use `write`");
    // The gate's rules read the preset's identity.
    // The verdict path: the same post-step, the same guard, the same first line — a comment, never an approval.
    expect(posts).toEqual([
      {
        target: { repo: "o/r", number: 42, commitId: HEAD },
        body: `LGTM: looks correct\n- [nit] F1 src/x.ts:3 — a name\n\nThe review: one nit, F1.`,
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
      provider: provider("unused"),
      yaml: REVIEW_PI_YAML,
      harness: { harness: piHarness, registry, harnessUrl: "https://bot.example.com", containerFor: () => container },
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
    const out = await runLoop(s.deps, s.ctx);
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
        body: "Changes requested: the new test is wrong\n\nSecond review: the new test is wrong.",
      },
    ]);
    expect(s.published).toEqual(["answer:Second review: the new test is wrong."]);
    expect(s.replies.some((r) => r.startsWith("🔀 o/r#42 moved during the run"))).toBe(true);
    // pi ended once, after the settle
    expect(container.killed).toEqual([4242]);
    expect(container.removed).toEqual(["/tmp/switchboard-pi-run-l"]);
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
        harness: piHarness,
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
    const out = await runLoop(s.deps, s.ctx);
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
      "github_issue_create",
      "github_issue_update",
      "github_issue_comment",
      "github_issue_delete",
    ]);
    for (const own of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(tools).not.toContain(own);
    const models = JSON.parse(container.files.get("/tmp/switchboard-pi-run-l/agent/models.json")!);
    expect(models.providers.switchboard.baseUrl).toBe("http://127.0.0.1:8080");
    const system = container.files.get("/tmp/switchboard-pi-run-l/agent/SYSTEM.md")!;
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
    expect(container.removed).toEqual(["/tmp/switchboard-pi-run-l"]);
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
      harness: { harness: piHarness, registry: new HarnessRegistry(), harnessUrl: "https://bot.example.com" },
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
        harness: piHarness,
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
    const out = await runLoop(s.deps, s.ctx);
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
        harness: piHarness,
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
    const out = await runLoop(s.deps, s.ctx);
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
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
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
    const stoppedOut = await runLoop(stopped.deps, {
      ...stopped.ctx,
      resume: softStop,
      messages: softStop.plan.messages,
    });
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
    const budgetOut = await runLoop(budget.deps, {
      ...budget.ctx,
      resume: timeBudget,
      messages: timeBudget.plan.messages,
    });
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
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
    expect(out.answer).toBe("The review: one nit, F1.");
    expect(posts).toEqual([
      {
        target: { repo: "o/r", number: 42, commitId: HEAD },
        body: `LGTM: looks correct\n- [nit] F1 src/x.ts:3 — a name\n\nThe review: one nit, F1.`,
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
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
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
      whatWhy: "The handler dropped the cookie; this restores it.",
      tour: [{ title: "The fix", description: "The cookie is set again.", anchor: { path: "src/a", from: 1, to: 2 } }],
      remaining: [],
      decisions: [{ title: "Keep it small", rationale: "One-line fix." }],
      risks: "none",
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
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ repo: "o/r", headBranch: BRANCH, base: "feat/trunk" });
    expect(out.prNote).toContain("PR opened");
  });

  it("a coordinator child whose plan base survived nowhere — no tag base, no instance in the store — opens nothing and publishes pr_not_opened saying the plan's base was lost across a roll", async () => {
    const BRANCH = "plan/p/u1";
    const description: PrDescription = {
      title: "Fix the login redirect",
      tldr: "Restores the session cookie on login. Users can sign in again.",
      whatWhy: "The handler dropped the cookie; this restores it.",
      tour: [{ title: "The fix", description: "The cookie is set again.", anchor: { path: "src/a", from: 1, to: 2 } }],
      remaining: [],
      decisions: [{ title: "Keep it small", rationale: "One-line fix." }],
      risks: "none",
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
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
    expect(opened).toEqual([]);
    expect(out.prNote).toContain("the plan's base was lost across a roll");
    s.ending.drain(true);
    await s.writer.settled();
    const rec = (await s.store.get("run-l"))!;
    expect(rec.events.filter((e) => e.type === "run_note" && (e as { kind: string }).kind === "pr_not_opened")).toEqual(
      [expect.objectContaining({ summary: "no PR opened: the plan's base was lost across a roll" })],
    );
  });

  it("on the pi harness no pi is started and the one the previous generation left is ended at its recorded pid and root (harness-pi item 8)", async () => {
    const container = new FakeHarnessContainer();
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harness: piHarness,
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { pid: 777, logOffset: 10, root: "/tmp/switchboard-pi-old-build-run-l" } },
    });
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
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
        harness: piHarness,
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { pid: 777, logOffset: 10, root: "/tmp/switchboard-pi-run-l", container: "vm-old" } },
    });
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
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
        harness: piHarness,
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", {
      agent: "coding",
      state: { harness: { pid: 777, logOffset: 10, root: "/tmp/switchboard-pi-run-l", container: "vm-old" } },
    });
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
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

  // docs/reference/specs/harness.md item 7: a row's facts are read by the
  // harness that wrote them. A row another harness wrote names a process pi
  // can neither judge nor end.
  const OPENCODE_ROW = {
    harness: "opencode",
    pid: 9,
    port: 41000,
    logOffset: 0,
    sessionID: "ses_1",
    root: "/tmp/switchboard-oc-run-l",
    bearerHash: "h",
    container: "vm-1",
    relaunches: 0,
  };

  it("a `finish` plan whose row carries another harness's facts ends nothing: the harness answers another-harness, a note names both harnesses, and the post-steps run with the answer", async () => {
    const container = new FakeHarnessContainer();
    const s = setup("", {
      agent: "coding",
      provider: neverCalled(),
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harness: piHarness,
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        containerFor: () => container,
      },
    });
    const resume = finishing("Done: pushed the fix.", { agent: "coding", state: { harness: OPENCODE_ROW } });
    const out = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages });
    expect(out.answer).toBe("Done: pushed the fix.");
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
    expect(container.starts).toEqual([]);
    const notes = s.registry
      .snapshotById("run-l")!
      .events.filter((e) => e.type === "run_note")
      .map((e) => (e as { summary: string }).summary);
    expect(notes).toContainEqual(
      "the run's row carries opencode harness facts (pid 9), and this run is driven by pi: that process was neither judged nor ended here",
    );
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "completed" });
  });

  it("a resume mid-loop whose row carries another harness's facts closes the run `interrupted`, not failed: the loop refuses before any harness opens, HarnessMismatchError propagates for the dispatcher's restart, nothing is filed, started, killed or removed, the record carries the harness_error note once, the workspace is released, and the card closes 🔁 naming both harnesses — never ❌", async () => {
    const container = new FakeHarnessContainer();
    const opened: string[] = [];
    const watching = new PiHarness();
    const open = watching.open.bind(watching);
    watching.open = (deps, run) => {
      opened.push(run.runId);
      return open(deps, run);
    };
    const s = setup("unused", {
      agent: "coding",
      yaml: YAML + "harness:\n  coding: pi\n",
      harness: {
        harness: piHarness,
        registry: new HarnessRegistry(),
        harnessUrl: "https://bot.example.com",
        loopbackUrl: "http://127.0.0.1:8080",
        containerFor: () => container,
        pollMs: 1,
        tickMs: 5,
      },
    });
    s.deps.harness = { ...s.deps.harness!, harness: watching };
    const resume = reentering({ harness: OPENCODE_ROW });
    const err = await runLoop(s.deps, { ...s.ctx, resume, messages: resume.plan.messages }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessMismatchError);
    expect(err).toBeInstanceOf(HarnessInterruptedError);
    expect(err).toMatchObject({ expected: "pi", found: "opencode", refusal: "harness_mismatch" });
    expect(opened).toEqual([]); // the loop refused; no harness was opened
    expect(s.registry.getById("run-l")).toMatchObject({ finished: true, status: "interrupted" });
    expect(container.files.size).toBe(0);
    expect(container.starts).toEqual([]);
    expect(container.killed).toEqual([]);
    expect(container.removed).toEqual([]);
    expect(s.releases).toEqual(["paired"]);
    expect(s.closes).toHaveLength(1);
    const close = JSON.stringify(s.closes[0]);
    expect(close).toContain("🔁");
    expect(close).toContain("the row's harness facts are opencode's, not pi's; restarting from the request");
    expect(close).not.toContain("❌");
    expect(s.published).toEqual([]);
    s.ending.drain(undefined);
    await s.writer.settled();
    const record = (await s.store.get("run-l"))!;
    expect(record.status).toBe("interrupted");
    const notes = record.events.filter((e) => e.type === "run_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "harness_error",
      summary:
        "the run's row carries opencode harness facts and this run is driven by pi: nothing of that process is judged or ended here; the run restarts from its request",
    });
  });
});
