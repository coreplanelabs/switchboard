// Feature: docs/reference/specs/tracing.md item 26 — the span log behind an ingress bearer with trace:read.
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Secret } from "../secrets.js";
import { handleAdminTraceLog, parseTraceLogQuery, TRACE_LOG_PATH } from "./adminTraceLog.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { createSpanLog } from "../core/trace/spanLog.js";
import { createTracer } from "../core/trace/tracer.js";

const TOKENS = new Secret(
  JSON.stringify({ "tok-tracer": { subject: "tracer" }, "tok-deployer": { subject: "ops" } }),
  "SWITCHBOARD_INGRESS_TOKENS",
);
const GRANTS: Record<string, Grants> = {
  "http:tracer": { actions: new Set(["trace:read"]), channels: new Set(), repos: new Set() },
  "http:ops": { actions: new Set(["deploy:write"]), channels: new Set(), repos: new Set() },
};

function request(method: string, url: string, authorization?: string) {
  const writes: { status?: number; body?: string } = {};
  const req = { method, url, headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
  const res = {
    writeHead: (status: number) => void (writes.status = status),
    end: (body: string) => void (writes.body = body),
  } as unknown as ServerResponse;
  return { req, res, body: () => JSON.parse(writes.body ?? "null") as Record<string, unknown>, writes };
}

function harness(over: { tokens?: Secret | undefined } = {}) {
  const spanLog = createSpanLog();
  const logs: string[] = [];
  const deps = {
    tokens: "tokens" in over ? over.tokens : TOKENS,
    grantsFor: (id: string) => GRANTS[id] ?? NO_GRANTS,
    spanLog,
    log: (l: string) => void logs.push(l),
  };
  let t = 1_000;
  const tracer = createTracer({ clock: () => t });
  const root = tracer.start("request", { sinks: [spanLog.sink], attrs: { channel: "slack" } });
  const child = root.start("github.rest", { attrs: { host: "api.github.com", route: "contents", method: "GET" } });
  t = 1_050;
  child.end("ok", { httpStatus: 200 });
  t = 1_300;
  root.end("ok");
  return { deps, logs, root };
}

describe(`GET ${TRACE_LOG_PATH}`, () => {
  it("a trace:read bearer reads the log: the lines as the sink prints them plus endedAt, the counts, oldestAt; the filters apply", () => {
    const { deps, root } = harness();
    const all = request("GET", TRACE_LOG_PATH, "Bearer tok-tracer");
    handleAdminTraceLog(all.req, all.res, deps);
    expect(all.writes.status).toBe(200);
    expect(all.body()).toMatchObject({ ok: true, matched: 2, kept: 2, dropped: 0, oldestAt: 1_050 });
    const lines = all.body().lines as Array<Record<string, unknown>>;
    expect(lines.map((l) => l.span)).toEqual(["github.rest", "request"]);
    expect(lines[0]).toEqual({
      span: "github.rest",
      traceId: root.traceId,
      spanId: expect.any(String),
      parentSpanId: root.id,
      startedAt: 1_000,
      ms: 50,
      status: "ok",
      attrs: { host: "api.github.com", route: "contents", method: "GET", httpStatus: 200 },
      endedAt: 1_050,
    });
    const filtered = request(
      "GET",
      `${TRACE_LOG_PATH}?span=github&since=1000&traceId=${root.traceId}&limit=1`,
      "Bearer tok-tracer",
    );
    handleAdminTraceLog(filtered.req, filtered.res, deps);
    expect((filtered.body().lines as unknown[]).length).toBe(1);
    expect(filtered.body()).toMatchObject({ matched: 1 });
  });

  it("no bearer → 401, a bearer without trace:read → 403, no token map → 503, a non-GET → 405, a malformed query → 400; nothing is read", () => {
    const { deps, logs } = harness();
    const cases: Array<[string, string | undefined, number]> = [
      ["GET", undefined, 401],
      ["GET", "Bearer nope", 401],
      ["GET", "Bearer tok-deployer", 403],
      ["POST", "Bearer tok-tracer", 405],
    ];
    for (const [method, auth, status] of cases) {
      const r = request(method, TRACE_LOG_PATH, auth);
      handleAdminTraceLog(r.req, r.res, deps);
      expect(r.writes.status).toBe(status);
      expect(r.body()).toMatchObject({ ok: false });
      expect(r.body()).not.toHaveProperty("lines");
    }
    expect(logs.filter((l) => l.startsWith("[admin/trace-log] 40"))).toHaveLength(3);
    for (const bad of ["since=yesterday", "traceId=abc", "span=Bad%20Name", "limit=0", "limit=1.5"]) {
      const r = request("GET", `${TRACE_LOG_PATH}?${bad}`, "Bearer tok-tracer");
      handleAdminTraceLog(r.req, r.res, deps);
      expect(r.writes.status).toBe(400);
    }
    const noMap = harness({ tokens: undefined });
    const r = request("GET", TRACE_LOG_PATH, "Bearer tok-tracer");
    handleAdminTraceLog(r.req, r.res, noMap.deps);
    expect(r.writes.status).toBe(503);
    expect(String(r.body().error)).toContain("trace log disabled");
  });

  it("parseTraceLogQuery: every field optional, each refused when malformed rather than ignored", () => {
    expect(parseTraceLogQuery(new URLSearchParams(""))).toEqual({ ok: true, query: {} });
    expect(parseTraceLogQuery(new URLSearchParams("since=5&limit=20&span=http.client"))).toEqual({
      ok: true,
      query: { sinceMs: 5, limit: 20, span: "http.client" },
    });
    expect(parseTraceLogQuery(new URLSearchParams("since=-1"))).toMatchObject({ ok: false });
    expect(parseTraceLogQuery(new URLSearchParams("traceId=ZZ"))).toMatchObject({ ok: false });
  });
});
