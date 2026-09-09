import type { RunSummary } from "./projections.js";
import type { Unsubscribe } from "./state.js";

// The runs-index feed: the live subscribers to the Access-gated index
// (`GET /runs?stream=1`) and the fan-out that reaches them. Separate from the
// per-run subscribers a run carries in its state: these get every run's
// lifecycle, not one run's events. The registry owns one feed and drives it
// from create/publish/finish/seal/discard/sweep; the feed knows nothing of
// runs beyond the summaries it is handed.

/**
 * A single change on the Access-gated runs index (`GET /runs`), delivered live to
 * `subscribeIndex` listeners. `upsert` carries the run's current summary — the
 * same shape `listActive()` returns — and covers create, per-event activity, and
 * finish (a finished run is an `upsert` with `finished: true`, not a removal).
 * `removed` fires exactly once, when a finished run is finally evicted by the TTL
 * sweep — the only removal signal (eviction stays lazy/timer-free).
 */
export type IndexEvent = { type: "upsert"; run: RunSummary } | { type: "removed"; id: string };

/** A live subscriber to the runs-index feed. */
export type IndexSubscriber = (event: IndexEvent) => void;

export class IndexFeed {
  /** Live subscribers to the runs-index feed (see subscribeIndex). Separate from
   *  per-run `subscribers`: these get every run's lifecycle, not one run's events. */
  private readonly subscribers = new Set<IndexSubscriber>();

  /** Attach a subscriber: `current` — the active set in `listActive()` order —
   *  is replayed to it as `upsert` events first, mirroring the per-run backlog
   *  replay, so a viewer sees every current run before any live delta. Returns
   *  an idempotent unsubscribe. */
  subscribe(onEvent: IndexSubscriber, current: readonly RunSummary[]): Unsubscribe {
    for (const run of current) onEvent({ type: "upsert", run });
    this.subscribers.add(onEvent);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(onEvent);
    };
  }

  /** Fan an index event out to index subscribers. Each callback is isolated: one
   *  that throws (e.g. a dead SSE sink) is swallowed so it can neither corrupt
   *  registry state nor throw into the create/publish/finish/sweep caller. */
  notify(ev: IndexEvent): void {
    for (const onEvent of this.subscribers) {
      try {
        onEvent(ev);
      } catch {
        // A misbehaving index subscriber must not break the lifecycle call that
        // triggered this notification, nor stop the other subscribers.
      }
    }
  }
}
