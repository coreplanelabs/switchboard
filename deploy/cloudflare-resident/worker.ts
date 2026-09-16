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
// Lifecycle engine: schedule-driven provisioning (clone → install/build →
// stamped snapshot → warm; the one timer left), wake-path rehydration
// (`restoring` persisted BEFORE restore, stamped snapshots refused on
// mismatch), the refresh cycle as a Workflow instance the cron creates per
// resident and ten-minute bucket (refresh.ts: fetch, install, build,
// snapshot, then the worktree sweep and the disk measurement as steps), and
// a cron watchdog (create the due instances; name a stale mid-flight marker
// by its instance; time out stuck onboarding; auto-rebuild after N
// consecutive down passes on a rehydration-flavored reason). GitHub App tokens are minted
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
import { decideWorktree, parseReuse, type WorktreeFacts } from "../../src/execution/residentReuse.js";
import {
  boundByFor,
  canReturnToDefault,
  parseOwnPr,
  parsePushed,
  parseRefByDefault,
  rebindPlan,
  rebindRefused,
  rebindVerdict,
  rememberOwnBranches,
  returnToDefault,
  type BoundBy,
  type OwnBranch,
  type OwnPr,
  type PushedBranch,
  type Returned,
  type Rebound,
  type RebindRefused,
  type RebindTreeFacts,
} from "../../src/execution/residentRebind.js";
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
import {
  evictedTreeOf,
  evictedTreeSentence,
  parseWorktreeCleanliness,
  worktreeCleanlinessScript,
  type EvictedTree,
  type LeftBehind,
  type WorktreeCleanliness,
} from "../../src/execution/residentCleanliness.js";
import {
  base64LengthOf,
  chunkPlan,
  MAX_READ_BYTES,
  parseByteSize,
  readChunkCommandFor,
  readCommandFor,
  readEncodingOf,
  statCommandFor,
  type Base64ReadAnswer,
  type ReadEncoding,
} from "../../src/execution/binaryRead.js";
import {
  capBytesFor,
  capWrappedCommand,
  execCapFiles,
  recoverCapturedOutput,
} from "../../src/execution/residentExecWrap.js";
import { shellQuote } from "../../src/execution/shellQuote.js";
import { envFromRequest } from "../../src/execution/sandboxEnv.js";
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
import { RestoreWaiters } from "../../src/execution/restoreWaiters.js";
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
  restoreFailureDisposition,
  isRuntimeUnreachableSignal,
  killStaleBuildProcessesCommand,
  planRefresh,
  RUNTIME_REPLACEMENT_WORDING,
  RUNTIME_UNREACHABLE_DOWN_AT,
  runtimeUnreachableReason,
  runtimeUnreachableRung,
  SDK_CONNECT_TIMEOUT_MS,
  SDK_RUNTIME_RECORD_KEY,
  judgeRestoreProgress,
  planWakeDepsBudget,
  RESTORE_MAX_MS,
  RESTORE_POLL_MS,
  restoreArchivePath,
  withTimeout,
  type RefreshDisk,
  type RefreshPlan,
  type RestoreSample,
  type RefreshFailure,
} from "../../src/execution/residentRefresh.js";
import { autoRebuildDecision, isAutoRebuildEligible } from "../../src/execution/residentAutoRebuild.js";
import {
  lifecycleOf,
  parseLifecycle,
  type RefreshRow,
  type ResidentLifecycle,
} from "../../src/execution/residentInstanceId.js";
import {
  MIRROR_MUTEX_KEY,
  REFRESH_CYCLE_LEASE_MS,
  STALE_MIDFLIGHT_MS,
  depsLeaseKey,
  liveInFlight,
  mintIncarnationId,
  inFlightKey,
  inFlightRow,
  releaseMutex,
  takeMutex,
  type InFlightRow,
  type Lease,
} from "../../src/execution/residentIncarnation.js";
import {
  LAST_FETCH_KEY,
  planBuild,
  planFetchMirror,
  planInstallDeps,
  planMaterializeDeps,
  planRestore,
  planSnapshot,
  snapshotCommitDecision,
  type FetchRecord,
  type SnapshotStamp,
} from "../../src/execution/residentStepPlan.js";
import { backupIdsOf, RETIRED_SNAPSHOT_KEY, rotateSnapshots } from "../../src/execution/snapshotRetention.js";
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
import {
  attachTarget,
  type FetchReason,
  mirrorFetchReason,
  parseWantSha,
  wantShaForBinding,
} from "../../src/execution/residentHead.js";
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
import { startAdoptedRoot } from "../../src/core/trace/workerTrace.js";
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
  depsAttemptOfScratchPath,
  depsAttemptPaths,
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
  DEPS_STORE_MAX_UNREFERENCED_UNDER_PRESSURE,
  type DepsEvictionPlan,
  type DepsStoreListing,
} from "../../src/execution/residentDepsStore.js";
import { buildId, injectedBuildStamp } from "../../src/deploy/buildStamp.js";
import { createRefreshInstance, createRefreshInstanceNow, type RefreshInstanceParams } from "./refresh";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEPS_STEP_OVERHEAD_MS,
  errMsg,
  GIT_NETWORK_TIMEOUT_MS,
  THREAD_POOL_SIZE,
  R2_TRANSFER_TIMEOUT_MS,
  REFRESH_BUILD_TIMEOUT_MS,
  REFRESH_INSTALL_TIMEOUT_MS,
  REFRESH_INTERVAL_S,
  registryStub,
  residentStub,
  tracer,
  traceSinks,
} from "./shared";

/** The refresh cycle's Workflow entrypoint is declared in refresh.ts; the
 *  Workflows binding resolves its `class_name` against this module
 *  (wrangler.template.jsonc), so the entry exports it under that name. */
export { ResidentRefresh } from "./refresh";

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
// the request carried one. The tracer and its log sink are shared.ts's: the
// refresh instance's root (refresh.ts) starts from the same pair.
const STREAMED_ROUTES: ReadonlySet<string> = new Set(["/attach", "/exec", "/op", "/await-restore"]);

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

export interface Env {
  RESIDENT: DurableObjectNamespace<ResidentDO>;
  REGISTRY: DurableObjectNamespace<ResidentRegistryDO>;
  BACKUP_BUCKET: R2Bucket;
  /** The refresh cycle as a Workflow instance (docs/reference/specs/resident-repos.md
   *  item 7): `ResidentRefresh` in refresh.ts, re-exported above. The watchdog
   *  cron creates one per resident and ten-minute bucket. */
  RESIDENT_REFRESH: Workflow<RefreshInstanceParams>;
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

/** After `output()`'s wait gives up on a process the supervisor should have
 *  killed at `timeout`, how long to wait for the exit status of OUR kill
 *  before reporting the step without one. */
const KILL_EXIT_WAIT_MS = 10_000;
/** The mirror-mutex lease for a section that names no step budget of its own
 *  (attach's clone section, a sweep's eviction, the wake and reclaim fetches):
 *  a holder of the current incarnation still holding past this has hung, the
 *  same bound the watchdog puts on a mid-flight state. The engine steps pass
 *  their exact budgets instead. */
const MIRROR_LEASE_DEFAULT_MS = STALE_MIDFLIGHT_MS;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
const THREAD_USERS = Array.from({ length: THREAD_POOL_SIZE }, (_, i) => `worker${i + 2}`);

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
/** A live binding whose last attach is older than this and has no op in
 *  flight is released by the sweep step (every refresh instance runs one),
 *  whatever its tree holds (item 17) — runs that ended before /detach existed,
 *  or whose release call was lost. */
const CLEAN_IDLE_RELEASE_S = 60 * 60;
/** Idle sleep: when no live binding was attached to or used within this
 *  window and nothing is in flight, the refresh cycle skips the fetch and the
 *  cron holds the next instance to the idle cadence, so the container can
 *  actually sleep (SLEEP_AFTER); the next attach refreshes first if the mirror
 *  is stale (refresh-on-attach). The disk-full recycle (item 54) reads the
 *  same window through the same predicate (`recentlyUsed`): a sleep and a
 *  recycle destroy the same disk, so one rule says when it may go away. */
const IDLE_AFTER_S = 60 * 60;
/** LRU eviction floor: an over-cap onboard with `evictColdest:true` may
 *  offboard the coldest eligible warm resident, but never one whose last
 *  activity (attach or provisioning) is younger than this — a repo used
 *  minutes ago must not go cold to make room. Same window as idle sleep. */
const LRU_FLOOR_S = IDLE_AFTER_S;
/** Budget for one GitHub REST call in the reclamation pass (pulls lookup per
 *  live non-default binding); a slow API answers "unknown", never blocks the cycle. */
const GITHUB_API_TIMEOUT_MS = 10_000;
/** A resident degraded with the SAME reason for this many consecutive cycles
 *  is chronically broken (e.g. the default branch's build fails); retrying
 *  every 10 min bills the container 24/7 for nothing. After the streak it may
 *  idle-park like a warm one; the next attach still refreshes first. */
const DEGRADED_PARK_AFTER_CYCLES = 3;
const DEGRADED_STREAK_KEY = "resident:degradedStreak";
/** Degraded reasons that are not evidence about the repository — both always
 *  carry a `: detail` suffix: the watchdog's `stale-mid-flight: …` (a marker
 *  a dead cycle left behind; a cycle must run) and the wake path's
 *  `restore-interrupted: …` (the runtime was replaced under a restore; the
 *  step's retry restores again). They never count toward the park streak.
 *  Deliberate trade-off: a resident that oscillates between a
 *  refresh-produced failure and a watchdog stamp (e.g. `install-failed` → DO
 *  eviction → `stale-mid-flight` → `install-failed` …) keeps resetting the
 *  streak and never parks — full 10-min cadence for a chronically broken
 *  repo. Accepted: a watchdog stamp means the previous "same reason"
 *  observation is not trustworthy, and preserving the streak across it would
 *  re-open the parked-degraded hole this fixes. A refresh step killed from
 *  outside (`refresh-interrupted`, `classifyRefreshFailure`) is never recorded
 *  as `degraded` at all: the instance throws it to the engine, whose retry
 *  re-enters the step. A control port that did not answer
 *  (`runtime-unreachable: …`, item 64) is the third: no command ran, the
 *  ladder over its own persisted count owns the recovery. */
const NON_EVIDENCE_REASON = /^(?:stale-mid-flight|restore-interrupted|runtime-unreachable):/;
/** When the disk-full recovery last stopped the container (docs/reference/specs/resident-repos.md item 54):
 *  feeds `planDiskFullRecovery`'s cooldown so a working set that refills the
 *  disk is named, not recycled in a loop. */
const DISK_FULL_RECYCLE_KEY = "resident:diskFullRecycleAt";
/** The last disk measurement (docs/reference/specs/resident-repos.md item 55; `residentDiskBudget.ts`): one
 *  `df` + one `du` over the parts, taken by every refresh instance's `measure`
 *  step after its sweep. Surfaced as the live view's `disk`; the attach
 *  admission projects a new tree's cost from its parts (its free-space term
 *  is a live `df` of its own). */
const DISK_KEY = "resident:disk";
/** The lifecycle row (docs/reference/specs/resident-repos.md item 7): `workflow`,
 *  the one scheduler. Kept from the flagged rollout so `/status` and `/debug
 *  info` can say so; an `alarm` value a flip left behind reads `workflow`
 *  (`lifecycleOf`) — the chain it named no longer exists. Rewritten by the
 *  admin `/debug` `lifecycle` op. */
const LIFECYCLE_KEY = "resident:lifecycle";
/** The refresh instance row (item 7): the last instance created for this
 *  resident, with the step it last reported and the cycle lease it holds, and
 *  the last bucket the cron skipped (a live cycle, a duplicate id). */
const REFRESH_INSTANCE_KEY = "resident:refreshInstance";
/** A `du` over a multi-GB checkout plus every live tree is seconds warm, tens
 *  of seconds on a cold page cache — the same class as a git network step. */
const DU_TIMEOUT_MS = GIT_NETWORK_TIMEOUT_MS;
function isNonEvidenceReason(reason: string): boolean {
  return NON_EVIDENCE_REASON.test(reason);
}

/** Attach waits on the mirror mutex under this named timeout; expiry answers
 *  503 {state, reason: "mirror-busy"} instead of queueing forever. */
const ATTACH_MUTEX_WAIT_MS = 60_000;

// Auto-rebuild (item 36): a resident `down` on a reason only a rebuild can
// escape (REHYDRATION_FAILURE_RE, `residentAutoRebuild.ts`) is rebuilt on the
// `goDown` transition itself, under `AUTO_REBUILD_BUDGET` per window; the
// watchdog is the backstop for a transition that could not act (no registry
// record at the time). Provision-failure downs never auto-rebuild — they would
// loop against the same broken build.

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

/** The container's control port never answered: `exec` rejected with the
 *  DOMException of the SDK's connect abort (`DEFAULT_CONNECT_TIMEOUT_MS`,
 *  30 s), raised inside its wake path — `RuntimeBootstrapProbe.probe` →
 *  `ContainerControlConnection.fetchUpgradeAttempt`, the WebSocket upgrade to
 *  port 3000 — before any process could start. Not a replacement (the runtime
 *  did not change; it is silent), not a command failure (nothing ran), not
 *  evidence about the repository. Carries the persisted consecutive count the
 *  ladder decides on (`runtimeUnreachableRung`, docs/reference/specs/resident-repos.md
 *  item 64); the message is the named reason, never the SDK's bare
 *  `The operation was aborted` — which is what the incident this names sat
 *  behind as `degraded(refresh-failed: The operation was aborted)` for forty
 *  minutes while nothing escalated. */
class RuntimeUnreachableError extends Error {
  constructor(
    readonly count: number,
    readonly cause: unknown,
  ) {
    super(runtimeUnreachableReason(count));
    this.name = "RuntimeUnreachableError";
  }
}

/** Does this exec rejection mean the control port never answered? The pure
 *  signal (`isRuntimeUnreachableSignal`: the `AbortError` name, or the
 *  DOMException's message when a wrapper copied only that) over the error and
 *  its cause chain. Asked only AFTER `isRuntimeReplacement` — a replaced
 *  runtime is a different fact — and only of a spawn-phase error: a
 *  command's own output is a `StepError` with an exit code and never gets here. */
function isRuntimeUnreachable(err: unknown): boolean {
  for (const link of selfAndCauses(err)) if (isRuntimeUnreachableSignal(link)) return true;
  return false;
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
 *  current allocation; `ref` is sticky for the thread's whole life, with one
 *  exception — the branch the thread's own run opened a pull request on
 *  (`rebound`, docs/reference/specs/resident-repos.md item 16). */
interface ThreadBinding {
  threadKey: string;
  ref: string;
  /** How `ref` was chosen: the repo default for want of a named branch — when
   *  the binding was made (item 30), or when a return put it there because the
   *  branch it was on is gone (`returned`) — or a branch someone named. Absent
   *  on a binding made before the field: read as `default` iff `ref` is the
   *  default branch. Only a `default` binding may ever move onto a branch. */
  boundBy?: BoundBy;
  /** The move a binding may make (item 16): from the default it was bound to,
   *  onto the branch the thread's own run opened a pull request on. Set, the
   *  binding moves again only after the move is returned (`returnedAt`: the
   *  branch was gone from the mirror and the binding went back to the
   *  default), and then for the next own pull request. */
  rebound?: Rebound;
  /** The binding's last move back to the default (item 16's second movement):
   *  the branch it was on — one a rebind moved it onto, or one this thread's
   *  own runs pushed (`ownBranches`) and bound by name, a ship unit's — was
   *  gone from the mirror at an attach. From where, to where, which pull
   *  request's branch it was, when. */
  returned?: Returned;
  /** The branches the thread's own runs pushed and the pull requests they
   *  head, as each run's release handed them over (`/detach` `pushed`, item
   *  16a) — written before any eviction decision, so the fact outlives the
   *  tree: the tree is released the moment its run ends, and this is what
   *  lets the follow-up's attach move onto the branch and provision the tree
   *  there. Newest last; the oldest fall off past `OWN_BRANCHES_MAX`. */
  ownBranches?: OwnBranch[];
  /** Allocated OS user (worker2..worker17); "" once evicted (pool released). */
  user: string;
  worktreePath: string;
  boundAt: string;
  lastAttachAt: string;
  evicted?: boolean;
  evictedAt?: string;
  /** Why the last eviction happened (the audit trail): `ttl`, `clean-idle`,
   *  `detach`, `disk-pressure`, or a reclamation fate — `merged #N` /
   *  `closed #N` / `gone`. */
  evictedWhy?: string;
  /** What the tree held when that eviction removed it (item 17: never a
   *  reason to keep the tree, never discarded silently): the tracked changes
   *  and unpushed commits measured as the thread user. Absent when the tree
   *  was clean, already gone with the disk, or not measured (a force detach). */
  evictedLeftBehind?: LeftBehind;
  /** Why the tree could not be measured before that eviction (git could not
   *  read it) — so an unreadable tree is never recorded as clean. */
  evictedUnmeasured?: string;
  /** What the tree held when the last disk-full recycle (item 54) discarded
   *  it with the disk — the same measurement as `evictedLeftBehind`, under its
   *  own name because the binding is not evicted: its user is kept and the
   *  next attach recreates the tree (`worktree-missing`). Both rewritten on
   *  every recycle; absent when the tree was clean or already gone. */
  recycledLeftBehind?: LeftBehind;
  /** Why the tree could not be measured before that recycle (git could not
   *  read it) — still discarded with the disk, never recorded as clean. */
  recycledUnmeasured?: string;
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
  /** Which container the tree is in: the kernel's boot id of this resident's
   *  VM (docs/reference/specs/harness-pi.md item 8), so the run's row can name
   *  the container its pi runs in. Absent when the kernel does not say. */
  container?: string;
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
  /** This attach moved the binding onto the branch the thread's own run opened
   *  a pull request on (item 16): from where, to where, which PR. */
  rebound?: Rebound;
  /** The caller asked for that move and the binding stood: the branch, the PR
   *  and why — so the bot can say where the follow-up runs and why. */
  rebindRefused?: RebindRefused;
  /** This attach moved the binding BACK to the default branch (item 16's
   *  second movement): the branch it was on — a rebind's, or one this thread
   *  itself pushed — is gone from the mirror, so the tree was provisioned on
   *  the default instead of the attach failing `unknown-ref`. From where, to
   *  where, which PR's branch it was. */
  returned?: Returned;
}

/** What `POST /detach` answers: whether the pool user went back, why not, and
 *  — on a release — what the tree still held (item 16a), now gone with it. */
interface DetachAnswer {
  released: boolean;
  reason?: string;
  user?: string;
  leftBehind?: LeftBehind;
}

/** Why the caller's `refHint` is what it is (item 16), beside the hint itself:
 *  `ownPr` — the pull request the thread's own run opened, whose head branch
 *  the hint is (the one reason a binding may move; never a PR a person named);
 *  `refByDefault` — the caller bound the resident's own default branch because
 *  its message named none (item 30), recorded on a new binding as `boundBy`. */
interface RefHintReason {
  ownPr: OwnPr | null;
  refByDefault: boolean;
}

/** The body every bot always sent: a hint with no reason attached. */
const NO_REF_HINT_REASON: RefHintReason = { ownPr: null, refByDefault: false };

/** What the rebind decided under the mutex (item 16): nothing to move (the
 *  row is already on the branch), a named refusal, or the move — written on
 *  the row; the attach that follows provisions the tree at the moved ref. */
type RebindOutcome =
  | { kind: "none"; binding: ThreadBinding }
  | { kind: "refuse"; refused: RebindRefused }
  | { kind: "rebound"; moved: ThreadBinding; rebound: Rebound };

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
  /** Set while the resident is in idle mode (the cron holds the next refresh instance to the idle cadence so the container may sleep). */
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

/** What the snapshot step answers: the record already at the stamp, a record
 *  it committed (with the one it replaced), or a step another writer won. */
type SnapshotStepResult =
  | { done: true; record: SnapshotRecord }
  | { done: false; superseded: false; record: SnapshotRecord; previous: SnapshotRecord | undefined }
  | { done: false; superseded: true };

/** The refresh instance row (REFRESH_INSTANCE_KEY, item 7). */
interface RefreshInstanceRow {
  /** The most recent instance the cron created (or a step reported) for this resident. */
  instance: {
    id: string;
    createdAt: string;
    /** `<step>: <outcome>` of the step the instance last ran; null before its first. */
    lastStep: string | null;
    /** The cycle lease the instance holds in the in-flight row, from its fetch step to its end. */
    holder: string | null;
  } | null;
  /** The most recent bucket the cron did not create for: a live cycle, or the engine's duplicate-id refusal. */
  skipped: { id: string; at: string; why: string } | null;
}

/** The engine's statuses under which an instance is still a live cycle:
 *  queued, running, paused or waiting. Anything else — `complete`, `errored`,
 *  `terminated`, an id the engine does not know — is not. */
const INSTANCE_LIVE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
]);

/** What every instance step answers besides its own facts: the resident's
 *  wall clock at the step's start and the commands it ran, so the instance
 *  can graft them under its root the way the bot grafts an attach's. */
export interface InstanceStepTrace {
  startedAt: number;
  trace: ResidentStep[];
}
/** A step's own verdict: `done` with its facts; `stopped` by a gate that ends
 *  the cycle with nothing to record (idle, a container restart, an offboard);
 *  `failed` by the repository's own doing, already recorded as `degraded`.
 *  A step killed from outside answers none of these — it throws, and the
 *  engine retries it. */
type InstanceStepResult<T> =
  ({ status: "done" } & T) | { status: "stopped"; why: string } | { status: "failed"; reason: string };
type InstanceStepAnswer<T> = InstanceStepResult<T> & InstanceStepTrace;
/** The fetch step's facts, small by construction: refs, shas, keys, words. */
interface RefreshFetchFacts {
  ref: string;
  sha: string;
  factsSha: string;
  lockfileKey: string;
  action: RefreshPlan["action"];
  /** Whether the install step must run: a rebuild whose lockfile key moved, on a repo with an install command. */
  install: boolean;
  mintError: string | null;
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
/** The schedule callbacks the retired alarm chain armed, gone with the flip to
 *  the Workflow scheduler. Their rows outlive the code that armed them, and the
 *  SDK's `alarm()` skips a due row whose callback method is gone WITHOUT
 *  deleting it, then re-arms for that past time at once — a hot alarm loop
 *  that only the row's deletion ends (@cloudflare/containers 0.3.7,
 *  dist/lib/container.js `alarm()`: the `continue` precedes the DELETE). The
 *  constructor deletes them before the first event, which on an upgraded
 *  resident is that very alarm. Drop this list once every resident has woken on
 *  this code (lifecycle.test.ts pins the names). */
const RETIRED_SCHEDULE_CALLBACKS = ["onRefreshAlarm", "onWorktreeSweep", "onDiskMeasure"] as const;

const STATE_KEY = "resident:state";
const REASON_KEY = "resident:reason";
const RESOURCE_KEY = "resident:resource";
const UPDATED_KEY = "resident:updatedAt";
const FACTS_KEY = "resident:facts";
const SNAPSHOT_KEY = "resident:snapshot";
const DEADLINE_AT_KEY = "resident:provisionDeadlineAt";
/** ISO instants of this resident's auto-rebuilds (item 36): the budget's window
 *  is judged over it; a manual rebuild or an offboard clears it. */
const AUTO_REBUILDS_KEY = "resident:autoRebuilds";
/** The strike counter the watchdog kept before the transition rebuilt (item 36); a serving pass deletes a leftover row. */
const RETIRED_REBUILD_STRIKES_KEY = "resident:rebuildStrikes";
/** Consecutive connects the container's control port did not answer (item 64): the ladder's count. */
const RUNTIME_UNREACHABLE_KEY = "resident:runtimeUnreachable";

/** The row under RUNTIME_UNREACHABLE_KEY: the count and both instants, so the
 *  fleet watch sees how long the runtime has been silent. Cleared by any exec
 *  whose process spawned. */
interface RuntimeUnreachableRow {
  count: number;
  firstAt: string;
  lastAt: string;
}

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

/** A reusing attach (item 66) found no tree it can keep: gone, unreadable, or
 *  built for the other mode. Nothing on disk was touched; the attach answers
 *  409 `needs: "recreate"` and the caller decides what a run without its
 *  workspace does. */
class ReuseRefusedError extends Error {
  constructor(readonly why: string) {
    super(`reuse-refused: ${why}`);
  }
}

/** Thrown after the resident has ALREADY been transitioned to `down` (reason
 *  persisted); signals callers the cycle is over without re-flipping. */
class ResidentDownError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

/** Thrown by a refresh gate that stopped the container on purpose — a stale
 *  image (`reconcileImage`), a disk-full recycle (`recoverFromDiskFull`) — so
 *  the instance step it runs in throws to the engine, whose retry (thirty
 *  seconds on) finds the container back on the current image or an empty
 *  disk, restores it and runs the cycle: the retry is the re-warm that a
 *  short re-arm used to be. Not a failure of the repository's own — never
 *  recorded as `degraded`. */
class CycleRestartError extends Error {
  constructor(public why: "image-stale-restart" | "disk-full-restart") {
    super(`${why}: the container is restarting — the step is retried onto it`);
  }
}

export class ResidentDO extends Sandbox<Env> {
  // TIMER RULE: lifecycle code never arms the Durable Object's own alarm slot
  // — the Container base class owns it (its sleepAfter machinery and the
  // schedule multiplexing live there). The one timer left is provisioning's
  // (`initResident`: the run at +1 s and its fail-closed deadline), through
  // the base class's schedule API, which multiplexes onto that slot safely
  // (checked against @cloudflare/containers 0.3.7: the SDK registers no
  // schedule callback names, so ours cannot collide). Every other cycle is a
  // Workflow instance (refresh.ts) and the watchdog re-arms nothing;
  // lifecycle.test.ts holds the line over these sources.

  constructor(...args: ConstructorParameters<typeof Sandbox<Env>>) {
    super(...args);
    // The base class created `container_schedules` synchronously above; the
    // rows the retired alarm chain armed are gone before this object handles
    // its first event (RETIRED_SCHEDULE_CALLBACKS).
    for (const name of RETIRED_SCHEDULE_CALLBACKS) this.deleteSchedules(name);
  }

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
  // `swapIncarnation()` at its site (memos AND the incarnation id go), every
  // lifecycle transition (`setResidentState`) clears the memos alone — the
  // incarnation survives it — and a sleep cannot race the TTL — the
  // container sleeps only after SLEEP_AFTER (20 min) of idleness, while the
  // hydration memo lives `hydrationMemoTtlMs` (60 s) past the last activity
  // that set it. Storage stays the truth: the memo caches a verdict PROBED from
  // disk, never assumes one.
  private hydratedVerdictAt = 0;
  private readonly hydrationMemoTtlMs = 60_000;
  private gitSetupDone = false;
  private stageDirsReady = new Set<string>();
  private containerIdMemo: string | undefined = undefined;

  /** The incarnation: one isolate paired with one container runtime
   *  (docs/reference/specs/resident-repos.md item 22). Minted when the object
   *  starts and again ONLY when the runtime is replaced under it
   *  (`swapIncarnation`) — every lease this object writes carries it, and a
   *  lease from another incarnation is a holder whose process context is gone.
   *  A lifecycle transition is not a swap: the cycle that flips the state to
   *  `refreshing` holds a lease of this incarnation and must still hold it
   *  afterwards, so `setResidentState` clears the memos and nothing more. */
  private incarnation = mintIncarnationId();
  private leaseSeq = 0;

  /** Item 27: the held /await-restore requests, answered by the lifecycle
   *  transition out of `restoring` (`setResidentState`). In-memory on purpose:
   *  a DO restart drops the held RPCs with the ledger and the bot's own
   *  deadline names the fallback. */
  private restoreWaiters = new RestoreWaiters();

  private nextHolder(): string {
    return `${this.incarnation}:${++this.leaseSeq}`;
  }

  /** The runtime under this object is gone (a replacement seen at the exec
   *  choke point, a deliberate stop/teardown/rebuild, retirement): every lease
   *  this incarnation holds is dead from here on, and so are its memos. */
  private swapIncarnation(): void {
    this.incarnation = mintIncarnationId();
    this.clearIncarnationMemos();
  }

  private clearIncarnationMemos(): void {
    this.hydratedVerdictAt = 0;
    this.gitSetupDone = false;
    this.stageDirsReady.clear();
    this.containerIdMemo = undefined;
    this.depsStoreDirReady = false;
    this.depsInstallSlots = null;
  }

  /** Mirror mutex, in-process half: a DO yields at every await, so two
   *  in-flight requests CAN interleave mid-handler — every mirror mutation
   *  (fetch, worktree add/remove) queues on this promise chain, in arrival
   *  order. The chain is the fast path within one incarnation; the durable
   *  row (MIRROR_MUTEX_KEY) is the truth across incarnations: an isolate swap
   *  drops the chain while the holder's process may keep writing, and the row
   *  is what the next incarnation reads before it touches the tree. */
  private mirrorLockTail: Promise<void> = Promise.resolve();

  /** Run `fn` holding the mirror mutex. With waitTimeoutMs > 0, gives up
   *  waiting after that long (throws MirrorBusyError) — the queued slot is
   *  released so later waiters are not stuck behind a ghost. `lease` names
   *  the step and its budget on the row; a section without a budget of its
   *  own gets the default lease. */
  private async withMirrorLock<T>(
    fn: () => Promise<T>,
    waitTimeoutMs = 0,
    lease: { step: string; budgetMs: number } = { step: "mirror", budgetMs: MIRROR_LEASE_DEFAULT_MS },
  ): Promise<{ value: T; waitedMs: number }> {
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
    // Past the chain, the row: taken when free or when its holder is dead.
    const holder = this.nextHolder();
    try {
      await this.takeMirrorRow(holder, lease, waitTimeoutMs, started);
    } catch (err) {
      release();
      throw err;
    }
    const waitedMs = systemClock() - started;
    this.stepTrace.getStore()?.mutexWait(waitedMs, systemClock());
    try {
      return { value: await fn(), waitedMs };
    } finally {
      try {
        // A failed release must not replace fn's result: the row's expiry is
        // the backstop, and the next taker takes over a dead holder anyway.
        await this.releaseLease(MIRROR_MUTEX_KEY, holder).catch((err: unknown) => {
          console.log(`mirror mutex: release of ${holder} failed (${errMsg(err)}); the lease expires on its own`);
        });
      } finally {
        release();
      }
    }
  }

  /** Write the mirror-mutex row for `holder`, or wait for a live holder of
   *  this incarnation to end. A dead holder — another incarnation, or one past
   *  its budget — is taken over at once (takeMutex); the row only ever names a
   *  live one of THIS incarnation when a release is racing this read, so the
   *  wait is short and bounded by the caller's timeout like the chain wait. */
  private async takeMirrorRow(
    holder: string,
    lease: { step: string; budgetMs: number },
    waitTimeoutMs: number,
    started: number,
  ): Promise<void> {
    for (;;) {
      const row = await this.ctx.storage.get<Lease>(MIRROR_MUTEX_KEY);
      const decision = takeMutex(row, systemClock(), this.incarnation, lease.budgetMs, lease.step, holder);
      if (decision.action === "take") {
        if (decision.dead) {
          console.log(
            `mirror mutex: ${decision.why} — ${lease.step} takes over from ${decision.dead.step} (${decision.dead.holder})`,
          );
        }
        await this.ctx.storage.put(MIRROR_MUTEX_KEY, decision.row);
        return;
      }
      const left = waitTimeoutMs > 0 ? waitTimeoutMs - (systemClock() - started) : Infinity;
      if (left <= 0) throw new MirrorBusyError(`mirror-busy: mutex not acquired within ${waitTimeoutMs}ms`);
      await sleep(Math.min(decision.remainingMs + 1, left, 1_000));
    }
  }

  /** Delete a lease row iff `holder` still owns it (releaseMutex). */
  private async releaseLease(key: string, holder: string): Promise<void> {
    const outcome = releaseMutex(await this.ctx.storage.get<Lease>(key), holder);
    if (outcome.released) await this.ctx.storage.delete(key);
  }

  /** Lease one of the in-flight facts the watchdog reads: one document per
   *  fact (inFlightKey), a plain put, so a hydration's clear can never race a
   *  refresh's record on a shared row. */
  private async recordInFlight(kind: keyof InFlightRow, holder: string, budgetMs: number, step: string): Promise<void> {
    const lease: Lease = { holder, incarnation: this.incarnation, expiresAt: systemClock() + budgetMs, step };
    await this.ctx.storage.put(inFlightKey(kind), lease);
  }

  private async clearInFlight(kind: keyof InFlightRow, holder: string): Promise<void> {
    const lease = await this.ctx.storage.get<Lease>(inFlightKey(kind));
    if (lease?.holder === holder) await this.ctx.storage.delete(inFlightKey(kind));
  }

  /** The two in-flight facts as one row, for liveInFlight and /debug. */
  private async readInFlight(): Promise<InFlightRow> {
    const [refresh, hydration] = await Promise.all([
      this.ctx.storage.get<Lease>(inFlightKey("refresh")),
      this.ctx.storage.get<Lease>(inFlightKey("hydration")),
    ]);
    return inFlightRow(refresh, hydration);
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
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated?: boolean }> {
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
      if (!isRuntimeReplacement(err)) {
        // The control port never answered the SDK's connect (its 30 s abort,
        // raised inside the wake path): no process started and nothing about
        // the repository is known. Count it in storage — the ladder of item 64
        // reads the count — and name it, so no reason ever carries the bare
        // `The operation was aborted`.
        if (isRuntimeUnreachable(err)) {
          throw new RuntimeUnreachableError((await this.noteRuntimeUnreachable()).count, err);
        }
        throw err;
      }
      // Forward-looking gate, structurally unreachable today: in the pinned SDK
      // (@cloudflare/sandbox@0.13.0-next.751.1) every `reason:"runtime_replaced"`
      // site hardcodes `retryable:false`, so a replacement currently always
      // takes the throw below. It exists so that if a future SDK vouches "never
      // started" we retry then — and only then — without a change here.
      if (!(err instanceof OperationInterruptedError && err.retryable === true)) {
        this.swapIncarnation(); // the container this incarnation's memos described is gone
        throw new RuntimeReplacedError("spawn", err);
      }
      console.log(
        `exec: runtime replaced before the process started (SDK says retryable) — retrying once: ${errMsg(err)}`,
      );
      proc = await createExtensionProcessSandbox(this).exec(argv as unknown as SandboxCommand, launch);
    }
    // The spawn is the proof the control port answers: a persisted count of
    // unanswered connects ends here, whatever the command goes on to do.
    await this.clearRuntimeUnreachable();
    try {
      const out = await proc.output({ encoding: "utf8", timeout: timeout + 30_000 });
      // `truncated` is the SDK saying the process log stream was cut past its
      // own retention — the output here is a prefix, whatever our caps say.
      return {
        stdout: out.stdout,
        stderr: out.stderr,
        exitCode: out.exitCode,
        timedOut: out.timedOut,
        truncated: out.truncated,
      };
    } catch (err) {
      if (isRuntimeReplacement(err)) {
        this.swapIncarnation(); // the container this incarnation's memos described is gone
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

  /** Whether the mirror holds `sha` as a commit — reachable from any ref it
   *  carries (a `--mirror` clone fetches `refs/pull/*` too, so a merged PR's
   *  head outlives its deleted branch). `sha` is a validated full sha
   *  (`parseWantSha`) before it reaches this argument. */
  private async commitInMirror(sha: string): Promise<boolean> {
    const r = await this.run(["git", "-C", MIRROR_DIR, "cat-file", "-e", `${sha}^{commit}`]);
    if (r.exitCode === 0) return true;
    // `cat-file -e` exits 1 for an object the repository does not have; any
    // other exit (a corrupt mirror, a killed git) is that step's own failure,
    // never mistaken for "commit absent" and folded into `unknown-ref`.
    if (r.exitCode === 1) return false;
    throw new StepError("cat-file", `git cat-file exited ${r.exitCode}: ${r.stderr.trim() || "(no output)"}`);
  }

  /** Attach's fetch decision (item 51) over the mirror's actual state — why
   *  the mirror is fetched before the tree is cloned, or null: the ref is
   *  missing, `wantSha` names a commit the ref's tip is not at, or the ref is
   *  one the binding could return from (item 16's second movement) and is
   *  verified against the origin before the mirror's word on it is trusted.
   *  The decision itself is the pure, tested `mirrorFetchReason`. */
  private async mirrorFetchReasonFor(
    ref: string,
    wantSha: string | null,
    returnable: boolean,
  ): Promise<FetchReason | null> {
    const refExists = await this.refExists(ref);
    const mirrorSha = refExists && wantSha !== null ? await this.readMirrorSha(ref) : undefined;
    return mirrorFetchReason({ refExists, mirrorSha, wantSha, returnable });
  }

  /** Dependency/build cache key: sha256 over the ls-tree lines (mode,
   *  blob oid, name) of the lockfile candidates AS COMMITTED at `sha` in the
   *  bare mirror. Fully determined by the commit — generated/uncommitted
   *  lockfiles on disk can never shift it. */
  private async lockfileKey(sha: string): Promise<string> {
    const script = `git -C ${MIRROR_DIR} ls-tree ${sha} -- ${LOCKFILE_CANDIDATES.join(" ")} | sha256sum | cut -d" " -f1`;
    return (await this.runOk(["sh", "-c", script], "lockfile-key")).trim();
  }

  /** The sha the disk was last materialized to (READY_MARKER), or null when
   *  either tree or the marker is missing — the restore step's fact. */
  private async readyStamp(): Promise<string | null> {
    const r = await this.run([
      "sh",
      "-c",
      `test -d ${MIRROR_DIR}/objects && test -d ${CHECKOUT_DIR}/.git && cat ${READY_MARKER} 2>/dev/null || echo __absent__`,
    ]);
    const out = r.stdout.trim();
    return r.exitCode === 0 && out !== "" && out !== "__absent__" ? out : null;
  }

  /** True when the disk already holds exactly what the snapshot stamp says. */
  private async diskMatches(sha: string): Promise<boolean> {
    return (await this.readyStamp()) === sha;
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

  // -- engine steps (docs/reference/specs/resident-repos.md item 22) ---------------
  //
  // Each step is one public method a cycle calls: it reads the facts it is
  // about to change and asks the pure plan (residentStepPlan.ts) whether the
  // work is done — done issues no command, so a second call with the same
  // inputs has no effect — then takes its lease, runs its commands under the
  // step's own budget, writes its result and releases. The refresh instance
  // drives them one step at a time (`refreshInstance*`).

  /** Fetch the mirror from origin, once per cycle: the record under
   *  LAST_FETCH_KEY names the cycle, so a repeated call inside the same cycle
   *  answers the sha it already read. */
  async fetchMirror(input: {
    ref: string;
    cycle: string;
    token: string | null;
  }): Promise<{ done: boolean; sha: string }> {
    const last = await this.ctx.storage.get<FetchRecord>(LAST_FETCH_KEY);
    const plan = planFetchMirror({ ref: input.ref, cycle: input.cycle, last });
    if (plan.action === "done") return { done: true, sha: plan.sha };
    // The tip is read under the same lock as the fetch: an attach's own
    // `fetch --prune` between the two could delete the ref and fail the cycle.
    const { value: sha } = await this.withMirrorLock(
      async () => {
        await this.gitWithCred(
          input.token,
          ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
          "fetch",
          GIT_NETWORK_TIMEOUT_MS,
        );
        return this.readMirrorSha(input.ref);
      },
      0,
      { step: "fetch", budgetMs: GIT_NETWORK_TIMEOUT_MS },
    );
    await this.ctx.storage.put(LAST_FETCH_KEY, {
      cycle: input.cycle,
      ref: input.ref,
      sha,
      at: systemClock(),
    } satisfies FetchRecord);
    return { done: false, sha };
  }

  /** The store entry for `key`, complete (item 59 is the primitive under it).
   *  The install's exclusive resource is the key's entry, never the mirror —
   *  installs run in a private scratch tree outside the mirror mutex — so its
   *  lease is per key (depsLeaseKey). A live holder of this incarnation is the
   *  install already running for the key: joined, never duplicated. A dead
   *  holder left its scratch tree behind, possibly with a process still
   *  writing into it: that tree is swept before this attempt starts, the way
   *  every build-user step sweeps the checkout. */
  async installDeps(input: {
    key: string;
    sha: string;
    installCmd: string;
    budgetMs: number;
    seedFromKey?: string;
    restoreDeadlineMs?: number;
  }): Promise<{ done: boolean; entry: string }> {
    const { key } = input;
    const plan = planInstallDeps({ key, entryComplete: await this.depsEntryComplete(key) });
    if (plan.action === "done") {
      await this.run(["touch", depsUsedPath(key)]);
      return { done: true, entry: depsEntryPath(key) };
    }
    const attempt = crypto.randomUUID().slice(0, 8);
    const leaseKey = depsLeaseKey(key);
    const holder = this.nextHolder();
    const leaseMs = Math.max(input.budgetMs, (input.restoreDeadlineMs ?? 0) - systemClock()) + DEPS_STEP_OVERHEAD_MS;
    for (;;) {
      const row = await this.ctx.storage.get<Lease>(leaseKey);
      const decision = takeMutex(
        row,
        systemClock(),
        this.incarnation,
        leaseMs,
        "deps-install",
        holder,
        depsScratchPath(attempt),
      );
      if (decision.action === "wait") {
        const running = this.depsInFlight.get(key);
        if (running) return { done: false, entry: await running };
        // The lease is written before the running install registers itself;
        // a caller landing in between waits for that, briefly.
        await sleep(Math.min(decision.remainingMs + 1, 1_000));
        continue;
      }
      if (decision.dead?.tree) {
        // The dead attempt's scratch tree AND its staging dir: its install ran
        // in the first, its commit script was moving node_modules into the
        // second; a process still writing to either is killed, then both go.
        const deadAttempt = depsAttemptOfScratchPath(decision.dead.tree);
        const deadPaths = deadAttempt ? depsAttemptPaths(key, deadAttempt) : [decision.dead.tree];
        console.log(
          `deps: ${decision.why} — sweeping ${deadPaths.join(" ")} left by ${decision.dead.holder} before installing ${key.slice(0, 8)}`,
        );
        for (const dir of deadPaths) {
          const swept = await this.runOk(killStaleBuildProcessesCommand(BUILD_USER, dir), "deps-install-stale-sweep");
          if (swept.trim()) console.log(`deps: ${swept.trim()}`);
        }
        await this.run(["rm", "-rf", ...deadPaths]).catch(() => {});
      }
      await this.ctx.storage.put(leaseKey, decision.row);
      break;
    }
    try {
      const entry = await this.materializeDeps(key, input.sha, input.installCmd, input.budgetMs, {
        seedFromKey: input.seedFromKey,
        restoreDeadlineMs: input.restoreDeadlineMs,
        attempt,
      });
      return { done: false, entry };
    } finally {
      await this.releaseLease(leaseKey, holder);
    }
  }

  /** Bring the checkout to `sha` and build it, under the mirror mutex. The
   *  disk markers decide (planBuild over the refresh planner): a checkout
   *  whose HEAD, deps and build markers all name the target is done. */
  async runBuild(input: {
    sha: string;
    factsSha: string;
    lockfileKey: string;
    buildCmd: string;
    /** The store entry to link as the checkout's node_modules when the plan installs; null when the command table has no install. */
    depsEntry: string | null;
  }): Promise<{ done: boolean; why: string }> {
    const { sha, lockfileKey } = input;
    const plan = planBuild({ sha, factsSha: input.factsSha, lockfileKey, disk: await this.readRefreshDisk() });
    if (plan.action === "done") return { done: true, why: plan.why };
    // Serialize the CHECKOUT_DIR mutation on the mirror mutex:
    // materializeThreadDeps reads CHECKOUT_DIR via `cp -al` under the same
    // lock, so an attach/op dep-copy can never hardlink a half-rebuilt
    // checkout into a thread tree (torn cache → false ❌ from `repo test`).
    // No wait timeout, exactly like the fetch lock: the background refresh
    // queues behind an in-flight attach instead of flipping to degraded on
    // transient lock contention. Token-free: repo code runs during the build.
    await this.withMirrorLock(
      async () => {
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
        // work happens; a changed key re-links the view to the new entry —
        // which is also what drops deps the new lockfile no longer has.
        await this.buildUserRun(checkoutUpdateCommand(sha, plan.clean), "checkout-update", GIT_NETWORK_TIMEOUT_MS);
        if (plan.install) {
          // The old view (a resumed install's keep-deps clean leaves it in
          // place, item 57) makes way for the new entry's: hardlinks only,
          // the entry's inodes are untouched.
          if (input.depsEntry) {
            await this.runOk(["rm", "-rf", `${CHECKOUT_DIR}/node_modules`], "unlink-deps-view");
            await this.linkDepsView(`${input.depsEntry}/node_modules`, CHECKOUT_DIR, BUILD_USER);
          }
          await this.writeDiskMarkers({ depsKey: lockfileKey });
          await this.runOk(["rm", "-f", INSTALLING_MARKER], "clear-installing-marker");
        }
        await this.buildUserRun(input.buildCmd, "build", REFRESH_BUILD_TIMEOUT_MS);
        await this.writeDiskMarkers({ builtSha: sha });
      },
      0,
      { step: "build", budgetMs: GIT_NETWORK_TIMEOUT_MS + REFRESH_BUILD_TIMEOUT_MS },
    );
    return { done: false, why: plan.why };
  }

  /** Archive the mirror and checkout to R2 under `stamp` and record it, with
   *  compare-and-swap on the record read at the start: a record already at
   *  the stamp is done; a record that moved while the archive was taken was
   *  written by someone else and wins — the fresh objects are dropped and the
   *  step answers `superseded`, never a throw. The recorded facts move to the
   *  stamp in the same write, so a wake never sees a half-updated pair. */
  async snapshot(input: { resource: string; stamp: SnapshotStamp }): Promise<SnapshotStepResult> {
    const { ref, sha, lockfileHash } = input.stamp;
    const readAtStart = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    const plan = planSnapshot({ stamp: input.stamp, current: readAtStart });
    if (plan.action === "done" && readAtStart) return { done: true, record: readAtStart };
    // Under the mirror mutex: nothing may mutate the checkout while it is archived.
    const { value: snap } = await this.withMirrorLock(
      () => this.takeSnapshot(input.resource, ref, sha, lockfileHash),
      0,
      { step: "snapshot", budgetMs: R2_TRANSFER_TIMEOUT_MS },
    );
    const stored = await this.ctx.storage.get<SnapshotRecord | RepoFacts>([SNAPSHOT_KEY, FACTS_KEY]);
    const decision = snapshotCommitDecision({
      readAtStart,
      current: stored.get(SNAPSHOT_KEY) as SnapshotRecord | undefined,
    });
    if (decision.action === "superseded") {
      console.log(
        `snapshot: superseded — a record at ${decision.by?.sha.slice(0, 8) ?? "(none)"} moved under this step`,
      );
      await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]).catch(() => {});
      return { done: false, superseded: true };
    }
    const facts = stored.get(FACTS_KEY) as RepoFacts | undefined;
    await this.ctx.storage.put({
      [SNAPSHOT_KEY]: snap,
      ...(facts
        ? {
            [FACTS_KEY]: {
              ...facts,
              sha,
              lockfileHash,
              lastRefreshAt: new Date(systemClock()).toISOString(),
            } satisfies RepoFacts,
          }
        : {}),
    });
    return { done: false, superseded: false, record: snap, previous: readAtStart };
  }

  /** Bring the disk to the snapshot's stamp: the ready marker naming its sha
   *  is done; otherwise unmount and clean, restore both archives (judged by
   *  their bytes, against the caller's one deadline), verify the restored
   *  mirror against the stamp and hand the checkout to the build user. Runs
   *  inside the hydration lease its caller holds — every mirror-mutex taker
   *  hydrates first, so nothing else touches these trees meanwhile. A stalled
   *  or capped restore leaves the resident `down` with the reason and the
   *  container stopped, as the wake path always did; a restore the runtime
   *  replacement interrupts (a deploy rolled the container under it) is
   *  `restore-interrupted`, degraded and rethrown for the instance step that
   *  called it to retry — nothing is streaming into a disk that no longer
   *  exists (restoreFailureDisposition). */
  async restoreCheckout(snap: SnapshotRecord, deadlineMs: number): Promise<{ done: boolean }> {
    const plan = planRestore({ sha: snap.sha, readyStamp: await this.readyStamp() });
    if (plan.action === "done") return { done: true };
    // A restore a previous attempt gave up on may still be writing into these
    // directories (the SDK call cannot be cancelled): wait for it to
    // settle before the clean, bounded by the same cap the restores get. A
    // restore that will not settle even then leaves the disk alone — a named
    // `down`, not a clean racing a writer.
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
        this.swapIncarnation(); // deliberate incarnation swap
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
      // The typed and cause-chain check first: the SDK's replacement errors
      // (a stale process handle, an inactive runtime identity, an interrupted
      // operation) carry the wording one cause down or not at all. An extract
      // the container roll SIGTERMed is different: its exec comes back a
      // normal `exit 143` result and the SDK's wording only reaches the execs
      // that follow — so the disposition also reads the kill signature, and
      // asks the runtime whether the container the extract wrote to is still
      // there (the incident that named this: a resident went `down` on exactly
      // this, 10 ms before every exec answered "container is not running").
      const runtimeReplaced = isRuntimeReplacement(err);
      const runtimeActive = runtimeReplaced ? false : await this.isRuntimeActive().catch(() => null);
      const disposition = restoreFailureDisposition(errMsg(err), {
        runtimeReplaced,
        runtimeActive: runtimeActive ?? undefined,
      });
      if (disposition.action === "interrupted") {
        // The runtime was replaced under the restore (a resident Worker deploy
        // rolled the container): the disk the stream wrote to is gone with the
        // container, so nothing can land on a rebuild and there is nothing to
        // stop. Not evidence about the repo — the resident is `degraded` with
        // the restore named, never `down`, and the error goes back to the
        // instance step, whose classifier reads the same wording as an
        // interruption and throws to the engine; the retry restores again onto
        // the new container. Before this branch every such restore ended `down`, and
        // only a rebuild (the watchdog's, after three passes) brought the
        // resident back.
        this.swapIncarnation(); // the container this incarnation's memos described is gone
        console.log(`restore: interrupted by a runtime replacement — ${disposition.reason.slice(0, 400)}`);
        await this.recordRefreshError(disposition.reason);
        await this.setResidentState("degraded", disposition.reason);
        // The reason travels on the error: the instance step's classifier
        // reads `restore-interrupted:` as an interruption whether the verdict
        // came from the SDK's wording, the kill signature or the probe.
        throw new StepError(err instanceof StepError ? err.step : "restore", disposition.reason);
      }
      // A stalled or capped restore is STILL STREAMING (the SDK call cannot be
      // cancelled); `pendingRestores` keeps the next hydrate off its directory,
      // but a `down` resident's only exit is a REBUILD, and provisioning owns
      // the same directories. Left running, the restore the wake path gave up
      // on lands into the checkout the rebuild has just cloned and linked —
      // tar overwrites in place through the deps store's hardlinks, resetting
      // every hardened entry file from 444 to 644. Stop
      // the container on the way down: the disk is ephemeral, the stream dies
      // with it, and the rebuild starts on an empty one.
      this.swapIncarnation(); // deliberate incarnation swap
      await this.stop().catch((stopErr) => console.log(`restore: stop failed: ${errMsg(stopErr)}`));
      throw await this.goDown(disposition.reason);
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
    return { done: false };
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

  /** Persist `down` with a reason and hand back the error that tells callers
   *  the transition already happened (a down resident gets no refresh
   *  instance: the cron's decision reads the state). */
  private async goDown(reason: string): Promise<ResidentDownError> {
    await this.setResidentState("down", reason);
    // Item 36: the transition is the trigger — a rehydration down is rebuilt
    // now (the rebuild arms provisioning's own schedule and returns), not
    // after three watchdog passes. The error still says `down`: the caller's
    // step ends the way it always did, and the rebuild's provisioning owns the
    // disk from its callback on. A failure inside the judgement is logged, not
    // thrown: the caller's contract is the ResidentDownError, and the state is
    // already `down`, where the watchdog's backstop pass finds it.
    await this.autoRebuildFromDown(reason, "transition").catch((err) =>
      console.log(`auto-rebuild (transition): failed — ${errMsg(err)}; the watchdog's pass is the backstop`),
    );
    return new ResidentDownError(reason);
  }

  /** Item 36: judge a `down` for the automatic rebuild and act. `rebuilt` when
   *  the rebuild started (state is `onboarding` now); `budget-spent` when the
   *  resident stays down with the budget stamped on its reason; `none` for a
   *  reason a rebuild cannot help, one already stamped, or a registry record
   *  missing (an offboard mid-flight — the watchdog's pass is the backstop).
   *  Both callers — the transition and the watchdog — read and write the one
   *  history row, so they cannot disagree about the budget. */
  private async autoRebuildFromDown(
    reason: string,
    where: "transition" | "watchdog",
  ): Promise<"rebuilt" | "budget-spent" | "none"> {
    if (!isAutoRebuildEligible(reason)) return "none";
    const history = (await this.ctx.storage.get<string[]>(AUTO_REBUILDS_KEY)) ?? [];
    const decision = autoRebuildDecision({ reason, history, now: systemClock() });
    if (decision.action === "not-eligible") return "none";
    if (decision.action === "budget-spent") {
      console.log(`auto-rebuild (${where}): ${decision.reason.slice(0, 400)}`);
      await this.ctx.storage.put(AUTO_REBUILDS_KEY, decision.history);
      await this.setResidentState("down", decision.reason);
      return "budget-spent";
    }
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    const record = await this.registry()
      .getRecord(resource)
      .catch(() => null);
    if (!record) {
      console.log(`auto-rebuild (${where}): no registry record for the resident — left down (${reason.slice(0, 200)})`);
      return "none";
    }
    console.log(`auto-rebuild (${where}): ${decision.reason.slice(0, 400)}`);
    const result = await this.rebuild(resource, record.defaultRef, record.provisioningTimeoutMs, false, {
      auto: true,
    });
    if ("error" in result) {
      console.log(`auto-rebuild (${where}): rebuild refused — ${result.error}`);
      return "none";
    }
    // The instant is recorded once the rebuild has started: a refused rebuild
    // spends no budget.
    await this.ctx.storage.put(AUTO_REBUILDS_KEY, decision.history);
    return "rebuilt";
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
    await this.ctx.storage.delete([FACTS_KEY, SNAPSHOT_KEY, RETIRED_SNAPSHOT_KEY]); // defensive: no stale facts from a past life
    try {
      this.deleteSchedules(PROVISIONING_CALLBACK);
      this.deleteSchedules(PROVISION_RUN_CALLBACK);
      await this.schedule(Math.max(1, Math.ceil(provisioningTimeoutMs / 1000)), PROVISIONING_CALLBACK, resource);
      await this.schedule(1, PROVISION_RUN_CALLBACK, resource);
    } catch (err) {
      // Nothing armed, so nothing may say `onboarding`: the row goes back to
      // what it was, the way the onboard route frees the registry slot. An
      // `onboarding` with no schedule behind it used to sit until the
      // watchdog's provision-timeout (seen live after an offboard in the same
      // isolate).
      await this.ctx.storage.delete([RESOURCE_KEY, STATE_KEY, REASON_KEY, UPDATED_KEY, DEADLINE_AT_KEY]);
      throw err;
    }
    return { state: "onboarding", reason: "" };
  }

  /** The provisioning engine (schedule-driven): clone bare mirror → resolve the
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
        const { entry } = await this.installDeps({
          key: lockfileHash,
          sha,
          installCmd: record.commands.install,
          budgetMs: Math.max(stepBudget, REFRESH_INSTALL_TIMEOUT_MS),
        });
        await this.linkDepsView(`${entry}/node_modules`, CHECKOUT_DIR, BUILD_USER);
      }
      await this.buildUserRun(record.commands.build, "build", stepBudget);

      // Provisioning is the only writer while `onboarding`, so the step cannot
      // be superseded; a record already at the stamp (a re-fired schedule) is
      // reused.
      const snapped = await this.snapshot({ resource, stamp: { ref, sha, lockfileHash } });
      if (!snapped.done && snapped.superseded) throw new StepError("snapshot", "superseded by a concurrent writer");
      const snap = snapped.record;

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
      // The first refresh instance is the cron's: the row now reads `warm`
      // with no instance recorded, so the next firing creates it (item 9).
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
   *  stamps → down(snapshot-stamp-mismatch); a stalled or capped restore →
   *  down(r2-restore-failed); a restore the runtime replacement interrupts →
   *  degraded(restore-interrupted), rethrown so the instance step that called
   *  it is retried by the engine. Throws ResidentDownError after the down
   *  transitions. Called by the refresh instance's fetch step (and the attach
   *  path). */
  async ensureHydrated(): Promise<void> {
    // Fresh positive verdict for this incarnation → nothing to probe. See the
    // per-incarnation memo block for why this is safe; the refresh cycle's
    // 10-min cadence always outlives the TTL, so a cycle re-probes for real.
    if (this.hydratedVerdictAt !== 0 && systemClock() - this.hydratedVerdictAt < this.hydrationMemoTtlMs) return;
    if (this.hydration) return this.hydration;
    // The hydration's lease in the in-flight row (item 22) is what the
    // watchdog reads: alive for this incarnation until the stale bound, gone
    // with the isolate that started it.
    const holder = this.nextHolder();
    const p = this.recordInFlight("hydration", holder, STALE_MIDFLIGHT_MS, "restore")
      .then(() => this.doHydrate())
      .then(() => {
        this.hydratedVerdictAt = systemClock();
      })
      .finally(async () => {
        if (this.hydration === p) this.hydration = null;
        await this.clearInFlight("hydration", holder);
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
    const t0 = systemClock();
    // One deadline for the whole hydrate: the restore step's wait for earlier
    // restores, both restores and the deps materialization below judge
    // against it, so the worst-case `restoring` span is RESTORE_MAX_MS, under
    // the watchdog's stale-mid-flight window — not three caps in a row.
    const deadlineMs = systemClock() + RESTORE_MAX_MS;
    if ((await this.restoreCheckout(snap, deadlineMs)).done) {
      // Raced a container start that already had the right disk.
      await this.setResidentState("warm");
      return;
    }
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
      } else {
        const plan = planMaterializeDeps({
          key: snap.lockfileHash,
          viewPresent: hasView,
          entryComplete: await this.depsEntryComplete(snap.lockfileHash),
        });
        if (plan.action === "done") {
          depsLinked = true;
        } else {
          console.log(`deps: ${plan.why}`);
          const budget = planWakeDepsBudget({
            nowMs: systemClock(),
            deadlineMs,
            installBudgetMs: REFRESH_INSTALL_TIMEOUT_MS,
          });
          if (budget.action === "skip") throw new Error(`${budget.remainingMs} ms left of the hydrate deadline`);
          const { entry } = await this.installDeps({
            key: snap.lockfileHash,
            sha: snap.sha,
            installCmd: record.commands.install,
            budgetMs: budget.installBudgetMs,
            restoreDeadlineMs: deadlineMs,
          });
          await this.linkDepsView(`${entry}/node_modules`, CHECKOUT_DIR, BUILD_USER);
          depsLinked = true;
        }
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

  // -- freshness (the refresh cycle's phases, one per instance step) -----------
  //
  // The cycle runs as the Workflow instance in refresh.ts: the gates, the
  // fetch, the plan, the install, the build, the snapshot, the completion,
  // then the housekeeping steps. Each phase is one method here; the instance
  // calls them one step at a time (`refreshInstance*`, below).

  /** The cycle's entry gates, in order: hydrate; the registry record (gone →
   *  the resident was offboarded mid-flight, nothing to do); the image
   *  reconcile (a stale image stops the container, which restarts on the
   *  current one — thrown as `CycleRestartError` so the engine retries the
   *  step onto it); the disk-full re-probe (a disk still full decides its own
   *  recovery — a recycle is thrown the same way, a kept container stops the
   *  cycle — item 54); the park streak and the idle gate (`idle`); and, for a
   *  cycle that runs, the end of idle mode. */
  private async refreshGate(
    resource: string,
  ): Promise<{ go: false; why: string } | { go: true; record: ResidentRecord; facts: RepoFacts }> {
    await this.ensureHydrated();
    const record = await this.registry().getRecord(resource);
    if (!record) return { go: false, why: "offboarded" }; // offboarded mid-flight: the cycle ends quietly
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!facts) throw new StepError("facts", "no repo facts recorded despite hydration");

    // Deploy-ordering hazard: `wrangler deploy` swaps the app's image but a
    // RUNNING container keeps the old one, so new Worker code can name pool
    // users the image lacks. Reconcile here (every cycle, cheap) — see
    // reconcileImage — so a rollout self-applies within one refresh.
    if (await this.reconcileImage("refresh")) {
      // Container stopping; it restarts on the new image in seconds. The
      // engine's retry re-enters this step thirty seconds on and re-warms the
      // resident within the minute, instead of the next bucket.
      throw new CycleRestartError("image-stale-restart");
    }

    // Idle sleep: no live binding used within IDLE_AFTER_S and nothing in
    // flight → skip this fetch; the cron holds the next instance to the idle
    // cadence, so SLEEP_AFTER can elapse. Staleness is repaid at the next
    // attach (refreshIfStale). What a live tree holds is not asked (item 17):
    // sleep destroys the disk, and a tree no run is using protects nothing.
    // Only a SETTLED resident may park: a cycle that finds `refreshing`/
    // `restoring` at entry is looking at a marker left by a cycle that died
    // mid-flight (a deploy evicting the DO: stuck `refreshing` + parked →
    // every run falls back cold because the bot's warm-gate probe never
    // sees `warm` again). Run the full cycle instead; it
    // ends warm or degraded, and the next one may park.
    // Decide off a FRESH state read — the caller's read predates several awaits
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
        // A recycle: the engine's retry re-enters this step, restores onto the
        // empty disk and runs the cycle. A kept container: nothing a fetch can
        // do until space is freed; the cycle ends and the next bucket re-probes.
        if (await this.recoverFromDiskFull(entry.reason, 0)) throw new CycleRestartError("disk-full-restart");
        return { go: false, why: "disk-full" };
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
      // Warm, or a degraded stamped by the WATCHDOG (stale-mid-flight) or by
      // an interrupted restore (restore-interrupted — a deploy rolled the
      // container; it says nothing about the repo): both mean a cycle must
      // RUN — this one.
      // Counting those toward the streak would be self-fulfilling —
      // each cycle that found the reason would park without attempting anything,
      // and after three the resident would sit parked-degraded for 6h at a
      // time. Never settled; streak reset.
      await this.ctx.storage.delete(DEGRADED_STREAK_KEY);
    }
    if (settled && (await this.isIdle())) {
      // isIdle awaited (the bindings listing) — re-read before writing.
      const now = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
      if (!now.idleSince)
        await this.ctx.storage.put(FACTS_KEY, {
          ...now,
          idleSince: new Date(systemClock()).toISOString(),
        } satisfies RepoFacts);
      return { go: false, why: "idle" }; // the cron creates the next instance at IDLE_REFRESH_INTERVAL_S
    }
    if (facts.idleSince) {
      const now = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
      const { idleSince: _woke, ...awake } = now;
      await this.ctx.storage.put(FACTS_KEY, awake satisfies RepoFacts);
    }
    return { go: true, record, facts };
  }

  /** The cycle's fetch phase: mint, `refreshing`, fetch, the lockfile key at
   *  the new tip. Token-mint failure is a command-level error — the resident
   *  keeps serving the last snapshot and lifecycle state is NOT flipped by
   *  it. It is recorded, and the cycle then CONTINUES with an anonymous
   *  fetch (exactly what an unconfigured App does): a public repo outside
   *  the installation stays fresh, and a private one fails at the fetch
   *  below into a visible `degraded(github-unreachable: …)`. Returning early
   *  instead would freeze whatever state the resident was in — a public
   *  repo the App is not installed on would sit `degraded` forever with an
   *  ever-staler mirror, because the App cannot mint for a repo it is not
   *  installed on. A failed fetch
   *  is recorded here — `degraded` with its reason, the disk-full recovery
   *  when that is the cause — and answered `ok: false`. */
  private async refreshFetch(
    resource: string,
    facts: RepoFacts,
    cycle: string,
    selfInFlight: number,
  ): Promise<
    | { ok: false; reason: string }
    | { ok: true; sha: string; lockfileHash: string; mintError: string | undefined; token: string | null }
  > {
    let token: string | null = null;
    // This cycle's mint error, kept so it survives the warm facts write
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
    let sha: string;
    try {
      // Same mirror mutex as attach's fetch/worktree work: the
      // refresh cycle and an in-flight attach serialize instead of racing
      // a prune against a worktree clone.
      sha = (await this.fetchMirror({ ref: facts.defaultRef, cycle, token })).sha;
    } catch (err) {
      // The fetch itself failed — or the tip could not be read afterwards,
      // which is the mirror's own failure, not GitHub's: the cycle's
      // classifier names that step.
      if (err instanceof StepError && err.step === "rev-parse") throw err;
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
        await this.recoverFromDiskFull(failure.reason, selfInFlight);
        return { ok: false, reason: failure.reason };
      }
      const reason = `github-unreachable: ${message}`;
      await this.setResidentState("degraded", reason);
      return { ok: false, reason };
    }

    // Pure function of the commit — computed from the mirror before
    // any checkout work so the planner can compare it to the deps marker.
    const lockfileHash = sha === facts.sha ? facts.lockfileHash : await this.lockfileKey(sha);
    return { ok: true, sha, lockfileHash, mintError, token };
  }

  /** A rebuild's first command: the markers for the steps about to be redone
   *  come off — `built` always, `deps-key` only when the install runs — so
   *  an interruption mid-step can never read as completion (item 48). */
  private async refreshClearMarkers(install: boolean): Promise<void> {
    await this.runOk(["rm", "-f", BUILT_MARKER, ...(install ? [DEPS_MARKER] : [])], "clear-markers");
  }

  /** The cycle's install phase: the store entry for the new lockfile key,
   *  bracketed by the installing marker (item 57) — written before, removed
   *  by the build once the deps key lands, so a cycle that ends in between is
   *  planned as a resume. The install is seeded from the key the checkout
   *  holds now — npm reconciles the delta; a resumed install finds its key
   *  already in the store when the last attempt completed, or reconciles
   *  from the warm key again when it did not. Null when the command table
   *  has no install: the build then links nothing. */
  private async refreshInstall(
    record: ResidentRecord,
    facts: RepoFacts,
    sha: string,
    lockfileHash: string,
  ): Promise<string | null> {
    if (!record.commands.install) return null;
    await this.writeDiskMarkers({ installingKey: lockfileHash });
    const { entry } = await this.installDeps({
      key: lockfileHash,
      sha,
      installCmd: record.commands.install,
      budgetMs: REFRESH_INSTALL_TIMEOUT_MS,
      seedFromKey: facts.lockfileHash,
    });
    return entry;
  }

  /** The cycle's snapshot phase: the stamped pair to R2 and, when this cycle's
   *  record stands (not superseded by another writer's), the ready marker and
   *  the rotation — the replaced pair retired, the pair retired before it
   *  swept (docs/reference/specs/resident-repos.md item 7: two generations, so a
   *  handle a seeded restore read from `/status` still resolves for a cycle).
   *  Answers whether the record committed. */
  private async refreshSnapshot(resource: string, stamp: SnapshotStamp): Promise<boolean> {
    const snapped = await this.snapshot({ resource, stamp });
    const committed = snapped.done || !snapped.superseded;
    if (committed) {
      await this.writeDiskMarkers({ ready: stamp.sha });
      const replaced = !snapped.done && !snapped.superseded ? snapped.previous : undefined;
      if (replaced) await this.retireSnapshot(replaced);
    }
    return committed;
  }

  /** The rotation's bookkeeping: the retired generation recorded (the storage
   *  write first, so a deletion that fails leaves the record true and the
   *  1-year R2 TTL as the backstop), then the objects the rotation frees. */
  private async retireSnapshot(replaced: SnapshotRecord): Promise<void> {
    const rotation = rotateSnapshots({ replaced, retired: await this.retiredSnapshot() });
    if (rotation.retired) await this.ctx.storage.put(RETIRED_SNAPSHOT_KEY, rotation.retired);
    if (rotation.deleteIds.length > 0) await this.deleteBackupObjects(rotation.deleteIds).catch(() => {});
  }

  private retiredSnapshot(): Promise<SnapshotRecord | undefined> {
    return this.ctx.storage.get<SnapshotRecord>(RETIRED_SNAPSHOT_KEY);
  }

  /** The backup ids of every recorded generation — the current pair and the
   *  retired one — for the paths that delete or itemize them all. */
  private async recordedBackupIds(current: SnapshotRecord | undefined): Promise<string[]> {
    return backupIdsOf([current, await this.retiredSnapshot()]);
  }

  /** The cycle's completion: the facts to the stamp (the snapshot step moved
   *  them in the same write as the record — a wake never sees a half-updated
   *  pair; this is the cycle's own bookkeeping on a fresh read, and a
   *  superseded snapshot leaves the other writer's stamp alone), `warm`, then
   *  the finished-ref reclamation the prune already informed (item 45) —
   *  housekeeping, never a lifecycle flip. The disk sample is the instance's
   *  own `measure` step (item 55), after its sweep. */
  private async refreshComplete(
    resource: string,
    facts: RepoFacts,
    cycle: {
      sha: string;
      lockfileHash: string;
      committed: boolean;
      mintError: string | undefined;
      token: string | null;
    },
  ): Promise<void> {
    const fresh = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
    const updatedFacts: RepoFacts = {
      ...fresh,
      ...(cycle.committed
        ? { sha: cycle.sha, lockfileHash: cycle.lockfileHash, lastRefreshAt: new Date(systemClock()).toISOString() }
        : {}),
    };
    // Clear a PRIOR cycle's error; keep THIS cycle's mint error visible.
    delete updatedFacts.lastRefreshError;
    if (cycle.mintError) updatedFacts.lastRefreshError = cycle.mintError;
    // A wake cycle cleared idleSince at the gate; `facts` was read at entry and
    // still carries it — never resurrect it here (the dash would show a stale
    // "idle since" and every attach would take the wake-fetch path).
    delete updatedFacts.idleSince;
    await this.ctx.storage.put(FACTS_KEY, updatedFacts);
    await this.setResidentState("warm");
    // Event-triggered reclamation: the prune above already told the
    // mirror which branches died; finished refs give their worktree and
    // pool user back now, not at the idle TTL. Housekeeping, never a
    // lifecycle flip — a failure here is a log line.
    try {
      const gc = await this.reclaimFinishedRefs(resource, facts.defaultRef, cycle.token);
      if (gc.reclaimed.length > 0) console.log(`reclaim ${resource}: ${JSON.stringify(gc)}`);
    } catch (err) {
      console.log(`reclaim ${resource}: pass failed: ${errMsg(err)}`);
    }
  }

  /** What a cycle's throw means. A step killed from OUTSIDE (the container
   *  replaced under it — an image-changing deploy or a container stop; a
   *  Worker-only deploy leaves the container running and interrupts nothing)
   *  is `refresh-interrupted`: not evidence about the repo, so it is never
   *  recorded as `degraded` — the instance step throws it to the engine, whose
   *  retry re-enters the same idempotent method (an unclassified kill would
   *  instead cost the resident a `degraded(build-failed: exit 143 …)` until
   *  the next cycle). Any other failure is the repo's own: `<step>-failed: …`
   *  / `refresh-failed: …`. Non-StepErrors classify too — an SDK replacement
   *  error can surface between steps — with the generic "refresh" step, whose
   *  failure reason is the `refresh-failed: …` shape. A full disk is a third
   *  class: `disk-full: …`, never serviceable, and the one failure the
   *  resident can act on itself (recoverFromDiskFull). */
  private async classifyCycleError(err: unknown): Promise<RefreshFailure> {
    // The control port never answered (item 64): the count decides, and a disk
    // probe would only cost another 30 s abort against the same silent port.
    if (err instanceof RuntimeUnreachableError) {
      return classifyRefreshFailure({
        step: "refresh",
        message: err.message,
        runtimeUnreachable: { count: err.count },
      });
    }
    return err instanceof StepError
      ? await this.classifyFailure(err.step, err.message)
      : await this.classifyFailure("refresh", errMsg(err));
  }

  /** Record a cycle's failure the one way: the classified reason in the log
   *  (a StepError logged its own output block, but a failure between steps —
   *  an SDK error, the markers, the snapshot — reached only the state entry,
   *  which the next cycle's failure overwrites), on the facts (the degraded
   *  state write can be clobbered within seconds by a concurrent attach/exec
   *  whose ensureHydrated flips the state to `restoring · rehydrating`;
   *  `lastRefreshError` survives that race and the next completed cycle
   *  clears it, same as a mint error), then `degraded` with the last snapshot
   *  still serving, and the disk-full recovery when that is the cause. */
  private async refreshFailed(failure: RefreshFailure, selfInFlight: number): Promise<void> {
    console.log(`refresh: cycle failed — ${failure.reason.slice(0, 400)}`);
    await this.recordRefreshError(failure.reason);
    await this.setResidentState("degraded", failure.reason); // last snapshot keeps serving
    if (failure.diskFull) await this.recoverFromDiskFull(failure.reason, selfInFlight);
  }

  // -- the runtime that never answers (docs/reference/specs/resident-repos.md item 64) ------
  //
  // Every `sandbox.exec` of the incident this section names rejected after
  // exactly 30 s with the SDK's connect abort: the WebSocket upgrade to the
  // container's control port was never answered, for forty minutes, while the
  // refresh instance recorded `degraded(refresh-failed: The operation was
  // aborted)` every bucket and nothing escalated — an admin `stop-container`
  // (a SIGTERM the runtime ignored) did not help either. The recovery is a
  // ladder over a persisted count of consecutive unanswered connects: re-arm,
  // stop, destroy and restore from the snapshot, then down with a reason the
  // watchdog's auto-rebuild strikes apply to. The count lives in storage
  // because the isolate does not: a Worker deploy or an eviction between
  // attempts would otherwise restart the ladder at one.

  /** The persisted count of consecutive connects the control port did not
   *  answer, or null while it answers. */
  private async runtimeUnreachableRow(): Promise<RuntimeUnreachableRow | null> {
    return (await this.ctx.storage.get<RuntimeUnreachableRow>(RUNTIME_UNREACHABLE_KEY)) ?? null;
  }

  /** One more unanswered connect: the count up by one, `firstAt` kept, `lastAt`
   *  now — and one log line naming the attempt (the SDK's own line is the bare
   *  AbortError with a stack). */
  private async noteRuntimeUnreachable(): Promise<RuntimeUnreachableRow> {
    const prev = await this.runtimeUnreachableRow();
    const now = new Date(systemClock()).toISOString();
    const row: RuntimeUnreachableRow = { count: (prev?.count ?? 0) + 1, firstAt: prev?.firstAt ?? now, lastAt: now };
    await this.ctx.storage.put(RUNTIME_UNREACHABLE_KEY, row);
    this.runtimeUnreachableSeen = true;
    console.log(
      `runtime-unreachable: the control port did not answer within ${SDK_CONNECT_TIMEOUT_MS / 1000} s — attempt ${row.count} of ${RUNTIME_UNREACHABLE_DOWN_AT} (first at ${row.firstAt})`,
    );
    return row;
  }

  /** Whether a row may exist, so the hot path pays one storage read per
   *  isolate and a delete only for a row that is there. Storage stays the
   *  truth; this only says whether it is worth asking. */
  private runtimeUnreachableSeen: boolean | undefined;

  /** A spawned process is the proof the control port answers: the row goes,
   *  and the log says the silence ended. */
  private async clearRuntimeUnreachable(): Promise<void> {
    if (this.runtimeUnreachableSeen === undefined) {
      this.runtimeUnreachableSeen = (await this.runtimeUnreachableRow()) !== null;
    }
    if (!this.runtimeUnreachableSeen) return;
    const row = await this.runtimeUnreachableRow();
    await this.ctx.storage.delete(RUNTIME_UNREACHABLE_KEY);
    this.runtimeUnreachableSeen = false;
    if (row) {
      console.log(
        `runtime-unreachable: cleared — the control port answered again after ${row.count} unanswered attempt(s) since ${row.firstAt}`,
      );
    }
  }

  /** The ladder (`runtimeUnreachableRung`) over the count `run()` persisted,
   *  applied where a refresh step's exec found the port silent. Every rung
   *  records its reason (`lastRefreshError` and the state) and logs one line
   *  naming the rung and the count; the first three then throw the step back
   *  to the engine, whose retry re-enters the same idempotent method thirty
   *  seconds on, doubling — within one instance's six attempts the ladder runs
   *  from the first unanswered connect to `down`, and a count that outlives the
   *  instance carries into the next bucket's. The state is `degraded` under
   *  every rung but the last: a `restoring` marker with no restore running
   *  would hold the cron's instance creation off until the stale bound, so the
   *  retry's wake path flips `restoring` itself when it starts the restore. */
  private async escalateRuntimeUnreachable(
    instance: string,
    step: string,
    err: RuntimeUnreachableError,
  ): Promise<{ status: "failed"; reason: string }> {
    const rung = runtimeUnreachableRung(err.count);
    const reason = runtimeUnreachableReason(err.count, rung);
    console.log(
      `refresh instance ${instance}: ${step} runtime-unreachable — rung ${rung} at attempt ${err.count} of ${RUNTIME_UNREACHABLE_DOWN_AT}`,
    );
    await this.recordRefreshError(reason);
    switch (rung) {
      case "re-arm":
        await this.setResidentState("degraded", reason);
        throw err;
      case "stop":
        // SIGTERM (`stop()` signals and returns; it cannot kill), the
        // incarnation swapped: a runtime that still honours signals restarts
        // under the retry's exec on a fresh disk, and the wake path restores.
        this.swapIncarnation(); // deliberate incarnation swap
        await this.stop().catch((stopErr) => console.log(`runtime-unreachable: stop failed: ${errMsg(stopErr)}`));
        await this.setResidentState("degraded", reason);
        throw err;
      case "recreate":
        await this.recreateContainer(reason);
        throw err;
      case "down":
        // A fresh VM did not answer either. Down with a rebuild-eligible reason
        // (REHYDRATION_FAILURE_RE) — goDown rebuilds on the transition, item 36 —
        // and the VM destroyed, so the rebuild's provisioning starts on a new one.
        this.swapIncarnation(); // deliberate incarnation swap
        await this.destroy().catch((destroyErr) =>
          console.log(`runtime-unreachable: destroy failed: ${errMsg(destroyErr)}`),
        );
        await this.clearInstanceLease(instance);
        return { status: "failed", reason: (await this.goDown(reason)).reason };
    }
  }

  /** Destroy the VM and keep everything else: the snapshots, the entry
   *  backups, the registry record, the bindings. `destroy()` is the SDK's
   *  SIGKILL of the whole container (`ctx.container.destroy()`), where `stop()`
   *  is a SIGTERM the runtime may ignore — a control server that no longer
   *  answers its port may not answer signals either, which is what the
   *  incident's admin `stop-container` showed. The disk goes with the VM; the
   *  next exec's wake path finds no runtime, flips `restoring` and restores
   *  mirror, checkout and deps from R2 — the cheap recovery (minutes), where a
   *  rebuild (destroy plus reprovision from the code host) is the expensive
   *  one. The state stays `degraded` with the reason naming the pending
   *  restore, for the reason `escalateRuntimeUnreachable` gives. */
  private async recreateContainer(reason: string): Promise<void> {
    console.log(
      `runtime-unreachable: destroying the container — snapshots kept; the next exec restores from R2 (${reason.slice(0, 200)})`,
    );
    this.swapIncarnation(); // deliberate incarnation swap
    await this.forgetRuntimeIdentity();
    await this.destroy().catch((err) => console.log(`runtime-unreachable: destroy failed: ${errMsg(err)}`));
    await this.setResidentState("degraded", reason);
  }

  /** Forget the SDK's stored runtime identity (`SDK_RUNTIME_RECORD_KEY`)
   *  before a destroy. The SDK's own `stop()` and `destroy()` delete it
   *  (`invalidate`) — this is the guard for the path where they do not get
   *  that far, and it makes the destroy prompt: with no identity stored the
   *  SDK skips the runtime cleanup it would otherwise attempt against the
   *  silent port. Never a recovery on its own: the incident's `stop-container`
   *  had already deleted the record and the next connect aborted the same way. */
  private async forgetRuntimeIdentity(): Promise<void> {
    await this.ctx.storage.delete(SDK_RUNTIME_RECORD_KEY);
  }

  // -- the refresh cycle as a Workflow instance (item 7) --------------------------
  //
  // `ResidentRefresh` (the Workflow entrypoint, refresh.ts) calls these
  // methods, one per step, through the DO stub. Each runs one phase of the
  // cycle over the resident's rows, so a step the engine retries re-enters
  // the same idempotent read-then-act method (item 22) and finds the work
  // done. Inputs and answers are small facts — refs, shas, keys, a path, a
  // word — never a payload and never a credential: the token is minted inside
  // the step that needs it.

  /** The lifecycle row (LIFECYCLE_KEY): `workflow`, whatever a flagged rollout stored. */
  async getLifecycle(): Promise<ResidentLifecycle> {
    return lifecycleOf(await this.ctx.storage.get(LIFECYCLE_KEY));
  }

  /** Rewrite the lifecycle row (admin `/debug` `lifecycle`). `workflow` is
   *  the one mode, so the op's only effect is to replace a stale `alarm`
   *  value the flagged rollout left behind — the row then says what
   *  `lifecycleOf` already reads. */
  async setLifecycle(mode: ResidentLifecycle): Promise<{ lifecycle: ResidentLifecycle }> {
    await this.ctx.storage.put(LIFECYCLE_KEY, mode);
    return { lifecycle: mode };
  }

  private async instanceRow(): Promise<RefreshInstanceRow> {
    return (await this.ctx.storage.get<RefreshInstanceRow>(REFRESH_INSTANCE_KEY)) ?? { instance: null, skipped: null };
  }

  /** The facts the cron's instance-creation decision and the admin
   *  `refresh-now` op read (`shouldCreateRefreshInstance`,
   *  `refreshCycleBlocked`): the state and when it last changed, idle mode,
   *  the last instance's creation time and whether the engine still runs it. */
  async refreshRow(): Promise<RefreshRow> {
    const map = await this.ctx.storage.get<unknown>([STATE_KEY, UPDATED_KEY, FACTS_KEY, REFRESH_INSTANCE_KEY]);
    const facts = map.get(FACTS_KEY) as RepoFacts | undefined;
    const row = (map.get(REFRESH_INSTANCE_KEY) as RefreshInstanceRow | undefined) ?? { instance: null, skipped: null };
    const epochMs = (iso: string | undefined): number | null => {
      const t = Date.parse(iso ?? "");
      return Number.isFinite(t) ? t : null;
    };
    return {
      state: (map.get(STATE_KEY) as ResidentState | undefined) ?? "down",
      updatedAt: epochMs(map.get(UPDATED_KEY) as string | undefined),
      idleSince: epochMs(facts?.idleSince),
      lastInstanceAt: epochMs(row.instance?.createdAt),
      instanceRunning: await this.instanceRunning(row.instance?.id ?? null),
    };
  }

  /** The engine's own word on the instance `id` — `queued`, `running`,
   *  `complete`, `errored`, … — or null for an id the engine does not know (a
   *  missing binding or a failed read answer the same). The one fact the
   *  marker's age cannot give — a step between retry attempts holds no lease
   *  and writes nothing — read from the engine, which knows. */
  private async instanceStatus(id: string | null): Promise<string | null> {
    if (!id) return null;
    try {
      return (await (await this.env.RESIDENT_REFRESH.get(id)).status()).status;
    } catch {
      return null;
    }
  }

  /** Whether the engine still runs `id`: queued, running, paused or waiting.
   *  Anything else — a finished or failed instance, an unknown id — is not a
   *  live cycle, and the marker's age then decides, as before. */
  private async instanceRunning(id: string | null): Promise<boolean> {
    const status = await this.instanceStatus(id);
    return status !== null && INSTANCE_LIVE_STATUSES.has(status);
  }

  /** The cron created an instance for this resident. */
  async recordRefreshInstance(id: string, createdAtMs: number): Promise<void> {
    const row = await this.instanceRow();
    await this.ctx.storage.put(REFRESH_INSTANCE_KEY, {
      ...row,
      instance: { id, createdAt: new Date(createdAtMs).toISOString(), lastStep: null, holder: null },
    } satisfies RefreshInstanceRow);
  }

  /** The cron did not create for this bucket: a live cycle, or the engine's duplicate refusal. */
  async recordRefreshSkipped(id: string, atMs: number, why: string): Promise<void> {
    const row = await this.instanceRow();
    await this.ctx.storage.put(REFRESH_INSTANCE_KEY, {
      ...row,
      skipped: { id, at: new Date(atMs).toISOString(), why },
    } satisfies RefreshInstanceRow);
  }

  /** The lifecycle flag and the instance row, for `/status` and `/debug info`. */
  async getRefreshView(): Promise<{
    lifecycle: ResidentLifecycle;
    instance: { id: string; createdAt: string; lastStep: string | null } | null;
    skipped: RefreshInstanceRow["skipped"];
  }> {
    const [lifecycle, row] = await Promise.all([this.getLifecycle(), this.instanceRow()]);
    const instance = row.instance
      ? { id: row.instance.id, createdAt: row.instance.createdAt, lastStep: row.instance.lastStep }
      : null;
    return { lifecycle, instance, skipped: row.skipped };
  }

  /** An instance step ended: its outcome on the row, for the operator. An
   *  instance the row does not know (created by hand) is adopted. */
  private async recordInstanceStep(instance: string, step: string, outcome: string): Promise<void> {
    const row = await this.instanceRow();
    const known = row.instance?.id === instance ? row.instance : null;
    await this.ctx.storage.put(REFRESH_INSTANCE_KEY, {
      ...row,
      instance: {
        id: instance,
        createdAt: known?.createdAt ?? new Date(systemClock()).toISOString(),
        holder: known?.holder ?? null,
        lastStep: residentText(`${step}: ${outcome}`),
      },
    } satisfies RefreshInstanceRow);
  }

  /** The instance's fetch step took the cycle lease: remember the holder so a
   *  later step — in this incarnation or the next — can release exactly it. */
  private async recordInstanceHolder(instance: string, holder: string): Promise<void> {
    const row = await this.instanceRow();
    const known = row.instance?.id === instance ? row.instance : null;
    await this.ctx.storage.put(REFRESH_INSTANCE_KEY, {
      ...row,
      instance: {
        id: instance,
        createdAt: known?.createdAt ?? new Date(systemClock()).toISOString(),
        lastStep: known?.lastStep ?? null,
        holder,
      },
    } satisfies RefreshInstanceRow);
  }

  /** Release the cycle lease the instance holds, if any. */
  private async clearInstanceLease(instance: string): Promise<void> {
    const row = await this.instanceRow();
    if (row.instance?.id !== instance || !row.instance.holder) return;
    await this.clearInFlight("refresh", row.instance.holder);
    await this.ctx.storage.put(REFRESH_INSTANCE_KEY, {
      ...row,
      instance: { ...row.instance, holder: null },
    } satisfies RefreshInstanceRow);
  }

  /** Run one step of the refresh instance: counted in flight once past the
   *  entry gates (so an attach-path reconcileImage never stops the container
   *  under it — while the gates themselves, `isIdle`, `reconcileImage("refresh")`
   *  and the disk-full recycle, must not see the probing cycle as an operation
   *  in flight, or no resident would ever park, restart a stale image or
   *  recycle a full disk; the step is handed `cycle.count` and calls it once
   *  its gates have passed — the fetch step after `refreshGate`, every other
   *  step first thing), under a step trace the instance grafts on its root,
   *  its outcome on the instance row for `/status`. A step killed from outside
   *  (the container replaced under it), or a gate that stopped the container
   *  on purpose (`CycleRestartError`), is thrown to the engine, whose retry
   *  re-enters the same idempotent method — the row stays `refreshing`, never
   *  `degraded`, and a `refreshing` younger than the stale bound keeps the
   *  cron from creating a second instance meanwhile. A failure of the repo's
   *  own is recorded — `degraded` with the reason, the last snapshot still
   *  serving — and answered `failed`, which ends the cycle; the next cron
   *  firing starts the next one from that state. */
  private async runInstanceStep<T>(
    instance: string,
    step: string,
    fn: (cycle: { count: () => void }) => Promise<InstanceStepResult<T>>,
  ): Promise<InstanceStepAnswer<T>> {
    const startedAt = systemClock();
    const trace = createStepTrace(startedAt);
    let counted = false;
    const count = () => {
      if (counted) return;
      counted = true;
      this.refreshesInFlight++;
    };
    let outcome = "done";
    try {
      const result = await this.stepTrace.run(trace, () => fn({ count }));
      if (result.status !== "done") {
        outcome = result.status === "stopped" ? `stopped (${result.why})` : `failed (${result.reason})`;
        await this.clearInstanceLease(instance);
      }
      return { ...result, startedAt, trace: trace.steps() };
    } catch (err) {
      if (err instanceof ResidentDownError) {
        // Already down with its reason (goDown recorded it); the instance ends.
        outcome = `failed (${err.message})`;
        await this.clearInstanceLease(instance);
        return { status: "failed", reason: err.message, startedAt, trace: trace.steps() };
      }
      if (err instanceof CycleRestartError) {
        outcome = `restarting (${err.why}) — the engine retries`;
        console.log(`refresh instance ${instance}: ${step} ${err.message}`);
        throw err;
      }
      if (err instanceof RuntimeUnreachableError) {
        // The control port never answered (item 64): the ladder decides — the
        // step is thrown back for the engine's retry under the first three
        // rungs, or the resident is down under the last.
        let result: { status: "failed"; reason: string };
        try {
          result = await this.escalateRuntimeUnreachable(instance, step, err);
        } catch (rethrown) {
          outcome = `runtime-unreachable (attempt ${err.count} of ${RUNTIME_UNREACHABLE_DOWN_AT}, rung ${runtimeUnreachableRung(err.count)}) — the engine retries`;
          throw rethrown;
        }
        outcome = `failed (${result.reason})`;
        return { ...result, startedAt, trace: trace.steps() };
      }
      const failure = await this.classifyCycleError(err);
      if (failure.interrupted) {
        outcome = `interrupted (${failure.reason}) — the engine retries`;
        console.log(`refresh instance ${instance}: ${step} interrupted — ${failure.reason.slice(0, 400)}; retrying`);
        throw err;
      }
      // The disk-full recovery excludes this cycle from its in-flight count only
      // when the cycle counted itself: a failure inside the gates (before
      // `cycle.count()`) contributed nothing, and excluding it anyway would read
      // one real run as none and recycle the container under it.
      await this.refreshFailed(failure, counted ? 1 : 0);
      await this.clearInstanceLease(instance);
      outcome = `failed (${failure.reason})`;
      return { status: "failed", reason: failure.reason, startedAt, trace: trace.steps() };
    } finally {
      if (counted) this.refreshesInFlight--;
      await this.recordInstanceStep(instance, step, outcome).catch((err) =>
        console.log(`refresh instance ${instance}: recording ${step} failed: ${errMsg(err)}`),
      );
    }
  }

  /** Step `fetch`: the gates, the cycle lease, the fetch and the plan. The
   *  instance id is the cycle `fetchMirror` records, so a retry of this step
   *  finds its fetch done. A rebuild's markers come off here, once per cycle,
   *  never at the build step — a retried build must find its own work done. */
  async refreshInstanceFetch(input: {
    resource: string;
    instance: string;
  }): Promise<InstanceStepAnswer<RefreshFetchFacts>> {
    return this.runInstanceStep<RefreshFetchFacts>(input.instance, "fetch", async (cycle) => {
      const before = await this.getStatus();
      // down stays down (a rebuild is the escape hatch); onboarding is owned by provisioning.
      if (before.state === "onboarding" || before.state === "down") return { status: "stopped", why: "not-serving" };
      const gate = await this.refreshGate(input.resource);
      if (!gate.go) return { status: "stopped", why: gate.why };
      // Past the gates the cycle mutates the mirror and checkout: count it in
      // flight from here — never before, or the gates above (the idle park,
      // the image reconcile, the disk-full recycle) would have seen this
      // cycle as a live operation and never fired.
      cycle.count();
      const { record, facts } = gate;
      const holder = this.nextHolder();
      await this.recordInFlight("refresh", holder, REFRESH_CYCLE_LEASE_MS, "refresh");
      await this.recordInstanceHolder(input.instance, holder);
      const fetched = await this.refreshFetch(input.resource, facts, input.instance, 1);
      if (!fetched.ok) return { status: "failed", reason: fetched.reason };
      const { sha, lockfileHash } = fetched;
      const plan = planRefresh({
        sha,
        factsSha: facts.sha,
        lockfileKey: lockfileHash,
        disk: await this.readRefreshDisk(),
      });
      if (plan.action !== "unchanged") {
        console.log(`refresh: ${facts.sha.slice(0, 8)} → ${sha.slice(0, 8)}: ${plan.action} (${plan.why})`);
      }
      if (plan.action === "rebuild") await this.refreshClearMarkers(plan.install);
      return {
        status: "done",
        ref: facts.defaultRef,
        sha,
        factsSha: facts.sha,
        lockfileKey: lockfileHash,
        action: plan.action,
        install: plan.action === "rebuild" && plan.install && !!record.commands.install,
        mintError: fetched.mintError ?? null,
      };
    });
  }

  /** Step `install`: the store entry for the new key (`installDeps` finds a
   *  complete entry done). Answers the entry's path for the build to link. */
  async refreshInstanceInstall(input: {
    resource: string;
    instance: string;
    sha: string;
    lockfileKey: string;
  }): Promise<InstanceStepAnswer<{ entry: string | null }>> {
    return this.runInstanceStep<{ entry: string | null }>(input.instance, "install", async (cycle) => {
      cycle.count();
      const record = await this.registry().getRecord(input.resource);
      if (!record) return { status: "stopped", why: "offboarded" };
      const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
      if (!facts) return { status: "stopped", why: "no-facts" };
      const entry = await this.refreshInstall(record, facts, input.sha, input.lockfileKey);
      return { status: "done", entry };
    });
  }

  /** Step `build`: the checkout to the sha and its build (`runBuild` finds a
   *  checkout whose markers all name the target done). */
  async refreshInstanceBuild(input: {
    resource: string;
    instance: string;
    sha: string;
    factsSha: string;
    lockfileKey: string;
    depsEntry: string | null;
  }): Promise<InstanceStepAnswer<{ ran: boolean; why: string }>> {
    return this.runInstanceStep<{ ran: boolean; why: string }>(input.instance, "build", async (cycle) => {
      cycle.count();
      const record = await this.registry().getRecord(input.resource);
      if (!record) return { status: "stopped", why: "offboarded" };
      const built = await this.runBuild({
        sha: input.sha,
        factsSha: input.factsSha,
        lockfileKey: input.lockfileKey,
        buildCmd: record.commands.build,
        depsEntry: input.depsEntry,
      });
      // `done` from the plan means the tree was already built for this sha; the
      // step reports whether a build actually ran.
      return { status: "done", ran: !built.done, why: built.why };
    });
  }

  /** Step `snapshot`: the stamped pair to R2 (`snapshot` finds a record at the
   *  stamp done and answers `superseded` to another writer, never a throw),
   *  then the cycle's completion — facts, `warm`, the reclamation — and the
   *  cycle lease released. An `unchanged` cycle skips the archive and still
   *  completes. */
  async refreshInstanceSnapshot(input: {
    resource: string;
    instance: string;
    ref: string;
    sha: string;
    lockfileKey: string;
    action: RefreshPlan["action"];
    mintError: string | null;
  }): Promise<InstanceStepAnswer<{ committed: boolean }>> {
    return this.runInstanceStep<{ committed: boolean }>(input.instance, "snapshot", async (cycle) => {
      cycle.count();
      const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
      if (!facts) return { status: "stopped", why: "no-facts" };
      const committed =
        input.action === "unchanged"
          ? true
          : await this.refreshSnapshot(input.resource, {
              ref: input.ref,
              sha: input.sha,
              lockfileHash: input.lockfileKey,
            });
      // The reclamation's token: minted here (cached per slug), never carried
      // between steps. A failed mint runs the reclamation anonymously (PR lookups
      // answer unknown, trees are kept) and is recorded like the fetch's.
      let token: string | null = null;
      let snapshotMintError: string | undefined;
      if (githubAppConfigured(this.env)) {
        try {
          token = (await mintRepoScopedToken(this.env, input.resource.slice("repo:".length))).token;
        } catch (err) {
          snapshotMintError = `token-mint-failed (reclamation runs anonymously): ${errMsg(err)}`;
          console.log(`refresh instance ${input.instance}: ${snapshotMintError}`);
        }
      }
      await this.refreshComplete(input.resource, facts, {
        sha: input.sha,
        lockfileHash: input.lockfileKey,
        committed,
        mintError: input.mintError ?? snapshotMintError,
        token,
      });
      await this.clearInstanceLease(input.instance);
      return { status: "done", committed };
    });
  }

  /** A housekeeping step never flips lifecycle state: its failure is a log
   *  line and a `done` answer naming it (`result` null) — except a step killed
   *  from outside, which the engine retries like any other. */
  private async housekeeping<T>(
    step: string,
    work: () => Promise<T>,
  ): Promise<InstanceStepResult<{ result: T | null; error: string | null }>> {
    try {
      return { status: "done", result: await work(), error: null };
    } catch (err) {
      const failure = await this.classifyCycleError(err);
      if (failure.interrupted) throw err;
      console.log(`refresh instance: ${step} failed — ${failure.reason.slice(0, 400)}`);
      return { status: "done", result: null, error: residentText(failure.reason) };
    }
  }

  /** Step `sweep`: the worktree inactivity sweep (item 23) — TTL eviction and
   *  the clean-idle release. No gate runs here, so the step counts its cycle
   *  first thing, like install, build and snapshot. Idempotent by shape: a
   *  second call finds the bindings it evicted already evicted and nothing
   *  else past its cutoffs. */
  async refreshInstanceSweep(input: {
    resource: string;
    instance: string;
  }): Promise<InstanceStepAnswer<{ result: { evicted: string[]; kept: number } | null; error: string | null }>> {
    return this.runInstanceStep(input.instance, "sweep", async (cycle) => {
      cycle.count();
      // A runtime that does not answer has nothing to sweep, and every probe
      // would cost the SDK's 30 s abort (item 64); the fetch step already
      // recorded the verdict this instance.
      if (await this.runtimeUnreachableRow()) return { status: "stopped", why: "runtime-unreachable" };
      return this.housekeeping("sweep", () => this.sweepWorktrees(input.resource));
    });
  }

  /** Step `measure`: the disk sample (item 55) — one `df` + one `du`, written
   *  over the last; a second call takes the same sample again. Counts its
   *  cycle first thing, like every step past the gates. Never wakes a slept
   *  container (`measureDisk` answers null, `measured: false`). */
  async refreshInstanceMeasure(input: {
    instance: string;
  }): Promise<InstanceStepAnswer<{ result: { measured: boolean } | null; error: string | null }>> {
    return this.runInstanceStep(input.instance, "measure", async (cycle) => {
      cycle.count();
      // Same gate as the sweep: a silent control port cannot answer a `df`.
      if (await this.runtimeUnreachableRow()) return { status: "stopped", why: "runtime-unreachable" };
      return this.housekeeping("measure", async () => ({ measured: (await this.measureDisk()) !== null }));
    });
  }

  /** Whether a run may be using this disk: a live binding attached to or
   *  used (an exec bumps `lastAttachAt` too, item 21) within IDLE_AFTER_S.
   *  The op counter is 0 between a run's tool calls, so this floor is what
   *  stands for a run mid-flight. The one predicate behind "the disk may go
   *  away": the idle-sleep gate (item 16b — a platform sleep destroys the
   *  disk) and the disk-full recycle (item 54) both read it, and neither asks
   *  what a tree holds (item 17): a dirty tree no run is using protects
   *  nothing — the next attach wipes it. Bindings are storage, so this needs
   *  no container. */
  private recentlyUsed(live: ThreadBinding[]): boolean {
    const recent = systemClock() - IDLE_AFTER_S * 1000;
    return live.some((b) => Date.parse(b.lastAttachAt) >= recent);
  }

  /** Idle = no live binding used within the floor and nothing in flight; the
   *  sweep's release records what an idle tree held. */
  private async isIdle(): Promise<boolean> {
    if (this.recentlyUsed(await this.liveBindings())) return false;
    return this.inFlightCount() === 0;
  }

  /** Bindings that hold a pool user and a tree on disk (not evicted). */
  private async liveBindings(): Promise<ThreadBinding[]> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return [...all.values()].filter((b) => !b.evicted && b.user);
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

  /** The disk is a cache: stop the container so the next cycle attempt
   *  restores mirror + checkout from R2 onto an empty disk — the same wake
   *  path as a platform sleep. Only when the pure plan allows it: no recycle
   *  within the cooldown, nothing in flight (`selfInFlight` excludes the
   *  calling refresh cycle from the count) and no live binding used within
   *  the idle floor — the idle-sleep gate's own predicate (`recentlyUsed`),
   *  because a sleep and a recycle destroy the same disk: it may go away when
   *  no run is using it, never for what the trees hold (item 17). A recycle
   *  discards every live tree the way an eviction does, so each is measured
   *  first, as its thread user, and its binding records what went
   *  (`recordRecycledTree`); the plan is decided again after those awaits,
   *  right before the stop. A refused recycle is written to
   *  `lastRefreshError` with its why, so `/residents` says what an operator
   *  must do; the `degraded` reason stays the clean `disk-full: …`. Answers
   *  whether the container was recycled. */
  private async recoverFromDiskFull(reason: string, selfInFlight: number): Promise<boolean> {
    const lastRecycleAt = await this.ctx.storage.get<number>(DISK_FULL_RECYCLE_KEY);
    const plan = (live: ThreadBinding[]) =>
      planDiskFullRecovery({
        now: systemClock(),
        lastRecycleAt,
        inFlight: this.inFlightCount() - selfInFlight,
        recentlyUsed: this.recentlyUsed(live),
        idleFloorS: IDLE_AFTER_S,
      });
    const kept = async (why: string) => {
      console.log(`disk-full: container kept — ${why}`);
      await this.recordRefreshError(`${reason} — container kept: ${why}`);
      return false;
    };
    const live = await this.liveBindings();
    const first = plan(live);
    if (first.action === "wait") return kept(first.why);
    // What each live tree holds, for its record — never a reason to keep the
    // container. Concurrent: each probe touches only its own tree, one spawn
    // each. Runtime down: the disk, and every tree with it, is already gone.
    const active = await this.isRuntimeActive().catch(() => false);
    const trees = active
      ? await Promise.all(
          live.map(async (binding) => [binding, await this.measureTreeBeforeEviction(binding)] as const),
        )
      : live.map((binding) => [binding, undefined] as const);
    // The measurement awaited (the DO yields at each await): decide again over
    // fresh facts — an attach or an op that landed meanwhile keeps the container.
    const verdict = plan(await this.liveBindings());
    if (verdict.action === "wait") return kept(verdict.why);
    console.log(
      `disk-full: recycling the container — the next cycle restores mirror + checkout from R2 onto an empty disk (${reason})`,
    );
    for (const [binding, tree] of trees) await this.recordRecycledTree(binding, tree);
    await this.ctx.storage.put(DISK_FULL_RECYCLE_KEY, systemClock());
    await this.recordRefreshError(`${reason} — container recycled; restoring from R2 on the next cycle`);
    this.swapIncarnation(); // deliberate incarnation swap
    await this.stop().catch((err) => console.log(`disk-full: stop failed: ${errMsg(err)}`));
    return true;
  }

  /** The disk-full recycle's record for one live tree (item 54), written the
   *  way `evictBinding` writes an eviction's — but the binding stays live, its
   *  pool user kept and its tree recreated on the next attach, so this is not
   *  an eviction and the record sits under its own name beside
   *  `evictedLeftBehind`: the counts when something was there, the probe's
   *  first error line when git could not read the tree, both rewritten on
   *  every recycle so nothing lingers from an earlier one, and one log line
   *  when the tree held something. Re-read first: a binding evicted or
   *  re-attached during the measurement is left as is. */
  private async recordRecycledTree(binding: ThreadBinding, tree: EvictedTree | undefined): Promise<void> {
    const now = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
    if (!now || now.evicted || now.lastAttachAt !== binding.lastAttachAt) return;
    await this.ctx.storage.put(threadBindingKey(binding.threadKey), {
      ...now,
      recycledLeftBehind: tree && "leftBehind" in tree ? tree.leftBehind : undefined,
      recycledUnmeasured: tree && "unmeasured" in tree ? tree.unmeasured : undefined,
    } satisfies ThreadBinding);
    if (tree)
      console.log(`disk-full: ${binding.threadKey} tree discarded with the disk — ${evictedTreeSentence(tree)}`);
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
   *  coldest idle trees go first (`orderEvictionCandidates`: never the
   *  requesting thread, a busy tree, the default branch, or one attached within
   *  DISK_EVICT_MIN_IDLE_MS), whatever they hold — item 17: dirt never keeps a
   *  tree; each is measured as its thread user for the eviction's record —
   *  `df` re-probed after each; still
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
        // A deps-store entry backup stages its archive from the deps (item
        // 61); the reserve holds their share only while one runs.
        depsBackupInFlight: this.depsBackupsInFlight.size > 0,
      });
    let rawFree = df.freeKiB;
    let verdict = decide(rawFree);
    const evicted: Array<{ threadKey: string; freedKiB: number | null }> = [];
    // Item 62: keep decisions travel as tokens; the key stays for the log line.
    const kept: Array<{ threadKey: string; why: DiskKeepWhy }> = [];
    // The deps store's spares go first (item 55): a warm cache no live tree
    // references, worth minutes on a future attach, against a tree refused
    // now. Their bytes come back before any idle tree is considered.
    let spares: Array<{ key: string; freedKiB: number }> = [];
    if (!verdict.fits) {
      spares = await this.evictDepsSparesUnderPressure().catch((err) => {
        console.log(`disk-pressure: deps spare eviction failed: ${errMsg(err)}`);
        return [];
      });
      if (spares.length > 0) {
        console.log(
          `disk-pressure: evicted ${spares.length} deps-store spare(s) (${formatGiB(spares.reduce((a, e) => a + e.freedKiB, 0))} back) to make room for ${input.threadKey}`,
        );
        rawFree = rawFreeAfterEviction(
          rawFree,
          await this.dfSample(),
          spares.reduce((a, e) => a + e.freedKiB, 0),
        );
        verdict = decide(rawFree);
      }
    }
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
        // What the tree holds goes on the eviction's record (item 17), never
        // into a keep; the runtime is up — this attach is running on it.
        const tree = await this.measureTreeBeforeEviction(binding);
        // Same re-read guards as the sweep: the measurement awaited.
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
        if (!(await this.evictBinding(current, true, "disk-pressure", DISK_PRESSURE_REASON, tree))) {
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
      const reason = diskPressureReason({ verdict: final, evicted, kept, spares });
      console.log(`attach ${input.threadKey}: ${reason}`);
      const s = await this.getStatus();
      return { error: reason, status: 503, state: s.state, reason: DISK_PRESSURE_REASON };
    }
    const m = final.math;
    console.log(
      `attach ${input.threadKey}: disk admitted — ${kind} ${formatGiB(m.projectedKiB)} projected, ${formatGiB(m.freeKiB)} free, ` +
        `reserve ${formatGiB(m.reserve.totalKiB)}, headroom ${formatGiB(m.headroomKiB)}${spares.length > 0 ? `, evicted ${spares.length} deps spare(s)` : ""}${evicted.length > 0 ? `, evicted ${evicted.map((e) => e.threadKey).join(", ")}` : ""}`,
    );
    const committedKiB = m.projectedKiB ?? 0;
    this.diskCommittedKiB += committedKiB;
    return { admitted: true, committedKiB };
  }

  /** Refresh-on-attach, BOUNDED: if the resident was idle (or the last
   *  refresh is older than the active cadence), fetch the mirror now — seconds,
   *  under the mirror lock — so the ref this thread binds is current, and
   *  clear idle mode, which puts the full refresh cycle (checkout rebuild if
   *  main moved: minutes) on the cron's awake cadence — the next firing
   *  creates its instance, within one bucket. The attach never waits on an
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
      // fetch. The next refresh instance repays the staleness.
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
    this.swapIncarnation(); // deliberate incarnation swap
    await this.stop().catch((err) => console.log(`image-stale: stop failed: ${errMsg(err)}`));
    return true;
  }

  // -- watchdog (the sparse cron; it re-arms nothing) --------------------------

  /** One watchdog pass over this resident (invoked by the Worker cron): time
   *  out an onboarding stuck past its budget → down(provision-timeout) + cap
   *  slot release; the backstop for item 36's auto-rebuild (a rehydration
   *  down the transition could not act on — same decision, same row); name a
   *  `refreshing`/`restoring` marker older than STALE_MIDFLIGHT_MS that no
   *  live lease and no running instance stands behind —
   *  `degraded(stale-mid-flight: …)` carrying the last instance's id and the
   *  engine's word on it, so a failed instance is visible by name on
   *  `/status` (item 9) — and the next instance the cron creates (this very
   *  pass) normalizes it. Storage and engine-status reads only: containers
   *  are started by the instances' steps, never in this pass. The refresh row
   *  the cron's instance-creation decision reads rides on the answer, read
   *  after the check settled the state. */
  async watchdogCheck(): Promise<{
    resource: string;
    state: ResidentState;
    reason: string;
    action: "none" | "provision-timed-out" | "auto-rebuilt";
    /** Item 55: the last disk sample's gauge, for the watchdog's status line. */
    disk: { usedKiB: number; totalKiB: number; freeKiB: number; at: string } | null;
    /** Item 7: what the cron's instance-creation decision reads, after the check above settled the state. */
    refresh: RefreshRow;
  }> {
    const [check, disk] = await Promise.all([this.watchdogCheckLifecycle(), this.diskGauge()]);
    return { ...check, disk, refresh: await this.refreshRow() };
  }

  private async watchdogCheckLifecycle(): Promise<{
    resource: string;
    state: ResidentState;
    reason: string;
    action: "none" | "provision-timed-out" | "auto-rebuilt";
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
      // Item 36's backstop: the transition rebuilt (or stamped the budget)
      // when it fired; a rehydration down still here on a pass is one the
      // transition could not act on — a registry record missing then, or a
      // down from before the transition rebuilt. Same decision, same history
      // row, no strikes to accumulate.
      if ((await this.autoRebuildFromDown(status.reason, "watchdog")) === "rebuilt") {
        return {
          resource,
          state: "onboarding",
          reason: `auto-rebuild (watchdog): ${status.reason}`,
          action: "auto-rebuilt",
        };
      }
      return { resource, ...(await this.getStatus()), action: "none" };
    }
    // The auto-rebuild history is NOT cleared by a serving state: the budget
    // counts rebuilds inside a window, so a resident that comes back `warm`
    // and goes `down` again is judged with its earlier rebuilds in view. The
    // strike counter the watchdog kept before is a retired row.
    await this.ctx.storage.delete(RETIRED_REBUILD_STRIKES_KEY);

    // A mid-flight state older than STALE_MIDFLIGHT_MS with no cycle or restore
    // actually running is a marker orphaned by a cycle that died — a DO evicted
    // by a deploy, a platform restart, an instance out of retries mid-step.
    // Left alone it is permanent — the idle gate only parks from `warm`, and
    // nothing else would ever rewrite it, so the bot's warm-gate keeps sending
    // runs cold. Mark it degraded (visible — named degradation, never a
    // stall), naming the instance the row last recorded and the engine's word
    // on it; the marker is no longer `refreshing`, so the instance the cron
    // creates in this same pass normalizes it.
    if (status.state === "refreshing" || status.state === "restoring") {
      const updatedAt = Date.parse((await this.ctx.storage.get<string>(UPDATED_KEY)) ?? "") || 0;
      // Who holds what comes from the in-flight row (item 22), not from this
      // isolate's memory: a cycle or hydration lease is alive only for the
      // current incarnation and inside its budget. A hydration past the stale
      // bound counts as DEAD, not in flight: its promise lives on SDK calls
      // into a container that may have been replaced under it, and a promise
      // that never settles would otherwise hold the memo forever — making a
      // stuck `restoring` permanently invisible to this branch. No legitimate
      // restore approaches STALE_MIDFLIGHT_MS (a full R2 restore is ~1 min).
      const live = liveInFlight(await this.readInFlight(), systemClock(), this.incarnation);
      const inFlight = live.refresh || live.hydration;
      if (!inFlight && systemClock() - updatedAt > STALE_MIDFLIGHT_MS) {
        // The reads above yielded; a cycle that started meanwhile owns the
        // state now — leave it alone rather than stamp `degraded` over it.
        const again = await this.getStatus();
        const rowAgain = await this.readInFlight();
        const liveAgain = liveInFlight(rowAgain, systemClock(), this.incarnation);
        if (again.state !== status.state || liveAgain.refresh || liveAgain.hydration) {
          return { resource, ...again, action: "none" };
        }
        const last = (await this.instanceRow()).instance?.id ?? null;
        const engine = await this.instanceStatus(last);
        if (engine !== null && INSTANCE_LIVE_STATUSES.has(engine)) {
          // The engine still runs the recorded instance — a step between retry
          // attempts, holding no lease and writing no state. Not stale: leave
          // the marker, create nothing (the cron's decision reads the same fact).
          return { resource, ...status, action: "none" };
        }
        // Drop the dead hydration reference and the dead leases so the next
        // cycle's ensureHydrated starts a fresh restore instead of awaiting a
        // promise that will never settle. Safe: past the bound nothing on the
        // other end is still writing (the container it talked to is gone).
        // Each clear is compared against the holder just read: a cycle that
        // recorded a fresh lease between that read and this delete keeps it,
        // the way a release never deletes another holder's row.
        this.hydration = null;
        if (rowAgain.refresh) await this.clearInFlight("refresh", rowAgain.refresh.holder);
        if (rowAgain.hydration) await this.clearInFlight("hydration", rowAgain.hydration.holder);
        const instance = last
          ? `the last instance ${last} is ${engine ?? "unknown to the engine"}`
          : "no instance recorded";
        const reason = `stale-mid-flight: ${status.state} since ${new Date(updatedAt).toISOString()} with no cycle running; ${instance}; the next refresh instance normalizes it`;
        await this.setResidentState("degraded", reason);
        return { resource, state: "degraded", reason, action: "none" };
      }
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
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated?: boolean }> {
    // The caller's variables (an /exec body's `env`, docs/reference/specs/
    // harness-pi.md item 4) under the Worker's own: a caller never overrides
    // what the Worker injects. `su` without `-` keeps this environment for the
    // thread user's shell.
    const injected = { ...(env ?? {}), GIT_TERMINAL_PROMPT: "0" };
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
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated?: boolean }> {
    const capBytes = capBytesFor(charCap);
    const files = execCapFiles();
    const r = await this.threadRun(user, worktreePath, command, timeoutMs, capBytes, files, env);
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
    /** How a NEW binding's ref was chosen (item 16); an existing binding keeps its own record. */
    boundBy: BoundBy,
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
      // An evicted binding's own history: how its ref was chosen (absent on
      // one made before the field — never overwritten by this attach's flag),
      // the one move it may have made and its last move back.
      ...(existing
        ? {
            ...(existing.boundBy !== undefined ? { boundBy: existing.boundBy } : {}),
            ...(existing.rebound !== undefined ? { rebound: existing.rebound } : {}),
            ...(existing.returned !== undefined ? { returned: existing.returned } : {}),
            ...(existing.ownBranches !== undefined ? { ownBranches: existing.ownBranches } : {}),
          }
        : { boundBy }),
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
    reuse = false,
    record?: ResidentRecord,
    traceparent?: string,
    reason: RefHintReason = NO_REF_HINT_REASON,
  ): Promise<AttachOk | ThreadErr> {
    // One step trace per attach (docs/reference/specs/tracing.md item 19): every command
    // the attach runs lands on it, and the answer carries it.
    const t0 = systemClock();
    const trace = createStepTrace(t0);
    const res = await this.stepTrace.run(trace, () =>
      this.attachThreadTraced(threadKey, refHint, readonly, wantSha, reuse, record, t0, reason),
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
    reuse: boolean,
    record: ResidentRecord | undefined,
    t0: number,
    reason: RefHintReason,
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
      // container under it (and isIdle never parks the cycle mid-attach).
      this.attachesInFlight++;
      try {
        return await this.attachThreadBody(
          threadKey,
          refHint,
          readonly,
          wantSha,
          reuse,
          resourceId,
          t0,
          record,
          reason,
        );
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
   *  `/etc/gitconfig.lock`); the recovery decision lives in the next refresh
   *  instance's entry gate (the cron's, within one bucket) — an attach never
   *  stops the container itself: it is in flight. */
  private async attachFailed(err: unknown): Promise<ThreadErr> {
    if (!(err instanceof StepError)) return { error: `attach-failed: ${errMsg(err)}`, status: 500 };
    const failure = await this.classifyFailure(err.step, err.message);
    if (!failure.diskFull) return { error: `attach-failed at ${err.step}: ${err.message}`, status: 500 };
    console.log(`attach: ${failure.reason}`);
    await this.setResidentState("degraded", failure.reason);
    return { error: `attach-failed: ${failure.reason}`, status: 500 };
  }

  private async attachThreadBody(
    threadKey: string,
    refHint: string | null,
    readonly: boolean,
    wantSha: string | null,
    /** A resumed run's attach (item 66): keep the thread's tree as it stands, or refuse. */
    reuse: boolean,
    resourceId: string,
    t0: number,
    recordFromRoute: ResidentRecord | undefined,
    reason: RefHintReason,
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

    // The binding's ref wins for the thread's whole life, with one exception
    // (item 16): a thread bound to the repo default for want of a named branch
    // moves, once per pull request, onto the branch its own run opened a pull
    // request on — when that branch is the thread's own and the mirror holds
    // it. A decision about the binding alone, made here, before the ref is
    // chosen, so the rest of the attach (fetch, the worktree step that
    // provisions the tree clean at the moved ref, deps, credentials) runs on
    // the moved ref.
    const rebind = await this.rebindToOwnPr(
      stored.get(threadBindingKey(threadKey)) as ThreadBinding | undefined,
      reason.ownPr,
      reuse,
      facts.defaultRef,
      slug,
    );
    if ("error" in rebind) return rebind;
    const prior = rebind.binding;
    const ref = prior?.ref ?? refHint;
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

    const alloc = await this.allocateThreadUser(
      threadKey,
      ref,
      worktreePath,
      boundByFor({ refByDefault: reason.refByDefault, ref, defaultRef: facts.defaultRef }),
    );
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
        reuse,
        slug,
        t0,
        facts,
        record,
        binding,
        mode,
        rollback,
        ...(rebind.rebound !== undefined ? { rebound: rebind.rebound } : {}),
        ...(rebind.rebindRefused !== undefined ? { rebindRefused: rebind.rebindRefused } : {}),
      });
    } finally {
      this.diskCommittedKiB -= admission.committedKiB;
    }
  }

  /** Item 16's one exception to the sticky binding: a thread bound to the repo
   *  default for want of a named branch moves onto the branch its own run
   *  opened a pull request on (`ownPr`), once per pull request. A decision
   *  about the BINDING alone — the pure `rebindPlan` / `rebindVerdict` of
   *  src/execution/residentRebind.ts: the branch must be the thread's own,
   *  remembered from a release (`ownBranches`) or, when nothing was
   *  remembered, a local branch of the thread's surviving tree, measured as
   *  the thread user — and the mirror must hold it (`moveOntoOwnBranch`), since
   *  the attach that follows provisions the tree at the moved ref from the
   *  mirror as it provisions any tree (item 17: clean at the ref's tip, a tree
   *  left dirty or on the old branch recreated, the binding's path kept). Under
   *  the mirror mutex, on the row as it stands there. The binding records the
   *  move (`rebound`); the answer carries it, or the named refusal, so the bot
   *  can say where the follow-up runs and why. A refusal never fails the attach. */
  private async rebindToOwnPr(
    prior: ThreadBinding | undefined,
    ownPr: OwnPr | null,
    reuse: boolean,
    defaultRef: string,
    slug: string,
  ): Promise<{ binding: ThreadBinding | undefined; rebound?: Rebound; rebindRefused?: RebindRefused } | ThreadErr> {
    const plan = rebindPlan({ ownPr, reuse, binding: prior, defaultRef });
    if (plan.kind === "none" || prior === undefined) return { binding: prior };
    if (plan.kind === "refuse") return { binding: prior, rebindRefused: plan.refused };
    const key = threadBindingKey(prior.threadKey);
    // The tree is provisioned at the branch from the mirror, so the mirror
    // must hold it first: a branch pushed since the last refresh cycle is
    // fetched for — with a token minted here, before the mutex, like the
    // attach's own recovery fetch.
    const fetchToken = githubAppConfigured(this.env)
      ? ((await mintRepoScopedToken(this.env, slug).catch(() => null))?.token ?? null)
      : null;
    let outcome: RebindOutcome;
    try {
      outcome = (
        await this.withMirrorLock(async (): Promise<RebindOutcome> => {
          // The binding as it stands NOW, under the mutex — not the snapshot
          // the plan read before the wait: the move is judged on, and written
          // over, the row's current fields (its last attach time, its
          // credential stamp), and a premise that changed while waiting —
          // another attach already moved the ref — is re-judged, never
          // overwritten.
          const current = (await this.ctx.storage.get<ThreadBinding>(key)) ?? prior;
          const again = rebindPlan({ ownPr, reuse, binding: current, defaultRef });
          if (again.kind === "none") return { kind: "none", binding: current };
          if (again.kind === "refuse") return again;
          if (again.kind === "measure" && !again.own) {
            // Nothing remembered from a release: the branch must be a local
            // branch of the thread's surviving tree — the physical trace of
            // this thread's run having made it — measured as the thread user.
            const wt = current.worktreePath;
            const tree: RebindTreeFacts = { exists: (await this.run(["test", "-d", `${wt}/.git`])).exitCode === 0 };
            if (tree.exists) {
              const branch = await this.threadRun(
                current.user,
                wt,
                `git rev-parse --verify --quiet ${shellQuote(`refs/heads/${again.to}`)}`,
                DEFAULT_EXEC_TIMEOUT_MS,
              );
              tree.branchExists = branch.exitCode === 0;
            }
            const verdict = rebindVerdict(again, tree);
            if (verdict.kind === "refuse") return verdict;
          }
          return this.moveOntoOwnBranch(current, again, fetchToken);
        }, ATTACH_MUTEX_WAIT_MS)
      ).value;
    } catch (err) {
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      return { error: `attach-failed: ${errMsg(err)}`, status: 500 };
    }
    if (outcome.kind === "none") return { binding: outcome.binding };
    if (outcome.kind === "refuse") {
      console.log(
        `attach ${prior.threadKey}: kept on ${prior.ref} — rebind to ${plan.to} refused (${outcome.refused.reason}: ${outcome.refused.why})`,
      );
      return { binding: prior, rebindRefused: outcome.refused };
    }
    const { moved, rebound } = outcome;
    console.log(
      `attach ${prior.threadKey}: rebound ${rebound.from} → ${rebound.to} (the thread's own pull request #${rebound.pr}); the tree is provisioned at it`,
    );
    return { binding: moved, rebound };
  }

  /** The move itself (item 16): the binding's ref becomes the branch, and the
   *  attach that follows provisions the tree at it — `ensureThreadWorktree`
   *  clones the branch from the mirror when the tree is gone, dirty or on the
   *  old ref. So the mirror must hold the branch: one pushed since the last
   *  refresh cycle is fetched for here, under the mutex; a branch still
   *  missing after the fetch (deleted after a merge, or never pushed) is a
   *  `branch-absent` refusal and the binding stands — the attach then goes on
   *  at the ref it had, never `unknown-ref`. Nothing on disk is touched here:
   *  the row is written, the tree is the attach's. */
  private async moveOntoOwnBranch(
    current: ThreadBinding,
    plan: { to: string; pr: number },
    fetchToken: string | null,
  ): Promise<RebindOutcome> {
    let present = await this.refExists(plan.to);
    if (!present) {
      // A fetch that fails — GitHub unreachable, no token for a private repo —
      // is not the attach's failure: the branch is then simply not in the
      // mirror, and the refusal below names it, so the binding stands and the
      // run goes on at the ref it had instead of the attach ending 500.
      try {
        await this.gitWithCred(
          fetchToken,
          ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
          "fetch",
          GIT_NETWORK_TIMEOUT_MS,
        );
      } catch (err) {
        console.log(
          `attach ${current.threadKey}: the fetch for ${plan.to} failed (${errMsg(err)}) — the rebind is refused, the attach goes on`,
        );
      }
      present = await this.refExists(plan.to);
    }
    if (!present) {
      return {
        kind: "refuse",
        refused: rebindRefused(
          plan,
          "branch-absent",
          `the mirror does not hold ${JSON.stringify(plan.to)} even after a fetch (deleted after a merge, or never pushed); the tree cannot be provisioned at it`,
        ),
      };
    }
    const rebound: Rebound = {
      from: current.ref,
      to: plan.to,
      pr: plan.pr,
      at: new Date(systemClock()).toISOString(),
    };
    const moved: ThreadBinding = { ...current, ref: plan.to, rebound };
    await this.ctx.storage.put(threadBindingKey(current.threadKey), moved);
    return { kind: "rebound", moved, rebound };
  }

  /** Item 16's second movement, decided where the fact is established — under
   *  the mirror mutex, after the attach's fetch found the bound ref gone: a
   *  binding on a branch that is now deleted (its pull request merged) goes
   *  back to the default, so the run starts clean there (item 17) instead of
   *  the thread failing `unknown-ref` for the rest of its life — when the
   *  branch is one a rebind moved it onto, or one this thread's own runs
   *  pushed as the binding remembers it (`ownBranches`): a ship unit's coding
   *  child binds its unit branch by name and pushes it, and the merge deletes
   *  it. The row as it stands is re-read and re-judged (the pure
   *  `returnToDefault`, which writes nothing for a row `canReturnToDefault`
   *  does not admit: a ref a person named that the thread never pushed never
   *  returns — that branch is theirs to sort out), the move recorded so the
   *  thread may follow its next pull request, and the answer carries the move
   *  back for the card. A row that no longer qualifies — another attach moved
   *  it meanwhile — is answered as it stands, nothing written. */
  private async returnBindingToDefault(
    binding: ThreadBinding,
    defaultRef: string,
  ): Promise<{ binding: ThreadBinding; returned?: Returned }> {
    const key = threadBindingKey(binding.threadKey);
    const current = (await this.ctx.storage.get<ThreadBinding>(key)) ?? binding;
    const back = returnToDefault(current, defaultRef, new Date(systemClock()).toISOString());
    if (back === undefined) return { binding: current };
    await this.ctx.storage.put(key, back.binding);
    console.log(
      `attach ${binding.threadKey}: ${back.returned.from} is gone from the mirror (the thread's own pull request #${back.returned.pr}) — returned to ${back.returned.to}; the tree is provisioned there`,
    );
    return back;
  }

  /** The release's word on what the run pushed (`/detach` `pushed`, item
   *  16a), remembered on the binding BEFORE the detach decides anything: the
   *  tree evicted, a busy one kept, an already-evicted binding answered as
   *  such — and in every case the fact must outlive the
   *  tree, since it is what a follow-up's rebind onto the thread's own pull
   *  request branch reads once the tree is gone. No binding → nothing to
   *  remember on (the detach answers its 404 next). */
  private async rememberOwnBranches(threadKey: string, pushed: readonly PushedBranch[]): Promise<void> {
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) return;
    await this.ctx.storage.put(threadBindingKey(threadKey), {
      ...binding,
      ownBranches: rememberOwnBranches(binding.ownBranches, pushed, new Date(systemClock()).toISOString()),
    } satisfies ThreadBinding);
  }

  /** The second half of an attach, past disk admission: mint, fetch + clone
   *  under the mirror lock, deps, credentials, the binding write. Split from
   *  `attachThreadBody` only so the admission's commitment is released on every
   *  exit path in one `finally`. */
  private async attachThreadCreate(input: {
    threadKey: string;
    refHint: string | null;
    wantSha: string | null;
    reuse: boolean;
    slug: string;
    t0: number;
    facts: RepoFacts;
    record: ResidentRecord;
    binding: ThreadBinding;
    mode: ReturnType<typeof planReadonlyAttach>;
    rollback: () => Promise<void>;
    /** What `rebindToOwnPr` decided (item 16), for the answer. */
    rebound?: Rebound;
    rebindRefused?: RebindRefused;
  }): Promise<AttachOk | ThreadErr> {
    const { threadKey, refHint, wantSha, reuse, slug, t0, facts, record, mode, rollback } = input;
    const { rebound, rebindRefused } = input;
    // Reassigned once, under the lock, when the bound ref turns out gone from
    // the mirror and the binding goes back to the default (item 16's second
    // movement): everything after the lock — deps, credentials, the row's
    // final write, the answer — then speaks of the returned binding.
    let binding = input.binding;
    let returned: Returned | undefined;

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
    // A ref the binding could return from — a branch a rebind moved it onto,
    // or one its own runs pushed (item 16's second movement) — is fetched for
    // whether or not the mirror holds it: the branch dies when its pull
    // request merges, the deletion reaches the mirror only through a
    // `fetch --prune`, and a mirror trusted for still holding the ref would
    // provision a tree at the deleted branch's stale tip until the refresh
    // cycle's prune caught up. One predicate, read once here, drives the mint
    // pre-check, the fetch under the lock and the return gate alike.
    let want = wantShaForBinding({ boundRef: binding.ref, refHint, wantSha });
    const returnable = canReturnToDefault(binding, facts.defaultRef);
    let fetchToken: string | null = token;
    if (
      !fetchToken &&
      githubAppConfigured(this.env) &&
      (await this.mirrorFetchReasonFor(binding.ref, want, returnable)) !== null
    ) {
      fetchToken = (await mintRepoScopedToken(this.env, slug).catch(() => null))?.token ?? null;
    }

    let locked: { value: { sha: string; threadLockKey: string; recreated: boolean }; waitedMs: number };
    try {
      locked = await this.withMirrorLock(async () => {
        await this.ensureGitSetup();
        const why = await this.mirrorFetchReasonFor(binding.ref, want, returnable);
        if (why !== null) {
          try {
            await this.gitWithCred(
              fetchToken,
              ["-C", MIRROR_DIR, "fetch", "--prune", "origin"],
              "fetch",
              GIT_NETWORK_TIMEOUT_MS,
            );
          } catch (err) {
            // A fetch for a missing or stale ref fails the attach as it always
            // did. One that only verifies a returnable ref the mirror holds is
            // not the attach's failure — the origin unreachable, no token for
            // a private repo — so the attach goes on with the mirror's ref, as
            // it did before the verification existed; the return is only
            // ever decided on a fetch that ran.
            if (why !== "returnable-ref") throw err;
            console.log(
              `attach ${threadKey}: the fetch verifying ${binding.ref} at the origin failed (${errMsg(err)}) — the attach goes on with the mirror's ref`,
            );
          }
        }
        // What to check out, now that the mirror is as fresh as it will get
        // (item 51, the pure `attachTarget`): the ref's tip when the ref is
        // there; the expected commit, detached, when the ref is gone but the
        // mirror holds the commit — a merged PR's branch was deleted while
        // `refs/pull/N/head` still names its head, and the caller told us that
        // head — so a review of a merged PR stays on the warm resident instead
        // of falling back to a cold sandbox that clones the same commit itself.
        // No fetch was due ⇒ the ref existed at the check: `mirrorFetchReason`
        // fetches for every missing ref, so only a fetched mirror needs the
        // re-read — and a returnable ref is re-read for real, the fact the
        // second movement is decided on. (Under the mirror mutex — the mirror
        // cannot change in between.)
        const refExists = why === null || (await this.refExists(binding.ref));
        let target = attachTarget({
          refExists,
          wantSha: want,
          commitInMirror: !refExists && want !== null && (await this.commitInMirror(want)),
        });
        if (target.kind === "unknown-ref" && returnable) {
          // The thread's branch — one a rebind moved it onto, or one its own
          // runs pushed and it was bound to by name — is gone even after the
          // fetch: deleted once its pull request merged. The binding goes
          // back to the default (item 16's second movement) and the attach
          // goes on there: the default is always in the mirror, and the
          // worktree step below provisions the tree at its tip.
          const back = await this.returnBindingToDefault(binding, facts.defaultRef);
          binding = back.binding;
          returned = back.returned;
          want = wantShaForBinding({ boundRef: binding.ref, refHint, wantSha });
          target = attachTarget({
            refExists: await this.refExists(binding.ref),
            wantSha: want,
            commitInMirror: false,
          });
        }
        if (target.kind === "unknown-ref") {
          throw new StepError(
            "unknown-ref",
            `ref ${JSON.stringify(binding.ref)} does not resolve in the mirror (even after a fetch)` +
              (want !== null ? `, and the mirror does not hold the expected commit ${want.slice(0, 7)} either` : ""),
          );
        }
        const sha = target.kind === "sha" ? target.sha : await this.readMirrorSha(binding.ref);
        const threadLockKey = await this.lockfileKey(sha);
        const recreated = await this.ensureThreadWorktree(binding, sha, mode.originUrl, mode.modeSwitch, {
          detached: target.kind === "sha",
          reuse,
        });
        return { sha, threadLockKey, recreated };
      }, ATTACH_MUTEX_WAIT_MS);
    } catch (err) {
      await rollback();
      // A reusing attach found no tree it can keep (item 66): nothing was
      // wiped, and the caller (not this resident) decides what a run
      // without its workspace does.
      if (err instanceof ReuseRefusedError)
        return { error: `reuse-refused: ${err.why}`, status: 409, needs: "recreate" };
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      if (err instanceof StepError && err.step === "unknown-ref") {
        return { error: `unknown-ref: ${err.message}`, status: 400 };
      }
      return this.attachFailed(err);
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
      return this.attachFailed(err);
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
    // Item 55: the tree is on disk now; the next refresh instance's `measure`
    // step counts it — the admission's free-space term is a live `df`, and the
    // per-part projection it reads from the sample moves only with a cycle.

    // Which container the tree is in, for the run's row (harness-pi item 8):
    // memoized per incarnation, so this is a read after the first attach.
    const container = await this.containerIdentity();
    return {
      workspace: binding.worktreePath,
      ref: binding.ref,
      sha: locked.value.sha,
      user: binding.user,
      reconciled: deps.reconciled,
      recreated: locked.value.recreated,
      ...(container !== undefined ? { container } : {}),
      deps: deps.deps,
      credentials,
      ...(credentialsError ? { credentialsError } : {}),
      readonly: mode.readonly,
      mutexWaitMs: locked.waitedMs,
      attachMs: systemClock() - t0,
      trace: this.currentSteps(),
      ...(rebound !== undefined ? { rebound } : {}),
      ...(rebindRefused !== undefined ? { rebindRefused } : {}),
      ...(returned !== undefined ? { returned } : {}),
    };
  }

  /** Ensure the worktree exists. A provisioning attach wipes dirty/stale
   *  trees — a run starts from a clean tree at the bound ref's tip (item 17),
   *  and a rebind that moved the binding leaves a tree on the old branch that
   *  this discipline recreates like any stale one; a reusing attach
   *  (`opts.reuse`, item 66) keeps a readable tree exactly as it stands (the
   *  dirt and the HEAD are the resumed run's own work) and throws
   *  `ReuseRefusedError` for one it cannot keep, touching nothing. The
   *  decision is the pure `decideWorktree`; this method measures the facts
   *  and runs the verdict. Returns true when the tree was (re)created. MUST be
   *  called holding the mirror mutex: the clone reads the mirror.
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
    /** `detached`: the bound ref is gone from the mirror and `sha` is the
     *  expected commit it still holds (item 51) — the tree is checked out at
     *  that commit, detached, instead of at a branch. `reuse`: a resumed
     *  run's attach (item 66): keep the tree as it stands, or refuse. */
    opts: { detached: boolean; reuse: boolean } = { detached: false, reuse: false },
  ): Promise<boolean> {
    const wt = binding.worktreePath;
    const threadDir = parentDir(wt);
    await this.runOk(["install", "-d", "-m", "755", "-o", "root", "-g", "root", THREADS_DIR], "threads-dir");
    // 700 + thread-user ownership: other thread users cannot traverse in.
    await this.runOk(["install", "-d", "-m", "700", "-o", binding.user, "-g", binding.user, threadDir], "thread-dir");

    // What is on disk, measured as the thread user. A tree built for the
    // other mode (item 50) is decided before any probe: a mirror-origin,
    // credential-less tree must never serve a writable run, and a
    // GitHub-origin tree must never serve a read-only one. The ancestry probe
    // is a provisioning attach's alone: a reusing attach never judges the HEAD.
    const facts: WorktreeFacts = { exists: false };
    if (!modeSwitch && (await this.run(["test", "-d", `${wt}/.git`])).exitCode === 0) {
      facts.exists = true;
      const status = await this.threadRun(binding.user, wt, "git status --porcelain -uno", DEFAULT_EXEC_TIMEOUT_MS);
      const head = await this.threadRun(binding.user, wt, "git rev-parse HEAD", DEFAULT_EXEC_TIMEOUT_MS);
      if (status.exitCode !== 0 || head.exitCode !== 0) {
        // unreadable/corrupt (or owned by a previous pool user)
        facts.readable = false;
        facts.detail = (status.exitCode !== 0 ? status.stderr : head.stderr).trim().split("\n")[0]?.slice(0, 200) ?? "";
      } else {
        facts.readable = true;
        facts.dirty = status.stdout.trim() !== "";
        facts.head = head.stdout.trim();
        if (!opts.reuse && !facts.dirty && facts.head !== sha) {
          const anc = await this.threadRun(
            binding.user,
            wt,
            `git merge-base --is-ancestor ${sha} HEAD`,
            DEFAULT_EXEC_TIMEOUT_MS,
          );
          facts.descendsFromTip = anc.exitCode === 0;
        }
      }
    }
    const decision = decideWorktree({ reuse: opts.reuse, modeSwitch, sha, worktreePath: wt, facts });
    if (decision.kind === "refuse") throw new ReuseRefusedError(decision.why);
    if (decision.kind === "reuse") return false;

    await this.runOk(["rm", "-rf", wt], "worktree-clean");
    if (opts.detached) {
      // No branch to clone: clone the mirror without a checkout, then check
      // the expected commit out detached (`sha` is a validated full sha). A
      // path clone copies the mirror's whole object store, so the commit is in
      // the tree even though no branch of the clone names it; the detached
      // HEAD then keeps it reachable.
      await this.runOk(["git", "clone", "--no-hardlinks", "--no-checkout", MIRROR_DIR, wt], "worktree-clone", {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
      await this.runOk(["git", "-C", wt, "checkout", "--detach", "--quiet", sha], "worktree-detach", {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
    } else {
      await this.runOk(["git", "clone", "--no-hardlinks", "--branch", binding.ref, MIRROR_DIR, wt], "worktree-clone", {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
    }
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

  /** Which container this is: the kernel's boot id, one per VM boot and
   *  world-readable, so the run's pool user reads the same word from inside
   *  (docs/reference/specs/harness-pi.md item 8). Memoized per incarnation (a
   *  replaced runtime clears it with the other memos). Undefined when the
   *  kernel does not say or the command could not run: then the answer names
   *  no container, and nothing is judged by it. */
  private async containerIdentity(): Promise<string | undefined> {
    if (this.containerIdMemo !== undefined) return this.containerIdMemo;
    try {
      const word = (await this.runOk(["cat", "/proc/sys/kernel/random/boot_id"], "boot-id")).trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(word)) return undefined;
      this.containerIdMemo = word;
      return word;
    } catch {
      return undefined;
    }
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
     *  would for an install. `attempt`: the private scratch tree's name when
     *  the caller has leased it (installDeps); minted here otherwise. */
    opts: { seedFromKey?: string; restoreDeadlineMs?: number; attempt?: string } = {},
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
    const attempt = opts.attempt ?? crypto.randomUUID().slice(0, 8);
    const p = (
      plan.action === "restore" && backupRecord
        ? this.restoreDepsEntry(key, backupRecord, restoreDeadlineMs, attempt).catch(async (err) => {
            console.log(`deps: restore of ${key.slice(0, 8)} failed — installing instead: ${errMsg(err)}`);
            await this.dropDepsBackups([key]).catch(() => {});
            return this.installDepsEntry(key, sha, installCmd, budgetMs, { ...opts, attempt });
          })
        : this.installDepsEntry(key, sha, installCmd, budgetMs, { ...opts, attempt })
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
  private async restoreDepsEntry(
    key: string,
    record: DepsBackupRecord,
    deadlineMs: number,
    attempt: string,
  ): Promise<string> {
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
    opts: { seedFromKey?: string; attempt: string },
  ): Promise<string> {
    await this.acquireDepsInstallSlot();
    const { attempt } = opts;
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
        await this.swapMutableCaches(
          seedNm,
          `${scratch}/node_modules`,
          BUILD_USER,
          parsed.mutableListing,
          "deps-seed-swap",
        );
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
    await this.swapMutableCaches(
      entryNodeModules ?? `${CHECKOUT_DIR}/node_modules`,
      `${tree}/node_modules`,
      user,
      parsed.mutableListing,
      "deps-mutable-swap",
    );
    return parsed.mech;
  }

  /** The tool-cache swap for a freshly hardlinked node_modules: the listing
   *  through `mutableCachePaths`, every swap in one fork
   *  (`mutableCacheSwapScript`). A path the source has no counterpart for is
   *  a tree-private entry the script leaves in place and names on a
   *  `skipped=` line; the log carries those names so a refresh that read warm
   *  still says what it left alone (the failure path already quotes the
   *  script's stdout). */
  private async swapMutableCaches(
    srcNodeModules: string,
    dstNodeModules: string,
    user: string,
    mutableListing: string[],
    step: "deps-mutable-swap" | "deps-seed-swap",
  ): Promise<void> {
    const paths = mutableCachePaths(dstNodeModules, mutableListing);
    if (paths.length === 0) return;
    const swapped = await this.runDepScript(
      mutableCacheSwapScript(srcNodeModules, dstNodeModules, user, paths),
      step,
      GIT_NETWORK_TIMEOUT_MS,
    );
    if (swapped.skipped.length > 0) {
      console.log(
        `deps: ${step} left ${swapped.skipped.length} tree-private node_modules entr${swapped.skipped.length === 1 ? "y" : "ies"} with no store counterpart in place: ${swapped.skipped.join(", ")}`,
      );
    }
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
  /** The store entries no eviction may touch: the checkout's key, every live
   *  binding's, every install and every entry backup in flight. */
  private async depsProtectedKeys(): Promise<Set<string>> {
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    const protectedKeys = new Set<string>([...this.depsInFlight.keys(), ...this.depsBackupsInFlight]);
    if (facts?.lockfileHash) protectedKeys.add(facts.lockfileHash);
    for (const b of await this.liveBindings()) if (b.depsKey) protectedKeys.add(b.depsKey);
    return protectedKeys;
  }

  /** Remove the store entries a plan names and drop their entry backups with
   *  them (item 61 PR B: a spare nothing references on disk is a spare nothing
   *  will wake into). Shared by the sweep and the attach's pressure path. */
  private async applyDepsEviction(plan: DepsEvictionPlan, listing: DepsStoreListing, who: string): Promise<void> {
    await this.runOk(["rm", "-rf", ...plan.remove], "deps-evict", { timeoutMs: DU_TIMEOUT_MS });
    console.log(
      `deps: ${who} evicted ${plan.remove.length} path(s) — ${plan.remove.map((p) => p.slice(DEPS_STORE_DIR.length + 1, DEPS_STORE_DIR.length + 9)).join(", ")}; kept ${plan.keep.map((k) => k.slice(0, 8)).join(", ")}`,
    );
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

  /** Under disk pressure (item 55) the store keeps no spare: every complete
   *  entry no live tree references goes, coldest first, before any idle tree
   *  is considered — a spare is a cache worth minutes on a future attach, a
   *  refused tree is a run falling to a cold sandbox now. Leftovers are the
   *  sweep's business (they may be live installs' scratch). Answers what it
   *  removed with the bytes each measured at; a listing that fails answers
   *  nothing and the tree path decides as before. */
  private async evictDepsSparesUnderPressure(): Promise<Array<{ key: string; freedKiB: number }>> {
    const listed = await this.run(["sh", "-c", depsStoreListScript()], { timeoutMs: DU_TIMEOUT_MS });
    if (listed.exitCode !== 0) return [];
    const listing = parseDepsStoreListing(listed.stdout);
    if (listing.entries.length === 0) return [];
    const plan = planDepsEviction({
      entries: listing.entries,
      leftovers: [],
      protectedKeys: await this.depsProtectedKeys(),
      maxUnreferenced: DEPS_STORE_MAX_UNREFERENCED_UNDER_PRESSURE,
    });
    if (plan.remove.length === 0) return [];
    await this.applyDepsEviction(plan, listing, "disk-pressure");
    return plan.evicted.map((e) => ({ key: e.key, freedKiB: e.kib }));
  }

  private async sweepDepsStore(): Promise<void> {
    const listed = await this.run(["sh", "-c", depsStoreListScript()], { timeoutMs: DU_TIMEOUT_MS });
    if (listed.exitCode !== 0) return;
    const listing = parseDepsStoreListing(listed.stdout);
    if (listing.entries.length === 0 && listing.leftovers.length === 0) return;
    const protectedKeys = await this.depsProtectedKeys();
    // A scratch/staging dir of an install still running in this incarnation
    // is live work, not debris; the listing cannot tell them apart, so
    // leftovers wait for a sweep with nothing in flight.
    const leftovers = this.depsInFlight.size > 0 ? [] : listing.leftovers;
    const plan = planDepsEviction({ entries: listing.entries, leftovers, protectedKeys });
    if (plan.remove.length === 0) return;
    await this.applyDepsEviction(plan, listing, "sweep");
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
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    const queuedAt = systemClock();
    let startedAt = queuedAt;
    const res = await this.withThreadBusy(threadKey, () => {
      startedAt = systemClock();
      return this.execThreadImpl(threadKey, command, timeoutMs, env);
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
    env?: Record<string, string>,
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
      r = await this.threadRunCapped(binding.user, binding.worktreePath, command, timeoutMs, EXEC_OUTPUT_CAP, env);
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
    const truncated = r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP || r.truncated === true;
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
   *  the prefix check) is what confines a symlink pointing outside. A
   *  `base64` read (src/execution/binaryRead.ts) runs `base64 -w0` instead,
   *  under the binary cap; an overflow is the named refusal, never a slice
   *  of the encoding. */
  async readThreadFile(
    threadKey: string,
    path: string,
    encoding: ReadEncoding = "utf8",
  ): Promise<{ content: string; truncated: boolean } | Base64ReadAnswer | ThreadErr> {
    return this.withThreadBusy(threadKey, () => this.readThreadFileImpl(threadKey, path, encoding));
  }

  private async readThreadFileImpl(
    threadKey: string,
    path: string,
    encoding: ReadEncoding,
  ): Promise<{ content: string; truncated: boolean } | Base64ReadAnswer | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const resolved = confineThreadPath(pre.binding.worktreePath, path);
    if (!resolved)
      return { error: `path-escape: ${JSON.stringify(path)} does not stay inside the thread worktree`, status: 400 };
    if (encoding === "base64") return this.readThreadBytes(pre.binding, resolved);
    let r: Awaited<ReturnType<ResidentDO["threadRun"]>>;
    try {
      r = await this.threadRun(
        pre.binding.user,
        pre.binding.worktreePath,
        readCommandFor(resolved),
        DEFAULT_EXEC_TIMEOUT_MS,
        capBytesFor(READ_CONTENT_CAP),
      );
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
    if (r.exitCode !== 0 || r.timedOut) return { error: `read-failed: ${describeStepFailure(r)}`, status: 404 };
    const truncated = r.stdout.length > READ_CONTENT_CAP || r.truncated === true;
    return { content: truncated ? r.stdout.slice(0, READ_CONTENT_CAP) : r.stdout, truncated };
  }

  /** The bytes of a confined file as base64, as the thread user, in chunks
   *  (src/execution/binaryRead.ts): one command's stdout crosses the SDK's
   *  process log stream, which cuts a stream past a retention limit far below
   *  the binary cap and says so only through `truncated` — a 12 MB file once
   *  came back as 1.7 MB and was handed on as complete. So: `stat` first (the
   *  cap is judged on the size, before any read), then chunks small enough
   *  that no stream is ever cut; a chunk the SDK still flags, or one whose
   *  length is not what the size promised, fails the read by name. The answer
   *  carries the size for the client to check the decoded bytes against. */
  private async readThreadBytes(
    binding: { user: string; worktreePath: string },
    resolved: string,
  ): Promise<Base64ReadAnswer | ThreadErr> {
    const run = (command: string, capChars: number) =>
      this.threadRun(binding.user, binding.worktreePath, command, DEFAULT_EXEC_TIMEOUT_MS, capBytesFor(capChars));
    try {
      const stat = await run(statCommandFor(resolved), 64);
      if (stat.exitCode !== 0 || stat.timedOut)
        return { error: `read-failed: ${describeStepFailure(stat)}`, status: 404 };
      const size = parseByteSize(stat.stdout);
      if (size === null)
        return { error: `read-failed: stat answered ${JSON.stringify(stat.stdout.slice(0, 64))}`, status: 500 };
      if (size > MAX_READ_BYTES) return { encoding: "base64", tooLarge: true };
      const chunks = chunkPlan(size);
      const parts: string[] = [];
      for (const [i, chunk] of chunks.entries()) {
        const expected = base64LengthOf(chunk.length);
        const r = await run(readChunkCommandFor(resolved, chunk), expected);
        if (r.exitCode !== 0 || r.timedOut) return { error: `read-failed: ${describeStepFailure(r)}`, status: 404 };
        const piece = r.stdout.trimEnd();
        if (r.truncated === true || piece.length !== expected) {
          return {
            error: `read-inconsistent: chunk ${i + 1} of ${chunks.length} arrived as ${piece.length} of ${expected} base64 chars${r.truncated ? " (the SDK cut the output stream)" : ""}`,
            status: 409,
          };
        }
        parts.push(piece);
      }
      return { encoding: "base64", content: parts.join(""), size };
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
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
   *  evicted with the cause (`evictedWhy`) and with what the tree held
   *  (`evictedLeftBehind`, or `evictedUnmeasured` when git could not read it
   *  — item 17: never a reason to keep the tree, never discarded silently), so
   *  the ref stays sticky and the next attach recreates the tree with it.
   *  Shared by the inactivity sweep, the reclamation pass, the disk-pressure
   *  path and /detach. */
  private async evictBinding(
    binding: ThreadBinding,
    runtimeActive: boolean,
    logCtx: string,
    why: string,
    /** What the caller measured in the tree first (`measureTreeBeforeEviction`,
     *  as the thread user with the runtime up); absent when the tree was clean,
     *  already gone with the disk, or not measured (a force detach). */
    tree?: EvictedTree,
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
      evictedLeftBehind: tree && "leftBehind" in tree ? tree.leftBehind : undefined,
      evictedUnmeasured: tree && "unmeasured" in tree ? tree.unmeasured : undefined,
    } satisfies ThreadBinding);
    if (tree) console.log(`${logCtx}: ${binding.threadKey} evicted (${why}) — ${evictedTreeSentence(tree)}`);
    return true;
  }

  /** POST /detach: a run has ended — give the thread's pool user back now
   *  instead of holding it until the TTL sweep (the pool is sized for
   *  simultaneous runs). A run starts from a clean tree (item 17), so the tree
   *  goes whatever it holds: what it held — uncommitted changes, unpushed
   *  commits — is measured once, as the thread user, and named in the answer
   *  (`leftBehind`) so the loss is never silent. The one thing that keeps a
   *  tree is an op still in flight in it (`busy`) — `force` (read-only agents,
   *  hard stops) KILLS that op first (the bot has already dropped its fetch,
   *  the command would otherwise run on and hold the user until the sweep)
   *  and measures nothing. No binding → 404-shaped error; already evicted → a
   *  no-op success. Never flips lifecycle state. */
  async detachThread(
    threadKey: string,
    force: boolean,
    /** What the ending run pushed (item 16a): remembered on the binding first, whatever the detach then decides. */
    pushed: readonly PushedBranch[] = [],
  ): Promise<DetachAnswer | ThreadErr> {
    if (pushed.length > 0) await this.rememberOwnBranches(threadKey, pushed);
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
    // What the tree still holds, for the answer and the eviction's record —
    // never a reason to keep it. Not measured on a force release: a read-only
    // tree holds nothing, and a hard stop's tree is whatever the killed
    // command left. A probe that fails names nothing in the answer (never a
    // guess); the record and the log say it could not be measured.
    let tree: EvictedTree | undefined;
    if (!force && active) tree = await this.measureTreeBeforeEviction(binding);
    // Re-check right before removal: the measurement above awaited (the DO
    // yields at each await), so an exec that arrived mid-detach would otherwise
    // have its tree removed under it.
    const busyNow = this.threadOpsInFlight.get(threadKey) ?? 0;
    if (busyNow > 0)
      return {
        released: false,
        reason: `busy: ${busyNow} operation(s) started during detach — kept`,
        user: binding.user,
      };
    // Same re-read as the sweep: a re-attach during the measurement means a
    // fresh tree we must not remove from a stale snapshot.
    const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!current || current.evicted) return { released: false, reason: "already-evicted" };
    if (current.lastAttachAt !== binding.lastAttachAt)
      return { released: false, reason: "re-attached during the detach — kept", user: current.user };
    const user = current.user;
    // Same as the sweep: `active` was read before the measurement's awaits; a
    // container that woke meanwhile must get the rm, not an orphaned tree.
    const activeNow = await this.isRuntimeActive().catch(() => false);
    if (!(await this.evictBinding(current, activeNow, `detach`, "detach", tree))) {
      return { released: false, reason: "re-attached during eviction — kept", user };
    }
    // Item 55: the tree is gone; the gauge catches up at the next refresh
    // instance's `measure` step, and the admission's `df` sees the space now.
    const leftBehind = tree && "leftBehind" in tree ? tree.leftBehind : undefined;
    return { released: true, user, ...(leftBehind !== undefined ? { leftBehind } : {}) };
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

  /** What this thread's tree holds: the tracked changes and unpushed commits,
   *  or that git could not read it. The git probes run AS THE THREAD USER
   *  (su), never as root: the worktree is thread-owned, so root git in it
   *  would be refused by safe.directory and would be the exact repo-local-
   *  config execution vector safe.directory exists to block. Read by
   *  `measureTreeBeforeEviction` alone, for the record of an eviction or of
   *  the disk-full recycle — never a reason to keep a tree or a container
   *  (item 17). A tree that no longer exists (disk recycled by a sleep/wake)
   *  is clean with nothing measured: there was nothing to discard.
   *
   *  ONE spawn: the presence test and both git probes fold
   *  into the pure `worktreeCleanlinessScript` (test -d as root, both git
   *  commands inside a single privilege-dropped `su`, tagged lines out);
   *  `parseWorktreeCleanliness` encodes the exact decision table above. */
  private async worktreeCleanliness(binding: ThreadBinding): Promise<WorktreeCleanliness> {
    const injected = { GIT_TERMINAL_PROMPT: "0" }; // same injection as threadRun — fail fast, never prompt
    validateEnvNames(injected);
    const r = await this.run(["sh", "-c", worktreeCleanlinessScript(binding.worktreePath, binding.user)], {
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      env: injected,
    });
    return parseWorktreeCleanliness(r);
  }

  /** What a tree holds right before its eviction — or before the disk-full
   *  recycle discards it with the disk (item 54) — for the record and the log
   *  (item 17): the one-spawn probe as the thread user, read once into
   *  `evictedTreeOf` — never into a keep decision. Callers skip it when the
   *  runtime is down: the disk, and the tree with it, is already gone. */
  private async measureTreeBeforeEviction(binding: ThreadBinding): Promise<EvictedTree | undefined> {
    return evictedTreeOf(await this.worktreeCleanliness(binding));
  }

  /** Anything that must not be interrupted by a container stop or counted
   *  as idle: thread exec/read/write, disposable /op runs, and attaches past
   *  their own image check (mid clone/install under the mirror lock). */
  private inFlightCount(): number {
    return this.runsInFlightCount() + this.refreshesInFlight;
  }
  /** The RUNS part of inFlightCount — what a deploy's isolate swap kills for a
   *  user: thread exec/read/write, disposable /op runs, attaches mid-flight.
   *  Without the refresh cycles, which resume from their checkpoints after a
   *  swap (item 44): the deploy preflight refuses on this number and only
   *  warns for a cycle, so a resident that is merely refreshing no longer
   *  reads as busy. */
  private runsInFlightCount(): number {
    const threadOps = [...this.threadOpsInFlight.values()].reduce((a, n) => a + n, 0);
    return threadOps + this.opUsersInUse.size + this.attachesInFlight;
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

  /** The worktree inactivity sweep — every refresh instance's `sweep` step
   *  (item 23) and the `sweep-now` debug op. Removes worktrees whose binding
   *  is idle past the TTL, releases the user to the pool, and KEEPS the
   *  binding record marked evicted. Never wakes a slept container just to
   *  delete files a sleep already destroyed. */
  async sweepWorktrees(resource: string): Promise<{ evicted: string[]; kept: number }> {
    const evicted: string[] = [];
    let kept = 0;
    const record = await this.registry()
      .getRecord(resource)
      .catch(() => null);
    const ttlDays = record?.worktreeTtlDays ?? WORKTREE_TTL_DAYS_DEFAULT;
    const cutoff = systemClock() - ttlDays * 86_400_000;
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const idleCutoff = systemClock() - CLEAN_IDLE_RELEASE_S * 1000;
    for (const binding of all.values()) {
      if (binding.evicted || !binding.user) continue;
      const last = Date.parse(binding.lastAttachAt);
      if (last >= cutoff) {
        // Not past the TTL. Still release it if it has been idle for an hour
        // and nothing is running on it: the run that used it is over, and
        // whatever its tree holds has no future — the next attach provisions
        // a clean tree (item 17) — so there is nothing to keep it for. This is
        // what drains the bindings of runs whose release never came (a
        // resident that was sick at the run's end, a run older than
        // `/detach`). A live run is protected by its op in flight, not by its
        // dirt. A slept container has no tree any more anyway (sleep destroys
        // the disk).
        const busy = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
        if (last >= idleCutoff || busy > 0) {
          kept++;
          continue;
        }
      }
      // Re-read the binding: earlier iterations awaited (the DO yields), so a
      // re-attach that completed meanwhile bumped lastAttachAt and rebuilt the
      // tree — evicting from this loop's stale snapshot would rm the fresh tree.
      const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
      if (!current || current.evicted || current.lastAttachAt !== binding.lastAttachAt) {
        kept++;
        continue;
      }
      // `active` is re-read per binding: the container can wake mid-sweep (an
      // attach), and an eviction decided on a stale "inactive" would skip the
      // rm and orphan a real tree.
      const activeNow = await this.isRuntimeActive().catch(() => false);
      // What the tree holds goes on the eviction's record (item 17), measured
      // while the runtime is up; a slept container has no tree to measure.
      const tree = activeNow ? await this.measureTreeBeforeEviction(current) : undefined;
      if (
        await this.evictBinding(
          current,
          activeNow,
          `worktree-sweep ${resource}`,
          last >= cutoff ? "clean-idle" : "ttl",
          tree,
        )
      )
        evicted.push(binding.threadKey);
      else kept++;
    }
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
      const truncated = r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP || r.truncated === true;
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

  /** Debug: run the sweep pass now (the exact function the `sweep` step runs). */
  async debugSweepNow(): Promise<{ evicted: string[]; kept: number }> {
    return this.sweepWorktrees((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
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
   *  cadence, since the GitHub App has webhooks off — and via /debug
   *  reclaim-now. Never touches the default branch or a busy thread
   *  (reclaimDecision); every keep is named. What the tree holds is never a
   *  reason to keep it (item 17) — it is measured once as the thread user and
   *  recorded by the eviction, the sweep's `evictBinding` with the same
   *  re-read guards. */
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
      const decision = reclaimDecision({ fate, isDefaultRef, busy });
      if (!decision.reclaim) {
        kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: decision.why });
        continue;
      }
      // What the tree holds goes on the eviction's record (item 17), never
      // into the decision: measured as the thread user while the runtime is
      // up; down → the tree is already gone with the disk.
      const tree = active ? await this.measureTreeBeforeEviction(binding) : undefined;
      // Same guards as the sweep: the measurement awaited, so re-read the
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
      if (await this.evictBinding(current, activeNow, `reclaim ${resource}`, why, tree)) {
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
    // Item 27: the transition OUT of `restoring` is the restore event — it
    // answers every held /await-restore request with the state landed on.
    if (state !== "restoring") this.restoreWaiters.publish({ state, reason: residentText(reason) });
  }

  /** POST /await-restore (docs/reference/specs/execution.md item 27): answer at
   *  once when the state is anything but `restoring`; otherwise hold the ONE
   *  request on the waiter ledger until `setResidentState` leaves `restoring`
   *  and publishes. No polling and no retry timer on either side. */
  async awaitRestore(): Promise<{ state: string; reason: string }> {
    // The waiter goes on the ledger BEFORE the state is read: the read awaits
    // storage, and a transition that lands in that gap would publish to a
    // ledger this request is not on yet and hold it for a transition that may
    // never come (the bot's deadline would then turn a short wait cold). A
    // state already out of `restoring` answers at once and withdraws the waiter.
    const held = this.restoreWaiters.hold();
    const status = await this.getStatus();
    if (status.state !== "restoring") {
      held.withdraw();
      return { state: status.state, reason: status.reason };
    }
    const outcome = await held.outcome;
    return { state: outcome.state, reason: outcome.reason };
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
      MIRROR_MUTEX_KEY,
      inFlightKey("refresh"),
      inFlightKey("hydration"),
      LIFECYCLE_KEY,
      REFRESH_INSTANCE_KEY,
      RUNTIME_UNREACHABLE_KEY,
    ]);
    const facts = map.get(FACTS_KEY) as RepoFacts | undefined;
    const snap = map.get(SNAPSHOT_KEY) as SnapshotRecord | undefined;
    const disk = (map.get(DISK_KEY) as DiskSample | undefined) ?? null;
    const unreachable = (map.get(RUNTIME_UNREACHABLE_KEY) as RuntimeUnreachableRow | undefined) ?? null;
    const refreshRow = (map.get(REFRESH_INSTANCE_KEY) as RefreshInstanceRow | undefined) ?? {
      instance: null,
      skipped: null,
    };
    const [provisionRun, provisionDeadline, bindings] = await Promise.all([
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
      this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX }),
    ]);
    // Thread worktree bindings for the admin view: which refs are
    // live on this resident. worktreePath is an internal layout detail and is
    // left out; nothing here is secret (credential files are never persisted).
    const threads = [...bindings.values()]
      .sort((a, b) => b.lastAttachAt.localeCompare(a.lastAttachAt))
      .map(
        ({
          threadKey,
          ref,
          sha,
          user,
          deps,
          boundAt,
          lastAttachAt,
          evicted,
          evictedAt,
          evictedWhy,
          evictedLeftBehind,
          evictedUnmeasured,
          recycledLeftBehind,
          recycledUnmeasured,
        }) => ({
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
          evictedLeftBehind: evictedLeftBehind ?? null,
          evictedUnmeasured: evictedUnmeasured ?? null,
          recycledLeftBehind: recycledLeftBehind ?? null,
          recycledUnmeasured: recycledUnmeasured ?? null,
        }),
      );
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
            // The seed handle's other half (docs/reference/specs/execution.md item 25):
            // the deps-store entry archive for the snapshot's own lockfile key,
            // when one has been taken (item 61) — a seeded sandbox restores it
            // beside the checkout and skips the install.
            depsBackupId: (await this.depsBackupRecord(snap.lockfileHash))?.backup.id ?? null,
          }
        : null,
      // The provisioning schedules, the one timer a resident has (item 3).
      schedules: {
        provisionRun: provisionRun.length,
        provisionDeadline: provisionDeadline.length,
      },
      inFlight: this.inFlightCount(),
      // The runs alone (no refresh cycle): what the deploy preflight refuses on.
      runsInFlight: this.runsInFlightCount(),
      // Item 22: who holds what, as the rows say — the mirror mutex and the
      // cycle/hydration leases, each judged against this incarnation.
      incarnation: this.incarnation,
      mirrorMutex: (map.get(MIRROR_MUTEX_KEY) as Lease | undefined) ?? null,
      leases: inFlightRow(
        map.get(inFlightKey("refresh")) as Lease | undefined,
        map.get(inFlightKey("hydration")) as Lease | undefined,
      ),
      // Item 7: the lifecycle row (`workflow`), the instance last created with
      // the step it last reported, and the last bucket the cron skipped.
      lifecycle: lifecycleOf(map.get(LIFECYCLE_KEY)),
      refresh: {
        instance: refreshRow.instance
          ? {
              id: refreshRow.instance.id,
              createdAt: refreshRow.instance.createdAt,
              lastStep: refreshRow.instance.lastStep,
            }
          : null,
        skipped: refreshRow.skipped,
      },
      threads,
      // Item 55: the last disk sample (`residentDiskBudget.ts` DiskSample), or
      // null before the first measurement of this incarnation.
      disk,
      // Item 64: consecutive connects the control port did not answer, with
      // the rung that count is on; null while the port answers.
      runtimeUnreachable: unreachable ? { ...unreachable, rung: runtimeUnreachableRung(unreachable.count) } : null,
      // Item 36: the auto-rebuilds this resident has had (ISO instants; the
      // budget's window is judged over them). Empty after a person's rebuild.
      autoRebuilds: (map.get(AUTO_REBUILDS_KEY) as string[] | undefined) ?? [],
    };
  }

  // -- debug surface (admin-scoped via POST /debug; used by live validation) ---

  /** The pending schedule rows: provisioning's two, the one timer a resident
   *  has — a settled resident answers both empty (lifecycle.test.ts holds that
   *  nothing else is ever scheduled). */
  async debugSchedules(): Promise<Record<string, unknown>> {
    const [provisionRun, provisionDeadline] = await Promise.all([
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
    ]);
    return { provisionRun, provisionDeadline };
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
      this.swapIncarnation(); // deliberate incarnation swap
      await this.stop();
      return { stopped: true };
    } catch (err) {
      return { stopped: false, error: errMsg(err) };
    }
  }

  /** Admin `recreate-container` (item 13; item 64's rung 3 on demand): destroy
   *  the VM, keep every snapshot, and start the restore now — the operator's
   *  recovery for a resident whose runtime never answers, minutes where the
   *  rebuild is half an hour. Refused while the engine owns the state
   *  (onboarding/refreshing/restoring — two cycles must never race one disk)
   *  and on a `down` resident, whose one exit is `/rebuild`. The restore runs
   *  in the background through the ordinary wake path (`ensureHydrated`:
   *  `restoring`, mirror, checkout, deps, `warm`, `lastRestore`); the caller
   *  polls `/debug info`. A failure the wake path did not record itself is
   *  recorded here, so the marker never strands `restoring`. */
  async debugRecreateContainer(): Promise<
    { recreated: true; restoreStartedAt: string } | { recreated: false; error: string; status: number }
  > {
    const from = await this.getStatus();
    if (from.state === "onboarding" || from.state === "refreshing" || from.state === "restoring") {
      return {
        recreated: false,
        status: 409,
        error: `recreate-refused: the engine is mid-flight (state ${from.state}) — retry once it settles (warm/degraded)`,
      };
    }
    if (from.state === "down") {
      return {
        recreated: false,
        status: 409,
        error: `recreate-refused: the resident is down (${from.reason}) — POST /rebuild is its exit`,
      };
    }
    await this.recreateContainer(
      "runtime-unreachable: the container was recreated by an operator (recreate-container), snapshots kept — the restore from the snapshot is starting",
    );
    const restoreStartedAt = new Date(systemClock()).toISOString();
    this.ctx.waitUntil(
      this.ensureHydrated().catch(async (err) => {
        if (err instanceof ResidentDownError) return; // the wake path recorded it
        const failure = await this.classifyCycleError(err);
        console.log(`recreate-container: the restore failed — ${failure.reason.slice(0, 400)}`);
        await this.recordRefreshError(failure.reason);
        if ((await this.getStatus()).state === "restoring") await this.setResidentState("degraded", failure.reason);
      }),
    );
    return { recreated: true, restoreStartedAt };
  }

  /** Fault injection for item 36 without corrupting real R2 objects. Bare: persist
   *  `down` with a rehydration-flavored reason and nothing else, so the next
   *  watchdog pass is the backstop under test. `transition`: go through
   *  `goDown` itself — the rebuild (or the budget stamp) happens in this call,
   *  the way the wake path's own down does. Test-only semantics; admin scope. */
  async debugForceDown(reason: string, transition: boolean): Promise<ResidentStatus> {
    if (transition) {
      await this.goDown(reason);
    } else {
      await this.setResidentState("down", reason);
    }
    return this.getStatus();
  }

  /** Rebuild: the down→onboarding escape hatch — discard the recorded
   *  snapshots (R2 objects included) and reprovision from scratch through the
   *  ordinary provisioning pipeline, reusing the registry record's command
   *  table/ref/budget. `dryRun` returns the same itemized plan WITHOUT
   *  executing: nothing deleted, no state change, schedules untouched.
   *  Refused while the engine owns the state (onboarding/refreshing/
   *  restoring) — two cycles must never race the same disk. */
  async rebuild(
    resource: string,
    defaultRef: string,
    provisioningTimeoutMs: number,
    dryRun: boolean,
    /** `auto`: item 36's rebuild, which keeps the auto-rebuild history (the budget's count); a person's rebuild clears it. */
    opts: { auto?: boolean } = {},
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
    const recorded = await this.recordedBackupIds(snap);
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
        backupObjects: await this.countBackupObjects(recorded),
      },
      reprovision: { defaultRef, provisioningTimeoutMs },
      keeps: { registryRecord: true as const, threadBindings: bindings.size },
    };
    if (dryRun) return plan;

    // Old snapshot objects go FIRST: initResident wipes the stored handles,
    // and backups/<id>/ lives outside the resident/<resource>/ prefix — this
    // is the only path that can still reach them (same ordering as teardown).
    let backupObjectsDeleted = 0;
    if (recorded.length > 0) {
      try {
        backupObjectsDeleted = await this.deleteBackupObjects(recorded);
      } catch {
        // best effort — the 1-year R2 TTL is the leak backstop
      }
    }
    // A person's rebuild resets the auto-rebuild budget (item 36): the
    // history is what stops a flapping resident, and a person asking for a
    // rebuild has seen it. The automatic one keeps the history — it IS the
    // budget's count.
    if (!opts.auto) await this.ctx.storage.delete(AUTO_REBUILDS_KEY);
    // From scratch means a fresh container too: the SDK's runtime identity
    // forgotten and the VM destroyed (SIGKILL, a fresh disk) before
    // provisioning clones onto it. A rebuild that reprovisioned onto the
    // running container inherited its wedged runtime once — every exec of the
    // new provisioning met the same unanswered control port (item 64).
    this.swapIncarnation(); // deliberate incarnation swap
    await this.forgetRuntimeIdentity();
    await this.destroy().catch((err) =>
      console.log(`rebuild: destroy failed (provisioning starts anyway): ${errMsg(err)}`),
    );
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
    const [prov, run] = await Promise.all([
      this.listSchedules(PROVISIONING_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
    ]);
    const ids = await this.recordedBackupIds(await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY));
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return {
      ...status,
      schedules: prov.length + run.length,
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
    const recorded = await this.recordedBackupIds(await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY));
    if (recorded.length > 0) {
      try {
        backupObjectsDeleted = await this.deleteBackupObjects(recorded);
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
    // schedules, then delete every stored key — ours and the SDK's (its runtime
    // identity among them) — so nothing ever wakes this object again. Keys, not
    // `deleteAll()`: on a SQLite-backed object that also drops the SDK's
    // `container_schedules` table, which only its constructor creates, and an
    // onboard served by this same isolate then fails arming with
    // `no such table` after writing `onboarding` (seen live). The table stays,
    // empty — its rows are the two schedules cancelled above.
    this.swapIncarnation(); // retired object, retired memos
    await this.ctx.storage.deleteAlarm();
    const keys = [...(await this.ctx.storage.list()).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
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
  "/await-restore": { scope: "operator", method: "POST" },
};

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
          case "/await-restore":
            return await handleAwaitRestore(env, body);
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

  /** Watchdog cron: one sparse pass that creates each resident's due refresh
   *  instance (item 7), names a stale mid-flight marker by its instance, and
   *  times out stuck onboarding. Cadence invariant: this cron (every 10
   *  minutes) stays SHORTER than SLEEP_AFTER ("20m") — the instance it
   *  creates is the keep-warm. It reads DO storage and the engine's instance
   *  status only — containers are started by the instances' steps, not by the
   *  watchdog itself.
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
            `the repository is not in the App installation's repository list, or does not exist under that ` +
            `exact name (GitHub's token API answers the same 422 for both). An org admin adds it under the ` +
            `App's installation settings (Settings → GitHub Apps → Configure → Repository access), ` +
            `then retry (${errMsg(err)})`,
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
 *  onboard (the transition is provisioning's schedule). */
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
  const [record, status, inFlight, refresh] = await Promise.all([
    registryStub(env).getRecord(resource.resource),
    stub.getStatus(),
    stub.getInFlightCount(),
    stub.getRefreshView(),
  ]);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  // Item 7: which scheduler drives the refresh cycle and, on the Workflow
  // lifecycle, the current instance with its last step and the last skipped bucket.
  return json({
    state: status.state,
    reason: status.reason,
    inFlight,
    lifecycle: refresh.lifecycle,
    refresh: { instance: refresh.instance, skipped: refresh.skipped },
  });
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
  const reuse = parseReuse(body.reuse);
  if ("error" in reuse) return json({ error: reuse.error }, 400);
  // Why the hint is what it is (item 16): the thread's own pull request and
  // its head branch — the branch checked against the one ref pattern like
  // every ref, before it can become a git argument — and the bound-by-default flag.
  const parsedOwnPr = parseOwnPr(body.ownPr);
  if ("error" in parsedOwnPr) return json({ error: parsedOwnPr.error }, 400);
  if (parsedOwnPr.ownPr !== null) {
    const ownRef = parseRef(parsedOwnPr.ownPr.ref, "ownPr.ref");
    if ("error" in ownRef) return json({ error: ownRef.error }, 400);
  }
  const refByDefault = parseRefByDefault(body.refByDefault);
  if ("error" in refByDefault) return json({ error: refByDefault.error }, 400);
  const reason: RefHintReason = { ownPr: parsedOwnPr.ownPr, refByDefault: refByDefault.refByDefault };
  // Post-validation, the answer streams like /exec (item 59): heartbeat
  // whitespace then ONE JSON document over HTTP 200, so an attach that waits
  // on a deps install (minutes) cannot lose the connection the way a plain
  // response does (`fetch failed` a few minutes in). A refusal
  // carries its `status` in the body; `ResidentExecutor.attach` reads it there.
  return streamHeartbeatJson(
    ctx.stub.attachThread(
      ctx.threadKey,
      refHint,
      readonly.readonly,
      want.sha,
      reuse.reuse,
      ctx.record,
      traceparent,
      reason,
    ),
    (result) => result,
    (err) => ({ error: errMsg(err), status: 500 }),
  );
}

/** POST /await-restore (docs/reference/specs/execution.md item 27): the bot's
 *  one held request while the resident restores. Held server-side by the DO's
 *  waiter ledger; the answer streams like /attach (heartbeat whitespace then
 *  ONE JSON document over HTTP 200) so a restore lasting minutes cannot lose
 *  the connection. A pre-route Worker answers 404 (unknown route), which the
 *  bot reads as "this Worker predates the route" and falls back cold. */
async function handleAwaitRestore(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return streamHeartbeatJson(
    residentStub(env, resource.resource).awaitRestore(),
    (result) => result,
    (err) => ({ error: errMsg(err), status: 500 }),
  );
}

async function handleDetach(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  // What the run pushed (item 16a), each ref through the one ref pattern
  // before it can be stored or become a git argument.
  const pushed = parsePushed(body.pushed);
  if ("error" in pushed) return json({ error: pushed.error }, 400);
  for (const entry of pushed.pushed) {
    const ref = parseRef(entry.ref, "pushed[].ref");
    if ("error" in ref) return json({ error: ref.error }, 400);
  }
  const result = await ctx.stub.detachThread(ctx.threadKey, body.force === true, pushed.pushed);
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
  // A caller's extra environment for this one command (docs/reference/specs/
  // harness-pi.md item 4) — the run bearer the pi harness hands its process —
  // read from the body alone through the one validated reader the sandbox
  // Worker uses, and handed to the exec's env option, never onto the command.
  const execEnv = envFromRequest({ body });
  return streamThreadExec(ctx.stub.execThread(ctx.threadKey, body.command, timeoutMs, traceparent, execEnv));
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
  const encoding = readEncodingOf(body);
  if (typeof encoding !== "string") return json({ error: encoding.error }, 400);
  const result = await ctx.stub.readThreadFile(ctx.threadKey, body.path, encoding);
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

/** Admin diagnostic surface, used by the live validation of the freshness engine (refresh-now
 *  creates this bucket's instance on demand, stop-container simulates a platform sleep; mint-token proves
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
    case "refresh-now":
      // Item 13: this bucket's refresh instance, created now — `duplicate` when
      // the cron already served the bucket, `skipped` beside a live cycle.
      return json({
        op,
        resource: resource.resource,
        ...(await createRefreshInstanceNow(env, stub, resource.resource)),
      });
    case "stop-container":
      return json(await stub.debugStopContainer());
    case "recreate-container": {
      // Item 64's rung 3 on demand: destroy the VM, keep the snapshots, start
      // the restore now. `in` narrowing, as handleRebuild (the RPC stub's
      // Disposable intersection defeats the boolean discriminant).
      const r = await stub.debugRecreateContainer();
      return "error" in r ? json({ error: r.error }, r.status) : json(r, 202);
    }
    case "force-onboarding":
      return json(await stub.debugForceOnboarding());
    case "force-down": {
      // Fault injection for item 36; a rehydration-flavored default reason
      // makes it eligible. `transition: true` fires the down through goDown
      // (the rebuild happens now); bare, the watchdog's next pass is the backstop.
      const reason =
        typeof body.reason === "string" && body.reason ? body.reason : "r2-restore-failed: injected (debug force-down)";
      return json(await stub.debugForceDown(reason, body.transition === true));
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
    case "lifecycle": {
      // Item 7: the lifecycle row. `workflow` is the one scheduler, so the op
      // only rewrites a stale `alarm` value the flagged rollout left behind.
      const mode = parseLifecycle(body.mode);
      if (!mode) return json({ error: 'mode must be "workflow" — the alarm chain no longer exists' }, 400);
      return json({ op, resource: resource.resource, ...(await stub.setLifecycle(mode)) });
    }
    default:
      return json(
        {
          error: `unknown op ${JSON.stringify(op)} (ops: info, schedules, refresh-now, stop-container, recreate-container, force-onboarding, force-down, mint-token, run-watchdog, set-test-overrides, threads, sweep-now, reclaim-now, measure-disk, purge-bindings, backdate-thread, lifecycle)`,
        },
        400,
      );
  }
}

/** One watchdog pass over every registered resident. Shared by the cron
 *  handler and the /debug run-watchdog op. Each check targets a different DO,
 *  so they run concurrently; a failing one becomes its own {error} entry
 *  without touching its neighbors, and the results follow the registry list.
 *  The pass also creates each resident's refresh instance when its bucket is
 *  due (item 7). */
async function runWatchdog(env: Env, parent?: TraceSpan): Promise<WatchdogSummary> {
  const registry = registryStub(env);
  const residents = await registry.list();
  // Each check is a `resident.check` child of the firing's root when it has
  // one (the cron path; the /debug op runs bare), ending with the action taken
  // — never the resource, which names a repo.
  const checkOne = async (record: { resource: string }, span?: TraceSpan) => {
    const stub = residentStub(env, record.resource);
    const check = await stub.watchdogCheck();
    if (check.action === "provision-timed-out") {
      // The DO already tried to release its own slot; this is the backstop.
      await registry.remove(record.resource);
    }
    const instance = await createRefreshInstance(env, stub, record.resource, check.refresh);
    span?.setAttrs({ outcome: check.action });
    return { ...check, instance };
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
          instance: s.value.instance,
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
