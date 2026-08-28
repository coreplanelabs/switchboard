// Local test harness — implemented as a second channel adapter over the same
// core dispatcher the Slack adapter uses, which is also the proof that the
// core is channel-agnostic.
//   npx tsx src/cli.ts "what is 2+2"
//   npx tsx src/cli.ts "agent:review review acme/api#123"
//   npx tsx src/cli.ts "agent:coding model:openai/gpt-5 ship a PR that ..."
//   npx tsx src/cli.ts --thread cli:mywork "agent:coding continue where we left off"

import { pathToFileURL } from "node:url";
import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { dispatch } from "./core/dispatcher.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";
import { PlainTextFormatter } from "./core/structuredMessage.js";
import type { ChannelIO, StatusHandle, StatusUpdate } from "./core/types.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";

export interface CliInvocation {
  threadKey: string;
  text: string;
}

/** Thread key precedence: `--thread <key>` / `--thread=<key>` flag >
 *  SWITCHBOARD_THREAD env > ephemeral `cli:<timestamp>`. A stable key lets
 *  repeated CLI invocations act as ONE thread (workspace reuse, resident
 *  re-attach / binding persistence). */
export function parseCliInvocation(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CliInvocation {
  const rest: string[] = [];
  let thread: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread") {
      thread = argv[++i];
    } else if (a.startsWith("--thread=")) {
      thread = a.slice("--thread=".length);
    } else {
      rest.push(a);
    }
  }
  return {
    threadKey: thread || env.SWITCHBOARD_THREAD || `cli:${Date.now()}`,
    text: rest.join(" ").trim(),
  };
}

class ConsoleIO implements ChannelIO {
  /** Structured output renders as plain text for the terminal. */
  readonly formatter = new PlainTextFormatter();

  async reply(text: string): Promise<void> {
    console.log("\n" + text);
  }
  async status(initial: StatusUpdate): Promise<StatusHandle> {
    console.error(initial.title);
    return {
      update: (f) => console.error([f.title, f.detail].filter(Boolean).join(" | ").split("\n").join(" | ")),
      done: async (f) => console.error(f.title),
    };
  }
  async history(): Promise<[]> {
    return []; // one-shot harness; no prior turns
  }
}

async function main() {
  const { threadKey, text } = parseCliInvocation(process.argv.slice(2));
  if (!text) {
    console.error(
      'Usage: npx tsx src/cli.ts [--thread <key>] "[agent:name] [model:provider/model] your request"\n' +
        "  --thread <key> (or SWITCHBOARD_THREAD env): stable thread key so repeated runs act as one thread",
    );
    process.exit(1);
  }

  const config = new ConfigStore(CONFIG_PATH, "./data/cli-overrides.json");
  const providers = new ProviderRegistry(config.config.providers);
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);

  await dispatch(
    { config, providers, skills },
    {
      channelId: "cli:local",
      userId: "cli:local",
      threadKey,
      text,
    },
    new ConsoleIO(),
  );
}

// Run only when invoked as a script (tsx/node src/cli.ts), never on import
// (the parsing helper above is unit-tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
