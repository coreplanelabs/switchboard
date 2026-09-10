import { z } from "zod";
import { hasAction } from "./authorize.js";
import { NO_GRANTS, type Grants, type GrantSet } from "./types.js";

// Grants: WHAT an actor may do, from config's one shape —
// the native `grants` block (one entry per platform-namespaced actor id, or
// `<ns>:*` for every actor authenticated on a surface) — plus `restrict`, which
// names the agents and repos that are CLOSED unless a grant covers them.
// Everything not restricted is open to everyone who can reach the bot; a grant
// only ever adds. Pure: no I/O, no decisions — nothing here says whether an
// action is allowed; that is `authorize`.

/** Every grant, on every axis. What admins and the local CLI hold. */
export const ALL_GRANTS: Grants = Object.freeze({ actions: "all", channels: "all", repos: "all" });

/** The namespaces a native `grants` key may use (invariant 4). `cli:` is not
 *  configurable (the local CLI always holds everything) and `agent:` actors
 *  derive their grants from their principal, so neither is listed. */
export const GRANT_ACTOR_PREFIXES = ["slack", "http", "mcp", "access", "schedule"] as const;

/** The surfaces whose every authenticated actor may be granted at once with one
 *  `<ns>:*` entry: who may authenticate there is decided elsewhere (Cloudflare
 *  Access admits the org, Slack the workspace, the token maps the credentials),
 *  so "everyone on this surface" is a set an operator already trusts. Not here:
 *  `schedule:` (a schedule is an individually named job the registry declares),
 *  `access:svc:` (a service token is a named credential, not a browser session —
 *  `access:*` never reaches one), and the unconfigurable `cli:` and `agent:`. */
export const SURFACE_GRANT_PREFIXES = ["slack", "http", "mcp", "access"] as const;

/** The `<ns>:*` key for the surface `actorId` authenticated on — `slack:*` for
 *  `slack:U…`, `access:*` for a browser `access:<sub>` — or undefined when its
 *  namespace has none (`access:svc:`, `schedule:`, `cli:`, `agent:`, unknown). */
export function surfaceKeyFor(actorId: string): string | undefined {
  if (actorId.startsWith("access:svc:")) return undefined;
  const colon = actorId.indexOf(":");
  if (colon <= 0 || colon === actorId.length - 1) return undefined;
  const ns = actorId.slice(0, colon);
  return (SURFACE_GRANT_PREFIXES as readonly string[]).includes(ns) ? `${ns}:*` : undefined;
}

/** The action that lets an actor run agent `<name>` — checked only for a
 *  RESTRICTED agent (`restrict.agents`); every other agent is open. */
export function agentRunAction(agent: string): string {
  return `agent:run:${agent}`;
}

/** The actions of the commands the `open` chat gate admitted before they became
 *  policy rows: what EVERY Slack user holds. A command group not listed here
 *  is closed to chat users until config grants it (fail-closed).
 *  `config:write` is not here: `config set channel` is held where `grants` say
 *  so (admins through `actions: all`) and nowhere else. */
export const CHAT_OPEN_ACTIONS: readonly string[] = [
  "help:read",
  "config:read",
  "repo:read",
  "friction:read",
  "memory:read",
  "mcp:read",
  "schedule:read",
  "memory:write",
  "mcp:write",
];

/** What an Access browser session holds implicitly: every registered
 *  group's read — never a write, never an exec. */
export function browserReadActions(commandGroups: readonly string[]): Set<string> {
  return new Set(commandGroups.map((g) => `${g}:read`));
}

// ---- the native `grants` block ----------------------------------------------

/** One axis as config spells it: a list of names, or the explicit word "all". */
export type GrantListConfig = readonly string[] | "all";

/** One actor's entry. An ABSENT axis is the empty set (fail-closed). */
export interface GrantsEntryConfig {
  actions?: GrantListConfig;
  channels?: GrantListConfig;
  repos?: GrantListConfig;
}

/** `grants:` in config.yaml — actor id → entry. */
export type GrantsConfig = Record<string, GrantsEntryConfig>;

const grantList = z.union([z.literal("all"), z.array(z.string().min(1))]);
const grantsEntrySchema = z
  .object({ actions: grantList.optional(), channels: grantList.optional(), repos: grantList.optional() })
  .strict();

export type ParsedGrantsConfig = { ok: true; grants: Map<string, Grants> } | { ok: false; errors: string[] };

function toSet(v: GrantListConfig | undefined): GrantSet {
  if (v === "all") return "all";
  return new Set(v ?? []);
}

function hasKnownPrefix(actorId: string): boolean {
  const colon = actorId.indexOf(":");
  if (colon <= 0 || colon === actorId.length - 1) return false;
  return (GRANT_ACTOR_PREFIXES as readonly string[]).includes(actorId.slice(0, colon));
}

/** Validate a raw `grants` block and build its table. Every problem names the
 *  actor id (and the axis) it is about; nothing is silently dropped or widened.
 *  `*` is only ever a whole surface (`surfaceKeyFor`): a partial subject
 *  (`slack:U*`) would be a pattern the lookup cannot honour, and `schedule:*`,
 *  `access:svc:*`, `agent:*`, `cli:*` name namespaces no surface entry covers. */
export function parseGrantsConfig(raw: unknown): ParsedGrantsConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, errors: ["grants must be a mapping of actor id → { actions, channels, repos }"] };
  const errors: string[] = [];
  const grants = new Map<string, Grants>();
  for (const [actorId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const where = `grants["${actorId}"]`;
    if (actorId.includes("*") && surfaceKeyFor(actorId) !== actorId) {
      errors.push(
        `${where}: "*" only ever stands for a whole surface — one of ${SURFACE_GRANT_PREFIXES.map((p) => `${p}:*`).join(", ")} (every actor authenticated there); a subject is never a pattern, and schedule:, access:svc:, agent: and cli: ids are named one by one`,
      );
      continue;
    }
    if (!hasKnownPrefix(actorId)) {
      errors.push(
        `${where}: actor ids are platform-namespaced — one of ${GRANT_ACTOR_PREFIXES.map((p) => `${p}:`).join(", ")} followed by the subject`,
      );
      continue;
    }
    const parsed = grantsEntrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const axis = issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : "";
        errors.push(
          issue.code === "unrecognized_keys"
            ? `${where}: unknown field ${issue.keys.join(", ")} (expected actions, channels, repos)`
            : `${where}${axis}: expected "all" or a list of non-empty names`,
        );
      }
      continue;
    }
    grants.set(actorId, {
      actions: toSet(parsed.data.actions),
      channels: toSet(parsed.data.channels),
      repos: toSet(parsed.data.repos),
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, grants };
}

// ---- `restrict`: what is closed unless granted -------------------------------------

/** `restrict:` in config.yaml. An agent listed here runs only for an actor whose
 *  grants hold `agent:run:<name>` (or `all`); a repo listed here (an `owner/name`
 *  slug) is used only by an actor whose `repos` axis names it (or `all`).
 *  Everything unlisted is open to everyone who can reach the bot. The lock and
 *  the allowlist are kept apart: listing a grant never takes anything from
 *  anyone else. */
export interface RestrictConfig {
  agents?: readonly string[];
  repos?: readonly string[];
}

/** The parsed block: repo slugs lowercased once, since every lookup is by a
 *  lowercased slug (`parseSlug`/`slugOf`/`repoResourceId`). */
export interface Restriction {
  agents: ReadonlySet<string>;
  repos: ReadonlySet<string>;
}

export const NO_RESTRICTION: Restriction = Object.freeze({ agents: new Set<string>(), repos: new Set<string>() });

const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const restrictSchema = z
  .object({ agents: z.array(z.string().min(1)).optional(), repos: z.array(z.string().min(1)).optional() })
  .strict();

export type ParsedRestrictConfig = { ok: true; restrict: Restriction } | { ok: false; errors: string[] };

/** Validate a raw `restrict` block: agents must be registered names (a typo
 *  would otherwise restrict nothing, silently), repos must be `owner/name`. */
export function parseRestrictConfig(raw: unknown, agentNames: readonly string[]): ParsedRestrictConfig {
  if (raw === undefined) return { ok: true, restrict: NO_RESTRICTION };
  const parsed = restrictSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.code === "unrecognized_keys"
          ? `restrict: unknown field ${issue.keys.join(", ")} (expected agents, repos)`
          : `restrict${issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : ""}: expected a list of non-empty names`,
      ),
    };
  }
  const errors: string[] = [];
  for (const agent of parsed.data.agents ?? []) {
    if (!agentNames.includes(agent))
      errors.push(`restrict.agents: "${agent}" is not a registered agent (${agentNames.join(", ")})`);
  }
  for (const repo of parsed.data.repos ?? []) {
    if (!REPO_SLUG_RE.test(repo)) errors.push(`restrict.repos: "${repo}" is not an owner/name slug`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    restrict: {
      agents: new Set(parsed.data.agents ?? []),
      repos: new Set((parsed.data.repos ?? []).map((r) => r.toLowerCase())),
    },
  };
}

/** Whether `set` covers `name` — `all`, or the name itself. */
export function covers(set: GrantSet, name: string): boolean {
  return set === "all" || set.has(name);
}

// ---- the table: native entries, registry defaults, baselines -----------------------

/** Everything grants can come from. Every field optional: a deployment may have
 *  no `grants` block at all (then every actor is `NO_GRANTS` beyond its baseline). */
export interface GrantsSource {
  /** The native block, already parsed (`parseGrantsConfig`). */
  grants?: ReadonlyMap<string, Grants>;
  /** The parsed `restrict` block; absent = nothing restricted. */
  restrict?: Restriction;
  /** The registered agents; absent = none (no agent is open to everyone). */
  agentNames?: readonly string[];
  /** The registered command groups; absent = none (a browser session holds nothing). */
  commandGroups?: readonly string[];
  /** The schedule registry's declared actors (`RunAction.actor`): each
   *  schedule's grants as the registry states them. The floor for a
   *  `schedule:<name>` id — a native `grants` entry for the same id replaces
   *  them (config decides). */
  schedules?: readonly { readonly id: string; readonly grants: Grants }[];
}

export interface GrantsTable {
  /** Every actor the config or the schedule registry names, with its baseline unioned in. Never a `*` key. */
  grants: Map<string, Grants>;
  /** The `<ns>:*` entries by key: what every actor authenticated on that surface
   *  holds beyond its baseline, unioned into each of them at lookup — never
   *  replacing an actor's own entry, never listed as an actor (a surface is not
   *  someone `adminsHint` can name). */
  surfaces: Map<string, Grants>;
  /** What every `slack:` user holds, listed or not: the open chat commands and `agent:run:<name>` for every unrestricted agent. */
  everyone: Grants;
  /** What every Access browser session (`access:<sub>`, never `access:svc:`) holds: each registered group's read. */
  browserReads: Grants;
  restrict: Restriction;
}

/** The baseline an actor id inherits by its namespace, listed or not: a `slack:`
 *  user holds what `everyone` does; an Access browser session holds every
 *  `<group>:read`. Every other namespace (`schedule:`, `access:svc:`, `http:`,
 *  `mcp:`) is a credential or a job that holds exactly what names it — an
 *  unlisted one is `NO_GRANTS` (fail-closed). */
export function namespaceBaseline(actorId: string, table: Pick<GrantsTable, "everyone" | "browserReads">): Grants {
  if (actorId.startsWith("slack:")) return table.everyone;
  if (actorId.startsWith("access:") && !actorId.startsWith("access:svc:")) return table.browserReads;
  return NO_GRANTS;
}

/** The whole table — what `ConfigStore` builds once at load. A native `slack:`
 *  or browser entry ADDS to its namespace's baseline (a grant never takes the
 *  open commands away); every other entry is exactly what it declares. A
 *  `<ns>:*` entry is kept apart as a surface entry (`grantsIn` unions it in). A
 *  schedule's registry-declared grants are its floor, replaced whole by a native
 *  entry for the same `schedule:<name>` (the registry is a default, not a
 *  second config shape). */
export function grantsTable(source: GrantsSource): GrantsTable {
  const restrict = source.restrict ?? NO_RESTRICTION;
  const openAgents = (source.agentNames ?? []).filter((a) => !restrict.agents.has(a)).map(agentRunAction);
  const baselines = {
    everyone: { ...NO_GRANTS, actions: new Set([...CHAT_OPEN_ACTIONS, ...openAgents]) },
    browserReads: { ...NO_GRANTS, actions: browserReadActions(source.commandGroups ?? []) },
  };
  const grants = new Map<string, Grants>();
  const surfaces = new Map<string, Grants>();
  for (const [id, g] of source.grants ?? []) {
    if (surfaceKeyFor(id) === id) surfaces.set(id, g);
    else grants.set(id, unionGrants(g, namespaceBaseline(id, baselines)));
  }
  for (const schedule of source.schedules ?? []) {
    if (source.grants?.has(schedule.id)) continue;
    grants.set(schedule.id, schedule.grants);
  }
  return { grants, surfaces, ...baselines, restrict };
}

/** One actor's grants from a built table: the UNION of its entry (baseline
 *  included; else the baseline its namespace inherits) and its surface's `*`
 *  entry — a personal entry never narrows what everyone on the surface holds.
 *  Nothing on any axis → `NO_GRANTS` (fail-closed); an id no surface owns has
 *  no `*` entry to inherit. */
export function grantsIn(table: GrantsTable, actorId: string): Grants {
  const own = table.grants.get(actorId) ?? namespaceBaseline(actorId, table);
  const surfaceKey = surfaceKeyFor(actorId);
  const surface = surfaceKey === undefined ? undefined : table.surfaces.get(surfaceKey);
  const effective = surface === undefined ? own : unionGrants(own, surface);
  return isEmpty(effective) ? NO_GRANTS : effective;
}

/** `grantsIn` over a table built on the spot — for callers without a `ConfigStore`. */
export function grantsFor(actorId: string, source: GrantsSource): Grants {
  return grantsIn(grantsTable(source), actorId);
}

/** Whether `actor` may run `agent`: every agent is open unless `restrict.agents`
 *  names it, and then only for a holder of `agent:run:<name>` — literally, through
 *  the `agent:run:*` wildcard, or `all` (the same `hasAction` the policy table reads). */
export function mayRunAgent(table: Pick<GrantsTable, "restrict">, actorGrants: Grants, agent: string): boolean {
  return !table.restrict.agents.has(agent) || hasAction(actorGrants.actions, agentRunAction(agent));
}

/** Whether `actor` may use repo `slug`: every repo is open unless `restrict.repos`
 *  names it, and then only for a holder whose `repos` axis names it (or `all`).
 *  Compared lowercased on both sides — slugs are case-insensitive on GitHub. */
export function mayUseRepo(table: Pick<GrantsTable, "restrict">, actorGrants: Grants, slug: string): boolean {
  const lower = slug.toLowerCase();
  if (!table.restrict.repos.has(lower)) return true;
  if (actorGrants.repos === "all") return true;
  for (const r of actorGrants.repos) if (r.toLowerCase() === lower) return true;
  return false;
}

function unionSet(a: GrantSet, b: GrantSet): GrantSet {
  if (a === "all" || b === "all") return "all";
  return new Set([...a, ...b]);
}

function unionGrants(a: Grants, b: Grants): Grants {
  return {
    actions: unionSet(a.actions, b.actions),
    channels: unionSet(a.channels, b.channels),
    repos: unionSet(a.repos, b.repos),
  };
}

function isEmpty(g: Grants): boolean {
  return (
    g.actions !== "all" &&
    g.actions.size === 0 &&
    g.channels !== "all" &&
    g.channels.size === 0 &&
    g.repos !== "all" &&
    g.repos.size === 0
  );
}
