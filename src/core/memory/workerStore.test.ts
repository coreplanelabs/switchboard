import { describe, expect, it } from "vitest";
import type { MemoryCandidate, MemoryRecord } from "./types.js";
import { WorkerMemoryStore, MEMORY_WORKER_TIMEOUT_MS } from "./workerStore.js";

// Feature: features/memory.md — the durable MemoryStore (PR3, #85): an HTTPS
// client to the Memory Worker, mirroring ResidentExecutor's remote plane. The
// contract is asserted here against a fake fetch; the Worker's own behavior is
// proven by deploy/cloudflare-memory/worker.test.ts.

const record: MemoryRecord = {
  id: "mem:org:coreplanelabs:0",
  scopeKey: "org:coreplanelabs",
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

function fakeFetch(
  respond: (call: Call) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
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
    const out = await store(fetch).retrieve({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
    expect(out).toEqual([record]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://memory.example/retrieve"); // trailing slash normalized
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ scopeKey: "org:coreplanelabs", query: "deploy", limit: 8 });
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
    await expect(store(fetch).write("org:coreplanelabs", [cand])).resolves.toBeUndefined();
    expect(calls[0].url).toBe("https://memory.example/write");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ scopeKey: "org:coreplanelabs", records: [cand] });
  });

  it("skips the round trip entirely for an empty batch", async () => {
    const { fetch, calls } = fakeFetch(() => jsonRes({ ok: true }));
    await store(fetch).write("org:coreplanelabs", []);
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

describe("WorkerMemoryStore construction", () => {
  it("has a bounded request timeout so a hung Worker can never stall a dispatch", () => {
    expect(MEMORY_WORKER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MEMORY_WORKER_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
