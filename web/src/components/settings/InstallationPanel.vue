<script setup lang="ts">
import { computed } from "vue";
import type { InstallationView } from "@core/core/installationSettings.js";

// The Installation tab: what the running config.yaml says about the behaviour
// a customer can see, one row per knob (the allow-list projection in
// src/core/installationSettings.ts), and which capabilities are on. Read-only
// by construction: a config.yaml value changes with `deploy config` and a
// restart, a `defaults.*` value is overridden per channel on the Channels tab.

const props = defineProps<{ installation: InstallationView }>();

/** Rows grouped by their config.yaml block, in the projection's order. */
const groups = computed(() => {
  const out: { block: string; rows: InstallationView["settings"] }[] = [];
  for (const row of props.installation.settings) {
    const block = row.key.split(".")[0];
    const last = out[out.length - 1];
    if (last && last.block === block) last.rows.push(row);
    else out.push({ block, rows: [row] });
  }
  return out;
});

const HOW = {
  runtime: "config.yaml default · a channel overrides it at run time (Channels tab, `config set channel`)",
  config: "config.yaml · `deploy config`, then a restart",
} as const;

const onLabel = (on: boolean | string) => (typeof on === "string" ? on : on ? "on" : "off");
</script>

<template>
  <section class="grid gap-4">
    <p class="text-sm text-muted">
      The behaviour knobs of this installation's <code>config.yaml</code>, with the value in force. A running process
      keeps the config it started with: a change here is <code>deploy config</code> and a restart. The
      <code>defaults.*</code> rows are what a channel overrides on the Channels tab.
    </p>

    <div class="overflow-x-auto rounded-lg border border-default bg-elevated">
      <table class="settings w-full min-w-[42rem] border-collapse text-[0.8125rem]">
        <thead>
          <tr class="text-left font-mono text-[0.6875rem] uppercase tracking-widest text-dimmed">
            <th class="px-4 py-2.5 font-medium">Key</th>
            <th class="px-4 py-2.5 font-medium">Value</th>
            <th class="px-4 py-2.5 font-medium">What it does</th>
            <th class="px-4 py-2.5 font-medium">Changes in</th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.block">
          <tr class="border-t border-muted bg-muted/40">
            <th colspan="4" class="px-4 py-1.5 text-left font-mono text-xs font-medium text-toned">{{ g.block }}</th>
          </tr>
          <tr v-for="row in g.rows" :key="row.key" class="setting border-t border-muted align-top" :data-key="row.key">
            <td class="px-4 py-2 font-mono text-xs text-highlighted">{{ row.key }}</td>
            <td class="px-4 py-2 font-mono text-xs tabular-nums">
              <span class="value">{{ row.value }}</span>
              <span v-if="row.isDefault" class="ml-1.5 rounded bg-accented px-1.5 py-0.5 text-[0.625rem] text-muted"
                >default</span
              >
            </td>
            <td class="px-4 py-2 text-muted">{{ row.note }}</td>
            <td class="px-4 py-2 text-xs text-dimmed">{{ HOW[row.how] }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <h2 class="mt-2 font-mono text-xs font-medium uppercase tracking-wider text-muted">Capabilities</h2>
    <p class="-mt-3 text-sm text-muted">
      What is on in this process. Each one is a <code>config.yaml</code> block plus what its environment needs; the
      commands, dashboard section and Worker of a capability appear together when it is on.
    </p>
    <ul class="capabilities grid gap-1.5 rounded-lg border border-default bg-elevated px-4 py-3 text-sm">
      <li
        v-for="c in installation.capabilities"
        :key="c.key"
        class="capability flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-muted py-1.5 last:border-0"
        :data-capability="c.key"
        :data-on="String(c.on)"
      >
        <span class="w-40 font-mono text-xs text-highlighted">{{ c.key }}</span>
        <span
          class="state rounded px-1.5 py-0.5 font-mono text-[0.6875rem]"
          :class="c.on === false ? 'bg-accented text-dimmed' : 'bg-ok/15 text-ok'"
          >{{ onLabel(c.on) }}</span
        >
        <span class="text-xs text-muted">{{ c.how }}</span>
      </li>
    </ul>
  </section>
</template>
