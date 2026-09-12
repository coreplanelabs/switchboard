import { describe, expect, it } from "vitest";
import { secretsFrom } from "../secrets.js";
import type { PullRequestFacts } from "./delivery.js";
import {
  buildDeliverySnapshotStore,
  InMemoryDeliverySnapshotStore,
  isDeliverySnapshot,
  isDeliverySnapshotPatch,
  SNAPSHOT_WORKER_TIMEOUT_MS,
  WorkerDeliverySnapshotStore,
  type DeliverySnapshot,
  type DeliverySnapshotPatch,
} from "./deliverySnapshotStore.js";

// Feature: docs/reference/specs/delivery.md item 10 — where a repository's
// snapshot lives. Two implementations of one seam (AGENTS.md invariant 2): the
// Worker client (the DeliveryDO on the state Worker — the production choice, so
// a bot restart keeps the snapshot, invariant 6) and the in-memory store. A
// snapshot is written whole once and patched by every refresh after.

const day = (iso: string): string => iso.slice(0, 10);

const pr = (number: number, mergedAt: string, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-09-01T09:00:00Z",
  mergedAt,
  updatedAt: mergedAt,
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [],
  reviews: [
    { author: "acme-review[bot]", state: "commented", submittedAt: "2026-09-01T10:00:00Z", body: "LGTM: fine." },
  ],
  pushes: [],
  ...over,
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

/** A refresh an hour later: 2 was touched again, 3 merged, 1 aged out of the window. */
const patch = (repo: string, over: Partial<DeliverySnapshotPatch> = {}): DeliverySnapshotPatch => ({
  repo,
  snapshotAt: "2026-09-12T15:00:00Z",
  range: { since: day("2026-06-22T00:00:00Z"), until: day("2026-09-12T00:00:00Z"), weeks: 13 },
  truncated: false,
  completeFrom: "2026-06-22T00:00:00Z",
  upsert: [
    pr(2, "2026-09-11T12:00:00Z", { title: "change 2 (commented on)", updatedAt: "2026-09-12T14:30:00Z" }),
    pr(3, "2026-09-12T14:20:00Z"),
  ],
  drop: [1],
  ...over,
});

/** The snapshot the patch leaves behind. */
const patched = (repo: string): DeliverySnapshot => {
  const { upsert, drop, ...meta } = patch(repo);
  void drop;
  return { ...meta, prs: upsert };
};

describe("isDeliverySnapshot", () => {
  it("accepts a stored snapshot and refuses a malformed one by field", () => {
    expect(isDeliverySnapshot(snapshot("acme/api"))).toBe(true);
    expect(isDeliverySnapshot(snapshot("acme/api", { prs: [] }))).toBe(true);
    // Facts read before the update time was kept have none; the guard takes them.
    expect(
      isDeliverySnapshot(snapshot("acme/api", { prs: [{ ...pr(1, "2026-09-02T12:00:00Z"), updatedAt: undefined }] })),
    ).toBe(true);
    expect(
      isDeliverySnapshot({ ...snapshot("acme/api"), prs: [pr(1, "2026-09-02T12:00:00Z", { updatedAt: "recently" })] }),
    ).toBe(false);
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

describe("isDeliverySnapshotPatch", () => {
  it("accepts a refresh's patch — the meta, the rows to upsert, the numbers to drop — and refuses a malformed one by field", () => {
    expect(isDeliverySnapshotPatch(patch("acme/api"))).toBe(true);
    expect(isDeliverySnapshotPatch(patch("acme/api", { upsert: [], drop: [] }))).toBe(true);
    expect(isDeliverySnapshotPatch(snapshot("acme/api"))).toBe(false);
    expect(isDeliverySnapshotPatch({ ...patch("acme/api"), repo: "../etc" })).toBe(false);
    expect(isDeliverySnapshotPatch({ ...patch("acme/api"), completeFrom: "soon" })).toBe(false);
    expect(isDeliverySnapshotPatch({ ...patch("acme/api"), upsert: [{ number: 3 }] })).toBe(false);
    expect(isDeliverySnapshotPatch({ ...patch("acme/api"), drop: ["1"] })).toBe(false);
    expect(isDeliverySnapshotPatch({ ...patch("acme/api"), drop: [Number.NaN] })).toBe(false);
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

  it("merge applies a refresh: the rows it carries replace theirs by number, the numbers it names go, the meta is replaced; false for a repository with nothing stored", async () => {
    const store = new InMemoryDeliverySnapshotStore();
    expect(await store.merge(patch("acme/api"))).toBe(false);
    expect(await store.get("acme/api")).toBeUndefined();
    await store.put(snapshot("acme/api"));
    await store.put(snapshot("acme/web"));
    expect(await store.merge(patch("acme/api"))).toBe(true);
    expect(await store.get("acme/api")).toEqual(patched("acme/api"));
    expect(await store.get("acme/web")).toEqual(snapshot("acme/web"));
  });
});

// ---- a fake state Worker: the three routes, the bearer, one row per repository ----

function fakeStateWorker(opts: { token?: string; failPut?: number; failMerge?: number; routes?: boolean } = {}) {
  const token = opts.token ?? "secret";
  const rows = new Map<string, { repo: string; prs: Array<{ number: number }> }>();
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
      const s = body.snapshot as { repo: string; prs: Array<{ number: number }> };
      rows.set(s.repo, s);
      return Response.json({ ok: true, prs: s.prs.length });
    }
    if (url.pathname === "/delivery/merge") {
      if (opts.failMerge !== undefined) return Response.json({ error: "a row too large" }, { status: opts.failMerge });
      const p = body.patch as DeliverySnapshotPatch;
      const stored = rows.get(p.repo);
      if (!stored) return Response.json({ error: `no snapshot for ${p.repo} to merge into` }, { status: 404 });
      const { upsert, drop, ...meta } = p;
      const byNumber = new Map(stored.prs.map((r) => [r.number, r]));
      for (const r of upsert) byNumber.set(r.number, r);
      for (const n of drop) byNumber.delete(n);
      const prs = [...byNumber.values()].sort((a, b) => a.number - b.number);
      rows.set(p.repo, { ...meta, prs });
      return Response.json({ ok: true, prs: prs.length });
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
    worker.rows.set("acme/api", { repo: "acme/api", prs: "garbage" as unknown as Array<{ number: number }> });
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

  it("merge POSTs the patch and is true when the Worker applied it, false when the Worker has nothing to merge into (or is an older Worker without the route), and throws with the Worker's words on a refused write", async () => {
    const worker = fakeStateWorker();
    const store = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: worker.fetch,
    });
    expect(await store.merge(patch("acme/api"))).toBe(false);
    await store.put(snapshot("acme/api"));
    expect(await store.merge(patch("acme/api"))).toBe(true);
    expect(worker.requests[2]).toMatchObject({ path: "/delivery/merge", auth: "Bearer secret" });
    expect(worker.requests[2].body).toEqual({ patch: patch("acme/api") });
    expect(await store.get("acme/api")).toEqual(patched("acme/api"));
    const old = fakeStateWorker({ routes: false });
    const older = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: old.fetch,
    });
    expect(await older.merge(patch("acme/api"))).toBe(false);
    const refusing = fakeStateWorker({ failMerge: 413 });
    const refused = new WorkerDeliverySnapshotStore({
      baseUrl: "https://state.example.com",
      token: "secret",
      fetch: refusing.fetch,
    });
    await expect(refused.merge(patch("acme/api"))).rejects.toThrow(/HTTP 413: a row too large/);
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
