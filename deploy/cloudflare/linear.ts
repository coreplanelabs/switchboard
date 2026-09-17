import { DurableObject } from "cloudflare:workers";
import {
  LinearOAuth,
  LinearTokenProvider,
  LINEAR_AUTHORIZE_PATH,
  LINEAR_CALLBACK_PATH,
} from "../../src/channels/linear/oauth.js";
import { DirectLinearApi } from "../../src/channels/linear/api.js";
import { handleLinearBridge, LINEAR_BRIDGE_PATH } from "../../src/channels/linear/bridge.js";
import { StoredLinearStore, type LinearOAuthState } from "../../src/channels/linear/store.js";
import { SqlLinearInbox } from "../../src/channels/linear/inbox.js";
import { LinearAcknowledgements } from "../../src/channels/linear/acknowledgement.js";
import { revokeLinearInstallation } from "../../src/channels/linear/lifecycle.js";
import { boundedBody, handleLinearWebhook, LINEAR_WEBHOOK_PATH } from "../../src/channels/linear/webhook.js";
import { LINEAR_TIMING } from "../../src/core/budgets.js";
import { systemClock } from "../../src/core/trace/clock.js";
import type { Env } from "./worker";

export type LinearEnv = Pick<
  Env,
  | "LINEAR_STATE"
  | "LINEAR_CLIENT_ID"
  | "LINEAR_CLIENT_SECRET"
  | "LINEAR_APPLICATION_ID"
  | "LINEAR_WEBHOOK_SECRET"
  | "LINEAR_ORGANIZATION_ID"
  | "LINEAR_BRIDGE_TOKEN"
  | "PUBLIC_BASE_URL"
>;

/** Public OAuth and signed webhook routes never wake the bot's container.
 *  An installation without the optional credentials stays explicitly disabled. */
export function linearRoute(pathname: string): boolean {
  return (
    pathname === LINEAR_AUTHORIZE_PATH ||
    pathname === LINEAR_CALLBACK_PATH ||
    pathname === LINEAR_WEBHOOK_PATH ||
    pathname === LINEAR_BRIDGE_PATH
  );
}

export async function handleLinearEdge(request: Request, env: LinearEnv): Promise<Response> {
  if (
    !env.LINEAR_CLIENT_ID ||
    !env.LINEAR_CLIENT_SECRET ||
    !env.LINEAR_APPLICATION_ID ||
    !env.LINEAR_WEBHOOK_SECRET ||
    !env.PUBLIC_BASE_URL
  ) {
    return Response.json({ error: "linear_disabled" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  // Buffer only bounded raw bytes before crossing the Durable Object boundary.
  // An early rejection there must not leave a streaming subrequest pumping
  // from the outer request after its response has already been sent.
  if (request.body) {
    const bytes = await boundedBody(request);
    if (!bytes) return Response.json({ error: "too_large" }, { status: 413 });
    request = new Request(request, { body: bytes as Uint8Array<ArrayBuffer> });
  }
  return env.LINEAR_STATE.get(env.LINEAR_STATE.idFromName("installation")).fetch(request);
}

/** One durable host for the installation's OAuth state, credentials and inbox.
 *  No credential route exists: tokens never leave this object's storage through
 *  an HTTP response. The queue is retained independently of container lifetimes. */
export class LinearState extends DurableObject<LinearEnv> {
  private readonly store: StoredLinearStore;
  private readonly inbox: SqlLinearInbox;
  private readonly tokens: LinearTokenProvider;
  private readonly acknowledgements: LinearAcknowledgements;

  constructor(ctx: DurableObjectState, env: LinearEnv) {
    super(ctx, env);
    this.store = new StoredLinearStore(ctx.storage);
    this.inbox = new SqlLinearInbox(ctx.storage.sql);
    this.tokens = new LinearTokenProvider({
      clientId: env.LINEAR_CLIENT_ID ?? "",
      clientSecret: env.LINEAR_CLIENT_SECRET ?? "",
      store: this.store,
      fetch: (input, init) => fetch(input, init),
      clock: systemClock,
    });
    this.acknowledgements = new LinearAcknowledgements({
      inbox: this.inbox,
      api: (organizationId) => this.api(organizationId),
      clock: systemClock,
      warn: (message) => console.warn(message),
    });
  }

  private async api(organizationId: string): Promise<DirectLinearApi> {
    if (this.env.LINEAR_ORGANIZATION_ID && organizationId !== this.env.LINEAR_ORGANIZATION_ID)
      throw new Error("linear_wrong_installation");
    const installation = await this.store.getInstallation(organizationId);
    if (!installation) throw new Error("linear_not_installed");
    return new DirectLinearApi({
      organizationId,
      appUserId: installation.appUserId,
      token: () => this.tokens.accessToken(organizationId),
      fetch: (input, init) => fetch(input, init),
    });
  }

  private async armAlarm(delay: number): Promise<void> {
    const next = systemClock() + delay;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async fetch(request: Request): Promise<Response> {
    const env = this.env;
    if (
      !env.LINEAR_CLIENT_ID ||
      !env.LINEAR_CLIENT_SECRET ||
      !env.LINEAR_APPLICATION_ID ||
      !env.LINEAR_WEBHOOK_SECRET ||
      !env.PUBLIC_BASE_URL
    ) {
      return Response.json({ error: "linear_disabled" }, { status: 503 });
    }
    try {
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(systemClock() + LINEAR_TIMING.oauthStateMs);
      const path = new URL(request.url).pathname;
      if (path === LINEAR_BRIDGE_PATH)
        return await handleLinearBridge(request, {
          token: env.LINEAR_BRIDGE_TOKEN,
          inbox: this.inbox,
          clock: systemClock,
          api: (organizationId) => this.api(organizationId),
        });
      if (path === LINEAR_WEBHOOK_PATH)
        return await handleLinearWebhook(request, {
          secret: env.LINEAR_WEBHOOK_SECRET,
          applicationId: env.LINEAR_APPLICATION_ID,
          organizationId: env.LINEAR_ORGANIZATION_ID,
          clock: systemClock,
          accept: async (event) => {
            if (event.payload.type === "OAuthApp" && event.payload.action === "revoked") {
              if (!(await revokeLinearInstallation(this.store, event))) return false;
              await this.inbox.cancelOrganization(event.payload.organizationId, event.receivedAt);
            }
            const acknowledge = event.payload.type === "AgentSessionEvent" && event.payload.action === "created";
            const accepted = await this.inbox.accept(event, { acknowledge });
            if (acknowledge) {
              // The alarm is durable before HTTP 200; network work runs outside
              // the response lifetime and never waits for the bot container.
              await this.armAlarm(LINEAR_TIMING.progressMs);
              this.ctx.waitUntil(
                this.acknowledgements.flush().catch(() => {
                  console.warn("[linear] acknowledgement sweep unavailable; alarm will retry");
                }),
              );
            }
            return accepted;
          },
        });
      if (path === LINEAR_AUTHORIZE_PATH) {
        await this.pruneStates();
        const pending = await this.ctx.storage.list({ prefix: "oauth:", limit: 256 });
        if (pending.size >= 256) return Response.json({ error: "too_many_pending_installations" }, { status: 429 });
      }
      const oauth = new LinearOAuth({
        clientId: env.LINEAR_CLIENT_ID,
        clientSecret: env.LINEAR_CLIENT_SECRET,
        baseUrl: env.PUBLIC_BASE_URL,
        organizationId: env.LINEAR_ORGANIZATION_ID,
        store: this.store,
        fetch: (input, init) => fetch(input, init),
        clock: systemClock,
      });
      return await oauth.handle(request);
    } catch {
      return Response.json({ error: "linear_unavailable" }, { status: 503 });
    }
  }

  private async pruneStates(): Promise<void> {
    const now = systemClock();
    const states = await this.ctx.storage.list<LinearOAuthState>({ prefix: "oauth:" });
    const expired = [...states].filter(([, value]) => value.expiresAt <= now).map(([key]) => key);
    for (let offset = 0; offset < expired.length; offset += 128)
      await this.ctx.storage.delete(expired.slice(offset, offset + 128));
  }

  async alarm(): Promise<void> {
    try {
      await this.acknowledgements.flush();
      await this.pruneStates();
      await this.inbox.prune(systemClock() - LINEAR_TIMING.deliveryRetentionMs);
    } finally {
      await this.armAlarm((await this.inbox.hasPendingAcks()) ? LINEAR_TIMING.progressMs : LINEAR_TIMING.oauthStateMs);
    }
  }
}
