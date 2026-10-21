import type { PersonProfile } from "../../core/names.js";
import { readRequesterProfile } from "../runRequester.js";
import { RUN_VIEW_POLL_MS } from "../../core/budgets.js";
import type { IndexRunIdentity } from "../../core/runRegistry/indexFeed.js";
import { hasWorkViewScope, workReadPredicate } from "../workViewScope.js";
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
import { privateWorkerRun } from "../../core/runsService.js";

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
  if (!authorize(actor, "runs:read", RUNS_LIST).allow) return NONE;
  const readable = predicateFor(actor, "runs:read", "run");
  return hasWorkViewScope(actor) ? workReadPredicate(actor, readable) : readable;
}

/** Follow shared deletion fences for rows this connection has already seen.
 * Keep saved identities after ordinary registry eviction so a later Kill still
 * removes the browser's retained row. Visibility is applied by the outer feed. */
export function deletionAwareIndexFeed(
  subscribe: (onEvent: IndexSubscriber) => Unsubscribe,
  readDeleted: (ids: readonly string[]) => Promise<string[]>,
  initial: readonly (IndexRunIdentity & { id: string })[],
): (onEvent: IndexSubscriber) => Unsubscribe {
  return (onEvent) => {
    const known = new Map(initial.map((row) => [row.id, row]));
    let closed = false;
    let pollUnavailable = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.type === "upsert") known.set(event.run.id, event.run);
      else if (event.deleted) known.delete(event.id);
      onEvent(event);
    });
    const poll = async () => {
      try {
        const deleted = await readDeleted([...known.keys()]);
        pollUnavailable = false;
        for (const id of deleted) {
          const identity = known.get(id);
          if (!closed && identity) {
            known.delete(id);
            onEvent({ type: "removed", id, deleted: true, identity });
          }
        }
      } catch {
        if (!closed && !pollUnavailable) {
          pollUnavailable = true;
          console.warn("[runs] deletion poll unavailable; row removals are unverified");
        }
      }
      if (!closed) {
        timer = setTimeout(() => void poll(), RUN_VIEW_POLL_MS);
        timer.unref?.();
      }
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  };
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
        if (privateWorkerRun(ev.run) || !matchesPredicate(visibleTo, ev.run)) return;
        shown.add(ev.run.id);
      } else if (ev.deleted && ev.identity) {
        if (privateWorkerRun(ev.identity) || !matchesPredicate(visibleTo, ev.identity)) return;
        shown.delete(ev.id);
        onEvent({ type: "removed", id: ev.id, deleted: true });
        return;
      } else if (!shown.delete(ev.id)) return;
      onEvent(ev);
    });
  };
}

/** Resolve labels only after visibility filtering. Serialize updates so a slow
 * name lookup cannot resurrect a row after its removal. */
export function namedIndexFeed(
  subscribe: (onEvent: IndexSubscriber) => Unsubscribe,
  name?: (id: string, requesterProfileId?: string) => Promise<string | PersonProfile | undefined>,
): (onEvent: IndexSubscriber) => Unsubscribe {
  if (!name) return subscribe;
  return (onEvent) => {
    let closed = false;
    let tail = Promise.resolve();
    const names = new Map<string, Promise<PersonProfile | undefined>>();
    const unsubscribe = subscribe((event) => {
      if (closed) return;
      const id = event.type === "upsert" ? event.run.userId : undefined;
      const requesterProfileId = event.type === "upsert" ? event.run.requesterProfileId : undefined;
      const key = id ? JSON.stringify([id, requesterProfileId]) : undefined;
      // Start replay lookups together; each requester shares one bounded read.
      if (id && key && !names.has(key))
        names.set(
          key,
          readRequesterProfile((account) => name(account, requesterProfileId), id),
        );
      const label = key ? names.get(key) : undefined;
      tail = tail
        .then(async () => {
          const userProfile = await label;
          if (closed) return;
          const run =
            event.type === "upsert" && userProfile
              ? { ...event.run, userName: userProfile.name, userProfile }
              : undefined;
          onEvent(run ? { type: "upsert", run } : event);
        })
        .catch(() => undefined);
    });
    return () => {
      closed = true;
      unsubscribe();
    };
  };
}
