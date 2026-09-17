import type { RunRegistry } from "./runRegistry.js";
import type { SealResult } from "./runRegistry/projections.js";

// How a dispatch ends its runs (docs/reference/specs/tracing.md; live-view item 4). A run
// FINISHES when the agent stops (`registry.finish`) and is SEALED when the
// first reply attempt has completed — success or failure — or its branch was
// abandoned without one. Between the two the stream is open for the span
// records of the card close and the reply. Every record of a finished run is
// written AFTER its seal, by the drain, so the record carries the seal's
// stamps and the events the seal returned. One `RunEnding` per dispatch:
// a Collecting Parameter for the runs finished so far and the record writers
// waiting on their seal, and one Unit of Work (`drain`) that seals then writes.

/** A record writer registered at a run's finish and run once, after the seal.
 *  `failedAfterFinish` is set by `sealAfterReply` when a card close or reply
 *  threw AFTER the run finished, on entries that opted in — the main path's and
 *  the ship's, whose `completed` then becomes `failed` (the thread never saw
 *  the answer); a command run's status is its command's `ok` and never flips. */
export interface PendingRecord {
  runId: string;
  flipOnPostFinishFailure: boolean;
  failedAfterFinish: boolean;
  /** Assemble and hand the record to the store; `failedAfterFinish` is this
   *  entry's flag at drain time. Must call the writer before its first `await`,
   *  so the writer's `pending()` counts it when the dispatch's own bookkeeping
   *  runs right after the drain. */
  write(seal: SealResult, failedAfterFinish: boolean): void | Promise<void>;
}

export interface RunEnding {
  /** The run finished: seal it at the next drain. `afterSeal` runs right after
   *  that seal, whether or not it succeeded — the run's root span ends there
   *  (docs/reference/specs/tracing.md), so its `span_end` lands after the stream closed and
   *  the record shows the request as the one span still open. */
  finished(runId: string, hooks?: { afterSeal?: () => void }): void;
  /** Its record writer, run once after the seal. */
  register(entry: Omit<PendingRecord, "failedAfterFinish">): void;
  /** Forget a registered writer (another generation owns the run — the record is theirs). */
  drop(runId: string): void;
  /** Seal every finished run with `replyOk`, then run every registered writer
   *  once with its run's `SealResult`. Idempotent: a second drain finds nothing.
   *  Never throws; a writer that throws is logged with its run id only. */
  drain(replyOk: boolean | undefined, replyNote?: string): void;
  /** The reply wrap: `prelude` (the card close) then `reply`, and a drain in
   *  `finally`. `replyOk` is scoped to the reply call alone — `undefined` when
   *  no reply was given or the prelude threw, `false` once the reply was
   *  invoked, `true` when it returned — so a thrown card close seals with no
   *  caption while still flipping the record; the throw is re-raised after the
   *  flip and the drain. `opts.undelivered` says the reply call has no channel
   *  to deliver to (docs/reference/specs/run-history.md item 38): the reply is still
   *  invoked (its log line), but the seal says `replyOk: false` with the reason,
   *  because a reply nobody could receive was not delivered. */
  sealAfterReply(
    prelude: () => Promise<void>,
    reply?: () => Promise<void>,
    opts?: { undelivered?: string },
  ): Promise<void>;
}

export interface RunEndingDeps {
  registry: Pick<RunRegistry, "seal">;
  /** Where a writer's failure is reported — the run id and the error's message only, never the record. */
  log?: (line: string) => void;
  /** Runs the moment a run is reported finished, before its seal — for what must
   *  stop buying the run anything more: its model-proxy bearer is revoked here
   *  (docs/reference/specs/model-proxy.md). A throwing hook is logged with the run id only. */
  onFinished?: (runId: string) => void;
}

export function createRunEnding(deps: RunEndingDeps): RunEnding {
  const log = deps.log ?? console.error;
  const finished: Array<{ id: string; afterSeal?: () => void }> = [];
  const pending: PendingRecord[] = [];

  const drain = (replyOk: boolean | undefined, replyNote?: string): void => {
    for (const { id, afterSeal } of finished.splice(0)) {
      try {
        deps.registry.seal(
          id,
          replyOk === undefined ? {} : { replyOk, ...(replyNote !== undefined ? { replyNote } : {}) },
        );
      } catch (err) {
        log(`[ending] seal ${id}: ${describe(err)}`);
      }
      try {
        afterSeal?.();
      } catch (err) {
        log(`[ending] after seal ${id}: ${describe(err)}`);
      }
    }
    for (const entry of pending.splice(0)) {
      try {
        // `seal` is re-readable: the run was sealed above (or earlier), and the
        // result is the same every time.
        const result = deps.registry.seal(entry.runId);
        void Promise.resolve(entry.write(result, entry.failedAfterFinish)).catch((err: unknown) =>
          log(`[ending] record ${entry.runId}: ${describe(err)}`),
        );
      } catch (err) {
        log(`[ending] record ${entry.runId}: ${describe(err)}`);
      }
    }
  };

  return {
    finished(runId, hooks) {
      finished.push({ id: runId, ...(hooks?.afterSeal ? { afterSeal: hooks.afterSeal } : {}) });
      try {
        deps.onFinished?.(runId);
      } catch (err) {
        log(`[ending] finished ${runId}: ${describe(err)}`);
      }
    },
    register(entry) {
      pending.push({ ...entry, failedAfterFinish: false });
    },
    drop(runId) {
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.runId === runId) pending.splice(i, 1);
    },
    drain,
    async sealAfterReply(prelude, reply, opts) {
      let ok: boolean | undefined;
      try {
        await prelude();
        if (reply) {
          ok = false;
          await reply();
          // A reply with no channel to deliver to is not delivered: the seal
          // keeps `replyOk: false` and carries the reason.
          if (opts?.undelivered === undefined) ok = true;
        }
      } catch (err) {
        for (const entry of pending) if (entry.flipOnPostFinishFailure) entry.failedAfterFinish = true;
        throw err;
      } finally {
        drain(ok, ok === false ? opts?.undelivered : undefined);
      }
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
