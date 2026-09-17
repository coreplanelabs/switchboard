// The RPC transport over the container seam (docs/reference/specs/harness-pi.md
// item 4): commands go to pi's FIFO one line at a time, in order; the events
// come back by polling pi's log from the last byte read — exact bytes, so a
// record split across two reads is whole before it is parsed — and the stream
// ends when the harness closes it or when pi is found dead with nothing more
// to read. Two positions are kept apart: where the reads have reached, by
// whole chunks, and the boundary after the record last handed out, by records
// — the one the harness's re-attach fact is made of (item 8). The same
// `PiTransport` shape the spike driver speaks over a child process, so the
// bridge and the driver's accumulator never know which.

import { LOG_READ_BYTES, type HarnessContainer, type HarnessPaths } from "../container.js";
import type { PiTransport } from "./protocol.js";

export interface PiRpcTransportDeps {
  container: HarnessContainer;
  paths: HarnessPaths;
  pid: number;
  /** Between two reads that found nothing. */
  pollMs: number;
  /** How many empty polls between two `alive` checks. */
  alivePolls?: number;
  sleep: (ms: number) => Promise<void>;
  /** Where to begin reading the log — a re-attach continues from the offset it recorded. */
  offset?: number;
}

const NEWLINE = 0x0a;

export class PiRpcTransport implements PiTransport {
  /** The byte the next read starts at: the read position, moved by whole chunks. */
  offset: number;
  /** The boundary after the record last handed out, moved by records: where a
   *  reader that has seen everything so far continues from — the harness's
   *  re-attach fact, taken when nothing handed out is left unwritten. */
  consumedOffset: number;
  /** pi was found dead while the harness still listened. */
  exited = false;
  /** The command a failed `send` last carried, kept beside `sendError` so a
   *  re-attach can resolve a write whose outcome is unknown by pi's echo — a
   *  control reset or a replaced word the row's pid refuted (harness-pi item
   *  16). The first failure's command; cleared with a fresh transport. */
  pendingSend: Record<string, unknown> | undefined;
  private closed = false;
  /** Set by `abandon()` (a re-attach): every write still queued is skipped when
   *  its turn comes, so none of this transport's writes land after the fresh one
   *  re-sends. A plain `close()` leaves it false, so teardown still flushes. */
  private dropQueued = false;
  private sending: Promise<void> = Promise.resolve();
  private sendError: Error | undefined;
  private buffer = Buffer.alloc(0);
  readonly lines: AsyncIterable<string>;

  constructor(private readonly deps: PiRpcTransportDeps) {
    this.offset = deps.offset ?? 0;
    this.consumedOffset = this.offset;
    this.lines = this.read();
  }

  /** In order, one line each; a failed write ends the stream with its error on the next read. */
  send(command: Record<string, unknown>): void {
    if (this.closed) return;
    const line = JSON.stringify(command);
    this.sending = this.sending
      // The drop check runs when this write's turn on the chain comes, not only
      // when it was queued: an `abandon()` between the two (a re-attach)
      // neutralises every write still queued behind the one in flight, so none
      // of the old transport's writes land after the re-attach re-sends onto the
      // fresh transport (harness-pi item 16). A plain `close()` (teardown) does
      // not drop, so a write sent just before it — an abort on a gate bypass —
      // still flushes.
      .then(() => (this.dropQueued ? undefined : this.deps.container.writeLine(this.deps.paths, line)))
      .catch((err: unknown) => {
        this.sendError ??= err instanceof Error ? err : new Error(String(err));
        this.pendingSend ??= command;
      });
  }

  /** Every write so far landed (or failed): what a caller awaits before it reads for the answer. */
  flushed(): Promise<void> {
    return this.sending;
  }

  close(): void {
    this.closed = true;
  }

  /** Close AND drop every write still queued — the re-attach's close (harness-pi
   *  item 16): no write of the old transport lands after the fresh one re-sends
   *  the one the reset left unresolved. `close()` alone still flushes what was
   *  queued, so teardown never loses a just-sent abort. */
  abandon(): void {
    this.closed = true;
    this.dropQueued = true;
  }

  private async *read(): AsyncGenerator<string> {
    const alivePolls = this.deps.alivePolls ?? 4;
    let idle = 0;
    while (!this.closed) {
      if (this.sendError) throw this.sendError;
      const chunk = await this.deps.container.readLog(this.deps.paths.log, this.offset, LOG_READ_BYTES);
      if (chunk.length > 0) {
        idle = 0;
        this.offset += chunk.length;
        yield* this.split(chunk);
        if (chunk.length === LOG_READ_BYTES) continue;
      } else {
        idle++;
        if (idle % alivePolls === 0 && !(await this.deps.container.alive(this.deps.pid))) {
          // Dead: whatever landed between the read and the check is the last of it.
          const rest = await this.deps.container.readLog(this.deps.paths.log, this.offset, LOG_READ_BYTES);
          if (rest.length > 0) {
            this.offset += rest.length;
            yield* this.split(rest);
          }
          this.exited = true;
          return;
        }
      }
      if (this.closed) return;
      await this.deps.sleep(this.deps.pollMs);
    }
  }

  /** Complete lines out of the buffered bytes; the partial tail waits for more. */
  private *split(chunk: Uint8Array): Generator<string> {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    // Where the buffer's first byte sits in the log: the read position, less what waits unparsed.
    const base = this.offset - this.buffer.length;
    let start = 0;
    for (let i = this.buffer.indexOf(NEWLINE, start); i >= 0; i = this.buffer.indexOf(NEWLINE, start)) {
      let line = this.buffer.subarray(start, i).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        this.consumedOffset = base + i + 1;
        yield line;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.subarray(start);
  }
}
