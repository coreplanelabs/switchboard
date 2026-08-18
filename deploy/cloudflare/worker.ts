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
  GH_TOKEN?: string; // not needed when execution.type is e2b
}

export class SwitchboardServer extends Container<Env> {
  defaultPort = 8080; // the bot's health endpoint (PORT=8080 in the image)
  // Never let this scale to zero: the Slack websocket must stay connected and
  // Slack does not redeliver missed Socket Mode events. Cron pings every 5m.
  sleepAfter = "2h";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
      ...(env.E2B_API_KEY ? { E2B_API_KEY: env.E2B_API_KEY } : {}),
      ...(env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {}),
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
