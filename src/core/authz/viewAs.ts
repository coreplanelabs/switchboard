import type { Actor } from "./types.js";

// Viewing as a person (docs/decisions/0053-viewing-as-a-person-borrows-their-ceiling-and-keeps-your-name-on-the-line.md):
// the two facts every surface agrees on — who may view as someone, and the one
// sentence a write gets while viewing. The actor shape itself is `Actor.viewingAs`
// beside `onBehalfOf` (types.ts); the resolver that builds it is
// src/channels/commandHttp.ts, the door that reads it src/core/commandRegistry.ts.

/** Whether a session may view as another person: it holds `all` on every axis of its OWN
 *  grants (the admin's, never the effective ones — an admin already viewing still holds them). */
export function holdsAll(actor: Actor): boolean {
  return actor.grants.actions === "all" && actor.grants.channels === "all" && actor.grants.repos === "all";
}

/** A person a session may view as: a Slack person id, the one kind the directory knows. */
export function isViewablePerson(id: string): boolean {
  return /^slack:U[A-Z0-9]+$/.test(id);
}

/** The one sentence a write gets while viewing as a person — the registry door's refusal, the
 *  stop route's, the chat's; the banner and every disabled control show the same words. */
export function viewingRefusal(person: { id: string; name?: string }): string {
  return `You are viewing as ${person.name ?? person.id}; writes are your own to make — exit view-as to write.`;
}
