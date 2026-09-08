import { describe, expect, it, vi } from "vitest";
import type { Predicate } from "./authz/types.js";
import { analyzeRunFriction } from "./runFriction.js";
import {
  DEFAULT_LEDGER_MAX,
  InMemoryFrictionLedger,
  NullFrictionLedger,
  isFrictionRunRecord,
  RunStoreFrictionLedger,
  selectFrictionLedger,
} from "./frictionLedger.js";
import type { FrictionRunRecord } from "./frictionProposals.js";
import type { RunEvent } from "./runEvents.js";
import type { RunRecord } from "./runRecord.js";
import { InMemoryRunStore, type RunStore } from "./runStore.js";

// Feature: docs/reference/specs/self-improvement.md — the FrictionLedger seam: where each
// finished run's diagnosis is READ from so the proposer can look ACROSS runs
// (the live registry evicts a finished run after 60s). Production reads run
// history (`RunStoreFrictionLedger`); the in-memory ledger is the test double
// that pins the seam's ordering and trimming rules over bare records.

const rec = (runId: string, finishedAt: number): FrictionRunRecord => ({
  runId,
  label: `review · #ch · u · "${runId}"`,
  agent: "review",
  finishedAt,
  diagnosis: analyzeRunFriction([]),
});

describe("InMemoryFrictionLedger — the seam's rules over bare records", () => {
  it("starts empty", async () => {
    expect(await new InMemoryFrictionLedger().recent()).toEqual([]);
  });

  it("returns seeded runs oldest-first regardless of seed order", async () => {
    const ledger = new InMemoryFrictionLedger();
    await ledger.record(rec("b", 200));
    await ledger.record(rec("a", 100));
    await ledger.record(rec("c", 300));
    expect((await ledger.recent()).map((r) => r.runId)).toEqual(["a", "b", "c"]);
  });

  it("`limit` keeps the NEWEST n; `sinceMs` drops older runs", async () => {
    const ledger = new InMemoryFrictionLedger();
    for (const [id, at] of [
      ["a", 100],
      ["b", 200],
      ["c", 300],
    ] as const)
      await ledger.record(rec(id, at));
    expect((await ledger.recent({ limit: 2 })).map((r) => r.runId)).toEqual(["b", "c"]);
    expect((await ledger.recent({ sinceMs: 200 })).map((r) => r.runId)).toEqual(["b", "c"]);
  });

  it("is bounded: beyond `max` records the oldest are dropped", async () => {
    const ledger = new InMemoryFrictionLedger({ max: 2 });
    for (const [id, at] of [
      ["a", 100],
      ["b", 200],
      ["c", 300],
    ] as const)
      await ledger.record(rec(id, at));
    expect((await ledger.recent()).map((r) => r.runId)).toEqual(["b", "c"]);
  });

  it("upserts by run id: a repeated seed replaces, never double-counts", async () => {
    const ledger = new InMemoryFrictionLedger();
    await ledger.record(rec("a", 100));
    await ledger.record({ ...rec("a", 150), agent: "coding" });
    const out = await ledger.recent();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ runId: "a", finishedAt: 150, agent: "coding" });
  });

  it("hands back copies — mutating a result does not change the ledger", async () => {
    const ledger = new InMemoryFrictionLedger();
    await ledger.record(rec("a", 100));
    const [first] = await ledger.recent();
    first.label = "mutated";
    expect((await ledger.recent())[0].label).toBe(rec("a", 100).label);
  });

  it("bare records answer only a predicate that admits everything: anything narrower yields nothing (fail closed)", async () => {
    const ledger = new InMemoryFrictionLedger();
    await ledger.record(rec("a", 100));
    const inX: Predicate = { kind: "channels-in", channelIds: new Set(["http:x"]) };
    expect(await ledger.recent({ visibleTo: inX })).toEqual([]);
    expect((await ledger.recent({ visibleTo: { kind: "all" } })).map((r) => r.runId)).toEqual(["a"]);
  });
});

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
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
      channelVisibility: "unknown",
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

  it("recent() orders and trims exactly like the in-memory ledger over the same fixture (differential)", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    const reference = new InMemoryFrictionLedger();
    for (const [id, at] of fixture) {
      await store.put(runRecord(id, at));
      await reference.record({
        runId: id,
        label: `coding · o/r · "${id}"`,
        agent: "coding",
        finishedAt: at,
        diagnosis: (await store.get(id))!.diagnosis,
      });
    }
    const viaStore = await new RunStoreFrictionLedger(store).recent();
    expect(viaStore).toEqual(await reference.recent());
    expect(viaStore.map((r) => r.runId)).toEqual(["a", "b", "c", "d"]);
    expect((await new RunStoreFrictionLedger(store).recent({ limit: 2 })).map((r) => r.runId)).toEqual(["c", "d"]);
    expect((await new RunStoreFrictionLedger(store).recent({ sinceMs: NOW - 100 })).map((r) => r.runId)).toEqual([
      "c",
      "d",
    ]);
  });

  it("recent() takes the actor's predicate (authorization.md item 6): the run store is asked with it as `visibleTo`; `none` reads nothing; `all` and no predicate ask without a filter", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put(runRecord("x1", NOW - 300, { channelId: "http:x", channelVisibility: "machine" }));
    await store.put(runRecord("x2", NOW - 100, { channelId: "http:x", channelVisibility: "machine" }));
    await store.put(runRecord("y1", NOW - 200, { channelId: "http:y", channelVisibility: "machine" }));
    await store.put(runRecord("p1", NOW - 250, { channelId: "slack:C_PUB", channelVisibility: "public" }));
    const ledger = new RunStoreFrictionLedger(store);
    const list = vi.spyOn(store, "list");
    const inX: Predicate = { kind: "channels-in", channelIds: new Set(["http:x"]) };
    expect((await ledger.recent({ visibleTo: inX })).map((r) => r.runId)).toEqual(["x1", "x2"]);
    expect(list.mock.calls[0][0].visibleTo).toEqual({ kind: "channels-in", channelIds: ["http:x"] });
    expect((await ledger.recent({ visibleTo: inX, limit: 1 })).map((r) => r.runId)).toEqual(["x2"]);
    expect(await ledger.recent({ visibleTo: { kind: "channels-in", channelIds: new Set(["http:nowhere"]) } })).toEqual(
      [],
    );
    // member-of as the compiler emits it: the granted channel OR the public runs.
    const memberOf: Predicate = { kind: "or", of: [inX, { kind: "visibility-in", visibilities: new Set(["public"]) }] };
    expect((await ledger.recent({ visibleTo: memberOf })).map((r) => r.runId)).toEqual(["x1", "p1", "x2"]);
    list.mockClear();
    expect(await ledger.recent({ visibleTo: { kind: "none" } })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    expect((await ledger.recent({ visibleTo: { kind: "all" } })).map((r) => r.runId)).toEqual(["x1", "p1", "y1", "x2"]);
    expect(list.mock.calls[0][0]).not.toHaveProperty("visibleTo");
    expect((await ledger.recent()).map((r) => r.runId)).toEqual(["x1", "p1", "y1", "x2"]);
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

  it("a run store that cannot be read rejects with its error — the friction command names the cause", async () => {
    const brokenStore: RunStore = {
      put: async () => ({ ok: true, retained: 0, stored: false, rewritten: false }),
      get: async () => null,
      getSummary: async () => null,
      list: async () => {
        throw new Error("store down");
      },
      events: async () => null,
      delete: async () => {},
    };
    await expect(new RunStoreFrictionLedger(brokenStore).recent()).rejects.toThrow("store down");
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
    const rec = runRecord("older", NOW);
    const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
    await store.put({ ...rec, diagnosis: { ...rec.diagnosis, byCategory: rest as typeof rec.diagnosis.byCategory } });
    const [row] = await new RunStoreFrictionLedger(store).recent();
    expect(row.diagnosis.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
    expect(isFrictionRunRecord(row)).toBe(true);
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

  it("selectFrictionLedger: a run store → the store-served ledger; no run store → the null ledger (no recent runs anywhere)", () => {
    expect(selectFrictionLedger(new InMemoryRunStore())).toBeInstanceOf(RunStoreFrictionLedger);
    expect(selectFrictionLedger(null)).toBeInstanceOf(NullFrictionLedger);
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
    // Run history holds records for weeks; a new FrictionCategory
    // (`slow_model_turn`, say) must not make every existing record
    // unreadable — the projection zero-fills what an older diagnosis lacks.
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

// Feature: docs/reference/specs/routing-and-config.md item 16 — the Null Object a process
// without run history is wired with; `selectFrictionLedger` hands it out for a
// missing store instead of `undefined`.
describe("NullFrictionLedger — the ledger of a process without run history", () => {
  it("has no recent runs whatever is asked; selectFrictionLedger(null) is it, and a store gives the run-store ledger", async () => {
    const ledger = new NullFrictionLedger();
    expect(await ledger.recent()).toEqual([]);
    expect(await ledger.recent({ limit: 5, sinceMs: 0, visibleTo: { kind: "all" } })).toEqual([]);
    expect(selectFrictionLedger(null)).toBeInstanceOf(NullFrictionLedger);
    expect(selectFrictionLedger(new InMemoryRunStore())).toBeInstanceOf(RunStoreFrictionLedger);
  });
});
