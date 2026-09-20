import { describe, expect, it } from "vitest";
import { levelPosts, memorySide, mergeOutbox, seatSide, type LevelSample } from "./levels.js";
import { MEMORY_SOFT_LIMIT_PCT } from "./memoryGuard.js";
import { methodOf, readSource } from "./testing/sourceScan";

// Feature: docs/reference/specs/resident-repos.md — the resident's level
// reports (record 0064): the sides, the crossing posts, the boot's
// re-statement and the outbox's supersession are the pure module's; the
// Worker wiring (levels on every /attach, /exec and /status answer; the
// registry's drain posts and its alarm at `until`) is pinned over the entry's
// source like memoryGate.test.ts.

const sample = (over: Partial<LevelSample> = {}): LevelSample => ({
  seat: "below",
  memory: "below",
  generation: "gen-1",
  ...over,
});

describe("the sides", () => {
  it("seat is above exactly when no pool user is free — the next attach would be refused user-pool-exhausted", () => {
    expect(seatSide(15, 16)).toBe("below");
    expect(seatSide(16, 16)).toBe("above");
  });

  it("memory is above at the gate's soft line; no reading or no cap gates nothing", () => {
    expect(memorySide(MEMORY_SOFT_LIMIT_PCT - 1)).toBe("below");
    expect(memorySide(MEMORY_SOFT_LIMIT_PCT)).toBe("above");
    expect(memorySide(null)).toBe("below");
  });
});

describe("the crossing posts and the boot's re-statement (record 0064)", () => {
  it("a crossing posts a level: only the name that moved", () => {
    expect(levelPosts(sample(), sample({ memory: "above" }), "t1")).toEqual([
      { name: "memory", side: "above", generation: "gen-1", at: "t1" },
    ]);
  });

  it("an unchanged sample posts nothing", () => {
    expect(levelPosts(sample(), sample(), "t1")).toEqual([]);
  });

  it("a boot re-states both names: no previous sample, or one from another generation", () => {
    expect(levelPosts(null, sample(), "t1").map((p) => p.name)).toEqual(["seat", "memory"]);
    expect(levelPosts(sample(), sample({ generation: "gen-2" }), "t1").map((p) => p.name)).toEqual(["seat", "memory"]);
  });

  it("a newer post of a name supersedes the outbox's older one; the outbox never grows past one per name", () => {
    const older = levelPosts(sample(), sample({ memory: "above" }), "t1");
    const newer = levelPosts(sample({ memory: "above" }), sample(), "t2");
    const merged = mergeOutbox(older, newer);
    expect(merged).toEqual([{ name: "memory", side: "below", generation: "gen-1", at: "t2" }]);
    expect(mergeOutbox(merged, []).length).toBe(1);
  });
});

const source = readSource("worker.ts");
const residentDO = source.slice(source.indexOf("export class ResidentDO"));
const registryDO = source.slice(
  source.indexOf("export class ResidentRegistryDO"),
  source.indexOf("export class ResidentDO"),
);

describe("the Worker wiring (static): levels on every answer, the registry's drain posts and its alarm", () => {
  it("residentLevels reads the pool and the last memory sample, judges crossings, and persists the outbox", () => {
    const body = methodOf(residentDO, "residentLevels");
    expect(body, "worker.ts declares ResidentDO.residentLevels").not.toBeNull();
    expect(body!).toMatch(/seatSide\(/);
    expect(body!).toMatch(/memorySide\(/);
    expect(body!).toMatch(/levelPosts\(/);
    expect(body!).toMatch(/mergeOutbox\(/);
  });

  it("the /status, /attach and /exec answers carry levels", () => {
    expect(source).toMatch(/handleStatus[\s\S]*?stub\.residentLevels\(\)/);
    const attach = source.slice(
      source.indexOf("async function handleAttach"),
      source.indexOf("async function handleDetach"),
    );
    expect(attach).toMatch(/withLevels\(/);
    const exec = source.slice(source.indexOf("async function handleExec"));
    expect(exec).toMatch(/withLevels\(/);
  });

  it("the registry's drain set posts above and arms one alarm at until; a clear posts below; the alarm posts below for an expired drain", () => {
    expect(registryDO).toMatch(/setDrain[\s\S]*?pushDrainPost\("above"/);
    expect(registryDO).toMatch(/setDrain[\s\S]*?setAlarm\(Date\.parse\(record\.until\)\)/);
    expect(registryDO).toMatch(/clearDrain[\s\S]*?pushDrainPost\("below"/);
    const alarm = methodOf(registryDO, "alarm");
    expect(alarm, "worker.ts declares ResidentRegistryDO.alarm").not.toBeNull();
    expect(alarm!).toMatch(/pushDrainPost\("below"/);
  });
});
