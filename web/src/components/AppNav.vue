<script lang="ts">
// Site navigation shared by every page (/runs, /residents, /costs). One list,
// one place to add the next section — and one rule for which sections exist:
// a section needs its capability on (src/core/capabilities.ts, via the seed),
// except Runs, which is the dashboard itself, and the section the viewer is on.
// Full page loads (plain anchors): the server renders a fresh shell + seed per
// section.
import type { Capabilities } from "@core/core/capabilities.js";

export type NavSection = "runs" | "residents" | "costs";

export interface NavItem {
  id: NavSection;
  label: string;
  href: string;
  icon: string;
  /** The capability this section needs; absent → always there (Runs). */
  on?: (caps: Capabilities) => boolean;
}

const SECTIONS: ReadonlyArray<NavItem> = [
  { id: "runs", label: "Runs", href: "/runs", icon: "i-lucide-list" },
  { id: "residents", label: "Residents", href: "/residents", icon: "i-lucide-server", on: (c) => c.residents },
  { id: "costs", label: "Costs", href: "/costs", icon: "i-lucide-circle-dollar-sign", on: (c) => c.costs },
];

/** The sections this installation has, in fixed order: Runs, each one whose
 *  capability is on, and the current one (the viewer is on it — it exists).
 *  No capabilities (no seed) → Runs and the current section only. */
export function navSections(caps: Capabilities | null, current: NavSection): NavItem[] {
  return SECTIONS.filter((s) => s.id === current || s.on === undefined || (caps !== null && s.on(caps)));
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { useCapabilities } from "../lib/capabilities";

const props = defineProps<{ current: NavSection }>();
const caps = useCapabilities();
const sections = computed(() => navSections(caps, props.current));
</script>

<template>
  <nav class="site flex items-center gap-3.5 text-[0.8rem]" aria-label="Sections">
    <a
      v-for="s in sections"
      :key="s.id"
      :href="s.href"
      :aria-current="s.id === current ? 'page' : undefined"
      class="text-muted no-underline underline-offset-4 hover:text-highlighted hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-highlighted aria-[current=page]:underline"
    >
      {{ s.label }}
    </a>
  </nav>
</template>
