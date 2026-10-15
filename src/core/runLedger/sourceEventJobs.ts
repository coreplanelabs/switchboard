import { SOURCE_JOB_LEASE_MS, SOURCE_JOB_MAX_ATTEMPTS, SOURCE_JOB_RETRY_MS } from "../budgets.js";
import type {
  SourceEventJob,
  SourceEventJobV2,
  SourceJobLease,
  SourceJobReleaseReceipt,
  SourceJobReleaseRequest,
  SourceJobReleaseResult,
} from "./sourceEvents.js";

export type SourceJobClaimPlan =
  | { kind: "not-due" }
  | { kind: "claimed"; job: SourceEventJobV2; lease: SourceJobLease }
  | { kind: "failed"; job: SourceEventJobV2 };

/** Queue ownership is separate from a task's execution lease and permissions. */
export function planSourceJobClaim(job: SourceEventJob, owner: string, now: number): SourceJobClaimPlan {
  if (job.nextAttemptAt === null || job.nextAttemptAt > now) return { kind: "not-due" };
  const releases = job.version === 2 ? job.releases : [];
  if (job.attempts >= SOURCE_JOB_MAX_ATTEMPTS)
    return {
      kind: "failed",
      job: {
        version: 2,
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
      version: 2,
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
  | { kind: "changed"; job: SourceEventJobV2; receipt: SourceJobReleaseReceipt }
  | { kind: "replayed"; receipt: SourceJobReleaseReceipt }
  | Extract<SourceJobReleaseResult, { kind: "refused" }>;

export function planSourceJobRelease(
  job: SourceEventJob,
  request: SourceJobReleaseRequest,
  now: number,
): SourceJobReleasePlan {
  if (job.version !== 2) return { kind: "refused", reason: "fenced" };
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
        version: 2,
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
      version: 2,
      eventKey: job.eventKey,
      stage: "received",
      state: "ready",
      attempts: job.attempts,
      nextAttemptAt,
      releases: [...job.releases, receipt],
    },
  };
}
