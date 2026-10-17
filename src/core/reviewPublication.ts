import { isPublicationRepo } from "./branchPublication.js";
import type { ReviewPost, ReviewVerdictKind } from "./reviewVerdict.js";

export interface NativeReviewReceipt {
  id: string;
  nodeId: string;
  url: string;
  publishedAt: number;
}

/** Small original-run receipt; public facts contain no review prose. */
export interface ReviewPublicationReceipt {
  version: 1;
  runId: string;
  target: Extract<ReviewPost, { posted: true }>["target"] & { commitId: string };
  bodyHash: string;
  verdict?: ReviewVerdictKind;
  state: "pending" | "accepted" | "refused" | "uncertain";
  nativeReview?: NativeReviewReceipt;
  feedback?: { format: 1; findings: number; at: number };
}
export interface ReviewPublicationJournal {
  runId: string;
  /** Null means confirmed absent; undefined or malformed bytes mean unknown. */
  read(): Promise<unknown>;
  /** The existing fenced run owner also admits the exact publication target. */
  commit(receipt: ReviewPublicationReceipt, signal?: AbortSignal): Promise<"committed" | "refused" | "unknown">;
  /** Fresh owner, stop, requester/grant and audience checks before native POST. */
  canPublish(): Promise<boolean>;
}
/** Trusted adapter result, never decoded from stored receipt bytes. */
export const REVIEW_PUBLICATION_OWNER_ABSENT = Object.freeze({ kind: "owner_absent" as const });

/** Bound a local wait without retrying or detaching an issued native write. */
export async function awaitReviewPublication<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!signal) return work();
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const value = await Promise.race([work(), aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function reviewPublicationOf(value: unknown): ReviewPublicationReceipt | undefined {
  if (!object(value) || !object(value.target)) return undefined;
  const target = value.target;
  if (
    Object.keys(value).some(
      (key) =>
        !["version", "runId", "target", "bodyHash", "verdict", "state", "nativeReview", "feedback"].includes(key),
    ) ||
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
  if (
    value.nativeReview !== undefined &&
    (value.state !== "accepted" ||
      !nativeReviewReceiptOf(value.nativeReview, target.repo as string, target.number as number))
  )
    return undefined;
  if (
    value.feedback !== undefined &&
    (!object(value.feedback) ||
      Object.keys(value.feedback).some((k) => !["format", "findings", "at"].includes(k)) ||
      value.feedback.format !== 1 ||
      !Number.isSafeInteger(value.feedback.findings) ||
      Number(value.feedback.findings) < 0 ||
      !Number.isSafeInteger(value.feedback.at) ||
      Number(value.feedback.at) <= 0)
  )
    return undefined;
  return structuredClone(value) as unknown as ReviewPublicationReceipt;
}

export function nativeReviewReceiptOf(value: unknown, repo: string, pr: number): NativeReviewReceipt | undefined {
  if (!object(value)) return undefined;
  const url =
    typeof value.url === "string"
      ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)#pullrequestreview-([1-9]\d*)$/.exec(value.url)
      : null;
  if (
    Object.keys(value).some((k) => !["id", "nodeId", "url", "publishedAt"].includes(k)) ||
    typeof value.id !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value.id) ||
    typeof value.nodeId !== "string" ||
    value.nodeId.length < 1 ||
    value.nodeId.length > 256 ||
    /\s/.test(value.nodeId) ||
    [...value.nodeId].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    !url ||
    url[1]!.toLowerCase() !== repo.toLowerCase() ||
    url[2] !== String(pr) ||
    url[3] !== value.id ||
    !Number.isSafeInteger(value.publishedAt) ||
    Number(value.publishedAt) <= 0
  )
    return undefined;
  return value as unknown as NativeReviewReceipt;
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
