// The mechanical half of docs/reference/* — rendered from the command registry.
//
// Every command is registered once (`src/core/commands/all.ts`) with its args,
// options, action, effect, and per-surface opt-outs; who may run it is the
// policy table's answer (`src/core/authz/policy.ts`, features/authorization.md).
// That registration IS the reference material: a hand-written table can only
// ever be a copy of it that rots (the pre-generator table had no `mcp` group and
// no `deploy restart`). So the tables come from the registry, `npm run docs:gen`
// writes them into the generated regions, and CI's `docs:check` fails when the
// two disagree.
//
// Pure: strings in, markdown out. No fs, no clock, no registry construction.
import type { z } from "zod";
import { authorize } from "../core/authz/authorize.js";
import { CHAT_OPEN_ACTIONS } from "../core/authz/grants.js";
import type { Actor } from "../core/authz/types.js";
import { CAPABILITY_KEYS, gatedBy, type CapabilityKey } from "../core/capabilityGating.js";
import type { CommandAction, CommandDef, SurfaceName } from "../core/commandRegistry.js";
import { acceptsUndefined, resourceOf } from "../core/commandRegistry.js";
import { chatForm, cliFlag, httpPath, isBooleanSchema, mcpToolName, typeHint } from "../core/commandSurface.js";

/** Everything the docs need about one command, flattened out of its definition. */
export interface DocCommand {
  id: string;
  group: string;
  verb: string;
  /** `config set <me|channel> [--agent <string>]` — enum values inlined. */
  usage: string;
  describe: string;
  action: CommandAction;
  /** Who may run it in Slack, in the vocabulary of docs/reference/authorization.md (`whoMayRun`). */
  who: string;
  effect: "read" | "write";
  surfaces: readonly SurfaceName[];
  httpPath: string;
  mcpTool: string;
  /** The capabilities that turn it on (`gatedBy`, src/core/capabilityGating.ts); empty = on in every installation. */
  needs: readonly CapabilityKey[];
}

const ALL_SURFACES: readonly SurfaceName[] = ["chat", "cli", "http", "mcp"];

/** How each surface is named in prose, in the order the tables print them. */
const SURFACE_LABEL: Readonly<Record<SurfaceName, string>> = {
  chat: "Slack",
  cli: "CLI",
  http: "HTTP",
  mcp: "MCP",
};

const slackUser = (id: string, extra: readonly string[]): Actor => ({
  kind: "user",
  id,
  grants: { actions: new Set([...CHAT_OPEN_ACTIONS, ...extra]), channels: new Set(), repos: new Set() },
});

/** The Slack readers a command's "Who can run it" is decided for, narrowest
 *  first, each labelled as docs/reference/authorization.md names the set: a
 *  plain user (the baseline every Slack user holds), one granted the coding
 *  agent, one granted `repo:write` (a repo manager), one granted `config:write`
 *  (channel config), an admin. The label is the first the policy table admits —
 *  the same `authorize` the registry asks. */
const SLACK_READERS: ReadonlyArray<{ label: string; actor: Actor }> = [
  { label: "anyone", actor: slackUser("slack:UDOC", []) },
  { label: "anyone granted `agent:run:coding`", actor: slackUser("slack:UDOC", ["agent:run:coding"]) },
  { label: "repo managers (`repo:write`)", actor: slackUser("slack:UDOC", ["repo:write", "friction:write"]) },
  { label: "channel-config holders (`config:write`)", actor: slackUser("slack:UDOC", ["config:write"]) },
  {
    label: "admins",
    actor: { kind: "user", id: "slack:UDOC", grants: { actions: "all", channels: "all", repos: "all" } },
  },
];

/** Who may run a command in Slack, as the policy table decides it for the
 *  command's own resource (the command, or what its `resource` resolver names
 *  for an empty input) — never a label the definition asserts about itself.
 *  A command no reader passes is "nobody in Slack" (a row is missing). */
export function whoMayRun(cmd: Pick<CommandDef<unknown>, "id" | "action" | "resource">): string {
  const caller = { kind: "chat" as const, id: "slack:UDOC", actor: SLACK_READERS[0]!.actor };
  const resource = resourceOf(cmd, {}, caller);
  return SLACK_READERS.find((r) => authorize(r.actor, cmd.action, resource).allow)?.label ?? "nobody in Slack";
}

/** `<me|channel>` for an enum, `<slug>` otherwise; `[…]` when optional, `…` for rest. */
function argForm(arg: { name: string; schema: z.ZodType; rest?: true }): string {
  const hint = typeHint(arg.schema);
  const label = hint.includes("|") ? hint : arg.name;
  const inner = arg.rest ? `${label}…` : label;
  return acceptsUndefined(arg.schema) ? `[${inner}]` : `<${inner}>`;
}

function optionForm(key: string, schema: z.ZodType): string {
  const flag = cliFlag(key);
  const form = isBooleanSchema(schema) ? flag : `${flag} <${typeHint(schema)}>`;
  return acceptsUndefined(schema) ? `[${form}]` : form;
}

/** The full invocation form. Same shape as `usageLine` in `commandSurface.ts`,
 *  except a positional whose schema is an enum prints its values (`<me|channel>`
 *  rather than `<scope>`) — in a table there is no help text underneath to say
 *  what the values are. */
export function usageFor(cmd: Pick<CommandDef<unknown>, "id" | "args" | "options">): string {
  const parts = [chatForm(cmd.id)];
  for (const arg of cmd.args ?? []) parts.push(argForm(arg));
  for (const [key, schema] of Object.entries(cmd.options?.shape ?? {})) parts.push(optionForm(key, schema));
  return parts.join(" ");
}

/** Flatten the registry's definitions into what the tables print, registration
 *  order preserved (`commands/all.ts` groups them deliberately). */
export function docCommands(cmds: readonly CommandDef<unknown>[]): DocCommand[] {
  return cmds.map((cmd) => {
    const [group, verb] = cmd.id.split(".");
    return {
      id: cmd.id,
      group,
      verb,
      usage: usageFor(cmd),
      describe: cmd.describe,
      action: cmd.action,
      who: whoMayRun(cmd),
      effect: cmd.effect,
      surfaces: ALL_SURFACES.filter((s) => cmd.surfaces?.[s] !== false),
      httpPath: httpPath(cmd.id),
      mcpTool: mcpToolName(cmd.id),
      needs: gatedBy(cmd),
    };
  });
}

/** Prose in a markdown table cell. `|` would end the cell and a newline the row;
 *  a bare `<agent>` (several `describe` texts carry one) is an HTML tag to
 *  GitHub and an unknown component to VitePress's Vue compiler, so angle
 *  brackets are escaped — but only OUTSIDE inline code spans, where `&lt;`
 *  would show up literally. */
export function cell(text: string): string {
  const flat = text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  // Odd segments of the split are the code spans (backtick-delimited).
  return flat
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("");
}

/** A code cell: the whole text is one code span, so only `|` needs escaping. */
function code(text: string): string {
  return `\`${text.replace(/\|/g, "\\|").replace(/\n+/g, " ")}\``;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

/** Groups in registration order, each with its commands. */
function byGroup(cmds: readonly DocCommand[]): { group: string; commands: DocCommand[] }[] {
  const groups: { group: string; commands: DocCommand[] }[] = [];
  for (const cmd of cmds) {
    const last = groups.find((g) => g.group === cmd.group);
    if (last) last.commands.push(cmd);
    else groups.push({ group: cmd.group, commands: [cmd] });
  }
  return groups;
}

/** Where a command can be invoked. Most commands reach all four surfaces, and
 *  spelling that out in every row buries the ones that don't — so the common
 *  case is two words and the exceptions are the ones that read as a list. */
function surfaceList(cmd: DocCommand): string {
  if (cmd.surfaces.length === 0) return "—";
  if (cmd.surfaces.length === ALL_SURFACES.length) return "every surface";
  if (cmd.surfaces.length === 1) return `${SURFACE_LABEL[cmd.surfaces[0]]} only`;
  return cmd.surfaces.map((s) => SURFACE_LABEL[s]).join(" · ");
}

/** docs/reference/cli.md — every registered command, whatever surface it serves,
 *  in the CLI's own invocation form. The canonical "everything there is" table. */
export function renderCliCommands(cmds: readonly DocCommand[]): string {
  const sections = byGroup(cmds.filter((c) => c.surfaces.includes("cli"))).map(({ group, commands }) => {
    const rows = commands.map((c) => [code(c.usage), cell(c.describe), cell(surfaceList(c))]);
    return `### \`${group}\`\n\n${table(["Command", "What it does", "Surfaces"], rows)}`;
  });
  return sections.join("\n\n");
}

/** docs/reference/slack-commands.md — the chat-reachable commands and who may
 *  run each. Commands opted out of chat (`deploy all`, `friction analyze`) are
 *  absent by construction, not by an author remembering to leave them out. */
export function renderChatCommands(cmds: readonly DocCommand[]): string {
  const sections = byGroup(cmds.filter((c) => c.surfaces.includes("chat"))).map(({ group, commands }) => {
    const rows = commands.map((c) => [code(c.usage), cell(c.describe), cell(c.who)]);
    return `### \`${group}\`\n\n${table(["Command", "What it does", "Who can run it"], rows)}`;
  });
  return sections.join("\n\n");
}

/** docs/reference/dashboard-routes.md — the `/api/<group>.<verb>` twin of every
 *  command. Methods are the registry's own rule: a write is POST-only; the
 *  action is the grant a token or Access identity needs for it. */
export function renderApiRoutes(cmds: readonly DocCommand[]): string {
  const rows = cmds
    .filter((c) => c.surfaces.includes("http"))
    .map((c) => [
      code(c.httpPath),
      c.effect === "write" ? "`POST`" : "`GET`, `POST`",
      code(c.action),
      cell(c.describe),
    ]);
  return table(["Route", "Methods", "Action", "What it does"], rows);
}

/** docs/how-to/turn-features-on-and-off.md — the command column of the matrix:
 *  one row per capability axis (the contract's order) and the commands whose
 *  `enabledWhen` needs it, in chat form; an axis that turns on no command reads
 *  "—". Read off the registry through `gatedBy`, so the page cannot claim a
 *  command is behind a capability the code does not gate it on. The closing
 *  line counts the commands on in every installation. */
export function renderCapabilityCommands(cmds: readonly DocCommand[]): string {
  const rows = CAPABILITY_KEYS.map((key) => {
    const on = cmds.filter((c) => c.needs.includes(key)).map((c) => code(chatForm(c.id)));
    return [code(key), on.length === 0 ? "—" : on.join(", ")];
  });
  const alwaysOn = cmds.filter((c) => c.needs.length === 0).length;
  const noun = alwaysOn === 1 ? "command is" : "commands are";
  return `${table(["Capability", "Commands it turns on"], rows)}\n\nThe other ${alwaysOn} ${noun} on in every installation.`;
}

/** Every generated region in docs/, keyed by the file that carries it. The
 *  generator walks exactly this table — a region added here without a marker in
 *  the file (or the reverse) is a `docs:check` failure. */
export const GENERATED_REGIONS: Readonly<
  Record<string, Readonly<Record<string, (cmds: readonly DocCommand[]) => string>>>
> = {
  "reference/cli.md": { "cli-commands": renderCliCommands },
  "reference/slack-commands.md": { "chat-commands": renderChatCommands },
  "reference/dashboard-routes.md": { "api-routes": renderApiRoutes },
  "how-to/turn-features-on-and-off.md": { "capability-commands": renderCapabilityCommands },
};
