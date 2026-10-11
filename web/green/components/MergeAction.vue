<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { HomeMergeAction, HomeConfirmationChoice, HomeConfirmationOffer } from "@core/channels/homeSeed.js";
import ConfirmationPrompt from "./ConfirmationPrompt.vue";
type SavedChoice = { offer: HomeConfirmationOffer; pending: HomeConfirmationChoice };
const props = defineProps<{ action: HomeMergeAction; scope?: string | null; saved?: SavedChoice }>();
const emit = defineEmits<{
  merged: [];
  settled: [];
  unknown: [saved: SavedChoice, scope: string | null | undefined];
}>();
const busy = ref(false);
const offer = ref<HomeConfirmationOffer | null>(props.saved?.offer ?? null);
const pending = ref<HomeConfirmationChoice | null>(props.saved?.pending ?? null);
const message = ref("");
const finished = ref(false);
let active = true;
onBeforeUnmount(() => {
  active = false;
});
watch(
  () => props.scope,
  () => {
    offer.value = null;
    pending.value = null;
    message.value = "";
    finished.value = false;
  },
);
async function send(choice?: HomeConfirmationChoice) {
  if (busy.value || finished.value || (pending.value && !choice)) return;
  busy.value = true;
  message.value = "";
  if (choice) pending.value = { ...choice };
  const scope = props.scope;
  try {
    const response = await fetch("/api/pulls.merge", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-switchboard-client": "dashboard" },
      body: JSON.stringify(
        choice ? { _confirmation: pending.value } : { pr: props.action.pr, head: props.action.head },
      ),
    });
    const value = await response.json();
    if (!active || scope !== props.scope) return;
    if (
      response.status === 409 &&
      value.error === "confirmation_required" &&
      typeof value.confirmation?.id === "string" &&
      typeof value.confirmation.line === "string"
    ) {
      offer.value = { ...value.confirmation, actionLabel: "Merge" };
    } else if (response.ok) {
      finished.value = true;
      offer.value = null;
      pending.value = null;
      message.value =
        value.kind === "merged"
          ? "Merged."
          : choice?.kind === "cancel"
            ? "Cancelled; nothing ran."
            : "The merge command returned. Open the pull request for its current state.";
      if (value.kind === "merged") emit("merged");
      emit("settled");
    } else {
      message.value = typeof value.message === "string" ? value.message : "The merge was refused.";
      // A consumed saved id can follow a lost acknowledgement. Never turn it
      // into a fresh merge request; retain its exact choice for inspection.
    }
  } catch {
    if (!active || scope !== props.scope) return;
    message.value = choice
      ? "The result is unknown. Check the same saved action."
      : "The command response is unavailable. Open the pull request before trying again.";
  } finally {
    busy.value = false;
    if (active && scope === props.scope && offer.value && pending.value)
      emit("unknown", { offer: { ...offer.value }, pending: { ...pending.value } }, scope);
  }
}
</script>
<template>
  <div class="min-w-0">
    <ConfirmationPrompt v-if="offer" :offer="offer" :busy="busy" :pending="pending" @choose="send" />
    <button
      v-else-if="!finished"
      class="green-button green-button-primary"
      type="button"
      :disabled="busy"
      @click="send()"
    >
      <UIcon name="i-lucide-git-merge" />Merge
    </button>
    <p v-if="message" class="text-xs text-toned mt-2" role="status">{{ message }}</p>
  </div>
</template>
