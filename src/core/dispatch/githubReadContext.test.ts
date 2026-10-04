import { describe, expect, it, vi } from "vitest";
import { InMemoryGithubApi } from "../../execution/githubApi.js";
import { githubFileTool, githubReposTool, githubPullGetTool } from "../../tools/github.js";
import type { ToolContext } from "../../tools/runnableTool.js";
import { sourceHash } from "../references/receipts.js";
import { githubReadWithContext } from "./githubReadContext.js";

describe("durable requester-scoped GitHub reads", () => {
  it("enables review closure only after delivering the history source receipt", async () => {
    const f = fixture();
    f.ctx.reviewHistory = { target: { repo: "acme/api", number: 7 } };
    f.api.repos.get("acme/api")!.pulls = [
      {
        number: 7,
        title: "fix",
        body: "",
        state: "open",
        draft: false,
        url: "https://github.com/acme/api/pull/7",
        author: "author",
        updatedAt: "2026-01-01T00:00:00Z",
        head: { repo: "acme/api", ref: "fix", sha: "a".repeat(40) },
        base: { repo: "acme/api", ref: "main" },
      },
    ];
    const tool = githubReadWithContext(githubPullGetTool, { runId: "producer", commit: f.commit });
    const args = { repo: "acme/api", number: 7, includeReviewHistory: true };
    f.commit.mockResolvedValueOnce(false);
    expect(await tool.run(args, f.ctx)).toMatch(/could not be durably recorded/);
    expect(f.ctx.reviewHistory.snapshot).toBeUndefined();
    await tool.run(args, f.ctx);
    expect(f.ctx.reviewHistory.snapshot).toMatchObject({ head: "a".repeat(40), findings: [] });
    f.commit.mockResolvedValueOnce(false);
    await tool.run(args, f.ctx);
    expect(f.ctx.reviewHistory.snapshot).toBeUndefined();
  });
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
  it("records requester-authorized private results through the same receipt", async () => {
    const f = fixture();
    f.api.repos.set("acme/private", { private: true, files: { "README.md": "private readme" }, issues: [] });
    const body = await githubReadWithContext(githubFileTool, { runId: "producer", commit: f.commit }).run(
      { repo: "acme/private", path: "README.md" },
      f.ctx,
    );
    expect(body).toContain("private readme");
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ repos: ["acme/private"], resultHash: await sourceHash(body) }),
      expect.objectContaining({ status: "known", githubRepos: ["acme/private"] }),
    );
  });
});
