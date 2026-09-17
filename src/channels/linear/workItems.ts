import type { WorkItem, WorkItemRequest, WorkItemResult } from "../../core/workItems.js";
import { object, required, string } from "./api.js";
import { linearPerson, linearTeamAllows, type LinearAccessDeps, type LinearPersonIdentity } from "./access.js";

/** Transport identity comes from the dispatcher, never from a tool argument.
 * Config grants admit actions; team facts below cap access at the person's
 * current Linear access, even when config grants every channel. */
export type LinearWorkItemActor = LinearPersonIdentity;
type Deps = LinearAccessDeps;

const FIELDS = `id identifier title description url priority
  state { id name type } team { id visibility restrictedBy { id } }
  assignee { id name } delegate { id name }`;

function item(row: Record<string, unknown>): WorkItem {
  const state = object(row.state);
  const states = object(object(row.team).states).nodes;
  if (typeof row.priority !== "number") throw new Error("linear_invalid_response");
  const person = (value: unknown) => {
    const user = object(value);
    return user.id ? { id: required(user.id), name: required(user.name) } : undefined;
  };
  return {
    id: required(row.id),
    identifier: required(row.identifier),
    title: required(row.title),
    description: string(row.description),
    url: required(row.url),
    priority: row.priority,
    state: { id: required(state.id), name: required(state.name), type: required(state.type) },
    ...(Array.isArray(states)
      ? {
          availableStates: states.map((s) => {
            const value = object(s);
            return { id: required(value.id), name: required(value.name), type: required(value.type) };
          }),
        }
      : {}),
    teamId: required(object(row.team).id),
    assignee: person(row.assignee),
    delegate: person(row.delegate),
  };
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max)
    throw new Error("linear_invalid_work_item_input");
  return value;
}

export async function linearWorkItems(
  deps: Deps,
  identity: LinearWorkItemActor,
  request: WorkItemRequest,
): Promise<WorkItemResult> {
  if (!["get", "delegated", "update", "create_child", "comment"].includes(request.op))
    throw new Error("linear_invalid_work_item_input");
  const person = await linearPerson(deps, identity);
  const { members, publicAccess } = person;
  const action = request.op === "get" || request.op === "delegated" ? "work-items:read" : "work-items:write";
  const allowed = (row: Record<string, unknown>) => linearTeamAllows(person, action, object(row.team));
  if (request.op === "delegated") {
    const first = request.limit ?? 25;
    if (!Number.isInteger(first) || first < 1 || first > 50) throw new Error("linear_invalid_work_item_input");
    const teams: Record<string, unknown>[] = [
      { id: { in: [...members] } },
      { and: [{ visibility: { eq: "restricted" } }, { restrictedBy: { id: { in: [...members] } } }] },
    ];
    if (publicAccess) teams.push({ visibility: { eq: "public" } });
    const data = await deps.query(
      `query SwitchboardDelegated($first: Int!, $after: String, $filter: IssueFilter!) {
      issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
        nodes { ${FIELDS} } pageInfo { hasNextPage endCursor }
      }
    }`,
      {
        first,
        after: request.after === undefined ? undefined : text(request.after, 512),
        filter: {
          delegate: { id: { eq: deps.appUserId } },
          team: { or: teams },
        },
      },
    );
    const connection = object(data.issues),
      info = object(connection.pageInfo);
    if (!Array.isArray(connection.nodes)) throw new Error("linear_invalid_response");
    return {
      items: connection.nodes
        .map(object)
        .filter((row) => object(row.delegate).id === deps.appUserId && allowed(row))
        .map(item),
      ...(info.hasNextPage === true ? { nextCursor: required(info.endCursor) } : {}),
    };
  }
  const id = text(request.op === "create_child" ? request.parentId : request.id, 256);
  const data = await deps.query(
    `query SwitchboardWorkItem($id: String!) {
    issue(id: $id) { ${FIELDS} team { id visibility states(first: 100) { nodes { id name type } } } }
  }`,
    { id },
  );
  const row = object(data.issue);
  if (!allowed(row)) throw new Error("linear_work_item_denied");
  if (request.op === "get") return item(row);
  if (request.op === "comment") {
    const data = await deps.query(
      `mutation SwitchboardWorkItemComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { url } }
    }`,
      { input: { issueId: required(row.id), body: text(request.body, 50_000) } },
    );
    const result = object(data.commentCreate);
    if (result.success !== true) throw new Error("linear_work_item_write_failed");
    return { url: required(object(result.comment).url) };
  }
  const input: Record<string, unknown> = {};
  if (request.title !== undefined) input.title = text(request.title, 500);
  if (request.description !== undefined) input.description = text(request.description, 100_000, true);
  if (request.op === "create_child") {
    input.title = text(request.title, 500);
    input.teamId = required(object(row.team).id);
    input.parentId = required(row.id);
  } else {
    if (request.priority !== undefined) {
      if (!Number.isInteger(request.priority) || request.priority < 0 || request.priority > 4)
        throw new Error("linear_invalid_work_item_input");
      input.priority = request.priority;
    }
    if (request.state !== undefined) {
      const wanted = text(request.state, 256).toLowerCase();
      const states = object(object(row.team).states).nodes;
      if (!Array.isArray(states)) throw new Error("linear_invalid_response");
      const matches = states
        .map(object)
        .filter((s) => s.id === request.state || required(s.name).toLowerCase() === wanted);
      if (matches.length !== 1) throw new Error("linear_unknown_or_ambiguous_state");
      input.stateId = required(matches[0]!.id);
    }
    if (Object.keys(input).length === 0) throw new Error("linear_empty_work_item_update");
  }
  const create = request.op === "create_child";
  const result = await deps.query(
    create
      ? `mutation SwitchboardChild($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${FIELDS} } } }`
      : `mutation SwitchboardWorkItemUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${FIELDS} } } }`,
    create ? { input } : { id: required(row.id), input },
  );
  const payload = object(result[create ? "issueCreate" : "issueUpdate"]);
  if (payload.success !== true) throw new Error("linear_work_item_write_failed");
  return item(object(payload.issue));
}
