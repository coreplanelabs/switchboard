import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./runFriction.js";
import {
  DEFAULT_LEDGER_MAX,
  FileFrictionLedger,
  InMemoryFrictionLedger,
  isFrictionRunRecord,
  RunStoreFrictionLedger,
  selectFrictionLedger,
  type FrictionLedger,
} from "./frictionLedger.js";
import type { FrictionRunRecord } from "./frictionProposals.js";
import type { RunEvent } from "./runEvents.js";
import type { RunRecord } from "./runRecord.js";
import { InMemoryRunStore, type RunStore } from "./runStore.js";

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

// Feature: features/run-history.md / self-improvement.md — the friction ledger is
// SERVED from the run store (KD3, KTD12): `recent()` projects run-store list
// rows to FrictionRunRecords and unions the legacy ledger for one retention window.
describe("RunStoreFrictionLedger", () => {
  const NOW = 1_800_000_000_000;
  const runRecord = (id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord => {
    const events: RunEvent[] = [{ type: "tool_call", tool: "bash", summary: `secret-ish text for ${id}` }];
    return {
      id,
      label: `coding · o/r · "${id}"`,
      agent: "coding",
      model: "anthropic/m",
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: "slack:C1:1",
      startedAt: finishedAt - 1000,
      finishedAt,
      status: "completed",
      eventCount: 1,
      storedEventCount: 1,
      truncated: false,
      events,
      diagnosis: analyzeRunFriction([]), // the diagnosis is redacted-at-source and never carries message text
      ...over,
    };
  };
  const fixture = [
    ["c", NOW - 100],
    ["a", NOW - 300],
    ["b", NOW - 300],
    ["d", NOW - 50],
  ] as const;

  it("recent() matches FileFrictionLedger.recent() ordering over the same fixture (differential)", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    const file = new FileFrictionLedger(tmpPath());
    for (const [id, at] of fixture) {
      await store.put(runRecord(id, at));
      await file.record({ runId: id, label: `coding · o/r · "${id}"`, agent: "coding", finishedAt: at, diagnosis: (await store.get(id))!.diagnosis });
    }
    const viaStore = await new RunStoreFrictionLedger(store).recent();
    expect(viaStore).toEqual(await file.recent());
    expect(viaStore.map((r) => r.runId)).toEqual(["a", "b", "c", "d"]);
    expect((await new RunStoreFrictionLedger(store).recent({ limit: 2 })).map((r) => r.runId)).toEqual(["c", "d"]);
    expect((await new RunStoreFrictionLedger(store).recent({ sinceMs: NOW - 100 })).map((r) => r.runId)).toEqual(["c", "d"]);
  });

  it("a channel pin (KTD10) keeps only that channel's run-store rows; legacy rows carry no channel and are excluded, and a bare-record ledger yields nothing", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put(runRecord("x1", NOW - 300, { channelId: "http:x" }));
    await store.put(runRecord("x2", NOW - 100, { channelId: "http:x" }));
    await store.put(runRecord("y1", NOW - 200, { channelId: "http:y" }));
    const legacy = new InMemoryFrictionLedger();
    await legacy.record(rec("legacy-1", NOW - 150));
    const ledger = new RunStoreFrictionLedger(store, legacy);
    expect((await ledger.recent({ channel: "http:x" })).map((r) => r.runId)).toEqual(["x1", "x2"]);
    expect((await ledger.recent({ channel: "http:x", limit: 1 })).map((r) => r.runId)).toEqual(["x2"]);
    expect(await ledger.recent({ channel: "http:nowhere" })).toEqual([]);
    expect((await ledger.recent()).map((r) => r.runId)).toEqual(["x1", "y1", "legacy-1", "x2"]);
    expect(await legacy.recent({ channel: "http:x" })).toEqual([]);
    const file = new FileFrictionLedger(tmpPath());
    await file.record(rec("f1", NOW));
    expect(await file.recent({ channel: "http:x" })).toEqual([]);
  });

  it("projects only { runId, label, agent, finishedAt, diagnosis } — no message text, no ids beyond the run id", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put(runRecord("a", NOW));
    const [rec] = await new RunStoreFrictionLedger(store).recent();
    expect(Object.keys(rec).sort()).toEqual(["agent", "diagnosis", "finishedAt", "label", "runId"]);
    expect(JSON.stringify(rec)).not.toContain("secret-ish");
    expect(JSON.stringify(rec)).not.toContain("slack:");
    expect(isFrictionRunRecord(rec)).toBe(true);
  });

  it("unions the legacy ledger: the run-store row wins on a shared id, a legacy-only run still appears", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    const legacy = new InMemoryFrictionLedger();
    await store.put(runRecord("shared", NOW - 10, { label: "from store" }));
    await legacy.record({ runId: "shared", label: "from legacy", finishedAt: NOW - 10, diagnosis: analyzeRunFriction([]) });
    await legacy.record({ runId: "legacy-only", finishedAt: NOW - 20, diagnosis: analyzeRunFriction([]) });
    const out = await new RunStoreFrictionLedger(store, legacy).recent();
    expect(out.map((r) => r.runId)).toEqual(["legacy-only", "shared"]);
    expect(out[1].label).toBe("from store");
  });

  const failing = (): FrictionLedger => ({
    record: async () => {},
    recent: async () => {
      throw new Error("legacy down");
    },
  });
  const brokenStore = (): RunStore => ({
    put: async () => ({ ok: true, retained: 0, stored: false, rewritten: false }),
    get: async () => null,
    getSummary: async () => null,
    list: async () => {
      throw new Error("store down");
    },
    events: async () => null,
    delete: async () => {},
  });

  it("a failing legacy ledger is warned about once and the run-store rows are still served", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put(runRecord("a", NOW));
    const warnings: string[] = [];
    const out = await new RunStoreFrictionLedger(store, failing(), (m) => warnings.push(m)).recent();
    expect(out.map((r) => r.runId)).toEqual(["a"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("legacy down");
  });

  it("a failing run store is warned about once and the legacy rows are still served", async () => {
    const legacy = new InMemoryFrictionLedger();
    await legacy.record({ runId: "l", finishedAt: NOW - 5, diagnosis: analyzeRunFriction([]) });
    const warnings: string[] = [];
    const out = await new RunStoreFrictionLedger(brokenStore(), legacy, (m) => warnings.push(m)).recent();
    expect(out.map((r) => r.runId)).toEqual(["l"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("store down");
  });

  it("when both sources fail, recent() rejects with the run store's error", async () => {
    await expect(new RunStoreFrictionLedger(brokenStore(), failing(), () => {}).recent()).rejects.toThrow("store down");
  });

  it("pages the run store by {before, beforeId}: 202 runs sharing one finishedAt all reach the ledger", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    for (let i = 0; i < 202; i++) await store.put(runRecord(`same-${String(i).padStart(3, "0")}`, NOW));
    const out = await new RunStoreFrictionLedger(store).recent({ limit: 202 });
    expect(out).toHaveLength(202);
    expect(new Set(out.map((r) => r.runId)).size).toBe(202);
  });

  it("projects a stored record missing a diagnosis category with that category zero-filled", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    const rec = runRecord("legacy", NOW);
    const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
    await store.put({ ...rec, diagnosis: { ...rec.diagnosis, byCategory: rest as typeof rec.diagnosis.byCategory } });
    const [row] = await new RunStoreFrictionLedger(store).recent();
    expect(row.diagnosis.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
    expect(isFrictionRunRecord(row)).toBe(true);
  });

  it("record() forwards to the legacy ledger (FrictionDO keeps its writes until decommission) and is a no-op without one", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    const legacy = new InMemoryFrictionLedger();
    await new RunStoreFrictionLedger(store, legacy).record({ runId: "x", finishedAt: 1, diagnosis: analyzeRunFriction([]) });
    expect((await legacy.recent()).map((r) => r.runId)).toEqual(["x"]);
    await expect(new RunStoreFrictionLedger(store).record({ runId: "y", finishedAt: 1, diagnosis: analyzeRunFriction([]) })).resolves.toBeUndefined();
    expect(await store.list({})).toEqual([]); // never writes the run store
  });

  it("bounds the run-store read to the ledger default (500) and never calls get", async () => {
    const calls: string[] = [];
    const inner = new InMemoryRunStore({ now: () => NOW });
    for (let i = 0; i < 3; i++) await inner.put(runRecord(`r${i}`, NOW - i));
    const spy: RunStore = {
      put: (r) => inner.put(r),
      get: async (id) => {
        calls.push(`get ${id}`);
        return inner.get(id);
      },
      getSummary: async (id) => {
        calls.push(`getSummary ${id}`);
        return inner.getSummary(id);
      },
      list: async (opts) => {
        calls.push(`list ${opts.limit}`);
        return inner.list(opts);
      },
      events: (id, o) => inner.events(id, o),
      delete: (id) => inner.delete(id),
    };
    await new RunStoreFrictionLedger(spy).recent();
    await new RunStoreFrictionLedger(spy).recent({ limit: 2 });
    expect(calls).toEqual([`list ${DEFAULT_LEDGER_MAX}`, "list 2"]);
  });

  it("selectFrictionLedger: a null run store → the legacy ledger unchanged", () => {
    const legacy = new InMemoryFrictionLedger();
    expect(selectFrictionLedger(null, legacy)).toBe(legacy);
    expect(selectFrictionLedger(new InMemoryRunStore(), legacy)).toBeInstanceOf(RunStoreFrictionLedger);
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

  it("accepts a record written by an OLDER analyzer whose byCategory lacks categories added since (absent = zero)", () => {
    // The durable ledger holds records for months; a new FrictionCategory
    // (`slow_model_turn`, 2026-08-30) must not make every existing record
    // unreadable — `WorkerFrictionLedger.recent` filters through this guard.
    const old = rec("a", 1);
    const { slow_model_turn: _dropped, ...legacy } = old.diagnosis.byCategory;
    expect(isFrictionRunRecord({ ...old, diagnosis: { ...old.diagnosis, byCategory: legacy } })).toBe(true);
  });

  it("still rejects a byCategory whose entries are not totals objects", () => {
    const bad = rec("a", 1);
    expect(isFrictionRunRecord({ ...bad, diagnosis: { ...bad.diagnosis, byCategory: { slow_tool: 3 } } })).toBe(false);
    expect(isFrictionRunRecord({ ...bad, diagnosis: { ...bad.diagnosis, byCategory: null } })).toBe(false);
  });
});
