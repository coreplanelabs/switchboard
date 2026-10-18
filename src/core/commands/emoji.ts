import { CommandError, commandDefiner, type CommandRegistry, type JsonObject } from "../commandRegistry.js";
import type { EmojiSyncResult } from "../emoji.js";

export interface EmojiCommandDeps {
  emoji: { sync(): Promise<EmojiSyncResult> };
}
const defineCommand = commandDefiner<EmojiCommandDeps>();

export const emojiSync = defineCommand({
  id: "emoji.sync",
  action: "config:write",
  resource: () => ({ type: "config-scope", kind: "org" }),
  effect: "write",
  surfaces: { chat: false },
  annotations: { destructive: false, risk: () => "refreshes the workspace emoji catalog" },
  describe:
    "Download the workspace's full custom Slack emoji catalog and aliases on demand. Replaces the local catalog, preserves verified cached images on partial failure, and reports name and file counts. No scheduled polling.",
  handler: async ({ deps }) => (await deps.emoji.sync()) as unknown as JsonObject,
  render: (output) => {
    const value = output as JsonObject;
    if (value.status === "unavailable")
      return value.reason === "missing_scope"
        ? "Emoji sync is unavailable: the Slack bot token needs emoji:read. The saved catalog remains available."
        : "Emoji sync is unavailable. The saved catalog remains available.";
    return `Emoji sync ${String(value.status)}: ${String(value.available)}/${String(value.total)} names available, ${String(value.downloaded)} image files downloaded, ${String(value.failed)} names failed. New names appear on the next dashboard page load.`;
  },
});

export function registerEmojiCommands<D extends EmojiCommandDeps>(registry: CommandRegistry<D>): void {
  registry.register(emojiSync);
}

export function unavailableEmojiSync(): never {
  throw new CommandError("unavailable", "Emoji sync needs a connection to the running Switchboard host.");
}
