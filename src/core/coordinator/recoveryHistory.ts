import {
  isCoordinatorUnit,
  isCoordinatorEnding,
  INSTANCE_ID_PATTERN,
  mainTaskClaimMatches,
  preserveWorkBrief,
  hasRecoverySettlementCapacity,
  RECOVERY_ROW_MAX_BYTES,
  RECOVERY_SETTLEMENT_MAX_BYTES,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";

/** Evidence belongs to the original unit. These rows confer no authority. */
export interface RecoveryRequest {
  userId: string;
  threadKey: string;
  messageId: string;
}
export interface RecoveryAction {
  version: 1;
  id: string;
  instanceId: string;
  unit: string;
  request: RecoveryRequest;
  repo: string;
  base: string;
  branch: string;
  actId?: string;
  mainThreadKey: string;
  workerThreadKey: string;
  predecessorId: string;
  workflowId: string;
  reviewRunId?: string;
  codingRunId?: string;
  externalReviewId?: number;
  expectedHeadSha: string;
  payloadDigest: string;
  /** Exact canonical admission fields behind the digest; no report text is interpreted. */
  payload: string;
  state: "pending" | "refused" | "settled";
  error?: string;
  receiptId?: string;
  /** A completed/terminal Workflow consumed the transition even if it refused. */
  consumed: boolean;
}
export interface RecoveryReceipt {
  version: 1;
  id: string;
  seq: number;
  instanceId: string;
  unit: string;
  provenance: "observed_predecessor" | "recovery_settlement";
  predecessorId?: string;
  actionId?: string;
  workflowId?: string;
  ending: NonNullable<CoordinatorUnit["ending"]>;
}
export interface RecoveryHistoryPage {
  receipts: RecoveryReceipt[];
  cursor: number;
  more: boolean;
}
export type RecoveryTransition = { expected: CoordinatorUnit; replacement: CoordinatorUnit } & (
  | { kind: "claim"; request: RecoveryRequest }
  | { kind: "settle" }
  | { kind: "refuse"; error: string; consumed?: boolean }
);
export type RecoveryTransitionResult =
  | { ok: true; unit: CoordinatorUnit; replayed?: true }
  | { ok: false; reason: "stale" | "conflict" | "capacity" | "unavailable" };

export const RECOVERY_HISTORY_LIMITS = {
  actions: 32,
  receipts: 33,
  totalBytes: 6 * 1024 * 1024,
  unitBytes: RECOVERY_ROW_MAX_BYTES,
  receiptBytes: RECOVERY_SETTLEMENT_MAX_BYTES + 4096,
  actionBytes: 8 * 1024,
  requestBytes: 480 * 1024,
  pageCount: 8,
  pageBytes: 384 * 1024,
} as const;

export const recoveryBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const claimSourceRunId = (claim: NonNullable<CoordinatorUnit["recovery"]>): string =>
  claim.kind === "coding" ? claim.codingRunId : claim.reviewRunId;
const actionSourceRunId = (action: RecoveryAction): string | undefined => action.codingRunId ?? action.reviewRunId;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, part: unknown) =>
    object(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part,
  );
const digest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
export function isRecoveryRequest(v: unknown): v is RecoveryRequest {
  return object(v) && Object.keys(v).length === 3 && text(v.userId) && text(v.threadKey) && text(v.messageId);
}
export async function recoveryActionId(
  key: Pick<CoordinatorUnit, "instanceId" | "unit">,
  request: RecoveryRequest,
): Promise<string> {
  return `r_${await digest([1, key.instanceId, key.unit, request.userId, request.threadKey, request.messageId])}`;
}
export function isRecoveryTransition(v: unknown): v is RecoveryTransition {
  return (
    object(v) &&
    isCoordinatorUnit(v.expected) &&
    isCoordinatorUnit(v.replacement) &&
    v.expected.instanceId === v.replacement.instanceId &&
    v.expected.unit === v.replacement.unit &&
    ((v.kind === "claim" && isRecoveryRequest(v.request)) ||
      v.kind === "settle" ||
      (v.kind === "refuse" && text(v.error, 128) && (v.consumed === undefined || typeof v.consumed === "boolean")))
  );
}
export function isRecoveryAction(v: unknown): v is RecoveryAction {
  if (!object(v)) return false;
  const fields = [
    "version",
    "id",
    "instanceId",
    "unit",
    "request",
    "repo",
    "base",
    "branch",
    "actId",
    "mainThreadKey",
    "workerThreadKey",
    "predecessorId",
    "workflowId",
    "reviewRunId",
    "codingRunId",
    "externalReviewId",
    "expectedHeadSha",
    "payloadDigest",
    "payload",
    "state",
    "error",
    "receiptId",
    "consumed",
  ];
  return (
    Object.keys(v).every((key) => fields.includes(key)) &&
    v.version === 1 &&
    [
      v.id,
      v.instanceId,
      v.unit,
      v.repo,
      v.base,
      v.branch,
      v.mainThreadKey,
      v.workerThreadKey,
      v.predecessorId,
      v.workflowId,
    ].every((value) => text(value)) &&
    text(v.reviewRunId) !== text(v.codingRunId) &&
    (v.actId === undefined || text(v.actId, 128)) &&
    isRecoveryRequest(v.request) &&
    typeof v.expectedHeadSha === "string" &&
    /^[a-f0-9]{40}$/i.test(v.expectedHeadSha) &&
    typeof v.payloadDigest === "string" &&
    /^[a-f0-9]{64}$/.test(v.payloadDigest) &&
    text(v.payload, RECOVERY_HISTORY_LIMITS.actionBytes) &&
    (v.externalReviewId === undefined ||
      (Number.isSafeInteger(v.externalReviewId) && (v.externalReviewId as number) > 0)) &&
    typeof v.consumed === "boolean" &&
    ((v.state === "pending" && !v.consumed && v.error === undefined && v.receiptId === undefined) ||
      (v.state === "refused" && text(v.error, 128) && v.receiptId === undefined) ||
      (v.state === "settled" && v.consumed && text(v.receiptId) && v.error === undefined)) &&
    recoveryBytes(v) <= RECOVERY_HISTORY_LIMITS.actionBytes
  );
}
export function isRecoveryReceipt(v: unknown): v is RecoveryReceipt {
  if (!object(v)) return false;
  const fields = [
    "version",
    "id",
    "seq",
    "instanceId",
    "unit",
    "provenance",
    "predecessorId",
    "actionId",
    "workflowId",
    "ending",
  ];
  return (
    Object.keys(v).every((key) => fields.includes(key)) &&
    v.version === 1 &&
    text(v.id) &&
    object(v.ending) &&
    Number.isSafeInteger(v.seq) &&
    (v.seq as number) > 0 &&
    typeof v.instanceId === "string" &&
    INSTANCE_ID_PATTERN.test(v.instanceId) &&
    text(v.unit, 32) &&
    isCoordinatorEnding(v.ending) &&
    ((v.provenance === "observed_predecessor" &&
      v.predecessorId === undefined &&
      v.actionId === undefined &&
      v.workflowId === undefined) ||
      (v.provenance === "recovery_settlement" && text(v.predecessorId) && text(v.actionId) && text(v.workflowId))) &&
    recoveryBytes(v) <= RECOVERY_HISTORY_LIMITS.receiptBytes
  );
}
export function recoveryHistoryPage(receipts: readonly RecoveryReceipt[], after = 0): RecoveryHistoryPage {
  if (!Number.isSafeInteger(after) || after < 0 || !receipts.every(isRecoveryReceipt))
    throw new Error("invalid recovery history");
  const pending = receipts.filter((row) => row.seq > after).sort((a, b) => a.seq - b.seq);
  const page: RecoveryReceipt[] = [];
  for (const row of pending) {
    if (
      page.length >= RECOVERY_HISTORY_LIMITS.pageCount ||
      recoveryBytes([...page, row]) > RECOVERY_HISTORY_LIMITS.pageBytes
    )
      break;
    page.push(row);
  }
  return { receipts: page, cursor: page.at(-1)?.seq ?? after, more: page.length < pending.length };
}

/** Hashing precedes the transaction; the expected unit is compared inside it. */
export async function prepareRecoveryTransition(input: RecoveryTransition) {
  const claim = input.kind === "claim" ? input.replacement.recovery : undefined;
  const {
    previousEnding: _ending,
    previousBinding: _binding,
    claimedAt: _at,
    remainingMs: _remaining,
    deadlineAt: _deadline,
    ...transition
  } = claim ?? {};
  const semantic =
    input.kind === "claim"
      ? {
          version: 1,
          instanceId: input.expected.instanceId,
          unit: input.expected.unit,
          branch: input.expected.branch,
          predecessorId: input.expected.history?.receiptId ?? "observed",
          request: input.request,
          transition,
        }
      : input;
  return {
    input,
    actionId:
      input.kind === "claim"
        ? await recoveryActionId(input.expected, input.request)
        : input.expected.recovery?.actionId,
    payload: canonical(semantic),
    payloadDigest: await digest(semantic),
  };
}
export interface RecoveryJournalState {
  actions: RecoveryAction[];
  receipts: RecoveryReceipt[];
  mainTask?: { instanceId: string; unit: string };
}
type PlannedRecoveryTransition = RecoveryTransitionResult & { action?: RecoveryAction; receipt?: RecoveryReceipt };

/** Pure transaction planner shared by memory and SQLite. No effects occur on refusal. */
export function planRecoveryTransition(
  prepared: Awaited<ReturnType<typeof prepareRecoveryTransition>>,
  instance: CoordinatorInstance | null,
  current: CoordinatorUnit | undefined,
  journal: RecoveryJournalState,
): PlannedRecoveryTransition {
  const { input, actionId, payloadDigest, payload } = prepared;
  const { expected } = input;
  const limits = RECOVERY_HISTORY_LIMITS;
  if (
    recoveryBytes({ input }) + 1024 > limits.requestBytes ||
    recoveryBytes(expected) > limits.unitBytes ||
    recoveryBytes(input.replacement) > limits.unitBytes
  )
    return { ok: false, reason: "capacity" };
  if (
    !isRecoveryTransition(input) ||
    !instance ||
    instance.id !== expected.instanceId ||
    !current ||
    !actionId ||
    !journal.actions.every(
      (row) => isRecoveryAction(row) && row.instanceId === expected.instanceId && row.unit === expected.unit,
    ) ||
    !journal.receipts.every(
      (row) => isRecoveryReceipt(row) && row.instanceId === expected.instanceId && row.unit === expected.unit,
    )
  )
    return { ok: false, reason: "conflict" };
  // Each transition is a whole-row write, but none can move the original
  // conversation, request, or pull request to a different identity.
  for (const field of [
    "instanceId",
    "unit",
    "branch",
    "threadKey",
    "sourceUrl",
    "reviewThread",
    "pr",
    "workBrief",
    "context",
    "generatedTask",
    "threadEvidence",
  ] as const)
    if (!same(expected[field], input.replacement[field])) return { ok: false, reason: "conflict" };
  const prior = journal.actions.find((row) => row.id === actionId);
  if (input.kind === "claim" && prior) {
    if (
      prior.payloadDigest === payloadDigest &&
      prior.payload === payload &&
      prior.state === "pending" &&
      current.recovery?.actionId === actionId
    )
      return { ok: true, unit: current, replayed: true };
    return { ok: false, reason: "conflict" };
  }
  let unit = preserveWorkBrief(expected, input.replacement);
  if (input.kind === "refuse" && unit.history === undefined && expected.history !== undefined)
    unit = { ...unit, history: expected.history };
  if (
    input.kind !== "claim" &&
    prior &&
    expected.recovery !== undefined &&
    prior.workflowId === expected.recovery?.workflowId &&
    actionSourceRunId(prior) === claimSourceRunId(expected.recovery)
  ) {
    const restored = input.kind === "settle" ? { ...unit, history: { version: 1, receiptId: actionId } } : unit;
    if (
      same(current, restored) &&
      ((input.kind === "refuse" &&
        prior.state === "refused" &&
        prior.error === input.error &&
        prior.consumed === (input.consumed === true)) ||
        (input.kind === "settle" &&
          prior.state === "settled" &&
          journal.receipts.some((row) => row.id === prior.receiptId && same(row.ending, unit.ending))))
    )
      return { ok: true, unit: current, replayed: true };
  }
  if (!same(current, expected)) return { ok: false, reason: "stale" };
  let action: RecoveryAction;
  let receipt: RecoveryReceipt | undefined;
  if (input.kind === "claim") {
    const claim = unit.recovery;
    if (
      instance.stop !== undefined ||
      instance.admission === "unreconciled" ||
      !text(instance.base) ||
      !claim ||
      expected.recovery ||
      !expected.ending ||
      unit.ending ||
      (expected.workBrief !== undefined &&
        (journal.mainTask?.instanceId !== instance.id ||
          journal.mainTask.unit !== expected.unit ||
          !mainTaskClaimMatches(
            { mainThreadKey: expected.workBrief.mainThreadKey, actId: expected.workBrief.actId },
            instance,
            expected,
          ))) ||
      !same(claim.previousEnding, expected.ending) ||
      input.request.userId !== instance.userId ||
      input.request.threadKey !== (expected.threadKey ?? instance.threadKey) ||
      unit.branch !== expected.branch ||
      !same(unit.workBrief, expected.workBrief) ||
      !same(unit.context, expected.context) ||
      !same(unit.generatedTask, expected.generatedTask) ||
      !same(unit.history, expected.history) ||
      claim.actionId !== undefined ||
      journal.actions.some(
        (row) =>
          row.consumed &&
          (actionSourceRunId(row) === claimSourceRunId(claim) ||
            (claim.externalReview !== undefined && row.externalReviewId === claim.externalReview.id)),
      )
    )
      return { ok: false, reason: "conflict" };
    const predecessorId = expected.history?.receiptId ?? "observed";
    const predecessor = journal.receipts.find((row) => row.id === predecessorId);
    if (expected.history ? !predecessor || !same(predecessor.ending, expected.ending) : journal.receipts.length > 0)
      return { ok: false, reason: "conflict" };
    if (!predecessor)
      receipt = {
        version: 1,
        id: predecessorId,
        seq: 1,
        instanceId: expected.instanceId,
        unit: expected.unit,
        provenance: "observed_predecessor",
        ending: expected.ending,
      };
    action = {
      version: 1,
      id: actionId,
      instanceId: expected.instanceId,
      unit: expected.unit,
      request: input.request,
      repo: instance.repo,
      base: instance.base,
      branch: expected.branch,
      ...(expected.workBrief ? { actId: expected.workBrief.actId } : {}),
      mainThreadKey: instance.threadKey,
      workerThreadKey: expected.threadKey ?? instance.threadKey,
      predecessorId,
      workflowId: claim.workflowId,
      ...(claim.kind === "coding" ? { codingRunId: claim.codingRunId } : { reviewRunId: claim.reviewRunId }),
      ...(claim.externalReview ? { externalReviewId: claim.externalReview.id } : {}),
      expectedHeadSha: claim.expectedHeadSha,
      payloadDigest,
      payload,
      state: "pending",
      consumed: false,
    };
    // The final slot and the largest permitted result are reserved before any create.
    const occupied =
      journal.receipts.reduce((n, row) => n + recoveryBytes(row), 0) +
      journal.actions.reduce((n, row) => n + recoveryBytes(row), 0);
    if (
      journal.actions.length + 1 > limits.actions ||
      journal.receipts.length + (receipt ? 1 : 0) + 1 > limits.receipts ||
      occupied + (receipt ? recoveryBytes(receipt) : 0) + limits.actionBytes + limits.receiptBytes > limits.totalBytes
    )
      return { ok: false, reason: "capacity" };
    unit = { ...unit, history: { version: 1, receiptId: predecessorId }, recovery: { ...claim, actionId } };
    if (!hasRecoverySettlementCapacity(unit)) return { ok: false, reason: "capacity" };
  } else {
    const claim = expected.recovery;
    if (
      !prior ||
      prior.state !== "pending" ||
      !claim ||
      prior.workflowId !== claim.workflowId ||
      actionSourceRunId(prior) !== claimSourceRunId(claim) ||
      expected.history?.receiptId !== prior.predecessorId ||
      unit.recovery !== undefined ||
      !same(unit.history, expected.history) ||
      unit.branch !== expected.branch
    )
      return { ok: false, reason: "conflict" };
    if (input.kind === "settle") {
      if (
        recoveryBytes({ ending: unit.ending, recoveryHold: unit.recoveryHold, recoveryReceipt: unit.recoveryReceipt }) >
        RECOVERY_SETTLEMENT_MAX_BYTES
      )
        return { ok: false, reason: "capacity" };
      if (
        !unit.ending ||
        unit.recoveryReceipt?.workflowId !== prior.workflowId ||
        (unit.recoveryReceipt.codingRunId ?? unit.recoveryReceipt.reviewRunId) !== actionSourceRunId(prior)
      )
        return { ok: false, reason: "conflict" };
      receipt = {
        version: 1,
        id: actionId,
        seq: journal.receipts.length + 1,
        instanceId: expected.instanceId,
        unit: expected.unit,
        provenance: "recovery_settlement",
        predecessorId: prior.predecessorId,
        actionId,
        workflowId: prior.workflowId,
        ending: unit.ending,
      };
      if (journal.receipts.some((row) => row.id === receipt!.id)) return { ok: false, reason: "conflict" };
      action = { ...prior, state: "settled", consumed: true, receiptId: receipt.id };
      unit = { ...unit, history: { version: 1, receiptId: receipt.id } };
    } else {
      if (!same(unit.ending, claim.previousEnding)) return { ok: false, reason: "conflict" };
      action = { ...prior, state: "refused", error: input.error, consumed: input.consumed === true };
    }
  }
  if (
    recoveryBytes(unit) > limits.unitBytes ||
    (receipt && recoveryBytes(receipt) > limits.receiptBytes) ||
    recoveryBytes(action) > limits.actionBytes
  )
    return { ok: false, reason: "capacity" };
  if (!isCoordinatorUnit(unit) || !isRecoveryAction(action) || (receipt && !isRecoveryReceipt(receipt)))
    return { ok: false, reason: "conflict" };
  return { ok: true, unit, action, ...(receipt ? { receipt } : {}) };
}
