<script setup lang="ts">
// The source mark (item 21): where the run came from. With a thread to open it
// is the familiar ↗ arrow (a link, new tab); without one, the surface's glyph.
// Revealed on row hover/focus (GitHub-style quick action). The tooltip leads
// with the surface's icon — allow-listed kinds only, never markup.
import SlackMark from "../SlackMark.vue";
import { SURFACE_GLYPH, SURFACE_NAME } from "../../lib/indexRow";

const props = defineProps<{ kind: string; tip: string; url?: string }>();

const glyph = () => SURFACE_GLYPH[props.kind] ?? "○";
const name = () => SURFACE_NAME[props.kind] ?? props.kind;
</script>

<template>
  <UTooltip>
    <template #content>
      <span class="flex items-baseline gap-1.5 whitespace-pre-line px-2 py-1 text-xs">
        <SlackMark v-if="kind === 'slack'" />
        <span v-else-if="SURFACE_GLYPH[kind]" class="text-dimmed">{{ glyph() }}</span>
        <span>{{ tip }}</span>
      </span>
    </template>
    <a
      v-if="url"
      class="source linked pointer-events-auto w-[1.6em] shrink-0 rounded border border-transparent text-center text-[0.8rem] text-toned opacity-0 transition-opacity hover:border-primary/30 hover:bg-primary/10 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
      :data-kind="kind"
      :aria-label="`open the ${name()} thread (new tab)`"
      :href="url"
      target="_blank"
      rel="noopener noreferrer"
      >↗</a
    >
    <span
      v-else
      class="source pointer-events-auto w-[1.6em] shrink-0 text-center text-[0.8rem] text-dimmed opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
      :class="kind === 'cli' ? 'text-[0.7rem]' : ''"
      :data-kind="kind"
      :aria-label="`source: ${name()}`"
      >{{ glyph() }}</span
    >
  </UTooltip>
</template>
