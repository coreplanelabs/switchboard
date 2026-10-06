import { branchPublicationOf, doorPublicationOf } from "./branchPublication.js";
import { publicationReceiptsFromState } from "./publicationPush.js";
import { isPublicationSettlement } from "./publicationSettlement.js";
import { branchPushReceiptsOf } from "./runRecord.js";
import type { RunState } from "./runLedger/types.js";

/** Refusal-only history: missing display events never erase a saved write. */
export function branchIdentityCaptureBlocked(state: RunState, repo: string, branch: string): boolean {
  if (state.pushedBranch !== undefined && (typeof state.pushedBranch !== "string" || state.pushedBranch === branch))
    return true;
  if (state.branchPushReceipts !== undefined) {
    const receipts = branchPushReceiptsOf(state.branchPushReceipts);
    if (!receipts || receipts.some((receipt) => receipt.ref === branch)) return true;
  }
  if (state.publicationReceipts !== undefined) {
    const receipts = publicationReceiptsFromState(state.publicationReceipts);
    if (
      !Array.isArray(state.publicationReceipts) ||
      receipts.length !== state.publicationReceipts.length ||
      receipts.some((receipt) => receipt.ref === branch || receipt.receipt?.repo.toLowerCase() !== repo.toLowerCase())
    )
      return true;
  }
  if (state.branchPublication !== undefined) {
    const publication = branchPublicationOf(state.branchPublication, repo);
    if (
      !publication ||
      !publication.complete ||
      publication.pending ||
      publication.branches.some((receipt) => receipt.ref === branch) ||
      publication.targets?.some((target) => target.ref === undefined || target.ref === branch)
    )
      return true;
  }
  if (state.doorPublicationPending !== undefined && state.doorPublicationPending !== null) {
    const door = doorPublicationOf(state.doorPublicationPending);
    if (
      !door ||
      (door.repo !== undefined && door.repo.toLowerCase() !== repo.toLowerCase()) ||
      (door.outcome !== "rejected" && door.outcome !== "not_forwarded")
    )
      return true;
  }
  if (state.publicationSettlement !== undefined) {
    const settlement = state.publicationSettlement;
    if (
      !isPublicationSettlement(settlement) ||
      settlement.binding.repo.toLowerCase() !== repo.toLowerCase() ||
      settlement.binding.branch === branch ||
      settlement.checkpoint.kind === "pending" ||
      settlement.checkpoint.kind === "failed" ||
      settlement.checkpoint.kind === "unknown" ||
      settlement.publication.kind === "pending" ||
      settlement.publication.kind === "unknown"
    )
      return true;
  }
  return false;
}
