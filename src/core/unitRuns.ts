import { unitKeyOf, type CoordinatorInstance, type CoordinatorUnit } from "./coordinator/contract.js";
import type { RunView } from "./runsService.js";

// The unit is the reading unit (docs/reference/specs/agent-ship.md item 17;
// docs/decisions/0034-one-agent-per-unit-a-run-continues-a-transcript.md, "The
// unit is the reading unit"): a ship unit's story is the runs of its coding
// thread (and, on a row written before record 0055, its review thread), cut at the round boundaries the
// runner reported on the unit's row and laid out in time order. This module is
// the pure half — no store, no clock: given the row and the two threads'
// listings it says which run belongs to which round. `RunsService.listUnitRuns`
// reads the row and the threads and hands them here.

/** Which of a unit's two threads a run belongs to. */
export type UnitThread = "coding" | "review";

/** One run of a unit: the view every run page renders, plus the round the
 *  runner had entered when it started and the thread it ran in. */
export type UnitRun = RunView & { round: number; thread: UnitThread };

/** A unit row's readable facts — what a page states about the unit beside its
 *  runs, without the row's machine fields (its dependencies, its resume). One
 *  projection, so the unit page's header and the parent record's unit list
 *  agree on every word. */
export interface UnitFacts {
  /** `<instanceId>:<unit>` (`unitKeyOf`). */
  unit: string;
  instanceId: string;
  /** The unit's id as the plan spells it (`U16`), or `task` for a generated plan's one unit. */
  id: string;
  /** The plan's one-line title for the unit, when the plan gave one. */
  title?: string;
  branch: string;
  threads: { coding?: string; review?: string };
  /** Where each thread opens, when the channel has a permalink for it. */
  sourceUrls: { coding?: string; review?: string };
  pr?: { number: number; url: string };
  issue?: number;
  rounds: CoordinatorUnit["rounds"];
  ending?: CoordinatorUnit["ending"];
  startedAt?: number;
}

/** The instance a unit belongs to, as the unit page names it: the repository
 *  and the plan the pipeline runs, which attempt this is, and the run record
 *  the pipeline's story is written under (the parent record's page). Never
 *  the requester's ids — the runs carry those, under the predicate. */
export interface InstanceFacts {
  id: string;
  repo: string;
  base?: string;
  plan?: CoordinatorInstance["plan"];
  attempt?: number;
  label?: string;
  runId?: string;
  sourceUrl?: string;
  createdAt: number;
}

/** What `runs unit <key>` answers: the unit's facts, its instance's, and its
 *  runs in time order. */
export interface UnitRunsView extends UnitFacts {
  instance: InstanceFacts;
  runs: UnitRun[];
}

/** The row's readable facts (`UnitFacts`), each optional field present only when the row has it. */
export function unitFactsOf(unit: CoordinatorUnit): UnitFacts {
  return {
    unit: unitKeyOf(unit),
    instanceId: unit.instanceId,
    id: unit.unit,
    ...(unit.title !== undefined ? { title: unit.title } : {}),
    branch: unit.branch,
    threads: {
      ...(unit.threadKey !== undefined ? { coding: unit.threadKey } : {}),
      ...(unit.reviewThread !== undefined ? { review: unit.reviewThread.threadKey } : {}),
    },
    sourceUrls: {
      ...(unit.sourceUrl !== undefined ? { coding: unit.sourceUrl } : {}),
      ...(unit.reviewThread?.sourceUrl !== undefined ? { review: unit.reviewThread.sourceUrl } : {}),
    },
    ...(unit.pr !== undefined ? { pr: unit.pr } : {}),
    ...(unit.issue !== undefined ? { issue: unit.issue } : {}),
    rounds: unit.rounds,
    ...(unit.ending !== undefined ? { ending: unit.ending } : {}),
    ...(unit.startedAt !== undefined ? { startedAt: unit.startedAt } : {}),
  };
}

/** The instance's readable facts (`InstanceFacts`). */
export function instanceFactsOf(instance: CoordinatorInstance): InstanceFacts {
  return {
    id: instance.id,
    repo: instance.repo,
    ...(instance.base !== undefined ? { base: instance.base } : {}),
    ...(instance.plan !== undefined ? { plan: instance.plan } : {}),
    ...(instance.attempt !== undefined ? { attempt: instance.attempt } : {}),
    ...(instance.label !== undefined ? { label: instance.label } : {}),
    ...(instance.runId !== undefined ? { runId: instance.runId } : {}),
    ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
    createdAt: instance.createdAt,
  };
}

/** Where each round of one thread begins: the earliest entry the row records
 *  for every round index the agent ran, in time order. The runner reports a
 *  round's `started` before it spawns the round's child, so a run that started
 *  at or after a boundary is that round's — but the earliest entry, not the
 *  `started` outcome, marks the round, so a row missing that one note still
 *  cuts where the round began. */
export function roundBoundaries(
  rounds: CoordinatorUnit["rounds"],
  agent: UnitThread,
): Array<{ index: number; at: number }> {
  const first = new Map<number, number>();
  for (const r of rounds) {
    if (r.agent !== agent) continue;
    const at = first.get(r.index);
    if (at === undefined || r.at < at) first.set(r.index, r.at);
  }
  return [...first.entries()].map(([index, at]) => ({ index, at })).sort((a, b) => a.at - b.at || a.index - b.index);
}

/** The round a run of `thread` belongs to: the last boundary at or before its
 *  start. Undefined when it started before the thread's first round — a task's
 *  thread is the requesting thread, whose earlier runs are not the unit's. */
function roundOf(boundaries: ReadonlyArray<{ index: number; at: number }>, run: RunView): number | undefined {
  let round: number | undefined;
  for (const b of boundaries) {
    if (b.at > run.startedAt) break;
    round = b.index;
  }
  return round;
}

/** The pipeline's own record is written in a task's requesting thread when the
 *  instance ends — the pipeline, never one of its rounds. */
const isPipelineRecord = (run: RunView): boolean => run.agent === "ship";

const THREAD_ORDER: Readonly<Record<UnitThread, number>> = { coding: 0, review: 1 };

/** A unit's runs in time order — coding 0, review 1, coding 1, review 2 … as
 *  they started — each with its round and thread. A unit has one thread
 *  (record 0055): its runs are cut by agent, the review agent's at the review
 *  rounds and the rest at the coding rounds; a row a bot wrote before that
 *  names a review thread, whose runs are the review's. A thread the row does
 *  not name contributes nothing whatever it is handed; a run that started
 *  before the thread's first round, and the pipeline's own record, are left out. */
export function unitRunsOf(unit: CoordinatorUnit, threads: { coding: RunView[]; review: RunView[] }): UnitRun[] {
  const out: UnitRun[] = [];
  const cut = (thread: UnitThread, runs: RunView[]): void => {
    const boundaries = roundBoundaries(unit.rounds, thread);
    for (const run of runs) {
      if (isPipelineRecord(run)) continue;
      const round = roundOf(boundaries, run);
      if (round !== undefined) out.push({ ...run, round, thread });
    }
  };
  if (unit.threadKey !== undefined) {
    if (unit.reviewThread !== undefined) {
      cut("coding", threads.coding);
      cut("review", threads.review);
    } else {
      cut(
        "coding",
        threads.coding.filter((r) => r.agent !== "review"),
      );
      cut(
        "review",
        threads.coding.filter((r) => r.agent === "review"),
      );
    }
  }
  return out.sort(
    (a, b) =>
      a.startedAt - b.startedAt ||
      THREAD_ORDER[a.thread] - THREAD_ORDER[b.thread] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
