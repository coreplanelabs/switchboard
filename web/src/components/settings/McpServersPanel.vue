<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from "vue";
import type { SettingsSeed, SettingsVocabulary } from "@core/channels/webSeed.js";
import type { McpServerView } from "@core/mcp/registry.js";
import { browser } from "../../lib/browser";
import { AGENT_HUE, agentHue } from "../../lib/indexRow";
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

/** While a connect link is out (it opens in a new tab), the page watches the row it was minted
 *  for — one `mcp list` every few seconds, bounded by the link's own life — and reloads when the
 *  row's state changes, so closing the connect tab lands back on an up-to-date list. */
const WATCH_EVERY_MS = 4_000;
/** The link lives ten minutes: that many ticks, counted — the page reads no clock. */
const WATCH_TICKS = (10 * 60_000) / WATCH_EVERY_MS;
const watching = ref(false);
let watchTimer: ReturnType<typeof setTimeout> | undefined;
const stopWatching = (): void => {
  if (watchTimer !== undefined) clearTimeout(watchTimer);
  watchTimer = undefined;
  watching.value = false;
};
onUnmounted(stopWatching);
function watchRow(name: string, scopeKey: string, was: McpServerView["state"] | undefined): void {
  stopWatching();
  watching.value = true;
  let ticks = 0;
  const tick = async (): Promise<void> => {
    ticks += 1;
    const answer = await getCommand(fetchFn, "mcp.list", props.mcps.allTiers ? { all: "true" } : {});
    const rows = answer.ok ? ((answer.value as { servers?: McpServerView[] }).servers ?? []) : [];
    const row = rows.find((r) => r.name === name && r.scopeKey === scopeKey);
    if (row && row.state !== was) {
      stopWatching();
      browser.reload();
      return;
    }
    if (ticks >= WATCH_TICKS) {
      stopWatching();
      return;
    }
    watchTimer = setTimeout(() => void tick(), WATCH_EVERY_MS);
  };
  watchTimer = setTimeout(() => void tick(), WATCH_EVERY_MS);
}

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
/** Whose a user-tier row is: the id after `user:` in its scope key. */
const ownerOf = (s: McpServerView): string => (s.scope === "user" ? s.scopeKey.slice("user:".length) : "");
/** Who added it, as the service could name them; the id otherwise (record 0042). */
const addedBy = (s: McpServerView): string => (isMine(s) ? "you" : (s.addedByName ?? s.addedBy ?? ""));
/** Promote (record 0042): a person's runtime server re-issued in the org tier by an org admin. */
const canPromote = (s: McpServerView) =>
  s.scope === "user" && s.source === "runtime" && props.mcps.canWrite.org && !s.shadowedBy;

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
  const v = answer.value as {
    connectUrl?: string;
    server?: { name?: string; scopeKey?: string; state?: McpServerView["state"] };
  };
  notice.value = v.connectUrl
    ? {
        kind: "ok",
        text: `Added ${v.server?.name ?? form.name}. Open the one-time link to connect it (it expires in 10 minutes; only you can complete it).`,
        connectUrl: v.connectUrl,
      }
    : { kind: "ok", text: `Added ${v.server?.name ?? form.name}.` };
  if (!v.connectUrl) browser.reload();
  else if (v.server?.name && v.server.scopeKey) watchRow(v.server.name, v.server.scopeKey, v.server.state);
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
  // A re-key keeps the state `connected`, so the watcher would see no change: watch the
  // awaiting row only. (A connected row's re-key is a quiet success either way.)
  if (v.connectUrl && s.state === "awaiting_credential") watchRow(s.name, s.scopeKey, s.state);
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

async function promote(s: McpServerView): Promise<void> {
  if (
    !browser.confirm(
      `Promote ${s.name} to the org tier? The org gets its own copy under the same name — ${s.ownerName ?? ownerOf(s)}'s credential is never copied; a bearer or oauth server needs you to connect it. Their personal entry retires once the org copy works.`,
    )
  )
    return;
  busy.value = true;
  notice.value = null;
  const answer = await postCommand(fetchFn, "mcp.promote", { name: s.name, from: ownerOf(s) });
  busy.value = false;
  if (!answer.ok) {
    notice.value = { kind: "error", text: answer.failure.message };
    return;
  }
  const v = answer.value as { connectUrl?: string };
  notice.value = v.connectUrl
    ? {
        kind: "ok",
        text: `${s.name} is now an org server awaiting your credential. Open the one-time link to connect it (10 minutes; only you can complete it).`,
        connectUrl: v.connectUrl,
      }
    : { kind: "ok", text: `${s.name} is now an org server.` };
  if (!v.connectUrl) browser.reload();
  else watchRow(s.name, "org", "awaiting_credential");
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
  <section class="grid gap-5">
    <!-- One line per fact the reader needs before the table; the long version is the spec's. -->
    <div class="grid gap-1 text-sm text-muted">
      <p>
        External MCP servers a run's tools may call.
        <span class="ml-1 inline-flex flex-wrap gap-x-3 gap-y-1">
          <span><strong class="text-toned">org</strong> · every run</span>
          <span><strong class="text-toned">channel</strong> · that channel's runs</span>
          <span v-if="asUser"
            ><strong class="text-toned">me</strong> · the runs you ask for as {{ asUser.name ?? asUser.id }}</span
          >
          <span v-else><strong class="text-toned">me</strong> · added in chat with <code>mcp add</code></span>
        </span>
      </p>
      <p v-if="mcps.allTiers" class="text-xs text-dimmed">
        You see every tier. <strong class="font-medium text-muted">Promote</strong> gives the org its own copy of a
        person's server under the same name, connected by you — their credential is never copied, and their entry
        retires once the org copy works.
      </p>
    </div>

    <form class="flex flex-wrap items-center gap-2 text-sm" @submit.prevent="openChannel">
      <label class="text-muted" for="mcp-channel">Channel</label>
      <input
        id="mcp-channel"
        v-model="channelField"
        :class="INPUT_CLASS"
        class="w-56 font-mono text-xs"
        placeholder="slack:C0123…"
        aria-label="channel whose MCP servers to list"
      />
      <UButton type="submit" size="xs" color="neutral" variant="outline">Open</UButton>
      <span class="text-xs text-dimmed">{{
        mcps.channel ? `Listing ${mcps.channel}'s tier beside the rest.` : "Blank: the org's and your own."
      }}</span>
    </form>

    <p v-if="mcps.unavailable" class="unavailable rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
      {{ mcps.unavailable }}
    </p>

    <div v-else class="overflow-x-auto rounded-lg border border-default bg-elevated">
      <table class="servers w-full min-w-[60rem] border-collapse text-[0.8125rem]">
        <thead>
          <tr class="text-left font-mono text-[0.6875rem] uppercase tracking-widest text-dimmed">
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">Name</th>
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">Tier</th>
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">URL</th>
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">Agents</th>
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">Auth</th>
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">State</th>
            <th class="px-3 py-2.5 font-medium whitespace-nowrap">Added by</th>
            <th class="px-3 py-2.5 font-medium"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="mcps.servers.length === 0">
            <td colspan="8" class="empty px-4 py-6 text-center text-muted">
              No MCP server reaches runs here yet. Add one below.
            </td>
          </tr>
          <tr
            v-for="s in mcps.servers"
            :key="`${s.scopeKey}/${s.name}`"
            class="server border-t border-muted align-middle"
            :class="s.shadowedBy ? 'shadowed text-dimmed' : ''"
            :data-name="s.name"
            :data-scope="s.scope"
            :data-shadowed-by="s.shadowedBy"
          >
            <td class="px-3 py-2.5 font-mono text-xs font-medium whitespace-nowrap text-highlighted">{{ s.name }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">
              <span class="tier rounded border border-accented px-1.5 py-0.5 font-mono text-[0.6875rem] text-toned">{{
                s.scope
              }}</span>
              <span v-if="ownerOf(s)" class="owner mt-1 block text-[0.6875rem] text-dimmed" :title="ownerOf(s)">{{
                s.ownerName ?? ownerOf(s)
              }}</span>
            </td>
            <td class="px-3 py-2.5">
              <span class="block max-w-[11rem] truncate font-mono text-xs text-muted" :title="s.url">{{ s.url }}</span>
            </td>
            <td class="min-w-[11rem] px-3 py-2.5">
              <!-- The run page's agent chips (indexRow's hue allow-list), so an agent reads the same everywhere. -->
              <span class="agents flex flex-wrap gap-1">
                <span
                  v-for="a in s.agents"
                  :key="a"
                  class="agent rounded border px-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-wider"
                  :class="AGENT_HUE[agentHue(a)]"
                  :data-agent-hue="agentHue(a)"
                  >{{ a }}</span
                >
              </span>
            </td>
            <td class="px-3 py-2.5 font-mono text-xs whitespace-nowrap">{{ s.auth }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">
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
              <UTooltip
                v-if="s.shadowedBy"
                :text="`The ${s.shadowedBy} tier holds a server of this name, so runs use that one; this entry is idle until it is removed or renamed.`"
              >
                <span
                  class="shadow ml-1 cursor-help rounded border border-dashed border-accented px-1.5 py-0.5 font-mono text-[0.6875rem] text-dimmed"
                  >shadowed by {{ s.shadowedBy }}</span
                >
              </UTooltip>
              <div v-if="probes[s.name]" class="probe mt-1 text-xs text-dimmed">{{ probes[s.name] }}</div>
            </td>
            <td class="addedby px-3 py-2.5 text-xs text-muted" :title="s.addedBy">
              <span class="block max-w-[8rem] truncate">{{ addedBy(s) }}</span>
              <span
                v-if="s.promotedFrom"
                class="block max-w-[8rem] truncate text-[0.6875rem] text-dimmed"
                :title="s.promotedFrom"
                >promoted from {{ s.promotedFromName ?? s.promotedFrom }}</span
              >
            </td>
            <!-- Four fixed slots so the buttons line up down the column whatever a row offers. -->
            <td class="px-3 py-1.5 text-right whitespace-nowrap">
              <span class="actions inline-flex items-center justify-end">
                <span class="slot inline-flex w-[4.5rem] justify-center">
                  <UButton size="xs" color="neutral" variant="ghost" :disabled="busy" @click="probe(s)">Probe</UButton>
                </span>
                <span class="slot inline-flex w-[4.5rem] justify-center">
                  <UButton
                    v-if="canPromote(s)"
                    size="xs"
                    color="primary"
                    variant="ghost"
                    :disabled="busy"
                    @click="promote(s)"
                    >Promote</UButton
                  >
                </span>
                <span class="slot inline-flex w-[4.5rem] justify-center">
                  <UButton
                    v-if="s.source === 'runtime' && s.auth !== 'none'"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :disabled="busy || !canWriteRow(s)"
                    @click="connect(s)"
                    >Connect</UButton
                  >
                </span>
                <span class="slot inline-flex w-[4.5rem] justify-center">
                  <UButton
                    v-if="s.source === 'runtime'"
                    size="xs"
                    color="error"
                    variant="ghost"
                    :disabled="busy || !canWriteRow(s)"
                    @click="remove(s)"
                    >Remove</UButton
                  >
                </span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <form
      v-if="!mcps.unavailable"
      class="add grid max-w-3xl gap-4 rounded-lg border border-default bg-elevated px-5 py-4"
      @submit.prevent="add"
    >
      <h2 class="font-mono text-xs font-medium uppercase tracking-wider text-muted">Add a server</h2>
      <div class="grid gap-x-4 gap-y-3 sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:items-start">
        <label class="text-sm text-muted sm:pt-1" for="mcp-name">Name</label>
        <div class="grid gap-1">
          <input
            id="mcp-name"
            v-model="form.name"
            :class="INPUT_CLASS"
            class="font-mono text-xs sm:max-w-xs"
            required
            pattern="[a-z0-9][a-z0-9-]{0,31}"
            placeholder="notion"
            :disabled="!canAdd"
          />
          <span class="text-xs text-dimmed"
            >A slug; its tools appear as <code>mcp__{{ form.name.trim() || "name" }}__…</code></span
          >
        </div>
        <label class="text-sm text-muted sm:pt-1" for="mcp-url">URL</label>
        <div class="grid gap-1">
          <input
            id="mcp-url"
            v-model="form.url"
            :class="INPUT_CLASS"
            class="font-mono text-xs"
            type="url"
            required
            placeholder="https://mcp.example.com/mcp"
            :disabled="!canAdd"
          />
          <span class="text-xs text-dimmed">The server's Streamable-HTTP endpoint.</span>
        </div>
        <label class="text-sm text-muted sm:pt-1" for="mcp-scope">Tier</label>
        <select
          id="mcp-scope"
          v-model="form.scope"
          :class="SELECT_CLASS"
          class="sm:max-w-md"
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
        <span class="text-sm text-muted sm:pt-1">Agents</span>
        <div class="flex flex-wrap gap-x-4 gap-y-1.5 pt-1 text-sm">
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
        <label class="text-sm text-muted sm:pt-1" for="mcp-auth">Auth</label>
        <select id="mcp-auth" v-model="form.auth" :class="SELECT_CLASS" class="sm:max-w-md" :disabled="!canAdd">
          <option value="">detect from the server</option>
          <option value="oauth">oauth — sign in on a one-time link</option>
          <option value="bearer">bearer — paste a token on a one-time link</option>
          <option value="none">none</option>
        </select>
        <span class="hidden sm:block"></span>
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
      </div>
      <p
        v-if="notice"
        class="notice rounded-md px-3 py-2 text-sm"
        :class="notice.kind === 'error' ? 'border border-err/30 bg-err/10' : 'border border-ok/30 bg-ok/10'"
      >
        {{ notice.text }}
        <a
          v-if="notice.connectUrl"
          class="connect ml-1 font-mono text-xs underline"
          :href="notice.connectUrl"
          target="_blank"
          rel="noopener"
          >{{ notice.connectUrl }}</a
        >
        <span v-if="watching" class="watching ml-1 text-xs text-dimmed"
          >— this page refreshes itself when the link is used.</span
        >
      </p>
    </form>
  </section>
</template>
