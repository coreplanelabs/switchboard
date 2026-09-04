import { describe, expect, it } from "vitest";
import { CHAT_OPEN_ACTIONS } from "../authz/grants.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { helpShow, registerHelpCommands, type HelpCommandDeps } from "./help.js";

// Feature: features/command-registry.md (phase 4b, KTD25): `help show` — the
// help text derived from the agent registry and the command catalogue, never
// hand-written; the bare word `help` in chat is this command.

/** A plain Slack user: the open chat commands. */
const chat: Caller = callerWith("chat", "slack:UX", CHAT_OPEN_ACTIONS);

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
    expect(helpShow).toMatchObject({ action: "help:read", effect: "read" });
  });

  it("chat rendering (surface: chat): one bold header per group, one bullet per chat-exposed command, no column padding — the aligned columns collapse in Slack's proportional font", async () => {
    const registry = new CommandRegistry<HelpCommandDeps>({ audit: () => {} });
    registerHelpCommands(registry);
    const catalogue = [
      { id: "help.show", describe: "help" },
      { id: "config.show", describe: "show config" },
      { id: "runs.list", describe: "list runs" },
      { id: "runs.get", describe: "hidden in chat", surfaces: { chat: false } as const },
      { id: "config.set", describe: "set config" },
      { id: "repo.list", describe: "list repos" },
    ];
    const commands = bindCommands(registry, { help: { agents: () => [{ name: "general", description: "answers questions" }], commands: () => catalogue } });
    const res = await commands.invoke("help.show", {}, chat);
    if (!res.ok) throw new Error("unreachable");
    const text = renderText(commands.get("help.show")!, res.value, { surface: "chat" });
    const terminal = renderText(commands.get("help.show")!, res.value);
    // Both share the frame (agents + directives); only the command list differs.
    const frame = text.slice(0, text.indexOf("*Commands*"));
    expect(terminal.startsWith(frame)).toBe(true);
    expect(frame).toContain("*Switchboard* — send me a request. Agents:\n• `general` — answers questions");
    expect(frame).toContain("*Per-request directives*");
    expect(text).not.toMatch(/ {3,}/);
    expect(terminal).toMatch(/ {3,}/);
    const list = text.slice(text.indexOf("*Commands*")).split("\n").slice(1);
    // One header per group, in first-appearance order; the commands of a group under it, registry order.
    expect(list).toEqual(["*help*", "• `help show` — help", "*config*", "• `config show` — show config", "• `config set` — set config", "*runs*", "• `runs list` — list runs", "*repo*", "• `repo list` — list repos"]);
    // Every chat-exposed command exactly once, nothing hidden leaks — driven by the catalogue, not a hard-coded list.
    for (const c of catalogue) {
      const form = c.id.replace(".", " ");
      expect(text.split(`\`${form}\``).length - 1, form).toBe(c.surfaces?.chat === false ? 0 : 1);
    }
  });
});
