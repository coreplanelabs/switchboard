/** The read-then-act plan for each engine step the resident Worker runs
 *  (docs/reference/specs/resident-repos.md item 22), kept pure and
 *  dependency-free so it is unit-testable from src/ and imported by the
 *  resident Worker like residentRefresh — the tested code IS the shipped code.
 *
 *  Every step method on the resident (`fetchMirror`, `installDeps`, `runBuild`,
 *  `snapshot`, `restoreCheckout`, and the wake path's dependency view) begins
 *  by reading the facts it is about to change — a stored record, the disk
 *  markers, the store — and asks one of these functions whether the work is
 *  already done. A step that is done issues no command, so a second call with
 *  the same inputs has no effect; that is what lets a caller retry a step it
 *  cannot tell apart from one that was killed mid-way. The snapshot step adds
 *  the compare-and-swap rule: its record is committed only over the record it
 *  read at the start, and a stamp that moved meanwhile makes the step
 *  `superseded`, never a throw. */

import { planRefresh, type CleanScope, type RefreshDisk } from "./residentRefresh.js";

/** Where `fetchMirror` records the fetch a cycle made. */
export const LAST_FETCH_KEY = "resident:lastFetch";

export interface FetchRecord {
  /** The cycle that fetched: the refresh instance driving it. */
  cycle: string;
  ref: string;
  /** The ref's tip in the mirror after that fetch. */
  sha: string;
  at: number;
}

export type FetchPlan = { action: "done"; why: string; sha: string } | { action: "run"; why: string };

export function planFetchMirror(input: { ref: string; cycle: string; last: FetchRecord | undefined }): FetchPlan {
  const { last } = input;
  if (last && last.cycle === input.cycle && last.ref === input.ref) {
    return { action: "done", why: `cycle ${input.cycle} already fetched ${input.ref}`, sha: last.sha };
  }
  return { action: "run", why: "no fetch recorded for this cycle" };
}

export type StepPlan = { action: "done"; why: string } | { action: "run"; why: string };

export function planInstallDeps(input: { key: string; entryComplete: boolean }): StepPlan {
  const short = input.key.slice(0, 8);
  return input.entryComplete
    ? { action: "done", why: `store entry ${short} is complete` }
    : { action: "run", why: `no complete store entry for ${short}` };
}

export type BuildDisk = RefreshDisk;

export type BuildPlan =
  { action: "done"; why: string } | { action: "run"; why: string; install: boolean; clean: CleanScope };

/** The build step over the refresh planner: the recorded facts already at the
 *  target, or a checkout whose HEAD, deps and build markers all name it, is
 *  done; anything else is the planner's rebuild, with its install gate and
 *  clean scope. */
export function planBuild(input: { sha: string; factsSha: string; lockfileKey: string; disk: BuildDisk }): BuildPlan {
  const plan = planRefresh(input);
  if (plan.action === "unchanged") return { action: "done", why: `facts already at ${input.sha.slice(0, 8)}` };
  if (plan.action === "reuse") return { action: "done", why: plan.why };
  return { action: "run", why: plan.why, install: plan.install, clean: plan.clean };
}

export interface SnapshotStamp {
  ref: string;
  sha: string;
  lockfileHash: string;
}

/** What the stored snapshot record shows of itself: its stamp and when it was
 *  written. Two records with equal fields are the same record. */
export type StampedRecord = SnapshotStamp & { createdAt: string };

const stampText = (s: SnapshotStamp) => `{${s.ref}, ${s.sha.slice(0, 8)}, ${s.lockfileHash.slice(0, 8)}}`;

const sameStamp = (a: SnapshotStamp, b: SnapshotStamp) =>
  a.ref === b.ref && a.sha === b.sha && a.lockfileHash === b.lockfileHash;

export function planSnapshot(input: { stamp: SnapshotStamp; current: StampedRecord | undefined }): StepPlan {
  if (!input.current) return { action: "run", why: "no snapshot recorded" };
  return sameStamp(input.current, input.stamp)
    ? { action: "done", why: `snapshot already at ${stampText(input.stamp)}` }
    : { action: "run", why: `snapshot at ${stampText(input.current)}, the target is ${stampText(input.stamp)}` };
}

export type SnapshotCommit = { action: "commit" } | { action: "superseded"; by: StampedRecord | undefined };

/** Commit only over the record read at the start; a record that appeared,
 *  vanished or changed meanwhile was written by someone else and wins. */
export function snapshotCommitDecision(input: {
  readAtStart: StampedRecord | undefined;
  current: StampedRecord | undefined;
}): SnapshotCommit {
  const { readAtStart, current } = input;
  if (!readAtStart && !current) return { action: "commit" };
  if (readAtStart && current && sameStamp(readAtStart, current) && readAtStart.createdAt === current.createdAt) {
    return { action: "commit" };
  }
  return { action: "superseded", by: current };
}

/** The restore step: the ready marker (the sha the last materialized disk
 *  was left at, present only when both trees exist) proves the disk. */
export function planRestore(input: { sha: string; readyStamp: string | null }): StepPlan {
  const target = input.sha.slice(0, 8);
  if (input.readyStamp === input.sha) return { action: "done", why: `disk already holds ${target}` };
  const holds = input.readyStamp === null ? "nothing" : input.readyStamp.slice(0, 8);
  return { action: "run", why: `disk holds ${holds}, the stamp says ${target}` };
}

export type MaterializeDepsPlan = { action: "done"; why: string } | { action: "run"; why: string; needsEntry: boolean };

/** The wake path's dependency view: the checkout holding its `node_modules`
 *  is done; otherwise link the key's entry, producing it first when the store
 *  has none. */
export function planMaterializeDeps(input: {
  key: string;
  viewPresent: boolean;
  entryComplete: boolean;
}): MaterializeDepsPlan {
  if (input.viewPresent) return { action: "done", why: "the checkout holds its dependency view" };
  const short = input.key.slice(0, 8);
  return input.entryComplete
    ? { action: "run", why: `link the complete entry ${short}`, needsEntry: false }
    : { action: "run", why: `materialize ${short} into the store, then link it`, needsEntry: true };
}
