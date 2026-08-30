import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { NAV_CSS, renderNav } from "./nav.js";
import { serializedOnce, type RunEvent, type StopMode } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunStatus } from "../core/runRecord.js";
import { STORE_UNAVAILABLE_BANNER } from "../core/commandRegistry.js";
import type { IndexEvent, RunRegistry, RunSummary, Unsubscribe } from "../core/runRegistry.js";
import type { Result, RunEventsPageView, RunsService, RunView } from "../core/runsService.js";
import { renderMarkdownInto } from "./markdownLite.js";
import { createRunTimeline } from "./runTimeline.js";
import { formatLocalIso } from "./localIso.js";
import { buildScheduledRows, renderScheduledPanel, SCHEDULED_PANEL_CSS, type FiringsState } from "./scheduledPanel.js";
import type { ScheduleDef } from "../core/schedules.js";
import type { ScheduleStore } from "../core/scheduleStore.js";

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
 * The seeded events as a JSON literal safe inside an inline `<script>`: every
 * `<`, `>` and `&` is `\uXXXX`-escaped (so no `</script>` — or any tag — can
 * appear, whatever the event text holds), as are U+2028/U+2029 (line
 * terminators JSON allows but JavaScript string literals do not). Exported for
 * the tests that pin the contract.
 */
export function seedEventsJson(events: readonly LiveFrame[]): string {
  return JSON.stringify(events).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** History-mode inputs for `renderRunPage`: the terminal status (absent for a
 *  finished run the store has not confirmed yet) and the published event count
 *  (for the AE11 omission marker). */
export interface HistoryPage {
  status?: RunStatus;
  eventCount: number;
}

/** The history page's header label: `finished · completed`, `finished · stopped (soft)`, …, or bare `finished`. */
function finishedLabel(status: RunStatus | undefined): string {
  return status ? `finished · ${serverRows.statusLabel(status)}` : "finished";
}

/**
 * The run timeline as browser source, inlined like the markdown renderer (same
 * `__name` shim rationale — see MARKDOWN_RENDERER_SCRIPT).
 */
export const RUN_TIMELINE_SCRIPT = String(createRunTimeline);

/** The timestamp formatter as browser source (localIso.ts), inlined the same way. */
export const LOCAL_ISO_SCRIPT = String(formatLocalIso);

/**
 * The self-contained HTML page for one run: a readable timeline of the whole
 * run, grouped the way a person reads it (features/live-view.md item 13).
 * Opens an EventSource to this run's token-scoped event stream and folds each
 * RunEvent through `createRunTimeline` (runTimeline.ts, inlined as `String(fn)`)
 * into: the **Request** block above the log; **steps** — the model's prose
 * (markdown) followed by the tool calls it explains, on a left rail; each call a
 * collapsible **card** (`<details>`) whose header is the command (hanging indent
 * for wrapped lines), a status glyph (spinner / ✓ / ✗ / ⚠), and facts (exit code,
 * line count, duration), with the redacted output inside — failed calls open by
 * default, everything else collapsed; `update_status` as one muted line;
 * `run_note` as a notice; a live **tail** row naming what is running or that the
 * agent is thinking, removed at `end`; and the **Answer** block under the log.
 * Every row leads with a gray local-zone ISO timestamp (e.g. `[2026-08-29T17:47:44-07:00]`) from the event's `at`.
 *
 * `context` events — the thread turns the model was given — render like the
 * request, inside a collapsed **Context** block between the Request block and
 * the log.
 *
 * `events` seeds the page for a run that has no stream to replay from — the
 * history page. The seed rides as a JSON island (`seedEventsJson`) and is fed
 * through the SAME `handle(e)` the EventSource frames go through (one
 * `timeline.push` → `apply` fold), so a seeded page and a live page render
 * identically by construction. The LIVE page passes none: its SSE replay paints
 * the backlog, so seeding would duplicate rows.
 *
 * `history` switches the page into history mode (R12): no EventSource is opened
 * (the seed IS the stream — opening one would paint every row twice), the stop
 * controls are hidden, the header reads a grey `finished · <status>`, and the
 * AE11 omission marker is seeded in place. `token` is unused in that mode (pass
 * ""): a history page never carries a capability URL.
 *
 * All inline (CSP-safe): DOM is built with createElement/textContent only, the
 * markdown surfaces go through `renderMarkdownInto` (markdownLite.ts), and
 * nothing on this page ever assigns raw markup. `id`/`token` are percent-encoded
 * before they are JSON-quoted into the script, so they carry no `<`, `"` or `'`
 * that could break out of the string or the script element. Event text is the
 * one other thing inside the script, and it is only ever there as the
 * `\u003c`-escaped JSON seed.
 */
export function renderRunPage(id: string, token: string, events: readonly RunEvent[] = [], history?: HistoryPage): string {
  const eventsPath = `/runs/${encodeURIComponent(id)}/events?t=${encodeURIComponent(token)}`;
  // Stop control (#101): same token, POST-only; `&mode=` is appended client-side.
  const stopPath = `/runs/${encodeURIComponent(id)}/stop?t=${encodeURIComponent(token)}`;
  const seed: readonly LiveFrame[] = history ? withOmittedMarkers(events, history.eventCount) : events;
  const title = history ? "Run" : "Live run";
  const conn = history
    ? `<span class="dot grey" id="statedot"></span><span id="state">${escapeHtml(finishedLabel(history.status))}</span>`
    : `<span class="dot amber" id="statedot"></span><span id="state">connecting…</span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
  :root { color-scheme: dark;
    --bg: #0b0d12; --panel: #0f1218; --card: #12151c; --card-open: #141821; --line: #232836; --rail: #1f2430;
    --fg: #e6e6e6; --fg-soft: #b6bcc8; --muted: #8b93a7; --dim: #5f677a;
    --blue: #9ecbff; --green: #7ee787; --red: #ff7b72; --amber: #d29922;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 var(--mono); background: var(--bg); color: var(--fg);
    padding: 1.25rem 1.25rem 8rem; max-width: 72rem; margin-inline: auto; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1rem;
    border-bottom: 1px solid var(--line); padding-bottom: .6rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  a.back { color: var(--blue); text-decoration: none; font-size: .8rem; }
  a.back:hover { text-decoration: underline; }
  ${NAV_CSS}
  .conn { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem; }
  #state { font-size: .8rem; color: var(--muted); }
  .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%; background: #6e7681; flex: 0 0 auto; }
  .dot.green { background: #2ea043; }
  .dot.amber { background: var(--amber); }
  .dot.red { background: #f85149; }
  .dot.grey { background: #6e7681; }
  /* Timestamps: a small gray local-zone ISO stamp leading every row and both blocks. */
  .ts { color: var(--dim); font-size: .75rem; font-family: var(--mono); flex: 0 0 auto; user-select: none; }
  /* Request / Answer: headed blocks, proportional type, above and below the log. */
  section.block { border: 1px solid var(--line); border-radius: 8px; padding: .6rem .75rem; background: var(--panel); }
  section.block > h2 { display: flex; align-items: baseline; gap: .6rem; font-size: .75rem; margin: 0 0 .5rem;
    color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  /* Where the request came from: channel · user · a link to the thread. */
  .source { margin-left: auto; display: inline-flex; gap: .6rem; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .source a { color: var(--blue); text-decoration: none; }
  .source a:hover { text-decoration: underline; }
  #request { margin-bottom: 1.25rem; }
  /* Context: the thread turns the model was given, collapsed by default (secondary to the request). */
  details#context { margin-bottom: 1.25rem; }
  details#context > summary { cursor: pointer; font-size: .75rem; color: var(--muted); font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em; list-style: none; }
  details#context > summary::-webkit-details-marker { display: none; }
  details#context > summary::before { content: "\\25B8 "; }
  details#context[open] > summary::before { content: "\\25BE "; }
  details#context > summary > .count { font-weight: 400; text-transform: none; letter-spacing: 0; }
  details#context .turn { display: flex; gap: .75rem; align-items: baseline; padding: .4rem 0; border-top: 1px solid var(--line); opacity: .85; }
  details#context .turn:first-of-type { border-top: 0; }
  #answer { margin-top: 1.5rem; border-color: #2ea04366; }
  #answer > h2 { color: var(--green); }
  /* The timeline: steps, each = optional narration + its calls. One left edge
     for everything — timestamps line up down the page, prose and cards alike;
     steps are separated by space, not lines. */
  #log { list-style: none; margin: 0; padding: 0; }
  #log > li { margin: 0; padding: 0; }
  #log > li.step + li.step { margin-top: 1.5rem; }
  li.step > .narration { display: flex; gap: .75rem; align-items: baseline; padding: .15rem .75rem .65rem; color: var(--fg); }
  li.step > .calls { display: flex; flex-direction: column; gap: .5rem; }
  li.step > .calls:empty { display: none; }
  /* A call card: <details> — header row is the <summary>, output inside. */
  details.call { border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
  details.call[open] { background: var(--card-open); }
  details.call > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: .75rem;
    padding: .5rem .75rem; min-width: 0; }
  details.call > summary::-webkit-details-marker { display: none; }
  details.call > summary:hover { background: #181d27; border-radius: 6px; }
  details.call[open] > summary { border-bottom: 1px solid var(--line); border-radius: 6px 6px 0 0; }
  details.call > summary:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; border-radius: 6px; }
  .glyph { flex: 0 0 1em; text-align: center; font-weight: 700; }
  .ok > summary .glyph { color: var(--green); }
  .failed > summary .glyph { color: var(--red); }
  .infra > summary .glyph { color: var(--amber); }
  .spin { display: inline-block; width: .7em; height: .7em; border: 2px solid #3b4252; border-top-color: var(--blue);
    border-radius: 50%; animation: spin .9s linear infinite; vertical-align: -.05em; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .dollar { flex: 0 0 auto; color: var(--dim); user-select: none; }
  .tool { flex: 0 0 auto; font-size: .7rem; color: var(--muted); background: #1b1f28; border-radius: 4px;
    padding: 0 .35em; line-height: 1.5; }
  /* The command: pre-wrap so a long pipeline wraps, and — because it is its own
     flex item — every continuation line aligns under the command's first char. */
  .cmd { flex: 1 1 auto; min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--blue); }
  /* Collapsed: the command's first line only (with a trailing …); open: all of it. */
  details.call:not([open]) > summary .cmd.full { display: none; }
  details.call[open] > summary .cmd.brief { display: none; }
  details.call:not([open]) > summary .cmd.brief { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .facts { flex: 0 0 auto; display: inline-flex; gap: .75rem; font-size: .75rem; color: var(--muted); margin-left: auto; }
  .fact.bad { color: var(--red); }
  .chev { flex: 0 0 auto; color: var(--dim); font-size: .7rem; transition: transform .12s; }
  details.call[open] > summary .chev { transform: rotate(90deg); }
  pre.out { margin: 0; padding: .65rem .85rem; font: .8rem/1.5 var(--mono); color: var(--fg-soft);
    white-space: pre-wrap; word-break: break-word; max-height: 28rem; overflow: auto; }
  .failed pre.out { color: #f0d0cd; }
  .none { padding: .4rem .75rem; color: var(--dim); font-style: italic; font-size: .8rem; }
  /* Bookkeeping (update_status): one muted line, no card. */
  #log > li.turn { display: flex; gap: .75rem; align-items: baseline; padding: .5rem 2rem .1rem .75rem; margin-top: .6rem; color: var(--dim); font-size: .8rem; }
  .quiet { display: flex; gap: .75rem; align-items: baseline; padding: .2rem .75rem; color: var(--dim); font-size: .8rem; }
  /* Runner notices (wrap-up, budget, stop). */
  li.note { display: flex; gap: .75rem; align-items: baseline; padding: .4rem .75rem; margin-top: 1rem; border-radius: 6px;
    color: var(--amber); background: #d2992214; }
  /* The live tail: what is happening right now, always last while connected. */
  li.tail { display: flex; gap: .75rem; align-items: center; padding: .6rem .75rem; margin-top: 1rem; color: var(--muted); font-size: .8rem; }
  /* \`display: flex\` above outranks the bare \`[hidden]\` rule (0,1,1 vs 0,1,0), so
     the tail needs its own hidden rule — or a finished run keeps "thinking…"
     (seen live 2026-08-29 on the first post-deploy run). */
  li.tail[hidden] { display: none; }
  li.tail .pulse { width: .55em; height: .55em; border-radius: 50%; background: var(--blue); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
  .empty { color: var(--muted); }
  /* Markdown surfaces: proportional type, tight vertical rhythm. */
  .md { font: 14px/1.55 var(--sans); white-space: pre-wrap; word-break: break-word; min-width: 0; flex: 1 1 auto; }
  .md p, .md ul, .md ol, .md pre, .md blockquote, .md table, .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 0 0 .5rem; }
  .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { font-size: 1rem; font-weight: 600; color: var(--fg); text-transform: none; letter-spacing: 0; display: block; }
  .md h1 { font-size: 1.1rem; }
  .md h4, .md h5, .md h6 { font-size: .9rem; color: var(--fg-soft); }
  /* GFM table subset (#209): bordered, collapsed, header row set off. */
  .md table { border-collapse: collapse; white-space: normal; font-size: .95em; }
  .md th, .md td { border: 1px solid var(--line); padding: .25rem .55rem; text-align: left; vertical-align: top; }
  .md th { background: #161b22; font-weight: 600; }
  .md ul, .md ol { padding-left: 1.4rem; white-space: normal; }
  .md ul { list-style: disc; }
  .md ul ul { list-style: circle; }
  .md li { white-space: pre-wrap; }
  .md code { font: .85em var(--mono); background: #1b1f28; padding: .05em .3em; border-radius: 4px; }
  .md pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: .5rem .6rem; overflow-x: auto; white-space: pre; }
  .md pre code { background: none; padding: 0; font-size: .85em; }
  .md blockquote { border-left: 3px solid #3b4252; padding-left: .6rem; color: var(--fg-soft); }
  .md a { color: var(--blue); }
  .md strong { color: #fff; }
  .actions { display: inline-flex; gap: .4rem; }
  button.stop { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid #3b4252; background: #161b22; color: var(--fg); }
  button.stop.hard { border-color: #f85149; color: var(--red); }
  button.stop:disabled { opacity: .5; cursor: default; }
  button.fold { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: var(--muted); }
  button.fold:hover { color: var(--fg); border-color: #3b4252; }
  [hidden] { display: none; }
</style>
</head>
<body>
<header>
  <a class="back" href="/runs">← All runs</a>
  <h1>${title}</h1>
  <span class="actions" id="actions"${history ? " hidden" : ""}>
    <button class="stop soft" data-mode="soft" title="Soft stop: no new steps, the agent writes up what it has">Stop</button>
    <button class="stop hard" data-mode="hard" title="Hard stop: abort now, no summary, free the sandbox">Kill</button>
  </span>
  <button class="fold" id="fold" data-open="0" title="Open every call card">Expand all</button>
  <span class="conn">${conn}</span>
  ${renderNav("runs")}
</header>
<section class="block" id="request" hidden><h2><span>Request</span><span class="ts" id="requestts"></span><span class="source" id="source"></span></h2><div class="md" id="requesttext"></div></section>
<details class="block" id="context" hidden><summary>Context <span class="count" id="contextcount"></span></summary><div id="contextturns"></div></details>
<ol id="log"><li class="empty" id="placeholder">Waiting for activity…</li></ol>
<section class="block" id="answer" hidden><h2><span>Answer</span><span class="ts" id="answerts"></span></h2><div class="md" id="answertext"></div></section>
<script>
${MARKDOWN_RENDERER_SCRIPT}
${RUN_TIMELINE_SCRIPT}
${LOCAL_ISO_SCRIPT}
(function () {
  // \`live\` = this page follows a stream: false on a history page (the seed is the
  // whole record; no stream, no stop route), true on a live page until \`end\` or
  // a dropped connection (EventSource reconnects re-assert it in onopen). The
  // tail row shows only while it holds.
  var live = ${history ? "false" : "true"};
  var url = ${history ? "null" : JSON.stringify(eventsPath)};
  var stopUrl = ${history ? "null" : JSON.stringify(stopPath)};
  var log = document.getElementById("log");
  var requestBox = document.getElementById("request");
  var requestText = document.getElementById("requesttext");
  var requestTs = document.getElementById("requestts");
  var contextBox = document.getElementById("context");
  var contextTurns = document.getElementById("contextturns");
  var contextCount = document.getElementById("contextcount");
  var contextN = 0;
  var answerBox = document.getElementById("answer");
  var answerText = document.getElementById("answertext");
  var answerTs = document.getElementById("answerts");
  var state = document.getElementById("state");
  var stateDot = document.getElementById("statedot");
  var actions = document.getElementById("actions");
  var placeholder = document.getElementById("placeholder");
  // The empty-state sentinel goes away on the FIRST painted change of any kind
  // — a no-tool run (input → answer, no cards) must not keep "Waiting for
  // activity…" forever (#209). One helper; apply() and the tail both call it.
  function clearPlaceholder() { if (placeholder) { placeholder.remove(); placeholder = null; } }
  var source = document.getElementById("source");
  var timeline = createRunTimeline();
  // Which calls start open. Failures and sandbox errors are what you came to
  // read; everything else is one click away. \`?open=tests,build\` on the page
  // URL overrides the list (any call tag — tests, build, install, git, read,
  // network, shell, a tool name — or \`all\`).
  var OPEN_BY_DEFAULT = ["failed", "infra"];
  var openParam = new URLSearchParams(window.location.search).get("open");
  if (openParam) OPEN_BY_DEFAULT = openParam.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
  function opensByDefault(call) {
    if (OPEN_BY_DEFAULT.indexOf("all") !== -1) return true;
    for (var i = 0; i < call.tags.length; i++) if (OPEN_BY_DEFAULT.indexOf(call.tags[i]) !== -1) return true;
    return false;
  }
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
  // ISO timestamp for an event's \`at\` in the viewer's own zone (with its
  // offset, so a pasted line stays unambiguous); "" when the event carries none.
  function fmtTime(at) { return typeof at === "number" ? "[" + formatLocalIso(at) + "]" : ""; }
  // Every node is createElement + textContent — event text is rendered as data.
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function stamp(at) { return el("span", "ts", fmtTime(at)); }
  // The request's origin: channel · user · a link to the thread that started
  // the run. Only http(s) URLs become links (setAttribute, never markup).
  function showSource(src) {
    source.textContent = "";
    if (!src) return;
    if (src.channel) source.appendChild(el("span", "", "#" + src.channel));
    if (src.user) source.appendChild(el("span", "", src.user));
    if (typeof src.url === "string" && /^https?:\\/\\//.test(src.url)) {
      var a = el("a", "", "open thread \\u2197");
      a.setAttribute("href", src.url);
      a.setAttribute("rel", "noopener noreferrer");
      source.appendChild(a);
    }
  }
  // Every markdown surface renders through this guard: a renderer bug must cost
  // at most the formatting of ONE event, never the event or the stream — on any
  // throw the text is shown verbatim (textContent, still no markup).
  function md(target, text) {
    try { renderMarkdownInto(target, text); } catch (_) { target.textContent = text; }
  }
  // Only follow the stream when the viewer is already at the tail; someone
  // reading earlier steps keeps their place.
  function atTail() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 60; }
  function follow(node, wasAtTail) { if (wasAtTail) node.scrollIntoView({ block: "nearest" }); }

  // The live tail: pinned last while connected; names the running call or
  // says the agent is thinking. Removed on \`end\`.
  var tail = el("li", "tail");
  var tailDot = el("span", "pulse");
  var tailText = el("span", "", "");
  tail.appendChild(tailDot);
  tail.appendChild(tailText);
  tail.hidden = true;
  log.appendChild(tail);
  function refreshTail() {
    if (!live) { tail.hidden = true; return; }
    clearPlaceholder();
    var p = timeline.pending();
    tailText.textContent = p ? "running \\u00b7 " + (p.headline.length > 80 ? p.headline.slice(0, 80) + "\\u2026" : p.headline) : "thinking\\u2026";
    tail.hidden = false;
  }
  // A thread turn the model was given: rendered like the request (markdown via
  // the same guard), inside the collapsed Context block. Never in the log.
  function contextTurn(change) {
    var turn = el("div", "turn");
    turn.appendChild(stamp(change.at));
    var box = el("div", "md");
    turn.appendChild(box);
    md(box, change.text);
    contextTurns.appendChild(turn);
    contextN++;
    contextCount.textContent = "(" + contextN + " turn" + (contextN === 1 ? "" : "s") + ")";
    contextBox.hidden = false;
  }

  // --- steps ---------------------------------------------------------------
  var stepNodes = {}; // step.index -> { li, calls }
  var callNodes = {}; // call.id -> { details, glyph, facts, body }
  function addStep(step) {
    var li = el("li", "step");
    if (step.narration) {
      var nar = el("div", "narration");
      nar.appendChild(stamp(step.narration.at));
      var box = el("div", "md");
      nar.appendChild(box);
      md(box, step.narration.text);
      li.appendChild(nar);
    }
    var calls = el("div", "calls");
    li.appendChild(calls);
    log.insertBefore(li, tail);
    stepNodes[step.index] = { li: li, calls: calls };
    return li;
  }
  function glyphFor(call) {
    if (call.status === "running") return el("span", "spin");
    return el("span", "glyph", call.status === "ok" ? "\\u2713" : call.status === "failed" ? "\\u2717" : "\\u26a0");
  }
  function fillFacts(node, call) {
    node.textContent = "";
    for (var i = 0; i < call.facts.length; i++) {
      var f = call.facts[i];
      var bad = call.status !== "ok" && i === 0;
      node.appendChild(el("span", bad ? "fact bad" : "fact", f));
    }
  }
  function fillBody(node, call) {
    node.textContent = "";
    if (!call.result) { node.appendChild(el("div", "none", "running\\u2026")); return; }
    var text = call.result.output || call.result.summary;
    if (text) node.appendChild(el("pre", "out", text));
    else node.appendChild(el("div", "none", "no output"));
  }
  function addCall(step, call) {
    var parent = stepNodes[step.index] ? stepNodes[step.index].calls : addStep(step).lastChild;
    if (call.quiet) {
      var q = el("div", "quiet");
      q.appendChild(stamp(call.startedAt));
      q.appendChild(el("span", "", "\\u270e " + (call.tool === "update_status" ? "status checklist updated" : call.title)));
      parent.appendChild(q);
      callNodes[call.id] = { quiet: q };
      return q;
    }
    var details = el("details", "call " + call.status);
    var summary = el("summary");
    summary.appendChild(stamp(call.startedAt));
    var glyph = glyphFor(call);
    summary.appendChild(glyph);
    summary.appendChild(call.shell ? el("span", "dollar", "$") : el("span", "tool", call.tool));
    summary.appendChild(el("code", "cmd brief", call.headline));
    summary.appendChild(el("code", "cmd full", call.title));
    var facts = el("span", "facts");
    fillFacts(facts, call);
    summary.appendChild(facts);
    summary.appendChild(el("span", "chev", "\\u276f"));
    details.appendChild(summary);
    var body = el("div", "body");
    fillBody(body, call);
    details.appendChild(body);
    if (allOpen || opensByDefault(call)) details.open = true;
    parent.appendChild(details);
    callNodes[call.id] = { details: details, glyph: glyph, facts: facts, body: body };
    return details;
  }
  function settleCall(step, call) {
    var n = callNodes[call.id];
    if (!n) return addCall(step, call);
    if (n.quiet) return n.quiet;
    n.details.className = "call " + call.status;
    var glyph = glyphFor(call);
    n.glyph.replaceWith(glyph);
    n.glyph = glyph;
    fillFacts(n.facts, call);
    fillBody(n.body, call);
    if (opensByDefault(call)) n.details.open = true;
    return n.details;
  }
  // A model turn (item 15): one muted line, "💭 Thought for 5m 04s" plus the
  // token facts, above the step that turn produced.
  function addTurn(change) {
    var li = el("li", "turn");
    li.appendChild(stamp(change.at));
    li.appendChild(el("span", "", "\ud83d\udcad " + change.label));
    var facts = el("span", "facts");
    for (var i = 0; i < change.facts.length; i++) facts.appendChild(el("span", "fact", change.facts[i]));
    li.appendChild(facts);
    log.insertBefore(li, tail);
    return li;
  }
  function addNote(change) {
    var li = el("li", "note");
    li.appendChild(stamp(change.at));
    li.appendChild(el("span", "", (change.kind === "replay_note" ? "\\u2026 " : "\\u23f1 ") + change.text));
    log.insertBefore(li, tail);
    return li;
  }
  // Expand all / Collapse all: flips every card, and every card added later
  // while "expanded" starts open (a viewer who opened everything wants it all).
  var fold = document.getElementById("fold");
  var allOpen = false;
  fold.addEventListener("click", function () {
    allOpen = !allOpen;
    fold.textContent = allOpen ? "Collapse all" : "Expand all";
    fold.setAttribute("data-open", allOpen ? "1" : "0");
    var cards = log.querySelectorAll("details.call");
    for (var i = 0; i < cards.length; i++) cards[i].open = allOpen;
  });
  function markStopping(mode) {
    stopMode = mode;
    actions.hidden = true; // one request is enough; the stream shows the outcome
    if (live) setConn("amber", "stopping (" + mode + ")"); // a history page already shows the outcome
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

  function apply(change, wasAtTail) {
    clearPlaceholder(); // every change paints — input and answer clear it too (#209)
    if (change.kind === "input") {
      requestTs.textContent = fmtTime(change.at);
      md(requestText, change.text);
      showSource(change.source);
      requestBox.hidden = false;
    } else if (change.kind === "step") {
      follow(addStep(change.step), wasAtTail);
    } else if (change.kind === "call") {
      follow(addCall(change.step, change.call), wasAtTail);
    } else if (change.kind === "result") {
      follow(settleCall(change.step, change.call), wasAtTail);
    } else if (change.kind === "turn") {
      follow(addTurn(change), wasAtTail);
    } else if (change.kind === "context") {
      contextTurn(change);
    } else if (change.kind === "note" || change.kind === "replay_note") {
      follow(addNote(change), wasAtTail);
      if ((change.noteKind === "stop_requested" || change.noteKind === "stopped") && change.mode) markStopping(change.mode);
    } else if (change.kind === "answer") {
      // The run's final answer — the same text the thread got, as markdown.
      answerTs.textContent = fmtTime(change.at);
      md(answerText, change.text);
      answerBox.hidden = false;
      follow(answerBox, wasAtTail);
    }
  }
  // ONE fold for every frame — the seeded history and the live stream go
  // through the same push → apply path, so the two pages can never drift apart.
  // \`wasAtTail\` is sampled once per event, BEFORE anything is added.
  function handle(e) {
    var wasAtTail = atTail();
    var changes = timeline.push(e);
    for (var i = 0; i < changes.length; i++) apply(changes[i], wasAtTail);
    refreshTail();
    if (wasAtTail && !tail.hidden) tail.scrollIntoView({ block: "nearest" });
  }
  var seed = ${seedEventsJson(seed)};
  for (var i = 0; i < seed.length; i++) handle(seed[i]);
  if (live) {
    var es = new EventSource(url);
    es.onopen = function () { live = true; if (!stopMode) setConn("green", "live"); refreshTail(); };
    var lastSeq = 0;
    es.onmessage = function (m) {
      var e;
      try { e = JSON.parse(m.data); } catch (_) { return; }
      // Run-event frames carry their stream position as the SSE id; a proxy that
      // strips Last-Event-ID on reconnect would make the server replay from the
      // start, so anything at or before the last applied position is dropped
      // here too. A transport notice (replay_note) has no id of its own — the
      // browser reports the previous frame's id for it — so it is exempt.
      if (e.type !== "replay_note") {
        var sid = Number(m.lastEventId);
        if (sid > 0) { if (sid <= lastSeq) return; lastSeq = sid; }
      }
      handle(e);
    };
    es.addEventListener("end", function () {
      live = false;
      refreshTail();
      actions.hidden = true;
      setConn("grey", stopMode ? "stopped (" + stopMode + ")" : "finished");
      es.close();
    });
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) { live = false; refreshTail(); setConn("red", "disconnected"); }
    };
  }
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

/** The retention sentence the index toggle carries as its tooltip (R11) —
 *  truthful in both configurations: with history off the registry TTL is all
 *  there is. */
export function retentionSentence(retention: { retentionDays: number } | null): string {
  if (!retention) return "Run history is off; finished runs are kept about a minute.";
  const n = retention.retentionDays;
  return `Finished runs are kept for ${n} day${n === 1 ? "" : "s"}, then deleted`;
}

/**
 * One index row, whatever its source: a live registry row (a `RunSummary`, which
 * carries the capability `token`) or a finished/persisted `RunView` from
 * `RunsService` (no token). The row renderer derives everything from this shape
 * — the href in particular: a live row links with its token, a finished row
 * links `/runs/:id` tokenless (R10) even while the registry still holds one.
 */
export interface IndexRow extends RunView {
  token?: string;
}

/** The slice of the DOM the row renderer touches — what a browser `Element`
 *  offers and what `staticDocument()` implements on the server. */
export interface RowElement {
  className: string;
  textContent: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: RowElement): void;
}
export interface RowDocument {
  createElement(tag: string): RowElement;
}

/** What the index feed handler does with one `IndexEvent`, given the view mode
 *  and whether the addressed row is store-confirmed (`data-persisted`). */
export type FeedAction = { op: "upsert"; run: IndexRow } | { op: "remove"; id: string } | { op: "keep" };

/**
 * THE index-row renderer, written once as browser-plain JavaScript and used on
 * both sides: the server inlines it (`String(fn)`, like the markdown renderer)
 * and runs it against `staticDocument()` to emit the initial HTML; the page runs
 * the same code against `document` for every `upsert`. A server-rendered row and
 * its later client repaint are therefore identical by construction, not by
 * mirror-maintenance. Everything is createElement + textContent/setAttribute —
 * a hostile label or id is rendered as data on both paths.
 *
 * Row shape: `<li data-run-id data-started-at [data-persisted]>` holding one
 * full-row `<a class="row" href>` — status dot (green live / grey completed or
 * finished / amber stopped / red failed, with an accessible label), label,
 * event count, and for a finished row with a known `finishedAt` a status line
 * (`completed · 12s · finished 2026-08-29 10:00 UTC`), plus a stop badge once a
 * stop was requested — and, for a stoppable live run, a SIBLING
 * `<span class="actions">` with the Stop/Kill buttons (#101; a button may not
 * nest inside an anchor).
 *
 * `feedAction` is the `?stream=1` reconciliation rule (R11): the default view
 * drops a `finished` upsert (the row leaves as the run ends) and honors every
 * `removed`; `?all=1` keeps finished rows and ignores `removed` only for a row
 * the store confirmed (`persisted`), so a run the writer lost still disappears
 * at eviction and no ghost row survives a reload.
 *
 * Plain `function`s and `var` only — this source runs unbundled in the browser.
 */
export function indexRowRenderer(doc: RowDocument) {
  function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) + "…" : id;
  }
  function countLabel(n: number): string {
    return n + (n === 1 ? " event" : " events");
  }
  function stopLabel(stop: { state: string; mode: string }): string {
    return stop.state + " (" + stop.mode + ")";
  }
  function statusLabel(status: string): string {
    return status === "stopped_soft" ? "stopped (soft)" : status === "stopped_hard" ? "stopped (hard)" : status;
  }
  function statusWord(run: IndexRow): string {
    return !run.finished ? "live" : run.status ? statusLabel(run.status) : "finished";
  }
  function statusDot(run: IndexRow): string {
    if (!run.finished) return "green";
    if (run.status === "failed") return "red";
    if (run.status === "stopped_soft" || run.status === "stopped_hard") return "amber";
    return "grey";
  }
  function pad(n: number): string {
    return (n < 10 ? "0" : "") + n;
  }
  function fmtDuration(ms: number): string {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + pad(s % 60) + "s";
    return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
  }
  function fmtFinishedAt(at: number): string {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
  // A live row links with its capability token; a finished row never does (R10).
  function href(run: IndexRow): string {
    return "/runs/" + encodeURIComponent(run.id) + (!run.finished && run.token ? "?t=" + encodeURIComponent(run.token) : "");
  }
  function stopHref(run: IndexRow, mode: string): string {
    return "/runs/" + encodeURIComponent(run.id) + "/stop?t=" + encodeURIComponent(run.token || "") + "&mode=" + encodeURIComponent(mode);
  }
  function stopButton(mode: string, text: string, title: string): RowElement {
    var b = doc.createElement("button");
    b.className = "stop " + mode;
    b.setAttribute("data-mode", mode);
    b.setAttribute("title", title);
    b.textContent = text;
    return b;
  }
  function span(cls: string, text: string): RowElement {
    var el = doc.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function fill(li: RowElement, run: IndexRow): void {
    li.setAttribute("data-run-id", run.id);
    li.setAttribute("data-started-at", String(run.startedAt)); // drives sorted insert
    if (run.persisted) li.setAttribute("data-persisted", "1"); // store-confirmed: survives `removed` in ?all=1
    li.textContent = ""; // clear any prior children (server-rendered or stale)
    var a = doc.createElement("a");
    a.className = "row";
    a.setAttribute("href", href(run));
    var word = statusWord(run);
    var dot = doc.createElement("span");
    dot.className = "dot " + statusDot(run);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", word);
    dot.setAttribute("title", word);
    a.appendChild(dot);
    a.appendChild(span("label", run.label || shortId(run.id)));
    a.appendChild(span("meta", countLabel(run.eventCount)));
    if (run.finished && typeof run.finishedAt === "number") {
      a.appendChild(span("meta status", word + " · " + fmtDuration(run.finishedAt - run.startedAt) + " · finished " + fmtFinishedAt(run.finishedAt)));
    }
    if (run.stop) a.appendChild(span("stopbadge " + run.stop.state, stopLabel(run.stop)));
    li.appendChild(a);
    if (!run.finished && !run.stop) {
      var actions = doc.createElement("span");
      actions.className = "actions";
      actions.appendChild(stopButton("soft", "Stop", "Soft stop: no new steps, the agent writes up what it has"));
      actions.appendChild(stopButton("hard", "Kill", "Hard stop: abort now, no summary, free the sandbox"));
      li.appendChild(actions);
    }
  }
  function feedAction(ev: { type?: string; run?: IndexRow; id?: string }, showAll: boolean, persisted: boolean): FeedAction {
    if (ev.type === "upsert" && ev.run) return !showAll && ev.run.finished ? { op: "remove", id: ev.run.id } : { op: "upsert", run: ev.run };
    if (ev.type === "removed" && ev.id) return showAll && persisted ? { op: "keep" } : { op: "remove", id: ev.id };
    return { op: "keep" };
  }
  return { fill: fill, href: href, stopHref: stopHref, feedAction: feedAction, statusLabel: statusLabel };
}

/** The `__name` shim every inlined `String(fn)` needs (see MARKDOWN_RENDERER_SCRIPT). */
const NAME_SHIM = "var __name = function (fn) { return fn; };";

/** The row renderer as browser source, for the index page's inline script. */
export const INDEX_ROW_SCRIPT = `${NAME_SHIM}\n${String(indexRowRenderer)}`;

/**
 * A server-side `RowDocument`: elements that remember their attributes (in set
 * order) and children, and a serializer that escapes every attribute value and
 * text node — so the row renderer's `textContent`/`setAttribute` discipline
 * becomes `escapeHtml` on the server. Exported for the mirror test.
 */
export function staticDocument(): RowDocument & { serialize(el: RowElement): string } {
  class StaticElement implements RowElement {
    readonly attrs: Array<[string, string]> = [];
    children: Array<StaticElement | string> = [];
    constructor(readonly tag: string) {}
    get className(): string {
      return this.attrs.find(([k]) => k === "class")?.[1] ?? "";
    }
    set className(v: string) {
      this.setAttribute("class", v);
    }
    get textContent(): string {
      return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    }
    set textContent(v: string) {
      this.children = v === "" ? [] : [v];
    }
    setAttribute(name: string, value: string): void {
      const existing = this.attrs.find(([k]) => k === name);
      if (existing) existing[1] = value;
      else this.attrs.push([name, value]);
    }
    appendChild(child: RowElement): void {
      this.children.push(child as StaticElement);
    }
  }
  const serialize = (el: RowElement): string => {
    const e = el as StaticElement;
    const attrs = e.attrs.map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join("");
    const inner = e.children.map((c) => (typeof c === "string" ? escapeHtml(c) : serialize(c))).join("");
    return `<${e.tag}${attrs}>${inner}</${e.tag}>`;
  };
  return { createElement: (tag) => new StaticElement(tag), serialize };
}

const serverDoc = staticDocument();
const serverRows = indexRowRenderer(serverDoc);

/** Server-rendered markup for one index row — the shared renderer against the
 *  static document. Exported for the mirror test. */
export function indexRowHtml(row: IndexRow): string {
  const li = serverDoc.createElement("li");
  serverRows.fill(li, row);
  return serverDoc.serialize(li);
}

export interface RunsIndexOptions {
  /** `?all=1`: finished and persisted rows included, the feed keeps finished rows. */
  all: boolean;
  /** The configured retention, for the toggle tooltip; null when history is off. */
  retention: { retentionDays: number } | null;
  /** The rendered "Scheduled" panel (#244), placed under the run list; absent → no panel. */
  scheduledPanel?: string;
  /** `?all=1` only: the service degraded to live rows (`ListRunsResult.storeUnavailable`) → a visible banner. */
  storeUnavailable?: boolean;
}

/**
 * The Access-gated runs index (`GET /runs`): a self-contained, **live** HTML page.
 * By default it lists the active runs (R11 — never a store read); with `?all=1`
 * it also lists finished and persisted runs, visually distinct (status dot and
 * word, duration, finished-at). Each live row links to its per-run page WITH the
 * run's capability token; finished rows link tokenless. The initial snapshot is
 * server-rendered (fast first paint); an inline `EventSource("/runs?stream=1")`
 * then keeps it live — rows appear, update (activity/finish), and disappear
 * (eviction) without a refresh, driven by `IndexEvent`s from the shared registry
 * (so runs from every channel show up), reconciled per `feedAction`. Unlike the
 * per-run page/stream, the index has NO token gate — Cloudflare Access is the
 * "who" gate in front of it. Because it renders the capability links, it must
 * ONLY be exposed behind Access; without Access it would leak every live-run
 * link (see features/live-view.md).
 *
 * CSP-safe (inline-only, no external assets). Rows are rendered by the ONE
 * `indexRowRenderer` on both sides (see there), so no `innerHTML` and no
 * unescaped string ever reaches the markup on either path.
 */
export function renderRunsIndex(runs: readonly IndexRow[], opts: RunsIndexOptions = { all: false, retention: null }): string {
  const rows = runs.map(indexRowHtml).join("");
  // The empty-state <li> always exists; it is only visible when the list has no
  // run rows (server-side here, and toggled client-side as rows come and go).
  const emptyHidden = runs.length === 0 ? "" : " hidden";
  const title = opts.all ? "All runs" : "Live runs";
  const toggle = opts.all
    ? `<a class="toggle" href="/runs" title="${escapeHtml(retentionSentence(opts.retention))}">Active only</a>`
    : `<a class="toggle" href="/runs?all=1" title="${escapeHtml(retentionSentence(opts.retention))}">Show all</a>`;
  const feedUrl = opts.all ? "/runs?stream=1&all=1" : "/runs?stream=1";
  const banner = opts.storeUnavailable ? `\n<p class="banner" role="status">${escapeHtml(STORE_UNAVAILABLE_BANNER)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #e6e6e6; padding: 1rem; }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem;
    border-bottom: 1px solid #2a2f3a; padding-bottom: .5rem; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  a.toggle { color: #9ecbff; text-decoration: none; font-size: .8rem; border: 1px solid #3b4252;
    border-radius: 4px; padding: .05rem .5rem; }
  a.toggle:hover { background: #161b22; }
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
  .meta.status { margin-left: auto; }
  .stopbadge { font-size: .75rem; color: #d29922; }
  .stopbadge.stopped { color: #8b93a7; }
  .actions { display: inline-flex; gap: .4rem; flex: 0 0 auto; padding-right: .5rem; }
  button.stop { font: inherit; font-size: .75rem; padding: .1rem .5rem; border-radius: 4px; cursor: pointer;
    border: 1px solid #3b4252; background: #161b22; color: #e6e6e6; }
  button.stop.hard { border-color: #f85149; color: #ff7b72; }
  button.stop:disabled { opacity: .5; cursor: default; }
  .empty { color: #8b93a7; padding: .45rem .5rem; }
  .banner { margin: 0 0 .75rem; padding: .45rem .6rem; border: 1px solid #d29922; border-radius: 6px; color: #d29922; font-size: .8rem; }
  [hidden] { display: none; }
  ${SCHEDULED_PANEL_CSS}
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  ${toggle}
  <span class="conn"><span class="dot amber" id="statedot"></span><span id="state">connecting…</span></span>
  ${renderNav("runs")}
</header>${banner}
<ul id="runs">${rows}<li class="empty" id="empty"${emptyHidden}>${opts.all ? "No runs." : "No active runs."}</li></ul>
${opts.scheduledPanel ?? ""}
<script>
${INDEX_ROW_SCRIPT}
(function () {
  var showAll = ${opts.all ? "true" : "false"};
  var rowLib = indexRowRenderer(document);
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
    fetch(rowLib.stopHref(run, mode), { method: "POST", credentials: "same-origin" })
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
      rowLib.fill(li, run); // update in place — startedAt is immutable, so position holds
    } else {
      li = document.createElement("li");
      rows[run.id] = li;
      rowLib.fill(li, run);
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

  var es = new EventSource(${JSON.stringify(feedUrl)});
  es.onopen = function () { setConn("green", "live"); };
  es.onmessage = function (m) {
    var ev;
    try { ev = JSON.parse(m.data); } catch (_) { return; }
    var li = ev.type === "removed" && ev.id ? rows[ev.id] : null;
    var act = rowLib.feedAction(ev, showAll, li ? li.getAttribute("data-persisted") === "1" : false);
    if (act.op === "upsert") upsert(act.run); else if (act.op === "remove") remove(act.id);
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

/** A frame on the per-run stream: a run event, or a notice from the transport
 *  itself. `replay_note` is emitted once, first, when a late subscriber's replay
 *  was capped — it is NOT a run event and never enters the registry or the run
 *  record (the full stream stays readable via `snapshot` / the history page). */
export type LiveFrame = RunEvent | { type: "replay_note"; summary: string };

/** Most backlog frames a late subscriber is replayed (#157 KTD9); the newest
 *  win. The registry keeps up to 5000 — the browser does not need them all to
 *  follow a live run, and the page must not stall on a 4 MiB burst. */
export const REPLAY_LIMIT = 1000;

/** One SSE frame for a run event: `id:` is its position in the run's stream (the
 *  registry's `seq`), so a browser that reconnects (proxy drop, deploy, laptop
 *  sleep) sends it back as `Last-Event-ID` and the server replays only what it
 *  missed — instead of the whole backlog again, which the page would have
 *  appended as duplicates. */
function sseData(event: RunEvent, seq: number): string {
  return `id: ${seq}\ndata: ${serializedOnce(event)}\n\n`;
}

/** One SSE `data:` frame for a transport notice (`replay_note`). No `id:` — a
 *  notice has no stream position, so it must not move the client's cursor. */
function sseNotice(frame: Exclude<LiveFrame, RunEvent>): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The `Last-Event-ID` a reconnecting EventSource sends, as the stream position
 *  to resume after; anything absent or malformed means "from the start". */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !/^\d{1,15}$/.test(raw.trim())) return 0;
  return Number(raw.trim());
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
 *
 * The replay is capped at the newest `REPLAY_LIMIT` events; when the backlog
 * held more, a leading `replay_note` frame says how many of how many were
 * replayed. Live events after the replay are never capped. The buffer is a
 * bounded ring — the oldest event is shifted out once it holds `REPLAY_LIMIT`
 * — and `replayed` counts everything the backlog offered, for the note. With a
 * resume cursor (`Last-Event-ID` → `subscribe(…, afterSeq)`) the registry
 * offers only the events after it, so the ring and the note both count from
 * the cursor — the two mechanisms compose rather than overlap.
 */
export function serveEvents(
  subscribe: (onEvent: (e: RunEvent, seq: number) => void, onFinish: () => void) => Unsubscribe | null,
  sink: SseSink,
  onLive?: () => void,
): void {
  const replay: Array<{ event: RunEvent; seq: number }> = [];
  let replayed = 0;
  let live = false;
  let endedDuringReplay = false;
  const onFinish = () => {
    if (live) {
      sink.write(SSE_END);
      sink.end();
    } else endedDuringReplay = true;
  };

  const unsubscribe = subscribe((e, seq) => {
    if (live) {
      sink.write(sseData(e, seq));
      return;
    }
    replayed++;
    if (replay.length === REPLAY_LIMIT) replay.shift();
    replay.push({ event: e, seq });
  }, onFinish);
  if (!unsubscribe) {
    sink.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    sink.write("run not found");
    sink.end();
    return;
  }

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE); // flush the head immediately (a run with no events yet has an empty backlog)
  if (replayed > REPLAY_LIMIT) {
    sink.write(sseNotice({ type: "replay_note", summary: `replaying last ${REPLAY_LIMIT} of ${replayed} events` }));
  }
  for (const { event, seq } of replay) sink.write(sseData(event, seq));
  replay.length = 0;
  if (endedDuringReplay) {
    sink.write(SSE_END);
    sink.end();
    return;
  }
  sink.onClose(unsubscribe);
  onLive?.(); // stream stays open → safe to start the keepalive heartbeat
}

/** One SSE `data:` frame for an index event (upsert/removed). No `id:` — the
 *  index has no resume semantics (a reconnect replays the current active set). */
function sseIndexData(ev: IndexEvent): string {
  return `data: ${serializedOnce(ev)}\n\n`;
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

/**
 * The stored stream with the truncation made visible (R12 / AE11): when the
 * record holds fewer events than the run published (`eventCount`), one
 * `replay_note` — "N events omitted", N = published − stored — is placed at the
 * first gap in `seq` (a gap at the start puts it first; no gap in the stored
 * range means the tail was cut, so it goes last). A complete record is returned
 * as-is. The marker is a transport notice, never a run event (it does not enter
 * any store).
 */
export function withOmittedMarkers(events: readonly RunEvent[], eventCount: number): LiveFrame[] {
  const omitted = eventCount - events.length;
  if (omitted <= 0) return [...events];
  const marker: LiveFrame = { type: "replay_note", summary: `${omitted} event${omitted === 1 ? "" : "s"} omitted` };
  const out: LiveFrame[] = [];
  let expected = 1;
  let placed = false;
  for (const e of events) {
    if (!placed && typeof e.seq === "number" && e.seq > expected) {
      out.push(marker);
      placed = true;
    }
    out.push(e);
    expected = typeof e.seq === "number" ? e.seq + 1 : expected + 1;
  }
  if (!placed) out.push(marker);
  return out;
}

/**
 * Serve a finished run's stored stream (R12): every page of `getRunEvents` is
 * collected first — the history path knows every event before it writes a head
 * (KTD6) — then the 200 head, the prelude, each frame (with the AE11 omission
 * marker in place), and the terminal `end`. A page that is not-found (the run
 * expired between the caller's lookup and this read) is the same 404 as a live
 * miss. `eventCount` is the run's published total, for the marker.
 */
export async function serveHistoryEvents(
  page: (afterSeq: number) => Promise<Result<RunEventsPageView>>,
  eventCount: number,
  sink: SseSink,
): Promise<void> {
  const events: RunEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const res = await page(afterSeq);
    if (!res.ok) {
      sink.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      sink.write("run not found");
      sink.end();
      return;
    }
    events.push(...res.value.events);
    if (res.value.nextAfterSeq === undefined || res.value.events.length === 0) break;
    afterSeq = res.value.nextAfterSeq;
  }
  sink.writeHead(200, SSE_HEADERS);
  sink.write(SSE_PRELUDE);
  withOmittedMarkers(events, eventCount).forEach((frame, i) => {
    sink.write(frame.type === "replay_note" ? sseNotice(frame) : sseData(frame, frame.seq ?? i + 1));
  });
  sink.write(SSE_END);
  sink.end();
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
   *  otherwise 403. The token-gated live path is unaffected. Absent → no gate. */
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
  /** One rendered index page: the rows and the store-degraded flag. */
  interface IndexPage {
    rows: readonly IndexRow[];
    storeUnavailable?: boolean;
  }
  /** `?all=1`: the service's live ∪ finished ∪ persisted rows, with the live rows'
   *  capability tokens re-attached for their hrefs (finished rows stay tokenless). */
  const mergedRows = async (live: readonly RunSummary[]): Promise<IndexPage> => {
    const tokens = new Map(live.map((s) => [s.id, s.token]));
    const { runs, storeUnavailable } = await service.listRuns({ status: "all" });
    const rows = runs.map((v) => {
      const token = tokens.get(v.id);
      return token === undefined ? v : { ...v, token };
    });
    // The service degraded to live rows: the page says so (a banner), never a silently short list.
    return storeUnavailable ? { rows, storeUnavailable: true } : { rows };
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
          }),
        );
      };
      const noStore: FiringsState = { ok: false, reason: NO_STORE_REASON };
      if (!all && !scheduled?.store) {
        // Nothing to await: the default view is the registry alone (R11 — never a
        // store read), rendered synchronously as before.
        render({ rows: live.filter((s) => !s.finished) }, noStore);
        return true;
      }
      run(res, async () => {
        // Both reads are known before the head is written, so the first paint is
        // complete (a firing-store failure is shown as such, never as an empty
        // history).
        const [page, firings] = await Promise.all([
          all ? mergedRows(live) : Promise.resolve<IndexPage>({ rows: live.filter((s) => !s.finished) }),
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
      const found = await service.getRun(route.id, route.kind === "page" ? { include: "messages" } : {});
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
      await serveHistoryEvents((afterSeq) => service.getRunEvents(route.id, { afterSeq }), view.eventCount, nodeSseSink(req, res));
    });
    return true;
  };
}
