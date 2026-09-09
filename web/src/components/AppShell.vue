<script setup lang="ts">
// The one page chrome every section shares: header (leading slot · title ·
// status slot · actions · site nav · docs · theme) over the page body. This is
// the normalization the port buys — the four hand-rolled shells collapse into
// this component. Below sm the nav, docs, and theme fold into one finger-sized
// hamburger menu; page actions (the status slot's controls) stay visible.
// What the nav and the menu list follows the installation's capabilities (the
// seed): a section that is off has no entry. The docs link needs no capability:
// it opens the project's published site, the same on every installation.
import { computed } from "vue";
import { useColorMode } from "@vueuse/core";
import AppNav, { navSections, type NavSection } from "./AppNav.vue";
import DocsLink, { DOCS_HREF, DOCS_ICON, DOCS_LABEL } from "./DocsLink.vue";
import ThemeToggle from "./ThemeToggle.vue";
import { browser } from "../lib/browser";
import { useCapabilities } from "../lib/capabilities";

const props = defineProps<{ title: string; nav: NavSection }>();

const caps = useCapabilities();
const sections = computed(() => navSections(caps, props.nav));

const mode = useColorMode({ emitAuto: true });
const THEMES = [
  { label: "Light", value: "light", icon: "i-lucide-sun" },
  { label: "Dark", value: "dark", icon: "i-lucide-moon" },
  { label: "System", value: "auto", icon: "i-lucide-monitor" },
] as const;

const menuItems = computed(() => [
  // The docs sit in their own group: an external destination, not a section of
  // this app, and the only item here that leaves the page.
  [{ label: DOCS_LABEL, icon: DOCS_ICON, to: DOCS_HREF, target: "_blank" as const }],
  sections.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    type: "checkbox" as const,
    checked: s.id === props.nav,
    // A full page load, like the desktop nav — the server seeds each section.
    onSelect: () => browser.navigate(s.href),
  })),
  THEMES.map((t) => ({
    label: t.label,
    icon: t.icon,
    type: "checkbox" as const,
    checked: mode.value === t.value,
    onSelect: () => {
      mode.value = t.value;
    },
  })),
]);
</script>

<template>
  <div class="mx-auto max-w-[80rem] px-3 pb-16 pt-4 sm:px-5">
    <header class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-default pb-3">
      <slot name="leading" />
      <h1 class="text-base font-semibold text-highlighted">{{ title }}</h1>
      <slot name="status" />
      <span class="ml-auto flex items-center gap-4">
        <slot name="actions" />
        <span class="hidden items-center gap-4 sm:flex">
          <AppNav :current="nav" />
          <DocsLink />
          <ThemeToggle />
        </span>
        <UDropdownMenu :items="menuItems" :content="{ align: 'end' }" class="sm:hidden">
          <UButton class="-my-1" size="md" color="neutral" variant="ghost" icon="i-lucide-menu" aria-label="Menu" />
        </UDropdownMenu>
      </span>
    </header>
    <slot />
  </div>
</template>
