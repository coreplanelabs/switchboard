// Feature: features/tracing.md — one request, one root: the constructor of
// roots, its sinks, and what a bound run and a bound card see.
import { describe, expect, it } from "vitest";
import { channelOf, startRequestRoot } from "./requestTrace.js";
import { recordingSink } from "./testing/recordingSink.js";
import { createTickingClock } from "./testing/tickingClock.js";
import type { RunEvent } from "./runEvents.js";

const config = (log?: "roots" | "slow") => ({ config: { tracing: log ? { log } : undefined } }) as never;

describe("startRequestRoot", () => {
  it("starts the root at receivedAt with the channel attr; a bound run gets the setup spans backfilled then live, and the root learns its runId", async () => {
    const clock = createTickingClock(10_000);
    const log = recordingSink();
    const trace = startRequestRoot(
      { config: config(), clock: clock.now, sinks: [log] },
      {
        channel: "slack",
        receivedAt: 9_000,
      },
    );
    expect(trace.receivedAt).toBe(9_000);
    expect(trace.root.record()).toMatchObject({ name: "request", startedAt: 9_000, attrs: { channel: "slack" } });
    // Setup spans before any run exists are retained…
    clock.tick(500);
    await trace.root.span("dispatch.history", () => undefined);
    const events: RunEvent[] = [];
    trace.bindRun("r1", (e) => events.push(e));
    // …and delivered at bind, then live.
    expect(
      events.map((e) => (e.type === "span_start" ? `+${e.name}` : e.type === "span_end" ? `-${e.name}` : e.type)),
    ).toEqual(["+request", "+dispatch.history", "-dispatch.history"]);
    await trace.root.span("dispatch.compose", () => undefined);
    expect(events).toHaveLength(5);
    expect(trace.root.record().attrs).toEqual({ channel: "slack", runId: "r1" });
    // Log-only spans never reach the run's stream, only the log sink.
    await trace.root.span("post.history_write", () => undefined);
    expect(events).toHaveLength(5);
    expect(log.ended("post.history_write")).toBeDefined();
  });

  it("a bound card is told the setup step by display name and cleared when the agent loop starts", async () => {
    const clock = createTickingClock();
    const trace = startRequestRoot(
      { config: config(), clock: clock.now, sinks: [] },
      {
        channel: "http",
        receivedAt: clock.now(),
      },
    );
    const labels: Array<string | undefined> = [];
    trace.bindCard({ setupLabel: (l) => void labels.push(l) });
    await trace.root.span("dispatch.workspace.attach", () => undefined);
    await trace.root.span("post.history_write", () => undefined); // log-only: no label
    await trace.root.span("run.agent", () => undefined);
    expect(labels).toEqual(["attaching the workspace…", undefined]);
  });

  it("spansSoFar is the streamed children so far — ended ones complete, an open one open — never the root or a log-only span", async () => {
    const clock = createTickingClock(1_000);
    const trace = startRequestRoot(
      { config: config(), clock: clock.now, sinks: [] },
      {
        channel: undefined,
        receivedAt: 1_000,
      },
    );
    await trace.root.span("dispatch.history", () => void clock.tick(200));
    const open = trace.root.start("dispatch.workspace.attach");
    await trace.root.span("exec.release", () => undefined);
    const spans = trace.spansSoFar();
    expect(spans.map((s) => [s.name, s.endedAt !== undefined])).toEqual([
      ["dispatch.history", true],
      ["dispatch.workspace.attach", false],
    ]);
    expect(spans[0]!.durationMs).toBe(200);
    open.end();
    expect(trace.spansSoFar()[1]!.endedAt).toBeDefined();
    expect(trace.root.record().attrs).toEqual({}); // no channel → no attr
  });

  it("with no injected sinks the log sink follows tracing.log: roots prints the root only", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      const trace = startRequestRoot({ config: config("roots") }, { channel: "cli", receivedAt: 1 });
      await trace.root.span("dispatch.history", () => undefined);
      expect(lines).toHaveLength(0);
      trace.root.end();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ span: "request", attrs: { channel: "cli" } });
    } finally {
      console.log = orig;
    }
  });

  it("channelOf reads the namespaced prefix and names no channel for anything else", () => {
    expect(channelOf("slack:C1")).toBe("slack");
    expect(channelOf("http:cron")).toBe("http");
    expect(channelOf("mcp:default")).toBe("mcp");
    expect(channelOf("cli:local")).toBe("cli");
    expect(channelOf("teams:x")).toBeUndefined();
    expect(channelOf("nocolon")).toBeUndefined();
  });
});
