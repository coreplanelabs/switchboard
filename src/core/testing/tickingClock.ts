import { AsyncLocalStorage } from "node:async_hooks";
import type { Clock, Span, SpanContext } from "../trace/types.js";

/** A virtual clock for tests: reads return the current value, `tick` advances
 *  it, and nothing ever waits on real time. */
export interface TickingClock {
  now: Clock;
  tick(ms: number): void;
  set(at: number): void;
}

export function createTickingClock(start = 1_700_000_000_000): TickingClock {
  let at = start;
  return {
    now: () => at,
    tick: (ms) => {
      at += ms;
    },
    set: (v) => {
      at = v;
    },
  };
}

/** The test `SpanContext`: an `AsyncLocalStorage` that only `span(fn)` enters,
 *  so an awaited fake can ask which span it ran under — `undefined` for a bare
 *  await under the root, which is exactly the gap the no-gaps test looks for. */
export interface AlsContext {
  context: SpanContext;
  current(): Span | undefined;
}

export function createAlsContext(): AlsContext {
  const als = new AsyncLocalStorage<Span>();
  return {
    context: { run: (span, fn) => als.run(span, fn) },
    current: () => als.getStore(),
  };
}

export interface Tick {
  dep: string;
  /** The innermost `span(fn)` the fake ran under, by name; `null` is the gap. */
  span: string | null;
  spanId: string | null;
  at: number;
}

/** Wrap an awaited fake so each call advances the clock by `stepMs` after it
 *  resolves and records which span (if any) it ran under. */
export function timedFakes(clock: TickingClock, ctx: AlsContext, stepMs = 1000) {
  const ticks: Tick[] = [];
  return {
    ticks,
    timed<A extends unknown[], R>(dep: string, fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R> {
      return async (...args: A) => {
        const result = await fn(...args);
        const current = ctx.current();
        ticks.push({ dep, span: current?.name ?? null, spanId: current?.id ?? null, at: clock.now() });
        clock.tick(stepMs);
        return result;
      };
    },
  };
}
