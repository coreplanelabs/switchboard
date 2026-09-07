import { ALL_GRANTS } from "./grants.js";
import type { Actor, Grants } from "./types.js";

// Actor resolution (plan U2 — R2, KTD3): each adapter proves WHO is asking
// (a Slack user id, an ingress token's subject, an Access `sub` or service
// token `common_name`, the local CLI, a schedule registry entry) and hands it
// here; this module gives it a kind, its platform-namespaced id (invariant 4)
// and its grants — looked up by id through the one `GrantsLookup` config owns.
// No decision lives here: nothing below says what an actor MAY do.

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
  msg: { userId: string; channelId: string; threadKey: string },
  grantsFor: GrantsLookup,
): Actor {
  const colon = msg.userId.indexOf(":");
  const surface = colon > 0 ? CHAT_SURFACES[msg.userId.slice(0, colon)] : undefined;
  const origin = { channelId: msg.channelId, threadKey: msg.threadKey };
  if (surface === undefined) return { kind: "user", id: msg.userId, grants: grantsFor(msg.userId), origin };
  return resolveActor({ surface, subjectId: msg.userId.slice(colon + 1), ...origin }, grantsFor);
}
