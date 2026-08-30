import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { StopMode } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRegistry, RunSummary } from "../core/runRegistry.js";
import { RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunListCursor, RunsService } from "../core/runsService.js";
import type { ScheduleDef } from "../core/schedules.js";
import type { ScheduleStore } from "../core/scheduleStore.js";
import { buildScheduledRows, renderScheduledPanel, type FiringsState } from "./scheduledPanel.js";
import { HTML_PAGE_HEADERS } from "./liveView/html.js";
import { renderRunPage } from "./liveView/runPage.js";
import { renderRunsIndex, type IndexRow, type RunsIndexOptions } from "./liveView/runsIndex.js";
import { nodeSseSink, parseLastEventId, serveEvents, serveHistoryEvents, serveIndexEvents, startSseHeartbeat } from "./liveView/sse.js";

// Live-view channel: the external, browser-facing surface for a live agent run
// (Area 2 / #43). It streams the SAME redacted RunEvents the in-channel status
// card consumes, over Server-Sent Events, to a minimal self-contained page.
//
// Auth for a LIVE run is a per-run CAPABILITY TOKEN, not a bearer header: a
// plain browser navigation can't send an Authorization header, so the token
// rides in the URL (`/runs/:id?t=…`) and is validated (constant-time) by the
// registry — via `RunsService.authorizeLive` — for the page, the event stream
// and the stop control. A wrong/missing token on a live run — or an unknown run
// — is a 404 (never reveal existence). A FINISHED run (still in the registry, or
// persisted in the run store — #157) is served tokenless in history mode to the
// Access-authenticated viewer, through the same page renderer. Events are
// already redacted + capped upstream (runEvents.ts); this layer adds no data and
// re-exposes nothing.
//
// SSE (not WebSocket) because the flow is strictly one-directional server→page,
// EventSource auto-reconnects, and it needs no handshake or extra dependency.
//
// Handlers are split from transport so the logic is unit-testable without a
// socket: `parseRunRoute` (pure), `renderRunPage` (pure string), and
// `serveEvents` (drives an abstract SseSink). `createLiveViewHandler` is the
// thin node:http wrapper.
//
// This file is the router (`parseRunRoute`, `createLiveViewHandler`); the
// rendering and transport live in `./liveView/` and are re-exported here so
// every importer keeps one entry point:
//   html.ts      — HTML_PAGE_HEADERS, escapeHtml, NAME_SHIM
//   runPage.ts   — renderRunPage + the inlined client scripts, seedEventsJson
//   runsIndex.ts — renderRunsIndex, indexRowRenderer, staticDocument, feed rules
//   sse.ts       — SseSink, serveEvents / serveIndexEvents / serveHistoryEvents

export * from "./liveView/html.js";
export * from "./liveView/runPage.js";
export * from "./liveView/runsIndex.js";
export * from "./liveView/sse.js";

/** Which live-view route a path is, if any. The bare `/runs` index carries no
 *  id (it is Access-gated, not token-gated); the per-run routes do. `stop` is
 *  the one WRITE route (`POST /runs/:id/stop`, #101). */
export type RunRoute = { kind: "index" } | { id: string; kind: "page" | "events" | "friction" | "stop" };

/** Match the bare index (`/runs`, `/runs/`), a per-run page (`/runs/:id`), a
 *  per-run SSE stream (`/runs/:id/events`), a per-run friction diagnosis
 *  (`/runs/:id/friction`), or the per-run stop control (`/runs/:id/stop`).
 *  Path only — the token is a query param, read separately. Returns null for
 *  anything else so the server can fall through to its other routes. */
export function parseRunRoute(pathname: string): RunRoute | null {
  if (pathname === "/runs" || pathname === "/runs/") return { kind: "index" };
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

/** One audit line per persisted-run page/events read (R9): who read which run
 *  on which route — never any content. */
export interface HistoryReadAudit {
  route: "page" | "events";
  runId: string;
  identity?: string;
}

export interface LiveViewDeps {
  /** Every run read and the tokenless stop go through the service (KTD7). */
  service: RunsService;
  /** The registry's index face: the live rows (with tokens, for their hrefs) and
   *  the live feed. The default `/runs` view is served from this alone (R11). */
  index: Pick<RunRegistry, "listActive" | "subscribeIndex">;
  /** The configured run-history retention, for the index toggle's tooltip; null
   *  when history is off (store: null). */
  retention: { retentionDays: number } | null;
  /** KTD13: under `ACCESS_DEV_BYPASS`, history reads (`?all=1`, tokenless page /
   *  events / friction of a finished run) are served only to a loopback client;
   *  otherwise 403. `active` is true only while the bypass is in effect — i.e.
   *  Access is NOT configured (index.ts applies the same rule as `commandHttp`
   *  and `requireAccessForRuns`). The token-gated live path is unaffected.
   *  Absent → no gate. */
  devBypass?: { active: () => boolean; isLoopback: (req: HttpRequest) => boolean };
  /** Receives one entry per persisted-run page/events read. Default: console.log. */
  audit?: (entry: HistoryReadAudit) => void;
  /** The "Scheduled" panel on the index (#244): the schedule registry to list
   *  and, optionally, the store holding each schedule's firings. Absent → no
   *  panel (tests, the CLI). */
  scheduled?: {
    schedules: readonly ScheduleDef[];
    /** undefined → the panel says firing history is unavailable. */
    store?: ScheduleStore;
  };
  /** Injectable clock for the panel's "next fire" / relative times. */
  now?: () => number;
  /** Rows per `?all=1` page. Default `RUN_LIST_MAX_LIMIT` (the service's cap) —
   *  a full page renders an "Older runs" link carrying the service's cursor. */
  indexPageSize?: number;
}

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

/** Per-request context the server passes in: the Access identity it verified. */
export interface LiveViewContext {
  identity?: string;
}

const NOT_FOUND = "run not found";
const TEXT = { "content-type": "text/plain; charset=utf-8" };
const JSON_NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

/**
 * node:http handler for the live-view routes. Returns `true` if it owned the
 * request (so the server stops routing), `false` to fall through. Every read
 * route is GET-only and the one write route is POST-only (405 otherwise):
 *   GET  /runs                 → the runs index HTML page: active runs (Access-gated, NOT token-gated)
 *   GET  /runs?all=1           → the index with finished + persisted runs too (R11)
 *   GET  /runs?stream=1[&all=1] → the live runs-index SSE feed
 *   GET  /runs/:id[?t=…]       → the HTML page: a valid token → the live page; no/wrong token →
 *        history mode for a finished or persisted run (tokenless, Access-gated), 404 for a live run
 *   GET  /runs/:id/events[?t=…] → the SSE stream: live with a token; the stored replay + `end` otherwise
 *   GET  /runs/:id/friction[?t=…] → the friction diagnosis JSON (live diagnosis-so-far, or the stored one)
 *   POST /runs/:id/stop?t=…&mode=soft|hard → ask the run to stop (#101): 200 JSON, 400 bad
 *        mode, 404 bad/missing token on a live run or unknown run, 409 finished/persisted
 * The live routes are token-gated via the registry (`authorizeLive`, synchronous
 * — KTD6); the tokenless history routes and the index are Access-gated at the
 * edge (index.ts gates every method under /runs*). Unknown, expired, and
 * wrong-token-on-live lookups share one 404 body (R4/R10). `?stream=1` (a query
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

export function createLiveViewHandler(deps: LiveViewDeps): (req: HttpRequest, res: ServerResponse, ctx?: LiveViewContext) => boolean {
  const { service, index } = deps;
  const audit = deps.audit ?? ((entry) => console.log(`[runs] history read ${JSON.stringify(entry)}`));
  const text = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, TEXT);
    res.end(body);
  };
  const historyReadForbidden = (req: HttpRequest): boolean => !!deps.devBypass && deps.devBypass.active() && !deps.devBypass.isLoopback(req);
  /** Runs the async history path; a throw is a 500, never an unhandled rejection. */
  const run = (res: ServerResponse, work: () => Promise<void>) => {
    work().catch((err: unknown) => {
      console.error(`[runs] ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) text(res, 500, "internal error");
      else res.end();
    });
  };

  const now = deps.now ?? Date.now;
  const pageSize = deps.indexPageSize ?? RUN_LIST_MAX_LIMIT;
  /** One rendered index page: the rows, the store-degraded flag and the "Older runs" href. */
  interface IndexPage {
    rows: readonly IndexRow[];
    storeUnavailable?: boolean;
    olderHref?: string;
  }
  /** `?all=1`: one full page of the service's live ∪ finished ∪ persisted rows
   *  (the service's cap, never its 50-row default), with the live rows'
   *  capability tokens re-attached for their hrefs (finished rows stay
   *  tokenless), plus the "Older runs" href when the page was full. */
  const mergedRows = async (live: readonly RunSummary[], cursor?: { before: number; beforeId: string }): Promise<IndexPage> => {
    const tokens = new Map(live.map((s) => [s.id, s.token]));
    const { runs, nextBefore, storeUnavailable } = await service.listRuns({ status: "all", limit: pageSize, ...(cursor ?? {}) });
    const rows = runs.map((v) => {
      const token = tokens.get(v.id);
      return token === undefined ? v : { ...v, token };
    });
    // The service degraded to live rows: the page says so (a banner), never a silently short list.
    return {
      rows,
      ...(storeUnavailable ? { storeUnavailable: true } : {}),
      ...(nextBefore ? { olderHref: olderRunsHref(nextBefore) } : {}),
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
    // behind Access (see features/live-view.md). The default view is the live
    // registry only (R11: never a store read); `?all=1` merges the service's
    // finished + persisted rows in, keeping the live rows' token hrefs.
    if (route.kind === "index") {
      const all = url.searchParams.get("all") === "1";
      if (all && historyReadForbidden(req)) {
        text(res, 403, "forbidden");
        return true;
      }
      if (url.searchParams.get("stream") === "1") {
        serveIndexEvents((onEvent) => index.subscribeIndex(onEvent), nodeSseSink(req, res), () => startSseHeartbeat(req, res));
        return true;
      }
      const live = index.listActive();
      const scheduled = deps.scheduled;
      // The Scheduled panel (#244) lists the registry's schedules with each one's
      // last firing; a live firing links with its token, so the panel reads the
      // live rows, whatever the view. Without a firing store the history is
      // "unavailable" (never "never fired").
      const panelFor = (firings: FiringsState): string | undefined => {
        if (!scheduled) return undefined;
        const t = now();
        return renderScheduledPanel(buildScheduledRows(scheduled.schedules, firings, live, t), firings, t);
      };
      const render = (page: IndexPage, firings: FiringsState) => {
        res.writeHead(200, HTML_PAGE_HEADERS);
        res.end(
          renderRunsIndex(page.rows, {
            all,
            retention: deps.retention,
            scheduledPanel: panelFor(firings),
            ...(page.storeUnavailable ? { storeUnavailable: true } : {}),
            ...(page.olderHref ? { olderHref: page.olderHref } : {}),
          }),
        );
      };
      const noStore: FiringsState = { ok: false, reason: NO_STORE_REASON };
      const activeOnly = () => ({ rows: live.filter((s) => !s.finished) });
      if (!all && !scheduled?.store) {
        // Nothing to await: the default view is the registry alone (R11 — never a
        // store read), rendered synchronously as before.
        render(activeOnly(), noStore);
        return true;
      }
      run(res, async () => {
        // Both reads are known before the head is written, so the first paint is
        // complete (a firing-store failure is shown as such, never as an empty
        // history).
        const [page, firings] = await Promise.all([
          all ? mergedRows(live, parseIndexCursor(url.searchParams)) : Promise.resolve<IndexPage>(activeOnly()),
          scheduled?.store ? loadFirings(scheduled.store) : Promise.resolve(noStore),
        ]);
        render(page, firings);
      });
      return true;
    }

    const token = url.searchParams.get("t") ?? "";
    const access = token ? service.authorizeLive(route.id, token) : null;

    // ── Live path: the token checked out. Synchronous and byte-identical to the
    // pre-history handler (KTD6).
    if (access) {
      if (route.kind === "page") {
        res.writeHead(200, HTML_PAGE_HEADERS);
        res.end(renderRunPage(route.id, token));
        return true;
      }
      // Read-only friction diagnosis of the run's retained backlog (#84): works
      // mid-run (a diagnosis so far) and for a finished run still within the TTL.
      if (route.kind === "friction") {
        const snap = access.snapshot();
        if (!snap) {
          text(res, 404, NOT_FOUND);
          return true;
        }
        const diagnosis = analyzeRunFriction(snap.events, { finished: snap.finished });
        res.writeHead(200, JSON_NO_STORE);
        res.end(JSON.stringify({ id: route.id, finished: snap.finished, diagnosis }));
        return true;
      }
      // Run control (#101): the only write. Mode is validated BEFORE anything
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
        (onEvent, onFinish) => access.subscribe(onEvent, onFinish, afterSeq),
        nodeSseSink(req, res),
        () => startSseHeartbeat(req, res),
      );
      return true;
    }

    // ── History path: no token, or one the registry refused. Only a FINISHED run
    // is readable here (R10: a live run keeps requiring its token — a wrong
    // token on it is the same 404 as an unknown run); a finished run still in
    // the registry and a persisted one render identically through the service.
    if (route.kind === "stop") {
      const mode = parseStopMode(url.searchParams.get("mode"));
      if (!mode) {
        text(res, 400, "mode must be soft or hard");
        return true;
      }
      run(res, async () => {
        const found = await service.getRun(route.id);
        if (!found.ok || !found.value.finished) text(res, 404, NOT_FOUND);
        else text(res, 409, "run already finished");
      });
      return true;
    }

    if (historyReadForbidden(req)) {
      text(res, 403, "forbidden");
      return true;
    }

    if (route.kind === "friction") {
      run(res, async () => {
        const found = await service.getRunFriction(route.id);
        if (!found.ok || !found.value.finished) {
          text(res, 404, NOT_FOUND);
          return;
        }
        res.writeHead(200, JSON_NO_STORE);
        res.end(JSON.stringify(found.value));
      });
      return true;
    }

    run(res, async () => {
      // ONE record read serves both the page and the stored replay: the record
      // already holds every event, so the events route never re-reads it page
      // by page.
      const found = await service.getRun(route.id, { include: "messages" });
      if (!found.ok || !found.value.finished) {
        if (route.kind === "events") {
          // the same 404 shape the live stream writes
          const sink = nodeSseSink(req, res);
          sink.writeHead(404, TEXT);
          sink.write(NOT_FOUND);
          sink.end();
        } else text(res, 404, NOT_FOUND);
        return;
      }
      const view = found.value;
      audit({ route: route.kind === "page" ? "page" : "events", runId: route.id, ...(ctx?.identity ? { identity: ctx.identity } : {}) });
      if (route.kind === "page") {
        res.writeHead(200, HTML_PAGE_HEADERS);
        res.end(renderRunPage(route.id, "", view.events ?? [], { status: view.status, eventCount: view.eventCount }));
        return;
      }
      serveHistoryEvents(view.events ?? [], view.eventCount, nodeSseSink(req, res));
    });
    return true;
  };
}
