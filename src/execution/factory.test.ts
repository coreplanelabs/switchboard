import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS } from "../agents/registry.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { LocalExecutor } from "./executor.js";
import { ResidentExecutor, ResidentNeedsRefError } from "./resident.js";
import {
  makeExecutor,
  resetResidentProbeCache,
  residentOnboardedProbe,
  residentSlugsLister,
  type ExecutorFactoryOptions,
} from "./factory.js";
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
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push(new URL(String(url)).pathname);
      bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
      if (next.reject) throw new TypeError(next.reject);
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls, bodies };
  }

  it("ctx.repo undefined → per-thread path with ZERO probe calls (total input contract)", async () => {
    stubEnvs();
    const { fn } = stubFetch();
    const { executor, note, binding } = await makeExecutor(residentOpts(), {
      threadKey: "slack:CX:1.0",
      agent: AGENTS.coding,
    });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBeUndefined();
    expect(binding).toBeUndefined(); // nothing attached on the per-thread path
    expect(fn).not.toHaveBeenCalled();
  });

  it("warm probe → ResidentExecutor, attached on open, with the resident discriminant set", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      {
        body: {
          workspace: "/workspace/threads/x/master",
          ref: "master",
          sha: "abc",
          user: "worker2",
          deps: "hardlink",
        },
      },
    );
    const { executor, note, resident, binding } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    // The warm path is POSITIVELY named (never inferable only from the absence
    // of a fallback note): ref@short-sha of the attached worktree.
    expect(note).toBe("resident · jshttp/vary · master@abc");
    // The attach answer rides along for the dispatcher (#282): the worktree
    // path for the prompt, the attached sha for the pre-run head check.
    expect(binding).toEqual({ ref: "master", sha: "abc", workspace: "/workspace/threads/x/master" });
    // The discriminant is the backend signal the dispatcher branches its
    // resident system-prompt on (never an executor `instanceof`): true ONLY on
    // the warm-resident branch.
    expect(resident).toBe(true);
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("needs-ref WITH the resident's defaultRef → re-attach once on that ref; the note says it was the repo default", async () => {
    stubEnvs();
    const { calls, bodies } = stubFetch(
      { body: { state: "warm", reason: "" } },
      {
        status: 409,
        body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref", defaultRef: "master" },
      },
      {
        body: {
          workspace: "/workspace/threads/x/master",
          ref: "master",
          sha: "abc1234def",
          user: "worker2",
          deps: "hardlink",
        },
      },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), { ...repoCtx(), ref: undefined });
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(resident).toBe(true);
    expect(note).toBe("resident · jshttp/vary · master@abc1234 (repo default — no branch named)");
    expect(calls).toEqual(["/status", "/attach", "/attach"]);
    expect(bodies[1]?.refHint).toBeUndefined(); // first attach: nothing named
    expect(bodies[2]?.refHint).toBe("master"); // re-attach on the resident's default
  });

  // features/resident-repos.md item 50: the review agent (toolset "readonly")
  // attaches read-only; coding (toolset "full") attaches writable. The bot
  // decides from the agent's declared toolset — never from the prompt.
  it("a readonly-toolset agent attaches with readonly:true; a full-toolset agent's body has no readonly field", async () => {
    stubEnvs();
    const attachOk = {
      workspace: "/workspace/threads/x/master",
      ref: "master",
      sha: "abc",
      user: "worker2",
      deps: "hardlink",
    };
    const { bodies } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { body: attachOk },
      { body: { state: "warm", reason: "" } },
      { body: attachOk },
    );
    await makeExecutor(residentOpts(), { ...repoCtx(), agent: AGENTS.review });
    expect(bodies[1]?.readonly).toBe(true);
    await makeExecutor(residentOpts(), repoCtx()); // AGENTS.coding
    expect(bodies[3]).not.toHaveProperty("readonly");
  });

  // features/resident-repos.md item 51: a resolved PR head is passed to /attach
  // as `sha` so the resident fetches a mirror whose ref tip lags it (the #214
  // re-review cloned a stale tip); no resolved head → no field (older body).
  it("a resolved headSha is sent as the attach body's sha; absent headSha sends no sha field", async () => {
    stubEnvs();
    const attachOk = {
      workspace: "/workspace/threads/x/master",
      ref: "master",
      sha: "47c4230692cbc5961682532afb822e9c2f1f40b7",
      user: "worker2",
      deps: "hardlink",
    };
    const { bodies } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { body: attachOk },
      { body: { state: "warm", reason: "" } },
      { body: attachOk },
    );
    await makeExecutor(residentOpts(), {
      ...repoCtx(),
      agent: AGENTS.review,
      headSha: "47c4230692cbc5961682532afb822e9c2f1f40b7",
    });
    expect(bodies[1]).toMatchObject({
      refHint: "master",
      readonly: true,
      sha: "47c4230692cbc5961682532afb822e9c2f1f40b7",
    });
    await makeExecutor(residentOpts(), repoCtx());
    expect(bodies[3]).not.toHaveProperty("sha");
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
      {
        body: {
          workspace: "/workspace/threads/x/master",
          ref: "master",
          sha: "abc",
          user: "worker2",
          deps: "hardlink",
        },
      },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(resident).toBe(true);
    expect(note).toBe("resident refreshing · jshttp/vary · master@abc — attached to the last snapshot");
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("degraded probe → ResidentExecutor, note carries the reason", async () => {
    stubEnvs();
    stubFetch(
      { body: { state: "degraded", reason: "github-unreachable: fetch timed out" } },
      {
        body: {
          workspace: "/workspace/threads/x/master",
          ref: "master",
          sha: "abc",
          user: "worker2",
          deps: "hardlink",
        },
      },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(resident).toBe(true);
    expect(note).toBe(
      "resident degraded (github-unreachable: fetch timed out) · jshttp/vary · master@abc — attached to the last snapshot",
    );
  });

  // Review finding on #162: a refresh that failed INSIDE the rebuild lock
  // (install/build after `git clean -fdx`) leaves a checkout at the new sha with
  // absent/partial deps; a fresh thread would hardlink that broken cache. Those
  // degraded reasons stay cold until the next cycle rebuilds.
  it("degraded by an in-rebuild failure (install-failed) → per-thread fallback, no attach", async () => {
    stubEnvs();
    const { calls } = stubFetch({
      body: { state: "degraded", reason: "install-failed: npm ERR! ERESOLVE unable to resolve dependency tree" },
    });
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toBe(
      "resident degraded (install-failed: npm ERR! ERESOLVE unable to resolve dependency tree) — using fresh sandbox",
    );
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

  it("item 55: a warm probe then a disk-pressure attach (503, the math in `error`) → per-thread fallback, the note carries the whole refusal", async () => {
    stubEnvs();
    const reason =
      "disk-pressure: need 2.47 GiB for a new tree (install), but 3.10 GiB free minus the 2.76 GiB reserve (snapshot staging 1.76 GiB + floor 1.00 GiB) leaves 0.34 GiB — short by 2.13 GiB; evicted 1 idle tree(s) (0.52 GiB back): slack:C1:old; kept 1: slack:C1:busy (2 operation(s) in flight)";
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { status: 503, body: { error: reason, state: "warm", reason: "disk-pressure" } },
    );
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toBe(
      `resident attach failed (resident attach failed for repo:jshttp/vary: ${reason}) — using fresh sandbox`,
    );
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

// resident-repos.md item 29: the resolver's onboarded probe tells a refusal
// (`false`: 404 not-onboarded, a non-transport HTTP error) from a registry
// that did not answer (`"unreachable"`: transport failure/timeout, and the
// outage window it opens) — the resolver refuses an explicit address loudly
// on the latter instead of treating silence as "not onboarded".
describe("residentOnboardedProbe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetResidentProbeCache();
  });
  const cfg = { baseUrl: "https://resident.example" };
  const env = { RESIDENT_OPERATOR_TOKEN: "op-tok" } as NodeJS.ProcessEnv;
  const answer = (status: number, body: unknown = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("true for any lifecycle state of an onboarded resource, false for 404 not-onboarded and for a non-transport HTTP error", async () => {
    answer(200, { state: "down", reason: "provision-failed" });
    await expect(residentOnboardedProbe(cfg, env)?.("acme/api")).resolves.toBe(true);
    answer(404);
    await expect(residentOnboardedProbe(cfg, env)?.("acme/api")).resolves.toBe(false);
    answer(500, { error: "boom" });
    await expect(residentOnboardedProbe(cfg, env)?.("acme/api")).resolves.toBe(false);
  });

  it('"unreachable" for a transport failure — and for the outage window it opens', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fn);
    const probe = residentOnboardedProbe(cfg, env);
    await expect(probe?.("acme/api")).resolves.toBe("unreachable");
    await expect(probe?.("acme/web")).resolves.toBe("unreachable");
    expect(fn).toHaveBeenCalledTimes(1); // the second answer came from the outage window
  });

  it("undefined without the resident config or the operator bearer", () => {
    expect(residentOnboardedProbe(undefined, env)).toBeUndefined();
    expect(residentOnboardedProbe(cfg, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

// resident-repos.md item 29: the registry listing the repo resolver uses to
// turn a bare `in <name>` address into an onboarded `owner/name`. Read with
// the ADMIN bearer (`/residents` is read-scoped, which the operator bearer
// does not open); every failure answers undefined — a name then binds
// nothing, never a guess.
describe("residentSlugsLister", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetResidentProbeCache();
  });
  const cfg = { baseUrl: "https://resident.example/" };
  const env = { RESIDENT_ADMIN_TOKEN: "admin-tok" } as NodeJS.ProcessEnv;

  function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("lists onboarded slugs from GET /residents with the admin bearer — `repo:` prefixes stripped, lowercased", async () => {
    const fn = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            cap: 6,
            residents: [
              { resource: "repo:Acme/API", state: "warm" },
              { resource: "repo:acme/web" },
              { resource: "svc:other" },
              {},
            ],
          }),
        ),
    );
    const list = residentSlugsLister(cfg, env);
    await expect(list?.()).resolves.toEqual(["acme/api", "acme/web"]);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://resident.example/residents");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer admin-tok");
  });

  it("is undefined without the resident config or the admin bearer (names are then ignored by the resolver)", () => {
    expect(residentSlugsLister(undefined, env)).toBeUndefined();
    expect(residentSlugsLister(cfg, {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(residentSlugsLister({ ...cfg, adminTokenEnv: "OTHER" }, env)).toBeUndefined();
    expect(residentSlugsLister({ ...cfg, adminTokenEnv: "OTHER" }, { OTHER: "x" } as NodeJS.ProcessEnv)).toBeDefined();
  });

  it("a non-2xx answer or a body without a residents array is no answer (undefined)", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    await expect(residentSlugsLister(cfg, env)?.()).resolves.toBeUndefined();
    stubFetch(() => new Response("not json"));
    await expect(residentSlugsLister(cfg, env)?.()).resolves.toBeUndefined();
    stubFetch(() => new Response(JSON.stringify({ residents: "x" })));
    await expect(residentSlugsLister(cfg, env)?.()).resolves.toBeUndefined();
  });

  it("a transport failure answers undefined AND opens the shared probe outage window (the next call skips the fetch)", async () => {
    const fn = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const list = residentSlugsLister(cfg, env);
    await expect(list?.()).resolves.toBeUndefined();
    await expect(list?.()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1); // second call answered from the outage window
  });
});
