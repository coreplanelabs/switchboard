import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secretsFrom } from "../secrets.js";
import { AGENTS, type AgentDef } from "../agents/registry.js";
import { declaredProfile } from "../config/profile.js";
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

// The sandbox's GitHub credential is minted per identity (least-privilege), so
// mock the mint to a scope-tagged token: the test asserts the SCOPE requested
// and the token that lands in the sandbox env, without JWT signing or network.
vi.mock("./githubApp.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./githubApp.js")>();
  return {
    ...mod,
    resolveGithubToken: vi.fn(async (scope?: "read" | "write") => `ghs_${scope ?? "write"}`),
  };
});

// Feature: docs/reference/specs/execution.md — per-agent executor provisioning: each
// agent declares the machine class its runs are provisioned on
// (AgentDef.machine); an agent on `none` gets a null executor and no
// sandbox/workspace is ever provisioned.

function dirs(): Pick<ExecutorFactoryOptions, "workspaceDir" | "dataDir"> {
  const dir = mkdtempSync(join(tmpdir(), "swb-factory-"));
  return { workspaceDir: join(dir, "workspaces"), dataDir: join(dir, "data") };
}

/** The context a dispatch hands the factory: the preset and its declared
 *  profile — the run's effective profile when no boundary caps anything. */
const ctxOf = (agent: AgentDef) => ({ threadKey: "slack:CX:1.0", agent, profile: declaredProfile(agent) });
const ctx = (agentName: string) => ctxOf(AGENTS[agentName]);

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
    const { executor: ex, backend } = await makeExecutor(
      { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
      ctx("general"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(backend).toBe("local"); // a null executor runs nothing anywhere: its spans say `local` (docs/reference/specs/tracing.md)
    // Tools reaching a machine-less agent's executor is a config bug — it
    // must surface legibly, naming the class, not crash or provision anything.
    await expect(ex.exec("echo hi")).rejects.toThrow(/machine class "none"/);
  });

  it("an agent declaring no repo gets a null executor with e2b configured (no API key needed)", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const { executor: ex } = await makeExecutor({ execution: { type: "e2b" }, ...dirs() }, ctx("general"));
    await expect(ex.readFile("x")).rejects.toThrow(/machine class "none"/);
  });

  it("an agent declaring no repo creates no workspace directory in local mode", async () => {
    const d = dirs();
    await makeExecutor({ ...d }, ctx("general"));
    expect(existsSync(d.workspaceDir)).toBe(false);
  });

  it("a repo-requiring agent gets a LocalExecutor with a per-thread workspace (local)", async () => {
    const d = dirs();
    const { executor: ex, backend } = await makeExecutor({ ...d }, ctx("coding"));
    expect(ex).toBeInstanceOf(LocalExecutor);
    expect(backend).toBe("local");
    expect(existsSync(join(d.workspaceDir, "slack_CX_1.0"))).toBe(true);
  });

  it("a repo-requiring agent gets the Cloudflare backend when configured", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("GITHUB_APP_ID", ""); // keep githubEnvs off the network
    const { executor: ex, backend } = await makeExecutor(
      { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
      ctx("review"),
    );
    expect(ex).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(backend).toBe("sandbox"); // the per-thread Cloudflare sandbox, on the run's `exec.*` spans
  });

  it("a repo-requiring agent with e2b configured but no API key still fails legibly", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    await expect(makeExecutor({ execution: { type: "e2b" }, ...dirs() }, ctx("coding"))).rejects.toThrow(
      /E2B_API_KEY is not set/,
    );
  });

  // Security: the review agent's sandbox has `gh` + the credential
  // helper, so a write-capable GH_TOKEN there would let the model — or a
  // prompt-injected diff — post/review/push. Least-privilege closes it at the
  // token: a `read` identity gets a READ-scoped token, a `write` identity gets
  // WRITE. (The bot-process review post uses its own write token, unaffected.)
  const envOf = (ex: unknown) =>
    (ex as { opts: { resolveEnvs: () => Promise<Record<string, string>> } }).opts.resolveEnvs();

  it("a readonly agent's sandbox gets a READ-scoped token; a full agent gets WRITE", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.mocked(resolveGithubToken).mockClear();
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
    };
    const review = await makeExecutor(cf, ctx("review")); // identity "read"
    const coding = await makeExecutor(cf, ctx("coding")); // identity "write"

    // …and the scoped token is exactly what lands in the sandbox env.
    expect((await envOf(review.executor)).GH_TOKEN).toBe("ghs_read");
    expect((await envOf(coding.executor)).GH_TOKEN).toBe("ghs_write");
    expect(resolveGithubToken).toHaveBeenCalledWith("read");
    expect(resolveGithubToken).toHaveBeenCalledWith("write");
  });

  // Feature: docs/reference/specs/execution.md item 5 — the credential is resolved when a
  // command runs, never captured when the executor is built (a token captured
  // at build time would expire under a 20-minute first command).
  it("the sandbox credential is resolved per command, not captured at executor construction", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.mocked(resolveGithubToken).mockClear();
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
    };
    const review = await makeExecutor(cf, ctx("review"));
    expect(resolveGithubToken).not.toHaveBeenCalled();

    expect((await envOf(review.executor)).GH_TOKEN).toBe("ghs_read");
    // The mint rotates (a fresh token after the reuse margin): the next command
    // sees the new one, because nothing was captured.
    vi.mocked(resolveGithubToken).mockResolvedValueOnce("ghs_read_rotated");
    expect((await envOf(review.executor)).GH_TOKEN).toBe("ghs_read_rotated");
  });
});

// Feature: docs/reference/specs/resident-repos.md — resident selection: with a
// resolved target repo and execution.resident configured, a warm resident
// serves the thread; any other state falls back to the per-thread backend
// with a NAMED note; probe transport failures are negative-cached so
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
    ...ctxOf(AGENTS.coding),
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
    const { executor, note, binding } = await makeExecutor(residentOpts(), ctxOf(AGENTS.coding));
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBeUndefined();
    expect(binding).toBeUndefined(); // nothing attached on the per-thread path
    expect(fn).not.toHaveBeenCalled();
  });

  it("a poisoned probe reason reaches the note as one redacted line (item 62)", async () => {
    stubEnvs();
    stubFetch({
      body: {
        state: "degraded",
        reason:
          "\x1b[31mrefresh failed\x1b[0m GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nkept slack:C0OTHER:1.2",
      },
    });
    const { executor, note } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBeDefined();
    expect(note).not.toContain("ghp_");
    expect(note).not.toContain("\x1b");
    expect(note).not.toContain("\n");
    expect(note).toContain("resident degraded");
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
          attachMs: 1_900,
          trace: [{ name: "clone", startMs: 100, durationMs: 1_500, status: "ok", exitCode: 0 }],
        },
      },
    );
    const { executor, note, resident, binding, backend, trace, attachMs } = await makeExecutor(
      residentOpts(),
      repoCtx(),
    );
    expect(executor).toBeInstanceOf(ResidentExecutor);
    expect(backend).toBe("resident");
    // The resident's own steps and total ride the selection for the dispatcher's attach span (tracing.md item 19).
    expect(trace).toEqual([{ name: "clone", startMs: 100, durationMs: 1_500, status: "ok", exitCode: 0 }]);
    expect(attachMs).toBe(1_900);
    // The warm path is POSITIVELY named (never inferable only from the absence
    // of a fallback note): ref@short-sha of the attached worktree.
    expect(note).toBe("resident · jshttp/vary · master@abc");
    // The attach answer rides along for the dispatcher: the worktree
    // path for the prompt, the attached sha for the pre-run head check.
    expect(binding).toMatchObject({ ref: "master", sha: "abc", workspace: "/workspace/threads/x/master" });
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

  // docs/reference/specs/resident-repos.md item 50: the review agent (identity
  // `read`) attaches read-only; coding (identity `write`) attaches writable. The
  // bot decides from the run's profile — never from the prompt.
  it("a read-identity agent attaches with readonly:true; a write-identity agent's body has no readonly field", async () => {
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
    await makeExecutor(residentOpts(), { ...repoCtx(), ...ctxOf(AGENTS.review) });
    expect(bodies[1]?.readonly).toBe(true);
    await makeExecutor(residentOpts(), repoCtx()); // AGENTS.coding
    expect(bodies[3]).not.toHaveProperty("readonly");
  });

  // docs/reference/specs/resident-repos.md item 51: a resolved PR head is passed to /attach
  // as `sha` so the resident fetches a mirror whose ref tip lags it (otherwise
  // a re-review right after a push clones a stale tip); no resolved head → no
  // field (older body).
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
      ...ctxOf(AGENTS.review),
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

  // Serviceable non-warm states: the resident keeps serving the last snapshot
  // while `refreshing` (fetch/rebuild under the mirror lock) or `degraded` (a
  // failed refresh; previous checkout intact), and /attach refuses neither —
  // so the bot attaches, and says so on the card.
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

  // A refresh that failed INSIDE the rebuild lock
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
      {
        status: 503,
        body: {
          error: "mirror busy: rebuild in progress",
          state: "refreshing",
          reason: "mirror-busy",
          // The steps the resident ran before refusing (tracing.md item 19).
          trace: [{ name: "mutex_wait", startMs: 0, durationMs: 4_000, status: "ok", waitedMs: 4_000 }],
        },
      },
    );
    const { executor, note, resident, trace } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(resident).toBeFalsy();
    expect(note).toMatch(/^resident attach failed \(.*mirror busy.*\) — using fresh sandbox$/);
    // The failed attach's trace rides the fallback selection so the dispatcher grafts it.
    expect(trace).toEqual([{ name: "mutex_wait", startMs: 0, durationMs: 4_000, status: "ok", waitedMs: 4_000 }]);
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("item 55: a warm probe then a disk-pressure attach (503, the math in `error`) → per-thread fallback, the note carries the whole refusal", async () => {
    stubEnvs();
    const reason =
      // The shape `diskPressureReason` emits since item 62: sizes, counts and
      // keep tokens, never another thread's key.
      "disk-pressure: need 2.47 GiB for a new tree (install), but 3.10 GiB free minus the 2.76 GiB reserve (snapshot staging 1.76 GiB + floor 1.00 GiB) leaves 0.34 GiB — short by 2.13 GiB; evicted 1 idle tree(s) (0.52 GiB back); kept 1 (busy 1)";
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
  // a NAMED note — never a silent stall or a raw ⚠️.
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
  // but the fall-through must be VISIBLE: the user needs to know coding
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

// Feature: docs/reference/specs/execution.md item 18 — the two machine classes
// that never touch the resident registry or Worker. `blank` is a per-thread
// sandbox with an empty workspace: no repository, no credential. `repo-cold`
// is a per-thread sandbox with the checkout and the run's credential, even
// when the repository has a serviceable resident. Both are exercised with
// synthetic agents: no preset declares them yet.
describe("makeExecutor machine classes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetResidentProbeCache();
  });

  /** Cloudflare sandbox AND a resident configured: the classes under test must ignore the latter. */
  const bothBackends = (): ExecutorFactoryOptions => ({
    execution: {
      type: "cloudflare",
      url: "https://sandbox.example",
      resident: { baseUrl: "https://resident.example" },
    },
    ...dirs(),
  });

  const agentOn = (machine: AgentDef["machine"], base: AgentDef = AGENTS.coding): AgentDef => ({
    ...base,
    name: `${base.name}-${machine}`,
    machine,
  });

  /** A fetch that records nothing and fails loudly: no class here may call the network at selection. */
  function poisonFetch() {
    const fn = vi.fn(() => {
      throw new Error("unexpected network call");
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  const optsOf = (ex: unknown) =>
    (ex as { opts: { repo?: string; ref?: string; resolveEnvs: () => Promise<Record<string, string>> } }).opts;

  it("blank → a per-thread sandbox with NO repository and NO credential, no resident probe, even with a repo in the context", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    const fetchSpy = poisonFetch();
    const { executor, note, resident, binding, backend } = await makeExecutor(bothBackends(), {
      ...ctxOf(agentOn("blank")),
      repo: "jshttp/vary",
      ref: "master",
    });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(backend).toBe("sandbox");
    expect(note).toBeUndefined();
    expect(resident).toBeFalsy();
    expect(binding).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    // The workspace is empty: the sandbox is told of no repository to clone…
    expect(optsOf(executor).repo).toBeUndefined();
    expect(optsOf(executor).ref).toBeUndefined();
    // …and holds no GitHub credential: nothing says this run acts as anyone.
    await expect(optsOf(executor).resolveEnvs()).resolves.toEqual({});
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("blank (local) → a per-thread workspace directory, empty", async () => {
    const d = dirs();
    const { executor, backend } = await makeExecutor({ ...d }, ctxOf(agentOn("blank")));
    expect(executor).toBeInstanceOf(LocalExecutor);
    expect(backend).toBe("local");
    expect(existsSync(join(d.workspaceDir, "slack_CX_1.0"))).toBe(true);
  });

  it("repo-cold → a per-thread sandbox WITH the checkout and the run's credential; the resident is never probed though one is configured", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    const fetchSpy = poisonFetch();
    const { executor, note, resident, binding, backend } = await makeExecutor(bothBackends(), {
      ...ctxOf(agentOn("repo-cold")),
      repo: "jshttp/vary",
      ref: "master",
    });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(backend).toBe("sandbox");
    expect(note).toBeUndefined(); // nothing fell back: cold is the class, not a fallback
    expect(resident).toBeFalsy();
    expect(binding).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(optsOf(executor)).toMatchObject({ repo: "jshttp/vary", ref: "master" });
    // The credential is the run's, scoped by the profile's identity: a `write`
    // identity writes, a `read` one reads.
    await expect(optsOf(executor).resolveEnvs()).resolves.toEqual({ GH_TOKEN: "ghs_write" });
    const readonly = await makeExecutor(bothBackends(), {
      ...ctxOf(agentOn("repo-cold", AGENTS.review)),
      repo: "jshttp/vary",
    });
    await expect(optsOf(readonly.executor).resolveEnvs()).resolves.toEqual({ GH_TOKEN: "ghs_read" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Record 0026's invariant (c): the factory provisions from the run's
  // EFFECTIVE profile and nothing else — the preset's own fields are never
  // read again here. Proven by handing it a context whose preset and profile
  // disagree on every axis.
  it("provisions from the profile, never from the preset: the class and identity the context's profile names win over the agent's own fields", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    vi.mocked(resolveGithubToken).mockClear();
    const fetchSpy = poisonFetch();
    // A repo-resident/write preset whose profile says `none`: nothing is provisioned.
    const nothing = await makeExecutor(bothBackends(), {
      threadKey: "slack:CX:1.0",
      agent: AGENTS.coding,
      profile: { machine: "none", identity: "none", minutes: 45 },
      repo: "jshttp/vary",
    });
    await expect(nothing.executor.exec("echo hi")).rejects.toThrow(/machine class "none"/);
    expect(nothing.backend).toBe("local");
    // A `full`-toolset preset whose profile says identity `read`: the sandbox holds a READ token.
    const reading = await makeExecutor(bothBackends(), {
      threadKey: "slack:CX:1.0",
      agent: AGENTS.coding,
      profile: { machine: "repo-cold", identity: "read", minutes: 45 },
      repo: "jshttp/vary",
    });
    await expect(optsOf(reading.executor).resolveEnvs()).resolves.toEqual({ GH_TOKEN: "ghs_read" });
    expect(resolveGithubToken).toHaveBeenLastCalledWith("read");
    // Identity `none` on a class with a checkout: the checkout is cloned anonymously, no token is minted.
    vi.mocked(resolveGithubToken).mockClear();
    const anonymous = await makeExecutor(bothBackends(), {
      threadKey: "slack:CX:1.0",
      agent: AGENTS.coding,
      profile: { machine: "repo-cold", identity: "none", minutes: 45 },
      repo: "jshttp/vary",
    });
    expect(optsOf(anonymous.executor)).toMatchObject({ repo: "jshttp/vary" });
    await expect(optsOf(anonymous.executor).resolveEnvs()).resolves.toEqual({});
    expect(resolveGithubToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repo-cold without a resolved repository → the per-thread sandbox with an empty workspace, no note", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    const fetchSpy = poisonFetch();
    const { executor, note } = await makeExecutor(bothBackends(), ctxOf(agentOn("repo-cold")));
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBeUndefined();
    expect(optsOf(executor).repo).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the null executor's tool error names the class and the classes that provision a workspace", async () => {
    const { executor } = await makeExecutor({ ...dirs() }, ctx("general"));
    await expect(executor.exec("echo hi")).rejects.toThrow(
      'Agent "general" runs on machine class "none", so it has no execution workspace. Declare a machine class that provisions one (`repo-resident`, `repo-cold` or `blank`) if its tools need one.',
    );
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
  const env = secretsFrom({ RESIDENT_OPERATOR_TOKEN: "op-tok" });
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
    expect(residentOnboardedProbe(cfg, secretsFrom({}))).toBeUndefined();
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
  const env = secretsFrom({ RESIDENT_ADMIN_TOKEN: "admin-tok" });

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
    expect(residentSlugsLister(cfg, secretsFrom({}))).toBeUndefined();
    expect(residentSlugsLister({ ...cfg, adminTokenEnv: "OTHER" }, env)).toBeUndefined();
    expect(residentSlugsLister({ ...cfg, adminTokenEnv: "OTHER" }, secretsFrom({ OTHER: "x" }))).toBeDefined();
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
