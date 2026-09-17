<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { SettingsSeed, SettingsVocabulary } from "@core/channels/webSeed.js";
import { browser } from "../../lib/browser";
import ChannelPicker from "../ChannelPicker.vue";
import SettingSelect from "../SettingSelect.vue";
import { INPUT_CLASS, postCommand, type FetchLike } from "../../lib/settingsApi";

// The Channels tab: the index of configured channels (`config overrides`),
// then one channel's scope (`config show --channel`) as a form whose Save is
// `config set channel`, whose instructions box is `config instructions channel`
// and whose Clear is `config clear channel` — each one `POST /api/config.*`
// with `--channel` named (record 0041). `config set` PATCHES: a filled field is
// set, an empty one leaves the stored value alone; Clear drops every runtime
// override so the static config.yaml values show through again.

const props = defineProps<{
  channels: NonNullable<SettingsSeed["channels"]>;
  vocabulary: SettingsVocabulary;
  fetch?: FetchLike;
}>();

const fetchFn: FetchLike = (input, init) => (props.fetch ?? ((i, o) => globalThis.fetch(i, o)))(input, init);

const selected = computed(() => props.channels.selected ?? null);
const viewer = computed(() => props.channels.viewer ?? null);
/** The viewer's own scope, as `key: value` lines; an empty scope is a sentence, never a blank. */
const viewerScopeLines = computed((): string[] => {
  const s = viewer.value?.user;
  if (!s) return [];
  const lines: string[] = [];
  if (s.agent) lines.push(`agent ${s.agent}`);
  if (s.model) lines.push(`model ${s.model}`);
  for (const [a, m] of Object.entries(s.models ?? {})) lines.push(`${a} → ${m}`);
  if (s.effort) lines.push(`effort ${s.effort}`);
  for (const [a, e] of Object.entries(s.efforts ?? {})) lines.push(`${a} effort ${e}`);
  for (const [a, h] of Object.entries(s.harness ?? {})) lines.push(`${a} on ${h}`);
  if (s.boundary?.maxMinutes) lines.push(`at most ${s.boundary.maxMinutes} min`);
  if (s.boundary?.maxIdentity) lines.push(`identity ≤ ${s.boundary.maxIdentity}`);
  if (s.boundary?.machines) lines.push(`machines ${s.boundary.machines.join(", ")}`);
  if (s.instructions) lines.push(`instructions (${s.instructions.length} chars)`);
  return lines;
});
const scope = computed(() => selected.value?.scope?.channel ?? null);
/** The selects' options as data (Nuxt UI `USelect`): the empty value is the "leave it" choice, spelled out. */
const agentItems = computed(() => [
  { label: `— the default (${selected.value?.scope?.defaults.agent ?? "general"}), or the router —`, value: "" },
  ...props.vocabulary.agents.map((a) => {
    const restricted = selected.value?.scope?.restrictedAgents.includes(a) ?? false;
    return { label: restricted ? `${a} (restricted)` : a, value: a, disabled: restricted };
  }),
]);
const effortItems = computed(() => [
  { label: "— unset —", value: "" },
  ...props.vocabulary.efforts.map((e) => ({ label: e, value: e })),
]);
const identityItems = computed(() => [
  { label: "— uncapped —", value: "" },
  ...props.vocabulary.identities.map((i) => ({ label: i, value: i })),
]);
/** A channel as a person reads it: `#name` when the directory knew it, the id otherwise (the id
 *  stays in the tooltip and the data attribute either way). */
const channelLabel = (c: { channelId: string; channelName?: string }): string =>
  c.channelName ? `#${c.channelName}` : c.channelId;

/** The channels the viewer may open, by name (`config channels`); the picker's options. */
const pickable = computed(() => props.channels.pickable?.channels ?? []);
/** Picking a channel opens it: the combobox's value is the channel id. */
function openPicked(id: string): void {
  if (id) browser.navigate(`/settings/channels/${encodeURIComponent(id)}`);
}
/** Typed as an id when nothing could be listed (no bot channel list, no scoped channel). */
const openField = ref("");
function open(): void {
  openPicked(openField.value.trim());
}

const form = reactive({
  agent: scope.value?.agent ?? "",
  model: scope.value?.model ?? "",
  models: Object.fromEntries(props.vocabulary.agents.map((a) => [a, scope.value?.models?.[a] ?? ""])) as Record<
    string,
    string
  >,
  effort: scope.value?.effort ?? "",
  efforts: Object.fromEntries(props.vocabulary.agents.map((a) => [a, scope.value?.efforts?.[a] ?? ""])) as Record<
    string,
    string
  >,
  maxMinutes: scope.value?.boundary?.maxMinutes?.toString() ?? "",
  maxIdentity: scope.value?.boundary?.maxIdentity ?? "",
  machines: new Set<string>(scope.value?.boundary?.machines ?? []),
  instructions: scope.value?.instructions ?? "",
});
const busy = ref(false);
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);

const canWrite = computed(() => selected.value?.canWrite === true);

function toggleMachine(m: string, on: boolean): void {
  if (on) form.machines.add(m);
  else form.machines.delete(m);
}

/** The filled fields, by the command's option names; nothing for an empty field. */
function patch(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.agent) out.agent = form.agent;
  if (form.model.trim()) out.model = form.model.trim();
  const models = Object.fromEntries(Object.entries(form.models).filter(([, v]) => v.trim()));
  if (Object.keys(models).length) out.models = models;
  if (form.effort) out.effort = form.effort;
  const efforts = Object.fromEntries(Object.entries(form.efforts).filter(([, v]) => v));
  if (Object.keys(efforts).length) out.efforts = efforts;
  const boundary: Record<string, unknown> = {};
  if (form.maxMinutes.trim()) boundary.maxMinutes = Number(form.maxMinutes);
  if (form.maxIdentity) boundary.maxIdentity = form.maxIdentity;
  if (form.machines.size) boundary.machines = [...form.machines].join(",");
  if (Object.keys(boundary).length) out.boundary = boundary;
  return out;
}

async function run(id: string, body: Record<string, unknown>, okText: string): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  notice.value = null;
  const answer = await postCommand(fetchFn, id, { scope: "channel", channel: selected.value.channelId, ...body });
  busy.value = false;
  if (!answer.ok) {
    notice.value = { kind: "error", text: answer.failure.message };
    return;
  }
  notice.value = { kind: "ok", text: okText };
  browser.reload();
}

const save = () => run("config.set", patch(), "Saved.");
const saveInstructions = () => run("config.instructions", { text: form.instructions.trim() }, "Instructions saved.");
const clearInstructions = () => run("config.instructions", { text: "" }, "Instructions cleared.");
async function clearAll(): Promise<void> {
  if (!selected.value) return;
  if (
    !browser.confirm(
      `Drop every runtime override of ${selected.value.channelId}? Static config.yaml values show through again.`,
    )
  )
    return;
  await run("config.clear", {}, "Cleared.");
}

const SOURCE_LABEL = { config: "config.yaml", runtime: "runtime", both: "config.yaml + runtime" } as const;
</script>

<template>
  <section class="grid gap-4">
    <p class="text-sm text-muted">
      What a run gets is layered: the installation defaults, then the channel's scope, then your own settings (<code
        >config set me</code
      >). This tab shows yours and lets you set a channel's.
    </p>

    <!-- The viewer's settings, always: every installation has defaults and every viewer a scope (record 0041). -->
    <section
      v-if="viewer"
      class="mine grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4 text-sm sm:grid-cols-3"
      aria-labelledby="mine-heading"
    >
      <h2 id="mine-heading" class="font-mono text-xs font-medium uppercase tracking-wider text-muted sm:col-span-3">
        Your settings
      </h2>
      <div class="grid content-start gap-1">
        <span class="text-xs text-dimmed">A run you ask for outside any channel gets</span>
        <span class="effective font-mono text-xs text-highlighted"
          >agent {{ viewer.effective.agent }} · {{ viewer.effective.model
          }}<template v-if="viewer.effective.effort"> · effort {{ viewer.effective.effort }}</template></span
        >
      </div>
      <div class="grid content-start gap-1">
        <span class="text-xs text-dimmed">Installation defaults</span>
        <span class="defaults font-mono text-xs text-muted">
          agent {{ viewer.defaults.agent }}
          <template v-for="(m, a) in viewer.defaults.models" :key="a"><br />{{ a }} → {{ m }}</template>
        </span>
      </div>
      <div class="grid content-start gap-1">
        <span class="text-xs text-dimmed">Yours (<code>config set me</code>)</span>
        <span v-if="viewerScopeLines.length > 0" class="yours font-mono text-xs text-muted">
          <template v-for="(line, i) in viewerScopeLines" :key="line"><br v-if="i > 0" />{{ line }}</template>
        </span>
        <span v-else class="yours text-xs text-muted">Nothing of your own yet — the defaults apply.</span>
      </div>
    </section>
    <p
      v-else-if="channels.viewerUnavailable"
      class="unavailable rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm"
    >
      {{ channels.viewerUnavailable }}
    </p>

    <div class="grid gap-3 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
      <aside class="grid content-start gap-3">
        <div class="overflow-hidden rounded-lg border border-default bg-elevated">
          <h2
            class="border-b border-muted px-4 py-2 font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed"
          >
            Configured channels
          </h2>
          <p v-if="channels.unavailable" class="unavailable px-4 py-3 text-sm text-warn">{{ channels.unavailable }}</p>
          <p v-else-if="channels.index.length === 0" class="empty px-4 py-3 text-sm text-muted">
            Every channel runs on the defaults. Open one below to give it settings of its own.
          </p>
          <ul v-else class="index text-sm">
            <li
              v-for="row in channels.index"
              :key="row.channelId"
              class="border-b border-muted last:border-0"
              :data-channel="row.channelId"
            >
              <a
                class="grid gap-0.5 px-4 py-2 no-underline hover:bg-(--ui-bg-muted)"
                :href="`/settings/channels/${encodeURIComponent(row.channelId)}`"
                :aria-current="selected?.channelId === row.channelId ? 'page' : undefined"
              >
                <span class="font-mono text-xs font-medium text-highlighted" :title="row.channelId">{{
                  channelLabel(row)
                }}</span>
                <span class="text-xs text-muted">{{ row.settings.join(", ") }} · {{ SOURCE_LABEL[row.source] }}</span>
              </a>
            </li>
          </ul>
        </div>
        <div class="picker grid gap-2">
          <ChannelPicker
            v-if="pickable.length > 0"
            id="channel-pick"
            :channels="pickable"
            :model-value="selected?.channelId ?? ''"
            :extra="selected?.channelId"
            placeholder="Search channels…"
            aria-label="channel to open"
            @update:model-value="openPicked"
          />
          <form v-else class="flex items-center gap-2" @submit.prevent="open">
            <input
              id="channel-open"
              v-model="openField"
              :class="INPUT_CLASS"
              class="flex-1 font-mono text-xs"
              placeholder="slack:C0123… — a channel id"
              aria-label="channel id to open"
            />
            <UButton type="submit" size="xs" color="neutral" variant="outline">Open</UButton>
          </form>
          <p v-if="pickable.length > 0 && channels.pickable?.listed === false" class="text-xs text-dimmed">
            The bot could not list its channels; only the channels that already carry settings are offered.
          </p>
        </div>
      </aside>

      <div
        v-if="!selected"
        class="placeholder rounded-lg border border-dashed border-default px-5 py-8 text-center text-sm text-muted"
      >
        Pick a channel on the left to see and change its own settings.
      </div>

      <div v-else-if="selected.refused" class="refused rounded-lg border border-warn/30 bg-warn/10 px-5 py-4 text-sm">
        <span class="font-mono text-xs" :title="selected.channelId">{{ channelLabel(selected) }}</span> ·
        {{ selected.refused }}
      </div>

      <div v-else-if="scope && selected.scope" class="scope grid gap-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-mono text-sm font-medium text-highlighted" :title="selected.channelId">
            {{ channelLabel(selected)
            }}<span v-if="selected.channelName" class="ml-2 text-xs font-normal text-dimmed">{{
              selected.channelId
            }}</span>
          </h2>
          <p class="effective text-xs text-muted">
            Runs here get agent <code>{{ selected.scope.effective.agent }}</code
            >, model <code>{{ selected.scope.effective.model }}</code
            ><template v-if="selected.scope.effective.effort"
              >, effort <code>{{ selected.scope.effective.effort }}</code></template
            >
          </p>
        </div>
        <p v-if="!canWrite" class="restricted text-xs text-muted">
          Read-only: channel config changes need the channel-config right. {{ selected.scope.adminsHint }}
        </p>

        <form
          class="agent-form grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4"
          @submit.prevent="save"
        >
          <h3 class="font-mono text-xs font-medium uppercase tracking-wider text-muted">Agent, model, effort</h3>
          <div class="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <label class="text-sm text-muted" for="ch-agent">Agent</label>
            <SettingSelect
              id="ch-agent"
              v-model="form.agent"
              :items="agentItems"
              class="w-full"
              :disabled="!canWrite"
            />
            <label class="text-sm text-muted" for="ch-model">Model, any agent</label>
            <input
              id="ch-model"
              v-model="form.model"
              :class="INPUT_CLASS"
              class="font-mono text-xs"
              placeholder="provider/model — forces every run's model"
              :disabled="!canWrite"
            />
            <span class="text-sm text-muted">Model per agent</span>
            <div class="grid gap-1.5">
              <label
                v-for="a in vocabulary.agents"
                :key="a"
                class="grid grid-cols-[6rem_1fr] items-center gap-2 font-mono text-xs"
              >
                <span class="text-muted">{{ a }}</span>
                <input
                  v-model="form.models[a]"
                  :name="`models.${a}`"
                  :class="INPUT_CLASS"
                  class="font-mono text-xs"
                  :placeholder="selected.scope.defaults.models[a] ?? 'default'"
                  :disabled="!canWrite"
                />
              </label>
            </div>
            <label class="text-sm text-muted" for="ch-effort">Effort, any agent</label>
            <SettingSelect
              id="ch-effort"
              v-model="form.effort"
              :items="effortItems"
              class="w-full"
              :disabled="!canWrite"
            />
            <span class="text-sm text-muted">Effort per agent</span>
            <div class="grid gap-1.5">
              <label
                v-for="a in vocabulary.agents"
                :key="a"
                class="grid grid-cols-[6rem_1fr] items-center gap-2 font-mono text-xs"
              >
                <span class="text-muted">{{ a }}</span>
                <SettingSelect
                  v-model="form.efforts[a]"
                  :name="`efforts.${a}`"
                  :items="effortItems"
                  class="w-full"
                  :disabled="!canWrite"
                />
              </label>
            </div>
          </div>

          <h3 class="mt-2 font-mono text-xs font-medium uppercase tracking-wider text-muted">
            Boundary · caps every run here, never grants
          </h3>
          <div class="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <label class="text-sm text-muted" for="ch-minutes">Max minutes</label>
            <input
              id="ch-minutes"
              v-model="form.maxMinutes"
              :class="INPUT_CLASS"
              class="w-28 font-mono text-xs tabular-nums"
              type="number"
              min="2"
              placeholder="uncapped"
              :disabled="!canWrite"
            />
            <label class="text-sm text-muted" for="ch-identity">Max identity</label>
            <SettingSelect
              id="ch-identity"
              v-model="form.maxIdentity"
              :items="identityItems"
              class="w-full"
              :disabled="!canWrite"
            />
            <span class="text-sm text-muted">Machines</span>
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              <label
                v-for="m in vocabulary.machines"
                :key="m"
                class="inline-flex items-center gap-1.5 font-mono text-xs"
              >
                <input
                  type="checkbox"
                  :name="`machine-${m}`"
                  :checked="form.machines.has(m)"
                  :disabled="!canWrite"
                  @change="toggleMachine(m, ($event.target as HTMLInputElement).checked)"
                />
                {{ m }}
              </label>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <UButton type="submit" size="sm" color="neutral" :disabled="!canWrite || busy">Save</UButton>
            <UButton size="sm" color="error" variant="ghost" :disabled="!canWrite || busy" @click="clearAll"
              >Clear every override</UButton
            >
            <span class="text-xs text-dimmed">Save sets the filled fields and leaves the rest as they are.</span>
          </div>
        </form>

        <form
          class="instructions-form grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4"
          @submit.prevent="saveInstructions"
        >
          <h3 class="font-mono text-xs font-medium uppercase tracking-wider text-muted">
            Custom instructions · advisory, on every run here
          </h3>
          <textarea
            id="ch-instructions"
            v-model="form.instructions"
            :class="INPUT_CLASS"
            class="min-h-28 w-full"
            maxlength="2000"
            placeholder="Always reply in bullet points."
            :disabled="!canWrite"
          />
          <div class="flex flex-wrap items-center gap-3">
            <UButton type="submit" size="sm" color="neutral" :disabled="!canWrite || busy">Save instructions</UButton>
            <UButton size="sm" color="neutral" variant="ghost" :disabled="!canWrite || busy" @click="clearInstructions"
              >Clear instructions</UButton
            >
            <span class="text-xs text-dimmed tabular-nums">{{ form.instructions.length }} / 2000</span>
          </div>
        </form>

        <p
          v-if="notice"
          class="notice rounded-md px-3 py-2 text-sm"
          :class="notice.kind === 'error' ? 'border border-err/30 bg-err/10' : 'border border-ok/30 bg-ok/10'"
        >
          {{ notice.text }}
        </p>
      </div>
    </div>
  </section>
</template>
