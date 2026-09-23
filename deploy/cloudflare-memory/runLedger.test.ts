import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../src/core/runRecord.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";
import type { CoordinatorInstance, CoordinatorUnit } from "../../src/core/coordinator/contract.ts";
import { assertNoPendingBackgroundTasks } from "./backgroundTasks.ts";
import type { RunHistoryDO, SessionLogDO } from "./worker.ts";

// Feature: docs/reference/specs/run-history.md items 28–34 — the live-run ledger on the
// RunHistoryDO: claim (one live run per thread), the fence on every owner
// write, step records, the inbox, stop, handoff, finishing, finish in one
// transaction, reclaim. Runs in workerd against the real SQLite object; a
// unique store key per test.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

let n = 0;
const storeKey = () => `runs:ledger-${Date.now()}-${n++}`;

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
  byCategory: Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, ZERO])) as RunRecord["diagnosis"]["byCategory"],
  findings: [],
  verdict: "no friction detected",
});

function record(id: string, threadKey: string): RunRecord {
  return {
    id,
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey,
    channelVisibility: "unknown",
    // Inside the retention window, or the finished record is trimmed on write.
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 1_000,
    status: "completed",
    eventCount: 1,
    storedEventCount: 1,
    truncated: false,
    events: [{ type: "tool_call", tool: "bash", summary: "ls", seq: 1 }],
    diagnosis: diagnosis(),
  };
}

const claimBody = (key: string, runId: string, threadKey: string, gen = "g1", over: Record<string, unknown> = {}) => ({
  storeKey: key,
  run: {
    runId,
    threadKey,
    gen,
    leaseMs: LEASE_MS,
    startedAt: 1_000,
    meta: { agent: "review", channelId: "slack:C1", userId: "slack:UALICE", threadKey },
    card: { channel: "C1", ts: "1.0" },
    system: "you review",
    tools: [{ name: "bash", description: "run", inputSchema: {} }],
    ...over,
  },
});

const step = (over: Record<string, unknown> = {}) => ({
  step: 1,
  seq: 10,
  turnIndex: 2,
  inFlight: [{ callId: "c1", tool: "bash" }],
  inboxConsumedSeq: 0,
  remainingMs: 600_000,
  turn: 1,
  iteration: 1,
  ...over,
});

describe("run ledger — claim and admission (item 29)", () => {
  it("claim → 200; a second run on the same thread → 409 thread-live naming the live run; the owner's re-claim is idempotent; /runs/live lists it", async () => {
    const key = storeKey();
    expect(await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    const busy = await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"));
    expect(busy.status).toBe(409);
    expect(busy.data).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r1", agent: "review", startedAt: 1_000 },
    });
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"))).status).toBe(200);
    const live = await post("/runs/live", { storeKey: key });
    expect(live.status).toBe(200);
    const runs = live.data.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "r1",
      threadKey: "slack:C1:1.0",
      ownerGen: "g1",
      phase: "live",
      stop: null,
      card: { channel: "C1", ts: "1.0" },
      system: "you review",
    });
    expect(typeof runs[0].leaseUntil).toBe("number");
    // Live runs are NOT in the finished listing.
    const list = await post("/runs/list", { storeKey: key });
    expect(list.data.items).toEqual([]);
  });

  it("a claim with `phase: attaching` reserves the thread before the prompt exists (item 42): the row lists as attaching with its request and an empty prompt; the owner's later claim with the prompt promotes it to live in place; reclaim keeps an expired attaching row's phase", async () => {
    const key = storeKey();
    const request = {
      channelId: "slack:C1",
      userId: "slack:UA",
      threadKey: "slack:C1:1.0",
      text: "review it",
      at: 900,
    };
    const reserve = claimBody(key, "r1", "slack:C1:1.0", "g1", {
      phase: "attaching",
      system: "",
      tools: [],
      card: null,
      meta: { agent: "review", channelId: "slack:C1", userId: "slack:UA", threadKey: "slack:C1:1.0", request },
    });
    expect(await post("/runs/claim", reserve)).toMatchObject({ status: 200, data: { ok: true } });
    let runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({ runId: "r1", phase: "attaching", system: "", tools: [], card: null });
    expect((runs[0].meta as Record<string, unknown>).request).toEqual(request);
    expect((await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"))).status).toBe(409);
    // The prompt lands: promoted in place, identity and start unchanged.
    expect(await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0", "g1", { state: { n: 1 } }))).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs[0]).toMatchObject({
      runId: "r1",
      phase: "live",
      system: "you review",
      card: { channel: "C1", ts: "1.0" },
      state: { n: 1 },
      startedAt: 1_000,
    });
    // A bad phase is a 400.
    expect((await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { phase: "sleeping" }))).status).toBe(
      400,
    );
    // An expired attaching row is reclaimed as attaching, request and inbox in hand.
    await post(
      "/runs/claim",
      claimBody(key, "r9", "slack:C1:9.0", "g1", { ...reserve.run, runId: "r9", threadKey: "slack:C1:9.0" }),
    );
    await post("/runs/inbox", { storeKey: key, runId: "r9", message: { text: "also this" } });
    const future = Date.now() + LEASE_MS + 1_000;
    const r = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS });
    const taken = (r.data.runs as Array<Record<string, unknown>>).find(
      (x) => (x.row as Record<string, unknown>).runId === "r9",
    )!;
    expect(taken.reclaimedFrom).toBe("attaching");
    expect(taken.row).toMatchObject({ ownerGen: "g2", phase: "attaching" });
    expect(((taken.row as Record<string, unknown>).meta as Record<string, unknown>).request).toEqual(request);
    expect((taken.inbox as Array<{ message: { text: string } }>).map((i) => i.message.text)).toEqual(["also this"]);
    // Abandon: the live rows go with no record; fenced from any other generation; unknown afterwards.
    expect((await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g1" })).status).toBe(409);
    expect(await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g2" })).toMatchObject({
      status: 200,
      data: { ok: true },
    });
    runs = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(runs.map((x) => x.runId)).toEqual(["r1"]);
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r9", afterSeq: 0 })).data.items).toEqual([]);
    expect((await post("/runs/list", { storeKey: key })).data.items).toEqual([]);
    expect((await post("/runs/abandon", { storeKey: key, runId: "r9", gen: "g2" })).status).toBe(409);
  });

  it("validates: a bad run id, gen, lease, or missing fields → 400; no bearer → 401", async () => {
    const key = storeKey();
    expect((await post("/runs/claim", claimBody(key, "bad id!", "t"))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "bad gen!"))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "g1", { leaseMs: 10 }))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t", "g1", { system: undefined }))).status).toBe(400);
    expect((await post("/runs/claim", claimBody(key, "r1", "t"), { "content-type": "application/json" })).status).toBe(
      401,
    );
  });
});

describe("run ledger — the fence (item 28)", () => {
  it("heartbeat, append, step, state, finishing and finish from another generation → 409 fenced; an unknown run → 409 unknown-run", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const fenced = { status: 409, data: { ok: false, reason: "fenced" } };
    expect(await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g2", leaseMs: LEASE_MS })).toEqual(fenced);
    expect(
      await post("/runs/append", {
        storeKey: key,
        runId: "r1",
        gen: "g2",
        events: [{ type: "tool_call", tool: "bash", summary: "x", seq: 1 }],
      }),
    ).toEqual(fenced);
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g2", record: step() })).toEqual(fenced);
    expect(await post("/runs/state", { storeKey: key, runId: "r1", gen: "g2", state: {} })).toEqual(fenced);
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g2" })).toEqual(fenced);
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g2", record: record("r1", "slack:C1:1.0") }),
    ).toEqual(fenced);
    expect(await post("/runs/heartbeat", { storeKey: key, runId: "nope", gen: "g1", leaseMs: LEASE_MS })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown-run" },
    });
  });

  it("the owner's heartbeat extends the lease and reports a stop any generation requested; stop says whether the owner is live", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const before = ((await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>)[0]
      .leaseUntil;
    expect(await post("/runs/stop", { storeKey: key, runId: "r1", mode: "soft" })).toEqual({
      status: 200,
      data: { ok: true, ownerLive: true },
    });
    await new Promise((r) => setTimeout(r, 5));
    const hb = await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    expect(hb).toEqual({ status: 200, data: { ok: true, stop: "soft", phase: "live", effects: [] } });
    const after = ((await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>)[0]
      .leaseUntil;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(await post("/runs/stop", { storeKey: key, runId: "nope", mode: "hard" })).toEqual({
      status: 200,
      data: { ok: false },
    });
  });
});

describe("run ledger — steps, events, inbox, state (items 30–31)", () => {
  it("live-state assignment commits its boundary and projection together, while a pre-commit refusal exposes neither half", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "state-1", "slack:C1:state"));
    const admitted = await post("/runs/live-state", {
      storeKey: key,
      runId: "state-1",
      gen: "g1",
      assignment: { expectedSeq: 0, eventSeq: 1, at: 100, state: "admitted", bound: 1_000 },
    });
    expect(admitted).toMatchObject({
      status: 200,
      data: { ok: true, liveState: { state: "admitted", since: 100, bound: 1_000 }, liveStateSeq: 1 },
    });
    let live = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(live[0]).toMatchObject({
      liveState: { state: "admitted", since: 100, bound: 1_000 },
      liveStateSeq: 1,
    });
    expect((await post("/runs/live-events", { storeKey: key, runId: "state-1" })).data.events).toHaveLength(1);

    expect(
      await post("/runs/live-state", {
        storeKey: key,
        runId: "state-1",
        gen: "g1",
        assignment: {
          expectedSeq: 1,
          at: 200,
          state: "working",
          bound: 900,
          sourceEvents: [{ type: "tool_call", tool: "bash", summary: "x", seq: 1, at: 200 }],
        },
      }),
    ).toEqual({ status: 400, data: { ok: false, reason: "stale-sequence" } });
    live = (await post("/runs/live", { storeKey: key })).data.runs as Array<Record<string, unknown>>;
    expect(live[0]).toMatchObject({
      liveState: { state: "admitted", since: 100, bound: 1_000 },
      liveStateSeq: 1,
    });
    expect((await post("/runs/live-events", { storeKey: key, runId: "state-1" })).data.events).toHaveLength(1);
  });
  it("append lands event rows keyed by seq while the run is live (the finished-runs routes do not see a live run — its events reach them with the finish record); an over-cap event is 400; step records replace by step number", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    const events = [1, 2, 3].map((seq) => ({ type: "tool_call", tool: "bash", summary: `s${seq}`, seq }));
    expect(await post("/runs/append", { storeKey: key, runId: "r1", gen: "g1", events })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const seqs = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_inst, state) =>
      state.storage.sql
        .exec<{ seq: number }>(`SELECT seq FROM run_events WHERE run_id = ? ORDER BY seq`, "r1")
        .toArray()
        .map((r) => r.seq),
    );
    expect(seqs).toEqual([1, 2, 3]);
    // Live runs are not finished runs: the history routes answer as for an unknown id —
    // the ledger's own read is how a reclaim gets at them (item 36); an unknown run is empty.
    expect((await post("/runs/events", { storeKey: key, id: "r1" })).data.events).toBeNull();
    const liveEvents = (await post("/runs/live-events", { storeKey: key, runId: "r1" })).data.events as Array<{
      seq: number;
      type: string;
    }>;
    expect(liveEvents.map((e) => [e.seq, e.type])).toEqual([
      [1, "tool_call"],
      [2, "tool_call"],
      [3, "tool_call"],
    ]);
    expect((await post("/runs/live-events", { storeKey: key, runId: "nope" })).data.events).toEqual([]);
    expect((await post("/runs/live-events", { storeKey: key, runId: "bad id" })).status).toBe(400);
    const huge = { type: "tool_result", tool: "bash", summary: "x", output: "y".repeat(70_000), seq: 4 };
    expect((await post("/runs/append", { storeKey: key, runId: "r1", gen: "g1", events: [huge] })).status).toBe(400);
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step() })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step({ inFlight: [] }) })).toEqual(
      { status: 200, data: { ok: true } },
    );
    expect((await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: { step: 1 } })).status).toBe(400);
  });

  it("inbox appends with increasing seq from any generation; state replaces; both refused for an unknown run", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    expect(await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "a" } })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "b" } })).toEqual({
      status: 200,
      data: { ok: true, seq: 2 },
    });
    expect(await post("/runs/inbox", { storeKey: key, runId: "nope", message: { text: "c" } })).toEqual({
      status: 200,
      data: { ok: false },
    });
    // Read back past a seq (item 40): the resume's re-read at adopt time.
    expect(await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: 1 })).toEqual({
      status: 200,
      data: { items: [{ seq: 2, message: { text: "b" } }] },
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1" })).data).toEqual({
      items: [
        { seq: 1, message: { text: "a" } },
        { seq: 2, message: { text: "b" } },
      ],
    });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "nope", afterSeq: 0 })).data).toEqual({ items: [] });
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: -1 })).status).toBe(400);
    expect((await post("/runs/inbox/read", { storeKey: key, runId: "r1", afterSeq: "2" })).status).toBe(400);
    expect(await post("/runs/state", { storeKey: key, runId: "r1", gen: "g1", state: { verdict: "approve" } })).toEqual(
      { status: 200, data: { ok: true } },
    );
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ state: unknown }>;
    expect(live[0].state).toEqual({ verdict: "approve" });
  });
});

describe("run ledger — finishing, finish, handoff, reclaim (items 31, 33)", () => {
  it("finishing is a CAS taken once; finish writes the finished record and removes every live row in one step; the record then lists as finished", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post("/runs/step", { storeKey: key, runId: "r1", gen: "g1", record: step() });
    await post("/runs/inbox", { storeKey: key, runId: "r1", message: { text: "a" } });
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g1" })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/finishing", { storeKey: key, runId: "r1", gen: "g1" })).toEqual({
      status: 409,
      data: { ok: false, reason: "fenced" },
    });
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: record("r1", "slack:C1:1.0"),
    });
    // `event: none` — a record with no coordinator sends nothing (item 47).
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    const got = await post("/runs/get", { storeKey: key, id: "r1" });
    expect((got.data.record as RunRecord).status).toBe("completed");
    const list = await post("/runs/list", { storeKey: key });
    expect((list.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["r1"]);
    // The thread is free again.
    expect((await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"))).status).toBe(200);
    // finish with a record whose id differs from runId is refused before any write.
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r2", gen: "g1", record: record("other", "slack:C1:1.0") }))
        .status,
    ).toBe(400);
  });

  it("handoff marks this generation's live runs; reclaim takes expired and handed-off rows with the last step, the unconsumed inbox and jobs, and re-owns them; a live lease is left alone", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "expired", "slack:C1:1.0"));
    await post("/runs/claim", claimBody(key, "handed", "slack:C1:2.0"));
    await post("/runs/claim", claimBody(key, "alive", "slack:C1:3.0", "g1", { leaseMs: 3_600_000 }));
    // g2's own row with a lapsed lease: never taken by g2's own reclaim (a heartbeat that did not land, not a dead owner).
    await post("/runs/claim", claimBody(key, "mine", "slack:C1:4.0", "g2"));
    await post("/runs/step", { storeKey: key, runId: "expired", gen: "g1", record: step({ inboxConsumedSeq: 1 }) });
    await post("/runs/inbox", { storeKey: key, runId: "expired", message: { text: "first" } });
    await post("/runs/inbox", { storeKey: key, runId: "expired", message: { text: "second" } });
    expect(await post("/runs/handoff", { storeKey: key, gen: "g1", runIds: ["handed", "alive-not-mine"] })).toEqual({
      status: 200,
      data: { marked: ["handed"] },
    });
    const future = Date.now() + LEASE_MS + 1_000; // past `expired`'s lease, inside `alive`'s hour
    const r = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS });
    expect(r.status).toBe(200);
    const runs = r.data.runs as Array<{
      row: { runId: string; ownerGen: string; phase: string };
      lastStep: { step: number } | null;
      inbox: Array<{ message: { text: string } }>;
    }>;
    expect(runs.map((x) => x.row.runId).sort()).toEqual(["expired", "handed"]);
    const expired = runs.find((x) => x.row.runId === "expired")!;
    expect(expired.row).toMatchObject({ ownerGen: "g2", phase: "live" });
    expect(expired.lastStep?.step).toBe(1);
    expect(expired.inbox.map((i) => i.message.text)).toEqual(["second"]);
    // The old generation is fenced; the new one writes.
    expect((await post("/runs/step", { storeKey: key, runId: "expired", gen: "g1", record: step() })).status).toBe(409);
    expect(
      (await post("/runs/step", { storeKey: key, runId: "expired", gen: "g2", record: step({ step: 2 }) })).status,
    ).toBe(200);
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ runId: string; ownerGen: string }>;
    expect(live.find((x) => x.runId === "alive")?.ownerGen).toBe("g1");
    expect(live.find((x) => x.runId === "mine")?.ownerGen).toBe("g2"); // untouched by its own generation's reclaim
  });

  it("reclaim offers the deferred rows at or below the cursor with every row past it; a malformed deferred list is refused", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "parked", "slack:C1:1.0"));
    for (const text of ["ordinary", "earlier read", "provider up", "later"])
      await post("/runs/inbox", { storeKey: key, runId: "parked", message: { text } });
    for (const inboxDeferredSeqs of [[0], [1.5], "1", [-1]])
      expect(
        (
          await post("/runs/step", {
            storeKey: key,
            runId: "parked",
            gen: "g1",
            record: { ...step({ inboxConsumedSeq: 3 }), inboxDeferredSeqs },
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await post("/runs/step", {
          storeKey: key,
          runId: "parked",
          gen: "g1",
          record: step({ inboxConsumedSeq: 3, inboxDeferredSeqs: [1] }),
        })
      ).status,
    ).toBe(200);
    const r = await post("/runs/reclaim", {
      storeKey: key,
      gen: "g2",
      now: Date.now() + LEASE_MS + 1_000,
      leaseMs: LEASE_MS,
    });
    const [taken] = r.data.runs as Array<{ inbox: Array<{ seq: number; message: { text: string } }> }>;
    expect(taken!.inbox.map((i) => [i.seq, i.message.text])).toEqual([
      [1, "ordinary"],
      [4, "later"],
    ]);
  });
});

// docs/reference/specs/run-history.md items 47–48: the coordinator's event rides
// the one handler every terminal record commits through, and the row and record
// carry the instance and the spawn's key.
describe("run ledger — the coordinator's event and the key (items 47–48)", () => {
  const TAG = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
  type Sent = { instance: string; type: string; payload: unknown };

  /** The Workflow binding as the object sees it, doubled: what `finish` sent, or
   *  an engine that refuses because the instance ended. Installed on the live
   *  object, so the send goes through the handler's own code path. */
  async function coordinatorDouble(key: string, behaviour: "ok" | "not-running" | "absent" = "ok"): Promise<Sent[]> {
    const sent: Sent[] = [];
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const holder = inst as unknown as { env: Record<string, unknown> };
      // `absent`: a state Worker deployed without the binding (the release
      // before it bound the bot's class) — the pool's own binding is the stub
      // Worker's, so absence is installed, never assumed.
      if (behaviour === "absent") {
        const { SHIP_COORDINATOR: _binding, ...without } = holder.env;
        holder.env = without;
        return;
      }
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async (id: string) => ({
            sendEvent: async (event: { type: string; payload: unknown }) => {
              if (behaviour === "not-running") throw new Error("instance is not running");
              sent.push({ instance: id, type: event.type, payload: event.payload });
            },
          }),
        },
      };
    });
    return sent;
  }

  const childRecord = (id: string, threadKey: string, status: RunRecord["status"] = "completed"): RunRecord => ({
    ...record(id, threadKey),
    status,
    ...TAG,
  });

  it("the test pool leaves the real Workflow engine unbound, so only a test's live-object double can own a workflow promise", () => {
    expect(env.SHIP_COORDINATOR).toBeUndefined();
  });

  it("a record carrying parentInstanceId committed by the owner's finish sends exactly one `run-finished-<runId>` to that instance, after the commit, and the response says so", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: childRecord("r1", "slack:C1:1.0"),
    });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "sent" } });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "run-finished-r1",
        payload: expect.objectContaining({ runId: "r1", status: "completed", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // The commit stood: the row is gone and the record lists as finished, its tag on it.
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    const got = (await post("/runs/get", { storeKey: key, id: "r1" })).data.record as RunRecord;
    expect(got).toMatchObject({ status: "completed", ...TAG });
  });

  it("the reclaim's close (an expired live row taken by the next generation) and the admission's close (a reserved row it supersedes) each send exactly one event", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    const base = claimBody(key, "expired", "slack:C1:1.0").run.meta;
    await post("/runs/claim", claimBody(key, "expired", "slack:C1:1.0", "g1", { meta: { ...base, ...TAG } }));
    await post(
      "/runs/claim",
      claimBody(key, "reserved", "slack:C1:2.0", "g1", {
        phase: "attaching",
        system: "",
        tools: [],
        card: null,
        meta: { ...base, threadKey: "slack:C1:2.0", ...TAG, request: { text: "do the unit" } },
      }),
    );
    const future = Date.now() + LEASE_MS + 1_000;
    const taken = (await post("/runs/reclaim", { storeKey: key, gen: "g2", now: future, leaseMs: LEASE_MS })).data
      .runs as Array<{ row: { runId: string } }>;
    expect(taken.map((t) => t.row.runId).sort()).toEqual(["expired", "reserved"]);
    expect(
      await post("/runs/finish", {
        storeKey: key,
        runId: "expired",
        gen: "g2",
        record: childRecord("expired", "slack:C1:1.0", "interrupted"),
      }),
    ).toMatchObject({ status: 200, data: { ok: true, event: "sent" } });
    expect(
      await post("/runs/finish", {
        storeKey: key,
        runId: "reserved",
        gen: "g2",
        record: childRecord("reserved", "slack:C1:2.0", "interrupted"),
      }),
    ).toMatchObject({ status: 200, data: { ok: true, event: "sent" } });
    expect(sent.map((s) => s.type)).toEqual(["run-finished-expired", "run-finished-reserved"]);
    expect(sent.map((s) => (s.payload as { status: string }).status)).toEqual(["interrupted", "interrupted"]);
  });

  it("a terminal record committed through put, outside the ledger's finish — the run loop's or a reclaim's interrupted close, the pi harness's restart — sends `run-finished-<runId>` once; the start tombstone (finishedAt = startedAt) sends nothing; a record without the tag sends nothing", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    // The tombstone a run writes at its start: not a close, so no wake.
    const started = record("p1", "slack:C1:3.0");
    await post("/runs/put", {
      storeKey: key,
      record: { ...started, finishedAt: started.startedAt, status: "interrupted", ...TAG },
    });
    expect(sent).toEqual([]);
    // The interrupted close written outside `finish`: one send, the record's status on it.
    expect(
      await post("/runs/put", { storeKey: key, record: { ...childRecord("p1", "slack:C1:3.0", "interrupted") } }),
    ).toMatchObject({ status: 200, data: { ok: true, stored: true } });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "run-finished-p1",
        payload: expect.objectContaining({ runId: "p1", status: "interrupted", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // A plain record — no coordinator — wakes nobody.
    await post("/runs/put", { storeKey: key, record: record("p2", "slack:C1:4.0") });
    expect(sent).toHaveLength(1);
  });

  it("a record without parentInstanceId sends nothing; a fenced finish sends nothing", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post(
      "/runs/claim",
      claimBody(key, "r2", "slack:C1:2.0", "g1", {
        meta: { ...claimBody(key, "r2", "slack:C1:2.0").run.meta, ...TAG },
      }),
    );
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:1.0") }),
    ).toEqual({ status: 200, data: { ok: true, stored: true, event: "none" } });
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r2", gen: "g9", record: childRecord("r2", "slack:C1:2.0") }))
        .status,
    ).toBe(409);
    expect(sent).toEqual([]);
  });

  it("a send the engine refuses — the instance ended — is swallowed: the finish still commits and the response names the failure", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key, "not-running");
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    const fin = await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: childRecord("r1", "slack:C1:1.0"),
    });
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true, event: "failed" } });
    expect(sent).toEqual([]);
    expect((await post("/runs/live", { storeKey: key })).data.runs).toEqual([]);
    expect(((await post("/runs/get", { storeKey: key, id: "r1" })).data.record as RunRecord).status).toBe("completed");
  });

  it("a Worker without the coordinator binding (the release before it bound the bot's class) commits as before and answers no-binding", async () => {
    const key = storeKey();
    await coordinatorDouble(key, "absent");
    await post(
      "/runs/claim",
      claimBody(key, "r1", "slack:C1:1.0", "g1", {
        meta: { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG },
      }),
    );
    expect(
      await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: childRecord("r1", "slack:C1:1.0") }),
    ).toEqual({ status: 200, data: { ok: true, stored: true, event: "no-binding" } });
  });

  it("the claim stores the key on the row and a second claim on the thread is refused naming it; a malformed key or instance id in the meta is 400", async () => {
    const key = storeKey();
    const meta = { ...claimBody(key, "r1", "slack:C1:1.0").run.meta, ...TAG };
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0", "g1", { meta }))).status).toBe(200);
    const live = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ meta: Record<string, unknown> }>;
    expect(live[0].meta).toMatchObject(TAG);
    const busy = await post("/runs/claim", claimBody(key, "r2", "slack:C1:1.0"));
    expect(busy).toEqual({
      status: 409,
      data: {
        ok: false,
        reason: "thread-live",
        live: { runId: "r1", agent: "review", startedAt: 1_000, idempotencyKey: TAG.idempotencyKey },
      },
    });
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, idempotencyKey: "no-step" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: { ...meta, parentInstanceId: "has:colon" } }),
        )
      ).status,
    ).toBe(400);
    // The tag is both fields or neither: one alone is refused before it reaches a row.
    const { idempotencyKey: _k, ...instanceOnly } = meta;
    expect((await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0", "g1", { meta: instanceOnly }))).status).toBe(
      400,
    );
  });
});

// docs/reference/specs/run-history.md item 49: the parent ship record the
// coordinator's spawn route reads the requester from lives on the state Worker.
describe("run ledger — the coordinator instance record (item 49)", () => {
  const instance: CoordinatorInstance = {
    id: "ship_acme_api_1",
    kind: "ship",
    userId: "slack:UALICE",
    userName: "alice",
    channelId: "slack:C1",
    threadKey: "slack:C1:1.0",
    repo: "acme/api",
    branch: "plan/orchestration/u12",
    base: "main",
    createdAt: 1_000,
  };

  it("put stores the record and get reads it back; an identical put is idempotent; a different record under the same id is refused as exists; an unknown id is null", async () => {
    const key = storeKey();
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).toEqual({
      status: 200,
      data: { instance },
    });
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, branch: "other" } })).toEqual({
      status: 409,
      data: { ok: false, reason: "exists" },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "ship_none" })).data).toEqual({ instance: null });
  });

  // Record 0060 / issue 1924: the hard stop's mark on the instance row —
  // written when the hosted parent is sealed, read back by the runner's routes.
  it("stop marks the instance row and get reads the mark back; a second mark keeps the first `at`; an unknown id is 409 unknown_instance; a malformed body is 400", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/put", { storeKey: key, instance })).status).toBe(200);
    expect(await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 5_000 })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...instance, stop: { at: 5_000 } },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id, at: 9_000 })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({
      instance: { ...instance, stop: { at: 5_000 } },
    });
    expect(await post("/runs/coordinator/stop", { storeKey: key, instanceId: "ship_none", at: 5_000 })).toEqual({
      status: 409,
      data: { ok: false, reason: "unknown_instance" },
    });
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: "has:colon", at: 5_000 })).status).toBe(
      400,
    );
    expect((await post("/runs/coordinator/stop", { storeKey: key, instanceId: instance.id })).status).toBe(400);
  });

  it("replace writes the record over whatever the id holds — a different record, or none — drops the id's unit rows and no other instance's; a malformed record is 400", async () => {
    const key = storeKey();
    expect(await post("/runs/coordinator/put", { storeKey: key, instance })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const row = (instanceId: string, unit: string): CoordinatorUnit => ({
      instanceId,
      unit,
      slug: unit.toLowerCase(),
      branch: `plan/orchestration/${unit.toLowerCase()}`,
      dependsOn: [],
      rounds: [],
    });
    await post("/runs/coordinator/units/put", {
      storeKey: key,
      units: [row(instance.id, "U12"), row(instance.id, "U13"), row("ship_other", "U12")],
    });
    const again = { ...instance, runId: "run-s2", createdAt: 2_000 };
    expect(await post("/runs/coordinator/replace", { storeKey: key, instance: again })).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await post("/runs/coordinator/get", { storeKey: key, id: instance.id })).data).toEqual({ instance: again });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: instance.id })).data).toEqual({
      units: [],
    });
    const others = (await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "ship_other" })).data
      .units as CoordinatorUnit[];
    expect(others.map((u) => u.unit)).toEqual(["U12"]);
    const fresh = { ...again, id: "ship_fresh" };
    expect((await post("/runs/coordinator/replace", { storeKey: key, instance: fresh })).status).toBe(200);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "ship_fresh" })).data).toEqual({
      instance: fresh,
    });
    expect(
      (await post("/runs/coordinator/replace", { storeKey: key, instance: { ...instance, kind: "review" } })).status,
    ).toBe(400);
  });

  it("validates: a malformed record or id is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect(
      (await post("/runs/coordinator/put", { storeKey: key, instance: { ...instance, kind: "review" } })).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/put", { storeKey: key })).status).toBe(400);
    expect((await post("/runs/coordinator/get", { storeKey: key, id: "has:colon" })).status).toBe(400);
    expect(
      (await post("/runs/coordinator/get", { storeKey: key, id: instance.id }, { "content-type": "application/json" }))
        .status,
    ).toBe(401);
  });
});

// Feature: docs/reference/specs/agent-ship.md item 16 and run-history.md item 50 —
// decision-record reservations survive bot-process restarts in the state Worker,
// with already-persisted unit and run rows included in the claim set.
describe("run ledger — durable decision-record reservations (agent-ship item 16)", () => {
  it("advances past reservations persisted on unit and run rows, and reuses a task key after a process restart", async () => {
    const key = storeKey();
    const instance: CoordinatorInstance = {
      id: "ship_record_reservations",
      kind: "ship",
      userId: "slack:UALICE",
      channelId: "slack:C1",
      threadKey: "slack:C1:1.0",
      repo: "acme/api",
      branch: "plan/records/u1",
      base: "main",
      createdAt: 1_000,
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: ["U", "1"].join(""),
      slug: "u1",
      branch: "plan/records/u1",
      dependsOn: [],
      record: "0075",
      rounds: [],
    };
    await post("/runs/coordinator/put", { storeKey: key, instance });
    await post("/runs/coordinator/units/put", { storeKey: key, units: [unit] });

    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "1111111111111111",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0076" } });
    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "1111111111111111",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0076" } });

    await post("/runs/put", {
      storeKey: key,
      record: { ...record("record-run", "slack:C1:2.0"), repo: "acme/api", record: "0077" },
    });
    expect(
      await post("/runs/decision-record/reserve", {
        storeKey: key,
        repo: "acme/api",
        taskKey: "2222222222222222",
        claimed: ["0074"],
      }),
    ).toEqual({ status: 200, data: { number: "0078" } });
  });
});

describe("run ledger — the coordinator's unit rows (item 50)", () => {
  const INSTANCE_ID = "ship_acme_api_1";
  const unit = (name: string, over: Partial<CoordinatorUnit> = {}): CoordinatorUnit => ({
    instanceId: INSTANCE_ID,
    unit: name,
    slug: name.toLowerCase(),
    branch: `plan/orchestration/${name.toLowerCase()}`,
    dependsOn: [],
    rounds: [],
    ...over,
  });

  it("put writes the rows and list reads an instance's back in first-written order; a row is replaced whole and keeps its place; another instance's rows never appear; an unknown instance lists none", async () => {
    const key = storeKey();
    expect(
      await post("/runs/coordinator/units/put", {
        storeKey: key,
        units: [unit("U12"), unit("U13", { dependsOn: ["U12"] })],
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect(
      (
        await post("/runs/coordinator/units/put", {
          storeKey: key,
          units: [{ ...unit("U99"), instanceId: "ship_other" }],
        })
      ).status,
    ).toBe(200);
    const listed = await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID });
    expect(listed.status).toBe(200);
    expect((listed.data.units as CoordinatorUnit[]).map((u) => u.unit)).toEqual(["U12", "U13"]);
    const reached = unit("U12", {
      threadKey: "slack:C1:2.0",
      pr: { number: 7, url: "https://github.com/acme/api/pull/7" },
      rounds: [{ index: 0, agent: "coding", outcome: "started", at: 1_000 }],
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [reached] })).status).toBe(200);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [reached, unit("U13", { dependsOn: ["U12"] })],
    });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "ship_none" })).data).toEqual({
      units: [],
    });
  });

  it("the validating wake boundary accepts a first-segment resume without inventing a renewal segment row", async () => {
    const key = storeKey();
    const row = unit("U12", {
      startedAt: 1_000,
      idle: { why: "stopped", at: 2_000, renewalsLeft: 2, spendUsd: null, wakes: 1 },
    });
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "U12",
          event: { sender: "slack:UALICE", text: "resume", mode: "wake", at: 3_000 },
        })
      ).status,
    ).toBe(200);
    const answer = {
      kind: "segment",
      index: 1,
      spendUsd: null,
      texts: ["Alice: resume"],
      senders: ["Alice"],
      leaseMs: 60_000,
    } as const;
    expect(
      await post("/runs/coordinator/wake", {
        storeKey: key,
        unit: row,
        waitId: "U12/idle/1",
        answer,
        seqs: [1],
        by: "segment:1",
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: INSTANCE_ID })).data).toEqual({
      units: [{ ...row, wakes: { "U12/idle/1": answer } }],
    });
    expect(
      (await post("/runs/coordinator/events/list", { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" })).data,
    ).toMatchObject({ events: [{ consumedBy: "segment:1" }] });
  });

  it("validates: an empty list, a malformed row or instance id is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [] })).status).toBe(400);
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [{ unit: "U12" }] })).status).toBe(400);
    expect((await post("/runs/coordinator/units/list", { storeKey: key, instanceId: "has:colon" })).status).toBe(400);
    expect(
      (
        await post(
          "/runs/coordinator/units/list",
          { storeKey: key, instanceId: INSTANCE_ID },
          {
            "content-type": "application/json",
          },
        )
      ).status,
    ).toBe(401);
  });
});

// Feature: docs/reference/specs/run-history.md item 50 and record 0051's reply-as-event rule —
// the thread events of a unit-owned thread: a sibling table of the unit rows,
// appended in arrival order under the per-event cap, consumed once.
describe("run ledger — the coordinator's unit events (record 0051's reply-as-event rule)", () => {
  const INSTANCE_ID = "ship_acme_api_1";
  const event = (text: string, over: Record<string, unknown> = {}) => ({
    sender: "slack:UALICE",
    text,
    mode: "steer",
    at: 5_000,
    ...over,
  });

  it("append assigns sequences in order and caps per event; list filters unconsumed; mark-consumed is idempotent; a put of the unit row leaves the events untouched", async () => {
    const key = storeKey();
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" };
    const seeded = event("first", { id: `${INSTANCE_ID}:U12:ship-request` });
    expect(await post("/runs/coordinator/events/append", { ...body, event: seeded })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/coordinator/events/append", { ...body, event: seeded })).toEqual({
      status: 200,
      data: { ok: true, seq: 1 },
    });
    expect(await post("/runs/coordinator/events/append", { ...body, event: event("second") })).toEqual({
      status: 200,
      data: { ok: true, seq: 2 },
    });
    // Over the durable cap (400 KiB): the attachments are dropped whole and the row says how many.
    const heavy = event("third", { attachments: [{ mediaType: "image/png", data: "x".repeat(500 * 1024) }] });
    expect((await post("/runs/coordinator/events/append", { ...body, event: heavy })).data).toEqual({
      ok: true,
      seq: 3,
    });
    const all = await post("/runs/coordinator/events/list", body);
    const rows = all.data.events as Array<Record<string, unknown>>;
    expect(rows.map((e) => [e.seq, e.text])).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"],
    ]);
    expect(rows[2]!.attachments).toBeUndefined();
    expect(rows[2]!.attachmentsDropped).toBe(1);
    // Consumed once: a second mark keeps the first consumer; list filters unconsumed.
    expect(
      (await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1, 2], by: "spawn:U12/1/fix" })).data,
    ).toEqual({ ok: true });
    expect(
      (await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1], by: "spawn:U12/2/fix" })).data,
    ).toEqual({ ok: true });
    const unconsumed = await post("/runs/coordinator/events/list", { ...body, unconsumedOnly: true });
    expect((unconsumed.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3]);
    const after = await post("/runs/coordinator/events/list", body);
    expect((after.data.events as Array<{ consumedBy?: string }>).map((e) => e.consumedBy)).toEqual([
      "spawn:U12/1/fix",
      "spawn:U12/1/fix",
      undefined,
    ]);
    // A put of the unit row — the whole-row upsert — leaves the events untouched (record 0051).
    const row: CoordinatorUnit = {
      instanceId: INSTANCE_ID,
      unit: "U12",
      slug: "u12",
      branch: "plan/orchestration/u12",
      dependsOn: [],
      rounds: [],
      threadKey: "slack:C1:2.0",
    };
    expect((await post("/runs/coordinator/units/put", { storeKey: key, units: [row] })).status).toBe(200);
    const kept = await post("/runs/coordinator/events/list", body);
    expect((kept.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2, 3]);
    // Another unit's list is its own.
    expect((await post("/runs/coordinator/events/list", { ...body, unit: "U13" })).data).toEqual({ events: [] });
    // A text alone over the cap is cut to fit and the row says how many characters went.
    const wordy = event("w".repeat(500 * 1024));
    expect((await post("/runs/coordinator/events/append", { ...body, event: wordy })).data).toEqual({
      ok: true,
      seq: 4,
    });
    const events = async () =>
      (await post("/runs/coordinator/events/list", body)).data.events as Array<Record<string, unknown>>;
    const fourth = (await events())[3]!;
    expect((fourth.text as string).length).toBeLessThan(500 * 1024);
    expect(fourth.textDropped).toBe(500 * 1024 - (fourth.text as string).length);
    // A caller's `consumedBy` never rides the append: the row is born unconsumed in its JSON as in its column.
    const presumptuous = event("fifth", { consumedBy: "spawn:U12/9/fix" });
    expect((await post("/runs/coordinator/events/append", { ...body, event: presumptuous })).data).toEqual({
      ok: true,
      seq: 5,
    });
    expect((await events())[4]!.consumedBy).toBeUndefined();
    const stillOpen = await post("/runs/coordinator/events/list", { ...body, unconsumedOnly: true });
    expect((stillOpen.data.events as Array<{ seq: number }>).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("validates: a malformed event, unit, instance id, seqs or consumer is 400", async () => {
    const key = storeKey();
    const body = { storeKey: key, instanceId: INSTANCE_ID, unit: "U12" };
    expect((await post("/runs/coordinator/events/append", { ...body, event: { text: "x" } })).status).toBe(400);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: "has:colon",
          unit: "U12",
          event: event("x"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/coordinator/events/append", {
          storeKey: key,
          instanceId: INSTANCE_ID,
          unit: "u/12",
          event: event("x"),
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [0], by: "r" })).status).toBe(400);
    expect((await post("/runs/coordinator/events/mark-consumed", { ...body, seqs: [1], by: "" })).status).toBe(400);
  });
});

// Feature: docs/reference/specs/session-log.md item 7 — the sessions registry
// on RunHistoryDO and the sweep's drop: a session object goes only when every
// kept run of the session is gone and no live run holds its thread, owner row
// first, then the rows.
describe("the sessions registry and the sweep's drop of a session log", () => {
  const sql = <T extends Record<string, unknown>>(key: string, query: string, ...params: unknown[]) =>
    runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (_inst, state) =>
      state.storage.sql.exec<T>(query, ...params).toArray(),
    );
  const sessionOf = (threadKey: string, agent: string) => `${threadKey}:${agent}`;
  const sessionStub = (skey: string) => env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(skey));
  const withSession = (threadKey: string, agent: string, seedFrom: number) => ({
    session: { key: sessionOf(threadKey, agent), seedFrom, request: seedFrom, range: { from: seedFrom } },
  });
  const seedRows = async (skey: string, gen: string, runId: string, count: number) => {
    await post("/runs/session/owner", { key: skey, runId, gen });
    await post("/runs/session/write", {
      key: skey,
      gen,
      rows: Array.from({ length: count }, (_, i) => ({
        idx: i,
        part: 0,
        json: JSON.stringify({ role: "user", part: { type: "text", text: `turn ${i}` } }),
      })),
      attachments: [],
    });
  };

  it("a claim with a session registers it under its thread and agent; the finish stamps the run's row with the session key, refreshes the registry's finish time and the object's bytes", async () => {
    const key = storeKey();
    const thread = "slack:C1:1.0";
    const skey = sessionOf(thread, "review");
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(key, "r1", thread, "g1", {
            meta: {
              agent: "review",
              channelId: "slack:C1",
              userId: "u",
              threadKey: thread,
              ...withSession(thread, "review", 0),
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(await sql(key, `SELECT key, thread_key, agent, last_finished_at, bytes FROM sessions`)).toEqual([
      { key: skey, thread_key: thread, agent: "review", last_finished_at: 0, bytes: 0 },
    ]);
    await seedRows(skey, "g1", "r1", 3);
    const rec = { ...record("r1", thread), session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 2 } } };
    expect((await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: rec })).status).toBe(200);
    expect(await sql(key, `SELECT run_id, session_key FROM runs`)).toEqual([{ run_id: "r1", session_key: skey }]);
    const [row] = await sql<{ last_finished_at: number; bytes: number }>(
      key,
      `SELECT last_finished_at, bytes FROM sessions WHERE key = ?`,
      skey,
    );
    expect(row.last_finished_at).toBe(rec.finishedAt);
    expect(row.bytes).toBeGreaterThan(0);
    // The finish cleared nothing: the log's rows stay for the next run.
    expect((await post("/runs/session/tail", { key: skey })).data).toEqual({ next: 3 });
    // A record without a session leaves the column null.
    await post("/runs/put", { storeKey: key, record: record("plain", "slack:C1:9.0") });
    expect(await sql(key, `SELECT session_key FROM runs WHERE run_id = 'plain'`)).toEqual([{ session_key: null }]);
  });

  it("the sweep drops a session object only once every kept run of it is gone and no live run holds the thread — owner cleared, rows gone, registry row deleted; a session with a kept run or a live thread stays", async () => {
    const key = storeKey();
    const now = Date.now();
    const DAY = 86_400_000;
    const gone = "slack:C1:1.0";
    const kept = "slack:C1:2.0";
    const live = "slack:C1:3.0";
    const sGone = sessionOf(gone, "review");
    const sKept = sessionOf(kept, "review");
    const sLive = sessionOf(live, "review");
    const sLiveOther = sessionOf(live, "coding");
    // Three finished sessions: one whose only run is old, one whose run is fresh,
    // one whose old run finished but whose thread has a live run of another agent.
    for (const [runId, thread, skey, finishedAt] of [
      ["r-gone", gone, sGone, now - 40 * DAY],
      ["r-kept", kept, sKept, now - 1000],
      ["r-live", live, sLive, now - 40 * DAY],
    ] as const) {
      await seedRows(skey, "g1", runId, 2);
      await post(
        "/runs/claim",
        claimBody(key, runId, thread, "g1", {
          meta: {
            agent: "review",
            channelId: "slack:C1",
            userId: "u",
            threadKey: thread,
            ...withSession(thread, "review", 0),
          },
        }),
      );
      const rec = {
        ...record(runId, thread),
        startedAt: finishedAt - 5000,
        finishedAt,
        session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
      };
      await post("/runs/finish", { storeKey: key, runId, gen: "g1", record: rec });
    }
    // The live run on the third thread, a coding session with no record yet.
    await seedRows(sLiveOther, "g1", "r-live-2", 1);
    await post(
      "/runs/claim",
      claimBody(key, "r-live-2", live, "g1", {
        meta: {
          agent: "coding",
          channelId: "slack:C1",
          userId: "u",
          threadKey: live,
          ...withSession(live, "coding", 0),
        },
      }),
    );
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual(
      [sGone, sKept, sLive, sLiveOther].sort(),
    );
    // Retention keeps 30 days: the two old records fall out at the sweep.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), (inst: RunHistoryDO) => inst.alarm());
    expect((await sql(key, `SELECT run_id FROM runs ORDER BY run_id`)).map((r) => r.run_id)).toEqual(["r-kept"]);
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual(
      [sKept, sLive, sLiveOther].sort(),
    );
    // The dropped object: owner gone (a late write is unknown-run), rows gone.
    expect((await post("/runs/session/write", { key: sGone, gen: "g1", rows: [], attachments: [] })).data).toEqual({
      ok: false,
      reason: "unknown-run",
    });
    expect((await post("/runs/session/tail", { key: sGone })).data).toEqual({ next: 0 });
    // The kept session and both sessions of the live thread are untouched.
    expect((await post("/runs/session/tail", { key: sKept })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sLive })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sLiveOther })).data).toEqual({ next: 1 });
    expect(await runInDurableObject(sessionStub(sLive), (inst: SessionLogDO) => inst.rowCount())).toBe(2);
  });

  it("the drop decides on what it re-reads at each drop, not on the candidate list: a run that went live on the thread, or a record that named the session, between the list and the drop keeps the session and its registry row", async () => {
    const key = storeKey();
    const now = Date.now();
    const DAY = 86_400_000;
    const threadA = "slack:C1:11.0";
    const threadB = "slack:C1:12.0";
    const sA = sessionOf(threadA, "review");
    const sB = sessionOf(threadB, "review");
    for (const [runId, thread, skey] of [
      ["r-a", threadA, sA],
      ["r-b", threadB, sB],
    ] as const) {
      await seedRows(skey, "g1", runId, 2);
      await post(
        "/runs/claim",
        claimBody(key, runId, thread, "g1", {
          meta: {
            agent: "review",
            channelId: "slack:C1",
            userId: "u",
            threadKey: thread,
            ...withSession(thread, "review", 0),
          },
        }),
      );
      await post("/runs/finish", {
        storeKey: key,
        runId,
        gen: "g1",
        record: {
          ...record(runId, thread),
          startedAt: now - 40 * DAY - 5000,
          finishedAt: now - 40 * DAY,
          session: { key: skey, seedFrom: 0, request: 0, range: { from: 0, to: 1 } },
        },
      });
    }
    // The list the sweep's transaction would produce once retention drops both old records.
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await runInDurableObject(stub, async (_inst, state) => {
      state.storage.sql.exec(`DELETE FROM run_events WHERE run_id IN ('r-a', 'r-b')`);
      state.storage.sql.exec(`DELETE FROM runs WHERE run_id IN ('r-a', 'r-b')`);
    });
    const candidates = [
      { key: sA, threadKey: threadA },
      { key: sB, threadKey: threadB },
    ];
    // Between the list and the drop: a new run goes live on thread A, and a
    // fresh record names session B.
    await post(
      "/runs/claim",
      claimBody(key, "r-a2", threadA, "g1", {
        meta: { agent: "coding", channelId: "slack:C1", userId: "u", threadKey: threadA },
      }),
    );
    await post("/runs/put", {
      storeKey: key,
      record: { ...record("r-b2", threadB), session: { key: sB, seedFrom: 2, request: 2, range: { from: 2, to: 3 } } },
    });
    const dropped = await runInDurableObject(stub, (inst: RunHistoryDO) => inst.sweepSessions(candidates));
    expect(dropped).toBe(0);
    expect((await post("/runs/session/tail", { key: sA })).data).toEqual({ next: 2 });
    expect((await post("/runs/session/tail", { key: sB })).data).toEqual({ next: 2 });
    expect((await sql(key, `SELECT key FROM sessions ORDER BY key`)).map((r) => r.key)).toEqual([sA, sB].sort());
    // Once thread A's run finishes with no record and session B's record is gone, the same list drops both.
    await post("/runs/abandon", { storeKey: key, runId: "r-a2", gen: "g1" });
    await post("/runs/delete", { storeKey: key, id: "r-b2" });
    expect(await runInDurableObject(stub, (inst: RunHistoryDO) => inst.sweepSessions(candidates))).toBe(2);
    expect((await post("/runs/session/tail", { key: sA })).data).toEqual({ next: 0 });
    expect(await sql(key, `SELECT key FROM sessions`)).toEqual([]);
  });
});

describe("run ledger — intake receipts (item 59)", () => {
  const HOUR = 3_600_000;
  const intakeReceipt = (threadKey: string, over: Record<string, unknown> = {}) => ({
    verdict: "silent",
    reason: "answering a colleague",
    source: "model",
    mode: "classify",
    model: "prov/mini",
    gen: 3,
    threadKey,
    decidedAt: 5_000,
    ...over,
  });

  it("the insert is if-absent inside the transaction: the first write answers inserted with the row, a second on the key answers the first stored row; read answers the row or null", async () => {
    const key = storeKey();
    expect((await post("/runs/intake/read", { storeKey: key, key: "slack:C1:2.0" })).data).toEqual({ receipt: null });
    const first = intakeReceipt("slack:C1:1.0", {
      source: "error",
      providerFailure: "credit-or-quota-exhausted",
      reason: "The model provider's credit or quota is exhausted; this request did not start.",
    });
    expect(await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: first })).toMatchObject({
      status: 200,
      data: { inserted: true, stored: first },
    });
    const second = intakeReceipt("slack:C1:1.0", { verdict: "addressed", decidedAt: 6_000, gen: 9 });
    expect((await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: second })).data).toEqual({
      inserted: false,
      stored: first,
    });
    expect((await post("/runs/intake/read", { storeKey: key, key: "slack:C1:2.0" })).data).toEqual({
      receipt: first,
    });
  });

  it("claims one failure delivery atomically, releases a rejected post, and closes a successful post", async () => {
    const key = storeKey();
    const receiptKey = "slack:C1:2.0";
    await post("/runs/intake", {
      storeKey: key,
      key: receiptKey,
      receipt: intakeReceipt("slack:C1:1.0", { source: "error", providerFailure: "transient" }),
    });
    const claim = (poster: string, claimedAt = 5_000) =>
      post("/runs/intake/delivery/claim", { storeKey: key, key: receiptKey, poster, claimedAt });
    const [a, b] = await Promise.all([claim("poster-a"), claim("poster-b")]);
    expect([a.data.claimed, b.data.claimed].sort()).toEqual([false, true]);
    const owner = a.data.claimed === true ? "poster-a" : "poster-b";
    const loser = owner === "poster-a" ? "poster-b" : "poster-a";

    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: loser,
      delivered: false,
    });
    expect((await claim("poster-c")).data).toEqual({ claimed: false });
    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: owner,
      delivered: false,
    });
    expect((await claim("poster-c")).data).toEqual({ claimed: true });
    await post("/runs/intake/delivery/finish", {
      storeKey: key,
      key: receiptKey,
      poster: "poster-c",
      delivered: true,
    });
    expect((await claim("poster-d", Number.MAX_SAFE_INTEGER)).data).toEqual({ claimed: false });
  });

  it("list answers a thread's rows and rows since an instant, oldest first", async () => {
    const key = storeKey();
    const a = intakeReceipt("slack:C1:1.0", { decidedAt: 1_000 });
    const b = intakeReceipt("slack:C1:1.0", { decidedAt: 3_000, verdict: "addressed" });
    const other = intakeReceipt("slack:C2:9.0", { decidedAt: 2_000 });
    await post("/runs/intake", { storeKey: key, key: "slack:C1:3.0", receipt: b });
    await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: a });
    await post("/runs/intake", { storeKey: key, key: "slack:C2:9.5", receipt: other });
    expect((await post("/runs/intake/list", { storeKey: key, threadKey: "slack:C1:1.0" })).data).toEqual({
      receipts: [a, b],
    });
    expect((await post("/runs/intake/list", { storeKey: key, since: 2_000 })).data).toEqual({
      receipts: [other, b],
    });
    expect((await post("/runs/intake/list", { storeKey: key, threadKey: "slack:C1:1.0", since: 2_000 })).data).toEqual({
      receipts: [b],
    });
    expect((await post("/runs/intake/list", { storeKey: key })).data).toEqual({ receipts: [a, other, b] });
  });

  it("the alarm prunes by both arms of the bound: a 30 minute window keeps a row 24 hours, a two day window keeps it the window plus the drain deadline", async () => {
    const key = storeKey();
    const now = Date.now();
    const min30 = 30 * 60_000;
    const twoDays = 48 * HOUR;
    const at = (hoursAgo: number) => intakeReceipt("slack:C1:1.0", { decidedAt: now - hoursAgo * HOUR });
    // The 24-hour arm: a 30 minute window keeps rows 24 hours, no more.
    await post("/runs/intake", { storeKey: key, key: "k:24h-out", receipt: at(25), windowMs: min30 });
    await post("/runs/intake", { storeKey: key, key: "k:24h-kept", receipt: at(23), windowMs: min30 });
    // The window arm: a two-day window keeps rows the window plus the drain (90 min).
    await post("/runs/intake", { storeKey: key, key: "k:win-out", receipt: at(50), windowMs: twoDays });
    await post("/runs/intake", { storeKey: key, key: "k:win-kept", receipt: at(49), windowMs: twoDays });
    expect(await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(key)))).toBe(true); // armed by the first insert
    const read = async (k: string) =>
      (await post("/runs/intake/read", { storeKey: key, key: k })).data.receipt as unknown;
    expect(await read("k:24h-out")).toBeNull();
    expect(await read("k:24h-kept")).not.toBeNull();
    expect(await read("k:win-out")).toBeNull();
    expect(await read("k:win-kept")).not.toBeNull();
  });

  it("validates: a missing or overlong key, a malformed receipt or windowMs is 400; no bearer is 401", async () => {
    const key = storeKey();
    expect((await post("/runs/intake", { storeKey: key, receipt: intakeReceipt("slack:C1:1.0") })).status).toBe(400);
    expect(
      (await post("/runs/intake", { storeKey: key, key: "k".repeat(300), receipt: intakeReceipt("slack:C1:1.0") }))
        .status,
    ).toBe(400);
    expect(
      (await post("/runs/intake", { storeKey: key, key: "slack:C1:2.0", receipt: { verdict: "maybe" } })).status,
    ).toBe(400);
    expect(
      (
        await post("/runs/intake", {
          storeKey: key,
          key: "slack:C1:2.0",
          receipt: intakeReceipt("slack:C1:1.0"),
          windowMs: -5,
        })
      ).status,
    ).toBe(400);
    expect((await post("/runs/intake/read", { storeKey: key })).status).toBe(400);
    expect((await post("/runs/intake/list", { storeKey: key, since: "yesterday" })).status).toBe(400);
    expect(
      (
        await post(
          "/runs/intake",
          { storeKey: key, key: "k", receipt: intakeReceipt("slack:C1:1.0") },
          { "content-type": "application/json" },
        )
      ).status,
    ).toBe(401);
  });
});

describe("the plane's admission stage — /plane/admit, reservations, the seal's walk (orchestration-plane; record 0064)", () => {
  const requester = "slack:UALICE";
  const admit = (key: string, threadKey: string, text: string) =>
    post("/plane/admit", { storeKey: key, threadKey, requester, request: { text } });

  it("two asks a second apart on one thread: the first is admitted with a reservation, the second queued at position 1; the first's claim promotes the reservation; the seal admits the queued run with its attaching row", async () => {
    const key = storeKey();
    const t = "slack:C1:1.0";
    const one = await admit(key, t, "one");
    expect(one.status).toBe(200);
    expect(one.data.kind).toBe("admitted");
    expect(typeof one.data.reservation).toBe("string");
    const two = await admit(key, t, "two");
    expect(two.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "thread_free", threadKey: t, met: false }],
    });
    const queuedId = two.data.id as string;
    const queued = await post("/plane/queued", { storeKey: key, runId: queuedId });
    expect(queued.data.row).toMatchObject({ runId: queuedId, state: "waiting" });
    expect(queued.data.row).not.toHaveProperty("liveState");
    // The ledger claim promotes the reservation: the row retires in the claim's
    // transaction and the live row holds the thread from there.
    expect((await post("/runs/claim", claimBody(key, "r1", t))).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT * FROM plane_reservations`).toArray()).toEqual([]);
    });
    // A third ask still queues — the thread is live, position ranks it behind the second.
    expect((await admit(key, t, "three")).data).toMatchObject({ kind: "queued", position: 2 });
    // The seal flips thread_free: the queued run is admitted, its admit effect
    // is offered carrying the stored request, and its attaching row exists
    // under the plane's id (the restart-from-request path's shape).
    expect(
      (await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) })).status,
    ).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const effects = inst.openPlaneEffects();
      expect(effects.map((e) => e.id)).toEqual([`admit:${queuedId}`]);
      expect(effects[0]).toMatchObject({ kind: "admit", runId: queuedId, threadKey: t, request: { text: "two" } });
      const live = await inst.listLive();
      const row = live.find((r) => r.runId === queuedId)!;
      expect(row).toMatchObject({ threadKey: t, ownerGen: "plane", phase: "attaching" });
      expect(row.meta.request).toEqual({ text: "two" });
    });
  });

  it("a duplicate admit decision after a roll keeps the effect's first offer and the attaching row (INSERT OR IGNORE)", async () => {
    const key = storeKey();
    const t = "slack:C2:2.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
  });

  it("runs stop on a queued id withdraws it: the row goes withdrawn, a second withdraw answers false, and the seal admits nothing", async () => {
    const key = storeKey();
    const t = "slack:C3:3.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    expect((await post("/plane/withdraw", { storeKey: key, runId: q })).data).toEqual({ withdrawn: true });
    expect((await post("/plane/withdraw", { storeKey: key, runId: q })).data).toEqual({ withdrawn: false });
    expect((await post("/plane/queued", { storeKey: key, runId: q })).data.row).toMatchObject({ state: "withdrawn" });
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });

  it("a pending deploy queues an ask on deploy_settled and deploy.landed flips it, admitting the queued run", async () => {
    const key = storeKey();
    const t = "slack:C4:4.0";
    expect((await post("/plane/deploy", { storeKey: key, phase: "pending" })).status).toBe(200);
    const asked = await admit(key, t, "hi");
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "deploy_settled", met: false }],
    });
    const landed = await post("/plane/deploy", { storeKey: key, phase: "landed", version: "1.0.0" });
    expect(landed.data).toEqual({ ok: true, admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.kind)).toEqual(["admit"]);
    });
  });

  it("effects for a sealed run are dropped at the seal: an admitted-then-finished run's open admit goes with its finish", async () => {
    const key = storeKey();
    const t = "slack:C5:5.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    // The plane's attaching row is another generation's with an expired lease:
    // the reclaim takes it (the restart-from-request path) and its finish seals it.
    const reclaimed = await post("/runs/reclaim", { storeKey: key, gen: "g2", now: Date.now(), leaseMs: LEASE_MS });
    expect((reclaimed.data.runs as Array<{ row: { runId: string } }>).map((r) => r.row.runId)).toContain(q);
    expect((await post("/runs/finish", { storeKey: key, runId: q, gen: "g2", record: record(q, t) })).status).toBe(200);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });

  it("a push that fails leaves the effect on the next heartbeat answer: the bot answered 404, nothing was acked, and the offer rides the heartbeat", async () => {
    const key = storeKey();
    const t = "slack:C6:6.0";
    await admit(key, t, "one");
    await post("/runs/claim", claimBody(key, "r1", t));
    const q = (await admit(key, t, "two")).data.id as string;
    const pushes: { url: string; auth: string | null }[] = [];
    let startedPush!: () => void;
    let finishPush!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      startedPush = resolve;
    });
    const pushCanFinish = new Promise<void>((resolve) => {
      finishPush = resolve;
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      // A BOT binding whose push dead-ends (the container down, an older bot
      // without the route): the fetch answers 404 and delivers nothing.
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async (url: string, init: { headers: Record<string, string> }) => {
            pushes.push({ url: String(url), auth: init.headers.authorization ?? null });
            startedPush();
            await pushCanFinish;
            return new Response("not found", { status: 404 });
          },
        },
      };
    });
    // The seal walks the queue and pushes the admit. Its response stays
    // independent, while waitUntil and the test guard own the unfinished I/O.
    const finishing = post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", t) });
    await pushStarted;
    expect(() => assertNoPendingBackgroundTasks()).toThrow(/plane effect push \(admit:/);
    finishPush();
    await finishing;
    await vi.waitFor(() => expect(() => assertNoPendingBackgroundTasks()).not.toThrow());
    expect(pushes).toEqual([{ url: "https://bot/plane/effects", auth: "Bearer test-token" }]);
    // Nothing was acked: the offer stands and rides the next heartbeat answer.
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
    const t2 = "slack:C6:6.1";
    await post("/runs/claim", claimBody(key, "r2", t2));
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r2", gen: "g1", leaseMs: LEASE_MS });
    expect((beat.data.effects as Array<{ id: string }>).map((e) => e.id)).toEqual([`admit:${q}`]);
  });

  it("validates: a missing threadKey, requester or request is 400; a malformed withdraw run id is 400", async () => {
    const key = storeKey();
    expect((await post("/plane/admit", { storeKey: key, requester, request: {} })).status).toBe(400);
    expect((await post("/plane/admit", { storeKey: key, threadKey: "slack:C1:1.0", request: {} })).status).toBe(400);
    expect(
      (await post("/plane/admit", { storeKey: key, threadKey: "slack:C1:1.0", requester, request: [] })).status,
    ).toBe(400);
    expect((await post("/plane/withdraw", { storeKey: key, runId: "" })).status).toBe(400);
    expect((await post("/plane/deploy", { storeKey: key, phase: "later" })).status).toBe(400);
  });
});

describe("the plane's resident stage — /plane/level, /plane/observe, the re-ask alarm (orchestration-plane item 9; record 0064)", () => {
  const requester = "slack:UALICE";
  const level = (key: string, resident: string, name: string, side: string, generation = "gen-1") =>
    post("/plane/level", { storeKey: key, resident, name, side, generation });
  const residentAsk = (key: string, threadKey: string, resident: string, over: Record<string, unknown> = {}) =>
    post("/plane/admit", {
      storeKey: key,
      threadKey,
      requester,
      request: { text: "code" },
      stage: "resident",
      resident,
      ...over,
    });

  it("a queued admission awaits its alarm scheduling before the RPC response returns", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    let awaited = false;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () =>
        ({
          then(resolve: () => void) {
            awaited = true;
            resolve();
          },
        }) as Promise<void>;
    });

    expect((await residentAsk(key, "slack:C10:0.0", "owner/repo")).data.kind).toBe("queued");
    expect(awaited).toBe(true);
  });

  it("a queued admission returns its committed answer when alarm scheduling fails", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () => Promise.reject(new Error("alarm unavailable"));
    });

    const asked = await residentAsk(key, "slack:C10:0.1", "owner/repo");
    expect(asked).toMatchObject({ status: 200, data: { kind: "queued", position: 1 } });
    expect((await post("/plane/queued", { storeKey: key, runId: asked.data.id })).data.row).toMatchObject({
      state: "waiting",
    });
  });

  it("a level report lands in plane_levels; an above seat queues a resident ask holding no reservation; the below report admits it with its attaching row", async () => {
    const key = storeKey();
    const t = "slack:C10:1.0";
    expect((await level(key, "owner/repo", "seat", "above")).data).toEqual({ admitted: 0 });
    const asked = await residentAsk(key, t, "owner/repo");
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "seat", resident: "owner/repo", met: false }],
    });
    const q = asked.data.id as string;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT resident, name, side FROM plane_levels`).toArray()).toEqual([
        { resident: "owner/repo", name: "seat", side: "above" },
      ]);
      // A resident-stage ask holds nothing: its thread was reserved at admission.
      expect(sql.exec(`SELECT * FROM plane_reservations WHERE run_id = ?`, q).toArray()).toEqual([]);
      expect((await inst.listLive()).find((r) => r.runId === q)).toBeUndefined();
    });
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
      expect((await inst.listLive()).find((r) => r.runId === q)).toMatchObject({
        ownerGen: "plane",
        phase: "attaching",
      });
    });
  });

  it("an observation after the admit's ack re-enters the row and the next below report re-offers the SAME admit — the acked row never swallows it", async () => {
    const key = storeKey();
    const t = "slack:C11:1.0";
    await level(key, "owner/repo", "seat", "above");
    const q = (await residentAsk(key, t, "owner/repo")).data.id as string;
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    // The bot took the offer and acked it done; then the attach met the pool refusal.
    await post("/plane/ack", { storeKey: key, id: `admit:${q}`, outcome: "done" });
    let alarmAwaited = false;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () =>
        ({
          then(resolve: () => void) {
            alarmAwaited = true;
            resolve();
          },
        }) as Promise<void>;
    });
    const observed = await post("/plane/observe", {
      storeKey: key,
      runId: q,
      resident: "owner/repo",
      refusal: "user-pool-exhausted: no free worker user",
    });
    expect(observed.data).toEqual({ reentered: true });
    expect(alarmAwaited).toBe(true);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      // The refusal is evidence: the seat level is written back above.
      expect(sql.exec(`SELECT side FROM plane_levels WHERE resident = 'owner/repo' AND name = 'seat'`).one()).toEqual({
        side: "above",
      });
      expect(sql.exec(`SELECT state FROM plane_queue WHERE run_id = ?`, q).one()).toEqual({ state: "waiting" });
      expect(inst.openPlaneEffects()).toEqual([]);
    });
    // The next below report walks the re-entered row: the admit is offered
    // again despite the acked row under the same id (the pre-insert delete).
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${q}`]);
    });
    // An observation for a run the queue holds waiting (not admitted) is a no-op.
    expect(
      (
        await post("/plane/observe", {
          storeKey: key,
          runId: "unknown-run",
          resident: "owner/repo",
          refusal: "draining",
        })
      ).data,
    ).toEqual({ reentered: false });
  });

  it("an observation returns its committed re-entry when alarm scheduling fails", async () => {
    const key = storeKey();
    await level(key, "owner/repo", "seat", "above");
    const q = (await residentAsk(key, "slack:C11:1.1", "owner/repo")).data.id as string;
    expect((await level(key, "owner/repo", "seat", "below")).data).toEqual({ admitted: 1 });
    await post("/plane/ack", { storeKey: key, id: `admit:${q}`, outcome: "done" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const alarm = inst as unknown as { ensurePlaneReaskAlarm(now: number): Promise<void> };
      alarm.ensurePlaneReaskAlarm = () => Promise.reject(new Error("alarm unavailable"));
    });

    expect(
      await post("/plane/observe", {
        storeKey: key,
        runId: q,
        resident: "owner/repo",
        refusal: "draining",
      }),
    ).toMatchObject({ status: 200, data: { reentered: true } });
    expect((await post("/plane/queued", { storeKey: key, runId: q })).data.row).toMatchObject({ state: "waiting" });
  });

  it("a drain post opens the resident-drain window — an ask queues on it, a restartOf passes — and the below post lifts it, admitting the queued run", async () => {
    const key = storeKey();
    const t = "slack:C12:1.0";
    expect((await level(key, "registry", "drain", "above")).data).toEqual({ admitted: 0 });
    const asked = await post("/plane/admit", { storeKey: key, threadKey: t, requester, request: { text: "hi" } });
    expect(asked.data).toMatchObject({
      kind: "queued",
      position: 1,
      waiting: [{ kind: "window_open", window: "resident-drain", met: false }],
    });
    // A restart of a run the resident already holds passes the window.
    expect(
      (
        await post("/plane/admit", {
          storeKey: key,
          threadKey: "slack:C12:2.0",
          requester,
          request: {},
          restartOf: true,
        })
      ).data.kind,
    ).toBe("admitted");
    expect((await level(key, "registry", "drain", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects().map((e) => e.id)).toEqual([`admit:${asked.data.id as string}`]);
    });
  });

  it("the re-ask alarm probes a silent resident within the cadence, pulls the sweep alarm forward, and re-offers the probe after its ack", async () => {
    const key = storeKey();
    const cadence = 60_000;
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    await level(key, "owner/repo", "memory", "above");
    const asked = await residentAsk(key, "slack:C13:1.0", "owner/repo", { reaskMs: cadence });
    expect(asked.data).toMatchObject({
      kind: "queued",
      waiting: [{ kind: "memory", resident: "owner/repo", met: false }],
    });
    // The cadence's pull-forward, judged directly on the private ensure (the
    // pool's alarm helper deletes the scheduled alarm around a trigger, so its
    // stored time cannot be read back after one): a far sweep alarm is pulled
    // to the cadence; an earlier alarm is never pushed back.
    type WithAlarm = {
      ctx: DurableObjectState;
      sql: SqlStorage;
      ensurePlaneReaskAlarm(now: number): Promise<void>;
    };
    await runInDurableObject(stub, async (inst: RunHistoryDO) => {
      const priv = inst as unknown as WithAlarm;
      const now = Date.now();
      await priv.ctx.storage.setAlarm(now + 6 * 3_600_000);
      await priv.ensurePlaneReaskAlarm(now);
      expect(((await priv.ctx.storage.getAlarm()) as number) - now).toBeLessThanOrEqual(cadence);

      const sooner = now + cadence / 2;
      await priv.ctx.storage.setAlarm(sooner);
      await priv.ensurePlaneReaskAlarm(now);
      expect(await priv.ctx.storage.getAlarm()).toBe(sooner);

      // Make the report old enough for a probe without installing a native,
      // one-millisecond alarm that can still be in flight after this case.
      priv.sql.exec(`UPDATE plane_levels SET reported_at = ? WHERE resident = ?`, now - cadence - 1, "owner/repo");
    });
    const openIds = () =>
      runInDurableObject(stub, async (inst: RunHistoryDO) => inst.openPlaneEffects().map((e) => e.id));

    // The helper consumes and awaits the alarm handler. Its re-armed future
    // slot is then consumed the same way, so no handler crosses the test edge.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await openIds()).toEqual(["probe:owner/repo"]);
    await post("/plane/ack", { storeKey: key, id: "probe:owner/repo", outcome: "done" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await openIds()).toEqual(["probe:owner/repo"]);

    await post("/plane/ack", { storeKey: key, id: "probe:owner/repo", outcome: "done" });
    expect((await level(key, "owner/repo", "memory", "below")).data).toEqual({ admitted: 1 });
    await runInDurableObject(stub, async (inst: RunHistoryDO) => {
      await (inst as unknown as WithAlarm).ctx.storage.deleteAlarm();
    });
  });

  it("validates: a level with a missing resident, a bad name or side, or a non-string generation is 400; an observation with a bad run id, missing resident or empty refusal is 400", async () => {
    const key = storeKey();
    expect((await post("/plane/level", { storeKey: key, name: "seat", side: "below", generation: "g" })).status).toBe(
      400,
    );
    expect(
      (await post("/plane/level", { storeKey: key, resident: "r", name: "cpu", side: "below", generation: "g" }))
        .status,
    ).toBe(400);
    expect(
      (await post("/plane/level", { storeKey: key, resident: "r", name: "seat", side: "over", generation: "g" }))
        .status,
    ).toBe(400);
    expect((await post("/plane/level", { storeKey: key, resident: "r", name: "seat", side: "below" })).status).toBe(
      400,
    );
    expect(
      (await post("/plane/observe", { storeKey: key, runId: "no spaces!", resident: "r", refusal: "draining" })).status,
    ).toBe(400);
    expect((await post("/plane/observe", { storeKey: key, runId: "r1", refusal: "draining" })).status).toBe(400);
    expect((await post("/plane/observe", { storeKey: key, runId: "r1", resident: "r", refusal: "" })).status).toBe(400);
  });
});

describe("the plane's checkpoint steers and the provider condition — the heartbeat body, /plane/park, /plane/level provider (record 0064)", () => {
  const SENTENCE =
    "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push";
  const beat = (key: string, runId: string, facts?: Record<string, unknown>) =>
    post("/runs/heartbeat", { storeKey: key, runId, gen: "g1", leaseMs: 30_000, ...(facts ? { facts } : {}) });
  const facts = (round: number, over: Record<string, unknown> = {}) => ({
    round,
    coding: true,
    startedAt: 1,
    inFlight: { callId: "c1", tool: "bash", sinceAt: 1, boundMs: 1 },
    ...over,
  });
  const inbox = async (key: string, runId: string) =>
    (await post("/runs/inbox/read", { storeKey: key, runId, afterSeq: 0 })).data.items as Array<{
      seq: number;
      message: Record<string, unknown>;
    }>;

  it("a heartbeat whose facts cross a bound writes ONE inbox row — the fixed sentence, sender plane — in the heartbeat's own transaction; a second beat in the round writes none, a new round writes one, a second cause repeats no sentence", async () => {
    const key = storeKey();
    const t = "slack:C20:1.0";
    await post("/runs/claim", claimBody(key, "r1", t));
    expect((await beat(key, "r1", facts(1))).status).toBe(200);
    let items = await inbox(key, "r1");
    expect(items).toHaveLength(1);
    expect(items[0].message).toMatchObject({ text: SENTENCE, userId: "plane" });
    // Same round, same cause: nothing more; a second cause (no_push, far past the window) records its row but repeats no sentence.
    await beat(key, "r1", facts(1));
    await beat(key, "r1", facts(1, { inFlight: undefined, startedAt: 1, pushedHead: undefined }));
    expect(await inbox(key, "r1")).toHaveLength(1);
    // A new round steers once more.
    await beat(key, "r1", facts(2));
    items = await inbox(key, "r1");
    expect(items).toHaveLength(2);
    expect(items[1].message).toMatchObject({ text: SENTENCE, userId: "plane" });
  });

  it("a facts-less heartbeat and healthy facts steer nothing", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r2", "slack:C20:2.0"));
    await beat(key, "r2");
    await beat(key, "r2", {
      round: 1,
      coding: true,
      startedAt: Date.now(),
      inFlight: { callId: "c", tool: "bash", sinceAt: Date.now(), boundMs: 600_000 },
    });
    expect(await inbox(key, "r2")).toEqual([]);
  });

  it("a provider down and parked live run recover atomically as one durable row and one pushed offered steer; repeat up writes nothing", async () => {
    const key = storeKey();
    const pushed: Array<Record<string, unknown>> = [];
    await post("/runs/claim", claimBody(key, "r3", "slack:C20:3.0"));
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async (_url: string, init: { body: string }) => {
            pushed.push(JSON.parse(init.body) as Record<string, unknown>);
            return new Response("ok");
          },
        },
      };
    });
    expect(
      (
        await post("/plane/level", {
          storeKey: key,
          name: "provider",
          provider: "anthropic",
          side: "down",
          cause: "credit-or-quota-exhausted",
        })
      ).data,
    ).toEqual({ admitted: 0 });
    expect((await post("/plane/park", { storeKey: key, runId: "r3", provider: "anthropic" })).data).toEqual({
      parked: true,
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT resident, name, side, cause FROM plane_levels`).toArray()).toEqual([
        {
          resident: "anthropic",
          name: "provider",
          side: "above",
          cause: "credit-or-quota-exhausted",
        },
      ]);
      expect(sql.exec(`SELECT kind, key FROM plane_reservations`).toArray()).toEqual([
        { kind: "park", key: "anthropic#r3" },
      ]);
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    const items = await inbox(key, "r3");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      seq: 1,
      message: { userId: "plane", plane: { steer: "reissue", provider: "anthropic" } },
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const effect = (pushed[0]!.effects as Array<Record<string, unknown>>)[0];
    expect(effect).toMatchObject({
      id: "steer:r3:1",
      kind: "steer",
      runId: "r3",
      seq: 1,
      message: items[0]!.message,
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT * FROM plane_reservations WHERE kind = 'park'`).toArray()).toEqual([]);
      expect(inst.openPlaneEffects()).toEqual([effect]);
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    expect(await inbox(key, "r3")).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it("fences a pushed steer and renews its owner's lease atomically before registry delivery", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r-fenced", "slack:C20:3.1", "gen-stale"));
    await post("/plane/park", { storeKey: key, runId: "r-fenced", provider: "anthropic" });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });

    expect(
      (
        await post("/plane/steer/fence", {
          storeKey: key,
          id: "steer:r-fenced:1",
          runId: "r-fenced",
          gen: "gen-stale",
          leaseMs: LEASE_MS,
        })
      ).data,
    ).toEqual({ accepted: true });
    const [row] = (await post("/runs/live", { storeKey: key })).data.runs as Array<{ leaseUntil: number }>;
    expect(
      (
        await post("/runs/reclaim", {
          storeKey: key,
          gen: "gen-owner",
          now: row!.leaseUntil - 1,
          leaseMs: LEASE_MS,
        })
      ).data.runs,
    ).toEqual([]);
    expect(
      (
        await post("/runs/reclaim", {
          storeKey: key,
          gen: "gen-owner",
          now: row!.leaseUntil,
          leaseMs: LEASE_MS,
        })
      ).data.runs,
    ).toMatchObject([{ row: { runId: "r-fenced", ownerGen: "gen-owner" } }]);
    expect(
      (
        await post("/plane/steer/fence", {
          storeKey: key,
          id: "steer:r-fenced:1",
          runId: "r-fenced",
          gen: "gen-stale",
          leaseMs: LEASE_MS,
        })
      ).data,
    ).toEqual({ accepted: false });
  });

  it("a stale generation cannot close a steer offer after reclaim; the durable owner heartbeat receives and closes it", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r-owner", "slack:C20:3.1", "gen-stale"));
    await post("/plane/park", { storeKey: key, runId: "r-owner", provider: "anthropic" });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    const reclaimed = await post("/runs/reclaim", {
      storeKey: key,
      gen: "gen-owner",
      now: Date.now() + 2 * LEASE_MS,
      leaseMs: LEASE_MS,
    });
    expect(reclaimed.data.runs).toMatchObject([{ row: { runId: "r-owner", ownerGen: "gen-owner" } }]);

    await post("/plane/ack", {
      storeKey: key,
      id: "steer:r-owner:1",
      outcome: "done",
      owner: { runId: "r-owner", gen: "gen-stale" },
    });
    const ownerBeat = () =>
      post("/runs/heartbeat", { storeKey: key, runId: "r-owner", gen: "gen-owner", leaseMs: LEASE_MS });
    expect((await ownerBeat()).data.effects).toMatchObject([{ id: "steer:r-owner:1", kind: "steer", seq: 1 }]);

    await post("/plane/ack", {
      storeKey: key,
      id: "steer:r-owner:1",
      outcome: "done",
      owner: { runId: "r-owner", gen: "gen-owner" },
    });
    expect((await ownerBeat()).data.effects).toEqual([]);
  });

  it("a failed provider-up transaction writes neither the durable row nor its steer effect", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r4", "slack:C20:4.0"));
    await post("/plane/park", { storeKey: key, runId: "r4", provider: "anthropic" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      for (let i = 0; i < 256; i++)
        sql.exec(
          `INSERT INTO plane_effects (id, body_json, offered_at, acked_at) VALUES (?, ?, ?, NULL)`,
          `probe:cap-${i}`,
          JSON.stringify({ id: `probe:cap-${i}`, kind: "probe", resident: `r-${i}` }),
          i,
        );
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      expect(() => inst.planeLevel({ name: "provider", provider: "anthropic", side: "up" }, Date.now())).toThrow(
        /plane_effects total cap/,
      );
    });
    expect(await inbox(key, "r4")).toEqual([]);
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const sql = (inst as unknown as { sql: SqlStorage }).sql;
      expect(sql.exec(`SELECT COUNT(*) AS n FROM plane_effects`).one().n).toBe(256);
      expect(sql.exec(`SELECT key FROM plane_reservations WHERE kind = 'park'`).toArray()).toEqual([
        { key: "anthropic#r4" },
      ]);
    });
  });

  it("a failed live push leaves both the durable row and steer offer for an owner heartbeat; sealing first removes the park and produces no steer", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r5", "slack:C20:5.0"));
    await post("/plane/park", { storeKey: key, runId: "r5", provider: "anthropic" });
    let pushed!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      pushed = resolve;
    });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const withBot = inst as unknown as { env: Record<string, unknown> };
      withBot.env = {
        ...withBot.env,
        BOT: {
          fetch: async () => {
            pushed();
            return new Response("down", { status: 503 });
          },
        },
      };
    });
    await post("/plane/level", { storeKey: key, name: "provider", provider: "anthropic", side: "up" });
    await pushStarted;
    expect(await inbox(key, "r5")).toHaveLength(1);
    const beat = await post("/runs/heartbeat", { storeKey: key, runId: "r5", gen: "g1", leaseMs: LEASE_MS });
    expect(beat.data.effects).toMatchObject([{ id: "steer:r5:1", kind: "steer", seq: 1 }]);

    const sealedKey = storeKey();
    const thread = "slack:C20:5.1";
    await post("/runs/claim", claimBody(sealedKey, "r6", thread));
    await post("/plane/park", { storeKey: sealedKey, runId: "r6", provider: "anthropic" });
    await post("/runs/finish", { storeKey: sealedKey, runId: "r6", gen: "g1", record: record("r6", thread) });
    await post("/plane/level", { storeKey: sealedKey, name: "provider", provider: "anthropic", side: "up" });
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(sealedKey)), async (inst: RunHistoryDO) => {
      expect(inst.openPlaneEffects()).toEqual([]);
    });
  });
});

describe("the plane's endings and the alarm — the cause on close, /plane/reclaimed, the lease-end offer (record 0064)", () => {
  const TAG = { parentInstanceId: "ship_acme_api_1", idempotencyKey: "ship_acme_api_1:u12/0/coding" };
  type Sent = { instance: string; type: string; payload: unknown };

  /** The Workflow binding doubled on the live object (item 47's pattern). */
  async function coordinatorDouble(key: string): Promise<Sent[]> {
    const sent: Sent[] = [];
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const holder = inst as unknown as { env: Record<string, unknown> };
      holder.env = {
        ...holder.env,
        SHIP_COORDINATOR: {
          get: async (id: string) => ({
            sendEvent: async (event: { type: string; payload: unknown }) => {
              sent.push({ instance: id, type: event.type, payload: event.payload });
            },
          }),
        },
      };
    });
    return sent;
  }

  async function endingOf(key: string, runId: string): Promise<unknown> {
    let ending: unknown;
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      ending = inst.planeEndingOf(runId);
    });
    return ending;
  }

  it("the owner's finish records ended {kind, cause} exactly when the row closes — completed maps to completed, an interrupted record with `restarting` to resident_replaced, a bare interrupted to lease_lapsed — and the first cause stands", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:1.0"));
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:1.0") });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "completed", cause: "completed" });
    await post("/runs/claim", claimBody(key, "r2", "slack:C1:2.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r2",
      gen: "g1",
      record: { ...record("r2", "slack:C1:2.0"), status: "interrupted", restarting: true },
    });
    expect(await endingOf(key, "r2")).toMatchObject({ kind: "interrupted", cause: "resident_replaced" });
    await post("/runs/claim", claimBody(key, "r3", "slack:C1:3.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r3",
      gen: "g1",
      record: { ...record("r3", "slack:C1:3.0"), status: "interrupted" },
    });
    expect(await endingOf(key, "r3")).toMatchObject({ kind: "interrupted", cause: "lease_lapsed" });
    // First cause stands: a later report cannot rewrite r2's ending.
    const again = await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "r2", outcome: "closed" }] });
    expect(again.data).toEqual({ recorded: [{ runId: "r2", cause: "resident_replaced" }] });
    expect(await endingOf(key, "r2")).toMatchObject({ cause: "resident_replaced" });
  });

  it("a same-id successor's finish replaces a standing resident_replaced — a restarting close is the run continuing, not its end, so a restarted run that completes reads completed as its record does", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:9.0"));
    await post("/runs/finish", {
      storeKey: key,
      runId: "r1",
      gen: "g1",
      record: { ...record("r1", "slack:C1:9.0"), status: "interrupted", restarting: true },
    });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "interrupted", cause: "resident_replaced" });
    // The restart reuses the run's id (run-history item 42) and completes.
    await post("/runs/claim", claimBody(key, "r1", "slack:C1:9.0"));
    await post("/runs/finish", { storeKey: key, runId: "r1", gen: "g1", record: record("r1", "slack:C1:9.0") });
    expect(await endingOf(key, "r1")).toMatchObject({ kind: "completed", cause: "completed" });
    // A completed ending is final: a later report cannot rewrite it.
    await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "r1", outcome: "closed" }] });
    expect(await endingOf(key, "r1")).toMatchObject({ cause: "completed" });
  });

  it("/plane/reclaimed records lease_lapsed for a closed row and nothing for resume, restart or rehost — a roll that resumes every row assigns nothing", async () => {
    const key = storeKey();
    const r = await post("/plane/reclaimed", {
      storeKey: key,
      outcomes: [
        { runId: "a", outcome: "resume" },
        { runId: "b", outcome: "restart" },
        { runId: "c", outcome: "rehost" },
        { runId: "d", outcome: "closed" },
      ],
    });
    expect(r).toEqual({ status: 200, data: { recorded: [{ runId: "d", cause: "lease_lapsed" }] } });
    expect(await endingOf(key, "a")).toBeNull();
    expect(await endingOf(key, "b")).toBeNull();
    expect(await endingOf(key, "c")).toBeNull();
    expect(await endingOf(key, "d")).toMatchObject({ kind: "interrupted", cause: "lease_lapsed" });
    // A malformed word is refused by name.
    expect(
      (await post("/plane/reclaimed", { storeKey: key, outcomes: [{ runId: "x", outcome: "ended" }] })).status,
    ).toBe(400);
  });

  it("a claim whose meta carries restartOf under a coordinator sends the parent one child-resumed-<runId>; a claim without restartOf sends nothing; a Worker without the binding claims as before", async () => {
    const key = storeKey();
    const sent = await coordinatorDouble(key);
    const meta = { ...claimBody(key, "r1", "slack:C2:1.0").run.meta, ...TAG, restartOf: "r1" };
    expect((await post("/runs/claim", claimBody(key, "r1", "slack:C2:1.0", "g1", { meta }))).data).toEqual({
      ok: true,
    });
    expect(sent).toEqual([
      {
        instance: "ship_acme_api_1",
        type: "child-resumed-r1",
        payload: expect.objectContaining({ runId: "r1", kind: "resumed", parentInstanceId: "ship_acme_api_1" }),
      },
    ]);
    // Without restartOf: a plain claim under the same coordinator says nothing.
    await post(
      "/runs/claim",
      claimBody(key, "r2", "slack:C2:2.0", "g1", {
        meta: { ...claimBody(key, "r2", "slack:C2:2.0").run.meta, ...TAG },
      }),
    );
    expect(sent).toHaveLength(1);
    // A Worker without the binding: the claim still lands (no throw, no send).
    const bare = storeKey();
    expect(
      (
        await post(
          "/runs/claim",
          claimBody(bare, "r9", "slack:C2:9.0", "g1", {
            meta: { ...claimBody(bare, "r9", "slack:C2:9.0").run.meta, ...TAG, restartOf: "r9" },
          }),
        )
      ).data,
    ).toEqual({ ok: true });
  });

  it("the alarm at a lease end offers the row and never ends a run — the row stays live and unclosed, and the owner's heartbeat re-arms the alarm to the new earliest", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C3:1.0"));
    const stub = env.RUNS.get(env.RUNS.idFromName(key));
    const armed = await runInDurableObject(stub, async (inst: RunHistoryDO) =>
      (inst as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm(),
    );
    expect(armed).not.toBeNull();
    // The claim armed the alarm at the lease end (within the lease, not the 6 h sweep).
    expect(armed! - Date.now()).toBeLessThanOrEqual(LEASE_MS);
    // Fire it as if the lease end passed: the row is offered, never closed.
    expect(await runDurableObjectAlarm(env.RUNS.get(env.RUNS.idFromName(key)))).toBe(true);
    const live = await post("/runs/live", { storeKey: key });
    expect((live.data.runs as { runId: string }[]).map((r) => r.runId)).toEqual(["r1"]);
    expect(await endingOf(key, "r1")).toBeNull();
    // The owner's heartbeat extends the lease and moves the plane's alarm on.
    await post("/runs/heartbeat", { storeKey: key, runId: "r1", gen: "g1", leaseMs: LEASE_MS });
    const rearmed = await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) =>
      (inst as unknown as { ctx: { storage: { getAlarm(): Promise<number | null> } } }).ctx.storage.getAlarm(),
    );
    expect(rearmed).not.toBeNull();
    expect(rearmed!).toBeGreaterThanOrEqual(armed!);
  });

  it("a consumed alarm never strands a static due — ensurePlaneAlarm judges the armed slot, not the meta row, and an earlier foreign alarm is left to fire first", async () => {
    const key = storeKey();
    await post("/runs/claim", claimBody(key, "r1", "slack:C3:2.0"));
    type WithAlarm = {
      ctx: { storage: { getAlarm(): Promise<number | null>; setAlarm(at: number): Promise<void> } };
      ensurePlaneAlarm(now: number): Promise<void>;
    };
    await runInDurableObject(env.RUNS.get(env.RUNS.idFromName(key)), async (inst: RunHistoryDO) => {
      const priv = inst as unknown as WithAlarm;
      const now = Date.now();
      // An earlier alarm (the re-ask's) fired and was consumed; the handler
      // re-armed the sweep far out. The earliest due (the lease end) did not
      // move, so the meta row still equals it — the wake must be re-armed.
      await priv.ctx.storage.setAlarm(now + 6 * 3_600_000);
      await priv.ensurePlaneAlarm(now);
      expect(((await priv.ctx.storage.getAlarm()) as number) - now).toBeLessThanOrEqual(LEASE_MS);
      // An earlier alarm someone else armed is left to fire first.
      const sooner = now + 1;
      await priv.ctx.storage.setAlarm(sooner);
      await priv.ensurePlaneAlarm(now);
      expect(await priv.ctx.storage.getAlarm()).toBe(sooner);
    });
  });
});
