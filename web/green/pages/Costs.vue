<script setup lang="ts">
defineOptions({ name: "GreenCostsPage" });
import { MINUTE_MS } from "@core/core/budgets.js";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { CostWorkReport } from "@core/core/costsService.js";
import type { CostReport } from "@core/core/costs.js";
import type { CostsByReport } from "@core/core/costsBy.js";
import type { CostsSnapshotStatus } from "@core/core/costsSnapshot.js";
import type { CostsView } from "@core/channels/costsView.js";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import StatTiles from "../components/StatTiles.vue";
import CostChart from "../../src/components/costs/CostChart.vue";
import ShipSpendChart from "../../src/components/costs/ShipSpendChart.vue";
import CostsByDimension from "../../src/components/costs/CostsByDimension.vue";
import { useEventSourceFactory, type EventSourceLike } from "../../src/lib/eventSource";
import { useSeed } from "../../src/lib/seed";
import { postCommand } from "../../src/lib/settingsApi";
import { useWallClock } from "../../src/lib/wallClock";
import {
  accountLabelOf,
  chartModelOf,
  DO_LABEL,
  linksOf,
  LLM_LABEL,
  parseStatusFrame,
  PLATFORM_LABEL,
  resourceSplitOf,
  seriesOf,
  SERIES_SWATCH,
  snapshotLineOf,
  tilesOf,
  usd,
  valueOf,
} from "../../src/lib/costs";

// The spend dashboard: what a group of deployed pieces costs per day, every
// figure from the costs snapshot (costs.md item 6) — both billing sources read
// on the snapshot's interval or on request, never in a page load. The status
// line under the range names the snapshot the page shows, its age and when the
// next is due; before the first one lands the page shows that line alone. Same
// shell and tokens as every other page (the old costs page was the one
// light/sans outlier).

const seed = useSeed("costs");
/** The report and the open dimension's report start as the seed's and are replaced when a new snapshot lands (below). */
const report = ref<CostReport | null>(seed?.report ?? null);
const work = ref<CostWorkReport | null>(seed?.work ?? null);
const workRows = computed(() => (work.value?.completeness === "unavailable" ? [] : (work.value?.rows ?? [])));
const workDays = computed(() =>
  work.value?.completeness === "unavailable"
    ? []
    : [...(work.value?.days ?? [])].sort((a, b) => b.day.localeCompare(a.day) || a.key.localeCompare(b.key)),
);
const knownModelSpend = computed(() => workRows.value.reduce((sum, row) => sum + row.llmUsd, 0));
const unpricedWorkTokens = computed(() => workRows.value.reduce((sum, row) => sum + row.unpricedTokens, 0));
const workTiles = computed(() =>
  !work.value || work.value.completeness === "unavailable"
    ? []
    : [
        {
          label: "Known model spend",
          value:
            knownModelSpend.value > 0 || (work.value.completeness === "complete" && !unpricedWorkTokens.value)
              ? usd(knownModelSpend.value)
              : "—",
          note: "Recorded model usage only. Unpriced tokens are excluded.",
        },
      ],
);
const workUnits = computed(() =>
  work.value?.unitSpendStatus === "unavailable" ? [] : (work.value?.shipSpend?.units ?? []),
);
const workUnitKey = ref("");
const selectedWorkUnit = computed(
  () => workUnits.value.find((unit) => unit.key === workUnitKey.value) ?? workUnits.value[0],
);
const selectedRange = computed(() => work.value?.range.days ?? report.value?.range.days ?? 7);
const selectedShipKey = ref("");
const shipUnits = computed(() => report.value?.shipSpend?.units ?? []);
const shipKey = computed({
  get: () => shipUnits.value.find((unit) => unit.key === selectedShipKey.value)?.key ?? shipUnits.value[0]?.key ?? "",
  set: (key: string) => {
    selectedShipKey.value = key;
  },
});
const selectedShipUnit = computed(() => shipUnits.value.find((unit) => unit.key === shipKey.value));
const groups = computed(() => seed?.groups ?? []);
/** The group the page is for — from the seed even when there is no report yet to name it. */
const group = computed(() => seed?.group ?? report.value?.group ?? "");
/** The snapshot's status: its stamp, a take in flight, when the next is due — the seed's first, then the feed's. */
const status = ref<CostsSnapshotStatus | null>(seed?.snapshot ?? null);
/** The snapshot's age ticks by the minute while the page is open. */
const now = useWallClock(undefined, MINUTE_MS);
const snapshotLine = computed(() => (status.value ? snapshotLineOf(status.value, now.value) : ""));
/** Which tab is open: the daily tables, or a cost dimension (`?view=users|threads|channels|agents|models`,
 *  that dimension's report riding along in the seed). */
const view = computed<CostsView>(() => seed?.view ?? "daily");
const by = ref<CostsByReport | null>(seed && seed.view !== "daily" ? (seed.by ?? null) : null);
/** The tabs above the tables, in order: the daily tables, then one per cost dimension (costs.md item 10a). */
const VIEWS: ReadonlyArray<{ view: CostsView; tab: string; subtitle: string }> = [
  { view: "daily", tab: "Daily", subtitle: "" },
  {
    view: "users",
    tab: "By user",
    subtitle: "Who started the runs · LLM from their tokens through the price table · cloud allocated by wall-clock",
  },
  {
    view: "threads",
    tab: "By thread",
    subtitle:
      "The thread each run ran in · LLM from its tokens through the price table · cloud allocated by wall-clock",
  },
  {
    view: "channels",
    tab: "By channel",
    subtitle:
      "The channel each run ran in · LLM from its tokens through the price table · cloud allocated by wall-clock",
  },
  {
    view: "agents",
    tab: "By agent",
    subtitle: "The agent each run ran on · LLM from its tokens through the price table · cloud allocated by wall-clock",
  },
  {
    view: "models",
    tab: "By model",
    subtitle: "The model each turn ran on · LLM from its tokens through the price table · cloud is not split by model",
  },
];
const currentView = computed(() => VIEWS.find((v) => v.view === view.value) ?? VIEWS[0]);

// The status feed (costs.md item 8b): `/costs/<group>?stream=1` streams the
// snapshot's status — a take starting, landing or failing — so every viewer
// sees the line move without reloading. When a new snapshot lands (its
// `takenAt` differs from the one the figures came from) the page re-reads its
// JSON twins for the range it shows and repaints; the tiles never go blank.
const canSnapshot = computed(() => !work.value && seed?.canSnapshot === true);
const daysParam = computed(() =>
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("days"),
);
const twinUrl = (path: string) => `/costs/${group.value}${path}${daysParam.value ? `?days=${daysParam.value}` : ""}`;
/** The stamp the figures on screen were built from, and the newest stamp the feed has announced. */
let shownTakenAt: string | null = seed?.snapshot?.snapshot?.takenAt ?? null;
let announcedTakenAt: string | null = shownTakenAt;
let refetching: Promise<void> | null = null;
/** Re-read the twins; true when the daily report was replaced. A failure leaves the figures as they were. */
async function refetchReports(): Promise<boolean> {
  try {
    const [daily, dimension] = await Promise.all([
      fetch(twinUrl(".json"), { credentials: "same-origin" }),
      view.value !== "daily"
        ? fetch(twinUrl(`/${view.value}.json`), { credentials: "same-origin" })
        : Promise.resolve(null),
    ]);
    if (!daily.ok) return false;
    report.value = (await daily.json()) as CostReport;
    if (dimension?.ok) by.value = (await dimension.json()) as CostsByReport;
    return true;
  } catch {
    return false;
  }
}
/** Bring the figures up to the announced stamp: one re-read at a time, keyed on the stamp it is
 *  for — a snapshot landing while a re-read is in flight is re-read after it (the earlier read may
 *  have been served before it landed), and a failed re-read leaves the shown stamp behind so the
 *  next frame retries rather than looping here. */
function reconcile(): void {
  if (refetching || announcedTakenAt === null || announcedTakenAt === shownTakenAt) return;
  const stamp = announcedTakenAt;
  refetching = refetchReports()
    .then((ok) => {
      if (ok) shownTakenAt = stamp;
    })
    .finally(() => {
      refetching = null;
      if (announcedTakenAt !== stamp) reconcile();
    });
}
function onStatus(next: CostsSnapshotStatus): void {
  status.value = next;
  const landed = next.snapshot?.takenAt ?? null;
  if (landed) {
    announcedTakenAt = landed;
    reconcile();
  }
}
const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;
onMounted(() => {
  if (!group.value || work.value) return;
  es = makeEventSource(`/costs/${group.value}?stream=1`);
  es.onmessage = (m) => {
    const frame = parseStatusFrame(m.data);
    if (frame) onStatus(frame);
  };
});
onUnmounted(() => es?.close());

// **Snapshot now** (`costs:write` holders): posts the command the CLI and chat
// run; the feed shows the take to everyone, this button only reports a refusal.
const taking = ref(false);
const takeError = ref("");
async function takeSnapshot(): Promise<void> {
  taking.value = true;
  takeError.value = "";
  const answer = await postCommand(fetch, "costs.snapshot", {});
  if (!answer.ok) takeError.value = answer.failure.message;
  taking.value = false;
}
/** The same page for another group, range or tab — the two other pills keep the third. */
function hrefOf(group: string, days: number, v: CostsView): string {
  const q = [`days=${days}`];
  if (v !== "daily") q.push(`view=${v}`);
  return `/costs/${group}?${q.join("&")}`;
}
const downloadHref = computed(
  () =>
    `/costs/${group.value}${view.value === "daily" ? ".json" : `/${view.value}.json`}${work.value || report.value ? `?days=${selectedRange.value}` : ""}`,
);
const series = computed(() => (report.value ? seriesOf(report.value) : []));
const chartModel = computed(() => (report.value ? chartModelOf(report.value, series.value) : null));
const tiles = computed(() => (report.value ? tilesOf(report.value) : null));
const split = computed(() => (report.value ? resourceSplitOf(report.value) : []));
const links = computed(() => (report.value ? linksOf(report.value) : null));
const accountLabel = computed(() => (report.value ? accountLabelOf(report.value) : ""));

/** Where a split row's meter is billed and can be dug into on the dashboard. */
function splitLink(label: string): string | undefined {
  const l = links.value;
  if (!l) return undefined;
  if (/^(Memory|vCPU|Disk)/.test(label)) return l.containers;
  if (label.startsWith("Durable Object")) return l.durableObjects;
  if (label.startsWith("Workers")) return l.workers;
  if (label.startsWith("R2")) return l.r2;
  if (label.startsWith("Workflow")) return l.workflows;
  return undefined;
}

/** Where a chart series is billed: containers for a container app, the DO or
 *  platform pages, Anthropic's cost page for the LLM line. */
function seriesLink(name: string): string | undefined {
  const l = links.value;
  if (!l) return undefined;
  if (name === LLM_LABEL) return l.anthropic;
  if (name === DO_LABEL) return l.durableObjects;
  if (name === PLATFORM_LABEL) return l.workers;
  return l.containers;
}

/** The projection tile's second line: the two run-rates and what each stands on. */
const projectionLine = computed(() => {
  const r = report.value;
  const t = tiles.value;
  if (!r || !t) return "";
  const p = t.projection;
  const cloud = `cloud ${usd(p.cloudRate)}/day`;
  const cloudBasis = p.cloudBasis === "today" ? "cloud from today so far" : "cloud from the last 7 full days";
  if (!r.llmAvailable) return `${cloud} × 30.4 · ${cloudBasis} · before plan fees and included allowances`;
  const llm = `LLM ${usd(p.llmRate)}/day`;
  const llmBasis =
    p.llmBasis === "closed-days"
      ? `LLM from ${p.llmClosedDays} closed day${p.llmClosedDays === 1 ? "" : "s"}`
      : p.llmBasis === "today"
        ? "LLM from today so far"
        : "no LLM spend in range";
  const basis =
    p.cloudBasis === "today" && p.llmBasis === "today" ? "both from today so far" : `${cloudBasis} · ${llmBasis}`;
  return `${cloud} + ${llm} · × 30.4 · ${basis}`;
});
/** Newest first: the open day on top, where the eye lands. */
const daysNewestFirst = computed(() => (report.value ? [...report.value.days].reverse() : []));
// Invoice tie-out per biller (costs.md item 4d): each biller's own invoice beside
// the summed model.turn dollars its refs attributed; newest day first, like the table.
// A biller whose days carry unpriced tokens gets that column, so the gap they leave
// on the attributed side is explained rather than silent.
const billers = computed(() =>
  (report.value?.billers ?? []).map((t) => ({
    ...t,
    days: [...t.days].reverse(),
    unpricedTokens: t.days.reduce((s, d) => s + (d.unpricedTokens ?? 0), 0),
  })),
);
/** The range presets. Both billing sources bucket by UTC day (the cost report
 *  offers nothing finer), so the short one is today, not a rolling 24 hours. */
const ranges = [1, 7, 30];
const rangeLabel = (n: number): string => (n === 1 ? "today" : `${n}d`);

/** The LLM tile's second line: yesterday's and the open day's figures, the
 *  estimate said so; or why there is no figure at all. */
const llmTileLine = computed(() => {
  const r = report.value;
  const t = tiles.value;
  if (!r || !t) return "";
  if (!r.llmAvailable) return "LLM spend not configured";
  const parts: string[] = [];
  if (t.llm.yesterday !== undefined) parts.push(`yesterday ${usd(t.llm.yesterday)}`);
  if (t.llm.today) parts.push(`today ${usd(t.llm.today.usd)}${t.llm.today.estimated ? " (estimate)" : ""}`);
  return parts.length ? parts.join(" · ") : "in range";
});
const unpricedModelTokens = computed(() =>
  report.value?.llmAvailable ? report.value.days.reduce((count, day) => count + day.llmUnpricedTokens, 0) : 0,
);

/** An ISO day (`YYYY-MM-DD`) → `Aug 1` — the range line and the table read at a glance. */
function monthDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const summaryTiles = computed(() =>
  tiles.value
    ? [
        tiles.value.yesterday
          ? {
              label: "Yesterday",
              value: usd(tiles.value.yesterday.total),
              note: `${tiles.value.yesterday.date} · last full day, UTC`,
            }
          : {
              label: "Today so far",
              value: tiles.value.today ? usd(tiles.value.today.total) : "—",
              note: tiles.value.today ? `${tiles.value.today.date} · partial day, UTC` : "no day in range",
            },
        {
          label: "7-day average",
          value: tiles.value.avg7 !== undefined ? usd(tiles.value.avg7) : "—",
          note: tiles.value.avg7 !== undefined ? "per day, full days only" : "no full day yet in this range",
        },
        { label: "Total in range", value: usd(report.value?.totals.total ?? 0) },
        { label: "Monthly projection", value: usd(tiles.value.projection.monthUsd), note: projectionLine.value },
        {
          label: "Model usage",
          value: report.value?.llmAvailable ? usd(tiles.value.llm.range) : "—",
          note: llmTileLine.value,
        },
        { label: "Cloud account share", value: `${tiles.value.accountShare}%`, note: "Cloud costs only" },
      ]
    : [],
);
</script>
<template>
  <PageHeading
    title="Costs"
    :description="
      work
        ? 'See recorded model and unit spend for the selected work.'
        : 'Understand cloud and model spend from one billing snapshot.'
    "
    ><button v-if="canSnapshot" class="green-button" :disabled="taking || !!status?.inFlight" @click="takeSnapshot">
      <UIcon name="i-lucide-refresh-cw" />{{ taking || status?.inFlight ? "Taking snapshot…" : "Snapshot now" }}
    </button></PageHeading
  >
  <div v-if="seed" class="green-toolbar">
    <nav class="flex gap-2 flex-wrap" aria-label="Cost groups">
      <RouterLink
        v-for="g in groups"
        :key="g"
        class="green-button"
        :to="hrefOf(g, selectedRange, view)"
        :aria-current="g === group ? 'page' : undefined"
        >{{ g }}</RouterLink
      >
    </nav>
    <nav class="flex gap-1" aria-label="Cost range">
      <RouterLink v-for="n in ranges" :key="n" class="green-button" :to="hrefOf(group, n, view)">{{
        rangeLabel(n)
      }}</RouterLink>
    </nav>
  </div>
  <p v-if="!work" class="text-xs text-muted mb-5" data-snapshot-status>{{ snapshotLine }}</p>
  <p v-if="takeError" class="green-notice green-error" role="alert">{{ takeError }}</p>
  <template v-if="work">
    <p class="green-notice" role="status">Shared cloud bills cannot be attributed to this selected work.</p>
    <p v-if="work.completeness === 'partial'" class="green-notice green-warning" role="status">
      Personal usage is incomplete. Shown figures include recorded usage only.
    </p>
    <StatTiles :tiles="workTiles" />
    <p v-if="unpricedWorkTokens" class="green-notice green-warning" role="status">
      {{ unpricedWorkTokens.toLocaleString("en-US") }} unpriced tokens are excluded from the known spend.
    </p>
    <nav class="green-tabs" aria-label="Cost breakdown">
      <RouterLink
        v-for="v in VIEWS"
        :key="v.view"
        :to="hrefOf(group, selectedRange, v.view)"
        :aria-current="v.view === view ? 'page' : undefined"
        >{{ v.tab }}</RouterLink
      >
    </nav>
    <section class="green-section">
      <div class="green-section-heading"><h2>Recorded model usage</h2></div>
      <EmptyState
        v-if="work.completeness === 'unavailable'"
        title="Personal usage unavailable"
        description="Recorded usage could not be confirmed. No total is shown."
      />
      <EmptyState
        v-else-if="!workRows.length"
        :title="work.completeness === 'complete' ? 'No recorded model usage' : 'Personal usage is incomplete'"
        :description="
          work.completeness === 'complete'
            ? 'The covered range has no recorded model usage.'
            : 'Missing data prevents a complete usage total.'
        "
      />
      <div v-else class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>{{ view === "daily" ? "Model" : currentView.tab }}</th>
              <th>Runs</th>
              <th>Turns</th>
              <th>Known model spend</th>
              <th>Unpriced tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in workRows" :key="row.key">
              <td>{{ row.label ?? row.key }}</td>
              <td>{{ row.runs }}</td>
              <td>{{ row.turns }}</td>
              <td>{{ row.llmUsd === 0 && row.unpricedTokens > 0 ? "Unknown" : usd(row.llmUsd) }}</td>
              <td>{{ row.unpricedTokens }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section v-if="workDays.length" class="green-section">
      <div class="green-section-heading">
        <h2>Recorded usage by day</h2>
        <p>UTC days · known model spend only</p>
      </div>
      <div class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Work</th>
              <th>Turns</th>
              <th>Known model spend</th>
              <th>Unpriced tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in workDays" :key="`${day.day}:${day.key}`">
              <td>
                {{ monthDay(day.day)
                }}<span v-if="day.day === work.range.to && work.range.partialLastDay" class="block text-muted"
                  >Partial day</span
                >
              </td>
              <td>{{ day.label ?? day.key }}</td>
              <td>{{ day.turns }}</td>
              <td>{{ day.llmUsd === 0 && day.unpricedTokens > 0 ? "Unknown" : usd(day.llmUsd) }}</td>
              <td>{{ day.unpricedTokens }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Retained-range spend by unit</h2></div>
      <div class="green-section-content">
        <p v-if="work.unitSpendStatus === 'partial'" class="green-notice green-warning" role="status">
          Unit spend is incomplete. Missing ownership or retained runs prevents a full total.
        </p>
        <template v-if="selectedWorkUnit">
          <p class="text-xs text-muted mb-3" data-unit-spend-coverage>
            Only currently readable, attributed child runs kept in this range are included. Earlier runs and runs
            removed by retention are excluded. Original caps do not show remaining budget.
          </p>
          <label class="text-xs"
            >Unit<select v-model="workUnitKey" class="green-input w-full mt-2 mb-4">
              <option v-for="unit in workUnits" :key="unit.key" :value="unit.key">{{ unit.key }}</option>
            </select></label
          >
          <ShipSpendChart v-if="selectedWorkUnit.runs.length" :unit="selectedWorkUnit" />
          <p class="text-xs text-muted mb-3" data-unit-spend-summary>
            {{
              selectedWorkUnit.totalUsd === null
                ? "Unknown retained-range total: unpriced usage"
                : work.unitSpendStatus === "partial"
                  ? selectedWorkUnit.totalUsd > 0
                    ? `Known retained-range subtotal: ${usd(selectedWorkUnit.totalUsd)}`
                    : "Retained-range total unknown"
                  : `Retained-range total: ${usd(selectedWorkUnit.totalUsd)}`
            }}
            ·
            {{ selectedWorkUnit.capUsd === null ? "No recorded cap" : `Original cap ${usd(selectedWorkUnit.capUsd)}` }}
          </p>
          <div class="green-table-scroll">
            <table class="green-table">
              <thead>
                <tr>
                  <th>Run details</th>
                  <th>Cost</th>
                  <th>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="run in selectedWorkUnit.runs" :key="run.id">
                  <td>
                    <RouterLink :to="`/runs/${encodeURIComponent(run.id)}`">{{ run.id.slice(0, 8) }}</RouterLink>
                  </td>
                  <td>{{ run.usd === null ? "Unknown" : usd(run.usd) }}</td>
                  <td>{{ run.cumulativeUsd === null ? "Unknown" : usd(run.cumulativeUsd) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <EmptyState
          v-else
          :title="
            work.unitSpendStatus === 'unavailable'
              ? 'Unit spend unavailable'
              : work.unitSpendStatus === 'partial'
                ? 'Unit spend is incomplete'
                : 'No retained unit spend'
          "
          :description="
            work.unitSpendStatus === 'complete'
              ? 'This covered range has no retained child runs with unit attribution.'
              : 'Retained child-run spending cannot be confirmed.'
          "
        />
      </div>
    </section>
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <p class="mt-3">
        Model spend uses recorded run usage and known prices. Unpriced tokens remain unknown. Shared invoices, cloud
        account totals, and infrastructure allocations are excluded.
      </p>
      <p class="mt-2">
        Coverage starts {{ monthDay(work.coverage.from) }} · {{ work.coverage.retentionDays }} days of retention{{
          work.coverage.clamped ? " · requested range exceeds retained coverage" : ""
        }}.
      </p>
      <a class="block mt-2 text-primary" :href="downloadHref">Download report as JSON</a>
    </details>
  </template>
  <template v-else-if="report">
    <StatTiles :tiles="summaryTiles" />
    <p v-if="unpricedModelTokens" class="green-notice green-warning" role="status" data-unpriced-model-usage>
      {{ unpricedModelTokens.toLocaleString("en-US") }} tokens ran under models with no price and are excluded from the
      estimate. Shown totals do not include that usage.
    </p>
    <nav class="green-tabs" aria-label="Cost breakdown">
      <RouterLink
        v-for="v in VIEWS"
        :key="v.view"
        :to="hrefOf(report.group, report.range.days, v.view)"
        :aria-current="v.view === view ? 'page' : undefined"
        >{{ v.tab }}</RouterLink
      >
    </nav>
    <section class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Daily spend</h2>
          <p>Cloud and models, stacked by component</p>
        </div>
      </div>
      <div class="green-section-content">
        <CostChart v-if="chartModel" :model="chartModel" label="Daily cost, stacked by component" />
        <div class="flex flex-wrap gap-3 text-xs text-muted mt-3">
          <a
            v-for="(name, index) in series"
            :key="name"
            :href="seriesLink(name)"
            class="inline-flex items-center gap-2"
            target="_blank"
            rel="noopener noreferrer"
            ><span class="size-2 rounded-sm" :class="SERIES_SWATCH[index % SERIES_SWATCH.length]" />{{ name }}</a
          >
        </div>
      </div>
    </section>
    <template v-if="view === 'daily'">
      <section class="green-section">
        <div class="green-section-heading"><h2>Cloud components</h2></div>
        <div class="green-table-scroll">
          <table class="green-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Cost</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in split" :key="row.label">
                <td>
                  <a v-if="splitLink(row.label)" :href="splitLink(row.label)" target="_blank" rel="noopener noreferrer"
                    >{{ row.label }} ↗</a
                  ><span v-else>{{ row.label }}</span>
                </td>
                <td class="numeric">{{ usd(row.usd) }}</td>
                <td class="numeric">{{ Math.round(row.percent) }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="green-section">
        <div class="green-section-heading"><h2>Daily table</h2></div>
        <div class="green-table-scroll">
          <table class="green-table">
            <thead>
              <tr>
                <th>Date</th>
                <th v-for="s in series" :key="s">{{ s }}</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="day in daysNewestFirst" :key="day.date">
                <td>
                  {{ monthDay(day.date)
                  }}<span v-if="day.date === report.range.to && report.range.partialLastDay" class="block text-muted"
                    >Partial day</span
                  ><span v-if="day.llmEstimated" class="block text-muted">Models estimated</span>
                </td>
                <td v-for="s in series" :key="s" class="numeric">{{ usd(valueOf(day, s), 3) }}</td>
                <td class="numeric font-medium">{{ usd(day.total, 3) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section v-if="billers.length" class="green-section">
        <div class="green-section-heading"><h2>Invoice comparison</h2></div>
        <div class="green-section-content">
          <div v-for="biller in billers" :key="biller.biller" class="mb-4">
            <h3 class="text-sm font-medium">{{ biller.biller }}</h3>
            <p class="text-xs text-muted my-2">
              Attributed {{ usd(biller.totals.attributedUsd, 4) }} ·
              {{ biller.invoice ? `Invoice ${usd(biller.totals.invoiceUsd, 4)}` : "No invoice source" }} ·
              {{ biller.unpricedTokens }} unpriced tokens
            </p>
            <div class="green-table-scroll">
              <table class="green-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Invoice</th>
                    <th>Attributed</th>
                    <th>Fee · invoice / rows</th>
                    <th>Upstream · invoice / remainder</th>
                    <th>Unpriced tokens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="day in biller.days" :key="day.date">
                    <td>{{ day.date }}</td>
                    <td>{{ day.invoiceUsd === undefined ? "—" : usd(day.invoiceUsd, 4) }}</td>
                    <td>{{ usd(day.attributedUsd, 4) }}</td>
                    <td>
                      {{ day.invoiceFeeUsd === undefined ? "—" : usd(day.invoiceFeeUsd, 4) }} /
                      {{ day.attributedFeeUsd === undefined ? "—" : usd(day.attributedFeeUsd, 4) }}
                    </td>
                    <td>
                      {{ day.invoiceByokUsd === undefined ? "—" : usd(day.invoiceByokUsd, 4) }} /
                      {{ day.attributedUpstreamUsd === undefined ? "—" : usd(day.attributedUpstreamUsd, 4) }}
                    </td>
                    <td>{{ day.unpricedTokens ?? 0 }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </template>
    <section v-else class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Cost {{ currentView.tab.toLowerCase() }}</h2>
          <p>{{ currentView.subtitle }}</p>
        </div>
      </div>
      <div class="green-section-content">
        <CostsByDimension v-if="by" :report="by" /><EmptyState v-else title="This breakdown is unavailable" />
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Retained-range spend by unit</h2></div>
      <div class="green-section-content">
        <p v-if="report.shipSpend" class="text-xs text-muted mb-3" data-unit-spend-coverage>
          Only child runs kept within this date range are included. Earlier runs and runs removed by retention are
          excluded. Unit caps cover the original admitted unit; this chart does not show remaining budget. Unit spend is
          shared across cost groups.
        </p>
        <label v-if="shipUnits.length" class="text-xs"
          >Unit<select v-model="shipKey" class="green-input w-full mt-2 mb-4">
            <option v-for="unit in shipUnits" :key="unit.key" :value="unit.key">{{ unit.key }}</option>
          </select></label
        ><template v-if="selectedShipUnit"
          ><ShipSpendChart :unit="selectedShipUnit" />
          <p class="text-xs text-muted mb-3" data-unit-spend-summary>
            {{
              selectedShipUnit.totalUsd === null
                ? "Unknown retained-range total: unpriced usage"
                : `Retained-range total: ${usd(selectedShipUnit.totalUsd)}`
            }}
            ·
            {{ selectedShipUnit.capUsd === null ? "No recorded cap" : `Original cap ${usd(selectedShipUnit.capUsd)}` }}
          </p>
          <div class="green-table-scroll">
            <table class="green-table">
              <thead>
                <tr>
                  <th>Run details</th>
                  <th>Cost</th>
                  <th>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="run in selectedShipUnit.runs" :key="run.id">
                  <td>
                    <RouterLink :to="`/runs/${encodeURIComponent(run.id)}`">{{ run.id.slice(0, 8) }}</RouterLink>
                  </td>
                  <td>{{ run.usd === null ? "Unknown" : usd(run.usd) }}</td>
                  <td>{{ run.cumulativeUsd === null ? "Unknown" : usd(run.cumulativeUsd) }}</td>
                </tr>
              </tbody>
            </table>
          </div></template
        ><EmptyState
          v-else-if="report.shipSpend"
          title="No retained unit spend"
          description="This range has no retained child runs with unit attribution."
        />
        <EmptyState
          v-else
          title="Unit spend unavailable"
          description="Retained child-run data could not be confirmed."
        />
      </div>
    </section>
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <p class="mt-3">
        The stored snapshot covers cloud billing and model invoices. Cloud prices use provisioned resources and usage.
        Model usage uses provider invoices where available; open-day usage is estimated. Attributed spend keeps the
        recorded price of each model turn. Missing prices stay unknown.
      </p>
      <p class="mt-2">
        Group: {{ report.group }} · Cloud account: {{ accountLabel }}. Plan fees and included allowances are not
        subtracted.
      </p>
      <a class="block mt-2 text-primary" :href="downloadHref">Download report as JSON</a>
    </details>
  </template>
  <section v-else class="green-section">
    <EmptyState
      :title="seed ? 'No billing snapshot yet' : 'Costs unavailable'"
      :description="
        seed
          ? 'Totals appear when the first snapshot completes. Its progress and failures are shown above.'
          : 'Billing data could not be loaded. Totals cannot be confirmed.'
      "
    />
  </section>
</template>
