import type { RunEvent } from "../core/runEvents.js";
import type { RunRegistry } from "../core/runRegistry.js";
import type { IndexSubscriber } from "../core/runRegistry/indexFeed.js";
import type { Unsubscribe } from "../core/runRegistry/state.js";
import { SSE_HEADERS, SSE_PRELUDE, type SseSink } from "./liveView/sse.js";
import type { ResidentListing } from "./residentsModel.js";
import type { ResidentsFeedFrame } from "./webSeed.js";

// The residents index feed (`GET /residents?stream=1`, resident-repos item
// 42): what keeps the folds on the residents index current without a timer.
// Two buses carry everything the page needs, and both already exist:
//
//  - the registry's index feed says which runs are live and on which repo —
//    forwarded as the same `upsert` / `removed` frames the runs index gets,
//    narrowed to runs that name a repo (a run without one is on no resident);
//  - a run's own stream says when its tree on the resident changed hands: the
//    `dispatch.workspace.attach` span ended (the tree is bound, or the attach
//    failed) and the stream sealed (the release at run end is done — item 17).
//    On either, the admin listing is read once more and pushed whole as a
//    `residents` frame: the resident Worker is the only source of the bindings
//    and the disk sample, and it is read live, never cached, as every page of
//    this dash reads it.
//
// Reads are coalesced: one in flight at most, and at most one more queued
// behind it, so a burst of runs attaching at once costs two reads, not N —
// and a listing that fails leaves the page on the one it has (the seed's, or
// the last frame's) rather than an empty or half state.

/** The span whose end says a run's worktree on a resident is bound (or the
 *  attach failed): the dispatcher's one attach span (docs/reference/specs/tracing.md). */
export const ATTACH_SPAN = "dispatch.workspace.attach";

/** What the feed needs of the process: the viewer's index feed (already
 *  narrowed by `visibleIndexFeed`), the registry's per-run subscribe, and one
 *  admin listing read. `listing` resolves to the listing or to the reason it
 *  could not be read — never rejects. */
export interface ResidentsFeedSource {
  subscribeIndex(onEvent: IndexSubscriber): Unsubscribe;
  subscribeRun: RunRegistry["subscribe"];
  listing(): Promise<ResidentListing | { error: string }>;
}

function frame(f: ResidentsFeedFrame): string {
  return `data: ${JSON.stringify(f)}\n\n`;
}

/** Is this run event the end of the attach span? (a `span_end` named `ATTACH_SPAN`) */
export function isAttachEnd(event: RunEvent): boolean {
  return event.type === "span_end" && event.name === ATTACH_SPAN;
}

/**
 * Serve the residents feed to an SseSink. The index subscription replays the
 * current live set synchronously (as `upsert` frames) before the head is
 * written, so those frames are buffered and flushed after the 200 — the same
 * order `serveIndexEvents` keeps. Every subscription taken is released when
 * the client disconnects. `onLive` fires once the stream is open (the caller
 * starts its keepalive there).
 */
export function serveResidentsFeed(source: ResidentsFeedSource, sink: SseSink, onLive?: () => void): void {
  const buffered: string[] = [];
  let live = false;
  let closed = false;
  const send = (chunk: string) => {
    if (closed) return;
    if (live) sink.write(chunk);
    else buffered.push(chunk);
  };

  // ---- the listing, re-read on demand and coalesced ----
  let reading = false;
  let queued = false;
  const reread = () => {
    if (closed) return;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    void source.listing().then((r) => {
      reading = false;
      if (!("error" in r)) send(frame({ type: "residents", cap: r.cap, count: r.count, residents: r.residents }));
      if (queued) {
        queued = false;
        reread();
      }
    });
  };

  // ---- the runs, and each live run's own stream for its attach and seal ----
  const shown = new Set<string>();
  const watched = new Map<string, Unsubscribe>();
  const unwatch = (id: string) => {
    watched.get(id)?.();
    watched.delete(id);
  };
  const watch = (id: string, token: string) => {
    if (watched.has(id)) return;
    // The backlog is not the signal: the seed (or the last `residents` frame)
    // already shows a tree bound before now. One event of replay — the least
    // the registry offers — keeps the subscription cheap; the attach and the
    // seal are watched forward from here.
    const sub = source.subscribeRun(id, token, {
      onEvent: (event) => {
        if (isAttachEnd(event)) reread();
      },
      onSealed: () => {
        unwatch(id);
        reread();
      },
      limit: 1,
    });
    if (sub) watched.set(id, sub.unsubscribe);
  };

  const unsubscribeIndex = source.subscribeIndex((ev) => {
    if (ev.type === "upsert") {
      if (ev.run.repo === undefined) return;
      shown.add(ev.run.id);
      send(frame({ type: "upsert", run: ev.run }));
      if (!ev.run.finished) watch(ev.run.id, ev.run.token);
      return;
    }
    if (!shown.delete(ev.id)) return;
    unwatch(ev.id);
    send(frame({ type: "removed", id: ev.id }));
  });

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE);
  for (const chunk of buffered) sink.write(chunk);
  buffered.length = 0;
  sink.onClose(() => {
    closed = true;
    unsubscribeIndex();
    for (const off of watched.values()) off();
    watched.clear();
  });
  onLive?.();
}
