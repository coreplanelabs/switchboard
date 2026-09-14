import { describe, expect, it } from "vitest";
import { CHAT_OPEN_ACTIONS } from "../authz/grants.js";
import { CommandRegistry, bindCommands, renderText, type Caller } from "../commandRegistry.js";
import { PROJECT_DOCS_URL } from "../docsLink.js";
import { callerWith } from "../testing/callers.js";
import {
  COMMANDS_REFERENCE_URL,
  helpCommandsList,
  helpShow,
  registerHelpCommands,
  type HelpCommandDeps,
} from "./help.js";

// Feature: docs/reference/specs/routing-and-config.md item 21 (the words) and
// docs/reference/specs/command-registry.md: `help` — the bare word in chat — is
// the plain-language guide: how to ask, how to force a preset, how to change a
// route, one pointer to the command reference, and no command grammar; `help
// commands` is the grammar and the catalogue, derived from the registry the
// process bound, never hand-written.

/** A plain Slack user: the open chat commands. */
const chat: Caller = callerWith("chat", "slack:UX", CHAT_OPEN_ACTIONS);

/** A registry with presets of every door — including one no registry ships,
 *  so a line that appears for it is proven derived, not copied. */
const AGENTS_OF_EVERY_DOOR: ReturnType<HelpCommandDeps["help"]["agents"]> = [
  { name: "general", description: "answers questions", door: "routed" },
  { name: "coding", description: "ships PRs", door: "routed" },
  { name: "ship", description: "the coding → review loop to LGTM", door: "directive" },
  { name: "zebra", description: "stripes on demand", door: "routed" },
  { name: "conductor", description: "coordinates other runs", door: "compound" },
];

const CATALOGUE = [
  { id: "help.show", describe: "help" },
  { id: "help.commands", describe: "the commands" },
  { id: "config.show", describe: "show config" },
  { id: "runs.list", describe: "list runs" },
  { id: "runs.get", describe: "hidden in chat", surfaces: { chat: false } as const },
  { id: "config.set", describe: "set config" },
  { id: "repo.list", describe: "list repos" },
];

async function bound(agents = AGENTS_OF_EVERY_DOOR, catalogue = CATALOGUE) {
  const registry = new CommandRegistry<HelpCommandDeps>({ audit: () => {} });
  registerHelpCommands(registry);
  const commands = bindCommands(registry, { help: { agents: () => agents, commands: () => catalogue } });
  const show = async (id: string, surface?: "chat") => {
    const res = await commands.invoke(id, {}, chat);
    if (!res.ok) throw new Error(`${id} failed: ${res.error}`);
    return { value: res.value, text: renderText(commands.get(id)!, res.value, surface ? { surface } : undefined) };
  };
  return { commands, show };
}

describe("help.show — the plain-language guide", () => {
  it("leads with how to ask, then how to force a preset with the routable presets listed off the registry, that ship runs only when named, how to change a route, and one pointer to the command reference", async () => {
    const { show } = await bound();
    const { text } = await show("help.show");
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "*Switchboard* — just describe what you want. I pick the agent for it and say why on the card (`routed: <reason>`).",
    );
    // The compound door, right after: several asks run as the compound preset.
    expect(lines[1]).toBe(
      "Several independent asks in one message run as `conductor`, one child per ask: coordinates other runs",
    );
    // How to force one: the directive, then the presets a plain message picks from — registry order, derived.
    expect(lines[2]).toBe("*Want a particular agent?* Start your message with `agent:<preset>`:");
    expect(lines.slice(3, 6)).toEqual([
      "• `general` — answers questions",
      "• `coding` — ships PRs",
      "• `zebra` — stripes on demand",
    ]);
    // A preset reached by name alone says so, by name.
    expect(lines[6]).toBe("`ship` is never picked for you — name it: `agent:ship` — the coding → review loop to LGTM");
    // How to change a route: once the card closes, a reply with the directive.
    expect(lines[7]).toBe(
      "*Wrong pick?* Once the card closes, reply `agent:<preset>` in the thread and the request runs there instead.",
    );
    // One closing line: where the commands are.
    expect(lines[8]).toBe(
      `Commands (config, runs, repos and more): \`help commands\` lists them; the reference is ${COMMANDS_REFERENCE_URL}`,
    );
    expect(lines).toHaveLength(9);
    expect(COMMANDS_REFERENCE_URL).toBe(`${PROJECT_DOCS_URL}/reference/slack-commands`);
    expect(helpShow).toMatchObject({ action: "help:read", effect: "read" });
  });

  it("prints no command grammar: not the catalogue, not the directive syntax, not `<group> <verb>` — the same text on chat and the terminal", async () => {
    const { show } = await bound();
    const terminal = (await show("help.show")).text;
    const onChat = (await show("help.show", "chat")).text;
    expect(onChat).toBe(terminal);
    for (const grammar of ["config set", "runs list", "repo list", "<group> <verb>", "*Commands*", "model:", "effort:"])
      expect(terminal, grammar).not.toContain(grammar);
    // Chat shape: no padded columns.
    expect(onChat).not.toMatch(/ {3,}/);
  });

  it("the preset lines follow the registry it is bound to: a preset absent from the deps is absent from the text, and a routable one never reads as name-only", async () => {
    const { show } = await bound([{ name: "solo", description: "the only one", door: "routed" }]);
    const { text } = await show("help.show");
    expect(text).toContain("• `solo` — the only one");
    expect(text).not.toContain("general");
    expect(text).not.toContain("never picked for you");
    expect(text).not.toContain("Several independent asks");
  });
});

describe("help.commands — the command reference", () => {
  it("lists the directive syntax and every chat-exposed command from the catalogue it is bound to (hidden ones omitted), in aligned columns on the terminal", async () => {
    const { show } = await bound();
    const { value, text } = await show("help.commands");
    expect(value).toMatchObject({
      commands: [
        { id: "help.show", form: "help show" },
        { id: "help.commands", form: "help commands" },
        { id: "config.show", form: "config show" },
        { id: "runs.list", form: "runs list" },
        { id: "config.set", form: "config set" },
        { id: "repo.list", form: "repo list" },
      ],
    });
    expect(text).toContain(
      "*Per-request directives* (anywhere in the message):\n`agent:review model:anthropic/claude-opus-5 effort:low budget:20 look at PR 42`",
    );
    expect(text).toContain("*Commands*");
    expect(text).toContain("  runs list      — list runs");
    expect(text).toContain("  config set     — set config");
    expect(text).not.toContain("runs get");
    expect(helpCommandsList).toMatchObject({ action: "help:read", effect: "read" });
  });

  it("chat rendering (surface: chat): one bold header per group, one bullet per chat-exposed command, no column padding — the aligned columns collapse in Slack's proportional font", async () => {
    const { show } = await bound();
    const text = (await show("help.commands", "chat")).text;
    const terminal = (await show("help.commands")).text;
    // Both share the frame (the directives); only the command list differs.
    const frame = text.slice(0, text.indexOf("*Commands*"));
    expect(terminal.startsWith(frame)).toBe(true);
    expect(frame).toContain("*Per-request directives*");
    expect(text).not.toMatch(/ {3,}/);
    expect(terminal).toMatch(/ {3,}/);
    const list = text.slice(text.indexOf("*Commands*")).split("\n").slice(1);
    // One header per group, in first-appearance order; the commands of a group under it, registry order.
    expect(list).toEqual([
      "*help*",
      "• `help show` — help",
      "• `help commands` — the commands",
      "*config*",
      "• `config show` — show config",
      "• `config set` — set config",
      "*runs*",
      "• `runs list` — list runs",
      "*repo*",
      "• `repo list` — list repos",
    ]);
    // Every chat-exposed command exactly once, nothing hidden leaks — driven by the catalogue, not a hard-coded list.
    for (const c of CATALOGUE) {
      const form = c.id.replace(".", " ");
      expect(text.split(`\`${form}\``).length - 1, form).toBe(c.surfaces?.chat === false ? 0 : 1);
    }
  });
});
