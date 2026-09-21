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

import type { RunRecord, RunStatus } from "./runRecord.js";
import { RouteMissingError } from "./runStoreWorker.js";
import type { RunLedger } from "./runLedger/ledger.js";
import { transcriptCompleteness } from "./runLedger/decisions.js";
import { transcriptSource } from "./runLedger/resume.js";
import type { AssembledTranscript } from "./runLedger/transcript.js";
import {
  LEASE_MS,
  type AppendableEvent,
  type CardHandle,
  type HostingState,
  type InboxItem,
  type LivePhase,
  type LiveRunRow,
  type StepRecord,
} from "./runLedger/types.js";
import { reclaimedRunRecord } from "./dispatch/record.js";
import { shipInterruptedNote } from "./shipPipeline.js";
import { endingCauseWords, type PlaneEndingCause, type PlaneReclaimWord } from "./plane/decide.js";

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
  /** The PR the run's events say it opened (a `pr_opened` event), if any. */
  prUrl?: string;
  /** What the closed card — and, for a pipeline, the thread — says next: an
   *  interrupted run's guidance (`closureNote`); absent for a run that replied. */
  note?: string;
}

/** The interrupted run's guidance (run-history item 36): a ship pipeline's
 *  names the PR it had and the re-issue that continues it; every other run's
 *  says to re-send the request. With the plane's recorded cause (record 0064)
 *  the note RENDERS it — `endingCauseWords`, the one rendering every surface
 *  shares — and never composes one; without it (an older state Worker) the
 *  note keeps today's words. */
export function closureNote(agent: string | undefined, prUrl: string | undefined, cause?: PlaneEndingCause): string {
  if (agent === "ship")
    // The plane's `resident_replaced` renders as the container sentence; every
    // other close of the boot gap IS a bot restart — the one site that may
    // claim it (issue 1876).
    return shipInterruptedNote(prUrl, cause === "resident_replaced" ? "container_replaced" : "bot_restart");
  if (cause !== undefined)
    return `This is a bug: this run ended — ${endingCauseWords(cause)} — but it could not be resumed from the ledger. This card stopped updating and no replacement run was started.`;
  return "This is a bug: the bot restarted while this run was in flight, but the run could not be resumed from the ledger. This card stopped updating and no replacement run was started.";
}

/** The PR url a run's events recorded (`pr_opened`), the last one wins. */
export function prUrlOf(events: readonly AppendableEvent[]): string | undefined {
  let url: string | undefined;
  for (const e of events) if (e.type === "pr_opened" && typeof e.url === "string") url = e.url;
  return url;
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
  /** A hosted runner another live generation still drives. The next
   *  generation uses its durable instance id to rebuild the pull-ownership
   *  fence before it accepts a sweep. */
  hosting?: HostingState;
}

/** A reclaimed run the resume launcher continues (item 38): its row (ours
 *  now), the last step record, the transcript read whole, and the events it
 *  published before the restart. */
export interface ResumeRun {
  kind?: "resume";
  row: LiveRunRow;
  reclaimedFrom: LivePhase;
  lastStep: StepRecord;
  transcript: Extract<AssembledTranscript, { complete: true }>;
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

/** A hosted ship parent's row (record 0060) whose deadline, live Workflow
 *  or children that remain live say the pipeline still runs: no process of its own to resume —
 *  the plan runner drives it — so the launcher re-hosts the registry/ledger
 *  owner beside the children and subscribes later runner publishes. */
export interface RehostChild {
  runId: string;
  threadKey: string;
  agent?: string;
  idempotencyKey?: string;
}

export interface RehostRun {
  kind: "rehost";
  row: LiveRunRow;
  reclaimedFrom: LivePhase;
  hosting: HostingState;
  events: AppendableEvent[];
  /** Children the same ledger still holds for this instance. A parent is
   *  alive whenever one of these rows is alive, even after its old wall-clock
   *  estimate passed: the Workflow is waiting for that child. */
  children: RehostChild[];
}

export type ResumableRun = ResumeRun | RestartRun | RehostRun;

/** The hosting fact on a row's state, when the ship branch set one (record
 *  0060) and this build can read it; a malformed value reads as none, so the
 *  row falls to the transcript rule and closes like any host-keyed crash. */
export function hostingOf(state: LiveRunRow["state"]): HostingState | undefined {
  const h = state.hosting;
  if (typeof h !== "object" || h === null) return undefined;
  const { instanceId, until } = h as Record<string, unknown>;
  if (typeof instanceId !== "string" || instanceId.length === 0) return undefined;
  if (typeof until !== "number" || !Number.isFinite(until)) return undefined;
  return { instanceId, until };
}

/** The threads a follow-up must be steered into rather than run afresh
 *  (thread-admission item 5): rows other generations hold, plus the reclaimed
 *  rows not yet launched. A `rehost` row contributes nothing (record 0060):
 *  the hosted parent occupies no thread — its children run in its conversation
 *  — and a foreign hosted row's entry is keyed by the ledger's key column,
 *  whose `#host` suffix no message's thread can ever match. */
export function threadsElsewhereOf(
  outcome: ReclaimOutcome,
): { threadKey: string; runId: string; startedAt: number; meta: { agent?: string } }[] {
  return [...outcome.liveElsewhere, ...outcome.resumable.filter((r) => r.kind !== "rehost").map((r) => r.row)];
}

export interface ReclaimOutcome {
  closed: ReclaimedClosure[];
  /** Runs handed to the resume launcher instead of closed. */
  resumable: ResumableRun[];
  /** Runs another generation still holds a current lease on (a rollout
   *  overlap): their cards must not be swept as orphans. */
  liveElsewhere: LiveElsewhere[];
  /** Every hosted runner in the complete live-run listing, including rows
   *  owned by this generation whose classification failed. Ownership recovery
   *  must not lose those runners merely because they are not resumable. */
  liveHosted: HostingState[];
  /** True only when `liveElsewhere` and `liveHosted` came from a complete
   *  live-run listing. Recovery fences must not treat a partial answer as proof
   *  that no generation owns work. */
  liveListingComplete: boolean;
  /** Runs the reclaim could not close (a failed read or finish); their rows
   *  stay ours with a lease, so the next boot takes them again. */
  failed: { runId: string; error: string }[];
}

export interface ReclaimOptions {
  ledger: RunLedger;
  gen: string;
  /** The plain run store's status for a run id — the hosted-row guard (record
   *  0060): `completed` or `failed` means the pipeline's `finish` landed
   *  in the plain store because the ledger refused its write, so the row is
   *  abandoned instead of re-hosted; the provisional `interrupted` record the
   *  ship branch writes at start is the normal state of a hosted run and never
   *  abandons it. Absent (or failing — one warning), a row whose deadline or
   *  Workflow says live is re-hosted; a live child row is authoritative even
   *  over a stale plain-store projection, because abandoning its parent would
   *  orphan the unit. */
  storedStatus?: (runId: string) => Promise<RunStatus | undefined>;
  /** Whether the Workflow instance still runs. `undefined` means the platform
   *  could not answer; a live child row remains sufficient on its own. */
  hostedInstanceLive?: (instanceId: string) => Promise<boolean | undefined>;
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
  const outcome: ReclaimOutcome = {
    closed: [],
    resumable: [],
    liveElsewhere: [],
    liveHosted: [],
    liveListingComplete: false,
    failed: [],
  };

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

  // Reclaim is one plane admission. Read the newly owned rows together, but
  // classify children before hosted parents: a child taken from `finishing` or
  // rejected by the transcript rule closes in this admission and must not keep
  // its parent alive. Children another generation still owns, children this
  // admission will actually resume, and children whose classification failed
  // while their row stayed live remain durable liveness facts.
  let rowsAtAdmission: LiveRunRow[] = reclaimed.map((run) => run.row);
  try {
    rowsAtAdmission = await ledger.listLive();
  } catch (err) {
    warn(`[reclaim] listing the admission's live rows failed (${describe(err)}) — using the reclaimed rows`);
  }
  const admissionOrder = new Map(reclaimed.map((run, index) => [run.row.runId, index]));
  const reclaimedIds = new Set(reclaimed.map((run) => run.row.runId));
  const resumingIds = new Set<string>();
  const failedIds = new Set<string>();
  const childrenOf = (instanceId: string): RehostChild[] =>
    rowsAtAdmission
      .filter(
        (candidate) =>
          candidate.meta.parentInstanceId === instanceId &&
          (!reclaimedIds.has(candidate.runId) || resumingIds.has(candidate.runId) || failedIds.has(candidate.runId)),
      )
      .map((candidate) => ({
        runId: candidate.runId,
        threadKey: candidate.meta.threadKey,
        ...(candidate.meta.agent !== undefined ? { agent: candidate.meta.agent } : {}),
        ...(candidate.meta.idempotencyKey !== undefined ? { idempotencyKey: candidate.meta.idempotencyKey } : {}),
      }));
  const classificationOrder = [...reclaimed].sort(
    (left, right) => Number(hostingOf(left.row.state) !== undefined) - Number(hostingOf(right.row.state) !== undefined),
  );

  for (const run of classificationOrder) {
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
          resumingIds.add(row.runId);
          log(
            `[reclaim] ${row.runId} ${row.threadKey} restartable (from attaching; killed before its prompt existed; ${run.inbox.length} follow-up(s) pending) — handed to the launcher`,
          );
          continue;
        }
        status = "interrupted";
        why = "reserved at admission without its request: nothing to restart from";
      } else if (hostingOf(row.state) !== undefined) {
        // A hosted parent has no transcript of its own: its Workflow and
        // children that remain live are the durable liveness facts. The old
        // `until` is only a final bound when neither exists. Child classification
        // already removed finishing and non-resumable rows from this answer.
        const hosting = hostingOf(row.state)!;
        const children = childrenOf(hosting.instanceId);
        let instanceLive: boolean | undefined;
        if (children.length === 0 && hosting.until <= now() && opts.hostedInstanceLive) {
          try {
            instanceLive = await opts.hostedInstanceLive(hosting.instanceId);
          } catch (err) {
            warn(
              `[reclaim] ${row.runId} ${row.threadKey}: instance status failed (${describe(err)}) — falling back to the ledger deadline`,
            );
          }
        }
        const shouldRehost = hosting.until > now() || children.length > 0 || instanceLive === true;
        if (shouldRehost) {
          // With no child proving liveness, a terminal plain-store record says
          // finish landed there while the ledger write failed: abandon the
          // stale row. A live child wins over that stale projection — closing
          // its owner is the orphan bug this admission prevents.
          let stored: RunStatus | undefined;
          if (children.length === 0) {
            try {
              stored = await opts.storedStatus?.(row.runId);
            } catch (err) {
              warn(`[reclaim] ${row.runId} ${row.threadKey}: store read failed (${describe(err)}) — re-hosting`);
            }
          }
          if (stored === "completed" || stored === "failed") {
            const gone = await ledger.abandon(row.runId, gen);
            if (!gone.ok) {
              outcome.failed.push({ runId: row.runId, error: `abandon refused (${gone.reason})` });
              warn(`[reclaim] ${row.runId} ${row.threadKey}: abandon refused (${gone.reason})`);
              continue;
            }
            log(
              `[reclaim] ${row.runId} ${row.threadKey} abandoned (hosted; the store already holds its ${stored} record — the pipeline's finish landed there)`,
            );
            continue;
          }
          const events = await ledger.readEvents(row.runId);
          outcome.resumable.push({ kind: "rehost", row, reclaimedFrom: run.reclaimedFrom, hosting, events, children });
          resumingIds.add(row.runId);
          log(
            `[reclaim] ${row.runId} ${row.threadKey} rehost (from ${run.reclaimedFrom}; instance ${hosting.instanceId}; ${children.length} live child(ren); ${events.length} event(s)) — handed to the launcher`,
          );
          continue;
        }
        // Past its deadline with no live Workflow or child: the runner died
        // without `finish`, and re-hosting again would hold the host key forever.
        status = "interrupted";
        why = `hosted past its deadline (${new Date(hosting.until).toISOString()}): the pipeline's runner never finished it`;
      } else {
        // Resumable (item 38) when the transcript is whole and the completeness
        // rule accepts it against the last step record; the launcher plans the
        // settlement once the socket is up. Otherwise closed here.
        const verdict = await completenessVerdict(ledger, row, run.lastStep);
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
          resumingIds.add(row.runId);
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
        // A fence proves the row still exists under another generation. Keep
        // that durable child in its hosted parent's liveness facts just as we
        // do when classification throws while the row remains ours.
        if (closed.reason === "fenced") failedIds.add(row.runId);
        outcome.failed.push({ runId: row.runId, error: `finish refused (${closed.reason})` });
        warn(`[reclaim] ${row.runId} ${row.threadKey}: finish refused (${closed.reason})`);
        continue;
      }
      const prUrl = prUrlOf(events);
      outcome.closed.push({
        runId: row.runId,
        // The metadata's thread, never the ledger's key column (record 0060):
        // the interrupted-run notice files a hosted row's closure under its
        // conversation, where the host key would name no thread at all.
        threadKey: row.meta.threadKey,
        status,
        from: run.reclaimedFrom,
        why,
        card: row.card,
        events: events.length,
        ...(row.meta.agent !== undefined ? { agent: row.meta.agent } : {}),
        ...(prUrl !== undefined ? { prUrl } : {}),
        ...(status === "interrupted" ? { note: closureNote(row.meta.agent, prUrl) } : {}),
      });
      log(
        `[reclaim] ${row.runId} ${row.threadKey} closed ${status} (from ${run.reclaimedFrom}; ${why}; ${events.length} event(s))`,
      );
    } catch (err) {
      failedIds.add(row.runId);
      outcome.failed.push({ runId: row.runId, error: describe(err) });
      warn(`[reclaim] ${row.runId} ${row.threadKey}: ${describe(err)} — left on the ledger for the next boot`);
    }
  }

  // Classification is dependency-ordered; callers still receive the ledger's
  // admission order, as they did before parent and child liveness were coupled.
  const orderOf = (runId: string): number => admissionOrder.get(runId) ?? Number.MAX_SAFE_INTEGER;
  outcome.closed.sort((left, right) => orderOf(left.runId) - orderOf(right.runId));
  outcome.resumable.sort((left, right) => orderOf(left.row.runId) - orderOf(right.row.runId));
  outcome.failed.sort((left, right) => orderOf(left.runId) - orderOf(right.runId));

  try {
    for (const row of await ledger.listLive()) {
      const hosting = hostingOf(row.state);
      if (hosting !== undefined) outcome.liveHosted.push(hosting);
      if (row.ownerGen !== gen) {
        outcome.liveElsewhere.push({
          runId: row.runId,
          ownerGen: row.ownerGen,
          card: row.card,
          threadKey: row.threadKey,
          startedAt: row.startedAt,
          meta: { ...(row.meta.agent !== undefined ? { agent: row.meta.agent } : {}) },
          ...(hosting !== undefined ? { hosting } : {}),
        });
      }
    }
    outcome.liveListingComplete = true;
  } catch (err) {
    warn(`[reclaim] listing live runs failed: ${describe(err)} — recovery guards remain fenced`);
  }

  // The reclaim's outcome is reported to the object (record 0064, "Endings and
  // the watches"; run-history item 36): `resume`, `restart` and `rehost` record
  // nothing — the run carries on — and each `closed` row's ending gets its
  // cause, answered back so the interrupted note renders the plane's word. An
  // older state Worker without the route is one warning and today's words.
  const words: { runId: string; outcome: PlaneReclaimWord }[] = [
    ...outcome.resumable.map((r) => ({ runId: r.row.runId, outcome: (r.kind ?? "resume") as PlaneReclaimWord })),
    ...outcome.closed.map((c) => ({ runId: c.runId, outcome: "closed" as const })),
  ];
  if (words.length > 0) {
    try {
      const recorded = await ledger.planeReclaimed(words);
      for (const { runId, cause } of recorded) {
        const closure = outcome.closed.find((c) => c.runId === runId);
        if (closure && closure.status === "interrupted")
          closure.note = closureNote(closure.agent, closure.prUrl, cause);
      }
    } catch (err) {
      warn(`[reclaim] outcome report not recorded (${describe(err)}) — the notes keep today's words`);
    }
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
  /** Called with every complete listing or non-empty outcome — the launcher,
   *  the card closer and recovery guards. */
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
      if (
        outcome.liveListingComplete ||
        outcome.closed.length + outcome.resumable.length + outcome.failed.length + outcome.liveElsewhere.length > 0
      ) {
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
  | { resumable: true; transcript: Extract<AssembledTranscript, { complete: true }>; why: string }
  | { resumable: false; why: string };

/** The transcript-completeness rule (item 31) against the last step record:
 *  what a resume finds, with the reason in words for the log and the record.
 *  The rows come from the run's session log from where its seed began, or
 *  from its own transcript object for a row claimed before the log existed
 *  (docs/reference/specs/session-log.md item 3). */
async function completenessVerdict(
  ledger: RunLedger,
  row: LiveRunRow,
  lastStep: { turnIndex: number } | null,
): Promise<Verdict> {
  if (!lastStep) return { resumable: false, why: "no step record: killed before its conversation was stored" };
  let transcript;
  try {
    const source = transcriptSource(row.meta);
    transcript =
      source.kind === "session"
        ? await ledger.readSession(source.key, source.from)
        : await ledger.readTranscript(row.runId);
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
