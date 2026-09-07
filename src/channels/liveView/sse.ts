import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { serializedOnce, type RunEvent } from "../../core/runEvents.js";
import type { IndexEvent, Unsubscribe } from "../../core/runRegistry.js";

// Server-Sent Events transport for the live view: the per-run stream (live
// replay ring + forward, or the stored history replay), the runs-index feed,
// the node:http sink and keepalive heartbeat. The `serve*` functions drive an
// abstract `SseSink`, so they are unit-testable without a socket.

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
 *  itself. `replay_note` is emitted once, first, when a late subscriber's replay
 *  was capped — it is NOT a run event and never enters the registry or the run
 *  record (the full stream stays readable via `snapshot` / the history page). */
export type LiveFrame = RunEvent | { type: "replay_note"; summary: string };

/** Most backlog frames a late subscriber is replayed (#157 KTD9); the newest
 *  win. The registry keeps up to 5000 — the browser does not need them all to
 *  follow a live run, and the page must not stall on a 4 MiB burst. */
export const REPLAY_LIMIT = 1000;

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

/** The `Last-Event-ID` a reconnecting EventSource sends, as the stream position
 *  to resume after; anything absent or malformed means "from the start". */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !/^\d{1,15}$/.test(raw.trim())) return 0;
  return Number(raw.trim());
}

/** The terminal `end` frame the page listens for to close its EventSource. */
const SSE_END = "event: end\ndata: {}\n\n";

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
 * (already carrying the run id + token — token validation lives in the
 * registry). Ordering matters: the registry replays the backlog synchronously
 * during `subscribe`, before we've decided the status code, so those frames are
 * buffered and flushed only after a 200 head is written. A `null` subscribe
 * result (unknown run or bad token) is a 404 — existence is never revealed.
 *
 * The replay is capped at the newest `REPLAY_LIMIT` events; when the backlog
 * held more, a leading `replay_note` frame says how many of how many were
 * replayed. Live events after the replay are never capped. The buffer is a
 * bounded ring — the oldest event is shifted out once it holds `REPLAY_LIMIT`
 * — and `replayed` counts everything the backlog offered, for the note. With a
 * resume cursor (`Last-Event-ID` → `subscribe(…, afterSeq)`) the registry
 * offers only the events after it, so the ring and the note both count from
 * the cursor — the two mechanisms compose rather than overlap.
 */
export function serveEvents(
  subscribe: (onEvent: (e: RunEvent, seq: number) => void, onFinish: () => void) => Unsubscribe | null,
  sink: SseSink,
  onLive?: () => void,
): void {
  const replay: Array<{ event: RunEvent; seq: number }> = [];
  let replayed = 0;
  let live = false;
  let endedDuringReplay = false;
  const onFinish = () => {
    if (live) {
      sink.write(SSE_END);
      sink.end();
    } else endedDuringReplay = true;
  };

  const unsubscribe = subscribe((e, seq) => {
    if (live) {
      sink.write(sseData(e, seq));
      return;
    }
    replayed++;
    if (replay.length === REPLAY_LIMIT) replay.shift();
    replay.push({ event: e, seq });
  }, onFinish);
  if (!unsubscribe) {
    sink.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    sink.write("run not found");
    sink.end();
    return;
  }

  sink.writeHead(200, SSE_HEADERS);
  live = true;
  sink.write(SSE_PRELUDE); // flush the head immediately (a run with no events yet has an empty backlog)
  if (replayed > REPLAY_LIMIT) {
    sink.write(sseNotice({ type: "replay_note", summary: `replaying last ${REPLAY_LIMIT} of ${replayed} events` }));
  }
  for (const { event, seq } of replay) sink.write(sseData(event, seq));
  replay.length = 0;
  if (endedDuringReplay) {
    sink.write(SSE_END);
    sink.end();
    return;
  }
  sink.onClose(unsubscribe);
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
 * The stored stream with the truncation made visible (R12 / AE11): when the
 * record holds fewer events than the run published (`eventCount`), a
 * `replay_note` — "N events omitted" — marks EVERY gap in `seq` with that gap's
 * own size (a gap at the start puts one first), and whatever the gaps do not
 * account for was cut from the tail, so one more marker goes last. The counts
 * always sum to published − stored. A complete record is returned as-is. The
 * markers are transport notices, never run events (they enter no store).
 */
export function withOmittedMarkers(events: readonly RunEvent[], eventCount: number): LiveFrame[] {
  const omitted = eventCount - events.length;
  if (omitted <= 0) return [...events];
  const marker = (n: number): LiveFrame => ({
    type: "replay_note",
    summary: `${n} event${n === 1 ? "" : "s"} omitted`,
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
    expected = typeof e.seq === "number" ? e.seq + 1 : expected + 1;
  }
  if (accounted < omitted) out.push(marker(omitted - accounted));
  return out;
}

/**
 * Serve a finished run's stored stream (R12) from the events the caller already
 * holds — one `getRun({ include: "messages" })` read carries the whole record,
 * so the history path knows every event before it writes a head (KTD6) without
 * re-reading the record per page. Then the 200 head, the prelude, each frame
 * (with the AE11 omission marker in place), and the terminal `end`.
 * `eventCount` is the run's published total, for the marker.
 */
export function serveHistoryEvents(events: readonly RunEvent[], eventCount: number, sink: SseSink): void {
  sink.writeHead(200, SSE_HEADERS);
  sink.write(SSE_PRELUDE);
  withOmittedMarkers(events, eventCount).forEach((frame, i) => {
    sink.write(frame.type === "replay_note" ? sseNotice(frame) : sseData(frame, frame.seq ?? i + 1));
  });
  sink.write(SSE_END);
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
