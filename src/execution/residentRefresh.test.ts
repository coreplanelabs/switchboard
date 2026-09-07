import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_REARM_MAX_CONSECUTIVE,
  INTERRUPTED_REARM_S,
  checkoutUpdateCommand,
  classifyRefreshFailure,
  nextRefreshDelayS,
  planRefresh,
  withTimeout,
  type RefreshDisk,
} from "./residentRefresh.js";
import { DISK_FULL_FREE_KIB } from "./residentDisk.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

const disk = (over: Partial<RefreshDisk> = {}): RefreshDisk => ({
  head: OLD,
  installedKey: KEY_A,
  builtSha: OLD,
  ...over,
});

describe("planRefresh (#163: lockfile-hash install gate + on-disk checkpoints)", () => {
  it("default branch did not move → unchanged, whatever the disk says", () => {
    expect(planRefresh({ sha: OLD, factsSha: OLD, lockfileKey: KEY_A, disk: disk() })).toEqual({ action: "unchanged" });
    expect(
      planRefresh({
        sha: OLD,
        factsSha: OLD,
        lockfileKey: KEY_B,
        disk: disk({ head: null, installedKey: null, builtSha: null }),
      }),
    ).toEqual({ action: "unchanged" });
  });

  it("sha moved, committed lockfile unchanged → rebuild WITHOUT install, deps kept through the clean", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk() });
    expect(plan).toMatchObject({ action: "rebuild", install: false, clean: "keep-deps" });
    expect(plan.action === "rebuild" && plan.why).toMatch(/lockfile unchanged/);
  });

  it("sha moved, committed lockfile changed → full clean + install", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_B, disk: disk() });
    expect(plan).toMatchObject({ action: "rebuild", install: true, clean: "all" });
    expect(plan.action === "rebuild" && plan.why).toMatch(/lockfile changed/);
  });

  it("no deps marker on disk (pre-#163 container, or a full clean that was interrupted) → conservative full install", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ installedKey: null }) });
    expect(plan).toMatchObject({ action: "rebuild", install: true, clean: "all" });
    expect(plan.action === "rebuild" && plan.why).toMatch(/no deps marker/);
  });

  it("checkpoint hit: checkout HEAD, built marker and deps key all already match → reuse (snapshot only)", () => {
    const plan = planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: NEW }) });
    expect(plan).toMatchObject({ action: "reuse" });
    expect(plan.action === "reuse" && plan.why).toMatch(/already materialized/);
  });

  it("built marker matches but the checkout HEAD does not → never reuse; rebuild on the kept deps", () => {
    expect(
      planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: OLD, builtSha: NEW }) }),
    ).toMatchObject({
      action: "rebuild",
      install: false,
      clean: "keep-deps",
    });
    expect(
      planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: null, builtSha: NEW }) }),
    ).toMatchObject({
      action: "rebuild",
      install: false,
    });
  });

  it("checkout at the new sha but the build never finished → keep deps, rebuild only", () => {
    expect(
      planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: OLD }) }),
    ).toMatchObject({
      action: "rebuild",
      install: false,
      clean: "keep-deps",
    });
    expect(
      planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_A, disk: disk({ head: NEW, builtSha: null }) }),
    ).toMatchObject({
      action: "rebuild",
      install: false,
    });
  });

  it("checkout and build markers match the sha but the deps key does not → full install, never reuse", () => {
    expect(
      planRefresh({ sha: NEW, factsSha: OLD, lockfileKey: KEY_B, disk: disk({ head: NEW, builtSha: NEW }) }),
    ).toMatchObject({
      action: "rebuild",
      install: true,
      clean: "all",
    });
  });
});

describe("checkoutUpdateCommand", () => {
  it("keep-deps: cleans every gitignored/untracked path EXCEPT node_modules (fresh build inodes, deps preserved)", () => {
    const cmd = checkoutUpdateCommand(NEW, "keep-deps");
    expect(cmd).toContain(`git reset --hard --quiet ${NEW}`);
    expect(cmd).toContain("git clean -fdx -e node_modules");
  });

  it("keep-deps: sweeps the build-written caches inside node_modules at any depth (they open+truncate hardlinked inodes)", () => {
    const cmd = checkoutUpdateCommand(NEW, "keep-deps");
    expect(cmd).toContain(
      "find . -path '*/node_modules/*' -type d \\( -name .cache -o -name .vite \\) -prune -exec rm -rf {} +",
    );
    // The sweep runs after the clean, so it never races git over the same paths.
    expect(cmd.indexOf("git clean")).toBeLessThan(cmd.indexOf("find ."));
  });

  it("all: the unconditional -x clean (deps are about to be reinstalled), no cache sweep needed", () => {
    const cmd = checkoutUpdateCommand(NEW, "all");
    expect(cmd).toContain(`git reset --hard --quiet ${NEW}`);
    expect(cmd).toMatch(/git clean -fdx$/);
    expect(cmd).not.toContain("-e node_modules");
    expect(cmd).not.toContain("find .");
  });
});

describe("classifyRefreshFailure (#216: a build SIGTERM'd by a deploy is an interruption, not evidence)", () => {
  const live = "exit 143: Session terminated, killing shell... ...killed.";

  it("exit 143 during build → refresh-interrupted, reason prefixed for the streak gate", () => {
    const f = classifyRefreshFailure({ step: "build", message: live });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toMatch(/^refresh-interrupted: build exit 143/);
    expect(f.reason).not.toMatch(/build-failed/);
  });

  it("exit 143 during install and checkout-update are interruptions too", () => {
    expect(classifyRefreshFailure({ step: "install", message: live }).interrupted).toBe(true);
    expect(classifyRefreshFailure({ step: "checkout-update", message: "exit 143: " }).interrupted).toBe(true);
  });

  it("SIGTERM / 'Session terminated' wording without the exit code still counts", () => {
    expect(
      classifyRefreshFailure({ step: "build", message: "exit 1: Session terminated, killing shell" }).interrupted,
    ).toBe(true);
    expect(classifyRefreshFailure({ step: "build", message: "exit 1: npm ERR! signal SIGTERM" }).interrupted).toBe(
      true,
    );
  });

  it("an ordinary build failure stays <step>-failed with the message verbatim", () => {
    const f = classifyRefreshFailure({ step: "build", message: "exit 1: src/x.ts(3,1): error TS2304" });
    expect(f).toEqual({
      interrupted: false,
      diskFull: false,
      reason: "build-failed: exit 1: src/x.ts(3,1): error TS2304",
    });
  });

  it("our own timeout kill is NOT an interruption — the build really did not finish in budget", () => {
    const f = classifyRefreshFailure({ step: "build", message: "exit 143 (timed out): killed" });
    expect(f.interrupted).toBe(false);
    expect(f.reason).toMatch(/^build-failed: /);
  });

  it("snapshot step killed by a container replacement — 'Process supervisor is closed' → refresh-interrupted (#335)", () => {
    const f = classifyRefreshFailure({ step: "snapshot", message: "Process supervisor is closed" });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toBe("refresh-interrupted: snapshot Process supervisor is closed");
  });

  it("SDK stale-handle wording ('previous runtime incarnation') → refresh-interrupted, any step (#335)", () => {
    const f = classifyRefreshFailure({
      step: "fetch",
      message: "Process handle refers to a previous runtime incarnation",
    });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toMatch(/^refresh-interrupted: fetch /);
  });

  it("the SDK replacement wording is case-insensitive and covers the whole isRuntimeReplacement message family (#335)", () => {
    for (const msg of [
      "process supervisor is closed",
      "operation was interrupted because the runtime changed",
      "the runtime identity is no longer active",
      "sandbox lifetime is no longer current",
      "the platform was updating the sandbox runtime",
      "supervisor no longer identifies pid 42",
    ]) {
      expect(classifyRefreshFailure({ step: "snapshot", message: msg }).interrupted).toBe(true);
    }
  });

  it("our own timeout kill still wins over a replacement wording in the same message (#335)", () => {
    const f = classifyRefreshFailure({
      step: "snapshot",
      message: "exit 1 (timed out): Process supervisor is closed",
    });
    expect(f.interrupted).toBe(false);
    expect(f.reason).toMatch(/^snapshot-failed: /);
  });

  it("'killed' inside ordinary compiler output does not count without the signal signature", () => {
    expect(
      classifyRefreshFailure({ step: "build", message: "exit 1: error: process killed by OOM killer" }).interrupted,
    ).toBe(false);
  });
});

describe("classifyRefreshFailure (#457: a full container disk is `disk-full`, not GitHub's fault and not the repo's)", () => {
  // The refresh reason the nominal resident actually carried on 2026-09-04
  // while every attach failed at git-setup — recorded as github-unreachable.
  const credWrite =
    "Failed to write file '/workspace/.resident/git-credentials': ENOSPC: no space left on device, write '/workspace/.resident/git-credentials'";

  it("ENOSPC wording in the message decides on its own — no probe needed", () => {
    const f = classifyRefreshFailure({ step: "fetch", message: credWrite });
    expect(f.diskFull).toBe(true);
    expect(f.interrupted).toBe(false);
    expect(f.reason).toBe(`disk-full: fetch ${credWrite}`);
    expect(f.reason).not.toMatch(/github-unreachable|fetch-failed/);
  });

  it("an errno-less message (git config's exit 4) becomes disk-full when the probe says the disk is below the floor", () => {
    const msg = "exit 4: stderr: error: failed to write new configuration file /etc/gitconfig.lock";
    const f = classifyRefreshFailure({ step: "git-setup", message: msg, freeKiB: 0 });
    expect(f.diskFull).toBe(true);
    expect(f.reason).toBe(`disk-full: git-setup ${msg} (/workspace: 0 KiB free)`);
    expect(classifyRefreshFailure({ step: "git-setup", message: msg, freeKiB: DISK_FULL_FREE_KIB - 1 }).diskFull).toBe(
      true,
    );
  });

  it("the same message with room on the disk, or with no probe answer, stays the step's own failure", () => {
    const msg = "exit 4: stderr: error: failed to write new configuration file /etc/gitconfig.lock";
    expect(classifyRefreshFailure({ step: "git-setup", message: msg, freeKiB: DISK_FULL_FREE_KIB })).toEqual({
      interrupted: false,
      diskFull: false,
      reason: `git-setup-failed: ${msg}`,
    });
    expect(classifyRefreshFailure({ step: "git-setup", message: msg, freeKiB: null }).diskFull).toBe(false);
    expect(classifyRefreshFailure({ step: "git-setup", message: msg }).diskFull).toBe(false);
  });

  it("a step killed from outside is an interruption even on a low disk — the kill, not the disk, ended it", () => {
    const f = classifyRefreshFailure({
      step: "build",
      message: "exit 143: Session terminated, killing shell...",
      freeKiB: 0,
    });
    expect(f.interrupted).toBe(true);
    expect(f.diskFull).toBe(false);
    expect(f.reason).toMatch(/^refresh-interrupted: build /);
  });

  it("ENOSPC in the message wins over a kill signature in the same message (the disk is the actionable fact)", () => {
    const f = classifyRefreshFailure({
      step: "install",
      message: "exit 143: ENOSPC: no space left on device; Session terminated",
    });
    expect(f.diskFull).toBe(true);
    expect(f.interrupted).toBe(false);
  });
});

describe("nextRefreshDelayS (#216: re-arm short after an interruption or an image-stale restart)", () => {
  const cadence = { intervalS: 600, idleIntervalS: 21600 };

  it("normal outcome → the regular interval", () => {
    expect(nextRefreshDelayS({ outcome: "normal", ...cadence })).toBe(600);
  });

  it("disk-full restart → the same short re-arm as an image-stale restart (the container is coming back on an empty disk), uncapped", () => {
    expect(nextRefreshDelayS({ outcome: "disk-full-restart", ...cadence })).toBe(INTERRUPTED_REARM_S);
    expect(nextRefreshDelayS({ outcome: "disk-full-restart", consecutiveInterrupted: 50, ...cadence })).toBe(
      INTERRUPTED_REARM_S,
    );
  });

  it("interrupted → the short re-arm, well under the regular interval", () => {
    expect(nextRefreshDelayS({ outcome: "interrupted", ...cadence })).toBe(INTERRUPTED_REARM_S);
    expect(INTERRUPTED_REARM_S).toBeGreaterThanOrEqual(30);
    expect(INTERRUPTED_REARM_S).toBeLessThanOrEqual(60);
  });

  it("image-stale restart → the same short re-arm (the container is coming back on the new image)", () => {
    expect(nextRefreshDelayS({ outcome: "image-stale-restart", ...cadence })).toBe(INTERRUPTED_REARM_S);
  });

  it("idle → the idle interval", () => {
    expect(nextRefreshDelayS({ outcome: "idle", ...cadence })).toBe(21600);
  });

  it("a run of consecutive interruptions is capped: past the cap the regular interval returns (no 45 s hot loop on a chronic false positive)", () => {
    for (let n = 1; n <= INTERRUPTED_REARM_MAX_CONSECUTIVE; n++) {
      expect(nextRefreshDelayS({ outcome: "interrupted", consecutiveInterrupted: n, ...cadence })).toBe(
        INTERRUPTED_REARM_S,
      );
    }
    expect(
      nextRefreshDelayS({
        outcome: "interrupted",
        consecutiveInterrupted: INTERRUPTED_REARM_MAX_CONSECUTIVE + 1,
        ...cadence,
      }),
    ).toBe(600);
    expect(nextRefreshDelayS({ outcome: "interrupted", consecutiveInterrupted: 50, ...cadence })).toBe(600);
  });

  it("the cap applies to interruptions only — an image-stale restart is never repeated by the same cause", () => {
    expect(nextRefreshDelayS({ outcome: "image-stale-restart", consecutiveInterrupted: 50, ...cadence })).toBe(
      INTERRUPTED_REARM_S,
    );
  });

  it("omitting the count means 'first interruption' (short)", () => {
    expect(nextRefreshDelayS({ outcome: "interrupted", ...cadence })).toBe(INTERRUPTED_REARM_S);
  });
});

describe("withTimeout (#356 item 7a: R2 snapshot/restore calls get an explicit budget)", () => {
  it("passes a value through when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000, "mirror backup")).resolves.toBe(42);
  });
  it("passes the promise's own rejection through untouched", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000, "mirror backup")).rejects.toThrow("boom");
  });
  it("rejects with a NAMED error when the budget elapses — a hung upload fails the cycle visibly instead of stranding it for the 30-min watchdog", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 5, "checkout restore")).rejects.toThrow("checkout restore timed out after 5ms");
  });
  it("a loser that rejects after the timeout never surfaces as an unhandled rejection", async () => {
    let rejectLate!: (e: Error) => void;
    const late = new Promise<never>((_, rej) => (rejectLate = rej));
    await expect(withTimeout(late, 5, "mirror backup")).rejects.toThrow("timed out");
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      rejectLate(new Error("late failure"));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
