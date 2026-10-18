import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import { textRendering, watchDisplayText } from "./emoji";

describe("Shared text rendering", () => {
  it("renders pipeline backticks as literal inline code through the shared hook", async () => {
    const text = ref("Pipeline `core/api` :shipit: `:shipit:`");
    const page = mount(defineComponent({ render: () => h("a", text.value) }), {
      attachTo: document.body,
      global: { plugins: [textRendering] },
    });
    const stop = watchDisplayText(page.element as HTMLElement, { shipit: { path: "/assets/emoji/ship.png" } });
    expect(page.findAll("code").map((code) => code.text())).toEqual(["core/api", ":shipit:"]);
    expect(page.findAll("img").map((image) => image.attributes("alt"))).toEqual([":shipit:"]);
    text.value = "Pipeline `core/worker` :shipit:";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.get("code").text()).toBe("core/worker");
    expect(page.findAll("img").map((image) => image.attributes("alt"))).toEqual([":shipit:"]);
    stop();
    page.unmount();
  });
  afterEach(() => document.body.replaceChildren());

  it("renders the catalog in labels and prose, preserves code and inputs, and follows live text changes", async () => {
    const text = ref("First :ship:");
    const page = mount(
      defineComponent({
        render: () =>
          h("main", [
            h("h1", text.value),
            h("p", ["Ready ", text.value, h("strong", "now")]),
            h("code", ":ship:"),
            h("textarea", ":ship:"),
            h("p", ":unknown: :unsafe:"),
            h("p", ":thumbsup: :rocket: :white_square: :bird's-gift:"),
          ]),
      }),
      { attachTo: document.body, global: { plugins: [textRendering] } },
    );
    const stop = watchDisplayText(page.element as HTMLElement, {
      ship: { path: "/assets/emoji/abc.gif" },
      unsafe: { path: "https://example.test/tracker.png" },
      white_square: { text: "⬜" },
      "bird's-gift": { path: "/assets/emoji/bird.jpg" },
    });
    await nextTick();
    expect(page.findAll("img").map((i) => i.attributes("alt"))).toEqual([":ship:", ":ship:", ":bird's-gift:"]);
    expect(page.get("code").text()).toBe(":ship:");
    expect(page.get("textarea").element.value).toBe(":ship:");
    expect(page.text()).toContain(":unknown: :unsafe:");
    expect(page.text()).toContain("👍 🚀 ⬜");
    text.value = "Second :ship:";
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.get("h1").text()).toBe("Second");
    expect(page.get("p").text()).toBe("Ready Second now");
    expect(page.findAll("img").map((i) => i.attributes("alt"))).toEqual([":ship:", ":ship:", ":bird's-gift:"]);
    stop();
    page.unmount();
  });
});
