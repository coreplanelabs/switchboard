<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useMediaQuery } from "@vueuse/core";
import type { HomeUnit } from "@core/core/home/service.js";
import { githubPrUrl } from "../../src/lib/githubLinks";
import { endingWordOf } from "@core/core/pipelineStanding.js";
import { rowOffsets, visibleWindow } from "../lib/virtualRows";
const props = defineProps<{
  rows: (HomeUnit & { activity?: "moving" })[];
  label: string;
  urgent?: boolean;
  activity?: "moving";
  attentionRecipient?: string;
}>();
const query = ref("");
const narrow = useMediaQuery("(max-width: 639px)");
const filtered = computed(() =>
  props.rows.filter((row) =>
    `${row.unit.title ?? ""} ${row.unit.id} ${row.instance.repo} ${row.unit.branch} ${row.conditions.map((c) => c.summary).join(" ")}`
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const measured = ref<Record<string, number>>({});
const offsets = computed(() =>
  rowOffsets(
    filtered.value.map((row) => row.unit.unit),
    measured.value,
    narrow.value ? 230 : 150,
  ),
);
const window = computed(() => visibleWindow(offsets.value, scrollTop.value, 600));
const list = computed(() =>
  filtered.value
    .slice(window.value.start, window.value.end)
    .map((data, index) => ({ data, index: index + window.value.start })),
);
let observer: ResizeObserver | null = null;
const elements = new Map<string, Element>();
function setRow(key: string, element: unknown) {
  const previous = elements.get(key);
  if (previous) observer?.unobserve(previous);
  if (element instanceof Element) {
    elements.set(key, element);
    observer?.observe(element);
  } else elements.delete(key);
}
onMounted(() => {
  if (typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver((entries) => {
    const next = { ...measured.value };
    let changed = false;
    for (const entry of entries) {
      const key = entry.target.getAttribute("data-unit");
      if (!key) continue;
      const height = entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
      if (height > 0 && Math.abs((next[key] ?? 0) - height) > 1) {
        next[key] = height;
        changed = true;
      }
    }
    if (changed) measured.value = next;
  });
  for (const element of elements.values()) observer.observe(element);
});
onBeforeUnmount(() => observer?.disconnect());
function resetScroll() {
  scrollTop.value = 0;
  if (viewport.value) viewport.value.scrollTop = 0;
  void nextTick();
}
function onKeydown(event: KeyboardEvent) {
  const element = viewport.value;
  if (!element || event.target !== element) return;
  const size = element.clientHeight || 600;
  const max = Math.max(0, offsets.value[offsets.value.length - 1] - size);
  const change =
    event.key === "PageDown"
      ? size
      : event.key === "PageUp"
        ? -size
        : event.key === "ArrowDown"
          ? 48
          : event.key === "ArrowUp"
            ? -48
            : null;
  if (change === null && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const target =
    event.key === "Home" ? 0 : event.key === "End" ? max : Math.max(0, Math.min(max, scrollTop.value + (change ?? 0)));
  element.scrollTop = target;
  scrollTop.value = target;
}
const owner = (row: HomeUnit) =>
  row.conditions
    .map((condition) =>
      condition.owner.kind === "person"
        ? condition.owner.id === props.attentionRecipient
          ? "You"
          : `Assigned to: ${condition.owner.id}`
        : condition.owner.kind === "automation"
          ? `Us · ${condition.owner.class}`
          : condition.owner.kind === "external"
            ? `The world · ${condition.owner.label}`
            : "Who acts is not recorded",
    )
    .join(" · ");
const state = (row: (typeof props.rows)[number]) => {
  if (row.conditions.some((condition) => condition.state === "open")) return "Waiting";
  if (props.activity === "moving" || row.activity === "moving") return "Working";
  if (row.unit.ending) return endingWordOf(row.unit.ending.kind);
  if (row.unit.idle) return "Waiting";
  return "State not recorded";
};
</script>
<template>
  <section class="green-section" :class="{ 'green-attention-section': urgent }">
    <div class="green-section-heading">
      <div>
        <h2>
          {{ label }} <span class="green-badge ml-2">{{ rows.length }}</span>
        </h2>
        <p v-if="urgent">A recorded condition is assigned to you.</p>
      </div>
      <label v-if="rows.length > 8" class="max-w-[48%]"
        ><span class="sr-only">Filter {{ label.toLowerCase() }}</span
        ><input v-model="query" class="green-input w-full text-xs" placeholder="Filter work…" @input="resetScroll"
      /></label>
    </div>
    <p v-if="!filtered.length" class="p-5 text-xs text-muted">
      {{ query ? "No matching work in this list." : "No work in this section." }}
    </p>
    <template v-else>
      <p v-if="filtered.length > 10" class="px-5 pt-3 text-xs text-muted" role="status">
        {{ filtered.length }} matching units. Scroll or use Page Down and Page Up to see all unresolved work.
      </p>
      <div
        ref="viewport"
        :style="{ maxHeight: '600px', overflow: 'auto' }"
        :aria-label="`${label}: ${filtered.length} units`"
        tabindex="0"
        @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
        @keydown="onKeydown"
      >
        <div role="list">
          <div :style="{ height: `${offsets[window.start]}px` }" aria-hidden="true" />
          <article
            v-for="item in list"
            :key="item.data.unit.unit"
            :ref="(element) => setRow(item.data.unit.unit, element)"
            role="listitem"
            :aria-posinset="item.index + 1"
            :aria-setsize="filtered.length"
            class="green-unit-row"
            :data-unit="item.data.unit.unit"
          >
            <div class="green-unit-row-head">
              <RouterLink :to="`/runs/unit/${encodeURIComponent(item.data.unit.unit)}`" class="green-unit-title">{{
                item.data.unit.title ?? `Unit ${item.data.unit.id}`
              }}</RouterLink
              ><span class="green-badge">{{ state(item.data) }}</span>
            </div>
            <p class="green-unit-meta">
              {{ item.data.instance.repo }} · {{ item.data.unit.branch
              }}<a
                v-if="item.data.unit.pr"
                :href="githubPrUrl(item.data.instance.repo, item.data.unit.pr.number) ?? undefined"
                target="_blank"
                rel="noopener noreferrer"
              >
                · #{{ item.data.unit.pr.number }} ↗</a
              >
            </p>
            <p v-if="item.data.conditions.length" class="green-unit-condition">
              {{ item.data.conditions.map((c) => c.summary).join(" · ") }}
            </p>
            <div class="green-unit-row-footer">
              <span class="green-unit-owner">{{ owner(item.data) || "No condition details available" }}</span
              ><span class="green-unit-next">{{
                item.data.nextAction.kind === "recorded" ? item.data.nextAction.text : "Next action not recorded"
              }}</span>
            </div>
          </article>
          <div :style="{ height: `${offsets[offsets.length - 1] - offsets[window.end]}px` }" aria-hidden="true" />
        </div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.green-attention-section {
  border-color: color-mix(in srgb, var(--ui-warning) 45%, var(--ui-border));
}
.green-unit-row {
  padding: 16px 20px;
  border-bottom: 1px solid var(--ui-border-muted);
}
.green-unit-row-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.green-unit-title {
  color: var(--ui-text-highlighted);
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.green-unit-title:hover {
  color: var(--ui-primary);
}
.green-unit-meta {
  color: var(--ui-text-muted);
  font-size: 11px;
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.green-unit-condition {
  overflow-wrap: anywhere;
  color: var(--ui-text);
  font-size: 12px;
  margin-top: 9px;
}
.green-unit-row-footer {
  overflow-wrap: anywhere;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 9px;
  font-size: 11px;
}
.green-unit-owner {
  color: var(--ui-text-muted);
}
.green-unit-next {
  color: var(--ui-text-toned);
}
@media (max-width: 639px) {
  .green-unit-row {
    padding: 14px 16px;
  }
  .green-unit-row-footer {
    overflow-wrap: anywhere;
    flex-direction: column;
    gap: 4px;
  }
}
</style>
