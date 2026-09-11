<script setup lang="ts">
// Site navigation shared by every page (/runs, /residents, /costs, /delivery).
// Which sections exist is `navSections` (web/src/lib/navSections.ts): the one
// list the shell's phone menu reads too. Full page loads (plain anchors): the
// server renders a fresh shell + seed per section. The current section is ink
// over a 1px grey rail — a weight and a line, never a coloured fill.
import { computed } from "vue";
import { useCapabilities } from "../lib/capabilities";
import { navSections, type NavSection } from "../lib/navSections";

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
      class="font-medium text-muted no-underline decoration-1 underline-offset-[6px] hover:text-highlighted aria-[current=page]:text-highlighted aria-[current=page]:underline aria-[current=page]:decoration-(--ui-border-accented)"
    >
      {{ s.label }}
    </a>
  </nav>
</template>
