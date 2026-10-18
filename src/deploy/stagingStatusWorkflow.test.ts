import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const sha = "a".repeat(40);
const branch = "release-please--branches--main--components--switchboard";
const repo = "example/service";
const pull = (ref = branch, head = sha) => ({
  number: 7,
  state: "open",
  head: { ref, sha: head, repo: { full_name: repo } },
  base: { ref: "main", repo: { full_name: repo } },
});
const controller = (id: number, overrides = {}) => ({
  id,
  run_attempt: 1,
  workflow_id: 77,
  path: ".github/workflows/deploy-staging.yml",
  event: "pull_request_target",
  display_title: "Staging requested",
  head_branch: branch,
  head_sha: sha,
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  run_started_at: `2026-10-18T21:${id}:00Z`,
  created_at: `2026-10-18T21:${id}:00Z`,
  status: "completed",
  conclusion: "success",
  html_url: `https://github.com/${repo}/actions/runs/${id}`,
  ...overrides,
});
const live = (conclusion = "success") => [{ name: "staging / live Review", status: "completed", conclusion }];

function execute(
  options: {
    event?: object;
    eventName?: string;
    runs?: ReturnType<typeof controller>[];
    jobs?: Record<string, ReturnType<typeof live>>;
    currentPull?: ReturnType<typeof pull>;
    totalCount?: number;
    historyFailure?: boolean;
    laterRuns?: ReturnType<typeof controller>[];
  } = {},
) {
  const workflow = parse(readFileSync(".github/workflows/staging-status.yml", "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "staging-status-"));
  try {
    const currentPull = options.currentPull ?? pull();
    const event = options.event ?? { repository: { default_branch: "main" }, pull_request: currentPull };
    writeFileSync(join(directory, "event"), JSON.stringify(event));
    writeFileSync(
      join(directory, "fixture"),
      JSON.stringify({
        runs: options.runs ?? [controller(10)],
        jobs: options.jobs ?? { "10": live() },
        pull: currentPull,
        totalCount: options.totalCount,
        historyFailure: options.historyFailure,
        laterRuns: options.laterRuns,
      }),
    );
    writeFileSync(
      join(directory, "gh"),
      `#!${process.execPath}
const fs = require("node:fs");
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const args = process.argv.slice(2);
const path = args.find(arg => arg.startsWith("repos/"));
let result;
if (args.includes("POST")) {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.appendFileSync(process.env.POSTS, JSON.stringify({ path, ...body }) + "\\n");
  result = {};
} else if (path.includes("/pulls?")) result = [fixture.pull];
else if (path.endsWith("/pulls/7")) result = fixture.pull;
else if (path.endsWith("/workflows/deploy-staging.yml")) result = { id: 77 };
else if (path.includes("/workflows/deploy-staging.yml/runs?")) {
  if (fixture.historyFailure) process.exit(1);
  const counter = process.env.FIXTURE + ".reads";
  const reads = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) : 0;
  fs.writeFileSync(counter, String(reads + 1));
  const runs = reads > 0 && fixture.laterRuns ? fixture.laterRuns : fixture.runs;
  result = { total_count: fixture.totalCount ?? runs.length, workflow_runs: runs };
} else if (path.includes("/jobs")) {
  const id = path.match(/\\/runs\\/(\\d+)\\//)[1];
  const jobs = fixture.jobs[id] ?? [];
  result = { total_count: jobs.length, jobs };
} else if (/\\/actions\\/runs\\/\\d+$/.test(path)) result = fixture.runs.find(run => path.endsWith("/" + run.id));
else throw new Error("Unexpected API route: " + path);
process.stdout.write(JSON.stringify(result));
`,
      { mode: 0o700 },
    );
    writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", workflow.jobs.check.steps[0].run], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: repo,
        GITHUB_EVENT_NAME: options.eventName ?? "pull_request",
        GITHUB_EVENT_PATH: join(directory, "event"),
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        HEAD_REF: currentPull.head.ref,
        HEAD_SHA: sha,
        FIXTURE: join(directory, "fixture"),
        POSTS: join(directory, "posts"),
      },
    });
    return {
      ...result,
      posts: existsSync(join(directory, "posts"))
        ? readFileSync(join(directory, "posts"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
      summary: existsSync(join(directory, "summary")) ? readFileSync(join(directory, "summary"), "utf8").trim() : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("PR staging acceptance status", () => {
  it("refreshes on controller requests, starts and completions without checking out candidate code", () => {
    const workflow = parse(readFileSync(".github/workflows/staging-status.yml", "utf8"));
    expect(workflow.on.workflow_run).toEqual({
      workflows: ["deploy staging"],
      types: ["requested", "in_progress", "completed"],
    });
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(workflow.jobs.check.steps).toHaveLength(1);
    const source = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    expect(workflow.concurrency.queue).toBe(source.jobs.deploy.concurrency.queue);
    expect(workflow.concurrency["cancel-in-progress"]).toBe(source.jobs.deploy.concurrency["cancel-in-progress"]);
    const name = source["run-name"].slice(3, -2);
    expect(
      Function(
        "github",
        `return (${name})`,
      )({ event_name: "pull_request_target", event: { action: "labeled", label: { name: "severity:medium" } } }),
    ).toBe("Staging label ignored");
    expect(
      Function(
        "github",
        `return (${name})`,
      )({ event_name: "pull_request_target", event: { action: "labeled", label: { name: "deploy:staging" } } }),
    ).toBe("Staging requested");
  });

  it("finishes ordinary PRs without writing a release status", () => {
    const result = execute({ currentPull: pull("feature/change") });
    expect(result.status, result.stderr).toBe(0);
    expect({ posts: result.posts, summary: result.summary }).toEqual({
      posts: [],
      summary: "Not required for an ordinary PR.",
    });
  });

  it.each([
    { status: "in_progress", conclusion: null, expected: "pending" },
    { status: "completed", conclusion: "cancelled", expected: "failure" },
    { status: "completed", conclusion: "success", expected: "failure" },
  ])("does not reuse an older success before the newest final job exists: $status $conclusion", (scenario) => {
    const newest = controller(20, { status: scenario.status, conclusion: scenario.conclusion });
    const result = execute({
      eventName: "workflow_run",
      event: { workflow_run: newest },
      runs: [newest, controller(10)],
      jobs: { "10": live() },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.posts.map((post) => post.state)).toEqual(["pending", scenario.expected]);
    expect(result.posts.map((post) => post.path)).toEqual([
      `repos/${repo}/statuses/${sha}`,
      `repos/${repo}/statuses/${sha}`,
    ]);
  });

  it.each(["success", "failure"])("refreshes a completed controller result without a PR event: %s", (conclusion) => {
    const newest = controller(20, { conclusion });
    const result = execute({
      eventName: "workflow_run",
      event: { workflow_run: newest },
      runs: [newest],
      jobs: { "20": live(conclusion) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.posts.map((post) => [post.context, post.state])).toEqual([
      ["staging / Review E2E", "pending"],
      ["staging / Review E2E", conclusion],
    ]);
  });

  it("uses a later attempt of an older run instead of sorting only by run id", () => {
    const rerun = controller(10, { run_attempt: 2, run_started_at: "2026-10-18T21:30:00Z" });
    const result = execute({
      eventName: "workflow_run",
      event: { workflow_run: rerun },
      runs: [controller(20, { conclusion: "failure" }), rerun],
      jobs: { "10": live(), "20": live("failure") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.posts.map((post) => post.state)).toEqual(["pending", "success"]);
    expect(result.posts[1].target_url).toBe("https://github.com/example/service/actions/runs/10/attempts/2");
  });

  it.each(["workflow_dispatch", "push"])("refuses a candidate-sourced success from %s", (event) => {
    const newest = controller(20, { event });
    const result = execute({
      eventName: "workflow_run",
      event: { workflow_run: newest },
      runs: [newest, controller(10)],
      jobs: { "20": live(), "10": live() },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.posts.map((post) => post.state)).toEqual(["pending", "failure"]);
  });

  it("ignores only a trusted run explicitly marked as an unrelated label", () => {
    const ignored = controller(20, { display_title: "Staging label ignored" });
    const result = execute({
      eventName: "workflow_run",
      event: { workflow_run: ignored },
      runs: [ignored, controller(10)],
      jobs: { "10": live() },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.posts.map((post) => post.state)).toEqual(["pending", "success"]);
  });

  it("does not accept another branch or head, or a truncated source history", () => {
    for (const options of [
      { runs: [controller(10, { head_sha: "b".repeat(40) })], exit: 0 },
      { runs: [controller(10, { head_branch: "feature/change" })], exit: 0 },
      { totalCount: 101, exit: 1 },
    ]) {
      const result = execute(options);
      expect(result.status, result.stderr).toBe(options.exit);
      expect(result.posts.map((post) => post.state)).toEqual(["pending", "failure"]);
    }
  });

  it("invalidates an earlier success before a source read fails", () => {
    const result = execute({ historyFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.posts.map((post) => post.state)).toEqual(["pending", "failure"]);
  });

  it("keeps a concurrent controller start pending instead of publishing the earlier success", () => {
    const result = execute({
      laterRuns: [controller(20, { status: "in_progress", conclusion: null }), controller(10)],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.posts.map((post) => post.state)).toEqual(["pending", "pending"]);
  });
});
