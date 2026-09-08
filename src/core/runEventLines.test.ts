import { describe, expect, it } from "vitest";
import { parseRunEventLines } from "./runEventLines.js";

// Feature: features/run-friction.md — the input of `friction analyze`: JSON
// lines of RunEvents, or a raw SSE capture of `/runs/:id/events` (`data: {...}`
// frames), which is the same thing with a prefix — so `curl <live link>/events
// > run.sse` is directly analyzable.

describe("parseRunEventLines", () => {
  it("parses JSON lines of run events", () => {
    const text = [
      '{"type":"tool_call","tool":"bash","summary":"$ ls","at":1}',
      '{"type":"tool_result","tool":"bash","ok":true,"summary":"ok","at":2}',
    ].join("\n");
    expect(parseRunEventLines(text)).toEqual({
      events: [
        { type: "tool_call", tool: "bash", summary: "$ ls", at: 1 },
        { type: "tool_result", tool: "bash", ok: true, summary: "ok", at: 2 },
      ],
      skipped: 0,
    });
  });

  it("parses a raw SSE capture: data: frames, ignoring retry/event/comment lines and the end frame", () => {
    const text = [
      "retry: 3000",
      "",
      'data: {"type":"tool_call","tool":"bash","summary":"$ ls","at":1}',
      "",
      ": keepalive",
      'data: {"type":"run_note","kind":"wrap_up","summary":"w","at":9}',
      "",
      "event: end",
      "data: {}",
      "",
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events.map((e) => e.type)).toEqual(["tool_call", "run_note"]);
    expect(out.skipped).toBe(0); // the `{}` end payload is transport, not garbage
  });

  it("a payload with no type field is a transport frame, never garbage; an event-shaped payload this reader does not know is skipped and counted (features/tracing.md)", () => {
    const out = parseRunEventLines(
      [
        'data: {"sealedAt":1,"replyOk":true}',
        'data: {"finishedAt":5}',
        'data: {"type":"some_future_event","at":1}',
      ].join("\n"),
    );
    expect(out.events).toEqual([]);
    expect(out.skipped).toBe(1);
  });

  it("skips (and counts) malformed or non-event lines instead of throwing", () => {
    const text = [
      "not json",
      '{"type":"bogus"}',
      '{"no":"type"}',
      '{"type":"tool_call","tool":"bash","summary":"x"}',
      "42",
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events).toHaveLength(1);
    // `{"no":"type"}` is a transport frame (features/tracing.md), not garbage; the other three are.
    expect(out.skipped).toBe(3);
  });

  it("accepts every declared run_note kind, fleet_busy included (features/execution.md item 14)", () => {
    const text = [
      '{"type":"run_note","kind":"fleet_busy","summary":"⏳ Sandbox fleet busy — no free per-thread sandbox after waiting 300s","at":5}',
      '{"type":"run_note","kind":"sandbox_dead","summary":"dead","at":6}',
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events.map((e) => (e.type === "run_note" ? e.kind : e.type))).toEqual(["fleet_busy", "sandbox_dead"]);
    expect(out.skipped).toBe(0);
  });

  it("skips events whose fields have the wrong shape (a recognized type is not enough) — the analyzer must never be fed junk", () => {
    const text = [
      '{"type":"tool_call","tool":"bash","summary":42}',
      '{"type":"tool_call","tool":7,"summary":"$ ls"}',
      '{"type":"tool_result","tool":"bash","ok":"yes","summary":"x"}',
      '{"type":"tool_result","tool":"bash","ok":true,"summary":"x","at":"soon"}',
      '{"type":"run_note","kind":"nap","summary":"x"}',
      '{"type":"run_note","kind":"wrap_up","summary":"w","at":5}',
      '{"type":"tool_call","tool":"bash","summary":"$ ls","at":1}',
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events.map((e) => e.type)).toEqual(["run_note", "tool_call"]);
    expect(out.skipped).toBe(5);
  });

  it("accepts the timeline events (`input`, `assistant`, `answer`) when they carry text, skips them otherwise; `turn` needs numeric timing", () => {
    const text = [
      '{"type":"input","text":"fix the bug","at":1}',
      '{"type":"assistant","text":"checking…","at":2}',
      '{"type":"answer","text":"done","at":3}',
      '{"type":"input","text":42}',
      '{"type":"assistant"}',
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events.map((e) => e.type)).toEqual(["input", "assistant", "answer"]);
    expect(out.skipped).toBe(2);
    const turns = parseRunEventLines(
      [
        '{"type":"turn","startedAt":1,"durationMs":5000,"stopReason":"tool_use","at":5001}',
        '{"type":"turn","startedAt":"x","at":2}',
      ].join("\n"),
    );
    expect(turns.events.map((e) => e.type)).toEqual(["turn"]);
    expect(turns.skipped).toBe(1);
    // `run_meta` (live-view item 19) needs its agent; the model is optional (a
    // command run resolves none — features/tracing.md) and so are the repo fields
    const metas = parseRunEventLines(
      [
        '{"type":"run_meta","agent":"review","model":"anthropic/claude-fable-5","repo":"acme/web","pr":281,"at":1}',
        '{"type":"run_meta","agent":"review"}',
        '{"type":"run_meta","model":"anthropic/claude-fable-5"}',
      ].join("\n"),
    );
    expect(metas.events.map((e) => e.type)).toEqual(["run_meta", "run_meta"]);
    expect(metas.skipped).toBe(1);
  });

  it("accepts the span records (features/tracing.md): a start needs spanId + name, an end also numeric startedAt/durationMs and an ok|error status", () => {
    const out = parseRunEventLines(
      [
        '{"type":"span_start","spanId":"s1","name":"dispatch.compose","at":1}',
        '{"type":"span_end","spanId":"s1","name":"dispatch.compose","startedAt":1,"durationMs":40,"status":"ok","at":41}',
        '{"type":"span_end","spanId":"s2","name":"tool.bash","startedAt":1,"durationMs":40,"status":"weird"}',
        '{"type":"span_start","name":"no id"}',
        '{"type":"span_end","spanId":"s3","name":"x","startedAt":"1","durationMs":40,"status":"ok"}',
      ].join("\n"),
    );
    expect(out.events.map((e) => e.type)).toEqual(["span_start", "span_end"]);
    expect(out.skipped).toBe(3);
  });

  it("accepts `skill_use` when it carries skill + agent + numeric bodyBytes, skips it otherwise", () => {
    const ok = {
      type: "skill_use",
      skill: "code-review-and-quality",
      description: "d",
      agent: "review",
      bodyBytes: 1200,
      at: 1,
    };
    const bad = { type: "skill_use", skill: "x", agent: "review" }; // no bodyBytes
    const { events, skipped } = parseRunEventLines([JSON.stringify(ok), JSON.stringify(bad)].join("\n"));
    expect(events).toEqual([ok]);
    expect(skipped).toBe(1);
  });

  it("accepts `review_artifact` (reading_diff + string diff + known poweredBy), skips it otherwise", () => {
    const ok = {
      type: "review_artifact",
      artifact: "reading_diff",
      poweredBy: "meat",
      baseRef: "main",
      diff: "d",
      truncated: false,
      at: 1,
    };
    const bad = { type: "review_artifact", artifact: "reading_diff", poweredBy: "carrier-pigeon", diff: "d" };
    const { events, skipped } = parseRunEventLines([JSON.stringify(ok), JSON.stringify(bad)].join("\n"));
    expect(events).toEqual([ok]);
    expect(skipped).toBe(1);
  });

  it("accepts `pr_description` when it carries an object description, skips a string or null one", () => {
    const ok = { type: "pr_description", description: { title: "Fix the gate" }, at: 1 };
    const badString = { type: "pr_description", description: "not an object" };
    const badNull = { type: "pr_description", description: null };
    const { events, skipped } = parseRunEventLines([ok, badString, badNull].map((e) => JSON.stringify(e)).join("\n"));
    expect(events).toEqual([ok]);
    expect(skipped).toBe(2);
  });

  it("accepts `pr_opened` when it carries url + number + created, skips it otherwise", () => {
    const ok = { type: "pr_opened", url: "https://github.com/acme/api/pull/7", number: 7, created: true, at: 2 };
    const bad = { type: "pr_opened", url: "https://github.com/acme/api/pull/7" }; // no number/created
    const { events, skipped } = parseRunEventLines([ok, bad].map((e) => JSON.stringify(e)).join("\n"));
    expect(events).toEqual([ok]);
    expect(skipped).toBe(1);
  });

  it("accepts `ship_round` when it carries a numeric index + agent and outcome strings, skips it otherwise", () => {
    const ok = { type: "ship_round", index: 1, agent: "review", outcome: "approve", at: 3 };
    const badIndex = { type: "ship_round", index: "1", agent: "review", outcome: "approve" };
    const noAgent = { type: "ship_round", index: 1, outcome: "approve" };
    const noOutcome = { type: "ship_round", index: 1, agent: "review" };
    const { events, skipped } = parseRunEventLines(
      [ok, badIndex, noAgent, noOutcome].map((e) => JSON.stringify(e)).join("\n"),
    );
    expect(events).toEqual([ok]);
    expect(skipped).toBe(3);
  });

  it("empty input yields no events", () => {
    expect(parseRunEventLines("")).toEqual({ events: [], skipped: 0 });
  });
});
