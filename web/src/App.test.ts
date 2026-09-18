// Feature: docs/reference/specs/live-view.md item 31 — the app mounts one page
// per address from the seed loaded for it: a new address is a fresh mount with
// its own seed, a hash move is not, and the progress cue shows while a seed loads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, inject } from "vue";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import type { WebSeed } from "@core/channels/webSeed.js";
import App from "./App.vue";
import { SeedKey } from "./lib/seed";
import { installSeedRouting, SeedRoutingKey } from "./lib/seedRouting";
import { browser } from "./lib/browser";
import { ALL_ON } from "./testing/mount";

const seedFor = (title: string): WebSeed => ({ page: "runNotFound", title, retentionDays: 30, capabilities: ALL_ON });

let mounted = 0;
/** A page that paints the seed it was provided and counts its mounts. */
const Page = defineComponent({
  setup() {
    mounted += 1;
    const seed = inject(SeedKey, null);
    return () => h("p", { "data-testid": "page" }, `${seed?.title ?? "no seed"} · mount ${mounted}`);
  },
});

function mountApp(load: (address: string) => Promise<WebSeed | null>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: Page }],
  });
  const routing = installSeedRouting(router, { island: seedFor("island"), load, leave: vi.fn() });
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [router, ui], provide: { [SeedRoutingKey]: routing } },
  });
  return { wrapper, router };
}

describe("App", () => {
  afterEach(() => {
    mounted = 0;
    vi.restoreAllMocks();
  });

  it("mounts the first page from the island, and a new address from the seed loaded for it — a fresh mount, the title and favicon set from the seed", async () => {
    const setTitle = vi.spyOn(browser, "setTitle").mockImplementation(() => {});
    const setFavicon = vi.spyOn(browser, "setFavicon").mockImplementation(() => {});
    const { wrapper, router } = mountApp(async (address) => seedFor(`seed of ${address}`));
    await router.push("/runs");
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="page"]').text()).toBe("island · mount 1");
    expect(setTitle).toHaveBeenLastCalledWith("island");
    await router.push("/costs?days=7");
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="page"]').text()).toBe("seed of /costs?days=7 · mount 2");
    expect(setTitle).toHaveBeenLastCalledWith("seed of /costs?days=7");
    expect(setFavicon).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("a hash move keeps the mounted page; the progress cue is drawn only while a seed loads", async () => {
    vi.spyOn(browser, "setTitle").mockImplementation(() => {});
    vi.spyOn(browser, "setFavicon").mockImplementation(() => {});
    let release!: (seed: WebSeed) => void;
    const { wrapper, router } = mountApp(() => new Promise<WebSeed>((resolve) => (release = resolve)));
    await router.push("/runs/abc");
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="page"]').text()).toBe("island · mount 1");
    expect(wrapper.find('[data-testid="nav-progress"]').exists()).toBe(false);
    await router.push("/runs/abc#step-2");
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="page"]').text()).toBe("island · mount 1");
    const nav = router.push("/residents");
    await vi.waitFor(() => expect(wrapper.find('[data-testid="nav-progress"]').exists()).toBe(true));
    expect(wrapper.get('[data-testid="page"]').text()).toBe("island · mount 1"); // the current page stays until the seed lands
    release(seedFor("residents"));
    await nav;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="nav-progress"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="page"]').text()).toBe("residents · mount 2");
    wrapper.unmount();
  });
});
