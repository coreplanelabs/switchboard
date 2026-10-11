<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useMediaQuery } from "@vueuse/core";
import type {
  HomeAnswerTarget,
  HomeMergeAction,
  HomeConfirmationOffer,
  HomeConfirmationChoice,
} from "@core/channels/homeSeed.js";
import MergeAction from "./MergeAction.vue";
import { SeedKey, useViewingAs } from "../../src/lib/seed";
import { useHomeSession } from "../lib/homeSession";
import InlineAnswer from "./InlineAnswer.vue";
import type { HomeUnit } from "@core/core/home/service.js";
import { githubPrUrl, githubRepoUrl, githubTreeUrl } from "../../src/lib/githubLinks";
import { endingWordOf } from "@core/core/pipelineStanding.js";
import { rowOffsets, visibleWindow } from "../lib/virtualRows";
const props = defineProps<{
  rows: (HomeUnit & { activity?: "moving" })[];
  label: string;
  urgent?: boolean;
  activity?: "moving";
  attentionRecipient?: string;
  attentionRecipients?: string[];
  answers?: Record<string, HomeAnswerTarget>;
  actions?: Record<string, HomeMergeAction>;
  actionScope?: string | null;
  savedActions?: Record<string, { offer: HomeConfirmationOffer; pending: HomeConfirmationChoice }>;
}>();
const emit = defineEmits<{
  merged: [unit: string];
  settled: [unit: string];
  unknown: [
    unit: string,
    saved: { offer: HomeConfirmationOffer; pending: HomeConfirmationChoice },
    scope: string | null | undefined,
  ];
}>();
const query = ref("");
const home = useHomeSession();
const viewingAs = useViewingAs();
const globalSeed = inject(SeedKey, null);
const canReply = !viewingAs && (!globalSeed?.dataView || globalSeed.dataView.mode !== "person");
const answerHere = (row: HomeUnit) => canReply && home?.inlineAnswer.value?.unit === row.unit.unit;
const safeUrl = (url: string | undefined) => (url && /^https?:\/\//.test(url) ? url : undefined);
const narrow = useMediaQuery("(max-width: 639px)");
const filtered = computed(() =>
  props.rows.filter(
    (row) =>
      answerHere(row) ||
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
        ? (props.attentionRecipients ?? (props.attentionRecipient ? [props.attentionRecipient] : [])).includes(
            condition.owner.id,
          )
          ? "You"
          : `Assigned to: ${condition.owner.id}`
        : condition.owner.kind === "automation"
          ? condition.owner.class
          : condition.owner.kind === "external"
            ? condition.owner.label
            : "Assignment unknown",
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
        {{ filtered.length }} matching units. Scroll or use Page Down and Page Up to see all matching work.
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
            :class="{ 'green-unit-row-answering': answerHere(item.data) }"
            :data-unit="item.data.unit.unit"
          >
            <div class="green-unit-row-head">
              <RouterLink :to="`/runs/unit/${encodeURIComponent(item.data.unit.unit)}`" class="green-unit-title">{{
                item.data.unit.title ?? `Unit ${item.data.unit.id}`
              }}</RouterLink
              ><span class="green-badge" :data-state="state(item.data)">{{ state(item.data) }}</span>
            </div>
            <p class="green-unit-meta">
              <a
                v-if="githubRepoUrl(item.data.instance.repo)"
                :href="githubRepoUrl(item.data.instance.repo)"
                target="_blank"
                rel="noopener noreferrer"
                ><UIcon name="i-lucide-folder-git-2" aria-hidden="true" /> {{ item.data.instance.repo }}</a
              ><span v-else>{{ item.data.instance.repo }}</span> ·
              <a
                v-if="githubTreeUrl(item.data.instance.repo, item.data.unit.branch)"
                :href="githubTreeUrl(item.data.instance.repo, item.data.unit.branch)"
                target="_blank"
                rel="noopener noreferrer"
                ><UIcon name="i-lucide-git-branch" aria-hidden="true" /> {{ item.data.unit.branch }}</a
              ><span v-else>{{ item.data.unit.branch }}</span
              ><a
                v-if="item.data.unit.pr"
                :href="githubPrUrl(item.data.instance.repo, item.data.unit.pr.number) ?? undefined"
                target="_blank"
                rel="noopener noreferrer"
              >
                · <UIcon name="i-lucide-git-pull-request" aria-hidden="true" /> #{{ item.data.unit.pr.number }}</a
              >
            </p>
            <InlineAnswer v-if="answerHere(item.data)" />
            <p v-else-if="item.data.conditions.length" class="green-unit-condition">
              {{ item.data.conditions.map((c) => c.summary).join(" · ") }}
            </p>
            <div class="green-unit-row-footer">
              <span class="green-unit-owner">{{ owner(item.data) || "No condition details available" }}</span
              ><span v-if="!answerHere(item.data)" class="green-unit-next">{{
                item.data.nextAction.kind === "recorded" ? item.data.nextAction.text : "Next action not recorded"
              }}</span>
            </div>
            <div class="green-unit-links" aria-label="Original work links">
              <MergeAction
                v-if="urgent && actions?.[item.data.unit.unit] && canReply"
                :action="actions[item.data.unit.unit]"
                :scope="actionScope"
                :saved="savedActions?.[item.data.unit.unit]"
                @merged="emit('merged', item.data.unit.unit)"
                @settled="emit('settled', item.data.unit.unit)"
                @unknown="(saved, scope) => emit('unknown', item.data.unit.unit, saved, scope)"
              />
              <button
                v-if="urgent && answers?.[item.data.unit.unit] && home && canReply && !home.inlineAnswer.value"
                type="button"
                class="green-button green-button-primary"
                :aria-label="`Answer: ${item.data.unit.title ?? item.data.unit.id}`"
                :disabled="home.sending.value || home.status.value !== 'ready'"
                @click="
                  home.beginInlineAnswer(
                    item.data.unit.unit,
                    item.data.unit.title ?? item.data.unit.id,
                    answers[item.data.unit.unit],
                  )
                "
              >
                <UIcon name="i-lucide-reply" />Answer
              </button>
              <RouterLink
                v-if="item.data.unit.threads.coding"
                :to="`/threads/${encodeURIComponent(item.data.unit.threads.coding)}`"
                aria-label="Original unit thread"
                title="Original unit thread"
                ><UIcon name="i-lucide-messages-square" /><span class="sr-only">Thread</span></RouterLink
              >
              <RouterLink
                v-if="item.data.unit.threads.review"
                :to="`/threads/${encodeURIComponent(item.data.unit.threads.review)}`"
                aria-label="Review thread"
                title="Review thread"
                ><UIcon name="i-lucide-message-square-check" /><span class="sr-only">Review thread</span></RouterLink
              >
              <RouterLink
                v-if="item.data.unit.pr"
                :to="`/runs/unit/${encodeURIComponent(item.data.unit.unit)}#changes`"
                aria-label="Changes"
                title="Changes"
                ><UIcon name="i-lucide-git-compare" /><span class="sr-only">Changes</span></RouterLink
              >
              <a
                v-if="safeUrl(item.data.instance.sourceUrl)"
                :href="safeUrl(item.data.instance.sourceUrl)"
                target="_blank"
                rel="noopener noreferrer"
                >Asking thread ↗</a
              >
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
.green-unit-row-answering {
  background: var(--green-selected);
}
.green-unit-links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--ui-primary);
}
.green-unit-links a {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
