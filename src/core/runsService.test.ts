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
import { parseModelPrices } from "./modelPricing.js";
import { InMemoryRunStore, type RunStore } from "./runStore.js";
import { createRunsService, type RunActor, type RunsService } from "./runsService.js";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import type { ChatMessage } from "./chatMessage.js";
import type { Predicate } from "./authz/types.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./coordinator/contract.js";
import { InMemoryCoordinatorInstanceStore } from "./coordinator/instanceStore.js";
import { GAP_MARKER } from "./runLedger/sessionLog.js";

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
    { type: "input", messageId: "m1", text: "do the thing", seq: 1 },
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
    reg.publish(id, { type: "input", messageId: "m1", text: "hi" });
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

  // Feature: docs/reference/specs/live-view.md item 32 (issue #1836) — the live
  // view carries the registry's pace facts, so the index row can tell a hung
  // bash from a slow suite; a persisted row never carries them.
  it("a live view carries the stall signal's pace facts — eventsLast5m, lastToolCallAt, inFlight with its bound; a persisted row none", async () => {
    const { reg, svc, store } = setup();
    const { id } = reg.create("coding · acme/x");
    reg.publish(id, { type: "tool_call", tool: "bash", summary: "$ npm test", boundMs: 600_000 });
    const res = await svc.getRun(id);
    expect(res.ok && res.value).toMatchObject({
      eventsLast5m: 1,
      lastToolCallAt: NOW,
      inFlight: { tool: "bash", since: NOW, boundMs: 600_000 },
    });
    await store!.put(record("r-done", NOW - 10_000));
    const done = await svc.getRun("r-done");
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value).not.toHaveProperty("eventsLast5m");
    expect(done.value).not.toHaveProperty("inFlight");
  });

  // docs/reference/specs/costs.md item 4c: a finished run's tokens are priced onto its view.
  it("prices a finished run from its record — a persisted row and a finished registry row alike — through the configured table; a live run carries no cost", async () => {
    const usage = {
      turns: 1,
      byModel: {
        "openai/gpt-5": { turns: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    };
    const { reg, store } = setup();
    await store!.put(record("priced", NOW - 1000, { usage }));
    await store!.put(record("old", NOW - 2000)); // written before usage existed
    // Without a table the list alone prices: the OpenAI model is unknown, so the run is unpriced — never $0.
    const listOnly = createRunsService({ registry: reg, store });
    const unpriced = await listOnly.getRun("priced");
    expect(unpriced.ok && unpriced.value.usage).toEqual(usage);
    expect(unpriced.ok && unpriced.value.cost).toEqual({
      usd: null,
      byModel: { "openai/gpt-5": { ...usage.byModel["openai/gpt-5"], usd: null } },
    });
    const old = await listOnly.getRun("old");
    expect(old.ok && "cost" in old.value).toBe(false);
    // The configured table prices it, on the summary read and the messages read alike.
    const svc = createRunsService({
      registry: reg,
      store,
      prices: parseModelPrices({ "openai/gpt-5": { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    });
    const priced = await svc.getRun("priced");
    expect(priced.ok && priced.value.cost?.usd).toBeCloseTo(2, 9);
    const full = await svc.getRun("priced", { include: "messages" });
    expect(full.ok && full.value.cost?.usd).toBeCloseTo(2, 9);
    // A finished row the registry still holds reads its usage and cost from the store's record.
    const { id } = reg.create("coding · acme/x", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:7",
    });
    reg.publish(id, { type: "input", messageId: "m1", text: "hi" });
    reg.finish(id, "completed");
    await store!.put(record(id, NOW, { usage }));
    const row = await svc.getRun(id);
    expect(row.ok && row.value.cost?.usd).toBeCloseTo(2, 9);
    expect(row.ok && row.value.usage).toEqual(usage);
    // A live run has neither: its usage is summed at finish.
    const live = reg.create("coding · acme/y", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:8",
    });
    const view = await svc.getRun(live.id);
    expect(view.ok && "cost" in view.value).toBe(false);
    expect(view.ok && "usage" in view.value).toBe(false);
  });

  // docs/reference/specs/run-history.md item 46: a spawned child's view names its
  // parent, live and persisted alike; a run with no parent carries no key.
  it("carries parentRunId from a live child's RunMeta and from a persisted child's record; no parent → no key", async () => {
    const { reg, svc, store } = setup();
    const child = reg.create("research · child", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:9",
      parentRunId: "run-parent",
    });
    const plain = reg.create("general · plain", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:8",
    });
    await store!.put(record("r-child", NOW - DAY, { parentRunId: "run-parent" }));
    const live = await svc.getRun(child.id);
    expect(live.ok && live.value.parentRunId).toBe("run-parent");
    const none = await svc.getRun(plain.id);
    expect(none.ok && "parentRunId" in none.value).toBe(false);
    const persisted = await svc.getRun("r-child");
    expect(persisted.ok && persisted.value.parentRunId).toBe("run-parent");
    const listed = await svc.listRuns({ status: "all", visibleTo: ALL });
    expect(listed.runs.map((r) => [r.id, r.parentRunId])).toEqual(
      expect.arrayContaining([
        [child.id, "run-parent"],
        ["r-child", "run-parent"],
      ]),
    );
  });

  // docs/reference/specs/run-history.md item 48: a coordinator's child names its
  // instance and its spawn's key on every view — live here, live on another
  // generation's ledger row, and persisted — so the spawn route can tell an
  // already-spawned step from a busy thread by reading the run.
  it("carries parentInstanceId and idempotencyKey from a live child's RunMeta, a ledger row's meta and a persisted record; a run without them carries no key", async () => {
    const { reg, tick } = testRegistry();
    const store = new InMemoryRunStore({ now: () => NOW });
    const ledger = new InMemoryRunLedger(() => NOW);
    const svc = createRunsService({ registry: reg, store, ledger });
    const tag = { parentInstanceId: "ship_acme_1", idempotencyKey: "ship_acme_1:u/0/coding" };
    const child = reg.create("coding · child", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:9",
      ...tag,
    });
    const plain = reg.create("general · plain", {
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:8",
    });
    await ledger.claim({
      runId: "r-far",
      threadKey: "slack:C1:7",
      gen: "gen-OTHER",
      leaseMs: 30_000,
      startedAt: NOW - 5_000,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:7", ...tag },
      card: null,
      system: "sys",
      tools: [],
    });
    await store.put(record("r-child", NOW - DAY, tag));
    tick(1);
    const live = await svc.getRun(child.id);
    expect(live.ok && live.value).toMatchObject(tag);
    const far = await svc.getRun("r-far");
    expect(far.ok && far.value).toMatchObject({ ...tag, ownerGen: "gen-OTHER" });
    const persisted = await svc.getRun("r-child");
    expect(persisted.ok && persisted.value).toMatchObject(tag);
    const none = await svc.getRun(plain.id);
    expect(none.ok && "parentInstanceId" in none.value).toBe(false);
    expect(none.ok && "idempotencyKey" in none.value).toBe(false);
    const active = await svc.listRuns({ status: "active", visibleTo: ALL });
    expect(
      active.runs
        .filter((r) => r.idempotencyKey === tag.idempotencyKey)
        .map((r) => r.id)
        .sort(),
    ).toEqual([child.id, "r-far"].sort());
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

  it("a finished run still in the registry carries verdict, reviewHead, reviewPost, dispositions and handoff from the store the moment the store holds its record — identity, status and events stay the registry's, and only the summary row is read", async () => {
    const inner = new InMemoryRunStore({ now: () => NOW });
    const store: RunStore = {
      put: (r) => inner.put(r),
      abandoned: () => {},
      get: vi.fn((id: string) => inner.get(id)),
      getSummary: vi.fn((id: string) => inner.getSummary(id)),
      list: (o) => inner.list(o),
      events: (id, o) => inner.events(id, o),
      delete: (id) => inner.delete(id),
      usage: (q) => inner.usage(q),
    };
    const { reg, tick } = testRegistry();
    const svc = createRunsService({ registry: reg, store });
    const run = reg.create("review · acme/api#7", {
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
    });
    reg.publish(run.id, { type: "input", messageId: "m1", text: "review #7" });
    reg.publish(run.id, { type: "answer", text: "LGTM: clean" });
    tick(40_000);
    reg.finish(run.id, "completed");
    const HEAD = "5f32069f".padEnd(40, "0");
    const verdict = { verdict: "approve" as const, summary: "clean", findings: [] };
    const dispositions = [{ findingId: "F1", disposition: "fixed" as const, note: "done" }];
    const handoff = { deviations: [], followUps: [], unproven: [] };
    const reviewPost = {
      posted: true as const,
      target: { repo: "acme/api", number: 7 },
      head: HEAD,
      verdict: "approve" as const,
    };
    // The finish record lands (and the writer tells the registry) while the row
    // is inside its 60 s TTL: the next read is the coordinator's, a second later.
    await store.put(
      record(run.id, NOW + 40_000, { agent: "review", verdict, reviewHead: HEAD, reviewPost, dispositions, handoff }),
    );
    reg.markPersisted(run.id);
    expect(reg.getById(run.id)?.finished).toBe(true);

    const res = await svc.getRun(run.id, { include: "messages" });
    expect(res.ok && res.value).toMatchObject({
      id: run.id,
      finished: true,
      persisted: true,
      status: "completed",
      finishedAt: NOW + 40_000,
      agent: "review",
      verdict,
      reviewHead: HEAD,
      reviewPost,
      dispositions,
      handoff,
    });
    // The events are the registry's two, not the record fixture's four.
    expect(res.ok && res.value.events?.map((e) => e.type)).toEqual(["input", "answer"]);
    expectNoToken(res);
    expect(store.getSummary).toHaveBeenCalledWith(run.id);
    expect(store.get).not.toHaveBeenCalled();
    // A read without `include` carries the same four fields.
    const summary = await svc.getRun(run.id);
    expect(summary.ok && summary.value).toMatchObject({ verdict, reviewHead: HEAD, dispositions, handoff });
    expect(summary.ok && summary.value).not.toHaveProperty("events");
    // The list of the same row says the same.
    const [row] = (await svc.listRuns({ visibleTo: ALL, status: "finished" })).runs;
    expect(row).toMatchObject({ id: run.id, verdict, reviewHead: HEAD, dispositions, handoff });
  });

  it("a finished registry row whose record has not landed carries no artifacts and is not persisted — the start tombstone lends nothing, not even its status; a live row never asks the store; a store that throws is one warning and the registry row", async () => {
    const inner = new InMemoryRunStore({ now: () => NOW });
    const store: RunStore = {
      put: (r) => inner.put(r),
      abandoned: () => {},
      get: vi.fn((id: string) => inner.get(id)),
      getSummary: vi.fn((id: string) => inner.getSummary(id)),
      list: (o) => inner.list(o),
      events: (id, o) => inner.events(id, o),
      delete: (id) => inner.delete(id),
      usage: (q) => inner.usage(q),
    };
    const warn = vi.fn<(message: string) => void>();
    const { reg, tick } = testRegistry();
    const svc = createRunsService({ registry: reg, store, warn });
    const run = reg.create("review · acme/api#7", {
      agent: "review",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
    });
    // The start tombstone (item 27): `interrupted`, `finishedAt` = `startedAt`, no artifacts.
    await store.put(record(run.id, NOW, { startedAt: NOW, status: "interrupted", agent: "review" }));
    const artifacts = ["verdict", "reviewHead", "dispositions", "handoff", "pr"];

    const live = await svc.getRun(run.id);
    expect(live.ok && live.value).toMatchObject({ id: run.id, finished: false });
    for (const key of artifacts) expect(live.ok && live.value).not.toHaveProperty(key);
    expect(store.getSummary).not.toHaveBeenCalled();

    tick(5_000);
    reg.finish(run.id, "completed"); // the finish record is on its way; the store still holds the tombstone
    const early = await svc.getRun(run.id);
    expect(early.ok && early.value).toMatchObject({
      id: run.id,
      finished: true,
      status: "completed",
      finishedAt: NOW + 5_000,
    });
    for (const key of artifacts) expect(early.ok && early.value).not.toHaveProperty(key);
    expect(early.ok && early.value.persisted).not.toBe(true);
    expect(store.getSummary).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    vi.mocked(store.getSummary).mockRejectedValueOnce(new Error("run store /runs/summary returned 503"));
    const degraded = await svc.getRun(run.id, { include: "messages" });
    expect(degraded.ok && degraded.value).toMatchObject({ id: run.id, finished: true, status: "completed" });
    for (const key of artifacts) expect(degraded.ok && degraded.value).not.toHaveProperty(key);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(run.id);
    expect(warn.mock.calls[0][0]).toContain("returned 503");
    expectNoToken(degraded);
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

  // docs/reference/specs/agent-conductor.md item 10: a thread's newest run is
  // one read — the filter narrows both sides of the merge.
  it("`threadKey` narrows the listing to one thread's runs — a live registry row first, then the store's, newest first — so a thread's newest run is one read with `limit: 1`", async () => {
    const { reg, svc, store } = setup();
    await store!.put(record("t-old", NOW - 5000, { threadKey: "slack:C1:th" }));
    await store!.put(record("t-mid", NOW - 1000, { threadKey: "slack:C1:th" }));
    await store!.put(record("x-other", NOW - 500, { threadKey: "slack:C1:other" }));
    const { id } = reg.create("general · follow-up", {
      agent: "general",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:th",
    });
    const all = await svc.listRuns({ visibleTo: ALL, status: "all", threadKey: "slack:C1:th" });
    expect(all.runs.map((r) => r.id)).toEqual([id, "t-mid", "t-old"]);
    const newest = await svc.listRuns({ visibleTo: ALL, status: "all", threadKey: "slack:C1:th", limit: 1 });
    expect(newest.runs.map((r) => r.id)).toEqual([id]);
    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished", threadKey: "slack:C1:th" });
    expect(finished.runs.map((r) => r.id)).toEqual(["t-mid", "t-old"]);
    const none = await svc.listRuns({ visibleTo: ALL, status: "all", threadKey: "slack:C1:none" });
    expect(none.runs).toEqual([]);
  });

  it("a live run's provisional interrupted tombstone never surfaces: the run lists as live under `all`, is absent from `finished`, and getRun serves the live row", async () => {
    const { reg, svc, store } = setup();
    const { id } = reg.create("coding · acme/x", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:x",
    });
    reg.publish(id, { type: "input", messageId: "m1", text: "go" });
    // The start-of-run tombstone: terminal in the store while the run is live.
    await store!.put(
      record(id, NOW, {
        status: "interrupted",
        startedAt: NOW,
        events: [{ type: "input", messageId: "m1", text: "go", seq: 1 }],
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

  // run-history item 27: the persisted flag reaches every store-only reader's view.
  it("a stored provisional tombstone's flag rides the view: listRuns and getRun carry `provisional: true`, and a final record's view carries no key", async () => {
    const { svc, store } = setup(); // an empty registry = a store-only reader
    await store!.put(record("tomb", NOW, { status: "interrupted", startedAt: NOW, provisional: true }));
    await store!.put(record("done", NOW - 1, { status: "completed" }));
    const finished = await svc.listRuns({ visibleTo: ALL, status: "finished" });
    expect(finished.runs.find((r) => r.id === "tomb")?.provisional).toBe(true);
    expect("provisional" in finished.runs.find((r) => r.id === "done")!).toBe(false);
    const got = await svc.getRun("tomb");
    expect(got.ok && got.value.provisional).toBe(true);
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
    reg.publish(id, { type: "input", messageId: "m1", text: "go" });
    reg.finish(id);
    reg.seal(id, { replyOk: true });
    await store!.put(
      record(id, NOW + 1, {
        ...meta,
        label: "coding · acme/x",
        startedAt: NOW,
        stepCount: 1,
        schema: 2, // as the record writer stamps it; the live row carries the same
        events: [{ type: "input", messageId: "m1", text: "go", seq: 1 }],
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
      abandoned: () => {},
      get: vi.fn(async () => null),
      getSummary: vi.fn(async () => null),
      list: vi.fn(async (opts) => rows.slice(0, Math.min(200, opts.limit ?? 50))),
      events: vi.fn(async () => ({ events: [] })),
      delete: vi.fn(),
      usage: vi.fn(async () => ({ rows: [], pending: 0, retentionDays: 0 })),
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
      abandoned: () => {},
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
      usage: vi.fn(async () => ({ rows: [], pending: 0, retentionDays: 0 })),
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
      { type: "input", messageId: "m1", text: "do the far thing", at: NOW - 5_000, seq: 1 },
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

  it("getRun, getRunEvents and getRunFriction answer for a ledger row: the view (with the events on a messages read, stamped with the span schema — a ledger run is always timed), a seq page, a live diagnosis", async () => {
    const { svc, ledger } = ledgerSetup();
    await farRun(ledger);
    const view = await svc.getRun("far-1");
    expect(view.ok && view.value).toMatchObject({
      id: "far-1",
      finished: false,
      ownerGen: "g-OTHER",
      eventCount: 2,
      schema: 2,
    });
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

  // record 0060 (run-history item 29): a ship parent is claimed under the host
  // key while its metadata names the thread — every surface lists it under its
  // conversation, marked hosted, with the label the registry gave it.
  it("lists a ledger row claimed under the host key under its conversation's threadKey, with hosted and its label; a registry row created with meta.hosted lists the same", async () => {
    const { svc, reg, ledger } = ledgerSetup();
    await ledger.claim({
      runId: "host-1",
      threadKey: "web:s:c9#host",
      gen: "g-OTHER",
      leaseMs: 30_000,
      startedAt: NOW - 5_000,
      meta: {
        channelId: "web:s",
        userId: "access:u1",
        threadKey: "web:s:c9",
        agent: "ship",
        hosted: true,
        label: "ship · acme/api",
      },
      card: null,
      system: "",
      tools: [],
    });
    const far = await svc.listRuns({ visibleTo: ALL, status: "active", threadKey: "web:s:c9" });
    expect(far.runs.map((r) => r.id)).toEqual(["host-1"]);
    expect(far.runs[0]).toMatchObject({ hosted: true, label: "ship · acme/api", threadKey: "web:s:c9" });
    // Nothing lists under the host key itself: the key column is the ledger's alone.
    expect((await svc.listRuns({ visibleTo: ALL, status: "active", threadKey: "web:s:c9#host" })).runs).toEqual([]);

    const { id } = reg.create("ship · acme/api", {
      agent: "ship",
      channelId: "web:s",
      userId: "access:u1",
      threadKey: "web:s:c8",
      hosted: true,
    });
    const near = await svc.listRuns({ visibleTo: ALL, status: "active", threadKey: "web:s:c8" });
    expect(near.runs.map((r) => r.id)).toEqual([id]);
    expect(near.runs[0]).toMatchObject({ hosted: true, label: "ship · acme/api" });
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
          { type: "input", messageId: "m1", text: "x", seq: 1 },
          ...Array.from({ length: 50 }, (_, i) => ({ ...call(`$ ${i}`), seq: i + 2 })),
        ],
      }),
    );
    const store: RunStore = {
      put: (r) => inner.put(r),
      abandoned: () => {},
      get: vi.fn((id: string) => inner.get(id)),
      getSummary: vi.fn((id: string) => inner.getSummary(id)),
      list: (o) => inner.list(o),
      events: (id, o) => inner.events(id, o),
      delete: (id) => inner.delete(id),
      usage: (q) => inner.usage(q),
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
    // A finished run's window is its own stamps (docs/reference/specs/tracing.md).
    expect(analyze).toHaveBeenCalledWith([expect.objectContaining({ seq: 1 })], {
      finished: true,
      truncated: false,
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

describe("RunsService — the pull request on the record (run-history item 2)", () => {
  const pr = { number: 7, url: "https://github.com/acme/api/pull/7" };

  it("a persisted row carries the PR its record names, and a finished row still in the registry gets it from the store the moment the record lands", async () => {
    const inner = new InMemoryRunStore({ now: () => NOW });
    const { reg, tick } = testRegistry();
    const svc = createRunsService({ registry: reg, store: inner });
    await inner.put(record("p1", NOW - DAY, { agent: "coding", repo: "acme/api", pr }));
    const persisted = await svc.getRun("p1");
    expect(persisted.ok && persisted.value.pr).toEqual(pr);
    const listed = await svc.listRuns({ status: "all", visibleTo: { kind: "all" }, limit: 50 });
    expect(listed.runs.find((r) => r.id === "p1")?.pr).toEqual(pr);

    const run = reg.create("coding · acme/api", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
    });
    tick(5_000);
    reg.finish(run.id, "completed");
    await inner.put(record(run.id, NOW + 5_000, { startedAt: NOW, status: "completed", agent: "coding", pr }));
    const finished = await svc.getRun(run.id);
    expect(finished.ok && finished.value).toMatchObject({ id: run.id, finished: true, pr });
  });
});

// docs/reference/specs/agent-ship.md item 17 and agent-conductor.md item 11: the
// unit is the reading unit — a ship unit's runs in round order from one read,
// a conductor's children as the same listing — under the reader's predicate.
describe("RunsService.listUnitRuns — a unit's runs in round order", () => {
  const T0 = NOW - 100_000;
  const instance: CoordinatorInstance = {
    id: "plan-p-1",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:parent",
    repo: "acme/api",
    branch: "plan/p/u1",
    createdAt: T0 - 1_000,
  };
  /** Round 0 is the coding round; review round n and its findings step share n — the runner's own vocabulary. */
  const rounds: CoordinatorUnit["rounds"] = [
    { index: 0, agent: "coding", outcome: "started", at: T0 },
    { index: 0, agent: "coding", outcome: "pr_opened", at: T0 + 10_000 },
    { index: 1, agent: "review", outcome: "started", at: T0 + 11_000 },
    { index: 1, agent: "review", outcome: "request_changes", at: T0 + 20_000 },
    { index: 1, agent: "coding", outcome: "started", at: T0 + 21_000 },
    { index: 1, agent: "coding", outcome: "completed", at: T0 + 30_000 },
    { index: 2, agent: "review", outcome: "started", at: T0 + 31_000 },
    { index: 2, agent: "review", outcome: "approve", at: T0 + 40_000 },
  ];
  const u1: CoordinatorUnit = {
    instanceId: "plan-p-1",
    unit: "U16",
    slug: "u1",
    branch: "plan/p/u1",
    dependsOn: [],
    threadKey: "slack:C1:u1",
    reviewThread: { threadKey: "slack:C1:u1r" },
    rounds,
  };
  const u2: CoordinatorUnit = {
    instanceId: "plan-p-1",
    unit: "U17",
    slug: "u2",
    branch: "plan/p/u2",
    dependsOn: ["U16"],
    rounds: [],
  };
  const CHANNEL_C2: Predicate = { kind: "channels-in", channelIds: new Set(["slack:C2"]) };
  const CHANNEL_C1: Predicate = { kind: "channels-in", channelIds: new Set(["slack:C1"]) };
  const PUBLIC: Predicate = { kind: "visibility-in", visibilities: new Set(["public"]) };

  async function world(units: CoordinatorUnit[] = [u1, u2]) {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance);
    await instances.putUnits(units);
    const store = new InMemoryRunStore({ now: () => NOW });
    const inThread = (id: string, threadKey: string, agent: string, startedAt: number) =>
      record(id, startedAt + 5_000, { threadKey, agent, startedAt, channelVisibility: "public" });
    await store.put(inThread("c0", "slack:C1:u1", "coding", T0 + 1_000));
    await store.put(inThread("r1", "slack:C1:u1r", "review", T0 + 12_000));
    await store.put(inThread("c1", "slack:C1:u1", "coding", T0 + 22_000));
    await store.put(inThread("r2", "slack:C1:u1r", "review", T0 + 32_000));
    // The requesting thread's own past and the pipeline's record: never a round's run.
    await store.put(inThread("before", "slack:C1:u1", "general", T0 - 50_000));
    await store.put(record("ship", T0 + 50_000, { threadKey: "slack:C1:u1", agent: "ship", startedAt: T0 - 1_000 }));
    // A findings run in flight in the coding thread, after round 1's boundary.
    const { reg } = testRegistry({ now: () => T0 + 41_000 });
    const live = reg.create("coding · live", {
      agent: "coding",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:u1",
      channelVisibility: "public",
    });
    const svc = createRunsService({ registry: reg, store, units: instances });
    return { svc, instances, store, live };
  }

  it("a unit with two rounds lists coding 0, review 1, coding 1, review 2 in time order, each run with its round and thread and every field of its view, the run in flight last with its round; the view names the threads and the row's boundaries", async () => {
    const { svc, live } = await world();
    const res = await svc.listUnitRuns("plan-p-1:U16", ALL);
    if (!res.ok) throw new Error("expected the listing");
    expect(res.value.runs.map((r) => [r.id, r.round, r.thread, r.finished])).toEqual([
      ["c0", 0, "coding", true],
      ["r1", 1, "review", true],
      ["c1", 1, "coding", true],
      ["r2", 2, "review", true],
      [live.id, 1, "coding", false],
    ]);
    expect(res.value.runs[0]).toMatchObject({
      agent: "coding",
      threadKey: "slack:C1:u1",
      persisted: true,
      status: "completed",
    });
    expect(res.value).toMatchObject({
      unit: "plan-p-1:U16",
      instanceId: "plan-p-1",
      threads: { coding: "slack:C1:u1", review: "slack:C1:u1r" },
      rounds,
    });
    expectNoToken(res.value);
  });

  it("the view carries the row's readable facts and its instance's — the plan's title, branch, pull request, where the threads open, how it ended; the instance's repository, plan, attempt and parent record — and never the requester's ids", async () => {
    const withFacts: CoordinatorUnit = {
      ...u1,
      title: "The unit page",
      sourceUrl: "https://example.slack.com/archives/C1/p10",
      reviewThread: { threadKey: "slack:C1:u1r", sourceUrl: "https://example.slack.com/archives/C1/p11" },
      pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
      issue: 7,
      ending: { kind: "merge_ready", report: "✅ Merge-ready after 2 review rounds", at: T0 + 40_000 },
      startedAt: T0,
    };
    const { svc, instances } = await world([withFacts, u2]);
    await instances.replace({
      ...instance,
      plan: { id: "p", path: "docs/plans/p.md" },
      attempt: 2,
      label: "*ship* · acme/api · the plan",
      runId: "parent-run",
      base: "main",
    });
    await instances.putUnits([withFacts, u2]);
    const res = await svc.listUnitRuns("plan-p-1:U16", ALL);
    if (!res.ok) throw new Error("expected the listing");
    const { runs, ...facts } = res.value;
    expect(runs).toHaveLength(5);
    expect(facts).toEqual({
      unit: "plan-p-1:U16",
      instanceId: "plan-p-1",
      id: "U16",
      title: "The unit page",
      branch: "plan/p/u1",
      threads: { coding: "slack:C1:u1", review: "slack:C1:u1r" },
      sourceUrls: {
        coding: "https://example.slack.com/archives/C1/p10",
        review: "https://example.slack.com/archives/C1/p11",
      },
      pr: { number: 42, url: "https://github.com/acme/api/pull/42" },
      issue: 7,
      rounds,
      ending: { kind: "merge_ready", report: "✅ Merge-ready after 2 review rounds", at: T0 + 40_000 },
      startedAt: T0,
      instance: {
        id: "plan-p-1",
        repo: "acme/api",
        base: "main",
        plan: { id: "p", path: "docs/plans/p.md" },
        attempt: 2,
        label: "*ship* · acme/api · the plan",
        runId: "parent-run",
        createdAt: T0 - 1_000,
      },
    });
    expect(JSON.stringify(facts)).not.toContain("UALICE");
  });

  it("a unit whose review thread does not exist yet lists the coding thread alone, and names no review thread", async () => {
    const { svc } = await world([{ ...u1, reviewThread: undefined, rounds: rounds.slice(0, 2) }]);
    const res = await svc.listUnitRuns("plan-p-1:U16", ALL);
    if (!res.ok) throw new Error("expected the listing");
    expect(res.value.runs.map((r) => [r.id, r.round, r.thread])).toEqual([
      ["c0", 0, "coding"],
      ["c1", 0, "coding"],
      [expect.stringMatching(/^id-/), 0, "coding"],
    ]);
    expect(res.value.threads).toEqual({ coding: "slack:C1:u1" });
  });

  it("a unit not started lists nothing and names no thread; an unknown unit, a malformed key and a process without the coordinator's records are not_found", async () => {
    const { svc, store } = await world();
    expect(await svc.listUnitRuns("plan-p-1:U17", ALL)).toEqual({
      ok: true,
      value: {
        unit: "plan-p-1:U17",
        instanceId: "plan-p-1",
        id: "U17",
        branch: "plan/p/u2",
        threads: {},
        sourceUrls: {},
        rounds: [],
        instance: { id: "plan-p-1", repo: "acme/api", createdAt: T0 - 1_000 },
        runs: [],
      },
    });
    expect(await svc.listUnitRuns("plan-p-1:U77", ALL)).toEqual({ ok: false, error: "not_found" });
    expect(await svc.listUnitRuns("plan-p-9:U16", ALL)).toEqual({ ok: false, error: "not_found" });
    expect(await svc.listUnitRuns("nonsense", ALL)).toEqual({ ok: false, error: "not_found" });
    const { reg } = testRegistry();
    expect(await createRunsService({ registry: reg, store }).listUnitRuns("plan-p-1:U16", ALL)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("a reader outside the predicate is told not_found, byte-identical to an unknown unit — another channel's reader, another user's — while a reader who may see any run of the unit sees the whole listing, and a unit not started yet follows its requester's channel", async () => {
    const { svc } = await world();
    expect(await svc.listUnitRuns("plan-p-1:U16", CHANNEL_C2)).toEqual({ ok: false, error: "not_found" });
    expect(await svc.listUnitRuns("plan-p-1:U16", { kind: "user-is", userId: "slack:UBOB" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await svc.listUnitRuns("plan-p-1:U16", { kind: "none" })).toEqual({ ok: false, error: "not_found" });
    for (const visibleTo of [CHANNEL_C1, PUBLIC, { kind: "user-is", userId: "slack:UALICE" } as Predicate]) {
      const res = await svc.listUnitRuns("plan-p-1:U16", visibleTo);
      expect(res.ok && res.value.runs).toHaveLength(5);
    }
    // No run yet: the requester's channel decides, and nothing else — a public-only
    // reader is told not_found until the first run carries the channel's stamp.
    expect((await svc.listUnitRuns("plan-p-1:U17", CHANNEL_C1)).ok).toBe(true);
    expect(await svc.listUnitRuns("plan-p-1:U17", CHANNEL_C2)).toEqual({ ok: false, error: "not_found" });
    expect(await svc.listUnitRuns("plan-p-1:U17", PUBLIC)).toEqual({ ok: false, error: "not_found" });
  });

  // agent-ship item 17: the parent record's page lists the instance's units.
  it("listInstanceUnits answers the instance's unit rows as their facts in the plan's order for a reader its requester's channel admits, and nothing for another channel's reader, an unknown instance, a `none` predicate or a process without the coordinator's records", async () => {
    const { svc, store } = await world();
    const facts = await svc.listInstanceUnits("plan-p-1", ALL);
    expect(facts.map((f) => [f.unit, f.id, f.branch, f.threads])).toEqual([
      ["plan-p-1:U16", "U16", "plan/p/u1", { coding: "slack:C1:u1", review: "slack:C1:u1r" }],
      ["plan-p-1:U17", "U17", "plan/p/u2", {}],
    ]);
    expect(facts[0]).toEqual({
      unit: "plan-p-1:U16",
      instanceId: "plan-p-1",
      id: "U16",
      branch: "plan/p/u1",
      threads: { coding: "slack:C1:u1", review: "slack:C1:u1r" },
      sourceUrls: {},
      rounds,
    });
    expect((await svc.listInstanceUnits("plan-p-1", CHANNEL_C1)).map((f) => f.id)).toEqual(["U16", "U17"]);
    expect(await svc.listInstanceUnits("plan-p-1", CHANNEL_C2)).toEqual([]);
    expect(await svc.listInstanceUnits("plan-p-1", PUBLIC)).toEqual([]);
    expect(await svc.listInstanceUnits("plan-p-1", { kind: "none" })).toEqual([]);
    expect(await svc.listInstanceUnits("plan-p-9", ALL)).toEqual([]);
    const { reg } = testRegistry();
    expect(await createRunsService({ registry: reg, store }).listInstanceUnits("plan-p-1", ALL)).toEqual([]);
  });
});

describe("RunsService.listFindings — a pull request's findings ledger from the records (agent-ship item 18)", () => {
  const T0 = NOW - 100_000;
  const PR = { repo: "acme/api", number: 42 };
  const URL = "https://github.com/acme/api/pull/42";
  const HEAD_A = "a".repeat(40);
  const HEAD_B = "b".repeat(40);
  const instance: CoordinatorInstance = {
    id: "plan-p-1",
    kind: "ship",
    userId: "slack:UALICE",
    channelId: "slack:C1",
    threadKey: "slack:C1:parent",
    repo: "acme/api",
    branch: "plan/p/u1",
    createdAt: T0 - 1_000,
  };
  const unit: CoordinatorUnit = {
    instanceId: "plan-p-1",
    unit: "U16",
    slug: "u1",
    branch: "plan/p/u1",
    dependsOn: [],
    threadKey: "slack:C1:u1",
    reviewThread: { threadKey: "slack:C1:u1r" },
    pr: { number: 42, url: URL },
    rounds: [
      { index: 0, agent: "coding", outcome: "started", at: T0 },
      { index: 1, agent: "review", outcome: "started", at: T0 + 11_000 },
      { index: 1, agent: "coding", outcome: "started", at: T0 + 21_000 },
      { index: 2, agent: "review", outcome: "started", at: T0 + 31_000 },
    ],
  };
  const child = (step: string): Partial<RunRecord> => ({
    parentInstanceId: "plan-p-1",
    idempotencyKey: `plan-p-1:U16/${step}`,
  });
  const F1 = { id: "F1", severity: "major" as const, file: "src/a.ts", line: 12, title: "null path unguarded" };
  const F2 = { id: "F2", severity: "nit" as const, file: "src/b.ts", title: "typo in a comment" };
  const inThread = (id: string, threadKey: string, agent: string, startedAt: number, over: Partial<RunRecord> = {}) =>
    record(id, startedAt + 5_000, {
      threadKey,
      agent,
      startedAt,
      repo: "acme/api",
      channelVisibility: "public",
      ...over,
    });

  /** A ship unit through two review rounds, as the records tell it: the coding
   *  round opened the pull request; review 1 raised two findings and posted;
   *  the findings step answered both and edited the pull request; review 2
   *  re-raised one — and its post was skipped, so only its thread names it. */
  async function world(opts: { units?: boolean; store?: InMemoryRunStore } = {}) {
    const instances = new InMemoryCoordinatorInstanceStore();
    await instances.put(instance);
    await instances.putUnits([unit]);
    const store = opts.store ?? new InMemoryRunStore({ now: () => NOW });
    await store.put(
      inThread("c0", "slack:C1:u1", "coding", T0 + 1_000, { pr: { number: 42, url: URL }, ...child("0/coding") }),
    );
    await store.put(
      inThread("r1", "slack:C1:u1r", "review", T0 + 12_000, {
        verdict: { verdict: "request_changes", summary: "two things", head: HEAD_A, findings: [F1, F2] },
        reviewHead: HEAD_A,
        reviewPost: {
          posted: true,
          target: { repo: "acme/api", number: 42 },
          head: HEAD_A,
          verdict: "request_changes",
        },
        ...child("1/review"),
      }),
    );
    await store.put(
      inThread("c1", "slack:C1:u1", "coding", T0 + 22_000, {
        pr: { number: 42, url: URL, head: "plan/p/u1" },
        dispositions: [
          { findingId: "F1", disposition: "fixed", note: "guarded the null path" },
          { findingId: "F2", disposition: "declined", note: "the comment quotes the library" },
        ],
        ...child("1/findings"),
      }),
    );
    await store.put(
      inThread("r2", "slack:C1:u1r", "review", T0 + 32_000, {
        verdict: {
          verdict: "request_changes",
          summary: "one stays",
          head: HEAD_B,
          findings: [{ ...F1, title: "the guard moved but the null path stays" }],
        },
        reviewHead: HEAD_B,
        reviewPost: { posted: false, reason: "head moved" },
        ...child("2/review"),
      }),
    );
    // Not the pull request's: another pull request on the repository, the same number elsewhere, the thread's past.
    await store.put(
      inThread("other", "slack:C1:o", "coding", T0 + 40_000, {
        pr: { number: 43, url: "https://github.com/acme/api/pull/43" },
      }),
    );
    await store.put(
      inThread("elsewhere", "slack:C1:e", "coding", T0 + 41_000, {
        repo: "acme/web",
        pr: { number: 42, url: "https://github.com/acme/web/pull/42" },
      }),
    );
    await store.put(inThread("before", "slack:C1:u1", "general", T0 - 50_000));
    const { reg } = testRegistry();
    const svc = createRunsService({ registry: reg, store, ...(opts.units === false ? {} : { units: instances }) });
    return { svc, store, instances };
  }

  it("joins the runs that name the pull request with the unit's runs — each with its round, a review whose post was skipped reached through its thread — and answers the unit, the url, the runs oldest first and one row per finding id", async () => {
    const { svc } = await world();
    const res = await svc.listFindings(PR, ALL);
    if (!res.ok) throw new Error("expected the ledger");
    expect(res.value.repo).toBe("acme/api");
    expect(res.value.pr).toEqual({ number: 42, url: URL });
    expect(res.value.unit).toBe("plan-p-1:U16");
    expect(res.value.runs).toEqual([
      { id: "c0", agent: "coding", startedAt: T0 + 1_000, finishedAt: T0 + 6_000, round: 0 },
      {
        id: "r1",
        agent: "review",
        startedAt: T0 + 12_000,
        finishedAt: T0 + 17_000,
        head: HEAD_A,
        round: 1,
        verdict: "request_changes",
        findings: 2,
      },
      { id: "c1", agent: "coding", startedAt: T0 + 22_000, finishedAt: T0 + 27_000, round: 1, dispositions: 2 },
      {
        id: "r2",
        agent: "review",
        startedAt: T0 + 32_000,
        finishedAt: T0 + 37_000,
        head: HEAD_B,
        round: 2,
        verdict: "request_changes",
        findings: 1,
      },
    ]);
    expect(res.value.findings).toEqual([
      {
        id: "F1",
        severity: "major",
        file: "src/a.ts",
        line: 12,
        title: "the guard moved but the null path stays",
        raised: { runId: "r1", head: HEAD_A, round: 1 },
        lastSeen: { runId: "r2", head: HEAD_B, round: 2 },
        disposition: { kind: "fixed", note: "guarded the null path", runId: "c1", round: 1 },
        status: "re-raised",
        reRaisedAfter: "fixed",
      },
      {
        id: "F2",
        severity: "nit",
        file: "src/b.ts",
        title: "typo in a comment",
        raised: { runId: "r1", head: HEAD_A, round: 1 },
        lastSeen: { runId: "r1", head: HEAD_A, round: 1 },
        disposition: { kind: "declined", note: "the comment quotes the library", runId: "c1", round: 1 },
        status: "conceded",
      },
    ]);
    expectNoToken(res.value);
    expect(JSON.stringify(res.value)).not.toContain("UALICE");
  });

  it("without the coordinator's records the ledger is read from the records alone — no unit, no rounds, and the review that posted nothing is absent", async () => {
    const { svc } = await world({ units: false });
    const res = await svc.listFindings(PR, ALL);
    if (!res.ok) throw new Error("expected the ledger");
    expect(res.value.unit).toBeUndefined();
    expect(res.value.runs.map((r) => [r.id, r.round])).toEqual([
      ["c0", undefined],
      ["r1", undefined],
      ["c1", undefined],
    ]);
    expect(res.value.findings.map((r) => [r.id, r.status, r.raised?.round])).toEqual([
      ["F1", "awaiting re-review", undefined],
      ["F2", "awaiting re-review", undefined],
    ]);
  });

  it("only runs the reader may see enter the join: a reader admitted to the public runs alone reads a ledger without the private review — its findings first raised by the later review, its dispositions answering ids no review it saw issued", async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    const { svc } = await world({ store });
    const r1 = (await store.get("r1"))!;
    await store.put({ ...r1, channelVisibility: "private" });
    const PUBLIC: Predicate = { kind: "visibility-in", visibilities: new Set(["public"]) };
    const res = await svc.listFindings(PR, PUBLIC);
    if (!res.ok) throw new Error("expected the ledger");
    expect(res.value.runs.map((r) => r.id)).toEqual(["c0", "c1", "r2"]);
    expect(res.value.findings.map((r) => [r.id, r.status, r.raised?.runId, r.disposition])).toEqual([
      ["F1", "open", "r2", undefined],
      [
        "F2",
        "unknown id",
        undefined,
        { kind: "declined", note: "the comment quotes the library", runId: "c1", round: 1 },
      ],
    ]);
  });

  it("is not_found — one answer — for a pull request no run names, a reader outside every run that names it, a `none` predicate, and another repository's same number", async () => {
    const { svc } = await world();
    expect(await svc.listFindings({ repo: "acme/api", number: 99 }, ALL)).toEqual({ ok: false, error: "not_found" });
    const C2: Predicate = { kind: "channels-in", channelIds: new Set(["slack:C2"]) };
    expect(await svc.listFindings(PR, C2)).toEqual({ ok: false, error: "not_found" });
    expect(await svc.listFindings(PR, { kind: "none" })).toEqual({ ok: false, error: "not_found" });
    const web = await svc.listFindings({ repo: "acme/web", number: 42 }, ALL);
    if (!web.ok) throw new Error("expected the ledger");
    expect(web.value.runs.map((r) => r.id)).toEqual(["elsewhere"]);
    expect(web.value.findings).toEqual([]);
  });

  it("the pull request rides down to the store as its own filter beside the predicate — nothing is loaded to be dropped afterwards", async () => {
    const { svc, store } = await world();
    const list = vi.spyOn(store, "list");
    const C1: Predicate = { kind: "channels-in", channelIds: new Set(["slack:C1"]) };
    const res = await svc.listFindings(PR, C1);
    expect(res.ok).toBe(true);
    expect(list.mock.calls[0][0]).toMatchObject({
      pr: { repo: "acme/api", number: 42 },
      visibleTo: { kind: "channels-in", channelIds: ["slack:C1"] },
    });
  });
});

describe("RunsService.listChildren — a conductor's children in start order", () => {
  it("lists the runs naming the parent — persisted and live — oldest started first, under the predicate, the store asked with the parent as its own filter; a run with no children, a reader outside the predicate and a `none` predicate are an empty list", async () => {
    const { reg } = testRegistry({ now: () => NOW - 1_000 });
    const store = new InMemoryRunStore({ now: () => NOW });
    await store.put(record("k1", NOW - 20_000, { parentRunId: "P", startedAt: NOW - 30_000 }));
    await store.put(record("k2", NOW - 5_000, { parentRunId: "P", startedAt: NOW - 50_000 }));
    await store.put(record("other", NOW - 3_000, { parentRunId: "Q" }));
    const live = reg.create("research · child", {
      agent: "research",
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:k3",
      parentRunId: "P",
    });
    const list = vi.spyOn(store, "list");
    const svc = createRunsService({ registry: reg, store });
    const children = await svc.listChildren("P", ALL);
    expect(children.map((r) => [r.id, r.finished, r.parentRunId])).toEqual([
      ["k2", true, "P"],
      ["k1", true, "P"],
      [live.id, false, "P"],
    ]);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ parentRunId: "P" }));
    expectNoToken(children);
    expect(await svc.listChildren("none", ALL)).toEqual([]);
    expect(await svc.listChildren("Q", { kind: "channels-in", channelIds: new Set(["slack:C2"]) })).toEqual([]);
    expect(await svc.listChildren("P", { kind: "none" })).toEqual([]);
    // `runs list --parent`'s filter is the same one, newest first as every listing is.
    const listed = await svc.listRuns({ status: "all", visibleTo: ALL, parentRunId: "P" });
    expect(listed.runs.map((r) => r.id)).toEqual([live.id, "k2", "k1"]);
  });
});

// docs/reference/specs/session-log.md item 11: a person's search over one
// session's log — the read `recall` makes — under the reader's predicate.
describe("RunsService.searchSession — a person's search over one session's log", () => {
  const KEY = "slack:C1:s:coding";
  const say = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });
  const reply = (text: string): ChatMessage => ({ role: "assistant", content: [{ type: "text", text }] });
  const failed: ChatMessage = {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "c1", content: "1 failed: lockfile.test.ts" }],
  };

  async function world() {
    const ledger = new InMemoryRunLedger(() => NOW);
    await ledger.claimSession(KEY, "run-a", "g1");
    await ledger.seed(
      "run-a",
      "g1",
      [
        say("please fix the flaky lockfile test"),
        reply("the lockfile is fine"),
        say(GAP_MARKER),
        failed,
        say("unrelated remark"),
      ].map((message, idx) => ({ idx, message })),
      KEY,
    );
    const store = new InMemoryRunStore({ now: () => NOW });
    // Two runs of the session: the first wrote turns 0–1, the second (after a
    // detach the marker at 2 names) turns 2–4.
    await store.put(
      record("run-a", NOW - 20_000, {
        threadKey: "slack:C1:s",
        agent: "coding",
        session: { key: KEY, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
      }),
    );
    await store.put(
      record("run-b", NOW - 10_000, {
        threadKey: "slack:C1:s",
        agent: "coding",
        session: { key: KEY, seedFrom: 0, request: 3, range: { from: 2, to: 4 } },
      }),
    );
    const { reg } = testRegistry();
    const svc = createRunsService({ registry: reg, store, sessions: ledger });
    return { svc, ledger, store, reg };
  }

  it("answers the matching turns in relevance order, each with its role, a one-line snippet and the run whose range holds it, the gap markers the hits straddle, and on a hit past a marker the marker's turn; `limit` caps the hits", async () => {
    const { svc } = await world();
    expect(await svc.searchSession(KEY, "flaky lockfile", 5, ALL)).toEqual({
      session: KEY,
      hits: [
        { turn: 0, role: "user", snippet: "please fix the flaky lockfile test", runId: "run-a" },
        { turn: 3, role: "user", snippet: "1 failed: lockfile.test.ts", runId: "run-b", gap: 2 },
        { turn: 1, role: "assistant", snippet: "the lockfile is fine", runId: "run-a" },
      ],
      gaps: [2],
    });
    expect((await svc.searchSession(KEY, "flaky lockfile", 1, ALL)).hits).toHaveLength(1);
    expect(await svc.searchSession(KEY, "unrelated", 5, ALL)).toEqual({
      session: KEY,
      hits: [{ turn: 4, role: "user", snippet: "unrelated remark", runId: "run-b" }],
      gaps: [],
    });
  });

  it("a reader outside the predicate, a session nobody ran, a key that is not one and a process without a ledger all search empty — one answer, and the log is never asked for a reader it is not for", async () => {
    const { svc, ledger, store, reg } = await world();
    const search = vi.spyOn(ledger, "searchSession");
    const empty = { session: KEY, hits: [], gaps: [] };
    expect(
      await svc.searchSession(KEY, "flaky", 5, { kind: "channels-in", channelIds: new Set(["slack:C2"]) }),
    ).toEqual(empty);
    expect(await svc.searchSession(KEY, "flaky", 5, { kind: "user-is", userId: "slack:UBOB" })).toEqual(empty);
    expect(await svc.searchSession(KEY, "flaky", 5, { kind: "none" })).toEqual(empty);
    expect(await svc.searchSession("slack:C1:none:coding", "flaky", 5, ALL)).toEqual({
      ...empty,
      session: "slack:C1:none:coding",
    });
    expect(await svc.searchSession("nonsense", "flaky", 5, ALL)).toEqual({ ...empty, session: "nonsense" });
    expect(search).not.toHaveBeenCalled();
    // The thread's runs of another agent are another session: `slack:C1:s:review` has none.
    expect(await svc.searchSession("slack:C1:s:review", "flaky", 5, ALL)).toEqual({
      ...empty,
      session: "slack:C1:s:review",
    });
    expect(await createRunsService({ registry: reg, store }).searchSession(KEY, "flaky", 5, ALL)).toEqual(empty);
    // A reader who may see the session's runs is answered.
    expect((await svc.searchSession(KEY, "flaky", 5, { kind: "user-is", userId: "slack:UALICE" })).hits).toHaveLength(
      1,
    );
  });
});

// Feature: record 0051 R2 (run-history item 2) — the view exposes the plan
// runner instance a ship run's hand-off created, off the record's projection.
describe("RunView.instanceId — the ship run's instance (record 0051 R2)", () => {
  it("a persisted ship record carries instanceId on the view — the get and the thread's list alike — and a record written before the event has none", async () => {
    const { reg, tick } = testRegistry();
    const store = new InMemoryRunStore({ now: () => NOW });
    const svc = createRunsService({ registry: reg, store });
    await store.put(record("r-ship", NOW - DAY, { agent: "ship", instanceId: "plan-fix-login-6435ec" }));
    await store.put(record("r-old", NOW - 2 * DAY, { agent: "ship" }));
    tick(1);
    const view = await svc.getRun("r-ship");
    expect(view.ok && view.value.instanceId).toBe("plan-fix-login-6435ec");
    const listed = await svc.listRuns({ status: "all", visibleTo: ALL, threadKey: "slack:C1:r-ship" });
    expect(listed.runs[0]?.instanceId).toBe("plan-fix-login-6435ec");
    const old = await svc.getRun("r-old");
    expect(old.ok && "instanceId" in old.value).toBe(false);
  });
});
