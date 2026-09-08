import type { RunRecord } from "./runRecord.js";
import type { RunStore } from "./runStore.js";
import { PermanentStoreError, RouteMissingError } from "./runStoreWorker.js";

// Run history (#157, U4 / KTD4): the dispatcher's write path. A finished run's
// record is built synchronously at finish and handed here AFTER the reply is
// sent, so persistence never delays or fails the reply. The same path also
// carries the tombstone-first writes (#375): a provisional `interrupted`
// record at run start (`provisional: true` — no `onPersisted`) and the drain
// deadline's full-transcript upgrade, both upserts the finish write replaces
// when the run ends normally. Writes are
// fire-and-forget but drain-counted: `pending()` is what the shutdown drain in
// index.ts waits on (like `pendingReflectionCount`), and it counts a write for
// its whole life — retry backoff included — so SIGTERM during a backoff waits
// for the retry rather than losing the run (AGENTS.md invariant 6).
//
// Retry policy: two retries with jittered backoff (nominal 1 s, then 4 s) on a
// `TransientStoreError` (network, timeout, 408/429/5xx) or any unclassified
// error (a file store's fs failure); never on a `PermanentStoreError` (a 4xx
// such as 413, or a malformed response) — the same record would fail again; and
// never on a `RouteMissingError` (404: the state Worker predates `v3`), which
// is a deploy-ordering mistake logged ONCE per process and flagged as
// `degraded`. Every permanent loss increments `failures()`.
//
// Final beats provisional: a run's FINAL record (any non-provisional write)
// supersedes its provisional writes — one already enqueued stands down before
// its next attempt (retry backoff included), and one enqueued later is dropped
// outright. Without this, a start tombstone sitting in retry backoff when a
// fast run finishes — or a drain-deadline write racing a run that finishes
// inside the write budget — could land AFTER the finish record and clobber it
// with `interrupted`. A stood-down write is not a loss (`failures()` untouched):
// the final record IS the run's record. The one irreducible window is a
// provisional put already on the wire when the final write lands — arrival
// order at the store is then the store's.

/** Nominal backoff before retry 1 and retry 2; each is jittered ±50%. */
export const RUN_HISTORY_RETRY_DELAYS_MS: readonly number[] = [1000, 4000];

export const ROUTE_MISSING_MESSAGE =
  "[run-history] state Worker has no /runs/put — deploy the state Worker with run-history routes before this bot version";

export interface RunHistoryWriter {
  /** Persist a record in the background. Never throws; never blocks.
   *  `provisional: true` (the start-of-run `interrupted` tombstone and the
   *  drain deadline's full-transcript upgrade, #375) skips the `onPersisted`
   *  hook — the index's persisted flag means "finished and durably stored",
   *  which a provisional write must not claim — and yields to the run's final
   *  record: once a non-provisional write for the same id is enqueued, a
   *  provisional write makes no further attempt. Retries and drain accounting
   *  (`pending()`) apply to both kinds alike. `via` routes THIS record to
   *  another sink than the store — the run ledger's one-transaction `finish`
   *  for a tracked run (features/run-history.md item 35) — with the same
   *  retries, accounting and final-beats-provisional rule. */
  write(record: RunRecord, opts?: { provisional?: boolean; via?: RecordSink }): void;
  /** Writes in flight, retry backoff included — awaited by the shutdown drain. */
  pending(): number;
  /** Records lost for good (retries exhausted, 4xx, or a missing route). */
  failures(): number;
  /** True once the store answered 404 to `/runs/put`: history is off until the Worker is redeployed. */
  degraded(): boolean;
  /** Resolves once every write pending at the time of the call has settled (tests, CLI exit). */
  settled(): Promise<void>;
}

/** Where a record can be written: the store, or a sink a caller routes one write through. */
export type RecordSink = Pick<RunStore, "put"> | { put(record: RunRecord): Promise<unknown> };

export interface RunHistoryWriterOptions {
  store: RecordSink;
  warn: (message: string) => void;
  /** Called with the run id after a successful put (the dispatcher passes `registry.markPersisted`). */
  onPersisted?: (id: string) => void;
  /** Injectable backoff (tests); default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1) (tests); default `Math.random`. */
  random?: () => number;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createRunHistoryWriter(opts: RunHistoryWriterOptions): RunHistoryWriter {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const inFlight = new Set<Promise<void>>();
  // Final-beats-provisional bookkeeping (see the header): ids with a final
  // write enqueued this process, and a stand-down flag per provisional write
  // still in flight. `finals` grows one short id per finished run — bounded in
  // practice by the process lifetime (a bot container is replaced on deploy).
  const finals = new Set<string>();
  type ProvisionalFlag = { id: string; superseded: boolean };
  const provisionalFlags = new Set<ProvisionalFlag>();
  let failures = 0;
  let degraded = false;
  let routeMissingLogged = false;

  /** ±50% jitter around the nominal delay, so a burst of finishing runs does not retry in lockstep. */
  const jittered = (ms: number): number => ms * (0.5 + random());

  const persisted = (id: string): void => {
    try {
      opts.onPersisted?.(id);
    } catch (err) {
      opts.warn(`[run-history] onPersisted hook failed for ${id}: ${describe(err)}`);
    }
  };

  const attemptAll = async (record: RunRecord, flag: ProvisionalFlag | undefined, sink: RecordSink): Promise<void> => {
    const attempts = RUN_HISTORY_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; ; attempt++) {
      // A provisional write stands down (silently — not a loss) the moment the
      // run's final record is enqueued; checked before every attempt so a
      // retry waking from backoff can never clobber the final record.
      if (flag?.superseded) return;
      try {
        await sink.put(record);
        if (!flag) persisted(record.id);
        return;
      } catch (err) {
        if (err instanceof RouteMissingError) {
          failures++;
          degraded = true;
          if (!routeMissingLogged) {
            routeMissingLogged = true;
            opts.warn(ROUTE_MISSING_MESSAGE);
          }
          return;
        }
        if (err instanceof PermanentStoreError) {
          failures++;
          opts.warn(`[run-history] ${record.id} not persisted (permanent, not retried): ${describe(err)}`);
          return;
        }
        if (attempt >= attempts) {
          failures++;
          opts.warn(`[run-history] ${record.id} not persisted after ${attempts} attempts: ${describe(err)}`);
          return;
        }
        await sleep(jittered(RUN_HISTORY_RETRY_DELAYS_MS[attempt - 1]));
      }
    }
  };

  return {
    write(record, writeOpts) {
      let flag: ProvisionalFlag | undefined;
      if (writeOpts?.provisional === true) {
        if (finals.has(record.id)) return; // the final record already exists (or is on its way) — drop, don't clobber
        flag = { id: record.id, superseded: false };
        provisionalFlags.add(flag);
      } else {
        finals.add(record.id);
        for (const f of provisionalFlags) if (f.id === record.id) f.superseded = true;
      }
      // attemptAll never rejects (every path returns), but a defensive catch
      // keeps a bug here from surfacing as an unhandled rejection in a run.
      const p: Promise<void> = attemptAll(record, flag, writeOpts?.via ?? opts.store)
        .catch((err: unknown) => {
          failures++;
          opts.warn(`[run-history] ${record.id} writer failed unexpectedly: ${describe(err)}`);
        })
        .finally(() => {
          if (flag) provisionalFlags.delete(flag);
          void inFlight.delete(p);
        });
      inFlight.add(p);
    },
    pending: () => inFlight.size,
    failures: () => failures,
    degraded: () => degraded,
    settled: async () => {
      await Promise.all([...inFlight]);
    },
  };
}
