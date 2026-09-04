import { z } from "zod";
import { formatConfigDescription, MAX_INSTRUCTIONS_LENGTH, type ConfigDescription, type ConfigStore, type Scope } from "../../config.js";
import { EFFORT_LEVELS, type Effort } from "../../effort.js";
import { CommandError, commandDefiner, type Caller, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";

// The `config.*` registrations (phase 4b): runtime config on the typed model.
//   config show [--channel <id>]
//   config set <channel|me> [--agent x] [--model p/m] [--models.<agent> p/m] [--effort e] [--efforts.<agent> e] [--channel <id>]
//   config clear <channel|me> [--channel <id>]
//   config instructions <channel|me> [text…] [--channel <id>]
// The caller's own channel (`caller.origin`) is the default target; `--channel`
// names another (or is required where there is no origin — a machine surface).
// `me` is the caller's own user scope, always open (pointing yourself at a
// restricted agent is harmless: the run-time agent gate still applies). The
// `channel` scope affects everyone in the channel, so it rides `channelConfig`
// (open when `permissions.channelConfig` is absent): a gate the DATA decides —
// the command declares `open` and the handler asks the caller's resolver for
// `channelConfig` only when the channel scope is named. Dotted option keys
// (`--models.coding x`) nest on every surface (KTD21). None of this reaches a
// model or starts a run.

export interface ConfigCommandDeps {
  config: Pick<
    ConfigStore,
    "describeConfig" | "scopes" | "setChannelOverride" | "setUserOverride" | "clearChannelOverride" | "clearUserOverride"
  > & {
    /** The agent names a scope may pin (`AGENTS` keys). */
    agentNames(): string[];
  };
}

const defineCommand = commandDefiner<ConfigCommandDeps>();

const scopeArg = { name: "scope", schema: z.enum(["channel", "me"]), describe: "`channel` (everyone here) or `me` (your own runs)" } as const;
const channelOption = z.string().optional().describe("target channel (default: the channel you are speaking in)");

const effort = z.enum(EFFORT_LEVELS);
const modelRef = z.string().min(1);

/** The channel a channel-scoped read/write targets: `--channel`, else the
 *  caller's origin; a machine caller with neither must name one. */
function targetChannel(caller: Caller, channel: string | undefined): string {
  const target = channel ?? caller.origin?.channelId;
  if (!target) throw new CommandError("invalid_input", "channel: required on this surface — pass --channel <id>");
  return target;
}

/** The channel scope affects everyone in the channel: the `channelConfig` gate
 *  (chat), or the command's own write scope (machine callers already passed it). */
function assertMayEditChannel(caller: Caller): void {
  if (caller.kind === "chat" && caller.chatGate?.("channelConfig") !== true) throw new CommandError("unauthorized", "Channel config changes are restricted.");
}

/** Scope as shown in replies: instructions are elided to their length so a
 *  2000-char paragraph isn't echoed every time someone changes their model. */
function summarizeScope(s: Scope): JsonObject {
  const { instructions, ...rest } = s;
  return (instructions === undefined ? rest : { ...rest, instructions: `<${instructions.length} chars>` }) as JsonObject;
}

const who = (scope: "channel" | "me") => (scope === "channel" ? "channel" : "your");

// ---- config show ---------------------------------------------------------------------

export const configShow = defineCommand({
  id: "config.show",
  options: z.object({ channel: channelOption }),
  scope: "config:read",
  chatGate: "open",
  effect: "read",
  describe: "The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted.",
  render: (output) => formatConfigDescription(output as unknown as ConfigDescription),
  handler: async ({ options, caller, deps }) => deps.config.describeConfig(targetChannel(caller, options.channel), caller.id) as unknown as JsonValue,
});

// ---- config set --------------------------------------------------------------------

export const configSet = defineCommand({
  id: "config.set",
  args: [scopeArg],
  options: z.object({
    agent: z.string().min(1).optional().describe("force which agent handles requests in this scope"),
    model: modelRef.optional().describe("force a model (provider/model) regardless of agent"),
    models: z.record(z.string(), modelRef).optional().describe("per-agent model: --models.<agent> provider/model"),
    effort: effort.optional().describe(`force a model effort (${EFFORT_LEVELS.join(" | ")})`),
    efforts: z.record(z.string(), effort).optional().describe("per-agent effort: --efforts.<agent> low|medium|high"),
    channel: channelOption,
  }),
  scope: "config:write",
  chatGate: "open",
  effect: "write",
  describe: "Set the agent, model, or effort for a channel (gated) or for yourself; per-agent forms take --models.<agent> / --efforts.<agent>.",
  render: (output) => {
    const o = output as JsonObject;
    return `Updated ${who(o.scope as "channel" | "me")} scope. Now: ${JSON.stringify(o.effective)}`;
  },
  handler: async ({ args, options, caller, deps }) => {
    const agents = deps.config.agentNames();
    const patch: Scope = {};
    if (options.agent !== undefined) {
      if (!agents.includes(options.agent)) throw new CommandError("invalid_input", `agent: expected one of ${agents.join(", ")}`);
      patch.agent = options.agent;
    }
    if (options.model !== undefined) patch.model = options.model;
    for (const [key, map] of [
      ["models", options.models],
      ["efforts", options.efforts],
    ] as const) {
      if (!map) continue;
      for (const agent of Object.keys(map)) if (!agents.includes(agent)) throw new CommandError("invalid_input", `${key}.${agent}: expected an agent name (one of ${agents.join(", ")})`);
    }
    if (options.models) patch.models = options.models;
    if (options.effort !== undefined) patch.effort = options.effort as Effort;
    if (options.efforts) patch.efforts = options.efforts as Record<string, Effort>;
    if (Object.keys(patch).length === 0) throw new CommandError("invalid_input", "nothing to set: pass --agent, --model, --models.<agent>, --effort, or --efforts.<agent>");
    let effective: Scope;
    if (args.scope === "channel") {
      const channel = targetChannel(caller, options.channel);
      assertMayEditChannel(caller);
      effective = await deps.config.setChannelOverride(channel, patch);
    } else {
      effective = await deps.config.setUserOverride(caller.id, patch);
    }
    return { scope: args.scope, effective: summarizeScope(effective) };
  },
});

// ---- config clear -------------------------------------------------------------------

export const configClear = defineCommand({
  id: "config.clear",
  args: [scopeArg],
  options: z.object({ channel: channelOption }),
  scope: "config:write",
  chatGate: "open",
  effect: "write",
  describe: "Drop every runtime override of a channel (gated) or of yourself; static config.yaml values show through again.",
  render: (output) => `Cleared ${who((output as JsonObject).scope as "channel" | "me")} overrides.`,
  handler: async ({ args, options, caller, deps }) => {
    if (args.scope === "channel") {
      const channel = targetChannel(caller, options.channel);
      assertMayEditChannel(caller);
      await deps.config.clearChannelOverride(channel);
    } else {
      await deps.config.clearUserOverride(caller.id);
    }
    return { scope: args.scope, cleared: true };
  },
});

// ---- config instructions -----------------------------------------------------------------

const quote = (text: string) => `> ${text.replace(/\n/g, "\n> ")}`;

export const configInstructions = defineCommand({
  id: "config.instructions",
  args: [scopeArg, { name: "text", schema: z.string().optional(), describe: 'the instructions; omit to show the current text, pass "" to clear', rest: true }],
  options: z.object({ channel: channelOption }),
  scope: "config:write",
  chatGate: "open",
  effect: "write",
  describe: "Custom instructions for a channel (gated) or for yourself — advisory prompt content that never changes agent, model, or permissions.",
  render: (output) => {
    const o = output as JsonObject;
    const scope = o.scope as "channel" | "me";
    const w = who(scope);
    const current = typeof o.instructions === "string" ? o.instructions : undefined;
    switch (o.action) {
      case "show":
        return current
          ? `Current ${w} instructions:\n${quote(current)}\nTo clear: \`config instructions ${scope} ""\``
          : `No ${w} instructions are set. Example: \`config instructions ${scope} "Always reply in bullet points"\``;
      case "clear":
        return current ? `Cleared ${w} instructions. The static config text now applies:\n${quote(current)}` : `Cleared ${w} instructions.`;
      default:
        return `Updated ${w} instructions (advisory prompt content — they never change agent, model, or permissions):\n${quote(current ?? "")}`;
    }
  },
  handler: async ({ args, options, caller, deps }) => {
    const channel = args.scope === "channel" ? targetChannel(caller, options.channel) : undefined;
    const scopes = deps.config.scopes(channel ?? caller.origin?.channelId ?? "", caller.id);
    const current = (args.scope === "channel" ? scopes.channel : scopes.user).instructions?.trim();
    // No value at all only SHOWS the current text (a peek must never clear).
    if (args.text === undefined) return { scope: args.scope, action: "show", ...(current ? { instructions: current } : {}) };
    const text = args.text.trim();
    if (text.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new CommandError("invalid_input", `text: too long (${text.length} characters). Instructions ride on every turn, so they're capped at ${MAX_INSTRUCTIONS_LENGTH} characters.`);
    }
    // An explicit empty value clears just the instructions, leaving agent/model intact.
    const patch: Scope = { instructions: text.length > 0 ? text : undefined };
    let effective: Scope;
    if (channel !== undefined) {
      assertMayEditChannel(caller);
      effective = await deps.config.setChannelOverride(channel, patch);
    } else {
      effective = await deps.config.setUserOverride(caller.id, patch);
    }
    if (text.length === 0) {
      // Deleting the runtime key lets any static config.yaml text show
      // through again — say so, rather than claiming nothing applies.
      const fromStatic = effective.instructions?.trim();
      return { scope: args.scope, action: "clear", ...(fromStatic ? { instructions: fromStatic } : {}) };
    }
    return { scope: args.scope, action: "set", instructions: text };
  },
});

export const configCommands: readonly CommandDef<ConfigCommandDeps>[] = [configShow, configSet, configClear, configInstructions] as unknown as CommandDef<ConfigCommandDeps>[];

export function registerConfigCommands<D extends ConfigCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of configCommands) registry.register(cmd as unknown as CommandDef<D>);
}
