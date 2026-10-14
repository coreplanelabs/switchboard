import { z } from "zod";
import { reviewPublicationOf, sameReviewPublication, type NativeReviewReceipt } from "./reviewPublication.js";
import {
  REVIEW_FEEDBACK_DAILY_MS,
  REVIEW_FEEDBACK_HOURLY_MS,
  REVIEW_FEEDBACK_LEASE_MS,
  REVIEW_FEEDBACK_RECENT_MS,
  REVIEW_FEEDBACK_RETAIN_MS,
  REVIEW_FEEDBACK_PASS_MS,
  REVIEW_FEEDBACK_TICK_MS,
} from "./budgets.js";
import { systemClock } from "./trace/clock.js";

export interface ReviewFeedbackPublication {
  runId: string;
  repo: string;
  pr: number;
  head: string;
  bodyHash: string;
  format: 1;
  findings: number;
  publishedAt: number;
  review?: NativeReviewReceipt;
}

export function reviewFeedbackPublicationOf(value: unknown): ReviewFeedbackPublication | undefined {
  const receipt = reviewPublicationOf(value);
  if (receipt?.state !== "accepted" || !receipt.feedback) return undefined;
  return {
    runId: receipt.runId,
    repo: receipt.target.repo,
    pr: receipt.target.number,
    head: receipt.target.commitId,
    bodyHash: receipt.bodyHash,
    format: 1,
    findings: receipt.feedback.findings,
    publishedAt: receipt.nativeReview?.publishedAt ?? receipt.feedback.at,
    ...(receipt.nativeReview ? { review: receipt.nativeReview } : {}),
  };
}

/** Only the original owner's matching pending → accepted transition creates a cohort row. */
export function retainedFeedbackReceipt(
  previous: unknown,
  next: unknown,
  owner: { runId: string; repo?: string; pr?: number },
): import("./reviewPublication.js").ReviewPublicationReceipt | undefined {
  const before = reviewPublicationOf(previous),
    after = reviewPublicationOf(next);
  if (
    !before ||
    !after ||
    before.state !== "pending" ||
    after.state !== "accepted" ||
    !after.feedback ||
    !sameReviewPublication(before, after) ||
    after.runId !== owner.runId ||
    after.target.repo !== owner.repo ||
    after.target.number !== owner.pr ||
    JSON.stringify(before.feedback) !== JSON.stringify(after.feedback)
  )
    return undefined;
  return after;
}

const vote = z
  .object({
    id: z.string().min(1).max(256),
    actorId: z.string().min(1).max(256).optional(),
    actorType: z.enum(["User", "Bot", "Unknown"]),
    content: z.enum(["up", "down"]),
  })
  .strict();
export type ReviewFeedbackVote = z.infer<typeof vote>;
const snapshot = z
  .object({
    status: z.enum(["complete", "unavailable", "content_changed"]),
    checkedAt: z.number().int().positive(),
    completedAt: z.number().int().positive().optional(),
    votes: z.array(vote).max(2000).optional(),
  })
  .strict()
  .refine((s) => s.status !== "complete" || s.votes !== undefined);
export type ReviewFeedbackSnapshot = z.infer<typeof snapshot>;
export const isReviewFeedbackSnapshot = (value: unknown): value is ReviewFeedbackSnapshot =>
  snapshot.safeParse(value).success;

export interface ReviewFeedbackEntry {
  publication: ReviewFeedbackPublication;
  snapshot?: ReviewFeedbackSnapshot;
}
export function isReviewFeedbackEntry(value: unknown): value is ReviewFeedbackEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>,
    p = row.publication as Record<string, unknown> | undefined;
  if (
    !p ||
    Object.keys(row).some((k) => !["publication", "snapshot"].includes(k)) ||
    Object.keys(p).some(
      (k) => !["runId", "repo", "pr", "head", "bodyHash", "format", "findings", "publishedAt", "review"].includes(k),
    )
  )
    return false;
  const decoded = reviewFeedbackPublicationOf({
    version: 1,
    runId: p.runId,
    target: { repo: p.repo, number: p.pr, commitId: p.head },
    bodyHash: p.bodyHash,
    state: "accepted",
    feedback: { format: p.format, findings: p.findings, at: p.publishedAt },
    ...(p.review !== undefined ? { nativeReview: p.review } : {}),
  });
  return (
    decoded !== undefined &&
    decoded.publishedAt === p.publishedAt &&
    (row.snapshot === undefined || isReviewFeedbackSnapshot(row.snapshot))
  );
}
export const validFeedbackRange = (sinceMs: number, untilMs: number): boolean =>
  Number.isSafeInteger(sinceMs) &&
  sinceMs >= 0 &&
  Number.isSafeInteger(untilMs) &&
  untilMs > sinceMs &&
  untilMs - sinceMs <= REVIEW_FEEDBACK_RETAIN_MS;
export interface ReviewFeedbackClaim {
  publication: ReviewFeedbackPublication;
  lease: number;
}
export interface ReviewFeedbackWindow {
  entries: ReviewFeedbackEntry[];
  collectionStartedAt?: number;
}
export interface ReviewFeedbackStore {
  list(sinceMs: number, untilMs: number): Promise<ReviewFeedbackWindow>;
  claim(now: number, limit: number): Promise<ReviewFeedbackClaim[]>;
  complete(claim: ReviewFeedbackClaim, update: ReviewFeedbackSnapshot, now: number): Promise<boolean>;
  cooldown(untilMs: number): Promise<void>;
}

export interface ReviewFeedbackSource {
  read(publication: ReviewFeedbackPublication): Promise<ReviewFeedbackVote[]>;
}
export class ReviewFeedbackReadError extends Error {
  constructor(
    readonly kind: "unavailable" | "content_changed",
    readonly retryAt?: number,
  ) {
    super(`Review feedback ${kind}`);
  }
}

/** Collection has no publication capability and never changes a run's verdict. */
export async function refreshReviewFeedback(
  store: ReviewFeedbackStore,
  source: ReviewFeedbackSource,
  opts: { now?: () => number; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? systemClock;
  const deadline = now() + REVIEW_FEEDBACK_PASS_MS;
  let completed = 0;
  for (let i = 0; i < Math.min(opts.limit ?? 20, 20) && now() < deadline; i++) {
    const [claim] = await store.claim(now(), 1);
    if (!claim) break;
    let update: ReviewFeedbackSnapshot;
    let retryAt: number | undefined;
    try {
      const votes = claim.publication.review ? await source.read(claim.publication) : undefined;
      update = votes ? { status: "complete", checkedAt: now(), votes } : { status: "unavailable", checkedAt: now() };
    } catch (error) {
      update = { status: error instanceof ReviewFeedbackReadError ? error.kind : "unavailable", checkedAt: now() };
      retryAt = error instanceof ReviewFeedbackReadError ? error.retryAt : undefined;
    }
    if (await store.complete(claim, update, now())) completed++;
    if (retryAt !== undefined) {
      await store.cooldown(retryAt);
      break;
    }
  }
  return completed;
}

/** One local pass at a time; durable leases coordinate replicas and survive restart. */
export function startReviewFeedbackRefresh(
  store: ReviewFeedbackStore,
  source: ReviewFeedbackSource,
  opts: {
    warn: (message: string) => void;
    setInterval?: (tick: () => void, ms: number) => { unref?(): void };
  },
): void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void refreshReviewFeedback(store, source)
      .catch(() => opts.warn("Review feedback refresh failed; the next tick will retry."))
      .finally(() => {
        running = false;
      });
  };
  (opts.setInterval ?? setInterval)(tick, REVIEW_FEEDBACK_TICK_MS).unref?.();
  tick();
}

export const feedbackInterval = (publication: ReviewFeedbackPublication, now: number): number =>
  now - publication.publishedAt <= REVIEW_FEEDBACK_RECENT_MS ? REVIEW_FEEDBACK_HOURLY_MS : REVIEW_FEEDBACK_DAILY_MS;

/** A failed/partial read can mark old data stale, but cannot invent vote removal. */
export function mergeFeedbackSnapshot(
  previous: ReviewFeedbackSnapshot | undefined,
  update: ReviewFeedbackSnapshot,
): ReviewFeedbackSnapshot {
  return update.status === "complete"
    ? { ...update, completedAt: update.checkedAt }
    : {
        status: update.status,
        checkedAt: update.checkedAt,
        ...(previous?.votes ? { votes: previous.votes } : {}),
        ...(previous?.completedAt ? { completedAt: previous.completedAt } : {}),
      };
}

export class InMemoryReviewFeedbackStore implements ReviewFeedbackStore {
  private readonly rows = new Map<string, ReviewFeedbackEntry & { lease: number; until: number }>();
  private blockedUntil = 0;
  private collectionStartedAt: number | undefined;
  constructor(private readonly now: () => number = systemClock) {}
  retain(publication: ReviewFeedbackPublication): void {
    this.collectionStartedAt ??= publication.publishedAt;
    if (
      publication.review &&
      [...this.rows.values()].some(
        (r) =>
          r.publication.repo.toLowerCase() === publication.repo.toLowerCase() &&
          r.publication.review?.id === publication.review!.id,
      )
    )
      return;
    if (!this.rows.has(publication.runId))
      this.rows.set(publication.runId, { publication: structuredClone(publication), lease: 0, until: 0 });
  }
  async list(sinceMs: number, untilMs: number): Promise<ReviewFeedbackWindow> {
    if (!validFeedbackRange(sinceMs, untilMs)) throw new Error("Invalid review feedback range");
    const entries = [...this.rows.values()]
      .filter(
        (r) =>
          r.publication.publishedAt >= Math.max(sinceMs, this.now() - REVIEW_FEEDBACK_RETAIN_MS) &&
          r.publication.publishedAt < untilMs,
      )
      .sort((a, b) => a.publication.runId.localeCompare(b.publication.runId))
      .map(({ publication, snapshot }) => structuredClone({ publication, ...(snapshot ? { snapshot } : {}) }));
    return { entries, ...(this.collectionStartedAt ? { collectionStartedAt: this.collectionStartedAt } : {}) };
  }
  async claim(now: number, limit: number): Promise<ReviewFeedbackClaim[]> {
    if (now < this.blockedUntil) return [];
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.publication.publishedAt >= now - REVIEW_FEEDBACK_RETAIN_MS &&
          r.until <= now &&
          (!r.snapshot || r.snapshot.checkedAt + feedbackInterval(r.publication, now) <= now),
      )
      .sort(
        (a, b) =>
          (a.snapshot?.checkedAt ?? 0) - (b.snapshot?.checkedAt ?? 0) ||
          a.publication.runId.localeCompare(b.publication.runId),
      )
      .slice(0, Math.min(limit, 20))
      .map((row) => {
        row.lease++;
        row.until = now + REVIEW_FEEDBACK_LEASE_MS;
        return { publication: structuredClone(row.publication), lease: row.lease };
      });
  }
  async complete(claim: ReviewFeedbackClaim, update: ReviewFeedbackSnapshot, now: number): Promise<boolean> {
    if (!isReviewFeedbackSnapshot(update)) throw new Error("Invalid review feedback snapshot");
    const row = this.rows.get(claim.publication.runId);
    if (!row || row.lease !== claim.lease || row.until <= now) return false;
    row.snapshot = mergeFeedbackSnapshot(row.snapshot, { ...structuredClone(update), checkedAt: now });
    row.until = 0;
    return true;
  }
  async cooldown(untilMs: number): Promise<void> {
    this.blockedUntil = Math.max(this.blockedUntil, untilMs);
  }
}
