// Cloudflare Containers shim: runs the unchanged Switchboard image as a single
// always-on container instance. The Worker exists only to (re)start the
// container and proxy health checks — all Slack traffic is the container's own
// outbound Socket Mode websocket, so nothing user-facing flows through here.
//
// Verify class/field names against current docs before first deploy:
// https://developers.cloudflare.com/containers/
import { Container, getContainer } from "@cloudflare/containers";

export class Switchboard extends Container<Env> {
  defaultPort = 8080; // the bot's health endpoint (PORT=8080 in the image)
  sleepAfter = "2h"; // cron below touches it every 5m, so it never expires

  // Secrets set via `wrangler secret put` are forwarded into the container.
  envVars = {
    SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: this.env.SLACK_APP_TOKEN,
    ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: this.env.OPENAI_API_KEY ?? "",
    GH_TOKEN: this.env.GH_TOKEN,
  };
}

interface Env {
  SWITCHBOARD: DurableObjectNamespace;
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  GH_TOKEN: string;
}

export default {
  // Manual health check / manual (re)start: `curl https://<worker>/healthz`
  async fetch(req: Request, env: Env): Promise<Response> {
    const container = getContainer(env.SWITCHBOARD, "singleton");
    return container.fetch(req);
  },

  // Keep-alive + revive after host restarts: any touch starts the container
  // if it's stopped and renews the activity timeout.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const container = getContainer(env.SWITCHBOARD, "singleton");
    await container.fetch(new Request("http://switchboard/healthz")).catch(() => {});
  },
};
