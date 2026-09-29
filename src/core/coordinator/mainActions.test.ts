import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../authz/types.js";
import { createPlaneService, type PlaneService } from "../planeService.js";
import { unitNudgeEventType, type CoordinatorInstance, type CoordinatorUnit, type WorkflowSender } from "./contract.js";
import { InMemoryCoordinatorInstanceStore } from "./instanceStore.js";
import { createMainTaskActions } from "./mainActions.js";

const THREAD = "slack:CMAIN:1.0";
const ACT = "act-fix-signup";
const INSTANCE: CoordinatorInstance = {
  id: "ship_signup_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:CMAIN",
  threadKey: THREAD,
  repo: "acme/api",
  branch: "ship/signup-1",
  base: "main",
  plan: { id: "signup-1" },
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
    suspectedCause: "Possibly an expired key",
    requestedChange: "Fix signups",
  },
};

function actor(over: Partial<Actor> = {}): Actor {
  return {
    kind: "user",
    id: "slack:UALICE",
    origin: { channelId: INSTANCE.channelId, threadKey: THREAD },
    grants: {
      actions: new Set(["steer:write"]),
      channels: new Set([INSTANCE.channelId]),
      repos: "all",
    },
    memberOf: new Set([INSTANCE.channelId]),
    ...over,
  };
}

async function fixture(over: Partial<CoordinatorUnit> = {}) {
  const instances = new InMemoryCoordinatorInstanceStore();
  expect(await instances.claimMainTask({ mainThreadKey: THREAD, actId: ACT }, INSTANCE, UNIT)).toMatchObject({
    ok: true,
    created: true,
  });
  if (Object.keys(over).length > 0) await instances.putUnits([{ ...UNIT, ...over }]);
  const sent: Array<{ instance: string; type: string }> = [];
  const workflow: WorkflowSender = {
    get: async (instance) => ({
      sendEvent: async ({ type }) => {
        sent.push({ instance, type });
      },
    }),
  };
  const stop = vi.fn<PlaneService["stop"]>(async (id) => ({
    kind: "stopped",
    instanceId: id,
    runnerStopped: true,
    stopsSucceeded: true,
    parent: { id: "run-parent", outcome: "aborted" },
    children: [{ id: "run-child", outcome: "aborted" }],
  }));
  const actions = createMainTaskActions({ instances, workflow, plane: { stop }, clock: () => 2_000 });
  return { instances, actions, sent, stop };
}

describe("main task actions", () => {
  it("status projects only the requester's linked unit without private context", async () => {
    const { instances, actions } = await fixture({
      startedAt: 1_500,
      threadKey: "private:worker:secret",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      rounds: [{ index: 1, agent: "review", outcome: "request_changes", at: 1_800 }],
    });
    const result = await actions.status(actor(), ACT);
    expect(result).toEqual({
      kind: "found",
      unit: {
        key: "ship_signup_1:task",
        repo: "acme/api",
        branch: "ship/signup-1",
        state: "running",
        pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private:|run-parent|run-child|expired key|count failed signups|12 failures/,
    );
    expect((await instances.listUnits(INSTANCE.id))[0]?.workBrief?.findings[0]?.result).toBe("12");
  });

  it("a foreign or cross-thread caller cannot read the link", async () => {
    const { actions } = await fixture();
    expect(await actions.status(actor({ id: "slack:UBOB" }), ACT)).toEqual({ kind: "not_found" });
    expect(
      await actions.status(actor({ origin: { channelId: INSTANCE.channelId, threadKey: "slack:CMAIN:other" } }), ACT),
    ).toEqual({ kind: "not_found" });
    expect(await actions.status(actor(), "other-act")).toEqual({ kind: "not_found" });
  });

  it("steer persists one event and a replay cannot change its words", async () => {
    const { instances, actions, sent } = await fixture({
      idle: {
        why: "wall_clock_cap",
        at: 1_900,
        renewalsLeft: 1,
        spendUsd: 0,
        wakes: 0,
      },
    });
    const input = { actId: ACT, eventId: "call-42", words: "Also check the confirmation email" };
    expect(await actions.steer(actor(), input)).toEqual({ kind: "queued", seq: 1, nudge: "sent" });
    expect(await actions.steer(actor(), input)).toEqual({ kind: "queued", seq: 1, nudge: "sent" });
    expect(await actions.steer(actor(), { ...input, words: "Change the target" })).toEqual({ kind: "conflict" });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toMatchObject([
      { sender: "slack:UALICE", text: input.words, mode: "wake" },
    ]);
    expect(sent).toEqual([
      { instance: INSTANCE.id, type: unitNudgeEventType({ instanceId: INSTANCE.id, unit: "task" }) },
      { instance: INSTANCE.id, type: unitNudgeEventType({ instanceId: INSTANCE.id, unit: "task" }) },
    ]);
  });

  it("a main-agent steer wakes as the bound requester", async () => {
    const { instances, actions } = await fixture({
      idle: { why: "stopped", at: 1_900, renewalsLeft: 1, spendUsd: 0, wakes: 0 },
    });
    const orchestrator = actor({ kind: "agent", id: "agent:orchestrator", onBehalfOf: actor() });
    expect(await actions.steer(orchestrator, { actId: ACT, eventId: "tool-42", words: "Continue the fix" })).toEqual({
      kind: "queued",
      seq: 1,
      nudge: "sent",
    });
    const events = await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" });
    expect(events).toMatchObject([{ sender: INSTANCE.userId, text: "Continue the fix", mode: "wake" }]);
    expect(events.some((event) => event.sender === INSTANCE.userId)).toBe(true);
  });

  it("a failed nudge leaves the event queued", async () => {
    const { instances } = await fixture();
    const actions = createMainTaskActions({
      instances,
      workflow: {
        get: async () => {
          throw new Error("offline");
        },
      },
      plane: { stop: vi.fn() },
      clock: () => 2_000,
    });
    expect(await actions.steer(actor(), { actId: ACT, eventId: "call-43", words: "Inspect the retry" })).toEqual({
      kind: "queued",
      seq: 1,
      nudge: "pending",
    });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(1);
  });

  it("a persisted steer is nudged without reading the unit's full event history", async () => {
    const { instances, sent } = await fixture();
    const history = vi.spyOn(instances, "listEvents").mockRejectedValue(new Error("history unavailable"));
    const actions = createMainTaskActions({
      instances: {
        getMainTask: instances.getMainTask.bind(instances),
        get: instances.get.bind(instances),
        listUnits: instances.listUnits.bind(instances),
        appendEvent: instances.appendEvent.bind(instances),
      },
      workflow: {
        get: async (id) => ({
          sendEvent: async ({ type }) => {
            sent.push({ instance: id, type });
          },
        }),
      },
      plane: { stop: vi.fn() },
      clock: () => 2_000,
    });
    expect(await actions.steer(actor(), { actId: ACT, eventId: "bounded-1", words: "Continue" })).toEqual({
      kind: "queued",
      seq: 1,
      nudge: "sent",
    });
    expect(sent).toHaveLength(1);
    expect(history).not.toHaveBeenCalled();
  });

  it("terminal units refuse a steer and a later brief rewrite cannot change the binding", async () => {
    const ended = await fixture({ ending: { kind: "merge_ready", report: "private report", at: 2_000 } });
    expect(await ended.actions.steer(actor(), { actId: ACT, eventId: "call-44", words: "Do more" })).toEqual({
      kind: "ended",
    });
    expect(await ended.instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(0);

    const stopped = await fixture();
    await stopped.instances.markStopped(INSTANCE.id, 2_000);
    expect(await stopped.actions.steer(actor(), { actId: ACT, eventId: "call-45", words: "Do more" })).toEqual({
      kind: "ended",
    });

    const recovering = await fixture({
      recoveryHold: { cause: "draft", pr: { number: 7, url: "https://github.com/acme/api/pull/7" } },
    });
    expect(await recovering.actions.steer(actor(), { actId: ACT, eventId: "call-47", words: "Do more" })).toEqual({
      kind: "ended",
    });
    expect(await recovering.instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(0);

    const rewritten = await fixture({ workBrief: { ...UNIT.workBrief!, repo: "other/repo" } });
    expect((await rewritten.instances.listUnits(INSTANCE.id))[0]?.workBrief?.repo).toBe(INSTANCE.repo);
    expect(await rewritten.actions.steer(actor(), { actId: ACT, eventId: "call-46", words: "Do more" })).toEqual({
      kind: "queued",
      seq: 1,
      nudge: "sent",
    });
  });

  it("a stop racing the append leaves no steer on a terminal unit", async () => {
    const { instances } = await fixture();
    const actions = createMainTaskActions({
      instances: {
        getMainTask: instances.getMainTask.bind(instances),
        get: instances.get.bind(instances),
        listUnits: instances.listUnits.bind(instances),
        appendEvent: async (key, event, guard) => {
          await instances.markStopped(INSTANCE.id, 2_000);
          return instances.appendEvent(key, event, guard);
        },
      },
      plane: { stop: vi.fn() },
      clock: () => 2_000,
    });
    expect(await actions.steer(actor(), { actId: ACT, eventId: "race-1", words: "Continue" })).toEqual({
      kind: "ended",
    });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toEqual([]);
  });

  it("a branch change racing the append leaves no steer on the former claimed unit", async () => {
    const { instances } = await fixture();
    const actions = createMainTaskActions({
      instances: {
        getMainTask: instances.getMainTask.bind(instances),
        get: instances.get.bind(instances),
        listUnits: instances.listUnits.bind(instances),
        appendEvent: async (key, event, active, binding) => {
          await instances.putUnits([{ ...UNIT, branch: "ship/other-work" }]);
          return instances.appendEvent(key, event, active, binding);
        },
      },
      plane: { stop: vi.fn() },
      clock: () => 2_000,
    });
    expect(await actions.steer(actor(), { actId: ACT, eventId: "race-branch", words: "Continue" })).toEqual({
      kind: "not_found",
    });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toEqual([]);
  });

  it("a branch change racing the stop leaves the former claimed instance running", async () => {
    const { instances } = await fixture();
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
    const actions = createMainTaskActions({ instances, plane, clock: () => 2_000 });
    expect(await actions.stop(actor(), ACT)).toEqual({ kind: "not_found" });
    expect((await instances.get(INSTANCE.id))?.stop).toBeUndefined();
    expect(stoppedRuns).toEqual([]);
  });

  it("a mismatched stored brief refuses a steer before writing an event", async () => {
    const { instances } = await fixture();
    const actions = createMainTaskActions({
      instances: {
        getMainTask: instances.getMainTask.bind(instances),
        get: instances.get.bind(instances),
        listUnits: async (id) =>
          (await instances.listUnits(id)).map((unit) => ({
            ...unit,
            workBrief: { ...unit.workBrief!, repo: "other/repo" },
          })),
        appendEvent: instances.appendEvent.bind(instances),
      },
      plane: { stop: vi.fn() },
      clock: () => 2_000,
    });
    expect(await actions.steer(actor(), { actId: ACT, eventId: "call-48", words: "Do more" })).toEqual({
      kind: "not_found",
    });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(0);
  });

  it("a changed unit branch revokes status, steer, and stop for the claimed task", async () => {
    const { instances, actions, stop } = await fixture({ branch: "another-task-branch" });
    expect(await actions.status(actor(), ACT)).toEqual({ kind: "not_found" });
    expect(await actions.steer(actor(), { actId: ACT, eventId: "call-branch", words: "Do more" })).toEqual({
      kind: "not_found",
    });
    expect(await actions.stop(actor(), ACT)).toEqual({ kind: "not_found" });
    expect(await instances.listEvents({ instanceId: INSTANCE.id, unit: "task" })).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stop preserves exact ownership and reports the plane outcome", async () => {
    const { actions, stop } = await fixture();
    expect(await actions.stop(actor({ id: "slack:UBOB" }), ACT)).toEqual({ kind: "not_found" });
    expect(
      await actions.stop(actor({ origin: { channelId: INSTANCE.channelId, threadKey: "slack:CMAIN:other" } }), ACT),
    ).toEqual({ kind: "not_found" });
    expect(await actions.stop(actor({ kind: "service" }), ACT)).toEqual({ kind: "forbidden" });
    expect(await actions.stop(actor({ viewingAs: { id: "slack:UALICE" } }), ACT)).toEqual({ kind: "forbidden" });
    expect(stop).not.toHaveBeenCalled();
    expect(await actions.stop(actor(), ACT)).toEqual({
      kind: "stopped",
      runnerStopped: true,
      parentOutcome: "aborted",
      childOutcomes: ["aborted"],
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.calls[0]?.[0]).toBe(INSTANCE.id);
    expect(stop.mock.calls[0]?.[1]).toEqual({ kind: "chat", id: "slack:UALICE" });
    expect(stop.mock.calls[0]?.[2]).not.toEqual({ kind: "all" });

    stop.mockResolvedValueOnce({
      kind: "stopped",
      instanceId: INSTANCE.id,
      runnerStopped: false,
      stopsSucceeded: true,
      children: [],
    });
    expect(await actions.stop(actor(), ACT)).toEqual({ kind: "partial", runnerStopped: false, childOutcomes: [] });
  });

  it("a failed child stop reports partial even when the runner mark succeeded", async () => {
    const { actions, stop } = await fixture();
    stop.mockResolvedValueOnce({
      kind: "stopped",
      instanceId: INSTANCE.id,
      runnerStopped: true,
      stopsSucceeded: false,
      parent: { id: "run-parent", outcome: "stopping" },
      children: [{ id: "run-child", outcome: "unavailable" }],
    });
    expect(await actions.stop(actor(), ACT)).toEqual({
      kind: "partial",
      runnerStopped: true,
      parentOutcome: "stopping",
      childOutcomes: ["unavailable"],
    });
  });
});
