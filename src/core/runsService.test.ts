// Feature: docs/reference/specs/run-history.md — `RunsService`: the one async
// service behind every `runs.*` read and stop. It merges the live registry with
// the durable store into token-free projections, pages events with a bounded
// page, authorizes the live SSE path synchronously, and records who asked a run
// to stop. Registry ids/tokens/clock and the store clock are injected, so every
// assertion here is deterministic.
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "./runEvents.js";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import { RunRegistry, type RunRegistryOptions } from "./runRegistry.js";
import { InMemoryRunStore, type RunStore } from "./runStore.js";
import { createRunsService, type RunActor, type RunsService } from "./runsService.js";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/** Every run is visible: these tests exercise the merge, not the policy (see `visibleTo` below). */
const ALL = { kind: "all" } as const;
const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
const result = (summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok: true, summary });

function testRegistry(over: Partial<RunRegistryOptions> = {}) {
  let n = 0;
  let clock = NOW;
  const reg = new RunRegistry({
    genId: () => `id-${++n}`,
    genToken: () => `tok-${n}`,
    now: () => clock,
    ...over,
  });
  return { reg, tick: (ms: number) => (clock += ms) };
}

function record(id: string, finishedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  const events: RunEvent[] = over.events ?? [
    { type: "input", text: "do the thing", seq: 1 },
    { ...call("$ ls"), seq: 2 },
    { ...result("a b c"), seq: 3 },
    { type: "answer", text: "done", seq: 4 },
  ];
  return {
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: `slack:C1:${id}`,
    channelVisibility: "unknown",
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    eventCount: events.length,
    storedEventCount: events.length,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
    ...over,
  };
}

const actor: RunActor = { kind: "cli", id: "cli:local" };

function setup(storeOver?: RunStore | null) {
  const { reg, tick } = testRegistry();
  const store = storeOver === undefined ? new InMemoryRunStore({ now: () => NOW }) : storeOver;
  const svc = createRunsService({ registry: reg, store });
  return { reg, tick, store, svc };
}

/** Assert no serialization of a service result carries a registry token. */
function expectNoToken(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/tok-/);
}

describe("RunsService.getRun", () => {
  it("returns a live run as finished:false with no token and no events unless asked", async () => {
    const { reg, svc } = setup();
    const { id } = reg.create("coding · acme/x");
    reg.publish(id, { type: "input", text: "hi" });
    reg.publish(id, call("$ ls"));

    const res = await svc.getRun(id);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ id, label: "coding · acme/x", finished: false, eventCount: 2, startedAt: NOW });
    expect(res.value).not.toHaveProperty("token");
    expect(res.value).not.toHaveProperty("events");
    expectNoToken(res);

    const withMessages = await svc.getRun(id, { include: "messages" });
    expect(withMessages.ok && withMessages.value.events?.map((e) => e.seq)).toEqual([1, 2]);
    expectNoToken(withMessages);
  });

  it("returns a persisted run in the same shape (finished:true, persisted:true), events only on include", async () => {
    const { svc, store } = setup();
    await store!.put(record("r1", NOW - DAY));

    const res = await svc.getRun("r1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({
      id: "r1",
      finished: true,
      persisted: true,
      status: "completed",
      eventCount: 4,
      agent: "coding",
    });
    expect(res.value).not.toHaveProperty("token");
    expect(res.value).not.toHaveProperty("events");

    const withMessages = await svc.getRun("r1", { include: "messages" });
    expect(withMessages.ok && withMessages.value.events?.length).toBe(4);
  });

  it("is not_found for an unknown id, a malformed id, and an expired record", async () => {
    const { svc, store } = setup();
    await store!.put(record("old", NOW - 31 * DAY)); // outside the 30-day default retention
    expect(await svc.getRun("nope")).toEqual({ ok: false, error: "not_found" });
    expect(await svc.getRun("../etc")).toEqual({ ok: false, error: "not_found" });
    expect(await svc.getRun("old")).toEqual({ ok: false, error: "not_found" });
  });

  it("works with history off (store null): live runs read, persisted ones not_found", async () => {
    const { reg, svc } = setup(null);
    const { id } = reg.create();
    expect((await svc.getRun(id)).ok).toBe(true);
    expect(await svc.getRun("r1")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("RunsService.listRuns — read merge", () => {
  it("lists a run in both the registry and the store once, live stop state winning, same eventCount before and after eviction", async () => {
    const { reg, tick, svc, store } = setup();
    const { id, token } = reg.create("coding · acme/x");
    for (let i = 0; i < 3; i++) reg.publish(id, call(`$ step ${i}`));
    reg.requestStop(id, token, "soft");
    reg.finish(id);
    reg.seal(id); // the TTL runs from the seal
    await store!.put(record(id, NOW, { eventCount: 4, storedEventCount: 4, status: "stopped_soft" }));
    reg.markPersisted(id);

    const before = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(before.runs.map((r) => r.id)).toEqual([id]);
    expect(before.runs[0]).toMatchObject({
      finished: true,
      eventCount: 4,
      stop: { mode: "soft", state: "stopped" },
      persisted: true,
    });
    expect(before.storeUnavailable).toBeUndefined();
    expectNoToken(before);

    tick(61_000); // past the 60 s TTL: the registry evicts, the store still has it
    expect(reg.size()).toBe(0);
    const after = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(after.runs.map((r) => r.id)).toEqual([id]);
    expect(after.runs[0]).toMatchObject({ finished: true, eventCount: 4, status: "stopped_soft", persisted: true });
    expect(after.runs[0].stop).toBeUndefined(); // stop state lived only on the registry row
  });

  it("a live run's provisional interrupted tombstone never surfaces: the run lists as live under `all`, is absent from `finished`, and getRun serves the live row", async () => {
    const { reg, svc, store } = setup();
    const { id } = reg.create("coding · acme/x", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:x",
    });
    reg.publish(id, { type: "input", text: "go" });
    // The start-of-run tombstone: terminal in the store while the run is live.
    await store!.put(
      record(id, NOW, {
        status: "interrupted",
        startedAt: NOW,
        events: [{ type: "input", text: "go", seq: 1 }],
        eventCount: 1,
        storedEventCount: 1,
      }),
    );

    const all = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(all.runs.map((r) => r.id)).toEqual([id]);
    expect(all.runs[0].finished).toBe(false); // never "interrupted" while demonstrably alive
    expect(all.runs[0].status).toBeUndefined();
    expect(all.runs[0].finishedAt).toBeUndefined();
    expect(all.runs[0].diagnosis).toBeUndefined();
    expect(all.runs[0].persisted).toBeUndefined(); // the tombstone is not "finished and persisted"

    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished" });
    expect(finished.runs).toEqual([]); // the tombstone must not list a live run as finished

    const got = await svc.getRun(id);
    expect(got.ok && got.value.finished).toBe(false);
    expect(got.ok && got.value.status).toBeUndefined();
  });

  it("a crash leaves the tombstone as the record: with the registry empty, the interrupted row lists under `finished` and reads as interrupted", async () => {
    const { svc, store } = setup(); // an empty registry = the next container after a crash
    await store!.put(record("dead", NOW, { status: "interrupted", startedAt: NOW }));
    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished" });
    expect(finished.runs.map((r) => r.id)).toEqual(["dead"]);
    expect(finished.runs[0]).toMatchObject({ finished: true, status: "interrupted", finishedAt: NOW, persisted: true });
    const got = await svc.getRun("dead");
    expect(got.ok && got.value.status).toBe("interrupted");
  });

  it("active = unfinished registry runs only and never calls the store; finished = finished registry ∪ store; all = union", async () => {
    const { reg, svc, store } = setup();
    const list = vi.spyOn(store!, "list");
    const live = reg.create("live");
    const done = reg.create("done");
    reg.finish(done.id);
    await store!.put(record("p1", NOW - DAY));

    const active = await svc.listRuns({ visibleTo: ALL, status: "active" });
    expect(active.runs.map((r) => r.id)).toEqual([live.id]);
    expect(active.runs[0].finished).toBe(false);
    expect(list).not.toHaveBeenCalled();

    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished" });
    expect(finished.runs.map((r) => r.id)).toEqual([done.id, "p1"]);
    expect(finished.runs.every((r) => r.finished)).toBe(true);

    const all = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(all.runs.map((r) => r.id)).toEqual([live.id, done.id, "p1"]); // unfinished first, then finishedAt desc
    expectNoToken(all);
  });

  it("orders by the store's key — live rows first, then finishedAt desc, id desc — so a page is a true top-N even when an old run started late", async () => {
    const { reg, tick, svc, store } = setup();
    // "late" started most recently but finished FIRST: under a startedAt order it
    // would outrank newer-finished runs and the page would not be the store's top-N.
    await store!.put(record("late", NOW - 1000, { startedAt: NOW - 1500 }));
    await store!.put(record("b", NOW, { startedAt: NOW - 60_000 }));
    await store!.put(record("a", NOW, { startedAt: NOW - 60_000 })); // finishedAt tie → id desc
    tick(5_000);
    const live = reg.create();
    const all = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(all.runs.map((r) => r.id)).toEqual([live.id, "b", "a", "late"]);
    expect(all.nextBefore).toBeUndefined(); // short page: the end of the list
  });

  it("pages with nextBefore = the last persisted row's {finishedAt, id}; same-ms siblings are not skipped; live rows are omitted past the first page", async () => {
    const { reg, svc, store } = setup();
    for (const id of ["p1", "p2", "p3"]) await store!.put(record(id, NOW)); // three siblings, one finishedAt
    await store!.put(record("p0", NOW - DAY));
    const live = reg.create("live");
    const page1 = await svc.listRuns({ visibleTo: ALL, status: "all", limit: 2 });
    expect(page1.runs.map((r) => r.id)).toEqual([live.id, "p3"]);
    expect(page1.nextBefore).toEqual({ finishedAt: NOW, id: "p3" });
    const page2 = await svc.listRuns({
      visibleTo: ALL,
      status: "all",
      limit: 2,
      before: page1.nextBefore!.finishedAt,
      beforeId: page1.nextBefore!.id,
    });
    expect(page2.runs.map((r) => r.id)).toEqual(["p2", "p1"]);
    expect(page2.nextBefore).toEqual({ finishedAt: NOW, id: "p1" });
    const page3 = await svc.listRuns({
      visibleTo: ALL,
      status: "all",
      limit: 2,
      ...{ before: page2.nextBefore!.finishedAt, beforeId: page2.nextBefore!.id },
    });
    expect(page3.runs.map((r) => r.id)).toEqual(["p0"]);
    expect(page3.nextBefore).toBeUndefined();
    // A full page of live rows only has no store cursor.
    reg.create("live-2");
    const liveOnly = await svc.listRuns({ visibleTo: ALL, status: "active", limit: 2 });
    expect(liveOnly.runs).toHaveLength(2);
    expect(liveOnly.nextBefore).toBeUndefined();
  });

  it("filters by agent, channel and sinceMs on live rows too — a live run carries the RunMeta given at create()", async () => {
    const { reg, svc, store } = setup();
    await store!.put(record("c1", NOW - DAY, { agent: "coding", channelId: "slack:C1" }));
    await store!.put(record("r1", NOW - 2 * DAY, { agent: "review", channelId: "slack:C2" }));
    await store!.put(record("old", NOW - 10 * DAY, { agent: "coding", channelId: "slack:C1" }));
    const live = reg.create("live", {
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:UIVY",
      threadKey: "slack:C1:9",
    });
    const bare = reg.create("bare"); // no meta: excluded by an agent/channel filter, kept otherwise

    const coding = await svc.listRuns({ visibleTo: ALL, status: "all", agent: "coding" });
    expect(coding.runs.map((r) => r.id)).toEqual([live.id, "c1", "old"]);
    expect(coding.runs[0]).toMatchObject({
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:UIVY",
      threadKey: "slack:C1:9",
    });

    const c2 = await svc.listRuns({ visibleTo: ALL, status: "all", channel: "slack:C2" });
    expect(c2.runs.map((r) => r.id)).toEqual(["r1"]);

    const recent = await svc.listRuns({ visibleTo: ALL, status: "all", sinceMs: NOW - 3 * DAY });
    expect(recent.runs.map((r) => r.id)).toEqual([bare.id, live.id, "c1", "r1"]);
  });

  it("a run in both sources projects identically from the live row and the persisted row, except for the finish-only fields", async () => {
    const { reg, tick, svc, store } = setup();
    const meta = {
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:x",
      channelVisibility: "unknown" as const,
      repo: "acme/x",
    };
    const { id } = reg.create("coding · acme/x", meta);
    reg.publish(id, { type: "input", text: "go" });
    reg.finish(id);
    reg.seal(id, { replyOk: true });
    await store!.put(
      record(id, NOW + 1, {
        ...meta,
        label: "coding · acme/x",
        startedAt: NOW,
        stepCount: 1,
        events: [{ type: "input", text: "go", seq: 1 }],
      }),
    );
    reg.markPersisted(id);
    const liveRow = (await svc.getRun(id)).ok && (await svc.getRun(id));
    tick(61_000);
    const persistedRow = await svc.getRun(id);
    if (!liveRow || !liveRow.ok || !persistedRow.ok) throw new Error("both reads must succeed");
    const finishOnly = [
      "finishedAt",
      "sealedAt",
      "replyOk",
      "status",
      "storedEventCount",
      "truncated",
      "diagnosis",
      "bytes",
    ];
    const strip = (v: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(v).filter(([k]) => !finishOnly.includes(k)));
    expect(strip(liveRow.value as unknown as Record<string, unknown>)).toEqual(
      strip(persistedRow.value as unknown as Record<string, unknown>),
    );
    expect(liveRow.value).toMatchObject({
      label: "coding · acme/x",
      ...meta,
      finished: true,
      persisted: true,
      eventCount: 1,
    });
    expect(persistedRow.value).toMatchObject({ status: "completed", finishedAt: NOW + 1 });
  });

  it("a live→persisted afterSeq cursor addresses the same events: the record keeps the registry seq, not positions", async () => {
    const { reg: r2, tick: t2 } = testRegistry({ backlogLimit: 5 });
    const s2 = new InMemoryRunStore({ now: () => NOW });
    const svc2 = createRunsService({ registry: r2, store: s2 });
    const { id, token } = r2.create("trimmed");
    for (let i = 1; i <= 20; i++) r2.publish(id, call(`$ step ${i}`));
    r2.finish(id);
    const snap = r2.snapshot(id, token)!;
    expect(snap.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20]); // the backlog kept the newest five
    await s2.put(record(id, NOW, { events: snap.events, eventCount: 20, storedEventCount: 5, truncated: true }));

    const live = await svc2.getRunEvents(id, { afterSeq: 17 });
    expect(live.ok && live.value.events.map((e) => e.seq)).toEqual([18, 19, 20]);
    t2(61_000); // evicted: the same read now comes from the store
    const persisted = await svc2.getRunEvents(id, { afterSeq: 17 });
    expect(persisted.ok && persisted.value.events.map((e) => e.seq)).toEqual([18, 19, 20]);
    expect(persisted.ok && persisted.value.events.map((e) => (e as { summary: string }).summary)).toEqual([
      "$ step 18",
      "$ step 19",
      "$ step 20",
    ]);
    const first = await svc2.getRunEvents(id, { afterSeq: 0, limit: 2 });
    expect(first.ok && first.value.events.map((e) => e.seq)).toEqual([16, 17]);
    expect(first.ok && first.value.nextAfterSeq).toBe(17);
  });

  it("applies limit after the merge (default 50, cap 200) and fetches at most limit + activeCount persisted rows", async () => {
    const { reg, svc, store } = setup();
    const list = vi.spyOn(store!, "list");
    for (let i = 0; i < 60; i++) await store!.put(record(`p${String(i).padStart(3, "0")}`, NOW - i * 1000));
    const a = reg.create("a");
    const b = reg.create("b");
    reg.finish(b.id);

    const limited = await svc.listRuns({ visibleTo: ALL, status: "all", limit: 10 });
    expect(limited.runs).toHaveLength(10);
    // The unfinished row first; then the store's key — `b` finished at NOW like p000, so id desc decides.
    expect(limited.runs.slice(0, 3).map((r) => r.id)).toEqual([a.id, "p000", b.id]);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 12 }));

    const dflt = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(dflt.runs).toHaveLength(50);

    const capped = await svc.listRuns({ visibleTo: ALL, status: "all", limit: 10_000 });
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 200 }));
    expect(capped.runs).toHaveLength(62);
  });

  it("listRuns({limit:10}) against a 5000-run store fetches a bounded page", async () => {
    const { svc } = setup();
    const rows = Array.from({ length: 5000 }, (_, i) => {
      const { events: _e, ...rest } = record(`p${i}`, NOW - i * 1000);
      return rest;
    });
    const store: RunStore = {
      put: vi.fn(),
      get: vi.fn(async () => null),
      getSummary: vi.fn(async () => null),
      list: vi.fn(async (opts) => rows.slice(0, Math.min(200, opts.limit ?? 50))),
      events: vi.fn(async () => ({ events: [] })),
      delete: vi.fn(),
    };
    const { reg } = testRegistry();
    const bounded = createRunsService({ registry: reg, store });
    const res = await bounded.listRuns({ visibleTo: ALL, status: "all", limit: 10 });
    expect(res.runs).toHaveLength(10);
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    void svc;
  });

  it("degrades to live rows + storeUnavailable when the store throws, warning once per failure (the message, never a token); active is unaffected", async () => {
    const broken: RunStore = {
      put: vi.fn(),
      get: vi.fn(async () => {
        throw new Error("boom");
      }),
      getSummary: vi.fn(async () => {
        throw new Error("boom");
      }),
      list: vi.fn(async () => {
        throw new Error("boom");
      }),
      events: vi.fn(async () => {
        throw new Error("boom");
      }),
      delete: vi.fn(),
    };
    const warn = vi.fn<(m: string) => void>();
    const { reg } = testRegistry();
    const svc = createRunsService({ registry: reg, store: broken, warn });
    const live = reg.create("live");
    const done = reg.create("done");
    reg.finish(done.id);

    const all = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(all.runs.map((r) => r.id)).toEqual([live.id, done.id]); // unfinished first, then by finishedAt
    expect(all.storeUnavailable).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("boom");
    expect(warn.mock.calls[0][0]).not.toContain("tok-");

    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished" });
    expect(finished.runs.map((r) => r.id)).toEqual([done.id]);
    expect(finished.storeUnavailable).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);

    const active = await svc.listRuns({ visibleTo: ALL, status: "active" });
    expect(active).toEqual({ runs: [expect.objectContaining({ id: live.id })] });
    expect(broken.list).toHaveBeenCalledTimes(2);
  });

  it("a run in both sources: the RECORD's finishedAt/status win over the registry row's (the record is the source of truth; a reply that threw after the loop is `failed` there only)", async () => {
    const { reg, tick, svc, store } = setup();
    const run = reg.create("r", {
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
    });
    tick(5_000);
    reg.finish(run.id, "completed");
    await store!.put(record(run.id, NOW + 5_000, { status: "failed" }));
    reg.markPersisted(run.id);
    const [row] = (await svc.listRuns({ visibleTo: ALL, status: "all" })).runs;
    expect(row).toMatchObject({ id: run.id, status: "failed", finishedAt: NOW + 5_000, persisted: true });
  });

  it("a finished registry row carries the status and finishedAt the dispatcher handed to finish() — nothing re-derived", async () => {
    const { reg, tick, svc } = setup();
    const run = reg.create("r", {
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
    });
    tick(7_000);
    reg.finish(run.id, "failed");
    const [row] = (await svc.listRuns({ visibleTo: ALL, status: "all" })).runs;
    expect(row).toMatchObject({
      id: run.id,
      finished: true,
      status: "failed",
      finishedAt: NOW + 7_000,
      startedAt: NOW,
    });
    const got = await svc.getRun(run.id);
    expect(got.ok && got.value).toMatchObject({ status: "failed", finishedAt: NOW + 7_000 });
  });

  it("with history off (store null) lists live rows and never reports storeUnavailable", async () => {
    const { reg, svc } = setup(null);
    const live = reg.create();
    expect(await svc.listRuns({ visibleTo: ALL, status: "all" })).toEqual({
      runs: [expect.objectContaining({ id: live.id })],
    });
  });

  it("`visibleTo` is pushed down to the store: live rows are filtered by the predicate, the store is asked with its wire form, `all` sends no filter, and `none` touches neither", async () => {
    const { reg, svc, store } = setup();
    await store!.put(
      record("pub", NOW - DAY, { channelId: "slack:C_PUB", userId: "slack:UALICE", channelVisibility: "public" }),
    );
    await store!.put(
      record("priv", NOW - 2 * DAY, { channelId: "slack:G1", userId: "slack:UBOB", channelVisibility: "private" }),
    );
    const liveOps = reg.create("ops", {
      agent: "coding",
      channelId: "http:ops",
      userId: "http:ci",
      threadKey: "http:ops:1",
      channelVisibility: "machine",
    });
    const livePriv = reg.create("priv-live", {
      agent: "coding",
      channelId: "slack:G1",
      userId: "slack:UBOB",
      threadKey: "slack:G1:1",
      channelVisibility: "private",
    });
    const unstamped = reg.create("bare", {
      agent: "coding",
      channelId: "slack:C_PUB",
      userId: "slack:UCAROL",
      threadKey: "slack:C_PUB:2",
    }); // no stamp = unknown
    const list = vi.spyOn(store!, "list");

    // A token granted http:ops: its channel, the public runs, its own.
    const token = await svc.listRuns({
      status: "all",
      visibleTo: {
        kind: "or",
        of: [
          { kind: "channels-in", channelIds: new Set(["http:ops"]) },
          { kind: "visibility-in", visibilities: new Set(["public"]) },
          { kind: "user-is", userId: "http:ci" },
        ],
      },
    });
    expect(token.runs.map((r) => r.id)).toEqual([liveOps.id, "pub"]);
    expect(list.mock.calls[0][0].visibleTo).toEqual({
      kind: "or",
      of: [
        { kind: "channels-in", channelIds: ["http:ops"] },
        { kind: "visibility-in", visibilities: ["public"] },
        { kind: "user-is", userId: "http:ci" },
      ],
    });

    // The private run's own user: the live and persisted private rows, plus public; never the unstamped one.
    const owner = await svc.listRuns({
      status: "all",
      visibleTo: {
        kind: "or",
        of: [
          { kind: "visibility-in", visibilities: new Set(["public"]) },
          { kind: "user-is", userId: "slack:UBOB" },
        ],
      },
    });
    expect(owner.runs.map((r) => r.id)).toEqual([livePriv.id, "pub", "priv"]);

    list.mockClear();
    expect(await svc.listRuns({ status: "all", visibleTo: { kind: "none" } })).toEqual({ runs: [] });
    expect(list).not.toHaveBeenCalled();
    const everything = await svc.listRuns({ status: "all", visibleTo: ALL });
    expect(everything.runs.map((r) => r.id)).toEqual([unstamped.id, livePriv.id, liveOps.id, "pub", "priv"]);
    expect(list.mock.calls[0][0]).not.toHaveProperty("visibleTo");
    // The view carries the stamp so a point read can be authorized on it.
    expect(everything.runs.find((r) => r.id === "pub")?.channelVisibility).toBe("public");
    expect(everything.runs.find((r) => r.id === liveOps.id)?.channelVisibility).toBe("machine");
    expect(everything.runs.find((r) => r.id === unstamped.id)).not.toHaveProperty("channelVisibility");
  });
});

// One durable registry across container generations (docs/reference/specs/run-history.md
// item 41): a run live on the ledger under another generation
// — or reclaimed here and not yet launched — lists, reads, pages, diagnoses and
// stops through the same service as a run in this process's registry.
describe("RunsService with the run ledger — one registry across generations (run-history item 41)", () => {
  function ledgerSetup() {
    const base = setup();
    const ledger = new InMemoryRunLedger(() => NOW);
    const warnings: string[] = [];
    const svc = createRunsService({ registry: base.reg, store: base.store, ledger, warn: (m) => warnings.push(m) });
    return { ...base, svc, ledger, warnings };
  }
  async function farRun(ledger: InMemoryRunLedger, id = "far-1", over: { userId?: string; agent?: string } = {}) {
    await ledger.claim({
      runId: id,
      threadKey: `slack:C9:${id}`,
      gen: "g-OTHER",
      leaseMs: 30_000,
      startedAt: NOW - 5_000,
      meta: {
        channelId: "slack:C9",
        userId: over.userId ?? "slack:UIVY",
        threadKey: `slack:C9:${id}`,
        agent: over.agent ?? "coding",
        model: "anthropic/claude",
        channelVisibility: "public",
        repo: "acme/api",
        userName: "nine",
        sourceUrl: "https://s/9",
      },
      card: null,
      system: "sys",
      tools: [],
    });
    await ledger.append(id, "g-OTHER", [
      { type: "input", text: "do the far thing", at: NOW - 5_000, seq: 1 },
      { type: "tool_call", tool: "bash", summary: "$ make", at: NOW - 4_000, seq: 2 },
    ]);
  }

  it("lists a run live on the ledger under another generation as a live row — its agent, sender, repo, event count and activity from the ledger, its owner generation named — under `all` and `active`, never under `finished`; its store tombstone never surfaces", async () => {
    const { svc, store, ledger } = ledgerSetup();
    await farRun(ledger);
    // The start tombstone a killed run would leave: terminal in the store while the ledger says live.
    await store!.put(
      record("far-1", NOW - 5_000, { status: "interrupted", startedAt: NOW - 5_000, finishedAt: NOW - 5_000 }),
    );
    const all = await svc.listRuns({ visibleTo: ALL, status: "all" });
    expect(all.runs.map((r) => r.id)).toEqual(["far-1"]);
    expect(all.runs[0]).toMatchObject({
      finished: false,
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C9",
      userId: "slack:UIVY",
      threadKey: "slack:C9:far-1",
      channelVisibility: "public",
      repo: "acme/api",
      userName: "nine",
      sourceUrl: "https://s/9",
      startedAt: NOW - 5_000,
      eventCount: 2,
      ownerGen: "g-OTHER",
    });
    expect(all.runs[0].activity).toBeDefined();
    expect(all.runs[0].finishedAt).toBeUndefined();
    expect(all.runs[0].status).toBeUndefined(); // not the tombstone's `interrupted`
    expectNoToken(all);
    const active = await svc.listRuns({ visibleTo: ALL, status: "active" });
    expect(active.runs.map((r) => r.id)).toEqual(["far-1"]);
    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished" });
    expect(finished.runs).toEqual([]); // live on the ledger: its tombstone is not a finished run
  });

  it("a run in this process's registry is listed once even when the ledger holds its row too (the registry wins); the ledger rows sort with the live ones, newest started first", async () => {
    const { svc, reg, ledger } = ledgerSetup();
    const mine = reg.create("coding · mine", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:mine",
    });
    await ledger.claim({
      runId: mine.id,
      threadKey: "slack:C1:mine",
      gen: "g-ME",
      leaseMs: 30_000,
      startedAt: NOW,
      meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:mine", agent: "coding" },
      card: null,
      system: "sys",
      tools: [],
    });
    await farRun(ledger);
    const res = await svc.listRuns({ visibleTo: ALL, status: "active" });
    expect(res.runs.map((r) => r.id)).toEqual([mine.id, "far-1"]);
    expect(res.runs[0].ownerGen).toBeUndefined(); // ours: the registry row, not the ledger's
  });

  it("the viewer's predicate applies to ledger rows as to any row", async () => {
    const { svc, ledger } = ledgerSetup();
    await farRun(ledger, "far-1", { userId: "slack:UIVY" });
    await farRun(ledger, "far-2", { userId: "slack:UHAL" });
    const res = await svc.listRuns({ visibleTo: { kind: "user-is", userId: "slack:UHAL" }, status: "active" });
    expect(res.runs.map((r) => r.id)).toEqual(["far-2"]);
    expect((await svc.listRuns({ visibleTo: { kind: "none" }, status: "active" })).runs).toEqual([]);
  });

  it("getRun, getRunEvents and getRunFriction answer for a ledger row: the view (with the events on a messages read), a seq page, a live diagnosis", async () => {
    const { svc, ledger } = ledgerSetup();
    await farRun(ledger);
    const view = await svc.getRun("far-1");
    expect(view.ok && view.value).toMatchObject({ id: "far-1", finished: false, ownerGen: "g-OTHER", eventCount: 2 });
    expect(view.ok && view.value.events).toBeUndefined();
    const full = await svc.getRun("far-1", { include: "messages" });
    expect(full.ok && full.value.events?.map((e) => e.type)).toEqual(["input", "tool_call"]);
    const page = await svc.getRunEvents("far-1", { afterSeq: 1 });
    expect(page.ok && page.value.events.map((e) => e.seq)).toEqual([2]);
    const friction = await svc.getRunFriction("far-1");
    expect(friction.ok && friction.value).toMatchObject({ id: "far-1", finished: false });
    expect(await svc.getRun("far-nope")).toEqual({ ok: false, error: "not_found" });
    expectNoToken([view, full, page, friction]);
  });

  it("stopRun on a ledger row asks the ledger — the owning generation reads the stop on its next heartbeat — and answers stopping; an unknown id stays not_found", async () => {
    const { svc, ledger } = ledgerSetup();
    await farRun(ledger);
    expect(await svc.stopRun("far-1", "soft", actor)).toEqual({
      ok: true,
      value: { id: "far-1", mode: "soft", state: "stopping" },
    });
    expect(ledger.live.get("far-1")!.stop).toBe("soft");
    expect(await svc.stopRun("far-nope", "soft", actor)).toEqual({ ok: false, error: "not_found" });
  });

  it("one ledger listing serves every read within the TTL — a page view's run, events and friction reads cost one listLive; the events of several rows are read in parallel; a failed listing is not kept", async () => {
    let clock = NOW;
    const base = setup();
    const ledger = new InMemoryRunLedger(() => NOW);
    const listLive = vi.spyOn(ledger, "listLive");
    const svc = createRunsService({ registry: base.reg, store: base.store, ledger, clock: () => clock });
    await farRun(ledger, "far-1");
    await farRun(ledger, "far-2");
    await svc.getRun("far-1");
    await svc.getRunEvents("far-1", {});
    await svc.getRunFriction("far-1");
    await svc.listRuns({ visibleTo: ALL, status: "active" });
    expect(listLive).toHaveBeenCalledTimes(1);
    clock += 2_001; // past the TTL: listed again
    expect((await svc.listRuns({ visibleTo: ALL, status: "active" })).runs).toHaveLength(2);
    expect(listLive).toHaveBeenCalledTimes(2);
    // A listing that failed is not kept for the TTL: the next read asks again.
    clock += 2_001;
    listLive.mockRejectedValueOnce(new Error("HTTP 503"));
    expect(await svc.getRun("far-1")).toEqual({ ok: false, error: "not_found" });
    expect((await svc.getRun("far-1")).ok).toBe(true);
    expect(listLive).toHaveBeenCalledTimes(4);
  });

  it("a ledger that cannot be read degrades to the registry (and the store): one warning, never a failed list", async () => {
    const { svc, reg, warnings, ledger } = ledgerSetup();
    reg.create("coding · mine");
    ledger.listLive = async () => {
      throw new Error("HTTP 503");
    };
    const res = await svc.listRuns({ visibleTo: ALL, status: "active" });
    expect(res.runs).toHaveLength(1);
    expect(warnings).toEqual([expect.stringContaining("HTTP 503")]);
    expect(await svc.getRun("far-1")).toEqual({ ok: false, error: "not_found" });
  });

  it("liveElsewhere is the ledger's live rows that are not in the registry, under the viewer's predicate — what the default index adds to the registry", async () => {
    const { svc, reg, ledger } = ledgerSetup();
    const mine = reg.create("mine");
    await ledger.claim({
      runId: mine.id,
      threadKey: "slack:C1:mine",
      gen: "g-ME",
      leaseMs: 30_000,
      startedAt: NOW,
      meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:mine" },
      card: null,
      system: "sys",
      tools: [],
    });
    await farRun(ledger);
    expect((await svc.liveElsewhere(ALL)).map((r) => r.id)).toEqual(["far-1"]);
    expect(await svc.liveElsewhere({ kind: "none" })).toEqual([]);
    const plain = createRunsService({ registry: reg, store: null });
    expect(await plain.liveElsewhere(ALL)).toEqual([]); // no ledger: nothing elsewhere
  });
});

describe("RunsService — summary-only persisted reads", () => {
  it("getRun without include, getRunFriction and stopRun read the persisted summary (store.getSummary), never the full record", async () => {
    const inner = new InMemoryRunStore({ now: () => NOW });
    await inner.put(
      record("p1", NOW - DAY, {
        events: [
          { type: "input", text: "x", seq: 1 },
          ...Array.from({ length: 50 }, (_, i) => ({ ...call(`$ ${i}`), seq: i + 2 })),
        ],
      }),
    );
    const store: RunStore = {
      put: (r) => inner.put(r),
      get: vi.fn((id: string) => inner.get(id)),
      getSummary: vi.fn((id: string) => inner.getSummary(id)),
      list: (o) => inner.list(o),
      events: (id, o) => inner.events(id, o),
      delete: (id) => inner.delete(id),
    };
    const { reg } = testRegistry();
    const svc = createRunsService({ registry: reg, store });

    const view = await svc.getRun("p1");
    expect(view.ok && view.value).toMatchObject({
      id: "p1",
      finished: true,
      persisted: true,
      status: "completed",
      eventCount: 51,
    });
    expect(view.ok && (view.value as { events?: unknown }).events).toBeUndefined();
    const friction = await svc.getRunFriction("p1");
    expect(friction.ok && friction.value.diagnosis.eventCount).toBeGreaterThan(0);
    expect(await svc.stopRun("p1", "soft", actor)).toEqual({ ok: false, error: "conflict" });
    expect(await svc.getRun("nope")).toEqual({ ok: false, error: "not_found" });
    expect(await svc.stopRun("nope", "soft", actor)).toEqual({ ok: false, error: "not_found" });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.getSummary).toHaveBeenCalledTimes(5);

    const full = await svc.getRun("p1", { include: "messages" });
    expect(full.ok && full.value.events).toHaveLength(51);
    expect(store.get).toHaveBeenCalledTimes(1);
  });
});

describe("RunsService.getRunEvents", () => {
  it("live: seq > afterSeq strictly, honoring limit, with nextAfterSeq while more follow", async () => {
    const { reg, svc } = setup();
    const { id } = reg.create();
    for (let i = 1; i <= 20; i++) reg.publish(id, call(`$ step ${i}`));

    const page = await svc.getRunEvents(id, { afterSeq: 10, limit: 5 });
    expect(page.ok && page.value.events.map((e) => e.seq)).toEqual([11, 12, 13, 14, 15]);
    expect(page.ok && page.value.nextAfterSeq).toBe(15);

    const tail = await svc.getRunEvents(id, { afterSeq: 15 });
    expect(tail.ok && tail.value.events.map((e) => e.seq)).toEqual([16, 17, 18, 19, 20]);
    expect(tail.ok && tail.value.nextAfterSeq).toBeUndefined();
    expectNoToken(page);
  });

  it("persisted: seq > afterSeq strictly; a 5000-event run returns a bounded page (≤ 500 events) with nextAfterSeq, read via store.events", async () => {
    const { svc, store } = setup();
    const events = vi.spyOn(store!, "events");
    const evs: RunEvent[] = Array.from({ length: 5000 }, (_, i) => call(`$ step ${i + 1}`));
    await store!.put(record("big", NOW, { events: evs, eventCount: 5000, storedEventCount: 5000 }));

    const first = await svc.getRunEvents("big", {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events).toHaveLength(500);
    expect(first.value.events[0].seq).toBe(1);
    expect(first.value.nextAfterSeq).toBe(500);
    expect(events).toHaveBeenCalledWith("big", expect.objectContaining({ afterSeq: 0, limit: 500 }));

    const later = await svc.getRunEvents("big", { afterSeq: 10, limit: 3 });
    expect(later.ok && later.value.events.map((e) => e.seq)).toEqual([11, 12, 13]);
    expect(later.ok && later.value.nextAfterSeq).toBe(13);

    const oversized = await svc.getRunEvents("big", { limit: 100_000 });
    expect(oversized.ok && oversized.value.events).toHaveLength(500);
  });

  it("caps a page at 256 KiB of event JSON and resumes from the cut", async () => {
    const { reg, svc } = setup();
    const { id } = reg.create();
    const big = "x".repeat(60 * 1024); // 60 KiB of text per event
    for (let i = 0; i < 10; i++) reg.publish(id, { type: "context", text: big });

    const page = await svc.getRunEvents(id, {});
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.events).toHaveLength(4); // 4 × ~60 KiB fits under 256 KiB; the 5th would not
    expect(page.value.nextAfterSeq).toBe(4);
    const rest = await svc.getRunEvents(id, { afterSeq: 4 });
    expect(rest.ok && rest.value.events.map((e) => e.seq)).toEqual([5, 6, 7, 8]);
  });

  it("is not_found for an unknown or expired run; a persisted run with zero events is ok with an empty page (getRun ok too)", async () => {
    const { svc, store } = setup();
    await store!.put(record("old", NOW - 31 * DAY));
    expect(await svc.getRunEvents("nope", {})).toEqual({ ok: false, error: "not_found" });
    expect(await svc.getRunEvents("old", {})).toEqual({ ok: false, error: "not_found" });
    await store!.put(record("empty", NOW, { events: [], eventCount: 0, storedEventCount: 0 }));
    expect(await svc.getRun("empty")).toMatchObject({ ok: true, value: { id: "empty", eventCount: 0 } });
    expect(await svc.getRunEvents("empty", {})).toEqual({ ok: true, value: { events: [] } });
    expect(await svc.getRunEvents("empty", { afterSeq: 10 })).toEqual({ ok: true, value: { events: [] } });
  });
});

describe("RunsService.getRunFriction", () => {
  it("analyzes the live snapshot (finished:false) and returns the stored diagnosis for a persisted run", async () => {
    const { reg, svc, store } = setup();
    const { id } = reg.create();
    reg.publish(id, call("$ npm test"));
    const live = await svc.getRunFriction(id);
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.value).toMatchObject({ id, finished: false });
    expect(live.value.diagnosis.eventCount).toBe(1);
    expectNoToken(live);

    const rec = record("p1", NOW - DAY);
    await store!.put(rec);
    const stored = await svc.getRunFriction("p1");
    expect(stored.ok && stored.value).toEqual({ id: "p1", finished: true, diagnosis: rec.diagnosis });

    expect(await svc.getRunFriction("nope")).toEqual({ ok: false, error: "not_found" });
  });

  it("passes the injected analyzer the live events and finished flag", async () => {
    const { reg } = testRegistry();
    const analyze = vi.fn(analyzeRunFriction);
    const svc = createRunsService({ registry: reg, store: null, analyze });
    const { id } = reg.create();
    reg.publish(id, call("$ ls"));
    reg.finish(id);
    await svc.getRunFriction(id);
    // The live stream is schema 2 and a finished run's window is its own stamps (docs/reference/specs/tracing.md).
    expect(analyze).toHaveBeenCalledWith([expect.objectContaining({ seq: 1 })], {
      finished: true,
      truncated: false,
      schema: 2,
      window: { start: expect.any(Number), end: expect.any(Number) },
    });
  });
});

describe("RunsService.stopRun", () => {
  it("live: drives the control and publishes stop_requested with the structured actor", async () => {
    const { reg, svc } = setup();
    const { id, token, control } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });

    const res = await svc.stopRun(id, "soft", { kind: "chat", id: "slack:U123" });
    expect(res).toEqual({ ok: true, value: { id, mode: "soft", state: "stopping" } });
    expect(control.requested).toBe("soft");
    expect(seen.at(-1)).toMatchObject({
      type: "run_note",
      kind: "stop_requested",
      mode: "soft",
      actor: { kind: "chat", id: "slack:U123" },
    });
    expect(reg.getById(id)?.stop).toEqual({ mode: "soft", state: "stopping" });
    expectNoToken(res);
  });

  it("strips disallowed characters from actor.id and caps it at 128", async () => {
    const { reg, svc } = setup();
    const { id, token } = reg.create();
    const seen: RunEvent[] = [];
    reg.subscribe(id, token, { onEvent: (e) => seen.push(e) });
    await svc.stopRun(id, "hard", { kind: "access", id: `a b<script>@x.y${"z".repeat(300)}` });
    const note = seen.at(-1) as Extract<RunEvent, { type: "run_note" }>;
    expect(note.actor?.id).toMatch(/^[A-Za-z0-9:@._-]{1,128}$/);
    expect(note.actor?.id.startsWith("abscript@x.y")).toBe(true);
    expect(note.actor?.id).toHaveLength(128);
  });

  it("is conflict for a finished (still in registry) run and for a persisted run; not_found for unknown", async () => {
    const { reg, svc, store } = setup();
    const { id } = reg.create();
    reg.finish(id);
    expect(await svc.stopRun(id, "soft", actor)).toEqual({ ok: false, error: "conflict" });
    await store!.put(record("p1", NOW - DAY));
    expect(await svc.stopRun("p1", "hard", actor)).toEqual({ ok: false, error: "conflict" });
    expect(await svc.stopRun("nope", "soft", actor)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("RunsService.authorizeLive", () => {
  it("returns null for a wrong token or unknown run and a working subscription for the right one", () => {
    const { reg, svc } = setup();
    const { id, token } = reg.create();
    reg.publish(id, call("$ ls"));
    expect(svc.authorizeLive(id, "tok-wrong")).toBeNull();
    expect(svc.authorizeLive("nope", token)).toBeNull();

    const live = svc.authorizeLive(id, token);
    expect(live).not.toBeNull();
    const seen: RunEvent[] = [];
    let finished = false;
    const unsub = live!.subscribe({ onEvent: (e) => seen.push(e), onSealed: () => (finished = true) });
    expect(unsub).not.toBeNull();
    reg.publish(id, call("$ pwd"));
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
    expect(live!.snapshot()).toMatchObject({ finished: false, eventCount: 2 });
    reg.finish(id);
    reg.seal(id); // the end frame comes with the seal
    expect(finished).toBe(true);
  });
});

describe("RunsService — no output carries the capability token", () => {
  it("every method's serialized result lacks the fixture token", async () => {
    const { reg, svc, store } = setup();
    const { id, token } = reg.create("coding · acme/x");
    reg.publish(id, call("$ ls"));
    await store!.put(record("p1", NOW - DAY));
    const outputs: unknown[] = [
      await svc.listRuns({ visibleTo: ALL, status: "all" }),
      await svc.listRuns({ visibleTo: ALL, status: "active" }),
      await svc.getRun(id, { include: "messages" }),
      await svc.getRun("p1", { include: "messages" }),
      await svc.getRunEvents(id, {}),
      await svc.getRunFriction(id),
      await svc.stopRun(id, "soft", actor),
    ];
    expect(token).toBe("tok-1"); // the fixture token really is in play
    for (const out of outputs) expectNoToken(out);
  });
});

// Type-level: the service is the public contract other units build on.
const _typecheck: (svc: RunsService) => void = () => {};
void _typecheck;
