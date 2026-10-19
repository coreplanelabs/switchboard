import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import { mountApp } from "../../testing/mount";
import RunScrollControls from "./RunScrollControls.vue";

enableAutoUnmount(afterEach);

let height: number;
let position: number;
let resize: () => void;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let reducedMotion: boolean;

beforeEach(() => {
  height = 2000;
  position = 0;
  frames = new Map();
  nextFrame = 0;
  reducedMotion = false;
  vi.spyOn(document.body, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => position);
  vi.spyOn(window, "scrollTo").mockImplementation((options) => {
    position = (options as ScrollToOptions).top ?? position;
    window.dispatchEvent(new Event("scroll"));
  });
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: reducedMotion }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        if (target === document.body) resize = this.callback;
      }
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function grow(to: number) {
  height = to;
  resize();
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
  await nextTick();
}

describe("RunScrollControls", () => {
  it("follows new output after a click, pauses while reading earlier output, and resumes on demand", async () => {
    const w = mountApp(RunScrollControls, { props: { live: true } });
    const follow = w.find('[data-testid="follow-output"]');
    expect(follow.text()).toBe("Follow output");
    expect(w.find('[aria-label="Jump to top"]').exists()).toBe(false);
    await follow.trigger("click");
    expect(position).toBe(1400);
    expect(follow.text()).toBe("Following");
    window.dispatchEvent(new Event("pointerdown"));
    await grow(2400);
    expect(position).toBe(1800);
    expect(follow.text()).toBe("Following");

    window.dispatchEvent(new Event("wheel"));
    position = 900;
    window.dispatchEvent(new Event("scroll"));
    await grow(2800);
    expect(position).toBe(900);
    expect(follow.text()).toBe("Follow output");
    await follow.trigger("click");
    expect(position).toBe(2200);
    expect(follow.text()).toBe("Following");
    await w.find('[aria-label="Jump to top"]').trigger("click");
    expect(position).toBe(0);
    expect(follow.text()).toBe("Follow output");
    await grow(3000);
    expect(position).toBe(0);
  });

  it("uses immediate jumps with reduced motion and calls history output Latest output", async () => {
    reducedMotion = true;
    const w = mountApp(RunScrollControls, { props: { live: false } });
    const follow = w.find('[data-testid="follow-output"]');
    expect(follow.text()).toBe("Latest output");
    await follow.trigger("click");
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: "instant" });
    expect(position).toBe(1400);
    expect(follow.text()).toBe("Latest output");
    await w.find('[aria-label="Jump to top"]').trigger("click");
    expect(position).toBe(0);
  });

  it("jumps once on saved output and keeps expanded content stationary", async () => {
    const w = mountApp(RunScrollControls, { props: { live: false } });
    const latest = w.find('[data-testid="follow-output"]');
    await latest.trigger("click");
    expect(position).toBe(1400);
    await grow(2400);
    expect(position).toBe(1400);
    expect(latest.text()).toBe("Latest output");
    expect(latest.attributes("data-following")).toBe("false");

    position = 1800;
    window.dispatchEvent(new Event("scroll"));
    await grow(2800);
    expect(position).toBe(1800);

    w.unmount();
    position = 2200;
    const reopened = mountApp(RunScrollControls, { props: { live: false } });
    await grow(3000);
    expect(position).toBe(2200);
    expect(reopened.find('[data-testid="follow-output"]').text()).toBe("Latest output");
  });

  it("stops following when a live run finishes and can follow again after reconnection", async () => {
    position = 1400;
    const mode = reactive({ live: true });
    const w = mountApp(RunScrollControls, { props: mode });
    const output = w.find('[data-testid="follow-output"]');
    await nextTick();
    expect(output.text()).toBe("Following");
    height = 2400;
    resize();
    mode.live = false;
    await nextTick();
    await grow(2800);
    expect(position).toBe(1400);
    expect(output.text()).toBe("Latest output");
    expect(output.attributes("data-following")).toBe("false");

    mode.live = true;
    await nextTick();
    expect(output.text()).toBe("Follow output");
    await output.trigger("click");
    expect(position).toBe(2200);
    await grow(3000);
    expect(position).toBe(2400);
    expect(output.text()).toBe("Following");
  });

  it("cancels a pending follow when the reader leaves the run", async () => {
    const w = mountApp(RunScrollControls, { props: { live: true } });
    await w.find('[data-testid="follow-output"]').trigger("click");
    expect(position).toBe(1400);
    height = 2400;
    resize();
    w.unmount();
    const pending = [...frames.values()];
    for (const callback of pending) callback(0);
    expect(position).toBe(1400);
    expect(frames.size).toBe(0);
  });
});
