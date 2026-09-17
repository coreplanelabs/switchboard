import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESTORE_MAX_MS,
  RESTORE_POLL_MS,
  RESTORE_STALL_MS,
  planWakeDepsBudget,
  WAKE_DEPS_MIN_MS,
  SDK_BACKUP_ARCHIVE_DIR,
  RUNTIME_MOVED_WORDING,
  RUNTIME_REPLACEMENT_WORDING,
  STOPPED_CONTAINER_WORDING,
  checkoutUpdateCommand,
  classifyRefreshFailure,
  fetchFailureIsMirrors,
  restoreFailureDisposition,
  killStaleBuildProcessesCommand,
  judgeRestoreProgress,
  planRefresh,
  restoreArchivePath,
  withTimeout,
  isRuntimeUnreachableReason,
  isRuntimeUnreachableSignal,
  RUNTIME_UNREACHABLE_DOWN_AT,
  RUNTIME_UNREACHABLE_RECREATE_AT,
  RUNTIME_UNREACHABLE_STOP_AT,
  runtimeUnreachableReason,
  runtimeUnreachableRung,
  SDK_CONNECT_TIMEOUT_MS,
  SDK_PORT_READY_ENV,
  SDK_RUNTIME_RECORD_KEY,
  WAKE_PORT_READY_MS,
  type RefreshDisk,
} from "./residentRefresh.js";
import { DISK_FULL_FREE_KIB } from "./residentDisk.js";
import { degradedIsServiceable } from "./residentState.js";

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
  // A cold `npm install` that outruns the 5-min step budget cycle after cycle
  // used to start over each time: every cycle found no deps marker, wiped
  // node_modules and began again from zero — never converging.
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

describe("planRefresh (lockfile-hash install gate + on-disk checkpoints)", () => {
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

  it("no deps marker on disk (a container predating the markers, or a full clean that was interrupted) → conservative full install", () => {
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

// Item 67: the cycle's fetch step used to name every failure `github-unreachable`
// — GitHub's, a serviceable reason that parks on repeat. A fetch that fails on
// the MIRROR itself (its remote gone from `config`, its object store broken)
// is the resident's own failure: `fetch-failed`, a resident step the ladder
// counts. The first live row of item 67 found this: the injected broken
// mirror read `degraded(github-unreachable: 'origin' does not appear to be a
// git repository …)`, parked, and the streak never moved.
describe("fetchFailureIsMirrors (a fetch that fails on the mirror is the resident's, not GitHub's)", () => {
  it("names the mirror for a missing remote, a broken object store or an unreadable local repository", () => {
    for (const msg of [
      "exit 128: stderr: fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      "exit 128: stderr: fatal: not a git repository (or any of the parent directories): .git",
      "exit 128: stderr: fatal: bad object HEAD",
      "exit 128: stderr: error: object file /workspace/mirror/objects/ab/cd is empty\nfatal: loose object abcd is corrupt",
      "exit 128: stderr: fatal: unable to read tree 1234",
      "exit 128: stderr: error: cannot open .git/FETCH_HEAD: No such file or directory",
    ]) {
      expect(fetchFailureIsMirrors(msg), msg).toBe(true);
    }
  });

  it("leaves GitHub's failures to GitHub: DNS, timeouts, HTTP errors, refused credentials, a repository GitHub says is not there", () => {
    for (const msg of [
      "exit 128: stderr: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "exit 128: stderr: fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
      "exit 128: stderr: fatal: unable to access 'https://github.com/o/r.git/': Operation timed out after 300000 milliseconds",
      "exit 128: stderr: remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
      "exit 128: stderr: remote: Invalid username or token. Password authentication is not supported\nfatal: Authentication failed",
      "token-mint-failed (command-level, fetching anonymously): 422; then exit 128: stderr: remote: Repository not found.",
      "fetch timed out after 300000ms",
      "",
    ]) {
      expect(fetchFailureIsMirrors(msg), msg).toBe(false);
    }
  });
});

describe("classifyRefreshFailure (a build SIGTERM'd by a deploy is an interruption, not evidence)", () => {
  const live = "exit 143: Session terminated, killing shell... ...killed.";

  it("exit 143 during build → refresh-interrupted, the reason prefixed so the instance step retries it instead of recording `degraded`", () => {
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

  it("a wake path's `restore-interrupted:` verdict (the probe found the container gone) is an interruption for the instance step too, whatever exit the extract reported", () => {
    const f = classifyRefreshFailure({
      step: "checkout-restore-extract",
      message: "restore-interrupted: exit 137: no output — the container stopped under the restore",
    });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toMatch(/^refresh-interrupted: checkout-restore-extract restore-interrupted: exit 137/);
    // The prefix is read at the start of the message only: a step whose own
    // output happens to quote it is not an interruption.
    expect(
      classifyRefreshFailure({ step: "build", message: "exit 1: grep: restore-interrupted: not found" }).interrupted,
    ).toBe(false);
  });

  it("an ordinary build failure stays <step>-failed with the message verbatim", () => {
    const f = classifyRefreshFailure({ step: "build", message: "exit 1: src/x.ts(3,1): error TS2304" });
    expect(f).toEqual({
      step: "build",
      interrupted: false,
      diskFull: false,
      runtimeUnreachable: false,
      reason: "build-failed: exit 1: src/x.ts(3,1): error TS2304",
    });
  });

  it("our own timeout kill is NOT an interruption — the build really did not finish in budget", () => {
    const f = classifyRefreshFailure({ step: "build", message: "exit 143 (timed out): killed" });
    expect(f.interrupted).toBe(false);
    expect(f.reason).toMatch(/^build-failed: /);
  });

  it("snapshot step killed by a container replacement — 'Process supervisor is closed' → refresh-interrupted", () => {
    const f = classifyRefreshFailure({ step: "snapshot", message: "Process supervisor is closed" });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toBe("refresh-interrupted: snapshot Process supervisor is closed");
  });

  it("SDK stale-handle wording ('previous runtime incarnation') → refresh-interrupted, any step", () => {
    const f = classifyRefreshFailure({
      step: "fetch",
      message: "Process handle refers to a previous runtime incarnation",
    });
    expect(f.interrupted).toBe(true);
    expect(f.reason).toMatch(/^refresh-interrupted: fetch /);
  });

  it("the SDK replacement wording is case-insensitive and covers the whole isRuntimeReplacement message family", () => {
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

  it("our own timeout kill still wins over a replacement wording in the same message", () => {
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

describe("restoreFailureDisposition (a restore the runtime replacement interrupts is retried, never down)", () => {
  // The exact reason a production resident carried when a resident Worker
  // deploy rolled its container mid-restore: the wake path
  // sent it `down(r2-restore-failed: …)` and only a rebuild could bring it
  // back, though nothing was still streaming into the disk — the container
  // it streamed into was gone.
  const REPLACED_MID_RESTORE =
    "runtime-replaced: the resident runtime was replaced (a deploy) while this command was starting; its output is lost (The container is not running, consider calling start())";

  it("a runtime replacement under the restore is `interrupted`: the disk it streamed into is gone, so nothing can land on a rebuild", () => {
    expect(restoreFailureDisposition(REPLACED_MID_RESTORE)).toEqual({
      action: "interrupted",
      reason: `restore-interrupted: ${REPLACED_MID_RESTORE}`,
    });
  });

  it("every wording the SDK uses for a replaced runtime is interrupted, wherever in the message it sits", () => {
    for (const msg of [
      "Process handle refers to a previous runtime incarnation",
      "operation interrupted because the runtime changed",
      "Process supervisor is closed",
      "sandbox.exec failed: The container is not running, consider calling start()",
    ]) {
      expect(restoreFailureDisposition(msg).action, msg).toBe("interrupted");
    }
  });

  it("a typed replacement with no wording on its message is interrupted when the caller says so (the Worker's typed and cause-chain check), and a timeout still wins", () => {
    expect(restoreFailureDisposition("restore failed", { runtimeReplaced: true })).toEqual({
      action: "interrupted",
      reason: "restore-interrupted: restore failed",
    });
    expect(restoreFailureDisposition("restore failed", { runtimeReplaced: false }).action).toBe("down");
    expect(restoreFailureDisposition("restore failed (timed out)", { runtimeReplaced: true }).action).toBe("down");
  });

  it("a stalled or capped restore is still `down`: the SDK call cannot be cancelled and may still be writing", () => {
    for (const msg of [
      "checkout restore stalled: 0 bytes written in 120000 ms (archive 0 B, target 0 B)",
      "mirror restore over the 25 min cap (1500000 ms): 2.1 GiB so far",
      "2 earlier restore(s) still running (timed out)",
    ]) {
      const d = restoreFailureDisposition(msg);
      expect(d.action, msg).toBe("down");
      expect(d.reason).toBe(`r2-restore-failed: ${msg} — container stopped so the transfer cannot land on a rebuild`);
    }
  });

  it("a genuinely failed container is `down`, not interrupted — a crash is not a replacement", () => {
    expect(restoreFailureDisposition("container exited with unexpected exit code: 1").action).toBe("down");
    expect(restoreFailureDisposition("the container is not listening").action).toBe("down");
  });

  it("a runtime replacement whose message also says it timed out is still `down`: the timeout means the stream ran on", () => {
    expect(
      restoreFailureDisposition("exit 143 (timed out): The container is not running, consider calling start()").action,
    ).toBe("down");
  });

  // The incident this names: a release's deploy rolled a resident's container
  // 300 ms into the checkout extract; the extract's exec came
  // back a normal result — `exit 143: no output`, SIGTERM — and only the
  // cleanup execs 10 ms later carried the SDK's `container is not running`
  // wording, swallowed. The wake path read a snapshot failure and went `down`.
  it("an extract killed by SIGTERM (exit 143, no output) is `interrupted` — the same kill signature the instance step's classifier already reads", () => {
    for (const msg of ["exit 143: no output", "exit 143: stderr: Terminated", "unsquashfs: SIGTERM received"]) {
      expect(restoreFailureDisposition(msg), msg).toEqual({
        action: "interrupted",
        reason: `restore-interrupted: ${msg}`,
      });
    }
  });

  it("a runtime the Worker probed and found stopped after the failure is `interrupted` whatever the exit said: the disk the extract wrote to is gone", () => {
    expect(restoreFailureDisposition("exit 137: no output", { runtimeActive: false })).toEqual({
      action: "interrupted",
      reason: "restore-interrupted: exit 137: no output — the container stopped under the restore",
    });
    expect(restoreFailureDisposition("exit 137: no output", { runtimeActive: true }).action).toBe("down");
    expect(restoreFailureDisposition("exit 137: no output").action).toBe("down");
    // A timeout still wins: the stream may still be running on a live disk.
    expect(restoreFailureDisposition("exit 143 (timed out): no output", { runtimeActive: false }).action).toBe("down");
  });
});

describe("RUNTIME_REPLACEMENT_WORDING (a deploy that ROLLS the container, not just swaps the isolate)", () => {
  // The exact string the resident logs when a deploy rolls the container onto
  // an empty ephemeral disk under a run — `sandbox.exec error … The container
  // is not running, consider calling start()`. It is a raw workerd binding
  // refusal (no typed SDK class), so the shared message wording is the ONLY
  // signal isRuntimeReplacement has.
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

  it("a container roll under a refresh step is refresh-interrupted, not <step>-failed (the engine retries the step, the snapshot keeps serving)", () => {
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

  it("is the union of two lists a reader tells apart: the SDK's words that vouch the runtime MOVED (a new incarnation serves the thread) and the platform's words for a container that is merely DOWN (stopped, asleep or starting) — the resident's /exec says runtime-replaced on the first whatever it knows, and on the second only when it knows the container it held is gone", () => {
    const moved = [
      "Process handle refers to a previous runtime incarnation",
      "interrupted because the runtime changed",
      "Runtime identity is no longer active",
      "sandbox lifetime is no longer current",
      "the platform was updating the sandbox runtime",
      "the runtime no longer identifies pid 4242",
    ];
    const down = ["Process supervisor is closed", CONTAINER_ROLLED];
    for (const text of moved) {
      expect(RUNTIME_MOVED_WORDING.test(text), text).toBe(true);
      expect(STOPPED_CONTAINER_WORDING.test(text), text).toBe(false);
      expect(RUNTIME_REPLACEMENT_WORDING.test(text), text).toBe(true);
    }
    for (const text of down) {
      expect(STOPPED_CONTAINER_WORDING.test(text), text).toBe(true);
      expect(RUNTIME_MOVED_WORDING.test(text), text).toBe(false);
      expect(RUNTIME_REPLACEMENT_WORDING.test(text), text).toBe(true);
    }
    // The union is exactly the two lists, and case-insensitive like both.
    expect(RUNTIME_REPLACEMENT_WORDING.source).toBe(
      `${RUNTIME_MOVED_WORDING.source}|${STOPPED_CONTAINER_WORDING.source}`,
    );
    expect(RUNTIME_REPLACEMENT_WORDING.flags).toBe("i");
    expect(STOPPED_CONTAINER_WORDING.test("the container is not running, consider calling start()")).toBe(true);
    // Neither list broadens to the failures the block above keeps out.
    expect(STOPPED_CONTAINER_WORDING.test("container exited with unexpected exit code: 1")).toBe(false);
    expect(RUNTIME_MOVED_WORDING.test("the container is not listening")).toBe(false);
  });
});

describe("classifyRefreshFailure (a full container disk is `disk-full`, not GitHub's fault and not the repo's)", () => {
  // The refresh reason a full disk produces — recorded as github-unreachable,
  // every attach fails at git-setup.
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
      step: "git-setup",
      interrupted: false,
      diskFull: false,
      runtimeUnreachable: false,
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

describe("withTimeout (R2 snapshot/restore calls get an explicit budget)", () => {
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

describe("judgeRestoreProgress (an R2 restore is judged by the bytes still arriving, not by a clock)", () => {
  // A ~2 GiB checkout restore can take eight minutes; under a fixed 300 s
  // budget it was declared failed while still writing, a second hydrate ran
  // `rm -rf` over the still-writing first one, and the resident went
  // down(r2-restore-failed) on a disk with plenty of room.
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

describe("restoreArchivePath (a restore's bytes land in the SDK's staging archive first, not the target)", () => {
  // Judged on the target alone, every `du` sample of /workspace/checkout reads
  // 0 while the archive is still downloading to /var/backups/<id>.sqsh, and the
  // judge calls a healthy restore stalled.
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

describe("planWakeDepsBudget (item 61 PR B: the wake's deps materialization lives inside the ONE hydrate deadline)", () => {
  const t0 = 1_000_000;
  const install = 10 * 60_000;

  it("plenty of deadline left → the install keeps its own budget and the restore is judged against the hydrate deadline", () => {
    const deadline = t0 + RESTORE_MAX_MS;
    expect(planWakeDepsBudget({ nowMs: t0, deadlineMs: deadline, installBudgetMs: install })).toEqual({
      action: "materialize",
      installBudgetMs: install,
      restoreDeadlineMs: deadline,
      remainingMs: RESTORE_MAX_MS,
    });
  });

  it("less deadline left than the install budget → the install is bounded by what remains, never past the deadline", () => {
    const deadline = t0 + 3 * 60_000;
    const b = planWakeDepsBudget({ nowMs: t0, deadlineMs: deadline, installBudgetMs: install });
    expect(b).toEqual({
      action: "materialize",
      installBudgetMs: 3 * 60_000,
      restoreDeadlineMs: deadline,
      remainingMs: 3 * 60_000,
    });
  });

  it("under WAKE_DEPS_MIN_MS left → skip (the deps checkpoint stays unwritten; the next refresh installs) — also when the deadline has passed", () => {
    expect(planWakeDepsBudget({ nowMs: t0, deadlineMs: t0 + WAKE_DEPS_MIN_MS - 1, installBudgetMs: install })).toEqual({
      action: "skip",
      remainingMs: WAKE_DEPS_MIN_MS - 1,
    });
    expect(planWakeDepsBudget({ nowMs: t0, deadlineMs: t0 - 5_000, installBudgetMs: install })).toEqual({
      action: "skip",
      remainingMs: 0,
    });
    expect(WAKE_DEPS_MIN_MS).toBeGreaterThanOrEqual(60_000);
  });
});

/** The installed SDK's dist, as text (its exports map hides package.json). */
function installedSdkSource(): string {
  const dist = path.dirname(require.resolve("@cloudflare/sandbox"));
  return readdirSync(dist)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(path.join(dist, f), "utf8"))
    .join("\n");
}

describe("runtime-unreachable (a container whose control port never answers is named, never a command failure)", () => {
  // The production failure, verbatim from the resident Worker's log: every
  // `sandbox.exec` rejected after exactly 30 s with the DOMException the SDK's
  // connect timeout raises, from inside the wake path.
  const production = Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
    stack: [
      "AbortError: The operation was aborted",
      "    at ContainerControlConnection.fetchUpgradeAttempt",
      "    at ContainerControlConnection.doConnect",
      "    at ContainerControlConnection.connect",
      "    at RuntimeBootstrapProbe.probe",
      "    at SandboxRuntimeLifecycle.doEstablish",
      "    at RuntimeOperationRunner.runWaking",
      "    at ResidentDO.exec",
    ].join("\n"),
  });

  it("the production AbortError is the signal — by its name, and by the DOMException's message when a wrapper copied only that", () => {
    expect(isRuntimeUnreachableSignal(production)).toBe(true);
    expect(isRuntimeUnreachableSignal({ name: "AbortError", message: "" })).toBe(true);
    expect(isRuntimeUnreachableSignal(new Error("The operation was aborted"))).toBe(true);
  });

  it("nothing else is: a command's own abort, a timeout, a replacement, a crash, a non-error", () => {
    expect(isRuntimeUnreachableSignal(new Error("exit 134: Aborted (core dumped)"))).toBe(false);
    expect(isRuntimeUnreachableSignal(new Error("exit 143 (timed out): killed"))).toBe(false);
    expect(isRuntimeUnreachableSignal({ name: "ProcessWaitTimeoutError", message: "Process wait timed out" })).toBe(
      false,
    );
    expect(isRuntimeUnreachableSignal(new Error("Process supervisor is closed"))).toBe(false);
    expect(isRuntimeUnreachableSignal(new Error("container exited with unexpected exit code 137"))).toBe(false);
    expect(isRuntimeUnreachableSignal(null)).toBe(false);
    expect(isRuntimeUnreachableSignal("The operation was aborted")).toBe(false);
  });

  it("the signal and the replacement family are disjoint — the Worker asks about a replacement first, and a replaced runtime is never counted as unreachable", () => {
    for (const msg of [
      "Process supervisor is closed",
      "Process handle refers to a previous runtime incarnation",
      "The container is not running, consider calling start()",
    ]) {
      expect(RUNTIME_REPLACEMENT_WORDING.test(msg)).toBe(true);
      expect(isRuntimeUnreachableSignal(new Error(msg))).toBe(false);
    }
    expect(RUNTIME_REPLACEMENT_WORDING.test(production.message)).toBe(false);
  });

  it("the ladder: attempts 1–2 re-arm, 3 stops the container, 4–5 destroy it and restore from the snapshot, 6 and beyond go down", () => {
    expect(RUNTIME_UNREACHABLE_STOP_AT).toBe(3);
    expect(RUNTIME_UNREACHABLE_RECREATE_AT).toBe(4);
    expect(RUNTIME_UNREACHABLE_DOWN_AT).toBe(6);
    expect(runtimeUnreachableRung(1)).toBe("re-arm");
    expect(runtimeUnreachableRung(2)).toBe("re-arm");
    expect(runtimeUnreachableRung(3)).toBe("stop");
    expect(runtimeUnreachableRung(4)).toBe("recreate");
    expect(runtimeUnreachableRung(5)).toBe("recreate");
    expect(runtimeUnreachableRung(6)).toBe("down");
    expect(runtimeUnreachableRung(7)).toBe("down");
    expect(runtimeUnreachableRung(100)).toBe("down");
  });

  it("a rung needs a count of at least one — zero and negative counts are a caller bug, not a rung", () => {
    expect(() => runtimeUnreachableRung(0)).toThrow(RangeError);
    expect(() => runtimeUnreachableRung(-1)).toThrow(RangeError);
    expect(() => runtimeUnreachableRung(Number.NaN)).toThrow(RangeError);
  });

  it("the reason names the port, the SDK's 30 s and the attempt out of the down threshold — never the bare `The operation was aborted`", () => {
    const reason = runtimeUnreachableReason(3);
    expect(reason).toBe(
      `runtime-unreachable: the container's control port did not answer within ${SDK_CONNECT_TIMEOUT_MS / 1000} s (attempt 3 of ${RUNTIME_UNREACHABLE_DOWN_AT})`,
    );
    expect(reason).not.toMatch(/operation was aborted/);
    expect(isRuntimeUnreachableReason(reason)).toBe(true);
    expect(isRuntimeUnreachableReason("refresh-failed: The operation was aborted")).toBe(false);
    expect(isRuntimeUnreachableReason("runtime-unreachable")).toBe(false);
  });

  it("each rung appends what it did, so the state reason says what happened and what the retry does next", () => {
    expect(runtimeUnreachableReason(1, "re-arm")).toMatch(/\(attempt 1 of 6\) — the step is retried/);
    expect(runtimeUnreachableReason(3, "stop")).toMatch(/\(attempt 3 of 6\) — the container was stopped/);
    expect(runtimeUnreachableReason(4, "recreate")).toMatch(
      /\(attempt 4 of 6\) — the container was destroyed and the SDK's runtime identity forgotten, snapshots kept; the retry restores the checkout from the snapshot/,
    );
    expect(runtimeUnreachableReason(6, "down")).toMatch(
      /\(attempt 6 of 6\) — a recreated container did not answer either; only a rebuild follows/,
    );
    for (const rung of ["re-arm", "stop", "recreate", "down"] as const) {
      expect(isRuntimeUnreachableReason(runtimeUnreachableReason(2, rung))).toBe(true);
    }
  });

  it("is never a serviceable degraded reason — the bot goes cold without attaching to a runtime that cannot answer", () => {
    expect(degradedIsServiceable(runtimeUnreachableReason(1, "re-arm"))).toBe(false);
    expect(degradedIsServiceable(runtimeUnreachableReason(4, "recreate"))).toBe(false);
  });

  it("classifyRefreshFailure with the caller's count → the `runtime-unreachable` outcome with the named reason, whatever the step and message", () => {
    const f = classifyRefreshFailure({
      step: "refresh",
      message: production.message,
      runtimeUnreachable: { count: 2 },
    });
    expect(f).toEqual({
      step: "refresh",
      interrupted: false,
      diskFull: false,
      runtimeUnreachable: true,
      reason: runtimeUnreachableReason(2),
    });
    expect(
      classifyRefreshFailure({ step: "fetch", message: "anything", runtimeUnreachable: { count: 5 } }).reason,
    ).toBe(runtimeUnreachableReason(5));
  });

  it("the caller's count wins over a disk probe: no probe is consulted and the disk is never named", () => {
    const f = classifyRefreshFailure({
      step: "refresh",
      message: production.message,
      runtimeUnreachable: { count: 1 },
      freeKiB: DISK_FULL_FREE_KIB - 1,
    });
    expect(f.diskFull).toBe(false);
    expect(f.runtimeUnreachable).toBe(true);
  });

  it("without the caller's word the classifier does not guess from the wording — the message stays the step's own failure, as it did in production", () => {
    const f = classifyRefreshFailure({ step: "refresh", message: production.message });
    expect(f).toEqual({
      step: "refresh",
      interrupted: false,
      diskFull: false,
      runtimeUnreachable: false,
      reason: "refresh-failed: The operation was aborted",
    });
  });

  it("a timeout wording stays the step's own failure and a timed-out restore stays down — the ladder never widens those", () => {
    const f = classifyRefreshFailure({ step: "build", message: "exit 143 (timed out): killed" });
    expect(f.runtimeUnreachable).toBe(false);
    expect(f.reason).toMatch(/^build-failed: /);
    expect(restoreFailureDisposition("checkout restore (timed out) The operation was aborted").action).toBe("down");
  });

  it("the 30 s is the INSTALLED SDK's connect timeout (`DEFAULT_CONNECT_TIMEOUT_MS`), not ours — an SDK bump that moves it fails here", () => {
    const m = /const DEFAULT_CONNECT_TIMEOUT_MS = ([0-9e]+);/.exec(installedSdkSource());
    expect(m, "the SDK declares DEFAULT_CONNECT_TIMEOUT_MS").not.toBeNull();
    expect(Number(m![1])).toBe(SDK_CONNECT_TIMEOUT_MS);
    expect(SDK_CONNECT_TIMEOUT_MS).toBe(30_000);
  });

  it("the SDK's runtime identity lives under the INSTALLED SDK's RUNTIME_RECORD_KEY, deleted by its own stop and destroy — the resident's explicit forget names the same key", () => {
    const source = installedSdkSource();
    const m = /const RUNTIME_RECORD_KEY = "([^"]+)";/.exec(source);
    expect(m, "the SDK declares RUNTIME_RECORD_KEY").not.toBeNull();
    expect(m![1]).toBe(SDK_RUNTIME_RECORD_KEY);
    // The two facts the ladder's rung 3 rests on: destroy forgets the identity
    // as its first act, and a destroy without a stored identity skips the
    // runtime cleanup (no wait against a silent port).
    expect(source).toMatch(/async doDestroy\(\) \{[\s\S]{0,400}?invalidateAndObserveStoredActive\(\)/);
    expect(source).toMatch(/if \(stored\) await this\.options\.storage\.delete\(RUNTIME_RECORD_KEY\);/);
    expect(source).toMatch(
      /async runBoundedDestroyRuntimeCleanup\(cleanupRuntime\) \{\s*if \(!cleanupRuntime\) return await this\.bucketMounts\.cleanupForDestroyWithoutRuntime\(\);/,
    );
    // And stop() is a signal the SDK never waits on — the rung the ladder does
    // not rest on (a wedged runtime ignored it live).
    expect(source).toMatch(
      /async performRuntimeStop\(physicalStop\) \{\s*await this\.runtimeLifecycle\.invalidate\(\);/,
    );
  });

  it("the wake budget: the first connect after a start waits WAKE_PORT_READY_MS (3 min) for the control port through the SDK's env knob, inside the SDK's bounds and above its default", () => {
    const source = installedSdkSource();
    const knob = new RegExp(
      `getEnvString\\(env\\$1, "${SDK_PORT_READY_ENV}"\\), "portReadyTimeoutMS", ([0-9e]+), ([0-9e]+)\\)`,
    ).exec(source);
    expect(knob, `the SDK reads ${SDK_PORT_READY_ENV} for portReadyTimeoutMS`).not.toBeNull();
    const [, min, max] = knob!;
    expect(WAKE_PORT_READY_MS).toBe(3 * 60_000);
    expect(WAKE_PORT_READY_MS).toBeGreaterThanOrEqual(Number(min));
    expect(WAKE_PORT_READY_MS).toBeLessThanOrEqual(Number(max));
    const dflt = /portReadyTimeoutMS: ([0-9e]+),/.exec(source);
    expect(dflt, "the SDK declares a portReadyTimeoutMS default").not.toBeNull();
    expect(WAKE_PORT_READY_MS).toBeGreaterThan(Number(dflt![1]));
    expect(WAKE_PORT_READY_MS).toBeGreaterThan(SDK_CONNECT_TIMEOUT_MS);
  });
});
