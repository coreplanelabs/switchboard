import { NAV_CSS, renderNav } from "../nav.js";
import type { RunEvent } from "../../core/runEvents.js";
import type { RunStatus } from "../../core/runRecord.js";
import { renderMarkdownInto } from "../markdownLite.js";
import { createRunTimeline } from "../runTimeline.js";
import { formatLocalIso } from "../localIso.js";
import { escapeHtml, NAME_SHIM } from "./html.js";
import { indexStatusLabel } from "./runsIndex.js";
import { withOmittedMarkers, type LiveFrame } from "./sse.js";

// The per-run page (`GET /runs/:id`): one self-contained HTML document that is
// either LIVE (follows the token-scoped SSE stream) or HISTORY (seeded from the
// stored record, no stream). The client-side timeline is `runTimeline.ts` and
// the markdown renderer `markdownLite.ts`, both inlined as `String(fn)` — the
// same code the server tests run, so the two sides cannot drift.

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
export const MARKDOWN_RENDERER_SCRIPT = `${NAME_SHIM}\n${String(renderMarkdownInto)}`;

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
  return status ? `finished · ${indexStatusLabel(status)}` : "finished";
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
