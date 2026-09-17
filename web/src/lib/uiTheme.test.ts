import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { RunIndexRowSeed } from "@core/channels/webSeed.js";
import RunRow from "../components/runs/RunRow.vue";
import ViewAsPicker from "../components/runs/ViewAsPicker.vue";
import { mountApp } from "../testing/mount";
import { POPUP_COMPONENTS, POPUP_LAYER, popupLayers } from "./uiTheme";

// Feature: docs/reference/specs/live-view.md item 20 — every popup paints
// above the page: the theme raises each floating `content` slot to one layer,
// and a run row keeps its own layering to itself.

enableAutoUnmount(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("popupLayers — the one z-index for every floating layer", () => {
  it("names every Nuxt UI component that floats content, each raised to the layer above the shell header", () => {
    const layers = popupLayers();
    expect(Object.keys(layers).sort()).toEqual([...POPUP_COMPONENTS].sort());
    for (const c of POPUP_COMPONENTS) expect(layers[c]).toEqual({ slots: { content: POPUP_LAYER } });
    // Above the shell's sticky header (z-20), not above the slideover (z-30 overlay + content).
    expect(POPUP_LAYER).toBe("z-30");
  });
});

const live: RunIndexRowSeed = {
  id: "run-1",
  label: 'review · acme/api · "please review #7"',
  channelId: "slack:C1",
  threadKey: "slack:C1:1.0",
  startedAt: 1_000,
  finished: false,
  eventCount: 3,
  token: "tok-1",
};

describe("the layers in the DOM", () => {
  it("a run row isolates its own layering, so its body's z-index never reaches the page", () => {
    const w = mountApp(RunRow, { props: { run: live, now: 2_000 } });
    expect(w.find("li.run").classes()).toContain("isolate");
    expect(w.find("li.run .body").classes()).toContain("z-[1]");
  });

  it("an opened row menu and an opened view-as list both carry the popup layer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const row = mountApp(RunRow, { props: { run: live, now: 2_000 } });
    const trigger = row.find("[aria-haspopup=menu]");
    expect(trigger.exists()).toBe(true);
    await trigger.trigger("keydown", { key: "Enter" });
    await nextTick();
    await vi.waitFor(() => expect(document.body.querySelector("[role=menu]")).not.toBeNull());
    expect(document.body.querySelector("[role=menu]")!.className.split(/\s+/)).toContain(POPUP_LAYER);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const picker = mountApp(ViewAsPicker, { props: { people: [{ id: "slack:UBOB", name: "bob" }] } });
    const input = picker.find("input");
    await input.trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    await vi.waitFor(() => expect(document.body.querySelector("[role=listbox]")).not.toBeNull());
    const list = document.body.querySelector("[role=listbox]")!;
    const content =
      list.closest(`.${POPUP_LAYER}`) ?? (list.className.split(/\s+/).includes(POPUP_LAYER) ? list : null);
    expect(content).not.toBeNull();
  });
});
