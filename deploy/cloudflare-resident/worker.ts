// Resident Worker: always-warm per-repo environments on Cloudflare Sandbox 1.0
// (@cloudflare/sandbox@next, exact-pinned; the Dockerfile FROM tag must match).
// One ResidentDO — a Sandbox subclass, i.e. a container — per onboarded
// resource, plus one singleton ResidentRegistryDO holding the onboarded set,
// the command table, and the cap.
//
// Residency is a generic resource-typed primitive: every route contract
// carries a `resource` id of the form "<type>:<id>"; "repo" is the first (and
// currently only) supported type, with id "<owner>/<name>" (the GitHub slug —
// the clone URL derives from it). The Durable Object name IS the resource id
// ("repo:<owner>/<name>" — the SDK's sanitizeSandboxId accepts ':' and '/';
// note '/' rules the id out of hostname-based preview URLs, use tunnels).
//
// Route surface (JSON in/out; every route below requires a bearer secret):
//   admin scope     POST /onboard /offboard /reconfigure /rebuild /debug (all ops)
//   read scope      GET /residents   POST /debug ops info|schedules|threads only (admin implied)
//   operator scope  POST /attach /detach /exec /read /write /op            GET /status (state, reason, inFlight)
//   unauthenticated GET /healthz (deploy wake ping; touches no DO)
//
// Lifecycle engine: alarm-driven provisioning (clone → install/build →
// stamped snapshot → warm), wake-path rehydration (`restoring` persisted
// BEFORE restore, stamped snapshots refused on mismatch), a self-rescheduling
// refresh alarm, and a cron watchdog (re-arm dead chains + degraded
// (alarm-missed); time out stuck onboarding; auto-rebuild after N consecutive
// down passes on a rehydration-flavored reason). GitHub App tokens are minted
// repo-scoped on WebCrypto. POST /rebuild is the down→onboarding escape hatch
// (discard snapshots, reprovision from scratch); /offboard and /rebuild
// support dryRun (itemized plan, nothing executed); onboard verifies GitHub
// App installation membership when the App is configured and skips the check
// with an honest `warning` when it is not.
//
// Operator data plane: POST /attach (per-thread worktree off the bare mirror
// + sticky ref binding + dep materialization + per-attach credential file),
// POST /exec (privilege-dropped per-thread execution), POST /read and /write
// (thread-user file ops confined to the worktree), an in-DO mirror mutex
// serializing every mirror mutation, and an inactivity sweep that evicts idle
// worktrees while keeping the binding record. All four thread routes take a
// `resource` field alongside `threadKey` — the service hosts many residents,
// and the resource picks the DO exactly as GET /status does.
//
// POST /op is the deterministic modelless path: a name from a fixed
// enum {test, build, status} resolves through the onboard-time command table
// only, gated by per-entry `effects` profiles (readonly runs, mutating
// refused by name), executed in a DISPOSABLE per-op checkout under
// /workspace/ops — never a thread's attached worktree — and deleted
// afterwards; `status` touches no checkout at all. /reconfigure accepts the
// `effects` map.
//
// SECURITY (deliberate deviations from the thread-sandbox Worker):
//   1. Bearer comparison is constant-time (timingSafeEqual below), never a
//      plain `!==`.
//   2. Two scopes: the admin token guards onboarding/config/enumeration; the
//      operator token guards per-resident operations. The admin token is a
//      strict superset (valid on operator routes); the operator token is
//      refused on admin routes. Missing/empty secrets grant nothing.
//   3. Caller-supplied `x-env-*` headers are IGNORED on every route — nothing
//      here reads them and no request header is ever forwarded into a
//      resident. The ONLY env the resident itself injects into a command is
//      GIT_TERMINAL_PROMPT=0 (validated through validateEnvNames); GitHub
//      tokens travel via a root-only one-shot credential file, never env and
//      never argv.
//   4. The GitHub App PRIVATE KEY exists only in Worker/DO scope. The
//      container sees nothing but 1-hour installation tokens scoped to the
//      resident's own repo, injected per command. Install/build executions
//      (untrusted repo code) run unprivileged (worker1) and token-free
//      (docs/decisions/0009-residents-second-credential-domain.md).
import {
  getSandbox,
  isDurableObjectCodeUpdateReset,
  OperationInterruptedError,
  ProcessWaitTimeoutError,
  RPCTransportError,
  RuntimeIdentityInactiveError,
  Sandbox,
  StaleProcessHandleError,
} from "@cloudflare/sandbox";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DirectoryBackup, SandboxCommand } from "@cloudflare/sandbox";
import { createExtensionProcessSandbox } from "@cloudflare/sandbox/extensions";
import { DurableObject } from "cloudflare:workers";
import { BASH_TIMEOUT_MAX_MS, BASH_TIMEOUT_MS, clampBashTimeout } from "../../src/execution/bashTimeout.js";
import { selectBindingsToPurge } from "../../src/execution/bindingPurge.js";
import { busyAfterKillReason, planForceDetach } from "../../src/execution/residentDetach.js";
import { parseReadonly, planReadonlyAttach } from "../../src/execution/residentReadonly.js";
import {
  depCacheScript,
  mutableCachePaths,
  mutableCacheSwapScript,
  parseDepCacheScriptOutput,
  planThreadDeps,
  threadDepsMechanism,
  type DepCacheMaterialization,
  type ThreadDepsMechanism,
} from "../../src/execution/residentDepCache.js";
import { parseWorktreeCleanliness, worktreeCleanlinessScript } from "../../src/execution/residentCleanliness.js";
import {
  capBytesFor,
  capWrappedCommand,
  execCapFiles,
  recoverCapturedOutput,
} from "../../src/execution/residentExecWrap.js";
import { shellQuote } from "../../src/execution/shellQuote.js";
import {
  CREDENTIAL_EXPIRY_MARGIN_MS,
  shouldRefreshThreadCredentials,
} from "../../src/execution/residentCredentials.js";
import {
  recordFiring,
  scheduleForCron,
  watchdogFiring,
  type ScheduleFiring,
  type WatchdogSummary,
} from "../../src/core/schedules.js";
import type { ResidentLifecycleState } from "../../src/execution/residentState.js";
import {
  decisivePull,
  effectiveLimits,
  parsePullsBody,
  parseRefListing,
  parseTestOverrides,
  pickEvictionCandidate,
  pullsFate,
  reclaimDecision,
  type EffectiveLimits,
  type RefFate,
  type ReclaimWhy,
  type ResidentView,
  type StoredTestOverrides,
} from "./gc";
import {
  checkoutUpdateCommand,
  classifyRefreshFailure,
  killStaleBuildProcessesCommand,
  nextRefreshDelayS,
  planRefresh,
  RUNTIME_REPLACEMENT_WORDING,
  judgeRestoreProgress,
  planWakeDepsBudget,
  RESTORE_MAX_MS,
  RESTORE_POLL_MS,
  restoreArchivePath,
  withTimeout,
  type RefreshDisk,
  type RestoreSample,
  type RefreshFailure,
  type RefreshOutcome,
} from "../../src/execution/residentRefresh.js";
import {
  DF_FREE_ARGV,
  DISK_FULL_FREE_KIB,
  isDiskFullReason,
  parseDfFreeKiB,
  planDiskFullRecovery,
} from "../../src/execution/residentDisk.js";
import {
  assembleDiskSample,
  checkDiskAdmission,
  DISK_PRESSURE_REASON,
  diskPressureReason,
  duArgv,
  formatDiskGauge,
  formatGiB,
  orderEvictionCandidates,
  type DiskKeepWhy,
  parseDfKiB,
  parseDu,
  rawFreeAfterEviction,
  threadUserCacheCleanArgv,
  type DiskEvictionCandidate,
  type DiskSample,
  type ThreadCostKind,
} from "../../src/execution/residentDiskBudget.js";
import { mirrorNeedsFetch, parseWantSha, wantShaForBinding } from "../../src/execution/residentHead.js";
import { residentText, sanitizeResidentBody } from "../../src/execution/residentText.js";
import {
  abandonedWaitStepResult,
  describeStepFailure,
  stepFailureLog,
  type StepResult,
} from "../../src/execution/residentStepReport.js";
import { createStepTrace, type ResidentStep, type StepTrace } from "../../src/execution/residentStepTrace.js";
import type { ResidentStepLabelKey, ResidentStepName } from "../../src/execution/residentSteps.js";
import { graftResidentSteps } from "../../src/execution/residentTrace.js";
import type { SpanAttrs } from "../../src/core/trace/attrs.js";
import type { Span as TraceSpan } from "../../src/core/trace/types.js";
import { systemClock } from "../../src/core/trace/clock.js";
import { createTracer } from "../../src/core/trace/tracer.js";
import { startAdoptedRoot, workerLogSink } from "../../src/core/trace/workerTrace.js";
import { backupTransferMode } from "../../src/execution/residentBackupTransfer.js";
import {
  extractRestoreScript,
  restoreMountDir,
  unmountAllRestoresScript,
  unmountRestoreScript,
} from "../../src/execution/residentRestoreExtract.js";
import {
  CHECKOUT_SNAPSHOT_EXCLUDES,
  DEPS_BACKUP_KEY_PREFIX,
  DEPS_BACKUP_TTL_S,
  DEPS_STORE_DIR,
  depsBackupStorageKey,
  depsBackupsToDrop,
  depsCompletePath,
  depsEntryPath,
  depsInstallSemaphoreSize,
  depsScratchCloneArgv,
  depsScratchPath,
  depsStagingPath,
  depsHardenScript,
  depsStoreCommitScript,
  depsStoreListScript,
  depsUsedPath,
  NO_LOCKFILE_KEY,
  parseDepsStoreListing,
  planDepsEviction,
  planDepsMaterialization,
} from "../../src/execution/residentDepsStore.js";
import { buildId, injectedBuildStamp } from "../../src/deploy/buildStamp.js";

/** The commit this bundle was built from, injected by the deploy
 *  (`deploy/bin/build-stamp.mjs`; `unknown` when nobody stamped it). Answered
 *  by GET /healthz as `build` so a deploy's edge propagation is provable from
 *  outside without auth, and stamped on test overrides so they die with the
 *  build that set them (gc.ts). Nothing to bump: it follows the tree. */
const BUILD = injectedBuildStamp();
/** The identity stored test overrides are expired against — see `buildId`:
 *  the commit alone cannot tell two builds of one dirty tree apart. */
const BUILD_ID = buildId(BUILD);

// The Worker's own spans (docs/reference/specs/tracing.md item 22): the streamed routes
// (/attach, /exec, /op) are rooted inside the DO where the work is, their
// collector's steps as `resident.<step>` children; every other authenticated
// route is a `resident.fetch` root at the edge. Each joins the bot's trace when
// the request carried one. A `slow` log sink whose filter drops a refusal's line.
const tracer = createTracer({ clock: systemClock });
const traceSinks = [workerLogSink((line) => console.log(line))];
const STREAMED_ROUTES: ReadonlySet<string> = new Set(["/attach", "/exec", "/op"]);

/** One request as the resident's own root: started at its t0, joining the
 *  bot's trace when `traceparent` parses, the collector's steps grafted as
 *  `resident.<step>` children, ended with the one outcome word. */
function emitStepRoot(
  name: "resident.attach" | "resident.op" | "resident.exec" | "resident.refresh",
  t0: number,
  steps: readonly ResidentStep[],
  traceparent: string | undefined,
  outcome: string,
  attrs: SpanAttrs = {},
): void {
  const root = startAdoptedRoot(tracer, name, { sinks: traceSinks, startedAt: t0, traceparent, attrs });
  graftResidentSteps(steps, { parent: root, prefix: "resident", baseAt: t0, clipAt: systemClock() });
  root.end(outcome === "ok" ? "ok" : "error", { outcome });
}

/** The one word a refusal's root carries: what it needed, else `error`. */
function refusalOutcome(err: ThreadErr): string {
  return err.needs ? `needs_${err.needs}` : "error";
}

interface Env {
  RESIDENT: DurableObjectNamespace<ResidentDO>;
  REGISTRY: DurableObjectNamespace<ResidentRegistryDO>;
  BACKUP_BUCKET: R2Bucket;
  // Presigned snapshot transfers (docs/reference/specs/resident-repos.md item 61): with all
  // four present the container moves archive bytes itself over presigned R2
  // URLs and the DO stays out of the data path; any one absent → the SDK's
  // local-bucket mode (the DO pumps the bytes — a 1.16 GB restore exceeds the
  // isolate's memory). Read exactly as `requirePresignedURLSupport` reads them.
  // The first two are wrangler vars; the keys are secrets (secrets.manifest.json).
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  RESIDENT_ADMIN_TOKEN: string;
  RESIDENT_OPERATOR_TOKEN: string;
  /** Optional read-only bearer: GET /residents and the read-only /debug ops
   *  (info, schedules, threads) — for dashboards and humans who need to look,
   *  never to change anything. Unset = no read scope exists. */
  RESIDENT_READ_TOKEN?: string;
  // GitHub App identity for minting installation tokens inside residents
  // (provisioned via `npm run secrets` from deploy/secrets.manifest.json; when
  // unset, clones/fetches run anonymously —
  // fine for public repos — and any explicit mint attempt is a command-level
  // error that never flips lifecycle state).
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // Where the watchdog cron records each firing for the bot's /runs Scheduled
  // panel: the state Worker's base URL (var) + bearer (secret). Optional:
  // unset → the pass still runs, the firing is only logged.
  STATE_WORKER_URL?: string;
  MEMORY_TOKEN?: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard cap on onboarded residents, enforced atomically by the registry DO.
 *  Deliberately BELOW wrangler.jsonc's containers max_instances (10) so an
 *  over-cap onboard is always refused by the registry, never by a platform
 *  scheduling failure. Bump the two together. */
// 6 = the number of repos one team works on concurrently. Past the cap,
// `evictColdest:true` makes room (docs/reference/specs/resident-repos.md item 46).
const RESIDENT_CAP = 6;

/** Container sleep window, passed to every getSandbox() for ResidentDO.
 *  Invariant: REFRESH_INTERVAL_S and the watchdog cron (wrangler.jsonc,
 *  every 10 minutes) MUST both stay SHORTER than this window, so a healthy
 *  resident is re-warmed before the platform can sleep it. Bump together. */
const SLEEP_AFTER = "20m";

/** Refresh alarm cadence (seconds). Each resident DO self-reschedules this
 *  alarm (per-resident alarms own freshness; the sparse cron is only the
 *  watchdog); it doubles as the keep-warm heartbeat, so it must stay below
 *  SLEEP_AFTER. Matches the watchdog cron so a killed chain is re-armed
 *  within one refresh interval. */
const REFRESH_INTERVAL_S = 600;

/** R2 lifetime of snapshot objects. We delete replaced/offboarded snapshots
 *  explicitly (see deleteBackupObjects); the TTL is a leak backstop, and it
 *  must be long — a quiet repo's current snapshot may go unreplaced for
 *  months and MUST still restore (SDK default is only 3 days). */
const SNAPSHOT_TTL_S = 365 * 24 * 60 * 60;

/** Default deadline for a resident to reach "warm" after onboarding.
 *  Containers take a few minutes to provision on first start. */
const DEFAULT_PROVISIONING_TIMEOUT_MS = 5 * 60_000;
const MIN_PROVISIONING_TIMEOUT_MS = 10_000;
const MAX_PROVISIONING_TIMEOUT_MS = 30 * 60_000;

/** Exec budgets. The DO alarm handler has a ~15-minute platform wall clock;
 *  every schedule callback's step budgets are chosen to fit under it. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const GIT_NETWORK_TIMEOUT_MS = 5 * 60_000;
const REFRESH_BUILD_TIMEOUT_MS = 5 * 60_000;
/** The refresh install budget. Twice the build's: a full `npm install` of the
 *  switchboard lockfile takes ~4 min on the resident's 1 vCPU when nothing
 *  else runs, and thread runs (tests, a review's greps) share that vCPU —
 *  under load it crosses 5 min several cycles in a row while the default
 *  branch keeps moving. A timed-out install is worse than a slow one: the cycle's whole
 *  budget is spent and the checkout is left without deps, so the next cycle
 *  starts the same install over. The cycle runs in the background (runs keep
 *  attaching to the last snapshot); the cost of a longer budget is a longer
 *  mirror-lock window, bounded well inside STALE_MIDFLIGHT_MS. */
const REFRESH_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** After `output()`'s wait gives up on a process the supervisor should have
 *  killed at `timeout`, how long to wait for the exit status of OUR kill
 *  before reporting the step without one. */
const KILL_EXIT_WAIT_MS = 10_000;
/** Budget per R2 SNAPSHOT upload. The SDK's createBackup
 *  accepts no timeout or AbortSignal, so each call is raced against this
 *  (withTimeout): a hung upload fails the cycle into the existing degrade
 *  handling with a named error, instead of stranding `refreshing` until the
 *  30-min watchdog. Restores are NOT on this budget any more: a download is
 *  judged by the bytes arriving in its target (restoreWithProgress) —
 *  a fixed budget abandoned a 481 s restore that then completed.
 *  Same class as the other network budgets (observed live transfers run
 *  seconds, recorded in `lastRestore.ms`). */
const R2_TRANSFER_TIMEOUT_MS = 5 * 60_000;

/** On-disk layout inside the resident container (disk is cache, never truth —
 *  DO storage is). Thread worktrees hang off the same mirror; keep these paths stable. */
const MIRROR_DIR = "/workspace/mirror"; // bare mirror, owned by root
const CHECKOUT_DIR = "/workspace/checkout"; // default-branch working tree + deps + build, owned by BUILD_USER
const RESIDENT_STATE_DIR = "/workspace/.resident"; // mode 700 root:root — worker users cannot traverse
const CRED_FILE = `${RESIDENT_STATE_DIR}/git-credentials`; // one-shot token file, deleted after each git command
const READY_MARKER = `${RESIDENT_STATE_DIR}/ready`; // holds the sha the disk was hydrated to
/** Refresh checkpoints: the lockfile key whose install fully completed
 *  into CHECKOUT_DIR/node_modules, and the sha whose build fully completed.
 *  Written as each step lands, removed before the step is redone; the next
 *  cycle reads them (plus the checkout's real HEAD) to skip work the disk
 *  already holds — a DO reset mid-cycle leaves the container disk intact. */
const DEPS_MARKER = `${RESIDENT_STATE_DIR}/deps-key`;
/** The lockfile key an install was STARTED for: written before `install`,
 *  removed once DEPS_MARKER lands. Left behind by a cycle whose install did
 *  not finish, it lets the next cycle resume that install on the partial
 *  tree instead of wiping it (planRefresh). */
const INSTALLING_MARKER = `${RESIDENT_STATE_DIR}/deps-installing`;
const BUILT_MARKER = `${RESIDENT_STATE_DIR}/built`;
const DISK_MARKERS = [READY_MARKER, DEPS_MARKER, INSTALLING_MARKER, BUILT_MARKER];

/** Unprivileged user for default-branch install/build (repo code never
 *  runs as root). worker2..worker17 stay free for the per-thread users. */
const BUILD_USER = "worker1";

/** Per-thread worktrees hang here: one 700 thread dir per threadKey
 *  (owned by that thread's OS user — other thread users cannot even
 *  traverse), one worktree per bound ref beneath it. Disk is cache: a slept
 *  container loses these, and the next attach recreates them. */
const THREADS_DIR = "/workspace/threads";

/** Disposable per-op checkouts hang here: one 700 uuid dir per
 *  in-flight op, owned by a transiently-held pool user, DELETED when the op
 *  completes (success or failure). Ops never touch a thread's attached
 *  worktree. An orphan from a mid-op DO restart dies with the container disk
 *  at the latest (disk is cache). */
const OPS_DIR = "/workspace/ops";

/** The thread-user pool. worker1 is the engine's build user; each
 *  attach allocates one of these to the thread (persisted in the binding)
 *  and every /exec /read /write for that thread runs privilege-dropped as
 *  that user. The pool is released by the inactivity sweep. */
/** Pool of OS users for thread worktrees (worker1 is the build user). Sized
 *  for SIMULTANEOUS runs, not for every thread ever seen: a run returns its
 *  user via /detach when it ends, so the pool only fills when 16 runs on one
 *  repo are genuinely concurrent. Memory, not this list, is the real ceiling
 *  — see the instance_type note in wrangler.jsonc. Must match the useradd loop
 *  in the Dockerfile. */
const THREAD_USERS = Array.from({ length: 16 }, (_, i) => `worker${i + 2}`);

/** Force-detach: after killing the thread user's processes, how long
 *  to wait for the in-flight op counter to drain (polled every
 *  FORCE_DETACH_DRAIN_POLL_MS). The bot bounds the whole `/detach` at 10 s
 *  (`DETACH_TIMEOUT_MS` in src/execution/resident.ts): the kill is a syscall
 *  (milliseconds — its 2 s bound only matters if `run()` itself wedges, and
 *  then the drain cannot succeed either), so kill + drain leaves ~2 s for the
 *  eviction's rm. The worst case can still overshoot the bot's bound, and that
 *  is tolerated: the bot only logs `[release] … failed`, while this DO method
 *  runs to completion regardless (a dropped fetch does not cancel it), so the
 *  user is freed either way. */
const FORCE_DETACH_DRAIN_MS = 6_000;
const FORCE_DETACH_DRAIN_POLL_MS = 250;
const FORCE_DETACH_KILL_TIMEOUT_MS = 2_000;

/** Inactivity eviction: worktrees whose binding lastAttachAt is older than
 *  this many days are removed and their user returned to the pool; the
 *  binding record is KEPT so the next attach recreates with the same
 *  ref. Overridable per resident via the onboard-time `worktreeTtlDays`. */
const WORKTREE_TTL_DAYS_DEFAULT = 7;
/** The sweep self-reschedules hourly (armed by attach when no sweep pends). */
const SWEEP_INTERVAL_S = 60 * 60; // hourly: the sweep is the backstop for trees a run kept (dirty) or never released
/** A live binding whose last attach is older than this AND whose tree is clean
 *  (no uncommitted/unpushed work) is released by the hourly sweep — runs that
 *  ended before /detach existed, or whose release call was lost. Dirty trees
 *  keep to the TTL. */
const CLEAN_IDLE_RELEASE_S = 60 * 60;
/** Slack over SWEEP_INTERVAL_S before a pending sweep row counts as config
 *  drift (armed by older code with a longer interval). A healthy row is due at
 *  most SWEEP_INTERVAL_S out and only gets closer, so this never trips on one. */
const SWEEP_DRIFT_SLACK_S = 5 * 60;
/** Idle sleep: when no thread has attached within this window and no live
 *  tree is dirty, the refresh alarm skips the fetch and re-arms far out so
 *  the container can actually sleep (SLEEP_AFTER); the next attach refreshes
 *  first if the mirror is stale (refresh-on-attach). */
const IDLE_AFTER_S = 60 * 60;
const IDLE_REFRESH_INTERVAL_S = 6 * 60 * 60;
/** LRU eviction floor: an over-cap onboard with `evictColdest:true` may
 *  offboard the coldest eligible warm resident, but never one whose last
 *  activity (attach or provisioning) is younger than this — a repo used
 *  minutes ago must not go cold to make room. Same window as idle sleep. */
const LRU_FLOOR_S = IDLE_AFTER_S;
/** Budget for one GitHub REST call in the reclamation pass (pulls lookup per
 *  live non-default binding); a slow API answers "unknown", never blocks the cycle. */
const GITHUB_API_TIMEOUT_MS = 10_000;
/** A `refreshing`/`restoring` marker older than this with nothing running is
 *  an orphan from an interrupted cycle; the watchdog normalizes it. Comfortably
 *  above the longest legitimate cycle (REFRESH_BUILD_TIMEOUT_MS-scale installs). */
const STALE_MIDFLIGHT_MS = 30 * 60_000;
/** A resident degraded with the SAME reason for this many consecutive cycles
 *  is chronically broken (e.g. the default branch's build fails); retrying
 *  every 10 min bills the container 24/7 for nothing. After the streak it may
 *  idle-park like a warm one; the next attach still refreshes first. */
const DEGRADED_PARK_AFTER_CYCLES = 3;
const DEGRADED_STREAK_KEY = "resident:degradedStreak";
/** Degraded reasons stamped by the WATCHDOG rather than by an attempted refresh
 *  (`watchdogCheck`: `alarm-missed: …`, `stale-mid-flight: …` — both always
 *  carry a `: detail` suffix). They mean "a cycle must run", so they never
 *  count toward the park streak. Deliberate trade-off: a resident that
 *  oscillates between a refresh-produced failure and watchdog stamps (e.g.
 *  `install-failed` → DO eviction → `stale-mid-flight` → `install-failed` …)
 *  keeps resetting the streak and never parks — full 10-min cadence for a
 *  chronically broken repo. Accepted: a watchdog stamp means the previous
 *  "same reason" observation is not trustworthy, and preserving the streak
 *  across it would re-open the parked-degraded hole this fixes. */
/** Plus a cycle whose step was killed from OUTSIDE by a deploy
 *  (`refresh-interrupted: …`, classified by `classifyRefreshFailure`): equally
 *  not evidence about the repository, equally never counted. */
const NON_EVIDENCE_REASON = /^(?:alarm-missed|stale-mid-flight|refresh-interrupted):/;
/** Consecutive cycles that ended `refresh-interrupted`: feeds the
 *  short-re-arm cap in `nextRefreshDelayS`; cleared by any other outcome. */
const INTERRUPTED_STREAK_KEY = "resident:interruptedStreak";
/** When the disk-full recovery last stopped the container (docs/reference/specs/resident-repos.md item 54):
 *  feeds `planDiskFullRecovery`'s cooldown so a working set that refills the
 *  disk is named, not recycled in a loop. */
const DISK_FULL_RECYCLE_KEY = "resident:diskFullRecycleAt";
/** A disk-full attach pulls the refresh cycle this close (seconds) so the
 *  recovery decision runs now, not at the next 600 s alarm. */
const DISK_FULL_REARM_S = 1;
/** The last disk measurement (docs/reference/specs/resident-repos.md item 55; `residentDiskBudget.ts`): one
 *  `df` + one `du` over the parts, taken at the end of every refresh cycle and
 *  (deferred by DISK_MEASURE_DELAY_S, off the hot path) after every attach,
 *  detach and sweep eviction. Surfaced as the live view's `disk`; the attach
 *  admission projects a new tree's cost from its parts. */
const DISK_KEY = "resident:disk";
const DISK_MEASURE_CALLBACK = "onDiskMeasure";
const DISK_MEASURE_DELAY_S = 1;
/** A `du` over a multi-GB checkout plus every live tree is seconds warm, tens
 *  of seconds on a cold page cache — the same class as a git network step. */
const DU_TIMEOUT_MS = GIT_NETWORK_TIMEOUT_MS;
function isNonEvidenceReason(reason: string): boolean {
  return NON_EVIDENCE_REASON.test(reason);
}

/** Attach waits on the mirror mutex under this named timeout; expiry answers
 *  503 {state, reason: "mirror-busy"} instead of queueing forever. */
const ATTACH_MUTEX_WAIT_MS = 60_000;

/** Watchdog auto-rebuild: a resident down with a REHYDRATION-flavored
 *  reason (bad/unreadable snapshots — states only a rebuild can escape, since
 *  down chains never retry hydration) accumulates one strike per watchdog
 *  pass; at N strikes the watchdog triggers the same down→onboarding rebuild
 *  an admin would, discarding the unusable snapshots and reprovisioning from
 *  GitHub. Provision-failure downs never auto-rebuild — they would loop
 *  against the same broken build. With the 10-minute cron, N=3 ≈ 30 minutes
 *  down before the automatic escape hatch fires. */
const AUTO_REBUILD_AFTER_STRIKES = 3;
const REHYDRATION_FAILURE_RE = /^(r2-restore-failed|snapshot-stamp-mismatch|no-snapshot)/;

/** /exec budget: the shared 5-minute default (`BASH_TIMEOUT_MS`);
 *  a caller may raise it per call via the body's `timeoutMs` up to the shared
 *  20-minute ceiling (`BASH_TIMEOUT_MAX_MS`) — clamped server-side by
 *  `clampBashTimeout` in handleExec, never trusting the client's number. The
 *  heartbeat keeps every HTTP hop alive for the whole budget; the ceiling
 *  stays far inside the bot's 45-min run budget. Work beyond 20 minutes
 *  belongs in background jobs.
 *
 *  /op runs (test/build) keep the flat 5-minute budget — the deterministic op
 *  path has no caller-supplied knob, so nothing may stretch it. */
const OP_EXEC_TIMEOUT_MS = BASH_TIMEOUT_MS;
/** Sanity bound on /exec's command body — a guard against a runaway caller,
 *  not a working limit: legitimate agent one-liners (heredocs writing test
 *  files, `node -e` scripts, long pipelines) run well past the old 8 000 and
 *  were refused here while the sandbox/local executors took them fine.
 *  64 000 is far above any sane command yet still tiny beside the route's
 *  content caps (write 512 KB) — real file content belongs in /write. The
 *  bot-side exec wrapper's `( cd <worktree> && …` framing counts against
 *  this bound too, so the agent's effective budget is slightly smaller. */
const MAX_EXEC_COMMAND_LENGTH = 64_000;
/** Output caps, per stream; truncation is annotated in stderr like the
 *  thread-sandbox Worker annotates its timeout note. */
const EXEC_OUTPUT_CAP = 100_000;
const READ_CONTENT_CAP = 262_144;
const MAX_WRITE_CONTENT = 524_288;

/** Files whose COMMITTED content keys the dependency/build cache.
 *  The key hashes `git ls-tree <sha> -- <these>` output from the mirror —
 *  never the working directory, because installs GENERATE lockfiles (npm
 *  writes an uncommitted package-lock.json), which would poison a disk-based
 *  key (this broke the first live wake: stamp e3b0c… vs restored 13e42f…).
 *  A repo committing none of these hashes to the sha256-of-empty constant,
 *  which is a fine (deterministic) key. */
const LOCKFILE_CANDIDATES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "Gemfile.lock",
  "composer.lock",
];

/** Env var names a resident injects must match this before interpolation —
 *  the other half of the x-env hardening above. ALL env injection (today:
 *  only GIT_TERMINAL_PROMPT in gitWithCred) routes through validateEnvNames(). */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export function validateEnvNames(vars: Record<string, string>): void {
  for (const name of Object.keys(vars)) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid env var name ${JSON.stringify(name)}: must match ${ENV_NAME_RE}`);
    }
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The resident runtime (the Sandbox SDK's control session to the container)
 *  was replaced while a command was in flight — in practice a `wrangler deploy`
 *  swapping this DO's isolate mid-run (which otherwise surfaces as a fake
 *  "OOM" on the run). `phase` says where the SDK failed: `"spawn"`
 *  (the start RPC itself; the SDK never proves the process did NOT start) or
 *  `"collect"` (a `StaleProcessHandleError` on an already-running process). In
 *  both cases the command may have run, so the resident never re-issues it;
 *  the thread routes answer the NAMED `runtime-replaced` error and the client
 *  decides (idempotent read/write retry; exec is handed to the model). */
class RuntimeReplacedError extends Error {
  constructor(
    readonly phase: "spawn" | "collect",
    readonly cause: unknown,
  ) {
    super(
      `runtime-replaced: the resident runtime was replaced (a deploy) while this command was ${
        phase === "spawn" ? "starting" : "running"
      }; its output is lost (${errMsg(cause)})`,
    );
    this.name = "RuntimeReplacedError";
  }
}

/** Every wording the pinned SDK (@cloudflare/sandbox@0.13.0-next.751.1) uses
 *  when the runtime incarnation changed under a call, for the message-based
 *  fallback below. Two of these come from classes the SDK does NOT export
 *  (`SandboxLifetimeChangedError`) or throws raw before its adapter translates
 *  them (`RuntimeIdentityInactiveError` at ~10 process/exec sites), so a typed
 *  check alone would miss them. */
// RUNTIME_REPLACEMENT_WORDING lives in src/execution/residentRefresh.ts
// so the refresh classifier and this file's isRuntimeReplacement share ONE
// message-wording list. It carries both "Process supervisor is closed" (the
// spawn-refusal a stopped container answers until it restarts) and
// "The container is not running, consider calling start()" — the raw workerd
// binding refusal a deploy that ROLLS the container (not just swaps the isolate)
// surfaces, which the SDK re-throws untyped when the roll outlasts its own
// port-ready bound. Both take the message fallback below; neither has a typed
// class to match.

/** `err` and its `cause` chain, bounded like the SDK's own `selfAndCauses`
 *  walker: the SDK wraps platform errors, so the telling message can sit one or
 *  two links down. */
function* selfAndCauses(err: unknown): Generator<unknown> {
  let current = err;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    yield current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
}

/** `OperationInterruptedError` reasons that mean the runtime under the call is
 *  gone and a new one serves the thread: a deploy swapped the isolate
 *  (`runtime_replaced`), the sandbox's lifetime epoch moved
 *  (`sandbox_lifetime_changed`), or the container itself stopped/restarted
 *  under the command (`container_stopped`). Deliberately NOT `transport_disposed`
 *  / `sandbox_destroyed` / `recovery_exhausted` — those are not "try the new
 *  runtime", they are real failures the ordinary error path should report — and
 *  NOT `unknown`, the union's catch-all: with no evidence of a replacement the
 *  classifier stays conservative and lets the ordinary path report it. Note the
 *  SDK's process control-plane wrapper (`processCapabilityLifecycle`) collapses
 *  ANY interruption it sees into a `StaleProcessHandleError`, so on that path
 *  the first `instanceof` below fires before this reason set is consulted; the
 *  set matters for the routes that reach the SDK without that wrapper. */
const RUNTIME_REPLACED_REASONS = new Set(["runtime_replaced", "sandbox_lifetime_changed", "container_stopped"]);

/** `RPCTransportError` kinds that mean the capnweb session to the container
 *  died under a live call. The SDK raises these RAW (not as an interruption)
 *  while collecting a process's output — `FencedSubscriptionTarget.next()`
 *  translates with `translateTransportErrorsAsInterruptions: false` — which is
 *  exactly how a container stop/restart mid-command surfaces: the socket dies
 *  before the container can send a structured error. Treating them as a
 *  replacement is safe even for a mere network blip: the consequence is the same
 *  legible outcome (re-attach once to prove the runtime serves the thread; the
 *  command is never re-run; the model re-checks effects). Excluded:
 *  `invalid_frame` / `protocol_error` (wire-format bugs, not a lost runtime) and
 *  `unknown` (no evidence). */
const RPC_TRANSPORT_LOSS_KINDS = new Set(["peer_closed", "connection_failed", "upgrade_failed", "session_disposed"]);

/** Does this SDK error mean the runtime incarnation changed under us? Typed
 *  checks first (`StaleProcessHandleError`, `RuntimeIdentityInactiveError`, an
 *  `OperationInterruptedError` with one of `RUNTIME_REPLACED_REASONS`, an
 *  `RPCTransportError` with one of `RPC_TRANSPORT_LOSS_KINDS`, the platform's
 *  superseded-isolate reset), then the SDK's message wording — on the error AND
 *  its cause chain — as a belt-and-braces fallback. Anything else (a real spawn
 *  failure, a timeout, a wire-format error) is NOT a runtime replacement. */
function isRuntimeReplacement(err: unknown): boolean {
  if (err instanceof StaleProcessHandleError) return true;
  if (err instanceof RuntimeIdentityInactiveError) return true;
  if (err instanceof OperationInterruptedError && RUNTIME_REPLACED_REASONS.has(err.reason)) return true;
  if (err instanceof RPCTransportError && RPC_TRANSPORT_LOSS_KINDS.has(err.kind)) return true;
  if (isDurableObjectCodeUpdateReset(err)) return true;
  for (const link of selfAndCauses(err)) if (RUNTIME_REPLACEMENT_WORDING.test(errMsg(link))) return true;
  return false;
}

/** The named ThreadErr every thread route (exec/read/write) answers for a
 *  runtime replacement, so the client can classify it (409 like the other
 *  recoverable thread states; `reason` is the discriminator). */
function runtimeReplacedErr(err: RuntimeReplacedError): ThreadErr {
  return { error: err.message, status: 409, reason: "runtime-replaced" };
}
/** Trailing slice of one string for an error reason. Command RESULTS are not
 *  described here — `describeStepFailure` owns that, because choosing between
 *  the two streams is what lost a diagnosis (residentStepReport.ts). */
const tail = (s: string, n: number): string => s.trim().slice(-n);

// ---------------------------------------------------------------------------
// GitHub App auth (docs/decisions/0009-residents-second-credential-domain.md)
// — Worker/DO scope only; the private key never
// enters the container. RS256 App JWT on WebCrypto (node:crypto is not
// available here), then POST /app/installations/:id/access_tokens with
// `repositories: [<own repo name>]` so a minted token never grants more than
// the resident's one repo. Cache per slug, but only serve a cached token while
// it has more than `CREDENTIAL_EXPIRY_MARGIN_MS` of life left, so a new
// attach never inherits a near-expiry token minted for an earlier thread.
// ---------------------------------------------------------------------------

export function githubAppConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY);
}

interface MintedToken {
  token: string;
  expiresAtMs: number;
}
const githubTokenCache = new Map<string, MintedToken>(); // key: repo slug ("owner/name")

/** Mint a 1-hour installation token scoped to exactly `slug`'s repository,
 *  returning it with its expiry so callers can persist `expiresAtMs` and refresh
 *  off the token's own life. `fresh` bypasses (and clears) the per-slug
 *  cache — for a token GitHub REJECTED, whose cached copy must not be re-served.
 *  Throws a command-level Error on any failure — callers MUST NOT
 *  translate that into a lifecycle transition. */
export async function mintRepoScopedToken(env: Env, slug: string, opts?: { fresh?: boolean }): Promise<MintedToken> {
  if (!githubAppConfigured(env)) {
    throw new Error(
      "github-app-not-configured: GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY secrets are unset; cannot mint an installation token",
    );
  }
  // A repudiated token must never be re-served: drop the slug's cache entry and
  // mint anew. Otherwise serve a cached token while it has more than the refresh
  // margin left: the same threshold `shouldRefreshThreadCredentials`
  // refreshes at, so a token the cache hands out is never one a fresh attach
  // would immediately have to re-mint. Was 5 min — too little for a 20-minute
  // exec to run under.
  if (opts?.fresh) githubTokenCache.delete(slug);
  const cached = opts?.fresh ? undefined : githubTokenCache.get(slug);
  if (cached && systemClock() < cached.expiresAtMs - CREDENTIAL_EXPIRY_MARGIN_MS) return cached;

  const jwt = await githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  // The installation-token API scopes by repo NAME within the installation's
  // owner — the owner half of the slug is fixed by the installation itself.
  const repoName = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "switchboard-resident",
      },
      body: JSON.stringify({ repositories: [repoName] }),
      // A slow GitHub must not hang attach/refresh. The 10s abort surfaces as a
      // command-level Error (below), never a lifecycle transition.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // AbortSignal.timeout aborts with a "TimeoutError" DOMException; any other
    // fetch throw (network/DNS) lands here too. Both are command-level errors.
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(
      `github-token-mint-failed: ${aborted ? "timed out after 10s contacting api.github.com" : errMsg(err)}`,
      { cause: err },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github-token-mint-failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  const minted: MintedToken = { token: data.token, expiresAtMs: Date.parse(data.expires_at) };
  githubTokenCache.set(slug, minted);
  return minted;
}

/** Short-lived RS256 JWT proving we are the app (max 10 min per GitHub docs).
 *  iat is backdated 60s to absorb clock drift. */
async function githubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(systemClock() / 1000);
  const header = strToB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = strToB64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const key = await importGithubAppKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${bytesToB64url(new Uint8Array(signature))}`;
}

let cachedAppKey: CryptoKey | null = null;
let cachedAppKeyPem = "";
/** Import the App private key. GitHub serves PKCS#1 ("BEGIN RSA PRIVATE KEY")
 *  PEMs; WebCrypto only imports PKCS#8, so PKCS#1 bodies are wrapped in a
 *  PrivateKeyInfo envelope first. Literal "\n" sequences are unescaped (the
 *  usual single-line secret encoding). */
async function importGithubAppKey(pemRaw: string): Promise<CryptoKey> {
  if (cachedAppKey && cachedAppKeyPem === pemRaw) return cachedAppKey;
  const pem = pemRaw.replace(/\\n/g, "\n");
  const der = pemToDer(pem);
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedAppKey = key;
  cachedAppKeyPem = pemRaw;
  return key;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** DER definite-length encoding. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo:
 *  SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 } */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetHeader = [0x04, ...derLength(pkcs1.length)];
  const innerLength = version.length + algId.length + octetHeader.length + pkcs1.length;
  const header = [0x30, ...derLength(innerLength), ...version, ...algId, ...octetHeader];
  const out = new Uint8Array(header.length + pkcs1.length);
  out.set(header);
  out.set(pkcs1, header.length);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const strToB64url = (s: string): string => bytesToB64url(new TextEncoder().encode(s));

// ---------------------------------------------------------------------------
// Lifecycle model (persisted in each ResidentDO)
// ---------------------------------------------------------------------------

// The lifecycle union is shared with the bot's executor selection
// (src/execution/residentState.ts — type-only import, bundled by wrangler), so
// a renamed or added state is a compile error on both sides rather than a
// silently changed attach gate.
type ResidentState = ResidentLifecycleState;
interface ResidentStatus {
  state: ResidentState;
  reason: string; // non-empty whenever state is degraded or down
}

/** Registry record: the onboarded set + command table (writable only via
 *  the admin routes onboard/reconfigure). */
interface ResidentRecord {
  resource: string;
  /** Command table. Always contains "test" and "build"; extra named commands
   *  are allowed ("install" is honored by the provisioning/refresh engine).
   *  Commands execute inside the resident as BUILD_USER — never on the
   *  Worker, never as root, never with a GitHub token in env. */
  commands: Record<string, string>;
  /** Execution profile per command-table entry: the modelless /op
   *  path executes "readonly" entries and refuses "mutating" ones BY NAME.
   *  An absent entry means readonly — test/build/status are readonly by
   *  construction; the refusal is the guard rail for future mutating entries.
   *  Admin-writable only, like `commands` (set via /reconfigure; replaced
   *  whole, never merged). */
  effects?: Record<string, "readonly" | "mutating">;
  defaultRef: string;
  diskBudgetMb?: number;
  provisioningTimeoutMs: number;
  /** Inactivity window (days) before the sweep evicts a thread's worktree
   *  and releases its user; the binding record survives. */
  worktreeTtlDays?: number;
  onboardedAt: string;
  updatedAt: string;
}

/** Per-thread binding: persisted in the resident DO keyed by
 *  threadKey; survives restarts and eviction. `user`/`evicted` describe the
 *  current allocation; `ref` is sticky for the thread's whole life. */
interface ThreadBinding {
  threadKey: string;
  ref: string;
  /** Allocated OS user (worker2..worker17); "" once evicted (pool released). */
  user: string;
  worktreePath: string;
  boundAt: string;
  lastAttachAt: string;
  evicted?: boolean;
  evictedAt?: string;
  /** Why the last eviction happened (the audit trail): `ttl`, `clean-idle`,
   *  `detach`, or a reclamation fate — `merged #N` / `closed #N` / `gone`. */
  evictedWhy?: string;
  /** How deps were last materialized (evidence that the per-branch reconciliation ran). */
  deps?: ThreadDepsMechanism;
  /** Commit the worktree was last attached at (the ref's tip in the mirror
   *  at that moment). Display only — the tree itself is authoritative. */
  sha?: string;
  /** The mode the tree was last built for (item 50): true → no credential
   *  file, origin = the unreadable mirror. An attach in the other mode
   *  recreates the tree. Absent (pre-field bindings) = writable. */
  readonly?: boolean;
  /** Epoch ms when `.git/github-credentials` was last written (attach or the
   *  per-exec refresh). Absent = unknown → the next writable exec re-mints
   *  (`shouldRefreshThreadCredentials`); cleared by a read-only attach. */
  credentialsWrittenAt?: number;
  /** Epoch ms when the written token expires. The per-exec refresh keys
   *  on this — not `credentialsWrittenAt` — so a near-expiry token inherited
   *  from an earlier thread's mint is re-minted before the first writable exec.
   *  Absent (pre-field binding) → the next writable exec falls back to the
   *  `credentialsWrittenAt` file-age rule; cleared alongside it on attach. */
  tokenExpiresAtMs?: number;
  /** The deps-store entry this tree's node_modules is a view of (item 59);
   *  protects the entry from eviction while the binding lives. Absent on a
   *  binding made before the store, or on a tree with no deps. */
  depsKey?: string;
}

/** Named, RPC-cloneable error shape for the thread data plane. The Worker
 *  maps `status` to the HTTP status; extra fields (`needs`, `state`,
 *  `reason`) ride along into the body. */
interface ThreadErr {
  error: string;
  status: number;
  /** The steps the request ran before it failed (docs/reference/specs/tracing.md item 19):
   *  a failed attach's trace is the one that says which step blew the budget. */
  trace?: ResidentStep[];
  needs?: string;
  /** With needs:"ref" — the resident's default branch, so the caller can bind by default. */
  defaultRef?: string;
  state?: ResidentState;
  reason?: string;
}

interface AttachOk {
  workspace: string;
  ref: string;
  sha: string;
  user: string;
  /** True only when a scoped install had to run (lockfile key differed). */
  reconciled: boolean;
  /** True when a dirty/stale/missing worktree was wiped and recreated. */
  recreated: boolean;
  deps: ThreadDepsMechanism;
  /** `ok` — credential file written; `unavailable` — writable attach but no
   *  token (see credentialsError); `none` — read-only attach, deliberately no
   *  credentials and an unfetchable origin (item 50). */
  credentials: "ok" | "unavailable" | "none";
  credentialsError?: string;
  /** Echo of the mode the tree was built for. */
  readonly: boolean;
  mutexWaitMs: number;
  attachMs: number;
  /** Every command this attach ran, as offsets from its start (docs/reference/specs/
   *  tracing.md item 19): the bot grafts them under its attach span. */
  trace: ResidentStep[];
}

/** Result of one /op test/build execution. `ok` is the command's
 *  verdict — a failing test run is a RESULT with ok:false, never an error. */
interface OpRunOk {
  ok: boolean;
  op: string;
  resource: string;
  ref: string;
  sha: string;
  summary: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** dep materialization evidence — shared with the attach mechanism */
  deps: ThreadDepsMechanism;
  reconciled: boolean;
  durationMs: number;
  /** Every command this op ran, as offsets from its start (docs/reference/specs/tracing.md item 19). */
  trace: ResidentStep[];
}

/** DO-recorded repo facts — the truth the disk is rehydrated against. */
interface RepoFacts {
  defaultRef: string; // resolved default branch (configured ref if it exists, else the mirror's HEAD)
  sha: string; // last-fetched default-branch commit
  lockfileHash: string; // dependency/build cache key
  provisionedAt: string;
  lastRefreshAt: string;
  lastRefreshError?: string; // last cycle's failure reason: command-level (e.g. token mint, no lifecycle flip) or the classified reason of a failed/interrupted cycle (survives a concurrent state overwrite); cleared by the next completed cycle
  lastRestore?: { at: string; ms: number }; // proof of restore-not-reclone on the wake path
  /** Set while the resident is in idle mode (refresh alarm parked far out so the container may sleep). */
  idleSince?: string;
}

/** Stamped snapshot record: handles into R2 plus the {ref, sha,
 *  lockfileHash} stamp. Snapshots are written ONLY by onboarding provisioning
 *  and default-branch refresh; restore refuses a mismatched stamp. */
interface SnapshotRecord {
  ref: string;
  sha: string;
  lockfileHash: string;
  createdAt: string;
  mirror: DirectoryBackup; // SDK handle; objects live under backups/<id>/ in BACKUP_BUCKET
  /** Since item 61 PR B the checkout archive EXCLUDES its top-level
   *  node_modules (CHECKOUT_SNAPSHOT_EXCLUDES); the deps come back through the
   *  key's entry backup (DepsBackupRecord) or the installer. Older records
   *  still carry node_modules and are adopted on restore as before. */
  checkout: DirectoryBackup;
}

/** One immutable archive per deps-store entry (docs/reference/specs/resident-repos.md item 61), keyed by
 *  lockfile key under DEPS_BACKUP_KEY_PREFIX. Taken once, right after the
 *  entry is committed; the handle's `dir` is the entry's node_modules, and a
 *  restore overrides `dir` to a scratch tree so the commit script — not the
 *  archive — decides when the entry is complete. */
interface DepsBackupRecord {
  key: string;
  backup: DirectoryBackup;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Registry DO (singleton): onboarded set + config, atomic cap enforcement
// ---------------------------------------------------------------------------

const REGISTRY_KEY_PREFIX = "resident:";
const registryKey = (resource: string) => `${REGISTRY_KEY_PREFIX}${resource}`;
/** Registry-DO key for the admin test overrides (gc.ts `StoredTestOverrides`).
 *  Deliberately OUTSIDE the `resident:` prefix so it never counts as a slot. */
const TEST_OVERRIDES_KEY = "testOverrides";

type OnboardResult = { ok: true; record: ResidentRecord } | { ok: false; status: number; error: string };

export class ResidentRegistryDO extends DurableObject<Env> {
  /** Atomic cap check + insert. Durable Objects deliver events through input
   *  gates: while a storage operation is in flight no other event is delivered
   *  to this object, and nothing below awaits anything except this object's
   *  own storage — so the exists-check, the count, and the insert cannot
   *  interleave with a concurrent onboard. */
  async onboard(record: ResidentRecord): Promise<OnboardResult> {
    const key = registryKey(record.resource);
    if (await this.ctx.storage.get(key)) {
      return { ok: false, status: 409, error: `${record.resource} is already onboarded` };
    }
    const { cap } = await this.limits();
    const existing = await this.ctx.storage.list({ prefix: REGISTRY_KEY_PREFIX });
    if (existing.size >= cap) {
      return {
        ok: false,
        status: 429,
        error: `resident cap reached (${existing.size}/${cap}); offboard a resident first, or onboard with evictColdest:true to make room`,
      };
    }
    await this.ctx.storage.put(key, record);
    return { ok: true, record };
  }

  /** The limits in force: the compiled constants, lowered by a test override
   *  written under THIS build (gc.ts `effectiveLimits`). Read inside the same
   *  input-gated section as the count/insert, so an override flip can never
   *  interleave with an onboard. */
  async limits(): Promise<EffectiveLimits> {
    const stored = await this.ctx.storage.get<StoredTestOverrides>(TEST_OVERRIDES_KEY);
    return effectiveLimits(stored, BUILD_ID, { cap: RESIDENT_CAP, floorS: LRU_FLOOR_S });
  }

  /** Admin-only by construction (reached solely via /debug set-test-overrides,
   *  which is not in READ_DEBUG_OPS). `null` clears. The record is stamped
   *  with the current build so a later deploy ignores it. */
  async setTestOverrides(overrides: { cap?: number; floorS?: number } | null): Promise<EffectiveLimits> {
    if (overrides === null) await this.ctx.storage.delete(TEST_OVERRIDES_KEY);
    else {
      await this.ctx.storage.put(TEST_OVERRIDES_KEY, {
        ...overrides,
        setAt: new Date(systemClock()).toISOString(),
        build: BUILD_ID,
      } satisfies StoredTestOverrides);
    }
    return this.limits();
  }

  /** LRU eviction: release `evict`'s slot and insert `record` in ONE
   *  input-gated section, so the freed slot can never be taken by a
   *  concurrent onboard between the two — the evicted resident is torn down
   *  only after its replacement holds the slot. Refuses (409) if `evict` is
   *  no longer registered (someone offboarded it meanwhile) or `record` is
   *  already onboarded; the cap check is the same as onboard's. */
  async replace(evict: string, record: ResidentRecord): Promise<OnboardResult> {
    if (!(await this.ctx.storage.get(registryKey(evict)))) {
      return { ok: false, status: 409, error: `${evict} is no longer onboarded — nothing to evict` };
    }
    if (await this.ctx.storage.get(registryKey(record.resource))) {
      return { ok: false, status: 409, error: `${record.resource} is already onboarded` };
    }
    const { cap } = await this.limits();
    const existing = await this.ctx.storage.list({ prefix: REGISTRY_KEY_PREFIX });
    if (existing.size - 1 >= cap) {
      return {
        ok: false,
        status: 429,
        error: `resident cap reached (${existing.size}/${cap}) even after evicting ${evict}`,
      };
    }
    await this.ctx.storage.delete(registryKey(evict));
    await this.ctx.storage.put(registryKey(record.resource), record);
    return { ok: true, record };
  }

  async getRecord(resource: string): Promise<ResidentRecord | null> {
    return (await this.ctx.storage.get<ResidentRecord>(registryKey(resource))) ?? null;
  }

  async list(): Promise<ResidentRecord[]> {
    const all = await this.ctx.storage.list<ResidentRecord>({ prefix: REGISTRY_KEY_PREFIX });
    return [...all.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  }

  /** Admin-only by construction: reachable exclusively through /reconfigure.
   *  `commands`, when present, REPLACES the whole command table. */
  async updateConfig(
    resource: string,
    patch: Partial<
      Pick<
        ResidentRecord,
        "commands" | "effects" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs" | "worktreeTtlDays"
      >
    >,
  ): Promise<ResidentRecord | null> {
    const key = registryKey(resource);
    const record = await this.ctx.storage.get<ResidentRecord>(key);
    if (!record) return null;
    const updated: ResidentRecord = { ...record, updatedAt: new Date(systemClock()).toISOString() };
    if (patch.commands !== undefined) updated.commands = patch.commands;
    if (patch.effects !== undefined) updated.effects = patch.effects;
    if (patch.defaultRef !== undefined) updated.defaultRef = patch.defaultRef;
    if (patch.diskBudgetMb !== undefined) updated.diskBudgetMb = patch.diskBudgetMb;
    if (patch.provisioningTimeoutMs !== undefined) updated.provisioningTimeoutMs = patch.provisioningTimeoutMs;
    if (patch.worktreeTtlDays !== undefined) updated.worktreeTtlDays = patch.worktreeTtlDays;
    await this.ctx.storage.put(key, updated);
    return updated;
  }

  async remove(resource: string): Promise<boolean> {
    return this.ctx.storage.delete(registryKey(resource));
  }
}

// ---------------------------------------------------------------------------
// Resident DO: one per resource; Sandbox subclass = one container per resource
// ---------------------------------------------------------------------------

const PROVISIONING_CALLBACK = "onProvisioningDeadline"; // fail-closed deadline
const PROVISION_RUN_CALLBACK = "runProvisioning"; // the actual provisioning work
const REFRESH_CALLBACK = "onRefreshAlarm"; // self-rescheduling freshness chain
const SWEEP_CALLBACK = "onWorktreeSweep"; // hourly worktree inactivity eviction

const STATE_KEY = "resident:state";
const REASON_KEY = "resident:reason";
const RESOURCE_KEY = "resident:resource";
const UPDATED_KEY = "resident:updatedAt";
const FACTS_KEY = "resident:facts";
const SNAPSHOT_KEY = "resident:snapshot";
const DEADLINE_AT_KEY = "resident:provisionDeadlineAt";
const REBUILD_STRIKES_KEY = "resident:rebuildStrikes"; // watchdog auto-rebuild counter

/** Thread bindings live under their own prefix, keyed by threadKey. */
const THREAD_KEY_PREFIX = "thread:";
const threadBindingKey = (threadKey: string) => `${THREAD_KEY_PREFIX}${threadKey}`;

const parentDir = (p: string): string => p.slice(0, p.lastIndexOf("/"));

/** Deterministic per-thread+ref worktree path. Slugs replace anything outside
 *  [A-Za-z0-9._-]; a threadKey-derived hash suffix keeps two keys that slug
 *  identically (e.g. "a:b" vs "a-b") from colliding on disk. */
async function threadWorktreePath(threadKey: string, ref: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(threadKey));
  const hash8 = [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return `${THREADS_DIR}/${slug(threadKey)}-${hash8}/${slug(ref)}`;
}

/** Path confinement for /read and /write: conservative charset, no `..`
 *  segments, and the resolved absolute path must stay under the worktree
 *  root. Symlink tricks past this point are bounded by the OS layer — the
 *  file op itself runs as the thread's unprivileged user. */
export function confineThreadPath(root: string, path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return null;
  const joined = path.startsWith("/") ? path : `${root}/${path}`;
  const segments = joined.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  const resolved = `/${segments.join("/")}`;
  return resolved.startsWith(`${root}/`) ? resolved : null;
}

/** Named mirror-mutex timeout — attach maps this to 503 {reason:"mirror-busy"}. */
class MirrorBusyError extends Error {}

/** Named failure of one engine step; becomes "<step>-flavored" reasons. */
class StepError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown after the resident has ALREADY been transitioned to `down` (reason
 *  persisted); signals callers to stop the refresh chain without re-flipping. */
class ResidentDownError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

export class ResidentDO extends Sandbox<Env> {
  // TIMER RULE: never call ctx.storage.setAlarm/deleteAlarm from lifecycle
  // code — the Container base class owns the DO alarm slot (its sleepAfter
  // machinery and schedule multiplexing live there). All resident timers go
  // through this.schedule()/this.deleteSchedules(), which multiplex onto that
  // alarm safely. (Checked against @cloudflare/containers 0.3.7: the SDK
  // registers no schedule callback names, so ours cannot collide.)

  /** Serializes concurrent hydration attempts within one DO lifetime. Never
   *  used as a "hydrated" flag — the container can sleep while the DO object
   *  survives, so hydration state is always probed from disk. */
  private hydration: Promise<void> | null = null;

  /** The step trace of the request in flight (docs/reference/specs/tracing.md item 19):
   *  `attachThread` and `runOp` each run inside their own collector, so the
   *  commands `runOk` runs and the mirror-lock waits land on the answer that
   *  caused them — never on a concurrent request's. Empty outside a traced
   *  request (a refresh cycle, a watchdog). */
  private readonly stepTrace = new AsyncLocalStorage<StepTrace>();

  private currentSteps(): ResidentStep[] {
    return this.stepTrace.getStore()?.steps() ?? [];
  }

  /** R2 restores this incarnation started and has not seen settle. The SDK's
   *  restoreBackup cannot be cancelled: a restore the wake path gave up on
   *  keeps writing into its target directory, so the next hydrate must not
   *  `rm -rf` that directory until these have settled (otherwise the second
   *  attempt's clean runs over the first attempt's still-filling
   *  checkout). A DO reset drops the set together with the transfers it named:
   *  the restore is driven from this isolate, so nothing outlives it. */
  private readonly pendingRestores = new Set<Promise<unknown>>();

  /** Run one R2 restore and judge it by the bytes arriving in its target
   *  directory (judgeRestoreProgress): the SDK call takes no timeout, progress
   *  callback or AbortSignal, and a fixed budget abandoned a restore that then
   *  completed (481 s against 300 s). While `du` of the target keeps
   *  growing the wait continues; it ends on a stall (no growth for
   *  RESTORE_STALL_MS) or the RESTORE_MAX_MS cap, with the bytes and the timing
   *  in the error. On success the observed size and rate are logged so the
   *  budgets can be revisited from evidence. */
  private async restoreWithProgress(backup: DirectoryBackup, what: string, deadlineMs: number): Promise<void> {
    const startedMs = systemClock();
    const p = this.restoreBackup(backup);
    this.pendingRestores.add(p);
    void p.then(
      () => this.pendingRestores.delete(p),
      () => this.pendingRestores.delete(p),
    );
    const samples: RestoreSample[] = [];
    for (;;) {
      const outcome = await Promise.race([
        p.then(() => "done" as const),
        new Promise<"tick">((r) => setTimeout(() => r("tick"), RESTORE_POLL_MS)),
      ]);
      if (outcome === "done") {
        const ms = systemClock() - startedMs;
        const kiB = await this.dirKiB(backup.dir);
        const rate = kiB !== null && ms > 0 ? ` (${((kiB / 1024 / ms) * 1000).toFixed(1)} MiB/s)` : "";
        const size = kiB === null ? "? GiB (du did not answer)" : `${(kiB / 1_048_576).toFixed(2)} GiB`;
        console.log(`${what}: ${size} in ${Math.round(ms / 1000)} s${rate}`);
        return;
      }
      samples.push({ atMs: systemClock(), kiB: await this.restoreProgressKiB(backup) });
      const verdict = judgeRestoreProgress({ startedMs, nowMs: systemClock(), samples, deadlineMs });
      if (verdict.verdict !== "wait") {
        // The restore itself keeps running (its settle handlers are attached
        // above); pendingRestores keeps the next hydrate off its directory.
        throw new Error(`${what} ${verdict.verdict}: ${verdict.detail}`);
      }
    }
  }

  /** Restore a backup INTO `targetDir` as a plain directory on the resident's
   *  disk (docs/reference/specs/resident-repos.md item 61). In presigned mode the SDK's restore MOUNTS the
   *  archive (squashfuse + fuse-overlayfs) at the handle's `dir` instead of
   *  extracting it, which breaks every step that treats the mirror, checkout
   *  or a store entry as a directory on one ext4 filesystem (
   *  `rm -rf` → Device or resource busy, `chown -R` → a full copy-up, `du -x`
   *  → ~1 MiB, hardlinks and renames across devices). So the handle is
   *  re-pointed at a staging mount beside the target, judged by bytes arriving
   *  like every restore, then `extractRestoreScript` puts a real tree in place
   *  — `unsquashfs` from the downloaded archive, or `cp -a` out of the mount —
   *  unmounts, and renames it in LAST. A failure leaves no half target and no
   *  mount behind. */
  private async restoreExtracted(
    backup: DirectoryBackup,
    targetDir: string,
    what: string,
    /** The extraction's own step name (`<x>-restore-extract`): what the trace and the run page show. */
    step: ResidentStepName,
    deadlineMs: number,
  ): Promise<void> {
    const attempt = crypto.randomUUID().slice(0, 8);
    const mountDir = restoreMountDir(targetDir, attempt);
    try {
      await this.restoreWithProgress({ ...backup, dir: mountDir }, what, deadlineMs);
      const t0 = systemClock();
      const r = await this.runOk(
        [
          "sh",
          "-c",
          extractRestoreScript({
            mountDir,
            backupId: backup.id,
            archivePath: restoreArchivePath(backup.id),
            targetDir,
          }),
        ],
        step,
        { timeoutMs: Math.max(60_000, deadlineMs - systemClock()) },
      );
      console.log(`${what}: ${r.trim() || "extracted"} in ${Math.round((systemClock() - t0) / 1000)} s`);
    } catch (err) {
      // Neither the staging mount nor a partial extraction may outlive the
      // attempt: a later clean would hit "Device or resource busy" on the
      // mount, and a half-extracted tree is multi-GiB debris on a
      // disk-budgeted resident. Best effort — the clean steps sweep both too.
      await this.run(["sh", "-c", unmountRestoreScript({ mountDir, backupId: backup.id })]).catch(() => {});
      await this.run(["rm", "-rf", `${targetDir}.extract-${attempt}`]).catch(() => {});
      throw err;
    }
  }

  /** Where a running restore's bytes actually land, in KiB: the SDK downloads
   *  the whole archive to `/var/backups/<backupId>.sqsh` FIRST and only then
   *  extracts it into the target directory (`downloadBackupParallel` →
   *  `restoreArchive`), so during the download the target stays empty. Judging
   *  the target alone reads 0 for every sample while a 2 GiB archive
   *  downloads, calls the restore stalled at ~2 minutes, and takes the resident
   *  down — a false stall. Summing the archive and the target covers both
   *  phases (the total only ever grows until the SDK deletes the archive,
   *  which the judge's high-water mark ignores). One `du` for both paths;
   *  a path that does not exist yet is simply absent from the output
   *  (`parseDu` skips du's error lines), and no readable path at all is null. */
  private async restoreProgressKiB(backup: DirectoryBackup): Promise<number | null> {
    const r = await this.run(["du", "-xsk", restoreArchivePath(backup.id), backup.dir]);
    const parsed = parseDu(r.stdout);
    if (parsed.size === 0) return null;
    let total = 0;
    for (const kiB of parsed.values()) total += kiB;
    return total;
  }

  /** `du -xsk <dir>` in KiB (the success line's size and rate); null when the
   *  directory is not there or du could not answer — never 0. */
  private async dirKiB(dir: string): Promise<number | null> {
    const r = await this.run(["du", "-xsk", dir]);
    if (r.exitCode !== 0) return null;
    const m = /^(\d+)\s/.exec(r.stdout.trim());
    return m ? Number(m[1]) : null;
  }

  // -- per-incarnation memos ---------------------------------------------------
  // Facts about the CURRENT container incarnation that are expensive to
  // re-derive (a storage multi-get + a runtime probe + a container fork for
  // hydration; a fork rewriting /etc/gitconfig for git setup; a fork creating
  // a per-user staging dir) and were, before these memos, re-derived on EVERY
  // /exec /read /write — the hottest path in the system. Safe to memoize
  // because every way the fact can stop being true is observable and clears
  // the memos: a runtime replacement surfaces as RuntimeReplacedError at the
  // ONE exec choke point (`run()`), a deliberate stop/teardown/rebuild calls
  // `clearIncarnationMemos()` at its site, every lifecycle transition
  // (`setResidentState`) clears too, and a sleep cannot race the TTL — the
  // container sleeps only after SLEEP_AFTER (20 min) of idleness, while the
  // hydration memo lives `hydrationMemoTtlMs` (60 s) past the last activity
  // that set it. Storage stays the truth: the memo caches a verdict PROBED from
  // disk, never assumes one.
  private hydratedVerdictAt = 0;
  private readonly hydrationMemoTtlMs = 60_000;
  private gitSetupDone = false;
  private stageDirsReady = new Set<string>();

  private clearIncarnationMemos(): void {
    this.hydratedVerdictAt = 0;
    this.gitSetupDone = false;
    this.stageDirsReady.clear();
    this.depsStoreDirReady = false;
    this.depsInstallSlots = null;
  }

  /** Mirror mutex: a DO yields at every await, so two in-flight
   *  requests CAN interleave mid-handler — every mirror mutation (fetch,
   *  worktree add/remove) runs under this explicit promise-chain lock. The
   *  chain lives in DO memory only; that is sufficient because all mirror
   *  work happens through this one DO instance, and a DO restart also drops
   *  any in-flight work the lock was guarding. */
  private mirrorLockTail: Promise<void> = Promise.resolve();

  /** Run `fn` holding the mirror mutex. With waitTimeoutMs > 0, gives up
   *  waiting after that long (throws MirrorBusyError) — the queued slot is
   *  released so later waiters are not stuck behind a ghost. */
  private async withMirrorLock<T>(fn: () => Promise<T>, waitTimeoutMs = 0): Promise<{ value: T; waitedMs: number }> {
    const prev = this.mirrorLockTail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => (release = resolve));
    // Chain synchronously (no await between read and write) so queue order is
    // exactly arrival order within the DO's single-threaded event loop.
    this.mirrorLockTail = prev.then(
      () => slot,
      () => slot,
    );
    const started = systemClock();
    if (waitTimeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        prev.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), waitTimeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        release(); // our slot becomes a no-op; the queue keeps moving
        throw new MirrorBusyError(`mirror-busy: mutex not acquired within ${waitTimeoutMs}ms`);
      }
    } else {
      await prev.catch(() => {});
    }
    const waitedMs = systemClock() - started;
    this.stepTrace.getStore()?.mutexWait(waitedMs, systemClock());
    try {
      return { value: await fn(), waitedMs };
    } finally {
      release();
    }
  }

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
  }

  // -- exec plumbing ---------------------------------------------------------

  /** Server-side exec-and-collect. Inside the DO, Sandbox.exec() returns a raw
   *  RPC descriptor; createExtensionProcessSandbox wraps it back into the
   *  waitable SandboxProcess surface (output/waitForExit). */
  private async run(
    argv: readonly string[],
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const timeout = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const launch = {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      timeout,
    };
    // Two phases, because a runtime replacement (a deploy mid-command) means
    // different things in each. Spawn: the start RPC failed. The SDK marks the
    // interruption `retryable` only when it vouches the process never started
    // (e.g. the container was still starting) — then, and only then, one retry
    // on a fresh process sandbox is safe. Collect: the process handle is stale,
    // so the command DID start and its output is gone — never re-run it. Both
    // unsafe cases surface as RuntimeReplacedError for the routes to name.
    let proc: Awaited<ReturnType<ReturnType<typeof createExtensionProcessSandbox>["exec"]>>;
    try {
      proc = await createExtensionProcessSandbox(this).exec(argv as unknown as SandboxCommand, launch);
    } catch (err) {
      if (!isRuntimeReplacement(err)) throw err;
      // Forward-looking gate, structurally unreachable today: in the pinned SDK
      // (@cloudflare/sandbox@0.13.0-next.751.1) every `reason:"runtime_replaced"`
      // site hardcodes `retryable:false`, so a replacement currently always
      // takes the throw below. It exists so that if a future SDK vouches "never
      // started" we retry then — and only then — without a change here.
      if (!(err instanceof OperationInterruptedError && err.retryable === true)) {
        this.clearIncarnationMemos(); // the container this incarnation's memos described is gone
        throw new RuntimeReplacedError("spawn", err);
      }
      console.log(
        `exec: runtime replaced before the process started (SDK says retryable) — retrying once: ${errMsg(err)}`,
      );
      proc = await createExtensionProcessSandbox(this).exec(argv as unknown as SandboxCommand, launch);
    }
    try {
      const out = await proc.output({ encoding: "utf8", timeout: timeout + 30_000 });
      return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, timedOut: out.timedOut };
    } catch (err) {
      if (isRuntimeReplacement(err)) {
        this.clearIncarnationMemos(); // the container this incarnation's memos described is gone
        throw new RuntimeReplacedError("collect", err);
      }
      if (err instanceof ProcessWaitTimeoutError) {
        // The supervisor should have killed the process at `timeout`; 30 s
        // later it still had not exited (a starved container kills late).
        // Rejecting here would abandon a LIVE process — an `npm install`
        // keeps extracting into the checkout while the next cycle's
        // `git clean -fdx` runs over it (`Directory not empty`) and the
        // resident spirals. Kill it, then report the step's own timeout.
        let exitCode: number | null = null;
        try {
          await proc.kill(9);
          exitCode = (await proc.waitForExit({ timeout: KILL_EXIT_WAIT_MS })).code;
        } catch {
          // no exit observed within the wait: the report says so
        }
        console.log(
          `exec: ${argv.join(" ").slice(0, 200)} outlived its ${timeout}ms budget — killed (exit ${exitCode ?? "unobserved"})`,
        );
        return abandonedWaitStepResult({ detail: errMsg(err), exitCode });
      }
      throw err;
    }
  }

  /** Shared success gate for run/threadRun results: a non-zero exit or a
   *  timeout becomes the step's named StepError; success hands back stdout. */
  private assertOk(r: StepResult, step: string): string {
    if (r.exitCode !== 0 || r.timedOut) {
      // The stored reason has room for a tail of each stream; the log gets the
      // error block itself, because a reason nobody can act on is how a whole
      // diagnosis was lost once (residentStepReport.ts).
      console.log(stepFailureLog(step, r));
      throw new StepError(step, describeStepFailure(r));
    }
    return r.stdout;
  }

  private async runOk(
    argv: readonly string[],
    step: ResidentStepName,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    const startedAt = systemClock();
    const r = await this.run(argv, opts);
    // The step's own measurement, on the request's trace when one is in flight.
    this.stepTrace
      .getStore()
      ?.record(step, { startedAt, endedAt: systemClock(), exitCode: r.exitCode, timedOut: r.timedOut });
    return this.assertOk(r, step);
  }

  /** Run one command-table entry as the unprivileged build user in the warm
   *  checkout. Never root. Never a GitHub token — the env
   *  is whatever `su` grants the target user, nothing injected. */
  private async buildUserRun(command: string, step: ResidentStepLabelKey, timeoutMs: number): Promise<string> {
    // Steps on the checkout are sequential, so a live build-user process
    // INSIDE it here is a leftover (a step whose wait was abandoned, or one
    // orphaned by a Worker-only deploy resetting the DO) — and it is writing
    // into the tree this step is about to clean or build. Scoped to the
    // checkout: the same user's deps-store installs run in their own scratch
    // trees, in parallel, and are live work (killStaleBuildProcessesCommand).
    const swept = await this.runOk(killStaleBuildProcessesCommand(BUILD_USER, CHECKOUT_DIR), `${step}-stale-sweep`);
    if (swept.trim()) console.log(`${step}: ${swept.trim()}`);
    return this.runOk(["su", "-s", "/bin/bash", BUILD_USER, "-c", `cd ${CHECKOUT_DIR} && ${command}`], step, {
      timeoutMs,
    });
  }

  /** Run a git command with an optional repo-scoped token, injected via a
   *  one-shot credential file under the root-only state dir — never
   *  process-wide env, never argv (which every user could read from the
   *  shared process list). The leading `credential.helper=`
   *  clears inherited helpers (the image configures gh's). */
  private async gitWithCred(
    token: string | null,
    gitArgs: readonly string[],
    step: ResidentStepName,
    timeoutMs: number,
  ): Promise<string> {
    const injected = { GIT_TERMINAL_PROMPT: "0" }; // fail fast instead of prompting
    validateEnvNames(injected);
    if (!token) {
      return this.runOk(["git", "-c", "credential.helper=", ...gitArgs], step, { timeoutMs, env: injected });
    }
    await this.writeFile(CRED_FILE, `https://x-access-token:${token}@github.com\n`);
    try {
      return await this.runOk(
        ["git", "-c", "credential.helper=", "-c", `credential.helper=store --file=${CRED_FILE}`, ...gitArgs],
        step,
        { timeoutMs, env: injected },
      );
    } finally {
      try {
        await this.deleteFile(CRED_FILE);
      } catch {
        // one-shot file inside the 700 root-only dir; deletion is best-effort
      }
    }
  }

  // -- repo helpers ----------------------------------------------------------

  /** Idempotent container-local setup that must survive every fresh disk:
   *  the root-only state dir, and a scoped safe.directory entry so worker
   *  users can fetch from the root-owned mirror without git's
   *  dubious-ownership refusal (scoped to the mirror — NOT '*'). */
  private async ensureGitSetup(): Promise<void> {
    // Memoized per incarnation: this used to be three container forks
    // (rewriting /etc/gitconfig among them) on EVERY attach and /op — inside
    // the mirror mutex, extending every peer's wait. One fork now, and only
    // when the incarnation hasn't run it yet (cleared with the other memos).
    if (this.gitSetupDone) return;
    // Thread isolation (the chown/chmod half): thread users must not read the
    // mirror directly (its config/refs are engine plumbing; repo content
    // reaches threads only through their own worktrees). worker1 still needs
    // read access — the warm checkout fetches from the mirror during refresh —
    // so the mirror top dir is root:worker1 750, denying worker2..worker17 at
    // traversal. Conditional: the dir does not exist before provisioning's
    // clone creates it (runProvisioning re-runs this right after the clone).
    await this.runOk(
      [
        "sh",
        "-c",
        `install -d -m 700 -o root -g root ${RESIDENT_STATE_DIR} && ` +
          `git config --system safe.directory ${MIRROR_DIR} && ` +
          `if [ -d ${MIRROR_DIR} ]; then chown root:${BUILD_USER} ${MIRROR_DIR} && chmod 750 ${MIRROR_DIR}; fi`,
      ],
      "git-setup",
    );
    this.gitSetupDone = true;
  }

  private async refExists(ref: string): Promise<boolean> {
    const r = await this.run(["git", "-C", MIRROR_DIR, "show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
    return r.exitCode === 0;
  }

  private async readMirrorSha(ref: string): Promise<string> {
    return (
      await this.runOk(["git", "-C", MIRROR_DIR, "rev-parse", "--verify", `refs/heads/${ref}`], "rev-parse")
    ).trim();
  }

  /** Attach's fetch decision (item 51) over the mirror's actual state: the ref
   *  is missing, or `wantSha` names a commit the ref's tip is not at. The
   *  decision itself is the pure, tested `mirrorNeedsFetch`. */
  private async mirrorNeedsFetchFor(ref: string, wantSha: string | null): Promise<boolean> {
    const refExists = await this.refExists(ref);
    const mirrorSha = refExists && wantSha !== null ? await this.readMirrorSha(ref) : undefined;
    return mirrorNeedsFetch({ refExists, mirrorSha, wantSha });
  }

  /** Dependency/build cache key: sha256 over the ls-tree lines (mode,
   *  blob oid, name) of the lockfile candidates AS COMMITTED at `sha` in the
   *  bare mirror. Fully determined by the commit — generated/uncommitted
   *  lockfiles on disk can never shift it. */
  private async lockfileKey(sha: string): Promise<string> {
    const script = `git -C ${MIRROR_DIR} ls-tree ${sha} -- ${LOCKFILE_CANDIDATES.join(" ")} | sha256sum | cut -d" " -f1`;
    return (await this.runOk(["sh", "-c", script], "lockfile-key")).trim();
  }

  /** True when the disk already holds exactly what the snapshot stamp says. */
  private async diskMatches(sha: string): Promise<boolean> {
    const r = await this.run([
      "sh",
      "-c",
      `test -d ${MIRROR_DIR}/objects && test -d ${CHECKOUT_DIR}/.git && cat ${READY_MARKER} 2>/dev/null || echo __absent__`,
    ]);
    return r.exitCode === 0 && r.stdout.trim() === sha;
  }

  /** Write the disk markers that a materialized checkout leaves behind (see
   *  DEPS_MARKER/BUILT_MARKER); omitted fields are left as they are. */
  private async writeDiskMarkers(m: {
    ready?: string;
    depsKey?: string;
    installingKey?: string;
    builtSha?: string;
  }): Promise<void> {
    if (m.ready !== undefined) await this.writeFile(READY_MARKER, `${m.ready}\n`);
    if (m.depsKey !== undefined) await this.writeFile(DEPS_MARKER, `${m.depsKey}\n`);
    if (m.installingKey !== undefined) await this.writeFile(INSTALLING_MARKER, `${m.installingKey}\n`);
    if (m.builtSha !== undefined) await this.writeFile(BUILT_MARKER, `${m.builtSha}\n`);
  }

  /** What the checkout actually holds, for the refresh planner: its HEAD (read
   *  as the build user — the tree is worker1-owned and git refuses dubious
   *  ownership from root) and the two refresh checkpoints. Anything unreadable
   *  is null, which the planner treats as "redo that step". */
  private async readRefreshDisk(): Promise<RefreshDisk> {
    // Each fact is emitted on its own tagged line, so parsing keys on the tag
    // rather than line position (a su/PAM banner cannot shift a field).
    const script = [
      `echo "head=$(su -s /bin/bash ${BUILD_USER} -c 'git -C ${CHECKOUT_DIR} rev-parse --verify HEAD' 2>/dev/null)"`,
      `echo "deps=$(cat ${DEPS_MARKER} 2>/dev/null)"`,
      `echo "installing=$(cat ${INSTALLING_MARKER} 2>/dev/null)"`,
      `echo "built=$(cat ${BUILT_MARKER} 2>/dev/null)"`,
    ].join("; ");
    const r = await this.run(["sh", "-c", script]);
    const fields = new Map<string, string>();
    if (r.exitCode === 0) {
      for (const line of r.stdout.split("\n")) {
        const m = /^(head|deps|installing|built)=(.*)$/.exec(line.trim());
        if (m) fields.set(m[1], m[2].trim());
      }
    }
    const get = (tag: string) => fields.get(tag) || null;
    return { head: get("head"), installedKey: get("deps"), installingKey: get("installing"), builtSha: get("built") };
  }

  /** Snapshot mirror + checkout to R2 (localBucket: the SDK resolves the
   *  BACKUP_BUCKET binding from this DO's env; objects land under
   *  backups/<uuid>/). gitignore stays false: node_modules and build output
   *  in the checkout ARE the cache being persisted. The pair runs
   *  concurrently — disjoint directories, independent uploads — and each is
   *  bounded by R2_TRANSFER_TIMEOUT_MS: a hang becomes this
   *  StepError, which the cycle's existing failure handling degrades with
   *  the step named. */
  private async takeSnapshot(
    resource: string,
    ref: string,
    sha: string,
    lockfileHash: string,
  ): Promise<SnapshotRecord> {
    try {
      // Presigned transfers when the env allows (docs/reference/specs/resident-repos.md item 61) — the
      // container moves the bytes, the DO only signs — else the SDK's
      // local-bucket mode (the DO in the data path). The handle records the
      // mode, so the restore of THIS snapshot travels the same way.
      const { localBucket, mode, missing } = backupTransferMode(this.env as unknown as Record<string, unknown>);
      if (mode === "local")
        console.log(`snapshot: local-bucket transfer (presigned env missing: ${missing.join(", ")})`);
      const [mirror, checkout] = await Promise.all([
        withTimeout(
          this.createBackup({ dir: MIRROR_DIR, localBucket, ttl: SNAPSHOT_TTL_S, name: `${resource} mirror` }),
          R2_TRANSFER_TIMEOUT_MS,
          "mirror backup",
        ),
        withTimeout(
          this.createBackup({
            dir: CHECKOUT_DIR,
            localBucket,
            ttl: SNAPSHOT_TTL_S,
            name: `${resource} checkout`,
            // The tree without its deps view (item 61 PR B): the store entry
            // has its own archive, so a refresh cycle stops re-uploading
            // node_modules and the wake restores the key's entry instead.
            excludes: [...CHECKOUT_SNAPSHOT_EXCLUDES],
          }),
          R2_TRANSFER_TIMEOUT_MS,
          "checkout backup",
        ),
      ]);
      return { ref, sha, lockfileHash, createdAt: new Date(systemClock()).toISOString(), mirror, checkout };
    } catch (err) {
      throw new StepError("snapshot", errMsg(err));
    }
  }

  /** Delete the R2 objects behind SDK backup handles (backups/<id>/ lives
   *  OUTSIDE the resident/<resource>/ prefix, so offboard's prefix sweep
   *  cannot reach it — this is the only cleanup path). The ids' prefixes are
   *  disjoint, so the sweeps run concurrently. */
  private async deleteBackupObjects(ids: string[]): Promise<number> {
    const deleted = await Promise.all(ids.map((id) => deleteR2Prefix(this.env.BACKUP_BUCKET, `backups/${id}/`)));
    return deleted.reduce((a, n) => a + n, 0);
  }

  /** Count (never delete) the R2 objects behind SDK backup handles — the
   *  read-only twin of deleteBackupObjects, for the dry-run itemizations. */
  private async countBackupObjects(ids: string[]): Promise<number> {
    const counts = await Promise.all(ids.map((id) => countR2Prefix(this.env.BACKUP_BUCKET, `backups/${id}/`)));
    return counts.reduce((a, n) => a + n, 0);
  }

  private async armRefresh(resource: string, intervalS = REFRESH_INTERVAL_S): Promise<void> {
    this.deleteSchedules(REFRESH_CALLBACK); // at most one pending refresh
    await this.schedule(intervalS, REFRESH_CALLBACK, resource);
  }

  /** Persist `down` with a reason, stop the refresh chain, and hand back the
   *  error that tells callers the transition already happened. */
  private async goDown(reason: string): Promise<ResidentDownError> {
    await this.setResidentState("down", reason);
    this.deleteSchedules(REFRESH_CALLBACK);
    return new ResidentDownError(reason);
  }

  private async recordRefreshError(message: string): Promise<void> {
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (facts) await this.ctx.storage.put(FACTS_KEY, { ...facts, lastRefreshError: residentText(message) });
  }

  // -- onboarding ------------------------------------------------------------

  /** Called once per onboard: persist the initial lifecycle state and arm BOTH
   *  the provisioning work and its fail-closed deadline. Does NOT start the
   *  container — onboard must return immediately; the container first starts
   *  when runProvisioning's schedule fires (~1s later). */
  async initResident(resource: string, provisioningTimeoutMs: number): Promise<ResidentStatus> {
    await this.ctx.storage.put({
      [RESOURCE_KEY]: resource,
      [STATE_KEY]: "onboarding" satisfies ResidentState,
      [REASON_KEY]: "",
      [UPDATED_KEY]: new Date(systemClock()).toISOString(),
      [DEADLINE_AT_KEY]: systemClock() + provisioningTimeoutMs,
    });
    await this.ctx.storage.delete([FACTS_KEY, SNAPSHOT_KEY]); // defensive: no stale facts from a past life
    this.deleteSchedules(PROVISIONING_CALLBACK);
    this.deleteSchedules(PROVISION_RUN_CALLBACK);
    this.deleteSchedules(REFRESH_CALLBACK);
    await this.schedule(Math.max(1, Math.ceil(provisioningTimeoutMs / 1000)), PROVISIONING_CALLBACK, resource);
    await this.schedule(1, PROVISION_RUN_CALLBACK, resource);
    return { state: "onboarding", reason: "" };
  }

  /** The provisioning engine (alarm-driven): clone bare mirror → resolve the
   *  default branch → full install + build in a working checkout using the
   *  onboard-time command table → stamped snapshot → record facts → warm.
   *  On failure: down(provision-failed at <step>) — the registry slot is
   *  deliberately KEPT so /status shows the named reason (only a stuck
   *  onboarding releases the slot, via the deadline/watchdog). */
  async runProvisioning(payload: string): Promise<void> {
    const resource = payload || ((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") return; // stale schedule
    try {
      const record = await this.registry().getRecord(resource);
      if (!record) throw new StepError("registry", "registry record missing (offboarded mid-onboard?)");
      const slug = resource.slice("repo:".length);
      const stepBudget = record.provisioningTimeoutMs;

      // A mint failure is command-level — fall back to an anonymous
      // clone (works for public repos); a private repo then fails AT CLONE
      // with the real, named signal.
      let token: string | null = null;
      if (githubAppConfigured(this.env)) {
        try {
          token = (await mintRepoScopedToken(this.env, slug)).token;
        } catch (err) {
          console.log(
            `provisioning ${resource}: token mint failed (command-level), trying anonymous clone: ${errMsg(err)}`,
          );
        }
      }

      // A restore an earlier hydrate gave up on may still be writing into these
      // directories (the SDK call cannot be cancelled, and a rebuild is
      // exactly what follows a restore that went `down`). The hydrate path
      // waits for `pendingRestores` before its clean; provisioning must too, or
      // the clone races a writer. Bounded like the hydrate's wait; a stream
      // that will not settle even then fails the provision with the wait
      // named, never a clone over a moving target.
      if (this.pendingRestores.size > 0) {
        const n = this.pendingRestores.size;
        await withTimeout(
          Promise.allSettled([...this.pendingRestores]),
          RESTORE_MAX_MS,
          `${n} earlier restore(s) still running before the clean`,
        ).catch((err) => {
          throw new StepError("await-restores", errMsg(err));
        });
      }
      await this.runOk(["sh", "-c", unmountAllRestoresScript()], "unmount-restores");
      await this.runOk(["rm", "-rf", MIRROR_DIR, CHECKOUT_DIR, ...DISK_MARKERS], "clean-workspace");
      await this.ensureGitSetup();
      await this.withMirrorLock(() =>
        this.gitWithCred(
          token,
          ["clone", "--mirror", `https://github.com/${slug}.git`, MIRROR_DIR],
          "clone",
          stepBudget,
        ),
      );
      await this.ensureGitSetup(); // the clone just created MIRROR_DIR — lock its perms down

      // Resolve the default branch: the configured ref when it exists, else
      // the mirror's HEAD (what GitHub reports as the default branch).
      let ref = record.defaultRef;
      if (!(await this.refExists(ref))) {
        ref = (
          await this.runOk(["git", "-C", MIRROR_DIR, "symbolic-ref", "--short", "HEAD"], "detect-default-branch")
        ).trim();
        if (!(await this.refExists(ref))) {
          throw new StepError(
            "detect-default-branch",
            `neither configured ref "${record.defaultRef}" nor detected HEAD "${ref}" exists in the mirror`,
          );
        }
      }
      const sha = await this.readMirrorSha(ref);
      const lockfileHash = await this.lockfileKey(sha);

      await this.runOk(["git", "clone", "--branch", ref, MIRROR_DIR, CHECKOUT_DIR], "checkout-clone", {
        timeoutMs: stepBudget,
      });
      await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, CHECKOUT_DIR], "chown");

      // Deps into the store (item 59), the checkout a hardlink view of the
      // entry; then the build, unprivileged and token-free. The
      // install budget is at least the refresh's: a provisioning budget below
      // a real install time just fails the onboarding.
      if (record.commands.install) {
        const entry = await this.materializeDeps(
          lockfileHash,
          sha,
          record.commands.install,
          Math.max(stepBudget, REFRESH_INSTALL_TIMEOUT_MS),
        );
        await this.linkDepsView(`${entry}/node_modules`, CHECKOUT_DIR, BUILD_USER);
      }
      await this.buildUserRun(record.commands.build, "build", stepBudget);

      const snap = await this.takeSnapshot(resource, ref, sha, lockfileHash);

      // The deadline may have fired mid-provision (down + slot released);
      // never flip a non-onboarding resident to warm from here.
      if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") {
        await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]).catch(() => {});
        return;
      }
      const now = new Date(systemClock()).toISOString();
      const facts: RepoFacts = { defaultRef: ref, sha, lockfileHash, provisionedAt: now, lastRefreshAt: now };
      await this.ctx.storage.put({ [FACTS_KEY]: facts, [SNAPSHOT_KEY]: snap });
      await this.writeDiskMarkers({ ready: sha, depsKey: lockfileHash, builtSha: sha });
      this.deleteSchedules(PROVISIONING_CALLBACK);
      await this.setResidentState("warm");
      await this.armRefresh(resource);
    } catch (err) {
      if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") return;
      this.deleteSchedules(PROVISIONING_CALLBACK);
      const reason =
        err instanceof StepError
          ? `provision-failed at ${err.step}: ${err.message}`
          : `provision-failed: ${errMsg(err)}`;
      await this.setResidentState("down", reason);
    }
  }

  /** Fail-closed deadline (armed at onboard): a resident still `onboarding`
   *  when this fires is stuck → down(provision-timeout) and the cap slot is
   *  released. The watchdog is the backstop when this schedule itself
   *  died. */
  async onProvisioningDeadline(_payload: string): Promise<void> {
    const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
    if (state !== "onboarding") return;
    await this.provisionTimedOut("provision-timeout: provisioning did not reach warm within its budget");
  }

  private async provisionTimedOut(reason: string): Promise<void> {
    await this.setResidentState("down", reason);
    this.deleteSchedules(PROVISIONING_CALLBACK);
    this.deleteSchedules(PROVISION_RUN_CALLBACK);
    this.deleteSchedules(REFRESH_CALLBACK);
    const resource = await this.ctx.storage.get<string>(RESOURCE_KEY);
    if (resource) {
      try {
        await this.registry().remove(resource); // release the cap slot
      } catch {
        // the Worker-side watchdog also removes on "provision-timed-out"
      }
    }
  }

  // -- wake path (rehydration: storage is truth, the disk is a cache) ----------

  /** Ensure the container disk holds the stamped snapshot state. `restoring`
   *  is persisted BEFORE any restore work — DO storage would
   *  otherwise still say warm while the R2 restore runs. Refuses mismatched
   *  stamps → down(snapshot-stamp-mismatch); restore failures →
   *  down(r2-restore-failed). Throws ResidentDownError after those
   *  transitions. Called by the refresh alarm (and the attach path). */
  async ensureHydrated(): Promise<void> {
    // Fresh positive verdict for this incarnation → nothing to probe. See the
    // per-incarnation memo block for why this is safe; the refresh alarm's
    // 10-min cadence always outlives the TTL, so a cycle re-probes for real.
    if (this.hydratedVerdictAt !== 0 && systemClock() - this.hydratedVerdictAt < this.hydrationMemoTtlMs) return;
    if (this.hydration) return this.hydration;
    const p = this.doHydrate()
      .then(() => {
        this.hydratedVerdictAt = systemClock();
      })
      .finally(() => {
        if (this.hydration === p) this.hydration = null;
      });
    this.hydration = p;
    this.hydrationStartedAt = systemClock();
    return p;
  }

  /** When the in-flight hydration began — lets the watchdog distinguish a
   *  restore that is genuinely running from one whose promise will never
   *  settle (an SDK call hung on a container that was replaced under it).
   *  Only meaningful while `this.hydration` is non-null. */
  private hydrationStartedAt = 0;

  private async doHydrate(): Promise<void> {
    // One storage round trip for the three facts, not three.
    const stored = await this.ctx.storage.get<ResidentState | SnapshotRecord | RepoFacts>([
      STATE_KEY,
      SNAPSHOT_KEY,
      FACTS_KEY,
    ]);
    const state = stored.get(STATE_KEY) as ResidentState | undefined;
    if (!state || state === "onboarding") throw new Error("resident is not provisioned yet — nothing to hydrate");
    const snap = stored.get(SNAPSHOT_KEY) as SnapshotRecord | undefined;
    const facts = stored.get(FACTS_KEY) as RepoFacts | undefined;
    if (!snap || !facts) {
      throw await this.goDown("no-snapshot: resident has no recorded snapshot to rehydrate from");
    }
    // DO-side stamp consistency (storage is truth) — checked before any
    // container work.
    if (snap.ref !== facts.defaultRef || snap.sha !== facts.sha || snap.lockfileHash !== facts.lockfileHash) {
      throw await this.goDown(
        `snapshot-stamp-mismatch: DO facts {ref:${facts.defaultRef}, sha:${facts.sha}, lockfileHash:${facts.lockfileHash}} != snapshot stamp {ref:${snap.ref}, sha:${snap.sha}, lockfileHash:${snap.lockfileHash}}`,
      );
    }

    // Cheap short-circuit only when the runtime is already up AND the disk
    // matches; a dead runtime goes straight to `restoring` so /status never
    // says warm while the wake actually runs.
    const active = await this.isRuntimeActive().catch(() => false);
    if (active && (await this.diskMatches(snap.sha))) return;

    await this.setResidentState("restoring", "rehydrating");
    if (await this.diskMatches(snap.sha)) {
      // Raced a container start that already had the right disk.
      await this.setResidentState("warm");
      return;
    }

    const t0 = systemClock();
    // A restore a previous attempt gave up on may still be writing into these
    // directories (the SDK call cannot be cancelled): wait for it to
    // settle before the clean, bounded by the same cap the restores get. A
    // restore that will not settle even then leaves the disk alone — a named
    // `down`, not a clean racing a writer.
    // One deadline for the whole hydrate: the wait below and both restores
    // judge against it, so the worst-case `restoring` span is RESTORE_MAX_MS,
    // under the watchdog's stale-mid-flight window — not three caps in a row.
    const deadlineMs = systemClock() + RESTORE_MAX_MS;
    if (this.pendingRestores.size > 0) {
      try {
        await withTimeout(
          Promise.allSettled([...this.pendingRestores]),
          Math.max(1, deadlineMs - systemClock()),
          `${this.pendingRestores.size} earlier restore(s) still running`,
        );
      } catch (err) {
        // Same exit as a stalled restore below: the stream is still running and
        // a rebuild is what follows a `down`, so the container goes with it.
        this.clearIncarnationMemos(); // deliberate incarnation swap
        await this.stop().catch((stopErr) => console.log(`restore: stop failed: ${errMsg(stopErr)}`));
        throw await this.goDown(
          `r2-restore-failed: ${errMsg(err)} — container stopped so the transfer cannot land on a rebuild`,
        );
      }
    }
    // A previous incarnation's restore may still be MOUNTED at these paths
    // (item 61: the SDK's presigned restore mounts) — `rm -rf` on a mount
    // point is "Device or resource busy". Unmount first, every time.
    await this.runOk(["sh", "-c", unmountAllRestoresScript()], "unmount-restores");
    await this.runOk(["rm", "-rf", MIRROR_DIR, CHECKOUT_DIR, ...DISK_MARKERS], "clean-before-restore");
    try {
      // The restore pair IS the cold-wake critical path. Sequential on purpose:
      // the SDK serializes backup operations anyway (one queue), so a
      // concurrent pair only made the second one's clock run while it waited —
      // and each is judged by its own bytes (restoreWithProgress), not by
      // a fixed budget: a slow transfer waits, a stalled one goes down with
      // the bytes and the idle span named instead of stranding `restoring` for
      // the watchdog.
      await this.restoreExtracted(snap.mirror, MIRROR_DIR, "mirror restore", "mirror-restore-extract", deadlineMs);
      await this.restoreExtracted(
        snap.checkout,
        CHECKOUT_DIR,
        "checkout restore",
        "checkout-restore-extract",
        deadlineMs,
      );
    } catch (err) {
      // A stalled or capped restore is STILL STREAMING (the SDK call cannot be
      // cancelled); `pendingRestores` keeps the next hydrate off its directory,
      // but a `down` resident's only exit is a REBUILD, and provisioning owns
      // the same directories. Left running, the restore the wake path gave up
      // on lands into the checkout the rebuild has just cloned and linked —
      // tar overwrites in place through the deps store's hardlinks, resetting
      // every hardened entry file from 444 to 644. Stop
      // the container on the way down: the disk is ephemeral, the stream dies
      // with it, and the rebuild starts on an empty one.
      this.clearIncarnationMemos(); // deliberate incarnation swap
      await this.stop().catch((stopErr) => console.log(`restore: stop failed: ${errMsg(stopErr)}`));
      throw await this.goDown(
        `r2-restore-failed: ${errMsg(err)} — container stopped so the transfer cannot land on a rebuild`,
      );
    }
    await this.ensureGitSetup();

    // Verify the restored disk against the stamp — a snapshot that does not
    // prove its own {ref, sha, lockfileHash} is refused. Both values
    // derive from the restored MIRROR (the source of truth the checkout was
    // built from); the checkout's presence was proven by restoreBackup + the
    // chown below failing loudly if it is missing.
    const shaRes = await this.run(["git", "-C", MIRROR_DIR, "rev-parse", "--verify", `refs/heads/${snap.ref}`]);
    const diskSha = shaRes.exitCode === 0 ? shaRes.stdout.trim() : `unreadable(${tail(shaRes.stderr, 120)})`;
    const diskLock = await this.lockfileKey(snap.sha).catch((err) => `unreadable(${errMsg(err)})`);
    if (diskSha !== snap.sha || diskLock !== snap.lockfileHash) {
      throw await this.goDown(
        `snapshot-stamp-mismatch: restored disk {sha:${diskSha}, lockfileHash:${diskLock}} != stamp {sha:${snap.sha}, lockfileHash:${snap.lockfileHash}}`,
      );
    }

    await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, CHECKOUT_DIR], "chown");
    // The snapshot carries the checkout's tree, not the store (item 59): adopt
    // its node_modules as the entry for the stamp's key — a rename plus a
    // hardlink view, seconds — so the first attach on the warm key hits.
    // Housekeeping on the restore path: a failure here leaves the checkout
    // whole (the entry is either absent or complete) and the first attach
    // adopts instead.
    await this.adoptCheckoutDeps(snap.lockfileHash).catch((err) =>
      console.log(`deps: adopt after restore failed: ${errMsg(err)}`),
    );
    // A snapshot taken since item 61 PR B carries the tree WITHOUT its deps
    // view. If the checkout has no node_modules after the adopt (a new-format
    // snapshot; an old one was adopted and linked just above), materialize
    // the stamp's key — hit, the entry backup, or the installer — and link
    // the view. The deps checkpoint is written ONLY when the checkout holds
    // its view: anything else (a repo without an install command has no view
    // to hold; a lookup or materialize failure) leaves it unwritten, so the
    // next refresh cycle's plan (`no deps marker on disk — full install`)
    // repairs it — never a `down` for a cache miss. The whole thing stays
    // under the hydrate's ONE deadline (planWakeDepsBudget): the restore is
    // judged against it and the install is bounded by what remains.
    let depsLinked = false;
    try {
      const resource = await this.ctx.storage.get<string>(RESOURCE_KEY);
      if (!resource) throw new Error("no resource recorded");
      const record = await this.registry().getRecord(resource);
      if (!record) throw new Error("registry record missing");
      const hasView = (await this.run(["test", "-d", `${CHECKOUT_DIR}/node_modules`])).exitCode === 0;
      if (!record.commands.install) {
        depsLinked = hasView;
      } else if (hasView) {
        depsLinked = true;
      } else {
        const budget = planWakeDepsBudget({
          nowMs: systemClock(),
          deadlineMs,
          installBudgetMs: REFRESH_INSTALL_TIMEOUT_MS,
        });
        if (budget.action === "skip") throw new Error(`${budget.remainingMs} ms left of the hydrate deadline`);
        const entry = await this.materializeDeps(
          snap.lockfileHash,
          snap.sha,
          record.commands.install,
          budget.installBudgetMs,
          {
            restoreDeadlineMs: deadlineMs,
          },
        );
        await this.linkDepsView(`${entry}/node_modules`, CHECKOUT_DIR, BUILD_USER);
        depsLinked = true;
      }
    } catch (err) {
      console.log(`deps: no view after restore — the next refresh installs: ${errMsg(err)}`);
    }
    // The restored checkout carries the snapshot's build, so the refresh
    // checkpoints are the stamp — the deps checkpoint only with the view in place.
    await this.writeDiskMarkers({
      ready: snap.sha,
      ...(depsLinked ? { depsKey: snap.lockfileHash } : {}),
      builtSha: snap.sha,
    });
    await this.ctx.storage.put(FACTS_KEY, {
      ...facts,
      lastRestore: { at: new Date(systemClock()).toISOString(), ms: systemClock() - t0 },
    } satisfies RepoFacts);
    await this.setResidentState("warm");
  }

  // -- freshness (the self-rescheduling refresh alarm) --------------------------

  /** Self-rescheduling refresh: rehydrate if the container slept → mint a
   *  repo-scoped token (mint failure is command-level: recorded, never a
   *  lifecycle flip) → fetch into the bare mirror → when the default branch
   *  moved: plan against the disk checkpoints (planRefresh) — reuse a
   *  checkout an interrupted cycle already materialized, else update the
   *  checkout and reinstall ONLY if the committed lockfile key changed, then
   *  rebuild — write a new stamped snapshot, delete the replaced backup
   *  objects. Transitions: refreshing → warm, or degraded(reason) with the
   *  last snapshot still serving. */
  async onRefreshAlarm(payload: string): Promise<void> {
    // The freshness cycle nobody asked for is a root of its own
    // (docs/reference/specs/tracing.md item 25): `resident.refresh`, with every command it
    // ran as a `resident.<step>` child, exactly like an attach's.
    const t0 = systemClock();
    const trace = createStepTrace(t0);
    let outcome = "ok";
    try {
      await this.stepTrace.run(trace, () => this.onRefreshAlarmTraced(payload));
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      emitStepRoot("resident.refresh", t0, trace.steps(), undefined, outcome);
    }
  }

  private async onRefreshAlarmTraced(payload: string): Promise<void> {
    const resource = payload || ((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    let refreshCounted = false;
    const before = await this.getStatus();
    // down chains stay down (a rebuild is the escape hatch); onboarding is
    // owned by provisioning, which arms the first refresh itself.
    if (before.state === "onboarding" || before.state === "down") return;
    try {
      await this.ensureHydrated();
      const record = await this.registry().getRecord(resource);
      if (!record) return; // offboarded mid-flight: let the chain die quietly
      const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
      if (!facts) throw new StepError("facts", "no repo facts recorded despite hydration");

      // Deploy-ordering hazard: `wrangler deploy` swaps the app's image but a
      // RUNNING container keeps the old one, so new Worker code can name pool
      // users the image lacks. Reconcile here (every cycle, cheap) — see
      // reconcileImage — so a rollout self-applies within one refresh.
      if (await this.reconcileImage("refresh")) {
        // Container stopping; it restarts on the new image in seconds. Re-arm
        // SHORT so the resident is re-warmed within a minute instead of
        // sitting on the old cadence for a full 600 s.
        this.rearmOutcome = "image-stale-restart";
        return; // finally re-arms
      }

      // Idle sleep: nobody has attached for IDLE_AFTER_S and no live tree is
      // dirty → skip this fetch and park the alarm far out so SLEEP_AFTER can
      // elapse. Staleness is repaid at the next attach (refreshIfStale). A
      // dirty live tree pins the container awake: sleep destroys the disk and
      // uncommitted work is not snapshotted.
      // Only a SETTLED resident may park: a cycle that finds `refreshing`/
      // `restoring` at entry is looking at a marker left by a cycle that died
      // mid-flight (a deploy evicting the DO: stuck `refreshing` + parked →
      // every run falls back cold because the bot's warm-gate probe never
      // sees `warm` again). Run the full cycle instead; it
      // ends warm or degraded, and the next one may park.
      // Decide off a FRESH state read — `before` predates several awaits
      // (hydration, registry, facts, reconcile) — same re-read discipline as
      // every other state decision in this file.
      const entry = await this.getStatus();
      if (entry.state === "degraded" && isDiskFullReason(entry.reason)) {
        // The cycle owns the disk-full verdict (docs/reference/specs/resident-repos.md item 54): re-probe before
        // fetching. Still full → nothing a fetch can do; decide whether the
        // container may be recycled and stop here (a fetch that happened to fit
        // would flip the resident `warm`, the bot would attach, git-setup would
        // fail and flip it back — a flap loop). Space back (a detach or the
        // sweep freed trees) → run the cycle as usual and earn `warm`.
        const free = await this.freeKiB();
        if (free !== null && free < DISK_FULL_FREE_KIB) {
          await this.recoverFromDiskFull(entry.reason, 0);
          return; // finally re-arms: short after a recycle, the cadence otherwise
        }
      }
      let settled = entry.state === "warm";
      if (entry.state === "degraded" && !isNonEvidenceReason(entry.reason)) {
        // Count consecutive cycles that found the same REFRESH-PRODUCED degraded
        // reason (github-unreachable, <step>-failed); a stable streak means
        // retrying is not going to help and parking is the right cost behavior.
        // Any other state resets the streak (below).
        const prev = await this.ctx.storage.get<{ reason: string; count: number }>(DEGRADED_STREAK_KEY);
        const streak =
          prev && prev.reason === entry.reason
            ? { reason: entry.reason, count: prev.count + 1 }
            : { reason: entry.reason, count: 1 };
        await this.ctx.storage.put(DEGRADED_STREAK_KEY, streak);
        settled = streak.count >= DEGRADED_PARK_AFTER_CYCLES;
      } else {
        // Warm, or a degraded stamped by the WATCHDOG (alarm-missed /
        // stale-mid-flight) or by an INTERRUPTED cycle (refresh-interrupted —
        // a deploy killed the step; it says nothing about the repo): the
        // watchdog pulled this cycle to +5s precisely so a refresh RUNS, and the
        // interrupted cycle re-armed short for the same reason.
        // Counting those toward the streak would be self-fulfilling —
        // each cycle that found the reason would park without attempting anything,
        // and after three the resident would sit parked-degraded for 6h at a
        // time. Never settled; streak reset.
        await this.ctx.storage.delete(DEGRADED_STREAK_KEY);
      }
      if (settled && (await this.isIdle())) {
        // isIdle awaited (git status per live tree) — re-read before writing.
        const now = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
        if (!now.idleSince)
          await this.ctx.storage.put(FACTS_KEY, {
            ...now,
            idleSince: new Date(systemClock()).toISOString(),
          } satisfies RepoFacts);
        this.rearmOutcome = "idle";
        return; // finally re-arms at IDLE_REFRESH_INTERVAL_S
      }
      if (facts.idleSince) {
        const now = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
        const { idleSince: _woke, ...awake } = now;
        await this.ctx.storage.put(FACTS_KEY, awake satisfies RepoFacts);
      }
      // From here the cycle mutates the mirror/checkout: count it as in flight
      // so an attach-path reconcileImage never stops the container under it.
      this.refreshesInFlight++;
      refreshCounted = true;

      // Token-mint failure is a command-level error — the resident
      // keeps serving the last snapshot and lifecycle state is NOT flipped by
      // it. It is recorded, and the cycle then CONTINUES with an anonymous
      // fetch (exactly what an unconfigured App does): a public repo outside
      // the installation stays fresh, and a private one fails at the fetch
      // below into a visible `degraded(github-unreachable: …)`. Returning here
      // instead would freeze whatever state the resident was in — a public
      // repo the App is not installed on would sit in the watchdog's
      // `degraded(alarm-missed)` forever with an ever-staler mirror, because
      // the App cannot mint for a repo it is not installed on.
      let token: string | null = null;
      // This cycle's mint error, kept so it survives the warm facts write below
      // (which clears errors from PRIOR cycles) and prefixes a fetch failure's
      // reason — the observable for "App configured, repo outside the
      // installation" is a warm-but-anonymous resident with the mint named.
      let mintError: string | undefined;
      if (githubAppConfigured(this.env)) {
        try {
          token = (await mintRepoScopedToken(this.env, resource.slice("repo:".length))).token;
        } catch (err) {
          mintError = `token-mint-failed (command-level, fetching anonymously): ${errMsg(err)}`;
          await this.recordRefreshError(mintError);
        }
      }

      await this.setResidentState("refreshing");
      try {
        // Same mirror mutex as attach's fetch/worktree work: the
        // refresh alarm and an in-flight attach serialize instead of racing
        // a prune against a worktree clone.
        await this.withMirrorLock(() =>
          this.gitWithCred(token, ["-C", MIRROR_DIR, "fetch", "--prune", "origin"], "fetch", GIT_NETWORK_TIMEOUT_MS),
        );
      } catch (err) {
        // A private repo whose mint failed lands here (the anonymous fetch is
        // refused): say so, rather than blaming GitHub reachability alone.
        const cause = mintError ? `${mintError}; then ` : "";
        const message = `${cause}${errMsg(err)}`;
        // A full disk fails this step too — the credential file is written
        // here (`ENOSPC` on /workspace/.resident/git-credentials would read as
        // github-unreachable, a SERVICEABLE reason, so every run would attach
        // and die at git-setup). Name the disk instead: not
        // serviceable, and the recovery below can free it.
        const failure = await this.classifyFailure("fetch", message);
        if (failure.diskFull) {
          await this.setResidentState("degraded", failure.reason);
          await this.recoverFromDiskFull(failure.reason, refreshCounted ? 1 : 0);
          return;
        }
        await this.setResidentState("degraded", `github-unreachable: ${message}`);
        return;
      }

      const sha = await this.readMirrorSha(facts.defaultRef);
      // Pure function of the commit — computed from the mirror before
      // any checkout work so the planner can compare it to the deps marker.
      const lockfileHash = sha === facts.sha ? facts.lockfileHash : await this.lockfileKey(sha);
      const plan = planRefresh({
        sha,
        factsSha: facts.sha,
        lockfileKey: lockfileHash,
        disk: await this.readRefreshDisk(),
      });
      let snap: SnapshotRecord | null = null;
      let previous: SnapshotRecord | undefined;
      if (plan.action !== "unchanged") {
        const t0 = systemClock();
        console.log(`refresh: ${facts.sha.slice(0, 8)} → ${sha.slice(0, 8)}: ${plan.action} (${plan.why})`);
        // Serialize the CHECKOUT_DIR mutation on the mirror mutex (FIX 2):
        // materializeThreadDeps reads CHECKOUT_DIR via `cp -al` under the same
        // lock, so an attach/op dep-copy can no longer hardlink a half-rebuilt
        // checkout into a thread tree (torn cache → false ❌ from `repo test`).
        // No wait timeout, exactly like the fetch lock above: the background
        // refresh queues behind an in-flight attach instead of flipping to
        // degraded on transient lock contention.
        // Token-free from here on: repo code runs during install/build.
        //
        // Deps come from the store (item 59): a changed lockfile key is
        // materialized ONCE into `/workspace/deps/<key>` — OUTSIDE the mirror
        // lock, because the install runs in its own scratch clone and touches
        // no consumer's tree (the staging step) — and the checkout's
        // node_modules becomes a hardlink view of that entry. An attach that
        // needs the same key joins this very install instead of starting its
        // own. Checkpoint: the deps marker comes off BEFORE the install so an
        // interruption mid-install can never read as completion.
        let depsEntry: string | null = null;
        if (plan.action === "rebuild") {
          await this.runOk(["rm", "-f", BUILT_MARKER, ...(plan.install ? [DEPS_MARKER] : [])], "clear-markers");
          if (plan.install && record.commands.install) {
            // The installing marker brackets the install (item 57): written
            // before, removed after the deps key lands, so a cycle that ends in
            // between is planned as a resume. The install is seeded from the
            // key the checkout holds now — npm reconciles the delta; a resumed
            // install finds its key already in the store when the last attempt
            // completed, or reconciles from the warm key again when it did not.
            await this.writeDiskMarkers({ installingKey: lockfileHash });
            depsEntry = await this.materializeDeps(
              lockfileHash,
              sha,
              record.commands.install,
              REFRESH_INSTALL_TIMEOUT_MS,
              {
                seedFromKey: facts.lockfileHash,
              },
            );
          }
        }
        await this.withMirrorLock(async () => {
          if (plan.action === "rebuild") {
            // Isolation invariant (review 1b): attached, sha-pinned thread
            // worktrees hold hardlinks to the store entry's FILE inodes, and so
            // does the checkout. A build that writes THROUGH an existing inode —
            // many bundlers do (e.g. .next incremental manifests open+truncate
            // rather than recreate) — would mutate every consumer's pinned
            // artifacts. The `-x` clean removes the checkout's build output so
            // the build allocates FRESH inodes; the entry's own files are
            // owner-read-only (deps-harden), so a write through them fails
            // loudly instead of silently reaching the store; the tool caches
            // inside node_modules are the checkout's private copies (item 18).
            //
            // Install gate: when the committed lockfile key is unchanged,
            // node_modules (the view) is excluded from the clean and no deps
            // work happens; a changed key takes the full clean and re-links the
            // view to the new entry — which is also what drops deps the new
            // lockfile no longer has.
            await this.buildUserRun(checkoutUpdateCommand(sha, plan.clean), "checkout-update", GIT_NETWORK_TIMEOUT_MS);
            if (plan.install) {
              // The old view (a resumed install's keep-deps clean leaves it in
              // place, item 57) makes way for the new entry's: hardlinks only,
              // the entry's inodes are untouched.
              if (depsEntry) {
                await this.runOk(["rm", "-rf", `${CHECKOUT_DIR}/node_modules`], "unlink-deps-view");
                await this.linkDepsView(`${depsEntry}/node_modules`, CHECKOUT_DIR, BUILD_USER);
              }
              await this.writeDiskMarkers({ depsKey: lockfileHash });
              await this.runOk(["rm", "-f", INSTALLING_MARKER], "clear-installing-marker");
            }
            await this.buildUserRun(record.commands.build, "build", REFRESH_BUILD_TIMEOUT_MS);
            await this.writeDiskMarkers({ builtSha: sha });
          }
          // `reuse`: the checkout already holds this sha with its deps and
          // build (an interrupted cycle got that far) — only the snapshot,
          // facts and stamp are missing, and they must still move together.
          previous = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
          snap = await this.takeSnapshot(resource, facts.defaultRef, sha, lockfileHash);
        });
        console.log(`refresh: ${sha.slice(0, 8)} ${plan.action} done in ${systemClock() - t0}ms`);
      }

      // Facts and snapshot move together so the stamp check never sees a
      // half-updated pair.
      const updatedFacts: RepoFacts = {
        ...facts,
        sha,
        lockfileHash,
        lastRefreshAt: new Date(systemClock()).toISOString(),
      };
      // Clear a PRIOR cycle's error; keep THIS cycle's mint error visible.
      delete updatedFacts.lastRefreshError;
      if (mintError) updatedFacts.lastRefreshError = mintError;
      // A wake cycle cleared idleSince above; `facts` was read at alarm entry and
      // still carries it — never resurrect it here (the dash would show a stale
      // "idle since" and every attach would take the wake-fetch path).
      delete updatedFacts.idleSince;
      if (snap) {
        await this.ctx.storage.put({ [FACTS_KEY]: updatedFacts, [SNAPSHOT_KEY]: snap });
        await this.writeDiskMarkers({ ready: sha });
        if (previous) await this.deleteBackupObjects([previous.mirror.id, previous.checkout.id]).catch(() => {});
      } else {
        await this.ctx.storage.put(FACTS_KEY, updatedFacts);
      }
      await this.setResidentState("warm");
      // Event-triggered reclamation: the prune above already told the
      // mirror which branches died; finished refs give their worktree and
      // pool user back now, not at the idle TTL. Housekeeping, never a
      // lifecycle flip — a failure here is a log line.
      try {
        const gc = await this.reclaimFinishedRefs(resource, facts.defaultRef, token);
        if (gc.reclaimed.length > 0) console.log(`reclaim ${resource}: ${JSON.stringify(gc)}`);
      } catch (err) {
        console.log(`reclaim ${resource}: pass failed: ${errMsg(err)}`);
      }
      // Item 55: the cycle's disk sample — what /residents, `repo list`, the
      // watchdog line and the next attach admission read. Housekeeping too.
      await this.measureDisk().catch((err) => console.log(`disk: measure failed: ${errMsg(err)}`));
    } catch (err) {
      if (err instanceof ResidentDownError) return; // already down with reason; chain stops below
      // A step killed from OUTSIDE (the container replaced under it — an
      // image-changing deploy or a container stop; a Worker-only deploy leaves
      // the container running and interrupts nothing) is
      // `refresh-interrupted`: it is not evidence about the repo — it
      // never counts toward the park streak (the entry gate above) — and the
      // chain re-arms SHORT so the resident is warm again within a minute
      // instead of after the full cadence (an unclassified kill otherwise
      // costs the resident the whole 10-minute cadence, e.g.
      // `degraded(build-failed: exit 143 …)` until the next alarm).
      // Any other failure is the repo's own: `<step>-failed: …` /
      // `refresh-failed: …` as before. Non-StepErrors classify too — an SDK
      // replacement error can surface between steps — with the generic
      // "refresh" step, whose failure reason is the pre-existing
      // `refresh-failed: …` shape.
      // A full disk is a third class: `disk-full: …`, never serviceable,
      // and the one failure the resident can act on itself (recoverFromDiskFull).
      const failure =
        err instanceof StepError
          ? await this.classifyFailure(err.step, err.message)
          : await this.classifyFailure("refresh", errMsg(err));
      // Set BEFORE the writes on purpose: if either throws, the finally still
      // re-arms short — the safe direction for an interruption.
      if (failure.interrupted) this.rearmOutcome = "interrupted";
      // The classified reason, always in the log: a StepError logged its own
      // output block above, but a failure between steps (an SDK error, the
      // markers, the snapshot) reached only the state entry — which the next
      // cycle's failure overwrites (an install timeout that starts an
      // incident leaves no trace once the follow-up cycle fails).
      console.log(`refresh: cycle failed — ${failure.reason.slice(0, 400)}`);
      // Record on the facts too: the degraded state write below can be
      // clobbered within seconds by a concurrent attach/exec whose
      // ensureHydrated flips the state to `restoring · rehydrating`, leaving
      // no visible trace of WHY.
      // `lastRefreshError` survives that race and the next completed cycle
      // clears it, same as a mint error.
      await this.recordRefreshError(failure.reason);
      await this.setResidentState("degraded", failure.reason); // last snapshot keeps serving
      if (failure.diskFull) await this.recoverFromDiskFull(failure.reason, refreshCounted ? 1 : 0);
    } finally {
      if (refreshCounted) this.refreshesInFlight--;
      const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
      // Consecutive-interruption count: bounds the short re-arm so
      // a step whose output chronically carries the kill signature falls back to
      // the cadence after INTERRUPTED_REARM_MAX_CONSECUTIVE instead of hot-looping.
      let consecutiveInterrupted: number | undefined;
      if (this.rearmOutcome === "interrupted") {
        consecutiveInterrupted = ((await this.ctx.storage.get<number>(INTERRUPTED_STREAK_KEY)) ?? 0) + 1;
        await this.ctx.storage.put(INTERRUPTED_STREAK_KEY, consecutiveInterrupted);
      } else {
        await this.ctx.storage.delete(INTERRUPTED_STREAK_KEY);
      }
      const interval = nextRefreshDelayS({
        outcome: this.rearmOutcome,
        intervalS: REFRESH_INTERVAL_S,
        idleIntervalS: IDLE_REFRESH_INTERVAL_S,
        consecutiveInterrupted,
      });
      this.rearmOutcome = "normal";
      if (state && state !== "down" && state !== "onboarding") await this.armRefresh(resource, interval);
    }
  }

  /** Set during one alarm by the idle gate (`idle`), an image-stale container
   *  stop (`image-stale-restart`), a disk-full recycle (`disk-full-restart`)
   *  or an interrupted step (`interrupted`) so `finally` picks the matching
   *  re-arm delay (`nextRefreshDelayS`); reset to `normal` after every arm. */
  private rearmOutcome: RefreshOutcome = "normal";

  /** Idle = no live binding attached within IDLE_AFTER_S AND (when the
   *  runtime is up) no live tree is dirty. Bindings are storage; dirtiness
   *  needs the container — if it is already asleep there is nothing to lose. */
  private async isIdle(): Promise<boolean> {
    const live = await this.liveBindings();
    const recent = systemClock() - IDLE_AFTER_S * 1000;
    if (live.some((b) => Date.parse(b.lastAttachAt) >= recent)) return false;
    if (this.inFlightCount() > 0) return false;
    return this.liveTreesClean(live);
  }

  /** Bindings that hold a pool user and a tree on disk (not evicted). */
  private async liveBindings(): Promise<ThreadBinding[]> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return [...all.values()].filter((b) => !b.evicted && b.user);
  }

  /** True when no live tree holds work a lost disk would destroy: every one
   *  is clean (as its thread user), or the runtime is already down — a sleep
   *  has destroyed the disk, so there is nothing left to lose. */
  private async liveTreesClean(live: ThreadBinding[]): Promise<boolean> {
    if (!(await this.isRuntimeActive().catch(() => false))) return true;
    // Concurrent: each check touches only its own (disjoint) tree, and one
    // spawn each — the idle gate does not pay a serial
    // 3-probe round-trip per live binding.
    const checks = await Promise.all(live.map((b) => this.worktreeCleanliness(b)));
    return checks.every((c) => c.clean); // any dirty or unknown → not clean
  }

  // -- disk-full (docs/reference/specs/resident-repos.md item 54) ---------------------------

  /** Free space on the workspace mount in KiB; `null` when df cannot answer.
   *  One fork, run only after a step has already failed — never on the hot path. */
  private async freeKiB(): Promise<number | null> {
    try {
      const r = await this.run([...DF_FREE_ARGV]);
      return r.exitCode === 0 ? parseDfFreeKiB(r.stdout) : null;
    } catch {
      return null;
    }
  }

  /** `classifyRefreshFailure` with the disk probe folded in: the probe runs
   *  only when the message alone does not decide (no ENOSPC wording, no kill
   *  signature) — git's `git config` reports its write failure without an
   *  errno, so a full-disk attach reads like a lock bug without the probe. */
  private async classifyFailure(step: string, message: string): Promise<RefreshFailure> {
    const direct = classifyRefreshFailure({ step, message });
    if (direct.diskFull || direct.interrupted) return direct;
    return classifyRefreshFailure({ step, message, freeKiB: await this.freeKiB() });
  }

  /** The disk is a cache: stop the container so the next alarm restores
   *  mirror + checkout from R2 onto an empty disk — the same wake path as a
   *  platform sleep. Only when the pure plan allows it: nothing in flight
   *  (`selfInFlight` excludes the calling refresh cycle from the count), every
   *  live tree clean, and no recycle within the cooldown. A refused recycle is
   *  written to `lastRefreshError` with its why, so `/residents` says what an
   *  operator must do; the `degraded` reason stays the clean `disk-full: …`. */
  private async recoverFromDiskFull(reason: string, selfInFlight: number): Promise<void> {
    const lastRecycleAt = await this.ctx.storage.get<number>(DISK_FULL_RECYCLE_KEY);
    const plan = planDiskFullRecovery({
      now: systemClock(),
      lastRecycleAt,
      inFlight: this.inFlightCount() - selfInFlight,
      treesClean: await this.liveTreesClean(await this.liveBindings()),
    });
    if (plan.action === "wait") {
      console.log(`disk-full: container kept — ${plan.why}`);
      await this.recordRefreshError(`${reason} — container kept: ${plan.why}`);
      return;
    }
    console.log(
      `disk-full: recycling the container — the next alarm restores mirror + checkout from R2 onto an empty disk (${reason})`,
    );
    await this.ctx.storage.put(DISK_FULL_RECYCLE_KEY, systemClock());
    await this.recordRefreshError(`${reason} — container recycled; restoring from R2 on the next alarm`);
    this.clearIncarnationMemos(); // deliberate incarnation swap
    await this.stop().catch((err) => console.log(`disk-full: stop failed: ${errMsg(err)}`));
    this.rearmOutcome = "disk-full-restart";
  }

  // -- disk budget (docs/reference/specs/resident-repos.md item 55) -------------------------

  /** The `df` half: total/used/free of the workspace mount; null when df
   *  cannot answer (never 0 — unknown must not read as full or as empty). */
  private async dfSample(): Promise<{ totalKiB: number; usedKiB: number; freeKiB: number } | null> {
    try {
      const r = await this.run([...DF_FREE_ARGV]);
      return r.exitCode === 0 ? parseDfKiB(r.stdout) : null;
    } catch {
      return null;
    }
  }

  /** One `df` + one `du -xsk` over the parts — mirror, the checkout's
   *  node_modules, the checkout, each live thread dir, every pool user's home —
   *  in `duArgv`'s order, so a hardlinked inode is counted once and charged to
   *  the checkout's deps term, never to the thread that shares it. Persisted at
   *  DISK_KEY and read back by `getResidentInfo` (`live.disk`) and the attach
   *  admission. Never wakes a sleeping container (a slept disk is gone anyway);
   *  best effort — a failure is a log line, never a lifecycle flip. `du` exits
   *  1 when any argument is unreadable or absent and still prints every line it
   *  could measure, so its exit code is deliberately not checked. */
  private async measureDisk(): Promise<DiskSample | null> {
    if (!(await this.isRuntimeActive().catch(() => false))) return null;
    const df = await this.dfSample();
    if (!df) {
      console.log("disk: df did not answer — no sample taken");
      return null;
    }
    const live = await this.liveBindings();
    const layout = {
      mirrorDir: MIRROR_DIR,
      depsStoreDir: DEPS_STORE_DIR,
      checkoutDir: CHECKOUT_DIR,
      threads: live.map((b) => ({ threadKey: b.threadKey, dir: parentDir(b.worktreePath) })),
      homes: [BUILD_USER, ...THREAD_USERS].map((user) => ({ user, dir: `/home/${user}` })),
    };
    const du = await this.run(duArgv(layout), { timeoutMs: DU_TIMEOUT_MS });
    const sample = assembleDiskSample({
      at: new Date(systemClock()).toISOString(),
      df,
      du: parseDu(du.stdout),
      layout,
    });
    await this.ctx.storage.put(DISK_KEY, sample);
    // Item 57: the store's cache upkeep rides on every measurement (the same
    // cadence as the gauge; never on an attach's hot path).
    await this.sweepDepsStore().catch((err) => console.log(`deps: sweep failed: ${errMsg(err)}`));
    const p = sample.parts;
    console.log(
      `disk: ${formatDiskGauge(sample)} — mirror ${formatGiB(p.mirror)}, deps ${formatGiB(p.deps)}, checkout ${formatGiB(p.checkout)}, ` +
        `${Object.keys(p.threads).length} thread tree(s) ${formatGiB(Object.values(p.threads).reduce((a, n) => a + n, 0))}, ` +
        `homes ${formatGiB(Object.values(p.homes).reduce((a, n) => a + n, 0))}, other ${formatGiB(p.other)}`,
    );
    return sample;
  }

  /** Schedule callback: the deferred measurement an attach/detach/sweep arms. */
  async onDiskMeasure(_payload: string): Promise<void> {
    await this.measureDisk().catch((err) => console.log(`disk: measure failed: ${errMsg(err)}`));
  }

  /** Arm one deferred measurement (at most one pending): the attach's hot path
   *  pays a `df`, not the `du`. */
  private async scheduleDiskMeasure(resource: string): Promise<void> {
    if ((await this.listSchedules(DISK_MEASURE_CALLBACK)).length > 0) return;
    await this.schedule(DISK_MEASURE_DELAY_S, DISK_MEASURE_CALLBACK, resource);
  }

  /** `{usedKiB, totalKiB, at}` of the last sample for the watchdog line (storage
   *  only — the watchdog never touches the container). */
  private async diskGauge(): Promise<{ usedKiB: number; totalKiB: number; freeKiB: number; at: string } | null> {
    const s = await this.ctx.storage.get<DiskSample>(DISK_KEY);
    return s ? { usedKiB: s.usedKiB, totalKiB: s.totalKiB, freeKiB: s.freeKiB, at: s.at } : null;
  }

  /** Projected bytes of attaches admitted but not yet on disk: the DO yields
   *  between an admission's `df` and its clone, so two concurrent attaches would
   *  otherwise each see the same free space. Added on admit, released when the
   *  attach settles (`attachThreadBody`'s finally). */
  private diskCommittedKiB = 0;

  /** Attach admission (item 55): a new thread tree is created only when its
   *  projected cost fits under `free − reserve` (`checkDiskAdmission`, with the
   *  record's `diskBudgetMb` as a cap and the in-flight commitments deducted).
   *  The cost is projected from the last sample's checkout parts: `hardlink`
   *  (history + tree) unless the committed lockfile at the ref's mirror tip
   *  differs from the warm checkout's (`install`: plus the deps term); a tree
   *  already on disk is `reuse` (0 — a dirty/stale recreate frees the old one
   *  first). A ref not yet in the mirror (fetched under the lock, moments later)
   *  is projected as `hardlink`, the common case. When it does not fit, the
   *  coldest clean idle trees go first (`orderEvictionCandidates`: never the
   *  requesting thread, a busy tree, the default branch, or one attached within
   *  DISK_EVICT_MIN_IDLE_MS; cleanliness checked as the thread user, dirty or
   *  unreadable kept — the sweep's rules), `df` re-probed after each; still
   *  short → `503 {reason:"disk-pressure"}` with the whole math in `error`, the
   *  same shape as `mirror-busy`, so the bot falls back cold legibly. Never a
   *  lifecycle flip: the checkout is intact and every existing tree keeps
   *  serving. Runs BEFORE the mirror lock — evictions take the lock themselves.
   *  No `df` answer → admitted (unknown is never refused). */
  private async admitThreadDisk(input: {
    threadKey: string;
    binding: ThreadBinding;
    facts: RepoFacts;
    record: ResidentRecord;
  }): Promise<{ admitted: true; committedKiB: number } | ThreadErr> {
    const wt = input.binding.worktreePath;
    if ((await this.run(["test", "-d", `${wt}/.git`])).exitCode === 0) return { admitted: true, committedKiB: 0 };
    let kind: ThreadCostKind = "hardlink";
    const tip = await this.run(["git", "-C", MIRROR_DIR, "rev-parse", "--verify", `refs/heads/${input.binding.ref}`]);
    if (tip.exitCode === 0) {
      const key = await this.lockfileKey(tip.stdout.trim()).catch(() => null);
      // A diverged lockfile is seeded from the shared cache and then reconciled
      // by the install (planThreadDeps): the delta share of the deps, not the
      // deps again. Without an install command nothing is seeded (the tree is
      // history + source only), so the hardlink projection is already an upper bound.
      if (key !== null && key !== input.facts.lockfileHash && input.record.commands.install !== undefined) {
        kind = "reconcile";
      }
    }
    const df = await this.dfSample();
    if (!df) {
      console.log(`attach ${input.threadKey}: disk admission skipped — df did not answer`);
      return { admitted: true, committedKiB: 0 };
    }
    // The parts come from the last full sample; total/used/free from this df.
    const stored = await this.ctx.storage.get<DiskSample>(DISK_KEY);
    const sample: DiskSample = {
      at: stored?.at ?? "",
      ...df,
      parts: stored?.parts ?? { mirror: null, deps: null, checkout: null, threads: {}, homes: {}, other: 0 },
    };
    // `rawFree` is always the last RAW df reading: `checkDiskAdmission`
    // deducts the in-flight commitments itself, exactly once, so a re-check
    // after an eviction never deducts them twice (review F1).
    const decide = (rawFreeKiB: number) =>
      checkDiskAdmission({
        sample,
        freeKiB: rawFreeKiB,
        committedKiB: this.diskCommittedKiB,
        diskBudgetMb: input.record.diskBudgetMb,
        kind,
      });
    let rawFree = df.freeKiB;
    let verdict = decide(rawFree);
    const evicted: Array<{ threadKey: string; freedKiB: number | null }> = [];
    // Item 62: keep decisions travel as tokens; the key stays for the log line.
    const kept: Array<{ threadKey: string; why: DiskKeepWhy }> = [];
    if (!verdict.fits) {
      const live = await this.liveBindings();
      const candidates: DiskEvictionCandidate[] = live.map((b) => ({
        threadKey: b.threadKey,
        ref: b.ref,
        lastAttachAt: b.lastAttachAt,
        busy: this.threadOpsInFlight.get(b.threadKey) ?? 0,
        isDefaultRef: b.ref === input.facts.defaultRef,
        sizeKiB: sample.parts.threads[b.threadKey] ?? null,
      }));
      const ordered = orderEvictionCandidates({ candidates, now: systemClock(), requestingThreadKey: input.threadKey });
      kept.push(...ordered.kept.map((k) => ({ threadKey: k.threadKey, why: k.why })));
      for (const c of ordered.order) {
        if (verdict.fits) break;
        const binding = live.find((b) => b.threadKey === c.threadKey);
        if (!binding) continue;
        const clean = await this.worktreeCleanliness(binding);
        if (!clean.clean) {
          kept.push({ threadKey: c.threadKey, why: "dirty" });
          continue;
        }
        // Same re-read guards as the sweep: the clean check awaited.
        const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(c.threadKey));
        if (
          !current ||
          current.evicted ||
          current.lastAttachAt !== binding.lastAttachAt ||
          (this.threadOpsInFlight.get(c.threadKey) ?? 0) > 0
        ) {
          kept.push({ threadKey: c.threadKey, why: "busy" });
          continue;
        }
        if (!(await this.evictBinding(current, true, "disk-pressure", DISK_PRESSURE_REASON))) {
          kept.push({ threadKey: c.threadKey, why: "other" });
          continue;
        }
        evicted.push({ threadKey: c.threadKey, freedKiB: c.sizeKiB });
        console.log(
          `disk-pressure: evicted ${c.threadKey} (${c.ref}, ${formatGiB(c.sizeKiB)} back) to make room for ${input.threadKey}`,
        );
        rawFree = rawFreeAfterEviction(rawFree, await this.dfSample(), c.sizeKiB);
        verdict = decide(rawFree);
      }
    }
    // `=== false`, not `!`: this package typechecks without `strict`, where
    // truthiness does not narrow a boolean-literal discriminant.
    const final = verdict;
    if (final.fits === false) {
      const reason = diskPressureReason({ verdict: final, evicted, kept });
      console.log(`attach ${input.threadKey}: ${reason}`);
      const s = await this.getStatus();
      return { error: reason, status: 503, state: s.state, reason: DISK_PRESSURE_REASON };
    }
    const m = final.math;
    console.log(
      `attach ${input.threadKey}: disk admitted — ${kind} ${formatGiB(m.projectedKiB)} projected, ${formatGiB(m.freeKiB)} free, ` +
        `reserve ${formatGiB(m.reserve.totalKiB)}, headroom ${formatGiB(m.headroomKiB)}${evicted.length > 0 ? `, evicted ${evicted.map((e) => e.threadKey).join(", ")}` : ""}`,
    );
    const committedKiB = m.projectedKiB ?? 0;
    this.diskCommittedKiB += committedKiB;
    return { admitted: true, committedKiB };
  }

  /** Refresh-on-attach, BOUNDED: if the resident was idle (or the last
   *  refresh is older than the active cadence), fetch the mirror now — seconds,
   *  under the mirror lock — so the ref this thread binds is current, clear
   *  idle mode, and pull the full refresh cycle (checkout rebuild if main
   *  moved: minutes) to +1s in the BACKGROUND. The attach never waits on an
   *  install/build, so a wake cannot become a cold-fallback generator. */
  private async refreshIfStale(resource: string): Promise<void> {
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!facts) return;
    const age = systemClock() - Date.parse(facts.lastRefreshAt);
    if (!facts.idleSince && age < REFRESH_INTERVAL_S * 1000) return;
    let token: string | null = null;
    if (githubAppConfigured(this.env)) {
      token = (await mintRepoScopedToken(this.env, resource.slice("repo:".length)).catch(() => null))?.token ?? null;
    }
    try {
      // Bounded like attach's own clone section: a full checkout rebuild
      // holding the mutex must not stall a wake attach for minutes — on
      // expiry (MirrorBusyError) proceed on the last mirror, same as a failed
      // fetch. The background full cycle armed below repays the staleness.
      await this.withMirrorLock(
        () =>
          this.gitWithCred(
            token,
            ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
            "wake-fetch",
            GIT_NETWORK_TIMEOUT_MS,
          ),
        ATTACH_MUTEX_WAIT_MS,
      );
    } catch (err) {
      console.log(
        `wake-fetch ${err instanceof MirrorBusyError ? "skipped (mirror busy)" : "failed"} — attach proceeds on the last mirror: ${errMsg(err)}`,
      );
    }
    // Re-read before writing: the awaits above yielded, and a concurrent
    // refresh cycle may have advanced facts (sha/lastRefreshAt) meanwhile —
    // never write a stale snapshot back over it.
    const fresh = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (fresh?.idleSince) {
      const { idleSince: _woke, ...awake } = fresh;
      await this.ctx.storage.put(FACTS_KEY, awake satisfies RepoFacts);
    }
    await this.armRefresh(resource, 1); // full cycle now, in the background; it re-arms at the active cadence
  }

  /** Pool users live in the IMAGE (Dockerfile useradd loop) while THREAD_USERS
   *  lives in the Worker. After a deploy that grows the pool, a still-running
   *  container lacks the new users and `install -o workerN` fails. Check the
   *  last pool user exists; if not and nothing is in flight, stop the container
   *  so it restarts on the current image (state is DO storage + R2 — the
   *  disk is a cache). Returns true when a stop was issued. */
  private async reconcileImage(where: string): Promise<boolean> {
    if (!(await this.isRuntimeActive().catch(() => false))) return false;
    const last = THREAD_USERS[THREAD_USERS.length - 1];
    const probe = await this.run(["id", "-u", last]);
    if (probe.exitCode === 0) return false;
    const busy = this.inFlightCount();
    if (busy > 0) {
      console.log(
        `image-stale (${where}): ${last} missing but ${busy} operation(s)/attach(es) in flight — deferring restart`,
      );
      return false;
    }
    console.log(
      `image-stale (${where}): ${last} missing in the running container — stopping so it restarts on the current image`,
    );
    this.clearIncarnationMemos(); // deliberate incarnation swap
    await this.stop().catch((err) => console.log(`image-stale: stop failed: ${errMsg(err)}`));
    return true;
  }

  // -- watchdog (the sparse cron that re-arms dead alarm chains) ---------------

  /** One watchdog pass over this resident (invoked by the Worker cron):
   *  re-arm a dead refresh chain and mark degraded(alarm-missed); time out an
   *  onboarding stuck past its budget → down(provision-timeout) + cap slot
   *  release; auto-rebuild a resident stuck down on unusable snapshots (one
   *  strike per pass, rebuild at AUTO_REBUILD_AFTER_STRIKES). Storage/
   *  schedule reads (plus the strike counter) only — containers start via the
   *  re-armed alarms, never in this pass. */
  async watchdogCheck(): Promise<{
    resource: string;
    state: ResidentState;
    reason: string;
    action: "none" | "rearmed" | "provision-timed-out" | "auto-rebuilt";
    /** Item 55: the last disk sample's gauge, for the watchdog's status line. */
    disk: { usedKiB: number; totalKiB: number; freeKiB: number; at: string } | null;
  }> {
    const [check, disk] = await Promise.all([this.watchdogCheckLifecycle(), this.diskGauge()]);
    return { ...check, disk };
  }

  private async watchdogCheckLifecycle(): Promise<{
    resource: string;
    state: ResidentState;
    reason: string;
    action: "none" | "rearmed" | "provision-timed-out" | "auto-rebuilt";
  }> {
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    const status = await this.getStatus();
    if (status.state === "onboarding") {
      const deadlineAt = await this.ctx.storage.get<number>(DEADLINE_AT_KEY);
      if (deadlineAt !== undefined && systemClock() > deadlineAt + 30_000) {
        const reason = "provision-timeout: onboarding stuck past its budget (watchdog)";
        await this.provisionTimedOut(reason);
        return { resource, state: "down", reason, action: "provision-timed-out" };
      }
      return { resource, ...status, action: "none" };
    }
    if (status.state === "down") {
      // Auto-rebuild escape hatch: only rehydration-flavored downs — the
      // snapshots themselves are the problem, and down chains never retry, so
      // without this the resident would stay down forever.
      if (REHYDRATION_FAILURE_RE.test(status.reason)) {
        const strikes = ((await this.ctx.storage.get<number>(REBUILD_STRIKES_KEY)) ?? 0) + 1;
        if (strikes >= AUTO_REBUILD_AFTER_STRIKES) {
          const record = await this.registry()
            .getRecord(resource)
            .catch(() => null);
          if (record) {
            const reason = `auto-rebuild: down for ${strikes} watchdog passes (${status.reason})`;
            await this.rebuild(resource, record.defaultRef, record.provisioningTimeoutMs, false);
            return { resource, state: "onboarding", reason, action: "auto-rebuilt" };
          }
        }
        await this.ctx.storage.put(REBUILD_STRIKES_KEY, strikes);
      }
      return { resource, ...status, action: "none" };
    }
    // Any serving state clears accumulated strikes (a recovery must reset the
    // counter, or an unrelated later down inherits stale strikes).
    await this.ctx.storage.delete(REBUILD_STRIKES_KEY);

    // The sweep chain has the same failure mode as the refresh chain (a DO
    // eviction mid-callback kills the self-rescheduling), but nothing re-armed
    // it: only an attach did, so a resident with live bindings and no traffic
    // never swept again (idle bindings sat for hours with no sweep).
    // Re-arm at +5s whenever live bindings exist and none is pending. Not a
    // lifecycle event — the sweep is housekeeping, no state flip. Runs BEFORE
    // the stale-mid-flight check so that branch's early return never skips it.
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const liveBindings = [...bindings.values()].some((b) => !b.evicted && b.user);
    // `sweepInFlight` is the explicit guard against arming a second chain while
    // a sweep is executing (its schedule row also stays listed until the callback
    // resolves, but that is a library detail we do not lean on).
    if (liveBindings && !this.sweepInFlight) {
      const pendingSweeps = await this.listSchedules(SWEEP_CALLBACK);
      // Config drift: a row armed by OLDER code (e.g. a daily sweep from
      // before the cadence shortened, due 24h out) is still honored by the runtime, so a
      // shorter SWEEP_INTERVAL_S never takes effect until it fires. Treat a row
      // due further out than the current interval (+ slack) as stale and
      // replace it, so a deploy that shortens the cadence applies within one
      // watchdog pass rather than after the old delay elapses.
      const nowS = Math.floor(systemClock() / 1000);
      const drifted = pendingSweeps.some((row) => (row.time ?? 0) - nowS > SWEEP_INTERVAL_S + SWEEP_DRIFT_SLACK_S);
      // Re-check the guard: listSchedules yielded, and a sweep that started
      // meanwhile owns the row its own `finally` is about to arm.
      if ((pendingSweeps.length === 0 || drifted) && !this.sweepInFlight) {
        this.deleteSchedules(SWEEP_CALLBACK);
        await this.schedule(5, SWEEP_CALLBACK, resource);
        // Disjoint by construction: inside this branch, a non-empty list implies `drifted`.
        console.log(
          `watchdog ${resource}: sweep ${pendingSweeps.length === 0 ? "chain was dead" : "row was due beyond the current interval (config drift)"} with live bindings — re-armed`,
        );
      }
    }

    // A mid-flight state older than STALE_MIDFLIGHT_MS with no cycle or restore
    // actually running is a marker orphaned by an interrupted cycle (DO evicted
    // by a deploy, platform restart). Left alone it is permanent — the idle gate
    // above only parks from `warm`, but nothing else would ever rewrite it, and
    // the bot's warm-gate keeps sending runs cold. Mark it degraded (visible —
    // named degradation, never a stall) and pull the next cycle to +5s so it normalizes.
    if (status.state === "refreshing" || status.state === "restoring") {
      const updatedAt = Date.parse((await this.ctx.storage.get<string>(UPDATED_KEY)) ?? "") || 0;
      // A hydration older than the stale bound counts as DEAD, not in flight:
      // its promise lives on SDK calls into a container that may have
      // been replaced under it, and a promise that never settles would
      // otherwise hold `this.hydration` non-null forever — making a stuck
      // `restoring` permanently invisible to this branch. No legitimate
      // restore approaches STALE_MIDFLIGHT_MS (a full R2 restore is ~1 min).
      const hydrationLive = this.hydration !== null && systemClock() - this.hydrationStartedAt <= STALE_MIDFLIGHT_MS;
      const inFlight = this.refreshesInFlight > 0 || hydrationLive;
      if (!inFlight && systemClock() - updatedAt > STALE_MIDFLIGHT_MS) {
        // The reads above yielded; a cycle that started meanwhile owns the
        // state now — leave it alone rather than stamp `degraded` over it.
        const again = await this.getStatus();
        const hydrationStillDead =
          this.hydration === null || systemClock() - this.hydrationStartedAt > STALE_MIDFLIGHT_MS;
        if (again.state !== status.state || this.refreshesInFlight > 0 || !hydrationStillDead) {
          return { resource, ...again, action: "none" };
        }
        // Drop the dead hydration reference so the re-armed cycle's
        // ensureHydrated starts a fresh restore instead of awaiting a promise
        // that will never settle. Safe: past the bound nothing on the other
        // end is still writing (the container it talked to is gone).
        this.hydration = null;
        const reason = `stale-mid-flight: ${status.state} since ${new Date(updatedAt).toISOString()} with no cycle running; re-armed by watchdog`;
        await this.setResidentState("degraded", reason);
        this.deleteSchedules(REFRESH_CALLBACK);
        await this.schedule(5, REFRESH_CALLBACK, resource);
        return { resource, state: "degraded", reason, action: "rearmed" };
      }
    }

    const pending = await this.listSchedules(REFRESH_CALLBACK);
    if (pending.length === 0) {
      await this.schedule(5, REFRESH_CALLBACK, resource);
      const reason = "alarm-missed: refresh chain was dead; re-armed by watchdog";
      // An in-flight restore owns its own state; everything else is visibly
      // degraded until the re-armed refresh succeeds.
      if (status.state !== "restoring") await this.setResidentState("degraded", reason);
      return { resource, state: "degraded", reason, action: "rearmed" };
    }
    return { resource, ...status, action: "none" };
  }

  // -- thread data plane (attach / exec / read / write / sweep) ----------------

  /** Run a shell string privilege-dropped as the thread's OS user with the
   *  worktree as cwd. Never root, never a token in env or argv — the
   *  only injected env var is GIT_TERMINAL_PROMPT, validated like every
   *  injection. The worktree path is built from slugged components, so
   *  embedding it in the -c string is shell-safe.
   *
   *  `capBytes`: when set, the command's streams are bounded
   *  INSIDE the container (`capWrappedCommand` — full output to container-disk
   *  temp files, only the capped head crosses the RPC), so a verbose test/build
   *  run can no longer materialize tens of MB inside this 128 MB DO isolate
   *  before the char-cap slice. Exit code, stream separation, and the DO-side
   *  `truncated` logic are preserved exactly (`capBytesFor`). Unset for the
   *  engine's own small probes — their outputs are parsed, never user-sized. */
  private async threadRun(
    user: string,
    worktreePath: string,
    command: string,
    timeoutMs: number,
    capBytes?: number,
    capFiles?: { out: string; err: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const injected = { GIT_TERMINAL_PROMPT: "0" };
    validateEnvNames(injected);
    const body = capBytes
      ? capWrappedCommand(worktreePath, command, capBytes, capFiles)
      : `cd ${worktreePath} && ${command}`;
    return this.run(["su", "-s", "/bin/bash", user, "-c", body], {
      timeoutMs,
      env: injected,
    });
  }

  /** Capped thread run with hung-run salvage: a timeout kill skips the
   *  wrapper's own head/cleanup lines, so what the command wrote before dying
   *  is recovered — the same capped heads — with one follow-up command that
   *  also removes the files. Recovery is best-effort; its failure leaves the
   *  timeout result exactly as the kill left it (empty streams). */
  private async threadRunCapped(
    user: string,
    worktreePath: string,
    command: string,
    timeoutMs: number,
    charCap: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const capBytes = capBytesFor(charCap);
    const files = execCapFiles();
    const r = await this.threadRun(user, worktreePath, command, timeoutMs, capBytes, files);
    if (!r.timedOut) return r;
    try {
      const rec = await this.threadRun(
        user,
        worktreePath,
        recoverCapturedOutput(files, capBytes),
        DEFAULT_EXEC_TIMEOUT_MS,
      );
      return { ...r, stdout: rec.stdout, stderr: rec.stderr };
    } catch (err) {
      console.log(`exec: timeout-output recovery failed (${errMsg(err)}) — returning the bare timeout result`);
      return r;
    }
  }

  private async threadRunOk(
    user: string,
    worktreePath: string,
    command: string,
    step: string,
    timeoutMs: number,
  ): Promise<string> {
    return this.assertOk(await this.threadRun(user, worktreePath, command, timeoutMs), step);
  }

  /** The user-pool scan shared by both allocators: live bindings (optionally
   *  ignoring one threadKey's own binding) plus users transiently held by
   *  in-flight ops mark the pool as used — an attach must never share an OS
   *  user with a running op, and vice versa. Storage reads + set reads only,
   *  so callers stay atomic under the DO input gate. */
  private async findFreePoolUser(excludeThreadKey?: string): Promise<string | undefined> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const used = new Set(
      [...all.values()].filter((b) => !b.evicted && b.user && b.threadKey !== excludeThreadKey).map((b) => b.user),
    );
    for (const u of this.opUsersInUse) used.add(u);
    return THREAD_USERS.find((u) => !used.has(u));
  }

  /** Storage-only allocation (atomic under the DO input gate: get → list →
   *  put touches nothing but this object's storage, so two concurrent
   *  attaches cannot both claim the same user). Sticky: an existing live
   *  binding is reused as-is; an evicted binding keeps its ref and
   *  gets a fresh user from the pool. */
  private async allocateThreadUser(
    threadKey: string,
    ref: string,
    worktreePath: string,
  ): Promise<{ binding: ThreadBinding; wrote: boolean } | ThreadErr> {
    const key = threadBindingKey(threadKey);
    const existing = await this.ctx.storage.get<ThreadBinding>(key);
    if (existing && !existing.evicted && existing.user) return { binding: existing, wrote: false };
    const user = await this.findFreePoolUser(threadKey);
    if (!user) {
      return {
        error: `user-pool-exhausted: all ${THREAD_USERS.length} thread users are allocated; wait for the inactivity sweep or evict a thread`,
        status: 429,
      };
    }
    const now = new Date(systemClock()).toISOString();
    const binding: ThreadBinding = {
      threadKey,
      ref: existing?.ref ?? ref, // sticky across eviction
      user,
      worktreePath: existing?.worktreePath ?? worktreePath,
      boundAt: existing?.boundAt ?? now,
      lastAttachAt: now,
      evicted: false,
    };
    await this.ctx.storage.put(key, binding);
    return { binding, wrote: true };
  }

  /** POST /attach: idempotent per-thread workspace materialization.
   *  Validated inputs only (the Worker enforces the patterns before this is
   *  ever called). Flow: hydrate → resolve/blind the ref binding → allocate
   *  a pool user → (mirror mutex) verify ref, wipe dirty/stale trees,
   *  clone → materialize deps → per-attach credential file.
   *  `wantSha` (item 51): the commit the caller expects the ref to be at — a
   *  mirror whose ref tip is not that commit is fetched before the clone. */
  async attachThread(
    threadKey: string,
    refHint: string | null,
    readonly = false,
    wantSha: string | null = null,
    record?: ResidentRecord,
    traceparent?: string,
  ): Promise<AttachOk | ThreadErr> {
    // One step trace per attach (docs/reference/specs/tracing.md item 19): every command
    // the attach runs lands on it, and the answer carries it.
    const t0 = systemClock();
    const trace = createStepTrace(t0);
    const res = await this.stepTrace.run(trace, () =>
      this.attachThreadTraced(threadKey, refHint, readonly, wantSha, record, t0),
    );
    // The same steps as the resident's own `resident.attach` root (item 22).
    emitStepRoot("resident.attach", t0, trace.steps(), traceparent, "error" in res ? refusalOutcome(res) : "ok");
    // A refusal carries the steps that led to it; a success already does.
    return "error" in res ? { ...res, trace: trace.steps() } : res;
  }

  private async attachThreadTraced(
    threadKey: string,
    refHint: string | null,
    readonly: boolean,
    wantSha: string | null,
    record: ResidentRecord | undefined,
    t0: number,
  ): Promise<AttachOk | ThreadErr> {
    try {
      await this.ensureHydrated();
      const resourceId = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
      if (await this.reconcileImage("attach")) {
        return {
          error: "image-stale: the container predates the current pool and is restarting; retry shortly",
          status: 503,
          state: "restoring",
          reason: "image-stale",
        };
      }
      // From here the attach may hold the mirror lock through clone/install:
      // count it so a concurrent refresh-cycle reconcileImage never stops the
      // container under it (and isIdle never parks the alarm mid-attach).
      this.attachesInFlight++;
      try {
        return await this.attachThreadBody(threadKey, refHint, readonly, wantSha, resourceId, t0, record);
      } finally {
        this.attachesInFlight--;
      }
    } catch (err) {
      return { error: `attach-failed: ${errMsg(err)}`, status: 500 };
    }
  }

  /** A failed attach step after its rollback: the 500 the caller falls back
   *  on, named by step. A step that died of a full disk (docs/reference/specs/resident-repos.md item 54) also
   *  flips the resident `degraded(disk-full: …)` — not serviceable, so the
   *  next dispatch goes cold without attaching (the card names the disk, not
   *  `/etc/gitconfig.lock`) — and pulls the refresh cycle to now, where the
   *  recovery decision lives (an attach never stops the container itself: it
   *  is in flight). */
  private async attachFailed(err: unknown, resource: string): Promise<ThreadErr> {
    if (!(err instanceof StepError)) return { error: `attach-failed: ${errMsg(err)}`, status: 500 };
    const failure = await this.classifyFailure(err.step, err.message);
    if (!failure.diskFull) return { error: `attach-failed at ${err.step}: ${err.message}`, status: 500 };
    console.log(`attach: ${failure.reason}`);
    await this.setResidentState("degraded", failure.reason);
    await this.armRefresh(resource, DISK_FULL_REARM_S);
    return { error: `attach-failed: ${failure.reason}`, status: 500 };
  }

  private async attachThreadBody(
    threadKey: string,
    refHint: string | null,
    readonly: boolean,
    wantSha: string | null,
    resourceId: string,
    t0: number,
    recordFromRoute?: ResidentRecord,
  ): Promise<AttachOk | ThreadErr> {
    try {
      await this.refreshIfStale(resourceId);
    } catch (err) {
      const s = await this.getStatus();
      return { error: `not-serviceable: ${errMsg(err)}`, status: 503, state: s.state, reason: s.reason };
    }
    // `resourceId` was read by the caller a moment ago (item 15 of the audit:
    // this used to re-read the same key), the registry record rides in from
    // the route's own onboarded check (same read, milliseconds earlier — the
    // fallback lookup keeps any other caller working), and the two remaining
    // storage reads go in ONE round trip.
    const resource = resourceId;
    const slug = resource.slice("repo:".length);
    const stored = await this.ctx.storage.get<RepoFacts | ThreadBinding>([FACTS_KEY, threadBindingKey(threadKey)]);
    const facts = stored.get(FACTS_KEY) as RepoFacts | undefined;
    const record = recordFromRoute ?? (await this.registry().getRecord(resource));
    if (!record || !facts) return { error: "not-serviceable: registry record or repo facts missing", status: 503 };

    const prior = stored.get(threadBindingKey(threadKey)) as ThreadBinding | undefined;
    const ref = prior?.ref ?? refHint; // the binding's ref wins for the thread's whole life
    if (!ref) {
      // Name the default branch so the bot can bind to it (loudly) instead of
      // asking the user when the message named no branch; the binding is still
      // made by the caller's next attach, never here (explicit, no guess).
      return {
        error: "needs-ref: this thread has no ref binding yet — supply refHint",
        status: 409,
        needs: "ref",
        defaultRef: facts.defaultRef,
      };
    }
    const worktreePath = prior?.worktreePath ?? (await threadWorktreePath(threadKey, ref));
    // Read-only vs writable (item 50): decided here, once, from the request
    // and the prior binding's mode — the tested pure helper is the shipped code.
    const mode = planReadonlyAttach({ readonly, prior, slug, mirrorDir: MIRROR_DIR });

    const alloc = await this.allocateThreadUser(threadKey, ref, worktreePath);
    if ("error" in alloc) return alloc;
    const binding = alloc.binding;
    // "Nothing created" on failure: a FRESH allocation (new binding or a
    // re-allocation after eviction) is rolled back if the attach fails below,
    // so a bogus refHint can neither bind sticky garbage nor leak a pool user.
    const rollback = async (): Promise<void> => {
      if (!alloc.wrote) return;
      if (prior) await this.ctx.storage.put(threadBindingKey(threadKey), prior);
      else await this.ctx.storage.delete(threadBindingKey(threadKey));
    };

    // Disk admission (item 55): before the lock, since making room takes it.
    const admission = await this.admitThreadDisk({ threadKey, binding, facts, record });
    if ("error" in admission) {
      await rollback();
      return admission;
    }
    try {
      return await this.attachThreadCreate({
        threadKey,
        refHint,
        wantSha,
        resource,
        slug,
        t0,
        facts,
        record,
        binding,
        mode,
        rollback,
      });
    } finally {
      this.diskCommittedKiB -= admission.committedKiB;
    }
  }

  /** The second half of an attach, past disk admission: mint, fetch + clone
   *  under the mirror lock, deps, credentials, the binding write. Split from
   *  `attachThreadBody` only so the admission's commitment is released on every
   *  exit path in one `finally`. */
  private async attachThreadCreate(input: {
    threadKey: string;
    refHint: string | null;
    wantSha: string | null;
    resource: string;
    slug: string;
    t0: number;
    facts: RepoFacts;
    record: ResidentRecord;
    binding: ThreadBinding;
    mode: ReturnType<typeof planReadonlyAttach>;
    rollback: () => Promise<void>;
  }): Promise<AttachOk | ThreadErr> {
    const { threadKey, refHint, wantSha, resource, slug, t0, facts, record, binding, mode, rollback } = input;

    // Command-level token mint — before the lock so mint latency
    // never holds the mutex, and failure never blocks the attach.
    let token: string | null = null;
    let tokenExpiresAtMs: number | null = null;
    let credentialsError: string | undefined;
    if (!mode.credentialFile) {
      // Read-only: no token for the TREE — nothing to leak, nothing to push with.
    } else if (githubAppConfigured(this.env)) {
      try {
        const minted = await mintRepoScopedToken(this.env, slug);
        token = minted.token;
        tokenExpiresAtMs = minted.expiresAtMs;
      } catch (err) {
        credentialsError = errMsg(err);
      }
    } else {
      credentialsError = "github-app-not-configured: GITHUB_APP_* secrets are unset";
    }
    // The mirror's recovery fetch — a ref pushed since the last refresh cycle:
    // missing from the mirror, or present at a tip that is not the commit the
    // caller expects (`wantSha`, item 51) — is the RESIDENT's operation: root,
    // against the mirror, never inside the tree — so a read-only attach must
    // not lose it: mint a fetch-only token when a fetch is due and none was
    // minted above. Outside the lock (mint latency never holds the mutex); the
    // pre-check is a racy read that only decides whether to mint, the
    // authoritative check runs under the lock.
    // The expected head applies to the ref it was resolved for; a sticky
    // binding on another branch drops it (item 51) rather than fetching on
    // every attach of a thread that can never be at that commit.
    const want = wantShaForBinding({ boundRef: binding.ref, refHint, wantSha });
    let fetchToken: string | null = token;
    if (!fetchToken && githubAppConfigured(this.env) && (await this.mirrorNeedsFetchFor(binding.ref, want))) {
      fetchToken = (await mintRepoScopedToken(this.env, slug).catch(() => null))?.token ?? null;
    }

    let locked: { value: { sha: string; threadLockKey: string; recreated: boolean }; waitedMs: number };
    try {
      locked = await this.withMirrorLock(async () => {
        await this.ensureGitSetup();
        if (await this.mirrorNeedsFetchFor(binding.ref, want)) {
          await this.gitWithCred(
            fetchToken,
            ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
            "fetch",
            GIT_NETWORK_TIMEOUT_MS,
          );
          if (!(await this.refExists(binding.ref))) {
            throw new StepError(
              "unknown-ref",
              `ref ${JSON.stringify(binding.ref)} does not resolve in the mirror (even after a fetch)`,
            );
          }
        }
        const sha = await this.readMirrorSha(binding.ref);
        const threadLockKey = await this.lockfileKey(sha);
        const recreated = await this.ensureThreadWorktree(binding, sha, mode.originUrl, mode.modeSwitch);
        return { sha, threadLockKey, recreated };
      }, ATTACH_MUTEX_WAIT_MS);
    } catch (err) {
      await rollback();
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      if (err instanceof StepError && err.step === "unknown-ref") {
        return { error: `unknown-ref: ${err.message}`, status: 400 };
      }
      return this.attachFailed(err, resource);
    }

    let deps: { deps: ThreadDepsMechanism; reconciled: boolean; depsKey?: string };
    let credentials: AttachOk["credentials"] = mode.readonly ? "none" : "unavailable";
    let credentialsWrittenAt: number | undefined;
    let credentialTokenExpiresAtMs: number | undefined;
    try {
      deps = await this.materializeThreadDeps(
        binding,
        locked.value.threadLockKey,
        locked.value.sha,
        facts.lockfileHash,
        record.commands.install,
      );
      if (mode.scrubCredentials) {
        // Every read-only attach, reused tree included: a tree built before
        // this rule (or by a writable attach on this thread) may carry a file.
        await this.scrubThreadCredentials(binding);
      } else if (token) {
        credentialsWrittenAt = await this.writeThreadCredentials(binding, token);
        // Persist the token's expiry beside the write time so the first writable
        // exec refreshes off the token's own life, not the file's age.
        credentialTokenExpiresAtMs = tokenExpiresAtMs ?? undefined;
        credentials = "ok";
      }
    } catch (err) {
      await rollback();
      // The deps hardlink-copy now waits on the mirror mutex (FIX 2): a
      // timed-out acquire surfaces as 503 mirror-busy, same as the fetch/
      // worktree lock above, so the bot-side fallback can retry.
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      return this.attachFailed(err, resource);
    }

    // The prior write time and token expiry never survive an attach: a
    // read-only attach scrubbed the file, a writable one either rewrote it
    // (stamped below) or could not — and "unknown" is what makes the next exec
    // re-mint.
    const { credentialsWrittenAt: _prior, tokenExpiresAtMs: _priorExp, ...bindingSansCred } = binding;
    await this.ctx.storage.put(threadBindingKey(threadKey), {
      ...bindingSansCred,
      lastAttachAt: new Date(systemClock()).toISOString(),
      deps: deps.deps,
      // A reused tree keeps the key it was linked from (spread above).
      ...(deps.depsKey ? { depsKey: deps.depsKey } : {}),
      sha: locked.value.sha,
      readonly: mode.readonly,
      // A writable attach that could not mint keeps nothing to date: the next
      // exec sees the file missing and re-mints (or logs and runs without).
      ...(credentialsWrittenAt !== undefined ? { credentialsWrittenAt } : {}),
      ...(credentialTokenExpiresAtMs !== undefined ? { tokenExpiresAtMs: credentialTokenExpiresAtMs } : {}),
    } satisfies ThreadBinding);
    if ((await this.listSchedules(SWEEP_CALLBACK)).length === 0) {
      await this.schedule(SWEEP_INTERVAL_S, SWEEP_CALLBACK, resource);
    }
    // Item 55: the tree is on disk now — measure it (deferred; the `du` stays
    // off this hot path) so the next admission projects from current parts.
    await this.scheduleDiskMeasure(resource);

    return {
      workspace: binding.worktreePath,
      ref: binding.ref,
      sha: locked.value.sha,
      user: binding.user,
      reconciled: deps.reconciled,
      recreated: locked.value.recreated,
      deps: deps.deps,
      credentials,
      ...(credentialsError ? { credentialsError } : {}),
      readonly: mode.readonly,
      mutexWaitMs: locked.waitedMs,
      attachMs: systemClock() - t0,
      trace: this.currentSteps(),
    };
  }

  /** Ensure the worktree exists, wiping dirty/stale trees. Returns
   *  true when the tree was (re)created. MUST be called holding the mirror
   *  mutex — the clone reads the mirror.
   *
   *  "Dirty" is tracked-file dirt (`status --porcelain -uno`): untracked
   *  scratch files are the thread's own state and survive re-attach.
   *  "Stale" is a HEAD that is neither the mirror's current ref tip nor a
   *  local descendant of it (thread commits on top of the tip are kept).
   *
   *  Mechanism note: per-thread trees are LOCAL CLONES of the mirror with
   *  --no-hardlinks, not `git worktree` checkouts. A worktree checkout keeps
   *  its index/objects inside the root-owned mirror (thread commits would
   *  need write access there), and hardlinked objects would let a chown-ed
   *  owner chmod shared inodes under every other tree. A no-hardlink clone
   *  gives the thread user a fully-owned repo whose writes stay in its own
   *  .git; `origin` is repointed at GitHub so fetch/push use the per-attach
   *  credential file rather than the (deliberately unreadable) mirror. */
  private async ensureThreadWorktree(
    binding: ThreadBinding,
    sha: string,
    originUrl: string,
    modeSwitch: boolean,
  ): Promise<boolean> {
    const wt = binding.worktreePath;
    const threadDir = parentDir(wt);
    await this.runOk(["install", "-d", "-m", "755", "-o", "root", "-g", "root", THREADS_DIR], "threads-dir");
    // 700 + thread-user ownership: other thread users cannot traverse in.
    await this.runOk(["install", "-d", "-m", "700", "-o", binding.user, "-g", binding.user, threadDir], "thread-dir");

    // A tree built for the other mode (item 50) is wiped before any other
    // check: a mirror-origin, credential-less tree must never serve a
    // writable run, and a GitHub-origin tree must never serve a read-only one.
    let recreate = modeSwitch;
    const exists = !recreate && (await this.run(["test", "-d", `${wt}/.git`])).exitCode === 0;
    if (exists) {
      const status = await this.threadRun(binding.user, wt, "git status --porcelain -uno", DEFAULT_EXEC_TIMEOUT_MS);
      const head = await this.threadRun(binding.user, wt, "git rev-parse HEAD", DEFAULT_EXEC_TIMEOUT_MS);
      if (status.exitCode !== 0 || head.exitCode !== 0) {
        recreate = true; // unreadable/corrupt (or owned by a previous pool user)
      } else if (status.stdout.trim() !== "") {
        recreate = true; // dirty tracked files
      } else {
        const headSha = head.stdout.trim();
        if (headSha !== sha) {
          const anc = await this.threadRun(
            binding.user,
            wt,
            `git merge-base --is-ancestor ${sha} HEAD`,
            DEFAULT_EXEC_TIMEOUT_MS,
          );
          if (anc.exitCode !== 0) recreate = true; // stale: behind/diverged from the mirror tip
        }
      }
      if (!recreate) return false;
    }

    await this.runOk(["rm", "-rf", wt], "worktree-clean");
    await this.runOk(["git", "clone", "--no-hardlinks", "--branch", binding.ref, MIRROR_DIR, wt], "worktree-clone", {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    await this.runOk(["chown", "-R", `${binding.user}:${binding.user}`, wt], "worktree-chown");
    // Writable: origin → GitHub (fetch/push via the per-attach credential file).
    // Read-only: origin stays the local mirror, which thread users cannot
    // traverse (root:worker1 750) — fetch/push fail legibly, while the
    // clone-time remote-tracking refs still serve `git diff origin/<base>...HEAD`.
    await this.threadRunOk(
      binding.user,
      wt,
      `git remote set-url origin ${shellQuote(originUrl)}`,
      "worktree-remote",
      DEFAULT_EXEC_TIMEOUT_MS,
    );
    return true;
  }

  /** Read-only attach (item 50): make sure the tree carries no credential file
   *  and no credential helper — idempotent, run on every read-only attach. */
  private async scrubThreadCredentials(binding: ThreadBinding): Promise<void> {
    const cred = `${binding.worktreePath}/.git/github-credentials`;
    await this.threadRunOk(
      binding.user,
      binding.worktreePath,
      `rm -f ${cred} && (git config --unset-all credential.helper || true)`,
      "thread-cred-scrub",
      DEFAULT_EXEC_TIMEOUT_MS,
    );
  }

  /** Run one dep-cache script (`depCacheScript` / `mutableCacheSwapScript`)
   *  and parse its tagged output. A failure throws the StepError the old
   *  per-spawn code would have thrown: the step comes from the script's
   *  `err=` tag (falling back to `fallbackStep` when the script died before
   *  tagging), the message from both streams, exactly like assertOk. */
  private async runDepScript(script: string, fallbackStep: string, timeoutMs: number) {
    const r = await this.run(["sh", "-c", script], { timeoutMs });
    const parsed = parseDepCacheScriptOutput(r.stdout);
    if (r.exitCode !== 0 || r.timedOut) {
      const step = parsed.failedStep ?? fallbackStep;
      console.log(stepFailureLog(step, r));
      throw new StepError(step, describeStepFailure(r));
    }
    return parsed;
  }

  /** Materialize the dep/build cache. Same committed-lockfile key as
   *  the warm checkout → per-dir mechanism from `depCacheMaterialization`:
   *  node_modules is hardlink-copied (cp -al), chowning only DIRECTORIES to
   *  the thread user: file inodes stay worker1-owned and read-only to the
   *  thread, so a thread can delete or replace entries in its own tree but
   *  can never mutate the inodes shared with the warm checkout (cp -al
   *  failing, e.g. cross-device, falls back to the plain copy) — except the
   *  tool-managed paths named by `mutableCachePaths` (top-level dot entries
   *  such as .cache/.vite/.prisma/.bin, nested .cache dirs), which builds and
   *  test runs rewrite in place and so are swapped for real copies. Build output
   *  dirs (dist/build/out/.next) are plain-copied — fresh inodes, fully
   *  chowned — because the review agent and `/op build` rebuild them IN
   *  PLACE, which a shared read-only inode refuses with EACCES.
   *  The whole per-dir mechanism runs as TWO container forks:
   *  `depCacheScript` handles all five dirs and emits tagged mechanism +
   *  mutable-listing lines, `mutableCacheSwapScript` performs the swaps —
   *  instead of ~25 sequential spawns, all of which would hold the mirror
   *  mutex. Ownership/permission results are identical (residentDepCache.ts).
   *  A differing key runs the repo's install command in the worktree,
   *  token-free, as the thread user. */
  private async materializeThreadDeps(
    binding: { user: string; worktreePath: string }, // a ThreadBinding, or a per-op checkout
    threadLockKey: string,
    sha: string,
    warmLockKey: string,
    installCmd: string | undefined,
  ): Promise<{ deps: ThreadDepsMechanism; reconciled: boolean; depsKey?: string }> {
    const wt = binding.worktreePath;
    const hasDeps = (await this.run(["test", "-d", `${wt}/node_modules`])).exitCode === 0;
    // The plan is pure (planThreadDeps, item 58): a reused tree is left alone;
    // a matching lockfile is seeded from the shared cache; a diverged lockfile
    // is seeded AND reconciled by the install. Item 59 moves where that
    // happens: the shared cache is the deps store, and the reconcile runs ONCE
    // per key inside the store's install (seeded from the warm key's entry) —
    // every thread on the key, this one included, then hardlinks the result.
    const plan = planThreadDeps({ hasDeps, threadLockKey, warmLockKey, installCmd });
    if (!plan.seed) return { deps: "none", reconciled: false };
    if (installCmd === undefined) {
      // No install command (item 52): there is no deps entry, but the build
      // step still ran at provisioning, so the tree still gets the checkout's
      // build dirs (and its node_modules, if a build produced one) — the
      // pre-store view, from the checkout itself.
      const seeded = await this.materializeDepsView(null, wt, binding.user);
      return { deps: threadDepsMechanism({ seeded, installed: false }), reconciled: false };
    }
    // The warm key's entry is guaranteed: provisioning/refresh put it there,
    // and a disk from before the store (or a fresh restore) adopts the
    // checkout's own node_modules into it.
    await this.ensureWarmDepsInStore(warmLockKey);
    if (plan.install) console.log(`deps ${wt}: ${plan.why}`);
    const entry = await this.materializeDeps(threadLockKey, sha, installCmd, REFRESH_INSTALL_TIMEOUT_MS, {
      seedFromKey: warmLockKey,
    });
    const seeded = await this.materializeDepsView(`${entry}/node_modules`, wt, binding.user);
    return {
      deps: threadDepsMechanism({ seeded, installed: plan.install }),
      reconciled: plan.install,
      depsKey: threadLockKey,
    };
  }

  // -- deps store (item 59) ----------------------------------------------------

  private depsStoreDirReady = false;
  /** key → the entry path promise of the install running for it in this
   *  incarnation; a second caller joins instead of installing twice. */
  private depsInFlight = new Map<string, Promise<string>>();
  /** Keys whose entry archive is uploading (item 61 PR B): protected from
   *  eviction like an install in flight, and never archived twice at once. */
  private depsBackupsInFlight = new Set<string>();
  /** Parallel install slots = cores (`nproc`, read once per incarnation). */
  private depsInstallSlots: number | null = null;
  private depsInstallRunning = 0;
  private depsInstallWaiters: Array<() => void> = [];

  private async ensureDepsStoreDir(): Promise<void> {
    if (this.depsStoreDirReady) return;
    await this.runOk(["install", "-d", "-m", "755", "-o", "root", "-g", "root", DEPS_STORE_DIR], "deps-store-dir");
    this.depsStoreDirReady = true;
  }

  private async depsEntryComplete(key: string): Promise<boolean> {
    return (await this.run(["test", "-f", depsCompletePath(key)])).exitCode === 0;
  }

  /** THE primitive (item 59): the store path holding `key`'s node_modules,
   *  complete. Hit → touch `.used`, return. An install already running for
   *  the key → join its promise. Miss → install once, outside every lock: the
   *  scratch clone reads the mirror's objects through alternates and touches
   *  no consumer's tree, so a full install never holds every attach
   *  behind the mirror mutex. `budgetMs` bounds the install step; a
   *  joiner inherits the running install's budget. */
  private async materializeDeps(
    key: string,
    sha: string,
    installCmd: string,
    budgetMs: number,
    /** `seedFromKey`: a complete entry to hardlink into the scratch tree
     *  before the install, so npm reconciles the delta (item 58) instead of
     *  extracting every package — and the two entries share every unchanged
     *  inode. Ignored when it is the key itself or has no complete entry.
     *  `restoreDeadlineMs`: the absolute deadline the `restore` backing is
     *  judged against — the wake path passes its ONE hydrate deadline so the
     *  `restoring` span stays under RESTORE_MAX_MS in total (the hydrate
     *  invariant); every other caller gets `min(budgetMs, RESTORE_MAX_MS)`
     *  from now, so an attach never waits longer for a download than it
     *  would for an install. */
    opts: { seedFromKey?: string; restoreDeadlineMs?: number } = {},
  ): Promise<string> {
    const backupRecord = await this.depsBackupRecord(key);
    const plan = planDepsMaterialization({
      complete: await this.depsEntryComplete(key),
      inFlight: this.depsInFlight.has(key),
      backup: backupRecord !== undefined,
    });
    if (plan.action === "hit") {
      await this.run(["touch", depsUsedPath(key)]);
      return depsEntryPath(key);
    }
    if (plan.action === "join") return this.depsInFlight.get(key) as Promise<string>;
    // `restore` (item 61 PR B): the key's archive comes down into a scratch
    // tree and commits like an install would. A restore that fails for any
    // reason drops the record (an expired or missing archive would fail the
    // same way next time) and falls through to the installer, which records
    // a fresh backup — never a stranded key.
    const restoreDeadlineMs = opts.restoreDeadlineMs ?? systemClock() + Math.min(budgetMs, RESTORE_MAX_MS);
    const p = (
      plan.action === "restore" && backupRecord
        ? this.restoreDepsEntry(key, backupRecord, restoreDeadlineMs).catch(async (err) => {
            console.log(`deps: restore of ${key.slice(0, 8)} failed — installing instead: ${errMsg(err)}`);
            await this.dropDepsBackups([key]).catch(() => {});
            return this.installDepsEntry(key, sha, installCmd, budgetMs, opts);
          })
        : this.installDepsEntry(key, sha, installCmd, budgetMs, opts)
    ).finally(() => this.depsInFlight.delete(key));
    this.depsInFlight.set(key, p);
    return p;
  }

  private async depsBackupRecord(key: string): Promise<DepsBackupRecord | undefined> {
    return this.ctx.storage.get<DepsBackupRecord>(depsBackupStorageKey(key));
  }

  /** Archive a freshly committed entry to R2, once (docs/reference/specs/resident-repos.md
   *  item 61). Runs after the commit, off the caller's critical path — the
   *  entry is already serving — and only in presigned mode: local-bucket mode
   *  would put the Durable Object in the data path of a deps-sized upload, the
   *  very class of failure presigned transfers exist to remove. Housekeeping:
   *  a failure is a log line; the next
   *  wake installs, as before. The key stays protected from eviction while
   *  the upload runs (`depsBackupsInFlight`). */
  private async backupDepsEntry(key: string): Promise<void> {
    if (this.depsBackupsInFlight.has(key) || (await this.depsBackupRecord(key))) return;
    const transfer = backupTransferMode(this.env as unknown as Record<string, unknown>);
    if (transfer.mode === "local") return;
    this.depsBackupsInFlight.add(key);
    const t0 = systemClock();
    try {
      const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
      const backup = await withTimeout(
        this.createBackup({
          dir: `${depsEntryPath(key)}/node_modules`,
          localBucket: transfer.localBucket,
          ttl: DEPS_BACKUP_TTL_S,
          name: `${resource} deps ${key.slice(0, 8)}`,
        }),
        R2_TRANSFER_TIMEOUT_MS,
        "deps backup",
      );
      // The entry may have been evicted or replaced while the archive was
      // taken (it is protected, but a rebuild wipes the disk): record only
      // what still describes a complete entry.
      if (!(await this.depsEntryComplete(key))) {
        await this.deleteBackupObjects([backup.id]).catch(() => {});
        return;
      }
      const record: DepsBackupRecord = { key, backup, createdAt: new Date(systemClock()).toISOString() };
      await this.ctx.storage.put(depsBackupStorageKey(key), record);
      console.log(`deps: backed up ${key.slice(0, 8)} in ${systemClock() - t0}ms`);
    } catch (err) {
      console.log(`deps: backup of ${key.slice(0, 8)} failed: ${errMsg(err)}`);
    } finally {
      this.depsBackupsInFlight.delete(key);
    }
  }

  /** The `restore` backing of materializeDeps (item 61 PR B): download the
   *  key's archive into a private scratch tree — the SDK extracts wherever
   *  the handle's `dir` says, so the handle is re-pointed at the scratch —
   *  judged by the bytes arriving like every restore (restoreWithProgress),
   *  then the same commit script an install ends with: staging, atomic
   *  rename, `.complete` LAST. A partial download never becomes an entry.
   *  `deadlineMs` is the caller's (see materializeDeps): never a fresh cap. */
  private async restoreDepsEntry(key: string, record: DepsBackupRecord, deadlineMs: number): Promise<string> {
    const attempt = crypto.randomUUID().slice(0, 8);
    const scratch = depsScratchPath(attempt);
    const staging = depsStagingPath(key, attempt);
    const t0 = systemClock();
    try {
      await this.ensureDepsStoreDir();
      console.log(`deps: restoring ${key.slice(0, 8)} from backup ${record.backup.id.slice(0, 8)} into ${scratch}`);
      await this.runOk(["mkdir", "-p", scratch], "deps-restore-scratch");
      await this.restoreExtracted(
        record.backup,
        `${scratch}/node_modules`,
        `deps restore ${key.slice(0, 8)}`,
        "deps-restore-extract",
        deadlineMs,
      );
      await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, scratch], "deps-restore-chown");
      await this.runOk(
        [
          "sh",
          "-c",
          depsStoreCommitScript({
            scratchDir: scratch,
            stagingDir: staging,
            entryDir: depsEntryPath(key),
            completePath: depsCompletePath(key),
          }),
        ],
        "deps-restore-commit",
        { timeoutMs: GIT_NETWORK_TIMEOUT_MS },
      );
      console.log(`deps: restored ${key.slice(0, 8)} from backup in ${systemClock() - t0}ms`);
      return depsEntryPath(key);
    } catch (err) {
      await this.run(["rm", "-rf", scratch, staging]).catch(() => {});
      throw err;
    }
  }

  /** Forget entry backups: the records and the R2 objects behind them. */
  private async dropDepsBackups(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const records = await this.ctx.storage.get<DepsBackupRecord>(keys.map((k) => depsBackupStorageKey(k)));
    const ids = [...records.values()].map((r) => r.backup.id);
    await this.ctx.storage.delete(keys.map((k) => depsBackupStorageKey(k)));
    return this.deleteBackupObjects(ids);
  }

  private async allDepsBackups(): Promise<DepsBackupRecord[]> {
    const all = await this.ctx.storage.list<DepsBackupRecord>({ prefix: DEPS_BACKUP_KEY_PREFIX });
    return [...all.values()];
  }

  private async installDepsEntry(
    key: string,
    sha: string,
    installCmd: string,
    budgetMs: number,
    opts: { seedFromKey?: string },
  ): Promise<string> {
    await this.acquireDepsInstallSlot();
    const attempt = crypto.randomUUID().slice(0, 8);
    const scratch = depsScratchPath(attempt);
    const staging = depsStagingPath(key, attempt);
    const t0 = systemClock();
    try {
      await this.ensureDepsStoreDir();
      console.log(`deps: installing ${key.slice(0, 8)} at ${sha.slice(0, 8)} in ${scratch}`);
      await this.runOk(depsScratchCloneArgv({ mirrorDir: MIRROR_DIR, scratchDir: scratch, sha }), "deps-scratch", {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
      await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, scratch], "deps-scratch-chown");
      // Seed (item 58, once per key now): a hardlink view of the seed entry
      // into the scratch tree, tool caches as writable copies, so the install
      // below reconciles the delta — replacing what differs, never writing
      // through a shared inode (they are owner-read-only). `depCacheScript`
      // with the scratch as its own "checkout": the build-dir sources do not
      // exist there, so only node_modules is materialized.
      const seed = opts.seedFromKey;
      if (seed && seed !== key && (await this.depsEntryComplete(seed))) {
        const seedNm = `${depsEntryPath(seed)}/node_modules`;
        const parsed = await this.runDepScript(
          depCacheScript(scratch, scratch, BUILD_USER, { nodeModulesSrc: seedNm }),
          "deps-seed",
          REFRESH_BUILD_TIMEOUT_MS,
        );
        const paths = mutableCachePaths(`${scratch}/node_modules`, parsed.mutableListing);
        if (paths.length > 0) {
          await this.runDepScript(
            mutableCacheSwapScript(seedNm, `${scratch}/node_modules`, BUILD_USER, paths),
            "deps-seed-swap",
            GIT_NETWORK_TIMEOUT_MS,
          );
        }
        console.log(`deps: ${key.slice(0, 8)} seeded from ${seed.slice(0, 8)} (${parsed.mech})`);
      }
      // Unprivileged and token-free, in a tree only this attempt
      // knows — no stale sweep needed: nothing else can be running in it.
      await this.runOk(["su", "-s", "/bin/bash", BUILD_USER, "-c", `cd ${scratch} && ${installCmd}`], "deps-install", {
        timeoutMs: budgetMs,
      });
      // Owner write stripped before the entry becomes visible: every consumer
      // hardlinks these inodes, and worker1 (the checkout's build) owns them —
      // a build writing outside the tool-cache paths must fail EACCES, never
      // mutate the store (review 1b, now with one source instead of three).
      // A commit with no lockfile may legitimately install nothing (the
      // infrastructure resident's `true`): its entry is an empty node_modules.
      await this.runOk(
        [
          "sh",
          "-c",
          depsHardenScript({
            scratchDir: scratch,
            owner: `${BUILD_USER}:${BUILD_USER}`,
            emptyOk: key === NO_LOCKFILE_KEY,
          }),
        ],
        "deps-harden",
        { timeoutMs: GIT_NETWORK_TIMEOUT_MS },
      );
      await this.runOk(
        [
          "sh",
          "-c",
          depsStoreCommitScript({
            scratchDir: scratch,
            stagingDir: staging,
            entryDir: depsEntryPath(key),
            completePath: depsCompletePath(key),
          }),
        ],
        "deps-commit",
        { timeoutMs: GIT_NETWORK_TIMEOUT_MS },
      );
      console.log(`deps: installed ${key.slice(0, 8)} in ${systemClock() - t0}ms`);
      this.ctx.waitUntil(this.backupDepsEntry(key));
      return depsEntryPath(key);
    } catch (err) {
      await this.run(["rm", "-rf", scratch, staging]).catch(() => {});
      throw err;
    } finally {
      this.releaseDepsInstallSlot();
    }
  }

  private async acquireDepsInstallSlot(): Promise<void> {
    if (this.depsInstallSlots === null) {
      const r = await this.run(["nproc"]);
      this.depsInstallSlots = depsInstallSemaphoreSize(r.exitCode === 0 ? r.stdout : null);
    }
    while (this.depsInstallRunning >= this.depsInstallSlots) {
      await new Promise<void>((resolve) => this.depsInstallWaiters.push(resolve));
    }
    this.depsInstallRunning++;
  }

  private releaseDepsInstallSlot(): void {
    this.depsInstallRunning--;
    this.depsInstallWaiters.shift()?.();
  }

  /** A hardlink view of a store entry's node_modules into `tree` for `user`,
   *  plus the tool-cache swap — the pure `depCacheScript` / `mutableCacheSwapScript`
   *  (residentDepCache.ts, where the WHY of every ownership/permission rule
   *  is documented) with the entry as the node_modules source; the build dirs
   *  still come from the checkout (they are build output at its sha).
   *  Serialized on the mirror mutex because the build-dir copies read
   *  CHECKOUT_DIR, which the refresh rebuilds under the same lock; bounded by
   *  ATTACH_MUTEX_WAIT_MS → MirrorBusyError → 503 mirror-busy for an attach.
   *  Callers hold no mirror lock of their own here. */
  private async materializeDepsView(
    /** The store entry's node_modules; null = the checkout is the source for
     *  every dir (a repo with no install command, item 52). */
    entryNodeModules: string | null,
    tree: string,
    user: string,
  ): Promise<DepCacheMaterialization | "none"> {
    let mech: DepCacheMaterialization | "none" = "none";
    await this.withMirrorLock(async () => {
      mech = await this.linkDepsView(entryNodeModules, tree, user);
    }, ATTACH_MUTEX_WAIT_MS);
    return mech;
  }

  /** The view itself, for callers already holding the mirror lock (the
   *  refresh rebuild and provisioning link the CHECKOUT this way). */
  private async linkDepsView(
    entryNodeModules: string | null,
    tree: string,
    user: string,
  ): Promise<DepCacheMaterialization | "none"> {
    const parsed = await this.runDepScript(
      depCacheScript(CHECKOUT_DIR, tree, user, entryNodeModules ? { nodeModulesSrc: entryNodeModules } : {}),
      "deps-materialize",
      REFRESH_BUILD_TIMEOUT_MS,
    );
    const nmDst = `${tree}/node_modules`;
    const paths = mutableCachePaths(nmDst, parsed.mutableListing);
    if (paths.length > 0) {
      await this.runDepScript(
        mutableCacheSwapScript(entryNodeModules ?? `${CHECKOUT_DIR}/node_modules`, nmDst, user, paths),
        "deps-mutable-swap",
        GIT_NETWORK_TIMEOUT_MS,
      );
    }
    return parsed.mech;
  }

  /** Adopt a checkout that already holds node_modules but whose key has no
   *  store entry (a disk from before the store, or a fresh R2 restore — the
   *  snapshot carries the checkout's tree, not the store): MOVE it into the
   *  entry (a rename, same filesystem) and re-link the checkout as a view. The
   *  inodes are the same before and after, so threads that hardlinked from the
   *  checkout earlier are untouched. Under the mirror lock: the checkout
   *  mutates. A no-op when the entry is complete or the checkout has no deps. */
  private async ensureWarmDepsInStore(warmKey: string): Promise<void> {
    if (await this.depsEntryComplete(warmKey)) return;
    await this.withMirrorLock(async () => this.adoptCheckoutDeps(warmKey), ATTACH_MUTEX_WAIT_MS);
  }

  private async adoptCheckoutDeps(warmKey: string): Promise<void> {
    if (await this.depsEntryComplete(warmKey)) return;
    if ((await this.run(["test", "-d", `${CHECKOUT_DIR}/node_modules`])).exitCode !== 0) return;
    await this.ensureDepsStoreDir();
    const attempt = crypto.randomUUID().slice(0, 8);
    console.log(`deps: adopting the checkout's node_modules as ${warmKey.slice(0, 8)}`);
    await this.runOk(
      [
        "sh",
        "-c",
        depsStoreCommitScript({
          scratchDir: CHECKOUT_DIR,
          stagingDir: depsStagingPath(warmKey, attempt),
          entryDir: depsEntryPath(warmKey),
          completePath: depsCompletePath(warmKey),
          keepScratch: true,
        }),
      ],
      "deps-adopt",
      { timeoutMs: GIT_NETWORK_TIMEOUT_MS },
    );
    await this.linkDepsView(`${depsEntryPath(warmKey)}/node_modules`, CHECKOUT_DIR, BUILD_USER);
    this.ctx.waitUntil(this.backupDepsEntry(warmKey));
  }

  /** Cache upkeep after every disk measurement (item 59): list the store,
   *  protect the checkout's key, every live binding's key and every install
   *  in flight, and remove what `planDepsEviction` names — debris first, then
   *  the coldest spares beyond DEPS_STORE_MAX_UNREFERENCED. Housekeeping:
   *  a failure is a log line, never a lifecycle flip. */
  private async sweepDepsStore(): Promise<void> {
    const listed = await this.run(["sh", "-c", depsStoreListScript()], { timeoutMs: DU_TIMEOUT_MS });
    if (listed.exitCode !== 0) return;
    const listing = parseDepsStoreListing(listed.stdout);
    if (listing.entries.length === 0 && listing.leftovers.length === 0) return;
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    const protectedKeys = new Set<string>([...this.depsInFlight.keys(), ...this.depsBackupsInFlight]);
    if (facts?.lockfileHash) protectedKeys.add(facts.lockfileHash);
    for (const b of await this.liveBindings()) if (b.depsKey) protectedKeys.add(b.depsKey);
    // A scratch/staging dir of an install still running in this incarnation
    // is live work, not debris; the listing cannot tell them apart, so
    // leftovers wait for a sweep with nothing in flight.
    const leftovers = this.depsInFlight.size > 0 ? [] : listing.leftovers;
    const plan = planDepsEviction({ entries: listing.entries, leftovers, protectedKeys });
    if (plan.remove.length === 0) return;
    await this.runOk(["rm", "-rf", ...plan.remove], "deps-evict", { timeoutMs: DU_TIMEOUT_MS });
    console.log(
      `deps: evicted ${plan.remove.length} path(s) — ${plan.remove.map((p) => p.slice(DEPS_STORE_DIR.length + 1, DEPS_STORE_DIR.length + 9)).join(", ")}; kept ${plan.keep.map((k) => k.slice(0, 8)).join(", ")}`,
    );
    // The evicted entries' archives go with them (item 61 PR B): a spare
    // nothing references on disk is a spare nothing will wake into.
    const kept = new Set(plan.keep);
    const evictedKeys = listing.entries.map((e) => e.key).filter((k) => !kept.has(k));
    const drop = depsBackupsToDrop({
      evictedKeys,
      backedUpKeys: (await this.allDepsBackups()).map((r) => r.key),
    });
    if (drop.length > 0) {
      const n = await this.dropDepsBackups(drop).catch(() => 0);
      console.log(
        `deps: dropped ${drop.length} entry backup(s) (${n} object(s)) — ${drop.map((k) => k.slice(0, 8)).join(", ")}`,
      );
    }
  }

  /** The per-user 700 staging dir (`install -d` is idempotent), memoized per
   *  incarnation — the write/credential paths used to fork for it on every
   *  call. Cleared with the other memos; a fresh disk simply re-creates it. */
  private async ensureStageDir(user: string, stageDir: string): Promise<void> {
    if (this.stageDirsReady.has(user)) return;
    await this.runOk(["install", "-d", "-m", "700", "-o", user, "-g", user, stageDir], "stage-dir");
    this.stageDirsReady.add(user);
  }

  /** Per-attach credential file: the minted token reaches the
   *  worktree via the SDK file API into a 700 per-user staging dir, then a
   *  privilege-dropped `cat` into `.git/github-credentials` (0600, owned by
   *  the thread user). The token never appears in argv or process-wide env —
   *  `ps` from another thread user sees file PATHS at most. The worktree's
   *  git credential helper points at the file. Returns the write time the
   *  caller persists as `credentialsWrittenAt`. */
  private async writeThreadCredentials(binding: ThreadBinding, token: string): Promise<number> {
    const stageDir = `/workspace/.stage-${binding.user}`;
    const stage = `${stageDir}/cred`;
    await this.ensureStageDir(binding.user, stageDir);
    await this.writeFile(stage, `https://x-access-token:${token}@github.com\n`);
    await this.runOk(
      ["sh", "-c", `chown ${binding.user}:${binding.user} ${stage} && chmod 600 ${stage}`],
      "stage-perms",
    );
    const cred = `${binding.worktreePath}/.git/github-credentials`;
    await this.threadRunOk(
      binding.user,
      binding.worktreePath,
      `umask 077 && cat ${stage} > ${cred} && rm -f ${stage} && chmod 600 ${cred} && git config credential.helper 'store --file=${cred}'`,
      "thread-cred",
      DEFAULT_EXEC_TIMEOUT_MS,
    );
    return systemClock();
  }

  /** Per-exec credential refresh: the attach-time token lives one
   *  hour, a coding run can push later than that, and git's `store` helper
   *  erases a 401'd credential from the file — so before every writable exec,
   *  size the file (one `stat`) and let the pure `shouldRefreshThreadCredentials`
   *  decide; on refresh, re-mint (cached per slug) and rewrite. Returns the
   *  new write time, or undefined when nothing changed. Never throws: a mint
   *  failure is command-level — logged, and the command runs with whatever the
   *  file holds (never a lifecycle transition). Unconfigured App → nothing to
   *  refresh, silently (attach already reported `credentials:"unavailable"`). */
  private async refreshThreadCredentialsIfDue(
    binding: ThreadBinding,
  ): Promise<{ writtenAtMs: number; tokenExpiresAtMs: number } | undefined> {
    if (binding.readonly || !githubAppConfigured(this.env)) return undefined;
    const cred = `${binding.worktreePath}/.git/github-credentials`;
    const sized = await this.run(["stat", "-c", "%s", cred]);
    const fileBytes = sized.exitCode === 0 ? Number.parseInt(sized.stdout.trim(), 10) : null;
    const decision = shouldRefreshThreadCredentials({
      writtenAtMs: binding.credentialsWrittenAt ?? null,
      tokenExpiresAtMs: binding.tokenExpiresAtMs ?? null,
      nowMs: systemClock(),
      fileBytes: fileBytes === null || Number.isNaN(fileBytes) ? null : fileBytes,
      readonly: binding.readonly ?? false,
    });
    if (!decision.refresh) return undefined;
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    try {
      // An `empty` file means git's `store` helper erased a token GitHub had
      // REJECTED (401) — so the per-slug cache may still hold that same dead
      // token, and serving it would rewrite the rejection and 401 the next
      // exec too. Force a fresh mint for a repudiated token; an
      // expiry-driven refresh still reuses the cache.
      const minted = await mintRepoScopedToken(this.env, resource.slice("repo:".length), {
        fresh: decision.reason === "empty",
      });
      const writtenAt = await this.writeThreadCredentials(binding, minted.token);
      console.log(`credentials: refreshed for ${binding.threadKey} (${decision.reason})`);
      return { writtenAtMs: writtenAt, tokenExpiresAtMs: minted.expiresAtMs };
    } catch (err) {
      console.log(
        `credentials: refresh failed (${decision.reason}: ${errMsg(err)}) — command runs without a fresh token`,
      );
      return undefined;
    }
  }

  /** Shared entry checks for exec/read/write: hydrated resident, live
   *  binding, worktree actually on disk (the container may have slept since
   *  the last attach — disk is cache, re-attach recreates). */
  private async threadPreflight(threadKey: string): Promise<{ binding: ThreadBinding } | ThreadErr> {
    try {
      await this.ensureHydrated();
    } catch (err) {
      const s = await this.getStatus();
      return { error: `not-serviceable: ${errMsg(err)}`, status: 503, state: s.state, reason: s.reason };
    }
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) {
      return {
        error: "not-attached: no binding for this threadKey — POST /attach first",
        status: 409,
        needs: "attach",
      };
    }
    if (binding.evicted || !binding.user) {
      return {
        error: "evicted: this thread's worktree was evicted after inactivity — POST /attach to recreate",
        status: 409,
        needs: "attach",
      };
    }
    if ((await this.run(["test", "-d", `${binding.worktreePath}/.git`])).exitCode !== 0) {
      return {
        error: "worktree-missing: the container disk was recycled since the last attach — POST /attach to recreate",
        status: 409,
        needs: "attach",
      };
    }
    return { binding };
  }

  /** POST /exec: run one shell command in the thread's worktree as the
   *  thread's user. Output mirrors the thread-sandbox Worker's shape
   *  ({stdout, stderr, exitCode}, notes appended to stderr, timeout as exit
   *  124); streams/caps are the Worker's job, truncation happens here. */
  /** In-flight thread operations (exec/read/write) per threadKey — DO memory
   *  only. /detach refuses (keeps, reason "busy") while any is running so a
   *  run's release can never yank a worktree out from under a concurrent
   *  command on the same thread (a queued follow-up message, two runs racing). */
  private threadOpsInFlight = new Map<string, number>();

  private async withThreadBusy<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
    this.threadOpsInFlight.set(threadKey, (this.threadOpsInFlight.get(threadKey) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.threadOpsInFlight.get(threadKey) ?? 1) - 1;
      if (n <= 0) this.threadOpsInFlight.delete(threadKey);
      else this.threadOpsInFlight.set(threadKey, n);
    }
  }

  async execThread(
    threadKey: string,
    command: string,
    timeoutMs: number,
    traceparent?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    const queuedAt = systemClock();
    let startedAt = queuedAt;
    const res = await this.withThreadBusy(threadKey, () => {
      startedAt = systemClock();
      return this.execThreadImpl(threadKey, command, timeoutMs);
    });
    // The command as the resident's own `resident.exec` root (docs/reference/specs/tracing.md
    // item 22): started when the command did, the wait for the thread's turn an attr.
    emitStepRoot("resident.exec", startedAt, [], traceparent, "error" in res ? refusalOutcome(res) : "ok", {
      waitedMs: startedAt - queuedAt,
      ...("error" in res ? {} : { exitCode: res.exitCode }),
    });
    return res;
  }

  private async execThreadImpl(
    threadKey: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const { binding } = pre;
    const refreshed = await this.refreshThreadCredentialsIfDue(binding);
    await this.ctx.storage.put(threadBindingKey(threadKey), {
      ...binding,
      lastAttachAt: new Date(systemClock()).toISOString(), // exec counts as activity for the sweep
      // A refresh re-mints and rewrites: persist both the new write time and the
      // new token expiry so the next exec's decision keys on this token.
      ...(refreshed
        ? { credentialsWrittenAt: refreshed.writtenAtMs, tokenExpiresAtMs: refreshed.tokenExpiresAtMs }
        : {}),
    } satisfies ThreadBinding);

    let r: Awaited<ReturnType<ResidentDO["threadRun"]>>;
    try {
      r = await this.threadRunCapped(binding.user, binding.worktreePath, command, timeoutMs, EXEC_OUTPUT_CAP);
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
    const truncated = r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP;
    const notes: string[] = [];
    if (r.timedOut)
      notes.push(
        `command timed out after ${timeoutMs}ms (pass the bash tool's timeoutMs for longer commands, max ${BASH_TIMEOUT_MAX_MS} ms); ` +
          "re-run as smaller steps or background it",
      );
    if (truncated) notes.push(`output truncated to ${EXEC_OUTPUT_CAP} chars per stream`);
    const stderr = [r.stderr.slice(0, EXEC_OUTPUT_CAP), ...notes].filter(Boolean).join("\n");
    return {
      stdout: r.stdout.slice(0, EXEC_OUTPUT_CAP),
      stderr,
      exitCode: r.timedOut ? 124 : r.exitCode,
      truncated,
    };
  }

  /** POST /read: cat the file AS THE THREAD USER — the OS layer (not just
   *  the prefix check) is what confines a symlink pointing outside. */
  async readThreadFile(threadKey: string, path: string): Promise<{ content: string; truncated: boolean } | ThreadErr> {
    return this.withThreadBusy(threadKey, () => this.readThreadFileImpl(threadKey, path));
  }

  private async readThreadFileImpl(
    threadKey: string,
    path: string,
  ): Promise<{ content: string; truncated: boolean } | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const resolved = confineThreadPath(pre.binding.worktreePath, path);
    if (!resolved)
      return { error: `path-escape: ${JSON.stringify(path)} does not stay inside the thread worktree`, status: 400 };
    let r: Awaited<ReturnType<ResidentDO["threadRun"]>>;
    try {
      r = await this.threadRun(
        pre.binding.user,
        pre.binding.worktreePath,
        `cat -- ${resolved}`,
        DEFAULT_EXEC_TIMEOUT_MS,
        capBytesFor(READ_CONTENT_CAP),
      );
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
    if (r.exitCode !== 0 || r.timedOut) return { error: `read-failed: ${describeStepFailure(r)}`, status: 404 };
    const truncated = r.stdout.length > READ_CONTENT_CAP;
    return { content: truncated ? r.stdout.slice(0, READ_CONTENT_CAP) : r.stdout, truncated };
  }

  /** POST /write: content travels via the SDK file API into the thread's
   *  700 staging dir (never argv — another thread's `ps` must not see it),
   *  then a privilege-dropped `cat` moves it into the worktree. Writing as
   *  the user (not root) means a planted symlink cannot escalate the write
   *  beyond what the user could touch anyway. */
  async writeThreadFile(
    threadKey: string,
    path: string,
    content: string,
  ): Promise<{ ok: true; bytes: number } | ThreadErr> {
    return this.withThreadBusy(threadKey, () => this.writeThreadFileImpl(threadKey, path, content));
  }

  private async writeThreadFileImpl(
    threadKey: string,
    path: string,
    content: string,
  ): Promise<{ ok: true; bytes: number } | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const { binding } = pre;
    const resolved = confineThreadPath(binding.worktreePath, path);
    if (!resolved)
      return { error: `path-escape: ${JSON.stringify(path)} does not stay inside the thread worktree`, status: 400 };
    const stageDir = `/workspace/.stage-${binding.user}`;
    const stage = `${stageDir}/put`;
    try {
      await this.ensureStageDir(binding.user, stageDir);
      await this.writeFile(stage, content);
      await this.runOk(
        ["sh", "-c", `chown ${binding.user}:${binding.user} ${stage} && chmod 600 ${stage}`],
        "stage-perms",
      );
      await this.threadRunOk(
        binding.user,
        binding.worktreePath,
        `mkdir -p ${parentDir(resolved)} && cat ${stage} > ${resolved} && rm -f ${stage}`,
        "thread-write",
        DEFAULT_EXEC_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `write-failed${step}: ${errMsg(err)}`, status: 400 };
    }
    return { ok: true, bytes: content.length };
  }

  /** Remove a thread's worktree (when the runtime is up — a slept container
   *  already lost it) and release its pool user; the binding is KEPT, marked
   *  evicted, so the ref stays sticky and the next attach recreates the tree
   *  with it. Shared by the inactivity sweep and /detach. */
  private async evictBinding(
    binding: ThreadBinding,
    runtimeActive: boolean,
    logCtx: string,
    why: string,
  ): Promise<boolean> {
    const threadDir = parentDir(binding.worktreePath);
    if (runtimeActive && threadDir.startsWith(`${THREADS_DIR}/`)) {
      try {
        // Worktree removal counts as a mirror-adjacent mutation — same mutex.
        await this.withMirrorLock(() => this.runOk(["rm", "-rf", threadDir], "evict"));
      } catch (err) {
        console.log(`${logCtx}: rm failed for ${binding.threadKey}: ${errMsg(err)}`);
      }
      // Item 55: what an `install` thread's package manager left OUTSIDE the
      // tree — its pnpm store (the tree's hardlink source: 0 unique bytes while
      // the tree lived, all of them now), npm/yarn/bun caches — goes with it.
      // Pool users only, never the build user (its store backs the warm checkout).
      if ((THREAD_USERS as readonly string[]).includes(binding.user)) {
        await this.run(threadUserCacheCleanArgv(`/home/${binding.user}`)).catch((err) =>
          console.log(`${logCtx}: home cache rm failed for ${binding.user}: ${errMsg(err)}`),
        );
      }
    }
    // The rm above awaited the mirror lock; a re-attach that STARTED in that
    // window has since bumped lastAttachAt (and will recreate the tree under
    // the same lock). Writing `user:""` over it would free a user the
    // re-attach is still holding — so re-read and give way instead.
    const now = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
    if (!now || now.evicted || now.lastAttachAt !== binding.lastAttachAt) {
      const why = !now ? "binding deleted" : now.evicted ? "already evicted (concurrent eviction)" : "re-attached";
      console.log(`${logCtx}: ${binding.threadKey} ${why} during eviction — binding left as is`);
      return false;
    }
    await this.ctx.storage.put(threadBindingKey(binding.threadKey), {
      ...now,
      user: "",
      evicted: true,
      evictedAt: new Date(systemClock()).toISOString(),
      evictedWhy: why,
    } satisfies ThreadBinding);
    return true;
  }

  /** POST /detach: a run has ended — give the thread's pool user back now
   *  instead of holding it until the TTL sweep (the pool is sized for
   *  simultaneous runs). `force` releases unconditionally (read-only agents,
   *  hard stops): an op still in flight is KILLED first (the bot has
   *  already dropped its fetch, the command would otherwise run on and hold
   *  the user until the sweep); otherwise a busy thread, or a worktree with
   *  uncommitted or unpushed work, is KEPT and the caller learns why. No
   *  binding → 404-shaped error; already evicted → a no-op success. Never
   *  flips lifecycle state. */
  async detachThread(
    threadKey: string,
    force: boolean,
  ): Promise<{ released: boolean; reason?: string; user?: string } | ThreadErr> {
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) return { error: `no-binding: ${threadKey} has never attached to this resident`, status: 404 };
    if (binding.evicted || !binding.user) return { released: false, reason: "already-evicted" };
    const plan = planForceDetach({
      force,
      inFlight: this.threadOpsInFlight.get(threadKey) ?? 0,
      user: binding.user,
      poolUsers: THREAD_USERS,
    });
    if (plan.action === "refuse") return { released: false, reason: plan.reason, user: binding.user };
    if (plan.action === "kill") {
      await this.killThreadUserProcesses(plan.user);
      console.log(
        `detach: force — killed ${plan.user}'s processes for ${threadKey} (${plan.inFlight} op(s) were in flight)`,
      );
      const left = await this.waitForThreadDrain(threadKey);
      if (left > 0) return { released: false, reason: busyAfterKillReason(left), user: binding.user };
    }
    const active = await this.isRuntimeActive().catch(() => false);
    if (!force && active) {
      const c = await this.worktreeCleanliness(binding);
      if (!c.clean) return { released: false, reason: `${c.reason} — kept`, user: binding.user };
    }
    // Re-check right before removal: the clean check above awaited (the DO
    // yields at each await), so an exec that arrived mid-detach would otherwise
    // have its tree removed under it.
    const busyNow = this.threadOpsInFlight.get(threadKey) ?? 0;
    if (busyNow > 0)
      return {
        released: false,
        reason: `busy: ${busyNow} operation(s) started during detach — kept`,
        user: binding.user,
      };
    // Same re-read as the sweep: a re-attach during the clean check means a
    // fresh tree we must not remove from a stale snapshot.
    const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!current || current.evicted) return { released: false, reason: "already-evicted" };
    if (current.lastAttachAt !== binding.lastAttachAt)
      return { released: false, reason: "re-attached during the clean check — kept", user: current.user };
    const user = current.user;
    // Same as the sweep: `active` was read before the clean check's awaits; a
    // container that woke meanwhile must get the rm, not an orphaned tree.
    const activeNow = await this.isRuntimeActive().catch(() => false);
    if (!(await this.evictBinding(current, activeNow, `detach`, "detach"))) {
      return { released: false, reason: "re-attached during eviction — kept", user };
    }
    // Item 55: the tree is gone — re-measure (deferred) so the gauge and the
    // next admission see the space back.
    await this.scheduleDiskMeasure((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    return { released: true, user };
  }

  /** Force-detach's kill: end every process owned by the pool user —
   *  `kill -9 -1` sent AS THAT USER reaches exactly its own processes (the
   *  thread's `su … bash -c` shell, the command, anything it backgrounded),
   *  nothing else in the container, and needs no procps. The shell kills
   *  itself too, so su exits 137 — any exit code is fine, and a throw
   *  (runtime replaced mid-kill) is fine as well: the drain wait after it is
   *  what decides, and it is bounded. Only ever called with a plan from
   *  `planForceDetach`, which refuses anything but a `THREAD_USERS` member. */
  private async killThreadUserProcesses(user: string): Promise<void> {
    try {
      await this.run(["su", "-s", "/bin/bash", user, "-c", "kill -9 -1"], { timeoutMs: FORCE_DETACH_KILL_TIMEOUT_MS });
    } catch (err) {
      console.log(`detach: force — kill as ${user} threw (continuing to the drain wait): ${errMsg(err)}`);
    }
  }

  /** Wait (bounded, see FORCE_DETACH_DRAIN_MS) for this thread's in-flight op
   *  counter to reach zero after a kill. The counter drops inside
   *  `withThreadBusy`'s finally, i.e. only after `run()` has collected the
   *  killed process's exit — so a zero here means every process the op ran
   *  is already dead, and the eviction's `rm -rf` of the worktree (the op's
   *  cwd) cannot race a live command. The killed op itself completes
   *  normally through `execThreadImpl` → `streamThreadExec` (exit 137 to a
   *  client that has usually already hung up). Returns the count still in
   *  flight when the bound expires (0 = drained). */
  private async waitForThreadDrain(threadKey: string): Promise<number> {
    const deadline = systemClock() + FORCE_DETACH_DRAIN_MS;
    for (;;) {
      const left = this.threadOpsInFlight.get(threadKey) ?? 0;
      if (left === 0 || systemClock() >= deadline) return left;
      await new Promise((r) => setTimeout(r, FORCE_DETACH_DRAIN_POLL_MS));
    }
  }

  /** Is this thread's tree safe to destroy? The git probes run AS THE THREAD
   *  USER (su), never as root: the worktree is thread-owned, so root git in
   *  it would be refused by safe.directory and would be the exact repo-local-
   *  config execution vector safe.directory exists to block. Unknown (git
   *  failed) counts as NOT clean — never destroy work on a guess. A tree
   *  that no longer exists (disk recycled by a sleep/wake) has nothing to
   *  preserve: releasable, so a post-wake binding does not hold a pool user
   *  for 7 days on behalf of files that are already gone.
   *
   *  ONE spawn: the presence test and both git probes fold
   *  into the pure `worktreeCleanlinessScript` (test -d as root, both git
   *  commands inside a single privilege-dropped `su`, tagged lines out);
   *  `parseWorktreeCleanliness` encodes the exact decision table above. */
  private async worktreeCleanliness(binding: ThreadBinding): Promise<{ clean: boolean; reason?: string }> {
    const injected = { GIT_TERMINAL_PROMPT: "0" }; // same injection as threadRun — fail fast, never prompt
    validateEnvNames(injected);
    const r = await this.run(["sh", "-c", worktreeCleanlinessScript(binding.worktreePath, binding.user)], {
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      env: injected,
    });
    return parseWorktreeCleanliness(r);
  }

  /** Anything that must not be interrupted by a container stop or counted
   *  as idle: thread exec/read/write, disposable /op runs, and attaches past
   *  their own image check (mid clone/install under the mirror lock). */
  private inFlightCount(): number {
    const threadOps = [...this.threadOpsInFlight.values()].reduce((a, n) => a + n, 0);
    return threadOps + this.opUsersInUse.size + this.attachesInFlight + this.refreshesInFlight;
  }
  /** In-flight activity for the deploy preflight (GET /status, GET /residents).
   *  In-memory by nature: a fresh isolate answers 0, which is correct — nothing
   *  survived to be interrupted. */
  async getInFlightCount(): Promise<number> {
    return this.inFlightCount();
  }
  private attachesInFlight = 0;
  /** A refresh cycle past its idle/reconcile gates (fetching, rebuilding, snapshotting). */
  private refreshesInFlight = 0;

  /** Hourly inactivity sweep (schedule: onWorktreeSweep). Removes worktrees
   *  whose binding is idle past the TTL, releases the user to the pool, and
   *  KEEPS the binding record marked evicted. Never wakes a slept
   *  container just to delete files a sleep already destroyed. */
  /** True while onWorktreeSweep is executing (DO memory; a restart clears it
   *  together with the in-flight sweep). The watchdog's re-arm checks it so
   *  two sweep chains can never be armed by construction. */
  private sweepInFlight = false;

  async onWorktreeSweep(payload: string): Promise<{ evicted: string[]; kept: number }> {
    const resource = payload || ((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    const evicted: string[] = [];
    let kept = 0;
    this.sweepInFlight = true;
    try {
      const record = await this.registry()
        .getRecord(resource)
        .catch(() => null);
      const ttlDays = record?.worktreeTtlDays ?? WORKTREE_TTL_DAYS_DEFAULT;
      const cutoff = systemClock() - ttlDays * 86_400_000;
      const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
      const active = await this.isRuntimeActive().catch(() => false);
      const idleCutoff = systemClock() - CLEAN_IDLE_RELEASE_S * 1000;
      for (const binding of all.values()) {
        if (binding.evicted || !binding.user) continue;
        const last = Date.parse(binding.lastAttachAt);
        if (last >= cutoff) {
          // Not past the TTL. Still release it if it has been idle for an hour,
          // nothing is running on it, and the tree is provably clean — the run
          // that used it is over and there is nothing to preserve. A slept
          // container has NO tree any more (sleep destroys the disk), so an
          // idle binding on an inactive runtime is releasable outright: there is
          // nothing left to protect, only a pool user to give back. (Keeping
          // them would leave idle bindings on a sleeping resident until the
          // 7-day TTL.)
          const busy = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
          const cleanIdle =
            last < idleCutoff && busy === 0 && (!active || (await this.worktreeCleanliness(binding)).clean);
          // Re-read right before removal: the clean check awaited (the DO
          // yields), so an exec that arrived meanwhile would otherwise have
          // its tree removed under it — same guard as detachThread.
          const busyNow = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
          if (!cleanIdle || busyNow > 0) {
            kept++;
            continue;
          }
        }
        // Re-read the binding too: a re-attach that completed inside the
        // clean-check await bumped lastAttachAt and rebuilt the tree — evicting
        // from this loop's stale snapshot would rm the fresh tree.
        const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
        if (!current || current.evicted || current.lastAttachAt !== binding.lastAttachAt) {
          kept++;
          continue;
        }
        // `active` is re-read per binding: the container can wake mid-sweep (an
        // attach), and an eviction decided on a stale "inactive" would skip the
        // rm and orphan a real tree.
        const activeNow = await this.isRuntimeActive().catch(() => false);
        if (
          await this.evictBinding(
            current,
            activeNow,
            `worktree-sweep ${resource}`,
            last >= cutoff ? "clean-idle" : "ttl",
          )
        )
          evicted.push(binding.threadKey);
        else kept++;
      }
    } finally {
      const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
      const live = [...all.values()].some((b) => !b.evicted && b.user);
      this.deleteSchedules(SWEEP_CALLBACK);
      if (live) await this.schedule(SWEEP_INTERVAL_S, SWEEP_CALLBACK, resource);
      this.sweepInFlight = false;
    }
    if (evicted.length > 0) await this.scheduleDiskMeasure(resource); // item 55
    return { evicted, kept };
  }

  // -- deterministic ops (/op — disposable per-op checkouts) -------------------

  /** Pool users transiently held by in-flight ops. DO memory only: an op is
   *  bounded by one request, and a DO restart kills the in-flight op anyway
   *  (its orphaned OPS_DIR entry dies with the container disk at the latest).
   *  Both this allocator and allocateThreadUser exclude the set, so an op
   *  never shares an OS user with a thread or another op. */
  private opUsersInUse = new Set<string>();

  /** Transient allocation: storage reads + a synchronous set-add in the same
   *  microtask (atomic under the DO input gate, like allocateThreadUser).
   *  Returns null when threads + ops have the whole pool busy. */
  private async allocateOpUser(): Promise<string | null> {
    const user = await this.findFreePoolUser();
    if (user) this.opUsersInUse.add(user);
    return user ?? null;
  }

  /** POST /op work half: run ONE readonly command-table entry in a
   *  disposable checkout under OPS_DIR — never a thread's attached worktree —
   *  privilege-dropped as a transiently-held pool user, then delete the
   *  checkout whatever happened. The command STRING comes exclusively from
   *  the admin-written table; the ref was pattern-validated by the Worker and
   *  must additionally resolve in the mirror (fetching once if unknown);
   *  request text is never interpolated into a shell command. Deps
   *  materialize through the exact thread mechanism: the shared
   *  lockfile-keyed cache, scoped token-free install only when the committed
   *  key differs. No snapshot is ever written here. */
  async runOp(op: "test" | "build", refArg: string | null, traceparent?: string): Promise<OpRunOk | ThreadErr> {
    // One step trace per op (docs/reference/specs/tracing.md item 19), like an attach.
    const t0 = systemClock();
    const trace = createStepTrace(t0);
    const res = await this.stepTrace.run(trace, () => this.runOpTraced(op, refArg, t0));
    emitStepRoot("resident.op", t0, trace.steps(), traceparent, "error" in res ? refusalOutcome(res) : "ok", {
      command: op,
    });
    return "error" in res ? { ...res, trace: trace.steps() } : res;
  }

  private async runOpTraced(op: "test" | "build", refArg: string | null, t0: number): Promise<OpRunOk | ThreadErr> {
    try {
      await this.ensureHydrated();
    } catch (err) {
      const s = await this.getStatus();
      return { error: `not-serviceable: ${errMsg(err)}`, status: 503, state: s.state, reason: s.reason };
    }
    // One storage round trip for the two facts; the registry lookup stays (an
    // op resolves ONLY through the onboard-time command table).
    const stored = await this.ctx.storage.get<string | RepoFacts>([RESOURCE_KEY, FACTS_KEY]);
    const resource = (stored.get(RESOURCE_KEY) as string | undefined) ?? "";
    const facts = stored.get(FACTS_KEY) as RepoFacts | undefined;
    const record = await this.registry().getRecord(resource);
    if (!record || !facts) return { error: "not-serviceable: registry record or repo facts missing", status: 503 };
    const command = record.commands[op];
    if (!command) return { error: `op-unavailable: the command table has no "${op}" entry`, status: 400 };

    const user = await this.allocateOpUser();
    if (!user) {
      return {
        error: `user-pool-exhausted: all ${THREAD_USERS.length} pool users are busy (threads or in-flight ops); try again shortly`,
        status: 429,
      };
    }
    const opDir = `${OPS_DIR}/${crypto.randomUUID()}`;
    const checkout = `${opDir}/checkout`;
    try {
      // Command-level token mint, attach's discipline: only a mirror
      // fetch for an unknown ref would use it; failure never blocks the op.
      let token: string | null = null;
      if (githubAppConfigured(this.env)) {
        token = (await mintRepoScopedToken(this.env, resource.slice("repo:".length)).catch(() => null))?.token ?? null;
      }
      const locked = await this.withMirrorLock(async () => {
        await this.ensureGitSetup();
        const ref = refArg ?? facts.defaultRef;
        if (!(await this.refExists(ref))) {
          await this.gitWithCred(
            token,
            ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
            "fetch",
            GIT_NETWORK_TIMEOUT_MS,
          );
          if (!(await this.refExists(ref))) {
            throw new StepError(
              "unknown-ref",
              `ref ${JSON.stringify(ref)} does not resolve in the mirror (even after a fetch)`,
            );
          }
        }
        const sha = await this.readMirrorSha(ref);
        const lockKey = await this.lockfileKey(sha);
        await this.runOk(["install", "-d", "-m", "755", "-o", "root", "-g", "root", OPS_DIR], "ops-dir");
        // 700 op dir first, clone beneath it: the tree is unreadable to peer
        // users for its whole life, exactly like a thread dir.
        await this.runOk(["install", "-d", "-m", "700", "-o", user, "-g", user, opDir], "op-dir");
        await this.runOk(["git", "clone", "--no-hardlinks", "--branch", ref, MIRROR_DIR, checkout], "op-clone", {
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        });
        await this.runOk(["chown", "-R", `${user}:${user}`, checkout], "op-chown");
        return { ref, sha, lockKey };
      }, ATTACH_MUTEX_WAIT_MS);

      const deps = await this.materializeThreadDeps(
        { user, worktreePath: checkout },
        locked.value.lockKey,
        locked.value.sha,
        facts.lockfileHash,
        record.commands.install,
      );

      const commandStartedAt = systemClock();
      const r = await this.threadRunCapped(user, checkout, command, OP_EXEC_TIMEOUT_MS, EXEC_OUTPUT_CAP);
      // The command itself is the op's step, named for the op (`test`, `build`).
      this.stepTrace.getStore()?.record(op, {
        startedAt: commandStartedAt,
        endedAt: systemClock(),
        exitCode: r.exitCode,
        timedOut: r.timedOut,
      });
      const ok = r.exitCode === 0 && !r.timedOut;
      const truncated = r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP;
      const notes: string[] = [];
      if (r.timedOut) notes.push(`command timed out after ${OP_EXEC_TIMEOUT_MS}ms`);
      if (truncated) notes.push(`output truncated to ${EXEC_OUTPUT_CAP} chars per stream`);
      const durationMs = systemClock() - t0;
      const sha8 = locked.value.sha.slice(0, 8);
      const exitCode = r.timedOut ? 124 : r.exitCode;
      return {
        ok,
        op,
        resource,
        ref: locked.value.ref,
        sha: locked.value.sha,
        summary: ok
          ? `${op} passed on ${resource} @ ${locked.value.ref} (${sha8}) in ${Math.round(durationMs / 1000)}s`
          : `${op} failed (exit ${exitCode}${r.timedOut ? ", timed out" : ""}) on ${resource} @ ${locked.value.ref} (${sha8})`,
        stdout: r.stdout.slice(0, EXEC_OUTPUT_CAP),
        stderr: [r.stderr.slice(0, EXEC_OUTPUT_CAP), ...notes].filter(Boolean).join("\n"),
        exitCode,
        truncated,
        deps: deps.deps,
        reconciled: deps.reconciled,
        durationMs,
        trace: this.currentSteps(),
      };
    } catch (err) {
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      if (err instanceof StepError && err.step === "unknown-ref") {
        return { error: `unknown-ref: ${err.message}`, status: 400 };
      }
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `op-failed${step}: ${errMsg(err)}`, status: 500 };
    } finally {
      // Disposable means disposable: the checkout dies with the op, pass or
      // fail (best effort — a slept container already destroyed it anyway).
      await this.run(["rm", "-rf", opDir]).catch(() => {});
      this.opUsersInUse.delete(user);
    }
  }

  /** Debug: enumerate thread bindings (read scope). No secrets live in a
   *  binding; worktreePath is omitted like getResidentInfo does — internal
   *  disk layout is not part of the lower-trust read surface. */
  async debugThreads(): Promise<{ threads: Array<Omit<ThreadBinding, "worktreePath">> }> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return { threads: [...all.values()].map(({ worktreePath: _internal, ...rest }) => rest) };
  }

  /** The entry backups on record (item 61 PR B): key, archive id, when — the
   *  receipt surface for "backed up once, restored on wake". */
  async debugDepsBackups(): Promise<{
    depsBackups: Array<{ key: string; backupId: string; createdAt: string; inFlight: boolean }>;
  }> {
    const records = await this.allDepsBackups();
    return {
      depsBackups: records.map((r) => ({
        key: r.key,
        backupId: r.backup.id,
        createdAt: r.createdAt,
        inFlight: this.depsBackupsInFlight.has(r.key),
      })),
    };
  }

  /** Delete the EVICTED bindings whose threadKey starts with `prefix` (item 60):
   *  eviction keeps a binding on purpose, so a load run's synthetic
   *  threads would otherwise stay on the detail page forever. The decision is
   *  `selectBindingsToPurge` — a whole non-production namespace or longer,
   *  never a live binding. Nothing on disk is touched: an evicted binding has
   *  no worktree and no pool user. */
  async debugPurgeBindings(prefix: string): Promise<{ purged: string[]; keptLive: string[] } | { error: string }> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const decision = selectBindingsToPurge([...all.values()], prefix);
    if (!decision.ok) return { error: decision.error };
    if (decision.purge.length > 0) await this.ctx.storage.delete(decision.purge.map(threadBindingKey));
    return { purged: decision.purge, keptLive: decision.keptLive };
  }

  /** Debug fault injection: age a binding so the sweep's TTL path can be
   *  exercised without waiting N days. */
  async debugBackdateThread(threadKey: string, days: number): Promise<{ ok: boolean; lastAttachAt?: string }> {
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) return { ok: false };
    const lastAttachAt = new Date(systemClock() - days * 86_400_000).toISOString();
    await this.ctx.storage.put(threadBindingKey(threadKey), { ...binding, lastAttachAt } satisfies ThreadBinding);
    return { ok: true, lastAttachAt };
  }

  /** Debug: run the sweep pass now (the exact scheduled function). */
  async debugSweepNow(): Promise<{ evicted: string[]; kept: number }> {
    return this.onWorktreeSweep("");
  }

  // -- event-triggered reclamation ---------------------------------------------

  /** Ask GitHub what happened to a head branch that still exists in the
   *  mirror. One REST call, bounded; any failure is `unknown` (keep), never a
   *  guess. Anonymous when the App is unconfigured (public repos). */
  private async lookupPullFate(
    slug: string,
    ref: string,
    token: string | null,
  ): Promise<{ fate: RefFate; pr: number | null }> {
    const owner = slug.split("/")[0];
    const url = `https://api.github.com/repos/${slug}/pulls?state=all&head=${encodeURIComponent(`${owner}:${ref}`)}&sort=updated&direction=desc&per_page=10`;
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "switchboard-resident",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });
      if (!res.ok) return { fate: "unknown", pr: null };
      const pulls = parsePullsBody(await res.json().catch(() => null));
      if (!pulls) return { fate: "unknown", pr: null };
      return { fate: pullsFate(pulls), pr: decisivePull(pulls)?.number ?? null };
    } catch {
      return { fate: "unknown", pr: null };
    }
  }

  /** Reclaim worktrees whose ref is FINISHED: the branch vanished from the
   *  mirror (the refresh cycle's `fetch --prune` just ran) or its PR was
   *  merged/closed. Runs inside the refresh cycle — a poll on the existing
   *  alarm, since the GitHub App has webhooks off — and via /debug
   *  reclaim-now. Never touches the default branch, a busy thread, or a dirty
   *  tree (reclaimDecision); every keep is named. The eviction itself is the
   *  sweep's `evictBinding` with the same re-read guards. */
  async reclaimFinishedRefs(
    resource: string,
    defaultRef: string,
    token: string | null,
  ): Promise<{
    reclaimed: Array<{ threadKey: string; ref: string; why: string }>;
    kept: Array<{ threadKey: string; ref: string; why: ReclaimWhy }>;
  }> {
    const reclaimed: Array<{ threadKey: string; ref: string; why: string }> = [];
    const kept: Array<{ threadKey: string; ref: string; why: ReclaimWhy }> = [];
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const live = [...all.values()].filter((b) => !b.evicted && b.user);
    if (live.length === 0) return { reclaimed, kept };
    const slug = resource.slice("repo:".length);
    const active = await this.isRuntimeActive().catch(() => false);
    // Fate pre-pass: resolve every distinct non-default ref's
    // fate up front — ONE `for-each-ref` listing answers the "branch gone?"
    // membership test for the whole pass (instead of a rev-parse container
    // spawn per ref), and the PR lookups (independent 10 s REST calls) run
    // concurrently. The eviction loop below stays SERIAL: its re-read guards
    // (binding, op counter, runtime) depend on ordering.
    const distinctRefs = [...new Set(live.map((b) => b.ref).filter((ref) => ref !== defaultRef))];
    // Branch existence is read from the MIRROR (the cycle's fetch --prune
    // just ran). A sleeping container has no mirror on disk, so `run` would
    // wake it and read an empty disk as "every branch gone" — when the
    // runtime is down only the PR lookup can speak. An unreadable listing
    // likewise must not read as "every branch gone": membership stays
    // unknown (null) and the PR lookup decides — keep on a guess, never evict.
    let mirrorRefs: Set<string> | null = null;
    if (active && distinctRefs.length > 0) {
      const listing = await this.run([
        "git",
        "-C",
        MIRROR_DIR,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/",
      ]);
      mirrorRefs = listing.exitCode === 0 ? parseRefListing(listing.stdout) : null;
    }
    const fates = new Map<string, { fate: RefFate; detail: string }>();
    await Promise.all(
      distinctRefs.map(async (ref) => {
        if (mirrorRefs && !mirrorRefs.has(ref)) {
          fates.set(ref, { fate: "gone", detail: "" });
          return;
        }
        const looked = await this.lookupPullFate(slug, ref, token);
        const detail =
          looked.pr !== null && (looked.fate === "merged" || looked.fate === "closed") ? ` #${looked.pr}` : "";
        fates.set(ref, { fate: looked.fate, detail });
      }),
    );
    for (const binding of live) {
      const isDefaultRef = binding.ref === defaultRef;
      // The default branch is never a finished ref (reclaimDecision keeps it
      // by name), so its fate is never looked up.
      const { fate, detail } = (!isDefaultRef && fates.get(binding.ref)) || { fate: "unknown" as RefFate, detail: "" };
      const busy = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
      // The clean check runs as the thread user and only when it can decide
      // anything: a finished ref, nothing running, runtime up (down → the tree
      // is already gone with the disk → null).
      const finished = fate === "gone" || fate === "merged" || fate === "closed";
      const clean = !active
        ? null
        : finished && !isDefaultRef && busy === 0
          ? (await this.worktreeCleanliness(binding)).clean
          : null;
      const decision = reclaimDecision({ fate, isDefaultRef, busy, clean });
      if (!decision.reclaim) {
        kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: decision.why });
        continue;
      }
      // Same guards as the sweep: the clean check awaited, so re-read the
      // binding (a re-attach means a fresh tree) and the op counter.
      const busyNow = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
      const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
      if (busyNow > 0) {
        kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: "busy" });
        continue;
      }
      if (!current || current.evicted || current.lastAttachAt !== binding.lastAttachAt) {
        kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: "re-attached" });
        continue;
      }
      const activeNow = await this.isRuntimeActive().catch(() => false);
      const why = `${decision.why}${detail}`;
      if (await this.evictBinding(current, activeNow, `reclaim ${resource}`, why)) {
        reclaimed.push({ threadKey: binding.threadKey, ref: binding.ref, why });
        console.log(`reclaim ${resource}: evicted ${binding.threadKey} on ${binding.ref} — ${why}`);
      } else kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: "re-attached" });
    }
    return { reclaimed, kept };
  }

  /** Debug: measure the disk now (admin) — the exact cycle/attach function. */
  async debugMeasureDisk(): Promise<DiskSample | null> {
    return this.measureDisk();
  }

  /** Debug: run the reclamation pass now (the exact refresh-cycle function,
   *  with a fresh mint when the App is configured). Runs a `fetch --prune`
   *  first so a branch deleted seconds ago already reads as gone. */
  async debugReclaimNow(): Promise<{ reclaimed: unknown[]; kept: unknown[]; fetch: string }> {
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!facts) return { reclaimed: [], kept: [], fetch: "skipped" };
    let token: string | null = null;
    if (githubAppConfigured(this.env))
      token = (await mintRepoScopedToken(this.env, resource.slice("repo:".length)).catch(() => null))?.token ?? null;
    let fetchResult = "skipped";
    if (await this.isRuntimeActive().catch(() => false)) {
      try {
        await this.withMirrorLock(
          () =>
            this.gitWithCred(
              token,
              ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
              "reclaim-fetch",
              GIT_NETWORK_TIMEOUT_MS,
            ),
          ATTACH_MUTEX_WAIT_MS,
        );
        fetchResult = "ok";
      } catch (err) {
        fetchResult = `fetch failed: ${errMsg(err)}`;
      }
    }
    const result = await this.reclaimFinishedRefs(resource, facts.defaultRef, token);
    return { ...result, fetch: fetchResult };
  }

  // -- state + introspection ---------------------------------------------------

  /** Persist a lifecycle transition. degraded/down always carry a reason.
   *  Every transition clears the per-incarnation memos: whatever made the
   *  state move (a restore starting, a refresh, a down) may invalidate the
   *  cached hydration/git-setup verdicts, and re-deriving them costs one probe. */
  async setResidentState(state: ResidentState, reason = ""): Promise<void> {
    if ((state === "degraded" || state === "down") && !reason) {
      throw new Error(`state "${state}" requires a reason`);
    }
    this.clearIncarnationMemos();
    // Item 62: a reason is built from step output; make it safe at the write
    // so the stored value is safe on every later read, on any bot version.
    await this.ctx.storage.put({
      [STATE_KEY]: state,
      [REASON_KEY]: residentText(reason),
      [UPDATED_KEY]: new Date(systemClock()).toISOString(),
    });
  }

  async getStatus(): Promise<ResidentStatus> {
    const map = await this.ctx.storage.get<string>([STATE_KEY, REASON_KEY]);
    const state = map.get(STATE_KEY) as ResidentState | undefined;
    if (!state) {
      return { state: "down", reason: "no resident state persisted (never onboarded, or already offboarded)" };
    }
    return { state, reason: map.get(REASON_KEY) ?? "" };
  }

  /** Full admin-facing view (surfaced via GET /residents and /debug info):
   *  lifecycle + recorded sha/cache keys/snapshot stamp/refresh telemetry.
   *  Backup handles are reduced to ids — never the raw handle internals. */
  async getResidentInfo(): Promise<Record<string, unknown>> {
    const map = await this.ctx.storage.get<unknown>([
      RESOURCE_KEY,
      STATE_KEY,
      REASON_KEY,
      UPDATED_KEY,
      FACTS_KEY,
      SNAPSHOT_KEY,
      DISK_KEY,
    ]);
    const facts = map.get(FACTS_KEY) as RepoFacts | undefined;
    const snap = map.get(SNAPSHOT_KEY) as SnapshotRecord | undefined;
    const disk = (map.get(DISK_KEY) as DiskSample | undefined) ?? null;
    const [refresh, provisionRun, provisionDeadline, bindings] = await Promise.all([
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
      this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX }),
    ]);
    // Thread worktree bindings for the admin view: which refs are
    // live on this resident. worktreePath is an internal layout detail and is
    // left out; nothing here is secret (credential files are never persisted).
    const threads = [...bindings.values()]
      .sort((a, b) => b.lastAttachAt.localeCompare(a.lastAttachAt))
      .map(({ threadKey, ref, sha, user, deps, boundAt, lastAttachAt, evicted, evictedAt, evictedWhy }) => ({
        threadKey,
        ref,
        sha: sha ?? null,
        user,
        deps: deps ?? null,
        boundAt,
        lastAttachAt,
        evicted: evicted ?? false,
        evictedAt: evictedAt ?? null,
        evictedWhy: evictedWhy ?? null,
      }));
    return {
      resource: map.get(RESOURCE_KEY) ?? null,
      state: map.get(STATE_KEY) ?? "down",
      reason: map.get(REASON_KEY) ?? "",
      updatedAt: map.get(UPDATED_KEY) ?? null,
      defaultRef: facts?.defaultRef ?? null,
      sha: facts?.sha ?? null,
      lockfileHash: facts?.lockfileHash ?? null,
      provisionedAt: facts?.provisionedAt ?? null,
      lastRefreshAt: facts?.lastRefreshAt ?? null,
      lastRefreshError: facts?.lastRefreshError ?? null,
      lastRestore: facts?.lastRestore ?? null,
      idleSince: facts?.idleSince ?? null,
      snapshot: snap
        ? {
            ref: snap.ref,
            sha: snap.sha,
            lockfileHash: snap.lockfileHash,
            createdAt: snap.createdAt,
            mirrorBackupId: snap.mirror.id,
            checkoutBackupId: snap.checkout.id,
          }
        : null,
      schedules: {
        refresh: refresh.length,
        provisionRun: provisionRun.length,
        provisionDeadline: provisionDeadline.length,
      },
      inFlight: this.inFlightCount(),
      threads,
      // Item 55: the last disk sample (`residentDiskBudget.ts` DiskSample), or
      // null before the first measurement of this incarnation.
      disk,
    };
  }

  // -- debug surface (admin-scoped via POST /debug; used by live validation) ---

  async debugSchedules(): Promise<Record<string, unknown>> {
    const [refresh, provisionRun, provisionDeadline, sweep] = await Promise.all([
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
      this.listSchedules(SWEEP_CALLBACK),
    ]);
    return { refresh, provisionRun, provisionDeadline, sweep };
  }

  /** Kill the refresh chain (simulates a dead alarm chain for watchdog tests). */
  async debugKillRefresh(): Promise<{ killed: boolean; remaining: number }> {
    this.deleteSchedules(REFRESH_CALLBACK);
    return { killed: true, remaining: (await this.listSchedules(REFRESH_CALLBACK)).length };
  }

  /** Pull the next refresh forward to ~1s from now. */
  async debugRefreshNow(): Promise<{ scheduled: boolean }> {
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    this.deleteSchedules(REFRESH_CALLBACK);
    await this.schedule(1, REFRESH_CALLBACK, resource);
    return { scheduled: true };
  }

  /** Fault injection for the watchdog's stuck-onboarding path: re-persist
   *  `onboarding` WITHOUT arming any schedule. With the recorded provisioning
   *  deadline in the past, the next watchdog pass must take this resident to
   *  down(provision-timeout) and release its cap slot. Test-only semantics;
   *  admin scope. */
  async debugForceOnboarding(): Promise<ResidentStatus> {
    await this.setResidentState("onboarding");
    return this.getStatus();
  }

  /** Stop the container (simulates a platform sleep: disk is ephemeral, so the
   *  next refresh must take the restoring→warm wake path). */
  async debugStopContainer(): Promise<{ stopped: boolean; error?: string }> {
    try {
      this.clearIncarnationMemos(); // deliberate incarnation swap
      await this.stop();
      return { stopped: true };
    } catch (err) {
      return { stopped: false, error: errMsg(err) };
    }
  }

  /** Fault injection for the watchdog's auto-rebuild path: persist
   *  `down` with a rehydration-flavored reason and stop the refresh chain
   *  (mirroring what a real goDown does), so repeated watchdog passes can
   *  strike it up to the auto-rebuild without corrupting real R2 objects.
   *  Test-only semantics; admin scope. */
  async debugForceDown(reason: string): Promise<ResidentStatus> {
    await this.setResidentState("down", reason);
    this.deleteSchedules(REFRESH_CALLBACK);
    return this.getStatus();
  }

  /** Rebuild: the down→onboarding escape hatch — discard the recorded
   *  snapshots (R2 objects included) and reprovision from scratch through the
   *  ordinary alarm-driven pipeline, reusing the registry record's command
   *  table/ref/budget. `dryRun` returns the same itemized plan WITHOUT
   *  executing: nothing deleted, no state change, schedules untouched.
   *  Refused while the engine owns the state (onboarding/refreshing/
   *  restoring) — two engine chains must never race the same disk. */
  async rebuild(
    resource: string,
    defaultRef: string,
    provisioningTimeoutMs: number,
    dryRun: boolean,
  ): Promise<
    | {
        resource: string;
        dryRun: boolean;
        from: ResidentStatus;
        discards: {
          snapshot: {
            ref: string;
            sha: string;
            lockfileHash: string;
            createdAt: string;
            mirrorBackupId: string;
            checkoutBackupId: string;
          } | null;
          backupObjects: number;
        };
        reprovision: { defaultRef: string; provisioningTimeoutMs: number };
        keeps: { registryRecord: true; threadBindings: number };
        backupObjectsDeleted?: number;
        state?: ResidentState;
      }
    | { error: string; status: number }
  > {
    const from = await this.getStatus();
    if (from.state === "onboarding" || from.state === "refreshing" || from.state === "restoring") {
      return {
        error: `rebuild-refused: the engine is mid-flight (state ${from.state}) — retry once it settles (warm/degraded/down)`,
        status: 409,
      };
    }
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const plan = {
      resource,
      dryRun,
      from,
      discards: {
        snapshot: snap
          ? {
              ref: snap.ref,
              sha: snap.sha,
              lockfileHash: snap.lockfileHash,
              createdAt: snap.createdAt,
              mirrorBackupId: snap.mirror.id,
              checkoutBackupId: snap.checkout.id,
            }
          : null,
        backupObjects: snap ? await this.countBackupObjects([snap.mirror.id, snap.checkout.id]) : 0,
      },
      reprovision: { defaultRef, provisioningTimeoutMs },
      keeps: { registryRecord: true as const, threadBindings: bindings.size },
    };
    if (dryRun) return plan;

    // Old snapshot objects go FIRST: initResident wipes the stored handles,
    // and backups/<id>/ lives outside the resident/<resource>/ prefix — this
    // is the only path that can still reach them (same ordering as teardown).
    let backupObjectsDeleted = 0;
    if (snap) {
      try {
        backupObjectsDeleted = await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]);
      } catch {
        // best effort — the 1-year R2 TTL is the leak backstop
      }
    }
    await this.ctx.storage.delete(REBUILD_STRIKES_KEY);
    await this.initResident(resource, provisioningTimeoutMs);
    return { ...plan, backupObjectsDeleted, state: "onboarding" as const };
  }

  /** Dry-run itemization for offboard: everything the real teardown
   *  below would remove, computed READ-ONLY — no schedule, storage,
   *  container, or R2 mutation. */
  async teardownPlan(): Promise<{
    state: ResidentState;
    reason: string;
    schedules: number;
    snapshotBackupIds: string[];
    backupObjects: number;
    threadBindings: number;
  }> {
    const status = await this.getStatus();
    const [prov, run, refresh, sweep] = await Promise.all([
      this.listSchedules(PROVISIONING_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(SWEEP_CALLBACK),
    ]);
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    const ids = snap ? [snap.mirror.id, snap.checkout.id] : [];
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return {
      ...status,
      schedules: prov.length + run.length + refresh.length + sweep.length,
      snapshotBackupIds: ids,
      backupObjects: await this.countBackupObjects(ids),
      threadBindings: bindings.size,
    };
  }

  /** Offboard teardown: cancel timers, delete the R2 objects behind the SDK
   *  backup handles (they live under backups/<uuid>/, OUTSIDE the
   *  resident/<resource>/ prefix, and the handles die with deleteAll — so
   *  this must happen first), stop the container (best effort), wipe DO
   *  storage. resident/<resource>/ objects are deleted by the Worker. */
  async teardown(): Promise<{
    schedulesCancelled: boolean;
    containerStopped: boolean;
    storageCleared: boolean;
    backupObjectsDeleted: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let containerStopped = false;
    let backupObjectsDeleted = 0;
    this.deleteSchedules(PROVISIONING_CALLBACK);
    this.deleteSchedules(PROVISION_RUN_CALLBACK);
    this.deleteSchedules(REFRESH_CALLBACK);
    this.deleteSchedules(SWEEP_CALLBACK);
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    if (snap) {
      try {
        backupObjectsDeleted = await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]);
      } catch (err) {
        errors.push(`backup object deletion failed: ${errMsg(err)}`);
      }
    }
    // The entry backups (item 61 PR B) live under backups/<id>/ too — the
    // same out-of-prefix objects, the same only path that reaches them.
    try {
      backupObjectsDeleted += await this.dropDepsBackups((await this.allDepsBackups()).map((r) => r.key));
    } catch (err) {
      errors.push(`deps backup deletion failed: ${errMsg(err)}`);
    }
    try {
      await this.destroy();
      containerStopped = true;
    } catch (err) {
      errors.push(`destroy failed: ${errMsg(err)}`);
    }
    // Retired DO: clear the alarm the Container base may have armed for its
    // schedules, then wipe storage so nothing ever wakes this object again.
    this.clearIncarnationMemos(); // retired object, retired memos
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { schedulesCancelled: true, containerStopped, storageCleared: true, backupObjectsDeleted, errors };
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Constant-time byte comparison. The early length return leaks only the
 *  length, which any comparison leaks; per-byte timing never varies with
 *  content. Deliberate deviation from the thread-sandbox Worker's plain !==. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

type Scope = "admin" | "operator" | "read";

/** Which token a bearer is, or null. Constant-time per comparison; fail closed
 *  on unset/empty secrets. */
function tokenScope(env: Env, token: string | null): Scope | null {
  if (!token) return null;
  if (env.RESIDENT_ADMIN_TOKEN && timingSafeEqual(token, env.RESIDENT_ADMIN_TOKEN)) return "admin";
  if (env.RESIDENT_OPERATOR_TOKEN && timingSafeEqual(token, env.RESIDENT_OPERATOR_TOKEN)) return "operator";
  if (env.RESIDENT_READ_TOKEN && timingSafeEqual(token, env.RESIDENT_READ_TOKEN)) return "read";
  return null;
}

/** Admin is a strict superset of everything. Operator opens operator routes
 *  only; read opens read routes only — neither ever reaches an admin route. */
function hasScope(env: Env, token: string | null, scope: Scope): boolean {
  const have = tokenScope(env, token);
  if (have === null) return false;
  if (have === "admin") return true;
  return have === scope;
}

/** /debug ops a read-scope bearer may run: pure reads of DO storage/schedules. */
const READ_DEBUG_OPS = new Set(["info", "schedules", "threads", "deps-backups"]);

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** A resource id is "<type>:<id>", lowercase. The whole resource doubles as the sandbox
 *  id (≤63 chars, no leading/trailing hyphen; ':' and '/' are accepted by the
 *  SDK's sanitizeSandboxId). */
const RESOURCE_RE = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9._/-]{0,61})$/;
/** repo ids are GitHub "<owner>/<name>" slugs (lowercased): the clone URL
 *  https://github.com/<owner>/<name>.git derives from the id, and the mint
 *  scope uses the <name> half. */
const REPO_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const SUPPORTED_RESOURCE_TYPES = new Set(["repo"]);

function parseResource(value: unknown): { resource: string } | { error: string } {
  if (typeof value !== "string") return { error: 'resource must be a string like "repo:<owner>/<name>"' };
  if (value.length > 63) return { error: "resource must be at most 63 characters (it doubles as the sandbox id)" };
  const match = RESOURCE_RE.exec(value);
  if (!match) return { error: `resource must match ${String(RESOURCE_RE)}` };
  if (!SUPPORTED_RESOURCE_TYPES.has(match[1])) {
    return {
      error: `unsupported resource type "${match[1]}" (supported: ${[...SUPPORTED_RESOURCE_TYPES].join(", ")})`,
    };
  }
  if (match[1] === "repo" && !REPO_ID_RE.test(match[2])) {
    return {
      error: 'repo resource id must be a lowercase GitHub "<owner>/<name>" slug (e.g. "repo:acme/api")',
    };
  }
  return { resource: value };
}

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_COMMAND_LENGTH = 2000;

function parseCommands(value: unknown): { commands: Record<string, string> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'commands must be an object like { "test": "npm test", "build": "npm run build" }' };
  }
  const commands: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (!COMMAND_NAME_RE.test(name)) return { error: `invalid command name ${JSON.stringify(name)}` };
    if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
      return {
        error: `command ${JSON.stringify(name)} must be a non-empty string of at most ${MAX_COMMAND_LENGTH} chars`,
      };
    }
    commands[name] = command;
  }
  for (const required of ["test", "build"]) {
    if (!(required in commands)) return { error: `commands must include "${required}"` };
  }
  return { commands };
}

/** Execution-profile values. */
const EFFECTS_VALUES = new Set(["readonly", "mutating"]);

function parseEffects(value: unknown): { effects: Record<string, "readonly" | "mutating"> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'effects must be an object like { "test": "readonly" } (values: readonly | mutating)' };
  }
  const effects: Record<string, "readonly" | "mutating"> = {};
  for (const [name, effect] of Object.entries(value)) {
    if (!COMMAND_NAME_RE.test(name)) return { error: `invalid command name ${JSON.stringify(name)} in effects` };
    if (typeof effect !== "string" || !EFFECTS_VALUES.has(effect)) {
      return { error: `effects[${JSON.stringify(name)}] must be "readonly" or "mutating"` };
    }
    effects[name] = effect as "readonly" | "mutating";
  }
  return { effects };
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Strict branch-ref pattern (P1 input validation): leading alnum rules out
 *  `-option` and `/abs` shapes, the charset rules out shell metacharacters
 *  and whitespace, and `..` / `@{` are refused before the value ever derives
 *  a path or a git argument. */
function parseRef(value: unknown, field: string): { ref: string } | { error: string } {
  if (
    typeof value !== "string" ||
    !REF_RE.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".lock")
  ) {
    return { error: `${field} must be a plausible git branch ref (e.g. "main")` };
  }
  return { ref: value };
}

function parseDefaultRef(value: unknown): { defaultRef: string } | { error: string } {
  const parsed = parseRef(value, "defaultRef");
  if ("error" in parsed) return parsed;
  return { defaultRef: parsed.ref };
}

/** Platform-namespaced thread id (P1 input validation, deliberately
 *  conservative): "<platform>:<id>" where the id charset excludes anything
 *  that could carry `../`, whitespace, or shell metacharacters. Validated
 *  BEFORE the key derives a storage key or a disk path. */
const THREAD_KEY_RE = /^[a-z]{1,32}:[A-Za-z0-9._:-]{1,128}$/;

function parseThreadKey(value: unknown): { threadKey: string } | { error: string } {
  if (typeof value !== "string" || !THREAD_KEY_RE.test(value)) {
    return {
      error: `threadKey must be a platform-namespaced id matching ${String(THREAD_KEY_RE)} (e.g. "slack:C0123ABC:1712345.6789")`,
    };
  }
  return { threadKey: value };
}

function parsePositiveInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): { value: number } | { error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value };
}

/** Optional resident limits shared by /onboard and /reconfigure: each field
 *  is validated only when present; an absent field stays undefined (onboard
 *  applies its own provisioningTimeoutMs default). */
function parseResidentLimits(
  body: Record<string, unknown>,
): { diskBudgetMb?: number; provisioningTimeoutMs?: number; worktreeTtlDays?: number } | { error: string } {
  const limits: { diskBudgetMb?: number; provisioningTimeoutMs?: number; worktreeTtlDays?: number } = {};
  if (body.diskBudgetMb !== undefined) {
    const parsed = parsePositiveInt(body.diskBudgetMb, "diskBudgetMb", 1, 100_000);
    if ("error" in parsed) return { error: parsed.error };
    limits.diskBudgetMb = parsed.value;
  }
  if (body.provisioningTimeoutMs !== undefined) {
    const parsed = parsePositiveInt(
      body.provisioningTimeoutMs,
      "provisioningTimeoutMs",
      MIN_PROVISIONING_TIMEOUT_MS,
      MAX_PROVISIONING_TIMEOUT_MS,
    );
    if ("error" in parsed) return { error: parsed.error };
    limits.provisioningTimeoutMs = parsed.value;
  }
  if (body.worktreeTtlDays !== undefined) {
    const parsed = parsePositiveInt(body.worktreeTtlDays, "worktreeTtlDays", 1, 365);
    if ("error" in parsed) return { error: parsed.error };
    limits.worktreeTtlDays = parsed.value;
  }
  return limits;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const ROUTES: Record<string, { scope: Scope; method: string }> = {
  "/onboard": { scope: "admin", method: "POST" },
  "/offboard": { scope: "admin", method: "POST" },
  "/reconfigure": { scope: "admin", method: "POST" },
  "/rebuild": { scope: "admin", method: "POST" },
  "/residents": { scope: "read", method: "GET" }, // admin implied; read-only bearer allowed
  "/debug": { scope: "read", method: "POST" }, // per-op: READ_DEBUG_OPS for read scope, everything for admin
  "/status": { scope: "operator", method: "GET" },
  "/attach": { scope: "operator", method: "POST" },
  "/detach": { scope: "operator", method: "POST" },
  "/exec": { scope: "operator", method: "POST" },
  "/read": { scope: "operator", method: "POST" },
  "/write": { scope: "operator", method: "POST" },
  "/op": { scope: "operator", method: "POST" },
};

function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

function residentStub(env: Env, resource: string) {
  return getSandbox(env.RESIDENT, resource, { sleepAfter: SLEEP_AFTER });
}

/** Per-resource R2 prefix for future resident cache objects; offboard deletes
 *  everything beneath it. NOTE: SDK backup snapshots deliberately do NOT live
 *  here — they land under backups/<uuid>/ and are deleted via the stored
 *  handles in ResidentDO.teardown(). */
const r2Prefix = (resource: string) => `resident/${resource}/`;

/** Cursor-pagination walk over every list page under `prefix` — the shared
 *  half of the delete and count sweeps below. Each next page is fetched only
 *  after the caller finishes with the current one. */
async function* r2PrefixPages(bucket: R2Bucket, prefix: string): AsyncGenerator<Awaited<ReturnType<R2Bucket["list"]>>> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    yield page;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  for await (const page of r2PrefixPages(bucket, prefix)) {
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
  }
  return deleted;
}

/** Read-only twin of deleteR2Prefix, for the dry-run itemizations. */
async function countR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let count = 0;
  for await (const page of r2PrefixPages(bucket, prefix)) count += page.objects.length;
  return count;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated wake ping for `npm run deploy` — touches no DO, no data.
    // `build` names the commit this bundle was deployed from, so a deploy's
    // propagation is provable from the outside without auth.
    // `backupTransfer` (docs/reference/specs/resident-repos.md item 61): "presigned" when the container moves
    // snapshot bytes itself, "local" when the DO does — the one GET that proves
    // the R2 credentials landed (their names, never their values, on a miss).
    if (url.pathname === "/healthz" && request.method === "GET") {
      const transfer = backupTransferMode(env as unknown as Record<string, unknown>);
      return json({
        ok: true,
        build: BUILD,
        backupTransfer: transfer.mode,
        ...(transfer.missing.length > 0 ? { backupTransferMissing: transfer.missing } : {}),
      });
    }

    // Auth precedes existence: unknown paths demand admin before revealing
    // 404 vs 401, so an unauthenticated scanner learns nothing.
    const route = ROUTES[url.pathname];
    const bearer = bearerToken(request);
    if (!hasScope(env, bearer, route?.scope ?? "admin")) {
      return json({ error: "unauthorized" }, 401);
    }
    const isAdmin = tokenScope(env, bearer) === "admin";
    if (!route) return json({ error: "unknown route" }, 404);
    if (request.method !== route.method) return json({ error: `${route.method} only` }, 405);

    const body: Record<string, unknown> =
      route.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    // Authenticated from here (docs/reference/specs/tracing.md item 22): the bot's trace
    // context is read only now. The streamed routes hand it to the DO, whose
    // own root covers the work; every other route is one `resident.fetch` root.
    const traceparent = request.headers.get("traceparent") ?? undefined;
    const root = STREAMED_ROUTES.has(url.pathname)
      ? undefined
      : startAdoptedRoot(tracer, "resident.fetch", { sinks: traceSinks, traceparent, attrs: { route: url.pathname } });
    const res = await (async (): Promise<Response> => {
      try {
        switch (url.pathname) {
          case "/onboard":
            return await handleOnboard(env, body);
          case "/offboard":
            return await handleOffboard(env, body);
          case "/reconfigure":
            return await handleReconfigure(env, body);
          case "/rebuild":
            return await handleRebuild(env, body);
          case "/residents":
            return await handleResidents(env);
          case "/debug": {
            // Read scope may only run the pure-read ops; the check happens AFTER
            // auth so an unauthenticated caller still learns nothing extra.
            const op = typeof body.op === "string" ? body.op : "";
            // Authenticated but under-scoped → 403 (401 is reserved for "no valid bearer").
            if (!isAdmin && !READ_DEBUG_OPS.has(op))
              return json({ error: "forbidden: admin scope required for this op" }, 403);
            return await handleDebug(env, body);
          }
          case "/status":
            return await handleStatus(env, url);
          case "/attach":
            return await handleAttach(env, body, traceparent);
          case "/detach":
            return await handleDetach(env, body);
          case "/exec":
            return await handleExec(env, body, traceparent);
          case "/read":
            return await handleRead(env, body);
          case "/write":
            return await handleWrite(env, body);
          case "/op":
            return await handleOp(env, body, traceparent);
          default:
            return json({ error: "unknown route" }, 404);
        }
      } catch (err) {
        return json({ error: errMsg(err) }, 500);
      }
    })();
    root?.end(res.status >= 500 ? "error" : "ok", { httpStatus: res.status });
    return res;
  },

  /** Watchdog cron: one sparse pass that re-arms dead refresh chains
   *  (marking degraded(alarm-missed)) and times out stuck onboarding. Cadence
   *  invariant: this cron (every 10 minutes) stays SHORTER than SLEEP_AFTER
   *  ("20m"). It reads DO storage/schedules only — containers are started by
   *  the re-armed refresh alarms, not by the watchdog itself.
   *
   *  The cron is the `resident` entry of the schedule registry
   *  (src/core/schedules.ts — a unit test keeps wrangler.jsonc equal to it);
   *  each pass is recorded on the state Worker for the bot's /runs Scheduled
   *  panel, best-effort and off the critical path. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const schedule = scheduleForCron(controller.cron, "resident");
    if (!schedule) {
      console.error(
        `[schedule] cron "${controller.cron}" is not a resident schedule in the registry — nothing fired (wrangler.jsonc and src/core/schedules.ts have drifted)`,
      );
      return;
    }
    if (schedule.action.type !== "watchdog") {
      console.error(
        `[schedule] ${schedule.name}: action "${schedule.action.type}" is not something the resident Worker fires — nothing fired`,
      );
      return;
    }
    const firedAt = controller.scheduledTime || systemClock();
    // One `resident.watchdog` root per firing (docs/reference/specs/tracing.md item 25),
    // each resident's check a `resident.check` child; the firing the state
    // Worker records carries the root's trace id, like the shim's cron roots.
    const root = startAdoptedRoot(tracer, "resident.watchdog", { sinks: traceSinks });
    let firing: ScheduleFiring;
    try {
      const summary = await runWatchdog(env, root);
      console.log(`resident-watchdog: ${JSON.stringify(summary)}`);
      firing = { ...watchdogFiring(schedule, firedAt, summary), traceId: root.traceId };
      root.end(firing.outcome === "completed" ? "ok" : "error", { outcome: firing.outcome, residents: summary.count });
    } catch (err) {
      firing = {
        ...watchdogFiring(schedule, firedAt, err instanceof Error ? err : new Error(String(err))),
        traceId: root.traceId,
      };
      console.error(`resident-watchdog: ${firing.detail}`);
      root.fail(err);
      root.end("error", { outcome: firing.outcome });
    }
    ctx.waitUntil(
      recordFiring({ url: env.STATE_WORKER_URL, token: env.MEMORY_TOKEN }, firing).then((res) => {
        if (res.ok === false) console.error(`[schedule] ${schedule.name}: recording the firing failed — ${res.reason}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOnboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const commands = parseCommands(body.commands);
  if ("error" in commands) return json({ error: commands.error }, 400);
  const defaultRef = parseDefaultRef(body.defaultRef);
  if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);

  const limits = parseResidentLimits(body);
  if ("error" in limits) return json({ error: limits.error }, 400);
  const { diskBudgetMb, worktreeTtlDays } = limits;
  const provisioningTimeoutMs = limits.provisioningTimeoutMs ?? DEFAULT_PROVISIONING_TIMEOUT_MS;

  // Installation membership: the GitHub App installation is repository-
  // scoped and that scoping is a real control — onboard requires the repo to
  // already be in the installation's repository list. A repo-scoped mint
  // proves membership (the token API 422s for a repo outside the
  // installation), so the check IS the mechanism it protects. Enforced when
  // the App is configured; SKIPPED WITH AN HONEST WARNING when it is not
  // (anonymous clones still work for public repos). Runs BEFORE the registry
  // insert so a refused onboard never consumes a cap slot.
  let warning: string | undefined;
  if (githubAppConfigured(env)) {
    try {
      await mintRepoScopedToken(env, resource.resource.slice("repo:".length));
    } catch (err) {
      return json(
        {
          error:
            `not-in-installation: the GitHub App cannot mint a token scoped to ${resource.resource} — ` +
            `install the App on the repository first (${errMsg(err)})`,
        },
        403,
      );
    }
  } else {
    warning =
      "github-app-not-configured: installation membership was NOT verified (GITHUB_APP_* secrets unset); " +
      "clones/fetches will be anonymous — public repos only, and thread credentials stay unavailable";
  }

  const now = new Date(systemClock()).toISOString();
  const record: ResidentRecord = {
    resource: resource.resource,
    commands: commands.commands,
    defaultRef: defaultRef.defaultRef,
    ...(diskBudgetMb !== undefined ? { diskBudgetMb } : {}),
    provisioningTimeoutMs,
    ...(worktreeTtlDays !== undefined ? { worktreeTtlDays } : {}),
    onboardedAt: now,
    updatedAt: now,
  };

  // LRU eviction opt-in: admin-only by route, per-request, default off.
  if (body.evictColdest !== undefined && typeof body.evictColdest !== "boolean") {
    return json({ error: "evictColdest must be a boolean" }, 400);
  }
  const evictColdest = body.evictColdest === true;

  const registry = registryStub(env);
  let result = await registry.onboard(record);
  // "in" narrowing: the RPC stub intersects returns with Disposable, which
  // defeats boolean-discriminant narrowing.
  let evicted: Record<string, unknown> | undefined;
  if ("error" in result && result.status === 429 && evictColdest) {
    // Over the cap and asked to make room: offboard the coldest eligible warm
    // resident (pickEvictionCandidate — warm, idle, no live worktree, past the
    // floor), then retry the atomic insert ONCE. No candidate → the ordinary
    // 429, itemizing why each resident was ineligible, so the admin can
    // offboard by hand with the facts in front of them.
    const { floorS } = await registry.limits(); // the compiled floor, or an active test override (item 50)
    const pick = pickEvictionCandidate(await collectResidentViews(env), systemClock(), floorS * 1000);
    if (!pick.candidate) {
      return json({ error: `${result.error}; evictColdest found no eligible resident`, rejected: pick.rejected }, 429);
    }
    // Slot first, teardown second: `replace` frees the victim's slot and
    // inserts the newcomer in one input-gated registry section, so a
    // concurrent onboard can never take the freed slot and leave a resident
    // destroyed for nothing. Only once the newcomer holds the slot is the
    // victim's DO/R2 state torn down (its registry row is already gone, so no
    // new work routes to it meanwhile).
    result = await registry.replace(pick.candidate.resource, record);
    if ("error" in result) return json({ error: result.error, wouldHaveEvicted: pick.candidate }, result.status);
    const teardown = await teardownResident(env, pick.candidate.resource);
    evicted = { ...pick.candidate, registryRemoved: true, ...teardown };
    console.log(
      `lru-evict: offboarded ${pick.candidate.resource} (last activity ${pick.candidate.lastActivityAt}) to make room for ${resource.resource}`,
    );
  }
  if ("error" in result) return json({ error: result.error, ...(evicted ? { evicted } : {}) }, result.status);

  try {
    await residentStub(env, resource.resource).initResident(resource.resource, provisioningTimeoutMs);
  } catch (err) {
    // Fail closed: no half-onboarded residents. Free the slot and report.
    await registry.remove(resource.resource);
    return json({ error: `onboard failed arming the resident: ${errMsg(err)}`, ...(evicted ? { evicted } : {}) }, 500);
  }

  return json(
    {
      resource: resource.resource,
      state: "onboarding" satisfies ResidentState,
      ...(warning ? { warning } : {}),
      ...(evicted ? { evicted } : {}),
    },
    202,
  );
}

/** Registry record + live engine view per resident, shaped for the LRU
 *  picker. A live view that failed reads as `state:"unknown"` / `inFlight:null`
 *  — never as a cold candidate. */
async function collectResidentViews(env: Env): Promise<ResidentView[]> {
  const residents = await registryStub(env).list();
  const settled = await Promise.allSettled(
    residents.map((record) => residentStub(env, record.resource).getResidentInfo()),
  );
  return residents.map((record, i) => {
    const s = settled[i];
    const live = s.status === "fulfilled" ? s.value : {};
    // Validate each element like parsePullsBody does: a malformed thread row
    // is dropped rather than silently comparing `undefined` timestamps.
    const threads = (Array.isArray(live.threads) ? (live.threads as unknown[]) : []).flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const { lastAttachAt, evicted, user } = t as Record<string, unknown>;
      if (typeof lastAttachAt !== "string" || typeof user !== "string") return [];
      return [{ lastAttachAt, evicted: evicted === true, user }];
    });
    return {
      resource: record.resource,
      onboardedAt: record.onboardedAt,
      state: s.status === "fulfilled" && typeof live.state === "string" ? live.state : "unknown",
      inFlight: s.status === "fulfilled" && typeof live.inFlight === "number" ? live.inFlight : null,
      provisionedAt: typeof live.provisionedAt === "string" ? live.provisionedAt : null,
      threads,
    };
  });
}

async function handleOffboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const registry = registryStub(env);
  const record = await registry.getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // --dry-run: the itemized plan of what the real teardown below would
  // remove, computed READ-ONLY — the resident stays fully intact (state,
  // schedules, snapshots, registry slot all untouched). The DO plan and the
  // R2 prefix count touch disjoint data, so they run concurrently.
  if (body.dryRun === true) {
    const planPending = residentStub(env, resource.resource).teardownPlan();
    const countPending = countR2Prefix(env.BACKUP_BUCKET, r2Prefix(resource.resource));
    let plan: Awaited<ReturnType<ResidentDO["teardownPlan"]>>;
    try {
      plan = await planPending;
    } catch (err) {
      countPending.catch(() => {}); // the plan's named failure answers; the count is read-only
      return json({ error: `offboard dry-run failed: ${errMsg(err)}` }, 500);
    }
    const r2Objects = await countPending;
    return json({
      resource: resource.resource,
      dryRun: true,
      wouldRemove: {
        registryRecord: true,
        schedules: plan.schedules,
        snapshotBackupIds: plan.snapshotBackupIds,
        backupObjects: plan.backupObjects,
        r2Objects,
        threadBindings: plan.threadBindings,
        container: plan.state,
      },
    });
  }

  return json(await offboardResident(env, resource.resource));
}

/** The full offboard teardown (item 11), shared by POST /offboard and the LRU
 *  eviction path of POST /onboard: registry removal first (the slot frees
 *  atomically and no new work routes here), then the DO teardown and the
 *  resident/<resource>/ R2 prefix sweep concurrently — they touch disjoint
 *  data (the teardown's backup objects live under backups/<id>/). */
async function offboardResident(
  env: Env,
  resource: string,
): Promise<{ resource: string; registryRemoved: boolean } & Awaited<ReturnType<typeof teardownResident>>> {
  const registryRemoved = await registryStub(env).remove(resource);
  return { resource, registryRemoved, ...(await teardownResident(env, resource)) };
}

/** Everything AFTER the registry removal: DO teardown + R2 prefix sweep.
 *  Split out so the LRU path can reserve the slot atomically (registry
 *  `replace`) before destroying anything. */
async function teardownResident(
  env: Env,
  resource: string,
): Promise<{
  schedulesCancelled: boolean;
  containerStopped: boolean;
  storageCleared: boolean;
  backupObjectsDeleted: number;
  r2ObjectsDeleted: number;
  errors: string[];
}> {
  const [teardown, r2Sweep] = await Promise.all([
    residentStub(env, resource)
      .teardown()
      .catch((err: unknown): Awaited<ReturnType<ResidentDO["teardown"]>> => ({
        schedulesCancelled: false,
        containerStopped: false,
        storageCleared: false,
        backupObjectsDeleted: 0,
        errors: [`teardown failed: ${errMsg(err)}`],
      })),
    // The registry is already gone, so the offboard cannot be retried; a
    // transient R2 failure must degrade to a reported partial success (naming
    // the prefix left behind) rather than throw an unretryable 500.
    deleteR2Prefix(env.BACKUP_BUCKET, r2Prefix(resource))
      .then((deleted) => ({ deleted, error: undefined as string | undefined }))
      .catch((err: unknown) => ({
        deleted: 0,
        error: `r2 prefix sweep failed for ${r2Prefix(resource)}: ${errMsg(err)}`,
      })),
  ]);

  const errors = [...teardown.errors];
  if (r2Sweep.error) errors.push(r2Sweep.error);

  return {
    schedulesCancelled: teardown.schedulesCancelled,
    containerStopped: teardown.containerStopped,
    storageCleared: teardown.storageCleared,
    backupObjectsDeleted: teardown.backupObjectsDeleted,
    r2ObjectsDeleted: r2Sweep.deleted,
    errors,
  };
}

async function handleReconfigure(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const patch: Partial<
    Pick<
      ResidentRecord,
      "commands" | "effects" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs" | "worktreeTtlDays"
    >
  > = {};
  if (body.commands !== undefined) {
    const commands = parseCommands(body.commands);
    if ("error" in commands) return json({ error: commands.error }, 400);
    patch.commands = commands.commands;
  }
  if (body.effects !== undefined) {
    // Execution profiles for /op. Like `commands`, the map REPLACES the whole
    // stored one (admin-writable only; {} clears every override back to the
    // readonly default).
    const effects = parseEffects(body.effects);
    if ("error" in effects) return json({ error: effects.error }, 400);
    patch.effects = effects.effects;
  }
  if (body.defaultRef !== undefined) {
    const defaultRef = parseDefaultRef(body.defaultRef);
    if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);
    patch.defaultRef = defaultRef.defaultRef;
  }
  const limits = parseResidentLimits(body);
  if ("error" in limits) return json({ error: limits.error }, 400);
  if (limits.diskBudgetMb !== undefined) patch.diskBudgetMb = limits.diskBudgetMb;
  if (limits.provisioningTimeoutMs !== undefined) patch.provisioningTimeoutMs = limits.provisioningTimeoutMs;
  if (limits.worktreeTtlDays !== undefined) patch.worktreeTtlDays = limits.worktreeTtlDays;
  if (Object.keys(patch).length === 0) {
    return json(
      {
        error:
          "nothing to reconfigure (accepted: commands, effects, defaultRef, diskBudgetMb, provisioningTimeoutMs, worktreeTtlDays)",
      },
      400,
    );
  }

  const updated = await registryStub(env).updateConfig(resource.resource, patch);
  if (!updated) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return json({ resource: updated.resource, record: updated });
}

/** The down→onboarding rebuild — discard the stamped snapshots and
 *  reprovision from scratch through the ordinary provisioning pipeline,
 *  reusing the registry record (command table, ref, budget) as-is; the cap
 *  slot and thread bindings are untouched. `dryRun:true` answers 200 with the
 *  itemized plan and executes nothing; a real rebuild answers 202 like
 *  onboard (the transition is alarm-driven). */
async function handleRebuild(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const dryRun = body.dryRun === true;

  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  const result = await residentStub(env, resource.resource).rebuild(
    resource.resource,
    record.defaultRef,
    record.provisioningTimeoutMs,
    dryRun,
  );
  // "in" narrowing: the RPC stub intersects returns with Disposable, which
  // defeats boolean-discriminant narrowing (same note as handleOnboard).
  if ("error" in result) return json({ error: result.error }, result.status);
  return json(result, dryRun ? 200 : 202);
}

/** Admin enumeration: registry config + each resident's live engine view
 *  (state, sha, cache keys, snapshot stamp, refresh telemetry). Each probe
 *  targets a different DO, so they run concurrently; a failing one degrades
 *  to {error} without touching its neighbors, and the response order follows
 *  the registry list. */
async function handleResidents(env: Env): Promise<Response> {
  const residents = await registryStub(env).list();
  const settled = await Promise.allSettled(
    residents.map((record) => residentStub(env, record.resource).getResidentInfo()),
  );
  // Fleet-wide in-flight view: one call answers "is anything running anywhere?".
  // `inFlight` is the sum over residents whose live view answered with a count;
  // it is null — not 0 — as soon as any resident is unknown (live view rejected
  // or carried no numeric count), and `inFlightUnknown` says how many. A reader
  // that trusts the aggregate can therefore never mistake "we don't know" for
  // "idle". The deploy preflight walks `residents[].live` itself and refuses on
  // any unknown; this aggregate is for dashboards and humans.
  let known = 0;
  let inFlightUnknown = 0;
  const enriched: unknown[] = residents.map((record, i) => {
    const s = settled[i];
    if (s.status === "fulfilled" && typeof s.value.inFlight === "number") known += s.value.inFlight;
    else inFlightUnknown += 1;
    const live: unknown = s.status === "fulfilled" ? s.value : { error: errMsg(s.reason) };
    return { ...record, live };
  });
  const inFlight: number | null = inFlightUnknown === 0 ? known : null;
  // `cap` is what the registry ENFORCES right now; when a test override is
  // active it is lower than `capDefault` and `testOverrides` says who/when, so
  // a dashboard never mistakes a test cap for the real one (item 50).
  const limits = await registryStub(env).limits();
  return json({
    cap: limits.cap,
    capDefault: RESIDENT_CAP,
    ...(limits.override
      ? { testOverrides: { ...limits.override, floorS: limits.floorS, floorDefaultS: LRU_FLOOR_S } }
      : {}),
    count: residents.length,
    inFlight,
    inFlightUnknown,
    residents: enriched,
  });
}

async function handleStatus(env: Env, url: URL): Promise<Response> {
  const resource = parseResource(url.searchParams.get("resource"));
  if ("error" in resource) return json({ error: resource.error }, 400);

  // Body deliberately limited to { state, reason, inFlight } — operator scope
  // sees lifecycle and activity, not config.
  // Three RPCs in one flight, not one atomic snapshot: getStatus() awaits
  // storage, and the DO may run other work in that gap, so `state`/`reason`
  // and `inFlight` can be a hair apart (and differ slightly from a /residents
  // sample taken alongside). All are best-effort current-state reads; the
  // deploy gate reads /residents. The registry check rides in the same flight
  // (its 404 is judged first, the probes' results discarded then).
  const stub = residentStub(env, resource.resource);
  const [record, status, inFlight] = await Promise.all([
    registryStub(env).getRecord(resource.resource),
    stub.getStatus(),
    stub.getInFlightCount(),
  ]);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return json({ state: status.state, reason: status.reason, inFlight });
}

// -- thread data plane handlers -----------------------------------------------

/** Shared front half of the thread routes: validate resource + threadKey (P1:
 *  BEFORE anything derives a path or a git argument) and hand back the stub.
 *
 *  Only /attach checks the registry (`requireOnboarded`) — attach is where a
 *  binding is created, so "is this resource onboarded" is its question, and
 *  the 404 names it (plus the record rides on to the DO, saving its re-read).
 *  /exec /read /write /detach used to round-trip the SINGLETON registry DO per
 *  request too — a fleet-wide serialization point that bought nothing: those
 *  routes fail closed anyway (no binding → `not-attached`/`no-binding`; a
 *  never-onboarded resource's DO has no state → 503 `not-serviceable`), and a
 *  binding can only exist because an attach passed the real check. */
async function resolveThreadRoute(
  env: Env,
  body: Record<string, unknown>,
  requireOnboarded = false,
): Promise<
  { stub: ReturnType<typeof residentStub>; resource: string; threadKey: string; record?: ResidentRecord } | Response
> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const threadKey = parseThreadKey(body.threadKey);
  if ("error" in threadKey) return json({ error: threadKey.error }, 400);
  if (!requireOnboarded) {
    return { stub: residentStub(env, resource.resource), resource: resource.resource, threadKey: threadKey.threadKey };
  }
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return {
    stub: residentStub(env, resource.resource),
    resource: resource.resource,
    threadKey: threadKey.threadKey,
    record,
  };
}

/** Map a ThreadErr union member to its HTTP response (status leaves the body). */
function threadErrResponse(result: ThreadErr): Response {
  const { status, ...rest } = result;
  return json(rest, status);
}

async function handleAttach(env: Env, body: Record<string, unknown>, traceparent?: string): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body, true);
  if (ctx instanceof Response) return ctx;
  let refHint: string | null = null;
  if (body.refHint !== undefined) {
    const parsed = parseRef(body.refHint, "refHint");
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    refHint = parsed.ref;
  }
  const readonly = parseReadonly(body.readonly);
  if ("error" in readonly) return json({ error: readonly.error }, 400);
  const want = parseWantSha(body.sha);
  if ("error" in want) return json({ error: want.error }, 400);
  // Post-validation, the answer streams like /exec (item 59): heartbeat
  // whitespace then ONE JSON document over HTTP 200, so an attach that waits
  // on a deps install (minutes) cannot lose the connection the way a plain
  // response does (`fetch failed` a few minutes in). A refusal
  // carries its `status` in the body; `ResidentExecutor.attach` reads it there.
  return streamHeartbeatJson(
    ctx.stub.attachThread(ctx.threadKey, refHint, readonly.readonly, want.sha, ctx.record, traceparent),
    (result) => result,
    (err) => ({ error: errMsg(err), status: 500 }),
  );
}

async function handleDetach(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  const result = await ctx.stub.detachThread(ctx.threadKey, body.force === true);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

async function handleExec(env: Env, body: Record<string, unknown>, traceparent?: string): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.command !== "string" || body.command.length === 0 || body.command.length > MAX_EXEC_COMMAND_LENGTH) {
    return json({ error: `command must be a non-empty string of at most ${MAX_EXEC_COMMAND_LENGTH} chars` }, 400);
  }
  // The client's number is never trusted: the SAME clamp rule bot-side code
  // uses — a finite number lands in [1s, 20 min], anything else (absent, NaN,
  // a string) runs at the 5-minute default. A clamp, not a 400: an out-of-range
  // ask still runs, at the nearest bound.
  const timeoutMs = clampBashTimeout(body.timeoutMs);
  return streamThreadExec(ctx.stub.execThread(ctx.threadKey, body.command, timeoutMs, traceparent));
}

/** Stream one pending result with the thread-sandbox Worker's heartbeat
 *  convention (shared by /exec and /op): headers go out immediately, a
 *  whitespace byte every 15s keeps intermediaries from dropping the idle
 *  connection while a long command runs, then exactly ONE JSON document.
 *  Every post-validation outcome — results AND named errors — arrives
 *  in-body over HTTP 200; the handlers supply only the payload mapping. */
function streamHeartbeatJson<T>(
  pending: Promise<T>,
  toPayload: (result: T) => object,
  toErrorPayload: (err: unknown) => object,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(beat); // client went away; the pending promise still settles
        }
      }, 15_000);
      const finish = (payload: object) => {
        clearInterval(beat);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        } catch {
          // stream already errored/cancelled — nothing left to deliver to
        }
      };
      // Item 62: the streamed document is the other exit; same sanitizer.
      pending
        .then((result) => finish(sanitizeResidentBody(toPayload(result))))
        .catch((err: unknown) => finish(sanitizeResidentBody(toErrorPayload(err))));
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

/** /exec's payload mapping: a result as {stdout, stderr, exitCode, truncated},
 *  a named failure as {error, needs?, reason?, stdout:"", stderr:error, exitCode:127}
 *  (`reason:"runtime-replaced"` is how the client tells a deploy from a dead
 *  exec transport). */
function streamThreadExec(pending: Promise<Awaited<ReturnType<ResidentDO["execThread"]>>>): Response {
  return streamHeartbeatJson(
    pending,
    (result) =>
      "error" in result
        ? {
            error: result.error,
            ...(result.needs ? { needs: result.needs } : {}),
            // `reason` must stay independent of `state`: runtimeReplacedErr()
            // sets reason:"runtime-replaced" with NO state, and the client's
            // deploy-vs-dead-transport check reads it. Folding these two spreads
            // back into one silently drops it (no test covers this Worker).
            ...(result.state ? { state: result.state } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            stdout: "",
            stderr: result.error,
            exitCode: 127,
          }
        : { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated },
    (err) => {
      const msg = errMsg(err);
      return { error: msg, stdout: "", stderr: msg, exitCode: 127 };
    },
  );
}

async function handleRead(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.path !== "string")
    return json({ error: "path must be a string relative to the thread worktree" }, 400);
  const result = await ctx.stub.readThreadFile(ctx.threadKey, body.path);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

async function handleWrite(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.path !== "string")
    return json({ error: "path must be a string relative to the thread worktree" }, 400);
  if (typeof body.content !== "string" || body.content.length > MAX_WRITE_CONTENT) {
    return json({ error: `content must be a string of at most ${MAX_WRITE_CONTENT} chars` }, 400);
  }
  const result = await ctx.stub.writeThreadFile(ctx.threadKey, body.path, body.content);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

// -- deterministic ops handler (/op) -------------------------------------------

const OP_NAMES = ["test", "build", "status"] as const;

/** POST /op {resource, op, ref?} (operator scope): the deterministic
 *  modelless path. `op` resolves ONLY through this fixed enum into the
 *  onboard-time command table (never request text into a shell); `ref` passes
 *  the same strict pattern as every ref input and must resolve in the mirror.
 *  Every entry's `effects` profile gates execution — readonly runs, mutating
 *  is refused BY NAME (test/build/status are readonly by construction; the
 *  refusal is the guard rail for future entries). test/build run in a
 *  disposable per-op checkout (see ResidentDO.runOp) and stream like /exec;
 *  status touches no checkout at all — DO storage reads only. */
async function handleOp(env: Env, body: Record<string, unknown>, traceparent?: string): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const op = body.op;
  if (typeof op !== "string" || !(OP_NAMES as readonly string[]).includes(op)) {
    return json({ error: `op must be one of ${OP_NAMES.join(", ")}` }, 400);
  }
  let ref: string | null = null;
  if (body.ref !== undefined) {
    const parsed = parseRef(body.ref, "ref");
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    ref = parsed.ref;
  }
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  const effects = record.effects?.[op] ?? "readonly";
  if (effects !== "readonly") {
    return json(
      {
        error: `op-refused: the "${op}" command-table entry is marked effects: ${effects} — the modelless op path executes readonly entries only`,
      },
      409,
    );
  }

  const stub = residentStub(env, resource.resource);
  if (op === "status") {
    const info = await stub.getResidentInfo();
    const state = String(info.state ?? "down");
    const sha = typeof info.sha === "string" ? info.sha : "";
    const summary =
      `${resource.resource} is ${state}` +
      (info.reason ? ` (${String(info.reason)})` : "") +
      (info.defaultRef ? ` on ${String(info.defaultRef)}` : "") +
      (sha ? ` @ ${sha.slice(0, 8)}` : "") +
      (info.lastRefreshAt ? `, last refresh ${String(info.lastRefreshAt)}` : "");
    return json({
      // ok = serviceable: down is the one state nothing can serve from
      // (degraded still serves the last snapshot).
      ok: state !== "down",
      op,
      resource: resource.resource,
      state,
      reason: info.reason ?? "",
      ref: info.defaultRef ?? null,
      sha: info.sha ?? null,
      lastRefreshAt: info.lastRefreshAt ?? null,
      lastRestore: info.lastRestore ?? null,
      summary,
    });
  }
  return streamOp(stub.runOp(op as "test" | "build", ref, traceparent));
}

/** /op's payload mapping: results pass through; a named error sheds its
 *  transport-only `status` field (the body is the contract, never the code). */
function streamOp(pending: Promise<Awaited<ReturnType<ResidentDO["runOp"]>>>): Response {
  return streamHeartbeatJson(
    pending,
    (result) => {
      if ("error" in result) {
        const { status: _status, ...rest } = result;
        return rest;
      }
      return result;
    },
    (err) => ({ error: errMsg(err) }),
  );
}

/** Admin diagnostic surface, used by the live validation of the freshness engine (kill-refresh /
 *  stop-container simulate dead chains and platform sleeps; mint-token proves
 *  the command-level mint failure shape without exposing token material).
 *  Side-effect-explicit; every op is admin-scope except the pure reads
 *  info/schedules/threads, which the read scope may also run. */
async function handleDebug(env: Env, body: Record<string, unknown>): Promise<Response> {
  const op = typeof body.op === "string" ? body.op : "";
  if (op === "run-watchdog") return json(await runWatchdog(env));
  if (op === "set-test-overrides") {
    // Item 49: lower the effective cap / LRU floor for live over-cap checks.
    // Registry-wide (no `resource`), admin-only (not in READ_DEBUG_OPS), only
    // ever lower than the compiled constants, and stamped with the build commit so
    // the next deploy ignores it. An empty body clears.
    const parsed = parseTestOverrides(body, { cap: RESIDENT_CAP, floorS: LRU_FLOOR_S });
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    const limits = await registryStub(env).setTestOverrides("clear" in parsed ? null : parsed.overrides);
    console.log(
      `test-overrides: ${"clear" in parsed ? "cleared" : JSON.stringify(parsed.overrides)} → effective cap ${limits.cap}, floorS ${limits.floorS}`,
    );
    return json({
      op,
      cap: limits.cap,
      capDefault: RESIDENT_CAP,
      floorS: limits.floorS,
      floorDefaultS: LRU_FLOOR_S,
      override: limits.override,
    });
  }
  if (op === "mint-token") {
    const resource = parseResource(body.resource);
    if ("error" in resource) return json({ error: resource.error }, 400);
    try {
      await mintRepoScopedToken(env, resource.resource.slice("repo:".length));
      return json({ op, ok: true, note: "token minted and cached (value withheld)" });
    } catch (err) {
      // The command-level failure shape: an error result, never a
      // lifecycle transition — verify via /status that state is untouched.
      return json({ op, ok: false, error: errMsg(err) });
    }
  }

  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const stub = residentStub(env, resource.resource);
  switch (op) {
    case "info":
      return json(await stub.getResidentInfo());
    case "schedules":
      return json(await stub.debugSchedules());
    case "kill-refresh":
      return json(await stub.debugKillRefresh());
    case "refresh-now":
      return json(await stub.debugRefreshNow());
    case "stop-container":
      return json(await stub.debugStopContainer());
    case "force-onboarding":
      return json(await stub.debugForceOnboarding());
    case "force-down": {
      // Fault injection for the watchdog auto-rebuild path; a
      // rehydration-flavored default reason makes it strike-eligible.
      const reason =
        typeof body.reason === "string" && body.reason ? body.reason : "r2-restore-failed: injected (debug force-down)";
      return json(await stub.debugForceDown(reason));
    }
    case "threads":
      return json(await stub.debugThreads());
    case "deps-backups":
      return json(await stub.debugDepsBackups());
    case "sweep-now":
      return json(await stub.debugSweepNow());
    case "reclaim-now":
      return json(await stub.debugReclaimNow());
    case "purge-bindings": {
      // Item 56: drop a load run's evicted synthetic bindings. `prefix` is
      // validated by the pure decision (a whole non-production namespace).
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      const r = await stub.debugPurgeBindings(prefix);
      return "error" in r ? json({ error: r.error }, 400) : json(r);
    }
    case "measure-disk":
      // Item 55: take the sample now (df + one du) and answer it — the live
      // check's way to read the gauge without waiting for a cycle.
      return json({ disk: await stub.debugMeasureDisk() });
    case "backdate-thread": {
      const threadKey = parseThreadKey(body.threadKey);
      if ("error" in threadKey) return json({ error: threadKey.error }, 400);
      const days = parsePositiveInt(body.days, "days", 1, 3650);
      if ("error" in days) return json({ error: days.error }, 400);
      return json(await stub.debugBackdateThread(threadKey.threadKey, days.value));
    }
    default:
      return json(
        {
          error: `unknown op ${JSON.stringify(op)} (ops: info, schedules, kill-refresh, refresh-now, stop-container, force-onboarding, force-down, mint-token, run-watchdog, set-test-overrides, threads, sweep-now, reclaim-now, measure-disk, purge-bindings, backdate-thread)`,
        },
        400,
      );
  }
}

/** One watchdog pass over every registered resident. Shared by the cron
 *  handler and the /debug run-watchdog op. Each check targets a different DO,
 *  so they run concurrently; a failing one becomes its own {error} entry
 *  without touching its neighbors, and the results follow the registry list. */
async function runWatchdog(env: Env, parent?: TraceSpan): Promise<WatchdogSummary> {
  const registry = registryStub(env);
  const residents = await registry.list();
  // Each check is a `resident.check` child of the firing's root when it has
  // one (the cron path; the /debug op runs bare), ending with the action taken
  // — never the resource, which names a repo.
  const checkOne = async (record: { resource: string }, span?: TraceSpan) => {
    const check = await residentStub(env, record.resource).watchdogCheck();
    if (check.action === "provision-timed-out") {
      // The DO already tried to release its own slot; this is the backstop.
      await registry.remove(record.resource);
    }
    span?.setAttrs({ outcome: check.action });
    return check;
  };
  const settled = await Promise.allSettled(
    residents.map((record) =>
      parent ? parent.span("resident.check", (span) => checkOne(record, span)) : checkOne(record),
    ),
  );
  const results: WatchdogSummary["results"][number][] = residents.map((record, i) => {
    const s = settled[i];
    return s.status === "fulfilled"
      ? {
          resource: record.resource,
          state: s.value.state,
          reason: s.value.reason,
          action: s.value.action,
          disk: s.value.disk,
        }
      : { resource: record.resource, error: errMsg(s.reason) };
  });
  return { cap: (await registry.limits()).cap, count: residents.length, results };
}

function json(data: unknown, status = 200): Response {
  // Item 62: every non-streamed body leaves through here; its `error`,
  // `reason` and `summary` strings are made safe at the exit.
  return new Response(JSON.stringify(sanitizeResidentBody(data)), {
    status,
    headers: { "content-type": "application/json" },
  });
}
