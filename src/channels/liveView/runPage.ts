import { NAV_CSS, renderNav } from "../nav.js";
import type { RunEvent } from "../../core/runEvents.js";
import type { RunStatus } from "../../core/runRecord.js";
import { renderMarkdownInto } from "../markdownLite.js";
import { createRunTimeline } from "../runTimeline.js";
import { formatLocalIso } from "../localIso.js";
import { formatElapsed } from "../indexFormat.js";
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
  /** `finishedAt - startedAt` when the record knows both (item 20): the header reads `finished · completed · 2m 27s`. */
  durationMs?: number;
}

/** The history page's header label: `finished · completed · 2m 27s`, `finished · stopped (soft)`, …, or bare `finished`. */
function finishedLabel(status: RunStatus | undefined, durationMs?: number): string {
  const parts = ["finished", ...(status ? [indexStatusLabel(status)] : []), ...(durationMs !== undefined ? [formatElapsed(durationMs)] : [])];
  return parts.join(" · ");
}

/**
 * The run timeline as browser source, inlined like the markdown renderer (same
 * `__name` shim rationale — see MARKDOWN_RENDERER_SCRIPT).
 */
export const RUN_TIMELINE_SCRIPT = String(createRunTimeline);

/** The timestamp formatter as browser source (localIso.ts), inlined the same way. */
export const LOCAL_ISO_SCRIPT = String(formatLocalIso);

/** The stopwatch formatter (indexFormat.ts) as browser source — the tail's
 *  "since the last event" and a call group's total time read like the index. */
export const ELAPSED_SCRIPT = String(formatElapsed);

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
  // The connection mark is the pulse glyph (∿), colored by state; the tail reuses it.
  const conn = history
    ? `<span class="pulse grey" id="statedot">∿</span><span id="state">${escapeHtml(finishedLabel(history.status, history.durationMs))}</span>`
    : `<span class="pulse amber" id="statedot">∿</span><span id="state">connecting…</span>`;
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
    --gutter: 9.5rem; /* the step timestamp column: rail → .75rem → [HH:MM:SS] → content */
    --fg: #e6e6e6; --fg-soft: #b6bcc8; --muted: #8b93a7; --dim: #5f677a;
    --blue: #9ecbff; --green: #7ee787; --red: #ff7b72; --amber: #d29922;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 var(--mono); background: var(--bg); color: var(--fg);
    padding: 1.25rem 1.25rem 8rem; max-width: 72rem; margin-inline: auto; }
  /* The header is a full-width band: back link · title · connection, the run
     controls in the middle, the site nav at the right. */
  header { display: flex; align-items: center; gap: 1rem; margin: -1.25rem -1.25rem 1.5rem; padding: .9rem 1.5rem;
    background: var(--panel); border-bottom: 1px solid var(--line); }
  h1 { font-size: 1.15rem; margin: 0; font-weight: 600; letter-spacing: -.01em; }
  header .actions { margin-left: auto; }
  header nav.site { margin-left: auto; }
  a.back { color: var(--blue); text-decoration: none; font-size: .8rem; }
  a.back:hover { text-decoration: underline; }
  ${NAV_CSS}
  /* The connection indicator sits beside the title and says what IT is —
     connected / connecting… / disconnected — never "live", which is a run state. */
  .conn { display: inline-flex; align-items: center; gap: .4rem; }
  #state { font-size: .8rem; color: var(--muted); }
  /* State colors for the pulse mark: green connected, amber connecting/stopping, red disconnected, grey finished. */
  .pulse.green { color: var(--green); }
  .pulse.amber { color: var(--amber); }
  .pulse.red { color: var(--red); }
  .pulse.grey { color: var(--dim); animation: none; }
  /* Timestamps: a small gray local-zone ISO stamp leading every row and both blocks. */
  .ts { color: var(--dim); font-size: .75rem; font-family: var(--mono); flex: 0 0 auto; user-select: none; }
  /* Request / Answer: headed blocks, proportional type, above and below the log. */
  section.block { border: 1px solid var(--line); border-radius: 8px; padding: .6rem .75rem; background: var(--panel); }
  section.block > h2 { display: flex; align-items: baseline; gap: .6rem; font-size: .75rem; margin: 0 0 .5rem;
    color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  /* Where the request came from: channel · user · a link to the thread. */
  .source { margin-left: auto; display: inline-flex; align-items: center; gap: .5rem; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--muted); }
  .source a { color: var(--fg-soft); text-decoration: none; }
  .source a:hover { color: var(--blue); text-decoration: underline; }
  .source > span + span::before, .source > a + span::before { content: "\\00b7"; color: var(--dim); margin-right: .5rem; }
  .slackmark { width: 1em; height: 1em; flex: 0 0 auto; }
  /* What the run is about: agent · model · owner/repo · ref · #PR · sha, each a
     link where GitHub has a page for it. Under the request, quiet, dotted. */
  .runmeta { display: flex; flex-wrap: wrap; align-items: baseline; gap: .55rem; margin-top: .6rem; padding-top: .5rem; border-top: 1px solid var(--line);
    font-size: .75rem; color: var(--muted); }
  .runmeta > * + *::before { content: "\\00b7"; color: var(--dim); margin-right: .55rem; }
  .runmeta .agent { color: var(--fg-soft); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; font-size: .68rem; }
  .runmeta a { color: var(--blue); text-decoration: none; }
  .runmeta a:hover { text-decoration: underline; }
  .runmeta .effort { color: var(--fg-soft); }
  /* The branch: a fact, not a destination — a quiet tag, no link. */
  .runmeta .reftag { border: 1px solid #3b4252; border-radius: 4px; padding: 0 .4em; color: var(--fg-soft); font-size: .75rem; }
  .runmeta a.prlink { display: inline-flex; align-items: center; gap: .35em; }
  .ghmark { width: 1em; height: 1em; flex: 0 0 auto; }
  .runmeta[hidden] { display: none; }
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
  #log > li.step + li.step, #log > li.step + li.turn, #log > li.turn + li.step { margin-top: 1.25rem; }
  /* ONE STEP = ONE BLOCK, read top to bottom (item 18): a rail marks where it
     starts and ends; its first row is the head — [when] 💭 how long the model
     thought → what it then said (the narration IS what the thinking produced) …
     tokens — and under it, the calls that prose explains. One column grid for
     every row inside a step: rail → 1.5rem → timestamp → marker → text … facts.
     Text rows (head, group tally) pad 1.5rem directly; cards sit .75rem in and
     pad .75rem inside their border — so a card's timestamp lands in the same
     column as the head's, and the right-hand facts end on the same line (text
     rows leave room for a card's chevron). */
  /* Gutter layout: the step's timestamp lives in a fixed left gutter beside the
     rail (padded off it), everything else in the content column. */
  #log > li.step, #log > li.turn { position: relative; border-left: 2px solid var(--rail); padding: .5rem 0 .75rem var(--gutter); } /* #log > li resets padding at (1,0,1) — match it */
  li.step.live { border-left-color: #2ea04366; }
  li.step > .narration, #log > li.turn > .narration { display: flex; gap: .75rem; align-items: baseline; padding: 0 .75rem .35rem 0; color: var(--fg); }
  .narration > .ts { position: absolute; left: .75rem; top: .6rem; }
  .think { flex: 0 0 auto; color: var(--amber); font-size: .8rem; background: #d2992214; border-radius: 4px; padding: .05em .5em; line-height: 1.6; white-space: nowrap; }
  .think.quick { color: var(--muted); background: #1b1f28; }
  .nonar { flex: 1 1 auto; color: var(--dim); font: italic .9rem/1.5 var(--sans); }
  /* The turn's token facts: their own quiet line under the prose. */
  /* Above the prose: a small metadata line, tight against the head row (item
     21), left edge aligned with the duration chip's TEXT. Inline (a no-prose
     head): part of the head row, regular size. */
  .turnfacts { display: flex; gap: .6rem; padding: 0 .75rem 0 .45rem; margin-bottom: -.1rem; font-size: .7rem; color: var(--dim); font-variant-numeric: tabular-nums; }
  .narration .turnfacts { padding: 0; margin: 0; align-self: center; font-size: .75rem; color: var(--muted); }
  .turnfacts .fact + .fact::before { content: "\\00b7"; color: var(--dim); margin-right: .6rem; }
  .turnfacts:empty { display: none; }
  li.step > .calls { display: flex; flex-direction: column; gap: .5rem; padding-right: .75rem; }
  li.step > .calls:empty { display: none; }
  /* Two or more calls under one narration fold into ONE group row — "[when]
     ❯ 7 calls · ✓ 6 · ✗ 1 · 9.4s" — so a step reads as a sentence, not a wall
     of cards. Open while any call is still running or after a failure; a clean
     step folds when the next one begins (a manual toggle sticks). */
  /* The tally is a bordered bar like the cards under it: count · ✓ n · ✗ n … total time. */
  details.group > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; gap: 1rem; padding: .5rem .75rem;
    border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); font-size: .85rem; }
  details.group > summary::-webkit-details-marker { display: none; }
  details.group > summary:hover { background: #181d27; }
  details.group > summary:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
  details.group > summary .gchev { flex: 0 0 auto; color: var(--dim); font-size: .7rem; transition: transform .12s; order: 9; }
  details.group[open] > summary .gchev { transform: rotate(90deg); }
  details.group > summary .gcount { color: var(--fg); font-weight: 600; }
  details.group > summary .gok { color: var(--green); }
  details.group > summary .gbad { color: var(--red); }
  details.group > summary .ginfra { color: var(--amber); }
  details.group > summary .grun { color: var(--blue); }
  details.group > summary .gtime { margin-left: auto; color: var(--muted); font-size: .8rem; font-variant-numeric: tabular-nums; }
  details.group > summary > span:empty { display: none; }
  details.group > .gbody { display: flex; flex-direction: column; gap: .5rem; padding: .5rem 0 .25rem; }
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
  .facts { flex: 0 0 auto; display: inline-flex; gap: .6rem; font-size: .75rem; color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
  .facts .fact + .fact::before { content: "\\00b7"; color: var(--dim); margin-right: .6rem; }
  .fact.bad { color: var(--red); }
  .chev { flex: 0 0 auto; color: var(--dim); font-size: .7rem; transition: transform .12s; }
  details.call[open] > summary .chev { transform: rotate(90deg); }
  pre.out { margin: 0; padding: .65rem .85rem; font: .8rem/1.5 var(--mono); color: var(--fg-soft);
    white-space: pre-wrap; word-break: break-word; max-height: 28rem; overflow: auto; }
  .failed pre.out { color: #f0d0cd; }
  .none { padding: .4rem .75rem; color: var(--dim); font-style: italic; font-size: .8rem; }
  /* Bookkeeping (update_status): one muted line, no card. */
  .quiet { display: flex; gap: .75rem; align-items: baseline; padding: .2rem .75rem; color: var(--dim); font-size: .8rem; }
  /* A skill loaded into context: its own row, set apart from call cards by a violet mark. */
  .skill { display: flex; gap: .6rem; align-items: baseline; padding: .3rem .75rem; font-size: .85rem; border-left: 2px solid #a78bfa; border-radius: 0 6px 6px 0; background: #a78bfa12; }
  .skill .skillmark { flex: 0 0 auto; }
  .skill .skillname { color: var(--fg); font-weight: 600; white-space: nowrap; }
  .skill .skilldesc { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; }
  .skill .facts { margin-left: auto; flex: 0 0 auto; }
  .skill a.fact { color: var(--blue); text-decoration: none; }
  .skill a.fact:hover { text-decoration: underline; }
  /* Runner notices (wrap-up, budget, stop). */
  li.note { display: flex; gap: .75rem; align-items: baseline; padding: .4rem .75rem; margin-top: 1rem; border-radius: 6px;
    color: var(--amber); background: #d2992214; }
  /* The live tail: what is happening right now, always last while connected. */
  /* \`#log > li\` resets margin/padding at (0,1,1) — the tail's own rule must match that specificity. */
  #log > li.tail { display: flex; gap: .75rem; align-items: center; padding: 1rem 2rem .75rem 1.5rem; margin-top: 2.5rem; color: var(--muted); font-size: .8rem;
    border-top: 1px dashed #2a2f3a; }
  li.tail .verb { color: var(--fg-soft); }
  li.tail .since { margin-left: auto; flex: 0 0 auto; color: var(--dim); font-variant-numeric: tabular-nums; }
  li.tail .since.slow { color: var(--amber); }
  /* \`display: flex\` above outranks the bare \`[hidden]\` rule (0,1,1 vs 0,1,0), so
     the tail needs its own hidden rule — or a finished run keeps "thinking…"
     (seen live 2026-08-29 on the first post-deploy run). */
  #log > li.tail[hidden] { display: none; }
  /* The pulse glyph (∿): the same mark as the header's connection indicator. */
  .pulse { color: var(--blue); font-size: 1.1em; line-height: 1; animation: pulse 1.4s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .pulse, .spin { animation: none; } }
  @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
  .empty { color: var(--muted); }
  /* Markdown surfaces: proportional type, tight vertical rhythm. */
  .md { font: 15px/1.55 var(--sans); white-space: pre-wrap; word-break: break-word; min-width: 0; flex: 1 1 auto; }
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
  /* The log's own toolbar: one ghost toggle, right-aligned above the timeline —
     a view control, not a run control, so it does not sit with Stop/Kill. Its
     icon flips with its state: ⊞ Expand all ↔ ⊟ Collapse all. */
  .logbar { display: flex; justify-content: flex-end; margin: 0 0 .35rem; padding: 0 .75rem 0 var(--gutter); }
  button.fold { font: inherit; font-size: .75rem; padding: .15rem .55rem; border-radius: 4px; cursor: pointer;
    border: 1px solid transparent; background: transparent; color: var(--muted); display: inline-flex; align-items: center; gap: .4rem; }
  button.fold::before { content: "\\229e"; font-size: .95rem; line-height: 1; color: var(--dim); }
  button.fold[data-open="1"]::before { content: "\\229f"; }
  button.fold:hover, button.fold:focus-visible { color: var(--fg); border-color: var(--line); background: var(--card); }
  button.fold:hover::before { color: var(--fg-soft); }
  [hidden] { display: none; }
</style>
</head>
<body>
<header>
  <a class="back" href="/runs">← All runs</a>
  <h1>${title}</h1>
  <span class="conn">${conn}</span>
  <span class="actions" id="actions"${history ? " hidden" : ""}>
    <button class="stop soft" data-mode="soft" title="Soft stop: no new steps, the agent writes up what it has">Stop</button>
    <button class="stop hard" data-mode="hard" title="Hard stop: abort now, no summary, free the sandbox">Kill</button>
  </span>
  ${renderNav("runs")}
</header>
<section class="block" id="request" hidden><h2><span>Request</span><span class="ts" id="requestts"></span><span class="source" id="source"></span></h2><div class="md" id="requesttext"></div><div class="runmeta" id="runmeta" hidden></div></section>
<details class="block" id="context" hidden><summary>Context <span class="count" id="contextcount"></span></summary><div id="contextturns"></div></details>
<div class="logbar"><button class="fold" id="fold" data-open="0" title="Open every call card" aria-pressed="false">Expand all</button></div>
<ol id="log"><li class="empty" id="placeholder">Waiting for activity…</li></ol>
<section class="block" id="answer" hidden><h2><span>Answer</span><span class="ts" id="answerts"></span></h2><div class="md" id="answertext"></div></section>
<script>
${MARKDOWN_RENDERER_SCRIPT}
${RUN_TIMELINE_SCRIPT}
${LOCAL_ISO_SCRIPT}
${ELAPSED_SCRIPT}
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
    stateDot.className = "pulse " + color;
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
  // A row's gutter stamp: the short local clock (\`[23:33:45]\`) with the full
  // ISO-with-offset on hover — the Request block already dates the run.
  function stamp(at) {
    var s = el("span", "ts", typeof at === "number" ? "[" + formatLocalIso(at).slice(11, 19) + "]" : "");
    if (typeof at === "number") s.setAttribute("title", formatLocalIso(at));
    return s;
  }
  // The request's origin: channel · user · a link to the thread that started
  // the run. Only http(s) URLs become links (setAttribute, never markup).
  function showSource(src) {
    source.textContent = "";
    if (!src) return;
    // The Slack mark (four bars, drawn — no external asset under this CSP) says
    // where the request came from; the channel name is the link to the thread.
    if (src.channel) {
      source.appendChild(slackMark());
      if (typeof src.url === "string" && /^https?:\\/\\//.test(src.url)) {
        var a = el("a", "", "#" + src.channel);
        a.setAttribute("href", src.url);
        a.setAttribute("target", "_blank"); // outbound links never take the operator off the dashboard
        a.setAttribute("rel", "noopener noreferrer");
        a.setAttribute("title", "open the thread");
        source.appendChild(a);
      } else source.appendChild(el("span", "", "#" + src.channel));
    }
    if (src.user) source.appendChild(el("span", "", src.user));
  }
  function slackMark() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "slackmark");
    svg.setAttribute("aria-label", "Slack");
    svg.setAttribute("role", "img");
    // Slack's four lozenges, one per quadrant.
    var bars = [["2", "13", "9", "3"], ["13", "2", "3", "9"], ["13", "13", "9", "3"], ["9", "13", "3", "9"]];
    var colors = ["#e01e5a", "#36c5f0", "#ecb22e", "#2eb67d"];
    for (var i = 0; i < bars.length; i++) {
      var r = document.createElementNS(ns, "rect");
      r.setAttribute("x", bars[i][0]); r.setAttribute("y", bars[i][1]); r.setAttribute("width", bars[i][2]); r.setAttribute("height", bars[i][3]);
      r.setAttribute("rx", "1.5"); r.setAttribute("fill", colors[i]);
      svg.appendChild(r);
    }
    return svg;
  }
  // What the run is about (item 19, tightened in item 21): agent · model ·
  // effort, then — for a repo run — the repo (a GitHub link), the branch as a
  // plain tag (nobody clicks "main"; the sha is gone for the same reason) and
  // the PR, the one link worth following, led by the GitHub mark.
  var runMeta = document.getElementById("runmeta");
  function showMeta(m) {
    runMeta.textContent = "";
    runMeta.appendChild(el("span", "agent", m.agent));
    runMeta.appendChild(el("span", "model", m.model));
    if (m.effort) runMeta.appendChild(el("span", "effort", m.effort + " effort"));
    if (!m.repo || !/^[\\w.-]+\\/[\\w.-]+$/.test(m.repo)) { runMeta.hidden = false; return; }
    var base = "https://github.com/" + m.repo;
    runMeta.appendChild(link(m.repo, base));
    if (m.ref) runMeta.appendChild(el("span", "reftag", m.ref));
    if (m.pr) {
      var pr = link("#" + m.pr, base + "/pull/" + m.pr);
      pr.className = "prlink";
      pr.insertBefore(githubMark(), pr.firstChild);
      runMeta.appendChild(pr);
    }
    runMeta.hidden = false;
  }
  function githubMark() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "ghmark");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z");
    svg.appendChild(p);
    return svg;
  }
  function link(text, href) {
    var a = el("a", "", text);
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank"); // outbound: a new tab, the run stays put
    a.setAttribute("rel", "noopener noreferrer");
    return a;
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
  // Layout: ● <verb>… ……… <elapsed>. The verb rotates through a few words (the
  // way Claude Code does — a live page that changes reads as alive); the running
  // command is NOT repeated here (its card, with the spinner, is the row above);
  // the elapsed counts from the last event RECEIVED (client clock, so no skew
  // against the runner's stamps) and turns amber past two minutes — a slow model
  // turn and a dead stream no longer look the same.
  var tail = el("li", "tail");
  var tailDot = el("span", "pulse", "\\u223f");
  var tailVerb = el("span", "verb", "");
  var tailSince = el("span", "since", "");
  tail.appendChild(tailDot);
  tail.appendChild(tailVerb);
  tail.appendChild(tailSince);
  tail.hidden = true;
  log.appendChild(tail);
  var THINKING = ["Thinking", "Pondering", "Mulling it over", "Reasoning", "Cogitating", "Weighing options", "Puzzling", "Deliberating", "Noodling", "Chewing on it", "Ruminating", "Reticulating splines"];
  var SLOW_MS = 120000;
  var lastEventAt = Date.now(); // client receipt time of the newest stream event
  var verbIndex = 0;
  var verbSince = Date.now();
  function refreshTail() {
    if (!live) { tail.hidden = true; return; }
    clearPlaceholder();
    var now = Date.now();
    // A new word every 6 s, in order — predictable, not twitchy.
    if (now - verbSince > 6000) { verbIndex = (verbIndex + 1) % THINKING.length; verbSince = now; }
    tailVerb.textContent = THINKING[verbIndex] + "\\u2026";
    var since = now - lastEventAt;
    tailSince.textContent = formatElapsed(since);
    tailSince.className = since >= SLOW_MS ? "since slow" : "since";
    tailSince.setAttribute("title", "since the last event arrived");
    tail.hidden = false;
  }
  window.setInterval(refreshTail, 1000);
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
  var stepNodes = {}; // step.index -> { li, calls, group, gbody, tally, step, manual }
  var callNodes = {}; // call.id -> { details, glyph, facts, body }
  // The model turn waiting for the step it produced: a \`turn\` change arrives
  // BEFORE that step, so it is held here and painted in the step's head row (one
  // thought = one block). A turn with no step after it (the answer's thinking, or
  // the run ended) is flushed as its own row.
  var pendingTurn = null;
  var lastStepIndex = -1;
  // The head row of a step (or of a stray turn): [when] · 💭 how long the model
  // thought (amber past 2 min) · what it then said — the narration is what the
  // thinking produced, so they share one line — · the turn's token facts.
  // \`turn\` may be null (a stream from before turns existed); \`narration\` may be
  // null (a tool-only completion) — then a muted note fills the slot.
  // Appends to \`li\`: the head row (gutter timestamp · 💭 chip · narration) and,
  // under it, the turn's token facts as their own quiet line.
  function turnFacts(turn) {
    var facts = el("div", "turnfacts");
    if (turn) for (var i = 0; i < turn.facts.length; i++) facts.appendChild(el("span", "fact", turn.facts[i]));
    return facts;
  }
  function appendHead(li, at, turn, narration, note) {
    var row = el("div", "narration");
    row.appendChild(stamp(at));
    if (turn) {
      // Amber by default — thinking time is the thing to notice; a sub-minute
      // turn is quiet.
      var chip = el("span", "think" + (turn.durationMs < 60000 ? " quick" : ""), turn.label.replace(/^Thought for /, ""));
      chip.setAttribute("title", turn.label);
      row.appendChild(chip);
    }
    if (narration) {
      var box = el("div", "md");
      md(box, narration.text);
      row.appendChild(box);
      li.appendChild(turnFacts(turn)); // above the prose: a small tight metadata line, never where the eye lands first
      li.appendChild(row);
    } else if (turn && turn.facts.length) {
      // No prose to head the step: the facts ARE the head — one row, no filler
      // text for the eye to land on (the calls below say what happened).
      row.appendChild(turnFacts(turn));
      li.appendChild(row);
    } else {
      row.appendChild(el("span", "nonar", note));
      li.appendChild(row);
      li.appendChild(turnFacts(turn));
    }
  }
  function addStep(step) {
    // A new step begins: the previous step is over — fold its calls unless
    // something in it failed (or the viewer toggled it by hand).
    if (lastStepIndex >= 0) { foldStep(stepNodes[lastStepIndex]); stepNodes[lastStepIndex].li.classList.remove("live"); }
    lastStepIndex = step.index;
    var li = el("li", "step live");
    var turn = pendingTurn;
    pendingTurn = null;
    var at = step.narration ? step.narration.at : turn ? turn.at : undefined;
    appendHead(li, at, turn, step.narration || null, "no commentary"); // the turn produced calls only — they are the rows below
    var calls = el("div", "calls");
    li.appendChild(calls);
    log.insertBefore(li, tail);
    stepNodes[step.index] = { li: li, calls: calls, group: null, gbody: null, tally: null, step: step, manual: false };
    return li;
  }
  // --- call groups -----------------------------------------------------------
  // From the second call on, a step's cards live inside ONE <details class="group">
  // whose summary tallies them: "[when] ❯ 7 calls · ✓ 6 · ✗ 1 · 9.4s". It stays
  // open while a call is running or after a failure; addStep folds it otherwise.
  function groupFor(node) {
    if (node.group) return node.group;
    var g = el("details", "group");
    g.open = true;
    var s = el("summary");
    if (node.step.calls[0] && typeof node.step.calls[0].startedAt === "number") s.setAttribute("title", "calls began " + formatLocalIso(node.step.calls[0].startedAt));
    s.appendChild(el("span", "gchev", "\\u276f"));
    // The tally cells, kept by name on the node so refreshGroup never depends
    // on their order here.
    node.tally = { count: el("span", "gcount", ""), ok: el("span", "gok", ""), bad: el("span", "gbad", ""), infra: el("span", "ginfra", ""), running: el("span", "grun", ""), time: el("span", "gtime", "") };
    s.appendChild(node.tally.count);
    s.appendChild(node.tally.ok);
    s.appendChild(node.tally.bad);
    s.appendChild(node.tally.infra);
    s.appendChild(node.tally.running);
    s.appendChild(node.tally.time);
    // A click on the summary is the viewer's choice; the auto-fold then leaves
    // this group alone.
    s.addEventListener("click", function () { node.manual = true; });
    g.appendChild(s);
    var body = el("div", "gbody");
    g.appendChild(body);
    // Move the first card (already painted directly under the step) inside.
    while (node.calls.firstChild) body.appendChild(node.calls.firstChild);
    node.calls.appendChild(g);
    node.group = g;
    node.gbody = body;
    refreshGroup(node);
    return g;
  }
  function refreshGroup(node) {
    if (!node.group) return;
    var calls = node.step.calls, n = 0, ok = 0, bad = 0, infra = 0, running = 0, ms = 0;
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      if (c.quiet) continue;
      n++;
      if (c.status === "ok") ok++;
      else if (c.status === "failed") bad++;
      else if (c.status === "infra") infra++;
      else running++;
      if (typeof c.durationMs === "number") ms += c.durationMs;
    }
    var t = node.tally;
    t.count.textContent = n + (n === 1 ? " call" : " calls");
    t.ok.textContent = ok ? "\\u2713 " + ok : "";
    t.bad.textContent = bad ? "\\u2717 " + bad : "";
    t.infra.textContent = infra ? "\\u26a0 " + infra : "";
    t.running.textContent = running ? running + " running" : "";
    t.time.textContent = ms > 0 ? formatElapsed(ms) : "";
    if (bad || infra || running) node.group.open = true;
  }
  function foldStep(node) {
    if (!node || !node.group || node.manual || allOpen) return;
    var calls = node.step.calls;
    for (var i = 0; i < calls.length; i++) if (calls[i].status !== "ok" && !calls[i].quiet) return;
    node.group.open = false;
  }
  function cardParent(node) {
    var cards = 0;
    for (var i = 0; i < node.step.calls.length; i++) if (!node.step.calls[i].quiet) cards++;
    return cards >= 2 ? groupFor(node).lastChild : node.calls;
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
    if (!stepNodes[step.index]) addStep(step);
    var node = stepNodes[step.index];
    var parent = cardParent(node); // may create the group (the model already holds this call)
    if (call.quiet) {
      var q = el("div", "quiet");
      q.appendChild(stamp(call.startedAt));
      q.appendChild(el("span", "", "\\u270e " + (call.tool === "update_status" ? "status checklist updated" : call.title)));
      parent.appendChild(q);
      callNodes[call.id] = { quiet: q };
      refreshGroup(node);
      return q;
    }
    var details = el("details", "call " + call.status);
    // The call's start time is pacing information, not a headline: it rides on
    // the card's hover (the step's gutter carries the timestamp that matters).
    if (typeof call.startedAt === "number") details.setAttribute("title", "started " + formatLocalIso(call.startedAt));
    var summary = el("summary");
    var glyph = glyphFor(call);
    summary.appendChild(glyph);
    // Shell: a dim $ then the command. Other tools: the tool-name chip then the
    // target (web_fetch <url>); a call whose summary is only the tool name
    // (submit_verdict) shows the chip alone — no duplicated word.
    summary.appendChild(call.shell ? el("span", "dollar", "$") : el("span", "tool", call.tool));
    if (call.shell || call.title !== call.tool) {
      summary.appendChild(el("code", "cmd brief", call.headline));
      summary.appendChild(el("code", "cmd full", call.title));
    } else summary.appendChild(el("span", "cmd", ""));
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
    refreshGroup(node);
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
    if (stepNodes[step.index]) refreshGroup(stepNodes[step.index]);
    return n.details;
  }
  // A model turn (item 15): "💭 Thought for 5m 04s" plus the token facts. Held
  // for the step it produced — addStep paints it in that step's head row (item 18).
  function addTurn(change) {
    if (pendingTurn) flushTurn();
    pendingTurn = change;
  }
  // A turn with no step after it (the answer's own thinking, or the run ended
  // mid-thought): its own head row, \`note\` saying what came of it.
  function flushTurn(note) {
    if (!pendingTurn) return null;
    var li = el("li", "turn");
    appendHead(li, pendingTurn.at, pendingTurn, null, note || "");
    pendingTurn = null;
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
  // A skill loaded into context (features/skills.md): its own row inside the
  // step, distinct from the use_skill call card above it — \`📚 skill <name>\`,
  // the description, the source as a link (http(s) only, setAttribute — never
  // markup), and the context cost.
  function addSkill(step, skill) {
    if (!stepNodes[step.index]) addStep(step);
    var node = stepNodes[step.index];
    var parent = cardParent(node);
    var row = el("div", "skill");
    row.appendChild(stamp(skill.at));
    row.appendChild(el("span", "skillmark", "\\ud83d\\udcda"));
    row.appendChild(el("span", "skillname", "skill " + skill.name));
    if (skill.description) row.appendChild(el("span", "skilldesc", skill.description));
    var facts = el("span", "facts");
    if (skill.source) {
      var a = el("a", "fact", "source");
      a.setAttribute("href", skill.source);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      facts.appendChild(a);
    }
    facts.appendChild(el("span", "fact", fmtBytes(skill.bodyBytes) + " into context"));
    row.appendChild(facts);
    parent.appendChild(row);
    refreshGroup(node);
    return row;
  }
  function fmtBytes(n) {
    if (!(n > 0)) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (Math.round(n / 102.4) / 10).toFixed(1) + " KB";
    return (Math.round(n / 104857.6) / 10).toFixed(1) + " MB";
  }
  // Expand all / Collapse all: flips every card, and every card added later
  // while "expanded" starts open (a viewer who opened everything wants it all).
  var fold = document.getElementById("fold");
  var allOpen = false;
  fold.addEventListener("click", function () {
    allOpen = !allOpen;
    fold.textContent = allOpen ? "Collapse all" : "Expand all";
    fold.setAttribute("data-open", allOpen ? "1" : "0");
    fold.setAttribute("aria-pressed", allOpen ? "true" : "false");
    fold.setAttribute("title", allOpen ? "Close every call card" : "Open every call card");
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
      addTurn(change); // painted with the step that follows (or flushed before the answer)
    } else if (change.kind === "meta") {
      showMeta(change);
    } else if (change.kind === "skill") {
      follow(addSkill(change.step, change.skill), wasAtTail);
    } else if (change.kind === "context") {
      contextTurn(change);
    } else if (change.kind === "note" || change.kind === "replay_note") {
      follow(addNote(change), wasAtTail);
      if ((change.noteKind === "stop_requested" || change.noteKind === "stopped") && change.mode) markStopping(change.mode);
    } else if (change.kind === "answer") {
      // The run's final answer — the same text the thread got, as markdown.
      flushTurn("wrote the answer below"); // the answer's own thinking has no step to sit on
      if (lastStepIndex >= 0) foldStep(stepNodes[lastStepIndex]);
      answerTs.textContent = fmtTime(change.at);
      md(answerText, change.text);
      answerBox.hidden = false;
      follow(answerBox, wasAtTail);
    }
  }
  // ONE fold for every frame — the seeded history and the live stream go
  // through the same push → apply path, so the two pages can never drift apart.
  // \`wasAtTail\` is sampled once per event, BEFORE anything is added.
  // The run's span on the runner clock (first event's \`at\` → last event's), for
  // the finished header: \`finished · 2m 27s\` (item 20).
  var firstAt = null, lastAt = null;
  function handle(e) {
    lastEventAt = Date.now();
    if (e && typeof e.at === "number") { if (firstAt === null || e.at < firstAt) firstAt = e.at; if (lastAt === null || e.at > lastAt) lastAt = e.at; }
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
    es.onopen = function () { live = true; if (!stopMode) setConn("green", "connected"); refreshTail(); };
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
      flushTurn("the run ended here"); // a run that ended without an answer still shows its last turn
      refreshTail();
      actions.hidden = true;
      var took = firstAt !== null && lastAt !== null && lastAt > firstAt ? " \\u00b7 " + formatElapsed(lastAt - firstAt) : "";
      setConn("grey", (stopMode ? "stopped (" + stopMode + ")" : "finished") + took);
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
