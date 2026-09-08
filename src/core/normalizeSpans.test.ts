// Feature: features/tracing.md — the one Adapter from a run stream to its span set.
import { describe, expect, it } from "vitest";
import { lossesFromStream, normalizeSpans, spansFromEvents } from "./normalizeSpans.js";
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
const turn = (startedAt: number, durationMs: number): RunEvent => ({
  type: "turn",
  startedAt,
  durationMs,
  stopReason: "tool_use",
  usage: { inputTokens: 10, outputTokens: 5 },
  at: startedAt + durationMs,
});
const spans = (events: RunEvent[]) => events.filter((e) => e.type === "span_start" || e.type === "span_end");
const withSeq = (events: RunEvent[]): RunEvent[] => events.map((e, i) => ({ ...e, seq: i + 1 }));

describe("normalizeSpans — legacy streams", () => {
  it("a legacy `turn` becomes a model.turn span placed on its own stamps, carrying the usage as attrs; the turn event stays", () => {
    const out = normalizeSpans([input(0), turn(0, 4_000), call("c1", 4_000), result("c1", 6_000), answer(9_000)]);
    const turnSpans = spans(out).filter((e) => e.type !== "span_start" && "name" in e && e.name === "model.turn");
    expect(turnSpans).toHaveLength(1);
    expect(turnSpans[0]).toMatchObject({
      type: "span_end",
      spanId: "synth:1",
      startedAt: 0,
      durationMs: 4_000,
      status: "ok",
      attrs: { stopReason: "tool_use", inputTokens: 10, outputTokens: 5 },
      at: 4_000,
    });
    expect(out.filter((e) => e.type === "turn")).toHaveLength(1);
    // the end lands right after the turn event
    const i = out.findIndex((e) => e.type === "turn");
    expect(out[i + 1]).toMatchObject({ type: "span_end", name: "model.turn" });
  });

  it("a tool_call/tool_result pair becomes a tool.<name> span keyed by callId; an unpaired call stays open (a start with no end)", () => {
    const out = normalizeSpans([call("c1", 1_000), result("c1", 3_500, false), call("c2", 4_000)]);
    const s = spansFromEvents(out, "run-1").filter((x) => x.name.startsWith("tool.")); // the gap rule adds a model.turn between them
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

  it("legacy calls without a callId pair with results oldest-first per tool — the fold's own rule — so two concurrent same-tool calls both close", () => {
    const legacyCall = (at: number, tool = "bash"): RunEvent => ({ type: "tool_call", tool, summary: "$ x", at });
    const legacyResult = (at: number, tool = "bash"): RunEvent => ({
      type: "tool_result",
      tool,
      ok: true,
      summary: "ok",
      at,
    });
    const s = spansFromEvents(
      normalizeSpans([legacyCall(1_000), legacyCall(1_100), legacyResult(2_000), legacyResult(2_500)], { schema: 2 }),
      "r",
    ).filter((x) => x.name === "tool.bash");
    expect(s.map((x) => [x.startedAt, x.endedAt])).toEqual([
      [1_000, 2_000],
      [1_100, 2_500],
    ]);
    expect(s.map((x) => x.spanId)).toEqual(["synth:0", "synth:1"]);
  });

  it("a callId that is not a plain token falls back to the content index for the id", () => {
    const out = normalizeSpans([call("weird id/with spaces", 1_000), result("weird id/with spaces", 2_000)]);
    expect(spansFromEvents(out, "r").map((s) => s.spanId)).toEqual(["synth:0"]);
  });

  it("an mcp_tool_use becomes an mcp.<server>.<tool> span ending at the event's stamp", () => {
    const mcp: RunEvent = {
      type: "mcp_tool_use",
      server: "vanta",
      tool: "list",
      ok: true,
      durationMs: 700,
      bytes: 120,
      at: 5_000,
    };
    const s = spansFromEvents(normalizeSpans([mcp]), "r");
    expect(s).toEqual([
      expect.objectContaining({
        name: "mcp.vanta.list",
        startedAt: 4_300,
        endedAt: 5_000,
        durationMs: 700,
        attrs: { ok: true, bytes: 120 },
      }),
    ]);
  });

  it("the gap rule fires only on a legacy stream with no turn record at all: previous result/input → next call/narration/answer", () => {
    const events = [
      input(0),
      call("c1", 3_000),
      result("c1", 4_000),
      { type: "assistant", text: "hm", at: 6_000 } as RunEvent,
      answer(9_000),
    ];
    const s = spansFromEvents(normalizeSpans(events), "r").filter((x) => x.name === "model.turn");
    expect(s.map((x) => [x.startedAt, x.endedAt])).toEqual([
      [0, 3_000],
      [4_000, 6_000],
    ]);
    // with one turn event present the gap rule stays off
    const withTurn = spansFromEvents(
      normalizeSpans([input(0), turn(0, 1_000), call("c1", 3_000), result("c1", 4_000), answer(9_000)]),
      "r",
    );
    expect(withTurn.filter((x) => x.name === "model.turn")).toHaveLength(1);
    // on a schema-2 stream it never fires
    expect(
      spansFromEvents(normalizeSpans(events, { schema: 2 }), "r").filter((x) => x.name === "model.turn"),
    ).toHaveLength(0);
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
    const out = normalizeSpans(
      [agent, call("c1", 1_000), result("c1", 2_000), call("c2", 20_000), result("c2", 21_000)],
      { schema: 2 },
    );
    const s = spansFromEvents(out, "r");
    expect(s.find((x) => x.spanId === "synth:c1")?.parentSpanId).toBe("a1");
    expect(s.find((x) => x.spanId === "synth:c2")?.parentSpanId).toBeUndefined();
  });
});

describe("normalizeSpans — idempotence and the identity", () => {
  it("running it twice adds nothing; a schema-2 stream whose pairs have twins is returned unchanged", () => {
    const legacy = [input(0), turn(0, 1_000), call("c1", 1_000), result("c1", 2_000), answer(3_000)];
    const once = normalizeSpans(legacy);
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
    expect(normalizeSpans(twinned, { schema: 2 })).toEqual(twinned);
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
