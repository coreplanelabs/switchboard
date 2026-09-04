import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../src/core/runRecord.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { RUN_EVENT_INSERT_BATCH, RunHistoryDO } from "./worker.ts";

// Feature: features/run-history.md — the RunHistoryDO (#157, U3): the durable
// run store behind the bot's WorkerRunStore. Runs in workerd against the real
// SQLite-backed Durable Object; a unique store key per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };
const DAY = 86_400_000;
const MIB = 1024 * 1024;

let n = 0;
const storeKey = () => `runs:test-${Date.now()}-${n++}`;

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { ...headers, "content-length": String(new TextEncoder().encode(raw).byteLength) }, body: raw });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON: leave {}
  }
  return { status: res.status, data };
}

const ZERO = { count: 0, durationMs: 0 };
const diagnosis = () => ({
  eventCount: 0,
  toolCalls: 0,
  hasTimings: false,
  // Every current analyzer category, zeroed — the DO normalizes on read, so a
  // fixture pinned to a category list would drift the moment one is added.
  byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, ZERO])) as RunRecord["diagnosis"]["byCategory"],
  findings: [],
  verdict: "no friction detected",
});

/** Events stamped 1..count like the registry stamps them (`seq` is what the store keys on). */
function events(count: number, size = 10, firstSeq = 1): RunRecord["events"] {
  return Array.from({ length: count }, (_, i) => ({ type: "tool_call" as const, tool: "bash", summary: `step ${i} ${"x".repeat(size)}`, seq: firstSeq + i }));
}

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const evs = over.events ?? events(3);
  return {
    id,
    label: `review · o/r · "${id}"`,
    agent: "review",
    model: "anthropic/m",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:1",
    channelVisibility: "unknown",
    startedAt: finishedAt - 5000,
    finishedAt,
    status: "completed",
    eventCount: evs.length,
    storedEventCount: evs.length,
    truncated: false,
    events: evs,
    diagnosis: diagnosis(),
    ...over,
  };
}

const stubOf = (key: string) => env.RUNS.get(env.RUNS.idFromName(key));
/** Record every SQL statement the DO instance runs from now on (the plan check). */
function spySql(inst: RunHistoryDO): string[] {
  const seen: string[] = [];
  const real = (inst as unknown as { sql: SqlStorage }).sql;
  Object.defineProperty(inst, "sql", {
    value: { exec: (q: string, ...p: unknown[]) => (seen.push(q), real.exec(q, ...p)) },
  });
  return seen;
}
const rowCount = (key: string, table: string) =>
  runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n);
const putDirect = (key: string, rec: RunRecord, proposal?: { policy: Record<string, number>; policyUpdatedAt: number }) =>
  runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.put(rec, proposal));

describe("run history routes", () => {
  it("put → get round-trips the record with events in seq order; unknown id → {record: null} 200", async () => {
    const key = storeKey();
    const now = Date.now();
    const rec = record("a", now, { events: events(5) });
    const put = await post("/runs/put", { storeKey: key, record: rec });
    expect(put.status).toBe(200);
    expect(put.data).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
    const got = await post("/runs/get", { storeKey: key, id: "a" });
    expect(got.status).toBe(200);
    expect(got.data.record).toEqual(rec);
    expect(await post("/runs/get", { storeKey: key, id: "nope" })).toEqual({ status: 200, data: { record: null } });
    expect(await post("/runs/get", { storeKey: storeKey(), id: "a" })).toEqual({ status: 200, data: { record: null } });
  });

  it("inserts 5000 events inside one transaction and pages them by seq", async () => {
    const key = storeKey();
    const rec = record("big", Date.now(), { events: events(5000) });
    expect((await post("/runs/put", { storeKey: key, record: rec })).data).toMatchObject({ ok: true, stored: true });
    expect(await rowCount(key, "run_events")).toBe(5000);
    expect(RUN_EVENT_INSERT_BATCH * 3).toBeLessThanOrEqual(100); // the DO bound-parameter limit
    const page = await post("/runs/events", { storeKey: key, id: "big", afterSeq: 10, limit: 5 });
    expect((page.data.events as Array<{ seq: number; summary: string }>).map((e) => e.seq)).toEqual([11, 12, 13, 14, 15]);
    expect((page.data.events as Array<{ summary: string }>)[0].summary).toMatch(/^step 10 /);
    expect(page.data.nextAfterSeq).toBe(15);
    const tail = await post("/runs/events", { storeKey: key, id: "big", afterSeq: 4995, limit: 100 });
    expect((tail.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([4996, 4997, 4998, 4999, 5000]);
    expect(tail.data.nextAfterSeq).toBeUndefined();
    expect((await post("/runs/events", { storeKey: key, id: "missing", afterSeq: 0 })).data).toEqual({ events: null });
    expect((await post("/runs/events", { storeKey: key, id: "big", afterSeq: 5000 })).data).toEqual({ events: [] });
  }, 60_000);

  it("stores each event's JSON verbatim: the run-page fields (callId, exitCode, output, input.source, the turn's timing + usage) come back unchanged from get and events", async () => {
    const key = storeKey();
    const evs: RunRecord["events"] = [
      { type: "input", text: "please review", source: { url: "https://x.slack.com/archives/C1/p1", channel: "general", user: "justin" }, at: 1 },
      { type: "turn", startedAt: 1, durationMs: 1, stopReason: "tool_use", usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 }, at: 2 },
      { type: "tool_call", tool: "bash", summary: "$ npm test", callId: "toolu_01", at: 2 },
      { type: "tool_result", tool: "bash", ok: false, summary: "exit 1: 3 failed", callId: "toolu_01", exitCode: 1, output: "exit 1:\n--- stderr ---\n3 failed", at: 3 },
    ];
    const rec = record("rich", Date.now(), { events: evs });
    expect((await post("/runs/put", { storeKey: key, record: rec })).status).toBe(200);
    // `seq` is the store's own key (position-stamped here); every other field is the JSON as written.
    const withoutSeq = (list: unknown) => (list as Array<RunRecord["events"][number] & { seq?: number }>).map(({ seq: _seq, ...e }) => e);
    expect(withoutSeq(((await post("/runs/get", { storeKey: key, id: "rich" })).data.record as RunRecord).events)).toEqual(evs);
    expect(withoutSeq((await post("/runs/events", { storeKey: key, id: "rich" })).data.events)).toEqual(evs);
  }, 60_000);

  it("events keep the registry seq: a record whose events carry seq 2001..7000 pages from afterSeq 6500 by that seq, and get returns them stamped", async () => {
    const key = storeKey();
    const rec = record("trimmed", Date.now(), { events: events(5000, 10, 2001), eventCount: 7000, storedEventCount: 5000, truncated: true });
    expect((await post("/runs/put", { storeKey: key, record: rec })).data).toMatchObject({ ok: true, stored: true });
    const page = await post("/runs/events", { storeKey: key, id: "trimmed", afterSeq: 6500, limit: 100 });
    const seqs = (page.data.events as Array<{ seq: number; summary: string }>).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => 6501 + i));
    expect((page.data.events as Array<{ summary: string }>)[0].summary).toMatch(/^step 4500 /);
    expect(page.data.nextAfterSeq).toBe(6600);
    const tail = await post("/runs/events", { storeKey: key, id: "trimmed", afterSeq: 6995 });
    expect((tail.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([6996, 6997, 6998, 6999, 7000]);
    expect(tail.data.nextAfterSeq).toBeUndefined();
    const got = (await post("/runs/get", { storeKey: key, id: "trimmed" })).data.record as RunRecord;
    expect(got.events.slice(0, 2).map((e) => e.seq)).toEqual([2001, 2002]);
    expect(got).toEqual(rec);
    // Events without a seq (a hand-built record) fall back to positions.
    const bare = record("bare", Date.now(), { events: events(3).map(({ seq: _s, ...e }) => e) });
    await post("/runs/put", { storeKey: key, record: bare });
    const bp = await post("/runs/events", { storeKey: key, id: "bare" });
    expect((bp.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2, 3]);
  }, 60_000);

  it("a stored record missing a diagnosis category still reads via get and list, normalized to every current category", async () => {
    const key = storeKey();
    const rec = record("legacy", Date.now());
    const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
    const put = await post("/runs/put", { storeKey: key, record: { ...rec, diagnosis: { ...rec.diagnosis, byCategory: { ...rest, retired: ZERO } } } });
    expect(put.status).toBe(200);
    const got = (await post("/runs/get", { storeKey: key, id: "legacy" })).data.record as RunRecord;
    expect(got.diagnosis.byCategory.slow_tool).toEqual(ZERO);
    expect(got.diagnosis.byCategory).not.toHaveProperty("retired");
    const [item] = (await post("/runs/list", { storeKey: key })).data.items as RunRecord[];
    expect(item.diagnosis.byCategory.slow_tool).toEqual(ZERO);
  });

  it("list cursor {before, beforeId}: same-finishedAt siblings across a page boundary all appear; a bad beforeId is 400", async () => {
    const key = storeKey();
    const now = Date.now();
    for (const id of ["tie-a", "tie-b", "tie-c"]) await putDirect(key, record(id, now, { events: events(1) }));
    await putDirect(key, record("older", now - 1000, { events: events(1) }));
    const page1 = await post("/runs/list", { storeKey: key, limit: 2 });
    expect((page1.data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(["tie-c", "tie-b"]);
    expect(page1.data.nextBefore).toEqual({ finishedAt: now, id: "tie-b" });
    const cursor = page1.data.nextBefore as { finishedAt: number; id: string };
    const page2 = await post("/runs/list", { storeKey: key, limit: 2, before: cursor.finishedAt, beforeId: cursor.id });
    expect((page2.data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(["tie-a", "older"]);
    expect(page2.data.nextBefore).toEqual({ finishedAt: now - 1000, id: "older" });
    expect(((await post("/runs/list", { storeKey: key, before: cursor.finishedAt, beforeId: cursor.id })).data.items as unknown[]).length).toBe(2);
    expect((await post("/runs/list", { storeKey: key, before: cursor.finishedAt, beforeId: "../x" })).status).toBe(400);
  });

  it("two puts for one id leave exactly one coherent event set; an identical repeat put is rewritten:false", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", { storeKey: key, record: record("a", now, { events: events(5) }) });
    const second = record("a", now, { events: events(3, 40) });
    expect((await post("/runs/put", { storeKey: key, record: second })).data).toMatchObject({ rewritten: true, retained: 1 });
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data.record).toEqual(second);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/put", { storeKey: key, record: second })).data).toMatchObject({ rewritten: false, retained: 1 });
    expect(await rowCount(key, "run_events")).toBe(3);
  });

  it("tombstone-first (#375): the DO accepts status `interrupted` (shared validator), and the finish put replaces the provisional record whole", async () => {
    const key = storeKey();
    const now = Date.now();
    // The provisional tombstone written at run start: terminal, finishedAt = startedAt, few events.
    const tombstone = record("t1", now - 5000, { status: "interrupted", startedAt: now - 5000, events: events(2) });
    expect((await post("/runs/put", { storeKey: key, record: tombstone })).status).toBe(200);
    expect((await post("/runs/get", { storeKey: key, id: "t1" })).data.record).toMatchObject({ status: "interrupted", finishedAt: now - 5000 });
    // The finish write: a different stored version (eventCount/finishedAt/bytes) → full rewrite.
    const final = record("t1", now, { status: "completed", startedAt: now - 5000, events: events(6) });
    expect((await post("/runs/put", { storeKey: key, record: final })).data).toMatchObject({ rewritten: true, retained: 1 });
    expect((await post("/runs/get", { storeKey: key, id: "t1" })).data.record).toEqual(final);
    expect(await rowCount(key, "run_events")).toBe(6);
    const list = (await post("/runs/list", { storeKey: key })).data.items as Array<{ id: string; status: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "t1", status: "completed" });
  });

  it("a put that fails mid-transaction leaves no runs row and no events", async () => {
    const key = storeKey();
    const rec = record("boom", Date.now(), { events: events(3) });
    let reads = 0;
    Object.defineProperty(rec.events, "2", {
      get() {
        reads++;
        throw new Error("torn event");
      },
    });
    await expect(putDirect(key, rec)).rejects.toThrow(/torn event/);
    expect(reads).toBeGreaterThan(0);
    expect(await rowCount(key, "runs")).toBe(0);
    expect(await rowCount(key, "run_events")).toBe(0);
  });

  it("policy: the newer policyUpdatedAt wins, an older proposal is ignored, retentionDays 0 → 400, a future stamp is clamped to the DO clock", async () => {
    const key = storeKey();
    const now = Date.now();
    const policy = (retentionDays: number) => ({ retentionDays, maxRuns: 5000, maxBytes: 64 * MIB });
    await post("/runs/put", { storeKey: key, record: record("old", now - 20 * DAY), policy: policy(30), policyUpdatedAt: now - 10_000 });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).not.toBeNull();
    // Older proposal with a tighter window: ignored, the run stays visible.
    await post("/runs/put", { storeKey: key, record: record("x", now), policy: policy(5), policyUpdatedAt: now - 20_000 });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).not.toBeNull();
    // Newer proposal: accepted, the run is now hidden.
    await post("/runs/put", { storeKey: key, record: record("y", now), policy: policy(5), policyUpdatedAt: now - 5_000 });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).toBeNull();
    expect((await post("/runs/put", { storeKey: key, record: record("z", now), policy: policy(0), policyUpdatedAt: now })).status).toBe(400);
    expect((await post("/runs/put", { storeKey: key, record: record("z", now), policy: { maxRuns: 0 }, policyUpdatedAt: now })).status).toBe(400);

    // A proposal dated a year ahead is stored with the DO clock, so a later,
    // correctly dated proposal still wins.
    const key2 = storeKey();
    await post("/runs/put", { storeKey: key2, record: record("old", now - 20 * DAY), policy: policy(30), policyUpdatedAt: now + 365 * DAY });
    const stored = await runInDurableObject(stubOf(key2), (inst: RunHistoryDO) => inst.policyState());
    expect(stored.policyUpdatedAt).toBeLessThanOrEqual(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    await post("/runs/put", { storeKey: key2, record: record("y", now), policy: policy(5), policyUpdatedAt: Date.now() });
    expect((await runInDurableObject(stubOf(key2), (inst: RunHistoryDO) => inst.policyState())).policy.retentionDays).toBe(5);
    expect((await post("/runs/get", { storeKey: key2, id: "old" })).data.record).toBeNull();
  });

  it("get/list never accept a policy: a generous body policy cannot resurrect a hidden row", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", { storeKey: key, record: record("old", now - 20 * DAY), policy: { retentionDays: 5, maxRuns: 100, maxBytes: 64 * MIB }, policyUpdatedAt: now });
    expect((await post("/runs/get", { storeKey: key, id: "old", policy: { retentionDays: 365 }, policyUpdatedAt: now + 1 })).data).toEqual({ record: null });
    expect((await post("/runs/list", { storeKey: key, policy: { retentionDays: 365 }, policyUpdatedAt: now + 1 })).data).toEqual({ items: [] });
    // and the persisted policy is unchanged
    expect((await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.policyState())).policy.retentionDays).toBe(5);
  });

  it("a shrink dropping >25% deletes at most 500 rows per put while list already hides them", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 620; i++) await putDirect(key, record(`r${String(i).padStart(4, "0")}`, now - i * 1000, { events: events(1) }));
    expect(await rowCount(key, "runs")).toBe(620);
    const res = await putDirect(key, record("new", now + 1, { events: events(1) }), { policy: { retentionDays: 30, maxRuns: 50, maxBytes: 64 * MIB }, policyUpdatedAt: now });
    expect(res.stored).toBe(true);
    expect(res.retained).toBe(50);
    // 621 - 50 = 571 outside policy; the fence deletes 500 of them this put.
    expect(await rowCount(key, "runs")).toBe(621 - 500);
    expect(await rowCount(key, "run_events")).toBe(621 - 500);
    const list = await post("/runs/list", { storeKey: key, limit: 200 });
    expect(list.data.items as unknown[]).toHaveLength(50);
    expect((list.data.items as Array<{ id: string }>)[0].id).toBe("new");
    // Rows still on disk behind the fence are hidden on every read path.
    expect(await runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => state.storage.sql.exec(`SELECT 1 FROM runs WHERE run_id = 'r0100'`).toArray().length)).toBe(1);
    expect((await post("/runs/get", { storeKey: key, id: "r0100" })).data).toEqual({ record: null });
    expect((await post("/runs/events", { storeKey: key, id: "r0100" })).data).toEqual({ events: null });
    // the next put finishes the job
    await putDirect(key, record("new2", now + 2, { events: events(1) }));
    expect(await rowCount(key, "runs")).toBe(50);
    expect(await rowCount(key, "run_events")).toBe(50);
  }, 60_000);

  it("get/events hide exactly what list hides for rows still on disk: age, then newest maxRuns (id tie-break), then maxBytes drop-oldest", async () => {
    // The policy is written straight into `meta` so the rows stay ON DISK
    // (a put would trim them): every read path must then agree row by row.
    const setPolicy = (key: string, policy: Record<string, number>) =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => {
        state.storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ ...policy, policyUpdatedAt: Date.now() }));
      });
    const idsOnDisk = (key: string) =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => state.storage.sql.exec<{ run_id: string; bytes: number }>(`SELECT run_id, bytes FROM runs`).toArray());
    const agree = async (key: string, expected: string[]) => {
      const listed = ((await post("/runs/list", { storeKey: key, limit: 200 })).data.items as Array<{ id: string }>).map((r) => r.id);
      expect(listed).toEqual(expected);
      for (const { run_id } of await idsOnDisk(key)) {
        const visible = listed.includes(run_id);
        expect((await post("/runs/get", { storeKey: key, id: run_id })).data.record !== null, `get ${run_id}`).toBe(visible);
        expect((await post("/runs/events", { storeKey: key, id: run_id })).data.events !== null, `events ${run_id}`).toBe(visible);
      }
    };
    const now = Date.now();

    // maxRuns with a finishedAt tie: t2 ranks ahead of t1 (run_id desc); age drops `old`.
    const k1 = storeKey();
    for (const [id, at] of [["old", now - 20 * DAY], ["a", now - 1000], ["t1", now - 2500], ["t2", now - 2500], ["b", now - 2000], ["c", now - 3000], ["d", now - 4000]] as const) {
      await putDirect(k1, record(id, at, { events: events(1) }));
    }
    expect(await rowCount(k1, "runs")).toBe(7);
    await setPolicy(k1, { retentionDays: 10, maxRuns: 4, maxBytes: 64 * MIB });
    expect(await rowCount(k1, "runs")).toBe(7); // nothing deleted — hidden only
    await agree(k1, ["a", "b", "t2", "t1"]);

    // maxBytes: four ~4.5 MiB records fill the budget exactly; the fifth-newest
    // and everything older fall off even though maxRuns would keep them.
    const k2 = storeKey();
    const big = () => events(72, 64 * 1024 - 100);
    for (const [id, at] of [["a", now - 1000], ["b", now - 2000], ["t1", now - 2500], ["t2", now - 2500]] as const) await putDirect(k2, record(id, at, { events: big() }));
    await putDirect(k2, record("c", now - 3000, { events: events(1) }));
    await putDirect(k2, record("d", now - 4000, { events: events(1) }));
    const bytesOf = Object.fromEntries((await idsOnDisk(k2)).map((r) => [r.run_id, r.bytes]));
    const budget = bytesOf.a + bytesOf.b + bytesOf.t2 + bytesOf.t1;
    expect(budget).toBeGreaterThanOrEqual(16 * MIB); // above the policy floor, so the clamp does not widen it
    await setPolicy(k2, { retentionDays: 30, maxRuns: 100, maxBytes: budget });
    await agree(k2, ["a", "b", "t2", "t1"]);
    await setPolicy(k2, { retentionDays: 30, maxRuns: 100, maxBytes: budget - 1 });
    await agree(k2, ["a", "b", "t2"]);
  }, 120_000);

  it("after a maxRuns trim the evicted run's events are gone; a re-put with 3 events leaves 3 rows; a record outside policy is stored:false", async () => {
    const key = storeKey();
    const now = Date.now();
    const proposal = { policy: { retentionDays: 30, maxRuns: 2, maxBytes: 64 * MIB }, policyUpdatedAt: now };
    await putDirect(key, record("a", now - 3000, { events: events(4) }), proposal);
    await putDirect(key, record("b", now - 2000, { events: events(4) }));
    await putDirect(key, record("c", now - 1000, { events: events(4) }));
    expect(await rowCount(key, "runs")).toBe(2);
    expect(await rowCount(key, "run_events")).toBe(8);
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data).toEqual({ record: null });
    const again = await putDirect(key, record("c", now - 1000, { events: events(3) }));
    expect(again).toEqual({ ok: true, retained: 2, stored: true, rewritten: true });
    expect(await rowCount(key, "run_events")).toBe(7);
    const outside = await putDirect(key, record("older", now - 40 * DAY, { events: events(2) }));
    expect(outside).toEqual({ ok: true, retained: 2, stored: false, rewritten: false });
    expect(await rowCount(key, "runs")).toBe(2);
  });

  it("a finishedAt one year ahead is clamped to now + 24 h and stored_at is recorded", async () => {
    const key = storeKey();
    const before = Date.now();
    await post("/runs/put", { storeKey: key, record: record("future", before + 365 * DAY) });
    const row = await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) =>
      state.storage.sql.exec<{ finished_at: number; stored_at: number }>(`SELECT finished_at, stored_at FROM runs WHERE run_id = 'future'`).one(),
    );
    expect(row.finished_at).toBeLessThanOrEqual(Date.now() + DAY);
    expect(row.finished_at).toBeGreaterThanOrEqual(before + DAY - 1);
    expect(row.stored_at).toBeGreaterThanOrEqual(before);
    const got = (await post("/runs/get", { storeKey: key, id: "future" })).data.record as RunRecord;
    expect(got.finishedAt).toBe(row.finished_at);
  });

  it("the alarm deletes expired rows with no writes, and get is then not-found", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", { storeKey: key, record: record("old", now - 20 * DAY), policy: { retentionDays: 30, maxRuns: 100, maxBytes: 64 * MIB }, policyUpdatedAt: now });
    await post("/runs/put", { storeKey: key, record: record("fresh", now) });
    // Tighten the policy so `old` is outside it — via the meta table, exactly
    // what a shrink would persist — without a put that would trim it.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.policyState());
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'policy'`, JSON.stringify({ retentionDays: 5, maxRuns: 100, maxBytes: 64 * MIB, policyUpdatedAt: now }));
    });
    expect(await rowCount(key, "runs")).toBe(2);
    expect(await runDurableObjectAlarm(stubOf(key))).toBe(true); // an alarm was scheduled by the first put
    expect(await rowCount(key, "runs")).toBe(1);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data).toEqual({ record: null });
    expect((await post("/runs/get", { storeKey: key, id: "fresh" })).data.record).not.toBeNull();
    expect(await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => state.storage.getAlarm())).not.toBeNull(); // rescheduled
  });

  it("body fence: 2 MiB cap on /runs/put (at cap ok, +1 byte 413) measured in bytes; other routes keep 512 KB; missing Content-Length → 411", async () => {
    const key = storeKey();
    const now = Date.now();
    const envelope = (rec: RunRecord) => JSON.stringify({ storeKey: key, record: rec });
    // Grow one event's summary until the body is exactly 2 MiB.
    const base = record("cap", now, { events: [{ type: "tool_call", tool: "bash", summary: "" }] });
    const pad = 2 * MIB - new TextEncoder().encode(envelope(base)).byteLength;
    const atCap = record("cap", now, { events: [{ type: "tool_call", tool: "bash", summary: "x".repeat(pad) }] });
    expect(new TextEncoder().encode(envelope(atCap)).byteLength).toBe(2 * MIB);
    expect((await post("/runs/put", envelope(atCap))).status).toBe(200);
    const over = record("cap", now, { events: [{ type: "tool_call", tool: "bash", summary: "x".repeat(pad + 1) }] });
    expect((await post("/runs/put", envelope(over))).status).toBe(413);
    // 1.9 MB of multibyte text: fewer chars than bytes, measured in bytes.
    const multi = record("multi", now, { events: [{ type: "tool_call", tool: "bash", summary: "é".repeat(950_000) }] });
    const multiBody = envelope(multi);
    expect(multiBody.length).toBeLessThan(1_000_000);
    expect(new TextEncoder().encode(multiBody).byteLength).toBeGreaterThan(1_900_000);
    expect((await post("/runs/put", multiBody)).status).toBe(200);
    expect(((await post("/runs/get", { storeKey: key, id: "multi" })).data.record as RunRecord).events[0]).toEqual({ ...multi.events[0], seq: 1 }); // no seq given → position
    // other routes keep the 512 KB fence
    const bigList = JSON.stringify({ storeKey: key, agent: "x".repeat(600 * 1024) });
    expect((await post("/runs/list", bigList)).status).toBe(413);
    // missing Content-Length → 411 (a streamed body)
    const res = await SELF.fetch(`${BASE}/runs/put`, {
      method: "POST",
      headers: AUTH,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(envelope(base)));
          c.close();
        },
      }),
      // @ts-expect-error duplex is required for streamed request bodies
      duplex: "half",
    });
    expect(res.status).toBe(411);
  });

  it("validates: bad store key, malformed record, bad id, bad limit → 400; unknown route → 404; no bearer → 401; GET → 405", async () => {
    const key = storeKey();
    expect((await post("/runs/put", { storeKey: "has space", record: record("a", 1) })).status).toBe(400);
    expect((await post("/runs/put", { storeKey: key, record: { id: "a" } })).data).toEqual({ error: "record must be a RunRecord" });
    expect((await post("/runs/get", { storeKey: key, id: "../x" })).status).toBe(400);
    expect((await post("/runs/events", { storeKey: key, id: "a", limit: 0 })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, limit: "5" })).status).toBe(400);
    expect((await post("/runs/nope", { storeKey: key })).status).toBe(404);
    expect((await post("/runs/get", { storeKey: key, id: "a" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/runs/list`, { headers: AUTH })).status).toBe(405);
  });

  it("a corrupt event row is skipped: the run still returns with the remaining events", async () => {
    const key = storeKey();
    await post("/runs/put", { storeKey: key, record: record("a", Date.now(), { events: events(3) }) });
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`UPDATE run_events SET json = '{not json' WHERE run_id = 'a' AND seq = 2`);
    });
    const got = (await post("/runs/get", { storeKey: key, id: "a" })).data.record as RunRecord;
    expect(got.events.map((e) => (e as { summary: string }).summary.slice(0, 6))).toEqual(["step 0", "step 2"]);
    const page = await post("/runs/events", { storeKey: key, id: "a" });
    expect((page.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 3]);
  });

  it("/healthz lists runs", async () => {
    const res = await SELF.fetch(`${BASE}/healthz`);
    expect(await res.json()).toEqual({ ok: true, features: ["memory", "friction", "schedules", "runs", "config"] });
  });

  it("list: newest-first, limit 1000 → at most 200 rows plus a cursor; before/sinceMs/agent/channel filters; no events on the wire", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 230; i++) {
      await putDirect(key, record(`r${String(i).padStart(3, "0")}`, now - i * 1000, { events: events(1), agent: i % 2 ? "review" : "coding", channelId: i % 5 ? "slack:C1" : "slack:C2" }));
    }
    const page = await post("/runs/list", { storeKey: key, limit: 1000 });
    const items = page.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(200);
    expect(items[0].id).toBe("r000");
    expect(items[0].events).toBeUndefined();
    expect(items[0].bytes).toBeGreaterThan(100);
    expect(page.data.nextBefore).toEqual({ finishedAt: items[199].finishedAt, id: items[199].id });
    const cursor = page.data.nextBefore as { finishedAt: number; id: string };
    const rest = await post("/runs/list", { storeKey: key, limit: 200, before: cursor.finishedAt, beforeId: cursor.id });
    expect((rest.data.items as unknown[]).length).toBe(30);
    expect(rest.data.nextBefore).toBeUndefined();
    expect((await post("/runs/list", { storeKey: key })).data.items as unknown[]).toHaveLength(50);
    expect((await post("/runs/list", { storeKey: key, sinceMs: now - 2500 })).data.items as unknown[]).toHaveLength(3);
    const coding = (await post("/runs/list", { storeKey: key, agent: "coding", limit: 5 })).data.items as Array<{ agent: string }>;
    expect(coding).toHaveLength(5);
    expect(coding.every((r) => r.agent === "coding")).toBe(true);
    const c2 = (await post("/runs/list", { storeKey: key, channel: "slack:C2", limit: 5 })).data.items as Array<{ channelId: string }>;
    expect(c2.every((r) => r.channelId === "slack:C2")).toBe(true);
  }, 60_000);

  it("/runs/summary returns the listing row (no events, with bytes) for a kept run and {summary: null} otherwise, reading no event rows", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirect(key, record("s1", now, { events: events(300) }));
    const res = await post("/runs/summary", { storeKey: key, id: "s1" });
    expect(res.status).toBe(200);
    const summary = res.data.summary as Record<string, unknown>;
    expect(summary.id).toBe("s1");
    expect(summary.eventCount).toBe(300);
    expect(summary.events).toBeUndefined();
    expect(summary.bytes).toBeGreaterThan(1000);
    expect((await post("/runs/summary", { storeKey: key, id: "nope" })).data).toEqual({ summary: null });
    expect((await post("/runs/summary", { storeKey: key, id: "../x" })).status).toBe(400);
    const statements = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      await inst.summary("s1");
      return seen;
    });
    expect(statements.some((q) => /run_events/.test(q))).toBe(false);
  });

  it("list fast path: within maxRuns/maxBytes the page is ONE LIMITed query with no retention scan; over a bound it falls back to the kept set with identical rows and order", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await putDirect(key, record(`f${String(i).padStart(2, "0")}`, now - i * 1000, { events: events(1), agent: i % 2 ? "review" : "coding", channelId: i % 3 ? "slack:C1" : "slack:C2" }));
    }
    const expectIds = async (q: Record<string, unknown>, ids: string[]) => {
      expect(((await post("/runs/list", { storeKey: key, ...q })).data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(ids);
    };
    const all = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    // Fast path: the plan is one SELECT … LIMIT, and the retention scan never runs.
    const fast = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({ limit: 5, agent: "coding" });
      return { seen, ids: res.items.map((r) => r.id), next: res.nextBefore };
    });
    expect(fast.ids).toEqual(["f00", "f02", "f04", "f06", "f08"]);
    expect(fast.next).toEqual({ finishedAt: now - 8000, id: "f08" });
    expect(fast.seen.filter((q) => /FROM runs/.test(q) && /ORDER BY finished_at ASC/.test(q))).toEqual([]);
    const page = fast.seen.filter((q) => /ORDER BY finished_at DESC/.test(q));
    expect(page).toHaveLength(1);
    expect(page[0]).toMatch(/LIMIT \?/);
    expect(page[0]).toMatch(/agent = \?/);
    await expectIds({ limit: 200 }, all);
    await expectIds({ channel: "slack:C2" }, ["f00", "f03", "f06", "f09"]);
    await expectIds({ limit: 3, before: now - 2000, beforeId: "f02" }, ["f03", "f04", "f05"]);
    await expectIds({ sinceMs: now - 2500 }, ["f00", "f01", "f02"]);

    // Slow path: a policy the rows exceed (written straight into meta so they stay on disk).
    await runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => {
      state.storage.sql.exec(`INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, JSON.stringify({ retentionDays: 30, maxRuns: 7, maxBytes: 8 * 1024 * 1024 * 1024, policyUpdatedAt: Date.now() }));
    });
    const slow = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({ limit: 200 });
      return { seen, ids: res.items.map((r) => r.id) };
    });
    expect(slow.ids).toEqual(all.slice(0, 7));
    expect(slow.seen.some((q) => /ORDER BY finished_at ASC/.test(q))).toBe(true);
    await expectIds({ agent: "review", limit: 200 }, ["f01", "f03", "f05"]);
    await expectIds({ limit: 3, before: now - 2000, beforeId: "f02" }, ["f03", "f04", "f05"]);
    await expectIds({ limit: 200, before: now - 5000, beforeId: "f05" }, ["f06"]);
    // get agrees with list on what is hidden, so the two paths hide the same rows.
    expect((await post("/runs/get", { storeKey: key, id: "f07" })).data).toEqual({ record: null });
    expect(((await post("/runs/get", { storeKey: key, id: "f06" })).data.record as { id: string }).id).toBe("f06");
  });

  it("list with `visibleTo` (authorization.md item 6): channels-in compiles to an indexed IN filter on the ONE LIMITed page query; visibility-in / user-is / or / and follow the same truth table as the in-memory store; none is an empty page; a bad filter is 400, never `all`", async () => {
    const key = storeKey();
    const now = Date.now();
    await putDirect(key, record("pub", now - 1000, { events: events(1), channelId: "slack:C_PUB", userId: "slack:U1", channelVisibility: "public" }));
    await putDirect(key, record("priv", now - 2000, { events: events(1), channelId: "slack:G1", userId: "slack:U2", channelVisibility: "private" }));
    await putDirect(key, record("ops", now - 3000, { events: events(1), channelId: "http:ops", userId: "http:ci", channelVisibility: "machine" }));
    await putDirect(key, record("dev", now - 4000, { events: events(1), channelId: "mcp:dev", userId: "mcp:ci", channelVisibility: "machine" }));
    const ids = async (visibleTo: unknown, more: Record<string, unknown> = {}) => {
      const res = await post("/runs/list", { storeKey: key, visibleTo, ...more });
      expect(res.status).toBe(200);
      return (res.data.items as Array<{ id: string }>).map((r) => r.id);
    };
    expect(await ids({ kind: "all" })).toEqual(["pub", "priv", "ops", "dev"]);
    expect(await ids({ kind: "none" })).toEqual([]);
    expect(await ids({ kind: "channels-in", channelIds: ["http:ops", "mcp:dev"] })).toEqual(["ops", "dev"]);
    expect(await ids({ kind: "channels-in", channelIds: [] })).toEqual([]);
    expect(await ids({ kind: "visibility-in", visibilities: ["public"] })).toEqual(["pub"]);
    expect(await ids({ kind: "user-is", userId: "slack:U2" })).toEqual(["priv"]);
    // member-of as the compiler emits it for a token granted http:ops, plus its own runs.
    expect(await ids({ kind: "or", of: [{ kind: "channels-in", channelIds: ["http:ops"] }, { kind: "visibility-in", visibilities: ["public"] }, { kind: "user-is", userId: "http:ci" }] })).toEqual(["pub", "ops"]);
    expect(await ids({ kind: "and", of: [{ kind: "channels-in", channelIds: ["slack:G1"] }, { kind: "user-is", userId: "slack:U2" }] })).toEqual(["priv"]);
    expect(await ids({ kind: "and", of: [{ kind: "channels-in", channelIds: ["slack:G1"] }, { kind: "user-is", userId: "slack:U1" }] })).toEqual([]);
    // ANDed with the plain filters and the cursor.
    expect(await ids({ kind: "channels-in", channelIds: ["http:ops", "mcp:dev", "slack:C_PUB"] }, { channel: "mcp:dev" })).toEqual(["dev"]);
    expect(await ids({ kind: "channels-in", channelIds: ["http:ops", "mcp:dev", "slack:C_PUB"] }, { before: now - 1000, beforeId: "pub" })).toEqual(["ops", "dev"]);
    // The plan: ONE indexed page query carrying the IN, no retention scan.
    const plan = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({ limit: 5, visibleTo: { kind: "or", of: [{ kind: "channels-in", channelIds: ["http:ops"] }, { kind: "visibility-in", visibilities: ["public"] }] } });
      return { seen, ids: res.items.map((r) => r.id) };
    });
    expect(plan.ids).toEqual(["pub", "ops"]);
    expect(plan.seen.filter((q) => /FROM runs/.test(q) && /ORDER BY finished_at ASC/.test(q))).toEqual([]);
    const page = plan.seen.filter((q) => /ORDER BY finished_at DESC/.test(q));
    expect(page).toHaveLength(1);
    expect(page[0]).toMatch(/channel_id IN \(\?\)/);
    expect(page[0]).toMatch(/channel_visibility IN \(\?\)/);
    expect(page[0]).toMatch(/LIMIT \?/);
    // Malformed or too wide → 400 with the field named; nothing widens to `all`.
    expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "everything" } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["everyone"] } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "channels-in", channelIds: Array.from({ length: 95 }, (_, i) => `c${i}`) } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "channels-in", channelIds: Array.from({ length: 90 }, (_, i) => `c${i}`) } })).status).toBe(200);
  });

  it("a table created before the visibility stamp gains the column with `unknown` for every existing row (the one migration), and a record put without the stamp reads back as `unknown` — never public", async () => {
    const key = storeKey();
    const now = Date.now();
    // Recreate the pre-stamp schema by hand: drop the column, then reconstruct the DO to run the migration.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_visibility_finished`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN channel_visibility`);
      const columns = state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(runs)`).toArray().map((c) => c.name);
      expect(columns).not.toContain("channel_visibility");
    });
    // A row written straight into the old shape (as a pre-migration DO would have left it).
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const { events: _e, channelVisibility: _v, ...summary } = record("legacy", now - 1000);
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        summary.id, summary.label ?? null, summary.agent ?? null, summary.model ?? null, summary.channelId, summary.userId, summary.threadKey, null, summary.startedAt, summary.finishedAt, now, summary.status, 0, 0, 0, 100, JSON.stringify(summary.diagnosis), JSON.stringify(summary),
      );
      // Simulate the next constructor run: the migration the DO applies on load.
      const cols = new Set(state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(runs)`).toArray().map((c) => c.name));
      if (!cols.has("channel_visibility")) state.storage.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    });
    const listed = (await post("/runs/list", { storeKey: key })).data.items as Array<{ id: string; channelVisibility?: string }>;
    expect(listed.map((r) => r.id)).toEqual(["legacy"]);
    expect(await runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => state.storage.sql.exec<{ v: string }>(`SELECT channel_visibility AS v FROM runs WHERE run_id = 'legacy'`).one().v)).toBe("unknown");
    expect((await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["public"] } })).data.items).toEqual([]);
    expect(((await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["unknown"] } })).data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(["legacy"]);
    // A put without the stamp (an older bot) stores `unknown` too.
    const { channelVisibility: _cv, ...unstamped } = record("unstamped", now - 500, { events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: unstamped })).status).toBe(200);
    expect(await runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) => state.storage.sql.exec<{ v: string }>(`SELECT channel_visibility AS v FROM runs WHERE run_id = 'unstamped'`).one().v)).toBe("unknown");
    // And a stamped put is stored as stamped and filterable.
    await post("/runs/put", { storeKey: key, record: record("stamped", now - 200, { events: events(1), channelVisibility: "public" }) });
    expect(((await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["public"] } })).data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(["stamped"]);
  });

  it("delete removes the run and all its events; deleting an unknown id is fine", async () => {
    const key = storeKey();
    await post("/runs/put", { storeKey: key, record: record("a", Date.now(), { events: events(4) }) });
    await post("/runs/put", { storeKey: key, record: record("b", Date.now(), { events: events(2) }) });
    expect((await post("/runs/delete", { storeKey: key, id: "a" })).data).toEqual({ ok: true, deleted: true });
    expect(await rowCount(key, "run_events")).toBe(2);
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data).toEqual({ record: null });
    expect((await post("/runs/list", { storeKey: key })).data.items as Array<{ id: string }>).toHaveLength(1);
    expect((await post("/runs/delete", { storeKey: key, id: "a" })).data).toEqual({ ok: true, deleted: false });
  });
});
