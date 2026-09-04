import { AGENTS } from "../agents/registry.js";
import type { ConfigStore, ResolvedMcpServer, Scope } from "../config.js";
import { assertUrlAllowed, BlockedUrlError, type FetchLike } from "../tools/web.js";
import { newTicket, planCallback, planComplete, planOpen, planStart, type CallbackRefusal, type CompleteDecision, type ConnectIdentity, type OpenDecision, type TicketRefusal } from "./connect.js";
import {
  authorizationUrl,
  detectAuth,
  discover,
  exchangeCode,
  isOAuthPending,
  needsRefresh,
  nonceOfState,
  OAuthError,
  oauthState,
  parseStoredCredential,
  pkce,
  refreshCredential,
  registerClient,
  type OAuthCredential,
  type OAuthPending,
} from "./oauth.js";
import {
  MCP_AGENTS_MAX,
  MCP_SELF_SERVE_AGENTS,
  MCP_SERVERS_PER_SCOPE_MAX,
  MCP_TICKET_TTL_MS,
  mcpCredentialKey,
  mcpScopeKey,
  serverView,
  splitCredentialKey,
  type McpAuthKind,
  type McpScopeKind,
  type McpServerEntry,
  type McpServerView,
  type McpTicket,
} from "./registry.js";
import { openCredential, randomNonce, sealCredential, type CredentialKey } from "./sealed.js";
import type { McpSecretStore } from "./secretStore.js";
import { DiscoveringMcpToolSource, type DiscoveringSourceOptions, type ResolvedServer } from "./source.js";
import type { McpClientFactory, McpServerSpec } from "./types.js";

// The MCP server rules in ONE place (features/mcp-tools.md items 13–17), over
// the CONFIG STORE — a server is `Scope.mcpServers[name]` in the org, channel,
// or user tier, persisted like every other runtime override — plus the secret
// store for what a config document must never hold (sealed credentials,
// one-time tickets). Shared by the `mcp.*` commands, the connect page, and the
// per-run tool source. Every decision here is deterministic; no model is
// involved.

export const MCP_OFF_MESSAGE = "External MCP servers are not enabled in this deployment (no `mcp` block in config.yaml).";

export class McpServiceError extends Error {
  constructor(
    public readonly code: "invalid_input" | "unauthorized" | "not_found" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "McpServiceError";
  }
}

export interface McpServiceOptions {
  config: ConfigStore;
  secrets: McpSecretStore;
  /** The sealing key; absent → bearer servers without `tokenEnv` cannot be added or used (named at the point of failure). */
  key?: CredentialKey;
  factory: McpClientFactory;
  /** `PUBLIC_BASE_URL` — where connect links point; absent → bearer/oauth adds are refused. */
  publicBaseUrl?: string;
  /** The SSRF-pinned fetch for auth detection and the OAuth exchanges (item
   *  18); absent → `mcp add` needs an explicit `--auth` and oauth servers
   *  cannot be connected. */
  fetch?: FetchLike;
  env: Record<string, string | undefined>;
  /** Resolve a chat user's email so a ticket binds to it; undefined → bind-on-first-open. */
  resolveEmail?: (userId: string) => Promise<string | undefined>;
  now?: () => number;
  nonce?: () => string;
  cacheTtlMs?: number;
}

/** Who is asking, as the command adapter resolved it (never what the request claimed). */
export interface McpActor {
  id: string;
  /** May manage ORG servers: `cli:local`, a machine token with `mcp:write`, a chat caller the repo-management gate admits. */
  orgAdmin: boolean;
  /** May manage CHANNEL servers: the `channelConfig` gate (open when unconfigured), like `config set channel`. */
  channelAdmin: boolean;
}

/** Which tier a command targets: `me` (the actor's own), `channel` (named or the origin channel), `org`. */
export interface McpTarget {
  kind: McpScopeKind;
  /** The channel id for `channel`; the actor id for `user`. */
  id?: string;
}

export interface AddInput {
  name: string;
  url: string;
  agents?: string[];
  /** Absent → detected with one unauthenticated `initialize` (item 18). */
  auth?: McpAuthKind;
}

export interface AddResult {
  server: McpServerView;
  /** Set when `auth` was detected rather than given. */
  detected?: McpAuthKind;
  connectUrl?: string;
  expiresAt?: number;
  expiresInMinutes?: number;
}

/** What the connect page gets back from `startOAuth`. */
export type StartOAuthResult = { ok: true; redirectUrl: string; server: McpServerView } | { ok: false; refusal: TicketRefusal | { kind: "oauth_failed"; reason: string }; server?: McpServerView };

/** What the connect page gets back from `completeOAuth` — shaped like `completeTicket`'s result. */
export interface CompleteOAuthResult {
  ok: boolean;
  refusal?: CallbackRefusal | { kind: "oauth_failed"; reason: string };
  toolCount?: number;
  warning?: string;
  server?: McpServerView;
}

const TICKET_MINUTES = Math.round(MCP_TICKET_TTL_MS / 60_000);
/** How often `awaitTicket` re-reads the ticket while the link is out. */
export const MCP_TICKET_POLL_MS = 3_000;

export class McpService {
  private readonly now: () => number;
  private readonly nonce: () => string;
  readonly source: ConfigMcpToolSource;

  constructor(private readonly opts: McpServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.nonce = opts.nonce ?? randomNonce;
    this.source = new ConfigMcpToolSource(this, { factory: opts.factory, now: this.now, ...(opts.cacheTtlMs !== undefined ? { cacheTtlMs: opts.cacheTtlMs } : {}) });
  }

  get secrets(): McpSecretStore {
    return this.opts.secrets;
  }

  // ---- targets + authorization ---------------------------------------------------

  /** The tier a command may act on. `channel` and `org` are decided by the DATA
   *  (command-registry.md item 22): a non-admin gets `unauthorized` naming the
   *  self-serve alternative. */
  target(actor: McpActor, word: "me" | "channel" | "org", channelId: string | undefined): McpTarget {
    if (word === "org") {
      if (!actor.orgAdmin) throw new McpServiceError("unauthorized", "org-wide MCP servers are managed by admins (repo-management rights). Add one for yourself with `--scope me`.");
      return { kind: "org" };
    }
    if (word === "channel") {
      if (!channelId) throw new McpServiceError("invalid_input", "channel: required on this surface — pass --channel <id>");
      if (!actor.channelAdmin) throw new McpServiceError("unauthorized", "channel MCP servers are restricted here (channel config rights). Add one for yourself with `--scope me`.");
      return { kind: "channel", id: channelId };
    }
    return { kind: "user", id: actor.id };
  }

  // ---- commands -----------------------------------------------------------------

  /** Every server the actor's runs in `channelId` would see: org + that channel + their own. */
  async list(actor: McpActor, channelId: string | undefined): Promise<McpServerView[]> {
    const resolved = this.opts.config.mcpServersFor(channelId ?? `none:${actor.id}`, actor.id);
    const out: McpServerView[] = [];
    for (const r of resolved) out.push(await this.view(r));
    return out;
  }

  async add(actor: McpActor, target: McpTarget, input: AddInput): Promise<AddResult> {
    const scopeKey = mcpScopeKey(target.kind, target.id);
    try {
      assertUrlAllowed(input.url);
    } catch (err) {
      throw new McpServiceError("invalid_input", `url: ${err instanceof BlockedUrlError ? err.message : "expected an http(s) URL"}`);
    }
    const agents = this.checkAgents(target.kind, input.agents);
    const auth = input.auth ?? (await this.detect(input.url));
    if (auth !== "none") this.requireCredentialSupport(auth);
    const runtime = this.opts.config.runtimeScope(target.kind, target.id);
    if (runtime.mcpServers?.[input.name] || this.opts.config.isStaticMcpServer(target.kind, target.id, input.name)) {
      throw new McpServiceError("conflict", `an MCP server named "${input.name}" already exists in this scope — remove it first or pick another name`);
    }
    // A lower tier must not take a name a higher tier holds: the tool names
    // would collide and the higher tier wins at run time (config.ts). For a
    // channel server "higher" is the org tier; for a user server it is the org
    // tier ONLY — a user's servers follow them into every channel, so a clash
    // with the server of whichever channel they happen to be speaking in is
    // not a reason to refuse: in that channel the user's copy is shadowed (and
    // the run says so), everywhere else it serves. Hence the synthetic channel.
    const higher = this.opts.config.mcpServersFor(target.kind === "channel" ? (target.id as string) : `none:${actor.id}`, actor.id).find((r) => r.name === input.name && ranks(r.kind) < ranks(target.kind));
    if (higher) throw new McpServiceError("conflict", `"${input.name}" is already an ${higher.kind}-scoped MCP server; pick another name`);
    if (Object.keys(runtime.mcpServers ?? {}).length >= MCP_SERVERS_PER_SCOPE_MAX) throw new McpServiceError("invalid_input", `this scope already has ${MCP_SERVERS_PER_SCOPE_MAX} servers`);
    const entry: McpServerEntry = { url: input.url, agents, auth, addedBy: actor.id, addedAt: this.now() };
    await this.writeServers(target, { ...runtime.mcpServers, [input.name]: entry });
    const view = serverView(scopeKey, input.name, entry, { hasCredential: false, source: "runtime" });
    const detected = input.auth === undefined ? { detected: auth } : {};
    if (auth === "none") return { server: view, ...detected };
    const ticket = await this.mintTicket(mcpCredentialKey(scopeKey, input.name), actor);
    return { server: view, ...detected, connectUrl: this.connectUrl(ticket), expiresAt: ticket.expiresAt, expiresInMinutes: TICKET_MINUTES };
  }

  /** A fresh connect link for a runtime bearer/oauth server (first connect, or a re-key). */
  async connect(actor: McpActor, target: McpTarget, name: string): Promise<AddResult> {
    const { scopeKey, entry, source } = this.owned(target, name);
    if (entry.auth === "none") throw new McpServiceError("invalid_input", `"${name}" needs no credential (auth: none)`);
    // A static bearer with `tokenEnv` has no stored credential to (re)key. A
    // static oauth entry does: its sign-in is completed at run time like a
    // runtime one — `source` alone is not the refusal.
    if (entry.tokenEnv) throw new McpServiceError("invalid_input", `"${name}" is pinned in config.yaml with tokenEnv — its bearer is an environment variable on the bot, not a stored credential`);
    if (source === "config" && entry.auth === "bearer") throw new McpServiceError("invalid_input", `"${name}" is pinned in config.yaml as a bearer server — give it a tokenEnv there, or add it at run time with \`mcp add\` to paste a token`);
    this.requireCredentialSupport(entry.auth);
    const ticket = await this.mintTicket(mcpCredentialKey(scopeKey, name), actor);
    const has = (await this.viaSecrets(() => this.opts.secrets.getCredential(mcpCredentialKey(scopeKey, name)))) !== null;
    return { server: serverView(scopeKey, name, entry, { hasCredential: has, source }), connectUrl: this.connectUrl(ticket), expiresAt: ticket.expiresAt, expiresInMinutes: TICKET_MINUTES };
  }

  async remove(actor: McpActor, target: McpTarget, name: string): Promise<{ removed: true; name: string; scope: McpScopeKind }> {
    const { scopeKey, source } = this.owned(target, name);
    if (source === "config") throw new McpServiceError("conflict", `"${name}" is pinned in config.yaml (${target.kind} scope) — remove it there`);
    const runtime = this.opts.config.runtimeScope(target.kind, target.id);
    const { [name]: _gone, ...rest } = runtime.mcpServers ?? {};
    await this.writeServers(target, rest);
    await this.viaSecrets(() => this.opts.secrets.deleteCredential(mcpCredentialKey(scopeKey, name))).catch(() => false);
    this.source.forget(mcpCredentialKey(scopeKey, name));
    return { removed: true, name, scope: target.kind };
  }

  /** The server plus a live `tools/list` probe (names + read-only flags) — never the credential. */
  async show(actor: McpActor, target: McpTarget, name: string): Promise<McpServerView & { probe: { ok: boolean; error?: string; tools?: Array<{ name: string; readOnly: boolean; description: string }> } }> {
    const found = this.visible(target, name);
    const view = await this.view(found);
    if (view.state === "awaiting_credential") return { ...view, probe: { ok: false, error: "no credential stored yet — complete the connect link first (`mcp connect`)" } };
    const spec = await this.specFor(found);
    if (!("spec" in spec)) return { ...view, probe: { ok: false, error: spec.unavailable } };
    try {
      const tools = await this.opts.factory(spec.spec).listTools();
      return { ...view, probe: { ok: true, tools: tools.map((t) => ({ name: t.name, readOnly: t.annotations?.readOnlyHint === true, description: (t.description ?? "").slice(0, 160) })) } };
    } catch (err) {
      return { ...view, probe: { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) } };
    }
  }

  // ---- the connect page ----------------------------------------------------------

  /** GET: binding an unbound ticket is a compare-and-swap on its state; when
   *  another opener won the race the decision is re-planned against the
   *  ticket as they left it (→ `wrong_identity`), never a second binding. */
  async openTicket(nonce: string, identity: ConnectIdentity): Promise<{ decision: OpenDecision; server?: McpServerView }> {
    const first = await this.tryOpen(nonce, identity);
    if (first !== "lost_race") return first;
    const second = await this.tryOpen(nonce, identity);
    return second === "lost_race" ? { decision: { ok: false, refusal: { kind: "wrong_identity" } } } : second;
  }

  private async tryOpen(nonce: string, identity: ConnectIdentity): Promise<{ decision: OpenDecision; server?: McpServerView } | "lost_race"> {
    const ticket = await this.viaSecrets(() => this.opts.secrets.getTicket(nonce));
    const decision = planOpen(ticket, identity, this.now());
    if (!decision.ok) return { decision };
    if (decision.bound && !(await this.viaSecrets(() => this.opts.secrets.transitionTicket(decision.ticket, (ticket as McpTicket).state)))) return "lost_race";
    return { decision, server: await this.serverOfTicket(decision.ticket) };
  }

  /** The completion: verify → claim the ticket → seal → store. `verified:
   *  false` means the server rejected the token (401/403 on tools/list):
   *  nothing is stored and the ticket stays open for a retry. The claim is a
   *  compare-and-swap on the ticket's state, so of two concurrent completions
   *  exactly one seals a credential; the other sees `used`. Claiming before
   *  sealing means a store failure after the claim spends the ticket without a
   *  credential — the failure page says so and `mcp connect` mints a new one. */
  async completeTicket(nonce: string, identity: ConnectIdentity, rawToken: string): Promise<{ decision: CompleteDecision; verified?: boolean; toolCount?: number; warning?: string; server?: McpServerView }> {
    const ticket = await this.viaSecrets(() => this.opts.secrets.getTicket(nonce));
    const decision = planComplete(ticket, identity, rawToken, this.now());
    if (!decision.ok) return { decision };
    const found = this.findByCredentialKey(decision.ticket.serverId);
    if (!found) return { decision: { ok: false, refusal: { kind: "not_found" } } };
    if (found.entry.auth !== "bearer") return { decision: { ok: false, refusal: { kind: "bad_token", reason: `"${found.name}" signs in with OAuth — use the button, not a pasted token` } }, server: await this.view(found) };
    const key = this.requireCredentialSupport("bearer");
    const probe = await this.probe({ id: decision.ticket.serverId, name: found.name, url: found.entry.url, agents: found.entry.agents ?? [...MCP_SELF_SERVE_AGENTS], auth: { type: "bearer", token: decision.token } });
    const server = await this.view(found);
    if (probe.kind === "rejected") return { decision, verified: false, server, warning: probe.error };
    const claimed = await this.viaSecrets(() => this.opts.secrets.transitionTicket({ ...decision.ticket, outcome: outcomeOf(probe) }, (ticket as McpTicket).state));
    if (!claimed) return { decision: { ok: false, refusal: { kind: "used" } } };
    const sealed = await sealCredential(key, decision.ticket.serverId, decision.token, this.now());
    await this.viaSecrets(() => this.opts.secrets.putCredential(sealed));
    this.source.forget(decision.ticket.serverId);
    return { decision, verified: true, server: { ...server, state: "connected" }, ...(probe.kind === "ok" ? { toolCount: probe.toolCount } : { warning: probe.error }) };
  }

  // ---- OAuth (item 18) ------------------------------------------------------------

  /** POST action=start on the connect page: discover the server's authorization
   *  server, register Switchboard as a public client, mint PKCE + `state`, seal
   *  the pending record onto the ticket (CAS from the state we read), and hand
   *  back the authorization URL for the browser. Every failure is a sentence;
   *  the ticket is untouched unless the CAS succeeded. */
  async startOAuth(nonce: string, identity: ConnectIdentity): Promise<StartOAuthResult> {
    const ticket = await this.viaSecrets(() => this.opts.secrets.getTicket(nonce));
    const found = ticket ? this.findByCredentialKey(ticket.serverId) : undefined;
    if (!found || !ticket) return { ok: false, refusal: { kind: "not_found" } };
    const server = await this.view(found);
    if (found.entry.auth !== "oauth") return { ok: false, refusal: { kind: "oauth_failed", reason: `"${found.name}" does not sign in with OAuth (auth: ${found.entry.auth})` }, server };
    const key = this.requireCredentialSupport("oauth");
    const fetchImpl = this.opts.fetch as FetchLike;
    let redirectUrl: string;
    let pending: OAuthPending;
    try {
      const discovery = await discover(fetchImpl, found.entry.url);
      const redirectUri = this.callbackUrl();
      const client = await registerClient(fetchImpl, discovery, redirectUri, this.opts.publicBaseUrl);
      const { verifier, challenge } = await pkce();
      pending = {
        state: oauthState(nonce),
        codeVerifier: verifier,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        tokenEndpoint: discovery.tokenEndpoint,
        redirectUri,
        resource: discovery.resource,
        ...(discovery.scopes ? { scope: discovery.scopes.join(" ") } : {}),
      };
      redirectUrl = authorizationUrl(discovery, pending, challenge);
    } catch (err) {
      if (err instanceof OAuthError || err instanceof BlockedUrlError) return { ok: false, refusal: { kind: "oauth_failed", reason: err.message }, server };
      throw err;
    }
    const sealed = await sealCredential(key, `ticket:${nonce}`, JSON.stringify(pending), this.now());
    const decision = planStart(ticket, identity, { keyId: sealed.keyId, sealed: sealed.sealed }, this.now());
    if (!decision.ok) return { ok: false, refusal: decision.refusal, server };
    const applied = await this.viaSecrets(() => this.opts.secrets.transitionTicket(decision.ticket, ticket.state));
    if (!applied) return { ok: false, refusal: await this.startLostRace(nonce, identity), server };
    return { ok: true, redirectUrl, server };
  }

  /** The CAS lost: the ticket moved between the read and the write. Re-read
   *  it and say what actually happened — cancelled, expired, completed, bound
   *  to someone else — and when it is still startable (another start of the
   *  same owner won, or a GET bound it), ask for the button again rather than
   *  overwriting the winner's pending record. */
  private async startLostRace(nonce: string, identity: ConnectIdentity): Promise<TicketRefusal | { kind: "oauth_failed"; reason: string }> {
    const current = await this.viaSecrets(() => this.opts.secrets.getTicket(nonce));
    const replanned = planOpen(current, identity, this.now());
    if (!replanned.ok) return replanned.refusal;
    return { kind: "oauth_failed", reason: "the connect link changed while sign-in was starting (opened again elsewhere); press the button once more" };
  }

  /** GET /mcp/oauth/callback: the browser is back with `code` + `state` (or an
   *  `error`). Who/when is `planCallback`'s call; the `state` must equal the
   *  sealed pending record's; the code is exchanged, the token set probed
   *  against the server, the ticket claimed (CAS), the credential sealed. A
   *  failed exchange or a rejected token stores nothing and leaves the ticket
   *  `authorizing` for another attempt from the connect link. */
  async completeOAuth(identity: ConnectIdentity, params: { state?: string; code?: string; error?: string; errorDescription?: string }): Promise<CompleteOAuthResult> {
    const nonce = params.state ? nonceOfState(params.state) : undefined;
    if (!nonce) return { ok: false, refusal: { kind: "not_found" } };
    const ticket = await this.viaSecrets(() => this.opts.secrets.getTicket(nonce));
    const decision = planCallback(ticket, identity, this.now());
    if (!decision.ok) return { ok: false, refusal: decision.refusal };
    const found = this.findByCredentialKey(decision.ticket.serverId);
    if (!found || found.entry.auth !== "oauth") return { ok: false, refusal: { kind: "not_found" } };
    const server = await this.view(found);
    const key = this.requireCredentialSupport("oauth");
    let pending: unknown;
    try {
      pending = JSON.parse(await openCredential(key, { serverId: `ticket:${nonce}`, keyId: (ticket as McpTicket).oauth!.keyId, sealed: (ticket as McpTicket).oauth!.sealed, updatedAt: 0 }));
    } catch (err) {
      return { ok: false, refusal: { kind: "oauth_failed", reason: `the pending authorization could not be read (${err instanceof Error ? err.message : String(err)})` }, server };
    }
    if (!isOAuthPending(pending) || !constantTimeEqual(pending.state, params.state ?? "")) return { ok: false, refusal: { kind: "oauth_failed", reason: "the returned state does not match the one this link started with" }, server };
    // Only a return that proved it is ours gets its `error` relayed.
    if (params.error) return { ok: false, refusal: { kind: "oauth_failed", reason: `the authorization server answered "${params.error}"${params.errorDescription ? ` (${params.errorDescription})` : ""}` }, server };
    if (!params.code) return { ok: false, refusal: { kind: "oauth_failed", reason: "the authorization server returned no code" }, server };
    let cred: OAuthCredential;
    try {
      cred = await exchangeCode(this.opts.fetch as FetchLike, pending, params.code, this.now());
    } catch (err) {
      if (err instanceof OAuthError || err instanceof BlockedUrlError) return { ok: false, refusal: { kind: "oauth_failed", reason: err.message }, server };
      throw err;
    }
    const probe = await this.probe({ id: decision.ticket.serverId, name: found.name, url: found.entry.url, agents: found.entry.agents ?? [...MCP_SELF_SERVE_AGENTS], auth: { type: "bearer", token: cred.accessToken } });
    if (probe.kind === "rejected") return { ok: false, refusal: { kind: "oauth_failed", reason: probe.error }, server };
    const claimed = await this.viaSecrets(() => this.opts.secrets.transitionTicket({ ...decision.ticket, outcome: outcomeOf(probe) }, (ticket as McpTicket).state));
    if (!claimed) return { ok: false, refusal: { kind: "used" }, server };
    await this.storeOAuth(decision.ticket.serverId, cred);
    return { ok: true, server: { ...server, state: "connected" }, ...(probe.kind === "ok" ? { toolCount: probe.toolCount } : { warning: probe.error }) };
  }

  private async storeOAuth(serverId: string, cred: OAuthCredential): Promise<void> {
    const key = this.requireCredentialSupport("oauth");
    const sealed = await sealCredential(key, serverId, JSON.stringify(cred), this.now());
    await this.viaSecrets(() => this.opts.secrets.putCredential(sealed));
    this.source.forget(serverId);
  }

  /** The thread's follow-up (item 19): wait — bounded by the ticket's own TTL,
   *  polling the store — for the connect link to be used, and say what
   *  happened. `completed` → the outcome the completion recorded; the link
   *  expiring unused → `expired`, unless the server got a credential another
   *  way (a re-minted link) → `superseded`, which the caller keeps quiet
   *  about. Never re-probes the server. */
  async awaitTicket(nonce: string, opts: { sleep?: (ms: number) => Promise<void>; pollMs?: number } = {}): Promise<{ kind: "completed"; outcome: NonNullable<McpTicket["outcome"]> } | { kind: "expired" } | { kind: "cancelled" } | { kind: "superseded" } | { kind: "gone" }> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const pollMs = opts.pollMs ?? MCP_TICKET_POLL_MS;
    for (;;) {
      const ticket = await this.viaSecrets(() => this.opts.secrets.getTicket(nonce));
      if (!ticket) return { kind: "gone" };
      if (ticket.state === "completed") return { kind: "completed", outcome: ticket.outcome ?? {} };
      if (ticket.state === "cancelled") return { kind: "cancelled" };
      if (this.now() > ticket.expiresAt) {
        const found = this.findByCredentialKey(ticket.serverId);
        const has = found ? (await this.view(found)).state === "connected" : false;
        return has ? { kind: "superseded" } : { kind: "expired" };
      }
      await sleep(pollMs);
    }
  }

  private callbackUrl(): string {
    return `${(this.opts.publicBaseUrl ?? "").replace(/\/+$/, "")}/mcp/oauth/callback`;
  }

  /** In-flight refreshes by server id, so N concurrent runs refresh once. */
  private readonly refreshing = new Map<string, Promise<OAuthCredential>>();

  /** A usable access token for the run: the stored one while it lives, else
   *  a refreshed set (stored back, the cached client dropped so it is rebuilt
   *  with the new header). */
  private freshOAuth(serverId: string, cred: OAuthCredential): Promise<OAuthCredential> {
    if (!needsRefresh(cred, this.now())) return Promise.resolve(cred);
    let inflight = this.refreshing.get(serverId);
    if (!inflight) {
      inflight = (async () => {
        const next = await refreshCredential(this.opts.fetch as FetchLike, cred, this.now());
        await this.storeOAuth(serverId, next);
        return next;
      })().finally(() => this.refreshing.delete(serverId));
      this.refreshing.set(serverId, inflight);
    }
    return inflight;
  }

  // ---- the run-time view ----------------------------------------------------------

  /** Servers a run may use: every tier's entries whose agents include the
   *  agent, shadowed names reported as such, credentials opened for this run. */
  async resolveForRun(agentName: string, caller: { userId: string; channelId?: string }): Promise<ResolvedServer[]> {
    const out: ResolvedServer[] = [];
    for (const r of this.opts.config.mcpServersFor(caller.channelId ?? `none:${caller.userId}`, caller.userId)) {
      const agents = r.entry.agents ?? MCP_SELF_SERVE_AGENTS;
      if (!agents.includes(agentName)) continue;
      if (r.kind !== "org" && !MCP_SELF_SERVE_AGENTS.includes(agentName)) continue; // defense in depth over validateMcpServers
      if (r.shadowedBy) {
        out.push({ name: r.name, unavailable: `name shadowed by the ${r.shadowedBy === "org" ? "org" : r.shadowedBy.split(":")[0]}-scoped server of the same name` });
        continue;
      }
      out.push(await this.specFor(r));
    }
    return out;
  }

  // ---- internals -----------------------------------------------------------------

  private checkAgents(kind: McpScopeKind, agents: string[] | undefined): string[] {
    const list = agents && agents.length > 0 ? [...new Set(agents)] : [...MCP_SELF_SERVE_AGENTS];
    if (list.length > MCP_AGENTS_MAX) throw new McpServiceError("invalid_input", `agents: at most ${MCP_AGENTS_MAX}`);
    const known = Object.keys(AGENTS);
    for (const a of list) {
      if (!known.includes(a)) throw new McpServiceError("invalid_input", `agents: unknown agent "${a}" (known: ${known.join(", ")})`);
      if (kind !== "org" && !MCP_SELF_SERVE_AGENTS.includes(a)) {
        throw new McpServiceError("invalid_input", `agents: a ${kind === "user" ? "server you add for yourself" : "channel server"} can reach ${MCP_SELF_SERVE_AGENTS.join("/")} only — "${a}" runs with repo write access and takes an org-wide server an admin adds`);
      }
    }
    return list;
  }

  /** What a sealed credential needs: the key, and a public base URL for the
   *  connect page (and, for OAuth, the callback + the fetch that talks to the
   *  authorization server). Named at the point of failure. */
  private requireCredentialSupport(auth: Exclude<McpAuthKind, "none">): CredentialKey {
    if (!this.opts.key) throw new McpServiceError("unavailable", `${auth}-authenticated MCP servers need the credential key (MCP_CREDENTIAL_KEY) on the bot — it is not set`);
    if (!this.opts.publicBaseUrl) throw new McpServiceError("unavailable", "connect links need PUBLIC_BASE_URL on the bot — it is not set");
    if (auth === "oauth" && !this.opts.fetch) throw new McpServiceError("unavailable", "OAuth MCP servers need the web fetch on the bot — this process was wired without one");
    return this.opts.key;
  }

  /** `mcp add` without `--auth`: one unauthenticated `initialize` decides (item 18). */
  private async detect(url: string): Promise<McpAuthKind> {
    if (!this.opts.fetch) throw new McpServiceError("invalid_input", "auth: pass --auth oauth|bearer|none (this process cannot probe the server)");
    try {
      return (await detectAuth(this.opts.fetch, url)).auth;
    } catch (err) {
      if (err instanceof OAuthError || err instanceof BlockedUrlError) throw new McpServiceError("invalid_input", `auth: could not be detected — ${err.message}`);
      throw err;
    }
  }

  private connectUrl(ticket: McpTicket): string {
    return `${(this.opts.publicBaseUrl ?? "").replace(/\/+$/, "")}/mcp/connect/${ticket.nonce}`;
  }

  private async mintTicket(serverId: string, actor: McpActor): Promise<McpTicket> {
    const email = this.opts.resolveEmail ? await this.opts.resolveEmail(actor.id).catch(() => undefined) : undefined;
    const ticket = newTicket({ nonce: this.nonce(), serverId, requesterId: actor.id, ...(email ? { requesterEmail: email } : {}), now: this.now() });
    await this.viaSecrets(() => this.opts.secrets.putTicket(ticket));
    return ticket;
  }

  /** Persist one tier's runtime `mcpServers` map through the config store. */
  private async writeServers(target: McpTarget, servers: Record<string, McpServerEntry>): Promise<void> {
    const patch: Scope = { mcpServers: Object.keys(servers).length > 0 ? servers : undefined };
    try {
      if (target.kind === "org") await this.opts.config.setOrgOverride(patch);
      else if (target.kind === "channel") await this.opts.config.setChannelOverride(target.id as string, patch);
      else await this.opts.config.setUserOverride(target.id as string, patch);
    } catch (err) {
      throw new McpServiceError("unavailable", err instanceof Error ? err.message : String(err));
    }
  }

  /** A server the actor may MANAGE in this tier (the tier itself was authorized by `target`). */
  private owned(target: McpTarget, name: string): ResolvedMcpServer {
    const scopeKey = mcpScopeKey(target.kind, target.id);
    const hit = this.tierEntries(target).find((r) => r.name === name && r.scopeKey === scopeKey);
    if (!hit) throw new McpServiceError("not_found", `no MCP server named "${name}" in the ${target.kind} scope (see \`mcp list\`)`);
    return hit;
  }

  /** A server the actor may SEE: org and channel tiers are visible to everyone in the channel. */
  private visible(target: McpTarget, name: string): ResolvedMcpServer {
    return this.owned(target, name);
  }

  private tierEntries(target: McpTarget): ResolvedMcpServer[] {
    const channelId = target.kind === "channel" ? (target.id as string) : "none";
    const userId = target.kind === "user" ? (target.id as string) : "none";
    return this.opts.config.mcpServersFor(channelId, userId).filter((r) => r.kind === target.kind);
  }

  private findByCredentialKey(key: string): ResolvedMcpServer | undefined {
    const split = splitCredentialKey(key);
    if (!split) return undefined;
    const parsed = split.scopeKey === "org" ? { kind: "org" as const } : { kind: split.scopeKey.split(":")[0] as McpScopeKind, id: split.scopeKey.slice(split.scopeKey.indexOf(":") + 1) };
    return this.tierEntries(parsed).find((r) => r.name === split.name);
  }

  private async serverOfTicket(ticket: McpTicket): Promise<McpServerView | undefined> {
    const found = this.findByCredentialKey(ticket.serverId);
    return found ? this.view(found) : undefined;
  }

  private async view(r: ResolvedMcpServer): Promise<McpServerView> {
    const hasCredential = r.entry.auth !== "none" && !r.entry.tokenEnv ? (await this.viaSecrets(() => this.opts.secrets.getCredential(mcpCredentialKey(r.scopeKey, r.name)))) !== null : false;
    return serverView(r.scopeKey, r.name, r.entry, { hasCredential, source: r.source });
  }

  private async specFor(r: ResolvedMcpServer): Promise<ResolvedServer> {
    const id = mcpCredentialKey(r.scopeKey, r.name);
    const base: McpServerSpec = { id, name: r.name, url: r.entry.url, agents: r.entry.agents ?? [...MCP_SELF_SERVE_AGENTS] };
    if (r.entry.auth === "none") return { spec: base };
    if (r.entry.tokenEnv) {
      const token = this.opts.env[r.entry.tokenEnv];
      return token ? { spec: { ...base, auth: { type: "bearer", token } } } : { name: r.name, unavailable: `${r.entry.tokenEnv} is not set on the bot` };
    }
    if (!this.opts.key) return { name: r.name, unavailable: "credential key not configured on this bot" };
    let sealed;
    try {
      sealed = await this.opts.secrets.getCredential(id);
    } catch (err) {
      return { name: r.name, unavailable: `secret store: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!sealed) return { name: r.name, unavailable: "no credential stored — run `mcp connect`" };
    try {
      const stored = parseStoredCredential(await openCredential(this.opts.key, sealed));
      if (stored.kind === "bearer") return { spec: { ...base, auth: { type: "bearer", token: stored.token } } };
      const fresh = await this.freshOAuth(id, stored);
      return { spec: { ...base, auth: { type: "bearer", token: fresh.accessToken } } };
    } catch (err) {
      return { name: r.name, unavailable: err instanceof Error ? err.message : String(err) };
    }
  }

  private async probe(spec: McpServerSpec): Promise<{ kind: "ok"; toolCount: number } | { kind: "rejected"; error: string } | { kind: "error"; error: string }> {
    try {
      const tools = await this.opts.factory(spec).listTools();
      return { kind: "ok", toolCount: tools.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTP 40[13]\b/.test(message)) return { kind: "rejected", error: `the server rejected the token (${message})` };
      return { kind: "error", error: `stored, but the server could not be reached to verify it: ${message.slice(0, 200)}` };
    }
  }

  private async viaSecrets<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof McpServiceError) throw err;
      throw new McpServiceError("unavailable", err instanceof Error ? err.message : String(err));
    }
  }
}

/** What a completion records on the ticket (item 19): the count when the
 *  server answered, the verify warning when it could not be reached. */
function outcomeOf(probe: { kind: "ok"; toolCount: number } | { kind: "error"; error: string } | { kind: "rejected"; error: string }): NonNullable<McpTicket["outcome"]> {
  return probe.kind === "ok" ? { toolCount: probe.toolCount } : { warning: probe.error };
}

/** Same length and same bytes, without an early exit on the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Tier precedence: lower rank wins a name clash. */
function ranks(kind: McpScopeKind): number {
  return kind === "org" ? 0 : kind === "channel" ? 1 : 2;
}

/** The config-backed per-run source (item 17): the service resolves from the
 *  config layers, the shared engine discovers and bridges. */
export class ConfigMcpToolSource extends DiscoveringMcpToolSource {
  constructor(
    private readonly service: McpService,
    opts: DiscoveringSourceOptions,
  ) {
    super(opts);
  }

  protected async resolve(agentName: string, caller: { userId: string; channelId?: string }): Promise<ResolvedServer[]> {
    try {
      return await this.service.resolveForRun(agentName, caller);
    } catch (err) {
      return [{ name: "registry", unavailable: `MCP config unreachable: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` }];
    }
  }
}
