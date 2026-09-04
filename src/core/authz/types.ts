// One authorization model — the shared contract (plan
// docs/plans/2026-09-03-001-feat-authorization-model-plan.md, U0).
//
// Every surface resolves WHO is asking into an `Actor`; every command names
// WHAT it does as an `Action`; every thing acted on is a typed `Resource`.
// `authorize(actor, action, resource)` (U1) is the only decision; the same
// policy rules compile into store predicates for list-shaped reads (KTD2).
// This file is types only — no logic, no I/O, node-free (importable by the
// state Worker like `runRecord.ts`).

/** Who is asking. `agent` acts on behalf of a principal and never exceeds it (R2). */
export type ActorKind = "user" | "service" | "schedule" | "agent";

/** A set of names, or everything. `"all"` is explicit, never a default. */
export type GrantSet = ReadonlySet<string> | "all";

/** What an actor may do (R8). One shape for humans (`permissions.*`), ingress
 *  tokens, Access identities, schedule actors, and agents. */
export interface Grants {
  /** Action ids: `runs:read`, `friction:write`, `repo:exec`, `agent:run:<name>`, `memory:write`, … */
  readonly actions: GrantSet;
  /** Platform-namespaced channel ids the actor is a member of (`slack:C…`, `http:ops`), or every channel. */
  readonly channels: GrantSet;
  /** `owner/name` repos the actor may use, or every repo (open-when-absent today → `"all"`). */
  readonly repos: GrantSet;
}
// Which agents an actor may run is NOT a separate axis: it is the action
// `agent:run:<name>` (or `agent:run:*`) in `actions`, so `has-grant` covers it
// and the condition vocabulary stays closed.

/** The empty grant. `Object.freeze` is shallow and a frozen `Set` still
 *  accepts `add`, so the inner sets are protected by the `ReadonlySet` type
 *  alone — never hand this object to code that takes a mutable `Set`. */
export const NO_GRANTS: Grants = Object.freeze({
  actions: new Set<string>(),
  channels: new Set<string>(),
  repos: new Set<string>(),
});

export interface Actor {
  readonly kind: ActorKind;
  /** Platform-namespaced (invariant 4): `slack:U…`, `http:<subject>`, `mcp:<subject>`,
   *  `access:<sub>`, `access:svc:<common_name>`, `cli:local`, `schedule:<name>`, `agent:<name>`. */
  readonly id: string;
  readonly grants: Grants;
  /** For `agent` actors: the principal the run acts for. Effective grants are the intersection. */
  readonly onBehalfOf?: Actor;
  /** Where a chat actor is speaking from — context, never authority (KTD3). */
  readonly origin?: { readonly channelId: string; readonly threadKey: string };
}

/** `<group>:<read|write|exec>` plus the non-command actions (R3). A plain
 *  string on purpose: command ids are derived from the registry at runtime, so
 *  the closed set lives in the policy table, which validates every action it
 *  names against the registry at module load (U1) rather than in the type. */
export type Action = string;

/** How a channel's content may travel (R4, KTD7). `machine` = `http:*` / `mcp:*`. */
export type ChannelVisibility = "public" | "private" | "dm" | "machine" | "unknown";

export type Resource =
  | { readonly type: "run"; readonly id: string; readonly channelId: string; readonly userId: string; readonly repo?: string; readonly channelVisibility?: ChannelVisibility }
  | { readonly type: "channel"; readonly id: string; readonly visibility: ChannelVisibility }
  | { readonly type: "memory-scope"; readonly key: string; readonly kind: "org" | "user" | "repo" | "channel"; readonly originChannelVisibility?: ChannelVisibility }
  | { readonly type: "repo"; readonly owner: string; readonly name: string }
  | { readonly type: "config-scope"; readonly kind: "channel" | "user"; readonly id: string }
  | { readonly type: "agent"; readonly name: string }
  /** List-shaped actions with no single resource (`runs.list`, `friction.report`). */
  | { readonly type: "command"; readonly id: string };

export type ResourceType = Resource["type"];

/** The CLOSED condition vocabulary (KTD1). Every condition is both evaluable
 *  against one resource and compilable to a store predicate. Adding a member
 *  is a plan-level decision, never a local convenience. */
export type Condition =
  | { readonly kind: "has-grant"; readonly grant: string }
  /** actor.grants.channels contains resource.channelId (or is "all"), OR the
   *  resource's channel is `public` (a run's stamped `channelVisibility`, KTD7;
   *  `unknown` is never public). One definition for both evaluators (U3). */
  | { readonly kind: "member-of" }
  /** resource.userId === actor.id (or the on-behalf-of principal's id). */
  | { readonly kind: "is-self" }
  /** actor.grants.repos contains the resource's repo (or is "all"). */
  | { readonly kind: "owner-of" }
  /** actor.grants.channels === "all". */
  | { readonly kind: "all-channels" };

/** The `kind` discriminator of a kinded resource type (`memory-scope`,
 *  `config-scope`); `never` for the others, so a row cannot carry a kind its
 *  resource does not have. */
export type KindOf<T extends ResourceType> = Extract<Resource, { readonly type: T }> extends { readonly kind: infer K } ? K : never;

/** Every kind any kinded resource has (distributed per type — a conditional over the whole union would be `never`). */
export type ResourceKind = { [T in ResourceType]: KindOf<T> }[ResourceType];

/** `resourceKind` is REQUIRED for a kinded resource type and FORBIDDEN for the
 *  others — enforced by the type, not by a comment. */
type KindField<T extends ResourceType> = [KindOf<T>] extends [never]
  ? { readonly resourceKind?: never }
  : { readonly resourceKind: KindOf<T> };

/** One policy row: `when` conditions are ANDed; rows for the same
 *  (action, resource type[/kind]) are ORed. No row → deny (R7).
 *  `actorKinds`, `resourceKind`, and `originVisibility` SELECT which rows
 *  apply; `when` decides. Selectors read one side only (the actor's kind or a
 *  resource attribute); conditions relate the two — so selectors never widen
 *  the closed condition vocabulary. */
export type RuleFor<T extends ResourceType> = {
  readonly action: Action;
  readonly resource: T;
  /** Restrict the row to these actor kinds; absent = any kind. */
  readonly actorKinds?: readonly ActorKind[];
  /** Restrict the row to resources whose origin channel has one of these
   *  visibilities (R11: an `org` memory write from a `private`/`dm`/`unknown`
   *  origin has no row). A row carrying it is point-check only — `predicateFor`
   *  compiles it to `none`, since a store predicate cannot see the origin. */
  readonly originVisibility?: readonly ChannelVisibility[];
  readonly when: readonly Condition[];
} & KindField<T>;

/** A row for any resource type — distributed, so the kind stays tied to the type. */
export type Rule = { [T in ResourceType]: RuleFor<T> }[ResourceType];

export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/** What a list-shaped read may return, derived from the rules (KTD2).
 *  Stores translate it to their own filter; handlers never see it. */
export type Predicate =
  | { readonly kind: "none" } // nothing is visible
  | { readonly kind: "all" }
  | { readonly kind: "channels-in"; readonly channelIds: ReadonlySet<string> }
  | { readonly kind: "user-is"; readonly userId: string }
  | { readonly kind: "repos-in"; readonly repos: ReadonlySet<string> }
  /** The record's stamped `channelVisibility` is one of these (`member-of`'s
   *  public half, U3). A record without the stamp is `unknown` and never matches
   *  `visibility-in(["public"])`. */
  | { readonly kind: "visibility-in"; readonly visibilities: ReadonlySet<ChannelVisibility> }
  /** Rows for one (action, resource type) OR together. */
  | { readonly kind: "or"; readonly of: readonly Predicate[] }
  /** The compilable conditions of ONE row AND together (e.g. member-of ∧ is-self). */
  | { readonly kind: "and"; readonly of: readonly Predicate[] };

/** Adapter-supplied channel facts (KTD4). `unknown` is never a member (R7). */
export interface ChannelDirectory {
  info(channelId: string): Promise<{ visibility: ChannelVisibility }>;
  isMember(actorId: string, channelId: string): Promise<boolean | "unknown">;
}
