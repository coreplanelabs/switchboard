// Local test harness — implemented as a second channel adapter over the same
// core dispatcher the Slack adapter uses, which is also the proof that the
// core is channel-agnostic.
//   npx tsx src/cli.ts "what is 2+2"
//   npx tsx src/cli.ts "agent:review review acme/api#123"
//   npx tsx src/cli.ts "agent:coding model:openai/gpt-5 ship a PR that ..."

import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { dispatch } from "./core/dispatcher.js";
import type { ChannelIO, StatusHandle } from "./core/types.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";

class ConsoleIO implements ChannelIO {
  async reply(text: string): Promise<void> {
    console.log("\n" + text);
  }
  async status(initial: string): Promise<StatusHandle> {
    console.error(initial);
    return {
      update: (note) => console.error(note.split("\n").join(" | ")),
      done: async (summary) => console.error(summary),
    };
  }
  async history(): Promise<[]> {
    return []; // one-shot harness; no prior turns
  }
}

async function main() {
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    console.error('Usage: npx tsx src/cli.ts "[agent:name] [model:provider/model] your request"');
    process.exit(1);
  }

  const config = new ConfigStore(CONFIG_PATH, "./data/cli-overrides.json");
  const providers = new ProviderRegistry(config.config.providers);

  await dispatch(
    { config, providers },
    {
      channelId: "cli:local",
      userId: "cli:local",
      threadKey: `cli:${Date.now()}`,
      text: input,
    },
    new ConsoleIO(),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
