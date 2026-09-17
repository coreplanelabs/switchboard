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
  /** Set by `abandon()` (a re-attach): a write whose turn comes after it stays
   *  queued for the fresh transport instead of landing here. A plain `close()`
   *  leaves it false, so teardown still flushes. */
  private dropQueued = false;
  /** The writes handed to `send` whose turn on the chain has not come, in
   *  order. One queued behind a write that failed, or still queued when the
   *  transport was abandoned, never reached pi: the re-attach re-sends it as it
   *  was on the fresh transport (`takeUnsent`), after the write the failure
   *  left unknown is resolved — so pi sees the loop's order, and no write is
   *  silently lost or landed out of turn (harness-pi item 16). */
  private queued: Record<string, unknown>[] = [];
  private sending: Promise<void> = Promise.resolve();
  private sendError: Error | undefined;
  private buffer = Buffer.alloc(0);
  readonly lines: AsyncIterable<string>;

  constructor(private readonly deps: PiRpcTransportDeps) {
    this.offset = deps.offset ?? 0;
    this.consumedOffset = this.offset;
    this.lines = this.read();
  }

  /** In order, one line each; a failed write ends the stream with its error on
   *  the next read, and stops the chain: nothing queued behind the failure, and
   *  nothing sent after it, lands on this transport — it waits for the re-attach. */
  send(command: Record<string, unknown>): void {
    if (this.closed) return;
    const line = JSON.stringify(command);
    this.queued.push(command);
    this.sending = this.sending
      .then(() => {
        // Decided when this write's turn on the chain comes, not when it was
        // queued. Once a write has FAILED the chain is spent (a steer queued
        // behind the failed prompt must not land ahead of the prompt's re-send
        // on the fresh transport — order inverted), and once `abandon()`ed the
        // fresh transport owns every write not yet started: either way this one
        // stays queued for `takeUnsent`, never landed here, never lost. A plain
        // `close()` (teardown) does neither, so a write sent just before it —
        // an abort on a gate bypass — still flushes. Otherwise it is in flight.
        if (this.sendError !== undefined || this.dropQueued) return;
        this.queued.shift();
        return this.deps.container.writeLine(this.deps.paths, line);
      })
      .catch((err: unknown) => {
        this.sendError ??= err instanceof Error ? err : new Error(String(err));
        this.pendingSend ??= command;
      });
  }

  /** The writes whose turn never came — queued behind a failed one, or still
   *  queued when the transport was abandoned — in the order they were sent,
   *  taken once. They never reached pi, so the re-attach re-sends them as they
   *  were on the fresh transport, behind the write the failure left unknown. */
  takeUnsent(): Record<string, unknown>[] {
    const unsent = this.queued;
    this.queued = [];
    return unsent;
  }

  /** Every write so far landed (or failed): what a caller awaits before it reads for the answer. */
  flushed(): Promise<void> {
    return this.sending;
  }

  close(): void {
    this.closed = true;
  }

  /** Close AND hold back every write whose turn has not come — the re-attach's
   *  close (harness-pi item 16): they go to the fresh transport (`takeUnsent`)
   *  behind the write the failure left unresolved, so none lands here out of
   *  turn. A write already in flight lands on its own — the FIFO is the same
   *  pi's, the container unchanged. `close()` alone still flushes what was
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
