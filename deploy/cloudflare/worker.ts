// Cloudflare Containers shim: runs the unchanged Switchboard image as a single
// always-on container instance. Follows the house pattern proven by
// coreplanelabs/infrastructure `terrateam/` (long-lived server in a container,
// singleton DO, cron keep-alive).
//
// The Worker exists only to (re)start the container and run health checks —
// all Slack traffic is the container's own outbound Socket Mode websocket, so
// no routes are needed and nothing user-facing flows through here.
import { Container, getContainer } from "@cloudflare/containers";

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
  SWITCHBOARD_INGRESS_TOKENS?: string; // enables HTTP /ingress + MCP /mcp (JSON token→identity map)
  BRAVE_SEARCH_API_KEY?: string; // web_search backend (Brave); web_fetch works without it
  MEMORY_TOKEN?: string; // durable memory: bearer for the memory service (else in-process store)
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.SWITCHBOARD, INSTANCE).fetch(request);
  },

  // Keep-alive + revive after platform maintenance: any touch starts the
  // container if stopped and renews the activity timeout.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const res = await getContainer(env.SWITCHBOARD, INSTANCE).fetch(
      new Request("https://switchboard-keepalive.internal/healthz"),
    );
    if (!res.ok) {
      console.error(`switchboard health check failed: ${res.status}`);
    }
  },
} satisfies ExportedHandler<Env>;
