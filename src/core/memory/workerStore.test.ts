import { describe, expect, it } from "vitest";
import type { MemoryCandidate, MemoryRecord } from "./types.js";
import { WorkerMemoryStore, MEMORY_WORKER_TIMEOUT_MS } from "./workerStore.js";
import { recordingSink } from "../testing/recordingSink.js";
import { configureInternalHosts, internalHostsOf, NO_INTERNAL_HOSTS } from "../trace/internalHosts.js";
import { parseTraceparent } from "../trace/traceparent.js";
import { createTracer } from "../trace/tracer.js";

// Feature: docs/reference/specs/memory.md — the durable MemoryStore: an HTTPS
// client to the Memory Worker, mirroring ResidentExecutor's remote plane. The
// contract is asserted here against a fake fetch; the Worker's own behavior is
// proven by deploy/cloudflare-memory/worker.test.ts.

const record: MemoryRecord = {
  id: "mem:org:acme:0",
  scopeKey: "org:acme",
  kind: "fact",
  text: "the deploy command is npm run deploy",
  keywords: ["deploy"],
  sourceThreadKey: "slack:C1:1.0",
  createdAt: 1_700_000_000_000,
  useCount: 1,
  status: "active",
};

const cand: MemoryCandidate = { kind: "fact", text: "x", sourceThreadKey: "slack:C1:1.0" };

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function store(fetchImpl: typeof fetch, warnings: string[] = []) {
  return new WorkerMemoryStore({
    baseUrl: "https://memory.example/",
    token: "secret-token",
    fetch: fetchImpl,
    onWarn: (m) => warnings.push(m),
  });
}

describe("WorkerMemoryStore.retrieve", () => {
  it("POSTs /retrieve with the bearer and the query, returns the Worker's ranked records", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ records: [record] }));
    const out = await store(fetch).retrieve({ scopeKey: "org:acme", query: "deploy", limit: 8 });
    expect(out).toEqual([record]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://memory.example/retrieve"); // trailing slash normalized
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      scopeKey: "org:acme",
      query: "deploy",
      limit: 8,
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("memory is advisory: a non-2xx, a non-JSON body, or a transport failure → [] plus a warning, never a throw", async () => {
    const warnings: string[] = [];
    const cases: Array<() => Response | Promise<Response>> = [
      () => new Response("forbidden", { status: 403 }),
      () => new Response("<html>edge error</html>", { status: 200 }),
      () => jsonRes({ nope: true }),
      () => Promise.reject(new Error("ECONNRESET")),
    ];
    for (const respond of cases) {
      const out = await store(fakeFetch(respond).fetch, warnings).retrieve({ scopeKey: "s", query: "q", limit: 1 });
      expect(out).toEqual([]);
    }
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("403");
    expect(warnings[3]).toContain("ECONNRESET");
  });

  it("drops malformed records from the Worker's reply rather than injecting garbage", async () => {
    const { fetch } = fakeFetch(() => jsonRes({ records: [record, { id: 1 }, "str", null] }));
    const out = await store(fetch).retrieve({ scopeKey: "s", query: "deploy", limit: 8 });
    expect(out).toEqual([record]);
  });
});

describe("WorkerMemoryStore.write", () => {
  it("POSTs /write with the scope and candidates and resolves on 2xx", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ ok: true, inserted: 1, deduped: 0, superseded: 0 }));
    await expect(store(fetch).write("org:acme", [cand])).resolves.toBeUndefined();
    expect(calls[0].url).toBe("https://memory.example/write");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ scopeKey: "org:acme", records: [cand] });
  });

  it("skips the round trip entirely for an empty batch", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ ok: true }));
    await store(fetch).write("org:acme", []);
    expect(calls).toHaveLength(0);
  });

  it("a failed write THROWS with the status/error (the reflection pass catches and warns)", async () => {
    await expect(
      store(fakeFetch(() => jsonRes({ error: "scopeKey must be a string" }, 400)).fetch).write("s", [cand]),
    ).rejects.toThrow(/400.*scopeKey must be a string/);
    await expect(store(fakeFetch(() => Promise.reject(new Error("timeout"))).fetch).write("s", [cand])).rejects.toThrow(
      /timeout/,
    );
  });
});

// Feature: docs/reference/specs/memory.md §24 — human controls over the wire.
describe("WorkerMemoryStore.list / forget", () => {
  it("list POSTs /list {scopeKey, limit} and returns the Worker's records (malformed ones dropped)", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ records: [record, { junk: true }] }));
    expect(await store(fetch).list("org:acme", 20)).toEqual([record]);
    expect(calls[0].url).toBe("https://memory.example/list");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ scopeKey: "org:acme", limit: 20 });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
  });

  it("list sends `query` only when a filter is given", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ records: [] }));
    await store(fetch).list("org:acme", 20, "deploy command");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      scopeKey: "org:acme",
      limit: 20,
      query: "deploy command",
    });
    await store(fetch).list("org:acme", 20);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ scopeKey: "org:acme", limit: 20 });
  });

  it("list is a human command, so a failure THROWS (never silently shows an empty list)", async () => {
    const { fetch } = fakeFetch(() => jsonRes({ error: "boom" }, 500));
    await expect(store(fetch).list("org:acme", 20)).rejects.toThrow(/\/list HTTP 500: boom/);
  });

  it("forget POSTs /forget {scopeKey, id} and returns the Worker's `forgotten` flag", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ ok: true, forgotten: true }));
    expect(await store(fetch).forget("org:acme", "mem:org:acme:0")).toBe(true);
    expect(calls[0].url).toBe("https://memory.example/forget");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      scopeKey: "org:acme",
      id: "mem:org:acme:0",
    });
    const miss = fakeFetch(() => jsonRes({ ok: true, forgotten: false }));
    expect(await store(miss.fetch).forget("org:acme", "mem:org:acme:99")).toBe(false);
  });

  it("forget THROWS on a non-2xx", async () => {
    const { fetch } = fakeFetch(() => jsonRes({ error: "unauthorized" }, 401));
    await expect(store(fetch).forget("org:acme", "x")).rejects.toThrow(/\/forget HTTP 401: unauthorized/);
  });
});

describe("WorkerMemoryStore construction", () => {
  it("has a bounded request timeout so a hung Worker can never stall a dispatch", () => {
    expect(MEMORY_WORKER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MEMORY_WORKER_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

// Feature: docs/reference/specs/memory.md — per-scope cap reaches the Worker on the /write body.
describe("WorkerMemoryStore cap on the wire", () => {
  it("sends `cap` on /write when configured, and omits it (server default) when not", async () => {
    const capped = fakeFetch(() => jsonRes({ ok: true, inserted: 1, deduped: 0, superseded: 0, evicted: 0 }));
    await new WorkerMemoryStore({ baseUrl: "https://memory.example", token: "t", fetch: capped.fetch, cap: 250 }).write(
      "org:acme",
      [cand],
    );
    expect(JSON.parse(String(capped.calls[0].init.body))).toMatchObject({ scopeKey: "org:acme", cap: 250 });
    const plain = fakeFetch(() => jsonRes({ ok: true }));
    await store(plain.fetch).write("org:acme", [cand]);
    expect(JSON.parse(String(plain.calls[0].init.body))).not.toHaveProperty("cap");
  });

  it("accepts `evicted` records from the Worker (status is part of the wire contract)", async () => {
    const { fetch } = fakeFetch(() => jsonRes({ records: [{ ...record, status: "evicted" }] }));
    expect(await store(fetch).list("org:acme", 5)).toHaveLength(1);
  });
});

// docs/reference/specs/tracing.md item 24: the retrieve a dispatch makes is an `http.client`
// child of `dispatch.memory_read`; the trace context rides to our own Worker.
describe("WorkerMemoryStore trace context", () => {
  it("retrieve under a span is an http.client child with route /retrieve, POST and the status, no bearer or query text; traceparent rides for the configured host; without a span the call is a plain fetch", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 1_000 }).start("request", { sinks: [log] });
    const read = root.start("dispatch.memory_read");
    configureInternalHosts(internalHostsOf(["https://memory.example"]));
    try {
      const { fetch, calls } = fakeFetch(() => jsonRes({ records: [record] }));
      const s = store(fetch);
      const q = { scopeKey: "org:acme", query: "deploy secrets", limit: 8 };
      expect(await s.retrieve(q, { span: read })).toEqual([record]);
      const spans = log.ends.filter((e) => e.name === "http.client");
      expect(spans.map((e) => [e.parentSpanId, e.attrs])).toEqual([
        [read.id, { host: "memory.example", route: "/retrieve", method: "POST", httpStatus: 200 }],
      ]);
      expect(JSON.stringify(spans)).not.toMatch(/secret-token|deploy secrets|org:acme/);
      const h = new Headers(calls[0]!.init.headers);
      expect(parseTraceparent(h.get("traceparent"))?.parentId).toBe(spans[0]!.spanId);
      expect(h.get("authorization")).toBe("Bearer secret-token");
      await s.retrieve(q);
      expect(log.ends.filter((e) => e.name === "http.client")).toHaveLength(1);
      expect(new Headers(calls[1]!.init.headers).has("traceparent")).toBe(false);
    } finally {
      configureInternalHosts(NO_INTERNAL_HOSTS);
    }
  });
});
