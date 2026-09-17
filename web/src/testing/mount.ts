import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, provide, type Component, type InjectionKey, type Slots, type VNode } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import ui from "@nuxt/ui/vue-plugin";
import UApp from "@nuxt/ui/components/App.vue";
import SettingSelect from "../components/SettingSelect.vue";
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
  readingDiffAbridge: true,
  dashboardAuth: "access",
};

export interface MountAppOptions {
  props?: Record<string, unknown>;
  slots?: Record<string, () => VNode | VNode[] | string>;
  /** A page's seed (stamped with every capability on, as the shell would) or the whole island. */
  seed?: PageSeed | WebSeed | null;
  eventSource?: EventSourceFactory;
  /** Values a page normally provides to the component under test (an injection key and its value each). */
  provides?: ReadonlyArray<readonly [InjectionKey<unknown>, unknown]>;
}

export function mountApp(component: Component, options: MountAppOptions = {}) {
  const { seed = null, props, slots, eventSource, provides = [] } = options;
  const island: WebSeed | null = seed === null ? null : { capabilities: ALL_ON, ...seed };
  const host = defineComponent({
    setup() {
      provide(SeedKey, island);
      if (eventSource) provide(EventSourceKey, eventSource);
      for (const [key, value] of provides) provide(key, value);
      return () => h(UApp, null, { default: () => h(component, props, slots as unknown as Slots) });
    },
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: defineComponent({ render: () => h("div") }) }],
  });
  return mount(host, { attachTo: document.body, global: { plugins: [router, ui] } });
}

/** The styled select that carries this id (`#mcp-scope`): a `SettingSelect`, found by its `id`
 *  prop — the DOM element with the id is the menu's trigger button, which no `setValue` drives. */
function settingSelect(wrapper: VueWrapper<unknown>, selector: string): VueWrapper<InstanceType<typeof SettingSelect>> {
  const id = selector.replace(/^#/, "");
  const found = wrapper.findAllComponents(SettingSelect).find((c) => c.props("id") === id);
  if (!found) throw new Error(`no SettingSelect with id ${id}`);
  return found;
}

/** Pick a value on a styled select: `setValue` on the component emits its `update:modelValue`. */
export async function pickSelect(wrapper: VueWrapper<unknown>, selector: string, value: string): Promise<void> {
  await settingSelect(wrapper, selector).setValue(value);
}

/** The value a styled select holds: its `modelValue` prop, never a DOM `.value`. */
export function selectValue(wrapper: VueWrapper<unknown>, selector: string): string {
  return String(settingSelect(wrapper, selector).props("modelValue"));
}

/** The labels a styled select offers, in order — what a person reads on the menu. */
export function selectLabels(wrapper: VueWrapper<unknown>, selector: string): string[] {
  return (settingSelect(wrapper, selector).props("items") as readonly { label: string }[]).map((i) => i.label);
}

/** One item a styled select offers, by value: its label and whether it is disabled. */
export function selectItem(
  wrapper: VueWrapper<unknown>,
  selector: string,
  value: string,
): { label: string; value: string; disabled?: boolean } {
  const items = settingSelect(wrapper, selector).props("items") as readonly {
    label: string;
    value: string;
    disabled?: boolean;
  }[];
  const item = items.find((i) => i.value === value);
  if (!item) throw new Error(`no item ${value} on ${selector}`);
  return item;
}

/** Whether a styled select is disabled: its `disabled` prop, the one the trigger button carries. */
export function selectDisabled(wrapper: VueWrapper<unknown>, selector: string): boolean {
  return settingSelect(wrapper, selector).props("disabled") === true;
}
