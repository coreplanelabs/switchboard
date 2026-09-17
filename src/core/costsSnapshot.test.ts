import { describe, expect, it } from "vitest";
import {
  buildCostReport,
  EMPTY_USAGE,
  resolveRange,
  type CloudflareUsage,
  type CostGroupConfig,
  type LlmCostRow,
} from "./costs.js";
import { buildUserCostReport } from "./costsByUser.js";
import {
  COSTS_SNAPSHOT_EVERY_HOURS,
  CostsSnapshotter,
  MAX_USAGE_BACKFILL_ROUNDS,
  reportFromSnapshot,
  SNAPSHOT_DAYS,
  SNAPSHOT_TICK_MS,
  takeCostsSnapshot,
  usersReportFromSnapshot,
  type CostsSnapshotSources,
} from "./costsSnapshot.js";
import { InMemoryCostsSnapshotStore, type CostsSnapshot, type CostsSnapshotStore } from "./costsSnapshotStore.js";
import { NullRunStore, type RunStore } from "./runStore.js";
import type { RunUsageQuery, RunUsageReport } from "./runUsage.js";

// Feature: docs/reference/specs/costs.md item 6 — the costs snapshot: one read of
// both billing sources and the run history over the page's widest range, taken
// on an interval or on request, every report arithmetic over it.

// ---- fixtures ---------------------------------------------------------------

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const AUG_1 = iso(2026, 8, 1);
const SEP_1 = iso(2026, 9, 1);
const SEP_10 = iso(2026, 9, 10);
const SEP_15 = iso(2026, 9, 15);
const SEP_16 = iso(2026, 9, 16);
const T0 = Date.parse(`${SEP_16}T06:15:00.000Z`);
const GROUP: CostGroupConfig = {
  label: "Switchboard",
  workers: ["switchboard"],
  containerApps: { "app-bot": "bot" },
  durableObjectNamespaces: {},
  r2Buckets: {},
  anthropicWorkspaceId: "ws_1",
};
const USAGE: CloudflareUsage = {
  ...EMPTY_USAGE,
  containers: [
    {
      date: SEP_16,
      applicationId: "app-bot",
      cpuTimeSec: 3600,
      allocatedMemoryByteSec: 2 ** 30,
      allocatedDiskByteSec: 1e9,
    },
    {
      date: SEP_10,
      applicationId: "app-bot",
      cpuTimeSec: 1800,
      allocatedMemoryByteSec: 2 ** 30,
      allocatedDiskByteSec: 1e9,
    },
    {
      date: AUG_1,
      applicationId: "app-bot",
      cpuTimeSec: 900,
      allocatedMemoryByteSec: 2 ** 30,
      allocatedDiskByteSec: 1e9,
    },
  ],
  workers: [{ date: SEP_16, scriptName: "switchboard", requests: 1_000_000, cpuTimeUs: 5_000_000 }],
};
const LLM: LlmCostRow[] = [
  { date: SEP_15, workspaceId: "ws_1", amountUsd: 40 },
  { date: SEP_16, workspaceId: "ws_1", amountUsd: 12.5, estimated: true },
];
const RUN_USAGE: RunUsageReport = {
  rows: [
    {
      userId: "slack:UALICE",
      userName: "alice",
      day: SEP_16,
      runs: 2,
      wallMs: 3_600_000,
      usage: {
        turns: 1,
        byModel: {
          "anthropic/claude-haiku-4-5": {
            turns: 1,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    },
  ],
  pending: 0,
  earliestFinishedAt: Date.parse(`${SEP_1}T00:00:00Z`),
  retentionDays: 30,
};

/** A clock that advances by `stepMs` on every read, so a take has a duration. */
function clock(start = T0, stepMs = 0) {
  let t = start;
  return {
    now: () => {
      const at = new Date(t);
      t += stepMs;
      return at;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

/** A run store answering `usageByUser` from a queue of reports, recording the queries. */
function runStoreOf(answers: RunUsageReport[]): { store: RunStore; queries: RunUsageQuery[] } {
  const queries: RunUsageQuery[] = [];
  const queue = [...answers];
  // Only `usageByUser` is read here; the Null Object would read as history off.
  const store = {
    usageByUser: async (q: RunUsageQuery) => {
      queries.push(q);
      return queue.length > 1 ? queue.shift()! : queue[0]!;
    },
  } as unknown as RunStore;
  return { store, queries };
}

function sourcesOf(
  over: Partial<CostsSnapshotSources> = {},
  calls: { usage: number; llm: number } = { usage: 0, llm: 0 },
) {
  const sources: CostsSnapshotSources = {
    cloudflare: {
      fetchUsage: async () => {
        calls.usage += 1;
        return USAGE;
      },
    },
    llm: {
      fetchDailyCost: async () => {
        calls.llm += 1;
        return LLM;
      },
    },
    runStore: runStoreOf([RUN_USAGE]).store,
    ...over,
  };
  return { sources, calls };
}

// ---- takeCostsSnapshot -------------------------------------------------------

describe("takeCostsSnapshot", () => {
  it("reads both sources over the widest range the page offers, ending on the take day, and the run history over the same window; stamps who, when and how long", async () => {
    const c = clock(T0, 1_500);
    const ranges: unknown[] = [];
    const { store, queries } = runStoreOf([RUN_USAGE]);
    const { sources } = sourcesOf({
      cloudflare: {
        fetchUsage: async (range) => {
          ranges.push(range);
          return USAGE;
        },
      },
      llm: {
        fetchDailyCost: async (range) => {
          ranges.push(range);
          return LLM;
        },
      },
      runStore: store,
    });
    const snapshot = await takeCostsSnapshot(sources, { now: c.now, by: "schedule" });
    const window = resolveRange(String(SNAPSHOT_DAYS), new Date(T0));
    expect(window.days).toBe(31);
    expect(ranges).toEqual([window, window]);
    expect(queries).toEqual([
      { sinceMs: Date.parse(`${window.from}T00:00:00Z`), untilMs: Date.parse(`${window.to}T00:00:00Z`) + 86_400_000 },
    ]);
    expect(snapshot).toMatchObject({
      takenAt: new Date(T0).toISOString(),
      takenBy: "schedule",
      range: window,
      usage: USAGE,
      llm: LLM,
      runUsage: RUN_USAGE,
    });
    expect(snapshot.durationMs).toBe(1_500);
  });

  it("asks the run history again while it reports runs still being priced — the store heals its rows per call — and keeps the last answer; the rounds are bounded and what is still pending is kept as such", async () => {
    const healing = runStoreOf([{ ...RUN_USAGE, pending: 350 }, { ...RUN_USAGE, pending: 150 }, RUN_USAGE]);
    const healed = await takeCostsSnapshot(sourcesOf({ runStore: healing.store }).sources, {
      now: clock().now,
      by: "x",
    });
    expect(healing.queries).toHaveLength(3);
    expect(healed.runUsage?.pending).toBe(0);

    const stuck = runStoreOf([{ ...RUN_USAGE, pending: 9_999 }]);
    const capped = await takeCostsSnapshot(sourcesOf({ runStore: stuck.store }).sources, { now: clock().now, by: "x" });
    expect(stuck.queries).toHaveLength(MAX_USAGE_BACKFILL_ROUNDS);
    expect(capped.runUsage?.pending).toBe(9_999);
  });

  it("with no run store the snapshot carries no run usage; an LLM source with nothing configured leaves the LLM rows null", async () => {
    const { runStore: _none, ...noHistory } = sourcesOf({ llm: { fetchDailyCost: async () => null } }).sources;
    const snapshot = await takeCostsSnapshot(noHistory, { now: clock().now, by: "x" });
    expect(snapshot.runUsage).toBeNull();
    expect(snapshot.llm).toBeNull();
    const nullStore = await takeCostsSnapshot(sourcesOf({ runStore: new NullRunStore() }).sources, {
      now: clock().now,
      by: "x",
    });
    expect(nullStore.runUsage).toBeNull();
  });
});

// ---- reports from a snapshot ---------------------------------------------------

describe("reportFromSnapshot / usersReportFromSnapshot", () => {
  const snapshot: CostsSnapshot = {
    takenAt: new Date(T0).toISOString(),
    takenBy: "schedule",
    durationMs: 31_000,
    range: resolveRange(String(SNAPSHOT_DAYS), new Date(T0)),
    usage: USAGE,
    llm: LLM,
    runUsage: RUN_USAGE,
  };
  const meta = { accountId: "acct", accountName: "acme-infra" };

  it("a range is the report a live read at the snapshot's instant would have given: the same builder over the same rows, `today` the take day, stamped with the snapshot", () => {
    for (const days of ["1", "7", "30", null, "garbage", "400"]) {
      const range = resolveRange(days, new Date(T0));
      const expected = buildCostReport("switchboard", GROUP, USAGE, LLM, range, { ...meta, generatedAt: T0 });
      const got = reportFromSnapshot(snapshot, "switchboard", GROUP, days, meta);
      expect(got).toEqual({
        ...expected,
        snapshot: { takenAt: snapshot.takenAt, takenBy: "schedule", durationMs: 31_000 },
      });
    }
    const week = reportFromSnapshot(snapshot, "switchboard", GROUP, "7", meta);
    expect(week.range).toEqual({ from: SEP_10, to: SEP_16, days: 7, partialLastDay: true });
    expect(week.days.map((d) => d.date)).toContain(SEP_10);
    expect(week.days.map((d) => d.date)).not.toContain(AUG_1);
    expect(week.generatedAt).toBe(T0);
  });

  it("the by-user report is the builder over the snapshot's run usage for the range, history on; with run usage absent the history is off and nothing is attributed", () => {
    const daily = reportFromSnapshot(snapshot, "switchboard", GROUP, "7", meta);
    const expected = buildUserCostReport({
      group: "switchboard",
      range: daily.range,
      usage: RUN_USAGE,
      days: daily.days,
      historyOn: true,
      viewerUserIds: ["slack:UALICE"],
      matchedByEmail: true,
      generatedAt: T0,
    });
    const got = usersReportFromSnapshot(snapshot, daily, { viewerUserIds: ["slack:UALICE"], matchedByEmail: true });
    expect(got).toEqual({
      ...expected,
      snapshot: { takenAt: snapshot.takenAt, takenBy: "schedule", durationMs: 31_000 },
    });
    expect(got.users.map((u) => u.userId)).toEqual(["slack:UALICE"]);

    const off = usersReportFromSnapshot({ ...snapshot, runUsage: null }, daily, {
      viewerUserIds: [],
      matchedByEmail: false,
    });
    expect(off.coverage.historyOn).toBe(false);
    expect(off.users).toEqual([]);
  });
});

// ---- CostsSnapshotter ------------------------------------------------------------

function snapshotter(
  opts: {
    store?: CostsSnapshotStore;
    sources?: CostsSnapshotSources;
    everyHours?: number;
    clock?: ReturnType<typeof clock>;
  } = {},
) {
  const c = opts.clock ?? clock(T0, 0);
  const warnings: string[] = [];
  const calls = { usage: 0, llm: 0 };
  const store = opts.store ?? new InMemoryCostsSnapshotStore();
  const s = new CostsSnapshotter(opts.sources ?? sourcesOf({}, calls).sources, store, {
    everyHours: opts.everyHours ?? COSTS_SNAPSHOT_EVERY_HOURS.default,
    now: c.now,
    warn: (m) => warnings.push(m),
  });
  return { s, store, warnings, calls, clock: c };
}

describe("CostsSnapshotter", () => {
  it("current() reads the store once and answers from memory after; a store that cannot be read is an absent snapshot with a warning", async () => {
    let reads = 0;
    const stored: CostsSnapshot = {
      takenAt: new Date(T0 - 3_600_000).toISOString(),
      takenBy: "schedule",
      durationMs: 1,
      range: resolveRange(String(SNAPSHOT_DAYS), new Date(T0 - 3_600_000)),
      usage: USAGE,
      llm: LLM,
      runUsage: null,
    };
    const counting: CostsSnapshotStore = {
      get: async () => {
        reads += 1;
        return stored;
      },
      put: async () => undefined,
    };
    const { s } = snapshotter({ store: counting });
    expect(await s.current()).toEqual(stored);
    expect(await s.current()).toEqual(stored);
    expect(reads).toBe(1);

    const failing: CostsSnapshotStore = {
      get: async () => {
        throw new Error("Worker down");
      },
      put: async () => undefined,
    };
    const broken = snapshotter({ store: failing });
    expect(await broken.s.current()).toBeUndefined();
    expect(broken.warnings[0]).toContain("costs snapshot not read from the store: Worker down");
  });

  it("refresh(by) takes a snapshot, stores it and serves it from memory; callers arriving while one is being taken share it — the sources are read once", async () => {
    const { s, store, calls } = snapshotter();
    const [a, b] = await Promise.all([s.refresh("casey"), s.refresh("alice")]);
    expect(a).toBe(b);
    expect(a.takenBy).toBe("casey");
    expect(calls).toEqual({ usage: 1, llm: 1 });
    expect(await store.get()).toEqual(a);
    expect(await s.current()).toEqual(a);
    const again = await s.refresh("schedule");
    expect(again).not.toBe(a);
    expect(calls.usage).toBe(2);
  });

  it("a store that refuses the write is a warning — the snapshot in memory still serves; a take that fails rejects, keeps the previous snapshot and is named in the status until one succeeds", async () => {
    const refusing: CostsSnapshotStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error("HTTP 413");
      },
    };
    const kept = snapshotter({ store: refusing });
    const taken = await kept.s.refresh("casey");
    expect(kept.warnings).toEqual(["costs snapshot not stored: HTTP 413"]);
    expect(await kept.s.current()).toEqual(taken);

    let fail = false;
    const flaky = snapshotter({
      sources: {
        cloudflare: {
          fetchUsage: async () => {
            if (fail) throw new Error("cloudflare graphql 502");
            return USAGE;
          },
        },
        llm: { fetchDailyCost: async () => LLM },
      },
    });
    const first = await flaky.s.refresh("schedule");
    fail = true;
    await expect(flaky.s.refresh("casey")).rejects.toThrow("cloudflare graphql 502");
    expect(await flaky.s.current()).toEqual(first);
    expect(flaky.s.status().lastFailure).toEqual({
      at: new Date(T0).toISOString(),
      by: "casey",
      message: "cloudflare graphql 502",
    });
    fail = false;
    await flaky.s.refresh("casey");
    expect(flaky.s.status().lastFailure).toBeNull();
  });

  it("status(): nothing yet → no snapshot, nothing in flight, no next time; a snapshot → its stamp and the next take at takenAt + everyHours; while one is being taken → who started it and when", async () => {
    const c = clock(T0, 0);
    const { s } = snapshotter({ clock: c, everyHours: 24 });
    expect(s.status()).toEqual({ snapshot: null, inFlight: null, everyHours: 24, nextAt: null, lastFailure: null });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = snapshotter({
      clock: c,
      everyHours: 24,
      sources: {
        cloudflare: {
          fetchUsage: async () => {
            await gate;
            return USAGE;
          },
        },
        llm: { fetchDailyCost: async () => LLM },
      },
    });
    const taking = slow.s.refresh("casey");
    await Promise.resolve();
    expect(slow.s.status().inFlight).toEqual({ startedAt: new Date(T0).toISOString(), by: "casey" });
    release();
    const taken = await taking;
    expect(slow.s.status()).toEqual({
      snapshot: { takenAt: taken.takenAt, takenBy: "casey", durationMs: 0 },
      inFlight: null,
      everyHours: 24,
      nextAt: new Date(T0 + 24 * 3_600_000).toISOString(),
      lastFailure: null,
    });
  });

  it("subscribe(): a listener hears the status as a take starts, lands or fails; unsubscribing stops it", async () => {
    let fail = false;
    const { s } = snapshotter({
      sources: {
        cloudflare: {
          fetchUsage: async () => {
            if (fail) throw new Error("boom");
            return USAGE;
          },
        },
        llm: { fetchDailyCost: async () => LLM },
      },
    });
    const heard: string[] = [];
    const off = s.subscribe((status) =>
      heard.push(status.inFlight ? `started by ${status.inFlight.by}` : status.lastFailure ? "failed" : "taken"),
    );
    await s.refresh("casey");
    fail = true;
    await s.refresh("alice").catch(() => undefined);
    expect(heard).toEqual(["started by casey", "taken", "started by alice", "failed"]);
    off();
    fail = false;
    await s.refresh("bob");
    expect(heard).toHaveLength(4);
  });

  it("startRefreshLoop: a tick takes a snapshot when none is stored or the stored one is older than everyHours, leaves a young one alone, runs once at start, and a failing take is a warning the next tick retries", async () => {
    const c = clock(T0, 0);
    const store = new InMemoryCostsSnapshotStore();
    let fail = false;
    const calls = { usage: 0, llm: 0 };
    const { s, warnings } = snapshotter({
      clock: c,
      store,
      everyHours: 24,
      sources: {
        cloudflare: {
          fetchUsage: async () => {
            calls.usage += 1;
            if (fail) throw new Error("cloudflare graphql 502");
            return USAGE;
          },
        },
        llm: { fetchDailyCost: async () => LLM },
      },
    });
    let fire: (() => void) | undefined;
    let cleared = false;
    const loop = s.startRefreshLoop({
      setInterval: (fn, ms) => {
        expect(ms).toBe(SNAPSHOT_TICK_MS);
        fire = fn;
        return { unref: () => undefined };
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    // Runs once at start: nothing stored → taken.
    await loop.tick();
    expect(calls.usage).toBe(1);
    expect((await store.get())?.takenBy).toBe("schedule");
    // A young snapshot is left alone.
    c.set(T0 + 23 * 3_600_000);
    fire?.();
    await loop.tick();
    expect(calls.usage).toBe(1);
    // Past the interval → taken again; a failure is a warning, retried next tick.
    c.set(T0 + 25 * 3_600_000);
    fail = true;
    await loop.tick();
    expect(calls.usage).toBe(2);
    expect(warnings.at(-1)).toContain("costs snapshot not refreshed: cloudflare graphql 502");
    expect((await store.get())?.takenAt).toBe(new Date(T0).toISOString());
    fail = false;
    await loop.tick();
    expect(calls.usage).toBe(3);
    expect((await store.get())?.takenAt).toBe(new Date(T0 + 25 * 3_600_000).toISOString());
    loop.stop();
    expect(cleared).toBe(true);
  });
});
