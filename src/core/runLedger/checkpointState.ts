import { originalSessionPolicyOf, sameOriginalSessionPolicy } from "../harness/sessionPolicy.js";
import type { RunState } from "./types.js";
import { isRunWorkEvidence } from "../runRecord.js";
import { isBranchIdentityBaseline } from "../branchIdentityBaseline.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve only original session policy so caller snapshots and owning stores
 * share the same wire state without granting checkpoint or unit-seed authority. */
export function preserveHarnessPolicy(prior: RunState, incoming: RunState): RunState | undefined {
  const next = { ...incoming };
  const before = Object.hasOwn(prior, "harness") ? prior.harness : undefined;
  const after = Object.hasOwn(incoming, "harness") ? incoming.harness : undefined;
  const originalRaw = record(before) && Object.hasOwn(before, "sessionPolicy") ? before.sessionPolicy : undefined;
  const replacementRaw = record(after) && Object.hasOwn(after, "sessionPolicy") ? after.sessionPolicy : undefined;
  if (originalRaw === undefined) {
    if (replacementRaw === undefined) return next;
    const replacement = originalSessionPolicyOf(replacementRaw);
    if (before !== undefined || !replacement || !record(after)) return undefined;
    next.harness = { ...after, sessionPolicy: replacement };
    return next;
  }
  if (!originalSessionPolicyOf(originalRaw) || !record(before)) return undefined;
  if (after !== undefined && !record(after)) return undefined;
  if (replacementRaw !== undefined && !sameOriginalSessionPolicy(originalRaw, replacementRaw)) return undefined;
  next.harness = { ...((after ?? before) as Record<string, unknown>), sessionPolicy: structuredClone(originalRaw) };
  return next;
}

/** Preserve committed evidence; only the source-log acknowledgment may mint a unit seed receipt. */
export function preserveCheckpointState(
  prior: RunState,
  incoming: RunState,
  unitSeedAcknowledged = false,
): RunState | undefined {
  const next = preserveHarnessPolicy(prior, incoming);
  if (!next) return undefined;
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
