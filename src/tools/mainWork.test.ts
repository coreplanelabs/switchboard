import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../core/authz/types.js";
import type { CoordinatorInstance, CoordinatorUnit } from "../core/coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { PlaneService } from "../core/planeService.js";
import { mainWorkForRun, workStatusTool, workSteerTool, workStopTool, type MainWorkCapability } from "./mainWork.js";
import type { ToolContext } from "./runnableTool.js";

const THREAD = "slack:CMAIN:1.0";
const ACT = "fix-signup";
const INSTANCE: CoordinatorInstance = {
  id: "ship_signup_1",
  kind: "ship",
  userId: "slack:UALICE",
  channelId: "slack:CMAIN",
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
  const principal: Actor = {
    kind: "user",
    id: INSTANCE.userId,
    origin: { channelId: INSTANCE.channelId, threadKey: THREAD },
    grants: { actions: new Set(["steer:write"]), channels: new Set([INSTANCE.channelId]), repos: "all" },
  };
  return {
    kind: "agent",
    id: "agent:orchestrator",
    origin: principal.origin,
    grants: principal.grants,
    onBehalfOf: principal,
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
  const bind = (actor: Actor = requester(), runId = "run-main-1") =>
    mainWorkForRun({ agentName: "orchestrator", actor, runId, instances, workflow, plane, clock: () => 2_000 });
  const context = (capability: MainWorkCapability | null = bind() ?? null, callId = "tool-call-1"): ToolContext => ({
    executor: {} as ToolContext["executor"],
    ...(capability ? { mainWork: capability } : {}),
    callId,
  });
  return { instances, sent, stop, bind, context };
}

describe("main work tools", () => {
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
          bind(
            requester({
              id: "agent:other",
              onBehalfOf: {
                ...requester().onBehalfOf!,
                id: "slack:UBOB",
              },
            }),
          ),
        ),
      ),
    ).toMatch(/^error: I couldn't find that work in this conversation/);
    expect(
      await workStatusTool.run(
        { actId: ACT },
        context(bind(requester({ origin: { channelId: INSTANCE.channelId, threadKey: "slack:CMAIN:other" } }))),
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
        context(bind(requester({ origin: { channelId: INSTANCE.channelId, threadKey: "slack:CMAIN:other" } }))),
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
        runId: "run-x",
        instances: (await fixture()).instances,
        plane: async () => ({ stop: vi.fn() }),
        clock: () => 1,
      }),
    ).toBeUndefined();
  });
});
