import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRunPageModel,
  elidedText,
  liveWait,
  modelName,
  deliveryCaption,
  parseEndFrame,
  parseFinishedFrame,
  parseReplayElided,
  runnerNow,
  createRunClock,
  sameModel,
  type StepVm,
} from "./runPageModel";

// The run page's fold, driven by real event streams (the same shapes the SSE
// stream and the history seed carry). One fold for both — `handle` is the
// single entry point, exactly like the old inline script's.

const input = {
  type: "input",
  text: "fix the build",
  at: 1000,
  source: { channel: "dev", user: "justin", url: "https://acme.slack.com/x" },
};
const assistant = (text: string, at: number) => ({ type: "assistant", text, at });
/** A model turn's timing record (features/tracing.md): the `model.turn` span end the runner emits. */
const modelTurn = (t: {
  durationMs: number;
  at: number;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}) => ({
  type: "span_end",
  spanId: `turn-${t.at}`,
  name: "model.turn",
  startedAt: t.at - t.durationMs,
  durationMs: t.durationMs,
  status: "ok",
  attrs: { stopReason: "tool_use", ...(t.model ? { model: t.model } : {}), ...(t.usage ?? {}) },
  at: t.at,
});
const call = (id: string, summary: string, at: number, tool = "bash") => ({
  type: "tool_call",
  callId: id,
  tool,
  summary,
  at,
});
const result = (id: string, over: Record<string, unknown> = {}) => ({
  type: "tool_result",
  callId: id,
  tool: "bash",
  ok: true,
  summary: "",
  output: "out",
  ...over,
});

function model(openTags?: string[]) {
  return createRunPageModel({ openTags });
}

function step(m: ReturnType<typeof model>, i = 0): StepVm {
  const steps = m.state.log.filter((l): l is StepVm => l.kind === "step");
  return steps[i];
}

describe("request / context / answer / placeholder", () => {
  it("paints the request with its source, clears the placeholder on the FIRST change of any kind (#209)", () => {
    const m = model();
    expect(m.state.placeholder).toBe(true);
    m.handle(input);
    expect(m.state.placeholder).toBe(false);
    expect(m.state.request?.text).toBe("fix the build");
    expect(m.state.request?.source?.channel).toBe("dev");
  });

  it("a later input is a steered follow-up: its own timeline block where the run read it — it never replaces the request (one run, several inputs)", () => {
    const m = model();
    m.handle(input);
    m.handle({ type: "tool_call", callId: "c1", tool: "bash", summary: "$ npm test", at: 1500 });
    m.handle({
      type: "input",
      text: "also the numbers",
      at: 2000,
      source: { user: "bob", url: "https://acme.slack.com/y" },
    });
    m.handle({ type: "run_note", kind: "follow_up", summary: "follow-up folded in: also the numbers", at: 2000 });
    m.handle({ type: "input", text: "and a chart", at: 3000 });
    m.handle({ type: "run_note", kind: "follow_up", summary: "follow-up folded in: and a chart", at: 3000 });
    expect(m.state.request?.text).toBe("fix the build");
    // the step first, then the two follow-ups in arrival order; the snippet
    // notes are not rows — the block IS the marker
    expect(m.state.log.map((i) => i.kind)).toEqual(["step", "followup", "followup"]);
    const followUps = m.state.log.filter((i) => i.kind === "followup");
    expect(followUps.map((f) => f.input.text)).toEqual(["also the numbers", "and a chart"]);
    expect(followUps[0].input.source?.user).toBe("bob");
    expect(followUps[0].input.at).toBe(2000);
    expect(followUps[1].input.source).toBeUndefined();
  });

  it("every other run note is still a row (only the follow-up snippet is folded into its block)", () => {
    const m = model();
    m.handle(input);
    m.handle({ type: "run_note", kind: "stop_requested", mode: "soft", summary: "stop requested (soft)", at: 2000 });
    expect(m.state.log.map((i) => i.kind)).toEqual(["note"]);
  });

  it("collects context turns outside the log", () => {
    const m = model();
    m.handle({ type: "context", text: "earlier turn", at: 5 });
    m.handle({ type: "context", text: "another", at: 6 });
    expect(m.state.context.map((c) => c.text)).toEqual(["earlier turn", "another"]);
    expect(m.state.log).toHaveLength(0);
  });

  it("the answer lands below the log; the step's group stays open (the tally bars are the narrative)", () => {
    const m = model();
    m.handle(assistant("running tests", 1));
    m.handle(call("c1", "$ npm test", 2));
    m.handle(call("c2", "$ npm run build", 3));
    m.handle(result("c1"));
    m.handle(result("c2"));
    expect(step(m).groupOpen).toBe(true);
    m.handle({ type: "answer", text: "all done", at: 9 });
    expect(m.state.answer?.text).toBe("all done");
    expect(step(m).groupOpen).toBe(true); // never auto-folded
  });
});

describe("steps and turns", () => {
  it("a turn is held for the step it produced and painted in that step's head (chip reads the bare duration)", () => {
    const m = model();
    m.handle(modelTurn({ durationMs: 304_000, at: 10, usage: { inputTokens: 12_300, outputTokens: 800 } }));
    expect(m.state.log).toHaveLength(0); // held
    m.handle(assistant("now I will test", 11));
    const s = step(m);
    expect(s.turn?.chip).toBe("5m 04s");
    expect(s.turn?.quick).toBe(false);
    expect(s.turn?.facts).toEqual(["12.3k in", "800 out"]);
    expect(s.narration).toBe("now I will test");
  });

  it("a sub-minute turn is quiet; a turn followed by another turn is flushed as its own row", () => {
    const m = model();
    m.handle(modelTurn({ durationMs: 5_000, at: 10 }));
    m.handle(modelTurn({ durationMs: 61_000, at: 20 }));
    expect(m.state.log).toHaveLength(1);
    const row = m.state.log[0];
    expect(row.kind).toBe("turn");
    if (row.kind === "turn") expect(row.turn.quick).toBe(true);
    m.handle({ type: "answer", text: "done" });
    const flushed = m.state.log[1];
    expect(flushed.kind).toBe("turn");
    if (flushed.kind === "turn") {
      expect(flushed.turn.chip).toBe("1m 01s");
      expect(flushed.note).toBe("wrote the answer below");
    }
  });

  it("flushPendingTurn paints the held turn when the stream ends without an answer", () => {
    const m = model();
    m.handle(modelTurn({ durationMs: 61_000, at: 20 }));
    m.flushPendingTurn("the run ended here");
    const row = m.state.log[0];
    expect(row.kind).toBe("turn");
    if (row.kind === "turn") expect(row.note).toBe("the run ended here");
  });

  it("a new step marks the previous one no longer live", () => {
    const m = model();
    m.handle(assistant("one", 1));
    expect(step(m, 0).live).toBe(true);
    m.handle(assistant("two", 2));
    expect(step(m, 0).live).toBe(false);
    expect(step(m, 1).live).toBe(true);
  });
});

describe("calls, groups, folding", () => {
  it("a call carries its exit code and reads timed out on 124 only — a SIGKILL 137 is a failure, not a timeout (item 24)", () => {
    const m = createRunPageModel();
    m.handle(assistant("work", 1));
    m.handle(call("c1", "$ pnpm typegen", 2));
    m.handle(call("c2", "$ pnpm test", 3));
    m.handle(call("c3", "$ git status", 4));
    m.handle(call("c4", "$ pnpm build", 5));
    m.handle(result("c1", { ok: false, exitCode: 124, at: 2_000 }));
    m.handle(result("c2", { ok: false, exitCode: 1, at: 3_000 }));
    m.handle(result("c3", { ok: true, exitCode: 0, at: 4_000 }));
    m.handle(result("c4", { ok: false, exitCode: 137, at: 5_000 }));
    const calls = step(m).items.flatMap((i) => (i.kind === "call" ? [i.call] : []));
    expect(calls.map((c) => [c.exitCode, c.timedOut])).toEqual([
      [124, true],
      [1, false],
      [0, false],
      [137, false],
    ]);
  });

  it("cards carry the classification: shell $, headline vs full title, facts, status transitions", () => {
    const m = model();
    m.handle(call("c1", "$ npm test", 2));
    const s = step(m);
    const item = s.items[0];
    expect(item.kind).toBe("call");
    if (item.kind !== "call") return;
    expect(item.call.shell).toBe(true);
    expect(item.call.title).toBe("npm test");
    expect(item.call.status).toBe("running");
    m.handle(result("c1", { ok: false, exitCode: 1, at: 4000, output: "boom" }));
    expect(item.call.status).toBe("failed");
    expect(item.call.facts[0]).toBe("exit 1");
    expect(item.call.output).toBe("boom");
  });

  it("update_status renders as ONE quiet row, never a card — its result must not duplicate it", () => {
    const m = model();
    m.handle(call("q1", "update_status …", 2, "update_status"));
    m.handle(result("q1", { tool: "update_status" }));
    expect(step(m).items).toHaveLength(1);
    const item = step(m).items[0];
    expect(item.kind).toBe("quiet");
    if (item.kind === "quiet") expect(item.text).toContain("status checklist updated");
  });

  it("failed and infra calls open by default; ok calls stay collapsed; ?open= overrides; open=all opens everything", () => {
    const m = model();
    m.handle(call("c1", "$ npm test", 2));
    m.handle(call("c2", "$ git diff", 3));
    m.handle(result("c1", { ok: false, exitCode: 1 }));
    m.handle(result("c2", { ok: true }));
    const calls = step(m).items.filter((i) => i.kind === "call");
    expect(calls[0].kind === "call" && calls[0].call.open).toBe(true); // failed
    expect(calls[1].kind === "call" && calls[1].call.open).toBe(false);

    const tests = model(["tests"]);
    tests.handle(call("c1", "$ npm test", 2));
    tests.handle(call("c2", "$ git diff", 3));
    const tcalls = step(tests).items.filter((i) => i.kind === "call");
    expect(tcalls[0].kind === "call" && tcalls[0].call.open).toBe(true);
    expect(tcalls[1].kind === "call" && tcalls[1].call.open).toBe(false);

    const all = model(["all"]);
    all.handle(call("c2", "$ git diff", 3));
    const acalls = step(all).items.filter((i) => i.kind === "call");
    expect(acalls[0].kind === "call" && acalls[0].call.open).toBe(true);
  });

  it("groups stay open as new steps begin — they are never auto-folded; only the viewer's toggle closes one, and it sticks", () => {
    const m = model();
    m.handle(assistant("one", 1));
    m.handle(call("c1", "$ a", 2));
    m.handle(call("c2", "$ b", 3));
    m.handle(result("c1"));
    m.handle(result("c2"));
    m.handle(assistant("two", 4));
    expect(step(m, 0).groupOpen).toBe(true); // clean AND open — the group bar is the narrative

    const manual = model();
    manual.handle(assistant("one", 1));
    manual.handle(call("c1", "$ a", 2));
    manual.handle(call("c2", "$ b", 3));
    manual.handle(result("c1"));
    manual.toggleGroup(step(manual, 0)); // viewer closed it by hand mid-run …
    expect(step(manual, 0).groupOpen).toBe(false);
    manual.handle(assistant("two", 4));
    expect(step(manual, 0).groupOpen).toBe(false); // … and nothing re-opens a clean closed group
    expect(step(manual, 0).manual).toBe(true);
  });

  it("a step still running (or failed) forces its group open even after a manual close is superseded by new activity", () => {
    const m = model();
    m.handle(assistant("one", 1));
    m.handle(call("c1", "$ a", 2));
    m.handle(call("c2", "$ b", 3));
    m.toggleGroup(step(m));
    expect(step(m).groupOpen).toBe(false);
    m.handle(result("c1", { ok: false }));
    expect(step(m).groupOpen).toBe(true); // a failure re-opens even a manually closed group
  });

  it("expand all opens every card (later results keep it), collapse all closes them; new cards while expanded start open", () => {
    const m = model();
    m.handle(call("c1", "$ a", 2));
    m.setAllOpen(true);
    const first = step(m).items[0];
    expect(first.kind === "call" && first.call.open).toBe(true);
    m.handle(call("c2", "$ b", 3));
    const second = step(m).items[1];
    expect(second.kind === "call" && second.call.open).toBe(true);
    m.setAllOpen(false);
    expect(first.kind === "call" && first.call.open).toBe(false);
    expect(second.kind === "call" && second.call.open).toBe(false);
  });

  it("a skill lands as its own row inside the step, never a call card", () => {
    const m = model();
    m.handle(call("c1", "use_skill pdf", 2, "use_skill"));
    m.handle({
      type: "skill_use",
      skill: "pdf",
      description: "Fill PDFs",
      agent: "coding",
      bodyBytes: 2048,
      source: "https://example.com/x",
      at: 3,
    });
    const items = step(m).items;
    expect(items[1].kind).toBe("skill");
    if (items[1].kind === "skill") {
      expect(items[1].skill.name).toBe("pdf");
      expect(items[1].skill.source).toBe("https://example.com/x");
    }
  });
});

describe("notes and stops", () => {
  it("run notes land in the log; a stop note marks the run stopping", () => {
    const m = model();
    m.handle({
      type: "run_note",
      summary: "stop requested (soft): finishing up",
      kind: "stop_requested",
      mode: "soft",
      at: 5,
    });
    const note = m.state.log[0];
    expect(note.kind).toBe("note");
    expect(m.state.stopMode).toBe("soft");
  });

  it("replay notes (transport notices) render as replay rows", () => {
    const m = model();
    m.handle({ type: "replay_note", summary: "3 records omitted" });
    const note = m.state.log[0];
    expect(note.kind).toBe("note");
    if (note.kind === "note") {
      expect(note.replay).toBe(true);
      expect(note.text).toBe("3 records omitted");
    }
  });
});

// Feature: features/live-view.md item 5 — a live replay that skipped retained events.
describe("replay_elided frames (item 5)", () => {
  it("parseReplayElided accepts two positive integers in order and rejects everything else", () => {
    expect(parseReplayElided('{"fromSeq":1,"toSeq":1000}')).toEqual({ fromSeq: 1, toSeq: 1000 });
    expect(parseReplayElided('{"fromSeq":7,"toSeq":7}')).toEqual({ fromSeq: 7, toSeq: 7 });
    for (const bad of [
      undefined,
      "",
      "garbage",
      "[]",
      "null",
      '{"fromSeq":0,"toSeq":3}',
      '{"fromSeq":5,"toSeq":3}',
      '{"fromSeq":1.5,"toSeq":3}',
      '{"fromSeq":"1","toSeq":3}',
      '{"toSeq":3}',
    ]) {
      expect(parseReplayElided(bad)).toBeNull();
    }
  });

  it("noteElided adds a replay row naming the range and where it still is, and keeps the range for the partition", () => {
    const m = model();
    expect(m.state.placeholder).toBe(true);
    m.noteElided({ fromSeq: 1, toSeq: 1000 });
    expect(m.state.elided).toEqual([{ fromSeq: 1, toSeq: 1000 }]);
    expect(m.state.placeholder).toBe(false);
    const note = m.state.log[0];
    expect(note.kind).toBe("note");
    if (note.kind === "note") {
      expect(note.replay).toBe(true);
      expect(note.text).toBe("1000 events not loaded (events 1–1000) — the record has them");
    }
    expect(elidedText({ fromSeq: 7, toSeq: 7 })).toBe("1 event not loaded (event 7) — the record has them");
  });
});

// Feature: features/tracing.md — a streamed span is one row, named through the display table.
describe("span rows", () => {
  it("a span_start opens one row under its display name; the matching span_end closes the same row with its duration and status; a tool span opens none", () => {
    const m = model();
    m.handle({ type: "span_start", spanId: "d1", name: "dispatch.compose", at: 1_000 });
    expect(m.state.log).toHaveLength(1);
    const row = m.state.log[0];
    expect(row).toMatchObject({ kind: "span", spanId: "d1", text: "preparing the prompt", open: true, at: 1_000 });
    m.handle({
      type: "span_end",
      spanId: "d1",
      name: "dispatch.compose",
      startedAt: 1_000,
      durationMs: 250,
      status: "error",
      at: 1_250,
    });
    expect(m.state.log).toHaveLength(1);
    expect(m.state.log[0]).toMatchObject({ kind: "span", open: false, durationMs: 250, status: "error" });
    m.handle({ type: "span_start", spanId: "t1", name: "tool.bash", attrs: { callId: "c1" }, at: 2_000 });
    expect(m.state.log).toHaveLength(1);
    expect(m.state.placeholder).toBe(false);
  });
});

describe("the run's model — badged on the pending-turn row, flagged when it switches", () => {
  const meta = { type: "run_meta", agent: "coding", model: "anthropic/claude-fable-5", at: 5 };

  it("run_meta declares the model; a stamped turn confirms it (no switch); a turn on a different model switches and becomes the current one", () => {
    const m = model();
    expect(m.state.model).toBeNull();
    m.handle(meta);
    expect(m.state.model).toBe("anthropic/claude-fable-5");
    m.handle(modelTurn({ durationMs: 5_000, model: "anthropic/claude-fable-5", at: 10 }));
    m.handle(assistant("one", 11));
    expect(step(m, 0).turn).toMatchObject({ model: "anthropic/claude-fable-5", switched: false });
    m.handle(modelTurn({ durationMs: 5_000, model: "anthropic/claude-opus-5", at: 20 }));
    m.handle(assistant("two", 21));
    expect(step(m, 1).turn).toMatchObject({ model: "anthropic/claude-opus-5", switched: true });
    expect(m.state.model).toBe("anthropic/claude-opus-5");
    // back again: also a switch, relative to the model the run was on
    m.handle(modelTurn({ durationMs: 5_000, model: "anthropic/claude-fable-5", at: 30 }));
    m.handle(assistant("three", 31));
    expect(step(m, 2).turn?.switched).toBe(true);
  });

  it("an unstamped turn (a stream from before model stamps) keeps the declared model and never reads as a switch; the first stamped turn of a meta-less run is not a switch either", () => {
    const m = model();
    m.handle(meta);
    m.handle(modelTurn({ durationMs: 5_000, at: 10 }));
    m.handle(assistant("one", 11));
    // the head still names the run's declared model — every head carries its badge
    expect(step(m, 0).turn).toMatchObject({ model: "anthropic/claude-fable-5", switched: false });
    expect(m.state.model).toBe("anthropic/claude-fable-5");

    const bare = model();
    bare.handle(modelTurn({ durationMs: 5_000, model: "openai/gpt-5", at: 10 }));
    bare.handle(assistant("one", 11));
    expect(step(bare, 0).turn).toMatchObject({ model: "openai/gpt-5", switched: false });
    expect(bare.state.model).toBe("openai/gpt-5");

    const nothing = model();
    nothing.handle(modelTurn({ durationMs: 5_000, at: 10 }));
    nothing.handle(assistant("one", 11));
    expect(step(nothing, 0).turn?.model).toBeUndefined(); // nothing known → no badge, no guess
    expect(step(nothing, 0).turn?.switched).toBe(false);
  });

  it("a bare stamp (v0.4.0's runner) naming the model run_meta already names by its ref is NOT a switch — the head and the run keep the ref; a bare id for a different model still switches", () => {
    const m = model();
    m.handle(meta); // anthropic/claude-fable-5
    m.handle(modelTurn({ durationMs: 4_900, model: "claude-fable-5", at: 10 }));
    m.handle(assistant("one", 11));
    expect(step(m, 0).turn).toMatchObject({ model: "anthropic/claude-fable-5", switched: false });
    expect(m.state.model).toBe("anthropic/claude-fable-5");
    m.handle(modelTurn({ durationMs: 4_900, model: "claude-opus-5", at: 20 }));
    m.handle(assistant("two", 21));
    expect(step(m, 1).turn).toMatchObject({ model: "claude-opus-5", switched: true });
    expect(m.state.model).toBe("claude-opus-5");
  });

  it("sameModel: equal refs; a bare id against a ref with that name; never two refs with different providers", () => {
    expect(sameModel("anthropic/claude-fable-5", "anthropic/claude-fable-5")).toBe(true);
    expect(sameModel("claude-fable-5", "anthropic/claude-fable-5")).toBe(true);
    expect(sameModel("anthropic/claude-fable-5", "claude-fable-5")).toBe(true);
    expect(sameModel("openai/claude-fable-5", "anthropic/claude-fable-5")).toBe(false);
    expect(sameModel("claude-fable-5", "claude-opus-5")).toBe(false);
  });

  it("modelName is the part after the provider slash; a bare name is itself; nothing known reads `model`", () => {
    expect(modelName("anthropic/claude-fable-5")).toBe("claude-fable-5");
    expect(modelName("gpt-5")).toBe("gpt-5");
    expect(modelName("acme/")).toBe("acme/");
    expect(modelName(null)).toBe("model");
    expect(modelName(undefined)).toBe("model");
  });
});

describe("the `finished` frame freezes the header at the server's stamp (features/tracing.md)", () => {
  it("elapsedAt runs the one definition against the frame's finishedAt, from receivedAt when the seed has it", () => {
    expect(createRunClock({ serverNow: 1_000_000, startedAt: 940_000 }, 5_000).elapsedAt(970_000)).toBe(30_000);
    expect(
      createRunClock({ serverNow: 1_000_000, startedAt: 940_000, receivedAt: 900_000 }, 5_000).elapsedAt(970_000),
    ).toBe(70_000);
    expect(createRunClock({ serverNow: 1_000_000, startedAt: 940_000 }, 5_000).elapsedAt(900_000)).toBe(0); // skew never negative
  });

  it("parseFinishedFrame accepts one finite positive stamp and rejects everything else", () => {
    expect(parseFinishedFrame('{"finishedAt":970000}')).toEqual({ finishedAt: 970_000 });
    for (const bad of [undefined, "", "garbage", "null", "[]", '{"finishedAt":"970000"}', '{"finishedAt":0}', "{}"]) {
      expect(parseFinishedFrame(bad)).toBeNull();
    }
  });
});

describe("the `end` frame's stamps and the delivery caption (features/tracing.md)", () => {
  it("parseEndFrame keeps a finite positive sealedAt and a boolean replyOk, and nothing else; a stored stream's `{}` is empty", () => {
    expect(parseEndFrame('{"sealedAt":1003000,"replyOk":true}')).toEqual({ sealedAt: 1_003_000, replyOk: true });
    expect(parseEndFrame('{"sealedAt":1003000}')).toEqual({ sealedAt: 1_003_000 });
    expect(parseEndFrame('{"sealedAt":1003000,"replyOk":false}')).toEqual({ sealedAt: 1_003_000, replyOk: false });
    for (const empty of [
      "{}",
      undefined,
      "",
      "garbage",
      "null",
      '{"sealedAt":"x","replyOk":"yes"}',
      '{"sealedAt":0}',
    ]) {
      expect(parseEndFrame(empty)).toEqual({});
    }
  });

  it("deliveryCaption: `delivered in Ns` only when the reply landed and both stamps are known; `reply failed` when it threw; nothing otherwise", () => {
    expect(deliveryCaption({ finishedAt: 1_000_000, sealedAt: 1_002_400, replyOk: true })).toBe("delivered in 2s");
    expect(deliveryCaption({ finishedAt: 1_000_000, sealedAt: 1_000_000, replyOk: true })).toBe("delivered in 0s");
    expect(deliveryCaption({ finishedAt: 1_000_000, sealedAt: 999_000, replyOk: true })).toBe("delivered in 0s"); // skew never negative
    expect(deliveryCaption({ finishedAt: 1_000_000, sealedAt: 1_002_400, replyOk: false })).toBe("reply failed");
    expect(deliveryCaption({ replyOk: false })).toBe("reply failed");
    expect(deliveryCaption({ finishedAt: 1_000_000, sealedAt: 1_002_400 })).toBe(""); // no attempt measured
    expect(deliveryCaption({ finishedAt: 1_000_000, replyOk: true })).toBe(""); // no seal stamp
    expect(deliveryCaption({})).toBe("");
  });
});

describe("header stopwatch (item 22)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the header's duration is the one definition on the projected server clock: received (or started) → serverNow plus the browser time since the seed, never an event stamp", () => {
    const clock = createRunClock({ serverNow: 1_000_000, startedAt: 940_000 }, 5_000);
    expect(clock.now(5_000)).toBe(1_000_000);
    expect(clock.elapsedMs(5_000)).toBe(60_000);
    expect(clock.elapsedMs(35_000)).toBe(90_000);
    // receivedAt opens the window before startedAt
    const fromReceipt = createRunClock({ serverNow: 1_000_000, startedAt: 940_000, receivedAt: 900_000 }, 5_000);
    expect(fromReceipt.elapsedMs(5_000)).toBe(100_000);
    // a finished seed is frozen whatever the browser clock says
    const done = createRunClock({ serverNow: 1_000_000, startedAt: 940_000, finishedAt: 970_000 }, 5_000);
    expect(done.elapsedMs(999_999)).toBe(30_000);
  });

  it("a frame without a runner stamp (a replay notice) never moves the clock — the stopwatch cannot reset on a reconnect", () => {
    const m = model();
    vi.setSystemTime(1_000_000);
    m.handle({ type: "assistant", text: "x", at: 10_000 });
    vi.setSystemTime(1_600_000); // ten minutes later the stream reconnects and replays
    m.handle({ type: "replay_note", summary: "replaying last 200 of 300 events" });
    expect(m.state.lastAtWall).toBe(1_000_000);
    expect(runnerNow(m.state, 1_600_000)).toBe(610_000);
  });

  it("span records never move the runner clock or the stream's first/last stamps; no stamped events yet → no clock", () => {
    const m = model();
    expect(runnerNow(m.state, Date.now())).toBeNull();
    vi.setSystemTime(1_000_000);
    m.handle({ type: "span_start", spanId: "s", name: "dispatch.history", at: 5_000 });
    expect(m.state.firstAt).toBeNull();
    m.handle({ type: "assistant", text: "x", at: 10_000 });
    m.handle({
      type: "span_end",
      spanId: "s",
      name: "dispatch.history",
      startedAt: 5_000,
      durationMs: 90_000,
      status: "ok",
      at: 95_000,
    });
    expect(m.state.firstAt).toBe(10_000);
    expect(m.state.lastAt).toBe(10_000);
  });
});

describe("live wait — what the run is waiting on, and for how long", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("before the first stamped event the tail is `starting`", () => {
    const m = model();
    expect(liveWait(m.state, m.pendingCall(), Date.now())).toEqual({ kind: "starting" });
  });

  it("a running call: the tail names the OLDEST un-resulted card and counts from ITS start on the runner clock — not from the last frame", () => {
    const m = model();
    vi.setSystemTime(1_000_000);
    m.handle(input);
    m.handle(call("c1", "$ pnpm run typegen 2>&1 | tail -5", 3_000));
    m.handle(call("c2", "$ echo later", 3_500));
    // A frame with no stamp arrives much later (a reconnect's replay notice): the wait must not restart.
    vi.setSystemTime(1_900_000);
    m.handle({ type: "replay_note", summary: "replaying" });
    const tail = liveWait(m.state, m.pendingCall(), 2_200_000);
    expect(tail.kind).toBe("call");
    if (tail.kind !== "call") return;
    expect(tail.call.headline).toBe("pnpm run typegen 2>&1 | tail -5");
    // runner clock now = 3_500 + (2_200_000 − 1_000_000) = 1_203_500; the call began at 3_000.
    expect(tail.elapsedMs).toBe(1_200_500);
  });

  it("between calls the tail is `thinking` and counts from the last stamped event; amber (slow) past a minute — the threshold of the head it becomes", () => {
    const m = model();
    vi.setSystemTime(1_000_000);
    m.handle(call("c1", "$ npm test", 3_000));
    vi.setSystemTime(1_004_000);
    m.handle(result("c1", { at: 7_000 }));
    expect(m.pendingCall()).toBeNull();
    expect(liveWait(m.state, null, 1_010_000)).toEqual({ kind: "thinking", elapsedMs: 6_000, slow: false });
    expect(liveWait(m.state, null, 1_064_000)).toEqual({ kind: "thinking", elapsedMs: 60_000, slow: true });
  });

  it("a quiet call (update_status) is never what the run waits on", () => {
    const m = model();
    m.handle(call("q1", "update_status", 3_000, "update_status"));
    expect(m.pendingCall()).toBeNull();
    m.handle(call("c1", "$ npm test", 3_100));
    expect(m.pendingCall()?.id).toBe("c1");
  });
});
