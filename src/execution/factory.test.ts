import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { LocalExecutor } from "./executor.js";
import { ResidentExecutor, ResidentNeedsRefError } from "./resident.js";
import { makeExecutor, resetResidentProbeCache, type ExecutorFactoryOptions } from "./factory.js";
import { resolveGithubToken } from "./githubApp.js";

// The sandbox's GitHub credential is minted per toolset (least-privilege), so
// mock the mint to a scope-tagged token: the test asserts the SCOPE requested
// and the token that lands in the sandbox env, without JWT signing or network.
vi.mock("./githubApp.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./githubApp.js")>();
  return {
    ...mod,
    resolveGithubToken: vi.fn(async (scope?: "read" | "write") => `ghs_${scope ?? "write"}`),
  };
});

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

  // Security (#79 review): the review agent's sandbox has `gh` + the credential
  // helper, so a write-capable GH_TOKEN there would let the model — or a
  // prompt-injected diff — post/review/push. Least-privilege closes it at the
  // token: a `readonly` toolset gets a READ-scoped token, a `full` toolset gets
  // WRITE. (The bot-process review post uses its own write token, unaffected.)
  const envOf = (ex: unknown) => (ex as { opts: { envs: Record<string, string> } }).opts.envs;

  it("a readonly agent's sandbox gets a READ-scoped token; a full agent gets WRITE", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.mocked(resolveGithubToken).mockClear();
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
    };
    const review = await makeExecutor(cf, ctx("review")); // toolset "readonly"
    const coding = await makeExecutor(cf, ctx("coding")); // toolset "full"

    expect(resolveGithubToken).toHaveBeenCalledWith("read");
    expect(resolveGithubToken).toHaveBeenCalledWith("write");
    // …and the scoped token is exactly what lands in the sandbox env.
    expect(envOf(review.executor).GH_TOKEN).toBe("ghs_read");
    expect(envOf(coding.executor).GH_TOKEN).toBe("ghs_write");
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

  it("warm probe → ResidentExecutor, attached on open, with the resident discriminant set", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2", deps: "hardlink" } },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(note).toBeUndefined();
    // The discriminant is the backend signal the dispatcher branches its
    // resident system-prompt on (never an executor `instanceof`): true ONLY on
    // the warm-resident branch.
    expect(resident).toBe(true);
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("not-warm probe → fallback carrying state and reason verbatim; no attach, discriminant NOT set", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "restoring", reason: "rehydrating" } });
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBe("resident restoring (rehydrating) — using fresh sandbox");
    // A per-thread fallback is NOT the resident branch: the dispatcher must
    // keep the agent's own prompt, so the discriminant stays falsy.
    expect(resident).toBeFalsy();
    expect(calls).toEqual(["/status"]);
  });

  // Serviceable non-warm states (live 2026-08-29): the resident keeps serving
  // the last snapshot while `refreshing` (fetch/rebuild under the mirror lock)
  // or `degraded` (a failed refresh; previous checkout intact), and /attach
  // refuses neither — so the bot attaches, and says so on the card (KTD10).
  it("refreshing probe → ResidentExecutor WITH an informational note (attached to the last snapshot)", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "refreshing", reason: "" } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2", deps: "hardlink" } },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(resident).toBe(true);
    expect(note).toBe("resident refreshing — attached to the last snapshot");
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("degraded probe → ResidentExecutor, note carries the reason", async () => {
    stubEnvs();
    stubFetch(
      { body: { state: "degraded", reason: "github-unreachable: fetch timed out" } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2", deps: "hardlink" } },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(resident).toBe(true);
    expect(note).toBe("resident degraded (github-unreachable: fetch timed out) — attached to the last snapshot");
  });

  // Review finding on #162: a refresh that failed INSIDE the rebuild lock
  // (install/build after `git clean -fdx`) leaves a checkout at the new sha with
  // absent/partial deps; a fresh thread would hardlink that broken cache. Those
  // degraded reasons stay cold until the next cycle rebuilds.
  it("degraded by an in-rebuild failure (install-failed) → per-thread fallback, no attach", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "degraded", reason: "install-failed: npm ERR! ERESOLVE unable to resolve dependency tree" } });
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toBe("resident degraded (install-failed: npm ERR! ERESOLVE unable to resolve dependency tree) — using fresh sandbox");
    expect(calls).toEqual(["/status"]);
  });

  it("refreshing probe then a mirror-busy attach (503) → per-thread fallback with the named attach-failed note", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "refreshing", reason: "" } },
      { status: 503, body: { error: "mirror busy: rebuild in progress", state: "refreshing", reason: "mirror-busy" } },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toMatch(/^resident attach failed \(.*mirror busy.*\) — using fresh sandbox$/);
    expect(calls).toEqual(["/status", "/attach"]);
  });

  // The engine-owned states: nothing serviceable to attach to.
  it.each([
    ["onboarding", ""],
    ["restoring", "rehydrating"],
    ["down", "provision-failed at clone: no such repo"],
  ])("%s probe → per-thread fallback with the verbatim state/reason note; no attach", async (state, reason) => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state, reason } });
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toBe(`resident ${state}${reason ? ` (${reason})` : ""} — using fresh sandbox`);
    expect(calls).toEqual(["/status"]);
  });

  // AE6 (3-reviewer-corroborated): the resident can degrade between the warm
  // /status probe and /attach (503 mirror-busy, 429 pool-exhausted). Any attach
  // failure that is NOT needs-ref must fall back to the per-thread backend with
  // a NAMED note (KTD10) — never a silent stall or a raw ⚠️.
  it("warm probe then a NON-needs-ref attach failure → per-thread executor WITH a named 'resident attach failed' note", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { status: 503, body: { error: "mirror-busy: reprovisioning" } },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toMatch(/^resident attach failed \(.*mirror-busy.*\) — using fresh sandbox$/);
    // the probe WAS warm and the attach WAS attempted before falling back
    expect(calls).toEqual(["/status", "/attach"]);
  });

  // ResidentNeedsRefError must still propagate through the warm→attach window:
  // the dispatcher's ask-once flow (one clarifying question, no model turn)
  // depends on catching it — it must never be swallowed into a fallback note.
  it("warm probe then a needs-ref attach failure → ResidentNeedsRefError propagates (dispatcher ask-once intact)", async () => {
    stubEnvs();
    stubFetch(
      { body: { state: "warm", reason: "" } },
      { status: 409, body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref" } },
    );
    await expect(makeExecutor(residentOpts(), repoCtx())).rejects.toBeInstanceOf(ResidentNeedsRefError);
  });

  it("not-warm states are NOT cached — the next dispatch probes again", async () => {
    stubEnvs();
    const { fn } = stubFetch(
      { body: { state: "restoring", reason: "rehydrating" } },
      { body: { state: "down", reason: "r2-restore-failed: boom" } },
    );
    const first = await makeExecutor(residentOpts(), repoCtx());
    expect(first.note).toBe("resident restoring (rehydrating) — using fresh sandbox");
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

  // A repo that is simply not onboarded still runs — on the per-thread backend —
  // but the fall-through must be VISIBLE (KTD10): the user needs to know coding
  // ran cold instead of on a warm, deps-ready resident, plus how to fix it.
  it("404 not-onboarded → per-thread path with a named cold-fallback note pointing at onboarding", async () => {
    stubEnvs();
    const { fn } = stubFetch({ status: 404, body: { error: "unknown resource" } });
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toBe(
      "repo not onboarded as a resident — running in a cold per-thread sandbox; " +
        "onboard it (`repo onboard jshttp/vary`) for a warm, deps-ready environment",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resident configured but its token env unset → legible error", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "");
    stubFetch();
    await expect(makeExecutor(residentOpts(), repoCtx())).rejects.toThrow(/RESIDENT_OPERATOR_TOKEN is not set/);
  });
});
