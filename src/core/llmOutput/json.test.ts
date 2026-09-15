import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, jsonOutput } from "./json.js";

// Feature: docs/reference/specs/llm-output.md item 4 — the JSON output type: the value
// taken out of whatever surrounds it (normalization, not failure), syntax vs
// schema failures classified with an `observed` line phrased for a model
// re-ask, zod-typed value on ok.

const SHAPE = z.object({ facts: z.array(z.unknown()) });

describe("jsonOutput", () => {
  it("parses bare JSON into the zod-typed value with a canonical re-serialization", () => {
    const out = jsonOutput(SHAPE).parse('{ "facts": [1, 2] }');
    expect(out).toEqual({ ok: true, value: { facts: [1, 2] }, canonical: '{"facts":[1,2]}', changed: false });
  });

  it("`changed` is semantic: re-serialization noise (whitespace, key order, a fence) never fires it", () => {
    const two = z.object({ a: z.number(), b: z.number() });
    const out = jsonOutput(two).parse('```json\n{ "b": 2,\n  "a": 1 }\n```');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.changed).toBe(false);
  });

  it("`changed` fires when the schema stripped or transformed what the model sent", () => {
    const stripped = jsonOutput(SHAPE).parse('{"facts":[],"extra":"dropped by the schema"}');
    expect(stripped.ok).toBe(true);
    if (stripped.ok) {
      expect(stripped.changed).toBe(true);
      expect(stripped.canonical).toBe('{"facts":[]}');
    }
  });

  it("accepts a fenced JSON reply — stripping the fence is normalization, not failure", () => {
    const out = jsonOutput(SHAPE).parse('```json\n{"facts":[]}\n```');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ facts: [] });
  });

  it("accepts an opening fence with no closing one — the output cap cut the reply after the object closed", () => {
    const out = jsonOutput(SHAPE).parse('```json\n{"facts":[]}');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ facts: [] });
  });

  it("accepts a lead-in line and leading whitespace before the fence, and a remark after it", () => {
    const out = jsonOutput(SHAPE).parse(
      '\n\nHere is the JSON:\n```json\n{"facts":[]}\n```\nLet me know if you need more.',
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ facts: [] });
  });

  it("a fenced reply the cap cut inside the object is a `syntax` failure that names the cut, never the fence", () => {
    const out = jsonOutput(SHAPE).parse('```json\n{"facts":[{"text":"the deploy command is');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.kind).toBe("syntax");
      expect(out.failure.observed).toContain("not valid JSON");
      expect(out.failure.observed).not.toContain("`");
    }
  });

  it("classifies unparseable text as a `syntax` failure carrying the parser message", () => {
    const out = jsonOutput(SHAPE).parse("here you go: {facts}");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.kind).toBe("syntax");
      expect(out.failure.observed).toContain("not valid JSON");
    }
  });

  it("classifies a wrong shape as a `schema` failure naming the offending path", () => {
    const out = jsonOutput(SHAPE).parse('{"facts": "nope"}');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.failure.kind).toBe("schema");
      expect(out.failure.observed).toContain("facts");
    }
  });

  it("is retryable for both failure kinds — JSON violations are crisp and a re-ask can fix them", () => {
    const t = jsonOutput(SHAPE);
    expect(t.retryable({ kind: "syntax", observed: "x" })).toBe(true);
    expect(t.retryable({ kind: "schema", observed: "x" })).toBe(true);
    expect(t.maxRetries).toBe(2);
  });
});

describe("extractJson", () => {
  it("strips a single wrapping fence, with or without the json tag", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves unfenced text alone (trimmed)", () => {
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("an opening fence with no closing one: the value runs from the first brace to the end", () => {
    expect(extractJson('```json\n{"a":1}')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":[1,')).toBe('{"a":[1,');
  });

  it("text before the first brace and after its matching closer is ignored — a lead-in, a fence, a remark", () => {
    expect(extractJson('Sure — here it is:\n```json\n{"a":1}\n```\nAnything else?')).toBe('{"a":1}');
    expect(extractJson('{"a":1} trailing words')).toBe('{"a":1}');
    expect(extractJson("[1,2] and more")).toBe("[1,2]");
  });

  it("braces and escaped quotes inside strings never close the value", () => {
    expect(extractJson('{"a":"x } y","b":[1]} tail')).toBe('{"a":"x } y","b":[1]}');
    expect(extractJson('{"a":"say \\"}\\""} tail')).toBe('{"a":"say \\"}\\""}');
  });

  it("no brace at all: the trimmed text, so the parser's own message names what was seen", () => {
    expect(extractJson("  I could not do that.  ")).toBe("I could not do that.");
    expect(extractJson("```json\n```")).toBe("```json\n```");
  });
});
