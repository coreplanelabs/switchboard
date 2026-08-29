import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { NAV_CSS, renderNav } from "./nav.js";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { IndexEvent, RunRegistry, RunSummary, Unsubscribe } from "../core/runRegistry.js";
import type { StopMode } from "../core/runEvents.js";
import { renderMarkdownInto } from "./markdownLite.js";

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

/** Human label for a run's stop status ("stopping (soft)", "stopped (hard)").
 *  Kept byte-identical to the client mirrors in both pages. */
function stopLabel(stop: NonNullable<RunSummary["stop"]>): string {
  return `${stop.state} (${stop.mode})`;
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
export const HTML_PAGE_HEADERS: Record<string, string> = {
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
 * The markdown renderer as browser source. `String(fn)` is the whole build step
 * — no bundler, no second copy of the code (see markdownLite.ts) — but the
 * source is whatever transpiled the module: under `tsx` (dev/CLI) esbuild's
 * keepNames wraps every nested function in a module-scoped `__name(...)` helper
 * that does not exist in the browser (seen live 2026-08-29: the page threw
 * `__name is not defined` on every markdown event). The no-op shim ahead of the
 * function satisfies that helper in both of its emitted shapes (a wrapper
 * returning the function, or a bare statement) and is inert under plain `tsc`.
 */
export const MARKDOWN_RENDERER_SCRIPT = `var __name = function (fn) { return fn; };\n${String(renderMarkdownInto)}`;

/**
 * The self-contained HTML page for one run: a readable timeline of the whole
 * run. Opens an EventSource to this run's token-scoped event stream and renders
 * each RunEvent as it arrives — `input` → the **Request** block above the log;
 * `assistant` → a prose row inline in the log; `tool_call` → a "running" row;
 * `tool_result` → ✓/✗ + its (already redacted) summary; `run_note` → a notice;
 * `answer` → the **Answer** block under the log. Every row/block leads with a
 * gray UTC `[HH:MM:SS]` from the event's `at`. All inline (CSP-safe): tool rows
 * are written with `textContent`, and the markdown surfaces (Request, Answer,
 * assistant rows) go through `renderMarkdownInto` — the safe-subset renderer
 * from markdownLite.ts, inlined here as `String(fn)` — which builds DOM only via
 * createElement/textContent/setAttribute (angle brackets are text, only http(s)
 * links become anchors). Nothing on this page ever assigns raw markup.
 *
 * `id`/`token` are JSON-encoded into the script — they are the only dynamic
 * values, and JSON.stringify neutralizes any `</script>`/quote breakout.
 */
export function renderRunPage(id: string, token: string): string {
  const eventsPath = `/runs/${encodeURIComponent(id)}/events?t=${encodeURIComponent(token)}`;
  // Stop control (#101): same token, POST-only; `&mode=` is appended client-side.
  const stopPath = `/runs/${encodeURIComponent(id)}/stop?t=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Live run</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #e6e6e6; padding: 1rem; max-width: 72rem; margin-inline: auto; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem;
    border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  a.back { color: #9ecbff; text-decoration: none; font-size: .8rem; }
  a.back:hover { text-decoration: underline; }
  ${NAV_CSS}
  .conn { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; }
  #state { font-size: .8rem; color: #8b93a7; }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%;
    background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: #d29922; }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  /* Timestamps: a small gray [HH:MM:SS] leading every row and both blocks. */
  .ts { color: #8b93a7; font-size: .75rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    flex: 0 0 auto; user-select: none; }
  /* Request / Answer: headed blocks, proportional type, above and below the log. */
  section.block { border: 1px solid #2a2f3a; border-radius: 8px; padding: .6rem .75rem; background: #0f1218; }
  section.block > h2 { display: flex; align-items: baseline; gap: .5rem; font-size: .8rem; margin: 0 0 .4rem;
    color: #8b93a7; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  #request { margin-bottom: .75rem; }
  #answer { margin-top: .75rem; border-color: #2ea04366; }
  #answer > h2 { color: #7ee787; }
  /* The timeline. Tool rows stay monospace; each row is [ts] + body. */
  #log { list-style: none; margin: 0; padding: 0; }
  #log > li { display: flex; gap: .6rem; align-items: baseline; padding: .3rem .5rem; border-radius: 6px;
    word-break: break-word; }
  #log > li + li { margin-top: .2rem; }
  #log > li .body { white-space: pre-wrap; min-width: 0; flex: 1 1 auto; }
  #log > li.call, #log > li.ok, #log > li.err, #log > li.note { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .call { color: #9ecbff; }
  .ok { color: #7ee787; }
  .err { color: #ff7b72; }
  .note { color: #d29922; background: #d2992214; }
  .empty { color: #8b93a7; }
  /* The model talking between tools: neutral off-white prose with a quiet left border. */
  #log > li.assistant { color: #d7dbe3; background: #12151c; border-left: 3px solid #3b4252; border-radius: 0 6px 6px 0;
    margin-top: .4rem; margin-bottom: .4rem; padding: .5rem .75rem; }
  /* Markdown surfaces: proportional type, tight vertical rhythm. */
  .md { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    white-space: pre-wrap; word-break: break-word; min-width: 0; flex: 1 1 auto; }
  .md p, .md ul, .md ol, .md pre, .md blockquote, .md h1, .md h2, .md h3 { margin: 0 0 .5rem; }
  .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3 { font-size: 1rem; font-weight: 600; color: #e6e6e6; text-transform: none; letter-spacing: 0; display: block; }
  .md h1 { font-size: 1.1rem; }
  .md ul, .md ol { padding-left: 1.4rem; white-space: normal; }
  .md ul { list-style: disc; } /* a top-level list inside an assistant row is nested in the row li — keep discs */
  .md ul ul { list-style: circle; }
  .md li { white-space: pre-wrap; }
  .md code { font: .85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #1b1f28; padding: .05em .3em; border-radius: 4px; }
  .md pre { background: #0b0d12; border: 1px solid #2a2f3a; border-radius: 6px; padding: .5rem .6rem; overflow-x: auto; white-space: pre; }
  .md pre code { background: none; padding: 0; font-size: .85em; }
  .md blockquote { border-left: 3px solid #3b4252; padding-left: .6rem; color: #b6bcc8; }
  .md a { color: #9ecbff; }
  .md strong { color: #fff; }
  .actions { display: inline-flex; gap: .4rem; }
  button.stop { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid #3b4252; background: #161b22; color: #e6e6e6; }
  button.stop.hard { border-color: #f85149; color: #ff7b72; }
  button.stop:disabled { opacity: .5; cursor: default; }
  [hidden] { display: none; }
</style>
</head>
<body>
<header>
  <a class="back" href="/runs">← All runs</a>
  <h1>Live run</h1>
  <span class="actions" id="actions">
    <button class="stop soft" data-mode="soft" title="Soft stop: no new steps, the agent writes up what it has">Stop</button>
    <button class="stop hard" data-mode="hard" title="Hard stop: abort now, no summary, free the sandbox">Kill</button>
  </span>
  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>
  ${renderNav("runs")}
</header>
<section class="block" id="request" hidden><h2><span>Request</span><span class="ts" id="requestts"></span></h2><div class="md" id="requesttext"></div></section>
<ul id="log"><li class="empty" id="placeholder"><span class="body">Waiting for activity…</span></li></ul>
<section class="block" id="answer" hidden><h2><span>Answer</span><span class="ts" id="answerts"></span></h2><div class="md" id="answertext"></div></section>
<script>
${MARKDOWN_RENDERER_SCRIPT}
(function () {
  var url = ${JSON.stringify(eventsPath)};
  var stopUrl = ${JSON.stringify(stopPath)};
  var log = document.getElementById("log");
  var requestBox = document.getElementById("request");
  var requestText = document.getElementById("requesttext");
  var requestTs = document.getElementById("requestts");
  var answerBox = document.getElementById("answer");
  var answerText = document.getElementById("answertext");
  var answerTs = document.getElementById("answerts");
  var state = document.getElementById("state");
  var stateDot = document.getElementById("statedot");
  var actions = document.getElementById("actions");
  var placeholder = document.getElementById("placeholder");
  // Set once a stop is requested (from the stream, so a viewer who didn't click
  // sees it too); the end frame then reads "stopped (mode)" not "finished".
  var stopMode = null;
  // Connection indicator: color the dot + set its label via classList/textContent
  // (never via raw markup). green = live, amber = connecting, red = disconnected,
  // grey = finished.
  function setConn(color, text) {
    stateDot.className = "dot " + color;
    state.textContent = text;
  }
  // UTC wall-clock label for an event's \`at\`; "" when the event carries none.
  function fmtTime(at) { return typeof at === "number" ? "[" + new Date(at).toISOString().slice(11, 19) + "] " : ""; }
  // One timeline row: a gray timestamp span, then a body the caller fills.
  // Everything is createElement + textContent — summaries are rendered as data.
  function startRow(cls, e) {
    if (placeholder) { placeholder.remove(); placeholder = null; }
    var li = document.createElement("li");
    li.className = cls;
    var ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = fmtTime(e.at);
    li.appendChild(ts);
    log.appendChild(li);
    return li;
  }
  function row(cls, e, text) {
    var li = startRow(cls, e);
    var body = document.createElement("span");
    body.className = "body";
    body.textContent = text;
    li.appendChild(body);
    li.scrollIntoView({ block: "nearest" });
  }
  // Every markdown surface renders through this guard: a renderer bug must cost
  // at most the formatting of ONE event, never the event or the stream — on any
  // throw the text is shown verbatim (textContent, still no markup).
  function md(target, text) {
    try { renderMarkdownInto(target, text); } catch (_) { target.textContent = text; }
  }
  // The model talking between tool calls: markdown through the safe renderer.
  function proseRow(e) {
    var li = startRow("assistant", e);
    var box = document.createElement("div");
    box.className = "md";
    li.appendChild(box);
    md(box, e.text);
    li.scrollIntoView({ block: "nearest" });
  }
  function markStopping(mode) {
    stopMode = mode;
    actions.hidden = true; // one request is enough; the stream shows the outcome
    setConn("amber", "stopping (" + mode + ")");
  }
  // Stop control (#101): POST the mode to this run's token-scoped stop route.
  // A hard stop is destructive (no summary, sandbox torn down) → confirm first.
  actions.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("button[data-mode]") : null;
    if (!btn) return;
    var mode = btn.getAttribute("data-mode");
    if (mode === "hard" && !window.confirm("Hard stop: abort the run now with no summary and free its sandbox?")) return;
    btn.disabled = true;
    fetch(stopUrl + "&mode=" + encodeURIComponent(mode), { method: "POST", credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); markStopping(mode); })
      .catch(function (err) { btn.disabled = false; setConn("red", "stop failed: " + (err && err.message ? err.message : "error")); });
  });
  var es = new EventSource(url);
  es.onopen = function () { if (!stopMode) setConn("green", "live"); };
  es.onmessage = function (m) {
    var e;
    try { e = JSON.parse(m.data); } catch (_) { return; }
    if (e.type === "input") {
      // The request, above the log — the first event of the record.
      requestTs.textContent = fmtTime(e.at);
      md(requestText, e.text);
      requestBox.hidden = false;
    } else if (e.type === "assistant") {
      proseRow(e);
    } else if (e.type === "tool_call") {
      row("call", e, "\\u2192 " + e.summary);
    } else if (e.type === "tool_result") {
      row(e.ok ? "ok" : "err", e, (e.ok ? "\\u2713 " : "\\u2717 ") + e.tool + ": " + e.summary);
    } else if (e.type === "run_note") {
      row("note", e, "\\u23f1 " + e.summary);
      if ((e.kind === "stop_requested" || e.kind === "stopped") && e.mode) markStopping(e.mode);
    } else if (e.type === "answer") {
      // The run's final answer — the same text the thread got, as markdown via
      // the safe renderer. Only bring it into view when the viewer is already at
      // the tail; someone reading earlier rows keeps their place (same rule as
      // log autoscroll).
      var atTail = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
      answerTs.textContent = fmtTime(e.at);
      md(answerText, e.text);
      answerBox.hidden = false;
      if (atTail) answerBox.scrollIntoView({ block: "nearest" });
    }
  };
  es.addEventListener("end", function () {
    actions.hidden = true;
    setConn("grey", stopMode ? "stopped (" + stopMode + ")" : "finished");
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
 *  can find and update it in place. The run's content is a single `<a>` (full-row
 *  clickable), leading with a colored status dot (green = live, grey = finished)
 *  that carries an accessible label since color alone isn't accessible, and — for
 *  a live run — a SIBLING `<span class="actions">` with the Stop/Kill buttons
 *  (#101; a button may not nest inside an anchor). A requested stop shows as a
 *  `stopping (mode)` / `stopped (mode)` badge inside the anchor. Every dynamic
 *  string is HTML-escaped and the href's id/token URL-encoded — a hostile label
 *  or id can break out of neither the markup nor the attribute. The client
 *  mirrors this exact shape via the DOM (createElement + textContent/setAttribute),
 *  so a row looks the same whether painted here or by an `upsert`. */
function indexRowHtml(r: RunSummary): string {
  const href = `/runs/${encodeURIComponent(r.id)}?t=${encodeURIComponent(r.token)}`;
  const label = escapeHtml(r.label ?? shortId(r.id));
  const dotClass = r.finished ? "grey" : "green"; // static — safe, not user input
  const dotWord = r.finished ? "finished" : "live";
  const badge = r.stop ? `<span class="stopbadge ${r.stop.state}">${escapeHtml(stopLabel(r.stop))}</span>` : "";
  // Buttons only while the run can still be stopped: live and not already asked.
  const actions =
    r.finished || r.stop
      ? ""
      : `<span class="actions">` +
        `<button class="stop soft" data-mode="soft" title="Soft stop: no new steps, the agent writes up what it has">Stop</button>` +
        `<button class="stop hard" data-mode="hard" title="Hard stop: abort now, no summary, free the sandbox">Kill</button>` +
        `</span>`;
  return (
    `<li data-run-id="${escapeHtml(r.id)}" data-started-at="${r.startedAt}">` +
    `<a class="row" href="${escapeHtml(href)}">` +
    `<span class="dot ${dotClass}" role="img" aria-label="${dotWord}" title="${dotWord}"></span>` +
    `<span class="label">${label}</span>` +
    `<span class="meta">${escapeHtml(eventCountLabel(r.eventCount))}</span>` +
    badge +
    `</a>${actions}</li>`
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
  ${NAV_CSS}
  #runs { list-style: none; margin: 0; padding: 0; }
  #runs li { border-radius: 6px; display: flex; align-items: center; gap: .5rem; }
  /* The empty sentinel is an <li> too: this must outrank the flex rule above,
     or "No active runs." shows beside live rows (seen live 2026-08-29). */
  #runs li[hidden] { display: none; }
  #runs li + li { border-top: 1px solid #1b1f28; }
  /* The run's row is the link (full-row clickable), with a clear hover bg; the
     stop buttons sit beside it as a sibling (a button can't live in an anchor). */
  #runs a.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; flex: 1 1 auto;
    padding: .45rem .5rem; border-radius: 6px; color: inherit; text-decoration: none; }
  #runs a.row:hover { background: #161b22; }
  #runs a.row .label { color: #9ecbff; font-weight: 600; }
  .meta { font-size: .75rem; color: #8b93a7; }
  .stopbadge { font-size: .75rem; color: #d29922; }
  .stopbadge.stopped { color: #8b93a7; }
  .actions { display: inline-flex; gap: .4rem; flex: 0 0 auto; padding-right: .5rem; }
  button.stop { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid #3b4252; background: #161b22; color: #e6e6e6; }
  button.stop.hard { border-color: #f85149; color: #ff7b72; }
  button.stop:disabled { opacity: .5; cursor: default; }
  .empty { color: #8b93a7; padding: .45rem .5rem; }
  [hidden] { display: none; }
</style>
</head>
<body>
<header>
  <h1>Live runs</h1>
  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>
  ${renderNav("runs")}
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
  // The latest summary per run id — the stop buttons need the row's token.
  var runs = Object.create(null);
  var seeded = list.querySelectorAll("li[data-run-id]");
  for (var i = 0; i < seeded.length; i++) rows[seeded[i].getAttribute("data-run-id")] = seeded[i];

  function runHref(run) {
    return "/runs/" + encodeURIComponent(run.id) + "?t=" + encodeURIComponent(run.token);
  }
  function stopHref(run, mode) {
    return "/runs/" + encodeURIComponent(run.id) + "/stop?t=" + encodeURIComponent(run.token) + "&mode=" + encodeURIComponent(mode);
  }
  function shortId(id) { return id.length > 8 ? id.slice(0, 8) + "\\u2026" : id; }
  function countLabel(n) { return n + (n === 1 ? " event" : " events"); }
  function stopLabel(stop) { return stop.state + " (" + stop.mode + ")"; }
  function stopButton(mode, text, title) {
    var b = document.createElement("button");
    b.className = "stop " + mode;
    b.setAttribute("data-mode", mode);
    b.setAttribute("title", title);
    b.textContent = text;
    return b;
  }

  // Rebuild a row's contents from a run summary using createElement +
  // textContent/setAttribute only (no raw-markup assignment), so a hostile
  // label/id is rendered as data. Mirrors the server's shape: one <a class="row">
  // led by an accessible status dot (+ a stop badge once requested), then — for
  // a stoppable run — a sibling <span class="actions"> with Stop/Kill.
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
    if (run.stop) {
      var badge = document.createElement("span");
      badge.className = "stopbadge " + run.stop.state;
      badge.textContent = stopLabel(run.stop);
      a.appendChild(badge);
    }
    li.appendChild(a);
    if (!run.finished && !run.stop) {
      var actions = document.createElement("span");
      actions.className = "actions";
      actions.appendChild(stopButton("soft", "Stop", "Soft stop: no new steps, the agent writes up what it has"));
      actions.appendChild(stopButton("hard", "Kill", "Hard stop: abort now, no summary, free the sandbox"));
      li.appendChild(actions);
    }
  }
  // Stop control (#101), delegated from the list: POST the mode to the row's
  // token-scoped stop route; the registry's index upsert then repaints the row
  // as "stopping". A hard stop is destructive → confirm first.
  list.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("button[data-mode]") : null;
    if (!btn) return;
    var li = btn.closest("li[data-run-id]");
    var run = li && runs[li.getAttribute("data-run-id")];
    if (!run) return;
    var mode = btn.getAttribute("data-mode");
    if (mode === "hard" && !window.confirm("Hard stop: abort this run now with no summary and free its sandbox?")) return;
    btn.disabled = true;
    fetch(stopHref(run, mode), { method: "POST", credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); })
      .catch(function () { btn.disabled = false; });
  });
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
    runs[run.id] = run;
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
    delete runs[id];
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
 * request (so the server stops routing), `false` to fall through. Every read
 * route is GET-only and the one write route is POST-only (405 otherwise):
 *   GET  /runs                          → the runs index HTML page (Access-gated, NOT token-gated)
 *   GET  /runs?stream=1                 → the live runs-index SSE feed (Access-gated, NOT token-gated)
 *   GET  /runs/:id?t=…                  → the HTML page (404 on bad/missing token)
 *   GET  /runs/:id/events?t=…           → the SSE stream (404 on bad/missing token)
 *   GET  /runs/:id/friction?t=…         → the friction diagnosis JSON (404 on bad/missing token)
 *   POST /runs/:id/stop?t=…&mode=soft|hard → ask the run to stop (#101): 200 JSON, 400 bad
 *        mode, 404 bad/missing token or unknown run, 409 already finished
 * The per-run routes are token-gated via the registry; the index (page AND
 * feed) is not — Cloudflare Access fronts it, and it renders the per-run
 * capability links. The stop route sits behind BOTH gates: Access at the edge
 * (index.ts gates every method under /runs*) and the run's token here.
 * `?stream=1` (a query flag, not a new path) selects the feed so it never
 * collides with `/runs/<id>` where an id could legitimately be "events" or
 * "stream".
 */
export function createLiveViewHandler(
  registry: RunRegistry,
): (req: HttpRequest, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = parseRunRoute(url.pathname);
    if (!route) return false;

    const method = (req.method ?? "GET").toUpperCase();
    const allow = route.kind === "stop" ? "POST" : "GET";
    if (method !== allow) {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow });
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

    // Run control (#101): the only write. Mode is validated BEFORE the token is
    // checked so a malformed request is a plain 400 with no registry lookup;
    // the token gate then answers 404 for wrong token AND unknown run alike
    // (never reveal which), and a finished run is a 409. Never throws: the
    // registry call is total, and the run loop observes the control on its
    // own schedule — this request only records the ask.
    if (route.kind === "stop") {
      const mode = parseStopMode(url.searchParams.get("mode"));
      if (!mode) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("mode must be soft or hard");
        return true;
      }
      const result = registry.requestStop(route.id, token, mode);
      if (!result.ok) {
        const [status, body] = result.reason === "finished" ? [409, "run already finished"] : [404, "run not found"];
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        res.end(body);
        return true;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ id: route.id, mode: result.mode, state: "stopping" }));
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
