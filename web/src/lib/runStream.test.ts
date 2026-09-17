import { describe, expect, it, vi } from "vitest";
import { attachRunStream } from "./runStream";
import { fakeEventSourceFactory } from "../testing/fakeEventSource";

// Feature: docs/reference/specs/live-view.md items 6 and 22; web-chat.md item 4 —
// the one stream attach the run page and a thread's turn share: the seq dedupe,
// the named frames, the phases.

function model() {
  return {
    state: { stopMode: null as unknown },
    noteElided: vi.fn(),
    flushPendingTurn: vi.fn(),
    closePhases: vi.fn(),
  };
}

describe("attachRunStream", () => {
  it("hands every new frame to the page's fold and drops a replayed one by its seq; a notice has no seq", () => {
    const { created, factory } = fakeEventSourceFactory();
    const m = model();
    const handle = vi.fn();
    const stream = attachRunStream({ url: "/runs/r/events?t=x", factory, model: m, handle });
    const es = created[0];
    expect(es.url).toBe("/runs/r/events?t=x");
    expect(stream.phase.value).toBe("connecting");
    es.emitOpen();
    expect(stream.phase.value).toBe("running");
    es.emitMessage({ type: "assistant", text: "a", seq: 1 }, "1");
    es.emitMessage({ type: "assistant", text: "b", seq: 2 }, "2");
    es.emitMessage({ type: "assistant", text: "b again", seq: 2 }, "2");
    es.emitMessage({ type: "replay_note", summary: "3 events left out" });
    es.emitMessage("not json", "9");
    expect(handle.mock.calls.map((c) => (c[0] as { type: string; text?: string }).text ?? "note")).toEqual([
      "a",
      "b",
      "note",
    ]);
  });

  it("finished, end and a closed source move the phase and call the page's hooks; end flushes the model", () => {
    const { created, factory } = fakeEventSourceFactory();
    const m = model();
    const onFinished = vi.fn();
    const onEnd = vi.fn();
    const stream = attachRunStream({ url: "/x", factory, model: m, handle: () => {}, onFinished, onEnd });
    const es = created[0];
    es.emitOpen();
    es.emitNamed("replay_elided", JSON.stringify({ fromSeq: 1, toSeq: 4 }));
    expect(m.noteElided).toHaveBeenCalledWith({ fromSeq: 1, toSeq: 4 });
    es.emitNamed("finished", JSON.stringify({ finishedAt: 1_700_000_000_000 }));
    expect(stream.phase.value).toBe("finished");
    expect(onFinished).toHaveBeenCalledWith({ finishedAt: 1_700_000_000_000 });
    es.emitNamed("end", JSON.stringify({ sealedAt: 1_700_000_001_000, replyOk: true }));
    expect(stream.phase.value).toBe("ended");
    expect(m.flushPendingTurn).toHaveBeenCalledWith("the run ended here");
    expect(m.closePhases).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith({ sealedAt: 1_700_000_001_000, replyOk: true });
    expect(es.closed).toBe(true);
  });

  it("a stop the viewer asked for keeps the page's word on open; a closed source is disconnected", () => {
    const { created, factory } = fakeEventSourceFactory();
    const m = model();
    m.state.stopMode = "soft";
    const onDisconnected = vi.fn();
    const stream = attachRunStream({ url: "/x", factory, model: m, handle: () => {}, onDisconnected });
    const es = created[0];
    es.emitOpen();
    expect(stream.phase.value).toBe("connecting");
    es.emitError(false);
    expect(stream.phase.value).toBe("connecting");
    es.emitError(true);
    expect(stream.phase.value).toBe("disconnected");
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    stream.close();
    expect(es.closed).toBe(true);
  });
});
