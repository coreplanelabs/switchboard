import { describe, expect, it, vi } from "vitest";
import { DEPOT_ERRORS } from "../core/depotCi.js";
import { Secret, secretsFrom, publicEnv } from "../secrets.js";
import { depotCiAuthorizations } from "./depotCiAuthorization.js";
import { WorkerDepotCi, InMemoryDepotCi, buildDepotCi } from "./depotCi.js";

const ask = { operation: "inspect" as const, workflowId: "workflow-one" };
const token = new Secret("bridge-credential-only", "DEPOT_CI_BRIDGE_TOKEN");

describe("Depot CI bridge", () => {
  it("binds the repo outside model input and rechecks the permission before every call", async () => {
    let allowed = true;
    let grant: unknown;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { ticket } = JSON.parse(String(init?.body));
      grant = depotCiAuthorizations.consume(ticket);
      return Response.json({ workflowId: "workflow-one" });
    });
    const client = new WorkerDepotCi({
      runId: "coding-run",
      repo: "acme/api",
      canUseRepo: () => allowed,
      baseUrl: "https://edge.example",
      token,
      fetch: fetcher,
    });
    expect(await client.call(ask)).toEqual({ workflowId: "workflow-one" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://edge.example/internal/depot-ci");
    expect(JSON.parse(String(init?.body))).toEqual({ ticket: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(grant).toEqual({ runId: "coding-run", repo: "acme/api", operation: ask });
    expect(init).toMatchObject({ redirect: "error", headers: { authorization: "Bearer bridge-credential-only" } });
    allowed = false;
    await expect(client.call(ask)).rejects.toThrow("repository access refused");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses a repo override, broad input or unsafe origin without a request", async () => {
    const fetcher = vi.fn();
    const client = new WorkerDepotCi({
      runId: "coding-run",
      repo: "acme/api",
      canUseRepo: () => true,
      baseUrl: "https://edge.example",
      token,
      fetch: fetcher,
    });
    await expect(client.call({ ...ask, repo: "other/private" } as typeof ask)).rejects.toThrow("invalid");
    for (const baseUrl of [
      "http://edge.example",
      "https://user:pass@edge.example",
      "https://edge.example/path",
      "https://edge.example?key=x",
    ])
      expect(
        () =>
          new WorkerDepotCi({
            runId: "coding-run",
            repo: "acme/api",
            canUseRepo: () => true,
            baseUrl,
            token,
            fetch: fetcher,
          }),
      ).toThrow("HTTPS origin");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not retry failures and preserves only the typed edge error", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: "Depot retry outcome unknown; inspect before another request.", detail: "private" },
        { status: 502 },
      ),
    );
    const client = new WorkerDepotCi({
      runId: "coding-run",
      repo: "acme/api",
      canUseRepo: () => true,
      baseUrl: "https://edge.example",
      token,
      fetch: fetcher,
    });
    await expect(client.call(ask)).rejects.toThrow("Depot retry outcome unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValueOnce(new Error("private"));
    await expect(client.call(ask)).rejects.toThrow("bridge unavailable");
  });

  it("expires permits on every response or transport failure and treats unrecognized retry results as unknown", async () => {
    for (const answer of [
      new Error("private transport detail"),
      new Response("not JSON", { status: 502 }),
      Response.json(null),
      Response.json({ error: "private proxy detail" }, { status: 502 }),
    ]) {
      let ticket = "";
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        ticket = JSON.parse(String(init?.body)).ticket;
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const client = new WorkerDepotCi({
        runId: "coding-run",
        repo: "acme/api",
        canUseRepo: () => true,
        baseUrl: "https://edge.example",
        token,
        fetch: fetcher,
      });
      await expect(
        client.call({ operation: "retry_failed", workflowId: "workflow-one", expectedHead: "a".repeat(40) }),
      ).rejects.toThrow("outcome unknown");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(depotCiAuthorizations.consume(ticket)).toBeUndefined();
    }
  });

  it.each([
    ["empty object", {}],
    ["null", null],
    ["array", []],
    ["string", "accepted"],
    ["missing workflow", { jobIds: [], jobCount: 0 }],
    ["malformed workflow", { workflowId: "invalid/id", jobIds: [], jobCount: 0 }],
    ["foreign workflow", { workflowId: "workflow-other", jobIds: [], jobCount: 0 }],
    ["missing jobs", { workflowId: "workflow-one", jobCount: 0 }],
    ["non-array jobs", { workflowId: "workflow-one", jobIds: "job-one", jobCount: 1 }],
    ["invalid job", { workflowId: "workflow-one", jobIds: ["invalid/id"], jobCount: 1 }],
    ["non-string job", { workflowId: "workflow-one", jobIds: [1], jobCount: 1 }],
    ["missing count", { workflowId: "workflow-one", jobIds: [] }],
    ["negative count", { workflowId: "workflow-one", jobIds: [], jobCount: -1 }],
    ["fractional count", { workflowId: "workflow-one", jobIds: [], jobCount: 0.5 }],
    ["non-numeric count", { workflowId: "workflow-one", jobIds: [], jobCount: "0" }],
    ["inconsistent count", { workflowId: "workflow-one", jobIds: ["job-one"], jobCount: 0 }],
    ["error envelope", { error: "private edge detail" }],
    ["extra fields", { workflowId: "workflow-one", jobIds: [], jobCount: 0, error: "private edge detail" }],
  ])("treats malformed HTTP 200 retry acknowledgements as unknown without replay: %s", async (_label, answer) => {
    let ticket = "";
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      ticket = JSON.parse(String(init?.body)).ticket;
      return Response.json(answer);
    });
    const client = new WorkerDepotCi({
      runId: "coding-run",
      repo: "acme/api",
      canUseRepo: () => true,
      baseUrl: "https://edge.example",
      token,
      fetch: fetcher,
    });
    await expect(
      client.call({ operation: "retry_failed", workflowId: "workflow-one", expectedHead: "a".repeat(40) }),
    ).rejects.toThrow(new Error(DEPOT_ERRORS.unknown));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(depotCiAuthorizations.consume(ticket)).toBeUndefined();
  });

  it.each([{ jobIds: [] }, { jobIds: ["job-one", "job-two"] }])(
    "accepts complete retry acknowledgements for jobs $jobIds",
    async ({ jobIds }) => {
      const answer = { workflowId: "workflow-one", jobIds, jobCount: jobIds.length };
      const fetcher = vi.fn(async () => Response.json(answer));
      const client = new WorkerDepotCi({
        runId: "coding-run",
        repo: "acme/api",
        canUseRepo: () => true,
        baseUrl: "https://edge.example",
        token,
        fetch: fetcher,
      });
      await expect(
        client.call({ operation: "retry_failed", workflowId: "workflow-one", expectedHead: "a".repeat(40) }),
      ).resolves.toEqual(answer);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("enables only a configured repo binding and never reads the organization token", async () => {
    const get = vi.fn((name: string) => {
      expect(name).toBe("DEPOT_CI_BRIDGE_TOKEN");
      return token;
    });
    const secrets = { ...secretsFrom({}), get };
    const opts = { runId: "coding-run", repo: "acme/api", canUseRepo: () => true, baseUrl: "https://edge.example" };
    expect(buildDepotCi(opts, secrets)).toBeInstanceOf(WorkerDepotCi);
    expect(buildDepotCi({ ...opts, repo: undefined }, secrets)).toBeUndefined();
    expect(buildDepotCi({ ...opts, baseUrl: undefined }, secrets)).toBeUndefined();
    expect(buildDepotCi(opts, secretsFrom({}))).toBeUndefined();
    expect(publicEnv({ DEPOT_API_TOKEN: "org-secret", DEPOT_CI_BRIDGE_TOKEN: "bridge", PATH: "/bin" })).toEqual({
      PATH: "/bin",
    });
  });

  it("has an in-memory implementation for child tool tests", async () => {
    const client = new InMemoryDepotCi({ "workflow-one": { workflowId: "workflow-one" } });
    expect(await client.call(ask)).toEqual({ workflowId: "workflow-one" });
    expect(client.calls).toEqual([ask]);
    await expect(client.call({ ...ask, workflowId: "missing" })).rejects.toThrow("not found");
  });
});
