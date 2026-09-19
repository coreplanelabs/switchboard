import type { RunEvent, ShipRoundOutcome } from "./runEvents.js";
import type { UnitEnding } from "./ship/coordinator.js";

// The standing fold (record 0065): one pure, node-free reader of a hosted ship
// parent's `ship_round` and `ship_unit` events, yielding the pipeline's
// standing — per unit a stage from a closed vocabulary, its latest round, its
// pull request and the stamp that set the stage. The registry
// (`appendToBacklog`), the ledger view (`runsService.ts`) and the record
// assembly (`dispatch/record.ts`) all call it, so the three row sources can
// never disagree. Total over any event list; it never throws.

/** The stage vocabulary (record 0065): what every surface says a unit is in. */
export type Stage = "coding" | "review" | "fix" | "approved" | "merge-ready" | "merged" | "idle" | "ended";

export const STAGES = [
  "coding",
  "review",
  "fix",
  "approved",
  "merge-ready",
  "merged",
  "idle",
  "ended",
] as const satisfies readonly Stage[];

/** The stages a unit is still open in: what `PipelineSummary.current` lists. */
const OPEN_STAGES: ReadonlySet<Stage> = new Set(["coding", "review", "fix", "approved", "idle"]);

/** One unit's standing: the stage, the latest round index bound to it, the
 *  segment count (raised by a `continued` round and by a reopen from idle),
 *  when the stage was set, and the latest pull request and thread seen. A
 *  closed unit's `detail` names the ending kind the vocabulary folds to
 *  `ended`. */
export interface PipelineUnit {
  unit: string;
  stage: Stage;
  round: number;
  segment: number;
  since: number;
  pr?: number;
  threadKey?: string;
  detail?: string;
}

/** A round of an unnamed unit: a `ship_round` with no companion `ship_unit`
 *  at its stamp — the shape of records written before `ship_unit` existed. */
export interface RoundRow {
  index: number;
  agent: string;
  outcome: string;
  at: number;
}

/** One stage change the fold made — the pipeline page's log row. */
export interface StandingChange {
  at: number;
  unit: string;
  stage: Stage;
  round?: number;
  detail?: string;
}

/** What `pipelineStandingOf` returns: the units in order of first appearance,
 *  the rounds no unit names, and the changes in event order. The plan's unit
 *  total is not on the parent's stream and is not returned. */
export interface PipelineStanding {
  units: PipelineUnit[];
  unnamedRounds: RoundRow[];
  changes: StandingChange[];
}

/** The standing as the row sources carry it (`RunSummary.pipeline`,
 *  `RunView.pipeline`, `RunRecord.pipeline`): the open units whole, a count
 *  per stage, the units seen — and, for an older record whose rounds name no
 *  unit, the newest unnamed round, so its row can still say
 *  `round 2 · review` (record 0065, the pipeline row). */
export interface PipelineSummary {
  current: PipelineUnit[];
  counts: Record<Stage, number>;
  total: number;
  lastRound?: RoundRow;
}

/** What a bound round does to its unit's stage, by outcome (record 0065's
 *  mapping). `start` reads the agent and the index (`coding` at round 0, `fix`
 *  at any higher index, `review` for the review agent); `continue` is `coding`
 *  with the segment count raised; `hold` leaves the stage alone — the ending
 *  will say. Pinned to the union: a new outcome fails the build here. */
export const ROUND_STAGE = {
  started: "start",
  pr_opened: "review",
  completed: "merged",
  approve: "approved",
  request_changes: "fix",
  no_verdict: "hold",
  checks_failed: "fix",
  aborted: "hold",
  stopped: "hold",
  continued: "continue",
  idle: "idle",
} as const satisfies Record<ShipRoundOutcome, Stage | "start" | "continue" | "hold">;

/** What an unbound `ship_unit` ending word does to its unit (record 0065):
 *  `merged` and `already_landed` fold to `merged`, `merge_ready` to
 *  `merge-ready`, `idle` stays open as `idle`, `continued` is not an ending
 *  and holds the stage, and every other kind closes the unit as `ended` with
 *  the kind as detail. `blocked` — a unit status the driver posts to
 *  `unit-end` for a unit that never started — ends the same way. Pinned to
 *  the union: a new ending kind fails the build here. */
export const ENDING_STAGE = {
  merged: "merged",
  already_landed: "merged",
  merge_ready: "merge-ready",
  merge_refused: "ended",
  round_cap: "ended",
  wall_clock_cap: "ended",
  review_pending: "ended",
  stopped: "ended",
  aborted: "ended",
  continued: "hold",
  no_verdict: "ended",
  interrupted: "ended",
  refused: "ended",
  idle: "idle",
  blocked: "ended",
} as const satisfies Record<UnitEnding["kind"] | "blocked", Stage | "hold">;

type ShipEvent = Extract<RunEvent, { type: "ship_round" } | { type: "ship_unit" }>;

function isShipEvent(e: RunEvent): e is ShipEvent {
  return e.type === "ship_round" || e.type === "ship_unit";
}

/** Fold a run's events into the pipeline's standing. One pass, `seq` order
 *  assumed (every carrier's events are). A `ship_round` binds to the
 *  `ship_unit` published next at the same stamp — the round route's own batch
 *  contract — and that companion contributes only its pull request and thread
 *  key, never a stage; a round with no companion is a round of an unnamed
 *  unit. Total: an unknown word holds the stage, and the fold never throws. */
export function pipelineStandingOf(events: readonly RunEvent[]): PipelineStanding {
  const ship = events.filter(isShipEvent);
  const units = new Map<string, PipelineUnit>();
  const unnamedRounds: RoundRow[] = [];
  const changes: StandingChange[] = [];

  const setStage = (u: PipelineUnit, stage: Stage, at: number, detail?: string): void => {
    if (u.stage === stage && u.detail === detail) return;
    u.stage = stage;
    u.since = at;
    if (detail !== undefined) u.detail = detail;
    else delete u.detail;
    changes.push({ at, unit: u.unit, stage, round: u.round, ...(detail !== undefined ? { detail } : {}) });
  };

  /** The unit's row, created at first sight: at `coding` for a plain entry, or
   *  already at a bound round's stage for a unit adopted mid-pipeline (a
   *  resume at review skips round 0 — its first bound round says so). */
  const enter = (name: string, at: number, stage: Stage, round: number, detail?: string): PipelineUnit => {
    const existing = units.get(name);
    if (existing) return existing;
    const u: PipelineUnit = { unit: name, stage, round, segment: 1, since: at };
    if (detail !== undefined) u.detail = detail;
    units.set(name, u);
    changes.push({ at, unit: name, stage, round, ...(detail !== undefined ? { detail } : {}) });
    return u;
  };

  const takeFacts = (u: PipelineUnit, e: Extract<ShipEvent, { type: "ship_unit" }>): void => {
    if (e.pr !== undefined) u.pr = e.pr;
    if (e.threadKey !== undefined) u.threadKey = e.threadKey;
  };

  const consumed = new Set<number>();
  for (let i = 0; i < ship.length; i++) {
    if (consumed.has(i)) continue;
    const e = ship[i]!;
    const at = e.at ?? 0;
    if (e.type === "ship_round") {
      const next = ship[i + 1];
      const companion = next !== undefined && next.type === "ship_unit" && (next.at ?? 0) === at ? next : undefined;
      if (companion === undefined) {
        unnamedRounds.push({ index: e.index, agent: e.agent, outcome: e.outcome, at });
        continue;
      }
      consumed.add(i + 1);
      const mapped = (ROUND_STAGE as Record<string, Stage | "start" | "continue" | "hold">)[e.outcome] ?? "hold";
      const stage: Stage =
        mapped === "start"
          ? e.agent === "review"
            ? "review"
            : e.index >= 1
              ? "fix"
              : "coding"
          : mapped === "continue"
            ? "coding"
            : mapped === "hold"
              ? "coding" // a new unit's first word the mapping holds on: it is in play, and coding is the entry stage
              : mapped;
      const known = units.has(companion.unit);
      const u = enter(companion.unit, at, stage, e.index);
      takeFacts(u, companion); // the companion's pull request and thread only — never its state (record 0065)
      u.round = e.index;
      if (mapped === "continue" && known) u.segment += 1;
      if (mapped !== "hold") setStage(u, stage, at);
    } else {
      const state = e.state;
      if (state === "started") {
        const existing = units.get(e.unit);
        if (existing === undefined) {
          const u = enter(e.unit, at, "coding", 0);
          takeFacts(u, e);
        } else {
          // An idle or closed unit reopens at its next `started` — the next
          // segment; a started while the unit is open holds where it stands.
          if (existing.stage === "idle" || existing.stage === "ended") {
            existing.segment += 1;
            setStage(existing, "coding", at);
          }
          takeFacts(existing, e);
        }
        continue;
      }
      const mapped = (ENDING_STAGE as Record<string, Stage | "hold">)[state];
      const u =
        units.get(e.unit) ??
        // An ending for a unit that never started (`blocked` with no prior,
        // or a route that skipped `unit-start`): the row still enters.
        enter(e.unit, at, mapped !== undefined && mapped !== "hold" ? mapped : "coding", 0, endedDetail(state, mapped));
      takeFacts(u, e);
      // A round-outcome word on an unbound `ship_unit` (a route that skipped
      // its round) and any word the fold does not know hold the stage.
      if (mapped !== undefined && mapped !== "hold") setStage(u, mapped, at, endedDetail(state, mapped));
    }
  }
  return { units: [...units.values()], unnamedRounds, changes };
}

function endedDetail(state: string, mapped: Stage | "hold" | undefined): string | undefined {
  return mapped === "ended" ? state : undefined;
}

/** The standing as the three row sources carry it: the open units whole, the
 *  counts per stage (zero-filled — the shape is stable), the units seen, and
 *  an older record's newest unnamed round. */
export function summaryOfStanding(standing: PipelineStanding): PipelineSummary {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const u of standing.units) counts[u.stage]++;
  const lastRound = standing.unnamedRounds.at(-1);
  return {
    current: standing.units.filter((u) => OPEN_STAGES.has(u.stage)),
    counts,
    total: standing.units.length,
    ...(lastRound !== undefined ? { lastRound } : {}),
  };
}

/** The one carrier helper: the fold's summary for a run's events, or nothing
 *  for a run with no ship facts — so a model run's row never grows the field. */
export function pipelineOfEvents(events: readonly RunEvent[]): PipelineSummary | undefined {
  const standing = pipelineStandingOf(events);
  if (standing.units.length === 0 && standing.unnamedRounds.length === 0) return undefined;
  return summaryOfStanding(standing);
}

const isFinite_ = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isPipelineUnitShape(v: unknown): v is PipelineUnit {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  if (typeof u.unit !== "string" || !STAGES.includes(u.stage as Stage)) return false;
  if (!isFinite_(u.round) || !isFinite_(u.segment) || !isFinite_(u.since)) return false;
  if (u.pr !== undefined && !isFinite_(u.pr)) return false;
  if (u.threadKey !== undefined && typeof u.threadKey !== "string") return false;
  if (u.detail !== undefined && typeof u.detail !== "string") return false;
  return true;
}

/** Structural check on a stored summary (`RunRecord.pipeline`): the shape
 *  above, nothing else — an older reader accepts a newer record's field. */
export function isPipelineSummaryShape(v: unknown): v is PipelineSummary {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.current) || !s.current.every(isPipelineUnitShape)) return false;
  if (typeof s.counts !== "object" || s.counts === null) return false;
  if (!Object.values(s.counts).every(isFinite_)) return false;
  if (!isFinite_(s.total)) return false;
  if (s.lastRound !== undefined) {
    if (typeof s.lastRound !== "object" || s.lastRound === null) return false;
    const r = s.lastRound as Record<string, unknown>;
    if (!isFinite_(r.index) || typeof r.agent !== "string" || typeof r.outcome !== "string" || !isFinite_(r.at))
      return false;
  }
  return true;
}
