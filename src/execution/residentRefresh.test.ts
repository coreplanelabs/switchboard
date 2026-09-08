import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_REARM_MAX_CONSECUTIVE,
  INTERRUPTED_REARM_S,
  RESTORE_MAX_MS,
  RESTORE_POLL_MS,
  RESTORE_STALL_MS,
  SDK_BACKUP_ARCHIVE_DIR,
  RUNTIME_REPLACEMENT_WORDING,
  checkoutUpdateCommand,
  classifyRefreshFailure,
  killStaleBuildProcessesCommand,
  nextRefreshDelayS,
  judgeRestoreProgress,
  planRefresh,
  restoreArchivePath,
  withTimeout,
  type RefreshDisk,
} from "./residentRefresh.js";
import { DISK_FULL_FREE_KIB } from "./residentDisk.js";

const require = createRequire(import.meta.url);

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const OLD = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";

const disk = (over: Partial<RefreshDisk> = {}): RefreshDisk => ({
  head: OLD,
  installedKey: KEY_A,
  installingKey: null,
  builtSha: OLD,
  ...over,
});

describe("planRefresh: a timed-out install resumes instead of starting over", () => {
  // Live 2026-09-07 19:06–19:52 UTC: switchboard's cold `npm install` outran
  // the 5-min step budget four cycles in a row; each cycle found no deps
  // marker, wiped node_modules and began again from zero — never converging.
  it("no deps marker but an installing marker for THIS lockfile → rebuild WITH install on a keep-deps clean (npm reconciles the partial tree)", () => {
    const plan = planRefresh({
      sha: NEW,
      factsSha: OLD,
      lockfileKey: KEY_B,
      disk: disk({ head: NEW, installedKey: null, installingKey: KEY_B, builtSha: null }),
    });
    expect(plan).toMatchObject({ action: "rebuild", install: true, clean: "keep-deps" });
    expect((plan as { why: string }).why).toMatch(/resumes/);
  });

  it("an installing marker for ANOTHER lockfile is stale evidence → the conservative full clean + install", () => {
    const plan = planRefresh({
      sha: NEW,
      factsSha: OLD,
      lockfileKey: KEY_B,
      disk: disk({ head: NEW, installedKey: null, installingKey: KEY_A, builtSha: null }),
    });
    expect(plan).toMatchObject({ action: "rebuild", install: true, clean: "all" });
  });

  it("a completed deps key always wins over a leftover installing marker (the rm after the key landed did not happen)", () => {
    const plan = planRefresh({
      sha: NEW,
      factsSha: OLD,
      lockfileKey: KEY_A,
      disk: disk({ head: OLD, installedKey: KEY_A, installingKey: KEY_A, builtSha: OLD }),
    });
    expect(plan).toMatchObject({ action: "rebuild", install: false, clean: "keep-deps" });
  });
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

describe("killStaleBuildProcessesCommand (a build-user step never starts beside a process the last one left behind IN ITS TREE)", () => {
  const argv = killStaleBuildProcessesCommand("worker1", "/workspace/checkout");
  const script = argv[2];

  it("runs as a root shell (never `su`): the sweep must outrank the processes it kills", () => {
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(script).not.toContain("su ");
  });

  it("scopes by cwd: only the user's processes whose cwd is the tree or below it — a parallel install into another store entry is live work, not a leftover", () => {
    expect(script).toContain("pgrep -u worker1");
    expect(script).toContain("readlink /proc/$p/cwd");
    expect(script).toContain("/workspace/checkout|/workspace/checkout/*)");
    expect(script).not.toMatch(/pkill/);
  });

  it("names every survivor before killing it, so the Worker log shows WHAT was still running", () => {
    expect(script.indexOf("ps -o pid=,args=")).toBeLessThan(script.indexOf("kill -KILL"));
    expect(script).toContain("killing stale worker1 processes under /workspace/checkout:");
  });

  it("SIGKILL, not SIGTERM: an npm mid-extract must stop writing NOW, not at its leisure", () => {
    expect(script).toContain("kill -KILL $stale");
    expect(script).not.toMatch(/kill -TERM|kill -15/);
  });

  it("waits (bounded) until EVERY matched pid is gone — one survivor among several must keep the loop waiting", () => {
    expect(script).toContain('for p in $stale; do kill -0 $p 2>/dev/null && alive="$alive$p "; done');
    expect(script).toContain('[ -z "$alive" ] && break');
    expect(script).toMatch(/exit 1/);
  });

  it("nothing matching → exits 0 silently (pgrep's 'no match' exit 1 is not a failure)", () => {
    // A user that owns no process here: the sweep must be a no-op, not an error.
    const r = spawnSync(argv[0], [argv[1], killStaleBuildProcessesCommand("nobody", "/nonexistent")[2]], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
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

describe("RUNTIME_REPLACEMENT_WORDING (#566: a deploy that ROLLS the container, not just swaps the isolate)", () => {
  // The exact string the resident logged when a review run aborted at 23:08 UTC
  // 2026-09-07 — `sandbox.exec error … The container is not running, consider
  // calling start()` — twice, as the deploy rolled the container onto an empty
  // ephemeral disk. It is a raw workerd binding refusal (no typed SDK class),
  // so the shared message wording is the ONLY signal isRuntimeReplacement has.
  const CONTAINER_ROLLED = "The container is not running, consider calling start()";

  it("classifies the stopped-container spawn refusal as a runtime replacement", () => {
    expect(RUNTIME_REPLACEMENT_WORDING.test(CONTAINER_ROLLED)).toBe(true);
  });

  it("matches on the cause chain too (the resident walks selfAndCauses), and is case-insensitive", () => {
    expect(RUNTIME_REPLACEMENT_WORDING.test("the container is not running, consider calling start()")).toBe(true);
    // wrapped one link down, the shape the SDK produces when it re-throws the
    // binding refusal untyped from its own auto-start path
    expect(RUNTIME_REPLACEMENT_WORDING.test(`sandbox.exec failed: ${CONTAINER_ROLLED}`)).toBe(true);
  });

  it("a container roll under a refresh step is refresh-interrupted, not <step>-failed (re-arm SHORT, keep the snapshot)", () => {
    const f = classifyRefreshFailure({ step: "snapshot", message: CONTAINER_ROLLED });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toBe(`refresh-interrupted: snapshot ${CONTAINER_ROLLED}`);
  });

  it("does NOT broaden to genuinely-fatal container failures — a crash or the readiness probe stay ordinary failures", () => {
    // A container that exited non-zero has genuinely crashed; the readiness
    // probe not listening yet is a different condition. Neither is a deploy
    // replacement, so neither may be classified as runtime-replaced (that would
    // paper a real failure as recoverable). Anchoring on "consider calling
    // start" keeps them out.
    expect(RUNTIME_REPLACEMENT_WORDING.test("container exited with unexpected exit code: 1")).toBe(false);
    expect(RUNTIME_REPLACEMENT_WORDING.test("the container is not listening")).toBe(false);
    expect(
      classifyRefreshFailure({ step: "build", message: "container exited with unexpected exit code: 1" }).interrupted,
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

describe("judgeRestoreProgress (#572: an R2 restore is judged by the bytes still arriving, not by a clock)", () => {
  // Live 2026-09-07 23:35–23:47 UTC, switchboard resident: the checkout restore
  // (~2 GiB) completed in 481 s; the fixed 300 s budget had already declared it
  // failed, a second hydrate ran `rm -rf` over the still-writing first one, and
  // the resident went down(r2-restore-failed) on a disk with 11.5 GiB free.
  const t0 = 1_000_000;
  const s = (offsetS: number, kiB: number | null) => ({ atMs: t0 + offsetS * 1000, kiB });

  it("bytes still growing → wait, however long it has been running (well past the old 300 s budget)", () => {
    const samples = [s(15, 10_000), s(30, 250_000), s(300, 1_500_000), s(480, 2_000_000)];
    expect(judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 481_000, samples })).toEqual({ verdict: "wait" });
  });

  it("no growth for RESTORE_STALL_MS → stalled, naming the bytes so far and the idle span", () => {
    const samples = [s(15, 10_000), s(30, 250_000), s(45, 250_000), s(160, 250_000)];
    const j = judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 160_000, samples });
    expect(j.verdict).toBe("stalled");
    expect(j.verdict === "stalled" && j.detail).toMatch(/no bytes written for 130 s .*0\.24 GiB after 160 s/);
  });

  it("no byte at all within RESTORE_STALL_MS of the start → stalled (the clock runs from the start until the first byte)", () => {
    const samples = [s(15, 0), s(60, 0), s(125, 0)];
    expect(judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 125_000, samples }).verdict).toBe("stalled");
    // …but a slow start that is still inside the stall window waits.
    expect(judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 90_000, samples: [s(15, 0), s(60, 0)] }).verdict).toBe(
      "wait",
    );
  });

  it("a sample du could not take (null) neither counts as growth nor resets the stall clock", () => {
    const samples = [s(15, 10_000), s(30, 250_000), s(60, null), s(100, null), s(160, null)];
    expect(judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 160_000, samples }).verdict).toBe("stalled");
    expect(judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 100_000, samples: samples.slice(0, 4) }).verdict).toBe(
      "wait",
    );
  });

  it("past RESTORE_MAX_MS → capped even while bytes still arrive; the cap sits under the watchdog's stale-mid-flight window", () => {
    const samples = Array.from({ length: 100 }, (_, i) => s(15 * (i + 1), 10_000 * (i + 1)));
    const j = judgeRestoreProgress({ startedMs: t0, nowMs: t0 + RESTORE_MAX_MS + 1000, samples });
    expect(j.verdict).toBe("capped");
    // The cap is the HYDRATE's, not this restore's: a restore that started late
    // in the hydrate inherits the shared deadline and is capped by it even
    // though its own elapsed time is short (a wait + two restores never add up
    // past the window).
    const late = judgeRestoreProgress({
      startedMs: t0,
      nowMs: t0 + 60_000,
      samples: [s(15, 10_000), s(30, 20_000), s(45, 30_000)],
      deadlineMs: t0 + 50_000,
    });
    expect(late.verdict).toBe("capped");
    expect(RESTORE_MAX_MS).toBeLessThan(30 * 60_000);
    expect(RESTORE_STALL_MS).toBeGreaterThanOrEqual(60_000);
    expect(RESTORE_POLL_MS).toBeLessThan(RESTORE_STALL_MS);
  });

  it("no samples yet → wait (the first poll has not happened)", () => {
    expect(judgeRestoreProgress({ startedMs: t0, nowMs: t0 + 5_000, samples: [] })).toEqual({ verdict: "wait" });
  });
});

describe("restoreArchivePath (#572 follow-up: a restore's bytes land in the SDK's staging archive first, not the target)", () => {
  // Live 2026-09-08 00:51–00:53 UTC, the first hydrate on #576's build: eight
  // `du` samples of /workspace/checkout read 0 while the 2 GiB archive was still
  // downloading to /var/backups/<id>.sqsh; the judge called it stalled at 123 s.
  it("names the SDK's staging archive for a backup id", () => {
    expect(restoreArchivePath("21fe85c3-826f-47f1-932a-a4a9b8bb2e04")).toBe(
      "/var/backups/21fe85c3-826f-47f1-932a-a4a9b8bb2e04.sqsh",
    );
  });

  it("the staging dir is the INSTALLED SDK's BACKUP_CONTAINER_DIR — an SDK bump that moves it fails here, not in production", () => {
    // The package's exports map hides package.json; its main entry lives in dist/.
    const dist = path.dirname(require.resolve("@cloudflare/sandbox"));
    const source = readdirSync(dist)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(path.join(dist, f), "utf8"))
      .join("\n");
    const m = /const BACKUP_CONTAINER_DIR = "([^"]+)"/.exec(source);
    expect(m?.[1]).toBe(SDK_BACKUP_ARCHIVE_DIR);
    expect(source).toContain('const BACKUP_ARCHIVE_OBJECT_NAME = "data.sqsh"');
    expect(source).toMatch(/const archivePath = `\$\{BACKUP_CONTAINER_DIR\}\/\$\{id\}\.sqsh`/);
  });
});
