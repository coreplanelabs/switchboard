// Feature: features/tracing.md item 22 — the Workers' side of trace context:
// the edge strips, an internal Worker adopts after auth, routes are words from a
// closed table, refusals leave no line.
import { describe, expect, it } from "vitest";
import { recordingSink } from "../testing/recordingSink.js";
import { logLineOf } from "./sinks.js";
import { parseTraceparent } from "./traceparent.js";
import { createTracer } from "./tracer.js";
import {
  adoptedParent,
  refusalFilter,
  shimRoute,
  startAdoptedRoot,
  stripTraceContext,
  withTraceContext,
  workerLogSink,
} from "./workerTrace.js";

/** The W3C Trace Context specification's own example trace id and parent span id. */
const W3C_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const W3C_SPAN = "00f067aa0ba902b7";
const TP = `00-${W3C_TRACE}-${W3C_SPAN}-01`;

describe("adoptedParent", () => {
  it("names the trace and parent of a well-formed traceparent and nothing for an absent or malformed one", () => {
    expect(adoptedParent(TP)).toEqual({ traceId: W3C_TRACE, parentId: W3C_SPAN });
    expect(adoptedParent(null)).toBeUndefined();
    expect(adoptedParent("00-0000-nope")).toBeUndefined();
  });
});

describe("stripTraceContext / withTraceContext", () => {
  it("strips traceparent, tracestate and baggage and keeps every other header, the method and the body; withTraceContext sets the span's own", async () => {
    const req = new Request("https://bot.example/ingress?x=1", {
      method: "POST",
      headers: {
        traceparent: TP,
        tracestate: "vendor=1",
        baggage: "k=v",
        authorization: "Bearer tok",
        "content-type": "application/json",
      },
      body: '{"text":"hi"}',
    });
    const stripped = stripTraceContext(req);
    expect(stripped.headers.has("traceparent")).toBe(false);
    expect(stripped.headers.has("tracestate")).toBe(false);
    expect(stripped.headers.has("baggage")).toBe(false);
    expect(stripped.headers.get("authorization")).toBe("Bearer tok");
    expect(stripped.method).toBe("POST");
    expect(stripped.url).toBe("https://bot.example/ingress?x=1");
    expect(await stripped.text()).toBe('{"text":"hi"}');
    const root = createTracer({ clock: () => 1_000 }).start("bot-shim.fetch", { sinks: [] });
    const onward = withTraceContext(new Request("https://container/ingress", { method: "POST", body: "{}" }), root);
    expect(parseTraceparent(onward.headers.get("traceparent"))).toEqual({
      traceId: root.traceId,
      parentId: root.id,
      sampled: true,
    });
  });
});

describe("shimRoute", () => {
  it("maps every path to a closed-table word, and gives static assets, the favicon and the live view's SSE stream no root at all", () => {
    expect(shimRoute("/healthz")).toBe("healthz");
    expect(shimRoute("/ingress")).toBe("ingress");
    expect(shimRoute("/mcp")).toBe("mcp");
    expect(shimRoute("/mcp/connect/abc")).toBe("mcp");
    expect(shimRoute("/runs")).toBe("runs");
    expect(shimRoute("/runs/abc")).toBe("runs"); // never the id, never `?t=SECRET` (a pathname has no query)
    expect(shimRoute("/runs/abc/events")).toBeUndefined(); // SSE
    expect(shimRoute("/residents/acme/web")).toBe("residents");
    expect(shimRoute("/costs")).toBe("costs");
    expect(shimRoute("/api/runs")).toBe("api");
    expect(shimRoute("/admin/restart")).toBe("admin");
    expect(shimRoute("/docs")).toBe("docs");
    expect(shimRoute("/")).toBe("page");
    expect(shimRoute("/assets/index-abc.js")).toBeUndefined();
    expect(shimRoute("/favicon.ico")).toBeUndefined();
    expect(shimRoute("/whatever/else")).toBe("other");
  });
});

describe("refusalFilter / workerLogSink", () => {
  it("drops a root that ended 401 or 403 and passes every other record through; the worker sink is slow-level with the filter on", () => {
    const inner = recordingSink();
    const filtered = refusalFilter(inner);
    const tracer = createTracer({ clock: () => 1_000 });
    tracer.start("state.fetch", { sinks: [filtered] }).end("ok", { httpStatus: 401 });
    tracer.start("state.fetch", { sinks: [filtered] }).end("ok", { httpStatus: 403 });
    tracer.start("state.fetch", { sinks: [filtered] }).end("ok", { httpStatus: 200 });
    tracer.start("state.fetch", { sinks: [filtered] }).end("error", { httpStatus: 500 });
    expect(inner.ends.map((e) => e.attrs.httpStatus)).toEqual([200, 500]);
    const lines: string[] = [];
    const sink = workerLogSink((l) => lines.push(l));
    let t = 0;
    const slow = createTracer({ clock: () => (t += 2_000) });
    const root = slow.start("resident.attach", { sinks: [sink] });
    root.start("resident.clone").end("ok");
    root.end("ok", { httpStatus: 200 });
    const refused = slow.start("resident.fetch", { sinks: [sink] });
    refused.end("ok", { httpStatus: 401 });
    expect(lines.map((l) => (JSON.parse(l) as ReturnType<typeof logLineOf>).span)).toEqual([
      "resident.clone",
      "resident.attach",
    ]);
  });
});

describe("startAdoptedRoot", () => {
  it("joins the caller's trace as a child of the named span when traceparent parses, and mints its own trace when it is absent or malformed", () => {
    const log = recordingSink();
    const tracer = createTracer({ clock: () => 1_000 });
    const adopted = startAdoptedRoot(tracer, "state.fetch", {
      sinks: [log],
      traceparent: TP,
      startedAt: 900,
      attrs: { route: "/runs/put" },
    });
    expect(adopted.traceId).toBe(W3C_TRACE);
    expect(adopted.record()).toMatchObject({
      parentSpanId: W3C_SPAN,
      startedAt: 900,
      attrs: { route: "/runs/put" },
    });
    adopted.end("ok");
    expect(log.ends[0]!.traceId).toBe(W3C_TRACE);
    const own = startAdoptedRoot(tracer, "sandbox.exec", { sinks: [log], traceparent: "garbage" });
    expect(own.traceId).not.toBe(W3C_TRACE);
    expect(own.record().parentSpanId).toBeUndefined();
    const none = startAdoptedRoot(tracer, "sandbox.exec", { sinks: [log] });
    expect(none.record().parentSpanId).toBeUndefined();
  });
});
