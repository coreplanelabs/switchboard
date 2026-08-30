import { describe, expect, it } from "vitest";
import { mapLimit } from "./mapLimit.js";

describe("mapLimit", () => {
  function gated() {
    let inFlight = 0;
    let peak = 0;
    const waiters: Array<() => void> = [];
    const fn = async (x: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => waiters.push(r));
      inFlight--;
      return x * 2;
    };
    return { fn, peak: () => peak, inFlight: () => inFlight, release: () => waiters.splice(0).forEach((r) => r()) };
  }
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("keeps at most `limit` calls in flight and returns results in input order", async () => {
    const g = gated();
    const p = mapLimit([1, 2, 3, 4, 5], 2, g.fn);
    await tick();
    expect(g.inFlight()).toBe(2);
    g.release();
    await tick();
    expect(g.inFlight()).toBe(2);
    g.release();
    await tick();
    expect(g.inFlight()).toBe(1);
    g.release();
    expect(await p).toEqual([2, 4, 6, 8, 10]);
    expect(g.peak()).toBe(2);
  });

  it("empty input resolves to []; a limit above the length is full concurrency; a limit below 1 is serial", async () => {
    expect(await mapLimit([], 4, async (x: number) => x)).toEqual([]);
    const g = gated();
    const p = mapLimit([1, 2, 3], 10, g.fn);
    await tick();
    expect(g.inFlight()).toBe(3);
    g.release();
    await p;
    const s = gated();
    const q = mapLimit([1, 2], 0, s.fn);
    await tick();
    expect(s.inFlight()).toBe(1);
    s.release();
    await tick();
    s.release();
    await q;
    expect(s.peak()).toBe(1);
  });

  it("rejects on the first failure and starts nothing further", async () => {
    const started: number[] = [];
    const p = mapLimit([1, 2, 3, 4], 1, async (x) => {
      started.push(x);
      if (x === 2) throw new Error("boom");
      return x;
    });
    await expect(p).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });
});
