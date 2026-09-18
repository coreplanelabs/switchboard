import { describe, expect, it, vi } from "vitest";
import { handleLinearLifecycle, revokeLinearInstallation, type LinearLiveWork } from "./lifecycle.js";
import { InMemoryLinearStore } from "./store.js";
import type { LinearApi } from "./api.js";
import type { LinearWebhookEvent } from "./webhook.js";

const event = (type: string, action: string, extra = {}): LinearWebhookEvent => ({
  key: "k",
  receivedAt: 200,
  payload: { type, action, organizationId: "org", createdAt: new Date(150).toISOString(), ...extra },
});
const installation = {
  organizationId: "org",
  appUserId: "bot",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 1000,
  version: "v",
  installedAt: 100,
};
describe("Linear lifecycle", () => {
  it("revokes stored credentials without deleting a newer installation or another workspace", async () => {
    const store = new InMemoryLinearStore();
    await store.putInstallation(installation);
    await store.putInstallation({ ...installation, organizationId: "other" });
    await revokeLinearInstallation(store, event("OAuthApp", "revoked"));
    expect(await store.getInstallation("org")).toBeUndefined();
    expect(await store.getInstallation("other")).toBeDefined();
    await store.putInstallation({ ...installation, installedAt: 160 });
    await revokeLinearInstallation(store, event("OAuthApp", "revoked"));
    expect(await store.getInstallation("org")).toBeDefined();
  });
  const fixture = () => {
    const api: LinearApi = {
      openThread: vi.fn(),
      workItems: vi.fn(),
      files: vi.fn(async () => []),
      canRead: vi.fn(async () => true),
      upload: vi.fn(),
      session: vi.fn(async (id) => ({ id, appUserId: "bot" })),
      activities: vi.fn(),
      activity: vi.fn(),
      link: vi.fn(),
    };
    const deps = {
      api: () => api,
      halt: vi.fn(async () => {}),
      live: vi.fn<() => Promise<LinearLiveWork[]>>(async () => [
        { id: "a", threadKey: "linear:org:a", channelId: "linear:org:t1", startedAt: 100 },
        { id: "b", threadKey: "linear:org:b", channelId: "linear:org:t2", startedAt: 100 },
        { id: "c", threadKey: "linear:other:c", channelId: "linear:other:t1", startedAt: 100 },
        { id: "d", threadKey: "slack:org:d", channelId: "slack:org", startedAt: 100 },
        { id: "new", threadKey: "linear:org:new", channelId: "linear:org:t1", startedAt: 201 },
      ]),
    };
    return { deps, api };
  };
  it("stops only the revoked workspace's pre-existing work", async () => {
    const { deps } = fixture();
    await handleLinearLifecycle(deps, event("OAuthApp", "revoked"));
    expect(deps.halt.mock.calls).toEqual([["a"], ["b"]]);
  });
  it("stops removed teams without lending authority to notification text", async () => {
    const { deps } = fixture();
    await handleLinearLifecycle(
      deps,
      event("PermissionChange", "teamAccessChanged", { removedTeamIds: ["t1"], canAccessAllPublicTeams: true }),
    );
    expect(deps.halt.mock.calls).toEqual([["a"]]);
  });
  it("rechecks access when public-team permission contracts and fails closed", async () => {
    const { deps, api } = fixture();
    vi.mocked(api.session).mockRejectedValueOnce(new Error("forbidden"));
    await handleLinearLifecycle(
      deps,
      event("PermissionChange", "teamAccessChanged", {
        removedTeamIds: [],
        canAccessAllPublicTeams: false,
        appUserId: "bot",
      }),
    );
    expect(deps.halt.mock.calls).toEqual([["a"]]);
  });
  it("rechecks project and document requesters when team permissions contract", async () => {
    const { deps, api } = fixture();
    deps.live.mockResolvedValue([
      {
        id: "a",
        threadKey: "linear:org:a",
        channelId: "linear:org:project:p",
        startedAt: 100,
        userId: "linear:org:alice",
      },
      {
        id: "b",
        threadKey: "linear:org:b",
        channelId: "linear:org:document:d",
        startedAt: 100,
        userId: "linear:org:bob",
      },
    ]);
    vi.mocked(api.canRead).mockImplementation(async (_session, user) => user === "linear:org:bob");
    await handleLinearLifecycle(
      deps,
      event("PermissionChange", "teamAccessChanged", { removedTeamIds: ["team"], canAccessAllPublicTeams: true }),
    );
    expect(deps.halt.mock.calls).toEqual([["a"]]);
    expect(api.canRead).toHaveBeenCalledWith("a", "linear:org:alice");
    deps.halt.mockClear();
    vi.mocked(api.canRead).mockRejectedValue(new Error("access unavailable"));
    await handleLinearLifecycle(deps, event("PermissionChange", "teamAccessChanged", { removedTeamIds: ["team"] }));
    expect(deps.halt.mock.calls).toEqual([["a"], ["b"]]);
  });
  it("checks the current issue delegate before stopping an unassigned notification", async () => {
    const { deps, api } = fixture();
    vi.mocked(api.session).mockImplementation(async (id) => ({
      id,
      appUserId: "bot",
      issue: { id: "issue", identifier: "I-1", title: "Work", teamId: "t1", delegateId: id === "a" ? null : "bot" },
    }));
    await handleLinearLifecycle(
      deps,
      event("AppUserNotification", "issueUnassignedFromYou", { appUserId: "bot", notification: { issueId: "issue" } }),
    );
    expect(deps.halt.mock.calls).toEqual([["a"]]);
    deps.halt.mockClear();
    await handleLinearLifecycle(deps, event("AppUserNotification", "issueCommentMention"));
    expect(deps.halt).not.toHaveBeenCalled();
  });
});
