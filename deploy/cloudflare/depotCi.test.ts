import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { depotCiAuthorization, handleDepotCi } from "./depotCi.js";
import { depotCiGrantSchema } from "../../src/core/depotCi.js";
import { DepotCiAuthorizations } from "../../src/execution/depotCiAuthorization.js";
import { WorkerDepotCi } from "../../src/execution/depotCi.js";
import { Secret } from "../../src/secrets.js";

const HEAD = "a".repeat(40);
const depotToken = "organization-credential-never-forward";
const bridgeToken = "internal-bridge-credential";
const ticket = "a".repeat(64);
const workflow = () => ({
  orgId: "org-one",
  runId: "run-one",
  repo: "acme/api",
  workflowId: "workflow-one",
  headSha: HEAD,
  sha: "b".repeat(40),
  workflowStatus: "failed",
  workflowName: "ci",
  workflowPath: ".depot/workflows/ci.yml",
  workflowErrorMessage: "tests failed",
  jobs: [
    {
      jobId: "test",
      jobKey: "test",
      status: "failed",
      attempts: [
        { attemptId: "attempt-new", attempt: 2, status: "failed" },
        { attemptId: "attempt-old", attempt: 1, status: "failed" },
      ],
    },
    {
      jobId: "lint",
      jobKey: "lint",
      status: "finished",
      attempts: [{ attemptId: "lint-one", attempt: 1, status: "finished" }],
    },
  ],
});
function request(body: unknown, token = bridgeToken, method = "POST") {
  return new Request("https://edge.example/internal/depot-ci", {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
function harness(responses: unknown[] = [workflow()]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
    const answer = responses.shift();
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return Response.json(answer);
  }) as unknown as typeof fetch;
  const invoke = (body: unknown, token?: string, method?: string) => {
    const { repo, ...operation } = body as Record<string, unknown>;
    return handleDepotCi(request({ ticket }, token, method), {
      depotToken,
      bridgeToken,
      authorize: async () => ({ runId: "coding-run", repo, operation }),
      fetch: fetcher,
    });
  };
  return { calls, invoke, fetcher };
}
const inspect = { operation: "inspect", repo: "acme/api", workflowId: "workflow-one" };
const logs = { ...inspect, operation: "logs", jobId: "test" };
const retry = { ...inspect, operation: "retry_failed", expectedHead: HEAD };

describe("Depot CI edge", () => {
  it("authenticates before parsing and refuses missing credentials, methods and broad operations", async () => {
    const h = harness();
    expect((await h.invoke(inspect, "wrong")).status).toBe(401);
    expect((await h.invoke(inspect, undefined, "GET")).status).toBe(405);
    for (const body of [
      { ...inspect, operation: "Run" },
      { ...inspect, url: "https://evil.example" },
      { ...retry, headers: {} },
      { ...inspect, repo: "../x" },
    ])
      expect((await handleDepotCi(request(body), { depotToken, bridgeToken, fetch: h.fetcher })).status).toBe(400);
    expect(
      (
        await handleDepotCi(request({ ticket }), {
          bridgeToken,
          authorize: async () => ({
            runId: "coding-run",
            repo: "acme/api",
            operation: { operation: "inspect", workflowId: "workflow-one" },
          }),
          fetch: h.fetcher,
        })
      ).status,
    ).toBe(503);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a bridge bearer with caller-chosen run and repo before using the organization token", async () => {
    const h = harness();
    const res = await handleDepotCi(request(inspect), { depotToken, bridgeToken, fetch: h.fetcher });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("requires a valid live permit callback and never substitutes caller run, repo or operation", async () => {
    for (const answer of [undefined, {}, { runId: "coding-run", repo: "acme/api", operation: { operation: "Run" } }]) {
      const h = harness();
      const authorize = vi.fn(async () => answer);
      const res = await handleDepotCi(request({ ticket }), { depotToken, bridgeToken, authorize, fetch: h.fetcher });
      expect(res.status).toBe(403);
      expect(h.calls).toHaveLength(0);
      expect(authorize).toHaveBeenCalledOnce();
      for (const injection of [{ repo: "other/private" }, { runId: "other-run" }, { operation: "retry_failed" }]) {
        expect(
          (
            await handleDepotCi(request({ ticket, ...injection }), {
              depotToken,
              bridgeToken,
              authorize,
              fetch: h.fetcher,
            })
          ).status,
        ).toBe(400);
      }
      expect(authorize).toHaveBeenCalledOnce();
    }
    const h = harness();
    const res = await handleDepotCi(request({ ticket }), {
      depotToken,
      bridgeToken,
      fetch: h.fetcher,
      authorize: async () => {
        throw new Error(depotToken);
      },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(depotToken);
    expect(h.calls).toHaveLength(0);
  });

  it("uses the fixed private bot callback and refuses redirects, error bodies and malformed grants", async () => {
    const botFetch = vi.fn(async (req: Request) => {
      expect(req.url).toBe("https://switchboard-keepalive.internal/internal/depot-ci/authorization");
      expect(req.headers.get("authorization")).toBe(`Bearer ${ticket}`);
      expect(req.redirect).toBe("error");
      return Response.json({
        runId: "coding-run",
        repo: "acme/api",
        operation: { operation: "inspect", workflowId: "workflow-one" },
      });
    });
    const grant = await depotCiAuthorization(ticket, new AbortController().signal, botFetch);
    expect(depotCiGrantSchema.safeParse(grant).success).toBe(true);
    for (const status of [302, 403, 500]) {
      expect(
        await depotCiAuthorization(
          ticket,
          new AbortController().signal,
          async () => new Response(depotToken, { status }),
        ),
      ).toBeUndefined();
    }
    await expect(
      depotCiAuthorization(ticket, new AbortController().signal, async () => new Response("x".repeat(17 * 1024))),
    ).rejects.toThrow();
  });

  it("integrates the bot-issued run permit with the edge and refuses concurrent replay before a second retry", async () => {
    const permits = new DepotCiAuthorizations();
    const h = harness([workflow(), { workflowId: "workflow-one", jobIds: ["test"], jobCount: 1 }]);
    let replay: Request | undefined;
    const edge = (req: Request) =>
      handleDepotCi(req, {
        depotToken,
        bridgeToken,
        fetch: h.fetcher,
        authorize: async (key) => permits.consume(key),
      });
    const client = new WorkerDepotCi({
      runId: "coding-run",
      repo: "acme/api",
      canUseRepo: () => true,
      baseUrl: "https://edge.example",
      token: new Secret(bridgeToken, "DEPOT_CI_BRIDGE_TOKEN"),
      authorizations: permits,
      fetch: async (url, init) => {
        const req = new Request(url, init);
        replay = req.clone();
        const concurrent = req.clone();
        const [first, second] = await Promise.all([edge(req), edge(concurrent)]);
        expect(second.status).toBe(403);
        return first;
      },
    });
    expect(await client.call({ operation: "retry_failed", workflowId: "workflow-one", expectedHead: HEAD })).toEqual({
      workflowId: "workflow-one",
      jobIds: ["test"],
      jobCount: 1,
    });
    expect((await edge(replay!)).status).toBe(403);
    expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual(["GetWorkflow", "RetryFailedJobs"]);
  });

  it("withholds credentials split across page boundaries before any tail clipping", async () => {
    for (const secret of [depotToken, bridgeToken, "ghp_" + "a".repeat(30), "GH_TOKEN=some-private-value"]) {
      const cut = Math.floor(secret.length / 2);
      const h = harness([
        workflow(),
        { lines: [{ body: secret.slice(0, cut) }], nextPageToken: "next" },
        { lines: [{ body: secret.slice(cut) }, { body: "FAIL parser assertion" }] },
      ]);
      const res = await h.invoke({ ...logs, lines: 2 });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { text: string };
      expect(out.text).not.toContain(secret.slice(0, cut));
      expect(out.text).not.toContain(secret.slice(cut));
    }
  });

  it("follows empty pages with continuation tokens instead of declaring a partial credential complete", async () => {
    const h = harness([
      workflow(),
      { lines: [{ body: depotToken.slice(0, 10) }], nextPageToken: "two" },
      { lines: [], nextPageToken: "three" },
      { lines: [{ body: depotToken.slice(10) }] },
    ]);
    expect(await (await h.invoke(logs)).json()).toMatchObject({
      complete: true,
      text: "",
      withheld: "credential spans log records",
    });
    expect(h.calls).toHaveLength(4);
  });

  it("redacts a multi-page private key and withholds multi-page or ANSI-split credentials", async () => {
    const pem = harness([
      workflow(),
      { lines: [{ body: "FAIL parser assertion" }, { body: "-----BEGIN PRIVATE KEY-----" }], nextPageToken: "two" },
      { lines: [{ body: "private-key-material" }], nextPageToken: "three" },
      { lines: [{ body: "-----END PRIVATE KEY-----" }] },
    ]);
    const pemOut = (await (await pem.invoke(logs)).json()) as { text: string };
    expect(pemOut.text).toContain("FAIL parser assertion");
    expect(pemOut.text).not.toContain("private-key-material");
    for (const pieces of [
      [depotToken.slice(0, 4), depotToken.slice(4, 12), depotToken.slice(12)],
      [depotToken.slice(0, 8) + "\u001b[", "31m" + depotToken.slice(8)],
    ]) {
      const h = harness([
        workflow(),
        ...pieces.map((body, i) => ({
          lines: [{ body }],
          ...(i < pieces.length - 1 ? { nextPageToken: `page-${i}` } : {}),
        })),
      ]);
      expect(await (await h.invoke({ ...logs, lines: 1 })).json()).toMatchObject({
        text: "",
        withheld: "credential spans log records",
      });
    }
  });

  it("withholds incomplete or aggregate-limited captures instead of leaking a trailing secret fragment", async () => {
    const incomplete = harness([
      workflow(),
      ...Array.from({ length: 20 }, (_, i) => ({
        lines: [{ body: depotToken.slice(0, 10) }],
        nextPageToken: `page-${i}`,
      })),
    ]);
    expect(await (await incomplete.invoke(logs)).json()).toMatchObject({
      complete: false,
      text: "",
      withheld: "incomplete capture",
    });
    const tooLarge = harness([
      workflow(),
      ...Array.from({ length: 6 }, (_, i) => ({
        lines: [{ body: "x".repeat(1_000_000) }],
        nextPageToken: `page-${i}`,
      })),
    ]);
    expect(await (await tooLarge.invoke(logs)).json()).toMatchObject({
      complete: false,
      text: "",
      withheld: "incomplete capture",
    });
    expect(tooLarge.calls).toHaveLength(6);
  });

  it("reads a workflow over fixed Connect JSON and returns only bounded sanitized evidence", async () => {
    const h = harness([
      {
        ...workflow(),
        workflowErrorMessage: `\u001b[31m${depotToken} ${bridgeToken} GH_TOKEN=super-secret-value`,
        privateField: depotToken,
      },
    ]);
    const res = await h.invoke(inspect);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(HEAD);
    expect(text).toContain("attempt-new");
    for (const secret of [depotToken, bridgeToken, "super-secret-value", "privateField", "\u001b"])
      expect(text).not.toContain(secret);
    expect(h.calls[0].url).toBe("https://api.depot.dev/depot.ci.v1.CIService/GetWorkflow");
    expect(h.calls[0].init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${depotToken}`,
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
    });
    expect(h.calls[0].body).toEqual({ workflowId: "workflow-one" });
  });

  it("refuses foreign or inconsistent workflow identities before disclosure, logs or retry", async () => {
    for (const operation of [inspect, logs, retry]) {
      for (const foreign of [
        { ...workflow(), repo: "other/private" },
        { ...workflow(), workflowId: "different" },
      ]) {
        const h = harness([foreign]);
        const res = await h.invoke(operation);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("other/private");
        expect(h.calls).toHaveLength(1);
      }
    }
  });

  it("selects the latest numbered attempt, paginates pinned logs and returns a redacted tail", async () => {
    const h = harness([
      workflow(),
      { lines: [{ body: "old line" }], nextPageToken: "page-two" },
      {
        lines: [
          { body: `\u001b[31mFAIL test: expected true got false ${depotToken}` },
          { body: "GH_TOKEN=never-output-this" },
        ],
        nextPageToken: "end",
      },
      { lines: [] },
    ]);
    const res = await h.invoke({ ...logs, lines: 2 });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { text: string; complete: boolean; attemptId: string };
    expect(out.attemptId).toBe("attempt-new");
    expect(out.complete).toBe(true);
    expect(out.text).toContain("FAIL test: expected true got false");
    for (const hidden of ["old line", depotToken, "never-output-this", "\u001b"])
      expect(out.text).not.toContain(hidden);
    expect(h.calls.slice(1).map((c) => c.body)).toEqual([
      { attemptId: "attempt-new" },
      { attemptId: "attempt-new", pageToken: "page-two" },
      { attemptId: "attempt-new", pageToken: "end" },
    ]);
  });

  it("accepts only attempts belonging to the selected job and refuses unknown or ambiguous jobs", async () => {
    for (const input of [
      { ...logs, jobId: "foreign" },
      { ...logs, attemptId: "foreign" },
      { ...logs, attemptId: "lint-one" },
    ]) {
      const h = harness();
      expect((await h.invoke(input)).status).toBe(404);
      expect(h.calls).toHaveLength(1);
    }
    const h = harness([workflow(), { lines: [] }]);
    expect((await h.invoke({ ...logs, attemptId: "attempt-old" })).status).toBe(200);
    expect(h.calls[1].body).toEqual({ attemptId: "attempt-old" });
  });

  it("reports incomplete pagination and caps text without silently dropping evidence", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({
      lines: [{ body: "x".repeat(60_000) }],
      nextPageToken: `page-${i}`,
    }));
    const h = harness([workflow(), ...pages]);
    const out = (await (await h.invoke(logs)).json()) as { complete: boolean; truncated: boolean; text: string };
    expect(out.complete).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(50_000);
    expect(h.calls).toHaveLength(21);
  });

  it("keeps the requested line limit after a character-clipped page", async () => {
    const h = harness([
      workflow(),
      { lines: [{ body: "x".repeat(50_000) }, { body: "second line" }], nextPageToken: "next" },
      { lines: [{ body: "last line" }] },
    ]);
    const out = (await (await h.invoke({ ...logs, lines: 2 })).json()) as { text: string; truncated: boolean };
    expect(out.text).toBe("second line\nlast line");
    expect(out.truncated).toBe(true);
  });

  it("does not dispatch a retry after the child stops during the ownership read", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return Response.json(workflow());
    });
    const req = new Request(request({ ticket }), { signal: controller.signal });
    const { repo, ...operation } = retry;
    const res = await handleDepotCi(req, {
      depotToken,
      bridgeToken,
      fetch: fetcher,
      authorize: async () => ({ runId: "coding-run", repo, operation }),
    });
    expect(res.status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await res.text()).not.toContain("outcome unknown");
  });

  it("retries failed jobs only at the expected head without a full rerun", async () => {
    const h = harness([workflow(), { workflowId: "workflow-one", jobIds: ["test", "downstream"], jobCount: 2 }]);
    const res = await h.invoke(retry);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: "workflow-one", jobIds: ["test", "downstream"], jobCount: 2 });
    expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual(["GetWorkflow", "RetryFailedJobs"]);
    expect(h.calls[1].body).toEqual({ workflowId: "workflow-one" });
  });

  it("treats incomplete upstream retry acknowledgements as unknown outcomes", async () => {
    for (const answer of [
      { workflowId: "workflow-one", jobCount: 0 },
      { workflowId: "workflow-one", jobIds: [] },
    ]) {
      const h = harness([workflow(), answer]);
      const res = await h.invoke(retry);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("outcome unknown");
      expect(h.calls.map((c) => c.url.split("/").at(-1))).toEqual(["GetWorkflow", "RetryFailedJobs"]);
    }
  });

  it("refuses a mismatched head or nonfailed workflow without a mutation", async () => {
    for (const changed of [
      { ...workflow(), headSha: "c".repeat(40) },
      { ...workflow(), workflowStatus: "running" },
      { ...workflow(), workflowStatus: "finished" },
    ]) {
      const h = harness([changed]);
      expect((await h.invoke(retry)).status).toBe(409);
      expect(h.calls).toHaveLength(1);
    }
    const h = harness([
      { ...workflow(), headSha: "", sha: HEAD, workflowStatus: "cancelled" },
      { workflowId: "workflow-one", jobIds: ["test"], jobCount: 1 },
    ]);
    expect((await h.invoke(retry)).status).toBe(200);
  });

  it("never echoes errors or retries an uncertain mutation", async () => {
    for (const failure of [
      new Error(depotToken),
      new Response(depotToken, { status: 503 }),
      Response.json({ wrong: depotToken }),
    ]) {
      const h = harness([workflow(), failure]);
      const res = await h.invoke(retry);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain("outcome unknown");
      expect(text).not.toContain(depotToken);
      expect(h.calls).toHaveLength(2);
    }
    const h = harness([new Response(`Bearer ${depotToken}`, { status: 403 })]);
    const res = await h.invoke(inspect);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("HTTP 403");
  });

  it("cancels oversized responses and malformed metadata before any mutation", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const h = harness([new Response(body)]);
    expect((await h.invoke(retry)).status).toBe(502);
    expect(cancel).toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    const malformed = harness([{ workflowId: "workflow-one", repo: "acme/api" }]);
    expect((await malformed.invoke(retry)).status).toBe(502);
    expect(malformed.calls).toHaveLength(1);
  });

  it("routes at the Worker without forwarding the organization credential to the bot", () => {
    const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
    expect(source).toContain("handleDepotCi(request,");
    expect(source).toContain("depotToken: env.DEPOT_API_TOKEN");
    expect(source).toContain(
      'if (pathname === DEPOT_CI_AUTHORIZATION_PATH) return new Response("not found", { status: 404 })',
    );
    expect(source).toContain("getContainer(env.SWITCHBOARD, INSTANCE).fetch(req)");
    const forwarded = /const FORWARDED_OPTIONAL = \[([\s\S]*?)\]/.exec(source)![1];
    expect(forwarded).toContain('"DEPOT_CI_BRIDGE_TOKEN"');
    expect(forwarded).not.toContain('"DEPOT_API_TOKEN"');
  });
});
