import type { RunActor, RunEvent, StopMode } from "./runEvents.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "./runFriction.js";
import { clampListLimit, RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT, utf8ByteLength, type RunListItem, type RunRecord } from "./runRecord.js";
import type { RunRegistry, RunSnapshot, RunStopStatus, RunSubscriber, RunFinishListener, RunSummary, StopRequestResult, Unsubscribe } from "./runRegistry.js";
import type { RunStore } from "./runStore.js";

// Run history (#157, U5): the ONE service behind every `runs.*` command — list,
// get, events, friction, stop — and the live view's authorization. It owns the
// read merge between the in-memory registry (live runs, plus finished ones for
// the 60 s TTL) and the durable `RunStore` (finished runs for the retention
// window), and it is the boundary where the registry's capability token stops:
// nothing this module returns carries `token` (KTD7 — `RunSummary` never leaves
// the core). Who may call is decided one layer up (the command registry's scopes
// and chat gates, the Cloudflare Access gate); this service assumes an
// authorized caller, except `authorizeLive`, which IS the token check for the
// live SSE/HTML path (KTD6) and is synchronous so that path stays byte-identical.

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
  repo?: string;
  startedAt: number;
  /** Absent while the run is live. */
  finishedAt?: number;
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
  /** True once the durable store holds this run (registry flag or store row). */
  persisted?: boolean;
}

/** `getRun`'s shape: the view plus, only with `include: "messages"`, the events. */
export interface RunRecordView extends RunView {
  events?: RunEvent[];
}

export type RunListStatus = "active" | "finished" | "all";

export interface ListRunsOptions {
  status: RunListStatus;
  agent?: string;
  /** Platform-namespaced channel id (`slack:C0123`). */
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
 *  checked out: the subscription, the backlog, and the token-gated stop (U8 —
 *  the page's Stop/Kill buttons stay capability-gated, not operator-gated). */
export interface LiveRunAccess {
  /** `afterSeq` is the resume cursor (`Last-Event-ID`): only events after it are offered. */
  subscribe(onEvent: RunSubscriber, onFinish?: RunFinishListener, afterSeq?: number): Unsubscribe | null;
  snapshot(): RunSnapshot | null;
  requestStop(mode: StopMode): StopRequestResult;
}

export interface RunsService {
  listRuns(opts: ListRunsOptions): Promise<ListRunsResult>;
  getRun(id: string, opts?: { include?: "messages" }): Promise<Result<RunRecordView>>;
  getRunEvents(id: string, opts: { afterSeq?: number; limit?: number }): Promise<Result<RunEventsPageView>>;
  getRunFriction(id: string): Promise<Result<RunFrictionView>>;
  stopRun(id: string, mode: StopMode, actor: RunActor): Promise<Result<StopRunView>>;
  /** Synchronous capability check for the live HTML/SSE routes (KTD6): the
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
  analyze?: (events: readonly RunEvent[], opts: { finished: boolean; truncated?: boolean }) => FrictionDiagnosis;
  /** Where a store failure is reported (once per failing call, the error's
   *  message — never a token). Default `console.warn`. */
  warn?: (message: string) => void;
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
    ...(s.repo !== undefined ? { repo: s.repo } : {}),
    startedAt: s.startedAt,
    finished: s.finished,
    ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
    ...(s.status !== undefined ? { status: s.status } : {}),
    eventCount: s.eventCount,
    ...(s.stop ? { stop: s.stop } : {}),
    ...(s.activity !== undefined ? { activity: s.activity } : {}),
    ...(s.sourceUrl !== undefined ? { sourceUrl: s.sourceUrl } : {}),
    ...(s.userName !== undefined ? { userName: s.userName } : {}),
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
  const analyze = deps.analyze ?? ((events, opts) => analyzeRunFriction(events, opts));
  const warn = deps.warn ?? ((m: string) => console.warn(m));

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
      const matches = (r: RunView): boolean =>
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
      if (opts.status === "active") return { runs: live.slice(0, limit) };

      const byId = new Map<string, RunView>();
      let storeUnavailable = false;
      // Every unfinished registry run, whatever `status`/page was asked for: a
      // store row for one of these is its provisional `interrupted` tombstone
      // (#375) — the truth only if the run dies — and must never surface while
      // the run is demonstrably alive.
      const unfinished = new Set(
        registry
          .listActive()
          .filter((s) => !s.finished)
          .map((s) => s.id),
      );
      if (store) {
        try {
          const rows = await store.list({
            limit: Math.min(RUN_LIST_MAX_LIMIT, limit + live.length),
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
          warn(`[runs] history store list failed — showing live runs only: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // A FINISHED live row wins on every field it carries (the final stop
      // state, the registry's own persisted flag) EXCEPT the finish fields: the
      // store row is the same run, already finished, and the record is the
      // source of truth for `finishedAt`/`status` (a reply that threw after the
      // loop is `failed` in the record while the registry row still says
      // `completed`). It also contributes what only the record knows —
      // `diagnosis`, `bytes` — so a run in both lists as one complete row (U8).
      // An UNFINISHED live row wins whole (its store row — the provisional
      // tombstone, already dropped above — says `interrupted`, which is the
      // truth only once the run is dead; a live run must list as live, #375).
      for (const row of live) {
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
      if (runs.length === limit && last?.finishedAt !== undefined) out.nextBefore = { finishedAt: last.finishedAt, id: last.id };
      if (storeUnavailable) out.storeUnavailable = true;
      return out;
    },

    async getRun(id, opts = {}) {
      const summary = registry.getById(id);
      const snap = summary ? registry.snapshotById(id) : null;
      if (summary && snap) {
        const view: RunRecordView = liveView(summary);
        if (opts.include === "messages") view.events = snap.events;
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
        return { ok: true, value: pageBounded(snap.events.filter((e) => (e.seq ?? 0) > afterSeq), limit, false) };
      }
      if (!store || !RUN_ID_PATTERN.test(id)) return notFound;
      const cap = Math.min(MAX_EVENTS_PAGE, Math.max(1, Math.floor(limit)));
      // The store answers an unknown, expired, or malformed id with null (the
      // same not-found `get` gives, R4); an existing run with nothing past
      // `afterSeq` is an empty page and stays `ok`.
      const page = await store.events(id, { afterSeq, limit: cap });
      if (!page) return notFound;
      return { ok: true, value: pageBounded(page.events, cap, page.nextAfterSeq !== undefined) };
    },

    async getRunFriction(id) {
      const snap = registry.snapshotById(id);
      if (snap) return { ok: true, value: { id, finished: snap.finished, diagnosis: analyze(snap.events, { finished: snap.finished, truncated: snap.truncated }) } };
      // The stored diagnosis rides on the summary row — the events are not needed.
      const summary = await storeSummary(id);
      if (!summary) return notFound;
      return { ok: true, value: { id, finished: true, diagnosis: summary.diagnosis } };
    },

    async stopRun(id, mode, actor) {
      const res = registry.requestStopById(id, mode, actor);
      if (res.ok) return { ok: true, value: { id, mode: res.mode, state: "stopping" } };
      if (res.reason === "finished") return conflict;
      // Not in the registry: a persisted run is over (409), anything else is unknown.
      return (await storeSummary(id)) ? conflict : notFound;
    },

    authorizeLive(id, token) {
      if (!registry.has(id, token)) return null;
      return {
        subscribe: (onEvent, onFinish, afterSeq) => registry.subscribe(id, token, onEvent, onFinish, afterSeq),
        snapshot: () => registry.snapshot(id, token),
        requestStop: (mode) => registry.requestStop(id, token, mode),
      };
    },
  };
}
