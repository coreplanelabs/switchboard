import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../src/core/runRecord.ts";
import { FRICTION_CATEGORIES } from "../../src/core/runFriction.ts";
import { LEASE_MS } from "../../src/core/runLedger/types.ts";

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
  hasTimings: false,
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
    expect(hb).toEqual({ status: 200, data: { ok: true, stop: "soft", phase: "live" } });
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
    expect(fin).toEqual({ status: 200, data: { ok: true, stored: true } });
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
});
