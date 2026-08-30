// Cloudflare Containers shim: runs the unchanged Switchboard image as a single
// always-on container instance. Follows the house pattern proven by
// coreplanelabs/infrastructure `terrateam/` (long-lived server in a container,
// singleton DO, cron keep-alive).
//
// The Worker exists to (re)start the container, run health checks, and fire
// the scheduled jobs — all Slack traffic is the container's own outbound Socket
// Mode websocket, so nothing user-facing flows through here. Scheduled jobs are
// NOT special: a `run` schedule is POSTed to the bot's generic /ingress as the
// `cron` identity, so it becomes an ordinary run (#244).
import { Container, getContainer } from "@cloudflare/containers";
import {
  interpretIngressResponse,
  planScheduledFiring,
  scheduleForCron,
  type ScheduleFiring,
} from "../../src/core/schedules.ts";

interface Env {
  SWITCHBOARD: DurableObjectNamespace<SwitchboardServer>;
  // secrets (wrangler secret put ...)
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  E2B_API_KEY?: string;
  SANDBOX_TOKEN?: string; // cloudflare execution: bearer for the sandbox Worker
  RESIDENT_OPERATOR_TOKEN?: string; // resident repos: operator bearer for the resident Worker
  RESIDENT_ADMIN_TOKEN?: string; // resident repos: admin bearer for `repo onboard/offboard/...` chat commands
  GH_TOKEN?: string; // fallback when no GitHub App is configured
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  PUBLIC_BASE_URL?: string; // live-view: base for /runs/<id>?t=… links on the status card
  ACCESS_TEAM_DOMAIN?: string; // live-view SSO gate: Cloudflare Access team domain (JWKS + iss)
  ACCESS_AUD?: string; // live-view SSO gate: Cloudflare Access application AUD tag
  SWITCHBOARD_INGRESS_TOKENS?: string; // enables HTTP /ingress + MCP /mcp (JSON token→identity map); the `cron` entry is what scheduled runs present
  BRAVE_SEARCH_API_KEY?: string; // web_search backend (Brave); web_fetch works without it
  CF_ANALYTICS_TOKEN?: string; // costs dash: Cloudflare API token, Account Analytics:Read only
  ANTHROPIC_ADMIN_KEY?: string; // costs dash (optional): Anthropic Admin API key for the LLM cost report
  MEMORY_TOKEN?: string; // durable memory + friction ledger + schedule firings: bearer for the state Worker
  STATE_WORKER_URL?: string; // var: the state Worker's base URL — where this shim records each scheduled firing (#244)
}

export class SwitchboardServer extends Container<Env> {
  defaultPort = 8080; // the bot's health endpoint (PORT=8080 in the image)
  // Never let this scale to zero: the Slack websocket must stay connected and
  // Slack does not redeliver missed Socket Mode events. Cron pings every 5m.
  sleepAfter = "2h";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      SWITCHBOARD_CONFIG: "./config/config.production.yaml",
      SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
      ...(env.E2B_API_KEY ? { E2B_API_KEY: env.E2B_API_KEY } : {}),
      ...(env.SANDBOX_TOKEN ? { SANDBOX_TOKEN: env.SANDBOX_TOKEN } : {}),
      ...(env.RESIDENT_OPERATOR_TOKEN
        ? { RESIDENT_OPERATOR_TOKEN: env.RESIDENT_OPERATOR_TOKEN }
        : {}),
      ...(env.RESIDENT_ADMIN_TOKEN ? { RESIDENT_ADMIN_TOKEN: env.RESIDENT_ADMIN_TOKEN } : {}),
      ...(env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {}),
      ...(env.GITHUB_APP_ID ? { GITHUB_APP_ID: env.GITHUB_APP_ID } : {}),
      ...(env.GITHUB_APP_INSTALLATION_ID
        ? { GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID }
        : {}),
      ...(env.GITHUB_APP_PRIVATE_KEY
        ? { GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY }
        : {}),
      ...(env.PUBLIC_BASE_URL ? { PUBLIC_BASE_URL: env.PUBLIC_BASE_URL } : {}),
      ...(env.ACCESS_TEAM_DOMAIN ? { ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN } : {}),
      ...(env.ACCESS_AUD ? { ACCESS_AUD: env.ACCESS_AUD } : {}),
      ...(env.CF_ANALYTICS_TOKEN ? { CF_ANALYTICS_TOKEN: env.CF_ANALYTICS_TOKEN } : {}),
      ...(env.ANTHROPIC_ADMIN_KEY ? { ANTHROPIC_ADMIN_KEY: env.ANTHROPIC_ADMIN_KEY } : {}),
      ...(env.SWITCHBOARD_INGRESS_TOKENS
        ? { SWITCHBOARD_INGRESS_TOKENS: env.SWITCHBOARD_INGRESS_TOKENS }
        : {}),
      ...(env.BRAVE_SEARCH_API_KEY ? { BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY } : {}),
      ...(env.MEMORY_TOKEN ? { MEMORY_TOKEN: env.MEMORY_TOKEN } : {}),
    };
  }

  // Default port-ready timeout is 20s; first boot (npm-less image, but cold
  // pull + Slack connect) can exceed it.
  override async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts(this.defaultPort, { portReadyTimeoutMS: 120_000 });
    return super.fetch(request);
  }
}

const INSTANCE = "singleton";
const INTERNAL = "https://switchboard-keepalive.internal";

/** Record a firing on the state Worker's ScheduleDO (the /runs Scheduled panel
 *  reads it). Best-effort: a failure here is a log line — the run itself (if
 *  any) already happened and is its own record. Fail-closed on config: no URL
 *  or bearer → logged, nothing sent. */
async function recordFiring(env: Env, firing: ScheduleFiring): Promise<void> {
  if (!env.STATE_WORKER_URL || !env.MEMORY_TOKEN) {
    console.error(`[schedule] ${firing.schedule}: cannot record firing — ${!env.STATE_WORKER_URL ? "STATE_WORKER_URL var" : "MEMORY_TOKEN secret"} is not set`);
    return;
  }
  try {
    const res = await fetch(`${env.STATE_WORKER_URL.replace(/\/+$/, "")}/schedules/record`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.MEMORY_TOKEN}` },
      body: JSON.stringify({ firing }),
    });
    if (!res.ok) console.error(`[schedule] ${firing.schedule}: recording the firing failed — state Worker HTTP ${res.status}`);
  } catch (err) {
    console.error(`[schedule] ${firing.schedule}: recording the firing failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.SWITCHBOARD, INSTANCE).fetch(request);
  },

  // Every cron trigger in wrangler.jsonc is a schedule in the registry
  // (src/core/schedules.ts — a unit test keeps the two equal). The keep-alive
  // touches /healthz: any touch starts the container if stopped and renews the
  // activity timeout, which is also what revives it after platform maintenance.
  // A `run` schedule POSTs the bot's generic /ingress as the `cron` identity
  // (its bearer is the `cron` entry of SWITCHBOARD_INGRESS_TOKENS — no extra
  // secret) with the schedule's command text; the bot dispatches it as a normal
  // run and answers with the run's id + status, which is recorded on the state
  // Worker for the /runs Scheduled panel. Fail-closed: no `cron` token → nothing
  // is sent and the firing is recorded as `misconfigured`; an ingress error
  // (bot down, unknown identity) is recorded as `ingress-error`.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const schedule = scheduleForCron(controller.cron);
    if (!schedule) {
      console.error(`[schedule] cron "${controller.cron}" is not in the schedule registry — nothing fired (wrangler.jsonc and src/core/schedules.ts have drifted)`);
      return;
    }
    if (schedule.kind === "keep-alive") {
      const res = await getContainer(env.SWITCHBOARD, INSTANCE).fetch(new Request(`${INTERNAL}/healthz`));
      if (!res.ok) console.error(`switchboard health check failed: ${res.status}`);
      return;
    }

    const firedAt = controller.scheduledTime || Date.now();
    const plan = planScheduledFiring(schedule, env.SWITCHBOARD_INGRESS_TOKENS, firedAt);
    if (!plan.ok) {
      console.error(`[schedule] ${schedule.name}: not armed — ${plan.reason}; nothing ran`);
      await recordFiring(env, { schedule: schedule.name, firedAt, outcome: "misconfigured", detail: plan.reason });
      return;
    }
    let firing: ScheduleFiring;
    try {
      const res = await getContainer(env.SWITCHBOARD, INSTANCE).fetch(
        new Request(`${INTERNAL}/ingress`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${plan.token}` },
          body: JSON.stringify(plan.body),
        }),
      );
      firing = interpretIngressResponse(schedule, firedAt, res.status, await res.text().catch(() => ""));
    } catch (err) {
      firing = { schedule: schedule.name, firedAt, outcome: "ingress-error", detail: `fetch failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
    }
    // Ids, outcome, and the reply's first line only — never a token.
    console.log(`[schedule] ${schedule.name} → ${firing.outcome}${firing.runId ? ` run ${firing.runId}` : ""}${firing.detail ? ` — ${firing.detail}` : ""}`);
    await recordFiring(env, firing);
  },
} satisfies ExportedHandler<Env>;
