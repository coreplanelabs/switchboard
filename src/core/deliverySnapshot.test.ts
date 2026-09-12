import { describe, expect, it } from "vitest";
import {
  InMemoryDeliverySource,
  resolveDeliveryRange,
  type DeliveryFetch,
  type DeliveryFetchOptions,
  type DeliveryRange,
  type DeliverySource,
  type PullRequestFacts,
} from "./delivery.js";
import {
  mergeSnapshot,
  REFRESH_OVERLAP_MS,
  SNAPSHOT_WEEKS,
  snapshotAgeMinutes,
  SnapshottingDeliverySource,
} from "./deliverySnapshot.js";
import {
  InMemoryDeliverySnapshotStore,
  type DeliverySnapshot,
  type DeliverySnapshotPatch,
  type DeliverySnapshotStore,
} from "./deliverySnapshotStore.js";

// Feature: docs/reference/specs/delivery.md item 10 — the snapshot in front of
// the GitHub read: one window of facts per repository, read on an interval and
// kept on a store, served to every request that fits it; a refresh re-reads the
// rows touched since the last one and merges them in; `fresh` reads the newest
// rows whole and merges them in; a range reaching further back is live; the
// first request computes and stores.

const day = (iso: string): string => iso.slice(0, 10);
const START = Date.parse("2026-09-12T14:03:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const pr = (number: number, mergedAt: string, over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-06-01T09:00:00Z",
  mergedAt,
  updatedAt: mergedAt,
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [],
  reviews: [],
  pushes: [],
  ...over,
});
const PRS = [pr(1, "2026-06-20T12:00:00Z"), pr(2, "2026-08-20T12:00:00Z"), pr(3, "2026-09-11T12:00:00Z")];

/** A store that logs every write, over the in-memory one. */
function recordingStore(inner = new InMemoryDeliverySnapshotStore()) {
  const ops: string[] = [];
  const patches: DeliverySnapshotPatch[] = [];
  const store: DeliverySnapshotStore = {
    get: (repo) => inner.get(repo),
    put: (snapshot) => {
      ops.push("put");
      return inner.put(snapshot);
    },
    merge: (patch) => {
      ops.push("merge");
      patches.push(structuredClone(patch));
      return inner.merge(patch);
    },
  };
  return { store, inner, ops, patches };
}

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
    expect(first).toEqual({
      prs: PRS,
      truncated: false,
      completeFrom: `${window.since}T00:00:00Z`,
      fetchedAt: c.iso(),
    });
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

  it("fresh reads the newest rows whole (no touched instant) and merges them into the snapshot — a stored row the capped read did not reach survives, the read's reach joins the snapshot's completeness — and serves the new one", async () => {
    let answer: DeliveryFetch = { prs: PRS, truncated: false };
    const opts: Array<DeliveryFetchOptions | undefined> = [];
    const capped: DeliverySource = {
      fetchPullRequests: (_repo, _range, o) => {
        opts.push(o);
        return Promise.resolve(answer);
      },
    };
    const { c, store, source } = world({ inner: capped });
    await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    c.advance(5 * MIN);
    // The full read is capped at the first of the month: it re-reads 3 (fixed since) and stops there.
    const fixed = pr(3, "2026-09-11T12:00:00Z", { title: "change 3 (fixed)", updatedAt: iso(START + 4 * MIN) });
    answer = { prs: [fixed], truncated: true, completeFrom: "2026-09-01T00:00:00Z" };
    const fresh = await source.fetchPullRequests("acme/api", weeks(4, c.now()), { fresh: true });
    expect(opts).toEqual([undefined, undefined]);
    expect(fresh.fetchedAt).toBe(c.iso());
    expect(fresh.prs).toEqual([PRS[0], PRS[1], fixed]);
    // The read reached back past the previous read's time, so the snapshot stays complete.
    expect(fresh.truncated).toBe(false);
    expect(await store.get("acme/api")).toMatchObject({
      snapshotAt: c.iso(),
      prs: [PRS[0], PRS[1], fixed],
      truncated: false,
      completeFrom: `${weeks(SNAPSHOT_WEEKS, c.now()).since}T00:00:00Z`,
    });
    expect(await source.current("acme/api")).toMatchObject({ snapshotAt: c.iso() });
  });

  it("a later refresh is incremental: the rows touched since the previous read, less the overlap, whose update time the snapshot does not hold — a touched row replaces its stored facts, an untouched row survives, a row merged before the window is dropped — and the store receives the patch, not the whole snapshot", async () => {
    const recording = recordingStore();
    const { c, inner, source } = world({ store: recording.store });
    await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    const firstAt = c.iso();
    expect(recording.ops).toEqual(["put"]);
    // A week and an hour later: 3 was commented on, 4 merged, 1 is untouched and now older than the window.
    c.advance(7 * DAY + 60 * MIN);
    const commented = pr(3, "2026-09-11T12:00:00Z", {
      title: "change 3 (commented on)",
      updatedAt: iso(START + 3 * DAY),
    });
    const merged = pr(4, iso(START + 5 * DAY));
    inner.set("acme/api", [PRS[0], PRS[1], commented, merged]);
    const window = weeks(SNAPSHOT_WEEKS, c.now());
    expect(window.since).toBe(day("2026-06-22T00:00:00Z"));
    const loop = source.startRefreshLoop({ repos: ["acme/api"], everyMinutes: 60, setInterval: () => ({}) });
    await loop.tick();
    expect(inner.calls[1]).toEqual({
      repo: "acme/api",
      range: window,
      touched: {
        since: iso(Date.parse(firstAt) - REFRESH_OVERLAP_MS),
        known: new Map(PRS.map((p) => [p.number, p.updatedAt])),
      },
    });
    expect(REFRESH_OVERLAP_MS).toBe(10 * MIN);
    const snapshot = (await source.current("acme/api"))!;
    expect(snapshot.prs).toEqual([PRS[1], commented, merged]);
    expect(snapshot).toMatchObject({
      snapshotAt: c.iso(),
      range: window,
      truncated: false,
      completeFrom: `${window.since}T00:00:00Z`,
    });
    expect(recording.ops).toEqual(["put", "merge"]);
    expect(recording.patches[0]).toEqual({
      repo: "acme/api",
      snapshotAt: c.iso(),
      range: window,
      truncated: false,
      completeFrom: `${window.since}T00:00:00Z`,
      upsert: [commented, merged],
      drop: [1],
    });
    expect(await recording.inner.get("acme/api")).toEqual(snapshot);
    // Served from the merged snapshot: GitHub is not asked again for a range that fits.
    const served = await source.fetchPullRequests("acme/api", weeks(2, c.now()));
    expect(served.prs).toEqual(snapshot.prs);
    expect(inner.calls).toHaveLength(2);
  });

  it("a store with nothing to merge into — an earlier write it refused — is written whole on the next refresh", async () => {
    const inner = new InMemoryDeliverySnapshotStore();
    const ops: string[] = [];
    let refuse = true;
    const store: DeliverySnapshotStore = {
      get: (repo) => inner.get(repo),
      put: (snapshot) => {
        ops.push("put");
        return refuse ? Promise.reject(new Error("state Worker HTTP 503")) : inner.put(snapshot);
      },
      merge: (patch) => {
        ops.push("merge");
        return inner.merge(patch);
      },
    };
    const { c, source, warnings } = world({ store });
    await source.fetchPullRequests("acme/api", weeks(4, c.now()));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not stored.*HTTP 503/);
    refuse = false;
    c.advance(61 * MIN);
    await source.refresh("acme/api");
    expect(ops).toEqual(["put", "merge", "put"]);
    expect((await inner.get("acme/api"))!.snapshotAt).toBe(c.iso());
    expect(warnings).toHaveLength(1);
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
      merge: () => Promise.reject(new Error("state Worker HTTP 503")),
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

describe("mergeSnapshot", () => {
  const range = weeks(SNAPSHOT_WEEKS, new Date(START));
  const windowStart = `${range.since}T00:00:00Z`;
  const previous: DeliverySnapshot = {
    repo: "acme/api",
    snapshotAt: "2026-09-12T13:00:00Z",
    range,
    prs: PRS,
    truncated: true,
    completeFrom: "2026-07-01T00:00:00Z",
  };
  const read = (fetched: DeliveryFetch, over: Partial<{ range: DeliveryRange }> = {}) => ({
    repo: "acme/api",
    snapshotAt: "2026-09-12T14:03:00Z",
    range,
    fetched,
    ...over,
  });

  it("the read's rows replace theirs by number, the rest survive, rows merged before the window are dropped, and the rows come back in number order", () => {
    const fixed = pr(3, "2026-09-11T12:00:00Z", { title: "change 3 (fixed)" });
    const four = pr(4, "2026-09-12T10:00:00Z");
    const merged = mergeSnapshot(
      previous,
      read({ prs: [four, fixed], truncated: false, completeFrom: "2026-09-12T12:50:00Z" }),
    );
    expect(merged.prs).toEqual([PRS[0], PRS[1], fixed, four]);
    expect(merged).toMatchObject({ repo: "acme/api", snapshotAt: "2026-09-12T14:03:00Z", range });
    const slid = weeks(SNAPSHOT_WEEKS, new Date(Date.parse("2026-09-25T14:03:00Z")));
    expect(slid.since).toBe(day("2026-06-29T00:00:00Z"));
    expect(mergeSnapshot(previous, read({ prs: [], truncated: false }, { range: slid })).prs).toEqual([PRS[1], PRS[2]]);
  });

  it("a read that reached back to the previous read's time joins its completeness — complete from the earlier of the two, never before the window's start — and one that stopped short is complete from its own reach alone", () => {
    // An incremental read went back to ten minutes before the previous read: the older truncation stands.
    const overlapping = mergeSnapshot(
      previous,
      read({ prs: [], truncated: false, completeFrom: "2026-09-12T12:50:00Z" }),
    );
    expect(overlapping).toMatchObject({ truncated: true, completeFrom: "2026-07-01T00:00:00Z" });
    // The window slid past the truncation: the snapshot is complete over what it now covers.
    const slid = weeks(SNAPSHOT_WEEKS, new Date(Date.parse("2026-10-05T14:03:00Z")));
    expect(slid.since).toBe(day("2026-07-13T00:00:00Z"));
    expect(
      mergeSnapshot(
        previous,
        read({ prs: [], truncated: false, completeFrom: "2026-09-12T12:50:00Z" }, { range: slid }),
      ),
    ).toMatchObject({ truncated: false, completeFrom: `${slid.since}T00:00:00Z` });
    // A capped read that stopped after the previous read's time cannot vouch for the gap between them.
    const gap = mergeSnapshot(previous, read({ prs: [], truncated: true, completeFrom: "2026-09-12T13:30:00Z" }));
    expect(gap).toMatchObject({ truncated: true, completeFrom: "2026-09-12T13:30:00Z" });
    // A capped full read over a complete snapshot: its reach overlaps, so the snapshot stays complete.
    const complete = { ...previous, truncated: false, completeFrom: windowStart };
    expect(
      mergeSnapshot(complete, read({ prs: [PRS[2]], truncated: true, completeFrom: "2026-08-20T00:00:00Z" })),
    ).toMatchObject({ truncated: false, completeFrom: windowStart, prs: PRS });
    // No previous snapshot: the read is the snapshot, complete from what it says (the window's start when it does not).
    expect(
      mergeSnapshot(undefined, read({ prs: PRS, truncated: true, completeFrom: "2026-08-20T00:00:00Z" })),
    ).toMatchObject({ truncated: true, completeFrom: "2026-08-20T00:00:00Z", prs: PRS });
    expect(mergeSnapshot(undefined, read({ prs: PRS, truncated: false }))).toMatchObject({
      truncated: false,
      completeFrom: windowStart,
    });
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
