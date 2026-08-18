import { createServer } from "node:http";
import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createSlackApp } from "./channels/slack.js";

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

  // Optional health endpoint. Slack traffic arrives over the outbound Socket
  // Mode websocket; this port exists only so container platforms (Cloudflare
  // Containers, Fly, k8s) have something to probe/keep-alive.
  if (process.env.PORT) {
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }).listen(Number(process.env.PORT), () =>
      console.log(`health endpoint on :${process.env.PORT}`),
    );
  }

  console.log(
    `switchboard running (providers: ${providers.names().join(", ")}; default agent: ${config.config.defaults.agent})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
