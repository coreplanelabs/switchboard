<script setup lang="ts">
// The files of one message (docs/reference/specs/live-view.md item 26): nested
// inside the card of the message they arrived on or left with — the Request,
// a Follow-up, the Reply, and on a live page the `attach_file` call that sent
// them — one row each in event order: the direction word, the name (a link to
// the run's proxy route when the page has a store to serve from), the size
// and type. The four raster image types render inline under their row;
// everything else is a link the route downloads. An image whose object is
// gone (the route's 410) says so in the row instead of leaving a broken
// picture; a link to an expired file lands on the 410 text. `preview: false`
// keeps the rows and drops the picture — the call card's compact form once
// the Reply carries the same files.
import { computed, inject, reactive } from "vue";
import type { TimelineArtifact } from "@core/channels/runTimeline.js";
import { INLINE_IMAGE_TYPES } from "@core/artifacts/contentType.js";
import { formatBytes } from "../../lib/format";
import { ArtifactLinksKey, artifactHref } from "../../lib/runPageModel";

const props = withDefaults(
  defineProps<{
    files: TimelineArtifact[];
    /** True renders a raster image under its row; false keeps the row alone. */
    preview?: boolean;
  }>(),
  { preview: true },
);

/** Where the files are served from; null when no store is configured (rows are text). */
const links = inject(ArtifactLinksKey, null);

/** Keys whose image the browser could not load — the object expired. */
const expired = reactive(new Set<string>());

const rows = computed(() =>
  props.files.map((a) => ({
    ...a,
    href: links ? artifactHref(links, a.key) : null,
    inline: props.preview && INLINE_IMAGE_TYPES.has(a.contentType),
    expired: expired.has(a.key),
  })),
);
</script>

<template>
  <div class="files mt-3 border-t border-(--ui-border) pt-2" :data-preview="preview ? '1' : '0'">
    <h3
      class="mb-1.5 flex items-baseline gap-2 font-mono text-[0.68rem] font-medium uppercase tracking-wider text-dimmed"
    >
      <span>Files</span>
      <span class="count font-normal normal-case tracking-normal"
        >· {{ files.length }} file{{ files.length === 1 ? "" : "s" }}</span
      >
    </h3>
    <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
      <li
        v-for="row in rows"
        :key="row.key"
        class="artifact"
        :data-direction="row.direction"
        :data-expired="row.expired ? '1' : '0'"
      >
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 font-mono text-xs">
          <span
            class="dir shrink-0 select-none text-dimmed"
            :title="row.direction === 'out' ? 'sent by the run' : 'received from the thread'"
            >{{ row.direction === "out" ? "↑ sent" : "↓ received" }}</span
          >
          <a
            v-if="row.href && !row.expired"
            class="name font-medium text-primary no-underline hover:underline"
            :href="row.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ row.name }}</a
          >
          <span v-else class="name font-medium text-toned">{{ row.name }}</span>
          <span class="fact text-dimmed">{{ formatBytes(row.size) }}</span>
          <span class="fact text-dimmed">{{ row.contentType }}</span>
          <span v-if="row.expired && links" class="expired text-warn"
            >expired after {{ links.retentionDays }} days</span
          >
        </div>
        <img
          v-if="row.inline && row.href && !row.expired"
          class="preview mt-1.5 max-h-96 max-w-full rounded border border-(--ui-border)"
          :src="row.href"
          :alt="row.name"
          loading="lazy"
          @error="expired.add(row.key)"
        />
      </li>
    </ul>
  </div>
</template>
