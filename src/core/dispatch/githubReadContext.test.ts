import { describe, expect, it, vi } from "vitest";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { githubFileTool, githubReposTool } from "../../tools/github.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { sourceHash } from "../references/receipts.js";
import { githubReadWithContext } from "./githubReadContext.js";

describe("durable public GitHub reads", () => {
  const fixture = () => {
    const api = new InMemoryGithubApi({ "acme/api": { private: false, files: { "README.md": "public readme" } } });
    const commit = vi.fn(async () => true);
    const ctx: ToolContext = {
      executor: {} as ToolContext["executor"],
      callId: "read-1",
      agentName: "orchestrator",
      github: { api, canWrite: () => true, readableRepos: async () => api.listRepos() },
    };
    return { api, commit, ctx };
  };
  it("commits exact returned bytes and repository access before returning the result", async () => {
    const f = fixture();
    let release!: () => void;
    f.commit.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const result = githubReadWithContext(githubFileTool, { runId: "producer", commit: f.commit }).run(
      { repo: "acme/api", path: "README.md" },
      f.ctx,
    );
    await vi.waitFor(() => expect(f.commit).toHaveBeenCalledOnce());
    let exposed = false;
    void result.then(() => {
      exposed = true;
    });
    expect(exposed).toBe(false);
    release();
    const body = await result;
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        runId: "producer",
        callId: "read-1",
        tool: "github_file",
        repos: ["acme/api"],
        resultHash: await sourceHash(body),
      }),
      expect.objectContaining({ status: "known", githubRepos: ["acme/api"] }),
    );
  });
  it("withholds a public result when its durable receipt cannot be saved", async () => {
    const f = fixture();
    f.commit.mockResolvedValue(false);
    expect(
      await githubReadWithContext(githubFileTool, { runId: "producer", commit: f.commit }).run(
        { repo: "acme/api", path: "README.md" },
        f.ctx,
      ),
    ).not.toContain("public readme");
  });
  it("does not invent public proof for installation-only private reads", async () => {
    const f = fixture();
    f.ctx.agentName = "general";
    f.ctx.github!.readableRepos = async () => [];
    expect(
      await githubReadWithContext(githubFileTool, { runId: "producer", commit: f.commit }).run(
        { repo: "acme/api", path: "README.md" },
        f.ctx,
      ),
    ).toContain("public readme");
    expect(f.commit).not.toHaveBeenCalled();
  });
  it("records the complete exposed public catalog", async () => {
    const f = fixture();
    const body = await githubReadWithContext(githubReposTool, { runId: "producer", commit: f.commit }).run({}, f.ctx);
    expect(body).toContain("acme/api");
    expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({ repos: ["acme/api"] }), expect.anything());
  });
});
