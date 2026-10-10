<script setup lang="ts">
defineProps<{ title: string; description?: string; icon?: string }>();
</script>
<template>
  <div class="green-empty" role="status">
    <UIcon :name="icon ?? 'i-lucide-inbox'" />
    <h3>{{ title }}</h3>
    <p v-if="description">{{ description }}</p>
    <slot />
  </div>
</template>
