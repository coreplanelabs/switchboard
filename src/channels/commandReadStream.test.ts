import { afterEach, describe, expect, it, vi } from "vitest";
import { serveCommandRead } from "./commandReadStream.js";
import type { InvokeResult } from "../core/commandRegistry.js";
import type { SseSink } from "./liveView/sse.js";

function connection() {
  let disconnect = () => {};
  const chunks: string[] = [];
  let ended = false;
  const sink: SseSink = {
    writeHead: () => {},
    write: (chunk) => {
      chunks.push(chunk);
    },
    end: () => {
      ended = true;
    },
    onClose: (cb) => {
      disconnect = cb;
    },
  };
  return { sink, chunks, disconnect: () => disconnect(), ended: () => ended };
}
afterEach(() => vi.useRealTimers());
describe("Command read stream", () => {
  it.each(["read", "write"] as const)(
    "reports a %s failure without private error text and ends the attempt",
    async (phase) => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const c = connection();
        const write = c.sink.write;
        c.sink.write = (chunk) => {
          if (phase === "write" && chunk.startsWith("data:")) throw new Error("private transport details");
          return write(chunk);
        };
        serveCommandRead(
          async () => {
            if (phase === "read") throw new Error("private credential details");
            return { ok: true, value: { status: "success" } };
          },
          c.sink,
          30_000,
          "review.checks",
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(c.ended()).toBe(true);
        expect(c.chunks).toEqual(["retry: 3000\n\n"]);
        expect(log.mock.calls).toEqual([
          [JSON.stringify({ event: "command.read_stream.failed", command: "review.checks", phase })],
        ]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("reconciles full snapshots, reports unavailable data, and stops after disconnect", async () => {
    vi.useFakeTimers();
    const c = connection();
    let result: InvokeResult = { ok: true, value: { status: "in_progress" } };
    let reads = 0;
    serveCommandRead(
      async () => {
        reads++;
        return result;
      },
      c.sink,
      30_000,
      "review.checks",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(c.chunks.join("")).toContain('data: {"status":"in_progress"}\n\n');
    result = { ok: false, error: "unavailable", status: 503, message: "GitHub is unavailable", decidedBy: "handler" };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.chunks.join("")).toContain('event: unavailable\ndata: {"message":"GitHub is unavailable","retry":true}');
    result = { ok: true, value: { status: "success" } };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.chunks.join("")).toContain('data: {"status":"success"}\n\n');
    c.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(3);
  });
  it("ends after refusal and ignores a read that finishes after disconnect", async () => {
    vi.useFakeTimers();
    const c = connection();
    serveCommandRead(
      async () => ({ ok: false, error: "unauthorized", status: 403, message: "Run is unavailable", decidedBy: "door" }),
      c.sink,
      30_000,
      "review.checks",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(c.chunks.join("")).toContain('"retry":false');
    expect(c.ended()).toBe(true);
    const late = connection();
    let finish!: (value: InvokeResult) => void;
    serveCommandRead(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      late.sink,
      30_000,
      "review.checks",
    );
    late.disconnect();
    finish({ ok: true, value: { status: "success" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.chunks.join("")).toBe("retry: 3000\n\n");
  });
});
