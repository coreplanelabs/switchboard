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

/** What a client needs from a pi process: write a command, read its records,
 *  end its stdin (how RPC mode is told to shut down). */
export interface PiTransport {
  send(command: Record<string, unknown>): void;
  lines: AsyncIterable<string>;
  close(): void;
}
