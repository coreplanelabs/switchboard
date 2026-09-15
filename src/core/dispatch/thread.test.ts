import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSession } from "../runRecord.js";
import type { RunView } from "../runsService.js";
import { previousRunOf, readThread, stickyAgentOf, THREAD_READ_LIMIT, threadPrOf } from "./thread.js";

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
const onPi = (agent: string) => agent === "coding";

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
  it("the newest run's agent when that run finished with a session log and runs on the pi harness", () => {
    expect(
      stickyAgentOf([run({ id: "r2", agent: "coding", session: closed }), run({ id: "r1", agent: "review" })], onPi),
    ).toBe("coding");
  });

  it("nothing when the newest run is live, has no session log (refused at a gate, or from before the log), runs on the native loop, or the thread has no run", () => {
    expect(
      stickyAgentOf([run({ id: "live", agent: "coding", finished: false, session: closed })], onPi),
    ).toBeUndefined();
    expect(stickyAgentOf([run({ id: "r1", agent: "coding" })], onPi)).toBeUndefined();
    expect(stickyAgentOf([run({ id: "r1", agent: "review", session: closed })], onPi)).toBeUndefined();
    expect(stickyAgentOf([], onPi)).toBeUndefined();
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
