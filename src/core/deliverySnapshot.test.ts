import { describe, expect, it } from "vitest";
import {
  InMemoryDeliverySource,
  resolveDeliveryRange,
  type DeliveryFetch,
  type DeliveryRange,
  type DeliverySource,
  type PullRequestFacts,
} from "./delivery.js";
import { SNAPSHOT_WEEKS, snapshotAgeMinutes, SnapshottingDeliverySource } from "./deliverySnapshot.js";
import {
  InMemoryDeliverySnapshotStore,
  type DeliverySnapshot,
  type DeliverySnapshotStore,
} from "./deliverySnapshotStore.js";

// Feature: docs/reference/specs/delivery.md item 10 — the snapshot in front of
// the GitHub read: one window of facts per repository, read on an interval and
// kept on a store, served to every request that fits it; `fresh` re-reads;
// a range reaching further back is live; the first request computes and stores.

const day = (iso: string): string => iso.slice(0, 10);
const START = Date.parse("2026-09-12T14:03:00Z");
const MIN = 60_000;

const pr = (number: number, mergedAt: string): PullRequestFacts => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-06-01T09:00:00Z",
  mergedAt,
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [],
  reviews: [],
  pushes: [],
});
const PRS = [pr(1, "2026-06-20T12:00:00Z"), pr(2, "2026-08-20T12:00:00Z"), pr(3, "2026-09-11T12:00:00Z")];

/** A clock the tests move by hand. */
function clock(start = START) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => void (t += ms),
    iso: () => new Date(t).toISOString(),
  };
}

const world = (
  opts: { prs?: Record<string, PullRequestFacts[]>; store?: DeliverySnapshotStore; inner?: DeliverySource } = {},
) => {
  const c = clock();
  const inner = new InMemoryDeliverySource(opts.prs ?? { "acme/api": PRS });
  const store = opts.store ?? new InMemoryDeliverySnapshotStore();
  const warnings: string[] = [];
  const source = new SnapshottingDeliverySource(opts.inner ?? inner, store, {
    now: c.now,
    warn: (m) => void warnings.push(m),
  });
  return { c, inner, store, source, warnings };
};

const weeks = (n: number, now: Date): DeliveryRange => resolveDeliveryRange({ weeks: n }, now);

describe("SnapshottingDeliverySource", () => {
  it("the first read of a repository reads GitHub once over the snapshot window, stores it and serves the request from it; the next read is the stored facts, stamped with the read time, and GitHub is not asked again", async () => {
    const { c, inner, store, source } = world();
    const window = weeks(SNAPSHOT_WEEKS, c.now());
    expect(window.since).toBe(day("2026-06-15T00:00:00Z"));
    const first = await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    expect(inner.calls).toEqual([{ repo: "acme/api", range: window }]);
    expect(first).toEqual({ prs: PRS, truncated: false, fetchedAt: c.iso() });
    const stored = await store.get("acme/api");
    expect(stored).toEqual({
      repo: "acme/api",
      snapshotAt: c.iso(),
      range: window,
      prs: PRS,
      truncated: false,
      completeFrom: `${window.since}T00:00:00Z`,
    });
    const readAt = c.iso();
    c.advance(25 * MIN);
    const second = await source.fetchPullRequests("acme/api", weeks(1, c.now()));
    expect(inner.calls).toHaveLength(1);
    expect(second.fetchedAt).toBe(readAt);
    expect(second.prs).toEqual(PRS);
  });

  it("fresh re-reads GitHub, replaces the snapshot and serves from the new one", async () => {
    const { c, inner, store, source } = world();
    await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    c.advance(5 * MIN);
    const fresh = await source.fetchPullRequests("acme/api", weeks(4, c.now()), { fresh: true });
    expect(inner.calls).toHaveLength(2);
    expect(fresh.fetchedAt).toBe(c.iso());
    expect((await store.get("acme/api"))!.snapshotAt).toBe(c.iso());
    expect(await source.current("acme/api")).toMatchObject({ snapshotAt: c.iso() });
  });

  it("a range reaching further back than the window is a live read over that range and leaves the snapshot alone", async () => {
    const { c, inner, store, source } = world();
    await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    const wide = weeks(26, c.now());
    c.advance(MIN);
    const live = await source.fetchPullRequests("acme/api", wide);
    expect(inner.calls[1]).toEqual({ repo: "acme/api", range: wide });
    expect(live).toEqual({ prs: PRS, truncated: false, fetchedAt: c.iso() });
    expect((await store.get("acme/api"))!.snapshotAt).not.toBe(c.iso());
    // Fresh over a wide range is that live read too — the snapshot's window is what fresh refreshes.
    await source.fetchPullRequests("acme/api", wide, { fresh: true });
    expect(inner.calls).toHaveLength(3);
    expect((await store.get("acme/api"))!.snapshotAt).not.toBe(c.iso());
  });

  it("a snapshot on the store is served after a restart without a GitHub read, and a store that fails is an absent snapshot: a warning, then a read that computes and stores", async () => {
    const seed = world();
    await seed.source.fetchPullRequests("acme/api", weeks(4, seed.c.now()));
    const restarted = world({ store: seed.store });
    restarted.c.advance(10 * MIN);
    const served = await restarted.source.fetchPullRequests("acme/api", weeks(2, restarted.c.now()));
    expect(restarted.inner.calls).toEqual([]);
    expect(served.fetchedAt).toBe(seed.c.iso());

    const failing: DeliverySnapshotStore = {
      get: () => Promise.reject(new Error("state Worker HTTP 503")),
      put: () => Promise.reject(new Error("state Worker HTTP 503")),
    };
    const broken = world({ store: failing });
    const fetched = await broken.source.fetchPullRequests("acme/api", weeks(4, broken.c.now()));
    expect(fetched.prs).toEqual(PRS);
    expect(broken.inner.calls).toHaveLength(1);
    expect(broken.warnings).toHaveLength(2);
    expect(broken.warnings[0]).toMatch(/acme\/api.*HTTP 503/);
    expect(broken.warnings[1]).toMatch(/not stored.*HTTP 503/);
    // The facts stay in memory: the next read serves them, and the store is not asked again.
    await broken.source.fetchPullRequests("acme/api", weeks(1, broken.c.now()));
    expect(broken.inner.calls).toHaveLength(1);
    expect(broken.warnings).toHaveLength(2);
  });

  it("a capped snapshot is truncated for a range starting before its complete-from instant and complete for one starting after", async () => {
    const capped: DeliverySource = {
      fetchPullRequests: (_repo, _range): Promise<DeliveryFetch> =>
        Promise.resolve({ prs: PRS, truncated: true, completeFrom: "2026-08-28T01:47:37Z" }),
    };
    const { c, source } = world({ inner: capped });
    const four = await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    expect(four.truncated).toBe(true); // four weeks back starts before the listing's oldest row
    const two = await source.fetchPullRequests("acme/api", weeks(2, c.now()));
    expect(two.truncated).toBe(false); // two weeks back starts inside what the listing reached
    expect((await source.current("acme/api"))!.completeFrom).toBe("2026-08-28T01:47:37Z");
  });

  it("concurrent first reads share one GitHub read", async () => {
    const { c, inner, source } = world();
    const [a, b] = await Promise.all([
      source.fetchPullRequests("acme/api", weeks(4, c.now())),
      source.fetchPullRequests("acme/api", weeks(1, c.now())),
    ]);
    expect(inner.calls).toHaveLength(1);
    expect(a.fetchedAt).toBe(b.fetchedAt);
  });
});

describe("SnapshottingDeliverySource.startRefreshLoop", () => {
  function timer() {
    let cb: (() => void) | undefined;
    const state = { intervalMs: 0, cleared: false, unref: false };
    return {
      state,
      setInterval: (fn: () => void, ms: number) => {
        cb = fn;
        state.intervalMs = ms;
        return {
          unref: () => {
            state.unref = true;
          },
        };
      },
      clearInterval: () => {
        state.cleared = true;
      },
      fire: () => cb?.(),
    };
  }

  it("refreshes every configured repository whose snapshot is missing or older than the interval — once per interval, never more often; the timer is unref'd", async () => {
    const { c, inner, source, warnings } = world({ prs: { "acme/api": PRS, "acme/web": [] } });
    const t = timer();
    const loop = source.startRefreshLoop({
      repos: ["acme/api", "acme/web"],
      everyMinutes: 60,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });
    await loop.tick();
    expect(inner.calls.map((x) => x.repo)).toEqual(["acme/api", "acme/web"]);
    expect(t.state.intervalMs).toBe(MIN);
    expect(t.state.unref).toBe(true);
    c.advance(30 * MIN);
    await loop.tick();
    expect(inner.calls).toHaveLength(2);
    c.advance(30 * MIN);
    await loop.tick();
    expect(inner.calls).toHaveLength(4);
    expect((await source.current("acme/web"))!.snapshotAt).toBe(c.iso());
    loop.stop();
    expect(t.state.cleared).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("at start a stored snapshot younger than the interval is not re-read; one older than the interval is", async () => {
    const store = new InMemoryDeliverySnapshotStore();
    const young: DeliverySnapshot = {
      repo: "acme/api",
      snapshotAt: new Date(START - 30 * MIN).toISOString(),
      range: weeks(SNAPSHOT_WEEKS, new Date(START)),
      prs: PRS,
      truncated: false,
      completeFrom: "2026-06-15T00:00:00Z",
    };
    await store.put(young);
    const { c, inner, source } = world({ store });
    const t = timer();
    const loop = source.startRefreshLoop({
      repos: ["acme/api"],
      everyMinutes: 60,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });
    await loop.tick();
    expect(inner.calls).toEqual([]);
    c.advance(31 * MIN);
    await loop.tick();
    expect(inner.calls).toHaveLength(1);
    expect(snapshotAgeMinutes(young.snapshotAt, START)).toBe(30);
  });

  it("a failing refresh is a warning and is retried on the next tick; the interval ticks fire the same pass", async () => {
    let fail = true;
    const flaky: DeliverySource = {
      fetchPullRequests: (repo, range) => {
        if (fail) return Promise.reject(new Error("GitHub GET pulls failed: HTTP 502"));
        return new InMemoryDeliverySource({ "acme/api": PRS }).fetchPullRequests(repo, range);
      },
    };
    const { c, source, warnings } = world({ inner: flaky });
    const t = timer();
    const loop = source.startRefreshLoop({
      repos: ["acme/api"],
      everyMinutes: 60,
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });
    await loop.tick();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/acme\/api.*HTTP 502/);
    expect(await source.current("acme/api")).toBeUndefined();
    fail = false;
    t.fire();
    await loop.tick();
    expect((await source.current("acme/api"))!.snapshotAt).toBe(c.iso());
    expect(warnings).toHaveLength(1);
  });
});
