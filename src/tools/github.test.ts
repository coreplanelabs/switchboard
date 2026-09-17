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
  githubActionsRunTool,
  githubActionsJobLogTool,
} from "./github.js";
import { TOOLSETS } from "./toolsets.js";
import type { ToolContext } from "./runnableTool.js";
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
  // relayed reach — the web (search included), the skill tools, the session
  // tools and the GitHub reads; nothing that submits a verdict, a description,
  // dispositions or a handoff, or writes an issue. Its shell and file reads
  // are pi's own tools in its cold sandbox, never rows of this table.
  it("explore relays update_status, web_fetch, web_search, the skill tools, the session tools and the GitHub reads — no submit_*, no issue writes, and none of pi's own workspace tools", () => {
    expect(names("explore").sort()).toEqual(
      ["update_status", "web_fetch", "web_search", "list_skills", "use_skill", "recall", "notes", ...reads].sort(),
    );
    expect(names("explore").filter((n) => n.startsWith("submit_"))).toEqual([]);
  });
});

// docs/reference/specs/github-tools.md item 9: "why did this run fail?" from a
// pasted Actions URL, with no shell — the run and its jobs, then one job's log
// as its errors and its tail, timestamps stripped, secrets redacted.
describe("github_actions_* reads", () => {
  const T = (h: number, m: number, s: number) =>
    `2026-09-17T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;
  const step = (number: number, name: string, conclusion: string, from: string, to: string) => ({
    number,
    name,
    status: "completed",
    conclusion,
    startedAt: from,
    completedAt: to,
  });
  const logLines = [
    `${T(20, 0, 12).slice(0, -1)}.1234567Z ##[group]Run npm test`,
    `${T(20, 0, 12).slice(0, -1)}.2234567Z [32m> vitest run[0m`,
    `${T(20, 3, 1).slice(0, -1)}.0000000Z  FAIL  src/x.test.ts > x > adds`,
    `${T(20, 3, 1).slice(0, -1)}.1000000Z AssertionError: expected 2 to be 3`,
    `${T(20, 3, 9).slice(0, -1)}.0000000Z Tests  1 failed | 41 passed`,
    `${T(20, 3, 9).slice(0, -1)}.5000000Z token was ghp_abcdefghijklmnopqrstuvwxyz0123456789 in the log`,
    `${T(20, 3, 10).slice(0, -1)}.0000000Z ##[error]Process completed with exit code 1.`,
  ];
  const actions = () =>
    new InMemoryGithubApi({
      "acme/api": {
        actions: [
          {
            id: 123,
            name: "CI",
            displayTitle: "fix: the thing",
            workflowPath: ".github/workflows/ci.yml",
            status: "completed",
            conclusion: "failure",
            event: "pull_request",
            headBranch: "fix-x",
            headSha: "abcdef0123456789abcdef0123456789abcdef01",
            runNumber: 7,
            runAttempt: 1,
            url: "https://github.com/acme/api/actions/runs/123",
            createdAt: T(20, 0, 0),
            runStartedAt: T(20, 0, 5),
            updatedAt: T(20, 4, 17),
            jobs: [
              {
                id: 455,
                runId: 123,
                name: "lint",
                status: "completed",
                conclusion: "success",
                url: "https://github.com/acme/api/actions/runs/123/job/455",
                startedAt: T(20, 0, 10),
                completedAt: T(20, 1, 10),
                runnerName: "depot-ubuntu-24.04-4",
                steps: [
                  step(1, "Set up job", "success", T(20, 0, 10), T(20, 0, 12)),
                  step(2, "Run npm run lint", "success", T(20, 0, 12), T(20, 1, 10)),
                ],
              },
              {
                id: 456,
                runId: 123,
                name: "test 2 of 4",
                status: "completed",
                conclusion: "failure",
                url: "https://github.com/acme/api/actions/runs/123/job/456",
                startedAt: T(20, 0, 10),
                completedAt: T(20, 3, 11),
                runnerName: "depot-ubuntu-24.04-4",
                steps: [
                  step(1, "Set up job", "success", T(20, 0, 10), T(20, 0, 12)),
                  step(2, "Run npm test", "failure", T(20, 0, 12), T(20, 3, 10)),
                  step(3, "Post checkout", "skipped", T(20, 3, 10), T(20, 3, 10)),
                ],
                log: `${logLines.join("\n")}\n`,
              },
              {
                id: 457,
                runId: 123,
                name: "test 3 of 4",
                status: "in_progress",
                conclusion: null,
                url: "https://github.com/acme/api/actions/runs/123/job/457",
                startedAt: T(20, 0, 10),
                completedAt: null,
                runnerName: null,
                steps: [],
              },
            ],
          },
        ],
      },
    });

  it("both are side-effect-free reads and members of GITHUB_READ_TOOLS", () => {
    expect(githubActionsRunTool.sideEffectFree).toBe(true);
    expect(githubActionsJobLogTool.sideEffectFree).toBe(true);
    expect(GITHUB_READ_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining(["github_actions_run", "github_actions_job_log"]),
    );
  });

  it("github_actions_run renders the run, every job's conclusion and duration, the failed steps, and points at the log tool for the failed job", async () => {
    const out = await text(githubActionsRunTool, { repo: "acme/api", run: 123 }, ctxFor(actions()));
    expect(out).toBe(
      [
        "acme/api · CI run #7 — failure (completed) · pull_request on fix-x @ abcdef0 · “fix: the thing”",
        "https://github.com/acme/api/actions/runs/123 · started 2026-09-17T20:00:05Z, 4m12s to the last update · .github/workflows/ci.yml",
        "",
        "Jobs (3): 1 failure, 1 in_progress, 1 success",
        "✗ test 2 of 4 — failure, 3m01s (job 456)",
        "   failed step 2 “Run npm test” (2m58s); skipped step 3 “Post checkout”",
        "   https://github.com/acme/api/actions/runs/123/job/456",
        "· test 3 of 4 — in_progress (job 457)",
        "   https://github.com/acme/api/actions/runs/123/job/457",
        "✓ lint — success, 1m00s (job 455)",
        "",
        "Next: github_actions_job_log with job 456 shows the failed job's errors and the end of its log.",
      ].join("\n"),
    );
  });

  it("github_actions_run takes a run or job URL in place of repo + id, and refuses a repo that contradicts the URL", async () => {
    const ctx = ctxFor(actions());
    const byUrl = await text(
      githubActionsRunTool,
      { run: "https://github.com/Acme/API/actions/runs/123/job/456" },
      ctx,
    );
    expect(byUrl).toMatch(/^acme\/api · CI run #7 — failure/);
    expect(
      await text(githubActionsRunTool, { run: "https://github.com/acme/api/actions/runs/123/attempts/1" }, ctx),
    ).toMatch(/^acme\/api · CI run #7/);
    expect(
      await text(
        githubActionsRunTool,
        { repo: "acme/other", run: "https://github.com/acme/api/actions/runs/123" },
        ctx,
      ),
    ).toBe("github_actions_run: the URL names acme/api but repo says acme/other — pass one or the other.");
    expect(await text(githubActionsRunTool, { run: "abc" }, ctx)).toBe(
      'github_actions_run: run must be a run id or a github.com/<owner>/<repo>/actions/runs/<id> URL (got "abc").',
    );
    expect(await text(githubActionsRunTool, { run: 123 }, ctx)).toBe(
      "github_actions_run: repo is required when run is an id (owner/name), or pass the run's URL.",
    );
    expect(await text(githubActionsRunTool, { repo: "acme/api", run: 999 }, ctx)).toMatch(
      /^github_actions_run: not found in acme\/api — the repo is outside the Switchboard GitHub App installation/,
    );
  });

  it("github_actions_job_log renders the job's steps, its ##[error] lines and the end of the log — timestamps stripped, ANSI stripped, secrets redacted", async () => {
    const out = await text(githubActionsJobLogTool, { repo: "acme/api", job: 456 }, ctxFor(actions()));
    expect(out).toBe(
      [
        "acme/api · job “test 2 of 4” (456) of run 123 — failure, 3m01s · runner depot-ubuntu-24.04-4",
        "https://github.com/acme/api/actions/runs/123/job/456",
        "Steps: ✓ 1 Set up job (2s) · ✗ 2 Run npm test (2m58s) · – 3 Post checkout (skipped)",
        "",
        "Errors (1):",
        "##[error]Process completed with exit code 1.",
        "",
        "Last 7 lines of 7:",
        "##[group]Run npm test",
        "> vitest run",
        " FAIL  src/x.test.ts > x > adds",
        "AssertionError: expected 2 to be 3",
        "Tests  1 failed | 41 passed",
        "token was «redacted-github-token» in the log",
        "##[error]Process completed with exit code 1.",
      ].join("\n"),
    );
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("");
    expect(out).not.toContain("2026-09-17T20:03:10.0000000Z");
  });

  it("github_actions_job_log: `lines` picks the tail's length (clamped to 2000), `match` filters lines instead of tailing", async () => {
    const ctx = ctxFor(actions());
    const two = await text(githubActionsJobLogTool, { repo: "acme/api", job: 456, lines: 2 }, ctx);
    expect(two).toContain(
      "Last 2 lines of 7:\ntoken was «redacted-github-token» in the log\n##[error]Process completed with exit code 1.",
    );
    const matched = await text(githubActionsJobLogTool, { repo: "acme/api", job: 456, match: "fail" }, ctx);
    expect(matched).toContain(
      'Lines matching "fail" (2 of 7):\n FAIL  src/x.test.ts > x > adds\nTests  1 failed | 41 passed',
    );
    expect(matched).not.toContain("Last ");
    const none = await text(githubActionsJobLogTool, { repo: "acme/api", job: 456, match: "zzz" }, ctx);
    expect(none).toContain('Lines matching "zzz" (0 of 7): none.');
    const big = await text(githubActionsJobLogTool, { repo: "acme/api", job: 456, lines: 99999 }, ctx);
    expect(big).toContain("Last 7 lines of 7:");
  });

  it("github_actions_job_log takes a job URL, refuses a run URL without a job, a bad id, and words a 404; a live job says its log is partial", async () => {
    const ctx = ctxFor(actions());
    expect(
      await text(githubActionsJobLogTool, { job: "https://github.com/acme/api/actions/runs/123/job/456" }, ctx),
    ).toMatch(/^acme\/api · job “test 2 of 4” \(456\)/);
    expect(await text(githubActionsJobLogTool, { job: "https://github.com/acme/api/actions/runs/123" }, ctx)).toBe(
      "github_actions_job_log: that URL names a run, not a job — github_actions_run lists its jobs with their ids.",
    );
    expect(await text(githubActionsJobLogTool, { repo: "acme/api", job: "x" }, ctx)).toBe(
      'github_actions_job_log: job must be a job id or a github.com/<owner>/<repo>/actions/runs/<run>/job/<id> URL (got "x").',
    );
    expect(await text(githubActionsJobLogTool, { job: 456 }, ctx)).toBe(
      "github_actions_job_log: repo is required when job is an id (owner/name), or pass the job's URL.",
    );
    expect(await text(githubActionsJobLogTool, { repo: "acme/api", job: 999 }, ctx)).toMatch(
      /^github_actions_job_log: not found in acme\/api — the repo is outside the Switchboard GitHub App installation/,
    );
    const live = await text(githubActionsJobLogTool, { repo: "acme/api", job: 457 }, ctx);
    expect(live).toMatch(/^acme\/api · job “test 3 of 4” \(457\) of run 123 — in_progress · runner unknown\n/);
    expect(live).toContain("Steps: none reported yet");
    expect(live).toContain("The job is still running; the log is what GitHub has so far.");
    expect(live).toContain("Last 0 lines of 0:");
  });
});
