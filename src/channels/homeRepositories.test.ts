// Feature: docs/reference/specs/browser-home.md — explicit repository context stays within current source authority.
import { describe, expect, it, vi } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../config.js";
import { resolveActor } from "../core/authz/actor.js";
import { envelopeSchema } from "../core/organization/contract.js";
import { InMemoryGithubApi, GithubApiError, GithubCredentialUnavailable } from "../execution/githubApi.js";
import { createHomeRepositories } from "./homeRepositories.js";

function fixture(granted = ["sample/a", "sample/z", "sample/private"]) {
  const config = new ConfigStore(
    {
      validated: {
        organization: "fixture",
        providers: {},
        defaults: { agent: "main", models: {} },
        restrict: { repos: ["sample/a", "sample/z", "sample/private", "sample/denied"] },
        grants: { "access:alice": { codeRepos: granted } },
      },
    },
    { backing: new InMemoryOverridesBacking(), initial: undefined },
  );
  const actor = resolveActor({ surface: "access-browser", subjectId: "alice" }, (id) => config.grantsFor(id));
  const github = new InMemoryGithubApi({
    "sample/z": { private: false },
    "sample/a": { private: false },
    "sample/private": { private: true },
    "sample/denied": { private: false },
  });
  return { actor, config, github, repositories: createHomeRepositories({ config, github }) };
}

describe("Home repository selection", () => {
  it.each([
    [new GithubCredentialUnavailable("missing"), "credential_missing", 401],
    [new GithubCredentialUnavailable("failed"), "credential_failed", 503],
    [new GithubApiError(429, "PRIVATE_DETAIL"), "github_http", 429],
    [new TypeError("PRIVATE_DETAIL"), "read_error", undefined],
  ])("reports a closed repository-read cause without private exception details %s", async (error, kind, status) => {
    const { actor, config } = fixture();
    class FailedApi extends InMemoryGithubApi {
      override async listRepos(): Promise<never> {
        throw error;
      }
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const read = createHomeRepositories({ config, github: new FailedApi() });
      expect(await read.read(actor)).toEqual({ status: "unavailable", repositories: [] });
      expect(warn.mock.calls).toEqual([
        [
          JSON.stringify({
            event: "home.repositories.unavailable",
            reason: "read_failed",
            errorKind: kind,
            ...(status === undefined ? {} : { httpStatus: status }),
          }),
        ],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_DETAIL");
    } finally {
      warn.mockRestore();
    }
  });
  it("reports an invalid repository list without exposing repository names", async () => {
    const { actor, config } = fixture();
    const permission = vi.spyOn(config, "canUseRepo").mockReturnValue(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const read = createHomeRepositories({
        config,
        github: new InMemoryGithubApi({ "private name/repository": { private: false } }),
      });
      expect(await read.read(actor)).toEqual({ status: "unavailable", repositories: [] });
      expect(warn.mock.calls).toEqual([
        [JSON.stringify({ event: "home.repositories.unavailable", reason: "invalid_rows" })],
      ]);
    } finally {
      permission.mockRestore();
      warn.mockRestore();
    }
  });
  it("lists stable public choices within the actual actor's policy and hides private repositories even with code access", async () => {
    const { actor, repositories } = fixture();
    expect(await repositories.read(actor)).toEqual({
      status: "complete",
      repositories: [{ repo: "sample/a" }, { repo: "sample/z" }],
    });
    expect(await repositories.authorize(actor, "SAMPLE/A")).toBe(true);
    expect(await repositories.authorize(actor, "sample/denied")).toBe(false);
    expect(await repositories.authorize(actor, "sample/private")).toBe(false);
  });

  it("rechecks removal and the fresh actor's revoked policy before selecting a source repository", async () => {
    const { actor, github, repositories } = fixture();
    expect(await repositories.sourceChoice(actor, { selected: "SAMPLE/A" })).toBe("sample/a");
    github.repos.delete("sample/a");
    expect(await repositories.authorize(actor, "sample/a")).toBe(false);
    expect(await repositories.sourceChoice(actor, { selected: "sample/a" })).toBeUndefined();
    const revoked = fixture([]).actor;
    expect(await repositories.read(revoked)).toEqual({ status: "complete", repositories: [] });
    expect(await repositories.sourceChoice(revoked, { selected: "sample/z" })).toBeUndefined();
  });

  it("keeps readable attachments as evidence and selects only the explicit repository or configured default", async () => {
    const { actor, repositories } = fixture();
    expect(
      await repositories.sourceChoice(actor, { selected: "sample/a", attached: ["SAMPLE/A"], configured: "sample/z" }),
    ).toBe("sample/a");
    expect(await repositories.sourceChoice(actor, { attached: ["sample/z"], configured: "sample/a" })).toBe("sample/a");
    expect(await repositories.sourceChoice(actor, { configured: "sample/a" })).toBe("sample/a");
    expect(await repositories.sourceChoice(actor, { selected: "sample/a", attached: ["sample/z"] })).toBe("sample/a");
    expect(await repositories.sourceChoice(actor, { attached: ["sample/a", "sample/z"] })).toBeUndefined();
    expect(await repositories.sourceChoice(actor, { selected: "../sample/a" })).toBeUndefined();
  });

  it("keeps an unavailable directory distinct from a confirmed empty eligible set", async () => {
    const { actor, config } = fixture();
    let available = false;
    class UnavailableGithub extends InMemoryGithubApi {
      override async listRepos() {
        if (!available) throw new Error("Unavailable");
        return super.listRepos();
      }
    }
    const unavailable = createHomeRepositories({
      config,
      github: new UnavailableGithub({ "sample/a": { private: false } }),
    });
    expect(await unavailable.read(actor)).toEqual({ status: "unavailable", repositories: [] });
    await expect(unavailable.authorize(actor, "sample/a")).rejects.toThrow(
      "Current repository verification is unavailable.",
    );
    await expect(unavailable.sourceChoice(actor, { selected: "sample/a" })).rejects.toThrow(
      "Current repository verification is unavailable.",
    );
    expect(await unavailable.authorize(fixture([]).actor, "sample/a")).toBe(false);
    available = true;
    expect(await unavailable.authorize(actor, "sample/a")).toBe(true);
    expect(await unavailable.sourceChoice(actor, { selected: "sample/a" })).toBe("sample/a");
    const empty = createHomeRepositories({ config, github: new InMemoryGithubApi() });
    expect(await empty.read(actor)).toEqual({ status: "complete", repositories: [] });
    expect(envelopeSchema.shape.context.parse([{ kind: "repository", key: "sample/a" }])).toEqual([
      { kind: "repository", key: "sample/a" },
    ]);
  });
});
