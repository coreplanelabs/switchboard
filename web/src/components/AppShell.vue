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
import AppNav from "./AppNav.vue";
import { navSections, type NavSection } from "../lib/navSections";
import DocsLink, { DOCS_HREF, DOCS_ICON, DOCS_LABEL } from "./DocsLink.vue";
import SettingsLink, { SETTINGS_HREF, SETTINGS_ICON, SETTINGS_LABEL } from "./SettingsLink.vue";
import ThemeToggle from "./ThemeToggle.vue";
import BrandMark from "./BrandMark.vue";
import ViewAsBanner from "./ViewAsBanner.vue";
import { browser } from "../lib/browser";
import { useViewingAs } from "../lib/seed";
import { useCapabilities } from "../lib/capabilities";

const props = defineProps<{ title: string; nav: NavSection }>();

const caps = useCapabilities();
const sections = computed(() => navSections(caps, props.nav));
// Viewing as a person (record 0053): the banner sits under the header on every
// page, so the narrowed view is never mistaken for the session's own.
const viewingAs = useViewingAs();

const mode = useColorMode({ emitAuto: true });
const THEMES = [
  { label: "Light", value: "light", icon: "i-lucide-sun" },
  { label: "Dark", value: "dark", icon: "i-lucide-moon" },
  { label: "System", value: "auto", icon: "i-lucide-monitor" },
] as const;

const menuItems = computed(() => [
  // The docs and the settings cog sit in their own group: chrome, not sections
  // of this app — the docs the only item here that leaves the app, settings
  // navigated in place like the sections.
  [
    { label: DOCS_LABEL, icon: DOCS_ICON, to: DOCS_HREF, target: "_blank" as const },
    {
      label: SETTINGS_LABEL,
      icon: SETTINGS_ICON,
      type: "checkbox" as const,
      checked: props.nav === "settings",
      onSelect: () => browser.navigate(SETTINGS_HREF),
    },
  ],
  sections.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    type: "checkbox" as const,
    checked: s.id === props.nav,
    // In place, like the desktop nav — the router loads each section's seed.
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
  <div class="mx-auto max-w-[80rem] px-3 pb-16 sm:px-5">
    <!-- The header stays put: the canvas at 75% over a blur, so the page scrolls
         under it and the run's Stop/Kill and the site nav are always at hand. -->
    <header
      class="sticky top-0 z-20 -mx-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-default bg-default/75 px-3 pb-3 pt-4 backdrop-blur sm:-mx-5 sm:px-5"
    >
      <slot name="leading" />
      <!-- The constant part of every header (docs/reference/specs/web-chat.md item 1):
           the mark and the name as one link to the threads page, then the page's
           own title beside them, subordinate — the product is always named, the
           page is what changes. -->
      <h1 class="flex min-w-0 items-center gap-2 text-base tracking-tight">
        <RouterLink
          class="home brand flex shrink-0 items-center gap-2 font-medium text-highlighted no-underline"
          to="/threads"
          aria-label="Switchboard home"
        >
          <BrandMark /><span class="wordmark">Switchboard</span>
        </RouterLink>
        <span class="sep select-none text-dimmed" aria-hidden="true">/</span>
        <span class="title min-w-0 truncate font-normal text-toned">{{ title }}</span>
      </h1>
      <slot name="status" />
      <span class="ml-auto flex items-center gap-4">
        <slot name="actions" />
        <span class="hidden items-center gap-4 sm:flex">
          <AppNav :current="nav" />
          <SettingsLink :current="nav === 'settings'" />
          <DocsLink />
          <ThemeToggle />
        </span>
        <UDropdownMenu :items="menuItems" :content="{ align: 'end' }" class="sm:hidden">
          <UButton class="-my-1" size="md" color="neutral" variant="ghost" icon="i-lucide-menu" aria-label="Menu" />
        </UDropdownMenu>
      </span>
    </header>
    <ViewAsBanner v-if="viewingAs" :person="viewingAs" />
    <slot />
  </div>
</template>
