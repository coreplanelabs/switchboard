import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../src/core/runRecord.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";
import { blobOf, pointOf, type RunMetricsPoint } from "../../src/core/runMetrics.ts";
import { featuresOf, RUN_EVENT_INSERT_BATCH, RunHistoryDO } from "./worker.ts";

// Feature: docs/reference/specs/run-history.md — the RunHistoryDO: the durable
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
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...headers, "content-length": String(new TextEncoder().encode(raw).byteLength) },
    body: raw,
  });
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
  // Every current analyzer category, zeroed — the DO normalizes on read, so a
  // fixture pinned to a category list would drift the moment one is added.
  byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, ZERO])) as RunRecord["diagnosis"]["byCategory"],
  findings: [],
  verdict: "no friction detected",
});

/** Events stamped 1..count like the registry stamps them (`seq` is what the store keys on). */
function events(count: number, size = 10, firstSeq = 1): RunRecord["events"] {
  return Array.from({ length: count }, (_, i) => ({
    type: "tool_call" as const,
    tool: "bash",
    summary: `step ${i} ${"x".repeat(size)}`,
    seq: firstSeq + i,
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
  runInDurableObject(
    stubOf(key),
    async (_inst: RunHistoryDO, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
  );
const putDirect = (
  key: string,
  rec: RunRecord,
  proposal?: { policy: Record<string, number>; policyUpdatedAt: number },
) => runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.put(rec, proposal));

// docs/reference/specs/run-history.md item 56: the record's usage is stored beside
// the row; `/runs/usage` answers one row per run with its thread, channel and
// agent, names the parents outside the batch, and fills in a record written
// before the field from its stored model.turn events as it answers.
describe("run usage", () => {
  const T = Date.UTC(2026, 8, 15, 5, 0, 0);
  const modelTurn = (seq: number, model: string, inputTokens: number, outputTokens: number) =>
    ({
      type: "span_end",
      spanId: `m${seq}`,
      parentSpanId: "agent",
      name: "model.turn",
      startedAt: T - 5000 + seq,
      durationMs: 100,
      status: "ok",
      attrs: { model, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      seq,
    }) as unknown as RunRecord["events"][number];

  it("put stores the record's usage; /runs/usage answers one row per run with its thread, channel and agent, names a parent outside the batch, backfills a usage-less record from its events, and bounds the range to what is held", async () => {
    const key = storeKey();
    const usage = (input: number, output: number) => ({
      turns: 1,
      byModel: {
        "anthropic/claude-fable-5": {
          turns: 1,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    });
    // Alice's run, with usage as every record written since carries it — finished a week before the range.
    await post("/runs/put", {
      storeKey: key,
      record: record("alice-1", T - DAY, { usage: usage(100, 10), userName: "alice" }),
    });
    // A child the coordinator started for alice, in the unit's thread on the coding agent: its own
    // user_id is the coordinator's, and its parent is outside the range asked below.
    await post("/runs/put", {
      storeKey: key,
      record: record("child-1", T + 20_000, {
        userId: "http:coordinator",
        parentRunId: "alice-1",
        threadKey: "slack:C1:9",
        agent: "coding",
        usage: usage(1, 1),
      }),
    });
    // Bob's record from before the field existed: no usage, but the turn is in its events.
    const legacy = record("bob-old", T + 120_000, {
      userId: "slack:UBOB",
      userName: "bob",
      events: [
        { type: "input", text: "go", seq: 1 } as RunRecord["events"][number],
        modelTurn(2, "anthropic/claude-haiku-4-5", 40, 4),
      ],
    });
    delete (legacy as Partial<RunRecord>).usage;
    await post("/runs/put", { storeKey: key, record: legacy });
    // Alice, the next UTC day.
    await post("/runs/put", {
      storeKey: key,
      record: record("alice-2", T + 86_400_000, { usage: usage(5, 5), userName: "alice" }),
    });

    const first = await post("/runs/usage", { storeKey: key, sinceMs: T - 1, untilMs: T + 2 * 86_400_000 });
    expect(first.status).toBe(200);
    const runs = first.data.runs as Array<Record<string, unknown>>;
    // One row per run, oldest finish first, each with its own requester, thread, channel and agent.
    expect(runs.map((r) => `${r.id} ${r.userId} ${r.threadKey} ${r.channelId} ${r.agent}`)).toEqual([
      "child-1 http:coordinator slack:C1:9 slack:C1 coding",
      "bob-old slack:UBOB slack:C1:1 slack:C1 review",
      "alice-2 slack:UALICE slack:C1:1 slack:C1 review",
    ]);
    const child = runs[0] as { parentRunId: string; usage: { turns: number }; startedAt: number; finishedAt: number };
    expect(child.parentRunId).toBe("alice-1");
    expect(child.usage.turns).toBe(1);
    expect(child.finishedAt - child.startedAt).toBe(5000); // each fixture run is 5 s wall clock
    // The parent outside the range is named so the bot can bill the child to alice.
    expect(first.data.parents).toEqual({ "alice-1": { userId: "slack:UALICE", userName: "alice" } });
    // Bob's legacy row was priced from its events on this read: not pending, and written back.
    const bob = runs[1] as { userName: string; usage: { byModel: Record<string, { inputTokens: number }> } };
    expect(bob.userName).toBe("bob");
    expect(bob.usage.byModel["anthropic/claude-haiku-4-5"].inputTokens).toBe(40);
    expect(first.data.pending).toBe(0);
    expect(first.data.retentionDays).toBe(30);
    expect(first.data.earliestFinishedAt).toBe(T - DAY);
    const stored = await runInDurableObject(
      stubOf(key),
      async (_inst: RunHistoryDO, state) =>
        state.storage.sql
          .exec<{ usage_json: string | null }>(`SELECT usage_json FROM runs WHERE run_id = 'bob-old'`)
          .one().usage_json,
    );
    expect(JSON.parse(stored ?? "null")).toMatchObject({ turns: 1 });
    // The range is honoured: the second day alone, and no parent to name.
    const second = await post("/runs/usage", {
      storeKey: key,
      sinceMs: T + 86_000_000,
      untilMs: T + 2 * 86_400_000,
    });
    expect((second.data.runs as Array<{ id: string }>).map((r) => r.id)).toEqual(["alice-2"]);
    expect(second.data.parents).toEqual({});
  });

  it("refuses a malformed range by name", async () => {
    const key = storeKey();
    expect((await post("/runs/usage", { storeKey: key, sinceMs: 10, untilMs: 5 })).status).toBe(400);
    expect((await post("/runs/usage", { storeKey: key, sinceMs: 0, untilMs: 400 * 86_400_000 })).status).toBe(400);
    expect((await post("/runs/usage", { storeKey: key, sinceMs: "x", untilMs: 5 })).status).toBe(400);
    const empty = await post("/runs/usage", { storeKey: key, sinceMs: 0, untilMs: 1 });
    expect(empty.status).toBe(200);
    expect(empty.data).toMatchObject({ runs: [], parents: {}, pending: 0 });
  });
});

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
    expect((page.data.events as Array<{ seq: number; summary: string }>).map((e) => e.seq)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect((page.data.events as Array<{ summary: string }>)[0].summary).toMatch(/^step 10 /);
    expect(page.data.nextAfterSeq).toBe(15);
    const tail = await post("/runs/events", { storeKey: key, id: "big", afterSeq: 4995, limit: 100 });
    expect((tail.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([4996, 4997, 4998, 4999, 5000]);
    expect(tail.data.nextAfterSeq).toBeUndefined();
    expect((await post("/runs/events", { storeKey: key, id: "missing", afterSeq: 0 })).data).toEqual({ events: null });
    expect((await post("/runs/events", { storeKey: key, id: "big", afterSeq: 5000 })).data).toEqual({ events: [] });
  }, 60_000);

  it("stores each event's JSON verbatim: the run-page fields (callId, exitCode, output, input.source, the model.turn span's timing + usage) come back unchanged from get and events", async () => {
    const key = storeKey();
    const evs: RunRecord["events"] = [
      {
        type: "input",
        text: "please review",
        source: { url: "https://x.slack.com/archives/C1/p1", channel: "general", user: "alice" },
        at: 1,
      },
      {
        type: "span_end",
        spanId: "m1",
        name: "model.turn",
        startedAt: 1,
        durationMs: 1,
        status: "ok",
        attrs: { stopReason: "tool_use", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 },
        at: 2,
      },
      { type: "tool_call", tool: "bash", summary: "$ npm test", callId: "toolu_01", at: 2 },
      {
        type: "tool_result",
        tool: "bash",
        ok: false,
        summary: "exit 1: 3 failed",
        callId: "toolu_01",
        exitCode: 1,
        output: "exit 1:\n--- stderr ---\n3 failed",
        at: 3,
      },
    ];
    const rec = record("rich", Date.now(), { events: evs });
    expect((await post("/runs/put", { storeKey: key, record: rec })).status).toBe(200);
    // `seq` is the store's own key (position-stamped here); every other field is the JSON as written.
    const withoutSeq = (list: unknown) =>
      (list as Array<RunRecord["events"][number] & { seq?: number }>).map(({ seq: _seq, ...e }) => e);
    expect(
      withoutSeq(((await post("/runs/get", { storeKey: key, id: "rich" })).data.record as RunRecord).events),
    ).toEqual(evs);
    expect(withoutSeq((await post("/runs/events", { storeKey: key, id: "rich" })).data.events)).toEqual(evs);
  }, 60_000);

  it("events keep the registry seq: a record whose events carry seq 2001..7000 pages from afterSeq 6500 by that seq, and get returns them stamped", async () => {
    const key = storeKey();
    const rec = record("trimmed", Date.now(), {
      events: events(5000, 10, 2001),
      eventCount: 7000,
      storedEventCount: 5000,
      truncated: true,
    });
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
    const put = await post("/runs/put", {
      storeKey: key,
      record: { ...rec, diagnosis: { ...rec.diagnosis, byCategory: { ...rest, retired: ZERO } } },
    });
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
    expect(
      (
        (await post("/runs/list", { storeKey: key, before: cursor.finishedAt, beforeId: cursor.id })).data
          .items as unknown[]
      ).length,
    ).toBe(2);
    expect((await post("/runs/list", { storeKey: key, before: cursor.finishedAt, beforeId: "../x" })).status).toBe(400);
  });

  it("two puts for one id leave exactly one coherent event set; an identical repeat put is rewritten:false", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", { storeKey: key, record: record("a", now, { events: events(5) }) });
    const second = record("a", now, { events: events(3, 40) });
    expect((await post("/runs/put", { storeKey: key, record: second })).data).toMatchObject({
      rewritten: true,
      retained: 1,
    });
    expect((await post("/runs/get", { storeKey: key, id: "a" })).data.record).toEqual(second);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/put", { storeKey: key, record: second })).data).toMatchObject({
      rewritten: false,
      retained: 1,
    });
    expect(await rowCount(key, "run_events")).toBe(3);
  });

  it("tombstone-first: the DO accepts status `interrupted` (shared validator), and the finish put replaces the provisional record whole", async () => {
    const key = storeKey();
    const now = Date.now();
    // The provisional tombstone written at run start: terminal, finishedAt = startedAt, few events.
    const tombstone = record("t1", now - 5000, { status: "interrupted", startedAt: now - 5000, events: events(2) });
    expect((await post("/runs/put", { storeKey: key, record: tombstone })).status).toBe(200);
    expect((await post("/runs/get", { storeKey: key, id: "t1" })).data.record).toMatchObject({
      status: "interrupted",
      finishedAt: now - 5000,
    });
    // The finish write: a different stored version (eventCount/finishedAt/bytes) → full rewrite.
    const final = record("t1", now, { status: "completed", startedAt: now - 5000, events: events(6) });
    expect((await post("/runs/put", { storeKey: key, record: final })).data).toMatchObject({
      rewritten: true,
      retained: 1,
    });
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
    await post("/runs/put", {
      storeKey: key,
      record: record("old", now - 20 * DAY),
      policy: policy(30),
      policyUpdatedAt: now - 10_000,
    });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).not.toBeNull();
    // Older proposal with a tighter window: ignored, the run stays visible.
    await post("/runs/put", {
      storeKey: key,
      record: record("x", now),
      policy: policy(5),
      policyUpdatedAt: now - 20_000,
    });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).not.toBeNull();
    // Newer proposal: accepted, the run is now hidden.
    await post("/runs/put", {
      storeKey: key,
      record: record("y", now),
      policy: policy(5),
      policyUpdatedAt: now - 5_000,
    });
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data.record).toBeNull();
    expect(
      (await post("/runs/put", { storeKey: key, record: record("z", now), policy: policy(0), policyUpdatedAt: now }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/runs/put", {
          storeKey: key,
          record: record("z", now),
          policy: { maxRuns: 0 },
          policyUpdatedAt: now,
        })
      ).status,
    ).toBe(400);

    // A proposal dated a year ahead is stored with the DO clock, so a later,
    // correctly dated proposal still wins.
    const key2 = storeKey();
    await post("/runs/put", {
      storeKey: key2,
      record: record("old", now - 20 * DAY),
      policy: policy(30),
      policyUpdatedAt: now + 365 * DAY,
    });
    const stored = await runInDurableObject(stubOf(key2), (inst: RunHistoryDO) => inst.policyState());
    expect(stored.policyUpdatedAt).toBeLessThanOrEqual(Date.now());
    await new Promise((r) => setTimeout(r, 10));
    await post("/runs/put", {
      storeKey: key2,
      record: record("y", now),
      policy: policy(5),
      policyUpdatedAt: Date.now(),
    });
    expect(
      (await runInDurableObject(stubOf(key2), (inst: RunHistoryDO) => inst.policyState())).policy.retentionDays,
    ).toBe(5);
    expect((await post("/runs/get", { storeKey: key2, id: "old" })).data.record).toBeNull();
  });

  it("get/list never accept a policy: a generous body policy cannot resurrect a hidden row", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", {
      storeKey: key,
      record: record("old", now - 20 * DAY),
      policy: { retentionDays: 5, maxRuns: 100, maxBytes: 64 * MIB },
      policyUpdatedAt: now,
    });
    expect(
      (await post("/runs/get", { storeKey: key, id: "old", policy: { retentionDays: 365 }, policyUpdatedAt: now + 1 }))
        .data,
    ).toEqual({ record: null });
    expect(
      (await post("/runs/list", { storeKey: key, policy: { retentionDays: 365 }, policyUpdatedAt: now + 1 })).data,
    ).toEqual({ items: [] });
    // and the persisted policy is unchanged
    expect(
      (await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.policyState())).policy.retentionDays,
    ).toBe(5);
  });

  it("a shrink dropping >25% deletes at most 500 rows per put while list already hides them", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 620; i++)
      await putDirect(key, record(`r${String(i).padStart(4, "0")}`, now - i * 1000, { events: events(1) }));
    expect(await rowCount(key, "runs")).toBe(620);
    const res = await putDirect(key, record("new", now + 1, { events: events(1) }), {
      policy: { retentionDays: 30, maxRuns: 50, maxBytes: 64 * MIB },
      policyUpdatedAt: now,
    });
    expect(res.stored).toBe(true);
    expect(res.retained).toBe(50);
    // 621 - 50 = 571 outside policy; the fence deletes 500 of them this put.
    expect(await rowCount(key, "runs")).toBe(621 - 500);
    expect(await rowCount(key, "run_events")).toBe(621 - 500);
    const list = await post("/runs/list", { storeKey: key, limit: 200 });
    expect(list.data.items as unknown[]).toHaveLength(50);
    expect((list.data.items as Array<{ id: string }>)[0].id).toBe("new");
    // Rows still on disk behind the fence are hidden on every read path.
    expect(
      await runInDurableObject(
        stubOf(key),
        async (_i: RunHistoryDO, state) =>
          state.storage.sql.exec(`SELECT 1 FROM runs WHERE run_id = 'r0100'`).toArray().length,
      ),
    ).toBe(1);
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
        state.storage.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify({ ...policy, policyUpdatedAt: Date.now() }),
        );
      });
    const idsOnDisk = (key: string) =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) =>
        state.storage.sql.exec<{ run_id: string; bytes: number }>(`SELECT run_id, bytes FROM runs`).toArray(),
      );
    const agree = async (key: string, expected: string[]) => {
      const listed = (
        (await post("/runs/list", { storeKey: key, limit: 200 })).data.items as Array<{ id: string }>
      ).map((r) => r.id);
      expect(listed).toEqual(expected);
      for (const { run_id } of await idsOnDisk(key)) {
        const visible = listed.includes(run_id);
        expect((await post("/runs/get", { storeKey: key, id: run_id })).data.record !== null, `get ${run_id}`).toBe(
          visible,
        );
        expect(
          (await post("/runs/events", { storeKey: key, id: run_id })).data.events !== null,
          `events ${run_id}`,
        ).toBe(visible);
      }
    };
    const now = Date.now();

    // maxRuns with a finishedAt tie: t2 ranks ahead of t1 (run_id desc); age drops `old`.
    const k1 = storeKey();
    for (const [id, at] of [
      ["old", now - 20 * DAY],
      ["a", now - 1000],
      ["t1", now - 2500],
      ["t2", now - 2500],
      ["b", now - 2000],
      ["c", now - 3000],
      ["d", now - 4000],
    ] as const) {
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
    for (const [id, at] of [
      ["a", now - 1000],
      ["b", now - 2000],
      ["t1", now - 2500],
      ["t2", now - 2500],
    ] as const)
      await putDirect(k2, record(id, at, { events: big() }));
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
    expect(again).toEqual({ ok: true, retained: 2, stored: true, rewritten: true, turnedFinal: false });
    expect(await rowCount(key, "run_events")).toBe(7);
    const outside = await putDirect(key, record("older", now - 40 * DAY, { events: events(2) }));
    expect(outside).toEqual({ ok: true, retained: 2, stored: false, rewritten: false, turnedFinal: true });
    expect(await rowCount(key, "runs")).toBe(2);
  });

  it("a finishedAt one year ahead is clamped to now + 24 h and stored_at is recorded", async () => {
    const key = storeKey();
    const before = Date.now();
    await post("/runs/put", { storeKey: key, record: record("future", before + 365 * DAY) });
    const row = await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) =>
      state.storage.sql
        .exec<{ finished_at: number; stored_at: number }>(
          `SELECT finished_at, stored_at FROM runs WHERE run_id = 'future'`,
        )
        .one(),
    );
    expect(row.finished_at).toBeLessThanOrEqual(Date.now() + DAY);
    expect(row.finished_at).toBeGreaterThanOrEqual(before + DAY - 1);
    expect(row.stored_at).toBeGreaterThanOrEqual(before);
    const got = (await post("/runs/get", { storeKey: key, id: "future" })).data.record as RunRecord;
    expect(got.finishedAt).toBe(row.finished_at);
  });

  it("receivedAt and sealedAt a year ahead are clamped like finishedAt (docs/reference/specs/tracing.md)", async () => {
    const key = storeKey();
    const before = Date.now();
    const far = before + 365 * DAY;
    await post("/runs/put", { storeKey: key, record: record("stamps", before, { receivedAt: far, sealedAt: far }) });
    const got = (await post("/runs/get", { storeKey: key, id: "stamps" })).data.record as RunRecord;
    expect(got.receivedAt).toBeLessThanOrEqual(Date.now() + DAY);
    expect(got.sealedAt).toBeLessThanOrEqual(Date.now() + DAY);
    expect(got.receivedAt).toBeGreaterThanOrEqual(before + DAY - 1);
  });

  it("the alarm deletes expired rows with no writes, and get is then not-found", async () => {
    const key = storeKey();
    const now = Date.now();
    await post("/runs/put", {
      storeKey: key,
      record: record("old", now - 20 * DAY),
      policy: { retentionDays: 30, maxRuns: 100, maxBytes: 64 * MIB },
      policyUpdatedAt: now,
    });
    await post("/runs/put", { storeKey: key, record: record("fresh", now) });
    // Tighten the policy so `old` is outside it — via the meta table, exactly
    // what a shrink would persist — without a put that would trim it.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.policyState());
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'policy'`,
        JSON.stringify({ retentionDays: 5, maxRuns: 100, maxBytes: 64 * MIB, policyUpdatedAt: now }),
      );
    });
    expect(await rowCount(key, "runs")).toBe(2);
    expect(await runDurableObjectAlarm(stubOf(key))).toBe(true); // an alarm was scheduled by the first put
    expect(await rowCount(key, "runs")).toBe(1);
    expect(await rowCount(key, "run_events")).toBe(3);
    expect((await post("/runs/get", { storeKey: key, id: "old" })).data).toEqual({ record: null });
    expect((await post("/runs/get", { storeKey: key, id: "fresh" })).data.record).not.toBeNull();
    expect(
      await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => state.storage.getAlarm()),
    ).not.toBeNull(); // rescheduled
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
    expect(((await post("/runs/get", { storeKey: key, id: "multi" })).data.record as RunRecord).events[0]).toEqual({
      ...multi.events[0],
      seq: 1,
    }); // no seq given → position
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
    expect((await post("/runs/put", { storeKey: key, record: { id: "a" } })).data).toEqual({
      error: "record must be a RunRecord",
    });
    expect((await post("/runs/get", { storeKey: key, id: "../x" })).status).toBe(400);
    expect((await post("/runs/events", { storeKey: key, id: "a", limit: 0 })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, limit: "5" })).status).toBe(400);
    expect((await post("/runs/nope", { storeKey: key })).status).toBe(404);
    expect((await post("/runs/get", { storeKey: key, id: "a" }, { "content-type": "application/json" })).status).toBe(
      401,
    );
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
    expect(await res.json()).toEqual({
      ok: true,
      build: { commit: "unknown" },
      features: ["memory", "schedules", "runs", "config", "delivery", "costs", "plane"],
    });
  });

  it("recovery evidence filters before the cap and attests only a complete valid set", async () => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    for (let i = 0; i < 205; i++) await putDirect(key, record(`noise-${i}`, now - i, { threadKey: "slack:C1:noise" }));
    const relevant = [
      record("parent", now - 1000, {
        parentInstanceId: "original",
        idempotencyKey: "original:U99/0/coding",
        threadKey: "slack:C1:foreign",
      }),
      record("key", now - 2000, {
        parentInstanceId: "contradiction",
        idempotencyKey: "original:U12/0/coding",
        threadKey: "slack:C1:foreign",
      }),
      record("thread", now - 3000, { threadKey: "slack:C1:original" }),
      record("bare-key", now - 4000, {
        parentInstanceId: "contradiction",
        idempotencyKey: "original:U12",
        threadKey: "slack:C1:foreign",
      }),
    ];
    for (const row of relevant) await putDirect(key, row);
    await putDirect(
      key,
      record("other-unit", now - 4000, {
        parentInstanceId: "other",
        idempotencyKey: "original:U120/0/coding",
        threadKey: "slack:C1:foreign",
      }),
    );
    await putDirect(
      key,
      record("bare-neighbor", now - 5000, {
        parentInstanceId: "other",
        idempotencyKey: "original:U120",
        threadKey: "slack:C1:foreign",
      }),
    );
    const result = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(true);
    expect((result.data.items as RunRecord[]).map((row) => row.id)).toEqual(["parent", "key", "thread", "bare-key"]);
    const full = await post("/runs/list", { storeKey: key, limit: 2, recoveryEvidence });
    expect(full.data.evidenceComplete).toBe(false);
    for (const extra of [{ before: now }, { threadKey: "slack:C1:original" }, { visibleTo: { kind: "all" } }])
      expect((await post("/runs/list", { storeKey: key, recoveryEvidence, ...extra })).status).toBe(400);
    expect(
      (await post("/runs/list", { storeKey: key, recoveryEvidence: { ...recoveryEvidence, threadKeys: [] } })).status,
    ).toBe(400);
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET summary_json = ? WHERE run_id = ?", "{broken", "parent");
    });
    const corrupt = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(corrupt.data.evidenceComplete).toBe(false);
  });

  it.each<{ label: string; corrupt: (row: RunRecord) => unknown }>([
    { label: "null", corrupt: () => null },
    { label: "a boolean", corrupt: () => true },
    { label: "a number", corrupt: () => 42 },
    { label: "a string", corrupt: () => "corrupt" },
    { label: "an array", corrupt: () => [] },
    { label: "an empty object", corrupt: () => ({}) },
    { label: "missing a required field", corrupt: (row) => ({ ...row, id: undefined }) },
    { label: "carrying a malformed optional field", corrupt: (row) => ({ ...row, headSha: "invalid" }) },
  ])("recovery evidence refuses a retained foreign-thread summary that is $label", async ({ corrupt }) => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    await putDirect(key, record("original", now, { threadKey: "slack:C1:original" }));
    const child = record("competing", now - 1000, {
      parentInstanceId: "original",
      idempotencyKey: "original:U12/0/coding",
      threadKey: "slack:C1:foreign",
    });
    await putDirect(key, child);
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      // Leave the SQL thread foreign and erase both JSON identity matches. Even
      // a plausible object must pass the record parser, not just json_valid.
      const summary = corrupt({ ...child, parentInstanceId: "other", idempotencyKey: "other:U12/0/coding" });
      state.storage.sql.exec("UPDATE runs SET summary_json = ? WHERE run_id = ?", JSON.stringify(summary), child.id);
    });
    const result = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(false);
    // Ordinary history still skips corrupt rows instead of failing the page.
    const ordinary = await post("/runs/list", { storeKey: key });
    expect((ordinary.data.items as RunRecord[]).map((row) => row.id)).toEqual(["original"]);
    expect(ordinary.data.evidenceComplete).toBeUndefined();
  });

  it("recovery evidence validates past the evidence cap but only within retention", async () => {
    const key = storeKey();
    const now = Date.now();
    const recoveryEvidence = { instanceId: "original", unit: "U12", threadKeys: ["slack:C1:original"] };
    await putDirect(key, record("original", now, { threadKey: "slack:C1:original" }));
    for (let i = 0; i < 205; i++) await putDirect(key, record(`noise-${i}`, now - i, { threadKey: "slack:C1:noise" }));
    await putDirect(key, record("corrupt", now - 2 * DAY, { threadKey: "slack:C1:foreign" }));
    await runInDurableObject(stubOf(key), async (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET summary_json = 'null', bytes = ? WHERE run_id = 'corrupt'", 32 * MIB);
    });
    const result = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
    expect(result.status).toBe(200);
    expect(result.data.evidenceComplete).toBe(false);
    // Each policy independently excludes the corrupt row without deleting it.
    for (const policy of [
      { retentionDays: 1, maxRuns: 5000, maxBytes: 64 * MIB },
      { retentionDays: 30, maxRuns: 206, maxBytes: 64 * MIB },
      { retentionDays: 30, maxRuns: 5000, maxBytes: 16 * MIB },
    ]) {
      await runInDurableObject(stubOf(key), async (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify({ ...policy, policyUpdatedAt: now }),
        );
      });
      const retained = await post("/runs/list", { storeKey: key, limit: 200, recoveryEvidence });
      expect(retained.status).toBe(200);
      expect(retained.data.evidenceComplete).toBe(true);
      expect((retained.data.items as RunRecord[]).map((row) => row.id)).toEqual(["original"]);
      expect(await rowCount(key, "runs")).toBe(207);
    }
  });

  it("list: newest-first, limit 1000 → at most 200 rows plus a cursor; before/sinceMs/agent/channel/threadKey/parentRunId/pr filters; no events on the wire", async () => {
    const key = storeKey();
    const now = Date.now();
    for (let i = 0; i < 230; i++) {
      await putDirect(
        key,
        record(`r${String(i).padStart(3, "0")}`, now - i * 1000, {
          events: events(1),
          agent: i % 2 ? "review" : "coding",
          channelId: i % 5 ? "slack:C1" : "slack:C2",
          threadKey: i % 7 ? "slack:C1:t1" : "slack:C1:t2",
          ...(i % 11 === 0 ? { parentRunId: "parent-x" } : {}),
          // run-history item 58: every 13th row names pull request 42 — a coding
          // run through its `pr`, a review through its posted target; the rows
          // between carry another number, another repository, or a skipped post.
          repo: i % 13 === 5 ? "acme/web" : "acme/api",
          ...(i % 13 === 0
            ? i % 2
              ? { reviewPost: { posted: true, target: { repo: "acme/api", number: 42 }, head: "a".repeat(40) } }
              : { pr: { number: 42, url: "https://github.com/acme/api/pull/42" } }
            : i % 13 === 5
              ? { pr: { number: 42, url: "https://github.com/acme/web/pull/42" } }
              : i % 13 === 7
                ? { reviewPost: { posted: false, reason: "head moved" } }
                : { pr: { number: 43, url: "https://github.com/acme/api/pull/43" } }),
        }),
      );
    }
    const page = await post("/runs/list", { storeKey: key, limit: 1000 });
    const items = page.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(200);
    expect(items[0].id).toBe("r000");
    expect(items[0].events).toBeUndefined();
    expect(items[0].bytes).toBeGreaterThan(100);
    expect(page.data.nextBefore).toEqual({ finishedAt: items[199].finishedAt, id: items[199].id });
    const cursor = page.data.nextBefore as { finishedAt: number; id: string };
    const rest = await post("/runs/list", {
      storeKey: key,
      limit: 200,
      before: cursor.finishedAt,
      beforeId: cursor.id,
    });
    expect((rest.data.items as unknown[]).length).toBe(30);
    expect(rest.data.nextBefore).toBeUndefined();
    expect((await post("/runs/list", { storeKey: key })).data.items as unknown[]).toHaveLength(50);
    expect((await post("/runs/list", { storeKey: key, sinceMs: now - 2500 })).data.items as unknown[]).toHaveLength(3);
    const coding = (await post("/runs/list", { storeKey: key, agent: "coding", limit: 5 })).data.items as Array<{
      agent: string;
    }>;
    expect(coding).toHaveLength(5);
    expect(coding.every((r) => r.agent === "coding")).toBe(true);
    const c2 = (await post("/runs/list", { storeKey: key, channel: "slack:C2", limit: 5 })).data.items as Array<{
      channelId: string;
    }>;
    expect(c2.every((r) => r.channelId === "slack:C2")).toBe(true);
    // agent-conductor item 10: one thread's runs, newest first — the newest is `limit: 1`.
    const thread = (await post("/runs/list", { storeKey: key, threadKey: "slack:C1:t2", limit: 5 })).data
      .items as Array<{ id: string; threadKey: string }>;
    expect(thread).toHaveLength(5);
    expect(thread.every((r) => r.threadKey === "slack:C1:t2")).toBe(true);
    expect(thread[0].id).toBe("r000");
    const newest = (await post("/runs/list", { storeKey: key, threadKey: "slack:C1:t2", limit: 1 })).data
      .items as Array<{ id: string }>;
    expect(newest.map((r) => r.id)).toEqual(["r000"]);
    expect((await post("/runs/list", { storeKey: key, threadKey: "slack:C1:none" })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key, threadKey: 7 })).status).toBe(400);
    // run-history item 57: the runs one run spawned, newest first — a conductor's children as one listing.
    const children = (await post("/runs/list", { storeKey: key, parentRunId: "parent-x" })).data.items as Array<{
      id: string;
      parentRunId?: string;
    }>;
    expect(children).toHaveLength(21);
    expect(children.every((r) => r.parentRunId === "parent-x")).toBe(true);
    expect(children[0].id).toBe("r000");
    expect((await post("/runs/list", { storeKey: key, parentRunId: "parent-none" })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key, parentRunId: "not a run id!" })).status).toBe(400);
    // run-history item 58: the runs that name one pull request on one repository, newest first.
    const named = (await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number: 42 } })).data
      .items as Array<{ id: string; pr?: { number: number }; reviewPost?: { posted: boolean } }>;
    expect(named.map((r) => r.id)).toEqual(Array.from({ length: 18 }, (_, k) => `r${String(k * 13).padStart(3, "0")}`));
    expect(named.every((r) => r.pr?.number === 42 || r.reviewPost?.posted === true)).toBe(true);
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "acme/web", number: 42 } })).data.items).toHaveLength(
      18,
    );
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number: 99 } })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number: 0 } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, pr: { repo: "not a slug", number: 42 } })).status).toBe(400);
    expect((await post("/runs/list", { storeKey: key, pr: "acme/api#42" })).status).toBe(400);
  }, 60_000);

  it("a table created before the parent column gains it, filled from each record's own `parentRunId`, so a child stored earlier still lists under its parent; a later put writes the column beside the row", async () => {
    const key = storeKey();
    const now = Date.now();
    // Recreate the pre-column schema by hand: drop the index, then the column.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_parent`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN parent_run_id`);
      const columns = state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name);
      expect(columns).not.toContain("parent_run_id");
    });
    // Two rows written straight into the old shape: a child whose summary names its parent, and an orphan.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      for (const rec of [
        record("legacy-child", now - 1000, { parentRunId: "parent-1" }),
        record("legacy-orphan", now - 2000),
      ]) {
        const { events: _e, ...summary } = rec;
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          summary.id,
          summary.label ?? null,
          summary.agent ?? null,
          summary.model ?? null,
          summary.channelId,
          summary.userId,
          summary.threadKey,
          summary.channelVisibility,
          null,
          summary.startedAt,
          summary.finishedAt,
          now,
          summary.status,
          0,
          0,
          0,
          100,
          JSON.stringify(summary.diagnosis),
          JSON.stringify(summary),
        );
      }
    });
    // The migration the DO applies at every construction.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    const columnOf = () =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) =>
        state.storage.sql
          .exec<{ run_id: string; parent: string | null }>(
            `SELECT run_id, parent_run_id AS parent FROM runs ORDER BY run_id`,
          )
          .toArray(),
      );
    expect(await columnOf()).toEqual([
      { run_id: "legacy-child", parent: "parent-1" },
      { run_id: "legacy-orphan", parent: null },
    ]);
    const idsUnder = async (parent: string) =>
      ((await post("/runs/list", { storeKey: key, parentRunId: parent })).data.items as Array<{ id: string }>).map(
        (r) => r.id,
      );
    expect(await idsUnder("parent-1")).toEqual(["legacy-child"]);
    // Idempotent: a second construction changes nothing.
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    expect(await columnOf()).toHaveLength(2);
    // A put after the migration writes the column beside the row.
    const fresh = record("new-child", now - 500, { parentRunId: "parent-1", events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: fresh })).status).toBe(200);
    expect(await idsUnder("parent-1")).toEqual(["new-child", "legacy-child"]);
  });

  // run-history item 58: the pull request a run names is a column, so a
  // findings listing is one indexed page — filled once from `summary_json` for
  // rows written before the column, by the rule `pullRequestNumberOf` states.
  it("a table created before the pull request column gains it, filled from each record's own `pr` or posted review target — a skipped post and a run naming none stay null — so a run stored earlier still lists under its pull request; a later put writes the column beside the row", async () => {
    const key = storeKey();
    const now = Date.now();
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_pr`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN pr_number`);
      const columns = state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name);
      expect(columns).not.toContain("pr_number");
    });
    const posted = { posted: true as const, target: { repo: "acme/api", number: 42 }, head: "b".repeat(40) };
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      for (const rec of [
        record("legacy-coding", now - 1000, {
          repo: "acme/api",
          pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
        }),
        record("legacy-review", now - 2000, { repo: "acme/api", reviewPost: posted }),
        record("legacy-skipped", now - 3000, { repo: "acme/api", reviewPost: { posted: false, reason: "head moved" } }),
        record("legacy-none", now - 4000, { repo: "acme/api" }),
      ]) {
        const { events: _e, ...summary } = rec;
        state.storage.sql.exec(
          `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          summary.id,
          summary.label ?? null,
          summary.agent ?? null,
          summary.model ?? null,
          summary.channelId,
          summary.userId,
          summary.threadKey,
          summary.channelVisibility,
          summary.repo ?? null,
          summary.startedAt,
          summary.finishedAt,
          now,
          summary.status,
          0,
          0,
          0,
          100,
          JSON.stringify(summary.diagnosis),
          JSON.stringify(summary),
        );
      }
    });
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    const columnOf = () =>
      runInDurableObject(stubOf(key), async (_i: RunHistoryDO, state) =>
        state.storage.sql
          .exec<{ run_id: string; pr: number | null }>(`SELECT run_id, pr_number AS pr FROM runs ORDER BY run_id`)
          .toArray(),
      );
    expect(await columnOf()).toEqual([
      { run_id: "legacy-coding", pr: 42 },
      { run_id: "legacy-none", pr: null },
      { run_id: "legacy-review", pr: 42 },
      { run_id: "legacy-skipped", pr: null },
    ]);
    const idsNaming = async (number: number) =>
      (
        (await post("/runs/list", { storeKey: key, pr: { repo: "acme/api", number } })).data.items as Array<{
          id: string;
        }>
      ).map((r) => r.id);
    expect(await idsNaming(42)).toEqual(["legacy-coding", "legacy-review"]);
    await runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.migrateRunsTable());
    expect(await columnOf()).toHaveLength(4);
    const fresh = record("new-review", now - 500, { repo: "acme/api", reviewPost: posted, events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: fresh })).status).toBe(200);
    expect(await idsNaming(42)).toEqual(["new-review", "legacy-coding", "legacy-review"]);
  });

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
      await putDirect(
        key,
        record(`f${String(i).padStart(2, "0")}`, now - i * 1000, {
          events: events(1),
          agent: i % 2 ? "review" : "coding",
          channelId: i % 3 ? "slack:C1" : "slack:C2",
        }),
      );
    }
    const expectIds = async (q: Record<string, unknown>, ids: string[]) => {
      expect(
        ((await post("/runs/list", { storeKey: key, ...q })).data.items as Array<{ id: string }>).map((r) => r.id),
      ).toEqual(ids);
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
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        JSON.stringify({
          retentionDays: 30,
          maxRuns: 7,
          maxBytes: 8 * 1024 * 1024 * 1024,
          policyUpdatedAt: Date.now(),
        }),
      );
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
    await putDirect(
      key,
      record("pub", now - 1000, {
        events: events(1),
        channelId: "slack:C_PUB",
        userId: "slack:UALICE",
        channelVisibility: "public",
      }),
    );
    await putDirect(
      key,
      record("priv", now - 2000, {
        events: events(1),
        channelId: "slack:G1",
        userId: "slack:UBOB",
        channelVisibility: "private",
      }),
    );
    await putDirect(
      key,
      record("ops", now - 3000, {
        events: events(1),
        channelId: "http:ops",
        userId: "http:ci",
        channelVisibility: "machine",
      }),
    );
    await putDirect(
      key,
      record("dev", now - 4000, {
        events: events(1),
        channelId: "mcp:dev",
        userId: "mcp:ci",
        channelVisibility: "machine",
      }),
    );
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
    expect(await ids({ kind: "user-is", userId: "slack:UBOB" })).toEqual(["priv"]);
    // member-of as the compiler emits it for a token granted http:ops, plus its own runs.
    expect(
      await ids({
        kind: "or",
        of: [
          { kind: "channels-in", channelIds: ["http:ops"] },
          { kind: "visibility-in", visibilities: ["public"] },
          { kind: "user-is", userId: "http:ci" },
        ],
      }),
    ).toEqual(["pub", "ops"]);
    expect(
      await ids({
        kind: "and",
        of: [
          { kind: "channels-in", channelIds: ["slack:G1"] },
          { kind: "user-is", userId: "slack:UBOB" },
        ],
      }),
    ).toEqual(["priv"]);
    expect(
      await ids({
        kind: "and",
        of: [
          { kind: "channels-in", channelIds: ["slack:G1"] },
          { kind: "user-is", userId: "slack:UALICE" },
        ],
      }),
    ).toEqual([]);
    // ANDed with the plain filters and the cursor.
    expect(
      await ids({ kind: "channels-in", channelIds: ["http:ops", "mcp:dev", "slack:C_PUB"] }, { channel: "mcp:dev" }),
    ).toEqual(["dev"]);
    expect(
      await ids(
        { kind: "channels-in", channelIds: ["http:ops", "mcp:dev", "slack:C_PUB"] },
        { before: now - 1000, beforeId: "pub" },
      ),
    ).toEqual(["ops", "dev"]);
    // The plan: ONE indexed page query carrying the IN, no retention scan.
    const plan = await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      const seen = spySql(inst);
      const res = await inst.list({
        limit: 5,
        visibleTo: {
          kind: "or",
          of: [
            { kind: "channels-in", channelIds: ["http:ops"] },
            { kind: "visibility-in", visibilities: ["public"] },
          ],
        },
      });
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
    expect(
      (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["everyone"] } }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/runs/list", {
          storeKey: key,
          visibleTo: { kind: "channels-in", channelIds: Array.from({ length: 95 }, (_, i) => `c${i}`) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/list", {
          storeKey: key,
          visibleTo: { kind: "channels-in", channelIds: Array.from({ length: 90 }, (_, i) => `c${i}`) },
        })
      ).status,
    ).toBe(200);
  });

  it("a table created before the visibility stamp gains the column with `unknown` for every existing row (the one migration), and a record put without the stamp reads back as `unknown` — never public", async () => {
    const key = storeKey();
    const now = Date.now();
    // Recreate the pre-stamp schema by hand: drop the column, then reconstruct the DO to run the migration.
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      state.storage.sql.exec(`DROP INDEX IF EXISTS runs_visibility_finished`);
      state.storage.sql.exec(`ALTER TABLE runs DROP COLUMN channel_visibility`);
      const columns = state.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name);
      expect(columns).not.toContain("channel_visibility");
    });
    // A row written straight into the old shape (as a pre-migration DO would have left it).
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const { events: _e, channelVisibility: _v, ...summary } = record("legacy", now - 1000);
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, repo, started_at, finished_at, stored_at, status, event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        summary.id,
        summary.label ?? null,
        summary.agent ?? null,
        summary.model ?? null,
        summary.channelId,
        summary.userId,
        summary.threadKey,
        null,
        summary.startedAt,
        summary.finishedAt,
        now,
        summary.status,
        0,
        0,
        0,
        100,
        JSON.stringify(summary.diagnosis),
        JSON.stringify(summary),
      );
      // Simulate the next constructor run: the migration the DO applies on load.
      const cols = new Set(
        state.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(runs)`)
          .toArray()
          .map((c) => c.name),
      );
      if (!cols.has("channel_visibility"))
        state.storage.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    });
    const listed = (await post("/runs/list", { storeKey: key })).data.items as Array<{
      id: string;
      channelVisibility?: string;
    }>;
    expect(listed.map((r) => r.id)).toEqual(["legacy"]);
    expect(
      await runInDurableObject(
        stubOf(key),
        async (_i: RunHistoryDO, state) =>
          state.storage.sql
            .exec<{ v: string }>(`SELECT channel_visibility AS v FROM runs WHERE run_id = 'legacy'`)
            .one().v,
      ),
    ).toBe("unknown");
    expect(
      (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["public"] } })).data
        .items,
    ).toEqual([]);
    expect(
      (
        (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["unknown"] } }))
          .data.items as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(["legacy"]);
    // A put without the stamp (an older bot) stores `unknown` too.
    const { channelVisibility: _cv, ...unstamped } = record("unstamped", now - 500, { events: events(1) });
    expect((await post("/runs/put", { storeKey: key, record: unstamped })).status).toBe(200);
    expect(
      await runInDurableObject(
        stubOf(key),
        async (_i: RunHistoryDO, state) =>
          state.storage.sql
            .exec<{ v: string }>(`SELECT channel_visibility AS v FROM runs WHERE run_id = 'unstamped'`)
            .one().v,
      ),
    ).toBe("unknown");
    // And a stamped put is stored as stamped and filterable.
    await post("/runs/put", {
      storeKey: key,
      record: record("stamped", now - 200, { events: events(1), channelVisibility: "public" }),
    });
    expect(
      (
        (await post("/runs/list", { storeKey: key, visibleTo: { kind: "visibility-in", visibilities: ["public"] } }))
          .data.items as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(["stamped"]);
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

// docs/reference/specs/orchestration-plane.md — the decider inside the object
// (record 0064; orchestration-plane items 6–8): the tables exist, `transactionSync` commits state and
// effects together, the shadow outcome post is logged beside the decider's
// decision, every heartbeat and reclaim answer carries `effects`, and an ack
// of an unknown id is a no-op.
describe("orchestration plane — the tables, the decider, shadow and the effects", () => {
  const claimBody = (key: string, runId: string, threadKey: string, gen = "g1") => ({
    storeKey: key,
    run: {
      runId,
      threadKey,
      gen,
      leaseMs: LEASE_MS,
      startedAt: 1_000,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
      card: null,
      system: "you review",
      tools: [],
    },
  });

  const ask = (runId: string, threadKey: string) =>
    ({
      kind: "ask",
      at: 1_000,
      runId,
      requester: "slack:UBOB",
      threadKey,
      stage: "admission",
      request: { text: "next" },
    }) as const;

  it("a fresh object holds the plane's seven tables", async () => {
    const key = storeKey();
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const names = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plane_%' ORDER BY name`,
        )
        .toArray()
        .map((r) => r.name);
      expect(names).toEqual([
        "plane_effects",
        "plane_endings",
        "plane_findings",
        "plane_levels",
        "plane_queue",
        "plane_reservations",
        "plane_windows",
      ]);
    });
  });

  it("planeApply commits the queue row, then the seal's admitted state and its effect, together in transactionSync", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      // The claim's live row makes the thread live: the ask queues, no effect.
      const queued = inst.planeApply(ask("q1", "slack:C1:1.0"));
      expect(queued.effects).toEqual([]);
      const rows = () =>
        state.storage.sql.exec<{ run_id: string; state: string }>(`SELECT run_id, state FROM plane_queue`).toArray();
      expect(rows()).toEqual([{ run_id: "q1", state: "waiting" }]);
      // The seal admits the oldest waiting row; its state flip and the offered
      // effect land in the same transaction, so both are visible together.
      const sealed = inst.planeApply({ kind: "sealed", at: 2_000, threadKey: "slack:C1:1.0" });
      expect(sealed.effects).toEqual([
        { id: "admit:q1", kind: "admit", runId: "q1", threadKey: "slack:C1:1.0", request: { text: "next" } },
      ]);
      expect(rows()).toEqual([{ run_id: "q1", state: "admitted" }]);
      const offered = state.storage.sql
        .exec<{ id: string; acked_at: number | null }>(`SELECT id, acked_at FROM plane_effects`)
        .toArray();
      expect(offered).toEqual([{ id: "admit:q1", acked_at: null }]);
    });
  });

  it("two child_sealed findings on one subject merge into ONE plane_findings row, the first filed_at kept", async () => {
    const key = storeKey();
    // A seal with a pushed branch, no pull request, no live runner and no known
    // repository degrades to a finding (orphaned_child) instead of guessing.
    const sealed = (at: number) =>
      ({ kind: "child_sealed", at, runId: "r1", runnerLive: false, branch: "fix/x" }) as const;
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO, state) => {
      expect(inst.planeApply(sealed(1_000)).effects).toEqual([]);
      const rows = () =>
        state.storage.sql
          .exec<{ id: string; watch: string; subject: string; timeline_json: string; filed_at: number }>(
            `SELECT id, watch, subject, timeline_json, filed_at FROM plane_findings`,
          )
          .toArray();
      const first = rows();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        id: "orphaned_child#r1",
        watch: "orphaned_child",
        subject: "r1",
        filed_at: 1_000,
      });
      // The second observation is absorbed: still one row, timeline of two,
      // the first-seen stamp kept — the DO-side merge, not a second row.
      expect(inst.planeApply(sealed(2_000)).effects).toEqual([]);
      const merged = rows();
      expect(merged).toHaveLength(1);
      expect(merged[0]!.filed_at).toBe(1_000);
      expect((JSON.parse(merged[0]!.timeline_json) as { at: number }[]).map((e) => e.at)).toEqual([1_000, 2_000]);
    });
  });

  it("shadow logs refused:thread-live beside queued for a second ask on a live thread, and persists nothing", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const r = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "refused:thread-live",
    });
    expect(r).toEqual({ status: 200, data: { ok: true, decider: "queued", agreed: true } });
    // Nothing runs — and nothing queues — from the decider under shadow (orchestration-plane item 8).
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      expect(state.storage.sql.exec(`SELECT run_id FROM plane_queue`).toArray()).toEqual([]);
    });
  });

  it("an agreeing proceeded post counts nothing; a proceeded post on a live thread bumps the per-condition disagreement count", async () => {
    const key = storeKey();
    const agreed = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C9:9.0",
      stage: "admission",
      outcome: "proceeded",
    });
    expect(agreed.data).toEqual({ ok: true, decider: "proceed", agreed: true });
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const disagreed = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "proceeded",
    });
    expect(disagreed.data).toEqual({ ok: true, decider: "queued", agreed: false });
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_disagreements'`)
        .toArray()[0]!;
      expect(JSON.parse(row.value)).toEqual({ thread_free: 1 });
    });
  });

  it("a proceeded post naming its own run id is judged with that live row excluded — no false disagreement", async () => {
    // The post is fired without an await, so it can arrive after the dispatch
    // it describes claimed the thread; the run's own claim must not read as
    // "thread live" when the post carries the run's id.
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const late = await post("/plane/outcome", {
      storeKey: key,
      runId: "r1",
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "proceeded",
    });
    expect(late.data).toEqual({ ok: true, decider: "proceed", agreed: true });
    await runInDurableObject(stubOf(key), async (_inst: RunHistoryDO, state) => {
      const row = state.storage.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_disagreements'`)
        .toArray();
      expect(row).toEqual([]);
    });
  });

  it("a heartbeat answer and a reclaim answer carry effects: [], present even with nothing offered", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect(beat.status).toBe(200);
    expect(beat.data.effects).toEqual([]);
    const swept = await post("/runs/reclaim", {
      storeKey: key,
      gen: "g2",
      leaseMs: LEASE_MS,
      now: Date.now() + 2 * LEASE_MS,
    });
    expect(swept.status).toBe(200);
    expect(swept.data.effects).toEqual([]);
  });

  it("an offered effect rides the heartbeat answer; deferred leaves it offered, done closes it, an unknown id is a no-op", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      inst.planeApply(ask("q1", "slack:C1:1.0"));
      inst.planeApply({ kind: "sealed", at: 2_000, threadKey: "slack:C1:1.0" });
    });
    const beat = () => post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect((await beat()).data.effects).toMatchObject([{ id: "admit:q1", kind: "admit" }]);
    // deferred: still offered on the next answer.
    expect((await post("/plane/ack", { storeKey: key, id: "admit:q1", outcome: "deferred" })).data).toEqual({
      ok: true,
    });
    expect((await beat()).data.effects).toMatchObject([{ id: "admit:q1" }]);
    // an unknown id is a no-op, never an error.
    expect((await post("/plane/ack", { storeKey: key, id: "admit:zz", outcome: "done" })).data).toEqual({ ok: true });
    expect((await beat()).data.effects).toMatchObject([{ id: "admit:q1" }]);
    // done closes it.
    expect((await post("/plane/ack", { storeKey: key, id: "admit:q1", outcome: "done" })).data).toEqual({ ok: true });
    expect((await beat()).data.effects).toEqual([]);
  });

  it("a bad stage, outcome word or ack word is 400 before any object call", async () => {
    const key = storeKey();
    const bad = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "kitchen",
      outcome: "proceeded",
    });
    expect(bad).toEqual({ status: 400, data: { error: "stage must be admission, runner or resident" } });
    const word = await post("/plane/outcome", {
      storeKey: key,
      requester: "slack:UBOB",
      threadKey: "slack:C1:1.0",
      stage: "admission",
      outcome: "shrugged",
    });
    expect(word).toEqual({
      status: 400,
      data: { error: "outcome must be proceeded, refused:<code> or fell_cold:<token>" },
    });
    const ackWord = await post("/plane/ack", { storeKey: key, id: "admit:q1", outcome: "maybe" });
    expect(ackWord).toEqual({ status: 400, data: { error: "outcome must be done, skipped or deferred" } });
  });
});

// docs/reference/specs/run-metrics.md items 2–5: the state Worker writes one
// metrics point per run, after the commit, only when the row turned final —
// and behaves byte-identically without the binding, with no point, and when
// the sink throws. The pool's env has no RUN_METRICS binding, so the default
// sink is the NullSink; the recording and throwing sinks are installed on the
// live object, the coordinatorDouble pattern.
describe("run metrics — the point, the guard and the emission rule", () => {
  const claimBody = (key: string, runId: string, threadKey: string, gen = "g1") => ({
    storeKey: key,
    run: {
      runId,
      threadKey,
      gen,
      leaseMs: LEASE_MS,
      startedAt: 1_000,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
      card: null,
      system: "you review",
      tools: [],
    },
  });

  /** A RunMetricsSink double on the live object: records, or throws. */
  async function metricsDouble(key: string, behaviour: "record" | "throw" = "record"): Promise<RunMetricsPoint[]> {
    const written: RunMetricsPoint[] = [];
    await runInDurableObject(stubOf(key), async (inst: RunHistoryDO) => {
      Object.defineProperty(inst, "metrics", {
        value: {
          write(p: RunMetricsPoint) {
            if (behaviour === "throw") throw new TypeError("dataset refused");
            written.push(p);
          },
        },
      });
    });
    return written;
  }

  const putDirectWithPoint = (key: string, rec: RunRecord, point?: RunMetricsPoint) =>
    runInDurableObject(stubOf(key), (inst: RunHistoryDO) => inst.put(rec, undefined, point));

  it("a tombstone then the finish writes one point; a review-artifact rewrite and an identical retry write none more", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    // The start tombstone: provisional, no point beside it (pointOf answers undefined).
    const started = Date.now() - 60_000;
    const tombstone = record("r1", started, {
      status: "interrupted",
      provisional: true,
      startedAt: started,
      events: events(1),
      eventCount: 1,
      storedEventCount: 1,
    });
    expect(pointOf(tombstone)).toBeUndefined();
    await post("/runs/put", { storeKey: key, record: tombstone });
    expect(written).toHaveLength(0);
    // The finish replaces the tombstone: the row turns final, one point.
    const final = record("r1", Date.now() - 1_000);
    const point = pointOf(final)!;
    const fin = await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: final, point });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect(written).toHaveLength(1);
    expect(blobOf(written[0], "run id")).toBe("r1");
    expect(written[0].indexes).toEqual(["review"]);
    // The review artifact's whole-record rewrite (run-history item 44): rewritten, not turned final.
    const grown = { ...final, events: events(5), eventCount: 5, storedEventCount: 5 };
    expect(await putDirectWithPoint(key, grown, pointOf(grown))).toMatchObject({
      stored: true,
      rewritten: true,
      turnedFinal: false,
    });
    // The retry's landing: the same record again, still no second point.
    expect(await putDirectWithPoint(key, grown, pointOf(grown))).toMatchObject({
      stored: true,
      rewritten: false,
      turnedFinal: false,
    });
    expect(written).toHaveLength(1);
  });

  it("a plain put of an interrupted record over no row writes one point; one outside retention (stored: false) writes none", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    const interrupted = record("lost", Date.now() - 1_000, { status: "interrupted" });
    expect(await putDirectWithPoint(key, interrupted, pointOf(interrupted))).toMatchObject({
      stored: true,
      turnedFinal: true,
    });
    expect(written).toHaveLength(1);
    // A record outside the 30-day window is written and trimmed in its own put: no point.
    const expired = record("expired", Date.now() - 40 * DAY);
    expect(await putDirectWithPoint(key, expired, pointOf(expired))).toMatchObject({
      stored: false,
      turnedFinal: true,
    });
    expect(written).toHaveLength(1);
  });

  it("a provisional put over a final row writes nothing: the row, its events and the sessions table stay, and no point lands", async () => {
    const key = storeKey();
    const written = await metricsDouble(key);
    const final = record("r1", Date.now() - 1_000, {
      session: { key: "slack:C1:1:review", seedFrom: 0, request: 0, range: { from: 1, to: 3 } },
    });
    expect(await putDirectWithPoint(key, final, pointOf(final))).toMatchObject({ stored: true, turnedFinal: true });
    expect(written).toHaveLength(1);
    const before = (await post("/runs/get", { storeKey: key, id: "r1" })).data.record;
    const sessionsBefore = await rowCount(key, "sessions");
    // A late provisional write (a drain upgrade racing the finish) is answered
    // stored and writes nothing (run-history item 27's store-side guard).
    const late = record("r1", final.startedAt, {
      status: "interrupted",
      provisional: true,
      startedAt: final.startedAt,
      events: events(6),
      eventCount: 6,
      storedEventCount: 6,
      session: { key: "slack:C1:9:review", seedFrom: 0, request: 0, range: "broken" },
    });
    expect(await putDirectWithPoint(key, late, pointOf(late))).toEqual({
      ok: true,
      retained: 1,
      stored: true,
      rewritten: false,
      turnedFinal: false,
    });
    expect((await post("/runs/get", { storeKey: key, id: "r1" })).data.record).toEqual(before);
    expect(await rowCount(key, "run_events")).toBe(final.events.length);
    expect(await rowCount(key, "sessions")).toBe(sessionsBefore);
    expect(written).toHaveLength(1);
  });

  it("a throwing sink leaves the JSON answers deep-equal to a recording run's and to a bindingless Worker's, and warns once with the run id", async () => {
    const recording = storeKey();
    const throwing = storeKey();
    const bare = storeKey(); // no double installed: the pool has no binding, so this is the NullSink
    const written = await metricsDouble(recording);
    await metricsDouble(throwing, "throw");
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
    try {
      const rec = record("r1", Date.now() - 1_000);
      const answers = await Promise.all(
        [recording, throwing, bare].map((key) =>
          post("/runs/put", { storeKey: key, record: rec, point: pointOf(rec) }),
        ),
      );
      expect(answers[0]).toEqual(answers[1]);
      expect(answers[0]).toEqual(answers[2]);
      // The wire answer is exactly today's put shape — turnedFinal stays internal.
      expect(answers[0].data).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
    } finally {
      console.warn = realWarn;
    }
    expect(written).toHaveLength(1);
    const metricWarns = warns.filter((w) => w.includes("[runs/metrics]"));
    expect(metricWarns).toHaveLength(1);
    expect(metricWarns[0]).toContain("r1");
    expect(metricWarns[0]).toContain("TypeError");
  });

  it("a malformed point is refused by name on put and finish, before any write", async () => {
    const key = storeKey();
    const bad = await post("/runs/put", {
      storeKey: key,
      record: record("r1", Date.now() - 1_000),
      point: { junk: 1 },
    });
    expect(bad).toEqual({ status: 400, data: { error: "point must be a RunMetricsPoint" } });
    expect((await post("/runs/get", { storeKey: key, id: "r1" })).data).toEqual({ record: null });
    await post("/runs/claim", claimBody(key, "r2", "slack:C1:2.0"));
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r2",
      gen: "g1",
      record: record("r2", Date.now() - 1_000),
      point: { junk: 1 },
    });
    expect(fin).toEqual({ status: 400, data: { error: "point must be a RunMetricsPoint" } });
  });

  it("features names the dataset only when the binding is present", () => {
    expect(featuresOf({})).toEqual(["memory", "schedules", "runs", "config", "delivery", "costs", "plane"]);
    expect(
      featuresOf({ RUN_METRICS: { writeDataPoint() {} } as AnalyticsEngineDataset, RUN_METRICS_DATASET: "swb_runs" }),
    ).toEqual(["memory", "schedules", "runs", "config", "delivery", "costs", "plane", "runMetrics:swb_runs"]);
  });
});
