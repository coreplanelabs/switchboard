<script setup lang="ts">
defineProps<{ offer: { id: string; line: string; risk?: string; question?: string }; busy: boolean }>();
const emit = defineEmits<{ choose: [choice: { kind: "confirm" | "cancel"; id: string }] }>();
</script>

<template>
  <div class="my-3 rounded border border-default p-3" data-testid="confirmation-offer">
    <p v-if="offer.question">{{ offer.question }}</p>
    <code>{{ offer.line }}</code>
    <p v-if="offer.risk" class="mt-2 text-sm text-toned">{{ offer.risk }}</p>
    <div class="mt-3 flex gap-3">
      <button :disabled="busy" @click="emit('choose', { kind: 'confirm', id: offer.id })">Confirm saved action</button>
      <button :disabled="busy" @click="emit('choose', { kind: 'cancel', id: offer.id })">Cancel</button>
    </div>
  </div>
</template>
