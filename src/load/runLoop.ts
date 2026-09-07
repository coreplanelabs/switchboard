// The N-thread driver every load command shares: threads start staggered over
// a window, each runs setup → iterate (until the hold ends or the run is
// aborted) → teardown, and teardown ALWAYS runs — whatever setup acquired (a
// resident pool user, a sandbox container, a Slack card) is released even when
// an iteration throws or the operator interrupts. Clock and sleep are injected
// so the tests are instant and the harness's own timing is not under test.

export interface RunThreadsOptions<T> {
  threads: number;
  /** The window over which thread starts are spread: the first thread starts
   *  at once, the last at `staggerMs`, the rest evenly between. */
  staggerMs: number;
  /** How long each thread keeps iterating after it started. */
  holdMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Abort ends every thread at its next iteration boundary. */
  signal?: AbortSignal;
  setup: (thread: number) => Promise<T>;
  /** One iteration of the thread's profile; called until the hold ends. */
  iterate: (thread: number, ctx: T, elapsedMs: number) => Promise<void>;
  /** Always called once per thread; `ctx` is undefined when setup failed and
   *  `err` is the setup or iteration error that ended the thread, if any. */
  teardown: (thread: number, ctx: T | undefined, err?: Error) => Promise<void>;
}

export interface RunThreadsResult {
  /** Threads whose setup succeeded. */
  started: number;
  setupFailures: number;
  iterations: number;
  /** Iteration errors (each ends its thread). */
  errors: number;
  teardownFailures: number;
  aborted: boolean;
}

export async function runThreads<T>(opts: RunThreadsOptions<T>): Promise<RunThreadsResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: RunThreadsResult = {
    started: 0,
    setupFailures: 0,
    iterations: 0,
    errors: 0,
    teardownFailures: 0,
    aborted: false,
  };
  const aborted = () => opts.signal?.aborted === true;

  const one = async (i: number): Promise<void> => {
    const delay = opts.threads > 1 ? Math.round((i * opts.staggerMs) / (opts.threads - 1)) : 0;
    if (delay > 0) await sleep(delay);
    if (aborted()) return;
    let ctx: T | undefined;
    let ended: Error | undefined;
    try {
      ctx = await opts.setup(i);
      result.started++;
    } catch (err) {
      result.setupFailures++;
      ended = err instanceof Error ? err : new Error(String(err));
    }
    if (ctx !== undefined && !ended) {
      const t0 = now();
      while (!aborted() && now() - t0 < opts.holdMs) {
        try {
          await opts.iterate(i, ctx, now() - t0);
          result.iterations++;
        } catch (err) {
          result.errors++;
          ended = err instanceof Error ? err : new Error(String(err));
          break;
        }
      }
    }
    try {
      await opts.teardown(i, ctx, ended);
    } catch {
      result.teardownFailures++;
    }
  };

  await Promise.all(Array.from({ length: opts.threads }, (_, i) => one(i)));
  result.aborted = aborted();
  return result;
}
