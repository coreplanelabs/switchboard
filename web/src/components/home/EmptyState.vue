<script setup lang="ts">
import BrandMark from "../BrandMark.vue";
import { greeting } from "../../lib/homeModel";

// The empty state (docs/reference/specs/web-chat.md rules 6 and 7): the page
// lands in a choreography — the mark draws its route and floats, then the
// greeting, the line under it, the composer and the chips rise in 40 ms steps —
// so the first second has a rhythm and the eye ends on the box. The greeting
// names the person and the time of day; the chips are derived from data the
// bot holds (what its agents are for: reviews, investigations, autofix triage,
// the deploy's history), never a hand list. A chip SENDS its words: one click,
// no Enter.

defineProps<{
  name: string;
  /** The browser's local hour, resolved by the page. */
  hour: number;
  suggestions: string[];
}>();
const emit = defineEmits<{ pick: [text: string] }>();
</script>

<template>
  <section class="empty mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-3 py-6 text-center">
    <BrandMark draw idle class="mark-lg sb-stagger text-highlighted" style="font-size: 3.25rem; --sb-i: 0" />
    <div class="flex flex-col gap-1.5">
      <h2 class="greeting sb-stagger text-xl font-medium tracking-tight text-highlighted" style="--sb-i: 1">
        {{ greeting(hour, name) }}
      </h2>
      <p class="sub sb-stagger text-[0.875rem] text-muted" style="--sb-i: 2">
        Ask in plain words. The right agent picks it up, and you watch it work here.
      </p>
    </div>
    <!-- The composer sits here on the empty state, under the greeting and over
         the chips, so the first thing to do is the thing in the middle. -->
    <div class="sb-stagger w-full text-left" style="--sb-i: 3"><slot /></div>
    <ul v-if="suggestions.length > 0" class="chips flex flex-wrap justify-center gap-2" aria-label="Suggestions">
      <li v-for="(s, i) in suggestions" :key="s" class="sb-stagger" :style="{ '--sb-i': i + 4 }">
        <button
          type="button"
          class="chip rounded-full border border-default px-3 py-1 text-[0.8rem] text-toned transition-[color,border-color,background-color,transform] duration-150 ease-out hover:-translate-y-px hover:border-accented hover:bg-(--ui-bg-muted) hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary active:translate-y-0"
          @click="emit('pick', s)"
        >
          {{ s }}
        </button>
      </li>
    </ul>
  </section>
</template>
