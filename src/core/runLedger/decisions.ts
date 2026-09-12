// The ledger's decisions (docs/reference/specs/run-history.md items 28–31), pure. The
// Durable Object applies them inside one transaction; the in-memory ledger
// applies them in tests; both agree because this is the only copy.

import type { ClaimResult, FenceResult, LivePhase } from "./types.js";

/** One live run per thread. The existing row, if any, is what `live_runs` holds
 *  for the thread; the same run re-claimed by its owner is idempotent (a retry
 *  after a lost response), anything else is refused with what the steer
 *  message needs. */
export function decideClaim(
  existing: { runId: string; agent?: string; startedAt: number; ownerGen: string; idempotencyKey?: string } | undefined,
  req: { runId: string; gen: string },
): ClaimResult {
  if (!existing) return { ok: true };
  if (existing.runId === req.runId && existing.ownerGen === req.gen) return { ok: true };
  return {
    ok: false,
    reason: "thread-live",
    live: {
      runId: existing.runId,
      ...(existing.agent !== undefined ? { agent: existing.agent } : {}),
      startedAt: existing.startedAt,
      ...(existing.idempotencyKey !== undefined ? { idempotencyKey: existing.idempotencyKey } : {}),
    },
  };
}

/** What an accepted claim does to the thread's row (item 42). `insert`: no row.
 *  `promote`: the owner's claim WITH a prompt on its own `attaching` row — the
 *  prompt, tools, card and state land and the phase goes `live`, identity and
 *  start untouched. `refresh`: the owner re-reserves (a retry after a lost
 *  response) — the lease only. `keep`: any owner re-claim on a row past
 *  attaching — idempotent, nothing written (as it always was). Decided only
 *  after `decideClaim` accepted. */
export type ClaimWrite = "insert" | "promote" | "refresh" | "keep";
export function decideClaimWrite(
  existing: { runId: string; ownerGen: string; phase: LivePhase } | undefined,
  req: { runId: string; gen: string; phase?: "attaching" | "live" },
): ClaimWrite {
  if (!existing) return "insert";
  if (existing.phase !== "attaching") return "keep";
  return (req.phase ?? "live") === "attaching" ? "refresh" : "promote";
}

/** The phase a reclaimed row lands in: an `attaching` row stays so — the
 *  launcher restarts it from its request rather than resuming a transcript it
 *  does not have; every other row becomes `live` under the new owner. */
export function reclaimPhase(from: LivePhase): LivePhase {
  return from === "attaching" ? "attaching" : "live";
}

/** The fencing token: only the generation that holds the lease may write. */
export function checkFence(row: { ownerGen: string } | undefined, gen: string): FenceResult {
  if (!row) return { ok: false, reason: "unknown-run" };
  return row.ownerGen === gen ? { ok: true } : { ok: false, reason: "fenced" };
}

/** What a reclaiming generation takes over: every run whose lease has expired
 *  (a heartbeat lands strictly before `leaseUntil`, so equal is expired) and
 *  every run the previous generation handed off — **never a row it owns
 *  itself**. The reclaim runs on a sweep inside the live process too, and a
 *  lapsed lease on our own row means a heartbeat that could not land (a state
 *  Worker blip), not a dead owner: taking it would launch the run a second
 *  time in the same process, and the fence, which compares generations, would
 *  never stop the first. */
export function selectReclaim<T extends { leaseUntil: number; phase: LivePhase; ownerGen: string }>(
  rows: readonly T[],
  now: number,
  gen: string,
): T[] {
  return rows.filter((r) => r.ownerGen !== gen && (r.phase === "handoff" || r.leaseUntil <= now));
}

/** The compare-and-swap table for a run's phase. `attaching → live` (the
 *  prompt landed) or `→ finishing` (the dispatch failed before it — never
 *  handoff: an attaching run has nothing to resume from, so the drain waits
 *  for it and a dead owner's row is restarted instead), `live → handoff`
 *  (SIGTERM), `live → finishing` (before the reply), `handoff → finishing`
 *  (the owner finished inside its own handoff window, before any reclaim —
 *  the fence on the generation still keeps a reclaimed row from it), and back
 *  to `live` from `handoff` or `finishing` by a reclaim. Nothing else. */
export function phaseTransition(from: LivePhase, to: LivePhase): boolean {
  switch (from) {
    case "attaching":
      return to === "live" || to === "finishing";
    case "live":
      return to === "handoff" || to === "finishing";
    case "handoff":
      return to === "live" || to === "finishing";
    case "finishing":
      return to === "live";
    default:
      return false;
  }
}

export type Completeness = { kind: "resume" } | { kind: "run-step-fresh" } | { kind: "interrupted"; why: string };

/** What a resume does with the rows it finds. A step write lands the step's
 *  turns first (the previous results turn and this assistant turn: two turns),
 *  then the step record with `turnIndex` = the transcript's turn count. So:
 *  the count matches the last record → resume there; two more → the next
 *  step's turns landed but its record did not, nothing was dispatched, run
 *  that step's tools fresh; anything else is a partial write. With no record
 *  yet, the seed plays the role of the last record. */
export function transcriptCompleteness(input: {
  lastStep: { turnIndex: number } | null;
  seedTurns: number;
  transcriptTurns: number;
}): Completeness {
  const { lastStep, seedTurns, transcriptTurns } = input;
  if (transcriptTurns === 0) return { kind: "interrupted", why: "no transcript stored" };
  const base = lastStep ? lastStep.turnIndex : seedTurns;
  if (transcriptTurns === base) return { kind: "resume" };
  if (transcriptTurns === base + 2) return { kind: "run-step-fresh" };
  if (transcriptTurns < base) {
    return {
      kind: "interrupted",
      why: `transcript has ${transcriptTurns} turns but the last step recorded ${base}`,
    };
  }
  return {
    kind: "interrupted",
    why: `transcript has ${transcriptTurns} turns, one past the last step's ${base}: a partial step write`,
  };
}
