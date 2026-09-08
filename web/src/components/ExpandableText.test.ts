// Feature: docs/reference/specs/live-view.md item 12 — the Request folds to its first
// lines behind a fade and a Show more; a short request is just text.
import { afterEach, describe, expect, it } from "vitest";
import { h } from "vue";
import ExpandableText from "./ExpandableText.vue";
import { mountApp } from "../testing/mount";

/** happy-dom lays nothing out: the measured heights are stubbed per test. */
function layout(scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight });
}

afterEach(() => {
  // Back to happy-dom's own (zero) layout.
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

const prose = () => h("p", ["a long request ", h("a", { href: "https://example.com/x" }, "with a link")]);

describe("ExpandableText", () => {
  it("overflowing content is clamped to the given lines under a fade with Show more; the button is labelled for assistive tech", async () => {
    layout(500, 100);
    const w = mountApp(ExpandableText, { props: { lines: 3 }, slots: { default: prose } });
    await w.vm.$nextTick();
    const root = w.find(".expandable");
    expect(root.attributes("data-overflowing")).toBe("1");
    expect(root.attributes("data-expanded")).toBe("0");
    expect(w.find(".body").classes()).toContain("clamped");
    expect(w.find(".body").attributes("style")).toContain("--expandable-lines: 3");
    expect(w.find(".fade").exists()).toBe(true);
    const more = w.find("button.more");
    expect(more.text()).toBe("Show more");
    expect(more.attributes("aria-expanded")).toBe("false");
    expect(more.attributes("aria-controls")).toBe(w.find(".body").attributes("id"));
    expect(w.text()).toContain("a long request");
  });

  it("Show more opens everything and becomes Show less; Show less folds it back", async () => {
    layout(500, 100);
    const w = mountApp(ExpandableText, { slots: { default: prose } });
    await w.vm.$nextTick();
    await w.find("button.more").trigger("click");
    expect(w.find(".expandable").attributes("data-expanded")).toBe("1");
    expect(w.find(".body").classes()).not.toContain("clamped");
    expect(w.find(".fade").exists()).toBe(false);
    expect(w.find("button.more").text()).toBe("Show less");
    expect(w.find("button.more").attributes("aria-expanded")).toBe("true");
    await w.find("button.more").trigger("click");
    expect(w.find(".expandable").attributes("data-expanded")).toBe("0");
    expect(w.find(".body").classes()).toContain("clamped");
    expect(w.find(".body").attributes("style")).toContain("--expandable-lines: 5"); // the default
  });

  it("the whole collapsed block is the hit target — except a link in the prose, which stays the reader's", async () => {
    layout(500, 100);
    const w = mountApp(ExpandableText, { slots: { default: prose } });
    await w.vm.$nextTick();
    expect(w.find(".expandable").classes()).toContain("cursor-pointer");
    await w.find(".expandable a").trigger("click");
    expect(w.find(".expandable").attributes("data-expanded")).toBe("0"); // a link click is not a fold toggle
    await w.find(".body p").trigger("click");
    expect(w.find(".expandable").attributes("data-expanded")).toBe("1");
    expect(w.find(".expandable").classes()).not.toContain("cursor-pointer"); // open: plain prose again
  });

  it("content that fits shows no fade and no button — a short text is just text", async () => {
    layout(80, 100);
    const w = mountApp(ExpandableText, { slots: { default: prose } });
    await w.vm.$nextTick();
    expect(w.find(".expandable").attributes("data-overflowing")).toBe("0");
    expect(w.find(".fade").exists()).toBe(false);
    expect(w.find("button.more").exists()).toBe(false);
    expect(w.find(".expandable").classes()).not.toContain("cursor-pointer");
    await w.find(".body p").trigger("click");
    expect(w.find(".expandable").attributes("data-expanded")).toBe("0");
  });
});
