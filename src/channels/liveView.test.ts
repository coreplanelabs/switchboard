import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import {
  createLiveViewHandler,
  escapeHtml,
  indexRowHtml,
  indexRowRenderer,
  INDEX_ROW_SCRIPT,
  parseLastEventId,
  parseRunRoute,
  renderRunPage,
  RUN_TIMELINE_SCRIPT,
  renderRunsIndex,
  retentionSentence,
  seedEventsJson,
  serveEvents,
  serveIndexEvents,
  staticDocument,
  withOmittedMarkers,
  type IndexRow,
  type LiveViewDeps,
  type SseSink,
} from "./liveView.js";
import { renderMarkdownInto } from "./markdownLite.js";
import { createRunTimeline } from "./runTimeline.js";
import { isLoopbackAddress } from "./commandHttp.js";
import { RunRegistry } from "../core/runRegistry.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent } from "../core/runEvents.js";
import { RUN_LIST_MAX_LIMIT, type RunRecord } from "../core/runRecord.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";
import type { IndexEvent, RunSummary } from "../core/runRegistry.js";
import { FIXTURE_SCHEDULES } from "./scheduledPanel.test.js";
import { InMemoryScheduleStore, type ScheduleStore } from "../core/scheduleStore.js";

// Feature: features/live-view.md — the external live-view page + SSE stream.
// Auth is a per-run capability token (in the URL, not a header); a wrong/missing
// token or unknown run is a 404. Handlers are transport-free where possible:
// parseRunRoute (pure), renderRunPage (pure), serveEvents (drives an SseSink).

const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
const result = (ok: boolean, summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary });

/** Every SSE response now writes this prelude first, to flush the 200 head so the
 *  browser's EventSource fires `onopen` even before any data (fixes the page being
 *  stuck "connecting" through a buffering proxy when there's nothing to replay). */
const PRELUDE = "retry: 3000\n\n";

/** Deterministic registry so ids/tokens are predictable in URL assertions. */
function fixedRegistry() {
  let n = 0;
  return new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}` });
}

/** The handler over a registry alone — run history off (store: null), the
 *  pre-#157 live-only shape every token-path test below exercises. */
function liveOnlyHandler(registry: RunRegistry) {
  return createLiveViewHandler({ service: createRunsService({ registry, store: null }), index: registry, retention: null });
}

/** An SseSink that records everything written, for socket-free assertions. */
function recordingSink() {
  let status = 0;
  let headers: Record<string, string> = {};
  const writes: string[] = [];
  let ended = false;
  let closeCb: (() => void) | undefined;
  const sink: SseSink = {
    writeHead: (s, h) => {
      status = s;
      headers = h;
    },
    write: (c) => void writes.push(c),
    end: () => void (ended = true),
    onClose: (cb) => void (closeCb = cb),
  };
  return {
    sink,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    writes,
    body: () => writes.join(""),
    get ended() {
      return ended;
    },
    fireClose: () => closeCb?.(),
  };
}

describe("parseRunRoute", () => {
  it("matches the page route", () => {
    expect(parseRunRoute("/runs/abc123")).toEqual({ id: "abc123", kind: "page" });
  });
  it("matches the events route", () => {
    expect(parseRunRoute("/runs/abc123/events")).toEqual({ id: "abc123", kind: "events" });
  });
  it("decodes a percent-encoded id", () => {
    expect(parseRunRoute("/runs/a%2Db")).toEqual({ id: "a-b", kind: "page" });
  });
  it("matches the bare index route (the Access-gated home page, no id)", () => {
    expect(parseRunRoute("/runs")).toEqual({ kind: "index" });
    expect(parseRunRoute("/runs/")).toEqual({ kind: "index" });
  });
  it("returns null for non-run paths, an empty id, or malformed encoding", () => {
    expect(parseRunRoute("/ingress")).toBeNull();
    expect(parseRunRoute("/runs/abc/events/extra")).toBeNull();
    expect(parseRunRoute("/runs/%zz")).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes &, <, >, \", ' so a payload cannot break out of server-rendered markup", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });
  it("escapes & before the entity-introducing characters (no double-escaping order bug)", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;"); // the literal input & is escaped once
  });
});

describe("renderRunsIndex", () => {
  const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
    id: "run-1",
    token: "tok-1",
    label: "coding · owner/repo",
    finished: false,
    startedAt: 1000,
    eventCount: 3,
    ...over,
  });

  it("lists each run as a link carrying its per-run token", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toContain('href="/runs/run-1?t=tok-1"');
    expect(html).toContain("coding · owner/repo");
  });

  it("shows an empty-state message when there are no active runs", () => {
    expect(renderRunsIndex([])).toMatch(/no active runs/i);
  });

  it("is self-contained (no external/CDN assets — CSP-safe)", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toContain("//cdn");
  });

  it("HTML-escapes a malicious label instead of injecting it", () => {
    const html = renderRunsIndex([summary({ label: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("URL-encodes id/token into the href so special chars can't break the link or markup", () => {
    const html = renderRunsIndex([summary({ id: 'a/b"c', token: 'x"y', label: undefined })]);
    expect(html).toContain("/runs/a%2Fb%22c?t=x%22y");
    expect(html).not.toContain('t=x"y'); // raw quote never lands in an attribute
  });

  it("opens an EventSource on the index SSE feed (/runs?stream=1) for live updates", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toContain('new EventSource("/runs?stream=1")');
  });

  it("keys each server-rendered row by data-run-id so the client can reconcile it", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toContain('data-run-id="run-1"');
  });

  it("escapes the data-run-id attribute so a hostile id can't break out of it", () => {
    const html = renderRunsIndex([summary({ id: 'a"b', label: undefined })]);
    expect(html).toContain('data-run-id="a&quot;b"');
    expect(html).not.toContain('data-run-id="a"b"');
  });

  it("updates rows client-side with textContent, never innerHTML (no injection)", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
  });

  it("has a connection-state indicator like the per-run page", () => {
    const html = renderRunsIndex([]);
    expect(html).toContain('id="state"');
  });

  it("carries data-started-at on each row so the client can place rows by start time", () => {
    const html = renderRunsIndex([summary({ startedAt: 1000 })]);
    expect(html).toContain('data-started-at="1000"');
  });

  it("server-renders multiple runs newest-first, with matching data-started-at order", () => {
    const html = renderRunsIndex([
      summary({ id: "newer", startedAt: 2000, label: undefined }),
      summary({ id: "older", startedAt: 1000, label: undefined }),
    ]);
    expect(html.indexOf('data-run-id="newer"')).toBeLessThan(html.indexOf('data-run-id="older"'));
    expect(html.indexOf('data-started-at="2000"')).toBeLessThan(html.indexOf('data-started-at="1000"'));
  });

  it("inserts new rows by startedAt (sorted), not a blind prepend — so a replayed batch isn't inverted", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toContain("insertSorted"); // client places by comparing data-started-at
    expect(html).not.toContain("list.firstChild"); // the old blind-prepend is gone
  });

  it("makes the ENTIRE row a link (full-row clickable), with the label inside the anchor", () => {
    const html = renderRunsIndex([summary()]);
    // the whole row content sits inside a single anchor carrying the token URL
    expect(html).toContain('<a class="row" href="/runs/run-1?t=tok-1">');
    // the label lives inside that anchor (not a bare text node beside it)
    expect(html).toMatch(/<a class="row"[^>]*>[\s\S]*coding · owner\/repo[\s\S]*<\/a>/);
    // the data attrs the client reconciles on stay on the <li>, not the <a>
    expect(html).toContain('<li data-run-id="run-1" data-started-at="1000">');
  });

  it("has a :hover background so the row reads as clickable", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toMatch(/\.row:hover\s*\{[^}]*background/);
  });

  it("renders a per-row status dot: green for live, grey for finished, with an accessible label", () => {
    const live = renderRunsIndex([summary({ finished: false })]);
    expect(live).toMatch(/<span class="dot green"[^>]*aria-label="live"/);
    const done = renderRunsIndex([summary({ finished: true })]);
    expect(done).toMatch(/<span class="dot grey"[^>]*aria-label="finished"/);
  });

  it("gives the header connection indicator a status dot alongside its label (dot + label)", () => {
    const html = renderRunsIndex([]);
    expect(html).toContain('id="statedot"'); // the colored connection dot
    expect(html).toContain('id="state"'); // and its text label
  });

  it("client-added rows are full-row clickable and carry a status dot too (parity with server rows)", () => {
    const html = renderRunsIndex([summary()]);
    expect(html).toContain('a.className = "row"'); // client builds the same full-row anchor
    expect(html).toContain('dot.setAttribute("aria-label"'); // …and an accessible status dot
    expect(html).not.toContain("innerHTML"); // still textContent/setAttribute only
  });

  it("HTML-escapes a hostile label even inside the full-row anchor", () => {
    const html = renderRunsIndex([summary({ label: "<img src=x onerror=alert(1)>" })]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

// Feature: features/live-view.md item 11 — the run page shows the final answer
// (the `answer` event) as its own block, via textContent; the index hides its
// empty-state sentinel even though rows are flex containers.
describe("final answer on the run page + index empty-state (post-#137 fixes)", () => {
  it("renders an `answer` change into a dedicated block through the safe markdown renderer", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toContain('change.kind === "answer"');
    expect(html).toContain('id="answer"');
    expect(html).toMatch(/md\(answerText, change\.text\)/);
    expect(html).not.toContain("innerHTML");
    // Every addition — the answer included — only scrolls into view when the
    // viewer was already at the tail; a reader parked on earlier steps keeps
    // their place (review nit, #158). `wasAtTail` is sampled once per event,
    // BEFORE anything is added, so the addition itself can't defeat the check.
    expect(html).toMatch(/var wasAtTail = atTail\(\);\s*var changes = timeline\.push\(e\);/);
    expect(html).toMatch(/function follow\(node, wasAtTail\) \{ if \(wasAtTail\) node\.scrollIntoView/);
    expect(html).toContain("follow(answerBox, wasAtTail)");
  });

  it("every markdown surface renders through a try/catch guard that falls back to textContent (#179 review)", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toMatch(/function md\(target, text\) \{\s*try \{ renderMarkdownInto\(target, text\); \} catch \(_\) \{ target\.textContent = text; \}/);
    // The three surfaces call the guard, never the renderer directly.
    expect(html).toContain("md(box, step.narration.text)");
    expect(html).toContain("md(requestText, change.text)");
    expect(html).toContain("md(answerText, change.text)");
    expect(html.match(/renderMarkdownInto\(/g)?.length).toBe(1 + 1); // the definition + the guard's single call
  });

  it("the index hides the empty sentinel with a rule that beats `#runs li { display:flex }`", () => {
    const html = renderRunsIndex([]);
    expect(html).toMatch(/#runs li\[hidden\]\s*\{\s*display:\s*none/);
  });
});

// Feature: features/live-view.md item 12 — the run page is a timeline of the
// whole run: the request on top, the model's prose between tool rows, a UTC
// timestamp on every row, and markdown rendered through the inlined safe subset.
describe("run page timeline (request, assistant turns, timestamps, markdown)", () => {
  const html = renderRunPage("run-1", "tok-1");

  it("inlines the self-contained markdown renderer AND the timeline model (String(fn)), shim first", () => {
    expect(html).toContain(String(renderMarkdownInto));
    expect(html).toContain(RUN_TIMELINE_SCRIPT);
    expect(RUN_TIMELINE_SCRIPT).toBe(String(createRunTimeline));
    // The transpiler's keepNames helper (`__name`, emitted by esbuild under tsx)
    // must resolve in the browser: a no-op shim precedes BOTH inlined sources.
    const shim = html.indexOf("var __name = function (fn) { return fn; };");
    expect(shim).toBeGreaterThan(-1);
    expect(shim).toBeLessThan(html.indexOf("function renderMarkdownInto("));
    expect(shim).toBeLessThan(html.indexOf("function createRunTimeline("));
    // every event goes through the model; the page applies its changes
    expect(html).toContain("var timeline = createRunTimeline();");
    expect(html).toContain("var changes = timeline.push(e);");
    expect(html).not.toContain("innerHTML");
  });

  it("renders the `input` change into a Request block that sits ABOVE the log, the answer below", () => {
    expect(html).toContain('change.kind === "input"');
    expect(html).toContain('id="request"');
    expect(html.indexOf('id="request"')).toBeLessThan(html.indexOf('<ol id="log"'));
    expect(html.indexOf('<ol id="log"')).toBeLessThan(html.indexOf('id="answer"'));
    expect(html).toContain(">Request<");
  });

  it("renders a step's narration as proportional prose and its calls beneath it, on ONE left edge (no rails)", () => {
    expect(html).toContain('change.kind === "step"');
    expect(html).toMatch(/li\.step > \.narration\s*\{[^}]*display: flex/);
    expect(html).not.toMatch(/\.calls\s*\{[^}]*border-left/); // the rail that misaligned with the prose is gone
    // steps are separated by space that beats the `#log > li` margin reset
    expect(html).toMatch(/#log > li\.step \+ li\.step\s*\{[^}]*margin-top/);
  });

  it("stamps every row and both blocks with a gray local-zone ISO timestamp from `at` (omitted when absent)", () => {
    // formatLocalIso (localIso.ts) is inlined and reads the viewer's zone offset
    expect(html).toContain("function formatLocalIso(");
    expect(html).toContain("getTimezoneOffset()");
    expect(html).not.toContain("toISOString().slice(11, 19)");
    expect(html).toMatch(/function fmtTime\(at\)\s*\{\s*return typeof at === "number" \? "\[" \+ formatLocalIso\(at\) \+ "\]" : "";/);
    expect(html).toMatch(/\.ts\s*\{[^}]*color:\s*var\(--dim\)/); // gray
    // no `at` → no bracket: the formatter returns "" for a missing timestamp
    expect(html).toMatch(/function fmtTime\(at\)\s*\{\s*return typeof at === "number" \? "\[" \+ .*\]" : "";/);
    // rows are built from a timestamp span + a body, via createElement/textContent
    expect(html).toContain('function stamp(at) { return el("span", "ts", fmtTime(at)); }');
    expect(html).toContain("stamp(step.narration.at)");
    expect(html).toContain("stamp(call.startedAt)");
    expect(html).toContain("requestTs.textContent = fmtTime(change.at)");
    expect(html).toContain("answerTs.textContent = fmtTime(change.at)");
  });

  it("keeps the commands monospace and the markdown surfaces proportional", () => {
    expect(html).toMatch(/body\s*\{[^}]*font: 13px\/1\.5 var\(--mono\)/);
    expect(html).toMatch(/--mono: ui-monospace/);
    expect(html).toMatch(/\.md\s*\{[^}]*var\(--sans\)/);
    expect(html).toMatch(/--sans: -apple-system/);
  });
});

// Feature: features/live-view.md item 13 — the run page groups the flat stream
// into steps and call cards: the command as a collapsible <details> with its
// truthful status, exit code, size and duration in the header and the redacted
// output inside; failures open by default; a live tail names what is running.
describe("run page call cards (grouped timeline, item 13)", () => {
  const html = renderRunPage("run-1", "tok-1");

  it("renders each call as a native <details> card: <summary> header, output body — no custom toggle JS", () => {
    expect(html).toContain('el("details", "call " + call.status)');
    expect(html).toContain('el("summary")');
    expect(html).toContain('el("pre", "out", text)');
    expect(html).toMatch(/details\.call > summary::-webkit-details-marker \{ display: none; \}/);
    expect(html).toMatch(/details\.call > summary:focus-visible \{ outline/); // keyboard-reachable
  });

  it("the header carries: timestamp, status glyph (spinner while running, ✓ ✗ ⚠ after), `$` for shell / tool chip otherwise, command, facts, chevron", () => {
    expect(html).toContain('if (call.status === "running") return el("span", "spin");');
    expect(html).toContain('call.status === "ok" ? "\\u2713" : call.status === "failed" ? "\\u2717" : "\\u26a0"');
    expect(html).toContain('call.shell ? el("span", "dollar", "$") : el("span", "tool", call.tool)');
    expect(html).toContain('el("span", bad ? "fact bad" : "fact", f)'); // exit 1 / error / sandbox error read red
    expect(html).toContain('el("span", "chev", "\\u276f")');
    expect(html).toMatch(/details\.call\[open\] > summary \.chev \{ transform: rotate\(90deg\); \}/);
  });

  it("collapsed shows the one-line headline; open shows the full command with a hanging indent for wrapped lines", () => {
    expect(html).toContain('el("code", "cmd brief", call.headline)');
    expect(html).toContain('el("code", "cmd full", call.title)');
    expect(html).toMatch(/details\.call:not\(\[open\]\) > summary \.cmd\.full \{ display: none; \}/);
    expect(html).toMatch(/details\.call\[open\] > summary \.cmd\.brief \{ display: none; \}/);
    // the command is its own flex item with pre-wrap, so continuation lines
    // align under the command's first character, not under the timestamp
    expect(html).toMatch(/\.cmd \{[^}]*flex: 1 1 auto[^}]*white-space: pre-wrap/);
    expect(html).toMatch(/\.cmd\.brief \{[^}]*text-overflow: ellipsis/);
  });

  it("the body shows the redacted output (or `no output` / `running…`), never markup", () => {
    expect(html).toContain("var text = call.result.output || call.result.summary;");
    expect(html).toContain('el("div", "none", "no output")');
    expect(html).toContain('el("div", "none", "running\\u2026")');
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("insertAdjacentHTML");
  });

  it("failures and sandbox errors open by default; the list is a page constant overridable with ?open=tag,tag (or all)", () => {
    expect(html).toContain('var OPEN_BY_DEFAULT = ["failed", "infra"];');
    expect(html).toContain('new URLSearchParams(window.location.search).get("open")');
    expect(html).toMatch(/if \(OPEN_BY_DEFAULT\.indexOf\("all"\) !== -1\) return true;/);
    expect(html).toContain("if (allOpen || opensByDefault(call)) details.open = true;"); // at creation (replayed backlog)
    expect(html).toContain("if (opensByDefault(call)) n.details.open = true;"); // when the result lands
  });

  it("has an Expand all / Collapse all toggle that also applies to cards added later", () => {
    expect(html).toContain('id="fold"');
    expect(html).toContain('fold.textContent = allOpen ? "Collapse all" : "Expand all";');
    expect(html).toContain('log.querySelectorAll("details.call")');
  });

  it("update_status is one muted line, not a card", () => {
    expect(html).toContain("if (call.quiet) {");
    expect(html).toContain('"status checklist updated"');
  });

  it("a live tail row is pinned last while connected — naming the running command or `thinking…` — and removed at end/disconnect", () => {
    expect(html).toContain('var tail = el("li", "tail");');
    expect(html).toContain("log.insertBefore(li, tail)"); // steps and notes go above the tail
    expect(html).toMatch(/tailText\.textContent = p \? "running \\u00b7 " \+ .*p\.headline/);
    expect(html).toContain(': "thinking\\u2026"');
    expect(html).toMatch(/es\.onopen = function \(\) \{ live = true;[^}]*refreshTail\(\);/);
    expect(html).toMatch(/es\.addEventListener\("end", function \(\) \{\s*live = false;\s*refreshTail\(\);/);
    expect(html).toMatch(/if \(!live\) \{ tail\.hidden = true; return; \}/);
    expect(html).toMatch(/li\.tail \.pulse \{[^}]*animation: pulse/);
  });

  it("the Request block shows where the request came from: #channel · user · an `open thread` link (http(s) only, noopener)", () => {
    expect(html).toContain('id="source"');
    expect(html).toContain("showSource(change.source)");
    expect(html).toContain('source.appendChild(el("span", "", "#" + src.channel))');
    expect(html).toMatch(/if \(typeof src\.url === "string" && \/\^https\?:\\\/\\\/\/\.test\(src\.url\)\)/);
    expect(html).toContain('a.setAttribute("href", src.url)');
    expect(html).toContain('a.setAttribute("rel", "noopener noreferrer")');
  });

  it("hides the tail with a rule that beats `li.tail { display: flex }` (a finished run must not keep 'thinking…')", () => {
    // Same class of bug as the index empty sentinel: `li.tail` (0,1,1) outranks
    // `[hidden]` (0,1,0), so `tail.hidden = true` alone left it rendered.
    expect(html).toMatch(/li\.tail\[hidden\]\s*\{\s*display:\s*none/);
  });

  it("leaves room at the bottom so the tail never sits on the viewport edge", () => {
    expect(html).toMatch(/body\s*\{[^}]*padding: 1\.25rem 1\.25rem 8rem/);
  });

  it("the inlined page script parses as JavaScript (shim + both String(fn) sources + the IIFE)", () => {
    const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    // No DOM here — just prove the source is syntactically sound as shipped.
    expect(() => new Function(script)).not.toThrow();
  });
});

// Feature: features/live-view.md item 12 polish (#209): the "Waiting for
// activity…" placeholder must disappear on ANY first event — a no-tool run
// (input → answer, no rows) previously kept it forever — and the page styles
// the renderer's new tables and h4–h6 headings.
describe("run page placeholder + table/heading polish (#209)", () => {
  const html = renderRunPage("run-1", "tok-1");

  it("clears the placeholder on ANY painted change (input/answer too), not only call cards", () => {
    // one named helper, so every clearing site is the same code
    expect(html).toMatch(/function clearPlaceholder\(\) \{ if \(placeholder\) \{ placeholder\.remove\(\); placeholder = null; \} \}/);
    // apply() is the single paint dispatcher — clearing there covers input,
    // step, call, result, note AND answer (a no-tool run never keeps the sentinel)
    expect(html).toMatch(/function apply\(change, wasAtTail\) \{\s*clearPlaceholder\(\);/);
    // the live tail also clears it (it pins a row into the log)
    expect(html).toMatch(/function refreshTail\(\) \{[\s\S]{0,80}clearPlaceholder\(\);/);
    // no clearing site bypasses the helper
    expect(html.match(/placeholder\.remove\(\)/g)).toHaveLength(1);
  });

  it("styles markdown tables (bordered, collapsed) and h4\u2013h6 headings", () => {
    expect(html).toMatch(/\.md table\s*\{[^}]*border-collapse:\s*collapse/);
    expect(html).toMatch(/\.md th, \.md td\s*\{[^}]*border:/);
    expect(html).toMatch(/\.md h1, \.md h2, \.md h3, \.md h4, \.md h5, \.md h6/);
  });
});

describe("renderRunPage", () => {
  const html = renderRunPage("run-1", "tok-secret");

  it("references the token-scoped EventSource URL for this run", () => {
    expect(html).toContain("/runs/run-1/events?t=tok-secret");
    expect(html).toContain("new EventSource(");
  });

  it("is self-contained (no external/CDN assets — CSP-safe)", () => {
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toContain("//cdn");
  });

  it("renders event summaries with textContent, never innerHTML (no injection)", () => {
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
  });

  it("URL-encodes id/token safely into the stream URL", () => {
    const page = renderRunPage("a/b", 'x"y');
    expect(page).toContain("/runs/a%2Fb/events?t=x%22y");
    // JSON-encoded into the script, so no raw quote breaks out of the string.
    expect(page).not.toContain('t=x"y');
  });

  it("carries the shared site nav with Runs current, plus the contextual back link", () => {
    expect(html).toContain('<nav class="site" aria-label="Sections">');
    expect(html).toContain('<a href="/runs" aria-current="page">Runs</a>');
    expect(html).toContain('<a href="/residents">Residents</a>');
    expect(html).toContain('<a href="/costs">Costs</a>');
  });

  it('has a "← All runs" back link to the token-less, Access-gated index', () => {
    expect(html).toContain('<a class="back" href="/runs">');
    expect(html).toContain("← All runs");
    // the index is Access-gated, not token-gated — the back link must carry no token
    expect(html).not.toMatch(/href="\/runs\?[^"]*t=/);
  });

  it("renders a connection status dot in the header (dot + label)", () => {
    expect(html).toContain('id="statedot"');
    expect(html).toContain('id="state"');
  });
});

describe("serveEvents (SSE, transport-free)", () => {
  it("404s when subscribe is rejected (unknown run or bad token), without an event stream", () => {
    const rec = recordingSink();
    serveEvents(() => null, rec.sink);
    expect(rec.status).toBe(404);
    expect(rec.body()).toContain("run not found");
    expect(rec.ended).toBe(true);
    expect(rec.headers["content-type"]).not.toContain("event-stream");
  });

  it("sets the text/event-stream headers and forwards live events as data frames", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    expect(rec.status).toBe(200);
    expect(rec.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(rec.headers["cache-control"]).toContain("no-cache");

    reg.publish(id, call("$ echo hi"));
    reg.publish(id, result(true, "hi"));
    // Each frame carries its stream position as the SSE id (resume token).
    // Each frame carries its stream position twice on purpose: as the SSE `id:`
    // (the resume cursor) and as `seq` on the event itself (the record's order).
    expect(rec.body()).toBe(PRELUDE + `id: 1\ndata: ${JSON.stringify({ ...call("$ echo hi"), seq: 1 })}\n\n` + `id: 2\ndata: ${JSON.stringify({ ...result(true, "hi"), seq: 2 })}\n\n`);
  });

  it("a reconnect with Last-Event-ID replays only the events after that position — never the whole backlog again", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("one"));
    reg.publish(id, call("two"));
    reg.publish(id, call("three"));
    const rec = recordingSink();
    const afterSeq = parseLastEventId("2");
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish, afterSeq), rec.sink);
    expect(rec.body()).toBe(PRELUDE + `id: 3\ndata: ${JSON.stringify({ ...call("three"), seq: 3 })}\n\n`);
    reg.publish(id, call("four"));
    expect(rec.body()).toContain(`id: 4\ndata: ${JSON.stringify({ ...call("four"), seq: 4 })}`);
  });

  it("parseLastEventId: a positive integer resumes; absent, empty, or garbage means from the start", () => {
    expect(parseLastEventId("17")).toBe(17);
    expect(parseLastEventId(" 3 ")).toBe(3);
    expect(parseLastEventId(["5", "9"])).toBe(5);
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId("")).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId("-1")).toBe(0);
    expect(parseLastEventId("1e3")).toBe(0);
  });

  it("serializes each event once however many viewers are attached (the frame body is byte-identical per subscriber)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const a = recordingSink();
    const b = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), a.sink);
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), b.sink);
    const spy = vi.spyOn(JSON, "stringify");
    reg.publish(id, result(true, "x".repeat(5000)));
    const calls = spy.mock.calls.filter((c) => typeof c[0] === "object" && c[0] !== null && (c[0] as { type?: string }).type === "tool_result");
    spy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(a.body()).toBe(b.body());
  });

  it("flushes the head with the prelude even when the backlog is empty (no stuck 'connecting')", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    expect(rec.status).toBe(200);
    expect(rec.body()).toBe(PRELUDE); // head flushed immediately, before any run event
  });

  it("flushes a late subscriber's replayed backlog AFTER the 200 head (never before)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("earlier"));
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    expect(rec.status).toBe(200);
    // The replayed backlog frame is present, and status was set before any write.
    expect(rec.body()).toContain(`data: ${JSON.stringify({ ...call("earlier"), seq: 1 })}`);
  });

  it("writes a terminal `end` frame and closes the stream when the run finishes", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    reg.publish(id, call("x"));
    reg.finish(id);
    expect(rec.body()).toContain("event: end");
    expect(rec.ended).toBe(true);
  });

  it("an already-finished run replays its backlog then ends immediately (still 200)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("done-earlier"));
    reg.finish(id);
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    expect(rec.status).toBe(200);
    expect(rec.body()).toContain(`data: ${JSON.stringify({ ...call("done-earlier"), seq: 1 })}`);
    expect(rec.body()).toContain("event: end");
    expect(rec.ended).toBe(true);
  });

  it("unsubscribes when the client connection closes", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    rec.fireClose(); // client disconnects
    reg.publish(id, call("after-close"));
    expect(rec.body()).not.toContain("after-close");
  });
});

describe("serveIndexEvents (index SSE, transport-free)", () => {
  it("buffers the synchronous replay, writes the 200 head, flushes it, then live-forwards; unsubscribes on close", () => {
    let emit: (ev: IndexEvent) => void = () => {};
    let unsubscribed = false;
    const rec = recordingSink();
    const replayed: IndexEvent = {
      type: "upsert",
      run: { id: "r1", token: "t1", finished: false, startedAt: 1, eventCount: 0 },
    };

    serveIndexEvents((onEvent) => {
      onEvent(replayed); // synchronous replay, BEFORE serveIndexEvents writes the head
      emit = onEvent;
      return () => void (unsubscribed = true);
    }, rec.sink);

    expect(rec.status).toBe(200);
    expect(rec.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(rec.headers["cache-control"]).toContain("no-cache");
    // The prelude flushes the head, then the replay frame follows (after the 200 head).
    expect(rec.body()).toBe(PRELUDE + `data: ${JSON.stringify(replayed)}\n\n`);

    const live: IndexEvent = { type: "removed", id: "r1" };
    emit(live);
    expect(rec.body()).toBe(PRELUDE + `data: ${JSON.stringify(replayed)}\n\n` + `data: ${JSON.stringify(live)}\n\n`);

    rec.fireClose();
    expect(unsubscribed).toBe(true);
  });

  it("streams a live upsert frame when a run is created on the shared registry", () => {
    const reg = fixedRegistry();
    const rec = recordingSink();
    serveIndexEvents((onEvent) => reg.subscribeIndex(onEvent), rec.sink);
    // Nothing to replay, but the prelude still flushes the head immediately — this
    // is the fix for the page hanging on "connecting…" when no runs are active.
    expect(rec.body()).toBe(PRELUDE);
    reg.create("coding · owner/repo");
    expect(rec.body()).toContain('"type":"upsert"');
    expect(rec.body()).toContain('"id":"run-1"');
    expect(rec.body()).toContain('"label":"coding · owner/repo"');
  });
});

// Feature: features/live-view.md item 14 (#244) — the Scheduled panel on the
// index: built from the schedule registry + the ScheduleStore's latest firings
// before the page is written; a missing/failing store is reported as such.
describe("scheduled panel on the index (#244)", () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0);
  /** A live-only handler (no run store) over `registry`, with the panel options under test. */
  function panelHandler(registry: RunRegistry, options: Pick<LiveViewDeps, "scheduled">) {
    return createLiveViewHandler({ service: createRunsService({ registry, store: null }), index: registry, retention: null, now: () => NOW, ...options });
  }
  function pageFor(options: Pick<LiveViewDeps, "scheduled">) {
    const registry = new RunRegistry({ genId: () => "run-live", genToken: () => "tok-live" });
    const handler = panelHandler(registry, options);
    let body = "";
    let status = 0;
    const res = {
      writeHead: (s: number) => void (status = s),
      write: (c: string) => void (body += c),
      end: (c?: string) => void (body += c ?? ""),
    };
    const req = { method: "GET", url: "/runs", headers: {}, on: () => {} };
    const owned = handler(req as never, res as never);
    return { registry, owned, get body() { return body; }, get status() { return status; } };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("without `scheduled` the index has no panel (unchanged page)", () => {
    const t = pageFor({});
    expect(t.owned).toBe(true);
    expect(t.status).toBe(200);
    expect(t.body).not.toContain('id="scheduled"');
  });

  it("renders the panel from the registry + the store's latest firings, linking a live run with its token", async () => {
    const registry = new RunRegistry({ genId: () => "run-live", genToken: () => "tok-live" });
    registry.create("friction · #cron · cron");
    const store = new InMemoryScheduleStore();
    await store.record({ schedule: "self-improvement", firedAt: NOW - 60_000, outcome: "completed", runId: "run-live", detail: "🔍 8 runs analyzed" });
    const handler = panelHandler(registry, { scheduled: { schedules: FIXTURE_SCHEDULES, store } });
    let body = "";
    const res = { writeHead: () => {}, write: () => {}, end: (c?: string) => void (body += c ?? "") };
    expect(handler({ method: "GET", url: "/runs", headers: {}, on: () => {} } as never, res as never)).toBe(true);
    await tick();
    expect(body).toContain('<tr data-schedule="self-improvement">');
    expect(body).toContain('<span class="outcome ok">completed</span>');
    expect(body).toContain('<a href="/runs/run-live?t=tok-live">run run-live</a>');
    expect(body).toContain("2026-08-31 14:00 UTC"); // next fire, Monday
    expect(body).toContain('<tr data-schedule="resident-watchdog">');
    expect(body).not.toContain('data-schedule="keep-alive"'); // internal plumbing stays off the dashboard
  });

  it("no store → the panel lists the schedules and says history is unavailable (not 'never fired')", async () => {
    const t = pageFor({ scheduled: { schedules: FIXTURE_SCHEDULES } });
    await tick();
    expect(t.status).toBe(200);
    expect(t.body).toContain("Firing history unavailable: schedules.worker is not configured");
    expect(t.body).not.toContain("never fired");
  });

  it("a failing store → the page still renders, with the failure as the reason", async () => {
    const store: ScheduleStore = {
      record: async () => {},
      latest: async () => {
        throw new Error("schedule worker /latest HTTP 503");
      },
    };
    const t = pageFor({ scheduled: { schedules: FIXTURE_SCHEDULES, store } });
    await tick();
    expect(t.status).toBe(200);
    expect(t.body).toContain("Firing history unavailable: schedule worker /latest HTTP 503");
    expect(t.body).toContain('<tr data-schedule="self-improvement">');
  });
});

describe("createLiveViewHandler (node:http)", () => {
  function fakeReqRes(method: string, url: string, headers: IncomingHttpHeaders = {}) {
    // Mimic node's EventEmitter: multiple listeners per event, all fired on emit.
    // (The SSE handler registers two "close" listeners — the sink's unsubscribe
    // and the heartbeat's clearInterval — and both must run.)
    const listeners: Record<string, Array<() => void>> = {};
    const req = {
      method,
      url,
      headers,
      on: (ev: string, cb: () => void) => void (listeners[ev] ??= []).push(cb),
    };
    let status = 0;
    let outHeaders: Record<string, string> = {};
    const chunks: string[] = [];
    let ended = false;
    const res = {
      writeHead: (s: number, h?: Record<string, string>) => {
        status = s;
        outHeaders = h ?? {};
      },
      write: (c: string) => void chunks.push(c),
      end: (c?: string) => {
        if (c) chunks.push(c);
        ended = true;
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[1],
      get status() {
        return status;
      },
      get headers() {
        return outHeaders;
      },
      body: () => chunks.join(""),
      get ended() {
        return ended;
      },
      fireClose: () => listeners.close?.forEach((cb) => cb()),
    };
  }

  it("returns false for a non-run path (server falls through to its other routes)", () => {
    const handler = liveOnlyHandler(fixedRegistry());
    const t = fakeReqRes("GET", "/ingress");
    expect(handler(t.req, t.res)).toBe(false);
    expect(t.status).toBe(0); // nothing written
  });

  it("serves the HTML page for a valid id+token (CSP set, no-store)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}?t=${token}`);
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
    expect(t.headers["content-security-policy"]).toContain("default-src 'none'");
    // Clickjacking defense on this public page (CSP frame-ancestors + legacy header).
    expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(t.headers["x-frame-options"]).toBe("DENY");
    expect(t.body()).toContain(`/runs/${id}/events?t=${token}`);
  });

  it("404s the page for a wrong/missing token (never reveals the run exists)", async () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    const handler = liveOnlyHandler(reg);
    const wrong = fakeReqRes("GET", `/runs/${id}?t=nope`);
    handler(wrong.req, wrong.res);
    await vi.waitFor(() => expect(wrong.status).toBe(404)); // the tokenless lookup is async (history path, #157 U8)
    expect(wrong.body()).not.toContain("EventSource"); // no page leaked

    const missing = fakeReqRes("GET", `/runs/${id}`);
    handler(missing.req, missing.res);
    await vi.waitFor(() => expect(missing.status).toBe(404));
  });

  it("streams SSE for a valid id+token and forwards events", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}/events?t=${token}`);
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    reg.publish(id, call("live one"));
    expect(t.body()).toContain(`data: ${JSON.stringify({ ...call("live one"), seq: 1 })}`);
    // Client disconnect unsubscribes.
    t.fireClose();
    reg.publish(id, call("after"));
    expect(t.body()).not.toContain("after");
  });

  it("404s the SSE stream for a wrong token", async () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}/events?t=nope`);
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status).toBe(404));
    expect(t.headers["content-type"]).not.toContain("event-stream");
  });

  it("405s a non-GET method on a run route", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("POST", `/runs/${id}?t=${token}`);
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(405);
  });

  // The bare /runs index is the Access-gated home page: it is NOT token-gated
  // (Cloudflare Access is the "who" gate), and it renders the per-run capability
  // links — so it must only ever be exposed behind Access. Same CSP + clickjacking
  // + no-store headers as the per-run page.
  it("serves the HTML index at bare /runs, listing active runs with their token links (CSP + no-store)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create("coding · owner/repo");
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
    expect(t.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(t.headers["x-frame-options"]).toBe("DENY");
    expect(t.headers["cache-control"]).toBe("no-store");
    expect(t.body()).toContain(`/runs/${id}?t=${token}`);
    expect(t.body()).toContain("coding · owner/repo");
  });

  it("also serves the index at /runs/ (trailing slash)", () => {
    const reg = fixedRegistry();
    reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs/");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
  });

  it("renders the empty state when there are no active runs", () => {
    const reg = fixedRegistry();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    handler(t.req, t.res);
    expect(t.status).toBe(200);
    expect(t.body()).toMatch(/no active runs/i);
  });

  it("405s a non-GET method on the index", () => {
    const reg = fixedRegistry();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("POST", "/runs");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(405);
  });

  it("HTML-escapes a malicious run label in the index instead of injecting markup", () => {
    const reg = new RunRegistry({ genId: () => "run-1", genToken: () => "tok-1" });
    reg.create("<script>alert(1)</script>");
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    handler(t.req, t.res);
    expect(t.body()).not.toContain("<script>alert(1)</script>");
    expect(t.body()).toContain("&lt;script&gt;");
  });

  it("routes /runs (no flag) to HTML and /runs?stream=1 to the index SSE feed", () => {
    const reg = fixedRegistry();
    reg.create("coding · owner/repo");
    const handler = liveOnlyHandler(reg);

    const htmlReq = fakeReqRes("GET", "/runs");
    handler(htmlReq.req, htmlReq.res);
    expect(htmlReq.headers["content-type"]).toContain("text/html");

    const sseReq = fakeReqRes("GET", "/runs?stream=1");
    handler(sseReq.req, sseReq.res);
    expect(sseReq.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
  });

  it("streams the index SSE feed at /runs?stream=1: replays active runs, forwards new ones, unsubscribes on close", () => {
    const reg = fixedRegistry();
    reg.create("coding · owner/repo"); // active before connect → replayed
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs?stream=1");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(t.body()).toContain('"label":"coding · owner/repo"'); // replayed upsert

    reg.create("review · thread-9"); // live upsert
    expect(t.body()).toContain('"label":"review · thread-9"');

    t.fireClose(); // client disconnects → unsubscribe
    reg.create("after-close");
    expect(t.body()).not.toContain("after-close");
  });

  it("405s a non-GET method on the index SSE stream", () => {
    const reg = fixedRegistry();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("POST", "/runs?stream=1");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(405);
  });

  // #66 follow-up: prove the keepalive TIMER's real behavior (not just the
  // prelude wiring). An idle live stream must emit a `: hb` comment every
  // SSE_HEARTBEAT_MS, and a client disconnect must clearInterval so no further
  // heartbeat is written. Driven with fake timers through the real handler.
  it("SSE heartbeat: writes a keepalive comment on an idle live stream, then stops on client close", () => {
    vi.useFakeTimers();
    try {
      const reg = fixedRegistry();
      const handler = liveOnlyHandler(reg);
      // The index feed with no runs stays open and idle — the exact case the
      // heartbeat exists for (only the prelude, then nothing but heartbeats).
      const t = fakeReqRes("GET", "/runs?stream=1");
      expect(handler(t.req, t.res)).toBe(true);
      expect(t.status).toBe(200);
      expect(t.body()).not.toContain(": hb"); // none before the first interval elapses

      vi.advanceTimersByTime(20_000);
      expect(t.body()).toContain(": hb\n\n"); // one heartbeat fired at the interval
      const afterOne = t.body();

      t.fireClose(); // client disconnects → clearInterval must stop the timer
      vi.advanceTimersByTime(40_000);
      expect(t.body()).toBe(afterOne); // nothing more written — the interval was cleared
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /runs/:id/friction — read-only friction diagnosis (#84)", () => {
  // Feature: features/run-friction.md. Same capability-token gate as the page
  // and the stream; a JSON diagnosis of the run's backlog (live or finished).
  function fakeReqRes(method: string, url: string) {
    const req = { method, url, headers: {}, on: () => {} };
    let status = 0;
    let outHeaders: Record<string, string> = {};
    const chunks: string[] = [];
    const res = {
      writeHead: (s: number, h?: Record<string, string>) => {
        status = s;
        outHeaders = h ?? {};
      },
      write: (c: string) => void chunks.push(c),
      end: (c?: string) => {
        if (c) chunks.push(c);
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[1],
      get status() {
        return status;
      },
      get headers() {
        return outHeaders;
      },
      body: () => chunks.join(""),
    };
  }

  it("parseRunRoute matches the friction route", () => {
    expect(parseRunRoute("/runs/abc123/friction")).toEqual({ id: "abc123", kind: "friction" });
    expect(parseRunRoute("/runs/abc123/friction/")).toEqual({ id: "abc123", kind: "friction" });
    expect(parseRunRoute("/runs/abc/friction/extra")).toBeNull();
  });

  it("404s for a wrong or missing token, revealing nothing", async () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    reg.publish(id, call("$ npm install"));
    const handler = liveOnlyHandler(reg);
    for (const url of [`/runs/${id}/friction?t=nope`, `/runs/${id}/friction`, `/runs/unknown/friction?t=x`]) {
      const t = fakeReqRes("GET", url);
      expect(handler(t.req, t.res)).toBe(true);
      await vi.waitFor(() => expect(t.status).toBe(404));
      expect(t.body()).not.toContain("npm install");
    }
  });

  it("returns the JSON diagnosis of a finished run's backlog (no-store, GET only)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, { type: "tool_call", tool: "bash", summary: "$ npm install", at: 1_000 });
    reg.publish(id, { type: "tool_result", tool: "bash", ok: true, summary: "added 200 packages", at: 61_000 });
    reg.publish(id, { type: "tool_call", tool: "bash", summary: "$ npm test", at: 62_000 });
    reg.publish(id, { type: "tool_result", tool: "bash", ok: false, summary: "2 failing", at: 63_000 });
    reg.finish(id);
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}/friction?t=${token}`);
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("application/json");
    expect(t.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(t.body());
    expect(body).toMatchObject({ id, finished: true });
    expect(body.diagnosis.eventCount).toBe(4);
    expect(body.diagnosis.byCategory.setup_install).toEqual({ count: 1, durationMs: 60_000 });
    expect(body.diagnosis.byCategory.failed_tool.count).toBe(1);
    expect(body.diagnosis.verdict).toMatch(/setup\/install/);

    const post = fakeReqRes("POST", `/runs/${id}/friction?t=${token}`);
    handler(post.req, post.res);
    expect(post.status).toBe(405);
  });

  it("works mid-run too (finished:false) — a diagnosis so far, never an error", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("$ ls"));
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}/friction?t=${token}`);
    handler(t.req, t.res);
    expect(t.status).toBe(200);
    const body = JSON.parse(t.body());
    expect(body.finished).toBe(false);
    // The in-flight call has no result yet; mid-run that is not a failure.
    expect(body.diagnosis.findings).toEqual([]);
  });
});

// Feature: features/live-view.md item 10 — run control from /runs (#101):
// `POST /runs/:id/stop?t=…&mode=soft|hard` behind the same token gate (Access
// fronts every /runs* method at the edge), plus Stop/Kill controls on the index
// rows and the per-run page, and stopping → stopped state on both.
describe("run control: POST /runs/:id/stop (#101)", () => {
  function fakeReqRes(method: string, url: string) {
    const listeners: Record<string, Array<() => void>> = {};
    const req = { method, url, headers: {}, on: (ev: string, cb: () => void) => void (listeners[ev] ??= []).push(cb) };
    let status = 0;
    let outHeaders: Record<string, string> = {};
    const chunks: string[] = [];
    const res = {
      writeHead: (s: number, h?: Record<string, string>) => {
        status = s;
        outHeaders = h ?? {};
      },
      write: (c: string) => void chunks.push(c),
      end: (c?: string) => {
        if (c) chunks.push(c);
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[1],
      get status() {
        return status;
      },
      get headers() {
        return outHeaders;
      },
      body: () => chunks.join(""),
    };
  }

  it("parseRunRoute matches the stop route", () => {
    expect(parseRunRoute("/runs/abc/stop")).toEqual({ id: "abc", kind: "stop" });
    expect(parseRunRoute("/runs/abc/stop/")).toEqual({ id: "abc", kind: "stop" });
  });

  it("soft: drives the run's control, answers JSON {stopping, mode}", () => {
    const reg = fixedRegistry();
    const { id, token, control } = reg.create();
    const t = fakeReqRes("POST", `/runs/${id}/stop?t=${token}&mode=soft`);
    expect(liveOnlyHandler(reg)(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("application/json");
    expect(t.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(t.body())).toEqual({ id, mode: "soft", state: "stopping" });
    expect(control.requested).toBe("soft");
    expect(control.hardSignal.aborted).toBe(false);
  });

  it("hard: aborts the run's hard signal immediately", () => {
    const reg = fixedRegistry();
    const { id, token, control } = reg.create();
    const t = fakeReqRes("POST", `/runs/${id}/stop?t=${token}&mode=hard`);
    liveOnlyHandler(reg)(t.req, t.res);
    expect(t.status).toBe(200);
    expect(JSON.parse(t.body()).mode).toBe("hard");
    expect(control.hardSignal.aborted).toBe(true);
  });

  it("400s a missing or unknown mode without touching the run", () => {
    const reg = fixedRegistry();
    const { id, token, control } = reg.create();
    const handler = liveOnlyHandler(reg);
    for (const q of ["", "&mode=", "&mode=nuke"]) {
      const t = fakeReqRes("POST", `/runs/${id}/stop?t=${token}${q}`);
      handler(t.req, t.res);
      expect(t.status).toBe(400);
    }
    expect(control.requested).toBeUndefined();
  });

  it("404s a wrong/missing token or unknown run (existence never revealed), control untouched", async () => {
    const reg = fixedRegistry();
    const { id, control } = reg.create();
    const handler = liveOnlyHandler(reg);
    for (const url of [`/runs/${id}/stop?t=wrong&mode=hard`, `/runs/${id}/stop?mode=hard`, `/runs/nope/stop?t=tok-1&mode=hard`]) {
      const t = fakeReqRes("POST", url);
      handler(t.req, t.res);
      await vi.waitFor(() => expect(t.status).toBe(404));
    }
    expect(control.requested).toBeUndefined();
    expect(control.hardSignal.aborted).toBe(false);
  });

  it("409s a stop on a finished run", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.finish(id);
    const t = fakeReqRes("POST", `/runs/${id}/stop?t=${token}&mode=soft`);
    liveOnlyHandler(reg)(t.req, t.res);
    expect(t.status).toBe(409);
  });

  it("is POST-only: GET on the stop route is 405 with allow: POST, and never stops the run", () => {
    const reg = fixedRegistry();
    const { id, token, control } = reg.create();
    const t = fakeReqRes("GET", `/runs/${id}/stop?t=${token}&mode=hard`);
    liveOnlyHandler(reg)(t.req, t.res);
    expect(t.status).toBe(405);
    expect(t.headers.allow).toBe("POST");
    expect(control.requested).toBeUndefined();
  });

  it("the other run routes stay GET-only (405 on POST) — the stop route is the ONLY writer", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const t = fakeReqRes("POST", `/runs/${id}/events?t=${token}`);
    liveOnlyHandler(reg)(t.req, t.res);
    expect(t.status).toBe(405);
    expect(t.headers.allow).toBe("GET");
  });

  const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
    id: "run-1",
    token: "tok-1",
    label: "coding · owner/repo",
    finished: false,
    startedAt: 1000,
    eventCount: 3,
    ...over,
  });

  describe("index UI", () => {
    it("renders Stop (soft) and Kill (hard) buttons OUTSIDE the row anchor for a live run", () => {
      const html = renderRunsIndex([summary()]);
      // buttons are siblings of the <a class="row">, never nested inside it (invalid HTML)
      expect(html).toMatch(/<\/a><span class="actions">.*data-mode="soft".*data-mode="hard".*<\/span><\/li>/);
      expect(html).not.toMatch(/<a class="row"[^>]*>[^]*?<button[^]*?<\/a>/);
    });

    it("hides the buttons for a finished run", () => {
      const html = renderRunsIndex([summary({ finished: true })]);
      expect(html).not.toContain('data-mode="soft"');
      expect(html).not.toContain('data-mode="hard"');
    });

    it("shows a stopping / stopped badge from the summary's stop state", () => {
      expect(renderRunsIndex([summary({ stop: { mode: "soft", state: "stopping" } })])).toContain(
        '<span class="stopbadge stopping">stopping (soft)</span>',
      );
      expect(renderRunsIndex([summary({ finished: true, stop: { mode: "hard", state: "stopped" } })])).toContain(
        '<span class="stopbadge stopped">stopped (hard)</span>',
      );
      expect(renderRunsIndex([summary()])).not.toContain('class="stopbadge');
      // a run already asked to stop offers no second set of buttons
      expect(renderRunsIndex([summary({ stop: { mode: "soft", state: "stopping" } })])).not.toContain('data-mode="hard"');
    });

    it("client-side rows mirror the buttons + badge and POST the stop with the row's token", () => {
      const html = renderRunsIndex([summary()]);
      expect(html).toContain('method: "POST"');
      expect(html).toContain('"/stop?t="');
      expect(html).toContain('stop.state + " (" + stop.mode + ")"'); // same label as the server badge
      expect(html).toContain('stopButton("hard"');
      expect(html).not.toContain("innerHTML");
    });
  });

  describe("per-run page UI", () => {
    it("has Stop and Kill buttons that POST to this run's token-scoped stop route", () => {
      const html = renderRunPage("run-1", "tok-1");
      expect(html).toContain('data-mode="soft"');
      expect(html).toContain('data-mode="hard"');
      expect(html).toContain("/runs/run-1/stop?t=tok-1");
      expect(html).toContain('method: "POST"');
    });

    it("reflects stop_requested → stopping and end → stopped from the event stream (textContent only)", () => {
      const html = renderRunPage("run-1", "tok-1");
      expect(html).toContain('"stop_requested"');
      expect(html).toContain("stopping (");
      expect(html).toContain("stopped (");
      expect(html).not.toContain("innerHTML");
    });
  });
});

describe("run page model-turn rows (item 15)", () => {
  it("renders a `turn` change as a muted 💭 row with its facts, built with createElement/textContent only", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toContain('change.kind === "turn"');
    expect(html).toContain('el("li", "turn")');
    expect(html).toContain("#log > li.turn {"); // #log > li { padding: 0 } outranks a bare li.turn rule
    expect(html).not.toContain("innerHTML");
  });
});

// Feature: features/run-visibility.md / live-view.md item 12 — the exchange on
// the run page (#157 U1): `context` events (the thread turns the model was given)
// render like the request — markdown through the same guarded renderer — inside
// a collapsed Context block between the Request block and the log. A page seeded
// with history (`renderRunPage(id, token, events)`) feeds the seed through the
// SAME `handle(e)` the EventSource frames use, so seeded and live pages render
// identically by construction; the seed is a `\u003c`-escaped JSON island, so
// event text can never open or close a tag inside the inline script.
describe("context events + seeded history on the run page (#157 U1)", () => {
  const text = (type: "input" | "context" | "answer", text: string, seq: number): RunEvent => ({ type, text, seq });
  const SCRIPT_PAYLOAD = "</script><script>alert(1)</script>";
  const ATTR_PAYLOAD = '"><img src=x onerror=alert(1)>';

  it("renders `context` events into a collapsed Context block between the Request block and the log, via the markdown guard", () => {
    const html = renderRunPage("run-1", "tok-1");
    // The fold (runTimeline) turns a `context` event into a `context` change; the page renders it into the block.
    expect(createRunTimeline().push({ type: "context", text: "earlier turn", at: 5 })).toEqual([{ kind: "context", text: "earlier turn", at: 5 }]);
    expect(html).toContain('change.kind === "context"');
    expect(html).toContain("contextTurn(change)");
    expect(html).toContain('<details class="block" id="context" hidden>');
    expect(html.indexOf('id="request"')).toBeLessThan(html.indexOf('id="context"'));
    expect(html.indexOf('id="context"')).toBeLessThan(html.indexOf('<ol id="log"'));
    // a context turn is [ts] + a markdown box rendered through the same guard as the request
    expect(html).toMatch(/function contextTurn\(change\) \{[\s\S]*?turn\.appendChild\(stamp\(change\.at\)\);[\s\S]*?md\(box, change\.text\);[\s\S]*?contextTurns\.appendChild\(turn\)/);
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("insertAdjacentHTML");
  });

  it("seeded events ride as an escaped JSON island and go through the one `handle` the live stream uses (mirror by construction)", () => {
    const events: RunEvent[] = [text("input", "please run it", 1), text("context", "earlier turn", 2), { type: "turn", startedAt: 0, durationMs: 900, stopReason: "tool_use", seq: 3, at: 900 }, call("$ npm test"), text("answer", "all green", 5)];
    const html = renderRunPage("run-1", "tok-1", events);
    expect(html).toContain(`var seed = ${seedEventsJson(events)};`);
    expect(html).toContain("for (var i = 0; i < seed.length; i++) handle(seed[i]);");
    // The live frame is parsed, deduped on its SSE id (run events only), then goes through the same `handle`.
    expect(html).toMatch(/es\.onmessage = function \(m\) \{\s*var e;\s*try \{ e = JSON\.parse\(m\.data\); \} catch \(_\) \{ return; \}[\s\S]*?\n\s*handle\(e\);\s*\};/);
    // ONE fold: handle() is the only caller of timeline.push, and both the seed loop and onmessage go through it.
    expect(html).toMatch(/function handle\(e\) \{\s*var wasAtTail = atTail\(\);\s*var changes = timeline\.push\(e\);/);
    expect(html.match(/timeline\.push\(/g)).toHaveLength(1);
    // The seed is the events verbatim once the JSON escapes are undone.
    expect(JSON.parse(seedEventsJson(events))).toEqual(events);
  });

  it("a hostile seeded text is inert: `<`, `>` and `&` are \\u-escaped in the JSON island, so no tag opens or closes inside the script", () => {
    const html = renderRunPage("run-1", "tok-1", [text("input", SCRIPT_PAYLOAD, 1), text("answer", ATTR_PAYLOAD, 2)]);
    expect(html).not.toContain(SCRIPT_PAYLOAD);
    expect(html).not.toContain(ATTR_PAYLOAD);
    expect(html).toContain("\\u003c/script\\u003e");
    // Exactly one <script> open and one close on the page — the payload added none.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(seedEventsJson([text("input", "a\u2028b & <c>", 1)])).toBe('[{"type":"input","text":"a\\u2028b \\u0026 \\u003cc\\u003e","seq":1}]');
  });

  it("with no seeded events the seed is empty and the page keeps its waiting placeholder (unchanged live path)", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toContain("var seed = [];");
    expect(html).toContain('id="placeholder"');
  });
});

// Feature: features/live-view.md — bounded live replay (#157 U11): a late
// subscriber to a long run gets a leading note plus the newest 1000 frames; the
// registry snapshot still holds the whole backlog; the index feed is unchanged.
describe("serveEvents — live replay budget (#157 U11)", () => {
  it("a late subscriber to a 3000-event run gets a 'replaying last 1000 of 3000' note then the newest 1000 frames; snapshot has all 3000", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 3000; i++) reg.publish(id, call(`$ step ${i}`));
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    const frames = rec.writes.filter((w) => w.startsWith("data: ") || w.startsWith("id: ")).map((w) => JSON.parse(w.slice(w.indexOf("data: ") + 6)));
    expect(frames).toHaveLength(1001);
    expect(frames[0]).toEqual({ type: "replay_note", summary: "replaying last 1000 of 3000 events" });
    expect(frames[1]).toMatchObject({ summary: "$ step 2001", seq: 2001 });
    expect(frames[1000]).toMatchObject({ summary: "$ step 3000", seq: 3000 });
    expect(reg.snapshot(id, token)?.events).toHaveLength(3000);
    // Live frames after the replay still flow, uncapped.
    reg.publish(id, call("$ step 3001"));
    expect(rec.body()).toContain('"summary":"$ step 3001"');
  });

  it("a run with 1000 or fewer events replays everything with no note (byte-identical to before)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 1000; i++) reg.publish(id, call(`$ step ${i}`));
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    const frames = rec.writes.filter((w) => w.startsWith("id: "));
    expect(frames).toHaveLength(1000);
    expect(rec.body()).not.toContain("replay_note");
  });

  it("an already-finished long run: note, newest 1000, then the end frame", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 1500; i++) reg.publish(id, call(`$ step ${i}`));
    reg.finish(id);
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish), rec.sink);
    const data = rec.writes.filter((w) => w.startsWith("data: ") || w.startsWith("id: "));
    expect(data).toHaveLength(1001);
    expect(data[0]).toContain("replaying last 1000 of 1500 events");
    expect(rec.writes[rec.writes.length - 1]).toBe("event: end\ndata: {}\n\n");
    expect(rec.ended).toBe(true);
  });

  it("a resume cursor and the replay cap compose: the ring holds the newest 1000 AFTER the cursor and the note counts only those", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 3000; i++) reg.publish(id, call(`$ step ${i}`));
    // Reconnect having applied seq 500: 2500 remain, so 1500 are omitted.
    const rec = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish, parseLastEventId("500")), rec.sink);
    const frames = rec.writes.filter((w) => w.startsWith("data: ") || w.startsWith("id: "));
    expect(frames).toHaveLength(1001);
    expect(frames[0]).toBe(`data: ${JSON.stringify({ type: "replay_note", summary: "replaying last 1000 of 2500 events" })}\n\n`);
    expect(frames[1]).toMatch(/^id: 2001\n/);
    expect(frames[1000]).toMatch(/^id: 3000\n/);
    // A cursor inside the cap window: no note, exactly the events after it.
    const rec2 = recordingSink();
    serveEvents((onEvent, onFinish) => reg.subscribe(id, token, onEvent, onFinish, parseLastEventId("2500")), rec2.sink);
    const frames2 = rec2.writes.filter((w) => w.startsWith("data: ") || w.startsWith("id: "));
    expect(frames2).toHaveLength(500);
    expect(rec2.body()).not.toContain("replay_note");
    expect(frames2[0]).toMatch(/^id: 2501\n/);
  });

  it("the client exempts a replay_note from the Last-Event-ID dedupe (it carries no id of its own)", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toContain('if (e.type !== "replay_note") {');
    expect(html).toContain("if (sid > 0) { if (sid <= lastSeq) return; lastSeq = sid; }");
  });

  it("the client renders a replay_note frame as a note row (textContent)", () => {
    const html = renderRunPage("run-1", "tok-1");
    // The fold knows the transport frame; the page renders it through addNote with the … glyph, never markup.
    expect(createRunTimeline().push({ type: "replay_note", summary: "replaying last 1000 of 1200 events" })).toEqual([
      { kind: "replay_note", text: "replaying last 1000 of 1200 events" },
    ]);
    expect(html).toContain('change.kind === "note" || change.kind === "replay_note"');
    expect(html).toContain('(change.kind === "replay_note" ? "\\u2026 " : "\\u23f1 ") + change.text');
  });
});

// Feature: features/live-view.md / run-history.md — the live view on
// `RunsService` (#157 U8): finished/persisted runs render tokenless in history
// mode through the one `renderRunPage`; the index shows active runs by default
// (never touching the store) and everything with `?all=1`; live rows keep their
// capability hrefs, finished rows never carry a token.
describe("live view on RunsService: history pages + index toggle (#157 U8)", () => {
  const NOW = 1_700_000_000_000;
  const text = (type: "input" | "context" | "assistant" | "answer", t: string, seq: number): RunEvent => ({ type, text: t, seq }) as RunEvent;

  function record(id: string, over: Partial<RunRecord> = {}): RunRecord {
    const events: RunEvent[] = over.events ?? [
      text("input", "please run it", 1),
      text("context", "earlier turn", 2),
      { ...call("$ npm test"), seq: 3 },
      { ...result(true, "all green"), seq: 4 },
      text("answer", "done", 5),
    ];
    return {
      id,
      label: `coding · acme/${id}`,
      agent: "coding",
      model: "anthropic/claude",
      channelId: "slack:C1",
      userId: "slack:U1",
      threadKey: `slack:C1:${id}`,
      startedAt: NOW - 70_000,
      finishedAt: NOW - 60_000,
      status: "completed",
      eventCount: events.length,
      storedEventCount: events.length,
      truncated: false,
      events,
      diagnosis: analyzeRunFriction(events),
      ...over,
    };
  }

  function fakeReqRes(method: string, url: string, remoteAddress = "203.0.113.9") {
    const listeners: Record<string, Array<() => void>> = {};
    const req = { method, url, headers: {}, socket: { remoteAddress }, on: (ev: string, cb: () => void) => void (listeners[ev] ??= []).push(cb) };
    let status = 0;
    let outHeaders: Record<string, string> = {};
    const chunks: string[] = [];
    let ended = false;
    const res = {
      writeHead: (s: number, h?: Record<string, string>) => {
        status = s;
        outHeaders = h ?? {};
      },
      write: (c: string) => void chunks.push(c),
      end: (c?: string) => {
        if (c) chunks.push(c);
        ended = true;
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createLiveViewHandler>>[1],
      get status() {
        return status;
      },
      get headers() {
        return outHeaders;
      },
      body: () => chunks.join(""),
      get ended() {
        return ended;
      },
    };
  }

  /** Registry + store + service + handler, with every knob injectable. */
  function harness(
    opts: {
      store?: InMemoryRunStore | null;
      retention?: { retentionDays: number } | null;
      devBypass?: LiveViewDeps["devBypass"];
      audit?: LiveViewDeps["audit"];
      indexPageSize?: number;
    } = {},
  ) {
    let clock = NOW;
    const now = () => clock;
    let n = 0;
    const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}`, now });
    const store = opts.store === undefined ? new InMemoryRunStore({ now }) : opts.store;
    const service = createRunsService({ registry, store });
    const handler = createLiveViewHandler({
      service,
      index: registry,
      retention: opts.retention === undefined ? { retentionDays: 30 } : opts.retention,
      ...(opts.devBypass ? { devBypass: opts.devBypass } : {}),
      ...(opts.audit ? { audit: opts.audit } : {}),
      ...(opts.indexPageSize !== undefined ? { indexPageSize: opts.indexPageSize } : {}),
    });
    return { registry, store, service, handler, tick: (ms: number) => (clock += ms) };
  }

  const done = (t: { ended: boolean }) => vi.waitFor(() => expect(t.ended).toBe(true));

  describe("persisted run page (history mode)", () => {
    it("200s tokenless with request/context/reply/tool rows seeded, no EventSource, stop controls hidden, a grey finished header", async () => {
      const h = harness();
      await h.store!.put(record("r1"));
      const t = fakeReqRes("GET", "/runs/r1");
      expect(h.handler(t.req, t.res)).toBe(true);
      await done(t);
      expect(t.status).toBe(200);
      expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      const html = t.body();
      expect(html).toContain(`var seed = ${seedEventsJson(record("r1").events)};`);
      expect(html).toContain("var live = false;");
      expect(html).toMatch(/if \(live\) \{\s*var es = new EventSource\(url\);/); // the stream only opens on a live page
      expect(html).toContain('<span class="actions" id="actions" hidden>');
      expect(html).toContain('<span class="dot grey" id="statedot"></span><span id="state">finished · completed</span>');
      expect(html).not.toContain("?t=");
      expect(html).not.toContain("tok-");
    });

    it("a live page still opens the EventSource and shows the stop controls (unchanged live path)", () => {
      const html = renderRunPage("run-1", "tok-1");
      expect(html).toContain("var live = true;");
      expect(html).toContain('var url = "/runs/run-1/events?t=tok-1";');
      expect(html).toContain('<span class="actions" id="actions">');
      expect(html).toContain('<span class="dot amber" id="statedot"></span><span id="state">connecting…</span>');
    });

    it("labels a stopped or failed run's header from its status", async () => {
      const h = harness();
      await h.store!.put(record("r1", { status: "stopped_soft" }));
      await h.store!.put(record("r2", { status: "failed" }));
      const a = fakeReqRes("GET", "/runs/r1");
      h.handler(a.req, a.res);
      await done(a);
      expect(a.body()).toContain(">finished · stopped (soft)</span>");
      const b = fakeReqRes("GET", "/runs/r2");
      h.handler(b.req, b.res);
      await done(b);
      expect(b.body()).toContain(">finished · failed</span>");
    });

    it("a finished run still in the registry is served tokenless in history mode (the card link outlives the TTL either way)", async () => {
      const h = harness();
      const run = h.registry.create();
      h.registry.publish(run.id, text("input", "hi", 0));
      h.registry.finish(run.id);
      const t = fakeReqRes("GET", `/runs/${run.id}`);
      h.handler(t.req, t.res);
      await done(t);
      expect(t.status).toBe(200);
      expect(t.body()).toContain("var live = false;");
      expect(t.body()).toContain('"text":"hi"');
      expect(t.body()).not.toContain(run.token);
    });

    it("AE9: a persisted `</script><script>alert(1)</script>` message is inert on the page", async () => {
      const h = harness();
      const payload = "</script><script>alert(1)</script>";
      await h.store!.put(record("r1", { events: [text("input", payload, 1)], eventCount: 1, storedEventCount: 1 }));
      const t = fakeReqRes("GET", "/runs/r1");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.body()).not.toContain(payload);
      expect(t.body()).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
      expect(t.body().match(/<\/script>/g)).toHaveLength(1);
    });

    it("emits one audit line per history page/events read with the route, run id and identity — never content", async () => {
      const audit = vi.fn();
      const h = harness({ audit });
      await h.store!.put(record("r1"));
      const page = fakeReqRes("GET", "/runs/r1");
      h.handler(page.req, page.res, { identity: "access:alice" });
      await done(page);
      const events = fakeReqRes("GET", "/runs/r1/events");
      h.handler(events.req, events.res);
      await done(events);
      expect(audit.mock.calls).toEqual([[{ route: "page", runId: "r1", identity: "access:alice" }], [{ route: "events", runId: "r1" }]]);
      for (const [entry] of audit.mock.calls) expect(JSON.stringify(entry)).not.toContain("please run it");
    });
  });

  describe("AE11: truncated records", () => {
    it("withOmittedMarkers marks every seq gap with its own count; the unaccounted remainder is a tail marker", () => {
      const events: RunEvent[] = [text("input", "a", 1), { ...call("b"), seq: 4 }, { ...call("c"), seq: 5 }, { ...call("d"), seq: 9 }];
      // 12 published, 4 stored → 8 omitted: 2 (seq 2–3) + 3 (seq 6–8) + 3 cut from the tail
      expect(withOmittedMarkers(events, 12)).toEqual([
        events[0],
        { type: "replay_note", summary: "2 events omitted" },
        events[1],
        events[2],
        { type: "replay_note", summary: "3 events omitted" },
        events[3],
        { type: "replay_note", summary: "3 events omitted" },
      ]);
      // counts never exceed published − stored, even when seq numbering is odd
      const odd: RunEvent[] = [{ ...call("x"), seq: 1 }, { ...call("y"), seq: 50 }];
      expect(withOmittedMarkers(odd, 3)).toEqual([odd[0], { type: "replay_note", summary: "1 event omitted" }, odd[1]]);
    });

    it("withOmittedMarkers puts one 'N events omitted' note at a single seq gap, N = eventCount − stored", () => {
      const events: RunEvent[] = [text("input", "a", 1), { ...call("b"), seq: 2 }, { ...call("c"), seq: 8 }, text("answer", "d", 9)];
      expect(withOmittedMarkers(events, 9)).toEqual([events[0], events[1], { type: "replay_note", summary: "5 events omitted" }, events[2], events[3]]);
    });

    it("a gap at the start puts the marker first; a record with nothing missing gets no marker; a gap only at the tail puts it last", () => {
      const tail: RunEvent[] = [{ ...call("x"), seq: 4 }, { ...call("y"), seq: 5 }];
      expect(withOmittedMarkers(tail, 5)[0]).toEqual({ type: "replay_note", summary: "3 events omitted" });
      const full: RunEvent[] = [{ ...call("x"), seq: 1 }, { ...call("y"), seq: 2 }];
      expect(withOmittedMarkers(full, 2)).toEqual(full);
      expect(withOmittedMarkers(full, 3).at(-1)).toEqual({ type: "replay_note", summary: "1 event omitted" });
    });

    it("the persisted page seeds the marker in place and the events replay carries it too", async () => {
      const h = harness();
      const events: RunEvent[] = [text("input", "a", 1), { ...call("b"), seq: 2 }, { ...call("c"), seq: 8 }, text("answer", "d", 9)];
      await h.store!.put(record("r1", { events, eventCount: 9, storedEventCount: 4, truncated: true }));
      const page = fakeReqRes("GET", "/runs/r1");
      h.handler(page.req, page.res);
      await done(page);
      expect(page.body()).toContain(`var seed = ${seedEventsJson(withOmittedMarkers(events, 9))};`);
      expect(page.body()).toContain('"summary":"5 events omitted"');
      const stream = fakeReqRes("GET", "/runs/r1/events");
      h.handler(stream.req, stream.res);
      await done(stream);
      expect(stream.body()).toContain('data: {"type":"replay_note","summary":"5 events omitted"}\n\n');
    });
  });

  describe("persisted run events, friction and stop", () => {
    it("`/runs/:id/events` tokenless replays the stored stream in seq order from ONE record read (no per-page re-reads) then ends", async () => {
      const h = harness();
      const events: RunEvent[] = Array.from({ length: 1200 }, (_, i) => ({ ...call(`step ${i + 1}`), seq: i + 1 }));
      await h.store!.put(record("r1", { events, eventCount: 1200, storedEventCount: 1200 }));
      const get = vi.spyOn(h.store!, "get");
      const pages = vi.spyOn(h.store!, "events");
      const t = fakeReqRes("GET", "/runs/r1/events");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.status).toBe(200);
      expect(t.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      const body = t.body();
      expect(body.startsWith(PRELUDE)).toBe(true);
      expect(body.endsWith("event: end\ndata: {}\n\n")).toBe(true);
      const seqs = [...body.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1]));
      expect(seqs).toEqual(events.map((e) => e.seq));
      // `getRun({ include: "messages" })` already holds every event: one record read, zero event pages.
      expect(get).toHaveBeenCalledTimes(1);
      expect(pages).not.toHaveBeenCalled();
    });

    it("`/runs/:id/friction` tokenless returns the stored diagnosis", async () => {
      const h = harness();
      const rec = record("r1");
      await h.store!.put(rec);
      const t = fakeReqRes("GET", "/runs/r1/friction");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.status).toBe(200);
      expect(JSON.parse(t.body())).toEqual({ id: "r1", finished: true, diagnosis: rec.diagnosis });
    });

    it("`POST /runs/:id/stop` tokenless → 409 for a persisted run, 404 for a live unfinished run (control untouched)", async () => {
      const h = harness();
      await h.store!.put(record("r1"));
      const persisted = fakeReqRes("POST", "/runs/r1/stop?mode=soft");
      h.handler(persisted.req, persisted.res);
      await done(persisted);
      expect(persisted.status).toBe(409);
      const run = h.registry.create();
      const live = fakeReqRes("POST", `/runs/${run.id}/stop?mode=hard`);
      h.handler(live.req, live.res);
      await done(live);
      expect(live.status).toBe(404);
      expect(live.body()).toBe("run not found");
      expect(run.control.requested).toBeUndefined();
    });

    it("a valid token still stops a live run (200) and 409s a finished one — the token path is unchanged", () => {
      const h = harness();
      const run = h.registry.create();
      const ok = fakeReqRes("POST", `/runs/${run.id}/stop?t=${run.token}&mode=soft`);
      h.handler(ok.req, ok.res);
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body())).toEqual({ id: run.id, mode: "soft", state: "stopping" });
      h.registry.finish(run.id);
      const fin = fakeReqRes("POST", `/runs/${run.id}/stop?t=${run.token}&mode=soft`);
      h.handler(fin.req, fin.res);
      expect(fin.status).toBe(409);
    });
  });

  describe("404 shapes (R4/R10)", () => {
    it("unknown, expired, and wrong-token-on-live give the identical 404 body; a live run without a token is 404 on page, events and friction", async () => {
      const h = harness();
      await h.store!.put(record("old", { finishedAt: NOW - 31 * 86_400_000 }));
      const live = h.registry.create();
      const urls = [
        "/runs/nope",
        "/runs/old",
        `/runs/${live.id}?t=wrong`,
        `/runs/${live.id}`,
        `/runs/${live.id}/events`,
        `/runs/${live.id}/friction`,
        "/runs/nope/events",
        "/runs/nope/friction",
      ];
      for (const url of urls) {
        const t = fakeReqRes("GET", url);
        h.handler(t.req, t.res);
        await done(t);
        expect([url, t.status, t.body()]).toEqual([url, 404, "run not found"]);
      }
    });

    it("with run history off (store null) a finished, evicted run is the same 404", async () => {
      const h = harness({ store: null });
      const run = h.registry.create();
      h.registry.finish(run.id);
      h.tick(120_000);
      const t = fakeReqRes("GET", `/runs/${run.id}`);
      h.handler(t.req, t.res);
      await done(t);
      expect([t.status, t.body()]).toEqual([404, "run not found"]);
    });
  });

  describe("index: active by default, everything with ?all=1", () => {
    it("the default view lists only unfinished runs and never calls the store", async () => {
      const h = harness();
      await h.store!.put(record("p1"));
      const active = h.registry.create("active one");
      const fin = h.registry.create("finished one");
      h.registry.finish(fin.id);
      const list = vi.spyOn(h.store!, "list");
      const get = vi.spyOn(h.store!, "get");
      const t = fakeReqRes("GET", "/runs");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.status).toBe(200);
      expect(t.body()).toContain(`href="/runs/${active.id}?t=${active.token}"`);
      expect(t.body()).not.toContain("finished one");
      expect(t.body()).not.toContain("p1");
      expect(list).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(t.body()).toContain('href="/runs?all=1"');
      expect(t.body()).toContain('title="Finished runs are kept for 30 days, then deleted"');
      expect(t.body()).toContain('new EventSource("/runs?stream=1")');
      expect(t.body()).toContain("var showAll = false;");
    });

    it("?all=1 lists live rows with token hrefs and finished/persisted rows tokenless, with status, duration and finished-at", async () => {
      const h = harness();
      await h.store!.put(record("p1"));
      await h.store!.put(record("p2", { status: "failed", finishedAt: NOW - 30_000, startedAt: NOW - 30_000 - 3_725_000 }));
      const active = h.registry.create("active one");
      const fin = h.registry.create("finished one");
      h.registry.finish(fin.id);
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      const html = t.body();
      expect(html).toContain(`href="/runs/${active.id}?t=${active.token}"`);
      expect(html).toContain(`href="/runs/${fin.id}"`);
      expect(html).not.toContain(fin.token);
      expect(html).toContain('href="/runs/p1"');
      expect(html).toContain('href="/runs/p2"');
      // finished rows: status word + duration + finished-at (UTC), no token anywhere
      expect(html).toContain('<span class="dot grey" role="img" aria-label="completed" title="completed"></span>');
      expect(html).toContain('<span class="meta status">completed · 10s · finished 2023-11-14 22:12 UTC</span>');
      expect(html).toContain('<span class="dot red" role="img" aria-label="failed" title="failed"></span>');
      expect(html).toContain("failed · 1h 02m · finished 2023-11-14 22:12 UTC");
      const finishedRows = html.match(/<li data-run-id="(?!run-1")[^]*?<\/li>/g) ?? [];
      expect(finishedRows.length).toBe(3);
      for (const row of finishedRows) expect(row).not.toMatch(/tok-|\?t=/);
      expect(html).toContain('href="/runs"');
      expect(html).toContain("var showAll = true;");
      expect(html).toContain('new EventSource("/runs?stream=1&all=1")');
    });

    it("the toggle tooltip is truthful with run history off", async () => {
      const h = harness({ store: null, retention: null });
      const t = fakeReqRes("GET", "/runs");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.body()).toContain('title="Run history is off; finished runs are kept about a minute."');
      expect(retentionSentence({ retentionDays: 7 })).toBe("Finished runs are kept for 7 days, then deleted");
      expect(retentionSentence({ retentionDays: 1 })).toBe("Finished runs are kept for 1 day, then deleted");
    });

    it("AE9: a hostile persisted label is escaped in the index row", async () => {
      const h = harness();
      await h.store!.put(record("p1", { label: '<script>alert(1)</script>" onmouseover="x' }));
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.body()).not.toContain("<script>alert(1)</script>");
      expect(t.body()).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot; onmouseover=&quot;x");
    });

    it("a persisted row's `data-persisted` attribute is mirrored; the store spy sees exactly one list call for ?all=1", async () => {
      const h = harness();
      const run = h.registry.create("both");
      h.registry.finish(run.id);
      await h.store!.put(record(run.id));
      h.registry.markPersisted(run.id);
      const list = vi.spyOn(h.store!, "list");
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      expect(list).toHaveBeenCalledTimes(1);
      expect(t.body()).toContain(`<li data-run-id="${run.id}" data-started-at="${NOW}" data-persisted="1" data-finished-at="${NOW - 60_000}" data-status="completed">`);
      expect(t.body()).toContain('li.setAttribute("data-persisted", "1")');
    });

    it("?all=1 renders a visible banner when the history store is unavailable (live rows still listed); the default view never shows it", async () => {
      const broken = new InMemoryRunStore({ now: () => NOW });
      broken.list = async () => {
        throw new Error("store down");
      };
      const h = harness({ store: broken });
      const live = h.registry.create("still live");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const all = fakeReqRes("GET", "/runs?all=1");
      h.handler(all.req, all.res);
      await done(all);
      expect(all.status).toBe(200);
      expect(all.body()).toContain('<p class="banner" role="status">⚠ history store unavailable — showing live runs only</p>');
      expect(all.body()).toContain(`data-run-id="${live.id}"`);
      expect(all.body()).not.toContain("store down");
      const dflt = fakeReqRes("GET", "/runs");
      h.handler(dflt.req, dflt.res);
      await done(dflt);
      expect(dflt.body()).not.toContain("history store unavailable");
      warn.mockRestore();
    });

    it("?all=1 asks the service for a full page (RUN_LIST_MAX_LIMIT), never the 50-row default", async () => {
      const h = harness();
      const list = vi.spyOn(h.service, "listRuns");
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      expect(list).toHaveBeenCalledWith({ status: "all", limit: RUN_LIST_MAX_LIMIT });
    });

    it("a full page renders an `Older runs →` link carrying the service's cursor; following it yields the next page", async () => {
      const h = harness({ indexPageSize: 2 });
      await h.store!.put(record("p1", { finishedAt: NOW - 10_000 }));
      await h.store!.put(record("p2", { finishedAt: NOW - 20_000 }));
      await h.store!.put(record("p3", { finishedAt: NOW - 30_000 }));
      const first = fakeReqRes("GET", "/runs?all=1");
      h.handler(first.req, first.res);
      await done(first);
      const html = first.body();
      expect(html).toContain('href="/runs/p1"');
      expect(html).toContain('href="/runs/p2"');
      expect(html).not.toContain('href="/runs/p3"');
      const older = `/runs?all=1&before=${NOW - 20_000}&beforeId=p2`;
      expect(html).toContain(`<a class="older" href="${escapeHtml(older)}">Older runs →</a>`);

      const second = fakeReqRes("GET", older);
      h.handler(second.req, second.res);
      await done(second);
      expect(second.status).toBe(200);
      expect(second.body()).toContain('href="/runs/p3"');
      expect(second.body()).not.toContain('href="/runs/p2"');
      expect(second.body()).not.toContain("Older runs");
    });

    it("a short page has no older link; a malformed cursor is ignored (first page)", async () => {
      const h = harness({ indexPageSize: 2 });
      await h.store!.put(record("p1"));
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.body()).not.toContain("Older runs");
      const bad = fakeReqRes("GET", "/runs?all=1&before=abc&beforeId=p1");
      h.handler(bad.req, bad.res);
      await done(bad);
      expect(bad.status).toBe(200);
      expect(bad.body()).toContain('href="/runs/p1"');
    });
  });

  describe("index rows: one projection for the server and the client", () => {
    /** Evaluate the inlined row library exactly as the browser would. */
    function clientLib(doc: ReturnType<typeof staticDocument>) {
      return new Function("doc", `${INDEX_ROW_SCRIPT}; return indexRowRenderer(doc);`)(doc) as ReturnType<typeof indexRowRenderer>;
    }

    it("the server row equals the client `fill()` of the same row, for live, finished and persisted rows", () => {
      const rows: IndexRow[] = [
        { id: "l1", token: "tok-l1", label: "live", finished: false, startedAt: 1000, eventCount: 2 },
        { id: "s1", token: "tok-s1", label: "stopping", finished: false, startedAt: 1000, eventCount: 2, stop: { mode: "soft", state: "stopping" } },
        { id: "f1", token: "tok-f1", label: "finished in registry", finished: true, startedAt: 1000, eventCount: 2 },
        { id: "p1", label: "persisted", finished: true, persisted: true, startedAt: 1000, finishedAt: 61_000, status: "stopped_hard", eventCount: 9, stop: { mode: "hard", state: "stopped" } },
      ];
      const doc = staticDocument();
      const lib = clientLib(doc);
      for (const row of rows) {
        const li = doc.createElement("li");
        lib.fill(li, row);
        expect(doc.serialize(li)).toBe(indexRowHtml(row));
      }
    });

    it("finished rows never carry a token in their HTML, live rows do", () => {
      expect(indexRowHtml({ id: "f1", token: "tok-f1", finished: true, startedAt: 1, eventCount: 1 })).not.toContain("tok-f1");
      expect(indexRowHtml({ id: "f1", token: "tok-f1", finished: true, startedAt: 1, eventCount: 1 })).toContain('href="/runs/f1"');
      expect(indexRowHtml({ id: "l1", token: "tok-l1", finished: false, startedAt: 1, eventCount: 1 })).toContain('href="/runs/l1?t=tok-l1"');
    });

    it("feed semantics: default view drops a finished upsert; ?all=1 keeps it and suppresses `removed` only for a persisted row", () => {
      const lib = clientLib(staticDocument());
      const row = (finished: boolean): IndexRow => ({ id: "a", finished, startedAt: 1, eventCount: 0 });
      const fin = { type: "upsert", run: row(true) };
      expect(lib.feedAction(fin, false, false)).toEqual({ op: "remove", id: "a" });
      expect(lib.feedAction(fin, true, false)).toEqual({ op: "upsert", run: fin.run });
      expect(lib.feedAction({ type: "upsert", run: row(false) }, false, false)).toEqual({ op: "upsert", run: row(false) });
      expect(lib.feedAction({ type: "removed", id: "a" }, true, true)).toEqual({ op: "keep" });
      expect(lib.feedAction({ type: "removed", id: "a" }, true, false)).toEqual({ op: "remove", id: "a" });
      expect(lib.feedAction({ type: "removed", id: "a" }, false, true)).toEqual({ op: "remove", id: "a" });
    });

    it("a registry upsert of a finished, persisted row keeps its status/duration (merge, never a wipe) — server and client agree", () => {
      const doc = staticDocument();
      const lib = clientLib(doc);
      // The server rendered the store-merged row: finished with status + finishedAt.
      const merged: IndexRow = { id: "b1", label: "both", finished: true, persisted: true, startedAt: 1000, finishedAt: 61_000, status: "completed", eventCount: 9 };
      const li = doc.createElement("li");
      lib.fill(li, merged);
      expect(doc.serialize(li)).toContain("completed · 1m 00s");
      // The `?all=1` feed then replays the registry's RunSummary for the same run: no finishedAt/status,
      // but the current eventCount / label / persisted flag.
      const summary: IndexRow = { id: "b1", token: "tok-b1", label: "both", finished: true, persisted: true, startedAt: 1000, eventCount: 10 };
      lib.fill(li, lib.mergeRow(lib.persistedFields(li), summary));
      const repaint = doc.serialize(li);
      expect(repaint).toContain("completed · 1m 00s");
      expect(repaint).toContain('class="dot grey"');
      expect(repaint).toContain("10 events");
      expect(repaint).not.toContain("tok-b1");
      expect(repaint).toBe(indexRowHtml({ ...summary, finishedAt: 61_000, status: "completed" }));
      // A live row has nothing to keep: the summary is painted as-is.
      const live = doc.createElement("li");
      lib.fill(live, { id: "l1", token: "t", finished: false, startedAt: 1, eventCount: 1 });
      expect(lib.mergeRow(lib.persistedFields(live), { id: "l1", token: "t", finished: false, startedAt: 1, eventCount: 2 })).toEqual({ id: "l1", token: "t", finished: false, startedAt: 1, eventCount: 2 });
      // The page's upsert goes through the same merge.
      expect(renderRunsIndex([], { all: true, retention: null })).toContain("rowLib.fill(li, rowLib.mergeRow(rowLib.persistedFields(li), run));");
    });

    it("the index page routes every frame through feedAction, reading the row's data-persisted flag", () => {
      const html = renderRunsIndex([], { all: true, retention: null });
      expect(html).toContain('var act = rowLib.feedAction(ev, showAll, li ? li.getAttribute("data-persisted") === "1" : false);');
      expect(html).toContain('if (act.op === "upsert") upsert(act.run); else if (act.op === "remove") remove(act.id);');
    });
  });

  describe("KTD13: dev bypass off-loopback", () => {
    const bypass = (isLoopback: boolean) => ({ active: () => true, isLoopback: () => isLoopback });

    it("403s history reads (persisted page/events/friction, ?all=1) while a live token page still works", async () => {
      const h = harness({ devBypass: bypass(false) });
      await h.store!.put(record("r1"));
      for (const url of ["/runs/r1", "/runs/r1/events", "/runs/r1/friction", "/runs?all=1", "/runs?stream=1&all=1"]) {
        const t = fakeReqRes("GET", url);
        h.handler(t.req, t.res);
        await done(t);
        expect([url, t.status]).toEqual([url, 403]);
      }
      const live = h.registry.create();
      const ok = fakeReqRes("GET", `/runs/${live.id}?t=${live.token}`);
      h.handler(ok.req, ok.res);
      expect(ok.status).toBe(200);
      const idx = fakeReqRes("GET", "/runs");
      h.handler(idx.req, idx.res);
      await done(idx);
      expect(idx.status).toBe(200);
    });

    it("serves them on loopback, and always when the bypass is off", async () => {
      const on = harness({ devBypass: bypass(true) });
      await on.store!.put(record("r1"));
      const a = fakeReqRes("GET", "/runs/r1");
      on.handler(a.req, a.res);
      await done(a);
      expect(a.status).toBe(200);
      const off = harness({ devBypass: { active: () => false, isLoopback: () => false } });
      await off.store!.put(record("r1"));
      const b = fakeReqRes("GET", "/runs?all=1");
      off.handler(b.req, b.res);
      await done(b);
      expect(b.status).toBe(200);
    });

    it("isLoopbackAddress recognizes v4, v6 and mapped loopback only", () => {
      expect(["127.0.0.1", "::1", "::ffff:127.0.0.1"].map(isLoopbackAddress)).toEqual([true, true, true]);
      expect(["10.0.0.1", "203.0.113.9", undefined, ""].map(isLoopbackAddress)).toEqual([false, false, false, false]);
    });
  });
});
