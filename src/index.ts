import { createServer } from "node:http";
import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createSlackApp } from "./channels/slack.js";
import { createIngressHandler, parseIngressTokens } from "./channels/http.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";
const OVERRIDES_PATH = process.env.SWITCHBOARD_OVERRIDES ?? "./data/overrides.json";

async function main() {
  for (const v of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
    if (!process.env[v]) {
      console.error(`Missing required env var ${v}`);
      process.exit(1);
    }
  }

  const config = new ConfigStore(CONFIG_PATH, OVERRIDES_PATH);
  const providers = new ProviderRegistry(config.config.providers);
  const app = createSlackApp({ config, providers });

  await app.start();

  // Optional HTTP server. Slack traffic arrives over the outbound Socket Mode
  // websocket, so this port serves (a) a health probe for container platforms
  // (Cloudflare Containers, Fly, k8s) and (b) the authenticated HTTP ingress
  // channel (adapter #3): POST /ingress turns an authed request into the same
  // IncomingMessage the Slack/CLI adapters build and calls the same dispatch().
  if (process.env.PORT) {
    const auth = parseIngressTokens(process.env);
    const ingress = createIngressHandler({ config, providers }, { auth });
    const tokenCount = Object.keys(auth.tokens).length;
    createServer((req, res) => {
      if ((req.url ?? "/").split("?")[0] === "/ingress") {
        ingress(req, res);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }).listen(Number(process.env.PORT), () =>
      console.log(
        `http server on :${process.env.PORT} (health + POST /ingress; ` +
          `${tokenCount > 0 ? `${tokenCount} ingress token(s)` : "ingress DISABLED — no tokens configured"})`,
      ),
    );
  }

  console.log(
    `switchboard running (providers: ${providers.names().join(", ")}; default agent: ${config.config.defaults.agent})`,
  );

  // Graceful drain: close the Slack socket (no new events), let in-flight
  // agent runs finish (up to 15 min), then exit. A plain kill mid-run loses
  // the run and leaves a frozen status card in the thread.
  const { activeRunCount } = await import("./core/dispatcher.js");
  let draining = false;
  const drain = async (signal: string) => {
    if (draining) return;
    draining = true;
    console.log(`[drain] ${signal}: closing Slack socket, ${activeRunCount()} run(s) in flight`);
    await app.stop().catch(() => {});
    const deadline = Date.now() + 15 * 60_000;
    while (activeRunCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`[drain] exiting (${activeRunCount()} run(s) abandoned)`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void drain("SIGTERM"));
  process.on("SIGINT", () => void drain("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
