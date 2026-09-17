<script setup lang="ts">
// The source mark (item 21): the ↗ link that opens the run's thread, revealed
// on row hover/focus (GitHub-style quick action). A run without a thread draws
// no mark: the requester cell already names its surface in words, so a glyph
// here would only be a second, unreadable spelling of the same fact. The
// tooltip leads with the Slack mark for a Slack run — a recognisable logo —
// and with nothing else for the other surfaces; allow-listed kinds only,
// never markup.
import SlackMark from "../SlackMark.vue";
import { SURFACE_NAME } from "../../lib/indexRow";

const props = defineProps<{ kind: string; tip: string; url?: string }>();

const name = () => SURFACE_NAME[props.kind] ?? props.kind;
</script>

<template>
  <UTooltip v-if="url">
    <template #content>
      <span class="flex items-baseline gap-1.5 whitespace-pre-line px-2 py-1 text-xs">
        <SlackMark v-if="kind === 'slack'" />
        <span>{{ tip }}</span>
      </span>
    </template>
    <a
      class="source linked pointer-events-auto w-[1.6em] shrink-0 rounded border border-transparent text-center text-[0.8rem] text-toned opacity-0 transition-opacity hover:border-primary/30 hover:bg-primary/10 hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
      :data-kind="kind"
      :aria-label="`open the ${name()} thread (new tab)`"
      :href="url"
      target="_blank"
      rel="noopener noreferrer"
      >↗</a
    >
  </UTooltip>
  <span v-else class="source w-[1.6em] shrink-0" :data-kind="kind" aria-hidden="true"></span>
</template>
