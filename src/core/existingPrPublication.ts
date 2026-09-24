import type { PullRequestFacts } from "../execution/githubPulls.js";
import type { ExistingPrPublicationBinding } from "./coordinator/contract.js";

export interface ExistingPrPublicationContext {
  repo?: string;
  pr?: number;
  ref?: string;
  baseRef?: string;
  requestHeadSha?: string;
  workspaceRef?: string;
  workspaceHeadSha?: string;
  owner?: { instanceId: string; unit: string };
}

export type ExistingPrPublicationVerification =
  { ok: true; publication: { ref: string; expectedHeadSha: string } } | { ok: false; reason: string };

const fullSha = (value: string | undefined): value is string => value !== undefined && /^[0-9a-f]{40}$/i.test(value);
const sameOwner = (
  left: { instanceId: string; unit: string } | undefined,
  right: { instanceId: string; unit: string },
): boolean => left?.instanceId === right.instanceId && left.unit === right.unit;
const blocked = (reason: string): ExistingPrPublicationVerification => ({ ok: false, reason });

/**
 * The complete existing-PR publication receipt. No field is inferred from a
 * neighboring read: the durable binding, current dispatch/workspace identity
 * and one fresh PR read must all name the same target at the same full head.
 */
export function verifyExistingPrPublication(
  durable: ExistingPrPublicationBinding | undefined,
  local: ExistingPrPublicationContext,
  remote: PullRequestFacts | undefined,
): ExistingPrPublicationVerification {
  if (durable === undefined) return blocked("the durable existing-PR binding is missing");
  if (!fullSha(durable.expectedHeadSha)) return blocked("the durable expected head is not a full commit SHA");
  if (durable.headRef !== durable.publicationRef)
    return blocked("the durable head ref and owned publication ref do not agree");
  if (local.repo !== durable.repo) return blocked("the resolved repository does not match the durable binding");
  if (local.pr !== durable.pr) return blocked("the resolved pull request does not match the durable binding");
  if (local.ref !== durable.headRef) return blocked("the resolved head ref does not match the durable binding");
  if (local.baseRef !== durable.baseRef) return blocked("the resolved base ref does not match the durable binding");
  if (!fullSha(local.requestHeadSha)) return blocked("the request head is missing or not a full commit SHA");
  if (local.requestHeadSha.toLowerCase() !== durable.expectedHeadSha.toLowerCase())
    return blocked("the request head does not match the durable expected commit");
  if (local.workspaceRef !== durable.publicationRef)
    return blocked("the checked-out publication ref does not match the durable binding");
  if (!fullSha(local.workspaceHeadSha)) return blocked("the checked-out head is missing or not a full commit SHA");
  if (local.workspaceHeadSha.toLowerCase() !== durable.expectedHeadSha.toLowerCase())
    return blocked("the checked-out head does not match the durable expected commit");
  if (!sameOwner(local.owner, durable.owner)) return blocked("the publication owner changed");
  if (remote === undefined) return blocked("the fresh pull-request read is unavailable");
  if (remote.state !== "open") return blocked("the bound pull request is no longer open");
  if (remote.sameRepoHead !== true) return blocked("the pull request head is not in the bound repository");
  if (remote.headBranchExists !== true) return blocked("the pull request head branch is missing or unknown");
  if (remote.headRef !== durable.headRef) return blocked("the pull request head ref moved");
  if (remote.baseRef !== durable.baseRef) return blocked("the pull request base ref moved");
  if (!fullSha(remote.headSha)) return blocked("the fresh pull-request head is missing or not a full commit SHA");
  if (remote.headSha.toLowerCase() !== durable.expectedHeadSha.toLowerCase())
    return blocked("the pull request head moved from the durable expected commit");
  return {
    ok: true,
    publication: { ref: durable.publicationRef, expectedHeadSha: durable.expectedHeadSha.toLowerCase() },
  };
}
