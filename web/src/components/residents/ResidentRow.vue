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
// folded open, what is on it right now: each live run with its stopwatch and
// its link, joined by thread key to the worktree the resident bound for it
// (ref, commit, OS user, how the deps got there, the tree's own bytes), then
// the trees no run is using, then the disk and the room left on it. Every
// value the resident reports lands as text; only a well-formed slug, a hex sha
// and an http(s) thread URL become links.

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
const refreshedLabel = computed(() => {
  const at = refreshed.value ? Date.parse(refreshed.value) : Number.NaN;
  return Number.isFinite(at) ? formatRelative(at, props.now) : refreshed.value;
});
const relative = (iso: string): string => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? formatRelative(at, props.now) : iso || "—";
};

// Item 55: the last disk sample — the gauge on the row, the headroom in the fold.
const disk = computed(() => residentDisk(props.record));
const gauge = computed(() => (disk.value ? formatDiskGauge(disk.value) : ""));
const headroom = computed(() => {
  const d = disk.value;
  if (!d) return null;
  const budget = typeof props.record.diskBudgetMb === "number" ? props.record.diskBudgetMb : undefined;
  return diskHeadroom(d, budget);
});

const threads = computed(() => residentThreads(props.record));

interface RunLine {
  run: RunIndexRowSeed;
  agent?: string;
  text: string;
  elapsed: string;
  since: string;
  who: string;
  surface: string;
  href: string;
  threadUrl: string;
  binding?: ResidentThreadView;
  treeKiB: number | null;
}
const runLines = computed<RunLine[]>(() =>
  props.runs.map((run) => {
    const parts = splitRunLabel(run.label || shortId(run.id));
    const binding = bindingFor(threads.value, run.threadKey);
    const src = surfaceOf(run);
    return {
      run,
      agent: parts.agent,
      text: parts.snippet ?? parts.scope,
      elapsed: elapsedText(run, props.now),
      since: formatRelative(run.startedAt, props.now),
      who: src.identity,
      surface: SURFACE_NAME[src.kind] ?? src.kind,
      href: runHref(run),
      threadUrl: safeSourceUrl(run),
      binding,
      treeKiB: binding ? threadTreeKiB(disk.value, binding.threadKey) : null,
    };
  }),
);

/** The live bindings no run is using: trees held for a thread that may come back. */
const idle = computed(() => {
  const used = new Set(props.runs.map((r) => r.threadKey));
  return threads.value.filter((t) => !t.evicted && !used.has(t.threadKey));
});

const roomText = computed(() => {
  const h = headroom.value;
  if (!h) return "";
  if (h.room.hardlink === null) return "room not projected (checkout not measured)";
  return `room for ${h.room.hardlink} more ${h.room.hardlink === 1 ? "tree" : "trees"}`;
});
</script>

<template>
  <li class="resident border-b border-muted first:border-t" :data-slug="slug" :data-running="runs.length">
    <details class="group/fold" :open="opened" @toggle="onToggle">
      <summary
        class="row flex cursor-pointer list-none flex-wrap items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-elevated [&::-webkit-details-marker]:hidden"
      >
        <span
          class="chev select-none text-xs text-dimmed transition-transform group-open/fold:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
          >❯</span
        >
        <StatusDot :tone="tone" :label="live.state" :tip="live.state" />
        <span class="font-mono font-medium text-primary">{{ display }}</span>
        <span class="font-medium">{{ live.state }}</span>
        <span
          v-if="runs.length > 0"
          class="running shrink-0 rounded border border-ok/25 bg-ok/8 px-1.5 font-mono text-[0.7rem] font-medium tabular-nums text-ok"
          >{{ runs.length }} running</span
        >
        <!-- The facts wrap to their own indented line on a phone instead of
             breaking mid-token at the left edge. -->
        <span class="facts font-mono text-xs text-muted max-sm:basis-full max-sm:pl-5" :title="refreshed || undefined">
          ref {{ ref_ }}<template v-if="sha"> · sha {{ sha }}</template
          ><template v-if="refreshedLabel"> · refreshed {{ refreshedLabel }}</template
          ><template v-if="gauge">
            · <span :title="disk?.at ? `measured ${disk.at}` : undefined">disk {{ gauge }}</span></template
          >
        </span>
        <a
          v-if="href"
          class="detail ml-auto shrink-0 font-mono text-xs text-primary no-underline hover:underline"
          :href="href"
          @click.stop
          >detail ↗</a
        >
        <span v-if="live.reason" class="basis-full pl-5 text-xs text-warn">{{ live.reason }}</span>
      </summary>

      <div class="fold pb-3 pl-7 pr-2 pt-1">
        <p class="mb-1 font-mono text-[0.7rem] uppercase tracking-wider text-muted">
          running <span class="tabular-nums">{{ runs.length }}</span>
        </p>
        <ul v-if="runLines.length > 0" class="m-0 list-none p-0">
          <li
            v-for="line in runLines"
            :key="line.run.id"
            class="run flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1"
            :data-run-id="line.run.id"
          >
            <StatusDot tone="green" :label="statusWord(line.run)" :tip="dotTip(line.run)" pulse />
            <span
              v-if="line.agent"
              class="agent shrink-0 rounded border px-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-wider"
              :class="AGENT_HUE[agentHue(line.agent)]"
              >{{ line.agent }}</span
            >
            <span class="text min-w-0 flex-1 truncate text-toned">{{ line.text }}</span>
            <span class="elapsed shrink-0 font-mono text-xs tabular-nums text-ok" title="running for">{{
              line.elapsed
            }}</span>
            <a
              class="open shrink-0 font-mono text-xs text-primary no-underline hover:underline"
              :href="line.href"
              :aria-label="`open run ${line.run.label || shortId(line.run.id)}`"
              >open ↗</a
            >
            <span class="tree basis-full pl-5 font-mono text-xs text-muted">
              <template v-if="line.binding">
                worktree {{ line.binding.ref || "?" }}
                <template v-if="line.binding.sha">
                  @
                  <a v-if="commitHref(line.binding.sha)" class="text-primary" :href="commitHref(line.binding.sha)">{{
                    line.binding.sha.slice(0, 8)
                  }}</a>
                  <span v-else>{{ line.binding.sha.slice(0, 8) }}</span>
                </template>
                <template v-if="line.binding.user"> · {{ line.binding.user }}</template>
                <template v-if="line.binding.deps"> · deps {{ line.binding.deps }}</template>
                ·
                <span v-if="line.treeKiB !== null">{{ formatGiB(line.treeKiB) }} on disk</span>
                <span v-else class="text-dimmed">size not measured yet</span>
              </template>
              <span v-else class="text-dimmed">no worktree bound yet</span>
              · started {{ line.since }}<template v-if="line.who"> by {{ line.who }}</template>
              ·
              <a
                v-if="line.threadUrl"
                class="text-primary no-underline hover:underline"
                :href="line.threadUrl"
                target="_blank"
                rel="noopener noreferrer"
                >{{ line.surface }} thread ↗</a
              >
              <span v-else>via {{ line.surface }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-xs text-dimmed">nothing running on this resident</p>

        <template v-if="idle.length > 0">
          <p class="mb-1 mt-2 font-mono text-[0.7rem] uppercase tracking-wider text-muted">
            idle worktrees <span class="tabular-nums">{{ idle.length }}</span>
          </p>
          <ul class="m-0 list-none p-0">
            <li
              v-for="t in idle"
              :key="t.threadKey"
              class="idle py-0.5 font-mono text-xs text-muted"
              :data-thread="t.threadKey"
            >
              {{ t.ref || "?" }}
              <template v-if="t.sha">
                @
                <a v-if="commitHref(t.sha)" class="text-primary" :href="commitHref(t.sha)">{{ t.sha.slice(0, 8) }}</a>
                <span v-else>{{ t.sha.slice(0, 8) }}</span>
              </template>
              <template v-if="t.user"> · {{ t.user }}</template>
              <template v-if="t.deps"> · deps {{ t.deps }}</template>
              ·
              <span v-if="threadTreeKiB(disk, t.threadKey) !== null"
                >{{ formatGiB(threadTreeKiB(disk, t.threadKey)) }} on disk</span
              >
              <span v-else class="text-dimmed">size not measured yet</span>
              · last used {{ relative(t.lastAttachAt) }}
            </li>
          </ul>
        </template>

        <p class="disk mt-2 font-mono text-xs text-muted">
          <template v-if="disk && headroom">
            disk {{ gauge }} · {{ formatGiB(headroom.freeKiB) }} free<template v-if="headroom.capped">
              under the {{ formatGiB(headroom.capacityKiB) }} cap</template
            >
            · {{ roomText }} · measured {{ relative(disk.at) }}
          </template>
          <span v-else class="text-dimmed">disk not measured yet</span>
        </p>
      </div>
    </details>
  </li>
</template>
