// Feature: docs/reference/specs/tracing.md item 8 — the web app's one clock: a reading, and
// a ref that ticks while mounted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useWallClock, wallNow } from "./wallClock";

afterEach(() => {
  vi.useRealTimers();
});

describe("wallClock", () => {
  it("wallNow reads the browser clock; useWallClock starts at the given value (else the clock), ticks every second while mounted, and stops on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(wallNow()).toBe(1_000_000);
    let seen: number[] = [];
    const ticker = (initial?: number) =>
      defineComponent({
        setup() {
          const now = useWallClock(initial);
          return () => {
            seen.push(now.value);
            return h("div", String(now.value));
          };
        },
      });
    const w = mount(ticker(5));
    expect(w.text()).toBe("5"); // the seed's clock first
    vi.advanceTimersByTime(1_000);
    await nextTick();
    expect(w.text()).toBe("1001000");
    vi.advanceTimersByTime(2_000);
    await nextTick();
    expect(w.text()).toBe("1003000");
    w.unmount();
    seen = [];
    vi.advanceTimersByTime(5_000);
    await nextTick();
    expect(seen).toEqual([]); // nothing renders after unmount: the interval is gone
    const own = mount(defineComponent({ setup: () => () => h("div", String(useWallClock().value)) }));
    expect(own.text()).toBe("1008000"); // no seed: the clock itself
    own.unmount();
  });
});
