import { boundText, stalledFor } from "../runPace.js";
import type { RunView } from "../runsService.js";
import type { InstanceFacts, UnitFacts } from "../unitRuns.js";

// The plane's table (docs/reference/specs/orchestration-plane.md items 1-3;
// docs/decisions/0064): every live and recently ended run, every tracked pull
// request and every unit, each with an owner and its health flags, derived from
// facts the stores already hold — the ledger's live rows, the run records, the
// coordinator's unit rows and the merge door's pull request reads. This module
// is the pure half: the service reads, and this module says what the rows mean,
// so `plane show`, the page and the tests agree on every word. Node-free by
// design: the web bundle compiles it too.

/** What the merge door reads about a pull request, reduced to the facts the table judges. */
export interface PlanePullRequestFacts {
  repo: string;
  number: number;
  url?: string;
  title?: string;
  state?: "open" | "closed";
  headSha?: string;
  /** GitHub's `mergeable_state`: `clean`, `dirty` (a conflict with the base), `unknown`. */
  mergeableState?: string;
  mergedAt?: string;
  checks?: { total: number; pending: string[]; failed: string[] };
  /** An approving review whose commit is the head. */
  approvedAtHead?: boolean;
  /** Whether the title passes the repository's title rule; absent when unread. */
  titleOk?: boolean;
  /** GitHub could not be read: every other fact is stale or absent. */
  unknown?: true;
}

/** A run's flags. `bound-exceeded` outranks `stalled`; `no-signal` is a row
 *  live under another generation, which carries no pace fact (live-view item
 *  32) and is never read as stalled. */
export type RunHealth = "stalled" | "bound-exceeded" | "no-signal" | "provisional" | "interrupted" | "failed";

/** A pull request's flags, in the merge door's order (agent-ship item 9): a
 *  conflict is read before the checks; `approved` names an approval at the head. */
export type PrHealth = "approved" | "dirty" | "red" | "pending" | "mistitled" | "merged" | "closed" | "unknown";

/** A unit's flags: `live` while a run of it is live; `waiting` with no ending
 *  and no run; `idle` for an ending record 0051 idles on; `owner-gap` for a
 *  merge-ready unit whose pull request is still open, the gap record 0064 names. */
export type UnitHealth = "live" | "waiting" | "idle" | "merged" | "merge-ready" | "ended" | "owner-gap";

/** The ending kinds a unit idles on instead of ending (record 0051). */
export const IDLING_ENDINGS: ReadonlySet<string> = new Set([
  "aborted",
  "wall_clock_cap",
  "review_pending",
  "round_cap",
  "merge_refused",
  "no_verdict",
  "interrupted",
  "stopped",
]);

export interface PlaneRunRow {
  run: RunView;
  /** The unit the run belongs to, when it is a coordinator child of a known instance. */
  unit?: { key: string; id: string; title?: string };
  /** Who owns the run: the requester (with a name when the adapter resolved one),
   *  or the generation driving it when it is live under another container. */
  owner: { id?: string; name?: string; generation?: string };
  health: RunHealth[];
}

export interface PlaneUnitRow {
  unit: UnitFacts;
  instance: InstanceFacts;
  health: UnitHealth[];
}

export interface PlanePullRequestRow {
  pr: PlanePullRequestFacts;
  /** The unit whose row names the pull request, else the run that opened it, else a person's. */
  owner: { unitKey?: string; runId?: string; person?: true };
  health: PrHealth[];
}

/** The table: what `plane show` answers and the `/plane` panel paints. Windows
 *  and findings are empty until the plane decides them (record 0064's later
 *  units); the shape is here so the panel and the command never change. */
export interface PlaneTable {
  at: number;
  runs: PlaneRunRow[];
  units: PlaneUnitRow[];
  pullRequests: PlanePullRequestRow[];
  windows: never[];
  findings: never[];
}

export interface PlaneTableInput {
  now: number;
  runs: RunView[];
  instances: Array<{ instance: InstanceFacts; units: UnitFacts[] }>;
  pullRequests: PlanePullRequestFacts[];
}

/** A run's flags from the facts its view carries. */
export function runHealthOf(run: RunView, now: number): RunHealth[] {
  const flags: RunHealth[] = [];
  if (run.finished) {
    if (run.provisional) flags.push("provisional");
    else if (run.status === "interrupted") flags.push("interrupted");
    else if (run.status === "failed") flags.push("failed");
    return flags;
  }
  if (run.inFlight && boundText(run.inFlight, now) !== undefined) flags.push("bound-exceeded");
  if (stalledFor(run, now) !== undefined) flags.push("stalled");
  if (run.eventsLast5m === undefined && run.ownerGen !== undefined) flags.push("no-signal");
  return flags;
}

/** A pull request's flags in the merge door's order. */
export function prHealthOf(pr: PlanePullRequestFacts): PrHealth[] {
  if (pr.unknown) return ["unknown"];
  if (pr.state === "closed") return [pr.mergedAt !== undefined ? "merged" : "closed"];
  const flags: PrHealth[] = [];
  if (pr.approvedAtHead) flags.push("approved");
  if (pr.mergeableState === "dirty") flags.push("dirty");
  if (pr.checks && pr.checks.failed.length > 0) flags.push("red");
  else if (pr.checks && pr.checks.pending.length > 0) flags.push("pending");
  if (pr.titleOk === false) flags.push("mistitled");
  return flags;
}

/** A unit's flags from its ending and whether a run of it is live. */
export function unitHealthOf(unit: UnitFacts, facts: { live: boolean; prOpen?: boolean }): UnitHealth[] {
  const kind = unit.ending?.kind;
  if (kind === undefined) return [facts.live ? "live" : "waiting"];
  if (IDLING_ENDINGS.has(kind)) return ["idle"];
  if (kind === "merged") return ["merged"];
  if (kind === "merge_ready") return facts.prOpen ? ["merge-ready", "owner-gap"] : ["merge-ready"];
  return ["ended"];
}

/** Which unit a coordinator child belongs to: the spawn's idempotency key names
 *  it (`<instance>:<unit>/<round>/<lane>`); a run without one is the unit whose
 *  thread it runs in. Undefined for a run of no known unit. */
export function unitIdOfRun(run: RunView, units: readonly UnitFacts[]): string | undefined {
  if (run.parentInstanceId !== undefined && run.idempotencyKey !== undefined) {
    const prefix = `${run.parentInstanceId}:`;
    if (run.idempotencyKey.startsWith(prefix)) {
      const id = run.idempotencyKey.slice(prefix.length).split("/")[0];
      if (id !== "" && units.some((u) => u.id === id)) return id;
    }
  }
  if (run.threadKey !== undefined) {
    const byThread = units.find((u) => u.threads.coding === run.threadKey || u.threads.review === run.threadKey);
    if (byThread) return byThread.id;
  }
  return undefined;
}

const HEALTH_RANK: Record<RunHealth, number> = {
  "bound-exceeded": 0,
  stalled: 0,
  "no-signal": 1,
  provisional: 1,
  interrupted: 1,
  failed: 1,
};

function runRank(row: PlaneRunRow): number {
  if (row.run.finished) return 3;
  if (row.health.some((h) => HEALTH_RANK[h] === 0)) return 0;
  if (row.health.length === 0) return 1;
  return 2;
}

function ownerOf(run: RunView): PlaneRunRow["owner"] {
  if (run.ownerGen !== undefined && run.userId === undefined) return { generation: run.ownerGen };
  return {
    ...(run.userId !== undefined ? { id: run.userId } : {}),
    ...(run.userName !== undefined ? { name: run.userName } : {}),
    ...(run.ownerGen !== undefined ? { generation: run.ownerGen } : {}),
  };
}

const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

/** The table from the facts the service read: runs live first (stalled ahead of
 *  healthy, then rows with a flag), then recently ended, each newest first
 *  within its band; units in their instances' order; pull requests in the
 *  order given, owned by their unit, else their opener, else a person. */
export function buildPlaneTable(input: PlaneTableInput): PlaneTable {
  const unitsByInstance = new Map(input.instances.map((i) => [i.instance.id, i]));
  const liveUnits = new Set<string>();
  const runs: PlaneRunRow[] = input.runs.map((run) => {
    const row: PlaneRunRow = { run, owner: ownerOf(run), health: runHealthOf(run, input.now) };
    const instance = run.parentInstanceId !== undefined ? unitsByInstance.get(run.parentInstanceId) : undefined;
    if (instance) {
      const id = unitIdOfRun(run, instance.units);
      const unit = id !== undefined ? instance.units.find((u) => u.id === id) : undefined;
      if (unit) {
        row.unit = { key: unit.unit, id: unit.id, ...(unit.title !== undefined ? { title: unit.title } : {}) };
        if (!run.finished) liveUnits.add(unit.unit);
      }
    }
    return row;
  });
  runs.sort((a, b) => runRank(a) - runRank(b) || b.run.startedAt - a.run.startedAt);

  const prByKey = new Map(input.pullRequests.map((pr) => [prKey(pr), pr]));
  const prOwner = new Map<string, PlanePullRequestRow["owner"]>();
  const units: PlaneUnitRow[] = [];
  for (const { instance, units: rows } of input.instances) {
    for (const unit of rows) {
      const key = unit.pr ? prKey({ repo: instance.repo, number: unit.pr.number }) : undefined;
      if (key !== undefined && !prOwner.has(key)) prOwner.set(key, { unitKey: unit.unit });
      const pr = key !== undefined ? prByKey.get(key) : undefined;
      // A pull request the plane could not read, past the read cap or unread on GitHub, leans open: the unit ended
      // merge-ready with it open at the runner's last look, and an owner gap hidden by a read failure is the worse error.
      const prOpen =
        pr && !pr.unknown ? pr.state === "open" : unit.pr !== undefined && unit.ending?.kind === "merge_ready";
      units.push({ unit, instance, health: unitHealthOf(unit, { live: liveUnits.has(unit.unit), prOpen }) });
    }
  }
  for (const run of input.runs) {
    if (run.pr && run.repo !== undefined) {
      const key = prKey({ repo: run.repo, number: run.pr.number });
      if (!prOwner.has(key)) prOwner.set(key, { runId: run.id });
    }
  }
  const pullRequests: PlanePullRequestRow[] = input.pullRequests.map((pr) => ({
    pr,
    owner: prOwner.get(prKey(pr)) ?? { person: true },
    health: prHealthOf(pr),
  }));
  return { at: input.now, runs, units, pullRequests, windows: [], findings: [] };
}
