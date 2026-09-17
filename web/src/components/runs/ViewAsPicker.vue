<script setup lang="ts">
import { computed, ref } from "vue";
import type { ViewablePerson } from "@core/channels/webSeed.js";
import { enterViewAs } from "../../lib/viewAs";

// The view-as picker (record 0053): a combobox over the people the page can
// name — the requesters of its rows, by name — with a typed Slack id accepted
// too (Enter on text the list lacks offers it as an item). Picking posts the
// choice and the index reloads as that person. Drawn only when the seed offers
// `viewAs`, which the server sets for a session holding every grant.

const props = defineProps<{ people: readonly ViewablePerson[] }>();
const busy = ref(false);
const error = ref("");

interface Item {
  label: string;
  value: string;
  suffix?: string;
}
const items = computed((): Item[] =>
  props.people.map((p) => ({ label: p.name ?? p.id, value: p.id, ...(p.name ? { suffix: p.id } : {}) })),
);

async function pick(value: unknown): Promise<void> {
  const person = typeof value === "string" ? value.trim() : "";
  if (!person) return;
  busy.value = true;
  error.value = "";
  const r = await enterViewAs(person);
  if (!r.ok) {
    busy.value = false;
    error.value = r.message;
  }
}
</script>

<template>
  <span class="view-as-picker inline-flex items-center gap-2">
    <UInputMenu
      id="view-as-pick"
      :model-value="''"
      :items="items"
      value-key="value"
      :filter-fields="['label', 'value']"
      create-item
      placeholder="View as…"
      aria-label="view the dashboard as a person"
      :disabled="busy"
      size="xs"
      class="w-44 text-xs"
      @update:model-value="pick"
      @create="pick"
    >
      <template #item-trailing="{ item }">
        <span v-if="item.suffix" class="ml-2 font-mono text-[0.6875rem] text-dimmed">{{ item.suffix }}</span>
      </template>
      <template #create-item-label="{ item }">
        View as <span class="font-mono">{{ item }}</span>
      </template>
    </UInputMenu>
    <span v-if="error" class="text-bad">{{ error }}</span>
  </span>
</template>
