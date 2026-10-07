import { allocationAckOf } from "./allocationAck.js";
import { promotionConfirmationOf, confirmationMatchesPreparation } from "./seedVerification.js";
import type { RunRecord } from "../runRecord.js";
import {
  promotionBodyOf,
  promotionPreparationOf,
  promotionCommitReceiptOf,
  promotionCommitMatchesPreparation,
} from "./promotion.js";
import type { LiveRunMeta, LiveRunRow, StepRecord, TranscriptRow } from "./types.js";
import { isContextDependencies } from "../references/contextDependencies.js";
import {
  resourceLifetimeSchema,
  sameResourceLifetime,
  type ResourceLifetimeDeclaration,
} from "../../agents/resourceLifetime.js";
import type { SessionRangePins } from "./sessionRangePins.js";

export function isCustodyRangePins(value: unknown): value is SessionRangePins {
  return (
    object(value) &&
    Object.values(value).every(
      (ranges) =>
        Array.isArray(ranges) &&
        ranges.every(
          (range) =>
            object(range) &&
            Object.keys(range).every((key) => key === "from" || key === "to") &&
            natural(range.from) &&
            natural(range.to) &&
            range.to >= range.from,
        ),
    )
  );
}

export interface CustodyPinRevision {
  version: 1;
  revision: number;
  guarded: boolean;
}
export function custodyPinRevisionOf(value: unknown): CustodyPinRevision | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((k) => !["version", "revision", "guarded"].includes(k)) ||
    value.version !== 1 ||
    !natural(value.revision) ||
    typeof value.guarded !== "boolean" ||
    (value.guarded && value.revision === 0)
  )
    return;
  return { version: 1, revision: value.revision, guarded: value.guarded };
}
export function nextCustodyPinRevision(value: CustodyPinRevision): number | undefined {
  return custodyPinRevisionOf(value) && value.revision < Number.MAX_SAFE_INTEGER ? value.revision + 1 : undefined;
}
export function custodyPinProtectionOf(value: unknown): CustodyPinRevision | undefined {
  if (
    !object(value) ||
    value.ok !== true ||
    Object.keys(value).some((k) => !["ok", "version", "revision", "guarded"].includes(k))
  )
    return;
  const { ok: _ok, ...revision } = value;
  const parsed = custodyPinRevisionOf(revision);
  return parsed?.guarded ? parsed : undefined;
}
export function sameWorkspaceCustody(
  first: StoredWorkspaceCustody | undefined,
  second: StoredWorkspaceCustody | undefined,
): boolean {
  if (first?.session && (!second?.session || second.session.pinRevision < first.session.pinRevision)) return false;
  if (
    first?.threadReport &&
    (!second?.threadReport || second.threadReport.pinRevision < first.threadReport.pinRevision)
  )
    return false;
  const stable = (facts: StoredWorkspaceCustody | undefined) =>
    facts && {
      ...facts,
      ...(facts.session ? { session: { ...facts.session, pinRevision: 0 } } : {}),
      ...(facts.threadReport ? { threadReport: { ...facts.threadReport, pinRevision: 0 } } : {}),
    };
  return JSON.stringify(stable(first)) === JSON.stringify(stable(second));
}
import type { RunEvent } from "../runEvents.js";
import { reviewPublicationOf } from "../reviewPublication.js";

/** Original admission data. Its absence is unknown; a current role or profile
 * cannot recreate the permission to discard an earlier allocation. */
export interface LegacyWorkspaceAllocation {
  version: 1;
  kind: "exclusive-scratch" | "retained";
  runId: string;
  requester: string;
  threadKey: string;
  repo?: string;
  ref?: string;
  headSha?: string;
  parentInstanceId?: string;
  coordinatorUnit?: string;
  idempotencyKey?: string;
  maintenanceActionId?: string;
  allocationKey: string;
  /** Required durable output, independent of the scratch filesystem. */
  custody: "session-report" | "session-report-and-review-publication";
}

export interface DeclaredOriginalColdAllocation extends Omit<
  LegacyWorkspaceAllocation,
  "version" | "kind" | "repo" | "ref" | "headSha" | "custody"
> {
  version: 2;
  kind: "exclusive-scratch";
  repo: string;
  ref: string;
  headSha: string;
  pr: number;
  custody: "session-report-and-review-publication";
  policy: Extract<ResourceLifetimeDeclaration, { purpose: "pull-request-review" }>;
}
export type WorkspaceAllocation = LegacyWorkspaceAllocation | DeclaredOriginalColdAllocation;

export interface OriginalColdAllocationInput {
  runId: string;
  registered: { resourceLifetime?: unknown };
  identity: Pick<
    LiveRunMeta,
    | "userId"
    | "threadKey"
    | "repo"
    | "ref"
    | "headSha"
    | "pr"
    | "parentInstanceId"
    | "coordinatorUnit"
    | "idempotencyKey"
    | "maintenanceActionId"
  >;
  /** Already resolved/gated purpose target; syntax alone is not authorization. */
  target: { repo: string; ref: string; headSha: string; pr: number } | undefined;
}

/** Produces fresh admission DATA only. It does not acknowledge persistence,
 * verify a backend, close custody, authorize disposal or repair an old run. */
export function originalColdAllocation(input: OriginalColdAllocationInput): DeclaredOriginalColdAllocation | undefined {
  const policy = resourceLifetimeSchema.safeParse(input.registered?.resourceLifetime),
    meta = input.identity,
    target = input.target;
  if (
    !policy.success ||
    policy.data.purpose !== "pull-request-review" ||
    !target ||
    ![input.runId, meta.userId, meta.threadKey].every(text) ||
    meta.repo !== target.repo ||
    meta.ref !== target.ref ||
    meta.headSha !== target.headSha ||
    meta.pr !== target.pr
  )
    return;
  return declaredOriginalColdAllocationOf({
    version: 2,
    kind: "exclusive-scratch",
    runId: input.runId,
    requester: meta.userId,
    threadKey: meta.threadKey,
    repo: meta.repo,
    ref: meta.ref,
    headSha: meta.headSha,
    pr: meta.pr,
    ...Object.fromEntries(
      optional
        .filter((key) => !["repo", "ref", "headSha"].includes(key) && meta[key] !== undefined)
        .map((key) => [key, meta[key]]),
    ),
    allocationKey: `review:${input.runId}`,
    custody: policy.data.cold.custody,
    policy: policy.data,
  });
}

/** Only the new recorded declaration is recognized as original-purpose data.
 * This still supplies no ACK, supported consumer or physical permission. */
export function declaredOriginalColdAllocationOf(value: unknown): DeclaredOriginalColdAllocation | undefined {
  const parsed = workspaceAllocationOf(value);
  return parsed?.version === 2 ? parsed : undefined;
}

export type WorkspaceDisposition =
  | { version: 1; kind: "retained"; runId: string; ownerGen: string; reason: string }
  | {
      version: 1;
      kind: "scratch-custody-closed";
      runId: string;
      ownerGen: string;
      allocationKey: string;
      container: string;
      /** References actual owning-store inputs, not a caller's close receipt. */
      custody: {
        leaseSeq: number;
        leaseHash: string;
        reportSeq: number;
        reportHash: string;
        step: number;
        sessionKey: string;
        from: number;
        through: number;
        transcriptHash: string;
        pinRevision: number;
        threadReport: WorkspaceThreadReport;
      };
      execution: { processBirth: string; bearerHash: string };
    };

export interface WorkspaceThreadReport {
  key: string;
  threadKey: string;
  rowId: string;
  from: number;
  through: number;
  rowsHash: string;
  pinRevision: number;
}

/** Only the original admission/delivery intents retired by the seal are
 * exempt; external work and unreadable effects remain obligations. */
export function workspaceEffectNeedsCustody(
  runId: string,
  threadKey: string,
  row: { id: string; body_json: string },
): boolean {
  let effect: unknown;
  try {
    effect = JSON.parse(row.body_json);
  } catch {
    return true;
  }
  if (!object(effect) || effect.runId !== runId || effect.id !== row.id) return true;
  if (
    effect.kind === "admit" &&
    row.id === `admit:${runId}` &&
    effect.threadKey === threadKey &&
    object(effect.request)
  )
    return false;
  if (effect.kind === "steer" && natural(effect.seq) && effect.seq > 0 && object(effect.message)) return false;
  return true;
}

/** Exact immutable report parts; rendered/model prose is not a custody test. */
export function workspaceReportRowsMatch(rows: readonly TranscriptRow[] | undefined, answer: string): boolean {
  if (!rows?.length || !natural(rows[0].idx)) return false;
  const ordered = [...rows].sort((a, b) => a.part - b.part);
  let value = "";
  let context: string | undefined;
  for (const [part, row] of ordered.entries()) {
    if (row.idx !== ordered[0].idx || row.part !== part) return false;
    let stored: unknown;
    try {
      stored = JSON.parse(row.json);
    } catch {
      return false;
    }
    if (
      !object(stored) ||
      stored.role !== "assistant" ||
      stored.actor !== undefined ||
      stored.silent === true ||
      !object(stored.part) ||
      stored.part.type !== "text" ||
      typeof stored.part.text !== "string" ||
      !isContextDependencies(stored.context)
    )
      return false;
    const current = JSON.stringify(stored.context);
    if (context !== undefined && current !== context) return false;
    context = current;
    value += stored.part.text;
  }
  return value === answer;
}

export interface WorkspaceDurabilityArchive {
  version: 1;
  runId: string;
  /** Identity reference to the first claim, not a new budget or expiry. */
  startedAt: number;
  /** Canonical absence is retained too; it cannot become a later contract. */
  allocation: WorkspaceAllocation | null;
  disposition?: WorkspaceDisposition;
  promotion?: import("./promotion.js").OriginalPromotionPreparation;
  promotionCommit?: import("./promotion.js").PromotionCommitReceipt;
  promotionConfirmation?: import("./seedVerification.js").PromotionConfirmationReceipt;
  promotionAllocationAck?: import("./types.js").WorkspaceAllocationAck;
  promotionStepBase?: number;
}
export type WorkspaceDispositionRead =
  | { kind: "held"; reason: "live" | "unknown" | "mismatch" | "custody-unavailable" }
  | { kind: "terminal"; allocation: WorkspaceAllocation; disposition: WorkspaceDisposition };

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const processBirth = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[0-9]{1,20}$/.test(v);
const optional = [
  "repo",
  "ref",
  "headSha",
  "parentInstanceId",
  "coordinatorUnit",
  "idempotencyKey",
  "maintenanceActionId",
] as const;
const allocationFields = [
  "version",
  "kind",
  "runId",
  "requester",
  "threadKey",
  "allocationKey",
  "custody",
  ...optional,
];

export function workspaceAllocationOf(v: unknown): WorkspaceAllocation | undefined {
  if (
    !object(v) ||
    Object.keys(v).some((key) => ![...allocationFields, ...(v.version === 2 ? ["pr", "policy"] : [])].includes(key)) ||
    (v.version !== 1 && v.version !== 2) ||
    !["exclusive-scratch", "retained"].includes(String(v.kind)) ||
    ![v.runId, v.requester, v.threadKey, v.allocationKey].every(text) ||
    !["session-report", "session-report-and-review-publication"].includes(String(v.custody)) ||
    optional.some((key) => v[key] !== undefined && !text(v[key]))
  )
    return;
  if (v.kind === "exclusive-scratch" && v.allocationKey !== `review:${v.runId}`) return;
  if (v.headSha !== undefined && !/^[a-f0-9]{40}$/.test(String(v.headSha))) return;
  if (v.version === 2) {
    const policy = resourceLifetimeSchema.safeParse(v.policy);
    if (
      v.kind !== "exclusive-scratch" ||
      !policy.success ||
      policy.data.purpose !== "pull-request-review" ||
      v.custody !== policy.data.cold.custody ||
      !text(v.repo) ||
      !/^[\w.-]+\/[\w.-]+$/.test(v.repo) ||
      !text(v.ref) ||
      !text(v.headSha) ||
      !natural(v.pr) ||
      v.pr === 0 ||
      !/^[A-Za-z0-9_-]{1,56}$/.test(String(v.runId))
    )
      return;
    return structuredClone({ ...v, policy: policy.data }) as unknown as DeclaredOriginalColdAllocation;
  }
  return structuredClone(v) as unknown as WorkspaceAllocation;
}

/** Compare every available original identity. No agent name participates. */
export function allocationMatchesRun(
  a: WorkspaceAllocation,
  runId: string,
  meta: Pick<
    LiveRunMeta,
    | "userId"
    | "threadKey"
    | "repo"
    | "ref"
    | "headSha"
    | "pr"
    | "parentInstanceId"
    | "coordinatorUnit"
    | "idempotencyKey"
    | "maintenanceActionId"
  >,
): boolean {
  return (
    a.runId === runId &&
    a.requester === meta.userId &&
    a.threadKey === meta.threadKey &&
    optional.every((key) => a[key] === meta[key]) &&
    (a.version !== 2 || a.pr === meta.pr)
  );
}

export function allocationMatchesRecord(
  a: WorkspaceAllocation,
  record: Pick<
    RunRecord,
    | "id"
    | "userId"
    | "threadKey"
    | "repo"
    | "parentInstanceId"
    | "coordinatorUnit"
    | "idempotencyKey"
    | "maintenanceActionId"
  >,
): boolean {
  return (
    a.runId === record.id &&
    a.requester === record.userId &&
    a.threadKey === record.threadKey &&
    ["repo", "parentInstanceId", "coordinatorUnit", "idempotencyKey", "maintenanceActionId"].every(
      (key) => a[key as keyof WorkspaceAllocation] === record[key as keyof typeof record],
    )
  );
}

export function sameWorkspaceAllocation(a: unknown, b: unknown): boolean {
  const left = workspaceAllocationOf(a),
    right = workspaceAllocationOf(b);
  return (
    (a === undefined && b === undefined) ||
    (!!left &&
      !!right &&
      allocationFields.every(
        (key) => left[key as keyof WorkspaceAllocation] === right[key as keyof WorkspaceAllocation],
      ) &&
      (left.version !== 2 ||
        (right.version === 2 && left.pr === right.pr && sameResourceLifetime(left.policy, right.policy))))
  );
}

export function workspaceDurabilityKey(runId: string): string {
  return JSON.stringify(["workspace-allocation", runId]);
}

/** Only first canonical admission may establish a contract. Later requests
 * may omit their copy, but can never replace the original or retrofit legacy. */
export function prepareWorkspaceAllocation(
  runId: string,
  meta: LiveRunMeta,
  previous: unknown,
  previouslyAdmitted: boolean,
  startedAt: number,
): WorkspaceDurabilityArchive | undefined {
  const prior = previous === undefined ? undefined : workspaceDurabilityArchiveOf(previous);
  if (previous !== undefined && !prior) throw new Error("workspace allocation authority is unreadable");
  const incoming = meta.workspaceAllocation === undefined ? undefined : workspaceAllocationOf(meta.workspaceAllocation);
  if (meta.workspaceAllocation !== undefined && !incoming) throw new Error("workspace allocation is invalid");
  if (prior) {
    if (prior.runId !== runId || prior.startedAt !== startedAt)
      throw new Error("workspace allocation identity changed");
    if (prior.allocation === null) {
      if (incoming) throw new Error("workspace allocation cannot be retrofitted");
      return prior;
    }
    if (
      (incoming && !sameWorkspaceAllocation(prior.allocation, incoming)) ||
      !allocationMatchesRun(prior.allocation, runId, meta) ||
      (prior.allocation.kind === "exclusive-scratch" && (meta.readonly !== true || meta.profile?.identity !== "read"))
    )
      throw new Error("workspace allocation is immutable");
    if (prior.disposition?.kind === "scratch-custody-closed") throw new Error("workspace allocation is terminal");
    return prior;
  }
  if (!incoming) return { version: 1, runId, startedAt, allocation: null };
  if (
    previouslyAdmitted ||
    !allocationMatchesRun(incoming, runId, meta) ||
    (incoming.kind === "exclusive-scratch" && (meta.readonly !== true || meta.profile?.identity !== "read"))
  )
    throw new Error("workspace allocation does not match original admission");
  return { version: 1, runId, startedAt, allocation: incoming };
}

export function workspaceAuthorityFieldsPresent(v: unknown): boolean {
  return object(v) && (Object.hasOwn(v, "workspaceAllocation") || Object.hasOwn(v, "workspaceDisposition"));
}

export function workspaceDispositionOf(v: unknown): WorkspaceDisposition | undefined {
  if (!object(v) || v.version !== 1 || !text(v.runId) || !text(v.ownerGen)) return;
  if (
    v.kind === "retained" &&
    text(v.reason) &&
    Object.keys(v).every((k) => ["version", "kind", "runId", "ownerGen", "reason"].includes(k))
  )
    return { version: 1, kind: "retained", runId: v.runId, ownerGen: v.ownerGen, reason: v.reason };
  if (
    v.kind !== "scratch-custody-closed" ||
    !text(v.allocationKey) ||
    !text(v.container) ||
    !object(v.custody) ||
    !object(v.execution)
  )
    return;
  const c = v.custody,
    e = v.execution;
  if (
    Object.keys(v).some(
      (k) =>
        !["version", "kind", "runId", "ownerGen", "allocationKey", "container", "custody", "execution"].includes(k),
    ) ||
    Object.keys(c).some(
      (k) =>
        ![
          "leaseSeq",
          "leaseHash",
          "reportSeq",
          "reportHash",
          "step",
          "sessionKey",
          "from",
          "through",
          "transcriptHash",
          "pinRevision",
          "threadReport",
        ].includes(k),
    ) ||
    Object.keys(e).some((k) => !["processBirth", "bearerHash"].includes(k))
  )
    return;
  if (
    !natural(c.leaseSeq) ||
    c.leaseSeq === 0 ||
    !hash(c.leaseHash) ||
    !natural(c.reportSeq) ||
    c.reportSeq === 0 ||
    !hash(c.reportHash) ||
    !natural(c.step) ||
    !text(c.sessionKey) ||
    !natural(c.from) ||
    !natural(c.through) ||
    c.through < c.from ||
    !hash(c.transcriptHash) ||
    !natural(c.pinRevision) ||
    c.pinRevision === 0 ||
    !object(c.threadReport) ||
    Object.keys(c.threadReport).some(
      (k) => !["key", "threadKey", "rowId", "from", "through", "rowsHash", "pinRevision"].includes(k),
    ) ||
    !text(c.threadReport.key) ||
    !text(c.threadReport.threadKey) ||
    c.threadReport.rowId !== `run:${v.runId}:answer` ||
    !natural(c.threadReport.from) ||
    c.threadReport.through !== c.threadReport.from ||
    !hash(c.threadReport.rowsHash) ||
    !natural(c.threadReport.pinRevision) ||
    c.threadReport.pinRevision === 0 ||
    !processBirth(e.processBirth) ||
    !hash(e.bearerHash)
  )
    return;
  return structuredClone(v) as unknown as WorkspaceDisposition;
}

export function workspaceDurabilityArchiveOf(v: unknown): WorkspaceDurabilityArchive | undefined {
  if (
    !object(v) ||
    v.version !== 1 ||
    !text(v.runId) ||
    typeof v.startedAt !== "number" ||
    !Number.isFinite(v.startedAt) ||
    Object.keys(v).some(
      (k) =>
        ![
          "version",
          "runId",
          "startedAt",
          "allocation",
          "disposition",
          "promotion",
          "promotionCommit",
          "promotionConfirmation",
          "promotionAllocationAck",
          "promotionStepBase",
        ].includes(k),
    )
  )
    return;
  const allocation = v.allocation === null ? null : workspaceAllocationOf(v.allocation);
  const disposition = v.disposition === undefined ? undefined : workspaceDispositionOf(v.disposition);
  const promotion = v.promotion === undefined ? undefined : promotionPreparationOf(v.promotion);
  const promotionCommit = v.promotionCommit === undefined ? undefined : promotionCommitReceiptOf(v.promotionCommit);
  const confirmation =
    v.promotionConfirmation === undefined ? undefined : promotionConfirmationOf(v.promotionConfirmation);
  const promotionAllocationAck =
    v.promotionAllocationAck === undefined || !promotion
      ? undefined
      : allocationAckOf(v.promotionAllocationAck, promotionBodyOf(promotion.bodyJson)!);
  if (
    allocation === undefined ||
    (v.promotionStepBase !== undefined && !natural(v.promotionStepBase)) ||
    (v.promotionAllocationAck !== undefined && (!promotionAllocationAck || !promotionCommit)) ||
    (v.promotionConfirmation !== undefined &&
      (!confirmation || !promotion || !promotionCommit || !confirmationMatchesPreparation(confirmation, promotion))) ||
    (v.promotionCommit !== undefined &&
      (!promotionCommit || !promotion || !promotionCommitMatchesPreparation(promotionCommit, promotion))) ||
    (v.promotion !== undefined &&
      (!promotion || promotion.receipt.runId !== v.runId || promotion.receipt.startedAt !== v.startedAt)) ||
    (allocation && allocation.runId !== v.runId) ||
    (v.disposition !== undefined && !disposition) ||
    (disposition && disposition.runId !== v.runId) ||
    (disposition?.kind === "scratch-custody-closed" &&
      (allocation?.kind !== "exclusive-scratch" ||
        disposition.allocationKey !== allocation.allocationKey ||
        disposition.custody.threadReport.threadKey !== allocation.threadKey))
  )
    return;
  return {
    version: 1,
    runId: v.runId,
    startedAt: v.startedAt,
    allocation,
    ...(disposition ? { disposition } : {}),
    ...(promotion ? { promotion } : {}),
    ...(promotionCommit ? { promotionCommit } : {}),
    ...(confirmation ? { promotionConfirmation: confirmation } : {}),
    ...(promotionAllocationAck ? { promotionAllocationAck } : {}),
    ...(v.promotionStepBase !== undefined ? { promotionStepBase: v.promotionStepBase as number } : {}),
  };
}

export interface StoredWorkspaceCustody {
  events: readonly RunEvent[];
  step?: StepRecord;
  session?: { key: string; from: number; through: number; transcriptHash: string; pinRevision: number };
  threadReport?: WorkspaceThreadReport & { text: string };
  /** True only when read from the existing canonical jobs/effects, not input JSON. */
  pendingEffects: boolean;
  leaseHash?: string;
  reportHash?: string;
}

/** Refusal-only snapshot of the authority/custody inputs used below. It does
 * not copy model histories into an ownership inventory or mint an ACK. */
export function workspaceCustodyFingerprint(row: LiveRunRow, facts: StoredWorkspaceCustody): string {
  const lease = facts.events.find((e) => e.type === "lease");
  const report = [...facts.events].reverse().find((e) => e.type === "answer");
  return JSON.stringify({
    ownerGen: row.ownerGen,
    phase: row.phase,
    meta: {
      workspaceAllocation: row.meta.workspaceAllocation,
      userId: row.meta.userId,
      threadKey: row.meta.threadKey,
      repo: row.meta.repo,
      ref: row.meta.ref,
      headSha: row.meta.headSha,
      parentInstanceId: row.meta.parentInstanceId,
      coordinatorUnit: row.meta.coordinatorUnit,
      idempotencyKey: row.meta.idempotencyKey,
      maintenanceActionId: row.meta.maintenanceActionId,
      session: row.meta.session,
      readonly: row.meta.readonly,
      identity: row.meta.profile?.identity,
    },
    state: {
      binding: row.state.binding,
      harness: row.state.harness,
      reviewPublication: row.state.reviewPublication,
      branchPublication: row.state.branchPublication,
      doorPublicationPending: row.state.doorPublicationPending,
      publicationSettlement: row.state.publicationSettlement,
      pausedForRetry: row.state.pausedForRetry,
      checkExecutions: row.state.checkExecutions,
    },
    step: facts.step,
    lease,
    report,
    toolCustody: facts.events
      .filter((e) => e.type === "tool_call" || e.type === "tool_result")
      .map((e) =>
        e.type === "tool_result"
          ? { type: e.type, seq: e.seq, callId: e.callId, tool: e.tool, ok: e.ok, cut: e.cut, infra: e.infra }
          : {
              type: e.type,
              seq: e.seq,
              callId: "callId" in e ? e.callId : undefined,
              tool: "tool" in e ? e.tool : undefined,
            },
      ),
    pendingEffects: facts.pendingEffects,
  });
}

/** Existing recorded-check journal, read from the fenced canonical state.
 * Display exit codes and tool result prose never enter this decision. */
function settledRecordedCheck(row: LiveRunRow, callId: string, receipt: unknown): boolean {
  if (
    !object(receipt) ||
    receipt.callId !== callId ||
    !hash(receipt.inputHash) ||
    !hash(receipt.commandHash) ||
    !object(receipt.owner) ||
    !object(receipt.workspace) ||
    !object(receipt.outcome) ||
    receipt.owner.runId !== row.runId ||
    receipt.owner.requester !== row.meta.userId ||
    receipt.owner.threadKey !== row.meta.threadKey ||
    receipt.owner.repo !== row.meta.repo ||
    receipt.owner.unit !== row.meta.idempotencyKey
  )
    return false;
  const binding = row.state.binding;
  if (
    !object(binding) ||
    !text(binding.workspace) ||
    receipt.workspace.cwd !== binding.workspace ||
    typeof receipt.workspace.head !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(receipt.workspace.head) ||
    typeof receipt.workspace.fingerprint !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(receipt.workspace.fingerprint) ||
    typeof receipt.startedAt !== "number" ||
    !Number.isFinite(receipt.startedAt) ||
    typeof receipt.completedAt !== "number" ||
    !Number.isFinite(receipt.completedAt) ||
    receipt.completedAt < receipt.startedAt
  )
    return false;
  const outcome = receipt.outcome;
  if (outcome.kind === "not_started")
    return ["command_refused", "budget_exhausted", "stopped"].includes(String(outcome.reason));
  return (
    outcome.kind === "completed" &&
    Number.isInteger(outcome.exitCode) &&
    Number(outcome.exitCode) >= 0 &&
    Number(outcome.exitCode) <= 255 &&
    ![124, 137, 143].includes(Number(outcome.exitCode)) &&
    typeof outcome.stdout === "string" &&
    typeof outcome.stderr === "string" &&
    typeof outcome.truncated === "boolean"
  );
}

/** This transaction-derived receipt describes durable custody, not physical
 * quiescence or a native stop permit. Phase-two consumers must recheck binding. */
export function deriveWorkspaceDisposition(
  a: WorkspaceAllocation,
  row: LiveRunRow,
  record: RunRecord | undefined,
  stored: StoredWorkspaceCustody,
): WorkspaceDisposition {
  const hold = (reason: string): WorkspaceDisposition => ({
    version: 1,
    kind: "retained",
    runId: row.runId,
    ownerGen: row.ownerGen,
    reason,
  });
  if (!allocationMatchesRun(a, row.runId, row.meta)) return hold("original-allocation-mismatch");
  if (!sameWorkspaceAllocation(row.meta.workspaceAllocation, a)) return hold("original-allocation-mismatch");
  if (a.kind !== "exclusive-scratch") return hold("durable-workspace");
  if (row.meta.readonly !== true || row.meta.profile?.identity !== "read") return hold("original-allocation-mismatch");
  if (!record) return hold("abandoned-custody-unverified");
  if (record.startedAt !== row.startedAt) return hold("original-admission-mismatch");
  if (!allocationMatchesRecord(a, record) || record.provisional || record.restarting || row.phase !== "finishing")
    return hold("terminal-custody-unverified");
  const binding = row.state.binding,
    harness = row.state.harness;
  if (
    !object(binding) ||
    binding.backend !== "sandbox" ||
    binding.sandboxKey !== a.allocationKey ||
    !text(binding.container) ||
    binding.ref !== a.ref ||
    !object(harness) ||
    harness.container !== binding.container ||
    harness.relaunches !== 0 ||
    !processBirth(harness.processBirth) ||
    !hash(harness.bearerHash)
  )
    return hold("execution-custody-unverified");
  const lease = stored.events.find((event) => event.type === "lease");
  if (
    !lease ||
    lease.type !== "lease" ||
    !natural(lease.seq) ||
    lease.seq === 0 ||
    !Number.isFinite(lease.startedAt) ||
    !Number.isFinite(lease.endsAt) ||
    lease.endsAt <= lease.startedAt
  )
    return hold("original-deadline-unverified");
  const report = [...stored.events].reverse().find((event) => event.type === "answer");
  const session = stored.session,
    threadReport = stored.threadReport,
    step = stored.step,
    originalSession = row.meta.session;
  if (
    !report ||
    report.type !== "answer" ||
    !natural(report.seq) ||
    report.seq === 0 ||
    !report.text ||
    !session ||
    !originalSession ||
    originalSession.range === "broken" ||
    session.key !== originalSession.key ||
    session.from !== originalSession.seedFrom ||
    !step ||
    step.inFlight.length !== 0 ||
    session.through !== originalSession.seedFrom + step.turnIndex - 1 ||
    !threadReport ||
    threadReport.threadKey !== a.threadKey ||
    threadReport.rowId !== `run:${row.runId}:answer` ||
    threadReport.text !== report.text ||
    !natural(threadReport.from) ||
    threadReport.through !== threadReport.from ||
    !hash(threadReport.rowsHash) ||
    !natural(threadReport.pinRevision) ||
    threadReport.pinRevision === 0 ||
    !natural(session.pinRevision) ||
    session.pinRevision === 0 ||
    !hash(session.transcriptHash)
  )
    return hold("report-session-custody-unverified");
  if (
    !record.events.some((event) => event.type === "answer" && event.seq === report.seq && event.text === report.text) ||
    !record.events.some(
      (event) => event.type === "lease" && event.seq === lease.seq && JSON.stringify(event) === JSON.stringify(lease),
    ) ||
    record.session?.key !== session.key ||
    record.session.range === "broken" ||
    record.session.range.to !== session.through
  )
    return hold("terminal-report-custody-unverified");
  if (!hash(stored.leaseHash) || !hash(stored.reportHash)) return hold("terminal-report-custody-unverified");
  if (stored.pendingEffects) return hold("pending-effects");
  const called = stored.events.filter((e) => e.type === "tool_call");
  const checks = row.state.checkExecutions;
  if (checks !== undefined && (!object(checks) || checks.version !== 1 || !Array.isArray(checks.receipts)))
    return hold("tool-effect-custody-unverified");
  const receipts = object(checks) && Array.isArray(checks.receipts) ? checks.receipts : [];
  if (
    new Set(receipts.map((r) => (object(r) ? r.callId : undefined))).size !== receipts.length ||
    receipts.some((r) => !object(r) || typeof r.callId !== "string" || !settledRecordedCheck(row, r.callId, r))
  )
    return hold("tool-effect-custody-unverified");
  if (
    called.some((call) => {
      if (call.type !== "tool_call" || !call.callId) return true;
      const result = [...stored.events].reverse().find((e) => e.type === "tool_result" && e.callId === call.callId);
      if (!result || result.type !== "tool_result") return true;
      const receipt = receipts.find((r) => object(r) && r.callId === call.callId);
      return receipt
        ? !settledRecordedCheck(row, call.callId, receipt)
        : result.ok !== true || result.cut === true || result.infra === true;
    })
  )
    return hold("tool-effect-custody-unverified");
  for (const key of ["doorPublicationPending", "branchPublication", "publicationSettlement"] as const)
    if (row.state[key] !== undefined && row.state[key] !== null) return hold("private-publication-custody");
  if (a.custody === "session-report-and-review-publication") {
    const publication = reviewPublicationOf(row.state.reviewPublication);
    if (!publication || publication.runId !== row.runId || !["accepted", "refused"].includes(publication.state))
      return hold("review-publication-unconfirmed");
  } else if (row.state.reviewPublication !== undefined) {
    const publication = reviewPublicationOf(row.state.reviewPublication);
    if (!publication || publication.runId !== row.runId || !["accepted", "refused"].includes(publication.state))
      return hold("review-publication-unconfirmed");
  }
  return {
    version: 1,
    kind: "scratch-custody-closed",
    runId: row.runId,
    ownerGen: row.ownerGen,
    allocationKey: a.allocationKey,
    container: binding.container,
    custody: {
      leaseSeq: lease.seq,
      leaseHash: stored.leaseHash,
      reportSeq: report.seq,
      reportHash: stored.reportHash,
      step: step.step,
      sessionKey: session.key,
      from: session.from,
      through: session.through,
      transcriptHash: session.transcriptHash,
      pinRevision: session.pinRevision,
      threadReport: {
        key: threadReport.key,
        threadKey: threadReport.threadKey,
        rowId: threadReport.rowId,
        from: threadReport.from,
        through: threadReport.through,
        rowsHash: threadReport.rowsHash,
        pinRevision: threadReport.pinRevision,
      },
    },
    execution: { processBirth: harness.processBirth, bearerHash: harness.bearerHash },
  };
}

export const originalPromotionArchiveKey = (runId: string, bodySha256: string): string =>
  `promotion-original:${runId}:${bodySha256}`;
