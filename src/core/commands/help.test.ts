import { describe, expect, it } from "vitest";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { helpShow, registerHelpCommands, type HelpCommandDeps } from "./help.js";

// Feature: features/command-registry.md (phase 4b, KTD25): `help show` — the
// help text derived from the agent registry and the command catalogue, never
// hand-written; the bare word `help` in chat is this command.

const chat: Caller = { kind: "chat", id: "slack:UX", scopes: new Set(), chatGate: (g) => g === "open" };

describe("help.show", () => {
  it("lists the agents, the directive syntax, and every chat-exposed command from the catalogue it is bound to (hidden ones omitted)", async () => {
    const registry = new CommandRegistry<HelpCommandDeps>({ audit: () => {} });
    registerHelpCommands(registry);
    const commands = bindCommands(registry, {
      help: {
        agents: () => [{ name: "general", description: "answers questions" }, { name: "coding", description: "ships PRs" }],
        commands: () => [
          { id: "help.show", describe: "help" },
          { id: "runs.list", describe: "list runs" },
          { id: "runs.get", describe: "hidden in chat", surfaces: { chat: false } },
          { id: "config.set", describe: "set config" },
        ],
      },
    });
    const res = await commands.invoke("help.show", {}, chat);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.value).toMatchObject({ commands: [{ id: "help.show", form: "help show" }, { id: "runs.list", form: "runs list" }, { id: "config.set", form: "config set" }] });
    const text = renderText(commands.get("help.show")!, res.value);
    expect(text).toContain("*Switchboard* — send me a request. Agents:\n• `general` — answers questions\n• `coding` — ships PRs");
    expect(text).toContain("*Per-request directives* (anywhere in the message):\n`agent:review model:anthropic/claude-opus-5 effort:low look at PR #42`");
    expect(text).toContain("*Commands*");
    expect(text).toContain("  runs list   — list runs");
    expect(text).toContain("  config set  — set config");
    expect(text).not.toContain("runs get");
    expect(helpShow).toMatchObject({ scope: "help:read", chatGate: "open", effect: "read" });
  });
});
