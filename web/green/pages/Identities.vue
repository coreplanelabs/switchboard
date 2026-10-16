<script setup lang="ts">
defineOptions({ name: "GreenIdentitiesPage" });
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import LinkConsent from "../../src/modules/account-linking/LinkConsent.vue";
import { useSeed, useViewingAs } from "../../src/lib/seed";
const seed = useSeed("identities");
const viewingAs = useViewingAs();
</script>
<template>
  <PageHeading
    title="Identities"
    description="Explicit account links can join your future private activity across surfaces."
  />
  <nav class="green-tabs" aria-label="Settings sections">
    <RouterLink to="/settings/channels">Channels</RouterLink><RouterLink to="/settings/mcps">MCP servers</RouterLink
    ><RouterLink to="/settings/identities" aria-current="page">Identities</RouterLink
    ><RouterLink to="/settings/runtime">Runtime</RouterLink
    ><RouterLink to="/settings/installation">Installation</RouterLink>
  </nav>
  <section v-if="seed?.accounts?.length" class="green-section" aria-label="Your verified identities">
    <h2 class="green-section-title">Your identities</h2>
    <ul>
      <li
        v-for="account in seed.accounts"
        :key="`${account.identity.issuer}:${account.identity.tenant}:${account.identity.subject}`"
      >
        {{ account.identity.issuer === "https://slack.com" ? "Slack" : "Browser" }} · {{ account.identity.subject }} ·
        {{ account.state === "active" ? "Linked" : "Unlinked" }}
      </li>
    </ul>
  </section>
  <section v-if="seed?.notices?.length" class="green-section" aria-label="Account change notices">
    <h2 class="green-section-title">Account changes</h2>
    <article v-for="notice in seed.notices" :key="notice.id">
      <p>
        {{
          notice.operation?.kind === "unlink" ? "Unlink" : notice.operation?.kind === "recover" ? "Recovery" : "Link"
        }}
        · {{ notice.outcome }}. Past activity keeps its original account.
      </p>
      <form
        v-if="(seed.canAcknowledge ?? seed.canWrite) && !viewingAs"
        method="post"
        action="/settings/identities/acknowledge"
      >
        <input type="hidden" name="notice" :value="notice.id" /><input type="hidden" name="csrf" :value="notice.csrf" />
        <button type="submit" class="green-button green-button-quiet">Acknowledge</button>
      </form>
    </article>
  </section>
  <p v-if="seed?.pendingNotices" class="green-muted">
    {{ seed.pendingNotices }} loaded account notice{{ seed.pendingNotices === 1 ? "" : "s" }} pending acknowledgment or
    delivery.
  </p>
  <section class="green-section">
    <LinkConsent
      v-if="seed?.view"
      :view="seed.view"
      live
      native
      embedded
      path="/settings/identities"
      :readonly="!seed.canWrite || !!viewingAs"
    />
    <EmptyState
      v-else
      title="Identity linking is unavailable"
      :description="
        seed?.unavailable ??
        'This server has not enabled a trusted account verification flow. Matching names, email addresses, or organization membership do not link identities.'
      "
      icon="i-lucide-shield-check"
    />
  </section>
</template>
