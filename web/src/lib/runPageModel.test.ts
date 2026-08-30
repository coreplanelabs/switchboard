import { describe, expect, it } from "vitest";
import { createRunPageModel, runningHeader, runSpan, type StepVm } from "./runPageModel";

// The run page's fold, driven by real event streams (the same shapes the SSE
// stream and the history seed carry). One fold for both — `handle` is the
// single entry point, exactly like the old inline script's.

const input = { type: "input", text: "fix the build", at: 1000, source: { channel: "dev", user: "justin", url: "https://acme.slack.com/x" } };
const assistant = (text: string, at: number) => ({ type: "assistant", text, at });
const call = (id: string, summary: string, at: number, tool = "bash") => ({ type: "tool_call", callId: id, tool, summary, at });
const result = (id: string, over: Record<string, unknown> = {}) => ({ type: "tool_result", callId: id, tool: "bash", ok: true, summary: "", output: "out", ...over });

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
    m.handle({ type: "turn", durationMs: 304_000, at: 10, usage: { inputTokens: 12_300, outputTokens: 800 } });
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
    m.handle({ type: "turn", durationMs: 5_000, at: 10 });
    m.handle({ type: "turn", durationMs: 61_000, at: 20 });
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
    m.handle({ type: "turn", durationMs: 61_000, at: 20 });
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
    m.handle({ type: "skill_use", skill: "pdf", description: "Fill PDFs", agent: "coding", bodyBytes: 2048, source: "https://example.com/x", at: 3 });
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
    m.handle({ type: "run_note", summary: "stop requested (soft): finishing up", kind: "stop_requested", mode: "soft", at: 5 });
    const note = m.state.log[0];
    expect(note.kind).toBe("note");
    expect(m.state.stopMode).toBe("soft");
  });

  it("replay notes (transport notices) render as replay rows", () => {
    const m = model();
    m.handle({ type: "replay_note", summary: "3 events omitted" });
    const note = m.state.log[0];
    expect(note.kind).toBe("note");
    if (note.kind === "note") {
      expect(note.replay).toBe(true);
      expect(note.text).toBe("3 events omitted");
    }
  });
});

describe("header stopwatch (item 22)", () => {
  it("running header = runner-clock span + wall time since the last event arrived; runSpan is the finished duration", () => {
    const m = model();
    const wall = Date.now();
    m.handle({ type: "assistant", text: "x", at: 10_000 });
    m.handle({ type: "assistant", text: "y", at: 40_000 });
    expect(runSpan(m.state)).toBe("30s");
    const header = runningHeader(m.state, m.state.lastEventAt + 5_000);
    expect(header).toBe("running · 35s");
    expect(wall).toBeGreaterThan(0);
  });

  it("no events yet → no running header, empty span", () => {
    const m = model();
    expect(runningHeader(m.state, Date.now())).toBeNull();
    expect(runSpan(m.state)).toBe("");
  });
});
