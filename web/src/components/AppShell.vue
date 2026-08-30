<script setup lang="ts">
// The one page chrome every section shares: header (leading slot · title ·
// status slot · actions · site nav · theme) over the page body. This is the
// normalization the port buys — the four hand-rolled shells collapse into
// this component. Below sm the nav and theme fold into one finger-sized
// hamburger menu; page actions (the status slot's controls) stay visible.
import { computed } from "vue";
import { useColorMode } from "@vueuse/core";
import AppNav, { NAV_SECTIONS, type NavSection } from "./AppNav.vue";
import ThemeToggle from "./ThemeToggle.vue";
import { browser } from "../lib/browser";

const props = defineProps<{ title: string; nav: NavSection }>();

const mode = useColorMode({ emitAuto: true });
const THEMES = [
  { label: "Light", value: "light", icon: "i-lucide-sun" },
  { label: "Dark", value: "dark", icon: "i-lucide-moon" },
  { label: "System", value: "auto", icon: "i-lucide-monitor" },
] as const;

const menuItems = computed(() => [
  NAV_SECTIONS.map((s) => ({
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
