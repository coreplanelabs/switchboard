import { z } from "zod";
import {
  formatConfigDescription,
  type ChannelScopeIndexRow,
  type ConfigDescription,
  type Scope,
} from "../../config.js";
import { boundaryProblem, MAX_INSTRUCTIONS_LENGTH, MIN_BOUNDARY_MINUTES } from "../../config/validate.js";
import type { Boundary } from "../../config/profile.js";
import { IDENTITIES, MACHINE_CLASSES, type MachineClass } from "../../agents/registry.js";
import { EFFORT_LEVELS, type Effort } from "../../effort.js";
import { authorize } from "../authz/authorize.js";
import { pointingActor } from "../authz/pointingActor.js";
import type { ChannelVisibility } from "../authz/types.js";
import {
  CommandError,
  commandDefiner,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";

// The `config.*` registrations (phase 4b): runtime config on the typed model.
//   config show [--channel <id>]
//   config overrides                       — the channels that carry a scope, setting names only
//   config set <channel|me> [--agent x] [--model p/m] [--models.<agent> p/m] [--effort e] [--efforts.<agent> e]
//                           [--boundary.maxMinutes n] [--boundary.maxIdentity none|read|write] [--boundary.machines a,b] [--channel <id>]
//   config clear <channel|me> [--channel <id>]
//   config instructions <channel|me> [text…] [--channel <id>]
// The caller's own channel (`caller.origin`) is the default target; `--channel`
// names another (or is required where there is no origin — a machine surface).
// `me` is the caller's own user scope: a person always has it (pointing
// yourself at a restricted agent is harmless: the run-time agent gate still
// applies), a credential needs `config:write` — the `config:write` rows on
// `command` in the policy table. The `channel` scope affects everyone in the
// channel, so it is a refusal the DATA decides: the handler asks the same
// table about `config-scope { channel }` only when that scope is named
// (`config:write` is held only where `grants` say so: admins through `all`,
// anyone granted it by name, on any surface).
// Dotted option keys (`--models.coding x`) nest on every surface. None
// of this reaches a model or starts a run.

/** The store's reads and writes, each behind an async accessor: the config is
 *  opened asynchronously (its overrides backing may be the state Worker,
 *  routing-and-config item 12), so a command that needs it awaits the open
 *  exactly when it first reaches for it — and a command that never does never
 *  waits. No classification of commands anywhere. */
export interface ConfigCommandDeps {
  config: {
    /** Everything `config show` reports but `channelConfigRestricted`, which is the caller's actor's to decide (`mayEditChannel`). */
    describeConfig(channelId: string, userId: string): Promise<Omit<ConfigDescription, "channelConfigRestricted">>;
    scopes(channelId: string, userId: string): Promise<{ channel: Scope; user: Scope }>;
    setChannelOverride(channelId: string, patch: Scope): Promise<Scope>;
    setUserOverride(userId: string, patch: Scope): Promise<Scope>;
    clearChannelOverride(channelId: string): Promise<void>;
    clearUserOverride(userId: string): Promise<void>;
    /** Every channel with a scope, names only (`ConfigStore.channelsWithScope`), before the per-channel read gate. */
    channelsWithScope(): Promise<ChannelScopeIndexRow[]>;
    /** The agent names a scope may pin (`AGENTS` keys). */
    agentNames(): string[];
  };
  /** The visibility of a channel a caller names with `--channel` — the channel
   *  directory behind the run stamp, bounded the same way (`channelVisibilityOf`).
   *  Read only when the target is not the caller's own channel. Absent →
   *  `unknown`, so only a grant or the origin admits the read
   *  (authorization.md item 4, the channelConfig read half). */
  channelVisibility?: (channelId: string) => Promise<ChannelVisibility>;
}

const defineCommand = commandDefiner<ConfigCommandDeps>();

const scopeArg = {
  name: "scope",
  schema: z.enum(["channel", "me"]),
  describe: "`channel` (everyone here) or `me` (your own runs)",
} as const;
const channelOption = z.string().optional().describe("target channel (default: the channel you are speaking in)");

const effort = z.enum(EFFORT_LEVELS);
/** The ladder as the option descriptions print it (`<low|medium|high|xhigh|max>`):
 *  derived, so a level added to `EFFORT_LEVELS` reaches help and the machine
 *  schemas without anyone retyping the list. */
const effortLevels = `<${EFFORT_LEVELS.join("|")}>`;
const modelRef = z.string().min(1);
/** The boundary axes as dotted options (`--boundary.maxMinutes 45`): the
 *  minutes coerced from the chat grammar's string, the identity one of the
 *  ladder, the classes a comma-separated list the handler splits and checks
 *  against `MACHINE_CLASSES` (docs/reference/specs/routing-and-config.md item 5). */
const boundaryOption = z
  .object({
    maxMinutes: z.coerce
      .number()
      .int()
      .min(MIN_BOUNDARY_MINUTES)
      .optional()
      .describe(`cap the wall-clock budget of every run in this scope (minutes, >= ${MIN_BOUNDARY_MINUTES})`),
    maxIdentity: z
      .enum(IDENTITIES)
      .optional()
      .describe(`cap the identity runs may act as <${IDENTITIES.join("|")}> — a preset above it is refused`),
    machines: z
      .string()
      .optional()
      .describe(`the machine classes runs may execute on, comma-separated from ${MACHINE_CLASSES.join(", ")}`),
  })
  .optional();

/** The channel a channel-scoped read/write targets: `--channel`, else the
 *  caller's origin; a machine caller with neither must name one. */
function targetChannel(caller: Caller, channel: string | undefined): string {
  const target = channel ?? caller.origin?.channelId;
  if (!target) throw new CommandError("invalid_input", "channel: required on this surface — pass --channel <id>");
  return target;
}

/** The channel scope affects everyone in the channel: the policy table's
 *  `config:write` row on `config-scope { channel }` (the channel-config right). */
function mayEditChannel(caller: Caller, channel: string): boolean {
  return authorize(caller.actor, "config:write", { type: "config-scope", kind: "channel", id: channel }).allow;
}

function assertMayEditChannel(caller: Caller, channel: string): void {
  if (!mayEditChannel(caller, channel))
    throw new CommandError("unauthorized", "Channel config changes are restricted.");
}

/** Why a `me` write is refused on the Access surface (record 0041): a browser
 *  session never requests a run, so the scope it would write is read by nothing. */
export const ME_ON_ACCESS_MESSAGE =
  "Personal settings are set in chat (`config set me`, `config instructions me`): your runs are requested as your chat user, not as this browser session, so a setting written here would apply to nothing. Use `channel` here.";

/** The `me` scope is the caller's own user scope, and a run reads the scope
 *  of the user who requested it — a chat user. The Access surface (the
 *  dashboard, a dashboard bearer) never requests a run, so its `me` would be
 *  a setting that lies: refused by the data, on every surface that carries the
 *  `access` kind (docs/reference/specs/command-registry.md item 22). */
function assertMeWritable(caller: Caller): void {
  if (caller.kind === "access") throw new CommandError("unauthorized", ME_ON_ACCESS_MESSAGE);
}

/** Reading a channel's scope — its instructions text included — from another
 *  channel is the table's decision (authorization.md item 4, the `config:read`
 *  rows on `config-scope { channel }`), asked twice: for the caller's own actor
 *  (by grant: whoever may set the scope may read it, a channel grant naming it,
 *  a public channel) and for the pointing actor (record 0037: one membership,
 *  the origin, no grants — so a private channel's scope is read from inside it
 *  and nowhere else). Inside the channel the membership decides, so the
 *  visibility is not looked up; elsewhere it is the directory's, and `unknown`
 *  — no directory, a failed or slow lookup — reads as private: fail-closed. One
 *  refusal text for private, DM, unknown and nonexistent alike: the reply says
 *  nothing about the channel a workspace member could not already learn. */
async function mayReadChannel(caller: Caller, channel: string, deps: ConfigCommandDeps): Promise<boolean> {
  const origin = caller.origin?.channelId;
  const scopeAt = (visibility: ChannelVisibility) =>
    ({ type: "config-scope", kind: "channel", id: channel, visibility }) as const;
  // A grant (or the caller's own membership) admits the read whatever the
  // channel's visibility, so the directory is asked only when it could change
  // the answer — an admin listing every configured channel asks it never.
  if (authorize(caller.actor, "config:read", scopeAt("unknown")).allow) return true;
  const visibility: ChannelVisibility =
    origin === channel || !deps.channelVisibility ? "unknown" : await deps.channelVisibility(channel);
  const scope = scopeAt(visibility);
  return (
    authorize(caller.actor, "config:read", scope).allow ||
    (origin !== undefined && authorize(pointingActor(caller.actor, origin), "config:read", scope).allow)
  );
}

async function assertMayReadChannel(caller: Caller, channel: string, deps: ConfigCommandDeps): Promise<void> {
  if (!(await mayReadChannel(caller, channel, deps)))
    throw new CommandError("unauthorized", "That channel's config is restricted.");
}

/** Scope as shown in replies: instructions are elided to their length so a
 *  2000-char paragraph isn't echoed every time someone changes their model. */
function summarizeScope(s: Scope): JsonObject {
  const { instructions, ...rest } = s;
  return (
    instructions === undefined ? rest : { ...rest, instructions: `<${instructions.length} chars>` }
  ) as JsonObject;
}

const who = (scope: "channel" | "me") => (scope === "channel" ? "channel" : "your");

// ---- config show ---------------------------------------------------------------------

export const configShow = defineCommand({
  id: "config.show",
  options: z.object({ channel: channelOption }),
  action: "config:read",
  effect: "read",
  describe:
    "The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted.",
  render: (output) => formatConfigDescription(output as unknown as ConfigDescription),
  handler: async ({ options, caller, deps }) => {
    const channel = targetChannel(caller, options.channel);
    await assertMayReadChannel(caller, channel, deps);
    // The same question `config set channel` asks, answered for THIS caller's actor — the CLI's `all`, a token's grants, a Slack user's — never for an id the store looks up on its own.
    const description: ConfigDescription = {
      ...(await deps.config.describeConfig(channel, caller.id)),
      channelConfigRestricted: !mayEditChannel(caller, channel),
    };
    return description as unknown as JsonValue;
  },
});

// ---- config overrides ---------------------------------------------------------------

export const configOverrides = defineCommand({
  id: "config.overrides",
  options: z.object({}),
  action: "config:read",
  effect: "read",
  describe:
    "Which channels carry a scope (a config.yaml block or a runtime override) and which settings each one names — never a value; `config show --channel <id>` reads one.",
  render: (output) => {
    const rows = (output as unknown as { channels: ChannelScopeIndexRow[] }).channels;
    if (rows.length === 0) return "No channel carries a scope.";
    return rows.map((r) => `${r.channelId}: ${r.settings.join(", ")} (${r.source})`).join("\n");
  },
  handler: async ({ caller, deps }) => {
    // The same per-channel question `config show --channel` asks, so the index
    // never names a channel whose scope the caller could not then read; the
    // lookups run side by side, each bounded like a run's visibility stamp.
    const rows = await deps.config.channelsWithScope();
    const readable = await Promise.all(rows.map((r) => mayReadChannel(caller, r.channelId, deps)));
    return { channels: rows.filter((_, i) => readable[i]) } as unknown as JsonValue;
  },
});

// ---- config set --------------------------------------------------------------------

export const configSet = defineCommand({
  id: "config.set",
  args: [scopeArg],
  options: z.object({
    agent: z.string().min(1).optional().describe("force which agent handles requests in this scope"),
    model: modelRef.optional().describe("force a model (provider/model) regardless of agent"),
    models: z.record(z.string(), modelRef).optional().describe("per-agent model: --models.<agent> provider/model"),
    effort: effort.optional().describe(`force a model effort ${effortLevels}`),
    efforts: z.record(z.string(), effort).optional().describe(`per-agent effort: --efforts.<agent> ${effortLevels}`),
    boundary: boundaryOption,
    channel: channelOption,
  }),
  action: "config:write",
  effect: "write",
  describe:
    "Set the agent, model, effort or boundary for a channel (gated) or for yourself; per-agent forms take --models.<agent> / --efforts.<agent>, the boundary's axes --boundary.<axis> (a boundary caps every run in the scope and never grants).",
  render: (output) => {
    const o = output as JsonObject;
    return `Updated ${who(o.scope as "channel" | "me")} scope. Now: ${JSON.stringify(o.effective)}`;
  },
  handler: async ({ args, options, caller, deps }) => {
    const agents = deps.config.agentNames();
    const patch: Scope = {};
    if (options.agent !== undefined) {
      if (!agents.includes(options.agent))
        throw new CommandError("invalid_input", `agent: expected one of ${agents.join(", ")}`);
      patch.agent = options.agent;
    }
    if (options.model !== undefined) patch.model = options.model;
    for (const [key, map] of [
      ["models", options.models],
      ["efforts", options.efforts],
    ] as const) {
      if (!map) continue;
      for (const agent of Object.keys(map))
        if (!agents.includes(agent))
          throw new CommandError(
            "invalid_input",
            `${key}.${agent}: expected an agent name (one of ${agents.join(", ")})`,
          );
    }
    if (options.models) patch.models = options.models;
    if (options.effort !== undefined) patch.effort = options.effort as Effort;
    if (options.efforts) patch.efforts = options.efforts as Record<string, Effort>;
    if (options.boundary) {
      // The list arrives as one comma-separated token; the boundary is then
      // held to the load-time rule, so a typo is refused by name here exactly
      // as it would be in config.yaml — and the value is never echoed.
      const { machines, ...axes } = options.boundary;
      const boundary: Boundary = { ...axes };
      if (machines !== undefined) {
        const classes = machines.split(",").map((m) => m.trim());
        if (classes.length === 0 || classes.some((m) => !MACHINE_CLASSES.includes(m as MachineClass)))
          throw new CommandError(
            "invalid_input",
            `boundary.machines: expected a comma-separated list of ${MACHINE_CLASSES.join(", ")}`,
          );
        boundary.machines = classes as MachineClass[];
      }
      const problem = boundaryProblem("boundary", boundary);
      if (problem) throw new CommandError("invalid_input", problem);
      if (Object.keys(boundary).length > 0) patch.boundary = boundary;
    }
    if (Object.keys(patch).length === 0)
      throw new CommandError(
        "invalid_input",
        "nothing to set: pass --agent, --model, --models.<agent>, --effort, --efforts.<agent>, or --boundary.<maxMinutes|maxIdentity|machines>",
      );
    let effective: Scope;
    if (args.scope === "channel") {
      const channel = targetChannel(caller, options.channel);
      assertMayEditChannel(caller, channel);
      effective = await deps.config.setChannelOverride(channel, patch);
    } else {
      assertMeWritable(caller);
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
  action: "config:write",
  effect: "write",
  describe:
    "Drop every runtime override of a channel (gated) or of yourself; static config.yaml values show through again.",
  render: (output) => `Cleared ${who((output as JsonObject).scope as "channel" | "me")} overrides.`,
  handler: async ({ args, options, caller, deps }) => {
    if (args.scope === "channel") {
      const channel = targetChannel(caller, options.channel);
      assertMayEditChannel(caller, channel);
      await deps.config.clearChannelOverride(channel);
    } else {
      assertMeWritable(caller);
      await deps.config.clearUserOverride(caller.id);
    }
    return { scope: args.scope, cleared: true };
  },
});

// ---- config instructions -----------------------------------------------------------------

const quote = (text: string) => `> ${text.replace(/\n/g, "\n> ")}`;

export const configInstructions = defineCommand({
  id: "config.instructions",
  args: [
    scopeArg,
    {
      name: "text",
      schema: z.string().optional(),
      describe: 'the instructions; omit to show the current text, pass "" to clear',
      rest: true,
    },
  ],
  options: z.object({ channel: channelOption }),
  action: "config:write",
  effect: "write",
  describe:
    "Custom instructions for a channel (gated) or for yourself — advisory prompt content that never changes agent, model, or permissions.",
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
        return current
          ? `Cleared ${w} instructions. The static config text now applies:\n${quote(current)}`
          : `Cleared ${w} instructions.`;
      default:
        return `Updated ${w} instructions (advisory prompt content — they never change agent, model, or permissions):\n${quote(current ?? "")}`;
    }
  },
  handler: async ({ args, options, caller, deps }) => {
    const channel = args.scope === "channel" ? targetChannel(caller, options.channel) : undefined;
    // The peek reads another channel's text under the same rule `config show` does; a write is gated below.
    if (args.text === undefined && channel !== undefined) await assertMayReadChannel(caller, channel, deps);
    const scopes = await deps.config.scopes(channel ?? caller.origin?.channelId ?? "", caller.id);
    const current = (args.scope === "channel" ? scopes.channel : scopes.user).instructions?.trim();
    // No value at all only SHOWS the current text (a peek must never clear).
    if (args.text === undefined)
      return { scope: args.scope, action: "show", ...(current ? { instructions: current } : {}) };
    const text = args.text.trim();
    if (text.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new CommandError(
        "invalid_input",
        `text: too long (${text.length} characters). Instructions ride on every turn, so they're capped at ${MAX_INSTRUCTIONS_LENGTH} characters.`,
      );
    }
    // An explicit empty value clears just the instructions, leaving agent/model intact.
    const patch: Scope = { instructions: text.length > 0 ? text : undefined };
    let effective: Scope;
    if (channel !== undefined) {
      assertMayEditChannel(caller, channel);
      effective = await deps.config.setChannelOverride(channel, patch);
    } else {
      assertMeWritable(caller);
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

export const configCommands: readonly CommandDef<ConfigCommandDeps>[] = [
  configShow,
  configOverrides,
  configSet,
  configClear,
  configInstructions,
] as unknown as CommandDef<ConfigCommandDeps>[];

export function registerConfigCommands<D extends ConfigCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of configCommands) registry.register(cmd as unknown as CommandDef<D>);
}
