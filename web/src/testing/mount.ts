import { mount } from "@vue/test-utils";
import { defineComponent, h, provide, type Component, type Slots, type VNode } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import UApp from "@nuxt/ui/components/App.vue";
import type { WebSeed } from "@core/channels/webSeed.js";
import { SeedKey } from "../lib/seed";
import { EventSourceKey, type EventSourceFactory } from "../lib/eventSource";

// The one mount helper for component tests: everything is hosted inside
// <UApp> (tooltip/toast/overlay providers), with the Nuxt UI plugin, a memory
// router (ULink needs one), and the page seed provided the way App.vue does.

export interface MountAppOptions {
  props?: Record<string, unknown>;
  slots?: Record<string, () => VNode | VNode[] | string>;
  seed?: WebSeed | null;
  eventSource?: EventSourceFactory;
}

export function mountApp(component: Component, options: MountAppOptions = {}) {
  const { seed = null, props, slots, eventSource } = options;
  const host = defineComponent({
    setup() {
      provide(SeedKey, seed);
      if (eventSource) provide(EventSourceKey, eventSource);
      return () => h(UApp, null, { default: () => h(component, props, slots as unknown as Slots) });
    },
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: defineComponent({ render: () => h("div") }) }],
  });
  return mount(host, { attachTo: document.body, global: { plugins: [router, ui] } });
}
