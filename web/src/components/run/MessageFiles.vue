<script lang="ts">
/** Lists mounted so far, across the page: each list numbers its panels' ids
 *  from its own count, so two lists holding one file never share an id. */
let listsMounted = 0;
</script>

<script setup lang="ts">
// The files of one message (docs/reference/specs/live-view.md item 26): nested
// inside the card of the message they arrived on or left with — the Request,
// a Follow-up, the Reply, and on a live page the `attach_file` call that sent
// them — one row each in event order: the direction word, the name, the size
// and type. The name is a disclosure, never a link: it opens a panel under the
// row that renders the file where it was sent or received — a raster image as
// a picture, a video or audio file as a player, a text file as its first 64 KB,
// anything else as its facts with one explicit Download action (the only place
// a download exists). Raster images start open, everything else closed, so a
// large video loads nothing until asked. A file the route no longer serves
// (its 410) reads `expired after N days` in place of the panel. `openImages:
// false` starts every row closed — the call card's compact form once the
// Reply carries the same files.
import { computed, inject, reactive, watch } from "vue";
import type { TimelineArtifact } from "@core/channels/runTimeline.js";
import { formatBytes } from "../../lib/format";
import { TEXT_PREVIEW_CAP, previewKindOf, type PreviewKind } from "../../lib/filePreview";
import { ArtifactLinksKey, artifactHref } from "../../lib/runPageModel";

const props = withDefaults(
  defineProps<{
    files: TimelineArtifact[];
    /** True starts a raster image's row open (the picture shows at once); false starts every row closed. */
    openImages?: boolean;
  }>(),
  { openImages: true },
);

/** Where the files are served from; null when no store is configured (rows are text). */
const links = inject(ArtifactLinksKey, null);

/** Keys whose file the browser could not load — the object expired. */
const expired = reactive(new Set<string>());
/** Keys whose panel is open. Seeded from the props; toggled by the name. */
const open = reactive(new Set<string>());
/** Keys whose panel has been opened at least once: its content stays mounted
 *  so a close animates, and a video is fetched only after its first open. */
const mounted = reactive(new Set<string>());
/** Text previews by key: the text read so far, whether it was cut at the cap, or the failure. */
const texts = reactive(new Map<string, { text: string; truncated: boolean; error?: string }>());

function seedOpen(): void {
  for (const a of props.files) {
    if (props.openImages && previewKindOf(a.contentType) === "image" && !open.has(a.key) && !mounted.has(a.key)) {
      open.add(a.key);
      mounted.add(a.key);
    }
  }
}
seedOpen();
// The array itself and its length: a file appended in place and a replaced
// list both re-seed.
watch(() => [props.files, props.files.length] as const, seedOpen);

/** This list's own id: the same file renders in two lists at once (the
 *  attach call's card and the Reply), so a panel's id is per list, per row. */
listsMounted += 1;
const listId = `files-${listsMounted}`;

const rows = computed(() =>
  props.files.map((a, i) => ({
    ...a,
    href: links ? artifactHref(links, a.key) : null,
    kind: previewKindOf(a.contentType),
    open: open.has(a.key),
    mounted: mounted.has(a.key),
    expired: expired.has(a.key),
    panelId: `${listId}-file-${i}`,
  })),
);

function toggle(row: { key: string; kind: PreviewKind; href: string | null; expired: boolean }): void {
  if (!row.href || row.expired) return;
  if (open.has(row.key)) {
    open.delete(row.key);
    return;
  }
  open.add(row.key);
  mounted.add(row.key);
  if (row.kind === "text" && !texts.has(row.key)) void loadText(row.key, row.href);
}

/** The first `TEXT_PREVIEW_CAP` bytes of a text file, read from the route and
 *  cancelled past the cap — the panel never holds a whole log. */
async function loadText(key: string, href: string): Promise<void> {
  texts.set(key, { text: "", truncated: false });
  try {
    const res = await fetch(href, { credentials: "same-origin" });
    if (res.status === 410) {
      expired.add(key);
      texts.delete(key);
      return;
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let truncated = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // The cap is in BYTES, as the line under the text says: only the bytes
      // that fit are decoded, so multi-byte text is not overstated.
      const room = TEXT_PREVIEW_CAP - bytes;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      text += decoder.decode(chunk, { stream: true });
      bytes += chunk.byteLength;
      if (bytes >= TEXT_PREVIEW_CAP) {
        truncated = value.byteLength > room || !(await reader.read()).done;
        await reader.cancel();
        break;
      }
    }
    texts.set(key, { text, truncated });
  } catch (err) {
    texts.set(key, { text: "", truncated: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** A media element that could not load: the object is gone (the route's 410). */
function mediaFailed(key: string): void {
  expired.add(key);
  open.delete(key);
}

const directionWord = (direction: "in" | "out") => (direction === "out" ? "↑ sent" : "↓ received");
const directionTitle = (direction: "in" | "out") =>
  direction === "out" ? "sent by the run" : "received from the thread";
</script>

<template>
  <div class="files mt-3 border-t border-(--ui-border) pt-2" :data-open-images="openImages ? '1' : '0'">
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
        :data-kind="row.kind"
        :data-open="row.open ? '1' : '0'"
        :data-expired="row.expired ? '1' : '0'"
      >
        <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 font-mono text-xs">
          <span class="dir shrink-0 select-none text-dimmed" :title="directionTitle(row.direction)">{{
            directionWord(row.direction)
          }}</span>
          <!-- The name opens the file where it sits; the chevron leads, as on
               every other fold of the page. Without a route (no store) or for
               an expired file there is nothing to open, and the name is text. -->
          <button
            v-if="row.href && !row.expired"
            type="button"
            class="name flex cursor-pointer items-baseline gap-1.5 border-0 bg-transparent p-0 font-mono text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            :aria-expanded="row.open ? 'true' : 'false'"
            :aria-controls="row.panelId"
            @click="toggle(row)"
          >
            <span
              class="chev inline-block select-none text-[0.65rem] text-dimmed transition-transform motion-reduce:transition-none"
              :class="row.open ? 'rotate-90' : ''"
              aria-hidden="true"
              >❯</span
            >
            <span>{{ row.name }}</span>
          </button>
          <span v-else class="name font-medium text-toned">{{ row.name }}</span>
          <span class="fact text-dimmed">{{ formatBytes(row.size) }}</span>
          <span class="fact text-dimmed">{{ row.contentType }}</span>
          <span v-if="row.expired && links" class="expired text-warn"
            >expired after {{ links.retentionDays }} days</span
          >
        </div>
        <!-- The panel: a one-row grid whose row grows from 0fr to 1fr, so the
             open and close animate at whatever height the content takes. -->
        <div
          v-if="row.href && !row.expired"
          :id="row.panelId"
          class="panel grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
          :style="{ gridTemplateRows: row.open ? '1fr' : '0fr' }"
          :aria-hidden="row.open ? 'false' : 'true'"
        >
          <div class="min-h-0 overflow-hidden">
            <template v-if="row.mounted">
              <img
                v-if="row.kind === 'image'"
                class="preview mt-1.5 max-h-96 max-w-full rounded border border-(--ui-border)"
                :src="row.href"
                :alt="row.name"
                loading="lazy"
                @error="mediaFailed(row.key)"
              />
              <!-- A run's own recording; the record carries no captions to offer. -->
              <video
                v-else-if="row.kind === 'video'"
                class="preview mt-1.5 max-h-96 max-w-full rounded border border-(--ui-border) bg-black"
                :src="row.href"
                controls
                playsinline
                preload="auto"
                @error="mediaFailed(row.key)"
              />
              <audio
                v-else-if="row.kind === 'audio'"
                class="preview mt-1.5 w-full max-w-xl"
                :src="row.href"
                controls
                preload="auto"
                @error="mediaFailed(row.key)"
              />
              <div v-else-if="row.kind === 'text'" class="mt-1.5">
                <pre
                  v-if="texts.get(row.key) && !texts.get(row.key)!.error"
                  class="text max-h-96 overflow-auto rounded border border-(--ui-border) bg-elevated p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-toned"
                  >{{ texts.get(row.key)!.text }}</pre>
                <p v-if="texts.get(row.key)?.error" class="text-xs text-bad">
                  could not read the file: {{ texts.get(row.key)!.error }}
                </p>
                <p v-else-if="texts.get(row.key)?.truncated" class="mt-1 text-xs text-dimmed">
                  showing the first {{ formatBytes(TEXT_PREVIEW_CAP) }} of {{ formatBytes(row.size) }}
                </p>
              </div>
              <div
                v-else
                class="other mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs text-dimmed"
              >
                <span>no preview for {{ row.contentType }}</span>
                <a
                  class="download inline-block rounded border border-default px-2 py-0.5 font-medium text-toned no-underline hover:bg-accented hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                  :href="row.href"
                  :download="row.name"
                  >Download {{ formatBytes(row.size) }}</a
                >
              </div>
            </template>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
