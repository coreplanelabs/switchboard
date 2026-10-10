<script setup lang="ts">
defineProps<{ title: string; description?: string; eyebrow?: string }>();
</script>
<template>
  <div class="green-page-heading">
    <div>
      <p v-if="eyebrow" class="green-eyebrow">{{ eyebrow }}</p>
      <h1>{{ title }}</h1>
      <p v-if="description" class="green-description">{{ description }}</p>
    </div>
    <div class="green-heading-actions"><slot /></div>
  </div>
</template>
