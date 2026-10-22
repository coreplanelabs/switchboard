import {
  SOURCE_JOB_LEASE_MS,
  SOURCE_JOB_MAX_ATTEMPTS,
  SOURCE_JOB_RETRY_MS,
  SOURCE_RELEVANCE_MAX_CONTEXTS,
} from "../budgets.js";
import type {
  SourceEventJob,
  ClaimedSourceEventJob,
  SourceJobLease,
  SourceJobReleaseReceipt,
  SourceJobReleaseRequest,
  SourceJobReleaseResult,
  SourceRelevanceRequest,
  SourceRelevanceRecord,
  SourceRelevanceSaveResult,
} from "./sourceEvents.js";

export type SourceJobClaimPlan =
  | { kind: "not-due" }
  | { kind: "claimed"; job: ClaimedSourceEventJob; lease: SourceJobLease }
  | { kind: "failed"; job: ClaimedSourceEventJob };

/** Queue ownership is separate from a task's execution lease and permissions. */
export function planSourceJobClaim(job: SourceEventJob, owner: string, now: number): SourceJobClaimPlan {
  if (job.version === 4 || job.nextAttemptAt === null || job.nextAttemptAt > now) return { kind: "not-due" };
  const releases = job.version !== 1 ? job.releases : [];
  const saved = job.version === 3 ? { version: 3 as const, relevance: job.relevance } : { version: 2 as const };
  if (job.attempts >= SOURCE_JOB_MAX_ATTEMPTS)
    return {
      kind: "failed",
      job: {
        ...saved,
        eventKey: job.eventKey,
        stage: "received",
        state: "failed",
        attempts: job.attempts,
        nextAttemptAt: null,
        releases,
        failure: { reason: "attempts-exhausted", at: now },
      },
    };
  const lease: SourceJobLease = { owner, token: crypto.randomUUID(), claimedAt: now, until: now + SOURCE_JOB_LEASE_MS };
  return {
    kind: "claimed",
    lease,
    job: {
      ...saved,
      eventKey: job.eventKey,
      stage: "received",
      state: "leased",
      attempts: job.attempts + 1,
      nextAttemptAt: lease.until,
      lease,
      releases,
    },
  };
}

export type SourceJobReleasePlan =
  | { kind: "changed"; job: ClaimedSourceEventJob; receipt: SourceJobReleaseReceipt }
  | { kind: "replayed"; receipt: SourceJobReleaseReceipt }
  | Extract<SourceJobReleaseResult, { kind: "refused" }>;

export function planSourceJobRelease(
  job: SourceEventJob,
  request: SourceJobReleaseRequest,
  now: number,
): SourceJobReleasePlan {
  if (job.version === 1 || job.version === 4) return { kind: "refused", reason: "fenced" };
  const prior = job.releases.find((receipt) => receipt.token === request.token);
  if (prior)
    return prior.owner === request.owner && prior.disposition === request.disposition && prior.reason === request.reason
      ? { kind: "replayed", receipt: prior }
      : { kind: "refused", reason: "release-conflict" };
  if (
    job.state !== "leased" ||
    job.lease.owner !== request.owner ||
    job.lease.token !== request.token ||
    job.lease.until <= now
  )
    return { kind: "refused", reason: "fenced" };
  const saved = job.version === 3 ? { version: 3 as const, relevance: job.relevance } : { version: 2 as const };
  const exhausted = job.attempts >= SOURCE_JOB_MAX_ATTEMPTS;
  if (request.disposition === "hold" || exhausted) {
    const receipt: SourceJobReleaseReceipt = {
      ...request,
      attempts: job.attempts,
      at: now,
      state: "failed",
      nextAttemptAt: null,
    };
    return {
      kind: "changed",
      receipt,
      job: {
        ...saved,
        eventKey: job.eventKey,
        stage: "received",
        state: "failed",
        attempts: job.attempts,
        nextAttemptAt: null,
        releases: [...job.releases, receipt],
        failure: { reason: request.disposition === "hold" ? request.reason : "attempts-exhausted", at: now },
      },
    };
  }
  const nextAttemptAt = now + SOURCE_JOB_RETRY_MS[Math.min(job.attempts - 1, SOURCE_JOB_RETRY_MS.length - 1)]!;
  const receipt: SourceJobReleaseReceipt = {
    ...request,
    attempts: job.attempts,
    at: now,
    state: "ready",
    nextAttemptAt,
  };
  return {
    kind: "changed",
    receipt,
    job: {
      ...saved,
      eventKey: job.eventKey,
      stage: "received",
      state: "ready",
      attempts: job.attempts,
      nextAttemptAt,
      releases: [...job.releases, receipt],
    },
  };
}

export function planSourceRelevanceSave(
  job: SourceEventJob,
  request: SourceRelevanceRequest,
  now: number,
):
  | { kind: "changed"; job: ClaimedSourceEventJob; record: SourceRelevanceRecord }
  | { kind: "replayed"; record: SourceRelevanceRecord }
  | Extract<SourceRelevanceSaveResult, { kind: "refused" }> {
  if (job.version === 4) return { kind: "refused", reason: "fenced" };
  const relevance = job.version === 3 ? job.relevance : [];
  const prior = relevance.find((record) => JSON.stringify(record.context) === JSON.stringify(request.result.context));
  if (prior) {
    const { at: _at, ...result } = prior;
    return JSON.stringify(result) === JSON.stringify(request.result)
      ? { kind: "replayed", record: prior }
      : { kind: "refused", reason: "result-conflict" };
  }
  if (
    job.version === 1 ||
    job.state !== "leased" ||
    job.lease.owner !== request.owner ||
    job.lease.token !== request.token ||
    job.lease.until <= now
  )
    return { kind: "refused", reason: "fenced" };
  if (relevance.length >= SOURCE_RELEVANCE_MAX_CONTEXTS) return { kind: "refused", reason: "capacity" };
  const record: SourceRelevanceRecord = { ...request.result, at: now };
  return { kind: "changed", record, job: { ...job, version: 3, relevance: [...relevance, record] } };
}
