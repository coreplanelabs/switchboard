import { describe, expect, it, vi } from "vitest";
import { linearWorkItems } from "./workItems.js";

const issue = (team = "team", visibility = "private") => ({
  id: "issue",
  identifier: "ENG-1",
  title: "Fix login",
  description: "Context",
  url: "https://linear.app/issue/ENG-1",
  priority: 2,
  state: { id: "todo", name: "Todo", type: "unstarted" },
  team: { id: team, visibility, states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } },
  assignee: { id: "human", name: "Human" },
  delegate: { id: "bot", name: "Switchboard" },
});
function fixture() {
  const person = {
    id: "human",
    active: true,
    app: false,
    canAccessAnyPublicTeam: true,
    organization: { id: "org" },
    teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false } },
  };
  const query = vi.fn(async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (query.includes("SwitchboardPerson")) return { user: person };
    if (query.includes("SwitchboardWorkItemUpdate")) return { issueUpdate: { success: true, issue: issue() } };
    if (query.includes("SwitchboardChild"))
      return { issueCreate: { success: true, issue: { ...issue(), id: "child" } } };
    if (query.includes("SwitchboardDelegated"))
      return {
        issues: { nodes: [issue(), issue("outside", "private")], pageInfo: { hasNextPage: true, endCursor: "next" } },
      };
    if (query.includes("SwitchboardWorkItem"))
      return { issue: issue(String(variables.id) === "outside" ? "outside" : "team") };
    throw new Error("unexpected query");
  });
  const actor = { id: "linear:org:human", actions: ["work-items:read", "work-items:write"] };
  return { person, query, actor, deps: { organizationId: "org", appUserId: "bot", query } };
}

describe("Linear work items", () => {
  it("recognizes inherited access to a restricted child but never opens a private child by its parent", async () => {
    const f = fixture();
    const original = f.query.getMockImplementation()!;
    let visibility = "restricted";
    f.query.mockImplementation(async (query, variables) => {
      if (!query.includes("query SwitchboardWorkItem(")) return original(query, variables);
      const row = issue("child", visibility);
      return { issue: { ...row, team: { ...row.team, restrictedBy: { id: "team" } } } };
    });
    await expect(linearWorkItems(f.deps, f.actor, { op: "get", id: "issue" })).resolves.toHaveProperty(
      "teamId",
      "child",
    );
    visibility = "private";
    await expect(linearWorkItems(f.deps, f.actor, { op: "get", id: "issue" })).rejects.toThrow(
      "linear_work_item_denied",
    );
  });
  it("allows a public team only for people with public-team access and rejects a foreign workspace identity", async () => {
    const f = fixture();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (query, variables) =>
      query.includes("query SwitchboardWorkItem(") ? { issue: issue("outside", "public") } : original(query, variables),
    );
    await expect(linearWorkItems(f.deps, f.actor, { op: "get", id: "issue" })).resolves.toMatchObject({
      teamId: "outside",
    });
    f.person.canAccessAnyPublicTeam = false;
    await expect(linearWorkItems(f.deps, f.actor, { op: "get", id: "issue" })).rejects.toThrow(
      "linear_work_item_denied",
    );
    await expect(
      linearWorkItems(f.deps, { ...f.actor, id: "linear:other:human" }, { op: "get", id: "issue" }),
    ).rejects.toThrow("linear_human_required");
  });
  it("paginates membership and refuses a false mutation receipt or unknown status", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({
      user: { ...f.person, teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more" } } },
    });
    await expect(linearWorkItems(f.deps, f.actor, { op: "get", id: "issue" })).resolves.toHaveProperty("id", "issue");
    expect(f.query.mock.calls[1]![1]).toMatchObject({ after: "more" });
    await expect(linearWorkItems(f.deps, f.actor, { op: "update", id: "issue", state: "Not a state" })).rejects.toThrow(
      "linear_unknown_or_ambiguous_state",
    );
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (query, variables) =>
      query.includes("mutation") ? { issueUpdate: { success: false } } : original(query, variables),
    );
    await expect(linearWorkItems(f.deps, f.actor, { op: "update", id: "issue", title: "New title" })).rejects.toThrow(
      "linear_work_item_write_failed",
    );
  });
  it("checks the current human's access and denies a private issue outside their teams even for an operator", async () => {
    const f = fixture();
    expect(await linearWorkItems(f.deps, { ...f.actor, actions: "all" }, { op: "get", id: "issue" })).toMatchObject({
      identifier: "ENG-1",
      availableStates: [{ id: "done", name: "Done", type: "completed" }],
    });
    await expect(linearWorkItems(f.deps, { ...f.actor, actions: "all" }, { op: "get", id: "outside" })).rejects.toThrow(
      "linear_work_item_denied",
    );
    f.person.active = false;
    await expect(linearWorkItems(f.deps, f.actor, { op: "get", id: "issue" })).rejects.toThrow("linear_human_required");
  });
  it("filters the delegated queue by visibility and delegate, preserves pagination and never returns a private outsider", async () => {
    const f = fixture();
    const result = await linearWorkItems(f.deps, f.actor, { op: "delegated", after: "previous", limit: 10 });
    expect(result).toMatchObject({ items: [{ identifier: "ENG-1" }], nextCursor: "next" });
    const call = f.query.mock.calls.find(([q]) => q.includes("SwitchboardDelegated"))!;
    expect(call[1]).toMatchObject({
      after: "previous",
      first: 10,
      filter: {
        delegate: { id: { eq: "bot" } },
        team: {
          or: [
            { id: { in: ["team"] } },
            { and: [{ visibility: { eq: "restricted" } }, { restrictedBy: { id: { in: ["team"] } } }] },
            { visibility: { eq: "public" } },
          ],
        },
      },
    });
    f.person.canAccessAnyPublicTeam = false;
    await linearWorkItems(f.deps, f.actor, { op: "delegated" });
    expect(f.query.mock.calls.filter(([q]) => q.includes("SwitchboardDelegated")).at(-1)![1]).toMatchObject({
      filter: {
        team: {
          or: [
            { id: { in: ["team"] } },
            { and: [{ visibility: { eq: "restricted" } }, { restrictedBy: { id: { in: ["team"] } } }] },
          ],
        },
      },
    });
  });
  it("requires the write grant and updates only requested fields, preserving human assignee and delegation", async () => {
    const f = fixture();
    await expect(
      linearWorkItems(
        f.deps,
        { ...f.actor, actions: ["work-items:read"] },
        { op: "update", id: "issue", state: "Done" },
      ),
    ).rejects.toThrow("linear_work_item_denied");
    expect(f.query.mock.calls.some(([q]) => q.includes("mutation"))).toBe(false);
    await linearWorkItems(f.deps, f.actor, { op: "update", id: "issue", state: "Done", priority: 1 });
    expect(f.query.mock.calls.find(([q]) => q.includes("SwitchboardWorkItemUpdate"))![1]).toEqual({
      id: "issue",
      input: { stateId: "done", priority: 1 },
    });
  });
  it("creates children in the visible parent's team without assigning them or triggering another agent", async () => {
    const f = fixture();
    await linearWorkItems(f.deps, f.actor, { op: "create_child", parentId: "issue", title: "Add a regression test" });
    expect(f.query.mock.calls.find(([q]) => q.includes("SwitchboardChild"))![1]).toEqual({
      input: { parentId: "issue", teamId: "team", title: "Add a regression test" },
    });
  });
});
