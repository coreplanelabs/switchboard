import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { RunEvent } from "../core/runEvents.js";
import type { RunRegistry, RunSummary, Unsubscribe } from "../core/runRegistry.js";

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
export type RunRoute = { kind: "index" } | { id: string; kind: "page" | "events" };

/** Match the bare index (`/runs`, `/runs/`), a per-run page (`/runs/:id`), or a
 *  per-run SSE stream (`/runs/:id/events`). Path only — the token is a query
 *  param, read separately. Returns null for anything else so the server can
 *  fall through to its other routes. */
export function parseRunRoute(pathname: string): RunRoute | null {
  if (pathname === "/runs" || pathname === "/runs/") return { kind: "index" };
  const m = /^\/runs\/([^/]+)(\/events)?\/?$/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding → not a valid run route
  }
  if (id === "") return null;
  return { id, kind: m[2] ? "events" : "page" };
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
  #state { font-size: .8rem; color: #8b93a7; }
  #log { list-style: none; margin: 0; padding: 0; }
  #log li { padding: .3rem .5rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  #log li + li { margin-top: .25rem; }
  .call { color: #9ecbff; }
  .ok { color: #7ee787; }
  .err { color: #ff7b72; }
  .empty { color: #8b93a7; }
</style>
</head>
<body>
<header>
  <h1>Live run</h1>
  <span id="state">connecting…</span>
</header>
<ul id="log"><li class="empty" id="placeholder">Waiting for activity…</li></ul>
<script>
(function () {
  var url = ${JSON.stringify(eventsPath)};
  var log = document.getElementById("log");
  var state = document.getElementById("state");
  var placeholder = document.getElementById("placeholder");
  function row(cls, text) {
    if (placeholder) { placeholder.remove(); placeholder = null; }
    var li = document.createElement("li");
    li.className = cls;
    li.textContent = text; // textContent only — summaries are rendered as data
    log.appendChild(li);
    li.scrollIntoView({ block: "nearest" });
  }
  var es = new EventSource(url);
  es.onopen = function () { state.textContent = "live"; };
  es.onmessage = function (m) {
    var e;
    try { e = JSON.parse(m.data); } catch (_) { return; }
    if (e.type === "tool_call") {
      row("call", "\\u2192 " + e.summary);
    } else if (e.type === "tool_result") {
      row(e.ok ? "ok" : "err", (e.ok ? "\\u2713 " : "\\u2717 ") + e.tool + ": " + e.summary);
    }
  };
  es.addEventListener("end", function () {
    state.textContent = "finished";
    es.close();
  });
  es.onerror = function () {
    if (es.readyState === EventSource.CLOSED) state.textContent = "disconnected";
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

/**
 * The Access-gated runs index (`GET /runs`): a self-contained HTML page listing
 * every non-evicted run, each linking to its per-run page WITH that run's
 * capability token in the URL. Unlike the per-run page/stream, the index has NO
 * token gate — Cloudflare Access is the "who" gate in front of it. Because it
 * renders the capability links, it must ONLY be exposed behind Access; without
 * Access it would leak every live run link (see features/live-view.md).
 *
 * Pure and CSP-safe (same inline-only, no-external-asset style as the per-run
 * page). Every dynamic string — labels AND ids — is HTML-escaped via
 * `escapeHtml`, and the href's id/token are URL-encoded, so a hostile label or
 * id cannot break out of the markup or the attribute.
 */
export function renderRunsIndex(runs: RunSummary[]): string {
  const rows =
    runs.length === 0
      ? `<li class="empty">No active runs.</li>`
      : runs
          .map((r) => {
            const href = `/runs/${encodeURIComponent(r.id)}?t=${encodeURIComponent(r.token)}`;
            const label = escapeHtml(r.label ?? r.id);
            const state = r.finished
              ? `<span class="badge done">finished</span>`
              : `<span class="badge live">live</span>`;
            const count = `${r.eventCount} event${r.eventCount === 1 ? "" : "s"}`;
            return (
              `<li><a href="${escapeHtml(href)}">${label}</a> ${state}` +
              `<span class="meta">${escapeHtml(r.id)} · ${escapeHtml(count)}</span></li>`
            );
          })
          .join("");
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
  #runs { list-style: none; margin: 0; padding: 0; }
  #runs li { padding: .45rem .5rem; border-radius: 6px; display: flex; align-items: baseline;
    gap: .6rem; flex-wrap: wrap; }
  #runs li + li { margin-top: .25rem; border-top: 1px solid #1b1f28; }
  #runs a { color: #9ecbff; text-decoration: none; font-weight: 600; }
  #runs a:hover { text-decoration: underline; }
  .badge { font-size: .7rem; padding: .05rem .4rem; border-radius: 999px; }
  .badge.live { color: #7ee787; border: 1px solid #2ea043; }
  .badge.done { color: #8b93a7; border: 1px solid #2a2f3a; }
  .meta { font-size: .75rem; color: #8b93a7; }
  .empty { color: #8b93a7; }
</style>
</head>
<body>
<header>
  <h1>Live runs</h1>
</header>
<ul id="runs">${rows}</ul>
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
  for (const chunk of buffered) sink.write(chunk);
  buffered.length = 0;
  if (endedDuringReplay) {
    sink.end();
    return;
  }
  sink.onClose(unsubscribe);
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
 *   GET /runs                 → the runs index (Access-gated, NOT token-gated)
 *   GET /runs/:id?t=…         → the HTML page (404 on bad/missing token)
 *   GET /runs/:id/events?t=…  → the SSE stream (404 on bad/missing token)
 * The two per-run routes are token-gated via the registry; the index is not —
 * Cloudflare Access fronts it, and it renders the per-run capability links.
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
    // exposed behind Access (see features/live-view.md).
    if (route.kind === "index") {
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

    // route.kind === "events"
    serveEvents(
      (onEvent, onFinish) => registry.subscribe(route.id, token, onEvent, onFinish),
      nodeSseSink(req, res),
    );
    return true;
  };
}
