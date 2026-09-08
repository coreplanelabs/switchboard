import { describe, expect, it } from "vitest";
import {
  DF_FREE_ARGV,
  DISK_FULL_FREE_KIB,
  DISK_FULL_RECYCLE_COOLDOWN_MS,
  diskFullReason,
  isDiskFullMessage,
  isDiskFullReason,
  parseDfFreeKiB,
  planDiskFullRecovery,
} from "./residentDisk.js";

// Feature: docs/reference/specs/resident-repos.md item 54 — a full container disk is named
// `disk-full`, never `github-unreachable` / `<step>-failed`, and the resident
// recycles its (cache) disk once nothing live would be lost.

describe("isDiskFullMessage — the errno wording tools print when the disk is full", () => {
  it("the SDK's writeFile error (the refresh reason a full disk produces) and git's own ENOSPC wording", () => {
    expect(
      isDiskFullMessage(
        "Failed to write file '/workspace/.resident/git-credentials': ENOSPC: no space left on device, write '/workspace/.resident/git-credentials'",
      ),
    ).toBe(true);
    expect(isDiskFullMessage("exit 128: stderr: fatal: write error: No space left on device")).toBe(true);
    expect(isDiskFullMessage("exit 1: stderr: cp: cannot create regular file 'x': No space left on device")).toBe(true);
    expect(isDiskFullMessage("npm ERR! code ENOSPC")).toBe(true);
  });

  it("git config's write_error carries NO errno — the message alone cannot decide (that is what the df probe is for)", () => {
    // The incident's exact stderr (reproduced on a full Linux tmpfs: exit 4).
    expect(isDiskFullMessage("exit 4: stderr: error: failed to write new configuration file /etc/gitconfig.lock")).toBe(
      false,
    );
  });

  it("a stale lock is a different failure with a different message — never disk-full", () => {
    // Reproduced: `git config` against a config whose `.lock` already exists.
    expect(isDiskFullMessage("exit 255: stderr: error: could not lock config file /etc/gitconfig: File exists")).toBe(
      false,
    );
  });

  it("ordinary failures and near-miss words stay false", () => {
    expect(isDiskFullMessage("exit 1: src/x.ts(3,1): error TS2304")).toBe(false);
    expect(isDiskFullMessage("ENOSPCX")).toBe(false);
    expect(isDiskFullMessage("")).toBe(false);
  });
});

describe("parseDfFreeKiB — the free column of POSIX `df -Pk <path>`", () => {
  it("reads the 4th column of the one data row", () => {
    const out =
      "Filesystem     1024-blocks     Used Available Capacity Mounted on\n" +
      "overlay           15999888 15999888         0     100% /\n";
    expect(parseDfFreeKiB(out)).toBe(0);
    expect(
      parseDfFreeKiB(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 16000000 4000000 12000000 25% /workspace\n",
      ),
    ).toBe(12_000_000);
  });

  it("the probe argv is POSIX df in KiB on the workspace mount (one line to parse, no locale surprises)", () => {
    expect([...DF_FREE_ARGV]).toEqual(["df", "-Pk", "/workspace"]);
  });

  it("no data row, a non-numeric column, or a header-only dump → null (unknown, never 0)", () => {
    expect(parseDfFreeKiB("")).toBeNull();
    expect(parseDfFreeKiB("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
    expect(
      parseDfFreeKiB("Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1 2 lots 3% /\n"),
    ).toBeNull();
    expect(parseDfFreeKiB("df: /workspace: No such file or directory\n")).toBeNull();
  });
});

describe("diskFullReason / isDiskFullReason — the degraded reason and its prefix", () => {
  it("names the step, keeps the step's own message verbatim, and appends the probe when it answered", () => {
    expect(
      diskFullReason({
        step: "git-setup",
        message: "exit 4: stderr: error: failed to write new configuration file /etc/gitconfig.lock",
        freeKiB: 0,
      }),
    ).toBe(
      "disk-full: git-setup exit 4: stderr: error: failed to write new configuration file /etc/gitconfig.lock (/workspace: 0 KiB free)",
    );
    expect(diskFullReason({ step: "fetch", message: "ENOSPC: no space left on device", freeKiB: null })).toBe(
      "disk-full: fetch ENOSPC: no space left on device",
    );
  });

  it("the prefix test is exact — `disk-full:` and nothing that merely starts with it", () => {
    expect(isDiskFullReason("disk-full: fetch ENOSPC")).toBe(true);
    expect(isDiskFullReason("disk-fullness: x")).toBe(false);
    expect(isDiskFullReason("github-unreachable: ENOSPC")).toBe(false);
    expect(isDiskFullReason("")).toBe(false);
  });

  it("the free-space floor is a real working margin, not zero: below one checkout of the largest onboarded tree", () => {
    expect(DISK_FULL_FREE_KIB).toBe(128 * 1024);
  });
});

describe("planDiskFullRecovery — recycle the cache disk only when nothing live would be lost, at most once per cooldown", () => {
  const now = 1_800_000_000_000;
  const clear = { now, inFlight: 0, treesClean: true };

  it("nothing in flight, every live tree clean, never recycled → recycle", () => {
    expect(planDiskFullRecovery(clear)).toEqual({ action: "recycle" });
    expect(planDiskFullRecovery({ ...clear, lastRecycleAt: now - DISK_FULL_RECYCLE_COOLDOWN_MS - 1 })).toEqual({
      action: "recycle",
    });
  });

  it("a recycle inside the cooldown is refused and says the working set does not fit", () => {
    const plan = planDiskFullRecovery({ ...clear, lastRecycleAt: now - 12 * 60_000 });
    expect(plan.action).toBe("wait");
    expect(plan.action === "wait" && plan.why).toMatch(/recycled 12 min ago and the disk filled again/);
    expect(plan.action === "wait" && plan.why).toMatch(/does not fit/);
    expect(DISK_FULL_RECYCLE_COOLDOWN_MS).toBe(60 * 60_000);
  });

  it("an operation in flight keeps the container — a recycle would kill it", () => {
    const plan = planDiskFullRecovery({ ...clear, inFlight: 2 });
    expect(plan).toEqual({ action: "wait", why: "2 operation(s) in flight — a recycle would kill them" });
  });

  it("a dirty or unreadable live tree keeps the container — a recycle would destroy uncommitted work", () => {
    const plan = planDiskFullRecovery({ ...clear, treesClean: false });
    expect(plan.action).toBe("wait");
    expect(plan.action === "wait" && plan.why).toMatch(/uncommitted or unpushed work/);
  });

  it("the cooldown is checked first: a refused recycle names the cooldown even when a tree is dirty too", () => {
    const plan = planDiskFullRecovery({ ...clear, lastRecycleAt: now - 60_000, treesClean: false });
    expect(plan.action === "wait" && plan.why).toMatch(/recycled 1 min ago/);
  });
});
