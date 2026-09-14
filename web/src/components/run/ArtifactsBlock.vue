<script setup lang="ts">
// The Files block (docs/reference/specs/live-view.md item 26): every file the run
// received from its thread or sent back, one row each in event order — the
// direction, the name (a link to the run's proxy route when the page has a
// store to serve from), the size and type. The four raster image types render
// inline under their row; everything else is a link the route downloads. An
// image whose object is gone (the route's 410) says so in the row instead of
// leaving a broken picture; a link to an expired file lands on the 410 text.
// Like the Reply, it sits first on a finished run's page and last on a live one.
import { computed, reactive } from "vue";
import type { TimelineArtifact } from "@core/channels/runTimeline.js";
import type { ArtifactsSeed } from "@core/channels/webSeed.js";
import { INLINE_IMAGE_TYPES } from "@core/artifacts/contentType.js";
import { formatBytes } from "../../lib/format";
import { artifactHref } from "../../lib/runPageModel";

const props = defineProps<{
  artifacts: TimelineArtifact[];
  /** Where the files are served from; null when no store is configured (rows are text). */
  links: ArtifactsSeed | null;
  /** `first` — under the Request, above the work; `last` — after the steps. */
  position: "first" | "last";
}>();

/** Keys whose image the browser could not load — the object expired. */
const expired = reactive(new Set<string>());

const rows = computed(() =>
  props.artifacts.map((a) => ({
    ...a,
    href: props.links ? artifactHref(props.links, a.key) : null,
    inline: INLINE_IMAGE_TYPES.has(a.contentType),
    expired: expired.has(a.key),
  })),
);
</script>

<template>
  <section
    id="artifacts"
    class="block rounded-lg border border-(--ui-border) bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
    :class="position === 'first' ? 'mb-4' : 'mt-6'"
    :data-position="position"
  >
    <h2 class="mb-2 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">
      <span>Files</span>
      <span class="count font-normal normal-case tracking-normal text-dimmed"
        >· {{ artifacts.length }} file{{ artifacts.length === 1 ? "" : "s" }}</span
      >
    </h2>
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
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
  </section>
</template>
