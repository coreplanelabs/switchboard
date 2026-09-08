import { mount } from "@vue/test-utils";
import { defineComponent, h, provide, type Component, type Slots, type VNode } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import UApp from "@nuxt/ui/components/App.vue";
import type { PageSeed, WebSeed } from "@core/channels/webSeed.js";
import type { Capabilities } from "@core/core/capabilities.js";
import { SeedKey } from "../lib/seed";
import { EventSourceKey, type EventSourceFactory } from "../lib/eventSource";

// The one mount helper for component tests: everything is hosted inside
// <UApp> (tooltip/toast/overlay providers), with the Nuxt UI plugin, a memory
// router (ULink needs one), and the page seed provided the way App.vue does.

/** Every capability on — what the shell stamps on a page seed when a test
 *  hands one in without its own (a literal here, never an import: the web
 *  bundle takes types only from the core). */
export const ALL_ON: Capabilities = {
  execution: "cloudflare",
  residents: true,
  memory: true,
  runHistory: true,
  runLedger: true,
  mcp: true,
  costs: true,
  schedules: true,
  github: true,
  ingress: true,
  dashboardAuth: "access",
  docs: true,
};

export interface MountAppOptions {
  props?: Record<string, unknown>;
  slots?: Record<string, () => VNode | VNode[] | string>;
  /** A page's seed (stamped with every capability on, as the shell would) or the whole island. */
  seed?: PageSeed | WebSeed | null;
  eventSource?: EventSourceFactory;
}

export function mountApp(component: Component, options: MountAppOptions = {}) {
  const { seed = null, props, slots, eventSource } = options;
  const island: WebSeed | null = seed === null ? null : { capabilities: ALL_ON, ...seed };
  const host = defineComponent({
    setup() {
      provide(SeedKey, island);
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
