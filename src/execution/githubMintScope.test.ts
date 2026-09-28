import { describe, expect, it } from "vitest";
import { DOOR_PUSH_PERMISSIONS, RESIDENT_MIRROR_PERMISSIONS, verifyGithubMintScope } from "./githubMintScope.js";

describe("GitHub installation token scope", () => {
  it("keeps a resident mirror token read-only, including its pull request lookup", () => {
    expect(RESIDENT_MIRROR_PERMISSIONS).toEqual({
      contents: "read",
      pull_requests: "read",
      metadata: "read",
    });
    expect(new Set(Object.values(RESIDENT_MIRROR_PERMISSIONS))).toEqual(new Set(["read"]));
  });

  it("limits a Git push token to contents and workflow changes", () => {
    expect(DOOR_PUSH_PERMISSIONS).toEqual({
      contents: "write",
      workflows: "write",
      metadata: "read",
    });
  });

  it("accepts GitHub's response shape when implicit Metadata is omitted", () => {
    const repo = [{ full_name: "acme/api" }];
    expect(() =>
      verifyGithubMintScope(
        {
          permissions: { contents: "write", workflows: "write" },
          repository_selection: "selected",
          repositories: repo,
        },
        "acme/api",
        DOOR_PUSH_PERMISSIONS,
      ),
    ).not.toThrow();
    expect(() =>
      verifyGithubMintScope(
        {
          permissions: { contents: "read", pull_requests: "read" },
          repository_selection: "selected",
          repositories: repo,
        },
        "acme/api",
        RESIDENT_MIRROR_PERMISSIONS,
      ),
    ).not.toThrow();
  });

  it("checks the returned repository and effective permissions without including the token in an error", () => {
    const response = {
      token: "ghs_secret-that-must-not-appear",
      permissions: DOOR_PUSH_PERMISSIONS,
      repository_selection: "selected",
      repositories: [{ full_name: "acme/api" }],
    };
    expect(() => verifyGithubMintScope(response, "Acme/API", DOOR_PUSH_PERMISSIONS)).not.toThrow();
    for (const bad of [
      { ...response, permissions: { ...DOOR_PUSH_PERMISSIONS, issues: "write" } },
      { ...response, permissions: { ...DOOR_PUSH_PERMISSIONS, checks: "read" } },
      { ...response, permissions: { ...DOOR_PUSH_PERMISSIONS, metadata: "write" } },
      { ...response, permissions: { contents: "write", metadata: "read" } },
      { ...response, repositories: [{ full_name: "acme/foreign" }] },
      { ...response, repositories: [{ full_name: "acme/api" }, { full_name: "acme/foreign" }] },
      { ...response, repository_selection: "all" },
      { ...response, permissions: undefined },
    ]) {
      let error: Error | undefined;
      try {
        verifyGithubMintScope(bad, "acme/api", DOOR_PUSH_PERMISSIONS);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toBe("GitHub token scope mismatch");
      expect(error?.message).not.toContain(response.token);
    }
  });
});
