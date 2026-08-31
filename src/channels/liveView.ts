import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { StopMode } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRegistry, RunSummary } from "../core/runRegistry.js";
import type { RunListCursor, RunsService } from "../core/runsService.js";
import type { ScheduleDef } from "../core/schedules.js";
import type { ScheduleStore } from "../core/scheduleStore.js";
import { STORE_UNAVAILABLE_BANNER } from "../core/commandRegistry.js";
import { buildScheduledRows, type FiringsState } from "./scheduledPanel.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";
import type { RunIndexRowSeed, RunsIndexSeed, ScheduledSeed } from "./webSeed.js";
export { FAVICON_ICO_SVG, FAVICON_IDLE, FAVICON_LIVE, faviconSvg } from "./favicon.js";
import { nodeSseSink, parseLastEventId, serveEvents, serveHistoryEvents, serveIndexEvents, startSseHeartbeat, withOmittedMarkers } from "./liveView/sse.js";

/** One index row, whatever its source: a live registry row (which carries the
 *  capability `token`) or a finished/persisted `RunView` (no token). The seed
 *  type in webSeed.ts is the same shape — one alias so handler code reads
 *  naturally. */
export type IndexRow = RunIndexRowSeed;

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
 *  the one WRITE route (`POST /runs/:id/stop`, #101). */
export type RunRoute = { kind: "index" } | { kind: "scheduled" } | { id: string; kind: "page" | "events" | "friction" | "stop" };

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

/** One audit line per persisted-run page/events read (R9): who read which run
 *  on which route — never any content. */
export interface HistoryReadAudit {
  route: "page" | "events";
  runId: string;
  identity?: string;
}

export interface LiveViewDeps {
  /** The bound web-app shell (webShell.ts): title + seed → the HTML document. */
  shell: ShellRenderer;
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
  const pageSize = deps.indexPageSize ?? INDEX_PAGE_SIZE;
  /** One rendered index page: the rows, the store-degraded flag, the "Older runs" href and whether a cursor got us here. */
  interface IndexPage {
    rows: readonly IndexRow[];
    storeUnavailable?: boolean;
    olderHref?: string;
    olderThan?: number;
  }
  /** `?all=1`: one full page of the service's live ∪ finished ∪ persisted rows
   *  (the service's cap, never its 50-row default), with the live rows'
   *  capability tokens re-attached for their hrefs (finished rows stay
   *  tokenless), plus the "Older runs" href when the page was full. */
  const mergedRows = async (live: readonly RunSummary[], cursor?: { before: number; beforeId: string }): Promise<IndexPage> => {
    const tokens = new Map(live.map((s) => [s.id, s.token]));
    const { runs, nextBefore, storeUnavailable } = await service.listRuns({ status: "all", limit: pageSize, ...(cursor ?? {}) });
    // A cursor page holds finished runs only — the service leaves the live rows
    // off it (they all sort ahead of any cursor), so the page is a full page.
    // Only an UNFINISHED row gets its capability token (R10): the seed is data
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
        // Nothing to await: the default view is the registry alone (R11 — never a
        // store read), rendered synchronously as before.
        render({ rows: live.filter((s) => !s.finished) });
        return true;
      }
      run(res, async () => render(await mergedRows(live, parseIndexCursor(url.searchParams))));
      return true;
    }

    // The Scheduled tab (#244, item 18): the registry's schedules with each one's
    // last firing; a live firing links with its token, so the panel reads the
    // live rows. Without a firing store the history is "unavailable" (never
    // "never fired"); without a schedule registry the tab says so (200, not 404).
    // Same Access gate as the index, no token, GET-only, no feed.
    if (route.kind === "scheduled") {
      const scheduled = deps.scheduled;
      if (!scheduled) {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(deps.shell("Scheduled runs", { page: "scheduled", now: now(), rows: null }));
        return true;
      }
      const live = index.listActive();
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

    // ── Live path: the token checked out. Synchronous and byte-identical to the
    // pre-history handler (KTD6).
    if (access) {
      if (route.kind === "page") {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          deps.shell("Live run", {
            page: "run",
            mode: "live",
            id: route.id,
            // Stop control (#101): same token, POST-only; `&mode=` is appended client-side.
            eventsUrl: `/runs/${encodeURIComponent(route.id)}/events?t=${encodeURIComponent(token)}`,
            stopUrl: `/runs/${encodeURIComponent(route.id)}/stop?t=${encodeURIComponent(token)}`,
          }),
        );
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
        } else if (route.kind === "page") {
          // A person landed here: the same 404 (existence never revealed), as a
          // page with the way back (item 19). Machine routes keep the text body.
          res.writeHead(404, WEB_HTML_HEADERS);
          res.end(deps.shell("Run not found", { page: "runNotFound", retentionDays: deps.retention ? deps.retention.retentionDays : null }));
        } else text(res, 404, NOT_FOUND);
        return;
      }
      const view = found.value;
      audit({ route: route.kind === "page" ? "page" : "events", runId: route.id, ...(ctx?.identity ? { identity: ctx.identity } : {}) });
      if (route.kind === "page") {
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          deps.shell("Run", {
            page: "run",
            mode: "history",
            id: route.id,
            // The stored stream with the truncation made visible (AE11): the
            // seed IS the stream on a history page.
            events: withOmittedMarkers(view.events ?? [], view.eventCount),
            ...(view.status ? { status: view.status } : {}),
            eventCount: view.eventCount,
            ...(typeof view.finishedAt === "number" ? { durationMs: view.finishedAt - view.startedAt } : {}),
          }),
        );
        return;
      }
      serveHistoryEvents(view.events ?? [], view.eventCount, nodeSseSink(req, res));
    });
    return true;
  };
}
