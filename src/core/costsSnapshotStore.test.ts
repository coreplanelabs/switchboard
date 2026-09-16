import { describe, expect, it } from "vitest";
import { EMPTY_USAGE } from "./costs.js";
import {
  buildCostsSnapshotStore,
  COSTS_SNAPSHOT_WORKER_TIMEOUT_MS,
  InMemoryCostsSnapshotStore,
  isCostsSnapshot,
  WorkerCostsSnapshotStore,
  type CostsSnapshot,
} from "./costsSnapshotStore.js";

// Feature: docs/reference/specs/costs.md item 6 — where the costs snapshot lives.
// The shape guard the bot and the Worker share, the in-memory store, and the
// HTTPS client to the CostsSnapshotDO.

// ---- fixtures ---------------------------------------------------------------

/** A calendar day as the billing datasets spell it (YYYY-MM-DD, UTC). */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const JUN_19 = iso(2026, 6, 19);
const SEP_16 = iso(2026, 9, 16);
const SEP_17 = iso(2026, 9, 17);

export function snapshot(over: Partial<CostsSnapshot> = {}): CostsSnapshot {
  return {
    takenAt: `${SEP_16}T06:15:00.000Z`,
    takenBy: "schedule",
    durationMs: 31_000,
    range: { from: JUN_19, to: SEP_16, days: 90, partialLastDay: true },
    usage: {
      ...EMPTY_USAGE,
      workers: [{ date: SEP_16, scriptName: "switchboard", requests: 10, cpuTimeUs: 1_000 }],
      containers: [
        {
          date: SEP_16,
          applicationId: "app-bot",
          cpuTimeSec: 100,
          allocatedMemoryByteSec: 2 ** 30,
          allocatedDiskByteSec: 1e9,
        },
      ],
    },
    llm: [{ date: SEP_16, workspaceId: "ws_1", amountUsd: 12.5, estimated: true }],
    runUsage: {
      rows: [
        {
          userId: "slack:UALICE",
          userName: "alice",
          day: SEP_16,
          runs: 2,
          wallMs: 60_000,
          usage: {
            turns: 1,
            byModel: {
              "anthropic/claude-haiku-4-5": {
                turns: 1,
                inputTokens: 1_000,
                outputTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          },
        },
      ],
      pending: 0,
      retentionDays: 30,
    },
    ...over,
  };
}

describe("isCostsSnapshot", () => {
  it("accepts a stored snapshot — with or without LLM rows and run usage — and refuses a malformed one by field", () => {
    expect(isCostsSnapshot(snapshot())).toBe(true);
    expect(isCostsSnapshot(snapshot({ llm: null, runUsage: null }))).toBe(true);
    expect(isCostsSnapshot(snapshot({ llm: [] }))).toBe(true);
    expect(isCostsSnapshot(null)).toBe(false);
    expect(isCostsSnapshot("snapshot")).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), takenAt: "yesterday" })).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), takenBy: 7 })).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), durationMs: -1 })).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), range: { from: JUN_19, to: "today", days: 90 } })).toBe(false);
    // Every dataset Cloudflare bills on must be present as rows carrying a day.
    const { workflows: _dropped, ...short } = snapshot().usage;
    expect(isCostsSnapshot({ ...snapshot(), usage: short })).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), usage: { ...snapshot().usage, workers: [{ scriptName: "x" }] } })).toBe(
      false,
    );
    expect(isCostsSnapshot({ ...snapshot(), llm: [{ date: SEP_16, workspaceId: "ws" }] })).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), llm: "none" })).toBe(false);
    expect(isCostsSnapshot({ ...snapshot(), runUsage: { rows: "many" } })).toBe(false);
  });
});

describe("InMemoryCostsSnapshotStore", () => {
  it("put → get as a copy; nothing stored is undefined", async () => {
    const store = new InMemoryCostsSnapshotStore();
    expect(await store.get()).toBeUndefined();
    const s = snapshot();
    await store.put(s);
    const read = await store.get();
    expect(read).toEqual(s);
    expect(read).not.toBe(s);
    await store.put(snapshot({ takenAt: `${SEP_17}T06:15:00.000Z` }));
    expect((await store.get())?.takenAt).toBe(`${SEP_17}T06:15:00.000Z`);
  });
});

function fakeStateWorker(opts: { token?: string; failPut?: number; routes?: boolean; answer?: unknown } = {}) {
  const token = opts.token ?? "secret";
  let stored: unknown = null;
  const requests: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ path: url.pathname, body, auth: headers.get("authorization") });
    if (headers.get("authorization") !== `Bearer ${token}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (opts.routes === false) return Response.json({ error: "not found" }, { status: 404 });
    if (url.pathname === "/costs/snapshot/put") {
      if (opts.failPut !== undefined) return Response.json({ error: "snapshot too large" }, { status: opts.failPut });
      stored = body.snapshot;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/costs/snapshot/get")
      return Response.json(opts.answer !== undefined ? opts.answer : { snapshot: stored });
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("WorkerCostsSnapshotStore (HTTPS client to the state Worker)", () => {
  it("put POSTs the snapshot with the bearer, get reads it back verbatim — and a second client over the same Worker reads what the first wrote (a restart keeps the snapshot)", async () => {
    const worker = fakeStateWorker();
    const first = new WorkerCostsSnapshotStore({
      baseUrl: "https://state.example.com/",
      token: "secret",
      fetch: worker.fetch,
    });
    expect(await first.get()).toBeUndefined();
    await first.put(snapshot());
    expect(worker.requests[1]).toMatchObject({ path: "/costs/snapshot/put", auth: "Bearer secret" });
    expect(worker.requests[1].body).toEqual({ snapshot: snapshot() });
    const restarted = new WorkerCostsSnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: worker.fetch,
    });
    expect(await restarted.get()).toEqual(snapshot());
    expect(worker.requests[2]).toMatchObject({ path: "/costs/snapshot/get", body: {} });
    expect(COSTS_SNAPSHOT_WORKER_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("get: a malformed answer, a refused bearer and a Worker without the route throw with the Worker's own words — never a silent empty snapshot", async () => {
    const malformed = new WorkerCostsSnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: fakeStateWorker({ answer: { snapshot: { takenAt: `${SEP_16}T06:15:00Z` } } }).fetch,
    });
    await expect(malformed.get()).rejects.toThrow("/costs/snapshot/get: the answer is not a costs snapshot");
    const refused = new WorkerCostsSnapshotStore({
      baseUrl: "https://state.example.com",
      token: "wrong",
      fetch: fakeStateWorker().fetch,
    });
    await expect(refused.get()).rejects.toThrow("state Worker /costs/snapshot/get HTTP 401: unauthorized");
    const older = new WorkerCostsSnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: fakeStateWorker({ routes: false }).fetch,
    });
    await expect(older.get()).rejects.toThrow("state Worker /costs/snapshot/get HTTP 404: not found");
  });

  it("put: a non-2xx throws with the status and the Worker's error", async () => {
    const store = new WorkerCostsSnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: fakeStateWorker({ failPut: 413 }).fetch,
    });
    await expect(store.put(snapshot())).rejects.toThrow(
      "state Worker /costs/snapshot/put HTTP 413: snapshot too large",
    );
  });
});

describe("buildCostsSnapshotStore (startup selection)", () => {
  const secrets = (names: Record<string, string>) => ({
    named: (n: string) => (names[n] !== undefined ? { reveal: () => names[n] } : undefined),
  });

  it("with a `*.worker` block naming the state Worker and its bearer in the env → the Worker store", () => {
    const warnings: string[] = [];
    const store = buildCostsSnapshotStore(
      { runHistory: { worker: { baseUrl: "https://state.example.com" } } },
      secrets({ MEMORY_TOKEN: "t" }),
      (m) => warnings.push(m),
    );
    expect(store).toBeInstanceOf(WorkerCostsSnapshotStore);
    expect(warnings).toEqual([]);
  });

  it("without a state Worker → memory, with a warning naming what a restart costs and where to name one", () => {
    const warnings: string[] = [];
    const store = buildCostsSnapshotStore({}, secrets({}), (m) => warnings.push(m));
    expect(store).toBeInstanceOf(InMemoryCostsSnapshotStore);
    expect(warnings[0]).toContain("costs snapshot is kept in memory");
    expect(warnings[0]).toContain("runHistory.worker");
  });

  it("with the Worker named but its bearer unset → memory, with a warning naming the env var", () => {
    const warnings: string[] = [];
    const store = buildCostsSnapshotStore(
      { memory: { worker: { baseUrl: "https://state.example.com", tokenEnv: "STATE_TOKEN" } } },
      secrets({}),
      (m) => warnings.push(m),
    );
    expect(store).toBeInstanceOf(InMemoryCostsSnapshotStore);
    expect(warnings[0]).toContain("STATE_TOKEN is unset");
  });
});
