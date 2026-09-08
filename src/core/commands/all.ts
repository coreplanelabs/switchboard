import { CommandRegistry } from "../commandRegistry.js";
import { registerConfigCommands, type ConfigCommandDeps } from "./config.js";
import { registerDeployCommands, type DeployCommandDeps } from "./deploy.js";
import { registerEnvCommands, type EnvCommandDeps } from "./env.js";
import { registerFrictionCommands, type FrictionCommandDeps } from "./friction.js";
import { registerHelpCommands, type HelpCommandDeps } from "./help.js";
import { registerMcpCommands, type McpCommandDeps } from "./mcp.js";
import { registerMemoryCommands, type MemoryCommandDeps } from "./memory.js";
import { registerRepoCommands, type RepoCommandDeps } from "./repo.js";
import { registerRunsCommands, type RunsCommandDeps } from "./runs.js";
import { registerScheduleCommands, type ScheduleCommandDeps } from "./schedule.js";

// Every command the bot registers, and the deps object they are bound to.
// Bound ONCE per process by `buildCoreCommands` (src/core/commandCatalogue.ts)
// — the one binding the bot (src/index.ts) and the CLI (src/cli.ts) share — so
// HTTP, MCP, CLI, and chat all expose the same catalogue (KD2). Since phase 4b
// this IS every command there is: no legacy chat parser, no standalone CLI. A
// new command group adds its deps slice here and its `register*` call below; no
// adapter changes.

export type CoreCommandDeps = HelpCommandDeps &
  ConfigCommandDeps &
  RunsCommandDeps &
  FrictionCommandDeps &
  RepoCommandDeps &
  MemoryCommandDeps &
  McpCommandDeps &
  ScheduleCommandDeps &
  DeployCommandDeps &
  EnvCommandDeps;

export function registerCoreCommands(registry: CommandRegistry<CoreCommandDeps>): void {
  registerHelpCommands(registry);
  registerConfigCommands(registry);
  registerRunsCommands(registry);
  registerFrictionCommands(registry);
  registerRepoCommands(registry);
  registerMemoryCommands(registry);
  registerMcpCommands(registry);
  registerScheduleCommands(registry);
  registerDeployCommands(registry);
  registerEnvCommands(registry);
}

/** The `<group>` of every registered command's action, once each, sorted — the
 *  vocabulary an Access browser session's baseline reads (every `<group>:read`)
 *  are spelled in (`src/core/authz/grants.ts`). Derived from the catalogue so a
 *  new group is covered automatically; handed to `ConfigStore` at startup
 *  because `config.ts` cannot import the catalogue (the config commands import it). */
export function coreCommandGroups(): string[] {
  const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {} });
  registerCoreCommands(registry);
  return [...new Set(registry.list().map((c) => c.action.slice(0, c.action.indexOf(":"))))].sort();
}
