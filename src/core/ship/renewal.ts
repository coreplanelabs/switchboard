// The renewal decision (decision 0046, Renewal: the grant decides, the lease
// continues). A lease is sized by the infrastructure; the problem is bounded by
// the grant. When a segment ends with its unit unfinished, the runner reads
// progress off the row — never off a model's word — and renews only when three
// things hold: the row shows progress, the grant has a renewal left and the
// spend is under its cap, and the pipeline's ask still passes the fit.
// Otherwise it stops and names the clause that failed; a person's reply spends
// a renewal by hand. Pure and node-free: the unit machine (a Worker) and the
// bot's routes compute the same decision from the same facts.

import { fit, type Grant, type Pipeline } from "../budgets.js";
import type { Handoff } from "./handoff.js";

/** A head the run pushed, as the record carries it (run-history item 2). */
export interface PushedHeadFact {
  ref: string;
  sha: string;
  at?: number;
}

export interface ProgressInput {
  /** The unit's branch: a push to any other ref is not the unit's progress. */
  branch: string;
  /** The heads the segment's coding run pushed (`RunRecord.pushed`). */
  pushed: readonly PushedHeadFact[];
  /** The head the segment started from — the previous segment's recorded sha.
   *  Absent on a fresh branch, where any push is progress. */
  startHead?: string;
  /** When the segment's lease began; a push stamped before it is not this segment's. */
  leaseStartedAt?: number;
  /** The previous segment's handoff and this one's, when both exist. */
  handoff?: { previous: Handoff; current: Handoff };
}

export type Progress =
  | { progressed: true; by: "push"; sha: string }
  | { progressed: true; by: "handoff" }
  | { progressed: false; why: string };

/** Two shas name one commit when the shorter is a prefix of the longer. */
const sameSha = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
};

/** Progress is a fact the row records after unit eight and the runner reads
 *  without a model: the last head pushed to the unit's branch that differs from
 *  the head the segment started at and is not older than the lease; failing
 *  that, a handoff whose follow-ups shrank or whose deviations grew. */
export function progressOf(input: ProgressInput): Progress {
  const last = [...input.pushed].reverse().find((h) => h.ref === input.branch);
  if (last !== undefined) {
    const newerThanLease =
      input.leaseStartedAt === undefined || last.at === undefined || last.at >= input.leaseStartedAt;
    const moved = input.startHead === undefined || !sameSha(last.sha, input.startHead);
    if (newerThanLease && moved) return { progressed: true, by: "push", sha: last.sha };
  }
  const pushWhy = `no head newer than the lease's start was pushed to \`${input.branch}\``;
  if (input.handoff === undefined) return { progressed: false, why: pushWhy };
  const { previous, current } = input.handoff;
  if (current.followUps.length < previous.followUps.length || current.deviations.length > previous.deviations.length)
    return { progressed: true, by: "handoff" };
  return { progressed: false, why: `${pushWhy} and the handoff is unchanged` };
}

export interface RenewalInput {
  grant: Grant;
  /** Renewals already spent under this request: the segments beyond the first. */
  renewalsSpent: number;
  /** Dollars spent under this request so far; null when a run's model had no
   *  price, since a total that left a model's tokens out would understate it. */
  spendUsd: number | null;
  progress: Progress;
  /** The pipeline the next segment would run: its fit is re-asserted before every segment. */
  pipeline: Pipeline;
}

export type RenewalWhy = "no_progress" | "grant_exhausted" | "cost_cap" | "unfit";

export type RenewalDecision =
  | { renew: true; segment: number; from?: string; renewalsLeft: number }
  | { renew: false; why: RenewalWhy; detail: string; renewalsLeft: number };

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The decision, in the order the record states the clauses: progress, the
 *  grant's count, the cap, the fit. `segment` is the one the renewal opens
 *  (the first segment is 1); `from` the sha it continues from when a push made
 *  the progress. */
export function renewalDecision(input: RenewalInput): RenewalDecision {
  const renewalsLeft = Math.max(0, input.grant.renewals - input.renewalsSpent);
  if (!input.progress.progressed) return { renew: false, why: "no_progress", detail: input.progress.why, renewalsLeft };
  if (renewalsLeft === 0) {
    const detail =
      input.grant.renewals === 0
        ? "the grant holds no renewals"
        : `the grant's ${input.grant.renewals} renewal${input.grant.renewals === 1 ? "" : "s"} are spent`;
    return { renew: false, why: "grant_exhausted", detail, renewalsLeft };
  }
  const cap = input.grant.costCapUsd;
  if (cap !== undefined) {
    if (input.spendUsd === null)
      return {
        renew: false,
        why: "cost_cap",
        detail: `spend is unknown (a model had no price) under the grant's cap of $${cap}`,
        renewalsLeft,
      };
    if (input.spendUsd >= cap)
      return {
        renew: false,
        why: "cost_cap",
        detail: `spend ${usd(input.spendUsd)} reached the grant's cap of $${cap}`,
        renewalsLeft,
      };
  }
  const held = fit(input.pipeline);
  if (!held.ok)
    return {
      renew: false,
      why: "unfit",
      detail: `a ${held.have}-minute segment cannot hold the ship loop (${input.pipeline.maxRounds} review rounds need ${held.need} min)`,
      renewalsLeft,
    };
  return {
    renew: true,
    segment: input.renewalsSpent + 2,
    ...(input.progress.by === "push" ? { from: input.progress.sha } : {}),
    renewalsLeft: renewalsLeft - 1,
  };
}

/** The card's words (the record's trace, steps 4 and 9): a renewal names its
 *  number of the grant's and the sha it continues from; a stop names the
 *  clause and, when renewals remain, the reply that spends one by hand. */
export function renderRenewal(decision: RenewalDecision, grant: Grant): string {
  if (decision.renew)
    return `renewal ${decision.segment - 1} of ${grant.renewals}, continues ${decision.from !== undefined ? decision.from.slice(0, 7) : "the branch's head"}`;
  const holds =
    decision.renewalsLeft > 0
      ? `grant holds ${decision.renewalsLeft} renewal${decision.renewalsLeft === 1 ? "" : "s"}`
      : "the grant holds no renewals";
  switch (decision.why) {
    case "no_progress":
      return decision.renewalsLeft > 0
        ? `no progress in the last lease; ${holds}; reply continue to spend one`
        : `no progress in the last lease; ${holds}`;
    case "cost_cap":
      return decision.renewalsLeft > 0 ? `${decision.detail}; ${holds} unspent` : decision.detail;
    case "grant_exhausted":
    case "unfit":
      return decision.detail;
  }
}
