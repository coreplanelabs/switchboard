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
import type { Landing } from "../reattach.js";
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
  /** Set by `abandon()` (a re-attach): a write whose turn comes after it is
   *  held for the fresh transport (`takeUnsent`) instead of landing here. A
   *  plain `close()` leaves it false. */
  private heldForReattach = false;
  /** The writes handed to `send` whose turn on the chain has not come, in
   *  order. One queued behind a write that failed, or still queued when the
   *  transport was abandoned, never reached pi: the re-attach re-sends it as it
   *  was on the fresh transport (`takeUnsent`), after the write the failure
   *  left unknown is resolved — so pi sees the loop's order, and no write is
   *  silently lost or landed out of turn (harness-pi item 16). */
  private queued: Record<string, unknown>[] = [];
  /** The chain every write to the FIFO takes, the abort's included: one
   *  writer at a time. A line is a separate exec (`printf`, or `cat` past
   *  40 000 chars) and a line over PIPE_BUF is several `write(2)`s, so two
   *  writes in flight at once would interleave inside pi's line. */
  private sending: Promise<void> = Promise.resolve();
  private sendError: Error | undefined;
  private buffer = Buffer.alloc(0);
  /** The last read was short — fewer than `LOG_READ_BYTES` — so the log held
   *  no more at that moment; a full read means more follows at once. */
  private lastReadShort = false;
  /** Records read and not yet handed out: the rest of the chunk being consumed. */
  private unhanded = 0;
  readonly lines: AsyncIterable<string>;

  constructor(private readonly deps: PiRpcTransportDeps) {
    this.offset = deps.offset ?? 0;
    this.consumedOffset = this.offset;
    this.lines = this.read();
  }

  /** In order, one line each; a failed write ends the stream with its error on
   *  the next read, and stops the chain: nothing queued behind the failure, and
   *  nothing sent after it, lands on this transport — it waits for the re-attach.
   *  `write` is the same send answering with the write's landing. */
  send(command: Record<string, unknown>): void {
    void this.write(command);
  }

  /** Send, and say how the write came out once the chain reaches it (harness-pi
   *  item 16): `landed` on pi's FIFO; `failed` — the reset's, the command kept
   *  as `pendingSend` for the re-attach to resolve; `held` — never attempted
   *  here, kept for `takeUnsent` and the fresh transport. What the gate's
   *  `onLanded` waits on: a clock stamped at the landing (the finale's) starts
   *  when pi has the steer, not when a chain that only held it was handed it. */
  write(command: Record<string, unknown>): Promise<Landing> {
    if (this.closed) return Promise.resolve("held");
    // An abort never queues (`sendAbort`): one step on the chain that a spent
    // chain does not stop, so a write in flight that fails after it was asked
    // for cannot swallow it, and no re-attach can ever replay it from `takeUnsent`.
    if (command.type === "abort") {
      this.sendAbort();
      return this.sending.then(() => "landed" as const);
    }
    const line = JSON.stringify(command);
    this.queued.push(command);
    const step: Promise<Landing> = this.sending
      .then((): Landing | Promise<Landing> => {
        // Decided when this write's turn on the chain comes, not when it was
        // queued. Once a write has FAILED the chain is spent (a steer queued
        // behind the failed prompt must not land ahead of the prompt's re-send
        // on the fresh transport — order inverted), and once `abandon()`ed the
        // fresh transport owns every write not yet started: either way this one
        // stays queued for `takeUnsent`, never landed here, never lost. A plain
        // `close()` (teardown) does neither, so a write sent just before it
        // still flushes — unless an earlier write failed, when it is held like
        // the rest (see `close`). Otherwise it is in flight.
        if (this.sendError !== undefined || this.heldForReattach) return "held";
        this.queued.shift();
        return this.deps.container.writeLine(this.deps.paths, line).then(() => "landed" as const);
      })
      .catch((err: unknown): Landing => {
        this.sendError ??= err instanceof Error ? err : new Error(String(err));
        this.pendingSend ??= command;
        return "failed";
      });
    this.sending = step.then(() => undefined);
    return step;
  }

  /** The abort — a hard stop's, the finale's, a gate bypass's — the one write
   *  that never waits for the gate and never waits for a re-attach (harness-pi
   *  item 16): ONE step on the transport's chain that a spent chain does not
   *  stop. Nothing in flight — an idle chain, or one a failure already spent —
   *  and the step runs at once: that is the direct write. A write in flight or
   *  queued on a live chain, and the abort follows it: whichever prompt the
   *  stop was asked for during, pi has the prompt first and the abort after,
   *  never an idle session aborted and then handed the prompt to run unwatched.
   *  Never two writers: a line is a separate exec into the FIFO and a line over
   *  PIPE_BUF is several `write(2)`s, so a direct write beside an in-flight one
   *  could land inside pi's line and cost both. The step writes even when the
   *  write before it spent the chain (the reset that failed a prompt a moment
   *  after the abort was asked for must not swallow the stop), and skips only
   *  on a transport abandoned to a re-attach — its fresh transport is the one
   *  writer then; never queued for `takeUnsent`, so no re-attach replays it; a
   *  failed write is nobody's — the transport is being left, the process
   *  ended by `kill`. */
  sendAbort(): void {
    if (this.closed) return;
    const line = JSON.stringify({ type: "abort" });
    this.sending = this.sending
      .then(() => (this.heldForReattach ? undefined : this.deps.container.writeLine(this.deps.paths, line)))
      .catch(() => undefined);
  }

  /** Whether the reader is at the log's end as far as it knows: every record
   *  read has been handed out and the last read was short. The gate reads its
   *  clock only then (`HeldSends.quiet`): a catch-up burst still being handed
   *  out — the records pi wrote during a reset, read in one chunk and consumed
   *  one ledger write at a time — is no time, while a streaming pi's records
   *  each leave the reader caught up, so a held prompt's clock still runs. */
  get caughtUp(): boolean {
    return this.lastReadShort && this.unhanded === 0;
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

  /** Every write so far settled: landed, failed (`pendingSend`), or — after a
   *  failure or an `abandon()` — held for the fresh transport (`takeUnsent`),
   *  the chain running on without touching the FIFO; an abort's step among
   *  them. What the re-attach awaits BEFORE it reads `pendingSend`: a write in
   *  flight when the read failed fails with the same reset a moment later, and
   *  until it does it is neither `pendingSend` nor queued. Bounded by the
   *  write's own command timeout. */
  flushed(): Promise<void> {
    return this.sending;
  }

  /** Close for teardown: a write already queued still lands — unless an
   *  earlier write failed, when it is held (`takeUnsent`) and this transport
   *  delivers nothing more of the chain. An abort is the one exception: its
   *  step ignores the spent chain (`sendAbort`), so a teardown's abort still
   *  reaches pi even then; the process is ended by `kill` regardless, so
   *  teardown owes nothing to a held write. */
  close(): void {
    this.closed = true;
  }

  /** Close AND hold every write whose turn has not come for the fresh
   *  transport — the re-attach's close (harness-pi item 16): the fresh one sends
   *  them (`takeUnsent`) behind the write the failure left unresolved, so none
   *  lands here out of turn. A write still in flight may fail with the very
   *  reset that failed the read, so the re-attach awaits `flushed()` before it
   *  resolves — nothing in flight is abandoned unresolved. */
  abandon(): void {
    this.closed = true;
    this.heldForReattach = true;
  }

  private async *read(): AsyncGenerator<string> {
    const alivePolls = this.deps.alivePolls ?? 4;
    let idle = 0;
    while (!this.closed) {
      if (this.sendError) throw this.sendError;
      const chunk = await this.deps.container.readLog(this.deps.paths.log, this.offset, LOG_READ_BYTES);
      this.lastReadShort = chunk.length < LOG_READ_BYTES;
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
          this.lastReadShort = rest.length < LOG_READ_BYTES;
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

  /** Complete lines out of the buffered bytes; the partial tail waits for more.
   *  `unhanded` counts the lines of this chunk still to hand out, so the reader
   *  holding the last one is caught up (`caughtUp`), and the one holding an
   *  earlier one is not. */
  private *split(chunk: Uint8Array): Generator<string> {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    // Where the buffer's first byte sits in the log: the read position, less what waits unparsed.
    const base = this.offset - this.buffer.length;
    const lines: Array<{ line: string; end: number }> = [];
    let start = 0;
    for (let i = this.buffer.indexOf(NEWLINE, start); i >= 0; i = this.buffer.indexOf(NEWLINE, start)) {
      let line = this.buffer.subarray(start, i).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push({ line, end: base + i + 1 });
      start = i + 1;
    }
    this.buffer = this.buffer.subarray(start);
    for (let n = 0; n < lines.length; n++) {
      this.unhanded = lines.length - n - 1;
      this.consumedOffset = lines[n].end;
      yield lines[n].line;
    }
  }
}
