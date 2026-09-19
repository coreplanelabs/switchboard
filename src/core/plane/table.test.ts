import { describe, expect, it } from "vitest";
import type { RunView } from "../runsService.js";
import type { InstanceFacts, UnitFacts } from "../unitRuns.js";
import {
  buildPlaneTable,
  prHealthOf,
  runHealthOf,
  unitHealthOf,
  unitIdOfRun,
  type PlanePullRequestFacts,
} from "./table.js";

// The plane's table (docs/reference/specs/orchestration-plane.md items 1-3): every
// live and recently ended run, every tracked pull request and every unit, each
// with an owner and its health flags, derived from facts the stores already
// hold. Pure: the service reads, this module says what the rows mean, so the
// command's text, the page and the tests agree on every word.

const NOW = Date.parse("2026-09-19T03:00:00Z");
const MIN = 60_000;

function run(over: Partial<RunView> & { id: string }): RunView {
  return { startedAt: NOW - 20 * MIN, finished: false, eventCount: 40, agent: "coding", ...over };
}

const INSTANCE: InstanceFacts = {
  id: "plan-example-2",
  repo: "acme/api",
  createdAt: NOW - 60 * MIN,
  runId: "parent-1",
};

function unit(over: Partial<UnitFacts> & { id: string }): UnitFacts {
  return {
    unit: `${INSTANCE.id}:${over.id}`,
    instanceId: INSTANCE.id,
    branch: `plan/example/${over.id.toLowerCase()}`,
    threads: {},
    sourceUrls: {},
    rounds: [],
    ...over,
  };
}

function pr(over: Partial<PlanePullRequestFacts> = {}): PlanePullRequestFacts {
  return { repo: "acme/api", number: 41, state: "open", headSha: "a".repeat(40), titleOk: true, ...over };
}

describe("runHealthOf — a live run's flags from the pace facts and its status", () => {
  it("a live run of this process with a fresh tool call has no flag", () => {
    const r = run({ id: "r1", eventsLast5m: 12, lastToolCallAt: NOW - MIN });
    expect(runHealthOf(r, NOW)).toEqual([]);
  });
  it("a live run with no tool call for a whole window is stalled", () => {
    const r = run({ id: "r1", eventsLast5m: 0, lastToolCallAt: NOW - 9 * MIN });
    expect(runHealthOf(r, NOW)).toEqual(["stalled"]);
  });
  it("a call past its own declared bound is bound-exceeded, and outranks stalled", () => {
    const r = run({
      id: "r1",
      eventsLast5m: 0,
      lastToolCallAt: NOW - 30 * MIN,
      inFlight: { tool: "bash", since: NOW - 30 * MIN, boundMs: 10 * MIN },
    });
    expect(runHealthOf(r, NOW)).toEqual(["bound-exceeded", "stalled"]);
  });
  it("a row live under another generation carries no pace fact and reads no-signal, never stalled", () => {
    const r = run({ id: "r1", ownerGen: "gen-b" });
    expect(runHealthOf(r, NOW)).toEqual(["no-signal"]);
  });
  it("a provisional record and an interrupted or failed ending are named", () => {
    expect(runHealthOf(run({ id: "r1", finished: true, provisional: true }), NOW)).toEqual(["provisional"]);
    expect(runHealthOf(run({ id: "r2", finished: true, status: "interrupted" }), NOW)).toEqual(["interrupted"]);
    expect(runHealthOf(run({ id: "r3", finished: true, status: "failed" }), NOW)).toEqual(["failed"]);
    expect(runHealthOf(run({ id: "r4", finished: true, status: "completed" }), NOW)).toEqual([]);
  });
});

describe("prHealthOf — a tracked pull request's flags from the merge door's facts", () => {
  it("an open pull request with green checks and an approval at its head is merge-ready", () => {
    const facts = pr({ checks: { total: 3, pending: [], failed: [] }, approvedAtHead: true, mergeableState: "clean" });
    expect(prHealthOf(facts)).toEqual(["approved"]);
  });
  it("a red check at an approved head is red, a conflict is dirty, a failing title is mistitled", () => {
    expect(prHealthOf(pr({ checks: { total: 3, pending: [], failed: ["ci / bot"] }, approvedAtHead: true }))).toEqual([
      "approved",
      "red",
    ]);
    expect(prHealthOf(pr({ mergeableState: "dirty" }))).toEqual(["dirty"]);
    expect(prHealthOf(pr({ titleOk: false }))).toEqual(["mistitled"]);
  });
  it("pending checks are named; a merged or closed pull request carries its state alone", () => {
    expect(prHealthOf(pr({ checks: { total: 2, pending: ["ci / bot"], failed: [] } }))).toEqual(["pending"]);
    expect(prHealthOf(pr({ state: "closed", mergedAt: "2026-09-19T02:00:00Z" }))).toEqual(["merged"]);
    expect(prHealthOf(pr({ state: "closed" }))).toEqual(["closed"]);
  });
  it("a pull request GitHub could not be read is unknown and nothing else", () => {
    expect(prHealthOf(pr({ unknown: true, titleOk: undefined }))).toEqual(["unknown"]);
  });
});

describe("unitHealthOf — a unit's flags from its ending and its runs", () => {
  it("a unit with no ending and a live run is live; with no ending and no run it is waiting", () => {
    expect(unitHealthOf(unit({ id: "U12" }), { live: true })).toEqual(["live"]);
    expect(unitHealthOf(unit({ id: "U12" }), { live: false })).toEqual(["waiting"]);
  });
  it("an idling ending kind (record 0051) reads idle with its kind; merged and merge-ready read as they are", () => {
    for (const kind of ["aborted", "wall_clock_cap", "review_pending", "interrupted", "stopped"]) {
      expect(unitHealthOf(unit({ id: "U12", ending: { kind, report: "", at: NOW } }), { live: false })).toEqual([
        "idle",
      ]);
    }
    expect(unitHealthOf(unit({ id: "U12", ending: { kind: "merged", report: "", at: NOW } }), { live: false })).toEqual(
      ["merged"],
    );
    expect(
      unitHealthOf(unit({ id: "U12", ending: { kind: "merge_ready", report: "", at: NOW } }), { live: false }),
    ).toEqual(["merge-ready"]);
  });
  it("a merge-ready unit whose pull request is still open is an owner gap", () => {
    const u = unit({
      id: "U12",
      pr: { number: 41, url: "https://example.test/pr/41" },
      ending: { kind: "merge_ready", report: "", at: NOW },
    });
    expect(unitHealthOf(u, { live: false, prOpen: true })).toEqual(["merge-ready", "owner-gap"]);
  });
});

describe("unitIdOfRun — which unit a coordinator child belongs to", () => {
  it("reads the unit off the spawn's idempotency key, else off the unit whose thread the run is in", () => {
    const byKey = run({ id: "r1", parentInstanceId: INSTANCE.id, idempotencyKey: `${INSTANCE.id}:U12/1/coding` });
    expect(unitIdOfRun(byKey, [unit({ id: "U12" })])).toBe("U12");
    const byThread = run({ id: "r2", parentInstanceId: INSTANCE.id, threadKey: "slack:C1:2.0" });
    expect(unitIdOfRun(byThread, [unit({ id: "U13", threads: { coding: "slack:C1:2.0" } })])).toBe("U13");
    expect(unitIdOfRun(run({ id: "r3" }), [])).toBeUndefined();
  });
});

describe("buildPlaneTable — the rows, their owners and their order", () => {
  it("lists live runs first, stalled before healthy, then recently ended; names each owner", () => {
    const live = run({
      id: "live-1",
      eventsLast5m: 3,
      lastToolCallAt: NOW - MIN,
      userId: "slack:U_ALICE",
      userName: "alice",
    });
    const stalled = run({ id: "live-2", eventsLast5m: 0, lastToolCallAt: NOW - 8 * MIN, userId: "slack:U_BOB" });
    const foreign = run({ id: "live-3", ownerGen: "gen-b" });
    const done = run({ id: "done-1", finished: true, status: "completed", finishedAt: NOW - 5 * MIN });
    const table = buildPlaneTable({ now: NOW, runs: [done, live, foreign, stalled], instances: [], pullRequests: [] });
    expect(table.runs.map((r) => r.run.id)).toEqual(["live-2", "live-1", "live-3", "done-1"]);
    expect(table.runs[0].owner).toEqual({ id: "slack:U_BOB" });
    expect(table.runs[1].owner).toEqual({ id: "slack:U_ALICE", name: "alice" });
    expect(table.runs[2].owner).toEqual({ generation: "gen-b" });
    expect(table.at).toBe(NOW);
  });
  it("joins units to their instance and their runs, and pull requests to the unit that owns them", () => {
    const child = run({
      id: "child-1",
      parentInstanceId: INSTANCE.id,
      idempotencyKey: `${INSTANCE.id}:U12/0/coding`,
      eventsLast5m: 5,
      lastToolCallAt: NOW - MIN,
    });
    const u2 = unit({ id: "U12", title: "The table", pr: { number: 41, url: "https://example.test/pr/41" } });
    const u3 = unit({
      id: "U13",
      title: "The queue",
      ending: { kind: "merge_ready", report: "ok", at: NOW },
      pr: { number: 42, url: "https://example.test/pr/42" },
    });
    const table = buildPlaneTable({
      now: NOW,
      runs: [child],
      instances: [{ instance: INSTANCE, units: [u2, u3] }],
      pullRequests: [
        pr({ number: 41, checks: { total: 1, pending: ["ci / bot"], failed: [] } }),
        pr({ number: 42, approvedAtHead: true, checks: { total: 1, pending: [], failed: [] } }),
      ],
    });
    expect(table.runs[0].unit).toEqual({ key: `${INSTANCE.id}:U12`, id: "U12", title: "The table" });
    expect(table.units.map((u) => [u.unit.id, u.health])).toEqual([
      ["U12", ["live"]],
      ["U13", ["merge-ready", "owner-gap"]],
    ]);
    expect(table.units[0].instance).toEqual(INSTANCE);
    expect(table.pullRequests.map((p) => [p.pr.number, p.owner, p.health])).toEqual([
      [41, { unitKey: `${INSTANCE.id}:U12` }, ["pending"]],
      [42, { unitKey: `${INSTANCE.id}:U13` }, ["approved"]],
    ]);
  });
  it("a pull request a plain run opened is owned by that run; one nobody names is a person's", () => {
    const opener = run({
      id: "r1",
      finished: true,
      status: "completed",
      finishedAt: NOW - MIN,
      repo: "acme/api",
      pr: { number: 7, url: "https://example.test/pr/7" },
    });
    const table = buildPlaneTable({
      now: NOW,
      runs: [opener],
      instances: [],
      pullRequests: [pr({ number: 7 }), pr({ number: 8 })],
    });
    expect(table.pullRequests.map((p) => [p.pr.number, p.owner])).toEqual([
      [7, { runId: "r1" }],
      [8, { person: true }],
    ]);
  });
  it("carries empty windows and findings until the plane has them", () => {
    const table = buildPlaneTable({ now: NOW, runs: [], instances: [], pullRequests: [] });
    expect(table.windows).toEqual([]);
    expect(table.findings).toEqual([]);
  });
});

describe("buildPlaneTable — the owner gap when the pull request could not be read", () => {
  it("an unread pull request and one past the read cap both lean open: the gap is flagged either way", () => {
    const u = unit({ id: "U12", pr: { number: 41, url: "u" }, ending: { kind: "merge_ready", report: "", at: NOW } });
    const unread = buildPlaneTable({
      now: NOW,
      runs: [],
      instances: [{ instance: INSTANCE, units: [u] }],
      pullRequests: [pr({ number: 41, unknown: true, state: undefined })],
    });
    expect(unread.units[0].health).toEqual(["merge-ready", "owner-gap"]);
    const uncapped = buildPlaneTable({
      now: NOW,
      runs: [],
      instances: [{ instance: INSTANCE, units: [u] }],
      pullRequests: [],
    });
    expect(uncapped.units[0].health).toEqual(["merge-ready", "owner-gap"]);
    const closed = buildPlaneTable({
      now: NOW,
      runs: [],
      instances: [{ instance: INSTANCE, units: [u] }],
      pullRequests: [pr({ number: 41, state: "closed", mergedAt: "2026-09-19T02:00:00Z" })],
    });
    expect(closed.units[0].health).toEqual(["merge-ready"]);
  });
});
