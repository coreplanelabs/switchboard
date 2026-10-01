import type { RunState } from "./types.js";

/** These receipts are minted by the checkpoint transaction, never generic run state. */
export function preserveCheckpointState(prior: RunState, incoming: RunState): RunState | undefined {
  const next = { ...incoming };
  for (const key of ["pendingContextCheckpoint", "contextCheckpointReceipt"] as const) {
    if (incoming[key] !== undefined && JSON.stringify(incoming[key]) !== JSON.stringify(prior[key])) return undefined;
    if (prior[key] !== undefined) next[key] = structuredClone(prior[key]);
  }
  return next;
}
