<script setup lang="ts">
defineOptions({ name: "GreenShell" });
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useColorMode, useMediaQuery } from "@vueuse/core";
import { SeedKey } from "../../src/lib/seed";
import { primaryNavigation, pageTitle } from "../lib/navigation";

const route = useRoute();
const seed = inject(SeedKey, null);
const navigation = computed(() => primaryNavigation(seed?.capabilities));
const menuOpen = ref(false);
const wide = useMediaQuery("(min-width: 768px)");
const sidebar = ref<HTMLElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);
let previousOverflow = "";
function onKeydown(event: KeyboardEvent) {
  if (!menuOpen.value || wide.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    menuOpen.value = false;
    return;
  }
  if (event.key !== "Tab") return;
  const elements = sidebar.value?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),select:not(:disabled)");
  if (!elements?.length) return;
  const first = elements[0],
    last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch(menuOpen, async (open) => {
  if (wide.value) return;
  if (open) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    await nextTick();
    sidebar.value?.querySelector<HTMLElement>("button")?.focus();
  } else {
    document.body.style.overflow = previousOverflow;
    await nextTick();
    menuButton.value?.focus();
  }
});
watch(wide, (value) => {
  if (value && menuOpen.value) {
    menuOpen.value = false;
    document.body.style.overflow = previousOverflow;
  }
});
const mode = useColorMode({ emitAuto: true });
const theme = computed<"system" | "light" | "dark">({
  get: () => (mode.value === "auto" ? "system" : mode.value === "dark" ? "dark" : "light"),
  set: (value) => {
    mode.value = value === "system" ? "auto" : value;
  },
});
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (menuOpen.value) document.body.style.overflow = previousOverflow;
});
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
  },
);
</script>

<template>
  <div class="green-shell">
    <a href="#main-content" class="green-skip">Skip to content</a>
    <aside
      ref="sidebar"
      :inert="!wide && !menuOpen"
      :aria-hidden="!wide && !menuOpen ? true : undefined"
      :role="!wide ? 'dialog' : undefined"
      :aria-modal="!wide && menuOpen ? true : undefined"
      class="green-sidebar"
      :class="{ 'is-open': menuOpen }"
      aria-label="Main navigation"
    >
      <RouterLink to="/home" class="green-brand"
        ><span class="green-brand-mark" aria-hidden="true">S</span> Switchboard</RouterLink
      >
      <button
        class="green-mobile-close green-icon-button"
        type="button"
        aria-label="Close navigation"
        @click="menuOpen = false"
      >
        <UIcon name="i-lucide-x" />
      </button>
      <p class="green-nav-caption">WORKSPACE</p>
      <nav class="green-nav">
        <RouterLink
          v-for="item in navigation"
          :key="item.href"
          :to="item.href"
          :class="{ active: route.path.startsWith(item.href) }"
          :aria-current="route.path.startsWith(item.href) ? 'page' : undefined"
          ><UIcon :name="item.icon" />{{ item.label }}</RouterLink
        >
      </nav>
      <div class="green-sidebar-bottom">
        <nav class="green-nav" aria-label="More">
          <RouterLink to="/runs" :class="{ active: route.path === '/runs' }"
            ><UIcon name="i-lucide-list-tree" />Run details</RouterLink
          >
          <RouterLink to="/runs/scheduled"><UIcon name="i-lucide-calendar-clock" />Scheduled work</RouterLink>
          <RouterLink to="/settings" :class="{ active: route.path.startsWith('/settings') }"
            ><UIcon name="i-lucide-settings-2" />Settings</RouterLink
          >
        </nav>
        <label class="green-theme"
          ><UIcon name="i-lucide-sun-moon" /><span class="sr-only">Appearance</span
          ><select v-model="theme" aria-label="Appearance">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select></label
        >
        <a class="green-help" href="https://switchboard.space" target="_blank" rel="noopener noreferrer"
          >Documentation <UIcon name="i-lucide-arrow-up-right"
        /></a>
      </div>
    </aside>
    <button v-if="menuOpen" class="green-nav-backdrop" aria-label="Close navigation" @click="menuOpen = false" />
    <div class="green-workspace" :inert="menuOpen && !wide">
      <header class="green-topbar">
        <button
          ref="menuButton"
          class="green-menu-button green-icon-button"
          type="button"
          aria-label="Open navigation"
          :aria-expanded="menuOpen"
          @click="menuOpen = true"
        >
          <UIcon name="i-lucide-menu" />
        </button>
        <span class="green-breadcrumb"
          >Workspace <UIcon name="i-lucide-chevron-right" /><strong>{{ pageTitle(route.path) }}</strong></span
        >
        <slot name="status" />
      </header>
      <p v-if="seed?.preview" class="green-notice green-warning" role="status">{{ seed.preview }}</p>
      <p v-if="seed?.viewingAs" class="green-notice" role="status">
        Viewing as {{ seed.viewingAs.name ?? seed.viewingAs.id }}. This view is read-only.
      </p>
      <main id="main-content" class="green-main" tabindex="-1"><slot /></main>
    </div>
  </div>
</template>
