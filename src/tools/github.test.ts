import { describe, expect, it } from "vitest";
import { GithubApiError, InMemoryGithubApi } from "../execution/githubApi.js";
import {
  GITHUB_ISSUE_WRITE_TOOLS,
  GITHUB_READ_TOOLS,
  githubFileTool,
  githubIssueCreateTool,
  githubIssueDeleteTool,
  githubIssueGetTool,
  githubIssueListTool,
  githubIssueUpdateTool,
  githubReposTool,
  githubSearchCodeTool,
  githubTreeTool,
  githubIssueCommentTool,
} from "./github.js";
import { TOOLSETS, type ToolContext } from "./workspace.js";
import type { Executor } from "../execution/executor.js";

// Feature: features/github-tools.md — the github_* tools over the GithubApi
// seam: reads are side-effect-free and available to every agent with a tool
// loop; issue writes are gated per repo by the requesting user's permission
// and never reach the API when refused. Every failure is a string.

const noExecutor = {} as Executor;
const mem = () =>
  new InMemoryGithubApi({
    "acme/api": {
      description: "agent gateway",
      files: {
        "README.md": "# Switchboard\nresident repos are always-warm",
        "features/resident-repos.md": "52. detection",
        "src/x.ts": "const a = 1;",
      },
      issues: [
        {
          number: 40,
          title: "old",
          state: "open",
          url: "https://github.com/acme/api/issues/40",
          labels: ["bug"],
          assignees: ["ada"],
          author: "matanya",
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-02T00:00:00Z",
          body: "the body",
          comments: 0,
        },
      ],
    },
  });
const ctxFor = (api: InMemoryGithubApi, canWrite: (repo: string) => boolean = () => true): ToolContext => ({
  executor: noExecutor,
  github: { api, canWrite },
});
const text = async (
  tool: { run: (i: Record<string, unknown>, c: ToolContext) => Promise<unknown> },
  input: Record<string, unknown>,
  ctx: ToolContext,
) => String(await tool.run(input, ctx));

describe("github_* reads", () => {
  it("every tool reports itself unavailable without the capability, never throws", async () => {
    for (const tool of [...GITHUB_READ_TOOLS, ...GITHUB_ISSUE_WRITE_TOOLS]) {
      expect(
        await text(
          tool,
          { repo: "acme/api", number: 1, path: "x", query: "q", title: "t", body: "b" },
          { executor: noExecutor },
        ),
      ).toBe("GitHub tools are not available in this context.");
    }
  });

  it("github_repos lists the installation's repos with default branch + description", async () => {
    const out = await text(githubReposTool, {}, ctxFor(mem()));
    expect(out).toBe("Repositories reachable (1):\n- acme/api (private) — default branch main — agent gateway");
  });

  it("github_file returns the blob URL header + content; a 404 is worded as outside-the-installation-or-no-such-path", async () => {
    const ctx = ctxFor(mem());
    expect(await text(githubFileTool, { repo: "Acme/Api", path: "/features/resident-repos.md" }, ctx)).toBe(
      "https://github.com/acme/api/blob/main/features/resident-repos.md (13 bytes):\n\n52. detection",
    );
    expect(await text(githubFileTool, { repo: "acme/api", path: "nope.md" }, ctx)).toMatch(
      /^github_file: not found in acme\/api — the repo is outside the Switchboard GitHub App installation \(github_repos lists the reachable ones\), or the path\/ref\/number does not exist\./,
    );
    expect(await text(githubFileTool, { repo: "acme/api", path: "features" }, ctx)).toBe(
      "github_file: features is a directory — list it with github_tree",
    );
    expect(await text(githubFileTool, { repo: "not a slug", path: "x" }, ctx)).toMatch(
      /^github_file: repo must be an owner\/name slug/,
    );
    expect(await text(githubFileTool, { repo: "acme/api" }, ctx)).toBe("github_file: path is required.");
  });

  it("github_tree lists a directory (dirs with a trailing slash, files with sizes)", async () => {
    expect(await text(githubTreeTool, { repo: "acme/api" }, ctxFor(mem()))).toBe(
      "acme/api:/ — 3 entries:\nfeatures/\nREADME.md (44 B)\nsrc/",
    );
    expect(await text(githubTreeTool, { repo: "acme/api", path: "src", ref: "dev" }, ctxFor(mem()))).toBe(
      "acme/api@dev:src — 1 entry:\nsrc/x.ts (12 B)",
    );
  });

  it("github_search_code scopes to a repo and shows a fragment; empty query refused", async () => {
    const ctx = ctxFor(mem());
    expect(await text(githubSearchCodeTool, { query: "always-warm", repo: "acme/api" }, ctx)).toMatch(
      /^Code matches for "always-warm" in acme\/api \(1\):\n\n1\. acme\/api:README\.md\n {3}https:\/\/github\.com\/acme\/api\/blob\/main\/README\.md\n {3}.*always-warm/,
    );
    expect(await text(githubSearchCodeTool, { query: "zzz" }, ctx)).toBe('No code matches for "zzz".');
    expect(await text(githubSearchCodeTool, { query: "  " }, ctx)).toBe("github_search_code: empty query.");
  });

  it("github_issue_list / github_issue_get render issues and comments", async () => {
    const api = mem();
    const ctx = ctxFor(api);
    expect(await text(githubIssueListTool, { repo: "acme/api" }, ctx)).toBe(
      "Open issues in acme/api (1):\n#40 [open] old — matanya, updated 2026-09-02T00:00:00Z (labels: bug; assignees: ada)\n   https://github.com/acme/api/issues/40",
    );
    expect(await text(githubIssueListTool, { repo: "acme/api", state: "closed" }, ctx)).toBe(
      "No closed issues in acme/api.",
    );
    await api.commentIssue("acme/api", 40, "me too");
    const got = await text(githubIssueGetTool, { repo: "acme/api", number: "40" }, ctx);
    expect(got).toContain(
      "acme/api#40 [open] old\nhttps://github.com/acme/api/issues/40\nby matanya, created 2026-09-01T00:00:00Z, updated 2026-09-02T00:00:01.000Z\nlabels: bug\nassignees: ada\n\nthe body\n\n--- 1 comment ---\n[switchboard[bot], 2026-09-02T00:00:01.000Z]\nme too",
    );
    expect(await text(githubIssueGetTool, { repo: "acme/api", number: 0 }, ctx)).toBe(
      "github_issue_get: number must be a positive integer issue number (got 0).",
    );
  });

  it("reads are side-effect-free; writes are not", () => {
    for (const t of GITHUB_READ_TOOLS) expect(t.sideEffectFree, t.name).toBe(true);
    for (const t of GITHUB_ISSUE_WRITE_TOOLS) expect(t.sideEffectFree, t.name).toBeUndefined();
  });
});

describe("github_issue_* writes", () => {
  it("create → number + URL; update patches only given fields (state=closed closes); comment; delete is permanent and says so", async () => {
    const api = mem();
    const ctx = ctxFor(api);
    expect(await text(githubIssueCreateTool, { repo: "acme/api", title: "foo", body: "bar" }, ctx)).toBe(
      "Opened acme/api#41: foo\nhttps://github.com/acme/api/issues/41",
    );
    expect((await api.getIssue("acme/api", 41)).issue.body).toBe("bar");
    expect(
      await text(githubIssueUpdateTool, { repo: "acme/api", number: 41, state: "closed", labels: "bug, p1" }, ctx),
    ).toBe("Updated acme/api#41 (state, labels): [closed] foo\nhttps://github.com/acme/api/issues/41");
    expect((await api.getIssue("acme/api", 41)).issue.labels).toEqual(["bug", "p1"]);
    expect(await text(githubIssueUpdateTool, { repo: "acme/api", number: 41 }, ctx)).toBe(
      "github_issue_update: nothing to change — pass title, body, state, labels, or assignees.",
    );
    expect(await text(githubIssueCommentTool, { repo: "acme/api", number: 41, body: "note" }, ctx)).toBe(
      "Commented on acme/api#41\nhttps://github.com/acme/api/issues/41#issuecomment-1",
    );
    expect(await text(githubIssueDeleteTool, { repo: "acme/api", number: 41 }, ctx)).toBe(
      "Deleted acme/api#41 permanently.",
    );
    expect(api.deleted).toEqual(["acme/api#41"]);
    expect(await text(githubIssueCreateTool, { repo: "acme/api", title: "  " }, ctx)).toBe(
      "github_issue_create: title is required.",
    );
  });

  it("the per-repo write gate refuses BEFORE any API call and tells the model not to retry; reads on the same repo still work", async () => {
    const api = mem();
    const ctx = ctxFor(api, (repo) => repo !== "acme/api");
    for (const [tool, input] of [
      [githubIssueCreateTool, { title: "foo" }],
      [githubIssueUpdateTool, { number: 40, title: "x" }],
      [githubIssueCommentTool, { number: 40, body: "x" }],
      [githubIssueDeleteTool, { number: 40 }],
    ] as const) {
      expect(await text(tool, { repo: "acme/api", ...input }, ctx)).toBe(
        `${tool.name}: you are not allowed to write to acme/api (it is restricted and you hold no grant for it) — say so to the user instead of retrying.`,
      );
    }
    expect(api.deleted).toEqual([]);
    expect((await api.listIssues("acme/api")).map((i) => i.title)).toEqual(["old"]);
    expect(await text(githubIssueGetTool, { repo: "acme/api", number: 40 }, ctx)).toContain("acme/api#40 [open] old");
  });

  it("delete refused by GitHub (App installations cannot delete issues) → the honest line: nothing changed, offer to close, or the user deletes it", async () => {
    const api = mem();
    api.deleteIssue = async () => {
      throw new GithubApiError(403, "GitHub refused to delete acme/api#40: Viewer not authorized to delete");
    };
    expect(await text(githubIssueDeleteTool, { repo: "acme/api", number: 40 }, ctxFor(api))).toBe(
      "github_issue_delete: GitHub refused — issue deletion is not available to Switchboard's GitHub App credential (only a repository admin can delete an issue, in the GitHub UI). Nothing was changed. Offer to close it instead (github_issue_update state=closed), or tell the user to delete acme/api#40 themselves.",
    );
  });

  it("a write to a repo outside the installation is the 404 wording, not a crash", async () => {
    expect(await text(githubIssueCreateTool, { repo: "acme/elsewhere", title: "foo" }, ctxFor(mem()))).toMatch(
      /^github_issue_create: not found in acme\/elsewhere — the repo is outside the Switchboard GitHub App installation/,
    );
  });
});

describe("toolset wiring", () => {
  const names = (key: string) => (TOOLSETS[key] ?? []).map((t) => t.name);
  const reads = GITHUB_READ_TOOLS.map((t) => t.name);
  const writes = GITHUB_ISSUE_WRITE_TOOLS.map((t) => t.name);

  it("reads are in every toolset with a tool loop; issue writes only in assistant (general) and full (coding); none stays empty", () => {
    for (const key of ["full", "readonly", "web", "assistant", "explore", "conductor"])
      expect(names(key), key).toEqual(expect.arrayContaining(reads));
    expect(names("full")).toEqual(expect.arrayContaining(writes));
    expect(names("assistant")).toEqual(expect.arrayContaining(writes));
    for (const key of ["readonly", "web", "explore", "conductor"])
      for (const w of writes) expect(names(key), `${key} ${w}`).not.toContain(w);
    expect(names("none")).toEqual([]);
  });

  // docs/reference/specs/agent-conductor.md item 2: the five run tools, the
  // GitHub reads, URL reading and the status card — no shell, no files, no
  // writes; and the run tools are in no other toolset (dark by default).
  it("conductor holds spawn_run, send_to_run, await_runs, list_runs, get_run_status, web_fetch, update_status and the GitHub reads — no shell, no files, no submit_*, no issue writes; no other toolset holds a run tool", () => {
    const runTools = ["spawn_run", "send_to_run", "await_runs", "list_runs", "get_run_status"];
    expect(names("conductor").sort()).toEqual([...runTools, "web_fetch", "update_status", ...reads].sort());
    for (const key of Object.keys(TOOLSETS).filter((k) => k !== "conductor"))
      for (const t of runTools) expect(names(key), `${key} ${t}`).not.toContain(t);
  });

  it("assistant has no shell, no file writes, no verdict/PR submission — GitHub + web_fetch + status only", () => {
    expect(names("assistant").sort()).toEqual(["web_fetch", "update_status", ...reads, ...writes].sort());
  });

  // docs/reference/specs/agent-explore.md item 2: the investigation preset's
  // reach — a shell and file reads, the web (search included), the skill tools
  // and the GitHub reads; nothing that writes a file, submits a verdict, a
  // description, dispositions or a handoff, or writes an issue.
  it("explore holds bash, read_file, update_status, web_fetch, web_search, the skill tools and the GitHub reads — no write_file, no submit_*, no issue writes", () => {
    expect(names("explore").sort()).toEqual(
      ["bash", "read_file", "update_status", "web_fetch", "web_search", "list_skills", "use_skill", ...reads].sort(),
    );
    expect(names("explore").filter((n) => n.startsWith("submit_"))).toEqual([]);
  });
});
