// The resident's restore event (docs/reference/specs/execution.md item 23):
// while a resident is `restoring`, a run that would otherwise fall to the cold
// sandbox fleet subscribes to the moment the restore ends instead of retrying
// or racing a timer. The resident Durable Object holds each subscriber's
// request open and publishes the answer from `setResidentState` — the one
// place every lifecycle transition passes — the instant the state leaves
// `restoring`. Deliberately free of node: imports so wrangler can bundle it
// into the resident Worker, like sandboxIdle.ts and sandboxErrors.ts.

/** The subscription's ceiling: a restore is about a minute (the wake path's
 *  own ceiling, WAKE_WAIT_MAX_MS, covers a slow one at three); past it the
 *  subscriber is answered with the state as it stands and the caller decides —
 *  the bot falls back cold, as it did before the subscription existed. */
export const RESTORE_WAIT_MAX_MS = 3 * 60_000;

/** What the run's card says while the subscription is open. */
export const WAITING_FOR_RESTORE_NOTE = "waiting for the resident's restore";

/** What a subscriber is answered: the lifecycle state the transition landed
 *  on (or the state as it stands when the wait's ceiling passed). */
export interface RestoreAnswer {
  state: string;
  reason: string;
}

/** The in-memory subscriber ledger, owned by the resident Durable Object.
 *  In-memory on purpose: a subscriber is a held HTTP request into this same
 *  isolate, so nothing outlives what the waiters can answer — an isolate
 *  restart drops the requests with the ledger, and each caller falls back
 *  exactly as an unreachable resident already makes it do. */
export class RestoreWaiters {
  private waiters = new Set<(answer: RestoreAnswer) => void>();

  /** How many subscriptions are open (introspection and tests). */
  get size(): number {
    return this.waiters.size;
  }

  /** One subscription: resolves on the next publish that leaves `restoring`.
   *  Never rejects and never times out by itself — the caller bounds it. */
  subscribe(): Promise<RestoreAnswer> {
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  /** Called on every lifecycle transition. A transition INTO `restoring` (or a
   *  re-assertion of it) answers nobody: the restore is still running. Any
   *  other state is the event — every subscriber gets it, once. */
  publish(state: string, reason: string): void {
    if (state === "restoring") return;
    const answered = [...this.waiters];
    this.waiters.clear();
    for (const resolve of answered) resolve({ state, reason });
  }
}

/** The attach note once a subscription was answered and the attach succeeded:
 *  the wait is named so the card explains the run's slow start. */
export function restoredAfterWaitNote(waitedMs: number, nonWarm: string | undefined): string {
  const base = `restored after ${Math.round(waitedMs / 1000)}s (waited for the resident's restore)`;
  return nonWarm ? `${base} — ${nonWarm}` : base;
}

/** The cold-fallback note when the subscription ended without a serviceable
 *  resident: the wait is named beside the state the resident was left in. */
export function restoreWaitFallbackNote(waitedMs: number, seen: string): string {
  return `resident ${seen} after waiting ${Math.round(waitedMs / 1000)}s for the resident's restore — using fresh sandbox`;
}
