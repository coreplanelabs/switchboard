<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import StatusDot from "../components/StatusDot.vue";
import { useSeed } from "../lib/seed";
import {
  RESIDENT_SLUG_RE,
  rec,
  residentDisk,
  residentLive,
  residentSlug,
  residentStateTone,
  str,
  type ResidentRecordView,
} from "@core/channels/residentsModel.js";
import {
  diskReserveKiB,
  effectiveFreeKiB,
  formatDiskGauge,
  formatGiB,
  projectThreadCostKiB,
} from "@core/execution/residentDiskBudget.js";

// One resident's detail page: lifecycle, pinned facts, snapshot stamp, thread
// worktrees, pending schedules, command table, registry settings — the browser
// twin of `repo list`'s detail, with GitHub links where GitHub has a page.

const seed = useSeed("resident");
const record = computed<ResidentRecordView>(() => (seed?.record ?? {}) as ResidentRecordView);
const live = computed(() => residentLive(record.value));
const slug = computed(() => residentSlug(record.value) || (seed?.slug ?? ""));
const sha = computed(() => str(live.value.sha));
const ghRepo = computed(() => (RESIDENT_SLUG_RE.test(slug.value) ? `https://github.com/${slug.value}` : undefined));
const ghCommit = computed(() =>
  ghRepo.value && /^[0-9a-f]{7,40}$/.test(sha.value) ? `${ghRepo.value}/commit/${sha.value}` : undefined,
);
const snapshot = computed(() => {
  const s = live.value.snapshot;
  return s && typeof s === "object" ? rec(s) : undefined;
});
const schedules = computed(() => rec(live.value.schedules));
const commands = computed(() => {
  const cmds = rec(record.value.commands);
  const effects = rec(record.value.effects);
  return Object.keys(cmds)
    .sort()
    .map((k) => ({ name: k, command: str(cmds[k]), effect: str(effects[k]) || "readonly" }));
});

interface ThreadRow {
  threadKey: string;
  ref: string;
  sha: string;
  commitHref?: string;
  user: string;
  deps: string;
  boundAt: string;
  lastAttachAt: string;
  evicted: boolean;
  evictedAt: string;
  evictedWhy: string;
}
const threads = computed<ThreadRow[]>(() => {
  const raw = live.value.threads;
  const list = Array.isArray(raw) ? raw.map(rec) : [];
  return list
    .map((t) => {
      const tSha = str(t.sha);
      return {
        threadKey: str(t.threadKey) || "?",
        ref: str(t.ref) || "?",
        sha: tSha ? tSha.slice(0, 8) : "",
        commitHref: ghRepo.value && /^[0-9a-f]{7,40}$/.test(tSha) ? `${ghRepo.value}/commit/${tSha}` : undefined,
        user: str(t.user),
        deps: str(t.deps),
        boundAt: str(t.boundAt),
        lastAttachAt: str(t.lastAttachAt),
        evicted: t.evicted === true,
        evictedAt: str(t.evictedAt),
        evictedWhy: str(t.evictedWhy),
      };
    })
    .sort((a, b) => b.lastAttachAt.localeCompare(a.lastAttachAt));
});
const liveThreads = computed(() => threads.value.filter((t) => !t.evicted).length);

const lastRestore = computed(() => {
  const v = live.value.lastRestore;
  return v ? JSON.stringify(v) : "";
});

// Item 55: the last disk sample and the budget arithmetic over it — the same
// pure functions the resident's attach admission runs, so the page shows the
// numbers the next admission will decide on.
const disk = computed(() => residentDisk(record.value));
const diskBudgetMb = computed(() =>
  typeof record.value.diskBudgetMb === "number" ? record.value.diskBudgetMb : undefined,
);
const diskFacts = computed(() => {
  const d = disk.value;
  if (!d) return [];
  const reserve = diskReserveKiB(d);
  const { freeKiB, capped, capacityKiB } = effectiveFreeKiB(d, diskBudgetMb.value);
  const headroom = freeKiB - reserve.totalKiB;
  const room = (kind: "hardlink" | "reconcile"): string => {
    const cost = projectThreadCostKiB(d.parts, kind);
    if (cost === null) return "? (checkout not measured)";
    if (cost === 0) return "?";
    return `${Math.max(0, Math.floor(headroom / cost))} more (${formatGiB(cost)} each)`;
  };
  return [
    ["used / total", formatDiskGauge(d)],
    ["free", `${formatGiB(freeKiB)}${capped ? ` under the ${formatGiB(capacityKiB)} diskBudgetMb cap` : ""}`],
    [
      "reserve",
      `${formatGiB(reserve.totalKiB)} (snapshot staging ${formatGiB(reserve.stagingKiB)} + floor ${formatGiB(reserve.floorKiB)})`,
    ],
    [
      "headroom",
      `${formatGiB(Math.max(0, headroom))} — room for ${room("hardlink")} hardlinked trees, ${room("reconcile")} lockfile-diverged (reconciling)`,
    ],
    ["measured", d.at || "—"],
  ];
});
const diskParts = computed(() => {
  const d = disk.value;
  if (!d) return [];
  const rows: Array<[string, string]> = [
    ["mirror", formatGiB(d.parts.mirror)],
    ["checkout deps (node_modules)", formatGiB(d.parts.deps)],
    ["checkout (history + tree + build)", formatGiB(d.parts.checkout)],
  ];
  for (const [key, kib] of Object.entries(d.parts.threads).sort((a, b) => b[1] - a[1]))
    rows.push([`thread ${key}`, formatGiB(kib)]);
  // Homes hold an install thread's pnpm store / npm cache; a bare home (a few
  // KiB of dotfiles) is noise, so only ones above 1 MiB are listed.
  for (const [user, kib] of Object.entries(d.parts.homes).sort((a, b) => b[1] - a[1]))
    if (kib >= 1024) rows.push([`home ${user}`, formatGiB(kib)]);
  rows.push(["other (image, /tmp, …)", formatGiB(d.parts.other)]);
  return rows;
});
</script>

<template>
  <AppShell :title="slug || 'Resident'" nav="residents">
    <template #leading>
      <a class="back text-sm text-muted no-underline hover:text-primary" href="/residents">← All residents</a>
    </template>

    <section class="mt-4 first:mt-0">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Lifecycle</h2>
      <table class="w-full border-collapse font-mono text-[0.8125rem]">
        <tbody>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">state</td>
            <td class="px-2 py-1 align-top">
              <StatusDot :tone="residentStateTone(live.state)" :label="live.state" />
              <span class="ml-1.5 font-medium">{{ live.state }}</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">reason</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="live.reason">{{ live.reason }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">last refresh error</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="str(live.lastRefreshError)">{{ str(live.lastRefreshError) }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">last restore</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="lastRestore">{{ lastRestore }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">state updated</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="str(live.updatedAt)">{{ str(live.updatedAt) }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">idle since</td>
            <td class="break-all px-2 py-1 align-top">
              <template v-if="str(live.idleSince)">
                {{ str(live.idleSince) }} <span class="text-xs text-muted">(refresh parked; container may sleep)</span>
              </template>
              <span v-else class="text-dimmed">awake</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Pinned facts</h2>
      <table class="w-full border-collapse font-mono text-[0.8125rem]">
        <tbody>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">repository</td>
            <td class="break-all px-2 py-1 align-top">
              <a v-if="ghRepo" class="text-primary" :href="ghRepo">{{ ghRepo }}</a>
              <span v-else>{{ str(record.resource) || "—" }}</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">default ref</td>
            <td class="break-all px-2 py-1 align-top">{{ str(live.defaultRef) || str(record.defaultRef) || "—" }}</td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">pinned sha</td>
            <td class="break-all px-2 py-1 align-top">
              <a v-if="ghCommit" class="text-primary" :href="ghCommit">{{ sha }}</a>
              <span v-else-if="sha">{{ sha }}</span>
              <span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">lockfile hash</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="str(live.lockfileHash)">{{ str(live.lockfileHash) }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">provisioned</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="str(live.provisionedAt)">{{ str(live.provisionedAt) }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
          <tr class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">last refresh</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="str(live.lastRefreshAt)">{{ str(live.lastRefreshAt) }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Disk</h2>
      <template v-if="disk">
        <table class="w-full border-collapse font-mono text-[0.8125rem]">
          <tbody>
            <tr v-for="[label, value] in diskFacts" :key="label" class="border-t border-muted">
              <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">{{ label }}</td>
              <td class="break-all px-2 py-1 align-top">{{ value }}</td>
            </tr>
          </tbody>
        </table>
        <p class="mb-1 mt-2 text-xs text-muted">
          components (one du, hardlinks counted once — a thread tree shows only what it does not share with the
          checkout)
        </p>
        <table class="w-full border-collapse font-mono text-[0.8125rem]">
          <tbody>
            <tr v-for="[label, value] in diskParts" :key="label" class="border-t border-muted">
              <td class="w-32 break-all px-2 py-1 align-top text-muted sm:w-96 sm:break-words">{{ label }}</td>
              <td class="px-2 py-1 align-top">{{ value }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <p v-else class="text-xs text-muted">
        not measured yet — the first refresh cycle or attach of this container measures it
      </p>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Snapshot stamp</h2>
      <table v-if="snapshot" class="w-full border-collapse font-mono text-[0.8125rem]">
        <tbody>
          <tr
            v-for="k in ['ref', 'sha', 'lockfileHash', 'createdAt', 'mirrorBackupId', 'checkoutBackupId']"
            :key="k"
            class="border-t border-muted"
          >
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">{{ k }}</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="str(snapshot[k])">{{ str(snapshot[k]) }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-xs text-muted">no snapshot recorded</p>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Thread worktrees</h2>
      <template v-if="threads.length > 0">
        <p class="mb-1 text-xs text-muted">{{ liveThreads }} live · {{ threads.length - liveThreads }} evicted</p>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse font-mono text-[0.8125rem]">
            <tbody>
              <tr class="text-xs text-muted">
                <td class="px-2 py-1">thread</td>
                <td class="px-2 py-1">ref · sha</td>
                <td class="px-2 py-1">user · deps</td>
                <td class="px-2 py-1">bound · last attach</td>
              </tr>
              <tr v-for="t in threads" :key="t.threadKey" class="border-t border-muted">
                <td class="break-all px-2 py-1 align-top">
                  <template v-if="t.evicted">
                    <span class="text-xs text-muted"
                      >evicted {{ t.evictedAt || "—"
                      }}<template v-if="t.evictedWhy"> · {{ t.evictedWhy }}</template></span
                    >
                  </template>
                  <StatusDot v-else tone="green" label="live" tip="live" />
                  {{ t.threadKey }}
                </td>
                <td class="break-all px-2 py-1 align-top">
                  {{ t.ref }} ·
                  <a v-if="t.commitHref" class="text-primary" :href="t.commitHref">{{ t.sha }}</a>
                  <span v-else-if="t.sha">{{ t.sha }}</span>
                  <span v-else class="text-dimmed">—</span>
                </td>
                <td class="break-all px-2 py-1 align-top">
                  <span v-if="t.user">{{ t.user }}</span
                  ><span v-else class="text-dimmed">—</span> · <span v-if="t.deps">{{ t.deps }}</span
                  ><span v-else class="text-dimmed">—</span>
                </td>
                <td class="break-all px-2 py-1 align-top">
                  <span v-if="t.boundAt">{{ t.boundAt }}</span
                  ><span v-else class="text-dimmed">—</span> · <span v-if="t.lastAttachAt">{{ t.lastAttachAt }}</span
                  ><span v-else class="text-dimmed">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="text-xs text-muted">no thread worktrees</p>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Pending schedules</h2>
      <table class="w-full border-collapse font-mono text-[0.8125rem]">
        <tbody>
          <tr
            v-for="[label, key] in [
              ['refresh', 'refresh'],
              ['provision run', 'provisionRun'],
              ['provision deadline', 'provisionDeadline'],
            ]"
            :key="key"
            class="border-t border-muted"
          >
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">{{ label }}</td>
            <td class="px-2 py-1 align-top">{{ str(schedules[key] ?? 0) || "0" }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Command table</h2>
      <table v-if="commands.length > 0" class="w-full border-collapse font-mono text-[0.8125rem]">
        <tbody>
          <tr v-for="c in commands" :key="c.name" class="border-t border-muted">
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">{{ c.name }}</td>
            <td class="break-all px-2 py-1 align-top">
              <code>{{ c.command }}</code> <span class="text-xs text-muted">{{ c.effect }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-xs text-muted">no command table</p>
    </section>

    <section class="mt-4">
      <h2 class="mb-1.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">Registry settings</h2>
      <table class="w-full border-collapse font-mono text-[0.8125rem]">
        <tbody>
          <tr
            v-for="[label, value] in [
              ['onboarded', str(record.onboardedAt)],
              ['record updated', str(record.updatedAt)],
              ['provisioning timeout (ms)', str(record.provisioningTimeoutMs)],
              ['disk budget (MB)', str(record.diskBudgetMb)],
              ['worktree TTL (days)', str(record.worktreeTtlDays ?? 7)],
            ]"
            :key="label"
            class="border-t border-muted"
          >
            <td class="w-32 px-2 py-1 align-top text-muted sm:w-48 sm:whitespace-nowrap">{{ label }}</td>
            <td class="break-all px-2 py-1 align-top">
              <span v-if="value">{{ value }}</span
              ><span v-else class="text-dimmed">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="mt-4 text-xs text-muted">
      Manage from chat: <code class="rounded bg-elevated px-1 py-0.5">repo rebuild {{ slug }}</code> ·
      <code class="rounded bg-elevated px-1 py-0.5">repo reconfigure {{ slug }} …</code> ·
      <code class="rounded bg-elevated px-1 py-0.5">repo offboard {{ slug }} --dry-run</code>
    </p>
  </AppShell>
</template>
