// Feature: docs/reference/specs/tracing.md item 5 — the shape line and the card's gate on it.
import { describe, expect, it } from "vitest";
import { cardShapeLine, queuedCaption, shapeLine } from "./runShape.js";
import type { SpanRecord } from "./trace/types.js";

const span = (name: string, startedAt: number, durationMs: number, parentSpanId?: string): SpanRecord => ({
  traceId: "t",
  spanId: `${name}@${startedAt}`,
  ...(parentSpanId ? { parentSpanId } : {}),
  name,
  startedAt,
  endedAt: startedAt + durationMs,
  durationMs,
  status: "ok",
  attrs: {},
});

describe("shapeLine", () => {
  it("prints the worked example — every non-zero bucket, the residual last, summing to the total", () => {
    const spans = [
      span("slack.receive", 0, 4_000),
      span("dispatch.workspace.attach", 4_000, 28_000),
      span("run.agent", 34_000, 210_000),
      span("model.turn", 34_000, 150_000, "run.agent@34000"),
      span("tool.bash", 184_000, 55_000, "run.agent@34000"),
      span("run.pr_post_step", 244_000, 8_000),
    ];
    expect(shapeLine(spans, { window: { start: 0, end: 252_000 }, owner: "agent", finished: true })).toBe(
      "32s getting ready · 2m 30s thinking · 55s in tools · 8s finishing up · 7s Switchboard overhead",
    );
  });

  it("is nothing when fewer than two buckets are informative", () => {
    const spans = [span("run.agent", 0, 3_000), span("model.turn", 0, 2_900, "run.agent@0")];
    expect(shapeLine(spans, { window: { start: 0, end: 3_000 }, owner: "agent", finished: true })).toBeUndefined();
  });

  it("the card adds its size gate: under a minute with getting-ready under 15 s prints nothing, either threshold opens it", () => {
    const quick = [span("dispatch.workspace.attach", 0, 5_000), span("model.turn", 5_000, 20_000)];
    expect(cardShapeLine(quick, { window: { start: 0, end: 30_000 }, owner: "agent", finished: true })).toBeUndefined();
    const slowSetup = [span("dispatch.workspace.attach", 0, 16_000), span("model.turn", 16_000, 10_000)];
    expect(cardShapeLine(slowSetup, { window: { start: 0, end: 30_000 }, owner: "agent", finished: true })).toBe(
      "16s getting ready · 10s thinking · 4s Switchboard overhead",
    );
    const long = [span("dispatch.workspace.attach", 0, 5_000), span("model.turn", 5_000, 60_000)];
    expect(cardShapeLine(long, { window: { start: 0, end: 70_000 }, owner: "agent", finished: true })).toBe(
      "5s getting ready · 1m 00s thinking · 5s Switchboard overhead",
    );
  });

  it("an open span on a live window runs to the window end", () => {
    const open: SpanRecord = {
      ...span("dispatch.workspace.attach", 5_000, 0),
      endedAt: undefined,
      durationMs: undefined,
    };
    expect(
      shapeLine([span("dispatch.history", 0, 2_000), open], {
        window: { start: 0, end: 20_000 },
        owner: "agent",
        finished: false,
      }),
    ).toBe("17s getting ready · 3s Switchboard overhead");
  });
});

describe("queuedCaption", () => {
  it("shows from a minute, in the clock style, worded per kind; nothing below or when unknown", () => {
    expect(queuedCaption("before", 59_999)).toBeUndefined();
    expect(queuedCaption("before", undefined)).toBeUndefined();
    expect(queuedCaption("before", 360_000)).toBe("queued 6m 00s before we saw it");
    expect(queuedCaption("behind", 250_000)).toBe("queued 4m 10s behind the previous run");
  });
});
