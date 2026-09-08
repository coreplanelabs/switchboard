// Feature: docs/reference/specs/tracing.md item 26 — the in-process span log an operator's bearer reads.
import { describe, expect, it } from "vitest";
import { createTickingClock } from "../testing/tickingClock.js";
import { createSpanLog, SPAN_LOG_PAGE_DEFAULT, SPAN_LOG_PAGE_MAX } from "./spanLog.js";
import { createTracer } from "./tracer.js";

function traced(log: ReturnType<typeof createSpanLog>) {
  const clock = createTickingClock(1_000);
  const tracer = createTracer({ clock: clock.now });
  return { clock, root: tracer.start("request", { sinks: [log.sink], attrs: { channel: "slack" } }), tracer };
}

describe("createSpanLog", () => {
  it("keeps every span end as the log sink's line plus endedAt, at any level, oldest first; the request root joins when it ends", async () => {
    const log = createSpanLog();
    const { clock, root } = traced(log);
    await root.span("dispatch.history", () => clock.tick(200));
    await root.span("github.rest", () => clock.tick(50), {
      attrs: { host: "api.github.com", route: "contents", method: "GET" },
    });
    expect(log.read().lines.map((l) => l.span)).toEqual(["dispatch.history", "github.rest"]);
    root.end("ok");
    const page = log.read();
    expect(page.lines.map((l) => [l.span, l.ms, l.endedAt])).toEqual([
      ["dispatch.history", 200, 1_200],
      ["github.rest", 50, 1_250],
      ["request", 250, 1_250],
    ]);
    expect(page.lines[1]).toMatchObject({ traceId: root.traceId, parentSpanId: root.id, attrs: { route: "contents" } });
    expect(page).toMatchObject({ matched: 3, kept: 3, dropped: 0, oldestAt: 1_200 });
    for (const line of page.lines)
      for (const k of ["text", "summary", "output", "authorization"]) expect(line).not.toHaveProperty(k);
  });

  it("filters by trace id, by span name or family, and by end time; the newest `limit` of what matched, capped", async () => {
    const log = createSpanLog();
    const a = traced(log);
    const b = traced(log);
    for (let i = 0; i < 3; i++) await a.root.span("github.rest", () => a.clock.tick(10));
    await a.root.span("github.token_mint", () => a.clock.tick(10));
    await b.root.span("http.client", () => b.clock.tick(10));
    expect(log.read({ traceId: b.root.traceId }).lines.map((l) => l.span)).toEqual(["http.client"]);
    expect(log.read({ span: "github" }).matched).toBe(4);
    expect(log.read({ span: "github.rest" }).matched).toBe(3);
    expect(log.read({ span: "github.res" }).matched).toBe(0);
    expect(log.read({ sinceMs: 1_030 }).lines.map((l) => [l.span, l.endedAt])).toEqual([
      ["github.rest", 1_030],
      ["github.token_mint", 1_040],
    ]);
    const page = log.read({ span: "github.rest", limit: 2 });
    expect(page.lines.map((l) => l.endedAt)).toEqual([1_020, 1_030]);
    expect(page.matched).toBe(3);
    expect(log.read({ limit: 0 }).lines).toHaveLength(1);
    expect(log.read({ limit: SPAN_LOG_PAGE_MAX * 10 }).lines.length).toBeLessThanOrEqual(SPAN_LOG_PAGE_MAX);
    expect(SPAN_LOG_PAGE_DEFAULT).toBeLessThan(SPAN_LOG_PAGE_MAX);
  });

  it("is bounded by lines and by bytes: the oldest go first and the reader is told how many did", async () => {
    const byLines = createSpanLog({ maxLines: 3 });
    const { clock, root } = traced(byLines);
    for (let i = 0; i < 5; i++) await root.span("dispatch.history", () => clock.tick(1));
    expect(byLines.read()).toMatchObject({ kept: 3, dropped: 2, oldestAt: 1_003 });
    const byBytes = createSpanLog({ maxBytes: 300 });
    const t = traced(byBytes);
    for (let i = 0; i < 5; i++) await t.root.span("dispatch.history", () => t.clock.tick(1));
    const page = byBytes.read();
    expect(page.kept).toBeLessThan(5);
    expect(page.dropped).toBe(5 - page.kept);
    expect(createSpanLog().read()).toEqual({ lines: [], matched: 0, kept: 0, dropped: 0 });
  });
});
