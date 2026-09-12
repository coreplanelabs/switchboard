import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHECKOUT_SNAPSHOT_EXCLUDES,
  DEPS_BACKUP_KEY_PREFIX,
  DEPS_BACKUP_TTL_S,
  DEPS_STORE_DIR,
  depsBackupStorageKey,
  depsBackupsToDrop,
  depsAttemptOfScratchPath,
  depsAttemptPaths,
  depsEntryPath,
  depsCompletePath,
  depsScratchPath,
  depsStagingPath,
  depsInstallSemaphoreSize,
  depsScratchCloneArgv,
  depsStoreCommitScript,
  depsHardenScript,
  depsStoreListScript,
  NO_LOCKFILE_KEY,
  orderDepsEviction,
  parseDepsStoreListing,
  planDepsEviction,
  planDepsMaterialization,
  DEPS_STORE_MAX_UNREFERENCED,
} from "./residentDepsStore.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

describe("deps store layout (one content-addressed entry per lockfile key)", () => {
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

  it("a recorded entry backup is restored before anything is installed; a hit or a running install still wins", () => {
    expect(planDepsMaterialization({ complete: false, inFlight: false, backup: true })).toEqual({ action: "restore" });
    expect(planDepsMaterialization({ complete: true, inFlight: false, backup: true })).toEqual({ action: "hit" });
    expect(planDepsMaterialization({ complete: false, inFlight: true, backup: true })).toEqual({ action: "join" });
    expect(planDepsMaterialization({ complete: false, inFlight: false, backup: false })).toEqual({ action: "install" });
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
  it("a dead attempt's paths are its scratch tree AND its staging dir, recovered from the scratch path its lease names; any other path names no attempt", () => {
    const scratch = depsScratchPath("a1b2c3d4");
    expect(depsAttemptOfScratchPath(scratch)).toBe("a1b2c3d4");
    expect(depsAttemptPaths(KEY_A, "a1b2c3d4")).toEqual([scratch, depsStagingPath(KEY_A, "a1b2c3d4")]);
    expect(depsAttemptOfScratchPath(depsStagingPath(KEY_A, "a1b2c3d4"))).toBeUndefined();
    expect(depsAttemptOfScratchPath(depsEntryPath(KEY_A))).toBeUndefined();
    expect(depsAttemptOfScratchPath(`${scratch}/node_modules`)).toBeUndefined();
    expect(depsAttemptOfScratchPath("/workspace/deps/.scratch-")).toBeUndefined();
  });

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

describe("deps-harden: the install's node_modules is made owner-read-only, and a tree with no lockfile may hold none", () => {
  it("NO_LOCKFILE_KEY is the key of an empty lockfile listing (sha256 of no input)", () => {
    expect(NO_LOCKFILE_KEY).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("script: strips owner write from every file; a missing node_modules is created (owned by the build user) when emptyOk, refused otherwise", () => {
    const strict = depsHardenScript({
      scratchDir: "/workspace/deps/.scratch-1",
      owner: "worker1:worker1",
      emptyOk: false,
    });
    expect(strict).toContain("find '/workspace/deps/.scratch-1/node_modules' -type f -perm -u+w -exec chmod u-w {} +");
    expect(strict).toContain("install produced no node_modules");
    expect(strict).not.toContain("mkdir");
    const lenient = depsHardenScript({
      scratchDir: "/workspace/deps/.scratch-1",
      owner: "worker1:worker1",
      emptyOk: true,
    });
    expect(lenient).toContain("mkdir '/workspace/deps/.scratch-1/node_modules'");
    expect(lenient).toContain("chown worker1:worker1 '/workspace/deps/.scratch-1/node_modules'");
    expect(lenient).not.toContain("install produced no node_modules");
  });

  it("on a real filesystem: files lose u+w; no node_modules + emptyOk → an empty one exists and the commit succeeds; no node_modules + strict → exit 1 naming the scratch", (ctx) => {
    // `chmod u-w` withholds nothing from uid 0 — `test -w` answers yes for
    // root whatever the mode bits say — so a root test process (a sandbox
    // container's, say) cannot observe the hardening this case asserts.
    // Skipped there, saying why; the assertion itself stays exact rather than
    // checking mode bits root would pass anyway. The reason goes to stderr as
    // well as into the skip note: the default reporter prints a skip without
    // its note and drops a skipped test's console output.
    const asRoot = process.getuid?.() === 0;
    const reason =
      "running as root (uid 0): chmod u-w withholds nothing from root, so `test -w` cannot observe the hardening — run as an unprivileged user";
    if (asRoot) process.stderr.write(`deps-harden: the real-filesystem case is skipped — ${reason}\n`);
    ctx.skip(asRoot, reason);
    const root = mkdtempSync(join(tmpdir(), "deps-harden-"));
    const me = `${spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim()}:${spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim()}`;
    try {
      const full = join(root, ".scratch-full");
      mkdirSync(join(full, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(full, "node_modules", "pkg", "index.js"), "1", { mode: 0o644 });
      const r1 = spawnSync("sh", ["-c", depsHardenScript({ scratchDir: full, owner: me, emptyOk: false })], {
        encoding: "utf8",
      });
      expect(r1.status, r1.stderr).toBe(0);
      expect(spawnSync("test", ["-w", join(full, "node_modules", "pkg", "index.js")]).status).not.toBe(0);

      const bare = join(root, ".scratch-bare");
      mkdirSync(bare, { recursive: true });
      const r2 = spawnSync("sh", ["-c", depsHardenScript({ scratchDir: bare, owner: me, emptyOk: true })], {
        encoding: "utf8",
      });
      expect(r2.status, r2.stderr).toBe(0);
      expect(spawnSync("test", ["-d", join(bare, "node_modules")]).status).toBe(0);
      const entry = join(root, KEY_A);
      const r3 = spawnSync(
        "sh",
        [
          "-c",
          depsStoreCommitScript({
            scratchDir: bare,
            stagingDir: join(root, `.staging-${KEY_A}-1`),
            entryDir: entry,
            completePath: join(entry, ".complete"),
          }),
        ],
        { encoding: "utf8" },
      );
      expect(r3.status, r3.stderr).toBe(0);
      expect(spawnSync("test", ["-f", join(entry, ".complete")]).status).toBe(0);
      expect(spawnSync("test", ["-d", join(entry, "node_modules")]).status).toBe(0);

      const strictBare = join(root, ".scratch-strict");
      mkdirSync(strictBare, { recursive: true });
      const r4 = spawnSync("sh", ["-c", depsHardenScript({ scratchDir: strictBare, owner: me, emptyOk: false })], {
        encoding: "utf8",
      });
      expect(r4.status).toBe(1);
      expect(r4.stderr).toContain(`install produced no node_modules in ${strictBare}`);
      expect(spawnSync("test", ["-e", join(strictBare, "node_modules")]).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("entry backups: content-addressed snapshots of the store (item 61)", () => {
  it("the checkout snapshot excludes the top-level node_modules — the store entry carries it", () => {
    expect(CHECKOUT_SNAPSHOT_EXCLUDES).toEqual(["node_modules"]);
  });

  it("a backup record is keyed under its own storage prefix by lockfile key; a non-key is refused", () => {
    expect(DEPS_BACKUP_KEY_PREFIX).toBe("resident:depsBackup:");
    expect(depsBackupStorageKey(KEY_A)).toBe(`resident:depsBackup:${KEY_A}`);
    expect(() => depsBackupStorageKey("../snapshot")).toThrow(/not a lockfile key/);
  });

  it("entry backups outlive snapshots by design: at least 180 days, so a warm key's backup is there for the wake", () => {
    expect(DEPS_BACKUP_TTL_S).toBeGreaterThanOrEqual(180 * 24 * 60 * 60);
  });

  it("the backups to drop after a sweep are exactly the evicted keys that have one — never a key still in the store", () => {
    expect(depsBackupsToDrop({ evictedKeys: [KEY_A, KEY_B], backedUpKeys: [KEY_B, KEY_C] })).toEqual([KEY_B]);
    expect(depsBackupsToDrop({ evictedKeys: [], backedUpKeys: [KEY_A] })).toEqual([]);
    expect(depsBackupsToDrop({ evictedKeys: [KEY_A], backedUpKeys: [] })).toEqual([]);
  });
});
