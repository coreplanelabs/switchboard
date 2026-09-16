import { describe, expect, it } from "vitest";
import { withKnownLength } from "./knownLength.ts";

// Feature: docs/reference/specs/live-view.md item 26 — a whole-object artifact
// answer carries its length end to end. The shim re-frames the container's
// answer through a fixed-length pipe sized by the container's `Content-Length`,
// so the runtime declares the length instead of streaming it as unknown.

/** A pipe that fails like `FixedLengthStream`: another byte count than `size` errors the readable. */
function fixedLength(calls: number[]) {
  return (size: number) => {
    calls.push(size);
    let seen = 0;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > size) controller.error(new Error(`FixedLengthStream: more than ${size} bytes`));
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== size) controller.error(new Error(`FixedLengthStream: ${seen} of ${size} bytes`));
      },
    });
  };
}

function streamOf(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<number[]> {
  const out: number[] = [];
  if (!body) return out;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
}

describe("withKnownLength — the container's answer keeps the length it named", () => {
  it("a bodied answer with a byte-count Content-Length is re-framed through a pipe of that size, status and headers intact, bytes identical", async () => {
    const calls: number[] = [];
    const upstream = new Response(streamOf([1, 2, 3], [4, 5]), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "5",
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      },
    });
    const res = withKnownLength(upstream, fixedLength(calls));
    expect(res).not.toBe(upstream);
    expect(calls).toEqual([5]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await drain(res.body)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a 206 is re-framed the same way — the part's length is the count", async () => {
    const calls: number[] = [];
    const res = withKnownLength(
      new Response(streamOf([7, 8, 9]), {
        status: 206,
        headers: { "content-length": "3", "content-range": "bytes 7-9/10" },
      }),
      fixedLength(calls),
    );
    expect([res.status, calls, res.headers.get("content-range")]).toEqual([206, [3], "bytes 7-9/10"]);
    expect(await drain(res.body)).toEqual([7, 8, 9]);
  });

  it("untouched: no body, no Content-Length, a length that is not a byte count, a zero length, a WebSocket upgrade", () => {
    const calls: number[] = [];
    const pipe = fixedLength(calls);
    const noBody = new Response(null, { status: 204, headers: { "content-length": "0" } });
    expect(withKnownLength(noBody, pipe)).toBe(noBody);
    const unknown = new Response(streamOf([1]), { status: 200, headers: { "content-type": "text/event-stream" } });
    expect(withKnownLength(unknown, pipe)).toBe(unknown);
    const odd = new Response(streamOf([1]), { status: 200, headers: { "content-length": "many" } });
    expect(withKnownLength(odd, pipe)).toBe(odd);
    const empty = new Response(streamOf(), { status: 200, headers: { "content-length": "0" } });
    expect(withKnownLength(empty, pipe)).toBe(empty);
    // workerd hands a WebSocket upgrade back as a Response with `webSocket` set;
    // Node's Response refuses status 101, so the fake carries the property alone.
    const socket = Object.assign(new Response(streamOf([1]), { status: 200, headers: { "content-length": "1" } }), {
      webSocket: {},
    });
    expect(withKnownLength(socket, pipe)).toBe(socket);
    expect(calls).toEqual([]);
  });

  it("an upstream body of another length fails the answer with the pipe's words instead of ending clean", async () => {
    const res = withKnownLength(
      new Response(streamOf([1, 2]), { status: 200, headers: { "content-length": "5" } }),
      fixedLength([]),
    );
    await expect(drain(res.body)).rejects.toThrow(/FixedLengthStream: 2 of 5 bytes/);
  });
});
