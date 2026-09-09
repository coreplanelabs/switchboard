import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { runDurationMs } from "../core/runDuration.js";
import { normalizeSpans, SPAN_SCHEMA } from "../core/normalizeSpans.js";
import {
  authorize,
  matchesPredicate,
  predicateFor,
  type Actor,
  type Decision,
  type Predicate,
  type Resource,
} from "../core/authz/index.js";
import type { StopMode } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRegistry } from "../core/runRegistry.js";
import type { IndexSubscriber } from "../core/runRegistry/indexFeed.js";
import type { RunSummary } from "../core/runRegistry/projections.js";
import type { Unsubscribe } from "../core/runRegistry/state.js";
import { runResource, type RunListCursor, type RunsService, type RunView } from "../core/runsService.js";
import type { ScheduleDef } from "../core/schedules.js";
import type { ScheduleStore } from "../core/scheduleStore.js";
import { STORE_UNAVAILABLE_BANNER } from "../core/commandRegistry.js";
import { buildScheduledRows, type FiringsState } from "./scheduledPanel.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";
import type { RunIndexRowSeed, RunsIndexSeed, ScheduledSeed } from "./webSeed.js";
export { FAVICON_ICO_SVG, FAVICON_IDLE, FAVICON_LIVE, faviconSvg } from "./favicon.js";
import {
  nodeSseSink,
  parseLastEventId,
  serveEvents,
  serveHistoryEvents,
  serveIndexEvents,
  startSseHeartbeat,
  withOmittedMarkers,
} from "./liveView/sse.js";

/** One index row, whatever its source: a live registry row (which carries the
 *  capability `token`) or a finished/persisted `RunView` (no token). The seed
 *  type in webSeed.ts is the same shape — one alias so handler code reads
 *  naturally. */
export type IndexRow = RunIndexRowSeed;

// Live-view channel: the external, browser-facing surface for a live agent run.
// It streams the SAME redacted RunEvents the in-channel status
// card consumes, over Server-Sent Events, to a minimal self-contained page.
//
// Auth for a LIVE run is a per-run CAPABILITY TOKEN, not a bearer header: a
// plain browser navigation can't send an Authorization header, so the token
// rides in the URL (`/runs/:id?t=…`) and is validated (constant-time) by the
// registry — via `RunsService.authorizeLive` — for the page, the event stream
// and the stop control. A wrong/missing token on a live run — or an unknown run
// — is a 404 (never reveal existence). A FINISHED run (still in the registry, or
// persisted in the run store) is served tokenless in history mode to the
// Access-authenticated viewer, through the same page renderer — and only when
// the policy table lets that viewer's ACTOR read it (docs/reference/specs/authorization.md
// items 5–7): index.ts resolves the Access identity with the same
// `accessActor` the `/api/*` adapter uses and hands it in as `ctx.actor`; the
// index lists through `predicateFor(actor, "runs:read", "run")`, a tokenless
// read is `authorize`d against the run's own attributes, and a deny renders
// exactly like an unknown id (the reason reaches the audit line only).
// Events are already redacted + capped upstream (runEvents.ts); this layer adds
// no data and re-exposes nothing.
//
// SSE (not WebSocket) because the flow is strictly one-directional server→page,
// EventSource auto-reconnects, and it needs no handshake or extra dependency.
//
// Handlers are split from transport so the logic is unit-testable without a
// socket: `parseRunRoute` (pure), the seed builders (pure data), and
// `serveEvents` (drives an abstract SseSink). `createLiveViewHandler` is the
// thin node:http wrapper.
//
// RENDERING lives in the web app (web/): every HTML route serves the shared
// shell (webShell.ts) with this page's seed (webSeed.ts) embedded; the Vue
// pages paint it and open the SSE routes here. This file is the router and
// the seed source; the transport lives in ./liveView/sse.ts, re-exported so
// every importer keeps one entry point.

export * from "./liveView/html.js";
export * from "./liveView/sse.js";
export { retentionSentence } from "./webSeed.js";

/** Which live-view route a path is, if any. The bare `/runs` index carries no
 *  id (it is Access-gated, not token-gated); the per-run routes do. `stop` is
 *  the one WRITE route (`POST /runs/:id/stop`). */
export type RunRoute =
  { kind: "index" } | { kind: "scheduled" } | { id: string; kind: "page" | "events" | "friction" | "stop" };

/** Match the bare index (`/runs`, `/runs/`), the Scheduled tab
 *  (`/runs/scheduled`, item 18 — a reserved path word, never a run id: ids are
 *  UUIDs), a per-run page (`/runs/:id`), a per-run SSE stream
 *  (`/runs/:id/events`), a per-run friction diagnosis (`/runs/:id/friction`), or
 *  the per-run stop control (`/runs/:id/stop`). Path only — the token is a query
 *  param, read separately. Returns null for anything else so the server can fall
 *  through to its other routes. */
export function parseRunRoute(pathname: string): RunRoute | null {
  if (pathname === "/runs" || pathname === "/runs/") return { kind: "index" };
  if (pathname === "/runs/scheduled" || pathname === "/runs/scheduled/") return { kind: "scheduled" };
  const m = /^\/runs\/([^/]+)(?:\/(events|friction|stop))?\/?$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding → not a valid run route
  }
  if (id === "") return null;
  const sub = m[2];
  return { id, kind: sub === "events" || sub === "friction" || sub === "stop" ? sub : "page" };
}

/** Parse the `?mode=` of a stop request; anything but the two modes is null
 *  (→ 400). Never trust the query to name the mode for us. */
export function parseStopMode(raw: string | null): StopMode | null {
  return raw === "soft" || raw === "hard" ? raw : null;
}

/** The tokenless routes that read a finished run. */
export type HistoryReadRoute = "page" | "events" | "friction" | "stop";

/** One audit line per tokenless read of a finished run. An allowed
 *  page/events read says who read which run on which route — never any
 *  content. A read the table refused says who was refused on which route and
 *  why (`authorize`'s reason: the audit line's, never the reply's) — and
 *  never which run, so the log reveals no more existence than the 404 does
 *  (the same shape `runs.*` logs). */
export type HistoryReadAudit =
  | { route: "page" | "events"; runId: string; identity: string }
  | { route: HistoryReadRoute; identity: string; denied: string };

export interface LiveViewDeps {
  /** The bound web-app shell (webShell.ts): title + seed → the HTML document. */
  shell: ShellRenderer;
  /** Every run read and the tokenless stop go through the service. */
  service: RunsService;
  /** The registry's index face: the live rows (with tokens, for their hrefs) and
   *  the live feed. The default `/runs` view is this plus the service's rows live
   *  elsewhere (run-history item 41); never the store. */
  index: Pick<RunRegistry, "listActive" | "subscribeIndex">;
  /** The configured run-history retention, for the index toggle's tooltip; null
   *  when history is off (store: null). */
  retention: { retentionDays: number } | null;
  /** Receives one entry per allowed page/events history read and per refused
   *  tokenless read. Default: console.log. */
  audit?: (entry: HistoryReadAudit) => void;
  /** The "Scheduled" panel on the index: the schedule registry to list
   *  and, optionally, the store holding each schedule's firings. Absent → no
   *  panel (tests, the CLI). */
  scheduled?: {
    schedules: readonly ScheduleDef[];
    /** undefined → the panel says firing history is unavailable. */
    store?: ScheduleStore;
  };
  /** Injectable clock for the panel's "next fire" / relative times. */
  now?: () => number;
  /** Rows per `?all=1` page. Default `INDEX_PAGE_SIZE` — a full page renders an
   *  "Older runs" link carrying the service's cursor; a cursor page a "Newest runs" link. */
  indexPageSize?: number;
}

/** Completed runs per `?all=1` page (item 20): a screen's worth, paged by the
 *  service cursor — never the service's 200-row cap in one scroll. */
export const INDEX_PAGE_SIZE = 25;

/** The `?all=1` page cursor from the query (`before=<finishedAt>&beforeId=<id>`),
 *  or undefined for the first page — a malformed pair is ignored, never a 400. */
export function parseIndexCursor(params: URLSearchParams): { before: number; beforeId: string } | undefined {
  const before = Number(params.get("before"));
  const beforeId = params.get("beforeId") ?? "";
  if (!params.has("before") || !Number.isFinite(before) || before <= 0 || beforeId === "") return undefined;
  return { before, beforeId };
}

/** The `?all=1` href for the page after a full one. */
export function olderRunsHref(cursor: RunListCursor): string {
  return `/runs?all=1&before=${cursor.finishedAt}&beforeId=${encodeURIComponent(cursor.id)}`;
}

/** Per-request context the server passes in after the Access gate: the viewer
 *  as the `Actor` the policy table decides on — the verified Access identity
 *  resolved by `accessActor` (commandHttp.ts), the one resolver for every
 *  surface the gate fronts. The handler makes no decision of its own: it asks
 *  `authorize` / `predicateFor` with this actor (authorization.md item 1). */
export interface LiveViewContext {
  actor: Actor;
}

/** The command rows the `/api` twins of these routes are admitted by first
 *  (`runs.list` for the index, `runs.get` for a run read): the actor must hold
 *  `runs:read` at all before any run row is consulted, so the HTML surface is
 *  never wider than `/api/runs.*` for the same identity. */
const RUNS_LIST: Resource = { type: "command", id: "runs.list" };
const RUNS_GET: Resource = { type: "command", id: "runs.get" };
const RUNS_STOP: Resource = { type: "command", id: "runs.stop" };
const NONE: Predicate = { kind: "none" };

/** What the viewer may list (authorization.md item 6): nothing unless the actor
 *  is admitted to run reads, else the store predicate over its channels. */
function readableRuns(actor: Actor): Predicate {
  return authorize(actor, "runs:read", RUNS_LIST).allow ? predicateFor(actor, "runs:read", "run") : NONE;
}

/** The table's decision on ONE finished run the viewer asked for tokenless
 *  (authorization.md item 5): admitted to run reads, and allowed this run by
 *  its own attributes — channel, user, stamped visibility. */
function readDecision(actor: Actor, view: RunView): Decision {
  const admitted = authorize(actor, "runs:read", RUNS_GET);
  return admitted.allow ? authorize(actor, "runs:read", runResource(view)) : admitted;
}

/** The tokenless stop is a WRITE: the same two questions `runs.stop` asks on the
 *  command surface (authorization.md item 5) — admitted to `runs:write` at all,
 *  and allowed to write THIS run by its attributes. A viewer who may read the
 *  run but not stop it gets the read routes' 404, never a 409 that tells them
 *  the run exists and is over. The capability-token stop is unchanged: the
 *  token IS the capability (live-view item 10). */
function stopDecision(actor: Actor, view: RunView): Decision {
  const admitted = authorize(actor, "runs:write", RUNS_STOP);
  return admitted.allow ? authorize(actor, "runs:write", runResource(view)) : admitted;
}

/**
 * The runs-index feed as ONE viewer may see it: an `upsert` for a run outside
 * the predicate is dropped, and so is that run's later `removed` — the page
 * never learns the id of a run it was not shown. Every live run is stamped at
 * `create()`, so one decision per run holds for its whole life; `shown` is
 * bounded by the registry's live set (an id leaves it with its `removed`).
 */
export function visibleIndexFeed(
  subscribeIndex: (onEvent: IndexSubscriber) => Unsubscribe,
  visibleTo: Predicate,
): (onEvent: IndexSubscriber) => Unsubscribe {
  return (onEvent) => {
    const shown = new Set<string>();
    return subscribeIndex((ev) => {
      if (ev.type === "upsert") {
        if (!matchesPredicate(visibleTo, ev.run)) return;
        shown.add(ev.run.id);
      } else if (!shown.delete(ev.id)) return;
      onEvent(ev);
    });
  };
}

const NOT_FOUND = "run not found";
const TEXT = { "content-type": "text/plain; charset=utf-8" };
const JSON_NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/**
 * node:http handler for the live-view routes. Returns `true` if it owned the
 * request (so the server stops routing), `false` to fall through. Every read
 * route is GET-only and the one write route is POST-only (405 otherwise):
 *   GET  /runs                 → the runs index HTML page: active runs (Access-gated, NOT token-gated)
 *   GET  /runs?all=1           → the index with finished + persisted runs too
 *   GET  /runs?stream=1[&all=1] → the live runs-index SSE feed
 *   GET  /runs/:id[?t=…]       → the HTML page: a valid token → the live page; no/wrong token →
 *        history mode for a finished or persisted run (tokenless, Access-gated), 404 for a live run
 *   GET  /runs/:id/events[?t=…] → the SSE stream: live with a token; the stored replay + `end` otherwise
 *   GET  /runs/:id/friction[?t=…] → the friction diagnosis JSON (live diagnosis-so-far, or the stored one)
 *   POST /runs/:id/stop?t=…&mode=soft|hard → ask the run to stop: 200 JSON, 400 bad
 *        mode, 404 bad/missing token on a live run or unknown run, 409 finished/persisted
 * The live routes are token-gated via the registry (`authorizeLive`, synchronous
 * — never a store read) and ignore the viewer's actor: the token IS the capability
 * (docs/decisions/0013-capability-tokens-for-live-run-pages.md). The
 * tokenless history routes and the index are Access-gated at the edge (index.ts
 * gates every method under /runs*) AND bound to the viewer's actor (`ctx.actor`):
 * the index — default live rows, `?all=1`, the `?stream=1` feed, the Scheduled
 * tab's live links — lists what `readableRuns` allows, and a tokenless read of
 * a finished run is `readDecision`-ed on the run's own attributes; a deny is
 * the same 404 an unknown id gets, on every route, and the 409 a tokenless stop
 * gives a finished run is withheld the same way. Unknown, expired, denied and
 * wrong-token-on-live lookups share one 404 body. `?stream=1` (a query
 * flag, not a new path) selects the feed so it never collides with `/runs/<id>`
 * where an id could legitimately be "events" or "stream".
 */
/** Firing history for the panel: the store's answer, or the reason there is
 *  none — a store failure is shown as such, never as "never fired". */
const NO_STORE_REASON = "schedules.worker is not configured";

async function loadFirings(store: ScheduleStore): Promise<FiringsState> {
  try {
    return { ok: true, firings: await store.latest() };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function createLiveViewHandler(
  deps: LiveViewDeps,
): (req: HttpRequest, res: ServerResponse, ctx: LiveViewContext) => boolean {
  const { service, index } = deps;
  const audit = deps.audit ?? ((entry) => console.log(`[runs] history read ${JSON.stringify(entry)}`));
  /** True when the table lets `actor` read this finished run tokenless; a deny
   *  is audited here (route, actor, reason — never the run) and the caller
   *  renders it exactly as an unknown id. */
  const readable = (actor: Actor, view: RunView, route: HistoryReadRoute): boolean => {
    const decision = route === "stop" ? stopDecision(actor, view) : readDecision(actor, view);
    if (!decision.allow) audit({ route, identity: actor.id, denied: decision.reason });
    return decision.allow;
  };
  const text = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, TEXT);
    res.end(body);
  };
  /** Runs the async history path; a throw is a 500, never an unhandled rejection. */
  const run = (res: ServerResponse, work: () => Promise<void>) => {
    work().catch((err: unknown) => {
      console.error(`[runs] ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) text(res, 500, "internal error");
      else res.end();
    });
  };

  const now = deps.now ?? Date.now;
  const pageSize = deps.indexPageSize ?? INDEX_PAGE_SIZE;
  /** One rendered index page: the rows, the store-degraded flag, the "Older runs" href and whether a cursor got us here. */
  interface IndexPage {
    rows: readonly IndexRow[];
    storeUnavailable?: boolean;
    olderHref?: string;
    olderThan?: number;
  }
  /** `?all=1`: one full page of the service's live ∪ finished ∪ persisted rows
   *  the viewer may see (the service's cap, never its 50-row default), with the
   *  live rows' capability tokens re-attached for their hrefs (finished rows
   *  stay tokenless), plus the "Older runs" href when the page was full. */
  const mergedRows = async (
    live: readonly RunSummary[],
    visibleTo: Predicate,
    cursor?: { before: number; beforeId: string },
  ): Promise<IndexPage> => {
    const tokens = new Map(live.map((s) => [s.id, s.token]));
    // The viewer's predicate is the store's own filter: the service hands
    // it down and nothing is loaded to be dropped afterwards.
    const { runs, nextBefore, storeUnavailable } = await service.listRuns({
      status: "all",
      visibleTo,
      limit: pageSize,
      ...(cursor ?? {}),
    });
    // A cursor page holds finished runs only — the service leaves the live rows
    // off it (they all sort ahead of any cursor), so the page is a full page.
    // Only an UNFINISHED row gets its capability token: the seed is data
    // the page ships verbatim, and a finished row must never carry one — the
    // registry may still hold a token for a recently finished run.
    const rows = runs.map((v) => {
      const token = v.finished ? undefined : tokens.get(v.id);
      return token === undefined ? v : { ...v, token };
    });
    // The service degraded to live rows: the page says so (a banner), never a silently short list.
    return {
      rows,
      ...(storeUnavailable ? { storeUnavailable: true } : {}),
      ...(nextBefore ? { olderHref: olderRunsHref(nextBefore) } : {}),
      ...(cursor ? { olderThan: cursor.before } : {}),
    };
  };

  return (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseRunRoute(url.pathname);
    if (!route) return false;

    const method = (req.method ?? "GET").toUpperCase();
    const allow = route.kind === "stop" ? "POST" : "GET";
    if (method !== allow) {
      res.writeHead(405, { ...TEXT, allow });
      res.end("method not allowed");
      return true;
    }

    // The index has NO token gate — Cloudflare Access is the "who" gate in front
    // of it. It renders the per-run capability links, so it must only be exposed
    // behind Access (see docs/reference/specs/live-view.md) — and it renders them only for
    // the runs the viewer's actor may read: the default live rows, the `?all=1`
    // page and the `?stream=1` feed all go through the ONE predicate, so a
    // capability link for a run the viewer may not read never reaches the page.
    // The default view is the live registry only (never a store read);
    // `?all=1` merges the service's finished + persisted rows in, keeping the
    // live rows' token hrefs.
    if (route.kind === "index") {
      const all = url.searchParams.get("all") === "1";
      const visibleTo = readableRuns(ctx.actor);
      if (url.searchParams.get("stream") === "1") {
        serveIndexEvents(
          visibleIndexFeed((onEvent) => index.subscribeIndex(onEvent), visibleTo),
          nodeSseSink(req, res),
          () => startSseHeartbeat(req, res),
        );
        return true;
      }
      const live = index.listActive().filter((s) => matchesPredicate(visibleTo, s));
      const render = (page: IndexPage) => {
        const liveCount = page.rows.filter((r) => !r.finished).length;
        // The tab title carries the live count (item 21); the page keeps it
        // current from the feed after this first paint.
        const title = `${liveCount > 0 ? `(${liveCount}) ` : ""}${all ? "All runs" : "Live runs"}`;
        const seed: RunsIndexSeed = {
          page: "runs",
          all,
          retentionDays: deps.retention ? deps.retention.retentionDays : null,
          now: now(),
          rows: [...page.rows],
          ...(page.storeUnavailable ? { storeUnavailable: STORE_UNAVAILABLE_BANNER } : {}),
          ...(page.olderHref ? { olderHref: page.olderHref } : {}),
          ...(page.olderThan !== undefined ? { olderThan: page.olderThan } : {}),
        };
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(deps.shell(title, seed));
      };
      if (!all) {
        // The default view is the registry plus the ledger's rows live under
        // other generations (run-history item 41) — tokenless, static (the index
        // feed is the registry's). Still never a store read.
        run(res, async () =>
          render({ rows: [...live.filter((s) => !s.finished), ...(await service.liveElsewhere(visibleTo))] }),
        );
        return true;
      }
      run(res, async () => render(await mergedRows(live, visibleTo, parseIndexCursor(url.searchParams))));
      return true;
    }

    // The Scheduled tab (docs/reference/specs/live-view.md item 18): the registry's schedules with each one's
    // last firing; a live firing links with its token, so the panel reads the
    // live rows — only those the viewer may read, so it never hands out a token
    // for a run the viewer could not open (a finished firing links tokenless,
    // to the bound run page). Without a firing store the history is
    // "unavailable" (never "never fired"); without a schedule registry the tab
    // says so (200, not 404). Same Access gate as the index, no token, GET-only,
    // no feed.
    if (route.kind === "scheduled") {
      const scheduled = deps.scheduled;
      if (!scheduled) {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(deps.shell("Scheduled runs", { page: "scheduled", now: now(), rows: null }));
        return true;
      }
      const visibleTo = readableRuns(ctx.actor);
      const live = index.listActive().filter((s) => matchesPredicate(visibleTo, s));
      const render = (firings: FiringsState) => {
        const t = now();
        const seed: ScheduledSeed = {
          page: "scheduled",
          now: t,
          rows: buildScheduledRows(scheduled.schedules, firings, live, t),
          ...(firings.ok ? {} : { firingsUnavailable: firings.reason }),
        };
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(deps.shell("Scheduled runs", seed));
      };
      if (!scheduled.store) {
        render({ ok: false, reason: NO_STORE_REASON });
        return true;
      }
      // The store is read before the head is written, so the first paint is
      // complete (a firing-store failure is shown as such, never as an empty history).
      run(res, async () => render(await loadFirings(scheduled.store!)));
      return true;
    }

    const token = url.searchParams.get("t") ?? "";
    const access = token ? service.authorizeLive(route.id, token) : null;

    // ── Live path: the token checked out. Synchronous — the registry answers
    // from memory, never the store.
    if (access) {
      if (route.kind === "page") {
        const snap = access.snapshot();
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          deps.shell("Live run", {
            page: "run",
            mode: "live",
            id: route.id,
            // Stop control: same token, POST-only; `&mode=` is appended client-side.
            eventsUrl: `/runs/${encodeURIComponent(route.id)}/events?t=${encodeURIComponent(token)}`,
            stopUrl: `/runs/${encodeURIComponent(route.id)}/stop?t=${encodeURIComponent(token)}`,
            // The stamps the header's one duration reads (docs/reference/specs/tracing.md).
            serverNow: now(),
            startedAt: snap?.startedAt ?? now(),
            ...(snap?.receivedAt !== undefined ? { receivedAt: snap.receivedAt } : {}),
            ...(snap?.finishedAt !== undefined ? { finishedAt: snap.finishedAt } : {}),
          }),
        );
        return true;
      }
      // Read-only friction diagnosis of the run's retained backlog: works
      // mid-run (a diagnosis so far) and for a finished run still within the TTL.
      if (route.kind === "friction") {
        const snap = access.snapshot();
        if (!snap) {
          text(res, 404, NOT_FOUND);
          return true;
        }
        // The window is the run's own stamps, to now while live (docs/reference/specs/tracing.md):
        // a finished run's diagnosis here equals its record's shape.
        const diagnosis = analyzeRunFriction(snap.events, {
          finished: snap.finished,
          schema: SPAN_SCHEMA,
          window: { start: snap.receivedAt ?? snap.startedAt, end: snap.finishedAt ?? now() },
        });
        res.writeHead(200, JSON_NO_STORE);
        res.end(JSON.stringify({ id: route.id, finished: snap.finished, diagnosis }));
        return true;
      }
      // Run control: the only write. Mode is validated BEFORE anything
      // else so a malformed request is a plain 400; the registry's token-gated
      // stop answers 404 for a vanished run and 409 for a finished one. Never
      // throws: the run loop observes the control on its own schedule — this
      // request only records the ask.
      if (route.kind === "stop") {
        const mode = parseStopMode(url.searchParams.get("mode"));
        if (!mode) {
          text(res, 400, "mode must be soft or hard");
          return true;
        }
        const result = access.requestStop(mode);
        if (!result.ok) {
          if (result.reason === "finished") text(res, 409, "run already finished");
          else text(res, 404, NOT_FOUND);
          return true;
        }
        res.writeHead(200, JSON_NO_STORE);
        res.end(JSON.stringify({ id: route.id, mode: result.mode, state: "stopping" }));
        return true;
      }
      // route.kind === "events"
      const afterSeq = parseLastEventId(req.headers["last-event-id"]);
      serveEvents(
        (onEvent, onFinished, onSealed) => access.subscribe({ onEvent, onFinished, onSealed, afterSeq }),
        nodeSseSink(req, res),
        () => startSseHeartbeat(req, res),
      );
      return true;
    }

    // ── History path: no token, or one the registry refused. A FINISHED run the
    // viewer's actor may read is readable here (a live run of THIS process
    // keeps requiring its token — a wrong token on it is the same 404 as an
    // unknown run; a finished run the table denies is that same 404 too); a
    // finished run still in the registry and a persisted one render identically
    // through the service. So is a run LIVE ELSEWHERE (run-history item 41 —
    // the ledger's row under another generation, `ownerGen` set): its token is
    // the other generation's, so the attribute decision is the only gate it can
    // have, and it renders in history mode with the ledger's events — no
    // stream to follow, no stop controls on the page; the tokenless stop route
    // stops it through the ledger.
    const actor = ctx.actor;
    const servable = (view: RunView): boolean => view.finished || view.ownerGen !== undefined;
    if (route.kind === "stop") {
      const mode = parseStopMode(url.searchParams.get("mode"));
      if (!mode) {
        text(res, 400, "mode must be soft or hard");
        return true;
      }
      run(res, async () => {
        // The 409 says "this run exists and is over" — a fact only a viewer who
        // may read the run is told. A run live elsewhere is stopped through the
        // ledger (the owner reads the stop on its next heartbeat).
        const found = await service.getRun(route.id);
        if (!found.ok || !servable(found.value) || !readable(actor, found.value, "stop")) {
          text(res, 404, NOT_FOUND);
          return;
        }
        if (found.value.finished) {
          text(res, 409, "run already finished");
          return;
        }
        const stopped = await service.stopRun(route.id, mode, { kind: "access", id: actor.id });
        if (!stopped.ok) {
          if (stopped.error === "conflict") text(res, 409, "run already finished");
          else text(res, 404, NOT_FOUND);
          return;
        }
        res.writeHead(200, JSON_NO_STORE);
        res.end(JSON.stringify(stopped.value));
      });
      return true;
    }

    if (route.kind === "friction") {
      run(res, async () => {
        // The summary row carries what the decision reads; the diagnosis is fetched only for an allowed viewer.
        const found = await service.getRun(route.id);
        const friction =
          found.ok && servable(found.value) && readable(actor, found.value, "friction")
            ? await service.getRunFriction(route.id)
            : null;
        if (!friction?.ok || (!friction.value.finished && !(found.ok && found.value.ownerGen !== undefined))) {
          text(res, 404, NOT_FOUND);
          return;
        }
        res.writeHead(200, JSON_NO_STORE);
        res.end(JSON.stringify(friction.value));
      });
      return true;
    }

    run(res, async () => {
      // ONE record read serves both the page and the stored replay: the record
      // already holds every event, so the events route never re-reads it page
      // by page. The same read carries the attributes the decision needs.
      const found = await service.getRun(route.id, { include: "messages" });
      if (!found.ok || !servable(found.value) || !readable(actor, found.value, route.kind)) {
        if (route.kind === "events") {
          // the same 404 shape the live stream writes
          const sink = nodeSseSink(req, res);
          sink.writeHead(404, TEXT);
          sink.write(NOT_FOUND);
          sink.end();
        } else if (route.kind === "page") {
          // A person landed here: the same 404 (existence never revealed), as a
          // page with the way back (item 19). Machine routes keep the text body.
          res.writeHead(404, WEB_HTML_HEADERS);
          res.end(
            deps.shell("Run not found", {
              page: "runNotFound",
              retentionDays: deps.retention ? deps.retention.retentionDays : null,
            }),
          );
        } else text(res, 404, NOT_FOUND);
        return;
      }
      const view = found.value;
      audit({ route: route.kind === "page" ? "page" : "events", runId: route.id, identity: actor.id });
      if (route.kind === "page") {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          deps.shell("Run", {
            page: "run",
            mode: "history",
            id: route.id,
            // The stored stream with the truncation made visible (AE11): the
            // seed IS the stream on a history page — normalized first
            // (docs/reference/specs/tracing.md), so a legacy record's `turn` and
            // `mcp_tool_use` reach the fold as the spans a live run emits.
            events: withOmittedMarkers(normalizeSpans(view.events ?? [], { schema: view.schema }), view.eventCount),
            ...(view.status ? { status: view.status } : {}),
            eventCount: view.eventCount,
            startedAt: view.startedAt,
            ...(view.receivedAt !== undefined ? { receivedAt: view.receivedAt } : {}),
            ...(view.finishedAt !== undefined ? { finishedAt: view.finishedAt } : {}),
            ...(view.sealedAt !== undefined ? { sealedAt: view.sealedAt } : {}),
            ...(view.replyOk !== undefined ? { replyOk: view.replyOk } : {}),
            ...(runDurationMs(view) !== undefined ? { durationMs: runDurationMs(view) } : {}),
            ...(view.truncated !== undefined ? { truncated: view.truncated } : {}),
          }),
        );
        return;
      }
      serveHistoryEvents(view.events ?? [], view.eventCount, nodeSseSink(req, res));
    });
    return true;
  };
}
