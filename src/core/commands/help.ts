import type { PresetDoor } from "../../agents/registry.js";
import {
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { catalogueText, chatCatalogueText, chatForm, cliWords, type CommandShape } from "../commandSurface.js";
import { PROJECT_DOCS_URL } from "../docsLink.js";

// The two help commands. `help.show` — the bare word `help` in chat — is the
// plain-language guide a person meets first (docs/reference/specs/routing-and-config.md
// item 21): how to ask (describe what you want; the router picks the preset and
// the card says why), how to force a preset (`agent:<preset>`, the presets a
// plain message can mean listed off the registry, and that `ship` runs only
// when named), how to change a route (a reply with `agent:<preset>` once the
// card closes), then one pointer to the command reference. It prints no
// command grammar: commands are a first-class surface for the operator who
// digs in, not the way a person asks. `help.commands` is that surface — the
// per-request directives and every chat-exposed command by group, DERIVED from
// the registry this process bound, so adding a registration adds its line.

export interface HelpCommandDeps {
  help: {
    /** Every preset off the registry, with how a plain message reaches it (`presetDoor`). */
    agents(): Array<{ name: string; description: string; door: PresetDoor }>;
    /** The catalogue this process bound — the very list the adapters expose. */
    commands(): ReadonlyArray<CommandShape & { surfaces?: { chat?: false } }>;
  };
}

const defineCommand = commandDefiner<HelpCommandDeps>();

/** Where the command grammar's reference lives: the one line `help` ends with. */
export const COMMANDS_REFERENCE_URL = `${PROJECT_DOCS_URL}/reference/slack-commands`;

export const DIRECTIVES_HELP =
  "`agent:review model:anthropic/claude-opus-5 effort:low budget:20 look at PR 42` (effort: low | medium | high — lower = faster turns; budget: whole minutes — narrows this run's wall clock, never widens it; a budget too short for a turn plus the write-up is refused by name)";

interface HelpAgent {
  name: string;
  description: string;
  door: PresetDoor;
}

function agentsOf(output: JsonValue): HelpAgent[] {
  const o = output as JsonObject;
  return (Array.isArray(o.agents) ? o.agents : [])
    .map((a) => a as JsonObject)
    .map((a) => ({ name: String(a.name), description: String(a.description), door: String(a.door) as PresetDoor }));
}

/** The guide, the same on every surface: how to ask, how to force a preset,
 *  how to change a route, where the commands are. Every preset line is read
 *  off the registry through the deps — the routable presets as the list a
 *  plain message picks from, the compound preset with its door, the presets
 *  reached only by name with theirs. */
function plainHelp(output: JsonValue): string {
  const agents = agentsOf(output);
  const bullet = (a: HelpAgent) => `• \`${a.name}\` — ${a.description}`;
  return [
    "*Switchboard* — just describe what you want. I pick the agent for it and say why on the card (`routed: <reason>`).",
    ...agents
      .filter((a) => a.door === "compound")
      .map((a) => `Several independent asks in one message run as \`${a.name}\`, one child per ask: ${a.description}`),
    "*Want a particular agent?* Start your message with `agent:<preset>`:",
    ...agents.filter((a) => a.door === "routed").map(bullet),
    ...agents
      .filter((a) => a.door === "directive")
      .map((a) => `\`${a.name}\` is never picked for you — name it: \`agent:${a.name}\` — ${a.description}`),
    "*Wrong pick?* Once the card closes, reply `agent:<preset>` in the thread and the request runs there instead.",
    `Commands (config, runs, repos and more): \`help commands\` lists them; the reference is ${COMMANDS_REFERENCE_URL}`,
  ].join("\n");
}

/** The command reference: the per-request directives, then the command list
 *  under the grammar line — shared by both renderings, which differ only in
 *  the list's shape. */
function commandsFrame(output: JsonValue, commandList: (commands: CommandShape[]) => string[]): string {
  const o = output as JsonObject;
  const commands = (Array.isArray(o.commands) ? o.commands : [])
    .map((c) => c as JsonObject)
    .map((c) => ({ id: String(c.id), describe: String(c.describe) }));
  return [
    "*Per-request directives* (anywhere in the message):",
    DIRECTIVES_HELP,
    "",
    "*Commands* (`<group> <verb> [args…] [--option value…]`; `<group> help` lists a group, `<group> <verb> --help` explains one):",
    ...commandList(commands),
  ].join("\n");
}

/** Chat's command list: one bold header per group (first-appearance order),
 *  then the group's `chatCatalogueText` bullets — the same shape `<group> help`
 *  replies with. */
export function chatCommandList(commands: readonly CommandShape[]): string[] {
  const groups = new Map<string, CommandShape[]>();
  for (const c of commands) {
    const group = cliWords(c.id)[0];
    groups.set(group, [...(groups.get(group) ?? []), c]);
  }
  return [...groups].flatMap(([group, cmds]) => [`*${group}*`, ...chatCatalogueText(cmds).split("\n")]);
}

export const helpShow = defineCommand({
  id: "help.show",
  action: "help:read",
  effect: "read",
  describe: "How to ask in plain words: describe what you want, force an agent, change a route in the thread.",
  render: plainHelp,
  handler: async ({ deps }) => ({
    agents: deps.help.agents() as unknown as JsonValue,
    commandsReference: COMMANDS_REFERENCE_URL,
  }),
});

export const helpCommandsList = defineCommand({
  id: "help.commands",
  action: "help:read",
  effect: "read",
  describe: "Every chat command by group, the grammar, and the per-request directives.",
  render: (output) => commandsFrame(output, (commands) => [catalogueText(commands)]),
  renderChat: (output) => commandsFrame(output, chatCommandList),
  handler: async ({ deps }) => ({
    directives: DIRECTIVES_HELP,
    commands: deps.help
      .commands()
      .filter((c) => c.surfaces?.chat !== false)
      .map((c) => ({ id: c.id, form: chatForm(c.id), describe: c.describe })),
  }),
});

export const helpCommands: readonly CommandDef<HelpCommandDeps>[] = [
  helpShow,
  helpCommandsList,
] as unknown as CommandDef<HelpCommandDeps>[];

export function registerHelpCommands<D extends HelpCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of helpCommands) registry.register(cmd as unknown as CommandDef<D>);
}
