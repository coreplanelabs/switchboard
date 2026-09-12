import { describe, expect, it } from "vitest";
import { secretsFrom } from "../secrets.js";
import type { PullRequestFacts } from "./delivery.js";
import {
  buildDeliverySnapshotStore,
  InMemoryDeliverySnapshotStore,
  isDeliverySnapshot,
  SNAPSHOT_WORKER_TIMEOUT_MS,
  WorkerDeliverySnapshotStore,
  type DeliverySnapshot,
} from "./deliverySnapshotStore.js";

// Feature: docs/reference/specs/delivery.md item 10 — where a repository's
// snapshot lives. Two implementations of one seam (AGENTS.md invariant 2): the
// Worker client (the DeliveryDO on the state Worker — the production choice, so
// a bot restart keeps the snapshot, invariant 6) and the in-memory store.

const day = (iso: string): string => iso.slice(0, 10);

const pr = (number: number, mergedAt: string): PullRequestFacts => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-09-01T09:00:00Z",
  mergedAt,
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [],
  reviews: [
    { author: "acme-review[bot]", state: "commented", submittedAt: "2026-09-01T10:00:00Z", body: "LGTM: fine." },
  ],
  pushes: [],
});

const snapshot = (repo: string, over: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  repo,
  snapshotAt: "2026-09-12T14:00:00Z",
  range: { since: day("2026-06-15T00:00:00Z"), until: day("2026-09-12T00:00:00Z"), weeks: 13 },
  prs: [pr(1, "2026-09-02T12:00:00Z"), pr(2, "2026-09-11T12:00:00Z")],
  truncated: false,
  completeFrom: "2026-06-15T00:00:00Z",
  ...over,
});

describe("isDeliverySnapshot", () => {
  it("accepts a stored snapshot and refuses a malformed one by field", () => {
    expect(isDeliverySnapshot(snapshot("acme/api"))).toBe(true);
    expect(isDeliverySnapshot(snapshot("acme/api", { prs: [] }))).toBe(true);
    expect(isDeliverySnapshot(null)).toBe(false);
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), repo: "../etc" })).toBe(false);
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), snapshotAt: "yesterday" })).toBe(false);
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), completeFrom: 42 })).toBe(false);
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), range: { since: "monday" } })).toBe(false);
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), truncated: "no" })).toBe(false);
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), prs: "many" })).toBe(false);
    // A pull request's facts must carry the fields the arithmetic reads.
    expect(isDeliverySnapshot({ ...snapshot("acme/api"), prs: [{ number: 1 }] })).toBe(false);
    expect(
      isDeliverySnapshot({ ...snapshot("acme/api"), prs: [{ ...pr(1, "2026-09-02T12:00:00Z"), ci: "none" }] }),
    ).toBe(false);
  });
});

describe("InMemoryDeliverySnapshotStore", () => {
  it("put → get per repository, as copies; an unknown repository is undefined", async () => {
    const store = new InMemoryDeliverySnapshotStore();
    expect(await store.get("acme/api")).toBeUndefined();
    await store.put(snapshot("acme/api"));
    await store.put(snapshot("acme/web", { prs: [] }));
    const got = await store.get("acme/api");
    expect(got).toEqual(snapshot("acme/api"));
    got!.prs.length = 0;
    expect((await store.get("acme/api"))!.prs).toHaveLength(2);
    expect((await store.get("acme/web"))!.prs).toEqual([]);
    // A later put replaces the earlier one.
    await store.put(snapshot("acme/api", { snapshotAt: "2026-09-12T15:00:00Z", prs: [] }));
    expect((await store.get("acme/api"))!.snapshotAt).toBe("2026-09-12T15:00:00Z");
  });
});

// ---- a fake state Worker: the two routes, the bearer, one row per repository ----

function fakeStateWorker(opts: { token?: string; failPut?: number; routes?: boolean } = {}) {
  const token = opts.token ?? "secret";
  const rows = new Map<string, unknown>();
  const requests: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ path: url.pathname, body, auth: headers.get("authorization") });
    if (headers.get("authorization") !== `Bearer ${token}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (opts.routes === false) return Response.json({ error: "not found" }, { status: 404 });
    if (url.pathname === "/delivery/put") {
      if (opts.failPut !== undefined) return Response.json({ error: "snapshot too large" }, { status: opts.failPut });
      const s = body.snapshot as { repo: string; prs: unknown[] };
      rows.set(s.repo, s);
      return Response.json({ ok: true, prs: s.prs.length });
    }
    if (url.pathname === "/delivery/get") return Response.json({ snapshot: rows.get(body.repo as string) ?? null });
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, rows, requests };
}

describe("WorkerDeliverySnapshotStore (HTTPS client to the state Worker)", () => {
  it("put POSTs the snapshot with the bearer, get reads it back verbatim — and a second client over the same Worker reads what the first wrote (a restart keeps the snapshot)", async () => {
    const worker = fakeStateWorker();
    const first = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com/",
      token: "secret",
      fetch: worker.fetch,
    });
    await first.put(snapshot("acme/api"));
    expect(worker.requests[0]).toMatchObject({ path: "/delivery/put", auth: "Bearer secret" });
    expect(worker.requests[0].body).toEqual({ snapshot: snapshot("acme/api") });
    const restarted = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: worker.fetch,
    });
    expect(await restarted.get("acme/api")).toEqual(snapshot("acme/api"));
    expect(worker.requests[1]).toMatchObject({ path: "/delivery/get", body: { repo: "acme/api" } });
    expect(await restarted.get("acme/web")).toBeUndefined();
    expect(SNAPSHOT_WORKER_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("get: a malformed answer, a refused bearer and a Worker without the route throw with the Worker's own words — never a silent empty snapshot", async () => {
    const worker = fakeStateWorker();
    worker.rows.set("acme/api", { repo: "acme/api", prs: "garbage" });
    const store = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: worker.fetch,
    });
    await expect(store.get("acme/api")).rejects.toThrow(/not a delivery snapshot/);
    const wrong = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "nope",
      fetch: worker.fetch,
    });
    await expect(wrong.get("acme/api")).rejects.toThrow(/HTTP 401: unauthorized/);
    const old = fakeStateWorker({ routes: false });
    const older = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: old.fetch,
    });
    await expect(older.get("acme/api")).rejects.toThrow(/HTTP 404/);
  });

  it("put: a non-2xx throws with the status and the Worker's error", async () => {
    const worker = fakeStateWorker({ failPut: 413 });
    const store = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: worker.fetch,
    });
    await expect(store.put(snapshot("acme/api"))).rejects.toThrow(/HTTP 413: snapshot too large/);
  });
});

describe("buildDeliverySnapshotStore", () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);
  const worker = { baseUrl: "https://state.example.com" };

  it("the Worker store when any state Worker block and its bearer are present; the in-memory store with a warning otherwise", () => {
    warnings.length = 0;
    const secrets = secretsFrom({ MEMORY_TOKEN: "secret" });
    expect(buildDeliverySnapshotStore({ runHistory: { worker } }, secrets, warn)).toBeInstanceOf(
      WorkerDeliverySnapshotStore,
    );
    expect(buildDeliverySnapshotStore({ runtimeOverrides: { worker } }, secrets, warn)).toBeInstanceOf(
      WorkerDeliverySnapshotStore,
    );
    expect(buildDeliverySnapshotStore({ schedules: { worker } }, secrets, warn)).toBeInstanceOf(
      WorkerDeliverySnapshotStore,
    );
    expect(buildDeliverySnapshotStore({ memory: { worker } }, secrets, warn)).toBeInstanceOf(
      WorkerDeliverySnapshotStore,
    );
    expect(warnings).toEqual([]);
    expect(buildDeliverySnapshotStore({}, secrets, warn)).toBeInstanceOf(InMemoryDeliverySnapshotStore);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/in memory/);
    expect(warnings[0]).toMatch(/restart/);
  });

  it("a state Worker block whose bearer is unset is named and falls back to memory", () => {
    warnings.length = 0;
    const store = buildDeliverySnapshotStore(
      { runHistory: { worker: { ...worker, tokenEnv: "STATE_TOKEN" } } },
      secretsFrom({}),
      warn,
    );
    expect(store).toBeInstanceOf(InMemoryDeliverySnapshotStore);
    expect(warnings[0]).toMatch(/STATE_TOKEN/);
  });
});
