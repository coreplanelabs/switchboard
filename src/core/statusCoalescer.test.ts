import { describe, expect, it } from "vitest";
import { coalesceStatus } from "./statusCoalescer.js";
import type { StatusHandle, StatusUpdate } from "./types.js";

// Feature: features/run-visibility.md — the status card is refreshed per event
// but edited at most once per interval, always landing on the newest frame.

function harness(minIntervalMs = 3000) {
  let t = 0;
  const sent: StatusUpdate[] = [];
  let finished: StatusUpdate | undefined;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const inner: StatusHandle = {
    update: (f) => void sent.push(f),
    done: async (f) => void (finished = f),
  };
  const handle = coalesceStatus(
    inner,
    minIntervalMs,
    () => t,
    (fn, ms) => {
      timers.push({ at: t + ms, fn });
      return {};
    },
  );
  const advance = (ms: number) => {
    t += ms;
    for (const timer of timers.splice(0)) {
      if (timer.at <= t) timer.fn();
      else timers.push(timer);
    }
  };
  return { handle, sent, finished: () => finished, advance, timers };
}

describe("coalesceStatus", () => {
  it("sends the first frame immediately, then one trailing edit carrying the newest of a burst", () => {
    const h = harness();
    h.handle.update({ title: "1" });
    h.handle.update({ title: "2" });
    h.handle.update({ title: "3" });
    expect(h.sent.map((f) => f.title)).toEqual(["1"]);
    h.advance(2999);
    expect(h.sent.map((f) => f.title)).toEqual(["1"]);
    h.advance(1);
    expect(h.sent.map((f) => f.title)).toEqual(["1", "3"]);
    expect(h.timers).toHaveLength(0);
  });

  it("a frame after a quiet stretch goes out at once again", () => {
    const h = harness();
    h.handle.update({ title: "1" });
    h.advance(10_000);
    h.handle.update({ title: "2" });
    expect(h.sent.map((f) => f.title)).toEqual(["1", "2"]);
  });

  it("skips a frame identical to the last one sent (heartbeat with nothing new)", () => {
    const h = harness();
    h.handle.update({ title: "same", detail: "d" });
    h.advance(5000);
    h.handle.update({ title: "same", detail: "d" });
    h.advance(5000);
    h.handle.update({ title: "same", detail: "changed" });
    expect(h.sent).toEqual([
      { title: "same", detail: "d" },
      { title: "same", detail: "changed" },
    ]);
  });

  it("a frame whose only change is the link is NOT skipped as identical", () => {
    const h = harness();
    h.handle.update({ title: "same", detail: "d" });
    h.advance(5000);
    h.handle.update({ title: "same", detail: "d", link: { url: "https://x/runs/1?t=a", label: "Live run" } });
    expect(h.sent).toHaveLength(2);
  });

  it("done writes its frame immediately and a stale trailing flush never follows it", async () => {
    const h = harness();
    h.handle.update({ title: "1" });
    h.handle.update({ title: "2" }); // trailing edit armed
    await h.handle.done({ title: "✅ final" });
    expect(h.finished()).toEqual({ title: "✅ final" });
    h.advance(10_000);
    expect(h.sent.map((f) => f.title)).toEqual(["1"]); // "2" was dropped, not sent after done
    h.handle.update({ title: "late" });
    expect(h.sent.map((f) => f.title)).toEqual(["1"]);
  });
});
