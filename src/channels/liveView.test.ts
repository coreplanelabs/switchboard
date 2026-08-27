import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import {
  createLiveViewHandler,
  escapeHtml,
  parseRunRoute,
  renderRunPage,
  renderRunsIndex,
  serveEvents,
  type SseSink,
} from "./liveView.js";
import { RunRegistry } from "../core/runRegistry.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunSummary } from "../core/runRegistry.js";

// Feature: features/live-view.md — the external live-view page + SSE stream.
// Auth is a per-run capability token (in the URL, not a header); a wrong/missing
// token or unknown run is a 404. Handlers are transport-free where possible:
// parseRunRoute (pure), renderRunPage (pure), serveEvents (drives an SseSink).

const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
const result = (ok: boolean, summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary });

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
    expect(rec.body()).toBe(`data: ${JSON.stringify(call("$ echo hi"))}\n\n` + `data: ${JSON.stringify(result(true, "hi"))}\n\n`);
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

describe("createLiveViewHandler (node:http)", () => {
  function fakeReqRes(method: string, url: string, headers: IncomingHttpHeaders = {}) {
    const listeners: Record<string, () => void> = {};
    const req = { method, url, headers, on: (ev: string, cb: () => void) => void (listeners[ev] = cb) };
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
      fireClose: () => listeners.close?.(),
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
});
