/** Error classification: mark a thrown error with our kind and the peer's own
 *  discriminator at the point that knows them (an HTTP status, the resident's
 *  `needs`, the leading token of a resident reason), and read the mark back at
 *  any depth. A span that fails with a classified error records `errorKind` and
 *  `errorCode` and no message at all — free text from a remote body never
 *  reaches a span, a log line or the wire (features/tracing.md). */
import type { ErrorKind } from "./types.js";

export interface ErrorClassification {
  kind: ErrorKind;
  code?: string;
}

const MARKS = new WeakMap<object, ErrorClassification>();

/** How far `classificationOf` follows `cause` links. */
export const CAUSE_DEPTH = 5;

const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Mark `err` (any object; a non-object is returned unmarked) and return it, so
 *  `throw classifyError(new Error(...), { kind: "http", code: "503" })` reads
 *  naturally. A `code` that is not a short identifier is dropped: a code is the
 *  peer's discriminator, never its prose. */
export function classifyError<E>(err: E, c: ErrorClassification): E {
  if (err !== null && typeof err === "object") {
    MARKS.set(err, c.code !== undefined && CODE_RE.test(c.code) ? { kind: c.kind, code: c.code } : { kind: c.kind });
  }
  return err;
}

/** The classification on `err` or on any `cause` beneath it, to `CAUSE_DEPTH`. */
export function classificationOf(err: unknown): ErrorClassification | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth <= CAUSE_DEPTH && cur !== null && typeof cur === "object"; depth++) {
    const mark = MARKS.get(cur);
    if (mark) return mark;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** An HTTP status as an `errorCode`: an integer in 100..599, stringified;
 *  anything else is no code. */
export function httpStatusCode(status: unknown): string | undefined {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? String(status)
    : undefined;
}
