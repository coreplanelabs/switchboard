import { describe, expect, it } from "vitest";
import { secretsFrom } from "../secrets.js";
import type { ChatMessage } from "./chatMessage.js";
import { buildRunLedger, WorkerRunLedger, type WorkerRunLedgerOptions } from "./runLedgerWorker.js";
import { createLedgerWriteThrough } from "./runLedger/writeThrough.js";
import { pointOf } from "./runMetrics.js";
import { ATTACHMENT_REF_BYTES, LEASE_MS, type ClaimRequest, type IntakeReceipt } from "./runLedger/types.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "./runStoreWorker.js";

// The Worker client (docs/reference/specs/run-history.md item 28): routes, bodies, the
// step write's order (transcript before record), fenced answers as results,
// and the same error classes as the run store.

function stubWorker(
  answer: (path: string, body: Record<string, unknown>) => { status: number; data?: unknown } = () => ({
    status: 200,
    data: { ok: true },
  }),
  opts: Partial<WorkerRunLedgerOptions> = {},
) {
  const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const a = answer(url.pathname, body);
    return new Response(a.data === undefined ? "" : JSON.stringify(a.data), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  };
  const ledger = new WorkerRunLedger({
    baseUrl: "https://memory.test/",
    token: "tok",
    storeKey: "runs:default",
    fetch: fetchImpl,
    ...opts,
  });
  return { ledger, calls };
}

/** A finished record as `finish` posts one — minimal but whole enough for the
 *  point the client computes beside it (`pointOf`). */
const finishRecord = (over: Record<string, unknown> = {}) =>
  ({
    id: "r1",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1.0",
    startedAt: 1_000,
    finishedAt: 2_000,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: { eventCount: 0, toolCalls: 0, byCategory: {}, findings: [], verdict: "ok" },
    ...over,
  }) as unknown as import("./runRecord.js").RunRecord;

const claimReq: ClaimRequest = {
  runId: "r1",
  threadKey: "slack:C1:1.0",
  gen: "g1",
  leaseMs: LEASE_MS,
  startedAt: 1_000,
  meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1.0" },
  system: "s",
  tools: [],
};

describe("WorkerRunLedger", () => {
  it("claim posts the run under the store key with the bearer and nothing else — a run's transcript object is never owned; a 409 thread-live is a result", async () => {
    const w = stubWorker();
    expect(await w.ledger.claim(claimReq)).toEqual({ ok: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/claim"]);
    expect(w.calls[0].auth).toBe("Bearer tok");
    expect(w.calls[0].body).toEqual({ storeKey: "runs:default", run: claimReq });

    const busy = stubWorker(() => ({
      status: 409,
      data: { ok: false, reason: "thread-live", live: { runId: "r0", agent: "coding", startedAt: 5 } },
    }));
    expect(await busy.ledger.claim(claimReq)).toEqual({
      ok: false,
      reason: "thread-live",
      live: { runId: "r0", agent: "coding", startedAt: 5 },
    });
    expect(busy.calls).toHaveLength(1);
  });

  it("step writes the transcript turns FIRST (chunked rows, attachments one per request), then the step record; a fenced transcript write stops before the record", async () => {
    const w = stubWorker();
    const big: ChatMessage = {
      role: "user",
      content: [{ type: "image", mediaType: "image/png", data: "Z".repeat(ATTACHMENT_REF_BYTES + 1) }],
    };
    const assistant: ChatMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const record = {
      step: 1,
      seq: 3,
      turnIndex: 2,
      inFlight: [],
      inboxConsumedSeq: 0,
      remainingMs: 1,
      turn: 1,
      iteration: 1,
    };
    expect(
      await w.ledger.step("r1", "g1", record, [
        { idx: 0, message: big },
        { idx: 1, message: assistant },
      ]),
    ).toEqual({ ok: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/transcript/write", "/runs/transcript/write", "/runs/step"]);
    expect((w.calls[0].body.attachments as unknown[]).length).toBe(1);
    expect((w.calls[0].body.rows as unknown[]).length).toBe(0);
    expect((w.calls[1].body.rows as unknown[]).length).toBe(2);
    expect(w.calls[2].body).toEqual({ storeKey: "runs:default", runId: "r1", gen: "g1", record });

    const fenced = stubWorker((path) =>
      path === "/runs/transcript/write"
        ? { status: 409, data: { ok: false, reason: "fenced" } }
        : { status: 200, data: { ok: true } },
    );
    expect(await fenced.ledger.step("r1", "g1", record, [{ idx: 0, message: assistant }])).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(fenced.calls.map((c) => c.path)).toEqual(["/runs/transcript/write"]);
  });

  it("heartbeat returns the stop and phase the Worker answers; a 409 is fenced or unknown-run by the Worker's reason", async () => {
    const w = stubWorker(() => ({ status: 200, data: { ok: true, stop: "soft", phase: "live" } }));
    // An older Worker's answer has no effects field: read as none offered (orchestration-plane item 7).
    expect(await w.ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({
      ok: true,
      stop: "soft",
      phase: "live",
      effects: [],
    });
    const unknown = stubWorker(() => ({ status: 409, data: { ok: false, reason: "unknown-run" } }));
    expect(await unknown.ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({ ok: false, reason: "unknown-run" });
  });

  it("planeFenceSteer asks the object to atomically renew ownership before local delivery", async () => {
    const w = stubWorker(() => ({ status: 200, data: { accepted: true } }));
    await expect(w.ledger.planeFenceSteer("steer:r1:7", "r1", "g1", LEASE_MS)).resolves.toBe(true);
    expect(w.calls).toEqual([
      {
        path: "/plane/steer/fence",
        auth: "Bearer tok",
        body: {
          storeKey: "runs:default",
          id: "steer:r1:7",
          runId: "r1",
          gen: "g1",
          leaseMs: LEASE_MS,
        },
      },
    ]);
  });

  it("planeAck carries the authoritative owner fence for a steer", async () => {
    const w = stubWorker();
    await w.ledger.planeAck("steer:r1:7", "done", { runId: "r1", gen: "g1" });
    expect(w.calls).toEqual([
      {
        path: "/plane/ack",
        auth: "Bearer tok",
        body: {
          storeKey: "runs:default",
          id: "steer:r1:7",
          outcome: "done",
          owner: { runId: "r1", gen: "g1" },
        },
      },
    ]);
  });

  it("append with no events posts nothing; finish clears nothing and releases the session's owner best-effort when the record names one; reclaim re-owns a session log for a row with a session and the transcript object for one without", async () => {
    const session = { key: "slack:C1:1.0:review", seedFrom: 0, request: 0, range: { from: 0 } };
    const w = stubWorker((path) =>
      path === "/runs/reclaim"
        ? {
            status: 200,
            data: { runs: [{ row: { runId: "a", meta: { session } } }, { row: { runId: "b", meta: {} } }] },
          }
        : path === "/runs/finish"
          ? { status: 200, data: { ok: true, stored: true } }
          : path === "/runs/session/clear-owner"
            ? { status: 500 }
            : { status: 200, data: { ok: true } },
    );
    expect(await w.ledger.append("r1", "g1", [])).toEqual({ ok: true });
    expect(w.calls).toHaveLength(0);
    const plain = finishRecord();
    expect(await w.ledger.finish("r1", "g1", plain)).toEqual({ ok: true, stored: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/finish"]);
    const withSession = finishRecord({ session: { ...session, range: { from: 0, to: 4 } } });
    expect(await w.ledger.finish("r1", "g1", withSession)).toEqual({ ok: true, stored: true });
    expect(w.calls.slice(1).map((c) => [c.path, c.body.key ?? c.body.runId])).toEqual([
      ["/runs/finish", "r1"],
      ["/runs/session/clear-owner", "slack:C1:1.0:review"],
    ]);
    expect(w.calls[2].body).toEqual({ key: "slack:C1:1.0:review", runId: "r1", gen: "g1" });
    const taken = await w.ledger.reclaim("g2", 10, LEASE_MS);
    expect(taken.map((r) => r.row.runId)).toEqual(["a", "b"]);
    expect(w.calls.slice(3).map((c) => [c.path, c.body.key ?? c.body.runId])).toEqual([
      ["/runs/reclaim", undefined],
      ["/runs/session/owner", "slack:C1:1.0:review"],
      ["/runs/transcript/owner", "b"],
    ]);
    expect(w.calls[4].body).toMatchObject({ key: "slack:C1:1.0:review", runId: "a", gen: "g2" });
  });

  it("the session routes: tail, owner with the configured byte budget, seed and step writes into the log at their indices, a range read re-based to the range, the tail read, release", async () => {
    const rows = [
      { idx: 3, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "go" } }) },
      { idx: 4, part: 0, json: JSON.stringify({ role: "assistant", part: { type: "text", text: "ok" } }) },
    ];
    const w = stubWorker((path) =>
      path === "/runs/session/tail"
        ? { status: 200, data: { next: 3 } }
        : path === "/runs/session/read"
          ? { status: 200, data: { rows, attachments: [] } }
          : path === "/runs/session/read-tail"
            ? { status: 200, data: { rows, attachments: [], from: 3 } }
            : path === "/runs/session/write"
              ? { status: 200, data: { ok: true, bytes: 120 } }
              : { status: 200, data: { ok: true } },
    );
    const key = "slack:C1:1.0:review";
    expect(await w.ledger.sessionTail(key)).toBe(3);
    expect(w.calls[0]).toMatchObject({ path: "/runs/session/tail", body: { key } });
    await w.ledger.claimSession(key, "r1", "g1");
    expect(w.calls[1]).toMatchObject({
      path: "/runs/session/owner",
      body: { key, runId: "r1", gen: "g1", maxBytes: 200 * 1024 * 1024 },
    });
    const go: ChatMessage = { role: "user", content: [{ type: "text", text: "go" }] };
    expect(await w.ledger.seed("r1", "g1", [{ idx: 3, message: go }], key)).toEqual({ ok: true });
    expect(w.calls[2]).toMatchObject({ path: "/runs/session/write", body: { key, gen: "g1", rows: [rows[0]] } });
    expect(
      await w.ledger.step(
        "r1",
        "g1",
        { step: 1, seq: 0, turnIndex: 2, inFlight: [], inboxConsumedSeq: 0, remainingMs: 1, turn: 1, iteration: 0 },
        [{ idx: 4, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }],
        key,
      ),
    ).toEqual({ ok: true });
    expect(w.calls.slice(3).map((c) => c.path)).toEqual(["/runs/session/write", "/runs/step"]);
    const read = await w.ledger.readSession(key, 3, 4);
    expect(w.calls[5]).toMatchObject({ path: "/runs/session/read", body: { key, from: 3, to: 4 } });
    expect(read).toEqual({
      complete: true,
      turns: 2,
      messages: [go, { role: "assistant", content: [{ type: "text", text: "ok" }] }],
      compactions: [],
    });
    const tail = await w.ledger.readSessionTail(key, 240_000);
    expect(w.calls[6]).toMatchObject({ path: "/runs/session/read-tail", body: { key, maxBytes: 240_000 } });
    expect(tail.from).toBe(3);
    expect(tail.transcript.messages).toHaveLength(2);
    expect(await w.ledger.releaseSession(key, "r1", "g1")).toEqual({ ok: true });
    expect(w.calls[7]).toMatchObject({ path: "/runs/session/clear-owner", body: { key, runId: "r1", gen: "g1" } });
    // Without a session the seed still goes to the run's own transcript object (an adopted older row).
    await w.ledger.seed("r1", "g1", [{ idx: 0, message: go }]);
    expect(w.calls[8].path).toBe("/runs/transcript/write");
  });

  // session-log.md item 12: the actor a turn carries rides the stored row's JSON.
  it("a seed turn's actor rides the stored row's JSON; a turn without one stores none", async () => {
    const w = stubWorker(() => ({ status: 200, data: { ok: true } }));
    const key = "slack:C1:1.0:review";
    const go: ChatMessage = { role: "user", content: [{ type: "text", text: "go" }] };
    const ok: ChatMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    expect(
      await w.ledger.seed(
        "r1",
        "g1",
        [
          { idx: 3, message: go, actor: "slack:UALICE" },
          { idx: 4, message: ok },
        ],
        key,
      ),
    ).toEqual({ ok: true });
    const write = w.calls.find((c) => c.path === "/runs/session/write")!;
    const rows = write.body.rows as { idx: number; json: string }[];
    expect(JSON.parse(rows[0].json)).toMatchObject({ role: "user", actor: "slack:UALICE" });
    expect("actor" in JSON.parse(rows[1].json)).toBe(false);
  });

  // session-log.md item 10: the routes `recall` and `notes` read and write through.
  it("the search and notepad routes: search posts the key, query and limit and answers the hits and gaps as sent (nothing when the Worker sends none); the notepad read answers the text and time or null; the notepad write is fenced like a row write", async () => {
    const hits = [{ idx: 4, part: 0, role: "user", kind: "text", text: "fix the lockfile" }];
    const w = stubWorker((path) =>
      path === "/runs/session/search"
        ? { status: 200, data: { hits, gaps: [2] } }
        : path === "/runs/session/notepad"
          ? { status: 200, data: { notepad: { text: "keep the helper", updatedAt: 5_000 } } }
          : path === "/runs/session/notepad/write"
            ? { status: 409, data: { ok: false, reason: "fenced" } }
            : { status: 200, data: {} },
    );
    const key = "slack:C1:1.0:coding";
    expect(await w.ledger.searchSession(key, "lockfile", 5)).toEqual({ hits, gaps: [2] });
    expect(w.calls[0]).toMatchObject({ path: "/runs/session/search", body: { key, query: "lockfile", limit: 5 } });
    expect(await w.ledger.readNotepad(key)).toEqual({ text: "keep the helper", updatedAt: 5_000 });
    expect(w.calls[1]).toMatchObject({ path: "/runs/session/notepad", body: { key } });
    expect(await w.ledger.writeNotepad(key, "g1", "keep the helper")).toEqual({ ok: false, reason: "fenced" });
    expect(w.calls[2]).toMatchObject({
      path: "/runs/session/notepad/write",
      body: { key, gen: "g1", text: "keep the helper" },
    });
    const bare = stubWorker(() => ({ status: 200, data: {} }));
    expect(await bare.ledger.searchSession(key, "lockfile", 5)).toEqual({ hits: [], gaps: [] });
    expect(await bare.ledger.readNotepad(key)).toBeNull();
    await expect(w.ledger.searchSession("has space", "x", 1)).rejects.toBeInstanceOf(PermanentStoreError);
  });

  it("errors: 404 is RouteMissingError, 5xx/429 TransientStoreError, other 4xx PermanentStoreError, a malformed run id never leaves the process", async () => {
    await expect(
      stubWorker(() => ({ status: 404, data: { error: "not found" } })).ledger.listLive(),
    ).rejects.toBeInstanceOf(RouteMissingError);
    await expect(stubWorker(() => ({ status: 503 })).ledger.listLive()).rejects.toBeInstanceOf(TransientStoreError);
    await expect(stubWorker(() => ({ status: 429 })).ledger.listLive()).rejects.toBeInstanceOf(TransientStoreError);
    await expect(stubWorker(() => ({ status: 400, data: { error: "bad" } })).ledger.listLive()).rejects.toBeInstanceOf(
      PermanentStoreError,
    );
    const w = stubWorker();
    await expect(w.ledger.heartbeat("bad id!", "g1", 1)).rejects.toBeInstanceOf(PermanentStoreError);
    expect(w.calls).toHaveLength(0);
  });

  it("readInbox posts the run id and the seq to read past, and returns the Worker's items (item 40)", async () => {
    const items = [{ seq: 3, message: { text: "late" } }];
    const w = stubWorker(() => ({ status: 200, data: { items } }));
    expect(await w.ledger.readInbox("r1", 2)).toEqual(items);
    expect(w.calls.at(-1)).toMatchObject({ path: "/runs/inbox/read", body: { runId: "r1", afterSeq: 2 } });
    const empty = stubWorker(() => ({ status: 200, data: {} }));
    expect(await empty.ledger.readInbox("r1", 0)).toEqual([]);
  });

  it("finish posts the record's metrics point beside it, priced through the configured table, and none for a provisional record (run-metrics.md)", async () => {
    const prices = { "anthropic/m": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const w = stubWorker(
      (path) => ({ status: 200, data: path === "/runs/finish" ? { ok: true, stored: true } : { ok: true } }),
      {
        prices,
      },
    );
    const final = finishRecord({
      usage: {
        turns: 2,
        byModel: {
          "anthropic/m": { turns: 2, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    });
    expect(await w.ledger.finish("r1", "g1", final)).toEqual({ ok: true, stored: true });
    expect(w.calls[0].body.point).toEqual(pointOf(final, prices));
    const tombstone = finishRecord({ status: "interrupted", provisional: true, finishedAt: 1_000 });
    await w.ledger.finish("r1", "g1", tombstone);
    expect(w.calls[1].body.point).toBeUndefined();
  });

  it("readTranscript assembles the Worker's rows and attachments", async () => {
    const rows = [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "hi" } }) }];
    const w = stubWorker(() => ({ status: 200, data: { rows, attachments: [] } }));
    expect(await w.ledger.readTranscript("r1")).toEqual({
      complete: true,
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      compactions: [],
    });
  });
});

describe("buildRunLedger — the client for the configured history (run-history item 35)", () => {
  const worker = { baseUrl: "https://memory.example.com" };
  it("is null with history off, on a host-disk store, without a Worker URL, or without the bearer", () => {
    expect(buildRunLedger(undefined, secretsFrom({ MEMORY_TOKEN: "t" }))).toBeNull();
    expect(buildRunLedger({ store: "file", worker }, secretsFrom({ MEMORY_TOKEN: "t" }))).toBeNull();
    expect(buildRunLedger({}, secretsFrom({ MEMORY_TOKEN: "t" }))).toBeNull();
    expect(buildRunLedger({ worker }, secretsFrom({}))).toBeNull();
    expect(buildRunLedger({ worker }, secretsFrom({ MEMORY_TOKEN: "  " }))).toBeNull();
  });

  it("builds a Worker client on the configured URL and bearer env (the default MEMORY_TOKEN or the configured name)", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }) as typeof fetch;
    const byDefault = buildRunLedger({ worker }, secretsFrom({ MEMORY_TOKEN: "tok-a" }), { fetch: fetchImpl });
    expect(byDefault).toBeInstanceOf(WorkerRunLedger);
    await byDefault!.listLive();
    expect(calls.at(-1)).toEqual({ url: "https://memory.example.com/runs/live", auth: "Bearer tok-a" });
    const byName = buildRunLedger(
      { worker: { ...worker, tokenEnv: "LEDGER_TOKEN" } },
      secretsFrom({ LEDGER_TOKEN: "tok-b" }),
      { fetch: fetchImpl },
    );
    await byName!.listLive();
    expect(calls.at(-1)).toEqual({ url: "https://memory.example.com/runs/live", auth: "Bearer tok-b" });
  });

  it("carries the configured session log byte budget onto every session owner claim, clamped like the rest of the policy", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const configured = buildRunLedger(
      { worker, sessionLogMaxBytes: 64 * 1024 * 1024 },
      secretsFrom({ MEMORY_TOKEN: "t" }),
      {
        fetch: fetchImpl,
      },
    );
    await configured!.claimSession("slack:C1:1.0:review", "r1", "g1");
    expect(bodies.at(-1)).toEqual({ key: "slack:C1:1.0:review", runId: "r1", gen: "g1", maxBytes: 64 * 1024 * 1024 });
    const clamped = buildRunLedger({ worker, sessionLogMaxBytes: 1 }, secretsFrom({ MEMORY_TOKEN: "t" }), {
      fetch: fetchImpl,
    });
    await clamped!.claimSession("slack:C1:1.0:review", "r1", "g1");
    expect(bodies.at(-1)).toMatchObject({ maxBytes: 16 * 1024 * 1024 });
  });
});

describe("intake receipts — the routes and the retry (run-history item 59)", () => {
  const receipt = (over: Partial<IntakeReceipt> = {}): IntakeReceipt => ({
    verdict: "silent",
    reason: "answering a colleague",
    source: "model",
    mode: "classify",
    model: "prov/mini",
    gen: 3,
    threadKey: "slack:C1:1.0",
    decidedAt: 5_000,
    ...over,
  });

  it("recordIntake posts the key and receipt under the store key — windowMs only when the client carries one — and answers the insert", async () => {
    const stored = receipt();
    const w = stubWorker(() => ({ status: 200, data: { inserted: true, stored } }));
    expect(await w.ledger.recordIntake("slack:C1:2.0", stored)).toEqual({ inserted: true, stored });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/intake"]);
    expect(w.calls[0].body).toEqual({ storeKey: "runs:default", key: "slack:C1:2.0", receipt: stored });

    const windowed = stubWorker(() => ({ status: 200, data: { inserted: true, stored } }), {
      catchUpWindowMs: 1_800_000,
    });
    await windowed.ledger.recordIntake("slack:C1:2.0", stored);
    expect(windowed.calls[0].body).toEqual({
      storeKey: "runs:default",
      key: "slack:C1:2.0",
      receipt: stored,
      windowMs: 1_800_000,
    });
  });

  it("readIntake answers the row or none; listIntake passes only the filters given and answers the rows", async () => {
    const stored = receipt();
    const w = stubWorker((path) =>
      path === "/runs/intake/read"
        ? { status: 200, data: { receipt: stored } }
        : { status: 200, data: { receipts: [stored] } },
    );
    expect(await w.ledger.readIntake("slack:C1:2.0")).toEqual(stored);
    expect(w.calls[0]).toMatchObject({
      path: "/runs/intake/read",
      body: { storeKey: "runs:default", key: "slack:C1:2.0" },
    });
    expect(await w.ledger.listIntake({ threadKey: "slack:C1:1.0", since: 2_000 })).toEqual([stored]);
    expect(w.calls[1]).toMatchObject({
      path: "/runs/intake/list",
      body: { storeKey: "runs:default", threadKey: "slack:C1:1.0", since: 2_000 },
    });
    await w.ledger.listIntake({});
    expect(w.calls[2].body).toEqual({ storeKey: "runs:default" });

    const none = stubWorker(() => ({ status: 200, data: { receipt: null } }));
    expect(await none.ledger.readIntake("slack:C1:2.0")).toBeUndefined();
  });

  it("the write-through's retry after a lost response reads the same row and answers the stored insert", async () => {
    const rows = new Map<string, IntakeReceipt>();
    const w = stubWorker((path, body) => {
      if (path === "/runs/intake") {
        const key = body.key as string;
        if (!rows.has(key)) rows.set(key, body.receipt as IntakeReceipt); // the insert lands…
        return { status: 503, data: { error: "gateway" } }; // …and the response is lost
      }
      if (path === "/runs/intake/read") {
        return { status: 200, data: { receipt: rows.get(body.key as string) ?? null } };
      }
      return { status: 200, data: { ok: true } };
    });
    const wt = createLedgerWriteThrough({
      ledger: w.ledger,
      gen: "gen-A",
      fallback: { put: async () => ({}), abandoned: () => {} },
      warn: () => {},
      sleep: async () => {},
    });
    expect(await wt.recordIntake("slack:C1:2.0", receipt())).toEqual({ inserted: true, stored: receipt() });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/intake", "/runs/intake/read"]);
  });
});
