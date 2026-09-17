import { DurableObject } from "cloudflare:workers";
import { LinearOAuth, LINEAR_AUTHORIZE_PATH, LINEAR_CALLBACK_PATH } from "../../src/channels/linear/oauth.js";
import { StoredLinearStore, type LinearOAuthState } from "../../src/channels/linear/store.js";
import { SqlLinearInbox } from "../../src/channels/linear/inbox.js";
import { handleLinearWebhook, LINEAR_WEBHOOK_PATH } from "../../src/channels/linear/webhook.js";
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
  | "PUBLIC_BASE_URL"
>;

/** Public OAuth and signed webhook routes never wake the bot's container.
 *  An installation without the optional credentials stays explicitly disabled. */
export function linearRoute(pathname: string): boolean {
  return pathname === LINEAR_AUTHORIZE_PATH || pathname === LINEAR_CALLBACK_PATH || pathname === LINEAR_WEBHOOK_PATH;
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
  return env.LINEAR_STATE.get(env.LINEAR_STATE.idFromName("installation")).fetch(request);
}

/** One durable host for the installation's OAuth state, credentials and inbox.
 *  No credential route exists: tokens never leave this object's storage through
 *  an HTTP response. The queue is retained independently of container lifetimes. */
export class LinearState extends DurableObject<LinearEnv> {
  private readonly store: StoredLinearStore;
  private readonly inbox: SqlLinearInbox;

  constructor(ctx: DurableObjectState, env: LinearEnv) {
    super(ctx, env);
    this.store = new StoredLinearStore(ctx.storage);
    this.inbox = new SqlLinearInbox(ctx.storage.sql);
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
      if (path === LINEAR_WEBHOOK_PATH)
        return handleLinearWebhook(request, {
          secret: env.LINEAR_WEBHOOK_SECRET,
          applicationId: env.LINEAR_APPLICATION_ID,
          organizationId: env.LINEAR_ORGANIZATION_ID,
          clock: systemClock,
          accept: (event) => this.inbox.accept(event),
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
      return oauth.handle(request);
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
    await this.pruneStates();
    await this.inbox.prune(systemClock() - LINEAR_TIMING.deliveryRetentionMs);
    await this.ctx.storage.setAlarm(systemClock() + LINEAR_TIMING.oauthStateMs);
  }
}
