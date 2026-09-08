import { describe, expect, it, vi } from "vitest";
import {
  createLiveViewHandler,
  escapeHtml,
  parseLastEventId,
  parseRunRoute,
  retentionSentence,
  serveEvents,
  serveIndexEvents,
  withOmittedMarkers,
  type IndexRow,
  type LiveViewContext,
  type LiveViewDeps,
  type SseSink,
} from "./liveView.js";
import { makeShellRenderer, type ShellRenderer } from "./webShell.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import {
  SEED_ELEMENT_ID,
  type RunHistorySeed,
  type RunLiveSeed,
  type RunNotFoundSeed,
  type RunsIndexSeed,
  type ScheduledSeed,
  type WebSeed,
} from "./webSeed.js";
import { accessActor, isLoopbackAddress } from "./commandHttp.js";
import { ALL_GRANTS, grantsFor, type GrantsSource } from "../core/authz/grants.js";
import { NO_GRANTS, predicateFor } from "../core/authz/index.js";
import { RunRegistry, type RunRegistryOptions } from "../core/runRegistry.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import { normalizeSpans } from "../core/normalizeSpans.js";
import type { RunEvent } from "../core/runEvents.js";
import type { RunRecord } from "../core/runRecord.js";
import { INDEX_PAGE_SIZE } from "./liveView.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { InMemoryRunLedger } from "../core/runLedger/inMemory.js";
import { createRunsService } from "../core/runsService.js";
import type { IndexEvent, RunSummary } from "../core/runRegistry.js";
import { FIXTURE_SCHEDULES } from "./scheduledPanel.test.js";
import { InMemoryScheduleStore, type ScheduleStore } from "../core/scheduleStore.js";

// Feature: features/live-view.md — the external live-view surface. Every HTML
// route serves the web-app shell with this page's SEED embedded (rendering
// itself is tested in web/); these tests own the server side: routing, the
// capability-token and Access gates, the seeds' content (token rules, 404
// shapes, retention), and the SSE transport. Auth is a per-run capability
// token (in the URL, not a header); a wrong/missing token or unknown run is a
// 404 that never reveals existence.

const call = (summary: string): RunEvent => ({ type: "tool_call", tool: "bash", summary });
const result = (ok: boolean, summary: string): RunEvent => ({ type: "tool_result", tool: "bash", ok, summary });

/** Every SSE response writes this prelude first, to flush the 200 head so the
 *  browser's EventSource fires `onopen` even before any data. */
const PRELUDE = "retry: 3000\n\n";

/** Fixed assets so shell output is deterministic. */
const shell: ShellRenderer = makeShellRenderer(
  { js: "/assets/main-test.js", css: ["/assets/main-test.css"] },
  ALL_CAPABILITIES,
);

/** The seed a rendered shell carries — what the web app will paint. */
function seedOf(html: string): WebSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as WebSeed;
}
const indexSeedOf = (html: string) => seedOf(html) as RunsIndexSeed;
const runSeedOf = (html: string) => seedOf(html) as RunLiveSeed | RunHistorySeed;
const scheduledSeedOf = (html: string) => seedOf(html) as ScheduledSeed;

/** Deterministic registry so ids/tokens are predictable in URL assertions. */
function fixedRegistry(over: Partial<RunRegistryOptions> = {}) {
  let n = 0;
  return new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}`, ...over });
}
/** A span record (features/tracing.md): the union gains the variant with the emitters. */
const spanEnd = (name: string): RunEvent =>
  ({ type: "span_end", spanId: `s-${name}`, name, startedAt: 1, durationMs: 5, status: "ok" }) as unknown as RunEvent;
const FINISHED_THEN_END = /event: finished\ndata: \{"finishedAt":\d+\}\n\nevent: end\ndata: \{"sealedAt":\d+\}\n\n$/;

/** The viewer every handler call below reads as unless a test says otherwise:
 *  a fleet admin resolved through the real Access resolver (`accessActor` over
 *  `grantsFor`, the path index.ts takes) — every channel, so the index and the
 *  history routes show what they always showed. The authz block passes its own
 *  viewers. */
const ADMIN: LiveViewContext = {
  actor: accessActor({ sub: "admin" }, (id) => grantsFor(id, { grants: new Map([["access:admin", ALL_GRANTS]]) })),
};

type Handler = ReturnType<typeof createLiveViewHandler>;
/** `createLiveViewHandler` with `ctx` defaulting to the admin viewer. */
function adminByDefault(
  handler: Handler,
): (req: Parameters<Handler>[0], res: Parameters<Handler>[1], ctx?: LiveViewContext) => boolean {
  return (req, res, ctx = ADMIN) => handler(req, res, ctx);
}

/** The handler over a registry alone — run history off (store: null), the
 *  live-only shape every token-path test below exercises. */
function liveOnlyHandler(registry: RunRegistry) {
  return adminByDefault(
    createLiveViewHandler({
      shell,
      service: createRunsService({ registry, store: null }),
      index: registry,
      retention: null,
    }),
  );
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

/** A request/response pair the handler drives without a socket: records the
 *  status, headers and body it writes; `finished` resolves the moment the
 *  handler ends the response (the await every async route needs — an event,
 *  not a poll); `fireClose` plays the client going away. */
function fakeReqRes(method: string, url: string) {
  const listeners: Record<string, Array<() => void>> = {};
  const req = {
    method,
    url,
    headers: {},
    socket: { remoteAddress: "203.0.113.9" },
    on: (ev: string, cb: () => void) => void (listeners[ev] ??= []).push(cb),
  };
  let status = 0;
  let outHeaders: Record<string, string> = {};
  const chunks: string[] = [];
  let ended = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      outHeaders = h ?? {};
    },
    write: (c: string) => void chunks.push(c),
    end: (c?: string) => {
      if (c) chunks.push(c);
      ended = true;
      finish();
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
    finished,
    fireClose: () => listeners.close?.forEach((cb) => cb()),
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
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
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
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(rec.status).toBe(200);
    expect(rec.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(rec.headers["cache-control"]).toContain("no-cache");

    reg.publish(id, call("$ echo hi"));
    reg.publish(id, result(true, "hi"));
    // Each frame carries its stream position twice on purpose: as the SSE `id:`
    // (the resume cursor) and as `seq` on the event itself (the record's order).
    expect(rec.body()).toBe(
      PRELUDE +
        `id: 1\ndata: ${JSON.stringify({ ...call("$ echo hi"), seq: 1 })}\n\n` +
        `id: 2\ndata: ${JSON.stringify({ ...result(true, "hi"), seq: 2 })}\n\n`,
    );
  });

  it("a reconnect with Last-Event-ID replays only the events after that position — never the whole backlog again", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("one"));
    reg.publish(id, call("two"));
    reg.publish(id, call("three"));
    const rec = recordingSink();
    const afterSeq = parseLastEventId("2");
    serveEvents(
      (onEvent, onFinished, onSealed) =>
        reg.subscribe(id, token, { onEvent, onFinished, onSealed, afterSeq: afterSeq }),
      rec.sink,
    );
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
    serveEvents((onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }), a.sink);
    serveEvents((onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }), b.sink);
    const spy = vi.spyOn(JSON, "stringify");
    reg.publish(id, result(true, "x".repeat(5000)));
    const calls = spy.mock.calls.filter(
      (c) => typeof c[0] === "object" && c[0] !== null && (c[0] as { type?: string }).type === "tool_result",
    );
    spy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(a.body()).toBe(b.body());
  });

  it("flushes the head with the prelude even when the backlog is empty (no stuck 'connecting')", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(rec.status).toBe(200);
    expect(rec.body()).toBe(PRELUDE);
  });

  it("flushes a late subscriber's replayed backlog AFTER the 200 head (never before)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("earlier"));
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(rec.status).toBe(200);
    expect(rec.body()).toContain(`data: ${JSON.stringify({ ...call("earlier"), seq: 1 })}`);
  });

  it("writes the `finished` frame at finish and the terminal `end` frame (with the seal stamp) at the seal, then closes the stream", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    reg.publish(id, call("x"));
    reg.finish(id);
    expect(rec.ended).toBe(false);
    reg.seal(id);
    expect(rec.body()).toMatch(FINISHED_THEN_END);
    expect(rec.ended).toBe(true);
  });

  it("a finished-but-unsealed run: `finished` is written and the stream stays open, span records still flow, and the seal writes `end` carrying `replyOk` and closes it", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    reg.publish(id, call("x"));
    reg.finish(id);
    expect(rec.body()).toMatch(/event: finished\ndata: \{"finishedAt":\d+\}\n\n$/);
    expect(rec.ended).toBe(false);
    reg.publish(id, spanEnd("run.agent"));
    expect(rec.body()).toMatch(/id: 2\ndata: \{"type":"span_end"[^\n]*\n\n$/);
    reg.seal(id, { replyOk: true });
    expect(rec.body()).toMatch(/event: end\ndata: \{"sealedAt":\d+,"replyOk":true\}\n\n$/);
    expect(rec.ended).toBe(true);
  });

  it("an already-sealed run replays its backlog, then `finished`, then `end`, immediately (still 200)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    reg.publish(id, call("done-earlier"));
    reg.finish(id);
    reg.seal(id);
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(rec.status).toBe(200);
    expect(rec.body()).toContain(`data: ${JSON.stringify({ ...call("done-earlier"), seq: 1 })}`);
    expect(rec.body()).toMatch(FINISHED_THEN_END);
    expect(rec.body().indexOf("done-earlier")).toBeLessThan(rec.body().indexOf("event: finished"));
    expect(rec.ended).toBe(true);
  });

  it("unsubscribes when the client connection closes", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    rec.fireClose();
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
      onEvent(replayed);
      emit = onEvent;
      return () => void (unsubscribed = true);
    }, rec.sink);

    expect(rec.status).toBe(200);
    expect(rec.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(rec.headers["cache-control"]).toContain("no-cache");
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
    expect(rec.body()).toBe(PRELUDE);
    reg.create("coding · owner/repo");
    expect(rec.body()).toContain('"type":"upsert"');
    expect(rec.body()).toContain('"id":"run-1"');
    expect(rec.body()).toContain('"label":"coding · owner/repo"');
  });
});

// Feature: features/live-view.md item 14 (#244) — the Scheduled tab: its seed
// is built from the schedule registry + the ScheduleStore's latest firings
// before the page is written; a missing/failing store is reported as such.
describe("scheduled tab — GET /runs/scheduled (#244, item 18)", () => {
  const NOW = Date.UTC(2026, 7, 29, 12, 0);
  function panelHandler(registry: RunRegistry, options: Pick<LiveViewDeps, "scheduled">) {
    return adminByDefault(
      createLiveViewHandler({
        shell,
        service: createRunsService({ registry, store: null }),
        index: registry,
        retention: null,
        now: () => NOW,
        ...options,
      }),
    );
  }
  function pageFor(options: Pick<LiveViewDeps, "scheduled">, url = "/runs/scheduled", method = "GET") {
    const registry = new RunRegistry({ genId: () => "run-live", genToken: () => "tok-live" });
    const handler = panelHandler(registry, options);
    let body = "";
    let status = 0;
    let headers: Record<string, string> = {};
    const res = {
      writeHead: (s: number, h?: Record<string, string>) => void ((status = s), (headers = h ?? {})),
      write: (c: string) => void (body += c),
      end: (c?: string) => void (body += c ?? ""),
    };
    const req = { method, url, headers: {}, on: () => {} };
    const owned = handler(req as never, res as never);
    return {
      registry,
      owned,
      get body() {
        return body;
      },
      get status() {
        return status;
      },
      get headers() {
        return headers;
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("the runs index seed carries no schedule rows — the tab is its own page with its own seed", async () => {
    const registry = new RunRegistry({ genId: () => "run-live", genToken: () => "tok-live" });
    const index = fakeReqRes("GET", "/runs");
    panelHandler(registry, { scheduled: { schedules: FIXTURE_SCHEDULES } })(index.req, index.res);
    await index.finished; // the index awaits the service's rows live elsewhere (run-history item 41)
    expect(index.status).toBe(200);
    expect(indexSeedOf(index.body()).page).toBe("runs");
    const tab = pageFor({ scheduled: { schedules: FIXTURE_SCHEDULES } });
    expect(tab.status).toBe(200);
    expect(tab.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(scheduledSeedOf(tab.body).page).toBe("scheduled");
  });

  it("without `scheduled` the tab's seed says no registry is configured (rows null; 200, not 404)", () => {
    const t = pageFor({});
    expect(t.owned).toBe(true);
    expect(t.status).toBe(200);
    expect(scheduledSeedOf(t.body).rows).toBeNull();
  });

  it("is GET-only like the index (POST → 405 allow: GET)", () => {
    const t = pageFor({}, "/runs/scheduled", "POST");
    expect(t.owned).toBe(true);
    expect(t.status).toBe(405);
    expect(t.headers.allow).toBe("GET");
  });

  it("seeds the rows from the registry + the store's latest firings, linking a live run with its token; internal plumbing stays off", async () => {
    const registry = new RunRegistry({ genId: () => "run-live", genToken: () => "tok-live" });
    registry.create("friction · #cron · cron");
    const store = new InMemoryScheduleStore();
    await store.record({
      schedule: "self-improvement",
      firedAt: NOW - 60_000,
      outcome: "completed",
      runId: "run-live",
      detail: "🔍 8 runs analyzed",
    });
    const handler = panelHandler(registry, { scheduled: { schedules: FIXTURE_SCHEDULES, store } });
    let body = "";
    const res = { writeHead: () => {}, write: () => {}, end: (c?: string) => void (body += c ?? "") };
    expect(handler({ method: "GET", url: "/runs/scheduled", headers: {}, on: () => {} } as never, res as never)).toBe(
      true,
    );
    await tick();
    const seed = scheduledSeedOf(body);
    expect(seed.now).toBe(NOW);
    expect(seed.firingsUnavailable).toBeUndefined();
    const rows = seed.rows ?? [];
    const si = rows.find((r) => r.name === "self-improvement");
    expect(si?.last).toMatchObject({
      outcome: "completed",
      runId: "run-live",
      runHref: "/runs/run-live?t=tok-live",
      detail: "🔍 8 runs analyzed",
    });
    expect(si?.nextFireAt).toBe(Date.UTC(2026, 7, 31, 14, 0)); // next fire, Monday
    expect(rows.some((r) => r.name === "resident-watchdog")).toBe(true);
    expect(rows.some((r) => r.name === "keep-alive")).toBe(false); // internal plumbing stays off the dashboard
  });

  it("links a live firing with its token only for a viewer who may read that run — an unlisted browser session gets the bare tokenless href (authorization.md items 5–7, #428)", async () => {
    const registry = new RunRegistry({ genId: () => "run-live", genToken: () => "tok-live" });
    registry.create("friction · #cron · cron", {
      channelId: "http:cron",
      userId: "http:cron",
      threadKey: "http:cron:1",
      channelVisibility: "machine",
    });
    const store = new InMemoryScheduleStore();
    await store.record({
      schedule: "self-improvement",
      firedAt: NOW - 60_000,
      outcome: "completed",
      runId: "run-live",
      detail: "🔍 8 runs analyzed",
    });
    const handler = panelHandler(registry, { scheduled: { schedules: FIXTURE_SCHEDULES, store } });
    const alice: LiveViewContext = {
      actor: accessActor({ sub: "alice" }, (id) => grantsFor(id, { commandGroups: ["runs"] })),
    };
    const hrefFor = async (ctx?: LiveViewContext) => {
      let body = "";
      const res = { writeHead: () => {}, write: () => {}, end: (c?: string) => void (body += c ?? "") };
      handler({ method: "GET", url: "/runs/scheduled", headers: {}, on: () => {} } as never, res as never, ctx);
      await tick();
      return (scheduledSeedOf(body).rows ?? []).find((r) => r.name === "self-improvement")?.last?.runHref;
    };
    expect(await hrefFor(alice)).toBe("/runs/run-live");
    expect(await hrefFor()).toBe("/runs/run-live?t=tok-live");
  });

  it("no store → the seed lists the schedules and says history is unavailable (not 'never fired')", async () => {
    const t = pageFor({ scheduled: { schedules: FIXTURE_SCHEDULES } });
    await tick();
    expect(t.status).toBe(200);
    const seed = scheduledSeedOf(t.body);
    expect(seed.firingsUnavailable).toBe("schedules.worker is not configured");
    expect(seed.rows?.length).toBeGreaterThan(0);
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
    const seed = scheduledSeedOf(t.body);
    expect(seed.firingsUnavailable).toBe("schedule worker /latest HTTP 503");
    expect(seed.rows?.some((r) => r.name === "self-improvement")).toBe(true);
  });
});

describe("createLiveViewHandler (node:http)", () => {
  it("returns false for a non-run path (server falls through to its other routes)", () => {
    const handler = liveOnlyHandler(fixedRegistry());
    const t = fakeReqRes("GET", "/ingress");
    expect(handler(t.req, t.res)).toBe(false);
    expect(t.status).toBe(0);
  });

  it("serves the live-run shell for a valid id+token (strict headers; seed carries the token-scoped stream + stop URLs)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${id}?t=${token}`);
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
    expect(t.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(t.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(t.headers["x-frame-options"]).toBe("DENY");
    expect(t.headers["cache-control"]).toBe("no-store");
    const seed = runSeedOf(t.body());
    expect(seed).toEqual({
      page: "run",
      mode: "live",
      id,
      eventsUrl: `/runs/${id}/events?t=${token}`,
      stopUrl: `/runs/${id}/stop?t=${token}`,
      // the header's one duration reads from these (item 22)
      serverNow: expect.any(Number),
      startedAt: expect.any(Number),
      capabilities: ALL_CAPABILITIES,
    });
  });

  it("percent-encodes id/token into the seeded URLs so special chars can't break them", () => {
    const reg = new RunRegistry({ genId: () => "a/b", genToken: () => 'x"y' });
    const { id, token } = reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", `/runs/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
    handler(t.req, t.res);
    expect(t.status).toBe(200);
    const seed = runSeedOf(t.body()) as RunLiveSeed;
    expect(seed.eventsUrl).toBe("/runs/a%2Fb/events?t=x%22y");
    expect(t.body()).not.toContain('t=x"y');
  });

  it("404s the page for a wrong/missing token (never reveals the run exists)", async () => {
    const reg = fixedRegistry();
    const { id } = reg.create();
    const handler = liveOnlyHandler(reg);
    const wrong = fakeReqRes("GET", `/runs/${id}?t=nope`);
    handler(wrong.req, wrong.res);
    await wrong.finished;
    expect(wrong.status).toBe(404);
    expect((seedOf(wrong.body()) as RunNotFoundSeed).page).toBe("runNotFound"); // no live page leaked

    const missing = fakeReqRes("GET", `/runs/${id}`);
    handler(missing.req, missing.res);
    await missing.finished;
    expect(missing.status).toBe(404);
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
    await t.finished;
    expect(t.status).toBe(404);
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
  // (Cloudflare Access is the "who" gate), and its seed carries the per-run
  // capability tokens — so it must only ever be exposed behind Access.
  it("serves the index shell at bare /runs: live rows with tokens in the seed, strict headers, the live count in the title", async () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create("coding · owner/repo");
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    expect(handler(t.req, t.res)).toBe(true);
    await t.finished;
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
    expect(t.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(t.headers["x-frame-options"]).toBe("DENY");
    expect(t.headers["cache-control"]).toBe("no-store");
    const seed = indexSeedOf(t.body());
    expect(seed.all).toBe(false);
    expect(seed.retentionDays).toBeNull();
    expect(seed.rows).toHaveLength(1);
    expect(seed.rows[0]).toMatchObject({ id, token, label: "coding · owner/repo", finished: false });
    expect(t.body()).toContain("<title>(1) Live runs</title>"); // item 21: the tab carries the live count
  });

  it("also serves the index at /runs/ (trailing slash)", async () => {
    const reg = fixedRegistry();
    reg.create();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs/");
    expect(handler(t.req, t.res)).toBe(true);
    await t.finished;
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toContain("text/html");
  });

  it("seeds an empty row list (and a bare title) when there are no active runs", async () => {
    const reg = fixedRegistry();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    handler(t.req, t.res);
    await t.finished;
    expect(t.status).toBe(200);
    expect(indexSeedOf(t.body()).rows).toEqual([]);
    expect(t.body()).toContain("<title>Live runs</title>");
  });

  it("405s a non-GET method on the index", () => {
    const reg = fixedRegistry();
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("POST", "/runs");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(405);
  });

  it("a hostile run label is inert in the page: the seed island escapes every angle bracket", async () => {
    const reg = new RunRegistry({ genId: () => "run-1", genToken: () => "tok-1" });
    reg.create("</script><script>alert(1)</script>");
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs");
    handler(t.req, t.res);
    await t.finished;
    const html = t.body();
    expect(html).not.toContain("<script>alert(1)</script>");
    // exactly the shell's own two script elements (the seed island + the module)
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(indexSeedOf(html).rows[0].label).toBe("</script><script>alert(1)</script>"); // …and survives the round trip as data
  });

  it("routes /runs (no flag) to HTML and /runs?stream=1 to the index SSE feed", async () => {
    const reg = fixedRegistry();
    reg.create("coding · owner/repo");
    const handler = liveOnlyHandler(reg);

    const htmlReq = fakeReqRes("GET", "/runs");
    handler(htmlReq.req, htmlReq.res);
    await htmlReq.finished;
    expect(htmlReq.headers["content-type"]).toContain("text/html");

    const sseReq = fakeReqRes("GET", "/runs?stream=1");
    handler(sseReq.req, sseReq.res);
    expect(sseReq.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
  });

  it("streams the index SSE feed at /runs?stream=1: replays active runs, forwards new ones, unsubscribes on close", () => {
    const reg = fixedRegistry();
    reg.create("coding · owner/repo");
    const handler = liveOnlyHandler(reg);
    const t = fakeReqRes("GET", "/runs?stream=1");
    expect(handler(t.req, t.res)).toBe(true);
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(t.body()).toContain('"label":"coding · owner/repo"');

    reg.create("review · thread-9");
    expect(t.body()).toContain('"label":"review · thread-9"');

    t.fireClose();
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

  it("SSE heartbeat: writes a keepalive comment on an idle live stream, then stops on client close", () => {
    vi.useFakeTimers();
    try {
      const reg = fixedRegistry();
      const handler = liveOnlyHandler(reg);
      const t = fakeReqRes("GET", "/runs?stream=1");
      expect(handler(t.req, t.res)).toBe(true);
      expect(t.status).toBe(200);
      expect(t.body()).not.toContain(": hb");

      vi.advanceTimersByTime(20_000);
      expect(t.body()).toContain(": hb\n\n");
      const afterOne = t.body();

      t.fireClose();
      vi.advanceTimersByTime(40_000);
      expect(t.body()).toBe(afterOne);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /runs/:id/friction — read-only friction diagnosis (#84)", () => {
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
      await t.finished;
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
    expect(body.diagnosis.findings).toEqual([]);
  });
});

// Feature: features/live-view.md item 10 — run control from /runs (#101):
// `POST /runs/:id/stop?t=…&mode=soft|hard` behind the same token gate.
describe("run control: POST /runs/:id/stop (#101)", () => {
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
    for (const url of [
      `/runs/${id}/stop?t=wrong&mode=hard`,
      `/runs/${id}/stop?mode=hard`,
      `/runs/nope/stop?t=tok-1&mode=hard`,
    ]) {
      const t = fakeReqRes("POST", url);
      handler(t.req, t.res);
      await t.finished;
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
});

// Feature: features/live-view.md — the live replay budget (item 5).
describe("serveEvents — live replay budget (item 5)", () => {
  const elidedFrame = (fromSeq: number, toSeq: number) =>
    `event: replay_elided\ndata: ${JSON.stringify({ fromSeq, toSeq })}\n\n`;
  const idFrames = (rec: ReturnType<typeof recordingSink>) => rec.writes.filter((w) => w.startsWith("id: "));

  it("a late subscriber to a 3000-event run gets one replay_elided frame (1–1000) then the newest 2000 frames; live frames stay uncapped; snapshot has all 3000", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 3000; i++) reg.publish(id, call(`$ step ${i}`));
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(rec.writes[0]).toBe(PRELUDE);
    expect(rec.writes[1]).toBe(elidedFrame(1, 1000));
    const ids = idFrames(rec);
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toMatch(/^id: 1001\n/);
    expect(ids[0]).toContain('"summary":"$ step 1001"');
    expect(ids[1999]).toMatch(/^id: 3000\n/);
    expect(rec.body()).not.toContain("replay_note");
    expect(reg.snapshot(id, token)?.events).toHaveLength(3000);
    reg.publish(id, call("$ step 3001"));
    expect(rec.body()).toContain('"summary":"$ step 3001"');
  });

  it("a run within the budget replays everything with no elided frame (byte-identical to before)", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 2000; i++) reg.publish(id, call(`$ step ${i}`));
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(idFrames(rec)).toHaveLength(2000);
    expect(rec.body()).not.toContain("replay_elided");
    expect(rec.writes[1]).toMatch(/^id: 1\n/);
  });

  it("an already-finished long run: the elided frame, the newest 2000, then the end frame", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 2500; i++) reg.publish(id, call(`$ step ${i}`));
    reg.finish(id);
    reg.seal(id);
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) => reg.subscribe(id, token, { onEvent, onFinished, onSealed }),
      rec.sink,
    );
    expect(rec.writes[1]).toBe(elidedFrame(1, 500));
    expect(idFrames(rec)).toHaveLength(2000);
    expect(rec.writes[rec.writes.length - 1]).toMatch(/^event: end\ndata: \{"sealedAt":\d+\}\n\n$/);
    expect(rec.ended).toBe(true);
  });

  it("a resume cursor and the budget compose: the elided range starts after the cursor and the newest 2000 after it are replayed", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 3000; i++) reg.publish(id, call(`$ step ${i}`));
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) =>
        reg.subscribe(id, token, { onEvent, onFinished, onSealed, afterSeq: parseLastEventId("500") }),
      rec.sink,
    );
    expect(rec.writes[1]).toBe(elidedFrame(501, 1000));
    const ids = idFrames(rec);
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toMatch(/^id: 1001\n/);
    expect(ids[1999]).toMatch(/^id: 3000\n/);
    const rec2 = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) =>
        reg.subscribe(id, token, { onEvent, onFinished, onSealed, afterSeq: parseLastEventId("2500") }),
      rec2.sink,
    );
    const ids2 = idFrames(rec2);
    expect(ids2).toHaveLength(500);
    expect(rec2.body()).not.toContain("replay_elided");
    expect(ids2[0]).toMatch(/^id: 2501\n/);
  });

  it("the byte bound elides too: the frames replayed are the newest that fit the registry's byteLimit", () => {
    const reg = fixedRegistry();
    const { id, token } = reg.create();
    for (let i = 1; i <= 5; i++) reg.publish(id, call(`$ step ${i}`));
    const bytes = (i: number) => Buffer.byteLength(JSON.stringify({ ...call(`$ step ${i}`), seq: i }), "utf8");
    const rec = recordingSink();
    serveEvents(
      (onEvent, onFinished, onSealed) =>
        reg.subscribe(id, token, { onEvent, onFinished, onSealed, byteLimit: bytes(4) + bytes(5) }),
      rec.sink,
    );
    expect(rec.writes[1]).toBe(elidedFrame(1, 3));
    expect(idFrames(rec).map((w) => w.slice(0, w.indexOf("\n")))).toEqual(["id: 4", "id: 5"]);
  });
});

// Feature: features/live-view.md / run-history.md — the live view on
// `RunsService` (#157 U8): finished/persisted runs are seeded tokenless in
// history mode; the index seeds active runs by default (never touching the
// store) and everything with `?all=1`; live rows keep their capability tokens
// in the seed, finished rows never carry one.
describe("live view on RunsService: history pages + index toggle (#157 U8)", () => {
  const NOW = 1_700_000_000_000;
  const text = (type: "input" | "context" | "assistant" | "answer", t: string, seq: number): RunEvent =>
    ({ type, text: t, seq }) as RunEvent;

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
      channelVisibility: "unknown",
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

  /** Registry + store + service + handler, with every knob injectable. */
  function harness(
    opts: {
      store?: InMemoryRunStore | null;
      retention?: { retentionDays: number } | null;
      devBypass?: LiveViewDeps["devBypass"];
      audit?: LiveViewDeps["audit"];
      indexPageSize?: number;
      ledger?: InMemoryRunLedger;
    } = {},
  ) {
    let clock = NOW;
    const now = () => clock;
    let n = 0;
    const registry = new RunRegistry({ genId: () => `run-${++n}`, genToken: () => `tok-${n}`, now });
    const store = opts.store === undefined ? new InMemoryRunStore({ now }) : opts.store;
    const service = createRunsService({ registry, store, ...(opts.ledger ? { ledger: opts.ledger } : {}) });
    const handler = adminByDefault(
      createLiveViewHandler({
        shell,
        service,
        index: registry,
        now, // the seeds carry `serverNow`: two renders compared byte-for-byte need one clock
        retention: opts.retention === undefined ? { retentionDays: 30 } : opts.retention,
        ...(opts.devBypass ? { devBypass: opts.devBypass } : {}),
        ...(opts.audit ? { audit: opts.audit } : {}),
        ...(opts.indexPageSize !== undefined ? { indexPageSize: opts.indexPageSize } : {}),
      }),
    );
    return { registry, store, service, handler, tick: (ms: number) => (clock += ms) };
  }

  const done = (t: { finished: Promise<void> }) => t.finished;

  describe("persisted run page (history mode)", () => {
    it("200s tokenless: the seed is history mode with the record's events, status and duration — no token anywhere", async () => {
      const h = harness();
      await h.store!.put(record("r1"));
      const t = fakeReqRes("GET", "/runs/r1");
      expect(h.handler(t.req, t.res)).toBe(true);
      await done(t);
      expect(t.status).toBe(200);
      expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      const seed = runSeedOf(t.body()) as RunHistorySeed;
      expect(seed.mode).toBe("history");
      // The seed is the record's stream normalized (features/tracing.md): this
      // legacy record's tool pair gains its `tool.bash` twin, nothing else moves.
      expect(seed.events).toEqual(normalizeSpans(record("r1").events));
      expect(seed.events.filter((e) => e.type === "span_end")).toMatchObject([{ name: "tool.bash", status: "ok" }]);
      expect(seed.events.filter((e) => e.type !== "span_start" && e.type !== "span_end")).toEqual(record("r1").events);
      expect(seed.status).toBe("completed");
      expect(seed.eventCount).toBe(5);
      expect(seed.durationMs).toBe(10_000);
      expect(seed.startedAt).toBe(record("r1").startedAt);
      expect(seed.finishedAt).toBe(record("r1").finishedAt);
      expect(seed.truncated).toBe(record("r1").truncated); // the timeline's `(too large)` (live-view item 25)
      expect(t.body()).not.toContain("?t=");
      expect(t.body()).not.toContain("tok-");
    });

    it("a record carrying receivedAt seeds a duration that opens there — the one definition (features/tracing.md)", async () => {
      const h = harness();
      const base = record("r2");
      await h.store!.put({
        ...base,
        receivedAt: base.startedAt - 5_000,
        sealedAt: base.finishedAt + 2_000,
        replyOk: true,
      });
      const t = fakeReqRes("GET", "/runs/r2");
      expect(h.handler(t.req, t.res)).toBe(true);
      await done(t);
      const seed = runSeedOf(t.body()) as RunHistorySeed;
      expect(seed.durationMs).toBe(15_000);
      expect(seed).toMatchObject({
        receivedAt: base.startedAt - 5_000,
        sealedAt: base.finishedAt + 2_000,
        replyOk: true,
      });
    });

    it("carries the record's terminal status for stopped and failed runs (the page renders the outcome chip from it)", async () => {
      const h = harness();
      await h.store!.put(record("r1", { status: "stopped_soft" }));
      await h.store!.put(record("r2", { status: "failed" }));
      const a = fakeReqRes("GET", "/runs/r1");
      h.handler(a.req, a.res);
      await done(a);
      expect((runSeedOf(a.body()) as RunHistorySeed).status).toBe("stopped_soft");
      const b = fakeReqRes("GET", "/runs/r2");
      h.handler(b.req, b.res);
      await done(b);
      expect((runSeedOf(b.body()) as RunHistorySeed).status).toBe("failed");
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
      const seed = runSeedOf(t.body()) as RunHistorySeed;
      expect(seed.mode).toBe("history");
      expect(seed.events.some((e) => "text" in e && e.text === "hi")).toBe(true);
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
      expect(t.body().match(/<\/script>/g)).toHaveLength(2); // the shell's own two script elements only
      const seed = runSeedOf(t.body()) as RunHistorySeed;
      expect(seed.events[0]).toMatchObject({ text: payload }); // …and the payload survives as data
    });

    it("emits one audit line per history page/events read with the route, run id and the viewer's actor id — never content", async () => {
      const audit = vi.fn();
      const h = harness({ audit });
      await h.store!.put(record("r1"));
      const page = fakeReqRes("GET", "/runs/r1");
      h.handler(page.req, page.res);
      await done(page);
      const events = fakeReqRes("GET", "/runs/r1/events");
      h.handler(events.req, events.res);
      await done(events);
      expect(audit.mock.calls).toEqual([
        [{ route: "page", runId: "r1", identity: "access:admin" }],
        [{ route: "events", runId: "r1", identity: "access:admin" }],
      ]);
      for (const [entry] of audit.mock.calls) expect(JSON.stringify(entry)).not.toContain("please run it");
    });
  });

  describe("AE11: truncated records", () => {
    it("withOmittedMarkers marks every seq gap with its own count; the unaccounted remainder is a tail marker", () => {
      const events: RunEvent[] = [
        text("input", "a", 1),
        { ...call("b"), seq: 4 },
        { ...call("c"), seq: 5 },
        { ...call("d"), seq: 9 },
      ];
      expect(withOmittedMarkers(events, 12)).toEqual([
        events[0],
        { type: "replay_note", summary: "2 records omitted" },
        events[1],
        events[2],
        { type: "replay_note", summary: "3 records omitted" },
        events[3],
        { type: "replay_note", summary: "3 records omitted" },
      ]);
      const odd: RunEvent[] = [
        { ...call("x"), seq: 1 },
        { ...call("y"), seq: 50 },
      ];
      expect(withOmittedMarkers(odd, 3)).toEqual([
        odd[0],
        { type: "replay_note", summary: "1 record omitted" },
        odd[1],
      ]);
    });

    it("withOmittedMarkers puts one 'N records omitted' note at a single seq gap, N = eventCount − stored", () => {
      const events: RunEvent[] = [
        text("input", "a", 1),
        { ...call("b"), seq: 2 },
        { ...call("c"), seq: 8 },
        text("answer", "d", 9),
      ];
      expect(withOmittedMarkers(events, 9)).toEqual([
        events[0],
        events[1],
        { type: "replay_note", summary: "5 records omitted" },
        events[2],
        events[3],
      ]);
    });

    it("a gap at the start puts the marker first; a record with nothing missing gets no marker; a gap only at the tail puts it last", () => {
      const tail: RunEvent[] = [
        { ...call("x"), seq: 4 },
        { ...call("y"), seq: 5 },
      ];
      expect(withOmittedMarkers(tail, 5)[0]).toEqual({ type: "replay_note", summary: "3 records omitted" });
      const full: RunEvent[] = [
        { ...call("x"), seq: 1 },
        { ...call("y"), seq: 2 },
      ];
      expect(withOmittedMarkers(full, 2)).toEqual(full);
      expect(withOmittedMarkers(full, 3).at(-1)).toEqual({ type: "replay_note", summary: "1 record omitted" });
    });

    it("the persisted page seeds the marker in place and the events replay carries it too", async () => {
      const h = harness();
      const events: RunEvent[] = [
        text("input", "a", 1),
        { ...call("b"), seq: 2 },
        { ...call("c"), seq: 8 },
        text("answer", "d", 9),
      ];
      await h.store!.put(record("r1", { events, eventCount: 9, storedEventCount: 4, truncated: true }));
      const page = fakeReqRes("GET", "/runs/r1");
      h.handler(page.req, page.res);
      await done(page);
      const seed = runSeedOf(page.body()) as RunHistorySeed;
      // Markers sit where the `seq` gaps are, around the normalized stream's
      // synthesized (seq-less) spans: 5 omitted between seq 2 and 8, in place.
      expect(seed.events).toEqual(withOmittedMarkers(normalizeSpans(events), 9));
      const contentAndMarkers = seed.events.filter((e) => e.type !== "span_start" && e.type !== "span_end");
      expect(contentAndMarkers).toEqual(withOmittedMarkers(events, 9));
      const stream = fakeReqRes("GET", "/runs/r1/events");
      h.handler(stream.req, stream.res);
      await done(stream);
      expect(stream.body()).toContain('data: {"type":"replay_note","summary":"5 records omitted"}\n\n');
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
    it("unknown, expired, and wrong-token-on-live give the identical 404 page seed; events and friction keep the text body", async () => {
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
      const pageBodies = new Set<string>();
      for (const url of urls) {
        const t = fakeReqRes("GET", url);
        h.handler(t.req, t.res);
        await done(t);
        expect([url, t.status]).toEqual([url, 404]);
        if (/\/(events|friction)$/.test(url)) expect(t.body()).toBe("run not found");
        else {
          const seed = seedOf(t.body()) as RunNotFoundSeed;
          expect(seed).toEqual({ page: "runNotFound", retentionDays: 30, capabilities: ALL_CAPABILITIES }); // nothing echoed from the request — a static seed
          expect(t.body()).not.toContain("nope");
          expect(t.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
          pageBodies.add(t.body());
        }
      }
      expect(pageBodies.size).toBe(1); // byte-identical: existence never revealed
    });

    it("with run history off (store null) a finished, evicted run is the same 404 page", async () => {
      const h = harness({ store: null });
      const run = h.registry.create();
      h.registry.finish(run.id);
      h.registry.seal(run.id); // the TTL runs from the seal
      h.tick(120_000);
      const t = fakeReqRes("GET", `/runs/${run.id}`);
      h.handler(t.req, t.res);
      await done(t);
      expect(t.status).toBe(404);
      const seed = seedOf(t.body()) as RunNotFoundSeed;
      expect(seed).toEqual({ page: "runNotFound", retentionDays: 30, capabilities: ALL_CAPABILITIES });
    });
  });

  describe("index: active by default, everything with ?all=1", () => {
    it("a run live on the ledger under another generation opens tokenless (item 41): the page in history mode with the ledger's events and no token, the events route a replay that ends, friction a live diagnosis, and the tokenless stop goes to the ledger", async () => {
      const ledger = new InMemoryRunLedger(() => NOW);
      const h = harness({ ledger });
      await ledger.claim({
        runId: "far-1",
        threadKey: "slack:C9:far",
        gen: "g-OTHER",
        leaseMs: 30_000,
        startedAt: NOW - 5_000,
        meta: { channelId: "slack:C9", userId: "slack:U9", threadKey: "slack:C9:far", agent: "review" },
        card: null,
        system: "sys",
        tools: [],
      });
      await ledger.append("far-1", "g-OTHER", [
        { type: "input", text: "far away", at: NOW - 5_000, seq: 1 },
        { type: "tool_call", tool: "bash", summary: "$ ls", at: NOW - 4_000, seq: 2 },
      ]);
      const page = fakeReqRes("GET", "/runs/far-1");
      h.handler(page.req, page.res);
      await done(page);
      expect(page.status).toBe(200);
      const seed = runSeedOf(page.body()) as RunHistorySeed;
      expect(seed.mode).toBe("history");
      expect(seed.events.some((e) => "text" in e && e.text === "far away")).toBe(true);
      expect(seed.eventCount).toBe(2);
      expect(seed.finishedAt).toBeUndefined(); // live: no finish stamp, no duration
      expect(page.body()).not.toMatch(/\?t=/); // no token anywhere: the page token is the other generation's
      const events = fakeReqRes("GET", "/runs/far-1/events");
      h.handler(events.req, events.res);
      await done(events);
      expect(events.status).toBe(200);
      expect(events.body()).toContain("far away");
      expect(events.body()).toContain("event: end");
      const friction = fakeReqRes("GET", "/runs/far-1/friction");
      h.handler(friction.req, friction.res);
      await done(friction);
      expect(friction.status).toBe(200);
      expect(JSON.parse(friction.body())).toMatchObject({ id: "far-1", finished: false });
      const stop = fakeReqRes("POST", "/runs/far-1/stop?mode=soft");
      h.handler(stop.req, stop.res);
      await done(stop);
      expect(stop.status).toBe(200);
      expect(JSON.parse(stop.body())).toEqual({ id: "far-1", mode: "soft", state: "stopping" });
      expect(ledger.live.get("far-1")!.stop).toBe("soft");
    });

    it("the default view also seeds the runs live on the ledger under another generation (run-history item 41): tokenless, live, after this process's rows; still never a store call", async () => {
      const ledger = new InMemoryRunLedger(() => NOW);
      const h = harness({ ledger });
      const active = h.registry.create("active one");
      await ledger.claim({
        runId: "far-1",
        threadKey: "slack:C9:far",
        gen: "g-OTHER",
        leaseMs: 30_000,
        startedAt: NOW - 5_000,
        meta: { channelId: "slack:C9", userId: "slack:U9", threadKey: "slack:C9:far", agent: "review" },
        card: null,
        system: "sys",
        tools: [],
      });
      await ledger.append("far-1", "g-OTHER", [{ type: "input", text: "far", at: NOW - 5_000, seq: 1 }]);
      const list = vi.spyOn(h.store!, "list");
      const t = fakeReqRes("GET", "/runs");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.status).toBe(200);
      const seed = indexSeedOf(t.body());
      expect(seed.rows.map((r) => r.id)).toEqual([active.id, "far-1"]);
      expect(seed.rows[1]).toMatchObject({ finished: false, agent: "review", ownerGen: "g-OTHER", eventCount: 1 });
      expect(seed.rows[1].token).toBeUndefined(); // the page token is the other generation's
      expect(t.body()).toContain("<title>(2) Live runs</title>");
      expect(list).not.toHaveBeenCalled();
    });

    it("the default view seeds only unfinished runs and never calls the store", async () => {
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
      const seed = indexSeedOf(t.body());
      expect(seed.all).toBe(false);
      expect(seed.retentionDays).toBe(30);
      expect(seed.rows.map((r) => r.id)).toEqual([active.id]);
      expect(seed.rows[0].token).toBe(active.token); // the live row keeps its capability token
      expect(list).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });

    it("?all=1 seeds live rows with tokens and finished/persisted rows tokenless, with status and finished-at", async () => {
      const h = harness();
      await h.store!.put(record("p1"));
      await h.store!.put(
        record("p2", { status: "failed", finishedAt: NOW - 30_000, startedAt: NOW - 30_000 - 3_725_000 }),
      );
      const active = h.registry.create("active one");
      const fin = h.registry.create("finished one");
      h.registry.finish(fin.id);
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      const seed = indexSeedOf(t.body());
      expect(seed.all).toBe(true);
      const byId = new Map(seed.rows.map((r) => [r.id, r]));
      expect(byId.get(active.id)?.token).toBe(active.token);
      for (const finished of [fin.id, "p1", "p2"]) {
        const row = byId.get(finished);
        expect(row?.finished).toBe(true);
        expect(row?.token).toBeUndefined(); // a finished row never carries a token (R10)
      }
      expect(byId.get("p2")).toMatchObject({ status: "failed", finishedAt: NOW - 30_000 });
      expect(t.body()).not.toContain(fin.token);
    });

    it("the retention days ride the seed truthfully with run history off", async () => {
      const h = harness({ store: null, retention: null });
      const t = fakeReqRes("GET", "/runs");
      h.handler(t.req, t.res);
      await done(t);
      expect(indexSeedOf(t.body()).retentionDays).toBeNull();
      expect(retentionSentence(7)).toBe("Finished runs are kept for 7 days, then deleted");
      expect(retentionSentence(1)).toBe("Finished runs are kept for 1 day, then deleted");
      expect(retentionSentence(null)).toBe("Run history is off; finished runs are kept about a minute.");
    });

    it("AE9: a hostile persisted label is inert in the page and survives the seed round trip as data", async () => {
      const h = harness();
      await h.store!.put(record("p1", { label: '<script>alert(1)</script>" onmouseover="x' }));
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      expect(t.body()).not.toContain("<script>alert(1)</script>");
      const seed = indexSeedOf(t.body());
      expect(seed.rows.find((r) => r.id === "p1")?.label).toBe('<script>alert(1)</script>" onmouseover="x');
    });

    it("a persisted row's flag rides the seed; the store spy sees exactly one list call for ?all=1", async () => {
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
      const seed = indexSeedOf(t.body());
      expect(seed.rows.find((r) => r.id === run.id)).toMatchObject({
        persisted: true,
        finishedAt: NOW - 60_000,
        status: "completed",
      });
    });

    it("?all=1 seeds a visible banner when the history store is unavailable (live rows still listed); the default view never does", async () => {
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
      const seed = indexSeedOf(all.body());
      expect(seed.storeUnavailable).toBe("⚠ history store unavailable — showing live runs only");
      expect(seed.rows.some((r) => r.id === live.id)).toBe(true);
      expect(all.body()).not.toContain("store down");
      const dflt = fakeReqRes("GET", "/runs");
      h.handler(dflt.req, dflt.res);
      await done(dflt);
      expect(indexSeedOf(dflt.body()).storeUnavailable).toBeUndefined();
      warn.mockRestore();
    });

    it("?all=1 asks the service for one index page (INDEX_PAGE_SIZE), never the 50-row default", async () => {
      const h = harness();
      const list = vi.spyOn(h.service, "listRuns");
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      // `visibleTo` is the admin viewer's predicate — every channel compiles to `all`.
      expect(list).toHaveBeenCalledWith({ status: "all", visibleTo: { kind: "all" }, limit: INDEX_PAGE_SIZE });
    });

    it("a full page seeds an `olderHref` carrying the service's cursor; following it yields the next page with `olderThan`", async () => {
      const h = harness({ indexPageSize: 2 });
      await h.store!.put(record("p1", { finishedAt: NOW - 10_000 }));
      await h.store!.put(record("p2", { finishedAt: NOW - 20_000 }));
      await h.store!.put(record("p3", { finishedAt: NOW - 30_000 }));
      const first = fakeReqRes("GET", "/runs?all=1");
      h.handler(first.req, first.res);
      await done(first);
      const firstSeed = indexSeedOf(first.body());
      expect(firstSeed.rows.map((r) => r.id)).toEqual(["p1", "p2"]);
      const older = `/runs?all=1&before=${NOW - 20_000}&beforeId=p2`;
      expect(firstSeed.olderHref).toBe(older);
      expect(firstSeed.olderThan).toBeUndefined();

      const second = fakeReqRes("GET", older);
      h.handler(second.req, second.res);
      await done(second);
      expect(second.status).toBe(200);
      const secondSeed = indexSeedOf(second.body());
      expect(secondSeed.rows.map((r) => r.id)).toEqual(["p3"]);
      expect(secondSeed.olderThan).toBe(NOW - 20_000);
      expect(secondSeed.olderHref).toBeUndefined(); // a short page has no next
    });

    it("a cursor page holds finished runs only — the live rows are on the newest page (item 21)", async () => {
      const h = harness({ indexPageSize: 2 });
      const live = h.registry.create("still live");
      await h.store!.put(record("p1", { finishedAt: NOW - 10_000 }));
      await h.store!.put(record("p2", { finishedAt: NOW - 20_000 }));
      await h.store!.put(record("p3", { finishedAt: NOW - 30_000 }));
      const first = fakeReqRes("GET", "/runs?all=1");
      h.handler(first.req, first.res);
      await done(first);
      expect(indexSeedOf(first.body()).rows.some((r) => r.id === live.id)).toBe(true);
      const second = fakeReqRes("GET", `/runs?all=1&before=${NOW - 20_000}&beforeId=p2`);
      h.handler(second.req, second.res);
      await done(second);
      const seed = indexSeedOf(second.body());
      expect(seed.rows.map((r) => r.id)).toEqual(["p3"]);
      expect(seed.rows.some((r) => r.id === live.id)).toBe(false);
    });

    it("a short page has no older link; a malformed cursor is ignored (first page)", async () => {
      const h = harness({ indexPageSize: 2 });
      await h.store!.put(record("p1"));
      const t = fakeReqRes("GET", "/runs?all=1");
      h.handler(t.req, t.res);
      await done(t);
      expect(indexSeedOf(t.body()).olderHref).toBeUndefined();
      const bad = fakeReqRes("GET", "/runs?all=1&before=abc&beforeId=p1");
      h.handler(bad.req, bad.res);
      await done(bad);
      expect(bad.status).toBe(200);
      expect(indexSeedOf(bad.body()).rows.map((r) => r.id)).toEqual(["p1"]);
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

  // Feature: features/authorization.md items 5–7 on the HTML surface (#428).
  // The viewer is the Access identity's actor (index.ts resolves it with the
  // same `accessActor` /api/* uses): the index lists through the actor's
  // predicate, and a tokenless read of a finished run is `authorize`d against
  // the run's own attributes — a deny is the same 404 as an unknown id (KTD8).
  describe("the viewer's actor binds the index and the tokenless history routes (authorization.md items 5–7, #428)", () => {
    // Grants as config resolves them for the Access surface: alice is an
    // unlisted browser session (every group's read, no channel grants), bob is
    // granted the private channel natively, the admin holds everything.
    const SOURCE: GrantsSource = {
      grants: new Map([
        [
          "access:bob",
          { actions: new Set(["runs:read"]), channels: new Set(["slack:G_PRIV"]), repos: new Set<string>() },
        ],
        ["access:admin", ALL_GRANTS],
      ]),
      commandGroups: ["runs"],
    };
    const viewer = (sub: string): LiveViewContext => ({ actor: accessActor({ sub }, (id) => grantsFor(id, SOURCE)) });
    const alice = viewer("alice");
    const bob = viewer("bob");
    const admin = viewer("admin");
    /** A viewer config names nothing for — not even the browser read baseline (R7's `NO_GRANTS`). */
    const nobody: LiveViewContext = { actor: accessActor({ sub: "nobody" }, () => NO_GRANTS) };
    const PUBLIC = { channelId: "slack:C_PUB", channelVisibility: "public" } as const;
    const PRIVATE = { channelId: "slack:G_PRIV", channelVisibility: "private" } as const;
    const meta = (channel: typeof PUBLIC | typeof PRIVATE, threadKey: string) => ({
      ...channel,
      userId: "slack:U1",
      threadKey,
    });

    async function index(h: ReturnType<typeof harness>, url: string, ctx: LiveViewContext) {
      const t = fakeReqRes("GET", url);
      h.handler(t.req, t.res, ctx);
      await done(t);
      expect(t.status).toBe(200);
      return {
        ids: indexSeedOf(t.body())
          .rows.map((r) => r.id)
          .sort(),
        body: t.body(),
      };
    }
    async function request(h: ReturnType<typeof harness>, url: string, ctx: LiveViewContext, method = "GET") {
      const t = fakeReqRes(method, url);
      h.handler(t.req, t.res, ctx);
      await done(t);
      return t;
    }

    it("`/runs?all=1` lists an unlisted browser session only the public runs, a native channel grant adds that channel, the admin lists the fleet — the actor's predicate rides down to the service, never a filter after loading", async () => {
      const h = harness();
      await h.store!.put(record("pub", PUBLIC));
      await h.store!.put(record("priv", PRIVATE));
      await h.store!.put(record("unk")); // stamped `unknown` — never public (R7)
      const list = vi.spyOn(h.service, "listRuns");
      expect((await index(h, "/runs?all=1", alice)).ids).toEqual(["pub"]);
      expect((await index(h, "/runs?all=1", bob)).ids).toEqual(["priv", "pub"]);
      expect((await index(h, "/runs?all=1", admin)).ids).toEqual(["priv", "pub", "unk"]);
      expect(list.mock.calls.map(([opts]) => opts.visibleTo)).toEqual(
        [alice, bob, admin].map((v) => predicateFor(v.actor, "runs:read", "run")),
      );
    });

    it("the default `/runs` and its `?stream=1` feed carry only the live runs the viewer may read: a hidden run's row, token, upserts and eviction never reach the page", async () => {
      const h = harness();
      const pub = h.registry.create("public one", meta(PUBLIC, "t1"));
      const priv = h.registry.create("private one", meta(PRIVATE, "t2"));
      const dflt = await index(h, "/runs", alice);
      expect(dflt.ids).toEqual([pub.id]);
      expect(dflt.body).toContain(pub.token);
      expect(dflt.body).not.toContain(priv.token);
      expect((await index(h, "/runs", admin)).ids).toEqual([priv.id, pub.id].sort());

      const feed = fakeReqRes("GET", "/runs?stream=1");
      h.handler(feed.req, feed.res, alice);
      expect(feed.status).toBe(200);
      expect(feed.body()).toContain(`"id":"${pub.id}"`);
      expect(feed.body()).not.toContain(`"id":"${priv.id}"`); // the replay on connect is filtered too
      h.registry.publish(priv.id, call("private step"));
      h.registry.publish(pub.id, call("public step"));
      expect(feed.body()).toContain("public step");
      expect(feed.body()).not.toContain("private step");
      // Eviction: the hidden run's `removed` never names its id; the visible run's arrives.
      h.registry.finish(priv.id);
      h.registry.finish(pub.id);
      h.registry.seal(priv.id);
      h.registry.seal(pub.id); // the TTL runs from the seal
      h.tick(120_000);
      h.registry.create("sweeper", meta(PUBLIC, "t3")); // create() sweeps the TTL-expired runs
      const removed = [...feed.body().matchAll(/"type":"removed","id":"([^"]+)"/g)].map((m) => m[1]);
      expect(removed).toEqual([pub.id]);
      expect(feed.body()).not.toContain(`"${priv.id}"`);
      feed.fireClose();
    });

    it("a tokenless finished run the viewer may not read is the same 404 as an unknown id — the page byte-identical, events and friction the text body, the stop's 409 a 404 — with the reason on the audit line and never in the reply (KTD8)", async () => {
      const audit = vi.fn();
      const h = harness({ audit });
      await h.store!.put(record("priv", PRIVATE));
      const denied = await request(h, "/runs/priv", alice);
      const unknown = await request(h, "/runs/nope", alice);
      expect(denied.status).toBe(404);
      expect(denied.body()).toBe(unknown.body()); // byte-identical: existence never revealed
      expect(seedOf(denied.body())).toEqual({ page: "runNotFound", retentionDays: 30, capabilities: ALL_CAPABILITIES });
      for (const url of ["/runs/priv/events", "/runs/priv/friction"]) {
        const t = await request(h, url, alice);
        expect([url, t.status, t.body()]).toEqual([url, 404, "run not found"]);
      }
      const stop = await request(h, "/runs/priv/stop?mode=soft", alice, "POST");
      expect([stop.status, stop.body()]).toEqual([404, "run not found"]);
      // Who, which route, why — never the run id, never in the reply.
      // The read routes deny on the run's attributes (alice is not a member); the
      // stop denies one question earlier — an unlisted session holds no `runs:write`.
      expect(audit.mock.calls.map(([e]) => e)).toEqual([
        ...["page", "events", "friction"].map((route) => ({ route, identity: "access:alice", denied: "not-member" })),
        { route: "stop", identity: "access:alice", denied: "missing-grant" },
      ]);
      expect(denied.body()).not.toContain("not-member");
      // A native member and the admin read it; the admin's tokenless stop is the 409 a finished run gives.
      expect((await request(h, "/runs/priv", bob)).status).toBe(200);
      expect((await request(h, "/runs/priv", admin)).status).toBe(200);
      expect((await request(h, "/runs/priv/stop?mode=soft", admin, "POST")).status).toBe(409);
      // The tokenless stop is a WRITE (`runs.stop` on the command surface asks
      // `runs:write`): bob may read the run but not stop it — the same 404, with
      // the missing grant on the audit line.
      expect((await request(h, "/runs/priv/stop?mode=soft", bob, "POST")).status).toBe(404);
      expect(audit.mock.calls.slice(4).map(([e]) => e)).toEqual([
        { route: "page", runId: "priv", identity: "access:bob" },
        { route: "page", runId: "priv", identity: "access:admin" },
        { route: "stop", identity: "access:bob", denied: "missing-grant" },
      ]);
    });

    it("a viewer without the `runs:read` grant at all — what `/api/runs.*` refuses outright — sees an empty index and a 404 on every tokenless route even for a PUBLIC run; a capability token still opens the live page, stream and stop (the token IS the capability)", async () => {
      const audit = vi.fn();
      const h = harness({ audit });
      await h.store!.put(record("pub", PUBLIC));
      const live = h.registry.create("public live", meta(PUBLIC, "t9"));
      h.registry.publish(live.id, call("$ npm test"));
      expect((await index(h, "/runs", nobody)).ids).toEqual([]);
      expect((await index(h, "/runs?all=1", nobody)).ids).toEqual([]);
      expect((await request(h, "/runs/pub", nobody)).status).toBe(404);
      expect((await request(h, "/runs/pub/events", nobody)).status).toBe(404);
      expect(audit.mock.calls.map(([e]) => e)).toEqual(
        ["page", "events"].map((route) => ({ route, identity: "access:nobody", denied: "missing-grant" })),
      );

      const page = await request(h, `/runs/${live.id}?t=${live.token}`, nobody);
      expect(page.status).toBe(200);
      expect(page.body()).toBe((await request(h, `/runs/${live.id}?t=${live.token}`, admin)).body());
      expect(runSeedOf(page.body())).toMatchObject({
        mode: "live",
        eventsUrl: `/runs/${live.id}/events?t=${live.token}`,
      });
      expect((await request(h, `/runs/${live.id}/friction?t=${live.token}`, nobody)).status).toBe(200);
      const stream = fakeReqRes("GET", `/runs/${live.id}/events?t=${live.token}`);
      h.handler(stream.req, stream.res, nobody);
      expect(stream.status).toBe(200);
      expect(stream.body()).toContain("$ npm test");
      stream.fireClose();
      expect((await request(h, `/runs/${live.id}/stop?t=${live.token}&mode=soft`, nobody, "POST")).status).toBe(200);
    });
  });
});

// The IndexRow alias re-exported here is the seed row shape — one type across
// the handler, the seed, and the web app's row model.
describe("IndexRow seed shape", () => {
  it("accepts a live registry summary (with token) and a store view (without)", () => {
    const live: IndexRow = {
      id: "a",
      token: "t",
      finished: false,
      startedAt: 1,
      eventCount: 0,
    } satisfies Partial<RunSummary> as IndexRow;
    const stored: IndexRow = {
      id: "b",
      finished: true,
      startedAt: 1,
      finishedAt: 2,
      status: "completed",
      eventCount: 3,
    };
    expect(live.token).toBe("t");
    expect(stored.token).toBeUndefined();
  });
});
