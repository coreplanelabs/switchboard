import { z } from "zod";
import {
  fmtScope,
  formatConfigDescription,
  type ChannelScopeIndexRow,
  type ConfigDescription,
  type Scope,
} from "../../config.js";
import { boundaryProblem, INTAKE_MODES, MAX_INSTRUCTIONS_LENGTH, MIN_BOUNDARY_MINUTES } from "../../config/validate.js";
import { CONFIRM_CLASSES, type Boundary } from "../../config/profile.js";
import { IDENTITIES, MACHINE_CLASSES, type MachineClass } from "../../agents/registry.js";
import { EFFORT_LEVELS, type Effort } from "../../effort.js";
import { VERBOSITY_LEVELS } from "../verbosity.js";
import type { HarnessName } from "../harness/contract.js";
import { HARNESS_NAMES } from "../harness/roster.js";
import { ADDRESS_SEVERITIES } from "../shipPipeline.js";
import { authorize } from "../authz/authorize.js";
import { namesOf, type NameDirectory } from "../names.js";
import { pointingActor } from "../authz/pointingActor.js";
import type { ChannelVisibility, ListedChannel } from "../authz/types.js";
import {
  CommandError,
  commandDefiner,
  type Caller,
  type CommandDef,
  type CommandInput,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
  type ParsedCommandInput,
} from "../commandRegistry.js";

// The `config.*` registrations (phase 4b): runtime config on the typed model.
//   config show [--channel <id>]
//   config overrides                       — the channels that carry a scope, setting names only
//   config set <channel|me|thread|org|repo> [--agent x] [--model p/m] [--models.<agent> p/m] [--effort e] [--efforts.<agent> e]
//                           [--pulls.watch on|off] [--pulls.rebaseInFlight n] [--pulls.spendLimitUsd n] [--repo owner/name]
//                           [--verbosity quiet|verbose|debug]
//                           [--harness.<agent> pi|opencode] [--intake.threadReplies mention|classify|always]
//                           [--boundary.maxMinutes n] [--boundary.maxIdentity none|read|write] [--boundary.machines a,b]
//                           [--channel <id>] [--thread <key>]
//   config clear <channel|me|thread> [--channel <id>] [--thread <key>]
//   config instructions <channel|me> [text…] [--channel <id>]
// The caller's own channel (`caller.origin`) is the default target; `--channel`
// names another (or is required where there is no origin — a machine surface).
// The `thread` scope is the caller's own thread (`--thread <key>` on a machine
// surface), carries only the intake gate's mode, and rides a `config-scope
// { thread }` policy row that grants whoever holds the channel's `config:write`.
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
  /** The GitHub read behind the `user` scope's binding write (record 0062):
   *  `GET /users/<login>` over the read credential — `resolveLogin` in
   *  `src/execution/authorBinding.ts`; undefined is a 404 (no such login),
   *  refused by name. Absent — a process without a GitHub credential — the
   *  write is `unavailable` by name. */
  identity?: { resolveLogin(login: string): Promise<{ login: string; id: number } | undefined> };
  config: {
    /** Everything `config show` reports but `channelConfigRestricted`, which is the caller's actor's to decide (`mayEditChannel`). */
    describeConfig(channelId: string, userId: string): Promise<Omit<ConfigDescription, "channelConfigRestricted">>;
    scopes(channelId: string, userId: string): Promise<{ channel: Scope; user: Scope }>;
    setChannelOverride(channelId: string, patch: Scope): Promise<Scope>;
    setUserOverride(userId: string, patch: Scope): Promise<Scope>;
    setThreadOverride(threadKey: string, patch: Scope): Promise<Scope>;
    /** The org tier's runtime half (`config set org --pulls.…`, record 0071). */
    setOrgOverride(patch: Scope): Promise<Scope>;
    /** A repository scope (`config set repo --repo owner/name --pulls.…`, record 0071). */
    setRepoOverride(repo: string, patch: Scope): Promise<Scope>;
    clearRepoOverride(repo: string): Promise<void>;
    clearChannelOverride(channelId: string): Promise<void>;
    clearUserOverride(userId: string): Promise<void>;
    /** Removes one person's author binding alone (`config clear user`, record 0062). */
    clearUserGithub(userId: string): Promise<void>;
    /** The load-time duplicate rule asked before the binding write (`ConfigStore.githubBindingConflict`):
     *  the refusal when another person already binds this login or id across both layers, else undefined. */
    githubBindingConflict(userId: string, binding: { login: string; id: number }): Promise<string | undefined>;
    clearThreadOverride(threadKey: string): Promise<void>;
    /** Every channel with a scope, names only (`ConfigStore.channelsWithScope`), before the per-channel read gate. */
    channelsWithScope(): Promise<ChannelScopeIndexRow[]>;
    /** The agent names a scope may pin (`AGENTS` keys). */
    agentNames(): string[];
  };
  /** The channels the bot is in, with their visibility (`ChannelDirectory.channels`): what
   *  `config channels` offers a person to pick from. Absent, or `unknown` → only the channels
   *  that already carry a scope are offered. */
  channels?: () => Promise<readonly ListedChannel[] | "unknown">;
  /** Display names for the channels `config channels` lists (src/core/names.ts); absent → ids. */
  names?: NameDirectory;
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
  schema: z.enum(["channel", "me", "thread", "user", "org", "repo"]),
  describe:
    "`channel` (everyone here), `me` (your own runs), `thread` (this thread's intake gate), `user` (another person's GitHub binding, identity admins only), `org` or `repo` (the pull-request watch and its caps, `config:write`)",
} as const;
/** `config instructions` keeps the two scopes: a thread carries no instructions text. */
const instructionsScopeArg = {
  name: "scope",
  schema: z.enum(["channel", "me"]),
  describe: "`channel` (everyone here) or `me` (your own runs)",
} as const;
const channelOption = z.string().optional().describe("target channel (default: the channel you are speaking in)");
const threadOption = z.string().optional().describe("target thread key (default: the thread you are speaking in)");

/** Record 0057's audit rule over the parsed scope: a `me` write is the
 *  caller's own and one command undoes it — write; a `channel` or `thread`
 *  write changes what other people run under — destructive. Anything the
 *  enum did not accept never reaches here (`boundBlastRadius` fails closed). */
const destructiveBeyondMe = (input: ParsedCommandInput): boolean => input.args.scope !== "me";

/** The one platform-neutral confirmation sentence for config writes. The
 * accepted command input decides ownership; origin contributes only an
 * adapter-resolved display name. Classification and authorization stay in
 * `destructiveBeyondMe` and the policy table. */
export function configRisk(input: CommandInput, origin?: Caller["origin"]): string {
  const scope = input.args?.[0];
  switch (scope) {
    case "me":
      return "changes your own settings until you reset them";
    case "channel": {
      const explicitChannel = input.options?.channel;
      if (typeof explicitChannel === "string" && explicitChannel !== origin?.channelId) {
        return "changes the target channel's settings for everyone who asks there until reset";
      }
      const channelName = origin?.channelName?.trim();
      const safeName = channelName && !/[\r\n]/.test(channelName) ? channelName : undefined;
      const owner = safeName ? `the ${safeName} channel's` : "this channel's";
      return `changes ${owner} settings for everyone who asks there until reset`;
    }
    case "org":
      return "changes settings for every channel until reset";
    case "user":
      return "changes the affected person's GitHub setting until reset";
    case "repo": {
      const repo = input.options?.repo;
      return typeof repo === "string"
        ? `changes pull-request settings for ${repo} until reset`
        : "changes repository pull-request settings until reset";
    }
    case "thread": {
      const explicitThread = input.options?.thread;
      const owner =
        typeof explicitThread === "string" && explicitThread !== origin?.threadKey
          ? "the target thread's"
          : "this thread's";
      return `changes ${owner} intake setting for everyone who asks there until reset`;
    }
    default:
      return "changes settings until reset";
  }
}

const effort = z.enum(EFFORT_LEVELS);
/** The ladder as the option descriptions print it (`<low|medium|high|xhigh|max>`):
 *  derived, so a level added to `EFFORT_LEVELS` reaches help and the machine
 *  schemas without anyone retyping the list. */
const effortLevels = `<${EFFORT_LEVELS.join("|")}>`;
/** The verbosity ladder as the option prints it (`<quiet|verbose|debug>`;
 *  routing-and-config item 28): derived, so a level added to
 *  `VERBOSITY_LEVELS` reaches help and the machine schemas by itself. */
const verbosity = z.enum(VERBOSITY_LEVELS);
const verbosityLevels = `<${VERBOSITY_LEVELS.join("|")}>`;
const modelRef = z.string().min(1);
/** The roster's words as the option accepts them (`--harness.<agent> pi|opencode`;
 *  docs/reference/specs/harness.md item 8): derived from `HARNESS_NAMES`, so a
 *  harness added to the roster reaches help and the machine schemas by itself,
 *  and a word that is not one is refused by the schema without echoing it. */
const harnessWord = z.enum(HARNESS_NAMES);
const harnessWords = `<${HARNESS_NAMES.join("|")}>`;
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
    // A loose string, like `machines`: the word is held to the two classes by
    // `boundaryProblem` on write, so `never` and `exec` are refused with the
    // validator's own reasons rather than a schema message.
    confirm: z
      .string()
      .optional()
      .describe(
        `the first blast-radius class a command the router bound is handed back at instead of run <${CONFIRM_CLASSES.join("|")}> — a channel or user can only ask more than the layers above it`,
      ),
  })
  .optional();

/** The channel a channel-scoped read/write targets: `--channel`, else the
 *  caller's origin; a machine caller with neither must name one. */
function targetChannel(caller: Caller, channel: string | undefined): string {
  const target = channel ?? caller.origin?.channelId;
  if (!target) throw new CommandError("invalid_input", "channel: required on this surface — pass --channel <id>");
  return target;
}

/** The thread a thread-scoped write targets: `--thread`, else the caller's own
 *  thread; a machine caller with neither must name one. */
function targetThread(caller: Caller, thread: string | undefined): string {
  const target = thread ?? caller.origin?.threadKey;
  if (!target) throw new CommandError("invalid_input", "thread: required on this surface — pass --thread <key>");
  return target;
}

/** The channel scope affects everyone in the channel: the policy table's
 *  `config:write` row on `config-scope { channel }` (the channel-config right). */
function mayEditChannel(caller: Caller, channel: string): boolean {
  return authorize(caller.actor, "config:write", { type: "config-scope", kind: "channel", id: channel }).allow;
}

/** The org scope — and a repository scope, which is the org setting's
 *  per-repository slice (record 0071) — affects every requester: the policy
 *  table's `config:write` row on `config-scope { org }`. */
function assertMayEditOrg(caller: Caller): void {
  if (!authorize(caller.actor, "config:write", { type: "config-scope", kind: "org" }).allow)
    throw new CommandError("unauthorized", "Org and repository config changes are restricted.");
}

function assertMayEditChannel(caller: Caller, channel: string): void {
  if (!mayEditChannel(caller, channel))
    throw new CommandError("unauthorized", "Channel config changes are restricted.");
}

/** A thread's scope carries the channel-config right (routing-and-config item 27):
 *  the policy table's `config:write` row on `config-scope { thread }`, so
 *  whoever may set the channel may set a thread in it. */
function assertMayEditThread(caller: Caller, threadKey: string): void {
  if (!authorize(caller.actor, "config:write", { type: "config-scope", kind: "thread", id: threadKey }).allow)
    throw new CommandError("unauthorized", "Thread config changes are restricted.");
}

/** The one sentence `config set me --github` answers on every surface (record
 *  0062): the binding decides whose name is on a run's commits, so the one
 *  write that would make impersonation trivial — a person typing a login into
 *  their own scope — is refused at the registry door, before the handler,
 *  reason `identity` on the audit line. */
export const ME_GITHUB_MESSAGE = "your GitHub login is set by an identity admin; it is not yours to type";

/** The `user` scope target (`config set|clear user --user <id>`, record 0062):
 *  the policy table's `identity:write` row on `config-scope { user }` — held by
 *  `all` and by a named grants entry, never a baseline, never `config:write`.
 *  Deliberately a HANDLER gate under the commands' declared `config:write`
 *  action, not the declaration itself: the registry admits by the command, the
 *  scope decides the row — so a token granted `identity:write` alone (no
 *  `config:write`) is refused at the registry before this row is asked. An
 *  identity admin therefore holds both actions (or `all`). */
function assertMayWriteIdentity(caller: Caller, userId: string): void {
  if (!authorize(caller.actor, "identity:write", { type: "config-scope", kind: "user", id: userId }).allow)
    throw new CommandError("unauthorized", "GitHub bindings are written by an identity admin.");
}

/** Why a `me` write is refused for a service token (records 0041, 0043): no run is
 *  ever requested as one — the dashboard's chat is a browser session's, never a
 *  token's — so the scope it would write is read by nothing. */
export const ME_ON_SERVICE_TOKEN_MESSAGE =
  "A service token has no personal scope: no run is requested as it, so a `me` setting would apply to nothing. Use `channel` here.";

/**
 * The id whose scope `me` means for this caller: a chat user, the CLI and a token
 * are themselves; a browser session is the person it is linked to (record 0042:
 * `actor.self` carries the `slack:U…` id when the session's email named one) and,
 * unlinked, itself — `access:<sub>`, the identity the dashboard's chat requests its
 * runs as (record 0043), so what the session sets is what its runs read. A service
 * token (`access:svc:…`, a `service` actor) requests no run and has no `me`.
 * Exported for the surfaces that read a person's scope as the viewer.
 */
export function meIdOf(caller: Caller): string | undefined {
  if (caller.kind !== "access") return caller.id;
  if (caller.actor.kind === "service") return undefined;
  return caller.actor.self?.find((id) => id.startsWith("slack:")) ?? caller.id;
}

/** The `me` scope a write may reach, or the refusal by the data
 *  (docs/reference/specs/command-registry.md item 22) for a service token. */
function meIdOrRefuse(caller: Caller): string {
  const id = meIdOf(caller);
  if (id === undefined) throw new CommandError("unauthorized", ME_ON_SERVICE_TOKEN_MESSAGE);
  return id;
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
async function mayReadChannel(
  caller: Caller,
  channel: string,
  deps: ConfigCommandDeps,
  known?: ChannelVisibility,
): Promise<boolean> {
  const origin = caller.origin?.channelId;
  const scopeAt = (visibility: ChannelVisibility) =>
    ({ type: "config-scope", kind: "channel", id: channel, visibility }) as const;
  // A grant (or the caller's own membership) admits the read whatever the
  // channel's visibility, so the directory is asked only when it could change
  // the answer — an admin listing every configured channel asks it never. A
  // visibility the caller already knows (the bot's own channel list) is not asked again.
  if (authorize(caller.actor, "config:read", scopeAt("unknown")).allow) return true;
  const visibility: ChannelVisibility =
    known !== undefined && known !== "unknown"
      ? known
      : origin === channel || !deps.channelVisibility
        ? "unknown"
        : await deps.channelVisibility(channel);
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

const who = (scope: "channel" | "me" | "thread" | "user" | "org" | "repo") =>
  scope === "me" ? "your" : scope === "repo" ? "repository" : scope;

// ---- config show ---------------------------------------------------------------------

export const configShow = defineCommand({
  id: "config.show",
  options: z.object({ channel: channelOption }),
  action: "config:read",
  effect: "read",
  describe:
    "The effective agent/model/effort for you in this channel, the defaults, both scopes, and what is restricted; without a channel (a browser, a token, the CLI), your settings outside any channel.",
  render: (output) => formatConfigDescription(output as unknown as ConfigDescription),
  handler: async ({ options, caller, deps }) => {
    const me = meIdOf(caller) ?? caller.id;
    const channel = options.channel ?? caller.origin?.channelId;
    if (!channel) {
      // No channel to speak of (a browser, a token, the CLI without --channel): the caller's
      // settings outside any channel — the installation defaults under their own scope. The
      // synthetic channel has no scope and nobody's config to read, so no read gate applies and
      // nothing is editable as a channel (record 0041: a settings page never has "no data").
      const description: ConfigDescription = {
        ...(await deps.config.describeConfig(`none:${me}`, me)),
        channel: {},
        channelConfigRestricted: true,
      };
      return description as unknown as JsonValue;
    }
    await assertMayReadChannel(caller, channel, deps);
    // The same question `config set channel` asks, answered for THIS caller's actor — the CLI's `all`, a token's grants, a Slack user's — never for an id the store looks up on its own.
    const description: ConfigDescription = {
      ...(await deps.config.describeConfig(channel, me)),
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

// ---- config channels ---------------------------------------------------------------

/** One channel a person may pick a scope or an MCP tier for. */
export interface PickableChannel {
  channelId: string;
  /** The channel's name without its hash, when the name directory knew it. */
  channelName?: string;
  visibility: ChannelVisibility;
}

export const configChannels = defineCommand({
  id: "config.channels",
  options: z.object({}),
  action: "config:read",
  effect: "read",
  describe:
    "The channels you may pick settings or MCP servers for, by name: the channels the bot is in that you may read, plus any that already carry a scope; `listed: false` says the bot could not list its channels and only the scoped ones are here.",
  render: (output) => {
    const o = output as unknown as { channels: PickableChannel[]; listed: boolean };
    if (o.channels.length === 0)
      return o.listed
        ? "No channel you may read."
        : "The bot's channels could not be listed, and no channel carries a scope.";
    const lines = o.channels.map(
      (c) => `${c.channelName ? `#${c.channelName} (${c.channelId})` : c.channelId} · ${c.visibility}`,
    );
    if (!o.listed)
      lines.push("(the bot's channels could not be listed: only the channels that carry a scope are here)");
    return lines.join("\n");
  },
  handler: async ({ caller, deps }) => {
    // The bot's own channels, when the directory can list them, plus every channel that
    // carries a scope (a machine channel is never in Slack's list) — each admitted by the
    // same read question `config overrides` asks, with the listed visibility where the
    // directory gave one, so a private channel is offered exactly to those who may read it.
    const listed = deps.channels ? await deps.channels().catch((): "unknown" => "unknown") : "unknown";
    const known = new Map<string, ChannelVisibility>();
    if (listed !== "unknown") for (const c of listed) known.set(c.id, c.visibility);
    for (const r of await deps.config.channelsWithScope())
      if (!known.has(r.channelId)) known.set(r.channelId, "unknown");
    const ids = [...known.keys()];
    const readable = await Promise.all(ids.map((id) => mayReadChannel(caller, id, deps, known.get(id))));
    const offered = ids.filter((_, i) => readable[i]);
    const names = deps.names ? await namesOf((id) => deps.names!.channel(id), offered) : new Map<string, string>();
    const channels: PickableChannel[] = offered
      .map((id) => ({
        channelId: id,
        ...(names.has(id) ? { channelName: names.get(id)! } : {}),
        visibility: known.get(id) ?? "unknown",
      }))
      .sort((a, b) => (a.channelName ?? a.channelId).localeCompare(b.channelName ?? b.channelId));
    return { channels, listed: listed !== "unknown" } as unknown as JsonValue;
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
    verbosity: verbosity
      .optional()
      .describe(
        `how much of itself the bot says ${verbosityLevels}: quiet is only what needs you, verbose adds what it is doing for you, debug adds the router's reason`,
      ),
    harness: z
      .record(z.string(), harnessWord)
      .optional()
      .describe(
        `per-agent harness: --harness.<agent> ${harnessWords} — which process drives that agent's runs (under me, your own runs only)`,
      ),
    boundary: boundaryOption,
    review: z
      .object({
        addressSeverity: z
          .enum(ADDRESS_SEVERITIES)
          .optional()
          .describe(
            "the severity to address: a review's approve carrying a finding at or above it is a request_changes, and ship's rounds are held to it (--review.addressSeverity <level>)",
          ),
      })
      .optional(),
    intake: z
      .object({
        threadReplies: z
          .enum(INTAKE_MODES)
          .optional()
          .describe(
            `the thread-reply intake gate's mode in this scope <${INTAKE_MODES.join("|")}> — thread over user over channel over the defaults (--intake.threadReplies <mode>)`,
          ),
      })
      .optional(),
    pulls: z
      .object({
        watch: z
          .enum(["on", "off"])
          .optional()
          .describe(
            "watch a merge-ready pull request until it merges (org and repo scopes; off by default): the unit stays on it and a push to its base that leaves it conflicting buys a rebase (--pulls.watch on|off)",
          ),
        rebaseInFlight: z.coerce
          .number()
          .int()
          .min(1)
          .optional()
          .describe("how many watch rebases may run at once per repository (default 1)"),
        spendLimitUsd: z.coerce
          .number()
          .positive()
          .optional()
          .describe("what one pull request's watch may spend, in dollars"),
      })
      .optional(),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional()
      .describe(
        "the default repository (`owner/name`) for a channel scope, or the repository a repo-scope pull-watch write targets",
      ),
    user: z
      .string()
      .optional()
      .describe("the person whose GitHub binding to write (user scope only): a platform-namespaced id like slack:U…"),
    github: z
      .string()
      .optional()
      .describe(
        "the GitHub login to bind (user scope only, identity admins): resolved to { login, id } via GET /users/<login> and stored in the person's scope",
      ),
    channel: channelOption,
    thread: threadOption,
  }),
  action: "config:write",
  effect: "write",
  // A person never types their own GitHub login (record 0062): refused at
  // the registry door — before parse and handler — so every surface answers the
  // one sentence, with reason `identity` on the audit line.
  door: (input) =>
    input.args[0] === "me" && input.options.github !== undefined
      ? { message: ME_GITHUB_MESSAGE, reason: "identity" }
      : undefined,
  // One `config set` or `config clear` undoes it, but a shared scope changes
  // what other people run under — destructive beyond `me` (record 0057).
  annotations: {
    destructive: destructiveBeyondMe,
    risk: configRisk,
  },
  describe:
    "Set the agent, model, effort, verbosity, harness, boundary or default repository (`--repo owner/name`) for a channel (gated), or agent settings for yourself; per-agent forms take --models.<agent>, --efforts.<agent> and --harness.<agent>. Set the intake gate's mode for a thread (gated like the channel), a person's GitHub binding (`config set user --user <id> --github <login>`, identity admins — never your own: it is not yours to type), or the pull-request watch (`config set org|repo --pulls.watch on|off` with its caps, repo taking `--repo <owner/name>`).",
  // A sentence for the person who typed the command (routing-and-config item
  // 28): the scope's settings in `config show`'s words, never a JSON dump.
  render: (output) => {
    const o = output as JsonObject;
    const effective = o.effective as Scope;
    // The instructions text is never echoed (custom-instructions item 5):
    // `summarizeScope` left its length in its place, and the sentence names it.
    const instructions = effective.instructions !== undefined ? `, instructions ${effective.instructions}` : "";
    return `Updated ${who(o.scope as Parameters<typeof who>[0])} scope: ${fmtScope(effective)}${instructions}.`;
  },
  handler: async ({ args, options, caller, deps }) => {
    const agents = deps.config.agentNames();
    // The `user` scope target carries the binding alone (record 0062): it
    // exists for the identity admin's one write, never to set another person's
    // models — and `--github` belongs to it alone (`me` never reaches here: the
    // door refused it before parse).
    if (args.scope === "user") {
      if (options.github === undefined)
        throw new CommandError(
          "invalid_input",
          "user: pass --github <login> — the user scope carries the binding alone",
        );
      // `--channel`/`--thread` are target selectors other scopes read (ignored
      // here as `me` ignores them); any SETTING beside the binding is refused
      // by name — the user scope exists for the identity write alone.
      const selectors = new Set(["github", "user", "channel", "thread"]);
      if (Object.keys(options).some((k) => !selectors.has(k) && options[k as keyof typeof options] !== undefined))
        throw new CommandError("invalid_input", "user: only --github applies to a user scope target");
      if (options.user === undefined)
        throw new CommandError("invalid_input", "user: required — pass --user <id> naming the person");
      assertMayWriteIdentity(caller, options.user);
      if (!deps.identity)
        throw new CommandError("unavailable", "no GitHub credential is configured, so a login cannot be resolved");
      const binding = await deps.identity.resolveLogin(options.github);
      if (!binding) throw new CommandError("not_found", `GitHub has no user "${options.github}"`);
      // One login and one id under one person, across config.yaml and the
      // overrides together (routing-and-config item 30): the load-time rule is
      // asked HERE, before the write, so a duplicate is refused by the
      // validator's own words instead of stored — a stored duplicate would
      // refuse the whole overrides document at the next load.
      const conflict = await deps.config.githubBindingConflict(options.user, binding);
      if (conflict) throw new CommandError("conflict", conflict);
      const effective = await deps.config.setUserOverride(options.user, {
        github: { login: binding.login, id: binding.id },
      });
      return { scope: args.scope, effective: summarizeScope(effective) };
    }
    if (options.github !== undefined)
      throw new CommandError(
        "invalid_input",
        "github: a GitHub binding is written on the user scope — config set user --user <id> --github <login>",
      );
    // The org and repository scopes carry the pull-request watch alone (record
    // 0071): any other setting stored there would be read by nothing.
    if (args.scope === "org" || args.scope === "repo") {
      assertMayEditOrg(caller);
      const p = options.pulls;
      const pulls: Scope["pulls"] = {
        ...(p?.watch !== undefined ? { watch: p.watch === "on" } : {}),
        ...(p?.rebaseInFlight !== undefined ? { rebaseInFlight: p.rebaseInFlight } : {}),
        ...(p?.spendLimitUsd !== undefined ? { spendLimitUsd: p.spendLimitUsd } : {}),
      };
      if (Object.keys(pulls).length === 0)
        throw new CommandError(
          "invalid_input",
          `${args.scope}: pass --pulls.watch on|off, --pulls.rebaseInFlight <n> or --pulls.spendLimitUsd <usd> — the org and repository scopes carry the pull-request watch alone`,
        );
      const selectors = new Set(["pulls", "repo", "channel", "thread", "user"]);
      if (Object.keys(options).some((k) => !selectors.has(k) && options[k as keyof typeof options] !== undefined))
        throw new CommandError("invalid_input", `${args.scope}: only --pulls.* applies to this scope`);
      let effective: Scope;
      if (args.scope === "repo") {
        if (options.repo === undefined)
          throw new CommandError("invalid_input", "repo: required — pass --repo <owner/name>");
        effective = await deps.config.setRepoOverride(options.repo, { pulls });
      } else {
        effective = await deps.config.setOrgOverride({ pulls });
      }
      return { scope: args.scope, effective: summarizeScope(effective) };
    }
    if (options.pulls !== undefined)
      throw new CommandError(
        "invalid_input",
        "pulls: the pull-request watch is an org or repository setting — config set org|repo --pulls.…",
      );
    if (options.repo !== undefined && args.scope !== "channel")
      throw new CommandError("invalid_input", "repo: a default repository belongs to a channel scope");
    const patch: Scope = {};
    if (options.repo !== undefined) patch.repo = options.repo.toLowerCase();
    if (options.agent !== undefined) {
      if (!agents.includes(options.agent))
        throw new CommandError("invalid_input", `agent: expected one of ${agents.join(", ")}`);
      patch.agent = options.agent;
    }
    if (options.model !== undefined) patch.model = options.model;
    for (const [key, map] of [
      ["models", options.models],
      ["efforts", options.efforts],
      ["harness", options.harness],
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
    // Held to the ladder by the schema; the store holds a stored document to
    // the same rule at load (`validateScopeVerbosity`).
    if (options.verbosity !== undefined) patch.verbosity = options.verbosity;
    // The word was held to the roster by the schema; the store holds a stored
    // document to the same rule at load, so the two paths cannot drift.
    if (options.harness) patch.harness = options.harness as Record<string, HarnessName>;
    if (options.review?.addressSeverity !== undefined)
      patch.review = { addressSeverity: options.review.addressSeverity };
    if (options.intake?.threadReplies !== undefined) patch.intake = { threadReplies: options.intake.threadReplies };
    if (options.boundary) {
      // The list arrives as one comma-separated token and the confirm class as
      // a bare word; the whole boundary is then held to the load-time rule, so
      // a typo is refused by name here exactly as it would be in config.yaml
      // (a class list value is never echoed; `never` and `exec` get the
      // validator's reasons) — and only what passed is typed as a `Boundary`.
      const { machines, ...fields } = options.boundary;
      const raw: Record<string, unknown> = { ...fields };
      if (machines !== undefined) {
        const classes = machines.split(",").map((m) => m.trim());
        if (classes.length === 0 || classes.some((m) => !MACHINE_CLASSES.includes(m as MachineClass)))
          throw new CommandError(
            "invalid_input",
            `boundary.machines: expected a comma-separated list of ${MACHINE_CLASSES.join(", ")}`,
          );
        raw.machines = classes;
      }
      const problem = boundaryProblem("boundary", raw);
      if (problem) throw new CommandError("invalid_input", problem);
      const boundary = raw as Boundary;
      if (Object.keys(boundary).length > 0) patch.boundary = boundary;
    }
    if (Object.keys(patch).length === 0)
      throw new CommandError(
        "invalid_input",
        "nothing to set: pass --agent, --model, --models.<agent>, --effort, --efforts.<agent>, --verbosity, --harness.<agent>, --repo, --intake.threadReplies, or --boundary.<maxMinutes|maxIdentity|machines|confirm>",
      );
    let effective: Scope;
    if (args.scope === "channel") {
      const channel = targetChannel(caller, options.channel);
      assertMayEditChannel(caller, channel);
      effective = await deps.config.setChannelOverride(channel, patch);
    } else if (args.scope === "thread") {
      // The thread layer is read for the intake gate alone (routing-and-config
      // item 27): any other setting stored there would be read by nothing, so
      // it is refused by name rather than silently kept.
      if (Object.keys(patch).some((k) => k !== "intake"))
        throw new CommandError("invalid_input", "thread: only --intake.threadReplies applies to a thread scope");
      const thread = targetThread(caller, options.thread);
      assertMayEditThread(caller, thread);
      effective = await deps.config.setThreadOverride(thread, patch);
    } else {
      effective = await deps.config.setUserOverride(meIdOrRefuse(caller), patch);
    }
    return { scope: args.scope, effective: summarizeScope(effective) };
  },
});

// ---- config clear -------------------------------------------------------------------

export const configClear = defineCommand({
  id: "config.clear",
  args: [scopeArg],
  options: z.object({
    channel: channelOption,
    thread: threadOption,
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional()
      .describe("the repository (`owner/name`) whose scope to drop (repo scope only)"),
    user: z
      .string()
      .optional()
      .describe("the person whose GitHub binding to remove (user scope only, identity admins)"),
  }),
  action: "config:write",
  effect: "write",
  annotations: {
    destructive: destructiveBeyondMe,
    risk: configRisk,
  },
  describe:
    "Drop every runtime override of a channel (gated), of yourself (your GitHub binding stays — it is an identity admin's write), or of a thread (gated like the channel); `config clear user --user <id>` removes one person's GitHub binding (identity admins). Static config.yaml values show through again.",
  render: (output) => {
    const scope = (output as JsonObject).scope as Parameters<typeof who>[0];
    return scope === "user" ? "Cleared the user's GitHub binding." : `Cleared ${who(scope)} overrides.`;
  },
  handler: async ({ args, options, caller, deps }) => {
    if (args.scope === "org") {
      // The org scope's `config set` key alone (record 0071): the org tier's
      // MCP servers are `mcp remove`'s to drop, never cleared from here.
      assertMayEditOrg(caller);
      await deps.config.setOrgOverride({ pulls: undefined } as Scope);
    } else if (args.scope === "repo") {
      assertMayEditOrg(caller);
      if (options.repo === undefined)
        throw new CommandError("invalid_input", "repo: required — pass --repo <owner/name>");
      await deps.config.clearRepoOverride(options.repo);
    } else if (args.scope === "channel") {
      const channel = targetChannel(caller, options.channel);
      assertMayEditChannel(caller, channel);
      await deps.config.clearChannelOverride(channel);
    } else if (args.scope === "thread") {
      const thread = targetThread(caller, options.thread);
      assertMayEditThread(caller, thread);
      await deps.config.clearThreadOverride(thread);
    } else if (args.scope === "user") {
      // The identity admin's undo (record 0062): the binding alone — never the
      // person's other settings, which stay theirs.
      if (options.user === undefined)
        throw new CommandError("invalid_input", "user: required — pass --user <id> naming the person");
      assertMayWriteIdentity(caller, options.user);
      await deps.config.clearUserGithub(options.user);
    } else {
      await deps.config.clearUserOverride(meIdOrRefuse(caller));
    }
    return { scope: args.scope, cleared: true };
  },
});

// ---- config instructions -----------------------------------------------------------------

const quote = (text: string) => `> ${text.replace(/\n/g, "\n> ")}`;

export const configInstructions = defineCommand({
  id: "config.instructions",
  args: [
    instructionsScopeArg,
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
  annotations: {
    destructive: destructiveBeyondMe,
    risk: configRisk,
  },
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
    const scopes = await deps.config.scopes(channel ?? caller.origin?.channelId ?? "", meIdOf(caller) ?? caller.id);
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
      effective = await deps.config.setUserOverride(meIdOrRefuse(caller), patch);
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
  configChannels,
  configSet,
  configClear,
  configInstructions,
] as unknown as CommandDef<ConfigCommandDeps>[];

export function registerConfigCommands<D extends ConfigCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of configCommands) registry.register(cmd as unknown as CommandDef<D>);
}
