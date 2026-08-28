import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { IndexEvent, RunRegistry, RunSummary, Unsubscribe } from "../core/runRegistry.js";

// Live-view channel: the external, browser-facing surface for a live agent run
// (Area 2 / #43). It streams the SAME redacted RunEvents the in-channel status
// card consumes, over Server-Sent Events, to a minimal self-contained page.
//
// Auth is a per-run CAPABILITY TOKEN, not a bearer header: a plain browser
// navigation can't send an Authorization header, so the token rides in the URL
// (`/runs/:id?t=…`) and is validated (constant-time) by the registry for BOTH
// the page and the event stream. A wrong/missing token — or an unknown run — is
// a 404 (never reveal existence). Events are already redacted + capped upstream
// (runEvents.ts); this layer adds no data and re-exposes nothing.
//
// SSE (not WebSocket) because the flow is strictly one-directional server→page,
// EventSource auto-reconnects, and it needs no handshake or extra dependency.
//
// Handlers are split from transport so the logic is unit-testable without a
// socket: `parseRunRoute` (pure), `renderRunPage` (pure string), and
// `serveEvents` (drives an abstract SseSink). `createLiveViewHandler` is the
// thin node:http wrapper.

/** Which live-view route a path is, if any. The bare `/runs` index carries no
 *  id (it is Access-gated, not token-gated); the per-run page/events routes do. */
export type RunRoute = { kind: "index" } | { id: string; kind: "page" | "events" | "friction" };

/** Match the bare index (`/runs`, `/runs/`), a per-run page (`/runs/:id`), a
 *  per-run SSE stream (`/runs/:id/events`), or a per-run friction diagnosis
 *  (`/runs/:id/friction`). Path only — the token is a query param, read
 *  separately. Returns null for anything else so the server can fall through
 *  to its other routes. */
export function parseRunRoute(pathname: string): RunRoute | null {
  if (pathname === "/runs" || pathname === "/runs/") return { kind: "index" };
  const m = /^\/runs\/([^/]+)(?:\/(events|friction))?\/?$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding → not a valid run route
  }
  if (id === "") return null;
  return { id, kind: m[2] === "events" ? "events" : m[2] === "friction" ? "friction" : "page" };
}

/** Content-Security-Policy for the run page: everything self/inline only, no
 *  external or CDN assets. `connect-src 'self'` allows the same-origin
 *  EventSource; `frame-ancestors 'none'` blocks the page being iframed
 *  (clickjacking), since `default-src 'none'` does NOT cover frame-ancestors. */
const PAGE_CSP =
  "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Response headers shared by every HTML surface here (the per-run page AND the
 *  runs index): the strict CSP, both clickjacking defenses (`frame-ancestors`
 *  in CSP + the legacy `X-Frame-Options`), and `no-store` so no proxy or browser
 *  caches a page that carries capability tokens. One constant so the two
 *  surfaces are provably identical. */
const HTML_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": PAGE_CSP,
  "x-frame-options": "DENY", // belt-and-suspenders with CSP frame-ancestors
  "cache-control": "no-store",
};

/** SSE response headers. `no-transform` + `x-accel-buffering: no` keep proxies
 *  from buffering the stream, so events arrive as they are written. */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * The self-contained HTML page for one run. Opens an EventSource to this run's
 * token-scoped event stream and renders each RunEvent as it arrives:
 * `tool_call` → a "running" row; `tool_result` → ✓/✗ + its (already redacted)
 * summary. All inline (CSP-safe); summaries are written with `textContent`
 * (never innerHTML), so a summary can never inject markup.
 *
 * `id`/`token` are JSON-encoded into the script — they are the only dynamic
 * values, and JSON.stringify neutralizes any `</script>`/quote breakout.
 */
export function renderRunPage(id: string, token: string): string {
  const eventsPath = `/runs/${encodeURIComponent(id)}/events?t=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Live run</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #e6e6e6; padding: 1rem; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem;
    border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  a.back { color: #9ecbff; text-decoration: none; font-size: .8rem; }
  a.back:hover { text-decoration: underline; }
  .conn { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; }
  #state { font-size: .8rem; color: #8b93a7; }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%;
    background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: #d29922; }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  #log { list-style: none; margin: 0; padding: 0; }
  #log li { padding: .3rem .5rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  #log li + li { margin-top: .25rem; }
  .call { color: #9ecbff; }
  .ok { color: #7ee787; }
  .err { color: #ff7b72; }
  .note { color: #d29922; }
  .empty { color: #8b93a7; }
</style>
</head>
<body>
<header>
  <a class="back" href="/runs">← All runs</a>
  <h1>Live run</h1>
  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>
</header>
<ul id="log"><li class="empty" id="placeholder">Waiting for activity…</li></ul>
<script>
(function () {
  var url = ${JSON.stringify(eventsPath)};
  var log = document.getElementById("log");
  var state = document.getElementById("state");
  var stateDot = document.getElementById("statedot");
  var placeholder = document.getElementById("placeholder");
  // Connection indicator: color the dot + set its label via classList/textContent
  // (never via raw markup). green = live, amber = connecting, red = disconnected,
  // grey = finished.
  function setConn(color, text) {
    stateDot.className = "dot " + color;
    state.textContent = text;
  }
  function row(cls, text) {
    if (placeholder) { placeholder.remove(); placeholder = null; }
    var li = document.createElement("li");
    li.className = cls;
    li.textContent = text; // textContent only — summaries are rendered as data
    log.appendChild(li);
    li.scrollIntoView({ block: "nearest" });
  }
  var es = new EventSource(url);
  es.onopen = function () { setConn("green", "live"); };
  es.onmessage = function (m) {
    var e;
    try { e = JSON.parse(m.data); } catch (_) { return; }
    if (e.type === "tool_call") {
      row("call", "\\u2192 " + e.summary);
    } else if (e.type === "tool_result") {
      row(e.ok ? "ok" : "err", (e.ok ? "\\u2713 " : "\\u2717 ") + e.tool + ": " + e.summary);
    } else if (e.type === "run_note") {
      row("note", "\\u23f1 " + e.summary);
    }
  };
  es.addEventListener("end", function () {
    setConn("grey", "finished");
    es.close();
  });
  es.onerror = function () {
    if (es.readyState === EventSource.CLOSED) setConn("red", "disconnected");
  };
})();
</script>
</body>
</html>`;
}

/** HTML-escape a dynamic string for safe interpolation into server-rendered
 *  markup — `&` first so the entities it introduces aren't double-escaped, then
 *  the tag and quote characters. The per-run page renders event summaries client
 *  side with `textContent`; the runs index is server-rendered, so every dynamic
 *  string it emits (a run label may derive from a thread/repo name) MUST pass
 *  through here — otherwise a `<script>` in a label would inject. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Short, display-only fallback for a run with no label: the first 8 chars of
 *  its (unguessable) id, ellipsized. Kept byte-identical to the client mirror in
 *  `renderRunsIndex` so a server-rendered row and its later live upsert agree. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** One live-count label for a run's event tally ("1 event" / "N events"). */
function eventCountLabel(n: number): string {
  return `${n} event${n === 1 ? "" : "s"}`;
}

/** Server-rendered markup for one index row, keyed `data-run-id` so the client
 *  can find and update it in place. The ENTIRE row is a single `<a>` (full-row
 *  clickable), leading with a colored status dot (green = live, grey = finished)
 *  that carries an accessible label since color alone isn't accessible. Every
 *  dynamic string is HTML-escaped and the href's id/token URL-encoded — a hostile
 *  label or id can break out of neither the markup nor the attribute. The client
 *  mirrors this exact shape via the DOM (createElement + textContent/setAttribute),
 *  so a row looks the same whether painted here or by an `upsert`. */
function indexRowHtml(r: RunSummary): string {
  const href = `/runs/${encodeURIComponent(r.id)}?t=${encodeURIComponent(r.token)}`;
  const label = escapeHtml(r.label ?? shortId(r.id));
  const dotClass = r.finished ? "grey" : "green"; // static — safe, not user input
  const dotWord = r.finished ? "finished" : "live";
  return (
    `<li data-run-id="${escapeHtml(r.id)}" data-started-at="${r.startedAt}">` +
    `<a class="row" href="${escapeHtml(href)}">` +
    `<span class="dot ${dotClass}" role="img" aria-label="${dotWord}" title="${dotWord}"></span>` +
    `<span class="label">${label}</span>` +
    `<span class="meta">${escapeHtml(eventCountLabel(r.eventCount))}</span>` +
    `</a></li>`
  );
}

/**
 * The Access-gated runs index (`GET /runs`): a self-contained, **live** HTML page
 * listing every non-evicted run, each linking to its per-run page WITH that run's
 * capability token in the URL. The initial snapshot is server-rendered (fast
 * first paint); an inline `EventSource("/runs?stream=1")` then keeps it live —
 * rows appear, update (activity/finish), and disappear (eviction) without a
 * refresh, driven by `IndexEvent`s from the shared registry (so runs from every
 * channel show up). Unlike the per-run page/stream, the index has NO token gate —
 * Cloudflare Access is the "who" gate in front of it. Because it renders the
 * capability links, it must ONLY be exposed behind Access; without Access it would
 * leak every live-run link (see features/live-view.md).
 *
 * CSP-safe (inline-only, no external assets). Server-rendered rows escape every
 * dynamic string via `escapeHtml` and URL-encode the href; the client updates
 * exclusively via `textContent`/`setAttribute` (never `innerHTML`), so a hostile
 * label or id cannot inject markup or break out of the link on either path.
 */
export function renderRunsIndex(runs: RunSummary[]): string {
  const rows = runs.map(indexRowHtml).join("");
  // The empty-state <li> always exists; it is only visible when the list has no
  // run rows (server-side here, and toggled client-side as rows come and go).
  const emptyHidden = runs.length === 0 ? "" : " hidden";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Live runs</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #e6e6e6; padding: 1rem; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem;
    border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  .conn { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; }
  #state { font-size: .8rem; color: #8b93a7; }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%;
    background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: #d29922; }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  #runs { list-style: none; margin: 0; padding: 0; }
  #runs li { border-radius: 6px; }
  #runs li + li { border-top: 1px solid #1b1f28; }
  /* The whole row is the link (full-row clickable), with a clear hover bg. */
  #runs a.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
    padding: .45rem .5rem; border-radius: 6px; color: inherit; text-decoration: none; }
  #runs a.row:hover { background: #161b22; }
  #runs a.row .label { color: #9ecbff; font-weight: 600; }
  .meta { font-size: .75rem; color: #8b93a7; }
  .empty { color: #8b93a7; padding: .45rem .5rem; }
  [hidden] { display: none; }
</style>
</head>
<body>
<header>
  <h1>Live runs</h1>
  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>
</header>
<ul id="runs">${rows}<li class="empty" id="empty"${emptyHidden}>No active runs.</li></ul>
<script>
(function () {
  var list = document.getElementById("runs");
  var empty = document.getElementById("empty");
  var state = document.getElementById("state");
  var stateDot = document.getElementById("statedot");
  // Connection indicator: color the dot + set its label via classList/textContent
  // (never via raw markup). green = live, amber = connecting, red = disconnected.
  function setConn(color, text) {
    stateDot.className = "dot " + color;
    state.textContent = text;
  }
  // Rows keyed by run id — avoids building CSS selectors from (untrusted) ids.
  var rows = Object.create(null);
  var seeded = list.querySelectorAll("li[data-run-id]");
  for (var i = 0; i < seeded.length; i++) rows[seeded[i].getAttribute("data-run-id")] = seeded[i];

  function runHref(run) {
    return "/runs/" + encodeURIComponent(run.id) + "?t=" + encodeURIComponent(run.token);
  }
  function shortId(id) { return id.length > 8 ? id.slice(0, 8) + "\\u2026" : id; }
  function countLabel(n) { return n + (n === 1 ? " event" : " events"); }

  // Rebuild a row's contents from a run summary using createElement +
  // textContent/setAttribute only (no raw-markup assignment), so a hostile
  // label/id is rendered as data. Mirrors the server's full-row shape: the whole
  // row is one <a class="row">, led by an accessible status dot.
  function fill(li, run) {
    li.setAttribute("data-run-id", run.id);
    li.setAttribute("data-started-at", String(run.startedAt)); // drives sorted insert
    li.textContent = ""; // clear any prior children (server-rendered or stale)
    var a = document.createElement("a");
    a.className = "row";
    a.setAttribute("href", runHref(run));
    var dotWord = run.finished ? "finished" : "live";
    var dot = document.createElement("span");
    dot.className = "dot " + (run.finished ? "grey" : "green");
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", dotWord);
    dot.setAttribute("title", dotWord);
    a.appendChild(dot);
    var label = document.createElement("span");
    label.className = "label";
    label.textContent = run.label || shortId(run.id);
    a.appendChild(label);
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = countLabel(run.eventCount);
    a.appendChild(meta);
    li.appendChild(a);
  }
  function refreshEmpty() {
    var has = false;
    for (var k in rows) { has = true; break; }
    empty.hidden = has;
  }
  // Insert a new row in newest-first position by startedAt, so rows land
  // correctly whether they arrive via the replay (newest-first) or as live new
  // runs — a blind prepend would invert any batch that isn't server-seeded.
  // Existing rows are never repositioned (startedAt is immutable), so an update
  // never reorders the list.
  function insertSorted(li, startedAt) {
    var kids = list.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === empty) break; // real rows sit above the empty sentinel
      if (startedAt >= Number(k.getAttribute("data-started-at"))) {
        list.insertBefore(li, k);
        return;
      }
    }
    list.insertBefore(li, empty); // oldest so far (or empty list) → above the sentinel
  }
  function upsert(run) {
    var li = rows[run.id];
    if (li) {
      fill(li, run); // update in place — startedAt is immutable, so position holds
    } else {
      li = document.createElement("li");
      rows[run.id] = li;
      fill(li, run);
      insertSorted(li, run.startedAt);
    }
    refreshEmpty();
  }
  function remove(id) {
    var li = rows[id];
    if (li && li.parentNode) li.parentNode.removeChild(li);
    delete rows[id];
    refreshEmpty();
  }

  var es = new EventSource("/runs?stream=1");
  es.onopen = function () { setConn("green", "live"); };
  es.onmessage = function (m) {
    var ev;
    try { ev = JSON.parse(m.data); } catch (_) { return; }
    if (ev.type === "upsert" && ev.run) upsert(ev.run);
    else if (ev.type === "removed" && ev.id) remove(ev.id);
  };
  es.onerror = function () {
    if (es.readyState === EventSource.CLOSED) setConn("red", "disconnected");
    else setConn("amber", "connecting\\u2026");
  };
})();
</script>
</body>
</html>`;
}

/** A minimal, transport-free sink for an SSE response, so `serveEvents` is
 *  unit-testable without a real socket. `onClose` registers a callback for when
 *  the client disconnects (used to unsubscribe). */
export interface SseSink {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
  onClose(cb: () => void): void;
}

/** One SSE `data:` frame for a run event. */
function sseData(event: RunEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** The terminal `end` frame the page listens for to close its EventSource. */
const SSE_END = "event: end\ndata: {}\n\n";

/** First bytes of every SSE response, written right after the 200 head and before
 *  any buffered replay. It exists to FLUSH THE HEAD immediately: when there is
 *  nothing to replay yet (an empty runs index, or a run with no events), a proxy
 *  that waits for the first body byte before forwarding the response holds the
 *  head, and the browser's EventSource is stuck "connecting" (never fires
 *  `onopen`). A lone `retry:` directive is valid SSE, is ignored as data by
 *  EventSource (it only sets the reconnect backoff), and gives the proxy a byte
 *  to forward. */
const SSE_PRELUDE = "retry: 3000\n\n";

/** Idle keepalive interval (ms). Cloudflare (and most proxies) drop a connection
 *  with no bytes for ~100s; a run-less index or an idle run would otherwise be
 *  silently disconnected. */
const SSE_HEARTBEAT_MS = 20_000;

/** Start a periodic SSE comment on a live stream so an idle connection stays open
 *  and dropped clients are detected. Unref'd so it never keeps the process alive;
 *  cleared when the client disconnects (and if a write ever throws). node:http
 *  only — the transport-free `serve*` fns stay timer-free for unit tests. */
function startSseHeartbeat(req: HttpRequest, res: ServerResponse): void {
  const hb = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {
      clearInterval(hb);
    }
  }, SSE_HEARTBEAT_MS);
  (hb as { unref?: () => void }).unref?.();
  req.on("close", () => clearInterval(hb));
}

/**
 * Serve one run's event stream to an SseSink, given a bound `subscribe` fn
 * (already carrying the run id + token — token validation lives in the
 * registry). Ordering matters: the registry replays the backlog synchronously
 * during `subscribe`, before we've decided the status code, so those frames are
 * buffered and flushed only after a 200 head is written. A `null` subscribe
 * result (unknown run or bad token) is a 404 — existence is never revealed.
 */
export function serveEvents(
  subscribe: (onEvent: (e: RunEvent) => void, onFinish: () => void) => Unsubscribe | null,
  sink: SseSink,
  onLive?: () => void,
): void {
  const buffered: string[] = [];
  let live = false;
  let endedDuringReplay = false;
  const send = (chunk: string) => {
    if (live) sink.write(chunk);
    else buffered.push(chunk);
  };
  const onFinish = () => {
    send(SSE_END);
    if (live) sink.end();
    else endedDuringReplay = true;
  };

  const unsubscribe = subscribe((e) => send(sseData(e)), onFinish);
  if (!unsubscribe) {
    sink.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    sink.write("run not found");
    sink.end();
    return;
  }

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE); // flush the head immediately (a run with no events yet has an empty backlog)
  for (const chunk of buffered) sink.write(chunk);
  buffered.length = 0;
  if (endedDuringReplay) {
    sink.end();
    return;
  }
  sink.onClose(unsubscribe);
  onLive?.(); // stream stays open → safe to start the keepalive heartbeat
}

/** One SSE `data:` frame for an index event (upsert/removed). */
function sseIndexData(ev: IndexEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/**
 * Serve the live runs-index feed (`GET /runs?stream=1`) to an SseSink, given a
 * bound `subscribeIndex`. Mirrors `serveEvents`: the registry replays the current
 * active set synchronously during `subscribeIndex` (before the status is chosen),
 * so those frames are buffered and flushed only after the 200 head; new events
 * live-forward. A client disconnect unsubscribes.
 *
 * Two deliberate differences from the per-run stream: there is **no token gate**
 * (the index is Access-gated at the edge, never token-gated — so it always 200s
 * and streams), and there is **no terminal `end` frame** — the index feed spans
 * the whole registry and stays open; a finished run is an `upsert` (finished),
 * and an evicted one a `removed`, not a stream close.
 */
export function serveIndexEvents(
  subscribeIndex: (onEvent: (ev: IndexEvent) => void) => Unsubscribe,
  sink: SseSink,
  onLive?: () => void,
): void {
  const buffered: string[] = [];
  let live = false;
  const send = (chunk: string) => {
    if (live) sink.write(chunk);
    else buffered.push(chunk);
  };

  const unsubscribe = subscribeIndex((ev) => send(sseIndexData(ev)));

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE); // flush the head immediately so onopen fires even with no active runs
  for (const chunk of buffered) sink.write(chunk);
  buffered.length = 0;
  sink.onClose(unsubscribe);
  onLive?.(); // stream stays open → safe to start the keepalive heartbeat
}

/** Wrap a node ServerResponse/request pair as an SseSink. */
function nodeSseSink(req: HttpRequest, res: ServerResponse): SseSink {
  return {
    writeHead: (status, headers) => void res.writeHead(status, headers),
    write: (chunk) => void res.write(chunk),
    end: () => void res.end(),
    onClose: (cb) => void req.on("close", cb),
  };
}

/**
 * node:http handler for the live-view routes. Returns `true` if it owned the
 * request (so the server stops routing), `false` to fall through. All routes are
 * GET-only (405 otherwise):
 *   GET /runs                 → the runs index HTML page (Access-gated, NOT token-gated)
 *   GET /runs?stream=1        → the live runs-index SSE feed (Access-gated, NOT token-gated)
 *   GET /runs/:id?t=…         → the HTML page (404 on bad/missing token)
 *   GET /runs/:id/events?t=…  → the SSE stream (404 on bad/missing token)
 * The two per-run routes are token-gated via the registry; the index (page AND
 * feed) is not — Cloudflare Access fronts it, and it renders the per-run
 * capability links. `?stream=1` (a query flag, not a new path) selects the feed
 * so it never collides with `/runs/<id>` where an id could legitimately be
 * "events" or "stream".
 */
export function createLiveViewHandler(
  registry: RunRegistry,
): (req: HttpRequest, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseRunRoute(url.pathname);
    if (!route) return false;

    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET" });
      res.end("method not allowed");
      return true;
    }

    // The bare index has NO token gate — Cloudflare Access is the "who" gate in
    // front of it. It renders the per-run capability links, so it must only be
    // exposed behind Access (see features/live-view.md). `?stream=1` selects the
    // live SSE feed; otherwise the (initial-snapshot) HTML page.
    if (route.kind === "index") {
      if (url.searchParams.get("stream") === "1") {
        serveIndexEvents(
          (onEvent) => registry.subscribeIndex(onEvent),
          nodeSseSink(req, res),
          () => startSseHeartbeat(req, res),
        );
        return true;
      }
      res.writeHead(200, HTML_PAGE_HEADERS);
      res.end(renderRunsIndex(registry.listActive()));
      return true;
    }

    const token = url.searchParams.get("t") ?? "";

    if (route.kind === "page") {
      if (!registry.has(route.id, token)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("run not found");
        return true;
      }
      res.writeHead(200, HTML_PAGE_HEADERS);
      res.end(renderRunPage(route.id, token));
      return true;
    }

    // Read-only friction diagnosis of the run's retained backlog (#84): same
    // token gate → 404; JSON, never cached. Works mid-run (a diagnosis so far)
    // and for a finished run still within the TTL.
    if (route.kind === "friction") {
      const snap = registry.snapshot(route.id, token);
      if (!snap) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("run not found");
        return true;
      }
      const diagnosis = analyzeRunFriction(snap.events, { finished: snap.finished });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ id: route.id, finished: snap.finished, diagnosis }));
      return true;
    }

    // route.kind === "events"
    serveEvents(
      (onEvent, onFinish) => registry.subscribe(route.id, token, onEvent, onFinish),
      nodeSseSink(req, res),
      () => startSseHeartbeat(req, res),
    );
    return true;
  };
}
