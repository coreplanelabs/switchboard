<script setup lang="ts">
import type { DiffFileEntry, FileStatus } from "./files";
import { splitPath } from "./files";

// The panel's left column: the files of the diff as a table of contents.
// Stacked sections — the description slot (the PR's TL;DR), the Tour slot (the
// description's steps, each a jump to a file and a line range), then the
// files. The panel fills the two slots from `data.description`; a host may
// pass its own content instead. An entry names the file's status, its path
// with the directory dimmed, its counts, and whether the reader marked it
// viewed; the current file is the one the right column is scrolled to.

defineProps<{
  files: readonly DiffFileEntry[];
  /** The file the diff view is on (scroll-spy or the last click). */
  current: string | null;
  viewed: ReadonlySet<string>;
}>();
const emit = defineEmits<{ select: [path: string]; "toggle-viewed": [path: string] }>();

const STATUS_ICON: Record<FileStatus, string> = {
  added: "i-lucide-file-plus",
  deleted: "i-lucide-file-minus",
  renamed: "i-lucide-file-symlink",
  modified: "i-lucide-file-pen",
};
const STATUS_CLASS: Record<FileStatus, string> = {
  added: "text-ins",
  deleted: "text-del",
  renamed: "text-muted",
  modified: "text-muted",
};
</script>

<template>
  <nav class="file-list flex flex-col pb-24 text-xs" aria-label="Files changed" data-testid="file-list">
    <!-- The PR description's seats, in this order: the TL;DR, the Tour, then
         the files. Empty slots render nothing, so a diff without a description
         starts at the files. -->
    <slot name="description" />
    <slot name="tour" />
    <section class="files">
      <h3
        class="sticky top-0 z-10 flex items-baseline gap-1.5 border-b border-default bg-default px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted"
      >
        Files <span class="tabular-nums text-dimmed">{{ files.length }}</span>
      </h3>
      <ol class="m-0 list-none p-0">
        <li v-for="f in files" :key="f.path" class="border-b border-muted">
          <div
            class="entry flex items-center gap-1.5 px-2 py-1 hover:bg-muted"
            :class="[f.path === current ? 'is-current bg-accented' : '', viewed.has(f.path) ? 'is-viewed' : '']"
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              :class="viewed.has(f.path) ? 'text-dimmed' : 'text-default'"
              :aria-current="f.path === current ? 'true' : undefined"
              :title="f.from ? `${f.from} → ${f.path}` : f.path"
              data-testid="file-entry"
              @click="emit('select', f.path)"
            >
              <UIcon :name="STATUS_ICON[f.status]" class="size-3.5 shrink-0" :class="STATUS_CLASS[f.status]" />
              <span class="path min-w-0 flex-1 truncate font-mono" dir="rtl">
                <bdi>
                  <span class="text-dimmed">{{ splitPath(f.path).dir }}</span
                  ><span :class="viewed.has(f.path) ? '' : 'text-highlighted'">{{ splitPath(f.path).name }}</span>
                </bdi>
              </span>
              <span class="counts inline-flex shrink-0 gap-1 font-mono tabular-nums">
                <span v-if="f.binary" class="text-dimmed">bin</span>
                <template v-else>
                  <span class="text-ins">+{{ f.added }}</span>
                  <span class="text-del">−{{ f.deleted }}</span>
                </template>
              </span>
            </button>
            <label
              class="viewed-toggle flex shrink-0 cursor-pointer items-center"
              :title="viewed.has(f.path) ? 'Mark as not viewed' : 'Mark as viewed'"
            >
              <input
                type="checkbox"
                class="sr-only"
                :checked="viewed.has(f.path)"
                :aria-label="`Viewed: ${f.path}`"
                data-testid="file-entry-viewed"
                @change="emit('toggle-viewed', f.path)"
              />
              <UIcon
                :name="viewed.has(f.path) ? 'i-lucide-square-check' : 'i-lucide-square'"
                class="size-3.5"
                :class="viewed.has(f.path) ? 'text-ins' : 'text-dimmed'"
              />
            </label>
          </div>
        </li>
      </ol>
    </section>
  </nav>
</template>
