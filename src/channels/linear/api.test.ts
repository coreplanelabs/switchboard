import { describe, expect, it, vi } from "vitest";
import { DirectLinearApi } from "./api.js";

describe("Linear API boundary", () => {
  it("reconciles a lost activity mutation only against the same app, session and content", async () => {
    for (const changed of [
      {},
      { user: { id: "other" } },
      { agentSession: { id: "other" } },
      { content: { type: "thought", body: "different" } },
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce(
          Response.json({
            data: {
              agentActivity: {
                id: "activity",
                agentSession: { id: "s" },
                user: { id: "bot" },
                content: { type: "thought", body: "Received" },
                ...changed,
              },
            },
          }),
        );
      const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
      const result = api.activity("s", { type: "thought", body: "Received" }, { id: "activity" });
      if (Object.keys(changed).length === 0) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("linear_api_unavailable");
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it("checks the current workspace and session owner without exposing credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: {
          organization: { id: "org" },
          agentSession: {
            id: "s",
            appUser: { id: "bot" },
            creator: { id: "alice" },
            url: "https://linear.app/s",
            issue: null,
          },
        },
      }),
    );
    const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
    expect(await api.session("s")).toMatchObject({ id: "s", appUserId: "bot", creatorId: "alice" });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer secret" } });
    const other = new DirectLinearApi({
      organizationId: "other",
      appUserId: "bot",
      token: async () => "secret",
      fetch,
    });
    await expect(other.session("s")).rejects.toThrow("linear_wrong_installation");
  });
  it("paginates history backwards and returns chronological activities", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          agentSession: {
            activities: variables.before
              ? {
                  nodes: [
                    {
                      id: "first",
                      createdAt: "2020-01-01T00:00:00Z",
                      user: { id: "u" },
                      content: { type: "prompt", body: "first" },
                    },
                  ],
                  pageInfo: { hasPreviousPage: false, startCursor: "a" },
                }
              : {
                  nodes: [
                    {
                      id: "last",
                      createdAt: "2020-01-02T00:00:00Z",
                      user: { id: "bot" },
                      content: { type: "response", body: "last" },
                    },
                  ],
                  pageInfo: { hasPreviousPage: true, startCursor: "b" },
                },
          },
        },
      });
    });
    const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
    expect((await api.activities("s")).map((a) => a.id)).toEqual(["first", "last"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("fails closed on upstream errors and refuses unsuccessful mutation receipts", async () => {
    const fetch = vi.fn(async () => Response.json({ errors: [{ message: "token secret in upstream error" }] }));
    const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
    await expect(api.session("s")).rejects.toThrow(/^linear_api_error$/);
    fetch.mockImplementation(async () => Response.json({ data: { agentActivityCreate: { success: false } } }));
    await expect(api.activity("s", { type: "response", body: "answer" })).rejects.toThrow("linear_activity_failed");
  });
});
