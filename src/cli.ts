// Local test harness: run any agent from the terminal, no Slack involved.
//   npx tsx src/cli.ts "what is 2+2"
//   npx tsx src/cli.ts "agent:review review acme/api#123"
//   npx tsx src/cli.ts "agent:coding model:openai/gpt-5 ship a PR that ..."
// Uses config/config.yaml, a scratch overrides file, and ./workspaces/cli-<ts>.

import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { getAgent } from "./agents/registry.js";
import { parseDirectives } from "./directives.js";
import { runAgent } from "./runner.js";
import { ensureWorkspace } from "./tools/workspace.js";
import { parseModelRef } from "./providers/types.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";

async function main() {
  const input = process.argv.slice(2).join(" ").trim();
  if (!input) {
    console.error('Usage: npx tsx src/cli.ts "[agent:name] [model:provider/model] your request"');
    process.exit(1);
  }

  const config = new ConfigStore(CONFIG_PATH, "./data/cli-overrides.json");
  const providers = new ProviderRegistry(config.config.providers);

  const d = parseDirectives(input);
  const resolved = config.resolve({
    channelId: "cli",
    userId: "cli",
    request: { agent: d.agent, model: d.model },
  });
  const agent = getAgent(resolved.agentName);
  const { provider: providerName, model } = parseModelRef(resolved.modelRef);

  const workspaceDir = ensureWorkspace(
    config.config.workspaceDir ?? "./workspaces",
    `cli-${Date.now()}`,
  );
  console.error(`[agent=${agent.name} model=${resolved.modelRef} workspace=${workspaceDir}]`);

  const answer = await runAgent({
    provider: providers.get(providerName),
    model,
    agent,
    messages: [{ role: "user", content: [{ type: "text", text: d.text }] }],
    toolContext: { workspaceDir },
    onProgress: (note) => console.error(`  > ${note}`),
  });
  console.log("\n" + answer);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
