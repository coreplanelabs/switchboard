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
  /** The writes handed to `send` not yet settled — queued for their turn or in
   *  flight on the FIFO. While one is pending a direct abort can overtake it,
   *  so `sendAbort` also appends an abort behind it; at zero nothing can be
   *  overtaken, the direct write alone is the abort, and pi sees exactly one. */
  private pendingWrites = 0;
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
    // An abort never queues (`sendAbort`): written directly whatever the
    // chain's state, so a write in flight that fails after it was asked for
    // cannot swallow it, and no re-attach can ever replay it from `takeUnsent`.
    if (command.type === "abort") return this.sendAbort();
    const line = JSON.stringify(command);
    this.queued.push(command);
    this.pendingWrites++;
    this.sending = this.sending
      .then(() => {
        // Decided when this write's turn on the chain comes, not when it was
        // queued. Once a write has FAILED the chain is spent (a steer queued
        // behind the failed prompt must not land ahead of the prompt's re-send
        // on the fresh transport — order inverted), and once `abandon()`ed the
        // fresh transport owns every write not yet started: either way this one
        // stays queued for `takeUnsent`, never landed here, never lost. A plain
        // `close()` (teardown) does neither, so a write sent just before it
        // still flushes — unless an earlier write failed, when it is held like
        // the rest (see `close`). Otherwise it is in flight.
        if (this.sendError !== undefined || this.heldForReattach) return;
        this.queued.shift();
        return this.deps.container.writeLine(this.deps.paths, line);
      })
      .catch((err: unknown) => {
        this.sendError ??= err instanceof Error ? err : new Error(String(err));
        this.pendingSend ??= command;
      })
      .finally(() => {
        this.pendingWrites--;
      });
  }

  /** The abort — a hard stop's, the finale's, a gate bypass's — the one write
   *  that never waits, written twice where once could be wrong (harness-pi
   *  item 16). Directly, at once, whatever the chain's state: a write in flight
   *  can fail with the very reset a moment after the abort was asked for, and
   *  an abort queued behind it would then never land (the chain is spent, and
   *  it waits for a re-attach a stop is not making) and a re-attach would
   *  replay it. AND, while a write is pending on a live chain — queued for its
   *  turn or in flight — once more in its place behind it: the direct write can
   *  overtake a prompt whose `writeLine` is still a pending continuation — pi
   *  would abort an idle session, then receive the prompt and run the turn
   *  unwatched — so whichever order the FIFO takes, an abort follows the
   *  prompt. An idle chain has nothing to overtake, so there the direct write
   *  is the one abort pi sees. An abort is idempotent and the duplicate
   *  harmless; never queued for `takeUnsent`; a failed write is nobody's — the
   *  transport is being left, the process ended by `kill`. */
  sendAbort(): void {
    if (this.closed) return;
    const line = JSON.stringify({ type: "abort" });
    void this.deps.container.writeLine(this.deps.paths, line).catch(() => undefined);
    if (this.sendError !== undefined || this.pendingWrites === 0) return;
    this.sending = this.sending
      .then(() =>
        this.sendError !== undefined || this.heldForReattach
          ? undefined
          : this.deps.container.writeLine(this.deps.paths, line),
      )
      .catch(() => undefined);
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
   *  the chain running on without touching the FIFO. What the re-attach awaits
   *  BEFORE it reads `pendingSend`: a write in flight when the read failed
   *  fails with the same reset a moment later, and until it does it is neither
   *  `pendingSend` nor queued. Bounded by the write's own command timeout. */
  flushed(): Promise<void> {
    return this.sending;
  }

  /** Close for teardown: a write already queued still lands — unless an
   *  earlier write failed, when it is held (`takeUnsent`) and this transport
   *  delivers nothing more of the chain. An abort is the one exception: written
   *  directly (`sendAbort`), a teardown's abort still reaches pi even then; the
   *  process is ended by `kill` regardless, so teardown owes nothing to a held
   *  write. */
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
