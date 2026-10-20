import type { InvokeResult } from "../core/commandRegistry.js";
import { SSE_HEADERS, SSE_PRELUDE, type SseSink } from "./liveView/sse.js";

/** Each frame replaces the snapshot. Reconnects re-read through authorization,
 * so no retained event log or resume cursor is needed. */
export function serveCommandRead(
  read: () => Promise<InvokeResult>,
  sink: SseSink,
  interval: number,
  command: string,
): void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    closed = true;
    clearTimeout(timer);
  };
  sink.onClose(close);
  if (closed) return;
  sink.writeHead(200, { ...SSE_HEADERS, "cache-control": "no-store, no-transform" });
  sink.write(SSE_PRELUDE);
  const poll = async () => {
    let phase: "read" | "write" = "read";
    try {
      const result = await read();
      if (closed) return;
      phase = "write";
      if (result.ok) sink.write(`data: ${JSON.stringify(result.value)}\n\n`);
      else {
        const retry = result.error === "unavailable";
        sink.write(`event: unavailable\ndata: ${JSON.stringify({ message: result.message, retry })}\n\n`);
        if (!retry) {
          close();
          sink.end();
          return;
        }
      }
      timer = setTimeout(() => void poll(), interval);
      timer.unref?.();
    } catch {
      // A transport or reader failure ends this attempt. EventSource reconnects
      // through the identity gate and receives a complete snapshot again.
      if (!closed) {
        console.error(JSON.stringify({ event: "command.read_stream.failed", command, phase }));
        close();
        sink.end();
      }
    }
  };
  void poll();
}
