import { describe, expect, it } from "vitest";
import { runThreads } from "./runLoop.js";

// The N-thread driver every load command shares (docs/reference/specs/load-harness.md
// item 5): threads start staggered over a window, each runs setup → iterate
// (until the hold ends) → teardown, and teardown ALWAYS runs — a crashed
// iteration or an abort must still release whatever setup acquired (a resident
// pool user, a sandbox). Clock and sleep are injected so the tests are instant.

function fakeClock() {
  let t = 0;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: t + ms, resolve });
      }),
    /** Advance to the next timer and fire it; returns false when none pends. */
    async tick(): Promise<boolean> {
      if (timers.length === 0) return false;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift()!;
      t = Math.max(t, next.at);
      next.resolve();
      await Promise.resolve();
      return true;
    },
    async drain(): Promise<void> {
      for (let i = 0; i < 10_000; i++) {
        await Promise.resolve();
        if (!(await this.tick())) {
          await Promise.resolve();
          if (timers.length === 0) return;
        }
      }
    },
  };
}

describe("runThreads", () => {
  it("staggers thread starts over the window and runs setup → iterate… → teardown for each", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const starts: number[] = [];
    const done = runThreads({
      threads: 4,
      staggerMs: 300,
      holdMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      setup: async (i) => {
        starts.push(clock.now());
        log.push(`setup ${i}`);
        return { i };
      },
      iterate: async (i) => {
        log.push(`iter ${i}`);
        await clock.sleep(400);
      },
      teardown: async (i) => {
        log.push(`teardown ${i}`);
      },
    });
    await clock.drain();
    const result = await done;
    expect(starts).toEqual([0, 100, 200, 300]);
    expect(result.started).toBe(4);
    expect(result.setupFailures).toBe(0);
    expect(log.filter((l) => l.startsWith("teardown"))).toHaveLength(4);
    // Every thread iterated at least twice inside a 1 s hold with 400 ms iterations.
    for (let i = 0; i < 4; i++) expect(log.filter((l) => l === `iter ${i}`).length).toBeGreaterThanOrEqual(2);
    expect(result.iterations).toBe(log.filter((l) => l.startsWith("iter")).length);
  });

  it("a setup failure is counted, its thread never iterates, and teardown still runs with no context", async () => {
    const clock = fakeClock();
    const torn: Array<[number, unknown, string | undefined]> = [];
    const done = runThreads({
      threads: 2,
      staggerMs: 0,
      holdMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      setup: async (i) => {
        if (i === 1) throw new Error("429 user-pool-exhausted");
        return "ctx";
      },
      iterate: async () => {
        await clock.sleep(50);
      },
      teardown: async (i, ctx, err) => {
        torn.push([i, ctx, err?.message]);
      },
    });
    await clock.drain();
    const result = await done;
    expect(result.setupFailures).toBe(1);
    expect(torn).toContainEqual([1, undefined, "429 user-pool-exhausted"]);
    expect(torn).toContainEqual([0, "ctx", undefined]);
  });

  it("an iteration error ends that thread (counted) and teardown runs with the error", async () => {
    const clock = fakeClock();
    let iterations = 0;
    let tornWith: string | undefined;
    const done = runThreads({
      threads: 1,
      staggerMs: 0,
      holdMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
      setup: async () => "ctx",
      iterate: async () => {
        iterations++;
        if (iterations === 3) throw new Error("exec transport failed");
        await clock.sleep(10);
      },
      teardown: async (_i, _ctx, err) => {
        tornWith = err?.message;
      },
    });
    await clock.drain();
    const result = await done;
    expect(iterations).toBe(3);
    expect(result.errors).toBe(1);
    expect(tornWith).toBe("exec transport failed");
  });

  it("an abort signal stops every thread at its next iteration boundary and tears them down", async () => {
    const clock = fakeClock();
    const ac = new AbortController();
    let torn = 0;
    let iterations = 0;
    const done = runThreads({
      threads: 3,
      staggerMs: 0,
      holdMs: 1_000_000,
      now: clock.now,
      sleep: clock.sleep,
      signal: ac.signal,
      setup: async () => "ctx",
      iterate: async () => {
        iterations++;
        if (iterations === 3) ac.abort();
        await clock.sleep(10);
      },
      teardown: async () => {
        torn++;
      },
    });
    await clock.drain();
    const result = await done;
    expect(torn).toBe(3);
    expect(result.aborted).toBe(true);
    expect(iterations).toBeLessThanOrEqual(6);
  });

  it("a teardown that throws is counted, never rethrown, and does not stop the other teardowns", async () => {
    const clock = fakeClock();
    let torn = 0;
    const done = runThreads({
      threads: 2,
      staggerMs: 0,
      holdMs: 10,
      now: clock.now,
      sleep: clock.sleep,
      setup: async () => "ctx",
      iterate: async () => {
        await clock.sleep(10);
      },
      teardown: async (i) => {
        torn++;
        if (i === 0) throw new Error("detach timed out");
      },
    });
    await clock.drain();
    const result = await done;
    expect(torn).toBe(2);
    expect(result.teardownFailures).toBe(1);
  });
});
