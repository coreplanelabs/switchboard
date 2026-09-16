<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import CostChart from "../components/costs/CostChart.vue";
import CostsByUser from "../components/costs/CostsByUser.vue";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import {
  accountLabelOf,
  DO_LABEL,
  linksOf,
  LLM_LABEL,
  PLATFORM_LABEL,
  resourceSplitOf,
  seriesOf,
  SERIES_SWATCH,
  snapshotLineOf,
  tilesOf,
  usd,
  valueOf,
} from "../lib/costs";

// The spend dashboard: what a group of deployed pieces costs per day, every
// figure from the costs snapshot (costs.md item 6) — both billing sources read
// on the snapshot's interval or on request, never in a page load. The status
// line under the range names the snapshot the page shows, its age and when the
// next is due; before the first one lands the page shows that line alone. Same
// shell and tokens as every other page (the old costs page was the one
// light/sans outlier).

const seed = useSeed("costs");
const report = computed(() => seed?.report ?? null);
const groups = computed(() => seed?.groups ?? []);
/** The group the page is for — from the seed even when there is no report yet to name it. */
const group = computed(() => seed?.group ?? report.value?.group ?? "");
/** The snapshot's status: its stamp, a take in flight, when the next is due. */
const status = computed(() => seed?.snapshot ?? null);
/** The snapshot's age ticks by the minute while the page is open. */
const now = useWallClock(undefined, 60_000);
const snapshotLine = computed(() => (status.value ? snapshotLineOf(status.value, now.value) : ""));
/** Which tab is open: the daily tables, or cost by user (`?view=users`, the
 *  by-user report riding along in the seed). */
const view = computed<"daily" | "users">(() => seed?.view ?? "daily");
const users = computed(() => (view.value === "users" ? (seed?.users ?? null) : null));
/** The same page for another group, range or tab — the two other pills keep the third. */
function hrefOf(group: string, days: number, v: "daily" | "users"): string {
  const q = [`days=${days}`];
  if (v === "users") q.push("view=users");
  return `/costs/${group}?${q.join("&")}`;
}
const series = computed(() => (report.value ? seriesOf(report.value) : []));
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
/** The range presets. Both billing sources bucket by UTC day (the cost report
 *  offers nothing finer), so the short one is today, not a rolling 24 hours. */
const ranges = [1, 7, 30, 90];
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
    <!-- One glance: which group, which window. Groups and ranges are pill
         switchers (the current one solid), the range also a short human line. -->
    <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav class="flex items-center gap-1" aria-label="Range">
        <template v-for="n in ranges" :key="n">
          <span
            v-if="n === report.range.days"
            class="rounded-md bg-accented px-2.5 py-1 font-mono text-xs font-medium tabular-nums text-highlighted"
            aria-current="page"
            >{{ rangeLabel(n) }}</span
          >
          <a
            v-else
            class="rounded-md px-2.5 py-1 font-mono text-xs tabular-nums text-muted no-underline hover:bg-elevated hover:text-highlighted"
            :href="hrefOf(report.group, n, view)"
            >{{ rangeLabel(n) }}</a
          >
        </template>
      </nav>
      <nav v-if="groups.length > 1" class="flex items-center gap-1" aria-label="Cost groups">
        <template v-for="g in groups" :key="g">
          <span
            v-if="g === report.group"
            class="rounded-md bg-accented px-2.5 py-1 text-xs font-medium text-highlighted"
            aria-current="page"
            >{{ g }}</span
          >
          <a
            v-else
            class="rounded-md px-2.5 py-1 text-xs text-muted no-underline hover:bg-elevated hover:text-highlighted"
            :href="hrefOf(g, report.range.days, view)"
            >{{ g }}</a
          >
        </template>
      </nav>
      <p class="font-mono text-sm tabular-nums text-muted">
        {{ monthDay(report.range.from) }} → {{ monthDay(report.range.to) }} · {{ report.range.days }}d<template
          v-if="report.range.partialLastDay"
        >
          · today partial</template
        >
      </p>
      <!-- Every figure below is as of this snapshot: say which, how old, and when the next is due. -->
      <p v-if="snapshotLine" class="basis-full font-mono text-xs tabular-nums text-dimmed" data-snapshot-status>
        {{ snapshotLine }}
      </p>
    </div>

    <section class="mb-5 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
      <!-- The lead tile is the last full day; a range with none (1d) leads with
           the open day instead of an empty "yesterday". -->
      <div v-if="tiles.yesterday" class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5">
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">Yesterday</span>
        <span class="font-mono text-2xl font-medium tabular-nums">{{ usd(tiles.yesterday.total) }}</span>
        <span class="text-xs text-muted">{{ tiles.yesterday.date }} · last full day</span>
      </div>
      <div v-else class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5">
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">Today so far</span>
        <span class="font-mono text-2xl font-medium tabular-nums">{{
          tiles.today ? usd(tiles.today.total) : "—"
        }}</span>
        <span class="text-xs text-muted">{{
          tiles.today ? `${tiles.today.date} · partial day, UTC` : "no day in range"
        }}</span>
      </div>
      <div class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5">
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">7-day average</span>
        <span class="font-mono text-2xl font-medium tabular-nums">{{
          tiles.avg7 !== undefined ? usd(tiles.avg7) : "—"
        }}</span>
        <span class="text-xs text-muted">{{
          tiles.avg7 !== undefined ? "per day, full days only" : "no full day yet in this range"
        }}</span>
      </div>
      <!-- Cloud and LLM projected as separate run-rates and added: on a young
           workspace the LLM line has no full day yet, and a single 7-day rate
           over the totals would read an order of magnitude low. -->
      <div class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5">
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed"
          >Projected month</span
        >
        <span class="font-mono text-2xl font-medium tabular-nums">{{ usd(tiles.projection.monthUsd, 0) }}</span>
        <span class="text-xs text-muted">{{ projectionLine }}</span>
      </div>
      <!-- Dollars, not a share: model spend runs an order of magnitude above the
           Cloudflare spend, so its share of the total says nothing. -->
      <div class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5">
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">LLM spend</span>
        <span class="font-mono text-2xl font-medium tabular-nums">{{
          report.llmAvailable ? usd(tiles.llm.range) : "—"
        }}</span>
        <span class="text-xs text-muted">{{ llmTileLine }}</span>
      </div>
      <div class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5">
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed"
          >Share of account</span
        >
        <span class="font-mono text-2xl font-medium tabular-nums">{{ tiles.accountShare }}%</span>
        <span class="text-xs text-muted"
          >{{ usd(report.totals.cloudUsd) }} of {{ usd(report.account.cloudUsd) }} on
          <a
            v-if="links"
            class="text-primary hover:underline"
            :href="links.account"
            target="_blank"
            rel="noopener noreferrer"
            :title="`Cloudflare account ${report.account.id}`"
            >{{ accountLabel }}</a
          >
          · Cloudflare spend in range ·
          <a
            v-if="links"
            class="text-primary hover:underline"
            :href="links.billing"
            target="_blank"
            rel="noopener noreferrer"
            >billing</a
          ></span
        >
      </div>
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h2 class="text-[0.9375rem] font-medium">Daily cost</h2>
          <p class="text-sm text-muted">Stacked by component · USD list price</p>
        </div>
        <div class="legend flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <a
            v-for="(s, i) in series"
            :key="s"
            class="inline-flex items-center gap-1.5 no-underline hover:text-highlighted hover:underline"
            :href="seriesLink(s)"
            target="_blank"
            rel="noopener noreferrer"
            :title="`Open where ${s} is billed`"
          >
            <i class="inline-block size-2.5 rounded-xs" :class="SERIES_SWATCH[i % SERIES_SWATCH.length]" />{{ s }}
          </a>
        </div>
      </div>
      <CostChart :report="report" :series="series" />
      <!-- The billing-method prose lives in the collapsed footer; only an
           actionable gap stays on the card. -->
      <p v-if="!report.llmAvailable" class="text-xs text-warn">
        LLM spend not configured — set <code>ANTHROPIC_ADMIN_KEY</code> and the group's
        <code>anthropicWorkspaceId</code> to layer it in.
      </p>
      <p v-else-if="report.days.some((d) => d.llmEstimated)" class="text-xs text-muted">
        A day the Anthropic cost report has not closed yet (today, and yesterday until a few hours after midnight UTC)
        shows its LLM figure as an estimate: the hourly usage report priced at list. The closed days are the cost report
        itself.
        <template v-if="report.days.some((d) => d.llmUnpricedTokens > 0)">
          Some tokens ran under a model this page has no price for and are not in the estimate.
        </template>
      </p>
    </section>

    <!-- The tabs above the tables: the group's day-by-day figures, or the same
         dollars laid against who started the runs. The tiles and the chart
         above are the group's context on both. -->
    <nav class="mb-3 flex items-center gap-1 border-b border-default" aria-label="View">
      <template v-for="v in ['daily', 'users'] as const" :key="v">
        <span
          v-if="v === view"
          class="-mb-px border-b-2 border-primary px-3 py-1.5 text-sm font-medium text-highlighted"
          aria-current="page"
          >{{ v === "daily" ? "Daily" : "By user" }}</span
        >
        <a
          v-else
          class="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted no-underline hover:border-muted hover:text-highlighted"
          :href="hrefOf(report.group, report.range.days, v)"
          >{{ v === "daily" ? "Daily" : "By user" }}</a
        >
      </template>
    </nav>

    <section v-if="view === 'users'" class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-medium">Cost by user</h2>
        <p class="text-sm text-muted">
          Who started the runs · LLM at list from their tokens · cloud allocated by wall-clock
        </p>
      </div>
      <CostsByUser v-if="users" :report="users" />
      <p v-else class="text-sm text-warn">The by-user report did not load with this page.</p>
      <p class="text-xs text-muted">
        Machine-readable twin:
        <code class="rounded bg-accented px-1 py-0.5">GET /costs/{{ report.group }}/users.json</code> (same Access
        gate).
      </p>
    </section>

    <section v-if="view === 'daily'" class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-medium">What each cloud dollar buys</h2>
      </div>
      <table class="w-full border-collapse font-mono text-[0.8125rem] tabular-nums">
        <tbody>
          <tr v-for="row in split" :key="row.label" class="border-b border-muted">
            <td class="px-2.5 py-1.5">
              <a
                v-if="splitLink(row.label)"
                class="no-underline hover:text-highlighted hover:underline"
                :href="splitLink(row.label)"
                target="_blank"
                rel="noopener noreferrer"
                :title="`Open where this is billed on Cloudflare`"
                >{{ row.label }}</a
              >
              <template v-else>{{ row.label }}</template>
            </td>
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

    <section v-if="view === 'daily'" class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <details open>
        <summary class="cursor-pointer text-sm text-muted">Table view — daily cost by component (USD)</summary>
        <!-- The table scrolls sideways on a narrow screen instead of squishing
             into wrapped headers and split dates. -->
        <div class="mt-2.5 overflow-x-auto">
          <table
            class="data w-full min-w-[38rem] border-collapse whitespace-nowrap font-mono text-[0.8125rem] tabular-nums"
          >
            <thead>
              <tr>
                <th
                  class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-left text-xs font-medium text-muted"
                >
                  Date
                </th>
                <th
                  v-for="s in series"
                  :key="s"
                  class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
                >
                  {{ s }}
                </th>
                <th
                  class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
                >
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in daysNewestFirst" :key="d.date">
                <td class="border-b border-muted px-2.5 py-1.5" :title="d.date">
                  {{ monthDay(d.date) }}
                  <span v-if="report.range.partialLastDay && d.date === report.range.to" class="text-xs text-dimmed"
                    >(partial day{{ d.llmEstimated ? " · LLM estimated" : "" }})</span
                  >
                  <span v-else-if="d.llmEstimated" class="text-xs text-dimmed">(LLM estimated)</span>
                </td>
                <td v-for="s in series" :key="s" class="border-b border-muted px-2.5 py-1.5 text-right">
                  {{ usd(valueOf(d, s), 3) }}
                </td>
                <td class="border-b border-muted px-2.5 py-1.5 text-right font-medium">{{ usd(d.total, 3) }}</td>
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
            <b>Snapshot.</b> Both billing sources and the run history are read once over the widest range this page
            offers and kept as a snapshot; every figure here, the JSON twins and the By user tab are arithmetic over it,
            with <em>today</em> the day it was taken. The line under the range says when that was, how old it is and
            when the next one is due (<code>costs.snapshot.everyHours</code>, daily by default);
            <code>costs snapshot</code> takes one now. Cloudflare bills vCPU on active use only; memory and disk bill on
            the provisioned size for every second a container is awake. LLM spend is the Anthropic Admin API cost report
            for this group's workspace (gross, USD); a day the cost report has not closed is the Admin API usage report,
            hourly, priced at Anthropic list per model (input, output, cache writes, cache reads) and marked as an
            estimate.
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
            <b>Scope.</b> Attributed to this group: the Workers
            <template v-for="(w, i) in report.attribution.workers" :key="w"
              ><template v-if="i > 0">, </template
              ><a
                v-if="links"
                class="font-mono hover:underline"
                :href="links.worker(w)"
                target="_blank"
                rel="noopener noreferrer"
                >{{ w }}</a
              ><code v-else>{{ w }}</code></template
            >, every Durable Object namespace they host ({{
              Object.keys(report.attribution.durableObjectNamespaces).length
            }}), the R2 buckets named after them (<template
              v-for="(b, i) in Object.keys(report.attribution.r2Buckets)"
              :key="b"
              ><template v-if="i > 0">, </template
              ><a
                v-if="links"
                class="font-mono hover:underline"
                :href="links.bucket(b)"
                target="_blank"
                rel="noopener noreferrer"
                >{{ b }}</a
              ><code v-else>{{ b }}</code></template
            ><template v-if="Object.keys(report.attribution.r2Buckets).length === 0">none</template>), and the container
            apps mapped in <code>costs.groups.{{ report.group }}</code> ({{
              Object.keys(report.attribution.containerApps).length
            }}). Everything else in the account is priced the same way into the account total, which is what "share of
            account" divides by. Every figure above links to where it is billed: the
            <a v-if="links" class="hover:underline" :href="links.account" target="_blank" rel="noopener noreferrer"
              >Cloudflare dashboard</a
            >
            for the account <code>{{ report.account.id }}</code
            >{{ report.account.name ? ` (${report.account.name})` : "" }}, and
            <a v-if="links" class="hover:underline" :href="links.anthropic" target="_blank" rel="noopener noreferrer"
              >Anthropic's cost page</a
            >
            for the LLM line.
          </div>
        </div>
      </details>
    </footer>
  </AppShell>
  <!-- Before the first snapshot lands there is nothing to price: the status line says so and what happens next. -->
  <AppShell v-else :title="`${group} spend`" nav="costs">
    <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav v-if="groups.length > 1" class="flex items-center gap-1" aria-label="Cost groups">
        <template v-for="g in groups" :key="g">
          <span
            v-if="g === group"
            class="rounded-md bg-accented px-2.5 py-1 text-xs font-medium text-highlighted"
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
    </div>
    <section class="mb-5 grid gap-2 rounded-lg border border-default bg-elevated px-5 py-4">
      <h2 class="text-sm font-medium text-highlighted">Nothing to show yet</h2>
      <p class="font-mono text-xs tabular-nums text-muted" data-snapshot-status>{{ snapshotLine }}</p>
      <p class="text-xs text-dimmed">
        The page prices a stored snapshot of both billing sources, never a live read; reload once one has been taken, or
        take one now with <code>costs snapshot</code>.
      </p>
    </section>
  </AppShell>
</template>
