import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import {
  createLiveViewHandler,
  escapeHtml,
  parseRunRoute,
  renderRunPage,
  renderRunsIndex,
  serveEvents,
  serveIndexEvents,
  type SseSink,
} from "./liveView.js";
import { renderMarkdownInto } from "./markdownLite.js";
import { RunRegistry } from "../core/runRegistry.js";
import type { RunEvent } from "../core/runEvents.js";
import type { IndexEvent, RunSummary } from "../core/runRegistry.js";

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
  it("renders an `answer` event into a dedicated block through the safe markdown renderer", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toContain('e.type === "answer"');
    expect(html).toContain('id="answer"');
    expect(html).toMatch(/md\(answerText, e\.text\)/);
    expect(html).not.toContain("innerHTML");
    // The answer only scrolls into view when the viewer is at the tail — a
    // reader parked on earlier rows keeps their place (review nit, #158).
    expect(html).toMatch(/if \(atTail\) answerBox\.scrollIntoView/);
  });

  it("every markdown surface renders through a try/catch guard that falls back to textContent (#179 review)", () => {
    const html = renderRunPage("run-1", "tok-1");
    expect(html).toMatch(/function md\(target, text\) \{\s*try \{ renderMarkdownInto\(target, text\); \} catch \(_\) \{ target\.textContent = text; \}/);
    // The three surfaces call the guard, never the renderer directly.
    expect(html).toContain("md(box, e.text)");
    expect(html).toContain("md(requestText, e.text)");
    expect(html).toContain("md(answerText, e.text)");
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

  it("inlines the self-contained markdown renderer (String(fn)) and uses it for Request/Answer/assistant", () => {
    expect(html).toContain(String(renderMarkdownInto));
    // The transpiler's keepNames helper (`__name`, emitted by esbuild under tsx)
    // must resolve in the browser: a no-op shim precedes the inlined source.
    const shim = html.indexOf("var __name = function (fn) { return fn; };");
    expect(shim).toBeGreaterThan(-1);
    expect(shim).toBeLessThan(html.indexOf("function renderMarkdownInto("));
    // every markdown surface goes through the one renderer — never raw markup
    expect(html).toMatch(/md\(requestText, e\.text\)/);
    expect(html).toMatch(/md\(answerText, e\.text\)/);
    expect(html).toMatch(/md\(box, e\.text\)/);
    expect(html).not.toContain("innerHTML");
  });

  it("renders an `input` event into a Request block that sits ABOVE the log", () => {
    expect(html).toContain('e.type === "input"');
    expect(html).toContain('id="request"');
    expect(html.indexOf('id="request"')).toBeLessThan(html.indexOf('<ul id="log"'));
    expect(html.indexOf('<ul id="log"')).toBeLessThan(html.indexOf('id="answer"'));
    expect(html).toContain(">Request<");
  });

  it("renders an `assistant` event as its own timeline row, styled distinctly from tool rows", () => {
    expect(html).toContain('e.type === "assistant"');
    expect(html).toMatch(/\.assistant\s*\{[^}]*border-left/); // the neutral left-border style
  });

  it("stamps every row and both blocks with a gray UTC [HH:MM:SS] from `at` (omitted when absent)", () => {
    // toISOString().slice(11, 19) is UTC HH:MM:SS regardless of the viewer's zone
    expect(html).toContain("toISOString().slice(11, 19)");
    expect(html).toMatch(/\.ts\s*\{[^}]*color:\s*#8b93a7/); // gray
    // no `at` → no bracket: the formatter returns "" for a missing timestamp
    expect(html).toMatch(/function fmtTime\(at\)\s*\{\s*return typeof at === "number" \? "\[" \+ .*\] " : "";/);
    // rows and blocks are built from a timestamp span + a body, via createElement/textContent
    expect(html).toContain('ts.className = "ts"');
    expect(html).toContain("ts.textContent = fmtTime(e.at)");
  });

  it("keeps the tool rows monospace and the markdown blocks proportional", () => {
    expect(html).toMatch(/#log > li\.call, #log > li\.ok, #log > li\.err, #log > li\.note\s*\{[^}]*ui-monospace/);
    expect(html).toMatch(/\.md\s*\{[^}]*-apple-system/);
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
    expect(rec.body()).toBe(PRELUDE + `data: ${JSON.stringify(call("$ echo hi"))}\n\n` + `data: ${JSON.stringify(result(true, "hi"))}\n\n`);
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
    expect(rec.body()).toContain(`data: ${JSON.stringify(call("earlier"))}`);
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
    expect(rec.body()).toContain(`data: ${JSON.stringify(call("done-earlier"))}`);
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
    const handler = createLiveViewHandler(fixedRegistry());
    const t = fakeReqRes("GET", "/ingress");
    expect(handler(t.req, t.res)).toBe(false);
    expect(t.status).toBe(0); // nothing written
  });

  it("serves the HTML page for a valid id+token (CSP set, no-store)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = createLiveViewHandler(reg);
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

  it("404s the page for a wrong/missing token (never reveals the run exists)", () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    const handler = createLiveViewHandler(reg);
    const wrong = fakeReqRes("GET", `/runs/${id}?t=nope`);
    handler(wrong.req, wrong.res);
    expect(wrong.status).toBe(404);
    expect(wrong.body()).not.toContain("EventSource"); // no page leaked

    const missing = fakeReqRes("GET", `/runs/${id}`);
    handler(missing.req, missing.res);
    expect(missing.status).toBe(404);
  });

  it("streams SSE for a valid id+token and forwards events", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = createLiveViewHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}/events?t=${token}`);
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    reg.publish(id, call("live one"));
    expect(t.body()).toContain(`data: ${JSON.stringify(call("live one"))}`);
    // Client disconnect unsubscribes.
    t.fireClose();
    reg.publish(id, call("after"));
    expect(t.body()).not.toContain("after");
  });

  it("404s the SSE stream for a wrong token", () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    const handler = createLiveViewHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}/events?t=nope`);
    handler(t.req, t.res);
    expect(t.status).toBe(404);
    expect(t.headers["content-type"]).not.toContain("event-stream");
  });

  it("405s a non-GET method on a run route", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = createLiveViewHandler(reg);
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
    const handler = createLiveViewHandler(reg);
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
    const handler = createLiveViewHandler(reg);
    const t = fakeReqRes("GET", "/runs/");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
  });

  it("renders the empty state when there are no active runs", () => {
    const reg = fixedRegistry();
    const handler = createLiveViewHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    handler(t.req, t.res);
    expect(t.status).toBe(200);
    expect(t.body()).toMatch(/no active runs/i);
  });

  it("405s a non-GET method on the index", () => {
    const reg = fixedRegistry();
    const handler = createLiveViewHandler(reg);
    const t = fakeReqRes("POST", "/runs");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(405);
  });

  it("HTML-escapes a malicious run label in the index instead of injecting markup", () => {
    const reg = new RunRegistry({ genId: () => "run-1", genToken: () => "tok-1" });
    reg.create("<script>alert(1)</script>");
    const handler = createLiveViewHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    handler(t.req, t.res);
    expect(t.body()).not.toContain("<script>alert(1)</script>");
    expect(t.body()).toContain("&lt;script&gt;");
  });

  it("routes /runs (no flag) to HTML and /runs?stream=1 to the index SSE feed", () => {
    const reg = fixedRegistry();
    reg.create("coding · owner/repo");
    const handler = createLiveViewHandler(reg);

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
    const handler = createLiveViewHandler(reg);
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
    const handler = createLiveViewHandler(reg);
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
      const handler = createLiveViewHandler(reg);
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

  it("404s for a wrong or missing token, revealing nothing", () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    reg.publish(id, call("$ npm install"));
    const handler = createLiveViewHandler(reg);
    for (const url of [`/runs/${id}/friction?t=nope`, `/runs/${id}/friction`, `/runs/unknown/friction?t=x`]) {
      const t = fakeReqRes("GET", url);
      expect(handler(t.req, t.res)).toBe(true);
      expect(t.status).toBe(404);
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
    const handler = createLiveViewHandler(reg);
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
    const handler = createLiveViewHandler(reg);
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
    expect(createLiveViewHandler(reg)(t.req, t.res)).toBe(true);
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
    createLiveViewHandler(reg)(t.req, t.res);
    expect(t.status).toBe(200);
    expect(JSON.parse(t.body()).mode).toBe("hard");
    expect(control.hardSignal.aborted).toBe(true);
  });

  it("400s a missing or unknown mode without touching the run", () => {
    const reg = fixedRegistry();
    const { id, token, control } = reg.create();
    const handler = createLiveViewHandler(reg);
    for (const q of ["", "&mode=", "&mode=nuke"]) {
      const t = fakeReqRes("POST", `/runs/${id}/stop?t=${token}${q}`);
      handler(t.req, t.res);
      expect(t.status).toBe(400);
    }
    expect(control.requested).toBeUndefined();
  });

  it("404s a wrong/missing token or unknown run (existence never revealed), control untouched", () => {
    const reg = fixedRegistry();
    const { id, control } = reg.create();
    const handler = createLiveViewHandler(reg);
    for (const url of [`/runs/${id}/stop?t=wrong&mode=hard`, `/runs/${id}/stop?mode=hard`, `/runs/nope/stop?t=tok-1&mode=hard`]) {
      const t = fakeReqRes("POST", url);
      handler(t.req, t.res);
      expect(t.status).toBe(404);
    }
    expect(control.requested).toBeUndefined();
    expect(control.hardSignal.aborted).toBe(false);
  });

  it("409s a stop on a finished run", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.finish(id);
    const t = fakeReqRes("POST", `/runs/${id}/stop?t=${token}&mode=soft`);
    createLiveViewHandler(reg)(t.req, t.res);
    expect(t.status).toBe(409);
  });

  it("is POST-only: GET on the stop route is 405 with allow: POST, and never stops the run", () => {
    const reg = fixedRegistry();
    const { id, token, control } = reg.create();
    const t = fakeReqRes("GET", `/runs/${id}/stop?t=${token}&mode=hard`);
    createLiveViewHandler(reg)(t.req, t.res);
    expect(t.status).toBe(405);
    expect(t.headers.allow).toBe("POST");
    expect(control.requested).toBeUndefined();
  });

  it("the other run routes stay GET-only (405 on POST) — the stop route is the ONLY writer", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const t = fakeReqRes("POST", `/runs/${id}/events?t=${token}`);
    createLiveViewHandler(reg)(t.req, t.res);
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
