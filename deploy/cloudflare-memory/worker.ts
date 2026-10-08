import { originalPromotionArchiveKey } from "../../src/core/runLedger/workspaceDurability.ts";
import { storeRequestWitness } from "../../src/core/storeResponse.ts";
import {
  STATE_WRITE_DIAGNOSTIC_HEADER,
  StateWriteBoundaryError,
  stateWriteException,
  stateWriteReplyShape,
} from "../../src/core/runStateWriteDiagnostic.ts";
import { isConfigPublicationSnapshotKey, type ConfigSourcePrecondition } from "../../src/configPublicationProtocol.js";
import { DO_MAX_BOUND_PARAMETERS, RUN_EVENT_INSERT_BATCH } from "../../src/memorySqlLimits.js";
import {
  SOURCE_SEED_RECORD_PREFIX,
  sourceSeedOriginalKey,
  sourceSeedOriginalOf,
  sourceSeedReferenceOfReceipt,
  type SourceSeedOriginalRecord,
} from "../../src/core/runLedger/seedVerification.ts";
import { bindInboxCustody } from "../../src/core/runLedger/inboxMessage.ts";
import {
  sourceSeedReleaseOf,
  confirmStoredSeedBoundary,
  promotionConfirmationRow,
  type SourceSeedReleaseReceipt,
  type PromotionConfirmationResult,
  sourceSeedReferenceOf,
  sourceSeedReceiptOf,
  authenticatedSeedExpectation,
  verifiedSourceSeedHashes,
  sourceSeedReferenceMatches,
  SourceSeedPendingError,
  type SourceSeedReference,
  type SourceSeedReceipt,
  type SourceSeedResult,
  type SourceSeedSnapshot,
} from "../../src/core/runLedger/seedVerification.ts";
import {
  decodeExpectedSeedHeader,
  EXPECTED_SEED_HEADER,
  requestHeaderBytes,
  WORKER_REQUEST_HEADER_BYTES,
  expectedSeedManifestOf,
  expectedSeedMatchesClaim,
  seedContentHash,
  canonicalSeedJson,
  type ExpectedSeedManifest,
} from "../../src/core/runLedger/seedManifest.ts";
import { allocationAckFromCanonical } from "../../src/core/runLedger/allocationAck.js";
import {
  promotionBodyOf,
  promotionBodyHash,
  promotionBytes,
  promotionMatchesOriginal,
  promotionPending,
  promotionReceiptFromRow,
  preparedPromotionClaim,
  promotionCommitFromRow,
  promotionCommittedRowMatches,
  PromotionPendingError,
  PROMOTION_BODY_BYTES,
  type PromotionPrepareResult,
  type PromotionReadRequest,
  type PromotionReadResult,
} from "../../src/core/runLedger/promotion.js";
import {
  validMaintenanceTransport,
  sameMaintenanceTransport,
  maintenanceEventsMatch,
  preserveMaintenanceEvent,
} from "../../src/core/coordinator/maintenanceIdentity.js";
import { terminalPublicationRetentionRequired } from "../../src/core/branchPublication.ts";
import { intakePointOf } from "../../src/core/intakeMetrics.js";
import { branchPublicationOf, doorPublicationOf } from "../../src/core/branchPublication.js";
import { reviewPublicationOf } from "../../src/core/reviewPublication.js";
import {
  isMaintenanceAdmissionInput,
  prepareMaintenanceAdmission,
  planMaintenanceAdmission,
  type MaintenanceAdmissionInput,
  type MaintenanceAdmissionResult,
} from "../../src/core/coordinator/maintenanceAdmission.js";
import {
  terminalWorkspaceSettlement,
  terminalThreadKey,
  terminalWorkspaceRecordMatches,
  nextWorkspaceRevision,
  WORKSPACE_SETTLEMENTS_MAX,
  workspaceSettlementOf,
  workspaceOwnerKey,
  workspaceAcknowledgment,
  isWorkspaceOwner,
  type WorkspaceOwner,
  type AcknowledgedWorkspaceOwner,
  type WorkspaceSettlement,
  type WorkspaceAck,
} from "../../src/core/workspaceSettlement.js";
import type { UnitSeedReceipt } from "../../src/core/coordinator/unitSeedReceipt.js";
import {
  coordinatorReconciliationEffect,
  coordinatorWorkflowCanReconcile,
  coordinatorExecutionWasStarted,
  isCoordinatorReconcileEffect,
  isCoordinatorReconcileReceipt,
  type CoordinatorReconcileReceipt,
  type CoordinatorReconcileEffect,
} from "../../src/core/coordinator/workflowReconciliation.js";
import {
  readCoordinatorReport,
  coordinatorReportAdmission,
  sameCoordinatorReportAdmission,
  sameCoordinatorReportOwner,
} from "../../src/core/coordinator/reportContext.js";
import {
  coordinatorPublicDeliveryReference,
  readCoordinatorPublicDelivery,
} from "../../src/core/coordinator/reportPublicDelivery.js";
import { readCoordinatorStatus } from "../../src/core/coordinator/unitStatus.js";
import { coordinatorReportCanReconcile } from "../../src/core/coordinator/reportReconcileEligibility.js";
import { isCoordinatorReportAdmission } from "../../src/core/coordinator/reportAdmission.js";
import { privateWorkerThreadKey } from "../../src/core/privateWorkerLog.js";
import { isInstanceNotFound } from "../../src/core/coordinator/instancesRoute.js";
import { isPersonalToken } from "../../src/core/personalToken.js";
import { preserveCheckpointState } from "../../src/core/runLedger/checkpointState.js";
import {
  checkpointMembersOf,
  checkpointMemberHashesOf,
  ORDINARY_CONTEXT_HISTORY_RUNS,
  planContextCheckpoint,
  validateContextCheckpoint,
  isContextCheckpointReceipt,
  applyContextCheckpoint,
  applyContextCheckpointAliases,
  type CanonicalCheckpointSource,
  type ContextCheckpointReceipt,
  type ContextCheckpointRequest,
  type ContextCheckpointResult,
} from "../../src/core/references/contextCheckpoint.js";
import {
  contextDependenciesHash,
  contextDependenciesContain,
  mergeContextDependencies,
} from "../../src/core/references/contextDependencies.js";
import { assembleTranscript } from "../../src/core/runLedger/transcript.js";
import {
  workspaceAllocationOf,
  workspaceDurabilityArchiveOf,
  workspaceDurabilityKey,
  sameWorkspaceAllocation,
  allocationMatchesRecord,
  allocationMatchesRun,
  prepareWorkspaceAllocation,
  workspaceAuthorityFieldsPresent,
  deriveWorkspaceDisposition,
  workspaceCustodyFingerprint,
  workspaceReportRowsMatch,
  workspaceEffectNeedsCustody,
  custodyPinRevisionOf,
  custodyPinProtectionOf,
  nextCustodyPinRevision,
  sameWorkspaceCustody,
  type CustodyPinRevision,
  isCustodyRangePins,
  type WorkspaceAllocation,
  type WorkspaceDispositionRead,
  type WorkspaceDurabilityArchive,
  type StoredWorkspaceCustody,
} from "../../src/core/runLedger/workspaceDurability.js";
import {
  handoffRangePins,
  sessionRangesAvailable,
  sessionRowIsPinned,
  type SessionRangePin,
  type SessionRangePins,
} from "../../src/core/runLedger/sessionRangePins.js";
import { uncoveredSourceResult, verifiedSourceResults } from "../../src/core/references/sourceResultContext.js";
import {
  isContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "../../src/core/references/contextDependencies.js";
import { contextReferencesOf, type ContextReference } from "../../src/core/runLedger/contextRetention.js";
import { isChildHandoff, type ChildHandoff } from "../../src/core/dispatch/handoff.js";
import {
  type SessionSources,
  type SessionSourceOwner,
  appendSessionContext,
  sourceHash,
  taintSessionSources,
  isSessionSources,
  mergeSessionSources,
  sourcesBelongToSession,
} from "../../src/core/references/receipts.js";
import { DurableObject } from "cloudflare:workers";
import { parsePrivateWorkerThreadKey } from "../../src/channels/privateWorker.ts";
import {
  isPrivateWorkerEventInput,
  type PrivateWorkerEvent,
  type PrivateWorkerEventInput,
} from "../../src/core/privateWorkerLog.ts";
import type { MemoryCandidate, MemoryRecord } from "../../src/core/memory/types.ts";
import { isMemoryProvenance } from "../../src/core/memory/provenance.ts";
import {
  DEFAULT_SCOPE_CAP,
  mintRecord,
  normalizeText,
  planEviction,
  planWrite,
  rankRecords,
  rejectionMarkers,
} from "../../src/core/memory/engine.ts";
import { tokenize } from "../../src/core/memory/scorer.ts";
import { FIRING_DETAIL_MAX, isScheduleFiring, type ScheduleFiring } from "../../src/core/schedules.ts";
import { isCostsSnapshot, type CostsSnapshot } from "../../src/core/costsSnapshotStore.ts";
import { REPO_SLUG } from "../../src/core/delivery.ts";
import {
  isDeliverySnapshot,
  isDeliverySnapshotPatch,
  type DeliverySnapshot,
  type DeliverySnapshotPatch,
} from "../../src/core/deliverySnapshotStore.ts";
import {
  applyRetention,
  clampRetentionPolicy,
  isRunRecord,
  branchPushReceiptsOf,
  workEvidenceBelongsToRun,
  isRunWorkOwner,
  type RunWorkOwner,
  isRunListItem,
  isRecoveryEvidenceScope,
  isRunSession,
  isRunVisibilityFilter,
  normalizeStored,
  pullRequestNumberOf,
  RETENTION_BOUNDS,
  RUN_EVENTS_DEFAULT_PAGE,
  RUN_EVENTS_MAX_PAGE,
  MAX_RECORD_BYTES,
  RUN_ID_PATTERN,
  clampListLimit,
  RUN_LIST_MAX_LIMIT,
  sameStoredVersion,
  SESSION_KEY_PATTERN,
  storedEventSeqs,
  utf8ByteLength,
  MAX_EVENT_BYTES,
  type RetentionPolicy,
  type RunListItem,
  type RunListOptions,
  type RunRecord,
  type RunVisibilityFilter,
  type StoredRunEvent,
} from "../../src/core/runRecord.ts";
import {
  attachmentRefsOf,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  droppedToolResultRow,
  GAP_MARKER,
  NOTEPAD_MAX_BYTES,
  planSessionTrim,
  storedRowRequiresFreshSources,
  roleOfStoredRow,
  rowKind,
  SEARCH_MAX_HITS,
  sessionsToDrop,
  keyedAppendContextMatches,
  tailCut,
  textOfStoredRow,
  logicalThreadOfSession,
  contextThreadSessionKey,
} from "../../src/core/runLedger/sessionLog.ts";
import { mergeRequesterTarget, type RequesterTarget } from "../../src/core/runLedger/ledger.ts";
import type { RunEvent } from "../../src/core/runEvents.ts";
import {
  prepareHistoricalNativeAudit,
  historicalOwnerEvent,
  isHistoricalOwnerEvent,
  isHistoricalOwnerRecord,
  HISTORICAL_AUTHORITY_EVENT_TYPES,
  HISTORICAL_AUTHORITY_EVENT_FIELDS,
  type HistoricalOwnerEvent,
  type HistoricalOwnerRecord,
  type HistoricalAuditInput,
  type HistoricalNativeAudit,
} from "../../src/core/coordinator/historicalNativeAudit.ts";
import {
  isRunUsage,
  usageOfEvents,
  type RunUsage,
  type RunUsageRows,
  type UsageIdentity,
  type UsageRun,
} from "../../src/core/runUsage.ts";
import {
  assignLedgerLiveState,
  checkFence,
  decideClaim,
  decideClaimWrite,
  decideIntakeInsert,
  phaseTransition,
  reclaimPhase,
  selectReclaim,
  unreadInbox,
} from "../../src/core/runLedger/decisions.ts";
import {
  closeInboxSegment,
  encodeInboxSegment,
  inboxSegmentFloor,
  INBOX_SEGMENT_ARCHIVE_STEP,
} from "../../src/core/runLedger/inboxSegment.ts";
import {
  INTAKE_DELIVERY_CLAIM_MS,
  intakeReceiptRetentionMs,
  minutesToMs,
  PLANE,
  RANGE_PIN_RPC_SLOW_MS,
} from "../../src/core/budgets.ts";
import { PROVIDER_FAILURE_CAUSES, type ProviderFailureCause } from "../../src/core/provider.ts";
import { holdBackgroundTask } from "./backgroundTasks.ts";
import {
  causeOfClose,
  causeOfReclaim,
  decide,
  effectCapRefusal,
  planeAskAnswerOf,
  planeAskWordOf,
  RESIDENT_DRAIN_WINDOW,
  type PlaneEndingCause,
  type PlaneReclaimWord,
  type HeartbeatFacts,
  type PlaneAskAnswer,
  type PlaneLevelRow,
  type PlaneAckOutcome,
  type PlaneEffect,
  type PlaneEvent,
  type PlaneOutcomePost,
  type PlaneQueueRow,
  type PlaneReservation,
  type PlaneStage,
  type PlaneState,
  type PlaneWrite,
} from "../../src/core/plane/decide.ts";
import {
  type PullOwnershipDiagnostics,
  type PullOwnershipCheck,
  pullOwnerReadDiagnosticFor,
  type PullOwnershipSource,
  findPullOwnersInRows,
  pullBindingChanges,
  needsPullBindingAdmission,
  unitPullBindingRefusal,
  unitPullTargetsRefusal,
  type PullBindingRefusal,
  isPullTarget,
  isPullOwnerLiveMeta,
  PULL_OWNER_SCAN_MAX,
  PULL_OWNER_SCAN_MAX_BYTES,
  type PullTarget,
  type PullOwnersResult,
  type PullOwnershipRows,
} from "../../src/core/coordinator/pullOwnership.ts";
import {
  isUnitEffectTransition,
  planUnitEffectTransition,
  unitEffectRunId,
  unitEffectTombstoneMatches,
  type UnitEffectRunEvidence,
  type UnitEffectTransition,
  type UnitEffectTransitionResult,
} from "../../src/core/coordinator/unitEffect.ts";
import { mergePlaneFindings, planeFindingKey, type PlaneFinding } from "../../src/core/plane/findings.ts";
import {
  IDEMPOTENCY_KEY_PATTERN,
  capThreadEvent,
  INSTANCE_ID_PATTERN,
  isMainTaskKey,
  isMainTaskBinding,
  mainTaskBindingMatches,
  mainTaskClaimMatches,
  preserveWorkBrief,
  prepareUnfencedUnitWrite,
  permitsRecoveryMetadataWrite,
  CoordinatorUnitWriteConflict,
  isCoordinatorInstance,
  isCoordinatorUnit,
  coordinatorUnitCanBeDiscarded,
  isThreadEvent,
  isUnitWakeAnswer,
  sendChildSignal,
  sendRunFinished,
  STEP_NAME_PATTERN,
  UNIT_PATTERN,
  unitOfIdempotencyKey,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type MainTaskBinding,
  type RunFinishedSend,
  type ThreadEvent,
  type UnitWakeAnswer,
} from "../../src/core/coordinator/contract.ts";
import {
  compareSlackMessageId,
  isMainTaskAuthority,
  isRequesterTurnInput,
  sameMainTaskAuthority,
  type MainTaskAuthority,
  type RequesterTurn,
  type RequesterTurnInput,
} from "../../src/core/coordinator/requesterAuthority.ts";
import {
  GEN_PATTERN,
  isIntakeReceipt,
  type ClaimRequest,
  type ClaimResult,
  type FenceResult,
  type IntakeQuery,
  type IntakeReceipt,
  type IntakeWriteResult,
  type LivePhase,
  type LiveRunRow,
  type LiveStateAssignRequest,
  type LiveStateAssignResult,
  type ReclaimedRun,
  type RunState,
  type SessionHit,
  type StepRecord,
  type StopMode,
  type TranscriptAttachment,
  type TranscriptRow,
} from "../../src/core/runLedger/types.ts";
import {
  isMcpTicket,
  isSealedCredential,
  MCP_TICKET_STATES,
  type McpTicket,
  type McpTicketState,
  type SealedCredential,
} from "../../src/mcp/registry.ts";
import { isRunMetricsPoint, pointTurnsFinal, type RunMetricsPoint } from "../../src/core/runMetrics.ts";
import { AnalyticsEngineSink, NullSink, type RunMetricsSink } from "./runMetricsSink.ts";
import { injectedBuildStamp } from "../../src/deploy/buildStamp.ts";
import {
  prepareRecoveryTransition,
  planRecoveryTransition,
  recoveryActionId,
  recoveryHistoryPage,
  isRecoveryTransition,
  isRecoveryRequest,
  isRecoveryAction,
  RECOVERY_HISTORY_LIMITS,
  recoveryBytes,
  type RecoveryTransition,
  type RecoveryTransitionResult,
  type RecoveryRequest,
  type RecoveryAction,
  type RecoveryReceipt,
  type RecoveryHistoryPage,
} from "../../src/core/coordinator/recoveryHistory.ts";
import { systemClock } from "../../src/core/trace/clock.ts";
import { createTracer } from "../../src/core/trace/tracer.ts";
import { startAdoptedRoot, workerLogSink } from "../../src/core/trace/workerTrace.ts";

/** The commit this bundle was built from, injected by the deploy
 *  (`deploy/bin/build-stamp.mjs`) and answered on GET /healthz as `build`. */
const BUILD = injectedBuildStamp();

// The Worker's own spans (docs/reference/specs/tracing.md item 22): one `state.fetch` root
// per authenticated request, joining the bot's trace, on a `slow` log sink
// whose filter drops the line a refusal would leave.
const tracer = createTracer({ clock: systemClock });
const traceSinks = [workerLogSink((line) => console.log(line))];

// Memory Worker: the durable backend behind the bot's WorkerMemoryStore
// (src/core/memory/workerStore.ts) — cross-session memory (docs/reference/specs/memory.md). One
// SQLite-backed Durable Object per scopeKey (the DO name IS the scope key), so
// a scope's records live in one database that survives every bot restart
// (AGENTS.md invariant 6) and cross-scope reads are impossible by construction.
//
// The ranking and dedup/supersede rules are NOT reimplemented here: this file
// imports the pure engine from src/core/memory/ by relative path (bundled by
// wrangler), so the durable store and the in-process store run one algorithm.
// SQLite's job is persistence plus an FTS5 candidate prefilter; the engine
// re-checks whole-token relevance and orders by keyword+recency.
//
// Route surface (JSON in/out; bearer MEMORY_TOKEN on everything but /healthz):
//   POST /retrieve {scopeKey, query, limit} → {records: MemoryRecord[]}
//   POST /write    {scopeKey, records: MemoryCandidate[]} → {ok, inserted, deduped, restated, superseded, evicted}
//   POST /sweep    {scopeKey, dryRun?} → {ok, swept} (+ ids under dryRun — the marked rows, flipped to `swept`)
//   GET  /healthz  → {ok:true}  (deploy wake ping; touches no DO)
// Scheduled-firing routes (the record behind the /runs Scheduled panel;
// written by the bot's Worker shim after every cron firing, read by the bot's
// WorkerScheduleStore, src/core/scheduleStore.ts): ONE ScheduleDO, bounded per schedule.
//   POST /schedules/record {firing: ScheduleFiring} → {ok:true, retained}
//   POST /schedules/latest {}                       → {firings: ScheduleFiring[]} (newest per schedule)
// Run history routes (the durable RunStore behind the bot's WorkerRunStore,
// src/core/runStoreWorker.ts; docs/reference/specs/run-history.md): one RunHistoryDO per
// store key, owning the retention policy. Same bearer; /runs/put has its own 2 MiB
// body fence (a record is budgeted to 1.5 MiB upstream), every other route
// keeps the 512 KB one.
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?, point?} → {ok, retained, stored, rewritten}
//   POST /runs/get    {storeKey, id} → {record: RunRecord | null}      (unknown/expired: null, 200)
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?, threadKey?, parentRunId?}
//                       → {items: RunListItem[], nextBefore?: {finishedAt, id}}   (cursor = the last row's list key)
//   POST /runs/events {storeKey, id, afterSeq?, limit?} → {events: (RunEvent & {seq})[] | null, nextAfterSeq?}
//                       (`events: null` when the run is unknown or hidden by retention; `seq` is the registry's stamp)
//   POST /runs/delete {storeKey, id} → {ok: true, deleted}
//   GET  /healthz → {ok: true, build: {commit, builtAt?}, features: ["memory", "schedules", "runs", "config"]}
//
// SECURITY: bearer comparison is constant-time (same helper as the resident
// Worker); an unset/empty secret grants nothing (fail closed); every body field
// is validated with size caps before it reaches storage.

export interface Env {
  MEMORY: DurableObjectNamespace<MemoryDO>;
  /** Scheduled firings: ONE ScheduleDO (named "schedules") — the record behind the /runs Scheduled panel. */
  SCHEDULES: DurableObjectNamespace<ScheduleDO>;
  /** Run history: one RunHistoryDO per store key (`runs:default`). */
  RUNS: DurableObjectNamespace<RunHistoryDO>;
  /** Runtime config documents (routing-and-config item 12): ONE ConfigDO (named "config"). */
  CONFIG: DurableObjectNamespace<ConfigDO>;
  /** Live-run transcripts of runs claimed before the session log existed (run-history
   *  item 32): one RunTranscriptDO per such run, named by run id. New runs never write here. */
  RUN_TRANSCRIPTS: DurableObjectNamespace<RunTranscriptDO>;
  /** Session logs (docs/reference/specs/session-log.md): one SessionLogDO per thread and
   *  agent, named `<threadKey>:<agent>` — every run of the session appends its rows. */
  SESSION_LOGS: DurableObjectNamespace<SessionLogDO>;
  /** Delivery snapshots (delivery item 10): ONE DeliveryDO (named "delivery"), one snapshot per repository. */
  DELIVERY: DurableObjectNamespace<DeliveryDO>;
  /** The costs snapshot (costs item 6): ONE CostsSnapshotDO (named "costs"), one snapshot per installation. */
  COSTS: DurableObjectNamespace<CostsSnapshotDO>;
  /** The ship coordinator Workflow in the bot's shim Worker (run-history item
   *  47): where `RunHistoryDO.finish` sends `run-finished-<runId>` for a record
   *  carrying `parentInstanceId`. Optional: this Worker deploys without it (the
   *  binding is a cross-script one, and the class must exist on the bot before
   *  the state Worker may name it), and a finish then commits with no event. */
  SHIP_COORDINATOR?: Workflow;
  /** The run-metrics dataset (docs/reference/specs/run-metrics.md): where the
   *  RunHistoryDO writes one point per run whose row turned final. Optional
   *  like SHIP_COORDINATOR: this Worker deploys without it and every answer is
   *  byte-identical — the NullSink swallows the points. */
  RUN_METRICS?: AnalyticsEngineDataset;
  /** The dataset's name, rendered beside the binding, so `/healthz` can answer
   *  `runMetrics:<dataset>` and the bot's boot probe can compare names. */
  RUN_METRICS_DATASET?: string;
  /** Scheduled physical history cleanup. Paused by default; live plane alarms still run. */
  RUN_HISTORY_MAINTENANCE?: "enabled" | "paused";
  /** The bot Worker, for the plane's effect push (record 0064, "Where it
   *  lives"): committed effects are POSTed to its bearer-gated
   *  `/plane/effects`, which forwards to the container. Optional like
   *  SHIP_COORDINATOR — without it effects ride the heartbeat answers alone. */
  BOT?: Fetcher;
  MEMORY_TOKEN?: string;
}

/** The single DeliveryDO's name — every repository's snapshot lives in one object. */
const DELIVERY_OBJECT = "delivery";

/** The single CostsSnapshotDO's name — the installation has one costs snapshot. */
const COSTS_OBJECT = "costs";

/** The single ConfigDO's name. */
const CONFIG_OBJECT = "config";
/** A config document key: short, lowercase, like `overrides`. */
const CONFIG_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** The single ScheduleDO's name — every schedule's firings live in one object. */
const SCHEDULES_OBJECT = "schedules";

/** Retrieval limit ceiling (the bot's default is 8). */
const MAX_LIMIT = 50;
/** Candidates per write batch (the reflection pass emits ≤6). */
const MAX_BATCH = 50;
/** Unit rows one put may carry: a plan has tens of units, never hundreds. */
const MAX_UNITS_PER_PUT = 200;
const MAX_TEXT_CHARS = 4000;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_CHARS = 64;
const MAX_QUERY_CHARS = 4000;
const MAX_KEY_CHARS = 200;
/** FTS candidate pool per retrieval: ~5× the requested limit gives the engine's
 *  re-rank slack to disagree with bm25, and the floor hands the engine EVERY
 *  match in a scope with ≤50 hits — small scopes rank exactly as the engine
 *  alone decides. Was a flat 500 recency-ordered rows; ordering candidates by
 *  bm25 instead means a relevant-but-old record can no longer be starved out
 *  of the pool by recent weak matches. */
const FTS_CANDIDATES_PER_LIMIT = 5;
const FTS_CANDIDATES_FLOOR = 50;
/** MATCH terms per query: the N longest distinct tokens (ties by first
 *  appearance). A 4000-char query would otherwise become a several-hundred-term
 *  OR the FTS index must union on every retrieval; longer tokens are the
 *  selective ones — the `[a-z0-9]+` tokenizer's 1–3-char tokens are mostly
 *  stopwords ("a", "the", "to"). Realistic queries have far fewer distinct
 *  tokens and are untouched; the engine still ranks with the FULL query, so the
 *  cap only shapes which rows can become candidates. */
const MAX_MATCH_TOKENS = 24;
/** A `recall` query's size and the most hits one answers (session-log item 10):
 *  a query is a few words, and the tool's default is five. */
const MAX_SEARCH_QUERY_BYTES = 1_024;
/** Request body ceiling, checked against Content-Length before parsing. A full
 *  batch (50 × 4000-char texts + keywords + envelope) fits comfortably. */
const MAX_BODY_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Durable Object: one per scopeKey
// ---------------------------------------------------------------------------

/** A stored row. `keywords` is JSON text; nullable optionals are NULL. (A type
 *  alias, not an interface: SqlStorage's row constraint needs the implicit
 *  index signature only aliases get.) */
type Row = {
  id: string;
  seq: number;
  scope_key: string;
  kind: string;
  text: string;
  keywords: string;
  source_thread_key: string;
  source_run_id: string | null;
  provenance_json: string | null;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  confidence: number | null;
  supersedes: string | null;
  status: string;
};

export class MemoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent schema — CREATE … IF NOT EXISTS is this DO's one migration
    // path, re-applied on every start and safe over live data. `norm` is the
    // dedup key (normalizeText) so a dedup lookup is an indexed hit;
    // records_active_seq serves list()'s newest-first page and
    // records_active_used the status-prefixed scans (active count, eviction
    // fetch); records_fts holds text + keywords for the
    // whole-token candidate prefilter (unicode61 tokenizer ≈ the engine's
    // tokenize; the engine re-verifies every hit).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        norm TEXT NOT NULL,
        keywords TEXT NOT NULL,
        source_thread_key TEXT NOT NULL,
        source_run_id TEXT,
        provenance_json TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        supersedes TEXT,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_status_norm ON records(status, norm);
      CREATE INDEX IF NOT EXISTS records_active_seq ON records(status, seq DESC);
      CREATE INDEX IF NOT EXISTS records_active_used ON records(status, last_used_at DESC, created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, body);
    `);
    if (
      !this.sql
        .exec<{ name: string }>(`PRAGMA table_info(records)`)
        .toArray()
        .some((column) => column.name === "provenance_json")
    ) {
      this.sql.exec(`ALTER TABLE records ADD COLUMN provenance_json TEXT`);
    }
    this.reconcileFts();
  }

  /** Reconcile records_fts down to exactly the active rows. Forget, supersede,
   *  and evict delete their FTS entry inline; this is the one-time cleanup of
   *  the dead rows older deploys left behind, kept on every start as a
   *  self-healing invariant. Idempotent, and O(active rows) once clean (the
   *  scan is over the FTS table, which then holds only active rows — bounded by
   *  the scope cap), so it stays cheap forever. Returns rows removed. */
  reconcileFts(): number {
    return this.sql.exec(`DELETE FROM records_fts WHERE id NOT IN (SELECT id FROM records WHERE status = 'active')`)
      .rowsWritten;
  }

  /** Rank the scope's active records for `query` (engine rules), bump usage on
   *  the returned ones, return them. */
  async retrieve(scopeKey: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const match = ftsMatchExpr(query);
    if (match === null) return [];
    // Candidates ordered by bm25 (best match first — fts5's bm25() is
    // more-negative-is-better, so ascending), NOT by recency: recency ordering
    // let recent weak matches starve a relevant-but-old record out of the pool
    // before the engine ever saw it. bm25 only chooses which rows reach the
    // engine; the shared rankRecords still decides the final order — one
    // algorithm with the in-process store.
    const rows = this.sql
      .exec<Row>(
        `SELECT r.* FROM records r
           JOIN records_fts f ON f.id = r.id
          WHERE r.status = 'active' AND records_fts MATCH ?
          ORDER BY bm25(records_fts)
          LIMIT ?`,
        match,
        Math.max(FTS_CANDIDATES_FLOOR, limit * FTS_CANDIDATES_PER_LIMIT),
      )
      .toArray();
    const now = systemClock();
    const ranked = rankRecords(rows.map(toRecord), query, now, limit);
    if (ranked.length > 0) {
      // One batched usage bump for the returned set (ids are server-minted and
      // parameterized; at most MAX_LIMIT of them), not a statement per row.
      this.sql.exec(
        `UPDATE records SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${ranked.map(() => "?").join(", ")})`,
        now,
        ...ranked.map((r) => r.id),
      );
      for (const r of ranked) {
        r.lastUsedAt = now;
        r.useCount += 1;
      }
    }
    return ranked;
  }

  /** Apply the engine's write plan per candidate against the scope's ACTIVE
   *  rows.
   *
   *  Atomicity rests on two explicit facts, not on luck:
   *  1. The whole batch runs inside `transactionSync`: the read of active rows,
   *     the `MAX(seq)+1` base, and every UPDATE/INSERT commit together or not
   *     at all — an isolate evicted mid-batch can never leave a superseded row
   *     without its correction, and every statement inside is synchronous.
   *  2. A DO executes one JS turn at a time; with no `await` anywhere in this
   *     method (transactionSync forbids one) no other request on this scope can
   *     interleave between the seq read and the inserts. (Input gates are NOT
   *     the mechanism — they only fence async storage writes.)
   *  The concurrent-writers test in worker.test.ts guards both. */
  async write(
    scopeKey: string,
    candidates: MemoryCandidate[],
    cap: number = DEFAULT_SCOPE_CAP,
  ): Promise<{ inserted: number; deduped: number; restated: number; superseded: number; evicted: number }> {
    const counts = { inserted: 0, deduped: 0, restated: 0, superseded: 0, evicted: 0 };
    if (candidates.length === 0) return counts;
    this.ctx.storage.transactionSync(() => {
      let seq = this.sql.exec<{ next: number }>(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM records`).one().next;
      const now = systemClock();
      for (const cand of candidates) {
        // Targeted lookups, never a full-active scan: planWrite
        // only ever inspects (a) the active row `supersedes` names — its
        // supersede target AND its whole dedup pool — or (b) the active rows
        // whose norm equals the candidate's (the dedup key, an indexed hit on
        // records_status_norm; ordered by seq so with duplicate-norm actives —
        // the engine's collision case — the earliest still takes the dedup
        // bump, exactly as the full-set scan did). Reads inside transactionSync
        // see the batch's own earlier inserts and flips, so later candidates
        // still dedup/supersede against them. The branch matches planWrite's
        // own TRUTHINESS test: `supersedes: ""` passes validation but means NO
        // supersede to the engine, so it must dedup against the norm pool —
        // an `!== undefined` branch here would hand it an empty pool and
        // insert a duplicate active row. A `restates` id is looked up first
        // (the restate target); when it misses — not active, or another
        // scope's id, which this DO simply doesn't hold — the candidate takes
        // today's pool, so planWrite falls through to dedup-or-insert.
        const restatePool = cand.restates
          ? this.sql
              .exec<Row>(`SELECT * FROM records WHERE id = ? AND status = 'active'`, cand.restates)
              .toArray()
              .map(toRecord)
          : [];
        const relevant =
          restatePool.length > 0
            ? restatePool
            : (cand.supersedes
                ? this.sql.exec<Row>(`SELECT * FROM records WHERE id = ? AND status = 'active'`, cand.supersedes)
                : this.sql.exec<Row>(
                    `SELECT * FROM records WHERE status = 'active' AND norm = ? ORDER BY seq`,
                    normalizeText(cand.text),
                  )
              )
                .toArray()
                .map(toRecord);
        const plan = planWrite(relevant, cand, (c) => mintRecord(scopeKey, seq++, now, c));
        if (plan.action === "restate") {
          // The shown record is refreshed in place; COALESCE keeps the stored
          // confidence when the plan carries none (neither side had a value).
          this.sql.exec(
            `UPDATE records SET use_count = use_count + 1, last_used_at = ?, confidence = COALESCE(?, confidence), provenance_json = ? WHERE id = ?`,
            now,
            plan.confidence ?? null,
            plan.provenance ? JSON.stringify(plan.provenance) : null,
            plan.target.id,
          );
          counts.restated++;
          continue;
        }
        if (plan.action === "dedup") {
          this.sql.exec(
            `UPDATE records SET use_count = use_count + 1, provenance_json = ? WHERE id = ?`,
            plan.provenance ? JSON.stringify(plan.provenance) : null,
            plan.target.id,
          );
          counts.deduped++;
          continue;
        }
        if (plan.supersede) {
          this.sql.exec(`UPDATE records SET status = 'superseded' WHERE id = ?`, plan.supersede.id);
          // Soft delete for the record row, hard delete for its FTS entry: a
          // superseded row must stop matching queries at the source.
          this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, plan.supersede.id);
          counts.superseded++;
        }
        const r = plan.record;
        this.sql.exec(
          `INSERT INTO records (id, seq, scope_key, kind, text, norm, keywords, source_thread_key, source_run_id,
                                created_at, last_used_at, use_count, confidence, supersedes, status, provenance_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 'active', ?)`,
          r.id,
          seq - 1,
          r.scopeKey,
          r.kind,
          r.text,
          normalizeText(r.text),
          JSON.stringify(r.keywords),
          r.sourceThreadKey,
          r.sourceRunId ?? null,
          r.createdAt,
          r.confidence ?? null,
          r.supersedes ?? null,
          r.provenance ? JSON.stringify(r.provenance) : null,
        );
        this.sql.exec(`INSERT INTO records_fts (id, body) VALUES (?, ?)`, r.id, `${r.text} ${r.keywords.join(" ")}`);
        counts.inserted++;
      }
      // Per-scope cap, inside the same transaction: the batch never
      // commits with the scope over the cap. Soft delete — rows stay (their
      // FTS entries do not). The full active set is fetched only when
      // the indexed COUNT says the scope is over the cap — the common
      // under-cap batch does no full scan.
      const activeCount = this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records WHERE status = 'active'`)
        .one().n;
      if (activeCount > cap) {
        const active = this.sql.exec<Row>(`SELECT * FROM records WHERE status = 'active'`).toArray().map(toRecord);
        for (const victim of planEviction(active, cap)) {
          this.sql.exec(`UPDATE records SET status = 'evicted' WHERE id = ? AND status = 'active'`, victim.id);
          this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, victim.id);
          counts.evicted++;
        }
      }
    });
    return counts;
  }

  /** Human view and the repository window's read (docs/reference/specs/memory.md items 22, 26): the
   *  scope's ACTIVE rows, newest first, no usage bump. With `query`, only rows
   *  an FTS token hits (the same quoted-OR MATCH as retrieve, so user text
   *  never reaches the FTS parser as syntax); a query with no tokens lists
   *  nothing. With `kind`, only rows of that kind (the window lists facts). */
  async list(_scopeKey: string, limit: number, query?: string, kind?: MemoryRecord["kind"]): Promise<MemoryRecord[]> {
    if (query === undefined) {
      return this.sql
        .exec<Row>(
          `SELECT * FROM records WHERE status = 'active'${kind === undefined ? "" : " AND kind = ?"} ORDER BY seq DESC LIMIT ?`,
          ...(kind === undefined ? [] : [kind]),
          limit,
        )
        .toArray()
        .map(toRecord);
    }
    const match = ftsMatchExpr(query);
    if (match === null) return [];
    return this.sql
      .exec<Row>(
        `SELECT r.* FROM records r
           JOIN records_fts f ON f.id = r.id
          WHERE r.status = 'active'${kind === undefined ? "" : " AND r.kind = ?"} AND records_fts MATCH ?
          ORDER BY r.seq DESC
          LIMIT ?`,
        ...(kind === undefined ? [] : [kind]),
        match,
        limit,
      )
      .toArray()
      .map(toRecord);
  }

  /** Human control: soft-delete one ACTIVE row (`status = 'forgotten'`;
   *  the row and its provenance stay). Returns whether a row changed. The DO
   *  IS the scope, so an id from another scope simply matches nothing here. */
  async forget(_scopeKey: string, id: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const flipped =
        this.sql.exec(`UPDATE records SET status = 'forgotten' WHERE id = ? AND status = 'active'`, id).rowsWritten > 0;
      // Soft delete for the record row, hard delete for its FTS entry:
      // one sync transaction, so no crash can strand a dead FTS row (and the
      // start-time reconciliation would heal it anyway).
      if (flipped) this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, id);
      return flipped;
    });
  }

  /** Human control (docs/reference/specs/memory.md item 27): retire every
   *  ACTIVE fact whose text the write gate would reject today — the same
   *  `rejectionMarkers` the bot's write path runs, imported from the shared
   *  engine, so the sweep and the gate can never disagree. Summaries are never
   *  gated, so never swept. The scan, the flips and the FTS deletes run in ONE
   *  sync transaction (the per-scope cap's atomicity rule): the sweep commits
   *  whole or not at all. Idempotent — swept rows are no longer active, so a
   *  second call answers 0. Under `dryRun` nothing flips. */
  async sweep(_scopeKey: string, dryRun: boolean): Promise<{ swept: number; ids: string[] }> {
    return this.ctx.storage.transactionSync(() => {
      const ids = this.sql
        .exec<Row>(`SELECT * FROM records WHERE status = 'active' AND kind = 'fact'`)
        .toArray()
        .filter((row) => rejectionMarkers(row.text).length > 0)
        .map((row) => row.id);
      if (!dryRun) {
        for (const id of ids) {
          // Soft delete for the record row, hard delete for its FTS entry —
          // the forget/supersede/evict hygiene rule (§15).
          this.sql.exec(`UPDATE records SET status = 'swept' WHERE id = ? AND status = 'active'`, id);
          this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, id);
        }
      }
      return { swept: ids.length, ids };
    });
  }
}

/** Build the FTS5 MATCH expression for a query: each engine token (`[a-z0-9]+`
 *  by construction) quoted and OR-joined, so operators, parentheses and colons
 *  in user text can never reach the FTS query parser as syntax. At most the
 *  MAX_MATCH_TOKENS longest distinct tokens are used (see the constant's note);
 *  `null` when the query has no tokens. Shared by retrieve and list — the one
 *  place user text becomes a MATCH. */
function ftsMatchExpr(query: string): string | null {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return null;
  const kept =
    tokens.length <= MAX_MATCH_TOKENS
      ? tokens
      : tokens
          .map((t, i) => [t, i] as const)
          .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
          .slice(0, MAX_MATCH_TOKENS)
          .map(([t]) => t);
  return kept.map((t) => `"${t}"`).join(" OR ");
}

/** Row → wire record. Optional fields are OMITTED when NULL (never `null` on
 *  the wire — the bot's record type has them as `?: T`). */
function toRecord(row: Row): MemoryRecord {
  const r: MemoryRecord = {
    id: row.id,
    scopeKey: row.scope_key,
    kind: row.kind as MemoryRecord["kind"],
    text: row.text,
    keywords: JSON.parse(row.keywords) as string[],
    sourceThreadKey: row.source_thread_key,
    createdAt: row.created_at,
    useCount: row.use_count,
    status: row.status as MemoryRecord["status"],
  };
  if (row.source_run_id !== null) r.sourceRunId = row.source_run_id;
  if (row.provenance_json) {
    try {
      const provenance: unknown = JSON.parse(row.provenance_json);
      if (isMemoryProvenance(provenance) && provenance.scopeKey === row.scope_key) r.provenance = provenance;
    } catch {
      /* Malformed legacy metadata remains unknown to source readers. */
    }
  }
  if (row.last_used_at !== null) r.lastUsedAt = row.last_used_at;
  if (row.confidence !== null) r.confidence = row.confidence;
  if (row.supersedes !== null) r.supersedes = row.supersedes;
  return r;
}

// ---------------------------------------------------------------------------
// Scheduled firings — the durable record behind the /runs Scheduled panel
// ---------------------------------------------------------------------------

/** Firings kept per schedule; the oldest fall off. A weekly job needs ~2 years. */
const SCHEDULE_MAX_FIRINGS = 100;

type FiringRow = {
  record: string;
};

/**
 * ScheduleDO: one SQLite Durable Object holding every schedule's firings. The
 * Worker shim (deploy/cloudflare/worker.ts) appends one `ScheduleFiring` per
 * cron firing — including firings that produced NO run (misconfigured, ingress
 * error) — and the bot's /runs page reads the newest per schedule. Append-only
 * per firing (two firings at one instant are two rows; the later write is the
 * later id), bounded per schedule.
 */
export class ScheduleDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS firings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS firings_schedule_time ON firings(schedule, fired_at DESC, id DESC);
    `);
  }

  /** Append one firing, then trim that schedule to the newest SCHEDULE_MAX_FIRINGS.
   *  One sync transaction. Returns how many firings the schedule retains. */
  async record(firing: ScheduleFiring): Promise<number> {
    let retained = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO firings (schedule, fired_at, record) VALUES (?, ?, ?)`,
        firing.schedule,
        firing.firedAt,
        JSON.stringify(firing),
      );
      this.sql.exec(
        `DELETE FROM firings WHERE schedule = ? AND id NOT IN (
           SELECT id FROM firings WHERE schedule = ? ORDER BY fired_at DESC, id DESC LIMIT ?)`,
        firing.schedule,
        firing.schedule,
        SCHEDULE_MAX_FIRINGS,
      );
      retained = this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM firings WHERE schedule = ?`, firing.schedule)
        .one().n;
    });
    return retained;
  }

  /** The newest firing of every schedule (by fired_at, then insertion order). */
  async latest(): Promise<ScheduleFiring[]> {
    const rows = this.sql
      .exec<FiringRow>(
        `SELECT f.record AS record FROM firings f
          WHERE f.id = (SELECT g.id FROM firings g WHERE g.schedule = f.schedule ORDER BY g.fired_at DESC, g.id DESC LIMIT 1)
          ORDER BY f.schedule`,
      )
      .toArray();
    const out: ScheduleFiring[] = [];
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.record);
        if (isScheduleFiring(parsed)) out.push(parsed);
      } catch {
        // a corrupt row is skipped, never fatal
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Durable Object: runtime config documents (docs/reference/specs/routing-and-config.md item
// 10). ONE object, a table of small JSON documents by key — today the bot's
// `overrides` document (chat-set channel/user settings) — each with a version
// for optimistic concurrency: a `put` whose `expectedVersion` is stale is a 409,
// never a silent clobber (the bot and the CLI both write this document).

/** What the bot posts to mint a confirmation: the facts this object judges on
 *  and the bot's own row as an opaque body (routing-and-config item 25). */
interface ConfirmationInput {
  id: string;
  threadKey: string;
  requester: string;
  body: Record<string, unknown>;
}
/** A stored confirmation as a consume returns it: the input plus the expiry this object stamped. */
interface ConfirmationRow extends ConfirmationInput {
  expiresAt: number;
}
/** Why a consume or a cancel refused: the row is gone (`used`), past its expiry (`expired`), or someone else's (`foreign`). */
type ConfirmationRefusal = "used" | "expired" | "foreign";
/** A refusal names the row where one still exists — `expired` (deleted here)
 *  and `foreign` (kept) — so the bot can record the click's refusal against
 *  the command that was bound (record 0054); `used` has no row to name. */
type ConfirmationOutcome = { row: ConfirmationRow } | { refused: ConfirmationRefusal; row?: ConfirmationRow };
type ConfirmationCancelOutcome = { ok: true } | { refused: Exclude<ConfirmationRefusal, "expired"> };
/** The consume log's word: a refusal may carry the row it names (expired,
 *  foreign), so the refusal is the discriminant, never the row's presence. The
 *  parameter is the declared union, where the narrowing holds; the stub's
 *  return type narrows to `never` across `in`. */
function consumeWord(outcome: ConfirmationOutcome): string {
  return "refused" in outcome ? outcome.refused : "consumed";
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ConfigDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        server_id TEXT PRIMARY KEY,
        sealed TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tickets (
        nonce TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        ticket TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS personal_tokens (
        digest TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personal_tokens_subject ON personal_tokens(subject);
      CREATE TABLE IF NOT EXISTS confirmations (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        requester TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  // ---- Confirmations (docs/reference/specs/routing-and-config.md item 25): the
  // row a routed write is offered as, minted by the bot and consumed once at
  // the click. The body is the bot's row, opaque here; this object owns the
  // three facts the consume decides on — the thread (one pending row per
  // thread), the requester (the click must be theirs) and the expiry, stamped
  // and judged on this object's clock so two bot processes alive during a roll
  // read one answer. Nothing sweeps: expiry is checked on touch.

  /** Insert the row and drop the thread's older one in one transaction; the
   *  expiry is `now + ttlMs`, stamped here and answered to the caller. */
  async putConfirmation(row: ConfirmationInput, ttlMs: number, now: number): Promise<number> {
    const expiresAt = now + ttlMs;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM confirmations WHERE thread_key = ?`, row.threadKey);
      this.sql.exec(
        `INSERT OR REPLACE INTO confirmations (id, thread_key, requester, expires_at, body) VALUES (?, ?, ?, ?, ?)`,
        row.id,
        row.threadKey,
        row.requester,
        expiresAt,
        JSON.stringify(row.body),
      );
    });
    return expiresAt;
  }

  /** Read, judge and delete in one transaction on the single-threaded object,
   *  so a confirmation runs at most once whatever the click timing: a missing
   *  row is `used`, a row past its expiry is deleted and `expired`, a requester
   *  none of `actorIds` names is `foreign` (the row stays for its requester),
   *  and otherwise the row is deleted and returned. */
  async consumeConfirmation(id: string, actorIds: readonly string[], now: number): Promise<ConfirmationOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.readConfirmation(id);
      if (!stored) return { refused: "used" };
      if (stored.expiresAt <= now) {
        this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, id);
        return { refused: "expired", row: stored };
      }
      if (!actorIds.includes(stored.requester)) return { refused: "foreign", row: stored };
      this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, id);
      return { row: stored };
    });
  }

  /** Delete the row under the same requester check as a consume; a missing row
   *  is `used`. Expiry plays no part: cancelling an expired offer still leaves
   *  nothing pending, which is what the click asked for. */
  async cancelConfirmation(id: string, actorIds: readonly string[]): Promise<ConfirmationCancelOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.readConfirmation(id);
      if (!stored) return { refused: "used" };
      if (!actorIds.includes(stored.requester)) return { refused: "foreign" };
      this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, id);
      return { ok: true };
    });
  }

  /** Delete the thread's pending row under the same requester check (record
   *  0054: a typed answer supersedes the button, so a click cannot follow
   *  it). At most one row per thread exists (`putConfirmation` replaces); a
   *  thread with none is `used`. The body stays opaque here — a row stored
   *  before the bot's union gained `kind` cancels the same way. */
  async cancelConfirmationByThread(threadKey: string, actorIds: readonly string[]): Promise<ConfirmationCancelOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.sql
        .exec<{ id: string; requester: string }>(
          `SELECT id, requester FROM confirmations WHERE thread_key = ?`,
          threadKey,
        )
        .toArray()[0];
      if (!stored) return { refused: "used" };
      if (!actorIds.includes(stored.requester)) return { refused: "foreign" };
      this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, stored.id);
      return { ok: true };
    });
  }

  /** The thread's pending row when one exists and is inside its ttl, else
   *  null. A pure read: expiry is checked here on this object's clock and
   *  nothing is deleted — nothing sweeps, and a consume still finds the
   *  expired row to name `expired`. */
  async pendingConfirmationByThread(threadKey: string, now: number): Promise<ConfirmationRow | null> {
    const row = this.sql
      .exec<{ id: string; requester: string; expires_at: number; body: string }>(
        `SELECT id, requester, expires_at, body FROM confirmations WHERE thread_key = ?`,
        threadKey,
      )
      .toArray()[0];
    if (!row || row.expires_at <= now) return null;
    return {
      id: row.id,
      threadKey,
      requester: row.requester,
      expiresAt: row.expires_at,
      body: parseStored(row.body, isJsonObject) ?? {},
    };
  }

  private readConfirmation(id: string): ConfirmationRow | undefined {
    const row = this.sql
      .exec<{ thread_key: string; requester: string; expires_at: number; body: string }>(
        `SELECT thread_key, requester, expires_at, body FROM confirmations WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      id,
      threadKey: row.thread_key,
      requester: row.requester,
      expiresAt: row.expires_at,
      body: parseStored(row.body, isJsonObject) ?? {},
    };
  }

  // ---- MCP sealed credentials + connect tickets (docs/reference/specs/mcp-tools.md items 15–16).
  // Ciphertext the bot sealed — opaque here — and one-time tickets: the two
  // things a config document must never carry, kept beside it on this object.

  async putSecret(sealed: SealedCredential): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO secrets (server_id, sealed) VALUES (?, ?)`,
      sealed.serverId,
      JSON.stringify(sealed),
    );
  }

  async getSecret(serverId: string): Promise<SealedCredential | null> {
    const row = this.sql
      .exec<{ sealed: string }>(`SELECT sealed FROM secrets WHERE server_id = ?`, serverId)
      .toArray()[0];
    return row ? parseStored(row.sealed, isSealedCredential) : null;
  }

  async deleteSecret(serverId: string): Promise<boolean> {
    const had = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM secrets WHERE server_id = ?`, serverId).one().n;
    this.sql.exec(`DELETE FROM secrets WHERE server_id = ?`, serverId);
    return had > 0;
  }

  async putPersonalToken(token: { digest: string; subject: string; email: string; createdAt: number }): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO personal_tokens (digest, subject, email, created_at) VALUES (?, ?, ?, ?)`,
      token.digest,
      token.subject,
      token.email,
      token.createdAt,
    );
  }

  async getPersonalToken(
    digest: string,
  ): Promise<{ digest: string; subject: string; email: string; createdAt: number } | null> {
    const row = this.sql
      .exec<{ digest: string; subject: string; email: string; created_at: number }>(
        `SELECT digest, subject, email, created_at FROM personal_tokens WHERE digest = ?`,
        digest,
      )
      .toArray()[0];
    return row ? { digest: row.digest, subject: row.subject, email: row.email, createdAt: row.created_at } : null;
  }

  async listPersonalTokens(
    subject: string,
  ): Promise<{ digest: string; subject: string; email: string; createdAt: number }[]> {
    return this.sql
      .exec<{ digest: string; subject: string; email: string; created_at: number }>(
        `SELECT digest, subject, email, created_at FROM personal_tokens WHERE subject = ? ORDER BY created_at DESC`,
        subject,
      )
      .toArray()
      .map((row) => ({ digest: row.digest, subject: row.subject, email: row.email, createdAt: row.created_at }));
  }

  async deletePersonalToken(digest: string, subject: string): Promise<boolean> {
    const had = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM personal_tokens WHERE digest = ? AND subject = ?`,
        digest,
        subject,
      )
      .one().n;
    this.sql.exec(`DELETE FROM personal_tokens WHERE digest = ? AND subject = ?`, digest, subject);
    return had > 0;
  }

  /** Insert or replace; tickets expired more than a day ago are swept on every write. */
  async putTicket(ticket: McpTicket, now: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR REPLACE INTO tickets (nonce, server_id, expires_at, ticket) VALUES (?, ?, ?, ?)`,
        ticket.nonce,
        ticket.serverId,
        ticket.expiresAt,
        JSON.stringify(ticket),
      );
      this.sql.exec(`DELETE FROM tickets WHERE expires_at < ?`, now - 24 * 3600_000);
    });
  }

  async getTicket(nonce: string): Promise<McpTicket | null> {
    const row = this.sql.exec<{ ticket: string }>(`SELECT ticket FROM tickets WHERE nonce = ?`, nonce).toArray()[0];
    return row ? parseStored(row.ticket, isMcpTicket) : null;
  }

  /** Compare-and-swap: write `ticket` only while the stored row is still in
   *  `fromState`. One transaction on a single-threaded object, so of two
   *  concurrent opens/completions exactly one is applied — "single-use" is a
   *  property of the store, not of request timing. */
  async transitionTicket(ticket: McpTicket, fromState: McpTicketState): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ ticket: string }>(`SELECT ticket FROM tickets WHERE nonce = ?`, ticket.nonce)
        .toArray()[0];
      const stored = row ? parseStored(row.ticket, isMcpTicket) : null;
      if (!stored || stored.state !== fromState) return false;
      this.sql.exec(
        `UPDATE tickets SET server_id = ?, expires_at = ?, ticket = ? WHERE nonce = ?`,
        ticket.serverId,
        ticket.expiresAt,
        JSON.stringify(ticket),
        ticket.nonce,
      );
      return true;
    });
  }

  async get(key: string): Promise<{ document: unknown; version: number }> {
    const row = this.sql
      .exec<{ version: number; body: string }>(`SELECT version, body FROM documents WHERE key = ?`, key)
      .toArray()[0];
    if (!row) return { document: null, version: 0 };
    try {
      return { document: JSON.parse(row.body) as unknown, version: row.version };
    } catch {
      return { document: null, version: row.version };
    }
  }

  /** Replace the document iff its stored version equals `expectedVersion`
   *  (0 = not yet stored). Returns the new version, or the current one on conflict. */
  async put(
    key: string,
    document: unknown,
    expectedVersion: number,
    now: number,
    source?: ConfigSourcePrecondition,
  ): Promise<
    { ok: true; version: number; sourcePrecondition?: ConfigSourcePrecondition } | { ok: false; version: number }
  > {
    let outcome:
      { ok: true; version: number; sourcePrecondition?: ConfigSourcePrecondition } | { ok: false; version: number } = {
      ok: false,
      version: 0,
    };
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ version: number }>(`SELECT version FROM documents WHERE key = ?`, key).toArray()[0];
      const current = row?.version ?? 0;
      if (source) {
        const sourceRow = this.sql
          .exec<{ version: number }>(`SELECT version FROM documents WHERE key = ?`, source.key)
          .toArray()[0];
        if ((sourceRow?.version ?? 0) !== source.version) {
          try {
            console.log(
              `[config/put] refused ${key}: source ${source.key} v${sourceRow?.version ?? 0} != v${source.version}`,
            );
          } catch {
            // Telemetry cannot change a known compare-and-swap refusal.
          }
          outcome = { ok: false, version: current };
          return;
        }
      }
      if (current !== expectedVersion || (current > 0 && isConfigPublicationSnapshotKey(key))) {
        if (current > 0 && isConfigPublicationSnapshotKey(key)) {
          try {
            console.log(`[config/put] refused replacing snapshot ${key} v${current}`);
          } catch {
            // Telemetry cannot change a known compare-and-swap refusal.
          }
        }
        outcome = { ok: false, version: current };
        return;
      }
      const next = current + 1;
      this.sql.exec(
        `INSERT OR REPLACE INTO documents (key, version, body, updated_at) VALUES (?, ?, ?, ?)`,
        key,
        next,
        JSON.stringify(document),
        now,
      );
      outcome = { ok: true, version: next, ...(source ? { sourcePrecondition: { ...source } } : {}) };
    });
    return outcome;
  }
}

function parseStored<T>(text: string, guard: (v: unknown) => v is T): T | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Durable Object: delivery snapshots, one per repository
// ---------------------------------------------------------------------------

// The delivery page's snapshot (docs/reference/specs/delivery.md item 10): the
// merged pull requests' facts over the snapshot window, as GitHub gave them,
// and when they were read. A busy repository's window is many MB — the review
// bodies and every workflow run of every branch — so a snapshot is stored as
// one row per pull request under a meta row, never as one JSON value (the
// per-row limit is 2 MB). A put replaces the repository's snapshot whole, in
// one transaction — the first read; a merge applies a refresh — the rows it
// re-read replace theirs by number, the rows that aged out go, the meta is
// replaced — so the hourly write is the change, not the window; a get
// reassembles the snapshot in pull request number order.

/** One pull request's facts may not exceed a fraction of the row limit; the fence names the pull request. */
const MAX_PULL_REQUEST_FACTS_BYTES = 1024 * 1024;

export class DeliveryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        repo TEXT PRIMARY KEY,
        snapshot_at TEXT NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pull_requests (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        facts TEXT NOT NULL,
        PRIMARY KEY (repo, number)
      );
    `);
  }

  /** Replace the repository's snapshot: the meta row and one row per pull request, in one transaction. */
  async put(snapshot: DeliverySnapshot): Promise<number> {
    const { prs, ...meta } = snapshot;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM pull_requests WHERE repo = ?`, snapshot.repo);
      for (const pr of prs) {
        this.sql.exec(
          `INSERT OR REPLACE INTO pull_requests (repo, number, facts) VALUES (?, ?, ?)`,
          snapshot.repo,
          pr.number,
          JSON.stringify(pr),
        );
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO snapshots (repo, snapshot_at, meta) VALUES (?, ?, ?)`,
        snapshot.repo,
        snapshot.snapshotAt,
        JSON.stringify(meta),
      );
    });
    return prs.length;
  }

  /** Apply a refresh to the repository's snapshot in one transaction; the rows now stored, or null
   *  when the repository has no snapshot to merge into (a partial snapshot would claim a
   *  completeness it lacks — the caller writes whole instead). */
  async merge(patch: DeliverySnapshotPatch): Promise<number | null> {
    const { upsert, drop, ...meta } = patch;
    return this.ctx.storage.transactionSync(() => {
      const stored = this.sql.exec(`SELECT 1 FROM snapshots WHERE repo = ?`, patch.repo).toArray().length > 0;
      if (!stored) return null;
      for (const pr of upsert) {
        this.sql.exec(
          `INSERT OR REPLACE INTO pull_requests (repo, number, facts) VALUES (?, ?, ?)`,
          patch.repo,
          pr.number,
          JSON.stringify(pr),
        );
      }
      for (const number of drop) {
        this.sql.exec(`DELETE FROM pull_requests WHERE repo = ? AND number = ?`, patch.repo, number);
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO snapshots (repo, snapshot_at, meta) VALUES (?, ?, ?)`,
        patch.repo,
        patch.snapshotAt,
        JSON.stringify(meta),
      );
      const count = this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pull_requests WHERE repo = ?`, patch.repo)
        .toArray()[0];
      return count?.n ?? 0;
    });
  }

  /** The repository's snapshot, pull requests in number order; null when none was stored. */
  async get(repo: string): Promise<DeliverySnapshot | null> {
    const row = this.sql.exec<{ meta: string }>(`SELECT meta FROM snapshots WHERE repo = ?`, repo).toArray()[0];
    if (!row) return null;
    const prs = this.sql
      .exec<{ facts: string }>(`SELECT facts FROM pull_requests WHERE repo = ? ORDER BY number`, repo)
      .toArray()
      .map((r) => JSON.parse(r.facts) as DeliverySnapshot["prs"][number]);
    return { ...(JSON.parse(row.meta) as Omit<DeliverySnapshot, "prs">), prs };
  }
}

const DELIVERY_ROUTES = new Set(["/delivery/get", "/delivery/put", "/delivery/merge"]);

/** The pull request whose facts exceed the row fence, if any — checked before the transaction. */
function oversizedFacts(prs: readonly DeliverySnapshot["prs"][number][]): number | undefined {
  const encoder = new TextEncoder();
  return prs.find((pr) => encoder.encode(JSON.stringify(pr)).byteLength > MAX_PULL_REQUEST_FACTS_BYTES)?.number;
}

async function handleDelivery(pathname: string, body: unknown, env: Env): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dO = env.DELIVERY.get(env.DELIVERY.idFromName(DELIVERY_OBJECT));
  if (pathname === "/delivery/get") {
    if (typeof b.repo !== "string" || !REPO_SLUG.test(b.repo)) return json({ error: "repo must be owner/name" }, 400);
    const snapshot = await dO.get(b.repo);
    console.log(
      `[delivery/get] ${b.repo} -> ${snapshot ? `${snapshot.prs.length} pull requests as of ${snapshot.snapshotAt}` : "none"}`,
    );
    return json({ snapshot });
  }
  if (pathname === "/delivery/put") {
    if (!isDeliverySnapshot(b.snapshot))
      return json(
        { error: "snapshot must be a DeliverySnapshot (repo, snapshotAt, range, prs[], truncated, completeFrom)" },
        400,
      );
    const oversized = oversizedFacts(b.snapshot.prs);
    if (oversized !== undefined)
      return json(
        { error: `pull request ${oversized}'s facts must be at most ${MAX_PULL_REQUEST_FACTS_BYTES} bytes` },
        413,
      );
    const prs = await dO.put(b.snapshot);
    console.log(`[delivery/put] ${b.snapshot.repo} <- ${prs} pull requests as of ${b.snapshot.snapshotAt}`);
    return json({ ok: true, prs });
  }
  if (pathname === "/delivery/merge") {
    if (!isDeliverySnapshotPatch(b.patch))
      return json(
        {
          error:
            "patch must be a DeliverySnapshotPatch (repo, snapshotAt, range, truncated, completeFrom, upsert[], drop[])",
        },
        400,
      );
    const oversized = oversizedFacts(b.patch.upsert);
    if (oversized !== undefined)
      return json(
        { error: `pull request ${oversized}'s facts must be at most ${MAX_PULL_REQUEST_FACTS_BYTES} bytes` },
        413,
      );
    const prs = await dO.merge(b.patch);
    if (prs === null) return json({ error: `no snapshot for ${b.patch.repo} to merge into` }, 404);
    console.log(
      `[delivery/merge] ${b.patch.repo} <- ${b.patch.upsert.length} pull requests re-read, ${b.patch.drop.length} dropped, ${prs} stored as of ${b.patch.snapshotAt}`,
    );
    return json({ ok: true, prs });
  }
  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------
// The costs snapshot (docs/reference/specs/costs.md item 6)
// ---------------------------------------------------------------------------

/** The datasets a snapshot's `usage` carries, each stored as its own row. */
const USAGE_PARTS = [
  "containers",
  "durableObjectRequests",
  "durableObjectDays",
  "durableObjectStorage",
  "workers",
  "r2Storage",
  "r2Operations",
  "workflows",
] as const;

/**
 * The installation's one costs snapshot: both billing sources' rows over the
 * page's widest range plus the run history's per-user usage, and when they
 * were read (`CostsSnapshot`, the shape the bot validates too). Stored as one
 * row per part — the meta, each usage dataset, the LLM rows, the run usage —
 * so no single value nears the row limit as the window's rows grow; replaced
 * whole on every put, in one transaction, and read back as one document.
 */
export class CostsSnapshotDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS parts (
        part TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `);
  }

  /** Replace the snapshot whole: every part rewritten in one transaction. Each
   *  logical part is its own named row — `invoices` included, never a rest-spread
   *  into the meta row that would silently absorb future fields. */
  async put(snapshot: CostsSnapshot): Promise<void> {
    const { usage, llm, invoices, runUsage, ...meta } = snapshot;
    const rows: Array<[string, unknown]> = [
      ["meta", meta],
      ...USAGE_PARTS.map((name): [string, unknown] => [`usage.${name}`, usage[name]]),
      ["llm", llm],
      ...(invoices !== undefined ? [["invoices", invoices] as [string, unknown]] : []),
      ["runUsage", runUsage],
    ];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM parts`);
      for (const [part, body] of rows)
        this.sql.exec(`INSERT INTO parts (part, body) VALUES (?, ?)`, part, JSON.stringify(body));
    });
  }

  /** The stored snapshot reassembled from its parts, or null when none was stored (or the parts do not make one). */
  async get(): Promise<CostsSnapshot | null> {
    const parts = new Map(
      this.sql
        .exec<{ part: string; body: string }>(`SELECT part, body FROM parts`)
        .toArray()
        .map((r) => [r.part, r.body]),
    );
    const meta = parts.get("meta");
    if (meta === undefined) return null;
    const read = (part: string): unknown => {
      const body = parts.get(part);
      return body === undefined ? undefined : (JSON.parse(body) as unknown);
    };
    const usage = Object.fromEntries(USAGE_PARTS.map((name) => [name, read(`usage.${name}`)]));
    const invoices = read("invoices");
    const snapshot = {
      ...(JSON.parse(meta) as Record<string, unknown>),
      usage,
      llm: read("llm"),
      ...(invoices !== undefined ? { invoices } : {}),
      runUsage: read("runUsage"),
    };
    return isCostsSnapshot(snapshot) ? snapshot : null;
  }
}

const COSTS_ROUTES = new Set(["/costs/snapshot/get", "/costs/snapshot/put"]);

async function handleCosts(pathname: string, body: unknown, env: Env): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dO = env.COSTS.get(env.COSTS.idFromName(COSTS_OBJECT));
  if (pathname === "/costs/snapshot/get") {
    const snapshot = await dO.get();
    console.log(
      `[costs/snapshot/get] -> ${snapshot ? `snapshot taken ${snapshot.takenAt} by ${snapshot.takenBy}` : "none"}`,
    );
    return json({ snapshot });
  }
  if (pathname === "/costs/snapshot/put") {
    if (!isCostsSnapshot(b.snapshot))
      return json(
        { error: "snapshot must be a CostsSnapshot (takenAt, takenBy, durationMs, range, usage, llm, runUsage)" },
        400,
      );
    await dO.put(b.snapshot);
    console.log(`[costs/snapshot/put] <- snapshot taken ${b.snapshot.takenAt} by ${b.snapshot.takenBy}`);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

/** Documents are small; a body over this is refused before storage. */
const MAX_CONFIG_DOCUMENT_BYTES = 256 * 1024;

const CONFIG_ROUTES = new Set([
  "/config/get",
  "/config/put",
  "/config/secrets/put",
  "/config/secrets/get",
  "/config/secrets/delete",
  "/config/tickets/put",
  "/config/tickets/get",
  "/config/tickets/transition",
  "/config/personal-tokens/put",
  "/config/personal-tokens/get",
  "/config/personal-tokens/list",
  "/config/personal-tokens/delete",
  "/config/confirmations/put",
  "/config/confirmations/consume",
  "/config/confirmations/cancel",
  "/config/confirmations/cancel-by-thread",
  "/config/confirmations/pending-by-thread",
]);
const TICKET_STATES: ReadonlySet<string> = new Set<McpTicketState>(MCP_TICKET_STATES);
/** A confirmation id as the bot mints it (a UUID) — one token, no whitespace, bounded. */
const CONFIRMATION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** The `{ id, actorIds }` a consume or a cancel carries, or the 400 that refuses it. */
function confirmationClickOf(b: Record<string, unknown>): { id: string; actorIds: string[] } | Response {
  if (typeof b.id !== "string" || !CONFIRMATION_ID_RE.test(b.id)) return json({ error: "id malformed" }, 400);
  if (!Array.isArray(b.actorIds) || !b.actorIds.every((a): a is string => typeof a === "string"))
    return json({ error: "actorIds must be a list of actor ids" }, 400);
  return { id: b.id, actorIds: b.actorIds };
}

async function handleConfig(pathname: string, body: unknown, env: Env): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dO = env.CONFIG.get(env.CONFIG.idFromName(CONFIG_OBJECT));
  // MCP secrets + tickets (opaque to this Worker beyond shape).
  switch (pathname) {
    case "/config/personal-tokens/put": {
      if (!isPersonalToken(b.token)) return json({ error: "token malformed" }, 400);
      await dO.putPersonalToken(b.token);
      return json({ ok: true });
    }
    case "/config/personal-tokens/get": {
      if (typeof b.digest !== "string" || !/^[a-f0-9]{64}$/.test(b.digest))
        return json({ error: "digest malformed" }, 400);
      return json({ token: await dO.getPersonalToken(b.digest) });
    }
    case "/config/personal-tokens/list": {
      if (typeof b.subject !== "string" || !/^personal:.{1,256}$/.test(b.subject))
        return json({ error: "subject malformed" }, 400);
      return json({ tokens: await dO.listPersonalTokens(b.subject) });
    }
    case "/config/personal-tokens/delete": {
      if (
        typeof b.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(b.digest) ||
        typeof b.subject !== "string" ||
        !/^personal:.{1,256}$/.test(b.subject)
      )
        return json({ error: "digest or subject malformed" }, 400);
      return json({ ok: true, removed: await dO.deletePersonalToken(b.digest, b.subject) });
    }
    case "/config/secrets/put": {
      if (!isSealedCredential(b.sealed)) return json({ error: "sealed must be a SealedCredential" }, 400);
      await dO.putSecret(b.sealed);
      console.log(`[config/secrets/put] ${b.sealed.serverId} key=${b.sealed.keyId}`);
      return json({ ok: true });
    }
    case "/config/secrets/get": {
      if (typeof b.serverId !== "string" || !b.serverId) return json({ error: "serverId required" }, 400);
      return json({ sealed: await dO.getSecret(b.serverId) });
    }
    case "/config/secrets/delete": {
      if (typeof b.serverId !== "string" || !b.serverId) return json({ error: "serverId required" }, 400);
      return json({ ok: true, removed: await dO.deleteSecret(b.serverId) });
    }
    case "/config/tickets/put": {
      if (!isMcpTicket(b.ticket)) return json({ error: "ticket must be an McpTicket" }, 400);
      await dO.putTicket(b.ticket, systemClock());
      console.log(`[config/tickets/put] ${b.ticket.serverId} state=${b.ticket.state}`);
      return json({ ok: true });
    }
    case "/config/tickets/get": {
      if (typeof b.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(b.nonce))
        return json({ error: "nonce malformed" }, 400);
      return json({ ticket: await dO.getTicket(b.nonce) });
    }
    case "/config/tickets/transition": {
      if (!isMcpTicket(b.ticket)) return json({ error: "ticket must be an McpTicket" }, 400);
      if (typeof b.fromState !== "string" || !TICKET_STATES.has(b.fromState))
        return json({ error: "fromState must be a ticket state" }, 400);
      const applied = await dO.transitionTicket(b.ticket, b.fromState as McpTicketState);
      console.log(
        `[config/tickets/transition] ${b.ticket.serverId} ${b.fromState}→${b.ticket.state} applied=${applied}`,
      );
      return json({ ok: true, applied });
    }
    // Confirmations (routing-and-config item 25): the body is the bot's row,
    // stored verbatim; the expiry is this object's clock plus the ttl the bot
    // passed, never a timestamp the bot chose.
    case "/config/confirmations/put": {
      if (typeof b.id !== "string" || !CONFIRMATION_ID_RE.test(b.id)) return json({ error: "id malformed" }, 400);
      if (typeof b.threadKey !== "string" || !b.threadKey) return json({ error: "threadKey required" }, 400);
      if (typeof b.requester !== "string" || !b.requester) return json({ error: "requester required" }, 400);
      if (!isJsonObject(b.body)) return json({ error: "body must be a JSON object" }, 400);
      if (typeof b.ttlMs !== "number" || !Number.isInteger(b.ttlMs) || b.ttlMs < 0)
        return json({ error: "ttlMs must be a non-negative integer" }, 400);
      const expiresAt = await dO.putConfirmation(
        { id: b.id, threadKey: b.threadKey, requester: b.requester, body: b.body },
        b.ttlMs,
        systemClock(),
      );
      console.log(`[config/confirmations/put] ${b.threadKey} ${b.id} expires_at=${expiresAt}`);
      return json({ ok: true, expiresAt });
    }
    case "/config/confirmations/consume": {
      const click = confirmationClickOf(b);
      if (click instanceof Response) return click;
      const outcome = await dO.consumeConfirmation(click.id, click.actorIds, systemClock());
      console.log(`[config/confirmations/consume] ${click.id} ${consumeWord(outcome)}`);
      return json(outcome);
    }
    case "/config/confirmations/cancel": {
      const click = confirmationClickOf(b);
      if (click instanceof Response) return click;
      const outcome = await dO.cancelConfirmation(click.id, click.actorIds);
      console.log(`[config/confirmations/cancel] ${click.id} ${"ok" in outcome ? "cancelled" : outcome.refused}`);
      return json(outcome);
    }
    case "/config/confirmations/pending-by-thread": {
      if (typeof b.threadKey !== "string" || !b.threadKey) return json({ error: "threadKey required" }, 400);
      // The stub types this result `never`: workers-types' Serializable rejects
      // the row's opaque `Record<string, unknown>` body. What arrives is the
      // object's declared result, so the boundary restates it.
      const row = (await dO.pendingConfirmationByThread(b.threadKey, systemClock())) as ConfirmationRow | null;
      console.log(`[config/confirmations/pending-by-thread] ${b.threadKey} ${row === null ? "none" : row.id}`);
      return json({ row });
    }
    case "/config/confirmations/cancel-by-thread": {
      if (typeof b.threadKey !== "string" || !b.threadKey) return json({ error: "threadKey required" }, 400);
      if (!Array.isArray(b.actorIds) || !b.actorIds.every((a): a is string => typeof a === "string"))
        return json({ error: "actorIds must be a list of actor ids" }, 400);
      const outcome = await dO.cancelConfirmationByThread(b.threadKey, b.actorIds);
      console.log(
        `[config/confirmations/cancel-by-thread] ${b.threadKey} ${"ok" in outcome ? "cancelled" : outcome.refused}`,
      );
      return json(outcome);
    }
    default:
      break;
  }
  if (typeof b.key !== "string" || !CONFIG_KEY_RE.test(b.key))
    return json({ error: "key must be a short lowercase slug" }, 400);
  if (pathname === "/config/get") {
    return json(await dO.get(b.key));
  }
  if (pathname === "/config/put") {
    if (typeof b.document !== "object" || b.document === null || Array.isArray(b.document))
      return json({ error: "document must be a JSON object" }, 400);
    if (typeof b.expectedVersion !== "number" || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 0)
      return json({ error: "expectedVersion must be a non-negative integer" }, 400);
    if (new TextEncoder().encode(JSON.stringify(b.document)).byteLength > MAX_CONFIG_DOCUMENT_BYTES)
      return json({ error: `document must be at most ${MAX_CONFIG_DOCUMENT_BYTES} bytes` }, 413);
    let source: ConfigSourcePrecondition | undefined;
    if (b.sourcePrecondition !== undefined) {
      const value = b.sourcePrecondition;
      if (
        !isJsonObject(value) ||
        typeof value.key !== "string" ||
        !CONFIG_KEY_RE.test(value.key) ||
        typeof value.version !== "number" ||
        !Number.isSafeInteger(value.version) ||
        value.version < 0
      )
        return json({ error: "sourcePrecondition must name a document and a non-negative safe version" }, 400);
      source = { key: value.key, version: value.version };
    }
    const out = await dO.put(b.key, b.document, b.expectedVersion, systemClock(), source);
    if (!out.ok) return json({ error: "version conflict", version: out.version }, 409);
    console.log(`[config/put] ${b.key} v${out.version}`);
    return json({
      ok: true,
      version: out.version,
      ...(out.sourcePrecondition ? { sourcePrecondition: out.sourcePrecondition } : {}),
    });
  }
  return json({ error: "not found" }, 404);
}

function parseScheduleFiring(body: unknown): Validated<ScheduleFiring> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const f = (body as Record<string, unknown>).firing;
  if (!isScheduleFiring(f))
    return invalid("firing must be a ScheduleFiring (schedule, firedAt, outcome[, runId, detail])");
  if (f.schedule.length > MAX_KEY_CHARS) return invalid(`firing.schedule must be at most ${MAX_KEY_CHARS} characters`);
  if (f.runId !== undefined && f.runId.length > MAX_KEY_CHARS)
    return invalid(`firing.runId must be at most ${MAX_KEY_CHARS} characters`);
  if (f.detail !== undefined && f.detail.length > FIRING_DETAIL_MAX)
    return invalid(`firing.detail must be at most ${FIRING_DETAIL_MAX} characters`);
  return { ok: true, value: f };
}

// ---------------------------------------------------------------------------
// Durable Object: one run history per store key
// ---------------------------------------------------------------------------

// Cloudflare Durable Object SQLite limits (developers.cloudflare.com/durable-objects/platform/limits/;
// re-read them when a bound below looks wrong): 100 bound parameters per query; 100 KB per SQL statement;
// 2 MB per string/BLOB/row; 100 columns per table; 10 GB storage per object
// (Workers Paid). Consequences here: event inserts carry 3 parameters per row,
// so a batch is 33 rows (99 parameters); deletions by id list are batched at
// 100 ids; an event is capped to 64 KiB upstream (MAX_EVENT_BYTES) so no row
// nears 2 MB; and `maxBytes` is clamped to 8 GiB (RETENTION_BOUNDS), under the
// 10 GB per-object ceiling.
/** Ids per `DELETE ... WHERE run_id IN (...)` statement. */
const RUN_DELETE_BATCH = DO_MAX_BOUND_PARAMETERS;
/** Rows a single `put` may delete while trimming (the deletion fence): a
 *  policy shrink dropping thousands of runs is spread over successive puts and,
 *  when enabled, the 6 h sweep. Reads hide them immediately. */
const RUN_TRIM_FENCE = 500;
/** Background alarm interval; physical retention work runs only when enabled. */
const RUN_SWEEP_INTERVAL_MS = 6 * 3600_000;
/** `finishedAt` further ahead of the DO clock than this is clamped (a skewed bot clock). */
const RUN_MAX_FUTURE_MS = 24 * 3600_000;
/** Request body ceiling for `/runs/put` (a record is budgeted to 1.5 MiB upstream). */
const MAX_RUN_PUT_BODY_BYTES = 2 * 1024 * 1024;
const POLICY_KEY = "policy";

type RunRow = {
  run_id: string;
  agent: string | null;
  channel_id: string | null;
  finished_at: number;
  bytes: number;
  event_count: number;
  summary_json: string;
  source_reads_json?: string | null;
  work_evidence_json?: string | null;
  context_checkpoint_json?: string | null;
  direct_audience_json?: string | null;
};

interface StoredPolicy {
  policy: RetentionPolicy;
  policyUpdatedAt: number;
}

export interface RunPolicyProposal {
  policy: Partial<RetentionPolicy>;
  policyUpdatedAt: number;
}

/** What retention needs from a `runs` row. */
type RetentionRow = { run_id: string; finished_at: number; bytes: number };

/** A `live_runs` row as SQLite returns it. */
type LiveRow = {
  run_id: string;
  thread_key: string;
  owner_gen: string;
  lease_until: number;
  started_at: number;
  phase: string;
  stop: string | null;
  meta_json: string;
  card_json: string | null;
  system_text: string;
  tools_json: string;
  state_json: string;
};

function rowToLive(r: LiveRow): LiveRunRow {
  const state = JSON.parse(r.state_json) as RunState;
  const liveState = state.liveState as LiveRunRow["liveState"];
  const liveStateSeq = state.liveStateSeq;
  return {
    runId: r.run_id,
    threadKey: r.thread_key,
    ownerGen: r.owner_gen,
    leaseUntil: r.lease_until,
    startedAt: r.started_at,
    phase: r.phase as LivePhase,
    stop: (r.stop as StopMode | null) ?? null,
    meta: JSON.parse(r.meta_json) as LiveRunRow["meta"],
    card: r.card_json ? (JSON.parse(r.card_json) as LiveRunRow["card"]) : null,
    system: r.system_text,
    tools: JSON.parse(r.tools_json) as LiveRunRow["tools"],
    state,
    ...(liveState !== undefined ? { liveState } : {}),
    ...(typeof liveStateSeq === "number" ? { liveStateSeq } : {}),
  };
}

type HeartbeatAnswer = FenceResult & { stop?: StopMode | null; phase?: LivePhase; effects?: PlaneEffect[] };
type PromotionHold = { kind: "held"; reason: "promotion_pending" | "promotion_corrupt"; runId: string };

/** Whether the bot's outcome and the decider's word agree (orchestration-plane item 8): `proceeded`
 *  beside `proceed`, and a thread-live refusal beside `queued` — the refusal
 *  IS the queue position the plane would hold. `null` for a pair the decider
 *  does not model yet: logged, never counted. */
function planeAgreementOf(outcome: string, decider: "proceed" | "queued"): boolean | null {
  if (outcome === "proceeded") return decider === "proceed";
  if (outcome === "refused:thread-live") return decider === "queued";
  return null;
}

/** The most effects one answer carries (record 0064; orchestration-plane item 7): the rest ride the next heartbeat. */
const PLANE_EFFECTS_PER_ANSWER = 32;
const COORDINATOR_SCAN_LIMIT = 16;

/** An expected canonical archive refusal must leave the shared object alive.
 * Throwing it inside blockConcurrencyWhile resets unrelated run requests. */
class CanonicalArchiveRefusal extends Error {}

export class RunHistoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Where a turned-final run's point goes (run-metrics.md): the Analytics
   *  Engine dataset when the deploy bound one, the NullSink otherwise —
   *  selected once at construction, the `SHIP_COORDINATOR?` shape. */
  private readonly metrics: RunMetricsSink;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.metrics = env.RUN_METRICS !== undefined ? new AnalyticsEngineSink(env.RUN_METRICS) : new NullSink();
    // Idempotent schema. `runs` carries the listing columns plus the record
    // minus its events as JSON (`summary_json`, what `list` returns); events
    // live one per row keyed (run_id, seq) so a 5000-event run is paged, never
    // loaded whole to answer a listing. `meta` holds the persisted policy.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        label TEXT,
        agent TEXT,
        model TEXT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        channel_visibility TEXT NOT NULL DEFAULT 'unknown',
        repo TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        stored_event_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        diagnosis_json TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_finished ON runs(finished_at);
      CREATE INDEX IF NOT EXISTS runs_thread_key ON runs(thread_key, finished_at);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateRunsTable();
    // The indexes the visibility predicate's leaves walk (`channel_id IN`,
    // `channel_visibility IN`, `user_id =`), each ordered like the page; the
    // session the sweep asks about; the parent a children listing filters on;
    // the pull request a findings listing filters on.
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS runs_channel_finished ON runs(channel_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_visibility_finished ON runs(channel_visibility, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_user_finished ON runs(user_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_session ON runs(session_key);
      CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_run_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_pr ON runs(repo, pr_number, finished_at DESC, run_id DESC);
    `);
    // The sessions registry (session-log item 7): every session log a run of
    // this store claimed, with its thread — the sweep cannot enumerate the
    // SESSION_LOGS namespace, so this is how it knows which objects exist and
    // which thread's live row would block a drop.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS context_refs (
        holder_run_id TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        session_key TEXT NOT NULL DEFAULT '',
        ordinary_member INTEGER NOT NULL DEFAULT 0,
        ordinary_order INTEGER NOT NULL DEFAULT 0,
        ordinary_checkpoint TEXT NOT NULL DEFAULT '',
        retention_pin INTEGER NOT NULL DEFAULT 1,
        ordinary_pin INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (holder_run_id, source_run_id, session_key)
      );
      CREATE INDEX IF NOT EXISTS context_refs_source ON context_refs(source_run_id, holder_run_id);
      CREATE INDEX IF NOT EXISTS context_refs_session ON context_refs(session_key, holder_run_id);
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        agent TEXT,
        last_finished_at INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (
      !this.sql
        .exec<{ name: string }>(`PRAGMA table_info(context_refs)`)
        .toArray()
        .some((column) => column.name === "ordinary_member")
    )
      this.sql.exec(`ALTER TABLE context_refs ADD COLUMN ordinary_member INTEGER NOT NULL DEFAULT 0`);
    for (const [column, declaration] of [
      ["ordinary_order", "INTEGER NOT NULL DEFAULT 0"],
      ["ordinary_checkpoint", "TEXT NOT NULL DEFAULT ''"],
      ["retention_pin", "INTEGER NOT NULL DEFAULT 1"],
      ["ordinary_pin", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (
        !this.sql
          .exec<{ name: string }>(`PRAGMA table_info(context_refs)`)
          .toArray()
          .some((value) => value.name === column)
      )
        this.sql.exec(`ALTER TABLE context_refs ADD COLUMN ${column} ${declaration}`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS context_refs_active ON context_refs(retention_pin, ordinary_pin)
      WHERE retention_pin = 1 OR ordinary_pin = 1`);

    // The live-run ledger (run-history items 28–34): live runs never enter
    // `runs` — that table's finished_at drives retention and listing — they
    // live here until `finish` moves them across in one transaction.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_runs (
        run_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL UNIQUE,
        owner_gen TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        phase TEXT NOT NULL,
        stop TEXT,
        meta_json TEXT NOT NULL,
        card_json TEXT,
        system_text TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resident_claim_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO resident_claim_clock (id, value) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS workspace_settlements (
        owner_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        json TEXT,
        allocation_json TEXT,
        PRIMARY KEY (owner_key, revision)
      );
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, step)
      );
      CREATE TABLE IF NOT EXISTS run_inbox (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS run_jobs (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, kind)
      );
    `);
    const allocationColumns = new Set(
      this.sql
        .exec<{ name: string }>(`PRAGMA table_info(workspace_settlements)`)
        .toArray()
        .map((row) => row.name),
    );
    if (!allocationColumns.has("allocation_json"))
      this.sql.exec(`ALTER TABLE workspace_settlements ADD COLUMN allocation_json TEXT`);
    // The intake receipts (run-history item 59): one verdict per message key,
    // first writer wins, beside the live rows because the reconnect catch-up
    // reads them through the same store key. `prune_after` is stamped at the
    // insert (the bound is the writer's window through
    // `intakeReceiptRetentionMs`) and the enabled alarm sweep prunes by it.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS intake_receipts (
        key TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        prune_after INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS intake_thread ON intake_receipts(thread_key, decided_at);
      CREATE INDEX IF NOT EXISTS intake_prune ON intake_receipts(prune_after);
      CREATE TABLE IF NOT EXISTS intake_deliveries (
        receipt_key TEXT PRIMARY KEY,
        poster TEXT NOT NULL,
        claim_until INTEGER NOT NULL,
        delivered INTEGER NOT NULL
      );
    `);
    // The coordinator's parent records (run-history item 49): one row per
    // instance, written by the bot at the instance's creation and read by the
    // spawn route for the requester, channel and thread every child acts as.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_instances (
        instance_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // The units of the plan an instance runs (run-history item 50): one row per
    // (instance, unit), replaced whole as the runner reaches the unit; the
    // rowid keeps the order the rows were first written — the plan's.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_units (
        instance_id TEXT NOT NULL,
        unit TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (instance_id, unit)
      );
      CREATE TABLE IF NOT EXISTS coordinator_main_task_links (
        main_thread_key TEXT NOT NULL,
        act_id TEXT NOT NULL,
        instance_id TEXT NOT NULL UNIQUE,
        unit TEXT NOT NULL,
        PRIMARY KEY (main_thread_key, act_id)
      );
      CREATE TABLE IF NOT EXISTS coordinator_recovery_journal (
        instance_id TEXT NOT NULL,
        unit TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (instance_id, unit, kind, id)
      );
      CREATE TABLE IF NOT EXISTS coordinator_requester_turns (
        thread_key TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        question_target TEXT,
        prior_question_target TEXT,
        PRIMARY KEY (thread_key, requester_id, message_id),
        UNIQUE (thread_key, requester_id, revision)
      );
      CREATE TABLE IF NOT EXISTS coordinator_main_task_authority (
        main_thread_key TEXT NOT NULL,
        act_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        repo TEXT NOT NULL,
        PRIMARY KEY (main_thread_key, act_id)
      );
      CREATE TABLE IF NOT EXISTS coordinator_private_worker_events (
        thread_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT,
        json TEXT NOT NULL,
        PRIMARY KEY (thread_key, seq),
        UNIQUE (thread_key, event_id)
      );
      CREATE TABLE IF NOT EXISTS decision_record_reservations (
        repo TEXT NOT NULL,
        task_key TEXT NOT NULL,
        number TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (repo, task_key),
        UNIQUE (repo, number)
      );
    `);
    // The thread events of a unit-owned thread (record 0051's reply-as-event rule): a
    // sibling table of the unit rows, never a field on them — `putUnits`
    // replaces a row whole, so an append landing between a route's read and
    // its put would be lost. Consumption is a column of its own, set once.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_unit_events (
        instance_id TEXT NOT NULL,
        unit TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        consumed_by TEXT,
        PRIMARY KEY (instance_id, unit, seq)
      );
    `);
    // The orchestration plane's tables (record 0064; orchestration-plane.md item 7):
    // the queue with its conditions, the reservations, the quiet and pressure
    // windows, the watches' findings, the offered effects and the residents'
    // levels. This unit opens them all so a later Worker and an earlier one agree on
    // the schema; only the queue and the effects are written yet.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS plane_queue (
        run_id TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        stage TEXT NOT NULL,
        request_json TEXT NOT NULL,
        conditions_json TEXT NOT NULL,
        position_at INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plane_queue_waiting ON plane_queue(state, queued_at);
      CREATE TABLE IF NOT EXISTS plane_reservations (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE TABLE IF NOT EXISTS plane_windows (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        phase TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        reason_json TEXT NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE TABLE IF NOT EXISTS plane_findings (
        id TEXT PRIMARY KEY,
        watch TEXT NOT NULL,
        subject TEXT NOT NULL,
        timeline_json TEXT NOT NULL,
        filed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_effects (
        id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS plane_effects_open ON plane_effects(acked_at, offered_at);
      CREATE TABLE IF NOT EXISTS plane_levels (
        resident TEXT NOT NULL,
        name TEXT NOT NULL,
        side TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        generation TEXT NOT NULL,
        cause TEXT,
        PRIMARY KEY (resident, name)
      );
      CREATE TABLE IF NOT EXISTS plane_endings (
        run_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        cause TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    const planeLevelColumns = new Set(
      this.sql
        .exec<{ name: string }>(`PRAGMA table_info(plane_levels)`)
        .toArray()
        .map((column) => column.name),
    );
    if (!planeLevelColumns.has("cause")) this.sql.exec(`ALTER TABLE plane_levels ADD COLUMN cause TEXT`);
    this.ctx.blockConcurrencyWhile(() => this.armCoordinatorReconciliation(systemClock()));
  }

  // ---- the orchestration plane (record 0064; orchestration-plane.md) ----------

  /** The decider's state, read inside the caller's `transactionSync`: the
   *  queue oldest first and the threads a live row holds. `excludeRunId` drops
   *  that run's own live row from the view — a shadow post judged after the
   *  dispatch it describes claimed the thread must not read its own claim as
   *  "thread live" (orchestration-plane item 8). */
  private planeState(excludeRunId?: string): PlaneState {
    const now = systemClock();
    // A reservation not yet promoted into a live row expires after its window:
    // a dispatch that died between the admission answer and its claim must not
    // hold the thread forever. Promotion deletes the row (the live row holds
    // the thread from there), so age alone is the test.
    // `steer` and `park` rows (record 0064) have no expiry window: a steer's
    // dedupe row and a parked run's wait live until the run's seal deletes them.
    const reservations = this.sql
      .exec<{ kind: string; key: string; run_id: string; at: number }>(
        `SELECT * FROM plane_reservations WHERE kind != 'thread' OR at > ?`,
        now - minutesToMs(PLANE.reservationMinutes),
      )
      .toArray()
      .map((r): PlaneReservation => ({
        kind: r.kind as PlaneReservation["kind"],
        key: r.key,
        runId: r.run_id,
        at: r.at,
      }));
    const openWindows = this.sql
      .exec<{ kind: string }>(`SELECT kind FROM plane_windows WHERE phase = 'open'`)
      .toArray()
      .map((r) => r.kind);
    const queue = this.sql
      .exec<{
        run_id: string;
        requester: string;
        thread_key: string;
        stage: string;
        request_json: string;
        conditions_json: string;
        position_at: number;
        queued_at: number;
        state: string;
      }>(`SELECT * FROM plane_queue ORDER BY queued_at ASC, run_id ASC`)
      .toArray()
      .map((r): PlaneQueueRow => ({
        runId: r.run_id,
        requester: r.requester,
        threadKey: r.thread_key,
        stage: r.stage as PlaneStage,
        request: JSON.parse(r.request_json) as Record<string, unknown>,
        conditions: JSON.parse(r.conditions_json) as PlaneQueueRow["conditions"],
        position: r.position_at,
        queuedAt: r.queued_at,
        state: r.state as PlaneQueueRow["state"],
      }));
    const liveRows = this.sql
      .exec<{ run_id: string; thread_key: string; meta_json: string }>(
        `SELECT run_id, thread_key, meta_json FROM live_runs WHERE run_id IS NOT ?`,
        excludeRunId ?? null,
      )
      .toArray();
    const liveThreads = liveRows.map((r) => r.thread_key);
    const liveRuns = Object.fromEntries(
      liveRows.flatMap((r) => {
        const meta = JSON.parse(r.meta_json) as Record<string, unknown>;
        return typeof meta.channelId === "string"
          ? [[r.run_id, { channelId: meta.channelId, threadKey: r.thread_key }] as const]
          : [];
      }),
    );
    const inboxSeqs = Object.fromEntries(
      this.sql
        .exec<{ run_id: string; seq: number }>(`SELECT run_id, MAX(seq) AS seq FROM run_inbox GROUP BY run_id`)
        .toArray()
        .map((r) => [r.run_id, r.seq]),
    );
    const levels = this.sql
      .exec<{
        resident: string;
        name: string;
        side: string;
        reported_at: number;
        generation: string;
        cause: string | null;
      }>(`SELECT * FROM plane_levels`)
      .toArray()
      .map((r): PlaneLevelRow => ({
        resident: r.resident,
        name: r.name as PlaneLevelRow["name"],
        side: r.side as PlaneLevelRow["side"],
        reportedAt: r.reported_at,
        generation: r.generation,
        ...(r.cause !== null && (PROVIDER_FAILURE_CAUSES as readonly string[]).includes(r.cause)
          ? { cause: r.cause as ProviderFailureCause }
          : {}),
      }));
    return { queue, liveThreads, liveRuns, inboxSeqs, reservations, openWindows, levels };
  }

  /** The decider's writes, applied inside the same `transactionSync` that read
   *  the state — the decision and its consequences land together (orchestration-plane item 6). */
  private applyPlaneWrites(writes: PlaneWrite[]): void {
    for (const w of writes) {
      if (w.table === "plane_queue" && w.op === "put") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_queue
             (run_id, requester, thread_key, stage, request_json, conditions_json, position_at, queued_at, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          w.row.runId,
          w.row.requester,
          w.row.threadKey,
          w.row.stage,
          JSON.stringify(w.row.request),
          JSON.stringify(w.row.conditions),
          w.row.position,
          w.row.queuedAt,
          w.row.state,
        );
      } else if (w.table === "plane_queue" && w.op === "state") {
        this.sql.exec(`UPDATE plane_queue SET state = ? WHERE run_id = ?`, w.state, w.runId);
      } else if (w.table === "plane_reservations" && w.op === "put") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_reservations (kind, key, run_id, at) VALUES (?, ?, ?, ?)`,
          w.row.kind,
          w.row.key,
          w.row.runId,
          w.row.at,
        );
      } else if (w.table === "plane_reservations" && w.op === "del") {
        this.sql.exec(`DELETE FROM plane_reservations WHERE kind = ? AND key = ?`, w.kind ?? "thread", w.key);
      } else if (w.table === "run_inbox" && w.op === "push") {
        // The plane's steer into a live run's durable inbox (record 0064;
        // run-history item 40), in the decider's own transaction: the run reads
        // it at its next boundary like any follow-up; a run with no live row
        // reads nothing and the row would be an orphan, so it is skipped.
        const owner = this.liveRow(w.runId);
        if (!owner) continue;
        const stored = bindInboxCustody(
          w.message,
          {
            runId: w.runId,
            channelId: owner.meta.channelId,
            threadKey: owner.meta.threadKey,
            requester: owner.meta.userId,
            producerGen: owner.ownerGen,
          },
          true,
        );
        if (!stored) continue;
        const last = this.sql
          .exec<{ m: number | null }>(`SELECT MAX(seq) AS m FROM run_inbox WHERE run_id = ?`, w.runId)
          .one().m;
        this.sql.exec(
          `INSERT INTO run_inbox (run_id, seq, json) VALUES (?, ?, ?)`,
          w.runId,
          (last ?? 0) + 1,
          JSON.stringify(stored),
        );
      } else if (w.table === "plane_windows" && w.op === "put") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_windows (kind, key, phase, opened_at, reason_json) VALUES (?, ?, 'open', ?, '{}')`,
          w.window,
          w.window,
          w.at,
        );
      } else if (w.table === "plane_windows" && w.op === "del") {
        this.sql.exec(`DELETE FROM plane_windows WHERE kind = ?`, w.window);
      } else if (w.table === "plane_levels") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_levels (resident, name, side, reported_at, generation, cause) VALUES (?, ?, ?, ?, ?, ?)`,
          w.row.resident,
          w.row.name,
          w.row.side,
          w.row.reportedAt,
          w.row.generation,
          w.row.cause ?? null,
        );
      } else if (w.table === "plane_findings") {
        // A finding (record 0064, "Endings and the watches"): keyed by watch
        // and subject, so two findings on one subject are ONE row — an
        // existing row absorbs the timeline through the same merge the
        // decider's module defines, its first-seen stamp kept.
        const key = planeFindingKey(w.finding);
        const prior = this.sql
          .exec<{ timeline_json: string; filed_at: number }>(
            `SELECT timeline_json, filed_at FROM plane_findings WHERE id = ?`,
            key,
          )
          .toArray()[0];
        const existing = prior
          ? [
              {
                watch: w.finding.watch,
                subject: w.finding.subject,
                timeline: JSON.parse(prior.timeline_json) as PlaneFinding["timeline"],
                firstAt: Number(prior.filed_at),
                lastAt: w.finding.lastAt,
              },
            ]
          : [];
        const merged = mergePlaneFindings(existing, w.finding)[0]!;
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_findings (id, watch, subject, timeline_json, filed_at) VALUES (?, ?, ?, ?, ?)`,
          key,
          merged.watch,
          merged.subject,
          JSON.stringify(merged.timeline),
          merged.firstAt,
        );
      } else {
        // The effect bounds (record 0064): an offer past the per-run or total
        // cap is refused by the cap's name — the throw aborts the transaction,
        // so the queue row stays waiting and the next event re-decides.
        const total = Number(
          this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM plane_effects WHERE acked_at IS NULL`).toArray()[0]
            ?.n ?? 0,
        );
        const effectRunId = w.effect.kind === "admit" || w.effect.kind === "steer" ? w.effect.runId : undefined;
        const forRun =
          effectRunId === undefined
            ? 0
            : Number(
                this.sql
                  .exec<{ n: number }>(
                    `SELECT COUNT(*) AS n FROM plane_effects
                     WHERE acked_at IS NULL AND json_extract(body_json, '$.runId') = ?`,
                    effectRunId,
                  )
                  .toArray()[0]?.n ?? 0,
              );
        const refusal = effectCapRefusal({ total, forRun }, w.effect);
        if (refusal !== undefined) throw new Error(refusal);
        const effect = w.effect;
        if (effect.kind === "steer") {
          const owner = this.liveRow(effect.runId);
          const message =
            owner &&
            bindInboxCustody(
              effect.message,
              {
                runId: effect.runId,
                channelId: owner.meta.channelId,
                threadKey: owner.meta.threadKey,
                requester: owner.meta.userId,
                producerGen: owner.ownerGen,
              },
              true,
            );
          if (!message) throw new Error("unverified control destination");
          effect.message = { ...effect.message, ...message };
        }
        // A re-offer lands after an ack for any kind — a probe re-probes after
        // its ack (one open probe per resident, record 0064), and an observation
        // re-enters an admitted run whose acked `admit:<runId>` row would
        // otherwise swallow the walk's re-offer, stranding the run `admitted`
        // with no effect delivered. The decider only re-emits an effect when
        // its subject is waiting again, and the bot's own getById dedup guards
        // a genuine duplicate admit, so the acked row is history, not a fence.
        this.sql.exec(`DELETE FROM plane_effects WHERE id = ? AND acked_at IS NOT NULL`, w.effect.id);
        // An offer keeps its first `offered_at`: a re-decided admit after a
        // roll is the same effect, not a younger one.
        this.sql.exec(
          `INSERT OR IGNORE INTO plane_effects (id, body_json, offered_at, acked_at) VALUES (?, ?, ?, NULL)`,
          w.effect.id,
          JSON.stringify(effect),
          w.at,
        );
        // The admitted run's attaching row, in the same transaction as the
        // effect (record 0064, "The queue"): owner `plane`, lease already
        // expired, request in the meta — exactly the row a reserved run whose
        // owner died leaves (run-history item 42), so the bot's reclaim sweep
        // restarts it from the stored request under this id.
        if (w.effect.kind === "admit") {
          this.sql.exec(
            `INSERT OR IGNORE INTO live_runs (run_id, thread_key, owner_gen, lease_until, started_at, phase, stop, meta_json, card_json, system_text, tools_json, state_json)
             VALUES (?, ?, 'plane', ?, ?, 'attaching', NULL, ?, NULL, '', '[]', '{}')`,
            w.effect.runId,
            w.effect.threadKey,
            w.at,
            w.at,
            JSON.stringify({ request: w.effect.request }),
          );
        }
      }
    }
  }

  /** Apply one plane event: state read, decider, writes and effects in ONE
   *  `transactionSync` (orchestration-plane item 6). The transport unit's routes feed it; the tests pin the atomicity. */
  planeApply(event: PlaneEvent): { effects: PlaneEffect[] } {
    let effects: PlaneEffect[] = [];
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), event);
      this.applyPlaneWrites(decision.writes);
      effects = decision.effects;
    });
    this.pushPlaneEffects(effects);
    return { effects };
  }

  /** The admission ask (`POST /plane/admit`, record 0064 "The queue"): one
   *  transaction decides and writes — `admitted` reserves the thread,
   *  `queued` stores the request under the minted id. */
  async planeAdmit(
    post: {
      runId: string;
      requester: string;
      threadKey: string;
      request: Record<string, unknown>;
      stage?: PlaneStage;
      resident?: string;
      restartOf?: boolean;
      reaskMs?: number;
    },
    now: number,
  ): Promise<PlaneAskAnswer> {
    let answer!: PlaneAskAnswer;
    this.ctx.storage.transactionSync(() => {
      if (post.reaskMs !== undefined)
        this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('plane_reask_ms', ?)`, String(post.reaskMs));
      const decision = decide(this.planeState(), {
        kind: "ask",
        at: now,
        runId: post.runId,
        requester: post.requester,
        threadKey: post.threadKey,
        stage: post.stage ?? "admission",
        request: post.request,
        ...(post.resident !== undefined ? { resident: post.resident } : {}),
        ...(post.restartOf !== undefined ? { restartOf: post.restartOf } : {}),
      });
      this.applyPlaneWrites(decision.writes);
      answer = planeAskAnswerOf(decision, post.runId);
    });
    if (answer.kind === "queued") await this.settlePlaneReaskAlarmAfterCommit(now);
    console.log(
      `[plane/admit] ${post.threadKey} → ${answer.kind}${answer.kind === "queued" ? ` position ${answer.position}` : ""} (run ${post.runId})`,
    );
    return answer;
  }

  /** A resident's level report (`POST /plane/level`, record 0064): `seat` and `memory`
   *  land as level events — a `below` side walks the queue; the registry's
   *  drain posts land as the resident-drain window's open (`above`) and lift
   *  (`below` — a `cleared` or the alarm's `expired`). */
  planeLevel(
    post:
      | { resident: string; name: "seat" | "memory" | "drain"; side: "below" | "above"; generation: string }
      | { provider: string; name: "provider"; side: "up" | "down"; cause?: ProviderFailureCause },
    now: number,
  ): { admitted: number } {
    // The model proxy's provider level (record 0064): `up` re-issues every
    // held turn parked on the provider — the steers land as inbox writes in the
    // decider's transaction — and walks anything queued on `provider_up`.
    if (post.name === "provider") {
      const r = this.planeApply({
        kind: "provider_level",
        at: now,
        provider: post.provider,
        level: post.side,
        ...(post.side === "down" && post.cause !== undefined ? { cause: post.cause } : {}),
      });
      const admitted = r.effects.filter((e) => e.kind === "admit").length;
      console.log(`[plane/level] provider ${post.provider} ${post.side} — ${admitted} admission(s)`);
      return { admitted };
    }
    const r =
      post.name === "drain"
        ? this.planeApply({
            kind: "window",
            at: now,
            window: RESIDENT_DRAIN_WINDOW,
            phase: post.side === "above" ? "opened" : "lifted",
          })
        : this.planeApply({
            kind: "level",
            at: now,
            resident: post.resident,
            name: post.name,
            side: post.side,
            generation: post.generation,
          });
    const admitted = r.effects.filter((e) => e.kind === "admit").length;
    console.log(`[plane/level] ${post.resident} ${post.name} ${post.side} — ${admitted} admission(s)`);
    return { admitted };
  }

  /** A run parked on its provider (`POST /plane/park`, record 0064): the
   *  proxy could not complete the turn after its retry; the harness holds the
   *  turn and the provider's next `up` steers the run to re-issue it. */
  planePark(runId: string, provider: string, now: number): { parked: boolean } {
    let parked = false;
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), { kind: "park", at: now, runId, provider });
      this.applyPlaneWrites(decision.writes);
      parked = decision.writes.length > 0;
    });
    console.log(`[plane/park] run ${runId} on ${provider} — ${parked ? "parked" : "already parked"}`);
    return { parked };
  }

  /** A refusal-by-name the bot met at attach or exec (`POST /plane/observe`,
   *  record 0064): an admitted run re-enters the queue at its old position. */
  async planeObserve(
    post: { runId: string; resident: string; refusal: string },
    now: number,
  ): Promise<{ reentered: boolean }> {
    let reentered = false;
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), {
        kind: "observation",
        at: now,
        runId: post.runId,
        resident: post.resident,
        refusal: post.refusal,
      });
      this.applyPlaneWrites(decision.writes);
      reentered = decision.writes.length > 0;
    });
    if (reentered) await this.settlePlaneReaskAlarmAfterCommit(now);
    console.log(
      `[plane/observe] run ${post.runId} on ${post.resident}: ${post.refusal.slice(0, 60)} — ${reentered ? "re-entered" : "no-op"}`,
    );
    return { reentered };
  }

  /** The re-ask cadence (record 0064): while a queued row waits on a resident,
   *  the object's alarm fires within the cadence — the background 6 h alarm
   *  is pulled forward, never pushed back. */
  private planeReaskMs(): number {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_reask_ms'`).toArray()[0];
    const stored = row ? Number(row.value) : NaN;
    return Number.isFinite(stored) && stored > 0 ? stored : minutesToMs(PLANE.reaskMinutes);
  }

  private planeWaitsOnResident(): boolean {
    return this.planeState().queue.some(
      (r) => r.state === "waiting" && r.conditions.some((c) => c.kind === "seat" || c.kind === "memory"),
    );
  }

  private async ensurePlaneReaskAlarm(now: number): Promise<void> {
    if (!this.planeWaitsOnResident()) return;
    const due = now + this.planeReaskMs();
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > due) await this.ctx.storage.setAlarm(due);
  }

  /** Settle alarm I/O without contradicting the plane transaction that already
   *  committed. A scheduling failure may delay a re-ask until another wake,
   *  but returning an error would make the caller proceed or retry while the
   *  durable queued row remains eligible for admission. */
  private async settlePlaneReaskAlarmAfterCommit(now: number): Promise<void> {
    try {
      await this.ensurePlaneReaskAlarm(now);
    } catch (err) {
      console.error("[plane/alarm] re-ask scheduling failed after the plane state committed", err);
    }
  }

  /** The earliest instant the plane must wake at (record 0064): the
   *  earliest hosting deadline, lease end or re-ask across its rows. A due
   *  already past re-offers at the re-ask cadence, never in a hot loop, and
   *  contributes nothing to end a run — the alarm only offers. */
  private planeEarliestDue(now: number): number | undefined {
    const dues: number[] = [];
    const reoffer = now + this.planeReaskMs();
    for (const r of this.sql
      .exec<{ lease_until: number; state_json: string }>(`SELECT lease_until, state_json FROM live_runs`)
      .toArray()) {
      dues.push(r.lease_until > now ? r.lease_until : reoffer);
      try {
        const hosting = (JSON.parse(r.state_json) as Record<string, unknown>).hosting as { until?: unknown };
        if (typeof hosting?.until === "number") dues.push(hosting.until > now ? hosting.until : reoffer);
      } catch {
        // A malformed state contributes no deadline.
      }
    }
    if (this.planeWaitsOnResident()) dues.push(reoffer);
    const coordinatorDue = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'coordinator_reconcile_due'`)
      .toArray()[0];
    if (coordinatorDue && Number.isFinite(Number(coordinatorDue.value)))
      dues.push(Number(coordinatorDue.value) > now ? Number(coordinatorDue.value) : reoffer);
    return dues.length === 0 ? undefined : Math.min(...dues);
  }

  /** The plane's one alarm (record 0064): set to the earliest due across
   *  its rows — the owner's heartbeat, moving the lease end, moves an alarm
   *  the plane armed; an alarm someone else armed earlier is left to fire
   *  first (the handler re-arms). The armed slot is judged directly, never
   *  the meta row alone: the slot is shared with the re-ask and the sweep and
   *  a fired alarm is consumed, so a meta row equal to a static due (a
   *  hosting deadline) can claim a wake that no longer exists. The due is
   *  capped to the background interval so enabled maintenance never starves
   *  behind a distant hosting deadline. */
  private async ensurePlaneAlarm(now: number): Promise<void> {
    const raw = this.planeEarliestDue(now);
    const prior = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_alarm_at'`).toArray()[0];
    const priorAt = prior ? Number(prior.value) : undefined;
    if (raw === undefined) {
      if (prior) this.sql.exec(`DELETE FROM meta WHERE key = 'plane_alarm_at'`);
      return; // nothing waits: the background alarm's own arming stands
    }
    const due = Math.min(raw, now + RUN_SWEEP_INTERVAL_MS);
    const set = await this.ctx.storage.getAlarm();
    // Re-arm when the slot is empty, later than the due, or holds an alarm
    // this plane armed itself; an earlier foreign alarm fires first.
    if (set !== due && (set === null || set > due || set === priorAt)) await this.ctx.storage.setAlarm(due);
    if (due !== priorAt)
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('plane_alarm_at', ?)`, String(due));
  }

  /** A window's open or lift over the RPC seam (`/plane/deploy`; a later
   *  unit's `plane window lift`): kind `deploy` is the pending deploy. */
  planeWindow(window: string, phase: "opened" | "lifted", now: number): { admitted: number } {
    const r = this.planeApply({ kind: "window", at: now, window, phase });
    return { admitted: r.effects.length };
  }

  /** `runs stop` on a queued id (record 0064): the waiting row is withdrawn;
   *  an id the queue does not hold waiting answers false. */
  planeWithdraw(runId: string, now: number): { withdrawn: boolean } {
    let withdrawn = false;
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), { kind: "withdraw", at: now, runId });
      this.applyPlaneWrites(decision.writes);
      withdrawn = decision.writes.length > 0;
    });
    return { withdrawn };
  }

  /** One queued row, for the queued id's page. */
  planeQueueRowOf(runId: string): PlaneQueueRow | null {
    return this.planeState().queue.find((r) => r.runId === runId) ?? null;
  }

  /** The ending's cause (record 0064, "Endings and the watches"): one
   *  `ended { kind, cause }` per closed row, recorded only when a live row
   *  closes and first-writer-wins — a roll that resumes every row assigns
   *  nothing. One keyed exception, taken only by the finish (`supersedes`): a
   *  standing `resident_replaced` was a `restarting` close — the run carried
   *  on under its own id (run-history item 42's restart) — so that run's own
   *  later finish replaces it and the ending agrees with the record. The bot
   *  renders the word; the object never renders. */
  private recordPlaneEnding(
    runId: string,
    kind: string,
    cause: PlaneEndingCause,
    at: number,
    supersedes = false,
  ): PlaneEndingCause {
    this.sql.exec(
      `INSERT OR IGNORE INTO plane_endings (run_id, kind, cause, at) VALUES (?, ?, ?, ?)`,
      runId,
      kind,
      cause,
      at,
    );
    const standing = this.sql
      .exec<{ cause: string }>(`SELECT cause FROM plane_endings WHERE run_id = ?`, runId)
      .toArray()[0];
    if (
      supersedes &&
      standing !== undefined &&
      standing.cause === "resident_replaced" &&
      cause !== "resident_replaced"
    ) {
      this.sql.exec(`UPDATE plane_endings SET kind = ?, cause = ?, at = ? WHERE run_id = ?`, kind, cause, at, runId);
      return cause;
    }
    return (standing?.cause as PlaneEndingCause | undefined) ?? cause;
  }

  /** The reclaim's outcome per row (record 0064; run-history item 36): only a
   *  `closed` row records an ending — `lease_lapsed`, which is true and blames
   *  nobody — and the standing cause is answered back so the bot's interrupted
   *  note renders the plane's word. `resume`, `restart` and `rehost` record
   *  nothing: the run carries on. */
  planeReclaimed(
    outcomes: readonly { runId: string; outcome: PlaneReclaimWord }[],
    now: number,
  ): { recorded: { runId: string; cause: PlaneEndingCause }[] } {
    const recorded: { runId: string; cause: PlaneEndingCause }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const o of outcomes) {
        const cause = causeOfReclaim(o.outcome);
        if (cause === undefined) continue;
        recorded.push({ runId: o.runId, cause: this.recordPlaneEnding(o.runId, "interrupted", cause, now) });
      }
    });
    if (outcomes.length > 0)
      console.log(
        `[plane/reclaimed] ${outcomes.map((o) => `${o.runId}=${o.outcome}`).join(", ")} — ${recorded.length} ending(s) recorded`,
      );
    return { recorded };
  }

  /** One recorded ending (record 0064), or none: what a reader renders. */
  planeEndingOf(runId: string): { kind: string; cause: PlaneEndingCause; at: number } | null {
    const row = this.sql
      .exec<{ kind: string; cause: string; at: number }>(
        `SELECT kind, cause, at FROM plane_endings WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    return row ? { kind: row.kind, cause: row.cause as PlaneEndingCause, at: row.at } : null;
  }

  /** The seal (record 0064, "The queue"): the run's own open effects are
   *  dropped — an admit for a run that just ended is stale — then the sealed
   *  event frees the thread and walks the queue, all in one transaction. */
  private planeSealed(runId: string, threadKey: string, now: number): void {
    let effects: PlaneEffect[] = [];
    try {
      this.ctx.storage.transactionSync(() => {
        // Exact id matching (`admit:<runId>`), never LIKE: a bot-minted run id
        // can carry `%` or `_`, which a pattern would read as wildcards.
        this.sql.exec(`DELETE FROM plane_effects WHERE acked_at IS NULL AND id = 'admit:' || ?`, runId);
        this.sql.exec(
          `DELETE FROM plane_effects
           WHERE acked_at IS NULL
             AND json_extract(body_json, '$.kind') = 'steer'
             AND json_extract(body_json, '$.runId') = ?`,
          runId,
        );
        // The run's steer dedupe rows and any park go with it (record 0064):
        // a sealed run holds no turn and reads no steer.
        this.sql.exec(`DELETE FROM plane_reservations WHERE kind IN ('steer', 'park') AND run_id = ?`, runId);
        const decision = decide(this.planeState(), { kind: "sealed", at: now, threadKey });
        this.applyPlaneWrites(decision.writes);
        effects = decision.effects;
      });
    } catch (err) {
      // A cap refusal here must not undo the finish that already committed.
      console.warn(`[plane/sealed] ${threadKey}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.pushPlaneEffects(effects);
  }

  /** The transport's push (record 0064, "Where it lives"): committed effects
   *  are pushed to the bot Worker over the service binding, which forwards to
   *  the container. The response does not wait for this best-effort push, but
   *  the actor does: waitUntil keeps its I/O inside this request's lifetime so
   *  it cannot contend with an unrelated request after the caller moves on. */
  private pushPlaneEffects(effects: PlaneEffect[]): void {
    if (effects.length === 0) return;
    const bot = this.env.BOT;
    if (!bot) return;
    const delivery = Promise.resolve()
      .then(() =>
        bot.fetch("https://bot/plane/effects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.env.MEMORY_TOKEN ?? ""}`,
          },
          body: JSON.stringify({ effects }),
        }),
      )
      .then((r) => {
        if (!r.ok)
          console.warn(
            `[plane/push] ${effects.length} effect(s) → bot answered ${r.status} — they ride the next heartbeat`,
          );
      })
      .catch((err: unknown) => {
        console.warn(
          `[plane/push] ${effects.length} effect(s) not delivered: ${err instanceof Error ? err.message : String(err)} — they ride the next heartbeat`,
        );
      });
    holdBackgroundTask(this.ctx, `plane effect push (${effects.map((effect) => effect.id).join(", ")})`, delivery);
  }

  /** The unacknowledged effects, oldest first, at most `PLANE_EFFECTS_PER_ANSWER`
   *  (orchestration-plane item 7) — what every heartbeat and reclaim answer carries. Public: the
   *  reclaim route composes it beside the runs it took. */
  openPlaneEffects(): PlaneEffect[] {
    return this.sql
      .exec<{ body_json: string }>(
        `SELECT body_json FROM plane_effects WHERE acked_at IS NULL ORDER BY offered_at ASC, id ASC LIMIT ?`,
        PLANE_EFFECTS_PER_ANSWER,
      )
      .toArray()
      .map((r) => JSON.parse(r.body_json) as PlaneEffect);
  }

  /** Shadow (orchestration-plane item 8): the bot's own outcome for one dispatch, judged beside the
   *  decider's word for the same ask. Nothing runs and nothing queues from
   *  the decider here — the comparison is logged, and a disagreement bumps a
   *  per-condition counter in `meta` for the `plane disagreements` line. An
   *  outcome the decider does not model yet (an allowlist refusal, a cold
   *  fall) is logged uncounted. The post is fired without an await, so it can
   *  arrive AFTER the dispatch it describes claimed this thread's `live_runs`
   *  row; a post carrying the run's own id excludes that row from the live
   *  view so the run's own claim never reads as a false disagreement. */
  planeOutcome(
    post: PlaneOutcomePost,
    now: number,
  ): { ok: true; decider: "proceed" | "queued"; agreed: boolean | null } {
    let decider: "proceed" | "queued" = "proceed";
    let agreed: boolean | null = null;
    this.ctx.storage.transactionSync(() => {
      const ask: PlaneEvent = {
        kind: "ask",
        at: now,
        runId: post.runId ?? `ask:${post.threadKey}:${now}`,
        requester: post.requester,
        threadKey: post.threadKey,
        stage: post.stage,
        request: {},
      };
      decider = planeAskWordOf(decide(this.planeState(post.runId), ask), ask.runId);
      agreed = planeAgreementOf(post.outcome, decider);
      if (agreed === false) this.bumpPlaneDisagreement("thread_free");
    });
    console.log(
      `[plane/outcome] ${post.threadKey} ${post.stage} bot=${post.outcome} decider=${decider} agreed=${agreed ?? "uncompared"}`,
    );
    return { ok: true, decider, agreed };
  }

  /** The per-condition disagreement counts (orchestration-plane item 8), kept in `meta` so the table's
   *  later `plane disagreements` line can read them. */
  private bumpPlaneDisagreement(condition: string): void {
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_disagreements'`)
      .toArray()[0];
    const counts = row ? (JSON.parse(row.value) as Record<string, number>) : {};
    counts[condition] = (counts[condition] ?? 0) + 1;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('plane_disagreements', ?)`, JSON.stringify(counts));
  }

  /** Fence a pushed steer to the owning live generation before its local
   *  registry is touched. The effect check, owner check and lease renewal are
   *  one transaction: an expired owner may renew before reclaim, but reclaim
   *  can never cross the synchronous local delivery that follows a success. */
  async planeFenceSteer(
    id: string,
    runId: string,
    gen: string,
    leaseMs: number,
    now: number,
  ): Promise<{ accepted: boolean }> {
    let accepted = false;
    this.ctx.storage.transactionSync(() => {
      const offered = this.sql
        .exec<{ body_json: string }>(`SELECT body_json FROM plane_effects WHERE id = ? AND acked_at IS NULL`, id)
        .toArray()[0];
      if (!offered) return;
      const effect = JSON.parse(offered.body_json) as PlaneEffect;
      if (effect.kind !== "steer" || effect.runId !== runId) return;
      const live = this.liveRow(runId);
      if (!live || live.ownerGen !== gen || live.phase !== "live") return;
      this.sql.exec(`UPDATE live_runs SET lease_until = ? WHERE run_id = ?`, now + leaseMs, runId);
      accepted = true;
    });
    if (accepted) await this.ensurePlaneAlarm(now);
    return { accepted };
  }

  /** An effect's acknowledgement by id (orchestration-plane item 7): `done` and `skipped` close it,
   *  `deferred` leaves it offered for the next answer. A steer is special: the
   *  acknowledging generation must still own its live row. A stale process
   *  may retain registry state during reclaim overlap, but it cannot close the
   *  durable offer. An unknown id is a no-op. */
  planeAck(id: string, outcome: PlaneAckOutcome, now: number, owner?: { runId: string; gen: string }): { ok: true } {
    if (outcome === "deferred") return { ok: true };
    const offered = this.sql
      .exec<{ body_json: string }>(`SELECT body_json FROM plane_effects WHERE id = ? AND acked_at IS NULL`, id)
      .toArray()[0];
    if (!offered) return { ok: true };
    const effect = JSON.parse(offered.body_json) as PlaneEffect;
    // A terminal execution's offer is not closed by a transport word. Its
    // canonical report obligations are independently checked below.
    if (effect.kind === "coordinator_reconcile") return { ok: true };
    if (effect.kind === "steer") {
      if (!owner || owner.runId !== effect.runId) return { ok: true };
      const live = this.sql
        .exec<{ owner_gen: string }>(`SELECT owner_gen FROM live_runs WHERE run_id = ?`, owner.runId)
        .toArray()[0];
      if (live?.owner_gen !== owner.gen) return { ok: true };
    }
    this.sql.exec(`UPDATE plane_effects SET acked_at = ? WHERE id = ? AND acked_at IS NULL`, now, id);
    return { ok: true };
  }

  // ---- the coordinator's parent records (run-history item 49) -----------------

  private coordinatorSnapshot(
    instanceId: string,
    unit: string,
  ): { instance: CoordinatorInstance; unit: CoordinatorUnit; action?: RecoveryAction } | undefined {
    const savedInstance = this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, instanceId)
      .toArray()[0];
    const savedUnit = this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`, instanceId, unit)
      .toArray()[0];
    if (!savedInstance || !savedUnit) return;
    try {
      const instance = JSON.parse(savedInstance.json),
        row = JSON.parse(savedUnit.json);
      if (!isCoordinatorInstance(instance) || !isCoordinatorUnit(row) || row.instanceId !== instance.id) return;
      const actionId = row.recovery?.actionId ?? (row.recoveryReceipt ? row.history?.receiptId : undefined);
      let action: RecoveryAction | undefined;
      if (row.recovery || row.recoveryReceipt) {
        if (!actionId) return;
        const record = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM coordinator_recovery_journal WHERE instance_id = ? AND unit = ? AND kind = 'action' AND id = ?`,
            instanceId,
            unit,
            actionId,
          )
          .toArray()[0];
        if (!record) return;
        const parsed = JSON.parse(record.json);
        if (
          !isRecoveryAction(parsed) ||
          parsed.instanceId !== instance.id ||
          parsed.unit !== row.unit ||
          parsed.workflowId !== (row.recovery?.workflowId ?? row.recoveryReceipt?.workflowId) ||
          (row.recovery ? parsed.state !== "pending" : parsed.state !== "settled")
        )
          return;
        action = parsed;
      }
      return { instance, unit: row, ...(action ? { action } : {}) };
    } catch {
      return;
    }
  }

  private async coordinatorNativeStatus(id: string): Promise<string | "absent" | undefined> {
    if (!this.env.SHIP_COORDINATOR) return;
    try {
      const result = await (await this.env.SHIP_COORDINATOR.get(id)).status();
      return typeof result.status === "string" ? result.status : undefined;
    } catch (error) {
      return isInstanceNotFound(error instanceof Error ? error.message : String(error)) ? "absent" : undefined;
    }
  }

  private async armCoordinatorReconciliation(now: number): Promise<void> {
    if (!this.sql.exec(`SELECT 1 FROM coordinator_units LIMIT 1`).toArray().length) return;
    this.sql.exec(
      `INSERT OR IGNORE INTO meta (key, value) VALUES ('coordinator_reconcile_due', ?)`,
      String(now + this.planeReaskMs()),
    );
    await this.ensurePlaneAlarm(now);
  }

  /** Discovery only: native ended status offers settlement; it never fabricates
   * a final ending or replaces a report admitted by the original writer. */
  async offerCoordinatorReconciliation(instanceId: string, unit: string, now: number): Promise<{ offered: boolean }> {
    const before = this.coordinatorSnapshot(instanceId, unit);
    if (!before || before.instance.kind === "maintenance") return { offered: false };
    const effect = await coordinatorReconciliationEffect(before.instance, before.unit, before.action);
    if (this.sql.exec(`SELECT 1 FROM plane_effects WHERE id = ?`, effect.id).toArray().length)
      return { offered: false };
    const status = await this.coordinatorNativeStatus(effect.workflowId);
    const after = this.coordinatorSnapshot(instanceId, unit);
    if (!after || JSON.stringify(after) !== JSON.stringify(before)) return { offered: false };
    if (
      status === "absent" &&
      before.unit.recovery &&
      before.action?.state === "pending" &&
      !coordinatorWorkflowCanReconcile(before.instance, before.unit, before.action, status)
    ) {
      if (
        before.unit.currentEffect?.execution.workflowId === effect.workflowId ||
        this.sql
          .exec(
            `SELECT 1 FROM run_events WHERE json_extract(json, '$.type') = 'coordinator_tag' AND json_extract(json, '$.transportWorkflowId') = ? LIMIT 1`,
            effect.workflowId,
          )
          .toArray().length
      )
        return { offered: false };
      const { recovery: claim, ...retained } = before.unit;
      let restored: CoordinatorUnit = { ...retained, ending: claim.previousEnding };
      if (claim.previousBinding !== undefined) {
        const { publication: _publication, lastPush: _lastPush, ...original } = restored;
        restored = { ...original, ...claim.previousBinding };
      }
      // Absence consumes no execution/source evidence, refunds no allowance,
      // and retires only this journal action's delayed-create authority.
      await this.transitionRecovery(
        {
          kind: "refuse",
          expected: before.unit,
          replacement: restored,
          error: "workflow_absent",
          consumed: false,
        },
        now,
      );
      return { offered: false };
    }
    // The same native ID is not attribution of an unanswered create. An exact
    // durable effect execution is affirmative saved evidence; status alone is not.
    if (before.instance.admission === "unreconciled") {
      if (
        !coordinatorExecutionWasStarted(before.unit, effect.workflowId, effect.actionId) ||
        !["queued", "running", "paused", "waiting", "waitingForPause", "complete", "errored", "terminated"].includes(
          status ?? "",
        )
      )
        return { offered: false };
      if (!(await this.confirmInstanceCreated(before.instance)).ok) return { offered: false };
      before.instance = { ...before.instance, admission: "created" };
    }
    if (!coordinatorWorkflowCanReconcile(before.instance, before.unit, before.action, status))
      return { offered: false };
    if (
      !(await coordinatorReportCanReconcile(
        {
          readSessionEntry: async (key: string, rowId: string) =>
            this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).readEntry(rowId),
        },
        before.instance,
        before.unit,
        before.action,
      ))
    )
      return { offered: false };
    let offered = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.coordinatorSnapshot(instanceId, unit);
      if (!current || JSON.stringify(current) !== JSON.stringify(before)) return;
      // An acknowledged request is a retained finalization receipt, not a new
      // offer. Reopening it on every scan would loop forever on ended rows.
      if (this.sql.exec(`SELECT 1 FROM plane_effects WHERE id = ?`, effect.id).toArray().length) return;
      this.applyPlaneWrites([{ table: "plane_effects", op: "offer", effect, at: now }]);
      offered = true;
    });
    await this.armCoordinatorReconciliation(now);
    if (offered) this.pushPlaneEffects([effect]);
    return { offered };
  }

  /** A bounded worklist survives bot outages independently of physical history
   * maintenance and user nudges. Cursor and due live in the existing meta. */
  private async discoverCoordinatorWorkflows(now: number): Promise<void> {
    const cursor = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'coordinator_reconcile_cursor'`)
      .toArray()[0];
    let after: [string, string] = ["", ""];
    try {
      if (cursor) {
        const value = JSON.parse(cursor.value);
        if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string"))
          after = value as [string, string];
      }
    } catch {
      /* Restart a malformed cursor without guessing owner state. */
    }
    const rows = this.sql
      .exec<{ instance_id: string; unit: string }>(
        `SELECT instance_id, unit FROM coordinator_units WHERE instance_id > ? OR (instance_id = ? AND unit > ?) ORDER BY instance_id, unit LIMIT ?`,
        after[0],
        after[0],
        after[1],
        COORDINATOR_SCAN_LIMIT,
      )
      .toArray();
    for (const row of rows) {
      try {
        await this.offerCoordinatorReconciliation(row.instance_id, row.unit, now);
      } catch (error) {
        console.warn(
          "[coordinator/reconcile] discovery retained an unavailable owner",
          error instanceof Error ? error.name : "unavailable",
        );
      }
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('coordinator_reconcile_cursor', ?)`,
      JSON.stringify(rows.length === COORDINATOR_SCAN_LIMIT ? [rows.at(-1)!.instance_id, rows.at(-1)!.unit] : ["", ""]),
    );
    if (this.sql.exec(`SELECT 1 FROM coordinator_units LIMIT 1`).toArray().length)
      this.sql.exec(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('coordinator_reconcile_due', ?)`,
        String(now + this.planeReaskMs()),
      );
    else this.sql.exec(`DELETE FROM meta WHERE key IN ('coordinator_reconcile_due', 'coordinator_reconcile_cursor')`);
    // Unsupported move effects must not hide report obligations behind the
    // general answer's oldest entries when the bot returns after an outage.
    const deliveryCursor =
      this.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'coordinator_reconcile_delivery_cursor'`)
        .toArray()[0]?.value ?? "";
    const pending = this.sql
      .exec<{ body_json: string }>(
        `SELECT body_json FROM plane_effects WHERE acked_at IS NULL AND json_extract(body_json, '$.kind') = 'coordinator_reconcile' AND id > ? ORDER BY id LIMIT ?`,
        deliveryCursor,
        PLANE_EFFECTS_PER_ANSWER,
      )
      .toArray()
      .map((row) => JSON.parse(row.body_json) as CoordinatorReconcileEffect);
    this.sql.exec(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('coordinator_reconcile_delivery_cursor', ?)`,
      pending.length === PLANE_EFFECTS_PER_ANSWER ? pending.at(-1)!.id : "",
    );
    this.pushPlaneEffects(pending);
  }

  private pendingCoordinatorReport(current: CoordinatorUnit | undefined, next: CoordinatorUnit): boolean {
    if (
      !current?.ending ||
      (current.reportDelivery === undefined &&
        isCoordinatorReportAdmission(next.reportDelivery) &&
        JSON.stringify(current) === JSON.stringify({ ...next, reportDelivery: undefined })) ||
      (JSON.stringify(current.ending) === JSON.stringify(next.ending) &&
        JSON.stringify(current.reportDelivery) === JSON.stringify(next.reportDelivery))
    )
      return false;
    return (
      this.sql
        .exec(
          `SELECT 1 FROM plane_effects WHERE acked_at IS NULL AND json_extract(body_json, '$.kind') = 'coordinator_reconcile' AND json_extract(body_json, '$.instanceId') = ? AND json_extract(body_json, '$.unit') = ? LIMIT 1`,
          next.instanceId,
          next.unit,
        )
        .toArray().length > 0
    );
  }

  async ackCoordinatorReconciliation(
    id: string,
    receipt: CoordinatorReconcileReceipt,
    now: number,
  ): Promise<{ ok: boolean }> {
    const offered = this.sql
      .exec<{ body_json: string }>(`SELECT body_json FROM plane_effects WHERE id = ? AND acked_at IS NULL`, id)
      .toArray()[0];
    if (!offered) return { ok: true };
    const effect: unknown = JSON.parse(offered.body_json);
    if (!isCoordinatorReconcileEffect(effect) || !isCoordinatorReconcileReceipt(receipt)) return { ok: false };
    const before = this.coordinatorSnapshot(effect.instanceId, effect.unit);
    if (
      !before ||
      !before.unit.ending ||
      before.unit.recovery ||
      before.unit.idle ||
      (before.unit.currentEffect && before.unit.currentEffect.phase !== "settled") ||
      JSON.stringify(await coordinatorReconciliationEffect(before.instance, before.unit, before.action)) !==
        JSON.stringify(effect) ||
      !(await sameCoordinatorReportAdmission(before.unit.reportDelivery, receipt.reportDelivery)) ||
      !sameCoordinatorReportOwner(receipt.reportDelivery.owner, receipt.status)
    )
      return { ok: false };
    const owner = receipt.reportDelivery.owner;
    if (
      owner.requester !== before.instance.userId ||
      owner.channelId !== before.instance.channelId ||
      owner.attempt !== (before.instance.attempt ?? 0) ||
      owner.threadKey !==
        (before.unit.workBrief
          ? privateWorkerThreadKey(before.unit)
          : (before.unit.threadKey ?? before.instance.threadKey)) ||
      owner.deliveryId !==
        (effect.actionId !== undefined
          ? `recovery:${effect.workflowId}:${before.unit.ending.deliveryId}`
          : before.unit.ending.deliveryId) ||
      receipt.status.destinationThreadKey !== (before.unit.workBrief?.mainThreadKey ?? owner.threadKey)
    )
      return { ok: false };
    const ledger = {
      readSessionEntry: async (key: string, rowId: string) =>
        this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).readEntry(rowId),
    };
    const frozen = await readCoordinatorReport(ledger, owner),
      status = await readCoordinatorStatus(ledger, receipt.status);
    if (
      !frozen ||
      !status ||
      before.unit.ending.report !== frozen.text ||
      !(await sameCoordinatorReportAdmission(
        receipt.reportDelivery,
        await coordinatorReportAdmission(owner, frozen),
      )) ||
      status.observedAt !== before.unit.ending.at ||
      status.repo !== before.instance.repo.toLowerCase()
    )
      return { ok: false };
    if (before.unit.workBrief) {
      if (receipt.publicDelivery !== undefined) return { ok: false };
      if (!receipt.privateReplyId || before.unit.ending.deliveryId !== receipt.privateReplyId) return { ok: false };
      const reply = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM coordinator_private_worker_events WHERE thread_key = ? AND event_id = ?`,
          owner.threadKey,
          receipt.privateReplyId,
        )
        .toArray()[0];
      if (!reply) return { ok: false };
      const event = JSON.parse(reply.json);
      if (event.kind !== "reply" || event.text !== frozen.text) return { ok: false };
    } else {
      if (receipt.privateReplyId !== undefined || receipt.publicDelivery === undefined) return { ok: false };
      const expected = await coordinatorPublicDeliveryReference(receipt.reportDelivery, frozen.threadText);
      if (
        receipt.publicDelivery.proposalHash !== expected.proposalHash ||
        receipt.publicDelivery.threadHash !== expected.threadHash ||
        receipt.publicDelivery.kind !== expected.kind ||
        !sameCoordinatorReportOwner(receipt.publicDelivery.owner, expected.owner)
      )
        return { ok: false };
      try {
        if (!(await readCoordinatorPublicDelivery(ledger, expected))) return { ok: false };
      } catch {
        return { ok: false };
      }
    }
    if (
      !coordinatorWorkflowCanReconcile(
        before.instance,
        before.unit,
        before.action,
        await this.coordinatorNativeStatus(effect.workflowId),
      )
    )
      return { ok: false };
    let ok = false;
    this.ctx.storage.transactionSync(() => {
      if (JSON.stringify(this.coordinatorSnapshot(effect.instanceId, effect.unit)) !== JSON.stringify(before)) return;
      if (
        this.sql
          .exec<{ body_json: string }>(`SELECT body_json FROM plane_effects WHERE id = ? AND acked_at IS NULL`, id)
          .toArray()[0]?.body_json !== offered.body_json
      )
        return;
      this.sql.exec(`UPDATE plane_effects SET acked_at = ? WHERE id = ? AND acked_at IS NULL`, now, id);
      ok = true;
    });
    return { ok };
  }

  async recordRequesterTurn(
    input: RequesterTurnInput,
  ): Promise<{ ok: true; turn: RequesterTurn } | { ok: false; reason: "conflict" }> {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec<{
          message_id: string;
          revision: number;
          question_target: string | null;
          prior_question_target: string | null;
        }>(
          `SELECT message_id, revision, question_target, prior_question_target
           FROM coordinator_requester_turns WHERE thread_key = ? AND requester_id = ?
           ORDER BY revision DESC LIMIT 1`,
          input.threadKey,
          input.requesterId,
        )
        .toArray();
      const previous = rows[0];
      if (previous?.message_id === input.messageId) {
        if ((previous.question_target ?? undefined) !== input.questionTarget) return { ok: false, reason: "conflict" };
        return {
          ok: true,
          turn: {
            ...input,
            revision: previous.revision,
            ...(previous.prior_question_target ? { priorQuestionTarget: previous.prior_question_target } : {}),
          },
        };
      }
      if (previous && compareSlackMessageId(input.messageId, previous.message_id) <= 0)
        return { ok: false, reason: "conflict" };
      const revision = (previous?.revision ?? 0) + 1;
      const priorQuestionTarget = previous?.question_target ?? undefined;
      this.sql.exec(
        `INSERT INTO coordinator_requester_turns
         (thread_key, requester_id, message_id, revision, question_target, prior_question_target)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.threadKey,
        input.requesterId,
        input.messageId,
        revision,
        input.questionTarget ?? null,
        priorQuestionTarget ?? null,
      );
      return {
        ok: true,
        turn: { ...input, revision, ...(priorQuestionTarget ? { priorQuestionTarget } : {}) },
      };
    });
  }

  async latestRequesterTurn(key: { threadKey: string; requesterId: string }): Promise<RequesterTurn | null> {
    const row = this.sql
      .exec<{
        message_id: string;
        revision: number;
        question_target: string | null;
        prior_question_target: string | null;
      }>(
        `SELECT message_id, revision, question_target, prior_question_target
         FROM coordinator_requester_turns WHERE thread_key = ? AND requester_id = ?
         ORDER BY revision DESC LIMIT 1`,
        key.threadKey,
        key.requesterId,
      )
      .toArray()[0];
    return row
      ? {
          ...key,
          messageId: row.message_id,
          revision: row.revision,
          ...(row.question_target ? { questionTarget: row.question_target } : {}),
          ...(row.prior_question_target ? { priorQuestionTarget: row.prior_question_target } : {}),
        }
      : null;
  }

  async getMainTask(key: {
    mainThreadKey: string;
    actId: string;
  }): Promise<{ instanceId: string; unit: string; authority?: MainTaskAuthority } | null> {
    return (
      this.sql
        .exec<{
          instance_id: string;
          unit: string;
          requester_id: string | null;
          source_message_id: string | null;
          revision: number | null;
          repo: string | null;
        }>(
          `SELECT l.instance_id, l.unit, a.requester_id, a.source_message_id, a.revision, a.repo
           FROM coordinator_main_task_links l LEFT JOIN coordinator_main_task_authority a
           ON a.main_thread_key = l.main_thread_key AND a.act_id = l.act_id
           WHERE l.main_thread_key = ? AND l.act_id = ?`,
          key.mainThreadKey,
          key.actId,
        )
        .toArray()
        .map((row) => ({
          instanceId: row.instance_id,
          unit: row.unit,
          ...(row.requester_id && row.source_message_id && row.revision && row.repo
            ? {
                authority: {
                  requesterId: row.requester_id,
                  sourceMessageId: row.source_message_id,
                  revision: row.revision,
                  repo: row.repo,
                },
              }
            : {}),
        }))[0] ?? null
    );
  }

  /** The main decision is only an index. Its Ship instance and unit become
   * visible in the same transaction, so replay never points at a partial task. */
  async appendPrivateWorkerEvent(
    threadKey: string,
    event: PrivateWorkerEventInput,
  ): Promise<PrivateWorkerEvent | null> {
    return this.ctx.storage.transactionSync(() => {
      if ((event.kind === "input" || event.kind === "reply") && event.id !== undefined) {
        const prior = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM coordinator_private_worker_events WHERE thread_key = ? AND event_id = ?`,
            threadKey,
            event.id,
          )
          .toArray()[0];
        if (prior) {
          const row = JSON.parse(prior.json) as PrivateWorkerEvent;
          const same =
            row.kind === event.kind &&
            (event.kind === "input"
              ? row.kind === "input" &&
                row.sender === event.sender &&
                row.text === event.text &&
                row.textSha256 === event.textSha256
              : row.kind === "reply" && row.text === event.text && row.runId === event.runId);
          if (!same) return null;
          return row;
        }
      }
      const last = this.sql
        .exec<{ seq: number }>(
          `SELECT seq FROM coordinator_private_worker_events WHERE thread_key = ? ORDER BY seq DESC LIMIT 1`,
          threadKey,
        )
        .toArray()[0];
      const seq = (last?.seq ?? 0) + 1;
      const row: PrivateWorkerEvent = {
        ...event,
        seq,
        ...(event.kind === "status" && event.phase === "start" ? { statusSeq: seq } : {}),
      };
      this.sql.exec(
        `INSERT INTO coordinator_private_worker_events (thread_key, seq, event_id, json) VALUES (?, ?, ?, ?)`,
        threadKey,
        seq,
        event.kind === "input" || event.kind === "reply" ? (event.id ?? null) : null,
        JSON.stringify(row),
      );
      return row;
    });
  }

  async listPrivateWorkerEvents(threadKey: string): Promise<PrivateWorkerEvent[]> {
    return this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_private_worker_events WHERE thread_key = ? ORDER BY seq ASC`,
        threadKey,
      )
      .toArray()
      .map((row) => JSON.parse(row.json) as PrivateWorkerEvent);
  }

  async listPrivateWorkerEventsAfter(
    threadKey: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ events: PrivateWorkerEvent[]; more: boolean }> {
    const rows = this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_private_worker_events WHERE thread_key = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        threadKey,
        afterSeq,
        limit + 1,
      )
      .toArray();
    return {
      events: rows.slice(0, limit).map((row) => JSON.parse(row.json) as PrivateWorkerEvent),
      more: rows.length > limit,
    };
  }

  async claimMainTask(
    key: { mainThreadKey: string; actId: string },
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
    authority: MainTaskAuthority,
    now: number,
  ): Promise<
    | { ok: true; created: boolean; link: { instanceId: string; unit: string; authority: MainTaskAuthority } }
    | {
        ok: false;
        reason: "conflict" | PullBindingRefusal;
      }
  > {
    const result = await this.withRangePins(
      [{ id: `@unit:${unit.instanceId}:${unit.unit}`, handoff: unit.context?.handoff }],
      async () => {
        let out:
          | { ok: true; created: boolean; link: { instanceId: string; unit: string; authority: MainTaskAuthority } }
          | {
              ok: false;
              reason: "conflict" | PullBindingRefusal;
            } = {
          ok: false,
          reason: "conflict",
        };
        this.ctx.storage.transactionSync(() => {
          const prior = this.sql
            .exec<{
              instance_id: string;
              unit: string;
              requester_id: string | null;
              source_message_id: string | null;
              revision: number | null;
              repo: string | null;
            }>(
              `SELECT l.instance_id, l.unit, a.requester_id, a.source_message_id, a.revision, a.repo
           FROM coordinator_main_task_links l LEFT JOIN coordinator_main_task_authority a
           ON a.main_thread_key = l.main_thread_key AND a.act_id = l.act_id
           WHERE l.main_thread_key = ? AND l.act_id = ?`,
              key.mainThreadKey,
              key.actId,
            )
            .toArray()[0];
          if (prior) {
            const saved =
              prior.requester_id && prior.source_message_id && prior.revision && prior.repo
                ? {
                    requesterId: prior.requester_id,
                    sourceMessageId: prior.source_message_id,
                    revision: prior.revision,
                    repo: prior.repo,
                  }
                : undefined;
            if (sameMainTaskAuthority(saved, authority))
              out = {
                ok: true,
                created: false,
                link: { instanceId: prior.instance_id, unit: prior.unit, authority },
              };
            return;
          }
          const current = this.sql
            .exec<{ message_id: string; revision: number }>(
              `SELECT message_id, revision FROM coordinator_requester_turns
           WHERE thread_key = ? AND requester_id = ? ORDER BY revision DESC LIMIT 1`,
              key.mainThreadKey,
              authority.requesterId,
            )
            .toArray()[0];
          if (
            !current ||
            current.message_id !== authority.sourceMessageId ||
            current.revision !== authority.revision ||
            authority.requesterId !== instance.userId ||
            authority.repo.toLowerCase() !== instance.repo.toLowerCase() ||
            unit.instanceId !== instance.id ||
            unit.currentEffect !== undefined ||
            this.sql.exec(`SELECT 1 FROM coordinator_instances WHERE instance_id = ?`, instance.id).toArray().length > 0
          )
            return;
          const reason = this.bindingRefusal(undefined, unit, true, [], instance);
          if (reason) {
            out = { ok: false, reason };
            return;
          }
          this.pinUnitContext(unit, undefined, now);
          this.sql.exec(
            `INSERT INTO coordinator_instances (instance_id, json, created_at) VALUES (?, ?, ?)`,
            instance.id,
            JSON.stringify(instance),
            instance.createdAt,
          );
          this.sql.exec(
            `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)`,
            unit.instanceId,
            unit.unit,
            JSON.stringify(unit),
            now,
          );
          this.sql.exec(
            `INSERT INTO coordinator_main_task_links (main_thread_key, act_id, instance_id, unit) VALUES (?, ?, ?, ?)`,
            key.mainThreadKey,
            key.actId,
            instance.id,
            unit.unit,
          );
          this.sql.exec(
            `INSERT INTO coordinator_main_task_authority
         (main_thread_key, act_id, requester_id, source_message_id, revision, repo) VALUES (?, ?, ?, ?, ?, ?)`,
            key.mainThreadKey,
            key.actId,
            authority.requesterId,
            authority.sourceMessageId,
            authority.revision,
            authority.repo,
          );
          out = { ok: true, created: true, link: { instanceId: instance.id, unit: unit.unit, authority } };
        });
        return out;
      },
    );
    if (result.ok) await this.armCoordinatorReconciliation(now);
    return result;
  }

  /** Idempotent for the same record; a different record under a taken id is refused. */
  async putInstance(instance: CoordinatorInstance): Promise<{ ok: true } | { ok: false; reason: "exists" }> {
    let out: { ok: true } | { ok: false; reason: "exists" } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const text = JSON.stringify(instance);
      const existing = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, instance.id)
        .toArray()[0];
      if (existing) {
        if (existing.json !== text) out = { ok: false, reason: "exists" };
        return;
      }
      this.sql.exec(
        `INSERT INTO coordinator_instances (instance_id, json, created_at) VALUES (?, ?, ?)`,
        instance.id,
        text,
        instance.createdAt,
      );
    });
    return out;
  }

  /** The record written over whatever the id holds and the id's unit rows
   *  dropped, in one transaction — an attempt starting over: the leftover of one
   *  whose Workflow instance was never created, once the shim said so. */
  async replaceInstance(instance: CoordinatorInstance): Promise<{ ok: true } | { ok: false; reason: "exists" }> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      let out: { ok: true } | { ok: false; reason: "exists" } = { ok: true };
      this.ctx.storage.transactionSync(() => {
        if (
          this.sql.exec(`SELECT 1 FROM coordinator_main_task_links WHERE instance_id = ?`, instance.id).toArray()
            .length > 0 ||
          this.sql
            .exec<{ json: string }>(`SELECT json FROM coordinator_units WHERE instance_id = ?`, instance.id)
            .toArray()
            .some((row) => !coordinatorUnitCanBeDiscarded(row.json)) ||
          this.sql
            .exec(`SELECT 1 FROM coordinator_recovery_journal WHERE instance_id = ? LIMIT 1`, instance.id)
            .toArray().length > 0
        ) {
          out = { ok: false, reason: "exists" };
          return;
        }
        this.sql.exec(
          `INSERT INTO coordinator_instances (instance_id, json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
          instance.id,
          JSON.stringify(instance),
          instance.createdAt,
        );
        this.sql.exec(
          `DELETE FROM context_refs WHERE holder_run_id IN (SELECT '@unit:' || instance_id || ':' || unit FROM coordinator_units WHERE instance_id = ?)`,
          instance.id,
        );
        this.sql.exec(`DELETE FROM coordinator_units WHERE instance_id = ?`, instance.id);
      });
      return out;
    });
    if (result.ok) await this.syncRangePins();
    return result;
  }

  /** Confirm only the exact record whose create returned success. Keep its unit
   * rows; a replaced owner or a duplicate that predated the record stays
   * unreconciled across bot restarts. */
  async confirmInstanceCreated(expected: CoordinatorInstance): Promise<{ ok: true } | { ok: false; reason: "stale" }> {
    let out: { ok: true } | { ok: false; reason: "stale" } = { ok: false, reason: "stale" };
    this.ctx.storage.transactionSync(() => {
      const current = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, expected.id)
        .toArray()[0]?.json;
      const confirmed = JSON.stringify({ ...expected, admission: "created" });
      if (current === confirmed) {
        out = { ok: true };
        return;
      }
      if (expected.admission !== "unreconciled" || current !== JSON.stringify(expected)) return;
      this.sql.exec(`UPDATE coordinator_instances SET json = ? WHERE instance_id = ?`, confirmed, expected.id);
      out = { ok: true };
    });
    return out;
  }

  async getInstance(id: string): Promise<CoordinatorInstance | null> {
    const row = this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, id)
      .toArray()[0];
    return row ? (JSON.parse(row.json) as CoordinatorInstance) : null;
  }

  /** The hard stop's mark on the instance row (record 0060; issue 1924).
   *  Idempotent: a marked row keeps its first mark. */
  private currentMainTaskBindingMatches(
    binding: MainTaskBinding,
    instance: CoordinatorInstance,
    unit: CoordinatorUnit | undefined,
  ): boolean {
    const link = this.sql
      .exec<{ instance_id: string; unit: string }>(
        `SELECT instance_id, unit FROM coordinator_main_task_links WHERE main_thread_key = ? AND act_id = ?`,
        binding.key.mainThreadKey,
        binding.key.actId,
      )
      .toArray()[0];
    return mainTaskBindingMatches(
      binding,
      link ? { instanceId: link.instance_id, unit: link.unit } : null,
      instance,
      unit,
    );
  }

  async markInstanceStopped(
    id: string,
    at: number,
    binding?: MainTaskBinding,
  ): Promise<{ ok: true } | { ok: false; reason: "unknown_instance" | "stale" }> {
    let out: { ok: true } | { ok: false; reason: "unknown_instance" | "stale" } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, id)
        .toArray()[0];
      if (!row) {
        out = { ok: false, reason: "unknown_instance" };
        return;
      }
      const instance = JSON.parse(row.json) as CoordinatorInstance;
      if (binding !== undefined) {
        const unitText = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
            binding.instanceId,
            binding.unit,
          )
          .toArray()[0]?.json;
        const unit = unitText ? (JSON.parse(unitText) as CoordinatorUnit) : undefined;
        if (binding.instanceId !== id || !this.currentMainTaskBindingMatches(binding, instance, unit)) {
          out = { ok: false, reason: "stale" };
          return;
        }
      }
      if (instance.stop !== undefined) return;
      this.sql.exec(
        `UPDATE coordinator_instances SET json = ? WHERE instance_id = ?`,
        JSON.stringify({ ...instance, stop: { at } }),
        id,
      );
    });
    return out;
  }

  // ---- decision-record reservations (agent-ship item 16) ---------------------

  /** One atomic durable allocation across bot processes. Existing unit and run
   * rows seed the claim set for reservations written before this ledger existed. */
  async reserveDecisionRecord(
    repo: string,
    taskKey: string,
    claimed: string[],
    existing: string | undefined,
    now: number,
  ): Promise<{ number: string }> {
    let number = "";
    this.ctx.storage.transactionSync(() => {
      const prior = this.sql
        .exec<{ number: string }>(
          `SELECT number FROM decision_record_reservations WHERE repo = ? AND task_key = ?`,
          repo,
          taskKey,
        )
        .toArray()[0];
      if (prior !== undefined) {
        number = prior.number;
        return;
      }

      const used = new Set(claimed);
      for (const row of this.sql
        .exec<{ number: string }>(`SELECT number FROM decision_record_reservations WHERE repo = ?`, repo)
        .toArray())
        used.add(row.number);
      for (const row of this.sql
        .exec<{ instance_json: string; unit_json: string }>(
          `SELECT i.json AS instance_json, u.json AS unit_json
             FROM coordinator_units u JOIN coordinator_instances i ON i.instance_id = u.instance_id`,
        )
        .toArray()) {
        const instance = JSON.parse(row.instance_json) as CoordinatorInstance;
        const unit = JSON.parse(row.unit_json) as CoordinatorUnit;
        if (instance.repo === repo && unit.record !== undefined) used.add(unit.record);
      }
      for (const row of this.sql
        .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE repo = ?`, repo)
        .toArray()) {
        const record = JSON.parse(row.summary_json) as { record?: unknown };
        if (typeof record.record === "string" && /^\d{4}$/.test(record.record)) used.add(record.record);
      }
      for (const row of this.sql.exec<{ meta_json: string }>(`SELECT meta_json FROM live_runs`).toArray()) {
        const meta = JSON.parse(row.meta_json) as { repo?: unknown; record?: unknown };
        if (meta.repo === repo && typeof meta.record === "string" && /^\d{4}$/.test(meta.record)) used.add(meta.record);
      }

      const highest = [...used].reduce((max, value) => (/^\d{4}$/.test(value) ? Math.max(max, Number(value)) : max), 0);
      number = existing ?? String(highest + 1).padStart(4, "0");
      if (!/^\d{4}$/.test(number)) throw new Error(`decision-record numbers exhausted for ${repo}`);
      this.sql.exec(
        `INSERT INTO decision_record_reservations (repo, task_key, number, created_at) VALUES (?, ?, ?, ?)`,
        repo,
        taskKey,
        number,
        now,
      );
    });
    return { number };
  }

  // ---- the units of the plan an instance runs (run-history item 50) -----------

  private bindingRefusal(
    current: CoordinatorUnit | undefined,
    next: CoordinatorUnit,
    force = false,
    staged: readonly CoordinatorUnit[] = [],
    owner?: CoordinatorInstance,
  ): PullBindingRefusal | undefined {
    const diagnostics: PullOwnershipDiagnostics = {};
    let stage: PullOwnershipCheck = "instance_read";
    const report = (reason: PullBindingRefusal, check?: PullOwnershipCheck): PullBindingRefusal => {
      console.log(
        JSON.stringify({
          event: "coordinator_unit_admission_refused",
          instanceId: next.instanceId,
          unit: next.unit,
          reason,
          diagnostic: diagnostics.failure ?? { check: check ?? stage },
          ...(diagnostics.scan ? { scan: diagnostics.scan } : {}),
        }),
      );
      return reason;
    };
    if (this.pendingCoordinatorReport(current, next)) return report("stale", "pending_report");
    force ||= current?.startedAt === undefined && next.startedAt !== undefined;
    if (!force && !needsPullBindingAdmission(current, next)) return;
    try {
      const saved =
        owner === undefined
          ? this.sql
              .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, next.instanceId)
              .toArray()[0]
          : undefined;
      const instance = owner ?? (saved ? JSON.parse(saved.json) : null);
      if (!isCoordinatorInstance(instance)) return report("incomplete", "instance_shape");
      if (!force && !pullBindingChanges(instance, current, next)) return;
      stage = "ownership_scan";
      const rows = this.pullOwnershipRows(diagnostics, next.adoption?.audit ? next : undefined);
      for (const unit of staged) {
        const saved = this.sql
          .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, unit.instanceId)
          .toArray()[0];
        rows.units.push({ unit, instance: saved ? JSON.parse(saved.json) : null });
      }
      stage = "binding_validation";
      const reason = unitPullBindingRefusal(rows, instance, current, next, diagnostics);
      return reason === undefined ? undefined : report(reason);
    } catch {
      return report("incomplete");
    }
  }

  private writeUnfencedUnit(
    write: () => PullBindingRefusal | undefined,
  ): { ok: true } | { ok: false; reason: "settled" | PullBindingRefusal } {
    try {
      const reason = this.ctx.storage.transactionSync(write);
      return reason ? { ok: false, reason } : { ok: true };
    } catch (error) {
      if (error instanceof CoordinatorUnitWriteConflict) return { ok: false, reason: "settled" };
      throw error;
    }
  }

  /** Each row replaced whole under its (instance, unit); a replace keeps the row's place. */
  async putUnits(
    units: CoordinatorUnit[],
    now: number,
  ): Promise<{ ok: true } | { ok: false; reason: "settled" | PullBindingRefusal }> {
    const result = await this.withRangePins(
      units.map((unit) => ({ id: `@unit:${unit.instanceId}:${unit.unit}`, handoff: unit.context?.handoff })),
      async () =>
        this.writeUnfencedUnit(() => {
          const pending = new Map<string, { current: CoordinatorUnit | undefined; next: CoordinatorUnit }>();
          for (const unit of units) {
            const key = `${unit.instanceId}\0${unit.unit}`;
            const row = this.sql
              .exec<{ json: string }>(
                `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
                unit.instanceId,
                unit.unit,
              )
              .toArray()[0];
            const current = row ? (JSON.parse(row.json) as CoordinatorUnit) : undefined;
            const prior = pending.get(key);
            pending.set(key, { current, next: prepareUnfencedUnitWrite(prior?.next ?? current, unit) });
          }
          const staged = [...pending.values()].map((row) => row.next);
          for (const { current, next } of pending.values()) {
            const reason = this.bindingRefusal(current, next, false, staged);
            if (reason) return reason;
          }
          for (const { current, next } of pending.values()) {
            this.pinUnitContext(next, current, now);
            this.sql.exec(
              `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(instance_id, unit) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
              next.instanceId,
              next.unit,
              JSON.stringify(next),
              now,
            );
          }
        }),
    );
    if (result.ok) await this.armCoordinatorReconciliation(now);
    return result;
  }

  /** One compare-and-replace transaction updates a unit for exactly one
   * caller. The whole expected JSON is the fence: any intervening unit write
   * makes this caller stale. */
  private adoptionAuditInput(expected: CoordinatorUnit, runId: string): HistoricalAuditInput | undefined {
    try {
      if (!isCoordinatorUnit(expected)) return;
      const unitRow = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
          expected.instanceId,
          expected.unit,
        )
        .toArray()[0];
      if (unitRow?.json !== JSON.stringify(expected)) return;
      const instanceRow = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, expected.instanceId)
        .toArray()[0];
      const instance = instanceRow && JSON.parse(instanceRow.json);
      if (!isCoordinatorInstance(instance)) return;
      const key = `${instance.id}:${expected.unit}/`;
      const thread = expected.threadKey ?? instance.threadKey;
      const rows = this.pullOwnershipRows();
      const children = rows.runs.filter((row) => {
        const record = row.record as
          { idempotencyKey?: string; parentInstanceId?: string; threadKey?: string } | undefined;
        return (
          (expected.adoption?.audit
            ? record?.idempotencyKey === `${key}0/coding`
            : record?.idempotencyKey?.startsWith(key)) ||
          (record?.idempotencyKey === undefined &&
            record?.parentInstanceId === instance.id &&
            record?.threadKey === thread)
        );
      });
      if (children.length !== 1 || children[0]?.runId !== runId || this.liveRow(runId)) return;
      const record = this.canonicalRun(runId, true);
      return record ? { instance, unit: expected, record, events: record.events } : undefined;
    } catch {
      return undefined;
    }
  }

  async prepareAdoptionAudit(expected: CoordinatorUnit, runId: string): Promise<HistoricalNativeAudit | undefined> {
    const input = this.adoptionAuditInput(expected, runId);
    return input && (await prepareHistoricalNativeAudit(input, expected.adoption?.audit !== undefined))?.audit;
  }

  async compareAndReplaceUnit(
    expected: CoordinatorUnit,
    replacement: CoordinatorUnit,
    now: number,
  ): Promise<{ ok: true } | { ok: false; reason: PullBindingRefusal }> {
    const input = replacement.adoption?.audit && this.adoptionAuditInput(expected, replacement.adoption.runId);
    const prepared = input
      ? await prepareHistoricalNativeAudit(input, expected.adoption?.audit !== undefined)
      : undefined;
    if (
      replacement.adoption?.audit &&
      (!prepared || JSON.stringify(prepared.audit) !== JSON.stringify(replacement.adoption.audit))
    )
      return { ok: false, reason: "incomplete" };
    let out: { ok: true } | { ok: false; reason: PullBindingRefusal } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
          expected.instanceId,
          expected.unit,
        )
        .toArray()[0];
      if (row?.json !== JSON.stringify(expected) || !permitsRecoveryMetadataWrite(expected, replacement, true)) {
        out = { ok: false, reason: "stale" };
        return;
      }
      if (
        replacement.adoption?.audit &&
        (!prepared ||
          JSON.stringify(this.adoptionAuditInput(expected, replacement.adoption.runId)) !== prepared.snapshot)
      ) {
        out = { ok: false, reason: "incomplete" };
        return;
      }
      const preserved = preserveWorkBrief(expected, replacement);
      const reason = this.bindingRefusal(expected, preserved);
      if (reason) {
        out = { ok: false, reason };
        return;
      }
      this.pinUnitContext(preserved, expected, now);
      this.sql.exec(
        `UPDATE coordinator_units SET json = ?, updated_at = ? WHERE instance_id = ? AND unit = ?`,
        JSON.stringify(preserved),
        now,
        expected.instanceId,
        expected.unit,
      );
    });
    return out;
  }

  async admitMaintenance(input: MaintenanceAdmissionInput, now: number): Promise<MaintenanceAdmissionResult> {
    const prepared = await prepareMaintenanceAdmission({ ...input, createdAt: now });
    let result: MaintenanceAdmissionResult = { ok: false, reason: "unavailable" };
    try {
      this.ctx.storage.transactionSync(() => {
        const records = this.sql
          .exec<{ instance_id: string; json: string }>(
            `SELECT instance_id, json FROM coordinator_instances LIMIT ?`,
            PULL_OWNER_SCAN_MAX + 1,
          )
          .toArray();
        if (
          records.length > PULL_OWNER_SCAN_MAX ||
          records.reduce((n, row) => n + row.json.length * 3, 0) > PULL_OWNER_SCAN_MAX_BYTES
        ) {
          result = { ok: false, reason: "incomplete" };
          return;
        }
        const instances = records.map((row) => {
          const instance = JSON.parse(row.json);
          if (!isCoordinatorInstance(instance) || instance.id !== row.instance_id)
            throw new Error("unreadable maintenance owner");
          return instance;
        });
        const planned = planMaintenanceAdmission(prepared, this.pullOwnershipRows(), instances);
        if (!planned.ok || planned.replayed) {
          result = planned;
          return;
        }
        this.sql.exec(
          `INSERT OR IGNORE INTO coordinator_instances (instance_id, json, created_at) VALUES (?, ?, ?)`,
          planned.instance.id,
          JSON.stringify(planned.instance),
          now,
        );
        this.sql.exec(
          `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(instance_id, unit) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
          planned.unit.instanceId,
          planned.unit.unit,
          JSON.stringify(planned.unit),
          now,
        );
        result = planned;
      });
    } catch {
      result = { ok: false, reason: "incomplete" };
    }
    return result;
  }

  async transitionUnitEffect(input: UnitEffectTransition, now: number): Promise<UnitEffectTransitionResult> {
    if (!isUnitEffectTransition(input)) return { ok: false, reason: "conflict" };
    let result: UnitEffectTransitionResult = { ok: false, reason: "unavailable" };
    this.ctx.storage.transactionSync(() => {
      const { instanceId, unit } = input.expected;
      const saved = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
          instanceId,
          unit,
        )
        .toArray()[0];
      const savedInstance = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, instanceId)
        .toArray()[0];
      let current: unknown, instance: unknown;
      try {
        current = saved ? JSON.parse(saved.json) : undefined;
        instance = savedInstance ? JSON.parse(savedInstance.json) : null;
      } catch {
        result = { ok: false, reason: "incomplete" };
        return;
      }
      if (
        (instance !== null && !isCoordinatorInstance(instance)) ||
        (current !== undefined && !isCoordinatorUnit(current))
      ) {
        result = { ok: false, reason: "incomplete" };
        return;
      }
      const runId = unitEffectRunId(input);
      let evidence: UnitEffectRunEvidence | undefined;
      if (runId !== undefined) {
        try {
          const live = this.sql
            .exec<{ meta_json: string; started_at: number; thread_key: string }>(
              `SELECT meta_json, started_at, thread_key FROM live_runs WHERE run_id = ?`,
              runId,
            )
            .toArray()[0];
          const finished = this.sql
            .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, runId)
            .toArray()[0];
          const liveMeta = live ? JSON.parse(live.meta_json) : undefined;
          const record = finished ? JSON.parse(finished.summary_json) : undefined;
          if (live && live.thread_key !== liveMeta?.threadKey) throw new Error("unreadable child claim");
          if (finished && (!isRunRecord({ ...record, events: [] }) || record.id !== runId))
            throw new Error("unreadable child receipt");
          if (live && finished && !unitEffectTombstoneMatches(liveMeta, live.started_at, record))
            throw new Error("ambiguous child receipt");
          const meta = liveMeta ?? (record?.provisional === true ? undefined : record);
          if (meta)
            evidence = {
              runId,
              meta,
              reviewTarget:
                liveMeta ??
                (() => {
                  const original = this.sql
                    .exec<{ json: string }>(
                      `SELECT json FROM run_events WHERE run_id = ? AND json_extract(json, '$.type') = 'run_meta' ORDER BY seq ASC LIMIT 1`,
                      runId,
                    )
                    .toArray()[0];
                  return original ? JSON.parse(original.json) : undefined;
                })(),
              startedAt: live?.started_at ?? meta.startedAt,
              tags: this.sql
                .exec<{ json: string }>(
                  `SELECT json FROM run_events WHERE run_id = ? AND json_extract(json, '$.type') = 'coordinator_tag' LIMIT 2`,
                  runId,
                )
                .toArray()
                .map((row) => JSON.parse(row.json)),
            };
        } catch {
          result = { ok: false, reason: "incomplete" };
          return;
        }
      }
      const planned = planUnitEffectTransition(input, instance, current, evidence);
      if (!planned.ok) {
        result = planned;
        return;
      }
      if (input.kind === "admit") {
        let reason: PullBindingRefusal | undefined;
        try {
          reason = unitPullTargetsRefusal(this.pullOwnershipRows(), instance!, planned.unit);
        } catch {
          reason = "incomplete";
        }
        if (reason) {
          result = { ok: false, reason };
          return;
        }
      }
      const maintenance = planned.unit.currentEffect?.execution.maintenance;
      if (input.kind === "begin" && maintenance) {
        const deadline = maintenance.admittedAt + minutesToMs(maintenance.bounds.leaseMinutes);
        if (!Number.isFinite(deadline) || now >= deadline) {
          result = { ok: false, reason: "stopped" };
          return;
        }
      }
      const serialized = JSON.stringify(planned.unit);
      this.sql.exec(
        `UPDATE coordinator_units SET json = ?, updated_at = ? WHERE instance_id = ? AND unit = ?`,
        serialized,
        now,
        instanceId,
        unit,
      );
      result = planned;
    });
    return result;
  }

  async transitionRecovery(input: RecoveryTransition, now: number): Promise<RecoveryTransitionResult> {
    const prepared = await prepareRecoveryTransition(input);
    let result: RecoveryTransitionResult = { ok: false, reason: "unavailable" };
    this.ctx.storage.transactionSync(() => {
      const { instanceId, unit } = input.expected;
      const saved = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
          instanceId,
          unit,
        )
        .toArray()[0];
      const instance = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, instanceId)
        .toArray()[0];
      const records = this.sql
        .exec<{ kind: string; json: string }>(
          `SELECT kind, json FROM coordinator_recovery_journal WHERE instance_id = ? AND unit = ?`,
          instanceId,
          unit,
        )
        .toArray();
      const brief = input.expected.workBrief;
      const mainTask = brief
        ? this.sql
            .exec<{ instanceId: string; unit: string }>(
              `SELECT instance_id AS instanceId, unit FROM coordinator_main_task_links WHERE main_thread_key = ? AND act_id = ?`,
              brief.mainThreadKey,
              brief.actId,
            )
            .toArray()[0]
        : undefined;
      const planned = planRecoveryTransition(
        prepared,
        instance ? JSON.parse(instance.json) : null,
        saved ? JSON.parse(saved.json) : undefined,
        {
          actions: records.filter((row) => row.kind === "action").map((row) => JSON.parse(row.json) as RecoveryAction),
          receipts: records
            .filter((row) => row.kind === "receipt")
            .map((row) => JSON.parse(row.json) as RecoveryReceipt),
          mainTask,
        },
      );
      if (!planned.ok) {
        result = planned;
        return;
      }
      if (input.kind === "claim" && !planned.replayed) {
        const reason = this.bindingRefusal(input.expected, planned.unit, true);
        if (reason) {
          result = { ok: false, reason };
          return;
        }
      }
      this.pinUnitContext(planned.unit, saved ? (JSON.parse(saved.json) as CoordinatorUnit) : undefined, now);
      if (planned.receipt)
        this.sql.exec(
          `INSERT INTO coordinator_recovery_journal (instance_id, unit, kind, id, json) VALUES (?, ?, 'receipt', ?, ?)`,
          instanceId,
          unit,
          planned.receipt.id,
          JSON.stringify(planned.receipt),
        );
      if (planned.action)
        this.sql.exec(
          `INSERT INTO coordinator_recovery_journal (instance_id, unit, kind, id, json) VALUES (?, ?, 'action', ?, ?) ON CONFLICT(instance_id, unit, kind, id) DO UPDATE SET json = excluded.json`,
          instanceId,
          unit,
          planned.action.id,
          JSON.stringify(planned.action),
        );
      this.sql.exec(
        `UPDATE coordinator_units SET json = ?, updated_at = ? WHERE instance_id = ? AND unit = ?`,
        JSON.stringify(planned.unit),
        now,
        instanceId,
        unit,
      );
      result = { ok: true, unit: planned.unit, ...(planned.replayed ? { replayed: true } : {}) };
    });
    return result;
  }

  async getRecoveryAction(
    key: { instanceId: string; unit: string },
    request: RecoveryRequest | string,
  ): Promise<RecoveryAction | null> {
    const id = typeof request === "string" ? request : await recoveryActionId(key, request);
    const row = this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_recovery_journal WHERE instance_id = ? AND unit = ? AND kind = 'action' AND id = ?`,
        key.instanceId,
        key.unit,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const action = JSON.parse(row.json) as RecoveryAction;
    return isRecoveryAction(action) &&
      action.id === id &&
      action.instanceId === key.instanceId &&
      action.unit === key.unit
      ? action
      : null;
  }

  async listRecoveryHistory(key: { instanceId: string; unit: string }, after = 0): Promise<RecoveryHistoryPage> {
    const rows = this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_recovery_journal WHERE instance_id = ? AND unit = ? AND kind = 'receipt'`,
        key.instanceId,
        key.unit,
      )
      .toArray();
    return recoveryHistoryPage(
      rows.map((row) => JSON.parse(row.json) as RecoveryReceipt),
      after,
    );
  }

  async listUnits(instanceId: string): Promise<CoordinatorUnit[]> {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_units WHERE instance_id = ? ORDER BY rowid`, instanceId)
      .toArray()
      .map((r) => JSON.parse(r.json) as CoordinatorUnit);
  }

  /** Reads are also consumed by admission inside this existing owner transaction. */
  private historicalOwnerEvents(runId: string, record: HistoricalOwnerRecord): HistoricalOwnerEvent[] | undefined {
    const size = this.sql
      .exec<{ count: number; bytes: number; first: number; last: number }>(
        `SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(json AS BLOB))),0) AS bytes,MIN(seq) AS first,MAX(seq) AS last FROM run_events WHERE run_id=?`,
        runId,
      )
      .one();
    if (
      size.count < 1 ||
      size.count > RUN_EVENTS_MAX_PAGE ||
      size.count !== record.eventCount ||
      size.count !== record.storedEventCount ||
      record.truncated !== false ||
      size.first !== 1 ||
      size.last !== size.count ||
      size.bytes > MAX_RECORD_BYTES
    )
      return;
    const rows = this.sql
      .exec<{ seq: number; authority_json: string }>(
        `SELECT seq,
      CASE WHEN json_valid(json) AND json_type(json)='object' THEN
        CASE WHEN json_extract(json,'$.type') IN (SELECT value FROM json_each(?)) THEN
          (SELECT json_group_object(key,json(CASE WHEN type IN ('array','object') THEN value WHEN type='true' THEN 'true' WHEN type='false' THEN 'false' ELSE json_quote(value) END))
           FROM json_each(run_events.json) WHERE key IN (SELECT value FROM json_each(?)))
        ELSE CASE WHEN json_type(json,'$.type')='text' THEN '{"type":"ignored"}' ELSE 'null' END END
      ELSE 'null' END AS authority_json FROM run_events WHERE run_id=? ORDER BY seq LIMIT ?`,
        JSON.stringify(HISTORICAL_AUTHORITY_EVENT_TYPES),
        JSON.stringify(HISTORICAL_AUTHORITY_EVENT_FIELDS),
        runId,
        RUN_EVENTS_MAX_PAGE + 1,
      )
      .toArray();
    if (rows.length !== size.count) return;
    const events: HistoricalOwnerEvent[] = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += 3 * row.authority_json.length;
      if (bytes > MAX_RECORD_BYTES || row.seq !== events.length + 1) return;
      const value = JSON.parse(row.authority_json);
      const event: unknown = { ...value, seq: row.seq };
      if (!isHistoricalOwnerEvent(event)) return;
      events.push(historicalOwnerEvent(event));
    }
    return events;
  }

  private pullOwnershipRows(diagnostics?: PullOwnershipDiagnostics, auditing?: CoordinatorUnit): PullOwnershipRows {
    let count = 0,
      bytes = 0;
    const position = (source: PullOwnershipSource, rowIndex?: number) => {
      if (diagnostics) diagnostics.cursor = { source, ...(rowIndex !== undefined ? { rowIndex } : {}) };
    };
    const unreadable = (check: PullOwnershipCheck, cause: "shape" | "historical" = "shape") => {
      if (diagnostics) {
        diagnostics.failure = { check, ...diagnostics.cursor };
        diagnostics.cause = cause;
      }
    };
    const parse = (raw: string, check: PullOwnershipCheck) => {
      try {
        return JSON.parse(raw);
      } catch (error) {
        unreadable(check);
        if (diagnostics) diagnostics.cause = "json";
        throw error;
      }
    };
    const bounded = function* <T extends Record<string, unknown>>(cursor: Iterable<T>, source: PullOwnershipSource) {
      let rowIndex = 0;
      for (const row of cursor) {
        count++;
        // UTF-8 needs at most three bytes per UTF-16 code unit. Refuse before parsing.
        bytes += Object.values(row).reduce<number>(
          (sum, value) => sum + (typeof value === "string" ? 3 * value.length : 0),
          0,
        );
        position(source, rowIndex);
        if (diagnostics) diagnostics.scan = { source, rowIndex, rowsRead: count, sourceBytes: bytes };
        if (count > PULL_OWNER_SCAN_MAX || bytes > PULL_OWNER_SCAN_MAX_BYTES) {
          if (diagnostics)
            diagnostics.failure = {
              check: count > PULL_OWNER_SCAN_MAX ? "inventory_row_limit" : "inventory_byte_limit",
              source,
              rowIndex,
            };
          throw new Error("pull owner scan incomplete");
        }
        yield row;
        rowIndex++;
      }
    };
    const limit = PULL_OWNER_SCAN_MAX + 1;
    position("effects");
    const effects = [
      ...bounded(
        this.sql.exec<{ body_json: string }>(
          `SELECT body_json FROM plane_effects WHERE acked_at IS NULL LIMIT ?`,
          limit,
        ),
        "effects",
      ),
    ].map((row, rowIndex) => {
      position("effects", rowIndex);
      if (diagnostics?.scan) diagnostics.scan.rowIndex = rowIndex;
      return parse(row.body_json, "effect_shape");
    });
    if (diagnostics) diagnostics.runOrigins = [];
    const rows: PullOwnershipRows = { complete: true, units: [], runs: [], effects, settlements: [] };
    position("units");
    for (const row of bounded(
      this.sql.exec<{ unit_json: string; instance_json: string | null }>(
        `SELECT u.json AS unit_json, i.json AS instance_json FROM coordinator_units u LEFT JOIN coordinator_instances i ON i.instance_id = u.instance_id LIMIT ?`,
        limit,
      ),
      "units",
    ))
      rows.units.push({
        unit: (() => {
          const unit = parse(row.unit_json, "unit_shape");
          return auditing && auditing.instanceId === unit.instanceId && auditing.unit === unit.unit ? auditing : unit;
        })(),
        instance: row.instance_json === null ? undefined : parse(row.instance_json, "instance_shape"),
      });
    const auditedRunIds = new Set(
      rows.units.flatMap((row) =>
        isCoordinatorUnit(row.unit) && row.unit.adoption?.audit ? [row.unit.adoption.runId] : [],
      ),
    );
    position("live_runs");
    for (const row of bounded(
      this.sql.exec<{
        run_id: string;
        thread_key: string;
        owner_gen: string;
        phase: string;
        meta_json: string;
        state_json: string;
      }>(`SELECT run_id, thread_key, owner_gen, phase, meta_json, state_json FROM live_runs LIMIT ?`, limit),
      "live_runs",
    )) {
      const meta = parse(row.meta_json, "inventory_live_producer"),
        state = parse(row.state_json, "inventory_live_producer");
      const admitted =
        row.owner_gen === "plane" &&
        row.phase === "attaching" &&
        meta &&
        typeof meta === "object" &&
        !Array.isArray(meta) &&
        Object.keys(meta).length === 1 &&
        meta.request &&
        typeof meta.request === "object" &&
        !Array.isArray(meta.request) &&
        effects.some(
          (effect) =>
            effect?.kind === "admit" &&
            effect.runId === row.run_id &&
            effect.threadKey === row.thread_key &&
            JSON.stringify(effect.request) === JSON.stringify(meta.request),
        );
      if ((!isPullOwnerLiveMeta(meta) && !admitted) || !state || typeof state !== "object" || Array.isArray(state)) {
        if (diagnostics)
          diagnostics.failure = {
            check: "inventory_live_producer",
            source: diagnostics.scan?.source,
            rowIndex: diagnostics.scan?.rowIndex,
          };
        throw new Error("unreadable live producer");
      }
      rows.runs.push({
        runId: row.run_id,
        repo: meta.repo,
        live: true,
        record: meta,
        publication: state.branchPublication,
        door: state.doorPublicationPending,
      });
      if (diagnostics) diagnostics.runOrigins!.push({ source: "live_runs", rowIndex: diagnostics.scan!.rowIndex });
    }
    position("runs");
    for (const row of bounded(
      this.sql.exec<{ run_id: string; owner_json: string; work_evidence_json: string | null }>(
        // Project inside SQLite, before the source-byte bound. Display text and
        // diagnostics cannot hold a pull request; canonical identity and saved
        // publication remain in this transaction, including unreadable values.
        // SQLite accepts JSON5; refuse it before projection can normalize NaN
        // into the null sentinel used for a cleared Door publication.
        `SELECT run_id,
           CASE WHEN json_valid(summary_json) THEN
           (SELECT json_group_object(key, json(CASE
              WHEN type IN ('array', 'object') THEN value
              WHEN type = 'true' THEN 'true'
              WHEN type = 'false' THEN 'false'
              ELSE json_quote(value) END))
            FROM json_each(runs.summary_json)
            WHERE key IN ('id', 'repo', 'userId', 'channelId', 'threadKey',
              'parentInstanceId', 'coordinatorUnit', 'coordinatorAttempt',
              'idempotencyKey', 'session', 'agent', 'status', 'provisional', 'publicationSettlement',
              'startedAt', 'finishedAt', 'eventCount', 'storedEventCount', 'truncated', 'headSha', 'pushed', 'restarting', 'pr',
              'branchPublication', 'branchPushReceipts', 'doorPublicationPending'))
           ELSE 'null' END AS owner_json,
           work_evidence_json FROM runs LIMIT ?`,
        limit,
      ),
      "runs",
    )) {
      const raw: Record<string, unknown> = parse(row.owner_json, "inventory_terminal_producer");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        if (diagnostics)
          diagnostics.failure = {
            check: "inventory_terminal_producer",
            source: diagnostics.scan?.source,
            rowIndex: diagnostics.scan?.rowIndex,
          };
        throw new Error("unreadable terminal producer");
      }
      const { branchPublication, branchPushReceipts, doorPublicationPending, ...identity } = raw;
      if (!isRunWorkOwner(identity) || !isPullOwnerLiveMeta(identity) || identity.id !== row.run_id) {
        if (diagnostics)
          diagnostics.failure = {
            check: "inventory_terminal_producer",
            source: diagnostics.scan?.source,
            rowIndex: diagnostics.scan?.rowIndex,
          };
        throw new Error("unreadable terminal producer");
      }
      const evidence =
        row.work_evidence_json === null
          ? undefined
          : parseWorkEvidence(parse(row.work_evidence_json, "inventory_private_producer"), identity);
      if (row.work_evidence_json !== null && !evidence) {
        if (diagnostics)
          diagnostics.failure = {
            check: "inventory_private_producer",
            source: diagnostics.scan?.source,
            rowIndex: diagnostics.scan?.rowIndex,
          };
        throw new Error("unreadable private producer");
      }
      const audited = auditedRunIds.has(row.run_id);
      if (audited && !isHistoricalOwnerRecord(identity)) {
        unreadable("inventory_terminal_producer");
        throw new Error("unreadable historical header");
      }
      const historicalEvents =
        audited && isHistoricalOwnerRecord(identity) ? this.historicalOwnerEvents(row.run_id, identity) : undefined;
      if (audited) {
        if (!historicalEvents) {
          unreadable("inventory_terminal_producer", "historical");
          throw new Error("unreadable historical audit");
        }
        bytes += 3 * JSON.stringify(historicalEvents).length;
        if (diagnostics?.scan) diagnostics.scan.sourceBytes = bytes;
        if (bytes > PULL_OWNER_SCAN_MAX_BYTES) {
          unreadable("inventory_byte_limit");
          throw new Error("pull owner scan incomplete");
        }
      }
      rows.runs.push({
        runId: row.run_id,
        repo: identity.repo,
        live: false,
        record: identity,
        historicalEvents,
        pushReceipts:
          evidence && Object.hasOwn(evidence, "branchPushReceipts") ? evidence.branchPushReceipts : branchPushReceipts,
        publication:
          evidence && Object.hasOwn(evidence, "branchPublication") ? evidence.branchPublication : branchPublication,
        door:
          evidence && Object.hasOwn(evidence, "doorPublicationPending")
            ? evidence.doorPublicationPending
            : doorPublicationPending,
      });
      if (diagnostics) diagnostics.runOrigins!.push({ source: "runs", rowIndex: diagnostics.scan!.rowIndex });
    }
    position("settlements");
    for (const row of bounded(
      this.sql.exec<{ owner_key: string; revision: number; json: string }>(
        `SELECT owner_key, revision, json FROM workspace_settlements WHERE json IS NOT NULL LIMIT ?`,
        limit,
      ),
      "settlements",
    )) {
      const value = workspaceSettlementOf(parse(row.json, "inventory_workspace_owner"));
      if (!value || workspaceOwnerKey(value.owner) !== row.owner_key || value.revision !== row.revision) {
        if (diagnostics)
          diagnostics.failure = {
            check: "inventory_workspace_owner",
            source: diagnostics.scan?.source,
            rowIndex: diagnostics.scan?.rowIndex,
          };
        throw new Error("unreadable workspace owner");
      }
      rows.settlements!.push(value);
    }
    return rows;
  }

  async findPullOwners(target: PullTarget, includeDiagnostic = false): Promise<PullOwnersResult> {
    if (!isPullTarget(target)) return { ok: false, reason: "invalid" };
    const diagnostics: PullOwnershipDiagnostics | undefined = includeDiagnostic ? {} : undefined;
    let result: PullOwnersResult = { ok: false, reason: "incomplete" };
    const reported = (fallback: "read" | "validation"): PullOwnersResult => {
      const diagnostic = diagnostics && pullOwnerReadDiagnosticFor(diagnostics, fallback);
      return !result.ok && result.reason === "incomplete" && diagnostic ? { ...result, diagnostic } : result;
    };
    try {
      this.ctx.storage.transactionSync(() => {
        result = findPullOwnersInRows(target, this.pullOwnershipRows(diagnostics), diagnostics);
      });
    } catch {
      return reported("read");
    }
    return reported("validation");
  }

  async listActiveRecoveries(): Promise<CoordinatorUnit[]> {
    return this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_units
         WHERE json_valid(json) = 0 OR json_type(json, '$.recovery') IS NOT NULL
         ORDER BY rowid`,
      )
      .toArray()
      .map((r) => {
        const unit: unknown = JSON.parse(r.json);
        if (!isCoordinatorUnit(unit) || unit.recovery === undefined)
          throw new Error("active recovery index contains a malformed coordinator unit");
        return unit;
      });
  }

  private recoveryTransport(parentInstanceId: string, idempotencyKey: string | undefined): string | undefined {
    const unit = idempotencyKey === undefined ? undefined : unitOfIdempotencyKey(idempotencyKey);
    if (unit === undefined) return undefined;
    const row = this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
        parentInstanceId,
        unit,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    const parsed = JSON.parse(row.json) as CoordinatorUnit;
    return parsed.recovery?.workflowId;
  }

  // ---- the thread events of a unit-owned thread (record 0051's reply-as-event rule) --------------

  /** The next sequence assigned in one transaction, the per-event cap applied
   *  (attachments dropped whole, the row saying how many). A stable event id
   *  already on the unit returns its first sequence without another row. */
  async appendUnitEvent(
    instanceId: string,
    unit: string,
    event: Omit<ThreadEvent, "seq">,
    requireActive = false,
    binding?: MainTaskBinding,
    expectedRecovery?: { actionId: string; workflowId: string },
  ): Promise<{ ok: true; seq: number; event?: ThreadEvent } | { ok: false; reason: "ended" | "stale" }> {
    let seq = 1;
    let refusal: "ended" | "stale" | undefined;
    let storedEvent: ThreadEvent | undefined;
    this.ctx.storage.transactionSync(() => {
      if (requireActive || binding !== undefined || expectedRecovery !== undefined) {
        const instanceText = this.sql
          .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, instanceId)
          .toArray()[0]?.json;
        const unitText = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
            instanceId,
            unit,
          )
          .toArray()[0]?.json;
        const instance = instanceText ? (JSON.parse(instanceText) as CoordinatorInstance) : undefined;
        const row = unitText ? (JSON.parse(unitText) as CoordinatorUnit) : undefined;
        if (
          binding !== undefined &&
          (binding.instanceId !== instanceId ||
            binding.unit !== unit ||
            !instance ||
            !this.currentMainTaskBindingMatches(binding, instance, row))
        ) {
          refusal = "stale";
          return;
        }
        if (expectedRecovery !== undefined) {
          const snapshot = this.coordinatorSnapshot(instanceId, unit);
          if (
            !requireActive ||
            !snapshot ||
            snapshot.unit.recovery?.actionId !== expectedRecovery.actionId ||
            snapshot.unit.recovery.workflowId !== expectedRecovery.workflowId ||
            snapshot.action?.state !== "pending"
          ) {
            refusal = "stale";
            return;
          }
          if (snapshot.instance.stop || snapshot.unit.ending || snapshot.unit.recoveryHold) {
            refusal = "ended";
            return;
          }
        } else if (!instance || !row || instance.stop || row.ending || row.recovery || row.recoveryHold) {
          refusal = "ended";
          return;
        }
      }
      if (event.id !== undefined) {
        const existing = this.sql
          .exec<{ seq: number; json: string }>(
            `SELECT seq, json FROM coordinator_unit_events WHERE instance_id = ? AND unit = ? ORDER BY seq`,
            instanceId,
            unit,
          )
          .toArray()
          .find((row) => (JSON.parse(row.json) as ThreadEvent).id === event.id);
        if (existing !== undefined) {
          seq = existing.seq;
          storedEvent = JSON.parse(existing.json) as ThreadEvent;
          return;
        }
      }
      const max = this.sql
        .exec<{
          m: number | null;
        }>(`SELECT MAX(seq) AS m FROM coordinator_unit_events WHERE instance_id = ? AND unit = ?`, instanceId, unit)
        .toArray()[0];
      seq = (max?.m ?? 0) + 1;
      const capped = capThreadEvent({ ...event, seq });
      storedEvent = capped;
      this.sql.exec(
        `INSERT INTO coordinator_unit_events (instance_id, unit, seq, json) VALUES (?, ?, ?, ?)`,
        instanceId,
        unit,
        seq,
        JSON.stringify(capped),
      );
    });
    return refusal
      ? { ok: false, reason: refusal }
      : binding === undefined
        ? { ok: true, seq }
        : { ok: true, seq, event: storedEvent };
  }

  /** The unit's events in sequence order; `unconsumedOnly` filters to the rows nothing has consumed. */
  async listUnitEvents(instanceId: string, unit: string, unconsumedOnly: boolean): Promise<ThreadEvent[]> {
    return this.sql
      .exec<{ json: string; consumed_by: string | null }>(
        `SELECT json, consumed_by FROM coordinator_unit_events WHERE instance_id = ? AND unit = ?${
          unconsumedOnly ? " AND consumed_by IS NULL" : ""
        } ORDER BY seq ASC`,
        instanceId,
        unit,
      )
      .toArray()
      .map((r) => {
        const e = JSON.parse(r.json) as ThreadEvent;
        return r.consumed_by !== null ? { ...e, consumedBy: r.consumed_by } : e;
      });
  }

  /** Consumption set once — idempotent: a row already consumed keeps its first consumer. */
  async markUnitEventsConsumed(instanceId: string, unit: string, seqs: number[], by: string): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      for (const seq of seqs) {
        this.sql.exec(
          `UPDATE coordinator_unit_events SET consumed_by = ? WHERE instance_id = ? AND unit = ? AND seq = ? AND consumed_by IS NULL`,
          by,
          instanceId,
          unit,
          seq,
        );
      }
    });
    return { ok: true };
  }

  /** One transaction is the wake's decision: the indexed answer on the unit
   * row and every event it consumed become visible together. */
  async answerUnitWake(
    unit: CoordinatorUnit,
    waitId: string,
    answer: UnitWakeAnswer,
    seqs: number[],
    by: string,
    now: number,
  ): Promise<{ ok: true } | { ok: false; reason: "settled" | PullBindingRefusal }> {
    return this.writeUnfencedUnit(() => {
      const updated = { ...unit, wakes: { ...(unit.wakes ?? {}), [waitId]: answer } };
      const row = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
          unit.instanceId,
          unit.unit,
        )
        .toArray()[0];
      const current = row ? (JSON.parse(row.json) as CoordinatorUnit) : undefined;
      const prepared = prepareUnfencedUnitWrite(current, updated);
      const reason = this.bindingRefusal(current, prepared);
      if (reason) return reason;
      this.pinUnitContext(prepared, current, now);
      this.sql.exec(
        `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(instance_id, unit) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        unit.instanceId,
        unit.unit,
        JSON.stringify(prepared),
        now,
      );
      for (const seq of seqs)
        this.sql.exec(
          `UPDATE coordinator_unit_events SET consumed_by = ? WHERE instance_id = ? AND unit = ? AND seq = ? AND consumed_by IS NULL`,
          by,
          unit.instanceId,
          unit.unit,
          seq,
        );
    });
  }

  // ---- the live-run ledger (run-history items 28–34) --------------------------

  private liveRow(runId: string): LiveRunRow | undefined {
    const r = this.sql.exec<LiveRow>(`SELECT * FROM live_runs WHERE run_id = ?`, runId).toArray()[0];
    return r ? rowToLive(r) : undefined;
  }

  private checkpointMembership(runId: string): Pick<CanonicalCheckpointSource, "members" | "memberCheckpoints"> {
    const rows = this.sql
      .exec<{ source_run_id: string; ordinary_checkpoint: string }>(
        `SELECT source_run_id, ordinary_checkpoint FROM context_refs
       WHERE holder_run_id = ? AND ordinary_member = 1 ORDER BY ordinary_order LIMIT ?`,
        runId,
        ORDINARY_CONTEXT_HISTORY_RUNS + 1,
      )
      .toArray();
    return {
      members: rows.map((row) => row.source_run_id),
      memberCheckpoints: Object.fromEntries(rows.map((row) => [row.source_run_id, row.ordinary_checkpoint])),
    };
  }

  private async checkpointSource(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    const live = this.liveRow(runId);
    const archived = live ? undefined : await this.get(runId);
    const meta = live?.meta ?? archived;
    const context = live?.state.contextDependencies ?? archived?.contextDependencies;
    if (!meta || !isContextDependencies(context)) return undefined;
    const raw = live?.state.contextCheckpointReceipt ?? archived?.contextCheckpointReceipt;
    const receipt = isContextCheckpointReceipt(raw) ? raw : undefined;
    let transcriptHash: string | undefined;
    if (receipt) {
      const data = await this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(receipt.session.key)).read(
        receipt.session.seedFrom,
        receipt.session.through,
      );
      transcriptHash = await sourceHash(assembleTranscript(data.rows, data.attachments, receipt.session.seedFrom));
    }
    return {
      runId,
      meta,
      context,
      ...(receipt
        ? {
            receipt,
            transcriptHash,
            ...this.checkpointMembership(runId),
          }
        : {}),
    };
  }

  private async archiveCheckpoint(record: RunRecord): Promise<RunRecord> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.recoverPendingCheckpoint(record.id);
        const live = this.liveRow(record.id);
        for (const field of ["workReads", "unitSeedReceipt", "branchIdentityBaseline"] as const) {
          const canonical = live?.state[field];
          if (canonical === undefined) continue;
          if (record[field] !== undefined && JSON.stringify(record[field]) !== JSON.stringify(canonical))
            throw new CanonicalArchiveRefusal("work evidence is not canonical");
          record = { ...record, [field]: structuredClone(canonical) };
        }
        if (!workEvidenceBelongsToRun(record, record))
          throw new CanonicalArchiveRefusal("work evidence does not match its canonical run");
        const receipt = live?.state.contextCheckpointReceipt;
        if (!isContextCheckpointReceipt(receipt)) return record;
        if (
          record.contextCheckpointReceipt !== undefined &&
          JSON.stringify(record.contextCheckpointReceipt) !== JSON.stringify(receipt)
        )
          throw new CanonicalArchiveRefusal("checkpoint receipt is not canonical");
        const context = applyContextCheckpoint(
          mergeContextDependencies(
            record.contextDependencies ?? (live!.state.contextDependencies as ContextDependencies),
            receipt.normalized,
          ),
          receipt,
        );
        const sealed = { ...record, contextDependencies: context, contextCheckpointReceipt: receipt };
        if (!isRunRecord(sealed))
          throw new CanonicalArchiveRefusal("checkpoint archive does not match its canonical run");
        return sealed;
      } catch (error) {
        if (error instanceof CanonicalArchiveRefusal) return error;
        throw error;
      }
    });
    if (result instanceof CanonicalArchiveRefusal) throw result;
    return result;
  }

  private async recoverPendingCheckpoint(runId: string): Promise<void> {
    const row = this.liveRow(runId);
    const receipt = row?.state.pendingContextCheckpoint;
    if (
      !row ||
      !isContextCheckpointReceipt(receipt) ||
      row.state.contextCheckpointReceipt !== undefined ||
      !isContextDependencies(row.state.contextDependencies)
    )
      return;
    const before = await contextDependenciesHash(row.state.contextDependencies);
    if (before !== receipt.beforeHash && before !== receipt.normalizedHash) return;
    if ((await sourceHash(row.system)) !== receipt.inputs.systemHash) return;
    const log = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(receipt.session.key));
    const data = await log.checkpointSnapshot(receipt.session.seedFrom, receipt.session.through);
    const source: CanonicalCheckpointSource = {
      runId,
      meta: row.meta,
      context: receipt.normalized,
      receipt,
      transcriptHash: await sourceHash(assembleTranscript(data.rows, data.attachments, receipt.session.seedFrom)),
      ...this.checkpointMembership(runId),
    };
    if (
      !(await validateContextCheckpoint(receipt, source)) ||
      !(await log.installCheckpoint(runId, row.ownerGen, receipt)).ok
    )
      return;
    this.ctx.storage.transactionSync(() => {
      const current = this.liveRow(runId);
      if (
        !current ||
        current.ownerGen !== row.ownerGen ||
        JSON.stringify(current.state.pendingContextCheckpoint) !== JSON.stringify(receipt)
      )
        return;
      const { pendingContextCheckpoint: _pending, ...state } = current.state;
      this.sql.exec(
        `UPDATE live_runs SET state_json = ? WHERE run_id = ?`,
        JSON.stringify({ ...state, contextDependencies: receipt.normalized, contextCheckpointReceipt: receipt }),
        runId,
      );
      this.replaceOrdinaryCheckpointPins(runId, receipt);
    });
  }

  async readContextCheckpoint(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.recoverPendingCheckpoint(runId);
      const source = await this.checkpointSource(runId);
      return source?.receipt && (await validateContextCheckpoint(source.receipt, source)) ? source : undefined;
    });
  }

  async normalizeContextOrigins(request: ContextCheckpointRequest): Promise<ContextCheckpointResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.recoverPendingCheckpoint(request.runId);
      const row = this.liveRow(request.runId);
      const fence = checkFence(row, request.gen);
      if (!fence.ok) return fence;
      if (!row) return { ok: false, reason: "unknown-run" };
      const unavailable = (): ContextCheckpointResult => ({ ok: false, reason: "checkpoint-unavailable" });
      const committed = await this.checkpointSource(request.runId);
      if (committed?.receipt && (await validateContextCheckpoint(committed.receipt, committed)))
        return { ok: true, receipt: committed.receipt };
      const session = row.meta.session;
      const lastJson = this.sql
        .exec<{ json: string }>(
          `SELECT json FROM run_steps WHERE run_id = ? AND step >= 0 ORDER BY step DESC LIMIT 1`,
          row.runId,
        )
        .toArray()[0]?.json;
      const last = lastJson ? (JSON.parse(lastJson) as StepRecord) : undefined;
      if (
        !session ||
        session.key !== request.key ||
        session.range === "broken" ||
        !last ||
        last.step !== 0 ||
        last.inFlight.length
      )
        return unavailable();
      const through = session.seedFrom + last.turnIndex - 1;
      const checkpoint = row.state.contextCheckpoint as { key?: string; through?: number } | undefined;
      if (checkpoint && (checkpoint.key !== request.key || checkpoint.through !== through)) return unavailable();
      const log = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(request.key));
      const snapshot = await log.checkpointSnapshot(session.seedFrom, through);
      if (
        snapshot.next !== through + 1 ||
        snapshot.owner?.runId !== row.runId ||
        snapshot.owner.gen !== request.gen ||
        !isContextDependencies(snapshot.context) ||
        !isContextDependencies(row.state.contextDependencies)
      )
        return unavailable();
      const inputs = {
        transcriptHash: await sourceHash(assembleTranscript(snapshot.rows, snapshot.attachments, session.seedFrom)),
        systemHash: await sourceHash(row.system),
        notepadHash: await sourceHash(snapshot.notepad),
      };
      let receipt = isContextCheckpointReceipt(row.state.pendingContextCheckpoint)
        ? row.state.pendingContextCheckpoint
        : undefined;
      if (receipt) {
        if (
          receipt.runId !== row.runId ||
          receipt.session.key !== request.key ||
          receipt.session.through !== through ||
          (await sourceHash(inputs)) !== (await sourceHash(receipt.inputs))
        )
          return unavailable();
      } else {
        if (!contextDependenciesContain(snapshot.context, row.state.contextDependencies)) return unavailable();
        const sources = (
          await Promise.all(
            snapshot.context.origins
              .filter((origin) => origin.runId !== row.runId)
              .map((origin) => this.checkpointSource(origin.runId)),
          )
        ).filter((source): source is CanonicalCheckpointSource => source !== undefined);
        receipt = await planContextCheckpoint({
          run: { runId: row.runId, meta: row.meta, context: snapshot.context },
          ownerGen: request.gen,
          through,
          inputs,
          expected: request.expected,
          sources,
        });
        if (!receipt) return unavailable();
        const members = checkpointMembersOf(row.runId, receipt.coveredOrigins, sources);
        const memberHashes = checkpointMemberHashesOf(row.runId, receipt.coveredOrigins, sources);
        this.ctx.storage.transactionSync(() => {
          // Preserve predecessor pins until the source object ACKs installation.
          // A crash before that ACK still resumes from the original closure.
          for (const [order, member] of members.entries())
            this.sql.exec(
              `INSERT INTO context_refs (holder_run_id, source_run_id, session_key, ordinary_member, ordinary_order, ordinary_checkpoint, retention_pin)
               VALUES (?, ?, '', 1, ?, ?, 0)
               ON CONFLICT(holder_run_id, source_run_id, session_key) DO UPDATE SET
                 ordinary_member = 1, ordinary_order = excluded.ordinary_order, ordinary_checkpoint = excluded.ordinary_checkpoint`,
              row.runId,
              member,
              order,
              memberHashes[member],
            );
          this.pinReference(row.runId, row.runId, request.key, true);
          row.state.pendingContextCheckpoint = receipt;
          this.sql.exec(`UPDATE live_runs SET state_json = ? WHERE run_id = ?`, JSON.stringify(row.state), row.runId);
        });
      }
      if (!(await log.installCheckpoint(row.runId, request.gen, receipt)).ok) return unavailable();
      this.ctx.storage.transactionSync(() => {
        const { pendingContextCheckpoint: _pending, ...prior } = row.state;
        row.state = { ...prior, contextDependencies: receipt!.normalized, contextCheckpointReceipt: receipt };
        this.sql.exec(`UPDATE live_runs SET state_json = ? WHERE run_id = ?`, JSON.stringify(row.state), row.runId);
        this.replaceOrdinaryCheckpointPins(row.runId, receipt!);
      });
      return { ok: true, receipt };
    });
  }

  /** A source write proves its canonical session through the claimed row. */
  async sourceSessionOwner(runId: string, gen: string, key: string): Promise<SessionSourceOwner | null> {
    const row = this.liveRow(runId);
    if (!row || row.ownerGen !== gen || row.meta.session?.key !== key) return null;
    return { key, threadKey: row.meta.threadKey, channelId: row.meta.channelId, requester: row.meta.userId };
  }

  /** A later ledger owner gets a larger attachment fence, even for the same run ID. */
  async residentClaim(
    runId: string,
    gen: string,
    threadKey: string,
  ): Promise<{ ok: true; fence: number } | { ok: false; reason: "fenced" | "unknown-run" }> {
    let out: { ok: true; fence: number } | { ok: false; reason: "fenced" | "unknown-run" } = {
      ok: false,
      reason: "unknown-run",
    };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      if (!row) return;
      if (row.ownerGen !== gen || row.threadKey !== threadKey) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(`UPDATE resident_claim_clock SET value = value + 1 WHERE id = 1`);
      const fence = this.sql
        .exec<{ value: number }>(`SELECT value FROM resident_claim_clock WHERE id = 1`)
        .toArray()[0]?.value;
      if (fence === undefined || !Number.isSafeInteger(fence)) throw new Error("resident claim fence unavailable");
      out = { ok: true, fence };
    });
    return out;
  }

  /** The `runs` table's column migrations, run at every construction and
   *  idempotent: a table created before a column existed gains it, with the
   *  value a row written back then should read. The run-visibility stamp: a
   *  run written before the stamp is `unknown`, never public. The session a
   *  run was a range of (session-log item 7), so the sweep can tell which
   *  sessions still have a kept run; null for a record without one. What the
   *  run cost in tokens (costs.md, cost by user), NULL until the by-user
   *  aggregate fills it from the run's stored events. The parent a child names
   *  (run-history item 46), the column a children listing filters on: the
   *  record already carries it in `summary_json`, so existing rows are filled
   *  from there once, and every later `put` writes it beside the row. The pull
   *  request a run names (run-history item 58; `pullRequestNumberOf`), the
   *  column a findings listing filters on: the same one-time fill from
   *  `summary_json` — the coding post-step's `pr`, else a posted review's
   *  target — and every later `put` writes it beside the row. */
  migrateRunsTable(): void {
    const columns = new Set(
      this.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name),
    );
    if (!columns.has("channel_visibility"))
      this.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    if (!columns.has("session_key")) this.sql.exec(`ALTER TABLE runs ADD COLUMN session_key TEXT`);
    for (const [column, field] of [
      ["context_checkpoint_json", "contextCheckpointReceipt"],
      ["direct_audience_json", "directAudience"],
    ] as const) {
      if (!columns.has(column)) {
        this.sql.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
        this.sql.exec(
          `UPDATE runs SET ${column} = json_extract(summary_json, '$.${field}'), summary_json = json_remove(summary_json, '$.${field}') WHERE json_valid(summary_json) AND json_type(summary_json, '$.${field}') IS NOT NULL`,
        );
      }
    }
    if (!columns.has("work_evidence_json")) {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN work_evidence_json TEXT`);
      for (const field of ["workReads", "unitSeedReceipt"]) {
        this.sql
          .exec(`UPDATE runs SET work_evidence_json = json_set(COALESCE(work_evidence_json, '{"version":1}'), '$.${field}', json_extract(summary_json, '$.${field}')),
          summary_json = json_remove(summary_json, '$.${field}')
          WHERE json_valid(summary_json) AND json_type(summary_json, '$.${field}') IS NOT NULL`);
      }
    }
    if (!columns.has("source_reads_json")) {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN source_reads_json TEXT`);
      this.sql.exec(`UPDATE runs SET source_reads_json = json_extract(summary_json, '$.sourceReads'),
        summary_json = json_remove(summary_json, '$.sourceReads')
        WHERE json_valid(summary_json) AND json_type(summary_json, '$.sourceReads') IS NOT NULL`);
    }
    if (!columns.has("usage_json")) this.sql.exec(`ALTER TABLE runs ADD COLUMN usage_json TEXT`);
    if (!columns.has("parent_run_id")) {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN parent_run_id TEXT`);
      this.sql.exec(
        `UPDATE runs SET parent_run_id = json_extract(summary_json, '$.parentRunId')
         WHERE json_type(summary_json, '$.parentRunId') = 'text'`,
      );
    }
    if (!columns.has("pr_number")) {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN pr_number INTEGER`);
      // `pullRequestNumberOf` in SQL: the coding post-step's pull request, else
      // the one a posted review targeted (a skipped post has no target).
      this.sql.exec(
        `UPDATE runs SET pr_number = COALESCE(
           CASE WHEN json_type(summary_json, '$.pr.number') = 'integer' THEN json_extract(summary_json, '$.pr.number') END,
           CASE WHEN json_extract(summary_json, '$.reviewPost.posted') = 1
                 AND json_type(summary_json, '$.reviewPost.target.number') = 'integer'
                THEN json_extract(summary_json, '$.reviewPost.target.number') END
         )`,
      );
    }
  }

  private liveByThread(threadKey: string): LiveRunRow | undefined {
    const r = this.sql.exec<LiveRow>(`SELECT * FROM live_runs WHERE thread_key = ?`, threadKey).toArray()[0];
    return r ? rowToLive(r) : undefined;
  }

  /** One live run per thread (item 29): the UNIQUE on thread_key is the
   *  store-level guarantee; the decision names the live run for the steer. */
  /** A claim naming a session log registers it (session-log item 7), so the
   *  sweep knows the object exists and which thread it belongs to. Inside the
   *  claim's transaction. */
  private pinReference(holder: string, source: string, session: string, ordinary = false): void {
    this.sql.exec(
      `INSERT INTO context_refs (holder_run_id, source_run_id, session_key, retention_pin, ordinary_pin)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(holder_run_id, source_run_id, session_key) DO UPDATE SET
         retention_pin = MAX(retention_pin, excluded.retention_pin), ordinary_pin = MAX(ordinary_pin, excluded.ordinary_pin)`,
      holder,
      source,
      session,
      ordinary ? 0 : 1,
      ordinary ? 1 : 0,
    );
  }

  private replaceOrdinaryCheckpointPins(runId: string, receipt: ContextCheckpointReceipt): void {
    this.sql.exec(`UPDATE context_refs SET retention_pin = 0, ordinary_pin = 0 WHERE holder_run_id = ?`, runId);
    this.sql.exec(`DELETE FROM context_refs WHERE holder_run_id = ? AND ordinary_member = 0`, runId);
    this.pinContext(runId, undefined, receipt.normalized);
    this.pinReference(runId, runId, receipt.session.key, true);
  }

  private committedCheckpointReceipt(runId: string): ContextCheckpointReceipt | undefined {
    const live = this.liveRow(runId);
    const archived = live
      ? undefined
      : this.sql
          .exec<{ context_checkpoint_json: string | null }>(
            `SELECT context_checkpoint_json FROM runs WHERE run_id = ?`,
            runId,
          )
          .toArray()[0];
    let raw: unknown = live?.state.contextCheckpointReceipt;
    try {
      if (!raw && archived?.context_checkpoint_json) raw = JSON.parse(archived.context_checkpoint_json);
    } catch {
      return undefined;
    }
    return isContextCheckpointReceipt(raw) ? raw : undefined;
  }

  private pinContext(runId: string, handoff: ChildHandoff | undefined, context?: ContextDependencies): void {
    const ordinary = new Set<string>();
    for (const origin of context?.origins ?? []) {
      if (!origin.checkpoint) continue;
      const raw = this.committedCheckpointReceipt(origin.runId);
      if (!raw || raw.hash !== origin.checkpoint) continue;
      ordinary.add(origin.runId);
      let superseded = false;
      if (runId.startsWith("@session:")) {
        const roots = this.sql
          .exec<{ source_run_id: string }>(
            `SELECT DISTINCT source_run_id FROM context_refs WHERE holder_run_id = ? AND ordinary_pin = 1`,
            runId,
          )
          .toArray();
        for (const root of roots) {
          const prior = this.committedCheckpointReceipt(root.source_run_id);
          const sameLane =
            prior &&
            prior.session.key === raw.session.key &&
            JSON.stringify(prior.authority) === JSON.stringify(raw.authority);
          if (sameLane && prior.session.through > raw.session.through) superseded = true;
          if (
            (sameLane && prior.session.through < raw.session.through) ||
            raw.coveredOrigins.some((covered) => covered.runId === root.source_run_id)
          )
            this.sql.exec(
              `UPDATE context_refs SET ordinary_pin = 0 WHERE holder_run_id = ? AND source_run_id = ?`,
              runId,
              root.source_run_id,
            );
        }
        this.sql.exec(
          `DELETE FROM context_refs WHERE holder_run_id = ? AND ordinary_member = 0 AND retention_pin = 0 AND ordinary_pin = 0`,
          runId,
        );
      }
      if (!superseded) this.pinReference(runId, origin.runId, raw.session.key, true);
      // Keep exact external leaves; ordinary aliases are not archives to retain.
      for (const ref of contextReferencesOf(runId, undefined, {
        ...raw.normalized,
        origins: raw.normalized.origins.filter((value) => value.runId !== origin.runId),
      }))
        this.pinReference(runId, ref.sourceRunId, ref.sessionKey ?? "");
    }
    const external = context
      ? { ...context, origins: context.origins.filter((origin) => !ordinary.has(origin.runId)) }
      : undefined;
    for (const ref of contextReferencesOf(runId, handoff, external))
      this.pinReference(runId, ref.sourceRunId, ref.sessionKey ?? "");
  }

  /** Keep source objects pinned across their ACK and the canonical holder commit.
   * No source object calls back into this history object while the input gate is held. */
  private async withRangePins<T>(
    holders: readonly { id: string; handoff?: ChildHandoff }[],
    commit: () => T | Promise<T>,
  ): Promise<T> {
    holders = holders.filter((holder) => {
      const unit = this.unitRowForHolder(holder.id);
      const archived = this.sql
        .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, holder.id)
        .toArray()[0];
      const existing = unit
        ? (JSON.parse(unit.json) as CoordinatorUnit).context?.handoff
        : (this.liveRow(holder.id)?.meta.childHandoff ??
          (archived ? (JSON.parse(archived.summary_json) as RunRecord).childHandoff : undefined));
      return JSON.stringify(existing) !== JSON.stringify(holder.handoff);
    });
    if (!holders.some((holder) => handoffRangePins(holder.handoff).size)) return commit();
    const touched = new Set<string>();
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const { policy } = this.policyState();
        for (const holder of holders) {
          if (!this.contextSourcesAvailable(holder.handoff, undefined, policy, systemClock()))
            throw new Error("unit context source is unavailable");
          for (const [key, ranges] of handoffRangePins(holder.handoff)) {
            touched.add(key);
            const source = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key));
            if (!(await source.protectRanges(holder.id, ranges)).ok)
              throw new Error("context source range is unavailable");
          }
        }
        const value = await commit();
        return { ok: true as const, value };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    await this.syncRangePins([...touched]);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Source pins are an index of canonical retained holders, never new roots. */
  private async syncRangePins(keys?: readonly string[]): Promise<void> {
    const sessions =
      keys ??
      this.sql
        .exec<{ key: string }>("SELECT key FROM sessions")
        .toArray()
        .map((row) => row.key);
    for (const key of new Set(sessions)) {
      const id = this.env.SESSION_LOGS.idFromName(key),
        log = this.env.SESSION_LOGS.get(id),
        started = systemClock();
      try {
        // Read the receiver's revision BEFORE selecting canonical holders.
        // Protection during either the selection or a delayed RPC invalidates
        // the prune in the receiver's own transaction. No input gate or retry.
        const revision = custodyPinRevisionOf(await log.custodyPinRevision());
        if (!revision) throw new Error("session pin revision is unavailable");
        const { policy } = this.policyState();
        const now = systemClock();
        const holders = this.sql
          .exec<{ holder_run_id: string }>(
            `SELECT DISTINCT holder_run_id FROM context_refs WHERE session_key = ? AND (retention_pin = 1 OR ordinary_pin = 1)
         AND source_run_id IN (SELECT run_id FROM runs UNION SELECT run_id FROM live_runs)`,
            key,
          )
          .toArray()
          .map((row) => row.holder_run_id)
          .filter((holder) => {
            if (this.contextHolderIsLiveOrKept(holder, policy, now)) return true;
            const record = this.sql
              .exec<RetentionRow & { context_checkpoint_json: string | null; work_evidence_json: string | null }>(
                `SELECT run_id, finished_at, bytes, context_checkpoint_json, work_evidence_json FROM runs WHERE run_id = ?`,
                holder,
              )
              .toArray()[0];
            return (
              !!(record?.context_checkpoint_json || record?.work_evidence_json) && this.isKept(record, policy, now)
            );
          });

        for (const entry of this.sql
          .exec<{ allocation_json: string }>(
            "SELECT allocation_json FROM workspace_settlements WHERE allocation_json IS NOT NULL",
          )
          .toArray()) {
          const archive = workspaceDurabilityArchiveOf(JSON.parse(entry.allocation_json));
          if (!archive) throw new Error("workspace allocation authority is unreadable");
          const allocation = archive.allocation;
          if (allocation?.kind !== "exclusive-scratch") continue;
          const live = this.liveRow(archive.runId);
          if (live) {
            if (live.startedAt !== archive.startedAt || !allocationMatchesRun(allocation, live.runId, live.meta))
              throw new Error("workspace allocation owner changed");
            if (
              live.meta.session?.range === "broken" ||
              (revision.guarded && key !== contextThreadSessionKey(allocation.threadKey) && !live.meta.session)
            )
              throw new Error("workspace allocation session is unavailable");
            if (key === contextThreadSessionKey(allocation.threadKey) || live.meta.session?.key === key)
              holders.push(archive.runId);
            continue;
          }
          const saved = this.sql
            .exec<RetentionRow & { summary_json: string }>(
              "SELECT run_id,finished_at,bytes,summary_json FROM runs WHERE run_id=?",
              archive.runId,
            )
            .toArray()[0];
          if (!saved || !this.isKept(saved, policy, now)) continue;
          const record = JSON.parse(saved.summary_json) as RunRecord;
          if (
            record.startedAt !== archive.startedAt ||
            record.provisional ||
            !allocationMatchesRecord(allocation, record)
          )
            throw new Error("workspace allocation record changed");
          if (
            record.session?.range === "broken" ||
            (revision.guarded && key !== contextThreadSessionKey(allocation.threadKey) && !record.session)
          )
            throw new Error("workspace allocation session is unavailable");
          const custody =
            archive.disposition?.kind === "scratch-custody-closed" ? archive.disposition.custody : undefined;
          if (
            custody &&
            (custody.sessionKey !== record.session?.key ||
              record.session.range.to !== custody.through ||
              custody.threadReport.key !== contextThreadSessionKey(allocation.threadKey))
          )
            throw new Error("workspace custody reference changed");
          if (key === contextThreadSessionKey(allocation.threadKey) || record.session?.key === key)
            holders.push(archive.runId);
        }
        const applied = await log.retainRangePinsIfRevision(revision, [...new Set(holders)]);
        if (!applied.ok) {
          console.warn(`[range-pins] session=${id.toString()} retained: ${applied.reason}`);
          continue;
        }
        const received = custodyPinRevisionOf({
          version: applied.version,
          revision: applied.revision,
          guarded: applied.guarded,
        });
        if (!received || received.revision !== revision.revision + 1 || received.guarded !== revision.guarded)
          throw new Error("session pin prune receipt is unreadable");
        const elapsed = systemClock() - started;
        if (elapsed >= RANGE_PIN_RPC_SLOW_MS)
          console.log(
            `[range-pins] session=${id.toString()} holders=${holders.length} complete in ${elapsed}ms (slow)`,
          );
      } catch {
        // Unsupported or unknown receivers retain their pins. A timed-out
        // unconditional prune must never be retried against another revision.
        console.warn(`[range-pins] session=${id.toString()} retained: pin revision unavailable`);
      }
    }
  }

  private pinUnitContext(unit: CoordinatorUnit, current: CoordinatorUnit | undefined, now: number): void {
    if (JSON.stringify(unit.context) === JSON.stringify(current?.context)) return;
    const { policy } = this.policyState();
    if (unit.context && !this.contextSourcesAvailable(unit.context.handoff, undefined, policy, now))
      throw new Error("unit context source is unavailable");
    const holder = `@unit:${unit.instanceId}:${unit.unit}`;
    this.sql.exec(`DELETE FROM context_refs WHERE holder_run_id = ?`, holder);
    if (unit.context) this.pinContext(holder, unit.context.handoff);
  }

  private unitRowForHolder(holder: string): { json: string } | undefined {
    const prefix = "@unit:";
    const separator = holder.indexOf(":", prefix.length);
    if (!holder.startsWith(prefix) || separator === -1) return undefined;
    // Instance IDs cannot contain a colon; the remaining text is the unit name.
    return this.sql
      .exec<{ json: string }>(
        `SELECT json FROM coordinator_units WHERE instance_id = ? AND unit = ?`,
        holder.slice(prefix.length, separator),
        holder.slice(separator + 1),
      )
      .toArray()[0];
  }

  private unitContextRootIsRetained(holder: string): boolean {
    const row = this.unitRowForHolder(holder);
    return row !== undefined && this.unitContextJsonIsRetained(row.json);
  }

  private unitContextJsonIsRetained(json: string): boolean {
    try {
      const unit: unknown = JSON.parse(json);
      return isCoordinatorUnit(unit) && unit.context !== undefined;
    } catch {
      return false;
    }
  }

  private unitContextRoots(): string[] {
    const holders: string[] = [];
    // Stream each unit's JSON once instead of retaining all payloads or rereading each row.
    for (const row of this.sql.exec<{ holder: string; json: string }>(
      `SELECT '@unit:' || instance_id || ':' || unit AS holder, json FROM coordinator_units`,
    )) {
      if (this.unitContextJsonIsRetained(row.json)) holders.push(row.holder);
    }
    return holders;
  }

  private contextSourcesAvailable(
    handoff: ChildHandoff | undefined,
    context: ContextDependencies | undefined,
    policy: RetentionPolicy,
    now: number,
  ): boolean {
    const origins = [
      ...(context?.origins ?? []),
      ...(handoff
        ? [handoff, ...(handoff.ancestors ?? [])].flatMap(({ source, dependencies }) => [
            {
              runId: source.runId,
              requester: source.requester,
              channelId: source.channelId,
              threadKey: source.threadKey,
            },
            ...(dependencies?.value?.origins ?? []),
          ])
        : []),
    ];
    for (const ref of contextReferencesOf("@pending", handoff, context)) {
      const live = this.liveRow(ref.sourceRunId);
      const archived = this.sql
        .exec<RetentionRow & { summary_json: string }>(
          `SELECT run_id, finished_at, bytes, summary_json FROM runs WHERE run_id = ?`,
          ref.sourceRunId,
        )
        .toArray()[0];
      if (!live && (!archived || !this.isKept(archived, policy, now))) return false;
      const facts = live?.meta ?? (JSON.parse(archived!.summary_json) as RunListItem);
      if (ref.sessionKey !== undefined && facts.session?.key !== ref.sessionKey) return false;
      if (
        origins.some(
          (origin) =>
            origin.runId === ref.sourceRunId &&
            (origin.requester !== facts.userId ||
              origin.channelId !== facts.channelId ||
              origin.threadKey !== facts.threadKey),
        )
      )
        return false;
    }
    return true;
  }

  private contextReferences(): ContextReference[] {
    return this.sql
      .exec<{ holder_run_id: string; source_run_id: string; session_key: string }>(
        `SELECT holder_run_id, source_run_id, session_key FROM context_refs
       WHERE (retention_pin = 1 OR ordinary_pin = 1) AND holder_run_id IN (SELECT run_id FROM runs UNION SELECT run_id FROM live_runs UNION SELECT '@session:' || key FROM sessions UNION SELECT '@unit:' || instance_id || ':' || unit FROM coordinator_units)`,
      )
      .toArray()
      .map((r) => ({
        holderRunId: r.holder_run_id,
        sourceRunId: r.source_run_id,
        ...(r.session_key ? { sessionKey: r.session_key } : {}),
      }));
  }

  /** Derive protective roots from private facts only for policy-excluded records. */
  private publicationRetentionIds(rows: readonly RetentionRow[], policy: RetentionPolicy, now: number): string[] {
    const ordinary = RunHistoryDO.keptIds(rows, policy, now);
    return this.sql
      .exec<{ run_id: string; summary_json: string; work_evidence_json: string | null }>(
        `SELECT run_id, summary_json, work_evidence_json FROM runs WHERE run_id NOT IN (SELECT value FROM json_each(?))`,
        JSON.stringify([...ordinary]),
      )
      .toArray()
      .filter((row) => this.publicationRetainsRow(row))
      .map((row) => row.run_id);
  }

  private publicationRetainsRow(row: { summary_json: string; work_evidence_json: string | null }): boolean {
    const summary = parseSummary(row);
    if (!summary) return true;
    try {
      const evidence =
        row.work_evidence_json === null ? undefined : parseWorkEvidence(JSON.parse(row.work_evidence_json), summary);
      if (row.work_evidence_json !== null && evidence === undefined) return true;
      return (
        terminalPublicationRetentionRequired(JSON.parse(row.summary_json)) ||
        evidence?.branchPublication !== undefined ||
        evidence?.doorPublicationPending !== undefined ||
        evidence?.reviewPublication !== undefined ||
        evidence?.branchPushReceipts !== undefined
      );
    } catch {
      return true;
    }
  }

  private publicationRetains(runId: string): boolean {
    const row = this.sql
      .exec<{ summary_json: string; work_evidence_json: string | null }>(
        `SELECT summary_json, work_evidence_json FROM runs WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    return row !== undefined && this.publicationRetainsRow(row);
  }

  private contextKeptIds(rows: readonly RetentionRow[], policy: RetentionPolicy, now: number): Set<string> {
    const kept = applyRetention(
      rows.map((r) => ({ id: r.run_id, finishedAt: r.finished_at, bytes: r.bytes })),
      policy,
      now,
      {
        references: this.contextReferences(),
        protectedIds: this.publicationRetentionIds(rows, policy, now),
        liveHolderIds: this.sql
          .exec<{ run_id: string }>(`SELECT run_id FROM live_runs`)
          .toArray()
          .map((r) => r.run_id)
          .concat(
            this.sql
              .exec<{ key: string }>(`SELECT key FROM sessions`)
              .toArray()
              .filter(({ key }) => this.sessionContextRootIsRetained(key, policy, now))
              .map(({ key }) => `@session:${key}`),
          )
          .concat(this.unitContextRoots()),
      },
    );
    return new Set(kept.map((r) => r.id));
  }

  /** A connector/question-only conversation follows the same retention clock.
   * Indexing follows the idempotent row commit and completes before its ACK.
   * A missing source is an explicit gap, never resurrected from a reference. */
  async registerThreadSession(
    key: string,
    threadKey: string,
    now: number,
    context?: ContextDependencies,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (logicalThreadOfSession(key) !== threadKey) return { ok: false, reason: "invalid-thread-session" };
    let result: { ok: boolean; reason?: string } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const { policy } = this.policyState();
      if (!this.contextSourcesAvailable(undefined, context, policy, now)) {
        result = { ok: false, reason: "context-source-unavailable" };
        return;
      }
      this.sql.exec(
        `INSERT INTO sessions (key, thread_key, agent, last_finished_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(key) DO UPDATE SET last_finished_at = MAX(sessions.last_finished_at, excluded.last_finished_at)`,
        key,
        threadKey,
        now,
      );
      this.pinContext(`@session:${key}`, undefined, context);
    });
    if (result.ok && (await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(now + RUN_SWEEP_INTERVAL_MS);
    return result;
  }

  /** Shared logs are roots only through their own ordinary lifetime. Pinned
   * source records cannot keep their consuming conversation alive in a cycle. */
  private sessionContextRootIsRetained(key: string, policy: RetentionPolicy, now: number): boolean {
    const session = this.sql
      .exec<{ thread_key: string; last_finished_at: number }>(
        `SELECT thread_key, last_finished_at FROM sessions WHERE key = ?`,
        key,
      )
      .toArray()[0];
    if (!session || logicalThreadOfSession(key) !== session.thread_key) return false;
    if (session.last_finished_at >= now - policy.retentionDays * 86_400_000) return true;
    if (
      this.sql
        .exec(
          `SELECT 1 FROM live_runs WHERE thread_key = ? OR json_extract(meta_json, '$.threadKey') = ? LIMIT 1`,
          session.thread_key,
          session.thread_key,
        )
        .toArray().length
    )
      return true;
    return this.sql
      .exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs WHERE thread_key = ?`, session.thread_key)
      .toArray()
      .some((row) => this.isKeptByPolicy(row, policy, now));
  }

  private registerSession(req: ClaimRequest): void {
    this.pinContext(req.runId, req.meta.childHandoff);
    if (isContextDependencies(req.state?.contextDependencies))
      this.pinContext(req.runId, undefined, req.state.contextDependencies);
    const session = req.meta.session;
    if (!session) return;
    this.sql.exec(
      `INSERT INTO sessions (key, thread_key, agent) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET thread_key = excluded.thread_key, agent = excluded.agent`,
      session.key,
      req.meta.threadKey,
      req.meta.agent ?? null,
    );
  }

  /** Restore only the original baseline; other segment state keeps its existing lifetime. */
  private preserveArchivedBaseline(runId: string, incoming: RunState, owner: RunWorkOwner): RunState | undefined {
    const archived = this.sql
      .exec<{ summary_json: string; work_evidence_json: string | null }>(
        `SELECT summary_json, work_evidence_json FROM runs WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    if (!archived) return incoming;
    const record: unknown = JSON.parse(archived.summary_json);
    if (!isRunWorkOwner(record) || record.id !== runId) return undefined;
    const evidence =
      archived.work_evidence_json === null
        ? undefined
        : parseWorkEvidence(JSON.parse(archived.work_evidence_json), record);
    if (archived.work_evidence_json !== null && !evidence) return undefined;
    const summary = record as RunWorkOwner & { branchIdentityBaseline?: unknown };
    const baseline =
      evidence && Object.hasOwn(evidence, "branchIdentityBaseline")
        ? evidence.branchIdentityBaseline
        : summary.branchIdentityBaseline;
    if (baseline === undefined) return incoming;
    if (
      summary.branchIdentityBaseline !== undefined &&
      JSON.stringify(summary.branchIdentityBaseline) !== JSON.stringify(baseline)
    )
      return undefined;
    const retained = preserveCheckpointState(
      { branchIdentityBaseline: baseline },
      {
        branchIdentityBaseline: incoming.branchIdentityBaseline,
      },
    );
    if (!retained || !workEvidenceBelongsToRun(retained, owner)) return undefined;
    const binding = (retained.branchIdentityBaseline as { binding: { branch: string; base: string } }).binding;
    const target = owner as RunWorkOwner & { ref?: unknown; baseRef?: unknown };
    if (
      (target.ref !== undefined && target.ref !== binding.branch) ||
      (target.baseRef !== undefined && target.baseRef !== binding.base)
    )
      return undefined;
    return { ...incoming, ...retained };
  }

  private promotionHeld(runId: string, gen?: string): boolean {
    if (gen !== undefined && this.liveRow(runId)?.ownerGen !== gen) return false;
    const raw = this.allocationArchive(runId);
    return raw !== undefined && (!workspaceDurabilityArchiveOf(raw) || promotionPending(raw));
  }
  /** Thin negative precondition from actual private state; never a witness or permit. */
  async promotionHold(runId: string, gen?: string): Promise<PromotionHold | null> {
    const row = this.liveRow(runId);
    if (!row || (gen !== undefined && row.ownerGen !== gen)) return null;
    const raw = this.allocationArchive(runId),
      before = canonicalSeedJson(raw),
      archive = workspaceDurabilityArchiveOf(raw);
    if (raw === undefined) return null;
    if (archive?.promotionConfirmation && !this.promotionHeld(runId)) {
      try {
        const confirmation = archive.promotionConfirmation;
        const source = await this.env.SESSION_LOGS.get(
          this.env.SESSION_LOGS.idFromName(confirmation.key),
        ).readExpectedSeed(confirmation.key, sourceSeedReferenceOfReceipt(confirmation));
        if (
          source.kind === "verified" &&
          source.release &&
          canonicalSeedJson(source.release.confirmation) === canonicalSeedJson(confirmation) &&
          before === canonicalSeedJson(this.allocationArchive(runId))
        )
          return null;
      } catch {
        /* Unknown source release preserves the original. */
      }
      return { kind: "held", reason: "promotion_pending", runId };
    }
    if (!this.promotionHeld(runId)) return null;
    const original = await this.readPromotion({ runId, gen: row.ownerGen });
    const current = this.liveRow(runId);
    if (!current || current.ownerGen !== row.ownerGen) return null;
    return {
      kind: "held",
      reason: original.kind !== "held" ? "promotion_pending" : "promotion_corrupt",
      runId: current.runId,
    };
  }
  private async requirePromotionRelease(runId: string, gen: string): Promise<void> {
    const raw = canonicalSeedJson(this.allocationArchive(runId));
    if (await this.promotionHold(runId, gen)) throw new PromotionPendingError(runId);
    if (raw !== canonicalSeedJson(this.allocationArchive(runId))) throw new PromotionPendingError(runId);
  }
  async preparePromotion(bodyJson: string, expectedSeedInput?: ExpectedSeedManifest): Promise<PromotionPrepareResult> {
    const req = promotionBodyOf(bodyJson);
    if (!req) return { kind: "held", reason: promotionBytes(bodyJson) > PROMOTION_BODY_BYTES ? "oversize" : "corrupt" };
    const expectedSeed = expectedSeedInput === undefined ? undefined : expectedSeedManifestOf(expectedSeedInput);
    const digest = await promotionBodyHash(bodyJson);
    if (expectedSeedInput !== undefined && (!expectedSeed || !expectedSeedMatchesClaim(expectedSeed, req, digest)))
      return { kind: "held", reason: "mismatch" };
    const expectedSeedSha256 = expectedSeed ? await seedContentHash(expectedSeed) : undefined;
    const releaseBefore = canonicalSeedJson(this.allocationArchive(req.runId));
    const pendingRelease = await this.promotionHold(req.runId, req.gen);
    let result: PromotionPrepareResult = { kind: "held", reason: "unknown" };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(req.runId),
        raw = this.allocationArchive(req.runId);
      if (!row || row.ownerGen !== req.gen) {
        result = { kind: "held", reason: "fenced" };
        return;
      }
      if (row.stop === "hard") {
        result = { kind: "held", reason: "mismatch" };
        return;
      }
      let archive = workspaceDurabilityArchiveOf(raw);
      if (!archive) {
        result = { kind: "held", reason: raw === undefined ? "legacy" : "corrupt" };
        return;
      }
      if (
        archive.runId !== row.runId ||
        archive.startedAt !== row.startedAt ||
        !promotionMatchesOriginal(row, req, archive.allocation?.headSha) ||
        (req.meta.workspaceAllocation !== undefined &&
          !sameWorkspaceAllocation(req.meta.workspaceAllocation, archive.allocation))
      ) {
        result = { kind: "held", reason: "mismatch" };
        return;
      }
      if (
        archive.promotion &&
        archive.promotion.bodyJson !== bodyJson &&
        row.meta.restartOf === row.runId &&
        (row.phase === "attaching" || row.phase === "finishing") &&
        archive.promotionConfirmation &&
        archive.promotionAllocationAck &&
        !pendingRelease &&
        canonicalSeedJson(raw) === releaseBefore
      ) {
        this.retainPromotionOriginal(archive);
        const {
          promotion: _old,
          promotionCommit: _commit,
          promotionConfirmation: _confirmation,
          promotionAllocationAck: _ack,
          promotionStepBase: _stepBase,
          ...base
        } = archive;
        archive = base;
      }
      if (archive.promotion) {
        result =
          archive.promotion.bodyJson === bodyJson &&
          archive.promotion.receipt.bodySha256 === digest &&
          archive.promotion.receipt.expectedSeedSha256 === expectedSeedSha256 &&
          canonicalSeedJson(archive.promotion.expectedSeed ?? null) === canonicalSeedJson(expectedSeed ?? null)
            ? { kind: "prepared", receipt: structuredClone(archive.promotion.receipt) }
            : { kind: "held", reason: "mismatch" };
        return;
      }
      if (row.phase !== "attaching" && !(row.phase === "finishing" && row.meta.restartOf === row.runId)) {
        result = { kind: "held", reason: "mismatch" };
        return;
      }
      const receipt = promotionReceiptFromRow(row, digest, expectedSeedSha256);
      const next = {
        ...archive,
        promotion: { version: 1 as const, bodyJson, receipt, ...(expectedSeed ? { expectedSeed } : {}) },
        promotionStepBase: this.sql
          .exec<{ next: number }>(
            "SELECT COALESCE(MAX(step)+1,0) AS next FROM run_steps WHERE run_id=? AND step>=0",
            req.runId,
          )
          .one().next,
      };
      if (promotionBytes(JSON.stringify(next)) > MAX_RECORD_BYTES) {
        result = { kind: "held", reason: "oversize" };
        return;
      }
      this.retainAllocation(next);
      result = { kind: "prepared", receipt: structuredClone(receipt) };
    });
    return result;
  }
  private confirmationSnapshot(runId: string) {
    const entries = this.sql
      .exec<{ step: number; json: string }>(
        "SELECT step,json FROM run_steps WHERE run_id=? AND step>=? ORDER BY step",
        runId,
        workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotionStepBase ?? 0,
      )
      .toArray();
    return { row: this.liveRow(runId), archive: this.allocationArchive(runId), entries };
  }
  async confirmPromotion(input: SourceSeedReference): Promise<PromotionConfirmationResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref || !this.ctx.id.equals(this.env.RUNS.idFromName(ref.storeKey)))
      return { kind: "held", reason: "mismatch" };
    const original = await this.readPromotion({ runId: ref.runId, gen: ref.gen, bodySha256: ref.bodySha256 });
    if (original.kind === "confirmed")
      return sourceSeedReferenceMatches(original.receipt.source, ref, original.receipt.key)
        ? { kind: "confirmed", receipt: original.receipt }
        : { kind: "held", reason: "mismatch" };
    if (original.kind !== "committed" || !original.preparation.expectedSeed?.key)
      return { kind: "held", reason: "unsupported" };
    const snapshot = this.confirmationSnapshot(ref.runId),
      before = canonicalSeedJson({ ...snapshot, row: promotionConfirmationRow(snapshot.row) });
    if (!snapshot.row) return { kind: "held", reason: "fenced" };
    let steps: StepRecord[];
    try {
      steps = snapshot.entries.map((entry) => {
        const record = JSON.parse(entry.json) as StepRecord;
        if (record.step + (workspaceDurabilityArchiveOf(snapshot.archive)?.promotionStepBase ?? 0) !== entry.step)
          throw new Error("unreadable canonical seed key");
        return record;
      });
    } catch {
      return { kind: "held", reason: "corrupt" };
    }
    const key = original.preparation.expectedSeed.key;
    const source = await this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).readExpectedSeed(key, ref);
    const receipt = await confirmStoredSeedBoundary(original, source, snapshot.row, steps);
    if (!receipt) return { kind: "held", reason: "mismatch" };
    let result: PromotionConfirmationResult = { kind: "held", reason: "mismatch" };
    this.ctx.storage.transactionSync(() => {
      const current = this.confirmationSnapshot(ref.runId);
      if (canonicalSeedJson({ ...current, row: promotionConfirmationRow(current.row) }) !== before) return;
      const archive = workspaceDurabilityArchiveOf(snapshot.archive);
      if (!archive?.promotion || !archive.promotionCommit) return;
      const next = { ...archive, promotionConfirmation: receipt, promotionAllocationAck: original.allocationAck };
      if (promotionBytes(JSON.stringify(next)) > MAX_RECORD_BYTES) {
        result = { kind: "held", reason: "oversize" };
        return;
      }
      this.retainAllocation(next);
      result = { kind: "confirmed", receipt: structuredClone(receipt) };
    });
    return result;
  }
  async readPromotion(query: PromotionReadRequest): Promise<PromotionReadResult> {
    if (query.bodySha256) {
      const historical = this.historicalPromotion(query.runId, query.bodySha256);
      if (
        historical?.promotion &&
        historical.promotionCommit &&
        historical.promotionConfirmation &&
        historical.promotionAllocationAck &&
        historical.promotion.receipt.gen === query.gen
      ) {
        const before = canonicalSeedJson(historical);
        if (
          (await promotionBodyHash(historical.promotion.bodyJson)) !== query.bodySha256 ||
          before !== canonicalSeedJson(this.historicalPromotion(query.runId, query.bodySha256))
        )
          return { kind: "held", reason: "corrupt" };
        return {
          kind: "confirmed",
          preparation: historical.promotion,
          commit: historical.promotionCommit,
          receipt: historical.promotionConfirmation,
          allocationAck: historical.promotionAllocationAck,
        };
      }
    }
    const row = this.liveRow(query.runId),
      raw = this.allocationArchive(query.runId);
    if (!row || row.ownerGen !== query.gen) return { kind: "held", reason: "fenced" };
    if (row.stop === "hard") return { kind: "held", reason: "mismatch" };
    const archive = workspaceDurabilityArchiveOf(raw),
      prepared = archive?.promotion;
    if (!archive) return { kind: "held", reason: raw === undefined ? "legacy" : "corrupt" };
    if (!prepared) return { kind: "held", reason: "unknown" };
    if (prepared.receipt.gen !== query.gen || (query.bodySha256 && prepared.receipt.bodySha256 !== query.bodySha256))
      return { kind: "held", reason: "mismatch" };
    if (
      (await promotionBodyHash(prepared.bodyJson)) !== prepared.receipt.bodySha256 ||
      (prepared.expectedSeed !== undefined &&
        (await seedContentHash(prepared.expectedSeed)) !== prepared.receipt.expectedSeedSha256) ||
      JSON.stringify(this.allocationArchive(query.runId)) !== JSON.stringify(raw)
    )
      return { kind: "held", reason: "corrupt" };
    const current = this.liveRow(query.runId);
    if (
      !current ||
      current.ownerGen !== query.gen ||
      JSON.stringify(
        promotionReceiptFromRow(current, prepared.receipt.bodySha256, prepared.receipt.expectedSeedSha256),
      ) !== JSON.stringify(prepared.receipt)
    )
      return { kind: "held", reason: "fenced" };
    if (archive.promotionCommit) {
      const allocationAck = allocationAckFromCanonical(this.allocationArchive(query.runId), current);
      if (!promotionCommittedRowMatches(current, promotionBodyOf(prepared.bodyJson)!) || !allocationAck)
        return { kind: "held", reason: "corrupt" };
      if (archive.promotionConfirmation)
        return {
          kind: "confirmed",
          preparation: structuredClone(prepared),
          commit: structuredClone(archive.promotionCommit),
          receipt: structuredClone(archive.promotionConfirmation),
          allocationAck,
        };
      return {
        kind: "committed",
        preparation: structuredClone(prepared),
        receipt: structuredClone(archive.promotionCommit),
        allocationAck,
      };
    }
    return { kind: "prepared", preparation: structuredClone(prepared) };
  }
  async claim(req: ClaimRequest, now: number, originalBodyJson?: string): Promise<ClaimResult> {
    const restartArchiveBefore = canonicalSeedJson(this.allocationArchive(req.runId));
    const restartHeld =
      req.phase === "attaching" && req.meta.restartOf === req.runId
        ? await this.promotionHold(req.runId, req.gen)
        : undefined;
    const seedBefore = workspaceDurabilityArchiveOf(this.allocationArchive(req.runId))?.promotion?.expectedSeed;
    const seedJsonBefore = canonicalSeedJson(seedBefore ?? null);
    const actualSeedSha256 = seedBefore ? await seedContentHash(seedBefore) : undefined;
    const digest =
      originalBodyJson !== undefined && promotionBytes(originalBodyJson) <= PROMOTION_BODY_BYTES
        ? await promotionBodyHash(originalBodyJson)
        : undefined;
    if (this.promotionHeld(req.runId, req.gen)) {
      const archive = workspaceDurabilityArchiveOf(this.allocationArchive(req.runId));
      if (
        canonicalSeedJson(archive?.promotion?.expectedSeed ?? null) !== seedJsonBefore ||
        archive?.promotion?.receipt.expectedSeedSha256 !== actualSeedSha256
      )
        throw new PromotionPendingError(req.runId, "corrupt");
      const original = preparedPromotionClaim(req, originalBodyJson, digest, this.liveRow(req.runId), archive);
      if (!original) throw new PromotionPendingError(req.runId);
      req = original;
      if (archive?.promotionCommit) {
        const allocationAck = allocationAckFromCanonical(this.allocationArchive(req.runId), this.liveRow(req.runId));
        if (!allocationAck) throw new PromotionPendingError(req.runId, "corrupt");
        return { ok: true, allocationAck, promotionCommit: structuredClone(archive.promotionCommit) };
      }
    }
    if (Object.hasOwn(req.meta, "workspaceDisposition")) throw new Error("workspace disposition is store-derived");
    if (workspaceAuthorityFieldsPresent(req.state))
      throw new Error("workspace allocation cannot be written as mutable state");
    req = structuredClone(req);
    return this.withRangePins([{ id: req.runId, handoff: req.meta.childHandoff }], async () => {
      let out: ClaimResult = { ok: true };
      let duplicateCommit = false;
      this.ctx.storage.transactionSync(() => {
        if (this.promotionHeld(req.runId, req.gen)) {
          const archive = workspaceDurabilityArchiveOf(this.allocationArchive(req.runId));
          if (
            canonicalSeedJson(archive?.promotion?.expectedSeed ?? null) !== seedJsonBefore ||
            archive?.promotion?.receipt.expectedSeedSha256 !== actualSeedSha256
          )
            throw new PromotionPendingError(req.runId, "corrupt");
          const original = preparedPromotionClaim(req, originalBodyJson, digest, this.liveRow(req.runId), archive);
          if (!original) throw new PromotionPendingError(req.runId);
          req = original;
          if (archive?.promotionCommit) {
            const allocationAck = allocationAckFromCanonical(
              this.allocationArchive(req.runId),
              this.liveRow(req.runId),
            );
            if (!allocationAck) throw new PromotionPendingError(req.runId, "corrupt");
            out = { ok: true, allocationAck, promotionCommit: structuredClone(archive.promotionCommit) };
            duplicateCommit = true;
            return;
          }
        }
        const existing = this.liveByThread(req.threadKey);
        if (
          existing?.runId === req.runId &&
          existing.ownerGen === req.gen &&
          req.phase === "attaching" &&
          req.meta.restartOf === req.runId &&
          (existing.phase === "live" || existing.phase === "finishing") &&
          !restartHeld &&
          restartArchiveBefore === canonicalSeedJson(this.allocationArchive(req.runId))
        ) {
          existing.phase = "attaching";
          existing.meta = { ...existing.meta, restartOf: req.runId };
          this.sql.exec(
            "UPDATE live_runs SET phase='attaching',meta_json=? WHERE run_id=? AND owner_gen=?",
            JSON.stringify(existing.meta),
            req.runId,
            req.gen,
          );
        }
        const allocation = prepareWorkspaceAllocation(
          req.runId,
          req.meta,
          this.allocationArchive(req.runId),
          this.liveRow(req.runId) !== undefined || this.finalRecordExists(req.runId),
          req.startedAt,
        );
        req = {
          ...req,
          meta: { ...req.meta, ...(allocation?.allocation ? { workspaceAllocation: allocation.allocation } : {}) },
        };
        const retained = this.sql
          .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, req.runId)
          .toArray()[0];
        const original =
          this.liveRow(req.runId)?.meta ?? (retained ? (JSON.parse(retained.summary_json) as unknown) : undefined);
        if (!validMaintenanceTransport(req.meta) || (original && !sameMaintenanceTransport(original, req.meta)))
          throw new Error("maintenance transport identity conflicts with retained state");
        const restored = this.preserveArchivedBaseline(req.runId, req.state ?? {}, { id: req.runId, ...req.meta });
        const state =
          restored && preserveCheckpointState(existing?.runId === req.runId ? existing.state : {}, restored);
        if (!state) throw new Error("checkpoint state is immutable");
        if (!workEvidenceBelongsToRun(state, { id: req.runId, ...req.meta }))
          throw new Error("work evidence does not match its canonical run");
        req = { ...req, state };
        out = decideClaim(
          existing
            ? {
                runId: existing.runId,
                agent: existing.meta.agent,
                startedAt: existing.startedAt,
                ownerGen: existing.ownerGen,
                idempotencyKey: existing.meta.idempotencyKey,
              }
            : undefined,
          req,
        );
        if (!out.ok) return;
        const acknowledged = () => {
          const allocationAck = allocationAckFromCanonical(this.allocationArchive(req.runId), this.liveRow(req.runId));
          const promotionCommit =
            req.phase === "attaching"
              ? undefined
              : workspaceDurabilityArchiveOf(this.allocationArchive(req.runId))?.promotionCommit;
          out = {
            ok: true,
            ...(allocationAck ? { allocationAck } : {}),
            ...(promotionCommit ? { promotionCommit: structuredClone(promotionCommit) } : {}),
          };
        };
        if (allocation) this.retainAllocation(allocation);
        if (
          existing &&
          state.branchIdentityBaseline !== undefined &&
          existing.state.branchIdentityBaseline === undefined
        ) {
          existing.state = { ...existing.state, branchIdentityBaseline: structuredClone(state.branchIdentityBaseline) };
          this.sql.exec(
            `UPDATE live_runs SET state_json = ? WHERE run_id = ?`,
            JSON.stringify(existing.state),
            req.runId,
          );
        }
        // The claim promotes the thread's reservation (record 0064, "The queue"):
        // the live row holds the thread from here, so the reservation row retires
        // in the same transaction that writes the claim.
        this.sql.exec(`DELETE FROM plane_reservations WHERE kind = 'thread' AND key = ?`, req.threadKey);
        switch (decideClaimWrite(existing, req)) {
          case "keep":
            acknowledged();
            return;
          case "refresh":
            this.sql.exec(`UPDATE live_runs SET lease_until = ? WHERE run_id = ?`, now + req.leaseMs, req.runId);
            acknowledged();
            return;
          case "promote":
            // The prompt landed on the owner's own attaching row (item 42): the
            // claim the dispatcher always made, applied in place — identity,
            // thread and start stay; the row goes live.
            this.sql.exec(
              `UPDATE live_runs SET lease_until = ?, phase = 'live', meta_json = ?, card_json = ?, system_text = ?, tools_json = ?, state_json = ? WHERE run_id = ?`,
              now + req.leaseMs,
              JSON.stringify(req.meta),
              req.card ? JSON.stringify(req.card) : null,
              req.system,
              JSON.stringify(req.tools),
              JSON.stringify({ ...existing!.state, ...state }),
              req.runId,
            );
            this.registerSession(req);
            if (allocation?.promotion && digest) {
              const committed = {
                ...allocation,
                promotionCommit: promotionCommitFromRow(this.liveRow(req.runId)!, digest, actualSeedSha256),
              };
              if (promotionBytes(JSON.stringify(committed)) > MAX_RECORD_BYTES)
                throw new PromotionPendingError(req.runId);
              this.retainAllocation(committed);
            }
            acknowledged();
            return;
          case "insert":
            break;
        }
        this.registerSession(req);
        this.sql.exec(
          `INSERT INTO live_runs (run_id, thread_key, owner_gen, lease_until, started_at, phase, stop, meta_json, card_json, system_text, tools_json, state_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          req.runId,
          req.threadKey,
          req.gen,
          now + req.leaseMs,
          req.startedAt,
          req.phase ?? "live",
          JSON.stringify(req.meta),
          req.card ? JSON.stringify(req.card) : null,
          req.system,
          JSON.stringify(req.tools),
          JSON.stringify(state),
        );
        acknowledged();
      });
      if (out.ok && !duplicateCommit) {
        // A `restartOf` claim under a coordinator (record 0064): the plane
        // tells the waiting parent the child resumed — best effort, beside the
        // bot's own announcement; a duplicate is consumed and re-armed, harmless.
        if (req.meta.restartOf !== undefined && req.meta.parentInstanceId !== undefined) {
          const recoveryTransport = this.recoveryTransport(req.meta.parentInstanceId, req.meta.idempotencyKey);
          const sent = await sendChildSignal(this.env.SHIP_COORDINATOR, {
            runId: req.runId,
            parentInstanceId: req.meta.parentInstanceId,
            ...(recoveryTransport !== undefined ? { transportWorkflowId: recoveryTransport } : {}),
            kind: "resumed",
            reason: `restarted from run ${req.meta.restartOf}`,
            at: now,
          });
          if (sent.kind === "failed")
            console.warn(`[runs/claim] ${req.runId} → ${sent.type} not delivered to ${sent.instance}: ${sent.reason}`);
        }
        // The lease end joins the plane's alarm (record 0064): armed at the earliest due.
        await this.ensurePlaneAlarm(now);
      }
      return out;
    });
  }

  /** Extends the lease iff the caller owns the run; answers what another generation asked for. */
  async heartbeat(
    runId: string,
    gen: string,
    leaseMs: number,
    now: number,
    facts?: HeartbeatFacts,
  ): Promise<HeartbeatAnswer> {
    let out: HeartbeatAnswer = { ok: false, reason: "unknown-run" };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok || !row) {
        out = fence;
        return;
      }
      this.sql.exec(`UPDATE live_runs SET lease_until = ? WHERE run_id = ?`, now + leaseMs, runId);
      // The heartbeat body (record 0064): the facts are judged for the
      // checkpoint steer in this same transaction, so the inbox row and its
      // dedupe row land with the lease or not at all. A cap throw here must
      // not undo the lease of a healthy run, so the decision guards itself.
      if (facts !== undefined) {
        try {
          const decision = decide(this.planeState(), { kind: "heartbeat", at: now, runId, facts });
          this.applyPlaneWrites(decision.writes);
          if (decision.writes.some((w) => w.table === "run_inbox"))
            console.log(`[plane/steer] run ${runId} round ${facts.round} — checkpoint steer written`);
        } catch (err) {
          console.warn(`[plane/steer] run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // The plane's open effects ride every owner's heartbeat answer (record
      // 0064; orchestration-plane item 7) — empty until a unit writes them, but always present, so the
      // client's ack loop needs no version probe.
      out = { ok: true, stop: row.stop, phase: row.phase, effects: this.openPlaneEffects() };
    });
    // The owner's heartbeat refreshes the lease, so the plane's alarm moves
    // with it (record 0064): re-armed only when the earliest due changed.
    if (out.ok) await this.ensurePlaneAlarm(now);
    return out;
  }

  /** Append events with their registry seq (item 30). Fenced. */
  async appendEvents(runId: string, gen: string, events: Array<{ seq: number; json: string }>): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      out = checkFence(this.liveRow(runId), gen);
      if (!out.ok) return;
      if (
        !maintenanceEventsMatch(
          this.liveRow(runId)!.meta,
          events.map((event) => JSON.parse(event.json)),
        )
      ) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      const originalMeta = this.liveRow(runId)!.meta;
      if (originalMeta.maintenanceActionId !== undefined) {
        const previousBySeq = new Map<number, unknown>();
        for (const event of events) {
          const saved = this.sql
            .exec<{ json: string }>(`SELECT json FROM run_events WHERE run_id = ? AND seq = ?`, runId, event.seq)
            .toArray()[0];
          const previous = previousBySeq.get(event.seq) ?? (saved ? (JSON.parse(saved.json) as unknown) : undefined);
          const next: unknown = JSON.parse(event.json);
          if (!preserveMaintenanceEvent(originalMeta, previous, next)) {
            out = { ok: false, reason: "fenced" };
            return;
          }
          previousBySeq.set(event.seq, next);
        }
      }
      for (let i = 0; i < events.length; i += RUN_EVENT_INSERT_BATCH) {
        const batch = events.slice(i, i + RUN_EVENT_INSERT_BATCH);
        const params: (string | number)[] = [];
        for (const e of batch) params.push(runId, e.seq, e.json);
        this.sql.exec(
          `INSERT OR REPLACE INTO run_events (run_id, seq, json) VALUES ${batch.map(() => "(?, ?, ?)").join(",")}`,
          ...params,
        );
      }
    });
    return out;
  }

  /** The step record (item 31), written by the client AFTER the transcript turns. Fenced. */
  async recordStep(runId: string, gen: string, record: StepRecord): Promise<FenceResult> {
    if (!Number.isSafeInteger(record.step) || record.step < 0) throw new Error("invalid public step key");
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      out = checkFence(this.liveRow(runId), gen);
      if (!out.ok) return;
      if (inboxSegmentFloor(this.inboxSegmentArchive(runId), this.liveRow(runId)!) === undefined)
        throw new Error("retained inbox segment boundary is unreadable");
      this.sql.exec(
        `INSERT OR REPLACE INTO run_steps (run_id, step, json) VALUES (?, ?, ?)`,
        runId,
        (workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotionStepBase ?? 0) + record.step,
        JSON.stringify(record),
      );
    });
    return out;
  }

  async assignLiveState(
    runId: string,
    gen: string,
    assignment: LiveStateAssignRequest,
  ): Promise<LiveStateAssignResult> {
    if (workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotion)
      await this.requirePromotionRelease(runId, gen);
    if (workspaceAuthorityFieldsPresent(assignment.statePatch)) return { ok: false, reason: "fenced" };
    let out: LiveStateAssignResult = { ok: false, reason: "unknown-run" };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok) {
        out = fence;
        return;
      }
      if (!row) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (
        !preserveCheckpointState(row.state, assignment.statePatch ?? {}) ||
        !workEvidenceBelongsToRun({ ...row.state, ...assignment.statePatch }, { id: row.runId, ...row.meta })
      ) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      const result = assignLedgerLiveState(row.liveState, row.liveStateSeq ?? 0, assignment);
      if (!result.ok) {
        out = result;
        return;
      }
      let liveStateSeq = row.liveStateSeq ?? 0;
      const last = this.sql
        .exec<{ m: number | null }>(`SELECT MAX(seq) AS m FROM run_events WHERE run_id = ?`, runId)
        .one().m;
      let lastEventSeq = last ?? 0;
      for (const source of assignment.sourceEvents ?? []) {
        if (source.seq <= lastEventSeq) {
          out = { ok: false, reason: "stale-sequence" };
          return;
        }
        lastEventSeq = source.seq;
      }
      const boundarySeq = result.event ? (assignment.eventSeq ?? lastEventSeq + 1) : undefined;
      if (boundarySeq !== undefined && boundarySeq <= lastEventSeq) {
        out = { ok: false, reason: "stale-sequence" };
        return;
      }
      for (const source of assignment.sourceEvents ?? []) {
        this.sql.exec(
          `INSERT INTO run_events (run_id, seq, json) VALUES (?, ?, ?)`,
          runId,
          source.seq,
          JSON.stringify(source),
        );
        liveStateSeq = source.seq;
      }
      if (result.event && boundarySeq !== undefined) {
        liveStateSeq = boundarySeq;
        this.sql.exec(
          `INSERT INTO run_events (run_id, seq, json) VALUES (?, ?, ?)`,
          runId,
          liveStateSeq,
          JSON.stringify({ ...result.event, seq: liveStateSeq }),
        );
      }
      const state = preserveCheckpointState(row.state, {
        ...row.state,
        ...assignment.statePatch,
        liveState: result.liveState,
        liveStateSeq,
      });
      if (!state) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      if (isContextDependencies(state.contextDependencies))
        this.pinContext(runId, undefined, state.contextDependencies);
      this.sql.exec(`UPDATE live_runs SET state_json = ? WHERE run_id = ?`, JSON.stringify(state), runId);
      out = {
        ...result,
        ...(result.event ? { event: { ...result.event, seq: liveStateSeq } } : {}),
        liveStateSeq,
      };
    });
    return out;
  }

  async setState(runId: string, gen: string, state: RunState): Promise<FenceResult | PromotionHold> {
    // A known precondition crosses RPC as data. A remote exception cannot keep
    // the custom class that the HTTP handler would otherwise need to catch.
    const pending = (): PromotionHold => ({ kind: "held", reason: "promotion_pending", runId });
    if (workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotion) {
      const before = canonicalSeedJson(this.allocationArchive(runId));
      const hold = await this.promotionHold(runId, gen);
      if (hold) return hold;
      if (before !== canonicalSeedJson(this.allocationArchive(runId))) return pending();
    }
    if (workspaceAuthorityFieldsPresent(state)) return { ok: false, reason: "fenced" };
    if (this.promotionHeld(runId, gen)) return pending();
    return this.ctx.blockConcurrencyWhile(async (): Promise<FenceResult | PromotionHold> => {
      const row = this.liveRow(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok) return fence;
      if (!row) return { ok: false, reason: "unknown-run" };
      if (this.promotionHeld(runId, gen)) return pending();
      const restored = this.preserveArchivedBaseline(runId, state, { id: runId, ...row.meta });
      if (!restored) return { ok: false, reason: "fenced" };
      state = restored;
      const mintSeed = state.unitSeedReceipt !== undefined && row.state.unitSeedReceipt === undefined;
      const preserved = preserveCheckpointState(row.state, state, mintSeed);
      if (!preserved || !workEvidenceBelongsToRun(preserved, { id: row.runId, ...row.meta }))
        return { ok: false, reason: "fenced" };
      const receipt = preserved.unitSeedReceipt as UnitSeedReceipt | undefined;
      if (mintSeed && receipt) {
        const checkpoint = row.state.contextCheckpoint as { key?: string; through?: number } | undefined;
        const lastJson = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM run_steps WHERE run_id = ? AND step >= 0 ORDER BY step DESC LIMIT 1`,
            runId,
          )
          .toArray()[0]?.json;
        const last = lastJson ? (JSON.parse(lastJson) as StepRecord) : undefined;
        if (
          receipt.ownerGen !== gen ||
          checkpoint?.key !== receipt.seed.key ||
          checkpoint.through !== receipt.seed.through ||
          !last ||
          last.step !== 0 ||
          last.inFlight.length ||
          receipt.seed.through !== receipt.seed.from + last.turnIndex - 1
        )
          return { ok: false, reason: "fenced" };
        const log = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(receipt.seed.key));
        if (
          (await sourceHash(row.system)) !== receipt.seed.systemHash ||
          !(await log.acknowledgeUnitSeed(runId, gen, receipt)).ok
        )
          return { ok: false, reason: "fenced" };
      }
      let promotionRefused = false;
      this.ctx.storage.transactionSync(() => {
        if (this.promotionHeld(runId, gen)) {
          promotionRefused = true;
          return;
        }
        if (isContextDependencies(preserved.contextDependencies))
          this.pinContext(runId, undefined, preserved.contextDependencies);
        if (receipt) this.pinReference(runId, runId, receipt.seed.key);
        this.sql.exec(`UPDATE live_runs SET state_json = ? WHERE run_id = ?`, JSON.stringify(preserved), runId);
      });
      if (promotionRefused) return pending();
      return { ok: true };
    });
  }

  /** Any generation: a steer arrives on whichever container is up. */
  async pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }> {
    let out: { ok: boolean; seq?: number } = { ok: false };
    this.ctx.storage.transactionSync(() => {
      const owner = this.liveRow(runId);
      if (!owner) return;
      const stored = bindInboxCustody(message, {
        runId,
        channelId: owner.meta.channelId,
        threadKey: owner.meta.threadKey,
        requester: owner.meta.userId,
        producerGen: owner.ownerGen,
      });
      if (!stored) return;
      const last = this.sql
        .exec<{ m: number | null }>(`SELECT MAX(seq) AS m FROM run_inbox WHERE run_id = ?`, runId)
        .one().m;
      const seq = (last ?? 0) + 1;
      this.sql.exec(`INSERT INTO run_inbox (run_id, seq, json) VALUES (?, ?, ?)`, runId, seq, JSON.stringify(stored));
      out = { ok: true, seq };
    });
    return out;
  }

  /** The inbox past a seq (run-history item 40): the resume's re-read at adopt. */
  async readInbox(runId: string, afterSeq: number): Promise<{ seq: number; message: Record<string, unknown> }[]> {
    const row = this.liveRow(runId);
    const floor = row ? inboxSegmentFloor(this.inboxSegmentArchive(runId), row) : 0;
    if (floor === undefined) return [];
    return this.sql
      .exec<{ seq: number; json: string }>(
        `SELECT seq, json FROM run_inbox WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
        runId,
        Math.max(afterSeq, floor),
      )
      .toArray()
      .map((r) => ({ seq: r.seq, message: JSON.parse(r.json) as Record<string, unknown> }));
  }

  async peekInbox(
    runId: string,
    gen: string,
    afterSeq: number,
  ): Promise<import("../../src/core/runLedger/types.ts").InboxPeek> {
    const capture = () => {
      const row = this.liveRow(runId);
      const step = this.sql
        .exec<{ json: string }>(
          "SELECT json FROM run_steps WHERE run_id=? AND step>=0 ORDER BY step DESC LIMIT 1",
          runId,
        )
        .toArray()[0]?.json;
      const inbox = this.sql
        .exec<{ seq: number; json: string }>("SELECT seq,json FROM run_inbox WHERE run_id=? ORDER BY seq", runId)
        .toArray();
      const archive = this.inboxSegmentArchive(runId);
      return { row, step, inbox, archive };
    };
    const initial = capture();
    const fence = checkFence(initial.row, gen);
    if (!fence.ok || !initial.row) return fence.ok ? { ok: false, reason: "unknown-run" } : fence;
    if (
      initial.inbox.length > RUN_EVENTS_MAX_PAGE ||
      initial.inbox.reduce((size, item) => size + 3 * item.json.length, 0) > MAX_RECORD_BYTES
    )
      return { ok: false, reason: "incomplete" };
    const before = JSON.stringify({
      gen: initial.row.ownerGen,
      state: initial.row.state,
      step: initial.step,
      inbox: initial.inbox,
      archive: initial.archive,
    });
    try {
      const state = structuredClone(initial.row.state);
      const lastStep: unknown = initial.step ? JSON.parse(initial.step) : null;
      const floor = inboxSegmentFloor(initial.archive, initial.row);
      if (floor === undefined) return { ok: false, reason: "incomplete" };
      const rows = initial.inbox.filter((item) => item.seq > Math.max(afterSeq, floor));
      const items = await Promise.all(
        rows.map(async (item) => {
          const message: unknown = JSON.parse(item.json);
          if (!message || typeof message !== "object" || Array.isArray(message))
            throw new Error("unreadable inbox row");
          return {
            seq: item.seq,
            message: message as Record<string, unknown>,
            witness: { version: 1 as const, runId, seq: item.seq, digest: await sourceHash(message) },
          };
        }),
      );
      const current = capture();
      if (
        before !==
        JSON.stringify({
          gen: current.row?.ownerGen,
          state: current.row?.state,
          step: current.step,
          inbox: current.inbox,
          archive: current.archive,
        })
      )
        return { ok: false, reason: "incomplete" };
      return { ok: true, version: 1, runId, gen, items, boundary: { state, lastStep } };
    } catch {
      return { ok: false, reason: "incomplete" };
    }
  }

  async requestStop(runId: string, mode: StopMode, now: number): Promise<{ ok: boolean; ownerLive?: boolean }> {
    let out: { ok: boolean; ownerLive?: boolean } = { ok: false };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      if (!row) return;
      this.sql.exec(`UPDATE live_runs SET stop = ? WHERE run_id = ?`, mode, runId);
      out = { ok: true, ownerLive: row.leaseUntil > now };
    });
    return out;
  }

  /** SIGTERM: mark this generation's live runs for the next one (item 33). */
  async handoff(gen: string, runIds: string[], pausedForRetry = false): Promise<{ marked: string[] }> {
    const released = await Promise.all(
      runIds.map(async (runId) => ({
        runId,
        raw: canonicalSeedJson(this.allocationArchive(runId)),
        held: await this.promotionHold(runId, gen),
      })),
    );
    runIds = released
      .filter((item) => !item.held && item.raw === canonicalSeedJson(this.allocationArchive(item.runId)))
      .map((item) => item.runId);
    const marked: string[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const id of runIds) {
        const row = this.liveRow(id);
        if (row && row.ownerGen === gen && !this.promotionHeld(id) && phaseTransition(row.phase, "handoff")) {
          this.sql.exec(
            `UPDATE live_runs SET phase = 'handoff', state_json = ? WHERE run_id = ?`,
            JSON.stringify(pausedForRetry ? { ...row.state, pausedForRetry: true } : row.state),
            id,
          );
          marked.push(id);
        }
      }
    });
    return { marked };
  }

  /** CAS live → finishing, taken before the reply (item 33). Fenced. */
  async finishing(runId: string, gen: string): Promise<FenceResult> {
    if (workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotion)
      await this.requirePromotionRelease(runId, gen);
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok || !row) {
        out = fence;
        return;
      }
      if (!phaseTransition(row.phase, "finishing")) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(`UPDATE live_runs SET phase = 'finishing' WHERE run_id = ?`, runId);
    });
    return out;
  }

  /** The finished record replaces the live rows in ONE transaction (item 33).
   *  Fenced. Then, for a record carrying `parentInstanceId`, ONE `run
   *  finished:<runId>` to that coordinator instance (item 47) — after the
   *  commit, never inside it, and never able to undo it: a refused send (the
   *  instance ended, no binding) is the answer's `event`, not an error. */
  async finish(
    runId: string,
    gen: string,
    record: RunRecord,
    proposal?: RunPolicyProposal,
    point?: RunMetricsPoint,
    requireStoppedPause = false,
  ): Promise<FenceResult & { stored?: boolean; event?: RunFinishedSend["kind"] }> {
    if (workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotion)
      await this.requirePromotionRelease(runId, gen);
    if (workspaceAuthorityFieldsPresent(record)) return { ok: false, reason: "fenced" };
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    const opening = this.liveRow(runId);
    const admitted = checkFence(opening, gen);
    if (!admitted.ok) return admitted;
    if (
      !opening ||
      !terminalWorkspaceRecordMatches(opening, record) ||
      !sameMaintenanceTransport(opening.meta, record) ||
      !maintenanceEventsMatch(opening.meta, record.events)
    )
      return { ok: false, reason: "fenced" };
    this.checkWorkspaceFinishCapacity(opening, record);
    const allocation = workspaceDurabilityArchiveOf(this.allocationArchive(runId));
    const custodyBefore = allocation?.allocation ? this.workspaceCustodyFingerprint(opening) : undefined;
    const custody = allocation?.allocation ? await this.workspaceCustody(opening) : undefined;
    record = await this.archiveCheckpoint(record);
    const confirming = this.liveRow(runId);
    const confirmed =
      custody?.session && custody.threadReport && confirming ? await this.workspaceCustody(confirming) : custody;
    let out: FenceResult & { stored?: boolean } = { ok: true };
    let turnedFinal = false;
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok) {
        out = fence;
        return;
      }
      if (
        requireStoppedPause &&
        (row?.phase !== "handoff" ||
          row.state.pausedForRetry !== true ||
          row.stop !== "hard" ||
          record.status !== "stopped_hard")
      ) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      if (
        !row ||
        !terminalWorkspaceRecordMatches(row, record) ||
        !sameMaintenanceTransport(row.meta, record) ||
        !maintenanceEventsMatch(row.meta, record.events)
      ) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      if (row) this.checkWorkspaceFinishCapacity(row, record);
      if (
        allocation?.allocation &&
        row &&
        (custodyBefore !== this.workspaceCustodyFingerprint(row) || !sameWorkspaceCustody(custody, confirmed))
      ) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      const put = this.upsertInTransaction(record, proposal);
      if (allocation?.allocation && row && confirmed)
        this.retainAllocation({
          ...allocation,
          disposition: deriveWorkspaceDisposition(allocation.allocation, row, record, confirmed),
        });
      const obligation = row && terminalWorkspaceSettlement(row, record);
      if (obligation) {
        obligation.revision = nextWorkspaceRevision(this.workspaceRevision(obligation.owner));
        this.sql.exec(
          `INSERT INTO workspace_settlements (owner_key, revision, json) VALUES (?, ?, ?)`,
          workspaceOwnerKey(obligation.owner),
          obligation.revision,
          JSON.stringify(obligation),
        );
      }
      this.deleteLiveRows([runId]);
      // The ending's cause (record 0064), recorded exactly when the live
      // row closes: the record's own status word, `restarting` reading as the
      // resident replacement the reattach path observed.
      this.recordPlaneEnding(
        runId,
        record.status,
        causeOfClose(record.status, record.restarting === true),
        record.finishedAt,
        true,
      );
      turnedFinal = put.turnedFinal;
      out = { ok: true, stored: put.stored };
    });
    if (!out.ok) return out;
    // The seal flips `thread_free` (record 0064, "The queue"): the plane frees
    // the thread, drops the sealed run's own open effects and walks the queue.
    this.planeSealed(runId, record.threadKey, systemClock());
    // The point after the commit, never inside it (`sendRunFinished`'s placement):
    // the finish usually replaces the start tombstone, so this is where most
    // runs are counted (run-metrics.md item 2).
    this.writeMetricsPoint(runId, point, turnedFinal && out.stored === true);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
    await this.refreshSessionBytes(record.session?.key);
    const transportWorkflowId =
      record.parentInstanceId === undefined
        ? undefined
        : this.recoveryTransport(record.parentInstanceId, record.idempotencyKey);
    const event = await sendRunFinished(this.env.SHIP_COORDINATOR, {
      ...record,
      ...(transportWorkflowId !== undefined ? { transportWorkflowId } : {}),
    });
    if (event.kind === "failed")
      console.warn(`[runs/finish] ${runId} → ${event.type} not delivered to ${event.instance}: ${event.reason}`);
    return { ...out, event: event.kind };
  }

  /** The live rows go with no record (item 42): a reserved run that never
   *  started. Fenced. */
  async abandon(runId: string, gen: string): Promise<FenceResult> {
    if (workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotion)
      await this.requirePromotionRelease(runId, gen);
    const admitted = checkFence(this.liveRow(runId), gen);
    if (!admitted.ok) return admitted;
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    // A private custody refusal must not break the object's input gate.
    this.prepareInboxSegment(runId);
    let pinKeys: string[] = [];
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      let out: FenceResult = { ok: true };
      let held: PromotionPendingError | undefined;
      let threadKey: string | undefined;
      this.ctx.storage.transactionSync(() => {
        if (this.promotionHeld(runId, gen)) {
          held = new PromotionPendingError(runId);
          return;
        }
        const row = this.liveRow(runId);
        out = checkFence(row, gen);
        if (!out.ok) return;
        const allocation = workspaceDurabilityArchiveOf(this.allocationArchive(runId));
        if (allocation?.allocation && row)
          this.retainAllocation({
            ...allocation,
            disposition: deriveWorkspaceDisposition(allocation.allocation, row, undefined, {
              events: [],
              pendingEffects: true,
            }),
          });
        threadKey = row?.threadKey;
        // Only this holder or source can lose a pin when its live row goes.
        // The conditional pin sweep runs after the owning commit's input gate.
        pinKeys = this.sql
          .exec<{ session_key: string }>(
            `SELECT DISTINCT session_key FROM context_refs
             WHERE session_key != '' AND (holder_run_id = ? OR source_run_id = ?)`,
            runId,
            runId,
          )
          .toArray()
          .map((ref) => ref.session_key);
        this.deleteLiveRows([runId]);
      });
      if (held) return held;
      if (!out.ok) return out;
      // An abandoned reservation seals like a finish does: the thread frees and the queue walks.
      if (threadKey !== undefined) this.planeSealed(runId, threadKey, systemClock());
      return out;
    });
    if (result instanceof PromotionPendingError) throw result;
    if (result.ok && pinKeys.length > 0) await this.syncRangePins(pinKeys);
    return result;
  }

  private deleteLiveRows(runIds: string[]): void {
    for (const id of runIds) {
      const encoded = this.prepareInboxSegment(id);
      if (encoded !== undefined) {
        this.sql.exec(
          "INSERT OR REPLACE INTO run_steps(run_id,step,json) VALUES(?,?,?)",
          id,
          INBOX_SEGMENT_ARCHIVE_STEP,
          encoded,
        );
        this.sql.exec("DELETE FROM run_steps WHERE run_id=? AND step>=0", id);
      }
      this.sql.exec(`DELETE FROM live_runs WHERE run_id = ?`, id);
      // A terminal run does not acknowledge queued inputs. Keep canonical
      // inbox bytes until their original native consumption is established.
      this.sql.exec(`DELETE FROM run_jobs WHERE run_id = ?`, id);
    }
  }

  private prepareInboxSegment(runId: string): string | undefined {
    const row = this.liveRow(runId);
    if (!row) return;
    const previous = this.inboxSegmentArchive(runId);
    if (previous !== undefined && inboxSegmentFloor(previous, row) === undefined)
      throw new Error("retained inbox segment boundary is unreadable");
    const last = this.sql
      .exec<{ json: string }>("SELECT json FROM run_steps WHERE run_id=? AND step>=0 ORDER BY step DESC LIMIT 1", runId)
      .toArray()[0];
    const highWater =
      this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM run_inbox WHERE run_id=?", runId).one().m ?? 0;
    return encodeInboxSegment(
      closeInboxSegment(previous, row, last ? (JSON.parse(last.json) as StepRecord) : null, highWater),
      MAX_RECORD_BYTES,
    );
  }

  private inboxSegmentArchive(runId: string): unknown {
    const negative = this.sql
      .exec<{ count: number; key: number | null; bytes: number | null }>(
        "SELECT COUNT(*) AS count,MIN(step) AS key,MAX(LENGTH(CAST(json AS BLOB))) AS bytes FROM run_steps WHERE run_id=? AND step<0",
        runId,
      )
      .one();
    if (negative.count === 0) return undefined;
    if (negative.count !== 1 || negative.key !== INBOX_SEGMENT_ARCHIVE_STEP || (negative.bytes ?? 0) > MAX_RECORD_BYTES)
      return null;
    const raw = this.sql
      .exec<{ json: string }>("SELECT json FROM run_steps WHERE run_id=? AND step=?", runId, INBOX_SEGMENT_ARCHIVE_STEP)
      .one().json;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** A booting generation takes every expired or handed-off run (item 31),
   *  atomically, with what a resume needs. */
  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const candidates = selectReclaim(
      this.sql.exec<LiveRow>("SELECT * FROM live_runs").toArray().map(rowToLive),
      now,
      gen,
    );
    const observed = await Promise.all(
      candidates.map(async (row) => ({
        runId: row.runId,
        raw: canonicalSeedJson(this.allocationArchive(row.runId)),
        held: await this.promotionHold(row.runId, row.ownerGen),
      })),
    );
    const out: ReclaimedRun[] = [];
    this.ctx.storage.transactionSync(() => {
      const rows = this.sql.exec<LiveRow>(`SELECT * FROM live_runs`).toArray().map(rowToLive);
      for (const row of selectReclaim(rows, now, gen).filter(
        (row) =>
          !this.promotionHeld(row.runId) &&
          observed.some(
            (item) =>
              item.runId === row.runId &&
              !item.held &&
              item.raw === canonicalSeedJson(this.allocationArchive(row.runId)),
          ),
      )) {
        const phase = reclaimPhase(row.phase);
        const state = { ...row.state };
        delete state.pausedForRetry;
        this.sql.exec(
          `UPDATE live_runs SET owner_gen = ?, lease_until = ?, phase = ?, state_json = ? WHERE run_id = ?`,
          gen,
          now + leaseMs,
          phase,
          JSON.stringify(state),
          row.runId,
        );
        const stepRow = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM run_steps WHERE run_id = ? AND step >= 0 ORDER BY step DESC LIMIT 1`,
            row.runId,
          )
          .toArray()[0];
        const lastStep = stepRow ? (JSON.parse(stepRow.json) as StepRecord) : null;
        // Past the cursor, plus the deferred rows at or below it: the lowest
        // deferred seq bounds the read, and the record's predicate filters.
        const unread = unreadInbox(lastStep);
        const floor = inboxSegmentFloor(this.inboxSegmentArchive(row.runId), row);
        const from = Math.min(
          lastStep?.inboxConsumedSeq ?? 0,
          ...(lastStep?.inboxDeferredSeqs ?? []).map((s) => s - 1),
        );
        const inbox = this.sql
          .exec<{ seq: number; json: string }>(
            `SELECT seq, json FROM run_inbox WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
            row.runId,
            from,
          )
          .toArray()
          .map((r) => ({ seq: r.seq, message: JSON.parse(r.json) as Record<string, unknown> }))
          .filter((item) => floor !== undefined && item.seq > floor && unread(item));
        const jobs = this.sql
          .exec<{ kind: string; json: string }>(`SELECT kind, json FROM run_jobs WHERE run_id = ?`, row.runId)
          .toArray()
          .map((r) => ({ kind: r.kind, payload: JSON.parse(r.json) as unknown }));
        out.push({
          row: { ...row, ownerGen: gen, leaseUntil: now + leaseMs, phase, state },
          reclaimedFrom: row.phase,
          lastStep,
          inbox,
          jobs,
        });
      }
    });
    return out;
  }

  async listLive(): Promise<LiveRunRow[]> {
    return this.sql.exec<LiveRow>(`SELECT * FROM live_runs ORDER BY started_at ASC`).toArray().map(rowToLive);
  }

  /** Exact owner evidence for resident cleanup. Read live first and bypass
   * history retention: absence from a retained history view is not an ending. */
  private historicalPromotion(runId: string, digest: string): WorkspaceDurabilityArchive | undefined {
    const rows = this.sql
      .exec<{ revision: number; allocation_json: string }>(
        "SELECT revision,allocation_json FROM workspace_settlements WHERE owner_key=?",
        originalPromotionArchiveKey(runId, digest),
      )
      .toArray();
    if (!rows.length) return;
    if (rows.length !== 1 || rows[0].revision !== 1) throw new PromotionPendingError(runId, "corrupt");
    try {
      return workspaceDurabilityArchiveOf(JSON.parse(rows[0].allocation_json));
    } catch {
      throw new PromotionPendingError(runId, "corrupt");
    }
  }
  private retainPromotionOriginal(archive: WorkspaceDurabilityArchive): void {
    const key = originalPromotionArchiveKey(archive.runId, archive.promotion!.receipt.bodySha256),
      old = this.historicalPromotion(archive.runId, archive.promotion!.receipt.bodySha256);
    if (old && canonicalSeedJson(old) !== canonicalSeedJson(archive))
      throw new PromotionPendingError(archive.runId, "corrupt");
    if (!old)
      this.sql.exec(
        "INSERT INTO workspace_settlements(owner_key,revision,json,allocation_json) VALUES(?,1,NULL,?)",
        key,
        JSON.stringify(archive),
      );
  }
  private allocationArchive(runId: string): unknown {
    const rows = this.sql
      .exec<{ revision: number; allocation_json: string }>(
        `SELECT revision,allocation_json FROM workspace_settlements WHERE owner_key = ? AND allocation_json IS NOT NULL`,
        workspaceDurabilityKey(runId),
      )
      .toArray();
    if (rows.length === 0) return undefined;
    if (rows.length !== 1 || rows[0].revision !== 1) return { unreadableRevision: rows };
    try {
      return JSON.parse(rows[0].allocation_json);
    } catch {
      return null;
    }
  }

  private retainAllocation(value: WorkspaceDurabilityArchive): void {
    this.sql.exec(
      `INSERT INTO workspace_settlements (owner_key, revision, json, allocation_json) VALUES (?, 1, NULL, ?)
      ON CONFLICT(owner_key, revision) DO UPDATE SET allocation_json = excluded.allocation_json`,
      workspaceDurabilityKey(value.runId),
      JSON.stringify(value),
    );
  }

  private finalRecordExists(runId: string): boolean {
    const row = this.sql
      .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) return false;
    try {
      return JSON.parse(row.summary_json).provisional !== true;
    } catch {
      return true;
    }
  }

  private storedWorkspaceFacts(row: LiveRunRow): StoredWorkspaceCustody {
    const stepRow = this.sql
      .exec<{ json: string }>(`SELECT json FROM run_steps WHERE run_id = ? ORDER BY step DESC LIMIT 1`, row.runId)
      .toArray()[0];
    const events = this.sql
      .exec<{ seq: number; json: string }>(`SELECT seq, json FROM run_events WHERE run_id = ? ORDER BY seq`, row.runId)
      .toArray()
      .map((e) => ({ ...JSON.parse(e.json), seq: e.seq }) as RunEvent);
    const step = stepRow && (JSON.parse(stepRow.json) as StepRecord);
    const jobs =
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_jobs WHERE run_id = ?`, row.runId).toArray()[0]?.n ??
      0;
    const unread = this.sql
      .exec<{ seq: number }>(`SELECT seq FROM run_inbox WHERE run_id = ?`, row.runId)
      .toArray()
      .some(unreadInbox(step ?? null));
    // The delivery response is globally capped; it cannot prove absence for a
    // particular run. Only the exact intents retired by planeSealed are exempt.
    const openEffects = this.sql
      .exec<{ id: string; body_json: string }>(
        `SELECT id,body_json FROM plane_effects WHERE acked_at IS NULL AND
       CASE WHEN json_valid(body_json) THEN json_extract(body_json,'$.runId') = ? OR id = ? ELSE 1 END`,
        row.runId,
        `admit:${row.runId}`,
      )
      .toArray()
      .some((e) => workspaceEffectNeedsCustody(row.runId, row.threadKey, e));
    return {
      events,
      step,
      pendingEffects: jobs > 0 || unread || openEffects || row.state.pausedForRetry === true,
    };
  }

  private workspaceCustodyFingerprint(row: LiveRunRow): string {
    return workspaceCustodyFingerprint(row, this.storedWorkspaceFacts(row));
  }

  private async workspaceCustody(row: LiveRunRow): Promise<StoredWorkspaceCustody> {
    const read = this.storedWorkspaceFacts(row),
      session = row.meta.session;
    const facts = {
      ...read,
      leaseHash: await sourceHash(read.events.find((e) => e.type === "lease") ?? null),
      reportHash: await sourceHash([...read.events].reverse().find((e) => e.type === "answer") ?? null),
    };
    if (!session || session.range === "broken" || !facts.step) return facts;
    const through = session.seedFrom + facts.step.turnIndex - 1;
    if (through < session.seedFrom) return facts;
    try {
      const log = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(session.key));
      const snapshot = await log.checkpointSnapshot(session.seedFrom, through);
      if (snapshot.owner?.runId !== row.runId || snapshot.owner.gen !== row.ownerGen || snapshot.next !== through + 1)
        return facts;
      const loopPins = custodyPinProtectionOf(
        await log.protectCustodyRanges(row.runId, [{ from: session.seedFrom, to: through }]),
      );
      if (!loopPins) return facts;
      const transcript = assembleTranscript(snapshot.rows, snapshot.attachments, session.seedFrom);
      if (!transcript.complete) return facts;
      const transcriptHash = await sourceHash(transcript);
      const answer = [...read.events].reverse().find((e) => e.type === "answer");
      const reportKey = contextThreadSessionKey(row.meta.threadKey),
        rowId = `run:${row.runId}:answer`;
      const reportLog = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(reportKey));
      const reportRows = await reportLog.readEntry(rowId);
      if (!answer || answer.type !== "answer" || !workspaceReportRowsMatch(reportRows, answer.text)) return facts;
      const index = reportRows![0].idx;
      const reportPins = custodyPinProtectionOf(
        await reportLog.protectCustodyRanges(row.runId, [{ from: index, to: index }]),
      );
      if (!reportPins) return facts;
      const rowsHash = await sourceHash(reportRows);
      const current = await log.checkpointSnapshot(session.seedFrom, through);
      if (
        current.owner?.runId !== row.runId ||
        current.owner.gen !== row.ownerGen ||
        current.next !== snapshot.next ||
        JSON.stringify(current.rows) !== JSON.stringify(snapshot.rows) ||
        JSON.stringify(current.attachments) !== JSON.stringify(snapshot.attachments) ||
        JSON.stringify(await reportLog.readEntry(rowId)) !== JSON.stringify(reportRows)
      )
        return facts;
      return {
        ...facts,
        session: {
          key: session.key,
          from: session.seedFrom,
          through,
          transcriptHash,
          pinRevision: loopPins.revision,
        },
        threadReport: {
          key: reportKey,
          threadKey: row.meta.threadKey,
          rowId,
          from: index,
          through: index,
          rowsHash,
          pinRevision: reportPins.revision,
          text: answer.text,
        },
      };
    } catch {
      return facts;
    }
  }

  async workspaceDisposition(expected: WorkspaceAllocation): Promise<WorkspaceDispositionRead> {
    const stable = workspaceAllocationOf(expected);
    if (!stable) return { kind: "held", reason: "mismatch" };
    expected = stable;
    const live = () =>
      this.sql
        .exec(
          `SELECT run_id FROM live_runs WHERE run_id = ? OR json_extract(state_json, '$.binding.sandboxKey') = ? LIMIT 1`,
          expected.runId,
          expected.allocationKey,
        )
        .toArray().length > 0;
    if (live()) return { kind: "held", reason: "live" };
    const raw = this.allocationArchive(expected.runId),
      archive = workspaceDurabilityArchiveOf(raw);
    if (!archive?.allocation || !archive.disposition) return { kind: "held", reason: "unknown" };
    if (!sameWorkspaceAllocation(expected, archive.allocation)) return { kind: "held", reason: "mismatch" };
    if (archive.disposition.kind === "scratch-custody-closed") {
      const effectsPending = () =>
        this.sql
          .exec<{ id: string; body_json: string }>(
            `SELECT id,body_json FROM plane_effects WHERE acked_at IS NULL AND
         CASE WHEN json_valid(body_json) THEN json_extract(body_json,'$.runId') = ? OR id = ? ELSE 1 END`,
            expected.runId,
            `admit:${expected.runId}`,
          )
          .toArray()
          .some((e) => workspaceEffectNeedsCustody(expected.runId, expected.threadKey, e));
      if (effectsPending()) return { kind: "held", reason: "custody-unavailable" };
      const c = archive.disposition.custody;
      const record = await this.get(expected.runId);
      const lease = record?.events.find((e) => e.seq === c.leaseSeq && e.type === "lease"),
        report = record?.events.find((e) => e.seq === c.reportSeq && e.type === "answer");
      if (
        !record ||
        record.provisional ||
        record.restarting ||
        !allocationMatchesRecord(expected, record) ||
        !lease ||
        !report ||
        report.type !== "answer" ||
        (await sourceHash(lease)) !== c.leaseHash ||
        (await sourceHash(report)) !== c.reportHash ||
        c.threadReport.key !== contextThreadSessionKey(expected.threadKey) ||
        c.threadReport.threadKey !== expected.threadKey ||
        c.threadReport.rowId !== `run:${expected.runId}:answer`
      )
        return { kind: "held", reason: "custody-unavailable" };
      try {
        const log = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(c.sessionKey));
        const reportLog = this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(c.threadReport.key));
        const loopRevision = custodyPinRevisionOf(await log.custodyPinRevision()),
          reportRevision = custodyPinRevisionOf(await reportLog.custodyPinRevision());
        if (
          !loopRevision?.guarded ||
          loopRevision.revision < c.pinRevision ||
          !reportRevision?.guarded ||
          reportRevision.revision < c.threadReport.pinRevision ||
          !custodyPinProtectionOf(await log.protectCustodyRanges(expected.runId, [{ from: c.from, to: c.through }])) ||
          !custodyPinProtectionOf(
            await reportLog.protectCustodyRanges(expected.runId, [
              { from: c.threadReport.from, to: c.threadReport.through },
            ]),
          )
        )
          return { kind: "held", reason: "custody-unavailable" };
        const data = await log.checkpointSnapshot(c.from, c.through);
        const transcript = assembleTranscript(data.rows, data.attachments, c.from);
        const reportRows = await reportLog.readEntry(c.threadReport.rowId);
        if (
          !transcript.complete ||
          !workspaceReportRowsMatch(reportRows, report.text) ||
          reportRows![0].idx !== c.threadReport.from ||
          (await sourceHash(reportRows)) !== c.threadReport.rowsHash ||
          (await sourceHash(transcript)) !== c.transcriptHash ||
          JSON.stringify(await reportLog.readEntry(c.threadReport.rowId)) !== JSON.stringify(reportRows) ||
          JSON.stringify((await log.checkpointSnapshot(c.from, c.through)).rows) !== JSON.stringify(data.rows) ||
          effectsPending() ||
          live() ||
          JSON.stringify(this.allocationArchive(expected.runId)) !== JSON.stringify(raw)
        )
          return { kind: "held", reason: "custody-unavailable" };
      } catch {
        return { kind: "held", reason: "custody-unavailable" };
      }
    }
    return { kind: "terminal", allocation: archive.allocation, disposition: archive.disposition };
  }

  async preservationOwner(runId: string, owner?: WorkspaceOwner): Promise<unknown> {
    const live = this.sql
      .exec<Pick<LiveRow, "run_id" | "thread_key" | "owner_gen" | "phase" | "state_json" | "meta_json">>(
        `SELECT run_id, thread_key, owner_gen, phase, state_json, meta_json FROM live_runs WHERE run_id = ?`,
        runId,
      )
      .toArray()[0];
    if (live) {
      let binding: unknown;
      let workspaceThreadKey: string | undefined;
      try {
        workspaceThreadKey = terminalThreadKey({ threadKey: live.thread_key, meta: JSON.parse(live.meta_json) });
        binding = (JSON.parse(live.state_json) as RunState).binding;
      } catch {
        return { kind: "unknown" };
      }
      return {
        kind: "live",
        row: {
          runId: live.run_id,
          threadKey: live.thread_key,
          ownerGen: live.owner_gen,
          phase: live.phase,
          binding,
          workspaceThreadKey,
        },
      };
    }
    if (owner) {
      const settlement = this.workspaceSettlementRow(owner);
      if (settlement) return { kind: "terminal", record: settlement.record, settlement };
      const revision = this.workspaceRevision(owner);
      return settlement === undefined && revision !== undefined
        ? ({
            kind: "acknowledged",
            owner: { runId: owner.runId, ownerGen: owner.ownerGen, ownerFence: owner.ownerFence },
            revision,
          } satisfies AcknowledgedWorkspaceOwner)
        : settlement === undefined
          ? { kind: "absent", owner: { runId: owner.runId, ownerGen: owner.ownerGen, ownerFence: owner.ownerFence } }
          : { kind: "unknown" };
    }
    const row = this.sql
      .exec<{ summary_json: string }>(`SELECT summary_json FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) return { kind: "unknown" };
    const record = parseSummary(row);
    if (!record || record.provisional === true) return { kind: "unknown" };
    return {
      kind: "terminal",
      record: {
        id: record.id,
        threadKey: record.threadKey,
        status: record.status,
        repo: record.repo,
        userId: record.userId,
        parentInstanceId: record.parentInstanceId,
        idempotencyKey: record.idempotencyKey,
        publicationSettlement: record.publicationSettlement,
      },
    };
  }

  private workspaceSettlementRow(owner: WorkspaceOwner, revision?: number): WorkspaceSettlement | null | undefined {
    const row = this.sql
      .exec<{ json: string | null; revision: number }>(
        `SELECT json, revision FROM workspace_settlements WHERE owner_key = ? AND ${revision === undefined ? "json IS NOT NULL" : "revision = ?"} ORDER BY revision ASC LIMIT 1`,
        workspaceOwnerKey(owner),
        ...(revision === undefined ? [] : [revision]),
      )
      .toArray()[0];
    if (!row || row.json === null) return;
    try {
      const value = workspaceSettlementOf(JSON.parse(row.json));
      return value && workspaceOwnerKey(value.owner) === workspaceOwnerKey(owner) && value.revision === row.revision
        ? value
        : null;
    } catch {
      return null;
    }
  }

  private checkWorkspaceFinishCapacity(row: LiveRunRow, record: RunRecord): void {
    const value = terminalWorkspaceSettlement(row, record);
    if (!value) return;
    const count =
      this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM workspace_settlements WHERE owner_key = ? AND json IS NOT NULL`,
          workspaceOwnerKey(value.owner),
        )
        .toArray()[0]?.n ?? 0;
    if (count >= WORKSPACE_SETTLEMENTS_MAX) throw new Error("workspace obligation capacity exhausted");
  }

  private workspaceRevision(owner: WorkspaceOwner): number | undefined {
    return (
      this.sql
        .exec<{ revision: number }>(
          `SELECT MAX(revision) AS revision FROM workspace_settlements WHERE owner_key = ?`,
          workspaceOwnerKey(owner),
        )
        .toArray()[0]?.revision ?? undefined
    );
  }

  async ackWorkspaceSettlement(owner: WorkspaceOwner, revision: number): Promise<WorkspaceAck> {
    let result: WorkspaceAck = { ok: false, reason: "unverified" };
    this.ctx.storage.transactionSync(() => {
      result = workspaceAcknowledgment(
        this.workspaceSettlementRow(owner, revision),
        revision,
        this.liveRow(owner.runId) !== undefined,
        this.workspaceRevision(owner),
      );
      if (result.ok) {
        this.sql.exec(
          `UPDATE workspace_settlements SET json = NULL WHERE owner_key = ? AND revision = ?`,
          workspaceOwnerKey(owner),
          revision,
        );
        this.sql.exec(
          `DELETE FROM workspace_settlements WHERE owner_key = ? AND json IS NULL AND revision < (SELECT MAX(revision) FROM workspace_settlements WHERE owner_key = ?)`,
          workspaceOwnerKey(owner),
          workspaceOwnerKey(owner),
        );
      }
    });
    return result;
  }

  /** The events a live run has appended so far (item 30), in seq order — what
   *  a reclaim closes an unresumable run's record with. The finished-runs
   *  reads never see a live run, so this is the one way at its events. */
  async liveEvents(runId: string): Promise<StoredRunEvent[]> {
    return parseEventRows(this.eventRows(runId, 0, Number.MAX_SAFE_INTEGER));
  }

  // ---- the intake receipts (run-history item 59) -------------------------------

  private intakeRow(key: string): IntakeReceipt | undefined {
    const r = this.sql.exec<{ json: string }>(`SELECT json FROM intake_receipts WHERE key = ?`, key).toArray()[0];
    return r ? (JSON.parse(r.json) as IntakeReceipt) : undefined;
  }

  /** Insert-if-absent inside one transaction: the first writer's row stands
   *  and every caller acts on `stored` (`decideIntakeInsert`). `windowMs` is
   *  the writer's reconnect catch-up window; the retention bound is stamped on
   *  the row so the enabled alarm sweep is one indexed delete. */
  async recordIntake(
    key: string,
    receipt: IntakeReceipt,
    windowMs: number,
    telemetry = false,
  ): Promise<IntakeWriteResult> {
    let out: IntakeWriteResult = { inserted: false, stored: receipt };
    this.ctx.storage.transactionSync(() => {
      out = decideIntakeInsert(this.intakeRow(key), receipt);
      if (!out.inserted) return;
      this.sql.exec(
        `INSERT INTO intake_receipts (key, thread_key, decided_at, prune_after, json) VALUES (?, ?, ?, ?, ?)`,
        key,
        receipt.threadKey,
        receipt.decidedAt,
        receipt.decidedAt + intakeReceiptRetentionMs(windowMs),
        JSON.stringify(receipt),
      );
    });
    if (out.inserted && telemetry) {
      try {
        const point = intakePointOf(out.stored);
        if (point) this.metrics.write(point);
      } catch (err) {
        console.warn(
          `[runs/intake-metrics] point not written: ${err instanceof Error ? err.constructor.name : "Error"}`,
        );
      }
    }
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
    return out;
  }

  async readIntake(key: string): Promise<IntakeReceipt | null> {
    return this.intakeRow(key) ?? null;
  }

  /** The receipt key and poster become one durable, atomic right to publish.
   * A dead claimant can be replaced only after its bounded claim expires. */
  async claimIntakeDelivery(key: string, poster: string, claimedAt: number): Promise<boolean> {
    let claimed = false;
    this.ctx.storage.transactionSync(() => {
      if (this.intakeRow(key)?.providerFailure === undefined) return;
      const existing = this.sql
        .exec<{ claim_until: number; delivered: number }>(
          `SELECT claim_until, delivered FROM intake_deliveries WHERE receipt_key = ?`,
          key,
        )
        .toArray()[0];
      if (existing?.delivered === 1 || (existing !== undefined && existing.claim_until > claimedAt)) return;
      this.sql.exec(
        `INSERT INTO intake_deliveries (receipt_key, poster, claim_until, delivered) VALUES (?, ?, ?, 0)
         ON CONFLICT(receipt_key) DO UPDATE SET poster = excluded.poster, claim_until = excluded.claim_until, delivered = 0`,
        key,
        poster,
        claimedAt + INTAKE_DELIVERY_CLAIM_MS,
      );
      claimed = true;
    });
    return claimed;
  }

  async finishIntakeDelivery(key: string, poster: string, delivered: boolean): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      if (delivered)
        this.sql.exec(
          `UPDATE intake_deliveries SET delivered = 1 WHERE receipt_key = ? AND poster = ? AND delivered = 0`,
          key,
          poster,
        );
      else
        this.sql.exec(
          `DELETE FROM intake_deliveries WHERE receipt_key = ? AND poster = ? AND delivered = 0`,
          key,
          poster,
        );
    });
  }

  /** A thread's receipts, or the receipts since an instant, oldest first. */
  async listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.threadKey !== undefined) {
      clauses.push("thread_key = ?");
      params.push(query.threadKey);
    }
    if (query.since !== undefined) {
      clauses.push("decided_at >= ?");
      params.push(query.since);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM intake_receipts${where} ORDER BY decided_at ASC`, ...params)
      .toArray()
      .map((r) => JSON.parse(r.json) as IntakeReceipt);
  }

  // ---- policy ---------------------------------------------------------------

  /** The persisted policy (defaults until the first proposal lands). */
  policyState(): StoredPolicy {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, POLICY_KEY).toArray()[0];
    if (!row) return { policy: clampRetentionPolicy({}), policyUpdatedAt: 0 };
    try {
      const parsed = JSON.parse(row.value) as Partial<RetentionPolicy> & { policyUpdatedAt?: number };
      const at =
        typeof parsed.policyUpdatedAt === "number" && Number.isFinite(parsed.policyUpdatedAt)
          ? parsed.policyUpdatedAt
          : 0;
      return { policy: clampRetentionPolicy(parsed), policyUpdatedAt: at };
    } catch {
      return { policy: clampRetentionPolicy({}), policyUpdatedAt: 0 };
    }
  }

  /** Accept a proposal only when strictly newer than the stored one; its stamp
   *  is clamped to the DO clock so a skewed proposer cannot lock the policy. */
  private applyProposal(proposal: RunPolicyProposal, now: number): StoredPolicy {
    const current = this.policyState();
    const stamp = Math.min(proposal.policyUpdatedAt, now);
    if (stamp <= current.policyUpdatedAt) return current;
    const next: StoredPolicy = { policy: clampRetentionPolicy(proposal.policy), policyUpdatedAt: stamp };
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      POLICY_KEY,
      JSON.stringify({ ...next.policy, policyUpdatedAt: next.policyUpdatedAt }),
    );
    return next;
  }

  // ---- retention ------------------------------------------------------------

  /** The ids the policy keeps among `rows`, computed by the ONE shared
   *  retention function over each row's (id, finishedAt, bytes). */
  private static keptIds(rows: readonly RetentionRow[], policy: RetentionPolicy, now: number): Set<string> {
    const kept = applyRetention(
      rows.map((r) => ({ id: r.run_id, finishedAt: r.finished_at, bytes: r.bytes })),
      policy,
      now,
    );
    return new Set(kept.map((r) => r.id));
  }

  /** Every row, oldest first (`finished_at ASC, run_id ASC`) — the deletion order. */
  private retentionRows(): RetentionRow[] {
    return this.sql
      .exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs ORDER BY finished_at ASC, run_id ASC`)
      .toArray();
  }

  /**
   * Whether ONE row is kept, without materializing the table — the same answer
   * `applyRetention` gives for it, decided in its order: (1) finished before
   * the `retentionDays` cutoff → out; (2) rows ranked ahead of it (newest
   * first: `finished_at DESC, run_id DESC`, among those inside the cutoff) must
   * number fewer than `maxRuns`; (3) their bytes plus its own must fit
   * `maxBytes` (bytes are non-negative, so the cumulative total is monotone and
   * "the first row over the budget and everything after it" reduces to this one
   * inequality). Ids are ASCII (`RUN_ID_PATTERN`), so SQLite's binary `run_id`
   * order is the JS string order `newestFirst` uses.
   */
  private isKept(row: RetentionRow, policy: RetentionPolicy, now: number): boolean {
    if (this.isKeptByPolicy(row, policy, now) || this.publicationRetains(row.run_id)) return true;
    const holders = this.sql
      .exec<{ holder_run_id: string }>(
        `SELECT DISTINCT holder_run_id FROM context_refs WHERE source_run_id = ? AND (retention_pin = 1 OR ordinary_pin = 1)`,
        row.run_id,
      )
      .toArray();
    return holders.some(({ holder_run_id }) => this.contextHolderIsLiveOrKept(holder_run_id, policy, now));
  }

  private contextHolderIsLiveOrKept(runId: string, policy: RetentionPolicy, now: number): boolean {
    if (runId.startsWith("@session:"))
      return this.sessionContextRootIsRetained(runId.slice("@session:".length), policy, now);
    if (runId.startsWith("@unit:")) return this.unitContextRootIsRetained(runId);
    if (this.liveRow(runId)) return true;
    const holder = this.sql
      .exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    return holder !== undefined && (this.isKeptByPolicy(holder, policy, now) || this.publicationRetains(runId));
  }

  private isKeptByPolicy(row: RetentionRow, policy: RetentionPolicy, now: number): boolean {
    const cutoff = now - policy.retentionDays * 86_400_000;
    if (row.finished_at < cutoff) return false;
    const ahead = this.sql
      .exec<{ n: number; b: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM runs
          WHERE finished_at >= ? AND (finished_at > ? OR (finished_at = ? AND run_id > ?))`,
        cutoff,
        row.finished_at,
        row.finished_at,
        row.run_id,
      )
      .one();
    return ahead.n < policy.maxRuns && ahead.b + row.bytes <= policy.maxBytes;
  }

  private deleteRuns(ids: readonly string[], explicit = false): void {
    for (let i = 0; i < ids.length; i += RUN_DELETE_BATCH) {
      const batch = ids.slice(i, i + RUN_DELETE_BATCH);
      const marks = batch.map(() => "?").join(",");
      if (explicit) this.sql.exec(`DELETE FROM context_refs WHERE source_run_id IN (${marks})`, ...batch);
      else {
        this.sql.exec(`DELETE FROM context_refs WHERE source_run_id IN (${marks}) AND ordinary_member = 0`, ...batch);
        this.sql.exec(
          `UPDATE context_refs SET retention_pin = 0, ordinary_pin = 0 WHERE source_run_id IN (${marks})`,
          ...batch,
        );
      }
      this.sql.exec(`DELETE FROM context_refs WHERE holder_run_id IN (${marks})`, ...batch);
      this.sql.exec(`DELETE FROM run_events WHERE run_id IN (${marks})`, ...batch);
      this.sql.exec(`DELETE FROM runs WHERE run_id IN (${marks})`, ...batch);
    }
  }

  /** Delete rows outside policy, oldest first, at most `fence` of them (all
   *  when `fence` is undefined). `first`, when outside policy, is always
   *  deleted — the record just written must not survive its own put as a
   *  hidden row. One scan of `runs` feeds both the kept set and the deletion
   *  order. Returns how many rows were deleted and the kept ids — which are
   *  exactly the rows retained after the delete: the kept set is the newest
   *  prefix of the age-filtered order, and only rows outside it were removed,
   *  so re-running retention on what remains selects the same rows. */
  private trim(
    policy: RetentionPolicy,
    now: number,
    fence: number | undefined,
    first?: string,
  ): { deleted: number; kept: Set<string> } {
    const rows = this.retentionRows();
    const kept = this.contextKeptIds(rows, policy, now);
    const outside = rows.map((r) => r.run_id).filter((id) => !kept.has(id) && id !== first);
    const firstDoomed = first !== undefined && !kept.has(first);
    const doomed = firstDoomed ? [first, ...outside] : outside;
    const victims = fence === undefined ? doomed : doomed.slice(0, Math.max(fence, firstDoomed ? 1 : 0));
    this.deleteRuns(victims);
    if (victims.length < doomed.length)
      console.log(
        `[runs/trim] deletion fence: ${victims.length} of ${doomed.length} rows outside policy deleted this put`,
      );
    return { deleted: victims.length, kept };
  }

  // ---- writes ---------------------------------------------------------------

  /** Upsert one record and trim, in ONE sync transaction (see MemoryDO.write for
   *  why this is atomic and un-interleavable). Event rows are rewritten only
   *  when the stored version changed (`event_count`, `finished_at`, `bytes`) —
   *  an identical retry is a no-op on `run_events`. `stored: false` when the
   *  record itself fell outside the (possibly just-updated) policy: it was
   *  written and deleted in the same transaction, so nothing of it remains.
   *  `point` is the record's metrics point, computed by the client
   *  (run-metrics.md): written to the sink AFTER the commit, only when the row
   *  turned final and the record was stored — `turnedFinal` stays internal (the
   *  route strips it), so the wire answer is exactly the shape it always was. */
  async put(
    record: RunRecord,
    proposal?: RunPolicyProposal,
    point?: RunMetricsPoint,
  ): Promise<{ ok: true; retained: number; stored: boolean; rewritten: boolean; turnedFinal: boolean }> {
    if (this.promotionHeld(record.id)) throw new PromotionPendingError(record.id);
    record = await this.archiveCheckpoint(record);
    return this.withRangePins([{ id: record.id, handoff: record.childHandoff }], async () => {
      let result = { ok: true as const, retained: 0, stored: false, rewritten: false, turnedFinal: false };
      this.ctx.storage.transactionSync(() => {
        if (this.promotionHeld(record.id)) throw new PromotionPendingError(record.id);
        result = this.upsertInTransaction(record, proposal);
      });
      this.writeMetricsPoint(record.id, point, result.turnedFinal && result.stored);
      // A coordinator child closed OUTSIDE the ledger's finish — the run loop or
      // a reclaim writing an `interrupted` record, the pi harness's typed restart,
      // a resume abandoning a lost workspace — still wakes its parent's wait at
      // once (run-history item 47): the same `run-finished-<runId>` event rides
      // this commit. The tombstone a run writes at its start is excluded (its
      // `finishedAt` equals `startedAt`); the parent confirms by `read-record`
      // before it acts, so a duplicate send is harmless.
      if (result.stored && record.parentInstanceId !== undefined && record.finishedAt > record.startedAt) {
        const transportWorkflowId = record.events.find(
          (event) => event.type === "coordinator_tag",
        )?.transportWorkflowId;
        const event = await sendRunFinished(this.env.SHIP_COORDINATOR, {
          ...record,
          ...(transportWorkflowId !== undefined ? { transportWorkflowId } : {}),
        });
        if (event.kind === "failed")
          console.warn(`[runs/put] ${record.id} → ${event.type} not delivered to ${event.instance}: ${event.reason}`);
      }
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
      return result;
    });
  }

  /** The body of `put`, for a caller already inside `transactionSync` — the
   *  ledger's `finish` writes the finished record and deletes the live rows in
   *  ONE transaction (run-history item 33), so this cannot open its own. */
  private upsertInTransaction(
    record: RunRecord,
    proposal?: RunPolicyProposal,
  ): { ok: true; retained: number; stored: boolean; rewritten: boolean; turnedFinal: boolean } {
    if (workspaceAuthorityFieldsPresent(record))
      throw new Error("workspace allocation authority cannot be written through a run record");
    {
      const now = systemClock();
      const policy = proposal ? this.applyProposal(proposal, now).policy : this.policyState().policy;
      const finishedAt = Math.min(record.finishedAt, now + RUN_MAX_FUTURE_MS);
      // The tracing stamps get the same skew clamp (docs/reference/specs/tracing.md).
      const stored: RunRecord = {
        ...record,
        finishedAt,
        ...(record.receivedAt !== undefined
          ? { receivedAt: Math.min(record.receivedAt, now + RUN_MAX_FUTURE_MS) }
          : {}),
        ...(record.sealedAt !== undefined ? { sealedAt: Math.min(record.sealedAt, now + RUN_MAX_FUTURE_MS) } : {}),
      };
      const priorReceipt =
        this.liveRow(stored.id)?.state.contextCheckpointReceipt ??
        (() => {
          const previous = this.sql
            .exec<{ context_checkpoint_json: string | null }>(
              `SELECT context_checkpoint_json FROM runs WHERE run_id = ?`,
              stored.id,
            )
            .toArray()[0];
          return previous?.context_checkpoint_json ? JSON.parse(previous.context_checkpoint_json) : undefined;
        })();
      if (
        stored.contextCheckpointReceipt !== undefined &&
        JSON.stringify(stored.contextCheckpointReceipt) !== JSON.stringify(priorReceipt)
      )
        throw new Error("checkpoint receipt is not canonical");
      const priorRecord = this.sql
        .exec<{ work_evidence_json: string | null; summary_json: string }>(
          `SELECT work_evidence_json, summary_json FROM runs WHERE run_id = ?`,
          stored.id,
        )
        .toArray()[0];
      const priorEvidence =
        priorRecord?.work_evidence_json != null
          ? parseWorkEvidence(JSON.parse(priorRecord.work_evidence_json), stored)
          : undefined;
      if (priorRecord?.work_evidence_json != null && priorEvidence === undefined)
        throw new Error("work evidence is unreadable");
      const liveWork = this.liveRow(stored.id)?.state;
      const canonicalWork = this.preserveArchivedBaseline(
        stored.id,
        liveWork ?? {
          ...priorEvidence,
          ...(priorRecord &&
          (JSON.parse(priorRecord.summary_json) as Record<string, unknown>).branchPublication !== undefined
            ? { branchPublication: (JSON.parse(priorRecord.summary_json) as Record<string, unknown>).branchPublication }
            : {}),
          ...(priorRecord &&
          (JSON.parse(priorRecord.summary_json) as Record<string, unknown>).reviewPublication !== undefined
            ? { reviewPublication: (JSON.parse(priorRecord.summary_json) as Record<string, unknown>).reviewPublication }
            : {}),
          ...(priorRecord &&
          (JSON.parse(priorRecord.summary_json) as Record<string, unknown>).branchPushReceipts !== undefined
            ? {
                branchPushReceipts: (JSON.parse(priorRecord.summary_json) as Record<string, unknown>)
                  .branchPushReceipts,
              }
            : {}),
        },
        stored,
      );
      if (!canonicalWork) throw new Error("original branch identity baseline is immutable");
      // Terminal outcome and cost do not depend on a process-local publication
      // acknowledgment. Only saved producer state can authorize branch release.
      const canonicalDoor = liveWork
        ? liveWork.doorPublicationPending
        : priorRecord
          ? priorEvidence && Object.hasOwn(priorEvidence, "doorPublicationPending")
            ? priorEvidence.doorPublicationPending
            : JSON.parse(priorRecord.summary_json).doorPublicationPending
          : stored.doorPublicationPending;
      delete stored.doorPublicationPending;
      const doorPublicationPending = doorPublicationOf(canonicalDoor);
      if (doorPublicationPending !== undefined) stored.doorPublicationPending = doorPublicationPending;
      delete stored.branchPublication;
      const branchPublication = branchPublicationOf(canonicalWork.branchPublication, stored.repo);
      if (branchPublication !== undefined) stored.branchPublication = branchPublication;
      delete stored.branchPushReceipts;
      const branchPushReceipts = branchPushReceiptsOf(canonicalWork.branchPushReceipts);
      if (branchPushReceipts !== undefined) stored.branchPushReceipts = branchPushReceipts;
      const unreadablePush =
        branchPushReceipts === undefined && canonicalWork.branchPushReceipts !== undefined
          ? { branchPushReceipts: canonicalWork.branchPushReceipts }
          : {};
      delete stored.reviewPublication;
      const decodedReview = reviewPublicationOf(canonicalWork.reviewPublication);
      const reviewPublication =
        decodedReview?.runId === stored.id && decodedReview.target.repo === stored.repo ? decodedReview : undefined;
      if (reviewPublication !== undefined) stored.reviewPublication = reviewPublication;
      const unreadableReview =
        reviewPublication === undefined && canonicalWork.reviewPublication !== undefined
          ? { reviewPublication: canonicalWork.reviewPublication }
          : {};
      if (
        stored.branchIdentityBaseline !== undefined &&
        JSON.stringify(stored.branchIdentityBaseline) !== JSON.stringify(canonicalWork.branchIdentityBaseline)
      )
        throw new Error("branch identity baseline is not canonical");
      if (
        stored.unitSeedReceipt !== undefined &&
        JSON.stringify(stored.unitSeedReceipt) !== JSON.stringify(canonicalWork.unitSeedReceipt)
      )
        throw new Error("unit seed receipt is not canonical");
      for (const field of ["workReads", "unitSeedReceipt", "branchIdentityBaseline"] as const) {
        if (stored[field] === undefined && canonicalWork[field] !== undefined)
          Object.assign(stored, { [field]: structuredClone(canonicalWork[field]) });
      }
      if (
        !preserveCheckpointState(canonicalWork, {
          workReads: stored.workReads,
          unitSeedReceipt: stored.unitSeedReceipt,
          branchIdentityBaseline: stored.branchIdentityBaseline,
        })
      )
        throw new Error("work evidence is not canonical");
      if (!workEvidenceBelongsToRun(stored, stored)) throw new Error("work evidence does not match its canonical run");
      this.pinContext(stored.id, stored.childHandoff, stored.contextDependencies);
      const {
        events,
        sourceReads,
        workReads,
        unitSeedReceipt,
        branchIdentityBaseline,
        contextCheckpointReceipt,
        directAudience,
        ...summary
      } = stored;
      const unreadableDoor =
        doorPublicationPending === undefined && canonicalDoor !== undefined && canonicalDoor !== null
          ? { doorPublicationPending: canonicalDoor }
          : {};
      const bytes = utf8ByteLength(
        JSON.stringify({
          ...unreadableDoor,
          ...unreadableReview,
          ...unreadablePush,
          ...stored,
          ...(branchPublication === undefined && canonicalWork.branchPublication !== undefined
            ? { branchPublication: canonicalWork.branchPublication }
            : {}),
        }),
      );
      const existing = this.sql
        .exec<{ event_count: number; finished_at: number; bytes: number; summary_json: string }>(
          `SELECT event_count, finished_at, bytes, summary_json FROM runs WHERE run_id = ?`,
          record.id,
        )
        .toArray()[0];
      // The one field of the stored summary the emission rule reads (run-metrics.md
      // item 2): the row's `provisional`, parsed alone — never deserialized whole.
      const existingProvisional = existing !== undefined && summaryIsProvisional(existing.summary_json);
      const turnedFinal = pointTurnsFinal(
        existing !== undefined ? { provisional: existingProvisional } : undefined,
        stored,
      );
      // A provisional record never overwrites a final row (run-history.md item 27;
      // run-metrics.md item 3): a start tombstone sitting in retry backoff or a
      // drain upgrade racing a fast finish would otherwise land after the finish
      // record, overwrite it with `interrupted` — and let the run's point be
      // written twice when a later final write turned the row "final" again.
      // Answered as stored, with nothing written: the row, its events and the
      // sessions table stay exactly as the final write left them.
      if (stored.provisional === true && existing !== undefined && !existingProvisional) {
        const retained = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`).one().n;
        return { ok: true as const, retained, stored: true, rewritten: false, turnedFinal: false };
      }
      const unchanged =
        existing !== undefined &&
        sameStoredVersion(
          { eventCount: existing.event_count, finishedAt: existing.finished_at, bytes: existing.bytes },
          { eventCount: stored.eventCount, finishedAt, bytes },
        );
      this.sql.exec(
        `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status,
                           event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json, session_key, usage_json, parent_run_id, pr_number, source_reads_json, context_checkpoint_json, direct_audience_json, work_evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           label = excluded.label, agent = excluded.agent, model = excluded.model, channel_id = excluded.channel_id,
           user_id = excluded.user_id, thread_key = excluded.thread_key, channel_visibility = excluded.channel_visibility,
           repo = excluded.repo, started_at = excluded.started_at,
           finished_at = excluded.finished_at, stored_at = excluded.stored_at, status = excluded.status,
           event_count = excluded.event_count, stored_event_count = excluded.stored_event_count, truncated = excluded.truncated,
           bytes = excluded.bytes, diagnosis_json = excluded.diagnosis_json, summary_json = excluded.summary_json,
           session_key = excluded.session_key,
           usage_json = COALESCE(excluded.usage_json, runs.usage_json),
           parent_run_id = excluded.parent_run_id,
           pr_number = excluded.pr_number, source_reads_json = excluded.source_reads_json, context_checkpoint_json = excluded.context_checkpoint_json, direct_audience_json = excluded.direct_audience_json, work_evidence_json = excluded.work_evidence_json`,
        stored.id,
        stored.label ?? null,
        stored.agent ?? null,
        stored.model ?? null,
        stored.channelId,
        stored.userId,
        stored.threadKey,
        stored.channelVisibility ?? "unknown",
        stored.repo ?? null,
        stored.startedAt,
        finishedAt,
        now,
        stored.status,
        stored.eventCount,
        stored.storedEventCount,
        stored.truncated ? 1 : 0,
        bytes,
        JSON.stringify(stored.diagnosis),
        JSON.stringify(summary),
        stored.session?.key ?? null,
        stored.usage ? JSON.stringify(stored.usage) : null,
        stored.parentRunId ?? null,
        pullRequestNumberOf(stored) ?? null,
        sourceReads === undefined ? null : JSON.stringify(sourceReads),
        contextCheckpointReceipt === undefined ? null : JSON.stringify(contextCheckpointReceipt),
        directAudience === undefined ? null : JSON.stringify(directAudience),
        workReads === undefined &&
          unitSeedReceipt === undefined &&
          branchIdentityBaseline === undefined &&
          !(branchPublication === undefined && canonicalWork.branchPublication !== undefined) &&
          Object.keys(unreadablePush).length === 0 &&
          Object.keys(unreadableReview).length === 0 &&
          Object.keys(unreadableDoor).length === 0
          ? null
          : JSON.stringify({
              version: 1,
              ...unreadableDoor,
              ...unreadableReview,
              ...unreadablePush,
              workReads,
              unitSeedReceipt,
              branchIdentityBaseline,
              ...(branchPublication === undefined && canonicalWork.branchPublication !== undefined
                ? { branchPublication: canonicalWork.branchPublication }
                : {}),
            }),
      );
      // The session's registry row learns its newest finish (session-log item
      // 7); a record that reaches the store without a claim (the plain put
      // of a detached run) still registers the session it names.
      if (stored.session) {
        this.sql.exec(
          `INSERT INTO sessions (key, thread_key, agent, last_finished_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET last_finished_at = MAX(sessions.last_finished_at, excluded.last_finished_at)`,
          stored.session.key,
          stored.threadKey,
          stored.agent ?? null,
          finishedAt,
        );
      }
      if (!unchanged) {
        this.sql.exec(`DELETE FROM run_events WHERE run_id = ?`, record.id);
        const seqs = storedEventSeqs(events); // the registry's stamps (see runRecord.ts)
        for (let i = 0; i < events.length; i += RUN_EVENT_INSERT_BATCH) {
          const batch = events.slice(i, i + RUN_EVENT_INSERT_BATCH);
          const params: (string | number)[] = [];
          batch.forEach((e, j) => params.push(record.id, seqs[i + j], JSON.stringify(e)));
          this.sql.exec(
            `INSERT INTO run_events (run_id, seq, json) VALUES ${batch.map(() => "(?, ?, ?)").join(",")}`,
            ...params,
          );
        }
      }
      // The just-written row is either kept or was deleted by the trim (it is
      // always `first`), so kept membership IS whether it is still stored.
      const { kept } = this.trim(policy, now, RUN_TRIM_FENCE, record.id);
      return {
        ok: true as const,
        retained: kept.size,
        stored: kept.has(record.id),
        rewritten: existing !== undefined && !unchanged,
        turnedFinal,
      };
    }
  }

  /** One point per run whose row turned final, AFTER the commit (run-metrics.md
   *  item 2) — advisory: a throwing sink leaves the answer exactly as a
   *  recording one would, and says so in one warn line with the run id and the
   *  error's constructor name, never the point's contents. */
  private writeMetricsPoint(runId: string, point: RunMetricsPoint | undefined, turnedFinal: boolean): void {
    if (point === undefined || !turnedFinal) return;
    try {
      this.metrics.write(point);
    } catch (err) {
      const kind = err instanceof Error ? err.constructor.name : "Error";
      console.warn(`[runs/metrics] ${runId} point not written: ${kind}`);
    }
  }

  /** Remove a run and its events. Returns whether a run row existed. */
  async delete(id: string): Promise<boolean | { ok: false; reason: "publication_pending" }> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      let deleted = false;
      let refused = false;
      this.ctx.storage.transactionSync(() => {
        // A live owner may also have a provisional terminal record. Neither
        // that record nor its events and context pins can be erased here.
        if (this.liveRow(id)) return;
        deleted = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE run_id = ?`, id).one().n === 1;
        // Retention may have removed the record while its checkpoint alias
        // survives. Explicit deletion still revokes the alias.
        if (this.publicationRetains(id)) {
          refused = true;
          return;
        }
        this.deleteRuns([id], true);
      });
      if (refused) return { ok: false as const, reason: "publication_pending" as const };
      return deleted;
    });
    if (typeof result === "boolean") await this.syncRangePins();
    return result;
  }

  /** The shared alarm always serves live plane work. Scheduled physical
   *  cleanup runs only when explicitly enabled. */
  async alarm(): Promise<void> {
    // The timer is a root of its own (docs/reference/specs/tracing.md item 25):
    // `state.alarm`, ending with how many rows it swept (zero when paused).
    const root = startAdoptedRoot(tracer, "state.alarm", { sinks: traceSinks });
    try {
      const now = systemClock();
      await this.discoverCoordinatorWorkflows(now);
      let deleted = 0;
      if (this.env.RUN_HISTORY_MAINTENANCE === "enabled") {
        const { policy } = this.policyState();
        let receipts = 0;
        let candidates: { key: string; threadKey: string }[] = [];
        this.ctx.storage.transactionSync(() => {
          deleted = this.trim(policy, now, undefined).deleted;
          // Orphan sweep: events whose run is gone. The table holds both live
          // ledger events and finished history, so both owners must be absent.
          this.sql.exec(`DELETE FROM run_events
          WHERE NOT EXISTS (SELECT 1 FROM runs WHERE runs.run_id = run_events.run_id)
            AND NOT EXISTS (SELECT 1 FROM live_runs WHERE live_runs.run_id = run_events.run_id)`);
          this.sql.exec(
            `DELETE FROM context_refs WHERE holder_run_id NOT IN (SELECT run_id FROM runs UNION SELECT run_id FROM live_runs UNION SELECT '@session:' || key FROM sessions UNION SELECT '@unit:' || instance_id || ':' || unit FROM coordinator_units)`,
          );
          // Intake receipts past their bound (item 59): each row carries its own
          // `prune_after`, stamped at the insert from the writer's window.
          receipts = this.sql
            .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM intake_receipts WHERE prune_after <= ?`, now)
            .one().n;
          this.sql.exec(
            `DELETE FROM intake_deliveries WHERE receipt_key IN (SELECT key FROM intake_receipts WHERE prune_after <= ?)`,
            now,
          );
          this.sql.exec(`DELETE FROM intake_receipts WHERE prune_after <= ?`, now);
          // The sessions no kept run names any more (session-log item 7): decided
          // here, on the rows this transaction leaves; dropped after it.
          candidates = this.sql
            .exec<{ key: string; thread_key: string }>(
              `SELECT key, thread_key FROM sessions
              WHERE key NOT IN (SELECT session_key FROM runs WHERE session_key IS NOT NULL)`,
            )
            .toArray()
            .map((r) => ({ key: r.key, threadKey: r.thread_key }));
        });
        await this.syncRangePins();
        const dropped = await this.sweepSessions(candidates);
        console.log(
          `[runs/alarm] swept ${deleted} rows outside policy, pruned ${receipts} intake receipt(s), dropped ${dropped} session log(s)`,
        );
      }
      // The plane's re-ask (record 0064): while a queued row waits on a resident
      // that has said nothing within the cadence, one probe effect per
      // resident — and the next alarm is pulled forward to the cadence, so a
      // silent resident is probed, never waited on forever. When maintenance
      // is enabled, its sweep rides this same alarm.
      if (this.planeWaitsOnResident()) {
        const probes = this.planeApply({ kind: "reask", at: now, cadenceMs: this.planeReaskMs() }).effects;
        if (probes.length > 0) console.log(`[plane/reask] ${probes.map((e) => e.id).join(", ")}`);
      }
      // A lease end offers the row to a generation other than its owner and
      // never ends a run (record 0064): the row stays exactly as it is —
      // any reclaim can take it now — and the open effects are re-pushed so a
      // listening bot sweeps sooner. The owner's next heartbeat refreshes an
      // unreclaimed row and moves the alarm on.
      const lapsed = this.sql
        .exec<{ run_id: string; owner_gen: string }>(
          `SELECT run_id, owner_gen FROM live_runs WHERE lease_until <= ?`,
          now,
        )
        .toArray();
      if (lapsed.length > 0) {
        console.log(
          `[plane/alarm] ${lapsed.length} lease(s) lapsed (${lapsed.map((l) => l.run_id).join(", ")}) — offered to any generation but the owner; nothing closed`,
        );
        this.pushPlaneEffects(this.openPlaneEffects());
      }
      root.end("ok", { swept: deleted });
    } catch (err) {
      root.fail(err);
      root.end("error");
      throw err;
    } finally {
      // Platform alarm retries are bounded. Persist the next due and arm it
      // even when discovery or physical maintenance failed in this pass.
      const now = systemClock();
      const set = await this.ctx.storage.getAlarm();
      if (set === null || set > now + RUN_SWEEP_INTERVAL_MS)
        await this.ctx.storage.setAlarm(now + RUN_SWEEP_INTERVAL_MS);
      await this.armCoordinatorReconciliation(now);
      await this.ensurePlaneAlarm(now);
    }
  }

  /** Drop the session logs among `candidates` that still have no kept run and
   *  no live run on their thread (session-log item 7), each object's owner row
   *  first so a late write is refused, then its rows; the registry row goes
   *  once the object is empty. Outside the sweep's transaction — a Durable
   *  Object call cannot run inside one — so each drop awaits, and a claim or a
   *  finish can land between two of them: the decision is therefore taken per
   *  key on what the object reads right before that key's drop, never on the
   *  list the transaction produced. A candidate a live run or a fresh record
   *  has overtaken is skipped and keeps its registry row. Returns how many dropped. */
  private sessionIsRetained(key: string, _threadKey: string): boolean {
    if (this.sql.exec(`SELECT 1 FROM runs WHERE session_key = ? LIMIT 1`, key).toArray().length > 0) return true;
    const now = systemClock();
    const { policy } = this.policyState();
    if (this.sessionContextRootIsRetained(key, policy, now)) return true;
    return this.sql
      .exec<{ holder_run_id: string }>(
        `SELECT DISTINCT holder_run_id FROM context_refs WHERE session_key = ? AND (retention_pin = 1 OR ordinary_pin = 1)
       AND source_run_id IN (SELECT run_id FROM runs UNION SELECT run_id FROM live_runs)`,
        key,
      )
      .toArray()
      .some(({ holder_run_id }) => this.contextHolderIsLiveOrKept(holder_run_id, policy, now));
  }

  async sweepSessions(candidates: readonly { key: string; threadKey: string }[]): Promise<number> {
    let dropped = 0;
    for (const { key, threadKey } of candidates) {
      const [{ decision }] = sessionsToDrop([
        {
          key,
          hasKeptRun: this.sessionIsRetained(key, threadKey),
          threadLive:
            this.sql
              .exec(
                `SELECT 1 FROM live_runs WHERE thread_key = ? OR json_extract(meta_json, '$.threadKey') = ? LIMIT 1`,
                threadKey,
                threadKey,
              )
              .toArray().length > 0,
        },
      ]);
      if (decision !== "drop") continue;
      try {
        await this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).drop();
        this.sql.exec(`DELETE FROM context_refs WHERE holder_run_id = ?`, `@session:${key}`);
        this.sql.exec(`DELETE FROM sessions WHERE key = ?`, key);
        dropped++;
      } catch (err) {
        console.warn(
          `[runs/alarm] session log ${key} not dropped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return dropped;
  }

  /** The registry row's `bytes` is the object's own count, read after a finish
   *  (the one moment a session's size changes and the store is told). Best
   *  effort: a registry row without a fresh count is a stale number, never a
   *  wrong decision — the sweep decides on run rows and live rows alone. */
  private async refreshSessionBytes(key: string | undefined): Promise<void> {
    if (key === undefined) return;
    try {
      const bytes = await this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).bytes();
      this.sql.exec(`UPDATE sessions SET bytes = ? WHERE key = ?`, bytes, key);
    } catch (err) {
      console.warn(`[runs/finish] session ${key} bytes not read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- reads ----------------------------------------------------------------

  /** The record with its events in seq order, each carrying the `seq` it is
   *  stored under (the registry's stamp — see `eventSeqs`), or null when
   *  unknown or outside policy — one not-found shape. A corrupt event row is skipped. */
  async get(id: string): Promise<RunRecord | null> {
    return this.canonicalRun(id);
  }

  private canonicalRun(id: string, privatePublication = false): RunRecord | null {
    const now = systemClock();
    const row = this.sql
      .exec<RunRow>(
        `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json, source_reads_json, context_checkpoint_json, direct_audience_json, work_evidence_json FROM runs WHERE run_id = ?`,
        id,
      )
      .toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, now)) return null;
    const summary = parseSummary(row);
    if (!summary) return null;
    if (privatePublication) {
      const size = this.sql
        .exec<{ count: number; bytes: number }>(
          `SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(json AS BLOB))),0) AS bytes FROM run_events WHERE run_id=?`,
          id,
        )
        .one();
      if (
        size.count < 1 ||
        size.count > RUN_EVENTS_MAX_PAGE ||
        size.count !== row.event_count ||
        size.bytes > MAX_RECORD_BYTES
      )
        return null;
    }
    const events: RunEvent[] = parseEventRows(this.eventRows(id, 0, Number.MAX_SAFE_INTEGER));
    let sourceReads: unknown;
    let branchPublication: unknown;
    let reviewPublication: unknown;
    let branchPushReceipts: unknown;
    let workReads: unknown;
    let unitSeedReceipt: unknown;
    let branchIdentityBaseline: unknown;
    let contextCheckpointReceipt: unknown;
    let directAudience: unknown;
    try {
      branchPublication = (JSON.parse(row.summary_json) as Record<string, unknown>).branchPublication;
      if (branchPublication !== undefined && !branchPublicationOf(branchPublication, summary.repo)) return null;
      reviewPublication = (JSON.parse(row.summary_json) as Record<string, unknown>).reviewPublication;
      if (reviewPublication !== undefined) {
        const receipt = reviewPublicationOf(reviewPublication);
        if (!receipt || receipt.runId !== id || receipt.target.repo !== summary.repo) return null;
      }
      branchPushReceipts = (JSON.parse(row.summary_json) as Record<string, unknown>).branchPushReceipts;
      if (branchPushReceipts !== undefined && !branchPushReceiptsOf(branchPushReceipts)) return null;
      sourceReads = row.source_reads_json == null ? undefined : JSON.parse(row.source_reads_json);
      if (row.work_evidence_json != null) {
        const evidence = parseWorkEvidence(JSON.parse(row.work_evidence_json), summary);
        if (evidence === undefined) return null;
        if (privatePublication && Object.hasOwn(evidence, "branchPublication"))
          branchPublication = evidence.branchPublication;
        if (privatePublication && Object.hasOwn(evidence, "branchPushReceipts"))
          branchPushReceipts = evidence.branchPushReceipts;
        workReads = (evidence as { workReads?: unknown }).workReads;
        unitSeedReceipt = (evidence as { unitSeedReceipt?: unknown }).unitSeedReceipt;
        branchIdentityBaseline = evidence.branchIdentityBaseline;
      }

      contextCheckpointReceipt =
        row.context_checkpoint_json == null ? undefined : JSON.parse(row.context_checkpoint_json);
      directAudience = row.direct_audience_json == null ? undefined : JSON.parse(row.direct_audience_json);
    } catch {
      return null;
    }
    const record = {
      ...summary,
      events,
      ...(branchPublication === undefined ? {} : { branchPublication }),
      ...(reviewPublication === undefined ? {} : { reviewPublication }),
      ...(branchPushReceipts === undefined ? {} : { branchPushReceipts }),
      ...(sourceReads === undefined ? {} : { sourceReads }),
      ...(workReads === undefined ? {} : { workReads }),
      ...(unitSeedReceipt === undefined ? {} : { unitSeedReceipt }),
      ...(branchIdentityBaseline === undefined ? {} : { branchIdentityBaseline }),
      ...(contextCheckpointReceipt === undefined ? {} : { contextCheckpointReceipt }),
      ...(directAudience === undefined ? {} : { directAudience }),
    };
    return isRunRecord(record) && record.id === id ? record : null;
  }

  private eventRows(id: string, afterSeq: number, limit: number): EventRow[] {
    return this.sql
      .exec<EventRow>(
        `SELECT seq, json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        id,
        afterSeq,
        limit,
      )
      .toArray();
  }

  /** A page of events with seq > afterSeq. `nextAfterSeq` is set when more
   *  rows follow (the cursor is the last seq READ, so a skipped corrupt row
   *  never stalls paging). Unknown or expired run → null (the same not-found
   *  as `get`); a run with nothing past `afterSeq` → an empty page. One query
   *  reads `limit + 1` rows: the page is the first `limit`, the extra row only
   *  says that more follow. */
  async events(
    id: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ events: StoredRunEvent[]; nextAfterSeq?: number } | null> {
    const row = this.sql
      .exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs WHERE run_id = ?`, id)
      .toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, systemClock())) return null;
    const rows = this.eventRows(id, afterSeq, limit + 1);
    const page = rows.slice(0, limit);
    const out: { events: StoredRunEvent[]; nextAfterSeq?: number } = { events: parseEventRows(page) };
    if (rows.length > limit) out.nextAfterSeq = page[page.length - 1].seq;
    return out;
  }

  /** The record minus its events (the listing row, `bytes` included), or null
   *  when unknown or outside policy — the same not-found as `get`. No event row
   *  is touched: the read for callers that need identity, status, or the
   *  diagnosis but not the event set. */
  async summary(id: string): Promise<RunListItem | null> {
    const row = this.sql
      .exec<RunRow>(
        `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE run_id = ?`,
        id,
      )
      .toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, systemClock())) return null;
    const summary = parseSummary(row);
    return summary ? { ...summary, bytes: row.bytes } : null;
  }

  /**
   * What the runs that finished in [sinceMs, untilMs) and are inside the
   * retention window cost (costs.md items 10–10a; run-history item 56): one row
   * per run — its requester, thread, channel, agent and usage — plus the
   * identity of every parent a child names that is outside the batch, so the
   * bot bills the child without a second read. The arithmetic is the bot's; the
   * Worker only reads its rows. A row written before `usage_json` existed is
   * filled in here from its stored `model.turn` events — up to
   * USAGE_BACKFILL_PER_CALL a call, the rest answered without `usage` and
   * counted in `pending` — so the history heals as it is read, with no
   * operator step; a run without turns is written back as the zero usage so it
   * is not re-read.
   */
  usage(sinceMs: number, untilMs: number): RunUsageRows {
    const now = systemClock();
    const { policy } = this.policyState();
    const cutoff = now - policy.retentionDays * 86_400_000;
    const rows = this.sql
      .exec<UsageRow>(
        `SELECT run_id, user_id, agent, channel_id, thread_key, started_at, finished_at, usage_json, summary_json FROM runs
          WHERE finished_at >= ? AND finished_at < ? ORDER BY finished_at ASC, run_id ASC`,
        Math.max(sinceMs, cutoff),
        untilMs,
      )
      .toArray();
    let backfilled = 0;
    let pending = 0;
    const runs: UsageRun[] = rows.map((row) => {
      let usage = parseUsageJson(row.usage_json);
      if (usage === undefined && backfilled < USAGE_BACKFILL_PER_CALL) {
        usage = usageOfEvents(this.modelTurnEvents(row.run_id));
        this.sql.exec(`UPDATE runs SET usage_json = ? WHERE run_id = ?`, JSON.stringify(usage), row.run_id);
        backfilled += 1;
      }
      if (usage === undefined) pending += 1;
      const who = identityOfSummary(row.summary_json);
      return {
        id: row.run_id,
        userId: row.user_id,
        ...(who.userName ? { userName: who.userName } : {}),
        ...(who.parentRunId ? { parentRunId: who.parentRunId } : {}),
        ...(who.parentInstanceId ? { parentInstanceId: who.parentInstanceId } : {}),
        ...(who.idempotencyKey ? { idempotencyKey: who.idempotencyKey } : {}),
        ...(who.costCapUsd !== undefined ? { costCapUsd: who.costCapUsd } : {}),
        threadKey: row.thread_key,
        channelId: row.channel_id,
        ...(row.agent ? { agent: row.agent } : {}),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        ...(usage ? { usage } : {}),
      };
    });
    // The parents a child names that are not in the batch: looked up once each, known or not.
    const inBatch = new Set(runs.map((r) => r.id));
    const parents: Record<string, UsageIdentity> = {};
    for (const id of new Set(runs.map((r) => r.parentRunId).filter((p): p is string => !!p && !inBatch.has(p)))) {
      const p = this.sql
        .exec<{ user_id: string; summary_json: string }>(`SELECT user_id, summary_json FROM runs WHERE run_id = ?`, id)
        .toArray()[0];
      if (!p) continue;
      const who = identityOfSummary(p.summary_json);
      parents[id] = { userId: p.user_id, ...(who.userName ? { userName: who.userName } : {}) };
    }
    const earliest = this.sql
      .exec<{ m: number | null }>(`SELECT MIN(finished_at) AS m FROM runs WHERE finished_at >= ?`, cutoff)
      .one().m;
    return {
      runs,
      parents,
      pending,
      ...(earliest !== null ? { earliestFinishedAt: earliest } : {}),
      retentionDays: policy.retentionDays,
    };
  }

  /** The stored `model.turn` span ends of one run — the rows a backfill prices. */
  private modelTurnEvents(runId: string): RunEvent[] {
    const out: RunEvent[] = [];
    for (const r of this.sql
      .exec<{ json: string }>(`SELECT json FROM run_events WHERE run_id = ? AND json LIKE '%"model.turn"%'`, runId)
      .toArray()) {
      try {
        const e = JSON.parse(r.json) as RunEvent;
        if (e && e.type === "span_end") out.push(e);
      } catch {
        // an unparsable event row prices nothing
      }
    }
    return out;
  }

  /**
   * Newest first (finished_at desc, run_id desc) among the rows the policy
   * keeps, filtered, capped at RUN_LIST_MAX_LIMIT. The `before`/`beforeId`
   * cursor is the previous page's last row: rows strictly after it in the list
   * order (`finished_at < before`, or equal with `run_id < beforeId`), so
   * same-millisecond siblings are never skipped; `before` alone falls back to
   * `finished_at < before`. `nextBefore` is the last row's key when this page
   * was full.
   *
   * An aggregate over the in-policy rows (`COUNT(*)`, `SUM(bytes)` where
   * `finished_at >= cutoff`) chooses the ordinary path: when both bounds hold,
   * every in-cutoff row is kept, so an indexed, filtered page needs no
   * retention scan. Context references may protect older rows; a full page
   * of in-cutoff rows still needs only that indexed query. A short page,
   * exceeded bound, or recovery-evidence request computes the kept set with
   * `applyRetention` before querying the page.
   *
   * Recovery evidence additionally streams every retained summary through the
   * record parser before trusting identity filters: valid JSON can still be
   * unreadable evidence whose missing identity would hide a competing child.
   * This does not load the retained summaries into memory together or change
   * the relevant-row cap; ordinary list queries keep the fast path above.
   *
   * `visibleTo` — the caller's authorization predicate (authorization.md item
   * 6) — is compiled into the same WHERE clause (`visibilitySql`): its leaves
   * become `channel_id IN (…)`, `channel_visibility IN (…)`, `user_id = ?`,
   * `repo IN (…)`, each backed by an index, so the actor's view is one more
   * indexed filter on the page query, never a post-filter. `none` answers an
   * empty page without a query.
   */
  async list(
    q: RunListOptions,
  ): Promise<{ items: RunListItem[]; nextBefore?: { finishedAt: number; id: string }; evidenceComplete?: boolean }> {
    const now = systemClock();
    const limit = clampListLimit(q.limit);
    if (q.visibleTo?.kind === "none") return { items: [] };
    const { policy } = this.policyState();
    const cutoff = now - policy.retentionDays * 86_400_000;
    const inPolicy = this.sql
      .exec<{ n: number; b: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM runs WHERE finished_at >= ?`,
        cutoff,
      )
      .one();
    const boundExceeded = inPolicy.n > policy.maxRuns || inPolicy.b > policy.maxBytes;
    // A full page inside the age and size bounds does not need any protected
    // older source to fill it. Only active pins can protect sources; ordinary
    // manifest rows with neither pin are not edges. Check existence without
    // materializing the graph (or scanning runs) on ordinary pages.
    const hasContext =
      boundExceeded ||
      this.sql.exec(`SELECT 1 FROM context_refs WHERE retention_pin = 1 OR ordinary_pin = 1 LIMIT 1`).toArray().length >
        0 ||
      this.sql.exec(`SELECT 1 FROM runs WHERE finished_at < ? LIMIT 1`, cutoff).toArray().length > 0;
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const addFilters = (where: string[], params: (string | number)[]): void => {
      if (q.sinceMs !== undefined) {
        where.push(`finished_at >= ?`);
        params.push(q.sinceMs);
      }
      if (q.agent !== undefined) {
        where.push(`agent = ?`);
        params.push(q.agent);
      }
      if (q.channel !== undefined) {
        where.push(`channel_id = ?`);
        params.push(q.channel);
      }
      if (q.threadKey !== undefined) {
        where.push(`thread_key = ?`);
        params.push(q.threadKey);
      }
      if (q.parentRunId !== undefined) {
        where.push(`parent_run_id = ?`);
        params.push(q.parentRunId);
      }
      if (q.pr !== undefined) {
        where.push(`repo = ?`, `pr_number = ?`);
        params.push(q.pr.repo, q.pr.number);
      }
      if (q.visibleTo !== undefined && q.visibleTo.kind !== "all") where.push(visibilitySql(q.visibleTo, params));
    };
    if (hasContext && !boundExceeded && q.recoveryEvidence === undefined) {
      const recentWhere = [`(finished_at < ? OR (finished_at = ? AND run_id < ?))`, `finished_at >= ?`];
      const recentParams: (string | number)[] = [before, before, q.beforeId ?? "", cutoff];
      addFilters(recentWhere, recentParams);
      const recentRows = this.sql
        .exec<RunRow>(
          `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE ${recentWhere.join(" AND ")} ORDER BY finished_at DESC, run_id DESC LIMIT ?`,
          ...recentParams,
          limit,
        )
        .toArray();
      if (recentRows.length === limit) {
        const items = recentRows.map((row) => {
          const summary = parseSummary(row);
          return summary ? { ...summary, bytes: row.bytes } : null;
        });
        if (items.every((item) => item !== null)) {
          const last = items[items.length - 1];
          return { items, nextBefore: { finishedAt: last.finishedAt, id: last.id } };
        }
      }
    }
    const kept = hasContext
      ? this.contextKeptIds(this.retentionRows(), policy, now)
      : boundExceeded
        ? RunHistoryDO.keptIds(this.retentionRows(), policy, now)
        : null;
    const where = [
      `(finished_at < ? OR (finished_at = ? AND run_id < ?))`,
      hasContext ? `run_id IN (SELECT value FROM json_each(?))` : `finished_at >= ?`,
    ];
    // no beforeId → no row satisfies `run_id < ''`: the equality branch is inert
    const params: (string | number)[] = [
      before,
      before,
      q.beforeId ?? "",
      hasContext ? JSON.stringify([...kept!]) : cutoff,
    ];
    if (q.recoveryEvidence !== undefined) {
      // Identity comparisons cannot prove an unreadable record is unrelated.
      // Use the same parser as the result loop, not a weaker SQL shape check.
      // Pinned sources can be older than the cutoff and retained ids need not
      // be contiguous: a policy-evicted row can sit between two kept rows.
      const validationWhere = kept === null ? `finished_at >= ?` : `run_id IN (SELECT value FROM json_each(?))`;
      const validationParam = kept === null ? cutoff : JSON.stringify([...kept]);
      for (const row of this.sql.exec<Pick<RunRow, "run_id" | "summary_json">>(
        `SELECT run_id, summary_json FROM runs WHERE ${validationWhere}`,
        validationParam,
      )) {
        if (!parseSummary(row)) return { items: [], evidenceComplete: false };
      }
      const scope = q.recoveryEvidence;
      const unitKey = `${scope.instanceId}:${scope.unit}`;
      const prefix = `${unitKey}/`;
      // Literal prefix, not LIKE: instance ids can contain SQL wildcard chars.
      // Bare unit keys remain candidates, never proof of absence.
      where.push(`(CASE WHEN json_valid(summary_json) THEN (
        json_extract(summary_json, '$.parentInstanceId') = ? OR
        json_extract(summary_json, '$.idempotencyKey') = ? OR
        substr(json_extract(summary_json, '$.idempotencyKey'), 1, ?) = ? OR
        thread_key IN (${scope.threadKeys.map(() => "?").join(",")})
      ) ELSE 1 END)`);
      params.push(scope.instanceId, unitKey, prefix.length, prefix, ...scope.threadKeys);
    }
    addFilters(where, params);
    const select = `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE ${where.join(" AND ")} ORDER BY finished_at DESC, run_id DESC`;
    // The kept-id filter precedes `LIMIT`, including when protected older
    // sources make the retained order discontinuous.
    const rows = this.sql.exec<RunRow>(`${select} LIMIT ?`, ...params, limit).toArray();
    const items: RunListItem[] = [];
    let malformed = false;
    for (const row of rows) {
      if (items.length >= limit) break;
      if (kept !== null && !kept.has(row.run_id)) break; // the SQL kept-id filter already excludes this row
      const summary = parseSummary(row);
      if (summary) items.push({ ...summary, bytes: row.bytes });
      else malformed = true;
    }
    const out: { items: RunListItem[]; nextBefore?: { finishedAt: number; id: string }; evidenceComplete?: boolean } = {
      items,
    };
    if (q.recoveryEvidence !== undefined) out.evidenceComplete = !malformed && rows.length < limit;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      out.nextBefore = { finishedAt: last.finished_at, id: last.run_id };
    }
    return out;
  }
}

type EventRow = { seq: number; json: string };

/** A visibility filter as one SQL boolean over the `runs` columns, its values
 *  appended to `params` — the same truth table as `matchesVisibility`
 *  (runRecord.ts). An empty `IN ()` list and an empty `or` are `0` (nothing),
 *  an empty `and` is `0` too (fail-closed, like the reference evaluator). The
 *  body validator (`isRunVisibilityFilter`) already bounded depth and width. */
function visibilitySql(f: RunVisibilityFilter, params: (string | number)[]): string {
  const inList = (column: string, values: readonly string[]): string => {
    if (values.length === 0) return "0";
    params.push(...values);
    return `${column} IN (${values.map(() => "?").join(",")})`;
  };
  switch (f.kind) {
    case "none":
      return "0";
    case "all":
      return "1";
    case "channels-in":
      return inList("channel_id", f.channelIds);
    case "visibility-in":
      return inList("channel_visibility", f.visibilities);
    case "repos-in":
      return inList(
        "LOWER(repo)",
        f.repos.map((r) => r.toLowerCase()),
      );
    case "repos-not-in":
      return f.repos.length === 0
        ? "repo IS NOT NULL"
        : `(repo IS NOT NULL AND NOT (${inList(
            "LOWER(repo)",
            f.repos.map((r) => r.toLowerCase()),
          )}))`;
    case "user-is":
      params.push(f.userId);
      return "user_id = ?";
    case "or":
      return f.of.length === 0 ? "0" : `(${f.of.map((p) => visibilitySql(p, params)).join(" OR ")})`;
    case "and":
      return f.of.length === 0 ? "0" : `(${f.of.map((p) => visibilitySql(p, params)).join(" AND ")})`;
  }
}

/** Event rows → stored events. A corrupt row is skipped, never fatal — the rest of the run still reads. */
function parseEventRows(rows: readonly EventRow[]): StoredRunEvent[] {
  const out: StoredRunEvent[] = [];
  for (const r of rows) {
    try {
      const parsed: unknown = JSON.parse(r.json);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
        out.push({ ...(parsed as RunEvent), seq: r.seq });
      }
    } catch {
      // skipped
    }
  }
  return out;
}

/** The stored summary (record minus events); null when the row is unreadable. */
/** How many usage-less rows one by-user read prices from their events before
 *  reporting the rest as pending: a page load stays quick while the history heals. */
const USAGE_BACKFILL_PER_CALL = 200;

type UsageRow = {
  run_id: string;
  user_id: string;
  agent: string | null;
  channel_id: string;
  thread_key: string;
  started_at: number;
  finished_at: number;
  usage_json: string | null;
  summary_json: string;
};

/** A stored `usage_json`, or undefined when absent or unreadable (then it is recomputed). */
function parseUsageJson(raw: string | null): RunUsage | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRunUsage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The two identity fields the by-user aggregate needs off a summary, read leniently. */
function identityOfSummary(raw: string): {
  userName?: string;
  parentRunId?: string;
  parentInstanceId?: string;
  idempotencyKey?: string;
  costCapUsd?: number;
} {
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof s.userName === "string" && s.userName ? { userName: s.userName } : {}),
      ...(typeof s.parentRunId === "string" && s.parentRunId ? { parentRunId: s.parentRunId } : {}),
      ...(typeof s.parentInstanceId === "string" && s.parentInstanceId ? { parentInstanceId: s.parentInstanceId } : {}),
      ...(typeof s.idempotencyKey === "string" && s.idempotencyKey ? { idempotencyKey: s.idempotencyKey } : {}),
      ...(typeof s.costCapUsd === "number" && Number.isFinite(s.costCapUsd) && s.costCapUsd > 0
        ? { costCapUsd: s.costCapUsd }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Private evidence can carry an unreadable producer projection for preservation only. */
function parseWorkEvidence(value: unknown, owner: RunWorkOwner): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Record<string, unknown>;
  if (
    evidence.version !== 1 ||
    Object.keys(evidence).some(
      (field) =>
        field !== "version" &&
        field !== "workReads" &&
        field !== "unitSeedReceipt" &&
        field !== "branchIdentityBaseline" &&
        field !== "branchPublication" &&
        field !== "reviewPublication" &&
        field !== "branchPushReceipts" &&
        field !== "doorPublicationPending",
    ) ||
    !workEvidenceBelongsToRun(evidence, owner)
  )
    return undefined;
  return evidence;
}

function parseSummary(row: Pick<RunRow, "summary_json">): RunListItem | null {
  try {
    const parsed: unknown = JSON.parse(row.summary_json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const {
      branchPublication: _branchPublication,
      reviewPublication: _reviewPublication,
      branchPushReceipts: _branchPushReceipts,
      ...summary
    } = parsed as Record<string, unknown>;
    return isRunListItem(summary) ? normalizeStored(summary as unknown as RunListItem) : null;
  } catch {
    return null;
  }
}

/** The one field of a stored row's summary the emission rule reads: whether the
 *  row is a provisional tombstone. Deliberately not a full `RunRecord` parse
 *  (run-metrics.md item 2) — this runs inside every upsert's transaction. */
function summaryIsProvisional(summaryJson: string): boolean {
  try {
    return (JSON.parse(summaryJson) as { provisional?: unknown }).provisional === true;
  } catch {
    return false;
  }
}

function parseRunId(v: unknown): Validated<string> {
  if (typeof v !== "string" || !RUN_ID_PATTERN.test(v)) return invalid("id must match ^[A-Za-z0-9_-]{1,64}$");
  return { ok: true, value: v };
}

function parseStoreKey(b: Record<string, unknown>): Validated<string> {
  return parseScopeKey(b.storeKey, "storeKey");
}

function parsePositiveInt(v: unknown, name: string, max: number): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max)
    return invalid(`${name} must be an integer between 1 and ${max}`);
  return { ok: true, value: v };
}

function parseRunPut(
  body: unknown,
): Validated<{ storeKey: string; record: RunRecord; proposal?: RunPolicyProposal; point?: RunMetricsPoint }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  if (!isRunRecord(b.record)) return invalid("record must be a RunRecord");
  const out: { storeKey: string; record: RunRecord; proposal?: RunPolicyProposal; point?: RunMetricsPoint } = {
    storeKey: key.value,
    record: b.record,
  };
  // The record's metrics point (run-metrics.md item 1), validated at the door
  // like everything else that reaches storage.
  if (b.point !== undefined) {
    if (!isRunMetricsPoint(b.point)) return invalid("point must be a RunMetricsPoint");
    out.point = b.point;
  }
  if (b.policy !== undefined) {
    if (typeof b.policy !== "object" || b.policy === null) return invalid("policy must be an object");
    const p = b.policy as Record<string, unknown>;
    const policy: Partial<RetentionPolicy> = {};
    for (const field of ["retentionDays", "maxRuns", "maxBytes"] as const) {
      const v = p[field];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
        return invalid(`policy.${field} must be an integer >= 1`);
      policy[field] = v;
    }
    if (typeof b.policyUpdatedAt !== "number" || !Number.isFinite(b.policyUpdatedAt) || b.policyUpdatedAt < 0) {
      return invalid("policyUpdatedAt must be a non-negative number when a policy is proposed");
    }
    out.proposal = { policy, policyUpdatedAt: b.policyUpdatedAt };
  }
  return { ok: true, value: out };
}

/** `{storeKey, id}` — the body of /runs/get, /runs/summary and /runs/delete, and the base of /runs/events. */
/** At most a year of runs a call — the page asks for 90 days at most. */
const USAGE_QUERY_MAX_SPAN_MS = 366 * 86_400_000;

function parseRunUsageQuery(body: unknown): Validated<{ storeKey: string; sinceMs: number; untilMs: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  const { sinceMs, untilMs } = b;
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0)
    return invalid("sinceMs must be a non-negative number");
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs) || untilMs <= sinceMs)
    return invalid("untilMs must be a number after sinceMs");
  if (untilMs - sinceMs > USAGE_QUERY_MAX_SPAN_MS) return invalid("the range may span at most 366 days");
  return { ok: true, value: { storeKey: key.value, sinceMs, untilMs } };
}

function parseRunTarget(body: unknown): Validated<{ storeKey: string; id: string }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  const id = parseRunId(b.id);
  if (!id.ok) return id;
  return { ok: true, value: { storeKey: key.value, id: id.value } };
}

function parseRunEvents(body: unknown): Validated<{ storeKey: string; id: string; afterSeq: number; limit: number }> {
  const base = parseRunTarget(body);
  if (!base.ok) return base;
  const b = body as Record<string, unknown>;
  let afterSeq = 0;
  if (b.afterSeq !== undefined) {
    if (typeof b.afterSeq !== "number" || !Number.isInteger(b.afterSeq) || b.afterSeq < 0)
      return invalid("afterSeq must be a non-negative integer");
    afterSeq = b.afterSeq;
  }
  let limit = RUN_EVENTS_DEFAULT_PAGE;
  if (b.limit !== undefined) {
    const l = parsePositiveInt(b.limit, "limit", RUN_EVENTS_MAX_PAGE);
    if (!l.ok) return l;
    limit = l.value;
  }
  return { ok: true, value: { ...base.value, afterSeq, limit } };
}

function parseRunList(body: unknown): Validated<{ storeKey: string; query: RunListOptions }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  const query: RunListOptions = {};
  if (b.limit !== undefined) {
    // Over-asking is not an error: the cap is the contract (`limit: 1000` → 200 rows).
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1)
      return invalid("limit must be a positive integer");
    query.limit = Math.min(b.limit, RUN_LIST_MAX_LIMIT);
  }
  for (const field of ["before", "sinceMs"] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return invalid(`${field} must be a number`);
    query[field] = v;
  }
  if (b.beforeId !== undefined) {
    const id = parseRunId(b.beforeId);
    if (!id.ok) return invalid("beforeId must match ^[A-Za-z0-9_-]{1,64}$");
    query.beforeId = id.value;
  }
  for (const field of ["agent", "channel", "threadKey"] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > MAX_KEY_CHARS)
      return invalid(`${field} must be a string of at most ${MAX_KEY_CHARS} characters`);
    query[field] = v;
  }
  if (b.parentRunId !== undefined) {
    const id = parseRunId(b.parentRunId);
    if (!id.ok) return invalid("parentRunId must match ^[A-Za-z0-9_-]{1,64}$");
    query.parentRunId = id.value;
  }
  if (b.pr !== undefined) {
    const pr = b.pr as Record<string, unknown> | null;
    if (
      typeof pr !== "object" ||
      pr === null ||
      typeof pr.repo !== "string" ||
      !REPO_SLUG.test(pr.repo) ||
      typeof pr.number !== "number" ||
      !Number.isInteger(pr.number) ||
      pr.number < 1
    )
      return invalid("pr must be { repo: owner/name, number: a positive integer }");
    query.pr = { repo: pr.repo, number: pr.number };
  }
  if (b.recoveryEvidence !== undefined) {
    if (!isRecoveryEvidenceScope(b.recoveryEvidence))
      return invalid("recoveryEvidence must name an instance, unit and original threads");
    // No paged or narrowed response can attest complete recovery evidence.
    if (Object.keys(query).some((field) => field !== "limit") || b.visibleTo !== undefined)
      return invalid("recoveryEvidence cannot be combined with list filters or cursors");
    query.recoveryEvidence = b.recoveryEvidence;
  }
  if (b.visibleTo !== undefined) {
    // A malformed filter is a 400, never "all": the bot degrades to live rows
    // rather than the DO widening what an actor may see.
    if (!isRunVisibilityFilter(b.visibleTo)) return invalid("visibleTo must be a run visibility filter");
    const headroom = DO_MAX_BOUND_PARAMETERS - RUN_LIST_BASE_PARAMETERS - (query.pr ? RUN_LIST_PR_PARAMETERS : 0);
    if (boundParameters(b.visibleTo) > headroom) return invalid(`visibleTo names more than ${headroom} ids`);
    query.visibleTo = b.visibleTo;
  }
  return { ok: true, value: { storeKey: key.value, query } };
}

/** Parameters the page query binds before any filter: the cursor pair (3) and the age floor (1),
 *  plus `agent`, `channel`, `threadKey`, `parentRunId`, and the LIMIT at most — the headroom `visibleTo` must fit under. */
const RUN_LIST_BASE_PARAMETERS = 9;
/** The two more a `pr` filter binds (`repo`, `pr_number`), taken from the same headroom only when asked. */
const RUN_LIST_PR_PARAMETERS = 2;

/** How many `?` a filter binds (one per id, one per user). */
function boundParameters(f: RunVisibilityFilter): number {
  switch (f.kind) {
    case "none":
    case "all":
      return 0;
    case "channels-in":
      return f.channelIds.length;
    case "visibility-in":
      return f.visibilities.length;
    case "repos-in":
    case "repos-not-in":
      return f.repos.length;
    case "user-is":
      return 1;
    case "or":
    case "and":
      return f.of.reduce((n, p) => n + boundParameters(p), 0);
  }
}

// ---------------------------------------------------------------------------
// Auth (mirrors the resident Worker)
// ---------------------------------------------------------------------------

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Constant-time byte comparison; the length early-return leaks only length. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Fail closed: an unset/empty secret grants nothing. */
function authorized(env: Env, request: Request): boolean {
  const token = bearerToken(request);
  return !!token && !!env.MEMORY_TOKEN && timingSafeEqual(token, env.MEMORY_TOKEN);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function invalid<T>(error: string): Validated<T> {
  return { ok: false, error };
}

/** A scope key is an opaque namespaced id (`org:acme`): non-empty,
 *  bounded, no whitespace or control characters. `fieldName` names the body
 *  field in the error (the run routes call theirs
 *  `storeKey`). */
function parseScopeKey(v: unknown, fieldName = "scopeKey"): Validated<string> {
  if (typeof v !== "string" || v.length === 0) return invalid(`${fieldName} must be a non-empty string`);
  if (v.length > MAX_KEY_CHARS) return invalid(`${fieldName} must be at most ${MAX_KEY_CHARS} characters`);
  if (/[\s\p{C}]/u.test(v)) return invalid(`${fieldName} must not contain whitespace or control characters`);
  return { ok: true, value: v };
}

function parseLimit(v: unknown): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT) {
    return invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { ok: true, value: v };
}

/** `POST /list {scopeKey, limit, query?, kind?}`. */
function parseList(
  body: unknown,
): Validated<{ scopeKey: string; limit: number; query?: string; kind?: MemoryRecord["kind"] }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  const limit = parseLimit(b.limit);
  if (!limit.ok) return limit;
  if (b.query !== undefined) {
    if (typeof b.query !== "string") return invalid("query must be a string");
    if (b.query.length > MAX_QUERY_CHARS) return invalid(`query must be at most ${MAX_QUERY_CHARS} characters`);
  }
  if (b.kind !== undefined && b.kind !== "fact" && b.kind !== "summary")
    return invalid('kind must be "fact" or "summary"');
  return {
    ok: true,
    value: {
      scopeKey: scope.value,
      limit: limit.value,
      ...(typeof b.query === "string" ? { query: b.query } : {}),
      ...(b.kind === "fact" || b.kind === "summary" ? { kind: b.kind } : {}),
    },
  };
}

/** `POST /sweep {scopeKey, dryRun?}`. */
function parseSweep(body: unknown): Validated<{ scopeKey: string; dryRun: boolean }> {
  if (!isJsonObject(body)) return invalid("body must be a JSON object");
  const b = body;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return invalid("dryRun must be a boolean");
  return { ok: true, value: { scopeKey: scope.value, dryRun: b.dryRun === true } };
}

/** `POST /forget {scopeKey, id}`: the id is an opaque key, same caps as scopeKey. */
function parseForget(body: unknown): Validated<{ scopeKey: string; id: string }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (typeof b.id !== "string" || b.id.length === 0 || b.id.length > MAX_KEY_CHARS || /[\s\p{Cc}]/u.test(b.id)) {
    return invalid(`id must be a non-empty string of at most ${MAX_KEY_CHARS} characters with no whitespace`);
  }
  return { ok: true, value: { scopeKey: scope.value, id: b.id } };
}

function parseRetrieve(body: unknown): Validated<{ scopeKey: string; query: string; limit: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (typeof b.query !== "string") return invalid("query must be a string");
  if (b.query.length > MAX_QUERY_CHARS) return invalid(`query must be at most ${MAX_QUERY_CHARS} characters`);
  if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > MAX_LIMIT) {
    return invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { ok: true, value: { scopeKey: scope.value, query: b.query, limit: b.limit } };
}

function parseCandidate(v: unknown, i: number): Validated<MemoryCandidate> {
  const at = `records[${i}]`;
  if (typeof v !== "object" || v === null) return invalid(`${at} must be an object`);
  const c = v as Record<string, unknown>;
  if (c.kind !== "fact" && c.kind !== "summary") return invalid(`${at}.kind must be "fact" or "summary"`);
  if (typeof c.text !== "string" || c.text.trim().length === 0) return invalid(`${at}.text must be a non-empty string`);
  if (c.text.length > MAX_TEXT_CHARS) return invalid(`${at}.text must be at most ${MAX_TEXT_CHARS} characters`);
  if (
    typeof c.sourceThreadKey !== "string" ||
    c.sourceThreadKey.length === 0 ||
    c.sourceThreadKey.length > MAX_KEY_CHARS
  ) {
    return invalid(`${at}.sourceThreadKey must be a non-empty string`);
  }
  const out: MemoryCandidate = { kind: c.kind, text: c.text, sourceThreadKey: c.sourceThreadKey };
  if (c.provenance !== undefined) {
    if (!isMemoryProvenance(c.provenance)) return invalid(`${at}.provenance must be a bounded memory revision`);
    out.provenance = c.provenance;
  }
  if (c.keywords !== undefined) {
    if (
      !Array.isArray(c.keywords) ||
      c.keywords.length > MAX_KEYWORDS ||
      !c.keywords.every((k) => typeof k === "string" && k.length > 0 && k.length <= MAX_KEYWORD_CHARS)
    ) {
      return invalid(`${at}.keywords must be an array of at most ${MAX_KEYWORDS} short strings`);
    }
    out.keywords = c.keywords as string[];
  }
  if (c.sourceRunId !== undefined) {
    if (typeof c.sourceRunId !== "string" || c.sourceRunId.length > MAX_KEY_CHARS)
      return invalid(`${at}.sourceRunId must be a string`);
    out.sourceRunId = c.sourceRunId;
  }
  if (c.confidence !== undefined) {
    if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      return invalid(`${at}.confidence must be a number in [0, 1]`);
    }
    out.confidence = c.confidence;
  }
  if (c.supersedes !== undefined) {
    if (typeof c.supersedes !== "string" || c.supersedes.length > MAX_KEY_CHARS)
      return invalid(`${at}.supersedes must be a string`);
    out.supersedes = c.supersedes;
  }
  if (c.restates !== undefined) {
    if (typeof c.restates !== "string" || c.restates.length > MAX_KEY_CHARS)
      return invalid(`${at}.restates must be a string`);
    out.restates = c.restates;
  }
  return { ok: true, value: out };
}

/** Upper bound on a caller-supplied per-scope cap. */
const MAX_SCOPE_CAP = 10_000;

function parseWrite(body: unknown): Validated<{ scopeKey: string; records: MemoryCandidate[]; cap?: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  let cap: number | undefined;
  if (b.cap !== undefined) {
    if (typeof b.cap !== "number" || !Number.isInteger(b.cap) || b.cap < 1 || b.cap > MAX_SCOPE_CAP) {
      return invalid(`cap must be an integer between 1 and ${MAX_SCOPE_CAP}`);
    }
    cap = b.cap;
  }
  if (!Array.isArray(b.records)) return invalid("records must be an array");
  if (b.records.length > MAX_BATCH) return invalid(`records must hold at most ${MAX_BATCH} candidates`);
  const records: MemoryCandidate[] = [];
  for (let i = 0; i < b.records.length; i++) {
    const c = parseCandidate(b.records[i], i);
    if (!c.ok) return c;
    records.push(c.value);
  }
  return { ok: true, value: { scopeKey: scope.value, records, ...(cap !== undefined ? { cap } : {}) } };
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Live-run transcripts (run-history item 32)
// ---------------------------------------------------------------------------

/** One object per LIVE run, named by run id: the raw transcript a resumed run
 *  continues from, one row per content part (never near the 2 MB row limit),
 *  attachments over the reference threshold stored once. Fenced by its own
 *  `owner` row — set at claim, replaced by reclaim — because this object and
 *  the history object commit independently, and a zombie generation whose
 *  history write is about to be refused must not land transcript rows either. */
export class RunTranscriptDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner (k INTEGER PRIMARY KEY CHECK (k = 1), gen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_messages (
        idx INTEGER NOT NULL,
        part INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (idx, part)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        ref TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  async setOwner(gen: string): Promise<{ ok: true }> {
    this.sql.exec(`INSERT INTO owner (k, gen) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET gen = excluded.gen`, gen);
    return { ok: true };
  }

  private owner(): string | undefined {
    return this.sql.exec<{ gen: string }>(`SELECT gen FROM owner WHERE k = 1`).toArray()[0]?.gen;
  }

  async write(gen: string, rows: TranscriptRow[], attachments: TranscriptAttachment[]): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const owner = this.owner();
      if (owner === undefined) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner !== gen) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      for (const a of attachments) {
        this.sql.exec(
          `INSERT OR REPLACE INTO attachments (ref, media_type, data) VALUES (?, ?, ?)`,
          a.ref,
          a.mediaType,
          a.data,
        );
      }
      for (const r of rows) {
        this.sql.exec(`INSERT OR REPLACE INTO run_messages (idx, part, json) VALUES (?, ?, ?)`, r.idx, r.part, r.json);
      }
    });
    return out;
  }

  async read(): Promise<{ rows: TranscriptRow[]; attachments: TranscriptAttachment[] }> {
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string }>(`SELECT idx, part, json FROM run_messages ORDER BY idx, part`)
      .toArray();
    const attachments = this.sql
      .exec<{ ref: string; media_type: string; data: string }>(`SELECT ref, media_type, data FROM attachments`)
      .toArray()
      .map((a) => ({ ref: a.ref, mediaType: a.media_type, data: a.data }));
    return { rows, attachments };
  }

  async clear(): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM run_messages`);
      this.sql.exec(`DELETE FROM attachments`);
      this.sql.exec(`DELETE FROM owner`);
    });
    return { ok: true };
  }
}

/** A tool-result marker's size, for the byte policy's first estimate of how
 *  many rows to replace; the pass repeats on the measured total, so the
 *  estimate only decides how many rows one pass tries. */
const TRIM_MARKER_BYTES_ESTIMATE = 260;

type SessionTurnRow = { id: number; idx: number; part: number; json: string; text: string };

/**
 * One session log (docs/reference/specs/session-log.md): the transcript rows of every
 * run of a thread-and-agent session, each at its log index, under the same
 * `(idx, part)` upsert and owner fence as a run's transcript object — plus a
 * full-text index over the rows' text, kept in step by hand because an
 * external-content FTS5 table learns of a replaced row only when told, the
 * attachments the rows reference, the byte policy that replaces the oldest
 * tool results with a marker once the log is over its budget, and the
 * notepad row a later release writes. Nothing here is cleared when a run
 * finishes; the enabled sweep on `RunHistoryDO` drops the whole object.
 */
export class SessionLogDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner (k INTEGER PRIMARY KEY CHECK (k = 1), run_id TEXT NOT NULL, gen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        idx INTEGER NOT NULL,
        part INTEGER NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        trimmed INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL,
        text TEXT NOT NULL,
        UNIQUE (idx, part)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, content='turns', content_rowid='id');
      CREATE TABLE IF NOT EXISTS attachments (
        ref TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        data TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notepad (k INTEGER PRIMARY KEY CHECK (k = 1), text TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requester_target (actor TEXT PRIMARY KEY, repo TEXT NOT NULL, issue TEXT, provenance TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0);
    `);
    // The keyed append's identity (session-log item 13): a row group's id, on
    // its first part; a partial unique index holds the idempotency line. Added
    // by ALTER so a log written before the column keeps its rows.
    const columns = new Set(
      this.sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('turns')`)
        .toArray()
        .map((r) => r.name),
    );
    if (!columns.has("row_id")) this.sql.exec(`ALTER TABLE turns ADD COLUMN row_id TEXT`);
    if (!columns.has("row_hash")) this.sql.exec(`ALTER TABLE turns ADD COLUMN row_hash TEXT`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS turns_row_id ON turns(row_id) WHERE row_id IS NOT NULL`);
  }

  /** The index the next row lands at: one past the newest turn, 0 for an empty
   *  log. (Not named `tail`: the runtime reserves that as a handler name on an
   *  entrypoint and refuses it over RPC.) */
  async nextIndex(): Promise<{ next: number }> {
    return { next: this.next() };
  }

  private next(): number {
    return this.sql.exec<{ next: number }>(`SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM turns`).one().next;
  }

  /** The live writer: the run and the generation whose writes land. Replaced
   *  by every claim and reclaim, as the transcript object's owner is. The byte
   *  budget rides along so the object enforces the store's policy on write. */
  private sourceSeedRecords(): SourceSeedOriginalRecord[] {
    const records: SourceSeedOriginalRecord[] = [];
    for (const row of this.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM meta WHERE key GLOB ?",
        SOURCE_SEED_RECORD_PREFIX + "*",
      )
      .toArray()) {
      let record: SourceSeedOriginalRecord | undefined;
      try {
        record = sourceSeedOriginalOf(JSON.parse(row.value));
      } catch {
        /* Preserve unreadable metadata. */
      }
      if (
        !record ||
        sourceSeedOriginalKey(record.receipt) !== row.key ||
        !this.ctx.id.equals(this.env.SESSION_LOGS.idFromName(record.receipt.key))
      )
        throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
      records.push(record);
    }
    const legacy = this.sourceMeta("expected_seed_pending"),
      rawRelease = this.sourceMeta("expected_seed_release");
    if (legacy !== undefined) {
      let receipt: SourceSeedReceipt | undefined, release: SourceSeedReleaseReceipt | undefined;
      try {
        receipt = sourceSeedReceiptOf(JSON.parse(legacy));
        release = rawRelease === undefined ? undefined : sourceSeedReleaseOf(JSON.parse(rawRelease));
      } catch {
        /* Preserve unreadable legacy evidence. */
      }
      if (
        !receipt ||
        !this.ctx.id.equals(this.env.SESSION_LOGS.idFromName(receipt.key)) ||
        (rawRelease !== undefined && (!release || canonicalSeedJson(release.source) !== canonicalSeedJson(receipt)))
      )
        throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
      const saved = records.find((record) => sourceSeedOriginalKey(record.receipt) === sourceSeedOriginalKey(receipt!));
      if (
        saved &&
        (canonicalSeedJson(saved.receipt) !== canonicalSeedJson(receipt) ||
          (release && canonicalSeedJson(saved.release) !== canonicalSeedJson(release)))
      )
        throw new SourceSeedPendingError(receipt.key, receipt.runId);
      if (!saved) records.push({ version: 1, receipt, ...(release ? { release } : {}) });
    }
    return records;
  }
  private sourceSeedRecord(ref: SourceSeedReference): SourceSeedOriginalRecord | undefined {
    const name = sourceSeedOriginalKey(ref),
      raw = this.sourceMeta(name);
    if (raw !== undefined) {
      let record: SourceSeedOriginalRecord | undefined;
      try {
        record = sourceSeedOriginalOf(JSON.parse(raw));
      } catch {
        /* Preserve unreadable metadata. */
      }
      if (
        !record ||
        sourceSeedOriginalKey(record.receipt) !== name ||
        !this.ctx.id.equals(this.env.SESSION_LOGS.idFromName(record.receipt.key))
      )
        throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
      return record;
    }
    const legacy = this.sourceMeta("expected_seed_pending"),
      rawRelease = this.sourceMeta("expected_seed_release");
    if (legacy === undefined) return;
    let receipt: SourceSeedReceipt | undefined, release: SourceSeedReleaseReceipt | undefined;
    try {
      receipt = sourceSeedReceiptOf(JSON.parse(legacy));
      release = rawRelease === undefined ? undefined : sourceSeedReleaseOf(JSON.parse(rawRelease));
    } catch {
      /* Preserve unreadable metadata. */
    }
    if (
      !receipt ||
      (rawRelease !== undefined && (!release || canonicalSeedJson(release.source) !== canonicalSeedJson(receipt)))
    )
      throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
    return sourceSeedOriginalKey(receipt) === name
      ? { version: 1, receipt, ...(release ? { release } : {}) }
      : undefined;
  }
  private currentSourceSeedRecord(): SourceSeedOriginalRecord | undefined {
    const raw = this.sourceMeta("expected_seed_current");
    if (raw !== undefined) {
      let ref: SourceSeedReference | undefined;
      try {
        ref = sourceSeedReferenceOf(JSON.parse(raw));
      } catch {
        /* A pointer alone proves nothing. */
      }
      const record = ref && this.sourceSeedRecord(ref);
      if (!record) throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
      return record;
    }
    if (
      this.sql.exec("SELECT key FROM meta WHERE key GLOB ? LIMIT 1", SOURCE_SEED_RECORD_PREFIX + "*").toArray().length
    )
      throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
    const legacy = this.sourceMeta("expected_seed_pending");
    if (legacy === undefined) return;
    let receipt: SourceSeedReceipt | undefined;
    try {
      receipt = sourceSeedReceiptOf(JSON.parse(legacy));
    } catch {
      /* Preserve unreadable metadata. */
    }
    if (!receipt) throw new SourceSeedPendingError(this.ctx.id.toString(), this.owner()?.runId ?? "unknown");
    return this.sourceSeedRecord(receipt);
  }
  private storedSourceSeedReceipt(): SourceSeedReceipt | undefined {
    return this.currentSourceSeedRecord()?.receipt;
  }
  private sourceSeedRelease(): SourceSeedReleaseReceipt | undefined {
    return this.currentSourceSeedRecord()?.release;
  }
  private sourceSeedPending(): SourceSeedReceipt | undefined {
    const current = this.currentSourceSeedRecord(),
      pending = this.sourceSeedRecords().filter((record) => !record.release);
    if (
      pending.some(
        (record) => !current || sourceSeedOriginalKey(record.receipt) !== sourceSeedOriginalKey(current.receipt),
      )
    )
      throw new SourceSeedPendingError(pending[0].receipt.key, pending[0].receipt.runId);
    return current?.release ? undefined : current?.receipt;
  }
  private retainSourceSeedRecord(record: SourceSeedOriginalRecord): void {
    this.setSourceMeta(sourceSeedOriginalKey(record.receipt), JSON.stringify(record));
    const legacy = this.sourceMeta("expected_seed_pending");
    if (legacy === undefined) this.setSourceMeta("expected_seed_pending", JSON.stringify(record.receipt));
    if (
      record.release &&
      this.sourceMeta("expected_seed_release") === undefined &&
      sourceSeedOriginalKey(sourceSeedReceiptOf(JSON.parse(this.sourceMeta("expected_seed_pending")!))!) ===
        sourceSeedOriginalKey(record.receipt)
    )
      this.setSourceMeta("expected_seed_release", JSON.stringify(record.release));
  }
  async releaseExpectedSeed(key: string, input: SourceSeedReference): Promise<SourceSeedResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref || !this.ctx.id.equals(this.env.SESSION_LOGS.idFromName(key))) return { kind: "held", reason: "mismatch" };
    let stored: SourceSeedReceipt | undefined;
    try {
      stored = this.sourceSeedRecord(ref)?.receipt;
    } catch {
      return { kind: "held", reason: "corrupt" };
    }
    if (!stored || !sourceSeedReferenceMatches(stored, ref, key)) return { kind: "held", reason: "mismatch" };
    if (this.sourceSeedRecord(ref)?.release) return this.readExpectedSeed(key, ref);
    const snapshot = () => ({
      data: this.sourceSeedSnapshot(stored!.from, stored!.through),
      record: this.sourceSeedRecord(ref),
      current: this.sourceMeta("expected_seed_current"),
      pins: this.sourceMeta("range_pins"),
      revision: this.sourceMeta("range_pin_revision"),
      guarded: this.sourceMeta("custody_pin_guard"),
    });
    const before = canonicalSeedJson(snapshot());
    const actual = await this.env.RUNS.get(this.env.RUNS.idFromName(ref.storeKey)).readPromotion({
      runId: ref.runId,
      gen: ref.gen,
      bodySha256: ref.bodySha256,
    });
    if (actual.kind !== "confirmed" || canonicalSeedJson(actual.receipt.source) !== canonicalSeedJson(stored))
      return { kind: "held", reason: "mismatch" };
    const verified = await this.readExpectedSeed(key, ref);
    if (
      verified.kind !== "verified" ||
      verified.release ||
      canonicalSeedJson(verified.receipt) !== canonicalSeedJson(stored)
    )
      return { kind: "held", reason: "mismatch" };
    let result: SourceSeedResult = { kind: "held", reason: "mismatch" };
    this.ctx.storage.transactionSync(() => {
      if (canonicalSeedJson(snapshot()) !== before) return;
      const release: SourceSeedReleaseReceipt = {
        version: 1,
        phase: "released",
        source: stored!,
        confirmation: actual.receipt,
      };
      this.retainSourceSeedRecord({ version: 1, receipt: stored!, release });
      result = { kind: "verified", receipt: structuredClone(stored!), release: structuredClone(release) };
    });
    return result;
  }
  async observeExpectedSeed(from: number, through: number): Promise<SourceSeedSnapshot> {
    return this.sourceSeedSnapshot(from, through);
  }
  private sourceSeedSnapshot(from: number, through: number): SourceSeedSnapshot {
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string; trimmed: number }>(
        "SELECT idx,part,json,trimmed FROM turns WHERE idx >= ? AND idx <= ? ORDER BY idx,part",
        from,
        through,
      )
      .toArray();
    return {
      rows,
      attachments: this.attachmentsOf(rows),
      owner: this.owner(),
      next: this.next(),
      sources: this.sources(),
      context: this.sources()?.context,
      notepad: this.sql.exec<{ text: string }>("SELECT text FROM notepad WHERE k=1").toArray()[0]?.text ?? "",
    };
  }
  async verifyExpectedSeed(key: string, input: SourceSeedReference): Promise<SourceSeedResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref || !this.ctx.id.equals(this.env.SESSION_LOGS.idFromName(key))) return { kind: "held", reason: "mismatch" };
    if (this.sourceSeedRecord(ref)?.release) return this.readExpectedSeed(key, ref);
    const actual = await this.env.RUNS.get(this.env.RUNS.idFromName(ref.storeKey)).readPromotion({
      runId: ref.runId,
      gen: ref.gen,
      bodySha256: ref.bodySha256,
    });
    const expected = authenticatedSeedExpectation(key, ref, actual);
    if (!expected) return { kind: "held", reason: "mismatch" };
    if (this.sourceSeedRecord(ref)) return this.readExpectedSeed(key, ref);
    const previous = this.currentSourceSeedRecord();
    if (previous && !previous.release) return { kind: "held", reason: "owner" };
    const previousBefore = canonicalSeedJson(previous ?? null);
    const snapshot = this.sourceSeedSnapshot(expected.from, expected.through),
      before = canonicalSeedJson(snapshot),
      hashes = await verifiedSourceSeedHashes(snapshot, expected);
    if (!hashes) return { kind: "held", reason: "mismatch" };
    let result: SourceSeedResult = { kind: "held", reason: "mismatch" };
    this.ctx.storage.transactionSync(() => {
      if (canonicalSeedJson(this.sourceSeedSnapshot(expected.from, expected.through)) !== before) return;
      const pending = this.sourceSeedRecord(ref)?.receipt;
      if (pending) {
        if (sourceSeedReferenceMatches(pending, ref, key))
          result = { kind: "verified", receipt: structuredClone(pending) };
        return;
      }
      if (canonicalSeedJson(this.currentSourceSeedRecord() ?? null) !== previousBefore) return;
      const pins = this.rangePins();
      pins[ref.runId] = [...(pins[ref.runId] ?? []), { from: expected.from, to: expected.through }];
      const revision = this.writeRangePins(pins, true);
      if (revision === undefined) {
        result = { kind: "held", reason: "corrupt" };
        return;
      }
      const receipt: SourceSeedReceipt = {
        ...ref,
        ...hashes,
        version: 1,
        phase: "pending-confirmation",
        key,
        startedAt: expected.startedAt,
        namespace: expected.namespace,
        requester: expected.requester,
        from: expected.from,
        through: expected.through,
        count: expected.count,
        next: snapshot.next,
        pinRevision: revision,
      };
      if (previous) this.retainSourceSeedRecord(previous);
      this.retainSourceSeedRecord({ version: 1, receipt });
      this.setSourceMeta("expected_seed_current", JSON.stringify(sourceSeedReferenceOfReceipt(receipt)));
      result = { kind: "verified", receipt: structuredClone(receipt) };
    });
    return result;
  }
  async readExpectedSeed(key: string, input: SourceSeedReference): Promise<SourceSeedResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref || !this.ctx.id.equals(this.env.SESSION_LOGS.idFromName(key))) return { kind: "held", reason: "mismatch" };
    let receipt: SourceSeedReceipt | undefined;
    try {
      receipt = this.sourceSeedRecord(ref)?.receipt;
    } catch {
      return { kind: "held", reason: "corrupt" };
    }
    if (!receipt) return { kind: "held", reason: "missing" };
    if (!sourceSeedReferenceMatches(receipt, ref, key)) return { kind: "held", reason: "mismatch" };
    if (this.sourceSeedRecord(ref)?.release !== undefined) {
      try {
        return { kind: "verified", receipt: structuredClone(receipt), release: this.sourceSeedRecord(ref)!.release! };
      } catch {
        return { kind: "held", reason: "corrupt" };
      }
    }
    const actual = await this.env.RUNS.get(this.env.RUNS.idFromName(ref.storeKey)).readPromotion({
        runId: ref.runId,
        gen: ref.gen,
        bodySha256: ref.bodySha256,
      }),
      expected = authenticatedSeedExpectation(key, ref, actual);
    if (!expected) return { kind: "held", reason: "mismatch" };
    const snapshot = this.sourceSeedSnapshot(expected.from, expected.through),
      before = canonicalSeedJson(snapshot),
      hashes = await verifiedSourceSeedHashes(snapshot, expected),
      revision = await this.custodyPinRevision();
    if (
      !hashes ||
      canonicalSeedJson(this.sourceSeedSnapshot(expected.from, expected.through)) !== before ||
      canonicalSeedJson(this.sourceSeedPending()) !== canonicalSeedJson(receipt) ||
      !revision?.guarded ||
      revision.revision < receipt.pinRevision ||
      !this.rangePins()[ref.runId]?.some((r) => r.from === receipt!.from && r.to === receipt!.through)
    )
      return { kind: "held", reason: "corrupt" };
    return { kind: "verified", receipt: structuredClone(receipt) };
  }
  /** Actual source precondition, not a fabricated ownership fence or terminal witness. */
  async expectedSeedMutationHold(): Promise<{
    kind: "held";
    reason: "source_seed_pending";
    key: string;
    runId: string;
  } | null> {
    const pending = this.sourceSeedPending();
    return pending ? { kind: "held", reason: "source_seed_pending", key: pending.key, runId: pending.runId } : null;
  }
  async setOwner(runId: string, gen: string, maxBytes: number = DEFAULT_SESSION_LOG_MAX_BYTES): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      const held = this.sourceSeedPending();
      if (held) {
        if (held.runId === runId && held.gen === gen && String(maxBytes) === this.sourceMeta("max_bytes")) return;
        throw new SourceSeedPendingError(held.key, held.runId);
      }
      const pending = this.sourceMeta("source_pending_owner");
      if (pending && pending !== `${runId}:${gen}`)
        this.setSourceMeta("sources", JSON.stringify(taintSessionSources(this.sources())));
      this.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('source_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(this.next()),
      );
      this.sql.exec(
        `INSERT INTO owner (k, run_id, gen) VALUES (1, ?, ?) ON CONFLICT(k) DO UPDATE SET run_id = excluded.run_id, gen = excluded.gen`,
        runId,
        gen,
      );
      this.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('max_bytes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(maxBytes),
      );
    });
    return { ok: true };
  }

  async maxBytes(): Promise<number> {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'max_bytes'`).toArray()[0];
    const n = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_LOG_MAX_BYTES;
  }

  async checkpointSnapshot(from: number, to: number) {
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string }>(
        `SELECT idx, part, json FROM turns WHERE idx >= ? AND idx <= ? ORDER BY idx, part`,
        from,
        to,
      )
      .toArray();
    return {
      rows,
      attachments: this.attachmentsOf(rows),
      owner: this.owner(),
      next: this.next(),
      context: this.sources()?.context,
      notepad: this.sql.exec<{ text: string }>(`SELECT text FROM notepad WHERE k = 1`).toArray()[0]?.text ?? "",
    };
  }

  async installCheckpoint(runId: string, gen: string, receipt: ContextCheckpointReceipt): Promise<FenceResult> {
    const pending = this.sourceSeedPending();
    if (pending) throw new SourceSeedPendingError(pending.key, pending.runId);
    const { seedFrom, through } = receipt.session;
    const snapshot = await this.checkpointSnapshot(seedFrom, through);
    if (snapshot.owner?.runId !== runId || snapshot.owner.gen !== gen) return { ok: false, reason: "fenced" };
    if (
      snapshot.next !== through + 1 ||
      !isContextDependencies(snapshot.context) ||
      snapshot.context.status !== "known"
    )
      return { ok: false, reason: "fenced" };
    const digest = await contextDependenciesHash(snapshot.context);
    if (digest !== receipt.beforeHash && digest !== receipt.normalizedHash) return { ok: false, reason: "fenced" };
    if (
      (await sourceHash(assembleTranscript(snapshot.rows, snapshot.attachments, seedFrom))) !==
        receipt.inputs.transcriptHash ||
      (await sourceHash(snapshot.notepad)) !== receipt.inputs.notepadHash
    )
      return { ok: false, reason: "fenced" };
    const current = await this.checkpointSnapshot(seedFrom, through);
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) return { ok: false, reason: "fenced" };
    return this.ctx.storage.transactionSync(() => {
      const pending = this.sourceSeedPending();
      if (pending) throw new SourceSeedPendingError(pending.key, pending.runId);
      const owner = this.owner();
      if (
        owner?.runId !== runId ||
        owner.gen !== gen ||
        this.next() !== through + 1 ||
        JSON.stringify(this.sources()?.context) !== JSON.stringify(snapshot.context)
      )
        return { ok: false, reason: "fenced" };
      const raw = this.sql
        .exec<{ idx: number; part: number; json: string; trimmed: number }>(
          `SELECT idx, part, json, trimmed FROM turns WHERE idx >= ? AND idx <= ? ORDER BY idx, part`,
          seedFrom,
          through,
        )
        .toArray();
      if (
        !sessionRangesAvailable(raw, [{ from: seedFrom, to: through }]) ||
        JSON.stringify(raw.map(({ idx, part, json }) => ({ idx, part, json }))) !== JSON.stringify(snapshot.rows)
      )
        return { ok: false, reason: "fenced" };
      if (
        (this.sql.exec<{ text: string }>(`SELECT text FROM notepad WHERE k = 1`).toArray()[0]?.text ?? "") !==
          snapshot.notepad ||
        JSON.stringify(this.attachmentsOf(raw)) !== JSON.stringify(snapshot.attachments)
      )
        return { ok: false, reason: "fenced" };
      const pins = this.rangePins();
      pins[runId] = [...(pins[runId] ?? []), { from: seedFrom, to: through }];
      if (this.writeRangePins(pins) === undefined) return { ok: false, reason: "fenced" };
      this.setSourceMeta("sources", JSON.stringify({ ...this.sources(), context: receipt.normalized }));
      return { ok: true };
    });
  }

  async acknowledgeUnitSeed(runId: string, gen: string, receipt: UnitSeedReceipt): Promise<FenceResult> {
    const { from, through, messagesHash } = receipt.seed;
    const snapshot = await this.checkpointSnapshot(from, through);
    if (
      snapshot.owner?.runId !== runId ||
      snapshot.owner.gen !== gen ||
      (await sourceHash(assembleTranscript(snapshot.rows, snapshot.attachments, from))) !== messagesHash
    )
      return { ok: false, reason: "fenced" };
    return this.ctx.storage.transactionSync(() => {
      const owner = this.owner();
      const rows = this.sql
        .exec<{ idx: number; part: number; json: string; trimmed: number }>(
          `SELECT idx, part, json, trimmed FROM turns WHERE idx >= ? AND idx <= ? ORDER BY idx, part`,
          from,
          through,
        )
        .toArray();
      if (
        owner?.runId !== runId ||
        owner.gen !== gen ||
        !sessionRangesAvailable(rows, [{ from, to: through }]) ||
        JSON.stringify(rows.map(({ idx, part, json }) => ({ idx, part, json }))) !== JSON.stringify(snapshot.rows) ||
        JSON.stringify(this.attachmentsOf(rows)) !== JSON.stringify(snapshot.attachments)
      )
        return { ok: false, reason: "fenced" };
      const pins = this.rangePins();
      pins[runId] = [...(pins[runId] ?? []), { from, to: through }];
      return this.writeRangePins(pins) === undefined ? { ok: false, reason: "fenced" } : { ok: true };
    });
  }

  private rangePins(): SessionRangePins {
    const stored = this.sourceMeta("range_pins");
    return stored ? (JSON.parse(stored) as SessionRangePins) : {};
  }

  /** A separate RPC capability: an older receiver cannot silently execute a
   * legacy unconditional prune when this revision protocol is requested. */
  async custodyPinRevision(): Promise<CustodyPinRevision | undefined> {
    const raw = this.sourceMeta("range_pin_revision"),
      guard = this.sourceMeta("custody_pin_guard");
    if (
      (guard !== undefined && guard !== "1") ||
      (guard !== undefined && raw === undefined) ||
      !isCustodyRangePins(this.rangePins())
    )
      return;
    const revision = raw === undefined ? 0 : Number(raw);
    if (raw !== undefined && String(revision) !== raw) return;
    return custodyPinRevisionOf({ version: 1, revision, guarded: guard === "1" });
  }

  private writeRangePins(pins: SessionRangePins, guarded = false): number | undefined {
    pins = structuredClone(pins);
    for (const { receipt: pending } of this.sourceSeedRecords()) {
      const held = pins[pending.runId] ?? [];
      pins[pending.runId] = held.some((range) => range.from === pending.from && range.to === pending.through)
        ? held
        : [...held, { from: pending.from, to: pending.through }];
      guarded = true;
    }
    const raw = this.sourceMeta("range_pin_revision"),
      guard = this.sourceMeta("custody_pin_guard");
    if (
      (guard !== undefined && guard !== "1") ||
      (guard !== undefined && raw === undefined) ||
      !isCustodyRangePins(this.rangePins()) ||
      !isCustodyRangePins(pins)
    )
      return;
    const current = custodyPinRevisionOf({
      version: 1,
      revision: raw === undefined ? 0 : Number(raw),
      guarded: guard === "1",
    });
    if (!current || (raw !== undefined && String(current.revision) !== raw)) return;
    const revision = nextCustodyPinRevision(current);
    if (revision === undefined) return;
    this.setSourceMeta("range_pins", JSON.stringify(pins));
    this.setSourceMeta("range_pin_revision", String(revision));
    if (guarded) this.setSourceMeta("custody_pin_guard", "1");
    return revision;
  }

  async protectCustodyRanges(holder: string, ranges: readonly SessionRangePin[]) {
    return this.ctx.storage.transactionSync(() => {
      if (typeof holder !== "string" || !holder || !Array.isArray(ranges) || !ranges.length)
        return { ok: false as const };
      const rows = this.sql
        .exec<{ idx: number; part: number; json: string; trimmed: number }>("SELECT idx,part,json,trimmed FROM turns")
        .toArray();
      if (!sessionRangesAvailable(rows, ranges)) return { ok: false as const };
      const pins = this.rangePins();
      const previous = Object.hasOwn(pins, holder) ? pins[holder] : [];
      Object.defineProperty(pins, holder, {
        value: [...new Map([...previous, ...ranges].map((range) => [`${range.from}:${range.to}`, range])).values()],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const revision = this.writeRangePins(pins, true);
      return revision === undefined
        ? { ok: false as const }
        : { ok: true as const, version: 1 as const, revision, guarded: true as const };
    });
  }

  async retainRangePinsIfRevision(expected: CustodyPinRevision, holders: readonly string[]) {
    return this.ctx.storage.transactionSync(() => {
      const proposed = custodyPinRevisionOf(expected);
      const raw = this.sourceMeta("range_pin_revision"),
        guard = this.sourceMeta("custody_pin_guard");
      const current = custodyPinRevisionOf({
        version: 1,
        revision: raw === undefined ? 0 : Number(raw),
        guarded: guard === "1",
      });
      if (
        !proposed ||
        !current ||
        (guard !== undefined && guard !== "1") ||
        (guard !== undefined && raw === undefined) ||
        (raw !== undefined && String(current.revision) !== raw) ||
        !Array.isArray(holders) ||
        !holders.every((holder) => typeof holder === "string" && holder.length > 0)
      )
        return { ok: false as const, reason: "unreadable" as const };
      if (proposed.revision !== current.revision || proposed.guarded !== current.guarded)
        return { ok: false as const, reason: "revision-changed" as const, ...current };
      const pins = this.rangePins(),
        allowed = new Set(holders);
      for (const holder of Object.keys(pins)) if (!allowed.has(holder)) delete pins[holder];
      const revision = this.writeRangePins(pins);
      return revision === undefined
        ? { ok: false as const, reason: "unreadable" as const }
        : { ok: true as const, version: 1 as const, revision, guarded: current.guarded };
    });
  }

  async protectRanges(holder: string, ranges: readonly SessionRangePin[]): Promise<{ ok: boolean }> {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec<{ idx: number; part: number; json: string; trimmed: number }>(
          `SELECT idx, part, json, trimmed FROM turns`,
        )
        .toArray();
      if (!sessionRangesAvailable(rows, ranges)) return { ok: false };
      const pins = this.rangePins();
      pins[holder] = [
        ...new Map([...(pins[holder] ?? []), ...ranges].map((range) => [`${range.from}:${range.to}`, range])).values(),
      ];
      return { ok: this.writeRangePins(pins) !== undefined };
    });
  }

  async retainRangePins(holders: readonly string[]) {
    return this.ctx.storage.transactionSync(() => {
      if (this.sourceMeta("custody_pin_guard") !== undefined)
        return { ok: false as const, reason: "custody-protected" as const };
      const pins = this.rangePins();
      const allowed = new Set(holders);
      for (const holder of Object.keys(pins)) if (!allowed.has(holder)) delete pins[holder];
      return { ok: this.writeRangePins(pins) !== undefined };
    });
  }

  private owner(): { runId: string; gen: string } | undefined {
    const row = this.sql
      .exec<{ run_id: string; gen: string }>(`SELECT run_id, gen FROM owner WHERE k = 1`)
      .toArray()[0];
    return row ? { runId: row.run_id, gen: row.gen } : undefined;
  }

  /** The owner releases the log at its finish so a zombie of a finished run is
   *  refused rather than appending to a session it no longer drives; only the
   *  owner may. The rows stay. */
  async clearOwner(runId: string, gen: string): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const pending = this.sourceSeedPending();
      if (pending) throw new SourceSeedPendingError(pending.key, pending.runId);
      const owner = this.owner();
      if (!owner) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner.runId !== runId || owner.gen !== gen) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(`DELETE FROM owner`);
    });
    return out;
  }

  /** One row into the table and the index. A row already at `(idx, part)` — a
   *  zombie's late write the new generation overwrites — has its index entry
   *  deleted first, then goes; the new row is inserted with its own id and
   *  indexed. */
  private putRow(row: TranscriptRow, json: string, trimmed: boolean): void {
    const existing = this.sql
      .exec<{ id: number; text: string }>(`SELECT id, text FROM turns WHERE idx = ? AND part = ?`, row.idx, row.part)
      .toArray()[0];
    if (existing) {
      this.sql.exec(
        `INSERT INTO turns_fts (turns_fts, rowid, text) VALUES ('delete', ?, ?)`,
        existing.id,
        existing.text,
      );
      this.sql.exec(`DELETE FROM turns WHERE id = ?`, existing.id);
    }
    if (storedRowRequiresFreshSources(json)) this.setSourceMeta("requires_fresh_sources", "true");
    const text = textOfStoredRow(json);
    this.sql.exec(
      `INSERT INTO turns (idx, part, kind, bytes, trimmed, json, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.idx,
      row.part,
      rowKind(json),
      utf8ByteLength(json),
      trimmed ? 1 : 0,
      json,
      text,
    );
    const id = this.sql.exec<{ id: number }>(`SELECT last_insert_rowid() AS id`).one().id;
    this.sql.exec(`INSERT INTO turns_fts (rowid, text) VALUES (?, ?)`, id, text);
  }

  /** The idempotent keyed append (session-log item 13): the parts of ONE turn
   *  land at the tail under `rowId` — a fold of a `ship_unit` event, a
   *  connector's turn, a migrated row. A row id the log has seen appends
   *  nothing, so a fold read twice yields one row; two appends keep their
   *  arrival order, since each lands at the tail inside one transaction. No
   *  owner fence: a thread session has no one owning run. */
  async appendKeyed(
    rowId: string,
    rows: Array<{ part: number; json: string }>,
    context?: ContextDependencies,
    checkpoints: readonly CanonicalCheckpointSource[] = [],
  ): Promise<{ ok: boolean; appended: boolean }> {
    if (!keyedAppendContextMatches(rows, context)) return { ok: false, appended: false };
    const hash = await sourceHash({ rows, context: context ?? UNKNOWN_CONTEXT_DEPENDENCIES });
    let appended = false;
    let ok = true;
    this.ctx.storage.transactionSync(() => {
      const seen = this.sql
        .exec<{ row_hash: string | null }>(`SELECT row_hash FROM turns WHERE row_id = ? LIMIT 1`, rowId)
        .toArray()[0];
      if (seen) {
        // A historical row without a hash has no immutable replay proof.
        ok = seen.row_hash === hash;
        return;
      }
      const pending = this.sourceSeedPending();
      if (pending) throw new SourceSeedPendingError(pending.key, pending.runId);
      const idx = this.next();
      const previous = this.sources();
      for (const checkpoint of checkpoints)
        if (previous?.context) previous.context = applyContextCheckpointAliases(previous.context, checkpoint);
      const merged = appendSessionContext(previous, context, idx === 0);
      for (const checkpoint of checkpoints)
        if (merged.context) merged.context = applyContextCheckpointAliases(merged.context, checkpoint);
      this.setSourceMeta("sources", JSON.stringify(merged));
      for (const [i, r] of rows.entries()) {
        this.putRow({ idx, part: r.part, json: r.json }, r.json, false);
        if (i === 0)
          this.sql.exec(
            `UPDATE turns SET row_id = ?, row_hash = ? WHERE idx = ? AND part = ?`,
            rowId,
            hash,
            idx,
            r.part,
          );
      }
      appended = true;
      this.enforceBytePolicy();
    });
    return { ok, appended };
  }

  async write(
    gen: string,
    rows: TranscriptRow[],
    attachments: TranscriptAttachment[],
    sourceUpdate?: { runId: string; sources: SessionSources },
    runId?: string,
    seed = false,
  ): Promise<FenceResult & { bytes?: number; sourcesSaved?: true }> {
    const frozen = structuredClone({ rows, attachments, sourceUpdate });
    rows = frozen.rows;
    attachments = frozen.attachments;
    sourceUpdate = frozen.sourceUpdate;
    const verified = await verifiedSourceResults(rows);
    let out: FenceResult & { bytes?: number; sourcesSaved?: true } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const pending = this.sourceSeedPending();
      if (pending) {
        const owner = this.owner();
        const unchanged =
          owner?.runId === (sourceUpdate?.runId ?? runId) &&
          owner?.gen === gen &&
          rows.every(
            (r) =>
              this.sql
                .exec<{ json: string }>("SELECT json FROM turns WHERE idx=? AND part=?", r.idx, r.part)
                .toArray()[0]?.json === r.json,
          ) &&
          attachments.every((a) => {
            const old = this.sql
              .exec<{ media_type: string; data: string }>("SELECT media_type,data FROM attachments WHERE ref=?", a.ref)
              .toArray()[0];
            return old?.data === a.data && old.media_type === a.mediaType;
          }) &&
          (!sourceUpdate || canonicalSeedJson(sourceUpdate.sources) === canonicalSeedJson(this.sources()));
        if (unchanged) {
          out = { ok: true, ...(sourceUpdate ? { sourcesSaved: true as const } : {}) };
          return;
        }
        throw new SourceSeedPendingError(pending.key, pending.runId);
      }
      const owner = this.owner();
      if (owner === undefined) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (
        owner.gen !== gen ||
        (!sourceUpdate && (this.sourceMeta("sources") || runId !== undefined) && owner.runId !== runId)
      ) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      if (sourceUpdate) {
        if (owner.runId !== sourceUpdate.runId) {
          out = { ok: false, reason: "fenced" };
          return;
        }
        const pending = this.sourceMeta("source_pending_owner");
        const previous =
          pending && pending !== `${owner.runId}:${gen}` ? taintSessionSources(this.sources()) : this.sources();
        const start = this.sql
          .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'source_start'`)
          .toArray()[0]?.value;
        const sources = mergeSessionSources(previous, sourceUpdate.sources, start === "0");
        this.sql.exec(
          `INSERT INTO meta (key, value) VALUES ('sources', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify(sources),
        );
        if (JSON.stringify(sources) !== JSON.stringify(sourceUpdate.sources)) {
          out = { ok: false, reason: "fenced" };
          return;
        }
      }
      if (sourceUpdate) {
        this.setSourceMeta("source_owner", `${owner.runId}:${gen}`);
        this.sql.exec(`DELETE FROM meta WHERE key = 'source_pending_owner'`);
      } else if (
        rows.length &&
        this.sourceMeta("sources") &&
        this.sourceMeta("source_owner") !== `${owner.runId}:${gen}`
      ) {
        // A writer that cannot attest source completeness must not inherit a prior writer's receipt.
        this.setSourceMeta("source_pending_owner", `${owner.runId}:${gen}`);
      }
      const pins = this.rangePins();
      for (const row of rows) {
        if (!sessionRowIsPinned(pins, row.idx)) continue;
        const original = this.sql
          .exec<{ json: string }>(`SELECT json FROM turns WHERE idx = ? AND part = ?`, row.idx, row.part)
          .toArray()[0];
        if (original?.json !== row.json) {
          out = { ok: false, reason: "fenced" };
          return;
        }
      }
      for (const attachment of attachments) {
        const original = this.sql
          .exec<{ media_type: string; data: string }>(
            `SELECT media_type, data FROM attachments WHERE ref = ?`,
            attachment.ref,
          )
          .toArray()[0];
        if (
          original &&
          (original.data !== attachment.data || original.media_type !== attachment.mediaType) &&
          this.sql
            .exec<{ idx: number; json: string }>(`SELECT idx, json FROM turns`)
            .toArray()
            .some((row) => sessionRowIsPinned(pins, row.idx) && attachmentRefsOf(row.json).includes(attachment.ref))
        ) {
          out = { ok: false, reason: "fenced" };
          return;
        }
      }
      for (const a of attachments) {
        this.sql.exec(
          `INSERT OR REPLACE INTO attachments (ref, media_type, data, bytes) VALUES (?, ?, ?, ?)`,
          a.ref,
          a.mediaType,
          a.data,
          utf8ByteLength(a.data),
        );
      }
      const tracked = this.sources();
      if (tracked?.context && rows.some((r) => rowKind(r.json) === "tool_result")) {
        const indices = [...new Set(rows.map((r) => r.idx))];
        const old = this.sql
          .exec<{ idx: number; part: number; json: string }>(
            `SELECT idx, part, json FROM turns WHERE kind = 'tool_use' OR idx IN (SELECT value FROM json_each(?)) ORDER BY idx, part`,
            JSON.stringify(indices),
          )
          .toArray();
        if (uncoveredSourceResult(old, rows, tracked.context, seed ? undefined : owner.runId, verified))
          this.setSourceMeta("sources", JSON.stringify(taintSessionSources(tracked)));
      }
      if (sourceUpdate && JSON.stringify(this.sources()) !== JSON.stringify(sourceUpdate.sources)) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      for (const r of rows) this.putRow(r, r.json, false);
      out = { ok: true, bytes: this.enforceBytePolicy(), ...(sourceUpdate ? { sourcesSaved: true as const } : {}) };
    });
    return out;
  }

  private totalBytes(): number {
    return (
      this.sql.exec<{ b: number }>(`SELECT COALESCE(SUM(bytes), 0) AS b FROM turns`).one().b +
      this.sql.exec<{ b: number }>(`SELECT COALESCE(SUM(bytes), 0) AS b FROM attachments`).one().b
    );
  }

  /** Whether any row other than `exceptId` references the attachment `ref`.
   *  Rows carry references inside their JSON, so the check is a substring
   *  match on the quoted field; refs are `t<idx>p<part>`, and the closing quote
   *  keeps `t1p0` from matching `t1p01`. */
  private referencedElsewhere(ref: string, exceptId: number): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM turns WHERE id != ? AND INSTR(json, ?) > 0 LIMIT 1`, exceptId, `"dataRef":"${ref}"`)
        .toArray().length > 0
    );
  }

  /** The bytes a trimmed row would free beyond its own: the attachments only
   *  it references (session-log item 5). */
  private soleAttachmentBytes(row: { id: number; json: string }): number {
    let bytes = 0;
    for (const ref of attachmentRefsOf(row.json)) {
      if (this.referencedElsewhere(ref, row.id)) continue;
      bytes +=
        this.sql.exec<{ bytes: number }>(`SELECT bytes FROM attachments WHERE ref = ?`, ref).toArray()[0]?.bytes ?? 0;
    }
    return bytes;
  }

  /** The byte policy (session-log item 5): over the budget, the oldest tool
   *  results are replaced by a marker, oldest first, each taking with it the
   *  attachments no remaining row references, until the log fits or none is
   *  left; user and assistant text is never dropped, nor an attachment a kept
   *  row still shows. Each pass plans on an estimate of the marker's size and
   *  re-measures, so a pass is never short by more than the estimate's error
   *  and the loop ends when the candidates do. Returns the total after. */
  private enforceBytePolicy(): number {
    const max = Number(
      this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'max_bytes'`).toArray()[0]?.value ??
        DEFAULT_SESSION_LOG_MAX_BYTES,
    );
    let total = this.totalBytes();
    while (total > max) {
      const candidates = this.sql
        .exec<{ id: number; idx: number; bytes: number; json: string }>(
          `SELECT id, idx, bytes, json FROM turns WHERE kind = 'tool_result' AND trimmed = 0 ORDER BY idx ASC, part ASC`,
        )
        .toArray()
        .filter((c) => !sessionRowIsPinned(this.rangePins(), c.idx))
        .map((c) => ({ id: c.id, bytes: c.bytes + this.soleAttachmentBytes(c) }));
      const ids = planSessionTrim(candidates, total - max, TRIM_MARKER_BYTES_ESTIMATE);
      if (ids.length === 0) break;
      for (const id of ids) {
        const row = this.sql
          .exec<SessionTurnRow & { row_id: string | null; row_hash: string | null }>(
            `SELECT id, idx, part, json, text, row_id, row_hash FROM turns WHERE id = ?`,
            id,
          )
          .toArray()[0];
        if (!row) continue;
        const marker = droppedToolResultRow(row.json);
        if (marker === undefined) {
          // Not replaceable after all: mark it so the loop never picks it again.
          this.sql.exec(`UPDATE turns SET trimmed = 1 WHERE id = ?`, id);
          continue;
        }
        const refs = attachmentRefsOf(row.json);
        this.putRow({ idx: row.idx, part: row.part, json: marker }, marker, true);
        // The marker keeps the row's keyed-append id (item 13): `putRow` deletes
        // the old row, so without this the partial unique index forgets the id
        // and a replayed migration or fold would re-append the trimmed turn.
        if (row.row_id !== null)
          this.sql.exec(
            `UPDATE turns SET row_id = ?, row_hash = ? WHERE idx = ? AND part = ?`,
            row.row_id,
            row.row_hash,
            row.idx,
            row.part,
          );
        // The marker references nothing, so an attachment only this row showed is now orphaned.
        for (const ref of refs) {
          if (!this.referencedElsewhere(ref, -1)) this.sql.exec(`DELETE FROM attachments WHERE ref = ?`, ref);
        }
      }
      total = this.totalBytes();
    }
    return total;
  }

  /** Every attachment the log holds, by reference. */
  async attachmentRefs(): Promise<string[]> {
    return this.sql
      .exec<{ ref: string }>(`SELECT ref FROM attachments ORDER BY ref`)
      .toArray()
      .map((r) => r.ref);
  }

  /** Read frozen keyed parts, never replacement bytes from a trimmed row. */
  async readEntry(rowId: string): Promise<TranscriptRow[] | undefined> {
    const seen = this.sql.exec<{ idx: number }>(`SELECT idx FROM turns WHERE row_id = ? LIMIT 1`, rowId).toArray()[0];
    if (!seen) return undefined;
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string; trimmed: number }>(
        `SELECT idx, part, json, trimmed FROM turns WHERE idx = ? ORDER BY part`,
        seen.idx,
      )
      .toArray();
    if (!rows.length || rows.some((row) => row.trimmed === 1)) return undefined;
    return rows.map(({ idx, part, json }) => ({ idx, part, json }));
  }

  /** The rows from `from` to `to` (inclusive; the tail when `to` is absent), in
   *  (idx, part) order, with the attachments those rows reference. */
  async read(from: number, to?: number): Promise<{ rows: TranscriptRow[]; attachments: TranscriptAttachment[] }> {
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string }>(
        `SELECT idx, part, json FROM turns WHERE idx >= ? AND idx <= ? ORDER BY idx, part`,
        from,
        to ?? Number.MAX_SAFE_INTEGER,
      )
      .toArray();
    return { rows, attachments: this.attachmentsOf(rows) };
  }

  private attachmentsOf(rows: readonly TranscriptRow[]): TranscriptAttachment[] {
    const refs = [...new Set(rows.flatMap((r) => attachmentRefsOf(r.json)))];
    if (refs.length === 0) return [];
    const out: TranscriptAttachment[] = [];
    for (let i = 0; i < refs.length; i += DO_MAX_BOUND_PARAMETERS) {
      const batch = refs.slice(i, i + DO_MAX_BOUND_PARAMETERS);
      out.push(
        ...this.sql
          .exec<{ ref: string; media_type: string; data: string }>(
            `SELECT ref, media_type, data FROM attachments WHERE ref IN (${batch.map(() => "?").join(",")}) ORDER BY ref`,
            ...batch,
          )
          .toArray()
          .map((a) => ({ ref: a.ref, mediaType: a.media_type, data: a.data })),
      );
    }
    return out;
  }

  private sourceMeta(key: string): string | undefined {
    return this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]?.value;
  }

  private setSourceMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private sources(): SessionSources | undefined {
    const value = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'sources'`).toArray()[0]?.value;
    if (value === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return isSessionSources(parsed) ? parsed : { version: 1, status: "unknown" };
    } catch {
      return { version: 1, status: "unknown" };
    }
  }

  /** The tail a follow-up seeds from (session-log item 4): the newest whole
   *  turns within `maxBytes`, answered oldest first with the first index they
   *  start at; when even the newest turn is over the budget, no rows and the
   *  tail index. */
  async readTail(maxBytes: number): Promise<{
    rows: TranscriptRow[];
    attachments: TranscriptAttachment[];
    from: number;
    sources?: SessionSources;
    requiresFreshSources?: true;
  }> {
    const newestFirst = this.sql
      .exec<{ idx: number; bytes: number }>(`SELECT idx, bytes FROM turns ORDER BY idx DESC, part DESC`)
      .toArray();
    const from = tailCut(newestFirst, maxBytes);
    const sources = this.sourceMeta("source_pending_owner") ? taintSessionSources(this.sources()) : this.sources();
    const replay = this.sourceMeta("requires_fresh_sources") === "true" ? { requiresFreshSources: true as const } : {};
    if (from === undefined)
      return { rows: [], attachments: [], from: this.next(), ...(sources ? { sources } : {}), ...replay };
    return { ...(await this.read(from)), from, ...(sources ? { sources } : {}), ...replay };
  }

  /** The rows whose text matches `query`, in relevance order (FTS5's bm25 rank,
   *  the order the memory store's search uses; the newest first among equals),
   *  each with its turn, part, role, kind and indexed text — what `recall`
   *  answers (session-log item 10). */
  async search(query: string, limit: number): Promise<SessionHit[]> {
    const match = ftsMatchExpr(query);
    if (match === null) return [];
    return this.sql
      .exec<{ idx: number; part: number; kind: string; json: string; text: string }>(
        `SELECT t.idx, t.part, t.kind, t.json, t.text FROM turns_fts f JOIN turns t ON t.id = f.rowid
          WHERE turns_fts MATCH ? ORDER BY f.rank, t.idx DESC, t.part DESC LIMIT ?`,
        match,
        limit,
      )
      .toArray()
      .map(({ idx, part, kind, json, text }) => {
        const role = roleOfStoredRow(json);
        return { idx, part, ...(role !== undefined ? { role } : {}), kind, text };
      });
  }

  /** The gap markers (session-log item 9) whose turn lies in `[from, to]`: the
   *  rows a follow-up appended because the run before it detached, so a search
   *  whose hits straddle one can say the log ends short between them. */
  async gapsBetween(from: number, to: number): Promise<number[]> {
    return this.sql
      .exec<{ idx: number }>(
        `SELECT DISTINCT idx FROM turns WHERE idx >= ? AND idx <= ? AND kind = 'text' AND text = ? ORDER BY idx`,
        from,
        to,
        GAP_MARKER,
      )
      .toArray()
      .map((r) => r.idx);
  }

  async requesterTarget(actor: string): Promise<RequesterTarget | null> {
    const row = this.sql
      .exec<{ repo: string; issue: string | null; provenance: string; conflict: number }>(
        `SELECT repo, issue, provenance, conflict FROM requester_target WHERE actor = ?`,
        actor,
      )
      .toArray()[0];
    return row
      ? {
          repo: row.repo,
          ...(row.issue ? { issue: row.issue } : {}),
          provenance: row.provenance,
          ...(row.conflict ? { conflict: true } : {}),
        }
      : null;
  }

  async checkpointRequesterTarget(actor: string, target: RequesterTarget): Promise<RequesterTarget> {
    let merged: RequesterTarget = target;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ repo: string; issue: string | null; provenance: string; conflict: number }>(
          `SELECT repo, issue, provenance, conflict FROM requester_target WHERE actor = ?`,
          actor,
        )
        .toArray()[0];
      const prior: RequesterTarget | null = row
        ? {
            repo: row.repo,
            ...(row.issue ? { issue: row.issue } : {}),
            provenance: row.provenance,
            ...(row.conflict ? { conflict: true as const } : {}),
          }
        : null;
      merged = mergeRequesterTarget(prior, target);
      this.sql.exec(
        `INSERT INTO requester_target (actor, repo, issue, provenance, conflict) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actor) DO UPDATE SET repo = excluded.repo, issue = excluded.issue, provenance = excluded.provenance, conflict = excluded.conflict`,
        actor,
        merged.repo,
        merged.issue ?? null,
        merged.provenance,
        merged.conflict ? 1 : 0,
      );
    });
    return merged;
  }

  /** The notepad, replaced whole by the live run (session-log item 10): the
   *  same fence as a row write — unknown-run before an owner, fenced for
   *  another generation — and the write's time kept beside the text. */
  async writeNotepad(gen: string, text: string, now: number, runId?: string): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const pending = this.sourceSeedPending();
      if (pending) {
        if (
          pending.runId === runId &&
          pending.gen === gen &&
          this.sql.exec<{ text: string }>("SELECT text FROM notepad WHERE k=1").toArray()[0]?.text === text
        )
          return;
        throw new SourceSeedPendingError(pending.key, pending.runId);
      }
      const owner = this.owner();
      if (owner === undefined) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner.gen !== gen || ((this.sourceMeta("sources") || runId !== undefined) && owner.runId !== runId)) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(
        `INSERT INTO notepad (k, text, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(k) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        text,
        now,
      );
    });
    return out;
  }

  async bytes(): Promise<number> {
    return this.totalBytes();
  }

  async rowCount(): Promise<number> {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM turns`).one().n;
  }

  async notepad(): Promise<{ text: string; updatedAt: number } | null> {
    const row = this.sql
      .exec<{ text: string; updated_at: number }>(`SELECT text, updated_at FROM notepad WHERE k = 1`)
      .toArray()[0];
    return row ? { text: row.text, updatedAt: row.updated_at } : null;
  }

  /** The sweep's drop (session-log item 7): the owner first, so a write that
   *  races the drop is refused rather than landing on a log about to go, then
   *  every row, index entry, attachment, the notepad and the budget. */
  async drop(): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      const pending = this.storedSourceSeedReceipt();
      if (pending) throw new SourceSeedPendingError(pending.key, pending.runId);
      this.sql.exec(`DELETE FROM owner`);
      this.sql.exec(`INSERT INTO turns_fts (turns_fts) VALUES ('delete-all')`);
      this.sql.exec(`DELETE FROM turns`);
      this.sql.exec(`DELETE FROM attachments`);
      this.sql.exec(`DELETE FROM notepad`);
      this.sql.exec(`DELETE FROM requester_target`);
      this.sql.exec(`DELETE FROM meta`);
    });
    return { ok: true };
  }
}

const LEDGER_ROUTES = new Set([
  "/runs/context-checkpoint",
  "/runs/session/checkpoint",
  "/runs/private-worker/append",
  "/runs/private-worker/list",
  "/runs/private-worker/list-after",
  "/runs/coordinator/put",
  "/runs/coordinator/replace",
  "/runs/coordinator/admission/confirm",
  "/runs/coordinator/main-task/get",
  "/runs/coordinator/main-task/claim",
  "/runs/coordinator/requester-turn/record",
  "/runs/coordinator/requester-turn/latest",
  "/runs/coordinator/get",
  "/runs/coordinator/stop",
  "/runs/coordinator/units/put",
  "/runs/coordinator/units/claim-legacy-continuation",
  "/runs/coordinator/units/adoption-audit",
  "/runs/coordinator/recovery/transition",
  "/runs/coordinator/units/effect-transition",
  "/runs/coordinator/maintenance/admit",
  "/runs/coordinator/recovery/action",
  "/runs/coordinator/recovery/history",
  "/runs/coordinator/units/list-active-recoveries",
  "/runs/coordinator/pull-owners",
  "/runs/coordinator/units/list",
  "/runs/coordinator/reconcile/offer",
  "/runs/coordinator/events/append",
  "/runs/coordinator/events/list",
  "/runs/coordinator/events/mark-consumed",
  "/runs/coordinator/wake",
  "/runs/decision-record/reserve",
  "/runs/claim",
  "/runs/promotion/prepare",
  "/runs/promotion/read",
  "/runs/resident-claim",
  "/runs/heartbeat",
  "/runs/append",
  "/runs/live-state",
  "/runs/step",
  "/runs/state",
  "/runs/inbox",
  "/runs/inbox/read",
  "/runs/stop",
  "/runs/handoff",
  "/runs/finishing",
  "/runs/finish",
  "/runs/abandon",
  "/runs/reclaim",
  "/runs/live",
  "/runs/preservation-owner",
  "/runs/workspace-disposition",
  "/runs/workspace-ack",
  "/runs/live-events",
  "/runs/intake",
  "/runs/intake/read",
  "/runs/intake/delivery/claim",
  "/runs/intake/delivery/finish",
  "/runs/intake/list",
  "/runs/transcript/owner",
  "/runs/transcript/write",
  "/runs/transcript/read",
  "/runs/transcript/clear",
  "/runs/session/expected-seed/verify",
  "/runs/session/expected-seed/read",
  "/runs/session/tail",
  "/runs/session/owner",
  "/runs/session/write",
  "/runs/session/append",
  "/runs/session/read",
  "/runs/session/entry",
  "/runs/session/read-tail",
  "/runs/session/clear-owner",
  "/runs/session/search",
  "/runs/session/requester-target",
  "/runs/session/requester-target/write",
  "/runs/session/notepad",
  "/runs/session/notepad/write",
]);

/** The plane's routes (record 0064; orchestration-plane items 7 and 8):
 *  outcomes, effect delivery fencing and acknowledgements land on the ledger
 *  object of the given store key, like every `/runs/*` route. */
const PLANE_ROUTES = new Set([
  "/plane/outcome",
  "/plane/ack",
  "/plane/steer/fence",
  "/plane/admit",
  "/plane/withdraw",
  "/plane/deploy",
  "/plane/queued",
  "/plane/level",
  "/plane/observe",
  "/plane/park",
  "/plane/reclaimed",
]);

const PLANE_RECLAIM_WORDS = new Set(["resume", "restart", "rehost", "closed"]);

const PLANE_LEVEL_NAMES = new Set(["seat", "memory", "drain"]);
const PLANE_LEVEL_SIDES = new Set(["below", "above"]);

const PLANE_STAGES = new Set(["admission", "runner", "resident"]);
const PLANE_OUTCOME = /^(proceeded|refused:[a-z0-9-]+|fell_cold:[a-z0-9_-]+)$/;
const PLANE_ACK_OUTCOMES = new Set(["done", "skipped", "deferred"]);

/** The `/plane/*` routes: validated before any object call, ids and words
 *  only on the log lines. */
async function handlePlane(pathname: string, body: unknown, env: Env): Promise<Response> {
  if (typeof body !== "object" || body === null) return json({ error: "body must be a JSON object" }, 400);
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return json({ error: key.error }, 400);
  const stub = env.RUNS.get(env.RUNS.idFromName(key.value));
  const now = systemClock();
  if (pathname === "/plane/outcome") {
    if (typeof b.threadKey !== "string" || b.threadKey.length === 0)
      return json({ error: "threadKey must be a non-empty string" }, 400);
    if (typeof b.requester !== "string" || b.requester.length === 0)
      return json({ error: "requester must be a non-empty string" }, 400);
    if (typeof b.stage !== "string" || !PLANE_STAGES.has(b.stage))
      return json({ error: "stage must be admission, runner or resident" }, 400);
    if (typeof b.outcome !== "string" || !PLANE_OUTCOME.test(b.outcome))
      return json({ error: "outcome must be proceeded, refused:<code> or fell_cold:<token>" }, 400);
    let runId: string | undefined;
    if (b.runId !== undefined) {
      const parsed = parseRunId(b.runId);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      runId = parsed.value;
    }
    const r = await stub.planeOutcome(
      {
        ...(runId !== undefined ? { runId } : {}),
        requester: b.requester,
        threadKey: b.threadKey,
        stage: b.stage as PlaneStage,
        outcome: b.outcome,
      },
      now,
    );
    return json(r);
  }
  if (pathname === "/plane/steer/fence") {
    if (typeof b.id !== "string" || b.id.length === 0) return json({ error: "id must be a non-empty string" }, 400);
    const runId = parseRunId(b.runId);
    if (!runId.ok) return json({ error: runId.error }, 400);
    const g = gen(b.gen);
    if (!g.ok) return json({ error: g.error }, 400);
    const lease = parseLeaseMs(b.leaseMs);
    if (!lease.ok) return json({ error: lease.error }, 400);
    return json(await stub.planeFenceSteer(b.id, runId.value, g.value, lease.value, now));
  }
  if (pathname === "/plane/ack") {
    if (typeof b.id !== "string" || b.id.length === 0) return json({ error: "id must be a non-empty string" }, 400);
    if (typeof b.outcome !== "string" || !PLANE_ACK_OUTCOMES.has(b.outcome))
      return json({ error: "outcome must be done, skipped or deferred" }, 400);
    let owner: { runId: string; gen: string } | undefined;
    if (b.owner !== undefined) {
      if (typeof b.owner !== "object" || b.owner === null || Array.isArray(b.owner))
        return json({ error: "owner must name a runId and generation" }, 400);
      const rawOwner = b.owner as Record<string, unknown>;
      const runId = parseRunId(rawOwner.runId);
      if (!runId.ok) return json({ error: runId.error }, 400);
      if (typeof rawOwner.gen !== "string" || rawOwner.gen.length === 0)
        return json({ error: "owner generation must be a non-empty string" }, 400);
      owner = { runId: runId.value, gen: rawOwner.gen };
    }
    if (b.reconciliation !== undefined) {
      if (!isCoordinatorReconcileReceipt(b.reconciliation) || b.outcome !== "done")
        return json({ error: "invalid reconciliation acknowledgement" }, 400);
      const result = await stub.ackCoordinatorReconciliation(b.id, b.reconciliation, now);
      return json(result, result.ok ? 200 : 409);
    }
    return json(await stub.planeAck(b.id, b.outcome as PlaneAckOutcome, now, owner));
  }
  if (pathname === "/plane/admit") {
    // The admission-stage ask (record 0064, "The queue"): the thread key, the
    // requester and the request in the durable inbox's shape. The route mints
    // the run id: `queued` stores the request under it, `admitted` names it as
    // the reservation.
    if (typeof b.threadKey !== "string" || b.threadKey.length === 0)
      return json({ error: "threadKey must be a non-empty string" }, 400);
    if (typeof b.requester !== "string" || b.requester.length === 0)
      return json({ error: "requester must be a non-empty string" }, 400);
    if (typeof b.request !== "object" || b.request === null || Array.isArray(b.request))
      return json({ error: "request must be a JSON object" }, 400);
    if (b.stage !== undefined && (typeof b.stage !== "string" || !PLANE_STAGES.has(b.stage)))
      return json({ error: "stage must be admission, runner or resident" }, 400);
    if (b.resident !== undefined && (typeof b.resident !== "string" || b.resident.length === 0))
      return json({ error: "resident must be a non-empty string" }, 400);
    if (b.restartOf !== undefined && typeof b.restartOf !== "boolean")
      return json({ error: "restartOf must be a boolean" }, 400);
    if (b.reaskMs !== undefined && (typeof b.reaskMs !== "number" || !(b.reaskMs > 0)))
      return json({ error: "reaskMs must be a positive number of milliseconds" }, 400);
    try {
      const answer = await stub.planeAdmit(
        {
          runId: crypto.randomUUID(),
          requester: b.requester,
          threadKey: b.threadKey,
          request: b.request as Record<string, unknown>,
          ...(b.stage !== undefined ? { stage: b.stage as PlaneStage } : {}),
          ...(b.resident !== undefined ? { resident: b.resident } : {}),
          ...(b.restartOf !== undefined ? { restartOf: b.restartOf } : {}),
          ...(b.reaskMs !== undefined ? { reaskMs: b.reaskMs } : {}),
        },
        now,
      );
      return json(answer);
    } catch (err) {
      // The effect caps refuse by name (record 0064): the ask is answered with
      // the cap's own sentence, never queued silently.
      return json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }
  if (pathname === "/plane/level") {
    // The model proxy's provider level (record 0064): `up` on a relayed
    // success, `down` on a failure past its one retry.
    if (b.name === "provider") {
      if (typeof b.provider !== "string" || b.provider.length === 0)
        return json({ error: "provider must be a non-empty string" }, 400);
      if (b.side !== "up" && b.side !== "down") return json({ error: "side must be up or down" }, 400);
      if (
        b.cause !== undefined &&
        (typeof b.cause !== "string" || !(PROVIDER_FAILURE_CAUSES as readonly string[]).includes(b.cause))
      )
        return json({ error: `cause must be one of ${PROVIDER_FAILURE_CAUSES.join(", ")}` }, 400);
      return json(
        await stub.planeLevel(
          {
            provider: b.provider,
            name: "provider",
            side: b.side,
            ...(b.side === "down" && typeof b.cause === "string" ? { cause: b.cause as ProviderFailureCause } : {}),
          },
          now,
        ),
      );
    }
    // A resident's level report (record 0064): forwarded by the bot from the levels a
    // resident answer carried, or from the registry's drain outbox.
    if (typeof b.resident !== "string" || b.resident.length === 0)
      return json({ error: "resident must be a non-empty string" }, 400);
    if (typeof b.name !== "string" || !PLANE_LEVEL_NAMES.has(b.name))
      return json({ error: "name must be seat, memory or drain" }, 400);
    if (typeof b.side !== "string" || !PLANE_LEVEL_SIDES.has(b.side))
      return json({ error: "side must be below or above" }, 400);
    if (typeof b.generation !== "string") return json({ error: "generation must be a string" }, 400);
    return json(
      await stub.planeLevel(
        {
          resident: b.resident,
          name: b.name as "seat" | "memory" | "drain",
          side: b.side as "below" | "above",
          generation: b.generation,
        },
        now,
      ),
    );
  }
  if (pathname === "/plane/observe") {
    // A refusal-by-name met at attach or exec (record 0064).
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    if (typeof b.resident !== "string" || b.resident.length === 0)
      return json({ error: "resident must be a non-empty string" }, 400);
    if (typeof b.refusal !== "string" || b.refusal.length === 0)
      return json({ error: "refusal must be a non-empty string" }, 400);
    return json(await stub.planeObserve({ runId: parsed.value, resident: b.resident, refusal: b.refusal }, now));
  }
  if (pathname === "/plane/park") {
    // A run parked on its provider (record 0064).
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    if (typeof b.provider !== "string" || b.provider.length === 0)
      return json({ error: "provider must be a non-empty string" }, 400);
    return json(await stub.planePark(parsed.value, b.provider, now));
  }
  if (pathname === "/plane/withdraw") {
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    return json(await stub.planeWithdraw(parsed.value, now));
  }
  if (pathname === "/plane/reclaimed") {
    // The reclaim's outcome per row (record 0064; run-history item 36): only
    // `closed` records an ending; the standing causes are answered back.
    if (!Array.isArray(b.outcomes)) return json({ error: "outcomes must be an array" }, 400);
    const outcomes: { runId: string; outcome: PlaneReclaimWord }[] = [];
    for (const o of b.outcomes as unknown[]) {
      const row = o as Record<string, unknown>;
      const parsed = parseRunId(row?.runId);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      if (typeof row.outcome !== "string" || !PLANE_RECLAIM_WORDS.has(row.outcome))
        return json({ error: "outcome must be resume, restart, rehost or closed" }, 400);
      outcomes.push({ runId: parsed.value, outcome: row.outcome as PlaneReclaimWord });
    }
    return json(await stub.planeReclaimed(outcomes, now));
  }
  if (pathname === "/plane/queued") {
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    return json({ row: await stub.planeQueueRowOf(parsed.value) });
  }
  if (pathname === "/plane/deploy") {
    // The deploy runner's post (record 0064, "The queue"): `landed` lifts the
    // pending-deploy window — `deploy_settled` flips and the queue walks;
    // `pending` opens it. Version and workers ride the log line only.
    if (b.phase !== "landed" && b.phase !== "pending") return json({ error: "phase must be landed or pending" }, 400);
    try {
      const r = await stub.planeWindow("deploy", b.phase === "landed" ? "lifted" : "opened", now);
      console.log(
        `[plane/deploy] ${b.phase}${typeof b.version === "string" ? ` ${b.version}` : ""} — ${r.admitted} admission(s)`,
      );
      return json({ ok: true, admitted: r.admitted });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }
  return json({ error: "not found" }, 404);
}

/** Routes whose bodies may carry a record, a transcript chunk, or an event batch. */
const WIDE_BODY_ROUTES = new Set([
  "/runs/put",
  "/runs/finish",
  "/runs/append",
  "/runs/transcript/write",
  "/runs/session/write",
  "/runs/session/append",
]);
/** A delivery snapshot written whole, or a refresh's patch: every merged pull request's reviews and
 *  its branch's workflow runs — about 7 KB a pull request (measured: 291 pull requests, 2.1 MB), so
 *  a first read at the listing cap is under 6 MB and a busy repository's whole window many MB. */
const MAX_SNAPSHOT_BODY_BYTES = 16 * 1024 * 1024;

/** The request body ceiling per route, decided after routing and before the parse. */
function bodyFenceFor(pathname: string): number {
  if (WIDE_BODY_ROUTES.has(pathname)) return MAX_RUN_PUT_BODY_BYTES;
  if (pathname === "/delivery/put" || pathname === "/delivery/merge") return MAX_SNAPSHOT_BODY_BYTES;
  // A ninety-day costs snapshot is a few hundred KB today and grows with the account's rows.
  if (pathname === "/costs/snapshot/put") return MAX_SNAPSHOT_BODY_BYTES;
  return MAX_BODY_BYTES;
}

const gen = (v: unknown): Validated<string> =>
  typeof v === "string" && GEN_PATTERN.test(v)
    ? { ok: true, value: v }
    : invalid("gen must match the generation pattern");

function parseLeaseMs(v: unknown): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1_000 || v > 3_600_000) {
    return invalid("leaseMs must be an integer between 1000 and 3600000");
  }
  return { ok: true, value: v };
}

function parseClaim(b: Record<string, unknown>): Validated<ClaimRequest> {
  const run = b.run;
  if (typeof run !== "object" || run === null) return invalid("run must be an object");
  const r = run as Record<string, unknown>;
  const runId = parseRunId(r.runId);
  if (!runId.ok) return runId;
  const g = gen(r.gen);
  if (!g.ok) return g;
  const lease = parseLeaseMs(r.leaseMs);
  if (!lease.ok) return lease;
  if (typeof r.threadKey !== "string" || r.threadKey.length === 0 || r.threadKey.length > 256) {
    return invalid("run.threadKey must be a non-empty string");
  }
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt))
    return invalid("run.startedAt must be a number");
  if (typeof r.meta !== "object" || r.meta === null) return invalid("run.meta must be an object");
  // A coordinator's tag (run-history item 48) is stored at the claim and read
  // by the finish's send and the refusal a second claim meets: shaped or
  // refused, and both fields or neither — one alone is no tag.
  const meta = r.meta as Record<string, unknown>;
  if (!validMaintenanceTransport(meta))
    return invalid("run.meta maintenance transport must name its original logical owner");
  if (meta.childHandoff !== undefined && !isChildHandoff(meta.childHandoff))
    return invalid("run.meta.childHandoff must be a valid bounded handoff");
  if (meta.session !== undefined && !isRunSession(meta.session))
    return invalid("run.meta.session must name a session log and the run's range in it");
  if ((meta.parentInstanceId === undefined) !== (meta.idempotencyKey === undefined))
    return invalid("run.meta.parentInstanceId and run.meta.idempotencyKey come together or not at all");
  if (meta.parentInstanceId !== undefined) {
    if (typeof meta.parentInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(meta.parentInstanceId))
      return invalid("run.meta.parentInstanceId must be a Workflow instance id");
  }
  if (meta.idempotencyKey !== undefined) {
    if (typeof meta.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(meta.idempotencyKey))
      return invalid("run.meta.idempotencyKey must be <parentInstanceId>:<step>");
  }
  if (
    meta.costCapUsd !== undefined &&
    (meta.parentInstanceId === undefined ||
      typeof meta.costCapUsd !== "number" ||
      !Number.isFinite(meta.costCapUsd) ||
      meta.costCapUsd <= 0)
  )
    return invalid("run.meta.costCapUsd must be a positive coordinator cap");
  // The restart tag (record 0064) names the predecessor run whose windows the
  // claim reuses and rides the `child-resumed` event's reason: a run id or
  // absent, never another shape.
  if (meta.restartOf !== undefined && (typeof meta.restartOf !== "string" || !RUN_ID_PATTERN.test(meta.restartOf)))
    return invalid("run.meta.restartOf must be a run id");
  if (typeof r.system !== "string") return invalid("run.system must be a string");
  if (!Array.isArray(r.tools)) return invalid("run.tools must be an array");
  if (r.card !== undefined && r.card !== null) {
    const c = r.card as Record<string, unknown>;
    if (typeof c.channel !== "string" || typeof c.ts !== "string") return invalid("run.card must be {channel, ts}");
  }
  if (r.state !== undefined && (typeof r.state !== "object" || r.state === null))
    return invalid("run.state must be an object");
  if (r.phase !== undefined && r.phase !== "attaching" && r.phase !== "live")
    return invalid("run.phase must be attaching or live");
  return {
    ok: true,
    value: {
      runId: runId.value,
      threadKey: r.threadKey,
      gen: g.value,
      leaseMs: lease.value,
      startedAt: r.startedAt,
      meta: r.meta as ClaimRequest["meta"],
      card: (r.card as ClaimRequest["card"]) ?? null,
      system: r.system,
      tools: r.tools as ClaimRequest["tools"],
      ...(r.state ? { state: r.state as RunState } : {}),
      ...(r.phase !== undefined ? { phase: r.phase as "attaching" | "live" } : {}),
    },
  };
}

function parseStep(v: unknown): Validated<StepRecord> {
  if (typeof v !== "object" || v === null) return invalid("record must be an object");
  const s = v as Record<string, unknown>;
  for (const k of ["step", "seq", "turnIndex", "inboxConsumedSeq", "remainingMs", "turn", "iteration"] as const) {
    if (typeof s[k] !== "number" || !Number.isInteger(s[k]) || (s[k] as number) < 0) {
      return invalid(`record.${k} must be a non-negative integer`);
    }
  }
  if (
    s.inboxDeferredSeqs !== undefined &&
    (!Array.isArray(s.inboxDeferredSeqs) ||
      !s.inboxDeferredSeqs.every((seq) => typeof seq === "number" && Number.isInteger(seq) && seq > 0))
  )
    return invalid("record.inboxDeferredSeqs must be an array of positive integers");
  if (!Array.isArray(s.inFlight)) return invalid("record.inFlight must be an array");
  for (const c of s.inFlight) {
    const call = c as Record<string, unknown>;
    if (typeof call?.callId !== "string" || typeof call?.tool !== "string")
      return invalid("record.inFlight entries must be {callId, tool}");
  }
  return { ok: true, value: s as unknown as StepRecord };
}

function parseTranscriptRows(v: unknown): Validated<TranscriptRow[]> {
  if (!Array.isArray(v)) return invalid("rows must be an array");
  for (const r of v) {
    const row = r as Record<string, unknown>;
    if (
      typeof row?.idx !== "number" ||
      !Number.isInteger(row.idx) ||
      row.idx < 0 ||
      typeof row?.part !== "number" ||
      !Number.isInteger(row.part) ||
      row.part < 0 ||
      typeof row?.json !== "string"
    ) {
      return invalid("rows entries must be {idx, part, json}");
    }
  }
  return { ok: true, value: v as TranscriptRow[] };
}

/** The keyed append's rows (session-log item 13): the parts of one turn, no index — the object assigns the tail's. */
function parseKeyedRows(v: unknown): Validated<Array<{ part: number; json: string }>> {
  if (!Array.isArray(v) || v.length === 0) return invalid("rows must be a non-empty array");
  for (const r of v) {
    const row = r as Record<string, unknown>;
    if (typeof row?.part !== "number" || !Number.isInteger(row.part) || row.part < 0 || typeof row?.json !== "string")
      return invalid("rows entries must be {part, json}");
  }
  return { ok: true, value: v as Array<{ part: number; json: string }> };
}

/** The keyed append's row id (session-log item 13): non-empty, bounded — an event id, a message id with its edit stamp, a migrated row's name. */
function parseRowId(v: unknown): Validated<string> {
  if (typeof v !== "string" || v.length === 0 || v.length > 512)
    return invalid("rowId must be a string of 1..512 characters");
  return { ok: true, value: v };
}

function parseSessionKey(v: unknown): Validated<string> {
  if (typeof v !== "string" || !SESSION_KEY_PATTERN.test(v)) return invalid("key must be a session key");
  return { ok: true, value: v };
}

function parseLogIndex(v: unknown, name: string): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return invalid(`${name} must be an integer >= 0`);
  return { ok: true, value: v };
}

/** The session log's byte budget on the owner claim: the store's policy field,
 *  clamped into its bounds like every policy field; absent, the default. */
function parseSessionMaxBytes(v: unknown): Validated<number> {
  if (v === undefined) return { ok: true, value: DEFAULT_SESSION_LOG_MAX_BYTES };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return invalid("maxBytes must be an integer >= 1");
  const [lo, hi] = RETENTION_BOUNDS.sessionLogMaxBytes;
  return { ok: true, value: Math.min(hi, Math.max(lo, v)) };
}

function parseAttachments(v: unknown): Validated<TranscriptAttachment[]> {
  if (!Array.isArray(v)) return invalid("attachments must be an array");
  for (const a of v) {
    const att = a as Record<string, unknown>;
    if (typeof att?.ref !== "string" || typeof att?.mediaType !== "string" || typeof att?.data !== "string") {
      return invalid("attachments entries must be {ref, mediaType, data}");
    }
  }
  return { ok: true, value: v as TranscriptAttachment[] };
}

/** The ledger routes (run-history items 28–34). Bodies are validated before
 *  any object call; fenced answers are 409 with the reason; observability
 *  lines carry ids and counts only. */
async function handleLedger(
  pathname: string,
  body: unknown,
  env: Env,
  originalBody?: string,
  expectedSeed?: ExpectedSeedManifest,
): Promise<Response> {
  if (typeof body !== "object" || body === null) return json({ error: "body must be a JSON object" }, 400);
  const b = body as Record<string, unknown>;
  const fenced = (r: FenceResult) => (r.ok ? json(r) : json(r, 409));

  if (pathname.startsWith("/runs/session/")) {
    const key = parseSessionKey(b.key);
    if (!key.ok) return json({ error: key.error }, 400);
    const stub = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(key.value));
    try {
      if (pathname === "/runs/session/expected-seed/verify" || pathname === "/runs/session/expected-seed/read") {
        if (b.release !== undefined && pathname.endsWith("/verify")) {
          const release = sourceSeedReferenceOf(b.release);
          if (!release || Object.keys(b).some((k) => !["key", "release"].includes(k)))
            return json({ error: "invalid original source release reference" }, 400);
          return json(await stub.releaseExpectedSeed(key.value, release));
        }
        const reference = sourceSeedReferenceOf(b.reference);
        if (!reference) return json({ error: "invalid original source reference" }, 400);
        return json(
          pathname.endsWith("/verify")
            ? await stub.verifyExpectedSeed(key.value, reference)
            : await stub.readExpectedSeed(key.value, reference),
        );
      }
      if (pathname === "/runs/session/checkpoint") {
        const store = parseStoreKey(b);
        if (!store.ok) return json({ error: store.error }, 400);
        const run = parseRunId(b.runId);
        if (!run.ok) return json({ error: run.error }, 400);
        const owner = gen(b.gen);
        if (!owner.ok) return json({ error: owner.error }, 400);
        const request = {
          key: key.value,
          runId: run.value,
          gen: owner.value,
          expected: b.expected,
        } as ContextCheckpointRequest;
        if (
          !request.expected ||
          typeof request.expected.beforeHash !== "string" ||
          !Number.isSafeInteger(request.expected.revision) ||
          !request.expected.inputs
        )
          return json({ error: "invalid checkpoint request" }, 400);
        const result = await env.RUNS.get(env.RUNS.idFromName(store.value)).normalizeContextOrigins(request);
        return json(result, result.ok ? 200 : 409);
      }
      if (pathname === "/runs/session/tail") return json(await stub.nextIndex());
      if (pathname === "/runs/session/owner") {
        const runId = parseRunId(b.runId);
        if (!runId.ok) return json({ error: runId.error }, 400);
        const g = gen(b.gen);
        if (!g.ok) return json({ error: g.error }, 400);
        const max = parseSessionMaxBytes(b.maxBytes);
        if (!max.ok) return json({ error: max.error }, 400);
        return json(await stub.setOwner(runId.value, g.value, max.value));
      }
      if (pathname === "/runs/session/write") {
        const g = gen(b.gen);
        if (!g.ok) return json({ error: g.error }, 400);
        const rows = parseTranscriptRows(b.rows);
        if (!rows.ok) return json({ error: rows.error }, 400);
        const attachments = parseAttachments(b.attachments);
        if (!attachments.ok) return json({ error: attachments.error }, 400);
        if (b.sources !== undefined) {
          if (!isSessionSources(b.sources) || typeof b.sourceRunId !== "string")
            return json({ error: "invalid trusted source metadata" }, 400);
          let owner: SessionSourceOwner | null | undefined;
          if (b.storeKey !== undefined) {
            const store = parseStoreKey(b);
            if (!store.ok) return json({ error: store.error }, 400);
            owner = await env.RUNS.get(env.RUNS.idFromName(store.value)).sourceSessionOwner(
              b.sourceRunId,
              g.value,
              key.value,
            );
          }
          if (!sourcesBelongToSession(key.value, b.sources, owner))
            return json({ error: "source metadata does not belong to the claimed session" }, 409);
        }
        const r = await stub.write(
          g.value,
          rows.value,
          attachments.value,
          b.sources !== undefined
            ? { runId: b.sourceRunId as string, sources: b.sources as SessionSources }
            : undefined,
          typeof b.runId === "string" ? b.runId : undefined,
          b.seed === true,
        );
        console.log(
          `[runs/session/write] ${key.value} <- ${rows.value.length} row(s), ${attachments.value.length} attachment(s), ok=${r.ok}`,
        );
        return fenced(r);
      }
      if (pathname === "/runs/session/append") {
        const rowId = parseRowId(b.rowId);
        if (!rowId.ok) return json({ error: rowId.error }, 400);
        const rows = parseKeyedRows(b.rows);
        if (!rows.ok) return json({ error: rows.error }, 400);
        if (b.context !== undefined && !isContextDependencies(b.context))
          return json({ error: "invalid context dependencies" }, 400);
        const store = b.storeKey !== undefined ? parseStoreKey(b) : undefined;
        if (store && !store.ok) return json({ error: store.error }, 400);
        if (
          !store &&
          logicalThreadOfSession(key.value) !== undefined &&
          contextReferencesOf("@pending", undefined, b.context as ContextDependencies | undefined).length
        )
          return json({ ok: false, appended: false, reason: "context-index-unavailable" }, 409);
        const context = b.context as ContextDependencies | undefined;
        const checkpoints: CanonicalCheckpointSource[] = [];
        if (store?.ok)
          for (const origin of context?.origins ?? []) {
            if (!origin.checkpoint) continue;
            const source = await env.RUNS.get(env.RUNS.idFromName(store.value)).readContextCheckpoint(origin.runId);
            if (source?.receipt?.hash === origin.checkpoint) checkpoints.push(source);
          }
        const r = await stub.appendKeyed(rowId.value, rows.value, context, checkpoints);
        if (r.ok && store?.ok && logicalThreadOfSession(key.value) !== undefined) {
          const indexed = await env.RUNS.get(env.RUNS.idFromName(store.value)).registerThreadSession(
            key.value,
            logicalThreadOfSession(key.value)!,
            systemClock(),
            b.context as ContextDependencies | undefined,
          );
          if (!indexed.ok) return json({ ok: false, appended: r.appended, reason: indexed.reason }, 409);
        }
        console.log(
          `[runs/session/append] ${key.value} <- ${rows.value.length} row(s) under ${rowId.value}, appended=${r.appended}`,
        );
        return json({ ...r, ...(r.ok && b.context !== undefined ? { contextSaved: true } : {}) });
      }
      if (pathname === "/runs/session/entry") {
        const rowId = parseRowId(b.rowId);
        if (!rowId.ok) return json({ error: rowId.error }, 400);
        return json({ rows: (await stub.readEntry(rowId.value)) ?? null });
      }
      if (pathname === "/runs/session/read") {
        if (b.observation !== undefined) {
          const observation = b.observation as { from?: unknown; through?: unknown };
          const from = parseLogIndex(observation?.from, "from"),
            through = parseLogIndex(observation?.through, "through");
          if (
            !from.ok ||
            !through.ok ||
            through.value < from.value ||
            Object.keys(b).some((k) => !["key", "observation"].includes(k))
          )
            return json({ error: "invalid original seed observation" }, 400);
          return json(await stub.observeExpectedSeed(from.value, through.value));
        }
        const from = parseLogIndex(b.from, "from");
        if (!from.ok) return json({ error: from.error }, 400);
        if (b.to !== undefined) {
          const to = parseLogIndex(b.to, "to");
          if (!to.ok) return json({ error: to.error }, 400);
          if (to.value < from.value) return json({ error: "to must be at least from" }, 400);
          return json(await stub.read(from.value, to.value));
        }
        return json(await stub.read(from.value));
      }
      if (pathname === "/runs/session/read-tail") {
        const max = b.maxBytes;
        if (typeof max !== "number" || !Number.isInteger(max) || max < 1)
          return json({ error: "maxBytes must be an integer >= 1" }, 400);
        return json(await stub.readTail(max));
      }
      if (pathname === "/runs/session/clear-owner") {
        const runId = parseRunId(b.runId);
        if (!runId.ok) return json({ error: runId.error }, 400);
        const g = gen(b.gen);
        if (!g.ok) return json({ error: g.error }, 400);
        return fenced(await stub.clearOwner(runId.value, g.value));
      }
      // `recall` (session-log item 10): the hits in relevance order, and the gap
      // markers that lie between the oldest and the newest of them.
      if (pathname === "/runs/session/search") {
        if (
          typeof b.query !== "string" ||
          b.query.trim().length === 0 ||
          utf8ByteLength(b.query) > MAX_SEARCH_QUERY_BYTES
        )
          return json({ error: `query must be a non-empty string of at most ${MAX_SEARCH_QUERY_BYTES} bytes` }, 400);
        const limit = b.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_HITS)
          return json({ error: `limit must be an integer in 1..${SEARCH_MAX_HITS}` }, 400);
        const hits = await stub.search(b.query, limit);
        const gaps =
          hits.length > 1
            ? await stub.gapsBetween(Math.min(...hits.map((h) => h.idx)), Math.max(...hits.map((h) => h.idx)))
            : [];
        console.log(`[runs/session/search] ${key.value} -> ${hits.length} hit(s), ${gaps.length} gap(s)`);
        return json({ hits, gaps });
      }
      if (pathname === "/runs/session/requester-target" || pathname === "/runs/session/requester-target/write") {
        const actor = b.actor;
        if (typeof actor !== "string" || !/^[a-z][\w-]*:[^\s]{1,150}$/.test(actor))
          return json({ error: "actor must be a namespaced identity" }, 400);
        if (pathname === "/runs/session/requester-target") return json({ target: await stub.requesterTarget(actor) });
        const target = b.target as Record<string, unknown> | undefined;
        if (
          !target ||
          typeof target.repo !== "string" ||
          !/^[\w.-]+\/[\w.-]+$/.test(target.repo) ||
          typeof target.provenance !== "string" ||
          utf8ByteLength(target.provenance) > 2_000 ||
          !target.provenance ||
          (target.issue !== undefined &&
            (typeof target.issue !== "string" ||
              !target.issue.startsWith(`${target.repo}#`) ||
              !/^\d+$/.test(target.issue.slice(target.repo.length + 1))))
        )
          return json({ error: "invalid requester target" }, 400);
        return json({
          target: await stub.checkpointRequesterTarget(actor, {
            repo: target.repo,
            provenance: target.provenance,
            ...(target.issue ? { issue: target.issue as string } : {}),
          }),
        });
      }
      if (pathname === "/runs/session/notepad") return json({ notepad: await stub.notepad() });
      if (pathname === "/runs/session/notepad/write") {
        const g = gen(b.gen);
        if (!g.ok) return json({ error: g.error }, 400);
        if (typeof b.text !== "string") return json({ error: "text must be a string" }, 400);
        const bytes = utf8ByteLength(b.text);
        if (bytes > NOTEPAD_MAX_BYTES)
          return json({ error: `text is ${bytes} bytes; the notepad holds at most ${NOTEPAD_MAX_BYTES}` }, 400);
        const r = await stub.writeNotepad(
          g.value,
          b.text,
          systemClock(),
          typeof b.runId === "string" ? b.runId : undefined,
        );
        console.log(`[runs/session/notepad/write] ${key.value} <- ${bytes} byte(s), ok=${r.ok}`);
        return fenced(r);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      const pending = await stub.expectedSeedMutationHold();
      if (pending) return json(pending, 423);
      throw error;
    }
  }

  if (pathname.startsWith("/runs/transcript/")) {
    const runId = parseRunId(b.runId);
    if (!runId.ok) return json({ error: runId.error }, 400);
    const stub = env.RUN_TRANSCRIPTS.get(env.RUN_TRANSCRIPTS.idFromName(runId.value));
    if (pathname === "/runs/transcript/owner") {
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      return json(await stub.setOwner(g.value));
    }
    if (pathname === "/runs/transcript/write") {
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      const rows = parseTranscriptRows(b.rows);
      if (!rows.ok) return json({ error: rows.error }, 400);
      const attachments = parseAttachments(b.attachments);
      if (!attachments.ok) return json({ error: attachments.error }, 400);
      const r = await stub.write(g.value, rows.value, attachments.value);
      console.log(
        `[runs/transcript/write] ${runId.value} <- ${rows.value.length} row(s), ${attachments.value.length} attachment(s), ok=${r.ok}`,
      );
      return fenced(r);
    }
    if (pathname === "/runs/transcript/read") return json(await stub.read());
    return json(await stub.clear());
  }

  const key = parseStoreKey(b);
  if (!key.ok) return json({ error: key.error }, 400);
  const stub = env.RUNS.get(env.RUNS.idFromName(key.value));
  const now = systemClock();
  const stateWitness =
    pathname === "/runs/state" && originalBody !== undefined
      ? await storeRequestWitness(pathname, originalBody)
      : undefined;
  if (["/runs/state", "/runs/live-state", "/runs/finishing", "/runs/finish", "/runs/abandon"].includes(pathname)) {
    const id = parseRunId(b.runId),
      owner = gen(b.gen);
    if (id.ok && owner.ok) {
      let pending: PromotionHold | null;
      try {
        pending = await stub.promotionHold(id.value, owner.value);
      } catch (error) {
        if (!stateWitness) throw error;
        throw new StateWriteBoundaryError(
          {
            version: 1,
            requestDigest: stateWitness.digest,
            failure: stateWriteException("promotion-preflight", error),
          },
          error,
        );
      }
      if (pending) return json(pending, 423);
    }
  }

  if (pathname === "/runs/promotion/prepare") {
    const parsed = parseClaim(b);
    if (!parsed.ok || originalBody === undefined) return json({ error: "invalid original promotion body" }, 400);
    return json(await stub.preparePromotion(originalBody, expectedSeed));
  }
  if (pathname === "/runs/promotion/read") {
    const run = parseRunId(b.runId),
      owner = gen(b.gen);
    if (
      !run.ok ||
      !owner.ok ||
      (b.bodySha256 !== undefined && (typeof b.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.bodySha256)))
    )
      return json({ error: "invalid promotion read identity" }, 400);
    return json(
      await stub.readPromotion({
        runId: run.value,
        gen: owner.value,
        ...(typeof b.bodySha256 === "string" ? { bodySha256: b.bodySha256 } : {}),
      }),
    );
  }

  if (pathname === "/runs/context-checkpoint") {
    const run = parseRunId(b.runId);
    if (!run.ok) return json({ error: run.error }, 400);
    return json({ source: (await stub.readContextCheckpoint(run.value)) ?? null });
  }
  if (pathname === "/runs/claim") {
    if (b.confirm !== undefined) {
      const reference = sourceSeedReferenceOf(b.confirm);
      if (
        !reference ||
        reference.storeKey !== key.value ||
        Object.keys(b).some((k) => !["storeKey", "confirm"].includes(k))
      )
        return json({ error: "invalid original confirmation reference" }, 400);
      return json(await stub.confirmPromotion(reference));
    }
    const req = parseClaim(b);
    if (!req.ok) return json({ error: req.error }, 400);
    const pending = await stub.promotionHold(req.value.runId, req.value.gen);
    if (pending) {
      const saved = await stub.readPromotion({ runId: req.value.runId, gen: req.value.gen });
      if (saved.kind === "held" || saved.preparation.bodyJson !== originalBody) return json(pending, 423);
    }
    const r = await stub.claim(req.value, now, originalBody);
    console.log(
      `[runs/claim] ${key.value} ${req.value.runId} on ${req.value.threadKey} → ${r.ok ? "claimed" : r.reason}`,
    );
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/resident-claim") {
    const runId = parseRunId(b.runId);
    if (!runId.ok) return json({ error: runId.error }, 400);
    const g = gen(b.gen);
    if (!g.ok) return json({ error: g.error }, 400);
    if (typeof b.threadKey !== "string" || b.threadKey.length === 0 || b.threadKey.length > 256)
      return json({ error: "threadKey must be a non-empty string" }, 400);
    const result = await stub.residentClaim(runId.value, g.value, b.threadKey);
    return result.ok ? json(result) : json(result, 409);
  }
  if (pathname === "/runs/live") return json({ runs: await stub.listLive() });
  if (pathname === "/runs/preservation-owner") {
    const runId = parseRunId(b.runId);
    if (!runId.ok) return json({ error: runId.error }, 400);
    const exact = b.ownerGen !== undefined || b.ownerFence !== undefined;
    if (exact && !isWorkspaceOwner(b)) return json({ error: "invalid workspace owner" }, 400);
    return json(await stub.preservationOwner(runId.value, exact ? (b as unknown as WorkspaceOwner) : undefined));
  }
  if (pathname === "/runs/workspace-disposition") {
    const allocation = workspaceAllocationOf(b.allocation);
    if (!allocation) return json({ error: "invalid original workspace allocation" }, 400);
    return json(await stub.workspaceDisposition(allocation));
  }
  if (pathname === "/runs/workspace-ack") {
    if (!isWorkspaceOwner(b) || !Number.isSafeInteger(b.revision) || Number(b.revision) <= 0)
      return json({ error: "invalid workspace acknowledgment" }, 400);
    const result = await stub.ackWorkspaceSettlement(b, Number(b.revision));
    return json(result, result.ok ? 200 : 409);
  }
  if (pathname === "/runs/reclaim") {
    const g = gen(b.gen);
    if (!g.ok) return json({ error: g.error }, 400);
    const lease = parseLeaseMs(b.leaseMs);
    if (!lease.ok) return json({ error: lease.error }, 400);
    const at = typeof b.now === "number" && Number.isFinite(b.now) ? b.now : now;
    // The RPC type mapping reads the row's open-ended JSON fields as
    // unserializable; the values are plain JSON, so the cast only restores the
    // declared shape.
    const runs = (await stub.reclaim(g.value, at, lease.value)) as unknown as ReclaimedRun[];
    console.log(`[runs/reclaim] ${key.value} ${g.value} took ${runs.length} run(s)`);
    // The reclaim sweep's answer carries the plane's open effects like every
    // heartbeat answer does (record 0064; orchestration-plane item 7) — empty until a unit writes them.
    return json({ runs, effects: await stub.openPlaneEffects() });
  }
  if (pathname === "/runs/handoff") {
    const g = gen(b.gen);
    if (!g.ok) return json({ error: g.error }, 400);
    const ids: unknown[] = Array.isArray(b.runIds) ? b.runIds : [];
    if (!Array.isArray(b.runIds) || !ids.every((id) => typeof id === "string" && RUN_ID_PATTERN.test(id))) {
      return json({ error: "runIds must be an array of run ids" }, 400);
    }
    const runIds = ids as string[];
    if (b.pausedForRetry !== undefined && (b.pausedForRetry !== true || runIds.length !== 1))
      return json({ error: "pausedForRetry requires one run" }, 400);
    const r = await stub.handoff(g.value, runIds, b.pausedForRetry === true);
    console.log(`[runs/handoff] ${key.value} ${g.value} marked ${r.marked.length}/${runIds.length}`);
    return json(r);
  }

  // Decision-record allocation is one atomic write on the same durable object
  // that holds unit and run rows, so a bot restart cannot forget a claim.
  if (pathname === "/runs/decision-record/reserve") {
    if (typeof b.repo !== "string" || !REPO_SLUG.test(b.repo)) return json({ error: "repo must be owner/name" }, 400);
    if (typeof b.taskKey !== "string" || !/^[0-9a-f]{16}$/.test(b.taskKey))
      return json({ error: "taskKey must be a decision-record task key" }, 400);
    if (!Array.isArray(b.claimed) || !b.claimed.every((number) => typeof number === "string" && /^\d{4}$/.test(number)))
      return json({ error: "claimed must be an array of decision-record numbers" }, 400);
    if (b.existing !== undefined && (typeof b.existing !== "string" || !/^\d{4}$/.test(b.existing)))
      return json({ error: "existing must be a decision-record number" }, 400);
    return json(
      await stub.reserveDecisionRecord(b.repo, b.taskKey, b.claimed as string[], b.existing as string | undefined, now),
    );
  }

  // The coordinator's parent records (run-history item 49): the record whole,
  // validated by the shared contract; a read by instance id.
  if (pathname === "/runs/coordinator/put") {
    if (!isCoordinatorInstance(b.instance))
      return json({ error: "instance must be a coordinator instance record" }, 400);
    const r = await stub.putInstance(b.instance);
    console.log(`[runs/coordinator/put] ${key.value} ${b.instance.id} → ${r.ok ? "stored" : r.reason}`);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/replace") {
    if (!isCoordinatorInstance(b.instance))
      return json({ error: "instance must be a coordinator instance record" }, 400);
    const r = await stub.replaceInstance(b.instance);
    console.log(`[runs/coordinator/replace] ${key.value} ${b.instance.id} → ${r.ok ? "replaced" : r.reason}`);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/admission/confirm") {
    if (!isCoordinatorInstance(b.expected) || b.expected.admission !== "unreconciled")
      return json({ error: "expected must be an unreconciled coordinator instance" }, 400);
    const r = await stub.confirmInstanceCreated(b.expected);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/main-task/get") {
    if (!isMainTaskKey(b.key)) return json({ error: "key must name a main thread and act id" }, 400);
    return json({ link: await stub.getMainTask(b.key) });
  }
  if (pathname === "/runs/coordinator/requester-turn/record") {
    if (!isRequesterTurnInput(b.input)) return json({ error: "input must name one verified Slack turn" }, 400);
    const r = await stub.recordRequesterTurn(b.input);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/requester-turn/latest") {
    const key = b.key as { threadKey?: unknown; requesterId?: unknown } | undefined;
    if (
      !key ||
      typeof key.threadKey !== "string" ||
      !/^slack:[CDG][A-Za-z0-9]+:\d+(?:\.\d+)?$/.test(key.threadKey) ||
      typeof key.requesterId !== "string" ||
      !/^slack:[UW][A-Za-z0-9]+$/.test(key.requesterId)
    )
      return json({ error: "key must name one requester in a Slack DM" }, 400);
    return json({ turn: await stub.latestRequesterTurn({ threadKey: key.threadKey, requesterId: key.requesterId }) });
  }
  if (
    pathname === "/runs/private-worker/append" ||
    pathname === "/runs/private-worker/list" ||
    pathname === "/runs/private-worker/list-after"
  ) {
    if (typeof b.threadKey !== "string" || parsePrivateWorkerThreadKey(b.threadKey) === undefined)
      return json({ error: "threadKey must name one private worker" }, 400);
    if (pathname === "/runs/private-worker/list")
      return json({ events: await stub.listPrivateWorkerEvents(b.threadKey) });
    if (pathname === "/runs/private-worker/list-after") {
      if (
        !Number.isSafeInteger(b.afterSeq) ||
        (b.afterSeq as number) < 0 ||
        !Number.isSafeInteger(b.limit) ||
        (b.limit as number) < 1 ||
        (b.limit as number) > 32
      )
        return json({ error: "afterSeq and limit must be bounded positive integers" }, 400);
      return json(await stub.listPrivateWorkerEventsAfter(b.threadKey, b.afterSeq as number, b.limit as number));
    }
    if (!isPrivateWorkerEventInput(b.event)) return json({ error: "event must be a bounded worker event" }, 400);
    const event = await stub.appendPrivateWorkerEvent(b.threadKey, b.event);
    return event === null ? json({ error: "private worker input id conflict" }, 409) : json({ event });
  }
  if (pathname === "/runs/coordinator/main-task/claim") {
    if (
      !isMainTaskKey(b.key) ||
      !isCoordinatorInstance(b.instance) ||
      !isCoordinatorUnit(b.unit) ||
      !isMainTaskAuthority(b.authority) ||
      !mainTaskClaimMatches(b.key, b.instance, b.unit)
    )
      return json({ error: "claim must bind one generated unit and its attributed brief" }, 400);
    const r = await stub.claimMainTask(b.key, b.instance, b.unit, b.authority, now);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/get") {
    if (typeof b.id !== "string" || !INSTANCE_ID_PATTERN.test(b.id))
      return json({ error: "id must be a Workflow instance id" }, 400);
    return json({ instance: await stub.getInstance(b.id) });
  }
  // The hard stop's mark on the instance row (record 0060; issue 1924): the
  // bot writes it when the hosted parent is sealed; the runner reads it back.
  if (pathname === "/runs/coordinator/stop") {
    if (typeof b.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(b.instanceId))
      return json({ error: "instanceId must be a Workflow instance id" }, 400);
    if (typeof b.at !== "number" || !Number.isFinite(b.at)) return json({ error: "at must be a time" }, 400);
    if (b.binding !== undefined && !isMainTaskBinding(b.binding))
      return json({ error: "binding must name one main task claim" }, 400);
    const r = await stub.markInstanceStopped(b.instanceId, b.at, b.binding as MainTaskBinding | undefined);
    console.log(`[runs/coordinator/stop] ${key.value} ${b.instanceId} → ${r.ok ? "marked" : r.reason}`);
    return r.ok ? json(r) : json(r, 409);
  }
  // The units of the plan an instance runs (run-history item 50): rows
  // validated by the shared contract, each replaced whole; a list by instance.
  if (pathname === "/runs/coordinator/maintenance/admit") {
    if (!isMaintenanceAdmissionInput(b.input)) return json({ error: "invalid maintenance intent" }, 400);
    const result = await stub.admitMaintenance(b.input, now);
    return result.ok ? json(result) : json(result, 409);
  }
  if (pathname === "/runs/coordinator/units/effect-transition") {
    if (!isUnitEffectTransition(b.input)) return json({ error: "invalid unit effect transition" }, 400);
    const result = await stub.transitionUnitEffect(b.input, now);
    return json(result, result.ok ? 200 : 409);
  }
  if (pathname === "/runs/coordinator/recovery/transition") {
    if (recoveryBytes(b) > RECOVERY_HISTORY_LIMITS.requestBytes) return json({ ok: false, reason: "capacity" }, 409);
    if (!isRecoveryTransition(b.input)) return json({ error: "invalid recovery transition" }, 400);
    const result = await stub.transitionRecovery(b.input, now);
    return json(result, result.ok ? 200 : 409);
  }
  if (pathname === "/runs/coordinator/recovery/action" || pathname === "/runs/coordinator/recovery/history") {
    const address = b.key as { instanceId?: unknown; unit?: unknown } | undefined;
    if (
      !address ||
      typeof address.instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(address.instanceId) ||
      typeof address.unit !== "string" ||
      !UNIT_PATTERN.test(address.unit)
    )
      return json({ error: "invalid recovery work key" }, 400);
    const recoveryKey = { instanceId: address.instanceId, unit: address.unit };
    if (pathname.endsWith("/action")) {
      const byId = typeof b.actionId === "string" && /^r_[a-f0-9]{64}$/.test(b.actionId);
      if (byId ? b.request !== undefined : b.actionId !== undefined || !isRecoveryRequest(b.request))
        return json({ error: "invalid recovery request" }, 400);
      return json({
        action: await stub.getRecoveryAction(
          recoveryKey,
          byId ? (b.actionId as string) : (b.request as RecoveryRequest),
        ),
      });
    }
    if (!Number.isSafeInteger(b.after) || (b.after as number) < 0)
      return json({ error: "invalid recovery cursor" }, 400);
    return json(await stub.listRecoveryHistory(recoveryKey, b.after as number));
  }
  if (pathname === "/runs/coordinator/reconcile/offer") {
    if (
      typeof b.instanceId !== "string" ||
      !INSTANCE_ID_PATTERN.test(b.instanceId) ||
      typeof b.unit !== "string" ||
      !UNIT_PATTERN.test(b.unit)
    )
      return json({ error: "invalid reconciliation work key" }, 400);
    return json(await stub.offerCoordinatorReconciliation(b.instanceId, b.unit, now));
  }
  if (pathname === "/runs/coordinator/units/put") {
    if (!Array.isArray(b.units) || b.units.length === 0 || b.units.length > MAX_UNITS_PER_PUT)
      return json({ error: `units must be a non-empty array of at most ${MAX_UNITS_PER_PUT} unit rows` }, 400);
    if (!b.units.every(isCoordinatorUnit)) return json({ error: "every unit must be a coordinator unit row" }, 400);
    const units = b.units as CoordinatorUnit[];
    const r = await stub.putUnits(units, now);
    console.log(`[runs/coordinator/units/put] ${key.value} ${units[0]!.instanceId} ${units.length} row(s)`);
    return json(r, r.ok ? 200 : 409);
  }
  if (pathname === "/runs/coordinator/units/claim-legacy-continuation") {
    if (!isCoordinatorUnit(b.expected) || !isCoordinatorUnit(b.recovered))
      return json({ error: "expected and recovered must be coordinator unit rows" }, 400);
    if (b.expected.instanceId !== b.recovered.instanceId || b.expected.unit !== b.recovered.unit)
      return json({ error: "expected and recovered must name the same unit" }, 400);
    const r = await stub.compareAndReplaceUnit(b.expected, b.recovered, now);
    console.log(
      `[runs/coordinator/units/claim-legacy-continuation] ${key.value} ${b.expected.instanceId}:${b.expected.unit} → ${r.ok ? "replaced" : r.reason}`,
    );
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/units/adoption-audit") {
    if (!isCoordinatorUnit(b.expected) || typeof b.runId !== "string" || !RUN_ID_PATTERN.test(b.runId))
      return json({ error: "expected unit and original run required" }, 400);
    return json({ audit: (await stub.prepareAdoptionAudit(b.expected, b.runId)) ?? null });
  }
  if (pathname === "/runs/coordinator/units/list") {
    if (typeof b.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(b.instanceId))
      return json({ error: "instanceId must be a Workflow instance id" }, 400);
    return json({ units: await stub.listUnits(b.instanceId) });
  }
  if (pathname === "/runs/coordinator/pull-owners") {
    if (!isPullTarget(b.target)) return json({ error: "target must name a repository and PR or ref" }, 400);
    if (b.diagnostic !== undefined && typeof b.diagnostic !== "boolean")
      return json({ error: "diagnostic must be boolean" }, 400);
    return json(await stub.findPullOwners(b.target, b.diagnostic === true));
  }
  if (pathname === "/runs/coordinator/units/list-active-recoveries")
    return json({ units: await stub.listActiveRecoveries() });
  if (pathname === "/runs/coordinator/wake") {
    if (!isCoordinatorUnit(b.unit)) return json({ error: "unit must be a coordinator unit row" }, 400);
    if (typeof b.waitId !== "string" || !STEP_NAME_PATTERN.test(b.waitId))
      return json({ error: "waitId must be a step name" }, 400);
    if (!isUnitWakeAnswer(b.answer)) return json({ error: "answer must be a unit wake answer" }, 400);
    if (!Array.isArray(b.seqs) || !b.seqs.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 1))
      return json({ error: "seqs must be an array of sequence numbers" }, 400);
    if (typeof b.by !== "string" || b.by.length === 0 || b.by.length > 200)
      return json({ error: "by must name the consumer" }, 400);
    const r = await stub.answerUnitWake(b.unit, b.waitId, b.answer, b.seqs as number[], b.by, now);
    console.log(`[runs/coordinator/wake] ${key.value} ${b.unit.instanceId}:${b.unit.unit} ${b.waitId}`);
    return json(r, r.ok ? 200 : 409);
  }
  // The thread events of a unit-owned thread (record 0051's reply-as-event rule): append assigns
  // the sequence (or returns the row with the same stable id), list filters
  // unconsumed, mark-consumed is idempotent.
  if (pathname.startsWith("/runs/coordinator/events/")) {
    if (typeof b.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(b.instanceId))
      return json({ error: "instanceId must be a Workflow instance id" }, 400);
    if (typeof b.unit !== "string" || !UNIT_PATTERN.test(b.unit)) return json({ error: "unit must be a unit id" }, 400);
    if (pathname === "/runs/coordinator/events/append") {
      if (!isThreadEvent({ ...(b.event as Record<string, unknown>), seq: 1 }))
        return json({ error: "event must be a thread event (without its seq)" }, 400);
      if (b.requireActive !== undefined && typeof b.requireActive !== "boolean")
        return json({ error: "requireActive must be boolean" }, 400);
      if (b.binding !== undefined && !isMainTaskBinding(b.binding))
        return json({ error: "binding must name one main task claim" }, 400);
      if (b.expectedRecovery !== undefined) {
        const exact = b.expectedRecovery as { actionId?: unknown; workflowId?: unknown };
        if (
          !exact ||
          typeof exact !== "object" ||
          Array.isArray(exact) ||
          Object.keys(exact).length !== 2 ||
          typeof exact.actionId !== "string" ||
          !/^r_[a-f0-9]{64}$/.test(exact.actionId) ||
          typeof exact.workflowId !== "string" ||
          !INSTANCE_ID_PATTERN.test(exact.workflowId) ||
          b.requireActive !== true
        )
          return json({ error: "expectedRecovery must name an active exact action and Workflow" }, 400);
      }
      // The store assigns the sequence and the consumer: a caller's `seq` or
      // `consumedBy` is dropped, so no row is born consumed in its JSON while
      // its column still lists it unconsumed.
      const { seq: _ignored, consumedBy: _fresh, ...event } = b.event as ThreadEvent;
      const r = await stub.appendUnitEvent(
        b.instanceId,
        b.unit,
        event as Omit<ThreadEvent, "seq" | "consumedBy">,
        b.requireActive === true,
        b.binding as MainTaskBinding | undefined,
        b.expectedRecovery as { actionId: string; workflowId: string } | undefined,
      );
      if (!r.ok) return json(r, 409);
      console.log(`[runs/coordinator/events/append] ${key.value} ${b.instanceId}:${b.unit} seq ${r.seq}`);
      return json(r);
    }
    if (pathname === "/runs/coordinator/events/list") {
      return json({ events: await stub.listUnitEvents(b.instanceId, b.unit, b.unconsumedOnly === true) });
    }
    if (pathname === "/runs/coordinator/events/mark-consumed") {
      if (!Array.isArray(b.seqs) || !b.seqs.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 1))
        return json({ error: "seqs must be an array of sequence numbers" }, 400);
      if (typeof b.by !== "string" || b.by.length === 0 || b.by.length > 200)
        return json({ error: "by must name the consumer" }, 400);
      const r = await stub.markUnitEventsConsumed(b.instanceId, b.unit, b.seqs as number[], b.by);
      console.log(
        `[runs/coordinator/events/mark-consumed] ${key.value} ${b.instanceId}:${b.unit} ${b.seqs.length} row(s) by ${b.by}`,
      );
      return json(r);
    }
  }

  // The intake receipts (run-history item 59): keyed by the message, not a run.
  if (pathname === "/runs/intake/delivery/claim" || pathname === "/runs/intake/delivery/finish") {
    const receiptKey = b.key;
    if (typeof receiptKey !== "string" || receiptKey.length === 0 || receiptKey.length > 256)
      return json({ error: "key must be a non-empty string of at most 256 characters" }, 400);
    if (typeof b.poster !== "string" || b.poster.length === 0 || b.poster.length > 256)
      return json({ error: "poster must be a non-empty string of at most 256 characters" }, 400);
    if (pathname === "/runs/intake/delivery/claim") {
      if (typeof b.claimedAt !== "number" || !Number.isFinite(b.claimedAt))
        return json({ error: "claimedAt must be a number" }, 400);
      return json({ claimed: await stub.claimIntakeDelivery(receiptKey, b.poster, b.claimedAt) });
    }
    if (typeof b.delivered !== "boolean") return json({ error: "delivered must be a boolean" }, 400);
    await stub.finishIntakeDelivery(receiptKey, b.poster, b.delivered);
    return json({ ok: true });
  }
  if (pathname === "/runs/intake" || pathname === "/runs/intake/read") {
    const receiptKey = b.key;
    if (typeof receiptKey !== "string" || receiptKey.length === 0 || receiptKey.length > 256)
      return json({ error: "key must be a non-empty string of at most 256 characters" }, 400);
    if (pathname === "/runs/intake/read") return json({ receipt: await stub.readIntake(receiptKey) });
    if (!isIntakeReceipt(b.receipt)) return json({ error: "receipt must be an intake receipt" }, 400);
    if (b.windowMs !== undefined && (typeof b.windowMs !== "number" || !Number.isFinite(b.windowMs) || b.windowMs < 0))
      return json({ error: "windowMs must be a non-negative number" }, 400);
    if (b.telemetry !== undefined && typeof b.telemetry !== "boolean")
      return json({ error: "telemetry must be a boolean" }, 400);
    const r = await stub.recordIntake(
      receiptKey,
      b.receipt,
      typeof b.windowMs === "number" ? b.windowMs : 0,
      b.telemetry === true,
    );
    console.log(`[runs/intake] ${key.value} ${receiptKey} → ${r.inserted ? "inserted" : "existing"}`);
    return json(r);
  }
  if (pathname === "/runs/intake/list") {
    if (b.threadKey !== undefined && (typeof b.threadKey !== "string" || b.threadKey.length === 0))
      return json({ error: "threadKey must be a non-empty string" }, 400);
    if (b.since !== undefined && (typeof b.since !== "number" || !Number.isFinite(b.since)))
      return json({ error: "since must be a number" }, 400);
    return json({
      receipts: await stub.listIntake({
        ...(b.threadKey !== undefined ? { threadKey: b.threadKey } : {}),
        ...(b.since !== undefined ? { since: b.since } : {}),
      }),
    });
  }

  const runId = parseRunId(b.runId);
  if (!runId.ok) return json({ error: runId.error }, 400);
  if (pathname === "/runs/inbox") {
    if (typeof b.message !== "object" || b.message === null) return json({ error: "message must be an object" }, 400);
    return json(await stub.pushInbox(runId.value, b.message as Record<string, unknown>));
  }
  if (pathname === "/runs/live-events") return json({ events: await stub.liveEvents(runId.value) });
  if (pathname === "/runs/inbox/read") {
    const after = b.afterSeq === undefined ? 0 : b.afterSeq;
    if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
      return json({ error: "afterSeq must be a non-negative integer" }, 400);
    }
    if (b.peek === true) {
      const owner = gen(b.gen);
      if (!owner.ok) return json({ error: owner.error }, 400);
      const result = await stub.peekInbox(runId.value, owner.value, after);
      return json(result, result.ok ? 200 : 409);
    }
    return json({ items: await stub.readInbox(runId.value, after) });
  }
  if (pathname === "/runs/stop") {
    if (b.mode !== "soft" && b.mode !== "hard") return json({ error: "mode must be soft or hard" }, 400);
    return json(await stub.requestStop(runId.value, b.mode, now));
  }

  const g = gen(b.gen);
  if (!g.ok) return json({ error: g.error }, 400);
  if (pathname === "/runs/heartbeat") {
    const lease = parseLeaseMs(b.leaseMs);
    if (!lease.ok) return json({ error: lease.error }, 400);
    // The RPC type mapping reads the effects' open-ended `request` JSON as
    // unserializable; the values are plain JSON, so the cast only restores the
    // declared shape (as the reclaim route's does).
    // The heartbeat body (record 0064): plain JSON facts, validated by
    // shape — a malformed body beats without facts rather than dropping the lease.
    const facts =
      typeof b.facts === "object" &&
      b.facts !== null &&
      typeof (b.facts as Record<string, unknown>).round === "number" &&
      typeof (b.facts as Record<string, unknown>).coding === "boolean" &&
      typeof (b.facts as Record<string, unknown>).startedAt === "number"
        ? (b.facts as unknown as HeartbeatFacts)
        : undefined;
    const r = (await stub.heartbeat(runId.value, g.value, lease.value, now, facts)) as unknown as HeartbeatAnswer;
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/append") {
    if (!Array.isArray(b.events)) return json({ error: "events must be an array" }, 400);
    const events: Array<{ seq: number; json: string }> = [];
    for (const e of b.events) {
      const ev = e as Record<string, unknown>;
      if (typeof ev?.seq !== "number" || !Number.isInteger(ev.seq) || ev.seq < 1)
        return json({ error: "every event needs an integer seq ≥ 1" }, 400);
      const text = JSON.stringify(e);
      if (utf8ByteLength(text) > MAX_EVENT_BYTES)
        return json({ error: `event ${ev.seq} exceeds ${MAX_EVENT_BYTES} bytes` }, 400);
      events.push({ seq: ev.seq, json: text });
    }
    const r = await stub.appendEvents(runId.value, g.value, events);
    console.log(`[runs/append] ${key.value} ${runId.value} <- ${events.length} event(s), ok=${r.ok}`);
    return fenced(r);
  }
  if (pathname === "/runs/live-state") {
    if (typeof b.assignment !== "object" || b.assignment === null)
      return json({ error: "assignment must be an object" }, 400);
    const assignment = b.assignment as unknown as LiveStateAssignRequest;
    const r = await stub.assignLiveState(runId.value, g.value, assignment);
    return r.ok ? json(r) : json(r, r.reason === "fenced" || r.reason === "unknown-run" ? 409 : 400);
  }
  if (pathname === "/runs/step") {
    const record = parseStep(b.record);
    if (!record.ok) return json({ error: record.error }, 400);
    return fenced(await stub.recordStep(runId.value, g.value, record.value));
  }
  if (pathname === "/runs/state") {
    if (typeof b.state !== "object" || b.state === null) return json({ error: "state must be an object" }, 400);
    let result: FenceResult | PromotionHold;
    try {
      result = await stub.setState(runId.value, g.value, b.state as RunState);
    } catch (error) {
      if (!stateWitness) throw error;
      throw new StateWriteBoundaryError(
        {
          version: 1,
          requestDigest: stateWitness.digest,
          failure: stateWriteException("state-rpc", error),
        },
        error,
      );
    }
    if (result && typeof result === "object") {
      if (
        "kind" in result &&
        result.kind === "held" &&
        (result.reason === "promotion_pending" || result.reason === "promotion_corrupt") &&
        result.runId === runId.value &&
        Object.keys(result).every((key) => ["kind", "reason", "runId"].includes(key))
      )
        return json(result, 423);
      if (
        "ok" in result &&
        ((result.ok === true && Object.keys(result).length === 1) ||
          (result.ok === false &&
            (result.reason === "fenced" || result.reason === "unknown-run") &&
            Object.keys(result).every((key) => ["ok", "reason"].includes(key))))
      )
        return fenced(result);
    }
    const invalid = new Error("run state RPC returned an invalid acknowledgement");
    if (!stateWitness) throw invalid;
    throw new StateWriteBoundaryError(
      {
        version: 1,
        requestDigest: stateWitness.digest,
        failure: { stage: "acknowledgment", replyShape: stateWriteReplyShape(result) },
      },
      invalid,
    );
  }
  if (pathname === "/runs/finishing") return fenced(await stub.finishing(runId.value, g.value));
  if (pathname === "/runs/abandon") {
    const r = await stub.abandon(runId.value, g.value);
    console.log(`[runs/abandon] ${key.value} ${runId.value} ok=${r.ok}${r.ok ? "" : ` ${r.reason}`}`);
    return fenced(r);
  }
  if (pathname === "/runs/finish") {
    const parsed = parseRunPut({ ...b, storeKey: key.value });
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    if (parsed.value.record.id !== runId.value) return json({ error: "record.id must equal runId" }, 400);
    if (b.requireStoppedPause !== undefined && b.requireStoppedPause !== true)
      return json({ error: "requireStoppedPause must be true" }, 400);
    const r = await stub.finish(
      runId.value,
      g.value,
      parsed.value.record,
      parsed.value.proposal,
      parsed.value.point,
      b.requireStoppedPause === true,
    );
    console.log(
      `[runs/finish] ${key.value} ${runId.value} ok=${r.ok}${r.ok ? ` stored=${r.stored} event=${r.event}` : ` ${r.reason}`}`,
    );
    return r.ok ? json(r) : json(r, 409);
  }
  return json({ error: "not found" }, 404);
}

/** The `/runs/*` routes. Observability lines carry ids + counts only —
 *  never event text. A bad `id` is 400 before any DO call. */
async function handleRuns(pathname: string, body: unknown, env: Env): Promise<Response> {
  const stub = (key: string) => env.RUNS.get(env.RUNS.idFromName(key));
  if (LEDGER_ROUTES.has(pathname)) return handleLedger(pathname, body, env);
  if (pathname === "/runs/put") {
    const parsed = parseRunPut(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, record, proposal, point } = parsed.value;
    const pendingPromotion = await stub(storeKey).promotionHold(record.id);
    if (pendingPromotion) return json(pendingPromotion, 423);
    // `turnedFinal` stays internal: the wire answer is exactly the shape it
    // always was, binding or no binding (run-metrics.md item 4).
    const { turnedFinal: _turnedFinal, ...result } = await stub(storeKey).put(record, proposal, point);
    console.log(
      `[runs/put] ${storeKey} <- ${record.id} (${record.storedEventCount} events, stored=${result.stored}, ${result.retained} retained)`,
    );
    return json(result);
  }
  if (pathname === "/runs/get") {
    const parsed = parseRunTarget(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    // The stored record is JSON data; avoid recursively expanding the RPC
    // mapped type for every nested archive leaf at this transport boundary.
    const target = stub(parsed.value.storeKey) as unknown as Pick<RunHistoryDO, "get">;
    const record = await target.get(parsed.value.id);
    console.log(
      `[runs/get] ${parsed.value.storeKey} ${parsed.value.id} -> ${record ? `${record.events.length} events` : "not found"}`,
    );
    return json({ record });
  }
  if (pathname === "/runs/summary") {
    const parsed = parseRunTarget(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const summary = await stub(parsed.value.storeKey).summary(parsed.value.id);
    console.log(`[runs/summary] ${parsed.value.storeKey} ${parsed.value.id} -> ${summary ? "found" : "not found"}`);
    return json({ summary });
  }
  if (pathname === "/runs/list") {
    const parsed = parseRunList(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const result = await stub(parsed.value.storeKey).list(parsed.value.query);
    console.log(`[runs/list] ${parsed.value.storeKey} -> ${result.items.length} runs`);
    return json(result);
  }
  if (pathname === "/runs/events") {
    const parsed = parseRunEvents(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, id, afterSeq, limit } = parsed.value;
    const result = await stub(storeKey).events(id, afterSeq, limit);
    console.log(
      `[runs/events] ${storeKey} ${id} after ${afterSeq} -> ${result ? `${result.events.length} events` : "not found"}`,
    );
    return json(result ?? { events: null });
  }
  if (pathname === "/runs/usage") {
    const parsed = parseRunUsageQuery(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, sinceMs, untilMs } = parsed.value;
    const rows = await stub(storeKey).usage(sinceMs, untilMs);
    console.log(`[runs/usage] ${storeKey} -> ${rows.runs.length} runs, ${rows.pending} pending`);
    return json(rows);
  }
  // /runs/delete
  const parsed = parseRunTarget(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const deleted = await stub(parsed.value.storeKey).delete(parsed.value.id);
  if (typeof deleted !== "boolean") return json(deleted, 409);
  console.log(`[runs/delete] ${parsed.value.storeKey} ${parsed.value.id} -> deleted=${deleted}`);
  return json({ ok: true, deleted });
}

const ROUTES = new Set([
  ...CONFIG_ROUTES,
  ...DELIVERY_ROUTES,
  ...COSTS_ROUTES,
  "/retrieve",
  "/write",
  "/list",
  "/forget",
  "/sweep",
  "/schedules/record",
  "/schedules/latest",
  "/runs/put",
  "/runs/get",
  "/runs/summary",
  "/runs/list",
  "/runs/events",
  "/runs/usage",
  "/runs/delete",
  ...LEDGER_ROUTES,
  ...PLANE_ROUTES,
]);

/** The two decisions `fetch` makes once and hands down: is the path one of
 *  ours, and did the bearer check out. `handleRequest` answers from them in the
 *  order it always did (404, then 405, then 401) and never re-decides. */
interface Admission {
  known: boolean;
  authorized: boolean;
}

/** What this deploy carries, for the bot's boot probe: the fixed route set,
 *  plus `runMetrics:<dataset>` when the deploy bound the Analytics Engine
 *  dataset (run-metrics.md item 5) — the name from the `RUN_METRICS_DATASET`
 *  var rendered beside the binding, so the probe can compare it to the bot's. */
export function featuresOf(env: Pick<Env, "RUN_METRICS" | "RUN_METRICS_DATASET">): string[] {
  const features = ["memory", "schedules", "runs", "config", "delivery", "costs", "plane"];
  if (env.RUN_METRICS !== undefined) features.push(`runMetrics:${env.RUN_METRICS_DATASET ?? "unknown"}`);
  return features;
}

/** Every request, once `fetch` has decided whether it gets a root. */
async function handleRequest(request: Request, env: Env, admission: Admission): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET")
    return json({ ok: true, build: BUILD, features: featuresOf(env) });
  if (!admission.known) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!admission.authorized) return json({ error: "unauthorized" }, 401);

  // Size fence BEFORE parsing: a caller holding a valid bearer still can't
  // make us JSON-parse an oversized body just to be told 400 by the field
  // caps. Content-Length must be a plain digit string (RFC 9110) — that
  // rules out the absent header of a chunked/streamed body, a blank value,
  // and forms `Number()` would accept ("0x1000", "5e2", "12.5"); each is
  // 411 Length Required. A well-formed length over the cap is 413. Every
  // legitimate client (WorkerMemoryStore) sends a sized JSON body. The cap
  // is per route — decided AFTER routing and before the parse: /runs/put
  // carries a whole run record (budgeted to 1.5 MiB upstream) and gets 2 MiB;
  // every other route keeps the 512 KB fence.
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header.trim())) {
    return json({ error: "body must declare a numeric Content-Length" }, 411);
  }
  // The ledger's bulk routes carry a finished record, a transcript chunk, or
  // an event batch (32 × 64 KiB) and share /runs/put's fence; a delivery
  // snapshot carries a whole window of pull request facts and has its own.
  const maxBodyBytes = bodyFenceFor(url.pathname);
  if (Number(header) > maxBodyBytes) {
    return json({ error: `body must be at most ${maxBodyBytes} bytes` }, 413);
  }

  let body: unknown;
  if (url.pathname === "/runs/promotion/prepare" || url.pathname === "/runs/claim" || url.pathname === "/runs/state") {
    const header = url.pathname === "/runs/state" ? null : request.headers.get(EXPECTED_SEED_HEADER);
    const expectedSeed = header === null ? undefined : decodeExpectedSeedHeader(header);
    if (
      header !== null &&
      (url.pathname !== "/runs/promotion/prepare" ||
        !expectedSeed ||
        requestHeaderBytes(request.headers) > WORKER_REQUEST_HEADER_BYTES)
    )
      return json({ error: "invalid expected seed header" }, 400);
    try {
      const originalBody = await request.text();
      return handleLedger(url.pathname, JSON.parse(originalBody), env, originalBody, expectedSeed);
    } catch {
      return json({ error: "body must be valid JSON" }, 400);
    }
  }
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be valid JSON" }, 400);
  }

  if (url.pathname === "/schedules/record") {
    const parsed = parseScheduleFiring(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const firing = parsed.value;
    const retained = await env.SCHEDULES.get(env.SCHEDULES.idFromName(SCHEDULES_OBJECT)).record(firing);
    console.log(
      `[schedules/record] ${firing.schedule} ${firing.outcome}${firing.runId ? ` run ${firing.runId}` : ""} (${retained} retained)`,
    );
    return json({ ok: true, retained });
  }
  if (url.pathname === "/schedules/latest") {
    const firings = await env.SCHEDULES.get(env.SCHEDULES.idFromName(SCHEDULES_OBJECT)).latest();
    console.log(`[schedules/latest] -> ${firings.length} schedules`);
    return json({ firings });
  }
  if (url.pathname.startsWith("/runs/")) return handleRuns(url.pathname, body, env);
  if (url.pathname.startsWith("/plane/")) return handlePlane(url.pathname, body, env);
  if (url.pathname.startsWith("/config/")) return handleConfig(url.pathname, body, env);
  if (url.pathname.startsWith("/delivery/")) return handleDelivery(url.pathname, body, env);
  if (url.pathname.startsWith("/costs/")) return handleCosts(url.pathname, body, env);

  if (url.pathname === "/retrieve") {
    const parsed = parseRetrieve(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, query, limit } = parsed.value;
    const stub = env.MEMORY.get(env.MEMORY.idFromName(scopeKey));
    const records = await stub.retrieve(scopeKey, query, limit);
    // Observability (counts + scopeKey only, never record content/PII): makes
    // `wrangler tail switchboard-memory` show retrieve traffic and depth.
    console.log(`[retrieve] ${scopeKey} -> ${records.length} records`);
    return json({ records });
  }

  if (url.pathname === "/list") {
    const parsed = parseList(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, limit, query, kind } = parsed.value;
    const records = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).list(scopeKey, limit, query, kind);
    console.log(`[list] ${scopeKey} -> ${records.length} records`);
    return json({ records });
  }
  if (url.pathname === "/forget") {
    const parsed = parseForget(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, id } = parsed.value;
    const forgotten = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).forget(scopeKey, id);
    // Observability: scope + id only (ids carry no record text).
    console.log(`[forget] ${scopeKey} ${id} -> ${forgotten}`);
    return json({ ok: true, forgotten });
  }
  if (url.pathname === "/sweep") {
    const parsed = parseSweep(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, dryRun } = parsed.value;
    const out = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).sweep(scopeKey, dryRun);
    // Observability: scope + count only (ids carry no record text; they ride
    // the dryRun answer, not the log).
    console.log(`[sweep] ${scopeKey} -> ${out.swept}${dryRun ? " (dry run)" : ""}`);
    return json({ ok: true, swept: out.swept, ...(dryRun ? { ids: out.ids } : {}) });
  }

  const parsed = parseWrite(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { scopeKey, records, cap } = parsed.value;
  const stub = env.MEMORY.get(env.MEMORY.idFromName(scopeKey));
  const counts = await stub.write(scopeKey, records, cap);
  // Observability (counts + scopeKey only, never record content/PII): confirms
  // the reflection write fired, how many candidates it carried, and whether
  // the per-scope cap evicted anything.
  console.log(
    `[write] ${scopeKey} <- ${records.length} candidates${counts.evicted > 0 ? ` (evicted ${counts.evicted})` : ""}`,
  );
  return json({ ok: true, ...counts });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One `state.fetch` root per authenticated, routed request (docs/reference/specs/
    // tracing.md item 22), adopting the bot's trace context — never before the
    // bearer checked out, so a refusal, an unknown path or the unauthenticated
    // /healthz leaves no line and the route attr is always a word from ROUTES.
    const url = new URL(request.url);
    const admission: Admission = { known: ROUTES.has(url.pathname), authorized: authorized(env, request) };
    if (!admission.known || !admission.authorized) return handleRequest(request, env, admission);
    const root = startAdoptedRoot(tracer, "state.fetch", {
      sinks: traceSinks,
      traceparent: request.headers.get("traceparent"),
      attrs: { route: url.pathname },
    });
    try {
      const res = await handleRequest(request, env, admission);
      root.end(res.status >= 500 ? "error" : "ok", { httpStatus: res.status });
      return res;
    } catch (err) {
      if (err instanceof StateWriteBoundaryError) {
        root.fail(err.cause);
        root.end("error", {
          httpStatus: 500,
          stateWriteStage: err.diagnostic.failure.stage,
          requestDigest: err.diagnostic.requestDigest,
        });
        const response = json({ error: "run state mutation outcome unknown" }, 500);
        response.headers.set(STATE_WRITE_DIAGNOSTIC_HEADER, JSON.stringify(err.diagnostic));
        return response;
      }
      if (err instanceof PromotionPendingError) {
        root.end("ok", { httpStatus: 423 });
        return json({ kind: "held", reason: "promotion_pending", runId: err.runId }, 423);
      }
      root.fail(err);
      root.end("error");
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
