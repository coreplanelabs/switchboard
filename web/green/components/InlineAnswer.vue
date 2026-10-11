<script setup lang="ts">
import { computed } from "vue";
import { useHomeSession } from "../lib/homeSession";
import MarkdownText from "../../src/components/MarkdownText.vue";
import ConversationComposer from "./ConversationComposer.vue";
const home = useHomeSession();
const answer = computed(() => home?.inlineAnswer.value);
</script>
<template>
  <section v-if="answer && home" class="green-inline-answer" aria-label="Answer original unit question">
    <div class="flex justify-between items-start gap-3">
      <p class="flex items-center gap-2 text-xs text-muted">
        <UIcon name="i-lucide-reply" aria-hidden="true" />Reply in this thread
      </p>
      <button
        type="button"
        class="green-icon-button shrink-0"
        aria-label="Preserve answer and return to your messages"
        :disabled="home.sending.value"
        @click="home.preserveInlineAnswer()"
      >
        <UIcon name="i-lucide-x" />
      </button>
    </div>
    <MarkdownText class="my-3" :text="answer.question" />
    <div v-if="home.context.value.length" class="flex flex-wrap gap-2 mb-3" aria-label="Attached context">
      <span v-for="item in home.context.value" :key="`${item.kind}:${item.key}`" class="green-badge"
        >{{ item.label
        }}<button
          v-if="!home.pendingSubmission.value"
          type="button"
          :aria-label="`Remove context: ${item.label}`"
          :disabled="home.sending.value"
          @click="home.context.value = home.context.value.filter((value) => value !== item)"
        >
          <UIcon name="i-lucide-x" /></button
      ></span>
    </div>
    <ConversationComposer
      :captured-revision="answer.revision"
      :primary-action="answer.primaryAction ?? { label: 'Confirm', text: 'confirm' }"
    />
    <p
      v-if="home.text.value.trim() || home.context.value.length || home.pendingSubmission.value"
      class="mt-2 text-xs text-muted"
    >
      Closing keeps this thread's draft and any unconfirmed submission.
    </p>
  </section>
</template>
<style scoped>
.green-inline-answer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
}
</style>
