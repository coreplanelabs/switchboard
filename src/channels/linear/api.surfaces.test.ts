import { describe, expect, it, vi } from "vitest";
import { DirectLinearApi } from "./api.js";

function fixture(comment: Record<string, unknown>) {
  const team = { id: "team", visibility: "private", restrictedBy: null as { id: string } | null };
  const user = {
    id: "alice",
    active: true,
    app: false,
    organization: { id: "org" },
    canAccessAnyPublicTeam: false,
    teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false } },
  };
  const session: Record<string, unknown> = {
    id: "s",
    appUser: { id: "bot" },
    creator: { id: "alice" },
    comment,
    issue: null,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SwitchboardPerson")) return Response.json({ data: { user } });
    if (query.includes("SwitchboardProjectAccess"))
      return Response.json({
        data: {
          organization: { id: "org" },
          project: {
            id: "project",
            teams: {
              nodes: variables.after ? [team] : [],
              pageInfo: variables.after ? { hasNextPage: false } : { hasNextPage: true, endCursor: "next" },
            },
          },
        },
      });
    return Response.json({ data: { organization: { id: "org" }, agentSession: session } });
  });
  const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
  return { api, fetch, user, team, session };
}
const project = {
  id: "project",
  name: "Launch",
  content: "Release checklist",
  url: "https://linear.app/acme/project/launch",
};

describe("Linear project and document sessions", () => {
  it("loads project context and rechecks paginated team visibility for the requesting human", async () => {
    const f = fixture({ body: "Review the plan", project });
    expect(await f.api.session("s")).toMatchObject({
      surface: { kind: "project", id: "project", title: "Launch", content: "Release checklist", url: project.url },
    });
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(true);
    f.user.teams.nodes = [];
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
    f.team.visibility = "public";
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
    f.user.canAccessAnyPublicTeam = true;
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(true);
    f.user.active = false;
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
  });
  it.each(["project", "projectUpdate", "sourceComment"])(
    "resolves the current project anchor from %s",
    async (kind) => {
      const f = fixture(
        kind === "projectUpdate"
          ? { projectUpdate: { project } }
          : kind === "project"
            ? { documentContent: { project } }
            : {},
      );
      if (kind === "sourceComment") {
        f.session.comment = { isArtificialAgentSessionRoot: true };
        f.session.sourceComment = { body: "original mention", project };
      }
      expect(await f.api.canRead("s", "linear:org:alice")).toBe(true);
      expect(await f.api.session("s")).toMatchObject({ surface: { kind: "project", id: "project" } });
    },
  );
  it.each(["project", "issue", "team"])("loads a document and checks its current %s access", async (owner) => {
    const f = fixture({});
    const document = {
      id: "doc",
      title: "Design",
      content: "Private notes",
      url: "https://linear.app/acme/document/design",
      [owner]: owner === "project" ? project : owner === "issue" ? { team: f.team } : f.team,
    };
    f.session.comment = { body: "Please review", documentContent: { document } };
    expect(await f.api.session("s")).toMatchObject({
      surface: { kind: "document", id: "doc", title: "Design", content: "Private notes", url: document.url },
    });
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(true);
    f.user.teams.nodes = [];
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
    f.team.visibility = "restricted";
    f.team.restrictedBy = { id: "parent" };
    f.user.teams.nodes = [{ id: "parent" }];
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(true);
  });
  it("reads only files referenced by the current document and its originating comment", async () => {
    const f = fixture({});
    const documentFile = "https://uploads.linear.app/org/design.txt";
    const commentFile = "https://uploads.linear.app/org/source.txt";
    const foreignFile = "https://uploads.linear.app/org/private.txt";
    f.session.comment = {
      documentContent: {
        document: { id: "doc", title: "Design", content: `[design.txt](${documentFile})`, team: f.team },
      },
    };
    f.session.sourceComment = { body: `[source.txt](${commentFile})`, documentContent: { document: { id: "doc" } } };
    const graphql = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      String(url).startsWith("https://uploads.linear.app/")
        ? new Response("notes", { headers: { "content-type": "text/plain" } })
        : graphql(url, init),
    );
    vi.spyOn(f.api, "activities").mockResolvedValue([]);
    const files = await f.api.files("s", "linear:org:alice", [documentFile, commentFile, foreignFile]);
    expect(files[0]).toMatchObject({ document: { data: "notes", name: "design.txt" } });
    expect(files[1]).toMatchObject({ document: { data: "notes", name: "source.txt" } });
    expect(files[2]?.skipped).toContain("current session context");
    f.user.teams.nodes = [];
    f.fetch.mockClear();
    await expect(f.api.files("s", "linear:org:alice", [documentFile])).rejects.toThrow("linear_file_denied");
    expect(f.fetch.mock.calls.some(([url]) => String(url).startsWith("https://uploads.linear.app/"))).toBe(false);
  });
  it("does not borrow a source project's access for an unsupported primary comment", async () => {
    const f = fixture({ id: "private-comment", isArtificialAgentSessionRoot: false, body: "private primary text" });
    f.session.sourceComment = { project, body: "public source" };
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
    expect(await f.api.session("s")).toMatchObject({ unsupportedSurface: true });
  });
  it("does not expose a source comment from a different origin", async () => {
    const f = fixture({ project });
    f.session.sourceComment = { body: "Private source text", project: { id: "other-project" } };
    const session = await f.api.session("s");
    expect(session.surface?.id).toBe("project");
    expect(session.sourceComment).toBeUndefined();
  });
  it("refuses a project from another workspace and retries malformed or cycling pagination", async () => {
    const f = fixture({ project });
    const normal = f.fetch.getMockImplementation()!;
    const answer: Record<string, unknown> = { organization: { id: "other" }, project: { id: "project" } };
    f.fetch.mockImplementation(async (url, init) =>
      JSON.parse(String(init?.body)).query.includes("SwitchboardProjectAccess")
        ? Response.json({ data: answer })
        : normal(url, init),
    );
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
    answer.organization = { id: "org" };
    answer.project = { id: "project", teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "again" } } };
    await expect(f.api.canRead("s", "linear:org:alice")).rejects.toThrow("linear_invalid_pagination");
  });
  it("refuses unknown origins and does not use context references as access to a session", async () => {
    const f = fixture({});
    f.session.context = { projectId: "project" };
    expect(await f.api.canRead("s", "linear:org:alice")).toBe(false);
    expect(await f.api.session("s")).toMatchObject({ unsupportedSurface: true });
  });
});
