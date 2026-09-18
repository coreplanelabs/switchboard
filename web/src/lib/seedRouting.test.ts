// Feature: docs/reference/specs/live-view.md item 31 — navigation in place: the
// island seeds the first page, every later address is asked for its seed before
// its page mounts, and an address that is not a page is a full navigation.
import { describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { WebSeed } from "@core/channels/webSeed.js";
import { installSeedRouting, pageAddress } from "./seedRouting";
import { ALL_ON } from "../testing/mount";

const seedFor = (title: string): WebSeed => ({ page: "runNotFound", title, retentionDays: 30, capabilities: ALL_ON });
const ISLAND = seedFor("island");

function router(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: defineComponent({ render: () => h("div") }) }],
  });
}

/** A load whose answers the test releases by hand, to order two navigations. */
function manualLoad() {
  const pending = new Map<string, (seed: WebSeed | null) => void>();
  const load = vi.fn((address: string) => new Promise<WebSeed | null>((resolve) => pending.set(address, resolve)));
  return { load, release: (address: string, seed: WebSeed | null) => pending.get(address)!(seed) };
}

describe("pageAddress", () => {
  it("is the path and the query, never the hash", async () => {
    const r = router();
    await r.push("/runs/abc?t=1#step-3");
    expect(pageAddress(r.currentRoute.value)).toBe("/runs/abc?t=1");
    await r.push("/costs");
    expect(pageAddress(r.currentRoute.value)).toBe("/costs");
  });
});

describe("installSeedRouting", () => {
  it("the first navigation is the document's own: its seed is the island, nothing is loaded", async () => {
    const r = router();
    const load = vi.fn();
    const routing = installSeedRouting(r, { island: ISLAND, load, leave: vi.fn() });
    await r.push("/runs?all=1");
    expect(load).not.toHaveBeenCalled();
    expect(routing.seedAt("/runs?all=1")).toBe(ISLAND);
    expect(routing.seedAt("/runs")).toBeNull();
    expect(routing.loading.value).toBe(false);
  });

  it("a later navigation loads the address's seed before the route resolves; the loading flag is up meanwhile; the old address's seed is gone", async () => {
    const r = router();
    const { load, release } = manualLoad();
    const leave = vi.fn();
    const routing = installSeedRouting(r, { island: ISLAND, load, leave });
    await r.push("/runs");
    const nav = r.push("/costs?days=7");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("/costs?days=7"));
    expect(routing.loading.value).toBe(true);
    expect(r.currentRoute.value.fullPath).toBe("/runs"); // not yet: the seed is on its way
    release("/costs?days=7", seedFor("costs"));
    await nav;
    expect(r.currentRoute.value.fullPath).toBe("/costs?days=7");
    expect(routing.seedAt("/costs?days=7")?.title).toBe("costs");
    expect(routing.seedAt("/runs")).toBeNull();
    expect(routing.loading.value).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it("a hash move stays on the page: nothing is loaded, the seed stays", async () => {
    const r = router();
    const load = vi.fn(async () => seedFor("run"));
    const routing = installSeedRouting(r, { island: ISLAND, load, leave: vi.fn() });
    await r.push("/runs/abc");
    await r.push("/runs/abc#step-3");
    expect(load).not.toHaveBeenCalled();
    expect(routing.seedAt("/runs/abc")).toBe(ISLAND);
    expect(r.currentRoute.value.hash).toBe("#step-3");
  });

  it("an address that answers no seed is the browser's: a full navigation to it, the in-app one cancelled, the page kept", async () => {
    const r = router();
    const load = vi.fn(async () => null);
    const leave = vi.fn();
    const routing = installSeedRouting(r, { island: ISLAND, load, leave });
    await r.push("/runs");
    await r.push("/runs/abc/events#x").catch(() => undefined);
    expect(leave).toHaveBeenCalledWith("/runs/abc/events#x");
    expect(r.currentRoute.value.fullPath).toBe("/runs");
    expect(routing.seedAt("/runs")).toBe(ISLAND);
    expect(routing.loading.value).toBe(false);
  });

  it("a load that throws is the same full navigation", async () => {
    const r = router();
    const leave = vi.fn();
    installSeedRouting(r, {
      island: ISLAND,
      load: async () => {
        throw new Error("network");
      },
      leave,
    });
    await r.push("/runs");
    await r.push("/costs").catch(() => undefined);
    expect(leave).toHaveBeenCalledWith("/costs");
    expect(r.currentRoute.value.fullPath).toBe("/runs");
  });

  it("a navigation superseded while its seed loads never lands: the newer address's seed is the one kept, even when the older answer arrives last", async () => {
    const r = router();
    const { load, release } = manualLoad();
    const leave = vi.fn();
    const routing = installSeedRouting(r, { island: ISLAND, load, leave });
    await r.push("/runs");
    const first = r.push("/costs");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("/costs"));
    const second = r.push("/delivery");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("/delivery"));
    release("/delivery", seedFor("delivery"));
    await second;
    release("/costs", seedFor("costs"));
    await first.catch(() => undefined);
    expect(r.currentRoute.value.fullPath).toBe("/delivery");
    expect(routing.seedAt("/delivery")?.title).toBe("delivery");
    expect(routing.seedAt("/costs")).toBeNull();
    expect(routing.loading.value).toBe(false);
    expect(leave).not.toHaveBeenCalled();
  });

  it("a hash move supersedes a pending load too: its late answer neither lands nor leaves, whatever it is", async () => {
    for (const late of [null, seedFor("costs")]) {
      const r = router();
      const { load, release } = manualLoad();
      const leave = vi.fn();
      const routing = installSeedRouting(r, { island: ISLAND, load, leave });
      await r.push("/runs");
      const stale = r.push("/costs");
      await vi.waitFor(() => expect(load).toHaveBeenCalledWith("/costs"));
      await r.push("/runs#step-3");
      expect(routing.loading.value).toBe(false); // the page is not navigating any more
      release("/costs", late);
      await stale.catch(() => undefined);
      expect(r.currentRoute.value.fullPath).toBe("/runs#step-3");
      expect(routing.seedAt("/runs")).toBe(ISLAND);
      expect(routing.seedAt("/costs")).toBeNull();
      expect(routing.loading.value).toBe(false);
      expect(leave).not.toHaveBeenCalled();
    }
  });
});
