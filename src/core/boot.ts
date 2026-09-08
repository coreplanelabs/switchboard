// The boot sequence's ledger step (docs/reference/specs/run-history.md item 36): before
// the Slack socket opens, this generation takes over every run the previous
// one left on the ledger — an expired lease (the owner died), a handoff (the
// owner drained), or a `finishing` row (the owner replied and died before
// `finish`) — and either hands it to the resume launcher (item 38: a row from
// `live`/`handoff` whose transcript and last step record the completeness
// rule accepts) or closes it with a proper record, so no run ever ends as a
// card spinning forever with a tombstone for a record.
//
// Ordering: awaited by `src/index.ts` before `app.start()` (D7), then repeated
// every lease interval (`startReclaimSweep`): a row whose lease was still
// current at boot — the owner died seconds before — expires shortly after, and
// nothing else would ever take it. The catch-up's orphan sweep finds the closed
// runs' cards unowned and closes them as interrupted; the rows another
// generation still holds a current lease on are handed back so the sweep leaves
// THEIR cards alone (`liveElsewhere`).

import type { ChatMessage } from "../providers/types.js";
import type { RunRecord, RunStatus } from "./runRecord.js";
import { RouteMissingError } from "./runStoreWorker.js";
import type { RunLedger } from "./runLedger/ledger.js";
import { transcriptCompleteness } from "./runLedger/decisions.js";
import {
  LEASE_MS,
  type AppendableEvent,
  type CardHandle,
  type InboxItem,
  type LivePhase,
  type LiveRunRow,
  type StepRecord,
} from "./runLedger/types.js";
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
  /** For the admission map (thread-admission item 5): a follow-up on this
   *  thread is steered into the run's durable inbox, not run afresh. */
  threadKey: string;
  startedAt: number;
  meta: { agent?: string };
}

/** A reclaimed run the resume launcher continues (item 38): its row (ours
 *  now), the last step record, the transcript read whole, and the events it
 *  published before the restart. */
export interface ResumeRun {
  kind?: "resume";
  row: LiveRunRow;
  reclaimedFrom: LivePhase;
  lastStep: StepRecord;
  transcript: { complete: true; turns: number; messages: ChatMessage[] };
  events: AppendableEvent[];
  /** Follow-ups steered into the run after its last step record (item 40):
   *  the resume folds them in at its first boundary. */
  inbox: InboxItem[];
}

/** A run reserved at admission whose owner died before its prompt existed
 *  (item 42): nothing to resume from, so the launcher dispatches the row's own
 *  request again under the same run id and card. The row is still `attaching`
 *  and ours; the follow-ups steered into it meanwhile ride along. */
export interface RestartRun {
  kind: "restart";
  row: LiveRunRow;
  reclaimedFrom: "attaching";
  inbox: InboxItem[];
}

export type ResumableRun = ResumeRun | RestartRun;

export interface ReclaimOutcome {
  closed: ReclaimedClosure[];
  /** Runs handed to the resume launcher instead of closed. */
  resumable: ResumableRun[];
  /** Runs another generation still holds a current lease on (a rollout
   *  overlap): their cards must not be swept as orphans. */
  liveElsewhere: LiveElsewhere[];
  /** Runs the reclaim could not close (a failed read or finish); their rows
   *  stay ours with a lease, so the next boot takes them again. */
  failed: { runId: string; error: string }[];
}

export interface ReclaimOptions {
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
export async function reclaimRuns(opts: ReclaimOptions): Promise<ReclaimOutcome> {
  const { ledger, gen } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const outcome: ReclaimOutcome = { closed: [], resumable: [], liveElsewhere: [], failed: [] };

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
      } else if (run.reclaimedFrom === "attaching") {
        // Reserved at admission, killed before its prompt existed (item 42):
        // restarted from the request the row carries — or, without one (a row
        // this build cannot read), closed like any run with nothing to resume.
        if (typeof row.meta.request === "object" && row.meta.request !== null) {
          outcome.resumable.push({ kind: "restart", row, reclaimedFrom: "attaching", inbox: run.inbox });
          log(
            `[reclaim] ${row.runId} ${row.threadKey} restartable (from attaching; killed before its prompt existed; ${run.inbox.length} follow-up(s) pending) — handed to the launcher`,
          );
          continue;
        }
        status = "interrupted";
        why = "reserved at admission without its request: nothing to restart from";
      } else {
        // Resumable (item 38) when the transcript is whole and the completeness
        // rule accepts it against the last step record; the launcher plans the
        // settlement once the socket is up. Otherwise closed here.
        const verdict = await completenessVerdict(ledger, row.runId, run.lastStep);
        if (verdict.resumable && run.lastStep) {
          const events = await ledger.readEvents(row.runId);
          outcome.resumable.push({
            row,
            reclaimedFrom: run.reclaimedFrom,
            lastStep: run.lastStep,
            transcript: verdict.transcript,
            events,
            inbox: run.inbox,
          });
          log(
            `[reclaim] ${row.runId} ${row.threadKey} resumable (from ${run.reclaimedFrom}; ${verdict.why}; ${events.length} event(s)) — handed to the launcher`,
          );
          continue;
        }
        status = "interrupted";
        why = verdict.why;
      }
      const events = await ledger.readEvents(row.runId);
      const closed = await closeReclaimed(ledger, gen, { row, events, status, finishedAt: now() });
      if (!closed.ok) {
        outcome.failed.push({ runId: row.runId, error: `finish refused (${closed.reason})` });
        warn(`[reclaim] ${row.runId} ${row.threadKey}: finish refused (${closed.reason})`);
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
        outcome.liveElsewhere.push({
          runId: row.runId,
          ownerGen: row.ownerGen,
          card: row.card,
          threadKey: row.threadKey,
          startedAt: row.startedAt,
          meta: { ...(row.meta.agent !== undefined ? { agent: row.meta.agent } : {}) },
        });
    }
  } catch (err) {
    warn(`[reclaim] listing live runs failed: ${describe(err)} — the card sweep runs without the ledger's guard`);
  }

  if (reclaimed.length > 0 || outcome.liveElsewhere.length > 0) {
    log(
      `[reclaim] ${gen}: took ${reclaimed.length} run(s) — ${outcome.resumable.length} resumable, ${outcome.closed.length} closed, ${outcome.failed.length} failed; ${outcome.liveElsewhere.length} live under another generation`,
    );
  }
  return outcome;
}

export interface ReclaimSweepOptions extends ReclaimOptions {
  /** Default `LEASE_MS`: an expired lease is noticed within two intervals. */
  intervalMs?: number;
  /** Called with every non-empty outcome — the launcher, the card closer, the sweep guard. */
  onOutcome: (outcome: ReclaimOutcome) => Promise<void> | void;
  /** Injectable timer (tests). */
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
}

/** The boot reclaim, repeated: every interval, take and close (or hand to the
 *  launcher) whatever the ledger holds under an expired lease or a handoff.
 *  One pass at a time; a pass that throws is a warning, never a crash. */
export function startReclaimSweep(opts: ReclaimSweepOptions): { stop(): void } {
  const warn = opts.warn ?? (() => {});
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const outcome = await reclaimRuns(opts);
      if (outcome.closed.length + outcome.resumable.length + outcome.failed.length + outcome.liveElsewhere.length > 0) {
        await opts.onOutcome(outcome);
      }
    } catch (err) {
      warn(`[reclaim] sweep failed: ${describe(err)}`);
    } finally {
      running = false;
    }
  };
  const start =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const stop = opts.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout));
  const timer = start(() => void pass(), opts.intervalMs ?? LEASE_MS);
  return { stop: () => stop(timer) };
}

/** Close one reclaimed run on the ledger with the record built from its row
 *  and events (item 36) — the boot's closer, and the launcher's for a run the
 *  plan refuses. */
export async function closeReclaimed(
  ledger: RunLedger,
  gen: string,
  input: { row: LiveRunRow; events: AppendableEvent[]; status: RunStatus; finishedAt: number },
): Promise<{ ok: true; record: RunRecord } | { ok: false; reason: string }> {
  const record = reclaimedRunRecord(input);
  const result = await ledger.finish(input.row.runId, gen, record);
  return result.ok ? { ok: true, record } : { ok: false, reason: result.reason ?? "refused" };
}

type Verdict =
  | { resumable: true; transcript: { complete: true; turns: number; messages: ChatMessage[] }; why: string }
  | { resumable: false; why: string };

/** The transcript-completeness rule (item 31) against the last step record:
 *  what a resume finds, with the reason in words for the log and the record. */
async function completenessVerdict(
  ledger: RunLedger,
  runId: string,
  lastStep: { turnIndex: number } | null,
): Promise<Verdict> {
  if (!lastStep) return { resumable: false, why: "no step record: killed before its conversation was stored" };
  let transcript;
  try {
    transcript = await ledger.readTranscript(runId);
  } catch (err) {
    return { resumable: false, why: `transcript unreadable (${describe(err)})` };
  }
  if (!transcript.complete) return { resumable: false, why: `transcript incomplete: ${transcript.gap}` };
  const verdict = transcriptCompleteness({
    lastStep,
    seedTurns: lastStep.turnIndex,
    transcriptTurns: transcript.turns,
  });
  switch (verdict.kind) {
    case "resume":
      return {
        resumable: true,
        transcript,
        why: `the transcript's ${transcript.turns} turns match the last step record`,
      };
    case "run-step-fresh":
      return { resumable: true, transcript, why: "the next step's turns landed, its record did not" };
    default:
      return { resumable: false, why: verdict.why };
  }
}
