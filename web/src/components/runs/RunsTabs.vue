<script lang="ts">
// The tabs of the /runs page: Runs (live list) · Scheduled. Full page loads;
// underline = current, aria-current is both the styling hook and the
// accessible signal. Scheduled exists only when firing history is configured
// (`capabilities.schedules`, from the seed) or the viewer is on it; a bar with
// one tab is no choice at all, so the bar is not drawn then.
import type { Capabilities } from "@core/core/capabilities.js";

export type RunsTab = "runs" | "scheduled";

export interface RunsTabItem {
  id: RunsTab;
  href: string;
  label: string;
  /** The capability this tab needs; absent → always there (Runs). */
  on?: (caps: Capabilities) => boolean;
}

const TABS: ReadonlyArray<RunsTabItem> = [
  { id: "runs", href: "/runs", label: "Runs" },
  { id: "scheduled", href: "/runs/scheduled", label: "Scheduled", on: (c) => c.schedules },
];

/** The tabs this installation has: Runs, each one whose capability is on, and the current one. */
export function runsTabs(caps: Capabilities | null, current: RunsTab): RunsTabItem[] {
  return TABS.filter((t) => t.id === current || t.on === undefined || (caps !== null && t.on(caps)));
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { useCapabilities } from "../../lib/capabilities";

const props = defineProps<{ current: RunsTab }>();
const caps = useCapabilities();
const tabs = computed(() => runsTabs(caps, props.current));
</script>

<template>
  <nav
    v-if="tabs.length > 1"
    class="tabs mb-3.5 flex gap-5 border-b border-muted px-2 text-[0.8rem]"
    aria-label="Runs views"
  >
    <a
      v-for="t in tabs"
      :key="t.id"
      :href="t.href"
      :aria-current="t.id === current ? 'page' : undefined"
      class="-mb-px border-b-2 border-transparent pb-2 pt-1.5 text-muted no-underline hover:text-default aria-[current=page]:border-primary aria-[current=page]:font-semibold aria-[current=page]:text-highlighted"
    >
      {{ t.label }}
    </a>
  </nav>
</template>
