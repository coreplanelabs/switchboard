<script setup lang="ts">
import { computed } from "vue";
import type { HomeConfirmationOffer, HomeConfirmationChoice } from "@core/channels/homeSeed.js";
const props = defineProps<{ offer: HomeConfirmationOffer; busy: boolean; pending?: HomeConfirmationChoice | null }>();
const actionTitle = computed(
  () =>
    props.offer.actionLabel ??
    (/^runs stop\b/.test(props.offer.line)
      ? "Stop run"
      : /^runs kill\b/.test(props.offer.line)
        ? "Delete run"
        : "Confirm action"),
);
const emit = defineEmits<{ choose: [choice: HomeConfirmationChoice] }>();
</script>
<template>
  <section class="green-notice" aria-label="Saved action confirmation" data-testid="confirmation-offer">
    <h3 class="font-medium text-sm mb-2">{{ actionTitle }}</h3>
    <p v-if="offer.question" class="mb-2 text-sm">{{ offer.question }}</p>
    <code class="block text-xs break-words">{{ offer.line }}</code>
    <p v-if="offer.risk" class="mt-2 text-xs text-toned">{{ offer.risk }}</p>
    <p v-if="pending" class="mt-2 text-xs text-toned">The result is unknown. This repeats the same saved choice.</p>
    <div class="flex flex-wrap gap-2 mt-3">
      <button
        v-if="!pending || pending.kind === 'confirm'"
        class="green-button green-button-primary"
        type="button"
        :disabled="busy"
        @click="emit('choose', { kind: 'confirm', id: offer.id })"
      >
        {{ pending ? "Check saved action" : (offer.actionLabel ?? "Confirm") }}</button
      ><button
        v-if="!pending || pending.kind === 'cancel'"
        class="green-button"
        type="button"
        :disabled="busy"
        @click="emit('choose', { kind: 'cancel', id: offer.id })"
      >
        {{ pending ? "Check cancellation" : "Cancel" }}
      </button>
    </div>
  </section>
</template>
