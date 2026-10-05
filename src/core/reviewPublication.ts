import { isPublicationRepo } from "./branchPublication.js";
import type { ReviewPost, ReviewVerdictKind } from "./reviewVerdict.js";

/** Small original-run receipt; public facts contain no review prose. */
export interface ReviewPublicationReceipt {
  version: 1;
  runId: string;
  target: Extract<ReviewPost, { posted: true }>["target"] & { commitId: string };
  bodyHash: string;
  verdict?: ReviewVerdictKind;
  state: "pending" | "accepted" | "refused" | "uncertain";
}
export interface ReviewPublicationJournal {
  runId: string;
  /** Null means confirmed absent; undefined or malformed bytes mean unknown. */
  read(): Promise<unknown>;
  /** The existing fenced run owner also admits the exact publication target. */
  commit(receipt: ReviewPublicationReceipt): Promise<"committed" | "refused" | "unknown">;
  /** Fresh owner, stop, requester/grant and audience checks before native POST. */
  canPublish(): Promise<boolean>;
}
/** Trusted adapter result, never decoded from stored receipt bytes. */
export const REVIEW_PUBLICATION_OWNER_ABSENT = Object.freeze({ kind: "owner_absent" as const });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function reviewPublicationOf(value: unknown): ReviewPublicationReceipt | undefined {
  if (!object(value) || !object(value.target)) return undefined;
  const target = value.target;
  if (
    Object.keys(value).some((key) => !["version", "runId", "target", "bodyHash", "verdict", "state"].includes(key)) ||
    Object.keys(target).some((key) => !["repo", "number", "commitId"].includes(key)) ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    !value.runId ||
    value.runId.length > 512 ||
    !isPublicationRepo(target.repo) ||
    !Number.isSafeInteger(target.number) ||
    (target.number as number) < 1 ||
    typeof target.commitId !== "string" ||
    !/^[a-f0-9]{40}$/.test(target.commitId) ||
    typeof value.bodyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.bodyHash) ||
    (value.verdict !== undefined && !["approve", "request_changes"].includes(value.verdict as string)) ||
    !["pending", "accepted", "refused", "uncertain"].includes(value.state as string)
  )
    return undefined;
  return structuredClone(value) as unknown as ReviewPublicationReceipt;
}
export function sameReviewPublication(a: ReviewPublicationReceipt, b: ReviewPublicationReceipt): boolean {
  return (
    a.runId === b.runId &&
    a.target.repo === b.target.repo &&
    a.target.number === b.target.number &&
    a.target.commitId === b.target.commitId &&
    a.bodyHash === b.bodyHash &&
    a.verdict === b.verdict
  );
}
export function acceptedReviewPublication(
  receipt: ReviewPublicationReceipt,
): Extract<ReviewPost, { posted: true }> | undefined {
  return receipt.state === "accepted"
    ? {
        posted: true,
        target: { repo: receipt.target.repo, number: receipt.target.number },
        head: receipt.target.commitId,
        ...(receipt.verdict ? { verdict: receipt.verdict } : {}),
      }
    : undefined;
}
