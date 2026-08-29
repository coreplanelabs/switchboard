import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./runFriction.js";
import { FileFrictionLedger, InMemoryFrictionLedger, isFrictionRunRecord, type FrictionLedger } from "./frictionLedger.js";
import type { FrictionRunRecord } from "./frictionProposals.js";

// Feature: features/self-improvement.md — the FrictionLedger seam: where each
// finished run's diagnosis is kept so the proposer can look ACROSS runs (the
// live registry evicts a finished run after 60s). Two implementations
// (AGENTS.md invariant 2): in-memory (tests/dev) and an append-only JSONL file
// under data/ (the same durability as data/overrides.json).

const rec = (runId: string, finishedAt: number): FrictionRunRecord => ({
  runId,
  label: `review · #ch · u · "${runId}"`,
  agent: "review",
  finishedAt,
  diagnosis: analyzeRunFriction([]),
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpPath(): string {
  const d = mkdtempSync(join(tmpdir(), "friction-ledger-"));
  dirs.push(d);
  return join(d, "nested", "friction.jsonl"); // the parent dir must be created on first write
}

/** Contract shared by every implementation. */
function contract(name: string, make: (max?: number) => FrictionLedger) {
  describe(`${name} — FrictionLedger contract`, () => {
    it("starts empty", async () => {
      expect(await make().recent()).toEqual([]);
    });

    it("returns recorded runs oldest-first regardless of record order", async () => {
      const l = make();
      await l.record(rec("b", 200));
      await l.record(rec("a", 100));
      await l.record(rec("c", 300));
      expect((await l.recent()).map((r) => r.runId)).toEqual(["a", "b", "c"]);
    });

    it("`limit` keeps the NEWEST n; `sinceMs` drops older runs", async () => {
      const l = make();
      for (let i = 1; i <= 5; i++) await l.record(rec(`r${i}`, i * 100));
      expect((await l.recent({ limit: 2 })).map((r) => r.runId)).toEqual(["r4", "r5"]);
      expect((await l.recent({ sinceMs: 300 })).map((r) => r.runId)).toEqual(["r3", "r4", "r5"]);
      expect((await l.recent({ sinceMs: 300, limit: 1 })).map((r) => r.runId)).toEqual(["r5"]);
    });

    it("is bounded: beyond `max` records the oldest are dropped", async () => {
      const l = make(3);
      for (let i = 1; i <= 5; i++) await l.record(rec(`r${i}`, i * 100));
      expect((await l.recent()).map((r) => r.runId)).toEqual(["r3", "r4", "r5"]);
    });

    it("upserts by run id: a retried or duplicated write replaces, never double-counts", async () => {
      const l = make();
      await l.record(rec("a", 100));
      await l.record(rec("b", 200));
      const again = rec("a", 100);
      again.label = "replaced";
      await l.record(again);
      const all = await l.recent();
      expect(all.map((r) => r.runId)).toEqual(["a", "b"]);
      expect(all[0].label).toBe("replaced");
    });

    it("hands back copies — mutating a result does not change the ledger", async () => {
      const l = make();
      await l.record(rec("a", 100));
      const [first] = await l.recent();
      first.runId = "mutated";
      expect((await l.recent())[0].runId).toBe("a");
    });
  });
}

contract("InMemoryFrictionLedger", (max) => new InMemoryFrictionLedger({ max }));
contract("FileFrictionLedger", (max) => new FileFrictionLedger(tmpPath(), { max }));

describe("FileFrictionLedger", () => {
  it("persists across instances (a restart reads what the previous process wrote)", async () => {
    const path = tmpPath();
    await new FileFrictionLedger(path).record(rec("a", 100));
    await new FileFrictionLedger(path).record(rec("b", 200));
    expect((await new FileFrictionLedger(path).recent()).map((r) => r.runId)).toEqual(["a", "b"]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2); // one JSON line per run
  });

  it("skips corrupt or wrong-shaped lines instead of failing the read", async () => {
    const path = tmpPath();
    const l = new FileFrictionLedger(path);
    await l.record(rec("a", 100));
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"runId":"x"}\n{"type":"tool_call"}\n`);
    await l.record(rec("b", 200));
    expect((await l.recent()).map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("compacts the file when it grows past the bound", async () => {
    const path = tmpPath();
    const l = new FileFrictionLedger(path, { max: 2 });
    for (let i = 1; i <= 6; i++) await l.record(rec(`r${i}`, i));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(4); // ≤ 2×max between compactions
    expect((await l.recent()).map((r) => r.runId)).toEqual(["r5", "r6"]);
  });

  it("a missing file reads as empty, never throws", async () => {
    expect(await new FileFrictionLedger(tmpPath()).recent()).toEqual([]);
  });
});

describe("isFrictionRunRecord", () => {
  it("accepts a real record and rejects partial/foreign shapes", () => {
    expect(isFrictionRunRecord(rec("a", 1))).toBe(true);
    expect(isFrictionRunRecord({ runId: "a", finishedAt: 1 })).toBe(false);
    expect(isFrictionRunRecord({ ...rec("a", 1), runId: "" })).toBe(false); // an id-less run has no identity to upsert on
    expect(isFrictionRunRecord({ runId: "a", finishedAt: "1", diagnosis: analyzeRunFriction([]) })).toBe(false);
    expect(isFrictionRunRecord({ runId: "a", finishedAt: 1, diagnosis: { findings: "nope" } })).toBe(false);
    expect(isFrictionRunRecord(null)).toBe(false);
    expect(isFrictionRunRecord("x")).toBe(false);
  });
});
