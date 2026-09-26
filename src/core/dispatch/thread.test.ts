import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorUnit } from "../coordinator/contract.js";
import type { RunSession } from "../runRecord.js";
import type { RunView } from "../runsService.js";
import {
  instanceOf,
  ownerOf,
  previousRunOf,
  readThread,
  releasedPrOf,
  refusedRequestsOf,
  requesterOf,
  runsSince,
  stickyAgentOf,
  THREAD_READ_LIMIT,
  threadPrOf,
  threadRouteOf,
  newestFinishedRunOf,
} from "./thread.js";

// docs/reference/specs/routing-and-config.md item 3 and session-log.md item 9:
// one read of the thread's newest runs, and what the dispatcher derives from it.

const run = (over: Partial<RunView> & { id: string }): RunView => ({
  startedAt: 1_000,
  finished: true,
  eventCount: 0,
  ...over,
});
const session = (range: RunSession["range"]): RunSession => ({
  key: "slack:C1:1.0:coding",
  seedFrom: 0,
  request: 2,
  range,
});
const closed = session({ from: 0, to: 9 });

describe("readThread — one page of the thread's newest runs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks the runs service for the thread's runs, live and finished, under no visibility predicate, newest first", async () => {
    const runs = [run({ id: "r2" }), run({ id: "r1" })];
    const listRuns = vi.fn(async () => ({ runs }));
    expect(await readThread({ listRuns }, "slack:C1:1.0")).toEqual(runs);
    expect(listRuns).toHaveBeenCalledWith({
      status: "all",
      visibleTo: { kind: "all" },
      threadKey: "slack:C1:1.0",
      limit: THREAD_READ_LIMIT,
    });
  });

  it("a read that fails is no thread: undefined, one warning naming the thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listRuns = vi.fn(async () => {
      throw new Error("store down");
    });
    expect(await readThread({ listRuns }, "slack:C1:1.0")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("slack:C1:1.0: thread read failed — store down"));
  });
});

describe("newestFinishedRunOf — the operator's thread facts", () => {
  it("returns the newest finished run's agent, repository and pull request past a live run", () => {
    expect(
      newestFinishedRunOf([
        run({ id: "live", agent: "coding", repo: "acme/web", finished: false }),
        run({
          id: "review-7",
          agent: "review",
          repo: "acme/api",
          pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
        }),
        run({ id: "coding-6", agent: "coding", repo: "acme/old" }),
      ]),
    ).toEqual({
      agent: "review",
      repo: "acme/api",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
    });
  });

  it("returns no facts when the page has no finished run", () => {
    expect(newestFinishedRunOf([run({ id: "live", finished: false })])).toBeUndefined();
  });
});

describe("stickyAgentOf — the thread's agent by transcript", () => {
  it("the newest run's agent when that run finished with a session log, whatever its preset", () => {
    expect(
      stickyAgentOf([run({ id: "r2", agent: "coding", session: closed }), run({ id: "r1", agent: "review" })]),
    ).toBe("coding");
    expect(stickyAgentOf([run({ id: "r1", agent: "review", session: closed })])).toBe("review");
  });

  it("nothing when the newest run is live, has no session log (refused at a gate, or from before the log), or the thread has no run", () => {
    expect(stickyAgentOf([run({ id: "live", agent: "coding", finished: false, session: closed })])).toBeUndefined();
    expect(stickyAgentOf([run({ id: "r1", agent: "coding" })])).toBeUndefined();
    expect(stickyAgentOf([])).toBeUndefined();
  });

  it("a run a coordinator spawned into the thread is the runner's turn, not the thread's: skipped, so the newest run a person addressed decides — a ship thread whose newest addressed run holds no transcript has no sticky agent and routes again", () => {
    const child = run({ id: "c1", agent: "coding", session: closed, parentInstanceId: "plan-fix-1" });
    // The plan's own run — the ship hand-off — wrote no session log: the
    // follow-up resolves through the scopes and the router, never as coding.
    expect(stickyAgentOf([child, run({ id: "s1", agent: "ship" })])).toBeUndefined();
    // A person's earlier run with a transcript is the one that sticks.
    expect(stickyAgentOf([child, run({ id: "g1", agent: "general", session: closed })])).toBe("general");
    // A thread of children alone has no sticky agent.
    expect(
      stickyAgentOf([child, run({ id: "c0", agent: "review", session: closed, parentInstanceId: "plan-fix-1" })]),
    ).toBeUndefined();
  });
});

// docs/reference/specs/routing-and-config.md item 27 (record 0058): the
// requester the intake facts name — the person of the thread's newest run a
// person addressed, whatever state that run is in.
describe("requesterOf — the person of the thread's newest addressed run", () => {
  it("returns the newest addressed run's user whether that run is live, finished or refused at a gate", () => {
    expect(requesterOf([run({ id: "live", userId: "slack:U_ALICE", finished: false })])).toBe("slack:U_ALICE");
    expect(requesterOf([run({ id: "done", userId: "slack:U_ALICE", session: closed })])).toBe("slack:U_ALICE");
    // A run refused at a gate wrote no session log; its user still holds the thread.
    expect(requesterOf([run({ id: "refused", userId: "slack:U_ALICE" })])).toBe("slack:U_ALICE");
    // The newest addressed run decides, not an older one.
    expect(requesterOf([run({ id: "r2", userId: "slack:U_BOB" }), run({ id: "r1", userId: "slack:U_ALICE" })])).toBe(
      "slack:U_BOB",
    );
  });

  it("skips a coordinator's spawned child: the runner's turns never name the requester", () => {
    const child = run({ id: "c1", userId: "slack:UBOT", parentInstanceId: "plan-fix-1" });
    expect(requesterOf([child, run({ id: "r1", userId: "slack:U_ALICE" })])).toBe("slack:U_ALICE");
    expect(requesterOf([child])).toBeUndefined();
  });

  it("returns none on an empty page", () => {
    expect(requesterOf([])).toBeUndefined();
  });
});

// docs/reference/specs/routing-and-config.md item 21: the route a sticky-by-
// transcript follow-up carries — the thread's decision, receipt intact.
describe("threadRouteOf — the route a sticky follow-up carries", () => {
  const route = { preset: "coding", reason: "an imperative ask", model: "anthropic/fast" };

  it("the newest continuable run's route for the sticky agent, with a compound's parts and a collapse stripped — the follow-up spawns nothing and collapsed nothing", () => {
    const routed = run({
      id: "r2",
      agent: "coding",
      session: closed,
      route: { ...route, parts: [{ preset: "general", text: "x" }], collapsed: { presets: ["review", "coding"] } },
    });
    expect(threadRouteOf([routed, run({ id: "r1" })], "coding")).toEqual(route);
  });

  it("nothing when the newest run was not routed, cannot be continued, is another agent's, or the thread has no run — an unrouted thread's card is exactly what it was", () => {
    expect(threadRouteOf([run({ id: "r1", agent: "coding", session: closed })], "coding")).toBeUndefined();
    expect(threadRouteOf([run({ id: "r1", agent: "coding", route })], "coding")).toBeUndefined();
    expect(threadRouteOf([run({ id: "r1", agent: "review", session: closed, route })], "coding")).toBeUndefined();
    expect(threadRouteOf([], "coding")).toBeUndefined();
  });

  it("a coordinator's spawned child is skipped here too: the route carried is the newest addressed run's", () => {
    const child = run({ id: "c1", agent: "coding", session: closed, parentInstanceId: "plan-fix-1", route });
    const addressed = run({
      id: "r1",
      agent: "coding",
      session: closed,
      route: { ...route, reason: "the person's ask" },
    });
    expect(threadRouteOf([child, addressed], "coding")).toEqual({ ...route, reason: "the person's ask" });
    expect(threadRouteOf([child], "coding")).toBeUndefined();
  });
});

describe("previousRunOf — the agent's previous finished run", () => {
  it("the newest finished run of the agent with a session, past a live run and another agent's runs: when it ended, and whether its log ends short", () => {
    const runs = [
      run({ id: "live", agent: "coding", finished: false }),
      run({ id: "r3", agent: "review", session: closed, finishedAt: 9_000 }),
      run({ id: "r2", agent: "coding", session: session("broken"), finishedAt: 7_000 }),
      run({ id: "r1", agent: "coding", session: closed, finishedAt: 5_000 }),
    ];
    expect(previousRunOf(runs, "coding")).toEqual({ finishedAt: 7_000, broken: true });
    expect(previousRunOf(runs, "review")).toEqual({ finishedAt: 9_000, broken: false });
  });

  it("nothing when the agent has no finished run with a session in the page", () => {
    expect(
      previousRunOf(
        [run({ id: "r1", agent: "coding" }), run({ id: "r0", agent: "review", session: closed })],
        "coding",
      ),
    ).toBeUndefined();
  });
});

describe("refusedRequestsOf — the requests the provider refused under its usage policy", () => {
  it("the request row of every finished run of the agent whose record says failure: policy_refusal and names its session; a run failed otherwise, another agent's, a live one and one without a session count for nothing", () => {
    const refused = (id: string, request: number, over: Partial<RunView> = {}): RunView =>
      run({
        id,
        agent: "coding",
        status: "failed",
        failure: { kind: "policy_refusal" },
        session: { ...closed, request },
        ...over,
      });
    expect(
      refusedRequestsOf(
        [
          refused("r6", 43),
          refused("r5", 42),
          run({ id: "r4", agent: "coding", status: "failed", session: closed }),
          refused("r3", 30, { agent: "review" }),
          refused("live", 29, { finished: false }),
          refused("r1", 28, { session: undefined }),
        ],
        "coding",
      ),
    ).toEqual([43, 42]);
    expect(refusedRequestsOf([], "coding")).toEqual([]);
  });
});

describe("threadPrOf — the pull request the thread's work lives on (docs/reference/specs/resident-repos.md item 29)", () => {
  const pr = (number: number) => ({ number, url: `https://github.com/acme/api/pull/${number}` });

  it("the newest finished run that recorded an opened pull request — its repo, its number and when it ended — past a live run and a run that opened none", () => {
    const runs = [
      run({ id: "live", agent: "coding", finished: false, repo: "acme/api" }),
      run({ id: "r3", agent: "review", finishedAt: 3_000, repo: "acme/api", session: closed }),
      run({ id: "r2", agent: "coding", finishedAt: 2_000, repo: "acme/api", pr: pr(7) }),
      run({ id: "r1", agent: "coding", finishedAt: 1_000, repo: "acme/api", pr: pr(6) }),
    ];
    expect(threadPrOf(runs)).toEqual({
      repo: "acme/api",
      number: 7,
      at: 2_000,
    });
  });

  it("nothing when no finished run in the page recorded one, when the run's record names no repository, or the thread has no run", () => {
    expect(
      threadPrOf([run({ id: "r1", agent: "coding", finishedAt: 1_000, repo: "acme/api", session: closed })]),
    ).toBeUndefined();
    expect(threadPrOf([run({ id: "r1", agent: "coding", finishedAt: 1_000, pr: pr(7) })])).toBeUndefined();
    expect(
      threadPrOf([run({ id: "live", agent: "coding", finished: false, repo: "acme/api", pr: pr(7) })]),
    ).toBeUndefined();
    expect(threadPrOf([])).toBeUndefined();
  });
});

describe("runsSince — the finished runs newer than the agent's previous run (session-log item 9)", () => {
  // The page newest first: a live run, another agent's run, a coordinator's child, the agent's previous
  // run, a run of the agent from before the log (not continuable), an older run of another agent.
  const page: RunView[] = [
    run({ id: "r6", agent: "general", finished: false }),
    run({ id: "r5", agent: "review", session: closed }),
    run({ id: "r4", agent: "review", session: closed, parentInstanceId: "inst-1", idempotencyKey: "inst-1:review-1" }),
    run({ id: "r3", agent: "coding", session: closed }),
    run({ id: "r2", agent: "coding" }),
    run({ id: "r1", agent: "review", session: closed }),
  ];

  it("the finished runs before the agent's previous continuable run on the page, oldest first — another agent's run and a coordinator's child alike; a live run and the previous run itself are left out", () => {
    expect(runsSince(page, "coding").map((r) => r.id)).toEqual(["r4", "r5"]);
  });

  it("an agent with no continuable run in the thread is handed every finished run, oldest first", () => {
    expect(runsSince(page, "explore").map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    // A run of the agent from before the log is not a previous run to continue: everything finished is since.
    expect(
      runsSince(
        [run({ id: "r6", agent: "general", finished: false }), run({ id: "r2", agent: "coding" })],
        "coding",
      ).map((r) => r.id),
    ).toEqual(["r2"]);
  });

  it("nothing newer than the previous run is an empty list; an empty page too", () => {
    expect(runsSince(page, "review")).toEqual([]);
    expect(runsSince([], "coding")).toEqual([]);
  });
});

// Feature: record 0051's owner rule (routing-and-config item 21) — the thread's owner
// for its life: the live run, else the unfinished unit of the page's instance
// whose row names this thread, else the newest continuable session a person
// addressed, else none. The unit read costs the page plus at most one read of
// the instance's unit rows.
describe("ownerOf and instanceOf — the thread's owner (record 0051's owner rule)", () => {
  const THREAD = "slack:C1:1.0";
  const unit = (over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
    instanceId: "ship_acme_api_1",
    unit: "U12",
    slug: "u12",
    branch: "plan/orchestration/u12",
    dependsOn: [],
    rounds: [],
    threadKey: THREAD,
    ...over,
  });

  it("finds an older completed publication when a newer stopped pipeline shadows its thread", async () => {
    const stopped = run({ id: "stopped", agent: "ship", instanceId: "ship-stopped", finishedAt: 3_000 });
    const completed = run({ id: "completed", agent: "ship", instanceId: "ship-published", finishedAt: 2_000 });
    const unitsOf = vi.fn(async (id: string) =>
      id === "ship-stopped"
        ? [
            unit({
              instanceId: id,
              pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
              ending: { kind: "stopped", report: "stopped", at: 3_000 },
            }),
          ]
        : [
            unit({
              instanceId: id,
              pr: { number: 8, url: "https://github.com/acme/api/pull/8" },
              publication: {
                repo: "acme/api",
                pr: 8,
                headRef: "plan/orchestration/u12",
                baseRef: "main",
                expectedHeadSha: "a".repeat(40),
                publicationRef: "plan/orchestration/u12",
                owner: { instanceId: id, unit: "U12" },
              },
              ending: { kind: "merge_ready", report: "ready", at: 2_000 },
            }),
          ],
    );
    expect(await releasedPrOf([stopped, completed], unitsOf, THREAD, 8)).toEqual({
      repo: "acme/api",
      number: 8,
      at: 2_000,
    });
    expect(await releasedPrOf([stopped, completed], unitsOf, THREAD, 7)).toBeUndefined();
  });

  it("owner is the live run when one is live — before any unit or session", async () => {
    const live = run({ id: "r-live", finished: false, instanceId: "ship_acme_api_1" });
    const unitsOf = vi.fn(async () => [unit()]);
    expect(await ownerOf([live, run({ id: "r-old", agent: "coding", session: closed })], unitsOf, THREAD)).toEqual({
      kind: "live",
      run: live,
    });
    expect(unitsOf).not.toHaveBeenCalled();
  });

  it("a hosted Ship parent yields to its live child, then the idle unit in their shared thread", async () => {
    const hosted = run({
      id: "ship-parent",
      agent: "ship",
      instanceId: "ship_acme_api_1",
      hosted: true,
      finished: false,
    });
    const child = run({
      id: "coding-child",
      agent: "coding",
      parentInstanceId: "ship_acme_api_1",
      finished: false,
    });
    const unitsOf = vi.fn(async () => [unit()]);

    expect(await ownerOf([hosted, child], unitsOf, THREAD)).toEqual({ kind: "live", run: child });
    expect(unitsOf).not.toHaveBeenCalled();
    expect(await ownerOf([hosted], unitsOf, THREAD)).toEqual({
      kind: "unit",
      instanceId: "ship_acme_api_1",
      unit: unit(),
    });
    expect(unitsOf).toHaveBeenCalledExactlyOnceWith("ship_acme_api_1");
  });

  it("a hosted Ship parent still guards its seed thread when no unit claims it", async () => {
    const hosted = run({
      id: "ship-parent",
      agent: "ship",
      instanceId: "ship_acme_api_1",
      hosted: true,
      finished: false,
    });
    expect(await ownerOf([hosted], async () => [unit({ threadKey: "slack:C1:9.9" })], THREAD)).toEqual({
      kind: "live",
      run: hosted,
    });
  });

  it("owner is the unfinished unit when the page's ship run names its instance and the row names this thread", async () => {
    const ship = run({ id: "r-ship", agent: "ship", instanceId: "ship_acme_api_1", session: closed });
    const unitsOf = vi.fn(async () => [unit()]);
    expect(await ownerOf([ship], unitsOf, THREAD)).toEqual({
      kind: "unit",
      instanceId: "ship_acme_api_1",
      unit: unit(),
    });
    expect(unitsOf).toHaveBeenCalledExactlyOnceWith("ship_acme_api_1");
  });

  it("owner is the unfinished unit when only a child's parentInstanceId names the instance", async () => {
    const child = run({ id: "r-child", agent: "coding", parentInstanceId: "ship_acme_api_1", session: closed });
    expect(await ownerOf([child], async () => [unit()], THREAD)).toMatchObject({ kind: "unit" });
  });

  it("owner falls to the sticky session when every unit for the thread has an ending, and a coordinator's child is never the owner", async () => {
    const ended = unit({ ending: { kind: "merged", report: "merged", at: 2_000 } });
    const child = run({ id: "r-child", agent: "coding", parentInstanceId: "ship_acme_api_1", session: closed });
    const person = run({ id: "r-person", agent: "review", session: closed });
    // The person's addressed session is the owner; the child alone owns nothing.
    expect(await ownerOf([child, person], async () => [ended], THREAD)).toEqual({ kind: "session", agent: "review" });
    expect(await ownerOf([child], async () => [ended], THREAD)).toEqual({ kind: "none" });
  });

  it("a watching unit owns its thread (record 0071, mechanism three): a merge-ready wait leaves the row without an ending, so an addressed reply is the unit's turn and never the router's", async () => {
    // With watch until merge on, a unit whose pull request reached merge-ready
    // stays registered in the merge-ready book and its row carries no ending
    // while it waits — exactly the unfinished-unit clause, so the reply is
    // appended to the unit's events (thread-admission item 9), not routed.
    const watching = unit({ pr: { number: 7, url: "https://github.com/acme/api/pull/7" } });
    const child = run({ id: "r-child", agent: "coding", parentInstanceId: "ship_acme_api_1", session: closed });
    expect(await ownerOf([child], async () => [watching], THREAD)).toEqual({
      kind: "unit",
      instanceId: "ship_acme_api_1",
      unit: watching,
    });
    // With the watch off, merge_ready is an ended kind exactly as today: the
    // row carries the ending and the thread is the router's again.
    const endedMergeReady = unit({
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      publication: {
        repo: "acme/api",
        pr: 7,
        headRef: "plan/orchestration/u12",
        baseRef: "main",
        expectedHeadSha: "a".repeat(40),
        publicationRef: "plan/orchestration/u12",
        owner: { instanceId: "ship_acme_api_1", unit: "U12" },
      },
      ending: { kind: "merge_ready", report: "merge-ready", at: 2_000 },
    });
    expect(await ownerOf([child], async () => [endedMergeReady], THREAD)).toEqual({
      kind: "none",
      releasedPr: { repo: "acme/api", number: 7, at: 2_000 },
    });
    const ship = run({ id: "ship-parent", agent: "ship", instanceId: "ship_acme_api_1", finished: true });
    expect(await ownerOf([ship], async () => [endedMergeReady], THREAD)).toEqual({
      kind: "none",
      releasedPr: { repo: "acme/api", number: 7, at: 2_000 },
    });
    const inconsistent = { ...endedMergeReady, pr: { number: 8, url: "https://github.com/acme/api/pull/8" } };
    expect(await ownerOf([ship], async () => [inconsistent], THREAD)).toEqual({ kind: "none" });
    const legacy = unit({
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      ending: { kind: "merge_ready", report: "merge-ready", at: 2_000 },
    });
    expect(await ownerOf([ship], async () => [legacy], THREAD)).toMatchObject({ kind: "pipeline", unit: legacy });
  });

  it("an ended ship pipeline still owns an aborted unit's thread, but multiple ended units in one thread are ambiguous", async () => {
    const aborted = unit({ ending: { kind: "aborted", report: "aborted", at: 2_000 } });
    const ship = run({
      id: "ship-parent",
      agent: "ship",
      instanceId: "ship_acme_api_1",
      finished: true,
    });
    expect(await ownerOf([ship], async () => [aborted], THREAD)).toEqual({
      kind: "pipeline",
      instanceId: "ship_acme_api_1",
      run: ship,
      unit: aborted,
    });
    const second = unit({ unit: "U13", slug: "u13", ending: { kind: "review_pending", report: "pending", at: 2_100 } });
    expect(await ownerOf([ship], async () => [aborted, second], THREAD)).toEqual({
      kind: "pipeline_ambiguous",
      instanceId: "ship_acme_api_1",
      run: ship,
      units: [aborted, second],
    });
    const merged = unit({ ending: { kind: "merged", report: "merged", at: 2_000 } });
    expect(await ownerOf([ship], async () => [merged], THREAD)).toEqual({ kind: "none" });
  });

  it("a unit row for another thread is not the owner, and an empty page owns nothing", async () => {
    const ship = run({ id: "r-ship", agent: "ship", instanceId: "ship_acme_api_1", session: closed });
    expect(await ownerOf([ship], async () => [unit({ threadKey: "slack:C1:9.9" })], THREAD)).toEqual({
      kind: "session",
      agent: "ship",
    });
    expect(await ownerOf([], async () => [], THREAD)).toEqual({ kind: "none" });
  });

  it("instanceOf reads the newest run's instance — a ship run's own instanceId or a child's parentInstanceId — and a failed unit read leaves the unit out", async () => {
    expect(instanceOf([run({ id: "a", instanceId: "i_1" }), run({ id: "b", parentInstanceId: "i_2" })])).toBe("i_1");
    expect(instanceOf([run({ id: "b", parentInstanceId: "i_2" })])).toBe("i_2");
    expect(instanceOf([run({ id: "c" })])).toBeUndefined();
    const ship = run({ id: "r-ship", agent: "ship", instanceId: "ship_acme_api_1", session: closed });
    expect(
      await ownerOf(
        [ship],
        async () => {
          throw new Error("store down");
        },
        THREAD,
      ),
    ).toEqual({ kind: "session", agent: "ship" });
  });
});
