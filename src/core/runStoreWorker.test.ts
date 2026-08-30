import { describe, expect, it } from "vitest";
import { analyzeRunFriction } from "./runFriction.js";
import type { RunEvent } from "./runEvents.js";
import { DEFAULT_RETENTION_POLICY, type RunRecord } from "./runRecord.js";
import { describeError, PermanentStoreError, RouteMissingError, TransientStoreError, WorkerRunStore } from "./runStoreWorker.js";

// Feature: features/run-history.md — the HTTPS RunStore client to the state
// Worker's RunHistoryDO (POST /runs/put|get|list|events|delete).

const NOW = 1_800_000_000_000;
function events(n: number, size = 20): RunEvent[] {
  return Array.from({ length: n }, (_, i) => ({ type: "tool_call", tool: "bash", summary: `step ${i} ${"x".repeat(size)}` }));
}
function record(id: string, evs: RunEvent[] = events(3)): RunRecord {
  return {
    id,
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:1",
    startedAt: NOW - 5000,
    finishedAt: NOW,
    status: "completed",
    eventCount: evs.length,
    storedEventCount: evs.length,
    truncated: false,
    events: evs,
    diagnosis: analyzeRunFriction(evs),
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  rawBody: unknown;
  body: Record<string, unknown>;
}

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown } | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: (init?.headers as Record<string, string>) ?? {},
      rawBody: init?.body,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    };
    calls.push(call);
    const r = handler(call);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const OPTS = { baseUrl: "https://state.example/", token: "tok", storeKey: "runs:default", policy: DEFAULT_RETENTION_POLICY, policyUpdatedAt: NOW };

describe("WorkerRunStore", () => {
  it("put sends a 1.9 MB record as a string body (Content-Length left to the runtime), the bearer, and the policy", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, retained: 1, stored: true, rewritten: false } }));
    const rec = record("a", events(38, 50_000));
    const res = await new WorkerRunStore({ ...OPTS, fetch }).put(rec);
    expect(res).toEqual({ ok: true, retained: 1, stored: true, rewritten: false });
    expect(calls[0].url).toBe("https://state.example/runs/put");
    expect(typeof calls[0].rawBody).toBe("string");
    const bytes = Buffer.byteLength(calls[0].rawBody as string);
    expect(bytes).toBeGreaterThan(1_900_000);
    // #313: a hand-set Content-Length was the one header the working clients do not send;
    // the runtime derives it from the string body.
    expect(calls[0].headers["content-length"]).toBeUndefined();
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(calls[0].body.storeKey).toBe("runs:default");
    expect(calls[0].body.policy).toEqual(DEFAULT_RETENTION_POLICY);
    expect(calls[0].body.policyUpdatedAt).toBe(NOW);
    expect((calls[0].body.record as RunRecord).id).toBe("a");
  });

  it("get/list/events/delete send no policy; get and list re-validate what comes back", async () => {
    const rec = record("a");
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/runs/get")) return { status: 200, body: { record: rec } };
      if (c.url.endsWith("/runs/list")) return { status: 200, body: { items: [{ ...rec, events: undefined, bytes: 10 }, { junk: true }] } };
      if (c.url.endsWith("/runs/events")) return { status: 200, body: { events: [{ ...rec.events[1], seq: 2 }], nextAfterSeq: 2 } };
      return { status: 200, body: { ok: true } };
    });
    const store = new WorkerRunStore({ ...OPTS, fetch });
    expect(await store.get("a")).toEqual(rec);
    expect(await store.list({ limit: 5, agent: "review" })).toEqual([{ ...rec, events: undefined, bytes: 10 }]);
    expect(await store.events("a", { afterSeq: 1, limit: 1 })).toEqual({ events: [{ ...rec.events[1], seq: 2 }], nextAfterSeq: 2 });
    await store.delete("a");
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.body.policy).toBeUndefined();
      expect(c.body.policyUpdatedAt).toBeUndefined();
      expect(c.body.storeKey).toBe("runs:default");
    }
    expect(calls[0].body).toEqual({ storeKey: "runs:default", id: "a" });
    expect(calls[1].body).toEqual({ storeKey: "runs:default", limit: 5, agent: "review" });
    expect(calls[2].body).toEqual({ storeKey: "runs:default", id: "a", afterSeq: 1, limit: 1 });
    expect(calls[3].body).toEqual({ storeKey: "runs:default", id: "a" });
  });

  it("getSummary posts /runs/summary and re-validates; {summary: null} → null; a malformed summary is a PermanentStoreError; a bad id never leaves the process", async () => {
    const rec = record("a");
    const { events: _e, ...summary } = rec;
    let reply: unknown = { summary: { ...summary, bytes: 42 } };
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: reply }));
    const store = new WorkerRunStore({ ...OPTS, fetch });
    expect(await store.getSummary("a")).toEqual({ ...summary, bytes: 42 });
    expect(calls[0].url).toBe("https://state.example/runs/summary");
    expect(calls[0].body).toEqual({ storeKey: "runs:default", id: "a" });
    reply = { summary: null };
    expect(await store.getSummary("a")).toBeNull();
    reply = { summary: { id: "a", junk: true } };
    await expect(store.getSummary("a")).rejects.toBeInstanceOf(PermanentStoreError);
    expect(await store.getSummary("a b")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("get returns null for {record: null}; events returns null for {events: null}; a malformed record is a PermanentStoreError", async () => {
    const nul = fakeFetch((c) => (c.url.endsWith("/runs/get") ? { status: 200, body: { record: null } } : { status: 200, body: { events: null } }));
    expect(await new WorkerRunStore({ ...OPTS, fetch: nul.fetch }).get("a")).toBeNull();
    expect(await new WorkerRunStore({ ...OPTS, fetch: nul.fetch }).events("a", {})).toBeNull();
    const bad = fakeFetch(() => ({ status: 200, body: { record: { id: "a" } } }));
    await expect(new WorkerRunStore({ ...OPTS, fetch: bad.fetch }).get("a")).rejects.toThrow(PermanentStoreError);
  });

  it("get and list normalize a stored diagnosis missing a current category (zero-filled) and keep the events' stored seq", async () => {
    const rec = record("a", events(2).map((e, i) => ({ ...e, seq: 100 + i })));
    const { slow_tool: _drop, ...rest } = rec.diagnosis.byCategory;
    const legacy = { ...rec, diagnosis: { ...rec.diagnosis, byCategory: rest } };
    const { fetch } = fakeFetch((c) =>
      c.url.endsWith("/runs/get") ? { status: 200, body: { record: legacy } } : { status: 200, body: { items: [{ ...legacy, events: undefined, bytes: 1 }] } },
    );
    const store = new WorkerRunStore({ ...OPTS, fetch });
    const got = await store.get("a");
    expect(got!.diagnosis.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
    expect(got!.events.map((e) => e.seq)).toEqual([100, 101]);
    const [item] = await store.list({});
    expect(item.diagnosis.byCategory.slow_tool).toEqual({ count: 0, durationMs: 0 });
  });

  it("rejects a bad id locally without a request", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const store = new WorkerRunStore({ ...OPTS, fetch });
    expect(await store.get("../x")).toBeNull();
    expect(await store.events("a b", {})).toBeNull();
    await store.delete("");
    expect(calls).toEqual([]);
  });

  it("classifies failures: 404 → RouteMissingError; 503/408/429/network → TransientStoreError; 400 → PermanentStoreError", async () => {
    const mk = (r: { status: number; body?: unknown } | Error) => new WorkerRunStore({ ...OPTS, fetch: fakeFetch(() => r).fetch });
    await expect(mk({ status: 404, body: { error: "not found" } }).put(record("a"))).rejects.toThrow(RouteMissingError);
    await expect(mk({ status: 503 }).put(record("a"))).rejects.toThrow(TransientStoreError);
    await expect(mk({ status: 408 }).get("a")).rejects.toThrow(TransientStoreError);
    await expect(mk({ status: 429 }).list({})).rejects.toThrow(TransientStoreError);
    await expect(mk(new Error("ECONNRESET")).get("a")).rejects.toThrow(TransientStoreError);
    await expect(mk({ status: 400, body: { error: "record must be a RunRecord" } }).put(record("a"))).rejects.toThrow(PermanentStoreError);
    await expect(mk({ status: 400, body: { error: "record must be a RunRecord" } }).put(record("a"))).rejects.toThrow(/HTTP 400: record must be a RunRecord/);
  });
});

describe("describeError — the cause chain survives into the warn line (#313)", () => {
  it("appends nested causes and error codes, so a bare `fetch failed` names its reason", () => {
    const socket = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const undici = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET", cause: socket });
    const fetchFailed = new TypeError("fetch failed", { cause: undici });
    expect(describeError(fetchFailed)).toBe("fetch failed (cause: other side closed [UND_ERR_SOCKET] (cause: read ECONNRESET))");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(new Error("no cause"))).toBe("no cause");
  });

  it("a network failure surfaces as a TransientStoreError whose message carries the cause", async () => {
    const { fetch } = fakeFetch(() => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }));
    const store = new WorkerRunStore({ ...OPTS, fetch });
    await expect(store.list({ limit: 1 })).rejects.toMatchObject({
      name: "TransientStoreError",
      message: "run store /runs/list: fetch failed (cause: getaddrinfo ENOTFOUND)", // code already in the message → not repeated
    });
  });
});
