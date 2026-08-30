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
const siblings = computed(() => groups.value.filter((g) => g !== report.value?.group));
const ranges = [7, 30, 90];
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

    <p class="mb-4 text-sm text-muted">
      Cost per day by component · {{ report.range.days }} days · {{ report.range.from }} → {{ report.range.to
      }}<template v-if="report.range.partialLastDay"> (today is a partial day)</template>
    </p>

    <nav v-if="siblings.length" class="mb-4 text-sm text-muted" aria-label="Other groups">
      Other groups:
      <template v-for="(g, i) in siblings" :key="g">
        <template v-if="i > 0"> · </template>
        <a class="text-primary hover:underline" :href="`/costs/${g}`">{{ g }}</a>
      </template>
    </nav>

    <section class="mb-5 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[11px] font-medium uppercase tracking-widest text-dimmed">Yesterday</span>
        <span class="text-2xl font-medium tabular-nums">{{ tiles.yesterday ? usd(tiles.yesterday.total) : "—" }}</span>
        <span class="text-xs text-muted">{{ tiles.yesterday ? `${tiles.yesterday.date} · last full day` : "no full day in range" }}</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[11px] font-medium uppercase tracking-widest text-dimmed">7-day average</span>
        <span class="text-2xl font-medium tabular-nums">{{ usd(tiles.avg7) }}</span>
        <span class="text-xs text-muted">per day, full days only</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[11px] font-medium uppercase tracking-widest text-dimmed">Projected month</span>
        <span class="text-2xl font-medium tabular-nums">{{ usd(tiles.projectedMonth, 0) }}</span>
        <span class="text-xs text-muted">7-day rate × 30.4, before plan fees and included allowances</span>
      </div>
      <div class="grid gap-0.5 rounded-md border border-default bg-elevated px-4 py-3.5">
        <span class="text-[11px] font-medium uppercase tracking-widest text-dimmed">{{ report.llmAvailable ? "LLM share" : "LLM spend" }}</span>
        <span class="text-2xl font-medium tabular-nums">{{ report.llmAvailable ? `${tiles.llmShare}%` : "—" }}</span>
        <span class="text-xs text-muted">{{ report.llmAvailable ? "of the range total" : "LLM spend not configured" }}</span>
      </div>
    </section>

    <section class="mb-5 grid gap-3 rounded-md border border-default bg-elevated px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h2 class="text-[15px] font-semibold">Daily cost</h2>
          <p class="text-sm text-muted">Stacked by component · USD at list price · read live from both billing sources</p>
        </div>
        <div class="legend flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <span v-for="(s, i) in series" :key="s" class="inline-flex items-center gap-1.5">
            <i class="inline-block size-2.5 rounded-xs" :class="SERIES_SWATCH[i % SERIES_SWATCH.length]" />{{ s }}
          </span>
        </div>
      </div>
      <CostChart :report="report" :series="series" />
      <p class="text-xs text-muted">
        Cloudflare bills vCPU on active use only; memory and disk bill on the provisioned size for every second a container is
        awake.
        <template v-if="report.llmAvailable">
          LLM spend is the Anthropic Admin API cost report for this group's workspace (gross, USD).
        </template>
        <template v-else>
          LLM spend not configured — set <code>ANTHROPIC_ADMIN_KEY</code> and the group's <code>anthropicWorkspaceId</code> to
          layer it in.
        </template>
      </p>
    </section>

    <section class="mb-5 grid gap-3 rounded-md border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[15px] font-semibold">What each cloud dollar buys</h2>
        <p class="text-sm text-muted">Cloudflare spend in range, split by billed resource</p>
      </div>
      <table class="w-full border-collapse text-[13px] tabular-nums">
        <tbody>
          <tr v-for="row in split" :key="row.label" class="border-b border-muted">
            <td class="px-2.5 py-1.5">{{ row.label }}</td>
            <td class="px-2.5 py-1.5 text-right">{{ usd(row.usd) }}</td>
            <td class="px-2.5 py-1.5 text-right">{{ Math.round(row.percent) }}%</td>
            <td class="w-2/5 px-2.5 py-1.5">
              <i class="block h-2.5 rounded-xs bg-primary opacity-75" :style="{ width: `${row.percent.toFixed(1)}%` }" />
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="mb-5 grid gap-3 rounded-md border border-default bg-elevated px-5 py-4">
      <details open>
        <summary class="cursor-pointer text-sm text-muted">Table view — daily cost by component (USD)</summary>
        <div class="mt-2.5 overflow-x-auto">
          <table class="data w-full border-collapse text-[13px] tabular-nums">
            <thead>
              <tr>
                <th class="border-b border-muted px-2.5 py-1.5 text-left text-xs font-medium text-muted">Date</th>
                <th v-for="s in series" :key="s" class="border-b border-muted px-2.5 py-1.5 text-right text-xs font-medium text-muted">
                  {{ s }}
                </th>
                <th class="border-b border-muted px-2.5 py-1.5 text-right text-xs font-medium text-muted">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in report.days" :key="d.date">
                <td class="border-b border-muted px-2.5 py-1.5">
                  {{ d.date }}
                  <span v-if="report.range.partialLastDay && d.date === report.range.to" class="text-xs text-dimmed">(partial day)</span>
                </td>
                <td v-for="s in series" :key="s" class="border-b border-muted px-2.5 py-1.5 text-right">{{ usd(valueOf(d, s), 3) }}</td>
                <td class="border-b border-muted px-2.5 py-1.5 text-right font-semibold">{{ usd(d.total, 3) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
      <p class="text-xs text-muted">
        Machine-readable twin: <code class="rounded bg-accented px-1 py-0.5">GET /costs/{{ report.group }}.json</code> (same
        Access gate).
      </p>
    </section>

    <footer class="grid gap-1 border-t border-default pt-3.5 text-xs text-dimmed">
      <div>
        <b>Method.</b> Cloudflare GraphQL Analytics <code>containersUsageAdaptiveGroups</code> (cpuTimeSec, allocatedMemory,
        allocatedDisk per app per UTC day), <code>durableObjectsPeriodicGroups</code> (billable <code>duration</code> GB-s per
        namespace) and <code>durableObjectsInvocationsAdaptiveGroups</code> (requests per Worker). Prices: vCPU $0.000020/s,
        memory $0.0000025/GiB-s, disk $0.00000007/GB-s, DO duration $12.50 per million GB-s, DO requests $0.15/M. Gross list
        price — plan fees and included allowances are not subtracted.
      </div>
      <div>
        <b>Scope.</b> Only the container apps, DO namespaces and Workers mapped to this group in
        <code>costs.groups.{{ report.group }}</code>; everything else in the account is excluded. Not included: R2 (resident
        snapshots), DO SQLite storage, Workers requests, Access — each is cents a month at current volume.
      </div>
    </footer>
  </AppShell>
</template>
