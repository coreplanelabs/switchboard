import {
  authorize,
  matchesPredicate,
  predicateFor,
  type Actor,
  type Predicate,
  type Resource,
} from "../../core/authz/index.js";
import type { IndexSubscriber } from "../../core/runRegistry/indexFeed.js";
import type { Unsubscribe } from "../../core/runRegistry/state.js";

// What one dashboard viewer may see of the run registry: the predicate the
// Access-gated pages list live runs through, and the index feed narrowed to
// it. Shared by every surface that shows registry rows to a viewer (the runs
// index, the Scheduled tab, the residents index), so the same identity is
// shown the same runs wherever they are listed.

/** The command row the `/api` twin of a live listing is admitted by first
 *  (`runs.list`): the actor must hold `runs:read` at all before any run row is
 *  consulted, so an HTML surface is never wider than `/api/runs.*` for the
 *  same identity. */
const RUNS_LIST: Resource = { type: "command", id: "runs.list" };
const NONE: Predicate = { kind: "none" };

/** What the viewer may list (authorization.md item 6): nothing unless the actor
 *  is admitted to run reads, else the store predicate over its channels. */
export function readableRuns(actor: Actor): Predicate {
  return authorize(actor, "runs:read", RUNS_LIST).allow ? predicateFor(actor, "runs:read", "run") : NONE;
}

/**
 * The runs-index feed as ONE viewer may see it: an `upsert` for a run outside
 * the predicate is dropped, and so is that run's later `removed` — the page
 * never learns the id of a run it was not shown. Every live run is stamped at
 * `create()`, so one decision per run holds for its whole life; `shown` is
 * bounded by the registry's live set (an id leaves it with its `removed`).
 */
export function visibleIndexFeed(
  subscribeIndex: (onEvent: IndexSubscriber) => Unsubscribe,
  visibleTo: Predicate,
): (onEvent: IndexSubscriber) => Unsubscribe {
  return (onEvent) => {
    const shown = new Set<string>();
    return subscribeIndex((ev) => {
      if (ev.type === "upsert") {
        if (!matchesPredicate(visibleTo, ev.run)) return;
        shown.add(ev.run.id);
      } else if (!shown.delete(ev.id)) return;
      onEvent(ev);
    });
  };
}
