import { ALL_GRANTS } from "./grants.js";
import type { Actor, Grants } from "./types.js";

// Actor resolution — adapters resolve identity, never authority: each adapter
// proves WHO is asking (a Slack user id, an ingress token's subject, an Access
// `sub` or service token `common_name`, the local CLI, a schedule registry
// entry) and hands it here; this module gives it a kind, its
// platform-namespaced id (invariant 4) and its grants — looked up by id through
// the one `GrantsLookup` config owns. No decision lives here: nothing below
// says what an actor MAY do.

/** What an adapter can prove about a caller's surface. */
export type ActorSurface = "slack" | "http" | "mcp" | "access-browser" | "access-service" | "cli" | "schedule";

export interface ActorInput {
  surface: ActorSurface;
  /** The bare subject the surface authenticated: `U…` for Slack, the token's
   *  `subject`, the Access `sub` / `common_name`, the schedule's `name`. */
  subjectId: string;
  /** Where a chat actor is speaking from; both or neither (context, never authority). */
  channelId?: string;
  threadKey?: string;
}

/** `ConfigStore.grantsFor` — or `grantsFor(id, source)` for callers without a store. */
export type GrantsLookup = (actorId: string) => Grants;

/** The local CLI: one operator at a keyboard, every grant, no config consulted. */
export const CLI_ACTOR: Actor = Object.freeze({ kind: "user", id: "cli:local", grants: ALL_GRANTS });

/** The one id form per surface. */
export function actorIdFor(surface: ActorSurface, subjectId: string): string {
  switch (surface) {
    case "slack":
      return `slack:${subjectId}`;
    case "http":
      return `http:${subjectId}`;
    case "mcp":
      return `mcp:${subjectId}`;
    case "access-browser":
      return `access:${subjectId}`;
    case "access-service":
      return `access:svc:${subjectId}`;
    case "cli":
      return CLI_ACTOR.id;
    case "schedule":
      return `schedule:${subjectId}`;
  }
}

function kindFor(surface: ActorSurface): Actor["kind"] {
  switch (surface) {
    case "slack":
    case "access-browser":
    case "cli":
      return "user";
    case "http":
    case "mcp":
    case "access-service":
      return "service";
    case "schedule":
      return "schedule";
  }
}

/** The `Actor` for what an adapter proved: kind from the surface, namespaced
 *  id, grants from config by that id (the CLI always holds everything), and
 *  `origin` when the input names both a channel and a thread. */
export function resolveActor(input: ActorInput, grantsFor: GrantsLookup): Actor {
  if (input.surface === "cli") return CLI_ACTOR;
  const id = actorIdFor(input.surface, input.subjectId);
  const origin =
    input.channelId !== undefined && input.threadKey !== undefined
      ? { channelId: input.channelId, threadKey: input.threadKey }
      : undefined;
  return { kind: kindFor(input.surface), id, grants: grantsFor(id), ...(origin ? { origin } : {}) };
}

/** The identity fields a bound credential's message carries (`IncomingMessage`). */
interface BoundFields {
  /** The credential's actor id when the sender is the person it is bound to. */
  authenticatedAs?: string;
  userName?: string;
}

/** The actor id whose grants govern a chat message: the credential that
 *  authenticated it when it was bound to a person (`authenticatedAs`), else
 *  the sender. Every `canRunAgent` / `canUseRepo` / `canManageRepos` /
 *  `canEditChannelConfig` question in the dispatch path asks about THIS id,
 *  never `msg.userId`: naming the person on a run must not lend the run the
 *  person's grants (authorization.md item 15). A relayed message (`postedBy`)
 *  is out of scope here — its gates are item 14's. */
export function grantsSubject(msg: { userId: string; authenticatedAs?: string }): string {
  return msg.authenticatedAs ?? msg.userId;
}

const CHAT_SURFACES: Readonly<Record<string, ActorSurface>> = {
  slack: "slack",
  http: "http",
  mcp: "mcp",
  cli: "cli",
  schedule: "schedule",
};

/** A chat message's `userId` is already namespaced by its adapter (`slack:U…`,
 *  `http:<subject>`, `mcp:<subject>`, `cli:local`, `schedule:<name>`): the prefix picks the surface.
 *  A namespace this module does not know stays a `user` with the id as given —
 *  its grants are whatever config names for that id, never a guess. */
export function resolveChatActor(
  msg: { userId: string; channelId: string; threadKey: string; postedBy?: string } & BoundFields,
  grantsFor: GrantsLookup,
): Actor {
  const person = resolveNamespacedActor(msg.userId, msg, grantsFor);
  if (msg.postedBy === undefined) {
    if (msg.authenticatedAs === undefined || msg.authenticatedAs === msg.userId) return person;
    // A credential bound to a person (authorization.md item 15): the adapter
    // proved the credential and config bound it to the person, so the actor IS
    // the credential — its kind, its id, its grants, exactly as an unbound
    // token's — and the person is its `self` and `asUser`, the same
    // identity-not-authority link a dashboard session carries (record 0042).
    const credential = resolveNamespacedActor(msg.authenticatedAs, msg, grantsFor);
    return {
      ...credential,
      self: [credential.id, msg.userId],
      asUser: { id: msg.userId, ...(msg.userName !== undefined ? { name: msg.userName } : {}) },
    };
  }
  // A request an app posted for a person (slack-channel.md item 13): the
  // message text named the person, and text is forgeable, so the person's
  // grants alone must never govern. The actor is the app, acting on the
  // person's behalf — `effectiveGrants` is the intersection, so the run holds
  // no more than the app holds (the surface baseline, plus whatever config
  // grants that app id by name) and no more than the person holds. Identity
  // (`userId`, the record, the costs page) is still the person's.
  const app = resolveNamespacedActor(msg.postedBy, msg, grantsFor);
  return { ...app, kind: "agent", onBehalfOf: person };
}

function resolveNamespacedActor(
  userId: string,
  origin: { channelId: string; threadKey: string },
  grantsFor: GrantsLookup,
): Actor {
  const colon = userId.indexOf(":");
  const surface = colon > 0 ? CHAT_SURFACES[userId.slice(0, colon)] : undefined;
  const at = { channelId: origin.channelId, threadKey: origin.threadKey };
  if (surface === undefined) return { kind: "user", id: userId, grants: grantsFor(userId), origin: at };
  return resolveActor({ surface, subjectId: userId.slice(colon + 1), ...at }, grantsFor);
}
