<script setup lang="ts">
defineProps<{ tiles: readonly { label: string; value: string; note?: string }[] }>();
</script>
<template>
  <dl class="green-stat-grid">
    <div v-for="tile in tiles" :key="tile.label" class="green-stat">
      <dt>{{ tile.label }}</dt>
      <dd>{{ tile.value }}</dd>
      <p v-if="tile.note">{{ tile.note }}</p>
    </div>
  </dl>
</template>
