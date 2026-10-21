<script setup lang="ts">
import { computed } from "vue";
import type { CheckRow, ChecksControl } from "./types";
const props = defineProps<{ control: ChecksControl; recordedHead?: string }>();
const rows = computed(() => props.control.snapshot?.rows ?? []);
const definitions = [
  { key: "failure", label: "failed", icon: "i-lucide-circle-x", color: "text-(--gh-check-danger)" },
  { key: "pending", label: "pending", icon: "i-lucide-circle-dot", color: "text-(--gh-check-attention)" },
  {
    key: "in_progress",
    label: "in progress",
    icon: "i-lucide-loader-circle",
    color: "text-(--gh-check-attention)",
  },
  {
    key: "cancelled",
    label: "cancelled",
    icon: "i-lucide-circle-slash",
    color: "text-(--gh-check-neutral)",
  },
  { key: "neutral", label: "neutral", icon: "i-lucide-circle-minus", color: "text-(--gh-check-neutral)" },
  {
    key: "skipped",
    label: "skipped",
    icon: "i-lucide-circle-skip-forward",
    color: "text-(--gh-check-neutral)",
  },
  {
    key: "success",
    label: "successful",
    icon: "i-lucide-circle-check",
    color: "text-(--gh-check-success)",
  },
] as const;
// Keep failures and active work visible. With no active work, open the first
// relevant result group. Stable values preserve a reader's manual toggles.
const expanded = computed(() => {
  const statuses = new Set<string>(rows.value.map((row) => (row.status === "expected" ? "pending" : row.status)));
  const active = ["failure", "cancelled", "in_progress"].filter((status) => statuses.has(status));
  if (!active.length) {
    const first = ["pending", "success", "neutral", "skipped"].find((status) => statuses.has(status));
    if (first) active.push(first);
  }
  return new Set(active);
});
const groups = computed(() =>
  definitions
    .map((g) => ({
      ...g,
      open: expanded.value.has(g.key),
      rows: rows.value.filter((r) => r.status === g.key || (g.key === "pending" && r.status === "expected")),
    }))
    .filter((g) => g.rows.length),
);
const pending = computed(() => rows.value.some((r) => ["pending", "expected", "in_progress"].includes(r.status)));
const failed = computed(() => rows.value.some((r) => r.status === "failure" || r.status === "cancelled"));
const incomplete = computed(() => !!props.control.error || !!props.control.snapshot?.warnings.length);
const heading = computed(() =>
  incomplete.value
    ? "Some check data is unavailable"
    : !rows.value.length
      ? "No checks reported"
      : failed.value
        ? "Some checks were not successful"
        : pending.value
          ? "Some checks haven't completed yet"
          : "All checks have passed",
);
const counts = computed(() =>
  ["failure", "neutral", "pending", "in_progress", "expected", "skipped", "cancelled", "success"]
    .flatMap((status) => {
      const n = rows.value.filter((r) => r.status === status).length;
      const label = status === "failure" ? "failed" : status === "success" ? "successful" : status.replace("_", " ");
      return n ? [`${n} ${label}`] : [];
    })
    .join(", "),
);
const moved = computed(
  () => props.recordedHead && props.control.snapshot && !props.control.snapshot.headSha.startsWith(props.recordedHead),
);
const statusLabel = (row: CheckRow) =>
  row.status === "expected" ? "Expected" : (definitions.find((g) => g.key === row.status)?.label ?? row.status);
</script>

<template>
  <section class="pr-checks p-4 sm:p-6" data-testid="pr-checks" :aria-busy="control.loading">
    <div class="mb-4 flex items-center justify-between gap-3">
      <div class="text-xs text-(--ui-text-muted)">
        <template v-if="control.snapshot">
          Updated
          {{
            new Date(control.snapshot.checkedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            })
          }}
          <span class="ml-2 font-mono">{{ control.snapshot.checkedSha.slice(0, 7) }}</span>
          <span v-if="control.snapshot.state !== 'OPEN'" class="ml-2"
            >Pull request {{ control.snapshot.state.toLowerCase() }}</span
          >
        </template>
        <span v-else>Current status from GitHub</span>
      </div>
    </div>
    <p
      v-if="control.error"
      role="alert"
      class="mb-4 rounded border border-(--ui-warning) p-3 text-sm text-(--gh-check-attention)"
    >
      {{ control.error
      }}<span v-if="control.snapshot"> The last confirmed checks are shown and may be out of date.</span>
    </p>
    <p v-if="moved" class="mb-4 text-sm text-(--gh-check-attention)" role="status">
      The PR head changed since this diff was recorded. These checks are for the current pull request.
    </p>
    <p
      v-if="control.snapshot && control.snapshot.checkedSha !== control.snapshot.headSha"
      class="mb-4 text-sm text-(--ui-text-muted)"
    >
      Showing checks for the merge commit
    </p>
    <p
      v-if="control.loading && !control.snapshot"
      role="status"
      class="flex items-center gap-2 text-sm text-(--ui-text-muted)"
    >
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />Loading GitHub checks…
    </p>
    <div v-if="control.snapshot" class="overflow-hidden rounded-md border border-(--ui-border)">
      <header class="flex gap-3 border-b border-(--ui-border) bg-(--ui-bg) p-4">
        <UIcon
          :name="
            incomplete
              ? 'i-lucide-circle-alert'
              : failed
                ? 'i-lucide-circle-x'
                : pending
                  ? 'i-lucide-circle-dot'
                  : rows.length
                    ? 'i-lucide-circle-check'
                    : 'i-lucide-circle-minus'
          "
          :class="[
            'mt-0.5 size-6 shrink-0',
            incomplete
              ? 'text-(--gh-check-attention)'
              : failed
                ? 'text-(--gh-check-danger)'
                : pending
                  ? 'text-(--gh-check-attention)'
                  : rows.length
                    ? 'text-(--gh-check-success)'
                    : 'text-(--gh-check-neutral)',
          ]"
        />
        <div class="min-w-0">
          <h2 class="font-semibold" data-testid="checks-summary">{{ heading }}</h2>
          <p v-if="counts" class="mt-1 text-sm text-(--ui-text-muted)">{{ counts }} checks</p>
        </div>
      </header>
      <p
        v-for="warning in control.snapshot.warnings"
        :key="warning"
        role="status"
        class="border-b border-(--ui-border) px-4 py-3 text-sm text-(--gh-check-attention)"
      >
        {{ warning }}
      </p>
      <div class="bg-(--ui-bg-muted) px-4 py-2">
        <details v-for="group in groups" :key="group.key" :open="group.open" class="py-2" :data-status="group.key">
          <summary class="cursor-pointer text-sm font-medium text-(--ui-text-muted)">
            {{ group.rows.length }} {{ group.label }} {{ group.rows.length === 1 ? "check" : "checks" }}
          </summary>
          <ul class="mt-2 divide-y divide-(--ui-border)">
            <li
              v-for="row in group.rows"
              :key="row.id"
              class="flex min-w-0 items-start gap-2 py-3 text-sm sm:items-center"
              :data-check="row.id"
            >
              <UIcon
                :name="row.status === 'expected' ? 'i-lucide-circle-dot' : group.icon"
                :class="[
                  'mt-0.5 size-4 shrink-0 sm:mt-0',
                  group.color,
                  row.status === 'in_progress' ? 'animate-spin' : '',
                ]"
              />
              <img
                v-if="row.icon"
                :src="row.icon"
                :alt="row.provider ?? ''"
                :title="row.provider"
                class="size-5 shrink-0 rounded"
                referrerpolicy="no-referrer"
                loading="lazy"
              />
              <UIcon v-else name="i-lucide-git-pull-request" class="size-5 shrink-0 text-(--ui-text-muted)" />
              <div class="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
                <a
                  v-if="row.url"
                  :href="row.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="min-w-0 break-words hover:underline"
                  >{{ row.name }}</a
                >
                <span v-else class="min-w-0 break-words">{{ row.name }}</span>
                <span class="sr-only">{{ statusLabel(row) }}</span>
                <span
                  v-if="row.description"
                  class="block truncate text-(--ui-text-muted) italic"
                  :title="row.description"
                  >{{ row.description }}</span
                >
              </div>
              <span
                v-if="row.required"
                class="shrink-0 rounded-full border border-(--ui-border-accented) px-2 py-0.5 text-xs"
                >Required</span
              >
            </li>
          </ul>
        </details>
        <p v-if="!rows.length" class="py-3 text-sm text-(--ui-text-muted)">
          GitHub has not reported any checks for this commit.
        </p>
      </div>
    </div>
  </section>
</template>

<style>
/* GitHub Primer status foregrounds: https://primer.style/product/primitives/color/ */
.pr-checks {
  --gh-check-success: #1a7f37;
  --gh-check-attention: #9a6700;
  --gh-check-danger: #d1242f;
  --gh-check-neutral: #59636e;
}
.dark .pr-checks {
  --gh-check-success: #3fb950;
  --gh-check-attention: #d29922;
  --gh-check-danger: #f85149;
  --gh-check-neutral: #9198a1;
}
</style>
