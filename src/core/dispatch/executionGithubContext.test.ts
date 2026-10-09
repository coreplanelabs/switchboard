import { describe, expect, it } from "vitest";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { currentGithubReadCapability } from "./executionGithubContext.js";

describe("current native execution read authority", () => {
  it.each(["removed installation", "revoked contents"])(
    "denies old private code after %s despite an empty successful global search",
    async (gap) => {
      const api = new InMemoryGithubApi(gap === "removed installation" ? {} : { "acme/private": { private: true } });
      api.searchCode = async () => [];
      if (gap === "revoked contents")
        api.listTree = async () => {
          throw new Error("contents permission revoked");
        };
      expect(
        await currentGithubReadCapability(
          {
            version: 2,
            runId: "run",
            callId: "call",
            tool: "github_search_code",
            repos: ["acme/private"],
            resultHash: "a".repeat(64),
            inputHash: "b".repeat(64),
            admissionHash: "c".repeat(64),
          },
          { query: "old private code" },
          { api, canWrite: () => false },
          "review",
        ),
      ).toBe(false);
    },
  );

  it("denies an unrecognized global issue search family rather than treating a catalog as authority", async () => {
    const api = new InMemoryGithubApi({ "acme/private": { private: true } });
    expect(
      await currentGithubReadCapability(
        {
          version: 2,
          runId: "run",
          callId: "call",
          tool: "github_search_issues",
          repos: ["acme/private"],
          resultHash: "a".repeat(64),
          inputHash: "b".repeat(64),
          admissionHash: "c".repeat(64),
        },
        { query: "old private issue" },
        { api, canWrite: () => false },
        "review",
      ),
    ).toBe(false);
  });
});
