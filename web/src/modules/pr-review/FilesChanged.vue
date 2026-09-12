<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from "vue";
import { useColorMode, useElementSize } from "@vueuse/core";
import FileDiffs from "./FileDiffs.vue";
import { diffStats, ellipsizeMiddle, type DiffFileStats } from "./files";
import { fileIcon } from "./fileIcons";

// The files a diff touches, listed once on the left and rendered in full on
// the right; picking a file scrolls its diff into view while the list itself
// stays put. Above the diff, the host's notes on it (the producer's summary,
// a truncation) as muted lines.

const props = defineProps<{
  diff: string;
  /** Muted lines over the diff: the abridged diff's summary, the cut's notice. */
  notes?: readonly string[];
  diffStyle?: "unified" | "split";
}>();

const FILE_NAME_BUDGET = 34;

const colorMode = useColorMode();
const theme = computed(() => (colorMode.value === "dark" ? "dark" : "light"));

const files = ref<DiffFileStats[]>([]);
const loading = ref(true);
const activeFile = ref<string | null>(null);
const panel = useTemplateRef<HTMLElement>("panel");
const root = useTemplateRef<HTMLElement>("root");
// Below this width the list folds above the diff (as on a phone) and the diff
// reads inline, since two columns of code have no room. Measured on the
// component, not the window: the panel is what its host leaves it.
const { width } = useElementSize(root);
// The observer reports the first size only once it settles; measuring the
// moment the diff mounts keeps the first paint from reading two columns into
// a phone-width panel.
watch(root, (element) => {
  if (element) width.value = element.getBoundingClientRect().width;
});
const narrow = computed(() => width.value > 0 && width.value < 672);
const filesOpen = ref(false);
const effectiveDiffStyle = computed(() => (narrow.value ? "unified" : (props.diffStyle ?? "unified")));
let loadToken = 0;

async function load() {
  const token = ++loadToken;
  loading.value = true;
  const stats = await diffStats(props.diff);
  if (token !== loadToken) return;
  files.value = stats.files;
  activeFile.value = null;
  loading.value = false;
}

watch(() => props.diff, load, { immediate: true });

const totals = computed(() =>
  files.value.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  ),
);

function show(path: string) {
  activeFile.value = path;
  if (narrow.value) filesOpen.value = false;
  // Matched on the attribute's value, never through a selector: a path is
  // arbitrary text and belongs in no selector string, escaped or not.
  const containers = panel.value?.querySelectorAll<HTMLElement>("[data-file]") ?? [];
  const target = Array.from(containers).find((el) => el.dataset.file === path);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
}
</script>

<template>
  <div
    v-if="loading"
    class="flex items-center gap-2 p-4 text-sm text-(--ui-text-muted) sm:p-5"
    data-testid="files-loading"
  >
    <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
    <span>Loading diff…</span>
  </div>
  <p v-else-if="files.length === 0" class="p-4 text-sm text-(--ui-text-muted) sm:p-5" data-testid="no-files">
    Nothing in this diff parsed as a file.
  </p>
  <div v-else ref="root" class="@container flex min-h-full flex-col @2xl:flex-row" data-testid="files-changed">
    <aside
      class="shrink-0 border-b border-(--ui-border) @2xl:w-72 @2xl:border-b-0 @2xl:border-r"
      data-testid="file-list"
    >
      <div class="@2xl:sticky @2xl:top-0 @2xl:max-h-[calc(100dvh-11rem)] @2xl:overflow-y-auto @2xl:py-3">
        <button
          v-if="narrow"
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-(--ui-text-muted)"
          :aria-expanded="filesOpen"
          data-testid="files-fold"
          @click="filesOpen = !filesOpen"
        >
          <UIcon
            :name="filesOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3.5 shrink-0 text-(--ui-text-dimmed)"
          />
          <span>{{ files.length }} {{ files.length === 1 ? "file" : "files" }} changed</span>
          <span class="ml-auto tabular-nums" data-testid="pr-totals"
            ><span class="text-(--ui-success)">+{{ totals.additions }}</span>
            <span class="text-(--ui-error)">−{{ totals.deletions }}</span></span
          >
        </button>
        <div v-else class="flex items-center justify-between gap-2 px-3 pb-2 text-xs text-(--ui-text-dimmed)">
          <span data-testid="file-count">{{ files.length }} {{ files.length === 1 ? "file" : "files" }}</span>
          <span class="tabular-nums" data-testid="pr-totals"
            ><span class="text-(--ui-success)">+{{ totals.additions }}</span>
            <span class="text-(--ui-error)">−{{ totals.deletions }}</span></span
          >
        </div>
        <ul v-if="!narrow || filesOpen" class="flex flex-col" :class="narrow ? 'pb-2' : ''">
          <li v-for="file in files" :key="file.path">
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accented/50 dark:hover:bg-(--ui-bg)"
              :class="
                activeFile === file.path
                  ? 'bg-accented/50 text-(--ui-text) dark:bg-(--ui-bg)'
                  : 'text-(--ui-text-muted)'
              "
              :title="file.path"
              :aria-current="activeFile === file.path ? 'true' : undefined"
              data-testid="file-entry"
              @click="show(file.path)"
            >
              <UIcon :name="fileIcon(file.path)" class="size-3.5 shrink-0" />
              <span class="min-w-0 flex-1 whitespace-nowrap">{{ ellipsizeMiddle(file.path, FILE_NAME_BUDGET) }}</span>
              <span class="shrink-0 text-[11px] tabular-nums"
                ><span class="text-(--ui-success)">+{{ file.additions }}</span>
                <span class="text-(--ui-error)">−{{ file.deletions }}</span></span
              >
            </button>
          </li>
        </ul>
      </div>
    </aside>
    <div ref="panel" class="min-w-0 flex-1 overflow-x-auto" data-testid="diff-column">
      <p v-for="note in notes" :key="note" class="px-3 pt-3 text-xs text-(--ui-text-muted)" data-testid="diff-note">
        {{ note }}
      </p>
      <FileDiffs :diff="diff" :theme="theme" :diff-style="effectiveDiffStyle" />
    </div>
  </div>
</template>
