import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSession } from "../runRecord.js";
import type { RunView } from "../runsService.js";
import {
  previousRunOf,
  readThread,
  refusedRequestsOf,
  runsSince,
  stickyAgentOf,
  THREAD_READ_LIMIT,
  threadPrOf,
  threadRouteOf,
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
