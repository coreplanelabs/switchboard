import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderText } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { emojiSync, registerEmojiCommands, type EmojiCommandDeps } from "./emoji.js";
import { createSlackEmojiCache, InMemoryEmojiStore } from "../../channels/slackEmoji.js";

describe("emoji.sync", () => {
  it("requires an operator grant and imports the full catalog without a model run", async () => {
    const cache = createSlackEmojiCache({
      store: new InMemoryEmojiStore(),
      fetch: async () => new Response(new Uint8Array(Buffer.from("GIF89a"))),
    });
    const registry = new CommandRegistry<EmojiCommandDeps>({ audit: () => {} });
    registerEmojiCommands(registry);
    const commands = bindCommands(registry, {
      emoji: {
        sync: () =>
          cache.refresh({
            emoji: {
              list: async () => ({
                ok: true,
                emoji: { ship: "https://emoji.slack-edge.com/T_FIXTURE/ship.gif", shipit: "alias:ship" },
              }),
            },
          }),
      },
    });
    const denied = await commands.invoke("emoji.sync", {}, callerWith("cli", "cli:reader", ["runs:read"]));
    expect(denied).toMatchObject({ ok: false, error: "unauthorized" });
    const result = await commands.invoke("emoji.sync", {}, callerWith("cli", "cli:operator", "all"));
    expect(result).toMatchObject({
      ok: true,
      value: { status: "complete", total: 2, available: 2, downloaded: 1, failed: 0 },
    });
    if (!result.ok) throw new Error(result.message);
    expect(renderText(emojiSync, result.value)).toContain("2/2 names available");
    expect(cache.catalog().shipit).toEqual(cache.catalog().ship);
  });
});
