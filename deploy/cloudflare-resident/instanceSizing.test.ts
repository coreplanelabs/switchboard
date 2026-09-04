import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The resident container's instance type is sized by arithmetic over MEASURED
// parts, and this test is where the arithmetic lives — wrangler.jsonc carries
// the number, this file carries the proof, and a change to either without the
// other fails here. Background (features/resident-repos.md, #448): on
// 2026-09-04 the nominal resident filled its 8 GB disk 45 minutes after a
// fresh provision with ONE thread attached, and nothing had measured the disk
// before ENOSPC. 8 GB was the platform default, never a budget.

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
  const cfg = readJsonc(fileURLToPath(new URL("./wrangler.jsonc", import.meta.url))) as { containers?: Array<{ instance_type?: unknown }> };
  const it = cfg.containers?.[0]?.instance_type;
  if (!it || typeof it !== "object") throw new Error("wrangler.jsonc: containers[0].instance_type must be a custom {vcpu, memory_mib, disk_mb} object");
  return it as InstanceType;
}

// Cloudflare's custom instance-type constraints (Containers docs, mirrored in
// the wrangler.jsonc comment): whole vCPUs 1–4, at least 3 GiB of memory per
// vCPU, at most 2 GB of disk per GiB of memory.
const MIN_MEMORY_MIB_PER_VCPU = 3 * 1024;
const MAX_DISK_MB_PER_MEMORY_GIB = 2000;

// MEASURED on 2026-09-04 against coreplanelabs/nominal at that day's `main`
// (fresh clone, `pnpm@10.10.0 install --frozen-lockfile`, `du -sh`), the
// largest onboarded repo — the one the shared type has to fit.
const NOMINAL = {
  historyMb: 357, // `.git` of a full clone = the mirror = each thread clone's history
  treeMb: 75, // the working tree
  nodeModulesMb: 2100, // pnpm node_modules; hardlinked into a thread tree UNLESS its lockfile differs
};
// Measured on the switchboard resident the same day: 863 MB used on a 7.3 GiB
// root filesystem with a ~0.4 GB workspace → the OS image (Ubuntu, node, git,
// pnpm) shares the disk and costs roughly this much.
const IMAGE_MB = 500;
// The refresh cycle snapshots mirror + checkout to R2 through the Sandbox SDK
// (`createBackup`); whether it stages a tarball on local disk is SDK-internal,
// so budget for one compressed copy of what it archives, worst case.
const SNAPSHOT_STAGING_RATIO = 0.6;

/** What a resident holding `repo` needs on disk with `threads` active thread
 *  trees, `threadsInstallingDeps` of which carry their own node_modules (a
 *  lockfile that differs from the warm checkout's → a scoped install under
 *  that thread user's own pnpm store, NOT hardlinks). */
function requiredDiskMb(repo: typeof NOMINAL, threads: number, threadsInstallingDeps: number): number {
  const mirror = repo.historyMb;
  const checkout = repo.historyMb + repo.treeMb + repo.nodeModulesMb;
  const threadTree = repo.historyMb + repo.treeMb; // deps hardlinked from the checkout
  const ownDeps = repo.nodeModulesMb;
  const staging = Math.round((mirror + checkout) * SNAPSHOT_STAGING_RATIO);
  return IMAGE_MB + mirror + checkout + threads * threadTree + threadsInstallingDeps * ownDeps + staging;
}

describe("resident instance type (deploy/cloudflare-resident/wrangler.jsonc)", () => {
  const it_ = configuredInstanceType();

  it("satisfies Cloudflare's custom-type constraints (the deploy would refuse otherwise, but say why here)", () => {
    expect(Number.isInteger(it_.vcpu) && it_.vcpu >= 1 && it_.vcpu <= 4).toBe(true);
    expect(it_.memory_mib).toBeGreaterThanOrEqual(MIN_MEMORY_MIB_PER_VCPU * it_.vcpu);
    expect(it_.disk_mb).toBeLessThanOrEqual((it_.memory_mib / 1024) * MAX_DISK_MB_PER_MEMORY_GIB);
  });

  // The two shapes below are asserted RELATIONALLY (against the old and the
  // configured disk), not as fixed sums: the model's inputs are the single
  // source, so re-measuring a part is a one-line edit here and nowhere else.
  // For the record, at the 2026-09-04 inputs: incident 7654 MB, target 12718 MB.

  it("the previous 8 GB did not fit the incident's shape — one thread with its own deps install plus a snapshot in flight", () => {
    // image + mirror + checkout + one thread tree + its own deps + staging,
    // against 8000 MB provisioned (7.3 GiB usable): no headroom, and any
    // second thread or leftover from a failed provision tips it over — which
    // is what happened.
    const previousDiskMb = 8000;
    expect(requiredDiskMb(NOMINAL, 1, 1)).toBeGreaterThan(previousDiskMb * 0.9);
  });

  it("the configured disk fits three deps-installing threads with headroom (the sizing target)", () => {
    const target = requiredDiskMb(NOMINAL, 3, 3);
    expect(it_.disk_mb).toBeGreaterThanOrEqual(target);
    expect(it_.disk_mb).toBeLessThan(target * 1.5); // not over-provisioned either: memory (and so cost) follows disk
  });

  it("memory is the minimum the disk requires, not a memory decision (2 GB disk per GiB)", () => {
    const minimumMemoryForDisk = Math.ceil(it_.disk_mb / MAX_DISK_MB_PER_MEMORY_GIB) * 1024;
    expect(it_.memory_mib).toBe(minimumMemoryForDisk);
  });
});
