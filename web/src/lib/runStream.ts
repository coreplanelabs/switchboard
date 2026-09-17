import { ref, type Ref } from "vue";
import { EVENT_SOURCE_CLOSED, type EventSourceFactory, type EventSourceLike } from "./eventSource";
import { parseEndFrame, parseFinishedFrame, parseReplayElided, type RunPageModel } from "./runPageModel";

// The ONE way a page follows a run's live stream (docs/reference/specs/live-view.md
// items 6 and 22; docs/reference/specs/web-chat.md item 4): the run page and a
// thread's assistant turn both attach here, so the transport rules live once —
// a frame at or before the last applied `seq` is dropped (a proxy that strips
// `Last-Event-ID` would replay the backlog as duplicates), `replay_elided`
// tells the model what the backlog left out, `finished` means the agent
// stopped and the reply is on its way, `end` flushes the pending turn and
// closes the phases, and a closed source after the browser gave up is
// `disconnected`. What each page DRAWS for a phase, and how it freezes its
// clock, stays the page's own: the hooks below hand it the frames.

/** Where the stream is, in the run page's words (live-view item 22). `stopping`
 *  is the page's own: it sets it when the viewer asked for a stop. */
export type StreamPhase = "connecting" | "running" | "stopping" | "finished" | "ended" | "disconnected";

export interface RunStreamOptions {
  url: string;
  factory: EventSourceFactory;
  model: Pick<RunPageModel, "noteElided" | "flushPendingTurn" | "closePhases"> & { state: { stopMode: unknown } };
  /** Every run-event frame past the dedupe, for the page to fold (`model.handle`) and read. */
  handle: (event: unknown) => void;
  /** The agent stopped. `null` when the frame did not parse: the run is finished all the same. */
  onFinished?: (frame: { finishedAt: number } | null) => void;
  onEnd?: (frame: { sealedAt?: number; replyOk?: boolean }) => void;
  onDisconnected?: () => void;
}

export interface RunStream {
  phase: Ref<StreamPhase>;
  close(): void;
}

export function attachRunStream(opts: RunStreamOptions): RunStream {
  const phase = ref<StreamPhase>("connecting");
  const es: EventSourceLike = opts.factory(opts.url);
  es.onopen = () => {
    if (phase.value === "connecting" && !opts.model.state.stopMode) phase.value = "running";
  };
  let lastSeq = 0;
  es.onmessage = (m) => {
    let e: { type?: string };
    try {
      e = JSON.parse(m.data) as typeof e;
    } catch {
      return;
    }
    // Run-event frames carry their stream position as the SSE id; a transport
    // notice (replay_note) has no id of its own — exempt from the dedupe.
    if (e.type !== "replay_note") {
      const sid = Number(m.lastEventId);
      if (sid > 0) {
        if (sid <= lastSeq) return;
        lastSeq = sid;
      }
    }
    opts.handle(e);
  };
  es.addEventListener("replay_elided", (data) => {
    const range = parseReplayElided(data);
    if (range) opts.model.noteElided(range);
  });
  es.addEventListener("finished", (data) => {
    opts.onFinished?.(parseFinishedFrame(data));
    if (phase.value === "connecting" || phase.value === "running") phase.value = "finished";
  });
  es.addEventListener("end", (data) => {
    opts.model.flushPendingTurn("the run ended here"); // a run that ended without a reply still shows its last turn
    opts.model.closePhases();
    phase.value = "ended";
    es.close();
    opts.onEnd?.(parseEndFrame(data));
  });
  es.onerror = () => {
    if (es.readyState === EVENT_SOURCE_CLOSED) {
      phase.value = "disconnected";
      opts.onDisconnected?.();
    }
  };
  return {
    phase,
    close: () => es.close(),
  };
}
