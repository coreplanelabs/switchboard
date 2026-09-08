// Feature: docs/reference/specs/tracing.md — the log sink's line shape and verbosity.
import { describe, expect, it } from "vitest";
import { createTickingClock } from "../testing/tickingClock.js";
import { classifyError } from "./classify.js";
import { createLogSink, logLineOf, NULL_SINK } from "./sinks.js";
import { createTracer } from "./tracer.js";

/** The W3C Trace Context specification's own example trace id and parent span id. */
const W3C_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const W3C_SPAN = "00f067aa0ba902b7";

function run(level: "roots" | "slow") {
  const clock = createTickingClock(5_000_000);
  const lines: string[] = [];
  const sink = createLogSink({ level, write: (l) => lines.push(l) });
  const tracer = createTracer({ clock: clock.now });
  const root = tracer.start("request", { sinks: [sink], attrs: { channel: "http" } });
  return { clock, lines, root };
}

describe("createLogSink", () => {
  it("`roots` prints the root only; `slow` adds every span of 1 s or more", async () => {
    for (const level of ["roots", "slow"] as const) {
      const { clock, lines, root } = run(level);
      await root.span("dispatch.history", () => clock.tick(200));
      await root.span("dispatch.compose", () => clock.tick(1500));
      root.end();
      const names = lines.map((l) => (JSON.parse(l) as { span: string }).span);
      expect(names).toEqual(level === "roots" ? ["request"] : ["dispatch.compose", "request"]);
    }
  });

  it("a root that adopted a remote parent — a Worker continuing the bot's trace — prints as a root at both levels, its children still by the level; the line keeps its shape", async () => {
    for (const level of ["roots", "slow"] as const) {
      const clock = createTickingClock(1_000);
      const lines: string[] = [];
      const tracer = createTracer({ clock: clock.now });
      const root = tracer.start("state.fetch", {
        sinks: [createLogSink({ level, write: (l) => lines.push(l) })],
        parent: { traceId: W3C_TRACE, parentId: W3C_SPAN },
        attrs: { route: "/retrieve" },
      });
      await root.span("state.put", () => clock.tick(50));
      clock.tick(100);
      root.end("ok", { httpStatus: 200 });
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(parsed.map((l) => l.span)).toEqual(["state.fetch"]);
      expect(parsed[0]).toMatchObject({
        traceId: W3C_TRACE,
        parentSpanId: W3C_SPAN,
        ms: 150,
        attrs: { route: "/retrieve", httpStatus: 200 },
      });
      expect(parsed[0]).not.toHaveProperty("adopted");
    }
  });

  it("the line carries exactly the documented fields and never text, summary or output", async () => {
    const { clock, lines, root } = run("slow");
    await root
      .span("github.rest", () => {
        clock.tick(2000);
        throw classifyError(new Error("body with GITHUB_TOKEN=ghp_x"), { kind: "http", code: "502" });
      })
      .catch(() => {});
    root.end();
    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(
      [
        "attrs",
        "errorCode",
        "errorKind",
        "ms",
        "parentSpanId",
        "span",
        "spanId",
        "startedAt",
        "status",
        "traceId",
      ].sort(),
    );
    expect(line).toMatchObject({ span: "github.rest", ms: 2000, status: "error", errorKind: "http", errorCode: "502" });
    expect(line.errorMessage).toBeUndefined();
    expect(JSON.stringify(line)).not.toMatch(/"(text|summary|output)"/);
    expect(JSON.stringify(line)).not.toContain("ghp_");
  });

  it("logLineOf drops undefined attrs and the null sink observes nothing", () => {
    const line = logLineOf({
      traceId: "t",
      spanId: "s",
      name: "request",
      startedAt: 1,
      durationMs: 2,
      status: "ok",
      attrs: { channel: "cli", count: undefined },
    });
    expect(line.attrs).toEqual({ channel: "cli" });
    expect(line.parentSpanId).toBeUndefined();
    expect(() => NULL_SINK.onEnd(line as never)).not.toThrow();
  });
});
