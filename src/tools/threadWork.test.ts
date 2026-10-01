import { describe, expect, it, vi } from "vitest";
import type { RunsService, RunView } from "../core/runsService.js";
import type { ToolContext } from "./runnableTool.js";
import { threadWorkTool } from "./threadWork.js";

const actor = {
  kind: "user" as const,
  id: "slack:UOWNER",
  grants: { actions: new Set<string>(), channels: new Set<string>(), repos: new Set<string>() },
};
const threadKey = "slack:CPUBLIC:100.0";
const view = (id: string, changes: Partial<RunView> = {}): RunView => ({
  id,
  channelId: "slack:CPUBLIC",
  channelVisibility: "public",
  threadKey,
  userId: actor.id,
  agent: "general",
  startedAt: 100,
  finished: true,
  eventCount: 0,
  ...changes,
});

describe("thread_work — the main conversation's durable work link (orchestration-plane item 14)", () => {
  it("joins the requester's exact-thread Ship run to its saved unit and PR after agent changes and restart", async () => {
    const listRuns = vi.fn(async () => ({
      durableHistory: true as const,
      runs: [
        view("current", { agent: "orchestrator", finished: false }),
        view("foreign", {
          userId: "slack:UOTHER",
          repo: "secret/repo",
          pr: { number: 2, url: "https://github.com/secret/repo/pull/2" },
        }),
        view("ship-parent", { agent: "ship", instanceId: "instance-one", repo: "acme/api" }),
        view("explore", { agent: "explore" }),
      ],
    }));
    const listInstanceUnits = vi.fn(async () => [
      {
        unit: "instance-one:task",
        instanceId: "instance-one",
        id: "task",
        branch: "plan/fix-it/u1",
        threads: { coding: threadKey },
        sourceUrls: {},
        pr: { number: 12, url: "https://github.com/acme/api/pull/12" },
        rounds: [],
        ending: { kind: "merge-ready", at: 200 },
      },
    ]);
    const ctx: ToolContext = {
      executor: {} as ToolContext["executor"],
      agentName: "orchestrator",
      runs: {
        actor,
        runId: "current",
        service: {
          getRun: vi.fn(async () => ({
            ok: true as const,
            value: view("current", { agent: "orchestrator", finished: false }),
          })),
          listRuns,
          listInstanceUnits,
        } as unknown as RunsService,
      },
    };
    const result = String(await threadWorkTool.run({}, ctx));
    expect(result).not.toContain('"id":"current"');
    expect(result).toContain("ship-parent");
    expect(result).toContain("instance-one:task");
    expect(result).toContain("https://github.com/acme/api/pull/12");
    expect(result).not.toContain("secret/repo");
    expect(result).not.toContain("foreign");
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ threadKey, status: "all" }));
    expect(listInstanceUnits).toHaveBeenCalledWith("instance-one", expect.anything());
  });

  it("refuses a live-only fallback and an incomplete persisted page before claiming the thread has no work", async () => {
    const service = {
      getRun: vi.fn(async () => ({ ok: true as const, value: view("current", { agent: "orchestrator" }) })),
      listRuns: vi.fn(async () => ({ runs: [] as RunView[] })),
      listInstanceUnits: vi.fn(),
    } as unknown as RunsService;
    const ctx: ToolContext = {
      executor: {} as ToolContext["executor"],
      agentName: "orchestrator",
      runs: { actor, runId: "current", service },
    };
    expect(String(await threadWorkTool.run({}, ctx))).toContain("unavailable");
    vi.mocked(service.listRuns).mockResolvedValueOnce({
      runs: [],
      durableHistory: true,
      nextBefore: { finishedAt: 99, id: "older" },
    });
    expect(String(await threadWorkTool.run({}, ctx))).toContain("unavailable");
    expect(service.listInstanceUnits).not.toHaveBeenCalled();
  });

  it("fails closed when the durable page is incomplete or the caller changes", async () => {
    const current = view("current", { agent: "orchestrator", finished: false });
    const service = {
      getRun: vi.fn(async () => ({ ok: true as const, value: current })),
      listRuns: vi.fn(async () => ({ runs: [], storeUnavailable: true as const })),
      listInstanceUnits: vi.fn(),
    } as unknown as RunsService;
    const ctx: ToolContext = {
      executor: {} as ToolContext["executor"],
      agentName: "orchestrator",
      runs: { actor, runId: "current", service },
    };
    expect(String(await threadWorkTool.run({}, ctx))).toContain("unavailable");
    expect(
      String(await threadWorkTool.run({}, { ...ctx, runs: { ...ctx.runs!, actor: { ...actor, id: "slack:UOTHER" } } })),
    ).toContain("unavailable");
    expect(service.listRuns).toHaveBeenCalledTimes(1);
    expect(String(await threadWorkTool.run({}, { ...ctx, agentName: "general" }))).toContain("unavailable");
  });
});
