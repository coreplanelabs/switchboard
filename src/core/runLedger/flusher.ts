// The append flusher (features/run-history.md item 30): the run registry
// publishes events synchronously and in-process; this carries them to the
// ledger in batches — every `flushMs` or `maxEvents`, whichever first — so the
// hot path never waits on the network. A push never throws. A failed send is
// reported and dropped: the transcript, not the event stream, is what a resume
// is rebuilt from, and the finish record still carries every event.

export interface AppendFlusherOptions<E> {
  flushMs: number;
  maxEvents: number;
  send: (batch: E[]) => Promise<void>;
  onError?: (err: Error, batch: E[]) => void;
  /** Injectable timer for tests; defaults to setTimeout with unref. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface AppendFlusher<E> {
  push(event: E): void;
  /** Send what is pending now; resolves when that send settles. */
  flush(): Promise<void>;
  /** Events pushed and not yet handed to `send`. */
  pending(): number;
  /** Flush, then refuse further pushes. */
  close(): Promise<void>;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(t) };
};

export function createAppendFlusher<E>(opts: AppendFlusherOptions<E>): AppendFlusher<E> {
  const schedule = opts.schedule ?? defaultSchedule;
  let queue: E[] = [];
  let timer: { cancel(): void } | undefined;
  let closed = false;
  let inFlight: Promise<void> = Promise.resolve();

  const report = (err: unknown, batch: E[]) =>
    opts.onError?.(err instanceof Error ? err : new Error(String(err)), batch);

  const sendNow = (): Promise<void> => {
    timer?.cancel();
    timer = undefined;
    if (queue.length === 0) return inFlight;
    const batch = queue;
    queue = [];
    const attempt = opts.send(batch).catch((err) => report(err, batch));
    inFlight = inFlight.then(() => attempt);
    return inFlight;
  };

  return {
    push(event) {
      if (closed) {
        report(new Error("flusher closed"), [event]);
        return;
      }
      queue.push(event);
      if (queue.length >= opts.maxEvents) {
        void sendNow();
        return;
      }
      if (!timer) timer = schedule(() => void sendNow(), opts.flushMs);
    },
    flush: () => sendNow(),
    pending: () => queue.length,
    async close() {
      closed = true;
      await sendNow();
    },
  };
}
