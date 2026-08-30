<script setup lang="ts">
import { computed } from "vue";
import { useColorMode } from "@vueuse/core";

// The light/dark/system switch, in every page's header. VueUse's color mode
// (the same manager the Nuxt UI plugin uses) stamps the `dark` class on <html>
// and persists the preference; "system" follows the OS. The server shell
// starts dark (the product default) and this corrects it on mount.

const mode = useColorMode({ emitAuto: true });

const ICONS: Record<string, string> = {
  light: "i-lucide-sun",
  dark: "i-lucide-moon",
  auto: "i-lucide-monitor",
};

const items = computed(() =>
  (
    [
      { label: "Light", value: "light" },
      { label: "Dark", value: "dark" },
      { label: "System", value: "auto" },
    ] as const
  ).map((item) => ({
    label: item.label,
    icon: ICONS[item.value],
    type: "checkbox" as const,
    checked: mode.value === item.value,
    onSelect() {
      mode.value = item.value;
    },
  })),
);
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }">
    <UButton
      class="theme-toggle"
      color="neutral"
      variant="ghost"
      size="xs"
      :icon="ICONS[mode] ?? ICONS.auto"
      aria-label="Theme"
    />
  </UDropdownMenu>
</template>
