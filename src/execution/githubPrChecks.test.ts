import { describe, expect, it } from "vitest";
import { GithubPrChecksSource } from "./githubPrChecks.js";

const head = "a".repeat(40);
const merge = "b".repeat(40);
const check = (name: string, over: Record<string, unknown> = {}) => ({
  __typename: "CheckRun",
  id: name,
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  isRequired: false,
  detailsUrl: "https://ci.example.com/job/1",
  title: "Tests passed",
  checkSuite: {
    app: { databaseId: 1, name: "CI", logoUrl: "https://avatars.githubusercontent.com/in/1" },
    workflowRun: { event: "pull_request", workflow: { name: "ci" } },
  },
  ...over,
});
const connection = (nodes: unknown[], more = false) => ({
  nodes,
  totalCount: nodes.length,
  pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
});
const commit = (oid: string, nodes: unknown[], more = false) => ({
  oid,
  statusCheckRollup: { contexts: connection(nodes, more) },
});
const pr = (over: Record<string, unknown> = {}) => ({
  headRefOid: head,
  baseRefName: "main",
  baseRefOid: "c".repeat(40),
  state: "OPEN",
  merged: false,
  baseRef: { branchProtectionRule: { requiredStatusChecks: [{ context: "missing", app: null }] } },
  commits: { nodes: [{ commit: commit(head, [check("test")]) }] },
  potentialMergeCommit: null,
  ...over,
});
function setup(answers: unknown[], rules: unknown = [], ruleStatus = 200) {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let previous: unknown;
  const source = new GithubPrChecksSource({
    token: async () => "test-token",
    clock: () => 1000,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.includes("/rules/branches/")) return Response.json(rules, { status: ruleStatus });
      const answer = answers.shift() ?? previous;
      previous = answer;
      if (answer instanceof Error) throw answer;
      return Response.json(answer);
    },
  });
  return { source, calls };
}

describe("GitHub PR checks", () => {
  it("assigns stable opaque identities to expected checks from protection and rulesets", async () => {
    const name = "PLANTED-FREE-TEXT-5b7e";
    const pullRequest = pr({
      baseRef: { branchProtectionRule: { requiredStatusChecks: [{ context: name, app: null }] } },
      commits: { nodes: [{ commit: commit(head, []) }] },
    });
    const rules = [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: name, integration_id: 2 }] },
      },
    ];
    const first = setup([{ data: { repository: { pullRequest } } }], rules);
    const checks = (await first.source.read("acme/api", 7)).checks;
    expect(checks).toEqual([
      {
        id: "expected:58a91cf0cfd812f3f46dddfbb06f1f24eab4ccf3d63385bd967aea92a34da173",
        name,
        status: "expected",
        required: true,
        description: "Expected — Waiting for status to be reported",
      },
      {
        id: "expected:2e2b47f6a11a861a3d611ebb2437ca1f22ba2d14dc4c6e75d5f01c749a082e9f",
        name,
        status: "expected",
        required: true,
        description: "Expected — Waiting for status to be reported",
      },
    ]);
    const reordered = setup(
      [{ data: { repository: { pullRequest: { ...pullRequest, baseRef: null } } } }],
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: name, integration_id: 2 }, { context: name }] },
        },
      ],
    );
    expect((await reordered.source.read("acme/api", 7)).checks).toEqual([...checks].reverse());
  });

  it("keeps an expected requirement when only a manual Actions job has passed", async () => {
    const { source } = setup(
      [
        {
          data: {
            repository: {
              pullRequest: pr({
                baseRef: null,
                commits: {
                  nodes: [
                    {
                      commit: commit(head, [
                        check("test", {
                          checkSuite: {
                            app: { databaseId: 15368, name: "GitHub Actions", logoUrl: null },
                            workflowRun: { event: "workflow_dispatch", workflow: { name: "ci" } },
                          },
                        }),
                      ]),
                    },
                  ],
                },
              }),
            },
          },
        },
      ],
      [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "test", integration_id: 15368 }] },
        },
      ],
    );
    expect((await source.read("acme/api", 7)).checks.map((c) => [c.name, c.status, c.required])).toEqual([
      ["ci / test", "success", false],
      ["test", "expected", true],
    ]);
  });

  it("retains ruleset expectations with provider restrictions and accepts rules without parameters", async () => {
    const { source } = setup(
      [
        {
          data: {
            repository: {
              pullRequest: pr({
                commits: { nodes: [{ commit: commit(head, [check("test", { isRequired: true })]) }] },
              }),
            },
          },
        },
      ],
      [
        { type: "deletion", parameters: null },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "test", integration_id: 2 },
              { context: "deploy", integration_id: null },
            ],
          },
        },
      ],
    );
    expect((await source.read("acme/api", 7)).checks.map((c) => [c.name, c.status, c.required])).toEqual([
      ["ci / test", "success", true],
      ["missing", "expected", true],
      ["test", "expected", true],
      ["deploy", "expected", true],
    ]);
  });
  it("combines checks and legacy statuses, keeps required flags, and includes missing required checks", async () => {
    const { source } = setup([
      {
        data: {
          repository: {
            pullRequest: pr({
              commits: {
                nodes: [
                  {
                    commit: commit(head, [
                      check("test", { isRequired: true }),
                      {
                        __typename: "StatusContext",
                        id: "external",
                        context: "external",
                        state: "PENDING",
                        isRequired: false,
                        description: "Waiting",
                        targetUrl: "javascript:alert(1)",
                      },
                    ]),
                  },
                ],
              },
            }),
          },
        },
      },
    ]);
    expect(await source.read("acme/api", 7)).toMatchObject({
      headSha: head,
      checkedSha: head,
      checkedAt: 1000,
      warnings: [],
      checks: [
        { id: "test", name: "ci / test", status: "success", required: true, provider: "CI" },
        { id: "external", name: "external", status: "pending", required: false, description: "Waiting" },
        { name: "missing", status: "expected", required: true },
      ],
    });
    expect((await source.read("acme/api", 7)).checks[1]).not.toHaveProperty("url");
  });
  it("uses the test merge commit when it has checks, and reads every page", async () => {
    const { source, calls } = setup([
      {
        data: {
          repository: {
            pullRequest: pr({
              potentialMergeCommit: commit(merge, [check("merge", { status: "IN_PROGRESS", conclusion: null })], true),
            }),
          },
        },
      },
      { data: { repository: { object: commit(merge, [check("last", { conclusion: "FAILURE" })]) } } },
      { data: { repository: { pullRequest: pr({ potentialMergeCommit: { oid: merge } }) } } },
    ]);
    const result = await source.read("acme/api", 7);
    expect(result.checkedSha).toBe(merge);
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ["ci / merge", "in_progress"],
      ["ci / last", "failure"],
      ["missing", "expected"],
    ]);
    expect(calls[1].body?.variables).toMatchObject({ sha: merge, after: "next" });
  });
  it("rejects mixed revisions and never presents an unreadable rules response as complete", async () => {
    const moved = setup([
      {
        data: {
          repository: { pullRequest: pr({ commits: { nodes: [{ commit: commit(head, [check("test")], true) }] } }) },
        },
      },
      { data: { repository: { object: commit(head, [check("last")]) } } },
      { data: { repository: { pullRequest: pr({ headRefOid: merge }) } } },
    ]);
    await expect(moved.source.read("acme/api", 7)).rejects.toThrow("changed while checks were read");
    const partial = setup([{ data: { repository: { pullRequest: pr() } } }], {}, 403);
    expect(await partial.source.read("acme/api", 7)).toMatchObject({
      warnings: ["Required checks could not be fully read."],
      checks: [{ status: "success" }, { status: "expected" }],
    });
  });
  it("coalesces reads and propagates GitHub errors", async () => {
    const { source, calls } = setup([{ data: { repository: { pullRequest: pr() } } }]);
    const results = await Promise.all([source.read("acme/api", 7), source.read("acme/api", 7)]);
    expect(results[0]).toEqual(results[1]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/graphql",
      "https://api.github.com/repos/acme/api/rules/branches/main?per_page=100",
      "https://api.github.com/graphql",
    ]);
    const broken = setup([{ errors: [{ message: "private upstream detail" }] }]);
    await expect(broken.source.read("acme/api", 7)).rejects.toThrow("GitHub checks could not be read");
  });
  it("respects GitHub's rate-limit wait before another API read", async () => {
    let now = 1000;
    let requests = 0;
    const source = new GithubPrChecksSource({
      clock: () => now,
      token: async () => "test-token",
      fetch: async () => {
        requests++;
        return Response.json({}, { status: 429, headers: { "retry-after": "120" } });
      },
    });
    await expect(source.read("acme/api", 7)).rejects.toThrow("rate limit");
    now += 30_000;
    await expect(source.read("acme/api", 7)).rejects.toThrow("rate limit");
    expect(requests).toBe(1);
    now += 100_000;
    await expect(source.read("acme/api", 7)).rejects.toThrow("rate limit");
    expect(requests).toBe(2);
    let graphqlReads = 0;
    const graphqlLimited = new GithubPrChecksSource({
      clock: () => now,
      token: async () => "test-token",
      fetch: async () => {
        graphqlReads++;
        return Response.json({ errors: [{ type: "RATE_LIMITED" }] });
      },
    });
    await expect(graphqlLimited.read("acme/api", 7)).rejects.toThrow("rate limit");
    now += 30_000;
    await expect(graphqlLimited.read("acme/api", 7)).rejects.toThrow("rate limit");
    expect(graphqlReads).toBe(1);
  });
});
