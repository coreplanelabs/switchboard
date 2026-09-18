<script setup lang="ts">
import { computed, ref, watch } from "vue";
import StatusDot from "../StatusDot.vue";
import { formatRelative, splitRunLabel } from "../../lib/format";
import {
  AGENT_HUE,
  agentHue,
  dotTip,
  elapsedText,
  runHref,
  safeSourceUrl,
  shortId,
  statusWord,
  SURFACE_NAME,
  surfaceOf,
} from "../../lib/indexRow";
import {
  bindingFor,
  diskHeadroom,
  RESIDENT_SLUG_RE,
  residentDisk,
  residentLive,
  residentSlug,
  residentStateTone,
  residentThreads,
  str,
  threadTreeKiB,
  type ResidentRecordView,
  type ResidentThreadView,
} from "@core/channels/residentsModel.js";
import { formatDiskGauge, formatGiB } from "@core/execution/residentDiskBudget.js";
import type { RunIndexRowSeed } from "@core/channels/webSeed.js";

// One resident on the index (resident-repos item 42): the row every glance
// reads — dot, slug, state, the pinned facts, how many runs are on it — and,
// folded open, the trees on it, one row each. A row reads left to right as the
// run · the tree it holds · the clock: the run side is words (agent chip, the
// request, who and where under it), the tree side a fixed-width monospace
// block (branch @ sha over user · deps · size) so rows align without column
// labels; an idle tree is a dimmed row with its last use in the run's place,
// and a run whose attach has not completed has no tree yet. Every value the
// resident reports lands as text; only a well-formed slug, a hex sha and an
// http(s) thread URL become links.

const props = defineProps<{
  record: ResidentRecordView;
  /** The live registry rows on this resident (`runsOnResident`), oldest first. */
  runs: RunIndexRowSeed[];
  now: number;
  /** Open on first paint (`?open=<slug>`). */
  open?: boolean;
}>();

const opened = ref(props.open === true);
watch(
  () => props.open,
  (o) => {
    if (o) opened.value = true;
  },
);
function onToggle(ev: Event): void {
  opened.value = (ev.target as HTMLDetailsElement).open;
}

const slug = computed(() => residentSlug(props.record));
const display = computed(() => slug.value || str(props.record.resource) || "?");
const live = computed(() => residentLive(props.record));
const tone = computed(() => residentStateTone(live.value.state));
const href = computed(() => (RESIDENT_SLUG_RE.test(slug.value) ? `/residents/${slug.value}` : null));
const ghRepo = computed(() => (RESIDENT_SLUG_RE.test(slug.value) ? `https://github.com/${slug.value}` : undefined));
const commitHref = (sha: string): string | undefined =>
  ghRepo.value && /^[0-9a-f]{7,40}$/.test(sha) ? `${ghRepo.value}/commit/${sha}` : undefined;

// The pinned facts: "refreshed 3 hours ago" reads in a second; the exact stamp rides the hover.
const ref_ = computed(() => str(props.record.defaultRef) || "?");
const sha = computed(() => str(live.value.sha).slice(0, 8));
const refreshed = computed(() => str(live.value.lastRefreshAt));
const relative = (iso: string): string => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? formatRelative(at, props.now) : iso || "—";
};
const refreshedLabel = computed(() => (refreshed.value ? relative(refreshed.value) : ""));

// Item 55: the last disk sample — the gauge on the row, the headroom in the fold.
const disk = computed(() => residentDisk(props.record));
const gauge = computed(() => (disk.value ? formatDiskGauge(disk.value) : ""));
const headroom = computed(() => {
  const d = disk.value;
  if (!d) return null;
  const budget = typeof props.record.diskBudgetMb === "number" ? props.record.diskBudgetMb : undefined;
  return diskHeadroom(d, budget);
});

/** The summary's facts as one line — joined here, so the separators keep
 *  their spaces (the template trims whitespace at its boundaries). */
const facts = computed(() =>
  [
    `ref ${ref_.value}`,
    sha.value,
    refreshedLabel.value ? `refreshed ${refreshedLabel.value}` : "",
    gauge.value ? `disk ${gauge.value}` : "",
  ]
    .filter(Boolean)
    .join(" · "),
);
const factsTip = computed(() =>
  [refreshed.value ? `refreshed ${refreshed.value}` : "", disk.value?.at ? `disk measured ${disk.value.at}` : ""]
    .filter(Boolean)
    .join(" · "),
);

/** The fold's one disk line: what is left, in the terms the admission decides on. */
const diskLine = computed(() => {
  const d = disk.value;
  const h = headroom.value;
  if (!d || !h) return "";
  const room =
    h.room.hardlink === null
      ? "room not projected (checkout not measured)"
      : `room for ${h.room.hardlink} more ${h.room.hardlink === 1 ? "tree" : "trees"}`;
  const free = `${formatGiB(h.freeKiB)} free${h.capped ? ` under the ${formatGiB(h.capacityKiB)} cap` : ""}`;
  return [free, room, `measured ${relative(d.at)}`].join(" · ");
});

const threads = computed(() => residentThreads(props.record));

/** One grid row: a run with the tree it holds, or an idle tree. */
interface TreeRow {
  key: string;
  run?: RunIndexRowSeed;
  agent?: string;
  /** The request (a run) or the idle word. */
  text: string;
  /** Who and where it came from (a run only). */
  who: string;
  surface: string;
  threadUrl: string;
  href: string;
  elapsed: string;
  binding?: ResidentThreadView;
  treeKiB: number | null;
}
const rows = computed<TreeRow[]>(() => {
  const lines: TreeRow[] = props.runs.map((run) => {
    const parts = splitRunLabel(run.label || shortId(run.id));
    const binding = bindingFor(threads.value, run.threadKey);
    const src = surfaceOf(run);
    return {
      key: `run:${run.id}`,
      run,
      agent: parts.agent,
      text: parts.snippet ?? parts.scope,
      who: src.identity,
      surface: SURFACE_NAME[src.kind] ?? src.kind,
      threadUrl: safeSourceUrl(run),
      href: runHref(run),
      elapsed: elapsedText(run, props.now),
      binding,
      treeKiB: binding ? threadTreeKiB(disk.value, binding.threadKey) : null,
    };
  });
  // The live bindings no run is using: trees held for a thread that may come back.
  const used = new Set(props.runs.map((r) => r.threadKey));
  for (const t of threads.value) {
    if (t.evicted || used.has(t.threadKey)) continue;
    lines.push({
      key: `idle:${t.threadKey}`,
      text: "idle",
      who: "",
      surface: "",
      threadUrl: "",
      href: "",
      elapsed: "",
      binding: t,
      treeKiB: threadTreeKiB(disk.value, t.threadKey),
    });
  }
  return lines;
});
const idleCount = computed(() => rows.value.filter((r) => !r.run).length);
</script>

<template>
  <li class="resident border-b border-muted first:border-t" :data-slug="slug" :data-running="runs.length">
    <details class="group/fold" :open="opened" @toggle="onToggle">
      <summary
        class="row flex cursor-pointer list-none flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-md px-2 py-2 hover:bg-elevated [&::-webkit-details-marker]:hidden"
      >
        <span
          class="chev w-3 select-none self-center text-xs text-dimmed transition-transform group-open/fold:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
          >❯</span
        >
        <span class="self-center"><StatusDot :tone="tone" :label="live.state" :tip="live.state" /></span>
        <span class="font-mono text-[0.9375rem] font-medium text-highlighted">{{ display }}</span>
        <span class="text-sm text-toned">{{ live.state }}</span>
        <span
          v-if="runs.length > 0"
          class="running shrink-0 rounded border border-ok/25 bg-ok/8 px-1.5 font-mono text-[0.68rem] font-medium tabular-nums text-ok"
          >{{ runs.length }} running</span
        >
        <!-- The facts wrap to their own indented line on a phone instead of
             breaking mid-token at the left edge. -->
        <span
          class="facts font-mono text-xs text-muted max-sm:basis-full max-sm:pl-[1.9rem] sm:ml-2"
          :title="factsTip || undefined"
          >{{ facts }}</span
        >
        <RouterLink
          v-if="href"
          class="detail ml-auto shrink-0 text-xs text-muted no-underline hover:text-highlighted hover:underline"
          :to="href"
          @click.stop
          >detail ↗</RouterLink
        >
        <span v-if="live.reason" class="basis-full pl-[1.9rem] text-xs text-warn">{{ live.reason }}</span>
      </summary>

      <div class="fold pb-3 pl-[1.9rem] pr-2 pt-0.5">
        <ul v-if="rows.length > 0" class="m-0 list-none divide-y divide-(--ui-border-muted) p-0">
          <!-- Each row reads left to right: the run · the tree it holds · the
               clock. The run side is words (chip, request, who and where under
               it); the tree side is a fixed-width monospace block (branch @ sha
               over user · deps · size) so rows align without column labels. -->
          <li
            v-for="row in rows"
            :key="row.key"
            class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(14rem,22rem)_auto]"
            :class="row.run ? 'run' : 'idle'"
            :data-run-id="row.run?.id"
            :data-thread="row.run ? undefined : row.binding?.threadKey"
          >
            <span class="pt-[0.3rem]">
              <StatusDot v-if="row.run" tone="green" :label="statusWord(row.run)" :tip="dotTip(row.run)" pulse />
              <StatusDot v-else tone="grey" label="idle" tip="no run is using this tree" />
            </span>

            <!-- the run: what, then who and where -->
            <span class="what min-w-0">
              <span class="flex min-w-0 items-baseline gap-2">
                <span
                  v-if="row.agent"
                  class="agent shrink-0 rounded border px-1.5 font-mono text-[0.65rem] font-medium uppercase tracking-wider"
                  :class="AGENT_HUE[agentHue(row.agent)]"
                  >{{ row.agent }}</span
                >
                <span
                  class="text min-w-0 truncate text-[0.8125rem]"
                  :class="row.run ? 'text-highlighted' : 'text-dimmed'"
                  :title="row.run ? row.text : undefined"
                  >{{ row.text }}</span
                >
              </span>
              <span v-if="row.run" class="who block truncate text-xs text-dimmed">
                <template v-if="row.who">by {{ row.who }}</template>
                <template v-if="row.who && (row.threadUrl || row.surface)">{{ " · " }}</template>
                <a
                  v-if="row.threadUrl"
                  class="text-muted no-underline hover:text-highlighted hover:underline"
                  :href="row.threadUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ row.surface }} thread ↗</a
                >
                <template v-else-if="row.surface">via {{ row.surface }}</template>
              </span>
              <span v-else-if="row.binding" class="who block text-xs text-dimmed"
                >last used {{ relative(row.binding.lastAttachAt) }}</span
              >
            </span>

            <!-- the tree: branch @ sha, then user · deps · size -->
            <span class="min-w-0 font-mono text-xs max-sm:col-span-2 max-sm:col-start-2 max-sm:row-start-2">
              <span
                class="tree block truncate text-toned"
                :title="row.binding ? row.binding.ref || undefined : undefined"
              >
                <template v-if="row.binding">
                  {{ row.binding.ref || "?"
                  }}<template v-if="row.binding.sha">
                    {{ " " }}<span class="text-dimmed">@</span>{{ " " }}
                    <a
                      v-if="commitHref(row.binding.sha)"
                      class="text-highlighted no-underline hover:underline"
                      :href="commitHref(row.binding.sha)"
                      >{{ row.binding.sha.slice(0, 8) }}</a
                    >
                    <span v-else>{{ row.binding.sha.slice(0, 8) }}</span>
                  </template>
                </template>
                <span v-else class="font-sans text-dimmed">no worktree bound yet</span>
              </span>
              <span v-if="row.binding" class="facts-tree block truncate text-dimmed">
                <span class="user">{{ row.binding.user || "—" }}</span>
                {{ " · " }}<span class="deps">{{ row.binding.deps || "—" }}</span> {{ " · "
                }}<span
                  class="size"
                  :class="row.treeKiB !== null ? 'text-muted' : ''"
                  :title="row.treeKiB !== null ? 'on disk' : 'size not measured yet'"
                  >{{ row.treeKiB !== null ? formatGiB(row.treeKiB) : "—" }}</span
                >
              </span>
            </span>
            <!-- the clock: the run's stopwatch and its page; nothing for an idle tree -->
            <span class="flex items-baseline gap-3 justify-self-end max-sm:col-start-3 max-sm:row-start-1">
              <span
                v-if="row.run"
                class="elapsed whitespace-nowrap font-mono text-xs tabular-nums text-ok"
                :title="`running for · started ${formatRelative(row.run.startedAt, now)}`"
                >{{ row.elapsed }}</span
              >
              <RouterLink
                v-if="row.run"
                class="open text-xs text-muted no-underline hover:text-highlighted hover:underline"
                :to="row.href"
                :aria-label="`open run ${row.run.label || shortId(row.run.id)}`"
                >open ↗</RouterLink
              >
            </span>
          </li>
        </ul>
        <p v-else class="py-1 text-xs text-dimmed">nothing on this resident — no run, no worktree</p>

        <p class="disk mt-2 font-mono text-xs text-dimmed" :data-idle="idleCount">
          <template v-if="diskLine">{{ diskLine }}</template>
          <span v-else>disk not measured yet</span>
        </p>
      </div>
    </details>
  </li>
</template>
