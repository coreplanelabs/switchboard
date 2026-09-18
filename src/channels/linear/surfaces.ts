import { object, required, string } from "./api.js";
import { linearTeamAllows, type LinearAccessDeps, type LinearPerson } from "./access.js";

export interface LinearSurface {
  kind: "project" | "document";
  id: string;
  title: string;
  content?: string;
  url?: string;
}

const projectFields = "id name content url";
/** Only comment ownership establishes an origin. Session context can contain
 * arbitrary references and is deliberately not used as an access boundary. */
export const SURFACE_CONTEXT_FIELDS = `
  isArtificialAgentSessionRoot
  project { ${projectFields} }
  projectUpdate { project { ${projectFields} } }
  documentContent { document { id title content url } project { ${projectFields} } }
`;
const teamFields = "id visibility restrictedBy { id }";
export const SURFACE_ACCESS_FIELDS = `
  isArtificialAgentSessionRoot
  project { id }
  projectUpdate { project { id } }
  documentContent { document { id project { id } issue { team { ${teamFields} } } team { ${teamFields} } } project { id } }
`;

export function linearSurfaceOrigin(
  session: Record<string, unknown>,
): { kind: LinearSurface["kind"]; entity: Record<string, unknown> } | undefined {
  if (session.issue || session.pullRequest) return undefined;
  const primary = object(session.comment);
  // A real primary comment with an unknown parent must not borrow access from
  // a source in some other conversation. Only an artificial root can fall back.
  const origins =
    !session.comment || primary.isArtificialAgentSessionRoot === true
      ? [session.comment, session.sourceComment]
      : [session.comment];
  for (const value of origins) {
    const comment = object(value),
      content = object(comment.documentContent);
    if (content.document) return { kind: "document", entity: object(content.document) };
    const project = comment.project ?? object(comment.projectUpdate).project ?? content.project;
    if (project) return { kind: "project", entity: object(project) };
  }
  return undefined;
}

/** A source comment can come from another conversation. Include its text only
 * when its own fresh origin is the one whose access this session checks. */
export function linearSurfaceSourceText(session: Record<string, unknown>): string | undefined {
  const origin = linearSurfaceOrigin(session);
  const source = linearSurfaceOrigin({ sourceComment: session.sourceComment });
  return origin &&
    source &&
    origin.kind === source.kind &&
    string(origin.entity.id) &&
    origin.entity.id === source.entity.id
    ? string(object(session.sourceComment).body)
    : undefined;
}

export function linearSurfaceContext(session: Record<string, unknown>): LinearSurface | undefined {
  const origin = linearSurfaceOrigin(session);
  if (!origin) return undefined;
  const { kind, entity } = origin;
  return {
    kind,
    id: required(entity.id),
    // Linear permits an empty document title.
    title:
      string(kind === "document" ? entity.title : entity.name) ??
      (kind === "document" ? "Untitled document" : "Untitled project"),
    ...(string(entity.content) ? { content: string(entity.content) } : {}),
    ...(string(entity.url) ? { url: string(entity.url) } : {}),
  };
}

/** Projects inherit visibility from any of their teams. Documents inherit the
 * visibility of their owner; an unsupported owner never implies public access. */
export async function linearSurfaceAllows(
  deps: LinearAccessDeps,
  person: LinearPerson,
  session: Record<string, unknown>,
): Promise<boolean> {
  const origin = linearSurfaceOrigin(session);
  if (!origin) return false;
  let project: Record<string, unknown>;
  if (origin.kind === "document") {
    const document = origin.entity;
    const team = object(object(document.issue).team ?? document.team);
    if (string(team.id)) return linearTeamAllows(person, "conversation:read", team);
    project = object(document.project);
  } else project = origin.entity;
  if (!string(project.id)) return false;
  let after: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page === 100) throw new Error("linear_project_access_too_large");
    const data = await deps.query(
      `query SwitchboardProjectAccess($id: String!, $after: String) {
      organization { id }
      project(id: $id) { id teams(first: 100, after: $after) {
        nodes { ${teamFields} } pageInfo { hasNextPage endCursor }
      } }
    }`,
      { id: project.id, after },
    );
    const current = object(data.project),
      teams = object(current.teams),
      info = object(teams.pageInfo);
    if (object(data.organization).id !== deps.organizationId || current.id !== project.id) return false;
    if (!Array.isArray(teams.nodes)) throw new Error("linear_invalid_response");
    if (teams.nodes.some((team) => linearTeamAllows(person, "conversation:read", object(team)))) return true;
    if (info.hasNextPage === false) return false;
    after = required(info.endCursor);
    if (seen.has(after)) throw new Error("linear_invalid_pagination");
    seen.add(after);
  }
}
