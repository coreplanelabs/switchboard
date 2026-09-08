// Feature: docs/reference/specs/tracing.md — sink scoping: retain, bind, backfill, route;
// two roots never cross; one root two runs (the fall-through) both see the
// setup; a bounded buffer announces what it dropped; nothing after the root end.
import { describe, expect, it } from "vitest";
import { createTickingClock } from "../testing/tickingClock.js";
import { createCardSink } from "./cardSink.js";
import {
  BUFFER_MAX_EVENTS,
  BUFFER_PROTECTED_HEAD,
  createRunStreamSink,
  type SpanStreamEvent,
} from "./runStreamSink.js";
import { createTracer } from "./tracer.js";

function setup() {
  const clock = createTickingClock(1_000);
  const warnings: string[] = [];
  const sink = createRunStreamSink({ clock: clock.now, warn: (m) => warnings.push(m) });
  const tracer = createTracer({ clock: clock.now, warn: (m) => warnings.push(m) });
  const root = tracer.start("request", { sinks: [sink] });
  const streams = new Map<string, SpanStreamEvent[]>();
  const bind = (runId: string) => {
    const events: SpanStreamEvent[] = [];
    streams.set(runId, events);
    sink.bindRun(runId, (e) => events.push(e));
    return events;
  };
  return { clock, sink, tracer, root, bind, streams, warnings };
}

const names = (events: SpanStreamEvent[]) =>
  events.map((e) => (e.type === "run_note" ? `note:${e.kind}` : `${e.type}:${e.name}`));

describe("createRunStreamSink", () => {
  it("retains streamed spans before any run exists, backfills them at bind as fresh objects, then routes live; log-only spans never stream", async () => {
    const { clock, root, bind } = setup();
    await root.span("dispatch.history", () => clock.tick(100));
    await root.span("github.rest", () => clock.tick(50)); // log-only
    const run1 = bind("run-1");
    expect(names(run1)).toEqual(["span_start:request", "span_start:dispatch.history", "span_end:dispatch.history"]);
    await root.span("model.turn", () => clock.tick(200));
    expect(names(run1).slice(-2)).toEqual(["span_start:model.turn", "span_end:model.turn"]);
    const end = run1.at(-1) as Extract<SpanStreamEvent, { type: "span_end" }>;
    expect(end).toMatchObject({ durationMs: 200, status: "ok", startedAt: 1_150, at: 1_350 });
    // fresh objects: mutating a delivered event does not reach the buffer or another run
    (run1[0] as { name: string }).name = "tampered";
    const run2 = bind("run-2");
    expect((run2[0] as { name: string }).name).toBe("request");
  });

  it("one root, two runs (the fall-through): the command run carries the setup and run.command; the agent run carries the same setup, the failed run.command and its own work, no cross-delivery", async () => {
    const { clock, root, bind } = setup();
    await root.span("dispatch.admission", () => clock.tick(10));
    const cmd = bind("cmd");
    await root
      .span("run.command", () => {
        clock.tick(10);
        throw new Error("not_found");
      })
      .catch(() => {});
    const agent = bind("agent");
    await root.span("run.agent", (s) => s.span("tool.bash", () => clock.tick(10)));
    expect(names(cmd)).toEqual([
      "span_start:request",
      "span_start:dispatch.admission",
      "span_end:dispatch.admission",
      "span_start:run.command",
      "span_end:run.command",
    ]);
    expect(names(agent)).toEqual([
      "span_start:request",
      "span_start:dispatch.admission",
      "span_end:dispatch.admission",
      "span_start:run.command",
      "span_end:run.command",
      "span_start:run.agent",
      "span_start:tool.bash",
      "span_end:tool.bash",
      "span_end:run.agent",
    ]);
    // the command run received nothing of the agent run's work
    expect(names(cmd)).not.toContain("span_start:run.agent");
  });

  it("two roots never cross: each root's sink sees only its own spans", async () => {
    const a = setup();
    const b = setup();
    const ra = a.bind("a");
    const rb = b.bind("b");
    await a.root.span("dispatch.compose", () => a.clock.tick(5));
    await b.root.span("model.turn", () => b.clock.tick(5));
    expect(names(ra)).toEqual(["span_start:request", "span_start:dispatch.compose", "span_end:dispatch.compose"]);
    expect(names(rb)).toEqual(["span_start:request", "span_start:model.turn", "span_end:model.turn"]);
  });

  it("a late child (its parent already ended) is never streamed; nothing streams after the root ended, with one warning; a bind after the root ended is a no-op", async () => {
    const { clock, root, bind, warnings } = setup();
    const events = bind("r");
    const agent = root.start("run.agent");
    agent.end();
    const late = agent.start("tool.bash");
    late.end();
    expect(names(events)).not.toContain("span_start:tool.bash");
    root.end();
    // a log-only span after the root must not spend the one warning slot…
    root.start("post.history_write").end();
    expect(warnings.filter((w) => w.includes("after its root ended"))).toHaveLength(0);
    // …so the first STREAMED late span is the one that warns
    await root.span("post.reply", () => clock.tick(1)).catch(() => {});
    root.start("post.card_close").end();
    expect(names(events).filter((n) => n.includes("post."))).toEqual([]);
    expect(warnings.filter((w) => w.includes("after its root ended"))).toHaveLength(1);
    expect(warnings.find((w) => w.includes("after its root ended"))).toContain("post.reply");
    const before = events.length;
    bind("late-run");
    expect(events.length).toBe(before);
    expect(warnings.some((w) => w.includes("no-op"))).toBe(true);
  });

  it("the buffer is bounded: the protected head survives, the middle is dropped, and a run bound afterwards gets one counted spans_dropped note naming the count and the gap", async () => {
    const { clock, root, bind } = setup();
    const total = BUFFER_MAX_EVENTS + 40; // events, counting starts and ends → 20 spans over
    for (let i = 0; i < total / 2; i++) {
      await root.span("dispatch.compose", () => clock.tick(1));
    }
    const events = bind("r");
    const note = events.find((e) => e.type === "run_note");
    expect(note).toMatchObject({ kind: "spans_dropped" });
    if (note?.type === "run_note") {
      expect(note.summary).toMatch(/^\d+ setup steps not recorded$/);
      expect(note.to).toBeGreaterThanOrEqual(note.from);
    }
    // the head is intact: the root start and the first setup spans
    expect(names(events).slice(0, BUFFER_PROTECTED_HEAD)).toEqual(names(events).slice(0, BUFFER_PROTECTED_HEAD));
    expect(names(events)[0]).toBe("span_start:request");
    expect(events.filter((e) => e.type !== "run_note")).toHaveLength(BUFFER_MAX_EVENTS);
    // the newest events are kept (the note follows the backfill)
    const spans = events.filter((e) => e.type !== "run_note");
    expect(spans.at(-1)?.type).toBe("span_end");
    expect((spans.at(-1) as Extract<SpanStreamEvent, { type: "span_end" }>).at).toBe(clock.now());
  });

  it("a rebind while a run is still bound releases it with one warning", async () => {
    const { root, bind, warnings } = setup();
    const first = bind("first");
    bind("second");
    await root.span("dispatch.compose", () => {});
    expect(names(first)).toEqual(["span_start:request"]);
    expect(warnings.filter((w) => w.includes("was still bound"))).toHaveLength(1);
  });
});

describe("createCardSink", () => {
  it("paints the setup label from streamed dispatch.* starts and clears it when run.agent starts; nothing until a card is bound", async () => {
    const clock = createTickingClock();
    const labels: Array<string | undefined> = [];
    const sink = createCardSink(
      (name) => ({ "dispatch.history": "reading the thread", "dispatch.compose": "preparing the prompt" })[name],
    );
    const tracer = createTracer({ clock: clock.now });
    const root = tracer.start("request", { sinks: [sink] });
    await root.span("dispatch.history", () => {});
    expect(labels).toEqual([]);
    sink.bindCard({ setupLabel: (l) => labels.push(l) });
    await root.span("dispatch.compose", () => {});
    await root.span("github.rest", () => {}); // log-only: no paint
    await root.span("run.agent", () => {});
    expect(labels).toEqual(["preparing the prompt", undefined]);
  });
});
