import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../providers/types.js";
import { buildRunLedger, WorkerRunLedger } from "./runLedgerWorker.js";
import { ATTACHMENT_REF_BYTES, LEASE_MS, type ClaimRequest } from "./runLedger/types.js";
import { PermanentStoreError, RouteMissingError, TransientStoreError } from "./runStoreWorker.js";

// The Worker client (docs/reference/specs/run-history.md item 28): routes, bodies, the
// step write's order (transcript before record), fenced answers as results,
// and the same error classes as the run store.

function stubWorker(
  answer: (path: string, body: Record<string, unknown>) => { status: number; data?: unknown } = () => ({
    status: 200,
    data: { ok: true },
  }),
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
  });
  return { ledger, calls };
}

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
  it("claim posts the run under the store key with the bearer, then sets the transcript owner; a 409 thread-live is a result", async () => {
    const w = stubWorker();
    expect(await w.ledger.claim(claimReq)).toEqual({ ok: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/claim", "/runs/transcript/owner"]);
    expect(w.calls[0].auth).toBe("Bearer tok");
    expect(w.calls[0].body).toEqual({ storeKey: "runs:default", run: claimReq });
    expect(w.calls[1].body).toEqual({ runId: "r1", gen: "g1" });

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
    expect(await w.ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({ ok: true, stop: "soft", phase: "live" });
    const unknown = stubWorker(() => ({ status: 409, data: { ok: false, reason: "unknown-run" } }));
    expect(await unknown.ledger.heartbeat("r1", "g1", LEASE_MS)).toEqual({ ok: false, reason: "unknown-run" });
  });

  it("append with no events posts nothing; finish clears the transcript best-effort; reclaim re-owns each transcript before returning", async () => {
    const w = stubWorker((path) =>
      path === "/runs/reclaim"
        ? { status: 200, data: { runs: [{ row: { runId: "a" } }, { row: { runId: "b" } }] } }
        : path === "/runs/finish"
          ? { status: 200, data: { ok: true, stored: true } }
          : path === "/runs/transcript/clear"
            ? { status: 500 }
            : { status: 200, data: { ok: true } },
    );
    expect(await w.ledger.append("r1", "g1", [])).toEqual({ ok: true });
    expect(w.calls).toHaveLength(0);
    const record = { id: "r1" } as never;
    expect(await w.ledger.finish("r1", "g1", record)).toEqual({ ok: true, stored: true });
    expect(w.calls.map((c) => c.path)).toEqual(["/runs/finish", "/runs/transcript/clear"]);
    const taken = await w.ledger.reclaim("g2", 10, LEASE_MS);
    expect(taken.map((r) => r.row.runId)).toEqual(["a", "b"]);
    expect(w.calls.slice(2).map((c) => [c.path, c.body.runId])).toEqual([
      ["/runs/reclaim", undefined],
      ["/runs/transcript/owner", "a"],
      ["/runs/transcript/owner", "b"],
    ]);
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

  it("readTranscript assembles the Worker's rows and attachments", async () => {
    const rows = [{ idx: 0, part: 0, json: JSON.stringify({ role: "user", part: { type: "text", text: "hi" } }) }];
    const w = stubWorker(() => ({ status: 200, data: { rows, attachments: [] } }));
    expect(await w.ledger.readTranscript("r1")).toEqual({
      complete: true,
      turns: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
  });
});

describe("buildRunLedger — the client for the configured history (run-history item 35)", () => {
  const worker = { baseUrl: "https://memory.example.com" };
  it("is null with history off, on a host-disk store, without a Worker URL, or without the bearer", () => {
    expect(buildRunLedger(undefined, { MEMORY_TOKEN: "t" })).toBeNull();
    expect(buildRunLedger({ store: "file", worker }, { MEMORY_TOKEN: "t" })).toBeNull();
    expect(buildRunLedger({}, { MEMORY_TOKEN: "t" })).toBeNull();
    expect(buildRunLedger({ worker }, {})).toBeNull();
    expect(buildRunLedger({ worker }, { MEMORY_TOKEN: "  " })).toBeNull();
  });

  it("builds a Worker client on the configured URL and bearer env (the default MEMORY_TOKEN or the configured name)", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }) as typeof fetch;
    const byDefault = buildRunLedger({ worker }, { MEMORY_TOKEN: "tok-a" }, { fetch: fetchImpl });
    expect(byDefault).toBeInstanceOf(WorkerRunLedger);
    await byDefault!.listLive();
    expect(calls.at(-1)).toEqual({ url: "https://memory.example.com/runs/live", auth: "Bearer tok-a" });
    const byName = buildRunLedger(
      { worker: { ...worker, tokenEnv: "LEDGER_TOKEN" } },
      { LEDGER_TOKEN: "tok-b" },
      { fetch: fetchImpl },
    );
    await byName!.listLive();
    expect(calls.at(-1)).toEqual({ url: "https://memory.example.com/runs/live", auth: "Bearer tok-b" });
  });
});
