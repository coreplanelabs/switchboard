import type { ClaimRequest, LiveRunRow, WorkspaceAllocationAck } from "./types.js";
import type { PromotionHoldReason } from "./promotion.js";
import {
  allocationMatchesRun,
  sameWorkspaceAllocation,
  workspaceAllocationOf,
  workspaceDurabilityArchiveOf,
} from "./workspaceDurability.js";

export interface OriginalPromotionDiagnosis {
  readonly phase:
    "prepare" | "claim" | "source-owner" | "source-seed" | "source-verification" | "confirmation" | "release";
  readonly operation: "write" | "read";
  readonly reason: PromotionHoldReason | "missing" | "owner" | "transient" | "invalid";
}

/** The original allocation-bearing claim may have committed. This is neither
 * a refusal nor permission to attach or issue the claim again. */
export class UnknownAllocationClaimError extends Error {
  readonly diagnosis?: Readonly<OriginalPromotionDiagnosis>;
  constructor(cause: unknown, diagnosis?: OriginalPromotionDiagnosis) {
    const bounded = diagnosis && { phase: diagnosis.phase, operation: diagnosis.operation, reason: diagnosis.reason };
    super(
      "The original allocation claim outcome is unknown." +
        (bounded ? ` Phase: ${bounded.phase}; ${bounded.operation}: ${bounded.reason}.` : ""),
      { cause },
    );
    this.name = "UnknownAllocationClaimError";
    if (bounded) this.diagnosis = Object.freeze(bounded);
  }
}

/** Called only inside the successful owning-store claim commit, with its
 * actual live row and private original archive. Never constructed from input. */
export function allocationAckFromCanonical(
  raw: unknown,
  row: LiveRunRow | undefined,
): WorkspaceAllocationAck | undefined {
  const archive = workspaceDurabilityArchiveOf(raw);
  if (
    !row ||
    !archive ||
    archive.runId !== row.runId ||
    archive.startedAt !== row.startedAt ||
    row.threadKey !== row.meta.threadKey ||
    (archive.allocation && !allocationMatchesRun(archive.allocation, row.runId, row.meta))
  )
    return;
  return structuredClone({
    version: 1,
    runId: row.runId,
    threadKey: row.threadKey,
    gen: row.ownerGen,
    startedAt: row.startedAt,
    allocation: archive.allocation,
  });
}

/** Unknown/older replies stay tracked without an acknowledged allocation.
 * Current prototype v1 contracts are still not runtime disposal eligibility. */
export function allocationAckOf(
  value: unknown,
  expected: Pick<ClaimRequest, "runId" | "threadKey" | "gen" | "startedAt" | "meta">,
): WorkspaceAllocationAck | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const ack = value as Record<string, unknown>;
  if (
    Object.keys(ack).some(
      (key) => !["version", "runId", "threadKey", "gen", "startedAt", "allocation"].includes(key),
    ) ||
    ack.version !== 1 ||
    ack.runId !== expected.runId ||
    ack.threadKey !== expected.threadKey ||
    ack.gen !== expected.gen ||
    ack.startedAt !== expected.startedAt ||
    !Number.isFinite(ack.startedAt) ||
    expected.threadKey !== expected.meta.threadKey
  )
    return;
  if (ack.allocation === null)
    return {
      version: 1,
      runId: expected.runId,
      threadKey: expected.threadKey,
      gen: expected.gen,
      startedAt: expected.startedAt,
      allocation: null,
    };
  const allocation = workspaceAllocationOf(ack.allocation);
  if (
    !allocation ||
    !allocationMatchesRun(allocation, expected.runId, expected.meta) ||
    (expected.meta.workspaceAllocation !== undefined &&
      !sameWorkspaceAllocation(allocation, expected.meta.workspaceAllocation))
  )
    return;
  return structuredClone({
    version: 1,
    runId: expected.runId,
    threadKey: expected.threadKey,
    gen: expected.gen,
    startedAt: expected.startedAt,
    allocation,
  });
}
