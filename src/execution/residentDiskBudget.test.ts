import { describe, expect, it } from "vitest";
import {
  DISK_EVICT_MIN_IDLE_MS,
  DISK_FLOOR_FRACTION,
  DISK_FLOOR_MIN_KIB,
  DF_SAMPLE_ARGV,
  RECONCILE_DEPS_RATIO,
  SNAPSHOT_STAGING_RATIO,
  THREAD_USER_CACHE_DIRS,
  assembleDiskSample,
  checkDiskAdmission,
  diskPressureReason,
  diskReserveKiB,
  duArgv,
  effectiveFreeKiB,
  formatDiskGauge,
  formatGiB,
  isDiskPressureReason,
  orderEvictionCandidates,
  parseDfKiB,
  parseDu,
  projectThreadCostKiB,
  rawFreeAfterEviction,
  threadUserCacheCleanArgv,
  type DiskLayout,
  type DiskSample,
} from "./residentDiskBudget.js";

// Feature: features/resident-repos.md item 55 — disk is measured on every
// cycle and attach, persisted on the live view, and a thread tree is admitted
// only when its projected cost fits under free − reserve; the coldest clean
// idle trees are evicted first, then the attach is refused as `disk-pressure`
// with the math in the text.

const GIB = 1024 * 1024;
const MB = 1024; // KiB per MB, near enough for the fixtures below

// The nominal shape measured 2026-09-05/07 (#448): 15 GiB disk, mirror 0.36 GB,
// deps 2.1 GB, checkout rest 0.43 GB (history + tree).
const LAYOUT: DiskLayout = {
  mirrorDir: "/workspace/mirror",
  depsStoreDir: "/workspace/deps",
  checkoutDir: "/workspace/checkout",
  threads: [
    { threadKey: "slack:C1:1.1", dir: "/workspace/threads/slack-C1-1.1-aaaaaaaa" },
    { threadKey: "slack:C1:2.2", dir: "/workspace/threads/slack-C1-2.2-bbbbbbbb" },
  ],
  homes: [
    { user: "worker1", dir: "/home/worker1" },
    { user: "worker2", dir: "/home/worker2" },
  ],
};

const DU_OUT = [
  "360000\t/workspace/mirror",
  "2100000\t/workspace/deps",
  "430000\t/workspace/checkout",
  "450000\t/workspace/threads/slack-C1-1.1-aaaaaaaa",
  "2550000\t/workspace/threads/slack-C1-2.2-bbbbbbbb",
  "8\t/home/worker1",
  "2100000\t/home/worker2",
  "",
].join("\n");

const DF_OUT =
  "Filesystem     1024-blocks    Used Available Capacity Mounted on\n/dev/vdc          15086920 8100000   6986920      54% /\n";

function sample(overrides: Partial<DiskSample> = {}, parts: Partial<DiskSample["parts"]> = {}): DiskSample {
  return {
    at: "2026-09-07T15:00:00.000Z",
    totalKiB: 15 * GIB,
    usedKiB: 4 * GIB,
    freeKiB: 11 * GIB,
    ...overrides,
    parts: { mirror: 360 * MB, deps: 2100 * MB, checkout: 430 * MB, threads: {}, homes: {}, other: 600 * MB, ...parts },
  };
}

describe("measurement — one df, one du, hardlinks counted once", () => {
  it("the df probe is #472's exact argv (one parser for both the classifier and the gauge)", () => {
    expect([...DF_SAMPLE_ARGV]).toEqual(["df", "-Pk", "/workspace"]);
    expect(parseDfKiB(DF_OUT)).toEqual({ totalKiB: 15_086_920, usedKiB: 8_100_000, freeKiB: 6_986_920 });
    expect(parseDfKiB("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
    expect(parseDfKiB("Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay x 2 3 3% /\n")).toBeNull();
  });

  it("du argv: mirror, then the deps store BEFORE the checkout, then threads, then homes — the order that charges shared inodes to the deps term", () => {
    expect(duArgv(LAYOUT)).toEqual([
      "du",
      "-xsk",
      "/workspace/mirror",
      "/workspace/deps",
      "/workspace/checkout",
      "/workspace/threads/slack-C1-1.1-aaaaaaaa",
      "/workspace/threads/slack-C1-2.2-bbbbbbbb",
      "/home/worker1",
      "/home/worker2",
    ]);
  });

  it("parseDu reads `<KiB>\\t<path>` lines and ignores everything else (errors, blanks)", () => {
    const m = parseDu(
      "du: cannot read directory '/x': Permission denied\n4\t/x\n123\t/workspace/checkout\n\nnot a line\n",
    );
    expect([...m]).toEqual([
      ["/x", 4],
      ["/workspace/checkout", 123],
    ]);
  });

  it("assembleDiskSample itemizes every measured part by key and puts the remainder (image, /tmp, …) in `other`", () => {
    const s = assembleDiskSample({
      at: "2026-09-07T15:00:00.000Z",
      df: parseDfKiB(DF_OUT)!,
      du: parseDu(DU_OUT),
      layout: LAYOUT,
    });
    expect(s).toEqual({
      at: "2026-09-07T15:00:00.000Z",
      totalKiB: 15_086_920,
      usedKiB: 8_100_000,
      freeKiB: 6_986_920,
      parts: {
        mirror: 360_000,
        deps: 2_100_000,
        checkout: 430_000,
        threads: { "slack:C1:1.1": 450_000, "slack:C1:2.2": 2_550_000 },
        homes: { worker1: 8, worker2: 2_100_000 },
        other: 8_100_000 - (360_000 + 2_100_000 + 430_000 + 450_000 + 2_550_000 + 8 + 2_100_000),
      },
    });
  });

  it("a part du could not read is null (never 0), `other` is never negative", () => {
    const s = assembleDiskSample({
      at: "t",
      df: { totalKiB: 100, usedKiB: 10, freeKiB: 90 },
      du: parseDu("50\t/workspace/checkout\n"),
      layout: { ...LAYOUT, threads: [], homes: [] },
    });
    expect(s.parts.mirror).toBeNull();
    expect(s.parts.deps).toBeNull();
    expect(s.parts.checkout).toBe(50);
    expect(s.parts.other).toBe(0);
  });
});

describe("the reserve — snapshot staging + a floor", () => {
  it("staging is 0.6 × (mirror + deps + checkout); the floor is the larger of 1 GiB and 5 % of the disk", () => {
    const r = diskReserveKiB(sample());
    expect(SNAPSHOT_STAGING_RATIO).toBe(0.6);
    expect(r.stagingKiB).toBe(Math.round((360 + 2100 + 430) * MB * 0.6));
    expect(DISK_FLOOR_MIN_KIB).toBe(GIB);
    expect(DISK_FLOOR_FRACTION).toBe(0.05);
    expect(r.floorKiB).toBe(GIB); // 5 % of 15 GiB = 0.75 GiB < 1 GiB
    expect(r.totalKiB).toBe(r.stagingKiB + r.floorKiB);
  });

  it("on a larger disk the 5 % floor takes over", () => {
    expect(diskReserveKiB(sample({ totalKiB: 40 * GIB })).floorKiB).toBe(2 * GIB);
  });

  it("unmeasured parts count as 0 in staging — the floor still stands", () => {
    const r = diskReserveKiB(sample({}, { mirror: null, deps: null, checkout: null }));
    expect(r.stagingKiB).toBe(0);
    expect(r.floorKiB).toBe(GIB);
  });
});

describe("projecting a thread tree's cost from the checkout", () => {
  const parts = sample().parts;
  it("hardlink-eligible → the checkout's non-deps bytes (history + tree); lockfile differs → plus the reconcile share of the deps; reuse → 0", () => {
    expect(projectThreadCostKiB(parts, "hardlink")).toBe(430 * MB);
    expect(projectThreadCostKiB(parts, "reconcile")).toBe(430 * MB + Math.round(2100 * MB * RECONCILE_DEPS_RATIO));
    expect(projectThreadCostKiB(parts, "reuse")).toBe(0);
  });
  it("the reconcile share is a real fraction of the deps: strictly between a hardlink and a full copy (a delta install writes only the packages that differ)", () => {
    expect(RECONCILE_DEPS_RATIO).toBeGreaterThan(0);
    expect(RECONCILE_DEPS_RATIO).toBeLessThan(1);
    const reconcile = projectThreadCostKiB(parts, "reconcile") ?? 0;
    expect(reconcile).toBeGreaterThan(projectThreadCostKiB(parts, "hardlink") ?? 0);
    expect(reconcile).toBeLessThan((430 + 2100) * MB);
  });
  it("an unmeasured checkout (or deps, for a reconcile) is null, never a guess", () => {
    expect(projectThreadCostKiB({ ...parts, checkout: null }, "hardlink")).toBeNull();
    expect(projectThreadCostKiB({ ...parts, deps: null }, "reconcile")).toBeNull();
    expect(projectThreadCostKiB({ ...parts, deps: null }, "hardlink")).toBe(430 * MB);
  });
});

describe("diskBudgetMb — an operator cap below the physical disk", () => {
  it("no budget → the physical free space; a budget → the smaller of physical free and (budget − used), never negative", () => {
    const s = sample({ totalKiB: 15 * GIB, usedKiB: 6 * GIB, freeKiB: 9 * GIB });
    expect(effectiveFreeKiB(s, undefined)).toEqual({ capacityKiB: 15 * GIB, freeKiB: 9 * GIB, capped: false });
    expect(effectiveFreeKiB(s, 8 * 1024)).toEqual({ capacityKiB: 8 * GIB, freeKiB: 2 * GIB, capped: true });
    expect(effectiveFreeKiB(s, 4 * 1024)).toEqual({ capacityKiB: 4 * GIB, freeKiB: 0, capped: true });
    // A budget above the disk is the disk.
    expect(effectiveFreeKiB(s, 100 * 1024)).toEqual({ capacityKiB: 15 * GIB, freeKiB: 9 * GIB, capped: false });
  });
});

describe("checkDiskAdmission — free − reserve ≥ projected", () => {
  // nominal on 15 GiB: reserve = 0.6 × 2.89 GB + 1 GiB ≈ 2.74 GiB.
  it("plenty of room → fits, with the math", () => {
    const v = checkDiskAdmission({ sample: sample(), kind: "hardlink" });
    expect(v.fits).toBe(true);
    expect(v.math.projectedKiB).toBe(430 * MB);
    expect(v.math.freeKiB).toBe(11 * GIB);
    expect(v.math.headroomKiB).toBe(11 * GIB - v.math.reserve.totalKiB - 430 * MB);
  });

  it("a reconciling thread that would eat into the reserve does not fit, and the shortfall is exact", () => {
    // Free = reserve + a hardlinked tree + 100 MB: the hardlink fits, the
    // reconcile share of the deps does not, and the shortfall is that share
    // minus the 100 MB of slack.
    const reserve = diskReserveKiB(sample()).totalKiB;
    const free = reserve + 430 * MB + 100 * MB;
    const s = sample({ usedKiB: 15 * GIB - free, freeKiB: free });
    const v = checkDiskAdmission({ sample: s, kind: "reconcile" });
    expect(v.fits).toBe(false);
    expect(v.fits === false && v.shortfallKiB).toBe(Math.round(2100 * MB * RECONCILE_DEPS_RATIO) - 100 * MB);
    // The same disk admits a hardlinked tree.
    expect(checkDiskAdmission({ sample: s, kind: "hardlink" }).fits).toBe(true);
  });

  it("a fresher df free reading overrides the sample's (the attach re-probes df, the du parts are the last cycle's)", () => {
    const s = sample({ usedKiB: 4 * GIB, freeKiB: 11 * GIB });
    expect(checkDiskAdmission({ sample: s, kind: "reconcile", freeKiB: 3 * GIB }).fits).toBe(false);
    expect(checkDiskAdmission({ sample: s, kind: "reconcile", freeKiB: 6 * GIB }).fits).toBe(true);
  });

  it("the budget cap lowers free: a 6 GB budget on a 15 GiB disk with 4 GiB used leaves ~2 GB, under the reserve → refused", () => {
    const v = checkDiskAdmission({ sample: sample(), kind: "hardlink", diskBudgetMb: 6 * 1024 });
    expect(v.fits).toBe(false);
    expect(v.math.capacityKiB).toBe(6 * GIB);
    expect(v.math.freeKiB).toBe(2 * GIB);
  });

  it("an unmeasured projection admits only while free clears the reserve (never refuses a fresh resident on a guess; never admits past the floor blind)", () => {
    const fresh = sample({}, { checkout: null, deps: null, mirror: null });
    const ok = checkDiskAdmission({ sample: fresh, kind: "reconcile" });
    expect(ok.fits).toBe(true);
    expect(ok.math.projectedKiB).toBeNull();
    const tight = checkDiskAdmission({
      sample: { ...fresh, usedKiB: 14.5 * GIB, freeKiB: 0.5 * GIB },
      kind: "hardlink",
    });
    expect(tight.fits).toBe(false);
  });

  it("in-flight commitments are deducted ONCE from the raw df reading (review F1): passing committed is the same verdict as passing the net free, and never goes negative", () => {
    const s = sample({ usedKiB: 10 * GIB, freeKiB: 5 * GIB });
    const viaCommitted = checkDiskAdmission({ sample: s, freeKiB: 5 * GIB, committedKiB: GIB, kind: "hardlink" });
    const viaNet = checkDiskAdmission({ sample: s, freeKiB: 4 * GIB, kind: "hardlink" });
    expect(viaCommitted).toEqual(viaNet);
    expect(viaCommitted.math.freeKiB).toBe(4 * GIB);
    expect(checkDiskAdmission({ sample: s, freeKiB: GIB, committedKiB: 3 * GIB, kind: "hardlink" }).math.freeKiB).toBe(
      0,
    );
  });

  it("rawFreeAfterEviction: a re-probe that answered wins; one that did not → the previous RAW reading plus the evicted bytes (unknown size adds nothing)", () => {
    expect(rawFreeAfterEviction(5 * GIB, { freeKiB: 6 * GIB }, 450_000)).toBe(6 * GIB);
    expect(rawFreeAfterEviction(5 * GIB, null, 450_000)).toBe(5 * GIB + 450_000);
    expect(rawFreeAfterEviction(5 * GIB, null, null)).toBe(5 * GIB);
    // The fallback feeds checkDiskAdmission a RAW number, so the commitment is deducted exactly once there.
    const s = sample({ usedKiB: 10 * GIB, freeKiB: 5 * GIB });
    const after = checkDiskAdmission({
      sample: s,
      freeKiB: rawFreeAfterEviction(5 * GIB, null, GIB),
      committedKiB: GIB,
      kind: "hardlink",
    });
    expect(after.math.freeKiB).toBe(5 * GIB);
  });

  it("reuse costs nothing — an existing tree is never refused for space", () => {
    const v = checkDiskAdmission({ sample: sample({ usedKiB: 12 * GIB, freeKiB: 3 * GIB }), kind: "reuse" });
    expect(v.fits).toBe(true);
    expect(v.math.projectedKiB).toBe(0);
  });
});

describe("orderEvictionCandidates — coldest clean idle trees first, every keep named", () => {
  const now = Date.parse("2026-09-07T15:00:00.000Z");
  const c = (
    threadKey: string,
    minsAgo: number,
    extra: Partial<Parameters<typeof orderEvictionCandidates>[0]["candidates"][number]> = {},
  ) => ({
    threadKey,
    ref: "feat/x",
    lastAttachAt: new Date(now - minsAgo * 60_000).toISOString(),
    busy: 0,
    isDefaultRef: false,
    sizeKiB: 450_000,
    ...extra,
  });

  it("orders eligible trees oldest attach first (ties on key) and keeps the requester, busy, default-branch and recent trees by name", () => {
    const r = orderEvictionCandidates({
      now,
      requestingThreadKey: "me",
      candidates: [
        c("me", 500),
        c("busy", 500, { busy: 2 }),
        c("main-tree", 500, { isDefaultRef: true, ref: "main" }),
        c("recent", 3),
        c("cold-b", 120),
        c("cold-a", 120),
        c("coldest", 600),
      ],
    });
    expect(r.order.map((x) => x.threadKey)).toEqual(["coldest", "cold-a", "cold-b"]);
    expect(r.kept).toEqual([
      { threadKey: "me", why: "requesting", detail: "the thread being attached" },
      { threadKey: "busy", why: "busy", detail: "2 operation(s) in flight" },
      { threadKey: "main-tree", why: "default-ref", detail: "on the default branch main" },
      { threadKey: "recent", why: "recent", detail: "attached 3m ago (floor 10m)" },
    ]);
  });

  it("the idle floor is 10 minutes — longer than any gap between tool calls, shorter than the hourly clean-idle release", () => {
    expect(DISK_EVICT_MIN_IDLE_MS).toBe(10 * 60_000);
    expect(orderEvictionCandidates({ now, requestingThreadKey: "me", candidates: [c("x", 10)] }).order).toHaveLength(1);
    expect(orderEvictionCandidates({ now, requestingThreadKey: "me", candidates: [c("x", 9)] }).order).toHaveLength(0);
  });

  it("an unparsable lastAttachAt is kept as recent (unknown is never idle)", () => {
    const r = orderEvictionCandidates({
      now,
      requestingThreadKey: "me",
      candidates: [c("x", 0, { lastAttachAt: "garbage" })],
    });
    expect(r.order).toHaveLength(0);
    expect(r.kept[0].why).toBe("recent");
  });
});

describe("diskPressureReason — the refusal names free, reserve, projected, what was evicted and what was kept", () => {
  it("full shape", () => {
    const s = sample({ usedKiB: 12 * GIB, freeKiB: 3 * GIB });
    const v = checkDiskAdmission({ sample: s, kind: "reconcile" });
    if (v.fits) throw new Error("fixture must not fit");
    const text = diskPressureReason({
      verdict: v,
      evicted: [{ freedKiB: 450_000 }],
      kept: [{ why: "busy" }, { why: "dirty" }, { why: "other" }],
    });
    // 430 MB + 0.25 × 2100 MB = 955 MB (0.93 GiB) projected; reserve = 0.6 × 2890 MB + 1 GiB = 1734 MB + 1024 MB = 2.69 GiB; 3 − 2.69 = 0.31 left; short 0.63.
    expect(text).toMatch(
      /^disk-pressure: need 0\.93 GiB for a new tree \(reconcile\), but 3\.00 GiB free minus the 2\.69 GiB reserve \(snapshot staging 1\.69 GiB \+ floor 1\.00 GiB\) leaves 0\.31 GiB — short by 0\.63 GiB; /,
    );
    expect(text).not.toContain("cap"); // no diskBudgetMb → no cap named
    expect(text).toContain("evicted 1 idle tree(s) (0.43 GiB back)");
    expect(text).toContain("kept 3 (busy 1, dirty 1, other 1)");
    // Item 62: the refusal reaches the requesting thread's card, so it names
    // counts and tokens only — never another thread's key or its free text.
    // The type no longer admits a key or a detail, so the refusal cannot carry one.
    expect(text).not.toContain("slack:C1:");
    expect(isDiskPressureReason(text)).toBe(true);
    expect(isDiskPressureReason("disk-full: x")).toBe(false);
  });

  it("names a budget cap and an unmeasured projection when those decided", () => {
    const v = checkDiskAdmission({
      sample: sample({}, { checkout: null, deps: null }),
      kind: "hardlink",
      diskBudgetMb: 4 * 1024,
    });
    if (v.fits) throw new Error("fixture must not fit");
    const text = diskPressureReason({ verdict: v, evicted: [], kept: [] });
    expect(text).toContain("need a new tree (hardlink) of UNMEASURED cost (no du sample yet)");
    expect(text).toContain("free under the 4.00 GiB diskBudgetMb cap");
    expect(text).toContain("evicted nothing");
  });
});

describe("formatting — one unit everywhere", () => {
  it("formatGiB: two decimals under 10 GiB, one above, `?` for unknown; the gauge is used/total (pct)", () => {
    expect(formatGiB(450_000)).toBe("0.43 GiB");
    expect(formatGiB(15_086_920)).toBe("14.4 GiB");
    expect(formatGiB(null)).toBe("?");
    expect(formatDiskGauge({ totalKiB: 15_086_920, usedKiB: 6_500_000 })).toBe("6.20 GiB/14.4 GiB (43%)");
    expect(formatDiskGauge({ totalKiB: 0, usedKiB: 0 })).toBe("0.00 GiB/0.00 GiB (0%)");
  });
});

describe("threadUserCacheCleanArgv — an eviction removes the pool user's package-manager leftovers too", () => {
  it("pnpm store, tool caches, npm/yarn/bun caches under the home, in one rm", () => {
    expect([...THREAD_USER_CACHE_DIRS]).toEqual([".local/share/pnpm", ".cache", ".npm", ".yarn", ".bun"]);
    expect(threadUserCacheCleanArgv("/home/worker7")).toEqual([
      "rm",
      "-rf",
      "/home/worker7/.local/share/pnpm",
      "/home/worker7/.cache",
      "/home/worker7/.npm",
      "/home/worker7/.yarn",
      "/home/worker7/.bun",
    ]);
  });
});
