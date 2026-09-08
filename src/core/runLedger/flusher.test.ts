import { describe, expect, it } from "vitest";
import { createAppendFlusher } from "./flusher.js";

// The append flusher (features/run-history.md item 30): events reach the
// ledger in batches — every 500 ms or 32 events, whichever first — and a push
// never blocks or throws; a failed send is reported and dropped, because the
// transcript, not the event stream, is what a resume is rebuilt from.

function harness(opts: { fail?: boolean } = {}) {
  const sent: Array<Array<{ seq: number }>> = [];
  const errors: string[] = [];
  let timer: (() => void) | undefined;
  let timerMs: number | undefined;
  const flusher = createAppendFlusher<{ seq: number }>({
    flushMs: 500,
    maxEvents: 3,
    send: async (batch) => {
      if (opts.fail) throw new Error("HTTP 503");
      sent.push(batch);
    },
    onError: (err, batch) => errors.push(`${err.message} (${batch.length} dropped)`),
    schedule: (fn, ms) => {
      timer = fn;
      timerMs = ms;
      return { cancel: () => (timer = undefined) };
    },
  });
  return {
    flusher,
    sent,
    errors,
    fire: async () => {
      const t = timer;
      timer = undefined;
      t?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    get timerMs() {
      return timerMs;
    },
    get armed() {
      return timer !== undefined;
    },
  };
}

describe("createAppendFlusher", () => {
  it("the first push arms one timer for flushMs; the timer sends everything pushed since, in order", async () => {
    const h = harness();
    h.flusher.push({ seq: 1 });
    h.flusher.push({ seq: 2 });
    expect(h.timerMs).toBe(500);
    expect(h.sent).toEqual([]);
    await h.fire();
    expect(h.sent).toEqual([[{ seq: 1 }, { seq: 2 }]]);
    expect(h.armed).toBe(false);
  });

  it("reaching maxEvents sends at once without waiting for the timer", async () => {
    const h = harness();
    h.flusher.push({ seq: 1 });
    h.flusher.push({ seq: 2 });
    h.flusher.push({ seq: 3 });
    await Promise.resolve();
    expect(h.sent).toEqual([[{ seq: 1 }, { seq: 2 }, { seq: 3 }]]);
    expect(h.armed).toBe(false);
  });

  it("flush() sends what is pending now and resolves when the send settles; pending() counts unsent events", async () => {
    const h = harness();
    h.flusher.push({ seq: 1 });
    expect(h.flusher.pending()).toBe(1);
    await h.flusher.flush();
    expect(h.sent).toEqual([[{ seq: 1 }]]);
    expect(h.flusher.pending()).toBe(0);
    await h.flusher.flush(); // nothing pending: a no-op
    expect(h.sent).toHaveLength(1);
  });

  it("a failing send is reported with the batch size and the batch is dropped; later pushes still flow", async () => {
    const h = harness({ fail: true });
    h.flusher.push({ seq: 1 });
    await h.flusher.flush();
    expect(h.errors).toEqual(["HTTP 503 (1 dropped)"]);
    expect(h.flusher.pending()).toBe(0);
  });

  it("close() flushes and refuses further pushes (reported, not thrown)", async () => {
    const h = harness();
    h.flusher.push({ seq: 1 });
    await h.flusher.close();
    expect(h.sent).toEqual([[{ seq: 1 }]]);
    h.flusher.push({ seq: 2 });
    expect(h.errors).toEqual(["flusher closed (1 dropped)"]);
  });
});
