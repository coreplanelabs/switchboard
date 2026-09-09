// The record stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// what a run leaves behind. The channel-visibility stamp every run is created
// with, and the ONE `RunRecord` assembly every run goes through before
// `runHistoryWriter.write` — an agent run at its finish, an inline command run,
// a run the drain deadline abandons, a run a booting generation reclaims.
import type { IncomingMessage } from "../types.js";
import type { ChannelDirectory, ChannelVisibility } from "../authz/types.js";
import { STATIC_CHANNEL_DIRECTORY } from "../authz/channelDirectory.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "../runFriction.js";
import { SPAN_SCHEMA } from "../normalizeSpans.js";
import { isSpanRecord } from "../runEvents.js";
import { fitRecordToBudget, type RunRecord, type RunStatus } from "../runRecord.js";
import type { RunHandle, RunRegistry } from "../runRegistry.js";
import { activityOfEvents } from "../runRegistry/activity.js";
import type { RunSnapshot, RunSummary, SealResult } from "../runRegistry/projections.js";
import type { RunHistoryWriter } from "../runHistoryWriter.js";
import type { AppendableEvent, LiveRunRow } from "../runLedger/types.js";
import type { ResolvedRequest } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import type { RepoContext } from "../repoContext.js";
import type { RunEnding } from "../runEnding.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import type { Span } from "../trace/types.js";
import type { ResumeContext } from "./admission.js";

/** What the record stage reads off the dispatcher's dependencies: the channel
 *  directory the visibility stamp is asked of, and its wait bound. `CoreDeps`
 *  extends this, so a caller's shape is unchanged; the stage declares only
 *  what it uses. */
export interface RecordDeps {
  /**
   * Channel facts for the run record (docs/decisions/0007-authorization-policy-table.md): every run is
   * stamped with its channel's visibility at create, asked of this directory
   * once per run. Default: the static id-based directory (`http:`/`mcp:` →
   * machine, `slack:D…` → dm, `slack:G…` → private, anything else → unknown);
   * the bot wires the Slack one (`SlackChannelDirectory`, `conversations.info`
   * cached per channel per TTL) when the Slack adapter is up. A directory
   * failure — or an answer slower than `channelDirectoryTimeoutMs` — stamps
   * `unknown`, never a guess, so a slow directory cannot delay a reply.
   */
  channelDirectory?: ChannelDirectory;
  /** Bound on one `channelDirectory.info` wait (default `CHANNEL_DIRECTORY_TIMEOUT_MS`).
   *  Tests that exercise the timeout set it low. */
  channelDirectoryTimeoutMs?: number;
  /**
   * The write path onto `runStore` (docs/decisions/0006-runs-have-two-lives.md): after every run the dispatcher
   * builds the `RunRecord` at finish and hands it here AFTER the reply is sent —
   * fire-and-forget with bounded retries, drain-counted via `pending()`. With
   * history off it is the `NullRunHistoryWriter` — every write dropped —
   * so the dispatcher never asks whether there is one. Production wires
   * `createRunHistoryWriter` over the selected store (src/index.ts, src/cli.ts).
   */
  runHistoryWriter: RunHistoryWriter;
}

/** The longest a reply waits on the channel directory. The Slack directory
 *  answers from its cache after the first message per channel per TTL; a cold
 *  `conversations.info` is one round trip, and a Slack outage must cost the
 *  user at most this much — the run is then stamped `unknown` (grants-only). */
export const CHANNEL_DIRECTORY_TIMEOUT_MS = 1500;

const DIRECTORY_TIMED_OUT = Symbol("channel directory timed out");

/** The visibility stamp for a run in `channelId` (docs/decisions/0007-authorization-policy-table.md): what the
 *  channel directory says, asked once per run and awaited for at most
 *  `channelDirectoryTimeoutMs`; a directory that throws, rejects, or is too slow
 *  yields `unknown` — never public, never a member. */
export async function channelVisibilityOf(deps: RecordDeps, channelId: string): Promise<ChannelVisibility> {
  const timeoutMs = deps.channelDirectoryTimeoutMs ?? CHANNEL_DIRECTORY_TIMEOUT_MS;
  const failed = (err: unknown): ChannelVisibility => {
    console.warn(
      `[authz] channel directory failed for ${channelId} — stamping unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Caught BEFORE the race, so a rejection is `unknown` by the same path
    // whether it lands before the timeout (stamped at once) or after it (the
    // run is already stamped; the late failure is logged, never left unhandled).
    const lookup = (deps.channelDirectory ?? STATIC_CHANNEL_DIRECTORY)
      .info(channelId)
      .then((info) => info.visibility, failed);
    const answer = await Promise.race([
      lookup,
      new Promise<typeof DIRECTORY_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(DIRECTORY_TIMED_OUT), timeoutMs);
      }),
    ]);
    if (answer === DIRECTORY_TIMED_OUT) {
      console.warn(`[authz] channel directory timed out after ${timeoutMs} ms for ${channelId} — stamping unknown`);
      return "unknown";
    }
    return answer;
  } catch (err) {
    // `info` threw synchronously (a non-async implementation).
    return failed(err);
  } finally {
    clearTimeout(timer);
  }
}
/**
 * The `interrupted` record for a run the drain deadline abandons: the
 * run's full registry snapshot (every event published so far) with
 * `finishedAt` = the drain's clock — the tombstone upgrade `src/index.ts`
 * writes for each still-active run before `process.exit`. Identity comes from
 * the run's `RunSummary` (the same `RunMeta` the dispatcher gave `create()`;
 * the channel/user/thread fields are always present on a dispatcher-created
 * run — the empty-string fallback only guards a hand-built registry entry).
 * The diagnosis is computed as unfinished: the run never reached `finish`.
 */
export function interruptedRunRecord(summary: RunSummary, snap: RunSnapshot, finishedAt: number): RunRecord {
  return assembleRunRecord({
    run: { id: summary.id, ...(summary.label !== undefined ? { label: summary.label } : {}) },
    snap,
    agent: summary.agent,
    model: summary.model,
    msg: {
      channelId: summary.channelId ?? "",
      userId: summary.userId ?? "",
      threadKey: summary.threadKey ?? "",
      sourceUrl: summary.sourceUrl,
      userName: summary.userName,
    },
    channelVisibility: summary.channelVisibility ?? "unknown",
    repo: summary.repo,
    finishedAt,
    status: "interrupted",
    diagnosis: analyzeRunFriction(snap.events, { finished: false, truncated: snap.truncated, schema: SPAN_SCHEMA }),
  });
}

/**
 * The record a booting generation closes a reclaimed run with (docs/reference/specs/
 * run-history.md item 36): the ledger row's identity and meta, the events it
 * appended while it ran (the registry that published them died with the old
 * process, so the ledger's copy is the whole stream — `eventCount` is its
 * last `seq`), the terminal status the reclaim decided, and `finishedAt` =
 * the reclaim's clock (nobody knows when the old process died). No label: the
 * row carries none.
 */
export function reclaimedRunRecord(input: {
  row: LiveRunRow;
  events: AppendableEvent[];
  status: RunStatus;
  finishedAt: number;
}): RunRecord {
  const { row, events, status, finishedAt } = input;
  const snap: RunSnapshot = {
    events,
    finished: true,
    startedAt: row.startedAt,
    finishedAt,
    eventCount: events.reduce((max, e) => Math.max(max, e.seq), 0),
    stepCount: events.filter((e) => !isSpanRecord(e)).length,
    truncated: false,
  };
  return assembleRunRecord({
    run: { id: row.runId },
    snap,
    agent: row.meta.agent,
    model: row.meta.model,
    msg: {
      channelId: row.meta.channelId,
      userId: row.meta.userId,
      threadKey: row.threadKey,
      sourceUrl: row.meta.sourceUrl,
      userName: row.meta.userName,
    },
    channelVisibility: row.meta.channelVisibility ?? "unknown",
    repo: row.meta.repo,
    finishedAt,
    status,
    diagnosis: analyzeRunFriction(events, {
      finished: status !== "interrupted",
      truncated: false,
      schema: SPAN_SCHEMA,
      // A reclaimed run that did finish has its window: the row's start to the
      // finish the closing generation stamped.
      ...(status !== "interrupted" ? { window: { start: row.startedAt, end: finishedAt } } : {}),
    }),
  });
}

/**
 * The drain deadline's abandonment pass, called by `src/index.ts` right
 * before `process.exit`: every registry run still unfinished gets its tombstone
 * upgraded to a full-transcript `interrupted` record (`interruptedRunRecord`
 * over the run's whole snapshot, `finishedAt` = the drain's clock). The writes
 * are `provisional` like the start tombstone: the persisted flag means
 * "finished and durably stored" — these runs never finished (and the registry
 * dies with the process) — and a provisional write stands down in the writer
 * if the run's real finish record shows up inside the drain's write budget, so
 * this pass can never clobber a finish that races it. Synchronous end to end
 * (the writes are fire-and-forget); returns how many were enqueued so the
 * caller knows whether to await the writer under its budget.
 */
export function writeAbandonedRunRecords(
  registry: Pick<RunRegistry, "listActive" | "snapshotById">,
  writer: Pick<RunHistoryWriter, "write">,
  now: number,
  log: (line: string) => void = console.log,
  /** Runs handed to the next generation (run-history item 39): their record is
   *  the ledger's, not a tombstone from here. */
  exclude: ReadonlySet<string> = new Set(),
): number {
  let written = 0;
  for (const summary of registry.listActive()) {
    if (summary.finished || exclude.has(summary.id)) continue;
    const snap = registry.snapshotById(summary.id);
    if (!snap) continue;
    writer.write(interruptedRunRecord(summary, snap, now), { provisional: true });
    log(`[drain] wrote interrupted record for ${summary.id} (${snap.events.length} events)`);
    written++;
  }
  return written;
}

/**
 * The persisted `RunRecord` for a finished run — the ONE assembly both an agent
 * run and an inline command run go through: the registry's redacted label and
 * finish-time snapshot, the caller's identity from the message, the terminal
 * status, and the diagnosis; then `fitRecordToBudget`. `repo`/`model` are omitted
 * (not set undefined) when absent, so the record's JSON is exactly what the
 * store measures and `isRunRecord` re-validates. The backlog is bounded (count +
 * bytes) while `eventCount` is the published total: a run that outgrew it is
 * `truncated` before the byte budget is even considered.
 */
export function assembleRunRecord(input: {
  run: Pick<RunHandle, "id" | "label">;
  snap: RunSnapshot | null;
  agent?: string;
  model?: string;
  msg: Pick<IncomingMessage, "channelId" | "userId" | "threadKey" | "sourceUrl" | "userName">;
  /** The stamp taken at create (`channelVisibilityOf`) — the record carries what the run was stamped with. */
  channelVisibility: ChannelVisibility;
  repo?: string;
  finishedAt: number;
  status: RunStatus;
  diagnosis: FrictionDiagnosis;
  /** The run's seal (docs/reference/specs/tracing.md): the events published between finish
   *  and seal are appended, the published total takes the larger count, and the
   *  two seal stamps ride the record — omitted when the seal has none. */
  seal?: SealResult;
}): RunRecord {
  const { run, snap, msg, seal } = input;
  const atFinish = snap?.events ?? [];
  const events = seal && seal.events.length > 0 ? [...atFinish, ...seal.events] : atFinish;
  const fitted = fitRecordToBudget({
    id: run.id,
    ...(run.label !== undefined ? { label: run.label } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    channelVisibility: input.channelVisibility,
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    // The window's opening rides the record (docs/reference/specs/tracing.md): every
    // duration surface and the diagnosis's window start here, not at create.
    ...(snap?.receivedAt !== undefined ? { receivedAt: snap.receivedAt } : {}),
    startedAt: snap?.startedAt ?? input.finishedAt,
    finishedAt: input.finishedAt,
    ...(seal?.sealedAt !== undefined ? { sealedAt: seal.sealedAt } : {}),
    ...(seal?.replyOk !== undefined ? { replyOk: seal.replyOk } : {}),
    ...(snap !== null ? { stepCount: snap.stepCount } : {}),
    status: input.status,
    eventCount: Math.max(snap?.eventCount ?? atFinish.length, seal?.eventCount ?? 0),
    storedEventCount: events.length,
    truncated: false,
    schema: SPAN_SCHEMA, // the stream carries spans, never `turn` events (docs/reference/specs/tracing.md)
    events,
    diagnosis: input.diagnosis,
    // What the run was last doing / how it ended, and where it came from — so the
    // index can say what failed and link the thread without the events (item 20).
    ...(activityOfEvents(events) !== undefined ? { activity: activityOfEvents(events) } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
  });
  return fitted.eventCount !== fitted.storedEventCount ? { ...fitted, truncated: true } : fitted;
}

/** What `writeTombstone` reads off the dispatch. */
export interface TombstoneContext {
  msg: IncomingMessage;
  agent: AgentDef;
  resolved: ResolvedRequest;
  repoCtx: RepoContext;
  channelVisibility: ChannelVisibility;
  run: RunHandle;
  registry: RunRegistry;
  resume: ResumeContext | undefined;
}

/**
 * Tombstone-first (run-history item 42): a provisional TERMINAL record —
 * status `interrupted`, `finishedAt` = `startedAt` — written the moment the run
 * loop owns the run, from the events published so far, so a crash or a drain
 * abandonment needs no store-side fixup: the tombstone is already the truth.
 * The finish write replaces it; the drain deadline upgrades it. Nothing for a
 * resume, whose record the ledger already holds.
 */
export function writeTombstone(deps: RecordDeps, ctx: TombstoneContext): void {
  const { msg, agent, resolved, repoCtx, channelVisibility, run, registry, resume } = ctx;
  // Tombstone-first: a provisional TERMINAL record — status
  // `interrupted`, `finishedAt` = `startedAt` — goes to the store now, built
  // from the events published so far (the setup spans, request, run_meta,
  // context). Written here, once the run loop owns the run, and not at the
  // reservation: a dispatch that ends before this point leaves NO record
  // (item 42 — its row is discarded and its reservation abandoned), and a
  // crash during the attach is the reservation's to restart, not a record's
  // to remember. Because it is already terminal, a crash or a
  // drain-abandonment needs NO store-side
  // fixup by the next container: the tombstone is already the truth (its
  // `finishedAt` stays the start time — nobody knows the real death time of a
  // crash). The finish write below replaces it (same-id upsert) for every run
  // that ends normally, and the drain deadline upgrades it with the full
  // transcript for a run it abandons. Fire-and-forget through the same writer
  // (retry + drain accounting), but `provisional`: `onPersisted`/
  // `markPersisted` must NOT run — the index's persisted flag means "finished
  // and durably stored". Synchronous assembly over a handful of bounded
  // events; the first model call is not delayed.
  if (!resume) {
    const startSnap = registry.snapshot(run.id, run.token);
    if (startSnap) {
      deps.runHistoryWriter.write(
        assembleRunRecord({
          run,
          snap: startSnap,
          agent: agent.name,
          model: resolved.modelRef,
          msg,
          channelVisibility,
          repo: repoCtx.repo,
          finishedAt: startSnap.startedAt,
          status: "interrupted",
          diagnosis: analyzeRunFriction(startSnap.events, {
            finished: false,
            truncated: startSnap.truncated,
            schema: SPAN_SCHEMA,
          }),
        }),
        { provisional: true },
      );
    }
  }
}

/** What `registerFinishRecord` reads off the dispatch. */
export interface FinishRecordContext {
  ending: RunEnding;
  run: RunHandle;
  snap: RunSnapshot | null;
  agent: AgentDef;
  resolved: ResolvedRequest;
  msg: IncomingMessage;
  channelVisibility: ChannelVisibility;
  repoCtx: RepoContext;
  finishedAt: number;
  status: RunStatus;
  diagnosis: FrictionDiagnosis;
  root: Span;
  ledgerRun: LedgerRun | undefined;
}

/**
 * The finish record, registered for the drain that follows the reply: the
 * finish-site snapshot and diagnosis assembled after the seal — so the record
 * carries the seal's stamps — and written through the ledger's finish when the
 * run is tracked (one transaction replacing its live rows) or the plain store
 * otherwise. A reply that threw after the loop completed flips a `completed`
 * run to `failed`: the thread never saw the answer.
 */
export function registerFinishRecord(deps: RecordDeps, ctx: FinishRecordContext): void {
  const {
    ending,
    run,
    snap,
    agent,
    resolved,
    msg,
    channelVisibility,
    repoCtx,
    finishedAt,
    status,
    diagnosis,
    root,
    ledgerRun,
  } = ctx;
  // A tracked run finishes through the ledger: the record replaces its
  // live rows in one transaction (a refused finish falls back to the store).
  ending.register({
    runId: run.id,
    flipOnPostFinishFailure: true,
    write: (seal, failedAfterFinish) =>
      deps.runHistoryWriter.write(
        assembleRunRecord({
          run,
          snap,
          agent: agent.name,
          model: resolved.modelRef,
          msg,
          channelVisibility,
          repo: repoCtx.repo,
          finishedAt,
          status: failedAfterFinish && status === "completed" ? "failed" : status,
          diagnosis,
          seal,
        }),
        { span: root, ...(ledgerRun ? { via: ledgerRun.sink } : {}) },
      ),
  });
}
