import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { LocalExecutor } from "./executor.js";
import { ResidentExecutor } from "./resident.js";
import { makeExecutor, resetResidentProbeCache, type ExecutorFactoryOptions } from "./factory.js";

// Feature: features/execution.md — per-agent executor provisioning: agents
// declare the resources they need (AgentDef.resources); an agent that declares
// no repo gets a null executor and no sandbox/workspace is ever provisioned.

function dirs(): Pick<ExecutorFactoryOptions, "workspaceDir" | "dataDir"> {
  const dir = mkdtempSync(join(tmpdir(), "swb-factory-"));
  return { workspaceDir: join(dir, "workspaces"), dataDir: join(dir, "data") };
}

const ctx = (agentName: string) => ({ threadKey: "slack:CX:1.0", agent: AGENTS[agentName] });

describe("makeExecutor per-agent provisioning", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("an agent declaring no repo gets a null executor with cloudflare configured (no sandbox call, no token needed)", async () => {
    // Missing credential + poisoned fetch: any attempt to touch the Cloudflare
    // path would throw or call the network. Neither may happen for general.
    vi.stubEnv("SANDBOX_TOKEN", "");
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { executor: ex } = await makeExecutor(
      { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
      ctx("general"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    // Tools reaching a resource-less agent's executor is a config bug — it
    // must surface legibly, not crash or provision anything.
    await expect(ex.exec("echo hi")).rejects.toThrow(/no repo resource/);
  });

  it("an agent declaring no repo gets a null executor with e2b configured (no API key needed)", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const { executor: ex } = await makeExecutor({ execution: { type: "e2b" }, ...dirs() }, ctx("general"));
    await expect(ex.readFile("x")).rejects.toThrow(/no repo resource/);
  });

  it("an agent declaring no repo creates no workspace directory in local mode", async () => {
    const d = dirs();
    await makeExecutor({ ...d }, ctx("general"));
    expect(existsSync(d.workspaceDir)).toBe(false);
  });

  it("a repo-requiring agent gets a LocalExecutor with a per-thread workspace (local)", async () => {
    const d = dirs();
    const { executor: ex } = await makeExecutor({ ...d }, ctx("coding"));
    expect(ex).toBeInstanceOf(LocalExecutor);
    expect(existsSync(join(d.workspaceDir, "slack_CX_1.0"))).toBe(true);
  });

  it("a repo-requiring agent gets the Cloudflare backend when configured", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", ""); // keep githubEnvs off the network
    const { executor: ex } = await makeExecutor(
      { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
      ctx("review"),
    );
    expect(ex).toBeInstanceOf(CloudflareSandboxExecutor);
  });

  it("a repo-requiring agent with e2b configured but no API key still fails legibly", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    await expect(makeExecutor({ execution: { type: "e2b" }, ...dirs() }, ctx("coding"))).rejects.toThrow(
      /E2B_API_KEY is not set/,
    );
  });
});

// Feature: features/resident-repos.md — resident selection (U5): with a
// resolved target repo and execution.resident configured, a warm resident
// serves the thread; any other state falls back to the per-thread backend
// with a NAMED note (KTD10); probe transport failures are negative-cached so
// a resident-service outage costs one timeout, not one per dispatch.
describe("makeExecutor resident selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetResidentProbeCache();
  });

  const residentOpts = (): ExecutorFactoryOptions => ({
    execution: {
      type: "cloudflare",
      url: "https://sandbox.example",
      resident: { baseUrl: "https://resident.example" },
    },
    ...dirs(),
  });

  const repoCtx = () => ({
    threadKey: "slack:CX:1.0",
    agent: AGENTS.coding,
    repo: "jshttp/vary",
    ref: "master",
  });

  function stubEnvs() {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.stubEnv("GITHUB_APP_ID", ""); // keep githubEnvs off the network
  }

  /** FIFO fetch stub; a canned {reject} entry simulates a network failure. */
  function stubFetch(...responses: Array<{ status?: number; body?: unknown; reject?: string }>) {
    const calls: string[] = [];
    const fn = vi.fn(async (url: unknown) => {
      calls.push(new URL(String(url)).pathname);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
      if (next.reject) throw new TypeError(next.reject);
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls };
  }

  it("ctx.repo undefined → per-thread path with ZERO probe calls (total input contract)", async () => {
    stubEnvs();
    const { fn } = stubFetch();
    const { executor, note } = await makeExecutor(residentOpts(), { threadKey: "slack:CX:1.0", agent: AGENTS.coding });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("warm probe → ResidentExecutor, attached on open", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2", deps: "hardlink" } },
    );
    const { executor, note } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(note).toBeUndefined();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("not-warm probe → fallback carrying state and reason verbatim; no attach", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "restoring", reason: "rehydrating" } });
    const { executor, note } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBe("resident restoring (rehydrating) — using fresh sandbox");
    expect(calls).toEqual(["/status"]);
  });

  it("not-warm states are NOT cached — the next dispatch probes again", async () => {
    stubEnvs();
    const { fn } = stubFetch(
      { body: { state: "degraded", reason: "alarm-missed: refresh chain was dead" } },
      { body: { state: "down", reason: "r2-restore-failed: boom" } },
    );
    const first = await makeExecutor(residentOpts(), repoCtx());
    expect(first.note).toBe("resident degraded (alarm-missed: refresh chain was dead) — using fresh sandbox");
    const second = await makeExecutor(residentOpts(), repoCtx());
    expect(second.note).toBe("resident down (r2-restore-failed: boom) — using fresh sandbox");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("probe transport failure → named fallback + negative cache (second dispatch makes no fetch)", async () => {
    stubEnvs();
    const { fn } = stubFetch({ reject: "fetch failed" });
    const first = await makeExecutor(residentOpts(), repoCtx());
    expect(first.executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(first.note).toMatch(/^resident unreachable \(.*fetch failed.*\) — using fresh sandbox$/);
    const second = await makeExecutor(residentOpts(), repoCtx());
    expect(second.executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(second.note).toMatch(/unreachable/);
    expect(fn).toHaveBeenCalledTimes(1); // circuit breaker: one timeout per outage window
  });

  it("404 not-onboarded → the ordinary per-thread path with NO note", async () => {
    stubEnvs();
    const { fn } = stubFetch({ status: 404, body: { error: "unknown resource" } });
    const { executor, note } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resident configured but its token env unset → legible error", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "");
    stubFetch();
    await expect(makeExecutor(residentOpts(), repoCtx())).rejects.toThrow(/RESIDENT_OPERATOR_TOKEN is not set/);
  });
});
