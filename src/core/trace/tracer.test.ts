// Feature: features/tracing.md — the primitive's pinned semantics.
import { describe, expect, it } from "vitest";
import { recordingSink } from "../testing/recordingSink.js";
import { createAlsContext, createTickingClock } from "../testing/tickingClock.js";
import { classifyError } from "./classify.js";
import { createTracer, ERROR_MESSAGE_CAP, sanitizeSpanName, SPAN_NAME_MAX } from "./tracer.js";

function setup() {
  const clock = createTickingClock(1_000_000);
  const sink = recordingSink();
  const warnings: string[] = [];
  const tracer = createTracer({ clock: clock.now, warn: (m) => warnings.push(m) });
  const root = tracer.start("request", { sinks: [sink], attrs: { channel: "slack" } });
  return { clock, sink, tracer, root, warnings };
}

describe("createTracer", () => {
  // Feature: features/tracing.md item 22 — a Worker's root joins the bot's trace.
  it("a root started with a remote parent carries that trace id and parent span id; without one it mints its own", () => {
    const log = recordingSink();
    const tracer = createTracer({ clock: () => 1_000 });
    const adopted = tracer.start("state.fetch", {
      sinks: [log],
      parent: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentId: "00f067aa0ba902b7" },
    });
    expect(adopted.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(adopted.record().parentSpanId).toBe("00f067aa0ba902b7");
    expect(adopted.record().adopted).toBe(true);
    const child = adopted.start("state.put");
    expect(child.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(child.record().parentSpanId).toBe(adopted.id);
    expect(child.record().adopted).toBeUndefined();
    adopted.end("ok");
    expect(log.ends.at(-1)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
    });
    const own = tracer.start("request", { sinks: [log] });
    expect(own.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(own.record().parentSpanId).toBeUndefined();
    expect(own.record().adopted).toBeUndefined();
  });

  it("span(fn) invokes fn synchronously, ends ok on return with the measured duration, and nests under its parent", async () => {
    const { clock, sink, root } = setup();
    let ranSynchronously = false;
    const p = root.span("dispatch.history", async (s) => {
      ranSynchronously = true;
      expect(s.parentId).toBe(root.id);
      clock.tick(250);
      return 42;
    });
    expect(ranSynchronously).toBe(true);
    expect(await p).toBe(42);
    const rec = sink.ended("dispatch.history");
    expect(rec).toMatchObject({ status: "ok", durationMs: 250, parentSpanId: root.id, traceId: root.traceId });
    expect(sink.starts.map((s) => s.name)).toEqual(["request", "dispatch.history"]);
  });

  it("a throwing fn ends the span as error and rethrows; an unclassified message is redacted and capped", async () => {
    const { sink, root } = setup();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await expect(
      root.span("dispatch.compose", () => {
        throw new Error(`prompt failed ${secret} ${"x".repeat(400)}`);
      }),
    ).rejects.toThrow(/prompt failed/);
    const rec = sink.ended("dispatch.compose");
    expect(rec?.status).toBe("error");
    expect(rec?.errorMessage).not.toContain(secret);
    expect(rec?.errorMessage?.length).toBeLessThanOrEqual(ERROR_MESSAGE_CAP + 1);
    expect(rec?.errorKind).toBeUndefined();
  });

  it("a classified error records kind and code and no message, at any depth through `cause`", async () => {
    const { sink, root } = setup();
    const inner = classifyError(new Error("upstream said GITHUB_TOKEN=ghp_x"), { kind: "http", code: "503" });
    const outer = new Error("wrapped", { cause: inner });
    await expect(
      root.span("github.rest", () => {
        throw outer;
      }),
    ).rejects.toBe(outer);
    const rec = sink.ended("github.rest");
    expect(rec).toMatchObject({ status: "error", errorKind: "http", errorCode: "503" });
    expect(rec?.errorMessage).toBeUndefined();
  });

  it("end() is idempotent and a handle can be ended explicitly with attrs", () => {
    const { clock, sink, root } = setup();
    const h = root.start("run.agent");
    clock.tick(10);
    h.end("ok", { count: 3 });
    clock.tick(10);
    h.end("error");
    expect(sink.ends.filter((e) => e.name === "run.agent")).toHaveLength(1);
    expect(sink.ended("run.agent")).toMatchObject({ durationMs: 10, status: "ok", attrs: { count: 3 } });
    expect(h.ended).toBe(true);
  });

  it("startedAt may backdate a span; a child started after its parent ended is recorded with true times", () => {
    const { clock, sink, root } = setup();
    const backdated = root.start("dispatch.workspace.attach.install", { startedAt: 999_000 });
    backdated.end();
    expect(sink.ended("dispatch.workspace.attach.install")).toMatchObject({ startedAt: 999_000, durationMs: 1000 });
    root.end();
    clock.tick(5000);
    const late = root.start("post.history_write");
    late.end();
    expect(sink.ended("post.history_write")).toMatchObject({ startedAt: 1_005_000, parentSpanId: root.id });
  });

  it("graft records a child with both stamps supplied: start then end reach the sinks at once, the duration is theirs, a classification rides without a message, and an end before the start reads as zero", () => {
    const clock = createTickingClock(50_000);
    const log = recordingSink();
    const root = createTracer({ clock: clock.now }).start("request", { sinks: [log] });
    const rec = root.graft("dispatch.workspace.attach.install", {
      startedAt: 10_000,
      endedAt: 22_500,
      attrs: { backend: "resident", exitCode: 0 },
    });
    expect(rec).toMatchObject({
      name: "dispatch.workspace.attach.install",
      parentSpanId: root.id,
      startedAt: 10_000,
      endedAt: 22_500,
      durationMs: 12_500,
      status: "ok",
      attrs: { backend: "resident", exitCode: 0 },
    });
    expect(log.starts.map((s) => s.name)).toEqual(["request", "dispatch.workspace.attach.install"]);
    expect(log.ends.map((s) => [s.name, s.durationMs])).toEqual([["dispatch.workspace.attach.install", 12_500]]);
    const failed = root.graft("dispatch.workspace.attach.clone", {
      startedAt: 30_000,
      endedAt: 29_000,
      status: "error",
      errorKind: "infra",
      errorCode: "attach",
    });
    expect(failed).toMatchObject({
      durationMs: 0,
      endedAt: 30_000,
      status: "error",
      errorKind: "infra",
      errorCode: "attach",
    });
    expect(failed.errorMessage).toBeUndefined();
    expect(clock.now()).toBe(50_000); // the clock was never read for a graft
  });

  it("a throwing sink never reaches traced code; the tracer reports it once per call", async () => {
    const clock = createTickingClock();
    const warnings: string[] = [];
    const tracer = createTracer({ clock: clock.now, warn: (m) => warnings.push(m) });
    const bad = {
      onStart: () => {
        throw new Error("sink boom");
      },
      onEnd: () => {
        throw new Error("sink boom");
      },
    };
    const root = tracer.start("request", { sinks: [bad] });
    await expect(root.span("dispatch.history", () => "fine")).resolves.toBe("fine");
    root.end();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.includes("sink"))).toBe(true);
  });

  it("the record is a copy: mutating it does not change the span; attrs merge", () => {
    const { sink, root } = setup();
    root.setAttrs({ status: "completed" });
    const rec = root.record();
    (rec.attrs as Record<string, unknown>).status = "failed";
    expect(root.record().attrs).toEqual({ channel: "slack", status: "completed" });
    root.end();
    expect(sink.ended("request")?.attrs).toEqual({ channel: "slack", status: "completed" });
  });

  it("the test context propagates the current span through awaits; a bare await under the root sees none", async () => {
    const clock = createTickingClock();
    const als = createAlsContext();
    const tracer = createTracer({ clock: clock.now, context: als.context });
    const root = tracer.start("request", { sinks: [] });
    expect(als.current()).toBeUndefined();
    await root.span("dispatch.history", async () => {
      await Promise.resolve();
      expect(als.current()?.name).toBe("dispatch.history");
      await root.span("dispatch.compose", async () => {
        await Promise.resolve();
        expect(als.current()?.name).toBe("dispatch.compose");
      });
      expect(als.current()?.name).toBe("dispatch.history");
    });
    await Promise.resolve();
    expect(als.current()).toBeUndefined();
  });
});

describe("sanitizeSpanName", () => {
  it("lowercases, replaces disallowed runs with one underscore, trims edges, and caps with a stable hash suffix", () => {
    expect(sanitizeSpanName("Tool.Bash")).toBe("tool.bash");
    expect(sanitizeSpanName("mcp.github/list issues!")).toBe("mcp.github_list_issues");
    expect(sanitizeSpanName("!!!")).toBe("span");
    const long = sanitizeSpanName(`tool.${"a".repeat(100)}`);
    expect(long).toHaveLength(SPAN_NAME_MAX);
    expect(long).toMatch(/-[0-9a-f]{8}$/);
    expect(sanitizeSpanName(`tool.${"a".repeat(100)}`)).toBe(long);
    expect(sanitizeSpanName(`tool.${"a".repeat(99)}b`)).not.toBe(long);
  });
});
