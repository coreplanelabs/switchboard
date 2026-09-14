import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { jsonlLines, parsePiLine, piAnsweredWithoutRunning, splitJsonl } from "./protocol.js";

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

describe("piAnsweredWithoutRunning — the answers pi's loop gives before the hook", () => {
  // The texts are pi 0.85.1's own: `validateToolArguments` in
  // packages/ai/src/utils/validation.ts, `failToolCallsFromTruncatedMessage`
  // and `prepareToolCall` in packages/agent/src/agent-loop.ts. The first is
  // the `read` call the spike receipt that opened this paired with no notice.
  const end = (toolName: string, text: string, isError = true) => ({
    type: "tool_execution_end",
    toolCallId: "toolu_016KLWcGrLHdN1s2AeWKGvG4",
    toolName,
    result: { content: [{ type: "text", text }], details: {} },
    isError,
  });
  const validation =
    'Validation failed for tool "read":\n  - offset: must be number\n\nReceived arguments:\n{\n  "path": "src/load/aggregate.test.ts",\n  "offset": [\n    140,\n    270\n  ]\n}';

  it("names pi's reason for an argument-validation failure, a truncated message and an unknown tool, and nothing for a call pi ran — however it ended", () => {
    expect(piAnsweredWithoutRunning(end("read", validation))).toBe(
      "its arguments failed pi's validation (offset: must be number)",
    );
    expect(
      piAnsweredWithoutRunning(
        end(
          "edit",
          'Validation failed for tool "edit":\n  - edits.2: must be object\n  - path: must be string\n\nReceived arguments:\n{}',
        ),
      ),
    ).toBe("its arguments failed pi's validation (edits.2: must be object; path: must be string)");
    expect(
      piAnsweredWithoutRunning(
        end(
          "write",
          'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
        ),
      ),
    ).toBe("its arguments were cut by the output token limit");
    expect(piAnsweredWithoutRunning(end("web_search", "Tool web_search not found"))).toBe(
      "the tool is not on pi's list",
    );
    // A call pi ran: a plain result, a failed one, a bash exit, the gate's own refusal, a text that only quotes pi's words.
    expect(piAnsweredWithoutRunning(end("read", "1: import x", false))).toBeUndefined();
    expect(piAnsweredWithoutRunning(end("read", "ENOENT: no such file"))).toBeUndefined();
    expect(piAnsweredWithoutRunning(end("bash", "boom\nCommand exited with code 1"))).toBeUndefined();
    expect(piAnsweredWithoutRunning(end("bash", "repo:use — push to `main`, not the run's branch"))).toBeUndefined();
    expect(piAnsweredWithoutRunning(end("bash", validation, false))).toBeUndefined();
    expect(piAnsweredWithoutRunning(end("bash", validation))).toBeUndefined(); // names another tool
    expect(
      piAnsweredWithoutRunning({ type: "tool_execution_start", toolCallId: "x", toolName: "read" }),
    ).toBeUndefined();
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
