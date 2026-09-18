<script setup lang="ts">
// The tabs of the /settings page: RouterLinks (the router loads each tab's
// seed), aria-current the styling hook and the accessible signal (the RunsTabs
// shape). Which tabs exist is
// `settingsTabs` in web/src/lib/settingsTabs.ts.
import { computed } from "vue";
import type { SettingsTab } from "@core/channels/webSeed.js";
import { useCapabilities } from "../../lib/capabilities";
import { settingsTabs } from "../../lib/settingsTabs";

const props = defineProps<{ current: SettingsTab }>();
const caps = useCapabilities();
const tabs = computed(() => settingsTabs(caps, props.current));
</script>

<template>
  <nav class="tabs mb-3.5 flex gap-5 border-b border-muted px-2 text-[0.8rem]" aria-label="Settings sections">
    <RouterLink
      v-for="t in tabs"
      :key="t.id"
      :to="t.href"
      :aria-current="t.id === current ? 'page' : undefined"
      class="-mb-px border-b border-transparent pb-2 pt-1.5 text-muted no-underline hover:text-highlighted aria-[current=page]:border-(--ui-text-highlighted) aria-[current=page]:font-medium aria-[current=page]:text-highlighted"
    >
      {{ t.label }}
    </RouterLink>
  </nav>
</template>
