import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { jsonlLines, parsePiLine, splitJsonl } from "./protocol.js";

// pi's framing (docs/reference/specs/harness-pi.md): LF is the only record
// delimiter — the shapes come from pi's own docs/rpc.md, Framing.

describe("splitJsonl — pi's framing: LF is the only delimiter", () => {
  it("splits on LF, strips a trailing CR, keeps U+2028 inside a record, and returns the partial tail", () => {
    const { lines, rest } = splitJsonl('{"a":1}\r\n{"b":"x y"}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":"x y"}']);
    expect(rest).toBe('{"c"');
  });
  it("skips empty records", () => {
    expect(splitJsonl("\n\n{}\n").lines).toEqual(["{}"]);
  });
});

describe("parsePiLine — the stream's records", () => {
  it("parses a record with a type and refuses anything else", () => {
    expect(parsePiLine('{"type":"agent_start"}')).toEqual({ type: "agent_start" });
    expect(parsePiLine("not json")).toBeUndefined();
    expect(parsePiLine('{"noType":true}')).toBeUndefined();
  });
});

describe("jsonlLines", () => {
  it("yields one record per LF however the chunks fall, and the unterminated tail at the end", async () => {
    const chunks = ['{"a":1}\n{"b":', '2}\r\n{"c":3}', '\n{"d":4}'];
    const out: string[] = [];
    for await (const line of jsonlLines(Readable.from(chunks))) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
  });
});
