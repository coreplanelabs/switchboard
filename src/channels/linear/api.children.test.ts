import { describe, expect, it, vi } from "vitest";
import { DirectLinearApi } from "./api.js";
import { InMemoryLinearChildStore } from "./children.js";

const commentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  const children = new InMemoryLinearChildStore();
  let comment: Record<string, unknown> | undefined;
  let loseSessionResponse = false,
    hideSession = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("SwitchboardChildComment"))
      return Response.json({
        data: {
          organization: { id: "org" },
          issue: {
            id: "issue",
            comments: { nodes: comment ? [{ ...comment, ...(hideSession ? { agentSession: null } : {}) }] : [] },
          },
        },
      });
    if (query.includes("SwitchboardCreateChildComment")) {
      comment = { id: variables.input.id, body: variables.input.body, user: { id: "bot" }, agentSession: null };
      return Response.json({ data: { commentCreate: { success: true, comment: { id: commentId } } } });
    }
    if (query.includes("SwitchboardCreateChildSession")) {
      const child = {
        id: "child",
        url: "https://linear.app/session/child",
        appUser: { id: "bot" },
        comment: { id: commentId },
        issue: { id: "issue" },
      };
      comment!.agentSession = child;
      if (loseSessionResponse) throw new Error("lost upstream response");
      return Response.json({ data: { agentSessionCreateOnComment: { success: true, agentSession: child } } });
    }
    throw new Error("unexpected query");
  });
  const api = new DirectLinearApi({
    organizationId: "org",
    appUserId: "bot",
    children,
    token: async () => "secret",
    fetch,
  });
  const access = vi.spyOn(api, "canRead").mockResolvedValue(true);
  vi.spyOn(api, "session").mockResolvedValue({
    id: "parent",
    appUserId: "bot",
    issue: { id: "issue", identifier: "EX-1", title: "Fix it", teamId: "team" },
  });
  const open = (user = "linear:org:alice", lead = "Review this change") =>
    api.openThread("parent", user, { id: commentId, lead });
  const mutations = () =>
    fetch.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)).query as string)
      .filter((q) => q.startsWith("mutation"));
  return {
    api,
    access,
    children,
    open,
    mutations,
    fetch,
    lose: (hidden = false) => {
      loseSessionResponse = true;
      hideSession = hidden;
    },
    reveal: () => {
      hideSession = false;
    },
  };
}

describe("Linear native child sessions", () => {
  it("recognizes a managed session during creation only from its durable comment intent", async () => {
    const children = new InMemoryLinearChildStore();
    await children.ensure({
      organizationId: "org",
      appUserId: "bot",
      parentSessionId: "parent",
      requesterId: "linear:org:alice",
      issueId: "issue",
      commentId,
      lead: "Review",
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: {
          organization: { id: "org" },
          agentSession: {
            id: "child",
            appUser: { id: "bot" },
            creator: { id: "bot" },
            comment: { id: commentId, body: "Review", user: { id: "bot" } },
            issue: { id: "issue", identifier: "EX-1", title: "Fix", team: { id: "team" } },
          },
        },
      }),
    );
    const api = new DirectLinearApi({
      organizationId: "org",
      appUserId: "bot",
      children,
      token: async () => "secret",
      fetch,
    });
    expect((await api.session("child")).managedChild).toBe(true);
    await children.beginSession("org", commentId);
    expect((await api.session("child")).managedChild).toBe(true);
    await children.finish("org", commentId, { id: "different" });
    expect((await api.session("child")).managedChild).toBeUndefined();
  });
  it("allows concurrent retries to attempt at most one session creation", async () => {
    const f = fixture();
    const results = await Promise.allSettled([f.open(), f.open()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(f.mutations().filter((q) => q.includes("SwitchboardCreateChildSession"))).toHaveLength(1);
    expect((await f.open()).sessionId).toBe("child");
  });
  it("creates one comment and session, binds the human, and reuses the durable result", async () => {
    const f = fixture();
    expect(await f.open()).toEqual({
      organizationId: "org",
      sessionId: "child",
      url: "https://linear.app/session/child",
    });
    await f.open();
    expect(f.access).toHaveBeenCalledTimes(2);
    expect(f.mutations()).toHaveLength(2);
    expect(await f.children.get("org", commentId)).toMatchObject({
      requesterId: "linear:org:alice",
      parentSessionId: "parent",
      session: { id: "child" },
    });
    await expect(f.open("linear:org:bob")).rejects.toThrow("linear_child_conflict");
    await expect(f.open("linear:org:alice", "Different work")).rejects.toThrow("linear_child_conflict");
  });
  it("reconciles a lost session response through the comment instead of recreating", async () => {
    const f = fixture();
    f.lose();
    expect((await f.open()).sessionId).toBe("child");
    expect(f.mutations()).toHaveLength(2);
  });
  it("leaves an uncertain session retryable by observation without repeating its mutation", async () => {
    const f = fixture();
    f.lose(true);
    await expect(f.open()).rejects.toThrow("linear_child_creation_uncertain");
    await expect(f.open()).rejects.toThrow("linear_child_creation_uncertain");
    expect(f.mutations()).toHaveLength(2);
    f.reveal();
    expect((await f.open()).sessionId).toBe("child");
    expect(f.mutations()).toHaveLength(2);
  });
  it("refuses revoked access and invalid creation ids before writing", async () => {
    const f = fixture();
    f.access.mockResolvedValue(false);
    await expect(f.open()).rejects.toThrow("linear_child_denied");
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.api.openThread("parent", "linear:org:alice", { id: "unbound", lead: "Hi" })).rejects.toThrow(
      "linear_invalid_child",
    );
    expect(await f.children.get("org", commentId)).toBeUndefined();
  });
});
