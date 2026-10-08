import { originalPromotionArchiveKey } from "./workspaceDurability.js";
import { RUN_STORE_KEY } from "../runStoreConstants.js";
import {
  SOURCE_SEED_RECORD_PREFIX,
  sourceSeedOriginalKey,
  sourceSeedOriginalOf,
  sourceSeedReferenceOfReceipt,
  type SourceSeedOriginalRecord,
} from "./seedVerification.js";
import {
  sourceSeedReleaseOf,
  confirmStoredSeedBoundary,
  promotionConfirmationRow,
  type SourceSeedReleaseReceipt,
  type PromotionConfirmationResult,
} from "./seedVerification.js";
import { bindInboxCustody } from "./inboxMessage.js";
import { closeInboxSegment, encodeInboxSegment, inboxSegmentFloor, type StepHistory } from "./inboxSegment.js";
import {
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
} from "./seedVerification.js";
import {
  expectedSeedManifestOf,
  expectedSeedMatchesClaim,
  seedContentHash,
  canonicalSeedJson,
  type ExpectedSeedManifest,
} from "./seedManifest.js";
import {
  validMaintenanceTransport,
  sameMaintenanceTransport,
  maintenanceEventsMatch,
  preserveMaintenanceEvent,
} from "../coordinator/maintenanceIdentity.js";
import { preserveCheckpointState } from "./checkpointState.js";
import { branchPublicationOf, doorPublicationOf } from "../branchPublication.js";
import {
  terminalWorkspaceSettlement,
  terminalWorkspaceRecordMatches,
  nextWorkspaceRevision,
  WORKSPACE_SETTLEMENTS_MAX,
  workspaceOwnerKey,
  workspaceAcknowledgment,
  type WorkspaceOwner,
  type WorkspaceSettlement,
  type WorkspaceAck,
} from "../workspaceSettlement.js";
import {
  checkpointMembersOf,
  checkpointMemberHashesOf,
  applyContextCheckpointAliases,
  planContextCheckpoint,
  validateContextCheckpoint,
  isContextCheckpointReceipt,
  type CanonicalCheckpointSource,
  type ContextCheckpointRequest,
  type ContextCheckpointResult,
} from "../references/contextCheckpoint.js";
import { contextDependenciesContain } from "../references/contextDependencies.js";
import type { CoordinatorReconcileReceipt } from "../coordinator/workflowReconciliation.js";
import {
  handoffRangePins,
  sessionRangesAvailable,
  sessionRowIsPinned,
  type SessionRangePins,
  type SessionRangePin,
} from "./sessionRangePins.js";
import { uncoveredSourceResult, verifiedSourceResults } from "../references/sourceResultContext.js";
import {
  isContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import {
  type SessionSources,
  mergeSessionSources,
  appendSessionContext,
  sourceHash,
  taintSessionSources,
  isSessionSources,
  sourcesBelongToSession,
} from "../references/receipts.js";
// The in-memory ledger: the reference implementation the bot's tests run
// against, applying the same pure decisions the Durable Object applies. It
// also documents the storage shape in the plainest form.

import { reviewPublicationOf } from "../reviewPublication.js";
import { allocationAckFromCanonical } from "./allocationAck.js";
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
} from "./promotion.js";
import {
  workspaceAllocationOf,
  workspaceDurabilityArchiveOf,
  workspaceDurabilityKey,
  sameWorkspaceAllocation,
  allocationMatchesRecord,
  prepareWorkspaceAllocation,
  workspaceAuthorityFieldsPresent,
  deriveWorkspaceDisposition,
  workspaceCustodyFingerprint,
  workspaceReportRowsMatch,
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
} from "./workspaceDurability.js";
import { INTAKE_DELIVERY_CLAIM_MS } from "../budgets.js";
import {
  branchPushReceiptsOf,
  MAX_RECORD_BYTES,
  utf8ByteLength,
  workEvidenceBelongsToRun,
  type RunRecord,
} from "../runRecord.js";
import type { UnitSeedReceipt } from "../coordinator/unitSeedReceipt.js";
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
} from "./decisions.js";
import {
  mergeRequesterTarget,
  type RequesterTarget,
  type FinishResult,
  type HeartbeatFacts,
  type HeartbeatResult,
  type RunLedger,
} from "./ledger.js";
import {
  causeOfClose,
  causeOfReclaim,
  type PlaneAckOutcome,
  type PlaneEffect,
  type PlaneAskAnswer,
  type PlaneEnding,
  type PlaneEndingCause,
  type PlaneOutcomePost,
  type PlaneQueueRow,
  type PlaneReclaimWord,
} from "../plane/decide.js";
import type { PlaneAdmitPost, PlaneLevelPost, PlaneObservePost } from "./ledger.js";
import {
  attachmentRefsOf,
  keyedAppendContextMatches,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  droppedToolResultRow,
  GAP_MARKER,
  planSessionTrim,
  storedRowRequiresFreshSources,
  roleOfStoredRow,
  rowKind,
  tailCut,
  textOfStoredRow,
  contextThreadSessionKey,
} from "./sessionLog.js";
import { tokenize } from "../memory/scorer.js";
import type { Notepad, SessionHit } from "./types.js";
import { assembleTranscript, turnRows, type AssembledTranscript } from "./transcript.js";
import type {
  AppendableEvent,
  ClaimRequest,
  ClaimResult,
  FenceResult,
  InboxItem,
  IntakeQuery,
  IntakeReceipt,
  IntakeWriteResult,
  LiveRunRow,
  LiveStateAssignRequest,
  LiveStateAssignResult,
  ReclaimedRun,
  RunJob,
  RunState,
  StepRecord,
  StopMode,
  TranscriptAttachment,
  TranscriptRow,
  TranscriptTurn,
} from "./types.js";

interface Transcript {
  ownerGen: string;
  rows: TranscriptRow[];
  attachments: TranscriptAttachment[];
}

/** One session log (docs/reference/specs/session-log.md): the rows of every run
 *  of a thread-and-agent session, the run whose writes land right now, and the
 *  byte budget the log is held to. */
export interface SessionLog {
  [key: `expected_seed_original:${string}`]: string | undefined;
  expectedSeedCurrent?: SourceSeedReference;
  expectedSeedPending?: SourceSeedReceipt;
  expectedSeedRelease?: SourceSeedReleaseReceipt;
  rangePins?: SessionRangePins;
  pinRevision?: number;
  custodyGuarded?: true;
  sources?: SessionSources;
  requiresFreshSources?: true;
  sourceStart?: number;
  sourceOwner?: string;
  pendingSourceOwner?: string;
  owner?: { runId: string; gen: string };
  rows: TranscriptRow[];
  attachments: TranscriptAttachment[];
  maxBytes: number;
  /** The `(idx, part)` keys the byte policy already replaced, so a pass never picks them again. */
  trimmed: Set<string>;
  /** Actor-stamped targets stay separate from turns and byte trimming. */
  requesterTargets?: Map<string, RequesterTarget>;
  /** The session's notepad (item 10), once a run wrote it. */
  notepad?: Notepad;
  /** The row ids the keyed append has seen (item 13), so a replay appends nothing twice. */
  rowIds?: Map<string, number>;
  rowHashes?: Map<string, string>;
}

/** A marker's bytes, for the trim plan's first estimate; the pass re-measures. */
const TRIM_MARKER_BYTES_ESTIMATE = 260;

export class InMemoryRunLedger implements RunLedger {
  originalPromotionBody(request: ClaimRequest): string {
    return JSON.stringify({ storeKey: RUN_STORE_KEY, run: request });
  }
  async observeExpectedSeed(key: string, from: number, through: number): Promise<SourceSeedSnapshot> {
    return this.sourceSeedSnapshot(key, from, through);
  }
  private sourceSeedRecords(key: string): SourceSeedOriginalRecord[] {
    const log = this.sessions.get(key);
    if (!log) return [];
    const records: SourceSeedOriginalRecord[] = [];
    for (const [name, raw] of Object.entries(log)) {
      if (!name.startsWith(SOURCE_SEED_RECORD_PREFIX)) continue;
      let record: SourceSeedOriginalRecord | undefined;
      try {
        record = typeof raw === "string" ? sourceSeedOriginalOf(JSON.parse(raw)) : undefined;
      } catch {
        /* Preserve unreadable metadata. */
      }
      if (!record || record.receipt.key !== key || sourceSeedOriginalKey(record.receipt) !== name)
        throw new SourceSeedPendingError(key, log.owner?.runId ?? "unknown");
      records.push(record);
    }
    if (log.expectedSeedPending !== undefined) {
      const receipt = sourceSeedReceiptOf(log.expectedSeedPending),
        release = log.expectedSeedRelease === undefined ? undefined : sourceSeedReleaseOf(log.expectedSeedRelease);
      if (
        !receipt ||
        receipt.key !== key ||
        (log.expectedSeedRelease !== undefined &&
          (!release || canonicalSeedJson(release.source) !== canonicalSeedJson(receipt)))
      )
        throw new SourceSeedPendingError(key, log.owner?.runId ?? "unknown");
      const saved = records.find((record) => sourceSeedOriginalKey(record.receipt) === sourceSeedOriginalKey(receipt));
      if (
        saved &&
        (canonicalSeedJson(saved.receipt) !== canonicalSeedJson(receipt) ||
          (release && canonicalSeedJson(saved.release) !== canonicalSeedJson(release)))
      )
        throw new SourceSeedPendingError(key, receipt.runId);
      if (!saved) records.push({ version: 1, receipt, ...(release ? { release } : {}) });
    }
    return records;
  }
  private sourceSeedRecord(key: string, ref: SourceSeedReference): SourceSeedOriginalRecord | undefined {
    const log = this.sessions.get(key);
    if (!log) return;
    const name = sourceSeedOriginalKey(ref),
      raw = log[name];
    if (raw !== undefined) {
      let record: SourceSeedOriginalRecord | undefined;
      try {
        record = sourceSeedOriginalOf(JSON.parse(raw));
      } catch {
        /* Preserve unreadable metadata. */
      }
      if (!record || record.receipt.key !== key || sourceSeedOriginalKey(record.receipt) !== name)
        throw new SourceSeedPendingError(key, log.owner?.runId ?? "unknown");
      return record;
    }
    if (log.expectedSeedPending === undefined) return;
    const receipt = sourceSeedReceiptOf(log.expectedSeedPending),
      release = log.expectedSeedRelease === undefined ? undefined : sourceSeedReleaseOf(log.expectedSeedRelease);
    if (
      !receipt ||
      (log.expectedSeedRelease !== undefined &&
        (!release || canonicalSeedJson(release.source) !== canonicalSeedJson(receipt)))
    )
      throw new SourceSeedPendingError(key, log.owner?.runId ?? "unknown");
    return sourceSeedOriginalKey(receipt) === name
      ? { version: 1, receipt, ...(release ? { release } : {}) }
      : undefined;
  }
  private currentSourceSeedRecord(key: string): SourceSeedOriginalRecord | undefined {
    const log = this.sessions.get(key);
    if (!log) return;
    if (log.expectedSeedCurrent !== undefined) {
      const ref = sourceSeedReferenceOf(log.expectedSeedCurrent),
        record = ref && this.sourceSeedRecord(key, ref);
      if (!record) throw new SourceSeedPendingError(key, log.owner?.runId ?? "unknown");
      return record;
    }
    if (Object.keys(log).some((name) => name.startsWith(SOURCE_SEED_RECORD_PREFIX)))
      throw new SourceSeedPendingError(key, log.owner?.runId ?? "unknown");
    return log.expectedSeedPending ? this.sourceSeedRecord(key, log.expectedSeedPending) : undefined;
  }
  private storedSourceSeedReceipt(key: string): SourceSeedReceipt | undefined {
    return this.currentSourceSeedRecord(key)?.receipt;
  }
  private sourceSeedPending(key: string): SourceSeedReceipt | undefined {
    const current = this.currentSourceSeedRecord(key),
      pending = this.sourceSeedRecords(key).filter((record) => !record.release);
    if (
      pending.some(
        (record) => !current || sourceSeedOriginalKey(record.receipt) !== sourceSeedOriginalKey(current.receipt),
      )
    )
      throw new SourceSeedPendingError(key, pending[0].receipt.runId);
    return current?.release ? undefined : current?.receipt;
  }
  private retainSourceSeedRecord(key: string, record: SourceSeedOriginalRecord): void {
    const log = this.sessions.get(key)!;
    log[sourceSeedOriginalKey(record.receipt)] = JSON.stringify(record);
    if (log.expectedSeedPending === undefined) log.expectedSeedPending = structuredClone(record.receipt);
    if (
      record.release &&
      sourceSeedOriginalKey(log.expectedSeedPending) === sourceSeedOriginalKey(record.receipt) &&
      log.expectedSeedRelease === undefined
    )
      log.expectedSeedRelease = structuredClone(record.release);
  }
  async releaseExpectedSeed(key: string, input: SourceSeedReference): Promise<SourceSeedResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref) return { kind: "held", reason: "mismatch" };
    const log = this.sessions.get(key),
      record = this.sourceSeedRecord(key, ref),
      stored = record?.receipt;
    if (!log || !stored || !sourceSeedReferenceMatches(stored, ref, key)) return { kind: "held", reason: "mismatch" };
    if (record?.release !== undefined) return this.readExpectedSeed(key, ref);
    const before = canonicalSeedJson({
      data: this.sourceSeedSnapshot(key, stored.from, stored.through),
      record: this.sourceSeedRecord(key, ref),
      current: log.expectedSeedCurrent,
      pins: log.rangePins,
      revision: log.pinRevision,
      guarded: log.custodyGuarded,
    });
    const actual = await this.readPromotion({ runId: ref.runId, gen: ref.gen, bodySha256: ref.bodySha256 });
    if (actual.kind !== "confirmed" || canonicalSeedJson(actual.receipt.source) !== canonicalSeedJson(stored))
      return { kind: "held", reason: "mismatch" };
    const verified = await this.readExpectedSeed(key, ref);
    if (
      verified.kind !== "verified" ||
      verified.release ||
      canonicalSeedJson(verified.receipt) !== canonicalSeedJson(stored) ||
      before !==
        canonicalSeedJson({
          data: this.sourceSeedSnapshot(key, stored.from, stored.through),
          record: this.sourceSeedRecord(key, ref),
          current: log.expectedSeedCurrent,
          pins: log.rangePins,
          revision: log.pinRevision,
          guarded: log.custodyGuarded,
        })
    )
      return { kind: "held", reason: "mismatch" };
    const release: SourceSeedReleaseReceipt = {
      version: 1,
      phase: "released",
      source: structuredClone(stored),
      confirmation: structuredClone(actual.receipt),
    };
    this.retainSourceSeedRecord(key, { version: 1, receipt: stored, release });
    return { kind: "verified", receipt: structuredClone(stored), release: structuredClone(release) };
  }
  async confirmPromotion(input: SourceSeedReference): Promise<PromotionConfirmationResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref) return { kind: "held", reason: "mismatch" };
    const original = await this.readPromotion({ runId: ref.runId, gen: ref.gen, bodySha256: ref.bodySha256 });
    if (original.kind === "confirmed")
      return sourceSeedReferenceMatches(original.receipt.source, ref, original.receipt.key)
        ? { kind: "confirmed", receipt: original.receipt }
        : { kind: "held", reason: "mismatch" };
    if (original.kind !== "committed" || !original.preparation.expectedSeed?.key)
      return { kind: "held", reason: "unsupported" };
    const row = structuredClone(this.live.get(ref.runId)!),
      steps = structuredClone(
        (this.steps.get(ref.runId) ?? []).slice(
          workspaceDurabilityArchiveOf(this.allocationArchive(ref.runId))?.promotionStepBase ?? 0,
        ),
      ),
      raw = structuredClone(this.allocationArchive(ref.runId));
    const before = canonicalSeedJson({ row: promotionConfirmationRow(row), steps, raw });
    const source = await this.readExpectedSeed(original.preparation.expectedSeed.key, ref);
    const receipt = await confirmStoredSeedBoundary(original, source, row, steps);
    if (
      !receipt ||
      before !==
        canonicalSeedJson({
          row: promotionConfirmationRow(this.live.get(ref.runId)),
          steps: (this.steps.get(ref.runId) ?? []).slice(
            workspaceDurabilityArchiveOf(this.allocationArchive(ref.runId))?.promotionStepBase ?? 0,
          ),
          raw: this.allocationArchive(ref.runId),
        })
    )
      return { kind: "held", reason: "mismatch" };
    const archive = workspaceDurabilityArchiveOf(raw)!;
    const next = { ...archive, promotionConfirmation: receipt };
    if (promotionBytes(JSON.stringify(next)) > MAX_RECORD_BYTES) return { kind: "held", reason: "oversize" };
    next.promotionAllocationAck = original.allocationAck;
    this.retainAllocation(next);
    return { kind: "confirmed", receipt: structuredClone(receipt) };
  }
  private sourceSeedSnapshot(key: string, from: number, through: number): SourceSeedSnapshot {
    const log = this.sessions.get(key),
      rows = (log?.rows ?? [])
        .filter((r) => r.idx >= from && r.idx <= through)
        .sort((a, b) => a.idx - b.idx || a.part - b.part);
    const refs = new Set(rows.flatMap((r) => attachmentRefsOf(r.json)));
    return structuredClone({
      rows: rows.map((r) => ({ ...r, trimmed: log?.trimmed.has(`${r.idx}:${r.part}`) ?? true })),
      attachments: (log?.attachments ?? []).filter((a) => refs.has(a.ref)),
      owner: log?.owner,
      next: log?.rows.length ? Math.max(...log.rows.map((r) => r.idx)) + 1 : 0,
      sources: log?.sources,
      context: log?.sources?.context,
      notepad: log?.notepad?.text ?? "",
    });
  }
  async verifyExpectedSeed(key: string, input: SourceSeedReference): Promise<SourceSeedResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref) return { kind: "held", reason: "mismatch" };
    if (this.sourceSeedRecord(key, ref)?.release) return this.readExpectedSeed(key, ref);
    const actual = await this.readPromotion({ runId: ref.runId, gen: ref.gen, bodySha256: ref.bodySha256 }),
      expected = authenticatedSeedExpectation(key, ref, actual);
    if (!expected) return { kind: "held", reason: "mismatch" };
    if (this.sourceSeedRecord(key, ref)) return this.readExpectedSeed(key, ref);
    const previous = this.currentSourceSeedRecord(key);
    if (previous && !previous.release) return { kind: "held", reason: "owner" };
    const previousBefore = canonicalSeedJson(previous ?? null);
    const snapshot = this.sourceSeedSnapshot(key, expected.from, expected.through),
      before = canonicalSeedJson(snapshot);
    const hashes = await verifiedSourceSeedHashes(snapshot, expected);
    if (!hashes) return { kind: "held", reason: "mismatch" };
    if (canonicalSeedJson(this.sourceSeedSnapshot(key, expected.from, expected.through)) !== before)
      return { kind: "held", reason: "mismatch" };
    const log = this.sessions.get(key)!;
    if (this.sourceSeedRecord(key, ref)) return this.readExpectedSeed(key, ref);
    if (canonicalSeedJson(this.currentSourceSeedRecord(key) ?? null) !== previousBefore)
      return { kind: "held", reason: "owner" };
    const revision = this.advanceMemoryPinRevision(log, true);
    if (revision === undefined) return { kind: "held", reason: "corrupt" };
    log.rangePins ??= {};
    log.rangePins[ref.runId] = [...(log.rangePins[ref.runId] ?? []), { from: expected.from, to: expected.through }];
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
    if (previous) this.retainSourceSeedRecord(key, previous);
    this.retainSourceSeedRecord(key, { version: 1, receipt });
    log.expectedSeedCurrent = sourceSeedReferenceOfReceipt(receipt);
    return { kind: "verified", receipt: structuredClone(receipt) };
  }
  async readExpectedSeed(key: string, input: SourceSeedReference): Promise<SourceSeedResult> {
    const ref = sourceSeedReferenceOf(input);
    if (!ref) return { kind: "held", reason: "mismatch" };
    let receipt: SourceSeedReceipt | undefined;
    try {
      receipt = this.sourceSeedRecord(key, ref)?.receipt;
    } catch {
      return { kind: "held", reason: "corrupt" };
    }
    if (!receipt) return { kind: "held", reason: "missing" };
    if (!sourceSeedReferenceMatches(receipt, ref, key)) return { kind: "held", reason: "mismatch" };
    const rawRelease = this.sourceSeedRecord(key, ref)?.release;
    if (rawRelease !== undefined) {
      const release = sourceSeedReleaseOf(rawRelease);
      return release && canonicalSeedJson(release.source) === canonicalSeedJson(receipt)
        ? { kind: "verified", receipt: structuredClone(receipt), release }
        : { kind: "held", reason: "corrupt" };
    }
    const actual = await this.readPromotion({ runId: ref.runId, gen: ref.gen, bodySha256: ref.bodySha256 }),
      expected = authenticatedSeedExpectation(key, ref, actual);
    if (!expected) return { kind: "held", reason: "mismatch" };
    const snapshot = this.sourceSeedSnapshot(key, expected.from, expected.through),
      before = canonicalSeedJson(snapshot),
      hashes = await verifiedSourceSeedHashes(snapshot, expected),
      log = this.sessions.get(key);
    if (
      !hashes ||
      canonicalSeedJson(this.sourceSeedSnapshot(key, expected.from, expected.through)) !== before ||
      canonicalSeedJson(this.sourceSeedRecord(key, ref)?.receipt) !== canonicalSeedJson(receipt) ||
      !log?.custodyGuarded ||
      !log.rangePins?.[ref.runId]?.some((r) => r.from === receipt!.from && r.to === receipt!.through) ||
      (log.pinRevision ?? 0) < receipt.pinRevision
    )
      return { kind: "held", reason: "corrupt" };
    return { kind: "verified", receipt: structuredClone(receipt) };
  }

  private promotionHeld(runId: string, gen?: string): boolean {
    if (gen !== undefined && this.live.get(runId)?.ownerGen !== gen) return false;
    const raw = this.allocationArchive(runId),
      archive = workspaceDurabilityArchiveOf(raw);
    if (raw === undefined) return false;
    if (!archive || promotionPending(raw)) return true;
    if (archive.promotionConfirmation) {
      try {
        const confirmation = archive.promotionConfirmation,
          release = this.sourceSeedRecord(confirmation.key, confirmation)?.release;
        return !release || canonicalSeedJson(release.confirmation) !== canonicalSeedJson(confirmation);
      } catch {
        return true;
      }
    }
    return false;
  }
  async preparePromotion(bodyJson: string, expectedSeedInput?: ExpectedSeedManifest): Promise<PromotionPrepareResult> {
    const req = promotionBodyOf(bodyJson);
    if (!req) return { kind: "held", reason: promotionBytes(bodyJson) > PROMOTION_BODY_BYTES ? "oversize" : "corrupt" };
    const expectedSeed = expectedSeedInput === undefined ? undefined : expectedSeedManifestOf(expectedSeedInput);
    const digest = await promotionBodyHash(bodyJson);
    if (expectedSeedInput !== undefined && (!expectedSeed || !expectedSeedMatchesClaim(expectedSeed, req, digest)))
      return { kind: "held", reason: "mismatch" };
    const expectedSeedSha256 = expectedSeed ? await seedContentHash(expectedSeed) : undefined;
    const row = this.live.get(req.runId),
      raw = this.allocationArchive(req.runId);
    if (!row || row.ownerGen !== req.gen) return { kind: "held", reason: "fenced" };
    if (row.stop === "hard") return { kind: "held", reason: "mismatch" };
    let archive = workspaceDurabilityArchiveOf(raw);
    if (!archive) return { kind: "held", reason: raw === undefined ? "legacy" : "corrupt" };
    if (archive.runId !== row.runId || archive.startedAt !== row.startedAt) return { kind: "held", reason: "mismatch" };
    if (
      !promotionMatchesOriginal(row, req, archive.allocation?.headSha) ||
      (req.meta.workspaceAllocation !== undefined &&
        !sameWorkspaceAllocation(req.meta.workspaceAllocation, archive.allocation))
    )
      return { kind: "held", reason: "mismatch" };
    if (
      archive.promotion &&
      archive.promotion.bodyJson !== bodyJson &&
      row.meta.restartOf === row.runId &&
      (row.phase === "attaching" || row.phase === "finishing") &&
      archive.promotionConfirmation &&
      archive.promotionAllocationAck &&
      !this.promotionHeld(row.runId, req.gen)
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
    if (archive.promotion)
      return archive.promotion.bodyJson === bodyJson &&
        archive.promotion.receipt.bodySha256 === digest &&
        archive.promotion.receipt.expectedSeedSha256 === expectedSeedSha256 &&
        canonicalSeedJson(archive.promotion.expectedSeed ?? null) === canonicalSeedJson(expectedSeed ?? null)
        ? { kind: "prepared", receipt: structuredClone(archive.promotion.receipt) }
        : { kind: "held", reason: "mismatch" };
    if (row.phase !== "attaching" && !(row.phase === "finishing" && row.meta.restartOf === row.runId))
      return { kind: "held", reason: "mismatch" };
    const receipt = promotionReceiptFromRow(row, digest, expectedSeedSha256);
    const next = {
      ...archive,
      promotion: { version: 1 as const, bodyJson, receipt, ...(expectedSeed ? { expectedSeed } : {}) },
      promotionStepBase: this.steps.get(req.runId)?.length ?? 0,
    };
    if (promotionBytes(JSON.stringify(next)) > MAX_RECORD_BYTES) return { kind: "held", reason: "oversize" };
    this.retainAllocation(next);
    return { kind: "prepared", receipt: structuredClone(receipt) };
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
    const row = this.live.get(query.runId),
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
    const current = this.live.get(query.runId);
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
  private readonly workspaceObligations = new Map<
    string,
    { revision: number; pending: Map<number, WorkspaceSettlement>; allocation?: WorkspaceDurabilityArchive }
  >();

  private historicalPromotion(runId: string, digest: string): WorkspaceDurabilityArchive | undefined {
    const value = this.workspaceObligations.get(originalPromotionArchiveKey(runId, digest));
    return value?.revision === 1 ? workspaceDurabilityArchiveOf(value.allocation) : undefined;
  }
  private retainPromotionOriginal(archive: WorkspaceDurabilityArchive): void {
    const digest = archive.promotion!.receipt.bodySha256,
      key = originalPromotionArchiveKey(archive.runId, digest),
      standing = this.workspaceObligations.get(key);
    if (standing && canonicalSeedJson(standing.allocation) !== canonicalSeedJson(archive))
      throw new PromotionPendingError(archive.runId, "corrupt");
    if (!standing)
      this.workspaceObligations.set(key, { revision: 1, pending: new Map(), allocation: structuredClone(archive) });
  }
  private allocationArchive(runId: string): unknown {
    const row = this.workspaceObligations.get(workspaceDurabilityKey(runId));
    if (row?.allocation !== undefined && row.revision !== 1)
      return { revision: row.revision, allocation: row.allocation };
    return row?.allocation;
  }
  private retainAllocation(value: WorkspaceDurabilityArchive): void {
    const key = workspaceDurabilityKey(value.runId);
    const row = this.workspaceObligations.get(key) ?? { revision: 1, pending: new Map<number, WorkspaceSettlement>() };
    row.allocation = structuredClone(value);
    this.workspaceObligations.set(key, row);
  }
  async workspaceDisposition(expected: WorkspaceAllocation): Promise<WorkspaceDispositionRead> {
    const stable = workspaceAllocationOf(expected);
    if (!stable) return { kind: "held", reason: "mismatch" };
    expected = stable;
    const live = () =>
      [...this.live.values()].some(
        (row) =>
          row.runId === expected.runId ||
          (row.state.binding as { sandboxKey?: unknown } | undefined)?.sandboxKey === expected.allocationKey,
      );
    if (live()) return { kind: "held", reason: "live" };
    const archive = workspaceDurabilityArchiveOf(this.allocationArchive(expected.runId));
    if (!archive?.allocation) return { kind: "held", reason: "unknown" };
    if (!sameWorkspaceAllocation(archive.allocation, expected)) return { kind: "held", reason: "mismatch" };
    if (!archive.disposition) return { kind: "held", reason: "unknown" };
    if (archive.disposition.kind === "scratch-custody-closed") {
      const c = archive.disposition.custody,
        log = this.sessions.get(c.sessionKey);
      const record = this.finished.get(expected.runId),
        lease = record?.events.find((e) => e.seq === c.leaseSeq && e.type === "lease"),
        report = record?.events.find((e) => e.seq === c.reportSeq && e.type === "answer");
      const reportReceipt = c.threadReport;
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
        reportReceipt.key !== contextThreadSessionKey(expected.threadKey) ||
        reportReceipt.threadKey !== expected.threadKey ||
        reportReceipt.rowId !== `run:${expected.runId}:answer`
      )
        return { kind: "held", reason: "custody-unavailable" };
      try {
        const loopRevision = await this.custodyPinRevision(c.sessionKey),
          reportRevision = await this.custodyPinRevision(reportReceipt.key);
        if (
          !loopRevision?.guarded ||
          loopRevision.revision < c.pinRevision ||
          !reportRevision?.guarded ||
          reportRevision.revision < reportReceipt.pinRevision ||
          !custodyPinProtectionOf(
            await this.protectCustodyRanges(c.sessionKey, expected.runId, [{ from: c.from, to: c.through }]),
          ) ||
          !custodyPinProtectionOf(
            await this.protectCustodyRanges(reportReceipt.key, expected.runId, [
              { from: reportReceipt.from, to: reportReceipt.through },
            ]),
          )
        )
          return { kind: "held", reason: "custody-unavailable" };
        const rows = structuredClone(log?.rows.filter((r) => r.idx >= c.from && r.idx <= c.through));
        const attachments = structuredClone(log?.attachments);
        const reportRows = await this.readSessionEntry(reportReceipt.key, reportReceipt.rowId);
        if (
          !log ||
          !rows ||
          !attachments ||
          !workspaceReportRowsMatch(reportRows, report.text) ||
          reportRows![0].idx !== reportReceipt.from ||
          (await sourceHash(reportRows)) !== reportReceipt.rowsHash ||
          !sessionRangesAvailable(
            log.rows.map((r) => ({ ...r, trimmed: log.trimmed.has(`${r.idx}:${r.part}`) })),
            [{ from: c.from, to: c.through }],
          ) ||
          (await sourceHash(assembleTranscript(rows, attachments, c.from))) !== c.transcriptHash ||
          JSON.stringify(await this.readSessionEntry(reportReceipt.key, reportReceipt.rowId)) !==
            JSON.stringify(reportRows) ||
          JSON.stringify(log.rows.filter((r) => r.idx >= c.from && r.idx <= c.through)) !== JSON.stringify(rows) ||
          JSON.stringify(log.attachments) !== JSON.stringify(attachments) ||
          live() ||
          JSON.stringify(this.allocationArchive(expected.runId)) !== JSON.stringify(archive)
        )
          return { kind: "held", reason: "custody-unavailable" };
      } catch {
        return { kind: "held", reason: "custody-unavailable" };
      }
    }
    return {
      kind: "terminal",
      allocation: structuredClone(archive.allocation),
      disposition: structuredClone(archive.disposition),
    };
  }

  private storedWorkspaceFacts(row: LiveRunRow): StoredWorkspaceCustody {
    const step = this.steps.get(row.runId)?.at(-1);
    const events = structuredClone(this.events.get(row.runId) ?? []);
    return {
      events,
      step: step && structuredClone(step),
      pendingEffects:
        (this.jobs.get(row.runId)?.length ?? 0) > 0 ||
        (this.inbox.get(row.runId) ?? []).some(unreadInbox(step ?? null)) ||
        row.state.pausedForRetry === true,
    };
  }
  private async workspaceCustody(row: LiveRunRow): Promise<StoredWorkspaceCustody> {
    const read = this.storedWorkspaceFacts(row),
      { events, step } = read;
    const base = {
      ...read,
      leaseHash: await sourceHash(events.find((e) => e.type === "lease") ?? null),
      reportHash: await sourceHash([...events].reverse().find((e) => e.type === "answer") ?? null),
    };
    const original = row.meta.session,
      log = original && this.sessions.get(original.key);
    if (
      !original ||
      original.range === "broken" ||
      !step ||
      !log ||
      log.owner?.runId !== row.runId ||
      log.owner.gen !== row.ownerGen
    )
      return base;
    const through = original.seedFrom + step.turnIndex - 1;
    if (
      through < original.seedFrom ||
      !sessionRangesAvailable(
        log.rows.map((r) => ({ ...r, trimmed: log.trimmed.has(`${r.idx}:${r.part}`) })),
        [{ from: original.seedFrom, to: through }],
      )
    )
      return base;
    try {
      const rows = structuredClone(log.rows.filter((r) => r.idx >= original.seedFrom && r.idx <= through));
      const attachments = structuredClone(log.attachments);
      const transcript = assembleTranscript(rows, attachments, original.seedFrom);
      if (!transcript.complete) return base;
      const loopPins = custodyPinProtectionOf(
        await this.protectCustodyRanges(original.key, row.runId, [{ from: original.seedFrom, to: through }]),
      );
      if (!loopPins) return base;
      const transcriptHash = await sourceHash(transcript);
      const answer = [...events].reverse().find((e) => e.type === "answer");
      const reportKey = contextThreadSessionKey(row.meta.threadKey),
        rowId = `run:${row.runId}:answer`;
      const reportRows = await this.readSessionEntry(reportKey, rowId);
      if (!answer || answer.type !== "answer" || !workspaceReportRowsMatch(reportRows, answer.text)) return base;
      const index = reportRows![0].idx;
      const reportPins = custodyPinProtectionOf(
        await this.protectCustodyRanges(reportKey, row.runId, [{ from: index, to: index }]),
      );
      if (!reportPins) return base;
      const rowsHash = await sourceHash(reportRows);
      const confirmedReport = await this.readSessionEntry(reportKey, rowId);
      if (
        JSON.stringify(confirmedReport) !== JSON.stringify(reportRows) ||
        log.owner?.runId !== row.runId ||
        log.owner.gen !== row.ownerGen ||
        JSON.stringify(log.rows.filter((r) => r.idx >= original.seedFrom && r.idx <= through)) !==
          JSON.stringify(rows) ||
        JSON.stringify(log.attachments) !== JSON.stringify(attachments) ||
        !sessionRangesAvailable(
          log.rows.map((r) => ({ ...r, trimmed: log.trimmed.has(`${r.idx}:${r.part}`) })),
          [{ from: original.seedFrom, to: through }],
        )
      )
        return base;
      return {
        ...base,
        session: {
          key: original.key,
          from: original.seedFrom,
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
      return base;
    }
  }

  /** Canonical private obligations, read synchronously by this ledger's paired store. */
  workspacePublicationRows(): WorkspaceSettlement[] {
    return [...this.workspaceObligations.values()].flatMap((row) => [...row.pending.values()]);
  }
  async workspaceSettlement(owner: WorkspaceOwner): Promise<WorkspaceSettlement | undefined> {
    if (this.live.has(owner.runId)) return;
    const value = this.workspaceObligations.get(workspaceOwnerKey(owner))?.pending.values().next().value;
    return value && structuredClone(value);
  }

  async ackWorkspaceSettlement(owner: WorkspaceOwner, revision: number): Promise<WorkspaceAck> {
    const key = workspaceOwnerKey(owner);
    const standing = this.workspaceObligations.get(key);
    const result = workspaceAcknowledgment(
      standing?.pending.get(revision),
      revision,
      this.live.has(owner.runId),
      standing?.revision,
    );
    if (result.ok) standing?.pending.delete(revision);
    return result;
  }
  private residentClaimFence = 0;
  async residentClaim(
    runId: string,
    gen: string,
    threadKey: string,
  ): Promise<{ ok: true; fence: number } | { ok: false; reason: "fenced" | "unknown-run" }> {
    const row = this.live.get(runId);
    if (!row) return { ok: false, reason: "unknown-run" };
    if (row.ownerGen !== gen || row.threadKey !== threadKey) return { ok: false, reason: "fenced" };
    return { ok: true, fence: ++this.residentClaimFence };
  }
  readonly live = new Map<string, LiveRunRow>();
  readonly steps = new Map<string, StepHistory>();
  readonly events = new Map<string, AppendableEvent[]>();
  readonly inbox = new Map<string, InboxItem[]>();
  readonly jobs = new Map<string, RunJob[]>();
  /** The transcript objects of runs claimed before the session log existed: a
   *  claim whose meta names no session. A run with a session has none. */
  readonly transcripts = new Map<string, Transcript>();
  readonly sessions = new Map<string, SessionLog>();
  readonly finished = new Map<string, RunRecord>();
  /** Mirrors private terminal producer evidence that cannot enter a typed record. */
  readonly finishedWorkEvidence = new Map<string, RunState>();
  readonly intake = new Map<string, IntakeReceipt>();
  readonly intakeDeliveries = new Map<string, { poster: string; claimUntil: number; delivered: boolean }>();
  /** The failure toggle (run-history item 59): tests flip a flag to make the
   *  next intake write or read throw, the way a lost Worker does. */
  readonly intakeFailure: { write?: boolean; read?: boolean } = {};
  /** Transaction failure injection for the reference live-state writer. The
   *  drafts must remain invisible when the commit point throws. */
  readonly liveStateFailure: { beforeCommit?: boolean } = {};

  constructor(private readonly now: () => number = Date.now) {}

  async custodyPinRevision(key: string): Promise<CustodyPinRevision | undefined> {
    const log = this.sessions.get(key);
    if (!log || (log.custodyGuarded && log.pinRevision === undefined) || !isCustodyRangePins(log.rangePins ?? {}))
      return;
    return custodyPinRevisionOf({ version: 1, revision: log.pinRevision ?? 0, guarded: log.custodyGuarded === true });
  }
  private advanceMemoryPinRevision(log: SessionLog, guarded = false): number | undefined {
    if ((log.custodyGuarded && log.pinRevision === undefined) || !isCustodyRangePins(log.rangePins ?? {})) return;
    const current = custodyPinRevisionOf({
      version: 1,
      revision: log.pinRevision ?? 0,
      guarded: log.custodyGuarded === true,
    });
    const next = current && nextCustodyPinRevision(current);
    if (next === undefined) return;
    log.pinRevision = next;
    if (guarded) log.custodyGuarded = true;
    return next;
  }
  async protectCustodyRanges(key: string, holder: string, ranges: readonly SessionRangePin[]) {
    const log = this.sessions.get(key);
    if (
      !log ||
      !isCustodyRangePins(log.rangePins ?? {}) ||
      !holder ||
      !Array.isArray(ranges) ||
      !ranges.length ||
      !sessionRangesAvailable(
        log.rows.map((row) => ({ ...row, trimmed: log.trimmed.has(`${row.idx}:${row.part}`) })),
        ranges,
      )
    )
      return { ok: false as const };
    const pins = structuredClone(log.rangePins ?? {});
    const previous = Object.hasOwn(pins, holder) ? pins[holder] : [];
    Object.defineProperty(pins, holder, {
      value: [...new Map([...previous, ...ranges].map((range) => [`${range.from}:${range.to}`, range])).values()],
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const revision = this.advanceMemoryPinRevision(log, true);
    if (revision === undefined) return { ok: false as const };
    log.rangePins = pins;
    return { ok: true as const, version: 1 as const, revision, guarded: true as const };
  }
  async retainRangePinsIfRevision(key: string, expected: CustodyPinRevision, holders: readonly string[]) {
    const log = this.sessions.get(key),
      proposed = custodyPinRevisionOf(expected),
      current = await this.custodyPinRevision(key);
    if (
      !log ||
      !proposed ||
      !current ||
      !Array.isArray(holders) ||
      !holders.every((holder) => typeof holder === "string" && holder.length > 0)
    )
      return { ok: false as const, reason: "unreadable" as const };
    // Re-read after the await: a new positive dependency invalidates this plan.
    const actual = custodyPinRevisionOf({
      version: 1,
      revision: log.pinRevision ?? 0,
      guarded: log.custodyGuarded === true,
    });
    if (!actual) return { ok: false as const, reason: "unreadable" as const };
    if (proposed.revision !== actual.revision || proposed.guarded !== actual.guarded)
      return { ok: false as const, reason: "revision-changed" as const, ...actual };
    const pins = structuredClone(log.rangePins ?? {}),
      allowed = new Set(holders);
    for (const { receipt: pending } of this.sourceSeedRecords(key)) {
      allowed.add(pending.runId);
      const held = pins[pending.runId] ?? [];
      pins[pending.runId] = held.some((range) => range.from === pending.from && range.to === pending.through)
        ? held
        : [...held, { from: pending.from, to: pending.through }];
    }
    for (const holder of Object.keys(pins)) if (!allowed.has(holder)) delete pins[holder];
    const revision = this.advanceMemoryPinRevision(log);
    if (revision === undefined) return { ok: false as const, reason: "unreadable" as const };
    log.rangePins = pins;
    return { ok: true as const, version: 1 as const, revision, guarded: actual.guarded };
  }
  async retainRangePins(key: string, holders: readonly string[]) {
    const current = await this.custodyPinRevision(key);
    if (!current) return { ok: false as const, reason: "unreadable" as const };
    if (current.guarded) return { ok: false as const, reason: "custody-protected" as const };
    return this.retainRangePinsIfRevision(key, current, holders);
  }

  private byThread(threadKey: string): LiveRunRow | undefined {
    for (const row of this.live.values()) if (row.threadKey === threadKey) return row;
    return undefined;
  }

  private fence(runId: string, gen: string): FenceResult {
    return checkFence(this.live.get(runId), gen);
  }

  private protectHandoff(req: ClaimRequest): void {
    const ranges = handoffRangePins(req.meta.childHandoff);
    for (const [key, pins] of ranges) {
      const log = this.sessions.get(key);
      if (
        !log ||
        !sessionRangesAvailable(
          log.rows.map((row) => ({ ...row, trimmed: log.trimmed.has(`${row.idx}:${row.part}`) })),
          pins,
        )
      )
        throw new Error("context source range is unavailable");
    }
    for (const [key, pins] of ranges) {
      const log = this.sessions.get(key)!;
      if (this.advanceMemoryPinRevision(log) === undefined) throw new Error("session pin revision is unreadable");
      log.rangePins ??= {};
      log.rangePins[req.runId] = pins;
    }
  }

  /** A request restart keeps the first receipt even after its predecessor closed. */
  private preserveArchivedBaseline(
    runId: string,
    incoming: RunState,
    owner: Parameters<typeof workEvidenceBelongsToRun>[1],
  ): RunState | undefined {
    const record = this.finished.get(runId);
    const evidence = this.finishedWorkEvidence.get(runId);
    const baseline =
      evidence && Object.hasOwn(evidence, "branchIdentityBaseline")
        ? evidence.branchIdentityBaseline
        : record?.branchIdentityBaseline;
    if (baseline === undefined) return incoming;
    if (
      !record ||
      record.id !== runId ||
      !workEvidenceBelongsToRun({ branchIdentityBaseline: baseline }, record) ||
      (record.branchIdentityBaseline !== undefined &&
        JSON.stringify(record.branchIdentityBaseline) !== JSON.stringify(baseline))
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
    const target = owner as typeof owner & { ref?: unknown; baseRef?: unknown };
    if (
      (target.ref !== undefined && target.ref !== binding.branch) ||
      (target.baseRef !== undefined && target.baseRef !== binding.base)
    )
      return undefined;
    return { ...incoming, ...retained };
  }

  async claim(req: ClaimRequest, originalBodyJson?: string): Promise<ClaimResult> {
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
      const original = preparedPromotionClaim(req, originalBodyJson, digest, this.live.get(req.runId), archive);
      if (!original) throw new PromotionPendingError(req.runId);
      req = original;
      if (archive?.promotionCommit) {
        const allocationAck = allocationAckFromCanonical(this.allocationArchive(req.runId), this.live.get(req.runId));
        if (!allocationAck) throw new PromotionPendingError(req.runId, "corrupt");
        return { ok: true, allocationAck, promotionCommit: structuredClone(archive.promotionCommit) };
      }
    }
    if (Object.hasOwn(req.meta, "workspaceDisposition")) throw new Error("workspace disposition is store-derived");
    if (workspaceAuthorityFieldsPresent(req.state))
      throw new Error("workspace allocation cannot be written as mutable state");
    const existing = this.byThread(req.threadKey);
    if (
      existing?.runId === req.runId &&
      existing.ownerGen === req.gen &&
      req.phase === "attaching" &&
      req.meta.restartOf === req.runId &&
      (existing.phase === "finishing" || existing.phase === "live") &&
      !this.promotionHeld(req.runId, req.gen)
    ) {
      existing.phase = "attaching";
      existing.meta = { ...existing.meta, restartOf: req.runId };
    }

    const allocation = prepareWorkspaceAllocation(
      req.runId,
      req.meta,
      this.allocationArchive(req.runId),
      this.live.has(req.runId) || (this.finished.has(req.runId) && this.finished.get(req.runId)?.provisional !== true),
      req.startedAt,
    );
    req = {
      ...req,
      meta: structuredClone({
        ...req.meta,
        ...(allocation?.allocation ? { workspaceAllocation: allocation.allocation } : {}),
      }),
    };
    const original = this.live.get(req.runId)?.meta ?? this.finished.get(req.runId);
    if (!validMaintenanceTransport(req.meta) || (original && !sameMaintenanceTransport(original, req.meta)))
      throw new Error("maintenance transport identity conflicts with retained state");
    const restored = this.preserveArchivedBaseline(req.runId, req.state ?? {}, { id: req.runId, ...req.meta });
    const state = restored && preserveCheckpointState(existing?.runId === req.runId ? existing.state : {}, restored);
    if (!state) throw new Error("checkpoint state is immutable");
    if (!workEvidenceBelongsToRun(state, { id: req.runId, ...req.meta }))
      throw new Error("work evidence does not match its canonical run");
    req = { ...req, state };
    const decision = decideClaim(
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
    if (!decision.ok) return decision;
    const acknowledged = (): ClaimResult => {
      const allocationAck = allocationAckFromCanonical(this.allocationArchive(req.runId), this.live.get(req.runId));
      const promotionCommit =
        req.phase === "attaching"
          ? undefined
          : workspaceDurabilityArchiveOf(this.allocationArchive(req.runId))?.promotionCommit;
      return {
        ok: true,
        ...(allocationAck ? { allocationAck } : {}),
        ...(promotionCommit ? { promotionCommit: structuredClone(promotionCommit) } : {}),
      };
    };
    if (existing && state.branchIdentityBaseline !== undefined && existing.state.branchIdentityBaseline === undefined)
      existing.state = { ...existing.state, branchIdentityBaseline: structuredClone(state.branchIdentityBaseline) };
    switch (decideClaimWrite(existing, req)) {
      case "keep":
        return acknowledged(); // idempotent re-claim
      case "refresh":
        existing!.leaseUntil = this.now() + req.leaseMs;
        return acknowledged();
      case "promote":
        if (
          allocation?.promotion &&
          digest &&
          promotionBytes(
            JSON.stringify({
              ...allocation,
              promotionCommit: promotionCommitFromRow(existing!, digest, actualSeedSha256),
            }),
          ) > MAX_RECORD_BYTES
        )
          throw new PromotionPendingError(req.runId);
        this.protectHandoff(req);
        if (allocation) this.retainAllocation(allocation);
        Object.assign(existing!, {
          leaseUntil: this.now() + req.leaseMs,
          phase: "live",
          meta: req.meta,
          card: req.card ?? null,
          system: req.system,
          tools: req.tools,
          state: { ...existing!.state, ...state },
        });
        if (allocation?.promotion && digest)
          this.retainAllocation({
            ...allocation,
            promotionCommit: promotionCommitFromRow(existing!, digest, actualSeedSha256),
          });
        return acknowledged();
      case "insert":
        break;
    }
    this.protectHandoff(req);
    if (allocation) this.retainAllocation(allocation);
    this.live.set(req.runId, {
      runId: req.runId,
      threadKey: req.threadKey,
      ownerGen: req.gen,
      leaseUntil: this.now() + req.leaseMs,
      startedAt: req.startedAt,
      phase: req.phase ?? "live",
      stop: null,
      meta: req.meta,
      card: req.card ?? null,
      system: req.system,
      tools: req.tools,
      state,
    });
    // A new live segment starts without a live-event table. Clear any prior
    // generation's entries, then let the first append create the table so its
    // absence still means that a pending event batch has not flushed.
    this.events.delete(req.runId);
    // A row with a session owns nothing but its log — the Worker never owns a
    // per-run transcript object for a new claim, so a write of such a run that
    // misses the log is refused here as it is live. A claim without a session
    // models a row from before the log existed: it owns its own object.
    if (!req.meta.session) this.transcripts.set(req.runId, { ownerGen: req.gen, rows: [], attachments: [] });
    return acknowledged();
  }

  /** The rows of `turns`, into `target` under the same `(idx, part)` upsert the objects apply. */
  private static append(
    target: { rows: TranscriptRow[]; attachments: TranscriptAttachment[] },
    turns: TranscriptTurn[],
  ) {
    for (const turn of turns) {
      const actor = "message" in turn ? turn.actor : undefined;
      const { rows, attachments } = turnRows(
        turn.idx,
        "message" in turn ? turn.message : { compaction: turn.compaction },
        {},
        actor,
      );
      for (const row of rows) {
        const at = target.rows.findIndex((r) => r.idx === row.idx && r.part === row.part);
        if (at >= 0) target.rows[at] = row;
        else target.rows.push(row);
      }
      target.attachments.push(...attachments);
    }
  }

  private async writeTurns(
    runId: string,
    gen: string,
    turns: TranscriptTurn[],
    session?: string,
    seed = false,
  ): Promise<FenceResult> {
    const frozen = structuredClone(turns);
    const incoming = frozen.flatMap(
      (t) =>
        turnRows(
          t.idx,
          "message" in t ? t.message : { compaction: t.compaction },
          {},
          "message" in t ? t.actor : undefined,
        ).rows,
    );
    const verified = await verifiedSourceResults(incoming);

    if (session !== undefined) {
      const log = this.sessions.get(session);
      const pending = this.sourceSeedPending(session);
      if (pending) {
        const attachments = frozen.flatMap(
          (t) =>
            turnRows(
              t.idx,
              "message" in t ? t.message : { compaction: t.compaction },
              {},
              "message" in t ? t.actor : undefined,
            ).attachments,
        );
        if (
          log?.owner?.runId === runId &&
          log.owner.gen === gen &&
          incoming.every((r) =>
            log.rows.some((old) => old.idx === r.idx && old.part === r.part && old.json === r.json),
          ) &&
          attachments.every((a) =>
            log.attachments.some((old) => old.ref === a.ref && old.mediaType === a.mediaType && old.data === a.data),
          )
        )
          return { ok: true };
        throw new SourceSeedPendingError(session, pending.runId);
      }
      if (!log?.owner) return { ok: false, reason: "unknown-run" };
      if (log.owner.gen !== gen || log.owner.runId !== runId) return { ok: false, reason: "fenced" };
      for (const row of incoming) {
        if (!sessionRowIsPinned(log.rangePins ?? {}, row.idx)) continue;
        if (log.rows.find((original) => original.idx === row.idx && original.part === row.part)?.json !== row.json)
          return { ok: false, reason: "fenced" };
      }
      if (log.sources && turns.length && log.sourceOwner !== `${log.owner.runId}:${gen}`)
        log.pendingSourceOwner = `${log.owner.runId}:${gen}`;
      if (
        log.sources?.context &&
        uncoveredSourceResult(log.rows, incoming, log.sources.context, seed ? undefined : runId, verified)
      )
        log.sources = taintSessionSources(log.sources);
      InMemoryRunLedger.append(log, frozen);
      if (log.rows.some((r) => storedRowRequiresFreshSources(r.json))) log.requiresFreshSources = true;
      this.enforceBytePolicy(session);
      return { ok: true };
    }
    const t = this.transcripts.get(runId);
    if (!t) return { ok: false, reason: "unknown-run" };
    if (t.ownerGen !== gen) return { ok: false, reason: "fenced" };
    InMemoryRunLedger.append(t, frozen);
    return { ok: true };
  }

  readonly checkpointMembers = new Map<string, readonly string[]>();
  readonly checkpointMemberHashes = new Map<string, Readonly<Record<string, string>>>();

  private async checkpointSource(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    const live = this.live.get(runId);
    const archived = this.finished.get(runId);
    const meta = live?.meta ?? archived;
    const context = live?.state.contextDependencies ?? archived?.contextDependencies;
    if (!meta || !isContextDependencies(context)) return undefined;
    const value = live?.state.contextCheckpointReceipt ?? archived?.contextCheckpointReceipt;
    const receipt = isContextCheckpointReceipt(value) ? value : undefined;
    return {
      runId,
      meta: structuredClone(meta),
      context: structuredClone(context),
      ...(receipt
        ? {
            receipt: structuredClone(receipt),
            transcriptHash: await sourceHash(
              await this.readSession(receipt.session.key, receipt.session.seedFrom, receipt.session.through),
            ),
            members: [...(this.checkpointMembers.get(runId) ?? [])],
            memberCheckpoints: { ...(this.checkpointMemberHashes.get(runId) ?? {}) },
          }
        : {}),
    };
  }

  async readContextCheckpoint(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    const source = await this.checkpointSource(runId);
    return source?.receipt && (await validateContextCheckpoint(source.receipt, source)) ? source : undefined;
  }

  async normalizeContextOrigins(
    request: ContextCheckpointRequest,
    expectedSession?: Readonly<import("../references/contextCheckpoint.js").ContextCheckpointSession>,
  ): Promise<ContextCheckpointResult> {
    const pending = this.sourceSeedPending(request.key);
    if (pending) throw new SourceSeedPendingError(request.key, pending.runId);
    const row = this.live.get(request.runId);
    const fence = checkFence(row, request.gen);
    if (!fence.ok) return fence;
    if (!row) return { ok: false, reason: "unknown-run" };
    const unavailable = (): ContextCheckpointResult => ({ ok: false, reason: "checkpoint-unavailable" });
    if (expectedSession !== undefined) {
      const session = row.meta.session;
      const receipt = row.state.contextCheckpointReceipt ?? row.state.pendingContextCheckpoint;
      const last = this.steps.get(request.runId)?.at(-1);
      const actual = isContextCheckpointReceipt(receipt)
        ? receipt.session
        : session && session.range !== "broken" && last
          ? {
              key: session.key,
              seedFrom: session.seedFrom,
              request: session.request,
              from: session.range.from,
              through: session.seedFrom + last.turnIndex - 1,
            }
          : undefined;
      if (
        !actual ||
        (["key", "seedFrom", "request", "from", "through"] as const).some((key) => actual[key] !== expectedSession[key])
      )
        return unavailable();
    }
    const committed = await this.readContextCheckpoint(request.runId);
    if (committed?.receipt) return { ok: true, receipt: committed.receipt };
    const log = this.sessions.get(request.key);
    const session = row.meta.session;
    const last = this.steps.get(request.runId)?.at(-1);
    if (
      !session ||
      session.key !== request.key ||
      session.range === "broken" ||
      !last ||
      last.step !== 0 ||
      last.inFlight.length ||
      log?.owner?.runId !== request.runId ||
      log.owner.gen !== request.gen ||
      !isContextDependencies(log.sources?.context) ||
      !isContextDependencies(row.state.contextDependencies) ||
      !contextDependenciesContain(log.sources.context, row.state.contextDependencies)
    )
      return unavailable();
    const through = session.seedFrom + last.turnIndex - 1;
    const checkpoint = row.state.contextCheckpoint as { key?: string; through?: number } | undefined;
    if (
      (checkpoint && (checkpoint.key !== request.key || checkpoint.through !== through)) ||
      (await this.sessionTail(request.key)) !== through + 1
    )
      return unavailable();
    const before = JSON.stringify({ row, log, last });
    const transcript = await this.readSession(request.key, session.seedFrom, through);
    const inputs = {
      transcriptHash: await sourceHash(transcript),
      systemHash: await sourceHash(row.system),
      notepadHash: await sourceHash(log.notepad?.text ?? ""),
    };
    const sources = (
      await Promise.all(
        log.sources.context.origins
          .filter((origin) => origin.runId !== row.runId)
          .map((origin) => this.checkpointSource(origin.runId)),
      )
    ).filter((source): source is CanonicalCheckpointSource => source !== undefined);
    const receipt = await planContextCheckpoint({
      run: { runId: row.runId, meta: row.meta, context: log.sources.context },
      ownerGen: request.gen,
      through,
      inputs,
      expected: request.expected,
      sources,
    });
    if (
      !receipt ||
      before !== JSON.stringify({ row, log, last }) ||
      this.live.get(request.runId) !== row ||
      row.ownerGen !== request.gen ||
      !sessionRangesAvailable(
        log.rows.map((part) => ({ ...part, trimmed: log.trimmed.has(`${part.idx}:${part.part}`) })),
        [{ from: session.seedFrom, to: through }],
      )
    )
      return unavailable();
    if (this.advanceMemoryPinRevision(log) === undefined) return unavailable();
    this.checkpointMembers.set(row.runId, checkpointMembersOf(row.runId, receipt.coveredOrigins, sources));
    this.checkpointMemberHashes.set(row.runId, checkpointMemberHashesOf(row.runId, receipt.coveredOrigins, sources));
    log.rangePins ??= {};
    log.rangePins[row.runId] = [{ from: session.seedFrom, to: through }];
    log.sources = { ...log.sources, context: structuredClone(receipt.normalized) };
    row.state = {
      ...row.state,
      contextDependencies: structuredClone(receipt.normalized),
      contextCheckpointReceipt: structuredClone(receipt),
    };
    return { ok: true, receipt };
  }

  async writeSessionSources(key: string, runId: string, gen: string, sources: SessionSources): Promise<FenceResult> {
    const pending = this.sourceSeedPending(key);
    if (pending) {
      if (
        pending.runId === runId &&
        pending.gen === gen &&
        canonicalSeedJson(this.sessions.get(key)?.sources) === canonicalSeedJson(sources)
      )
        return { ok: true };
      throw new SourceSeedPendingError(key, pending.runId);
    }
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.gen !== gen || log.owner.runId !== runId) return { ok: false, reason: "fenced" };
    const row = this.live.get(runId);
    const owner =
      row === undefined
        ? undefined
        : row.ownerGen === gen && row.meta.session?.key === key
          ? { key, threadKey: row.meta.threadKey, channelId: row.meta.channelId, requester: row.meta.userId }
          : null;
    if (!isSessionSources(sources) || !sourcesBelongToSession(key, sources, owner))
      return { ok: false, reason: "fenced" };
    if (log.pendingSourceOwner && log.pendingSourceOwner !== `${runId}:${gen}`)
      log.sources = taintSessionSources(log.sources);
    log.sources = structuredClone(mergeSessionSources(log.sources, sources, log.sourceStart === 0));
    if (JSON.stringify(log.sources) !== JSON.stringify(sources)) return { ok: false, reason: "fenced" };
    log.sourceOwner = `${runId}:${gen}`;
    delete log.pendingSourceOwner;
    return { ok: true };
  }

  async seed(runId: string, gen: string, turns: TranscriptTurn[], session?: string): Promise<FenceResult> {
    return this.writeTurns(runId, gen, turns, session, true);
  }

  async step(
    runId: string,
    gen: string,
    record: StepRecord,
    turns: TranscriptTurn[],
    session?: string,
  ): Promise<FenceResult> {
    if (!Number.isSafeInteger(record.step) || record.step < 0) throw new Error("invalid public step key");
    const owner = this.live.get(runId);
    if (owner && inboxSegmentFloor(this.steps.get(runId)?.inboxSegmentArchive, owner) === undefined)
      throw new Error("retained inbox segment boundary is unreadable");
    const written = await this.writeTurns(runId, gen, turns, session);
    if (!written.ok) return written;
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    const list = this.steps.get(runId) ?? [];
    const base = workspaceDurabilityArchiveOf(this.allocationArchive(runId))?.promotionStepBase ?? 0;
    const index = base + record.step;
    if (index < list.length) list[index] = record;
    else list.push(record);
    this.steps.set(runId, list);
    return { ok: true };
  }

  /** The heartbeat facts each beat carried, kept for assertions (record 0064). */
  readonly heartbeatFacts: Array<{ runId: string; facts?: HeartbeatFacts }> = [];

  async heartbeat(runId: string, gen: string, leaseMs: number, facts?: HeartbeatFacts): Promise<HeartbeatResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    this.heartbeatFacts.push({ runId, ...(facts !== undefined ? { facts } : {}) });
    row.leaseUntil = this.now() + leaseMs;
    // The in-memory ledger offers no plane effects; the field is present like
    // the Worker's answer (orchestration-plane; record 0064; orchestration-plane item 7).
    return { ok: true, stop: row.stop, phase: row.phase, effects: [] };
  }

  /** The shadow posts and the acks, kept for assertions (orchestration-plane items 7 and 8). */
  readonly planeOutcomes: PlaneOutcomePost[] = [];
  readonly planeAcks: Array<{ id: string; outcome: PlaneAckOutcome; reconciliation?: CoordinatorReconcileReceipt }> =
    [];
  /** The same outbox seam as the Worker; reconciliation remains open until
   * durable report obligations can be verified, which this double cannot infer. */
  readonly planeOffers = new Map<string, PlaneEffect>();

  async planeOutcome(post: PlaneOutcomePost): Promise<{ ok: boolean; decider?: string; agreed?: boolean | null }> {
    this.planeOutcomes.push(post);
    return { ok: true };
  }

  async planeFenceSteer(_id: string, runId: string, gen: string, leaseMs: number): Promise<boolean> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || row?.phase !== "live") return false;
    row.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async planeAck(
    id: string,
    outcome: PlaneAckOutcome,
    _owner?: { runId: string; gen: string },
    reconciliation?: CoordinatorReconcileReceipt,
  ): Promise<void> {
    this.planeAcks.push({
      id,
      outcome,
      ...(reconciliation ? { reconciliation: structuredClone(reconciliation) } : {}),
    });
  }

  /** The admission asks, kept for assertions; the answer is settable per test
   *  (default: admitted — an empty plane holds nothing). */
  readonly planeAdmits: PlaneAdmitPost[] = [];
  planeAdmitAnswer: PlaneAskAnswer | undefined;
  readonly planeWithdraws: string[] = [];
  planeWithdrawAnswer = false;

  async planeAdmit(post: PlaneAdmitPost): Promise<PlaneAskAnswer> {
    this.planeAdmits.push(post);
    return this.planeAdmitAnswer ?? { kind: "admitted", reservation: `resv-${this.planeAdmits.length}` };
  }

  async planeWithdraw(runId: string): Promise<{ withdrawn: boolean }> {
    this.planeWithdraws.push(runId);
    return { withdrawn: this.planeWithdrawAnswer };
  }

  /** The level reports and observations, kept for assertions (record 0064/record 0064). */
  readonly planeLevels: PlaneLevelPost[] = [];
  readonly planeObservations: PlaneObservePost[] = [];
  planeObserveAnswer = false;

  async planeLevel(post: PlaneLevelPost): Promise<void> {
    this.planeLevels.push(post);
  }

  /** The parks, kept for assertions (record 0064). */
  readonly planeParks: Array<{ runId: string; provider: string }> = [];

  async planePark(runId: string, provider: string): Promise<void> {
    this.planeParks.push({ runId, provider });
  }

  async planeObserve(post: PlaneObservePost): Promise<{ reentered: boolean }> {
    this.planeObservations.push(post);
    return { reentered: this.planeObserveAnswer };
  }

  /** Settable per test: the queued row `planeQueued` answers (default none). */
  planeQueuedRows = new Map<string, PlaneQueueRow>();

  async planeQueued(runId: string): Promise<PlaneQueueRow | null> {
    return this.planeQueuedRows.get(runId) ?? null;
  }

  /** The reclaim outcome reports, kept for assertions (record 0064): only a
   *  `closed` row records an ending — the reference applies `causeOfReclaim`
   *  exactly as the object does. */
  readonly planeReclaims: Array<{ runId: string; outcome: PlaneReclaimWord }> = [];

  async planeReclaimed(
    outcomes: readonly { runId: string; outcome: PlaneReclaimWord }[],
  ): Promise<{ runId: string; cause: PlaneEndingCause }[]> {
    const recorded: { runId: string; cause: PlaneEndingCause }[] = [];
    for (const o of outcomes) {
      this.planeReclaims.push({ ...o });
      const cause = causeOfReclaim(o.outcome);
      if (cause === undefined) continue;
      if (!this.planeEndings.has(o.runId)) this.planeEndings.set(o.runId, { kind: "interrupted", cause, at: 0 });
      recorded.push({ runId: o.runId, cause: this.planeEndings.get(o.runId)!.cause });
    }
    return recorded;
  }

  /** The endings the plane recorded (record 0064): one per closed row, the
   *  first cause standing — what the reference keeps for assertions. */
  readonly planeEndings = new Map<string, PlaneEnding>();

  async append(runId: string, gen: string, events: AppendableEvent[]): Promise<FenceResult> {
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    if (!maintenanceEventsMatch(this.live.get(runId)!.meta, events)) return { ok: false, reason: "fenced" };
    const list = this.events.get(runId) ?? [];
    const originalMeta = this.live.get(runId)!.meta;
    if (originalMeta.maintenanceActionId !== undefined) {
      const previousBySeq = new Map(list.map((event) => [event.seq, event]));
      for (const event of events) {
        if (!preserveMaintenanceEvent(originalMeta, previousBySeq.get(event.seq), event))
          return { ok: false, reason: "fenced" };
        previousBySeq.set(event.seq, event);
      }
    }
    list.push(...events);
    this.events.set(runId, list);
    return { ok: true };
  }

  async assignLiveState(
    runId: string,
    gen: string,
    assignment: LiveStateAssignRequest,
  ): Promise<LiveStateAssignResult> {
    if (workspaceAuthorityFieldsPresent(assignment.statePatch)) return { ok: false, reason: "fenced" };
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok) return fence;
    if (!row) return { ok: false, reason: "unknown-run" };
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    if (!preserveCheckpointState(row.state, assignment.statePatch ?? {})) return { ok: false, reason: "fenced" };
    if (!workEvidenceBelongsToRun({ ...row.state, ...assignment.statePatch }, { id: row.runId, ...row.meta }))
      return { ok: false, reason: "fenced" };
    const result = assignLedgerLiveState(row.liveState, row.liveStateSeq ?? 0, assignment);
    if (!result.ok) return result;
    let liveStateSeq = row.liveStateSeq ?? 0;
    const events = [...(this.events.get(runId) ?? [])];
    let lastEventSeq = Math.max(0, ...events.map((event) => event.seq));
    for (const source of assignment.sourceEvents ?? []) {
      if (source.seq <= lastEventSeq) return { ok: false, reason: "stale-sequence" };
      lastEventSeq = source.seq;
    }
    const boundarySeq = result.event ? (assignment.eventSeq ?? lastEventSeq + 1) : undefined;
    if (boundarySeq !== undefined && boundarySeq <= lastEventSeq) return { ok: false, reason: "stale-sequence" };
    for (const source of assignment.sourceEvents ?? []) {
      events.push(source);
      liveStateSeq = source.seq;
    }
    if (result.event && boundarySeq !== undefined) {
      liveStateSeq = boundarySeq;
      events.push({ ...result.event, seq: liveStateSeq });
    }
    if (this.liveStateFailure.beforeCommit) throw new Error("live-state commit failed");
    if ((assignment.sourceEvents?.length ?? 0) > 0 || result.event) this.events.set(runId, events);
    const preserved = preserveCheckpointState(row.state, {
      ...row.state,
      ...assignment.statePatch,
      liveState: result.liveState,
      liveStateSeq,
    });
    if (!preserved) return { ok: false, reason: "fenced" };
    row.state = preserved;
    row.liveState = result.liveState;
    row.liveStateSeq = liveStateSeq;
    return {
      ...result,
      ...(result.event ? { event: { ...result.event, seq: liveStateSeq } } : {}),
      liveStateSeq,
    };
  }

  async setState(runId: string, gen: string, state: RunState): Promise<FenceResult> {
    if (workspaceAuthorityFieldsPresent(state)) return { ok: false, reason: "fenced" };
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    const restored = this.preserveArchivedBaseline(runId, state, { id: runId, ...row.meta });
    if (!restored) return { ok: false, reason: "fenced" };
    state = restored;
    const mintSeed = state.unitSeedReceipt !== undefined && row.state.unitSeedReceipt === undefined;
    const preserved = preserveCheckpointState(row.state, state, mintSeed);
    if (!preserved) return { ok: false, reason: "fenced" };
    if (!workEvidenceBelongsToRun(preserved, { id: row.runId, ...row.meta })) return { ok: false, reason: "fenced" };
    if (mintSeed) {
      const receipt = preserved.unitSeedReceipt as UnitSeedReceipt;
      const checkpoint = row.state.contextCheckpoint as { key?: string; through?: number } | undefined;
      const last = this.steps.get(runId)?.at(-1);
      const log = this.sessions.get(receipt.seed.key);
      if (
        receipt.ownerGen !== gen ||
        checkpoint?.key !== receipt.seed.key ||
        checkpoint.through !== receipt.seed.through ||
        !last ||
        last.step !== 0 ||
        last.inFlight.length ||
        receipt.seed.through !== receipt.seed.from + last.turnIndex - 1 ||
        log?.owner?.runId !== runId ||
        log.owner.gen !== gen
      )
        return { ok: false, reason: "fenced" };
      const before = JSON.stringify({ row, log });
      const transcript = await this.readSession(receipt.seed.key, receipt.seed.from, receipt.seed.through);
      if (
        (await sourceHash(transcript)) !== receipt.seed.messagesHash ||
        (await sourceHash(row.system)) !== receipt.seed.systemHash ||
        this.live.get(runId) !== row ||
        before !== JSON.stringify({ row, log }) ||
        !sessionRangesAvailable(
          log.rows.map((part) => ({ ...part, trimmed: log.trimmed.has(`${part.idx}:${part.part}`) })),
          [{ from: receipt.seed.from, to: receipt.seed.through }],
        )
      )
        return { ok: false, reason: "fenced" };
      if (this.advanceMemoryPinRevision(log) === undefined) return { ok: false, reason: "fenced" };
      log.rangePins ??= {};
      log.rangePins[runId] = [...(log.rangePins[runId] ?? []), { from: receipt.seed.from, to: receipt.seed.through }];
    }
    row.state = preserved;
    return { ok: true };
  }

  async pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }> {
    const row = this.live.get(runId);
    if (!row) return { ok: false };
    const stored = bindInboxCustody(message, {
      runId,
      channelId: row.meta.channelId,
      threadKey: row.meta.threadKey,
      requester: row.meta.userId,
      producerGen: row.ownerGen,
    });
    if (!stored) return { ok: false };
    const list = this.inbox.get(runId) ?? [];
    const seq = list.length + 1;
    list.push({ seq, message: stored });
    this.inbox.set(runId, list);
    return { ok: true, seq };
  }

  async readInbox(runId: string, afterSeq: number): Promise<InboxItem[]> {
    const row = this.live.get(runId);
    const floor = row ? inboxSegmentFloor(this.steps.get(runId)?.inboxSegmentArchive, row) : 0;
    return (this.inbox.get(runId) ?? []).filter((i) => floor !== undefined && i.seq > Math.max(afterSeq, floor));
  }

  private prepareInboxSegment(runId: string): StepHistory {
    const row = this.live.get(runId)!;
    const steps = this.steps.get(runId);
    const previous = steps?.inboxSegmentArchive;
    if (previous !== undefined && inboxSegmentFloor(previous, row) === undefined)
      throw new Error("retained inbox segment boundary is unreadable");
    const archive = closeInboxSegment(
      previous,
      row,
      steps?.at(-1) ?? null,
      (this.inbox.get(runId) ?? []).reduce((high, item) => Math.max(high, item.seq), 0),
    );
    const retained: StepHistory = [];
    encodeInboxSegment(archive, MAX_RECORD_BYTES);
    retained.inboxSegmentArchive = archive;
    return retained;
  }

  async peekInbox(runId: string, gen: string, afterSeq: number): Promise<import("./types.js").InboxPeek> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence.ok ? { ok: false, reason: "unknown-run" } : fence;
    if (inboxSegmentFloor(this.steps.get(runId)?.inboxSegmentArchive, row) === undefined)
      return { ok: false, reason: "incomplete" };
    const capture = () =>
      JSON.stringify({
        gen: this.live.get(runId)?.ownerGen,
        state: this.live.get(runId)?.state,
        lastStep: this.steps.get(runId)?.at(-1) ?? null,
        items: this.inbox.get(runId) ?? [],
        archive: this.steps.get(runId)?.inboxSegmentArchive,
      });
    const before = capture();
    const snapshot = structuredClone({
      state: row.state,
      lastStep: this.steps.get(runId)?.at(-1) ?? null,
      items: await this.readInbox(runId, afterSeq),
    });
    const items = await Promise.all(
      snapshot.items.map(async (item) => ({
        ...item,
        witness: { version: 1 as const, runId, seq: item.seq, digest: await sourceHash(item.message) },
      })),
    );
    if (before !== capture()) return { ok: false, reason: "incomplete" };
    return {
      ok: true,
      version: 1,
      runId,
      gen,
      items,
      boundary: { state: snapshot.state, lastStep: snapshot.lastStep },
    };
  }

  async requestStop(runId: string, mode: StopMode): Promise<{ ok: boolean; ownerLive?: boolean }> {
    const row = this.live.get(runId);
    if (!row) return { ok: false };
    row.stop = mode;
    return { ok: true, ownerLive: row.leaseUntil > this.now() };
  }

  async handoff(gen: string, runIds: string[], opts?: { pausedForRetry: true }): Promise<{ marked: string[] }> {
    const marked: string[] = [];
    for (const id of runIds) {
      const row = this.live.get(id);
      if (row && row.ownerGen === gen && !this.promotionHeld(id) && phaseTransition(row.phase, "handoff")) {
        row.phase = "handoff";
        if (opts?.pausedForRetry) row.state = { ...row.state, pausedForRetry: true };
        marked.push(id);
      }
    }
    return { marked };
  }

  async finishing(runId: string, gen: string): Promise<FenceResult> {
    const row = this.live.get(runId);
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    if (!phaseTransition(row.phase, "finishing")) return { ok: false, reason: "fenced" };
    row.phase = "finishing";
    return { ok: true };
  }

  async finish(
    runId: string,
    gen: string,
    record: RunRecord,
    opts?: { requireStoppedPause: true },
  ): Promise<FinishResult> {
    if (workspaceAuthorityFieldsPresent(record)) return { ok: false, reason: "fenced" };
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    const row = this.live.get(runId)!;
    const archivedAllocation = workspaceDurabilityArchiveOf(this.allocationArchive(runId));
    const beforeCustody = workspaceCustodyFingerprint(row, this.storedWorkspaceFacts(row));
    const custody = archivedAllocation?.allocation ? await this.workspaceCustody(row) : undefined;
    const confirmed = custody?.session && custody.threadReport ? await this.workspaceCustody(row) : custody;
    if (
      this.promotionHeld(runId, gen) ||
      this.live.get(runId) !== row ||
      row.ownerGen !== gen ||
      !sameWorkspaceCustody(custody, confirmed) ||
      workspaceCustodyFingerprint(row, this.storedWorkspaceFacts(row)) !== beforeCustody
    )
      return { ok: false, reason: "fenced" };
    if (custody?.session) {
      const current = this.sessions.get(custody.session.key)?.owner;
      if (current?.runId !== runId || current.gen !== gen) return { ok: false, reason: "fenced" };
    }
    if (
      !terminalWorkspaceRecordMatches(row, record) ||
      !sameMaintenanceTransport(row.meta, record) ||
      !maintenanceEventsMatch(row.meta, record.events)
    )
      return { ok: false, reason: "fenced" };
    if (
      opts?.requireStoppedPause &&
      (row.phase !== "handoff" ||
        row.state.pausedForRetry !== true ||
        row.stop !== "hard" ||
        record.status !== "stopped_hard")
    )
      return { ok: false, reason: "fenced" };
    const retainedSteps = this.prepareInboxSegment(runId);
    const canonicalWork = this.preserveArchivedBaseline(runId, row.state, record);
    if (!canonicalWork) return { ok: false, reason: "fenced" };
    const {
      branchPublication: _speculativePublication,
      doorPublicationPending: _speculativeDoor,
      reviewPublication: _speculativeReview,
      branchPushReceipts: _speculativePushes,
      ...terminal
    } = record;
    const branchPublication = branchPublicationOf(canonicalWork.branchPublication, record.repo);
    const doorPublicationPending = doorPublicationOf(canonicalWork.doorPublicationPending);
    const branchPushReceipts = branchPushReceiptsOf(canonicalWork.branchPushReceipts);
    const savedReview = reviewPublicationOf(canonicalWork.reviewPublication);
    const reviewPublication =
      savedReview?.runId === runId && savedReview.target.repo === record.repo ? savedReview : undefined;
    record = {
      ...terminal,
      ...(branchPublication === undefined ? {} : { branchPublication }),
      ...(doorPublicationPending === undefined ? {} : { doorPublicationPending }),
      ...(reviewPublication === undefined ? {} : { reviewPublication }),
      ...(branchPushReceipts === undefined ? {} : { branchPushReceipts }),
    };
    if (
      record.branchIdentityBaseline !== undefined &&
      JSON.stringify(record.branchIdentityBaseline) !== JSON.stringify(canonicalWork.branchIdentityBaseline)
    )
      return { ok: false, reason: "fenced" };
    if (
      record.unitSeedReceipt !== undefined &&
      JSON.stringify(record.unitSeedReceipt) !== JSON.stringify(canonicalWork.unitSeedReceipt)
    )
      return { ok: false, reason: "fenced" };
    for (const field of ["workReads", "unitSeedReceipt", "branchIdentityBaseline"] as const) {
      const canonical = canonicalWork[field];
      if (canonical === undefined) continue;
      if (record[field] !== undefined && JSON.stringify(record[field]) !== JSON.stringify(canonical))
        return { ok: false, reason: "fenced" };
      record = { ...record, [field]: structuredClone(canonical) };
    }
    if (!workEvidenceBelongsToRun(record, record)) return { ok: false, reason: "fenced" };
    const priorReceipt =
      this.live.get(runId)?.state.contextCheckpointReceipt ?? this.finished.get(runId)?.contextCheckpointReceipt;
    if (
      record.contextCheckpointReceipt !== undefined &&
      JSON.stringify(record.contextCheckpointReceipt) !== JSON.stringify(priorReceipt)
    )
      return { ok: false, reason: "fenced" };
    const obligation = terminalWorkspaceSettlement(row, record);
    if (obligation) {
      const key = workspaceOwnerKey(obligation.owner);
      const prior = this.workspaceObligations.get(key);
      if ((prior?.pending.size ?? 0) >= WORKSPACE_SETTLEMENTS_MAX)
        throw new Error("workspace obligation capacity exhausted");
      obligation.revision = nextWorkspaceRevision(prior?.revision);
      const pending = prior?.pending ?? new Map<number, WorkspaceSettlement>();
      pending.set(obligation.revision, obligation);
      this.workspaceObligations.set(key, { revision: obligation.revision, pending });
    }
    const unreadable = {
      ...(canonicalWork.branchPushReceipts !== undefined && branchPushReceipts === undefined
        ? { branchPushReceipts: structuredClone(canonicalWork.branchPushReceipts) }
        : {}),
      ...(canonicalWork.reviewPublication !== undefined && reviewPublication === undefined
        ? { reviewPublication: structuredClone(canonicalWork.reviewPublication) }
        : {}),
      ...(canonicalWork.branchPublication !== undefined && branchPublication === undefined
        ? { branchPublication: structuredClone(canonicalWork.branchPublication) }
        : {}),
      ...(canonicalWork.doorPublicationPending !== undefined &&
      canonicalWork.doorPublicationPending !== null &&
      doorPublicationPending === undefined
        ? { doorPublicationPending: structuredClone(canonicalWork.doorPublicationPending) }
        : {}),
    };
    if (Object.keys(unreadable).length) this.finishedWorkEvidence.set(runId, unreadable);
    else this.finishedWorkEvidence.delete(runId);
    this.finished.set(runId, record);
    if (archivedAllocation?.allocation && confirmed)
      this.retainAllocation({
        ...archivedAllocation,
        disposition: deriveWorkspaceDisposition(archivedAllocation.allocation, row, record, confirmed),
      });
    // The ending's cause (record 0064): recorded when the row closes, first
    // cause standing — exactly the object's rule, its one keyed exception
    // included: a standing `resident_replaced` was a `restarting` close, the
    // run carried on under its own id, so that run's own later finish
    // replaces it and the ending agrees with the record.
    if (this.live.has(runId)) {
      const cause = causeOfClose(record.status, record.restarting === true);
      const standing = this.planeEndings.get(runId);
      if (standing === undefined || (standing.cause === "resident_replaced" && cause !== "resident_replaced"))
        this.planeEndings.set(runId, { kind: record.status, cause, at: record.finishedAt });
    }
    this.steps.set(runId, retainedSteps);
    this.live.delete(runId);
    // Terminal execution is not a native acknowledgement of queued messages.
    // Inbox custody remains in its original rows until exact consumption.
    this.jobs.delete(runId);
    this.transcripts.delete(runId);
    // The session log is kept whole; only the owner is released.
    if (record.session) await this.releaseSession(record.session.key, runId, gen);
    return { ok: true, stored: true };
  }

  private session(key: string): SessionLog {
    let log = this.sessions.get(key);
    if (!log)
      this.sessions.set(
        key,
        (log = { rows: [], attachments: [], maxBytes: DEFAULT_SESSION_LOG_MAX_BYTES, trimmed: new Set() }),
      );
    return log;
  }

  async sessionTail(key: string): Promise<number> {
    const rows = this.sessions.get(key)?.rows ?? [];
    return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.idx)) + 1;
  }

  async appendSession(
    key: string,
    rowId: string,
    rows: readonly { part: number; json: string }[],
    context?: ContextDependencies,
  ): Promise<{ ok: boolean; appended: boolean }> {
    if (!keyedAppendContextMatches(rows, context)) return { ok: false, appended: false };
    const hash = await sourceHash({ rows, context: context ?? UNKNOWN_CONTEXT_DEPENDENCIES });
    // Hashing precedes the synchronous append; every retry checks the durable
    // original payload, including after byte trimming replaces its content.
    const receipts = (
      await Promise.all(
        (context?.origins ?? [])
          .filter((origin) => origin.checkpoint)
          .map((origin) => this.readContextCheckpoint(origin.runId)),
      )
    ).flatMap((source) =>
      source?.receipt &&
      context?.origins.some((origin) => origin.runId === source.runId && origin.checkpoint === source.receipt!.hash)
        ? [source]
        : [],
    );
    const log = this.session(key);
    log.rowIds ??= new Map();
    log.rowHashes ??= new Map();
    if (log.rowIds.has(rowId)) return { ok: log.rowHashes.get(rowId) === hash, appended: false };
    const pending = this.sourceSeedPending(key);
    if (pending) throw new SourceSeedPendingError(key, pending.runId);
    const idx = log.rows.length === 0 ? 0 : Math.max(...log.rows.map((r) => r.idx)) + 1;
    for (const source of receipts)
      if (log.sources?.context) log.sources.context = applyContextCheckpointAliases(log.sources.context, source);
    log.sources = structuredClone(appendSessionContext(log.sources, context, idx === 0));
    for (const source of receipts)
      if (log.sources.context) log.sources.context = applyContextCheckpointAliases(log.sources.context, source);
    for (const r of rows) log.rows.push({ idx, part: r.part, json: r.json });
    log.rowIds.set(rowId, idx);
    log.rowHashes.set(rowId, hash);
    this.enforceBytePolicy(key);
    return { ok: true, appended: true };
  }

  async claimSession(key: string, runId: string, gen: string, maxBytes?: number): Promise<void> {
    const pending = this.sourceSeedPending(key);
    if (pending) {
      const current = this.sessions.get(key)!;
      if (pending.runId === runId && pending.gen === gen && (maxBytes === undefined || maxBytes === current.maxBytes))
        return;
      throw new SourceSeedPendingError(key, pending.runId);
    }
    const log = this.session(key);
    if (log.pendingSourceOwner && log.pendingSourceOwner !== `${runId}:${gen}`)
      log.sources = taintSessionSources(log.sources);
    log.sourceStart = await this.sessionTail(key);
    log.owner = { runId, gen };
    log.maxBytes = maxBytes ?? DEFAULT_SESSION_LOG_MAX_BYTES;
  }

  /** The log's rows and attachments in UTF-8 bytes — what the byte policy bounds. */
  sessionBytes(key: string): number {
    const log = this.sessions.get(key);
    if (!log) return 0;
    return (
      log.rows.reduce((n, r) => n + utf8ByteLength(r.json), 0) +
      log.attachments.reduce((n, a) => n + utf8ByteLength(a.data), 0)
    );
  }

  /** The byte policy (session-log item 5), as the object enforces it: over the
   *  budget, the oldest un-replaced tool results are replaced by the marker,
   *  each taking with it the attachments no remaining row references, until
   *  the log fits or no candidate is left; text rows are never candidates. */
  private enforceBytePolicy(key: string): void {
    const log = this.session(key);
    const rowKey = (r: TranscriptRow) => `${r.idx}:${r.part}`;
    const soleAttachmentBytes = (row: TranscriptRow): number => {
      const others = new Set(log.rows.filter((r) => r !== row).flatMap((r) => attachmentRefsOf(r.json)));
      return attachmentRefsOf(row.json)
        .filter((ref) => !others.has(ref))
        .reduce((n, ref) => n + (log.attachments.find((a) => a.ref === ref)?.data.length ?? 0), 0);
    };
    for (;;) {
      const total = this.sessionBytes(key);
      if (total <= log.maxBytes) return;
      const candidates = [...log.rows]
        .filter(
          (r) =>
            rowKind(r.json) === "tool_result" &&
            !log.trimmed.has(rowKey(r)) &&
            !sessionRowIsPinned(log.rangePins ?? {}, r.idx),
        )
        .sort((a, b) => a.idx - b.idx || a.part - b.part);
      const byId = new Map(candidates.map((r, i) => [i, r]));
      const ids = planSessionTrim(
        candidates.map((r, i) => ({ id: i, bytes: utf8ByteLength(r.json) + soleAttachmentBytes(r) })),
        total - log.maxBytes,
        TRIM_MARKER_BYTES_ESTIMATE,
      );
      if (ids.length === 0) return;
      for (const id of ids) {
        const row = byId.get(id)!;
        const marker = droppedToolResultRow(row.json);
        log.trimmed.add(rowKey(row));
        if (marker === undefined) continue;
        const refs = attachmentRefsOf(row.json);
        row.json = marker;
        const stillReferenced = new Set(log.rows.flatMap((r) => attachmentRefsOf(r.json)));
        log.attachments = log.attachments.filter((a) => !refs.includes(a.ref) || stillReferenced.has(a.ref));
      }
    }
  }

  async releaseSession(key: string, runId: string, gen: string): Promise<FenceResult> {
    const pending = this.sourceSeedPending(key);
    if (pending) throw new SourceSeedPendingError(key, pending.runId);
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.runId !== runId || log.owner.gen !== gen) return { ok: false, reason: "fenced" };
    delete log.owner;
    return { ok: true };
  }

  async readSessionEntry(key: string, rowId: string): Promise<readonly TranscriptRow[] | undefined> {
    const log = this.sessions.get(key);
    const index = log?.rowIds?.get(rowId);
    if (index === undefined || !log) return undefined;
    const rows = log.rows.filter((row) => row.idx === index).sort((a, b) => a.part - b.part);
    if (!rows.length || rows.some((row) => log.trimmed.has(`${row.idx}:${row.part}`))) return undefined;
    return structuredClone(rows);
  }

  async readSession(key: string, from: number, to?: number): Promise<AssembledTranscript> {
    const log = this.sessions.get(key);
    const rows = (log?.rows ?? []).filter((r) => r.idx >= from && (to === undefined || r.idx <= to));
    return assembleTranscript(rows, log?.attachments ?? [], from);
  }

  async readSessionTail(
    key: string,
    maxBytes: number,
  ): Promise<{ from: number; transcript: AssembledTranscript; sources?: SessionSources; requiresFreshSources?: true }> {
    const log = this.sessions.get(key);
    const sources = log?.pendingSourceOwner ? taintSessionSources(log.sources) : log?.sources;
    const rows = [...(this.sessions.get(key)?.rows ?? [])].sort((a, b) => b.idx - a.idx || b.part - a.part);
    const from = tailCut(
      rows.map((r) => ({ idx: r.idx, bytes: utf8ByteLength(r.json) })),
      maxBytes,
    );
    if (from === undefined) {
      const next = await this.sessionTail(key);
      return {
        from: next,
        transcript: assembleTranscript([], [], next),
        ...(sources ? { sources: structuredClone(sources) } : {}),
        ...(log?.requiresFreshSources ? { requiresFreshSources: true as const } : {}),
      };
    }
    return {
      from,
      transcript: await this.readSession(key, from),
      ...(sources ? { sources: structuredClone(sources) } : {}),
      ...(log?.requiresFreshSources ? { requiresFreshSources: true as const } : {}),
    };
  }

  /** The search as the object answers it (session-log item 10), by the memory
   *  scorer's tokens: a row scores the distinct query words its indexed text
   *  carries, the highest first and the newest among equals — the same order
   *  the object's bm25 rank gives for one-word texts, close enough for the
   *  reference — with the gap markers between the oldest and the newest hit. */
  async searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }> {
    const log = this.sessions.get(key);
    const words = [...new Set(tokenize(query))];
    if (!log || words.length === 0) return { hits: [], gaps: [] };
    const scored = log.rows
      .map((r) => {
        const text = textOfStoredRow(r.json);
        const has = new Set(tokenize(text));
        return { r, text, score: words.filter((w) => has.has(w)).length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.r.idx - a.r.idx || b.r.part - a.r.part)
      .slice(0, limit);
    const hits: SessionHit[] = scored.map(({ r, text }) => {
      const role = roleOfStoredRow(r.json);
      return { idx: r.idx, part: r.part, ...(role !== undefined ? { role } : {}), kind: rowKind(r.json), text };
    });
    if (hits.length < 2) return { hits, gaps: [] };
    const lo = Math.min(...hits.map((h) => h.idx));
    const hi = Math.max(...hits.map((h) => h.idx));
    const gaps = [
      ...new Set(
        log.rows.filter((r) => r.idx >= lo && r.idx <= hi && textOfStoredRow(r.json) === GAP_MARKER).map((r) => r.idx),
      ),
    ].sort((a, b) => a - b);
    return { hits, gaps };
  }

  async readRequesterTarget(key: string, actor: string): Promise<RequesterTarget | null> {
    return this.sessions.get(key)?.requesterTargets?.get(actor) ?? null;
  }

  async checkpointRequesterTarget(key: string, actor: string, target: RequesterTarget): Promise<RequesterTarget> {
    const log = this.session(key);
    const targets = (log.requesterTargets ??= new Map());
    const merged = mergeRequesterTarget(targets.get(actor) ?? null, target);
    targets.set(actor, merged);
    return merged;
  }

  async readNotepad(key: string): Promise<Notepad | null> {
    return this.sessions.get(key)?.notepad ?? null;
  }

  async writeNotepad(key: string, gen: string, text: string, runId?: string): Promise<FenceResult> {
    const pending = this.sourceSeedPending(key);
    if (pending) {
      if (pending.runId === runId && pending.gen === gen && this.sessions.get(key)?.notepad?.text === text)
        return { ok: true };
      throw new SourceSeedPendingError(key, pending.runId);
    }
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.gen !== gen || ((log.sources || runId !== undefined) && log.owner.runId !== runId))
      return { ok: false, reason: "fenced" };
    log.notepad = { text, updatedAt: this.now() };
    return { ok: true };
  }

  async abandon(runId: string, gen: string): Promise<FenceResult> {
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    if (this.promotionHeld(runId, gen)) throw new PromotionPendingError(runId);
    const retainedSteps = this.prepareInboxSegment(runId);
    this.steps.set(runId, retainedSteps);
    const allocation = workspaceDurabilityArchiveOf(this.allocationArchive(runId));
    const row = this.live.get(runId)!;
    if (allocation?.allocation)
      this.retainAllocation({
        ...allocation,
        disposition: deriveWorkspaceDisposition(allocation.allocation, row, undefined, {
          events: [],
          pendingEffects: true,
        }),
      });
    this.live.delete(runId);
    // Abandoning execution does not dispose of unread or opaque source bytes.
    this.jobs.delete(runId);
    this.transcripts.delete(runId);
    if (!this.finished.has(runId))
      for (const log of this.sessions.values())
        if (
          log.rangePins?.[runId] &&
          log.expectedSeedPending?.runId !== runId &&
          this.advanceMemoryPinRevision(log) !== undefined
        )
          delete log.rangePins[runId];
    return { ok: true };
  }

  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const taken = selectReclaim([...this.live.values()], now, gen).filter((row) => !this.promotionHeld(row.runId));
    const out: ReclaimedRun[] = [];
    for (const row of taken) {
      const reclaimedFrom = row.phase;
      row.ownerGen = gen;
      row.leaseUntil = now + leaseMs;
      row.phase = reclaimPhase(reclaimedFrom);
      delete row.state.pausedForRetry;
      const t = this.transcripts.get(row.runId);
      if (t) t.ownerGen = gen;
      // The row's session log changes hands with it, as the transcript object does.
      if (row.meta.session) this.session(row.meta.session.key).owner = { runId: row.runId, gen };
      const steps = this.steps.get(row.runId) ?? [];
      const lastStep = steps.length ? steps[steps.length - 1] : null;
      const unread = unreadInbox(lastStep);
      const floor = inboxSegmentFloor(this.steps.get(row.runId)?.inboxSegmentArchive, row);
      out.push({
        row,
        reclaimedFrom,
        lastStep,
        inbox: (this.inbox.get(row.runId) ?? []).filter(
          (item) => floor !== undefined && item.seq > floor && unread(item),
        ),
        jobs: this.jobs.get(row.runId) ?? [],
      });
    }
    return out;
  }

  async recordIntake(key: string, receipt: IntakeReceipt): Promise<IntakeWriteResult> {
    if (this.intakeFailure.write) throw new Error("intake write failed (toggled)");
    const out = decideIntakeInsert(this.intake.get(key), receipt);
    if (out.inserted) this.intake.set(key, receipt);
    return out;
  }

  async readIntake(key: string): Promise<IntakeReceipt | undefined> {
    if (this.intakeFailure.read) throw new Error("intake read failed (toggled)");
    return this.intake.get(key);
  }

  async claimIntakeDelivery(key: string, poster: string, claimedAt: number): Promise<boolean> {
    if (this.intakeFailure.write) throw new Error("intake write failed (toggled)");
    if (this.intake.get(key)?.providerFailure === undefined) return false;
    const existing = this.intakeDeliveries.get(key);
    if (existing?.delivered === true || (existing !== undefined && existing.claimUntil > claimedAt)) return false;
    this.intakeDeliveries.set(key, {
      poster,
      claimUntil: claimedAt + INTAKE_DELIVERY_CLAIM_MS,
      delivered: false,
    });
    return true;
  }

  async finishIntakeDelivery(key: string, poster: string, delivered: boolean): Promise<void> {
    if (this.intakeFailure.write) throw new Error("intake write failed (toggled)");
    const existing = this.intakeDeliveries.get(key);
    if (existing?.poster !== poster || existing.delivered) return;
    if (delivered) this.intakeDeliveries.set(key, { ...existing, delivered: true });
    else this.intakeDeliveries.delete(key);
  }

  async listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> {
    if (this.intakeFailure.read) throw new Error("intake read failed (toggled)");
    return [...this.intake.values()]
      .filter(
        (r) =>
          (query.threadKey === undefined || r.threadKey === query.threadKey) &&
          (query.since === undefined || r.decidedAt >= query.since),
      )
      .sort((a, b) => a.decidedAt - b.decidedAt);
  }

  async readEvents(runId: string): Promise<AppendableEvent[]> {
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async listLive(): Promise<LiveRunRow[]> {
    return [...this.live.values()];
  }

  async readTranscript(runId: string): Promise<AssembledTranscript> {
    const t = this.transcripts.get(runId);
    return assembleTranscript(t?.rows ?? [], t?.attachments ?? []);
  }
}
