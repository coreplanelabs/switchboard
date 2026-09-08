<script setup lang="ts">
import { computed } from "vue";
import ExpandableText from "../../components/ExpandableText.vue";
import { originNote } from "./tour";
import type { PrDescriptionData } from "./types";

// The PR's description at the top of the left column: the TL;DR — and, after
// it, the "What & why" when the host separated it — folded to five lines with
// a Show more (the app's ExpandableText, the one component the module takes
// from outside its folder; see README.md); under it, when the description was
// read back from the PR body and came up short, one muted note saying so. The
// title is the header's, not repeated here. Prose renders as text: a
// description is markdown the module has no renderer for, and its syntax
// reads fine as-is. The fade lands on the column's own ground.

const props = defineProps<{ description: PrDescriptionData }>();
const note = computed(() => originNote(props.description));
</script>

<template>
  <section
    v-if="description.tldr || description.whatWhy || note"
    class="description border-b border-default px-3 py-2"
    data-testid="pr-description"
  >
    <h3 class="m-0 mb-1 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Description</h3>
    <ExpandableText :lines="5" class="font-sans text-[0.8rem] text-default" style="--expandable-surface: var(--ui-bg)">
      <p v-if="description.tldr" class="m-0 whitespace-pre-line leading-snug" data-testid="description-tldr">
        {{ description.tldr }}
      </p>
      <template v-if="description.whatWhy">
        <h4 class="m-0 mt-2 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">What & why</h4>
        <p class="m-0 mt-0.5 whitespace-pre-line leading-snug" data-testid="description-what-why">
          {{ description.whatWhy }}
        </p>
      </template>
    </ExpandableText>
    <p v-if="note" class="m-0 mt-1.5 font-sans text-[0.7rem] italic text-dimmed" data-testid="description-origin">
      {{ note }}
    </p>
  </section>
</template>
