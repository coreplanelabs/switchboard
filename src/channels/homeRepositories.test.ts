// Feature: docs/reference/specs/browser-home.md — explicit repository context stays within current source authority.
import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../config.js";
import { resolveActor } from "../core/authz/actor.js";
import { envelopeSchema } from "../core/organization/contract.js";
import { InMemoryGithubApi } from "../execution/githubApi.js";
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
