// The threads whose live run is on the ledger but not in this process
// (docs/reference/specs/thread-admission.md item 5): a row another generation still holds
// (a rollout overlap, or a dead generation whose lease has not expired), or a
// row this generation reclaimed and has not yet launched. In-process admission
// knows nothing of them, so a follow-up on such a thread would start a rival
// run — this map is what the dispatcher consults instead, and the answer is a
// durable steer (`pushInbox`) into the run the ledger names.
//
// Fed by the reclaim sweep: every pass lists the ledger's live rows in full, so
// `replace` is the whole truth each time and staleness is bounded by the sweep
// interval. A stale hit is harmless — the ledger refuses a push to a row it no
// longer has, the dispatcher forgets the thread and runs the message fresh.

export interface ThreadElsewhere {
  runId: string;
  agent?: string;
  startedAt: number;
}

export class ThreadsElsewhere {
  private byThread = new Map<string, ThreadElsewhere>();

  /** The sweep's current listing, replacing the previous one entirely. */
  replace(rows: Iterable<{ threadKey: string; runId: string; startedAt: number; meta: { agent?: string } }>): void {
    const next = new Map<string, ThreadElsewhere>();
    for (const r of rows) {
      next.set(r.threadKey, {
        runId: r.runId,
        startedAt: r.startedAt,
        ...(r.meta.agent !== undefined ? { agent: r.meta.agent } : {}),
      });
    }
    this.byThread = next;
  }

  get(threadKey: string): ThreadElsewhere | undefined {
    return this.byThread.get(threadKey);
  }

  /** A local run paused onto the ledger is now elsewhere for admission too. */
  remember(threadKey: string, run: ThreadElsewhere): void {
    this.byThread.set(threadKey, run);
  }

  /** Drop one thread before the next sweep: its row is gone (a refused push). */
  forget(threadKey: string): void {
    this.byThread.delete(threadKey);
  }

  get size(): number {
    return this.byThread.size;
  }
}

/** A retry handoff keeps its thread reserved only while its ledger row is
 * still owned. Do not erase a newer run's owner if the old row ended. */
export function settleRetryPause(
  threads: Pick<ThreadsElsewhere, "get" | "forget" | "remember">,
  threadKey: string,
  run: ThreadElsewhere,
  retained: boolean,
): void {
  if (retained) {
    const current = threads.get(threadKey);
    if (!current || current.runId === run.runId) threads.remember(threadKey, run);
  } else {
    if (threads.get(threadKey)?.runId === run.runId) threads.forget(threadKey);
  }
}
