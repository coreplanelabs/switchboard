// Feature: docs/reference/specs/tracing.md — the one Adapter from a run stream to its span set.
import { describe, expect, it } from "vitest";
import { createLossTracker, lossesFromStream, normalizeSpans, spansFromEvents } from "./normalizeSpans.js";
import type { RunEvent } from "./runEvents.js";

const input = (at: number): RunEvent => ({ type: "input", text: "go", at });
const call = (id: string, at: number, tool = "bash"): RunEvent => ({
  type: "tool_call",
  tool,
  summary: "$ x",
  callId: id,
  at,
});
const result = (id: string, at: number, ok = true, tool = "bash"): RunEvent => ({
  type: "tool_result",
  tool,
  ok,
  summary: "done",
  callId: id,
  at,
});
const answer = (at: number): RunEvent => ({ type: "answer", text: "ok", at });
const spans = (events: RunEvent[]) => events.filter((e) => e.type === "span_start" || e.type === "span_end");
const withSeq = (events: RunEvent[]): RunEvent[] => events.map((e, i) => ({ ...e, seq: i + 1 }));

describe("normalizeSpans — the twin rule", () => {
  it("a tool_call/tool_result pair becomes a tool.<name> span keyed by callId, placed around the pair; an unpaired call stays open (a start with no end)", () => {
    const out = normalizeSpans([call("c1", 1_000), result("c1", 3_500, false), call("c2", 4_000)]);
    expect(out.map((e) => e.type)).toEqual([
      "span_start",
      "tool_call",
      "tool_result",
      "span_end",
      "span_start",
      "tool_call",
    ]);
    expect(spans(out).filter((e) => e.name !== "tool.bash")).toEqual([]); // nothing but the pairs' twins
    const s = spansFromEvents(out, "run-1");
    expect(s).toEqual([
      expect.objectContaining({
        spanId: "synth:c1",
        name: "tool.bash",
        startedAt: 1_000,
        endedAt: 3_500,
        durationMs: 2_500,
        status: "error",
        attrs: { callId: "c1", ok: false },
      }),
      expect.objectContaining({ spanId: "synth:c2", name: "tool.bash", startedAt: 4_000, attrs: { callId: "c2" } }),
    ]);
    expect(s[1].endedAt).toBeUndefined();
  });

  it("a call with no callId or no stamp gets no span, and a result with no callId closes nothing — there is nothing to key or time it by", () => {
    const unkeyed: RunEvent[] = [
      { type: "tool_call", tool: "bash", summary: "$ x", at: 1_000 },
      { type: "tool_result", tool: "bash", ok: true, summary: "ok", at: 2_000 },
    ];
    expect(normalizeSpans(unkeyed)).toEqual(unkeyed);
    const unstamped: RunEvent[] = [
      { type: "tool_call", tool: "bash", summary: "$ x", callId: "c1" },
      { type: "tool_result", tool: "bash", ok: true, summary: "ok", callId: "c1" },
    ];
    expect(normalizeSpans(unstamped)).toEqual(unstamped);
    // a keyed call whose result lost its id stays open
    const out = normalizeSpans([
      call("c1", 1_000),
      { type: "tool_result", tool: "bash", ok: true, summary: "ok", at: 2_000 },
    ]);
    expect(spansFromEvents(out, "r")).toEqual([expect.objectContaining({ spanId: "synth:c1", startedAt: 1_000 })]);
    expect(spansFromEvents(out, "r")[0].endedAt).toBeUndefined();
  });

  it("a callId that is not a plain token falls back to the content index for the id", () => {
    const out = normalizeSpans([call("weird id/with spaces", 1_000), result("weird id/with spaces", 2_000)]);
    expect(spansFromEvents(out, "r").map((s) => s.spanId)).toEqual(["synth:0"]);
  });

  it("no span is ever synthesized for a model turn or a narrative event: a stream without model.turn spans has no model time", () => {
    const events = [
      input(0),
      call("c1", 3_000),
      result("c1", 4_000),
      { type: "assistant", text: "hm", at: 6_000 } as RunEvent,
      answer(9_000),
    ];
    const s = spansFromEvents(normalizeSpans(events), "r");
    expect(s.map((x) => x.name)).toEqual(["tool.bash"]);
  });

  it("a synthesized span's parent is the innermost surviving run.agent span containing it; otherwise it is an orphan", () => {
    const agent: RunEvent = {
      type: "span_end",
      spanId: "a1",
      name: "run.agent",
      startedAt: 0,
      durationMs: 10_000,
      status: "ok",
      at: 10_000,
    };
    const out = normalizeSpans([
      agent,
      call("c1", 1_000),
      result("c1", 2_000),
      call("c2", 20_000),
      result("c2", 21_000),
    ]);
    const s = spansFromEvents(out, "r");
    expect(s.find((x) => x.spanId === "synth:c1")?.parentSpanId).toBe("a1");
    expect(s.find((x) => x.spanId === "synth:c2")?.parentSpanId).toBeUndefined();
  });
});

describe("normalizeSpans — idempotence and the identity", () => {
  it("running it twice adds nothing; a stream whose pairs have twins is returned unchanged", () => {
    const budgetCut = [input(0), call("c1", 1_000), result("c1", 2_000), answer(3_000)];
    const once = normalizeSpans(budgetCut);
    expect(once).not.toEqual(budgetCut);
    expect(normalizeSpans(once)).toEqual(once);
    const twinned: RunEvent[] = [
      { type: "span_start", spanId: "t1", name: "tool.bash", attrs: { callId: "c1" }, at: 1_000 },
      call("c1", 1_000),
      result("c1", 2_000),
      {
        type: "span_end",
        spanId: "t1",
        name: "tool.bash",
        startedAt: 1_000,
        durationMs: 1_000,
        status: "ok",
        attrs: { callId: "c1", ok: true },
        at: 2_000,
      },
    ];
    expect(normalizeSpans(twinned)).toEqual(twinned);
  });

  it("never mutates its input", () => {
    const events = [call("c1", 1_000), result("c1", 2_000)];
    const copy = structuredClone(events);
    normalizeSpans(events);
    expect(events).toEqual(copy);
  });
});

describe("spansFromEvents", () => {
  it("pairs a start and an end by spanId (the end's fields win, the start's attrs are kept), and an end alone is complete", () => {
    const s = spansFromEvents(
      [
        { type: "span_start", spanId: "x", parentSpanId: "p", name: "dispatch.compose", attrs: { count: 3 }, at: 100 },
        {
          type: "span_end",
          spanId: "x",
          name: "dispatch.compose",
          startedAt: 100,
          durationMs: 50,
          status: "ok",
          attrs: { outcome: "ok" },
          at: 150,
        },
        {
          type: "span_end",
          spanId: "y",
          name: "post.reply",
          startedAt: 900,
          durationMs: 20,
          status: "error",
          error: "slack 500",
          at: 920,
        },
      ],
      "run-9",
    );
    expect(s).toEqual([
      {
        traceId: "run-9",
        spanId: "x",
        parentSpanId: "p",
        name: "dispatch.compose",
        startedAt: 100,
        endedAt: 150,
        durationMs: 50,
        status: "ok",
        attrs: { count: 3, outcome: "ok" },
      },
      {
        traceId: "run-9",
        spanId: "y",
        name: "post.reply",
        startedAt: 900,
        endedAt: 920,
        durationMs: 20,
        status: "error",
        errorMessage: "slack 500",
        attrs: {},
      },
    ]);
  });
});

describe("lossesFromStream", () => {
  it("createLossTracker reads the same intervals frame by frame, and a gap's kind follows a range reported after the gap arrived", () => {
    const tracker = createLossTracker();
    const events: RunEvent[] = [
      { ...call("c1", 10_000), seq: 40 },
      { ...result("c1", 12_000), seq: 41 },
      { ...call("c2", 30_000), seq: 60 },
      { ...result("c2", 33_000), seq: 90 },
    ];
    for (const e of events) tracker.push(e);
    expect(tracker.losses({ windowStart: 0 })).toEqual(lossesFromStream(events, { windowStart: 0 }));
    expect(tracker.losses({ windowStart: 0 }).map((l) => l.kind)).toEqual(["lost", "lost", "lost"]);
    // The transport reports the second gap's range afterwards: that gap reads elided now, the others do not.
    expect(tracker.losses({ windowStart: 0, elided: [{ fromSeq: 61, toSeq: 89 }] }).map((l) => l.kind)).toEqual([
      "lost",
      "lost",
      "elided",
    ]);
    expect(createLossTracker().losses({ windowStart: 0 })).toEqual([]);
  });

  it("a head trimmed by the registry (first seq above 1) is a lost interval from the window start; an interior seq gap is lost, or elided when the transport reported it; a spans_dropped note is lost; replay_note markers change nothing", () => {
    const events: RunEvent[] = [
      { ...call("c1", 10_000), seq: 40 },
      { type: "replay_note", summary: "3 records omitted" } as unknown as RunEvent,
      { ...result("c1", 12_000), seq: 41 },
      { ...call("c2", 30_000), seq: 60 },
      {
        type: "run_note",
        kind: "spans_dropped",
        summary: "8 setup steps not recorded",
        from: 1_000,
        to: 4_000,
        seq: 61,
        at: 30_500,
      } as RunEvent,
      { ...result("c2", 33_000), seq: 90 },
    ];
    expect(lossesFromStream(events, { windowStart: 0, elided: [{ fromSeq: 62, toSeq: 89 }] })).toEqual([
      { from: 0, to: 10_000, kind: "lost" },
      { from: 12_000, to: 30_000, kind: "lost" },
      { from: 1_000, to: 4_000, kind: "lost" },
      { from: 30_500, to: 33_000, kind: "elided" },
    ]);
  });

  it("a complete stream has no losses; without a window start a trimmed head yields none either", () => {
    expect(lossesFromStream(withSeq([call("c1", 1), result("c1", 2)]), { windowStart: 0 })).toEqual([]);
    expect(lossesFromStream([{ ...call("c1", 5_000), seq: 9 }])).toEqual([]);
  });
});
