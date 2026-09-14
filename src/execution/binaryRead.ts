// A binary read on the Executor seam (docs/reference/specs/execution.md item 19):
// the whole file as bytes, for a tool that hands a workspace artifact — a
// screenshot, a PDF — to somewhere that needs the bytes, not a text view. Both
// remote executors ask their Worker's `/read` route for `encoding: "base64"`;
// the Worker answers `{ content, encoding: "base64" }`. This module is the
// contract both ends share: the caps, the request/answer shape, the resident's
// read command. It is bundled into the Workers too, so it stays free of Node
// imports.

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

/** The command a resident runs for a read of an already-confined path: `cat`
 *  for text; `base64 -w0` for bytes — one unwrapped line, so the Durable
 *  Object's character cap slices a plain string and nothing else. */
export function readCommandFor(encoding: ReadEncoding, resolvedPath: string): string {
  return encoding === "base64" ? `base64 -w0 -- ${resolvedPath}` : `cat -- ${resolvedPath}`;
}

/** How many bytes a base64 string decodes to, padding discounted. */
export function base64ByteLength(b64: string): number {
  const trimmed = b64.replace(/\s+/g, "");
  if (trimmed.length === 0) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

/** A Worker's answer to a base64 read: the bytes, or the named refusal of a
 *  file over the cap — HTTP 200 either way. The clients classify a non-2xx or
 *  an in-body `error` as a sick Worker (fail-fast counts it); a large file is
 *  the model's mistake, not infrastructure, so it travels as a plain field. */
export type Base64ReadAnswer = { encoding: "base64"; content: string } | { encoding: "base64"; tooLarge: true };

/** One message for a file over the cap, for every implementation. `bytes` is
 *  the size when the reader could measure it; a resident sees only that its
 *  capped base64 stream overflowed. */
export function tooLargeMessage(path: string, bytes?: number): string {
  const size = bytes === undefined ? "" : ` (${bytes} bytes)`;
  return `${path}${size} is over the ${MAX_READ_BYTES}-byte cap of a binary read`;
}
