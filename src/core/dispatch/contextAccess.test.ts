import { testSourceInput } from "../testing/sourceInputs.js";
import { InMemoryCoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { turnRows } from "../runLedger/transcript.js";
import { appendCoordinatorStatus } from "../coordinator/unitStatus.js";
import { freezeCoordinatorReport } from "../coordinator/reportContext.js";
import { readOperatorTailContext } from "./operatorTail.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../coordinator/contract.js";
import { privateWorkerThreadKey, InMemoryPrivateWorkerLog } from "../privateWorkerLog.js";
import { rehostPrivateWorkerIO } from "../../channels/privateWorker.js";
import type { UnitContext } from "./unitContext.js";
import { GithubApiError, InMemoryGithubApi } from "../../execution/githubApi.js";
import { githubRepositoryDependencies, memoryScopeDependencies } from "../references/contextDependencies.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { RunRecord } from "../runRecord.js";
import type { LiveRunRow } from "../runLedger/types.js";
import { type ContextOrigin, type ContextDependencies } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import { executionAdmissionHash } from "./executionGithubContext.js";
import { githubReadWithContext } from "./githubReadContext.js";
import { githubFileTool } from "../../tools/github.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { PiMirror } from "../harness/pi/mirror.js";
import { withSourceResults, type SourceResultReceipt } from "../references/sourceResultContext.js";
import { RunBearerStore } from "../modelProxy/runBearers.js";
import { createTracer } from "../trace/tracer.js";
import { secretsFrom } from "../../secrets.js";
import { handleModelProxyRequest, ANTHROPIC_MESSAGES_PATH } from "../../channels/modelProxy.js";
import type { ChatMessage } from "../chatMessage.js";
import {
  checkpointMembersOf,
  checkpointMemberHashesOf,
  planContextCheckpoint,
  type CanonicalCheckpointSource,
} from "../references/contextCheckpoint.js";
import { contextDependenciesHash } from "../references/contextDependencies.js";
import { createSourceReads, type SourceReadOperation, type SourceReadState } from "../../mcp/sourceRead.js";
import { sourceReadContract } from "../../mcp/sourceReadProtocol.js";
import { readQuery, readResponse, readTool } from "../../mcp/testing/sourceRead.js";
import { InMemoryMemoryStore } from "../memory/stores.js";
import { sealMemoryCandidate } from "../memory/provenance.js";
import type { HandoffSource } from "./handoff.js";
import {
  contextAccessForMessage,
  contextAccessForExecution,
  contextAccessForRun,
  revalidateAdmittedContext,
  type ContextAccessDeps,
} from "./contextAccess.js";

afterEach(() => vi.restoreAllMocks());
const msg: IncomingMessage = {
  userId: "slack:UA",
  channelId: "slack:DA",
  threadKey: "slack:DA:1",
  text: "continue",
  directAudience: { kind: "slack-unshared-im", userId: "slack:UA", channelId: "slack:DA", threadKey: "slack:DA:1" },
};
const origin: ContextOrigin = {
  runId: "original",
  requester: msg.userId,
  channelId: msg.channelId,
  threadKey: msg.threadKey,
};
const clean = { version: 1 as const, status: "known" as const, revision: 0, origins: [], slack: [], mcp: [] };
const closure = { ...clean, origins: [origin] };

describe("publication of admitted context", () => {
  it("names unknown, changing and unavailable context separately", async () => {
    let current: ContextDependencies = clean;
    expect(
      await revalidateAdmittedContext(
        () => ({ ...clean, status: "unknown" }),
        async () => ({ ok: true }),
      ),
    ).toEqual({ ok: false, code: "saved-context-unproved", check: "context_unknown" });
    expect(
      await revalidateAdmittedContext(
        () => current,
        async () => {
          current = { ...current, revision: current.revision + 1 };
          return { ok: true };
        },
      ),
    ).toEqual({ ok: false, code: "saved-context-unproved", check: "context_changed" });
    expect(
      await revalidateAdmittedContext(
        () => clean,
        async () => {
          throw new Error("private source content");
        },
      ),
    ).toEqual({ ok: false, code: "saved-context-unproved", check: "context_validation_exception" });
  });
  it("rechecks a dependency admitted during the asynchronous validation", async () => {
    let current: ContextDependencies = clean;
    const seen: unknown[] = [];
    const result = await revalidateAdmittedContext(
      () => current,
      async (snapshot) => {
        seen.push(snapshot);
        if (seen.length === 1) current = { ...clean, revision: 1, memoryScopes: ["user:slack:UA"] };
        return { ok: true };
      },
    );
    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ memoryScopes: ["user:slack:UA"] });
  });

  it("withholds when admission keeps changing or required proof disappears", async () => {
    let current: ContextDependencies = clean;
    expect(
      await revalidateAdmittedContext(
        () => current,
        async () => {
          current = { ...current, revision: current.revision + 1 };
          return { ok: true };
        },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await revalidateAdmittedContext(
        () => clean,
        async () => {
          throw new Error("source unavailable");
        },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await revalidateAdmittedContext(
        () => ({ ...clean, status: "unknown" }),
        async () => ({ ok: true }),
      ),
    ).toMatchObject({ ok: false });
  });
});
function setup() {
  const record = {
    id: origin.runId,
    userId: msg.userId,
    channelId: msg.channelId,
    threadKey: msg.threadKey,
    agent: "coding",
    events: [],
    contextDependencies: closure,
  } as unknown as RunRecord;
  const records = new Map([[record.id, record]]);
  const live: LiveRunRow[] = [];
  const io = {
    directAudience: () => msg.directAudience,
    verifyDirectAudience: vi.fn(async () => ({ ok: true })),
  } as unknown as ChannelIO;
  const originAudience = vi.fn(async (): Promise<"public" | "private" | "dm" | undefined> => "dm");
  const getRunEvents = vi.fn();
  const deps = {
    config: { grantsFor: () => ALL_GRANTS, userGithubBinding: () => undefined },
    runStore: { get: async (id: string) => records.get(id) },
    runLedger: { readLiveRuns: async () => live, readSessionTail: vi.fn() },
    slackContextForRun: () => ({ originAudience, canReadSource: async () => true }),
    mcp: { toolsFor: vi.fn() },
    runs: { getRunEvents },
  } as unknown as ContextAccessDeps;
  return {
    record,
    records,
    live,
    io,
    deps,
    originAudience,
    getRunEvents,
    access: contextAccessForMessage(deps, { msg, io }),
  };
}

async function workerFixture(f: ReturnType<typeof setup>) {
  const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
  const instance: CoordinatorInstance = {
    id: "plan_context",
    kind: "ship",
    userId: msg.userId,
    channelId: msg.channelId,
    threadKey: msg.threadKey,
    repo: "acme/api",
    branch: "plan/context/u1",
    base: "main",
    merge: "person",
    plan: { id: "context" },
    createdAt: 1,
  };
  const threadKey = privateWorkerThreadKey({ instanceId: instance.id, unit: "U11" });
  const context: UnitContext = {
    version: 1,
    handoff: {
      version: 1,
      source: origin,
      session: { key: "original-session", from: 0, to: 0 },
      window: { from: 0, to: 0, hash: "a".repeat(64) },
      dependencies: { value: closure, hash: "b".repeat(64) },
      assets: [],
    },
  };
  const unit: CoordinatorUnit & { context: UnitContext } = {
    instanceId: instance.id,
    unit: "U11",
    slug: "u1",
    branch: instance.branch,
    dependsOn: [],
    rounds: [],
    threadKey,
    context,
    workBrief: {
      requesterId: instance.userId,
      mainThreadKey: instance.threadKey,
      actId: "original-act",
      repo: instance.repo,
      base: instance.base!,
      question: "Why?",
      findings: [],
      requestedChange: "Fix it",
    },
  };
  await instances.recordRequesterTurn({ threadKey: instance.threadKey, requesterId: instance.userId, messageId: "1" });
  expect(
    await instances.claimMainTask({ mainThreadKey: instance.threadKey, actId: "original-act" }, instance, unit, {
      requesterId: instance.userId,
      sourceMessageId: "1",
      revision: 1,
      repo: instance.repo,
    }),
  ).toMatchObject({ ok: true, created: true });
  f.deps.coordinatorInstances = instances;
  const key = `${instance.id}:U11/0/coding`;
  const request: IncomingMessage = {
    userId: instance.userId,
    channelId: instance.channelId,
    threadKey,
    messageId: key,
    text: "continue",
  };
  const verify = vi.fn(async () => ({ ok: true }) as const);
  const io = rehostPrivateWorkerIO(
    new InMemoryPrivateWorkerLog(),
    { instanceId: instance.id, unit: unit.unit },
    {
      clock: () => 1,
      currentInputId: key,
      instances,
      ioFor: () => ({ ...f.io, directAudience: () => msg.directAudience, verifyDirectAudience: verify }),
    },
  );
  const consumer = { runId: "worker-run", requester: msg.userId, channelId: msg.channelId, threadKey, attempt: key };
  return {
    instances,
    instance,
    unit,
    context,
    key,
    request,
    io,
    verify,
    consumer,
    access: contextAccessForMessage(f.deps, { msg: request, io }),
  };
}

describe("canonical unit context access", () => {
  it("revalidates an immutable private work status independently of the adjacent raw report", async () => {
    const f = setup();
    const w = await workerFixture(f);
    const ledger = new InMemoryRunLedger();
    f.deps.runLedger.readSessionEntry = (...args) => ledger.readSessionEntry(...args);
    f.deps.config.canUseRepo = vi.fn(() => true);
    const settled: CoordinatorUnit = {
      ...w.unit,
      ending: {
        kind: "stopped",
        at: 2,
        report: "SECRET raw error",
        outcome: { schemaVersion: 1, kind: "stopped", reviewRounds: 0 },
      },
    };
    expect(await w.instances.compareAndReplaceUnit(w.unit, settled)).toEqual({ ok: true });
    const owner = {
      instanceId: w.instance.id,
      unit: w.unit.unit,
      attempt: 0,
      requester: msg.userId,
      channelId: msg.channelId,
      threadKey: w.request.threadKey,
      deliveryId: "U11/0/end",
    };
    await freezeCoordinatorReport(
      ledger,
      { ...owner, threadKey: msg.threadKey },
      { text: "SECRET raw error", threadText: "SECRET raw error" },
    );
    const ref = await appendCoordinatorStatus(
      { ledger, instances: w.instances },
      { owner, instance: w.instance, unit: settled },
    );
    expect(ref).toBeDefined();
    const read = () =>
      readOperatorTailContext({ ledger, runs: [], msg, validateDependencies: f.access.validateDependencies });
    const initial = await read();
    expect(initial.turns).toHaveLength(1);
    expect(initial.turns[0]?.text).toContain("original-act");
    expect(initial.turns[0]?.text).toContain("stopped");
    expect(JSON.stringify(initial.turns)).not.toContain("SECRET");
    expect(initial.unavailable).toHaveLength(1);
    expect(
      await w.instances.compareAndReplaceUnit(settled, {
        ...settled,
        ending: { ...settled.ending!, at: 3, report: "later private text" },
      }),
    ).toEqual({ ok: true });
    expect((await read()).turns).toEqual(initial.turns);
    expect(
      await f.access.validateDependencies({ ...clean, unitStatuses: [{ ...ref!, snapshotHash: "a".repeat(64) }] }),
    ).toMatchObject({ ok: false });
    vi.mocked(f.deps.config.canUseRepo).mockReturnValue(false);
    expect((await read()).turns).toEqual([]);
    vi.mocked(f.deps.config.canUseRepo).mockReturnValue(true);
    vi.mocked(f.io.verifyDirectAudience!).mockResolvedValue({ ok: false, code: "direct-audience-denied" });
    expect((await read()).turns).toEqual([]);
    vi.mocked(f.io.verifyDirectAudience!).mockResolvedValue({ ok: true });
    const other = contextAccessForMessage(f.deps, { msg: { ...msg, userId: "slack:UB" }, io: f.io });
    expect(await other.validateDependencies(initial.context!)).toMatchObject({ ok: false });
    vi.spyOn(w.instances, "getMainTask").mockResolvedValue(null);
    expect((await read()).turns).toEqual([]);
  });
  it("loads the persisted unit context only for its exact current binding and verified worker destination", async () => {
    const f = setup();
    const w = await workerFixture(f);
    const access = await contextAccessForRun(f.deps)({ consumer: w.consumer, msg: w.request, io: w.io });
    const binding = { instanceId: w.instance.id, unit: w.unit.unit, instanceAttempt: 0, idempotencyKey: w.key };
    const read = () => access.loadAdmission?.(binding, w.consumer);
    expect(await read()).toEqual({
      binding,
      context: w.context,
      requester: msg.userId,
      channelId: msg.channelId,
      threadKey: w.request.threadKey,
    });
    expect(await access.loadAdmission?.({ ...binding, instanceAttempt: 2 }, w.consumer)).toBeUndefined();
    expect(
      await access.loadAdmission?.({ ...binding, idempotencyKey: `${w.instance.id}:U12/0/coding` }, w.consumer),
    ).toBeUndefined();
    expect(await access.loadAdmission?.(binding, { ...w.consumer, attempt: `${w.key}/a2` })).toBeUndefined();
    expect(await access.loadAdmission?.(binding, { ...w.consumer, threadKey: msg.threadKey })).toBeUndefined();
    w.verify.mockResolvedValue({ ok: false, code: "direct-audience-denied" } as never);
    expect(await read()).toBeUndefined();
  });

  it("loads ordinary unit context without inventing a main-task or private-worker requirement", async () => {
    const f = setup();
    const w = await workerFixture(f);
    const ordinary: CoordinatorUnit & { context: UnitContext } = {
      ...w.unit,
      unit: "U12",
      workBrief: undefined,
      threadKey: msg.threadKey,
    };
    await w.instances.putUnits([ordinary]);
    const key = `${w.instance.id}:U12/0/coding`;
    const consumer = { ...w.consumer, threadKey: msg.threadKey, attempt: key };
    const access = await contextAccessForRun(f.deps)({ consumer, msg, io: f.io });
    expect(
      await access.loadAdmission?.(
        { instanceId: w.instance.id, unit: ordinary.unit, instanceAttempt: 0, idempotencyKey: key },
        consumer,
      ),
    ).toMatchObject({ context: w.context, requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey });
  });

  it("resolves worker producer visibility through its canonical DM without changing the stored origin", async () => {
    const f = setup();
    const w = await workerFixture(f);
    const workerOrigin = {
      runId: "worker-source",
      requester: msg.userId,
      channelId: msg.channelId,
      threadKey: w.request.threadKey,
    };
    f.records.set(workerOrigin.runId, {
      ...f.record,
      id: workerOrigin.runId,
      threadKey: workerOrigin.threadKey,
      parentInstanceId: w.instance.id,
      idempotencyKey: w.key,
      contextDependencies: { ...clean, origins: [workerOrigin] },
    });
    const seen: IncomingMessage[] = [];
    f.deps.slackContextForRun = (_actor, request) => {
      seen.push(request);
      if (request.threadKey.startsWith("worker:")) throw new Error("worker identity is not a Slack address");
      return { originAudience: async () => "dm" } as never;
    };
    expect(await f.access.readRunDependencies(workerOrigin.runId)).toEqual({ ...clean, origins: [workerOrigin] });
    expect(seen.every((request) => request.threadKey === msg.threadKey)).toBe(true);
    expect(await w.access.validateDependencies({ ...clean, origins: [workerOrigin] })).toEqual({ ok: true });
    vi.spyOn(w.instances, "getMainTask").mockResolvedValue(null);
    expect(await f.access.readRunDependencies(workerOrigin.runId)).toBeUndefined();
    expect(await w.access.validateDependencies(closure)).toMatchObject({ ok: false });
  });
});

describe("saved native read provenance", () => {
  it("requires the canonical completed B leaf and a fresh current-consumer source check", async () => {
    const f = setup();
    const leaf = {
      executionRunId: "choice-B",
      executionSequence: 2,
      reference: {
        version: 1 as const,
        kind: "confirmed" as const,
        sourceRunId: origin.runId,
        sourceSequence: 1,
        sourceDigest: "a".repeat(64),
        confirmationId: "saved-choice",
        intentDigest: "b".repeat(64),
      },
    };
    const context: ContextDependencies = { ...clean, version: 3, nativeMediaSources: [leaf] };
    f.records.set("choice-B", { ...f.record, id: "choice-B", contextDependencies: context });
    let allowed = true;
    const readers: string[] = [];
    f.deps.revalidateNativeMediaSource = async (_source, consumer) => {
      readers.push(consumer.actor.id);
      return allowed;
    };
    expect(await f.access.validateDependencies(context)).toEqual({ ok: true });
    expect(readers).toEqual(["slack:UA"]);
    expect(
      await f.access.validateDependencies({
        ...context,
        nativeMediaSources: [{ ...leaf, reference: { ...leaf.reference, sourceDigest: "c".repeat(64) } }],
      }),
    ).toEqual({ ok: false, code: "saved-context-unproved", check: "context_invalid" });
    allowed = false;
    expect(await f.access.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "context_invalid",
    });
    delete f.deps.revalidateNativeMediaSource;
    expect(await f.access.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "context_invalid",
    });
    expect(await f.access.validateDependencies(clean)).toEqual({ ok: true });
  });
});

describe("canonical saved operator decisions", () => {
  function pending() {
    const f = setup();
    Object.assign(f.record, {
      agent: "door",
      status: "completed",
      finishedAt: 2,
      events: [
        {
          type: "operator",
          mode: "on",
          outcome: "question",
          reason: "clarify",
          question: "Which branch?",
          request: "Check the build",
          seq: 1,
          at: 1,
        },
      ],
      operator: { mode: "on", outcome: "question", reason: "forged view", request: "untrusted projection" },
      contextDependencies: clean,
    });
    return f;
  }

  it("reads the canonical event before checking its full context and retains the original producer", async () => {
    const f = pending();
    f.originAudience.mockImplementation(async () => {
      f.record.events = [];
      return "dm";
    });
    const saved = await f.access.readOperatorDecision(origin.runId);
    expect(saved?.operator).toMatchObject({ reason: "clarify", request: "Check the build", question: "Which branch?" });
    expect(saved?.operator).not.toHaveProperty("seq");
    expect(saved?.context.origins).toEqual([origin]);
  });

  it("allows a current public reader while preserving the original requester", async () => {
    const f = pending();
    f.record.channelVisibility = "public";
    f.originAudience.mockResolvedValue("public");
    const reader = contextAccessForMessage(f.deps, {
      msg: { ...msg, userId: "slack:UB", directAudience: undefined },
      io: f.io,
    });
    const saved = await reader.readOperatorDecision(origin.runId);
    expect(saved?.operator.request).toBe("Check the build");
    expect(saved?.context.origins).toEqual([origin]);
  });

  it.each([
    "missing",
    "live",
    "wrong-thread",
    "wrong-channel",
    "non-door",
    "provisional",
    "no-event",
    "unknown",
    "revoked",
    "private-other",
    "scope-revoked",
  ])("withholds a saved decision with %s proof", async (failure) => {
    const f = pending();
    let reader = f.access;
    if (failure === "missing") f.records.clear();
    if (failure === "live") f.live.push({ runId: f.record.id, meta: f.record, state: {} } as unknown as LiveRunRow);
    if (failure === "wrong-thread") f.record.threadKey = "slack:DA:other";
    if (failure === "wrong-channel") f.record.channelId = "slack:DB";
    if (failure === "non-door") f.record.agent = "coding";
    if (failure === "provisional") f.record.provisional = true;
    if (failure === "no-event") f.record.events = [];
    if (failure === "unknown") f.record.contextDependencies = { ...clean, status: "unknown", reason: "legacy" };
    if (failure === "revoked") f.originAudience.mockResolvedValue(undefined);
    if (failure === "private-other")
      reader = contextAccessForMessage(f.deps, { msg: { ...msg, userId: "slack:UB" }, io: f.io });
    if (failure === "scope-revoked") f.record.contextDependencies = { ...clean, memoryScopes: ["user:slack:UB"] };
    expect(await reader.readOperatorDecision(origin.runId)).toBeUndefined();
  });
});

describe("message-bound context access", () => {
  it("retains source-input schema without authorizing model access before the source verifier exists", async () => {
    const f = setup();
    expect(await f.access.validateDependencies(clean)).toEqual({ ok: true });
    expect(await f.access.validateDependencies({ ...clean, version: 4, sourceInputs: [testSourceInput()] })).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "source_input_access_unproved",
    });
    expect(
      await f.access.validateDependencies({ ...clean, version: 4, sourceInputs: [testSourceInput(true)] }),
    ).toEqual({ ok: false, code: "saved-context-unproved", check: "source_input_access_unproved" });
  });

  it.each(["allowed", "foreign-owner", "github-revoked", "persistence-failed"] as const)(
    "checks the next model call against a native GitHub result's canonical proof: %s",
    async (failure) => {
      const f = setup();
      const request: IncomingMessage = {
        userId: "http:operator",
        channelId: "http:default",
        threadKey: "http:default:review",
        text: "Review the change",
      };
      const meta: LiveRunRow["meta"] = {
        agent: "review",
        readonly: true,
        profile: { machine: "repo-resident", identity: "read", minutes: 15 },
        userId: request.userId,
        channelId: request.channelId,
        threadKey: request.threadKey,
        repo: "acme/api",
        pr: 7,
        session: { key: "native-review", seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
      };
      const runId = "native-review";
      const gen = "native-generation";
      const admissionHash = (await executionAdmissionHash(meta))!;
      const receipts: SourceResultReceipt[] = [];
      let context: ContextDependencies = clean;
      const messages: ChatMessage[] = [];
      const row = { runId, ownerGen: gen, meta, state: { sourceResults: receipts } } as unknown as LiveRunRow;
      f.live.push(row);
      f.deps.runLedger.readSession = async () => ({
        complete: true,
        turns: messages.length,
        messages,
        compactions: [],
      });
      const github = new InMemoryGithubApi({ "acme/api": { private: false, files: { "README.md": "review source" } } });
      f.deps.githubApi = github;
      const mirror = new PiMirror({
        seedLength: 0,
        remainingMs: () => 60000,
        onStep: async (report) => {
          if (failure === "persistence-failed" && report.turns.some((message) => message.role === "user"))
            throw new Error("canonical persistence unavailable");
          for (const message of report.turns) messages.push(await withSourceResults(message, receipts));
        },
      });
      const args = { repo: "acme/api", path: "README.md" };
      await mirror.onMessage(
        { role: "assistant", content: [{ type: "toolCall", id: "read-source", name: "github_file", arguments: args }] },
        1,
      );
      const tool = githubReadWithContext(githubFileTool, {
        runId,
        execution: { gen, owner: async () => row },
        commit: async (receipt, dependencies) => {
          receipts.push(receipt);
          context = dependencies;
          return true;
        },
      });
      const result = await tool.run(args, {
        executor: {} as ToolContext["executor"],
        callId: "read-source",
        agentName: "review",
        repo: "acme/api",
        github: { api: github, canWrite: () => false, readableRepos: async () => [] },
      });
      expect(result).toContain("review source");
      expect(context).toMatchObject({
        version: 2,
        status: "known",
        executionGithub: [{ runId, callId: "read-source" }],
      });
      await mirror.onMessage(
        {
          role: "toolResult",
          toolCallId: "read-source",
          toolName: "github_file",
          content: [{ type: "text", text: result }],
        },
        1,
      );
      if (failure === "foreign-owner") row.ownerGen = "different-generation";
      if (failure === "github-revoked")
        github.readFile = async () => {
          throw new Error("read access revoked");
        };
      const access = contextAccessForExecution(f.deps, {
        msg: request,
        io: f.io,
        executionConsumer: { runId, gen, admissionHash },
      });
      const bearers = new RunBearerStore({ clock: () => 1 });
      const token = bearers.mint(
        {
          runId,
          modelRef: "fixture/review-model",
          providerName: "fixture",
          providerWire: "anthropic-messages",
          model: "review-model",
          maxTokens: 64,
          maxTurns: 2,
          expiresAt: 60001,
          span: createTracer({ clock: () => 1 }).start("request", { sinks: [] }),
          publish: () => {},
        },
        { sourceGuardRequired: true },
      );
      let validation: Awaited<ReturnType<typeof access.validateDependencies>> | undefined;
      bearers.bindSourceGuard(runId, async () => {
        await mirror.checkpointToolResults(1);
        return (
          await revalidateAdmittedContext(
            () => context,
            async (snapshot) => {
              validation = await access.validateDependencies(snapshot);
              return validation;
            },
          )
        ).ok;
      });
      const upstream: unknown[] = [];
      const response = await handleModelProxyRequest(
        {
          method: "POST",
          path: ANTHROPIC_MESSAGES_PATH,
          headers: { authorization: `Bearer ${token}` },
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify({
                model: "review-model",
                max_tokens: 64,
                stream: false,
                messages: [{ role: "user", content: "Continue the review" }],
              }),
            );
          })(),
        },
        {
          bearers,
          clock: () => 1,
          providers: () => ({ fixture: { type: "anthropic", apiKeyEnv: "FIXTURE_KEY" } }),
          secrets: secretsFrom({ FIXTURE_KEY: "local-fixture-only" }),
          fetch: async (_url, init) => {
            upstream.push(JSON.parse(String(init?.body)));
            return Response.json({
              id: "answer",
              type: "message",
              role: "assistant",
              model: "review-model",
              content: [{ type: "text", text: "Review continued" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          },
        },
      );
      expect(response.status).toBe(failure === "allowed" ? 200 : 403);
      if (failure === "allowed") {
        expect(validation).toEqual({ ok: true });
        expect(upstream).toEqual([
          expect.objectContaining({
            model: "review-model",
            messages: [{ role: "user", content: "Continue the review" }],
          }),
        ]);
        expect(JSON.parse(String(response.body))).toMatchObject({
          content: [{ type: "text", text: "Review continued" }],
        });
      } else {
        expect(JSON.parse(String(response.body))).toMatchObject({ error: { type: "source_unavailable" } });
        expect(upstream).toEqual([]);
        if (failure === "foreign-owner")
          expect(validation).toMatchObject({ ok: false, check: "execution_generation_mismatch" });
        if (failure === "github-revoked")
          expect(validation).toMatchObject({ ok: false, check: "execution_github_access_unproved" });
        if (failure === "persistence-failed") {
          expect(validation).toBeUndefined();
          expect(messages).toEqual([
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "read-source", name: "github_file", input: args }],
            },
          ]);
        }
      }
    },
  );
  it.each(["private", "public"])("checks source access, receipts, session and bytes (%s)", async (source) => {
    const f = setup();
    const meta: LiveRunRow["meta"] = {
      agent: "review",
      profile: { machine: "repo-resident", identity: "read", minutes: 25 },
      readonly: true,
      userId: msg.userId,
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      repo: "acme/api",
      pr: 7,
      session: { key: "session", seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
    };
    const admissionHash = (await executionAdmissionHash(meta))!;
    const sourceRepo = source === "public" ? "upstream/provider" : "acme/api";
    const input = { repo: sourceRepo, path: "src/x.ts" };
    const originalResult =
      source === "public"
        ? "https://github.com/upstream/provider/blob/main/src/x.ts (12 bytes):\n\ncurrent code"
        : "original code";
    const receipt = {
      version: 2 as const,
      runId: "review",
      callId: "read",
      tool: "github_file",
      repos: [sourceRepo],
      admissionHash,
      inputHash: await sourceHash(input),
      resultHash: await sourceHash(originalResult),
    };
    const messages: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "read", name: "github_file", input }] },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "read", content: originalResult }],
        sourceResults: [receipt],
      },
    ];
    const row = {
      runId: "review",
      ownerGen: "gen",
      meta,
      state: { sourceResults: [receipt] },
    } as unknown as LiveRunRow;
    f.live.push(row);
    const readSession = vi.fn(async () => ({ complete: true, messages }));
    f.deps.runLedger.readSession = readSession as never;
    f.deps.githubApi = new InMemoryGithubApi({
      [sourceRepo]: { private: source !== "public", files: { "src/x.ts": "current code" } },
    });
    if (source === "public") f.deps.githubApi.listRepos = async () => [];
    const execution = contextAccessForExecution(f.deps, {
      msg,
      io: f.io,
      executionConsumer: { runId: "review", gen: "gen", admissionHash },
    });
    const context: ContextDependencies = {
      ...clean,
      version: 2,
      executionGithub: [
        {
          runId: "review",
          callId: "read",
          resultHash: receipt.resultHash,
          admissionHash,
        },
      ],
    };
    let sessionReads = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      fetch: async () => {
        if (++sessionReads === 1) return Response.json({ error: "internal error" }, { status: 500 });
        return Response.json({
          rows: messages.flatMap((message, idx) => turnRows(idx, message).rows),
          attachments: [],
        });
      },
    });
    f.deps.runLedger.readSession = wire.readSession.bind(wire);
    expect(await execution.validateDependencies(context)).toEqual({ ok: true });
    f.deps.runLedger.readSession = readSession as never;
    const originalRead = f.deps.githubApi.readFile;
    f.deps.githubApi.readFile = async () => {
      throw new Error("private provider response");
    };
    expect(await execution.validateDependencies(context)).toMatchObject({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_github_access_unproved",
      githubAccess: { tool: "github_file", stage: "tool-read", operation: "readFile", reason: "unknown" },
    });
    f.deps.githubApi.readFile = originalRead;
    row.state.sourceResults = [];
    expect(await execution.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_receipt_missing",
    });
    row.state.sourceResults = [receipt];
    readSession.mockResolvedValueOnce({ complete: false, messages });
    expect(await execution.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_session_incomplete",
    });
    messages[1]!.content = [{ type: "tool_result", toolUseId: "read", content: "changed code" }];
    expect(await execution.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_call_result_unproved",
    });
  });
  it.each(["active", "finished"])(
    "validates repeated source reads within one remote-read allowance and rechecks later access (%s)",
    async (owner) => {
      const f = setup();
      const meta: LiveRunRow["meta"] = {
        agent: "review",
        profile: { machine: "repo-resident", identity: "read", minutes: 25 },
        readonly: true,
        userId: msg.userId,
        channelId: msg.channelId,
        threadKey: msg.threadKey,
        repo: "acme/api",
        pr: 7,
        session: { key: "session", seedFrom: 0, request: 0, range: { from: 0, to: 3 } },
      };
      const admissionHash = (await executionAdmissionHash(meta))!;
      const runId = owner === "active" ? "review" : origin.runId;
      const input = { repo: "acme/api", path: "src/x.ts" };
      const receipts: SourceResultReceipt[] = await Promise.all(
        ["read-1", "read-2"].map(async (callId) => ({
          version: 2 as const,
          runId,
          callId,
          tool: "github_file",
          repos: ["acme/api"],
          admissionHash,
          inputHash: await sourceHash(input),
          resultHash: await sourceHash("original source"),
        })),
      );
      const messages: ChatMessage[] = receipts.flatMap((receipt) => [
        {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: receipt.callId, name: receipt.tool, input }],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolUseId: receipt.callId, content: "original source" }],
          sourceResults: [receipt],
        },
      ]);
      const context: ContextDependencies = {
        ...clean,
        version: 2,
        executionGithub: receipts.map((receipt) => ({
          runId,
          callId: receipt.callId,
          resultHash: receipt.resultHash,
          admissionHash,
        })),
      };
      if (owner === "active") {
        f.live.push({
          runId,
          threadKey: msg.threadKey,
          ownerGen: "gen",
          leaseUntil: 1_000,
          startedAt: 0,
          phase: "live",
          stop: null,
          meta,
          card: null,
          system: "",
          tools: [],
          state: { sourceResults: receipts },
        });
      } else {
        Object.assign(f.record, {
          agent: "review",
          status: "completed",
          runtimeShutdownConfirmed: true,
          contextDependencies: context,
          session: meta.session,
        });
      }
      f.deps.runLedger.readSession = async () => ({ complete: true, messages, turns: 4, compactions: [] });
      const github = new InMemoryGithubApi({ "acme/api": { private: true, files: { "src/x.ts": "current source" } } });
      const originalRead = github.readFile.bind(github);
      let readsRemaining = 1;
      github.readFile = async (...args) => {
        if (readsRemaining-- <= 0) throw new GithubApiError(429, "remote read allowance exhausted");
        return originalRead(...args);
      };
      f.deps.githubApi = github;
      f.deps.config.canUseRepo = () => true;
      const access =
        owner === "active"
          ? contextAccessForExecution(f.deps, {
              msg,
              io: f.io,
              executionConsumer: { runId, gen: "gen", admissionHash },
            })
          : f.access;
      expect(await access.validateDependencies(context)).toEqual({ ok: true });

      github.readFile = async () => {
        throw new GithubApiError(403, "access revoked");
      };
      expect(await access.validateDependencies(context)).toMatchObject({
        ok: false,
        check: "execution_github_access_unproved",
        githubAccess: { operation: "readFile", stage: "tool-read" },
      });

      github.readFile = originalRead;
      messages[3]!.content = [{ type: "tool_result", toolUseId: "read-2", content: "altered source" }];
      expect(await access.validateDependencies(context)).toMatchObject({
        ok: false,
        check: "execution_call_result_unproved",
      });
    },
  );
  it("reuses a finished review's verified GitHub evidence under current read access", async () => {
    const f = setup();
    const input = { repo: "acme/api", path: "src/x.ts" };
    const result = "earlier source";
    const receipt: SourceResultReceipt = {
      version: 2,
      runId: origin.runId,
      callId: "earlier-read",
      tool: "github_file",
      repos: ["acme/api"],
      resultHash: await sourceHash(result),
      inputHash: await sourceHash(input),
      admissionHash: "a".repeat(64),
    };
    const context: ContextDependencies = {
      ...clean,
      version: 2,
      executionGithub: [
        {
          runId: origin.runId,
          callId: receipt.callId,
          resultHash: receipt.resultHash,
          admissionHash: receipt.admissionHash!,
        },
      ],
    };
    Object.assign(f.record, {
      agent: "review",
      status: "completed",
      runtimeShutdownConfirmed: true,
      contextDependencies: context,
      session: { key: "earlier-session", seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
    });
    const messages: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: receipt.callId, name: receipt.tool, input }] },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: receipt.callId, content: result }],
        sourceResults: [receipt],
      },
    ];
    f.deps.runLedger.readSession = async () => ({ complete: true, messages, turns: messages.length, compactions: [] });
    const github = new InMemoryGithubApi({ "acme/api": { private: true, files: { "src/x.ts": "current source" } } });
    f.deps.githubApi = github;
    f.deps.config.canUseRepo = () => true;
    expect(await f.access.validateDependencies(context)).toEqual({ ok: true });
    const media = {
      executionRunId: origin.runId,
      executionSequence: 1,
      reference: {
        version: 1 as const,
        kind: "original" as const,
        sourceRunId: origin.runId,
        sourceSequence: 1,
        sourceDigest: "b".repeat(64),
        intentDigest: "c".repeat(64),
      },
    };
    const mixed: ContextDependencies = { ...context, version: 3, nativeMediaSources: [media] };
    f.record.contextDependencies = mixed;
    let mediaReadable = true;
    const mediaReaders: string[] = [];
    f.deps.revalidateNativeMediaSource = async (_source, consumer) => {
      mediaReaders.push(consumer.actor.id);
      return mediaReadable;
    };
    expect(await f.access.validateDependencies(mixed)).toEqual({ ok: true });
    expect(mediaReaders).toEqual(["slack:UA"]);
    mediaReadable = false;
    expect(await f.access.validateDependencies(mixed)).toMatchObject({ ok: false, check: "context_invalid" });
    expect(await f.access.validateDependencies({ ...mixed, version: 4, sourceInputs: [testSourceInput()] })).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "source_input_access_unproved",
    });
    f.record.contextDependencies = context;
    f.record.status = "interrupted";
    expect(await f.access.validateDependencies(context)).toMatchObject({ ok: false, check: "execution_owner_changed" });
    f.record.status = "completed";
    f.record.provisional = true;
    expect(await f.access.validateDependencies(context)).toMatchObject({ ok: false, check: "execution_owner_changed" });
    delete f.record.provisional;
    f.record.restarting = true;
    expect(await f.access.validateDependencies(context)).toMatchObject({ ok: false, check: "execution_owner_changed" });
    delete f.record.restarting;
    const session = f.record.session!;
    f.record.session = { ...session, range: { from: 0 } };
    expect(await f.access.validateDependencies(context)).toMatchObject({
      ok: false,
      check: "execution_session_incomplete",
    });
    f.record.session = session;
    f.live.push({ runId: origin.runId } as LiveRunRow);
    expect(await f.access.validateDependencies(context)).toMatchObject({
      ok: false,
      check: "execution_receipt_owner_mismatch",
    });
    f.live.pop();
    f.record.contextDependencies = clean;
    expect(await f.access.validateDependencies(context)).toMatchObject({
      ok: false,
      check: "execution_receipt_missing",
    });
    f.record.contextDependencies = context;
    f.deps.config.canUseRepo = () => false;
    expect(await f.access.validateDependencies(context)).toMatchObject({
      ok: false,
      check: "github_repository_unproved",
    });
    f.deps.config.canUseRepo = () => true;
    messages[1]!.content = [{ type: "tool_result", toolUseId: receipt.callId, content: "altered source" }];
    expect(await f.access.validateDependencies(context)).toMatchObject({
      ok: false,
      check: "execution_call_result_unproved",
    });
    messages[1]!.content = [{ type: "tool_result", toolUseId: receipt.callId, content: result }];
    github.readFile = async () => {
      throw new Error("access revoked");
    };
    expect(await f.access.validateDependencies(context)).toMatchObject({
      ok: false,
      check: "execution_github_access_unproved",
    });
  });
  it("distinguishes a missing historical source from a missing live owner", async () => {
    const f = setup();
    const context: ContextDependencies = {
      ...clean,
      version: 2,
      executionGithub: [
        {
          runId: "review",
          callId: "read",
          resultHash: "a".repeat(64),
          admissionHash: "b".repeat(64),
        },
      ],
    };
    expect(await f.access.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "origin_record_missing",
    });
    const execution = contextAccessForExecution(f.deps, {
      msg,
      io: f.io,
      executionConsumer: { runId: "review", gen: "gen", admissionHash: "b".repeat(64) },
    });
    expect(await execution.validateDependencies(context)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_owner_missing",
    });
    expect(await execution.validateDependencies(clean)).toEqual({ ok: true });
  });
  it("checks the current destination before reusing a public source", async () => {
    const f = setup();
    const source = { ...origin, channelId: "slack:C_INTERNAL", threadKey: "slack:C_INTERNAL:1" };
    Object.assign(f.record, { channelId: source.channelId, threadKey: source.threadKey, channelVisibility: "public" });
    f.record.contextDependencies = { ...clean, origins: [source] };
    f.deps.slackContextForRun = (_actor, request) =>
      ({
        originAudience: async () => "public",
        canReadSource: async () => request.channelId !== "slack:C_SHARED",
      }) as never;
    expect(await f.access.readRunDependencies(source.runId)).toEqual({ ...clean, origins: [source] });
    const destination = contextAccessForMessage(f.deps, {
      msg: { ...msg, channelId: "slack:C_SHARED", threadKey: "slack:C_SHARED:2", directAudience: undefined },
      io: f.io,
    });
    expect(await destination.validateDependencies({ ...clean, origins: [source] })).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "origin_destination_unproved",
    });
    expect(await destination.readRunDependencies(source.runId)).toBeUndefined();
  });
  it("normalizes retained identity aliases before access without erasing mismatched checkpoint hashes or external leaves", async () => {
    const f = setup();
    const source: CanonicalCheckpointSource = {
      runId: origin.runId,
      meta: {
        userId: msg.userId,
        channelId: msg.channelId,
        threadKey: msg.threadKey,
        channelVisibility: "dm",
        session: { key: "saved", seedFrom: 0, request: 0, range: { from: 0, to: 0 } },
      },
      context: closure,
    };
    const seal = async (run: CanonicalCheckpointSource, sources: CanonicalCheckpointSource[]) => {
      const inputs = {
        transcriptHash: await sourceHash(run.runId),
        systemHash: await sourceHash("system"),
        notepadHash: await sourceHash("notes"),
      };
      const receipt = (await planContextCheckpoint({
        run,
        ownerGen: "gen",
        through: run.meta.session!.seedFrom,
        inputs,
        expected: { beforeHash: await contextDependenciesHash(run.context), revision: run.context.revision, inputs },
        sources,
      }))!;
      expect(receipt).toBeDefined();
      return {
        ...run,
        receipt,
        context: receipt.normalized,
        transcriptHash: inputs.transcriptHash,
        members: checkpointMembersOf(run.runId, receipt.coveredOrigins, sources),
        memberCheckpoints: checkpointMemberHashesOf(run.runId, receipt.coveredOrigins, sources),
      };
    };
    const first = await seal(source, []);
    const latest = await seal(
      {
        ...source,
        runId: "latest",
        meta: { ...source.meta, session: { key: "saved", seedFrom: 1, request: 1, range: { from: 1, to: 1 } } },
        context: { ...first.context, origins: [...first.context.origins, { ...origin, runId: "latest" }] },
      },
      [first],
    );
    f.records.clear();
    f.records.set("latest", { ...f.record, id: "latest", contextDependencies: latest.context });
    Object.assign(f.deps.runLedger, {
      readContextCheckpoint: async (id: string) => (id === "latest" ? latest : undefined),
    });
    const get = vi.spyOn(f.deps.runStore, "get");
    const repeated = await f.access.normalizeDependencies(
      Array.from({ length: 128 }, () => first.context),
      [latest.context],
    );
    expect(repeated.every((context) => context.origins[0]?.runId === "latest")).toBe(true);
    expect(get.mock.calls.every(([id]) => id === "latest")).toBe(true);
    get.mockClear();
    const external = { ...first.context, memoryScopes: ["user:slack:UB"] };
    const forged = { ...first.context, origins: [{ ...origin, checkpoint: "f".repeat(64) }] };
    const normalized = await f.access.normalizeDependencies(
      [closure, first.context, forged, external],
      [latest.context],
    );
    expect(normalized[0]!.origins).toEqual(latest.context.origins);
    expect(normalized[1]!.origins).toEqual(latest.context.origins);
    expect(normalized[2]).toEqual(forged);
    expect(normalized[3]!.memoryScopes).toEqual(external.memoryScopes);
    expect(await f.access.validateDependencies(normalized[0]!)).toEqual({ ok: true });
    expect(await f.access.validateDependencies(normalized[2]!)).toMatchObject({ ok: false });
    expect(await f.access.validateDependencies(normalized[3]!)).toMatchObject({ ok: false });
    let bounded = latest;
    for (let turn = 2; turn <= 130; turn++) {
      const runId = `retained-${turn}`;
      bounded = await seal(
        {
          ...source,
          runId,
          meta: {
            ...source.meta,
            session: { key: "saved", seedFrom: turn, request: turn, range: { from: turn, to: turn } },
          },
          context: { ...bounded.context, origins: [...bounded.context.origins, { ...origin, runId }] },
        },
        [bounded],
      );
    }
    f.records.set(origin.runId, f.record);
    f.records.set(bounded.runId, { ...f.record, id: bounded.runId, contextDependencies: bounded.context });
    Object.assign(f.deps.runLedger, {
      readContextCheckpoint: async (id: string) =>
        id === bounded.runId ? bounded : id === origin.runId ? first : undefined,
    });
    expect(await f.access.validateDependencies(first.context)).toEqual({ ok: true });
    const expired = await f.access.normalizeDependencies([first.context, closure], [bounded.context]);
    expect(expired.map((context) => context.status)).toEqual(["unknown", "unknown"]);
    f.originAudience.mockResolvedValue(undefined);
    expect(await f.access.normalizeDependencies([closure], [latest.context])).toEqual([closure]);
  });
  it("requires a committed canonical checkpoint with unchanged seed proof before accepting its marker", async () => {
    const f = setup();
    const source: CanonicalCheckpointSource = {
      runId: origin.runId,
      meta: {
        userId: msg.userId,
        channelId: msg.channelId,
        threadKey: msg.threadKey,
        channelVisibility: "dm",
        session: { key: "saved", seedFrom: 0, request: 0, range: { from: 0, to: 0 } },
      },
      context: { ...closure, memoryScopes: ["user:slack:UA"] },
    };
    const inputs = {
      transcriptHash: await sourceHash("seed"),
      systemHash: await sourceHash("system"),
      notepadHash: await sourceHash("notes"),
    };
    const receipt = (await planContextCheckpoint({
      run: source,
      ownerGen: "gen",
      through: 0,
      inputs,
      expected: {
        beforeHash: await contextDependenciesHash(source.context),
        revision: source.context.revision,
        inputs,
      },
      sources: [],
    }))!;
    const committed = {
      ...source,
      receipt,
      context: receipt.normalized,
      transcriptHash: inputs.transcriptHash,
      members: [origin.runId],
    };
    const readContextCheckpoint = vi.fn(async () => committed as CanonicalCheckpointSource | undefined);
    Object.assign(f.deps.runLedger, { readContextCheckpoint });
    expect(await f.access.validateDependencies(receipt.normalized)).toEqual({ ok: true });
    const normalized = await f.access.normalizeDependencies([closure], [receipt.normalized]);
    expect(normalized[0]?.origins).toEqual(receipt.normalized.origins);
    expect(normalized[0]?.memoryScopes).toBeUndefined();
    expect(await f.access.validateDependencies(normalized[0]!)).toEqual({ ok: true });
    readContextCheckpoint.mockResolvedValue({ ...committed, transcriptHash: "a".repeat(64) });
    expect(await f.access.validateDependencies(receipt.normalized)).toMatchObject({ ok: false });
    readContextCheckpoint.mockResolvedValue(undefined);
    expect(await f.access.validateDependencies(receipt.normalized)).toMatchObject({ ok: false });
    readContextCheckpoint.mockResolvedValue(committed);
    vi.mocked(f.io.verifyDirectAudience!).mockResolvedValue({ ok: false, code: "direct-audience-denied" });
    expect(await f.access.validateDependencies(receipt.normalized)).toMatchObject({ ok: false });
  });
  it("retains a memory scope's own access after its text came from a public producer", async () => {
    const f = setup();
    f.originAudience.mockResolvedValue("public");
    const scoped = { ...closure, memoryScopes: ["user:slack:UA"] };
    expect(await f.access.validateDependencies(scoped)).toEqual({ ok: true });
    const other = contextAccessForMessage(f.deps, { msg: { ...msg, userId: "slack:UB" }, io: f.io });
    expect(await other.validateDependencies(scoped)).toMatchObject({ ok: false });
    expect(await other.validateDependencies(memoryScopeDependencies(["org:acme", `channel:${msg.channelId}`]))).toEqual(
      { ok: true },
    );
  });

  it("rechecks original repository access without requiring the current catalog or README to be unchanged", async () => {
    const f = setup();
    const github = new InMemoryGithubApi({ "acme/first": { private: false }, "acme/new": { private: false } });
    const original = await github.listRepos();
    const list = vi.spyOn(github, "listRepos");
    f.deps.githubApi = github;
    f.deps.config.canUseRepo = vi.fn(() => true);
    const context = githubRepositoryDependencies(["acme/first"]);
    expect(await f.access.validateDependencies(context)).toEqual({ ok: true });
    list.mockResolvedValue(
      original.map((repo) =>
        repo.fullName === "acme/first" ? { ...repo, description: "Changed documentation" } : repo,
      ),
    );
    expect(await f.access.validateDependencies(context)).toEqual({ ok: true });
    list.mockResolvedValue(original.map((repo) => ({ ...repo, private: true })));
    expect(await f.access.validateDependencies(context)).toMatchObject({ ok: false });
    list.mockResolvedValue(original);
    vi.mocked(f.deps.config.canUseRepo).mockReturnValue(false);
    expect(await f.access.validateDependencies(context)).toMatchObject({ ok: false });
  });

  it("captures the latest live session envelope after bytes instead of trusting a stale state flush", async () => {
    const f = setup();
    f.live.push({
      runId: origin.runId,
      meta: { ...f.record, session: { key: "working" } },
      state: { contextDependencies: closure },
    } as unknown as LiveRunRow);
    const tail = vi.mocked(f.deps.runLedger.readSessionTail);
    tail.mockResolvedValue({
      sources: { version: 1, status: "unknown", context: { ...closure, status: "revoked" } },
    } as never);
    expect(await f.access.readRunDependencies(origin.runId)).toBeUndefined();
    expect(tail).toHaveBeenCalledWith("working", 1);
    tail.mockResolvedValue({ sources: { version: 1, status: "unknown", context: closure } } as never);
    expect(await f.access.readRunDependencies(origin.runId)).toEqual(closure);
  });

  it("admits a public original producer for a different current reader without changing original identity", async () => {
    const f = setup();
    f.record.userId = "slack:UB";
    const publicOrigin = { ...origin, requester: "slack:UB" };
    f.originAudience.mockResolvedValue("public");
    expect(await f.access.canReadOrigin(publicOrigin)).toBe(true);
    expect(await f.access.canReadOrigin(origin)).toBe(false);
    f.originAudience.mockResolvedValue("private");
    expect(await f.access.canReadOrigin(publicOrigin)).toBe(false);
  });

  it("reads canonical retained closures and never substitutes a later shared session for missing proof", async () => {
    const f = setup();
    expect(await f.access.readRunDependencies(origin.runId)).toEqual(closure);
    expect(await f.access.canReadOrigin({ ...origin, threadKey: "slack:DA:other" })).toBe(false);
    delete f.record.contextDependencies;
    expect(await f.access.readRunDependencies(origin.runId)).toBeUndefined();
    expect(f.deps.runLedger.readSessionTail).not.toHaveBeenCalled();
    f.record.contextDependencies = closure;
    f.originAudience.mockResolvedValue(undefined as never);
    expect(await f.access.readRunDependencies(origin.runId)).toBeUndefined();
  });

  it.each(["direct", "worker", "worker-source"] as const)(
    "freshly inspects retained original source actions without executing or rewriting them (%s)",
    async (destination) => {
      const f = setup();
      const worker = destination !== "direct" ? await workerFixture(f) : undefined;
      const access = destination === "worker" ? worker!.access : f.access;
      if (destination === "worker-source") {
        f.record.threadKey = worker!.request.threadKey;
        f.record.parentInstanceId = worker!.instance.id;
        f.record.idempotencyKey = worker!.key;
      }
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:01:00Z"));
      let state: SourceReadState | undefined;
      const operation: SourceReadOperation = {
        toolName: "mcp__metrics__readFailures",
        serverId: "user:slack:UA/metrics",
        connectionRevision: "original-generation",
        contract: sourceReadContract(readTool)!,
        session: async () => "session-original",
        current: vi.fn(async () => true),
        call: vi.fn(async (request, session) => ({
          content: [],
          structuredContent: readResponse(request.actionId as string, session),
        })),
      };
      const owner = {
        runId: origin.runId,
        requester: msg.userId,
        channelId: msg.channelId,
        threadKey: f.record.threadKey,
        agent: "coding",
      };
      const reads = createSourceReads({
        owner,
        operations: [operation],
        save: async (value) => {
          state = structuredClone(value);
          return true;
        },
        now: () => Date.parse("2030-01-01T00:01:00Z"),
        audience: async () => true,
        canRecover: true,
      });
      await reads.run(operation.toolName, readQuery, "call-1");
      f.record.sourceReads = state;
      const action = state!.records[0];
      const dependencies = {
        ...closure,
        origins: [{ ...origin, threadKey: owner.threadKey }],
        mcp: [
          {
            runId: origin.runId,
            actionId: action.actionId,
            callIds: ["call-1"],
            responseHash: await sourceHash(action.response),
          },
        ],
      };
      vi.mocked(f.deps.mcp.toolsFor).mockResolvedValue({ tools: [{ sourceRead: operation }] } as never);
      const before = JSON.stringify(state);
      expect(await access.validateDependencies(dependencies)).toEqual({ ok: true });
      expect(vi.mocked(operation.call).mock.calls.map(([request]) => request.action)).toEqual(["execute", "inspect"]);
      expect(vi.mocked(operation.call).mock.calls[1].slice(0, 2)).toEqual([
        { version: 1, action: "inspect", actionId: action.actionId, operationRevision: "1", ...readQuery },
        "session-original",
      ]);
      expect(JSON.stringify(state)).toBe(before);
      if (worker) {
        expect(f.deps.mcp.toolsFor).toHaveBeenCalledWith(owner.agent, {
          userId: msg.userId,
          channelId: msg.channelId,
          directAudience: msg.directAudience,
        });
        expect(worker.request.directAudience).toBeUndefined();
        expect(state!.owner.threadKey).toBe(owner.threadKey);
        if (destination === "worker") {
          expect(worker.verify).toHaveBeenCalled();
          worker.verify.mockResolvedValue({ ok: false, code: "direct-audience-denied" } as never);
          expect(await access.validateDependencies(dependencies)).toMatchObject({ ok: false });
          expect(operation.call).toHaveBeenCalledTimes(2);
          worker.verify.mockResolvedValue({ ok: true });
        }
      }
      f.record.sourceReads = { ...state!, owner: { ...state!.owner, requester: "slack:UB" } };
      expect(await access.validateDependencies(dependencies)).toMatchObject({ ok: false });
      expect(operation.call).toHaveBeenCalledTimes(2);
      f.record.sourceReads = state;
      vi.mocked(operation.current).mockResolvedValue(false);
      expect(await access.validateDependencies(dependencies)).toMatchObject({ ok: false });
      const foreign = contextAccessForMessage(f.deps, { msg: { ...msg, userId: "slack:UB" }, io: f.io });
      expect(await foreign.validateDependencies(dependencies)).toMatchObject({ ok: false });
      expect(operation.call).toHaveBeenCalledTimes(2);
    },
  );

  it("requires memory to retain its actual producer closure and immutable contents", async () => {
    const f = setup();
    const store = new InMemoryMemoryStore([], { now: () => 1 });
    const input = {
      kind: "fact" as const,
      text: "Remember this result",
      sourceRunId: origin.runId,
      sourceThreadKey: origin.threadKey,
    };
    await store.write("user:slack:UA", [await sealMemoryCandidate("user:slack:UA", input, closure)]);
    const candidate = (await store.list("user:slack:UA", 10))[0];
    expect(await f.access.authorizeMemory(candidate)).toEqual({ ok: true });
    f.record.contextDependencies = { ...closure, githubRepos: ["acme/original"] };
    f.deps.githubApi = new InMemoryGithubApi({ "acme/original": { private: false } });
    f.deps.config.canUseRepo = vi.fn(() => true);
    expect(await f.access.authorizeMemory(candidate)).toMatchObject({ ok: false });
    const withRepo = await sealMemoryCandidate("user:slack:UA", input, f.record.contextDependencies);
    expect(await f.access.authorizeMemory({ ...candidate, ...withRepo })).toEqual({ ok: true });
    f.record.contextDependencies = closure;
    expect(await f.access.authorizeMemory({ ...candidate, text: "modified" })).toMatchObject({ ok: false });
    const empty = await sealMemoryCandidate("user:slack:UA", input, clean);
    expect(await f.access.authorizeMemory({ ...candidate, ...empty })).toMatchObject({ ok: false });
    expect(await f.access.authorizeMemory({ ...candidate, sourceThreadKey: "another" })).toMatchObject({ ok: false });
  });

  it("pages live artifact events through the greatest frozen cursor and excludes later events", async () => {
    const f = setup();
    f.live.push({
      runId: origin.runId,
      meta: { ...f.record },
      state: { contextDependencies: closure },
    } as unknown as LiveRunRow);
    const artifact = (seq: number) => ({
      type: "artifact",
      seq,
      key: `artifact-${seq}`,
      name: `file-${seq}`,
      size: 1,
      contentType: "text/plain",
      direction: "out",
    });
    f.getRunEvents
      .mockResolvedValueOnce({ ok: true, value: { events: [artifact(1)], nextAfterSeq: 1 } })
      .mockResolvedValueOnce({ ok: true, value: { events: [artifact(2), artifact(3), artifact(4)], nextAfterSeq: 4 } });
    const access = await contextAccessForRun(f.deps)({
      consumer: {
        runId: "child",
        attempt: "attempt-1",
        requester: msg.userId,
        channelId: msg.channelId,
        threadKey: msg.threadKey,
      },
      msg,
      io: f.io,
    });
    const source = {
      source: origin,
      assets: [],
      assetRuns: [
        { runId: origin.runId, throughSeq: 3 },
        { runId: origin.runId, throughSeq: 1 },
      ],
    } as unknown as HandoffSource;
    expect((await access.readAssets(source)).map((a) => a.seq)).toEqual([1, 2, 3]);
    expect(f.getRunEvents).toHaveBeenCalledTimes(2);
    expect(f.getRunEvents.mock.calls[1][1].afterSeq).toBe(1);
    for (const assetRuns of [
      [{ runId: origin.runId }],
      [{ runId: origin.runId, throughSeq: "3" }],
      [{ runId: origin.runId, throughSeq: -1 }],
    ]) {
      await expect(access.readAssets({ ...source, assetRuns } as unknown as HandoffSource)).rejects.toThrow(
        "live artifact source has no frozen cursor",
      );
    }
    expect(f.getRunEvents).toHaveBeenCalledTimes(2);
  });
});
