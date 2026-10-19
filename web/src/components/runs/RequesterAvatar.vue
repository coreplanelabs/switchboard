<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{ name: string; url?: string }>();
const failed = ref(false);
const photo = computed(() => (props.url?.startsWith("https://avatars.slack-edge.com/") ? props.url : undefined));
const initials = computed(() =>
  props.name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase(),
);
watch(photo, () => {
  failed.value = false;
});
</script>

<template>
  <span
    class="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accented text-[0.6rem] font-medium"
    aria-hidden="true"
  >
    <img
      v-if="photo && !failed"
      :src="photo"
      alt=""
      class="size-full object-cover"
      referrerpolicy="no-referrer"
      @error="failed = true"
    />
    <span v-else>{{ initials }}</span>
  </span>
</template>
