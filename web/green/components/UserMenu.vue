<script setup lang="ts">
import RequesterAvatar from "../../src/components/runs/RequesterAvatar.vue";
import { onClickOutside } from "@vueuse/core";
import { inject, ref } from "vue";
import { SeedKey } from "../../src/lib/seed";
import { browser } from "../../src/lib/browser";
import { useHomeSession } from "../lib/homeSession";
const seed = inject(SeedKey, null);
const home = useHomeSession();
const menu = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
function close() {
  open.value = false;
  trigger.value?.focus();
}
onClickOutside(menu, () => {
  open.value = false;
});
const open = ref(false),
  busy = ref(false),
  error = ref("");
async function change(value: string) {
  if (busy.value) return;
  const person = value.startsWith("person:") ? value.slice(7) : null;
  if (person && !seed?.viewAs?.people.some((p) => p.id === person)) return;
  if (value === "everyone" && !seed?.dataView?.canViewEveryone) return;
  if (!person && value !== "mine" && value !== "everyone") return;
  busy.value = true;
  error.value = "";
  home?.resetPrivate();
  try {
    const response = await fetch(person ? "/runs/view-as" : "/runs/data-view", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(person ? { person } : { mode: value }),
    });
    if (response.ok) {
      const query = new URLSearchParams(browser.search());
      const paged = ["cursor", "before", "beforeId"].some((key) => query.has(key));
      for (const key of ["cursor", "before", "beforeId"]) query.delete(key);
      if (paged) browser.navigate(browser.pathname() + (query.size ? `?${query}` : ""));
      else browser.reload();
      return;
    }
    const result = (await response.json().catch(() => null)) as { message?: string } | null;
    error.value = result?.message ?? "The dashboard view could not be changed.";
  } catch {
    error.value = "The dashboard view could not be confirmed. Personal messages remain hidden.";
  }
  busy.value = false;
}
</script>
<template>
  <div ref="menu" class="green-user-menu" @keydown.esc="close">
    <button
      ref="trigger"
      type="button"
      class="green-user-trigger"
      aria-label="User menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <RequesterAvatar
        v-if="seed?.signedInUser?.name"
        :name="seed.signedInUser.name"
        :url="seed.signedInUser.avatarUrl"
      />
      <UIcon v-else name="i-lucide-circle-user-round" />
      <span class="green-user-label">
        <span class="green-user-name">{{ seed?.signedInUser?.name ?? "Your account" }}</span>
        <span v-if="seed?.viewingAs" class="green-user-read-target text-muted"
          >Viewing {{ seed.viewingAs.name ?? seed.viewingAs.id }}</span
        >
      </span>
      <UIcon name="i-lucide-chevron-down" />
    </button>
    <div v-if="open" class="green-user-panel" aria-label="Dashboard view">
      <p class="text-xs text-muted mb-2">Dashboard view</p>
      <label class="sr-only" for="green-data-view">View as person</label>
      <select
        id="green-data-view"
        class="green-input w-full"
        aria-label="View as person"
        :disabled="busy"
        :value="
          seed?.viewingAs ? `person:${seed.viewingAs.id}` : seed?.dataView?.mode === 'everyone' ? 'everyone' : 'mine'
        "
        @change="change(($event.target as HTMLSelectElement).value)"
      >
        <option value="mine">Mine</option>
        <option v-for="person in seed?.viewAs?.people ?? []" :key="person.id" :value="`person:${person.id}`">
          View as {{ person.name ?? person.id }}
        </option>
        <option v-if="seed?.dataView?.canViewEveryone" value="everyone">All people</option>
      </select>
      <p v-if="seed?.viewingAs" class="mt-2 text-xs text-muted">This person's view is read-only.</p>
      <p v-if="seed?.dataView?.mode === 'everyone'" class="mt-2 text-xs text-muted">
        All permitted work. Your messages keep your identity.
      </p>
      <RouterLink class="green-button mt-3 w-full" to="/settings/identities" @click="open = false"
        >Linked accounts</RouterLink
      >
      <p v-if="error" class="green-error text-xs mt-2" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
<style scoped>
.green-user-menu {
  position: relative;
  margin-left: auto;
  min-width: 0;
}
.green-user-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  font-size: 12px;
  max-width: min(44vw, 190px);
}
.green-user-label {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}
.green-user-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.green-user-panel {
  position: absolute;
  right: 0;
  top: 44px;
  width: min(300px, calc(100vw - 24px));
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg-elevated);
  box-shadow: 0 8px 28px rgb(0 0 0 / 15%);
  z-index: 50;
}
</style>
