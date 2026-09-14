// A binary read on the Executor seam (docs/reference/specs/execution.md item 19):
// the whole file as bytes, for a tool that hands a workspace artifact — a
// screenshot, a PDF — to somewhere that needs the bytes, not a text view. Both
// remote executors ask their Worker's `/read` route for `encoding: "base64"`;
// the Worker answers `{ encoding: "base64", content, size }`. This module is
// the contract both ends share: the caps, the request/answer shape, the
// resident's stat and chunk commands. It is bundled into the Workers too, so it
// stays free of Node imports.

/** The most bytes one `readBytes` hands over. A binary cannot be truncated
 *  the way text output is, so a larger file is refused by name, never trimmed.
 *  10 MiB covers a full-page 2× screenshot or a PDF several times over while
 *  keeping one read well inside a Worker isolate's memory. */
export const MAX_READ_BYTES = 10 * 1024 * 1024;

/** The base64 length a `MAX_READ_BYTES` file encodes to (four chars per three
 *  bytes, padded) — the Worker-side output cap for a base64 read. */
export const MAX_READ_BASE64_CHARS = Math.ceil(MAX_READ_BYTES / 3) * 4;

export type ReadEncoding = "utf8" | "base64";

/** The encoding a `/read` body asks for. Absent is the body every pre-binary
 *  client sends — a text read, exactly as before; `"base64"` asks for bytes;
 *  anything else is refused by name rather than silently read as text. */
export function readEncodingOf(body: Record<string, unknown>): ReadEncoding | { error: string } {
  if (body.encoding === undefined) return "utf8";
  if (body.encoding === "base64") return "base64";
  return { error: `encoding must be "base64" or absent, got ${JSON.stringify(body.encoding)}` };
}

/** The command a resident runs for a text read of an already-confined path.
 *  Bytes never go through one command: see `chunkPlan`. */
export function readCommandFor(resolvedPath: string): string {
  return `cat -- ${resolvedPath}`;
}

/** How many bytes a base64 string decodes to, padding discounted. */
export function base64ByteLength(b64: string): number {
  const trimmed = b64.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** A Worker's answer to a base64 read: the bytes with the file's size, or the
 *  named refusal of a file over the cap — HTTP 200 either way. The clients
 *  classify a non-2xx or an in-body `error` as a sick Worker (fail-fast counts
 *  it); a large file is the model's mistake, not infrastructure, so it travels
 *  as a plain field. `size` is the file's byte count from a `stat` taken before
 *  the read: the client refuses an answer whose decoded length differs, so a
 *  stream cut in transit can never pass as the file. */
export type Base64ReadAnswer =
  { encoding: "base64"; content: string; size: number } | { encoding: "base64"; tooLarge: true };

/** The command that measures a confined file, as the thread user: one number. */
export function statCommandFor(resolvedPath: string): string {
  return `stat -c %s -- ${resolvedPath}`;
}

/** `stat -c %s`'s output as a byte count; null for anything that is not one. */
export function parseByteSize(stdout: string): number | null {
  const m = /^\s*(\d{1,15})\s*$/.exec(stdout);
  return m ? Number(m[1]) : null;
}

/** Bytes per chunk of a resident's base64 read. A command's stdout crosses the
 *  sandbox SDK's process log stream, which cuts a stream past a retention
 *  limit the typings do not name (observed: about 2.3 MB) and reports the cut
 *  only as a `truncated` flag — so no single command may carry the whole file.
 *  One MiB less one: a multiple of 3, so each chunk's base64 has no padding and
 *  the pieces concatenate into the encoding of the whole. */
export const READ_CHUNK_BYTES = 1_048_575;

/** The chunks that cover a `size`-byte file, in order; none for an empty file. */
export function chunkPlan(size: number, chunkBytes = READ_CHUNK_BYTES): Array<{ offset: number; length: number }> {
  const chunks: Array<{ offset: number; length: number }> = [];
  for (let offset = 0; offset < size; offset += chunkBytes) {
    chunks.push({ offset, length: Math.min(chunkBytes, size - offset) });
  }
  return chunks;
}

/** One chunk of a confined file as unwrapped base64: `tail -c +N` seeks on a
 *  regular file, `head -c` bounds the piece. */
export function readChunkCommandFor(resolvedPath: string, chunk: { offset: number; length: number }): string {
  return `tail -c +${chunk.offset + 1} -- ${resolvedPath} | head -c ${chunk.length} | base64 -w0`;
}

/** The base64 length `bytes` encode to (four chars per three bytes, padded). */
export function base64LengthOf(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** One message for a file over the cap, for every implementation. `bytes` is
 *  the size when the reader could measure it; a resident sees only that its
 *  capped base64 stream overflowed. */
export function tooLargeMessage(path: string, bytes?: number): string {
  const size = bytes === undefined ? "" : ` (${bytes} bytes)`;
  return `${path}${size} is over the ${MAX_READ_BYTES}-byte cap of a binary read`;
}
