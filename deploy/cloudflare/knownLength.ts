// The container's answer, re-framed so its length survives to the browser.
//
// The bot writes `Content-Length` on every whole-object artifact answer
// (src/channels/liveView.ts `serveArtifact`), and locally the header is there.
// Live, a `200` for a 31 MB video reached the browser with no length while the
// `206` answers for the same bytes kept theirs: somewhere past the container
// the passthrough became a stream of unknown length. A player that falls back
// from ranges to a plain read of such a stream cannot seek and, with
// `preload="metadata"` on a file whose index sits at the end, never finds it.
//
// The Workers runtime emits `Content-Length` for a body it knows the length
// of, and `FixedLengthStream` is how a body declares one: this re-wraps the
// container's answer through a pipe sized by the container's own header. The
// pipe also refuses a body of another length, so a short or long upstream
// fails the response instead of lying about it. Pure over the Response and a
// pipe factory, so it is tested here with a fake pipe and wired in worker.ts
// with `new FixedLengthStream(size)`.

/** `new FixedLengthStream(size)` in workerd; a fake in tests. */
export type LengthPipe = (size: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

/** A response that could carry a WebSocket (workerd's `Response` does). */
type MaybeSocket = Response & { webSocket?: unknown };

/** The same answer with its body declared at the length the container named.
 *  Untouched: an answer with no body, one whose `Content-Length` is missing
 *  or not a byte count, a zero-length one, and a WebSocket upgrade — each is
 *  either already known-length or not a byte stream at all. */
export function withKnownLength(res: Response, lengthPipe: LengthPipe): Response {
  if (res.body === null || (res as MaybeSocket).webSocket) return res;
  const header = res.headers.get("content-length");
  if (header === null || !/^\d{1,15}$/.test(header)) return res;
  const size = Number(header);
  if (size === 0) return res;
  const { readable, writable } = lengthPipe(size);
  // The pipe's own failure (a body of another length) ends the readable with
  // that error; nothing here swallows it into a clean end.
  void res.body.pipeTo(writable).catch(() => undefined);
  return new Response(readable, res);
}
