import {
  observeWorkerCompletion,
  observeWorkerRequest,
  workerRequestId,
} from "../../src/core/trace/workerCorrelation.js";
import { installHttpTransport } from "../../src/core/trace/httpTransport.js";
import { prepareStorageRequest } from "../../src/core/storeResponse.js";
import { storageTransport } from "../../src/core/storageTransport.js";
import { assertRepositorySettingsWritable, resetRepositorySettings } from "../../src/execution/registrySettings.js";
import { captureException } from "../../src/core/runStateWriteDiagnostic.js";
import { residentGithubFailureFacts } from "./githubFailure.js";
import {
  FENCE_ACQUISITION_PREFIX,
  fenceAcquisitionOf,
  fenceAcquisitionReceipt,
  fenceAcquisitionRequestId,
  hasFenceAcquisition,
  ordinaryAcquisitionDrain,
  ownsAcquisitionFence,
  validFenceAcquisitionId,
  type FenceAcquisition,
} from "./fenceAcquisition.js";
import {
  abandonOperatorAdmission,
  handleOperatorAbandonment,
  handleOperatorAbandonmentRead,
  operatorSha256,
  quoteOperatorAdmission,
  readOperatorAbandonment,
} from "./operatorCancel.js";
import {
  nativeRetirementTargetSchema,
  nativeRetirementPermitSchema,
  nativeRetirementTargetKey,
  type NativeRetirementTarget,
} from "../../src/execution/nativeRetirement.js";
import { RecordedCheckOperation, type CheckOperationContext } from "./checkOperation.js";
import {
  NativeRunScopes,
  CloudflareNativeScopeTransport,
  type NativeScopeTransport,
  nativeOperatorScopeClosing,
  nativeOperatorScopeKey,
  nativeScopeRetirementKey,
  NATIVE_SCOPE_CONTROL_MS,
  type NativeScopeRef,
  type NativeExecutionScopeRef,
  type NativeTimeoutEnding,
} from "./nativeScope.js";
import {
  checkSelectorSchema,
  checkSourceReadOf,
  checkSourceIdentityHash,
  type CheckInspection,
  type CheckSelector,
  type CheckSourceRead,
} from "../../src/core/checkInspection.js";
import {
  checkOperationSchema,
  reportCheckResultFailure,
  type CheckOperation,
} from "../../src/execution/checkOperation.js";
import {
  NATIVE_OPERATION_PREFIX,
  NativeOperationJournal,
  nativeOperationOriginSchema,
  nativeOperationRecordSchema,
  type NativeOperationOrigin,
  type NativeOperationProducer,
  unstartedNativeOperator,
  validNativeOperationKey,
  type NativeOperationRows,
  type NativeOperationRecord,
  unstartedNativeThread,
} from "./nativeOperation.js";
import {
  readCancellationPreparation,
  cancellationFailure,
  cancellationRefusal,
  cancellationOf,
  cancellationRefusalOf,
  cancellationObservationOf,
  sameCancellation,
  type RunCancellation,
  type CancellationObservation,
  type CancellationRefusal,
  type RetirementBlock,
} from "../../src/core/runLedger/cancellation.js";
import { RUN_ID_PATTERN } from "../../src/core/runIdentity.js";
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
//   admin scope     POST /register /onboard /offboard /reconfigure /rebuild /reset /debug (all ops) /recover-admission /recover-quoted-admission /recover-native-operation
//                   GET /deploy-admissions
//   drain scope     POST /drain /deploy-fence /reconcile /undrain (admin implied)
//   read scope      GET /residents   POST /debug ops info|schedules|threads|deps-backups|native-operations (admin implied)
//   operator scope  POST /attach /detach /exec /publish /read /write /op   GET /status (state, reason, inFlight)
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
// + sticky ref binding + dep materialization + Git door origin),
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
//      root-owned mirror tokens travel via a one-shot credential file, never
//      into thread env or argv. Thread commands receive only a run bearer.
//   4. The GitHub App PRIVATE KEY exists only in Worker/DO scope. The
//      root-owned mirror commands use 1-hour installation tokens scoped to the
//      resident's own repo. Install/build executions
//      (untrusted repo code) run unprivileged (worker1) and token-free
//      (docs/decisions/0009-residents-second-credential-domain.md).
import {
  REPOSITORY_KEY_PREFIX,
  repositoryKey,
  registerRepository,
  type RepositoryRegistration,
} from "../../src/execution/repoRegistration.js";
import {
  residentAddress,
  selectedResidentMember,
  residentMembers,
  residentPoolOf,
  reservedResidentCount,
  planResidentPool,
  nextResidentMember,
  type ResidentMember,
} from "../../src/execution/residentMembers.js";
import { replicaMaintenanceFence, placementHistoryThreads, type ReplicaMaintenanceFence } from "./replicaMigration.js";
import {
  readResidentPlacement,
  recordResidentPlacement,
  type ResidentPlacement,
} from "../../src/execution/residentPlacement.js";
import { residentRouteOf, sameResidentRoute, type ResidentRoute } from "../../src/execution/residentRoute.js";
import { inspectResidentCredentials } from "./credentialInspection.js";
import {
  emptyCredentialInspection,
  parseCredentialInspection,
  credentialInspectionInputSchema,
  type CredentialInspection,
} from "../../src/execution/credentialInspection.js";
import {
  isDurableObjectCodeUpdateReset,
  isPlatformTransientError,
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
import {
  dependencyInspectionCommand,
  dependencyInspectionInputSchema,
  collectDependencyInspection,
  type DependencyInspection,
} from "../../src/execution/dependencyInspection.js";
import { DurableObject } from "cloudflare:workers";
import {
  legacyCredentialScrubCommand,
  legacyStageContentScanCommand,
  legacyStageReuseScrubCommand,
} from "./legacyCredentials.js";
import { hasUnexpectedOwnedThreadDir } from "./orphanThreadUsers.js";
import { KeyedAsyncLock } from "./keyedAsyncLock.js";
import { decideWorkspaceRemoval, hasRunOwnerField, type PreservationDecision } from "./workspacePreservation.js";
import {
  isWorkspaceOwner,
  isAcknowledgedWorkspaceOwner,
  workspaceOwnerKey,
  workspaceSettlementOf,
  workspaceBindingOf,
  type WorkspaceOwner,
  type WorkspaceSettlement,
} from "../../src/core/workspaceSettlement.js";
import { RUN_STORE_KEY, RUN_STORE_TIMEOUT_MS } from "../../src/core/runStoreConstants.js";
import { residentPublicationCommand, type ResidentPublicationInput } from "../../src/execution/residentPublication.js";
import {
  nextDeployImageReconcile,
  replacementContainerStarted,
  type DeployImageReconcileState,
} from "./imageReconcileState.js";
import {
  classifyDeployRegistrationWithLedger,
  decideOwnerReconciliation,
  validRunOwner,
  registeredRunAllowsClaim,
  registeredRunAllowsReattach,
  registeredRunNeedsProtection,
  registeredRunOwnsRelease,
} from "./runRegistration.js";
import {
  CREDENTIAL_INSPECTION_MAX_MS,
  DAY_MS,
  RUN_REGISTRATION_GRACE_MS,
  SECOND_MS,
  WORKSPACE_PREDECESSORS_MAX,
  WORKSPACE_RECONCILE_BINDINGS_MAX,
  RESTORE_BACKUP_EXPIRY_BUFFER_MS,
} from "../../src/core/budgets.js";
import { BASH_TIMEOUT_MAX_MS, BASH_TIMEOUT_MS, clampBashTimeout } from "../../src/execution/bashTimeout.js";
import { RESIDENT_MIRROR_PERMISSIONS, verifyGithubMintScope } from "../../src/execution/githubMintScope.js";
import { selectBindingsToPurge } from "../../src/execution/bindingPurge.js";
import { busyAfterKillReason, planForceDetach } from "../../src/execution/residentDetach.js";
import {
  levelPosts,
  memorySide,
  mergeOutbox,
  seatSide,
  type LevelPost,
  type LevelSample,
  type LevelSide,
  type ResidentLevelsDoc,
} from "./levels.js";
import { parseReadonly, planReadonlyAttach } from "../../src/execution/residentReadonly.js";
import {
  decideWorktree,
  parseReuse,
  replacementWorktreeCleanup,
  type WorktreeFacts,
} from "../../src/execution/residentReuse.js";
import {
  admitThreadDiskWithRollback,
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
  parsePrivateTreeObservation,
  inspectPrivateTreeObservation,
  privateTreeObservationScript,
  worktreeCleanlinessScript,
  type EvictedTree,
  type LeftBehind,
  type WorktreeCleanliness,
  type PrivateTreeObservation,
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
import { CREDENTIAL_EXPIRY_MARGIN_MS } from "../../src/execution/residentCredentials.js";
import { destroyWithPersistentFence } from "../../src/execution/residentDestroyGate.js";
import { ResidentRecreateAdmission } from "../../src/execution/residentRecreateAdmission.js";
import {
  claimPoolBinding,
  isResidentPoolUser,
  mayRunAsPoolUser,
  parsePoolBindings,
  rebuildPoolBindingIndex,
  releasePoolBinding,
} from "../../src/execution/residentPoolSpends.js";
import {
  reserveUid,
  uidOwner,
  uidLedger,
  issuedUidCount,
  resetUidGeneration,
  claimUid,
  readUidReport,
} from "./uidOwnership";
import { provisionUidCommand } from "./uidProvision";
import {
  recordFiring,
  scheduleForCron,
  watchdogFiring,
  type ScheduleFiring,
  type WatchdogSummary,
} from "../../src/core/schedules.js";
import { isServiceable, type ResidentLifecycleState } from "../../src/execution/residentState.js";
import { RestoreWaiters } from "../../src/execution/restoreWaiters.js";
import {
  isRuntimeBusySignal,
  RUNTIME_BUSY_REASON,
  SandboxRuntimeBusyError,
} from "../../src/execution/sandboxErrors.js";
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
  CHECKOUT_FETCH_COMMAND,
  checkoutUpdateCommand,
  classifyRefreshFailure,
  stageCheckoutScript,
  swapCheckoutScript,
  restoreFailureDisposition,
  isRuntimeUnreachableSignal,
  isBackgroundOperationHeld,
  killStaleBuildProcessesCommand,
  planRefresh,
  RUNTIME_MOVED_WORDING,
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
  accumulateRestoreProgress,
  withTimeout,
  type RefreshDisk,
  type RefreshPlan,
  type RestoreSample,
  type RefreshFailure,
  fetchFailureIsMirrors,
} from "../../src/execution/residentRefresh.js";
import { autoRebuildDecision, isAutoRebuildEligible } from "../../src/execution/residentAutoRebuild.js";
import {
  INFRA_STREAK_DOWN_AT,
  infraStreakReason,
  infraStreakRung,
  type InfraStreakRow,
  isRepoCommandStep,
  parksOnRepeat,
} from "../../src/execution/residentInfraStreak.js";
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
import { parseTraceparent } from "../../src/core/trace/traceparent.js";
import { backupTransferMode } from "../../src/execution/residentBackupTransfer.js";
import {
  archiveControlAnswer,
  archiveCapabilitySchema,
  executeRestoreArchive,
  prepareRestoreArchive,
  restoreIdentitySchema,
  restorePrivateDirectory,
  RestoreArchiveUnconfirmedError,
} from "./restoreArchive.js";
import {
  CHECKOUT_SNAPSHOT_EXCLUDES,
  DEPS_BACKUP_KEY_PREFIX,
  DEPS_BACKUP_TTL_S,
  DEPS_ENTRY_BACKUP_EXCLUDES,
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
import type { WorkloadAudit, WorkloadAuditCapture, WorkloadAuditSource } from "./workloadAudit.js";
import {
  admissionRecordHash,
  recoveryEvidenceUrl,
  recoveryQuote,
  recoveryViewsAreIdle,
  type AdmissionRecoveryQuote,
} from "./admissionRecovery.js";
import {
  abandonmentAuditSchema,
  deployObligations,
  liveMaintenanceWindow,
  stagingEvidenceSha256,
  stagingInstallationSchema,
  releaseWindowSchema,
  selectedStagingAttempt,
  stagingAttemptMatches,
  stagingMaintenanceSchema,
  stagingAttemptSchema,
  residentImageTargetSchema,
  type ResidentImageTarget,
  type MaintenanceRecord,
} from "./admissionRisk.js";
import {
  installStagingEpisode,
  readStagingEpisode,
  stagingEpisodeKeys,
  stagingEpisodeAuditKey,
} from "./stagingEpisodes.js";
import { createRefreshInstance, createRefreshInstanceNow, type RefreshInstanceParams } from "./refresh";
import {
  deployFenceReady,
  drainRefusal,
  holdDrain,
  liftDrain,
  liveDrain,
  parseDrainRequest,
  postUploadVersion,
  reportImageCurrent,
  staleHolds,
  type DrainRecord,
} from "./drain";
import {
  CGROUP_READ_ARGV,
  MEMORY_PRESSURE_REASON,
  MemoryGuard,
  MemorySampleUnavailable,
  type MemoryGateRoute,
  type MemoryReading,
} from "./memoryGuard";
import {
  ControlResetError,
  RuntimeReplacedError,
  controlResetErr,
  execFailureDocument,
  runtimeBusyErr,
  runtimeReplacedErr,
  selfAndCauses,
  threadErrBuilders,
  attachRefusalCode,
  preservedWorkspaceCode,
  type ThreadErr,
} from "./threadErr";
import { refusalOutcome, rootStatusForOutcome } from "./rootOutcome";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEPS_STEP_OVERHEAD_MS,
  errMsg,
  GIT_NETWORK_TIMEOUT_MS,
  RESIDENT_WORKLOAD_LIMIT,
  WORKTREE_SWEEP_BATCH_SIZE,
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
installHttpTransport();
/** The identity stored test overrides are expired against — see `buildId`:
 *  the commit alone cannot tell two builds of one dirty tree apart. */
const BUILD_ID = buildId(BUILD);

/** Version metadata is the runtime's upload identity. A missing binding
 * cannot prove whether an invocation predates the upload. */
function workerVersionId(env: Env): string | null {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

function workerVersionTimestamp(env: Env): string | null {
  const timestamp = env.CF_VERSION_METADATA?.timestamp;
  return typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

// The Worker's own spans (docs/reference/specs/tracing.md item 22): the streamed routes
// (/attach, /exec, /op) are rooted inside the DO where the work is, their
// collector's steps as `resident.<step>` children; every other authenticated
// route is a `resident.fetch` root at the edge. Each joins the bot's trace when
// the request carried one. The tracer and its log sink are shared.ts's: the
// refresh instance's root (refresh.ts) starts from the same pair.
const STREAMED_ROUTES: ReadonlySet<string> = new Set(["/attach", "/exec", "/publish", "/op", "/await-restore"]);

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
  root.end(rootStatusForOutcome(outcome), { outcome });
}

export interface Env {
  RESIDENT_MAINTENANCE_POLICY?: string;
  RESIDENT_SCRIPT_NAME?: string;
  CF_VERSION_METADATA?: { id: string; timestamp: string };
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
  /** Optional single-purpose bearer: exact terminal native scope retirement. */
  RESIDENT_RETIRE_TOKEN?: string;
  /** Optional drain-only bearer (item 69): POST /drain and /undrain, nothing
   *  else — what a release deploy holds so it can close the fleet without the
   *  admin bearer. Unset = only admin can drain. */
  RESIDENT_DRAIN_TOKEN?: string;
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
 *  scheduling failure. Keep the platform ceiling above this cap. */
// Past the cap, `evictColdest:true` makes room (resident-repos item 46).
const RESIDENT_CAP = 5;

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
/** The staged rebuild's side trees (resident-repos.md item 47): the refresh
 *  builds into `staging` OUTSIDE the mirror lock and swaps it into
 *  CHECKOUT_DIR under it (two renames); `retired` holds the replaced checkout
 *  between the swap and its off-lock removal. Same filesystem as the
 *  checkout, so both moves are renames and `cp -al` hardlinks. */
const STAGING_CHECKOUT_DIR = "/workspace/checkout.staging";
const RETIRED_CHECKOUT_DIR = "/workspace/checkout.retired";
const CHECKOUT_SWAP_DIRS = {
  checkout: CHECKOUT_DIR,
  staging: STAGING_CHECKOUT_DIR,
  retired: RETIRED_CHECKOUT_DIR,
} as const;
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
const FORCE_DETACH_KILL_TIMEOUT_MS = NATIVE_SCOPE_CONTROL_MS;

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
/** Consecutive cycles failed in the resident's OWN steps (item 67): the ladder's count, `InfraStreakRow`. */
const INFRA_STREAK_KEY = "resident:infraStreak";
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
const NON_EVIDENCE_REASON =
  /^(?:stale-mid-flight|restore-interrupted|runtime-unreachable|infra-streak|refresh-held|snapshot-stamp-unreadable):/;
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
/** The last memory reading (docs/reference/specs/resident-repos.md item 70; `memoryGuard.ts`):
 *  one cgroup v2 read at every /exec and /attach start and on the measure
 *  tick, persisted so the gauges (`/status`, `/residents`, the watchdog line)
 *  read storage only — the watchdog never touches the container. */
const MEMORY_KEY = "resident:memory";
/** The last level sample and the crossing outbox (record 0064; `levels.ts`). */
const LEVELS_LAST_KEY = "resident:levels:last";
const LEVELS_OUTBOX_KEY = "resident:levels:outbox";
/** The registry's drain post (record 0064): the fleet drain's set/cleared/expired,
 *  re-offered on every registry answer until superseded. */
const DRAIN_OUTBOX_KEY = "drain:outbox";
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
/** The settled state a cycle found before it wrote `refreshing` (item 68):
 *  what a cycle that yields to a busy container puts back. Rewritten by every
 *  cycle right before its `refreshing` write, so it always names the state
 *  under the current marker and nothing older. */
const REFRESHING_FROM_KEY = "resident:refreshingFrom";
type RefreshingFrom = ResidentStatus;
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
 *  stays far inside the bot's 90-min coding budget. Work beyond 20 minutes
 *  belongs in background jobs.
 *
 *  /op runs (test/build) get the flat 20-minute ceiling — the deterministic op
 *  path has no caller-supplied knob, and a repo's full suite routinely outlives
 *  the 5-minute per-command default; the client bounds its /op wait at the same
 *  ceiling, so the two ends agree. */
const OP_EXEC_TIMEOUT_MS = BASH_TIMEOUT_MAX_MS;
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

// `RuntimeReplacedError`, `ControlResetError`, the `ThreadErr` shape and the
// builders that answer a throw no route named live in ./threadErr.ts, pure
// over `(err, route)` so plain Node runs them; this entry hands them the
// predicates only it can supply (`threadErrBuilders`, below the predicates).

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
 *  `RPCTransportError` with one of `RPC_TRANSPORT_LOSS_KINDS`), then the SDK's
 *  message wording — on the error AND its cause chain — as a belt-and-braces
 *  fallback. Anything else (a real spawn failure, a timeout, a wire-format
 *  error) is NOT a runtime replacement.
 *
 *  Deliberately IMMUNE to the platform's superseded-isolate reset (a DO
 *  code-update reset): that is this Durable Object resetting over a container it
 *  did not touch, the container unchanged, so it is never a runtime replacement
 *  and never swaps the incarnation on the `/exec` path. `run()` answers it as a
 *  `control-reset` (`isControlReset`), and the restore path folds it in
 *  explicitly at its own site (`isRuntimeReplacement(err) || isControlReset(err)`)
 *  — the ONE place a DO reset shares the replacement disposition, since a reset
 *  under a live restore leaves nothing to land and re-restores onto the container
 *  that comes back. Keeping it out of this predicate makes that use the only one. */
function isRuntimeReplacement(err: unknown): boolean {
  if (err instanceof StaleProcessHandleError) return true;
  if (err instanceof RuntimeIdentityInactiveError) return true;
  if (err instanceof OperationInterruptedError && RUNTIME_REPLACED_REASONS.has(err.reason)) return true;
  if (err instanceof RPCTransportError && RPC_TRANSPORT_LOSS_KINDS.has(err.kind)) return true;
  for (const link of selfAndCauses(err)) if (RUNTIME_REPLACEMENT_WORDING.test(errMsg(link))) return true;
  return false;
}

/** Whether the SDK's failure vouches that the runtime under the command MOVED
 *  — a new incarnation serves the thread, so the container the command was
 *  aimed at is gone whatever else the resident knows: the typed classes for
 *  a stale process handle and an inactive runtime identity, an interruption
 *  whose reason is a replaced runtime, and the SDK's wordings for the same
 *  (`RUNTIME_MOVED_WORDING`, on the error and its cause chain). NOT the words
 *  for a container that is merely down (`STOPPED_CONTAINER_WORDING`: "The
 *  container is not running", "Process supervisor is closed") and NOT a
 *  transport lost under the call (`RPCTransportError`): an asleep or starting
 *  container and a network blip answer those too, so on `/exec` they are the
 *  word only when the resident itself knows the container it held is gone
 *  (`replacedExecAnswer`). NOT the platform's superseded-isolate reset either:
 *  that is this Durable Object resetting over a container it did not touch —
 *  `run()` intercepts it first, in both phases, as a `control-reset`
 *  (`isControlReset`), so a DO-reset cause never reaches this predicate, and a
 *  vouch for it here would say the opposite of that word. The restore path
 *  keeps the union by naming both explicitly at its site
 *  (`isRuntimeReplacement(err) || isControlReset(err)`), so a step interrupted
 *  either way is retried onto the container that comes back — while this
 *  predicate and `isRuntimeReplacement` stay immune to the reset. */
function sdkVouchesRuntimeMoved(err: unknown): boolean {
  if (err instanceof StaleProcessHandleError) return true;
  if (err instanceof RuntimeIdentityInactiveError) return true;
  if (err instanceof OperationInterruptedError && RUNTIME_REPLACED_REASONS.has(err.reason)) return true;
  for (const link of selfAndCauses(err)) if (RUNTIME_MOVED_WORDING.test(errMsg(link))) return true;
  return false;
}

/** The 500 for a throw no route named and the thread data plane's rejection
 *  mapping (threadErr.ts holds the rules; threadErr.test.ts runs them under
 *  plain Node with the SDK's real sentences), built over the predicates only
 *  this entry can supply: the SDK's reset and platform-transient predicates,
 *  and the resident's own replacement classifier and vouch. */
const { catchAllErr, threadRejectionErr } = threadErrBuilders({
  isControlReset,
  isRuntimeReplacement,
  sdkVouchesRuntimeMoved,
  isPlatformTransientError,
});

/** Whether a command's failure is the resident's own Durable Object resetting
 *  under it (a Worker-code deploy) rather than the container runtime being
 *  replaced. Checked BEFORE `isRuntimeReplacement` on the thread `run()` path,
 *  so a DO reset over a still-running container answers `control-reset`, never
 *  the replaced word. The SDK's predicate already walks the cause
 *  chain (`selfAndCauses`), so it is called directly on the caught error. */
function isControlReset(err: unknown): boolean {
  return isDurableObjectCodeUpdateReset(err);
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

/** Did the platform refuse the connect inside its own accept allowance
 *  (docs/reference/specs/resident-repos.md item 68; execution.md item 28)? The
 *  platform's own wording — a plain `Error`, the SDK hands it on unwrapped —
 *  anywhere in the cause chain; its words blame load, which the platform never
 *  measured and an idle container has disproved. Asked only of a spawn-phase
 *  error, after `isRuntimeReplacement`: such a container is neither replaced
 *  nor silent for good, and a command's own output never gets here. */
function isRuntimeBusy(err: unknown): boolean {
  for (const link of selfAndCauses(err)) if (isRuntimeBusySignal(link)) return true;
  return false;
}
// ---------------------------------------------------------------------------
// GitHub App auth (docs/decisions/0009-residents-second-credential-domain.md)
// — Worker/DO scope only; the private key never
// enters the container. RS256 App JWT on WebCrypto (node:crypto is not
// available here), then POST /app/installations/:id/access_tokens with
// `repositories: [<own repo name>]` and mirror-read permissions, so a minted
// token grants only the resident's root-owned clone/fetch and PR lookup. Cache
// per slug, but only serve a cached token while
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
  const checkMaintenance = async () => {
    const hold = await registryStub(env).getStagingMaintenance();
    if (hold?.state === "held" && !hold.policy.resources.includes(`repo:${slug}`))
      throw new Error("staging maintenance refuses token access outside the selected fixture");
  };
  await checkMaintenance();
  if (!githubAppConfigured(env)) {
    throw new Error(
      "github-app-not-configured: GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY secrets are unset; cannot mint an installation token",
    );
  }
  // A repudiated token must never be re-served: drop the slug's cache entry and
  // mint anew. Otherwise serve a cached token while it has more than the refresh
  // margin left, so a root-owned mirror operation never starts on a token
  // likely to expire during its network call.
  if (opts?.fresh) githubTokenCache.delete(slug);
  const cached = opts?.fresh ? undefined : githubTokenCache.get(slug);
  if (cached && systemClock() < cached.expiresAtMs - CREDENTIAL_EXPIRY_MARGIN_MS) return cached;

  const jwt = await githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  // The installation-token API scopes by repo NAME within the installation's
  // owner — the owner half of the slug is fixed by the installation itself.
  const repoName = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  await checkMaintenance();
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
      body: JSON.stringify({ repositories: [repoName], permissions: RESIDENT_MIRROR_PERMISSIONS }),
      // A slow GitHub must not hang attach/refresh. The 10s abort surfaces as a
      // command-level Error (below), never a lifecycle transition.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // AbortSignal.timeout aborts with a "TimeoutError" DOMException; any other
    // fetch throw (network/DNS) lands here too. Both are command-level errors.
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(
      `github-token-mint-failed: ${aborted ? "timed out after 10s contacting api.github.com" : "transport failure contacting api.github.com"}`,
      { cause: err },
    );
  }
  if (!res.ok) {
    throw new Error(`github-token-mint-failed: HTTP ${res.status}${await residentGithubFailureFacts(res)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  verifyGithubMintScope(data, slug, RESIDENT_MIRROR_PERMISSIONS);
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
interface ResidentRecord extends RepositoryRegistration {
  /** Metadata-only registration: never routes to a resident DO. */
  noResident?: boolean;
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
type WorkspaceReference = {
  owner: WorkspaceOwner;
  binding: WorkspaceSettlement["binding"];
  applied?: WorkspaceSettlement;
};
const WORKSPACE_SETTLEMENT_CURSOR_KEY = "workspace:settlement-cursor";
const WORKTREE_SWEEP_CURSOR_KEY = "workspace:sweep-cursor";

interface ThreadBinding {
  /** Metadata delivery survives owner replacement and VM loss. */
  workspacePredecessors?: WorkspaceReference[];
  workspaceSettlement?: WorkspaceSettlement;
  container?: string;
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
   *  there. Newest last; capacity refuses a merge rather than losing facts. */
  ownBranches?: OwnBranch[];
  /** Allocated OS user (worker2..worker17); "" once evicted (pool released). */
  user: string;
  worktreePath: string;
  boundAt: string;
  lastAttachAt: string;
  evicted?: boolean;
  evictedAt?: string;
  /** Owner of the registration removed with this tree, for a delayed push receipt. */
  lastRunOwner?: Pick<RunRegistration, "runId" | "ownerGen" | "ownerFence" | "workspace">;
  /** Why the last eviction happened (the audit trail): `ttl`, `clean-idle`,
   *  `detach`, `disk-pressure`, or a reclamation fate — `merged #N` /
   *  `closed #N` / `gone`. */
  evictedWhy?: string;
  /** What the tree held when that eviction removed it: the tracked changes
   *  and unpushed commits measured as the thread user. Absent when the tree
   *  was clean, already gone with the disk, or not measured (a force detach). */
  evictedLeftBehind?: LeftBehind;
  /** Why the tree could not be measured before that eviction (git could not
   *  read it) — so an unreadable tree is never recorded as clean. */
  evictedUnmeasured?: string;
  /** What the tree held when the last authorized disk-full recycle (item 54) discarded
   *  it with the disk — the same measurement as `evictedLeftBehind`, under its
   *  own name because the binding is not evicted: its user is kept and the
   *  next attach recreates the tree (`worktree-missing`). Both rewritten on
   *  every recycle; absent when the tree was clean or already gone. */
  recycledLeftBehind?: LeftBehind;
  /** Why the tree could not be measured before that recycle (git could not
   *  read it) — still discarded with the disk, never recorded as clean. */
  recycledUnmeasured?: string;
  /** Latest reason automatic cleanup deferred; never a release receipt. */
  preservationBlocked?: string;
  /** How deps were last materialized (evidence that the per-branch reconciliation ran). */
  deps?: ThreadDepsMechanism;
  /** Commit the worktree was last attached at (the ref's tip in the mirror
   *  at that moment). A terminal owner without a coding settlement can release
   *  only when the current clean tree is still at this HEAD. */
  sha?: string;
  /** The mode the tree was last built for (item 50): true → no credential
   *  file, origin = the unreadable mirror. An attach in the other mode
   *  recreates the tree. Absent (pre-field bindings) = writable. */
  readonly?: boolean;
  /** Legacy pre-door binding field. No new model credential file is written;
   *  attach clears the old value after scrubbing that file. */
  credentialsWrittenAt?: number;
  /** Legacy pre-door token expiry; cleared with `credentialsWrittenAt`. */
  tokenExpiresAtMs?: number;
  /** Non-secret host of the run-bearer Git door. The bearer lives only in
   *  the attach request and the run's per-exec environment. */
  githubDoorHost?: string;
  /** The deps-store entry this tree's node_modules is a view of (item 59);
   *  protects the entry from eviction while the binding lives. Absent on a
   *  binding made before the store, or on a tree with no deps. */
  depsKey?: string;
}

/** What one image reconcile decided (`reconcileImage`): the container was
 *  stopped to restart on the current image (`restarted`), already runs it
 *  (`current`), is not running so the next start uses it anyway (`inactive`),
 *  is busy — an operation, an attach or a registered run in flight — and the
 *  restart is deferred to the next quiet check (`deferred`), or predates the
 *  deploy on the attach path, which never stops a container (issue 2101): the
 *  attach is refused so the new run takes the fallback sandbox, and the
 *  restart stays the refresh cycle's or the deploy's (`stale`). */
type ImageReconcileResult = "restarted" | "current" | "inactive" | "deferred" | "stale";

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
  /** Set only after the exact attachment registration commits. */
  ownerFence?: number;
  deps: ThreadDepsMechanism;
  /** Present on a reused tree only when its stored dependency key matches this head. */
  depsKey?: string;
  /** `ok` — writable origin uses the Git door; `unavailable` — no door;
   *  `none` — read-only attach with an unfetchable origin (item 50). */
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

/** What `POST /detach` answers: whether the live binding was released, why not, and
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

/** The snapshot as `/status` and `/debug info` publish it: the stamp, both
 *  archive ids, and the deps entry archive for its lockfile key (null until
 *  one has been taken). */
interface SnapshotHandle {
  ref: string;
  sha: string;
  lockfileHash: string;
  createdAt: string;
  mirrorBackupId: string;
  checkoutBackupId: string;
  depsBackupId: string | null;
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

const REGISTRY_KEY_PREFIX = REPOSITORY_KEY_PREFIX;
const registryKey = repositoryKey;
/** Registry-DO key for the admin test overrides (gc.ts `StoredTestOverrides`).
 *  Deliberately OUTSIDE the `resident:` prefix so it never counts as a slot. */
const TEST_OVERRIDES_KEY = "testOverrides";
/** Registry-DO key for the fleet drain (drain.ts; docs/reference/specs/resident-repos.md
 *  item 69). Outside the `resident:` prefix like the overrides, so it never
 *  counts as a slot; it survives the isolate swap a deploy performs, which is
 *  why the record carries its own end. */
const DRAIN_KEY = "drain";
const DEPLOY_ADMISSION_KEY_PREFIX = "deploy:admission:";
const DEPLOY_RELEASE_RECEIPTS_KEY = "deploy:release-receipts";
const DEPLOY_RELEASE_RECEIPT_BYTES = 64 * 1024;
const DEPLOY_RECOVERY_KEY_PREFIX = "deploy:recovered:";
const DEPLOY_FENCE_RELEASE_KEY_PREFIX = "deploy:fence-release:";
const DEPLOY_ABANDONED_KEY_PREFIX = "deploy:abandoned:";

interface DeployFenceReleaseReceipt {
  schema: 1;
  originalRecordSha256: string;
  originalRecord: DrainRecord;
  workerVersion: string;
  evidenceSha256: string;
  registrySha256: string;
  releasedAt: number;
  requestEnd: "operator-attested";
  nativeOutcome: "operator-attested-unchanged";
  drainRetained: true;
}

/** Safe request provenance, never an authority or a native completion receipt. */
class OpaqueNativeOutcomeUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpaqueNativeOutcomeUnconfirmedError";
  }
}

type NativeRequestContext = {
  requestId?: string;
  sourceId?: string;
  callId: string;
  actor: NativeOperationOrigin["actor"];
  traceId: string | null;
  parentSourceId: string | null;
};

function deployAdmissionOrigin(input: unknown) {
  const row = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const word = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null);
  return {
    kind: ["resident-call", "refresh-step", "fleet-lifecycle", "reconcile", "watchdog"].includes(String(row.kind))
      ? (row.kind as string)
      : null,
    component: ["resident", "http", "workflow", "scheduler"].includes(String(row.component))
      ? (row.component as string)
      : null,
    build:
      typeof row.build === "string" &&
      /^[a-f0-9]{7,40}(?:@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(row.build)
        ? row.build
        : null,
    workerVersion:
      typeof row.workerVersion === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.workerVersion)
        ? row.workerVersion
        : null,
    resource:
      typeof row.resource === "string" &&
      row.resource.length <= 63 &&
      /^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.resource)
        ? row.resource
        : null,
    sourceId: word(row.sourceId),
    producer: [
      "git-setup",
      "provisioning",
      "hydration",
      "deps-materialize",
      "deps-backup",
      "deps-adopt",
      "op-test",
      "op-build",
      "resident-call",
      "refresh-step",
      "fleet-lifecycle",
      "reconcile",
      "watchdog",
      "attach",
      "thread-work",
      "inspect-preservation",
      "inspect-dependencies",
      "detach",
      "discard-absent",
      "reconcile-owner",
      "deadline",
      "exec",
      "read",
      "write",
      "publish",
      "credentials",
    ].includes(String(row.producer))
      ? String(row.producer)
      : null,
    callId:
      typeof row.callId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.callId)
        ? row.callId
        : null,
    actor: ["system", "service", "admin", "operator", "read", "drain", "retire"].includes(String(row.actor))
      ? String(row.actor)
      : null,
    parentSourceId: word(row.parentSourceId),
    traceId:
      typeof row.traceId === "string" && /^[a-f0-9]{32}$/.test(row.traceId) && !/^0+$/.test(row.traceId)
        ? row.traceId
        : null,
    requesterScope: ["admin", "operator", "read", "drain"].includes(String(row.requesterScope))
      ? (row.requesterScope as string)
      : null,
  };
}

function emitDeployAdmission(event: Record<string, unknown>, failure?: { error: unknown }): void {
  try {
    const exception = failure ? captureException(failure.error) : undefined;
    console.log(
      `[resident-deploy-admission] ${JSON.stringify({
        schema: 1,
        ...event,
        ...(exception ? { errorName: exception.name, errorMessage: exception.message } : {}),
      })}`,
    );
  } catch {
    /* A log sink cannot change request admission or settlement. */
  }
}

type DeployAdmissionIdentity = { id: string; requestHash: string };
type DeployReleaseReceipt = DeployAdmissionIdentity & {
  startedAt: number;
  releasedAt: number;
  origin?: ReturnType<typeof deployAdmissionOrigin>;
  originalRecordSha256?: string;
};

function validDeployAdmissionIdentity(value: unknown): value is DeployAdmissionIdentity {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id) &&
    typeof row.requestHash === "string" &&
    /^[a-f0-9]{64}$/.test(row.requestHash)
  );
}

function validDeployReleaseReceipts(value: unknown): value is DeployReleaseReceipt[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    new Set(value.map((row) => row?.id)).size === value.length &&
    value.every((row) => {
      const startedAt = row?.startedAt,
        releasedAt = row?.releasedAt,
        origin = row?.origin,
        originalRecordSha256 = row?.originalRecordSha256;
      return (
        validDeployAdmissionIdentity(row) &&
        Number.isSafeInteger(startedAt) &&
        startedAt >= 0 &&
        Number.isSafeInteger(releasedAt) &&
        releasedAt >= startedAt &&
        (origin === undefined ||
          (JSON.stringify(origin) === JSON.stringify(deployAdmissionOrigin(origin)) &&
            typeof originalRecordSha256 === "string" &&
            /^[a-f0-9]{64}$/.test(originalRecordSha256)))
      );
    })
  );
}

/** Only the original living stack may qualify a lost reply. Never repeat the mutation. */
async function beginTrackedDeployAdmission(
  registry: Pick<
    ResidentRegistryDO,
    "beginDeployAdmission" | "beginDeployReconcileAdmission" | "readDeployAdmissionReceipt"
  >,
  origin: unknown,
  reconcile?: { versionId: string | null; versionTimestamp: string | null; attempt?: unknown },
): Promise<DeployAdmissionIdentity | null> {
  const supplied = origin && typeof origin === "object" ? (origin as Record<string, unknown>) : {};
  const id = crypto.randomUUID();
  const safeOrigin = deployAdmissionOrigin({
    ...supplied,
    callId: supplied.callId ?? id,
    producer: supplied.producer ?? supplied.kind,
    actor: supplied.actor ?? supplied.requesterScope ?? (supplied.component === "http" ? "service" : "system"),
    sourceId: supplied.sourceId ?? supplied.kind,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([safeOrigin, reconcile ?? null])),
  );
  const identity = {
    id,
    requestHash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
  emitDeployAdmission({
    phase: "admission-requested",
    ...identity,
    observedAt: systemClock(),
    ...safeOrigin,
  });
  try {
    const result = reconcile
      ? await registry.beginDeployReconcileAdmission(
          reconcile.versionId,
          reconcile.versionTimestamp,
          identity,
          reconcile.attempt,
          safeOrigin,
        )
      : await registry.beginDeployAdmission(safeOrigin, identity);
    if (result === null) return null;
    if (result === identity.id) return identity;
  } catch {
    /* A committed admission can outlive its reply. */
  }
  const receipt = await registry.readDeployAdmissionReceipt(identity).catch(() => null);
  if (
    receipt?.state === "admitted" &&
    receipt.id === identity.id &&
    receipt.requestHash === identity.requestHash &&
    Number.isSafeInteger(receipt.startedAt) &&
    Number(receipt.startedAt) >= 0
  )
    return identity;
  emitDeployAdmission({
    phase: "admission-unverified",
    ...identity,
    observedAt: systemClock(),
    failure: "storage-or-rpc",
  });
  throw new Error("deploy-admission-unverified");
}

async function endTrackedDeployAdmission(
  registry: Pick<ResidentRegistryDO, "endDeployAdmission" | "readDeployAdmissionReceipt">,
  identity: DeployAdmissionIdentity,
): Promise<void> {
  try {
    await registry.endDeployAdmission(identity.id, identity.requestHash);
    return;
  } catch {
    /* Absence alone cannot qualify the original release. */
  }
  const receipt = await registry.readDeployAdmissionReceipt(identity).catch(() => null);
  if (
    receipt?.state === "released" &&
    receipt.id === identity.id &&
    receipt.requestHash === identity.requestHash &&
    Number.isSafeInteger(receipt.startedAt) &&
    Number(receipt.startedAt) >= 0 &&
    Number.isSafeInteger(receipt.releasedAt) &&
    Number(receipt.releasedAt) >= Number(receipt.startedAt)
  )
    return;
  emitDeployAdmission({
    phase: "permit-release",
    id: identity.id,
    observedAt: systemClock(),
    commit: "unverified",
    failure: "storage-or-rpc",
    nativeOutcome: "unverified",
  });
  throw new Error("deploy-release-unverified");
}

/** Resident-DO key (issue 1931): set when a deploy's reconcile could not
 *  verify this resident's container on the new image; the next reconcile that
 *  finds it current reports to the registry and clears it. */
const IMAGE_REPORT_PENDING_KEY = "imageReportPending";
const IMAGE_RECONCILE_KEY = "imageReconcile";

type OnboardResult = { ok: true; record: ResidentRecord } | { ok: false; status: number; error: string };

export class ResidentRegistryDO extends DurableObject<Env> {
  async resetSettings(action: "preview" | "freeze" | "restore", operation?: string, records?: ResidentRecord[]) {
    return resetRepositorySettings(this.ctx.storage, action, operation, records, (record) => {
      if (
        !record ||
        "error" in parseResource(record.resource) ||
        "error" in parseCommands(record.commands) ||
        "error" in parseDefaultRef(record.defaultRef) ||
        "error" in parseResidentLimits({ ...record }) ||
        record.offboarding
      )
        throw new Error("repository reset settings are invalid");
      residentPoolOf(record);
    });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (env.RESIDENT_MAINTENANCE_POLICY !== undefined)
      ctx.blockConcurrencyWhile(() => this.initializeStagingMaintenance());
  }

  /** Only the rendered policy can install a hold. A restart keeps the same
   * held/released generation; request data cannot replace it. */
  async initializeStagingMaintenance(): Promise<void> {
    if (this.env.RESIDENT_MAINTENANCE_POLICY === undefined) return;
    const parsed = stagingMaintenanceSchema.safeParse(JSON.parse(this.env.RESIDENT_MAINTENANCE_POLICY));
    if (!parsed.success) throw new Error("staging-maintenance-policy-invalid");
    const policy = parsed.data;
    if (
      policy.stagingAccount !== this.env.CLOUDFLARE_ACCOUNT_ID ||
      policy.stagingAccount === policy.productionAccount ||
      policy.residentScript !== this.env.RESIDENT_SCRIPT_NAME ||
      !policy.residentScript.includes("staging") ||
      policy.attempt.sourceCommit !== BUILD.commit
    )
      throw new Error("staging-maintenance-scope-mismatch");
    await this.ctx.storage.transaction((txn) => installStagingEpisode(txn, policy, systemClock()));
  }

  async getStagingMaintenance(
    store: Pick<DurableObjectStorage, "get" | "list"> = this.ctx.storage,
    historicalHoldId?: string,
  ): Promise<MaintenanceRecord | null> {
    const record = await readStagingEpisode(store, historicalHoldId);
    if (
      record &&
      (record.policy.stagingAccount !== this.env.CLOUDFLARE_ACCOUNT_ID ||
        record.policy.residentScript !== this.env.RESIDENT_SCRIPT_NAME)
    )
      throw new Error("staging-maintenance-record-unverified");
    return record;
  }

  async getDeployObligations(
    store: Pick<DurableObjectStorage, "get" | "list"> = this.ctx.storage,
    purpose: "deploy" | "release" = "deploy",
    selected?: MaintenanceRecord,
  ) {
    const maintenance = selected ?? (await this.getStagingMaintenance(store));
    const window = await store.get(stagingEpisodeKeys(maintenance?.policy).window);
    const parsed = releaseWindowSchema.safeParse(window);
    return deployObligations({
      rows: await store.list({ prefix: DEPLOY_ADMISSION_KEY_PREFIX }),
      maintenance,
      window,
      audit: parsed.success ? await store.get(stagingEpisodeAuditKey(maintenance?.policy, parsed.data.recordId)) : null,
      drain: await store.get(DRAIN_KEY),
      now: systemClock(),
      purpose,
    });
  }

  async getStagingMaintenanceReadback(historicalHoldId?: string) {
    return this.ctx.storage.transaction(async (txn) => {
      const hold = await this.getStagingMaintenance(txn, historicalHoldId);
      if (!hold) return null;
      const parsed = releaseWindowSchema.safeParse(await txn.get(stagingEpisodeKeys(hold.policy).window));
      const counts = await this.getDeployObligations(txn, "deploy", hold);
      const audit = parsed.success
        ? abandonmentAuditSchema.safeParse(await txn.get(stagingEpisodeAuditKey(hold.policy, parsed.data.recordId)))
        : null;
      return {
        schema: 1,
        policySha256: await stagingEvidenceSha256(hold.policy),
        installation: hold.policy.predecessor
          ? stagingInstallationSchema.parse(await txn.get(stagingEpisodeKeys(hold.policy).installation))
          : null,
        state: hold.state,
        holdId: hold.policy.holdId,
        generation: hold.policy.generation,
        releasedAt: hold.releasedAt,
        releaseDecisionSha256: hold.releaseDecisionSha256,
        fixtureSha256: hold.policy.fixtureSha256,
        decisionSha256: hold.policy.decisionSha256,
        attempt: hold.policy.attempt,
        window:
          parsed.success && audit?.success
            ? {
                state: !liveMaintenanceWindow(hold, systemClock())
                  ? "expired"
                  : counts.qualified
                    ? parsed.data.state
                    : "unverified",
                recordedState: parsed.data.state,
                recordId: audit.data.id,
                originalRecordSha256: audit.data.originalRecordSha256,
                decisionSha256: hold.policy.decisionSha256,
                disposition: audit.data.disposition,
                requestEnd: audit.data.requestEnd,
                nativeOutcome: audit.data.nativeOutcome,
                observedAt: systemClock(),
                stored: counts.stored,
                excluded: counts.excluded,
                blocking: counts.blocking,
              }
            : null,
      };
    });
  }

  /** Accept the preselected staging risk, preserving the exact unfinished
   * request. This audit grants no native ending or unrelated exemption. */
  async abandonStagingAdmission(
    id: string,
    expected: AdmissionRecoveryQuote,
    attempt: unknown,
    fixtureSha256: unknown,
    decisionSha256: unknown,
    versionId: string,
  ): Promise<boolean> {
    if (
      !stagingAttemptSchema.safeParse(attempt).success ||
      !/^[0-9a-f-]{36}$/.test(id) ||
      !recoveryQuote(expected?.startedAt, expected?.recordSha256)
    )
      return false;
    return this.ctx.storage.transaction(async (txn) => {
      if (hasFenceAcquisition(await txn.get(DRAIN_KEY))) return false;
      const now = systemClock();
      const held = await this.getStagingMaintenance(txn);
      const fence = liveDrain(await txn.get(DRAIN_KEY), now);
      if (
        !held ||
        !selectedStagingAttempt(held, attempt, now) ||
        (held.policy.predecessor &&
          (id !== held.policy.predecessor.request.id ||
            expected.startedAt !== held.policy.predecessor.request.startedAt ||
            expected.recordSha256 !== held.policy.predecessor.request.recordSha256)) ||
        held.policy.fixtureSha256 !== fixtureSha256 ||
        held.policy.decisionSha256 !== decisionSha256 ||
        !fence?.swapFence ||
        fence.swapVersion !== versionId ||
        !deployFenceReady(fence, now) ||
        held.policy.attempt.deadline > Date.parse(fence.until) ||
        (await txn.get(stagingEpisodeAuditKey(held?.policy, id))) !== undefined ||
        (await txn.get(`${DEPLOY_RECOVERY_KEY_PREFIX}${id}`)) !== undefined ||
        (await txn.get(stagingEpisodeKeys(held?.policy).window)) !== undefined
      )
        return false;
      const original = await txn.get(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`);
      if (
        (original as { startedAt?: unknown } | undefined)?.startedAt !== expected.startedAt ||
        now < expected.startedAt ||
        (await admissionRecordHash(original)) !== expected.recordSha256
      )
        return false;
      const quotedFence = { since: fence.since, until: fence.until, versionId };
      const audit = abandonmentAuditSchema.safeParse({
        schema: 1,
        id,
        disposition: "operator-abandoned",
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        independentObligations: "unchanged",
        policy: held.policy,
        originalRecord: original,
        originalRecordSha256: expected.recordSha256,
        decidedAt: now,
        fence: quotedFence,
      });
      if (!audit.success) return false;
      await txn.put(stagingEpisodeAuditKey(held?.policy, id), audit.data);
      await txn.put(stagingEpisodeKeys(held?.policy).window, {
        schema: 1,
        state: "authorized",
        recordId: id,
        holdId: held.policy.holdId,
        generation: held.policy.generation,
        attemptId: held.policy.attempt.id,
        drain: quotedFence,
      });
      return true;
    });
  }

  /** A matching immutable audit proves the risk decision's commit only. */
  async readStagingAbandonmentReceipt(
    id: string,
    expected: AdmissionRecoveryQuote,
    attempt: unknown,
    fixtureSha256: unknown,
    decisionSha256: unknown,
  ): Promise<boolean> {
    const held = await this.getStagingMaintenance();
    const audit = abandonmentAuditSchema.safeParse(
      await this.ctx.storage.get(stagingEpisodeAuditKey(held?.policy, id)),
    );
    const selected = stagingAttemptSchema.safeParse(attempt);
    if (!held || !audit.success || !selected.success || !recoveryQuote(expected?.startedAt, expected?.recordSha256))
      return false;
    return (
      audit.data.id === id &&
      audit.data.originalRecord.startedAt === expected.startedAt &&
      audit.data.originalRecordSha256 === expected.recordSha256 &&
      (await admissionRecordHash(audit.data.originalRecord)) === expected.recordSha256 &&
      JSON.stringify(audit.data.policy) === JSON.stringify(held.policy) &&
      held.policy.fixtureSha256 === fixtureSha256 &&
      held.policy.decisionSha256 === decisionSha256 &&
      selected.data.holdId === held.policy.holdId &&
      selected.data.generation === held.policy.generation &&
      (Object.keys(held.policy.attempt) as Array<keyof typeof held.policy.attempt>).every(
        (key) => selected.data[key] === held.policy.attempt[key],
      )
    );
  }

  /** A fresh manual release decision can reopen only this staging fixture.
   * It preserves the request and never renews its upload window. */
  async releaseStagingMaintenance(
    expected: AdmissionRecoveryQuote,
    attempt: unknown,
    decisionSha256: unknown,
  ): Promise<boolean> {
    if (
      !recoveryQuote(expected?.startedAt, expected?.recordSha256) ||
      typeof decisionSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(decisionSha256)
    )
      return false;
    const released = await this.ctx.storage.transaction(async (txn) => {
      const hold = await this.getStagingMaintenance(txn);
      if (
        !hold ||
        hold.state !== "held" ||
        !stagingAttemptMatches(hold, attempt) ||
        decisionSha256 === hold.policy.decisionSha256 ||
        (hold.policy.predecessor &&
          [hold.policy.predecessor.decisionSha256, hold.policy.predecessor.releaseDecisionSha256].includes(
            decisionSha256,
          ))
      )
        return false;
      const window = releaseWindowSchema.safeParse(await txn.get(stagingEpisodeKeys(hold?.policy).window));
      const counts = await this.getDeployObligations(txn, "release");
      if (!window.success || !counts.qualified || counts.blocking !== 0) return false;
      const quote = recoveryQuote(expected.startedAt, expected.recordSha256);
      const row = await txn.get(`${DEPLOY_ADMISSION_KEY_PREFIX}${window.data.recordId}`);
      if (
        !quote ||
        (row as { startedAt?: unknown } | undefined)?.startedAt !== quote.startedAt ||
        (await admissionRecordHash(row)) !== quote.recordSha256
      )
        return false;
      const key = `deploy:staging-release:${hold.policy.holdId}`;
      if ((await txn.get(key)) !== undefined) return false;
      const releasedAt = systemClock();
      await txn.put(key, {
        schema: 1,
        holdId: hold.policy.holdId,
        generation: hold.policy.generation,
        fixtureSha256: hold.policy.fixtureSha256,
        decisionSha256,
        releasedAt,
        originalRecordSha256: quote.recordSha256,
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
      });
      await txn.put(stagingEpisodeKeys(hold.policy).maintenance, {
        ...hold,
        state: "released",
        releasedAt,
        releaseDecisionSha256: decisionSha256,
      });
      await txn.delete(DRAIN_KEY);
      return true;
    });
    if (released) await this.pushDrainPost("below");
    return released;
  }

  async readStagingReleaseReceipt(attempt: unknown, decisionSha256: unknown): Promise<boolean> {
    const hold = await this.getStagingMaintenance();
    if (
      !hold ||
      hold.state !== "released" ||
      !stagingAttemptMatches(hold, attempt) ||
      hold.releaseDecisionSha256 !== decisionSha256
    )
      return false;
    const row = await this.ctx.storage.get<{ decisionSha256?: unknown; generation?: unknown; releasedAt?: unknown }>(
      `deploy:staging-release:${hold.policy.holdId}`,
    );
    return (
      row?.generation === hold.policy.generation &&
      row.decisionSha256 === decisionSha256 &&
      row.releasedAt === hold.releasedAt
    );
  }

  async sealStagingWindow(
    attempt: unknown,
    versionId: string | null,
    versionTimestamp: string | null,
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (hasFenceAcquisition(await txn.get(DRAIN_KEY))) return false;
      const held = await this.getStagingMaintenance(txn);
      const window = releaseWindowSchema.safeParse(await txn.get(stagingEpisodeKeys(held?.policy).window));
      const fence = liveDrain(await txn.get(DRAIN_KEY), systemClock());
      const counts = await this.getDeployObligations(txn);
      if (
        !held ||
        !selectedStagingAttempt(held, attempt, systemClock()) ||
        !window.success ||
        window.data.state !== "fenced" ||
        !counts.qualified ||
        counts.blocking !== 0 ||
        !fence ||
        !postUploadVersion(fence, versionId, versionTimestamp)
      )
        return false;
      await txn.put(stagingEpisodeKeys(held?.policy).window, { ...window.data, state: "completed" });
      return true;
    });
  }
  /** Atomic cap check + insert. Durable Objects deliver events through input
   *  gates: while a storage operation is in flight no other event is delivered
   *  to this object, and nothing below awaits anything except this object's
   *  own storage — so the exists-check, the count, and the insert cannot
   *  interleave with a concurrent onboard. */
  async onboard(record: ResidentRecord): Promise<OnboardResult> {
    const { cap } = await this.limits();
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "onboard");
      if ((await this.getStagingMaintenance(txn))?.state === "held")
        return { ok: false, status: 409, error: "staging maintenance blocks registration" };
      return registerRepository<ResidentRecord>(txn, record, cap);
    });
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
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "replace");
      if ((await this.getStagingMaintenance(txn))?.state === "held")
        return { ok: false, status: 409, error: "staging maintenance blocks replacement" };
      if ((await this.getRepository(evict))?.pool)
        return { ok: false, status: 409, error: "resident pools require explicit offboarding" };
      if (!(await txn.get(registryKey(evict)))) {
        return { ok: false, status: 409, error: `${evict} is no longer onboarded — nothing to evict` };
      }
      if (await txn.get(registryKey(record.resource))) {
        return { ok: false, status: 409, error: `${record.resource} is already onboarded` };
      }
      const { cap } = await this.limits();
      const existing = reservedResidentCount(await this.listRepositories());
      if (existing - 1 >= cap) {
        return {
          ok: false,
          status: 429,
          error: `resident cap reached (${existing}/${cap}) even after evicting ${evict}`,
        };
      }
      await txn.delete(registryKey(evict));
      await txn.put(registryKey(record.resource), record);
      return { ok: true, record };
    });
  }

  async getRecord(resource: string): Promise<ResidentRecord | null> {
    const record = await this.getRepository(resource);
    return record?.noResident === true || record?.offboarding === true ? null : record;
  }

  /** Keep saved placement. Only new threads can select another serving member. */
  async resolveThreadPlacement(
    resource: string,
    threadKey: string,
    serving?: string[],
  ): Promise<
    { ok: true; record: ResidentRecord; placement: ResidentPlacement } | { ok: false; status: number; error: string }
  > {
    const placementId = crypto.randomUUID();
    return this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<ResidentRecord>(registryKey(resource));
      if (!record || record.noResident === true || record.offboarding)
        return { ok: false, status: 404, error: `${resource} is not onboarded` };
      const pool = residentPoolOf(record);
      const saved = await readResidentPlacement(txn, resource, threadKey);
      if (
        saved === null ||
        (saved && !(pool?.members.slice(0, pool.active) ?? [resource]).includes(saved.residentId))
      ) {
        console.log(
          `[placement] refused ${resource} for ${threadKey}: ${saved ? "unsupported-address" : "placement-unverified"}`,
        );
        return { ok: false, status: 503, error: "resident placement could not be verified" };
      }
      if (saved) return { ok: true, record, placement: saved };
      const cursorKey = `replica-cursor:${resource}`;
      const cursor = (await txn.get<number>(cursorKey)) ?? 0;
      const residentId = serving === undefined ? resource : nextResidentMember(record, serving, cursor);
      if (!residentId) return { ok: false, status: 503, error: "no warm resident can accept a new placement" };
      const result = await recordResidentPlacement(txn, { schema: 1, resource, threadKey, residentId, placementId });
      if (!result.ok) return { ok: false, status: 503, error: "resident placement could not be verified" };
      if (serving !== undefined) await txn.put(cursorKey, cursor === Number.MAX_SAFE_INTEGER ? 0 : cursor + 1);
      return { ok: true, record, placement: result.placement };
    });
  }

  async readThreadPlacement(resource: string, threadKey: string): Promise<ResidentPlacement | null | undefined> {
    return readResidentPlacement(this.ctx.storage, resource, threadKey);
  }

  async getRepository(resource: string): Promise<ResidentRecord | null> {
    return (await this.ctx.storage.get<ResidentRecord>(registryKey(resource))) ?? null;
  }

  async list(): Promise<ResidentMember<ResidentRecord>[]> {
    return residentMembers(await this.listRepositories());
  }

  /** Reserve addresses and capacity now; maintenance activates new members
   * only after primary workspace placements have been imported. */
  async requestWarmReplicas(resource: string, desired: number): Promise<OnboardResult> {
    const revision = crypto.randomUUID();
    const addresses = Array.from(
      { length: Math.max(0, Math.min(desired, RESIDENT_CAP)) },
      () => `resident-${crypto.randomUUID()}`,
    );
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "requestWarmReplicas");
      const record = await txn.get<ResidentRecord>(registryKey(resource));
      if (!record || record.noResident || record.offboarding)
        return { ok: false, status: 404, error: `${resource} has no resident` };
      const { cap } = effectiveLimits(await txn.get<StoredTestOverrides>(TEST_OVERRIDES_KEY), BUILD_ID, {
        cap: RESIDENT_CAP,
        floorS: LRU_FLOOR_S,
      });
      const prior = residentPoolOf(record);
      const retained = prior?.members.length ?? 1;
      if (!Number.isSafeInteger(desired) || desired < 1 || desired > Math.max(cap, retained))
        return {
          ok: false,
          status: 400,
          error: `warm resident count must be between 1 and ${Math.max(cap, retained)}`,
        };
      if (prior?.desired === desired) return { ok: true, record };
      const pool = planResidentPool(record, desired, addresses, revision);
      const all = await txn.list<ResidentRecord>({ prefix: REGISTRY_KEY_PREFIX });
      const others = [...all.values()].filter((r) => r.resource !== resource);
      if (pool.members.length > retained && reservedResidentCount([...others, { ...record, pool }]) > cap)
        return { ok: false, status: 429, error: "resident capacity is already reserved" };
      const occupied = new Set(
        others.flatMap((r) => (r.noResident ? [] : (residentPoolOf(r)?.members ?? [r.resource]))),
      );
      if (pool.members.some((id) => occupied.has(id)))
        return { ok: false, status: 409, error: "resident address is already registered" };
      const updated = { ...record, pool, updatedAt: new Date(systemClock()).toISOString() };
      await txn.put(registryKey(resource), updated);
      return { ok: true, record: updated };
    });
  }

  async replicaMaintenance(admissionId: string): Promise<ReplicaMaintenanceFence | undefined> {
    return this.ctx.storage.transaction(async (txn) =>
      replicaMaintenanceFence(
        await txn.get(DRAIN_KEY),
        await txn.list({ prefix: DEPLOY_ADMISSION_KEY_PREFIX }),
        admissionId,
        systemClock(),
      ),
    );
  }

  /** Import bounded chunks; only a page's final chunk commits its cursor.
   * A lost reply replays the page or reads its completed cursor. */
  async importPrimaryPlacements(
    resource: string,
    revision: string,
    admissionId: string,
    fence: ReplicaMaintenanceFence,
    page?: { startAfter?: string; after?: string; done: boolean; threads: string[]; moreThreads?: boolean },
  ): Promise<{ ok: true; after?: string; done: boolean } | { ok: false }> {
    const identities = page?.threads.map(() => crypto.randomUUID()) ?? [];
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "importPrimaryPlacements");
      if (
        !replicaMaintenanceFence(
          await txn.get(DRAIN_KEY),
          await txn.list({ prefix: DEPLOY_ADMISSION_KEY_PREFIX }),
          admissionId,
          systemClock(),
          fence,
        )
      )
        return { ok: false };
      const record = await txn.get<ResidentRecord>(registryKey(resource));
      const pool = record && residentPoolOf(record);
      if (!pool || pool.revision !== revision) return { ok: false };
      const key = `replica-import:${resource}`;
      const saved = await txn.get<{ revision: string; fence: ReplicaMaintenanceFence; after?: string; done: boolean }>(
        key,
      );
      const sameFence =
        saved?.fence &&
        saved.fence.since === fence.since &&
        saved.fence.until === fence.until &&
        saved.fence.swapVersion === fence.swapVersion &&
        saved.fence.swapAt === fence.swapAt;
      const progress = saved?.revision === revision && sameFence ? saved : { revision, fence, done: false };
      if (typeof progress.done !== "boolean" || (progress.after !== undefined && typeof progress.after !== "string"))
        return { ok: false };
      if (progress.done && pool.active !== pool.members.length) return { ok: false };
      if (!page) return { ok: true, ...progress };
      if (page.startAfter !== progress.after || progress.done) return { ok: false };
      if (
        page.threads.length > 256 ||
        (page.moreThreads !== undefined && typeof page.moreThreads !== "boolean") ||
        (page.moreThreads === true && page.threads.length === 0) ||
        (page.after !== undefined &&
          (typeof page.after !== "string" ||
            (progress.after !== undefined &&
              page.after <= progress.after &&
              !(page.done && page.threads.length === 0 && page.after === progress.after)))) ||
        (!page.done && !page.after)
      )
        return { ok: false };
      for (const [i, threadKey] of page.threads.entries()) {
        if (!THREAD_KEY_RE.test(threadKey)) throw new Error("replica import thread is invalid");
        const placed = await recordResidentPlacement(txn, {
          schema: 1,
          resource,
          threadKey,
          residentId: resource,
          placementId: identities[i],
        });
        if (!placed.ok || placed.placement.residentId !== resource)
          throw new Error("replica import conflicts with saved placement");
      }
      // A legacy ownership row can expand beyond one transaction's thread limit.
      // Replay its source page after a lost chunk reply; only the final chunk moves the cursor.
      if (page.moreThreads === true) return { ok: true, ...progress, done: false };
      const next = { revision, fence, ...(page.after ? { after: page.after } : {}), done: page.done };
      await txn.put(key, next);
      if (page.done)
        await txn.put(registryKey(resource), { ...record, pool: { ...pool, active: pool.members.length } });
      return { ok: true, ...next };
    });
  }

  async listRepositories(): Promise<ResidentRecord[]> {
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
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "updateConfig");
      if ((await this.getStagingMaintenance(txn))?.state === "held")
        throw new Error("staging maintenance blocks configuration changes");
      const key = registryKey(resource);
      const record = await txn.get<ResidentRecord>(key);
      if (!record) return null;
      const updated: ResidentRecord = { ...record, updatedAt: new Date(systemClock()).toISOString() };
      if (patch.commands !== undefined) updated.commands = patch.commands;
      if (patch.effects !== undefined) updated.effects = patch.effects;
      if (patch.defaultRef !== undefined) updated.defaultRef = patch.defaultRef;
      if (patch.diskBudgetMb !== undefined) updated.diskBudgetMb = patch.diskBudgetMb;
      if (patch.provisioningTimeoutMs !== undefined) updated.provisioningTimeoutMs = patch.provisioningTimeoutMs;
      if (patch.worktreeTtlDays !== undefined) updated.worktreeTtlDays = patch.worktreeTtlDays;
      await txn.put(key, updated);
      return updated;
    });
  }

  async remove(resource: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "remove");
      return txn.delete(registryKey(resource));
    });
  }

  async beginPoolOffboard(resource: string, revision: string): Promise<ResidentRecord | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "beginPoolOffboard");
      const record = await txn.get<ResidentRecord>(registryKey(resource));
      if (!record?.pool || record.pool.revision !== revision) return undefined;
      const held = { ...record, offboarding: true as const };
      await txn.put(registryKey(resource), held);
      return held;
    });
  }

  /** Called only after all active members confirm teardown. Pending members
   * never started. Keep the registration closed until every placement page is removed. */
  async finishPoolOffboard(resource: string, revision: string): Promise<boolean> {
    for (;;) {
      const result = await this.ctx.storage.transaction(async (txn) => {
        await assertRepositorySettingsWritable(txn, "finishPoolOffboard");
        const record = await txn.get<ResidentRecord>(registryKey(resource));
        if (!record?.offboarding || record.pool?.revision !== revision) return "refused";
        const pool = residentPoolOf(record)!;
        if (pool.members.slice(0, pool.active).some((id) => !pool.removed?.[id])) return "refused";
        const placements = await txn.list({ prefix: `placement:[${JSON.stringify(resource)},`, limit: 128 });
        if (placements.size) {
          await txn.delete([...placements.keys()]);
          return "more";
        }
        await txn.delete([registryKey(resource), `replica-import:${resource}`, `replica-cursor:${resource}`]);
        return "done";
      });
      if (result !== "more") return result === "done";
    }
  }

  async recordPoolRemoval(
    resource: string,
    revision: string,
    residentId: string,
    receipt: { backupObjectsDeleted: number; r2ObjectsDeleted: number },
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      await assertRepositorySettingsWritable(txn, "recordPoolRemoval");
      const record = await txn.get<ResidentRecord>(registryKey(resource));
      const pool = record && residentPoolOf(record);
      if (
        !record?.offboarding ||
        !pool ||
        pool.revision !== revision ||
        !pool.members.slice(0, pool.active).includes(residentId)
      )
        return false;
      const next = { ...record, pool: { ...pool, removed: { ...pool.removed, [residentId]: receipt } } };
      residentPoolOf(next);
      await txn.put(registryKey(resource), next);
      return true;
    });
  }

  /** The stored drain record as it is — `liveDrain` (drain.ts) decides at the
   *  caller's clock whether it is in force; the registry keeps no clock of its
   *  own so an expired record is read the same by every route. */
  async getDrain(): Promise<unknown> {
    return (await this.ctx.storage.get(DRAIN_KEY)) ?? null;
  }

  /** A durable permit closes the gap between an admitted call and the
   * resident's in-memory counters. The swap fence and permit use the same
   * registry transaction boundary. An orphaned permit refuses deployment. */
  async beginDeployAdmission(origin?: unknown, identity?: DeployAdmissionIdentity): Promise<string | null> {
    if (identity !== undefined && !validDeployAdmissionIdentity(identity))
      throw new Error("deploy-admission-identity-invalid");
    const admitted = await this.ctx.storage.transaction(async (txn) => {
      if ((await this.getStagingMaintenance(txn))?.state === "held") return null;
      if (liveDrain(await txn.get(DRAIN_KEY), systemClock())?.swapFence) return null;
      const id = identity?.id ?? crypto.randomUUID();
      if (
        (await txn.get(`${DEPLOY_RECOVERY_KEY_PREFIX}${id}`)) !== undefined ||
        (await txn.get(`${DEPLOY_ABANDONED_KEY_PREFIX}${id}`)) !== undefined
      )
        throw new Error("deploy-admission-identity-used-or-unverified");
      if (identity) {
        const receipts = (await txn.get(DEPLOY_RELEASE_RECEIPTS_KEY)) ?? [];
        if (
          !validDeployReleaseReceipts(receipts) ||
          (await txn.get(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`)) !== undefined ||
          receipts.some((row) => row.id === id)
        )
          throw new Error("deploy-admission-identity-used-or-unverified");
      }
      const record = {
        schema: 1,
        startedAt: systemClock(),
        ...deployAdmissionOrigin(origin),
        ...(identity ? { requestHash: identity.requestHash } : {}),
      };
      await txn.put(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`, record);
      return { id, record };
    });
    // Emit only after the original commit acknowledgement, outside its retryable body.
    if (admitted)
      emitDeployAdmission({ phase: "admitted", id: admitted.id, observedAt: systemClock(), ...admitted.record });
    return admitted?.id ?? null;
  }

  /** Old-version reconciliation must enter before the fence read; a new
   * Worker version may reconcile the uploaded image while the fence stands. */
  async beginDeployReconcileAdmission(
    versionId: string | null,
    versionTimestamp: string | null,
    identity?: DeployAdmissionIdentity,
    attempt?: unknown,
    origin?: unknown,
  ): Promise<string | null> {
    if (identity !== undefined && !validDeployAdmissionIdentity(identity))
      throw new Error("deploy-admission-identity-invalid");
    const admitted = await this.ctx.storage.transaction(async (txn) => {
      const held = await this.getStagingMaintenance(txn);
      if (
        held?.state === "held" &&
        (!selectedStagingAttempt(held, attempt, systemClock()) || held.policy.attempt.sourceCommit !== BUILD.commit)
      )
        return null;
      const record = liveDrain(await txn.get(DRAIN_KEY), systemClock());
      if (record?.swapFence && !postUploadVersion(record, versionId, versionTimestamp)) return null;
      const id = identity?.id ?? crypto.randomUUID();
      if (
        (await txn.get(`${DEPLOY_RECOVERY_KEY_PREFIX}${id}`)) !== undefined ||
        (await txn.get(`${DEPLOY_ABANDONED_KEY_PREFIX}${id}`)) !== undefined
      )
        throw new Error("deploy-admission-identity-used-or-unverified");
      if (identity) {
        const receipts = (await txn.get(DEPLOY_RELEASE_RECEIPTS_KEY)) ?? [];
        if (
          !validDeployReleaseReceipts(receipts) ||
          (await txn.get(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`)) !== undefined ||
          receipts.some((row) => row.id === id)
        )
          throw new Error("deploy-admission-identity-used-or-unverified");
      }
      const permit = {
        schema: 1,
        ...(identity ? { requestHash: identity.requestHash } : {}),
        startedAt: systemClock(),
        ...deployAdmissionOrigin({
          ...(origin && typeof origin === "object" ? origin : {}),
          kind: "reconcile",
          component: "http",
          build: BUILD_ID,
          workerVersion: versionId,
        }),
      };
      await txn.put(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`, permit);
      return { id, record: permit };
    });
    if (admitted)
      emitDeployAdmission({ phase: "admitted", id: admitted.id, observedAt: systemClock(), ...admitted.record });
    return admitted?.id ?? null;
  }

  async endDeployAdmission(id: string, requestHash?: string): Promise<void> {
    try {
      const deleted = await this.ctx.storage.transaction(async (txn) => {
        const key = `${DEPLOY_ADMISSION_KEY_PREFIX}${id}`;
        const row = await txn.get<{ schema?: number; startedAt?: number; requestHash?: string }>(key);
        if ((await txn.get(`${DEPLOY_ABANDONED_KEY_PREFIX}${id}`)) !== undefined)
          throw new Error("deploy-release-abandoned-request-held");
        if (requestHash !== undefined) {
          const identity = { id, requestHash };
          if (!validDeployAdmissionIdentity(identity)) throw new Error("deploy-release-identity-invalid");
          const receipts = (await txn.get(DEPLOY_RELEASE_RECEIPTS_KEY)) ?? [];
          if (!validDeployReleaseReceipts(receipts)) throw new Error("deploy-release-receipts-unverified");
          if (row === undefined) {
            if (receipts.some((receipt) => receipt.id === id && receipt.requestHash === requestHash)) return false;
            throw new Error("deploy-release-unverified");
          }
          if (
            row?.schema !== 1 ||
            row.requestHash !== requestHash ||
            !Number.isSafeInteger(row.startedAt) ||
            Number(row.startedAt) < 0
          )
            throw new Error("deploy-release-identity-mismatch");
          const retained = [
            ...receipts.slice(-127),
            {
              id,
              requestHash,
              startedAt: row.startedAt,
              releasedAt: systemClock(),
              ...(deployAdmissionOrigin(row).callId
                ? { origin: deployAdmissionOrigin(row), originalRecordSha256: await admissionRecordHash(row) }
                : {}),
            },
          ];
          while (new TextEncoder().encode(JSON.stringify(retained)).byteLength > DEPLOY_RELEASE_RECEIPT_BYTES)
            retained.shift();
          await txn.put(DEPLOY_RELEASE_RECEIPTS_KEY, retained);
        } else if (row && Object.hasOwn(row, "requestHash")) throw new Error("deploy-release-identity-required");
        return txn.delete(key);
      });
      emitDeployAdmission({
        phase: "permit-release",
        id,
        observedAt: systemClock(),
        commit: deleted ? "acknowledged" : "already-absent",
        nativeOutcome: "unverified",
      });
    } catch (error) {
      emitDeployAdmission({
        phase: "permit-release",
        id,
        observedAt: systemClock(),
        commit: "unverified",
        failure: "storage",
        nativeOutcome: "unverified",
      });
      throw error;
    }
  }

  /** Exact storage read, never a recovery or a native process observation. */
  async readDeployAdmissionReceipt(identity: DeployAdmissionIdentity) {
    const unknown = { state: "unknown" as const };
    if (!validDeployAdmissionIdentity(identity)) return unknown;
    return this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(`${DEPLOY_ABANDONED_KEY_PREFIX}${identity.id}`)) !== undefined) return unknown;
      const row = await txn.get<{ schema?: number; startedAt?: number; requestHash?: string }>(
        `${DEPLOY_ADMISSION_KEY_PREFIX}${identity.id}`,
      );
      if (row !== undefined)
        return row?.schema === 1 &&
          row.requestHash === identity.requestHash &&
          Number.isSafeInteger(row.startedAt) &&
          Number(row.startedAt) >= 0
          ? { state: "admitted" as const, ...identity, startedAt: row.startedAt }
          : unknown;
      const receipts = (await txn.get(DEPLOY_RELEASE_RECEIPTS_KEY)) ?? [];
      if (!validDeployReleaseReceipts(receipts)) return unknown;
      const receipt = receipts.find((row) => row.id === identity.id && row.requestHash === identity.requestHash);
      return receipt ? { state: "released" as const, ...receipt, nativeOutcome: "unverified" as const } : unknown;
    });
  }

  /** Annotation runs after admission. It never resurrects a released permit. */
  async recordDeployAdmissionResource(id: string, resource: unknown): Promise<void> {
    const safe = deployAdmissionOrigin({ resource }).resource;
    if (!safe) return;
    try {
      const recorded = await this.ctx.storage.transaction(async (txn) => {
        if ((await txn.get(`${DEPLOY_ABANDONED_KEY_PREFIX}${id}`)) !== undefined) return false;
        const key = `${DEPLOY_ADMISSION_KEY_PREFIX}${id}`;
        const row = await txn.get<{ schema?: number; startedAt?: number }>(key);
        if (row?.schema !== 1) return false;
        await txn.put(key, { ...row, resource: safe });
        return true;
      });
      if (recorded) emitDeployAdmission({ phase: "origin-recorded", id, observedAt: systemClock(), resource: safe });
    } catch {
      emitDeployAdmission({ phase: "origin-unverified", id, observedAt: systemClock(), failure: "storage" });
    }
  }

  /** Metadata only. A bounded projection is separate from the gate's count. */
  async getDeployAdmissionReadback() {
    const stored = await this.ctx.storage.list<{ schema?: number; startedAt?: number; kind?: string }>({
      prefix: DEPLOY_ADMISSION_KEY_PREFIX,
    });
    const rows = [...stored].slice(0, 25).map(([key, row]) => ({
      id: key.slice(DEPLOY_ADMISSION_KEY_PREFIX.length),
      startedAt: Number.isSafeInteger(row?.startedAt) && Number(row.startedAt) >= 0 ? row.startedAt : null,
      ...(row?.schema === 1
        ? { schema: 1, ...deployAdmissionOrigin(row) }
        : { kind: "unknown", ...(row?.schema === undefined ? {} : { schema: 0 }) }),
    }));
    return {
      schema: 1,
      observedAt: systemClock(),
      observedActiveCount: stored.size,
      omittedCount: stored.size - rows.length,
      rows,
    };
  }

  async activeDeployAdmissions(): Promise<number> {
    return this.ctx.storage.transaction(async (txn) => (await this.getDeployObligations(txn)).blocking);
  }

  async listDeployAdmissions(): Promise<Array<{ id: string; startedAt: number; kind: string }>> {
    const rows = await this.ctx.storage.list<{ startedAt?: number; kind?: string }>({
      prefix: DEPLOY_ADMISSION_KEY_PREFIX,
    });
    return [...rows].map(([key, value]) => ({
      id: key.slice(DEPLOY_ADMISSION_KEY_PREFIX.length),
      startedAt: typeof value?.startedAt === "number" ? value.startedAt : 0,
      kind: typeof value?.kind === "string" ? value.kind : "unknown",
    }));
  }

  async getDeployAdmissionRecoveryQuote(id: string): Promise<AdmissionRecoveryQuote | null> {
    const record = await this.ctx.storage.get(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`);
    const recordSha256 = await admissionRecordHash(record);
    return recordSha256 === null ? null : recoveryQuote((record as { startedAt: number }).startedAt, recordSha256);
  }

  async getOperatorAbandonmentQuote(id: string) {
    return this.ctx.storage.transaction(async (txn) => {
      if ((await this.getStagingMaintenance(txn))?.state === "held") return null;
      return quoteOperatorAdmission(
        txn,
        id,
        { build: BUILD_ID, workerVersion: workerVersionId(this.env) },
        systemClock(),
      );
    });
  }

  async operatorAbandonDeployAdmission(input: unknown, authoritySha256: string) {
    const committed = await this.ctx.storage.transaction(async (txn) => {
      if ((await this.getStagingMaintenance(txn))?.state === "held") return null;
      return abandonOperatorAdmission(
        txn,
        input,
        { build: BUILD_ID, workerVersion: workerVersionId(this.env) },
        authoritySha256,
        systemClock,
      );
    });
    if (committed)
      emitDeployAdmission({
        phase: "operator-abandonment-commit",
        id: committed.request.id,
        operationId: committed.request.operationId,
        decidedAt: committed.decidedAt,
        requestEnd: "unobserved",
        nativeOutcome: "unverified",
        commit: "acknowledged",
      });
    return committed;
  }

  async readOperatorAbandonment(id: string, operationId: string, requestSha256?: string) {
    return this.ctx.storage.transaction((txn) => readOperatorAbandonment(txn, id, operationId, requestSha256));
  }

  /** Legacy callers have no observed-record contract. Keep their RPC closed
   * during mixed-version rollout instead of accepting ignored extra arguments. */
  async recoverDeployAdmission(): Promise<false> {
    return false;
  }

  /** Delete one observed permit only while this recovery's fence still stands. The
   * handler checks independent resident and process evidence before calling. */
  async recoverQuotedDeployAdmission(
    id: string,
    since: string,
    until: string,
    versionId: string,
    evidenceHash: string,
    expected: AdmissionRecoveryQuote,
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (hasFenceAcquisition(await txn.get(DRAIN_KEY))) return false;
      const now = systemClock();
      const fence = liveDrain(await txn.get(DRAIN_KEY), now);
      if (!fence?.swapFence || fence.since !== since || fence.until !== until || fence.swapVersion !== versionId)
        return false;
      const key = `${DEPLOY_ADMISSION_KEY_PREFIX}${id}`;
      const originalRecord = await txn.get(key);
      if (
        !recoveryQuote(expected?.startedAt, expected?.recordSha256) ||
        now < expected.startedAt ||
        !/^[0-9a-f]{64}$/.test(evidenceHash) ||
        (originalRecord as { startedAt?: number } | undefined)?.startedAt !== expected.startedAt ||
        (await admissionRecordHash(originalRecord)) !== expected.recordSha256 ||
        (await txn.get(`${DEPLOY_RECOVERY_KEY_PREFIX}${id}`)) !== undefined
      )
        return false;
      await txn.put(`${DEPLOY_RECOVERY_KEY_PREFIX}${id}`, {
        schema: 1,
        id,
        disposition: "request-ended",
        requestEnd: "operator-attested",
        nativeOutcome: "unverified",
        independentObligations: "unchanged",
        originalRecord,
        originalRecordSha256: expected.recordSha256,
        recoveredAt: now,
        evidenceHash,
        fence: { since, until, versionId },
      });
      await txn.delete(key);
      return true;
    });
  }

  /** Read the original committed disposition, never repeat recovery. */
  async readDeployAdmissionRecoveryReceipt(
    id: string,
    since: string,
    until: string,
    versionId: string,
    evidenceHash: string,
    expected: AdmissionRecoveryQuote,
  ): Promise<boolean> {
    if (!recoveryQuote(expected?.startedAt, expected?.recordSha256) || !/^[0-9a-f]{64}$/.test(evidenceHash))
      return false;
    return this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(`${DEPLOY_ADMISSION_KEY_PREFIX}${id}`)) !== undefined) return false;
      const audit = await txn.get<{
        schema?: number;
        id?: string;
        disposition?: string;
        requestEnd?: string;
        nativeOutcome?: string;
        independentObligations?: string;
        originalRecord?: { startedAt?: number };
        originalRecordSha256?: string;
        recoveredAt?: number;
        evidenceHash?: string;
        fence?: { since?: string; until?: string; versionId?: string };
      }>(`${DEPLOY_RECOVERY_KEY_PREFIX}${id}`);
      return (
        audit?.schema === 1 &&
        audit.id === id &&
        audit.disposition === "request-ended" &&
        audit.requestEnd === "operator-attested" &&
        audit.nativeOutcome === "unverified" &&
        audit.independentObligations === "unchanged" &&
        audit.originalRecord?.startedAt === expected.startedAt &&
        audit.originalRecordSha256 === expected.recordSha256 &&
        (await admissionRecordHash(audit.originalRecord)) === expected.recordSha256 &&
        Number.isSafeInteger(audit.recoveredAt) &&
        Number(audit.recoveredAt) >= expected.startedAt &&
        audit.evidenceHash === evidenceHash &&
        audit.fence?.since === since &&
        audit.fence.until === until &&
        audit.fence.versionId === versionId
      );
    });
  }

  /** The last pre-upload read is one registry transaction: an admitted call,
   * replaced drain, or expiring fence makes the answer fail closed. */
  private async deployFenceVerified(
    txn: Pick<DurableObjectStorage, "get" | "list">,
    since: string,
    until: string,
    versionId: string | null,
  ): Promise<boolean> {
    const now = systemClock();
    const current = liveDrain(await txn.get(DRAIN_KEY), now);
    const active = await this.getDeployObligations(txn);
    const maintenance = await this.getStagingMaintenance(txn);
    return (
      deployFenceReady(current, now) &&
      current?.since === since &&
      current.until === until &&
      current.swapVersion === versionId &&
      active.blocking === 0 &&
      (maintenance?.state !== "held" || active.qualified)
    );
  }

  async verifyDeployFence(since: string, until: string, versionId: string | null): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (hasFenceAcquisition(await txn.get(DRAIN_KEY))) return false;
      return this.deployFenceVerified(txn, since, until, versionId);
    });
  }

  /** Admin-only by construction (reached solely via POST /drain): replaces
   *  whatever drain stood — a second deploy's drain extends the first's. The
   *  set posts `above` for the plane (record 0064) and arms ONE alarm at
   *  `until`, so a drain nobody lifts posts its expiry itself. */
  async setDrain(record: DrainRecord, attempt?: unknown): Promise<DrainRecord | null> {
    const stored = await this.ctx.storage.transaction(async (txn) => {
      const now = systemClock();
      const original = await txn.get(DRAIN_KEY);
      const current = liveDrain(original, now);
      if (current && hasFenceAcquisition(original)) return false;
      const held = await this.getStagingMaintenance(txn);
      if (held?.state === "held") {
        if (!selectedStagingAttempt(held, attempt, now)) return false;
        record = {
          ...record,
          until: new Date(Math.min(Date.parse(record.until), held.policy.attempt.deadline)).toISOString(),
        };
        const raw = await txn.get(stagingEpisodeKeys(held?.policy).window);
        if (raw !== undefined) {
          const window = releaseWindowSchema.safeParse(raw);
          const counts = await this.getDeployObligations(txn);
          if (
            !window.success ||
            window.data.state !== "authorized" ||
            !counts.qualified ||
            current?.since !== window.data.drain.since ||
            current.until !== window.data.drain.until ||
            current.swapVersion !== window.data.drain.versionId
          )
            return false;
          await txn.put(stagingEpisodeKeys(held?.policy).window, {
            ...window.data,
            state: "claimed",
            drain: { ...window.data.drain, since: record.since, until: record.until },
          });
        } else if (current?.swapFence) return false;
      } else if (current?.swapFence) return false;
      await txn.put(DRAIN_KEY, record);
      return true;
    });
    if (!stored) return null;
    await this.pushDrainPost("above");
    await this.ctx.storage.setAlarm(Date.parse(record.until));
    return record;
  }

  /** Close the reattach exception before reading deploy activity. The same
   * durable drain survives the Worker isolate swap and expires by itself. */
  private async installDeployFence(
    txn: DurableObjectTransaction,
    versionId: string | null,
    attempt?: unknown,
  ): Promise<DrainRecord | null> {
    if (!versionId) return null;
    const now = systemClock();
    const held = await this.getStagingMaintenance(txn);
    if (held?.state === "held" && !selectedStagingAttempt(held, attempt, now)) return null;
    const original = await txn.get(DRAIN_KEY);
    const record = liveDrain(original, now);
    if (record === null || record.swapFence || hasFenceAcquisition(original)) return null;
    const fenced = {
      ...record,
      swapFence: true,
      swapBuild: BUILD_ID,
      swapVersion: versionId,
      swapAt: new Date(now).toISOString(),
    } as const;
    if (!deployFenceReady(fenced, now)) return null;
    if (held?.state === "held") {
      const raw = await txn.get(stagingEpisodeKeys(held?.policy).window);
      if (raw !== undefined) {
        const window = releaseWindowSchema.safeParse(raw);
        const counts = await this.getDeployObligations(txn);
        if (!window.success || window.data.state !== "claimed" || !counts.qualified) return null;
        await txn.put(stagingEpisodeKeys(held?.policy).window, {
          ...window.data,
          state: "fenced",
          drain: { since: fenced.since, until: fenced.until, versionId },
        });
      }
    }
    await txn.put(DRAIN_KEY, fenced);
    return fenced;
  }

  async setDeployFence(versionId: string | null, attempt?: unknown): Promise<DrainRecord | null> {
    return this.ctx.storage.transaction((txn) => this.installDeployFence(txn, versionId, attempt));
  }

  /** A distinct RPC makes an older Registry refuse before its first write. */
  async prepareDeployFenceAcquisition(
    id: string,
    versionId: string | null,
    producerBuild: string,
  ): Promise<FenceAcquisition | null> {
    return this.ctx.storage.transaction(async (txn) => {
      if (
        !validFenceAcquisitionId(id) ||
        !validFenceAcquisitionId(versionId) ||
        versionId !== workerVersionId(this.env) ||
        producerBuild !== BUILD_ID ||
        (await txn.get(FENCE_ACQUISITION_PREFIX + id)) !== undefined ||
        (await this.getStagingMaintenance(txn))?.state === "held"
      )
        return null;
      const originalDrain = ordinaryAcquisitionDrain(await txn.get(DRAIN_KEY));
      if (!originalDrain) return null;
      const installed = await this.installDeployFence(txn, versionId);
      if (!installed) return null;
      const fencedRecord = { ...installed, swapAcquisitionId: id };
      const prepared = fenceAcquisitionOf({
        schema: 1,
        purpose: "deploy-fence-acquisition",
        id,
        workerVersion: versionId,
        build: BUILD_ID,
        phase: "preparing",
        originalDrain,
        fencedRecord,
      });
      // The shared installer already wrote within this transaction. Roll it
      // back instead of leaving an untracked fence after a schema refusal.
      if (!prepared) throw new Error("deploy-fence-acquisition-invalid");
      await txn.put(DRAIN_KEY, fencedRecord);
      await txn.put(FENCE_ACQUISITION_PREFIX + id, prepared);
      return prepared;
    });
  }

  async sealDeployFenceAcquisition(
    id: string,
    versionId: string | null,
    producerBuild: string,
  ): Promise<FenceAcquisition | null> {
    return this.ctx.storage.transaction(async (txn) => {
      if (
        !validFenceAcquisitionId(id) ||
        versionId !== workerVersionId(this.env) ||
        producerBuild !== BUILD_ID ||
        (await this.getStagingMaintenance(txn))?.state === "held"
      )
        return null;
      const current = fenceAcquisitionOf(await txn.get(FENCE_ACQUISITION_PREFIX + id));
      if (
        current?.id !== id ||
        current.phase !== "preparing" ||
        !ownsAcquisitionFence(current, await txn.get(DRAIN_KEY), workerVersionId(this.env), BUILD_ID) ||
        !(await this.deployFenceVerified(txn, current.fencedRecord.since, current.fencedRecord.until, versionId))
      )
        return null;
      const sealed: FenceAcquisition = { ...current, phase: "sealed" };
      await txn.put(FENCE_ACQUISITION_PREFIX + id, sealed);
      return sealed;
    });
  }

  async abandonDeployFenceAcquisition(
    id: string,
    versionId: string | null,
    producerBuild: string,
  ): Promise<FenceAcquisition | null> {
    return this.ctx.storage.transaction(async (txn) => {
      if (!validFenceAcquisitionId(id)) return null;
      const raw = await txn.get(FENCE_ACQUISITION_PREFIX + id);
      const current = fenceAcquisitionOf(raw);
      if (current?.id === id && current.phase === "abandoned") return current;
      if (
        !validFenceAcquisitionId(versionId) ||
        versionId !== workerVersionId(this.env) ||
        producerBuild !== BUILD_ID ||
        (raw !== undefined && !current) ||
        (current &&
          (current.id !== id ||
            current.phase !== "preparing" ||
            !ownsAcquisitionFence(current, await txn.get(DRAIN_KEY), workerVersionId(this.env), BUILD_ID)))
      )
        return null;
      const abandoned = fenceAcquisitionOf(
        current
          ? { ...current, phase: "abandoned", disposition: "fence-withdrawn" }
          : {
              schema: 1,
              purpose: "deploy-fence-acquisition",
              id,
              workerVersion: versionId,
              build: BUILD_ID,
              phase: "abandoned",
              disposition: "cancelled-before-install",
            },
      );
      if (!abandoned) return null;
      if (current?.phase === "preparing") await txn.put(DRAIN_KEY, current.originalDrain);
      await txn.put(FENCE_ACQUISITION_PREFIX + id, abandoned);
      return abandoned;
    });
  }

  async readDeployFenceAcquisition(id: string): Promise<FenceAcquisition | null> {
    if (!validFenceAcquisitionId(id)) return null;
    const current = fenceAcquisitionOf(await this.ctx.storage.get(FENCE_ACQUISITION_PREFIX + id));
    return current?.id === id ? current : null;
  }

  /** A refused preflight reopens owned reattach, but cannot clear a newer
   * deployment's drain. */
  async clearDeployFence(since: string, until: string, versionId: string | null): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const original = await txn.get(DRAIN_KEY);
      if (hasFenceAcquisition(original)) return;
      const record = liveDrain(original, systemClock());
      if (record?.since !== since || record.until !== until || !record.swapFence || record.swapVersion !== versionId)
        return;
      const { swapFence: _fence, swapBuild: _build, swapVersion: _version, swapAt: _at, ...rest } = record;
      await txn.put(DRAIN_KEY, rest);
    });
  }

  /** Quote the whole original record. A caller's copy cannot identify the current producer. */
  async getDeployFenceRecoveryQuote(
    versionId: string | null,
    store: Pick<DurableObjectStorage, "get" | "list"> = this.ctx.storage,
  ) {
    if (!versionId || workerVersionId(this.env) !== versionId) return null;
    const original = await store.get<unknown>(DRAIN_KEY);
    if (
      !original ||
      typeof original !== "object" ||
      Array.isArray(original) ||
      Object.keys(original).some(
        (key) =>
          ![
            "since",
            "until",
            "by",
            "reason",
            "swapFence",
            "swapBuild",
            "swapVersion",
            "swapAt",
            "swapAcquisitionId",
          ].includes(key),
      )
    )
      return null;
    if (hasFenceAcquisition(original)) {
      const id = (original as Record<string, unknown>).swapAcquisitionId;
      if (!validFenceAcquisitionId(id)) return null;
      const acquisition = fenceAcquisitionOf(await store.get(FENCE_ACQUISITION_PREFIX + id));
      if (
        acquisition?.id !== id ||
        acquisition.phase !== "sealed" ||
        !ownsAcquisitionFence(acquisition, original, workerVersionId(this.env), BUILD_ID)
      )
        return null;
    }
    const record = liveDrain(original, systemClock());
    if (
      record?.swapFence !== true ||
      record.swapVersion !== versionId ||
      !record.swapAt ||
      !Number.isFinite(Date.parse(record.swapAt)) ||
      !Number.isFinite(Date.parse(record.since)) ||
      Date.parse(record.since) > Date.parse(record.swapAt) ||
      Date.parse(record.swapAt) > systemClock() ||
      JSON.stringify(original).length > 4096
    )
      return null;
    return {
      recordSha256: await stagingEvidenceSha256(original),
      registrySha256: await stagingEvidenceSha256(
        [...(await store.list({ prefix: REGISTRY_KEY_PREFIX })).entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
      since: record.since,
      until: record.until,
      swapAt: record.swapAt,
      workerVersion: versionId,
    };
  }

  /** An operator can release an abandoned fence, but cannot erase the drain or any work record. */
  async releaseDeployFence(
    recordSha256: string,
    versionId: string,
    evidenceSha256: string,
    registrySha256: string,
  ): Promise<boolean> {
    if (![recordSha256, evidenceSha256, registrySha256].every((value) => /^[a-f0-9]{64}$/.test(value))) return false;
    return this.ctx.storage.transaction(async (txn) => {
      if ((await this.getStagingMaintenance(txn))?.state === "held") return false;
      if ((await this.getDeployObligations(txn)).stored !== 0) return false;
      const quote = await this.getDeployFenceRecoveryQuote(versionId, txn);
      if (!quote || quote.recordSha256 !== recordSha256 || quote.registrySha256 !== registrySha256) return false;
      const key = `${DEPLOY_FENCE_RELEASE_KEY_PREFIX}${recordSha256}`;
      if (await txn.get(key)) return false;
      const originalRecord = await txn.get<DrainRecord>(DRAIN_KEY);
      if (!originalRecord) return false;
      const {
        swapFence: _fence,
        swapBuild: _build,
        swapVersion: _version,
        swapAt: _at,
        swapAcquisitionId: _acquisition,
        ...drain
      } = originalRecord;
      await txn.put(key, {
        schema: 1,
        originalRecordSha256: recordSha256,
        originalRecord,
        workerVersion: versionId,
        evidenceSha256,
        registrySha256,
        releasedAt: systemClock(),
        requestEnd: "operator-attested",
        nativeOutcome: "operator-attested-unchanged",
        drainRetained: true,
      });
      await txn.put(DRAIN_KEY, drain);
      return true;
    });
  }

  async readDeployFenceReleaseReceipt(recordSha256: string): Promise<DeployFenceReleaseReceipt | null> {
    if (!/^[a-f0-9]{64}$/.test(recordSha256)) return null;
    const receipt = await this.ctx.storage.get<DeployFenceReleaseReceipt>(
      `${DEPLOY_FENCE_RELEASE_KEY_PREFIX}${recordSha256}`,
    );
    if (
      receipt?.schema !== 1 ||
      receipt.originalRecordSha256 !== recordSha256 ||
      receipt.drainRetained !== true ||
      receipt.requestEnd !== "operator-attested" ||
      receipt.nativeOutcome !== "operator-attested-unchanged" ||
      typeof receipt.workerVersion !== "string" ||
      receipt.workerVersion !== receipt.originalRecord?.swapVersion ||
      typeof receipt.evidenceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256) ||
      !/^[a-f0-9]{64}$/.test(receipt.registrySha256) ||
      !Number.isSafeInteger(receipt.releasedAt) ||
      (await stagingEvidenceSha256(receipt.originalRecord)) !== recordSha256
    )
      return null;
    return receipt;
  }

  /** Admin-only by construction (POST /undrain): `cleared` when a record was
   *  there and was lifted — a cleared drain posts `below`, the plane's
   *  resident-drain window lifts. With holds outstanding (issue 1931: a
   *  container still to report the deploy's image) the fleet STAYS closed:
   *  the record stands with `liftAsked` and the last container's report lifts
   *  it (`reportContainerImageCurrent`); `until` remains the backstop. */
  async clearDrain(
    versionId: string | null,
    versionTimestamp: string | null,
  ): Promise<{ cleared: boolean; held: string[]; error?: string }> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      if ((await this.getStagingMaintenance(txn))?.state === "held")
        return { cleared: false, held: [], error: "staging maintenance requires explicit release" };
      const record = liveDrain(await txn.get(DRAIN_KEY), systemClock());
      if (record?.swapFence && !postUploadVersion(record, versionId, versionTimestamp))
        return { cleared: false, held: [], error: "deploy-fence: the pre-upload Worker cannot reopen the fleet" };
      if (record?.swapFence && (await this.getDeployObligations(txn)).blocking > 0)
        return { cleared: false, held: [], error: "deploy-fence: admitted work has not settled" };
      if (record !== null) {
        const lift = liftDrain(record);
        if (!lift.cleared) {
          await txn.put(DRAIN_KEY, lift.record);
          return { cleared: false, held: lift.record.holds ?? [] };
        }
      }
      return { cleared: await txn.delete(DRAIN_KEY), held: [] };
    });
    if (result.cleared) await this.pushDrainPost("below");
    return result;
  }

  /** The deploy's reconcile could not verify these residents' containers on
   *  the new image (issue 1931): hold the drain for each — the fleet must not
   *  reopen onto them until they report. No live drain, nothing to hold. */
  async holdDrainFor(resources: string[]): Promise<void> {
    if (resources.length === 0) return;
    const held = await this.ctx.storage.transaction(async (txn) => {
      const now = systemClock();
      const record = liveDrain(await txn.get(DRAIN_KEY), now);
      if (record === null) return null;
      const next = holdDrain(record, resources, now);
      await txn.put(DRAIN_KEY, next);
      return next;
    });
    // The hold's liveness alarm (issue 2044): the cycle bound is the earlier
    // end, so the alarm fires there — reopening the fleet with the stale
    // containers named — instead of at `until`, the last resort.
    if (held?.holdsUntil !== undefined) await this.ctx.storage.setAlarm(Date.parse(held.holdsUntil));
  }

  /** One resident's word that its running container is on the deploy's image:
   *  its hold drops, and when it was the last hold of a lift already asked the
   *  drain lifts here — the reopen fires on the last container's report. */
  async reportContainerImageCurrent(resource: string): Promise<{ lifted: boolean }> {
    const lifted = await this.ctx.storage.transaction(async (txn) => {
      const maintenance = await this.getStagingMaintenance(txn);
      const record = liveDrain(await txn.get(DRAIN_KEY), systemClock());
      if (record === null) return false;
      const report = reportImageCurrent(record, resource);
      if (report.record === null) {
        if (maintenance?.state === "held") return false;
        return txn.delete(DRAIN_KEY);
      }
      await txn.put(DRAIN_KEY, report.record);
      return false;
    });
    if (lifted) {
      await this.pushDrainPost("below");
      console.log(`[drain] fleet reopened — ${resource} was the last container to report the deploy's image`);
      return { lifted: true };
    }
    return { lifted: false };
  }

  /** The one alarm, at the drain's `until` (record 0064): a drain past
   *  its end is nothing (`liveDrain` already reads it so), and the expiry is
   *  posted `below` like a clear — whoever forgot the drain, the plane's
   *  window lifts. A drain replaced with a later `until` re-arms via setDrain. */
  async alarm(): Promise<void> {
    if ((await this.getStagingMaintenance())?.state === "held") return;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const now = systemClock();
      const stored = await txn.get(DRAIN_KEY);
      if (stored === undefined) return { kind: "missing" } as const;
      if (liveDrain(stored, now) === null) {
        const stale = staleHolds(stored, now);
        await txn.delete(DRAIN_KEY);
        return { kind: "expired", stale } as const;
      }
      return { kind: "live", record: stored as DrainRecord } as const;
    });
    if (result.kind === "expired") {
      // The hold's liveness (issue 2044): a reopen past the cycle bound names
      // the containers whose post-deploy cycle never landed — a warning, never
      // a silence; each restarts on its own next quiet attach or refresh.
      if (result.stale !== null)
        console.log(
          `[drain] fleet reopened with ${result.stale.join(", ")} still on the pre-deploy image — the post-deploy cycle did not land within its bound; a stale container restarts on its next quiet attach or refresh`,
        );
      await this.pushDrainPost("below");
    } else if (result.kind === "live") {
      // Replaced with a later end under an already-armed alarm: re-arm at the
      // record's own earlier end — the hold's cycle bound when one stands.
      const record = result.record;
      const ends = [
        Date.parse(record.until),
        ...(record.holdsUntil !== undefined ? [Date.parse(record.holdsUntil)] : []),
      ];
      await this.ctx.storage.setAlarm(Math.min(...ends.filter(Number.isFinite)));
    }
  }

  /** The drain's plane post (name `drain`), superseding the last: the plane
   *  only needs the current side, and the bot's forward is idempotent. */
  private async pushDrainPost(side: LevelSide): Promise<void> {
    await this.ctx.storage.put(DRAIN_OUTBOX_KEY, {
      name: "drain",
      side,
      generation: "",
      at: new Date(systemClock()).toISOString(),
    });
  }

  /** The pending drain post, for the registry's answers (`/drain`, `/undrain`,
   *  `/residents`) — the bot forwards it to `POST /plane/level`. */
  async getDrainOutbox(): Promise<LevelPost | null> {
    return ((await this.ctx.storage.get(DRAIN_OUTBOX_KEY)) as LevelPost | undefined) ?? null;
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
const RESIDENT_ID_KEY = "resident:instanceId";
const RESIDENT_RETIRED_KEY = "resident:retired";
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
/** A failed or interrupted VM destroy forbids another process on an unconfirmed disk. */
const DESTROY_UNCONFIRMED_KEY = "resident:destroyUnconfirmed";
/** The selected resource remains held until backup and prefix cleanup finish. */
const CLEANUP_PENDING_KEY = "resident:cleanupPending";
/** Retain the exact unknown-effect record after an explicitly selected full reset. */
const NATIVE_EMERGENCY_DISCARD_PREFIX = "native-emergency-discard:";
type NativeDiscardTarget = { key: string; recordHash: string; unknownEffect?: { originBuild: string } };
type NativeDiscardSelection = NativeDiscardTarget | NativeDiscardTarget[];
const RECREATE_ADMISSION_KEY = "resident:recreateAdmission";
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
const POOL_BINDING_KEY_PREFIX = "resident:poolBindings:";
const poolBindingKey = (user: string) => `${POOL_BINDING_KEY_PREFIX}${user}`;

const parentDir = (p: string): string => p.slice(0, p.lastIndexOf("/"));

/** A run's registration, held from its attach to its release (item 44): a
 *  harness run's process lives in the container BETWEEN the bot's operator
 *  calls, so the in-memory op counters read 0 while it runs. Durable rows —
 *  a fresh isolate still counts the process that survived in the container. */
const RUN_REG_KEY_PREFIX = "runReg:";
const runRegKey = (threadKey: string) => `${RUN_REG_KEY_PREFIX}${threadKey}`;
// A thread's highest accepted ledger claim survives registration release and
// binding purge: a delayed older /attach must never reopen an evicted tree.
const RUN_FENCE_KEY_PREFIX = "runFence:";
const runFenceKey = (threadKey: string) => `${RUN_FENCE_KEY_PREFIX}${threadKey}`;
interface RunRegistration {
  workspace?: WorkspaceSettlement["binding"];
  threadKey: string;
  registeredAt: string;
  deadlineAt?: number;
  runId?: string;
  ownerGen?: string;
  ownerFence?: number;
  /** Exact-thread reconciliation proves this unidentified run is elapsed, not deletable. */
  legacyRetainedAt?: number;
}

/** Deterministic per-thread+ref worktree path. Slugs replace anything outside
 *  [A-Za-z0-9._-]; a threadKey-derived hash suffix keeps two keys that slug
 *  identically (e.g. "a:b" vs "a-b") from colliding on disk. */
async function threadWorktreePath(threadKey: string, ref: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(threadKey));
  const hash8 = [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return `${THREADS_DIR}/${slug(threadKey)}-${hash8}/${slug(ref)}`;
}

/** Build a named-ref replacement beside the checkout the sticky row still
 * names. A slash-to-dash slug collision gets a ref hash so the provisional
 * clone can never overwrite the old checkout before the attach commits. */
async function replacementWorktreePath(threadKey: string, ref: string, priorPath: string): Promise<string> {
  const desired = await threadWorktreePath(threadKey, ref);
  if (desired !== priorPath) return desired;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref));
  const hash8 = [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${desired}-ref-${hash8}`;
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
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

class SnapshotStampUnreadableError extends StepError {
  constructor(message: string, cause?: unknown) {
    super("restore", message, cause);
  }
}

/** A preserved workspace refused a worktree step's replacement: the
 *  refusal's setup word rides the step error, so the attach's answer keeps
 *  `settlement_pending` apart from `workspace_preserved` (record 0097). */
class PreservedWorkspaceStepError extends StepError {
  readonly code: ThreadErr["code"];
  constructor(refusal: ThreadErr) {
    super("workspace-preserved", refusal.error);
    this.code = refusal.code;
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

class RunCancelledError extends Error {}

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
    // The SDK deletes these rows synchronously. Do it before scheduling any
    // asynchronous initialization so retired callbacks cannot fire on boot.
    for (const name of RETIRED_SCHEDULE_CALLBACKS) this.deleteSchedules(name);
    // Build the bounded UID view from primary rows before serving this DO
    // instance. A new instance repairs an old-image write or interrupted
    // migration; no durable "ready" flag can bless a stale index.
    void this.ctx.blockConcurrencyWhile(() => this.rebuildPoolBindingIndex());
  }

  /** Serializes concurrent hydration attempts within one DO lifetime. Never
   *  used as a "hydrated" flag — the container can sleep while the DO object
   *  survives, so hydration state is always probed from disk. */
  private hydration: Promise<void> | null = null;
  /** Concurrent lifecycle paths share one destruction attempt. */
  private destroying: Promise<void> | null = null;
  /** An operator's idle check and destroy are one admission interval. */
  private readonly recreateAdmission = new ResidentRecreateAdmission({
    mark: () => this.ctx.storage.put(RECREATE_ADMISSION_KEY, true),
    clear: async () => {
      await this.ctx.storage.delete(RECREATE_ADMISSION_KEY);
    },
    held: async () => (await this.ctx.storage.get(RECREATE_ADMISSION_KEY)) === true,
  });

  private recreateRefusal(): ThreadErr {
    return {
      error: "recreate-in-progress: new resident work is paused during the operator's checked VM recycle",
      status: 503,
      reason: "recreate-in-progress",
      transient: true,
      cause: "system",
    };
  }

  /** Direct admin disk work is admitted before its first await, so the
   *  operator's idle check cannot pass while it is about to mutate the VM. */
  private adminWorkInFlight = 0;

  private async withRecreateSafeAdmin<T>(action: () => Promise<T>): Promise<T | ThreadErr> {
    if (this.recreateAdmission.pending) return this.recreateRefusal();
    this.adminWorkInFlight++;
    try {
      if (await this.recreateAdmission.blocked()) return this.recreateRefusal();
      return await action();
    } finally {
      this.adminWorkInFlight--;
    }
  }

  /** Whether this resident knows the container it held is gone
   *  (docs/reference/specs/resident-repos.md item 43): a restore under way for
   *  this resident (`restoring`, persisted before any restore work) — its own
   *  knowledge, reliable — and nothing else.
   *
   *  Not the Container base's exit state, not a replayed `onStop`, not the
   *  platform's `running` flag: each was tried or weighed and separates
   *  nothing — a roll and an idle sleep leave the same traces, in both
   *  directions — and the why, with the pinned library's lines, is the
   *  record's alone (docs/reference/specs/resident-repos.md item 43), so a
   *  dependency bump rots one place, not three. The harness's own probe
   *  (`identity`, `alive`) stays the arbiter, so under-saying the word here is
   *  safe and over-saying it is what orphans a process.
   *
   *  A read that fails (the storage under a reset or a restore) is no
   *  knowledge: the answer falls back to the SDK's words and the harness
   *  probes, never an unhandled throw where a 409 was due. */
  private async knowsContainerGone(): Promise<boolean> {
    try {
      return (await this.getStatus()).state === "restoring";
    } catch {
      return false;
    }
  }

  /** The one decision on a failure the SDK classified as a runtime
   *  replacement, made where it is classified (`run()`): the SDK vouched the
   *  runtime moved, or a restore is under way for this resident. It gates the
   *  word on `/exec` and the incarnation mint alike; the per-incarnation memos
   *  clear before it, unconditionally. */
  private async replacementKnown(err: unknown): Promise<boolean> {
    return sdkVouchesRuntimeMoved(err) || (await this.knowsContainerGone());
  }

  /** The `/exec` answer for a command the SDK failed with a runtime
   *  replacement (item 43; harness.md item 6): the word — `reason:
   *  "runtime-replaced"`, the resident's sentence — when the replacement was
   *  known at the choke point (`RuntimeReplacedError.known`); otherwise what
   *  the SDK said, with no word and no `reason`, so the harness's one more
   *  command decides. The command is never re-issued either way: it may have
   *  started. */
  private replacedExecAnswer(err: RuntimeReplacedError): ThreadErr {
    if (err.known) return runtimeReplacedErr(err);
    return { error: errMsg(err.cause), status: 409 };
  }

  /** The step trace of the request in flight (docs/reference/specs/tracing.md item 19):
   *  `attachThread` and `runOp` each run inside their own collector, so the
   *  commands `runOk` runs and the mirror-lock waits land on the answer that
   *  caused them — never on a concurrent request's. Empty outside a traced
   *  request (a refresh cycle, a watchdog). */
  private readonly stepTrace = new AsyncLocalStorage<StepTrace>();
  private readonly threadOperationScope = new AsyncLocalStorage<
    | {
        key: string;
        threadKey: string;
        owner: WorkspaceOwner;
        attachment: boolean;
        active: boolean;
      }
    | undefined
  >();
  private readonly opOperationScope = new AsyncLocalStorage<
    | {
        key: string;
        owner: string;
        active: boolean;
        allocated: boolean;
        origin: NativeOperationOrigin;
      }
    | undefined
  >();

  private currentSteps(): ResidentStep[] {
    return this.stepTrace.getStore()?.steps() ?? [];
  }

  /** Durable restore intents remain held after an isolate reset. This set only
   * joins work still running in this incarnation; its loss proves no ending. */
  private readonly pendingRestores = new Set<Promise<unknown>>();

  private async restoreWithProgress(backup: DirectoryBackup, what: string, deadlineMs: number): Promise<void> {
    let prepared;
    try {
      prepared = await prepareRestoreArchive(
        this.env,
        backup.id,
        backup.dir,
        systemClock(),
        deadlineMs,
        RESTORE_BACKUP_EXPIRY_BUFFER_MS,
      );
    } catch (error) {
      emitDeployAdmission(
        {
          event: "native.opaque.not-started",
          phase: "archive-preflight",
          outcome: "not-started",
          commit: "not-admitted",
          reason: "verified-no-start",
          backupId: backup.id,
        },
        { error },
      );
      throw error;
    }
    const attempt = await this.beginThreadNativeOperation("opaque");
    const journal = new NativeOperationJournal(this.ctx.storage);
    let identity;
    try {
      if (!attempt.scope || !("kind" in attempt.scope) || !attempt.id || !attempt.key)
        throw new Error("archive restore requires its original operator scope");
      const capability = archiveCapabilitySchema.parse(
        archiveControlAnswer(
          await this.nativeScopeTransport().request({ mode: "inspect", archive: true }, NATIVE_SCOPE_CONTROL_MS),
        ),
      );
      if (capability.boot !== attempt.scope.boot) throw new Error("original archive kernel changed");
      identity = restoreIdentitySchema.parse({ ...prepared.descriptor, ref: attempt.scope, attempt: attempt.id });
      await journal.reserveArchive(attempt.key, attempt.id, identity);
    } catch (cause) {
      try {
        await attempt.settle();
      } catch (error) {
        throw new OpaqueNativeOutcomeUnconfirmedError("archive admission is unconfirmed", { cause: error });
      }
      throw cause;
    }
    const startedMs = systemClock();
    const privateDir = restorePrivateDirectory(identity.attempt, identity.ref.id);
    const p = executeRestoreArchive({
      identity,
      prepared,
      bucket: this.env.BACKUP_BUCKET,
      native: this.nativeScopeTransport(),
      deadline: deadlineMs,
      now: systemClock,
      controlMs: NATIVE_SCOPE_CONTROL_MS,
      finish: (receipt) => journal.finishArchive(attempt.key!, identity.attempt, receipt),
    }).catch((cause) => {
      if (cause instanceof RestoreArchiveUnconfirmedError)
        throw new OpaqueNativeOutcomeUnconfirmedError(cause.message, { cause });
      throw cause;
    });
    this.pendingRestores.add(p);
    void p.then(
      () => this.pendingRestores.delete(p),
      () => this.pendingRestores.delete(p),
    );
    let progress = { previousKiB: 0, observedKiB: 0 };
    const samples: RestoreSample[] = [];
    for (;;) {
      const outcome = await Promise.race([
        p.then((receipt) => ({ receipt })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RESTORE_POLL_MS)),
      ]);
      if (outcome) {
        emitDeployAdmission({
          event: "native.archive.completed",
          phase: "archive-settlement",
          outcome: outcome.receipt.outcome,
          commit: "acknowledged",
          scopeId: identity.ref.id,
          attemptId: identity.attempt,
          backupId: identity.backupId,
          reason: outcome.receipt.reason,
          ...identity.ref.owner,
        });
        if (outcome.receipt.outcome !== "committed") throw new Error(`${what}: ${outcome.receipt.reason}`);
        const kiB = await this.dirKiB(backup.dir);
        console.log(`${what}: ${kiB ?? "?"} KiB in ${Math.round((systemClock() - startedMs) / 1000)} s`);
        return;
      }
      const currentKiB = await this.restoreProgressKiB([privateDir, backup.dir]);
      progress = accumulateRestoreProgress(progress, currentKiB);
      samples.push({ atMs: systemClock(), kiB: currentKiB === null ? null : progress.observedKiB });
      const verdict = judgeRestoreProgress({ startedMs, nowMs: systemClock(), samples, deadlineMs });
      if (verdict.verdict !== "wait") {
        // The original coordinator performs one UUID-bound stop and cleanup.
        // Never grant fallback from a progress timeout alone.
        throw new OpaqueNativeOutcomeUnconfirmedError(`${what} ${verdict.verdict}: ${verdict.detail}`);
      }
    }
  }

  /** Both supported transfer modes install a plain tree through the fixed
   * archive controller. No SDK restore, FUSE mount or host cleanup is adopted. */
  private async restoreExtracted(
    backup: DirectoryBackup,
    targetDir: string,
    what: string,
    step: ResidentStepName,
    deadlineMs: number,
  ): Promise<void> {
    const startedAt = systemClock();
    await this.restoreWithProgress({ ...backup, dir: targetDir }, what, deadlineMs);
    this.stepTrace.getStore()?.record(step, { startedAt, endedAt: systemClock(), exitCode: 0, timedOut: false });
  }

  private async restoreProgressKiB(paths: readonly string[]): Promise<number | null> {
    const r = await this.run(["du", "-xsk", ...paths]);
    const parsed = parseDu(r.stdout);
    return parsed.size === 0 ? null : [...parsed.values()].reduce((total, size) => total + size, 0);
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

  /** Item 70: the memory guard — one cgroup reading per /exec and /attach
   *  start (and per measure tick), the two-threshold gate over the last one.
   *  In-memory like the waiter ledger: a fresh isolate re-samples at the next
   *  route start, and the persisted copy (MEMORY_KEY) serves the gauges. */
  private memoryGuard = new MemoryGuard({ read: () => this.readCgroup() }, (line) => console.log(line));

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
    opts: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      runtimeRecovery?: "observe";
      nativeUser?: string;
      nativeAccount?: string;
      workspacePaths?: readonly string[];
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated?: boolean }> {
    if ((await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== undefined)
      throw new Error("full-rebuild-cleanup-incomplete: runtime work is paused until cleanup completes");
    if (this.destroying || (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY))) {
      throw new Error("resident-destroy-unconfirmed: container reuse refused until destruction is confirmed");
    }
    let nativeAttempt = await this.beginThreadNativeOperation("process", opts.workspacePaths);
    const timeout = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    if (nativeAttempt.scope) {
      const inventory =
        argv.length === 3 && argv[0] === "ps" && argv[1] === "-eo"
          ? argv[2] === "user="
            ? "users"
            : argv[2] === "pid=,user="
              ? "pid-users"
              : undefined
          : undefined;
      const result = await this.nativeScopeTransport().request(
        {
          mode: "launch",
          ref: nativeAttempt.scope,
          attempt: nativeAttempt.id,
          role:
            inventory || (argv.length === 3 && argv[0] === "pgrep" && argv[1] === "-u")
              ? "inventory"
              : opts.nativeAccount
                ? "provision"
                : opts.nativeUser
                  ? "user"
                  : "trusted",
          ...(inventory ? { inventory } : {}),
          ...(argv.length === 3 && argv[0] === "pgrep" && argv[1] === "-u"
            ? { user: argv[2] }
            : opts.nativeAccount || opts.nativeUser
              ? { user: opts.nativeAccount ?? opts.nativeUser }
              : {}),
          argv: [...argv],
          ...(opts.workspacePaths ? { workspacePaths: opts.workspacePaths } : {}),
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          env: opts.env ?? {},
        },
        timeout,
      );
      if (result.timedOut && (result.exitCode !== 124 || !result.nativeEnding)) {
        try {
          console.warn(
            `[native-timeout-ending] ${JSON.stringify({
              phase: "unconfirmed",
              ...nativeAttempt.scope.owner,
              boot: nativeAttempt.scope.boot,
              attempt: nativeAttempt.id,
              exitCode: result.exitCode,
            })}`,
          );
        } catch {
          /* A failed diagnostic cannot change the original refusal or hold. */
        }
        throw new Error("native timeout ending is unconfirmed");
      }
      if (result.nativeEnding && (!result.timedOut || result.exitCode !== 124))
        throw new Error("native timeout result changed");
      if (Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode !== 125)
        await nativeAttempt.settle(result.nativeEnding);
      const { nativeEnding: _ending, ...output } = result;
      return output;
    }
    if (opts.nativeUser)
      argv = ["/usr/bin/su", "-s", "/bin/sh", opts.nativeUser, "-c", `exec ${argv.map(shellQuote).join(" ")}`];
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
      // A DO code-update reset (our own Worker deploy) BEFORE a runtime
      // replacement: the container is unchanged, so this is `control-reset`, not
      // the replaced word — never `swapIncarnation`, and the command's outcome
      // is unknown. Checked first so a DO reset over a live pi is never
      // read as a replaced container.
      if (isControlReset(err)) throw new ControlResetError("spawn", err);
      if (!isRuntimeReplacement(err)) {
        // The container is running but did not accept the SDK's connect inside
        // the platform's own allowance (item 68): a command already running in
        // it has its cores. Nothing started, the worktree is as it was, and the
        // container accepts again in moments — the typed word, for the thread
        // routes to answer with the wait token; never counted as unreachable.
        if (isRuntimeBusy(err)) {
          await nativeAttempt.settle();
          throw new SandboxRuntimeBusyError({ containerId: this.ctx.id.toString(), cause: errMsg(err) });
        }
        // The control port never answered the SDK's connect (its 30 s abort,
        // raised inside the wake path): no process started and nothing about
        // the repository is known. Ordinary steps count it in storage for the
        // recovery ladder. Manual inspection preserves that row and names the
        // observation, so no reason ever carries the bare
        // `The operation was aborted`.
        if (isRuntimeUnreachable(err)) {
          await nativeAttempt.settle();
          if (opts.runtimeRecovery === "observe")
            throw new RuntimeUnreachableError((await this.runtimeUnreachableRow())?.count ?? 1, err);
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
        // Two consequences with different safety, split here. The memos
        // (`hydratedVerdictAt`, `gitSetupDone`, `stageDirsReady`, the deps
        // flags — the fact that was stale) clear on EVERY replacement the SDK
        // classified: cheap to re-derive, and the per-incarnation memo block's
        // invariant is that this one choke point clears them, whatever the
        // word will say. The incarnation — the lease fencing token, one
        // isolate paired with one container runtime — is minted only when the
        // replacement is KNOWN: `isRuntimeReplacement` is the union, and a
        // transport blip on one request that minted an id would make
        // `takeMutex` read the live holder's row as `holder-incarnation-gone`
        // and hand the mirror mutex to a concurrent `/attach` over a running
        // fetch. (A swap gated whole on `known` was tried and left the memos
        // stale on a real roll, where `known` is false while the wake rewrites
        // the base's state — resident-repos item 43.) Only the word is gated,
        // on the same `known`.
        this.clearIncarnationMemos();
        const known = await this.replacementKnown(err);
        if (known) this.swapIncarnation();
        throw new RuntimeReplacedError("spawn", err, known);
      }
      console.log(
        `exec: runtime replaced before the process started (SDK says retryable) — retrying once: ${errMsg(err)}`,
      );
      if (this.destroying || (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY))) {
        throw new Error("resident-destroy-unconfirmed: container reuse refused until destruction is confirmed", {
          cause: err,
        });
      }
      await nativeAttempt.settle();
      if ((await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== undefined)
        throw new Error("full-rebuild-cleanup-incomplete: runtime work is paused until cleanup completes", {
          cause: err,
        });
      nativeAttempt = await this.beginThreadNativeOperation("process");
      proc = await createExtensionProcessSandbox(this).exec(argv as unknown as SandboxCommand, launch);
    }
    // Ordinary execution accounts for recovery. Manual inspection preserves
    // the existing recovery history, even when the probe connects successfully.
    await nativeAttempt.launched(proc);
    if (opts.runtimeRecovery !== "observe") await this.clearRuntimeUnreachable();
    try {
      const out = await proc.output({ encoding: "utf8", timeout: timeout + 30_000 });
      if (Number.isSafeInteger(out.exitCode) && out.exitCode >= 0) await nativeAttempt.settle();
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
      // A DO code-update reset during collect: the container and the process are
      // unchanged (only this DO's isolate reset), so the outcome is unknown but
      // never a replacement — `control-reset`, no `swapIncarnation`.
      // Checked before the replacement branch below.
      if (isControlReset(err)) throw new ControlResetError("collect", err);
      if (isRuntimeReplacement(err)) {
        // The same split as the spawn site above: the memos unconditionally,
        // the incarnation only when the replacement is known, the word gated.
        this.clearIncarnationMemos();
        const known = await this.replacementKnown(err);
        if (known) this.swapIncarnation();
        throw new RuntimeReplacedError("collect", err, known);
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
        if (exitCode !== null) await nativeAttempt.settle();
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
    opts: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      nativeUser?: string;
      workspacePaths?: readonly string[];
    } = {},
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
   *  checkout (or the staged rebuild's tree, item 47). Never root. Never a
   *  GitHub token. The native user role supplies its home and reduced
   *  privileges inside the original operator scope. */
  private async buildUserRun(
    command: string,
    step: ResidentStepLabelKey,
    timeoutMs: number,
    dir: string = CHECKOUT_DIR,
  ): Promise<string> {
    if (!this.opOperationScope.getStore()?.active)
      throw new Error("build command requires its original operator scope");
    // Steps on one tree are sequential, so a live build-user process INSIDE
    // it here is a leftover (a step whose wait was abandoned, or one
    // orphaned by a Worker-only deploy resetting the DO) — and it is writing
    // into the tree this step is about to clean or build. Scoped to that
    // tree: the same user's deps-store installs run in their own scratch
    // trees, in parallel, and are live work (killStaleBuildProcessesCommand).
    const swept = await this.runOk(killStaleBuildProcessesCommand(BUILD_USER, dir), `${step}-stale-sweep`);
    if (swept.trim()) console.log(`${step}: ${swept.trim()}`);
    return this.runOk(["/bin/bash", "-c", `cd ${dir} && ${command}`], step, {
      timeoutMs,
      nativeUser: BUILD_USER,
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
    await this.writeOwnedFile(CRED_FILE, `https://x-access-token:${token}@github.com\n`);
    try {
      return await this.runOk(
        ["git", "-c", "credential.helper=", "-c", `credential.helper=store --file=${CRED_FILE}`, ...gitArgs],
        step,
        { timeoutMs, env: injected },
      );
    } finally {
      try {
        await this.run(["rm", "-f", CRED_FILE]);
      } catch {
        // one-shot file inside the 700 root-only dir; deletion is best-effort
      }
    }
  }

  // -- repo helpers ----------------------------------------------------------

  /** Recreate the root-only state directory and mirror ownership on a fresh
   *  disk. The image supplies the fixed mirror safe.directory setting. */
  private async ensureGitSetup(): Promise<void> {
    return this.withSharedNativeOperation("git-setup", async () => {
      // Reuse this setup only within the current incarnation. A new disk
      // must restore the private directory and mirror ownership before use.
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
            `if [ -d ${MIRROR_DIR} ]; then chown root:${BUILD_USER} ${MIRROR_DIR} && chmod 750 ${MIRROR_DIR}; fi`,
        ],
        "git-setup",
      );
      this.gitSetupDone = true;
    });
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
    if (m.ready !== undefined) await this.writeOwnedFile(READY_MARKER, `${m.ready}\n`);
    if (m.depsKey !== undefined) await this.writeOwnedFile(DEPS_MARKER, `${m.depsKey}\n`);
    if (m.installingKey !== undefined) await this.writeOwnedFile(INSTALLING_MARKER, `${m.installingKey}\n`);
    if (m.builtSha !== undefined) await this.writeOwnedFile(BUILT_MARKER, `${m.builtSha}\n`);
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
          this.withOpaqueNativeEffect(
            () => this.createBackup({ dir: MIRROR_DIR, localBucket, ttl: SNAPSHOT_TTL_S, name: `${resource} mirror` }),
            (result) =>
              typeof result?.id === "string" &&
              result.id.length > 0 &&
              typeof result.dir === "string" &&
              result.dir === MIRROR_DIR,
          ),
          R2_TRANSFER_TIMEOUT_MS,
          "mirror backup",
          new OpaqueNativeOutcomeUnconfirmedError("mirror backup outcome is unconfirmed after timeout"),
        ),
        withTimeout(
          this.withOpaqueNativeEffect(
            () =>
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
            (result) =>
              typeof result?.id === "string" &&
              result.id.length > 0 &&
              typeof result.dir === "string" &&
              result.dir === CHECKOUT_DIR,
          ),
          R2_TRANSFER_TIMEOUT_MS,
          "checkout backup",
          new OpaqueNativeOutcomeUnconfirmedError("checkout backup outcome is unconfirmed after timeout"),
        ),
      ]);
      return { ref, sha, lockfileHash, createdAt: new Date(systemClock()).toISOString(), mirror, checkout };
    } catch (err) {
      throw new StepError("snapshot", errMsg(err), err);
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
    const attempt = crypto.randomUUID();
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
        await this.run(["rm", "-rf", ...deadPaths], { workspacePaths: deadPaths }).catch((err) => {
          if (isBackgroundOperationHeld(err)) throw err;
        });
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

  /** Bring the checkout to `sha` and build it — staged outside the mirror
   *  mutex, swapped in under it (item 47). The disk markers decide (planBuild
   *  over the refresh planner): a checkout whose HEAD, deps and build markers
   *  all name the target is done. */
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
    // The mirror mutex is held only to STAGE and later to SWAP — never for
    // the build (item 47): a heavy build under the lock pushed concurrent
    // attaches past ATTACH_MUTEX_WAIT_MS into mirror-busy 503s and cold
    // fallbacks. The stage lock covers the two reads the mutex actually
    // protects: a consistent hardlink copy of the warm checkout (exactly
    // materializeThreadDeps' torn-cache guarantee, which the `cp -al` under
    // the same lock keeps — CHECKOUT_DIR now changes only by rename under
    // this mutex) and the fetch from the mirror into the staging tree (an
    // attach's `fetch --prune` could delete a ref under it). No wait
    // timeout, exactly like the fetch lock: the background refresh queues
    // behind an in-flight attach instead of flipping to degraded on
    // transient lock contention. Token-free: repo code runs during the build.
    // Off the lock, before the stage lease: a failed or interrupted off-lock
    // build leaves a full staging tree — deps view plus partial build output,
    // hundreds of thousands of inodes — and the retry 30 s later would
    // otherwise hold the mirror lock through its removal, the contention
    // class the staged rebuild exists to remove. The tree is private to this
    // rebuild, so its stale writers are killed and the tree dropped without
    // the lock; the retired tree's heal-then-remove stays in the staged
    // script under the lease, where the checkout path's consistency needs it.
    const swept = await this.runOk(
      killStaleBuildProcessesCommand(BUILD_USER, STAGING_CHECKOUT_DIR),
      "checkout-stage-stale-sweep",
    );
    if (swept.trim()) console.log(`checkout-stage: ${swept.trim()}`);
    await this.runOk(["rm", "-rf", STAGING_CHECKOUT_DIR], "checkout-stage-clear", {
      workspacePaths: [STAGING_CHECKOUT_DIR],
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    await this.withMirrorLock(
      async () => {
        await this.runOk(["sh", "-c", stageCheckoutScript(CHECKOUT_SWAP_DIRS)], "checkout-stage", {
          workspacePaths: [CHECKOUT_DIR, STAGING_CHECKOUT_DIR, RETIRED_CHECKOUT_DIR],
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        });
        await this.buildUserRun(
          CHECKOUT_FETCH_COMMAND,
          "checkout-update",
          GIT_NETWORK_TIMEOUT_MS,
          STAGING_CHECKOUT_DIR,
        );
      },
      0,
      // The lease is the section's own budget (resident-repos.md item 22) —
      // the backstop by which a taker judges this holder dead. The section
      // runs two commands each budgeted GIT_NETWORK_TIMEOUT_MS (the stage
      // script and the mirror fetch), so the lease is their sum: a lease of
      // one budget let a taker steal the lock mid-stage and race its
      // `fetch --prune` against the staging fetch's negotiation.
      { step: "checkout-stage", budgetMs: 2 * GIT_NETWORK_TIMEOUT_MS },
    );
    // Outside the lock, in the staging tree. Isolation invariant (review 1b):
    // attached, sha-pinned thread worktrees hold hardlinks to the store
    // entry's FILE inodes, and so does the staged copy. A build that writes
    // THROUGH an existing inode — many bundlers do (e.g. .next incremental
    // manifests open+truncate rather than recreate) — would mutate every
    // consumer's pinned artifacts. The `-x` clean removes the staged copy's
    // build output so the build allocates FRESH inodes; the entry's own files
    // are owner-read-only (deps-harden), so a write through them fails loudly
    // instead of silently reaching the store; the tool caches inside
    // node_modules are the checkout's private copies (item 18).
    //
    // Install gate: when the committed lockfile key is unchanged, node_modules
    // (the view) is excluded from the clean and no deps work happens; a
    // changed key re-links the view to the new entry — which is also what
    // drops deps the new lockfile no longer has.
    await this.buildUserRun(
      checkoutUpdateCommand(sha, plan.clean),
      "checkout-update",
      GIT_NETWORK_TIMEOUT_MS,
      STAGING_CHECKOUT_DIR,
    );
    if (plan.install && input.depsEntry) {
      // The old view (a resumed install's keep-deps clean leaves it in
      // place, item 57) makes way for the new entry's: hardlinks only,
      // the entry's inodes are untouched.
      await this.runOk(["rm", "-rf", `${STAGING_CHECKOUT_DIR}/node_modules`], "unlink-deps-view");
      await this.linkDepsView(
        `${input.depsEntry}/node_modules`,
        STAGING_CHECKOUT_DIR,
        BUILD_USER,
        STAGING_CHECKOUT_DIR,
      );
    }
    await this.buildUserRun(input.buildCmd, "build", REFRESH_BUILD_TIMEOUT_MS, STAGING_CHECKOUT_DIR);
    // The swap: two renames — milliseconds — and the markers written with the
    // tree they vouch for, under one short lease.
    await this.withMirrorLock(
      async () => {
        // A leftover writer inside the old checkout would keep writing into
        // the retired tree while it is removed.
        const swept = await this.runOk(
          killStaleBuildProcessesCommand(BUILD_USER, CHECKOUT_DIR),
          "checkout-swap-stale-sweep",
        );
        if (swept.trim()) console.log(`checkout-swap: ${swept.trim()}`);
        await this.runOk(["sh", "-c", swapCheckoutScript(CHECKOUT_SWAP_DIRS)], "checkout-swap", {
          workspacePaths: [MIRROR_DIR, CHECKOUT_DIR, STAGING_CHECKOUT_DIR, RETIRED_CHECKOUT_DIR],
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        });
        if (plan.install) {
          await this.writeDiskMarkers({ depsKey: lockfileKey });
          await this.runOk(["rm", "-f", INSTALLING_MARKER], "clear-installing-marker");
        }
        await this.writeDiskMarkers({ builtSha: sha });
      },
      0,
      { step: "checkout-swap", budgetMs: GIT_NETWORK_TIMEOUT_MS },
    );
    // Off the lock: the replaced tree's removal (hardlinks — mostly link
    // drops). A failure here is a log line; the next stage's seed sweeps it.
    await this.runOk(["rm", "-rf", RETIRED_CHECKOUT_DIR], "checkout-retire", {
      workspacePaths: [RETIRED_CHECKOUT_DIR],
    }).catch((err: unknown) => console.log(`checkout-retire: ${errMsg(err)} — the next staged rebuild sweeps it`));
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
   *  is done; otherwise clean through the mutation gate and restore both archives (judged by
   *  their bytes, against the caller's one deadline), verify the restored
   *  mirror against the stamp and hand the checkout to the build user. Runs
   *  inside the hydration lease its caller holds — every mirror-mutex taker
   *  hydrates first, so nothing else touches these trees meanwhile. An
   *  unknown, stalled or capped restore holds recovery without stopping the
   *  container. A restore interrupted by a runtime replacement (a deploy
   *  rolled the container under it) is
   *  `restore-interrupted`, degraded and rethrown for the instance step that
   *  called it to retry — nothing is streaming into a disk that no longer
   *  exists (restoreFailureDisposition). */
  async restoreCheckout(snap: SnapshotRecord, deadlineMs: number): Promise<{ done: boolean }> {
    const plan = planRestore({ sha: snap.sha, readyStamp: await this.readyStamp() });
    if (plan.action === "done") return { done: true };
    // Join an original restore still observed by this incarnation before
    // cleaning. Durable restore intent also excludes cleanup after a reset.
    // A missing completion is never permission to clean a moving target.
    if (this.pendingRestores.size > 0) {
      try {
        await withTimeout(
          Promise.allSettled([...this.pendingRestores]),
          Math.max(1, deadlineMs - systemClock()),
          `${this.pendingRestores.size} earlier restore(s) still running`,
        );
      } catch (err) {
        throw new OpaqueNativeOutcomeUnconfirmedError("earlier restore is still running or its result is unknown", {
          cause: err,
        });
      }
    }
    // The fixed mutation gate refuses inherited mounts and pending restores.
    await this.runOk(
      ["rm", "-rf", MIRROR_DIR, CHECKOUT_DIR, STAGING_CHECKOUT_DIR, RETIRED_CHECKOUT_DIR, ...DISK_MARKERS],
      "clean-before-restore",
      { workspacePaths: [MIRROR_DIR, CHECKOUT_DIR, STAGING_CHECKOUT_DIR, RETIRED_CHECKOUT_DIR] },
    );
    try {
      // The restore pair IS the cold-wake critical path. Sequential on purpose:
      // the two targets share one hydration deadline, so a
      // concurrent pair only made the second one's clock run while it waited —
      // and each is judged by its own bytes (restoreWithProgress), not by
      // a short fixed budget: a slow transfer waits; a stalled one holds
      // recovery with the bytes and idle span named.
      await this.restoreExtracted(snap.mirror, MIRROR_DIR, "mirror restore", "mirror-restore-extract", deadlineMs);
      await this.restoreExtracted(
        snap.checkout,
        CHECKOUT_DIR,
        "checkout restore",
        "checkout-restore-extract",
        deadlineMs,
      );
    } catch (err) {
      if (isBackgroundOperationHeld(err)) throw err;
      // The typed and cause-chain check first: the SDK's replacement errors
      // (a stale process handle, an inactive runtime identity, an interrupted
      // operation) carry the wording one cause down or not at all. An extract
      // the container roll SIGTERMed is different: its exec comes back a
      // normal `exit 143` result and the SDK's wording only reaches the execs
      // that follow — so the disposition also reads the kill signature, and
      // asks the runtime whether the container the extract wrote to is still
      // there (the incident that named this: a resident went `down` on exactly
      // this, 10 ms before every exec answered "container is not running").
      // A control reset interrupts this caller. The durable original restore
      // remains held until its own result or cleanup receipt is verified.
      // The replacement wording does not credit that original effect.
      const runtimeReplaced = isRuntimeReplacement(err) || isControlReset(err);
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
      // A confirmed restore failure is not cleanup proof. Preserve unresolved
      // journal evidence even when workspace policy permits a VM stop.
      if (
        !(await this.automaticContainerLoss("restore failure", async () => {
          this.swapIncarnation(); // deliberate incarnation swap
          await this.stop().catch((stopErr) => console.log(`restore: stop failed: ${errMsg(stopErr)}`));
        }))
      )
        throw new StepError("restore", "workspace-preservation: automatic VM stop deferred");
      throw await this.goDown(disposition.reason);
    }
    await this.ensureGitSetup();

    // Verify the restored disk against the stamp — a snapshot that does not
    // prove its own {ref, sha, lockfileHash} is refused. Both values
    // derive from the restored MIRROR (the source of truth the checkout was
    // built from); the checkout's presence was proven by restoreBackup + the
    // chown below failing loudly if it is missing.
    const shaRes = await this.run(["git", "-C", MIRROR_DIR, "rev-parse", "--verify", `refs/heads/${snap.ref}`]).catch(
      async (err) => {
        if (isBackgroundOperationHeld(err)) throw err;
        throw await this.unreadableSnapshotStamp("sha", err);
      },
    );
    if (shaRes.exitCode !== 0 || shaRes.timedOut || !/^[0-9a-f]{40,64}$/.test(shaRes.stdout.trim()))
      throw await this.unreadableSnapshotStamp("sha", describeStepFailure(shaRes));
    const diskSha = shaRes.stdout.trim();
    if (diskSha !== snap.sha)
      throw await this.goDown(`snapshot-stamp-mismatch: restored disk {sha:${diskSha}} != stamp {sha:${snap.sha}}`);
    const diskLock = await this.lockfileKey(snap.sha).catch(async (err) => {
      if (isBackgroundOperationHeld(err)) throw err;
      throw await this.unreadableSnapshotStamp("lockfileHash", err);
    });
    if (!/^[0-9a-f]{64}$/.test(diskLock))
      throw await this.unreadableSnapshotStamp("lockfileHash", "hash read returned no valid digest");
    if (diskLock !== snap.lockfileHash) {
      throw await this.goDown(
        `snapshot-stamp-mismatch: restored disk {sha:${diskSha}, lockfileHash:${diskLock}} != stamp {sha:${snap.sha}, lockfileHash:${snap.lockfileHash}}`,
      );
    }

    await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, CHECKOUT_DIR], "chown");
    return { done: false };
  }

  private async unreadableSnapshotStamp(
    field: "sha" | "lockfileHash",
    cause: unknown,
  ): Promise<SnapshotStampUnreadableError> {
    const reason = `snapshot-stamp-unreadable: restored disk ${field} could not be verified (${errMsg(cause)})`;
    await this.recordRefreshError(reason);
    await this.setResidentState("degraded", reason);
    return new SnapshotStampUnreadableError(reason, cause);
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
  async initResident(
    resource: string,
    provisioningTimeoutMs: number,
    rebuilding = false,
    residentId?: string,
  ): Promise<ResidentStatus> {
    if ((await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== undefined)
      throw new Error("full-rebuild-cleanup-incomplete: provisioning is paused until cleanup completes");
    if (this.destroying || (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY))) {
      throw new Error("resident-destroy-unconfirmed: onboarding refused until destruction is confirmed");
    }
    if (!rebuilding && (await this.ctx.storage.get(RESOURCE_KEY))) {
      throw new Error("resident-old-state-present: onboarding refused until prior teardown is confirmed");
    }
    // Offboard can clear storage without replacing the DO isolate. Restore
    // claimant rows before this same isolate records a new onboard.
    await this.rebuildPoolBindingIndex();
    await this.ctx.storage.put({
      [RESOURCE_KEY]: resource,
      [RESIDENT_ID_KEY]: residentId ?? (await this.ctx.storage.get<string>(RESIDENT_ID_KEY)) ?? resource,
      [STATE_KEY]: "onboarding" satisfies ResidentState,
      [REASON_KEY]: "",
      [UPDATED_KEY]: new Date(systemClock()).toISOString(),
      [DEADLINE_AT_KEY]: systemClock() + provisioningTimeoutMs,
    });
    await this.ctx.storage.delete([FACTS_KEY, SNAPSHOT_KEY, RETIRED_SNAPSHOT_KEY, RESIDENT_RETIRED_KEY]); // defensive: no stale facts from a past life
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

  private async residentIdentity(): Promise<string> {
    const id =
      (await this.ctx.storage.get<string>(RESIDENT_ID_KEY)) ?? (await this.ctx.storage.get<string>(RESOURCE_KEY));
    if (!id) throw new Error("resident identity is unavailable");
    return id;
  }

  /** Only a new catalog member can initialize an empty DO. A retry cannot
   * replace another repository or an already recorded resident address. */
  async ensureResidentMember(resource: string, residentId: string, timeoutMs: number): Promise<void> {
    if (await this.ctx.storage.get(RESIDENT_RETIRED_KEY)) throw new Error("resident member is retired");
    const prior = await this.ctx.storage.get<string>(RESOURCE_KEY);
    const identity = await this.ctx.storage.get<string>(RESIDENT_ID_KEY);
    if (
      (prior && prior !== resource) ||
      (identity && identity !== residentId) ||
      (prior && !identity && residentId !== resource)
    )
      throw new Error("resident member identity does not match");
    if (!prior) await this.initResident(resource, timeoutMs, false, residentId);
  }

  async prepareMemberRemoval(resource: string, residentId: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const prior = await txn.get<string>(RESOURCE_KEY);
      const identity = await txn.get<string>(RESIDENT_ID_KEY);
      const pending = await txn.get<string>(CLEANUP_PENDING_KEY);
      if ((prior && prior !== resource) || (identity && identity !== residentId) || (pending && pending !== resource))
        throw new Error("resident removal target does not match");
      await txn.put({ [RESIDENT_ID_KEY]: residentId, [RESIDENT_RETIRED_KEY]: true, [CLEANUP_PENDING_KEY]: resource });
    });
  }

  /** Recheck the original catalog inside the existing per-DO recreate lock.
   * Delayed offboard retries cannot cross a completed removal and new onboard. */
  async removePoolMember(resource: string, residentId: string, revision: string) {
    const refused = (error: string) => ({
      schedulesCancelled: false,
      containerStopped: false,
      storageCleared: false,
      backupObjectsDeleted: 0,
      r2ObjectsDeleted: 0,
      errors: [error],
    });
    const admission = await this.recreateAdmission.run(async () => {
      const record = await this.registry().getRepository(resource);
      const pool = record && residentPoolOf(record);
      if (
        !record?.offboarding ||
        pool?.revision !== revision ||
        !pool.members.slice(0, pool.active).includes(residentId)
      )
        return refused("resident removal catalog changed");
      await this.prepareMemberRemoval(resource, residentId);
      const saved = pool.removed?.[residentId];
      const result = saved
        ? { ...saved, schedulesCancelled: true, containerStopped: true, storageCleared: true, errors: [] as string[] }
        : await teardownResident(this.env, resource, residentId, false, this);
      if (result.containerStopped && result.storageCleared && result.errors.length === 0) {
        const recorded =
          saved ||
          (await this.registry().recordPoolRemoval(resource, revision, residentId, {
            backupObjectsDeleted: result.backupObjectsDeleted,
            r2ObjectsDeleted: result.r2ObjectsDeleted,
          }));
        if (!recorded) result.errors.push("pool cleanup receipt was not saved");
        else {
          try {
            await this.confirmCleanup(resource);
          } catch (err) {
            result.errors.push(`cleanup confirmation failed: ${errMsg(err)}`);
          }
        }
      }
      return result;
    });
    return admission.busy ? refused("resident removal is already in progress") : admission.value;
  }

  /** Read metadata under the fleet maintenance fence. This includes UID
   * reservations from attachments which never completed. It reads no files. */
  async placementHistoryPage(startAfter?: string): Promise<{ after?: string; done: boolean; threads: string[] }> {
    const rows = await this.ctx.storage.list<unknown>({ limit: 128, ...(startAfter ? { startAfter } : {}) });
    return {
      ...(rows.size ? { after: [...rows.keys()].at(-1)! } : startAfter ? { after: startAfter } : {}),
      done: rows.size < 128,
      threads: placementHistoryThreads(rows),
    };
  }

  /** The provisioning engine (schedule-driven): clone bare mirror → resolve the
   *  default branch → full install + build in a working checkout using the
   *  onboard-time command table → stamped snapshot → record facts → warm.
   *  On failure: down(provision-failed at <step>) — the registry slot is
   *  deliberately KEPT so /status shows the named reason (only a stuck
   *  onboarding releases the slot, via the deadline/watchdog). */
  async runProvisioning(payload: string): Promise<void> {
    const savedResource = await this.ctx.storage.get<string>(RESOURCE_KEY);
    const resource = payload || savedResource || "";
    if (resource !== savedResource) return; // stale schedule from another membership
    if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") return; // stale schedule
    return this.withSharedNativeOperation("provisioning", async () => {
      if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") return;
      try {
        // An older image could have deleted every DO key after a failed
        // offboard destroy. No prior row is evidence of a fresh VM; confirm
        // destruction here, after onboard returned, before any provision step.
        if (
          !(await this.currentUidLedger().then(
            () => true,
            () => false,
          ))
        ) {
          if (
            !(await this.automaticContainerLoss("provisioning VM reset", async () => {
              this.swapIncarnation();
              await this.destroyConfirmed();
            }))
          )
            throw new StepError("provision", "workspace-preservation: automatic VM reset deferred");
        }
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

        // Join original work still running in this incarnation before cleanup.
        // The mutation reservation also protects against retained restore
        // intent after a reset; promise-set absence proves no ending.
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

        await this.runOk(
          ["rm", "-rf", MIRROR_DIR, CHECKOUT_DIR, STAGING_CHECKOUT_DIR, RETIRED_CHECKOUT_DIR, ...DISK_MARKERS],
          "clean-workspace",
          { workspacePaths: [MIRROR_DIR, CHECKOUT_DIR, STAGING_CHECKOUT_DIR, RETIRED_CHECKOUT_DIR] },
        );
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
        // A fresh provision runs on the image the deployed Worker pins, so it IS
        // the cycle a held drain waits for (issue 2044): report it — a rebuild
        // mid-drain reopens the fleet instead of leaving the hold standing on a
        // report `reconcileImage` would never send for a container it never saw
        // as stale. The marker is cleared with the report; a failure keeps both
        // for the next reconcile, and the hold's cycle bound is the backstop.
        await this.ctx.storage.put(IMAGE_REPORT_PENDING_KEY, { resource: await this.residentIdentity() });
        await this.reportPendingImageCurrent("provision");
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
    });
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
        const record = await this.registry().getRepository(resource);
        if (!record?.pool) await this.registry().remove(resource); // pools retain failed members for recovery
      } catch (err) {
        // the Worker-side watchdog also removes on "provision-timed-out"
        console.log(`[provision] ${resource}: capacity release failed: ${residentText(errMsg(err))}`);
      }
    }
  }

  // -- wake path (rehydration: storage is truth, the disk is a cache) ----------

  /** Ensure the container disk holds the stamped snapshot state. `restoring`
   *  is persisted BEFORE any restore work — DO storage would
   *  otherwise still say warm while the R2 restore runs. Refuses mismatched
   *  stamps → down(snapshot-stamp-mismatch); an unknown, stalled or capped
   *  restore → degraded(refresh-held) with the VM kept; a restore interrupted
   *  by a runtime replacement → degraded(restore-interrupted), then rethrown
   *  so the instance step is retried. Throws ResidentDownError after the down
   *  transitions. Called by the refresh instance's fetch step (and the attach
   *  path). */
  async ensureHydrated(): Promise<void> {
    if ((await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== undefined)
      throw new ResidentDownError("full-rebuild-cleanup-incomplete: hydration is paused until cleanup completes");
    // Fresh positive verdict for this incarnation → nothing to probe. See the
    // per-incarnation memo block for why this is safe; the refresh cycle's
    // 10-min cadence always outlives the TTL, so a cycle re-probes for real.
    if (this.hydratedVerdictAt !== 0 && systemClock() - this.hydratedVerdictAt < this.hydrationMemoTtlMs) return;
    if (this.hydration) {
      await this.hydration;
      await this.assertThreadOperationAllowed();
      return;
    }
    await this.assertThreadOperationAllowed();
    // The hydration's lease in the in-flight row (item 22) is what the
    // watchdog reads: alive for this incarnation until the stale bound, gone
    // with the isolate that started it.
    const holder = this.nextHolder();
    const p = this.recordInFlight("hydration", holder, STALE_MIDFLIGHT_MS, "restore")
      .then(() => this.withSharedNativeOperation("hydration", () => this.doHydrate()))
      .then(() => {
        this.hydratedVerdictAt = systemClock();
      })
      .finally(async () => {
        if (this.hydration === p) this.hydration = null;
        await this.clearInFlight("hydration", holder);
      });
    this.hydration = p;
    this.hydrationStartedAt = systemClock();
    await p;
    await this.assertThreadOperationAllowed();
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
      await this.reportPendingImageCurrent("hydrate");
      return;
    }
    // The snapshot carries the checkout's tree, not the store (item 59): adopt
    // its node_modules as the entry for the stamp's key — a rename plus a
    // hardlink view, seconds — so the first attach on the warm key hits.
    // Housekeeping on the restore path: a failure here leaves the checkout
    // whole (the entry is either absent or complete) and the first attach
    // adopts instead.
    await this.adoptCheckoutDeps(snap.lockfileHash).catch((err) => {
      if (isBackgroundOperationHeld(err)) throw err;
      console.log(`deps: adopt after restore failed: ${errMsg(err)}`);
    });
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
      if (isBackgroundOperationHeld(err)) throw err;
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
    // This is the deploy reconcile's missing fact: the replacement itself has
    // started, restored its snapshot and become usable. Reporting after `warm`
    // avoids both clearing the marker on stop and probing while restore still
    // owns the fresh container (issue 2101).
    await this.reportPendingImageCurrent("hydrate");
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
    if ((await this.reconcileImage("refresh")) === "restarted") {
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
    if (entry.state === "degraded" && !isNonEvidenceReason(entry.reason) && parksOnRepeat(entry.reason)) {
      // Count consecutive cycles that found the same REFRESH-PRODUCED degraded
      // reason that is evidence about the repo or GitHub (github-unreachable,
      // a repo-command step's <step>-failed); a stable streak means retrying
      // is not going to help and parking is the right cost behavior. A
      // resident-step failure never parks: item 67's ladder is its escalation.
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
    const pool = residentPoolOf(record);
    const keepWarm = pool ? pool.members.slice(0, pool.desired).includes(await this.residentIdentity()) : false;
    if (!keepWarm && settled && (await this.isIdle())) {
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

    // Item 68: remember what `refreshing` covers, so a cycle the busy container
    // turns away can put it back — the last snapshot never stopped serving.
    await this.ctx.storage.put(REFRESHING_FROM_KEY, (await this.getStatus()) satisfies RefreshingFrom);
    await this.setResidentState("refreshing");
    let sha: string;
    try {
      // Same mirror mutex as attach's fetch/worktree work: the
      // refresh cycle and an in-flight attach serialize instead of racing
      // a prune against a worktree clone.
      sha = (await this.fetchMirror({ ref: facts.defaultRef, cycle, token })).sha;
    } catch (err) {
      if (isBackgroundOperationHeld(err)) throw err;
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
      // Item 68: the container did not accept the connect — a run's command
      // has its cores. Not GitHub, not the mirror: the instance step yields.
      if (failure.busy) throw err;
      if (failure.diskFull) {
        await this.setResidentState("degraded", failure.reason);
        await this.recoverFromDiskFull(failure.reason, selfInFlight);
        return { ok: false, reason: failure.reason };
      }
      // Item 67: a fetch that failed on the MIRROR (its remote gone, its
      // object store broken) is the resident's own step failing — `fetch-failed`,
      // counted by the ladder, never serviceable — not GitHub being unreachable.
      // The first live row found a broken mirror parked as `github-unreachable`.
      if (fetchFailureIsMirrors(message)) {
        await this.refreshFailed(failure, selfInFlight);
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
    // A completed cycle ends any resident-step streak (item 67).
    await this.ctx.storage.delete(INFRA_STREAK_KEY);
    await this.setResidentState("warm");
    // Event-triggered reclamation: the prune above already told the
    // mirror which branches died; finished refs release their worktree and
    // live binding now, not at the idle TTL. Housekeeping, never a
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
   *  resident can act on itself (recoverFromDiskFull). A container that did
   *  not accept the connect (`runtime-busy`, item 68) is a fourth: `busy`,
   *  and the cycle yields to the run that holds it. */
  private async classifyCycleError(err: unknown): Promise<RefreshFailure> {
    if (err instanceof SnapshotStampUnreadableError)
      return {
        step: err.step,
        reason: err.message,
        interrupted: false,
        diskFull: false,
        runtimeUnreachable: false,
        busy: false,
        verificationUnknown: true,
      };
    if (isBackgroundOperationHeld(err))
      return classifyRefreshFailure({
        step: err instanceof StepError ? err.step : "refresh",
        message: errMsg(err),
        operationHeld: true,
      });
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
    console.log(
      `refresh: cycle ${failure.operationHeld || failure.verificationUnknown ? "held" : "failed"} — ${failure.reason.slice(0, 400)}`,
    );
    await this.recordRefreshError(failure.reason);
    if (failure.operationHeld || failure.verificationUnknown) {
      // An unresolved effect or stamp read is not evidence that the VM is
      // broken. A replacement cannot establish the missing fact.
      await this.ctx.storage.delete(INFRA_STREAK_KEY);
      await this.setResidentState("degraded", failure.reason);
      return;
    }
    if (failure.diskFull) {
      await this.setResidentState("degraded", failure.reason);
      await this.recoverFromDiskFull(failure.reason, selfInFlight);
      return;
    }
    // Item 67: a failure in the repository's own command is evidence about the
    // repo — degraded, and the gate's park streak decides; it also ends any
    // resident-step streak, since our machinery got that far. A failure in
    // the resident's own steps climbs the ladder over the persisted count.
    if (isRepoCommandStep(failure.step)) {
      await this.ctx.storage.delete(INFRA_STREAK_KEY);
      await this.setResidentState("degraded", failure.reason);
      return;
    }
    const row = await this.noteInfraStreak(failure.step);
    switch (infraStreakRung(row.count)) {
      case "count":
        await this.setResidentState("degraded", failure.reason);
        return;
      case "recreate":
        // The disk, not the repo: destroy the container, snapshots kept; the
        // next cycle's wake restores mirror, checkout and deps from R2.
        if (!(await this.recreateContainer(infraStreakReason(row, "recreate"))))
          await this.setResidentState("degraded", "workspace-preservation: automatic VM replacement deferred");
        return;
      case "down": {
        // A recreated container failed the same way: the snapshot or the
        // resident is what is wrong, and a rebuild from GitHub is the exit —
        // item 36's transition, the VM destroyed first so provisioning starts
        // on a fresh one.
        const reason = infraStreakReason(row, "down");
        const removed = await this.automaticContainerLoss(reason, async () => {
          this.swapIncarnation(); // deliberate incarnation swap
          await this.destroyConfirmed();
          await this.ctx.storage.delete(INFRA_STREAK_KEY);
        });
        if (!removed)
          await this.setResidentState("degraded", "workspace-preservation: automatic VM replacement deferred");
        else await this.goDown(reason);
        return;
      }
    }
  }

  /** One more cycle failed in the resident's own steps: the count up by one,
   *  `firstAt` kept, the step and `lastAt` now. */
  private async noteInfraStreak(step: string): Promise<InfraStreakRow> {
    const prev = await this.ctx.storage.get<InfraStreakRow>(INFRA_STREAK_KEY);
    const now = new Date(systemClock()).toISOString();
    const row: InfraStreakRow = { step, count: (prev?.count ?? 0) + 1, firstAt: prev?.firstAt ?? now, lastAt: now };
    await this.ctx.storage.put(INFRA_STREAK_KEY, row);
    console.log(
      `infra-streak: cycle ${row.count} of ${INFRA_STREAK_DOWN_AT} failed in the resident's own step ${step} (first at ${row.firstAt})`,
    );
    return row;
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
        if (
          !(await this.automaticContainerLoss(reason, async () => {
            this.swapIncarnation(); // deliberate incarnation swap
            await this.stop().catch((stopErr) => console.log(`runtime-unreachable: stop failed: ${errMsg(stopErr)}`));
          }))
        )
          return { status: "failed", reason: "workspace-preservation: automatic VM stop deferred" };
        await this.setResidentState("degraded", reason);
        throw err;
      case "recreate":
        if (!(await this.recreateContainer(reason)))
          return { status: "failed", reason: "workspace-preservation: automatic VM replacement deferred" };
        throw err;
      case "down":
        // A fresh VM did not answer either. Down with a rebuild-eligible reason
        // (REHYDRATION_FAILURE_RE) — goDown rebuilds on the transition, item 36 —
        // and the VM destroyed, so the rebuild's provisioning starts on a new one.
        if (
          !(await this.automaticContainerLoss(reason, async () => {
            this.swapIncarnation(); // deliberate incarnation swap
            await this.destroyConfirmed();
            await this.clearInstanceLease(instance);
          }))
        )
          return { status: "failed", reason: "workspace-preservation: automatic VM replacement deferred" };
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
  private async automaticContainerLoss(
    reason: string,
    action: () => Promise<void>,
    admissionHeld = false,
    ownAdmissions = 0,
  ): Promise<boolean> {
    const checked = async () => {
      const defer = async (detail: string) => {
        await this.recordRefreshError(`${reason} — workspace-preservation: ${detail}`);
        return false;
      };
      if (this.runsInFlightCount() > ownAdmissions || this.workspaceExclusiveOpsInFlight.size > 0)
        return defer("resident activity changed before VM loss check");
      const runtimeActive = await this.isRuntimeActive().catch(() => false);
      const bindings = (await this.liveBindings()).sort((a, b) => a.threadKey.localeCompare(b.threadKey));
      const owners = await Promise.all(
        bindings.map(async (binding) => ({
          registration: await this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey)),
          fence: await this.ctx.storage.get<unknown>(runFenceKey(binding.threadKey)),
        })),
      );
      for (const binding of bindings) {
        const decision = await this.workspaceRemovalDecision(binding, runtimeActive);
        if (decision.removable === false) {
          await this.reportBlockedWorkspace({ binding, reason: decision.reason });
          await this.recordRefreshError(`${reason} — workspace-preservation: ${binding.threadKey} ${decision.reason}`);
          return false;
        }
      }
      if (this.runsInFlightCount() > ownAdmissions || this.workspaceExclusiveOpsInFlight.size > 0)
        return defer("resident activity changed during VM loss check");
      const latest = (await this.liveBindings()).sort((a, b) => a.threadKey.localeCompare(b.threadKey));
      if (
        latest.length !== bindings.length ||
        latest.some((binding, index) => {
          const before = bindings[index];
          return (
            binding.threadKey !== before.threadKey ||
            binding.user !== before.user ||
            binding.ref !== before.ref ||
            binding.worktreePath !== before.worktreePath ||
            binding.lastAttachAt !== before.lastAttachAt
          );
        })
      )
        return defer("workspace binding changed during VM loss check");
      const latestOwners = await Promise.all(
        latest.map(async (binding) => ({
          registration: await this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey)),
          fence: await this.ctx.storage.get<unknown>(runFenceKey(binding.threadKey)),
        })),
      );
      if (latestOwners.some((owner, index) => JSON.stringify(owner) !== JSON.stringify(owners[index])))
        return defer("workspace owner changed during VM loss check");
      await action();
      return true;
    };
    if (admissionHeld) return checked();
    const admission = await this.recreateAdmission.run(checked);
    return admission.busy ? false : admission.value;
  }

  private async recreateContainer(reason: string, automatic = true, admissionHeld = false): Promise<boolean> {
    const recreate = async () => {
      console.log(
        `recreate: destroying the container — snapshots kept; the next exec restores from R2 (${reason.slice(0, 200)})`,
      );
      this.swapIncarnation(); // deliberate incarnation swap
      await this.destroyConfirmed();
      await this.setResidentState("degraded", reason);
    };
    if (automatic) return this.automaticContainerLoss(reason, recreate, admissionHeld, admissionHeld ? 1 : 0);
    await recreate();
    return true;
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

  /** Mark uncertainty before touching SDK runtime identity. A failed destroy
   *  remains visible after an isolate restart and refuses every new exec. */
  private async destroyConfirmed(): Promise<void> {
    const pending =
      this.destroying ??
      destroyWithPersistentFence(
        {
          mark: () => this.ctx.storage.put(DESTROY_UNCONFIRMED_KEY, true),
          clear: async () => {
            await this.ctx.storage.delete(DESTROY_UNCONFIRMED_KEY);
          },
        },
        async () => {
          await this.forgetRuntimeIdentity();
          await this.destroy();
          // Only confirmed destruction creates an empty generation. If this
          // write fails, the uncertainty fence remains and no UID is reused.
          await this.ctx.storage.transaction((txn) => resetUidGeneration(txn));
        },
      );
    this.destroying = pending;
    try {
      await pending;
    } finally {
      if (this.destroying === pending) this.destroying = null;
    }
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
   *  entry gates (so a concurrent reconcile — the deploy's — never stops the
   *  container under it — while the gates themselves, `isIdle`, `reconcileImage("refresh")`
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
   *  cron from creating a second instance meanwhile. A container that turned
   *  the step's connect away (`runtime-busy`, item 68) ends the cycle as
   *  `stopped` with nothing recorded — `yieldCycle` puts back the state the
   *  cycle found. A failure of the repo's
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
    const registry = this.registry();
    const operationOwner = `op:${crypto.randomUUID()}`;
    const requestContext: NativeRequestContext = {
      sourceId: step,
      callId: crypto.randomUUID(),
      actor: "system",
      traceId: null,
      parentSourceId: instance,
    };
    const admission = await beginTrackedDeployAdmission(registry, {
      kind: "refresh-step",
      component: "workflow",
      sourceId: instance,
      build: BUILD_ID,
      workerVersion: workerVersionId(this.env),
      producer: "refresh-step",
      actor: "system",
      callId: requestContext.callId,
      parentSourceId: step,
      resource: await this.ctx.storage.get(RESOURCE_KEY),
    });
    if (!admission) {
      await this.yieldCycle(instance);
      return { status: "stopped", why: "deploy-fence", startedAt, trace: trace.steps() };
    }
    this.refreshAdmissionsInFlight++;
    let counted = false;
    const count = () => {
      if (counted) return;
      counted = true;
      this.refreshesInFlight++;
    };
    let outcome = "done";
    try {
      const result = await this.withOpNativeOperation(
        operationOwner,
        async () => {
          if (await this.recreateAdmission.blocked())
            return { status: "stopped" as const, why: "recreate-in-progress" };
          return this.stepTrace.run(trace, () => fn({ count }));
        },
        "refresh-step",
        requestContext,
        admission,
      );
      if (result.status !== "done") {
        outcome = result.status === "stopped" ? `stopped (${result.why})` : `failed (${result.reason})`;
        await this.clearInstanceLease(instance);
      }
      return { ...result, startedAt, trace: trace.steps() };
    } catch (err) {
      if (err instanceof StepError && ["producer-cleanup-completed", "producer-cleanup-pending"].includes(err.step)) {
        outcome = `stopped (${err.step})`;
        await this.yieldCycle(instance);
        return { status: "stopped", why: err.step, startedAt, trace: trace.steps() };
      }
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
      if (failure.busy) {
        // Item 68: the container did not accept the cycle's connect — a run's
        // command has its cores. Nothing ran and nothing about the repository
        // is known: the cycle yields, the state it found goes back, and no
        // failure is recorded — not `degraded`, not a rung of item 67's ladder
        // (three cycles of it used to destroy the container under the run).
        // The next cron firing tries again; the engine is not asked to retry
        // into the same busy container.
        outcome = `yielded (${failure.reason})`;
        console.log(
          `refresh instance ${instance}: ${step} yielded — ${failure.reason.slice(0, 400)}; the next cycle retries`,
        );
        await this.yieldCycle(instance);
        return { status: "stopped", why: RUNTIME_BUSY_REASON, startedAt, trace: trace.steps() };
      }
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
      this.refreshAdmissionsInFlight--;
      if (counted) this.refreshesInFlight--;
      const journal = new NativeOperationJournal(this.ctx.storage);
      let callbackMetadataEnded = false;
      try {
        await this.recordInstanceStep(instance, step, outcome);
      } catch (error) {
        emitDeployAdmission(
          {
            phase: "operator-ending",
            stage: "callback-metadata",
            id: admission.id,
            commit: "unverified",
            failure: "storage",
          },
          { error },
        );
        const reason = `refresh-step-metadata-unverified: ${step} status was not stored`;
        await this.recordRefreshError(reason);
        const status = await this.getStatus();
        if (["warm", "refreshing", "degraded"].includes(status.state)) await this.setResidentState("degraded", reason);
      }
      try {
        // A failed status write has settled too. It is reported above, rather
        // than making the original caller's ending proof impossible to save.
        callbackMetadataEnded = await journal.endOperatorCallback(operationOwner, requestContext.callId, admission);
      } catch (error) {
        emitDeployAdmission(
          {
            phase: "operator-ending",
            stage: "callback-ending",
            id: admission.id,
            commit: "unverified",
            failure: "storage",
          },
          { error },
        );
      }
      const ended =
        callbackMetadataEnded &&
        (await journal
          .operatorEnded(`native-operation:${operationOwner}`, { opOwner: operationOwner }, requestContext.callId)
          .catch(() => false));
      if (ended) {
        await endTrackedDeployAdmission(registry, admission);
        const origin = await this.operationOrigin("refresh-step", operationOwner, requestContext);
        const saved = (await journal.producerAdmissions(origin, (owner) => owner === operationOwner))[0];
        if (saved) await journal.completeOperatorAdmission(saved);
      } else
        emitDeployAdmission({
          phase: "permit-release",
          id: admission.id,
          commit: "held",
          failure: "operator-ending-unverified",
        });
    }
  }

  /** A cycle that met the busy container ends here (item 68): the lease it
   *  holds goes back, and the `refreshing` it wrote is undone to the settled
   *  state it found, so the row says what the last snapshot still is — warm,
   *  or the degraded an earlier cycle earned — never a `degraded` of this
   *  cycle's own. A `refreshing` this cycle did not write (a step past the
   *  fetch found the marker of a cycle that died mid-flight) is left to the
   *  watchdog, which normalizes it. */
  private async yieldCycle(instance: string): Promise<void> {
    await this.clearInstanceLease(instance);
    const status = await this.getStatus();
    if (status.state !== "refreshing") return;
    const from = await this.ctx.storage.get<RefreshingFrom>(REFRESHING_FROM_KEY);
    if (!from || (from.state !== "warm" && from.state !== "degraded")) {
      console.log(
        `refresh instance ${instance}: yielded from \`refreshing\` over ${from?.state ?? "no recorded state"}; left for the watchdog`,
      );
      return;
    }
    await this.setResidentState(from.state, from.reason);
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
      if (isBackgroundOperationHeld(err)) throw err;
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
      return this.housekeeping("measure", async () => {
        // Item 70: the tick's memory line rides the measure step's cadence —
        // the instance the watchdog cron creates, never the watchdog's own
        // pass (which must not touch the container). No polling loop.
        await this.sampleMemory();
        return { measured: (await this.measureDisk()) !== null };
      });
    });
  }

  /** Whether a run may be using this disk: a live binding attached to or
   *  used (an exec bumps `lastAttachAt` too, item 21) within IDLE_AFTER_S.
   *  The run registration protects the gap between tool calls past this floor.
   *  The idle-sleep gate (item 16b) and disk-full recycle (item 54) both read
   *  the floor and the bounded registrations, never what a tree holds (item
   *  17): a dirty tree no run is using protects nothing. */
  private recentlyUsed(live: ThreadBinding[]): boolean {
    const recent = systemClock() - IDLE_AFTER_S * 1000;
    return live.some((b) => Date.parse(b.lastAttachAt) >= recent);
  }

  /** A live run registration prevents sleep even after an hour without an op;
   *  an expired one cannot keep the container awake. */
  private async isIdle(): Promise<boolean> {
    if (this.recentlyUsed(await this.liveBindings())) return false;
    if (this.inFlightCount() > 0) return false;
    return (await this.registeredRunsBeyondOps()) === 0;
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
    // A busy container (item 68) would only refuse the disk probe's exec too.
    if (direct.diskFull || direct.interrupted || direct.busy) return direct;
    return classifyRefreshFailure({ step, message, freeKiB: await this.freeKiB() });
  }

  /** Stop a safe container so the next cycle attempt
   *  restores mirror + checkout from R2 onto an empty disk — the same wake
   *  path as a platform sleep. Only when the pure plan allows it: no recycle
   *  within the cooldown, nothing in flight (`selfInFlight` excludes the
   *  calling refresh cycle from the count) and no live binding used within
   *  the idle floor and no live run registration — the idle-sleep gate's own
   *  predicates. The shared preservation decision must also authorize every
   *  live binding before the container can be stopped. Each tree is measured
   *  first, as its thread user, and its binding records what went
   *  (`recordRecycledTree`); the plan is decided again after those awaits,
   *  right before the stop. A refused recycle is written to
   *  `lastRefreshError` with its why, so `/residents` says what an operator
   *  must do; the `degraded` reason stays the clean `disk-full: …`. Answers
   *  whether the container was recycled. */
  private async recoverFromDiskFull(reason: string, selfInFlight: number): Promise<boolean> {
    const lastRecycleAt = await this.ctx.storage.get<number>(DISK_FULL_RECYCLE_KEY);
    const plan = async (live: ThreadBinding[]) => {
      const liveRegistrations = await this.registeredRunsBeyondOps();
      return planDiskFullRecovery({
        now: systemClock(),
        lastRecycleAt,
        inFlight: this.inFlightCount() - selfInFlight,
        recentlyUsed: this.recentlyUsed(live) || liveRegistrations > 0,
        idleFloorS: IDLE_AFTER_S,
      });
    };
    const kept = async (why: string) => {
      console.log(`disk-full: container kept — ${why}`);
      await this.recordRefreshError(`${reason} — container kept: ${why}`);
      return false;
    };
    const live = await this.liveBindings();
    const first = await plan(live);
    if (first.action === "wait") return kept(first.why);
    // What each live tree holds, for its record. Preservation authority is
    // checked separately before stop. Each probe touches its own tree, one spawn
    // each. Runtime down: the disk, and every tree with it, is already gone.
    const active = await this.isRuntimeActive().catch(() => false);
    const trees = active
      ? await Promise.all(
          live.map(async (binding) => [binding, await this.measureTreeBeforeEviction(binding)] as const),
        )
      : live.map((binding) => [binding, undefined] as const);
    // The measurement awaited (the DO yields at each await): decide again over
    // fresh facts — an attach or an op that landed meanwhile keeps the container.
    const verdict = await plan(await this.liveBindings());
    if (verdict.action === "wait") return kept(verdict.why);
    const recycled = await this.automaticContainerLoss(reason, async () => {
      console.log(
        `disk-full: recycling the container — the next cycle restores mirror + checkout from R2 onto an empty disk (${reason})`,
      );
      for (const [binding, tree] of trees) await this.recordRecycledTree(binding, tree);
      await this.ctx.storage.put(DISK_FULL_RECYCLE_KEY, systemClock());
      await this.recordRefreshError(`${reason} — container recycled; restoring from R2 on the next cycle`);
      this.swapIncarnation(); // deliberate incarnation swap
      await this.stop().catch((err) => console.log(`disk-full: stop failed: ${errMsg(err)}`));
    });
    return recycled || kept("workspace-preservation: automatic disk recycle deferred");
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
    await this.putThreadBinding({
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
      homes: [BUILD_USER, ...(await this.currentUidLedger()).map((row) => row.user)].map((user) => ({
        user,
        dir: `/home/${user}`,
      })),
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

  // -- memory guard (docs/reference/specs/resident-repos.md item 70) ------------

  /** The one real `CgroupReader`: `CGROUP_READ_ARGV` through the exec choke
   *  point (`run()`), one exec per sample. A throw there (busy, replaced,
   *  reset — the container's moment, not the cgroup) is the transient
   *  `MemorySampleUnavailable`, which never disables the gate — and a typed
   *  runtime replacement `invalidates` the last reading: the container it
   *  measured is gone, and gating on its numbers would answer
   *  `memory-pressure` where the route's own gate owes `runtime-replaced`.
   *  A non-zero exit is the unreadable cgroup that logs once and disables it. */
  private async readCgroup(): Promise<string> {
    let r: { stdout: string; stderr: string; exitCode: number };
    try {
      r = await this.run([...CGROUP_READ_ARGV]);
    } catch (err) {
      throw new MemorySampleUnavailable(errMsg(err), err instanceof RuntimeReplacedError);
    }
    if (r.exitCode !== 0) throw new Error(`cgroup read exit ${r.exitCode}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  }

  /** One sample, one structured log line (the guard's). Never on an inactive
   *  runtime — a sleeping container is not woken to be measured (item 55's
   *  rule) — and persisted for the gauges when taken. */
  private async sampleMemory(): Promise<MemoryReading | null> {
    if (!(await this.isRuntimeActive().catch(() => false))) {
      // An inactive container holds no memory: whatever the guard last read
      // came from a container that no longer runs, and a route hitting the
      // gate before anything wakes the runtime (a fresh hydration memo skips
      // the restore) must not be refused on a dead container's percent.
      this.memoryGuard.invalidate();
      return null;
    }
    const reading = await this.memoryGuard.sample(new Date(systemClock()).toISOString());
    if (reading) await this.ctx.storage.put(MEMORY_KEY, reading);
    return reading;
  }

  /** The last reading, for `/status`, `/residents` and the watchdog line —
   *  this incarnation's when it has one, else the persisted one (storage
   *  only: the watchdog never touches the container). */
  async memoryGauge(): Promise<MemoryReading | null> {
    return this.memoryGuard.lastReading ?? (await this.ctx.storage.get<MemoryReading>(MEMORY_KEY)) ?? null;
  }

  /** The resident's levels (record 0064; `levels.ts`): the seat (the
   *  thread/op user pool, whose exhaustion is the `user-pool-exhausted`
   *  refusal) and the memory line (the gate's soft side), stamped with this
   *  incarnation — the container's boot id where one is memoized, else the
   *  DO incarnation, so a boot or a replaced runtime reads as a new
   *  generation and re-states both levels. A crossing lands in the outbox
   *  and is re-offered on every answer until a newer crossing of the same
   *  name supersedes it; the bot forwards posts to `POST /plane/level`.
   *  Storage reads only — cached owner observations never grant custody, so
   *  every `/attach`, `/exec` and `/status` answer can carry the document. */
  async residentLevels(): Promise<ResidentLevelsDoc> {
    const at = new Date(systemClock()).toISOString();
    // Status never starts a VM. Count cached canonical owners and durable native
    // holds; request admission independently observes actual UID processes.
    const used = await this.activeWorkloadOwners(false, false).catch(
      () => new Set(Array.from({ length: RESIDENT_WORKLOAD_LIMIT }, (_, i) => `unknown:${i}`)),
    );
    const reading = await this.memoryGauge();
    const generation = this.containerIdMemo ?? this.incarnation;
    const seat = {
      side: seatSide(used.size, RESIDENT_WORKLOAD_LIMIT),
      used: used.size,
      total: RESIDENT_WORKLOAD_LIMIT,
    };
    const memory = { side: memorySide(reading?.percent ?? null), percent: reading?.percent ?? null };
    const next: LevelSample = { seat: seat.side, memory: memory.side, generation };
    const prev = (await this.ctx.storage.get<LevelSample>(LEVELS_LAST_KEY)) ?? null;
    const posts = levelPosts(prev, next, at);
    let outbox = (await this.ctx.storage.get<LevelPost[]>(LEVELS_OUTBOX_KEY)) ?? [];
    if (posts.length > 0) {
      outbox = mergeOutbox(outbox, posts);
      await this.ctx.storage.put(LEVELS_OUTBOX_KEY, outbox);
      await this.ctx.storage.put(LEVELS_LAST_KEY, next);
    }
    return { seat, memory, generation, at, posts: outbox };
  }

  /** The route gate (item 70): one fresh sample, then the pure verdict over
   *  the last reading. A refusal is the same 503 shape as `mirror-busy`, so
   *  the bot falls back or waits legibly — and a command already running is
   *  never touched: the gate sits at the route's start and kills nothing. */
  private async memoryGate(route: MemoryGateRoute, exemptRegisteredRun = false): Promise<ThreadErr | null> {
    await this.sampleMemory();
    // A run already in flight — registered from attach to release (item 44) —
    // is what the gate holds the resident open FOR: its re-attach (a rolled
    // container, an evicted worktree, a resume) passes as it passes the drain,
    // sampled but never refused — refusing it would strand the warm worktree
    // and lose the very work the gate protects.
    if (exemptRegisteredRun) return null;
    const refusal = this.memoryGuard.gate(route);
    if (!refusal) return null;
    const s = await this.getStatus();
    return {
      error: refusal.message,
      status: 503,
      state: s.state,
      stateReason: s.reason,
      reason: MEMORY_PRESSURE_REASON,
      cause: "system",
    };
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
   *  DISK_EVICT_MIN_IDLE_MS). The shared preservation decision admits each
   *  candidate; each is measured as its thread user for the eviction's record —
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
        if ((await this.evictBinding(current, true, "disk-pressure", DISK_PRESSURE_REASON, tree)) !== "evicted") {
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
      return { error: reason, status: 503, state: s.state, stateReason: s.reason, reason: DISK_PRESSURE_REASON };
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

  /** A running VM can predate its Worker. Probe the account-provisioning
   * protocol, but never let that capability clear a pending deployment report.
   * Attach does not replace a VM; refresh/deploy use the existing activity and
   * preservation gates before a confirmed destroy and restore. */
  private async reconcileImage(where: "attach" | "refresh" | "deploy", force = false): Promise<ImageReconcileResult> {
    const active = await this.isRuntimeActive().catch((err) => {
      console.log(`image-reconcile (${where}): activity probe failed — preserving the pending report: ${errMsg(err)}`);
      return null;
    });
    // A failed probe proves neither state. Preserve the marker and its drain
    // hold until a later reconcile confirms inactivity or hydrates a fresh
    // active container. An attach with that marker must fail closed even after
    // the drain backstop reopens: admitting it could wake a pre-deploy image.
    if (active === null) {
      if (
        where === "attach" &&
        (await this.ctx.storage.get<{ resource: string }>(IMAGE_REPORT_PENDING_KEY)) !== undefined
      ) {
        console.log(
          "image-stale (attach): activity could not be verified while a new-image report is pending — the attach is refused",
        );
        return "stale";
      }
      return "deferred";
    }
    if (!active) {
      // An inactive container's next start is on the deployed image by
      // construction. Report on every reconcile: the deploy may have marked
      // it pending after an earlier idle cycle, and the drain itself refuses
      // the attach that would otherwise wake it and provide another reporter.
      await this.reportPendingImageCurrent(where);
      return "inactive";
    }

    // A pending report marker (issue 1931) means a deploy could not verify this
    // container on its image: the protocol probe below is a capability check the
    // pre-deploy image can pass when the protocol did not change, so it can never
    // satisfy the marker — the container is treated as stale until it is
    // cycled post-deploy.
    const pending = await this.ctx.storage.get<{ resource: string }>(IMAGE_REPORT_PENDING_KEY);
    if (!force && pending === undefined) {
      const capability = ["cat", "/etc/switchboard-uid-protocol"];
      const probe = await this.run(capability);
      if (
        probe.exitCode === 0 &&
        probe.stdout === "dynamic-uid-v1\n" &&
        probe.stderr === "" &&
        !probe.timedOut &&
        !probe.truncated
      )
        return "current";
    }
    const stale = force
      ? "the container predates the deploy"
      : pending !== undefined
        ? "a deploy's new-image report is pending, so the running container cannot be trusted current"
        : "dynamic identity provisioning is unavailable on this image";
    if (where === "attach") {
      // An attach is never what restarts the container (issue 2101): the
      // post-deploy restart loop was exactly this — each attach stopped the
      // container the previous attach had stopped and probed a fresh start
      // still restoring, so the marker never cleared. While the marker is
      // pending every NEW attach is refused (`stale`) — the run takes the
      // fallback sandbox and the resident can go quiet for the refresh cycle's
      // restart; a stale pool with no marker keeps admitting onto a busy
      // container, as the deferral always did.
      if (pending === undefined && (this.inFlightCount() > 0 || (await this.registeredRunsBeyondOps()) > 0)) {
        console.log(`image-stale (attach): ${stale} but the container is busy — deferring to the refresh cycle`);
        return "deferred";
      }
      console.log(`image-stale (attach): ${stale} — the attach is refused; the refresh cycle restarts the container`);
      return "stale";
    }
    const busy = this.inFlightCount();
    if (busy > 0) {
      console.log(`image-stale (${where}): ${stale} but ${busy} operation(s)/attach(es) in flight — deferring restart`);
      return "deferred";
    }
    const registered = await this.registeredRunsBeyondOps();
    if (registered > 0) {
      console.log(
        `image-stale (${where}): ${stale} but ${registered} run registration(s) live — deferring restart until the resident is quiet`,
      );
      return "deferred";
    }
    let deployStopFailed = false;
    const restarted = await this.automaticContainerLoss(stale, async () => {
      console.log(`image-stale (${where}): ${stale} — stopping so it restarts on the current image`);
      this.swapIncarnation(); // deliberate incarnation swap
      try {
        await this.stop();
      } catch (err) {
        console.log(`image-stale: stop failed: ${errMsg(err)}`);
        deployStopFailed = where === "deploy";
      }
    });
    if (!restarted || deployStopFailed) return "deferred";
    // A successful stop proves only that the old process is gone. The pending
    // marker deliberately survives it: the replacement's own hydration reports
    // after reaching `warm`, so `imageReport: current` can never precede a
    // successful post-deploy start (issue 2101).
    return "restarted";
  }

  /** The report a held drain waits for (issue 1931): when the deploy's
   *  reconcile could not verify this resident's fresh container on the new
   *  image, a marker stays in storage and the registry holds the drain. The
   *  fact the report stands on is either an inactive runtime, whose next start
   *  uses the deployed image by construction, or the active replacement's own
   *  completed hydration: the fresh container has restored its snapshot and
   *  reached `warm`. A stop alone does not report (issue 2101). The marker is
   *  deleted only after a successful report: a transient failure keeps it for
   *  the next reconcile, and the drain's `until` is the backstop for a report
   *  that never lands. */
  private async reportPendingImageCurrent(where: string): Promise<boolean> {
    const pending = await this.ctx.storage.get<{ resource: string }>(IMAGE_REPORT_PENDING_KEY);
    if (pending === undefined) return true;
    try {
      const { lifted } = await registryStub(this.env).reportContainerImageCurrent(pending.resource);
      await this.ctx.storage.delete(IMAGE_REPORT_PENDING_KEY);
      console.log(
        `[reconcile] ${pending.resource} reports the deploy's image (${where})${lifted ? " — drain lifted" : ""}`,
      );
      return true;
    } catch (err) {
      console.log(
        `[reconcile] ${pending.resource}: the new-image report failed (${where}): ${errMsg(err)} — retried on the next reconcile`,
      );
      return false;
    }
  }

  /** The deploy's reconcile, inside the drain window (item 69's order: the
   *  runs in flight end, the swap lands, the containers reconcile, the fleet
   *  reopens): `POST /reconcile` calls this on every resident after the Worker
   *  deploy landed and BEFORE the drain is lifted. The pool-user probe cannot
   *  tell the pre-deploy image from the new one when the pool did not change,
   *  and the platform replaces the container processes asynchronously after an
   *  image-changing deploy (issue 1931) — so this path never trusts "current":
   *  an active, quiet container is always cycled, but that stop is not a report.
   *  The marker survives until the replacement hydrates and reaches `warm` on
   *  the deploy's image (issue 2101: the old probe raced that restore and lost).
   *  `verified` true is the fact the reopen may stand on: inactivity reports
   *  at once, while an active container's cycle leaves a hold until its fresh
   *  hydration calls `reportPendingImageCurrent`, never until a timer.
   *
   *  The hold lands BEFORE the marker: the marker is what lets any concurrent
   *  attach/refresh reconcile report, and a report that reaches the registry
   *  before the hold is a no-op — the marker would be consumed and the hold
   *  added afterwards would wait for a report nothing sends (until the drain's
   *  `until`). Held first, every report finds its hold. */
  async reconcileForDeploy(
    resource: string,
    input: unknown,
  ): Promise<{ result: ImageReconcileResult; verified: boolean }> {
    const target = residentImageTargetSchema.safeParse(input);
    if (!target.success || target.data.application !== `${this.env.RESIDENT_SCRIPT_NAME}-residentdo`) {
      console.log(
        JSON.stringify({
          event: "resident-image-target-refused",
          resource,
          expected: `${this.env.RESIDENT_SCRIPT_NAME ?? "missing"}-residentdo`,
          received: target.success ? target.data.application : null,
        }),
      );
      return { result: "deferred", verified: false };
    }
    // The deploy's image report and an idle pool recycle both reason about the
    // same VM. Admit reconciliation as disk work before its first await, so a
    // recycle sees it as busy; a recycle already holding admission defers this
    // pass for the deploy's bounded readiness retry.
    const admitted = await this.withRecreateSafeAdmin(() => this.reconcileForDeployAdmitted(resource, target.data));
    return "error" in admitted ? { result: "deferred", verified: false } : admitted;
  }

  private async reconcileForDeployAdmitted(
    _resource: string,
    target: ResidentImageTarget,
  ): Promise<{ result: ImageReconcileResult; verified: boolean }> {
    const progress = await this.ctx.storage.get<DeployImageReconcileState>(IMAGE_RECONCILE_KEY);
    const pending = await this.ctx.storage.get<{ resource: string }>(IMAGE_REPORT_PENDING_KEY);
    const action = nextDeployImageReconcile(BUILD_ID, progress, pending !== undefined, target);
    if (action === "await-target")
      throw new Error("desired image target changed while an earlier image report remains pending");
    if (action === "verified") return { result: "current", verified: true };
    if (action === "start") {
      await registryStub(this.env).holdDrainFor([await this.residentIdentity()]);
      await this.ctx.storage.put(IMAGE_REPORT_PENDING_KEY, { resource: await this.residentIdentity() });
      await this.ctx.storage.put(IMAGE_RECONCILE_KEY, { build: BUILD_ID, target, cycleIssued: false });
    }
    if (action === "await-report") {
      const active = await this.isRuntimeActive().catch(() => null);
      if (active === false) await this.reportPendingImageCurrent("deploy");
      else if (active === true) {
        const [state, facts] = await Promise.all([
          this.ctx.storage.get<ResidentState>(STATE_KEY),
          this.ctx.storage.get<RepoFacts>(FACTS_KEY),
        ]);
        // A replacement can reuse the disk and leave `warm` unchanged; that
        // hydrate shortcut does not send a report. A different boot after the
        // successful stop is proof that a replacement started. Finish its
        // hydration before reporting; an old warm state alone proves nothing.
        if (replacementContainerStarted(progress?.containerBeforeCycle, await this.containerIdentity())) {
          await this.ensureHydrated();
          await this.reportPendingImageCurrent("deploy");
        } else if (
          state === "warm" &&
          facts?.lastRestore?.at &&
          Date.parse(facts.lastRestore.at) >= Date.parse(progress?.cycleStoppedAt ?? "")
        ) {
          await this.reportPendingImageCurrent("deploy");
        }
      }
      return {
        result: active === false ? "inactive" : "deferred",
        verified: (await this.ctx.storage.get(IMAGE_REPORT_PENDING_KEY)) === undefined,
      };
    }
    // Reading the boot ID runs a command and would wake a sleeping resident.
    // Preserve the inactive path's report-without-start behavior.
    const activeBeforeCycle = await this.isRuntimeActive().catch(() => null);
    const containerBeforeCycle = activeBeforeCycle === true ? await this.containerIdentity() : undefined;
    const result = await this.reconcileImage("deploy", true);
    if (result === "restarted")
      await this.ctx.storage.put(IMAGE_RECONCILE_KEY, {
        build: BUILD_ID,
        target,
        cycleIssued: true,
        cycleStoppedAt: new Date(systemClock()).toISOString(),
        containerBeforeCycle,
      } satisfies DeployImageReconcileState);
    if (result === "deferred") return { result, verified: false };
    // Inactivity reports synchronously; a successful stop does not. A
    // concurrent fresh start may also have hydrated while this reconcile
    // yielded, hence the storage read rather than a verdict from `result`.
    const verified = (await this.ctx.storage.get(IMAGE_REPORT_PENDING_KEY)) === undefined;
    return { result, verified };
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
    /** Item 70: the last memory reading, storage only — the tick's gauge. */
    memory: MemoryReading | null;
    /** Item 7: what the cron's instance-creation decision reads, after the check above settled the state. */
    refresh: RefreshRow;
  }> {
    await this.reconcileWorkspaceSettlements();
    const [check, disk, memory] = await Promise.all([
      this.watchdogCheckLifecycle(),
      this.diskGauge(),
      this.memoryGauge(),
    ]);
    return { ...check, disk, memory, refresh: await this.refreshRow() };
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
    if (user !== BUILD_USER && (!isResidentPoolUser(user) || !(await this.poolUserOwnerMatches(user))))
      throw new Error("pool-owner-mismatch: model command refused before UID ownership");
    // The caller's variables (an /exec body's `env`, docs/reference/specs/
    // harness-pi.md item 4) under the Worker's own: a caller never overrides
    // what the Worker injects. `su` without `-` keeps this environment for the
    // thread user's shell.
    const injected = { ...(env ?? {}), GIT_TERMINAL_PROMPT: "0" };
    validateEnvNames(injected);
    const body = capBytes
      ? capWrappedCommand(worktreePath, command, capBytes, capFiles)
      : `cd ${worktreePath} && ${command}`;
    const owned = this.threadOperationScope?.getStore() ?? this.opOperationScope?.getStore();
    return this.run(owned ? ["/bin/bash", "-c", body] : ["su", "-s", "/bin/bash", user, "-c", body], {
      timeoutMs,
      env: injected,
      ...(owned ? { nativeUser: user } : {}),
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

  /** A candidate remains reserved across the disk inspection's awaits. */
  private poolUsersInspecting = new Set<string>();

  /** A UID is spent before any untrusted command receives it. The storage
   * transaction prevents concurrent admissions from losing each other's
   * marks. An old resident without this row is an unknown generation. */
  private async markPoolUserSpent(user: string, owner: string): Promise<boolean> {
    return this.ctx.storage.transaction((txn) => claimUid(txn, user, owner));
  }

  private async currentUidLedger() {
    const ledger = await this.ctx.storage.transaction((txn) => uidLedger(txn));
    return [...ledger].map(([user, owner]) => ({ user, owner }));
  }

  private async rebuildPoolBindingIndex(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const bindings = await txn.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
      const users = [
        ...new Set([
          ...(await uidLedger(txn).catch(() => new Map<string, string>())).keys(),
          ...[...bindings.values()]
            .filter((binding) => !binding.evicted && binding.user)
            .map((binding) => binding.user),
        ]),
      ];
      const byUser = rebuildPoolBindingIndex(bindings.values(), users);
      if (!byUser) throw new Error("pool-binding-index: malformed live binding; refusing resident work");
      for (const [user, keys] of byUser) await txn.put(poolBindingKey(user), keys);
    });
  }

  /** Primary and per-UID rows change atomically. The index keeps every live
   * claimant, including a legacy duplicate that must block shell access. */
  private async putThreadBinding(next: ThreadBinding, replaceWorkspaceFacts = false): Promise<void> {
    const key = threadBindingKey(next.threadKey);
    await this.ctx.storage.transaction(async (txn) => {
      const prior = await txn.get<ThreadBinding>(key);
      const scope = this.threadOperationScope?.getStore();
      const retired = await txn.get<WorkspaceOwner>(`discarded-thread:${next.threadKey}`);
      if (await txn.get(`discarding:${next.threadKey}`)) throw new Error("workspace discarded");
      let newWorkspaceAfterDiscard = false;
      if (retired) {
        const fence = await txn.get<unknown>(runFenceKey(next.threadKey));
        const registration = await txn.get<RunRegistration>(runRegKey(next.threadKey));
        const samePlacement =
          prior &&
          ["threadKey", "ref", "container", "worktreePath", "boundAt"].every(
            (field) => next[field as keyof ThreadBinding] === prior[field as keyof ThreadBinding],
          );
        const sameAllocation = prior && next.user === prior.user && next.evicted === prior.evicted;
        const currentOwner =
          isWorkspaceOwner(retired) &&
          isWorkspaceOwner(registration) &&
          isWorkspaceOwner(fence) &&
          registration.ownerFence > retired.ownerFence &&
          workspaceOwnerKey(registration) === workspaceOwnerKey(fence);
        const ownerMetadata =
          currentOwner &&
          isWorkspaceOwner(next.lastRunOwner) &&
          workspaceOwnerKey(next.lastRunOwner) === workspaceOwnerKey(registration!);
        const currentRelease = ownerMetadata && next.evicted && next.user === "" && prior && !prior.evicted;
        const sameSnapshot =
          samePlacement &&
          next.lastAttachAt === prior!.lastAttachAt &&
          (currentRelease ||
            (sameAllocation &&
              (ownerMetadata || JSON.stringify(next.lastRunOwner) === JSON.stringify(prior!.lastRunOwner))));
        const activeOwner = scope?.active && scope.threadKey === next.threadKey && isWorkspaceOwner(scope.owner);
        const attachment =
          activeOwner &&
          scope.attachment &&
          isWorkspaceOwner(retired) &&
          scope.owner.ownerFence > retired.ownerFence &&
          isWorkspaceOwner(fence) &&
          registeredRunAllowsClaim(fence, scope.owner.runId, scope.owner.ownerGen, scope.owner.ownerFence) &&
          registeredRunAllowsClaim(registration, scope.owner.runId, scope.owner.ownerGen, scope.owner.ownerFence);
        const currentScope =
          activeOwner && currentOwner && workspaceOwnerKey(scope.owner) === workspaceOwnerKey(registration!);
        newWorkspaceAfterDiscard = !!(attachment && prior?.evicted);
        if (
          !isWorkspaceOwner(retired) ||
          !(
            attachment ||
            (currentScope && samePlacement && (sameAllocation || currentRelease)) ||
            (!scope && sameSnapshot)
          )
        )
          throw new Error("workspace discarded");
      }
      if (scope && (await txn.get(`cancelled:${next.threadKey}:${scope.owner.runId}`)))
        throw new RunCancelledError("run cancelled");
      if (await txn.get(`cancel-control:${next.threadKey}`))
        throw new RunCancelledError("workspace cancellation is in progress");
      const loss =
        newWorkspaceAfterDiscard && retired
          ? await txn.get<{ completed?: boolean; binding?: ThreadBinding }>(
              `discarded:${next.threadKey}:${retired.runId}`,
            )
          : undefined;
      const remainingPredecessors = newWorkspaceAfterDiscard
        ? prior?.workspacePredecessors?.filter(
            (p) =>
              !isWorkspaceOwner(p.owner) ||
              !isWorkspaceOwner(retired) ||
              workspaceOwnerKey(p.owner) !== workspaceOwnerKey(retired) ||
              !loss?.completed ||
              !loss.binding ||
              p.binding?.ref !== loss.binding.ref ||
              p.binding?.workspace !== loss.binding.worktreePath ||
              p.binding?.user !== loss.binding.user ||
              p.binding?.container !== loss.binding.container,
          )
        : prior?.workspacePredecessors;
      const oldUser = prior && !prior.evicted ? prior.user : "";
      const newUser = !next.evicted ? next.user : "";
      if (oldUser && !isResidentPoolUser(oldUser)) throw new Error("pool-binding-index: unknown old UID");
      if (newUser && !isResidentPoolUser(newUser)) throw new Error("pool-binding-index: unknown new UID");
      if (oldUser !== newUser) {
        if (oldUser) {
          const keys = releasePoolBinding(await txn.get<unknown>(poolBindingKey(oldUser)), next.threadKey);
          if (!keys) throw new Error("pool-binding-index: missing old claimant");
          await txn.put(poolBindingKey(oldUser), keys);
        }
        if (newUser) {
          const keys = claimPoolBinding(await txn.get<unknown>(poolBindingKey(newUser)), next.threadKey);
          if (!keys) throw new Error("pool-binding-index: conflicting new claimant");
          await txn.put(poolBindingKey(newUser), keys);
        }
      }
      await txn.put(
        key,
        prior && !replaceWorkspaceFacts
          ? {
              ...next,
              workspacePredecessors: remainingPredecessors,
              workspaceSettlement: newWorkspaceAfterDiscard ? undefined : prior.workspaceSettlement,
              ownBranches: prior.ownBranches,
            }
          : next,
      );
    });
  }

  private async deleteThreadBinding(threadKey: string, onlyEvicted = false): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const key = threadBindingKey(threadKey);
      const prior = await txn.get<ThreadBinding>(key);
      if (!prior || (onlyEvicted && !prior.evicted)) return false;
      if (!prior.evicted && prior.user) {
        const keys = releasePoolBinding(await txn.get<unknown>(poolBindingKey(prior.user)), threadKey);
        if (!keys) throw new Error("pool-binding-index: missing deleted claimant");
        await txn.put(poolBindingKey(prior.user), keys);
      }
      await txn.delete(key);
      return true;
    });
  }

  /** Every UID-scoped action checks both the durable claimant and the live
   * bindings. Two retained bindings naming one UID fail closed, even when one
   * is the ledger owner. Ops have a separate exact in-flight owner. */
  private async poolUserOwnerMatches(user: string, expectedOwner?: string): Promise<boolean> {
    if (!isResidentPoolUser(user)) return false;
    const [owner, bindings] = await Promise.all([
      this.ctx.storage.transaction((txn) => uidOwner(txn, user)),
      this.ctx.storage.get<unknown>(poolBindingKey(user)),
    ]);
    const liveThreadKeys = parsePoolBindings(bindings);
    if (!liveThreadKeys) return false;
    return mayRunAsPoolUser(
      owner ? [{ user, owner }] : [],
      undefined,
      user,
      liveThreadKeys,
      this.opUsersInUse.get(user),
      expectedOwner,
    );
  }

  /** Root-side inspection fails closed on a missing/partial answer. A former
   * binding may have been freed by an old image while its private tree stayed
   * on disk; assigning that UID would let a new run read the old tree. */
  private async poolUserHasOldThreadDir(user: string, allowed: readonly string[]): Promise<boolean> {
    for (const dir of [THREADS_DIR, OPS_DIR]) {
      const result = await this.run([
        "sh",
        "-c",
        'if test -L "$1"; then exit 42; fi; if test -d "$1"; then find "$1" -mindepth 1 -maxdepth 1 -type d -uid "$2" -print; fi',
        "_",
        dir,
        String(Number(user.slice(6)) + 2000),
      ]);
      if (result.exitCode !== 0 || result.timedOut || result.truncated)
        throw new Error("pool-user-disk-scan-incomplete");
      if (hasUnexpectedOwnedThreadDir(result.stdout, dir, dir === THREADS_DIR ? allowed : [])) return true;
    }
    return false;
  }

  /** A freed UID may still have a pre-fix credential or staged write in its
   *  private staging directory. Inspect as root before assigning it to an op
   *  (which does not run attach's credential scrub) or a fresh thread. */
  private async poolUserHasOldStageContent(user: string): Promise<boolean> {
    const result = await this.run(legacyStageContentScanCommand(`/workspace/.stage-${user}`));
    if (result.exitCode !== 0 || result.timedOut || result.truncated || result.stderr !== "")
      throw new Error("pool-user-stage-scan-incomplete");
    if (result.stdout === "stale\n") return true;
    if (result.stdout === "clean\n") return false;
    throw new Error("pool-user-stage-scan-invalid");
  }
  /** The same verified account may be recreated after the VM's disk is
   * lost. This touches no workspace and grants no new ownership. */
  private async ensurePoolAccount(user: string): Promise<ThreadErr | null> {
    try {
      const result = await this.run(provisionUidCommand(user), { nativeAccount: user });
      if (
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.truncated &&
        result.stderr === "" &&
        result.stdout === "account-ready\n"
      )
        return null;
    } catch {
      // The admitted native journal retains any unknown outcome.
    }
    return {
      error: "workspace account creation could not be verified",
      status: 503,
      reason: "workload-unverified",
      cause: "system",
    };
  }

  /** Durable reservation precedes native creation. The existing native
   * admission tracks creation until its result is observed. */
  private async reserveSafePoolUser(owner: string, _excludeThreadKey?: string): Promise<string | ThreadErr> {
    let user: string;
    try {
      user = await this.ctx.storage.transaction(async (txn) => {
        const reserved = await reserveUid(txn, owner);
        const key = poolBindingKey(reserved);
        if ((await txn.get(key)) === undefined) await txn.put(key, []);
        return reserved;
      });
    } catch {
      return {
        error: "UID reservation could not be verified",
        status: 503,
        reason: "workload-unverified",
        cause: "system",
      };
    }
    if (this.poolUsersInspecting.has(user) || this.opUsersInUse.has(user))
      return { error: "workspace identity is busy", status: 409, reason: "busy", cause: "system" };
    this.poolUsersInspecting.add(user);
    let ready = false;
    try {
      const refused = await this.ensurePoolAccount(user);
      if (refused) return refused;
      if ((await this.poolUserHasOldThreadDir(user, [])) || (await this.poolUserHasOldStageContent(user)))
        return { error: "pool-user-contaminated: workspace identity retains private files", status: 503 };
      ready = true;
      return user;
    } catch {
      return {
        error: "workspace account creation could not be verified",
        status: 503,
        reason: "workload-unverified",
        cause: "system",
      };
    } finally {
      if (!ready) this.poolUsersInspecting.delete(user);
    }
  }

  /** The prior binding read, allocation and possible rollback are one
   *  same-thread operation, even while an attach awaits disk or Git. */
  private readonly threadAttaches = new KeyedAsyncLock();
  private readonly runCancellations = new KeyedAsyncLock();
  private readonly runNativeScopes = new Map<string, number>();
  private async cancellationPending(threadKey: string): Promise<boolean> {
    const held = await this.ctx.storage.get<{ runId?: unknown; cancellationId?: unknown }>(
      `cancel-control:${threadKey}`,
    );
    if (held === undefined) return false;
    if (typeof held?.runId !== "string" || typeof held.cancellationId !== "string") return true;
    const receipt = await this.ctx.storage.get<{ stopped?: unknown; cancellation?: { id?: unknown } }>(
      `cancelled:${threadKey}:${held.runId}`,
    );
    return receipt?.stopped !== true || receipt.cancellation?.id !== held.cancellationId;
  }
  private readonly workloadAdmissions = new KeyedAsyncLock();
  private readonly workloadReservations = new Set<string>();

  /** Count active owners, not historical UID spends or retained private files.
   * Native operations and current UID processes remain occupied after a reset. */
  private async activeWorkloadOwners(
    probeProcesses = true,
    observeCanonical = true,
    audit?: WorkloadAuditCapture,
    runtimeRecovery: "account" | "observe" = "account",
  ): Promise<Set<string>> {
    const owners = new Set([...this.workloadReservations, ...this.opUsersInUse.values()]);
    if (audit) audit.owners = owners;
    const record = (key: string, source: WorkloadAuditSource) => {
      if (!audit) return;
      const sources = audit.sources.get(key) ?? [];
      sources.push(source);
      audit.sources.set(key, sources);
    };
    for (const key of this.workloadReservations) record(key, { kind: "reservation" });
    for (const [user, key] of this.opUsersInUse) record(key, { kind: "operator", user });
    const [bindings, registrations, native] = await Promise.all([
      this.liveBindings(),
      this.ctx.storage.list<RunRegistration>({ prefix: RUN_REG_KEY_PREFIX }),
      new NativeOperationJournal(this.ctx.storage).unresolved() as Promise<
        Map<string, Partial<WorkspaceOwner> & { opOwner?: string }>
      >,
    ]);
    // Validate the generation once. Each current owner then uses an indexed
    // read, independent of the number of historical identities.
    await this.ctx.storage.transaction((txn) => issuedUidCount(txn));
    const now = systemClock();
    await Promise.all(
      bindings.map(async (binding) => {
        const key = `thread:${binding.threadKey}`;
        if (owners.has(key)) {
          record(key, {
            kind: "binding",
            threadKey: binding.threadKey,
            user: binding.user,
            reason: "already-reserved",
            lastAttachAt: binding.lastAttachAt,
          });
          return;
        }
        const registration = registrations.get(runRegKey(binding.threadKey));
        const [fence, owner, claimants, recordedOwner] = await Promise.all([
          this.ctx.storage.get(runFenceKey(binding.threadKey)),
          registration?.runId
            ? observeCanonical
              ? this.observeRunForEviction(registration, binding)
              : this.ctx.storage
                  .get<{ runId: string; ownerGen: string; ownerFence: number; observation: unknown }>(
                    `resident:workloadOwner:${binding.threadKey}`,
                  )
                  .then((cached) =>
                    cached &&
                    cached.runId === registration.runId &&
                    cached.ownerGen === registration.ownerGen &&
                    cached.ownerFence === registration.ownerFence
                      ? cached.observation
                      : null,
                  )
            : Promise.resolve(null),
          this.ctx.storage.get(poolBindingKey(binding.user)),
          this.ctx.storage.transaction((txn) => uidOwner(txn, binding.user)),
        ]);
        const { state, category, reason } = classifyDeployRegistrationWithLedger({
          threadKey: binding.threadKey,
          registration,
          fence,
          lastRunOwner: binding.lastRunOwner,
          owner,
          lastAttachAt: binding.lastAttachAt,
          cutoff: now - CLEAN_IDLE_RELEASE_S * 1000,
          now,
          graceMs: RUN_REGISTRATION_GRACE_MS,
          opInFlight: this.threadOpsInFlight.get(binding.threadKey) ?? 0,
          ledger: recordedOwner === null ? [] : [{ user: binding.user, owner: recordedOwner }],
          claimants,
          user: binding.user,
          pool: undefined,
        });
        record(key, {
          kind: "binding",
          threadKey: binding.threadKey,
          user: binding.user,
          runId: registration?.runId,
          ownerGen: registration?.ownerGen,
          ownerFence: registration?.ownerFence,
          registeredAt: registration?.registeredAt,
          deadlineAt: registration?.deadlineAt,
          lastAttachAt: binding.lastAttachAt,
          state,
          category,
          reason,
          canonicalKind:
            audit && registration
              ? (this.workloadOwnerObservation(registration, owner)?.kind ?? "unknown")
              : "unavailable",
        });
        // Only positively terminal ownership removes a held tree from this
        // workload count. A binding without a run registration is still unknown.
        if (state !== "retained" || category !== "owned") owners.add(key);
      }),
    );
    for (const [key, owner] of native) {
      const requestScope = this.opOperationScope?.getStore();
      const operation = owner as { origin?: unknown; native?: { scope?: unknown } };
      if (
        requestScope?.active &&
        !requestScope.allocated &&
        key === requestScope.key &&
        owner.opOwner === requestScope.owner &&
        JSON.stringify(operation.origin) === JSON.stringify(requestScope.origin) &&
        operation.native?.scope === undefined &&
        unstartedNativeOperator(owner, requestScope.owner) &&
        !this.workloadReservations.has(requestScope.owner) &&
        ![...this.opUsersInUse.values()].includes(requestScope.owner)
      )
        continue;
      const end = validRunOwner(owner?.runId, owner?.ownerGen, owner?.ownerFence)
        ? key.lastIndexOf(`:${owner.runId}:`)
        : -1;
      const thread = end > "native-operation:".length ? key.slice("native-operation:".length, end) : "";
      const ownerKey =
        typeof owner?.opOwner === "string" && /^op:\S+$/.test(owner.opOwner)
          ? owner.opOwner
          : THREAD_KEY_RE.test(thread)
            ? `thread:${thread}`
            : `native:${key}`;
      if (audit) {
        const original = owner as {
          native?: {
            closed?: unknown;
            pending?: Record<string, { process?: { id?: unknown; pid?: unknown; startedAt?: unknown } }>;
          };
        };
        const pending = original?.native?.pending;
        const attempts = pending && typeof pending === "object" ? Object.values(pending) : [];
        const processes = attempts.flatMap((attempt) => {
          const p = attempt?.process;
          return p &&
            typeof p.id === "string" &&
            p.id.length <= 256 &&
            Number.isSafeInteger(p.pid) &&
            Number(p.pid) > 0 &&
            typeof p.startedAt === "string" &&
            Number.isFinite(Date.parse(p.startedAt))
            ? [{ id: p.id, pid: Number(p.pid), startedAt: p.startedAt }]
            : [];
        });
        audit.nativeRecords.set(key, owner);
        if (processes.length > 64) {
          audit.complete = false;
          audit.issues.push("native-process-identities-omitted");
        }
        record(ownerKey, {
          kind: "native-operation",
          key,
          runId: owner?.runId,
          ownerGen: owner?.ownerGen,
          ownerFence: owner?.ownerFence,
          ...(THREAD_KEY_RE.test(thread) ? { threadKey: thread } : {}),
          ...(typeof original?.native?.closed === "boolean" ? { closed: original.native.closed } : {}),
          pendingAttempts: attempts.length,
          processes: processes.slice(0, 64),
        });
      }
      if (typeof owner?.opOwner === "string" && /^op:\S+$/.test(owner.opOwner)) {
        owners.add(owner.opOwner);
        continue;
      }
      owners.add(THREAD_KEY_RE.test(thread) ? `thread:${thread}` : `native:${key}`);
    }
    if (probeProcesses && (await this.isRuntimeActive())) {
      const processes = await this.run(
        ["ps", "-eo", "user="],
        runtimeRecovery === "observe" ? { runtimeRecovery: "observe" } : {},
      );
      if (processes.exitCode !== 0 || processes.timedOut || processes.truncated || processes.stderr !== "")
        throw new Error("resident process observation is incomplete");
      if (audit) audit.processes = "identities-only";
      for (const name of new Set(
        processes.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      )) {
        if (!/^(?:[A-Za-z_][A-Za-z0-9_.+-]*\$?|\d+)$/.test(name))
          throw new Error("resident process observation is invalid");
        const user =
          /^\d+$/.test(name) && Number(name) >= 2002 && Number(name) <= 2_147_483_647
            ? `worker${Number(name) - 2000}`
            : name;
        if (user === BUILD_USER) continue;
        if (user.startsWith("worker") && !isResidentPoolUser(user))
          throw new Error("resident process identity is unverified");
        if (isResidentPoolUser(user)) {
          const recorded = await this.ctx.storage.transaction((txn) => uidOwner(txn, user));
          owners.add(recorded ?? `uid:${user}`);
          record(recorded ?? `uid:${user}`, {
            kind: "process",
            user,
            reason: recorded === null ? "uid-owner-unverified" : "identity-observed",
          });
        }
      }
    } else if (probeProcesses && audit) {
      audit.processes = "runtime-inactive";
    }
    return owners;
  }

  private async workloadRecordHash(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private async hashWorkloadAudit(owners: Set<string>, audit: WorkloadAuditCapture): Promise<void> {
    // Hash the retained original rows only when a report is needed. Successful
    // admissions keep the counter's indexed reads and avoid this extra await.
    for (const owner of [...owners].sort().slice(0, 128)) {
      for (const source of (audit.sources.get(owner) ?? []).slice(0, 16)) {
        if (source.kind !== "native-operation" || !source.key) continue;
        try {
          source.recordHash = await this.workloadRecordHash(audit.nativeRecords.get(source.key));
        } catch {
          audit.complete = false;
          audit.issues.push("native-record-hash-unavailable");
        }
      }
    }
  }

  private async workloadAuditReport(
    resource: string,
    owners: Set<string> | null,
    audit: WorkloadAuditCapture,
    expectedResidentId?: string,
  ): Promise<WorkloadAudit> {
    let residentId = resource;
    try {
      const stored = await this.ctx.storage.get<unknown>(RESIDENT_ID_KEY);
      if (stored === undefined) {
        if (expectedResidentId !== undefined && expectedResidentId !== resource)
          throw new Error("resident identity is not initialized");
      } else {
        if (typeof stored !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,62}$/.test(stored))
          throw new Error("resident identity is invalid");
        if (expectedResidentId !== undefined && stored !== expectedResidentId)
          throw new Error("resident identity does not match");
        residentId = stored;
      }
    } catch {
      residentId = "unknown";
      audit.complete = false;
      audit.issues.push("resident-identity-unavailable");
    }
    const entries = [...(owners ?? audit.owners ?? [])].sort();
    const selected = entries.slice(0, 128);
    let sourcesOmitted = 0;
    const rows = selected.map((key) => {
      const sources = audit.sources.get(key) ?? [];
      sourcesOmitted += Math.max(0, sources.length - 16);
      return { key, sources: sources.slice(0, 16) };
    });
    const ownersOmitted = Math.max(0, entries.length - rows.length);
    const issues = [...new Set(audit.issues)];
    const report: WorkloadAudit = {
      schema: 1,
      resource,
      residentId,
      build: injectedBuildStamp(),
      asOf: audit.asOf,
      finishedAt: new Date(systemClock()).toISOString(),
      incarnation: this.incarnation,
      boot: { id: this.containerIdMemo ?? null, observation: this.containerIdMemo ? "cached" : "unknown" },
      consistency: "best-effort",
      workloadLimit: RESIDENT_WORKLOAD_LIMIT,
      used: owners?.size ?? null,
      complete: owners !== null && ownersOmitted === 0 && sourcesOmitted === 0 && audit.complete,
      ownersOmitted,
      sourcesOmitted,
      detailsOmitted: 0,
      processes: audit.processes,
      issues,
      uidHistory: audit.uidHistory ?? { issued: null, complete: false },
      owners: rows,
    };
    // Preserve compact identities first, then spend the remaining UTF-8 budget
    // on source detail. Never serialize one giant document to find its size.
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const budget = 60 * 1024;
    const fullSize = bytes({ ...report, owners: [] }) + rows.reduce((n, row) => n + bytes(row) + 1, 0);
    if (fullSize > budget - 128) {
      report.complete = false;
      report.issues.push("workload-details-omitted");
      report.owners = rows.map(({ key, sources }) => ({
        key,
        sources: sources.map(({ kind, recordHash }) => ({ kind, ...(recordHash ? { recordHash } : {}) })),
      }));
      while (report.owners.length && bytes(report) > budget - 128) {
        const removed = report.owners.pop()!;
        report.ownersOmitted++;
        report.sourcesOmitted += removed.sources.length;
      }
      let size = bytes(report);
      for (let i = 0; i < report.owners.length; i++) {
        for (let j = 0; j < report.owners[i].sources.length; j++) {
          const delta = bytes(rows[i].sources[j]) - bytes(report.owners[i].sources[j]);
          if (size + delta <= budget - 128) {
            report.owners[i].sources[j] = rows[i].sources[j];
            size += delta;
          } else report.detailsOmitted++;
        }
      }
    }
    return report;
  }

  /** Read the admission algorithm's evidence without allocating an identity,
   * starting an inactive VM, or interpreting an unknown hold as leaked work. */
  async getWorkloadAudit(resource: string, expectedResidentId = resource): Promise<WorkloadAudit> {
    const audit: WorkloadAuditCapture = {
      asOf: new Date(systemClock()).toISOString(),
      sources: new Map(),
      nativeRecords: new Map(),
      complete: true,
      processes: "not-observed",
      issues: [],
    };
    let owners: Set<string>;
    try {
      owners = await this.workloadAdmissions.run("workload", () =>
        this.activeWorkloadOwners(true, true, audit, "observe"),
      );
    } catch (error) {
      audit.complete = false;
      audit.processes = "unavailable";
      audit.issues.push("workload-observation-unavailable");
      try {
        const name = (error as { name?: unknown } | null)?.name;
        console.warn(
          `[workload] ${JSON.stringify({ event: "workload-observation-unavailable", resource, errorType: typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : typeof error })}`,
        );
      } catch {
        /* A failed warning cannot replace the captured partial report. */
      }
      return this.workloadAuditReport(resource, null, audit, expectedResidentId);
    }
    // The captured counter is stable evidence. Optional enrichment must not
    // hold admission while waiting for historical owners or UID metadata.
    await this.hashWorkloadAudit(owners, audit);
    const observedOwners = new Map<string, Promise<unknown>>();
    const selected = [...owners]
      .sort()
      .slice(0, 128)
      .flatMap((key) => (audit.sources.get(key) ?? []).slice(0, 16));
    await Promise.all(
      selected.map(async (source) => {
        if (
          source.kind !== "native-operation" ||
          !source.threadKey ||
          !validRunOwner(source.runId, source.ownerGen, source.ownerFence)
        )
          return;
        const owner = {
          threadKey: source.threadKey,
          runId: source.runId!,
          ownerGen: source.ownerGen!,
          ownerFence: source.ownerFence!,
        };
        const key = JSON.stringify(owner);
        let pending = observedOwners.get(key);
        if (!pending) {
          pending = this.observeRunForEviction(owner).then((view) => this.workloadOwnerObservation(owner, view));
          observedOwners.set(key, pending);
        }
        const observation = (await pending) as {
          kind?: string;
          revision?: number;
          record?: { status?: string };
        } | null;
        source.canonicalKind = observation?.kind ?? "unknown";
        source.canonicalRevision = observation?.revision;
        source.canonicalStatus = observation?.record?.status;
        source.canonicalObservedAt = new Date(systemClock()).toISOString();
      }),
    );
    // The full generation read is diagnostic only. Normal admission keeps
    // its indexed UID lookups and never counts historical allocations.
    try {
      const ledger = await this.currentUidLedger();
      const byUser = new Map(ledger.map(({ user, owner }) => [user, owner]));
      audit.uidHistory = { issued: ledger.length, complete: true };
      for (const { user, owner } of ledger) {
        if (!owners.has(owner)) continue;
        const sources = audit.sources.get(owner) ?? [];
        let reason = "recorded-owner";
        if (owner.startsWith("thread:")) {
          const claims = parsePoolBindings(await this.ctx.storage.get(poolBindingKey(user)));
          if (!claims || claims.length > 1 || (claims.length === 1 && owner !== `thread:${claims[0]}`)) {
            reason = "uid-claims-unverified";
            audit.issues.push(reason);
          } else if (claims.length === 0) reason = "no-current-binding";
        }
        sources.push({ kind: "uid-allocation", user, reason });
        audit.sources.set(owner, sources);
      }
      for (const owner of owners) {
        for (const source of audit.sources.get(owner) ?? []) {
          if (source.user && byUser.get(source.user) !== owner) {
            source.reason = "uid-owner-unverified";
            audit.issues.push("uid-owner-unverified");
          }
        }
      }
    } catch {
      audit.complete = false;
      audit.uidHistory = { issued: null, complete: false };
      audit.issues.push("uid-history-unavailable");
    }
    const report = await this.workloadAuditReport(resource, owners, audit, expectedResidentId);
    try {
      console.log(
        `[workload] ${JSON.stringify({ event: "workload-audit", resource: report.resource, residentId: report.residentId, asOf: report.asOf, finishedAt: report.finishedAt, used: report.used, complete: report.complete, ownersOmitted: report.ownersOmitted, issues: report.issues })}`,
      );
    } catch {
      /* A failed summary sink cannot change the returned audit evidence. */
    }
    return report;
  }

  /** Serialize the capacity read and reservation, not the clone or command.
   * A successful attach records its durable owner before releasing this slot. */
  private async logWorkloadRefusal(
    requestedOwner: string,
    reason: "workload-full" | "workload-unverified",
    owners: Set<string> | null,
    audit: WorkloadAuditCapture,
  ): Promise<void> {
    // Preserve the original observation. Neither a failed sink nor evidence
    // hashing can change the refusal or release any original obligation.
    try {
      await this.hashWorkloadAudit(owners ?? audit.owners ?? new Set(), audit);
      const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "unknown";
      console.log(
        `[workload] ${JSON.stringify({ event: "admission-refused", reason, requestedOwner, ...(await this.workloadAuditReport(resource, owners, audit)) })}`,
      );
    } catch (error) {
      try {
        const name = (error as { name?: unknown } | null)?.name;
        console.warn(
          `[workload] ${JSON.stringify({
            event: "refusal-diagnostics-unavailable",
            reason,
            requestedOwner,
            errorType: typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : typeof error,
          })}`,
        );
      } catch {
        /* Admission remains refused even if both diagnostic sinks fail. */
      }
    }
  }

  private async reserveWorkloadSlot(owner: string): Promise<ThreadErr | null> {
    const key = "workload";
    return this.workloadAdmissions.run(key, async () => {
      let owners: Set<string>;
      const audit: WorkloadAuditCapture = {
        asOf: new Date(systemClock()).toISOString(),
        sources: new Map(),
        nativeRecords: new Map(),
        complete: true,
        processes: "not-observed",
        issues: [],
      };
      try {
        owners = await this.activeWorkloadOwners(true, true, audit);
      } catch {
        audit.complete = false;
        audit.processes = "unavailable";
        audit.issues.push("workload-observation-unavailable");
        await this.logWorkloadRefusal(owner, "workload-unverified", null, audit);
        return {
          error: "resident workload could not be verified",
          status: 503,
          reason: "workload-unverified",
          cause: "system",
        };
      }
      if (!owners.has(owner) && owners.size >= RESIDENT_WORKLOAD_LIMIT) {
        await this.logWorkloadRefusal(owner, "workload-full", owners, audit);
        return {
          error: `resident workload is full (${owners.size}/${RESIDENT_WORKLOAD_LIMIT} active owners)`,
          status: 503,
          reason: "workload-full",
          cause: "system",
        };
      }
      this.workloadReservations.add(owner);
      return null;
    });
  }

  /** Claim an old retained binding before any user-scoped probe. A duplicate
   * legacy binding may name the same UID, but only its ledger owner proceeds. */
  private async claimRetainedThreadUser(binding: ThreadBinding): Promise<ThreadErr | null> {
    const user = binding.user;
    if (!isResidentPoolUser(user)) return { error: "pool-user-invalid: binding names a non-pool user", status: 409 };
    try {
      if (await this.poolUserHasOldThreadDir(user, [parentDir(binding.worktreePath)]))
        return { error: "pool-user-contaminated: another thread directory has this user", status: 409 };
    } catch {
      return { error: "pool-user-inspection-failed: allocation refused", status: 503 };
    }
    try {
      if (!(await this.markPoolUserSpent(user, `thread:${binding.threadKey}`)))
        return {
          error: "pool-owner-mismatch: existing binding cannot share a UID",
          status: 503,
          code: "owner_unverified",
        };
    } catch {
      return { error: "pool-generation-write-failed: existing binding cannot run", status: 503 };
    }
    if (!(await this.poolUserOwnerMatches(user, `thread:${binding.threadKey}`)))
      return {
        error: "pool-owner-mismatch: conflicting retained binding names this UID",
        status: 503,
        code: "owner_unverified",
      };
    return this.ensurePoolAccount(user);
  }

  /** Allocation stays provisional until attach finishes. A hint that names no branch
   *  keeps the sticky ref. An explicit named ref records named authority even
   *  when it matches the sticky ref; only a changed ref replaces the path. */
  private async allocateThreadUser(
    threadKey: string,
    ref: string,
    worktreePath: string,
    /** How the requested ref was chosen (item 16). */
    boundBy: BoundBy,
    /** An explicit named ref is authoritative; false is the sticky fallback. */
    replaceRef = false,
  ): Promise<{ binding: ThreadBinding; wrote: boolean } | ThreadErr> {
    const key = threadBindingKey(threadKey);
    const existing = await this.ctx.storage.get<ThreadBinding>(key);
    const replacingRef = existing !== undefined && replaceRef && existing.ref !== ref;
    const recordingNamedAuthority = existing !== undefined && replaceRef && existing.boundBy !== boundBy;
    const deferRefWrite = replacingRef && !existing.evicted && existing.user !== "";
    const existingUser = existing && !existing.evicted && existing.user ? existing.user : undefined;
    if (existing && existingUser) {
      if (existing.threadKey !== threadKey)
        return {
          error: "pool-owner-mismatch: retained binding belongs to another thread",
          status: 503,
          code: "owner_unverified",
        };
      const refusal = await this.claimRetainedThreadUser(existing);
      if (refusal) return refusal;
    }
    if (existingUser && !replacingRef && !recordingNamedAuthority) return { binding: existing!, wrote: false };
    const reserved = existingUser ?? (await this.reserveSafePoolUser(`thread:${threadKey}`, threadKey));
    if (typeof reserved !== "string") return reserved;
    const user = reserved;
    try {
      const now = new Date(systemClock()).toISOString();
      const binding: ThreadBinding = {
        threadKey,
        ref: replacingRef ? ref : (existing?.ref ?? ref),
        user,
        worktreePath: replacingRef ? worktreePath : (existing?.worktreePath ?? worktreePath),
        boundAt: existing?.boundAt ?? now,
        lastAttachAt: now,
        evicted: false,
        // A named ref starts a new binding choice, so stale move/return records
        // do not make it look default-bound. The thread's pushed-branch memory
        // remains its history across every ref choice.
        ...(existing
          ? {
              ...(replacingRef || recordingNamedAuthority
                ? { boundBy }
                : {
                    ...(existing.boundBy !== undefined ? { boundBy: existing.boundBy } : {}),
                    ...(existing.rebound !== undefined ? { rebound: existing.rebound } : {}),
                    ...(existing.returned !== undefined ? { returned: existing.returned } : {}),
                  }),
              ...(existing.ownBranches !== undefined ? { ownBranches: existing.ownBranches } : {}),
              ...(existing.workspacePredecessors !== undefined
                ? { workspacePredecessors: existing.workspacePredecessors }
                : {}),
              ...(existing.workspaceSettlement !== undefined
                ? { workspaceSettlement: existing.workspaceSettlement }
                : {}),
              ...(existing.lastRunOwner !== undefined ? { lastRunOwner: existing.lastRunOwner } : {}),
            }
          : { boundBy }),
      };
      // A live existing binding already reserves this user. Its named-ref
      // replacement stays provisional until deps and credentials succeed;
      // keeping the old row here lets a failed attach discard the new checkout
      // without ever publishing a binding that did not complete. An evicted row
      // has no user reservation, so its fresh allocation is written and rolled
      // back through the ordinary path.
      if (!deferRefWrite) await this.putThreadBinding(binding);
      return { binding, wrote: !deferRefWrite };
    } finally {
      if (!existingUser) this.poolUsersInspecting.delete(user);
    }
  }

  /** Best-effort cleanup after a provisional named-ref replacement settles.
   * The binding and its surviving checkout already agree; a cleanup failure
   * leaves only an unreachable sibling for the thread's eventual eviction. */
  private async discardReplacedCheckout(threadKey: string, path: string): Promise<void> {
    try {
      const removed = await this.run(["rm", "-rf", path]);
      if (removed.exitCode !== 0) {
        console.log(`attach ${threadKey}: failed to discard replaced checkout ${path}: ${removed.stderr}`);
      }
    } catch (err) {
      console.log(`attach ${threadKey}: failed to discard replaced checkout ${path}: ${errMsg(err)}`);
    }
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
    githubDoor?: { baseUrl: string; bearer: string },
    runBudgetMs?: number,
    runId?: string,
    ownerGen?: string,
    ownerFence?: number,
    nativeBirth = false,
    requestContext?: NativeRequestContext,
  ): Promise<AttachOk | ThreadErr> {
    // One step trace per attach (docs/reference/specs/tracing.md item 19): every command
    // the attach runs lands on it, and the answer carries it.
    const t0 = systemClock();
    const trace = createStepTrace(t0);
    let res: AttachOk | ThreadErr;
    this.attachAdmissionsInFlight++;
    try {
      res = await this.stepTrace.run(trace, () =>
        this.attachThreadTraced(
          threadKey,
          refHint,
          readonly,
          wantSha,
          reuse,
          record,
          t0,
          reason,
          githubDoor,
          runBudgetMs,
          runId,
          ownerGen,
          ownerFence,
          nativeBirth,
          requestContext,
        ),
      );
    } catch (error) {
      emitStepRoot("resident.attach", t0, trace.steps(), traceparent, "error");
      throw error;
    } finally {
      this.attachAdmissionsInFlight--;
    }
    // The same steps as the resident's own `resident.attach` root (item 22).
    emitStepRoot("resident.attach", t0, trace.steps(), traceparent, "error" in res ? refusalOutcome(res) : "ok");
    // A refusal carries the steps that led to it, and its class as a setup
    // word where one names it (record 0097); a success carries its steps already.
    if (!("error" in res)) return res;
    const code = attachRefusalCode(res);
    return { ...res, trace: trace.steps(), ...(code !== undefined ? { code } : {}) };
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
    githubDoor?: { baseUrl: string; bearer: string },
    runBudgetMs?: number,
    runId?: string,
    ownerGen?: string,
    ownerFence?: number,
    nativeBirth = false,
    requestContext?: NativeRequestContext,
  ): Promise<AttachOk | ThreadErr> {
    try {
      return await this.withDeployAdmission("attach", requestContext, () =>
        this.threadAttaches.run(threadKey, async () => {
          // The attachment fence takes precedence over every 503 gate. Keep the
          // same thread lock through the gates and registration write so a newer
          // attach cannot slip between this check and a fallback-eligible refusal.
          if (!validRunOwner(runId, ownerGen, ownerFence))
            return { error: "run-registration-incomplete: attach requires a verifiable owner", status: 400 };
          if (await this.cancellationPending(threadKey))
            return {
              error: "workspace is busy stopping its original run",
              status: 503,
              reason: "busy",
              cause: "system",
            } satisfies ThreadErr;
          if (await this.workspaceDiscarded(threadKey, runId))
            return { error: "workspace discarded", status: 409 } satisfies ThreadErr;
          if (await this.ctx.storage.get(`cancelled:${threadKey}:${runId}`))
            return { error: "run cancelled", status: 409 } satisfies ThreadErr;
          const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
          const fence = await this.ctx.storage.get<Pick<RunRegistration, "runId" | "ownerGen" | "ownerFence">>(
            runFenceKey(threadKey),
          );
          if (
            !registeredRunAllowsClaim(registration, runId, ownerGen, ownerFence) ||
            !registeredRunAllowsClaim(fence, runId, ownerGen, ownerFence)
          )
            return { error: "run-registration-mismatch: a newer generation owns the thread", status: 409 };
          const existing = registeredRunAllowsReattach(
            registration,
            runId,
            systemClock(),
            RUN_REGISTRATION_GRACE_MS,
            ownerGen,
            ownerFence,
          );
          const workloadOwner = `thread:${threadKey}`;
          if (!existing) {
            const workload = await this.reserveWorkloadSlot(workloadOwner);
            if (workload) return workload;
          }
          try {
            return await this.withOwnedNativeOperation(
              threadKey,
              { runId: runId!, ownerGen: ownerGen!, ownerFence: ownerFence! },
              async () => {
                const current = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
                const accepted = await this.ctx.storage.get<Pick<RunRegistration, "runId" | "ownerGen" | "ownerFence">>(
                  runFenceKey(threadKey),
                );
                if (
                  !registeredRunAllowsClaim(current, runId, ownerGen, ownerFence) ||
                  !registeredRunAllowsClaim(accepted, runId, ownerGen, ownerFence)
                )
                  return { error: "run-registration-mismatch: a newer generation owns the thread", status: 409 };
                await new NativeRunScopes(this.ctx.storage, {
                  request: (value, timeout) => this.nativeScopeTransport().request(value, timeout),
                }).birth(
                  threadKey,
                  { runId: runId!, ownerGen: ownerGen!, ownerFence: ownerFence! },
                  nativeBirth,
                  async (txn) => {
                    const registration = await txn.get<RunRegistration>(runRegKey(threadKey));
                    const fence = await txn.get<RunRegistration>(runFenceKey(threadKey));
                    if (
                      !registeredRunAllowsClaim(registration, runId, ownerGen, ownerFence) ||
                      !registeredRunAllowsClaim(fence, runId, ownerGen, ownerFence) ||
                      (await txn.get(`cancelled:${threadKey}:${runId}`)) ||
                      (await txn.get(`cancelled-thread:${threadKey}`)) ||
                      (await txn.get(`discarding:${threadKey}`)) ||
                      (await txn.get(`discarded:${threadKey}:${runId}`))
                    )
                      throw new RunCancelledError("run cancelled");
                  },
                );
                if (await this.workspaceDiscarded(threadKey, runId)) throw new Error("workspace discarded");
                const retained = await this.retainWorkspacePredecessor(threadKey, {
                  runId: runId!,
                  ownerGen: ownerGen!,
                  ownerFence: ownerFence!,
                });
                if (retained) return retained;
                if (await this.recreateAdmission.blocked()) return this.recreateRefusal();
                await this.ensureHydrated();
                if (await this.recreateAdmission.blocked()) return this.recreateRefusal();
                // The fleet drain (item 69): a deploy is waiting for the runs in flight
                // to end, and a NEW run's attach is refused with the record the bot
                // waits on — a real 503 in the streamed document, read by the client as
                // `draining`, never as the platform's transient. A run already in flight
                // — with an owned, live registration (item 44) — re-attaches
                // through: a rolled container, an evicted worktree, a resumed run are
                // the runs the drain waits FOR, and refusing them would hold the fleet
                // closed on the run it is closed for. Read before the image reconcile so
                // a refused attach never restarts a container.
                const drain = await this.fleetDrain();
                const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
                const registered = registeredRunAllowsReattach(
                  registration,
                  runId,
                  systemClock(),
                  RUN_REGISTRATION_GRACE_MS,
                  ownerGen,
                  ownerFence,
                );
                if (drain && (drain.swapFence || !registered)) {
                  const refusal: ThreadErr & { draining: DrainRecord } = drainRefusal(drain);
                  return refusal;
                }
                // Item 70: above the soft memory threshold a NEW attach is refused like
                // `mirror-busy` (the bot falls back or waits, the card says why) — after
                // the drain (storage only, cheaper) and before the image reconcile, so a
                // refused attach never restarts a container. An owned, live run's
                // re-attach passes for the same reason it passes the drain above.
                const memory = await this.memoryGate("attach", registered);
                if (memory) return memory;
                const resourceId = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
                // An attach never restarts the container (issue 2101): a `stale` verdict
                // refuses the NEW run — it falls back to the seeded sandbox — while a
                // owned, live run's re-attach passes exactly as it passes the drain and
                // the memory gate; the restart itself is the refresh cycle's or the
                // deploy's.
                if ((await this.reconcileImage("attach")) === "stale" && !registered) {
                  const s = await this.getStatus();
                  return {
                    error:
                      "image-stale: the container predates the deploy and restarts on the next quiet refresh; new runs use the fallback sandbox until then",
                    status: 503,
                    state: s.state,
                    stateReason: s.reason,
                    reason: "image-stale",
                  };
                }
                // From here the attach may hold the mirror lock through clone/install:
                // count it so a concurrent refresh-cycle reconcileImage never stops the
                // container under it (and isIdle never parks the cycle mid-attach).
                this.attachesInFlight++;
                const priorTree = !reuse
                  ? await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey))
                  : undefined;
                if (priorTree && !priorTree.evicted && priorTree.user)
                  this.workspaceExclusiveOpsInFlight.add(threadKey);
                try {
                  const res = await this.attachThreadBody(
                    threadKey,
                    refHint,
                    readonly,
                    wantSha,
                    reuse,
                    resourceId,
                    t0,
                    record,
                    reason,
                    githubDoor,
                    registered && readonly && wantSha !== null && !reuse
                      ? { runId: runId!, ownerGen: ownerGen!, ownerFence: ownerFence! }
                      : undefined,
                  );
                  // The run this attach opens is now in flight until its release —
                  // whatever its op counters read between the bot's calls (item 44).
                  if (!("error" in res)) {
                    await this.registerRun(threadKey, runBudgetMs, runId, ownerGen, ownerFence, res);
                    res.ownerFence = ownerFence;
                  }
                  return res;
                } finally {
                  if (priorTree && !priorTree.evicted && priorTree.user)
                    this.workspaceExclusiveOpsInFlight.delete(threadKey);
                  this.attachesInFlight--;
                }
              },
              true,
            );
          } finally {
            if (!existing) this.workloadReservations.delete(workloadOwner);
          }
        }),
      );
    } catch (err) {
      return catchAllErr(err, "attach-failed");
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
    if (!(err instanceof StepError)) return { ...catchAllErr(err, "attach-failed"), code: "attach_failed" };
    const failure = await this.classifyFailure(err.step, err.message);
    if (!failure.diskFull)
      return { error: `attach-failed at ${err.step}: ${err.message}`, status: 500, code: "attach_failed" };
    console.log(`attach: ${failure.reason}`);
    await this.setResidentState("degraded", failure.reason);
    return { error: `attach-failed: ${failure.reason}`, status: 500, code: "attach_failed" };
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
    githubDoor?: { baseUrl: string; bearer: string },
    advanceOwner?: WorkspaceOwner,
  ): Promise<AttachOk | ThreadErr> {
    if (!readonly && !githubDoor)
      return { error: "writable attach requires a Git door run bearer", status: 403, cause: "request" };
    try {
      await this.refreshIfStale(resourceId);
    } catch (err) {
      const s = await this.getStatus();
      return {
        error: `not-serviceable: ${errMsg(err)}`,
        status: 503,
        state: s.state,
        stateReason: s.reason,
        reason: s.reason,
        cause: "system",
      };
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
    // Typed `reason` beside the words: the client reads the field — a refusal no
    // wait clears, unlike the restore window's 503s — never the sentence.
    if (!record || !facts)
      return {
        error: "not-serviceable: registry record or repo facts missing",
        status: 503,
        reason: "unregistered",
        cause: "system",
      };

    // A ref the request names is authoritative. The sticky binding is only a
    // fallback when the request names none (`refHint` absent, or the bot's
    // explicit by-default resolution). This keeps a re-issued coordinator
    // child on the branch its new spawn names instead of an earlier attempt's
    // branch. The own-PR move remains for callers that name no branch of their
    // own but carry the typed follow-up fact.
    const storedPrior = stored.get(threadBindingKey(threadKey)) as ThreadBinding | undefined;
    if (!readonly && storedPrior?.githubDoorHost && !githubDoor)
      return { error: "Git door credential is required to reattach this writable tree", status: 403, cause: "request" };
    const namedRef = refHint !== null && !reason.refByDefault && reason.ownPr === null;
    if (namedRef && storedPrior && !storedPrior.evicted && storedPrior.user && storedPrior.ref !== refHint) {
      const preserved = await this.guardWorkspaceReplacement(storedPrior);
      if (preserved) return preserved;
    }
    // The own-PR rebind may run a branch probe as this UID before ordinary
    // allocation. Establish exact ownership first on a recycled VM.
    if (!namedRef && storedPrior && !storedPrior.evicted && storedPrior.user) {
      if (storedPrior.threadKey !== threadKey)
        return {
          error: "pool-owner-mismatch: retained binding belongs to another thread",
          status: 503,
          code: "owner_unverified",
        };
      const refusal = await this.claimRetainedThreadUser(storedPrior);
      if (refusal) return refusal;
      // The own-PR fallback may inspect a local branch as this pool user.
      // Remove any legacy App token before that first user-scoped Git probe.
      if (reason.ownPr !== null) {
        try {
          await this.scrubThreadCredentialFiles(storedPrior);
        } catch (err) {
          return this.attachFailed(err);
        }
      }
    }
    const rebind = namedRef
      ? { binding: storedPrior }
      : await this.rebindToOwnPr(storedPrior, reason.ownPr, reuse, facts.defaultRef, slug);
    if ("error" in rebind) return rebind;
    const prior = rebind.binding;
    const ref = namedRef ? refHint : (prior?.ref ?? refHint);
    if (!ref) {
      // Name the default branch so the bot can bind to it (loudly) instead of
      // asking the user when the message named no branch; the binding is still
      // made by the caller's next attach, never here (explicit, no guess).
      return {
        error: "needs-ref: this thread has no ref binding yet — supply refHint",
        status: 409,
        needs: "ref",
        defaultRef: facts.defaultRef,
        cause: "request",
      };
    }
    const replacingNamedRef = namedRef && prior !== undefined && prior.ref !== ref;
    const worktreePath = replacingNamedRef
      ? await replacementWorktreePath(threadKey, ref, prior.worktreePath)
      : (prior?.worktreePath ?? (await threadWorktreePath(threadKey, ref)));
    // Read-only vs writable (item 50): decided here, once, from the request
    // and the prior binding's mode — the tested pure helper is the shipped code.
    const mode = planReadonlyAttach({ readonly, prior, slug, mirrorDir: MIRROR_DIR });

    const alloc = await this.allocateThreadUser(
      threadKey,
      ref,
      worktreePath,
      boundByFor({ refByDefault: reason.refByDefault, ref, defaultRef: facts.defaultRef }),
      namedRef,
    );
    if ("error" in alloc) return alloc;
    const binding = alloc.binding;
    // "Nothing created" on failure: a FRESH allocation (new binding or a
    // re-allocation after eviction) is rolled back if the attach fails below,
    // including a throw during disk admission, so a bogus refHint can neither
    // bind sticky garbage nor leak a pool user.
    const rollback = async (): Promise<void> => {
      if (!alloc.wrote) return;
      if (prior) await this.putThreadBinding(prior);
      else await this.deleteThreadBinding(threadKey);
    };

    // A named ref builds beside the prior checkout and removes that sibling
    // only after the new binding commits. If cleanup later fails, the same
    // pool user can still traverse the old tree. Remove its legacy App token
    // before admitting the replacement or any of its model commands.
    if (replacingNamedRef && prior && !prior.evicted) {
      try {
        await this.scrubThreadCredentialFiles(prior);
      } catch (err) {
        await rollback();
        return this.attachFailed(err);
      }
    }

    // Disk admission (item 55): before the lock, since making room takes it.
    // An evicted prior binding has already published its replacement to
    // reserve the user; keep that row provisional if admission itself throws.
    const admission = await admitThreadDiskWithRollback(
      () => this.admitThreadDisk({ threadKey, binding, facts, record }),
      rollback,
    );
    if ("error" in admission) {
      await rollback();
      return admission;
    }
    let attached: AttachOk | ThreadErr | undefined;
    try {
      attached = await this.attachThreadCreate({
        threadKey,
        refHint,
        wantSha,
        reuse,
        slug,
        t0,
        facts,
        record,
        binding,
        preservationSource: storedPrior,
        advanceOwner,
        mode,
        githubDoor,
        rollback,
        namedRef,
        refChanged: storedPrior !== undefined && storedPrior.ref !== binding.ref,
        ...(rebind.rebound !== undefined ? { rebound: rebind.rebound } : {}),
        ...(rebind.rebindRefused !== undefined ? { rebindRefused: rebind.rebindRefused } : {}),
      });
      return attached;
    } finally {
      this.diskCommittedKiB -= admission.committedKiB;
      if (replacingNamedRef && prior !== undefined) {
        const discard = replacementWorktreeCleanup({
          priorPath: prior.worktreePath,
          replacementPath: binding.worktreePath,
          succeeded: attached !== undefined && !("error" in attached),
        });
        if (discard !== null) await this.discardReplacedCheckout(threadKey, discard);
      }
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
    if (!prior.evicted && prior.user) {
      const preserved = await this.guardWorkspaceReplacement(prior);
      if (preserved) return preserved;
    }
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
        return {
          error: errMsg(err),
          status: 503,
          state: s.state,
          stateReason: s.reason,
          reason: "mirror-busy",
          cause: "system",
        };
      }
      return catchAllErr(err, "attach-failed");
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
    await this.putThreadBinding(moved);
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
    if (!current.evicted && current.user) {
      const preserved = await this.guardWorkspaceReplacement(current);
      if (preserved) throw new PreservedWorkspaceStepError(preserved);
    }
    await this.putThreadBinding(back.binding);
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
  private async rememberOwnBranches(
    threadKey: string,
    pushed: readonly PushedBranch[],
  ): Promise<ThreadErr | undefined> {
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) return;
    const remembered = rememberOwnBranches(binding.ownBranches, pushed, new Date(systemClock()).toISOString());
    if ("error" in remembered) return { error: remembered.error, status: 409 };
    await this.putThreadBinding(
      {
        ...binding,
        ownBranches: remembered.ownBranches,
      } satisfies ThreadBinding,
      true,
    );
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
    preservationSource?: ThreadBinding;
    advanceOwner?: WorkspaceOwner;
    mode: ReturnType<typeof planReadonlyAttach>;
    githubDoor?: { baseUrl: string; bearer: string };
    rollback: () => Promise<void>;
    /** This ask named the ref; a missing named branch may not fall back. */
    namedRef: boolean;
    /** The row moved to another ref before provisioning. */
    refChanged: boolean;
    /** What `rebindToOwnPr` decided (item 16), for the answer. */
    rebound?: Rebound;
    rebindRefused?: RebindRefused;
  }): Promise<AttachOk | ThreadErr> {
    const { threadKey, refHint, wantSha, reuse, slug, t0, facts, record, mode, rollback, githubDoor } = input;
    const { rebound, rebindRefused } = input;
    // Reassigned once, under the lock, when the bound ref turns out gone from
    // the mirror and the binding goes back to the default (item 16's second
    // movement): everything after the lock — deps, credentials, the row's
    // final write, the answer — then speaks of the returned binding.
    let binding = input.binding;
    let refChanged = input.refChanged;
    let returned: Returned | undefined;

    // The mirror may mint a repository-scoped token as root for recovery fetches.
    // The thread receives no installation token, even on a writable attach.
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
    const returnable = input.namedRef ? false : canReturnToDefault(binding, facts.defaultRef);
    let fetchToken: string | null = null;
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
        // The tip is read here, once, and is what the target is judged on and
        // what the worktree is provisioned at: a caller that named a commit
        // gets that commit or a `stale-tip` refusal, never whatever the tip
        // happens to be (item 51).
        let tipSha = refExists ? await this.readMirrorSha(binding.ref).catch(() => null) : null;
        let target = attachTarget({
          refExists,
          wantSha: want,
          commitInMirror: !refExists && want !== null && (await this.commitInMirror(want)),
          tipSha,
        });
        if (target.kind === "unknown-ref" && returnable) {
          // The thread's branch — one a rebind moved it onto, or one its own
          // runs pushed and it was bound to by name — is gone even after the
          // fetch: deleted once its pull request merged. The binding goes
          // back to the default (item 16's second movement) and the attach
          // goes on there: the default is always in the mirror, and the
          // worktree step below provisions the tree at its tip.
          const back = await this.returnBindingToDefault(binding, facts.defaultRef);
          if (back.binding.ref !== binding.ref) refChanged = true;
          binding = back.binding;
          returned = back.returned;
          want = wantShaForBinding({ boundRef: binding.ref, refHint, wantSha });
          const defaultExists = await this.refExists(binding.ref);
          tipSha = defaultExists ? await this.readMirrorSha(binding.ref).catch(() => null) : null;
          target = attachTarget({
            refExists: defaultExists,
            wantSha: want,
            commitInMirror: false,
            tipSha,
          });
        }
        if (target.kind === "unknown-ref") {
          throw new StepError(
            "unknown-ref",
            `ref ${JSON.stringify(binding.ref)} does not resolve in the mirror (even after a fetch)` +
              (want !== null ? `, and the mirror does not hold the expected commit ${want.slice(0, 7)} either` : ""),
          );
        }
        if (target.kind === "stale-tip") {
          throw new StepError(
            "stale-tip",
            `ref ${JSON.stringify(binding.ref)} is at ${target.tip ? target.tip.slice(0, 7) : "an unreadable tip"} in the mirror${why === null ? " (no fetch was due)" : " even after the fetch"}; the caller expects ${target.want.slice(0, 7)} — the run executes at the commit it asked for, or not on this resident`,
          );
        }
        // A tip the read could not answer is never provisioned at: with no
        // commit named the target is `ref` without looking at the tip, so the
        // failed read is named here instead of becoming a null sha.
        const sha = target.kind === "sha" ? target.sha : tipSha;
        if (sha === null) {
          throw new StepError("rev-parse", `the mirror's tip of ${JSON.stringify(binding.ref)} could not be read`);
        }
        const threadLockKey = await this.lockfileKey(sha);
        const originUrl = githubDoor && !mode.readonly ? `${githubDoor.baseUrl}/git/${slug}.git` : mode.originUrl;
        // A reused tree can execute Git hooks during the worktree probes.
        // Delete legacy token files as root before its first thread-user command.
        if (mode.scrubCredentials || githubDoor) await this.scrubThreadCredentialFiles(binding);
        const recreated = await this.ensureThreadWorktree(binding, sha, originUrl, mode.modeSwitch, {
          detached: target.kind === "sha",
          reuse,
          refChanged,
          priorBinding: input.preservationSource,
          ...(sha === wantSha && input.advanceOwner ? { advanceOwner: input.advanceOwner } : {}),
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
        return {
          error: errMsg(err),
          status: 503,
          state: s.state,
          stateReason: s.reason,
          reason: "mirror-busy",
          cause: "system",
        };
      }
      if (err instanceof StepError && err.step === "unknown-ref") {
        return { error: `unknown-ref: ${err.message}`, status: 400, cause: "request" };
      }
      if (err instanceof StepError && err.step === "stale-tip") {
        // Item 51: not a resident fault and not a caller fault — a fact about
        // the mirror at this instant. 409 with the state, so the bot's named
        // fallback runs cold at the commit it asked for.
        const s = await this.getStatus();
        return {
          error: `stale-tip: ${err.message}`,
          status: 409,
          state: s.state,
          reason: "stale-tip",
          cause: "system",
        };
      }
      if (err instanceof StepError && err.step === "workspace-preserved")
        return {
          error: err.message,
          status: 409,
          reason: "workspace-preserved",
          ...(err instanceof PreservedWorkspaceStepError && err.code !== undefined ? { code: err.code } : {}),
        };
      return this.attachFailed(err);
    }

    let deps: { deps: ThreadDepsMechanism; reconciled: boolean; depsKey?: string };
    let credentials: AttachOk["credentials"] = mode.readonly ? "none" : "unavailable";
    try {
      // A reused old tree or an interrupted old attach may still have a
      // user-readable App token. Remove it before install/build hooks run.
      if (mode.scrubCredentials || githubDoor) await this.scrubThreadCredentials(binding);
      deps = await this.materializeThreadDeps(
        binding,
        locked.value.threadLockKey,
        locked.value.sha,
        facts.lockfileHash,
        record.commands.install,
      );
      if (githubDoor && !mode.readonly) {
        await this.threadRunOk(
          binding.user,
          binding.worktreePath,
          `git remote set-url origin ${shellQuote(`${githubDoor.baseUrl}/git/${slug}.git`)}`,
          "worktree-door-remote",
          DEFAULT_EXEC_TIMEOUT_MS,
        );
        credentials = "ok";
      }
    } catch (err) {
      await rollback();
      // The deps hardlink-copy now waits on the mirror mutex (FIX 2): a
      // timed-out acquire surfaces as 503 mirror-busy, same as the fetch/
      // worktree lock above, so the bot-side fallback can retry.
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return {
          error: errMsg(err),
          status: 503,
          state: s.state,
          stateReason: s.reason,
          reason: "mirror-busy",
          cause: "system",
        };
      }
      return this.attachFailed(err);
    }

    // The prior write time and token expiry never survive an attach: a
    // read-only attach scrubbed the file, a writable one either rewrote it
    // (stamped below) or could not — and "unknown" is what makes the next exec
    // re-mint.
    const {
      credentialsWrittenAt: _prior,
      tokenExpiresAtMs: _priorExp,
      githubDoorHost: _priorDoor,
      ...bindingSansCred
    } = binding;
    const container = await this.containerIdentity();
    await this.putThreadBinding({
      ...bindingSansCred,
      container,
      lastAttachAt: new Date(systemClock()).toISOString(),
      deps: deps.deps,
      // A reused tree keeps the key it was linked from (spread above).
      ...(deps.depsKey ? { depsKey: deps.depsKey } : {}),
      sha: locked.value.sha,
      readonly: mode.readonly,
      ...(githubDoor && !mode.readonly ? { githubDoorHost: new URL(githubDoor.baseUrl).host } : {}),
    } satisfies ThreadBinding);
    // Item 55: the tree is on disk now; the next refresh instance's `measure`
    // step counts it — the admission's free-space term is a live `df`, and the
    // per-part projection it reads from the sample moves only with a cycle.

    // Which container the tree is in, for the run's row (harness-pi item 8):
    // memoized per incarnation, so this is a read after the first attach.
    return {
      workspace: binding.worktreePath,
      ref: binding.ref,
      sha: locked.value.sha,
      user: binding.user,
      reconciled: deps.reconciled,
      recreated: locked.value.recreated,
      ...(container !== undefined ? { container } : {}),
      deps: deps.deps,
      ...(deps.depsKey ? { depsKey: deps.depsKey } : {}),
      credentials,
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
   *  .git; writable `origin` is repointed at the Git door so fetch/push use
   *  the run bearer rather than the (deliberately unreadable) mirror. */
  private async ensureThreadWorktree(
    binding: ThreadBinding,
    sha: string,
    originUrl: string,
    modeSwitch: boolean,
    /** `detached`: the bound ref is gone from the mirror and `sha` is the
     *  expected commit it still holds (item 51) — the tree is checked out at
     *  that commit, detached, instead of at a branch. `reuse`: a resumed
     *  run's attach (item 66): keep the tree as it stands, or refuse. */
    opts: {
      detached: boolean;
      reuse: boolean;
      refChanged: boolean;
      priorBinding?: ThreadBinding;
      advanceOwner?: WorkspaceOwner;
    } = {
      detached: false,
      reuse: false,
      refChanged: false,
    },
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
    let advancing = false;
    if (opts.advanceOwner && opts.priorBinding && facts.head !== sha) {
      if (
        opts.reuse ||
        modeSwitch ||
        opts.refChanged ||
        binding.ref !== opts.priorBinding.ref ||
        binding.worktreePath !== opts.priorBinding.worktreePath ||
        binding.user !== opts.priorBinding.user
      )
        throw new StepError("workspace-preserved", "workspace-preserved: incompatible live owner advance");
      const refusal = await this.guardWorkspaceAdvance(opts.priorBinding, opts.advanceOwner);
      if (refusal) throw new StepError("workspace-preserved", refusal.error);
      advancing = true;
    }
    const decision = advancing
      ? { kind: "recreate" as const, why: "stale" as const }
      : decideWorktree({
          reuse: opts.reuse,
          modeSwitch,
          refChanged: opts.refChanged,
          sha,
          worktreePath: wt,
          facts,
        });
    if (decision.kind === "refuse") throw new ReuseRefusedError(decision.why);
    if (decision.kind === "reuse") return false;

    if (
      !advancing &&
      opts.priorBinding &&
      !opts.priorBinding.evicted &&
      opts.priorBinding.user &&
      opts.priorBinding.worktreePath === wt
    ) {
      const preserved = await this.guardWorkspaceReplacement(opts.priorBinding);
      if (preserved) throw new PreservedWorkspaceStepError(preserved);
    }

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
    // Writable: origin → Git door (fetch/push with the run bearer).
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

  /** Before a thread runs, remove both legacy App-token locations: the Git
   * store and the staging file an interrupted old attach could leave behind.
   * A deletion failure aborts attach before any model command. */
  private async scrubThreadCredentials(binding: ThreadBinding): Promise<void> {
    await this.scrubThreadCredentialFiles(binding);
    await this.threadRunOk(
      binding.user,
      binding.worktreePath,
      "git config --unset-all credential.helper || true",
      "thread-cred-helper-scrub",
      DEFAULT_EXEC_TIMEOUT_MS,
    );
  }

  private async scrubThreadCredentialFiles(binding: ThreadBinding): Promise<void> {
    await this.runOk(
      legacyCredentialScrubCommand(binding.worktreePath, `/workspace/.stage-${binding.user}`),
      "thread-cred-file-scrub",
      { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
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
    binding: { user: string; worktreePath: string; depsKey?: string }, // a ThreadBinding, or a per-op checkout
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
    if (!plan.seed)
      return {
        deps: "none",
        reconciled: false,
        ...(hasDeps && binding.depsKey === threadLockKey ? { depsKey: threadLockKey } : {}),
      };
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
    await this.runOk(
      [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import os,stat; p='/workspace/deps';\ntry: os.mkdir(p,0o755)\nexcept FileExistsError: pass\nf=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); s=os.fstat(f); assert s.st_uid==0 and not s.st_mode & 0o022 and 'system.posix_acl_access' not in os.listxattr(f), 'dependency parent ownership is unverified'; os.close(f)",
      ],
      "deps-store-dir",
      { workspacePaths: [DEPS_STORE_DIR] },
    );
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
    if (plan.action === "join") {
      const result = await this.depsInFlight.get(key)!;
      await this.assertThreadOperationAllowed();
      return result;
    }
    await this.assertThreadOperationAllowed();
    // `restore` (item 61 PR B): the key's archive comes down into a scratch
    // tree and commits like an install would. Only a confirmed restore
    // failure can fall through to installation. An unconfirmed SDK effect
    // preserves its original target and durable producer claim.
    const restoreDeadlineMs = opts.restoreDeadlineMs ?? systemClock() + Math.min(budgetMs, RESTORE_MAX_MS);
    const attempt = opts.attempt ?? crypto.randomUUID();
    const p = this.withSharedNativeOperation(
      "deps-materialize",
      () =>
        plan.action === "restore" && backupRecord
          ? this.restoreDepsEntry(key, backupRecord, restoreDeadlineMs, attempt).catch(async (err) => {
              if (err instanceof OpaqueNativeOutcomeUnconfirmedError || isBackgroundOperationHeld(err)) throw err;
              console.log(`deps: restore of ${key.slice(0, 8)} failed — installing instead: ${errMsg(err)}`);
              await this.dropDepsBackups([key]).catch(() => {});
              return this.installDepsEntry(key, sha, installCmd, budgetMs, { ...opts, attempt });
            })
          : this.installDepsEntry(key, sha, installCmd, budgetMs, { ...opts, attempt }),
      key,
    ).finally(() => this.depsInFlight.delete(key));
    this.depsInFlight.set(key, p);
    const result = await p;
    await this.assertThreadOperationAllowed();
    return result;
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
    return this.withSharedNativeOperation(
      "deps-backup",
      async () => {
        if (this.depsBackupsInFlight.has(key) || (await this.depsBackupRecord(key))) return;
        const transfer = backupTransferMode(this.env as unknown as Record<string, unknown>);
        if (transfer.mode === "local") return;
        this.depsBackupsInFlight.add(key);
        const t0 = systemClock();
        try {
          const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
          const backup = await withTimeout(
            this.withOpaqueNativeEffect(
              () =>
                this.createBackup({
                  // The entry dir itself, not only its top-level node_modules: nested
                  // workspace node_modules are entry content too. The markers are
                  // excluded so a restore's own commit writes `.complete` LAST.
                  dir: depsEntryPath(key),
                  localBucket: transfer.localBucket,
                  ttl: DEPS_BACKUP_TTL_S,
                  name: `${resource} deps ${key.slice(0, 8)}`,
                  excludes: [...DEPS_ENTRY_BACKUP_EXCLUDES],
                }),
              (result) =>
                typeof result?.id === "string" &&
                result.id.length > 0 &&
                typeof result.dir === "string" &&
                result.dir === depsEntryPath(key),
            ),
            R2_TRANSFER_TIMEOUT_MS,
            "deps backup",
            new OpaqueNativeOutcomeUnconfirmedError("deps backup outcome is unconfirmed after timeout"),
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
          if (isBackgroundOperationHeld(err)) throw err;
          console.log(`deps: backup of ${key.slice(0, 8)} failed: ${errMsg(err)}`);
        } finally {
          this.depsBackupsInFlight.delete(key);
        }
      },
      key,
    );
  }

  /** The `restore` backing of materializeDeps (item 61): install the archive
   *  in its UUID scratch target through the fixed native restore operation,
   *  judged by the bytes arriving (restoreWithProgress),
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
      // The archive is the entry dir (top-level node_modules PLUS nested
      // workspace ones at their tree-relative paths), so it extracts into the
      // scratch root and the commit script moves each node_modules like an
      // install's. An archive from before nested coverage held only the
      // node_modules CONTENTS: its extract leaves no scratch/node_modules, the
      // commit fails, the record is dropped and the installer runs — the
      // documented fall-through, never a stranded key.
      await this.restoreExtracted(
        record.backup,
        scratch,
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
        { timeoutMs: GIT_NETWORK_TIMEOUT_MS, workspacePaths: [scratch, staging, depsEntryPath(key)] },
      );
      console.log(`deps: restored ${key.slice(0, 8)} from backup in ${systemClock() - t0}ms`);
      return depsEntryPath(key);
    } catch (err) {
      if (err instanceof OpaqueNativeOutcomeUnconfirmedError || isBackgroundOperationHeld(err)) throw err;
      await this.run(["rm", "-rf", scratch, staging], { workspacePaths: [scratch, staging] }).catch((cleanupErr) => {
        if (isBackgroundOperationHeld(cleanupErr))
          throw new AggregateError([err, cleanupErr], "dependency restore cleanup is held", { cause: cleanupErr });
      });
      throw err;
    }
  }

  /** Forget entry backups: the records and the R2 objects behind them. */
  private async dropDepsBackups(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const records = await this.ctx.storage.get<DepsBackupRecord>(keys.map((k) => depsBackupStorageKey(k)));
    const ids = [...records.values()].map((r) => r.backup.id);
    const deleted = await this.deleteBackupObjects(ids);
    await this.ctx.storage.transaction(async (rows) => {
      for (const [key, record] of records) {
        const current = await rows.get<DepsBackupRecord>(key);
        if (current?.backup.id === record.backup.id) await rows.delete(key);
      }
    });
    return deleted;
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
        for (const rel of parsed.nested) {
          await this.swapMutableCaches(
            `${depsEntryPath(seed)}/${rel}`,
            `${scratch}/${rel}`,
            BUILD_USER,
            parsed.mutableListing,
            "deps-seed-swap",
          );
        }
        console.log(`deps: ${key.slice(0, 8)} seeded from ${seed.slice(0, 8)} (${parsed.mech})`);
      }
      // Unprivileged and token-free, in a tree only this attempt
      // knows — no stale sweep needed: nothing else can be running in it.
      await this.runOk(["/bin/bash", "-c", `cd ${scratch} && ${installCmd}`], "deps-install", {
        timeoutMs: budgetMs,
        nativeUser: BUILD_USER,
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
        { timeoutMs: GIT_NETWORK_TIMEOUT_MS, workspacePaths: [scratch, staging, depsEntryPath(key)] },
      );
      console.log(`deps: installed ${key.slice(0, 8)} in ${systemClock() - t0}ms`);
      this.ctx.waitUntil(this.backupDepsEntry(key));
      return depsEntryPath(key);
    } catch (err) {
      if (isBackgroundOperationHeld(err)) throw err;
      await this.run(["rm", "-rf", scratch, staging], { workspacePaths: [scratch, staging] }).catch((cleanupErr) => {
        if (isBackgroundOperationHeld(cleanupErr))
          throw new AggregateError([err, cleanupErr], "dependency install cleanup is held", { cause: cleanupErr });
      });
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

  /** The view itself, lock-agnostic: provisioning links the CHECKOUT under
   *  the mirror lock it already holds; the staged rebuild links its staging
   *  tree OFF the lock — safe because the tree is private to the rebuild and
   *  the store entry's inodes are immutable (deps-harden). */
  private async linkDepsView(
    entryNodeModules: string | null,
    tree: string,
    user: string,
    /** The build dirs' source. The staged rebuild passes its own tree (its
     *  clean just removed them — nothing to copy; the WARM checkout's build
     *  output must never seed the tree that is about to rebuild it). */
    from: string = CHECKOUT_DIR,
  ): Promise<DepCacheMaterialization | "none"> {
    const parsed = await this.runDepScript(
      depCacheScript(from, tree, user, entryNodeModules ? { nodeModulesSrc: entryNodeModules } : {}),
      "deps-materialize",
      REFRESH_BUILD_TIMEOUT_MS,
    );
    await this.swapMutableCaches(
      entryNodeModules ?? `${from}/node_modules`,
      `${tree}/node_modules`,
      user,
      parsed.mutableListing,
      "deps-mutable-swap",
    );
    // Nested workspace node_modules the script hardlinked from the entry get
    // the same tool-cache swap, each scoped to its own root (mutableCachePaths
    // keeps only the listing under that root).
    if (entryNodeModules) {
      const entryRoot = entryNodeModules.replace(/\/node_modules$/, "");
      for (const rel of parsed.nested) {
        await this.swapMutableCaches(
          `${entryRoot}/${rel}`,
          `${tree}/${rel}`,
          user,
          parsed.mutableListing,
          "deps-mutable-swap",
        );
      }
    }
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
    return this.withSharedNativeOperation(
      "deps-adopt",
      async () => {
        if (await this.depsEntryComplete(warmKey)) return;
        await this.withMirrorLock(async () => this.adoptCheckoutDeps(warmKey), ATTACH_MUTEX_WAIT_MS);
      },
      warmKey,
    );
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
      { timeoutMs: GIT_NETWORK_TIMEOUT_MS, workspacePaths: [CHECKOUT_DIR, depsEntryPath(warmKey)] },
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
    await this.runOk(["rm", "-rf", ...plan.remove], "deps-evict", {
      timeoutMs: DU_TIMEOUT_MS,
      workspacePaths: [DEPS_STORE_DIR],
    });
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

  /** Shared entry checks for exec/read/write: hydrated resident, live
   *  binding, worktree actually on disk (the container may have slept since
   *  the last attach — disk is cache, re-attach recreates). */
  private async threadPreflight(threadKey: string): Promise<{ binding: ThreadBinding } | ThreadErr> {
    if (this.workspaceExclusiveOpsInFlight.has(threadKey))
      return { error: "workspace-preservation: automatic release is checking this thread", status: 503 };
    if (await this.recreateAdmission.blocked()) return this.recreateRefusal();
    try {
      await this.ensureHydrated();
    } catch (err) {
      const s = await this.getStatus();
      return {
        error: `not-serviceable: ${errMsg(err)}`,
        status: 503,
        state: s.state,
        stateReason: s.reason,
        reason: s.reason,
        cause: "system",
      };
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
    if (!(await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`))) {
      return { error: "pool-owner-mismatch: model command refused before UID ownership", status: 503 };
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
  /** Release and dependency inspection hold the attach lock and exclude new
   *  thread operations until their final observation or removal settles. */
  private workspaceExclusiveOpsInFlight = new Set<string>();

  private async withDeployAdmission<T>(
    producer: string,
    requestContext: NativeRequestContext | undefined,
    fn: () => Promise<T>,
    endingOwner?: string,
  ): Promise<T | ThreadErr> {
    if (!endingOwner && !this.threadOperationScope.getStore() && !this.opOperationScope.getStore()) {
      const owner = `op:${crypto.randomUUID()}`;
      const context: NativeRequestContext = requestContext ?? {
        callId: crypto.randomUUID(),
        actor: "service",
        traceId: null,
        parentSourceId: null,
      };
      return this.withDeployAdmission(
        producer,
        { ...context, sourceId: producer },
        () => this.withOpNativeOperation(owner, fn, "resident-call", { ...context, sourceId: producer }),
        owner,
      );
    }
    const registry = this.registry();
    const id = await beginTrackedDeployAdmission(registry, {
      kind: "resident-call",
      component: "resident",
      build: BUILD_ID,
      workerVersion: workerVersionId(this.env),
      resource: await this.ctx.storage.get(RESOURCE_KEY),
      producer,
      sourceId:
        endingOwner ??
        this.threadOperationScope.getStore()?.owner.runId ??
        this.opOperationScope.getStore()?.owner ??
        producer,
      actor: requestContext?.actor ?? (endingOwner ? "system" : "service"),
      callId: requestContext?.callId ?? crypto.randomUUID(),
      traceId: requestContext?.traceId,
      parentSourceId: requestContext?.parentSourceId,
    });
    if (!id)
      return {
        error: "deploy-fence: resident Worker upload is in progress",
        status: 503,
        reason: "draining",
        code: "deploy_fence",
        cause: "system",
      };
    try {
      await this.ctx.storage
        .get(RESOURCE_KEY)
        .then((resource) => registry.recordDeployAdmissionResource(id.id, resource))
        .catch(() =>
          emitDeployAdmission({
            phase: "origin-unverified",
            id: id.id,
            observedAt: systemClock(),
            failure: "storage-or-rpc",
          }),
        );
      return await fn();
    } finally {
      let endingReadFailure: { error: unknown } | undefined;
      const ended =
        !endingOwner ||
        (await new NativeOperationJournal(this.ctx.storage)
          .operatorEnded(`native-operation:${endingOwner}`, { opOwner: endingOwner })
          .catch((error) => {
            endingReadFailure = { error };
            return false;
          }));
      if (!ended)
        emitDeployAdmission(
          {
            phase: "permit-release",
            id: id.id,
            opOwner: endingOwner,
            commit: "held",
            failure: "operator-ending-unverified",
            reason: endingReadFailure ? "ending-read-failed" : "ending-not-observed",
          },
          endingReadFailure,
        );
      else
        await endTrackedDeployAdmission(registry, id).catch(() => {
          // The helper reports unverified cleanup. Retained permits still block deployment;
          // preserve the original work result or error for the caller and check recorder.
        });
    }
  }

  private async writeOwnedFile(path: string, content: string) {
    const nativeAttempt = await this.beginThreadNativeOperation();
    if (nativeAttempt.scope) {
      const result = await this.nativeScopeTransport().request(
        {
          mode: "launch",
          ref: nativeAttempt.scope,
          attempt: nativeAttempt.id,
          role: "write",
          path,
          content,
        },
        DEFAULT_EXEC_TIMEOUT_MS,
      );
      if (result.exitCode !== 0 || result.timedOut || result.truncated)
        throw new Error("owned write outcome is unconfirmed");
      await nativeAttempt.settle();
      return result;
    }
    const result = await this.writeFile(path, content);
    await nativeAttempt.settle();
    return result;
  }

  /** Admit before native work; only a known completion or no-start result settles it.
   * An unknown outcome deliberately keeps the enclosing durable operation held. */
  private async beginThreadNativeOperation(kind: "process" | "opaque" = "opaque", mutationPaths?: readonly string[]) {
    await this.assertThreadOperationAllowed();
    const thread = this.threadOperationScope?.getStore();
    const scope = thread ?? this.opOperationScope?.getStore();
    const ended = () => {
      if (thread) throw new RunCancelledError("run cancelled");
      throw new Error("operator command ended");
    };
    if (scope && !scope.active) ended();
    const journal = new NativeOperationJournal(this.ctx.storage);
    let nativeScope: NativeExecutionScopeRef | undefined;
    const nativeScopes = new NativeRunScopes(this.ctx.storage, {
      request: (value, timeout) => this.nativeScopeTransport().request(value, timeout),
    });
    if (thread && (await nativeScopes.protocol(thread.threadKey, thread.owner.runId)) === "native-v1") {
      await nativeScopes.reserve(thread.threadKey, thread.owner);
      if (!this.ctx.container?.running) await this.start();
      await this.assertThreadOperationAllowed();
      nativeScope = await nativeScopes.ensure(thread.threadKey, thread.owner, () =>
        this.assertThreadOperationAllowed(),
      );
      await journal.bindScope(thread.key, nativeScope);
    } else if (!thread && scope && "origin" in scope) {
      await nativeScopes.reserveOperator({ opOwner: scope.owner });
      if (!this.ctx.container?.running) await this.start();
      const allowed = async () => {
        if (!scope.active) ended();
        if (this.destroying || (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)))
          throw new Error("operator runtime unavailable");
      };
      nativeScope = await nativeScopes.ensureOperator({ opOwner: scope.owner }, allowed);
      await journal.bindScope(scope.key, nativeScope);
    }
    if (mutationPaths && (!scope || !nativeScope))
      throw new Error("workspace mutation requires its original native scope");
    const id = scope ? await journal.begin(scope.key, kind, mutationPaths) : null;
    // Admission itself awaited storage. A scope which closed in that interval
    // must settle its never-submitted attempt instead of launching after closure.
    if (scope && !scope.active) {
      await journal.settle(scope.key, id!);
      ended();
    }
    try {
      await this.assertThreadOperationAllowed();
    } catch (error) {
      if (scope && id) await journal.settle(scope.key, id);
      throw error;
    }
    let settled = false;
    return {
      scope: nativeScope,
      key: scope?.key,
      id,
      launched: async (process: { status(): Promise<unknown> }) => {
        if (!scope || !id) return;
        let status: unknown;
        try {
          status = await process.status();
        } catch (error) {
          // Only a failed observation on an acknowledged capability may leave
          // collection running. Lost runtime, authority and storage remain refusals.
          const forbidden = [...selfAndCauses(error)].some((link) => {
            const value = link as {
              name?: unknown;
              code?: unknown;
              status?: unknown;
              statusCode?: unknown;
              httpStatus?: unknown;
            };
            return (
              isControlReset(link) ||
              isRuntimeReplacement(link) ||
              link instanceof OperationInterruptedError ||
              /Auth|Security|Permission|Access|Cancel|Owner|Fence|Stale|Runtime|Interrupt|Reset|Recreate/i.test(
                String(value?.name ?? ""),
              ) ||
              /AUTH|PERMISSION|DENIED|REVOKED|OWNER|FENCE|RUNTIME|INTERRUPT|RESET|RECREATE/i.test(
                String(value?.code ?? ""),
              ) ||
              [value?.status, value?.statusCode, value?.httpStatus].some((status) => status === 401 || status === 403)
            );
          });
          if (
            forbidden ||
            !(error instanceof RPCTransportError) ||
            !["invalid_frame", "protocol_error"].includes(error.kind) ||
            thread?.attachment
          )
            throw error;
          if (!scope.active) ended();
          await this.assertThreadOperationAllowed();
          try {
            console.warn(
              `[native-identity-observation] ${JSON.stringify({
                phase: "status",
                class: "RPCTransportError",
                code: error.code,
                kind: error.kind,
                operation: scope.key,
                attempt: id,
              })}`,
            );
          } catch {
            /* Observation logging cannot abandon the original process. */
          }
          return;
        }
        // Parsing and persistence are outside the observation catch. Their
        // uncertainty cannot be mistaken for an unavailable status read.
        await journal.launched(scope.key, id, status);
      },
      settle: async (nativeEnding?: NativeTimeoutEnding) => {
        if (settled) return;
        settled = true;
        if (scope && id) {
          await journal.settle(scope.key, id, nativeEnding);
        }
      },
    };
  }

  /** Shared VM hydration and cache work has its own durable owner. A cancelled
   * consumer cannot stop maintenance that still serves other worktrees. */
  private async withSharedNativeOperation<T>(
    producer: NativeOperationProducer,
    fn: () => Promise<T>,
    sourceId: string = producer,
  ): Promise<T> {
    const owner = `op:${crypto.randomUUID()}`;
    const requestContext: NativeRequestContext = {
      sourceId,
      callId: crypto.randomUUID(),
      actor: "system",
      traceId: this.opOperationScope.getStore()?.origin.traceId ?? null,
      parentSourceId:
        this.threadOperationScope.getStore()?.owner.runId ?? this.opOperationScope.getStore()?.owner ?? null,
    };
    const answer = await this.threadOperationScope.run(undefined, () =>
      this.opOperationScope.run(undefined, () =>
        this.withDeployAdmission(
          producer,
          requestContext,
          async () => ({ value: await this.withOpNativeOperation(owner, fn, producer, requestContext) }),
          owner,
        ),
      ),
    );
    if ("error" in answer) throw new Error(answer.error);
    return answer.value;
  }

  private async operationOrigin(
    producer: NativeOperationProducer,
    sourceId: string,
    requestContext?: NativeRequestContext,
  ): Promise<NativeOperationOrigin> {
    return nativeOperationOriginSchema.parse({
      producer,
      resource: await this.ctx.storage.get(RESOURCE_KEY),
      callId: requestContext?.callId ?? crypto.randomUUID(),
      sourceId: requestContext?.sourceId ?? sourceId,
      actor: requestContext?.actor ?? (producer.startsWith("op-") ? "service" : "system"),
      traceId: requestContext?.traceId ?? null,
      parentSourceId:
        requestContext?.parentSourceId ??
        this.threadOperationScope.getStore()?.owner.runId ??
        this.opOperationScope.getStore()?.owner ??
        null,
      build: BUILD_ID,
      workerVersion: workerVersionId(this.env),
      startedAt: systemClock(),
    });
  }

  private async withOpaqueNativeEffect<T>(fn: () => Promise<T>, acknowledged: (result: T) => boolean): Promise<T> {
    const attempt = await this.beginThreadNativeOperation("opaque");
    let result: T;
    try {
      result = await fn();
    } catch (cause) {
      throw new OpaqueNativeOutcomeUnconfirmedError("original SDK outcome is unconfirmed", { cause });
    }
    if (!acknowledged(result))
      throw new OpaqueNativeOutcomeUnconfirmedError("original SDK acknowledgement is unconfirmed");
    try {
      await attempt.settle();
    } catch (cause) {
      throw new OpaqueNativeOutcomeUnconfirmedError("original SDK settlement is unconfirmed", { cause });
    }
    return result;
  }

  private nativeScopeTransport() {
    if (!this.ctx.container) throw new Error("native scope runtime unavailable");
    return new CloudflareNativeScopeTransport(this.ctx.container);
  }

  /** Recovery validates its original record before comparing native boots. */
  private nativeScopeRecoveryTransport(): NativeScopeTransport {
    return {
      request: async (value, timeout) => {
        if (!this.ctx.container?.running) {
          let refusal: string | undefined;
          if (this.recreateAdmission.pending) refusal = "recreate-pending";
          else if (this.destroying) refusal = "destroying";
          else if (await this.recreateAdmission.blocked()) refusal = "recreate-held";
          else if (await this.ctx.storage.get(CLEANUP_PENDING_KEY)) refusal = "cleanup-pending";
          else if (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) refusal = "destroy-unconfirmed";
          if (refusal) throw new Error(`native-scope runtime unavailable (${refusal})`);
          await this.start();
        }
        return this.nativeScopeTransport().request(value, timeout);
      },
    };
  }

  private async withOwnedNativeOperation<T>(
    threadKey: string,
    owner: WorkspaceOwner,
    fn: () => Promise<T>,
    attachment = false,
    admittedKey?: string,
  ): Promise<T> {
    const key = admittedKey ?? `native-operation:${threadKey}:${owner.runId}:${crypto.randomUUID()}`;
    const scope = { key, threadKey, owner, attachment, active: true };
    const identity = workspaceOwnerKey(owner);
    this.runNativeScopes.set(identity, (this.runNativeScopes.get(identity) ?? 0) + 1);
    try {
      return await this.withNativeOperationScope(key, owner, scope, () => this.threadOperationScope.run(scope, fn));
    } finally {
      const remaining = this.runNativeScopes.get(identity)! - 1;
      if (remaining) this.runNativeScopes.set(identity, remaining);
      else this.runNativeScopes.delete(identity);
    }
  }

  /** Both request kinds retain the same native-outcome obligation. */
  private async withNativeOperationScope<T>(
    key: string,
    owner: WorkspaceOwner | { opOwner: string },
    scope: { active: boolean; threadKey?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const journal = new NativeOperationJournal(this.ctx.storage);
    await journal.open(key, owner, scope.threadKey);
    try {
      return await fn();
    } finally {
      scope.active = false;
      await journal.close(key);
    }
  }

  private async assertThreadOperationAllowed(): Promise<void> {
    const scope = this.threadOperationScope?.getStore();
    if (!scope) return;
    if (
      !scope.active ||
      (await this.cancellationPending(scope.threadKey)) ||
      (await this.workspaceDiscarded(scope.threadKey, scope.owner.runId))
    )
      throw new RunCancelledError("run cancelled");
    const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(scope.threadKey));
    if (
      (!scope.attachment &&
        !registeredRunOwnsRelease(registration, scope.owner.runId, scope.owner.ownerGen, scope.owner.ownerFence)) ||
      (await this.ctx.storage.get(`cancelled:${scope.threadKey}:${scope.owner.runId}`))
    )
      throw new RunCancelledError("run cancelled");
  }

  private async withThreadBusy<T>(
    threadKey: string,
    fn: () => Promise<T>,
    requestOwner?: WorkspaceOwner | null,
    nativeKey?: string,
    requestContext?: NativeRequestContext,
    purpose = "thread-work",
  ): Promise<T | ThreadErr> {
    if (this.workspaceExclusiveOpsInFlight.has(threadKey))
      return { error: "workspace is busy", status: 409, reason: "busy", cause: "system" };
    // Count before the first admission await: cancellation must see requests
    // waiting for deploy admission, storage, preflight or native launch too.
    this.threadOpsInFlight.set(threadKey, (this.threadOpsInFlight.get(threadKey) ?? 0) + 1);
    try {
      return await this.withDeployAdmission(purpose, requestContext, async () => {
        const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
        const last =
          registration ?? (await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey)))?.lastRunOwner;
        if (
          (await this.workspaceDiscarded(threadKey, requestOwner?.runId ?? last?.runId)) ||
          (requestOwner &&
            (!isWorkspaceOwner(requestOwner) ||
              !registeredRunOwnsRelease(
                registration,
                requestOwner.runId,
                requestOwner.ownerGen,
                requestOwner.ownerFence,
              ))) ||
          (requestOwner === null && (await this.ctx.storage.get(`cancelled-thread:${threadKey}`))) ||
          (last?.runId && (await this.ctx.storage.get(`cancelled:${threadKey}:${requestOwner?.runId ?? last.runId}`)))
        )
          return { error: "run cancelled", status: 409, reason: "busy", cause: "system" } satisfies ThreadErr;
        if (this.workspaceExclusiveOpsInFlight.has(threadKey) || (await this.cancellationPending(threadKey)))
          return { error: "workspace is busy", status: 409, reason: "busy", cause: "system" } satisfies ThreadErr;
        return requestOwner !== undefined && isWorkspaceOwner(last)
          ? this.withOwnedNativeOperation(threadKey, requestOwner ?? last, fn, false, nativeKey)
          : fn();
      });
    } catch (error) {
      if (error instanceof RunCancelledError)
        return { error: "run cancelled", status: 409, reason: "busy", cause: "system" };
      throw error;
    } finally {
      const n = (this.threadOpsInFlight.get(threadKey) ?? 1) - 1;
      if (n <= 0) this.threadOpsInFlight.delete(threadKey);
      else this.threadOpsInFlight.set(threadKey, n);
    }
  }

  private async checkOperationContext(
    threadKey: string,
    owner: WorkspaceOwner | null,
    rows: NativeOperationRows = this.ctx.storage,
  ): Promise<CheckOperationContext | undefined> {
    if (!isWorkspaceOwner(owner)) return undefined;
    const registration = await rows.get<RunRegistration>(runRegKey(threadKey));
    const binding = await rows.get<ThreadBinding>(threadBindingKey(threadKey));
    const fence = await rows.get<WorkspaceOwner>(runFenceKey(threadKey));
    if (
      !isWorkspaceOwner(fence) ||
      workspaceOwnerKey(fence) !== workspaceOwnerKey(owner) ||
      (await rows.get(`discarding:${threadKey}`)) ||
      (await rows.get(`discarded:${threadKey}:${owner.runId}`))
    )
      return undefined;
    if (
      !registeredRunOwnsRelease(registration, owner.runId, owner.ownerGen, owner.ownerFence) ||
      !binding?.container ||
      binding.threadKey !== threadKey ||
      registration?.threadKey !== threadKey ||
      binding.evicted ||
      (await rows.get(`cancelled:${threadKey}:${owner.runId}`)) ||
      (await rows.get(`cancelled-thread:${threadKey}`))
    )
      return undefined;
    return { threadKey, ...owner, incarnation: binding.container };
  }

  async inspectCheckResult(threadKey: string, operation: CheckOperation, owner: WorkspaceOwner | null) {
    const context = await this.checkOperationContext(threadKey, owner);
    if (!context) return { kind: "unknown" as const };
    return new RecordedCheckOperation(this.ctx.storage).inspect(
      context,
      operation,
      async (rows) =>
        JSON.stringify(await this.checkOperationContext(threadKey, owner, rows)) === JSON.stringify(context),
    );
  }

  /** Re-read original Memory custody after routing; the public request cannot
   * supply a check key, workspace owner, result or native proof. */
  async inspectRecordedCheck(
    selector: CheckSelector,
    settle: boolean,
    expectedThreadKey: string,
  ): Promise<{ sourceHash: string; inspection: CheckInspection } | Extract<CheckInspection, { kind: "unavailable" }>> {
    const selected = await readRecordedCheckSource(this.env, selector);
    if (selected.kind !== "source" || selected.source.threadKey !== expectedThreadKey)
      return { kind: "unavailable", reason: "source" };
    try {
      if ((await this.ctx.storage.get<string>(RESOURCE_KEY)) !== `repo:${selected.source.resource.repo}`)
        return { kind: "unavailable", reason: "source" };
      return {
        sourceHash: await checkSourceIdentityHash(selected.source),
        inspection: await new RecordedCheckOperation(this.ctx.storage).inspectRecorded(selected.source, settle),
      };
    } catch {
      return { kind: "unavailable", reason: "backend" };
    }
  }

  async execThread(
    threadKey: string,
    command: string,
    timeoutMs: number,
    traceparent?: string,
    env?: Record<string, string>,
    requestOwner: WorkspaceOwner | null = null,
    checkOperation?: CheckOperation,
    requestContext?: NativeRequestContext,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    const queuedAt = systemClock();
    let startedAt = queuedAt;
    let refusal: ThreadErr | undefined;
    const execute = async (nativeKey?: string) => {
      const answer = await this.withThreadBusy(
        threadKey,
        () => {
          startedAt = systemClock();
          return this.execThreadImpl(threadKey, command, timeoutMs, env);
        },
        requestOwner,
        nativeKey,
        requestContext,
        "exec",
      );
      if ("error" in answer) refusal = answer;
      return answer;
    };
    let res: { stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr;
    try {
      const context = checkOperation ? await this.checkOperationContext(threadKey, requestOwner) : undefined;
      const saved =
        checkOperation && context
          ? await new RecordedCheckOperation(this.ctx.storage).execute(
              context,
              checkOperation,
              { command, timeoutMs, env },
              async (rows) =>
                JSON.stringify(await this.checkOperationContext(threadKey, requestOwner, rows)) ===
                JSON.stringify(context),
              execute,
            )
          : undefined;
      if (checkOperation && context && saved?.kind !== "completed" && !refusal)
        reportCheckResultFailure(
          saved?.kind === "not_started" ? "check_capacity" : "operation_result_unavailable",
          context,
          checkOperation,
        );
      res = checkOperation
        ? saved?.kind === "completed"
          ? saved.result
          : (refusal ??
            ({
              error: "check operation outcome unavailable",
              status: 409,
              reason: saved?.kind === "not_started" ? "check-capacity" : "busy",
              cause: "system",
            } satisfies ThreadErr))
        : await execute();
    } catch (error) {
      emitStepRoot("resident.exec", startedAt, [], traceparent, "error", { waitedMs: startedAt - queuedAt });
      throw error;
    }
    // The command as the resident's own `resident.exec` root (docs/reference/specs/tracing.md
    // item 22): started when the command did, the wait for the thread's turn an attr.
    emitStepRoot("resident.exec", startedAt, [], traceparent, "error" in res ? refusalOutcome(res) : "ok", {
      waitedMs: startedAt - queuedAt,
      ...("error" in res ? {} : { exitCode: res.exitCode }),
    });
    return res;
  }

  /** Observe the original terminal workspace under its existing exclusion.
   * The ordinary release guard judges the measured tree; this method never releases it. */
  async inspectThreadPreservation(
    input: unknown,
    requestContext?: NativeRequestContext,
  ): Promise<
    | { kind: "unknown"; reason: string }
    | {
        kind: "observed";
        binding: Pick<ThreadBinding, "threadKey" | "ref" | "sha" | "user" | "container">;
        owner: WorkspaceOwner;
        fence: WorkspaceOwner;
        ownerStatus: string;
        ownerEvidence: { kind: "terminal" | "acknowledged"; revision: number | null };
        soleClaimant: true;
        uidProcesses: 0;
        tree: PrivateTreeObservation;
        decision: PreservationDecision;
      }
  > {
    const unknown = (reason: string) => ({ kind: "unknown" as const, reason });
    if (!input || typeof input !== "object" || Array.isArray(input)) return unknown("invalid-input");
    const { runId, ...request } = input as Record<string, unknown>;
    const parsed = dependencyInspectionInputSchema.safeParse(request);
    if (!parsed.success || typeof runId !== "string" || !runId || runId.length > 512) return unknown("invalid-input");
    const { threadKey, ref, head } = parsed.data;
    try {
      const inspection = await this.withDeployAdmission("inspect-preservation", requestContext, () =>
        this.threadAttaches.run(threadKey, async () => {
          if (
            this.destroying ||
            this.ctx.container?.running !== true ||
            (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) ||
            (await this.recreateAdmission.blocked()) ||
            this.memoryGuard.gate("exec")
          )
            return unknown("runtime-unavailable");
          const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
          const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
          const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
          if (
            !binding ||
            binding.evicted ||
            binding.threadKey !== threadKey ||
            binding.ref !== ref ||
            !isResidentPoolUser(binding.user)
          )
            return unknown("binding-unverified");
          if (
            this.workspaceExclusiveOpsInFlight.has(threadKey) ||
            (this.threadOpsInFlight.get(threadKey) ?? 0) > 0 ||
            this.opUsersInUse.has(binding.user)
          )
            return unknown("workspace-busy");
          if (
            !registration ||
            registration.threadKey !== threadKey ||
            registration.runId !== runId ||
            !validRunOwner(registration.runId, registration.ownerGen, registration.ownerFence)
          )
            return unknown("owner-registration-incomplete");
          const owner = {
            runId: registration.runId!,
            ownerGen: registration.ownerGen!,
            ownerFence: registration.ownerFence!,
          };
          if (!isWorkspaceOwner(fence) || workspaceOwnerKey(fence) !== workspaceOwnerKey(owner))
            return unknown("owner-fence-mismatch");
          const soleClaimant = async () => {
            const claims = parsePoolBindings(await this.ctx.storage.get(poolBindingKey(binding.user)));
            return (
              claims?.length === 1 &&
              claims[0] === threadKey &&
              (await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`))
            );
          };
          if (!(await soleClaimant())) return unknown("uid-owner-unverified");
          const canonical = await threadWorktreePath(threadKey, ref);
          if (
            binding.worktreePath !== canonical &&
            binding.worktreePath !== (await replacementWorktreePath(threadKey, ref, canonical))
          )
            return unknown("workspace-path-unverified");
          if (!binding.container || (this.containerIdMemo !== undefined && this.containerIdMemo !== binding.container))
            return unknown("workspace-incarnation-mismatch");
          const answer = (await this.observeRunForEviction(registration, binding)) as {
            kind?: string;
            record?: { id?: string; threadKey?: string; status?: string; provisional?: boolean };
            owner?: unknown;
            revision?: unknown;
          } | null;
          const saved = workspaceSettlementOf(binding.workspaceSettlement);
          const record =
            answer?.kind === "terminal"
              ? answer.record
              : isAcknowledgedWorkspaceOwner(answer, owner) &&
                  saved &&
                  workspaceOwnerKey(saved.owner) === workspaceOwnerKey(owner) &&
                  answer.revision === saved.revision
                ? saved.record
                : undefined;
          if (
            record?.id !== runId ||
            record.threadKey !== threadKey ||
            ("provisional" in record && record.provisional === true) ||
            !["completed", "failed", "interrupted", "stopped_soft", "stopped_hard"].includes(record.status ?? "")
          )
            return unknown("owner-unverified");
          return this.withThreadBusy(
            threadKey,
            async () => {
              if ((this.threadOpsInFlight.get(threadKey) ?? 0) !== 1) return unknown("workspace-busy");
              this.workspaceExclusiveOpsInFlight.add(threadKey);
              try {
                if (this.ctx.container?.running !== true) return unknown("runtime-unavailable");
                const path = shellQuote(binding.worktreePath);
                const checkProcesses = [
                  `/usr/bin/pgrep -u ${shellQuote(binding.user)} >/dev/null 2>&1`,
                  'code=$?; test "$code" = 1 || { test "$code" = 0 && exit 23; exit 24; }',
                ];
                const command = [
                  "boot=$(/bin/cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit 20",
                  'printf "container=%s\\n" "$boot"',
                  `if test ! -e ${path} && test ! -L ${path}; then exit 21; fi`,
                  `test -d ${path} && test ! -L ${path} || exit 22`,
                  `test "$(/usr/bin/stat -c %u ${path} 2>/dev/null)" = "$(/usr/bin/id -u ${shellQuote(binding.user)} 2>/dev/null)" || exit 22`,
                  ...checkProcesses,
                  `${privateTreeObservationScript(binding.worktreePath, binding.user, true)} 2>/dev/null || exit 25`,
                  ...checkProcesses,
                ].join("\n");
                const unchanged = async () =>
                  this.ctx.container?.running === true &&
                  JSON.stringify(await this.ctx.storage.get(threadBindingKey(threadKey))) === JSON.stringify(binding) &&
                  JSON.stringify(await this.ctx.storage.get(runRegKey(threadKey))) === JSON.stringify(registration) &&
                  JSON.stringify(await this.ctx.storage.get(runFenceKey(threadKey))) === JSON.stringify(fence) &&
                  (this.threadOpsInFlight.get(threadKey) ?? 0) === 1 &&
                  (await soleClaimant()) &&
                  (this.containerIdMemo === undefined || this.containerIdMemo === binding.container);
                let inspection;
                try {
                  const process = await this.ctx.container.exec([
                    "/usr/bin/env",
                    "-i",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "/usr/bin/timeout",
                    "-s",
                    "KILL",
                    String(CREDENTIAL_INSPECTION_MAX_MS / SECOND_MS),
                    "/bin/sh",
                    "-c",
                    command,
                  ]);
                  inspection = await inspectPrivateTreeObservation(process, binding.container!);
                } catch {
                  if (!(await unchanged())) return unknown("observation-changed");
                  return unknown("native-exec-unavailable");
                }
                if (!(await unchanged())) return unknown("observation-changed");
                if (inspection.kind === "unknown") return inspection;
                const { tree } = inspection;
                if (tree.branch !== ref) return unknown("private-tree-branch-mismatch");
                if (tree.head !== head) return unknown("private-tree-head-mismatch");
                const decision = await this.workspaceRemovalDecision(binding, true, false, {
                  tree,
                  container: binding.container!,
                });
                if (!(await unchanged())) return unknown("observation-changed");
                return {
                  kind: "observed" as const,
                  binding: {
                    threadKey,
                    ref,
                    sha: binding.sha,
                    user: binding.user,
                    container: binding.container,
                  },
                  owner,
                  fence: owner,
                  ownerStatus: record.status!,
                  ownerEvidence: {
                    kind: answer!.kind === "acknowledged" ? ("acknowledged" as const) : ("terminal" as const),
                    revision: answer!.kind === "acknowledged" ? saved!.revision : null,
                  },
                  soleClaimant: true as const,
                  uidProcesses: 0 as const,
                  tree,
                  decision,
                };
              } finally {
                this.workspaceExclusiveOpsInFlight.delete(threadKey);
              }
            },
            undefined,
            undefined,
            requestContext,
            "inspect-preservation",
          );
        }),
      );
      return "error" in inspection ? unknown("deploy-admission-unavailable") : inspection;
    } catch {
      return unknown("observation-unavailable");
    }
  }

  /** Inspect an existing terminal owner's tree without waking, reattaching or repairing it. */
  async inspectThreadDependencies(
    input: unknown,
    requestContext?: NativeRequestContext,
  ): Promise<{ result: DependencyInspection; owner?: { runId: string; ownerGen: string; ownerFence: number } }> {
    const unknown = (): { result: DependencyInspection } => ({ result: { kind: "unknown" } });
    const parsed = dependencyInspectionInputSchema.safeParse(input);
    if (!parsed.success) return unknown();
    const { threadKey, ref, head } = parsed.data;
    try {
      const inspection = await this.withDeployAdmission("inspect-dependencies", requestContext, () =>
        this.threadAttaches.run(threadKey, async () => {
          if (
            this.destroying ||
            this.ctx.container?.running !== true ||
            (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) ||
            (await this.recreateAdmission.blocked()) ||
            this.memoryGuard.gate("exec")
          )
            return unknown();
          const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
          const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
          const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
          if (
            !binding ||
            binding.evicted ||
            binding.threadKey !== threadKey ||
            binding.ref !== ref ||
            !isResidentPoolUser(binding.user) ||
            this.workspaceExclusiveOpsInFlight.has(threadKey) ||
            (this.threadOpsInFlight.get(threadKey) ?? 0) > 0 ||
            this.opUsersInUse.has(binding.user)
          )
            return unknown();
          if (
            !registration ||
            registration.threadKey !== threadKey ||
            !validRunOwner(registration.runId, registration.ownerGen, registration.ownerFence)
          )
            return unknown();
          const owner = {
            runId: registration.runId!,
            ownerGen: registration.ownerGen!,
            ownerFence: registration.ownerFence!,
          };
          if (
            JSON.stringify(fence) !== JSON.stringify(owner) ||
            !(await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`))
          )
            return unknown();
          const observation = (await this.observeRunForEviction(registration, binding)) as {
            kind?: string;
            record?: { id?: string; threadKey?: string; provisional?: boolean; status?: string };
          } | null;
          if (
            observation?.kind !== "terminal" ||
            observation.record?.id !== owner.runId ||
            observation.record.threadKey !== threadKey ||
            observation.record.provisional === true ||
            !["completed", "failed", "interrupted", "stopped_soft", "stopped_hard"].includes(
              observation.record.status ?? "",
            )
          )
            return unknown();
          const canonical = await threadWorktreePath(threadKey, ref);
          if (
            binding.worktreePath !== canonical &&
            binding.worktreePath !== (await replacementWorktreePath(threadKey, ref, canonical))
          )
            return unknown();
          return this.withThreadBusy(
            threadKey,
            async () => {
              if ((this.threadOpsInFlight.get(threadKey) ?? 0) !== 1) return unknown();
              this.workspaceExclusiveOpsInFlight.add(threadKey);
              try {
                if (this.ctx.container?.running !== true) return unknown();
                const command = [
                  `/usr/bin/pgrep -u ${shellQuote(binding.user)} >/dev/null 2>&1`,
                  "code=$?",
                  'if test "$code" != 1; then printf \'{"kind":"unknown"}\'; exit 1; fi',
                  `exec /usr/bin/su -s /bin/sh ${shellQuote(binding.user)} --session-command ${shellQuote(dependencyInspectionCommand(binding.worktreePath, head))}`,
                ].join("\n");
                // Native container exec cannot start a stopped runtime. No model environment, SDK recovery or retry is used.
                const process = await this.ctx.container.exec([
                  "/usr/bin/env",
                  "-i",
                  "PATH=/usr/local/bin:/usr/bin:/bin",
                  "/usr/bin/timeout",
                  "-s",
                  "KILL",
                  String(CREDENTIAL_INSPECTION_MAX_MS / SECOND_MS),
                  "/bin/sh",
                  "-c",
                  command,
                ]);
                const result = await collectDependencyInspection(process);
                const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
                const currentRegistration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
                const currentFence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
                if (
                  this.ctx.container?.running !== true ||
                  JSON.stringify(current) !== JSON.stringify(binding) ||
                  JSON.stringify(currentRegistration) !== JSON.stringify(registration) ||
                  JSON.stringify(currentFence) !== JSON.stringify(fence) ||
                  (this.threadOpsInFlight.get(threadKey) ?? 0) !== 1
                )
                  return unknown();
                return result.kind === "unknown" ? unknown() : { result, owner };
              } finally {
                this.workspaceExclusiveOpsInFlight.delete(threadKey);
              }
            },
            undefined,
            undefined,
            requestContext,
            "inspect-dependencies",
          );
        }),
      );
      return "error" in inspection ? unknown() : inspection;
    } catch {
      return unknown();
    }
  }

  /** A fixed diagnostic over the existing runtime; only counts leave this DO. */
  async inspectThreadCredentials(
    threadKey: string,
    input: unknown,
    env: Record<string, string>,
    requestOwner: WorkspaceOwner | null = null,
    requestContext?: NativeRequestContext,
  ): Promise<CredentialInspection> {
    try {
      const inspection = await this.withThreadBusy(
        threadKey,
        async () => {
          if (this.workspaceExclusiveOpsInFlight.has(threadKey)) return emptyCredentialInspection();
          if (await this.memoryGate("exec")) return emptyCredentialInspection();
          // Inspection cannot hydrate, reattach or repair the selected runtime.
          const parsed = credentialInspectionInputSchema.safeParse(input);
          if (
            !parsed.success ||
            this.destroying ||
            (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) ||
            !(await this.isRuntimeActive())
          )
            return emptyCredentialInspection();
          const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
          if (
            !binding ||
            binding.evicted ||
            !isResidentPoolUser(binding.user) ||
            binding.ref !== parsed.data.ref ||
            !(await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`))
          )
            return emptyCredentialInspection();
          return inspectResidentCredentials(input, env, binding.githubDoorHost, async (command, options) => {
            validateEnvNames(env);
            if (this.threadOperationScope?.getStore()) {
              return this.run(["/bin/sh", "-c", `cd ${binding.worktreePath} && exec ${command}`], {
                timeoutMs: options.timeoutMs,
                env: { ...env, GIT_TERMINAL_PROMPT: "0" },
                nativeUser: binding.user,
              });
            }
            // A dedicated one-send transport: no generic exec logging, retries,
            // output files, timeout recovery command or raw failure response.
            const nativeAttempt = await this.beginThreadNativeOperation("process");
            const proc = await createExtensionProcessSandbox(this).exec(
              [
                "/usr/bin/su",
                "-s",
                "/bin/sh",
                binding.user,
                "-c",
                `cd ${binding.worktreePath} && exec ${command}`,
              ] as SandboxCommand,
              { timeout: options.timeoutMs, env: { ...env, GIT_TERMINAL_PROMPT: "0" } },
            );
            await nativeAttempt.launched(proc);
            try {
              const raw = await proc.output({ encoding: "utf8", timeout: options.timeoutMs });
              if (Number.isSafeInteger(raw.exitCode) && raw.exitCode >= 0) await nativeAttempt.settle();
              return { ...raw, truncated: raw.truncated === true };
            } catch {
              await proc.kill(9).catch(() => {});
              return undefined;
            }
          });
        },
        requestOwner,
        undefined,
        requestContext,
        "credentials",
      );
      return "error" in inspection ? emptyCredentialInspection() : inspection;
    } catch {
      return emptyCredentialInspection();
    }
  }

  /** A typed Git transport never enters the thread user's shell. The root-owned
   * mirror supplies trusted config; the thread clone supplies object bytes only.
   * The Git Door's one-use tuple remains the write authorization. */
  async publishThread(
    threadKey: string,
    input: Omit<ResidentPublicationInput, "worktreePath">,
    requestOwner: WorkspaceOwner | null = null,
    requestContext?: NativeRequestContext,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    return this.withThreadBusy(
      threadKey,
      async (): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> => {
        const memory = await this.memoryGate("exec");
        if (memory) return memory;
        const pre = await this.threadPreflight(threadKey);
        if ("error" in pre) return pre;
        const { binding } = pre;
        if (binding.readonly || !binding.githubDoorHost)
          return { error: "publication requires a writable Git Door binding", status: 403, cause: "request" };
        let command: ReturnType<typeof residentPublicationCommand>;
        try {
          command = residentPublicationCommand({ ...input, worktreePath: binding.worktreePath });
        } catch {
          return { error: "invalid typed publication request", status: 400, cause: "request" };
        }
        if (new URL(input.doorOrigin).host !== binding.githubDoorHost)
          return { error: "publication Door host does not match the thread binding", status: 403, cause: "request" };
        const objects = await this.run(["test", "-d", command.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]);
        if (objects.exitCode !== 0)
          return { error: "publication source objects are unavailable", status: 409, cause: "request" };
        const settlePublication = await this.beginThreadNativeOperation();
        let result: Awaited<ReturnType<ResidentDO["run"]>>;
        try {
          result = await this.run(command.argv, { timeoutMs: BASH_TIMEOUT_MS, env: command.env });
        } catch (error) {
          if (
            error instanceof RunCancelledError ||
            error instanceof SandboxRuntimeBusyError ||
            error instanceof RuntimeUnreachableError
          )
            await settlePublication.settle();
          throw error;
        }
        // A failed push can have reached the remote. Its native exit alone
        // does not settle the publication; keep its exact admission held.
        if (result.exitCode === 0 && !result.timedOut) await settlePublication.settle();
        return {
          stdout: result.stdout.slice(0, EXEC_OUTPUT_CAP),
          stderr: result.stderr.slice(0, EXEC_OUTPUT_CAP),
          exitCode: result.timedOut ? 124 : result.exitCode,
          truncated:
            result.truncated === true ||
            result.stdout.length > EXEC_OUTPUT_CAP ||
            result.stderr.length > EXEC_OUTPUT_CAP,
        };
      },
      requestOwner,
      undefined,
      requestContext,
      "publish",
    );
  }

  /** The exec route's one gate for a runtime replacement (item 43): every
   *  `RuntimeReplacedError` the route meets — the preflight's own probe of the
   *  worktree, the command itself — is judged by `replacedExecAnswer`, so the
   *  word reaches the harness only when the SDK vouched the runtime moved or
   *  the resident knows the container it held is gone. */
  private async execThreadImpl(
    threadKey: string,
    command: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    try {
      return await this.execThreadBody(threadKey, command, timeoutMs, env);
    } catch (err) {
      // A DO reset over a live container answers its own word at once — the
      // container is unchanged, so no `replacedExecAnswer` gate applies.
      if (err instanceof ControlResetError) return controlResetErr(err);
      if (err instanceof RuntimeReplacedError) return this.replacedExecAnswer(err);
      // A refused connect at the command's spawn (item 68): the wait token,
      // the command never started.
      if (err instanceof SandboxRuntimeBusyError) return runtimeBusyErr(err);
      throw err;
    }
  }

  private async execThreadBody(
    threadKey: string,
    command: string,
    timeoutMs: number,
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    // Item 70: a new command is refused by name above the hard memory
    // threshold — before the preflight, so nothing of it starts.
    const memory = await this.memoryGate("exec");
    if (memory) return memory;
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const { binding } = pre;
    if (!binding.readonly && !binding.githubDoorHost)
      return { error: "writable command requires a Git door binding", status: 403, cause: "request" };
    if (
      binding.githubDoorHost &&
      (env?.GH_HOST !== binding.githubDoorHost ||
        !/^sbr_[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{20,128}$/.test(env?.GH_ENTERPRISE_TOKEN ?? ""))
    )
      return { error: "Git door run bearer is missing from this command", status: 403, cause: "request" };
    await this.putThreadBinding({
      ...binding,
      lastAttachAt: new Date(systemClock()).toISOString(), // exec counts as activity for the sweep
    } satisfies ThreadBinding);

    // A runtime replacement or a control reset under the command propagates to
    // `execThread`'s gate (`replacedExecAnswer` / `controlResetErr`).
    const r = await this.threadRunCapped(binding.user, binding.worktreePath, command, timeoutMs, EXEC_OUTPUT_CAP, env);
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
    requestOwner: WorkspaceOwner | null = null,
    requestContext?: NativeRequestContext,
  ): Promise<{ content: string; truncated: boolean } | Base64ReadAnswer | ThreadErr> {
    return this.withThreadBusy(
      threadKey,
      () => this.readThreadFileImpl(threadKey, path, encoding),
      requestOwner,
      undefined,
      requestContext,
      "read",
    );
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
      if (err instanceof ControlResetError) return controlResetErr(err);
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      if (err instanceof SandboxRuntimeBusyError) return runtimeBusyErr(err);
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
      if (err instanceof ControlResetError) return controlResetErr(err);
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      if (err instanceof SandboxRuntimeBusyError) return runtimeBusyErr(err);
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
    requestOwner: WorkspaceOwner | null = null,
    requestContext?: NativeRequestContext,
  ): Promise<{ ok: true; bytes: number } | ThreadErr> {
    return this.withThreadBusy(
      threadKey,
      () => this.threadWrites.run(threadKey, () => this.writeThreadFileImpl(threadKey, path, content)),
      requestOwner,
      undefined,
      requestContext,
      "write",
    );
  }

  /** All writes for a thread share its stage file; keep staging and cleanup
   *  in one operation so a failed write cannot remove another write's data. */
  private readonly threadWrites = new KeyedAsyncLock();

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
      await this.writeOwnedFile(stage, content);
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
      if (err instanceof RunCancelledError) throw err;
      try {
        await this.runOk(legacyStageReuseScrubCommand(stageDir), "stage-write-cleanup");
      } catch (cleanupErr) {
        // The next UID reservation still refuses nonempty staging content.
        console.log(`write: stage cleanup failed for ${threadKey}: ${errMsg(cleanupErr)}`);
      }
      if (err instanceof ControlResetError) return controlResetErr(err);
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      if (err instanceof SandboxRuntimeBusyError) return runtimeBusyErr(err);
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `write-failed${step}: ${errMsg(err)}`, status: 400 };
    }
    return { ok: true, bytes: content.length };
  }

  /** Keep the overwritten physical owner discoverable without a state read.
   * Capacity refuses before materialization or registration transfer. */
  private async retainWorkspacePredecessor(threadKey: string, owner: WorkspaceOwner): Promise<ThreadErr | undefined> {
    return this.ctx.storage.transaction(async (txn) => {
      const binding = await txn.get<ThreadBinding>(threadBindingKey(threadKey));
      const prior = await txn.get<RunRegistration>(runRegKey(threadKey));
      const previous = prior ?? binding?.lastRunOwner;
      if (!binding || !previous || !hasRunOwnerField(previous)) return;
      if (binding.threadKey !== threadKey)
        return { error: "workspace-owner-unverified", status: 409, code: "owner_unverified" };
      if (!isWorkspaceOwner(previous))
        return { error: "workspace-owner-unverified", status: 409, code: "owner_unverified" };
      const loss = await txn.get<{ completed?: boolean; owner?: unknown }>(`discarded:${threadKey}:${previous.runId}`);
      if (
        loss?.completed &&
        isWorkspaceOwner(loss.owner) &&
        workspaceOwnerKey(loss.owner) === workspaceOwnerKey(previous)
      )
        return;
      const key = workspaceOwnerKey(previous);
      if (key === workspaceOwnerKey(owner)) return;
      const pending = binding.workspacePredecessors ?? [];
      if (!Array.isArray(pending) || pending.some((p) => !isWorkspaceOwner(p?.owner)))
        return { error: "workspace-owner-unverified", status: 409, code: "owner_unverified" };
      if (pending.some((p) => workspaceOwnerKey(p.owner) === key)) return;
      if (pending.length >= WORKSPACE_PREDECESSORS_MAX)
        return { error: "workspace-settlement-capacity", status: 409, code: "settlement_pending" };
      await txn.put(threadBindingKey(threadKey), {
        ...binding,
        workspacePredecessors: [
          ...pending,
          {
            owner: { runId: previous.runId, ownerGen: previous.ownerGen, ownerFence: previous.ownerFence },
            binding: prior?.workspace ?? binding.workspaceSettlement?.binding ?? null,
            ...(binding.workspaceSettlement && workspaceOwnerKey(binding.workspaceSettlement.owner) === key
              ? { applied: binding.workspaceSettlement }
              : {}),
          },
        ],
      });
    });
  }

  /** Storage and state-Worker traffic only. A down or busy VM cannot starve
   * delivery of terminal metadata; each binding retries independently. */
  private async reconcileWorkspaceSettlements(): Promise<void> {
    const startAfter = await this.ctx.storage.get<string>(WORKSPACE_SETTLEMENT_CURSOR_KEY);
    const bindings = await this.ctx.storage.list<ThreadBinding>({
      prefix: THREAD_KEY_PREFIX,
      limit: WORKSPACE_RECONCILE_BINDINGS_MAX,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, binding] of bindings) {
      try {
        await this.threadAttaches.run(binding.threadKey, () => this.reconcileWorkspaceBinding(binding.threadKey));
      } catch (err) {
        console.warn(`workspace-settlement: retained ${binding.threadKey}: ${errMsg(err)}`);
      } finally {
        await this.ctx.storage.put(WORKSPACE_SETTLEMENT_CURSOR_KEY, key);
      }
    }
    if (bindings.size < WORKSPACE_RECONCILE_BINDINGS_MAX)
      await this.ctx.storage.delete(WORKSPACE_SETTLEMENT_CURSOR_KEY);
  }

  /** Called under the existing thread lock. Facts land together before the
   * exact version ACK. No GitHub mutation or container command is involved. */
  private async reconcileWorkspaceBinding(threadKey: string): Promise<void> {
    const initial = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (
      !initial ||
      initial.threadKey !== threadKey ||
      (initial.workspacePredecessors !== undefined &&
        (!Array.isArray(initial.workspacePredecessors) ||
          initial.workspacePredecessors.length > WORKSPACE_PREDECESSORS_MAX))
    )
      return;
    let binding: ThreadBinding = initial;
    const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
    const current = registration ?? binding.lastRunOwner;
    const currentWorkspace = current?.workspace;
    const refs = [...(binding.workspacePredecessors ?? [])];
    if (isWorkspaceOwner(current))
      refs.push({
        owner: { runId: current.runId, ownerGen: current.ownerGen, ownerFence: current.ownerFence },
        binding: currentWorkspace ?? binding.workspaceSettlement?.binding ?? null,
      });
    const resource = await this.ctx.storage.get<string>(RESOURCE_KEY);
    for (const ref of refs) {
      if (!isWorkspaceOwner(ref.owner) || !workspaceBindingOf(ref.binding, ref.owner)) continue;
      const observed = await this.observeRunForEviction({ threadKey, registeredAt: "", ...ref.owner }, binding);
      const answer = observed as {
        kind?: string;
        settlement?: unknown;
        owner?: unknown;
        revision?: unknown;
        row?: { runId?: string; ownerGen?: string; binding?: unknown; workspaceThreadKey?: string };
      } | null;
      if (!answer) continue;
      if (answer.kind === "live" || answer.kind === "absent") {
        let live = answer.row;
        if (
          answer.kind === "absent" &&
          isWorkspaceOwner(answer.owner) &&
          workspaceOwnerKey(answer.owner) === workspaceOwnerKey(ref.owner) &&
          isWorkspaceOwner(current) &&
          current.runId === ref.owner.runId &&
          current.ownerFence > ref.owner.ownerFence
        ) {
          const observedCurrent = (await this.observeRunForEviction(
            { threadKey, registeredAt: "", ...current },
            binding,
          )) as { kind?: string; settlement?: unknown; owner?: unknown; revision?: unknown } | null;
          const terminal =
            observedCurrent?.kind === "terminal"
              ? workspaceSettlementOf(observedCurrent.settlement)
              : isAcknowledgedWorkspaceOwner(observedCurrent, current) &&
                  observedCurrent.revision === binding.workspaceSettlement?.revision
                ? workspaceSettlementOf(binding.workspaceSettlement)
                : undefined;
          if (terminal && workspaceOwnerKey(terminal.owner) === workspaceOwnerKey(current))
            live = {
              runId: terminal.owner.runId,
              ownerGen: terminal.owner.ownerGen,
              workspaceThreadKey: terminal.record.threadKey,
              binding: terminal.binding,
            };
        }
        const physical = isWorkspaceOwner(current) ? workspaceBindingOf(live?.binding, current) : undefined;
        if (
          isWorkspaceOwner(current) &&
          current.runId === ref.owner.runId &&
          current.ownerFence > ref.owner.ownerFence &&
          live?.workspaceThreadKey === threadKey &&
          live.runId === current.runId &&
          live.ownerGen === current.ownerGen &&
          physical &&
          physical.backend === "resident" &&
          physical.ownerGen === current.ownerGen &&
          physical.ownerFence === current.ownerFence &&
          currentWorkspace &&
          workspaceBindingOf(currentWorkspace, current) &&
          currentWorkspace.ownerGen === current.ownerGen &&
          currentWorkspace.ownerFence === current.ownerFence &&
          ["ref", "workspace", "user", "container"].every(
            (field) =>
              physical[field as keyof typeof physical] === ref.binding![field as keyof typeof ref.binding] &&
              physical[field as keyof typeof physical] === currentWorkspace[field as keyof typeof currentWorkspace],
          )
        ) {
          binding = {
            ...binding,
            workspacePredecessors: binding.workspacePredecessors?.filter(
              (p) => workspaceOwnerKey(p.owner) !== workspaceOwnerKey(ref.owner),
            ),
          };
          await this.putThreadBinding(binding, true);
        }
        continue;
      }
      const saved =
        answer.kind === "terminal"
          ? workspaceSettlementOf(answer.settlement)
          : isAcknowledgedWorkspaceOwner(answer, ref.owner)
            ? workspaceSettlementOf(ref.applied ?? binding.workspaceSettlement)
            : undefined;
      if (
        (answer.kind === "acknowledged" &&
          answer.revision !== (ref.applied ?? binding.workspaceSettlement)?.revision) ||
        !saved ||
        !saved.binding ||
        workspaceOwnerKey(saved.owner) !== workspaceOwnerKey(ref.owner) ||
        saved.record.threadKey !== threadKey ||
        resource !== `repo:${saved.record.repo}` ||
        saved.publication?.complete !== true ||
        saved.record.publicationSettlement === null ||
        [saved.record.userId, saved.record.repo, saved.record.parentInstanceId, saved.record.idempotencyKey].some(
          (v) => v === null,
        )
      )
        continue;
      if (
        ["ref", "workspace", "user", "container", "ownerGen", "ownerFence"].some(
          (field) =>
            saved.binding![field as keyof typeof saved.binding] !== ref.binding![field as keyof typeof ref.binding],
        )
      )
        continue;
      if (
        answer.kind === "acknowledged" &&
        saved.publication.branches.every((branch) =>
          binding.ownBranches?.some((owned) => owned.ref === branch.ref && owned.pr === branch.pr),
        )
      ) {
        const remaining = binding.workspacePredecessors?.filter(
          (p) => workspaceOwnerKey(p.owner) !== workspaceOwnerKey(ref.owner) || p.applied?.revision !== saved.revision,
        );
        if (remaining?.length !== binding.workspacePredecessors?.length) {
          binding = { ...binding, workspacePredecessors: remaining };
          await this.putThreadBinding(binding, true);
        }
        continue;
      }
      const remembered = rememberOwnBranches(
        binding.ownBranches,
        saved.publication.branches,
        new Date(systemClock()).toISOString(),
      );
      if ("error" in remembered) continue;
      const key = workspaceOwnerKey(ref.owner);
      const next: ThreadBinding = {
        ...binding,
        ownBranches: remembered.ownBranches,
        workspacePredecessors: binding.workspacePredecessors?.map((p) =>
          workspaceOwnerKey(p.owner) === key ? { ...p, applied: saved } : p,
        ),
        ...(isWorkspaceOwner(current) && workspaceOwnerKey(current) === key ? { workspaceSettlement: saved } : {}),
      };
      await this.putThreadBinding(next, true);
      binding = next;
      if (!(await this.ackWorkspaceSettlement(saved))) continue;
      const after = (await this.observeRunForEviction({ threadKey, registeredAt: "", ...ref.owner }, binding)) as {
        kind?: string;
        owner?: unknown;
        revision?: unknown;
      } | null;
      if (
        isAcknowledgedWorkspaceOwner(after, ref.owner) &&
        after.revision === saved.revision &&
        binding.workspacePredecessors?.some((p) => workspaceOwnerKey(p.owner) === key)
      ) {
        binding = {
          ...binding,
          workspacePredecessors: binding.workspacePredecessors.filter(
            (p) => workspaceOwnerKey(p.owner) !== key || p.applied?.revision !== saved.revision,
          ),
        };
        await this.putThreadBinding(binding, true);
      }
    }
    const remaining = binding.workspacePredecessors?.length ?? 0;
    const reconciled = (initial.workspacePredecessors?.length ?? 0) - remaining;
    if (reconciled > 0) {
      try {
        console.log(
          JSON.stringify({ event: "resident.workspace-predecessors.reconciled", threadKey, reconciled, remaining }),
        );
      } catch {
        /* Observation cannot change workspace preservation. */
      }
    }
  }

  private async ackWorkspaceSettlement(value: WorkspaceSettlement): Promise<boolean> {
    const url = this.env.STATE_WORKER_URL,
      token = this.env.MEMORY_TOKEN;
    if (!url || !token) return false;
    try {
      const storageRequest = await prepareStorageRequest("/runs/workspace-ack", {
        storeKey: RUN_STORE_KEY,
        ...value.owner,
        revision: value.revision,
      });
      return await storageTransport(
        storageRequest,
        {
          url: new URL("/runs/workspace-ack", url),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
          timeoutMs: RUN_STORE_TIMEOUT_MS,
          exceptionDetails: false,
          fetch,
        },
        async (response) => response.status === 200 && ((await response.json()) as { ok?: unknown }).ok === true,
      );
    } catch {
      return false;
    }
  }

  /** The state Worker answers one exact run, with live ownership taking
   *  precedence over a provisional or retained history row. An unavailable
   *  answer cannot authorize deletion. */
  private workloadOwnerObservation(
    expected: Pick<RunRegistration, "threadKey" | "runId" | "ownerGen" | "ownerFence">,
    observed: unknown,
  ) {
    if (!validRunOwner(expected.runId, expected.ownerGen, expected.ownerFence)) return null;
    const view = observed as {
      kind?: unknown;
      record?: Record<string, unknown>;
      row?: Record<string, unknown>;
      owner?: unknown;
      revision?: unknown;
      settlement?: { owner?: { runId?: unknown; ownerGen?: unknown; ownerFence?: unknown } };
    } | null;
    if (
      view?.kind === "terminal" &&
      view.record &&
      view.record.id === expected.runId &&
      view.record.threadKey === expected.threadKey &&
      view.record.provisional !== true &&
      (view.settlement === undefined ||
        (view.settlement?.owner &&
          view.settlement.owner.runId === expected.runId &&
          view.settlement.owner.ownerGen === expected.ownerGen &&
          view.settlement.owner.ownerFence === expected.ownerFence)) &&
      ["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"].includes(String(view.record.status))
    )
      return {
        kind: "terminal",
        record: {
          id: expected.runId,
          threadKey: expected.threadKey,
          status: String(view.record.status),
          provisional: false,
        },
      };
    const owner = { runId: expected.runId!, ownerGen: expected.ownerGen!, ownerFence: expected.ownerFence! };
    if (isAcknowledgedWorkspaceOwner(view, owner))
      return { kind: "acknowledged", owner, revision: view!.revision as number };
    const binding = view?.row?.binding as { ownerGen?: unknown; ownerFence?: unknown } | undefined;
    if (
      view?.kind === "live" &&
      view.row &&
      view.row.runId === expected.runId &&
      view.row.ownerGen === expected.ownerGen &&
      binding &&
      binding.ownerGen === expected.ownerGen &&
      binding.ownerFence === expected.ownerFence &&
      (view.row.workspaceThreadKey ?? view.row.threadKey) === expected.threadKey
    )
      return { kind: "live" };
    return null;
  }

  private async observeRunForEviction(
    registration: Pick<RunRegistration, "threadKey" | "runId" | "ownerGen" | "ownerFence"> & { registeredAt?: string },
    _binding?: ThreadBinding,
  ): Promise<unknown> {
    const url = this.env.STATE_WORKER_URL;
    const token = this.env.MEMORY_TOKEN;
    if (!url || !token || !registration.runId) return null;
    try {
      const storageRequest = await prepareStorageRequest("/runs/preservation-owner", {
        storeKey: RUN_STORE_KEY,
        runId: registration.runId,
        ownerGen: registration.ownerGen,
        ownerFence: registration.ownerFence,
      });
      const observed = await storageTransport(
        storageRequest,
        {
          url: new URL("/runs/preservation-owner", url),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
          timeoutMs: RUN_STORE_TIMEOUT_MS,
          exceptionDetails: false,
          fetch,
        },
        async (response) => (response.ok ? response.json() : null),
      );
      // Passive response levels reuse the last canonical observation. This
      // cache is only a capacity hint; admission and custody still read fresh.
      const projected = this.workloadOwnerObservation(registration, observed);
      const observation = projected?.kind === "live" ? null : projected;
      if (validRunOwner(registration.runId, registration.ownerGen, registration.ownerFence))
        await this.ctx.storage
          .transaction(async (txn) => {
            const current = await txn.get<RunRegistration>(runRegKey(registration.threadKey));
            if (!registeredRunOwnsRelease(current, registration.runId, registration.ownerGen, registration.ownerFence))
              return;
            await txn.put(`resident:workloadOwner:${registration.threadKey}`, {
              runId: registration.runId,
              ownerGen: registration.ownerGen,
              ownerFence: registration.ownerFence,
              observation,
            });
          })
          .catch(() => {});
      return observed;
    } catch {
      return null;
    }
  }

  /** Strict current Git proof. The older cleanliness count is only a report:
   *  it omits non-ignored untracked files and treats an absent tree as clean. */
  private async observePrivateTree(binding: ThreadBinding) {
    try {
      const result = await this.run([
        "/bin/sh",
        "-c",
        privateTreeObservationScript(binding.worktreePath, binding.user),
      ]);
      return parsePrivateTreeObservation(result);
    } catch {
      return null;
    }
  }

  /** A restored VM can retain the durable binding after its private disk is
   * gone. Retire that binding only after checking the exact path, sole UID
   * claimant, empty UID directories and staging, and no process on an active runtime. */
  private async observeAbsentPrivateTree(binding: ThreadBinding): Promise<boolean> {
    try {
      const canonical = await threadWorktreePath(binding.threadKey, binding.ref);
      if (
        binding.worktreePath !== canonical &&
        binding.worktreePath !== (await replacementWorktreePath(binding.threadKey, binding.ref, canonical))
      )
        return false;
      if (this.hydration !== null || (await this.getStatus()).state !== "warm") return false;
      if (await this.recreateAdmission.blocked()) return false;
      if (!(await this.isRuntimeActive())) return false;
      const claimants = parsePoolBindings(await this.ctx.storage.get(poolBindingKey(binding.user)));
      if (!claimants || claimants.length !== 1 || claimants[0] !== binding.threadKey) return false;
      const dir = parentDir(binding.worktreePath);
      const absentScript =
        'import os, sys\ntry:\n    os.lstat(sys.argv[1])\nexcept FileNotFoundError:\n    print("absent")\nelse:\n    raise SystemExit(42)\n';
      const absent = await this.run(["sh", "-c", `python3 -c ${shellQuote(absentScript)} "$1"`, "_", dir]);
      if (
        absent.exitCode !== 0 ||
        absent.timedOut ||
        absent.truncated ||
        absent.stderr !== "" ||
        absent.stdout !== "absent\n"
      )
        return false;
      if (await this.poolUserHasOldThreadDir(binding.user, [])) return false;
      if (await this.poolUserHasOldStageContent(binding.user)) return false;
      const processes = await this.run(["pgrep", "-u", binding.user]);
      return (
        processes.exitCode === 1 &&
        processes.stdout.trim() === "" &&
        processes.stderr.trim() === "" &&
        !processes.timedOut &&
        !processes.truncated
      );
    } catch {
      return false;
    }
  }

  /** Same-owner checkout movement has its own authority: a live owner may
   * advance a clean recorded head, but cannot grant terminal deletion. The
   * caller holds both locks and blocks file operations until attach settles. */
  private async guardWorkspaceAdvance(
    binding: ThreadBinding,
    owner: WorkspaceOwner,
    waitForProcessExit = true,
  ): Promise<ThreadErr | null> {
    const refuse = (step: ResidentStepLabelKey): ThreadErr => {
      const trace = this.stepTrace.getStore();
      if (trace) {
        const at = systemClock();
        trace.record(step, { startedAt: at, endedAt: at, ok: false });
      }
      return {
        error: "workspace-preserved: live owner advance unverified",
        status: 409,
        reason: "workspace-preserved",
      };
    };
    const [current, registration, fence] = await Promise.all([
      this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey)),
      this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey)),
      this.ctx.storage.get<unknown>(runFenceKey(binding.threadKey)),
    ]);
    if (
      !isWorkspaceOwner(owner) ||
      !isWorkspaceOwner(registration) ||
      !isWorkspaceOwner(fence) ||
      workspaceOwnerKey(owner) !== workspaceOwnerKey(registration) ||
      workspaceOwnerKey(owner) !== workspaceOwnerKey(fence) ||
      registration.threadKey !== binding.threadKey ||
      binding.readonly !== true ||
      !binding.sha ||
      !/^[a-f0-9]{40}$/.test(binding.sha) ||
      !current ||
      ["threadKey", "ref", "worktreePath", "user", "container", "sha", "readonly"].some(
        (field) => current[field as keyof ThreadBinding] !== binding[field as keyof ThreadBinding],
      ) ||
      (this.threadOpsInFlight.get(binding.threadKey) ?? 0) > 0 ||
      this.opUsersInUse.has(binding.user) ||
      !binding.container ||
      (await this.containerIdentity()) !== binding.container ||
      !(await this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`))
    )
      return refuse("advance-owner-check");
    const registered = workspaceBindingOf(registration.workspace, owner);
    const answer = (await this.observeRunForEviction(registration, binding)) as {
      kind?: string;
      row?: { runId?: string; ownerGen?: string; workspaceThreadKey?: string; binding?: unknown };
    } | null;
    const live = answer?.kind === "live" ? answer.row : undefined;
    const physical = workspaceBindingOf(live?.binding, owner);
    if (
      !registered ||
      !physical ||
      live?.runId !== owner.runId ||
      live.ownerGen !== owner.ownerGen ||
      live.workspaceThreadKey !== binding.threadKey ||
      ["ref", "workspace", "user", "container"].some(
        (field) => registered[field as keyof typeof registered] !== physical[field as keyof typeof physical],
      ) ||
      registered.ref !== binding.ref ||
      registered.workspace !== binding.worktreePath ||
      registered.user !== binding.user ||
      registered.container !== binding.container
    )
      return refuse("advance-live-binding");
    const tree = await this.observePrivateTree(binding);
    if (
      !tree ||
      tree.head !== binding.sha ||
      tree.branch !== binding.ref ||
      tree.uncommittedChanges !== 0 ||
      tree.untrackedNonIgnored !== 0 ||
      tree.unpushedCommits !== 0
    )
      return refuse("advance-tree-check");
    const processes = await this.run(["pgrep", "-u", binding.user]);
    // A completed producer can leave a process briefly exiting. Wait once
    // only for a complete PID list, then recheck every ownership and tree
    // condition. No process is signalled and no command is replayed.
    if (
      waitForProcessExit &&
      processes.exitCode === 0 &&
      /^[1-9]\d*(?:\n[1-9]\d*)*\n?$/.test(processes.stdout) &&
      processes.stderr === "" &&
      !processes.timedOut &&
      !processes.truncated
    ) {
      await sleep(SECOND_MS);
      return this.guardWorkspaceAdvance(binding, owner, false);
    }
    if (
      processes.exitCode !== 1 ||
      processes.stdout.trim() !== "" ||
      processes.stderr.trim() !== "" ||
      processes.timedOut ||
      processes.truncated
    )
      return refuse("advance-process-check");
    const fresh = (await this.observeRunForEviction(registration, binding)) as typeof answer;
    const freshPhysical = fresh?.kind === "live" ? workspaceBindingOf(fresh.row?.binding, owner) : undefined;
    if (
      !freshPhysical ||
      fresh?.row?.runId !== owner.runId ||
      fresh.row.ownerGen !== owner.ownerGen ||
      fresh.row.workspaceThreadKey !== binding.threadKey ||
      ["ref", "workspace", "user", "container"].some(
        (field) => physical[field as keyof typeof physical] !== freshPhysical[field as keyof typeof freshPhysical],
      )
    )
      return refuse("advance-owner-recheck");
    return null;
  }

  private async guardWorkspaceReplacement(binding: ThreadBinding): Promise<ThreadErr | null> {
    if ((this.threadOpsInFlight.get(binding.threadKey) ?? 0) > 0) {
      await this.reportBlockedWorkspace({ binding, reason: "thread-operation-in-flight" });
      return { error: "workspace-preserved: thread-operation-in-flight", status: 409, reason: "workspace-preserved" };
    }
    // Attach can retain an already terminal predecessor before the watchdog
    // runs. Apply its exact settlement before pending metadata blocks reuse.
    await this.reconcileWorkspaceBinding(binding.threadKey);
    const decision = await this.workspaceRemovalDecision(binding, await this.isRuntimeActive());
    if (decision.removable) return null;
    await this.reportBlockedWorkspace({ binding, reason: decision.reason });
    return {
      error: `workspace-preserved: ${decision.reason}`,
      status: 409,
      reason: "workspace-preserved",
      code: preservedWorkspaceCode(decision.reason),
    };
  }

  /** One decision for every automatic loss path. A true legacy cache needs
   *  no remote read; a known owner stays until exact terminal and current
   *  private-tree evidence agree, except for eviction of a verified absent
   *  directory that no process still owns. */
  private async workspaceRemovalDecision(
    binding: ThreadBinding,
    canObserveTree = true,
    recoverAbsent = false,
    observation?: { tree: PrivateTreeObservation; container: string },
  ): Promise<PreservationDecision> {
    const pending = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
    if (
      pending?.workspacePredecessors !== undefined &&
      (!Array.isArray(pending.workspacePredecessors) || pending.workspacePredecessors.length > 0)
    )
      return { removable: false, reason: "workspace-settlement-pending" };
    const [registration, fence] = await Promise.all([
      this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey)),
      this.ctx.storage.get<unknown>(runFenceKey(binding.threadKey)),
    ]);
    const input = { binding, registration, fence, owner: null as unknown, tree: null as unknown };
    let decision = decideWorkspaceRemoval(input);
    if (decision.removable || decision.reason !== "owner-unavailable") return decision;
    input.owner = await this.observeRunForEviction(registration!, binding);
    const answer = input.owner as { kind?: string; settlement?: unknown; owner?: unknown; revision?: unknown } | null;
    if ((registration && Object.hasOwn(registration, "workspace")) || answer?.kind === "acknowledged") {
      const saved = workspaceSettlementOf(pending?.workspaceSettlement);
      if (answer?.kind === "live") return { removable: false, reason: "owner-live" };
      if (
        !saved ||
        !saved.binding ||
        !isWorkspaceOwner(registration) ||
        workspaceOwnerKey(saved.owner) !== workspaceOwnerKey(registration) ||
        saved.record.threadKey !== binding.threadKey ||
        saved.publication?.complete !== true ||
        saved.record.publicationSettlement === null ||
        [saved.record.userId, saved.record.repo, saved.record.parentInstanceId, saved.record.idempotencyKey].some(
          (v) => v === null,
        ) ||
        saved.binding.ref !== binding.ref ||
        saved.binding.workspace !== binding.worktreePath ||
        saved.binding.user !== binding.user ||
        saved.binding.container !== binding.container ||
        !saved.publication.branches.every((branch) =>
          pending?.ownBranches?.some((owned) => owned.ref === branch.ref && owned.pr === branch.pr),
        )
      )
        return { removable: false, reason: "workspace-settlement-unverified" };
      const resource = await this.ctx.storage.get<string>(RESOURCE_KEY);
      if (resource !== `repo:${saved.record.repo}`)
        return { removable: false, reason: "workspace-settlement-unverified" };
      if (!isAcknowledgedWorkspaceOwner(answer, saved.owner) || answer.revision !== saved.revision)
        return { removable: false, reason: "workspace-settlement-unverified" };
      input.owner = { kind: "terminal", record: saved.record };
    }
    decision = decideWorkspaceRemoval(input);
    if (decision.removable || decision.reason !== "private-tree-unverified" || !canObserveTree) return decision;
    input.tree = observation?.tree ?? (await this.observePrivateTree(binding));
    if (
      binding.container &&
      input.tree !== null &&
      (observation?.container ?? (await this.containerIdentity())) !== binding.container
    )
      return { removable: false, reason: "workspace-incarnation-mismatch" };
    decision = decideWorkspaceRemoval(input);
    if (decision.removable || !recoverAbsent || input.tree !== null) return decision;
    if (!(await this.observeAbsentPrivateTree(binding))) return decision;
    input.tree = { present: false, absenceVerified: true };
    return decideWorkspaceRemoval(input);
  }

  /** A blocked release is visible on the binding, without changing owner or
   *  claiming that any bytes were saved. */
  private async reportBlockedWorkspace(input: { binding: ThreadBinding; reason: string }): Promise<void> {
    const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(input.binding.threadKey));
    if (
      !current ||
      current.evicted ||
      current.user !== input.binding.user ||
      current.lastAttachAt !== input.binding.lastAttachAt ||
      current.ref !== input.binding.ref
    )
      return;
    if (current.preservationBlocked !== input.reason)
      await this.putThreadBinding({ ...current, preservationBlocked: input.reason });
    console.log(`workspace-preservation: kept ${input.binding.threadKey} (${input.reason})`);
  }

  /** Remove a thread's worktree (when the runtime is up — a slept container
   *  already lost it) and release its pool user; the binding is KEPT, marked
   *  evicted with the cause (`evictedWhy`) and with what the tree held
   *  (`evictedLeftBehind`, or `evictedUnmeasured` when git could not read it), so
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
    threadLockHeld = false,
  ): Promise<"evicted" | "changed" | "cleanup-failed" | "preserved"> {
    if (!threadLockHeld)
      return this.threadAttaches.run(binding.threadKey, () =>
        this.evictBinding(binding, runtimeActive, logCtx, why, tree, true),
      );
    const before = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
    if (
      !before ||
      before.evicted ||
      before.user !== binding.user ||
      before.ref !== binding.ref ||
      before.lastAttachAt !== binding.lastAttachAt ||
      before.worktreePath !== binding.worktreePath
    )
      return "changed";
    if ((this.threadOpsInFlight.get(binding.threadKey) ?? 0) > 0) return "changed";
    this.workspaceExclusiveOpsInFlight.add(binding.threadKey);
    try {
      const decision = await this.workspaceRemovalDecision(before, runtimeActive, true);
      if (decision.removable === false) {
        await this.reportBlockedWorkspace({ binding: before, reason: decision.reason });
        return "preserved";
      }
      // A pre-ledger binding still consumes this UID. Reconstruct its spend
      // before releasing the binding, so another owner cannot inherit it on
      // this VM. The exact claimant and empty disk were checked above.
      if (decision.missingTree && !(await this.markPoolUserSpent(binding.user, `thread:${binding.threadKey}`)))
        return "cleanup-failed";
      if (!(await this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`))) return "cleanup-failed";
      const threadDir = parentDir(binding.worktreePath);
      if (runtimeActive && !threadDir.startsWith(`${THREADS_DIR}/`)) return "cleanup-failed";
      if (runtimeActive) {
        try {
          // Worktree removal counts as a mirror-adjacent mutation — same mutex.
          const removed = await this.withMirrorLock(async () => {
            if (!(await this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`)))
              throw new Error("pool-owner-mismatch: eviction refused before directory removal");
            const latest = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
            if (
              !latest ||
              latest.evicted ||
              latest.user !== binding.user ||
              latest.ref !== binding.ref ||
              latest.lastAttachAt !== binding.lastAttachAt ||
              latest.worktreePath !== binding.worktreePath ||
              (this.threadOpsInFlight.get(binding.threadKey) ?? 0) > 0
            )
              return false;
            // Missing-disk proof was read before this mutex. Recheck here and
            // never delete a path that may have appeared in the meantime.
            if (decision.missingTree) return this.observeAbsentPrivateTree(before);
            await this.runOk(["rm", "-rf", threadDir], "evict");
            return true;
          });
          if (!removed.value) return "changed";
        } catch (err) {
          console.log(`${logCtx}: rm failed for ${binding.threadKey}: ${errMsg(err)}`);
          // The directory may still contain a credential file readable by this
          // UID. Keep the binding live so the allocator cannot give it to a new
          // thread; a later sweep or detach may retry the removal.
          return "cleanup-failed";
        }
        // Item 55: what an `install` thread's package manager left OUTSIDE the
        // tree — its pnpm store (the tree's hardlink source: 0 unique bytes while
        // the tree lived, all of them now), npm/yarn/bun caches — goes with it.
        // Pool users only, never the build user (its store backs the warm checkout).
        // A missing-tree eviction leaves this spent UID's home for VM recycle.
        if (!decision.missingTree && isResidentPoolUser(binding.user)) {
          if (!(await this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`))) return "cleanup-failed";
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
        return "changed";
      }
      const recordedTree: EvictedTree | undefined = decision.missingTree
        ? { unmeasured: "private tree absent on active VM; prior contents unverified" }
        : tree;
      await this.putThreadBinding({
        ...now,
        user: "",
        evicted: true,
        evictedAt: new Date(systemClock()).toISOString(),
        lastRunOwner: await this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey)),
        evictedWhy: why,
        preservationBlocked: undefined,
        evictedLeftBehind: recordedTree && "leftBehind" in recordedTree ? recordedTree.leftBehind : undefined,
        evictedUnmeasured: recordedTree && "unmeasured" in recordedTree ? recordedTree.unmeasured : undefined,
      } satisfies ThreadBinding);
      // The run's registration goes with its binding (item 44): released here,
      // never on a give-way above — a re-attach has re-registered it anyway.
      await this.ctx.storage.delete(runRegKey(binding.threadKey));
      try {
        await new RecordedCheckOperation(this.ctx.storage).retire(binding.threadKey, async (context, rows) => {
          const current = await rows.get<RunRegistration>(runRegKey(context.threadKey));
          return !registeredRunOwnsRelease(current, context.runId, context.ownerGen, context.ownerFence);
        });
      } catch {
        // Optional output cleanup cannot turn completed workspace removal into
        // an unknown release. Retained aliases still refuse repeat execution.
        console.warn("check result cleanup unavailable");
      }
      if (recordedTree)
        console.log(`${logCtx}: ${binding.threadKey} evicted (${why}) — ${evictedTreeSentence(recordedTree)}`);
      return "evicted";
    } finally {
      this.workspaceExclusiveOpsInFlight.delete(binding.threadKey);
    }
  }

  /** POST /detach: a run has ended — release its live binding now instead of
   *  holding it until the TTL sweep. The UID remains spent for this VM
   *  generation. The shared preservation decision decides whether the tree
   *  may go. What it held — uncommitted changes, unpushed commits — is
   *  measured for the answer (`leftBehind`) and the eviction record.
   *  An op in flight also keeps the tree (`busy`) — `force` (read-only agents,
   *  hard stops) KILLS that op first (the bot has already dropped its fetch,
   *  the command would otherwise run on and hold the user until the sweep)
   *  and measures nothing. No binding → 404-shaped error; already evicted → a
   *  no-op success. Never flips lifecycle state. */
  async detachThread(
    threadKey: string,
    force: boolean,
    /** What the ending run pushed (item 16a): remembered on the binding first, whatever the detach then decides. */
    pushed: readonly PushedBranch[] = [],
    runId?: string,
    ownerGen?: string,
    ownerFence?: number,
    requestContext?: NativeRequestContext,
  ): Promise<DetachAnswer | ThreadErr> {
    return this.withDeployAdmission("detach", requestContext, () =>
      this.threadAttaches.run(threadKey, async () => {
        await this.reconcileWorkspaceBinding(threadKey);
        const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
        if (!binding) return { error: `no-binding: ${threadKey} has never attached to this resident`, status: 404 };
        if (binding.evicted || !binding.user) {
          if (pushed.length > 0 && registeredRunOwnsRelease(binding.lastRunOwner, runId, ownerGen, ownerFence)) {
            const refused = await this.rememberOwnBranches(threadKey, pushed);
            if (refused !== undefined) return refused;
          }
          return { released: false, reason: "already-evicted" };
        }
        const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
        if (!registeredRunOwnsRelease(registration, runId, ownerGen, ownerFence))
          return { released: false, reason: "run-registration-mismatch: the workspace belongs to another run" };
        if (pushed.length > 0) {
          const refused = await this.rememberOwnBranches(threadKey, pushed);
          if (refused !== undefined) return refused;
        }
        if (!(await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`)))
          return { error: "pool-owner-mismatch: detach refused for conflicting UID owner", status: 503 };
        const plan = planForceDetach({
          force,
          inFlight: this.threadOpsInFlight.get(threadKey) ?? 0,
          user: binding.user,
          poolUsers: undefined,
        });
        if (plan.action === "refuse") return { released: false, reason: plan.reason, user: binding.user };
        if (plan.action === "kill") {
          if (!(await this.killThreadUserProcesses(plan.user, threadKey, binding.container)).stopped)
            return { error: "runtime-stop-unconfirmed: force detach kept the workspace", status: 503 };
          console.log(
            `detach: force — killed ${plan.user}'s processes for ${threadKey} (${plan.inFlight} op(s) were in flight)`,
          );
          const left = await this.waitForThreadDrain(threadKey);
          if (left > 0) return { released: false, reason: busyAfterKillReason(left), user: binding.user };
        }
        const active = await this.isRuntimeActive().catch(() => false);
        // What the tree still holds, for the answer and the eviction's record.
        // Not measured on a force release: a read-only
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
        const activeNow = await this.isRuntimeActive().catch(() => true);
        const eviction = await this.evictBinding(current, activeNow, `detach`, "detach", tree, true);
        if (eviction === "preserved")
          return { released: false, reason: "workspace-preservation: owner or saved work is not verified", user };
        if (eviction === "cleanup-failed")
          return { released: false, reason: "thread-cleanup-failed: pool user kept", user };
        if (eviction === "changed") return { released: false, reason: "re-attached during eviction — kept", user };
        // Item 55: the tree is gone; the gauge catches up at the next refresh
        // instance's `measure` step, and the admission's `df` sees the space now.
        const leftBehind = tree && "leftBehind" in tree ? tree.leftBehind : undefined;
        return { released: true, user, ...(leftBehind !== undefined ? { leftBehind } : {}) };
      }),
    );
  }

  /** A loss receipt is separate from cancellation and publication evidence.
   * Pending retirement blocks successors; a completed receipt blocks only its old run. */
  private async workspaceDiscarded(threadKey: string, runId?: string): Promise<boolean> {
    return !!(
      (await this.ctx.storage.get(`discarding:${threadKey}`)) ||
      (runId && (await this.ctx.storage.get(`discarded:${threadKey}:${runId}`)))
    );
  }

  /** Explicit operator loss can retire absent private work without fabricating
   * publication. Present bytes still require a separately qualified disposal path. */
  async discardAbsentBinding(input: unknown): Promise<
    | { discarded: false; reason: string; owner?: WorkspaceOwner }
    | {
        discarded: true;
        runId: string;
        user: string;
        disposition: "absent-workspace-retired";
        owner?: WorkspaceOwner;
        fence?: WorkspaceOwner;
        currentBoot?: string | null;
      }
    | ThreadErr
  > {
    const refuse = (reason: string) => ({ discarded: false as const, reason });
    if (!input || typeof input !== "object" || Array.isArray(input)) return refuse("invalid-input");
    const request = input as Record<string, unknown>;
    const fields = [
      "confirmDiscard",
      "threadKey",
      "runId",
      "ownerGen",
      "ownerFence",
      "ref",
      "user",
      "container",
      "lastAttachAt",
    ];
    if (Object.keys(request).some((key) => !fields.includes(key))) return refuse("invalid-input");
    const parsed = parseThreadKey(request.threadKey);
    if (
      "error" in parsed ||
      request.confirmDiscard !== true ||
      ["runId", "ref", "user", "container", "lastAttachAt"].some(
        (key) => typeof request[key] !== "string" || !request[key] || (request[key] as string).length > 512,
      )
    )
      return refuse("invalid-input");
    const { threadKey } = parsed;
    const runId = request.runId as string;
    const key = `discarded:${threadKey}:${runId}`;
    type Receipt = {
      request: Record<string, unknown>;
      owner: WorkspaceOwner;
      completed: boolean;
      user: string;
      binding: ThreadBinding;
    };
    const matches = (prior: Receipt) =>
      ["threadKey", "runId", "ownerGen", "ownerFence", "ref", "user", "container", "lastAttachAt"].every(
        (field) => prior.request[field] === request[field],
      );
    const done = (user: string) => ({
      discarded: true as const,
      runId,
      user,
      disposition: "absent-workspace-retired" as const,
    });
    const readBoot = async () => {
      const command = ["cat", "/proc/sys/kernel/random/boot_id"];
      const result = await this.run(command);
      const boot = result.stdout.trim();
      return result.exitCode === 0 &&
        !result.timedOut &&
        !result.truncated &&
        !result.stderr &&
        /^[A-Za-z0-9-]{1,64}$/.test(boot)
        ? boot
        : undefined;
    };
    return this.withDeployAdmission("discard-absent", undefined, () =>
      this.threadAttaches.run(threadKey, async () => {
        const prior = await this.ctx.storage.get<Receipt>(key);
        if (prior && !matches(prior)) return refuse("discard-target-mismatch");
        if (prior?.completed) {
          const retired = await this.ctx.storage.get<unknown>(`discarded-thread:${threadKey}`);
          const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
          if (
            !isWorkspaceOwner(retired) ||
            !isWorkspaceOwner(fence) ||
            retired.ownerFence < prior.owner.ownerFence ||
            fence.ownerFence < prior.owner.ownerFence ||
            (retired.ownerFence === prior.owner.ownerFence &&
              workspaceOwnerKey(retired) !== workspaceOwnerKey(prior.owner)) ||
            (fence.ownerFence === prior.owner.ownerFence && workspaceOwnerKey(fence) !== workspaceOwnerKey(prior.owner))
          )
            return refuse("discard-receipt-unverified");
          // Receipt verification is metadata-only: SDK execution could wake a VM
          // that stopped during a storage await. Physical reset proof is separate.
          return { ...done(prior.user), owner: prior.owner, fence, currentBoot: null };
        }
        const pending = await this.ctx.storage.get<WorkspaceOwner>(`discarding:${threadKey}`);
        if (pending && (!prior || workspaceOwnerKey(pending) !== workspaceOwnerKey(prior.owner)))
          return refuse("discard-in-progress");
        const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
        const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
        const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
        if (
          !binding ||
          binding.evicted ||
          binding.threadKey !== threadKey ||
          ["ref", "user", "container", "lastAttachAt"].some(
            (field) => binding[field as keyof ThreadBinding] !== request[field],
          ) ||
          !isResidentPoolUser(binding.user)
        )
          return refuse("binding-mismatch");
        if (
          !isWorkspaceOwner(registration) ||
          registration.threadKey !== threadKey ||
          registration.runId !== runId ||
          !isWorkspaceOwner(fence) ||
          workspaceOwnerKey(fence) !== workspaceOwnerKey(registration) ||
          (prior && workspaceOwnerKey(prior.owner) !== workspaceOwnerKey(registration))
        )
          return refuse("owner-fence-mismatch");
        const owner: WorkspaceOwner = { runId, ownerGen: registration.ownerGen, ownerFence: registration.ownerFence };
        const physical = workspaceBindingOf(registration.workspace, owner);
        if (
          !physical ||
          physical.ref !== binding.ref ||
          physical.workspace !== binding.worktreePath ||
          physical.user !== binding.user ||
          physical.container !== binding.container
        )
          return refuse("owner-workspace-mismatch");
        const observed = (await this.observeRunForEviction(registration, binding)) as {
          kind?: string;
          owner?: unknown;
          record?: { id?: string; threadKey?: string; status?: string; provisional?: boolean; repo?: string };
          revision?: number;
        } | null;
        const saved = workspaceSettlementOf(binding.workspaceSettlement);
        let record =
          observed?.kind === "terminal"
            ? observed.record
            : isAcknowledgedWorkspaceOwner(observed, owner) &&
                saved &&
                workspaceOwnerKey(saved.owner) === workspaceOwnerKey(owner) &&
                observed?.revision === saved.revision
              ? saved.record
              : undefined;
        // Older final runs have no generation-scoped settlement. Only an
        // explicit discard may consult their final history after the exact
        // owner is absent; the canonical reader still gives live rows priority.
        if (
          observed?.kind === "absent" &&
          isWorkspaceOwner(observed.owner) &&
          workspaceOwnerKey(observed.owner) === workspaceOwnerKey(owner)
        ) {
          const legacy = (await this.observeRunForEviction(
            { threadKey, registeredAt: registration.registeredAt, runId },
            binding,
          )) as typeof observed;
          if (legacy?.kind === "terminal") record = legacy.record;
        }
        if (
          record?.id !== runId ||
          record.threadKey !== threadKey ||
          `repo:${record.repo}` !== (await this.ctx.storage.get<string>(RESOURCE_KEY)) ||
          ("provisional" in record && record.provisional === true) ||
          !["completed", "failed", "interrupted", "stopped_soft", "stopped_hard"].includes(record.status ?? "")
        )
          return refuse("owner-not-terminal");
        if (request.ownerGen === undefined && request.ownerFence === undefined)
          return { discarded: false as const, reason: "owner-confirmation-required", owner };
        if (request.ownerGen !== owner.ownerGen || request.ownerFence !== owner.ownerFence)
          return refuse("owner-fence-mismatch");
        if (
          this.destroying ||
          this.hydration !== null ||
          !(await this.isRuntimeActive()) ||
          (await this.getStatus()).state !== "warm" ||
          (await this.recreateAdmission.blocked())
        )
          return refuse("runtime-unavailable");
        if (
          this.workspaceExclusiveOpsInFlight.has(threadKey) ||
          (this.threadOpsInFlight.get(threadKey) ?? 0) > 0 ||
          this.opUsersInUse.has(binding.user) ||
          (await this.ctx.storage.list({ prefix: `native-operation:${threadKey}:`, limit: 1 })).size
        )
          return refuse("workspace-busy");
        if (!(await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`)))
          return refuse("uid-owner-unverified");
        this.workspaceExclusiveOpsInFlight.add(threadKey);
        try {
          const receipt: Receipt = { request, owner, user: binding.user, completed: false, binding };
          await this.ctx.storage.transaction(async (txn) => {
            await txn.put(key, receipt);
            await txn.put(`discarding:${threadKey}`, owner);
          });
          const result = await this.withMirrorLock(async () => {
            const boot = await readBoot();
            if (!boot || !(await this.observeAbsentPrivateTree(binding)))
              return refuse("private-tree-absence-unverified");
            if ((await readBoot()) !== boot || this.ctx.container?.running !== true) return refuse("runtime-changed");
            return this.ctx.storage.transaction(async (txn) => {
              const current = await txn.get<ThreadBinding>(threadBindingKey(threadKey));
              const currentOwner = await txn.get<RunRegistration>(runRegKey(threadKey));
              const currentFence = await txn.get<unknown>(runFenceKey(threadKey));
              if (
                JSON.stringify(current) !== JSON.stringify(binding) ||
                JSON.stringify(currentOwner) !== JSON.stringify(registration) ||
                JSON.stringify(currentFence) !== JSON.stringify(fence) ||
                (this.threadOpsInFlight.get(threadKey) ?? 0) > 0 ||
                (await txn.list({ prefix: `native-operation:${threadKey}:`, limit: 1 })).size
              )
                return refuse("target-changed");
              const claimants = await txn.get<unknown>(poolBindingKey(binding.user));
              if (!Array.isArray(claimants) || claimants.length !== 1 || claimants[0] !== threadKey)
                return refuse("uid-owner-unverified");
              const remaining = releasePoolBinding(claimants, threadKey);
              if (!remaining) return refuse("uid-owner-unverified");
              await txn.put(poolBindingKey(binding.user), remaining);
              await txn.put(threadBindingKey(threadKey), {
                ...binding,
                user: "",
                evicted: true,
                evictedAt: new Date(systemClock()).toISOString(),
                evictedWhy: "operator-discard",
                evictedUnmeasured: "operator-authorized loss; private tree verified absent",
                preservationBlocked: undefined,
                lastRunOwner: registration,
              } satisfies ThreadBinding);
              await txn.delete(runRegKey(threadKey));
              await txn.put(key, { ...receipt, completed: true });
              await txn.put(`discarded-thread:${threadKey}`, owner);
              await txn.delete(`discarding:${threadKey}`);
              return { ...done(binding.user), currentBoot: boot };
            });
          });
          return result.value;
        } catch {
          return refuse("observation-unconfirmed");
        } finally {
          this.workspaceExclusiveOpsInFlight.delete(threadKey);
        }
      }),
    );
  }

  async cancelRun(
    cancellation: RunCancellation,
    expected: {
      ref?: string;
      user?: string;
      ownerGen?: string;
      ownerFence?: number;
      container?: string;
      workspace?: string;
    } | null,
  ) {
    const scoped = await this.cancelNativeRunScope(cancellation);
    if (scoped !== null) return scoped;
    const threadKey = cancellation.threadKey;
    type Target = NonNullable<typeof expected>;
    const retainedRuntime = (registration: RunRegistration | undefined): ThreadBinding | undefined => {
      if (!isWorkspaceOwner(registration)) return;
      const physical = workspaceBindingOf(registration.workspace, registration);
      if (!physical || !isResidentPoolUser(physical.user)) return;
      return {
        threadKey,
        ref: physical.ref,
        user: physical.user,
        container: physical.container,
        worktreePath: physical.workspace,
      } as ThreadBinding;
    };
    if (expected === null) {
      const prior = await this.ctx.storage.get<{ cancellation: RunCancellation; target?: Target }>(
        `cancelled:${threadKey}:${cancellation.runId}`,
      );
      if (
        prior &&
        sameCancellation(prior.cancellation, cancellation) &&
        prior.target &&
        typeof prior.target === "object" &&
        !Array.isArray(prior.target)
      )
        expected = prior.target;
    }
    if (expected === null) {
      const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
      const binding =
        (await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey))) ?? retainedRuntime(registration);
      const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
      if (
        !binding ||
        binding.evicted ||
        !binding.container ||
        !binding.worktreePath ||
        !isWorkspaceOwner(registration) ||
        !isWorkspaceOwner(fence) ||
        registration.runId !== cancellation.runId ||
        workspaceOwnerKey(registration) !== workspaceOwnerKey(fence) ||
        !(await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`))
      )
        return cancellationFailure(cancellation, "resident", "custody-unverified");
      expected = {
        ref: binding.ref,
        user: binding.user,
        container: binding.container,
        workspace: binding.worktreePath,
        ownerGen: registration.ownerGen,
        ownerFence: registration.ownerFence,
      };
    }
    const resolvedExpected = expected;
    return this.runCancellations.run(cancellation.runId, async () => {
      const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
      const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
      const runtimeBinding = binding ?? retainedRuntime(registration);
      const key = `cancelled:${threadKey}:${cancellation.runId}`;
      const target = {
        ref: resolvedExpected.ref,
        user: resolvedExpected.user,
        container: resolvedExpected.container,
        workspace: resolvedExpected.workspace,
        ownerGen: resolvedExpected.ownerGen,
        ownerFence: resolvedExpected.ownerFence,
      };
      const matchesTarget = (value: unknown): boolean => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const saved = value as typeof target;
        return (
          typeof saved.ref === "string" &&
          saved.ref.length > 0 &&
          typeof saved.user === "string" &&
          isResidentPoolUser(saved.user) &&
          typeof saved.container === "string" &&
          saved.container.length > 0 &&
          typeof saved.workspace === "string" &&
          saved.workspace.length > 0 &&
          validRunOwner(cancellation.runId, saved.ownerGen, saved.ownerFence) &&
          Object.keys(target).every(
            (field) => saved[field as keyof typeof target] === target[field as keyof typeof target],
          )
        );
      };
      const prior = await this.ctx.storage.get<{
        cancellation: RunCancellation;
        target?: typeof target;
        stopped?: true;
        disposition?: "processes-stopped" | "runtime-retired";
        failure?: CancellationRefusal;
        observation?: CancellationObservation;
      }>(key);
      if (prior && !sameCancellation(prior.cancellation, cancellation))
        return cancellationFailure(cancellation, "resident", "ticket-conflict");
      if (prior?.target !== undefined && !matchesTarget(prior.target))
        return cancellationFailure(cancellation, "resident", "target-changed");
      if (!matchesTarget(target)) return cancellationFailure(cancellation, "resident", "custody-unverified");
      if (prior?.stopped === true) {
        if (!matchesTarget(prior.target)) return cancellationFailure(cancellation, "resident", "custody-unverified");
        return {
          stopped: true,
          cancellationId: cancellation.id,
          disposition: prior.disposition ?? "processes-stopped",
        };
      }
      const refuse = async (
        cause: CancellationRefusal["cause"],
        observation?: CancellationObservation,
        transaction?: DurableObjectTransaction,
      ) => {
        const save = async (txn: DurableObjectTransaction) => {
          const current = await txn.get<typeof prior>(key);
          if (!current || !sameCancellation(current.cancellation, cancellation))
            return cancellationFailure(cancellation, "resident", "ticket-conflict");
          if (!matchesTarget(current.target))
            return cancellationFailure(cancellation, "resident", "custody-unverified");
          if (current.stopped === true)
            return {
              stopped: true as const,
              cancellationId: cancellation.id,
              disposition: current.disposition ?? ("processes-stopped" as const),
            };
          const failure = { phase: "resident" as const, cause };
          await txn.put(key, { ...current, failure, ...(observation ? { observation } : {}) });
          return { ...cancellationFailure(cancellation, "resident", cause), ...(observation ? { observation } : {}) };
        };
        return transaction ? save(transaction) : this.ctx.storage.transaction(save);
      };
      const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
      const savedOriginal = prior !== undefined && matchesTarget(prior.target);
      const registeredRuntime = retainedRuntime(registration);
      const originalEpochMoved =
        savedOriginal &&
        !!binding &&
        !!registeredRuntime &&
        !binding.evicted &&
        binding.container !== target.container &&
        ["ref", "user", "worktreePath"].every(
          (field) => binding[field as keyof ThreadBinding] === originalBindingField(field),
        ) &&
        ["ref", "user", "container", "worktreePath"].every(
          (field) => binding[field as keyof ThreadBinding] === registeredRuntime[field as keyof ThreadBinding],
        ) &&
        registeredRunOwnsRelease(registration, cancellation.runId, target.ownerGen, target.ownerFence) &&
        isWorkspaceOwner(fence) &&
        isWorkspaceOwner(registration) &&
        workspaceOwnerKey(fence) === workspaceOwnerKey(registration) &&
        (await this.poolUserOwnerMatches(binding.user, `thread:${threadKey}`));
      function originalBindingField(field: string) {
        return field === "worktreePath" ? target.workspace : target[field as "ref" | "user"];
      }
      const currentOriginal =
        originalEpochMoved ||
        (!!runtimeBinding &&
          !runtimeBinding.evicted &&
          runtimeBinding.ref === resolvedExpected.ref &&
          runtimeBinding.user === resolvedExpected.user &&
          runtimeBinding.container === resolvedExpected.container &&
          runtimeBinding.worktreePath === resolvedExpected.workspace &&
          registeredRunOwnsRelease(
            registration,
            cancellation.runId,
            resolvedExpected.ownerGen,
            resolvedExpected.ownerFence,
          ) &&
          isWorkspaceOwner(fence) &&
          isWorkspaceOwner(registration) &&
          workspaceOwnerKey(fence) === workspaceOwnerKey(registration) &&
          (await this.poolUserOwnerMatches(runtimeBinding.user, `thread:${threadKey}`)));
      const successor =
        isWorkspaceOwner(registration) &&
        isWorkspaceOwner(fence) &&
        registration.runId !== cancellation.runId &&
        registration.ownerFence > (target.ownerFence ?? 0) &&
        workspaceOwnerKey(registration) === workspaceOwnerKey(fence);
      if (!currentOriginal && registration?.runId === cancellation.runId)
        return cancellationFailure(cancellation, "resident", "target-changed");
      if (!savedOriginal && !currentOriginal) return cancellationFailure(cancellation, "resident", "target-mismatch");
      const originalBinding = {
        threadKey,
        lastRunOwner: { runId: cancellation.runId, ownerGen: target.ownerGen!, ownerFence: target.ownerFence! },
        ref: target.ref!,
        user: target.user!,
        container: target.container!,
        worktreePath: target.workspace!,
      } as ThreadBinding;
      const stopBinding = originalEpochMoved ? registeredRuntime! : originalBinding;
      if (!savedOriginal && (this.destroying || this.ctx.container?.running !== true))
        return cancellationFailure(cancellation, "resident", "target-mismatch");
      this.workspaceExclusiveOpsInFlight.add(threadKey);
      try {
        const admitted = await this.ctx.storage.transaction(async (txn) => {
          const current = await txn.get<typeof prior>(key);
          if (current && !sameCancellation(current.cancellation, cancellation))
            return cancellationFailure(cancellation, "resident", "ticket-conflict");
          if (current?.target !== undefined && !matchesTarget(current.target))
            return cancellationFailure(cancellation, "resident", "target-changed");
          if (current?.stopped === true && !matchesTarget(current.target))
            return cancellationFailure(cancellation, "resident", "custody-unverified");
          if (current?.stopped === true)
            return {
              stopped: true as const,
              cancellationId: cancellation.id,
              disposition: current.disposition ?? ("processes-stopped" as const),
            };
          const currentBinding = await txn.get<ThreadBinding>(threadBindingKey(threadKey));
          const currentOwner = await txn.get<RunRegistration>(runRegKey(threadKey));
          const currentFence = await txn.get<unknown>(runFenceKey(threadKey));
          if (
            JSON.stringify(currentBinding) !== JSON.stringify(binding) ||
            JSON.stringify(currentOwner) !== JSON.stringify(registration) ||
            JSON.stringify(currentFence) !== JSON.stringify(fence)
          )
            return cancellationFailure(cancellation, "resident", "target-changed");
          if (currentOriginal) {
            const held = await txn.get<{ runId?: unknown; cancellationId?: unknown }>(`cancel-control:${threadKey}`);
            if (held && (held.runId !== cancellation.runId || held.cancellationId !== cancellation.id))
              return cancellationFailure(cancellation, "resident", "ticket-conflict");
            await txn.put(`cancel-control:${threadKey}`, {
              runId: cancellation.runId,
              cancellationId: cancellation.id,
            });
            await txn.put(`cancelled-thread:${threadKey}`, true);
          }
          await txn.put(key, { ...current, cancellation, target });
          return null;
        });
        if (admitted) return admitted;
        if (
          successor &&
          (this.runNativeScopes.get(
            workspaceOwnerKey({
              runId: cancellation.runId,
              ownerGen: target.ownerGen!,
              ownerFence: target.ownerFence!,
            }),
          ) ?? 0) > 0
        )
          return await refuse("operations-busy");
        // Prove an obsolete runtime before using an SDK path that could wake
        // a replacement. This observation is native-only and preserves bytes.
        let retirement: RetirementBlock | undefined;
        let retiredBoot = originalEpochMoved
          ? undefined
          : await this.observeRetiredThreadRuntime(
              originalBinding,
              (cause) => {
                retirement = cause;
              },
              successor,
            );
        if (!retiredBoot) {
          if (!currentOriginal) return await refuse("target-changed");
          const active = await new NativeOperationJournal(this.ctx.storage).unresolved(
            `native-operation:${threadKey}:`,
          );
          if (
            [...active.values()].some(
              (value) =>
                isWorkspaceOwner(value) &&
                (value.runId !== cancellation.runId ||
                  value.ownerGen !== target.ownerGen ||
                  value.ownerFence !== target.ownerFence),
            )
          )
            return await refuse("target-changed");
          const initialKill = await this.killThreadUserProcesses(stopBinding.user, threadKey, stopBinding.container);
          if (!initialKill.stopped) {
            const { stopped: _stopped, ...observation } = initialKill;
            return await refuse("kill-unconfirmed", {
              step: "initial-kill",
              ...observation,
              ...(retirement ? { retirement } : {}),
            });
          }
          if (await this.waitForThreadDrain(threadKey)) return await refuse("operations-busy");
          // Unknown native work remains held across an isolate or VM replacement.
          const unresolved = await new NativeOperationJournal(this.ctx.storage).unresolved(
            `native-operation:${threadKey}:`,
          );
          if (unresolved.size) return await refuse("native-outcome-unknown");
          // An admitted launch may have resumed after the first kill. All its
          // waits have now settled; kill detached children too, then ask the
          // native container for its physical identity and this UID's absence.
          const finalKill = await this.killThreadUserProcesses(stopBinding.user, threadKey, stopBinding.container);
          if (!finalKill.stopped) {
            const { stopped: _stopped, ...observation } = finalKill;
            return await refuse("kill-unconfirmed", { step: "final-kill", ...observation });
          }
          if (this.ctx.container?.running !== true) return await refuse("runtime-unavailable");
          const probe = await this.ctx.container.exec([
            "/usr/bin/timeout",
            "-s",
            "KILL",
            String(FORCE_DETACH_KILL_TIMEOUT_MS / SECOND_MS),
            "/bin/sh",
            "-c",
            'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; /usr/bin/pgrep -u "$2" >/dev/null 2>&1; test "$?" = 1',
            "--",
            stopBinding.container!,
            stopBinding.user,
          ]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const exit = await Promise.race([
            probe.exitCode,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), FORCE_DETACH_KILL_TIMEOUT_MS);
            }),
          ]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
          });
          if (exit !== 0 || this.ctx.container?.running !== true) return await refuse("native-observation-unconfirmed");
          if (originalEpochMoved) {
            retiredBoot = await this.observeRetiredThreadRuntime(originalBinding);
            if (!retiredBoot || retiredBoot !== stopBinding.container)
              return await refuse("native-observation-unconfirmed");
          }
        }
        const currentBinding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
        const currentRegistration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
        const currentRuntime = currentBinding ?? retainedRuntime(currentRegistration);
        if (
          !retiredBoot &&
          (!currentRuntime ||
            currentRuntime.evicted ||
            ["threadKey", "ref", "worktreePath", "user", "container"].some(
              (field) => currentRuntime[field as keyof ThreadBinding] !== originalBinding[field as keyof ThreadBinding],
            ) ||
            !registeredRunOwnsRelease(
              currentRegistration,
              cancellation.runId,
              resolvedExpected.ownerGen,
              resolvedExpected.ownerFence,
            ) ||
            !(await this.poolUserOwnerMatches(currentRuntime.user, `thread:${threadKey}`)))
        )
          return await refuse("target-changed");
        if (
          retiredBoot &&
          (await this.observeRetiredThreadRuntime(originalBinding, undefined, successor)) !== retiredBoot
        )
          return await refuse("native-observation-unconfirmed");
        const disposition = retiredBoot ? "runtime-retired" : "processes-stopped";
        const journal = new NativeOperationJournal(this.ctx.storage);
        const records = retiredBoot
          ? await journal.fingerprints(`native-operation:${threadKey}:${cancellation.runId}:`)
          : {};
        if (
          retiredBoot &&
          (await this.observeRetiredThreadRuntime(originalBinding, undefined, successor)) !== retiredBoot
        )
          return await refuse("native-observation-unconfirmed");
        return await this.ctx.storage.transaction(async (txn) => {
          const finalBinding = await txn.get<ThreadBinding>(threadBindingKey(threadKey));
          const finalOwner = await txn.get<RunRegistration>(runRegKey(threadKey));
          const finalFence = await txn.get<unknown>(runFenceKey(threadKey));
          if (
            retiredBoot &&
            (this.runNativeScopes.get(
              workspaceOwnerKey({
                runId: cancellation.runId,
                ownerGen: target.ownerGen!,
                ownerFence: target.ownerFence!,
              }),
            ) ?? 0) > 0
          )
            return refuse("operations-busy", undefined, txn);
          // The old kernel may be gone while this run acquires a new one.
          // Credit retirement only against the ownership snapshot we observed.
          if (
            retiredBoot &&
            (JSON.stringify(finalBinding) !== JSON.stringify(binding) ||
              JSON.stringify(finalOwner) !== JSON.stringify(registration) ||
              JSON.stringify(finalFence) !== JSON.stringify(fence))
          )
            return refuse("target-changed", undefined, txn);
          if (
            !retiredBoot &&
            (JSON.stringify(finalBinding) !== JSON.stringify(currentBinding) ||
              JSON.stringify(finalOwner) !== JSON.stringify(currentRegistration) ||
              !isWorkspaceOwner(finalOwner) ||
              !isWorkspaceOwner(finalFence) ||
              workspaceOwnerKey(finalFence) !== workspaceOwnerKey(finalOwner) ||
              (this.threadOpsInFlight.get(threadKey) ?? 0) > 0 ||
              (await journal.unresolved(`native-operation:${threadKey}:`, txn)).size)
          )
            return refuse("target-changed", undefined, txn);
          const current = await txn.get<typeof prior>(key);
          if (!current || !sameCancellation(current.cancellation, cancellation))
            return cancellationFailure(cancellation, "resident", "ticket-conflict");
          if (!matchesTarget(current.target))
            return cancellationFailure(cancellation, "resident", "custody-unverified");
          if (
            retiredBoot &&
            JSON.stringify(await journal.fingerprints(`native-operation:${threadKey}:${cancellation.runId}:`, txn)) !==
              JSON.stringify(records)
          )
            return refuse("native-outcome-unknown", undefined, txn);
          if (!retiredBoot && currentBinding && currentRegistration)
            await txn.put(threadBindingKey(threadKey), { ...currentBinding, lastRunOwner: currentRegistration });
          if (retiredBoot)
            await txn.put(`native-retirement:${threadKey}:${cancellation.runId}`, {
              version: 1,
              cancellationId: cancellation.id,
              owner: { runId: cancellation.runId, ownerGen: target.ownerGen, ownerFence: target.ownerFence },
              threadKey,
              originalBoot: target.container,
              currentBoot: retiredBoot,
              originalOperationOutcome: "unknown",
              records,
            });
          await txn.put(key, {
            ...current,
            cancellation,
            stopped: true,
            disposition,
            ...(retiredBoot ? { retiredBoot } : {}),
            ...(originalEpochMoved
              ? { endedRuntime: { container: stopBinding.container, user: stopBinding.user } }
              : {}),
          });
          const held = await txn.get<{ runId?: unknown; cancellationId?: unknown }>(`cancel-control:${threadKey}`);
          if (held?.runId === cancellation.runId && held.cancellationId === cancellation.id)
            await txn.delete(`cancel-control:${threadKey}`);
          return { stopped: true, cancellationId: cancellation.id, disposition };
        });
      } catch {
        try {
          return await refuse("runtime-unconfirmed");
        } catch {
          // Storage failure leaves the original intent unresolved. Do not
          // expose a provider error or claim a durable shutdown receipt.
          return cancellationFailure(cancellation, "resident", "runtime-unconfirmed");
        }
      } finally {
        this.workspaceExclusiveOpsInFlight.delete(threadKey);
      }
    });
  }

  private async cancelNativeRunScope(cancellation: RunCancellation) {
    const scopes = new NativeRunScopes(this.ctx.storage, {
      request: (value, timeoutMs) => this.nativeScopeTransport().request(value, timeoutMs),
    });
    let beforeBirth = false;
    try {
      const protocol = await scopes.protocol(cancellation.threadKey, cancellation.runId);
      if (protocol === "legacy" && cancellation.targets !== undefined)
        return cancellationFailure(cancellation, "resident", "custody-unverified");
      beforeBirth = protocol === undefined && cancellation.targets !== undefined;
      if (protocol !== "native-v1" && !beforeBirth) return null;
    } catch {
      return cancellationFailure(cancellation, "resident", "kill-unconfirmed");
    }
    return this.runCancellations.run(cancellation.runId, async () => {
      const key = `cancelled:${cancellation.threadKey}:${cancellation.runId}`;
      const admission = await this.ctx.storage.transaction(async (txn) => {
        const prior = await txn.get<{ cancellation: RunCancellation; stopped?: boolean }>(key);
        if (prior && !sameCancellation(prior.cancellation, cancellation))
          return cancellationFailure(cancellation, "resident", "ticket-conflict");
        await txn.put(key, { ...prior, cancellation });
        return null;
      });
      if (admission) return admission;
      try {
        const owners = await scopes.matching(cancellation.threadKey, cancellation.runId);
        if (owners.length === 0 && !beforeBirth) throw new Error("native scope inventory is missing");
        const closed: NativeScopeRef[] = [];
        for (const owner of owners) {
          const result = await scopes.close(cancellation.threadKey, owner);
          if (!result) throw new Error("native scope changed");
          if (result !== "unstarted") closed.push(result);
        }
        const journal = new NativeOperationJournal(this.ctx.storage);
        const prefix = `native-operation:${cancellation.threadKey}:${cancellation.runId}:`;
        const records = await journal.fingerprints(prefix);
        if (beforeBirth && owners.length !== 0)
          return cancellationFailure(cancellation, "resident", "custody-unverified");
        const active = await journal.unresolved(prefix);
        if (beforeBirth) {
          for (const operationKey of Object.keys(records)) {
            const value = active.get(operationKey);
            if (
              !isWorkspaceOwner(value) ||
              value.runId !== cancellation.runId ||
              !unstartedNativeThread(value, value, cancellation.threadKey) ||
              (value as NativeOperationRecord).native.scope !== undefined
            )
              return cancellationFailure(cancellation, "resident", "custody-unverified");
            owners.push(value);
          }
        }
        if (
          [...active.values()].some((value) => {
            const scope = (value as NativeOperationRecord)?.native?.scope;
            return (
              !owners.some((owner) => unstartedNativeThread(value, owner, cancellation.threadKey)) &&
              (!scope || !closed.some((ref) => JSON.stringify(scope) === JSON.stringify(ref)))
            );
          })
        )
          return cancellationFailure(cancellation, "resident", "native-outcome-unknown");
        return this.ctx.storage.transaction(async (txn) => {
          const prior = await txn.get<{ cancellation: RunCancellation }>(key);
          if (!prior || !sameCancellation(prior.cancellation, cancellation))
            return cancellationFailure(cancellation, "resident", "ticket-conflict");
          if (JSON.stringify(await journal.fingerprints(prefix, txn)) !== JSON.stringify(records))
            return cancellationFailure(cancellation, "resident", "native-outcome-unknown");
          if (beforeBirth) {
            const registration = await txn.get<RunRegistration>(runRegKey(cancellation.threadKey));
            const binding = await txn.get<ThreadBinding>(threadBindingKey(cancellation.threadKey));
            if (
              (registration?.runId === cancellation.runId &&
                (registration.threadKey !== cancellation.threadKey ||
                  !owners.some(
                    (owner) =>
                      isWorkspaceOwner(registration) && workspaceOwnerKey(owner) === workspaceOwnerKey(registration),
                  ))) ||
              binding?.lastRunOwner?.runId === cancellation.runId
            )
              return cancellationFailure(cancellation, "resident", "custody-unverified");
          }
          for (const [operationKey, value] of active) {
            if (owners.some((owner) => unstartedNativeThread(value, owner, cancellation.threadKey))) {
              await txn.put(`native-operation-no-start:${operationKey}`, value);
              await txn.delete(operationKey);
            }
          }
          for (const ref of closed)
            await txn.put(nativeScopeRetirementKey(cancellation.threadKey, ref.owner), {
              scope: ref,
              cancellationId: cancellation.id,
              controllerOwnerGen: cancellation.ownerGen,
              records,
              originalOperationOutcome: "unknown",
            });
          const disposition = beforeBirth ? ("no-workspace" as const) : ("processes-stopped" as const);
          await txn.put(key, { ...prior, stopped: true, disposition, nativeScopes: closed });
          return { stopped: true as const, cancellationId: cancellation.id, disposition };
        });
      } catch {
        return cancellationFailure(cancellation, "resident", "kill-unconfirmed");
      }
    });
  }

  /** A different kernel boot proves the original runtime is gone, not that
   * its workspace may be discarded. Native exec cannot wake a stopped VM. */
  private async observeRetiredThreadRuntime(
    binding: ThreadBinding,
    onBlocked?: (cause: RetirementBlock) => void,
    successor = false,
  ): Promise<string | undefined> {
    const blocked = (cause: RetirementBlock): undefined => {
      onBlocked?.(cause);
      return;
    };
    if (this.destroying) return blocked("destroying");
    if (this.ctx.container?.running !== true) return blocked("runtime-unavailable");
    // Owner/hash and a dead kernel cannot bind an unknown SDK submission to
    // that kernel. Keep its authority held until native confinement is proven.
    if (!isWorkspaceOwner(binding.lastRunOwner)) return blocked("uid-owner-unverified");
    if (
      (
        await new NativeOperationJournal(this.ctx.storage).unresolved(
          `native-operation:${binding.threadKey}:${binding.lastRunOwner.runId}:`,
        )
      ).size
    )
      return blocked("native-outcome-unknown");
    if (!successor && (this.threadOpsInFlight.get(binding.threadKey) ?? 0) > 0) return blocked("operations-busy");
    if (!successor && this.opUsersInUse.has(binding.user)) return blocked("operation-uid-active");
    if (!successor && !(await this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`)))
      return blocked("uid-owner-unverified");
    if (this.ctx.container?.running !== true) return blocked("runtime-unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observation = (async () => {
        const process = await this.ctx.container!.exec([
          "/usr/bin/timeout",
          "-s",
          "KILL",
          String(FORCE_DETACH_KILL_TIMEOUT_MS / SECOND_MS),
          "/bin/sh",
          "-c",
          successor
            ? 'boot=$(/bin/cat /proc/sys/kernel/random/boot_id) || exit 10; test -n "$boot" || exit 10; test "$boot" != "$1" || exit 12; test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$boot" || exit 2; printf "%s\\n" "$boot"'
            : 'boot=$(/bin/cat /proc/sys/kernel/random/boot_id) || exit 10; test -n "$boot" || exit 10; test "$boot" != "$1" || exit 12; /usr/bin/pgrep -u "$2" >/dev/null 2>&1; test "$?" = 1 || exit 3; test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$boot" || exit 2; printf "%s\\n" "$boot"',
          "--",
          binding.container!,
          binding.user,
        ]);
        return process.output();
      })();
      const result = await Promise.race([
        observation,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), FORCE_DETACH_KILL_TIMEOUT_MS);
        }),
      ]);
      if (!result) return blocked("timeout");
      if (result.exitCode === 10) return blocked("boot-read-unconfirmed");
      if (result.exitCode === 12) return blocked("original-runtime-present");
      if (result.exitCode === 2) return blocked("boot-unconfirmed");
      if (result.exitCode === 3) return blocked("uid-presence-unconfirmed");
      if (
        result.exitCode !== 0 ||
        result.stderr.byteLength !== 0 ||
        result.stdout.byteLength > 65 ||
        this.ctx.container?.running !== true
      )
        return blocked("native-observation-unconfirmed");
      const boot = new TextDecoder().decode(result.stdout).trim();
      return /^[A-Za-z0-9-]{1,64}$/.test(boot) && boot !== binding.container ? boot : blocked("boot-unconfirmed");
    } catch {
      return blocked("native-exec-failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Both shutdown paths kill only the recorded boot and pool user —
   *  `kill -9 -1` sent AS THAT USER reaches exactly its own processes (the
   *  thread's `su … bash -c` shell, the command, anything it backgrounded),
   *  nothing else in the container, and needs no procps. Native control
   *  bypasses an unresponsive SDK and cannot wake a replacement VM. The
   *  shell kills itself too, so su exits 137; the outer shell converts only
   *  that observed result to success. A timeout killing the wrapper cannot
   *  masquerade as that result. Lost, timed-out or foreign-boot results do
   *  not acknowledge a kill. Callers still drain and apply their own ending
   *  or workspace-preservation policy after this physical operation. */
  private async killThreadUserProcesses(
    user: string,
    threadKey: string,
    container?: string,
  ): Promise<{ stopped: true } | ({ stopped: false } & Omit<CancellationObservation, "step">)> {
    let phase: "guard" | "launch" | "exit" = "guard";
    const unconfirmed = (
      cause: "target-unverified" | "runtime-unavailable" | "timeout" | "exit-unconfirmed" | "native-exec-failed",
      exitCode?: number,
    ): { stopped: false } & Omit<CancellationObservation, "step"> => {
      // Native failures can carry commands or credentials. Record only the
      // control phase and closed cause, never exception text or output.
      console.warn(
        JSON.stringify({
          event: "resident.uid-kill.unconfirmed",
          cause,
          phase,
          user,
          threadKey,
          ...(exitCode !== undefined ? { exitCode } : {}),
        }),
      );
      return { stopped: false, phase, cause, ...(exitCode !== undefined ? { exitCode } : {}) };
    };
    if (!container || !isResidentPoolUser(user) || !(await this.poolUserOwnerMatches(user, `thread:${threadKey}`)))
      return unconfirmed("target-unverified");
    if (this.ctx.container?.running !== true) return unconfirmed("runtime-unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    phase = "launch";
    try {
      const nativeKill = (async () => {
        const process = await this.ctx.container!.exec([
          "/usr/bin/timeout",
          "-s",
          "KILL",
          String(FORCE_DETACH_KILL_TIMEOUT_MS / SECOND_MS),
          "/bin/sh",
          "-c",
          'test "$(/bin/cat /proc/sys/kernel/random/boot_id)" = "$1" || exit 2; /usr/bin/su -s /bin/bash "$2" -c "kill -9 -1"; case "$?" in 0|137) exit 0;; *) exit 1;; esac',
          "--",
          container,
          user,
        ]);
        phase = "exit";
        return process.exitCode;
      })();
      const exit = await Promise.race([
        nativeKill,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), FORCE_DETACH_KILL_TIMEOUT_MS);
        }),
      ]);
      if (exit !== 0)
        return unconfirmed(
          exit === null ? "timeout" : "exit-unconfirmed",
          typeof exit === "number" && Number.isSafeInteger(exit) ? exit : undefined,
        );
      if (this.ctx.container?.running !== true) return unconfirmed("runtime-unavailable", exit);
      return { stopped: true };
    } catch {
      return unconfirmed("native-exec-failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Wait (bounded, see FORCE_DETACH_DRAIN_MS) for this thread's in-flight op
   *  counter to reach zero after a kill. The counter drops inside
   *  `withThreadBusy`'s finally, i.e. only after `run()` has collected the
   *  killed process's exit — so zero means the admitted calls
   *  have settled. Detached children require a separate native UID observation. The killed op itself completes
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
   *  the disk-full recycle. The preservation decision uses a separate strict
   *  observation. A tree that no longer exists (disk recycled by a sleep/wake)
   *  is clean with nothing measured: there was nothing to discard.
   *
   *  ONE spawn: the presence test and both git probes fold
   *  into the pure `worktreeCleanlinessScript` (test -d as root, both git
   *  commands inside a single privilege-dropped `su`, tagged lines out);
   *  `parseWorktreeCleanliness` encodes the exact decision table above. */
  private async worktreeCleanliness(binding: ThreadBinding): Promise<WorktreeCleanliness> {
    if (!(await this.poolUserOwnerMatches(binding.user, `thread:${binding.threadKey}`)))
      return { clean: false, reason: "pool-owner-mismatch: cleanliness probe refused" };
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
    return (
      threadOps +
      Math.max(this.opUsersInUse.size, this.opAdmissionsInFlight) +
      Math.max(this.attachesInFlight, this.attachAdmissionsInFlight)
    );
  }
  /** The fleet drain in force (item 69), read from the registry at this clock;
   *  a registry that cannot be read is NO drain: a run must never fail because
   *  a flag could not be read, and the deploy's own preflight fails closed on
   *  its side (an unknown fleet refuses the deploy), so the failure lands on
   *  the deploy, never on the run. Said in the log. */
  private async fleetDrain(): Promise<DrainRecord | null> {
    try {
      return liveDrain(await this.registry().getDrain(), systemClock());
    } catch (err) {
      console.warn(`[drain] registry unreadable at attach — treating as no drain: ${errMsg(err)}`);
      return null;
    }
  }
  /** In-flight activity for the deploy preflight (GET /status, GET /residents).
   *  The in-memory counters (a fresh isolate answers 0 for them — nothing of
   *  THEIRS survived to be interrupted) plus the durable run registrations:
   *  a harness run's process DOES survive an isolate swap in the container,
   *  so its registration must too. */
  async getInFlightCount(): Promise<number> {
    return this.inFlightCount() + (await this.registeredRunsBeyondOps());
  }
  /** Admin-only, one exact retained thread. No workspace or private content is
   * changed: unidentified runs remain unidentified and cannot authorize removal. */
  async reconcileRetainedOwner(
    threadKey: string,
  ): Promise<{ migrated: number; legacy: number; ledger: number; reason: string } | ThreadErr> {
    return this.withDeployAdmission("reconcile-owner", undefined, () =>
      this.threadAttaches.run(threadKey, async () => {
        const refuse = (reason: string): ThreadErr => ({
          error: `owner-reconciliation-refused: ${reason}`,
          status: 503,
        });
        const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
        if (!binding || binding.evicted || !binding.user || binding.threadKey !== threadKey)
          return refuse("binding-unavailable");
        if ((this.threadOpsInFlight.get(threadKey) ?? 0) > 0 || this.opUsersInUse.has(binding.user))
          return refuse("owner-active");
        const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(threadKey));
        const fence = await this.ctx.storage.get<unknown>(runFenceKey(threadKey));
        const owner = registration?.runId ? await this.observeRunForEviction(registration, binding) : null;
        const lastRunOwner = binding.lastRunOwner;
        const canonicalPath = await threadWorktreePath(threadKey, binding.ref);
        const path = binding.worktreePath;
        // A named-ref change can slug-collide with its old checkout. In that
        // case the retained row names the deterministic sibling, not canonical.
        if (
          (path !== canonicalPath && path !== (await replacementWorktreePath(threadKey, binding.ref, canonicalPath))) ||
          !(await this.isRuntimeActive())
        )
          return refuse("workspace-unverified");
        try {
          if (await this.poolUserHasOldThreadDir(binding.user, [parentDir(path)])) return refuse("workspace-conflict");
          const disk = await this.run([
            "sh",
            "-c",
            'if test -L "$1" || test -L "$(dirname "$1")" || ! test -d "$1"; then exit 42; fi; stat -c %U "$1"',
            "_",
            path,
          ]);
          if (
            disk.exitCode !== 0 ||
            disk.timedOut ||
            disk.truncated ||
            disk.stderr.trim() ||
            disk.stdout.trim() !== binding.user
          )
            return refuse("workspace-unverified");
          const processes = await this.run(["pgrep", "-u", binding.user]);
          if (
            processes.exitCode !== 1 ||
            processes.stdout.trim() !== "" ||
            processes.stderr.trim() ||
            processes.timedOut ||
            processes.truncated
          )
            return refuse("owner-active-or-unreadable");
        } catch {
          return refuse("workspace-unreadable");
        }
        const now = systemClock();
        return this.ctx.storage.transaction(async (txn) => {
          const current = await txn.get<ThreadBinding>(threadBindingKey(threadKey));
          const row = await txn.get<RunRegistration>(runRegKey(threadKey));
          const currentFence = await txn.get<unknown>(runFenceKey(threadKey));
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(binding) ||
            JSON.stringify(row) !== JSON.stringify(registration) ||
            JSON.stringify(currentFence) !== JSON.stringify(fence) ||
            (this.threadOpsInFlight.get(threadKey) ?? 0) > 0 ||
            this.opUsersInUse.has(binding.user)
          )
            return refuse("owner-changed");
          const ledger = [...(await uidLedger(txn))].map(([user, owner]) => ({ user, owner }));
          const claimants = await txn.get<unknown>(poolBindingKey(binding.user));
          const decision = decideOwnerReconciliation({
            binding,
            registration: row,
            fence,
            lastRunOwner,
            owner,
            ledger,
            claimants,
            pool: undefined,
            now,
            cutoff: now - CLEAN_IDLE_RELEASE_S * 1000,
            graceMs: RUN_REGISTRATION_GRACE_MS,
            opInFlight: this.threadOpsInFlight.get(threadKey) ?? 0,
          });
          if (decision.action === "refuse") return refuse(decision.reason);
          if (decision.spend) {
            const next = await claimUid(txn, binding.user, `thread:${threadKey}`);
            if (!next) return refuse("ledger-conflict");
            // The indexed claim was committed in this transaction.
          }
          if (decision.legacy) await txn.put(runRegKey(threadKey), { ...row, legacyRetainedAt: now });
          return {
            migrated: Number(decision.action === "migrate"),
            legacy: Number(decision.legacy),
            ledger: Number(decision.spend),
            reason: decision.action === "migrate" ? "retained-owner-reconciled" : "already-reconciled",
          };
        });
      }),
    );
  }

  /** A run's registration protects its worktree until release or the bounded
   *  deadline. `/detach`, the sweep, and disk pressure end in `evictBinding`,
   *  which clears the row; a re-attach refreshes it. */
  private async registerRun(
    threadKey: string,
    runBudgetMs?: number,
    runId?: string,
    ownerGen?: string,
    ownerFence?: number,
    attached?: AttachOk,
  ): Promise<void> {
    if (!validRunOwner(runId, ownerGen, ownerFence)) throw new Error("run-registration-incomplete");
    if (await this.workspaceDiscarded(threadKey, runId)) throw new Error("workspace discarded");
    const retained = await this.retainWorkspacePredecessor(threadKey, {
      runId: runId!,
      ownerGen: ownerGen!,
      ownerFence: ownerFence!,
    });
    if (retained) throw new Error(retained.error);
    const now = systemClock();
    await this.ctx.storage.transaction(async (txn) => {
      if ((await txn.get(`discarding:${threadKey}`)) || (await txn.get(`discarded:${threadKey}:${runId}`)))
        throw new Error("workspace discarded");
      if ((await txn.get(`cancelled:${threadKey}:${runId}`)) || (await txn.get(`cancel-control:${threadKey}`)))
        throw new RunCancelledError("run cancelled");
      await txn.put(runFenceKey(threadKey), { runId, ownerGen, ownerFence });
      await txn.put(runRegKey(threadKey), {
        threadKey,
        ...(attached
          ? {
              workspace: attached.container
                ? {
                    backend: "resident" as const,
                    ref: attached.ref,
                    workspace: attached.workspace,
                    user: attached.user,
                    container: attached.container,
                    ownerGen: ownerGen!,
                    ownerFence: ownerFence!,
                  }
                : null,
            }
          : {}),
        registeredAt: new Date(now).toISOString(),
        ...(runBudgetMs !== undefined ? { deadlineAt: now + runBudgetMs } : {}),
        runId,
        ownerGen,
        ownerFence,
      } satisfies RunRegistration);
    });
  }
  /** The harness's lease begins after attach. Tighten the provisional setup
   * bound to its actual remaining clock, only for the run that attached. */
  async updateRunDeadline(
    threadKey: string,
    runId: string,
    remainingMs: number,
    ownerGen?: string,
    ownerFence?: number,
    requestContext?: NativeRequestContext,
  ): Promise<{ deadlineAt: number } | ThreadErr> {
    return this.withDeployAdmission("deadline", requestContext, () =>
      this.ctx.storage.transaction(async (txn) => {
        const registration = await txn.get<RunRegistration>(runRegKey(threadKey));
        if (
          !registration ||
          registration.runId !== runId ||
          registration.ownerGen !== ownerGen ||
          registration.ownerFence !== ownerFence
        )
          return { error: "run-registration-mismatch: this run does not own the thread", status: 409 };
        const deadlineAt = systemClock() + remainingMs;
        await txn.put(runRegKey(threadKey), { ...registration, deadlineAt });
        return { deadlineAt };
      }),
    );
  }
  /** Execution deadlines bound legacy registrations only. A binding with a
   *  durable run identity stays protected until its files pass the shared
   *  preservation decision and the binding is released. */
  private async registeredRunsBeyondOps(excludeNativeKeys?: ReadonlySet<string>): Promise<number> {
    const regs = await this.ctx.storage.list<RunRegistration>({ prefix: RUN_REG_KEY_PREFIX });
    const bindings = await this.liveBindings();
    const cutoff = systemClock() - CLEAN_IDLE_RELEASE_S * 1000;
    // An operator awaiting a UID has not begun its command yet.
    // Only its exact, acknowledged pre-allocation marker may be excluded;
    // reading two entries still detects a foreign marker after that one.
    const native = (await new NativeOperationJournal(this.ctx.storage).unresolved()) as Map<
      string,
      { opOwner?: string }
    >;
    const op = this.opOperationScope?.getStore();
    let n = [...native].some(
      ([key, value]) =>
        !(
          excludeNativeKeys?.has(key) ||
          (op?.active &&
            !op.allocated &&
            key === `native-operation:${op.owner}` &&
            unstartedNativeOperator(value, op.owner))
        ),
    )
      ? 1
      : 0;
    for (const binding of bindings) {
      const r = regs.get(runRegKey(binding.threadKey));
      const fence = await this.ctx.storage.get<unknown>(runFenceKey(binding.threadKey));
      if (hasRunOwnerField(r) || fence !== undefined || hasRunOwnerField(binding.lastRunOwner)) {
        if ((this.threadOpsInFlight.get(binding.threadKey) ?? 0) === 0) n++;
        continue;
      }
      if (!r) continue;
      if (
        registeredRunNeedsProtection(
          binding.lastAttachAt,
          this.threadOpsInFlight.get(binding.threadKey) ?? 0,
          cutoff,
          r.deadlineAt === undefined ? undefined : r.deadlineAt + RUN_REGISTRATION_GRACE_MS,
          systemClock(),
        )
      )
        n++;
    }
    return n;
  }

  /** Deployment activity is distinct from workspace retention. A terminal
   * run's unsaved tree remains held, while only a live owner or command can
   * be interrupted by an isolate swap. Unknown ownership refuses the swap. */
  async getResidentDeployInfo(): Promise<Record<string, unknown>> {
    const bindings = await this.liveBindings();
    const regs = await this.ctx.storage.list<RunRegistration>({ prefix: RUN_REG_KEY_PREFIX });
    const ledger = await this.currentUidLedger();
    let executingRuns = 0;
    let retainedRuns = 0;
    let unknownRuns = 0;
    const readback = new Map<string, { category: string; reason: string; count: number }>();
    const now = systemClock();
    for (const binding of bindings) {
      const registration = regs.get(runRegKey(binding.threadKey));
      const fence = await this.ctx.storage.get<unknown>(runFenceKey(binding.threadKey));
      const owner = registration?.runId ? await this.observeRunForEviction(registration, binding) : null;
      const opInFlight = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
      const { state, category, reason } = classifyDeployRegistrationWithLedger({
        threadKey: binding.threadKey,
        registration,
        fence,
        lastRunOwner: binding.lastRunOwner,
        owner,
        lastAttachAt: binding.lastAttachAt,
        cutoff: now - CLEAN_IDLE_RELEASE_S * 1000,
        now,
        graceMs: RUN_REGISTRATION_GRACE_MS,
        opInFlight,
        ledger,
        claimants: await this.ctx.storage.get<unknown>(poolBindingKey(binding.user)),
        user: binding.user,
        pool: undefined,
      });
      if (state !== "none") {
        const key = `${category}:${reason}`;
        const entry = readback.get(key) ?? { category, reason, count: 0 };
        entry.count++;
        readback.set(key, entry);
      }
      // An operator call on this thread is already in runsInFlightCount().
      if (state === "executing" && opInFlight === 0) executingRuns++;
      else if (state === "retained") retainedRuns++;
      else if (state === "unknown") unknownRuns++;
    }
    const nativeOperationReadback = await this.getNativeOperations();
    if (this.runsInFlightCount() === 0 && (await new NativeOperationJournal(this.ctx.storage).unresolved()).size > 0)
      unknownRuns++;
    return {
      ...(await this.getResidentInfo()),
      executingRuns: executingRuns + this.runsInFlightCount(),
      retainedRuns,
      unknownRuns,
      registrationReadback: [...readback.values()],
      nativeOperationReadback,
    };
  }
  /** Stored metadata only: never reconnect or inspect a native runtime. */
  async getNativeOperations(cursor?: string) {
    return new NativeOperationJournal(this.ctx.storage).list(cursor);
  }

  /** Observe original receipts; explicit termination uses the SDK capability
   * bound to that process's existing runtime, never a PID in a new VM. */
  async recoverNativeOperation(key: string, recordHash: string, terminate = false) {
    return this.withRecreateSafeAdmin(async () => {
      if (this.runsInFlightCount() !== 0 || this.activeOperatorRequests.size !== 0)
        return { error: "native-operation-recovery-refused: request-active", status: 409 as const };
      const ownerMatches = async (rows: NativeOperationRows, record: NativeOperationRecord) => {
        if (this.runsInFlightCount() !== 0) return false;
        if ("opOwner" in record) return key === `native-operation:${record.opOwner}`;
        const threadKey = record.native.threadKey!;
        const reg = await rows.get<RunRegistration>(runRegKey(threadKey));
        const fence = await rows.get<WorkspaceOwner>(runFenceKey(threadKey));
        return (
          key.startsWith(`native-operation:${threadKey}:${record.runId}:`) &&
          registeredRunOwnsRelease(reg, record.runId, record.ownerGen, record.ownerFence) &&
          fence?.runId === record.runId &&
          fence.ownerGen === record.ownerGen &&
          fence.ownerFence === record.ownerFence
        );
      };
      const journal = new NativeOperationJournal(this.ctx.storage);
      const native = this.nativeScopeRecoveryTransport();
      const operator = await journal.recoverOperator(
        key,
        recordHash,
        native,
        async (record) =>
          "opOwner" in record &&
          key === `native-operation:${record.opOwner}` &&
          !this.activeOperatorRequests.has(record.opOwner) &&
          record.origin?.resource === (await this.ctx.storage.get(RESOURCE_KEY)),
        terminate,
      );
      if (operator !== undefined) return operator;
      const processes = new Map<
        string,
        NonNullable<Awaited<ReturnType<ReturnType<typeof createExtensionProcessSandbox>["getProcess"]>>>
      >();
      return new NativeOperationJournal(this.ctx.storage).recover(
        key,
        recordHash,
        async (identity) => {
          const process = await createExtensionProcessSandbox(this).getProcess(identity.id);
          if (process) processes.set(identity.id, process);
          return process ? process.status() : null;
        },
        ownerMatches,
        terminate
          ? async (identity) => {
              const process = processes.get(identity.id);
              if (!process) throw new Error("original process handle unavailable");
              await process.kill(9);
            }
          : undefined,
      );
    });
  }

  /** Retire one original ended scope without changing its history or workspace. */
  async retireNativeOperation(target: NativeRetirementTarget) {
    return this.runCancellations.run(target.scope.owner.runId, async () => {
      const ownerMatches = async (rows: NativeOperationRows, selected: NativeRetirementTarget) => {
        const { threadKey, owner } = selected.scope;
        if ((await rows.get(RESOURCE_KEY)) !== selected.resource) return false;
        const matches = (value: unknown) =>
          value === undefined || (isWorkspaceOwner(value) && workspaceOwnerKey(value) === workspaceOwnerKey(owner));
        const registration = await rows.get<RunRegistration>(runRegKey(threadKey));
        const fence = await rows.get<WorkspaceOwner>(runFenceKey(threadKey));
        const binding = await rows.get<ThreadBinding>(threadBindingKey(threadKey));
        return (
          matches(registration) &&
          (!registration || registration.threadKey === threadKey) &&
          matches(fence) &&
          (!binding ||
            (binding.threadKey === threadKey && binding.lastRunOwner !== undefined && matches(binding.lastRunOwner)))
        );
      };
      const result = await new NativeOperationJournal(this.ctx.storage).retireScope(
        target,
        { request: (value, timeout) => this.nativeScopeTransport().request(value, timeout) },
        ownerMatches,
        async () => {
          if (!this.env.STATE_WORKER_URL || !this.env.MEMORY_TOKEN) return;
          const storageRequest = await prepareStorageRequest("/runs/native-retirement/prepare", {
            storeKey: RUN_STORE_KEY,
            target,
          });
          return storageTransport(
            storageRequest,
            {
              url: new URL("/runs/native-retirement/prepare", this.env.STATE_WORKER_URL),
              headers: { authorization: `Bearer ${this.env.MEMORY_TOKEN}`, "content-type": "application/json" },
              signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
              timeoutMs: RUN_STORE_TIMEOUT_MS,
              exceptionDetails: false,
              fetch,
            },
            async (reply) => {
              if (!reply.ok) return;
              const body = (await reply.json()) as { kind?: unknown; permit?: unknown };
              const permit = nativeRetirementPermitSchema.safeParse(body.permit);
              if (
                body.kind === "prepared" &&
                permit.success &&
                nativeRetirementTargetKey(permit.data.target) === nativeRetirementTargetKey(target)
              )
                return permit.data;
            },
          );
        },
      );
      if ("error" in result)
        console.warn(
          JSON.stringify({
            event: "native.scope.retirement",
            runId: target.scope.owner.runId,
            scopeId: target.scope.id,
            phase: result.phase,
            cause: result.cause,
          }),
        );
      return result;
    });
  }

  async getResidentRecoveryProbe(): Promise<{ activeProcesses: number }> {
    if (!(await this.isRuntimeActive())) return { activeProcesses: 0 };
    const probe = await this.run(["ps", "-eo", "pid=,user="]);
    if (probe.exitCode !== 0 || probe.timedOut || probe.truncated || probe.stderr !== "")
      throw new Error("resident process probe failed");
    let activeProcesses = 0;
    for (const line of probe.stdout.split("\n").filter((line) => line.trim())) {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) throw new Error("resident process probe returned invalid data");
      const raw = match[2]!;
      if (!/^(?:[A-Za-z_][A-Za-z0-9_.+-]*\$?|\d+)$/.test(raw))
        throw new Error("resident process identity is unverified");
      const user = /^\d+$/.test(raw) && Number(raw) >= 2001 ? `worker${Number(raw) - 2000}` : raw;
      if (user === BUILD_USER || isResidentPoolUser(user)) activeProcesses++;
      else if (user.startsWith("worker")) throw new Error("resident process identity is unverified");
    }
    return { activeProcesses };
  }
  private attachesInFlight = 0;
  /** Entry-to-answer admissions include hydration before attachesInFlight starts. */
  private attachAdmissionsInFlight = 0;
  private opAdmissionsInFlight = 0;
  /** A refresh step in its entry gates is also unsafe to interrupt. */
  private refreshAdmissionsInFlight = 0;
  /** A refresh cycle past its idle/reconcile gates (fetching, rebuilding, snapshotting). */
  private refreshesInFlight = 0;

  /** The worktree inactivity sweep — every refresh instance's `sweep` step
   *  (item 23) and the `sweep-now` debug op. Removes worktrees whose binding
   *  is idle past the TTL, releases the user to the pool, and KEEPS the
   *  binding record marked evicted. Never wakes a slept container just to
   *  delete files a sleep already destroyed. */
  async sweepWorktrees(resource: string): Promise<{ evicted: string[]; kept: number }> {
    await this.reconcileWorkspaceSettlements();
    const evicted: string[] = [];
    let kept = 0;
    const record = await this.registry()
      .getRecord(resource)
      .catch(() => null);
    const ttlDays = record?.worktreeTtlDays ?? WORKTREE_TTL_DAYS_DEFAULT;
    const cutoff = systemClock() - ttlDays * 86_400_000;
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const idleCutoff = systemClock() - CLEAN_IDLE_RELEASE_S * 1000;
    const live = [...all]
      .filter(([, binding]) => !binding.evicted && binding.user)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const cursor = await this.ctx.storage.get<string>(WORKTREE_SWEEP_CURSOR_KEY);
    const remaining = cursor ? live.filter(([key]) => key > cursor) : live;
    const batch = (remaining.length > 0 ? remaining : live).slice(0, WORKTREE_SWEEP_BATCH_SIZE);
    for (const [key, binding] of batch) {
      try {
        const registration = await this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey));
        if (
          registration?.deadlineAt !== undefined &&
          Number.isSafeInteger(registration.deadlineAt) &&
          systemClock() <= registration.deadlineAt + RUN_REGISTRATION_GRACE_MS
        ) {
          kept++;
          continue;
        }
        const last = Date.parse(binding.lastAttachAt);
        if (last >= cutoff) {
          // Not past the TTL. Still release it if it has been idle for an hour
          // and nothing is running on it. The preservation decision below
          // still needs the exact owner and current tree evidence before removal.
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
        const activeNow = await this.isRuntimeActive().catch(() => true);
        // What the tree holds goes on the eviction's record (item 17), measured
        // while the runtime is up; a slept container has no tree to measure.
        const tree = activeNow ? await this.measureTreeBeforeEviction(current) : undefined;
        if (
          (await this.evictBinding(
            current,
            activeNow,
            `worktree-sweep ${resource}`,
            last >= cutoff ? "clean-idle" : "ttl",
            tree,
          )) === "evicted"
        )
          evicted.push(binding.threadKey);
        else kept++;
      } finally {
        await this.ctx.storage.put(WORKTREE_SWEEP_CURSOR_KEY, key);
      }
    }
    if (batch.at(-1)?.[0] === live.at(-1)?.[0]) await this.ctx.storage.delete(WORKTREE_SWEEP_CURSOR_KEY);
    return { evicted, kept };
  }

  // -- deterministic ops (/op — disposable per-op checkouts) -------------------

  /** Pool users transiently held by in-flight ops. DO memory only: an op is
   *  bounded by one request, and a DO restart kills the in-flight op anyway
   *  (its orphaned OPS_DIR entry dies with the container disk at the latest).
   *  Both this allocator and allocateThreadUser exclude the set, so an op
   *  never shares an OS user with a thread or another op. */
  private opUsersInUse = new Map<string, string>();

  /** The inspection reservation transfers to the op reservation synchronously. */
  private async allocateOpUser(): Promise<string | ThreadErr> {
    const scope = this.opOperationScope.getStore();
    if (!scope?.active) throw new Error("operator command has no active admission");
    const owner = scope.owner;
    const reserved = await this.reserveSafePoolUser(owner);
    if (typeof reserved !== "string") return reserved;
    scope.allocated = true;
    this.opUsersInUse.set(reserved, owner);
    this.poolUsersInspecting.delete(reserved);
    return reserved;
  }

  /** The existing native echo counter also protects anonymous operator work.
   * An unknown command outcome keeps its capacity marker across an isolate reset. */
  private readonly activeOperatorRequests = new Set<string>();

  private async withOpNativeOperation<T>(
    owner: string,
    fn: () => Promise<T>,
    producer: NativeOperationProducer,
    requestContext?: NativeRequestContext,
    originalPermit?: DeployAdmissionIdentity,
  ): Promise<T> {
    this.activeOperatorRequests.add(owner);
    try {
      const key = `native-operation:${owner}`;
      const origin = await this.operationOrigin(producer, owner, requestContext);
      const scope = { key, owner, origin, active: true, allocated: false };
      const journal = new NativeOperationJournal(this.ctx.storage);
      if (originalPermit) await journal.enrollOperatorAdmission(owner, origin, originalPermit);
      const native: NativeScopeTransport = {
        request: (value, timeout) => this.nativeScopeTransport().request(value, timeout),
      };
      const scopes = new NativeRunScopes(this.ctx.storage, native);
      let finalization;
      let finalizationFailure: { error: unknown } | undefined;
      try {
        finalization = await journal.resumeProducerFinalization(
          origin,
          this.nativeScopeRecoveryTransport(),
          async (record) => "opOwner" in record && !this.activeOperatorRequests.has(record.opOwner),
        );
        for (const saved of await journal.producerAdmissions(origin, (previous) => previous !== owner)) {
          if (this.activeOperatorRequests.has(saved.opOwner)) {
            finalization = { key: `native-operation:${saved.opOwner}`, opOwner: saved.opOwner, outcome: "held" };
            break;
          }
          // Missing callback proof cannot be recreated by another request.
          // Keep that permit held, without turning it into a new gate for every
          // refresh step. The original native journal still owns exclusion.
          if (!(await journal.operatorAdmissionReady(saved))) continue;
          await endTrackedDeployAdmission(this.registry(), saved.permit);
          await journal.completeOperatorAdmission(saved);
          finalization = { key: `native-operation:${saved.opOwner}`, opOwner: saved.opOwner, outcome: "ended" };
        }
      } catch (error) {
        emitDeployAdmission(
          { phase: "operator-ending", stage: "resume", id: owner, commit: "unverified", failure: "storage-or-rpc" },
          { error },
        );
        finalizationFailure = { error };
      }
      // A cleanup-only request still needs its own ending receipt before its
      // caller can release the request's deployment permit.
      const admission = await journal.open(key, { opOwner: owner }, undefined, origin);
      await scopes.reserveOperator({ opOwner: owner });
      let callback: "returned" | "threw" = "threw";
      try {
        if (finalizationFailure)
          throw new StepError(
            "producer-cleanup-pending",
            "background producer cleanup remains pending",
            finalizationFailure.error,
          );
        if (finalization) {
          emitDeployAdmission({
            phase: "operator-ending",
            stage: "resume",
            id: finalization.opOwner,
            commit: finalization.outcome === "ended" ? "confirmed" : "unverified",
            callback: "unknown",
            originalOperationOutcome: "unknown",
          });
          throw new StepError(
            finalization.outcome === "ended" ? "producer-cleanup-completed" : "producer-cleanup-pending",
            finalization.outcome === "ended"
              ? "background producer cleanup completed without repeating its operation"
              : "background producer has an original active or unknown operation",
          );
        }
        if (admission === "producer-held") {
          const held = new Error("producer-held: an earlier operation is still active or its result is unknown");
          held.name = "BackgroundOperationHeldError";
          throw held;
        }
        const result = await this.opOperationScope.run(scope, fn);
        callback = "returned";
        return result;
      } finally {
        scope.active = false;
        let stage: "journal-close" | "scope-close" | "ending-write" = "journal-close";
        try {
          await journal.close(key);
          stage = "scope-close";
          await scopes.closeOperator({ opOwner: owner });
          stage = "ending-write";
          if (!(await journal.endOperator(key, { opOwner: owner }, callback)))
            emitDeployAdmission({
              phase: "operator-ending",
              id: owner,
              stage,
              commit: "unverified",
              failure: "opaque-or-scope-held",
              callback,
            });
        } catch (error) {
          emitDeployAdmission(
            { phase: "operator-ending", id: owner, stage, commit: "unverified", failure: "storage-or-rpc", callback },
            { error },
          );
        }
      }
    } finally {
      this.activeOperatorRequests.delete(owner);
    }
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
  async runOp(
    op: "test" | "build",
    refArg: string | null,
    traceparent?: string,
    requestContext?: NativeRequestContext,
  ): Promise<OpRunOk | ThreadErr> {
    // One step trace per op (docs/reference/specs/tracing.md item 19), like an attach.
    const t0 = systemClock();
    const trace = createStepTrace(t0);
    let res: OpRunOk | ThreadErr;
    try {
      if (this.recreateAdmission.pending) {
        res = this.recreateRefusal();
      } else {
        this.opAdmissionsInFlight++;
        try {
          const owner = `op:${crypto.randomUUID()}`;
          const workload = await this.reserveWorkloadSlot(owner);
          if (workload) res = workload;
          else {
            try {
              res = await this.withDeployAdmission(
                op === "test" ? "op-test" : "op-build",
                requestContext,
                () =>
                  this.withOpNativeOperation(
                    owner,
                    () => this.stepTrace.run(trace, () => this.runOpTraced(op, refArg, t0)),
                    op === "test" ? "op-test" : "op-build",
                    requestContext,
                  ),
                owner,
              );
            } finally {
              this.workloadReservations.delete(owner);
            }
          }
        } finally {
          this.opAdmissionsInFlight--;
        }
      }
    } catch (error) {
      emitStepRoot("resident.op", t0, trace.steps(), traceparent, "error", { command: op });
      throw error;
    }
    emitStepRoot("resident.op", t0, trace.steps(), traceparent, "error" in res ? refusalOutcome(res) : "ok", {
      command: op,
    });
    return "error" in res ? { ...res, trace: trace.steps() } : res;
  }

  private async runOpTraced(op: "test" | "build", refArg: string | null, t0: number): Promise<OpRunOk | ThreadErr> {
    return (async (): Promise<OpRunOk | ThreadErr> => {
      if (await this.recreateAdmission.blocked()) return this.recreateRefusal();
      // The fleet drain (item 69; issue 2044): a typed op is a new piece of work
      // like a new run's attach, and during the incident one waited silently at
      // the drain — so it is answered with the drain's own record at once, a
      // deterministic refusal the command surfaces as its reason, never a wait.
      const drain = await this.fleetDrain();
      if (drain !== null) {
        return {
          error: `op-refused: the resident fleet is drained for ${drain.reason} (asked by ${drain.by}, ends by ${drain.until}) — re-run the command when the fleet reopens`,
          status: 503,
          reason: "draining",
          cause: "system",
        };
      }
      try {
        await this.ensureHydrated();
      } catch (err) {
        const s = await this.getStatus();
        return {
          error: `not-serviceable: ${errMsg(err)}`,
          status: 503,
          state: s.state,
          stateReason: s.reason,
          reason: s.reason,
          cause: "system",
        };
      }
      if (await this.recreateAdmission.blocked()) return this.recreateRefusal();
      // One storage round trip for the two facts; the registry lookup stays (an
      // op resolves ONLY through the onboard-time command table).
      const stored = await this.ctx.storage.get<string | RepoFacts>([RESOURCE_KEY, FACTS_KEY]);
      const resource = (stored.get(RESOURCE_KEY) as string | undefined) ?? "";
      const facts = stored.get(FACTS_KEY) as RepoFacts | undefined;
      const record = await this.registry().getRecord(resource);
      // Typed `reason` beside the words: the client reads the field — a refusal no
      // wait clears, unlike the restore window's 503s — never the sentence.
      if (!record || !facts)
        return {
          error: "not-serviceable: registry record or repo facts missing",
          status: 503,
          reason: "unregistered",
          cause: "system",
        };
      const command = record.commands[op];
      if (!command) return { error: `op-unavailable: the command table has no "${op}" entry`, status: 400 };

      const user = await this.allocateOpUser();
      if (typeof user !== "string") return user;
      const opDir = `${OPS_DIR}/${crypto.randomUUID()}`;
      const checkout = `${opDir}/checkout`;
      try {
        // Command-level token mint, attach's discipline: only a mirror
        // fetch for an unknown ref would use it; failure never blocks the op.
        let token: string | null = null;
        if (githubAppConfigured(this.env)) {
          token =
            (await mintRepoScopedToken(this.env, resource.slice("repo:".length)).catch(() => null))?.token ?? null;
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
        const truncated =
          r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP || r.truncated === true;
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
          return {
            error: errMsg(err),
            status: 503,
            state: s.state,
            stateReason: s.reason,
            reason: "mirror-busy",
            cause: "system",
          };
        }
        if (err instanceof StepError && err.step === "unknown-ref") {
          return { error: `unknown-ref: ${err.message}`, status: 400, cause: "request" };
        }
        // A step that failed is named and deterministic; a throw no step named is
        // typed by the one builder every such 500 goes through.
        if (err instanceof StepError) return { error: `op-failed at ${err.step}: ${errMsg(err)}`, status: 500 };
        return catchAllErr(err, "op-failed");
      } finally {
        // Disposable means disposable: the checkout dies with the op, pass or
        // fail (best effort — a slept container already destroyed it anyway).
        await this.run(["rm", "-rf", opDir]).catch(() => {});
        this.opUsersInUse.delete(user);
      }
    })();
  }

  /** Debug: enumerate thread bindings (read scope). No secrets live in a
   *  binding; worktreePath is omitted like getResidentInfo does — internal
   *  disk layout is not part of the lower-trust read surface. */
  async debugThreads(selection?: { threadKey: string; runId: string }) {
    if (selection) {
      const { threadKey, runId } = selection;
      const cancellationKey = `cancelled:${threadKey}:${runId}`;
      const rows = await this.ctx.storage.get<unknown>([
        RESOURCE_KEY,
        cancellationKey,
        threadBindingKey(threadKey),
        runRegKey(threadKey),
        runFenceKey(threadKey),
      ]);
      const object = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      const text = (value: unknown, limit: number): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= limit;
      const saved = object(rows.get(cancellationKey));
      const parsed = cancellationOf(saved?.cancellation);
      const ticket =
        parsed?.runId === runId && parsed.threadKey === threadKey && rows.get(RESOURCE_KEY) === `repo:${parsed.repo}`
          ? parsed
          : undefined;
      const rawTarget = object(saved?.target);
      const target =
        ticket &&
        rawTarget &&
        text(rawTarget.ref, 512) &&
        text(rawTarget.user, 128) &&
        isResidentPoolUser(rawTarget.user) &&
        text(rawTarget.container, 128) &&
        text(rawTarget.workspace, 4096) &&
        rawTarget.workspace.startsWith("/workspace/threads/") &&
        isWorkspaceOwner({ runId, ownerGen: rawTarget.ownerGen, ownerFence: rawTarget.ownerFence })
          ? {
              ref: rawTarget.ref,
              user: rawTarget.user,
              container: rawTarget.container,
              ownerGen: rawTarget.ownerGen as string,
              ownerFence: rawTarget.ownerFence as number,
            }
          : null;
      const rawBinding = object(rows.get(threadBindingKey(threadKey)));
      const binding =
        rawBinding &&
        rawBinding.threadKey === threadKey &&
        text(rawBinding.ref, 512) &&
        text(rawBinding.user, 128) &&
        isResidentPoolUser(rawBinding.user) &&
        text(rawBinding.container, 128)
          ? { ref: rawBinding.ref, user: rawBinding.user, container: rawBinding.container }
          : null;
      const owner = (value: unknown) =>
        isWorkspaceOwner(value) ? { runId: value.runId, ownerGen: value.ownerGen, ownerFence: value.ownerFence } : null;
      const registration = owner(rows.get(runRegKey(threadKey)));
      const fence = owner(rows.get(runFenceKey(threadKey)));
      const matchesOwner = (current: typeof registration) =>
        !target || !current
          ? null
          : current.runId === runId && current.ownerGen === target.ownerGen && current.ownerFence === target.ownerFence;
      const matches = {
        binding:
          !target || !binding
            ? null
            : rawBinding?.evicted !== true &&
              binding.ref === target.ref &&
              binding.user === target.user &&
              binding.container === target.container &&
              rawBinding?.worktreePath === rawTarget?.workspace,
        registration: matchesOwner(registration),
        fence: matchesOwner(fence),
      };
      const disposition =
        saved?.disposition === "processes-stopped" || saved?.disposition === "runtime-retired"
          ? saved.disposition
          : null;
      const receipt = ticket
        ? {
            stopped: saved?.stopped === true ? true : saved?.stopped === false ? false : null,
            disposition,
            refusal: cancellationRefusalOf(saved?.failure) ?? null,
            observation: cancellationObservationOf(saved?.observation) ?? null,
          }
        : null;
      // This is stored custody, not a current kernel or process observation.
      // No report read repairs a missing row or acknowledges a shutdown.
      const state =
        rows.get(cancellationKey) === undefined
          ? ("absent" as const)
          : ticket &&
              target &&
              Object.values(matches).every((value) => value === true) &&
              (saved?.failure === undefined || receipt?.refusal !== null) &&
              (saved?.observation === undefined || receipt?.observation !== null) &&
              (saved?.disposition === undefined || disposition !== null) &&
              (saved?.stopped === undefined ||
                saved.stopped === false ||
                (saved.stopped === true && disposition !== null))
            ? ("recorded" as const)
            : ("unverified" as const);
      return {
        cancellation: {
          runId,
          threadKey,
          evidence: "stored-only" as const,
          state,
          ticket: ticket ? { id: ticket.id, ownerGen: ticket.ownerGen, startedAt: ticket.startedAt } : null,
          target,
          binding,
          registration,
          fence,
          matches,
          receipt,
        },
      };
    }
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
    const purged: string[] = [];
    const keptLive = [...decision.keptLive];
    for (const threadKey of decision.purge) {
      if (await this.deleteThreadBinding(threadKey, true)) purged.push(threadKey);
      else keptLive.push(threadKey);
    }
    return { purged, keptLive };
  }

  /** Debug fault injection: age a binding so the sweep's TTL path can be
   *  exercised without waiting N days. */
  async debugBackdateThread(threadKey: string, days: number): Promise<{ ok: boolean; lastAttachAt?: string }> {
    return this.threadAttaches.run(threadKey, () =>
      this.ctx.storage.transaction(async (txn) => {
        const binding = await txn.get<ThreadBinding>(threadBindingKey(threadKey));
        if (!binding || (await txn.get(`discarding:${threadKey}`))) return { ok: false };
        const lastAttachAt = new Date(systemClock() - days * 86_400_000).toISOString();
        // Admin authority changes only the current row's activity clock. Never
        // replay a cached binding through the ordinary owner/placement fence.
        await txn.put(threadBindingKey(threadKey), { ...binding, lastAttachAt } satisfies ThreadBinding);
        return { ok: true, lastAttachAt };
      }),
    );
  }

  /** Debug: run the sweep pass now (the exact function the `sweep` step runs). */
  async debugSweepNow(): Promise<{ evicted: string[]; kept: number } | ThreadErr> {
    return this.withRecreateSafeAdmin(async () =>
      this.sweepWorktrees((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? ""),
    );
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
    // The runs registered on this resident (item 44): a live registration
    // holds its tree through the deadline, and its process lives in the container
    // between the bot's calls — the op counters read 0 while its model thinks.
    const registrations = new Map(
      [...(await this.ctx.storage.list<RunRegistration>({ prefix: RUN_REG_KEY_PREFIX })).values()].map((r) => [
        r.threadKey,
        r,
      ]),
    );
    const protectsTree = (binding: ThreadBinding, registration: RunRegistration | undefined): boolean => {
      if (!registration) return false;
      const now = systemClock();
      return registeredRunNeedsProtection(
        binding.lastAttachAt,
        0,
        now - CLEAN_IDLE_RELEASE_S * 1000,
        registration.deadlineAt === undefined ? undefined : registration.deadlineAt + RUN_REGISTRATION_GRACE_MS,
        now,
      );
    };
    const registered = new Set(
      live
        .filter((binding) => protectsTree(binding, registrations.get(binding.threadKey)))
        .map((binding) => binding.threadKey),
    );
    for (const binding of live) {
      const isDefaultRef = binding.ref === defaultRef;
      // The default branch is never a finished ref (reclaimDecision keeps it
      // by name), so its fate is never looked up.
      const { fate, detail } = (!isDefaultRef && fates.get(binding.ref)) || { fate: "unknown" as RefFate, detail: "" };
      const busy = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
      const held = registered.has(binding.threadKey);
      const decision = reclaimDecision({ fate, isDefaultRef, busy, held });
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
      // A run attached while the tree was measured holds it now (item 44).
      const currentRegistration = await this.ctx.storage.get<RunRegistration>(runRegKey(binding.threadKey));
      if (protectsTree(current ?? binding, currentRegistration)) {
        kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: "run-held" });
        continue;
      }
      if (!current || current.evicted || current.lastAttachAt !== binding.lastAttachAt) {
        kept.push({ threadKey: binding.threadKey, ref: binding.ref, why: "re-attached" });
        continue;
      }
      const activeNow = await this.isRuntimeActive().catch(() => true);
      const why = `${decision.why}${detail}`;
      const eviction = await this.evictBinding(current, activeNow, `reclaim ${resource}`, why, tree);
      if (eviction === "evicted") {
        reclaimed.push({ threadKey: binding.threadKey, ref: binding.ref, why });
        console.log(`reclaim ${resource}: evicted ${binding.threadKey} on ${binding.ref} — ${why}`);
      } else
        kept.push({
          threadKey: binding.threadKey,
          ref: binding.ref,
          why:
            eviction === "changed" ? "re-attached" : eviction === "preserved" ? "preservation-held" : "cleanup-failed",
        });
    }
    return { reclaimed, kept };
  }

  /** Debug: measure the disk now (admin) — the exact cycle/attach function. */
  async debugMeasureDisk(): Promise<DiskSample | null | ThreadErr> {
    return this.withRecreateSafeAdmin(() => this.measureDisk());
  }

  /** Debug: run the reclamation pass now (the exact refresh-cycle function,
   *  with a fresh mint when the App is configured). Runs a `fetch --prune`
   *  first so a branch deleted seconds ago already reads as gone. */
  async debugReclaimNow(): Promise<{ reclaimed: unknown[]; kept: unknown[]; fetch: string } | ThreadErr> {
    return this.withRecreateSafeAdmin(() => this.debugReclaimNowBody());
  }

  private async debugReclaimNowBody(): Promise<{ reclaimed: unknown[]; kept: unknown[]; fetch: string }> {
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
    const map = await this.ctx.storage.get<string | boolean>([
      STATE_KEY,
      REASON_KEY,
      DESTROY_UNCONFIRMED_KEY,
      CLEANUP_PENDING_KEY,
    ]);
    if (map.has(CLEANUP_PENDING_KEY))
      return { state: "down", reason: "full-rebuild-cleanup-incomplete: cleanup is still pending" };
    if (this.destroying || map.get(DESTROY_UNCONFIRMED_KEY)) {
      return { state: "down", reason: "resident-destroy-unconfirmed: container reuse refused" };
    }
    const state = map.get(STATE_KEY) as ResidentState | undefined;
    if (!state) {
      return { state: "down", reason: "no resident state persisted (never onboarded, or already offboarded)" };
    }
    return { state, reason: (map.get(REASON_KEY) as string | undefined) ?? "" };
  }

  /** Full admin-facing view (surfaced via GET /residents and /debug info):
   *  lifecycle + recorded sha/cache keys/snapshot stamp/refresh telemetry.
   *  Backup handles are reduced to ids — never the raw handle internals. */
  /** The stamped snapshot as a handle (docs/reference/specs/resident-repos.md
   *  item 7): the stamp, both archive ids, and the deps-store entry archive for
   *  the snapshot's own lockfile key when one has been taken (item 61). What
   *  `/status` publishes for the seed (execution.md item 25 — a seeded sandbox
   *  restores the checkout and the deps view from it) and what `/debug info`
   *  shows; null before the first snapshot. */
  async snapshotHandle(snap?: SnapshotRecord): Promise<SnapshotHandle | null> {
    const record = snap ?? (await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY));
    if (!record) return null;
    return {
      ref: record.ref,
      sha: record.sha,
      lockfileHash: record.lockfileHash,
      createdAt: record.createdAt,
      mirrorBackupId: record.mirror.id,
      checkoutBackupId: record.checkout.id,
      depsBackupId: (await this.depsBackupRecord(record.lockfileHash))?.backup.id ?? null,
    };
  }

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
      AUTO_REBUILDS_KEY,
      INFRA_STREAK_KEY,
      MEMORY_KEY,
      IMAGE_REPORT_PENDING_KEY,
      IMAGE_RECONCILE_KEY,
      DESTROY_UNCONFIRMED_KEY,
      CLEANUP_PENDING_KEY,
      RECREATE_ADMISSION_KEY,
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
          preservationBlocked,
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
          preservationBlocked: preservationBlocked ?? null,
        }),
      );
    // The runs whose process lives in the container between operator calls
    // (item 44): what the deploy preflight must see, added to both counts.
    const registeredRuns = await this.registeredRunsBeyondOps();
    const uidReport = await this.ctx.storage.transaction((txn) => readUidReport(txn)).catch(() => null);
    return {
      resource: map.get(RESOURCE_KEY) ?? null,
      state:
        this.destroying || map.get(DESTROY_UNCONFIRMED_KEY) || map.has(CLEANUP_PENDING_KEY)
          ? "down"
          : (map.get(STATE_KEY) ?? "down"),
      cleanupPending: map.get(CLEANUP_PENDING_KEY) ?? null,
      reason:
        this.destroying || map.get(DESTROY_UNCONFIRMED_KEY)
          ? "resident-destroy-unconfirmed: container reuse refused"
          : map.has(CLEANUP_PENDING_KEY)
            ? "full-rebuild-cleanup-incomplete: cleanup is still pending"
            : (map.get(REASON_KEY) ?? ""),
      updatedAt: map.get(UPDATED_KEY) ?? null,
      defaultRef: facts?.defaultRef ?? null,
      sha: facts?.sha ?? null,
      lockfileHash: facts?.lockfileHash ?? null,
      provisionedAt: facts?.provisionedAt ?? null,
      lastRefreshAt: facts?.lastRefreshAt ?? null,
      lastRefreshError: facts?.lastRefreshError ?? null,
      lastRestore: facts?.lastRestore ?? null,
      idleSince: facts?.idleSince ?? null,
      snapshot: await this.snapshotHandle(snap),
      // The provisioning schedules, the one timer a resident has (item 3).
      schedules: {
        provisionRun: provisionRun.length,
        provisionDeadline: provisionDeadline.length,
      },
      inFlight: this.inFlightCount() + registeredRuns,
      // The runs alone (no refresh cycle): what the deploy preflight refuses on.
      runsInFlight: this.runsInFlightCount() + registeredRuns,
      // Issue 2044: whether this container's new-image report is still owed —
      // `pending` names a resident a held drain waits on, so `repo list` and
      // the deploy's readers never print a bare "warm" for a repository whose
      // running container the last deploy could not verify.
      imageReport: map.get(IMAGE_REPORT_PENDING_KEY) !== undefined ? "pending" : "current",
      imageTarget:
        (map.get(IMAGE_RECONCILE_KEY) as DeployImageReconcileState | undefined)?.build === BUILD_ID
          ? ((map.get(IMAGE_RECONCILE_KEY) as DeployImageReconcileState).target ?? null)
          : null,
      recreateAdmissionHeld: this.recreateAdmission.pending || map.get(RECREATE_ADMISSION_KEY) === true,
      poolUsersSpent: uidReport?.issued ?? null,
      poolUsersTotal: null,
      uidAllocation: "dynamic",
      workloadLimit: RESIDENT_WORKLOAD_LIMIT,
      // Read-scoped owner receipts explain historical occupancy even after
      // every live binding and disposable op has ended.
      poolUserSpends: uidReport?.preview ?? null,
      poolUserSpendsComplete: uidReport !== null && uidReport.preview.length === uidReport.issued,
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
      deploymentAdmissionRecovery: await new NativeOperationJournal(this.ctx.storage).admissionRecovery(
        (owner) => !this.activeOperatorRequests.has(owner),
      ),
      threads,
      // Item 55: the last disk sample (`residentDiskBudget.ts` DiskSample), or
      // null before the first measurement of this incarnation.
      disk,
      // Item 70: the last memory reading (used/cap bytes, percent), or null
      // before the first sample of this incarnation reaches storage.
      memory: (map.get(MEMORY_KEY) as MemoryReading | undefined) ?? null,
      // Item 64: consecutive connects the control port did not answer, with
      // the rung that count is on; null while the port answers.
      runtimeUnreachable: unreachable ? { ...unreachable, rung: runtimeUnreachableRung(unreachable.count) } : null,
      // Item 36: the auto-rebuilds this resident has had (ISO instants; the
      // budget's window is judged over them). Empty after a person's rebuild.
      autoRebuilds: (map.get(AUTO_REBUILDS_KEY) as string[] | undefined) ?? [],
      // Item 67: consecutive cycles failed in the resident's own steps, with
      // the rung that count is on; null while cycles complete.
      infraStreak: (() => {
        const row = map.get(INFRA_STREAK_KEY) as InfraStreakRow | undefined;
        return row ? { ...row, rung: infraStreakRung(row.count) } : null;
      })(),
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
   *  and on a `down` resident unless a prior destroy left its durable
   *  uncertainty fence. The checked retry then confirms destruction before
   *  the existing snapshot restore. Other `down` residents use `/rebuild`.
   *  The restore runs in the background through the ordinary wake path (`ensureHydrated`:
   *  `restoring`, mirror, checkout, deps, `warm`, `lastRestore`); the caller
   *  polls `/debug info`. A failure the wake path did not record itself is
   *  recorded here, so the marker never strands `restoring`. */
  async debugRecreateContainer(): Promise<
    { recreated: true; restoreStartedAt: string } | { recreated: false; error: string; status: number }
  > {
    const admission = await this.recreateAdmission.run(() => this.debugRecreateContainerChecked());
    return admission.busy
      ? { recreated: false, status: 409, error: "recreate-refused: a VM recycle is already checking idleness" }
      : admission.value;
  }

  private async debugRecreateContainerChecked(): Promise<
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
    const destroyFenceStored = (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) === true;
    const cleanupPending = (await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== undefined;
    const retryUnconfirmedDestroy = from.state === "down" && destroyFenceStored && !cleanupPending;
    if (from.state === "down" && !retryUnconfirmedDestroy) {
      if (destroyFenceStored && cleanupPending)
        console.warn(
          `[resident-recreate-refused] ${JSON.stringify({ schema: 1, destroyFenceStored, cleanupPending })}`,
        );
      return {
        recreated: false,
        status: 409,
        error: `recreate-refused: the resident is down (${from.reason}) — POST /rebuild is its exit`,
      };
    }
    const active =
      this.inFlightCount() +
      this.refreshAdmissionsInFlight +
      this.adminWorkInFlight +
      (this.hydration ? 1 : 0) +
      (await this.registeredRunsBeyondOps());
    if (active > 0) {
      return { recreated: false, status: 409, error: `recreate-refused: ${active} run(s) still in flight` };
    }
    await this.recreateContainer(
      retryUnconfirmedDestroy
        ? "resident-destroy-unconfirmed: the operator retried destruction and confirmed it; snapshots kept — the restore is starting"
        : "runtime-unreachable: the container was recreated by an operator (recreate-container), snapshots kept — the restore from the snapshot is starting",
      false,
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

  /** Fault injection for item 67: write the resident-step streak row at `count`
   *  (0 deletes it), so the next real failure lands on the rung under test.
   *  Test-only semantics; admin scope. */
  async debugSetInfraStreak(count: number): Promise<{ infraStreak: (InfraStreakRow & { rung: string }) | null }> {
    if (count === 0) {
      await this.ctx.storage.delete(INFRA_STREAK_KEY);
      return { infraStreak: null };
    }
    const now = new Date(systemClock()).toISOString();
    const row: InfraStreakRow = { step: "injected", count, firstAt: now, lastAt: now };
    await this.ctx.storage.put(INFRA_STREAK_KEY, row);
    return { infraStreak: { ...row, rung: infraStreakRung(count) } };
  }

  /** Fault injection for item 67: corrupt the mirror on disk so the next
   *  cycle's `fetch` fails in a resident step. The mirror's `config` goes (its
   *  `origin` remote with it: `'origin' does not appear to be a git
   *  repository`, exit 128) — NOT its objects: the wake check (`readyStamp`)
   *  tests `objects/`, and a missing directory is a disk to restore, which the
   *  wake did before any step could fail the first time this was tried live.
   *  The snapshots in R2 are untouched — the ladder's recreate restores them.
   *  Test-only semantics; admin scope. */
  async debugBreakMirror(): Promise<{ broken: boolean; error?: string }> {
    try {
      await this.runOk(["rm", "-f", `${MIRROR_DIR}/config`], "break-mirror");
      return { broken: true };
    } catch (err) {
      return { broken: false, error: errMsg(err) };
    }
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
    return this.withRecreateSafeAdmin(async () => {
      const from = await this.getStatus();
      if ((await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== undefined)
        return { error: "rebuild-refused: full rebuild cleanup is still incomplete", status: 409 };
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

      // A failed destroy must leave the old snapshot and budget intact, and
      // must never arm provisioning against an unconfirmed old VM.
      const destroy = async () => {
        this.swapIncarnation();
        await this.destroyConfirmed();
      };
      if (opts.auto) {
        if (!(await this.automaticContainerLoss("auto-rebuild", destroy)))
          return { error: "workspace-preservation: automatic rebuild deferred", status: 503 };
      } else await destroy();

      // Old snapshot objects go before initResident wipes the stored handles,
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
      // Provisioning starts only after confirmed destruction.
      await this.initResident(resource, provisioningTimeoutMs, true);
      return { ...plan, backupObjectsDeleted, state: "onboarding" as const };
    });
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
    const depsIds = (await this.allDepsBackups()).map((record) => record.backup.id);
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return {
      ...status,
      schedules: prov.length + run.length,
      snapshotBackupIds: ids,
      backupObjects: await this.countBackupObjects([...new Set([...ids, ...depsIds])]),
      threadBindings: bindings.size,
    };
  }

  /** Explicit full reset keeps the registry settings, but discards every
   * resident fact after confirmed destruction. A retained operation's result
   * remains unknown; resetting the runtime is not its completion receipt. */
  async reset(
    resource: string,
    defaultRef: string,
    provisioningTimeoutMs: number,
    dryRun: boolean,
    discardUnknownNative?: NativeDiscardSelection,
  ) {
    const discardTargets = discardUnknownNative
      ? Array.isArray(discardUnknownNative)
        ? discardUnknownNative
        : [discardUnknownNative]
      : [];
    if (discardTargets.length && !dryRun) {
      const audits = await Promise.all(
        discardTargets.map((target) =>
          this.ctx.storage.get<{ state?: unknown }>(`${NATIVE_EMERGENCY_DISCARD_PREFIX}${target.recordHash}`),
        ),
      );
      if (
        audits.every((audit) => audit?.state === "runtime-destroyed") &&
        (await Promise.all(discardTargets.map((target) => this.ctx.storage.get(target.key)))).every(
          (record) => record === undefined,
        ) &&
        !(await this.ctx.storage.get(CLEANUP_PENDING_KEY))
      )
        return { status: 409, error: "reset-refused: exact native disposal already completed; nothing repeated" };
    }
    const residentId = await this.residentIdentity();
    const unknownNative = dryRun ? await new NativeOperationJournal(this.ctx.storage).unresolved() : new Map();
    const nativeHashes = unknownNative.size
      ? await new NativeOperationJournal(this.ctx.storage).fingerprints(NATIVE_OPERATION_PREFIX)
      : {};
    const plan = {
      resource,
      dryRun,
      wouldRemove: {
        ...(await this.teardownPlan()),
        r2Objects: await countR2Prefix(this.env.BACKUP_BUCKET, r2Prefix(residentId)),
        ...(unknownNative.size
          ? {
              unverifiedNativeOperations: [...unknownNative.keys()].map((key) => ({
                key,
                recordHash: nativeHashes[key],
              })),
            }
          : {}),
      },
      keeps: { registryRecord: true as const },
      reprovision: { defaultRef, provisioningTimeoutMs },
      originalOperationOutcome: "unknown" as const,
    };
    if (dryRun) return plan;
    const admission = await this.recreateAdmission.run(async () => {
      const from = await this.getStatus();
      if (["onboarding", "refreshing", "restoring"].includes(from.state))
        return { status: 409, error: `reset-refused: the engine is mid-flight (state ${from.state})` };
      const active =
        this.inFlightCount() + this.refreshAdmissionsInFlight + this.adminWorkInFlight + (this.hydration ? 1 : 0);
      if (active > 0) return { status: 409, error: `reset-refused: ${active} request(s) still in flight` };
      if (
        discardTargets.length &&
        (await this.registeredRunsBeyondOps(new Set(discardTargets.map((target) => target.key)))) > 0
      )
        return { status: 409, error: "reset-refused: another original run or operation remains active" };
      const removed = await this.teardown(discardUnknownNative);
      if (removed.errors.length > 0)
        return { ...removed, status: 503, error: `reset-incomplete: ${removed.errors.join("; ")}` };
      try {
        const r2ObjectsDeleted = await deleteR2Prefix(this.env.BACKUP_BUCKET, r2Prefix(residentId));
        await this.confirmCleanup(resource);
        await this.initResident(resource, provisioningTimeoutMs, false, residentId);
        return { ...plan, ...removed, r2ObjectsDeleted, state: "onboarding" as const };
      } catch (err) {
        await this.setResidentState("down", `full-rebuild-cleanup-incomplete: ${errMsg(err)}`);
        return { ...plan, ...removed, status: 503, error: `reset-incomplete: ${errMsg(err)}` };
      }
    });
    return admission.busy
      ? { status: 409, error: "reset-refused: another VM recycle is in progress" }
      : admission.value;
  }

  /** Offboard teardown: confirm container destruction before deleting timers
   *  or state. Then delete the R2 objects behind the SDK backup handles,
   *  which live outside the resident prefix and must be removed before the
   *  handles in DO storage. The Worker deletes resident-prefix objects. */
  async teardown(discardUnknownNative?: NativeDiscardSelection): Promise<{
    schedulesCancelled: boolean;
    containerStopped: boolean;
    storageCleared: boolean;
    backupObjectsDeleted: number;
    discardedUnknownNative?: NativeDiscardTarget;
    discardedUnknownNatives?: NativeDiscardTarget[];
    errors: string[];
  }> {
    const errors: string[] = [];
    let backupObjectsDeleted = 0;
    const resource =
      (await this.ctx.storage.get<string>(CLEANUP_PENDING_KEY)) ?? (await this.ctx.storage.get<string>(RESOURCE_KEY));
    if (typeof resource !== "string") throw new Error("resident-cleanup-target-unavailable");
    const journal = new NativeOperationJournal(this.ctx.storage);
    const unresolved = await journal.unresolved();
    const targets = discardUnknownNative
      ? Array.isArray(discardUnknownNative)
        ? discardUnknownNative
        : [discardUnknownNative]
      : [];
    const selectedKeys = new Set(targets.map((target) => target.key));
    const audits = await Promise.all(
      targets.map(async (target) => ({
        target,
        key: `${NATIVE_EMERGENCY_DISCARD_PREFIX}${target.recordHash}`,
        old: await this.ctx.storage.get<{
          resource: string;
          key: string;
          recordHash: string;
          unknownEffect?: { originBuild: string };
          original: unknown;
          originalOperationOutcome: string;
          state: string;
        }>(`${NATIVE_EMERGENCY_DISCARD_PREFIX}${target.recordHash}`),
      })),
    );
    const resumeWithoutRecord =
      targets.length > 0 && unresolved.size === 0 && audits.every(({ old }) => old?.state === "runtime-destroyed");
    if (targets.length) {
      const hashes = await journal.fingerprints(NATIVE_OPERATION_PREFIX);
      const eligible = (
        await Promise.all(
          targets.map(async (target) => {
            const parsed = nativeOperationRecordSchema.safeParse(unresolved.get(target.key));
            if (!parsed.success || !("opOwner" in parsed.data)) return false;
            const record = parsed.data;
            const pending = Object.values(record.native.pending);
            // The journal cannot name the opaque effect. The operator must select
            // its original build explicitly and keep its result unknown.
            const unknownFetch =
              targets.length >= 2 &&
              !!target.unknownEffect &&
              target.unknownEffect.originBuild === record.origin?.build &&
              target.key === `native-operation:${record.opOwner}` &&
              !!record.native.scope &&
              nativeOperatorScopeClosing(
                await this.ctx.storage.get(nativeOperatorScopeKey({ opOwner: record.opOwner })),
                { opOwner: record.opOwner },
                record.native.scope,
              ) &&
              record.origin?.producer === "refresh-step" &&
              record.origin.resource === resource &&
              record.origin.sourceId === "fetch" &&
              record.origin.actor === "system" &&
              pending.length === 1 &&
              pending[0].kind === "opaque" &&
              !pending[0].process &&
              !pending[0].restore;
            return (
              record.native.closed === true &&
              !!record.native.scope &&
              (unknownFetch ||
                (!target.unknownEffect &&
                  pending.some((attempt) => attempt.restore) &&
                  !pending.some((attempt) => !attempt.restore)))
            );
          }),
        )
      ).every(Boolean);
      const hashMatch = targets.every((target) => hashes[target.key] === target.recordHash);
      if (
        !resumeWithoutRecord &&
        (unresolved.size !== targets.length ||
          selectedKeys.size !== targets.length ||
          new Set(targets.map((target) => target.recordHash)).size !== targets.length ||
          !eligible ||
          !hashMatch)
      )
        throw new Error(
          `resident-cleanup-refused: exact closed native operation changed or another hold remains (holds=${unresolved.size}, eligible=${eligible}, hashMatch=${hashMatch})`,
        );
    }
    for (const [key, value] of unresolved) {
      if (selectedKeys.has(key)) continue;
      const parsed = nativeOperationRecordSchema.safeParse(value);
      if (
        !parsed.success ||
        Object.values(parsed.data.native.pending).some((attempt) => attempt.restore) ||
        ("opOwner" in parsed.data && Object.keys(parsed.data.native.restoreReceipts ?? {}).length > 0)
      )
        throw new Error("resident-cleanup-refused: original archive restore is unresolved");
    }
    if (
      audits.some(
        ({ target, old }) =>
          old &&
          (old.resource !== resource ||
            old.key !== target.key ||
            old.recordHash !== target.recordHash ||
            JSON.stringify(old.unknownEffect ?? null) !== JSON.stringify(target.unknownEffect ?? null) ||
            old.original === undefined ||
            old.originalOperationOutcome !== "unknown" ||
            !["prepared", "runtime-destroyed"].includes(old.state)),
      )
    )
      throw new Error("resident-cleanup-refused: emergency disposal audit changed");
    const destructionConfirmed = targets.length > 0 && audits.every(({ old }) => old?.state === "runtime-destroyed");
    if (destructionConfirmed) {
      if (
        (await this.ctx.storage.get(CLEANUP_PENDING_KEY)) !== resource ||
        (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) ||
        this.ctx.container?.running === true
      )
        throw new Error("resident-cleanup-refused: confirmed destruction cannot be reused");
    } else {
      if (audits.some(({ old }) => old !== undefined))
        throw new Error("resident-cleanup-refused: earlier destruction is unconfirmed");
      if (targets.length)
        await this.ctx.storage.transaction(async (rows) => {
          const current = await journal.unresolved(NATIVE_OPERATION_PREFIX, rows);
          const hashes = await journal.fingerprints(NATIVE_OPERATION_PREFIX, rows);
          if (current.size !== targets.length || targets.some((target) => hashes[target.key] !== target.recordHash))
            throw new Error("resident-cleanup-refused: original native record changed before destruction");
          for (const { target, key } of audits)
            await rows.put(key, {
              resource,
              key: target.key,
              recordHash: target.recordHash,
              ...(target.unknownEffect ? { unknownEffect: target.unknownEffect } : {}),
              original: current.get(target.key),
              originalOperationOutcome: "unknown",
              state: "prepared",
            });
        });
      await this.ctx.storage.put(CLEANUP_PENDING_KEY, resource);
      await this.destroyConfirmed();
    }
    if (targets.length && !resumeWithoutRecord)
      await this.ctx.storage.transaction(async (rows) => {
        const current = await journal.unresolved(NATIVE_OPERATION_PREFIX, rows);
        const hashes = await journal.fingerprints(NATIVE_OPERATION_PREFIX, rows);
        if (current.size !== targets.length || targets.some((target) => hashes[target.key] !== target.recordHash))
          throw new Error("resident-cleanup-refused: original native record changed after destruction");
        for (const { target, key } of audits)
          await rows.put(key, {
            resource,
            key: target.key,
            recordHash: target.recordHash,
            ...(target.unknownEffect ? { unknownEffect: target.unknownEffect } : {}),
            original: current.get(target.key),
            originalOperationOutcome: "unknown",
            state: "runtime-destroyed",
          });
      });
    const containerStopped = true;
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
    if (errors.length > 0) {
      // Retain the current, retired and dependency handles until their R2
      // removal is confirmed. A restart must rediscover unfinished cleanup.
      await this.setResidentState("down", `full-rebuild-cleanup-incomplete: ${errors.join("; ")}`);
      return { schedulesCancelled: true, containerStopped, storageCleared: false, backupObjectsDeleted, errors };
    }
    if (targets.length && !resumeWithoutRecord) {
      // A late original restore reply may change a selected row during the
      // awaited backup deletion. Compare and remove the set in one transaction.
      await this.ctx.storage.transaction(async (rows) => {
        const hashes = await journal.fingerprints(NATIVE_OPERATION_PREFIX, rows);
        const current = await journal.unresolved(NATIVE_OPERATION_PREFIX, rows);
        if (current.size !== targets.length || targets.some((target) => hashes[target.key] !== target.recordHash))
          throw new Error("resident-cleanup-refused: original native record changed after backup cleanup");
        await rows.delete(targets.map((target) => target.key));
      });
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
    const keys = [...(await this.ctx.storage.list()).keys()].filter(
      (key) =>
        key !== CLEANUP_PENDING_KEY &&
        key !== RESIDENT_ID_KEY &&
        key !== RESIDENT_RETIRED_KEY &&
        !key.startsWith(NATIVE_EMERGENCY_DISCARD_PREFIX),
    );
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    return {
      schedulesCancelled: true,
      containerStopped,
      storageCleared: true,
      backupObjectsDeleted,
      ...(targets.length === 1 ? { discardedUnknownNative: targets[0] } : {}),
      ...(targets.length > 1 ? { discardedUnknownNatives: targets } : {}),
      errors,
    };
  }

  /** Metadata and deterministic R2 reads confirm cleanup; no runtime wakes. */
  async confirmCleanup(resource: string): Promise<void> {
    const pending = await this.ctx.storage.get<string>(CLEANUP_PENDING_KEY);
    if (pending === undefined) return;
    if (
      pending !== resource ||
      this.destroying ||
      (await this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)) ||
      this.ctx.container?.running === true
    )
      throw new Error("resident-cleanup-unconfirmed");
    const backups = await this.recordedBackupIds(await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY));
    if (
      backups.length ||
      (await this.allDepsBackups()).length ||
      (await countR2Prefix(
        this.env.BACKUP_BUCKET,
        r2Prefix((await this.ctx.storage.get<string>(RESIDENT_ID_KEY)) ?? resource),
      )) > 0
    )
      throw new Error("resident-cleanup-unconfirmed");
    await this.ctx.storage.delete(CLEANUP_PENDING_KEY);
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

type Scope = "admin" | "operator" | "read" | "drain" | "retire";

/** Which token a bearer is, or null. Constant-time per comparison; fail closed
 *  on unset/empty secrets. */
function tokenScope(env: Env, token: string | null): Scope | null {
  if (!token) return null;
  if (env.RESIDENT_ADMIN_TOKEN && timingSafeEqual(token, env.RESIDENT_ADMIN_TOKEN)) return "admin";
  if (env.RESIDENT_OPERATOR_TOKEN && timingSafeEqual(token, env.RESIDENT_OPERATOR_TOKEN)) return "operator";
  if (env.RESIDENT_READ_TOKEN && timingSafeEqual(token, env.RESIDENT_READ_TOKEN)) return "read";
  if (env.RESIDENT_DRAIN_TOKEN && timingSafeEqual(token, env.RESIDENT_DRAIN_TOKEN)) return "drain";
  if (env.RESIDENT_RETIRE_TOKEN && timingSafeEqual(token, env.RESIDENT_RETIRE_TOKEN)) return "retire";
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

/** Read-only diagnostics. Workload inspection observes the canonical owner and
 * identities in an already active VM; it never starts a VM or controls work. */
const READ_DEBUG_OPS = new Set(["info", "schedules", "threads", "deps-backups", "native-operations", "workload-audit"]);

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
  "/installation-reset/settings": { scope: "admin", method: "POST" },
  "/register": { scope: "admin", method: "POST" },
  "/onboard": { scope: "admin", method: "POST" },
  "/offboard": { scope: "admin", method: "POST" },
  "/reconfigure": { scope: "admin", method: "POST" },
  "/replicas": { scope: "admin", method: "POST" },
  "/rebuild": { scope: "admin", method: "POST" },
  "/replica-rebuild": { scope: "admin", method: "POST" },
  "/replica-reset": { scope: "admin", method: "POST" },
  "/replica-status": { scope: "operator", method: "GET" },
  "/reset": { scope: "admin", method: "POST" },
  "/drain": { scope: "drain", method: "POST" }, // close the fleet to new runs for a deploy (item 69; admin implied)
  "/deploy-fence": { scope: "drain", method: "POST" }, // fence reattach and read executing activity
  "/prepare-deploy-fence": { scope: "drain", method: "POST" },
  "/abandon-deploy-fence-acquisition": { scope: "drain", method: "POST" },
  "/deploy-fence-acquisition": { scope: "drain", method: "GET" },
  "/deploy-fence-recovery": { scope: "admin", method: "GET" },
  "/release-deploy-fence": { scope: "admin", method: "POST" },
  "/deploy-admissions": { scope: "admin", method: "GET" }, // targeted recovery inventory, never a drain-bearer route
  "/abandon-deploy-admission": { scope: "admin", method: "POST" },
  "/deploy-admission-abandonment": { scope: "admin", method: "GET" },
  "/replica-recover-native-operation": { scope: "admin", method: "POST" },
  "/retire-native-operation": { scope: "retire", method: "POST" },
  "/recover-native-operation": { scope: "admin", method: "POST" }, // exact journal plus original native receipt
  "/recover-admission": { scope: "admin", method: "POST" }, // legacy requests refuse without mutation
  "/recover-quoted-admission": { scope: "admin", method: "POST" }, // original record plus operator evidence
  "/staging-maintenance": { scope: "read", method: "GET" },
  "/staging-abandon-admission": { scope: "admin", method: "POST" },
  "/staging-release-maintenance": { scope: "admin", method: "POST" },
  "/staging-seal-window": { scope: "drain", method: "POST" },
  "/undrain": { scope: "drain", method: "POST" }, // reopen it
  "/reconcile": { scope: "drain", method: "POST" }, // reconcile every container onto the current image, inside the drain window
  "/residents": { scope: "read", method: "GET" }, // admin implied; read-only bearer allowed
  "/debug-replica": { scope: "read", method: "POST" },
  "/debug": { scope: "read", method: "POST" }, // per-op: READ_DEBUG_OPS for read scope, everything for admin
  "/status": { scope: "operator", method: "GET" },
  "/attach": { scope: "operator", method: "POST" },
  "/run-deadline": { scope: "operator", method: "POST" },
  "/detach": { scope: "operator", method: "POST" },
  "/cancel-run": { scope: "operator", method: "POST" },
  "/exec": { scope: "operator", method: "POST" },
  "/exec-result": { scope: "operator", method: "POST" },
  "/inspect-check": { scope: "operator", method: "POST" },
  "/settle-check": { scope: "operator", method: "POST" },
  "/inspect-credentials": { scope: "operator", method: "POST" },
  "/publish": { scope: "operator", method: "POST" },
  "/read": { scope: "operator", method: "POST" },
  "/write": { scope: "operator", method: "POST" },
  "/op": { scope: "operator", method: "POST" },
  "/await-restore": { scope: "operator", method: "POST" },
};

/** Admin lifecycle calls can start work after the resident activity snapshot.
 * A registry permit makes them visible to the same deploy barrier as thread
 * commands; a failed registry read refuses rather than opening a gap. */
async function withFleetAdmission(env: Env, work: () => Promise<Response>, origin?: unknown): Promise<Response> {
  const registry = registryStub(env);
  const id = await beginTrackedDeployAdmission(registry, {
    ...deployAdmissionOrigin(origin),
    kind: "fleet-lifecycle",
    component: "http",
    build: BUILD_ID,
    workerVersion: workerVersionId(env),
  }).catch(() => null);
  if (!id) return json({ error: "deploy-fence: resident fleet admission is closed" }, 503);
  try {
    return await work();
  } finally {
    await endTrackedDeployAdmission(registry, id);
  }
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
        features: { nativeRunScopes: "native-v1", deployFenceAcquisition: "v1" },
        ...(transfer.missing.length > 0 ? { backupTransferMissing: transfer.missing } : {}),
      });
    }

    // Auth precedes existence: unknown paths demand admin before revealing
    // 404 vs 401, so an unauthenticated scanner learns nothing.
    // Versioned execution routes refuse on old receivers before any SDK work.
    const nativeProtocol = url.pathname.startsWith("/native/");
    if (nativeProtocol) url.pathname = url.pathname.slice("/native".length);
    const route = ROUTES[url.pathname];
    const bearer = bearerToken(request);
    if (!hasScope(env, bearer, route?.scope ?? "admin")) {
      return json({ error: "unauthorized" }, 401);
    }
    const isAdmin = tokenScope(env, bearer) === "admin";
    if (!route) return json({ error: "unknown route" }, 404);
    if (request.method !== route.method) return json({ error: `${route.method} only` }, 405);

    observeWorkerRequest(request, { service: "resident", route: url.pathname, build: BUILD }, ctx?.tracing);
    const body: Record<string, unknown> =
      route.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    if (
      ["/replica-rebuild", "/replica-reset", "/debug-replica", "/replica-recover-native-operation"].includes(
        url.pathname,
      ) &&
      body.resident === undefined
    )
      return json({ error: "resident number is required" }, 400);
    if (url.pathname === "/replica-status" && !url.searchParams.has("resident"))
      return json({ error: "resident number is required" }, 400);

    // Authenticated from here (docs/reference/specs/tracing.md item 22): the bot's trace
    // context is read only now. The streamed routes hand it to the DO, whose
    // own root covers the work; every other route is one `resident.fetch` root.
    const traceparent = request.headers.get("traceparent") ?? undefined;
    const root = STREAMED_ROUTES.has(url.pathname)
      ? undefined
      : startAdoptedRoot(tracer, "resident.fetch", { sinks: traceSinks, traceparent, attrs: { route: url.pathname } });
    const requestContext = (): NativeRequestContext => ({
      requestId: workerRequestId(request.headers),
      callId: crypto.randomUUID(),
      actor: tokenScope(env, bearer) ?? "service",
      traceId: root?.traceId ?? parseTraceparent(traceparent)?.traceId ?? null,
      parentSourceId: null,
    });
    const res = await (async (): Promise<Response> => {
      try {
        switch (url.pathname) {
          case "/installation-reset/settings": {
            const action = body.action;
            if (!["preview", "freeze", "restore"].includes(String(action)))
              return json({ error: "invalid repository reset action" }, 400);
            const result = await registryStub(env).resetSettings(
              action as "preview" | "freeze" | "restore",
              body.operation as string | undefined,
              body.records as ResidentRecord[] | undefined,
            );
            if (action === "restore") {
              let initialized = 0;
              for (const member of residentMembers(result.records)) {
                const context = {
                  event: "installation.reset.repositories",
                  action,
                  operation: body.operation,
                  registrations: result.records.length,
                  resource: member.resource,
                  residentId: residentAddress(member),
                };
                console.log(JSON.stringify({ ...context, outcome: "initializing", initialized }));
                await residentStub(env, residentAddress(member)).initResident(
                  member.resource,
                  member.provisioningTimeoutMs,
                  false,
                  residentAddress(member),
                );
                console.log(JSON.stringify({ ...context, outcome: "initialized", initialized: ++initialized }));
              }
              console.log(
                JSON.stringify({
                  event: "installation.reset.repositories",
                  action,
                  operation: body.operation,
                  registrations: result.records.length,
                  initialized,
                  outcome: "complete",
                }),
              );
            }
            return json(result);
          }
          case "/register":
            if ((await registryStub(env).getStagingMaintenance())?.state === "held")
              return json({ error: "staging maintenance blocks registration" }, 409);
            return await handleOnboard(env, { ...body, noResident: true });
          case "/replicas":
            return await withFleetAdmission(env, () => handleReplicas(env, body), {
              resource: body.resource,
              sourceId: "replicas",
              traceId: root?.traceId,
              requesterScope: tokenScope(env, bearer),
            });
          case "/onboard":
            return await withFleetAdmission(env, () => handleOnboard(env, body), {
              resource: body.resource,
              sourceId: "onboard",
              traceId: root?.traceId,
              requesterScope: tokenScope(env, bearer),
            });
          case "/offboard":
            return await withFleetAdmission(env, () => handleOffboard(env, body), {
              resource: body.resource,
              sourceId: "offboard",
              traceId: root?.traceId,
              requesterScope: tokenScope(env, bearer),
            });
          case "/reconfigure":
            if ((await registryStub(env).getStagingMaintenance())?.state === "held")
              return json({ error: "staging maintenance blocks configuration changes" }, 409);
            return await handleReconfigure(env, body);
          case "/replica-rebuild":
          case "/rebuild":
            return await withFleetAdmission(env, () => handleRebuild(env, body), {
              resource: body.resource,
              sourceId: "rebuild",
              traceId: root?.traceId,
              requesterScope: tokenScope(env, bearer),
            });
          case "/replica-reset":
          case "/reset":
            return await withFleetAdmission(env, () => handleReset(env, body), {
              resource: body.resource,
              sourceId: "reset",
              traceId: root?.traceId,
              requesterScope: tokenScope(env, bearer),
            });
          case "/drain":
            return await handleDrain(env, body);
          case "/deploy-fence":
            return await handleDeployFence(env, body.attempt);
          case "/prepare-deploy-fence":
            return await handlePrepareDeployFence(env, request, ctx, body);
          case "/abandon-deploy-fence-acquisition":
            return await handleAbandonDeployFenceAcquisition(env, ctx, body);
          case "/deploy-fence-acquisition":
            return await handleReadDeployFenceAcquisition(env, url);
          case "/deploy-fence-recovery":
            return await handleDeployFenceRecovery(env, url);
          case "/release-deploy-fence":
            return await handleReleaseDeployFence(env, body);
          case "/deploy-admissions":
            return await handleDeployAdmissions(env, url);
          case "/abandon-deploy-admission":
            return await handleOperatorAbandonment(registryStub(env), body, await operatorSha256(bearer!));
          case "/deploy-admission-abandonment":
            return await handleOperatorAbandonmentRead(registryStub(env), url);
          case "/retire-native-operation":
            return await handleRetireNativeOperation(env, body);
          case "/replica-recover-native-operation":
          case "/recover-native-operation":
            return await handleRecoverNativeOperation(env, body);
          case "/recover-admission":
            return json({ error: "legacy permit recovery is unavailable" }, 409);
          case "/recover-quoted-admission":
            return await handleRecoverAdmission(env, body);
          case "/staging-maintenance": {
            const holdId = url.searchParams.get("holdId");
            if (holdId !== null && !stagingAttemptSchema.shape.holdId.safeParse(holdId).success)
              return json({ error: "a valid staging hold ID is required" }, 400);
            return json({ maintenance: await registryStub(env).getStagingMaintenanceReadback(holdId ?? undefined) });
          }
          case "/staging-abandon-admission":
            return await handleStagingAbandonment(env, body);
          case "/staging-release-maintenance":
            return await handleStagingMaintenanceRelease(env, body);
          case "/staging-seal-window": {
            const registry = registryStub(env);
            let sealed: boolean;
            try {
              sealed = await registry.sealStagingWindow(
                body.attempt,
                workerVersionId(env),
                workerVersionTimestamp(env),
              );
            } catch {
              const selected = stagingAttemptSchema.safeParse(body.attempt);
              emitDeployAdmission({
                phase: "staging-seal-commit",
                observedAt: systemClock(),
                attemptId: selected.success ? selected.data.id : null,
                commit: "unverified",
                failure: "storage-or-rpc",
                nativeOutcome: "unverified",
              });
              const receipt = await registry.getStagingMaintenanceReadback().catch(() => null);
              const held = await registry.getStagingMaintenance().catch(() => null);
              sealed =
                held !== null &&
                stagingAttemptMatches(held, body.attempt) &&
                receipt?.state === "held" &&
                receipt.window?.state === "completed";
            }
            return json({ sealed }, sealed ? 200 : 409);
          }
          case "/undrain":
            return await handleUndrain(env);
          case "/reconcile":
            return await handleReconcile(env, body.attempt, body.imageTarget);
          case "/residents":
            return await handleResidents(env);
          case "/debug-replica":
          case "/debug": {
            // Read scope may only run the pure-read ops; the check happens AFTER
            // auth so an unauthenticated caller still learns nothing extra.
            const op = typeof body.op === "string" ? body.op : "";
            // Authenticated but under-scoped → 403 (401 is reserved for "no valid bearer").
            if (!isAdmin && !READ_DEBUG_OPS.has(op))
              return json({ error: "forbidden: admin scope required for this op" }, 403);
            return READ_DEBUG_OPS.has(op)
              ? await handleDebug(env, body)
              : await withFleetAdmission(env, () => handleDebug(env, body), {
                  resource: body.resource,
                  sourceId: "debug",
                  traceId: root?.traceId,
                  requesterScope: tokenScope(env, bearer),
                });
          }
          case "/replica-status":
          case "/status":
            return await handleStatus(env, url);
          case "/attach":
            return await handleAttach(env, body, traceparent, nativeProtocol, requestContext());
          case "/run-deadline":
            return await handleRunDeadline(env, body);
          case "/cancel-run": {
            const cancellation = cancellationOf(body.cancellation);
            const resource = parseResource(body.resource);
            if (
              !cancellation ||
              "error" in resource ||
              body.resource !== `repo:${cancellation.repo}` ||
              (body.binding !== null && (!body.binding || typeof body.binding !== "object"))
            ) {
              cancellationRefusal(cancellation, "resident", "invalid-request");
              return json({ error: "invalid cancellation" }, 400);
            }
            const preparation = await readCancellationPreparation(
              cancellation,
              body.binding,
              env.STATE_WORKER_URL,
              env.MEMORY_TOKEN,
            );
            if (!("prepared" in preparation)) return json(preparation, 409);
            // Preparation binds this exact target to the original run. Keep its
            // address usable even after an authorized pool offboard removes placement.
            const route =
              body.binding === null
                ? await residentRouteFor(env, resource.resource, cancellation.threadKey, null, true)
                : residentRouteOf(body.binding);
            if (route === null) return json({ error: "invalid resident address" }, 400);
            if (route instanceof Response) return route;
            return json(
              await residentStub(env, route?.residentId ?? resource.resource).cancelRun(cancellation, body.binding),
            );
          }
          case "/detach":
            return await handleDetach(env, body, requestContext());
          case "/exec-result": {
            const operation = checkOperationSchema.safeParse(body.checkOperation);
            if (!operation.success) return json({ kind: "unknown" }, 400);
            const ctx = await resolveThreadRoute(env, body);
            if (ctx instanceof Response) return ctx;
            return json(await ctx.stub.inspectCheckResult(ctx.threadKey, operation.data, requestWorkspaceOwner(body)));
          }
          case "/inspect-check":
          case "/settle-check":
            return await handleRecordedCheck(env, body, url.pathname === "/settle-check");
          case "/exec":
            return await handleExec(env, body, traceparent, requestContext());
          case "/inspect-credentials":
            return await handleInspectCredentials(env, body, requestContext());
          case "/publish":
            return await handlePublish(env, body, requestContext());
          case "/read":
            return await handleRead(env, body, requestContext());
          case "/write":
            return await handleWrite(env, body, requestContext());
          case "/op":
            return await handleOp(env, body, traceparent, requestContext());
          case "/await-restore":
            return await handleAwaitRestore(env, body, requestContext());
          default:
            return json({ error: "unknown route" }, 404);
        }
      } catch (err) {
        return json(catchAllErr(err), 500);
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
  if (body.noResident !== undefined && typeof body.noResident !== "boolean")
    return json({ error: "noResident must be a boolean" }, 400);
  if (body.noResident === true && body.evictColdest === true)
    return json({ error: "noResident cannot be combined with evictColdest" }, 400);
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
          cause: "policy",
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
    ...(body.noResident === true ? { noResident: true } : {}),
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
    const victim = await registry.getRecord(pick.candidate.resource);
    if (!victim) return json({ error: "eviction refused: candidate registry row vanished" }, 409);
    result = await registry.replace(pick.candidate.resource, record);
    if ("error" in result) return json({ error: result.error, wouldHaveEvicted: pick.candidate }, result.status);
    const teardown = await teardownResident(env, pick.candidate.resource);
    if (!teardown.containerStopped) {
      await registry.replace(record.resource, victim);
      return json({ error: "eviction refused: old container destruction unconfirmed", evicted: teardown }, 503);
    }
    evicted = { ...pick.candidate, registryRemoved: true, ...teardown };
    console.log(
      `lru-evict: offboarded ${pick.candidate.resource} (last activity ${pick.candidate.lastActivityAt}) to make room for ${resource.resource}`,
    );
  }
  if ("error" in result) return json({ error: result.error, ...(evicted ? { evicted } : {}) }, result.status);

  if (record.noResident === true)
    return json({ resource: record.resource, state: "cold", ...(warning ? { warning } : {}) });

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
  const residents = (await registryStub(env).list()).filter((record) => !record.pool);
  const settled = await Promise.allSettled(
    residents.map((record) => residentStub(env, residentAddress(record)).getResidentInfo()),
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
  const record = await registry.getRepository(resource.resource);
  if (!record) {
    // Registry and resource rows may already be gone after partial cleanup.
    // Only the same durable cleanup target can authorize another teardown.
    const old = await residentStub(env, resource.resource).getResidentInfo();
    if (old.resource !== resource.resource && old.cleanupPending !== resource.resource)
      return json({ error: `${resource.resource} is not onboarded` }, 404);
  }

  if (record?.pool) {
    const members = residentMembers([record]);
    if (body.dryRun === true) {
      const plans = await Promise.all(
        members.map(async (member) => ({
          residentId: residentAddress(member),
          ...(await residentStub(env, residentAddress(member)).teardownPlan()),
        })),
      );
      return json({
        resource: record.resource,
        dryRun: true,
        wouldRemove: {
          registryRecord: true,
          members: plans,
          pendingMembers: record.pool.members.length - record.pool.active,
        },
      });
    }
    const held = await registry.beginPoolOffboard(record.resource, record.pool.revision);
    if (!held?.pool) return json({ error: "resident pool changed before offboard" }, 409);
    const results = [];
    for (const member of residentMembers([held])) {
      const residentId = residentAddress(member);
      results.push({
        residentId,
        ...(await residentStub(env, residentId).removePoolMember(held.resource, residentId, held.pool.revision)),
      });
    }
    const complete = results.every((r) => r.containerStopped && r.storageCleared && r.errors.length === 0);
    const registryRemoved = complete && (await registry.finishPoolOffboard(held.resource, held.pool.revision));
    return json({
      resource: held.resource,
      registryRemoved,
      members: results,
      schedulesCancelled: results.every((r) => r.schedulesCancelled),
      containerStopped: results.every((r) => r.containerStopped),
      storageCleared: results.every((r) => r.storageCleared),
      backupObjectsDeleted: results.reduce((n, r) => n + r.backupObjectsDeleted, 0),
      r2ObjectsDeleted: results.reduce((n, r) => n + r.r2ObjectsDeleted, 0),
      errors: [
        ...results.flatMap((r) => r.errors.map((error) => `${r.residentId}: ${error}`)),
        ...(!registryRemoved ? ["resident pool cleanup is incomplete"] : []),
      ],
    });
  }

  if (record?.noResident === true) {
    if (body.dryRun === true)
      return json({
        resource: record.resource,
        dryRun: true,
        wouldRemove: {
          registryRecord: true,
          schedules: [],
          snapshotBackupIds: [],
          backupObjects: 0,
          r2Objects: 0,
          threadBindings: 0,
          container: "none",
        },
      });
    const registryRemoved = await registry.remove(record.resource);
    return json({
      resource: record.resource,
      registryRemoved,
      schedulesCancelled: true,
      containerStopped: true,
      storageCleared: true,
      backupObjectsDeleted: 0,
      r2ObjectsDeleted: 0,
      errors: [],
    });
  }

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

  const result = await offboardResident(env, resource.resource);
  return json(result, result.containerStopped ? 200 : 503);
}

/** The full offboard teardown (item 11), shared by POST /offboard and the LRU
 *  eviction path of POST /onboard: registry removal first (the slot frees
 *  atomically and no new work routes here), then the DO teardown and the
 *  resident/<resource>/ R2 prefix sweep, then confirmed cleanup releases the
 *  durable hold. The teardown's backups live under backups/<id>/. */
async function offboardResident(
  env: Env,
  resource: string,
): Promise<{ resource: string; registryRemoved: boolean } & Awaited<ReturnType<typeof teardownResident>>> {
  const registryRemoved = await registryStub(env).remove(resource);
  return { resource, registryRemoved, ...(await teardownResident(env, resource)) };
}

/** Everything AFTER the registry removal: DO teardown, then R2 prefix sweep.
 *  Split out so the LRU path can reserve the slot atomically (registry
 *  `replace`) before destroying anything. */
async function teardownResident(
  env: Env,
  resource: string,
  residentId = resource,
  confirm = true,
  stub: Pick<ResidentDO, "teardown" | "confirmCleanup"> = residentStub(env, residentId),
): Promise<{
  schedulesCancelled: boolean;
  containerStopped: boolean;
  storageCleared: boolean;
  backupObjectsDeleted: number;
  r2ObjectsDeleted: number;
  errors: string[];
}> {
  const teardown = await stub.teardown().catch((err: unknown): Awaited<ReturnType<ResidentDO["teardown"]>> => ({
    schedulesCancelled: false,
    containerStopped: false,
    storageCleared: false,
    backupObjectsDeleted: 0,
    errors: [`teardown failed: ${errMsg(err)}`],
  }));
  // If destroy was uncertain, preserve its durable refusal and all resident
  // objects. A later admin offboard can retry the same DO identity.
  const r2Sweep = teardown.containerStopped
    ? await deleteR2Prefix(env.BACKUP_BUCKET, r2Prefix(residentId))
        .then((deleted) => ({ deleted, error: undefined as string | undefined }))
        .catch((err: unknown) => ({
          deleted: 0,
          error: `r2 prefix sweep failed for ${r2Prefix(residentId)}: ${errMsg(err)}`,
        }))
    : { deleted: 0, error: undefined };

  const errors = [...teardown.errors];
  if (r2Sweep.error) errors.push(r2Sweep.error);
  if (confirm && teardown.storageCleared && errors.length === 0) {
    try {
      await stub.confirmCleanup(resource);
    } catch (err) {
      errors.push(`cleanup confirmation failed: ${errMsg(err)}`);
    }
  }

  return {
    schedulesCancelled: teardown.schedulesCancelled,
    containerStopped: teardown.containerStopped,
    storageCleared: teardown.storageCleared,
    backupObjectsDeleted: teardown.backupObjectsDeleted,
    r2ObjectsDeleted: r2Sweep.deleted,
    errors,
  };
}

async function handleReplicas(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  if (
    Object.keys(body).some((key) => key !== "resource" && key !== "warmReplicas") ||
    typeof body.warmReplicas !== "number"
  )
    return json({ error: "replica configuration requires resource and warmReplicas only" }, 400);
  const result = await registryStub(env).requestWarmReplicas(resource.resource, body.warmReplicas);
  if (!result.ok) return json({ error: result.error }, result.status);
  const pool = residentPoolOf(result.record);
  return json({
    resource: resource.resource,
    warmReplicas: pool?.desired ?? 1,
    activeReplicas: pool?.active ?? 1,
    record: result.record,
  });
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

/** Full resident reset keeps registration durable while replacing its runtime
 * and stored work. An older Worker must refuse this dedicated route instead
 * of silently running a binding-preserving rebuild. */
async function handleReset(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    return json({ error: "dryRun must be a boolean" }, 400);
  const discard = body.discardUnknownNative;
  const validDiscardTarget = (value: unknown): value is NativeDiscardTarget => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const target = value as { key?: unknown; recordHash?: unknown; unknownEffect?: unknown };
    const keys = Object.keys(value).sort().join(",");
    if (
      !validNativeOperationKey(target.key) ||
      typeof target.recordHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(target.recordHash)
    )
      return false;
    if (keys === "key,recordHash") return true;
    if (keys !== "key,recordHash,unknownEffect" || !target.unknownEffect || typeof target.unknownEffect !== "object")
      return false;
    const unknownEffect = target.unknownEffect as { originBuild?: unknown };
    return (
      Object.keys(unknownEffect).join(",") === "originBuild" &&
      typeof unknownEffect.originBuild === "string" &&
      unknownEffect.originBuild.length > 0 &&
      unknownEffect.originBuild.length <= 128
    );
  };
  const validDiscard = Array.isArray(discard)
    ? discard.length >= 2 &&
      discard.length <= 64 &&
      discard.every(validDiscardTarget) &&
      new Set(discard.map((target: NativeDiscardTarget) => target.key)).size === discard.length &&
      new Set(discard.map((target: NativeDiscardTarget) => target.recordHash)).size === discard.length
    : validDiscardTarget(discard) && !discard.unknownEffect;
  if (discard !== undefined && !validDiscard)
    return json(
      {
        error: Array.isArray(discard)
          ? "two to 64 distinct exact native keys and record hashes are required"
          : "one exact native key and record hash are required",
      },
      400,
    );
  const record = await registryStub(env).getRepository(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  if (record.noResident === true || record.offboarding)
    return json({ error: `${record.resource} has no resident to reset` }, 409);
  const dryRun = body.dryRun === true;
  if (body.resident !== undefined && typeof body.resident !== "number")
    return json({ error: "resident number must be an integer" }, 400);
  const member = selectedResidentMember(record, body.resident as number | undefined);
  if (!member) return json({ error: "an active resident number is required for this repository" }, 409);
  const result = await residentStub(env, member).reset(
    resource.resource,
    record.defaultRef,
    record.provisioningTimeoutMs,
    dryRun,
    discard as NativeDiscardSelection | undefined,
  );
  return json(result, "error" in result ? result.status : dryRun ? 200 : 202);
}

/** Snapshot rebuild keeps the registry and thread bindings. */
async function handleRebuild(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const dryRun = body.dryRun === true;

  const record = await registryStub(env).getRepository(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  if (record.noResident === true || record.offboarding)
    return json({ error: `${record.resource} has no resident to rebuild` }, 409);

  if (body.resident !== undefined && typeof body.resident !== "number")
    return json({ error: "resident number must be an integer" }, 400);
  const member = selectedResidentMember(record, body.resident as number | undefined);
  if (!member) return json({ error: "an active resident number is required for this repository" }, 409);
  const result = await residentStub(env, member).rebuild(
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
/** POST /drain (admin): close the fleet to new runs (docs/reference/specs/resident-repos.md
 *  item 69). The record carries its own end (`until`), so a drain nobody lifts
 *  ends by itself; a second drain replaces the first. Runs in flight are
 *  untouched — the deploy that asked waits for them through `/residents`. */
async function handleDrain(env: Env, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseDrainRequest(body, systemClock());
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const record = await registryStub(env).setDrain(parsed.record, body.attempt);
  if (!record) return json({ error: "deploy-fence: an upload already owns the fleet drain" }, 409);
  console.log(`[drain] fleet closed to new runs by ${record.by} for ${record.reason}: until ${record.until}`);
  return json({ draining: record, planeOutbox: await registryStub(env).getDrainOutbox() });
}

/** POST /undrain (admin): reopen the fleet. Idempotent — `cleared` says
 *  whether a drain stood and was lifted. With containers still to report the
 *  deploy's image (issue 1931) the fleet STAYS closed: `held` names them, the
 *  record stands with the lift asked, and the last container's report reopens
 *  the fleet — a fact, never a timer; the drain's `until` is the backstop. */
async function handleUndrain(env: Env): Promise<Response> {
  const lift = await registryStub(env).clearDrain(workerVersionId(env), workerVersionTimestamp(env));
  if (lift.error) return json({ error: lift.error }, 409);
  if (!lift.cleared && lift.held.length > 0) {
    console.log(`[drain] fleet stays closed — containers still to report the deploy's image: ${lift.held.join(", ")}`);
    const draining = liveDrain(await registryStub(env).getDrain(), systemClock());
    return json({ draining, cleared: false, held: lift.held, planeOutbox: await registryStub(env).getDrainOutbox() });
  }
  console.log(`[drain] fleet reopened (${lift.cleared ? "a drain stood" : "no drain stood"})`);
  return json({ draining: null, cleared: lift.cleared, planeOutbox: await registryStub(env).getDrainOutbox() });
}

/** Fence registered reattach, then read every resident. A refusal removes
 * only this attempt's fence; the drain still protects new admissions. */
async function handleDeployFence(env: Env, attempt?: unknown): Promise<Response> {
  const registry = registryStub(env);
  const versionId = workerVersionId(env);
  if (!workerVersionTimestamp(env)) return json({ error: "Worker version timestamp is unavailable" }, 503);
  const fence = await registry.setDeployFence(versionId, attempt);
  if (fence === null)
    return json({ error: "deploy-fence requires a live fleet drain with time for upload and readiness" }, 409);
  try {
    const residents = await registry.list();
    const settled = await Promise.allSettled(
      residents.map((record) => residentStub(env, residentAddress(record)).getResidentDeployInfo()),
    );
    const enriched = residents.map((record, i) => {
      const result = settled[i];
      return { ...record, live: result.status === "fulfilled" ? result.value : { error: "resident-view-unavailable" } };
    });
    const admissionReadback = await registry.getDeployAdmissionReadback().catch(() => null);
    const sameFence = await registry.verifyDeployFence(fence.since, fence.until, versionId);
    const activeAdmissions = await registry.activeDeployAdmissions();
    const safe = sameFence && residentDeployViewsReady(enriched);
    if (!safe) await registry.clearDeployFence(fence.since, fence.until, versionId);
    return json({
      draining: safe ? fence : { ...fence, swapFence: false },
      fenceReady: safe,
      activeAdmissions,
      admissionReadback,
      stagingMaintenance: await registry.getStagingMaintenanceReadback(),
      deployDiagnostic: {
        schema: 1,
        producer: { build: BUILD_ID, workerVersion: versionId },
        fenceDisposition: safe ? "retained" : "withdrawn",
        admissionReadback: admissionReadback === null ? "unavailable" : "reported",
      },
      residents: enriched,
    });
  } catch {
    await registry.clearDeployFence(fence.since, fence.until, versionId);
    return json({ error: "deploy-fence-read-unavailable" }, 503);
  }
}

function residentDeployViewsReady(residents: readonly { live: unknown }[]): boolean {
  return residents.every(({ live }) => {
    const state = live as Record<string, unknown>;
    return (
      Number.isSafeInteger(state.executingRuns) &&
      Number(state.executingRuns) === 0 &&
      Number.isSafeInteger(state.unknownRuns) &&
      Number(state.unknownRuns) === 0 &&
      ["warm", "degraded", "down", "refreshing", "restoring"].includes(String(state.state))
    );
  });
}

/** Incoming cancellation is local to this preparation, never a native stop signal. */
async function handlePrepareDeployFence(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
  body: unknown,
): Promise<Response> {
  const id = fenceAcquisitionRequestId(body);
  if (!id) return json({ error: "an exact deployment acquisition id is required" }, 400);
  const versionId = workerVersionId(env);
  if (!versionId || !workerVersionTimestamp(env)) return json({ error: "Worker version metadata is unavailable" }, 503);
  const registry = registryStub(env);
  let withdrawal: Promise<FenceAcquisition | null> | undefined;
  const abandon = () =>
    (withdrawal ??= (async () => {
      try {
        const result = fenceAcquisitionOf(await registry.abandonDeployFenceAcquisition(id, versionId, BUILD_ID));
        if (result?.id === id && result.phase === "abandoned") return result;
      } catch {
        /* Qualify only the original retained disposition after a lost reply. */
      }
      try {
        const saved = fenceAcquisitionOf(await registry.readDeployFenceAcquisition(id));
        return saved?.id === id && saved.phase === "abandoned" ? saved : null;
      } catch {
        return null;
      }
    })());
  const onAbort = () => ctx.waitUntil(abandon());
  const refused = async (status: number, observations: Record<string, unknown> = {}): Promise<Response> => {
    const disposition = await abandon();
    emitDeployAdmission({
      phase: "fence-acquisition-withdrawal",
      id,
      workerVersion: versionId,
      acquisitionDisposition: disposition?.phase === "abandoned" ? disposition.disposition : "unverified",
      commit: disposition ? "acknowledged" : "unverified",
      nativeOutcome: "unverified",
    });
    return json(
      {
        ...observations,
        error: disposition
          ? status === 200
            ? "deploy-fence-not-ready"
            : "deploy-fence-read-unavailable"
          : "deploy-fence-acquisition-unverified",
        fenceReady: false,
        acquisition: disposition ? fenceAcquisitionReceipt(disposition) : null,
        ...(disposition?.originalDrain ? { draining: { ...disposition.originalDrain, swapFence: false } } : {}),
        deployDiagnostic: {
          schema: 1,
          producer: { build: BUILD_ID, workerVersion: versionId },
          fenceDisposition: disposition ? "withdrawn" : "unavailable",
        },
      },
      disposition ? status : 503,
    );
  };
  const observe = async () => {
    const residents = await registry.list();
    const settled = await Promise.allSettled(
      residents.map((record) => residentStub(env, residentAddress(record)).getResidentDeployInfo()),
    );
    const enriched = residents.map((record, i) => {
      const result = settled[i];
      return { ...record, live: result.status === "fulfilled" ? result.value : { error: "resident-view-unavailable" } };
    });
    const admissionReadback = await registry.getDeployAdmissionReadback().catch(() => null);
    const activeAdmissions = await registry.activeDeployAdmissions();
    const stagingMaintenance = await registry.getStagingMaintenanceReadback();
    return { residents: enriched, admissionReadback, activeAdmissions, stagingMaintenance };
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.signal.aborted) return await refused(503);
    // Ordinary drain leaves existing runs able to finish. Do not close their
    // per-call gate just to discover that those same runs are still active.
    const preliminary = await observe();
    if (request.signal.aborted || preliminary.activeAdmissions > 0 || !residentDeployViewsReady(preliminary.residents))
      return await refused(200, preliminary);
    const prepared = fenceAcquisitionOf(await registry.prepareDeployFenceAcquisition(id, versionId, BUILD_ID));
    if (!prepared || prepared.id !== id || prepared.phase !== "preparing")
      return json({ error: "deploy-fence-acquisition-refused", fenceReady: false }, 409);
    const observations = await observe();
    const { residents: enriched, admissionReadback, activeAdmissions } = observations;
    if (request.signal.aborted || activeAdmissions > 0 || !residentDeployViewsReady(enriched))
      return await refused(200, observations);
    const sealed = fenceAcquisitionOf(await registry.sealDeployFenceAcquisition(id, versionId, BUILD_ID));
    if (!sealed || sealed.id !== id || sealed.phase !== "sealed") return await refused(200, observations);
    // Nothing that can stall remains between the durable seal and the ready reply.
    if (request.signal.aborted) return json({ error: "deploy-fence-acquisition-unverified", fenceReady: false }, 503);
    emitDeployAdmission({ phase: "fence-acquisition-sealed", id, workerVersion: versionId, commit: "acknowledged" });
    return json({
      ...observations,
      draining: sealed.fencedRecord,
      fenceReady: true,
      acquisition: fenceAcquisitionReceipt(sealed),
      deployDiagnostic: {
        schema: 1,
        producer: { build: BUILD_ID, workerVersion: versionId },
        fenceDisposition: "retained",
        admissionReadback: admissionReadback === null ? "unavailable" : "reported",
      },
    });
  } catch {
    return await refused(503);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

async function handleAbandonDeployFenceAcquisition(env: Env, ctx: ExecutionContext, body: unknown): Promise<Response> {
  const id = fenceAcquisitionRequestId(body);
  if (!id) return json({ error: "an exact deployment acquisition id is required" }, 400);
  const registry = registryStub(env);
  let outcome: FenceAcquisition | undefined;
  try {
    const commit = registry.abandonDeployFenceAcquisition(id, workerVersionId(env), BUILD_ID);
    ctx.waitUntil(commit.catch(() => undefined));
    outcome = fenceAcquisitionOf(await commit);
  } catch {
    try {
      outcome = fenceAcquisitionOf(await registry.readDeployFenceAcquisition(id));
    } catch {
      /* An unreadable disposition grants nothing. */
    }
  }
  const abandoned = outcome?.id === id && outcome.phase === "abandoned";
  emitDeployAdmission({
    phase: "fence-acquisition-abandon",
    id,
    workerVersion: workerVersionId(env),
    commit: abandoned ? "acknowledged" : "unverified",
    nativeOutcome: "unverified",
  });
  return json(
    {
      acquisition: outcome?.id === id ? fenceAcquisitionReceipt(outcome) : null,
      ...(!abandoned ? { error: "deployment acquisition is not confirmed abandoned" } : {}),
    },
    abandoned ? 200 : 409,
  );
}

async function handleReadDeployFenceAcquisition(env: Env, url: URL): Promise<Response> {
  const id = url.searchParams.get("id");
  if (!validFenceAcquisitionId(id) || url.searchParams.size !== 1)
    return json({ error: "an exact deployment acquisition id is required" }, 400);
  const outcome = fenceAcquisitionOf(await registryStub(env).readDeployFenceAcquisition(id));
  return outcome?.id === id
    ? json({ acquisition: fenceAcquisitionReceipt(outcome) })
    : json({ error: "deployment acquisition is unverified", acquisition: null }, 409);
}

async function handleDeployFenceRecovery(env: Env, url: URL): Promise<Response> {
  const registry = registryStub(env);
  const released = url.searchParams.get("released");
  const respond = (
    status: number,
    output: Record<string, unknown>,
    recordSha256?: string,
    refusalClass: "invalid-record-hash" | "receipt-unavailable" | "quote-unavailable" | null = null,
  ) => {
    emitDeployAdmission({
      phase: "fence-recovery-read",
      observedAt: systemClock(),
      workerVersion: workerVersionId(env),
      operation: released === null ? "quote" : "receipt",
      recordSha256,
      outcome: status === 200 ? "read" : "refused",
      httpStatus: status,
      refusalClass,
    });
    return json(output, status);
  };
  if (released !== null) {
    if (!/^[a-f0-9]{64}$/.test(released))
      return respond(400, { error: "an exact released fence hash is required" }, undefined, "invalid-record-hash");
    const receipt = await registry.readDeployFenceReleaseReceipt(released);
    return receipt
      ? respond(200, { receipt }, released)
      : respond(409, { error: "fence release receipt is unavailable" }, released, "receipt-unavailable");
  }
  const quote = await registry.getDeployFenceRecoveryQuote(workerVersionId(env));
  return quote
    ? respond(200, { quote }, quote.recordSha256)
    : respond(409, { error: "a current pre-upload fence cannot be quoted" }, undefined, "quote-unavailable");
}

/** The administrator verifies the stopped controller and native target outside the Worker.
 * Fresh idle probes and the final storage transaction still enforce the local safety facts. */
async function handleReleaseDeployFence(env: Env, body: Record<string, unknown>): Promise<Response> {
  const expected = body.expectedRecordSha256;
  const evidence = recoveryEvidenceUrl(body.evidence);
  const respond = (
    status: number,
    output: Record<string, unknown>,
    refusalClass:
      | "invalid-request"
      | "fence-or-version-changed"
      | "resident-not-idle"
      | "state-changed"
      | "commit-unverified"
      | null = null,
  ) => {
    emitDeployAdmission({
      phase: "fence-release",
      observedAt: systemClock(),
      workerVersion: workerVersionId(env),
      recordSha256: typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) ? expected : undefined,
      controllerStoppedAttested: body.controllerStopped === true,
      nativeTargetUnchangedAttested: body.nativeTargetUnchanged === true,
      outcome: status === 200 ? "released" : status === 503 ? "unverified" : "refused",
      httpStatus: status,
      refusalClass,
    });
    return json(output, status);
  };
  if (
    typeof expected !== "string" ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !evidence ||
    body.controllerStopped !== true ||
    body.nativeTargetUnchanged !== true
  )
    return respond(
      400,
      {
        error: "an exact fence hash and independent stopped-controller and unchanged-target attestations are required",
      },
      "invalid-request",
    );
  const registry = registryStub(env);
  const versionId = workerVersionId(env);
  const quote = await registry.getDeployFenceRecoveryQuote(versionId);
  if (!versionId || !quote || quote.recordSha256 !== expected)
    return respond(
      409,
      { error: "fence or actual Worker version changed; nothing released" },
      "fence-or-version-changed",
    );
  const members = await registry.list();
  const views = await Promise.allSettled(
    members.map(async (member) => ({
      ...(await residentStub(env, residentAddress(member)).getResidentDeployInfo()),
      ...(await residentStub(env, residentAddress(member)).getResidentRecoveryProbe()),
    })),
  );
  if (!recoveryViewsAreIdle(views.map((result) => (result.status === "fulfilled" ? result.value : null))))
    return respond(
      409,
      { error: "fence release requires idle owner, lifecycle and process evidence" },
      "resident-not-idle",
    );
  const evidenceSha256 = await stagingEvidenceSha256(evidence);
  let released: boolean;
  try {
    released = await registry.releaseDeployFence(expected, versionId, evidenceSha256, quote.registrySha256);
  } catch {
    emitDeployAdmission({
      phase: "fence-release-commit",
      observedAt: systemClock(),
      workerVersion: versionId,
      recordSha256: expected,
      controllerStoppedAttested: true,
      nativeTargetUnchangedAttested: true,
      commit: "unverified",
      failure: "storage-or-rpc",
    });
    const receipt = await registry.readDeployFenceReleaseReceipt(expected).catch(() => null);
    if (
      receipt?.schema !== 1 ||
      receipt.originalRecordSha256 !== expected ||
      receipt.workerVersion !== versionId ||
      receipt.evidenceSha256 !== evidenceSha256 ||
      receipt.registrySha256 !== quote.registrySha256 ||
      receipt.requestEnd !== "operator-attested" ||
      receipt.nativeOutcome !== "operator-attested-unchanged"
    )
      return respond(
        503,
        { error: "fence release outcome is unverified; inspect the original receipt without another mutation" },
        "commit-unverified",
      );
    released = true;
  }
  return released
    ? respond(200, {
        released: true,
        originalRecordSha256: expected,
        evidenceSha256,
        requestEnd: "operator-attested",
        nativeOutcome: "operator-attested-unchanged",
        drainRetained: true,
      })
    : respond(409, { error: "fence, work or maintenance changed; nothing released" }, "state-changed");
}

/** The existing Admin inventory retains its compact legacy shape. Deployment
 * readback carries a separate bounded projection of safe request provenance. */
async function handleDeployAdmissions(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.has("id")) {
    const id = url.searchParams.get("id")!;
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "invalid admission id" }, 400);
    const quote = await registryStub(env).getDeployAdmissionRecoveryQuote(id);
    return quote
      ? json({ admission: { id, ...quote } })
      : json({ error: "admission missing or cannot be quoted" }, 409);
  }
  return json({ admissions: await registryStub(env).listDeployAdmissions() });
}

/** Staging accepts the selected fixture risk without inventing an ending. */
async function handleStagingAbandonment(env: Env, body: Record<string, unknown>): Promise<Response> {
  const id = body.id;
  const expected = recoveryQuote(body.expectedStartedAt, body.expectedRecordSha256);
  const selected = stagingAttemptSchema.safeParse(body.attempt);
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || !expected || !selected.success)
    return json({ error: "an exact stored request quote and selected staging attempt are required" }, 400);
  const registry = registryStub(env);
  const held = await registry.getStagingMaintenance();
  if (
    !held ||
    !selectedStagingAttempt(held, selected.data, systemClock()) ||
    body.expectedFixtureSha256 !== held.policy.fixtureSha256 ||
    body.expectedDecisionSha256 !== held.policy.decisionSha256
  )
    return json({ error: "selected staging risk decision is unavailable" }, 409);
  const versionId = workerVersionId(env);
  if (!versionId) return json({ error: "Worker version metadata is unavailable" }, 503);
  const fence = await registry.setDeployFence(versionId, selected.data);
  if (!fence) return json({ error: "staging disposition requires a fresh selected deployment fence" }, 409);
  let committed: boolean;
  try {
    committed = await registry.abandonStagingAdmission(
      id,
      expected,
      selected.data,
      body.expectedFixtureSha256,
      body.expectedDecisionSha256,
      versionId,
    );
  } catch {
    emitDeployAdmission({ phase: "staging-risk-commit", id, observedAt: systemClock(), commit: "unverified" });
    committed = await registry
      .readStagingAbandonmentReceipt(
        id,
        expected,
        selected.data,
        body.expectedFixtureSha256,
        body.expectedDecisionSha256,
      )
      .catch(() => false);
    if (!committed) return json({ error: "staging risk decision outcome is unverified" }, 503);
  }
  if (!committed) {
    await registry.clearDeployFence(fence.since, fence.until, versionId);
    return json({ error: "stored request or staging decision changed; nothing excluded" }, 409);
  }
  return json({
    id,
    disposition: "operator-abandoned",
    requestEnd: "unobserved",
    nativeOutcome: "unverified",
    maintenance: await registry.getStagingMaintenanceReadback(),
  });
}

async function handleStagingMaintenanceRelease(env: Env, body: Record<string, unknown>): Promise<Response> {
  const quote = recoveryQuote(body.expectedStartedAt, body.expectedRecordSha256);
  const attempt = stagingAttemptSchema.safeParse(body.attempt);
  const decision = body.releaseDecisionSha256;
  if (!quote || !attempt.success || typeof decision !== "string" || !/^[0-9a-f]{64}$/.test(decision))
    return json({ error: "an exact request quote, selected attempt and fresh release decision are required" }, 400);
  const registry = registryStub(env);
  const held = await registry.getStagingMaintenance();
  if (
    !held ||
    held.state !== "held" ||
    !stagingAttemptMatches(held, attempt.data) ||
    decision === held.policy.decisionSha256
  )
    return json({ error: "selected staging release decision is unavailable" }, 409);
  const members = await registry.list();
  const settled = await Promise.allSettled(
    members.map(async (member) => ({
      ...(await residentStub(env, residentAddress(member)).getResidentDeployInfo()),
      ...(await residentStub(env, residentAddress(member)).getResidentRecoveryProbe()),
    })),
  );
  if (!recoveryViewsAreIdle(settled.map((result) => (result.status === "fulfilled" ? result.value : null))))
    return json({ error: "staging release requires idle owner, lifecycle and process evidence" }, 409);
  let released: boolean;
  try {
    released = await registry.releaseStagingMaintenance(quote, attempt.data, decision);
  } catch {
    released = await registry.readStagingReleaseReceipt(attempt.data, decision).catch(() => false);
    if (!released) return json({ error: "staging release outcome is unverified" }, 503);
  }
  if (!released) return json({ error: "staging release quote changed or another request remains" }, 409);
  return json({
    maintenance: await registry.getStagingMaintenanceReadback(),
    requestEnd: "unobserved",
    nativeOutcome: "unverified",
    uploadWindowRenewed: false,
  });
}

/** Request-ended recovery requires an independent ending receipt and idle
 * owner, lifecycle and process views before deleting one quoted record. */
async function handleRecoverAdmission(env: Env, body: Record<string, unknown>): Promise<Response> {
  const id = body.id;
  const evidence = body.evidence;
  if (body.disposition === "operator-abandoned" || body.requestEnd === "unobserved")
    return json({ error: "operator abandonment is unavailable: independently qualified containment is required" }, 409);
  if (
    (body.disposition !== undefined && body.disposition !== "request-ended") ||
    (body.requestEnd !== undefined && body.requestEnd !== "operator-attested")
  )
    return json({ error: "invalid recovery disposition" }, 400);
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return json({ error: "invalid admission id" }, 400);
  const evidenceUrl = recoveryEvidenceUrl(evidence);
  if (!evidenceUrl)
    return json({ error: "an HTTPS link to an independently verified request-end receipt is required" }, 400);
  const expected = recoveryQuote(body.expectedStartedAt, body.expectedRecordSha256);
  if (!expected) return json({ error: "a fresh admission recovery quote is required" }, 400);
  const versionId = workerVersionId(env);
  if (!versionId) return json({ error: "Worker version metadata is unavailable" }, 503);
  const registry = registryStub(env);
  const current = await registry.getDeployAdmissionRecoveryQuote(id);
  if (!current || current.startedAt !== expected.startedAt || current.recordSha256 !== expected.recordSha256)
    return json({ error: "recovery quote changed or is unavailable; nothing removed" }, 409);
  const fence = await registry.setDeployFence(versionId);
  if (!fence) return json({ error: "recovery requires an unfenced live fleet drain with upload time remaining" }, 409);
  try {
    const residents = await registry.list();
    const settled = await Promise.allSettled(
      residents.map(async (record) => ({
        ...(await residentStub(env, residentAddress(record)).getResidentDeployInfo()),
        ...(await residentStub(env, residentAddress(record)).getResidentRecoveryProbe()),
      })),
    );
    const views = settled.map((result) =>
      result.status === "fulfilled" ? result.value : { error: errMsg(result.reason) },
    );
    if (!recoveryViewsAreIdle(views))
      return json({ error: "recovery refused: resident owner, lifecycle or process evidence is not idle" }, 409);
    const bytes = new TextEncoder().encode(evidenceUrl);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const evidenceHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    let recovered: boolean;
    try {
      recovered = await registry.recoverQuotedDeployAdmission(
        id,
        fence.since,
        fence.until,
        versionId,
        evidenceHash,
        expected,
      );
    } catch {
      emitDeployAdmission({
        phase: "recovery-commit",
        id,
        workerVersion: versionId,
        observedAt: systemClock(),
        commit: "unverified",
        failure: "storage-or-rpc",
        nativeOutcome: "unverified",
      });
      recovered = await registry
        .readDeployAdmissionRecoveryReceipt(id, fence.since, fence.until, versionId, evidenceHash, expected)
        .catch(() => false);
      if (!recovered) return json({ error: "recovery outcome is unverified" }, 503);
    }
    if (!recovered) return json({ error: "recovery fence or admission changed; nothing removed" }, 409);
    console.log(`[deploy] recovered one admission ${id} after an admin-supplied independent receipt and idle probes`);
    return json({
      recovered: id,
      evidenceSha256: evidenceHash,
      originalRecordSha256: expected.recordSha256,
      disposition: "request-ended",
      requestEnd: "operator-attested",
      nativeOutcome: "unverified",
      independentObligations: "unchanged",
    });
  } finally {
    await registry.clearDeployFence(fence.since, fence.until, versionId);
  }
}

async function handleRetireNativeOperation(env: Env, body: Record<string, unknown>): Promise<Response> {
  const { resident, ...requested } = body;
  const target = nativeRetirementTargetSchema.safeParse(requested);
  const resource = parseResource(body.resource);
  if (
    !target.success ||
    "error" in resource ||
    (resident !== undefined && (!Number.isSafeInteger(resident) || Number(resident) < 1))
  )
    return json({ error: "exact terminal native scope and original journal are required" }, 400);
  const record = await registryStub(env).getRepository(resource.resource);
  const member = record
    ? selectedResidentMember(record, resident as number | undefined)
    : resident === undefined
      ? resource.resource
      : undefined;
  if (!member) return json({ error: "an active resident number is required for this repository" }, 409);
  const result = await residentStub(env, member).retireNativeOperation(target.data);
  return json(result, "error" in result ? result.status : 200);
}

async function handleRecoverNativeOperation(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  if (
    !validNativeOperationKey(body.key) ||
    typeof body.recordHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.recordHash)
  )
    return json({ error: "exact native operation key and recordHash are required" }, 400);
  if (body.terminate !== undefined && typeof body.terminate !== "boolean")
    return json({ error: "terminate must be a boolean" }, 400);
  const record = await registryStub(env).getRepository(resource.resource);
  const member = record
    ? selectedResidentMember(record, body.resident as number | undefined)
    : body.resident === undefined
      ? resource.resource
      : undefined;
  if (!member) return json({ error: "an active resident number is required for this repository" }, 409);
  const result = await residentStub(env, member).recoverNativeOperation(
    body.key,
    body.recordHash,
    body.terminate === true,
  );
  return json(result, "error" in result ? result.status : 200);
}

/** POST /reconcile (drain scope): reconcile every resident's container onto
 *  the current image — the deploy runner posts it after its Worker deploy
 *  landed and BEFORE its `/undrain`, so a stale container restarts inside the
 *  drain window (item 69's order) and never under a run the reopened fleet
 *  admits. Each resident answers what its reconcile decided and whether its
 *  fresh container was VERIFIED on the deploy's image (issue 1931); one not
 *  verified — deferred, a failed fresh probe, an error — leaves a hold on the
 *  drain, so the fleet reopens only on that container's later report. */
async function handleReconcile(env: Env, attempt?: unknown, input?: unknown): Promise<Response> {
  const target = residentImageTargetSchema.safeParse(input);
  if (!target.success || target.data.application !== `${env.RESIDENT_SCRIPT_NAME}-residentdo`) {
    console.log(
      `[reconcile] refused image target: Resident script ${env.RESIDENT_SCRIPT_NAME ?? "missing"}, application ${target.success ? target.data.application : "invalid target"}`,
    );
    return json({ error: "an exact Resident application version and image target are required" }, 400);
  }
  const registry = registryStub(env);
  const admission = await beginTrackedDeployAdmission(
    registry,
    { kind: "reconcile", component: "http", build: BUILD_ID, workerVersion: workerVersionId(env) },
    { versionId: workerVersionId(env), versionTimestamp: workerVersionTimestamp(env), attempt },
  );
  if (!admission) return json({ error: "deploy-fence: reconcile waits for the uploaded Worker" }, 409);
  try {
    const registered = await registry.listRepositories();
    for (const record of registered) {
      const pool = residentPoolOf(record);
      if (!pool || record.offboarding || pool.active === pool.members.length) continue;
      const fence = await registry.replicaMaintenance(admission.id);
      if (!fence)
        return json({ error: "replica activation waits for an exclusive deployment maintenance window" }, 409);
      const primary = residentStub(env, record.resource);
      const view = await primary.getResidentDeployInfo();
      if (view.executingRuns !== 0 || view.unknownRuns !== 0)
        return json({ error: "replica activation waits for confirmed primary quiescence" }, 409);
      let progress = await registry.importPrimaryPlacements(record.resource, pool.revision, admission.id, fence);
      while (progress.ok && !progress.done) {
        const page = await primary.placementHistoryPage(progress.after);
        const startAfter = progress.after;
        for (let offset = 0; offset < Math.max(1, page.threads.length); offset += 256) {
          progress = await registry.importPrimaryPlacements(record.resource, pool.revision, admission.id, fence, {
            ...page,
            startAfter,
            threads: page.threads.slice(offset, offset + 256),
            moreThreads: offset + 256 < page.threads.length,
          });
          if (!progress.ok) break;
        }
      }
      if (!progress.ok) {
        console.log(
          "[replica-activation] aborted: primary placement import incomplete",
          JSON.stringify({ resource: record.resource, revision: pool.revision, admission: admission.id, fence }),
        );
        return json({ error: "replica activation could not confirm complete primary placement" }, 409);
      }
    }
    const residents = (await registry.list()).filter((record) => !record.offboarding);
    const settled = await Promise.allSettled(
      residents.map(async (record) => {
        const stub = residentStub(env, residentAddress(record));
        if (record.residentId)
          await stub.ensureResidentMember(record.resource, residentAddress(record), record.provisioningTimeoutMs);
        return stub.reconcileForDeploy(record.resource, target.data);
      }),
    );
    const reconciled = residents.map((record, i) => {
      const s = settled[i];
      return s.status === "fulfilled"
        ? {
            resource: record.resource,
            ...(record.residentId ? { residentId: record.residentId } : {}),
            result: s.value.result,
            verified: s.value.verified,
          }
        : {
            resource: record.resource,
            ...(record.residentId ? { residentId: record.residentId } : {}),
            result: "error" as const,
            verified: false,
            error: errMsg(s.reason),
          };
    });
    // Each resident held ITSELF before its marker (reconcileForDeploy), so no
    // report can outrun its hold; this pass is the backstop for a resident whose
    // call rejected before it could — holdDrain deduplicates, so re-holding a
    // deferred resident changes nothing.
    const unverified = reconciled.filter((r) => !r.verified).map((r) => residentAddress(r));
    if (unverified.length > 0) await registryStub(env).holdDrainFor(unverified);
    console.log(`[reconcile] deploy image reconcile: ${JSON.stringify(reconciled)}`);
    return json({ reconciled, imageTarget: target.data });
  } finally {
    await endTrackedDeployAdmission(registry, admission);
  }
}

async function handleResidents(env: Env): Promise<Response> {
  const registered = await registryStub(env).listRepositories();
  const residents = residentMembers(registered);
  const settled = await Promise.allSettled(
    residents.map((record) => residentStub(env, residentAddress(record)).getResidentInfo()),
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
    reservedCount: reservedResidentCount(registered),
    pendingReplicas: registered.reduce((count, record) => {
      const pool = residentPoolOf(record);
      return count + (pool ? pool.members.length - pool.active : 0);
    }, 0),
    repositoryCount: registered.length,
    repositories: registered
      .filter((record) => record.noResident === true)
      .map((record) => ({ ...record, live: { state: "cold", reason: "", inFlight: 0 } })),
    inFlight,
    inFlightUnknown,
    // The drain in force, or null (item 69): the deploy runner and the
    // dashboard read it here; the attach route reads the same record.
    draining: liveDrain(await registryStub(env).getDrain(), systemClock()),
    stagingMaintenance: await registryStub(env).getStagingMaintenanceReadback(),
    residents: enriched,
  });
}

async function handleStatus(env: Env, url: URL): Promise<Response> {
  const resource = parseResource(url.searchParams.get("resource"));
  if ("error" in resource) return json({ error: resource.error }, 400);

  const record = await registryStub(env).getRepository(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  if (record.noResident === true)
    return json({ state: "cold", reason: "", inFlight: 0, defaultRef: record.defaultRef });

  // Body deliberately limited to lifecycle, activity and the snapshot handle
  // — operator scope sees what a run needs (the seed's handle, execution.md
  // item 25: opaque archive ids, useless without the bucket), not config.
  // Three RPCs in one flight, not one atomic snapshot: getStatus() awaits
  // storage, and the DO may run other work in that gap, so `state`/`reason`
  // and `inFlight` can be a hair apart (and differ slightly from a /residents
  // sample taken alongside). All are best-effort current-state reads; the
  // deploy gate reads /residents. Registration is checked before any DO read.
  const selector = Object.fromEntries(url.searchParams);
  const route = await residentRouteFor(
    env,
    resource.resource,
    typeof selector.threadKey === "string" ? selector.threadKey : undefined,
    selector,
    true,
  );
  if (route instanceof Response) return route;
  const candidates = !route && selector.threadKey && record.pool ? await servingResidentIds(env, record) : [];
  const number = url.searchParams.get("resident");
  const selected = number === null ? undefined : selectedResidentMember(record, Number(number));
  if (number !== null && !selected) return json({ error: "resident number is not active" }, 404);
  const stub = residentStub(env, selected ?? route?.residentId ?? candidates[0] ?? resource.resource);
  const [status, inFlight, refresh, snapshot, memory, levels] = await Promise.all([
    stub.getStatus(),
    stub.getInFlightCount(),
    stub.getRefreshView(),
    stub.snapshotHandle(),
    stub.memoryGauge(),
    // The levels (record 0064): what the bot forwards to the plane; the
    // plane's `probe` effect is answered by exactly this read.
    stub.residentLevels().catch(() => null),
  ]);
  // Item 7: which scheduler drives the refresh cycle and, on the Workflow
  // lifecycle, the current instance with its last step and the last skipped
  // bucket; and the snapshot handle a seeded sandbox restores from (item 25).
  return json({
    state: status.state,
    reason: status.reason,
    inFlight,
    lifecycle: refresh.lifecycle,
    refresh: { instance: refresh.instance, skipped: refresh.skipped },
    snapshot,
    // Item 70: the last memory reading, so the bot and the residents page can
    // show what the resident's own gate is reading.
    memory,
    // Record 0064, record 0064: the levels and the crossing outbox on every answer.
    ...(levels ? { levels } : {}),
  });
}

/** Levels on every data-plane answer (record 0064): the document is read
 *  after the route's own work so the sample reflects it; a failed sample never
 *  fails the answer — the bot forwards nothing that call. */
async function withLevels<T>(
  stub: ReturnType<typeof residentStub>,
  pending: Promise<T>,
): Promise<{ result: T; levels: ResidentLevelsDoc | null }> {
  const result = await pending;
  const levels = await stub.residentLevels().catch(() => null);
  return { result, levels };
}

// -- thread data plane handlers -----------------------------------------------

async function readRecordedCheckSource(env: Env, selector: CheckSelector): Promise<CheckSourceRead> {
  if (!env.STATE_WORKER_URL || !env.MEMORY_TOKEN || !checkSelectorSchema.safeParse(selector).success)
    return { kind: "unavailable" };
  try {
    const storageRequest = await prepareStorageRequest("/runs/check-source", { storeKey: RUN_STORE_KEY, selector });
    return await storageTransport(
      storageRequest,
      {
        url: new URL("/runs/check-source", env.STATE_WORKER_URL),
        headers: { authorization: `Bearer ${env.MEMORY_TOKEN}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
        timeoutMs: RUN_STORE_TIMEOUT_MS,
        exceptionDetails: false,
        fetch,
      },
      async (response) =>
        response.ok ? checkSourceReadOf(await response.json(), selector) : { kind: "unavailable" as const },
    );
  } catch {
    return { kind: "unavailable" };
  }
}

async function handleRecordedCheck(env: Env, body: unknown, settle: boolean): Promise<Response> {
  const selector = checkSelectorSchema.safeParse(body);
  if (!selector.success) return json({ kind: "unavailable", reason: "identity" }, 400);
  const selected = await readRecordedCheckSource(env, selector.data);
  if (selected.kind !== "source") return json({ kind: "unavailable", reason: "source" });
  if (settle && selected.source.state !== "terminal") return json({ kind: "unavailable", reason: "live" });
  if (!settle && selected.source.result)
    return json({
      sourceHash: await checkSourceIdentityHash(selected.source),
      inspection: { kind: "known", source: "canonical", result: selected.source.result },
    });
  try {
    const route = await resolveThreadRoute(env, {
      resource: `repo:${selected.source.resource.repo}`,
      threadKey: selected.source.threadKey,
    });
    if (route instanceof Response) return json({ kind: "unavailable", reason: "source" });
    return json(await route.stub.inspectRecordedCheck(selector.data, settle, route.threadKey));
  } catch {
    return json({ kind: "unavailable", reason: "backend" });
  }
}

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
async function servingResidentIds(env: Env, record: ResidentRecord): Promise<string[]> {
  const members = residentMembers([record]).filter((member) => member.keepWarm !== false);
  const views = await Promise.all(
    members.map(async (member) => {
      const stub = residentStub(env, residentAddress(member));
      try {
        const [status, levels] = await Promise.all([stub.getStatus(), stub.residentLevels()]);
        return { status, levels };
      } catch (err) {
        console.log(
          `resident-capacity: ${record.resource} member ${residentAddress(member)} probe failed: ${residentText(errMsg(err))}`,
        );
        return null;
      }
    }),
  );
  return members
    .filter((_member, i) => {
      const view = views[i];
      return (
        view &&
        isServiceable(view.status.state, view.status.reason) &&
        view.levels.seat.side === "below" &&
        view.levels.memory.side === "below"
      );
    })
    .map(residentAddress);
}

/** A selector is checked against durable placement before a native target is
 * resolved. Missing selectors retain the legacy primary address in this release. */
async function residentRouteFor(
  env: Env,
  resource: string,
  threadKey: string | undefined,
  selector: unknown,
  discover = false,
): Promise<ResidentRoute | undefined | Response> {
  const route = residentRouteOf(selector);
  if (route === null) return json({ error: "invalid resident address" }, 400);
  if (!route) {
    if (!threadKey) return undefined;
    const saved = await registryStub(env).readThreadPlacement(resource, threadKey);
    if (saved === null) return json({ error: "resident placement could not be verified" }, 409);
    if (saved && saved.residentId !== resource) {
      if (discover) return { residentId: saved.residentId, placementId: saved.placementId };
      return json({ error: "the saved workspace requires its resident address" }, 409);
    }
    return saved && discover ? { residentId: saved.residentId, placementId: saved.placementId } : undefined;
  }
  if (!threadKey) return json({ error: "resident address requires its thread" }, 400);
  const saved = await registryStub(env).readThreadPlacement(resource, threadKey);
  if (!saved || !sameResidentRoute(saved, route))
    return json({ error: "resident address does not match the saved placement" }, 409);
  return route;
}

async function resolveThreadRoute(
  env: Env,
  body: Record<string, unknown>,
  requireOnboarded = false,
): Promise<
  | {
      stub: ReturnType<typeof residentStub>;
      resource: string;
      threadKey: string;
      record?: ResidentRecord;
      placement?: ResidentPlacement;
    }
  | Response
> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const threadKey = parseThreadKey(body.threadKey);
  if ("error" in threadKey) return json({ error: threadKey.error }, 400);
  const route = await residentRouteFor(
    env,
    resource.resource,
    threadKey.threadKey,
    body,
    requireOnboarded && body.replicaRouting === 1,
  );
  if (route instanceof Response) return route;
  if (!requireOnboarded) {
    return {
      stub: residentStub(env, route?.residentId ?? resource.resource),
      resource: resource.resource,
      threadKey: threadKey.threadKey,
    };
  }
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  const serving =
    body.replicaRouting === 1 && record.pool && !route ? await servingResidentIds(env, record) : undefined;
  const resolved = await registryStub(env).resolveThreadPlacement(resource.resource, threadKey.threadKey, serving);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status);
  return {
    stub: residentStub(env, resolved.placement.residentId),
    resource: resource.resource,
    threadKey: threadKey.threadKey,
    record: resolved.record,
    placement: resolved.placement,
  };
}

/** Map a ThreadErr union member to its HTTP response (status leaves the body). */
function threadErrResponse(result: ThreadErr): Response {
  const { status, ...rest } = result;
  return json(rest, status);
}

async function handleAttach(
  env: Env,
  body: Record<string, unknown>,
  traceparent?: string,
  nativeProtocol = false,
  requestContext?: NativeRequestContext,
): Promise<Response> {
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
  let runBudgetMs: number | undefined;
  if (body.runBudgetMs !== undefined) {
    const value = body.runBudgetMs;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > DAY_MS)
      return json({ error: "invalid run budget" }, 400);
    runBudgetMs = value;
  }
  const runId = body.runId;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0 || runId.length > 128))
    return json({ error: "invalid run id" }, 400);
  const ownerGen = body.ownerGen;
  if (ownerGen !== undefined && (typeof ownerGen !== "string" || ownerGen.length === 0 || ownerGen.length > 128))
    return json({ error: "invalid run generation" }, 400);
  const ownerFence = body.ownerFence;
  if (
    ownerFence !== undefined &&
    (typeof ownerFence !== "number" || !Number.isSafeInteger(ownerFence) || ownerFence <= 0)
  )
    return json({ error: "invalid run fence" }, 400);
  if (!validRunOwner(runId, ownerGen, ownerFence))
    return json({ error: "run registration requires a run id, generation and fence" }, 400);
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
  let githubDoor: { baseUrl: string; bearer: string } | undefined;
  if (body.githubDoor !== undefined) {
    const value = body.githubDoor as Record<string, unknown>;
    if (!value || typeof value !== "object" || typeof value.baseUrl !== "string" || typeof value.bearer !== "string")
      return json({ error: "invalid Git door attach credential" }, 400);
    let url: URL;
    try {
      url = new URL(value.baseUrl);
    } catch {
      return json({ error: "invalid Git door base URL" }, 400);
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !/^sbr_[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{20,128}$/.test(value.bearer)
    )
      return json({ error: "invalid Git door attach credential" }, 400);
    githubDoor = { baseUrl: url.origin, bearer: value.bearer };
  }
  if (!readonly.readonly && !githubDoor) return json({ error: "writable attach requires a Git door run bearer" }, 403);
  let nativeBirth = false;
  const refuseBirth = (reason: "http" | "owner" | "transport", status: number | null = null) => {
    try {
      console.warn(JSON.stringify({ event: "native.birth.refused", runId, threadKey: ctx.threadKey, reason, status }));
    } catch {
      /* Diagnostics must not change the refusal. */
    }
    return json(
      {
        error: reason === "owner" ? "run birth is unconfirmed" : "run birth is unavailable",
        status: 503,
        reason: "workload-unverified",
        cause: "system",
      },
      503,
    );
  };
  if (nativeProtocol)
    try {
      if (!runId) return refuseBirth("owner");
      const storageRequest = await prepareStorageRequest("/runs/preservation-owner", {
        storeKey: RUN_STORE_KEY,
        runId,
        ownerGen,
        ownerFence,
      });
      const canonical = await storageTransport(
        storageRequest,
        {
          url: new URL("/runs/preservation-owner", env.STATE_WORKER_URL),
          headers: { authorization: `Bearer ${env.MEMORY_TOKEN}`, "content-type": "application/json" },
          signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
          timeoutMs: RUN_STORE_TIMEOUT_MS,
          exceptionDetails: false,
          fetch,
        },
        async (response) => ({
          ok: response.ok,
          status: response.status,
          view: response.ok ? await response.json() : undefined,
        }),
      );
      if (!canonical.ok) return refuseBirth("http", canonical.status);
      const view = canonical.view as {
        kind?: string;
        row?: { runId?: string; ownerGen?: string; workspaceThreadKey?: string; residentExecution?: string };
      };
      if (
        view.kind !== "live" ||
        !view.row ||
        view.row.runId !== runId ||
        view.row.ownerGen !== ownerGen ||
        view.row.workspaceThreadKey !== ctx.threadKey
      )
        return refuseBirth("owner", canonical.status);
      nativeBirth = view.row.residentExecution === "native-v1";
    } catch {
      return refuseBirth("transport");
    }
  // Post-validation, the answer streams like /exec (item 59): heartbeat
  // whitespace then ONE JSON document over HTTP 200, so an attach that waits
  // on a deps install (minutes) cannot lose the connection the way a plain
  // response does (`fetch failed` a few minutes in). A refusal
  // carries its `status` in the body; `ResidentExecutor.attach` reads it there.
  return streamHeartbeatJson(
    withLevels(
      ctx.stub,
      ctx.stub.attachThread(
        ctx.threadKey,
        refHint,
        readonly.readonly,
        want.sha,
        reuse.reuse,
        ctx.record,
        traceparent,
        reason,
        githubDoor,
        runBudgetMs,
        runId,
        ownerGen,
        ownerFence,
        nativeBirth,
        requestContext,
      ),
    ),
    ({ result, levels }) => ({
      ...(result as object),
      ...(ctx.placement ? { residentId: ctx.placement.residentId, placementId: ctx.placement.placementId } : {}),
      ...(levels ? { levels } : {}),
    }),
    (err) => catchAllErr(err),
    { route: "/attach", requestId: requestContext?.requestId },
  );
}

async function handleRunDeadline(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  const runId = body.runId;
  const ownerGen = body.ownerGen;
  const ownerFence = body.ownerFence;
  const remainingMs = body.remainingMs;
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 128)
    return json({ error: "invalid run id" }, 400);
  if (ownerGen !== undefined && (typeof ownerGen !== "string" || ownerGen.length === 0 || ownerGen.length > 128))
    return json({ error: "invalid run generation" }, 400);
  if (
    ownerFence !== undefined &&
    (typeof ownerFence !== "number" || !Number.isSafeInteger(ownerFence) || ownerFence <= 0)
  )
    return json({ error: "invalid run fence" }, 400);
  if (typeof remainingMs !== "number" || !Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > DAY_MS)
    return json({ error: "invalid remaining lease" }, 400);
  const result = await ctx.stub.updateRunDeadline(ctx.threadKey, runId, remainingMs, ownerGen, ownerFence);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

/** POST /await-restore (docs/reference/specs/execution.md item 27): the bot's
 *  one held request while the resident restores. Held server-side by the DO's
 *  waiter ledger; the answer streams like /attach (heartbeat whitespace then
 *  ONE JSON document over HTTP 200) so a restore lasting minutes cannot lose
 *  the connection. A pre-route Worker answers 404 (unknown route), which the
 *  bot reads as "this Worker predates the route" and falls back cold. */
async function handleAwaitRestore(
  env: Env,
  body: Record<string, unknown>,
  requestContext?: NativeRequestContext,
): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  const route = await residentRouteFor(
    env,
    resource.resource,
    typeof body.threadKey === "string" ? body.threadKey : undefined,
    body,
    true,
  );
  if (route instanceof Response) return route;
  return streamHeartbeatJson(
    residentStub(env, route?.residentId ?? resource.resource).awaitRestore(),
    (result) => result,
    (err) => catchAllErr(err),
    { route: "/await-restore", requestId: requestContext?.requestId },
  );
}

async function handleDetach(
  env: Env,
  body: Record<string, unknown>,
  requestContext?: NativeRequestContext,
): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  const runId = body.runId;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0 || runId.length > 128))
    return json({ error: "invalid run id" }, 400);
  const ownerGen = body.ownerGen;
  if (ownerGen !== undefined && (typeof ownerGen !== "string" || ownerGen.length === 0 || ownerGen.length > 128))
    return json({ error: "invalid run generation" }, 400);
  const ownerFence = body.ownerFence;
  if (
    ownerFence !== undefined &&
    (typeof ownerFence !== "number" || !Number.isSafeInteger(ownerFence) || ownerFence <= 0)
  )
    return json({ error: "invalid run fence" }, 400);
  // What the run pushed (item 16a), each ref through the one ref pattern
  // before it can be stored or become a git argument.
  const pushed = parsePushed(body.pushed);
  if ("error" in pushed) return json({ error: pushed.error }, 400);
  for (const entry of pushed.pushed) {
    const ref = parseRef(entry.ref, "pushed[].ref");
    if ("error" in ref) return json({ error: ref.error }, 400);
  }
  const result = await ctx.stub.detachThread(
    ctx.threadKey,
    body.force === true,
    pushed.pushed,
    runId,
    ownerGen,
    ownerFence,
    requestContext,
  );
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

function requestWorkspaceOwner(body: Record<string, unknown>): WorkspaceOwner | null {
  const owner = { runId: body.runId, ownerGen: body.ownerGen, ownerFence: body.ownerFence };
  return isWorkspaceOwner(owner) ? owner : null;
}

async function handleExec(
  env: Env,
  body: Record<string, unknown>,
  traceparent?: string,
  requestContext?: NativeRequestContext,
): Promise<Response> {
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
  const operation = body.checkOperation === undefined ? undefined : checkOperationSchema.safeParse(body.checkOperation);
  if (operation && !operation.success) return json({ error: "invalid check operation" }, 400);
  return streamThreadExec(
    withLevels(
      ctx.stub,
      ctx.stub.execThread(
        ctx.threadKey,
        body.command,
        timeoutMs,
        traceparent,
        execEnv,
        requestWorkspaceOwner(body),
        operation?.success ? operation.data : undefined,
        requestContext,
      ),
    ),
    requestContext?.requestId,
  );
}

async function handleInspectCredentials(
  env: Env,
  body: Record<string, unknown>,
  requestContext?: NativeRequestContext,
): Promise<Response> {
  try {
    const input = credentialInspectionInputSchema.safeParse(body.input);
    if (!input.success || body.resource !== `repo:${input.data.repo}`) return json(emptyCredentialInspection());
    const ctx = await resolveThreadRoute(env, body);
    if (ctx instanceof Response) return json(emptyCredentialInspection());
    const result = await ctx.stub.inspectThreadCredentials(
      ctx.threadKey,
      input.data,
      envFromRequest({ body }),
      requestWorkspaceOwner(body),
      requestContext,
    );
    return json(parseCredentialInspection(result));
  } catch {
    return json(emptyCredentialInspection());
  }
}

async function handlePublish(
  env: Env,
  body: Record<string, unknown>,
  requestContext?: NativeRequestContext,
): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (
    typeof body.repo !== "string" ||
    `repo:${body.repo}` !== ctx.resource ||
    typeof body.doorOrigin !== "string" ||
    typeof body.branch !== "string" ||
    typeof body.next !== "string" ||
    (body.old !== undefined && typeof body.old !== "string") ||
    typeof body.bearer !== "string"
  )
    return json({ error: "invalid typed publication request" }, 400);
  return streamThreadExec(
    withLevels(
      ctx.stub,
      ctx.stub.publishThread(
        ctx.threadKey,
        {
          repo: body.repo,
          doorOrigin: body.doorOrigin,
          branch: body.branch,
          next: body.next,
          ...(body.old === undefined ? {} : { old: body.old }),
          bearer: body.bearer,
        },
        requestWorkspaceOwner(body),
        requestContext,
      ),
    ),
  );
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
  correlation?: { route: string; requestId?: string },
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
        let delivery: "sent" | "client-gone" = "sent";
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        } catch {
          // stream already errored/cancelled — nothing left to deliver to
          delivery = "client-gone";
        }
        if (correlation)
          observeWorkerCompletion("resident", correlation.route, correlation.requestId, payload, delivery);
      };
      // Item 62: the streamed document is the other exit; same sanitizer.
      pending
        .then((result) => finish(sanitizeResidentBody(toPayload(result))))
        .catch((err: unknown) => finish(sanitizeResidentBody(toErrorPayload(err))));
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

/** /exec's payload mapping: a result as {stdout, stderr, exitCode, truncated};
 *  a failure as `execFailureDocument` — the one the Durable Object named, or
 *  the pending result's rejection answered as the DO would have
 *  (`threadRejectionErr`: a code-update reset the DO's own `control-reset`
 *  word, a replacement the SDK's words on a bare 409 — the word withheld on
 *  /exec alone —, anything else the typed 500), so a rejection streams its
 *  `status`, its word and its `transient`,
 *  and the client reads it like the JSON routes' answer, never as a
 *  deterministic answer over HTTP 200. */
function streamThreadExec(
  pending: Promise<{ result: Awaited<ReturnType<ResidentDO["execThread"]>>; levels: ResidentLevelsDoc | null }>,
  requestId?: string,
): Response {
  return streamHeartbeatJson(
    pending,
    ({ result, levels }) => ({
      ...("error" in result
        ? execFailureDocument(result)
        : { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated }),
      // Record 0064, record 0064: levels on every answer, the crossing outbox included.
      ...(levels ? { levels } : {}),
    }),
    (err) => execFailureDocument(threadRejectionErr(err, "/exec")),
    { route: "/exec", requestId },
  );
}

async function handleRead(
  env: Env,
  body: Record<string, unknown>,
  requestContext?: NativeRequestContext,
): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.path !== "string")
    return json({ error: "path must be a string relative to the thread worktree" }, 400);
  const requestOwner = requestWorkspaceOwner(body);
  const encoding = readEncodingOf(body);
  if (typeof encoding !== "string") return json({ error: encoding.error }, 400);
  // A stub that rejects (the DO reset under the call, a storage operation that
  // did not complete) is answered as the DO answers the same fact inside, never
  // left to the fetch handler's catch-all.
  const result = await ctx.stub
    .readThreadFile(ctx.threadKey, body.path, encoding, requestOwner, requestContext)
    .catch((err: unknown) => threadRejectionErr(err, "/read"));
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

async function handleWrite(
  env: Env,
  body: Record<string, unknown>,
  requestContext?: NativeRequestContext,
): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.path !== "string")
    return json({ error: "path must be a string relative to the thread worktree" }, 400);
  if (typeof body.content !== "string" || body.content.length > MAX_WRITE_CONTENT) {
    return json({ error: `content must be a string of at most ${MAX_WRITE_CONTENT} chars` }, 400);
  }
  const requestOwner = requestWorkspaceOwner(body);
  const result = await ctx.stub
    .writeThreadFile(ctx.threadKey, body.path, body.content, requestOwner, requestContext)
    .catch((err: unknown) => threadRejectionErr(err, "/write"));
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
async function handleOp(
  env: Env,
  body: Record<string, unknown>,
  traceparent?: string,
  requestContext?: NativeRequestContext,
): Promise<Response> {
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
  return streamOp(stub.runOp(op as "test" | "build", ref, traceparent, requestContext), requestContext?.requestId);
}

/** /op's payload mapping: results pass through; a failure streams as the typed
 *  document it is — the named error with its `status` IN the body, a pending
 *  op that rejected as the typed 500 (`catchAllErr`, so `transient` rides
 *  beside the words) — exactly as `/exec`, `/attach` and `/await-restore`
 *  stream theirs, so the client reads the status off the document by the one
 *  rule (`answeredStatus`) and judges `transient` by the one rule too
 *  (`isTransientRefusal`: a 5xx carrying it), never by the field on a 200. */
function streamOp(pending: Promise<Awaited<ReturnType<ResidentDO["runOp"]>>>, requestId?: string): Response {
  return streamHeartbeatJson(
    pending,
    (result) => result,
    (err) => catchAllErr(err, "op-failed"),
    { route: "/op", requestId },
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
  const catalog = await registryStub(env).getRepository(resource.resource);
  if (catalog?.offboarding && !READ_DEBUG_OPS.has(op))
    return json({ error: "resident pool cleanup is in progress" }, 409);
  if (body.resident !== undefined && typeof body.resident !== "number")
    return json({ error: "resident number must be an integer" }, 400);
  const selected = catalog
    ? selectedResidentMember(
        catalog,
        body.resident === undefined && op === "workload-audit" ? 1 : (body.resident as number | undefined),
      )
    : body.resident === undefined
      ? resource.resource
      : undefined;
  if (!selected) return json({ error: "an active resident number is required for this repository" }, 409);
  let threadSelection: { threadKey: string; runId: string } | undefined;
  if (op === "workload-audit" && (body.residentId !== undefined || body.placementId !== undefined))
    return json({ error: "Workload inspection uses resident numbers, not thread placement IDs." }, 400);
  if (op === "threads" && (body.threadKey !== undefined || body.runId !== undefined)) {
    const thread = parseThreadKey(body.threadKey);
    if ("error" in thread || typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId))
      return json({ error: "threads inspection requires a valid threadKey and runId" }, 400);
    threadSelection = { threadKey: thread.threadKey, runId: body.runId };
  }
  if (threadSelection) {
    try {
      return json(await residentStub(env, selected).debugThreads(threadSelection));
    } catch {
      return json({ error: "The saved shutdown report is unavailable." }, 503);
    }
  }
  const stub = residentStub(env, selected);
  switch (op) {
    case "workload-audit":
      return json(await stub.getWorkloadAudit(resource.resource, selected));
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
        ...(await createRefreshInstanceNow(env, stub, resource.resource, selected)),
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
    case "infra-streak": {
      // Fault injection for item 67: set the resident-step streak's count, so
      // one real failure lands on the rung under test (recreate at 3, down at 5).
      const count =
        typeof body.count === "number" && Number.isInteger(body.count) && body.count >= 0 ? body.count : null;
      if (count === null) return json({ error: "count must be a non-negative integer" }, 400);
      return json(await stub.debugSetInfraStreak(count));
    }
    case "break-mirror":
      // Fault injection for item 67: remove the mirror's objects, so the next
      // cycle's fetch fails in a resident step — a corrupt disk, which the
      // ladder's recreate restores from the snapshot. Test residents only.
      return json(await stub.debugBreakMirror());
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
    case "native-operations": {
      if (body.cursor !== undefined && !validNativeOperationKey(body.cursor))
        return json({ error: "cursor must identify a native operation" }, 400);
      return json(await stub.getNativeOperations(body.cursor as string | undefined));
    }
    case "inspect-dependencies":
      return json(await stub.inspectThreadDependencies(body.input));
    case "discard-absent-binding":
      return json(await stub.discardAbsentBinding(body.input));
    case "inspect-preservation":
      return json(await stub.inspectThreadPreservation(body.input));
    case "reconcile-owner": {
      const thread = parseThreadKey(body.threadKey);
      if ("error" in thread) return json({ error: thread.error }, 400);
      try {
        const result = await stub.reconcileRetainedOwner(thread.threadKey);
        return "error" in result ? threadErrResponse(result) : json(result);
      } catch {
        return json({ error: "owner-reconciliation-refused: evidence-unreadable" }, 503);
      }
    }
    case "deps-backups":
      return json(await stub.debugDepsBackups());
    case "sweep-now": {
      const result = await stub.debugSweepNow();
      return json(result, "error" in result ? result.status : 200);
    }
    case "reclaim-now": {
      const result = await stub.debugReclaimNow();
      return json(result, "error" in result ? result.status : 200);
    }
    case "purge-bindings": {
      // Item 56: drop a load run's evicted synthetic bindings. `prefix` is
      // validated by the pure decision (a whole non-production namespace).
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      const r = await stub.debugPurgeBindings(prefix);
      return "error" in r ? json({ error: r.error }, 400) : json(r);
    }
    case "measure-disk": {
      // Item 55: take the sample now (df + one du) and answer it — the live
      // check's way to read the gauge without waiting for a cycle.
      const disk = await stub.debugMeasureDisk();
      return disk && "error" in disk ? json(disk, disk.status) : json({ disk });
    }
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
  // An empty installation has no work to admit. Keep its Registry untouched
  // so restoration can install saved registrations before lifecycle work starts.
  if (!(await registry.list()).some((record) => !record.offboarding))
    return { cap: (await registry.limits()).cap, count: 0, results: [] };
  const admission = await beginTrackedDeployAdmission(registry, {
    kind: "watchdog",
    component: parent ? "scheduler" : "http",
    traceId: parent?.traceId,
    build: BUILD_ID,
    workerVersion: workerVersionId(env),
  });
  if (!admission) throw new Error("deploy-fence: watchdog work is paused during Worker upload");
  try {
    const residents = (await registry.list()).filter((record) => !record.offboarding);
    // Each check is a `resident.check` child of the firing's root when it has
    // one (the cron path; the /debug op runs bare), ending with the action taken
    // — never the resource, which names a repo.
    const checkOne = async (record: ResidentMember<ResidentRecord>, span?: TraceSpan) => {
      const stub = residentStub(env, residentAddress(record));
      if (record.residentId)
        await stub.ensureResidentMember(record.resource, residentAddress(record), record.provisioningTimeoutMs);
      const check = await stub.watchdogCheck();
      if (check.action === "provision-timed-out") {
        // The DO already tried to release its own slot; this is the backstop.
        if (!record.pool) await registry.remove(record.resource);
      }
      const instance = await createRefreshInstance(
        env,
        stub,
        record.resource,
        record.keepWarm ? { ...check.refresh, idleSince: null } : check.refresh,
        residentAddress(record),
      );
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
            memory: s.value.memory,
            instance: s.value.instance,
          }
        : { resource: record.resource, error: errMsg(s.reason) };
    });
    return { cap: (await registry.limits()).cap, count: residents.length, results };
  } finally {
    await endTrackedDeployAdmission(registry, admission);
  }
}

function json(data: unknown, status = 200): Response {
  // Item 62: every non-streamed body leaves through here; its `error`,
  // `reason` and `summary` strings are made safe at the exit.
  return new Response(JSON.stringify(sanitizeResidentBody(data)), {
    status,
    headers: { "content-type": "application/json" },
  });
}
