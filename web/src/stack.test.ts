import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import UApp from "@nuxt/ui/components/App.vue";
import UButton from "@nuxt/ui/components/Button.vue";
import USlideover from "@nuxt/ui/components/Slideover.vue";

/*
 * Stack smoke test: proves the standalone-Vue @nuxt/ui path works under
 * vitest + happy-dom — buttons render with the theme's classes, and the
 * Slideover (the component motivating the port) opens with teleported
 * content. If this file fails after a dependency bump, the whole suite's
 * failures start here.
 */

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { template: "<div />" } }],
  });
}

function mountWithUi(component: ReturnType<typeof defineComponent>) {
  return mount(component, {
    global: { plugins: [testRouter(), ui] },
    attachTo: document.body,
  });
}

describe("frontend stack", () => {
  it("renders a themed UButton", () => {
    const wrapper = mountWithUi(
      defineComponent({
        render: () => h(UApp, () => h(UButton, { label: "Stop run" })),
      }),
    );
    const button = wrapper.find("button");
    expect(button.exists()).toBe(true);
    expect(button.text()).toBe("Stop run");
    expect(button.attributes("class")).toBeTruthy();
  });

  it("opens a USlideover with teleported content", async () => {
    const wrapper = mountWithUi(
      defineComponent({
        render: () =>
          h(UApp, () =>
            h(
              USlideover,
              { open: true, title: "Run details" },
              { body: () => h("p", "slideout body") },
            ),
          ),
      }),
    );
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    expect(document.body.textContent).toContain("slideout body");
  });
});
