import { describe, expect, it } from "vitest";
import {
  applyResidentsFrame,
  bindingFor,
  diskHeadroom,
  residentThreads,
  runsOnResident,
  threadTreeKiB,
  type ResidentsIndexState,
} from "./residentsModel.js";
import type { RunIndexRowSeed } from "./webSeed.js";

// The pure model the residents index and its feed share: the run → worktree
// join by thread key, the per-tree bytes, the headroom arithmetic, and the
// reducer the page applies to every feed frame.

const THREADS = [
  {
    threadKey: "slack:C1:1.1",
    ref: "feat/a",
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    user: "worker3",
    deps: "hardlink",
    boundAt: "2026-08-28T21:40:00.000Z",
    lastAttachAt: "2026-08-28T21:45:00.000Z",
    evicted: false,
  },
  {
    threadKey: "slack:C1:2.2",
    ref: "main",
    sha: null,
    user: "",
    deps: "reconcile",
    boundAt: "2026-08-20T10:00:00.000Z",
    lastAttachAt: "2026-08-29T10:05:00.000Z",
    evicted: true,
    evictedAt: "2026-08-29T10:00:00.000Z",
    evictedWhy: "merged #7",
  },
];
const RECORD = { resource: "repo:jshttp/vary", live: { state: "warm", threads: THREADS } };

const run = (id: string, over: Partial<RunIndexRowSeed> = {}): RunIndexRowSeed => ({
  id,
  finished: false,
  startedAt: 1000,
  eventCount: 1,
  token: `tok-${id}`,
  ...over,
});

describe("residentThreads", () => {
  it("normalizes every field to a string or boolean, newest attach first, and drops non-records", () => {
    const rows = residentThreads({ ...RECORD, live: { threads: [...THREADS, "junk", 7] } });
    expect(rows.map((t) => t.threadKey)).toEqual(["slack:C1:2.2", "slack:C1:1.1"]);
    expect(rows[1]).toEqual({
      threadKey: "slack:C1:1.1",
      ref: "feat/a",
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      user: "worker3",
      deps: "hardlink",
      boundAt: "2026-08-28T21:40:00.000Z",
      lastAttachAt: "2026-08-28T21:45:00.000Z",
      evicted: false,
      evictedAt: "",
      evictedWhy: "",
    });
    expect(rows[0].sha).toBe("");
    expect(rows[0].evicted).toBe(true);
  });

  it("is empty for a record with no threads, a malformed list, or an unreachable engine", () => {
    expect(residentThreads({ resource: "repo:a/b", live: {} })).toEqual([]);
    expect(residentThreads({ resource: "repo:a/b", live: { threads: "nope" } })).toEqual([]);
    expect(residentThreads({ resource: "repo:a/b", live: { error: "DO unreachable" } })).toEqual([]);
  });
});

describe("runsOnResident + bindingFor", () => {
  it("picks the live rows whose repo is the slug, oldest first, and joins each to its live binding by thread key", () => {
    const rows = [
      run("late", { repo: "jshttp/vary", threadKey: "slack:C1:1.1", startedAt: 3000 }),
      run("other", { repo: "acme/api", threadKey: "slack:C1:9.9" }),
      run("norepo", { threadKey: "slack:C1:1.1" }),
      run("done", { repo: "jshttp/vary", finished: true }),
      run("early", { repo: "jshttp/vary", threadKey: "slack:C1:2.2", startedAt: 2000 }),
    ];
    const on = runsOnResident(rows, "jshttp/vary");
    expect(on.map((r) => r.id)).toEqual(["early", "late"]);
    const threads = residentThreads(RECORD);
    expect(bindingFor(threads, "slack:C1:1.1")?.ref).toBe("feat/a");
    // An evicted binding is not the run's tree: the run has no worktree (yet, or any more).
    expect(bindingFor(threads, "slack:C1:2.2")).toBeUndefined();
    expect(bindingFor(threads, undefined)).toBeUndefined();
  });
});

describe("threadTreeKiB", () => {
  const disk = {
    at: "t",
    totalKiB: 100,
    usedKiB: 50,
    freeKiB: 50,
    parts: { mirror: 1, deps: 2, checkout: 3, threads: { "slack:C1:1.1": 541_860 }, homes: {}, other: 0 },
  };
  it("is the tree's own bytes from the last sample, null when unmeasured or unsampled", () => {
    expect(threadTreeKiB(disk, "slack:C1:1.1")).toBe(541_860);
    expect(threadTreeKiB(disk, "slack:C1:2.2")).toBeNull();
    expect(threadTreeKiB(null, "slack:C1:1.1")).toBeNull();
  });
});

describe("diskHeadroom", () => {
  // The residents.test.ts fixture: 14.4 GiB disk, 4.06 used, 10.3 free.
  const disk = {
    at: "2026-09-07T15:30:00.000Z",
    totalKiB: 15_086_920,
    usedKiB: 4_262_360,
    freeKiB: 10_808_176,
    parts: {
      mirror: 371_264,
      deps: 2_244_052,
      checkout: 462_888,
      threads: { "slack:C1:1.1": 541_860 },
      homes: { worker1: 4, worker3: 2_100_000 },
      other: 640_000,
    },
  };
  it("is the budget arithmetic the admission runs: free under the cap, the reserve, and the room in trees of each kind", () => {
    const h = diskHeadroom(disk, undefined);
    expect(h.capped).toBe(false);
    expect(h.freeKiB).toBe(10_808_176);
    expect(h.reserve.totalKiB).toBeGreaterThan(0);
    expect(h.headroomKiB).toBe(Math.max(0, h.freeKiB - h.reserve.totalKiB));
    expect(h.room.hardlink).toBe(17);
    expect(h.room.reconcile).toBe(7);
  });
  it("caps the free space under diskBudgetMb and says so; an unmeasured checkout has no room figure", () => {
    const capped = diskHeadroom(disk, 8 * 1024);
    expect(capped.capped).toBe(true);
    expect(capped.capacityKiB).toBe(8 * 1024 * 1024);
    expect(capped.freeKiB).toBe(8 * 1024 * 1024 - 4_262_360);
    const unmeasured = diskHeadroom({ ...disk, parts: { ...disk.parts, checkout: null } }, undefined);
    expect(unmeasured.room.hardlink).toBeNull();
  });
});

describe("applyResidentsFrame", () => {
  const state = (): ResidentsIndexState => ({
    cap: 5,
    count: 1,
    residents: [RECORD],
    runs: new Map([["a", run("a", { repo: "jshttp/vary" })]]),
  });

  it("a live upsert sets the row, a finished upsert removes it (the fold lists what is running), removed removes", () => {
    const s = state();
    applyResidentsFrame(s, { type: "upsert", run: run("b", { repo: "jshttp/vary" }) });
    expect([...s.runs.keys()]).toEqual(["a", "b"]);
    applyResidentsFrame(s, { type: "upsert", run: run("a", { repo: "jshttp/vary", finished: true }) });
    expect([...s.runs.keys()]).toEqual(["b"]);
    applyResidentsFrame(s, { type: "removed", id: "b" });
    expect(s.runs.size).toBe(0);
    applyResidentsFrame(s, { type: "removed", id: "never-seen" });
    expect(s.runs.size).toBe(0);
  });

  it("a residents frame replaces the listing whole — cap, count and every record", () => {
    const s = state();
    const fresh = { resource: "repo:jshttp/vary", live: { state: "refreshing", threads: [] } };
    applyResidentsFrame(s, { type: "residents", cap: 6, count: 2, residents: [fresh, RECORD] });
    expect(s.cap).toBe(6);
    expect(s.count).toBe(2);
    expect(s.residents).toEqual([fresh, RECORD]);
    expect(s.runs.size).toBe(1); // the runs are the registry's, untouched by a listing
  });

  it("an unknown or malformed frame changes nothing", () => {
    const s = state();
    applyResidentsFrame(s, { type: "upsert" } as never);
    applyResidentsFrame(s, { type: "what" } as never);
    applyResidentsFrame(s, "garbage" as never);
    expect(s.runs.size).toBe(1);
    expect(s.residents).toEqual([RECORD]);
  });
});
