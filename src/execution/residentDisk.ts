// A full container disk, named for what it is (#457, features/resident-repos.md
// item 54). Pure decisions the resident Worker (deploy/cloudflare-resident/
// worker.ts) imports; no I/O, no clock — `now` is an input.
//
// Why this exists: on 2026-09-04 the nominal resident's disk filled. The
// refresh cycle's credential-file write failed with ENOSPC and was recorded as
// `degraded(github-unreachable: …)` — a reason on the bot's serviceable
// allow-list — so every run attached, failed at git-setup with git's errno-less
// `failed to write new configuration file /etc/gitconfig.lock` (exit 4), and
// fell back cold with a message that read like a lock bug. Nothing freed the
// disk. Two facts fix that: the failure is classified `disk-full` (never
// serviceable, so the bot skips the attach and the card names the disk), and
// the resident recycles its container — the disk is a cache (KTD3); the next
// alarm restores mirror + checkout from R2 — once nothing live would be lost.

/** The errno wording tools print for ENOSPC: Node's `ENOSPC` code and libc's
 *  strerror text (git, cp, tar, pnpm all pass it through). A message carrying
 *  either is decisive on its own. */
const DISK_FULL_SIGNATURE = /\bENOSPC\b|no space left on device/i;

export function isDiskFullMessage(message: string): boolean {
  return DISK_FULL_SIGNATURE.test(message);
}

/** Below this much free space the disk is "full" for the resident's purposes:
 *  128 MiB is less than one checkout of the largest onboarded tree (nominal:
 *  75 MB) plus git's pack/lock scratch, so a fetch or a `worktree add` cannot
 *  complete — waiting for a literal 0 would only change which step dies. The
 *  probe is consulted only after a step has already failed, and only when the
 *  step's own message did not carry the errno (`git config`'s write_error
 *  reports no errno: reproduced on a full Linux tmpfs, exit 4). */
export const DISK_FULL_FREE_KIB = 128 * 1024;

/** POSIX `df` in 1 KiB blocks on the workspace mount: one header, one data row,
 *  no locale or column-wrapping surprises (`-P`). */
export const DF_FREE_ARGV = ["df", "-Pk", "/workspace"] as const;

/** The "Available" column of `df -Pk <path>` output, in KiB; `null` when there
 *  is no data row or the column is not a number — unknown is never reported as
 *  0, because 0 would classify every failure as disk-full. */
export function parseDfFreeKiB(stdout: string): number | null {
  const rows = stdout.split("\n").filter((l) => l.trim() !== "");
  if (rows.length < 2) return null;
  const cols = rows[1].trim().split(/\s+/);
  if (cols.length < 4 || !/^\d+$/.test(cols[3])) return null;
  return Number(cols[3]);
}

const DISK_FULL_PREFIX = "disk-full:";

/** The `degraded` reason: the step, its own message verbatim, and — when the
 *  probe answered — the free space, so the reason carries its evidence. */
export function diskFullReason(input: { step: string; message: string; freeKiB: number | null }): string {
  const probe = input.freeKiB === null ? "" : ` (/workspace: ${input.freeKiB} KiB free)`;
  return `${DISK_FULL_PREFIX} ${input.step} ${input.message}${probe}`;
}

export function isDiskFullReason(reason: string): boolean {
  return reason.startsWith(DISK_FULL_PREFIX);
}

/** At most one recycle per hour. A disk that fills again within the hour is
 *  not garbage — it is a working set the instance disk cannot hold, and a
 *  second recycle would only throw away another restore. */
export const DISK_FULL_RECYCLE_COOLDOWN_MS = 60 * 60_000;

export type DiskFullRecovery = { action: "recycle" } | { action: "wait"; why: string };

/** Whether a disk-full resident may stop its container now. The disk is a
 *  cache, but two things on it are not: work in flight (a recycle kills the
 *  process) and a live worktree's uncommitted or unpushed changes (a recycle
 *  destroys the tree; the next attach recreates it from the mirror). Both keep
 *  the container; so does the cooldown. `treesClean` must be computed as the
 *  thread users (never root git in a thread tree) and treated as false when a
 *  check could not run — an unreadable tree is kept, never guessed clean. */
export function planDiskFullRecovery(input: { now: number; lastRecycleAt?: number; inFlight: number; treesClean: boolean }): DiskFullRecovery {
  if (input.lastRecycleAt !== undefined && input.now - input.lastRecycleAt < DISK_FULL_RECYCLE_COOLDOWN_MS) {
    const min = Math.round((input.now - input.lastRecycleAt) / 60_000);
    return {
      action: "wait",
      why: `recycled ${min} min ago and the disk filled again — the working set does not fit the instance disk (resize the instance, or offboard a repo)`,
    };
  }
  if (input.inFlight > 0) return { action: "wait", why: `${input.inFlight} operation(s) in flight — a recycle would kill them` };
  if (!input.treesClean) {
    return { action: "wait", why: "a live worktree has (or could not prove it has no) uncommitted or unpushed work — a recycle would destroy it" };
  }
  return { action: "recycle" };
}
