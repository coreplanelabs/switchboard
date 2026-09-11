import { describe, expect, it } from "vitest";
import {
  LAST_FETCH_KEY,
  planBuild,
  planFetchMirror,
  planInstallDeps,
  planMaterializeDeps,
  planRestore,
  planSnapshot,
  snapshotCommitDecision,
  type BuildDisk,
  type FetchRecord,
  type SnapshotStamp,
  type StampedRecord,
} from "./residentStepPlan.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const NOW = 1_700_000_000_000;

/** A step is idempotent when a second call over the facts the first call left
 *  behind finds the work done and issues no command. Each step below is run
 *  through a tiny driver: `plan` decides, `apply` mutates the facts the way the
 *  Worker's method would, and the command log is asserted to hold exactly one
 *  entry after two calls. */
function runTwice<F>(input: { facts: F; plan: (facts: F) => { action: "done" | "run" }; apply: (facts: F) => F }) {
  const commands: string[] = [];
  let facts = input.facts;
  for (let i = 0; i < 2; i++) {
    const p = input.plan(facts);
    if (p.action === "run") {
      commands.push(`run#${i + 1}`);
      facts = input.apply(facts);
    }
  }
  return { commands, facts, finalPlan: input.plan(facts) };
}

describe("planFetchMirror — a cycle fetches a ref once", () => {
  const last: FetchRecord = { cycle: "c1", ref: "main", sha: NEW, at: NOW };
  it("no record yet → run", () => {
    expect(planFetchMirror({ ref: "main", cycle: "c1", last: undefined })).toEqual({
      action: "run",
      why: "no fetch recorded for this cycle",
    });
  });
  it("this cycle already fetched this ref → done with the sha it recorded", () => {
    expect(planFetchMirror({ ref: "main", cycle: "c1", last })).toEqual({
      action: "done",
      why: "cycle c1 already fetched main",
      sha: NEW,
    });
  });
  it("another cycle's record, or another ref, is not this step's work", () => {
    expect(planFetchMirror({ ref: "main", cycle: "c2", last })).toMatchObject({ action: "run" });
    expect(planFetchMirror({ ref: "release", cycle: "c1", last })).toMatchObject({ action: "run" });
  });
  it("called twice: one command, the second call is done", () => {
    const r = runTwice<FetchRecord | undefined>({
      facts: undefined,
      plan: (last) => planFetchMirror({ ref: "main", cycle: "c1", last }),
      apply: () => ({ cycle: "c1", ref: "main", sha: NEW, at: NOW }),
    });
    expect(r.commands).toEqual(["run#1"]);
    expect(r.finalPlan).toMatchObject({ action: "done", sha: NEW });
  });
  it("the record lives under its own storage key", () => {
    expect(LAST_FETCH_KEY).toBe("resident:lastFetch");
  });
});

describe("planInstallDeps — the store entry is the fact", () => {
  it("a complete entry for the key → done; no entry → run", () => {
    expect(planInstallDeps({ key: KEY_A, entryComplete: true })).toEqual({
      action: "done",
      why: `store entry ${KEY_A.slice(0, 8)} is complete`,
    });
    expect(planInstallDeps({ key: KEY_A, entryComplete: false })).toEqual({
      action: "run",
      why: `no complete store entry for ${KEY_A.slice(0, 8)}`,
    });
  });
  it("called twice: one install, then done", () => {
    const r = runTwice<{ complete: Set<string> }>({
      facts: { complete: new Set() },
      plan: (f) => planInstallDeps({ key: KEY_A, entryComplete: f.complete.has(KEY_A) }),
      apply: (f) => ({ complete: new Set([...f.complete, KEY_A]) }),
    });
    expect(r.commands).toEqual(["run#1"]);
    expect(r.finalPlan.action).toBe("done");
  });
});

describe("planBuild — the checkout's markers decide, through the refresh planner", () => {
  const disk = (over: Partial<BuildDisk> = {}): BuildDisk => ({
    head: OLD,
    installedKey: KEY_A,
    installingKey: null,
    builtSha: OLD,
    ...over,
  });
  it("the recorded facts are already at the target sha → done (the last completed cycle built it)", () => {
    expect(planBuild({ sha: OLD, factsSha: OLD, lockfileKey: KEY_A, disk: disk() })).toEqual({
      action: "done",
      why: `facts already at ${OLD.slice(0, 8)}`,
    });
  });
  it("HEAD, deps and build all at the target → done (an interrupted cycle got this far)", () => {
    const p = planBuild({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: NEW }) });
    expect(p.action).toBe("done");
    expect(p.why).toMatch(/already materialized/);
  });
  it("lockfile key unchanged, HEAD behind → run without install on a keep-deps clean", () => {
    expect(planBuild({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk() })).toMatchObject({
      action: "run",
      install: false,
      clean: "keep-deps",
    });
  });
  it("lockfile key changed → run with install on a full clean; a resumed install keeps its partial tree", () => {
    expect(planBuild({ sha: NEW, factsSha: OLD, lockfileKey: KEY_B, disk: disk() })).toMatchObject({
      action: "run",
      install: true,
      clean: "all",
    });
    expect(
      planBuild({
        sha: NEW,
        factsSha: OLD,
        lockfileKey: KEY_B,
        disk: disk({ installedKey: null, installingKey: KEY_B, builtSha: null }),
      }),
    ).toMatchObject({ action: "run", install: true, clean: "keep-deps" });
  });
  it("called twice: one build, then done — the markers the build leaves are the proof", () => {
    const r = runTwice<BuildDisk>({
      facts: disk(),
      plan: (d) => planBuild({ sha: NEW, factsSha: OLD, lockfileKey: KEY_B, disk: d }),
      apply: () => ({ head: NEW, installedKey: KEY_B, installingKey: null, builtSha: NEW }),
    });
    expect(r.commands).toEqual(["run#1"]);
    expect(r.finalPlan.action).toBe("done");
  });
});

describe("planSnapshot + snapshotCommitDecision — one snapshot per stamp, committed only over the record it read", () => {
  const stamp: SnapshotStamp = { ref: "main", sha: NEW, lockfileHash: KEY_A };
  const record = (over: Partial<StampedRecord> = {}): StampedRecord => ({
    ...stamp,
    createdAt: "2000-01-01T00:00:00.000Z",
    ...over,
  });
  it("no record, or a record at another stamp → run; the record at this stamp → done", () => {
    expect(planSnapshot({ stamp, current: undefined })).toEqual({ action: "run", why: "no snapshot recorded" });
    expect(planSnapshot({ stamp, current: record({ sha: OLD }) })).toMatchObject({ action: "run" });
    expect(planSnapshot({ stamp, current: record() })).toEqual({
      action: "done",
      why: `snapshot already at {main, ${NEW.slice(0, 8)}, ${KEY_A.slice(0, 8)}}`,
    });
  });
  it("the stamp moved since the read → superseded, never a throw; unchanged (or both absent) → commit", () => {
    expect(snapshotCommitDecision({ readAtStart: undefined, current: undefined })).toEqual({ action: "commit" });
    expect(snapshotCommitDecision({ readAtStart: record({ sha: OLD }), current: record({ sha: OLD }) })).toEqual({
      action: "commit",
    });
    expect(snapshotCommitDecision({ readAtStart: undefined, current: record() })).toEqual({
      action: "superseded",
      by: record(),
    });
    expect(
      snapshotCommitDecision({
        readAtStart: record({ sha: OLD }),
        current: record({ sha: OLD, createdAt: "2000-01-02T00:00:00.000Z" }),
      }),
    ).toMatchObject({ action: "superseded" });
    expect(snapshotCommitDecision({ readAtStart: record(), current: undefined })).toMatchObject({
      action: "superseded",
      by: undefined,
    });
  });
  it("called twice: one upload, then done", () => {
    const r = runTwice<StampedRecord | undefined>({
      facts: record({ sha: OLD }),
      plan: (current) => planSnapshot({ stamp, current }),
      apply: () => record(),
    });
    expect(r.commands).toEqual(["run#1"]);
    expect(r.finalPlan.action).toBe("done");
  });
});

describe("planRestore — the ready marker proves the disk", () => {
  it("the ready marker names the stamp's sha → done; anything else → run", () => {
    expect(planRestore({ sha: NEW, readyStamp: NEW })).toEqual({
      action: "done",
      why: `disk already holds ${NEW.slice(0, 8)}`,
    });
    expect(planRestore({ sha: NEW, readyStamp: OLD })).toEqual({
      action: "run",
      why: `disk holds ${OLD.slice(0, 8)}, the stamp says ${NEW.slice(0, 8)}`,
    });
    expect(planRestore({ sha: NEW, readyStamp: null })).toEqual({
      action: "run",
      why: `disk holds nothing, the stamp says ${NEW.slice(0, 8)}`,
    });
  });
  it("called twice: one restore, then done", () => {
    const r = runTwice<string | null>({
      facts: null,
      plan: (ready) => planRestore({ sha: NEW, readyStamp: ready }),
      apply: () => NEW,
    });
    expect(r.commands).toEqual(["run#1"]);
    expect(r.finalPlan.action).toBe("done");
  });
});

describe("planMaterializeDeps — the checkout's view is the fact", () => {
  it("a view already in the checkout → done; none → run, saying whether the entry must be produced first", () => {
    expect(planMaterializeDeps({ key: KEY_A, viewPresent: true, entryComplete: false })).toEqual({
      action: "done",
      why: "the checkout holds its dependency view",
    });
    expect(planMaterializeDeps({ key: KEY_A, viewPresent: false, entryComplete: true })).toEqual({
      action: "run",
      why: `link the complete entry ${KEY_A.slice(0, 8)}`,
      needsEntry: false,
    });
    expect(planMaterializeDeps({ key: KEY_A, viewPresent: false, entryComplete: false })).toEqual({
      action: "run",
      why: `materialize ${KEY_A.slice(0, 8)} into the store, then link it`,
      needsEntry: true,
    });
  });
  it("called twice: one materialization, then done", () => {
    const r = runTwice<{ view: boolean; entry: boolean }>({
      facts: { view: false, entry: false },
      plan: (f) => planMaterializeDeps({ key: KEY_A, viewPresent: f.view, entryComplete: f.entry }),
      apply: () => ({ view: true, entry: true }),
    });
    expect(r.commands).toEqual(["run#1"]);
    expect(r.finalPlan.action).toBe("done");
  });
});
