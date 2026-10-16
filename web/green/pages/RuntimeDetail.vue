<script setup lang="ts">
import { computed } from "vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import StatusDot from "../../src/components/StatusDot.vue";
import ResidentUidGauge from "../../src/components/residents/ResidentUidGauge.vue";
import { useSeed } from "../../src/lib/seed";
import {
  diskHeadroom,
  RESIDENT_SLUG_RE,
  rec,
  residentDisk,
  residentImageReport,
  residentLive,
  residentSlug,
  residentLabel,
  residentStateTone,
  residentThreads,
  str,
  type ResidentRecordView,
} from "@core/channels/residentsModel.js";
import { formatDiskGauge, formatGiB, projectThreadCostKiB } from "@core/execution/residentDiskBudget.js";

// One resident's detail page: lifecycle, pinned facts, snapshot stamp, thread
// worktrees, pending schedules, command table, registry settings — the browser
// twin of `repo list`'s detail, with GitHub links where GitHub has a page.

const seed = useSeed("resident");
const record = computed<ResidentRecordView>(() => (seed?.record ?? {}) as ResidentRecordView);
const live = computed(() => residentLive(record.value));
const imageReport = computed(() => residentImageReport(record.value));
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

// The bindings as the shared model reads them (newest attach first), with the
// short sha and its commit link — hex only — added for the table.
const threads = computed(() =>
  residentThreads(record.value).map((t) => ({
    ...t,
    threadKey: t.threadKey || "?",
    ref: t.ref || "?",
    sha: t.sha ? t.sha.slice(0, 8) : "",
    commitHref: ghRepo.value && /^[0-9a-f]{7,40}$/.test(t.sha) ? `${ghRepo.value}/commit/${t.sha}` : undefined,
  })),
);
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
  const h = diskHeadroom(d, diskBudgetMb.value);
  const room = (kind: "hardlink" | "reconcile"): string => {
    const count = h.room[kind];
    if (count === null) return projectThreadCostKiB(d.parts, kind) === null ? "? (checkout not measured)" : "?";
    return `${count} more (${formatGiB(projectThreadCostKiB(d.parts, kind))} each)`;
  };
  return [
    ["used / total", formatDiskGauge(d)],
    ["free", `${formatGiB(h.freeKiB)}${h.capped ? ` under the ${formatGiB(h.capacityKiB)} diskBudgetMb cap` : ""}`],
    [
      "reserve",
      `${formatGiB(h.reserve.totalKiB)} (snapshot staging ${formatGiB(h.reserve.stagingKiB)} + floor ${formatGiB(h.reserve.floorKiB)})`,
    ],
    [
      "headroom",
      `${formatGiB(h.headroomKiB)} — room for ${room("hardlink")} hardlinked trees, ${room("reconcile")} lockfile-diverged (reconciling)`,
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
  <template v-if="seed">
    <PageHeading
      :title="residentSlug(record) ? residentLabel(record) : slug || 'Repository environment'"
      description="Lifecycle, retained work, and the facts used for admission."
      eyebrow="SETTINGS / RUNTIME"
      ><RouterLink to="/settings/runtime" class="green-button"
        ><UIcon name="i-lucide-arrow-left" />Runtime</RouterLink
      ></PageHeading
    >
    <section class="green-section">
      <div class="green-section-heading">
        <h2>Lifecycle</h2>
        <span class="green-badge"
          ><StatusDot :tone="residentStateTone(live.state)" :label="live.state" />{{ live.state || "Unknown" }}</span
        >
      </div>
      <div class="green-section-content">
        <dl class="green-facts">
          <dt>Reason</dt>
          <dd>{{ live.reason || "No reason recorded" }}</dd>
          <dt>Container image</dt>
          <dd>
            {{ imageReport
            }}<span v-if="imageReport === 'pending'" class="block text-xs text-muted"
              >Waiting for the deployed image report</span
            >
          </dd>
          <dt>UID pool</dt>
          <dd><ResidentUidGauge :record="record" /></dd>
          <dt>Provisioned</dt>
          <dd>{{ str(live.provisionedAt) || "Not recorded" }}</dd>
          <dt>Last refresh</dt>
          <dd>{{ str(live.lastRefreshAt) || "Not recorded" }}</dd>
          <dt>Last refresh error</dt>
          <dd>{{ str(live.lastRefreshError) || "No error recorded" }}</dd>
          <dt>Idle since</dt>
          <dd>
            {{ str(live.idleSince) || "Awake"
            }}<span v-if="str(live.idleSince)" class="block text-xs text-muted"
              >Refresh is parked; the container may sleep.</span
            >
          </dd>
          <dt>Last restore</dt>
          <dd>{{ lastRestore || "No restore recorded" }}</dd>
        </dl>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Pinned source</h2></div>
      <div class="green-section-content">
        <dl class="green-facts">
          <dt>Repository</dt>
          <dd>
            <a v-if="ghRepo" :href="ghRepo" target="_blank" rel="noopener noreferrer" class="text-primary"
              >{{ slug }} ↗</a
            ><span v-else>{{ str(record.resource) || "Unknown" }}</span>
          </dd>
          <dt>Default branch</dt>
          <dd>{{ str(live.defaultRef) || str(record.defaultRef) || "Unknown" }}</dd>
          <dt>Commit</dt>
          <dd>
            <a v-if="ghCommit" :href="ghCommit" class="text-primary" target="_blank" rel="noopener noreferrer">{{
              sha
            }}</a
            ><span v-else>{{ sha || "Unknown" }}</span>
          </dd>
          <dt>Lockfile hash</dt>
          <dd>{{ str(live.lockfileHash) || "Unknown" }}</dd>
        </dl>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Disk and admission headroom</h2></div>
      <div class="green-section-content">
        <template v-if="disk"
          ><dl class="green-facts">
            <template v-for="[label, value] in diskFacts" :key="label"
              ><dt>{{ label }}</dt>
              <dd>{{ value }}</dd></template
            >
          </dl>
          <details class="mt-5 text-xs">
            <summary>Component measurements</summary>
            <dl class="green-facts mt-3">
              <template v-for="[label, value] in diskParts" :key="label"
                ><dt>{{ label }}</dt>
                <dd>{{ value }}</dd></template
              >
            </dl>
          </details></template
        >
        <p v-else class="text-xs text-muted">
          Disk has not been measured. The next refresh or attach will record a measurement.
        </p>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading">
        <h2>Thread worktrees</h2>
        <span class="text-xs text-muted">{{ liveThreads }} retained · {{ threads.length - liveThreads }} evicted</span>
      </div>
      <div v-if="threads.length" class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Thread</th>
              <th>Branch</th>
              <th>Commit</th>
              <th>State</th>
              <th>User</th>
              <th>Dependencies</th>
              <th>Disk</th>
              <th>Attached</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="thread in threads" :key="thread.threadKey">
              <td class="break-all">
                <RouterLink class="text-primary" :to="`/threads/${encodeURIComponent(thread.threadKey)}`">{{
                  thread.threadKey
                }}</RouterLink>
              </td>
              <td class="break-all">{{ thread.ref }}</td>
              <td>
                <a v-if="thread.commitHref" :href="thread.commitHref" class="text-primary">{{ thread.sha }}</a
                ><span v-else>{{ thread.sha || "Unknown" }}</span>
              </td>
              <td>
                {{ thread.evicted ? "Evicted" : "Retained" }}
                <span v-if="thread.evicted" class="block text-xs text-muted"
                  >evicted {{ thread.evictedAt || "at an unknown time" }} ·
                  {{ thread.evictedWhy || "No reason recorded" }}</span
                >
              </td>
              <td>{{ thread.user || "Unknown" }}</td>
              <td>{{ thread.deps || "Unknown" }}</td>
              <td>
                {{
                  disk?.parts.threads[thread.threadKey] === undefined
                    ? "Unknown"
                    : formatGiB(disk.parts.threads[thread.threadKey])
                }}
              </td>
              <td>{{ thread.lastAttachAt || "Unknown" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="p-5 text-xs text-muted">No worktrees recorded.</p>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Snapshot</h2></div>
      <div class="green-section-content">
        <dl v-if="snapshot" class="green-facts">
          <template
            v-for="key in ['ref', 'sha', 'lockfileHash', 'createdAt', 'mirrorBackupId', 'checkoutBackupId']"
            :key="key"
            ><dt>{{ key }}</dt>
            <dd>{{ str(snapshot[key]) || "Not recorded" }}</dd></template
          >
        </dl>
        <p v-else class="text-xs text-muted">No snapshot recorded.</p>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Pending schedules</h2></div>
      <div class="green-section-content">
        <dl class="green-facts">
          <template
            v-for="[label, key] in [
              ['Refresh', 'refresh'],
              ['Provision run', 'provisionRun'],
              ['Provision deadline', 'provisionDeadline'],
            ]"
            :key="key"
            ><dt>{{ label }}</dt>
            <dd>{{ str(schedules[key] ?? 0) || "0" }}</dd></template
          >
        </dl>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Commands</h2></div>
      <div v-if="commands.length" class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Command</th>
              <th>Effect</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="command in commands" :key="command.name">
              <td>{{ command.name }}</td>
              <td class="break-all font-mono">{{ command.command }}</td>
              <td>{{ command.effect }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="p-5 text-xs text-muted">No command table recorded.</p>
    </section>
    <details class="text-xs text-muted">
      <summary>Registry settings</summary>
      <dl class="green-facts mt-4">
        <template
          v-for="[label, value] in [
            ['Onboarded', str(record.onboardedAt)],
            ['Updated', str(record.updatedAt)],
            ['Provision timeout (ms)', str(record.provisioningTimeoutMs)],
            ['Disk budget (MB)', str(record.diskBudgetMb)],
            ['Worktree retention (days)', str(record.worktreeTtlDays)],
          ]"
          :key="label"
          ><dt>{{ label }}</dt>
          <dd>{{ value || "Not recorded" }}</dd></template
        >
      </dl>
    </details>
  </template>
  <section v-else class="green-section">
    <EmptyState
      title="Runtime unavailable"
      description="This repository environment is unknown or cannot be read with your current access."
    />
  </section>
</template>
<style scoped>
.green-facts {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 12px 20px;
  font-size: 12px;
}
.green-facts dt {
  color: var(--ui-text-muted);
}
.green-facts dd {
  overflow-wrap: anywhere;
}
@media (max-width: 639px) {
  .green-facts {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .green-facts dd {
    margin-bottom: 12px;
  }
}
</style>
