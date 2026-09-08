// Feature: docs/reference/specs/live-view.md item 25; docs/reference/specs/tracing.md — the timeline's
// view-model: the lede closes to the header's total on every fixture, the
// drill-down is a subset, the ranked list never prints a raw span name.
import { describe, expect, it } from "vitest";
import type { SpanRecord } from "@core/core/trace/types.js";
import type { SpanAttrs } from "@core/core/trace/attrs.js";
import { DISPLAY_NAMES } from "@core/core/trace/displayNames.js";
import { formatDuration } from "./format";
import {
  buildTimeline,
  CURRENTLY_DELIVERING,
  GLOSS,
  NO_ROOT_NOTE,
  RANKED_NOTE,
  type TimelineInput,
} from "./timelineVm";

function sp(
  id: string,
  name: string,
  startedAt: number,
  endedAt: number | undefined,
  over: { parent?: string; attrs?: SpanAttrs; status?: "ok" | "error" } = {},
): SpanRecord {
  return {
    traceId: "t",
    spanId: id,
    ...(over.parent ? { parentSpanId: over.parent } : {}),
    name,
    startedAt,
    ...(endedAt !== undefined ? { endedAt, durationMs: endedAt - startedAt, status: over.status ?? "ok" } : {}),
    attrs: over.attrs ?? {},
  };
}

/** The worked review (docs/reference/specs/tracing.md): 4m 12s, every bucket present. */
const REVIEW: SpanRecord[] = [
  sp("root", "request", 0, 252_000, { attrs: { channel: "slack", queuedBeforeMs: 360_000 } }),
  sp("recv", "slack.receive", 0, 2_000, { parent: "root" }),
  sp("hist", "dispatch.history", 2_000, 6_000, { parent: "root" }),
  sp("repo", "dispatch.repo_context", 6_000, 20_000, { parent: "root" }),
  sp("mem", "dispatch.memory_read", 8_000, 22_000, { parent: "root" }), // overlaps repo_context: counted once
  sp("attach", "dispatch.workspace.attach", 22_000, 34_000, { parent: "root", attrs: { backend: "resident" } }),
  sp("clone", "dispatch.workspace.attach.clone", 22_000, 30_000, { parent: "attach", attrs: { backend: "resident" } }),
  sp("diff", "run.reading_diff", 34_000, 154_000, { parent: "root" }), // background: claims nothing
  sp("agent", "run.agent", 34_000, 240_000, { parent: "root" }),
  sp("t1", "model.turn", 34_000, 70_000, { parent: "agent" }),
  sp("c1", "tool.bash", 70_000, 100_000, { parent: "agent", attrs: { callId: "c1" } }),
  sp("t2", "model.turn", 100_000, 200_000, { parent: "agent" }),
  sp("c2", "tool.bash", 200_000, 240_000, {
    parent: "agent",
    attrs: { callId: "c2", exitCode: 1, timeoutMs: 1_200_000 },
  }),
  sp("post", "run.pr_post_step", 240_000, 248_000, { parent: "root" }),
];

const finishedReview: TimelineInput = {
  spans: REVIEW,
  losses: [],
  window: { start: 0, end: 252_000 },
  owner: "agent",
  totalMs: 252_000,
  phase: "ended",
  delivery: { finishedAt: 252_000, sealedAt: 254_000, replyOk: true },
};

const RAW_NAMES = new Set(REVIEW.map((s) => s.name));
const DISPLAY = new Set<string>(Object.values(DISPLAY_NAMES));

describe("buildTimeline", () => {
  it("finished: the lede is the header's total split into the five words, summing to it; the bar is the same numbers; the queued and delivered captions read from the root and the stamps", () => {
    const vm = buildTimeline(finishedReview);
    expect(vm.lede).toBe(
      "4m 12s — 34s getting ready · 2m 16s thinking · 1m 10s in tools · 8s finishing up · 4s Switchboard overhead",
    );
    expect(vm.lede.startsWith(formatDuration(finishedReview.totalMs, "clock"))).toBe(true);
    // The printed items sum to the printed total.
    const seconds = [...vm.lede.matchAll(/(\d+)m (\d+)s|(\d+)s/g)].map((m) =>
      m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3]),
    );
    const [total, ...items] = seconds;
    expect(items.reduce((a, b) => a + b, 0)).toBe(total);
    expect(vm.current).toBe("delivered in 2s");
    expect(vm.captions).toEqual(["queued 6m 00s before we saw it"]);
    expect(vm.shown).toBe(true);
    expect(vm.note).toBe("");
    expect(vm.bar.map((s) => [s.term, s.ms, Math.round(s.pct * 10) / 10, s.hatched])).toEqual([
      ["getting ready", 34_000, 13.5, false],
      ["thinking", 136_000, 54, false],
      ["in tools", 70_000, 27.8, false],
      ["finishing up", 8_000, 3.2, false],
      ["Switchboard overhead", 4_000, 1.6, false],
    ]);
    expect(vm.bar.reduce((a, s) => a + s.ms, 0)).toBe(252_000);
    expect(vm.gloss).toBe(GLOSS);
    expect(vm.rankedNote).toBe(RANKED_NOTE);
  });

  it("ranks up to three steps by their own time (children excluded, the root and background out, ties by earlier start), labelled through the display table with whitelisted facts — never a raw span name", () => {
    const vm = buildTimeline(finishedReview);
    // run.agent's own time is zero (its turns and tools cover it); reading_diff is background.
    expect(vm.ranked).toEqual([
      { label: "a model turn", ms: 100_000, facts: [] },
      { label: "bash", ms: 40_000, facts: ["timeout 20m 00s", "exit 1"] },
      { label: "a model turn", ms: 36_000, facts: [] },
    ]);
    for (const item of vm.ranked) {
      expect(RAW_NAMES.has(item.label)).toBe(false);
      expect(item.label.includes(".")).toBe(false);
      expect(DISPLAY.has(item.label) || item.label === "bash").toBe(true);
    }
    // The attach's own time is its 4 s outside the clone graft: 4th, so not listed.
    expect(vm.ranked.some((r) => r.label === "attaching the workspace")).toBe(false);
  });

  it("live: the buckets over the elapsed window, then the open bucket as a drill-down that is a subset of its bucket and a hatched tail on the bar; no drill-down when the deepest open span is uncounted", () => {
    const live: SpanRecord[] = [
      sp("root", "request", 0, undefined, { attrs: { channel: "slack" } }),
      sp("hist", "dispatch.history", 0, 30_000, { parent: "root" }),
      sp("agent", "run.agent", 30_000, undefined, { parent: "root" }),
      sp("t1", "model.turn", 30_000, 60_000, { parent: "agent" }),
      sp("c1", "tool.bash", 60_000, 80_000, { parent: "agent" }),
      sp("t2", "model.turn", 90_000, undefined, { parent: "agent" }), // open: thinking for 10 s at now=100 s
    ];
    const vm = buildTimeline({
      spans: live,
      losses: [],
      window: { start: 0, end: 100_000 },
      owner: "agent",
      totalMs: 100_000,
      phase: "live",
    });
    expect(vm.lede).toBe("1m 40s — 30s getting ready · 40s thinking · 20s in tools · 10s Switchboard overhead");
    expect(vm.current).toBe("currently thinking 10s");
    expect(vm.openStep).toBe("a model turn"); // the tail row's word for the same open span
    const thinking = vm.bar.filter((s) => s.term === "thinking");
    expect(thinking.map((s) => [s.ms, s.hatched])).toEqual([
      [30_000, false],
      [10_000, true],
    ]);
    expect(vm.bar.reduce((a, s) => a + s.ms, 0)).toBe(100_000);
    // Between a result and the next turn only the (uncounted) loop is open: no drill-down, no hatch.
    const between = buildTimeline({
      spans: live.filter((s) => s.spanId !== "t2"),
      losses: [],
      window: { start: 0, end: 100_000 },
      owner: "agent",
      totalMs: 100_000,
      phase: "live",
    });
    expect(between.current).toBe("");
    expect(between.openStep).toBe("");
    expect(between.bar.some((s) => s.hatched)).toBe(false);
  });

  it("delivering reads `currently delivering`; ended reads the delivery caption — `reply failed`, or nothing when no reply was measured", () => {
    expect(buildTimeline({ ...finishedReview, phase: "delivering" }).current).toBe(CURRENTLY_DELIVERING);
    expect(
      buildTimeline({ ...finishedReview, delivery: { finishedAt: 252_000, sealedAt: 253_000, replyOk: false } })
        .current,
    ).toBe("reply failed");
    expect(buildTimeline({ ...finishedReview, delivery: { finishedAt: 252_000 } }).current).toBe("");
  });

  it("a record cut to its budget prints the lost stretch as `not recorded (too large)`; a live page whose replay was elided prints `not loaded (the record has the full shape)`; neither is overhead", () => {
    const spans = [
      sp("root", "request", 0, 120_000),
      sp("hist", "dispatch.history", 0, 30_000, { parent: "root" }),
      sp("agent", "run.agent", 30_000, 120_000, { parent: "root" }),
      sp("t1", "model.turn", 30_000, 50_000, { parent: "agent" }),
      sp("c9", "tool.bash", 80_000, 120_000, { parent: "agent" }),
    ];
    const cut = buildTimeline({
      spans,
      losses: [{ from: 50_000, to: 80_000, kind: "lost" }],
      window: { start: 0, end: 120_000 },
      owner: "agent",
      totalMs: 120_000,
      phase: "ended",
      truncated: true,
    });
    expect(cut.lede).toBe("2m 00s — 30s getting ready · 20s thinking · 40s in tools · 30s not recorded (too large)");
    expect(cut.bar.find((s) => s.term === "not recorded")?.ms).toBe(30_000);
    const plain = buildTimeline({
      ...finishedReview,
      spans,
      losses: [{ from: 50_000, to: 80_000, kind: "lost" }],
      window: { start: 0, end: 120_000 },
      totalMs: 120_000,
      delivery: {},
    });
    expect(plain.lede).toContain("30s not recorded");
    expect(plain.lede).not.toContain("too large");
    const elided = buildTimeline({
      spans: spans.map((s) =>
        s.spanId === "root" || s.spanId === "agent" ? { ...s, endedAt: undefined, durationMs: undefined } : s,
      ),
      losses: [{ from: 50_000, to: 80_000, kind: "elided" }],
      window: { start: 0, end: 120_000 },
      owner: "agent",
      totalMs: 120_000,
      phase: "live",
    });
    expect(elided.lede).toBe(
      "2m 00s — 30s getting ready · 20s thinking · 40s in tools · 30s not loaded (the record has the full shape)",
    );
    expect(elided.bar.find((s) => s.term === "not loaded")?.ms).toBe(30_000);
  });

  it("a record with no root shows the header's total and `getting ready: not recorded (too large)`; a live page before its root shows the total alone", () => {
    const legacy = [sp("t1", "model.turn", 10_000, 40_000), sp("c1", "tool.bash", 40_000, 50_000)];
    const record = buildTimeline({
      spans: legacy,
      losses: [],
      window: { start: 0, end: 60_000 },
      owner: "agent",
      totalMs: 60_000,
      phase: "ended",
      delivery: {},
    });
    expect(record.lede).toBe("1m 00s");
    expect(record.note).toBe(NO_ROOT_NOTE);
    expect(record.shown).toBe(false);
    expect(record.bar).toEqual([]);
    expect(record.ranked).toEqual([]);
    const early = buildTimeline({
      spans: [],
      losses: [],
      window: { start: 0, end: 3_000 },
      owner: "agent",
      totalMs: 3_000,
      phase: "live",
    });
    expect(early.lede).toBe("3s");
    expect(early.note).toBe("");
  });

  it("below the gate the lede is the total and the dominant word, nothing else shown; a command run's `run.command` is its tools while an agent run's is setup", () => {
    const setupOnly = buildTimeline({
      spans: [sp("root", "request", 0, undefined), sp("hist", "dispatch.history", 0, undefined, { parent: "root" })],
      losses: [],
      window: { start: 0, end: 40_000 },
      owner: "agent",
      totalMs: 40_000,
      phase: "live",
    });
    expect(setupOnly.lede).toBe("40s — getting ready");
    expect(setupOnly.shown).toBe(false);
    expect(setupOnly.current).toBe("currently getting ready 40s");
    expect(setupOnly.openStep).toBe("reading the thread");
    const command = [
      sp("root", "request", 0, 10_000),
      sp("cmd", "run.command", 0, 10_000, { parent: "root", attrs: { command: "repo.test" } }),
    ];
    const asCommand = buildTimeline({
      spans: command,
      losses: [],
      window: { start: 0, end: 10_000 },
      owner: "command",
      totalMs: 10_000,
      phase: "ended",
      delivery: {},
    });
    expect(asCommand.lede).toBe("10s — in tools");
    const asAgent = buildTimeline({
      spans: command,
      losses: [],
      window: { start: 0, end: 10_000 },
      owner: "agent",
      totalMs: 10_000,
      phase: "ended",
      delivery: {},
    });
    expect(asAgent.lede).toBe("10s — getting ready");
  });

  it("debug carries the partition and the raw names — the one place they appear", () => {
    const vm = buildTimeline(finishedReview) as {
      debug: { partition: { windowMs: number }; spans: Array<{ name: string }> };
    };
    expect(vm.debug.partition.windowMs).toBe(252_000);
    expect(vm.debug.spans.map((s) => s.name)).toContain("dispatch.workspace.attach.clone");
    const visible = JSON.stringify({ ...buildTimeline(finishedReview), debug: undefined });
    expect(visible).not.toContain("dispatch.");
    expect(visible).not.toContain("model.turn");
  });
});
