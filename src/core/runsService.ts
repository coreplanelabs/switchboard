import { matchesPredicate } from "./authz/predicate.js";
import type { ChannelVisibility, Predicate, Resource } from "./authz/types.js";
import type { RunActor, RunEvent, StopMode } from "./runEvents.js";
import { systemClock } from "./trace/clock.js";
import { SPAN_SCHEMA } from "./normalizeSpans.js";
import { analyzeRunFriction, type FrictionOptions, type FrictionDiagnosis } from "./runFriction.js";
import {
  clampListLimit,
  RUN_ID_PATTERN,
  RUN_LIST_MAX_LIMIT,
  toVisibilityFilter,
  utf8ByteLength,
  type RunListItem,
  type RunRecord,
} from "./runRecord.js";
import type { RunRegistry, StopRequestResult, SubscribeOptions, Subscribed } from "./runRegistry.js";
import type { RunSnapshot, RunStopStatus, RunSummary } from "./runRegistry/projections.js";
import type { RunStore } from "./runStore.js";
import type { RunLedger } from "./runLedger/ledger.js";
import type { LiveRunRow } from "./runLedger/types.js";
import { activityOfEvents } from "./runRegistry/activity.js";

/** How long one ledger listing serves the service's reads (item 41): a page
 *  view is a run read, an events read and a friction read within a second, and
 *  the ledger's live rows change on the order of a run's lifetime. */
export const LEDGER_LIST_TTL_MS = 2_000;

// Run history (docs/decisions/0006-runs-have-two-lives.md): the ONE service behind every `runs.*` command — list,
// get, events, friction, stop — and the live view's authorization. It owns the
// read merge between the in-memory registry (live runs, plus finished ones for
// the 60 s TTL) and the durable `RunStore` (finished runs for the retention
// window), and it is the boundary where the registry's capability token stops:
// nothing this module returns carries `token` (`RunSummary` never leaves
// the core). Who may CALL is decided one layer up (the command registry's policy
// table, the Cloudflare Access gate). What a caller may SEE in a list
// arrives as `visibleTo` — the authorization policy compiled to a store
// predicate (`predicateFor`, authorization.md item 6) — and is pushed down: live
// rows are filtered by the reference evaluator, the store receives the same
// predicate as its filter, and nothing is loaded to be dropped afterwards.
// Point reads return the run as stored; the command that asked authorizes it
// against the run's own attributes (a deny is `not_found`). The one check
// this service makes itself is `authorizeLive`, the capability-token gate for
// the live SSE/HTML path, synchronous so that path stays byte-identical.

export type { RunActor } from "./runEvents.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: "not_found" | "conflict" };

/**
 * One run as every surface sees it — live or persisted, the same shape. A
 * persisted `RunListItem` is assignable to it as-is (with `finished: true`,
 * `persisted: true`); a live registry row carries the same identity fields
 * (`label`, `agent`, `model`, `channelId`, `userId`, `threadKey`, `repo` — the
 * `RunMeta` given at `create()`), so the two project identically except for
 * what only exists once the run is over: `finishedAt`, `status`,
 * `storedEventCount`/`truncated`/`bytes`, `diagnosis`. `stop` is present only
 * while the registry holds the run (it is the live stop state; a persisted row
 * expresses the outcome as `status`).
 */
export interface RunView {
  id: string;
  label?: string;
  agent?: string;
  model?: string;
  channelId?: string;
  userId?: string;
  threadKey?: string;
  /** The stamped visibility (authorization); absent on a hand-built live row = `unknown`. */
  channelVisibility?: ChannelVisibility;
  repo?: string;
  startedAt: number;
  /** Absent while the run is live. */
  finishedAt?: number;
  /** The seven stamps and the one duration (docs/reference/specs/tracing.md). `receivedAt`:
   *  our process saw the message, from the adapter's clock (stamped by the
   *  dispatcher once the adapters carry it; absent until then, so every reader
   *  falls back to `startedAt`). `sealedAt`: the stream closed, when the first
   *  reply attempt completed or the branch was abandoned; `replyOk` is
   *  tri-state — `true` a reply was attempted and delivered, `false` attempted
   *  and threw, absent none was made. `stepCount`: content events only (span
   *  records excluded). `schema`: the stream schema — `SPAN_SCHEMA` on every
   *  registry and ledger view (a current runner emitted it); a STORED record
   *  absent it or below it carries no timing. All omitted when absent. */
  receivedAt?: number;
  sealedAt?: number;
  replyOk?: boolean;
  stepCount?: number;
  schema?: number;
  finished: boolean;
  status?: RunRecord["status"];
  /** Total events published (monotonic; the backlog/record may hold fewer). */
  eventCount: number;
  storedEventCount?: number;
  truncated?: boolean;
  /** Present on persisted rows only. */
  diagnosis?: FrictionDiagnosis;
  bytes?: number;
  stop?: RunStopStatus;
  /** The run's latest one-line activity (`RunSummary.activity` live; `RunRecord.activity` persisted). */
  activity?: string;
  /** The thread that started the run (`RunMeta.sourceUrl` / `RunRecord.sourceUrl`). */
  sourceUrl?: string;
  /** Who started it, resolved (`RunMeta.userName` / `RunRecord.userName`). */
  userName?: string;
  /** The run that spawned this one (`RunMeta.parentRunId` / `RunRecord.parentRunId`,
   *  run-history item 46); absent on a run a person or a schedule started. */
  parentRunId?: string;
  /** The coordinator instance a child belongs to and the key its spawn carried
   *  (`RunMeta` / `LiveRunMeta` / `RunRecord`, run-history item 48) — live here,
   *  live on another generation, or persisted; absent on every other run. */
  parentInstanceId?: string;
  idempotencyKey?: string;
  /** The typed artifacts a finished run's record carries (run-history item 2) —
   *  the review's verdict and reviewed head, the fix round's dispositions, the
   *  coding child's handoff. Persisted rows only: a live view has none yet. */
  verdict?: RunRecord["verdict"];
  reviewHead?: string;
  dispositions?: RunRecord["dispositions"];
  handoff?: RunRecord["handoff"];
  /** True once the durable store holds this run (registry flag or store row). */
  persisted?: boolean;
  /** The generation driving this run when it is not this process (run-history
   *  item 41): a row read from the run ledger — live under another container,
   *  or reclaimed here and not yet launched. Absent on this process's rows. */
  ownerGen?: string;
}

/** `getRun`'s shape: the view plus, only with `include: "messages"`, the events. */
export interface RunRecordView extends RunView {
  events?: RunEvent[];
}

/** The run as the typed `Resource` the policy rows read (authorization.md
 *  item 3) — exactly its channel, user, repo and stamped visibility — for the
 *  point-read `authorize` every surface makes on a view (`runs.*`, the
 *  tokenless run page). A view without the stamp is `unknown`, never public. */
export function runResource(view: RunView): Resource {
  return {
    type: "run",
    id: view.id,
    channelId: view.channelId ?? "",
    userId: view.userId ?? "",
    ...(view.repo !== undefined ? { repo: view.repo } : {}),
    channelVisibility: view.channelVisibility ?? "unknown",
  };
}

export type RunListStatus = "active" | "finished" | "all";

export interface ListRunsOptions {
  status: RunListStatus;
  /** What the caller may see: `predicateFor(actor, "runs:read", "run")`. REQUIRED —
   *  a list never runs without a decision; `{ kind: "all" }` is an explicit choice
   *  the caller makes for an actor holding every channel. `none` touches nothing. */
  visibleTo: Predicate;
  agent?: string;
  /** Platform-namespaced channel id (`slack:C0123`) — a filter the caller asked for, ANDed with `visibleTo`. */
  channel?: string;
  /** Only runs finished (or, while live, started) at or after this epoch ms. */
  sinceMs?: number;
  /** Rows after the merge: default `RUN_LIST_DEFAULT_LIMIT`, capped at `RUN_LIST_MAX_LIMIT`. */
  limit?: number;
  /** Page cursor: the previous page's `nextBefore`. Only persisted runs ordered
   *  after it are returned — live rows all sort ahead of any cursor (they were
   *  on the first page), so they are omitted. */
  before?: number;
  beforeId?: string;
}

/** The store's list key for the last row of a full page: pass back as `before`/`beforeId`. */
export interface RunListCursor {
  finishedAt: number;
  id: string;
}

export interface ListRunsResult {
  runs: RunView[];
  /** Present when the page was full and ended on a persisted row: the cursor for the next page. */
  nextBefore?: RunListCursor;
  /** Set when the store threw: `runs` holds live rows only. Never set for `active`. */
  storeUnavailable?: true;
}

export interface RunEventsPageView {
  events: RunEvent[];
  /** Present while more events follow: pass back as `afterSeq`. */
  nextAfterSeq?: number;
}

export interface RunFrictionView {
  id: string;
  finished: boolean;
  diagnosis: FrictionDiagnosis;
}

export interface StopRunView {
  id: string;
  mode: StopMode;
  state: "stopping";
}

/** The registry capabilities handed to the live HTML/SSE path once the token
 *  checked out: the subscription, the backlog, and the token-gated stop (the
 *  page's Stop/Kill buttons stay capability-gated, not operator-gated). */
export interface LiveRunAccess {
  /** `RunRegistry.subscribe` with the id and token already bound: the resume
   *  cursor and the replay budget live in the options, the elided range on the
   *  result. */
  subscribe(opts: SubscribeOptions): Subscribed | null;
  snapshot(): RunSnapshot | null;
  requestStop(mode: StopMode): StopRequestResult;
}

export interface RunsService {
  listRuns(opts: ListRunsOptions): Promise<ListRunsResult>;
  /** The ledger's live rows this process does not hold, under the viewer's
   *  predicate (run-history item 41) — what the default index adds to the
   *  registry's rows. Empty without a ledger; a ledger that cannot be read is a
   *  warning and empty. */
  liveElsewhere(visibleTo: Predicate): Promise<RunView[]>;
  getRun(id: string, opts?: { include?: "messages" }): Promise<Result<RunRecordView>>;
  getRunEvents(id: string, opts: { afterSeq?: number; limit?: number }): Promise<Result<RunEventsPageView>>;
  getRunFriction(id: string): Promise<Result<RunFrictionView>>;
  stopRun(id: string, mode: StopMode, actor: RunActor): Promise<Result<StopRunView>>;
  /** Synchronous capability check for the live HTML/SSE routes: the
   *  registry subscription when `token` is right for a non-evicted run, else null. */
  authorizeLive(id: string, token: string): LiveRunAccess | null;
}

/** `getRunEvents` page bounds — the SERVICE page handed to a command surface
 *  (tighter than the store's `RUN_EVENTS_MAX_PAGE`): events per page and UTF-8
 *  bytes of event JSON. */
export const MAX_EVENTS_PAGE = 500;
export const MAX_EVENTS_PAGE_BYTES = 256 * 1024;

export interface RunsServiceDeps {
  registry: RunRegistry;
  /** null when run history is off (live-only). */
  store: RunStore | null;
  /** The friction analyzer for live runs; a persisted run returns its stored diagnosis. */
  analyze?: (events: readonly RunEvent[], opts: FrictionOptions) => FrictionDiagnosis;
  /** Where a store failure is reported (once per failing call, the error's
   *  message — never a token). Default `console.warn`. */
  warn?: (message: string) => void;
  /** The clock a live run's friction window ends at; `systemClock` by default. */
  clock?: () => number;
  /** The run ledger (run-history item 41): its live rows that are not in this
   *  process's registry list, read, page, diagnose and stop like any run. Null or
   *  absent when the ledger is off. */
  ledger?: Pick<RunLedger, "listLive" | "readEvents" | "requestStop"> | null;
}

/** A live row of the run ledger as a view (run-history item 41): the row's meta
 *  and start, the events the ledger holds for it, the generation driving it.
 *  Never a token — the page token is the other generation's. */
function ledgerView(row: LiveRunRow, events: readonly RunEvent[]): RunView {
  const m = row.meta;
  const activity = activityOfEvents(events);
  return {
    id: row.runId,
    ...(m.agent !== undefined ? { agent: m.agent } : {}),
    ...(m.model !== undefined ? { model: m.model } : {}),
    channelId: m.channelId,
    userId: m.userId,
    threadKey: m.threadKey,
    ...(m.channelVisibility !== undefined ? { channelVisibility: m.channelVisibility } : {}),
    ...(m.repo !== undefined ? { repo: m.repo } : {}),
    startedAt: row.startedAt,
    finished: false,
    eventCount: events.length,
    ...(activity !== undefined ? { activity } : {}),
    ...(m.sourceUrl !== undefined ? { sourceUrl: m.sourceUrl } : {}),
    ...(m.userName !== undefined ? { userName: m.userName } : {}),
    ...(m.parentRunId !== undefined ? { parentRunId: m.parentRunId } : {}),
    ...(m.parentInstanceId !== undefined ? { parentInstanceId: m.parentInstanceId } : {}),
    ...(m.idempotencyKey !== undefined ? { idempotencyKey: m.idempotencyKey } : {}),
    ...(row.stop ? { stop: { mode: row.stop, state: "stopping" as const } } : {}),
    schema: SPAN_SCHEMA, // a ledger run is a current runner's: spans carry its timing
    ownerGen: row.ownerGen,
  };
}

/** A live registry row without its token. A finished registry row carries the
 *  `finishedAt` and `status` the dispatcher handed to `finish()`; a live one has
 *  neither. Field-explicit on purpose: a spread would carry `token`. */
function liveView(s: RunSummary): RunView {
  return {
    id: s.id,
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.agent !== undefined ? { agent: s.agent } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.channelId !== undefined ? { channelId: s.channelId } : {}),
    ...(s.userId !== undefined ? { userId: s.userId } : {}),
    ...(s.threadKey !== undefined ? { threadKey: s.threadKey } : {}),
    ...(s.channelVisibility !== undefined ? { channelVisibility: s.channelVisibility } : {}),
    ...(s.repo !== undefined ? { repo: s.repo } : {}),
    startedAt: s.startedAt,
    finished: s.finished,
    ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
    ...(s.receivedAt !== undefined ? { receivedAt: s.receivedAt } : {}),
    ...(s.sealedAt !== undefined ? { sealedAt: s.sealedAt } : {}),
    ...(s.replyOk !== undefined ? { replyOk: s.replyOk } : {}),
    ...(s.stepCount !== undefined ? { stepCount: s.stepCount } : {}),
    ...(s.schema !== undefined ? { schema: s.schema } : {}),
    ...(s.status !== undefined ? { status: s.status } : {}),
    eventCount: s.eventCount,
    ...(s.stop ? { stop: s.stop } : {}),
    ...(s.activity !== undefined ? { activity: s.activity } : {}),
    ...(s.sourceUrl !== undefined ? { sourceUrl: s.sourceUrl } : {}),
    ...(s.userName !== undefined ? { userName: s.userName } : {}),
    ...(s.parentRunId !== undefined ? { parentRunId: s.parentRunId } : {}),
    ...(s.parentInstanceId !== undefined ? { parentInstanceId: s.parentInstanceId } : {}),
    ...(s.idempotencyKey !== undefined ? { idempotencyKey: s.idempotencyKey } : {}),
    ...(s.persisted ? { persisted: true } : {}),
  };
}

function persistedView(item: RunListItem): RunView {
  return { ...item, finished: true, persisted: true };
}

/** The merged list order — the store's own key, so a page is a true top-N of
 *  the union and `nextBefore` is a valid store cursor: unfinished rows first
 *  (newest started first), then `finishedAt` desc, then id desc. A finished
 *  registry row sorts by its real `finishedAt`, exactly where its record will. */
function newestFinished(a: RunView, b: RunView): number {
  if (a.finished !== b.finished) return a.finished ? 1 : -1;
  const ka = a.finished ? (a.finishedAt ?? a.startedAt) : a.startedAt;
  const kb = b.finished ? (b.finishedAt ?? b.startedAt) : b.startedAt;
  return kb - ka || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
}

const notFound = { ok: false, error: "not_found" } as const;
const conflict = { ok: false, error: "conflict" } as const;

/** Take events in order while under the count cap and the byte budget (always
 *  at least one), stamping `nextAfterSeq` when anything was left behind. */
function pageBounded(events: readonly RunEvent[], limit: number, moreAfter: boolean): RunEventsPageView {
  const cap = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(limit)));
  const page: RunEvent[] = [];
  let bytes = 0;
  for (const e of events) {
    const size = utf8ByteLength(JSON.stringify(e));
    if (page.length >= cap || (page.length > 0 && bytes + size > MAX_EVENTS_PAGE_BYTES)) break;
    page.push(e);
    bytes += size;
  }
  const out: RunEventsPageView = { events: page };
  // `publish` stamps `seq` on every event, so the last one is the cursor. If an
  // unstamped event ever ends a page, fall back to the newest stamped one: the
  // next page then re-delivers a few events rather than silently ending early.
  let last: number | undefined;
  for (let i = page.length - 1; i >= 0 && last === undefined; i--) last = page[i].seq;
  if (last !== undefined && (page.length < events.length || moreAfter)) out.nextAfterSeq = last;
  return out;
}

export function createRunsService(deps: RunsServiceDeps): RunsService {
  const { registry, store } = deps;
  const ledger = deps.ledger ?? null;
  const analyze = deps.analyze ?? ((events, opts) => analyzeRunFriction(events, opts));
  const clock = deps.clock ?? systemClock;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  /** The ledger's live rows, one listing per `LEDGER_LIST_TTL_MS` (item 41):
   *  a page view's three reads share it, and a history read of a finished run
   *  costs at most one ledger call. Concurrent callers share the in-flight
   *  promise; a failed listing is not kept. Null when the ledger is off. */
  let listing: { at: number; rows: Promise<LiveRunRow[]> } | undefined;
  const liveRows = (): Promise<LiveRunRow[]> | null => {
    if (!ledger) return null;
    const t = clock();
    if (listing && t - listing.at < LEDGER_LIST_TTL_MS) return listing.rows;
    const rows = ledger.listLive();
    listing = { at: t, rows };
    rows.catch(() => {
      if (listing?.rows === rows) listing = undefined;
    });
    return rows;
  };
  /** The ledger's live rows this process does not hold, as views (item 41). A
   *  ledger that cannot be read is one warning and no rows — the registry and
   *  the store still answer. The events are read in parallel, one call per row. */
  const ledgerLive = async (): Promise<RunView[]> => {
    const pending = liveRows();
    if (!pending) return [];
    let rows: LiveRunRow[];
    try {
      rows = await pending;
    } catch (err) {
      warn(`[runs] run ledger list failed — showing this process's runs only: ${describe(err)}`);
      return [];
    }
    const foreign = rows.filter((row) => !registry.getById(row.runId)); // ours: the registry row is the truth
    return Promise.all(
      foreign.map(async (row) => {
        let events: RunEvent[] = [];
        try {
          events = await ledger!.readEvents(row.runId);
        } catch (err) {
          warn(`[runs] run ledger events read failed for ${row.runId}: ${describe(err)}`);
        }
        return ledgerView(row, events);
      }),
    );
  };
  /** One ledger row by id, with its events; null when the ledger is off, the id
   *  is malformed, the row is not live, or the ledger cannot be read (a warning). */
  const ledgerRow = async (id: string): Promise<{ row: LiveRunRow; events: RunEvent[] } | null> => {
    const pending = RUN_ID_PATTERN.test(id) ? liveRows() : null;
    if (!pending) return null;
    try {
      const row = (await pending).find((r) => r.runId === id);
      if (!row) return null;
      return { row, events: await ledger!.readEvents(id) };
    } catch (err) {
      warn(`[runs] run ledger read failed for ${id}: ${describe(err)}`);
      return null;
    }
  };

  /** `store.get` with the id pre-checked (a malformed id never reaches the store). */
  const storeGet = async (id: string): Promise<RunRecord | null> => {
    if (!store || !RUN_ID_PATTERN.test(id)) return null;
    return store.get(id);
  };
  /** The summary-only read (`store.getSummary`), same id pre-check. */
  const storeSummary = async (id: string): Promise<RunListItem | null> => {
    if (!store || !RUN_ID_PATTERN.test(id)) return null;
    return store.getSummary(id);
  };

  return {
    async listRuns(opts) {
      const limit = clampListLimit(opts.limit);
      // `none` is decided here, once: no live row qualifies and the store is not asked.
      if (opts.visibleTo.kind === "none") return { runs: [] };
      const matches = (r: RunView): boolean =>
        matchesPredicate(opts.visibleTo, r) &&
        (opts.agent === undefined || r.agent === opts.agent) &&
        (opts.channel === undefined || r.channelId === opts.channel) &&
        (opts.sinceMs === undefined || (r.finishedAt ?? r.startedAt) >= opts.sinceMs);
      const paging = opts.before !== undefined;
      const live = paging
        ? [] // every live row sorts ahead of any cursor: they were all on the first page
        : registry
            .listActive()
            .filter((s) => (opts.status === "active" ? !s.finished : opts.status === "finished" ? s.finished : true))
            .map(liveView)
            .filter(matches);
      // The ledger's live rows this process does not hold (item 41): runs live
      // under another generation, or reclaimed here and not yet launched. Listed
      // as live rows — never on a cursor page (live rows all sort ahead of any
      // cursor), never under `finished` — and, whatever was asked, the ids whose
      // store row (a tombstone) must not surface.
      const ledgerRows = await ledgerLive();
      const elsewhere = paging || opts.status === "finished" ? [] : ledgerRows.filter(matches);
      const liveRows = [...live, ...elsewhere];
      if (opts.status === "active") return { runs: liveRows.slice(0, limit) };

      const byId = new Map<string, RunView>();
      let storeUnavailable = false;
      // Every unfinished registry run, whatever `status`/page was asked for: a
      // store row for one of these is its provisional `interrupted` tombstone
      // — the truth only if the run dies — and must never surface while
      // the run is demonstrably alive.
      const unfinished = new Set([
        ...registry
          .listActive()
          .filter((s) => !s.finished)
          .map((s) => s.id),
        // …and a run the ledger holds live (item 41): its store row is the same
        // tombstone, the truth only once the run is dead.
        ...ledgerRows.map((r) => r.id),
      ]);
      if (store) {
        try {
          const rows = await store.list({
            limit: Math.min(RUN_LIST_MAX_LIMIT, limit + live.length),
            // The policy rides down as the store's own filter: `all` is no
            // constraint and is omitted so the store's query is unchanged for it.
            ...(opts.visibleTo.kind !== "all" ? { visibleTo: toVisibilityFilter(opts.visibleTo) } : {}),
            ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
            ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
            ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}),
            ...(opts.before !== undefined ? { before: opts.before } : {}),
            ...(opts.beforeId !== undefined ? { beforeId: opts.beforeId } : {}),
          });
          for (const row of rows) if (!unfinished.has(row.id)) byId.set(row.id, persistedView(row));
        } catch (err) {
          // Degrade to live rows — never a whole-command failure — but say so
          // in the log: the message only (a store error names a route or an
          // HTTP status, never a token), once per failing call.
          storeUnavailable = true;
          warn(
            `[runs] history store list failed — showing live runs only: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // A FINISHED live row wins on every field it carries (the final stop
      // state, the registry's own persisted flag) EXCEPT the finish fields: the
      // store row is the same run, already finished, and the record is the
      // source of truth for `finishedAt`/`status` (a reply that threw after the
      // loop is `failed` in the record while the registry row still says
      // `completed`). It also contributes what only the record knows —
      // `diagnosis`, `bytes` — so a run in both lists as one complete row.
      // An UNFINISHED live row wins whole (its store row — the provisional
      // tombstone, already dropped above — says `interrupted`, which is the
      // truth only once the run is dead; a live run must list as live).
      for (const row of liveRows) {
        const stored = byId.get(row.id);
        if (!row.finished || !stored) {
          byId.set(row.id, row);
          continue;
        }
        byId.set(row.id, {
          ...stored,
          ...row,
          ...(stored.finishedAt !== undefined ? { finishedAt: stored.finishedAt } : {}),
          ...(stored.status !== undefined ? { status: stored.status } : {}),
        });
      }
      const runs = [...byId.values()].sort(newestFinished).slice(0, limit);
      const out: ListRunsResult = { runs };
      // A full page ending on a persisted row has a next page to ask for; a
      // page of live rows only, or a short page, is the end of the list.
      const last = runs.at(-1);
      if (runs.length === limit && last?.finishedAt !== undefined)
        out.nextBefore = { finishedAt: last.finishedAt, id: last.id };
      if (storeUnavailable) out.storeUnavailable = true;
      return out;
    },

    async liveElsewhere(visibleTo) {
      if (visibleTo.kind === "none") return [];
      return (await ledgerLive()).filter((r) => matchesPredicate(visibleTo, r));
    },

    async getRun(id, opts = {}) {
      const summary = registry.getById(id);
      const snap = summary ? registry.snapshotById(id) : null;
      if (summary && snap) {
        const view: RunRecordView = liveView(summary);
        if (opts.include === "messages") view.events = snap.events;
        return { ok: true, value: view };
      }
      // Live on the ledger, not here (item 41): the row and the events it holds.
      const far = await ledgerRow(id);
      if (far) {
        const view: RunRecordView = ledgerView(far.row, far.events);
        if (opts.include === "messages") view.events = far.events;
        return { ok: true, value: view };
      }
      // Only a `messages` read loads the events; every other caller gets the
      // summary row (the record minus events), so a 5000-event run is never
      // read whole to answer "what is this run".
      if (opts.include !== "messages") {
        const summary = await storeSummary(id);
        return summary ? { ok: true, value: persistedView(summary) } : notFound;
      }
      const record = await storeGet(id);
      if (!record) return notFound;
      const { events, ...rest } = record;
      const view: RunRecordView = persistedView(rest);
      view.events = events;
      return { ok: true, value: view };
    },

    async getRunEvents(id, opts) {
      const afterSeq = Math.max(0, Math.floor(opts.afterSeq ?? 0));
      const limit = opts.limit ?? MAX_EVENTS_PAGE;
      const snap = registry.snapshotById(id);
      if (snap) {
        return {
          ok: true,
          value: pageBounded(
            snap.events.filter((e) => (e.seq ?? 0) > afterSeq),
            limit,
            false,
          ),
        };
      }
      const cap = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(limit)));
      const far = await ledgerRow(id);
      if (far) {
        return {
          ok: true,
          value: pageBounded(
            far.events.filter((e) => (e.seq ?? 0) > afterSeq),
            cap,
            false,
          ),
        };
      }
      if (!store || !RUN_ID_PATTERN.test(id)) return notFound;
      // The store answers an unknown, expired, or malformed id with null (the
      // same not-found `get` gives); an existing run with nothing past
      // `afterSeq` is an empty page and stays `ok`.
      const page = await store.events(id, { afterSeq, limit: cap });
      if (!page) return notFound;
      return { ok: true, value: pageBounded(page.events, cap, page.nextAfterSeq !== undefined) };
    },

    async getRunFriction(id) {
      const snap = registry.snapshotById(id);
      if (snap)
        return {
          ok: true,
          value: {
            id,
            finished: snap.finished,
            // The window is the run's own stamps, to now while live
            // (docs/reference/specs/tracing.md) — the same window the live route
            // passes, so the two surfaces time a run alike; a finished run's
            // diagnosis carries the shape.
            diagnosis: analyze(snap.events, {
              finished: snap.finished,
              truncated: snap.truncated,
              window: { start: snap.receivedAt ?? snap.startedAt, end: snap.finishedAt ?? clock() },
            }),
          },
        };
      const far = await ledgerRow(id);
      if (far) return { ok: true, value: { id, finished: false, diagnosis: analyze(far.events, { finished: false }) } };
      // The stored diagnosis rides on the summary row — the events are not needed.
      const summary = await storeSummary(id);
      if (!summary) return notFound;
      return { ok: true, value: { id, finished: true, diagnosis: summary.diagnosis } };
    },

    async stopRun(id, mode, actor) {
      const res = registry.requestStopById(id, mode, actor);
      if (res.ok) return { ok: true, value: { id, mode: res.mode, state: "stopping" } };
      if (res.reason === "finished") return conflict;
      // Live on the ledger under another generation (item 41): the stop rides the
      // row; the owner reads it on its next heartbeat.
      if (ledger && RUN_ID_PATTERN.test(id)) {
        try {
          const r = await ledger.requestStop(id, mode);
          if (r.ok) return { ok: true, value: { id, mode, state: "stopping" } };
        } catch (err) {
          warn(`[runs] run ledger stop failed for ${id}: ${describe(err)}`);
        }
      }
      // Not in the registry: a persisted run is over (409), anything else is unknown.
      return (await storeSummary(id)) ? conflict : notFound;
    },

    authorizeLive(id, token) {
      if (!registry.has(id, token)) return null;
      return {
        subscribe: (opts) => registry.subscribe(id, token, opts),
        snapshot: () => registry.snapshot(id, token),
        requestStop: (mode) => registry.requestStop(id, token, mode),
      };
    },
  };
}
