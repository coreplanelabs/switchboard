import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSession } from "../runRecord.js";
import type { RunView } from "../runsService.js";
import type { RunEvent } from "../runEvents.js";
import {
  previousRunOf,
  readThread,
  readThreadArtifacts,
  stickyAgentOf,
  THREAD_READ_LIMIT,
  threadPrOf,
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

// execution.md item 20 (record 0033): the files the thread received before this
// run, read from the prior runs' records — every page of every run, since a
// steer's file lands wherever in the log the steer did.
describe("readThreadArtifacts — the thread's received files from its records", () => {
  const inEvent = (key: string, name: string): RunEvent => ({
    type: "artifact",
    direction: "in",
    key,
    name,
    size: 10,
    contentType: "video/mp4",
  });
  const filler = (n: number): RunEvent[] =>
    Array.from({ length: n }, (_, i) => ({ type: "assistant", text: `step ${i}` }) as RunEvent);
  /** A service whose events come in pages of `pageSize`, `nextAfterSeq` while more follow. */
  const paged = (byRun: Record<string, RunEvent[]>, pageSize: number) => {
    const reads: Array<{ id: string; afterSeq?: number }> = [];
    const getRunEvents = vi.fn(async (id: string, opts: { afterSeq?: number }) => {
      reads.push({ id, ...(opts.afterSeq !== undefined ? { afterSeq: opts.afterSeq } : {}) });
      const all = byRun[id];
      if (!all) return { ok: false as const, error: "not_found" as const };
      const from = opts.afterSeq ?? 0;
      const events = all.slice(from, from + pageSize);
      const end = from + events.length;
      return { ok: true as const, value: { events, ...(end < all.length ? { nextAfterSeq: end } : {}) } };
    });
    return { getRunEvents, reads };
  };

  it("pages every prior run to its end — an `in` event on a late page (a steered file) is found — oldest run first, one entry per key", async () => {
    const older = [inEvent("threads/t/in/1/1-a.mp4", "a.mp4"), ...filler(30)];
    const newer = [
      ...filler(45),
      inEvent("threads/t/in/9/1-late.mp4", "late.mp4"),
      inEvent("threads/t/in/1/1-a.mp4", "a.mp4"),
    ];
    const svc = paged({ older, newer }, 10);
    const found = await readThreadArtifacts(svc, [run({ id: "newer" }), run({ id: "older" })]);
    expect(found.map((a) => a.key)).toEqual(["threads/t/in/1/1-a.mp4", "threads/t/in/9/1-late.mp4"]);
    // older: 31 events in 4 pages; newer: 47 events in 5 pages — every page read, none capped.
    expect(svc.reads.filter((r) => r.id === "older")).toHaveLength(4);
    expect(svc.reads.filter((r) => r.id === "newer")).toHaveLength(5);
    expect(svc.reads[0]).toEqual({ id: "older" });
  });

  it("a page the service refuses stops that run's read with what was read so far and a warning naming the run; a throw does the same; the other runs still count", async () => {
    const warnings: string[] = [];
    const first = [inEvent("threads/t/in/1/1-a.mp4", "a.mp4"), ...filler(15)];
    const svc = paged({ first }, 10);
    const found = await readThreadArtifacts(
      svc,
      [run({ id: "gone" }), run({ id: "first" })],
      (line) => void warnings.push(line),
    );
    expect(found.map((a) => a.key)).toEqual(["threads/t/in/1/1-a.mp4"]);
    expect(warnings).toEqual(["[thread] gone: reading its received files stopped after 0 event(s) — not_found"]);
    const throwing = {
      getRunEvents: vi.fn(async () => {
        throw new Error("store down");
      }),
    };
    const warned: string[] = [];
    expect(await readThreadArtifacts(throwing, [run({ id: "r1" })], (line) => void warned.push(line))).toEqual([]);
    expect(warned).toEqual(["[thread] r1: reading its received files failed after 0 event(s) — store down"]);
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
