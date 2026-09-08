// The boot sequence's ledger step (features/run-history.md item 36): before
// the Slack socket opens, this generation takes over every run the previous
// one left on the ledger — an expired lease (the owner died), a handoff (the
// owner drained), or a `finishing` row (the owner replied and died before
// `finish`) — and closes each with a proper record, so no run ever ends as a
// card spinning forever with a tombstone for a record. Resuming a run's model
// loop from its transcript is the next step of the plan; until then every
// reclaimed run that had not replied closes `interrupted`, and the verdict
// the transcript-completeness rule WOULD have given is logged so the receipt
// can count how often a resume would have been possible.
//
// Ordering: awaited by `src/index.ts` before `app.start()` (D7). The catch-up's
// orphan sweep then finds the closed runs' cards unowned and closes them as
// interrupted; the rows another generation still holds a current lease on are
// handed back so the sweep leaves THEIR cards alone (`liveElsewhere`).

import type { RunStatus } from "./runRecord.js";
import { RouteMissingError } from "./runStoreWorker.js";
import type { RunLedger } from "./runLedger/ledger.js";
import { transcriptCompleteness } from "./runLedger/decisions.js";
import { LEASE_MS, type CardHandle, type LivePhase } from "./runLedger/types.js";
import { reclaimedRunRecord } from "./dispatcher.js";

export interface ReclaimedClosure {
  runId: string;
  threadKey: string;
  status: RunStatus;
  /** The phase the row was in when taken. */
  from: LivePhase;
  /** One line: why this status — the completeness verdict, or "replied". */
  why: string;
  card: CardHandle | null;
  events: number;
  /** The run's agent, for the closed card's title. */
  agent?: string;
}

export interface LiveElsewhere {
  runId: string;
  ownerGen: string;
  card: CardHandle | null;
}

export interface ReclaimOutcome {
  closed: ReclaimedClosure[];
  /** Runs another generation still holds a current lease on (a rollout
   *  overlap): their cards must not be swept as orphans. */
  liveElsewhere: LiveElsewhere[];
  /** Runs the reclaim could not close (a failed read or finish); their rows
   *  stay ours with a lease, so the next boot takes them again. */
  failed: { runId: string; error: string }[];
}

export interface ReclaimAtBootOptions {
  ledger: RunLedger;
  gen: string;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

const TERMINAL: ReadonlySet<string> = new Set<RunStatus>([
  "completed",
  "stopped_soft",
  "stopped_hard",
  "failed",
  "interrupted",
]);

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Take over and close what the previous generation left. Never throws: a
 *  ledger that cannot be reached (or predates the routes) is a warning and an
 *  empty outcome — the bot boots as before. */
export async function reclaimAtBoot(opts: ReclaimAtBootOptions): Promise<ReclaimOutcome> {
  const { ledger, gen } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const outcome: ReclaimOutcome = { closed: [], liveElsewhere: [], failed: [] };

  let reclaimed;
  try {
    reclaimed = await ledger.reclaim(gen, now(), LEASE_MS);
  } catch (err) {
    warn(
      err instanceof RouteMissingError
        ? "[reclaim] state Worker has no run-ledger routes — nothing to take over"
        : `[reclaim] reclaim failed: ${describe(err)} — runs the last generation left stay on the ledger until the next boot`,
    );
    return outcome;
  }

  for (const run of reclaimed) {
    const { row } = run;
    try {
      let status: RunStatus;
      let why: string;
      if (run.reclaimedFrom === "finishing") {
        // The old generation had taken `finishing` — its reply is in the
        // thread — and died before `finish`. Close with the status it recorded
        // on the way out; `completed` when it recorded none.
        const recorded = row.state.finalStatus;
        status = typeof recorded === "string" && TERMINAL.has(recorded) ? (recorded as RunStatus) : "completed";
        why = "replied before the previous generation died";
      } else {
        status = "interrupted";
        why = await completenessVerdict(ledger, run.row.runId, run.lastStep);
      }
      const events = await ledger.readEvents(row.runId);
      const finishedAt = now();
      const record = reclaimedRunRecord({ row, events, status, finishedAt });
      const result = await ledger.finish(row.runId, gen, record);
      if (!result.ok) {
        outcome.failed.push({ runId: row.runId, error: `finish refused (${result.reason})` });
        warn(`[reclaim] ${row.runId} ${row.threadKey}: finish refused (${result.reason})`);
        continue;
      }
      outcome.closed.push({
        runId: row.runId,
        threadKey: row.threadKey,
        status,
        from: run.reclaimedFrom,
        why,
        card: row.card,
        events: events.length,
        ...(row.meta.agent !== undefined ? { agent: row.meta.agent } : {}),
      });
      log(
        `[reclaim] ${row.runId} ${row.threadKey} closed ${status} (from ${run.reclaimedFrom}; ${why}; ${events.length} event(s))`,
      );
    } catch (err) {
      outcome.failed.push({ runId: row.runId, error: describe(err) });
      warn(`[reclaim] ${row.runId} ${row.threadKey}: ${describe(err)} — left on the ledger for the next boot`);
    }
  }

  try {
    for (const row of await ledger.listLive()) {
      if (row.ownerGen !== gen)
        outcome.liveElsewhere.push({ runId: row.runId, ownerGen: row.ownerGen, card: row.card });
    }
  } catch (err) {
    warn(`[reclaim] listing live runs failed: ${describe(err)} — the card sweep runs without the ledger's guard`);
  }

  if (reclaimed.length > 0 || outcome.liveElsewhere.length > 0) {
    log(
      `[reclaim] ${gen}: took ${reclaimed.length} run(s) — ${outcome.closed.length} closed, ${outcome.failed.length} failed; ${outcome.liveElsewhere.length} live under another generation`,
    );
  }
  return outcome;
}

/** What a resume would have found (the transcript-completeness rule, item 31),
 *  as the reason on an `interrupted` closure — logged so the rollover receipt
 *  can say how many runs were resumable. */
async function completenessVerdict(
  ledger: RunLedger,
  runId: string,
  lastStep: { turnIndex: number } | null,
): Promise<string> {
  if (!lastStep) return "no step record: killed before its conversation was stored";
  let turns: number;
  let gap: string | undefined;
  try {
    const transcript = await ledger.readTranscript(runId);
    turns = transcript.turns;
    gap = transcript.complete ? undefined : transcript.gap;
  } catch (err) {
    return `transcript unreadable (${describe(err)})`;
  }
  if (gap) return `transcript incomplete: ${gap}`;
  const verdict = transcriptCompleteness({ lastStep, seedTurns: lastStep.turnIndex, transcriptTurns: turns });
  switch (verdict.kind) {
    case "resume":
      return `resumable: the transcript's ${lastStep.turnIndex} turns match the last step record — resume not built yet, closed instead`;
    case "run-step-fresh":
      return "resumable (next step's turns landed, record did not) — resume not built yet, closed instead";
    default:
      return verdict.why;
  }
}
