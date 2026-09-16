<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { SettingsSeed, SettingsVocabulary } from "@core/channels/webSeed.js";
import type { McpServerView } from "@core/mcp/registry.js";
import { browser } from "../../lib/browser";
import { getCommand, INPUT_CLASS, postCommand, SELECT_CLASS, type FetchLike } from "../../lib/settingsApi";

// The MCPs tab: `mcp list` as a table, an add form, a connect link and a
// remove button — every action one `POST /api/mcp.*` (record 0041). Org and
// channel are always offered; `me` only when the session is linked to its
// person (record 0042: the seed's `asUser`), because an unlinked browser
// session is not the identity a run is requested as, and the handler refuses
// it anyway. A credential never passes through this page: `add` and `connect`
// hand back a one-time link to the Access-gated connect form.

type Tier = "org" | "channel" | "me";

const props = defineProps<{
  mcps: NonNullable<SettingsSeed["mcps"]>;
  vocabulary: SettingsVocabulary;
  viewer: string;
  /** The person the session is linked to; present → the `me` tier is theirs and offered here. */
  asUser?: { id: string; name?: string };
  fetch?: FetchLike;
}>();

const fetchFn: FetchLike = (input, init) => (props.fetch ?? ((i, o) => globalThis.fetch(i, o)))(input, init);

const SELF_SERVE_AGENTS = ["general", "research"];
const linked = computed(() => props.asUser !== undefined);

const form = reactive({
  name: "",
  url: "",
  scope: (props.mcps.channel ? "channel" : props.asUser ? "me" : "org") as Tier,
  agents: new Set<string>(SELF_SERVE_AGENTS),
  auth: "" as "" | "oauth" | "bearer" | "none",
});
const channelField = ref(props.mcps.channel ?? "");
const busy = ref(false);
/** The last action's outcome, shown under the form: a connect link, or the handler's refusal as is. */
const notice = ref<{ kind: "ok" | "error"; text: string; connectUrl?: string } | null>(null);
/** A `mcp show` probe's answer, per server name. */
const probes = reactive<Record<string, string>>({});

const canAdd = computed(() =>
  form.scope === "org"
    ? props.mcps.canWrite.org
    : form.scope === "channel"
      ? props.mcps.canWrite.channel
      : linked.value,
);
/** A user-tier row is the viewer's own when it is the linked person's. */
const canWriteRow = (s: McpServerView) =>
  s.scope === "org"
    ? props.mcps.canWrite.org
    : s.scope === "channel"
      ? props.mcps.canWrite.channel
      : props.asUser !== undefined && s.scopeKey === `user:${props.asUser.id}`;
const isMine = (s: McpServerView) =>
  s.addedBy === props.viewer || (props.asUser !== undefined && s.addedBy === props.asUser.id);

const STATE_LABEL: Record<McpServerView["state"], string> = {
  connected: "connected",
  awaiting_credential: "awaiting credential",
  static: "pinned in config.yaml",
};

/** `?channel=` is part of the page's URL: another channel is another page load. */
function openChannel(): void {
  const id = channelField.value.trim();
  browser.navigate(id ? `/settings/mcps?channel=${encodeURIComponent(id)}` : "/settings/mcps");
}

function toggleAgent(agent: string, on: boolean): void {
  if (on) form.agents.add(agent);
  else form.agents.delete(agent);
}

/** The target tier's options, by name as the command takes them; `me` only for a linked session (the handler refuses it otherwise). */
function tier(scope: Tier): Record<string, unknown> {
  if (scope === "channel") return { scope: "channel", channel: props.mcps.channel };
  return { scope };
}
const tierOf = (s: McpServerView): Tier => (s.scope === "user" ? "me" : s.scope);

async function add(): Promise<void> {
  busy.value = true;
  notice.value = null;
  const answer = await postCommand(fetchFn, "mcp.add", {
    name: form.name.trim(),
    url: form.url.trim(),
    ...tier(form.scope),
    agents: [...form.agents].join(","),
    ...(form.auth ? { auth: form.auth } : {}),
  });
  busy.value = false;
  if (!answer.ok) {
    notice.value = { kind: "error", text: answer.failure.message };
    return;
  }
  const v = answer.value as { connectUrl?: string; server?: { name?: string; state?: string } };
  notice.value = v.connectUrl
    ? {
        kind: "ok",
        text: `Added ${v.server?.name ?? form.name}. Open the one-time link to connect it (it expires in 10 minutes; only you can complete it).`,
        connectUrl: v.connectUrl,
      }
    : { kind: "ok", text: `Added ${v.server?.name ?? form.name}.` };
  if (!v.connectUrl) browser.reload();
}

async function connect(s: McpServerView): Promise<void> {
  busy.value = true;
  notice.value = null;
  const answer = await postCommand(fetchFn, "mcp.connect", { name: s.name, ...tier(tierOf(s)) });
  busy.value = false;
  if (!answer.ok) {
    notice.value = { kind: "error", text: answer.failure.message };
    return;
  }
  const v = answer.value as { connectUrl?: string };
  notice.value = {
    kind: "ok",
    text: `A fresh one-time link for ${s.name} (10 minutes; only you can complete it).`,
    ...(v.connectUrl ? { connectUrl: v.connectUrl } : {}),
  };
}

async function remove(s: McpServerView): Promise<void> {
  if (!browser.confirm(`Remove ${s.name} from the ${s.scope} tier and forget its stored credential?`)) return;
  busy.value = true;
  notice.value = null;
  const answer = await postCommand(fetchFn, "mcp.remove", { name: s.name, ...tier(tierOf(s)) });
  busy.value = false;
  if (!answer.ok) {
    notice.value = { kind: "error", text: answer.failure.message };
    return;
  }
  browser.reload();
}

async function probe(s: McpServerView): Promise<void> {
  probes[s.name] = "probing…";
  const answer = await getCommand(fetchFn, "mcp.show", {
    name: s.name,
    scope: s.scope === "user" ? "me" : s.scope,
    channel: s.scope === "channel" ? props.mcps.channel : undefined,
  });
  if (!answer.ok) {
    probes[s.name] = answer.failure.message;
    return;
  }
  const { probe: result } = answer.value as { probe?: { ok: boolean; tools?: { name: string }[]; error?: string } };
  probes[s.name] = result?.tools
    ? `${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}: ${result.tools.map((t) => t.name).join(", ")}`
    : (result?.error ?? "no tools listed");
}
</script>

<template>
  <section class="grid gap-4">
    <p class="text-sm text-muted">
      External MCP servers a run's tools may call, by tier: <strong>org</strong> reaches every run and is the only tier
      that may name the coding, review or ship agents; <strong>channel</strong> reaches that channel's runs;
      <template v-if="asUser"
        ><strong>me</strong> reaches the runs you ask for as {{ asUser.name ?? asUser.id }}.</template
      ><template v-else
        >personal servers are added in chat (<code>mcp add</code>), where your runs are requested as you.</template
      >
    </p>

    <form class="flex flex-wrap items-center gap-2 text-sm" @submit.prevent="openChannel">
      <label class="text-muted" for="mcp-channel">Channel tier</label>
      <input
        id="mcp-channel"
        v-model="channelField"
        :class="INPUT_CLASS"
        class="font-mono text-xs"
        placeholder="slack:C0123… (blank: org and your own)"
        aria-label="channel whose MCP servers to list"
      />
      <UButton type="submit" size="xs" color="neutral" variant="outline">Open</UButton>
    </form>

    <p v-if="mcps.unavailable" class="unavailable rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
      {{ mcps.unavailable }}
    </p>

    <div v-else class="overflow-x-auto rounded-lg border border-default bg-elevated">
      <table class="servers w-full min-w-[46rem] border-collapse text-[0.8125rem]">
        <thead>
          <tr class="text-left font-mono text-[0.6875rem] uppercase tracking-widest text-dimmed">
            <th class="px-4 py-2.5 font-medium">Name</th>
            <th class="px-4 py-2.5 font-medium">Tier</th>
            <th class="px-4 py-2.5 font-medium">URL</th>
            <th class="px-4 py-2.5 font-medium">Agents</th>
            <th class="px-4 py-2.5 font-medium">Auth</th>
            <th class="px-4 py-2.5 font-medium">State</th>
            <th class="px-4 py-2.5 font-medium"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="mcps.servers.length === 0">
            <td colspan="7" class="empty px-4 py-6 text-center text-muted">
              No MCP server reaches runs here yet. Add one below.
            </td>
          </tr>
          <tr
            v-for="s in mcps.servers"
            :key="`${s.scopeKey}/${s.name}`"
            class="server border-t border-muted align-top"
            :data-name="s.name"
            :data-scope="s.scope"
          >
            <td class="px-4 py-2 font-mono text-xs font-medium text-highlighted">
              {{ s.name }}
              <span v-if="isMine(s)" class="ml-1 text-[0.625rem] font-normal text-dimmed">· added by you</span>
            </td>
            <td class="px-4 py-2 font-mono text-xs">{{ s.scope }}</td>
            <td class="max-w-[18rem] truncate px-4 py-2 font-mono text-xs text-muted" :title="s.url">{{ s.url }}</td>
            <td class="px-4 py-2 font-mono text-xs">{{ s.agents.join(", ") }}</td>
            <td class="px-4 py-2 font-mono text-xs">{{ s.auth }}</td>
            <td class="px-4 py-2 text-xs">
              <span
                class="state rounded px-1.5 py-0.5 font-mono text-[0.6875rem]"
                :class="
                  s.state === 'connected'
                    ? 'bg-ok/15 text-ok'
                    : s.state === 'awaiting_credential'
                      ? 'bg-warn/15 text-warn'
                      : 'bg-accented text-muted'
                "
                >{{ STATE_LABEL[s.state] }}</span
              >
              <div v-if="probes[s.name]" class="probe mt-1 text-dimmed">{{ probes[s.name] }}</div>
            </td>
            <td class="px-4 py-1.5 text-right whitespace-nowrap">
              <UButton size="xs" color="neutral" variant="ghost" :disabled="busy" @click="probe(s)">Probe</UButton>
              <UButton
                v-if="s.source === 'runtime' && s.auth !== 'none'"
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="busy || !canWriteRow(s)"
                @click="connect(s)"
                >Connect</UButton
              >
              <UButton
                v-if="s.source === 'runtime'"
                size="xs"
                color="error"
                variant="ghost"
                :disabled="busy || !canWriteRow(s)"
                @click="remove(s)"
                >Remove</UButton
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form
      v-if="!mcps.unavailable"
      class="add grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4"
      @submit.prevent="add"
    >
      <h2 class="font-mono text-xs font-medium uppercase tracking-wider text-muted">Add a server</h2>
      <div class="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <label class="text-sm text-muted" for="mcp-name">Name</label>
        <input
          id="mcp-name"
          v-model="form.name"
          :class="INPUT_CLASS"
          class="font-mono text-xs"
          required
          pattern="[a-z0-9][a-z0-9-]{0,31}"
          placeholder="notion — becomes the tool prefix mcp__notion__"
          :disabled="!canAdd"
        />
        <label class="text-sm text-muted" for="mcp-url">URL</label>
        <input
          id="mcp-url"
          v-model="form.url"
          :class="INPUT_CLASS"
          class="font-mono text-xs"
          type="url"
          required
          placeholder="https://mcp.example.com/mcp — Streamable HTTP"
          :disabled="!canAdd"
        />
        <label class="text-sm text-muted" for="mcp-scope">Tier</label>
        <select
          id="mcp-scope"
          v-model="form.scope"
          :class="SELECT_CLASS"
          :disabled="!canAdd && !mcps.canWrite.org && !mcps.canWrite.channel && !linked"
        >
          <option value="me" :disabled="!linked">
            me —
            {{
              asUser ? `your own runs, as ${asUser.name ?? asUser.id}` : "your session is not linked to a Slack user"
            }}
          </option>
          <option value="org">org — every run; may name coding, review, ship</option>
          <option value="channel" :disabled="!mcps.channel">
            channel — {{ mcps.channel ?? "open a channel above first" }}
          </option>
        </select>
        <span class="text-sm text-muted">Agents</span>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <label v-for="a in vocabulary.agents" :key="a" class="inline-flex items-center gap-1.5 font-mono text-xs">
            <input
              type="checkbox"
              :name="`agent-${a}`"
              :checked="form.agents.has(a)"
              :disabled="!canAdd || (form.scope === 'channel' && !SELF_SERVE_AGENTS.includes(a))"
              @change="toggleAgent(a, ($event.target as HTMLInputElement).checked)"
            />
            {{ a }}
          </label>
        </div>
        <label class="text-sm text-muted" for="mcp-auth">Auth</label>
        <select id="mcp-auth" v-model="form.auth" :class="SELECT_CLASS" :disabled="!canAdd">
          <option value="">detect from the server</option>
          <option value="oauth">oauth — sign in on a one-time link</option>
          <option value="bearer">bearer — paste a token on a one-time link</option>
          <option value="none">none</option>
        </select>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <UButton type="submit" size="sm" color="neutral" :disabled="!canAdd || busy">Add</UButton>
        <span v-if="!canAdd" class="restricted text-xs text-muted">
          {{
            form.scope === "org"
              ? "Org-wide servers are managed by admins (repo-management rights)."
              : form.scope === "channel"
                ? "This channel's servers need channel-config rights."
                : "Personal servers need a session linked to your Slack user; add yours in chat with `mcp add`."
          }}
        </span>
      </div>
      <p
        v-if="notice"
        class="notice rounded-md px-3 py-2 text-sm"
        :class="notice.kind === 'error' ? 'border border-err/30 bg-err/10' : 'border border-ok/30 bg-ok/10'"
      >
        {{ notice.text }}
        <a v-if="notice.connectUrl" class="connect ml-1 font-mono text-xs underline" :href="notice.connectUrl">{{
          notice.connectUrl
        }}</a>
      </p>
    </form>
  </section>
</template>
