import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { bearerHashOf, RunBearerStore } from "../core/modelProxy/runBearers.js";
import { GIT_RECEIVE_PACK_FORWARD_TIMEOUT_MS } from "../core/budgets.js";
import { GitBindings } from "../core/modelProxy/gitBindings.js";
import { createGithubDoorHandler, type GithubDoorDeps } from "./githubDoor.js";

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

async function fixture(bindings?: GitBindings, token?: GithubDoorDeps["token"]) {
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
    token: token ?? (async (scope, repo) => `${scope}:${repo ?? "all"}`),
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
  const allowBranchReceipt = (bindings: GitBindings, runId: string) =>
    bindings.setBranchRecorder(runId, { begin: async () => true, finish: async () => true });
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

  it("holds an existing PR behind fresh authority and refuses a stale old head at the HTTP door", async () => {
    const bindings = new GitBindings();
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true)).toBe(true);
    const f = await fixture(bindings);
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
    const push = (head: string) => {
      const line = Buffer.from(`${head} ${next} refs/heads/fix\0report-status`);
      const body = Buffer.concat([
        Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
        line,
        Buffer.from("0000PACK"),
      ]);
      return fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
    };
    try {
      expect((await push(old)).status).toBe(403);
      expect(f.upstream).not.toHaveBeenCalled();
      expect(bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old })).toBe(true);
      const stale = await push("3".repeat(40));
      expect(await stale.text()).toContain("existing PR head differs from the authorized lease");
      expect(f.upstream.mock.calls.some(([url]) => url === "https://github.com/o/r.git/git-receive-pack")).toBe(false);
      const begin = vi.fn(async () => true);
      const finish = vi.fn(async () => true);
      expect(bindings.setPublicationRecorder(grant.runId, { begin, finish })).toBe(true);
      f.upstream.mockImplementation(async (url: string) => {
        if (url === "https://api.github.com/repos/o/r")
          return new Response(JSON.stringify({ default_branch: "main" }), {
            headers: { "content-type": "application/json" },
          });
        const report = (line: string) => {
          const bytes = Buffer.from(line);
          return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
        };
        return new Response(
          Buffer.concat([report("unpack ok\n"), report("ok refs/heads/fix\n"), Buffer.from("0000")]),
          {
            headers: { "content-type": "application/x-git-receive-pack-result" },
          },
        );
      });
      expect((await push(old)).status).toBe(200);
      expect(f.upstream.mock.calls.some(([url]) => url === "https://github.com/o/r.git/git-receive-pack")).toBe(true);
      expect(begin).toHaveBeenCalledWith({ old, next, ref: "refs/heads/fix" });
      expect(finish).toHaveBeenCalledWith({ old, next, ref: "refs/heads/fix" }, "accepted");
      expect(bindings.publicationOf(grant.runId)).toEqual({ ref: "fix", expectedHeadSha: next });
    } finally {
      await f.close();
    }
  });

  it("requires a source-bound harness authorization before forwarding even an owned receive-pack", async () => {
    const bindings = new GitBindings();
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true);
    bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old });
    bindings.setPublicationRecorder(grant.runId, { begin: async () => true, finish: async () => true });
    bindings.requireToolPush(grant.runId);
    const f = await fixture(bindings);
    const line = Buffer.from(`${old} ${next} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
    const send = () =>
      fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
    try {
      expect((await send()).status).toBe(403);
      expect(
        (
          await fetch(`${f.url}/git/o/r.git/info/refs?service=git-receive-pack`, {
            headers: { authorization: auth },
          })
        ).status,
      ).toBe(403);
      expect(f.upstream).not.toHaveBeenCalled();
      bindings.allowToolPush(grant.runId, "literal", { ref: "refs/heads/fix", old, next }, bearerHashOf(f.bearer));
      const pkt = (line: string) =>
        Buffer.concat([Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")), Buffer.from(line)]);
      f.upstream.mockImplementation(async (url: string) =>
        url.includes("/repos/o/r")
          ? new Response(JSON.stringify({ default_branch: "main" }))
          : new Response(Buffer.concat([pkt("unpack ok\n"), pkt("ok refs/heads/fix\n"), Buffer.from("0000")]), {
              headers: { "content-type": "application/x-git-receive-pack-result" },
            }),
      );
      expect((await send()).status).toBe(200);
      const replay = await send();
      expect(replay.status).toBe(403);
      expect(await replay.text()).toContain("bound harness push is required");
      expect(f.upstream.mock.calls.filter(([url]) => url.endsWith("git-receive-pack"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("treats only an authorized exact EOF flush as a no-op and leaves command fences intact", async () => {
    const bindings = new GitBindings();
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old })).toBe(true);
    const begin = vi.fn(async () => true);
    const finish = vi.fn(async () => true);
    expect(bindings.setPublicationRecorder(grant.runId, { begin, finish })).toBe(true);
    expect(bindings.requireToolPush(grant.runId)).toBe(true);
    const f = await fixture(bindings);
    const effect = f.bearers.issue(grant.runId)!.token;
    expect(
      bindings.allowToolPush(grant.runId, "effect", { ref: "refs/heads/fix", old, next }, bearerHashOf(effect)),
    ).toBe(true);
    const path = `${f.url}/git/o/r.git/git-receive-pack`;
    const auth = (bearer: string) => `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`;
    const send = (body: BodyInit, credential = effect, target = path, duplex = false) =>
      fetch(target, {
        method: "POST",
        headers: { authorization: auth(credential), "content-type": "application/x-git-receive-pack-request" },
        body,
        ...(duplex ? { duplex: "half" } : {}),
      } as RequestInit);
    const line = (from: string, to: string, ref: string) => {
      const command = Buffer.from(`${from} ${to} ${ref}\0report-status`);
      return Buffer.concat([
        Buffer.from((command.length + 4).toString(16).padStart(4, "0")),
        command,
        Buffer.from("0000PACK"),
      ]);
    };
    try {
      expect((await send("0000", "wrong-secret")).status).toBe(401);
      expect((await send("0000", f.bearer)).status).toBe(403); // same run, model credential
      const readerId = "12345678-1234-1234-1234-123456789abd";
      const reader = f.bearers.mint({ ...grant, runId: readerId, github: { identity: "read", repo: "o/r" } });
      expect(bindings.register(readerId, { repo: "o/r" }, undefined)).toBe(true);
      expect((await send("0000", reader)).status).toBe(403);
      expect((await send("0000", effect, `${f.url}/git/o/other.git/git-receive-pack`)).status).toBe(403);
      for (const trailing of ["0000PACK", "00000000", "00gg", "000", "0001"]) {
        expect((await send(trailing)).status).toBe(400);
      }
      const split = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("00"));
          controller.enqueue(Buffer.from("00"));
          controller.close();
        },
      });
      const probe = await send(split, effect, path, true);
      expect(probe.status).toBe(200);
      expect(probe.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
      expect(await probe.text()).toBe("0000");
      expect((await send("0000")).status).toBe(200);
      for (const command of [line("3".repeat(40), next, "refs/heads/fix"), line(old, next, "refs/heads/other")]) {
        const denied = await send(command);
        expect(denied.status).toBe(200);
        expect(await denied.text()).toContain("ng refs/heads/");
      }
      expect((await send(line(old, "4".repeat(40), "refs/heads/fix"))).status).toBe(403);
      expect(bindings.hasToolPush(grant.runId, bearerHashOf(effect))).toBe(true);
      expect(begin).not.toHaveBeenCalled();
      expect(f.upstream.mock.calls.filter(([url]) => url.endsWith("/git-receive-pack"))).toHaveLength(0);
      const revokedId = "12345678-1234-1234-1234-123456789abe";
      const revoked = f.bearers.mint({ ...grant, runId: revokedId });
      f.bearers.revoke(revokedId);
      expect((await send("0000", revoked)).status).toBe(403);
      bindings.setPublication(grant.runId, { blocked: "publication held" });
      expect((await send("0000")).status).toBe(403);
      expect(begin).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("refuses a concurrent model bearer even when a typed effect owns the same one-use ref/source slot", async () => {
    const bindings = new GitBindings();
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true);
    bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old });
    bindings.setPublicationRecorder(grant.runId, { begin: async () => true, finish: async () => true });
    bindings.requireToolPush(grant.runId);
    const f = await fixture(bindings);
    const effect = f.bearers.issue(grant.runId)!.token;
    const line = Buffer.from(`${old} ${next} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    const send = (bearer: string) =>
      fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`,
          "content-type": "application/x-git-receive-pack-request",
        },
        body,
      });
    try {
      expect(
        bindings.allowToolPush(grant.runId, "effect", { ref: "refs/heads/fix", old, next }, bearerHashOf(effect)),
      ).toBe(true);
      expect((await send(f.bearer)).status).toBe(403);
      expect(
        (
          await fetch(`${f.url}/git/o/r.git/info/refs?service=git-receive-pack`, {
            headers: { authorization: `Bearer ${f.bearer}` },
          })
        ).status,
      ).toBe(403);
      expect(bindings.hasToolPush(grant.runId, bearerHashOf(effect))).toBe(true);
      const pkt = (value: string) =>
        Buffer.concat([Buffer.from((Buffer.byteLength(value) + 4).toString(16).padStart(4, "0")), Buffer.from(value)]);
      f.upstream.mockImplementation(async (url: string) =>
        url.includes("/repos/o/r")
          ? new Response(JSON.stringify({ default_branch: "main" }))
          : new Response(Buffer.concat([pkt("unpack ok\n"), pkt("ok refs/heads/fix\n"), Buffer.from("0000")]), {
              headers: { "content-type": "application/x-git-receive-pack-result" },
            }),
      );
      expect((await send(effect)).status).toBe(200);
      expect((await send(f.bearer)).status).toBe(403);
      expect(f.upstream.mock.calls.filter(([url]) => url.endsWith("git-receive-pack"))).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("refuses an existing PR push without a trusted durable receipt writer", async () => {
    const bindings = new GitBindings();
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true)).toBe(true);
    const old = "1".repeat(40);
    expect(bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old })).toBe(true);
    const f = await fixture(bindings);
    const line = Buffer.from(`${old} ${"2".repeat(40)} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const response = await fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      expect(response.status).toBe(403);
      expect(f.upstream.mock.calls.some(([url]) => url === "https://github.com/o/r.git/git-receive-pack")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("refuses a branch push without a durable receipt writer", async () => {
    const bindings = new GitBindings();
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined)).toBe(true);
    const f = await fixture(bindings);
    const line = Buffer.from(`${"1".repeat(40)} ${"2".repeat(40)} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const response = await fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      expect(response.status).toBe(403);
      expect(f.upstream.mock.calls.some(([url]) => url === "https://github.com/o/r.git/git-receive-pack")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("withholds an accepted existing-PR push when its durable outcome fails and blocks another write", async () => {
    const bindings = new GitBindings();
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old })).toBe(true);
    const begin = vi.fn(async () => true);
    const finish = vi.fn(async () => false);
    expect(bindings.setPublicationRecorder(grant.runId, { begin, finish })).toBe(true);
    const f = await fixture(bindings);
    const line = Buffer.from(`${old} ${next} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    const pkt = (line: string) => {
      const bytes = Buffer.from(line);
      return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
    };
    f.upstream.mockImplementation(async (url: string) =>
      url === "https://api.github.com/repos/o/r"
        ? new Response(JSON.stringify({ default_branch: "main" }))
        : new Response(Buffer.concat([pkt("unpack ok\n"), pkt("ok refs/heads/fix\n"), Buffer.from("0000")]), {
            headers: { "content-type": "application/x-git-receive-pack-result" },
          }),
    );
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const push = () =>
        fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
          body,
        });
      expect((await push()).status).toBe(503);
      expect(begin).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledWith({ old, next, ref: "refs/heads/fix" }, "accepted");
      expect(bindings.publicationOf(grant.runId)).toMatchObject({ blocked: expect.any(String) });
      expect((await push()).status).toBe(403);
      expect(
        f.upstream.mock.calls.filter(([url]) => url === "https://github.com/o/r.git/git-receive-pack"),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("attributes a one-use forwarded push after revocation under a bounded request", async () => {
    const bindings = new GitBindings();
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined, undefined, true)).toBe(true);
    expect(bindings.setPublication(grant.runId, { ref: "fix", expectedHeadSha: old })).toBe(true);
    const begin = vi.fn(async () => true);
    const finish = vi.fn(async () => true);
    expect(bindings.setPublicationRecorder(grant.runId, { begin, finish })).toBe(true);
    const f = await fixture(bindings);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let enteredForward!: () => void;
    const forwarding = new Promise<void>((resolve) => (enteredForward = resolve));
    let releaseForward!: () => void;
    const held = new Promise<void>((resolve) => (releaseForward = resolve));
    let forwardSignal: AbortSignal | undefined;
    const pkt = (line: string) => {
      const bytes = Buffer.from(line);
      return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
    };
    f.upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "https://api.github.com/repos/o/r") return new Response(JSON.stringify({ default_branch: "main" }));
      forwardSignal = init?.signal ?? undefined;
      enteredForward();
      await held;
      return new Response(Buffer.concat([pkt("unpack ok\n"), pkt("ok refs/heads/fix\n"), Buffer.from("0000")]), {
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    });
    const line = Buffer.from(`${old} ${next} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const pending = fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      await forwarding;
      expect(begin).toHaveBeenCalledWith({ old, next, ref: "refs/heads/fix" });
      expect(forwardSignal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(GIT_RECEIVE_PACK_FORWARD_TIMEOUT_MS);
      f.bearers.revoke(grant.runId);
      expect(bindings.setPublication(grant.runId, { blocked: "run ended" })).toBe(true);
      releaseForward();
      expect((await pending).status).toBe(200);
      expect(finish).toHaveBeenCalledWith({ old, next, ref: "refs/heads/fix" }, "accepted");
      expect(bindings.publicationOf(grant.runId)).toEqual({ blocked: "run ended" });
    } finally {
      releaseForward();
      timeout.mockRestore();
      await f.close();
    }
  });

  it("bounds a first-branch receive-pack forward without changing its branch identity", async () => {
    const bindings = new GitBindings();
    expect(bindings.register(grant.runId, { repo: "o/r" }, undefined, async () => true)).toBe(true);
    expect(allowBranchReceipt(bindings, grant.runId)).toBe(true);
    const f = await fixture(bindings);
    const bearer = f.bearers.mint({ ...grant, github: { identity: "write", repo: "o/r" } });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const ref = "refs/heads/unit-branch";
    const pkt = (line: string) => {
      const bytes = Buffer.from(line);
      return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
    };
    f.upstream.mockImplementation(async (url: string) => {
      if (url === "https://api.github.com/repos/o/r") return new Response(JSON.stringify({ default_branch: "main" }));
      return new Response(Buffer.concat([pkt("unpack ok\n"), pkt(`ok ${ref}\n`), Buffer.from("0000")]), {
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    });
    const line = Buffer.from(`${"0".repeat(40)} ${"2".repeat(40)} ${ref}\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`;
      const result = await fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      expect(result.status).toBe(200);
      expect(bindings.get(grant.runId)).toMatchObject({ ref, refConfirmed: true });
      expect(timeout).toHaveBeenCalledWith(GIT_RECEIVE_PACK_FORWARD_TIMEOUT_MS);
      expect(
        f.upstream.mock.calls.find(([url]) => url === "https://github.com/o/r.git/git-receive-pack")?.[1]?.signal,
      ).toBeInstanceOf(AbortSignal);
    } finally {
      timeout.mockRestore();
      await f.close();
    }
  });

  it("leaves a first branch create-only when its bounded receive-pack forward aborts", async () => {
    const bindings = new GitBindings();
    expect(bindings.register(grant.runId, { repo: "o/r" }, undefined, async () => true)).toBe(true);
    expect(allowBranchReceipt(bindings, grant.runId)).toBe(true);
    const f = await fixture(bindings);
    const bearer = f.bearers.mint({ ...grant, github: { identity: "write", repo: "o/r" } });
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(1));
    const ref = "refs/heads/unit-branch";
    f.upstream.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "https://api.github.com/repos/o/r") return new Response(JSON.stringify({ default_branch: "main" }));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const line = Buffer.from(`${"0".repeat(40)} ${"2".repeat(40)} ${ref}\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${bearer}`).toString("base64")}`;
      const result = await fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      expect(result.status).toBe(502);
      expect(timeout).toHaveBeenCalledWith(GIT_RECEIVE_PACK_FORWARD_TIMEOUT_MS);
      expect(bindings.get(grant.runId)).toMatchObject({ ref, refConfirmed: false });
    } finally {
      timeout.mockRestore();
      await f.close();
    }
  });

  it("refuses an in-flight receive-pack after its run binding and bearer are revoked", async () => {
    const bindings = new GitBindings();
    expect(
      bindings.register(
        grant.runId,
        { repo: "o/r", ref: "fix" },
        { repo: "o/r", ref: "refs/heads/fix", refConfirmed: true },
        async () => true,
      ),
    ).toBe(true);
    const f = await fixture(bindings);
    let enteredMetadata!: () => void;
    const metadataStarted = new Promise<void>((resolve) => (enteredMetadata = resolve));
    let releaseMetadata!: () => void;
    const metadataHeld = new Promise<void>((resolve) => (releaseMetadata = resolve));
    f.upstream.mockImplementation(async (url: string) => {
      if (url === "https://api.github.com/repos/o/r") {
        enteredMetadata();
        await metadataHeld;
        return new Response(JSON.stringify({ default_branch: "main" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("upstream accepted", { status: 200 });
    });
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    const line = Buffer.from(`${old} ${next} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const pending = fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      await metadataStarted;
      bindings.unregister(grant.runId);
      f.bearers.revoke(grant.runId);
      releaseMetadata();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(f.upstream.mock.calls.some(([url]) => url === "https://github.com/o/r.git/git-receive-pack")).toBe(false);
    } finally {
      releaseMetadata();
      await f.close();
    }
  });

  it("refuses receive-pack revoked while its write token is being minted", async () => {
    const bindings = new GitBindings();
    expect(bindings.register(grant.runId, { repo: "o/r", ref: "fix" }, undefined)).toBe(true);
    expect(allowBranchReceipt(bindings, grant.runId)).toBe(true);
    let enteredMint!: () => void;
    const mintStarted = new Promise<void>((resolve) => (enteredMint = resolve));
    let releaseMint!: () => void;
    const mintHeld = new Promise<void>((resolve) => (releaseMint = resolve));
    const f = await fixture(bindings, async (scope, repo) => {
      if (scope === "write") {
        enteredMint();
        await mintHeld;
      }
      return `${scope}:${repo ?? "all"}`;
    });
    const old = "1".repeat(40);
    const next = "2".repeat(40);
    const line = Buffer.from(`${old} ${next} refs/heads/fix\0report-status`);
    const body = Buffer.concat([
      Buffer.from((line.length + 4).toString(16).padStart(4, "0")),
      line,
      Buffer.from("0000PACK"),
    ]);
    try {
      const auth = `Basic ${Buffer.from(`x-access-token:${f.bearer}`).toString("base64")}`;
      const pending = fetch(`${f.url}/git/o/r.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      await mintStarted;
      bindings.unregister(grant.runId);
      f.bearers.revoke(grant.runId);
      releaseMint();
      expect((await pending).status).toBe(403);
      expect(f.upstream.mock.calls.some(([url]) => url === "https://github.com/o/r.git/git-receive-pack")).toBe(false);
    } finally {
      releaseMint();
      await f.close();
    }
  });

  it("keeps a rejected first branch creation create-only until Git confirms it", async () => {
    const bindings = new GitBindings();
    const f = await fixture(bindings);
    const runId = "12345678-1234-1234-1234-123456789abf";
    expect(bindings.register(runId, { repo: "o/r" }, undefined, async () => true)).toBe(true);
    expect(allowBranchReceipt(bindings, runId)).toBe(true);
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
      new Response(
        Buffer.concat([
          packet("unpack ok\n"),
          packet(`${result} ${ref}${result === "ng" ? " rejected" : ""}\n`),
          Buffer.from("0000"),
        ]),
        {
          headers: { "content-type": "application/x-git-receive-pack-result" },
        },
      );
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
      expect(allowBranchReceipt(bindings, runId)).toBe(true);
      expect(await (await push("1".repeat(40))).text()).toContain("first push must create a new branch");
      expect(pushes).toBe(1);
      expect(await (await push("0".repeat(40))).text()).toContain(`ok ${ref}`);
      expect(bindings.get(runId)).toMatchObject({ ref, refConfirmed: true });
      const confirmed = bindings.get(runId);
      bindings.unregister(runId);
      expect(bindings.register(runId, { repo: "o/r" }, confirmed, async () => true)).toBe(true);
      expect(allowBranchReceipt(bindings, runId)).toBe(true);
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
