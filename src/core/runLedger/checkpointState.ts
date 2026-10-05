import type { RunState } from "./types.js";
import { isRunWorkEvidence } from "../runRecord.js";
import { isBranchIdentityBaseline } from "../branchIdentityBaseline.js";

/** Preserve committed evidence; only the source-log acknowledgment may mint a unit seed receipt. */
export function preserveCheckpointState(
  prior: RunState,
  incoming: RunState,
  unitSeedAcknowledged = false,
): RunState | undefined {
  const next = { ...incoming };
  const baseline = prior.branchIdentityBaseline;
  const replacement = incoming.branchIdentityBaseline;
  if (baseline !== undefined) {
    if (
      !isBranchIdentityBaseline(baseline) ||
      (replacement !== undefined &&
        (!isBranchIdentityBaseline(replacement) || JSON.stringify(replacement) !== JSON.stringify(baseline)))
    )
      return undefined;
    next.branchIdentityBaseline = structuredClone(baseline);
  } else if (replacement !== undefined) {
    if (!isBranchIdentityBaseline(replacement)) return undefined;
    next.branchIdentityBaseline = structuredClone(replacement);
  }
  for (const key of ["pendingContextCheckpoint", "contextCheckpointReceipt"] as const) {
    if (incoming[key] !== undefined && JSON.stringify(incoming[key]) !== JSON.stringify(prior[key])) return undefined;
    if (prior[key] !== undefined) next[key] = structuredClone(prior[key]);
  }
  if (prior.unitSeedReceipt !== undefined) {
    if (
      incoming.unitSeedReceipt !== undefined &&
      JSON.stringify(incoming.unitSeedReceipt) !== JSON.stringify(prior.unitSeedReceipt)
    )
      return undefined;
    next.unitSeedReceipt = structuredClone(prior.unitSeedReceipt);
  } else if (incoming.unitSeedReceipt !== undefined && !unitSeedAcknowledged) return undefined;
  if (incoming.workReads === undefined && prior.workReads !== undefined)
    next.workReads = structuredClone(prior.workReads);
  if (
    !isRunWorkEvidence({
      workReads: next.workReads,
      unitSeedReceipt: next.unitSeedReceipt,
      branchIdentityBaseline: next.branchIdentityBaseline,
    })
  )
    return undefined;
  if (
    Array.isArray(prior.workReads) &&
    prior.workReads.some(
      (read) =>
        !(next.workReads as { callId: string }[] | undefined)?.some(
          (value) => value.callId === read.callId && JSON.stringify(value) === JSON.stringify(read),
        ),
    )
  )
    return undefined;
  return next;
}
