import type { CommandRegistry } from "../commandRegistry.js";
import { registerFrictionCommands, type FrictionCommandDeps } from "./friction.js";
import { registerRepoCommands, type RepoCommandDeps } from "./repo.js";
import { registerRunsCommands, type RunsCommandDeps } from "./runs.js";

// Every command the bot registers, and the deps object they are bound to.
// Bound ONCE per process by `buildCoreCommands` (src/commandCli.ts) — the one
// binding the bot (src/index.ts), the chat harness (src/cli.ts) and the command
// CLI share — so HTTP, MCP, CLI, and chat all expose the same catalogue (KD2).
// A new command group adds its deps slice here and its `register*` call below;
// no adapter changes.

export type CoreCommandDeps = RunsCommandDeps & FrictionCommandDeps & RepoCommandDeps;

export function registerCoreCommands(registry: CommandRegistry<CoreCommandDeps>): void {
  registerRunsCommands(registry);
  registerFrictionCommands(registry);
  registerRepoCommands(registry);
}
