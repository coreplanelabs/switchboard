import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../core/authz/types.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { createPlaneService } from "../core/planeService.js";
import type { PlaneService } from "../core/planeService.js";
import {
  createMainWorkEffectGate,
  mainWorkForRun,
  workStatusTool,
  workSteerTool,
  workStopTool,
  type MainWorkCapability,
} from "./mainWork.js";
import type { ToolContext } from "./runnableTool.js";
import {
  isMainWorkReadReceipt,
  type MainWorkRead,
  type MainWorkReadObserver,
} from "../core/coordinator/mainWorkObservation.js";
import { sourceHash } from "../core/references/receipts.js";

const THREAD = "slack:DMAIN:1.0";
const ACT = "fix-signup";
const INSTANCE: CoordinatorInstance = {
  id: "ship_signup_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:DMAIN",
  threadKey: THREAD,
  repo: "acme/api",
  branch: "ship/signup",
  base: "main",
  plan: { id: "signup" },
  merge: "person",
  createdAt: 1_000,
  runId: "run-parent",
};
const UNIT: CoordinatorUnit = {
  instanceId: INSTANCE.id,
  unit: "task",
  slug: "signup",
  branch: INSTANCE.branch,
  dependsOn: [],
  rounds: [],
  workBrief: {
    requesterId: INSTANCE.userId,
    mainThreadKey: THREAD,
    actId: ACT,
    repo: INSTANCE.repo,
    base: INSTANCE.base!,
    question: "How many users failed to sign up?",
    findings: [
      {
        kind: "analysis",
        text: "12 failures",
        query: "count failed signups",
        result: "12",
        timeWindow: "last day",
        sourceUrl: "https://example.com/signups",
      },
    ],
    requestedChange: "Fix signups",
  },
};

function requester(over: Partial<Actor> = {}): Actor {
  return {
    kind: "user",
    id: INSTANCE.userId,
    origin: { channelId: INSTANCE.channelId, threadKey: THREAD },
    grants: { actions: new Set(["steer:write"]), channels: new Set([INSTANCE.channelId]), repos: "all" },
    ...over,
  };
}

async function fixture(over: Partial<CoordinatorUnit> = {}) {
  const instances = new InMemoryCoordinatorInstanceStore(new InMemoryRunLedger());
  await instances.recordRequesterTurn({ threadKey: THREAD, requesterId: INSTANCE.userId, messageId: "1" });
  expect(
    await instances.claimMainTask({ mainThreadKey: THREAD, actId: ACT }, INSTANCE, UNIT, {
      requesterId: INSTANCE.userId,
      sourceMessageId: "1",
      revision: 1,
      repo: INSTANCE.repo,
    }),
  ).toMatchObject({
    ok: true,
    created: true,
  });
  if (Object.keys(over).length) await instances.putUnits([{ ...UNIT, ...over }]);
  const sent: string[] = [];
  const workflow = {
    get: async (id: string) => ({
      sendEvent: async () => {
        sent.push(id);
      },
    }),
  };
  const stop = vi.fn<PlaneService["stop"]>(async (id) => ({
    kind: "stopped",
    instanceId: id,
    runnerStopped: true,
    stopsSucceeded: true,
    children: [],
  }));
  const plane = async () => ({ stop }) as Pick<PlaneService, "stop">;
  const bind = (
    actor: Actor = requester(),
    runId = "run-main-1",
    message: Parameters<typeof mainWorkForRun>[0]["message"] = {
      channelId: INSTANCE.channelId,
      threadKey: THREAD,
      userId: INSTANCE.userId,
    },
    trusted = () => true,
    verify = async () => true,
    loadPlane: typeof plane = plane,
    effectGate = createMainWorkEffectGate(),
    observeRead?: MainWorkReadObserver,
    readTrusted?: () => boolean,
  ) =>
    mainWorkForRun({
      agentName: "orchestrator",
      actor,
      message: {
        ...message,
        directAudience: {
          kind: "slack-unshared-im" as const,
          channelId: message.channelId,
          threadKey: message.threadKey,
          userId: message.userId,
        },
      },
      channelVisibility: "dm",
      runId,
      instances,
      workflow,
      plane: loadPlane,
      clock: () => 2_000,
      effectGate,
      trusted,
      verifiedAtOpen: true,
      verify,
      observeRead,
      readTrusted,
    });
  const context = (capability: MainWorkCapability | null = bind() ?? null, callId = "tool-call-1"): ToolContext => ({
    executor: {} as ToolContext["executor"],
    ...(capability ? { mainWork: capability } : {}),
    callId,
  });
  return { instances, sent, stop, bind, context };
}

describe("main work tools", () => {
  it("restores a current authorized status without restoring mutation authority", async () => {
    const { bind, instances, context, sent, stop } = await fixture({ startedAt: 1_100 });
    const reads: MainWorkRead[] = [];
    const original = bind(undefined, undefined, undefined, undefined, undefined, undefined, undefined, (read) => {
      reads.push(read);
    });
    await workStatusTool.run({ actId: ACT }, context(original, "saved-status"));
    const { refresh: _refresh, content: _content, ...receipt } = reads[0]!;
    let sourceTrusted = true;
    let audience = true;
    const resumed = bind(
      requester(),
      "resumed-run",
      undefined,
      () => false,
      async () => audience,
      undefined,
      undefined,
      undefined,
      () => sourceTrusted,
    )!;
    const refresh = resumed.restoreRead!(JSON.parse(JSON.stringify(receipt)))!;
    await instances.putUnits([
      { ...UNIT, startedAt: 1_100, ending: { kind: "aborted", report: "Stopped", at: 1_900 } },
    ]);
    expect(await refresh()).toMatchObject({ kind: "changed", content: expect.stringContaining('"state":"ended"') });
    expect(await resumed.steer(ACT, "Change the work", "resumed-steer")).toEqual({ kind: "unavailable" });
    expect(await resumed.stop(ACT)).toEqual({ kind: "unavailable" });
    expect(sent).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
    sourceTrusted = false;
    expect(await refresh()).toEqual({ kind: "unavailable" });
    sourceTrusted = true;
    audience = false;
    expect(await refresh()).toEqual({ kind: "unavailable" });
    expect(
      bind(
        requester({ id: "slack:UBOB" }),
        "foreign-run",
        undefined,
        () => false,
        async () => true,
        undefined,
        undefined,
        undefined,
        () => true,
      ),
    ).toBeUndefined();
    expect(
      bind(
        requester(),
        "app-run",
        { channelId: INSTANCE.channelId, threadKey: THREAD, userId: INSTANCE.userId, postedBy: "slack:bot:B1" },
        () => false,
        async () => true,
        undefined,
        undefined,
        undefined,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("records exact status bytes and refreshes the canonical ending after completion", async () => {
    const { bind, instances, context } = await fixture({ startedAt: 1_100 });
    const reads: MainWorkRead[] = [];
    let audience = true;
    const capability = bind(
      requester(),
      "run-status",
      undefined,
      () => true,
      async () => audience,
      undefined,
      undefined,
      (read) => {
        reads.push(read);
      },
    );
    const content = await workStatusTool.run({ actId: ACT }, context(capability, "status-call"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      tool: "work_status",
      callId: "status-call",
      input: { actId: ACT },
      content,
      resultHash: await sourceHash(content),
    });
    expect(JSON.parse(content as string)).toMatchObject({ state: "running", asOf: { observedAt: 2_000 } });
    const { refresh: _refresh, content: _content, ...receipt } = reads[0]!;
    expect(isMainWorkReadReceipt(receipt)).toBe(true);
    const restarted = bind(
      requester(),
      "new-run",
      undefined,
      () => true,
      async () => audience,
    )!.restoreRead!(JSON.parse(JSON.stringify(receipt)))!;
    expect(await restarted()).toEqual({ kind: "unchanged" });
    await instances.putUnits([
      { ...UNIT, startedAt: 1_100, ending: { kind: "aborted", report: "Stopped", at: 1_900 } },
    ]);
    const changed = await restarted();
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "changed") throw new Error("Expected a changed canonical observation");
    expect(JSON.parse(changed.content)).toMatchObject({ state: "ended", ending: { kind: "aborted" } });
    expect(changed.resultHash).toBe(await sourceHash(changed.content));
    expect(await restarted()).toEqual({ kind: "unchanged" });
    audience = false;
    expect(await restarted()).toEqual({ kind: "unavailable" });
    expect(
      capability!.restoreRead!({ ...receipt, observation: { ...receipt.observation, requesterId: "slack:UBOB" } }),
    ).toBeUndefined();
  });

  it("waits for the observation storage acknowledgement before exposing the status", async () => {
    const { bind, context } = await fixture();
    let acknowledge!: () => void;
    let observing!: () => void;
    const started = new Promise<void>((resolve) => {
      observing = resolve;
    });
    const stored = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const capability = bind(undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => {
      observing();
      await stored;
    });
    let exposed = false;
    const reading = Promise.resolve(workStatusTool.run({ actId: ACT }, context(capability))).then((value) => {
      exposed = true;
      return value;
    });
    await started;
    expect(exposed).toBe(false);
    acknowledge();
    expect(await reading).toContain("asOf");
  });

  it("a delayed unit lookup cannot steer after authority is revoked", async () => {
    const { bind, instances, sent } = await fixture();
    let trusted = true;
    let lookupStarted!: () => void;
    let releaseLookup!: () => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));
    const held = new Promise<void>((resolve) => (releaseLookup = resolve));
    const getMainTask = instances.getMainTask.bind(instances);
    vi.spyOn(instances, "getMainTask").mockImplementation(async (key) => {
      lookupStarted();
      await held;
      return getMainTask(key);
    });
    const capability = bind(requester(), "run-steer-lookup", undefined, () => trusted);
    const steering = capability!.steer(ACT, "Stop this work", "call-after-lookup");
    await started;
    trusted = false;
    releaseLookup();
    expect(await steering).toEqual({ kind: "unavailable" });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: UNIT.unit })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("a delayed unit lookup cannot stop after authority is revoked", async () => {
    const { bind, instances, stop } = await fixture();
    let trusted = true;
    let lookupStarted!: () => void;
    let releaseLookup!: () => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));
    const held = new Promise<void>((resolve) => (releaseLookup = resolve));
    const getMainTask = instances.getMainTask.bind(instances);
    vi.spyOn(instances, "getMainTask").mockImplementation(async (key) => {
      lookupStarted();
      await held;
      return getMainTask(key);
    });
    const capability = bind(requester(), "run-stop-lookup", undefined, () => trusted);
    const stopping = capability!.stop(ACT);
    await started;
    trusted = false;
    releaseLookup();
    expect(await stopping).toEqual({ kind: "unavailable" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("a delayed plane lookup cannot stop after authority is revoked", async () => {
    const { bind, stop } = await fixture();
    let trusted = true;
    let lookupStarted!: () => void;
    let releaseLookup!: () => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));
    const held = new Promise<void>((resolve) => (releaseLookup = resolve));
    const capability = bind(
      requester(),
      "run-stop-plane",
      undefined,
      () => trusted,
      async () => true,
      async () => {
        lookupStarted();
        await held;
        return { stop };
      },
    );
    const stopping = capability!.stop(ACT);
    await started;
    trusted = false;
    releaseLookup();
    expect(await stopping).toEqual({ kind: "unavailable" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("a deferred steer cannot cross a relayed follow-up", async () => {
    const { bind, instances } = await fixture();
    let trusted = true;
    let started!: () => void;
    let release!: (verified: boolean) => void;
    const checking = new Promise<void>((resolve) => (started = resolve));
    const verified = new Promise<boolean>((resolve) => (release = resolve));
    const capability = bind(
      requester(),
      "run-deferred",
      undefined,
      () => trusted,
      async () => {
        started();
        return verified;
      },
    );
    const steering = capability!.steer(ACT, "Stop now", "call-deferred");
    await checking;
    trusted = false;
    release(true);
    expect(await steering).toEqual({ kind: "unavailable" });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: UNIT.unit })).toEqual([]);
  });

  it("a channel flip during status read withholds private facts", async () => {
    const { bind, instances } = await fixture();
    let shared = false;
    const getMainTask = instances.getMainTask.bind(instances);
    vi.spyOn(instances, "getMainTask").mockImplementation(async (key) => {
      const link = await getMainTask(key);
      shared = true;
      return link;
    });
    const capability = bind(
      requester(),
      "run-status-flip",
      undefined,
      () => true,
      async () => !shared,
    );
    expect(await capability!.status(ACT)).toEqual({ kind: "unavailable" });
  });

  it("refuses a Slack Connect D-channel or missing and failed action-time verification", async () => {
    const { bind, instances } = await fixture();
    const shared = mainWorkForRun({
      agentName: "orchestrator",
      actor: requester(),
      message: { channelId: INSTANCE.channelId, threadKey: THREAD, userId: INSTANCE.userId },
      channelVisibility: "dm",
      runId: "run-shared",
      instances,
      plane: async () => ({ stop: vi.fn() }),
      clock: () => 2_000,
      effectGate: createMainWorkEffectGate(),
      trusted: () => true,
      verifiedAtOpen: true,
      verify: async () => true,
    });
    expect(shared).toBeUndefined();
    const denied = bind(
      requester(),
      "run-denied",
      undefined,
      () => true,
      async () => false,
    );
    expect(await denied!.status(ACT)).toEqual({ kind: "unavailable" });
    const unavailable = bind(
      requester(),
      "run-unavailable",
      undefined,
      () => true,
      async () => {
        throw new Error("Slack lookup unavailable");
      },
    );
    expect(await unavailable!.stop(ACT)).toEqual({ kind: "unavailable" });
  });

  it("refuses linked-work reads and effects during an untrusted follow-up turn", async () => {
    const { bind, context, stop, sent } = await fixture();
    let trusted = true;
    const capability = bind(requester(), "run-main-1", undefined, () => trusted);
    expect(capability).toBeDefined();
    trusted = false;
    expect(await capability!.status(ACT)).toEqual({ kind: "unavailable" });
    expect(await capability!.steer(ACT, "change scope", "call-1")).toEqual({ kind: "unavailable" });
    expect(await capability!.stop(ACT)).toEqual({ kind: "unavailable" });
    expect(await workStatusTool.run({ actId: ACT }, context(capability))).toMatch(/^error: Saved work is unavailable/);
    expect(stop).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    trusted = true;
    expect(await capability!.status(ACT)).toMatchObject({ kind: "found" });
  });

  it("does not bind linked-work controls for a shared channel even when the requester owns the unit", async () => {
    const { instances } = await fixture();
    const capability = mainWorkForRun({
      agentName: "orchestrator",
      actor: requester({ origin: { channelId: "slack:CPUB", threadKey: "slack:CPUB:1.0" } }),
      runId: "run-public",
      instances,
      plane: async () => ({ stop: vi.fn() }),
      clock: () => 2_000,
      effectGate: createMainWorkEffectGate(),
      message: { channelId: "slack:CPUB", threadKey: "slack:CPUB:1.0", userId: INSTANCE.userId },
      channelVisibility: "public",
    });
    expect(capability).toBeUndefined();
  });

  it("keeps linked-work controls unavailable in group DM, web chat, relay, or uncertain audience", async () => {
    const { instances, bind } = await fixture();
    expect(bind()).toBeDefined();
    for (const [channelId, visibility] of [
      ["slack:GTEAM", "dm"],
      ["web:alice", "dm"],
      [INSTANCE.channelId, "unknown"],
    ] as const) {
      expect(
        mainWorkForRun({
          agentName: "orchestrator",
          actor: requester({ origin: { channelId, threadKey: `${channelId}:1.0` } }),
          message: { channelId, threadKey: `${channelId}:1.0`, userId: INSTANCE.userId },
          channelVisibility: visibility,
          runId: "run-other-audience",
          instances,
          plane: async () => ({ stop: vi.fn() }),
          clock: () => 2_000,
          effectGate: createMainWorkEffectGate(),
        }),
      ).toBeUndefined();
    }
    expect(
      mainWorkForRun({
        agentName: "orchestrator",
        actor: requester({ kind: "agent", id: "slack:bot:B1", onBehalfOf: requester() }),
        message: {
          channelId: INSTANCE.channelId,
          threadKey: THREAD,
          userId: INSTANCE.userId,
          postedBy: "slack:bot:B1",
        },
        channelVisibility: "dm",
        runId: "run-relay",
        instances,
        plane: async () => ({ stop: vi.fn() }),
        clock: () => 2_000,
        effectGate: createMainWorkEffectGate(),
      }),
    ).toBeUndefined();
  });

  it("reads only the current requester's linked unit and never reveals the private brief", async () => {
    const { bind, context } = await fixture({ threadKey: "private:worker:secret", startedAt: 1_500 });
    const own = await workStatusTool.run(
      { actId: ACT, requesterId: "slack:UBOB", threadKey: "slack:COTHER:2.0" },
      context(),
    );
    expect(own).toContain("ship_signup_1:task");
    expect(own).toContain("running");
    expect(own).not.toMatch(/private:worker|count failed signups|12 failures|run-parent/);
    expect(
      await workStatusTool.run(
        { actId: ACT },
        context(
          bind(requester({ id: "slack:UBOB" }), "run-bob", {
            channelId: INSTANCE.channelId,
            threadKey: THREAD,
            userId: "slack:UBOB",
          }),
        ),
      ),
    ).toMatch(/^error: I couldn't find that work in this conversation/);
    expect(
      await workStatusTool.run(
        { actId: ACT },
        context(
          bind(
            requester({ origin: { channelId: INSTANCE.channelId, threadKey: "slack:DMAIN:other" } }),
            "run-other-thread",
            { channelId: INSTANCE.channelId, threadKey: "slack:DMAIN:other", userId: INSTANCE.userId },
          ),
        ),
      ),
    ).toMatch(/^error: I couldn't find that work in this conversation/);
  });

  it("steers once per stable run and call id as the bound requester", async () => {
    const { instances, bind, context, sent } = await fixture({
      idle: { why: "stopped", at: 1_900, renewalsLeft: 1, spendUsd: 0, wakes: 0 },
    });
    const input = { actId: ACT, words: "Also check confirmation emails" };
    expect(await workSteerTool.run(input, context())).toContain("queued");
    expect(await workSteerTool.run(input, context())).toContain("queued");
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toMatchObject([
      { sender: INSTANCE.userId, text: input.words, mode: "wake" },
    ]);
    expect(sent).toEqual([INSTANCE.id, INSTANCE.id]);
    expect(await workSteerTool.run(input, context(bind(requester(), "run-main-2")))).toContain("queued");
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(2);
  });

  it("refuses a steer without a stable call id or valid words before writing", async () => {
    const { instances, context } = await fixture();
    expect(await workSteerTool.run({ actId: ACT, words: "Fix it" }, { ...context(), callId: undefined })).toMatch(
      /^error: /,
    );
    expect(await workSteerTool.run({ actId: ACT, words: "   " }, context())).toMatch(/^error: /);
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(0);
  });

  it("stops only the current requester's unit and tells the truth about a partial stop", async () => {
    const { bind, context, stop } = await fixture();
    expect(
      await workStopTool.run(
        { actId: ACT },
        context(
          bind(
            requester({ origin: { channelId: INSTANCE.channelId, threadKey: "slack:DMAIN:other" } }),
            "run-other-thread",
            { channelId: INSTANCE.channelId, threadKey: "slack:DMAIN:other", userId: INSTANCE.userId },
          ),
        ),
      ),
    ).toMatch(/^error: I couldn't find that work in this conversation/);
    expect(stop).not.toHaveBeenCalled();
    expect(await workStopTool.run({ actId: ACT }, context())).toContain("Stop mark saved");
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]?.[0]).toBe(INSTANCE.id);
    expect(stop.mock.calls[0]?.[3]).toMatchObject({
      instanceId: INSTANCE.id,
      branch: INSTANCE.branch,
      key: { mainThreadKey: THREAD, actId: ACT },
    });
    stop.mockResolvedValueOnce({
      kind: "stopped",
      instanceId: INSTANCE.id,
      runnerStopped: false,
      stopsSucceeded: true,
      children: [],
    });
    expect(await workStopTool.run({ actId: ACT }, context())).toMatch(/^error: Stop incomplete/);
    stop.mockResolvedValueOnce({
      kind: "stopped",
      instanceId: INSTANCE.id,
      runnerStopped: true,
      stopsSucceeded: false,
      children: [{ id: "child-1", outcome: "conflict" }],
    });
    expect(await workStopTool.run({ actId: ACT }, context())).toContain("a worker did not confirm it stopped");
  });

  it("a branch change during the work_stop tool cannot stop the former claimed unit", async () => {
    const { instances, bind, context } = await fixture();
    const stoppedRuns: string[] = [];
    const plane = createPlaneService({
      instances: {
        get: instances.get.bind(instances),
        listUnits: instances.listUnits.bind(instances),
        markStopped: async (id, at, binding) => {
          await instances.putUnits([{ ...UNIT, branch: "ship/other-work" }]);
          return instances.markStopped(id, at, binding);
        },
      },
      runs: {
        listRuns: async () => ({ runs: [] }),
        listInstanceUnits: async () => [],
        stopRun: async (id: string) => {
          stoppedRuns.push(id);
          return { ok: true, value: { state: "stopping" } };
        },
      } as unknown as Parameters<typeof createPlaneService>[0]["runs"],
      clock: () => 2_000,
    });
    const capability = bind(
      requester(),
      "run-branch-race",
      undefined,
      () => true,
      async () => true,
      async () => plane,
    );
    expect(await workStopTool.run({ actId: ACT }, context(capability))).toMatch(
      /^error: I couldn't find that work in this conversation/,
    );
    expect((await instances.get(INSTANCE.id))?.stop).toBeUndefined();
    expect(stoppedRuns).toEqual([]);
  });

  it("closes new effects before waiting for an in-flight effect to settle", async () => {
    const gate = createMainWorkEffectGate();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = gate.run(async () => {
      entered();
      await held;
      return "written";
    });
    await started;
    let withdrawn = false;
    const revoke = gate.revoke().then(() => (withdrawn = true));
    expect(await gate.run(async () => "late write")).toBeUndefined();
    expect(withdrawn).toBe(false);
    release();
    expect(await first).toBe("written");
    await revoke;
    expect(withdrawn).toBe(true);
    expect(await gate.run(async () => "another write")).toBeUndefined();
  });

  it("a relayed follow-up closes the gate while a durable steer is in flight", async () => {
    const { instances, bind } = await fixture();
    const gate = createMainWorkEffectGate();
    let trusted = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const append = instances.appendEvent.bind(instances);
    vi.spyOn(instances, "appendEvent").mockImplementation(async (...args) => {
      entered();
      await held;
      return append(...args);
    });
    const capability = bind(
      requester(),
      "run-race",
      undefined,
      () => trusted,
      async () => true,
      undefined,
      gate,
    )!;
    const first = capability.steer(ACT, "Do the fix", "call-1");
    await started;
    const withdrawal = gate.revoke().then(() => (trusted = false));
    expect(await capability.steer(ACT, "Late change", "call-2")).toEqual({ kind: "unavailable" });
    release();
    expect(await first).toMatchObject({ kind: "queued" });
    await withdrawal;
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: UNIT.unit })).toMatchObject([
      { text: "Do the fix" },
    ]);
    expect(await capability.steer(ACT, "Another change", "call-3")).toEqual({ kind: "unavailable" });
  });

  it("fails by name when the capability is missing and never offers a start tool", async () => {
    const { bind, context } = await fixture();
    expect(bind(requester(), "run-main")).toBeDefined();
    expect(await workStatusTool.run({ actId: ACT }, context(null))).toMatch(/^error: Saved work is unavailable/);
    expect(await workSteerTool.run({ actId: ACT, words: "Fix it" }, { ...context(null), callId: "call" })).toMatch(
      /^error: Saved work is unavailable/,
    );
    expect(await workStopTool.run({ actId: ACT }, context(null))).toMatch(/^error: Saved work is unavailable/);
    expect(
      mainWorkForRun({
        agentName: "review",
        actor: requester(),
        message: { channelId: INSTANCE.channelId, threadKey: THREAD, userId: INSTANCE.userId },
        channelVisibility: "dm",
        runId: "run-x",
        instances: (await fixture()).instances,
        plane: async () => ({ stop: vi.fn() }),
        clock: () => 1,
        effectGate: createMainWorkEffectGate(),
      }),
    ).toBeUndefined();
  });
});
