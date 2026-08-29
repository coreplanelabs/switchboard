import { describe, expect, it } from "vitest";
import { inProgressHint, parseFrictionArgs, parseRunEventLines } from "./frictionCli.js";
import { analyzeRunFriction } from "./core/runFriction.js";

// Feature: features/run-friction.md — the read-only CLI over a saved run
// stream. Input is JSON-lines of RunEvents, or a raw SSE capture of
// `/runs/:id/events` (`data: {...}` frames), which is the same thing with a
// prefix — so `curl <live link>/events > run.sse` is directly analyzable.

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

  it("skips (and counts) malformed or non-event lines instead of throwing", () => {
    const text = ["not json", '{"type":"bogus"}', '{"no":"type"}', '{"type":"tool_call","tool":"bash","summary":"x"}', "42"].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events).toHaveLength(1);
    expect(out.skipped).toBe(4);
  });

  it("skips events whose fields have the wrong shape (a recognized type is not enough) — the analyzer must never be fed junk", () => {
    const text = [
      '{"type":"tool_call","tool":"bash","summary":42}', // non-string summary
      '{"type":"tool_call","tool":7,"summary":"$ ls"}', // non-string tool
      '{"type":"tool_result","tool":"bash","ok":"yes","summary":"x"}', // non-boolean ok
      '{"type":"tool_result","tool":"bash","ok":true,"summary":"x","at":"soon"}', // non-numeric at
      '{"type":"run_note","kind":"nap","summary":"x"}', // unknown kind
      '{"type":"run_note","kind":"wrap_up","summary":"w","at":5}', // valid
      '{"type":"tool_call","tool":"bash","summary":"$ ls","at":1}', // valid
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events.map((e) => e.type)).toEqual(["run_note", "tool_call"]);
    expect(out.skipped).toBe(5);
  });

  it("accepts the timeline events (`input`, `assistant`, `answer`) when they carry text, skips them otherwise", () => {
    const text = [
      '{"type":"input","text":"fix the bug","at":1}',
      '{"type":"assistant","text":"checking…","at":2}',
      '{"type":"answer","text":"done","at":3}',
      '{"type":"input","text":42}', // wrong shape
      '{"type":"assistant"}', // missing text
    ].join("\n");
    const out = parseRunEventLines(text);
    expect(out.events.map((e) => e.type)).toEqual(["input", "assistant", "answer"]);
    expect(out.skipped).toBe(2);
  });

  it("empty input yields no events", () => {
    expect(parseRunEventLines("")).toEqual({ events: [], skipped: 0 });
  });
});

describe("inProgressHint", () => {
  const trailing = [
    { type: "tool_call", tool: "bash", summary: "$ npm test", at: 1 },
  ] as const;
  it("hints at --in-progress when a default (finished) analysis blames a trailing unpaired call", () => {
    const d = analyzeRunFriction([...trailing], { finished: true });
    expect(inProgressHint(d, true)).toMatch(/--in-progress/);
  });
  it("stays quiet when --in-progress was given, or when nothing ended mid-tool", () => {
    expect(inProgressHint(analyzeRunFriction([...trailing], { finished: false }), false)).toBeUndefined();
    const paired = analyzeRunFriction([
      { type: "tool_call", tool: "bash", summary: "$ ls", at: 1 },
      { type: "tool_result", tool: "bash", ok: false, summary: "e", at: 2 },
    ]);
    expect(inProgressHint(paired, true)).toBeUndefined();
  });
});

describe("parseFrictionArgs", () => {
  it("defaults: read stdin, text report, default slow threshold, stream assumed finished", () => {
    expect(parseFrictionArgs([])).toEqual({ source: "-", json: false, slowToolMs: undefined, finished: true });
  });
  it("a file path, --json, --slow-ms, and --in-progress (a mid-run capture: a trailing call is not a death)", () => {
    expect(parseFrictionArgs(["run.jsonl", "--json", "--slow-ms", "5000"])).toEqual({ source: "run.jsonl", json: true, slowToolMs: 5000, finished: true });
    expect(parseFrictionArgs(["--slow-ms=250", "-", "--in-progress"])).toEqual({ source: "-", json: false, slowToolMs: 250, finished: false });
  });
  it("rejects an unknown flag or a non-numeric --slow-ms", () => {
    expect(() => parseFrictionArgs(["--wat"])).toThrow(/unknown/i);
    expect(() => parseFrictionArgs(["--slow-ms", "soon"])).toThrow(/slow-ms/);
  });
});
