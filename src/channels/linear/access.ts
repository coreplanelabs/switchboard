import { authorize } from "../../core/authz/authorize.js";
import type { Actor } from "../../core/authz/types.js";
import { object, required } from "./api.js";

export interface LinearPersonIdentity {
  id: string;
  actions: "all" | readonly string[];
}
export interface LinearAccessDeps {
  organizationId: string;
  appUserId: string;
  query(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export interface LinearPerson {
  actor: Actor;
  prefix: string;
  members: Set<string>;
  publicAccess: boolean;
}

/** Current platform facts cap config grants; neither names nor issue text establish membership. */
export async function linearPerson(deps: LinearAccessDeps, identity: LinearPersonIdentity): Promise<LinearPerson> {
  const prefix = `linear:${deps.organizationId}:`;
  const userId =
    typeof identity.id === "string" && identity.id.startsWith(prefix) ? identity.id.slice(prefix.length) : "";
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(userId) ||
    userId === deps.appUserId ||
    !(
      identity.actions === "all" ||
      (Array.isArray(identity.actions) && identity.actions.every((a) => typeof a === "string"))
    )
  )
    throw new Error("linear_human_required");
  const members = new Set<string>();
  let after: string | undefined;
  let publicAccess: boolean;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page === 100) throw new Error("linear_membership_too_large");
    const data = await deps.query(
      `query SwitchboardPerson($id: String!, $after: String) {
      user(id: $id) { id active app canAccessAnyPublicTeam organization { id }
        teams(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }
    }`,
      { id: userId, after },
    );
    const user = object(data.user),
      connection = object(user.teams),
      info = object(connection.pageInfo);
    if (
      user.id !== userId ||
      user.active !== true ||
      user.app !== false ||
      object(user.organization).id !== deps.organizationId
    )
      throw new Error("linear_human_required");
    publicAccess = user.canAccessAnyPublicTeam === true;
    if (!Array.isArray(connection.nodes)) throw new Error("linear_invalid_response");
    for (const team of connection.nodes) members.add(required(object(team).id));
    if (info.hasNextPage === false) break;
    after = required(info.endCursor);
    if (seen.has(after)) throw new Error("linear_invalid_pagination");
    seen.add(after);
  }
  const actor: Actor = {
    kind: "user",
    id: identity.id,
    grants: {
      actions: identity.actions === "all" ? "all" : new Set(identity.actions),
      channels: new Set(),
      repos: new Set(),
    },
    memberOf: new Set([...members].map((id) => `${prefix}${id}`)),
  };
  return { actor, prefix, members, publicAccess };
}

export function linearTeamAllows(person: LinearPerson, action: string, team: Record<string, unknown>): boolean {
  const { actor, prefix, members, publicAccess } = person;
  // Restricted children inherit their enclosing private team's membership;
  // an unrelated parent never opens a private child.
  const memberOf = new Set(actor.memberOf);
  if (team.visibility === "restricted" && members.has(String(object(team.restrictedBy).id)))
    memberOf.add(`${prefix}${required(team.id)}`);
  return authorize({ ...actor, memberOf }, action, {
    type: "channel",
    id: `${prefix}${required(team.id)}`,
    visibility: publicAccess && team.visibility === "public" ? "public" : "private",
  }).allow;
}
