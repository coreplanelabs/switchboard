<script setup lang="ts">
import type { HomeConfirmationOffer, HomeConfirmationChoice } from "@core/channels/homeSeed.js";
defineProps<{ offer: HomeConfirmationOffer; busy: boolean }>();
const emit = defineEmits<{ choose: [choice: HomeConfirmationChoice] }>();
</script>
<template>
  <section class="green-notice" aria-label="Saved action confirmation" data-testid="confirmation-offer">
    <p v-if="offer.question" class="mb-2 text-sm">{{ offer.question }}</p>
    <code class="block text-xs break-words">{{ offer.line }}</code>
    <p v-if="offer.risk" class="mt-2 text-xs text-toned">{{ offer.risk }}</p>
    <div class="flex flex-wrap gap-2 mt-3">
      <button
        class="green-button green-button-primary"
        type="button"
        :disabled="busy"
        @click="emit('choose', { kind: 'confirm', id: offer.id })"
      >
        Confirm saved action</button
      ><button
        class="green-button"
        type="button"
        :disabled="busy"
        @click="emit('choose', { kind: 'cancel', id: offer.id })"
      >
        Cancel
      </button>
    </div>
  </section>
</template>
