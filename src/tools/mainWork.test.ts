import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../core/authz/types.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { PlaneService } from "../core/planeService.js";
import { mainWorkForRun, workStatusTool, workSteerTool, workStopTool, type MainWorkCapability } from "./mainWork.js";
import type { ToolContext } from "./runnableTool.js";

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
    findings: [{ text: "12 failures", query: "count failed signups", result: "12", timeWindow: "last day" }],
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
  const instances = new InMemoryCoordinatorInstanceStore();
  expect(await instances.claimMainTask({ mainThreadKey: THREAD, actId: ACT }, INSTANCE, UNIT)).toMatchObject({
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
    children: [],
  }));
  const plane = async () => ({ stop }) as Pick<PlaneService, "stop">;
  const bind = (
    actor: Actor = requester(),
    runId = "run-main-1",
    message = { channelId: INSTANCE.channelId, threadKey: THREAD, userId: INSTANCE.userId },
    trusted = () => true,
    verify = async () => true,
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
      plane,
      clock: () => 2_000,
      trusted,
      verifiedAtOpen: true,
      verify,
    });
  const context = (capability: MainWorkCapability | null = bind() ?? null, callId = "tool-call-1"): ToolContext => ({
    executor: {} as ToolContext["executor"],
    ...(capability ? { mainWork: capability } : {}),
    callId,
  });
  return { instances, sent, stop, bind, context };
}

describe("main work tools", () => {
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
    stop.mockResolvedValueOnce({ kind: "stopped", instanceId: INSTANCE.id, runnerStopped: false, children: [] });
    expect(await workStopTool.run({ actId: ACT }, context())).toMatch(/^error: Stop incomplete/);
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
      }),
    ).toBeUndefined();
  });
});
