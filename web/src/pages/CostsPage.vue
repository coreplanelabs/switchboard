<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import CostChart from "../components/costs/CostChart.vue";
import { useSeed } from "../lib/seed";
import { resourceSplitOf, seriesOf, SERIES_SWATCH, tilesOf, usd, valueOf } from "../lib/costs";

// The spend dashboard: what a group of deployed pieces costs per day, read
// live from both billing sources per request. Same shell and tokens as every
// other page now (the old costs page was the one light/sans outlier).

const seed = useSeed("costs");
const report = computed(() => seed?.report ?? null);
const groups = computed(() => seed?.groups ?? []);
const series = computed(() => (report.value ? seriesOf(report.value) : []));
const tiles = computed(() => (report.value ? tilesOf(report.value) : null));
const split = computed(() => (report.value ? resourceSplitOf(report.value) : []));
const ranges = [7, 30, 90];

/** An ISO day (`YYYY-MM-DD`) → `Aug 1` — the range line and the table read at a glance. */
function monthDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
</script>

<template>
  <AppShell v-if="report && tiles" :title="`${report.label} spend`" nav="costs">
    <template #actions>
      <span class="text-xs text-muted">
        <template v-for="(n, i) in ranges" :key="n">
          <template v-if="i > 0"> · </template>
          <b v-if="n === report.range.days" class="text-highlighted">{{ n }}d</b>
          <a v-else class="text-primary hover:underline" :href="`/costs/${report.group}?days=${n}`">{{ n }}d</a>
        </template>
      </span>
    </template>

    <!-- One glance: which group, which window. Groups are a pill switcher (the
         current one solid), the range a short human line. -->
    <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav v-if="groups.length > 1" class="flex items-center gap-1" aria-label="Cost groups">
        <template v-for="g in groups" :key="g">
          <span
            v-if="g === report.group"
            class="rounded-md bg-accented px-2.5 py-1 text-xs font-semibold text-highlighted"
            aria-current="page"
            >{{ g }}</span
          >
          <a
            v-else
            class="rounded-md px-2.5 py-1 text-xs text-muted no-underline hover:bg-elevated hover:text-highlighted"
            :href="`/costs/${g}`"
            >{{ g }}</a
          >
        </template>
      </nav>
      <p class="text-sm tabular-nums text-muted">
        {{ monthDay(report.range.from) }} → {{ monthDay(report.range.to) }} · {{ report.range.days }}d<template
          v-if="report.range.partialLastDay"
        >
          · today partial</template
        >
      </p>
    </div>

    <section class="mb-5 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">Yesterday</span>
        <span class="text-2xl font-medium tabular-nums">{{ tiles.yesterday ? usd(tiles.yesterday.total) : "—" }}</span>
        <span class="text-xs text-muted">{{
          tiles.yesterday ? `${tiles.yesterday.date} · last full day` : "no full day in range"
        }}</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">7-day average</span>
        <span class="text-2xl font-medium tabular-nums">{{ usd(tiles.avg7) }}</span>
        <span class="text-xs text-muted">per day, full days only</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">Projected month</span>
        <span class="text-2xl font-medium tabular-nums">{{ usd(tiles.projectedMonth, 0) }}</span>
        <span class="text-xs text-muted">7-day rate × 30.4, before plan fees and included allowances</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">{{
          report.llmAvailable ? "LLM share" : "LLM spend"
        }}</span>
        <span class="text-2xl font-medium tabular-nums">{{ report.llmAvailable ? `${tiles.llmShare}%` : "—" }}</span>
        <span class="text-xs text-muted">{{
          report.llmAvailable ? "of the range total" : "LLM spend not configured"
        }}</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">Share of account</span>
        <span class="text-2xl font-medium tabular-nums">{{ tiles.accountShare }}%</span>
        <span class="text-xs text-muted"
          >{{ usd(report.totals.cloudUsd) }} of {{ usd(report.account.cloudUsd) }} Cloudflare spend in range</span
        >
      </div>
    </section>

    <section class="mb-5 grid gap-3 rounded-md border border-default bg-elevated px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h2 class="text-[0.9375rem] font-semibold">Daily cost</h2>
          <p class="text-sm text-muted">Stacked by component · USD list price</p>
        </div>
        <div class="legend flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <span v-for="(s, i) in series" :key="s" class="inline-flex items-center gap-1.5">
            <i class="inline-block size-2.5 rounded-xs" :class="SERIES_SWATCH[i % SERIES_SWATCH.length]" />{{ s }}
          </span>
        </div>
      </div>
      <CostChart :report="report" :series="series" />
      <!-- The billing-method prose lives in the collapsed footer; only an
           actionable gap stays on the card. -->
      <p v-if="!report.llmAvailable" class="text-xs text-warn">
        LLM spend not configured — set <code>ANTHROPIC_ADMIN_KEY</code> and the group's
        <code>anthropicWorkspaceId</code> to layer it in.
      </p>
    </section>

    <section class="mb-5 grid gap-3 rounded-md border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-semibold">What each cloud dollar buys</h2>
      </div>
      <table class="w-full border-collapse text-[0.8125rem] tabular-nums">
        <tbody>
          <tr v-for="row in split" :key="row.label" class="border-b border-muted">
            <td class="px-2.5 py-1.5">{{ row.label }}</td>
            <td class="px-2.5 py-1.5 text-right">{{ usd(row.usd) }}</td>
            <td class="px-2.5 py-1.5 text-right">{{ Math.round(row.percent) }}%</td>
            <td class="w-2/5 px-2.5 py-1.5">
              <i
                class="block h-2.5 rounded-xs bg-primary opacity-75"
                :style="{ width: `${row.percent.toFixed(1)}%` }"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="mb-5 grid gap-3 rounded-md border border-default bg-elevated px-5 py-4">
      <details open>
        <summary class="cursor-pointer text-sm text-muted">Table view — daily cost by component (USD)</summary>
        <!-- The table scrolls sideways on a narrow screen instead of squishing
             into wrapped headers and split dates. -->
        <div class="mt-2.5 overflow-x-auto">
          <table class="data w-full min-w-[38rem] border-collapse whitespace-nowrap text-[0.8125rem] tabular-nums">
            <thead>
              <tr>
                <th class="border-b border-muted px-2.5 py-1.5 text-left text-xs font-medium text-muted">Date</th>
                <th
                  v-for="s in series"
                  :key="s"
                  class="border-b border-muted px-2.5 py-1.5 text-right text-xs font-medium text-muted"
                >
                  {{ s }}
                </th>
                <th class="border-b border-muted px-2.5 py-1.5 text-right text-xs font-medium text-muted">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in report.days" :key="d.date">
                <td class="border-b border-muted px-2.5 py-1.5" :title="d.date">
                  {{ monthDay(d.date) }}
                  <span v-if="report.range.partialLastDay && d.date === report.range.to" class="text-xs text-dimmed"
                    >(partial day)</span
                  >
                </td>
                <td v-for="s in series" :key="s" class="border-b border-muted px-2.5 py-1.5 text-right">
                  {{ usd(valueOf(d, s), 3) }}
                </td>
                <td class="border-b border-muted px-2.5 py-1.5 text-right font-semibold">{{ usd(d.total, 3) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
      <p class="text-xs text-muted">
        Machine-readable twin:
        <code class="rounded bg-accented px-1 py-0.5">GET /costs/{{ report.group }}.json</code> (same Access gate).
      </p>
    </section>

    <!-- The methodology matters and stays — one click away instead of two
         paragraphs of standing prose. -->
    <footer class="border-t border-default pt-3.5 text-xs text-dimmed">
      <details>
        <summary class="cursor-pointer text-muted">How these numbers are computed</summary>
        <div class="mt-2 grid gap-1.5">
          <div>
            <b>Live.</b> Both billing sources are read live from this page — nothing cached, nothing stored. Cloudflare
            bills vCPU on active use only; memory and disk bill on the provisioned size for every second a container is
            awake. LLM spend is the Anthropic Admin API cost report for this group's workspace (gross, USD).
          </div>
          <div>
            <b>Method.</b> Cloudflare GraphQL Analytics, every meter a Workers deployment is billed on:
            <code>containersUsageAdaptiveGroups</code> (cpuTimeSec, allocatedMemory, allocatedDisk per app per UTC day),
            <code>durableObjectsPeriodicGroups</code> (billable <code>duration</code> GB-s and SQLite rows read and
            written per namespace), <code>durableObjectsInvocationsAdaptiveGroups</code> (requests per namespace),
            <code>durableObjectsSqlStorageGroups</code> (bytes stored),
            <code>workersInvocationsAdaptive</code> (requests, CPU time), <code>r2StorageAdaptiveGroups</code> and
            <code>r2OperationsAdaptiveGroups</code>
            (bytes stored, class A/B operations). Prices: vCPU $0.000020/s, memory $0.0000025/GiB-s, disk
            $0.00000007/GB-s, DO duration $12.50 per million GB-s, DO requests $0.15/M, SQLite rows $0.001/M read and
            $1.00/M written, DO storage $0.20/GB-month, Workers $0.30/M requests and $0.02/M CPU-ms, R2 $0.015/GB-month,
            $4.50/M class A and $0.36/M class B (deletes free). Storage is the day's peak, prorated over a 30.44-day
            month. Gross list price — plan fees and included allowances are not subtracted; Workers Logs volume has no
            analytics dataset and is not priced.
          </div>
          <div>
            <b>Scope.</b> Attributed to this group: the Workers <code>{{ report.attribution.workers.join(", ") }}</code
            >, every Durable Object namespace they host ({{
              Object.keys(report.attribution.durableObjectNamespaces).length
            }}), the R2 buckets named after them ({{ Object.keys(report.attribution.r2Buckets).length }}), and the
            container apps mapped in <code>costs.groups.{{ report.group }}</code> ({{
              Object.keys(report.attribution.containerApps).length
            }}). Everything else in the account is priced the same way into the account total, which is what "share of
            account" divides by.
          </div>
        </div>
      </details>
    </footer>
  </AppShell>
</template>
