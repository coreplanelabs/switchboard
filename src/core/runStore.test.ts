import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./runFriction.js";
import { DEFAULT_RETENTION_POLICY, type RunListOptions, type RunRecord } from "./runRecord.js";
import type { RunEvent } from "./runEvents.js";
import { buildRunStore, FileRunStore, InMemoryRunStore, NullRunStore, type RunStore } from "./runStore.js";
import { WorkerRunStore } from "./runStoreWorker.js";

// Feature: features/run-history.md — the RunStore seam (U2): in-memory and
// directory-backed file stores sharing one retention function with the Worker.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function events(n: number, size = 20): RunEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "tool_call",
    tool: "bash",
    summary: `step ${i} ${"x".repeat(size)}`,
    at: NOW - 1000 + i,
  }));
}

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const evs = over.events ?? events(3);
  return {
    id,
    label: `review · o/r · "${id}"`,
    agent: "review",
    model: "anthropic/m",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1",
    channelVisibility: "unknown",
    startedAt: finishedAt - 5000,
    finishedAt,
    status: "completed",
    eventCount: evs.length,
    storedEventCount: evs.length,
    truncated: false,
    events: evs,
    diagnosis: analyzeRunFriction(evs),
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "run-store-"));
  dirs.push(d);
  return join(d, "data", "runs");
}

interface Harness {
  store: RunStore;
  clock: { now: number };
}

function contract(name: string, make: (policy?: Partial<typeof DEFAULT_RETENTION_POLICY>) => Harness) {
  describe(`${name} — RunStore contract`, () => {
    it("round-trips a 2 MB record and lists without events", async () => {
      const { store } = make();
      const big = record("big", NOW, { events: events(40, 50_000) });
      expect(JSON.stringify(big).length).toBeGreaterThan(2_000_000);
      const res = await store.put(big);
      expect(res).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
      expect(await store.get("big")).toEqual(big);
      const items = await store.list({});
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("big");
      expect((items[0] as Record<string, unknown>).events).toBeUndefined();
      expect(items[0].bytes).toBeGreaterThan(2_000_000);
    });

    it("getSummary returns the listing row (no events, with bytes) for a kept run; null for unknown, expired, or malformed ids", async () => {
      const { store, clock } = make({ retentionDays: 1 });
      const rec = record("s1", NOW, { events: events(5) });
      await store.put(rec);
      const summary = await store.getSummary("s1");
      const { events: _e, ...rest } = rec;
      expect(summary).toEqual({ ...rest, bytes: expect.any(Number) });
      expect((summary as Record<string, unknown>).events).toBeUndefined();
      expect(summary!.bytes).toBe((await store.list({}))[0].bytes);
      expect(await store.getSummary("nope")).toBeNull();
      expect(await store.getSummary("../x")).toBeNull();
      clock.now = NOW + 2 * DAY;
      expect(await store.getSummary("s1")).toBeNull();
    });

    it("rejects ids failing RUN_ID_PATTERN without throwing", async () => {
      const { store } = make();
      expect(await store.get("../../etc/x")).toBeNull();
      expect(await store.get("has space")).toBeNull();
      expect(await store.events("a/b", {})).toBeNull();
      await expect(store.delete("../x")).resolves.toBeUndefined();
      expect(await store.list({})).toEqual([]);
    });

    // 30 s timeout, not the 5 s default: the FileRunStore variant's 205 puts
    // each re-read the index, stat every kept record (compact's intact check),
    // and rewrite the index — O(n) I/O per put by design (self-healing index).
    // ~300 ms on an idle SSD, but on a busy runner it has blown the default
    // timeout twice now (a CI runner at 260 records; a resident review worktree
    // under build contention, #403). The generous ceiling keeps the test's
    // coverage without racing the disk.
    it(
      "list is newest-first, capped at 200 (default 50), with a `before` cursor and filters",
      { timeout: 30_000 },
      async () => {
        const { store } = make();
        // 205 records: the fewest that prove the 200 cap AND a non-empty second
        // page. One pre-built event list + diagnosis is shared across every record
        // so each put is one small write.
        const evs = events(1);
        const diagnosis = analyzeRunFriction(evs);
        for (let i = 0; i < 205; i++) {
          await store.put(
            record(`r${String(i).padStart(3, "0")}`, NOW - i * 1000, {
              agent: i % 2 ? "review" : "coding",
              channelId: i % 3 ? "slack:C1" : "slack:C2",
              events: evs,
              eventCount: 1,
              storedEventCount: 1,
              diagnosis,
            }),
          );
        }
        const dflt = await store.list({});
        expect(dflt).toHaveLength(50);
        expect(dflt[0].id).toBe("r000");
        const capped = await store.list({ limit: 1000 });
        expect(capped).toHaveLength(200);
        const page2 = await store.list({ limit: 200, before: capped[199].finishedAt });
        expect(page2).toHaveLength(5);
        expect(page2[0].id).toBe("r200");
        expect((await store.list({ agent: "coding", limit: 5 })).every((r) => r.agent === "coding")).toBe(true);
        expect((await store.list({ channel: "slack:C2", limit: 5 })).every((r) => r.channelId === "slack:C2")).toBe(
          true,
        );
        expect(await store.list({ sinceMs: NOW - 2500 })).toHaveLength(3);
      },
    );

    it("list applies `visibleTo` — the actor's predicate — as its own filter, ANDed with the others; a row without the stamp is `unknown` and never public", async () => {
      const { store } = make();
      await store.put(
        record("pub", NOW - 1000, { channelId: "slack:C_PUB", userId: "slack:UALICE", channelVisibility: "public" }),
      );
      await store.put(
        record("priv", NOW - 2000, { channelId: "slack:G1", userId: "slack:UBOB", channelVisibility: "private" }),
      );
      await store.put(
        record("ops", NOW - 3000, { channelId: "http:ops", userId: "http:ci", channelVisibility: "machine" }),
      );
      await store.put(
        record("old-style", NOW - 4000, { channelId: "slack:C_PUB", userId: "slack:UCAROL", channelVisibility: "unknown" }),
      );
      const ids = async (visibleTo: RunListOptions["visibleTo"], more: Partial<RunListOptions> = {}) =>
        (await store.list({ visibleTo, ...more })).map((r) => r.id);
      expect(await ids({ kind: "all" })).toEqual(["pub", "priv", "ops", "old-style"]);
      expect(await ids({ kind: "none" })).toEqual([]);
      expect(await ids({ kind: "visibility-in", visibilities: ["public"] })).toEqual(["pub"]);
      expect(
        await ids({
          kind: "or",
          of: [
            { kind: "channels-in", channelIds: ["http:ops"] },
            { kind: "visibility-in", visibilities: ["public"] },
          ],
        }),
      ).toEqual(["pub", "ops"]);
      expect(
        await ids({
          kind: "or",
          of: [
            { kind: "visibility-in", visibilities: ["public"] },
            { kind: "user-is", userId: "slack:UBOB" },
          ],
        }),
      ).toEqual(["pub", "priv"]);
      expect(await ids({ kind: "channels-in", channelIds: ["slack:C_PUB"] }, { channel: "http:ops" })).toEqual([]);
      expect(await ids({ kind: "channels-in", channelIds: ["slack:C_PUB"] })).toEqual(["pub", "old-style"]);
    });

    it("events(id, {afterSeq: 10, limit: 5}) returns five events with seq > 10 and a cursor; unknown id → null; a run with no events → an empty page", async () => {
      const { store } = make();
      await store.put(record("a", NOW, { events: events(20) }));
      const page = await store.events("a", { afterSeq: 10, limit: 5 });
      expect(page!.events.map((e) => e.seq)).toEqual([11, 12, 13, 14, 15]);
      expect((page!.events[0] as { summary: string }).summary).toMatch(/^step 10 /);
      expect(page!.nextAfterSeq).toBe(15);
      const last = await store.events("a", { afterSeq: 15, limit: 10 });
      expect(last!.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20]);
      expect(last!.nextAfterSeq).toBeUndefined();
      expect(await store.events("missing", {})).toBeNull();
      await store.put(record("empty", NOW - 1, { events: [], eventCount: 0, storedEventCount: 0 }));
      expect(await store.events("empty", {})).toEqual({ events: [] });
      expect(await store.events("a", { afterSeq: 20 })).toEqual({ events: [] });
    });

    it("events keep the registry seq they were published with: a record whose events carry seq 2001..7000 pages from afterSeq 6500 by that seq", async () => {
      const { store } = make();
      const stamped = events(5000).map((e, i) => ({ ...e, seq: 2001 + i }));
      await store.put(
        record("trimmed", NOW, { events: stamped, eventCount: 7000, storedEventCount: 5000, truncated: true }),
      );
      const page = await store.events("trimmed", { afterSeq: 6500, limit: 100 });
      expect(page!.events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 6501 + i));
      expect((page!.events[0] as { summary: string }).summary).toMatch(/^step 4500 /);
      expect(page!.nextAfterSeq).toBe(6600);
      const tail = await store.events("trimmed", { afterSeq: 6995 });
      expect(tail!.events.map((e) => e.seq)).toEqual([6996, 6997, 6998, 6999, 7000]);
      expect(tail!.nextAfterSeq).toBeUndefined();
      expect(await store.events("trimmed", { afterSeq: 1000, limit: 2 })).toMatchObject({
        events: [{ seq: 2001 }, { seq: 2002 }],
        nextAfterSeq: 2002,
      });
      expect((await store.get("trimmed"))!.events.map((e) => e.seq).slice(0, 3)).toEqual([2001, 2002, 2003]);
    });

    it("list cursor {before, beforeId}: two runs with identical finishedAt straddling a page boundary both appear", async () => {
      const { store } = make();
      for (let i = 0; i < 5; i++) await store.put(record(`older${i}`, NOW - 1000 - i));
      await store.put(record("tie-a", NOW));
      await store.put(record("tie-b", NOW));
      await store.put(record("tie-c", NOW));
      const page1 = await store.list({ limit: 2 });
      expect(page1.map((r) => r.id)).toEqual(["tie-c", "tie-b"]);
      const last = page1[page1.length - 1];
      const page2 = await store.list({ limit: 2, before: last.finishedAt, beforeId: last.id });
      expect(page2.map((r) => r.id)).toEqual(["tie-a", "older0"]);
      // `before` alone keeps its old meaning (strictly earlier) — and skips the sibling.
      expect((await store.list({ limit: 2, before: last.finishedAt })).map((r) => r.id)).toEqual(["older0", "older1"]);
    });

    it("a stored record missing a diagnosis category still loads and lists, normalized to every current category", async () => {
      const { store } = make();
      const rec = record("legacy", NOW);
      const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
      await store.put({ ...rec, diagnosis: { ...rec.diagnosis, byCategory: rest as typeof rec.diagnosis.byCategory } });
      const got = await store.get("legacy");
      expect(got!.diagnosis.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
      expect(got!.diagnosis.byCategory.failed_tool).toEqual(rec.diagnosis.byCategory.failed_tool);
      const [item] = await store.list({});
      expect(item.id).toBe("legacy");
      expect(item.diagnosis.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
    });

    it("an expired record is absent from get/list before any write", async () => {
      const { store, clock } = make({ retentionDays: 30 });
      clock.now = NOW - 31 * DAY;
      await store.put(record("old", NOW - 31 * DAY));
      await store.put(record("fresh", NOW - 29 * DAY));
      clock.now = NOW;
      expect(await store.get("old")).toBeNull();
      expect((await store.list({})).map((r) => r.id)).toEqual(["fresh"]);
    });

    it("put reports stored:false for a record already outside policy", async () => {
      const { store } = make({ retentionDays: 30 });
      const res = await store.put(record("old", NOW - 31 * DAY));
      expect(res.stored).toBe(false);
      expect(await store.get("old")).toBeNull();
    });

    it("rewritten is true only when an existing record changed", async () => {
      const { store } = make();
      await store.put(record("a", NOW));
      expect((await store.put(record("a", NOW))).rewritten).toBe(false);
      expect((await store.put(record("a", NOW, { events: events(5) }))).rewritten).toBe(true);
    });

    it("delete removes the run and its events", async () => {
      const { store } = make();
      await store.put(record("a", NOW));
      await store.delete("a");
      expect(await store.get("a")).toBeNull();
      expect(await store.list({})).toEqual([]);
      expect(await store.events("a", {})).toBeNull();
    });
  });
}

contract("InMemoryRunStore", (policy) => {
  const clock = { now: NOW };
  return {
    store: new InMemoryRunStore({ policy: { ...DEFAULT_RETENTION_POLICY, ...policy }, now: () => clock.now }),
    clock,
  };
});
contract("FileRunStore", (policy) => {
  const clock = { now: NOW };
  return {
    store: new FileRunStore(tmpDir(), { policy: { ...DEFAULT_RETENTION_POLICY, ...policy }, now: () => clock.now }),
    clock,
  };
});

describe("FileRunStore", () => {
  const make = (dir: string, policy: Partial<typeof DEFAULT_RETENTION_POLICY> = {}, clock = { now: NOW }) =>
    new FileRunStore(dir, { policy: { ...DEFAULT_RETENTION_POLICY, ...policy }, now: () => clock.now });

  it("writes <id>.json with mode 0600 inside a 0700 directory, temp-then-rename", async () => {
    const dir = tmpDir();
    await make(dir).put(record("a", NOW));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "a.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "index.jsonl")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it('get("../../etc/x") is not-found and touches nothing outside data/runs', async () => {
    const dir = tmpDir();
    const store = make(dir);
    expect(await store.get("../../etc/x")).toBeNull();
    expect(existsSync(join(dir, "..", "..", "etc"))).toBe(false);
    expect(existsSync(dir)).toBe(false); // nothing was even created for a bad id
  });

  it("a torn <id>.json is skipped by get and absent from list while the others read", async () => {
    const dir = tmpDir();
    const store = make(dir);
    await store.put(record("ok", NOW));
    await store.put(record("torn", NOW - 1));
    const path = join(dir, "torn.json");
    writeFileSync(path, readFileSync(path, "utf8").slice(0, 100));
    expect(await store.get("torn")).toBeNull();
    expect(await store.getSummary("torn")).toBeNull(); // hidden like list hides it (size ≠ indexed bytes), no file read
    expect((await store.getSummary("ok"))?.id).toBe("ok");
    expect((await store.list({})).map((r) => r.id)).toEqual(["ok"]);
    expect((await store.get("ok"))?.id).toBe("ok");
  });

  it("a stale index line (file gone) is hidden and healed on the next put", async () => {
    const dir = tmpDir();
    const store = make(dir);
    await store.put(record("gone", NOW - 1));
    await store.put(record("kept", NOW - 2));
    rmSync(join(dir, "gone.json"));
    expect((await store.list({})).map((r) => r.id)).toEqual(["kept"]);
    expect(readFileSync(join(dir, "index.jsonl"), "utf8")).toContain('"gone"');
    await store.put(record("new", NOW));
    expect(readFileSync(join(dir, "index.jsonl"), "utf8")).not.toContain('"gone"');
    expect((await store.list({})).map((r) => r.id)).toEqual(["new", "kept"]);
  });

  it("an expired record is unlinked on the next put and the index compacted", async () => {
    const dir = tmpDir();
    const clock = { now: NOW - 31 * DAY };
    const store = make(dir, { retentionDays: 30 }, clock);
    await store.put(record("old", NOW - 31 * DAY));
    clock.now = NOW;
    expect(existsSync(join(dir, "old.json"))).toBe(true);
    const res = await store.put(record("fresh", NOW));
    expect(res).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
    expect(existsSync(join(dir, "old.json"))).toBe(false);
    expect(readFileSync(join(dir, "index.jsonl"), "utf8")).not.toContain('"old"');
  });

  it("shrinking then growing retentionDays does not resurrect deleted records", async () => {
    const dir = tmpDir();
    const clock = { now: NOW };
    await make(dir, { retentionDays: 30 }, clock).put(record("mid", NOW - 10 * DAY));
    const shrunk = make(dir, { retentionDays: 5 }, clock);
    await shrunk.put(record("fresh", NOW));
    expect(await shrunk.get("mid")).toBeNull();
    const grown = make(dir, { retentionDays: 30 }, clock);
    expect(await grown.get("mid")).toBeNull();
    expect((await grown.list({})).map((r) => r.id)).toEqual(["fresh"]);
  });

  it("persists across instances (a restart reads what the previous process wrote)", async () => {
    const dir = tmpDir();
    await make(dir).put(record("a", NOW));
    expect((await make(dir).get("a"))?.id).toBe("a");
    expect((await make(dir).list({})).map((r) => r.id)).toEqual(["a"]);
  });

  it("sweep() unlinks expired files with no writes", async () => {
    const dir = tmpDir();
    const clock = { now: NOW };
    const store = make(dir, { retentionDays: 30 }, clock);
    await store.put(record("a", NOW));
    clock.now = NOW + 31 * DAY;
    store.sweep();
    expect(existsSync(join(dir, "a.json"))).toBe(false);
    expect(readFileSync(join(dir, "index.jsonl"), "utf8").trim()).toBe("");
  });
});

describe("buildRunStore", () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);
  const timers: Array<{ fn: () => void; ms: number; unref: boolean }> = [];
  const setIntervalImpl = ((fn: () => void, ms: number) => {
    const t = { fn, ms, unref: false };
    timers.push(t);
    return { unref: () => void (t.unref = true) };
  }) as unknown as typeof setInterval;
  const deps = () => {
    warnings.length = 0;
    timers.length = 0;
    return { dataDir: tmpDir().replace(/\/runs$/, ""), warn, setInterval: setIntervalImpl };
  };

  it("unconfigured → null (history off), no timer", () => {
    expect(buildRunStore(undefined, {}, deps())).toBeNull();
    expect(timers).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("store: file → FileRunStore under <dataDir>/runs with a 6 h sweep timer (unref'd) that unlinks expired files", async () => {
    const d = deps();
    const clock = { now: NOW };
    const store = buildRunStore({ store: "file", retentionDays: 30 }, {}, { ...d, now: () => clock.now });
    expect(store).toBeInstanceOf(FileRunStore);
    await store!.put(record("a", NOW));
    expect(existsSync(join(d.dataDir, "runs", "a.json"))).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(6 * 3600_000);
    expect(timers[0].unref).toBe(true);
    clock.now = NOW + 31 * DAY;
    timers[0].fn();
    expect(existsSync(join(d.dataDir, "runs", "a.json"))).toBe(false);
  });

  it("worker without its bearer → null + a warning naming the env var", () => {
    const d = deps();
    expect(
      buildRunStore({ store: "worker", worker: { baseUrl: "https://state.example", tokenEnv: "RUNS_TOKEN" } }, {}, d),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("RUNS_TOKEN");
    expect(timers).toEqual([]);
  });

  it("worker with its bearer → WorkerRunStore (default env MEMORY_TOKEN), no timer", () => {
    const d = deps();
    expect(buildRunStore({ worker: { baseUrl: "https://state.example" } }, { MEMORY_TOKEN: "tok" }, d)).toBeInstanceOf(
      WorkerRunStore,
    );
    expect(warnings).toEqual([]);
    expect(timers).toEqual([]);
  });
});

// Feature: features/routing-and-config.md item 16 — the Null Object a process
// without run history is wired with, so no caller branches on a missing store.
describe("NullRunStore — the store of a process without run history", () => {
  it("accepts a put and keeps nothing (stored: false, like a record outside retention); every read is the not-found shape; list is empty; delete is a no-op", async () => {
    const store = new NullRunStore();
    expect(await store.put(record("r1", NOW))).toEqual({ ok: true, retained: 0, stored: false, rewritten: false });
    expect(await store.get("r1")).toBeNull();
    expect(await store.getSummary("r1")).toBeNull();
    expect(await store.list({ limit: 10 })).toEqual([]);
    expect(await store.events("r1", { limit: 10 })).toBeNull();
    await expect(store.delete("r1")).resolves.toBeUndefined();
  });
});
