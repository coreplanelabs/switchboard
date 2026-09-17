import { describe, expect, it, vi } from "vitest";
import { DirectLinearApi } from "./api.js";

describe("Linear API boundary", () => {
  it("mints private file uploads and preserves signed storage headers without forwarding the OAuth token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/file?signature=one-file",
              assetUrl: "https://uploads.linear.app/file",
              headers: [
                { key: "Content-Disposition", value: "attachment; filename=plot.png" },
                { key: "x-goog-content-length-range", value: "12,12" },
              ],
            },
          },
        },
      }),
    );
    const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
    const upload = await api.upload("s", { name: "plot.png", size: 12 });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).variables).toEqual({
      contentType: "image/png",
      filename: "plot.png",
      size: 12,
      metaData: { agentSessionId: "s" },
    });
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toContain("makePublic: false");
    expect(upload.headers).toMatchObject({
      "Content-Type": "image/png",
      "Content-Disposition": "attachment; filename=plot.png",
      "x-goog-content-length-range": "12,12",
    });
    expect(JSON.stringify(upload)).not.toContain("secret");
  });
  it("rejects invalid upload requests before minting and refuses unsafe storage responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = new DirectLinearApi({ organizationId: "org", appUserId: "bot", token: async () => "secret", fetch });
    for (const file of [
      { name: "../file", size: 1 },
      { name: "file", size: 0 },
      { name: "file", size: 2 ** 30 + 1 },
    ])
      await expect(api.upload("s", file)).rejects.toThrow("linear_invalid_file");
    expect(fetch).not.toHaveBeenCalled();
    for (const uploadUrl of ["http://storage.example/file", "https://user:pass@storage.example/file"]) {
      fetch.mockResolvedValueOnce(
        Response.json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl,
                assetUrl: "https://uploads.linear.app/file",
                headers: [],
              },
            },
          },
        }),
      );
      await expect(api.upload("s", { name: "file", size: 1 })).rejects.toThrow("linear_invalid_response");
    }
  });
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
