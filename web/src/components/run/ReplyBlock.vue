<script setup lang="ts">
// The Reply block — what went back (the product's word: "the reply lands in
// the thread"). One component because the run page places it in two spots:
// first on a finished run's page, where a reader wants the outcome before the
// work, and last on a live page, where it lands as it arrives. The caption
// says what the reply is, from the run's facts (`replyCaption`); the moment
// sits at the right edge like every block heading.
import MarkdownText from "../MarkdownText.vue";

defineProps<{
  text: string;
  at: number | undefined;
  caption: { text: string; href?: string };
  when: string;
  whenTitle: string | undefined;
  /** `first` — under the Request, above the work; `last` — after the steps. */
  position: "first" | "last";
}>();
</script>

<template>
  <section
    id="reply"
    class="block rounded-lg border border-ok/40 bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
    :class="position === 'first' ? 'mb-4' : 'mt-6'"
    :data-position="position"
  >
    <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-ok">
      <span>Reply</span>
      <a
        v-if="caption.href"
        class="caption font-normal normal-case tracking-normal text-dimmed no-underline hover:text-primary hover:underline"
        :href="caption.href"
        target="_blank"
        rel="noopener noreferrer"
        >{{ caption.text }}</a
      >
      <span v-else class="caption font-normal normal-case tracking-normal text-dimmed">{{ caption.text }}</span>
      <span
        class="ts ml-auto select-none text-xs font-normal normal-case tracking-normal text-dimmed"
        :title="whenTitle"
        >{{ when }}</span
      >
    </h2>
    <MarkdownText :text="text" />
  </section>
</template>
