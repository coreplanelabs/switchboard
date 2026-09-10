// Feature: docs/reference/specs/tracing.md — the partition identity on every fixture the
// plan names, the open-span rules, the loss algebra and the printed shape.
import { describe, expect, it } from "vitest";
import { isInformative, partition, printedShape, type LossInterval, type Partition } from "./partition.js";
import type { SpanRecord } from "./types.js";

let n = 0;
function span(
  name: string,
  startedAt: number,
  endedAt: number | undefined,
  parentSpanId?: string,
  spanId = `s${++n}`,
): SpanRecord {
  return {
    traceId: "t",
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    startedAt,
    ...(endedAt !== undefined ? { endedAt, durationMs: endedAt - startedAt, status: "ok" as const } : {}),
    attrs: {},
  };
}

function identity(p: Partition): void {
  expect(
    p.gettingReadyMs + p.thinkingMs + p.toolsMs + p.finishingUpMs + p.overheadMs + p.notRecordedMs + p.notLoadedMs,
  ).toBe(p.windowMs);
}

const W = { start: 0, end: 252_000 }; // the worked example: 4m 12s

describe("partition", () => {
  it("the worked example: 32s getting ready · 2m 30s thinking · 55s in tools · 8s finishing up · 7s overhead", () => {
    const spans: SpanRecord[] = [span("request", 0, undefined, undefined, "root")];
    // slack.receive + dispatch.* sum to 34 s with a 2 s repo_context/memory_read overlap → 32 s
    spans.push(span("slack.receive", 0, 2_000, "root"));
    spans.push(span("dispatch.history", 2_000, 10_000, "root"));
    spans.push(span("dispatch.repo_context", 10_000, 22_000, "root"));
    spans.push(span("dispatch.memory_read", 20_000, 32_000, "root")); // overlaps 2 s
    // background diff read for two minutes claims nothing
    spans.push(span("run.reading_diff", 32_000, 152_000, "root"));
    spans.push(span("run.agent", 32_000, 236_000, "root", "agent"));
    // eight turns summing to 150 s, eleven tools summing to 56.5 s with a 1.5 s three-read overlap → 55 s
    let t = 32_000;
    for (let i = 0; i < 8; i++) {
      spans.push(span("model.turn", t, t + 18_750, "agent"));
      t += 18_750;
    }
    // t = 182_000; tools from 182_000
    t = 182_000;
    for (let i = 0; i < 8; i++) {
      spans.push(span("tool.bash", t, t + 5_000, "agent"));
      t += 5_000;
    } // 40 s → t = 222_000
    spans.push(span("tool.read_file", 222_000, 228_000, "agent")); // 6 s
    spans.push(span("tool.read_file", 226_500, 232_500, "agent")); // overlaps 1.5 s → +4.5 s
    spans.push(span("tool.read_file", 232_500, 237_000, "agent")); // 4.5 s → 55 s total, ends past run.agent
    spans.push(span("run.pr_post_step", 237_000, 245_000, "root")); // 8 s
    const p = partition(spans, { window: W, owner: "agent", finished: true, losses: [] });
    identity(p);
    expect(p).toMatchObject({
      gettingReadyMs: 32_000,
      thinkingMs: 150_000,
      toolsMs: 55_000,
      finishingUpMs: 8_000,
      notRecordedMs: 0,
      notLoadedMs: 0,
    });
    expect(p.overheadMs).toBe(7_000);
    expect(printedShape(p)).toEqual({
      totalS: 252,
      items: [
        { term: "getting ready", s: 32 },
        { term: "thinking", s: 150 },
        { term: "in tools", s: 55 },
        { term: "finishing up", s: 8 },
        { term: "Switchboard overhead", s: 7 },
      ],
    });
    expect(isInformative(p)).toBe(true);
  });

  it("concurrent siblings count once; an MCP call inside a tool stays tools; a deeper counted node wins", () => {
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("run.agent", 0, 10_000, "root", "agent"),
      span("tool.a", 0, 4_000, "agent", "ta"),
      span("tool.b", 2_000, 6_000, "agent"),
      span("mcp.github.list", 1_000, 3_000, "ta"),
      span("model.turn", 6_000, 9_000, "agent"),
    ];
    const p = partition(spans, { window: { start: 0, end: 10_000 }, owner: "agent", finished: true, losses: [] });
    identity(p);
    expect(p).toMatchObject({ toolsMs: 6_000, thinkingMs: 3_000, overheadMs: 1_000 });
  });

  it("a head-moved re-review's turn under the uncounted settle span is thinking; the settle's own awaits are overhead", () => {
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("run.settle_reviewed_head", 0, 30_000, "root", "settle"),
      span("run.agent", 10_000, 25_000, "settle", "agent2"),
      span("model.turn", 10_000, 25_000, "agent2"),
    ];
    const p = partition(spans, { window: { start: 0, end: 30_000 }, owner: "agent", finished: true, losses: [] });
    identity(p);
    expect(p).toMatchObject({ thinkingMs: 15_000, overheadMs: 15_000 });
  });

  it("a command run's run.command and its grafts are tools; on the fall-through's agent run the same spans are getting ready", () => {
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("run.command", 1_000, 5_000, "root", "cmd"),
      span("run.command.test", 2_000, 4_000, "cmd"),
    ];
    const asCommand = partition(spans, {
      window: { start: 0, end: 6_000 },
      owner: "command",
      finished: true,
      losses: [],
    });
    const asAgent = partition(spans, { window: { start: 0, end: 6_000 }, owner: "agent", finished: true, losses: [] });
    identity(asCommand);
    identity(asAgent);
    expect(asCommand).toMatchObject({ toolsMs: 4_000, gettingReadyMs: 0, overheadMs: 2_000 });
    expect(asAgent).toMatchObject({ toolsMs: 0, gettingReadyMs: 4_000, overheadMs: 2_000 });
  });

  it("an open root and an open background span are never a loss; background-only time is overhead and reported", () => {
    // Two productions of the one background name: a closed one and one still open.
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("run.reading_diff", 0, 4_000, "root"),
      span("run.reading_diff", 1_000, undefined, "root", "bg-2"),
      span("dispatch.compose", 4_000, 6_000, "root"),
    ];
    const p = partition(spans, { window: { start: 0, end: 8_000 }, owner: "agent", finished: true, losses: [] });
    identity(p);
    // the first covers 0..4 s alone; the open one runs to the window end and covers 6..8 s alone.
    expect(p).toMatchObject({ gettingReadyMs: 2_000, overheadMs: 6_000, notRecordedMs: 0, backgroundOnlyMs: 6_000 });
  });

  it("live window: an open counted span runs to the window end; finished window: it is cut at the next loss", () => {
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("dispatch.workspace.attach", 1_000, undefined, "root"),
    ];
    const losses: LossInterval[] = [{ from: 5_000, to: 7_000, kind: "lost" }];
    const live = partition(spans, { window: { start: 0, end: 10_000 }, owner: "agent", finished: false, losses });
    const done = partition(spans, { window: { start: 0, end: 10_000 }, owner: "agent", finished: true, losses });
    identity(live);
    identity(done);
    expect(live).toMatchObject({ gettingReadyMs: 9_000, notRecordedMs: 0, overheadMs: 1_000 });
    expect(done).toMatchObject({ gettingReadyMs: 4_000, notRecordedMs: 2_000, overheadMs: 4_000 });
  });

  it("losses: lost is not recorded, elided is not loaded, a counted claim beats both, lost beats elided, intervals clip to the window", () => {
    const spans = [span("request", 0, undefined, undefined, "root"), span("model.turn", 2_000, 4_000, "root")];
    const losses: LossInterval[] = [
      { from: -5_000, to: 3_000, kind: "lost" }, // clipped to 0..3000; 2000..3000 claimed by the turn
      { from: 6_000, to: 9_000, kind: "elided" },
      { from: 8_000, to: 12_000, kind: "lost" }, // overlaps the elision 8000..9000 → lost wins; clipped at 10000
    ];
    const p = partition(spans, { window: { start: 0, end: 10_000 }, owner: "agent", finished: true, losses });
    identity(p);
    expect(p).toMatchObject({ thinkingMs: 2_000, notRecordedMs: 2_000 + 2_000, notLoadedMs: 2_000, overheadMs: 2_000 });
  });

  it("head truncation (first seq > 1) and a middle drop with a 3 s seal delta both keep the identity", () => {
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("run.agent", 20_000, 60_000, "root", "agent"),
      span("model.turn", 20_000, 30_000, "agent"),
      span("tool.bash", 45_000, 60_000, "agent"),
      span("post.reply", 60_000, 63_000, "root"),
    ];
    const losses: LossInterval[] = [
      { from: 0, to: 20_000, kind: "lost" },
      { from: 30_000, to: 45_000, kind: "lost" },
    ];
    const p = partition(spans, { window: { start: 0, end: 60_000 }, owner: "agent", finished: true, losses });
    identity(p);
    expect(p).toMatchObject({ thinkingMs: 10_000, toolsMs: 15_000, notRecordedMs: 35_000, overheadMs: 0 });
  });

  it("spans outside the window contribute nothing; an empty input is all overhead", () => {
    const spans = [
      span("request", 0, undefined, undefined, "root"),
      span("post.reply", 10_000, 12_000, "root"),
      span("tool.x", 11_000, 12_000, "root"),
    ];
    const p = partition(spans, { window: { start: 0, end: 10_000 }, owner: "agent", finished: true, losses: [] });
    identity(p);
    expect(p.overheadMs).toBe(10_000);
    const empty = partition([], { window: { start: 5, end: 5 }, owner: "agent", finished: true, losses: [] });
    expect(empty.windowMs).toBe(0);
    expect(isInformative(empty)).toBe(false);
  });

  it("printedShape floors and lets the residual absorb the rounding, never printing 0s; the gate needs two informative terms", () => {
    const p: Partition = {
      windowMs: 10_400,
      gettingReadyMs: 5_500,
      thinkingMs: 4_500,
      toolsMs: 400,
      finishingUpMs: 0,
      overheadMs: 0,
      notRecordedMs: 0,
      notLoadedMs: 0,
      backgroundOnlyMs: 0,
    };
    const shape = printedShape(p);
    expect(shape.totalS).toBe(10);
    expect(shape.items.reduce((a, i) => a + i.s, 0)).toBe(10);
    expect(shape.items.map((i) => i.term)).toEqual(["getting ready", "thinking", "Switchboard overhead"]);
    expect(isInformative(p)).toBe(true);
    expect(isInformative({ ...p, thinkingMs: 0, toolsMs: 0, gettingReadyMs: 10_400 })).toBe(false);
  });
});
