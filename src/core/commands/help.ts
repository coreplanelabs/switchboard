import { commandDefiner, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";
import { catalogueText, chatForm, cliWords, type CommandShape } from "../commandSurface.js";

// `help.show` (phase 4b): the one help text, DERIVED — the agents from the
// agent registry, the per-request directive syntax, and the chat catalogue
// from the command registry itself (every chat-exposed command, in registration
// order). Nothing about a command is hand-written here: adding a registration
// adds its help line. In chat the bare word `help` is this command (KTD25).

export interface HelpCommandDeps {
  help: {
    agents(): Array<{ name: string; description: string }>;
    /** The catalogue this process bound — the very list the adapters expose. */
    commands(): ReadonlyArray<CommandShape & { surfaces?: { chat?: false } }>;
  };
}

const defineCommand = commandDefiner<HelpCommandDeps>();

export const DIRECTIVES_HELP = "`agent:review model:anthropic/claude-opus-5 effort:low look at PR #42` (effort: low | medium | high — lower = faster turns)";

/** The help text around the command list — shared by both renderings. */
function helpFrame(output: JsonValue, commandList: (commands: CommandShape[]) => string[]): string {
  const o = output as JsonObject;
  const agents = (Array.isArray(o.agents) ? o.agents : []).map((a) => a as JsonObject).map((a) => `• \`${String(a.name)}\` — ${String(a.description)}`);
  const commands = (Array.isArray(o.commands) ? o.commands : []).map((c) => c as JsonObject).map((c) => ({ id: String(c.id), describe: String(c.describe) }));
  return [
    "*Switchboard* — send me a request. Agents:",
    ...agents,
    "",
    "*Per-request directives* (anywhere in the message):",
    DIRECTIVES_HELP,
    "",
    "*Commands* (`<group> <verb> [args…] [--option value…]`; `<group> help` lists a group, `<group> <verb> --help` explains one):",
    ...commandList(commands),
  ].join("\n");
}

/** Chat's command list: one bold header per group (first-appearance order),
 *  one bullet per command, no column padding — aligned columns collapse in a
 *  proportional font (Slack, 2026-08-30). */
export function chatCommandList(commands: readonly CommandShape[]): string[] {
  const groups = new Map<string, CommandShape[]>();
  for (const c of commands) {
    const group = cliWords(c.id)[0];
    groups.set(group, [...(groups.get(group) ?? []), c]);
  }
  return [...groups].flatMap(([group, cmds]) => [`*${group}*`, ...cmds.map((c) => `• \`${chatForm(c.id)}\` — ${c.describe}`)]);
}

export const helpShow = defineCommand({
  id: "help.show",
  action: "help:read",
  effect: "read",
  describe: "What Switchboard can do: agents, per-request directives, and every chat command.",
  render: (output) => helpFrame(output, (commands) => [catalogueText(commands)]),
  renderChat: (output) => helpFrame(output, chatCommandList),
  handler: async ({ deps }) => ({
    agents: deps.help.agents() as unknown as JsonValue,
    directives: DIRECTIVES_HELP,
    commands: deps.help
      .commands()
      .filter((c) => c.surfaces?.chat !== false)
      .map((c) => ({ id: c.id, form: chatForm(c.id), describe: c.describe })),
  }),
});

export const helpCommands: readonly CommandDef<HelpCommandDeps>[] = [helpShow] as unknown as CommandDef<HelpCommandDeps>[];

export function registerHelpCommands<D extends HelpCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of helpCommands) registry.register(cmd as unknown as CommandDef<D>);
}
