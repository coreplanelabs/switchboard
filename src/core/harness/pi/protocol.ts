// pi's wire protocol as this repository speaks it (docs/reference/specs/harness-pi.md):
// one JSON object per line on stdin and stdout, LF the only delimiter. The
// framing, the record parser and the transport seam every pi client here
// drives — the load harness's spike driver and the coding harness alike —
// live in this one module, so the two never disagree on a byte.

import type { Readable } from "node:stream";

/** One record off pi's stdout: every one carries a `type`. */
export type PiEvent = { type: string } & Record<string, unknown>;

/** pi's framing (docs/rpc.md, Framing): LF is the only record delimiter, a
 *  trailing CR is stripped, and nothing else — not U+2028/2029 — splits a
 *  record, which rules out Node's `readline`. Returns the complete records and
 *  the unterminated tail to prepend to the next chunk. */
export function splitJsonl(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = buffer.indexOf("\n", start); i >= 0; i = buffer.indexOf("\n", start)) {
    let line = buffer.slice(start, i);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0) lines.push(line);
    start = i + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

export function parsePiLine(line: string): PiEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
      return value as PiEvent;
    }
  } catch {
    // not a record — pi never writes one, but a client must not die on stray output
  }
  return undefined;
}

/** pi's stdout as records: LF-only framing (`splitJsonl`), the unterminated
 *  tail delivered when the stream ends. */
export async function* jsonlLines(stream: Readable): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    const { lines, rest } = splitJsonl(buffer);
    buffer = rest;
    for (const line of lines) yield line;
  }
  const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  if (tail.length > 0) yield tail;
}

/** pi's loop answers three kinds of tool call by itself, before the
 *  `tool_call` hook and without running the tool (pi-agent-core
 *  `prepareToolCall` and `failToolCallsFromTruncatedMessage`: the hook is
 *  `beforeToolCall`, called after `validateToolArguments`): arguments that
 *  fail the tool's schema, a tool that is not on pi's list, and every call of
 *  an assistant message the output token limit cut. Each is announced with
 *  `tool_execution_start` and ended with an error result in pi's own words —
 *  so a `tool_execution_end` the hook never preceded is either one of these,
 *  and nothing ran, or a call that ran unvetted. The reason for the first
 *  case, `undefined` for a call pi ran however it ended. Pinned to pi's texts
 *  the way the bridge reads bash's `Command exited with code N` trailer. */
export function piAnsweredWithoutRunning(event: PiEvent): string | undefined {
  if (event.type !== "tool_execution_end" || event.isError !== true) return undefined;
  const tool = typeof event.toolName === "string" ? event.toolName : "";
  const result = event.result as { content?: unknown } | undefined;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n");
  const validation = `Validation failed for tool "${tool}":\n`;
  if (text.startsWith(validation)) {
    const problems = text
      .slice(validation.length)
      .split("\n\n")[0]
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .filter((line) => line.length > 0);
    return `its arguments failed pi's validation (${problems.join("; ")})`;
  }
  if (text.startsWith(`Tool call "${tool}" was not executed: the response hit the output token limit`))
    return "its arguments were cut by the output token limit";
  if (text === `Tool ${tool} not found`) return "the tool is not on pi's list";
  return undefined;
}

/** What a client needs from a pi process: write a command, read its records,
 *  end its stdin (how RPC mode is told to shut down). */
export interface PiTransport {
  send(command: Record<string, unknown>): void;
  lines: AsyncIterable<string>;
  close(): void;
}
