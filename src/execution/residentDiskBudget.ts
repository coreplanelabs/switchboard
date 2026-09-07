// Disk as a measured, budgeted resource on a resident (#448, features/
// resident-repos.md item 55). Pure decisions the resident Worker (deploy/
// cloudflare-resident/worker.ts) imports, like residentDisk / residentRefresh:
// no I/O, no clock — `now` is an input, `df`/`du` output comes in as text.
//
// Why this exists: until #457/#472 nothing measured a resident's disk and
// ENOSPC was the first signal (2026-09-04: nominal filled 8 GB in 45 min). #472
// names a FULL disk after the fact; this module keeps it from filling: every
// refresh cycle and every attach measures the disk (one `df`, one `du` over
// the components — hardlinks counted once), the sample is persisted on the
// resident's live view, and a thread tree is created only when the projected
// cost fits under the free space minus a reserve — evicting the coldest clean
// idle trees first, then refusing with `disk-pressure` (the bot falls back to
// the cold sandbox legibly, like `mirror-busy`). The math is in every refusal.

import { DF_FREE_ARGV, parseDfKiB } from "./residentDisk.js";

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** The components of a resident's disk, in KiB, from ONE `du -xsk` invocation
 *  (GNU du counts a hardlinked inode once per invocation and charges it to the
 *  first argument that reaches it — so argument ORDER decides who pays for
 *  shared bytes; `duArgv` fixes the order). `null` = the path was not
 *  measured (absent, or du could not read it). */
export interface DiskParts {
  /** `/workspace/mirror` — the bare mirror (history once). */
  mirror: number | null;
  /** `/workspace/checkout/node_modules` — the warm dependency cache; the
   *  bytes a hardlinked thread tree shares are charged HERE, never to the thread. */
  deps: number | null;
  /** `/workspace/checkout` minus its node_modules: history + tree + build
   *  output — what a hardlink-eligible thread tree costs on its own. */
  checkout: number | null;
  /** threadKey → the UNIQUE bytes of that thread's tree (its own history clone,
   *  tree, plain-copied build dirs and mutable caches; an `install` thread's
   *  own node_modules). */
  threads: Record<string, number>;
  /** pool user → bytes under `/home/<user>`: a pnpm store or npm cache a
   *  thread install left behind, outside the tree the eviction removes. */
  homes: Record<string, number>;
  /** `used − Σ(the above)`: the OS image, /tmp, everything not itemized. */
  other: number;
}

/** One measurement of the resident's disk, persisted on the live view
 *  (`live.disk`) and rendered on `/residents`, `repo list`, the watchdog line. */
export interface DiskSample {
  /** ISO time the measurement was taken. */
  at: string;
  totalKiB: number;
  usedKiB: number;
  freeKiB: number;
  parts: DiskParts;
}

export const DF_SAMPLE_ARGV = DF_FREE_ARGV;

/** What the Worker hands `duArgv`/`assembleDiskSample`: the fixed layout plus
 *  the live thread trees and pool-user homes to itemize. */
export interface DiskLayout {
  mirrorDir: string;
  checkoutDir: string;
  /** Live bindings: the thread's top-level dir under /workspace/threads (the
   *  700 per-thread dir the eviction removes), keyed for the sample. */
  threads: ReadonlyArray<{ threadKey: string; dir: string }>;
  /** Every pool user's home, live or not — an evicted user's leftover store
   *  is exactly what this itemizes. */
  homes: ReadonlyArray<{ user: string; dir: string }>;
}

/** `du -xsk` over every component in the ONE order the accounting needs:
 *  mirror first, then the checkout's node_modules BEFORE the checkout itself
 *  (so `checkout` reads as history + tree, the hardlink-eligible thread cost),
 *  then each thread tree (charged only what it does not share with the
 *  checkout), then the homes. `-x` stays on the workspace filesystem; `-s`
 *  one total per argument; `-k` KiB. */
export function duArgv(layout: DiskLayout): string[] {
  return [
    "du",
    "-xsk",
    layout.mirrorDir,
    `${layout.checkoutDir}/node_modules`,
    layout.checkoutDir,
    ...layout.threads.map((t) => t.dir),
    ...layout.homes.map((h) => h.dir),
  ];
}

/** `du -xsk` output → path → KiB. Lines that are not `<digits><tab><path>` are
 *  ignored (du writes its errors to stderr, but a caller may hand both). A
 *  missing path simply has no line — `null` in the sample, never 0. */
export function parseDu(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const m = /^(\d+)\t(.+)$/.exec(line.trimEnd());
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

/** Fold the two probes into the persisted sample. `df` is authoritative for
 *  total/used/free; the `du` lines itemize `used`, and whatever they do not
 *  cover is `other` (never negative — a du that raced a delete is clamped). */
export function assembleDiskSample(input: {
  at: string;
  df: { totalKiB: number; usedKiB: number; freeKiB: number };
  du: ReadonlyMap<string, number>;
  layout: DiskLayout;
}): DiskSample {
  const { du, layout } = input;
  const get = (path: string): number | null => du.get(path) ?? null;
  const deps = get(`${layout.checkoutDir}/node_modules`);
  const parts: DiskParts = {
    mirror: get(layout.mirrorDir),
    deps,
    checkout: get(layout.checkoutDir),
    threads: {},
    homes: {},
    other: 0,
  };
  let itemized = (parts.mirror ?? 0) + (deps ?? 0) + (parts.checkout ?? 0);
  for (const t of layout.threads) {
    const kib = get(t.dir);
    if (kib !== null) {
      parts.threads[t.threadKey] = kib;
      itemized += kib;
    }
  }
  for (const h of layout.homes) {
    const kib = get(h.dir);
    if (kib !== null) {
      parts.homes[h.user] = kib;
      itemized += kib;
    }
  }
  parts.other = Math.max(0, input.df.usedKiB - itemized);
  return { at: input.at, ...input.df, parts };
}

export { parseDfKiB };

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/** The refresh cycle snapshots mirror + checkout to R2 through the Sandbox
 *  SDK (`createBackup`); whether it stages a tarball on local disk is
 *  SDK-internal, so the budget holds room for one compressed copy of what it
 *  archives — the same ratio `instanceSizing.test.ts` sizes the instance with. */
export const SNAPSHOT_STAGING_RATIO = 0.6;

/** The fixed floor under the staging term: at least 1 GiB, or 5 % of the disk
 *  when that is more. 1 GiB is ~2.5 hardlinked nominal thread trees of slack
 *  for what no projection sees — git's pack scratch, a `cp -al` fallback to a
 *  plain copy, an exec writing under /tmp, `du` racing a write — and it is
 *  eight times #472's 128 MiB `disk-full` floor, so admission always refuses
 *  well before the failure classifier would have to speak. 5 % keeps the
 *  margin proportional on a larger instance (20 GB → 1 GB, the same number
 *  today; the fraction is for when the cap moves). */
export const DISK_FLOOR_MIN_KIB = 1024 * 1024;
export const DISK_FLOOR_FRACTION = 0.05;

export interface DiskReserve {
  stagingKiB: number;
  floorKiB: number;
  totalKiB: number;
}

/** `staging + floor`. Staging is computed from the MEASURED mirror and
 *  checkout (deps + rest); an unmeasured part counts as 0 there — the floor
 *  still stands, and `projectThreadCostKiB` refuses to project from missing
 *  parts, so an unmeasured resident never admits on a guess. */
export function diskReserveKiB(sample: Pick<DiskSample, "totalKiB" | "parts">): DiskReserve {
  const archived = (sample.parts.mirror ?? 0) + (sample.parts.deps ?? 0) + (sample.parts.checkout ?? 0);
  const stagingKiB = Math.round(archived * SNAPSHOT_STAGING_RATIO);
  const floorKiB = Math.max(DISK_FLOOR_MIN_KIB, Math.round(sample.totalKiB * DISK_FLOOR_FRACTION));
  return { stagingKiB, floorKiB, totalKiB: stagingKiB + floorKiB };
}

/** What creating this thread's tree will cost. `reuse`: the tree already
 *  exists with its deps (0). `hardlink`: the committed lockfile matches the
 *  warm checkout's, so node_modules is `cp -al` — the tree costs history +
 *  tree (the checkout's own non-deps bytes). `install`: the lockfile differs
 *  and the thread installs its own node_modules — plus the deps term. */
export type ThreadCostKind = "reuse" | "hardlink" | "install";

/** `null` when the parts needed are not measured yet (no sample, or du could
 *  not read the checkout) — the caller decides what an unknown cost means
 *  (`planDiskAdmission`: admit only while the floor alone is met). */
export function projectThreadCostKiB(parts: DiskParts, kind: ThreadCostKind): number | null {
  if (kind === "reuse") return 0;
  if (parts.checkout === null) return null;
  if (kind === "hardlink") return parts.checkout;
  if (parts.deps === null) return null;
  return parts.checkout + parts.deps;
}

/** The disk the resident may use: the physical total, lowered by the record's
 *  `diskBudgetMb` when set (an operator's cap under the instance size — the
 *  first thing that ever reads the field). Free under the cap is what is
 *  left of the cap after `used`, never more than the physical free space. */
export function effectiveFreeKiB(
  sample: Pick<DiskSample, "totalKiB" | "usedKiB" | "freeKiB">,
  diskBudgetMb: number | undefined,
): { capacityKiB: number; freeKiB: number; capped: boolean } {
  const budgetKiB = diskBudgetMb === undefined ? Number.POSITIVE_INFINITY : diskBudgetMb * 1024;
  const capped = budgetKiB < sample.totalKiB;
  const capacityKiB = capped ? budgetKiB : sample.totalKiB;
  const freeKiB = Math.max(0, Math.min(sample.freeKiB, capacityKiB - sample.usedKiB));
  return { capacityKiB, freeKiB, capped };
}

export interface AdmissionMath {
  /** What the tree will cost, or null when unmeasured. */
  projectedKiB: number | null;
  kind: ThreadCostKind;
  /** Free space under the cap (physical free, or the budget's remainder). */
  freeKiB: number;
  capacityKiB: number;
  /** True when `diskBudgetMb` lowered the capacity under the physical disk. */
  capped: boolean;
  reserve: DiskReserve;
  /** `free − reserve − projected`; negative = the shortfall. */
  headroomKiB: number;
}

export type AdmissionVerdict =
  { fits: true; math: AdmissionMath } | { fits: false; math: AdmissionMath; shortfallKiB: number };

/** The admission test: `free − reserve ≥ projected`. With an unmeasured
 *  projection (`null`) the tree is admitted only while the free space clears
 *  the reserve at all — the resident has never measured itself (a fresh
 *  container before its first cycle), and refusing every attach until it does
 *  would make the gauge a new outage; the refusal text says the cost was
 *  unmeasured when it does refuse. */
export function checkDiskAdmission(input: {
  sample: DiskSample;
  /** A fresher RAW `df` free reading than the sample's (the attach re-probes
   *  `df`, cheap, while the du parts come from the last full measurement). */
  freeKiB?: number;
  /** Projected bytes of attaches admitted but not yet on disk (the Worker's
   *  in-flight commitments). Deducted ONCE here, from the raw reading — the
   *  caller never pre-deducts, so a re-check can never deduct twice. */
  committedKiB?: number;
  diskBudgetMb?: number;
  kind: ThreadCostKind;
}): AdmissionVerdict {
  const rawFree = Math.max(0, (input.freeKiB ?? input.sample.freeKiB) - (input.committedKiB ?? 0));
  const live = { ...input.sample, freeKiB: rawFree, usedKiB: input.sample.totalKiB - rawFree };
  const { capacityKiB, freeKiB, capped } = effectiveFreeKiB(live, input.diskBudgetMb);
  const reserve = diskReserveKiB(input.sample);
  const projectedKiB = projectThreadCostKiB(input.sample.parts, input.kind);
  const headroomKiB = freeKiB - reserve.totalKiB - (projectedKiB ?? 0);
  const math: AdmissionMath = { projectedKiB, kind: input.kind, freeKiB, capacityKiB, capped, reserve, headroomKiB };
  return headroomKiB >= 0 ? { fits: true, math } : { fits: false, math, shortfallKiB: -headroomKiB };
}

/** The raw free reading to re-check with after an eviction: the re-probe's
 *  answer when `df` answered, else the previous RAW reading plus the bytes the
 *  evicted tree was measured at (unknown size → nothing added). Always raw —
 *  `checkDiskAdmission` deducts the commitments itself. */
export function rawFreeAfterEviction(
  previousRawFreeKiB: number,
  probe: { freeKiB: number } | null,
  freedKiB: number | null,
): number {
  return probe ? probe.freeKiB : previousRawFreeKiB + (freedKiB ?? 0);
}

// ---------------------------------------------------------------------------
// Making room: the coldest clean idle trees first
// ---------------------------------------------------------------------------

/** A tree attached more recently than this is presumed to belong to a run in
 *  progress (the bot detaches on finish, so a live binding is either in a run
 *  or leaked) and is never evicted for space — between two tool calls its op
 *  counter is 0 for seconds at a time, and a run would lose its tree mid-flight
 *  (self-healing via `needs:"attach"`, but a needless recreate). 10 min is
 *  longer than any gap between tool calls in a run and shorter than the
 *  hourly clean-idle release, so the pressure path reaches trees the sweep
 *  has not got to yet. */
export const DISK_EVICT_MIN_IDLE_MS = 10 * 60_000;

export interface DiskEvictionCandidate {
  threadKey: string;
  ref: string;
  lastAttachAt: string;
  /** Ops in flight on this binding right now. */
  busy: number;
  isDefaultRef: boolean;
  /** Unique bytes of its tree from the last sample; null when unmeasured. */
  sizeKiB: number | null;
}

export type DiskKeepWhy = "busy" | "default-ref" | "recent" | "dirty" | "requesting";

/** Order the live trees for eviction under pressure and name every one that is
 *  kept: the requesting thread itself, a busy tree, the default branch (the
 *  one most likely re-attached — the same rule as `reclaimDecision`), and a
 *  tree attached within `DISK_EVICT_MIN_IDLE_MS` are never candidates; the
 *  rest are ordered coldest first (oldest `lastAttachAt`, ties on key).
 *  Cleanliness is NOT decided here — it needs the container (as the thread
 *  user), so the Worker checks each candidate in this order and keeps a dirty
 *  or unreadable one (`dirty`), exactly like the sweep. */
export function orderEvictionCandidates(input: {
  candidates: readonly DiskEvictionCandidate[];
  now: number;
  requestingThreadKey: string;
  minIdleMs?: number;
}): {
  order: DiskEvictionCandidate[];
  kept: Array<{ threadKey: string; why: DiskKeepWhy; detail: string }>;
} {
  const minIdle = input.minIdleMs ?? DISK_EVICT_MIN_IDLE_MS;
  const order: DiskEvictionCandidate[] = [];
  const kept: Array<{ threadKey: string; why: DiskKeepWhy; detail: string }> = [];
  for (const c of input.candidates) {
    if (c.threadKey === input.requestingThreadKey) {
      kept.push({ threadKey: c.threadKey, why: "requesting", detail: "the thread being attached" });
      continue;
    }
    if (c.busy > 0) {
      kept.push({ threadKey: c.threadKey, why: "busy", detail: `${c.busy} operation(s) in flight` });
      continue;
    }
    if (c.isDefaultRef) {
      kept.push({ threadKey: c.threadKey, why: "default-ref", detail: `on the default branch ${c.ref}` });
      continue;
    }
    const idleMs = input.now - Date.parse(c.lastAttachAt);
    if (!(idleMs >= minIdle)) {
      kept.push({
        threadKey: c.threadKey,
        why: "recent",
        detail: `attached ${formatAgo(idleMs)} ago (floor ${formatAgo(minIdle)})`,
      });
      continue;
    }
    order.push(c);
  }
  order.sort((a, b) => a.lastAttachAt.localeCompare(b.lastAttachAt) || a.threadKey.localeCompare(b.threadKey));
  return { order, kept };
}

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${Math.max(0, min)}m` : `${Math.round(min / 60)}h`;
}

// ---------------------------------------------------------------------------
// The refusal, with the math in it
// ---------------------------------------------------------------------------

export const DISK_PRESSURE_REASON = "disk-pressure";

/** `x.y GiB` (two decimals under 10 GiB, one above) — the unit every disk
 *  number on `/residents`, `repo list`, the watchdog line and the refusal
 *  shares, so the same quantity never reads two ways. */
export function formatGiB(kib: number | null | undefined): string {
  if (kib === null || kib === undefined || !Number.isFinite(kib)) return "?";
  const gib = kib / (1024 * 1024);
  return `${gib < 10 ? gib.toFixed(2) : gib.toFixed(1)} GiB`;
}

/** `6.5/15.0 GiB (43%)` — the one-line gauge for lists and status lines. */
export function formatDiskGauge(sample: Pick<DiskSample, "totalKiB" | "usedKiB">): string {
  const pct = sample.totalKiB > 0 ? Math.round((sample.usedKiB / sample.totalKiB) * 100) : 0;
  return `${formatGiB(sample.usedKiB)}/${formatGiB(sample.totalKiB)} (${pct}%)`;
}

/** The `disk-pressure` refusal: the projection (or that it is unmeasured), the
 *  free space under the cap, the reserve and its two terms, what was evicted
 *  (with the bytes it gave back) and what was kept and why — every number the
 *  decision used, so the card, the log and the operator see the same math. */
export function diskPressureReason(input: {
  verdict: Extract<AdmissionVerdict, { fits: false }>;
  evicted: ReadonlyArray<{ threadKey: string; freedKiB: number | null }>;
  kept: ReadonlyArray<{ threadKey: string; detail: string }>;
}): string {
  const { math } = input.verdict;
  const need =
    math.projectedKiB === null
      ? `a new tree (${math.kind}) of UNMEASURED cost (no du sample yet)`
      : `${formatGiB(math.projectedKiB)} for a new tree (${math.kind})`;
  const cap = math.capped ? ` under the ${formatGiB(math.capacityKiB)} diskBudgetMb cap` : "";
  const parts = [
    `${DISK_PRESSURE_REASON}: need ${need}, but ${formatGiB(math.freeKiB)} free${cap} minus the ${formatGiB(math.reserve.totalKiB)} reserve ` +
      `(snapshot staging ${formatGiB(math.reserve.stagingKiB)} + floor ${formatGiB(math.reserve.floorKiB)}) leaves ${formatGiB(Math.max(0, math.freeKiB - math.reserve.totalKiB))} — short by ${formatGiB(input.verdict.shortfallKiB)}`,
  ];
  if (input.evicted.length > 0) {
    const freed = input.evicted.reduce((a, e) => a + (e.freedKiB ?? 0), 0);
    parts.push(
      `evicted ${input.evicted.length} idle tree(s) (${formatGiB(freed)} back): ${input.evicted.map((e) => e.threadKey).join(", ")}`,
    );
  } else parts.push("evicted nothing");
  if (input.kept.length > 0)
    parts.push(`kept ${input.kept.length}: ${input.kept.map((k) => `${k.threadKey} (${k.detail})`).join(", ")}`);
  return parts.join("; ");
}

export function isDiskPressureReason(reason: string): boolean {
  return reason.startsWith(`${DISK_PRESSURE_REASON}:`);
}

// ---------------------------------------------------------------------------
// What an eviction must also remove: the user's package-manager leftovers
// ---------------------------------------------------------------------------

/** Relative to a pool user's home: where an `install` thread's package manager
 *  keeps what is NOT in the tree — pnpm's content-addressable store
 *  (`~/.local/share/pnpm/store`, the hardlink source of its node_modules: 0
 *  unique bytes while the tree lives, ALL of them once the tree is removed),
 *  pnpm's metadata cache and any tool cache (`~/.cache`), npm's tarball cache
 *  (`~/.npm`), yarn's and bun's. Removed with the tree on every eviction —
 *  the pool user is an arbitrary slot, so a store left behind is almost never
 *  reused and would otherwise outlive every thread that filled it (16 users ×
 *  a 2.1 GB store = the whole disk). The build user's home (`worker1`) is never
 *  touched here: its store is the warm checkout's hardlink source. */
export const THREAD_USER_CACHE_DIRS = [".local/share/pnpm", ".cache", ".npm", ".yarn", ".bun"] as const;

export function threadUserCacheCleanArgv(homeDir: string): string[] {
  return ["rm", "-rf", ...THREAD_USER_CACHE_DIRS.map((d) => `${homeDir}/${d}`)];
}
