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
