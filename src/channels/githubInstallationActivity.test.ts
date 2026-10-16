import { describe, expect, it } from "vitest";
import { normalizeGithubActivity } from "./githubActivity.js";

const source = { host: "github.com", appId: 1, installationId: 2 };
const installation = {
  id: 2,
  app_id: 1,
  repository_selection: "selected",
  permissions: { contents: "read", pull_requests: "write" },
};
const native = { action: "suspend", installation, sender: { id: 4, login: "actor", type: "User" } };

describe("GitHub installation activity normalization", () => {
  it.each(["created", "deleted", "new_permissions_accepted", "suspend", "unsuspend"])(
    "retains installation-wide %s without a repository or requester grant",
    async (action) => {
      const payload = { ...native, action, requester: { id: 99, login: "other-user" } };
      const result = await normalizeGithubActivity(source, { event: "installation", delivery: action }, payload);
      expect(result).toMatchObject({
        kind: "normalized",
        event: {
          kind: "source-fact",
          sourceId: "github:github.com:app:1:installation:2",
          objectId: "github:github.com:installation:2",
          authorId: "github:github.com:user:4",
          payload: {
            version: 1,
            installation: { id: 2, appId: 1 },
            activity: {
              surface: "installation-access",
              event: "installation",
              action,
              repositorySelection: "selected",
              installationRepositorySelection: "selected",
              repositoryIds: null,
              addedRepositoryIds: null,
              removedRepositoryIds: null,
              permissions: installation.permissions,
              actorId: 4,
            },
            native: payload,
          },
        },
      });
      if (result.kind !== "normalized") throw new Error("expected source fact");
      expect(Object.keys(result.event.payload as object).sort()).toEqual([
        "activity",
        "installation",
        "native",
        "version",
      ]);
      expect(Object.keys(result.event).sort()).toEqual([
        "authorId",
        "changeId",
        "deliveryId",
        "kind",
        "objectId",
        "payload",
        "sourceId",
        "version",
      ]);
    },
  );

  it("keeps unknown, empty and all-repository selections distinct", async () => {
    expect(
      await normalizeGithubActivity(
        source,
        { event: "installation", delivery: "empty" },
        { ...native, repositories: [] },
      ),
    ).toMatchObject({
      kind: "normalized",
      event: { payload: { activity: { repositoryIds: [], repositorySelection: "selected" } } },
    });
    const payload = {
      ...native,
      action: "created",
      installation: { ...installation, repository_selection: "all" },
      repositories: [{ id: 3 }, { id: 9 }],
    };
    expect(await normalizeGithubActivity(source, { event: "installation", delivery: "all" }, payload)).toMatchObject({
      kind: "normalized",
      event: { payload: { activity: { repositoryIds: [3, 9], repositorySelection: "all" } } },
    });
  });

  it.each(["added", "removed"])(
    "retains %s repository lists including empty removals on all-to-selected changes",
    async (action) => {
      const payload = {
        ...native,
        action,
        repository_selection: "selected",
        repositories_added: action === "added" ? [{ id: 3 }] : [],
        repositories_removed: action === "removed" ? [{ id: 9 }] : [],
      };
      expect(
        await normalizeGithubActivity(source, { event: "installation_repositories", delivery: action }, payload),
      ).toMatchObject({
        kind: "normalized",
        event: {
          objectId: "github:github.com:installation:2",
          payload: {
            activity: {
              event: "installation_repositories",
              action,
              repositorySelection: "selected",
              repositoryIds: null,
              addedRepositoryIds: action === "added" ? [3] : [],
              removedRepositoryIds: action === "removed" ? [9] : [],
            },
            native: payload,
          },
        },
      });
      expect(
        await normalizeGithubActivity(
          source,
          { event: "installation_repositories", delivery: `${action}-empty` },
          { ...payload, repositories_added: [], repositories_removed: [] },
        ),
      ).toMatchObject({
        kind: "normalized",
        event: { payload: { activity: { addedRepositoryIds: [], removedRepositoryIds: [] } } },
      });
    },
  );

  it("freezes input and separates delivery identity from access revisions", async () => {
    const payload = structuredClone(native),
      binding = { ...source },
      headers = { event: "installation", delivery: "one" };
    const pending = normalizeGithubActivity(binding, headers, payload);
    payload.action = "unsuspend";
    binding.installationId = 99;
    headers.delivery = "changed";
    const first = await pending,
      again = await normalizeGithubActivity(source, { event: "installation", delivery: "two" }, native),
      changed = await normalizeGithubActivity(
        source,
        { event: "installation", delivery: "three" },
        { ...native, action: "unsuspend" },
      );
    if (first.kind !== "normalized" || again.kind !== "normalized" || changed.kind !== "normalized")
      throw new Error("expected source facts");
    expect(first.event).toMatchObject({
      deliveryId: "one",
      sourceId: "github:github.com:app:1:installation:2",
      payload: { activity: { action: "suspend" } },
    });
    expect(first.event.changeId).toMatch(/^[a-f0-9]{64}$/);
    expect(again.event.changeId).toBe(first.event.changeId);
    expect(changed.event.changeId).not.toBe(first.event.changeId);
    expect(changed.event.objectId).toBe(first.event.objectId);
  });

  it("retains unknown actors and rejects foreign or malformed source facts", async () => {
    expect(
      await normalizeGithubActivity(
        source,
        { event: "installation", delivery: "unknown" },
        { ...native, sender: null },
      ),
    ).toMatchObject({ kind: "normalized", event: { payload: { activity: { actorId: null } } } });
    for (const payload of [
      { ...native, installation: { ...installation, id: 99 } },
      { ...native, installation: { ...installation, app_id: 99 } },
      { ...native, installation: { ...installation, repository_selection: "bad" } },
      { ...native, repositories: null },
      { ...native, repositories: [{ id: 0 }] },
      { ...native, installation: { ...installation, permissions: null } },
    ]) {
      expect(await normalizeGithubActivity(source, { event: "installation", delivery: "bad" }, payload)).toMatchObject({
        kind: "refused",
      });
    }
    expect(
      await normalizeGithubActivity(
        source,
        { event: "installation", delivery: "future" },
        { ...native, action: "future" },
      ),
    ).toEqual({ kind: "ignored", reason: "action" });
    expect(await normalizeGithubActivity(source, { event: "issue_comment", delivery: "missing-repo" }, {})).toEqual({
      kind: "refused",
      reason: "invalid-source",
    });
  });

  it("requires both repository delta lists and a valid configured source", async () => {
    const delta = {
      ...native,
      action: "removed",
      repository_selection: "selected",
      repositories_added: [],
      repositories_removed: [{ id: 3 }],
    };
    expect(
      await normalizeGithubActivity(source, { event: "installation_repositories", delivery: "valid" }, delta),
    ).toMatchObject({ kind: "normalized" });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "installation_repositories", delivery: "missing" },
        { ...delta, repositories_removed: undefined },
      ),
    ).toEqual({ kind: "refused", reason: "invalid-event" });
    expect(
      await normalizeGithubActivity(
        source,
        { event: "installation_repositories", delivery: "bad-list" },
        { ...delta, repositories_added: "unknown" },
      ),
    ).toEqual({ kind: "refused", reason: "invalid-payload" });
    expect(
      await normalizeGithubActivity(
        { ...source, host: "user:password@github.com" },
        { event: "installation", delivery: "bad-source" },
        native,
      ),
    ).toEqual({ kind: "refused", reason: "invalid-source" });
  });

  it("holds unsafe and oversized payloads without evaluating accessors", async () => {
    let reads = 0;
    const payload = {
      ...native,
      get repositories() {
        reads++;
        return [];
      },
    };
    expect(await normalizeGithubActivity(source, { event: "installation", delivery: "unsafe" }, payload)).toEqual({
      kind: "refused",
      reason: "invalid-event",
    });
    expect(reads).toBe(0);
    expect(
      await normalizeGithubActivity(
        source,
        { event: "installation", delivery: "large" },
        { ...native, retained: "x".repeat(400 * 1024) },
      ),
    ).toEqual({ kind: "refused", reason: "invalid-event" });
    expect(await normalizeGithubActivity(source, { event: "installation", delivery: "valid" }, native)).toMatchObject({
      kind: "normalized",
    });
  });
});
