import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import { GitBindings } from "../core/modelProxy/gitBindings.js";
import { createGithubDoorHandler } from "./githubDoor.js";

const grant = {
  runId: "12345678-1234-1234-1234-123456789abc",
  modelRef: "x/y",
  providerName: "x",
  providerWire: "openai-chat" as const,
  model: "y",
  maxTokens: 100,
  maxTurns: 10,
  expiresAt: 2_000,
  span: {} as never,
  publish: () => {},
  github: { identity: "write" as const, repo: "o/r", ref: "fix" },
};

async function fixture(bindings?: GitBindings) {
  const bearers = new RunBearerStore({ clock: () => 1_000 });
  const bearer = bearers.mint(grant);
  const upstream = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("info/refs")) {
      const line = Buffer.from(`${"1".repeat(40)} refs/heads/main\0report-status side-band-64k push-options\n`);
      const pkt = Buffer.concat([
        Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
        line,
        Buffer.from("0000"),
      ]);
      return new Response(pkt, { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
    }
    return new Response(JSON.stringify({ full_name: "o/r", default_branch: "main" }), {
      headers: { "content-type": "application/json" },
    });
  });
  const handler = createGithubDoorHandler({
    bearers,
    bindings,
    fetcher: upstream,
    token: async (scope, repo) => `${scope}:${repo ?? "all"}`,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("missing server port");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    bearer,
    bearers,
    upstream,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("GitHub run-bearer door", () => {
  it("rejects oversized credentials and refuses upstream redirects without forwarding the bearer", async () => {
    const f = await fixture();
    try {
      const oversized = await fetch(`${f.url}/api/v3/repos/o/r`, {
        headers: { authorization: `token ${"x".repeat(2050)}` },
      });
      expect(oversized.status).toBe(401);
      expect(f.upstream).not.toHaveBeenCalled();
      f.upstream.mockImplementationOnce(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://outside.example/private" },
          }),
      );
      const redirect = await fetch(`${f.url}/api/v3/repos/o/r`, {
        headers: { authorization: `token ${f.bearer}` },
      });
      expect(redirect.status).toBe(502);
      expect(redirect.headers.get("location")).toBeNull();
      expect(f.upstream.mock.calls.at(-1)?.[1]).toMatchObject({ redirect: "manual" });
    } finally {
      await f.close();
    }
  });

  it("forwards read API with a trusted-side token and refuses API writes", async () => {
    const f = await fixture();
    try {
      const ok = await fetch(`${f.url}/api/v3/repos/o/r`, { headers: { authorization: `token ${f.bearer}` } });
      expect(ok.status).toBe(200);
      expect(f.upstream).toHaveBeenCalledWith(
        "https://api.github.com/repos/o/r",
        expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer read:o/r" }) }),
      );
      const count = f.upstream.mock.calls.length;
      const denied = await fetch(`${f.url}/api/v3/repos/o/r`, {
        method: "PATCH",
        headers: { authorization: `token ${f.bearer}` },
      });
      expect(denied.status).toBe(405);
      expect(f.upstream).toHaveBeenCalledTimes(count);
      f.bearers.revoke(grant.runId);
      expect(
        (await fetch(`${f.url}/api/v3/repos/o/r`, { headers: { authorization: `token ${f.bearer}` } })).status,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });

  it("refuses REST reads outside the run's repository before any upstream call", async () => {
    const f = await fixture();
    try {
      for (const path of ["/api/v3/repos/o/other/issues", "/api/v3/search/issues?q=repo%3Ao%2Fother"]) {
        const response = await fetch(`${f.url}${path}`, { headers: { authorization: `token ${f.bearer}` } });
        expect(response.status).toBe(403);
      }
      const unbound = f.bearers.mint({
        ...grant,
        runId: "12345678-1234-1234-1234-123456789abd",
        github: { identity: "write" },
      });
      const noTarget = await fetch(`${f.url}/api/v3/repos/o/r`, { headers: { authorization: `token ${unbound}` } });
      expect(noTarget.status).toBe(403);
      expect(f.upstream).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("refuses Git discovery without a repository authorized by dispatch", async () => {
    const f = await fixture();
    try {
      const unbound = f.bearers.mint({
        ...grant,
        runId: "12345678-1234-1234-1234-123456789abe",
        github: { identity: "write" },
      });
      const auth = `Basic ${Buffer.from(`x-access-token:${unbound}`).toString("base64")}`;
      for (const service of ["git-upload-pack", "git-receive-pack"]) {
        const response = await fetch(`${f.url}/git/o/r.git/info/refs?service=${service}`, {
          headers: { authorization: auth },
        });
        expect(response.status).toBe(403);
      }
      expect(f.upstream).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("forwards only a GraphQL read rooted in the bound repository", async () => {
    const f = await fixture();
    const graphql = async (query: string, variables?: Record<string, unknown>) =>
      fetch(`${f.url}/api/graphql`, {
        method: "POST",
        headers: { authorization: `token ${f.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    try {
      const allowed = await graphql(
        "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}",
        { owner: "o", name: "r" },
      );
      expect(allowed.status).toBe(200);
      expect(f.upstream).toHaveBeenCalledWith(
        "https://api.github.com/graphql",
        expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer read:o/r" }) }),
      );
      const withFragment = await graphql(
        "query Named($owner:String!,$name:String!){repo:repository(owner:$owner,name:$name){...RepoBits}} fragment RepoBits on Repository { nameWithOwner }",
        { owner: "o", name: "r" },
      );
      expect(withFragment.status).toBe(200);
      const pullRead = await graphql(
        'query { repository(owner:"o",name:"r") { pullRequest(number:1) { repository { nameWithOwner } reviews(first:5) { nodes { body } } } } }',
      );
      expect(pullRead.status).toBe(200);
      const cliRead = await graphql(
        "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewRequests(first:100){nodes{requestedReviewer{... on Team {organization{login}}}}} reviews(first:100){nodes{body}} comments(first:100){nodes{body}}}}}",
        { owner: "o", repo: "r", number: 1 },
      );
      expect(cliRead.status).toBe(200);
      const forkMetadata = await graphql(
        'query { repository(owner:"o",name:"r") { pullRequest(number:1) { headRepository { nameWithOwner owner { login } } } } }',
      );
      expect(forkMetadata.status).toBe(200);
      const issueRead = await graphql(
        "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){hasIssuesEnabled issue:issueOrPullRequest(number:$number){__typename ... on Issue { parent{id number title url state repository{nameWithOwner}} subIssues(first:10){nodes{id number title url state repository{nameWithOwner}} totalCount} blockedBy(first:10){nodes{id number title url state repository{nameWithOwner}} totalCount} blocking(first:10){nodes{id number title url state repository{nameWithOwner}} totalCount} }}}}",
        { owner: "o", repo: "r", number: 1 },
      );
      expect(issueRead.status).toBe(200);
      const checksRead = await graphql(
        'query { repository(owner:"o",name:"r") { pullRequest(number:1) { statusCheckRollup:commits(first:1) { nodes { commit { statusCheckRollup { contexts { nodes { __typename ... on CheckRun { name status conclusion checkSuite { workflowRun { workflow { name } } } } } pageInfo { hasNextPage endCursor } } } } } } } } }',
      );
      expect(checksRead.status).toBe(200);
      const count = f.upstream.mock.calls.length;
      for (const [query, variables] of [
        [
          "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner}}",
          { owner: "o", name: "other" },
        ],
        ['query { foreign:repository(owner:"o",name:"other") { nameWithOwner } }', {}],
        ['query { ...F } fragment F on Query { repository(owner:"o",name:"other") { nameWithOwner } }', {}],
        ['query { repository(owner:"o",name:"r") { owner { repository(name:"other") { name } } } }', {}],
        ['query { repository(owner:"o",name:"r") { owner { projectsV2(first:10) { nodes { id } } } } }', {}],
        [
          'query { repository(owner:"o",name:"r") { forks(first:10) { nodes { issues(first:10) { nodes { title } } } } } }',
          {},
        ],
        [
          'query { repository(owner:"o",name:"r") { pullRequest(number:1) { headRepository { issues(first:10) { nodes { title } } } } } }',
          {},
        ],
        [
          'query { repository(owner:"o",name:"r") { pullRequest(number:1) { commits(first:1) { nodes { commit { repository { issues(first:1) { nodes { title } } } } } } } } }',
          {},
        ],
        [
          'query { repository(owner:"o",name:"r") { pullRequest(number:1) { commits(first:1) { nodes { commit { comments(first:1) { nodes { body } } } } } } } }',
          {},
        ],
        [
          'query { repository(owner:"o",name:"r") { issueOrPullRequest(number:1) { ... on Issue { parent { body } } } } }',
          {},
        ],
        ['query { repository(owner:"o",name:"r") { vulnerabilityAlerts(first:1) { nodes { id } } } }', {}],
        [
          'query { repository(owner:"o",name:"r") { ...Escape } } fragment Escape on Repository { owner { repository(name:"other") { name } } }',
          {},
        ],
        [
          'query { repository(owner:"o",name:"r") { name } } query Other { repository(owner:"o",name:"other") { name } }',
          {},
        ],
        ['query { repository(owner:"o",name:"r") { name }', {}],
        ['query { node(id:"foreign") { id } }', {}],
        ['mutation { createIssue(input:{repositoryId:"foreign",title:"x"}) { clientMutationId } }', {}],
      ] as const) {
        const response = await graphql(query, variables);
        expect(response.status).toBe(403);
      }
      expect(f.upstream).toHaveBeenCalledTimes(count);
    } finally {
      await f.close();
    }
  });

  it("checks run identity and bound ref before forwarding receive-pack", async () => {
    const f = await fixture();
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const discovery = await fetch(`${f.url}/git/o/r.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: auth },
      });
      expect(discovery.status).toBe(200);
      expect(Buffer.from(await discovery.arrayBuffer()).toString()).not.toContain("push-options");
      const old = "1".repeat(40),
        next = "2".repeat(40);
      const line = Buffer.from(`${old} ${next} refs/heads/main\0report-status side-band-64k`);
      const body = Buffer.concat([
        Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
        line,
        Buffer.from("0000PACK"),
      ]);
      const count = f.upstream.mock.calls.length;
      const denied = await fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      expect(denied.status).toBe(200);
      expect(await denied.text()).toContain("default branch push refused");
      expect(f.upstream).toHaveBeenCalledTimes(count + 1);
      expect(f.upstream.mock.calls.at(-1)?.[0]).toBe("https://api.github.com/repos/o/r");
    } finally {
      await f.close();
    }
  });

  it("keeps a rejected first branch creation create-only until Git confirms it", async () => {
    const bindings = new GitBindings();
    const f = await fixture(bindings);
    const runId = "12345678-1234-1234-1234-123456789abf";
    expect(bindings.register(runId, { repo: "o/r" }, undefined, async () => true)).toBe(true);
    const bearer = f.bearers.mint({ ...grant, runId, github: { identity: "write", repo: "o/r" } });
    const auth = `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`;
    const ref = "refs/heads/existing";
    const packet = (line: string) => {
      const bytes = Buffer.from(line);
      return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
    };
    const body = (old: string) =>
      Buffer.concat([packet(`${old} ${"2".repeat(40)} ${ref}\0report-status`), Buffer.from("0000PACK")]);
    const report = (result: string) =>
      new Response(Buffer.concat([packet("unpack ok\n"), packet(`${result} ${ref}\n`), Buffer.from("0000")]), {
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    let pushes = 0;
    f.upstream.mockImplementation(async (url: string) => {
      if (url.endsWith("git-receive-pack")) return report(++pushes === 1 ? "ng" : "ok");
      return new Response(JSON.stringify({ default_branch: "main" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const push = (old: string) =>
      fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body: body(old),
      });
    try {
      expect(await (await push("0".repeat(40))).text()).toContain(`ng ${ref}`);
      expect(bindings.get(runId)).toMatchObject({ ref, refConfirmed: false });
      const pending = bindings.get(runId);
      bindings.unregister(runId);
      expect(bindings.register(runId, { repo: "o/r" }, pending, async () => true)).toBe(true);
      expect(await (await push("1".repeat(40))).text()).toContain("first push must create a new branch");
      expect(pushes).toBe(1);
      expect(await (await push("0".repeat(40))).text()).toContain(`ok ${ref}`);
      expect(bindings.get(runId)).toMatchObject({ ref, refConfirmed: true });
      const confirmed = bindings.get(runId);
      bindings.unregister(runId);
      expect(bindings.register(runId, { repo: "o/r" }, confirmed, async () => true)).toBe(true);
      expect(await (await push("1".repeat(40))).text()).toContain(`ok ${ref}`);
      expect(pushes).toBe(3);
    } finally {
      await f.close();
    }
  });

  it("accepts gh clone's unprefixed Git path and forwards with a read token", async () => {
    const f = await fixture();
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const response = await fetch(`${f.url}/o/r.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: auth },
      });
      expect(response.status).toBe(200);
      expect(f.upstream.mock.calls.at(-1)?.[0]).toBe("https://github.com/o/r.git/info/refs?service=git-upload-pack");
      expect(f.upstream.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
        authorization: expect.stringMatching(/^Basic /),
      });
    } finally {
      await f.close();
    }
  });

  it("keeps paginated API reads on the door instead of sending its bearer to GitHub", async () => {
    const f = await fixture();
    try {
      f.upstream.mockImplementationOnce(
        async () =>
          new Response("[]", {
            headers: {
              link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
              "content-type": "application/json",
            },
          }),
      );
      const res = await fetch(`${f.url}/api/v3/repos/o/r/issues?page=1`, {
        headers: { authorization: `token ${f.bearer}` },
      });
      expect(res.headers.get("link")).toBe(
        `<http://${new URL(f.url).host}/api/v3/repos/o/r/issues?page=2>; rel="next"`,
      );
    } finally {
      await f.close();
    }
  });
});
