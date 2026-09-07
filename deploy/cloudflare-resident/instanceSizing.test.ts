import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DISK_FLOOR_FRACTION,
  DISK_FLOOR_MIN_KIB,
  SNAPSHOT_STAGING_RATIO,
} from "../../src/execution/residentDiskBudget.js";

// The resident container's instance type is sized by arithmetic over MEASURED
// parts, and this test is where the arithmetic lives — wrangler.jsonc carries
// the number, this file carries the proof, and a change to either without the
// other fails here. Background (features/resident-repos.md items 54–55, #448):
// on 2026-09-04 the nominal resident filled its 8 GB disk 45 minutes after a
// fresh provision with ONE thread attached, and nothing had measured the disk
// before ENOSPC. 8 GB was the platform default, never a budget. Since item 55
// the disk IS a budget: the attach admission (`residentDiskBudget.ts`) admits a
// thread tree only under `free − reserve`, so the instance size no longer has
// to hold the pool's theoretical maximum — it decides how many concurrent
// trees fit before the next one falls back to a cold sandbox. The reserve
// terms below are imported from the budget module so the two cannot drift.

/** wrangler.jsonc is JSON with comments; strip them string-aware (URLs in
 *  string values contain `//`). Same reader as src/core/schedules.test.ts. */
function readJsonc(path: string): unknown {
  const text = readFileSync(path, "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface InstanceType {
  vcpu: number;
  memory_mib: number;
  disk_mb: number;
}

function configuredInstanceType(): InstanceType {
  const cfg = readJsonc(fileURLToPath(new URL("./wrangler.jsonc", import.meta.url))) as {
    containers?: Array<{ instance_type?: unknown }>;
  };
  const it = cfg.containers?.[0]?.instance_type;
  if (!it || typeof it !== "object")
    throw new Error("wrangler.jsonc: containers[0].instance_type must be a custom {vcpu, memory_mib, disk_mb} object");
  return it as InstanceType;
}

// Cloudflare's custom instance-type constraints (Containers docs "limits",
// mirrored in the wrangler.jsonc comment): whole vCPUs 1–4, at least 3 GiB of
// memory per vCPU, at most 2 GB of disk per GiB of memory, and a hard ceiling
// of 12 GiB memory / 20 GB disk.
const MIN_MEMORY_MIB_PER_VCPU = 3 * 1024;
const MAX_DISK_MB_PER_MEMORY_GIB = 2000;
const MAX_MEMORY_MIB = 12 * 1024;
const MAX_DISK_MB = 20_000;

// MEASURED 2026-09-07 15:27Z inside the nominal resident (a read-only attach as
// a pool user; `df -Pk`, ONE `du -xsk` invocation so hardlinks count once,
// `stat -c %h`), the largest onboarded repo — the one the shared type has to fit.
// nominal @ 6756da8, freshly restored from R2 with one hardlinked thread tree.
const KIB_PER_MB = 1000 / 1.024; // du/df report KiB; the instance type is in MB
const mb = (kib: number): number => Math.round(kib / KIB_PER_MB);
const NOMINAL = {
  historyMb: mb(371_264), // `.git` of the checkout = the mirror = each thread clone's own history (380 MB)
  treeMb: mb(91_624), // the working tree (94 MB)
  nodeModulesMb: mb(2_244_052), // pnpm node_modules (2298 MB); hardlinked into a thread tree UNLESS its lockfile differs
  // A hardlinked thread tree's UNIQUE bytes, measured directly (555 MB): its own
  // history clone + tree, PLUS ~80 MB of per-thread copies — the tool-managed
  // paths inside node_modules that item 18 swaps for real copies (`.bin`,
  // `.cache`, `.vite`, …) and `.git`'s index. Measured whole, not derived.
  hardlinkedThreadMb: mb(541_860),
};
// The OS image on the same filesystem: /usr 522 MB + /var 10 + /etc 2 + /tmp 6
// measured the same day (the 2026-09-04 estimate of ~500 MB held up).
const IMAGE_MB = mb(539_480);
// A 16 000 MB instance mounts as a 15 086 920 KiB ext4 filesystem: 3.4 % goes
// to the filesystem itself. The budget works in what `df` reports.
const FS_USABLE_RATIO = mb(15_086_920) / 16_000;
// The pnpm store term is ZERO — measured, not assumed (#448's open question):
// `/home/worker1` is 4 KiB on a restored disk (the store is not in the R2
// snapshot), and where an install has run, pnpm hardlinks node_modules from the
// store on the same ext4 filesystem (link count 2 on every `.pnpm` file =
// checkout + one thread tree; a store copy would read 3), so the store never
// holds a second copy of the deps. The issue's "2.5 GiB outside /workspace"
// was the pre-#464 thread tree carrying a full plain copy of node_modules.
const PNPM_STORE_MB = 0;

/** What a resident holding `repo` needs on disk with `hardlinked` thread trees
 *  sharing the warm checkout's deps and `installing` trees carrying their own
 *  node_modules (a lockfile that differs from the warm checkout's → a scoped
 *  install as that thread's user — its pnpm store hardlinks the same bytes, so
 *  the store adds nothing on top). The reserve is exactly what the attach
 *  admission holds back: snapshot staging + the floor. */
function requiredDiskMb(repo: typeof NOMINAL, hardlinked: number, installing: number, usableDiskMb: number): number {
  const mirror = repo.historyMb;
  const checkout = repo.historyMb + repo.treeMb + repo.nodeModulesMb;
  const installingThread = repo.hardlinkedThreadMb + repo.nodeModulesMb;
  const staging = Math.round((mirror + checkout) * SNAPSHOT_STAGING_RATIO);
  const floor = Math.max(mb(DISK_FLOOR_MIN_KIB), Math.round(usableDiskMb * DISK_FLOOR_FRACTION));
  return (
    IMAGE_MB +
    mirror +
    checkout +
    PNPM_STORE_MB +
    hardlinked * repo.hardlinkedThreadMb +
    installing * installingThread +
    staging +
    floor
  );
}

describe("resident instance type (deploy/cloudflare-resident/wrangler.jsonc)", () => {
  const it_ = configuredInstanceType();
  const usable = Math.round(it_.disk_mb * FS_USABLE_RATIO);

  it("satisfies Cloudflare's custom-type constraints (the deploy would refuse otherwise, but say why here)", () => {
    expect(Number.isInteger(it_.vcpu) && it_.vcpu >= 1 && it_.vcpu <= 4).toBe(true);
    expect(it_.memory_mib).toBeGreaterThanOrEqual(MIN_MEMORY_MIB_PER_VCPU * it_.vcpu);
    expect(it_.memory_mib).toBeLessThanOrEqual(MAX_MEMORY_MIB);
    expect(it_.disk_mb).toBeLessThanOrEqual(MAX_DISK_MB);
    expect(it_.disk_mb).toBeLessThanOrEqual((it_.memory_mib / 1024) * MAX_DISK_MB_PER_MEMORY_GIB);
  });

  // The shapes below are asserted RELATIONALLY (against the configured disk),
  // not as fixed sums: the model's inputs are the single source, so
  // re-measuring a part is a one-line edit here and nowhere else. For the
  // record, at the 2026-09-07 inputs: base (image + mirror + checkout + reserve)
  // 6669 MB; a hardlinked tree 555 MB; an installing tree 2853 MB; usable 15 449.

  it("the previous 8 GB did not fit even ONE installing thread plus the reserve — the 2026-09-04 shape", () => {
    // On 2026-09-04 EVERY pnpm thread carried a full copy of node_modules (the
    // `.pnpm` swap fixed by #464), so one thread cost what an installing thread
    // costs today; with the reserve the admission holds back, 8 GB was over
    // before the second attach.
    const previousDiskMb = 8000;
    expect(requiredDiskMb(NOMINAL, 0, 1, Math.round(previousDiskMb * FS_USABLE_RATIO))).toBeGreaterThan(previousDiskMb);
  });

  it("the configured disk fits the target working set: 10 hardlinked + 1 deps-installing trees, or 5 hardlinked + 2 deps-installing, each with the reserve", () => {
    expect(requiredDiskMb(NOMINAL, 10, 1, usable)).toBeLessThanOrEqual(usable);
    expect(requiredDiskMb(NOMINAL, 5, 2, usable)).toBeLessThanOrEqual(usable);
    // Not over-provisioned either: memory (and so cost) follows disk.
    expect(usable).toBeLessThan(requiredDiskMb(NOMINAL, 5, 2, usable) * 1.25);
  });

  it("the pool's theoretical maximum (16 hardlinked + 2 installing) fits NEITHER this disk NOR the 20 GB platform ceiling — admission is not optional at any affordable size", () => {
    expect(requiredDiskMb(NOMINAL, 16, 2, usable)).toBeGreaterThan(usable);
    const ceilingUsable = Math.round(MAX_DISK_MB * FS_USABLE_RATIO);
    expect(requiredDiskMb(NOMINAL, 16, 2, ceilingUsable)).toBeGreaterThan(ceilingUsable);
    // What the +$26/mo step to 12 GiB / 20 GB would buy: 16 + 1, or 12 + 2.
    expect(requiredDiskMb(NOMINAL, 16, 1, ceilingUsable)).toBeLessThanOrEqual(ceilingUsable);
    expect(requiredDiskMb(NOMINAL, 12, 2, ceilingUsable)).toBeLessThanOrEqual(ceilingUsable);
  });

  it("memory is the minimum the disk requires, not a memory decision (2 GB disk per GiB)", () => {
    const minimumMemoryForDisk = Math.ceil(it_.disk_mb / MAX_DISK_MB_PER_MEMORY_GIB) * 1024;
    expect(it_.memory_mib).toBe(minimumMemoryForDisk);
  });
});
