import { describe, expect, it } from "vitest";
import type { Predicate } from "./authz/types.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import { createPlaneService, type PlaneGithubReads } from "./planeService.js";
import type { ListRunsOptions, ListRunsResult, RunView } from "./runsService.js";
import { unitFactsOf } from "./unitRuns.js";

// The plane service (docs/reference/specs/orchestration-plane.md items 1-3): one read
// over the stores that exist — the runs service for live and recently ended
// runs and for an instance's units under the viewer's predicate, the instance
// store for the instance's facts, the merge door's GitHub reads for the tracked
// pull requests — handed to the pure table. Nothing here decides anything.

const NOW = Date.parse("2026-09-19T03:00:00Z");
const MIN = 60_000;
const ALL: Predicate = { kind: "all" };

function view(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 10 * MIN, finished: false, eventCount: 3, agent: "coding", ...over };
}

const INSTANCE: CoordinatorInstance = {
  id: "plan-example-2",
  kind: "ship",
  userId: "slack:U_ALICE",
  channelId: "slack:C_PUB",
  threadKey: "slack:C_PUB:1.0",
  repo: "acme/api",
  branch: "plan/example",
  createdAt: NOW - 60 * MIN,
  caps: { maxRounds: 3, maxMinutes: 240 },
  runId: "parent-1",
} as CoordinatorInstance;

function unit(id: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit {
  return {
    instanceId: INSTANCE.id,
    unit: id,
    slug: id.toLowerCase(),
    branch: `plan/example/${id.toLowerCase()}`,
    dependsOn: [],
    rounds: [],
    ...over,
  };
}

/** A runs service over fixed lists: `listRuns` answers by status, `listInstanceUnits` by instance. */
function fakeRuns(rows: { active: RunView[]; finished: RunView[] }, units: Record<string, CoordinatorUnit[]>) {
  const asked: ListRunsOptions[] = [];
  return {
    asked,
    runs: {
      listRuns: async (opts: ListRunsOptions): Promise<ListRunsResult> => {
        asked.push(opts);
        return { runs: opts.status === "active" ? rows.active : rows.finished };
      },
      listInstanceUnits: async (instanceId: string) => (units[instanceId] ?? []).map(unitFactsOf),
    },
  };
}

function github(over: Partial<PlaneGithubReads> = {}): PlaneGithubReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    facts: async (pr) => {
      asked.push(`facts ${pr.repo}#${pr.number}`);
      return {
        state: "open",
        sameRepoHead: true,
        headSha: "b".repeat(40),
        title: "feat(runs): the table",
        mergeableState: "clean",
      };
    },
    checks: async (repo, sha) => {
      asked.push(`checks ${repo}@${sha.slice(0, 7)}`);
      return { total: 2, pending: [], failed: [] };
    },
    reviews: async (pr) => {
      asked.push(`reviews ${pr.repo}#${pr.number}`);
      return [{ state: "APPROVED", commitId: "b".repeat(40), body: "LGTM" }];
    },
    ...over,
  };
}

describe("createPlaneService — the table over the stores that exist", () => {
  it("lists the live runs and the runs finished within the recent window, under the viewer's predicate", async () => {
    const live = view({ id: "live-1", eventsLast5m: 2, lastToolCallAt: NOW - MIN });
    const done = view({ id: "done-1", finished: true, status: "completed", finishedAt: NOW - 5 * MIN });
    const fake = fakeRuns({ active: [live], finished: [done] }, {});
    const service = createPlaneService({
      runs: fake.runs,
      instances: new InMemoryCoordinatorInstanceStore(),
      clock: () => NOW,
    });
    const table = await service.table(ALL);
    expect(table.runs.map((r) => r.run.id)).toEqual(["live-1", "done-1"]);
    expect(fake.asked.map((o) => [o.status, o.visibleTo])).toEqual([
      ["active", ALL],
      ["finished", ALL],
    ]);
    expect(fake.asked[1].sinceMs).toBe(NOW - 60 * MIN);
    expect(table.pullRequests).toEqual([]);
    expect(table.units).toEqual([]);
  });

  it("joins a coordinator child to its instance's units and reads the units' pull requests once each", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    await store.put(INSTANCE);
    const u2 = unit("U12", { title: "The table", pr: { number: 41, url: "https://example.test/pr/41" } });
    const u3 = unit("U13", { title: "The queue", pr: { number: 41, url: "https://example.test/pr/41" } });
    await store.putUnits([u2, u3]);
    const child = view({
      id: "child-1",
      parentInstanceId: INSTANCE.id,
      idempotencyKey: `${INSTANCE.id}:U12/0/coding`,
      eventsLast5m: 4,
      lastToolCallAt: NOW - MIN,
    });
    const fake = fakeRuns({ active: [child], finished: [] }, { [INSTANCE.id]: [u2, u3] });
    const gh = github();
    const service = createPlaneService({
      runs: fake.runs,
      instances: store,
      github: gh,
      clock: () => NOW,
      titleOk: () => true,
    });
    const table = await service.table(ALL);
    expect(table.runs[0].unit).toEqual({ key: `${INSTANCE.id}:U12`, id: "U12", title: "The table" });
    expect(table.units.map((u) => u.unit.id)).toEqual(["U12", "U13"]);
    expect(table.units[0].instance.repo).toBe("acme/api");
    expect(table.pullRequests).toHaveLength(1);
    expect(table.pullRequests[0]).toMatchObject({
      pr: { repo: "acme/api", number: 41, headSha: "b".repeat(40), approvedAtHead: true, titleOk: true },
      owner: { unitKey: `${INSTANCE.id}:U12` },
      health: ["approved"],
    });
    expect(gh.asked.sort()).toEqual(["checks acme/api@bbbbbbb", "facts acme/api#41", "reviews acme/api#41"]);
  });

  it("an instance the viewer may see nothing of contributes no units and no pull requests", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    await store.put(INSTANCE);
    await store.putUnits([unit("U12", { pr: { number: 41, url: "https://example.test/pr/41" } })]);
    const child = view({ id: "child-1", parentInstanceId: INSTANCE.id, idempotencyKey: `${INSTANCE.id}:U12/0/coding` });
    // The runs service answers no units for a reader outside the instance's channel.
    const fake = fakeRuns({ active: [child], finished: [] }, {});
    const gh = github();
    const service = createPlaneService({ runs: fake.runs, instances: store, github: gh, clock: () => NOW });
    const table = await service.table(ALL);
    expect(table.units).toEqual([]);
    expect(table.pullRequests).toEqual([]);
    expect(table.runs[0].unit).toBeUndefined();
    expect(gh.asked).toEqual([]);
  });

  it("a pull request GitHub cannot read is unknown; without a GitHub reader every pull request is", async () => {
    const opener = view({
      id: "r1",
      finished: true,
      status: "completed",
      finishedAt: NOW - MIN,
      repo: "acme/api",
      pr: { number: 7, url: "https://example.test/pr/7" },
    });
    const fake = fakeRuns({ active: [], finished: [opener] }, {});
    const unreadable = createPlaneService({
      runs: fake.runs,
      instances: new InMemoryCoordinatorInstanceStore(),
      github: github({ facts: async () => undefined }),
      clock: () => NOW,
    });
    expect((await unreadable.table(ALL)).pullRequests[0]).toMatchObject({
      pr: { number: 7, unknown: true },
      health: ["unknown"],
      owner: { runId: "r1" },
    });
    const none = createPlaneService({
      runs: fake.runs,
      instances: new InMemoryCoordinatorInstanceStore(),
      clock: () => NOW,
    });
    expect((await none.table(ALL)).pullRequests[0].health).toEqual(["unknown"]);
  });

  it("reads at most the configured number of pull requests, the units' first", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    await store.put(INSTANCE);
    await store.putUnits([unit("U12", { pr: { number: 1, url: "u" } }), unit("U13", { pr: { number: 2, url: "u" } })]);
    const child = view({ id: "child-1", parentInstanceId: INSTANCE.id, idempotencyKey: `${INSTANCE.id}:U12/0/coding` });
    const openers = [3, 4].map((n) =>
      view({
        id: `r${n}`,
        finished: true,
        status: "completed",
        finishedAt: NOW - MIN,
        repo: "acme/api",
        pr: { number: n, url: "u" },
      }),
    );
    const fake = fakeRuns(
      { active: [child], finished: openers },
      { [INSTANCE.id]: [unit("U12", { pr: { number: 1, url: "u" } }), unit("U13", { pr: { number: 2, url: "u" } })] },
    );
    const gh = github();
    const service = createPlaneService({
      runs: fake.runs,
      instances: store,
      github: gh,
      clock: () => NOW,
      maxPullRequests: 3,
    });
    const table = await service.table(ALL);
    expect(table.pullRequests.map((p) => p.pr.number)).toEqual([1, 2, 3]);
    expect(gh.asked.filter((a) => a.startsWith("facts"))).toHaveLength(3);
  });
});

describe("plane stop — the runner_stop move (record 0064; issue 1924)", () => {
  function stopHarness(over: { markFails?: boolean; liveByThread?: Record<string, RunView[]> } = {}) {
    const store = new InMemoryCoordinatorInstanceStore();
    const stops: Array<{ id: string; mode: string; actor: { kind: string; id: string } }> = [];
    const marks: string[] = [];
    const instances = {
      get: (id: string) => store.get(id),
      listUnits: (id: string) => store.listUnits(id),
      markStopped: async (id: string, at: number) => {
        marks.push(`${id}@${at}`);
        if (over.markFails) return { ok: false as const, reason: "unknown_instance" as const };
        return store.markStopped(id, at);
      },
    };
    const runs = {
      listRuns: async (opts: ListRunsOptions): Promise<ListRunsResult> => ({
        runs: opts.threadKey !== undefined ? (over.liveByThread?.[opts.threadKey] ?? []) : [],
      }),
      listInstanceUnits: async () => [],
      stopRun: async (id: string, mode: "soft" | "hard", actor: { kind: string; id: string }) => {
        stops.push({ id, mode, actor });
        return { ok: true as const, value: { id, mode, state: "stopping" } };
      },
    };
    const service = createPlaneService({
      runs: runs as unknown as Parameters<typeof createPlaneService>[0]["runs"],
      instances,
      clock: () => NOW,
    });
    return { service, store, stops, marks };
  }
  const actor = { kind: "chat", id: "slack:U_ALICE" } as const;

  it("terminates the instance and ends its live children in one move: the stop mark first, the hosted parent hard-stopped, then every live child in a unit thread — never the parent twice", async () => {
    const h = stopHarness({
      liveByThread: {
        "slack:C_PUB:2.0": [view({ id: "child-1" })],
        "slack:C_PUB:3.0": [view({ id: "child-2" })],
      },
    });
    await h.store.put(INSTANCE);
    await h.store.putUnits([
      unit("U12", { threadKey: "slack:C_PUB:2.0", reviewThread: { threadKey: "slack:C_PUB:3.0" } }),
    ]);
    const report = await h.service.stop(INSTANCE.id, actor, ALL);
    expect(report).toEqual({
      kind: "stopped",
      instanceId: INSTANCE.id,
      runnerStopped: true,
      parent: { id: "parent-1", outcome: "stopping" },
      children: [
        { id: "child-1", outcome: "stopping" },
        { id: "child-2", outcome: "stopping" },
      ],
    });
    expect(h.marks).toEqual([`${INSTANCE.id}@${NOW}`]);
    expect(h.stops.map((s) => [s.id, s.mode])).toEqual([
      ["parent-1", "hard"],
      ["child-1", "hard"],
      ["child-2", "hard"],
    ]);
    expect(h.stops.every((s) => s.actor.id === "slack:U_ALICE")).toBe(true);
  });

  it("a stop mark that could not be written still ends the runs and says so; an instance the viewer's predicate does not admit is unknown, and an unknown id stops nothing", async () => {
    const h = stopHarness({ markFails: true });
    await h.store.put(INSTANCE);
    const report = await h.service.stop(INSTANCE.id, actor, ALL);
    expect(report).toMatchObject({ kind: "stopped", runnerStopped: false, parent: { id: "parent-1" } });

    const foreign = await h.service.stop(INSTANCE.id, actor, { kind: "user-is", userId: "slack:U_OTHER" });
    expect(foreign).toEqual({ kind: "unknown_instance", instanceId: INSTANCE.id });

    const none = await h.service.stop("plan-nope", actor, ALL);
    expect(none).toEqual({ kind: "unknown_instance", instanceId: "plan-nope" });
    // The predicate-refused and unknown stops wrote no mark and stopped no run beyond the first call's.
    expect(h.marks).toHaveLength(1);
    expect(h.stops.map((s) => s.id)).toEqual(["parent-1"]);
  });

  it("a process without the run-history stores refuses by name instead of half-stopping", async () => {
    const service = createPlaneService({
      runs: { listRuns: async () => ({ runs: [] }), listInstanceUnits: async () => [] },
      instances: { get: async () => null },
      clock: () => NOW,
    });
    const report = await service.stop("plan-x", actor, ALL);
    expect(report).toMatchObject({ kind: "unavailable" });
  });
});
