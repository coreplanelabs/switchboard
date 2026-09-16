import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { runDurationMs } from "../core/runDuration.js";
import { normalizeSpans, SPAN_SCHEMA } from "../core/normalizeSpans.js";
import {
  authorize,
  matchesPredicate,
  type Actor,
  type Decision,
  type Predicate,
  type Resource,
} from "../core/authz/index.js";
import { readableRuns, visibleIndexFeed } from "./liveView/viewer.js";
export { readableRuns, visibleIndexFeed } from "./liveView/viewer.js";
import type { RunEvent, StopMode } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { INLINE_IMAGE_TYPES } from "../artifacts/contentType.js";
import { safeBasename } from "../artifacts/keys.js";
import type { RunRegistry } from "../core/runRegistry.js";
import type { RunSummary } from "../core/runRegistry/projections.js";
import { runResource, type RunListCursor, type RunsService, type RunView } from "../core/runsService.js";
import type { ScheduleDef } from "../core/schedules.js";
import type { ScheduleStore } from "../core/scheduleStore.js";
import { STORE_UNAVAILABLE_BANNER } from "../core/commandRegistry.js";
import { buildScheduledRows, type FiringsState } from "./scheduledPanel.js";
import type { ShellRenderer } from "./webShell.js";
import { WEB_HTML_HEADERS } from "./webShell.js";
import type { RunIndexRowSeed, RunsIndexSeed, ScheduledSeed, UnitRunRowSeed, UnitSeed } from "./webSeed.js";
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
  | { kind: "index" }
  | { kind: "scheduled" }
  | { id: string; kind: "page" | "events" | "friction" | "stop" }
  /** `/runs/:id/artifacts/<key>` (item 26): `key` is everything after `/artifacts/`, decoded. */
  | { id: string; kind: "artifact"; key: string }
  /** `/runs/unit/<key>` (item 28): a ship unit's page, `key` the unit key `<instance>:<unit>`, decoded. */
  | { kind: "unit"; key: string };

/** Path words that are never a run id (ids are UUIDs): the Scheduled tab, the
 *  artifacts prefix and the unit pages' prefix. `/runs/artifacts`,
 *  `/runs/artifacts/x` and a bare `/runs/unit` route nowhere. */
const RESERVED_IDS = new Set(["scheduled", "artifacts", "unit"]);

/** Match the bare index (`/runs`, `/runs/`), the Scheduled tab
 *  (`/runs/scheduled`, item 18 — a reserved path word, never a run id: ids are
 *  UUIDs), a per-run page (`/runs/:id`), a per-run SSE stream
 *  (`/runs/:id/events`), a per-run friction diagnosis (`/runs/:id/friction`),
 *  the per-run stop control (`/runs/:id/stop`), or one of the run's files
 *  (`/runs/:id/artifacts/<key>`, item 26 — the key is the greedy tail, slashes
 *  and all, each segment decoded). Path only — the token is a query param, read
 *  separately. Returns null for anything else so the server can fall through
 *  to its other routes. */
export function parseRunRoute(pathname: string): RunRoute | null {
  if (pathname === "/runs" || pathname === "/runs/") return { kind: "index" };
  if (pathname === "/runs/scheduled" || pathname === "/runs/scheduled/") return { kind: "scheduled" };
  const u = /^\/runs\/unit\/([^/]+)\/?$/.exec(pathname);
  if (u) {
    const key = decodeSegment(u[1]);
    return key === null || key === "" ? null : { kind: "unit", key };
  }
  const a = /^\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(pathname);
  if (a) {
    const id = decodeSegment(a[1]);
    const segments = a[2].split("/").map(decodeSegment);
    if (id === null || id === "" || RESERVED_IDS.has(id) || segments.some((s) => s === null || s === "")) return null;
    return { id, kind: "artifact", key: segments.join("/") };
  }
  const m = /^\/runs\/([^/]+)(?:\/(events|friction|stop))?\/?$/.exec(pathname);
  if (!m) return null;
  const id = decodeSegment(m[1]);
  if (id === null || id === "" || RESERVED_IDS.has(id)) return null;
  const sub = m[2];
  return { id, kind: sub === "events" || sub === "friction" || sub === "stop" ? sub : "page" };
}

/** One path segment decoded; null on malformed percent-encoding (→ not a run route). */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

type ArtifactEvent = Extract<RunEvent, { type: "artifact" }>;

/** The response end of the artifact proxy (item 26): what a byte sink must offer. */
export type ByteSink = Pick<ServerResponse, "write" | "end" | "once" | "off" | "destroyed">;

/** Pipe an object's bytes to the response with backpressure, and stop the
 *  moment the client is gone: a `write` that returns false waits for `drain`
 *  OR `close`, whichever comes first — a response the client aborted never
 *  drains, and a loop that waited on `drain` alone would hold the store's
 *  stream open forever. On abort the source is cancelled so the signed GET
 *  upstream closes too; nothing is written to a destroyed response. */
export async function pipeToResponse(body: ReadableStream<Uint8Array>, res: ByteSink): Promise<void> {
  let closed = false;
  const onClose = () => void (closed = true);
  res.once("close", onClose);
  const reader = body.getReader();
  try {
    for (;;) {
      if (closed || res.destroyed) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (closed || res.destroyed) {
        await reader.cancel();
        return;
      }
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const drained = () => {
            res.off("close", gone);
            resolve();
          };
          const gone = () => {
            res.off("drain", drained);
            resolve();
          };
          res.once("drain", drained);
          res.once("close", gone);
        });
      }
    }
    res.end();
  } finally {
    res.off("close", onClose);
    reader.releaseLock();
  }
}

/** Parse the `?mode=` of a stop request; anything but the two modes is null
 *  (→ 400). Never trust the query to name the mode for us. */
export function parseStopMode(raw: string | null): StopMode | null {
  return raw === "soft" || raw === "hard" ? raw : null;
}

/** The tokenless routes that read a finished run. */
export type HistoryReadRoute = "page" | "events" | "friction" | "stop" | "artifact";

/** One audit line per tokenless read of a finished run. An allowed
 *  page/events/artifact read says who read which run on which route — never
 *  any content (an artifact read names the run, not the key). A read the
 *  table refused says who was refused on which route and why (`authorize`'s
 *  reason: the audit line's, never the reply's) — and never which run, so the
 *  log reveals no more existence than the 404 does (the same shape `runs.*`
 *  logs). */
export type HistoryReadAudit =
  | { route: "page" | "events" | "artifact"; runId: string; identity: string }
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
  /** The artifact store (execution.md item 20) the `/runs/:id/artifacts/<key>`
   *  route reads from, with the bucket's retention for the 410 an expired key
   *  answers. Absent → no `artifacts:` section: the route answers 404 and the
   *  seeds carry no `artifacts`. */
  artifacts?: { store: ArtifactStore; retentionDays: number };
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
 *  (`runs.get` for a run read, `runs.stop` for a stop; the index's `runs.list`
 *  lives with `readableRuns` in liveView/viewer.ts): the actor must hold the
 *  right at all before any run row is consulted, so the HTML surface is never
 *  wider than `/api/runs.*` for the same identity. */
const RUNS_GET: Resource = { type: "command", id: "runs.get" };
const RUNS_STOP: Resource = { type: "command", id: "runs.stop" };

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

  /** The seed's `artifacts` (item 26) when a store is configured: the run's
   *  URL base, the retention the 410 names, and the live token when there is
   *  one. Nothing without a store — a page can list nothing it cannot serve. */
  const artifactsSeed = (id: string, token?: string) =>
    deps.artifacts
      ? {
          artifacts: {
            urlBase: `/runs/${encodeURIComponent(id)}/artifacts/`,
            retentionDays: deps.artifacts.retentionDays,
            ...(token !== undefined ? { token } : {}),
          },
        }
      : {};

  /** Serve one of the run's files (item 26). The caller has already decided
   *  the viewer may read the RUN; this decides the KEY: only a key one of the
   *  run's own `artifact` events names is served (404 otherwise — the store
   *  holds every run's files under one bucket, and a key from another run is
   *  as unknown here as a made-up one). The bytes are piped from a signed GET
   *  the store mints for this request; the type is the event's, never sniffed
   *  (`nosniff`), the response is sandboxed so an HTML or SVG file cannot run
   *  as this origin, and only the four raster image types render inline —
   *  everything else downloads under its recorded basename. A key whose object
   *  is gone answers 410 naming the retention window. The request's single
   *  `Range` is honoured — the page's video and audio players seek by it — as
   *  a 206 with `Content-Range` and the part's length, a 416 naming the size
   *  past the end, and every answer says `Accept-Ranges: bytes`; a range the
   *  syntax does not admit streams the whole object. The caller looks the key
   *  up (`artifactNamed`) so it can audit a read of a named key — served or
   *  expired — before serving, and audit nothing for a key the run never named. */
  const artifactNamed = (events: readonly RunEvent[], key: string): ArtifactEvent | undefined =>
    events.find((e): e is ArtifactEvent => e.type === "artifact" && e.key === key);
  const serveArtifact = async (
    res: ServerResponse,
    named: ArtifactEvent | undefined,
    range: string | undefined,
  ): Promise<void> => {
    if (!named || !deps.artifacts) {
      text(res, 404, NOT_FOUND);
      return;
    }
    const object = await deps.artifacts.store.get(named.key, range === undefined ? {} : { range });
    if (!object) {
      text(res, 410, `artifact expired: files are kept for ${deps.artifacts.retentionDays} days`);
      return;
    }
    if ("unsatisfiable" in object) {
      res.writeHead(416, {
        "content-range": `bytes */${object.size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      });
      res.end();
      return;
    }
    const inline = INLINE_IMAGE_TYPES.has(named.contentType);
    const filename = safeBasename(named.name);
    const { part } = object;
    res.writeHead(part ? 206 : 200, {
      "content-type": named.contentType,
      "content-length": String(part ? part.end - part.start + 1 : object.size),
      ...(part ? { "content-range": `bytes ${part.start}-${part.end}/${object.size}` } : {}),
      "accept-ranges": "bytes",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-store",
    });
    await pipeToResponse(object.body, res);
  };
  /** The request's `Range` header as one string, or nothing. */
  const rangeOf = (req: HttpRequest): string | undefined => {
    const h = req.headers.range;
    return typeof h === "string" && h.length > 0 ? h : undefined;
  };
  /** One rendered index page: the rows, the store-degraded flag, the "Older runs" href and whether a cursor got us here. */
  interface IndexPage {
    rows: readonly IndexRow[];
    storeUnavailable?: boolean;
    olderHref?: string;
    olderThan?: number;
  }
  /** A row with its capability token re-attached for its href — only an
   *  UNFINISHED row gets one: the seed is data the page ships verbatim, and a
   *  finished row must never carry a token (the registry may still hold one for
   *  a recently finished run). */
  const withLiveToken = <T extends RunView>(v: T, tokens: ReadonlyMap<string, string>): T & { token?: string } => {
    const token = v.finished ? undefined : tokens.get(v.id);
    return token === undefined ? v : { ...v, token };
  };
  /** The live registry's tokens by run id — what every listing re-attaches from. */
  const liveTokens = (): Map<string, string> => new Map(index.listActive().map((s) => [s.id, s.token]));
  /** The run 404 as a page (item 19): one non-revealing message for an unknown
   *  id, an expired one, a wrong token, a deny — and a unit the viewer may not
   *  see (item 28) — with the way back. */
  const notFoundPage = (res: ServerResponse): void => {
    res.writeHead(404, WEB_HTML_HEADERS);
    res.end(
      deps.shell("Run not found", {
        page: "runNotFound",
        retentionDays: deps.retention ? deps.retention.retentionDays : null,
      }),
    );
  };
  /** `?all=1`: one full page of the service's live ∪ finished ∪ persisted rows
   *  the viewer may see (the service's cap, never its 50-row default), with the
   *  live rows' capability tokens re-attached for their hrefs (finished rows
   *  stay tokenless), plus the "Older runs" href when the page was full. */
  const mergedRows = async (
    live: readonly RunSummary[],
    visibleTo: Predicate,
    cursor?: { before: number; beforeId: string },
  ): Promise<IndexPage> => {
    const tokens = new Map(live.map((s) => [s.id, s.token] as const));
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
    const rows = runs.map((v) => withLiveToken(v, tokens));
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

    // The unit page (item 28; agent-ship item 17): the unit's runs in round
    // order from the one read `runs unit` makes, under the viewer's predicate,
    // a live row keeping its capability token as an index row does. A unit
    // that does not exist and one the viewer may see nothing of are the run
    // 404 — the page reveals no more than the route. Same Access gate as the
    // index, no token, GET-only, no feed; no store read is audited here, as
    // the index audits none: the seed is run metadata, never content.
    if (route.kind === "unit") {
      const visibleTo = readableRuns(ctx.actor);
      run(res, async () => {
        const found = await service.listUnitRuns(route.key, visibleTo);
        if (!found.ok) {
          notFoundPage(res);
          return;
        }
        const tokens = liveTokens();
        const seed: UnitSeed = {
          page: "unit",
          view: { ...found.value, runs: found.value.runs.map((r) => withLiveToken(r, tokens)) },
          now: now(),
          retentionDays: deps.retention ? deps.retention.retentionDays : null,
        };
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(deps.shell(`Unit ${found.value.id}`, seed));
      });
      return true;
    }

    const token = url.searchParams.get("t") ?? "";
    const access = token ? service.authorizeLive(route.id, token) : null;

    // ── Live path: the token checked out. Synchronous — the registry answers
    // from memory, never the store.
    if (access) {
      if (route.kind === "page") {
        const snap = access.snapshot();
        // A live conductor's children (item 28) from the registry alone — the
        // live path never reads the store — in start order, live rows with
        // their tokens: the token that opened the parent's page opens no child,
        // so each child's row carries its own.
        const children: UnitRunRowSeed[] = index
          .listActive()
          .filter((s) => s.parentRunId === route.id)
          .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((s): UnitRunRowSeed => {
            const { token: own, ...row } = s;
            return s.finished ? row : { ...row, token: own };
          });
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          deps.shell("Live run", {
            page: "run",
            mode: "live",
            id: route.id,
            ...(children.length > 0 ? { children } : {}),
            // Stop control: same token, POST-only; `&mode=` is appended client-side.
            eventsUrl: `/runs/${encodeURIComponent(route.id)}/events?t=${encodeURIComponent(token)}`,
            stopUrl: `/runs/${encodeURIComponent(route.id)}/stop?t=${encodeURIComponent(token)}`,
            // The files' URL base with the same token (item 26): the page appends each key.
            ...artifactsSeed(route.id, token),
            // The stamps the header's one duration reads (docs/reference/specs/tracing.md).
            serverNow: now(),
            startedAt: snap?.startedAt ?? now(),
            ...(snap?.receivedAt !== undefined ? { receivedAt: snap.receivedAt } : {}),
            ...(snap?.finishedAt !== undefined ? { finishedAt: snap.finishedAt } : {}),
          }),
        );
        return true;
      }
      // One of the run's files (item 26): the token that opens the page opens
      // its files; the key must be one the run's own events name.
      if (route.kind === "artifact") {
        const snap = access.snapshot();
        if (!snap) {
          text(res, 404, NOT_FOUND);
          return true;
        }
        run(res, () => serveArtifact(res, artifactNamed(snap.events, route.key), rangeOf(req)));
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
          notFoundPage(res);
        } else text(res, 404, NOT_FOUND);
        return;
      }
      const view = found.value;
      if (route.kind === "artifact") {
        // Audited once the KEY is decided too: a 404 for a key the run never
        // named is not a read of anything, and must not log as one.
        const named = artifactNamed(view.events ?? [], route.key);
        if (named) audit({ route: "artifact", runId: route.id, identity: actor.id });
        await serveArtifact(res, named, rangeOf(req));
        return;
      }
      audit({ route: route.kind === "page" ? "page" : "events", runId: route.id, identity: actor.id });
      if (route.kind === "page") {
        // A STORED record from before span schema carries no timing (docs/reference/specs/tracing.md):
        // it is handed over as stored, with no span set, and the page says so. Every
        // registry and ledger view is stamped `SPAN_SCHEMA` where it is built, so only
        // such a record reads as untimed here.
        const timed = (view.schema ?? 0) >= SPAN_SCHEMA;
        const events = view.events ?? [];
        // What this run is the parent of (item 28): the runs it spawned, and —
        // on the pipeline's own record, whose `run_meta` names its instance —
        // the instance's units. Both under the viewer's predicate; a live
        // child keeps its token as an index row does.
        const visibleTo = readableRuns(actor);
        const meta = events.find((e) => e.type === "run_meta");
        const instanceId = meta?.type === "run_meta" ? meta.instanceId : undefined;
        const [children, units] = await Promise.all([
          service.listChildren(route.id, visibleTo),
          instanceId !== undefined ? service.listInstanceUnits(instanceId, visibleTo) : Promise.resolve([]),
        ]);
        const tokens = liveTokens();
        res.writeHead(200, WEB_HTML_HEADERS);
        res.end(
          deps.shell("Run", {
            page: "run",
            mode: "history",
            id: route.id,
            ...(children.length > 0 ? { children: children.map((c) => withLiveToken(c, tokens)) } : {}),
            ...(units.length > 0 ? { units } : {}),
            // The stored stream with the truncation made visible (AE11): the
            // seed IS the stream on a history page — normalized first on a
            // span-schema record, so a pair whose twin the budget dropped gets
            // it back.
            events: withOmittedMarkers(timed ? normalizeSpans(events) : events, view.eventCount),
            ...(timed ? {} : { untimed: true as const }),
            ...(view.status ? { status: view.status } : {}),
            eventCount: view.eventCount,
            startedAt: view.startedAt,
            ...(view.receivedAt !== undefined ? { receivedAt: view.receivedAt } : {}),
            ...(view.finishedAt !== undefined ? { finishedAt: view.finishedAt } : {}),
            ...(view.sealedAt !== undefined ? { sealedAt: view.sealedAt } : {}),
            ...(view.replyOk !== undefined ? { replyOk: view.replyOk } : {}),
            ...(runDurationMs(view) !== undefined ? { durationMs: runDurationMs(view) } : {}),
            ...(view.truncated !== undefined ? { truncated: view.truncated } : {}),
            // Tokenless: the files are read under the same decision as this page (item 26).
            ...artifactsSeed(route.id),
          }),
        );
        return;
      }
      serveHistoryEvents(view.events ?? [], view.eventCount, nodeSseSink(req, res));
    });
    return true;
  };
}
