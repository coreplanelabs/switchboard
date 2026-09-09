import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { isSpanRecord, serializedOnce, type RunEvent } from "../../core/runEvents.js";
import type { IndexEvent, Subscribed } from "../../core/runRegistry.js";
import type { FinishedFrame, SealedFrame, Unsubscribe } from "../../core/runRegistry/state.js";

// Server-Sent Events transport for the live view: the per-run stream (the
// registry's budgeted replay + forward, or the stored history replay), the
// runs-index feed, the node:http sink and keepalive heartbeat. The `serve*`
// functions drive an abstract `SseSink`, so they are unit-testable without a
// socket.

/** SSE response headers. `no-transform` + `x-accel-buffering: no` keep proxies
 *  from buffering the stream, so events arrive as they are written. */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/** A minimal, transport-free sink for an SSE response, so `serveEvents` is
 *  unit-testable without a real socket. `onClose` registers a callback for when
 *  the client disconnects (used to unsubscribe). */
export interface SseSink {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
  onClose(cb: () => void): void;
}

/** A frame on the per-run stream: a run event, or a notice from the transport
 *  itself. `replay_note` marks records MISSING from a stored stream
 *  (`withOmittedMarkers`) — it is NOT a run event and never enters the registry
 *  or the run record. A live replay that skipped retained events says so with
 *  the named `replay_elided` frame instead (`sseElided`), so the two are never
 *  confused: elided events still exist in the registry and on the record. */
export type LiveFrame = RunEvent | { type: "replay_note"; summary: string };

/** The named frame a live replay writes, once and first, when the registry's
 *  replay budget left retained events out: the contiguous `seq` range the
 *  viewer did not get. A named event carries no `id:`, so it never moves a
 *  resuming client's cursor. */
export type ReplayElided = { fromSeq: number; toSeq: number };

/** One SSE frame for a run event: `id:` is its position in the run's stream (the
 *  registry's `seq`), so a browser that reconnects (proxy drop, deploy, laptop
 *  sleep) sends it back as `Last-Event-ID` and the server replays only what it
 *  missed — instead of the whole backlog again, which the page would have
 *  appended as duplicates. */
function sseData(event: RunEvent, seq: number): string {
  return `id: ${seq}\ndata: ${serializedOnce(event)}\n\n`;
}

/** One SSE `data:` frame for a transport notice (`replay_note`). No `id:` — a
 *  notice has no stream position, so it must not move the client's cursor. */
function sseNotice(frame: Exclude<LiveFrame, RunEvent>): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The `replay_elided` frame (see `ReplayElided`). */
function sseElided(range: ReplayElided): string {
  return `event: replay_elided\ndata: ${JSON.stringify({ fromSeq: range.fromSeq, toSeq: range.toSeq })}\n\n`;
}

/** The `Last-Event-ID` a reconnecting EventSource sends, as the stream position
 *  to resume after; anything absent or malformed means "from the start". */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !/^\d{1,15}$/.test(raw.trim())) return 0;
  return Number(raw.trim());
}

/** The `finished` frame: the agent stopped (`registry.finish`). The stream stays
 *  open for the span records published until the seal. Named, no `id:`. */
function sseFinished(frame: FinishedFrame): string {
  return `event: finished\ndata: ${JSON.stringify({ finishedAt: frame.finishedAt })}\n\n`;
}

/** The terminal `end` frame the page listens for to close its EventSource: the
 *  stream closed (`registry.seal`), carrying the seal stamps when the registry
 *  has them; a stored stream ends with `{}`. Named, no `id:`. */
function sseEnd(frame?: SealedFrame): string {
  const body = frame
    ? { sealedAt: frame.sealedAt, ...(frame.replyOk !== undefined ? { replyOk: frame.replyOk } : {}) }
    : {};
  return `event: end\ndata: ${JSON.stringify(body)}\n\n`;
}

/** First bytes of every SSE response, written right after the 200 head and before
 *  any buffered replay. It exists to FLUSH THE HEAD immediately: when there is
 *  nothing to replay yet (an empty runs index, or a run with no events), a proxy
 *  that waits for the first body byte before forwarding the response holds the
 *  head, and the browser's EventSource is stuck "connecting" (never fires
 *  `onopen`). A lone `retry:` directive is valid SSE, is ignored as data by
 *  EventSource (it only sets the reconnect backoff), and gives the proxy a byte
 *  to forward. */
const SSE_PRELUDE = "retry: 3000\n\n";

/** Idle keepalive interval (ms). Cloudflare (and most proxies) drop a connection
 *  with no bytes for ~100s; a run-less index or an idle run would otherwise be
 *  silently disconnected. */
const SSE_HEARTBEAT_MS = 20_000;

/** Start a periodic SSE comment on a live stream so an idle connection stays open
 *  and dropped clients are detected. Unref'd so it never keeps the process alive;
 *  cleared when the client disconnects (and if a write ever throws). node:http
 *  only — the transport-free `serve*` fns stay timer-free for unit tests. */
export function startSseHeartbeat(req: HttpRequest, res: ServerResponse): void {
  const hb = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {
      clearInterval(hb);
    }
  }, SSE_HEARTBEAT_MS);
  (hb as { unref?: () => void }).unref?.();
  req.on("close", () => clearInterval(hb));
}

/**
 * Serve one run's event stream to an SseSink, given a bound `subscribe` fn
 * (already carrying the run id + token, the resume cursor and the replay budget
 * — token validation and the budget live in the registry). Ordering matters:
 * the registry replays synchronously during `subscribe`, before we've decided
 * the status code, so those frames — and a `finished` or `end` the registry
 * reports at once for a run already finished or sealed — are buffered and
 * flushed only after a 200 head is written, in that order. A `null` subscribe
 * result (unknown run or bad token) is a 404 — existence is never revealed.
 *
 * Two named frames end a live stream: `finished` when the agent stopped (the
 * stream stays open for the span records still to come) and `end` when the
 * registry sealed the run, after which the sink is closed.
 *
 * The registry replays the newest events within its budget and reports the
 * retained range it skipped; when it did, one `replay_elided` frame precedes
 * the replay so the page can mark what it did not load. Live events after the
 * replay are never capped. With a resume cursor (`Last-Event-ID` →
 * `subscribe({ afterSeq })`) the registry offers only the events after it, so
 * the budget and the cursor compose: the elided range, if any, starts after
 * the cursor.
 */
export function serveEvents(
  subscribe: (
    onEvent: (e: RunEvent, seq: number) => void,
    onFinished: (frame: FinishedFrame) => void,
    onSealed: (frame: SealedFrame) => void,
  ) => Subscribed | null,
  sink: SseSink,
  onLive?: () => void,
): void {
  // Unbounded on purpose: the registry already budgeted this replay (count and
  // bytes), so what lands here is at most that budget. A caller subscribing
  // with REPLAY_EVERYTHING must not route through here.
  const replay: Array<{ event: RunEvent; seq: number }> = [];
  let live = false;
  let finishedDuringReplay: FinishedFrame | undefined;
  let endedDuringReplay: SealedFrame | undefined;
  const onFinished = (frame: FinishedFrame) => {
    if (live) sink.write(sseFinished(frame));
    else finishedDuringReplay = frame;
  };
  const onSealed = (frame: SealedFrame) => {
    if (live) {
      sink.write(sseEnd(frame));
      sink.end();
    } else endedDuringReplay = frame;
  };

  const subscribed = subscribe(
    (e, seq) => {
      if (live) sink.write(sseData(e, seq));
      else replay.push({ event: e, seq });
    },
    onFinished,
    onSealed,
  );
  if (!subscribed) {
    sink.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    sink.write("run not found");
    sink.end();
    return;
  }

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE); // flush the head immediately (a run with no events yet has an empty backlog)
  if (subscribed.elided) sink.write(sseElided(subscribed.elided));
  for (const { event, seq } of replay) sink.write(sseData(event, seq));
  replay.length = 0;
  if (finishedDuringReplay) sink.write(sseFinished(finishedDuringReplay));
  if (endedDuringReplay) {
    sink.write(sseEnd(endedDuringReplay));
    sink.end();
    return;
  }
  sink.onClose(subscribed.unsubscribe);
  onLive?.(); // stream stays open → safe to start the keepalive heartbeat
}

/** One SSE `data:` frame for an index event (upsert/removed). No `id:` — the
 *  index has no resume semantics (a reconnect replays the current active set). */
function sseIndexData(ev: IndexEvent): string {
  return `data: ${serializedOnce(ev)}\n\n`;
}

/**
 * Serve the live runs-index feed (`GET /runs?stream=1`) to an SseSink, given a
 * bound `subscribeIndex`. Mirrors `serveEvents`: the registry replays the current
 * active set synchronously during `subscribeIndex` (before the status is chosen),
 * so those frames are buffered and flushed only after the 200 head; new events
 * live-forward. A client disconnect unsubscribes.
 *
 * Two deliberate differences from the per-run stream: there is **no token gate**
 * (the index is Access-gated at the edge, never token-gated — so it always 200s
 * and streams), and there is **no terminal `end` frame** — the index feed spans
 * the whole registry and stays open; a finished run is an `upsert` (finished),
 * and an evicted one a `removed`, not a stream close.
 */
export function serveIndexEvents(
  subscribeIndex: (onEvent: (ev: IndexEvent) => void) => Unsubscribe,
  sink: SseSink,
  onLive?: () => void,
): void {
  const buffered: string[] = [];
  let live = false;
  const send = (chunk: string) => {
    if (live) sink.write(chunk);
    else buffered.push(chunk);
  };

  const unsubscribe = subscribeIndex((ev) => send(sseIndexData(ev)));

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE); // flush the head immediately so onopen fires even with no active runs
  for (const chunk of buffered) sink.write(chunk);
  buffered.length = 0;
  sink.onClose(unsubscribe);
  onLive?.(); // stream stays open → safe to start the keepalive heartbeat
}

/**
 * The stored stream with the truncation made visible: when the
 * record holds fewer events than the run published (`eventCount`), a
 * `replay_note` — "N records omitted" (records, since the count includes span records) — marks EVERY gap in `seq` with that gap's
 * own size (a gap at the start puts one first), and whatever the gaps do not
 * account for was cut from the tail, so one more marker goes last. The counts
 * always sum to published − stored. A complete record is returned as-is. The
 * markers are transport notices, never run events (they enter no store).
 */
export function withOmittedMarkers(events: readonly RunEvent[], eventCount: number): LiveFrame[] {
  // A span record without a `seq` was synthesized by `normalizeSpans` for the
  // seed (docs/reference/specs/tracing.md): it stands for nothing the registry counted, so
  // it is neither part of the stored count nor a step of the cursor below.
  const counted = events.filter((e) => !(isSpanRecord(e) && e.seq === undefined)).length;
  const omitted = eventCount - counted;
  if (omitted <= 0) return [...events];
  const marker = (n: number): LiveFrame => ({
    type: "replay_note",
    summary: `${n} record${n === 1 ? "" : "s"} omitted`,
  });
  const out: LiveFrame[] = [];
  let expected = 1;
  let accounted = 0;
  for (const e of events) {
    if (typeof e.seq === "number" && e.seq > expected) {
      const gap = Math.min(e.seq - expected, omitted - accounted);
      if (gap > 0) {
        out.push(marker(gap));
        accounted += gap;
      }
    }
    out.push(e);
    // Only a stamped event moves the cursor: a synthesized span (the seed is
    // normalized before the markers) or another marker has no `seq` and
    // stands for nothing the registry counted.
    if (typeof e.seq === "number") expected = e.seq + 1;
  }
  if (accounted < omitted) out.push(marker(omitted - accounted));
  return out;
}

/**
 * Serve a finished run's stored stream from the events the caller already
 * holds — one `getRun({ include: "messages" })` read carries the whole record,
 * so the history path knows every event before it writes a head without
 * re-reading the record per page. Then the 200 head, the prelude, each frame
 * (with the omission marker in place), and the terminal `end`.
 * `eventCount` is the run's published total, for the marker.
 */
export function serveHistoryEvents(events: readonly RunEvent[], eventCount: number, sink: SseSink): void {
  sink.writeHead(200, SSE_HEADERS);
  sink.write(SSE_PRELUDE);
  withOmittedMarkers(events, eventCount).forEach((frame, i) => {
    sink.write(frame.type === "replay_note" ? sseNotice(frame) : sseData(frame, frame.seq ?? i + 1));
  });
  sink.write(sseEnd());
  sink.end();
}

/** Wrap a node ServerResponse/request pair as an SseSink. */
export function nodeSseSink(req: HttpRequest, res: ServerResponse): SseSink {
  return {
    writeHead: (status, headers) => void res.writeHead(status, headers),
    write: (chunk) => void res.write(chunk),
    end: () => void res.end(),
    onClose: (cb) => void req.on("close", cb),
  };
}
