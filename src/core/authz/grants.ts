import { z } from "zod";
import type { Permissions } from "../../config.js";
import type { IngressTokenMap } from "../ingressTokens.js";
import { NO_GRANTS, type Grants, type GrantSet } from "./types.js";

// Grants (plan U2 — R7, R8, KTD6): WHAT an actor may do, from config. Two
// shapes are accepted during the dual-acceptance release: the native `grants`
// block (one entry per platform-namespaced actor id) and the legacy keys
// (`permissions.*`, ingress token `scopes`/`channel`, Access `serviceTokens`),
// which `translateLegacyConfig` turns into the same `Grants` by ONE table.
// Native wins for an actor both shapes name (`mergeGrants` reports the
// overlap so `validateConfig` can warn). Pure: no I/O, no decisions — nothing
// here says whether an action is allowed; that is `authorize` (U1).

/** Every grant, on every axis. What admins and the local CLI hold. */
export const ALL_GRANTS: Grants = Object.freeze({ actions: "all", channels: "all", repos: "all" });

/** The namespaces a native `grants` key may use (invariant 4). `cli:` is not
 *  configurable (the local CLI always holds everything) and `agent:` actors
 *  derive their grants from their principal (R2), so neither is listed. */
export const GRANT_ACTOR_PREFIXES = ["slack", "http", "mcp", "access", "schedule"] as const;

/** The action that lets an actor run agent `<name>` (`canRunAgent` today). */
export function agentRunAction(agent: string): string {
  return `agent:run:${agent}`;
}

/** The actions of the commands the `open` chat gate admitted before they became
 *  policy rows (plan U4, KTD5): what EVERY Slack user holds. A command group not
 *  listed here is closed to chat users until config grants it (fail-closed, R7).
 *  `config:write` is not here: it is the `permissions.channelConfig` right and
 *  joins the baseline only while a legacy `permissions` block is present WITHOUT
 *  that key (open-when-absent). A deployment with no `permissions` block has
 *  nothing to be absent from: it holds `config:write` where its `grants` say so
 *  and nowhere else (R7 — production since authz U7 step 1). */
export const CHAT_OPEN_ACTIONS: readonly string[] = ["help:read", "config:read", "repo:read", "friction:read", "memory:read", "mcp:read", "schedule:read", "memory:write", "mcp:write"];

/** What an Access browser session holds implicitly (KTD6/KTD10): every registered
 *  group's read — never a write, never an exec. */
export function browserReadActions(commandGroups: readonly string[]): Set<string> {
  return new Set(commandGroups.map((g) => `${g}:read`));
}

// ---- the native `grants` block ----------------------------------------------

/** One axis as config spells it: a list of names, or the explicit word "all". */
export type GrantListConfig = readonly string[] | "all";

/** One actor's entry. An ABSENT axis is the empty set (fail-closed, R7). */
export interface GrantsEntryConfig {
  actions?: GrantListConfig;
  channels?: GrantListConfig;
  repos?: GrantListConfig;
}

/** `grants:` in config.yaml — actor id → entry. */
export type GrantsConfig = Record<string, GrantsEntryConfig>;

const grantList = z.union([z.literal("all"), z.array(z.string().min(1))]);
const grantsEntrySchema = z.object({ actions: grantList.optional(), channels: grantList.optional(), repos: grantList.optional() }).strict();

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
 *  actor id (and the axis) it is about; nothing is silently dropped or widened. */
export function parseGrantsConfig(raw: unknown): ParsedGrantsConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["grants must be a mapping of actor id → { actions, channels, repos }"] };
  const errors: string[] = [];
  const grants = new Map<string, Grants>();
  for (const [actorId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const where = `grants["${actorId}"]`;
    if (!hasKnownPrefix(actorId)) {
      errors.push(`${where}: actor ids are platform-namespaced — one of ${GRANT_ACTOR_PREFIXES.map((p) => `${p}:`).join(", ")} followed by the subject`);
      continue;
    }
    const parsed = grantsEntrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const axis = issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : "";
        errors.push(issue.code === "unrecognized_keys" ? `${where}: unknown field ${issue.keys.join(", ")} (expected actions, channels, repos)` : `${where}${axis}: expected "all" or a list of non-empty names`);
      }
      continue;
    }
    grants.set(actorId, { actions: toSet(parsed.data.actions), channels: toSet(parsed.data.channels), repos: toSet(parsed.data.repos) });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, grants };
}

// ---- the legacy keys → grants (KTD6) ------------------------------------------

/** The chat-side legacy keys. `serviceTokens` is the Access machine credential
 *  map and travels as its own argument. */
export type LegacyPermissions = Omit<Permissions, "serviceTokens">;

/** What the legacy keys refer to by name but never list: the registered agents
 *  (`permissions.agents` restricts SOME of them; the rest are open to everyone)
 *  and the command groups (`permissions.operators` grants every group's read
 *  and write). Supplied by the caller — this module knows no registry. */
export interface LegacyVocabulary {
  agentNames: readonly string[];
  /** `<group>` of every registered command's `<group>:<read|write|exec>` scope. */
  commandGroups: readonly string[];
}

export interface LegacyTranslation {
  grants: Map<string, Grants>;
  /** What EVERY Slack user holds under the legacy keys, listed or not: the
   *  `open` chat commands (`CHAT_OPEN_ACTIONS`), `agent:run:<name>` for each
   *  agent without an allowlist (`canRunAgent` is true for anyone there), and
   *  `config:write` while a `permissions` block is present without
   *  `channelConfig` (`canEditChannelConfig`'s open-when-absent — a rule about
   *  a legacy block's missing key; no block, no rule). */
  everyone: Grants;
  /** `permissions.repos` ABSENT (KD7): every repo is open to every allowed
   *  coding-agent user. Listed coding users receive `repos: "all"`; the flag
   *  says the same for users no list names. */
  reposOpen: boolean;
  /** The ids a `permissions.*` key names (`serviceTokens` included) — the
   *  legacy entries an operator can delete from config.yaml once a native
   *  entry replaces them. Ingress-token ids are NOT here: a token-map entry is
   *  the credential itself, and a native entry for its `http:`/`mcp:` id is how
   *  a token is granted channels (#453), not a second copy to remove. */
  fromPermissions: ReadonlySet<string>;
}

/**
 * The KTD6 table, plus the two legacy keys it omitted (`repos`, `serviceTokens`):
 *   admins                    → all / all / all
 *   operators                 → every `<group>:read` + `<group>:write` (never `:exec`); channels all
 *   repoManagement            → repo:write, friction:write (absent/empty → nothing; KTD9)
 *   channelConfig             → config:write for the listed; ABSENT from a present `permissions` block → config:write
 *                               for `everyone`; no `permissions` block at all → for nobody by baseline (native only)
 *   (the `open` chat gate)    → CHAT_OPEN_ACTIONS for `everyone`
 *   agents.<name>: [users]    → agent:run:<name> for those users; an agent with
 *                               NO allowlist → agent:run:<name> for `everyone`
 *   repos[slug]: [users]      → repos {slug} per listed user (absent → "all" for coding users, `reposOpen`)
 *   token scopes              → actions of the same names, for BOTH `http:<subject>` and `mcp:<subject>`
 *   token channel             → channels {`http:<channel>`} / {`mcp:<channel>`}; no pin → NO channels (OQ4,
 *                               option a: channels are channels, no machine-channel vocabulary). An unpinned
 *                               token therefore lists nothing and reads no run until a native `grants`
 *                               entry names its channels (or `all`) — R12's fourth deliberate change.
 *   serviceTokens[cn]         → `access:svc:<cn>` actions = scopes; channels all
 * An actor named by several keys holds the union; `all` absorbs a list.
 */
export function translateLegacyConfig(permissions: LegacyPermissions | undefined, ingressTokens: IngressTokenMap | undefined, accessServiceTokens: Record<string, string[]> | undefined, vocabulary: LegacyVocabulary): LegacyTranslation {
  const table = new Map<string, Grants>();
  const fromPermissions = new Set<string>();
  const union = (actorId: string, g: Partial<Grants>) => table.set(actorId, unionGrants(table.get(actorId) ?? NO_GRANTS, { ...NO_GRANTS, ...g }));
  /** A `permissions.*` key naming `actorId`: unioned in AND recorded as deletable. */
  const add = (actorId: string, g: Partial<Grants>) => {
    fromPermissions.add(actorId);
    union(actorId, g);
  };
  const p = permissions ?? {};

  for (const id of p.admins ?? []) add(id, ALL_GRANTS);
  const operatorActions = new Set(vocabulary.commandGroups.flatMap((g) => [`${g}:read`, `${g}:write`]));
  for (const id of p.operators ?? []) add(id, { actions: operatorActions, channels: "all" });
  for (const id of p.repoManagement ?? []) add(id, { actions: new Set(["repo:write", "friction:write"]) });
  for (const id of p.channelConfig ?? []) add(id, { actions: new Set(["config:write"]) });

  const restricted = p.agents ?? {};
  for (const [agent, users] of Object.entries(restricted)) {
    for (const id of users) add(id, { actions: new Set([agentRunAction(agent)]) });
  }
  // `config:write` is open-when-absent only for a legacy block that omits the
  // key; with no `permissions` block there is no legacy rule to apply (R7).
  const channelConfigOpen = permissions !== undefined && p.channelConfig === undefined;
  const everyone: Grants = {
    ...NO_GRANTS,
    actions: new Set([...CHAT_OPEN_ACTIONS, ...(channelConfigOpen ? ["config:write"] : []), ...vocabulary.agentNames.filter((a) => restricted[a] === undefined).map(agentRunAction)]),
  };

  const reposOpen = p.repos === undefined;
  if (reposOpen) {
    for (const id of restricted.coding ?? []) add(id, { repos: "all" });
  } else {
    for (const [slug, users] of Object.entries(p.repos ?? {})) {
      for (const id of users) add(id, { repos: new Set([slug]) });
    }
  }

  for (const entry of Object.values(ingressTokens ?? {})) {
    for (const ns of ["http", "mcp"] as const) {
      union(`${ns}:${entry.subject}`, { actions: new Set(entry.scopes), channels: new Set(entry.channel === undefined ? [] : [`${ns}:${entry.channel}`]) });
    }
  }

  for (const [commonName, scopes] of Object.entries(accessServiceTokens ?? {})) {
    // A malformed list is no scopes, never a widened one (the same tolerance
    // `validateConfig` shows the key).
    if (!Array.isArray(scopes)) continue;
    add(`access:svc:${commonName}`, { actions: new Set(scopes.filter((s): s is string => typeof s === "string")), channels: "all" });
  }

  return { grants: table, everyone, reposOpen, fromPermissions };
}

function unionSet(a: GrantSet, b: GrantSet): GrantSet {
  if (a === "all" || b === "all") return "all";
  return new Set([...a, ...b]);
}

function unionGrants(a: Grants, b: Grants): Grants {
  return { actions: unionSet(a.actions, b.actions), channels: unionSet(a.channels, b.channels), repos: unionSet(a.repos, b.repos) };
}

function isEmpty(g: Grants): boolean {
  return g.actions !== "all" && g.actions.size === 0 && g.channels !== "all" && g.channels.size === 0 && g.repos !== "all" && g.repos.size === 0;
}

// ---- merging + lookup -------------------------------------------------------------

export interface MergedGrants {
  grants: Map<string, Grants>;
  /** Actor ids named by BOTH shapes — the native entry won; config should warn. */
  overlapping: string[];
}

/** Native wins for an id present in both; every other id is carried as is. */
export function mergeGrants(native: ReadonlyMap<string, Grants>, legacy: ReadonlyMap<string, Grants>): MergedGrants {
  const grants = new Map<string, Grants>(legacy);
  const overlapping: string[] = [];
  for (const [id, g] of native) {
    if (legacy.has(id)) overlapping.push(id);
    grants.set(id, g);
  }
  return { grants, overlapping };
}

/** Everything grants can come from. Every field optional: a deployment may
 *  have only one shape, or neither (then every actor is `NO_GRANTS`). */
export interface GrantsSource {
  /** The native block, already parsed (`parseGrantsConfig`). */
  grants?: ReadonlyMap<string, Grants>;
  permissions?: Permissions;
  /** `SWITCHBOARD_INGRESS_TOKENS`, parsed (`parseIngressTokenMap`). */
  ingressTokens?: IngressTokenMap;
  /** The registered agents; absent = none (no agent is open to everyone). */
  agentNames?: readonly string[];
  /** The registered command groups; absent = none (operators translate to no actions). */
  commandGroups?: readonly string[];
  /** The schedule registry's declared actors (`RunAction.actor`, R9): each
   *  schedule's grants as the registry states them. The floor for a
   *  `schedule:<name>` id — a native `grants` entry for the same id replaces
   *  them (config decides), and the legacy keys never name a schedule. */
  schedules?: readonly { readonly id: string; readonly grants: Grants }[];
}

export type GrantsTable = Pick<MergedGrants, "grants"> &
  Pick<LegacyTranslation, "everyone" | "reposOpen"> & {
    /** Ids a `permissions.*` key AND the native block both name — the native
     *  entry won and the legacy one is deletable, so `ConfigStore` warns. An
     *  ingress token's `http:`/`mcp:` id with a native entry beside it is not
     *  here (`LegacyTranslation.fromPermissions`): that pairing is the intended
     *  way to grant a token channels, not a duplicate. */
    overlapping: string[];
    /** What every Access browser session holds under the legacy rules: each registered group's read. */
    browserReads: Grants;
  };

/** The legacy baseline an actor id inherits, listed or not: a `slack:` user
 *  holds what `everyone` does (the `open` chat commands, the unrestricted
 *  agents); an Access browser session (`access:<sub>`, never `access:svc:`)
 *  holds every `<group>:read`. Every other namespace (`schedule:`,
 *  `access:svc:`, `http:`, `mcp:`) is a credential or a job that holds exactly
 *  what names it — an unlisted one is `NO_GRANTS` (R7). */
export function legacyBaseline(actorId: string, table: Pick<GrantsTable, "everyone" | "browserReads">): Grants {
  if (actorId.startsWith("slack:")) return table.everyone;
  if (actorId.startsWith("access:") && !actorId.startsWith("access:svc:")) return table.browserReads;
  return NO_GRANTS;
}

/** The whole merged table plus the legacy baselines — what `ConfigStore`
 *  builds once at load (and warns from). A legacy entry already includes its
 *  baseline; a native entry is exactly what it declares (R7). A schedule's
 *  registry-declared grants are its floor: a legacy key that names the
 *  schedule ADDS to them like every legacy key adds, and a native entry for the
 *  same `schedule:<name>` replaces them whole, without an overlap warning (the
 *  registry is a default, not a second config shape). */
export function grantsTable(source: GrantsSource): GrantsTable {
  const { serviceTokens, ...permissions } = source.permissions ?? {};
  const legacy = translateLegacyConfig(source.permissions ? permissions : undefined, source.ingressTokens, serviceTokens, { agentNames: source.agentNames ?? [], commandGroups: source.commandGroups ?? [] });
  const baselines = { everyone: legacy.everyone, browserReads: { ...NO_GRANTS, actions: browserReadActions(source.commandGroups ?? []) } };
  const withBaseline = new Map([...legacy.grants].map(([id, g]) => [id, unionGrants(g, legacyBaseline(id, baselines))] as const));
  const merged = mergeGrants(source.grants ?? new Map(), withBaseline);
  for (const schedule of source.schedules ?? []) {
    if (source.grants?.has(schedule.id)) continue;
    merged.grants.set(schedule.id, unionGrants(merged.grants.get(schedule.id) ?? NO_GRANTS, schedule.grants));
  }
  return { grants: merged.grants, overlapping: merged.overlapping.filter((id) => legacy.fromPermissions.has(id)), ...baselines, reposOpen: legacy.reposOpen };
}

/** One actor's grants from a built table: its entry; else the legacy baseline
 *  its namespace inherits (`legacyBaseline`); else `NO_GRANTS` (R7). */
export function grantsIn(table: GrantsTable, actorId: string): Grants {
  const listed = table.grants.get(actorId);
  if (listed) return listed;
  const baseline = legacyBaseline(actorId, table);
  return isEmpty(baseline) ? NO_GRANTS : baseline;
}

/** `grantsIn` over a table built on the spot — for callers without a `ConfigStore`. */
export function grantsFor(actorId: string, source: GrantsSource): Grants {
  return grantsIn(grantsTable(source), actorId);
}
