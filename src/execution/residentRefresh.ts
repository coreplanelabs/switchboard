/** The refresh cycle's rebuild decision for the resident Worker's
 *  `onRefreshAlarm` (deploy/cloudflare-resident/worker.ts), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported across
 *  packages by the resident Worker (like residentDetach) — the tested code IS
 *  the shipped code.
 *
 *  Background (#163): the refresh used to `git clean -fdx` + `npm install` on
 *  EVERY default-branch advance (a 130 s refresh was observed live), even
 *  though the committed lockfile — the dependency cache key (KTD7) — rarely
 *  moves. A refresh longer than the bot's 60 s attach wait sends runs cold.
 *  The `-x` clean itself is load-bearing: attached, sha-pinned thread
 *  worktrees hardlink the checkout's dep/build FILE inodes, so a rebuild must
 *  allocate fresh inodes rather than write through shared ones (review 1b).
 *  Skipping install therefore keeps `node_modules` — inodes nobody is about
 *  to write through — while still cleaning every other gitignored path (build
 *  output), so the build allocates fresh inodes exactly as before.
 *
 *  The disk facts come from two root-only markers the cycle writes as it
 *  materializes (deps key after install, built sha after build) plus the
 *  checkout's actual HEAD. A worker-code deploy resets the DO mid-cycle but
 *  leaves the container disk alone, so the next alarm can pick up where the
 *  interrupted one stopped instead of redoing the whole rebuild. */

import { DISK_FULL_FREE_KIB, diskFullReason, isDiskFullMessage } from "./residentDisk.js";

export interface RefreshDisk {
  /** `git rev-parse HEAD` of the warm checkout; null when unreadable. */
  head: string | null;
  /** Lockfile key whose install fully completed into the checkout's node_modules; null when absent. */
  installedKey: string | null;
  /** Lockfile key an install was STARTED for and never completed (the marker is
   *  written before `install` and removed after the deps key lands); null when absent. */
  installingKey: string | null;
  /** Sha whose build fully completed in the checkout; null when absent. */
  builtSha: string | null;
}

/** What the `-x` clean may remove: everything untracked, or everything except `node_modules`. */
export type CleanScope = "all" | "keep-deps";

export type RefreshPlan =
  /** The default branch did not move — nothing to rebuild or snapshot. */
  | { action: "unchanged" }
  /** Checkout, deps and build already match the target (an interrupted cycle
   *  got this far): skip straight to the snapshot. */
  | { action: "reuse"; why: string }
  /** Update the checkout; `install` only when the committed lockfile moved. */
  | { action: "rebuild"; install: boolean; clean: CleanScope; why: string };

export function planRefresh(input: {
  /** Mirror sha of the default branch after the fetch. */
  sha: string;
  /** The sha the recorded facts (and the last snapshot) are at. */
  factsSha: string;
  /** Committed-lockfile key at `sha` (pure function of the commit, KTD7). */
  lockfileKey: string;
  disk: RefreshDisk;
}): RefreshPlan {
  const { sha, factsSha, lockfileKey, disk } = input;
  if (sha === factsSha) return { action: "unchanged" };
  const depsMatch = disk.installedKey !== null && disk.installedKey === lockfileKey;
  if (depsMatch && disk.head === sha && disk.builtSha === sha) {
    return { action: "reuse", why: `checkout, deps and build already materialized for ${sha.slice(0, 8)}` };
  }
  if (depsMatch) {
    return { action: "rebuild", install: false, clean: "keep-deps", why: "lockfile unchanged — deps kept, build only" };
  }
  if (disk.installedKey === null && disk.installingKey !== null && disk.installingKey === lockfileKey) {
    // A previous cycle started this very install and ended before the deps
    // key landed (its step timed out, or its DO isolate died; the pre-step
    // sweep has killed any writer it left). npm reconciles a partial tree to
    // the lockfile, so resuming converges where wipe-and-restart cannot: a
    // repo whose cold install outruns one step budget still lands over cycles
    // (live 2026-09-07: four consecutive full installs, none finishing).
    // Safe for the hardlink invariant (review 1b): threads only link deps
    // whose key the deps marker vouches for, and no marker vouched for these.
    return {
      action: "rebuild",
      install: true,
      clean: "keep-deps",
      why: "install resumes — a previous attempt for this lockfile ended before the deps marker; npm reconciles the partial tree",
    };
  }
  const why = disk.installedKey === null ? "no deps marker on disk — full install" : "lockfile changed — full install";
  return { action: "rebuild", install: true, clean: "all", why };
}

/** Tool caches that BUILDS (not installs) write inside node_modules — and
 *  typically open+truncate in place: babel-loader/eslint/webpack under
 *  `.cache`, vite/vitest under `.vite`. Kept deps are hardlinked into attached
 *  worktrees, so these must go before a keep-deps build or it would write
 *  through shared inodes (review 1b). Pruned at any depth (workspaces). */
export const NODE_MODULES_CACHE_DIRS = [".cache", ".vite"] as const;

/** The checkout-update shell for the build user (runs inside the checkout):
 *  fetch from the local mirror, hard-reset to `sha`, then the `-x` clean.
 *  `-e node_modules` is a git exclude pattern (matches at any depth, so
 *  workspace packages keep theirs too) that survives `-x`; everything else
 *  gitignored — build output above all — is still removed so the build
 *  allocates fresh inodes (review 1b). Keep-deps additionally sweeps the
 *  build-written caches inside node_modules (NODE_MODULES_CACHE_DIRS). */
export function checkoutUpdateCommand(sha: string, clean: CleanScope): string {
  const base = `git fetch --quiet origin && git reset --hard --quiet ${sha}`;
  if (clean === "all") return `${base} && git clean -fdx`;
  const names = NODE_MODULES_CACHE_DIRS.map((d) => `-name ${d}`).join(" -o ");
  const sweep = `find . -path '*/node_modules/*' -type d \\( ${names} \\) -prune -exec rm -rf {} +`;
  return `${base} && git clean -fdx -e node_modules && ${sweep}`;
}

// -- interruption vs. failure (#216) -----------------------------------------

/** How a refresh-cycle step failed. `interrupted` is the one outcome that says
 *  NOTHING about the repository: the step was killed from outside because the
 *  CONTAINER was replaced under it — an image-changing deploy or an explicit
 *  container stop/restart. (A Worker-only deploy swaps the DO isolate but
 *  leaves the container and its processes running — live 2026-08-30, #335 — so
 *  it cannot interrupt a step at all.) The kill surfaces either as the shell's
 *  own death (SIGTERM, exit 143, "Session terminated") or, past the shell, as
 *  the SDK's replacement errors (stale process handle, closed supervisor).
 *  Everything else is the repo's own build failing. */
export interface RefreshFailure {
  /** The `degraded` reason to record. Interruptions are prefixed
   *  `refresh-interrupted:` so the park-streak gate can exclude them by prefix,
   *  exactly like the watchdog's stamps; a full disk is `disk-full:` (#457,
   *  `residentDisk.ts` — the cycle's entry gate and the recycle decision key
   *  on it); real failures keep `<step>-failed:`. */
  reason: string;
  interrupted: boolean;
  diskFull: boolean;
}

/** Root argv that kills every process the build user still owns and waits
 *  (bounded, 5 s) until none is left. Runs before EVERY build-user step.
 *
 *  Why (2026-09-07, switchboard resident): `npm install` outlived its budget
 *  and the SDK's output grace; the cycle recorded the timeout and moved on
 *  while npm kept extracting into CHECKOUT_DIR/node_modules. The next cycle's
 *  `git clean -fdx` raced it — `warning: failed to remove node_modules/dayjs:
 *  Directory not empty` on exactly the packages being written — and the
 *  resident spiralled between `checkout-update-failed` and install timeouts
 *  (each cycle's install now sharing 1 vCPU with the last one's orphan) for
 *  as long as main kept moving. A Worker-only deploy is the other way to
 *  orphan a step: the DO isolate resets, the container keeps running.
 *
 *  Scoped to the TREE the step is about to touch (`dir`): a process counts as
 *  stale when its cwd is `dir` or below it. Steps on one tree are strictly
 *  sequential, so a live build-user process inside that tree at step start
 *  is by definition a leftover — while the same user's installs into OTHER
 *  trees (the deps store runs distinct keys in parallel, item 59) are live
 *  work this sweep must not touch. Survivors are NAMED on stdout (the Worker
 *  log shows what was still running) before SIGKILL: SIGTERM would let npm
 *  keep writing while the clean runs. Nothing matching is the happy path; a
 *  process that survives SIGKILL for 5 s fails the step — nothing may start
 *  beside it. */
export function killStaleBuildProcessesCommand(user: string, dir: string): string[] {
  const inTree = `case "$(readlink /proc/$p/cwd 2>/dev/null)" in ${dir}|${dir}/*) `;
  const script =
    `stale=""; for p in $(pgrep -u ${user}); do ${inTree}stale="$stale$p ";; esac; done; ` +
    `if [ -n "$stale" ]; then ` +
    `echo "killing stale ${user} processes under ${dir}:"; ps -o pid=,args= -p $(echo $stale | tr ' ' ',') 2>/dev/null; ` +
    `kill -KILL $stale 2>/dev/null; ` +
    `i=0; while :; do alive=""; for p in $stale; do kill -0 $p 2>/dev/null && alive="$alive$p "; done; ` +
    `[ -z "$alive" ] && break; i=$((i+1)); ` +
    `if [ $i -ge 50 ]; then echo "stale ${user} processes survived SIGKILL for 5s: $alive" >&2; exit 1; fi; ` +
    `sleep 0.1; done; ` +
    `fi`;
  return ["sh", "-c", script];
}

/** Signature of a step killed from OUTSIDE its own budget: the exit status of
 *  SIGTERM (128 + 15), bash's "Session terminated" on a killed login shell, or
 *  a tool naming the signal. A bare "killed" is NOT enough — compilers and
 *  OOM messages say it too — and a step the cycle itself timed out is a real
 *  failure however it died. */
const INTERRUPTION_SIGNATURE = /\bexit 143\b|Session terminated|SIGTERM/;

/** Message wording of the Sandbox SDK's runtime-replacement error family — the
 *  container went away UNDER a live SDK call, so the failure never reaches the
 *  shell-kill signature above: a step that dies this way surfaces as
 *  `StaleProcessHandleError` ("previous runtime incarnation"),
 *  `ProcessSpawnFailedError` ("Process supervisor is closed"), or one of the
 *  SDK's interruption messages. Shared with the resident Worker's
 *  `isRuntimeReplacement` (deploy/cloudflare-resident/worker.ts) as its
 *  message-level fallback, so the exec path and the refresh classifier agree on
 *  one wording list (#335: a `stop-container` mid-snapshot produced
 *  "Process supervisor is closed" and was classified as the repo's own
 *  `snapshot-failed`, re-arming at the full cadence). */
export const RUNTIME_REPLACEMENT_WORDING =
  /previous runtime incarnation|interrupted because the runtime changed|runtime identity is no longer active|sandbox lifetime is no longer current|platform was updating the sandbox runtime|no longer identifies pid|process supervisor is closed/i;

/** `freeKiB` is the `df` probe's answer (`parseDfFreeKiB`), taken AFTER the
 *  step failed and only consulted when the message itself carries no errno:
 *  a message saying ENOSPC is disk-full outright (the disk is the actionable
 *  fact, whatever else the message says); a kill signature without it is an
 *  interruption whatever the disk holds (the kill ended the step); otherwise a
 *  probe below the floor names the disk, and no probe (`undefined`/`null`)
 *  leaves the step's own failure — unknown is never full. */
export function classifyRefreshFailure(input: {
  step: string;
  message: string;
  freeKiB?: number | null;
}): RefreshFailure {
  const { step, message } = input;
  if (isDiskFullMessage(message)) {
    return {
      interrupted: false,
      diskFull: true,
      reason: diskFullReason({ step, message, freeKiB: input.freeKiB ?? null }),
    };
  }
  const timedOut = /\(timed out\)/.test(message);
  if (!timedOut && (INTERRUPTION_SIGNATURE.test(message) || RUNTIME_REPLACEMENT_WORDING.test(message))) {
    return { interrupted: true, diskFull: false, reason: `refresh-interrupted: ${step} ${message}` };
  }
  if (input.freeKiB !== undefined && input.freeKiB !== null && input.freeKiB < DISK_FULL_FREE_KIB) {
    return { interrupted: false, diskFull: true, reason: diskFullReason({ step, message, freeKiB: input.freeKiB }) };
  }
  return { interrupted: false, diskFull: false, reason: `${step}-failed: ${message}` };
}

/** Re-arm delay after a cycle that did not run to completion for a reason
 *  outside the repo — an interrupted step, or an image-stale container stop.
 *  45 s: comfortably longer than a container restart plus rehydration
 *  (~10–20 s observed), so the retry finds a live runtime, and an order of
 *  magnitude under the 600 s cadence that previously left the resident
 *  `degraded` (every run falling back cold) until the next regular alarm
 *  (#216, live 2026-08-29: 22:31 → 22:42). */
export const INTERRUPTED_REARM_S = 45;

export type RefreshOutcome =
  /** Cycle ran (warm, or a real failure): regular cadence. */
  | "normal"
  /** A step was killed from outside (see classifyRefreshFailure). */
  | "interrupted"
  /** `reconcileImage` stopped the container so it restarts on the new image. */
  | "image-stale-restart"
  /** The disk-full recovery stopped the container so it restarts on an empty
   *  disk and the next alarm restores from R2 (#457, `residentDisk.ts`). */
  | "disk-full-restart"
  /** Idle gate parked the resident. */
  | "idle";

/** How many CONSECUTIVE interrupted cycles still re-arm short. A real deploy
 *  interrupts once, maybe twice (a deploy train); a step whose own output
 *  happens to carry the kill signature every cycle (a test supervisor printing
 *  `signal SIGTERM`) would otherwise retry at 45 s forever — never parking
 *  (it is excluded from the streak) AND at 13× the cadence. Past the cap the
 *  regular interval returns; the classification (and the streak exclusion)
 *  stand, matching the watchdog's accepted "never parks, but at cadence". */
export const INTERRUPTED_REARM_MAX_CONSECUTIVE = 3;

export function nextRefreshDelayS(input: {
  outcome: RefreshOutcome;
  intervalS: number;
  idleIntervalS: number;
  /** Consecutive cycles (this one included) that ended `interrupted`; omitted = 1. */
  consecutiveInterrupted?: number;
}): number {
  switch (input.outcome) {
    case "idle":
      return input.idleIntervalS;
    case "interrupted":
      return (input.consecutiveInterrupted ?? 1) > INTERRUPTED_REARM_MAX_CONSECUTIVE
        ? input.intervalS
        : INTERRUPTED_REARM_S;
    case "image-stale-restart":
    case "disk-full-restart":
      return INTERRUPTED_REARM_S;
    default:
      return input.intervalS;
  }
}

/** Bound a promise that offers no timeout of its own (#356 item 7a: the
 *  Sandbox SDK's createBackup/restoreBackup take neither a timeout nor an
 *  AbortSignal). On expiry, rejects with an error naming `what` and the
 *  budget, so a hung R2 transfer fails the refresh cycle into its existing
 *  degrade/goDown handling instead of stranding `refreshing`/`restoring`
 *  until the 30-min watchdog. The losing promise keeps running (nothing can
 *  cancel it) — its eventual rejection is swallowed so it never surfaces as
 *  an unhandled rejection. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => {});
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}
