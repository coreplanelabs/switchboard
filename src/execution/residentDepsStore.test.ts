import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPS_STORE_DIR,
  depsEntryPath,
  depsCompletePath,
  depsInstallSemaphoreSize,
  depsScratchCloneArgv,
  depsStoreCommitScript,
  depsStoreListScript,
  orderDepsEviction,
  parseDepsStoreListing,
  planDepsEviction,
  planDepsMaterialization,
  DEPS_STORE_MAX_UNREFERENCED,
} from "./residentDepsStore.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

describe("deps store layout (#555: one content-addressed entry per lockfile key)", () => {
  it("entries live under the store dir by key; the marker is INSIDE the entry so a rename carries it", () => {
    expect(DEPS_STORE_DIR).toBe("/workspace/deps");
    expect(depsEntryPath(KEY_A)).toBe(`/workspace/deps/${KEY_A}`);
    expect(depsCompletePath(KEY_A)).toBe(`/workspace/deps/${KEY_A}/.complete`);
  });

  it("refuses a key that is not a lockfile hash — the key is a path segment and must never be attacker-shaped", () => {
    expect(() => depsEntryPath("../etc")).toThrow(/lockfile key/);
    expect(() => depsEntryPath("")).toThrow(/lockfile key/);
    expect(() => depsEntryPath("A".repeat(64))).toThrow(/lockfile key/);
  });
});

describe("planDepsMaterialization (hit / join / install)", () => {
  it("complete entry on disk → hit, no install, no wait", () => {
    expect(planDepsMaterialization({ complete: true, inFlight: false })).toEqual({ action: "hit" });
  });

  it("an install for the same key already running in this incarnation → join its promise, never a second install", () => {
    expect(planDepsMaterialization({ complete: false, inFlight: true })).toEqual({ action: "join" });
  });

  it("nothing on disk, nothing running → install", () => {
    expect(planDepsMaterialization({ complete: false, inFlight: false })).toEqual({ action: "install" });
  });

  it("a complete entry wins over a stale in-flight memo (a DO reset can leave one)", () => {
    expect(planDepsMaterialization({ complete: true, inFlight: true })).toEqual({ action: "hit" });
  });
});

describe("depsInstallSemaphoreSize (parallel installs up to the core count, never a constant)", () => {
  it("is the core count", () => {
    expect(depsInstallSemaphoreSize("4\n")).toBe(4);
    expect(depsInstallSemaphoreSize("1")).toBe(1);
  });

  it("unknown or nonsense → 1 (serial is the safe floor)", () => {
    expect(depsInstallSemaphoreSize("")).toBe(1);
    expect(depsInstallSemaphoreSize("nproc: not found")).toBe(1);
    expect(depsInstallSemaphoreSize("0")).toBe(1);
    expect(depsInstallSemaphoreSize(null)).toBe(1);
  });
});

describe("the install scratch tree and the store commit", () => {
  it("scratch clone: shares the mirror's objects (no second copy of history) and checks out the key's sha detached", () => {
    const argv = depsScratchCloneArgv({
      mirrorDir: "/workspace/mirror",
      scratchDir: "/workspace/deps/.scratch-x",
      sha: "1".repeat(40),
    });
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv[2]).toContain(
      "git clone --shared --no-checkout --quiet '/workspace/mirror' '/workspace/deps/.scratch-x'",
    );
    expect(argv[2]).toContain(`git -C '/workspace/deps/.scratch-x' checkout --detach --quiet ${"1".repeat(40)}`);
  });

  it("commit: the installed node_modules MOVES (same filesystem) into staging, staging is renamed to the entry, the marker is written LAST", () => {
    const script = depsStoreCommitScript({
      scratchDir: "/workspace/deps/.scratch-x",
      stagingDir: `/workspace/deps/.staging-${KEY_A}-x`,
      entryDir: depsEntryPath(KEY_A),
      completePath: depsCompletePath(KEY_A),
    });
    const mv = script.indexOf("mv '/workspace/deps/.scratch-x/node_modules'");
    const rename = script.indexOf(`mv '/workspace/deps/.staging-${KEY_A}-x' '/workspace/deps/${KEY_A}'`);
    const mark = script.indexOf(`touch '/workspace/deps/${KEY_A}/.complete'`);
    expect(mv).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(mv);
    expect(mark).toBeGreaterThan(rename);
    // A missing node_modules (install produced nothing) is a failure, not an empty entry.
    expect(script).toContain("test -d '/workspace/deps/.scratch-x/node_modules'");
  });

  it("adoption keeps the scratch tree (it IS the warm checkout) — only its node_modules moves", () => {
    const script = depsStoreCommitScript({
      scratchDir: "/workspace/checkout",
      stagingDir: `/workspace/deps/.staging-${KEY_A}-x`,
      entryDir: depsEntryPath(KEY_A),
      completePath: depsCompletePath(KEY_A),
      keepScratch: true,
    });
    expect(script).toContain("mv '/workspace/checkout/node_modules'");
    expect(script).not.toContain("rm -rf '/workspace/checkout'");
  });

  it("commit script behaves on a real filesystem: entry appears complete, scratch is gone, a losing racer leaves the winner alone", () => {
    const root = mkdtempSync(join(tmpdir(), "deps-store-"));
    try {
      const scratch = join(root, ".scratch-1");
      const staging = join(root, `.staging-${KEY_A}-1`);
      const entry = join(root, KEY_A);
      mkdirSync(join(scratch, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(scratch, "node_modules", "pkg", "index.js"), "1");
      const script = depsStoreCommitScript({
        scratchDir: scratch,
        stagingDir: staging,
        entryDir: entry,
        completePath: join(entry, ".complete"),
      });
      const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(spawnSync("test", ["-f", join(entry, ".complete")]).status).toBe(0);
      expect(spawnSync("test", ["-f", join(entry, "node_modules", "pkg", "index.js")]).status).toBe(0);
      expect(spawnSync("test", ["-e", scratch]).status).not.toBe(0);
      // Second racer for the same key: its staging must NOT clobber the complete entry.
      const scratch2 = join(root, ".scratch-2");
      mkdirSync(join(scratch2, "node_modules", "other"), { recursive: true });
      const r2 = spawnSync(
        "sh",
        [
          "-c",
          depsStoreCommitScript({
            scratchDir: scratch2,
            stagingDir: join(root, `.staging-${KEY_A}-2`),
            entryDir: entry,
            completePath: join(entry, ".complete"),
          }),
        ],
        { encoding: "utf8" },
      );
      expect(r2.status).toBe(0);
      expect(spawnSync("test", ["-e", join(entry, "node_modules", "other")]).status).not.toBe(0);
      expect(spawnSync("test", ["-e", join(root, `.staging-${KEY_A}-2`)]).status).not.toBe(0);
      // Crash debris: an entry dir WITHOUT its marker (the shell died between the
      // rename and the touch). A re-install must replace it, never nest inside it.
      const entryB = join(root, KEY_B);
      mkdirSync(join(entryB, "node_modules", "stale"), { recursive: true });
      const scratch3 = join(root, ".scratch-3");
      mkdirSync(join(scratch3, "node_modules", "fresh"), { recursive: true });
      const r3 = spawnSync(
        "sh",
        [
          "-c",
          depsStoreCommitScript({
            scratchDir: scratch3,
            stagingDir: join(root, `.staging-${KEY_B}-3`),
            entryDir: entryB,
            completePath: join(entryB, ".complete"),
          }),
        ],
        { encoding: "utf8" },
      );
      expect(r3.status, r3.stderr).toBe(0);
      expect(spawnSync("test", ["-f", join(entryB, ".complete")]).status).toBe(0);
      expect(spawnSync("test", ["-d", join(entryB, "node_modules", "fresh")]).status).toBe(0);
      expect(spawnSync("test", ["-e", join(entryB, "node_modules", "stale")]).status).not.toBe(0);
      expect(spawnSync("test", ["-e", join(entryB, `.staging-${KEY_B}-3`)]).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("store listing and eviction (LRU among unreferenced entries, never a protected key)", () => {
  it("listing script emits one tagged line per entry with the complete flag, size and last-used time; leftovers are named too", () => {
    const script = depsStoreListScript("/workspace/deps");
    expect(script).toContain("/workspace/deps");
    const parsed = parseDepsStoreListing(
      [
        `entry=${KEY_A} complete=1 kib=2100000 used=1788800000`,
        `entry=${KEY_B} complete=1 kib=1900000 used=1788700000`,
        `entry=${KEY_C} complete=0 kib=40 used=0`,
        `leftover=/workspace/deps/.staging-${KEY_C}-abc`,
        "garbage line",
      ].join("\n"),
    );
    expect(parsed.entries).toEqual([
      { key: KEY_A, complete: true, kib: 2_100_000, usedAtS: 1_788_800_000 },
      { key: KEY_B, complete: true, kib: 1_900_000, usedAtS: 1_788_700_000 },
      { key: KEY_C, complete: false, kib: 40, usedAtS: 0 },
    ]);
    expect(parsed.leftovers).toEqual([`/workspace/deps/.staging-${KEY_C}-abc`]);
  });

  it("orders unreferenced complete entries coldest first; protected keys and in-flight keys are never candidates", () => {
    const order = orderDepsEviction({
      entries: [
        { key: KEY_A, complete: true, kib: 1, usedAtS: 300 },
        { key: KEY_B, complete: true, kib: 1, usedAtS: 100 },
        { key: KEY_C, complete: true, kib: 1, usedAtS: 200 },
      ],
      protectedKeys: new Set([KEY_A]),
    });
    expect(order.map((e) => e.key)).toEqual([KEY_B, KEY_C]);
  });

  it("an incomplete entry with no install in flight is debris and goes first, whatever its age", () => {
    const order = orderDepsEviction({
      entries: [
        { key: KEY_B, complete: true, kib: 1, usedAtS: 100 },
        { key: KEY_C, complete: false, kib: 1, usedAtS: 999 },
      ],
      protectedKeys: new Set(),
    });
    expect(order.map((e) => e.key)).toEqual([KEY_C, KEY_B]);
  });

  it("planDepsEviction keeps at most DEPS_STORE_MAX_UNREFERENCED complete unreferenced entries (the warmest), removes the rest and every leftover", () => {
    expect(DEPS_STORE_MAX_UNREFERENCED).toBe(1);
    const plan = planDepsEviction({
      entries: [
        { key: KEY_A, complete: true, kib: 1, usedAtS: 300 }, // protected
        { key: KEY_B, complete: true, kib: 1, usedAtS: 100 },
        { key: KEY_C, complete: true, kib: 1, usedAtS: 200 },
      ],
      leftovers: ["/workspace/deps/.staging-x"],
      protectedKeys: new Set([KEY_A]),
    });
    // C is warmer than B: C stays as the one unreferenced entry, B goes.
    expect(plan.remove).toEqual([depsEntryPath(KEY_B), "/workspace/deps/.staging-x"]);
    expect(plan.keep).toEqual([KEY_A, KEY_C]);
  });

  it("nothing to remove → empty plan (no fork)", () => {
    const plan = planDepsEviction({
      entries: [{ key: KEY_A, complete: true, kib: 1, usedAtS: 1 }],
      leftovers: [],
      protectedKeys: new Set([KEY_A]),
    });
    expect(plan.remove).toEqual([]);
  });
});
