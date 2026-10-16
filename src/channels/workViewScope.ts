import { authorize } from "../core/authz/authorize.js";
import { allOf } from "../core/authz/predicate.js";
import type { Actor, Predicate } from "../core/authz/types.js";

export const DATA_VIEW_COOKIE = "sb-data-view";
export const DATA_VIEW_PATH = "/runs/data-view";
export interface WorkViewScope {
  mode: "mine" | "person" | "everyone";
  ownerIds: readonly string[];
  person?: { id: string; name?: string };
  canEveryone: boolean;
}
const scopes = new WeakMap<Actor, WorkViewScope>();
/** The host supplies current proved owner identities. They narrow discovery;
 * they never enter Actor.self, grant arithmetic, or execution attribution. */
export function resolveWorkViewScope(
  actor: Actor,
  options: {
    organization: string;
    originalActor?: Actor;
    mode?: "mine" | "everyone";
    ownerIds?: readonly string[];
  },
): WorkViewScope {
  const original = options.originalActor ?? actor;
  const canEveryone =
    original.id === actor.id &&
    original.kind === "user" &&
    original.grants.actions === "all" &&
    original.grants.channels === "all" &&
    authorize(original, "organization:read", { type: "organization", id: options.organization }).allow;
  const ownerIds = [...new Set(options.ownerIds ?? [actor.viewingAs?.id ?? actor.id])];
  if (actor.viewingAs) return { mode: "person", ownerIds, person: actor.viewingAs, canEveryone };
  return options.mode === "everyone" && canEveryone
    ? { mode: "everyone", ownerIds: [], canEveryone }
    : { mode: "mine", ownerIds, canEveryone };
}
export function withWorkViewScope(actor: Actor, scope: WorkViewScope): Actor {
  scopes.set(actor, Object.freeze({ ...scope, ownerIds: Object.freeze([...scope.ownerIds]) }));
  return actor;
}
export function hasWorkViewScope(actor: Actor): boolean {
  return scopes.has(actor);
}
export function workViewScopeOf(actor: Actor): WorkViewScope {
  return (
    scopes.get(actor) ?? {
      mode: actor.viewingAs ? "person" : "mine",
      ownerIds: [actor.viewingAs?.id ?? actor.id],
      ...(actor.viewingAs ? { person: actor.viewingAs } : {}),
      canEveryone: false,
    }
  );
}
export function workOwnerPredicate(scope: WorkViewScope): Predicate {
  if (scope.mode === "everyone") return { kind: "all" };
  if (scope.ownerIds.length === 0) return { kind: "none" };
  const predicates: Predicate[] = scope.ownerIds.map((userId) => ({ kind: "user-is", userId }));
  return predicates.length === 1 ? predicates[0]! : { kind: "or", of: predicates };
}
export function workReadPredicate(actor: Actor, readable: Predicate): Predicate {
  return allOf([readable, workOwnerPredicate(workViewScopeOf(actor))]);
}
export function workViewModeFromCookie(header: string | string[] | undefined): "mine" | "everyone" {
  const raw = Array.isArray(header) ? header.join(";") : header;
  for (const piece of (raw ?? "").split(";")) {
    const [name, value] = piece.trim().split("=");
    if (name === DATA_VIEW_COOKIE) return value === "everyone" ? "everyone" : "mine";
  }
  return "mine";
}
