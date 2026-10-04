import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secretsFrom } from "../secrets.js";
import { AGENTS, type AgentDef } from "../agents/registry.js";
import { declaredProfile } from "../config/profile.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { ExecInfraError, LocalExecutor } from "./executor.js";
import {
  DRAIN_FALLBACK_WAIT_MS,
  DRAIN_POLL_MS,
  ResidentExecutor,
  ResidentNeedsRefError,
  ResidentRegistrationMismatchError,
} from "./resident.js";
import {
  gitIdentityEnvs,
  prepareColdPublicationCheckout,
  makeExecutor,
  resetResidentProbeCache,
  residentOnboardedProbe,
  residentSlugsLister,
  workspaceBindingFor,
  workspaceBindingOf,
  WorkspaceReattachLeaseSpentError,
  WorkspaceReattachRefusedError,
  ReadyEnvironmentError,
  type ExecutorFactoryOptions,
  type WorkspaceBinding,
} from "./factory.js";
import { githubAppConfigured, resolveGithubIdentity, resolveGithubToken } from "./githubApp.js";

// The sandbox's GitHub credential is minted per identity (least-privilege), so
// mock the mint to a scope-tagged token: the test asserts the SCOPE requested
// and the token that lands in the sandbox env, without JWT signing or network.
// The bot identity is mocked to "unknown" by default (no commit identity env
// rides — the images' fallback stands); tests of the four variables set it.
vi.mock("./githubApp.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./githubApp.js")>();
  return {
    ...mod,
    githubAppConfigured: vi.fn(() => true),
    resolveGithubToken: vi.fn(async (scope?: "read" | "write") => `ghs_${scope ?? "write"}`),
    resolveGithubIdentity: vi.fn(async () => undefined),
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
const ctxOf = (agent: AgentDef) => ({
  threadKey: "slack:CX:1.0",
  agent,
  profile: declaredProfile(agent),
  ...(agent.name === "review" ? { runId: "review-fixture" } : {}),
  githubDoor: { baseUrl: "https://door.example", bearer: "sbr_test.secret" },
});
const ctx = (agentName: string) => ctxOf(AGENTS[agentName]);

describe("review sandbox isolation", () => {
  afterEach(() => vi.unstubAllEnvs());

  const opts = () => ({ execution: { type: "cloudflare" as const, url: "https://sandbox.example" }, ...dirs() });
  const keyOf = (selection: Awaited<ReturnType<typeof makeExecutor>>) =>
    (selection.executor as CloudflareSandboxExecutor as unknown as { opts: { threadKey: string } }).opts.threadKey;

  it("separates a coding predecessor and two fresh read-profile reviews of the same logical thread", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    const coding = await makeExecutor(opts(), { ...ctx("coding"), runId: "coding-1" });
    const first = await makeExecutor(opts(), { ...ctx("review"), runId: "review-1" });
    const second = await makeExecutor(opts(), { ...ctx("review"), runId: "review-2" });
    expect(keyOf(coding)).toBe("slack:CX:1.0");
    expect(keyOf(first)).toBe("review:review-1");
    expect(keyOf(second)).toBe("review:review-2");
    expect(new Set([keyOf(coding), keyOf(first), keyOf(second)]).size).toBe(3);
    const binding = workspaceBindingOf(JSON.parse(JSON.stringify(workspaceBindingFor(first))));
    expect(binding).toMatchObject({ backend: "sandbox", sandboxKey: "review:review-1" });
    const resumed = await makeExecutor(opts(), { ...ctx("review"), runId: "review-1", reattach: binding });
    expect(keyOf(resumed)).toBe(keyOf(first));
    expect(workspaceBindingFor(resumed, "repo-resident", binding)).toEqual(binding);
    await expect(
      makeExecutor(
        { ...dirs(), execution: { type: "local" } },
        { ...ctx("review"), runId: "review-1", reattach: binding },
      ),
    ).rejects.toBeInstanceOf(WorkspaceReattachRefusedError);
  });

  it("reattaches a legacy sandbox binding on its original thread key and refuses an invalid stored key", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    const legacy = workspaceBindingOf({ backend: "sandbox" });
    const resumed = await makeExecutor(opts(), { ...ctx("review"), runId: "review-2", reattach: legacy });
    expect(keyOf(resumed)).toBe("slack:CX:1.0");
    expect(workspaceBindingFor(resumed, "repo-resident", legacy)).toEqual(legacy);
    await expect(
      makeExecutor(opts(), { ...ctx("review"), runId: "review-2", reattach: { backend: "sandbox", sandboxKey: "" } }),
    ).rejects.toBeInstanceOf(WorkspaceReattachRefusedError);
    await expect(
      makeExecutor(opts(), {
        ...ctx("review"),
        runId: "review-2",
        reattach: workspaceBindingOf({ backend: "sandbox", sandboxKey: "review:review-1" }),
      }),
    ).rejects.toBeInstanceOf(WorkspaceReattachRefusedError);
  });

  it("refuses to provision a fresh read-profile review without a safe durable run ID", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    await expect(makeExecutor(opts(), { ...ctx("review"), runId: undefined })).rejects.toThrow(/durable run ID/);
    await expect(makeExecutor(opts(), { ...ctx("review"), runId: "bad\nid" })).rejects.toThrow(/durable run ID/);
  });
});

describe("makeExecutor per-agent provisioning", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.mocked(githubAppConfigured).mockReturnValue(true);
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

  it("a local backend gives model commands the run bearer without an App token", async () => {
    const d = dirs();
    vi.mocked(resolveGithubToken).mockClear();
    const writing = await makeExecutor({ ...d }, ctx("coding"));
    expect(writing.executor).toBeInstanceOf(LocalExecutor);
    expect(writing.backend).toBe("local");
    expect(existsSync(join(d.workspaceDir, "slack_CX_1.0"))).toBe(true);
    await expect(writing.executor.exec('printf %s "${GH_TOKEN-unset}|$GH_ENTERPRISE_TOKEN"')).resolves.toBe(
      "unset|sbr_test.secret",
    );

    const reading = await makeExecutor({ ...d }, ctx("review"));
    await expect(reading.executor.exec('printf %s "${GH_TOKEN-unset}|$GH_ENTERPRISE_TOKEN"')).resolves.toBe(
      "unset|sbr_test.secret",
    );
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("a door-backed local run exposes only its revocable run bearer to model commands", async () => {
    const selected = await makeExecutor(
      { ...dirs(), githubCredentials: { assertProfileIdentity: () => {} } },
      {
        ...ctx("coding"),
        repo: "acme/api",
        githubDoor: { baseUrl: "http://127.0.0.1:1234", bearer: "sbr_test.secret", ghConfigDir: "/tmp/gh-config" },
      },
    );
    const env = await selected.executor.exec(
      'printf "%s|%s|%s|%s" "${GH_TOKEN-unset}" "$GH_ENTERPRISE_TOKEN" "$GH_HOST" "$GH_CONFIG_DIR"',
    );
    expect(env).toBe("unset|sbr_test.secret|127.0.0.1:1234|/tmp/gh-config");
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("refuses read and write workspace attach without a door, even when an App or PAT is available", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_static");
    const noDoor = (agent: string) => ({ ...ctx(agent), githubDoor: undefined });
    await expect(makeExecutor({ ...dirs() }, noDoor("review"))).rejects.toThrow(/read.*GitHub door run bearer/i);
    await expect(makeExecutor({ ...dirs() }, noDoor("coding"))).rejects.toThrow(/write.*GitHub door run bearer/i);
    await expect(
      makeExecutor(
        { ...dirs() },
        {
          ...noDoor("coding"),
          profile: { ...ctx("coding").profile, machine: "repo-cold" as const },
        },
      ),
    ).rejects.toThrow(/write.*GitHub door run bearer/i);
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("a repo-requiring agent gets the Cloudflare backend when configured", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
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

  // Both identities use a revocable run bearer; the trusted door enforces
  // read versus write and never gives its App token to a model command.
  const envOf = (ex: unknown) =>
    (ex as { opts: { resolveEnvs: () => Promise<Record<string, string>> } }).opts.resolveEnvs();

  it("read and write sandboxes get only the run bearer", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.mocked(resolveGithubToken).mockClear();
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
    };
    const review = await makeExecutor(cf, ctx("review")); // identity "read"
    const coding = await makeExecutor(cf, ctx("coding")); // identity "write"

    expect((await envOf(review.executor)).GH_ENTERPRISE_TOKEN).toBe("sbr_test.secret");
    expect((await envOf(coding.executor)).GH_ENTERPRISE_TOKEN).toBe("sbr_test.secret");
    expect((await envOf(review.executor)).GH_TOKEN).toBeUndefined();
    expect((await envOf(coding.executor)).GH_TOKEN).toBeUndefined();
    expect(await envOf(coding.executor)).toMatchObject({
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://door.example.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    });
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it("leaves GitHub clones direct even when their names extend the bound repository", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
    };
    const coding = await makeExecutor(cf, { ...ctx("coding"), repo: "acme/api" });
    const env = {
      ...process.env,
      ...(await envOf(coding.executor)),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8" }).trim();

    for (const url of [
      "https://github.com/acme/api.git",
      "git@github.com:acme/api.git",
      "https://github.com/acme/api.git-tools.git",
      "git@github.com:acme/api.git-tools.git",
      "https://github.com/cashapp/hermit-packages.git",
    ])
      expect(git("ls-remote", "--get-url", url)).toBe(url);
    expect((await envOf(coding.executor)).GIT_DOOR_ORIGIN).toBe("https://door.example");
    expect((await envOf(coding.executor)).GIT_DOOR_REMOTE).toBe("https://door.example/git/acme/api.git");
    expect((await envOf(coding.executor)).GH_REPO).toBe("door.example/acme/api");
    expect(git("ls-remote", "--get-url", (await envOf(coding.executor)).GIT_DOOR_REMOTE)).toBe(
      "https://door.example/git/acme/api.git",
    );
    expect(git("config", "--get-urlmatch", "credential.helper", "https://door.example/git/acme/api.git")).toBe(
      "!gh auth git-credential",
    );
    expect(git("config", "--get-urlmatch", "credential.helper", "https://github.com/cashapp/hermit-packages.git")).toBe(
      "",
    );
  });

  it("the sandbox env resolves the run bearer for each command without minting App tokens", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.mocked(resolveGithubToken).mockClear();
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
    };
    const review = await makeExecutor(cf, ctx("review"));
    expect(resolveGithubToken).not.toHaveBeenCalled();

    expect((await envOf(review.executor)).GH_ENTERPRISE_TOKEN).toBe("sbr_test.secret");
    expect((await envOf(review.executor)).GH_ENTERPRISE_TOKEN).toBe("sbr_test.secret");
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  // Feature: docs/reference/specs/execution.md item 5 — the commit identity
  // rides the same resolver as the credential: a write run's sandbox env
  // carries the four variables, the author pair from the requester's stored
  // binding, the committer pair the bot's.
  it("a write run's sandbox env carries the four identity variables — author the bound requester pair, committer the bot pair", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.mocked(resolveGithubIdentity).mockResolvedValue({ login: "switchboard-app[bot]", id: 111 });
    // The stored binding is re-read by id (authorBinding.ts): answer it here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ login: "ivy-dev", id: 4242 }), { status: 200 })),
    );
    const cf: ExecutorFactoryOptions = {
      execution: { type: "cloudflare", url: "https://sandbox.example" },
      ...dirs(),
      bindings: { userGithubBinding: () => ({ login: "ivy-dev", id: 4242 }) },
    };
    const coding = await makeExecutor(cf, { ...ctx("coding"), requester: "slack:U0123" });
    const env = await envOf(coding.executor);
    expect(env).toMatchObject({
      GH_ENTERPRISE_TOKEN: "sbr_test.secret",
      GIT_AUTHOR_NAME: "ivy-dev",
      GIT_AUTHOR_EMAIL: "4242+ivy-dev@users.noreply.github.com",
      GIT_COMMITTER_NAME: "switchboard-app[bot]",
      GIT_COMMITTER_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
    });
    expect(env.GH_TOKEN).toBeUndefined();
    vi.mocked(resolveGithubIdentity).mockResolvedValue(undefined);
  });
});

// Feature: docs/reference/specs/execution.md item 5 — the commit identity env
// (record 0062): a `write` identity's commits are committed by the bot pair
// always and authored by the requester's bound pair (or the bot pair,
// unbound); `read` and `none` get none of the four; an unknown bot pair
// yields none, so the images' fallback identity stands.
describe("gitIdentityEnvs — the commit identity for a run's workspace", () => {
  const BOT = { login: "switchboard-app[bot]", id: 111 };
  const IVY = { login: "ivy-dev", id: 4242 };
  const seams = (over: { bot?: typeof BOT; binding?: typeof IVY } = {}) => ({
    bot: async () => over.bot,
    binding: async () => over.binding,
  });
  const source = { requester: "slack:U0123", bindings: { userGithubBinding: () => ({ ...IVY }) } };

  it("write identity, bound requester: the four variables — author the requester pair, committer the bot pair", async () => {
    await expect(gitIdentityEnvs("write", source, seams({ bot: BOT, binding: IVY }))).resolves.toEqual({
      GIT_AUTHOR_NAME: "ivy-dev",
      GIT_AUTHOR_EMAIL: "4242+ivy-dev@users.noreply.github.com",
      GIT_COMMITTER_NAME: "switchboard-app[bot]",
      GIT_COMMITTER_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
    });
  });

  it("write identity, unbound requester: author and committer both the bot pair", async () => {
    await expect(gitIdentityEnvs("write", source, seams({ bot: BOT }))).resolves.toEqual({
      GIT_AUTHOR_NAME: "switchboard-app[bot]",
      GIT_AUTHOR_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "switchboard-app[bot]",
      GIT_COMMITTER_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
    });
  });

  it("a run with no requester or no binding store reads no binding: the bot pair authors", async () => {
    const binding = vi.fn(async () => IVY);
    await expect(
      gitIdentityEnvs("write", { bindings: source.bindings }, { bot: async () => BOT, binding }),
    ).resolves.toMatchObject({ GIT_AUTHOR_NAME: "switchboard-app[bot]" });
    await expect(
      gitIdentityEnvs("write", { requester: "slack:U0123" }, { bot: async () => BOT, binding }),
    ).resolves.toMatchObject({ GIT_AUTHOR_NAME: "switchboard-app[bot]" });
    expect(binding).not.toHaveBeenCalled();
  });

  it("read and none identities: none of the four, even for a bound requester", async () => {
    await expect(gitIdentityEnvs("read", source, seams({ bot: BOT, binding: IVY }))).resolves.toEqual({});
    await expect(gitIdentityEnvs("none", source, seams({ bot: BOT, binding: IVY }))).resolves.toEqual({});
  });

  it("an unknown bot pair (no GitHub credential) yields none: the image fallback stands", async () => {
    await expect(gitIdentityEnvs("write", source, seams({ binding: IVY }))).resolves.toEqual({});
  });

  it("a binding read that throws falls back to the bot pair, never a failed exec", async () => {
    await expect(
      gitIdentityEnvs("write", source, {
        bot: async () => BOT,
        binding: async () => {
          throw new Error("github unreachable");
        },
      }),
    ).resolves.toMatchObject({ GIT_AUTHOR_NAME: "switchboard-app[bot]" });
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
  }

  /** A fetch whose canned answers may arrive late (`afterMs`, on the fake clock); the request's signal ends one first. */
  function stubFetchLate(...responses: Array<{ status?: number; body?: unknown; afterMs?: number }>) {
    const calls: string[] = [];
    const fn = vi.fn((url: unknown, init?: RequestInit) => {
      calls.push(new URL(String(url)).pathname);
      const next = responses.shift();
      return new Promise<Response>((resolve, reject) => {
        if (!next) return reject(new TypeError(`unexpected fetch: ${String(url)}`));
        const answer = () => resolve(new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 }));
        if (!next.afterMs) return answer();
        const timer = setTimeout(answer, next.afterMs);
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls };
  }

  /** FIFO fetch stub; a canned {reject} entry simulates a network failure, a {raw} entry a non-JSON body (the edge's page). */
  function stubFetch(...responses: Array<{ status?: number; body?: unknown; raw?: string; reject?: string }>) {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push(new URL(String(url)).pathname);
      bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
      if (next.reject) throw new TypeError(next.reject);
      return new Response(next.raw ?? JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
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

  it("uses the run-specific review key only on a resident's Cloudflare fallback", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "down", reason: "offline" } });
    const context = { ...repoCtx(), ...ctxOf(AGENTS.review), runId: "review-3" };
    const selected = await makeExecutor(residentOpts(), context);
    expect(calls).toEqual(["/status"]);
    expect(selected.backend).toBe("sandbox");
    expect(selected.sandboxKey).toBe("review:review-3");
    expect(workspaceBindingFor(selected)?.sandboxKey).toBe("review:review-3");
    expect(
      (selected.executor as CloudflareSandboxExecutor as unknown as { opts: { threadKey: string } }).opts.threadKey,
    ).toBe("review:review-3");
    expect(context.threadKey).toBe("slack:CX:1.0");
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
    const env = await (
      executor as unknown as { opts: { resolveEnvs: () => Promise<Record<string, string>> } }
    ).opts.resolveEnvs();
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://door.example.helper");
    expect(env.GIT_CONFIG_VALUE_1).toContain("password=$GH_ENTERPRISE_TOKEN");
    const gitEnv = { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    expect(
      execFileSync(
        "git",
        ["config", "--get-urlmatch", "credential.helper", "https://github.com/cashapp/hermit-packages.git"],
        {
          env: gitEnv,
          encoding: "utf8",
        },
      ).trim(),
    ).toBe("");
    // The discriminant is the backend signal the dispatcher branches its
    // resident system-prompt on (never an executor `instanceof`): true ONLY on
    // the warm-resident branch.
    expect(resident).toBe(true);
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("a fenced ledger owner stops before resident attach or cold fallback", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "warm", reason: "" } });
    await expect(
      makeExecutor(residentOpts(), {
        ...repoCtx(),
        runId: "run-1",
        ownerGen: "gen-old",
        residentClaim: async () => {
          throw new Error("resident claim refused: fenced");
        },
      }),
    ).rejects.toThrow("resident claim refused: fenced");
    expect(calls).toEqual([]);
  });

  it("a fenced owner cannot provision cold when the resident is down", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "down", reason: "install-failed" } });
    const claim = vi.fn(async (): Promise<number> => {
      throw new Error("resident claim refused: fenced");
    });
    await expect(makeExecutor(residentOpts(), { ...repoCtx(), residentClaim: claim })).rejects.toThrow(
      "resident claim refused: fenced",
    );
    expect(claim).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });

  it("a current owner rechecks before and after taking a cold fallback", async () => {
    stubEnvs();
    const { calls } = stubFetch({ body: { state: "down", reason: "install-failed" } });
    const claim = vi.fn(async () => 7);
    const selection = await makeExecutor(residentOpts(), { ...repoCtx(), residentClaim: claim });
    expect(selection.executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(["/status"]);
  });

  it("a generation reclaimed during the resident probe cannot provision cold", async () => {
    stubEnvs();
    let ownsRun = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(new URL(String(url)).pathname);
        ownsRun = false;
        return new Response(JSON.stringify({ state: "down", reason: "install-failed" }));
      }),
    );
    const claim = vi.fn(async () => {
      if (!ownsRun) throw new Error("resident claim refused: fenced");
      return 7;
    });
    await expect(makeExecutor(residentOpts(), { ...repoCtx(), residentClaim: claim })).rejects.toThrow(
      "resident claim refused: fenced",
    );
    expect(claim).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["/status"]);
  });

  it("a generation reclaimed during the resident probe cannot attach warm", async () => {
    stubEnvs();
    let ownsRun = true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(new URL(String(url)).pathname);
        if (calls.at(-1) === "/status") ownsRun = false;
        return new Response(JSON.stringify({ state: "warm", reason: "" }));
      }),
    );
    const claim = vi.fn(async () => {
      if (!ownsRun) throw new Error("resident claim refused: fenced");
      return 7;
    });
    await expect(makeExecutor(residentOpts(), { ...repoCtx(), residentClaim: claim })).rejects.toThrow(
      "resident claim refused: fenced",
    );
    expect(claim).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["/status"]);
  });

  it("a warm attach uses the fence claimed after its probe", async () => {
    stubEnvs();
    const { bodies } = stubFetch(
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
    let fence = 6;
    const claim = vi.fn(async () => ++fence);
    const selection = await makeExecutor(residentOpts(), {
      ...repoCtx(),
      runId: "run-1",
      ownerGen: "gen-1",
      residentClaim: claim,
    });
    expect(selection.executor).toBeInstanceOf(ResidentExecutor);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(bodies[1]).toMatchObject({ ownerFence: 8 });
  });

  it("a generation reclaimed during warm attach releases its registration before returning", async () => {
    stubEnvs();
    let ownsRun = true;
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined);
        if (path === "/status") return new Response(JSON.stringify({ state: "warm", reason: "" }));
        if (path === "/attach") {
          ownsRun = false;
          return new Response(
            JSON.stringify({ workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" }),
          );
        }
        if (path === "/detach") return new Response(JSON.stringify({ released: true }));
        throw new Error(`unexpected fetch: ${path}`);
      }),
    );
    let fence = 6;
    const claim = vi.fn(async () => {
      if (!ownsRun) throw new Error("resident claim refused: fenced");
      return ++fence;
    });
    await expect(
      makeExecutor(residentOpts(), { ...repoCtx(), runId: "run-1", ownerGen: "gen-1", residentClaim: claim }),
    ).rejects.toThrow("resident claim refused: fenced");
    expect(claim).toHaveBeenCalledTimes(3);
    expect(calls).toEqual(["/status", "/attach", "/detach"]);
    expect(bodies[1]).toMatchObject({ ownerFence: 8 });
    expect(bodies[2]).toMatchObject({ ownerFence: 8 });
  });

  it("a resident registration mismatch never becomes a cold fallback", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { status: 409, body: { error: "run-registration-mismatch: a newer generation owns the thread" } },
    );
    const claim = vi.fn(async () => 7);
    const refused = await makeExecutor(residentOpts(), { ...repoCtx(), residentClaim: claim }).catch(
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(ResidentRegistrationMismatchError);
    expect((refused as Error).message).toContain("run-registration-mismatch");
    expect(claim).toHaveBeenCalledTimes(2);
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
    expect(bodies[1]).not.toHaveProperty("refByDefault");
    expect(bodies[2]?.refHint).toBe("master"); // re-attach on the resident's default
    // …and says so, so the resident records the binding as bound by default
    // (docs/reference/specs/resident-repos.md item 16): the one kind that may later move.
    expect(bodies[2]?.refByDefault).toBe(true);
  });

  // docs/reference/specs/resident-repos.md item 16: the thread's own pull request
  // rides the attach body as the reason for the hint, and the card says what the
  // resident did with it — the move beside the binding line, the way the
  // repo-default note is said, or the refusal that kept the thread where it was.
  describe("the thread's own pull request (ctx.ownPr) and the resident's answer to it", () => {
    const SHA = "47c4230692cbc5961682532afb822e9c2f1f40b7";
    const ownPr = { number: 7, ref: "fix/x" };
    const attached = (over: Record<string, unknown>) => ({
      body: {
        workspace: "/workspace/threads/x/master",
        ref: "master",
        sha: SHA,
        user: "worker2",
        deps: "hardlink",
        ...over,
      },
    });

    it("ctx.ownPr is sent as the attach body's ownPr beside the hint and the head; a context without it sends none", async () => {
      stubEnvs();
      const { bodies } = stubFetch(
        { body: { state: "warm", reason: "" } },
        attached({ ref: "fix/x" }),
        { body: { state: "warm", reason: "" } },
        attached({}),
      );
      await makeExecutor(residentOpts(), { ...repoCtx(), ref: "fix/x", headSha: SHA, ownPr });
      expect(bodies[1]).toEqual({
        resource: "repo:jshttp/vary",
        threadKey: "slack:CX:1.0",
        refHint: "fix/x",
        sha: SHA,
        ownPr,
        runBudgetMs: AGENTS.coding.maxMinutes * 60_000,
        githubDoor: { baseUrl: "https://door.example", bearer: "sbr_test.secret" },
      });
      await makeExecutor(residentOpts(), repoCtx());
      expect(bodies[3]).not.toHaveProperty("ownPr");
    });

    it("an answer that moved the binding names the move on the note beside the binding line, and the binding carries it", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "warm", reason: "" } },
        attached({
          ref: "fix/x",
          rebound: { from: "master", to: "fix/x", pr: 7, at: "2026-01-01T00:00:00.000Z" },
        }),
      );
      const { note, binding } = await makeExecutor(residentOpts(), { ...repoCtx(), ref: "fix/x", headSha: SHA, ownPr });
      expect(note).toBe("resident · jshttp/vary · fix/x@47c4230 · rebound to fix/x (this thread's PR #7)");
      expect(binding?.rebound).toEqual({ from: "master", to: "fix/x", pr: 7 });
    });

    it("an answer that refused the move names the refusal on the note — the run stays where the binding is — and the binding carries why", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "warm", reason: "" } },
        attached({
          rebindRefused: {
            to: "fix/x",
            pr: 7,
            reason: "branch-absent",
            why: 'the mirror does not hold "fix/x" even after a fetch (deleted after a merge, or never pushed); the tree cannot be provisioned at it',
          },
        }),
      );
      const { note, binding } = await makeExecutor(residentOpts(), { ...repoCtx(), ref: "fix/x", headSha: SHA, ownPr });
      expect(note).toBe(
        "resident · jshttp/vary · master@47c4230 · rebind to fix/x (this thread's PR #7) refused: branch-absent",
      );
      expect(binding?.rebindRefused).toEqual({
        to: "fix/x",
        pr: 7,
        reason: "branch-absent",
        why: 'the mirror does not hold "fix/x" even after a fetch (deleted after a merge, or never pushed); the tree cannot be provisioned at it',
      });
    });

    // Item 16's second movement: the thread's branch — one a rebind moved it
    // onto, or one its own run pushed under the name it was bound to — is gone
    // from the mirror, so the resident moved the binding back to the default
    // and provisioned the tree there — the card says so, naming the pull
    // request whose branch it was when the resident named one.
    it("an answer that returned the binding to the default names the move back on the note, and the binding carries it", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "warm", reason: "" } },
        attached({ ref: "master", returned: { from: "fix/x", to: "master", pr: 7, at: "t" } }),
      );
      const { note, binding } = await makeExecutor(residentOpts(), { ...repoCtx(), ref: "fix/x", headSha: SHA, ownPr });
      expect(note).toBe(
        "resident · jshttp/vary · master@47c4230 · returned to master (the branch of this thread's PR #7 is gone)",
      );
      expect(binding?.returned).toEqual({ from: "fix/x", to: "master", pr: 7 });
      expect(binding?.rebound).toBeUndefined();
    });

    it("a return that names no pull request says the branch itself is gone — the card never invents a number", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "warm", reason: "" } },
        attached({ ref: "master", returned: { from: "plan/slug/u1", to: "master", at: "t" } }),
      );
      const { note, binding } = await makeExecutor(residentOpts(), {
        ...repoCtx(),
        ref: "plan/slug/u1",
        headSha: SHA,
        ownPr: { number: 7, ref: "plan/slug/u1" },
      });
      expect(note).toBe(
        "resident · jshttp/vary · master@47c4230 · returned to master (this thread's branch plan/slug/u1 is gone)",
      );
      expect(binding?.returned).toEqual({ from: "plan/slug/u1", to: "master" });
    });

    it("a serviceable non-warm resident says the move before the snapshot note", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "refreshing", reason: "" } },
        attached({ ref: "fix/x", rebound: { from: "master", to: "fix/x", pr: 7, at: "2026-01-01T00:00:00.000Z" } }),
      );
      const { note } = await makeExecutor(residentOpts(), { ...repoCtx(), ref: "fix/x", headSha: SHA, ownPr });
      expect(note).toBe(
        "resident refreshing · jshttp/vary · fix/x@47c4230 · rebound to fix/x (this thread's PR #7) — attached to the last snapshot",
      );
    });
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
    expect(bodies[1]?.runBudgetMs).toBe(AGENTS.review.maxMinutes * 60_000);
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
    const { calls } = stubFetch({ body: { state: "down", reason: "r2-restore-failed: boom" } });
    const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toBe("resident down (r2-restore-failed: boom) — using fresh sandbox");
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

  // docs/reference/specs/execution.md item 27: a probe that finds the resident
  // restoring opens the ONE held /await-restore request instead of falling to
  // the cold fleet — event-driven, no polling, no retry timer — attaches when
  // the answer is serviceable, and names the wait on the card either way. An
  // older Worker's 404 falls back cold with the wait named.
  describe("a restoring resident — the one held /await-restore request (item 27)", () => {
    const attachOk = {
      body: {
        workspace: "/workspace/threads/x/master",
        ref: "master",
        sha: "47c4230692cbc5961682532afb822e9c2f1f40b7",
        user: "worker2",
      },
    };

    it("restoring probe → /await-restore held; a warm answer attaches, the card names the wait", async () => {
      stubEnvs();
      const { calls, bodies } = stubFetch(
        { body: { state: "restoring", reason: "rehydrating" } },
        { body: { state: "warm", reason: "" } },
        attachOk,
      );
      const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(resident).toBe(true);
      expect(calls).toEqual(["/status", "/await-restore", "/attach"]);
      expect(bodies[1]).toEqual({ resource: "repo:jshttp/vary" });
      expect(note).toBe("resident · jshttp/vary · master@47c4230 · after waiting for the resident's restore");
    });

    it("a restore landing on a serviceable non-warm state attaches too, the wait and the snapshot both named", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "restoring", reason: "rehydrating" } },
        { body: { state: "refreshing", reason: "" } },
        attachOk,
      );
      const { note, resident } = await makeExecutor(residentOpts(), repoCtx());
      expect(resident).toBe(true);
      expect(note).toBe(
        "resident refreshing · jshttp/vary · master@47c4230 — attached to the last snapshot · after waiting for the resident's restore",
      );
    });

    it("an older Worker's 404 → cold fallback with the wait named as unsupported; no attach", async () => {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "restoring", reason: "rehydrating" } },
        { status: 404, body: { error: "unknown route" } },
      );
      const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(resident).toBeFalsy();
      expect(calls).toEqual(["/status", "/await-restore"]);
      expect(note).toBe(
        "resident restoring (rehydrating) — this Worker has no /await-restore route, " +
          "so waiting for the resident's restore is not possible — using fresh sandbox",
      );
    });

    it("a restore landing on a non-serviceable state → cold fallback naming the state AND the wait", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "restoring", reason: "rehydrating" } },
        { body: { state: "down", reason: "r2-restore-failed: boom" } },
      );
      const { note, resident } = await makeExecutor(residentOpts(), repoCtx());
      expect(resident).toBeFalsy();
      expect(note).toBe(
        "resident down (r2-restore-failed: boom) after waiting for the resident's restore — using fresh sandbox",
      );
    });

    it("a wait that fails in transport → cold fallback naming the failed wait; never a throw", async () => {
      stubEnvs();
      stubFetch({ body: { state: "restoring", reason: "rehydrating" } }, { reject: "fetch failed" });
      const { executor, note } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(note).toMatch(
        /^resident restoring — waiting for the resident's restore failed \(.*fetch failed.*\) — using fresh sandbox$/,
      );
    });

    it("the run's own stop during the hold is the stop's typed shape, never a cold fallback on the view the stop produced", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        stubFetchLate(
          { body: { state: "restoring", reason: "rehydrating" } },
          { body: { state: "warm", reason: "" }, afterMs: 9 * 60_000 },
        );
        const control = new AbortController();
        let settled: unknown;
        void makeExecutor(residentOpts(), { ...repoCtx(), stopSignal: control.signal }).catch(
          (e: unknown) => (settled = e),
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBeUndefined();
        control.abort();
        await vi.advanceTimersByTimeAsync(1);
        expect((settled as { reason?: string }).reason).toBe("aborted");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a wait that lands warm but whose attach then fails → cold fallback naming the attach failure AND the wait", async () => {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "restoring", reason: "rehydrating" } },
        { body: { state: "warm", reason: "" } },
        { status: 503, body: { error: "mirror-busy: reprovisioning" } },
      );
      const { executor, note, resident } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(resident).toBeFalsy();
      expect(calls).toEqual(["/status", "/await-restore", "/attach"]);
      expect(note).toMatch(
        /^resident attach failed \(.*mirror-busy.*\) after waiting for the resident's restore — using fresh sandbox$/,
      );
    });
  });

  // AE6 (3-reviewer-corroborated): the resident can degrade between the warm
  // /status probe and /attach (503 mirror-busy, 429 pool-exhausted). Any attach
  // failure that is NOT needs-ref must fall back to the per-thread backend with
  // a NAMED note — never a silent stall or a raw ⚠️.
  // Issue 2101: the first attach has the sandbox fallback below to fall to, so
  // a drained fleet is waited for under the FALLBACK's own cost — never the
  // deploy's — and the drain's wait rides the selection so the run's
  // `drain_wait` note still publishes (the incident's run counted zero).
  it("a drained fleet's first attach falls to the sandbox after the fallback's own bound, the wait riding the selection as drainWaitMs (issue 2101)", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const draining = {
        status: 503,
        body: {
          error: "draining: the resident fleet is closed to new runs for deploy 62e4e9a — the run waits at its attach",
          status: 503,
          draining: { since: "2026-09-18T05:00:00.000Z", until: "2026-09-18T06:00:00.000Z", by: "deploy all" },
        },
      };
      const polls = DRAIN_FALLBACK_WAIT_MS / DRAIN_POLL_MS;
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        ...Array.from({ length: polls + 1 }, () => draining),
      );
      const p = makeExecutor(residentOpts(), repoCtx());
      await vi.advanceTimersByTimeAsync(DRAIN_FALLBACK_WAIT_MS + 1_000);
      const { executor, resident, note, drainWaitMs } = await p;
      expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(resident).toBeFalsy();
      expect(drainWaitMs).toBe(DRAIN_FALLBACK_WAIT_MS);
      expect(note).toMatch(
        /^resident attach failed \(.*did not reopen within the 180s this run could wait.*\) — using fresh sandbox$/,
      );
      expect(calls).toEqual(["/status", ...Array.from({ length: polls + 1 }, () => "/attach")]);
    } finally {
      vi.useRealTimers();
    }
  });

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

  // The run's FIRST attach waits too (docs/reference/specs/execution.md item 9):
  // a 500 the Worker typed as the platform's transient — the Durable Object
  // reset or lost under the attach — is a hiccup a re-probe clears, so the
  // client's own wake wait (probe, re-attach) runs before any cold fallback,
  // and the run gets the warm resident it came for. The deterministic refusal
  // above still falls back cold at once, with no probe.
  it("warm probe then a TRANSIENT attach failure → the wake wait (a probe, a re-attach) and the ResidentExecutor, never a cold fallback", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
        { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } },
        { body: { state: "warm", reason: "", inFlight: 0 } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      const p = makeExecutor(residentOpts(), repoCtx());
      await vi.advanceTimersByTimeAsync(5_000);
      const { executor, resident, note, binding } = await p;
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(resident).toBe(true);
      expect(binding).toMatchObject({ ref: "master", sha: "abc", wokeAfterMs: 5_000 });
      // The wait is on the card, as item 27's restore wait is.
      expect(note).toBe("resident · jshttp/vary · master@abc · after waiting 5s for the resident");
      expect(calls).toEqual(["/status", "/attach", "/status", "/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failure beside a pending stop is that failure, not the stop: a deterministic attach refusal with the run's stop already requested still falls back cold, named — only the executor's typed aborted error reads as the stop", async () => {
    stubEnvs();
    const { calls } = stubFetch(
      { body: { state: "warm", reason: "" } },
      { body: { error: "attach-failed at clone: exit 128", status: 500 } },
    );
    const control = new AbortController();
    control.abort();
    const { executor, note } = await makeExecutor(residentOpts(), { ...repoCtx(), stopSignal: control.signal });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(note).toMatch(/^resident attach failed \(.*exit 128.*\) — using fresh sandbox$/);
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("the needs-ref retry by default draws on the first attach's one budget and the card names the total wait: a blip cleared before the 409 and another before the binding is one `after waiting 10s`", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const restoring = { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } };
      const warm = { body: { state: "warm", reason: "", inFlight: 0 } };
      const transient = { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } };
      const { calls, bodies } = stubFetch(
        { body: { state: "warm", reason: "" } },
        transient,
        restoring,
        warm,
        {
          status: 409,
          body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref", defaultRef: "main" },
        },
        transient,
        restoring,
        warm,
        { body: { workspace: "/workspace/threads/x/main", ref: "main", sha: "abc", user: "worker2" } },
      );
      const p = makeExecutor(residentOpts(), repoCtx());
      await vi.advanceTimersByTimeAsync(10_000);
      const { note, binding } = await p;
      expect(binding).toMatchObject({ ref: "main", wokeAfterMs: 10_000 });
      expect(note).toBe(
        "resident · jshttp/vary · main@abc (repo default — no branch named) · after waiting 10s for the resident",
      );
      expect(bodies[5]).toMatchObject({ refHint: "main", refByDefault: true });
      expect(calls).toEqual([
        "/status",
        "/attach",
        "/status",
        "/status",
        "/attach",
        "/attach",
        "/status",
        "/status",
        "/attach",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the retry's budget is what the first attach's WAIT left, never what its own latency took: a first attach that spends 40s reconciling before it answers needs-ref, with no wait, leaves the retry by default the whole minute", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const restoring = { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } };
      const warm = { body: { state: "warm", reason: "", inFlight: 0 } };
      const transient = { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } };
      const { calls } = stubFetchLate(
        { body: { state: "warm", reason: "" } },
        // The first attach's own work (a stale mirror fetched) before the 409: the attach's time, not the wake's.
        {
          status: 409,
          body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref", defaultRef: "main" },
          afterMs: 40_000,
        },
        transient,
        ...Array.from({ length: 10 }, () => restoring),
        warm,
        { body: { workspace: "/workspace/threads/x/main", ref: "main", sha: "abc", user: "worker2" } },
      );
      const p = makeExecutor(residentOpts(), repoCtx());
      // t=40 s the 409; the retry's blip waits 50 s (restoring at t=40..85, warm at t=90) — inside the retry's full minute.
      await vi.advanceTimersByTimeAsync(90_000);
      const { executor, note } = await p;
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(note).toBe(
        "resident · jshttp/vary · main@abc (repo default — no branch named) · after waiting 50s for the resident",
      );
      expect(calls.filter((c) => c === "/attach")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one budget across the needs-ref retry: a first wait that spent 55s of the minute leaves the retry 5s, so the attach falls cold at the minute — never a second full minute", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const restoring = { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } };
      const warm = { body: { state: "warm", reason: "", inFlight: 0 } };
      const transient = { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } };
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        transient,
        ...Array.from({ length: 11 }, () => restoring),
        warm,
        {
          status: 409,
          body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref", defaultRef: "main" },
        },
        transient,
        ...Array.from({ length: 4 }, () => restoring),
      );
      let settled: { note?: string } | undefined;
      const p = makeExecutor(residentOpts(), repoCtx()).then((s) => (settled = s));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled?.note).toMatch(
        /^resident attach failed \(.*waited 5s for the resident to come back.*\) — using fresh sandbox$/,
      );
      expect(calls.slice(0, 2)).toEqual(["/status", "/attach"]);
      expect(calls.filter((c) => c === "/attach")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a transient blip the first probe already shows cleared re-attaches at once — no pause, no second probe — and a wait under a second is not named on the card", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
        { body: { state: "warm", reason: "", inFlight: 0 } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      const { executor, resident, note, binding } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(resident).toBe(true);
      expect(binding).toMatchObject({ ref: "master", sha: "abc", wokeAfterMs: 0 });
      expect(note).toBe("resident · jshttp/vary · master@abc");
      expect(calls).toEqual(["/status", "/attach", "/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hard stop during the first attach's wake wait ends it at once with the stop's typed error — the run's control rides into the factory as `stopSignal` — and a stopped run is never provisioned cold", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
        { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } },
      );
      const control = new AbortController();
      const p = makeExecutor(residentOpts(), { ...repoCtx(), stopSignal: control.signal }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      control.abort();
      const err = await p;
      expect(err).toBeInstanceOf(Error);
      expect((err as { reason?: string }).reason).toBe("aborted");
      expect((err as Error).message).toBe(
        "resident /attach: stopped waiting for the resident to wake: the run was stopped",
      );
      // The wait was in its pause: one probe, no re-attach, and no cold fallback (no sandbox call).
      expect(calls).toEqual(["/status", "/attach", "/status"]);
    } finally {
      vi.useRealTimers();
    }
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
      { body: { state: "onboarding", reason: "" } },
      { body: { state: "down", reason: "r2-restore-failed: boom" } },
    );
    const first = await makeExecutor(residentOpts(), repoCtx());
    expect(first.note).toBe("resident onboarding — using fresh sandbox");
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
    expect(fn).toHaveBeenCalledTimes(1); // circuit breaker: one connection failure per outage window
  });

  // resident-repos.md item 25: a deadline miss is the host answering slowly,
  // not the service gone. Live, one /status in 1,633 was cancelled at the old
  // 2 s deadline on a healthy resident and sent its run cold — and, through
  // the breaker, every dispatch of the next 30 s with it.
  it("a probe that misses its deadline falls cold for THIS dispatch alone and arms NO outage window: the next dispatch probes again", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetchLate(
        { body: { state: "warm", reason: "" }, afterMs: 60_000 },
        { body: { state: "warm", reason: "" }, afterMs: 60_000 },
      );
      let first: { note?: string; executor?: unknown } | undefined;
      void makeExecutor(residentOpts(), repoCtx()).then((s) => (first = s));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(first?.executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(first?.note).toBe("resident unreachable (the 8s call deadline passed) — using fresh sandbox");
      let second: { note?: string } | undefined;
      void makeExecutor(residentOpts(), repoCtx()).then((s) => (second = s));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(second?.note).toBe("resident unreachable (the 8s call deadline passed) — using fresh sandbox");
      expect(second?.note).not.toMatch(/outage window/);
      expect(calls).toEqual(["/status", "/status"]); // the second dispatch probed: nothing was cached
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default probe deadline is 8 s: a resident that answers at 7.9 s is selected warm", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetchLate(
        { body: { state: "warm", reason: "" }, afterMs: 7_900 },
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
      let settled: { executor?: unknown } | undefined;
      void makeExecutor(residentOpts(), repoCtx()).then((s) => (settled = s));
      await vi.advanceTimersByTimeAsync(7_899);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(101);
      expect(settled?.executor).toBeInstanceOf(ResidentExecutor);
      expect(calls).toEqual(["/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a transport failure met on a re-probe inside the blip wait ends the wait at once AND opens the outage breaker, as the first probe's would: the next dispatch inside the window skips the fetch", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { fn } = stubFetch(
        { status: 500, body: { error: "internal error", status: 500, transient: true } },
        { reject: "fetch failed" },
      );
      const first = await makeExecutor(residentOpts(), repoCtx());
      expect(first.executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(first.note).toMatch(/^resident unreachable \(.*fetch failed.*\) — using fresh sandbox$/);
      const second = await makeExecutor(residentOpts(), repoCtx());
      expect(second.executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(second.note).toMatch(/probe skipped during outage window/);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hard stop that lands inside a re-probe of the blip wait opens NO outage window — the stop's signal decides before the error's name, as at every send — so the next dispatch in the process probes", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
      // The probe is the blip; its at-once re-probe hangs; the stop lands inside it.
      const hung = stubFetchLate(transient, { ...transient, afterMs: 60_000 });
      const control = new AbortController();
      let settled: unknown;
      void makeExecutor(residentOpts(), { ...repoCtx(), stopSignal: control.signal }).catch(
        (e: unknown) => (settled = e),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBeUndefined();
      control.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect((settled as { reason?: string }).reason).toBe("aborted");
      expect(hung.calls).toEqual(["/status", "/status"]);
      // The next dispatch fetches: no `probe skipped during outage window`.
      const next = stubFetch(
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      const { executor, note } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(note).toBe("resident · jshttp/vary · master@abc");
      expect(next.calls).toEqual(["/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hard stop that lands inside the FIRST probe of a dead resident is the stop, not a transport failure that arms the breaker: the probe carries the run's stop as every re-probe does, the run ends `aborted`, and the next dispatch probes", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      // A dead resident: the first probe hangs; the stop lands 200 ms in.
      const hung = stubFetchLate({ body: { state: "warm", reason: "" }, afterMs: 60_000 });
      const control = new AbortController();
      let settled: unknown;
      void makeExecutor(residentOpts(), { ...repoCtx(), stopSignal: control.signal }).catch(
        (e: unknown) => (settled = e),
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBeUndefined();
      control.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect((settled as { reason?: string }).reason).toBe("aborted");
      expect(hung.calls).toEqual(["/status"]);
      const next = stubFetch(
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      const { executor } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(next.calls).toEqual(["/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an edge 5xx — the platform's own page, no Worker document — held for the whole blip wait arms the outage window as a transport failure would, so an edge outage costs one wait, not one per concurrent dispatch; the Worker's own typed blip never arms it", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const edge = {
        status: 502,
        raw: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>",
      };
      // The probe, its at-once re-probe, then one every 5 s to the budget's edge: 14 in all.
      const { fn } = stubFetch(...Array.from({ length: 14 }, () => edge));
      let settled: { note?: string } | undefined;
      const p = makeExecutor(residentOpts(), repoCtx()).then((s) => (settled = s));
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      expect(settled?.note).toBe(
        "resident unreachable (probe HTTP 502: no Worker document in the answer) after waiting 60s — using fresh sandbox",
      );
      expect(fn).toHaveBeenCalledTimes(14);
      // Inside the window the next dispatch skips the fetch, the wait named.
      const second = await makeExecutor(residentOpts(), repoCtx());
      expect(second.executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(second.note).toMatch(
        /the edge's own page \(no Worker document\) for 14 of 14 probes over 60s; probe skipped during outage window/,
      );
      expect(fn).toHaveBeenCalledTimes(14);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the window is armed by what the wait was SPENT on — more edge pages than Worker-typed blips among its views — never by its last view alone: an edge wait that ends on one Worker-typed view still arms it, and a Worker-typed wait that ends on one edge page arms nothing", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const edge = {
        status: 502,
        raw: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>",
      };
      const typed = { status: 500, body: { error: "internal error", status: 500, transient: true } };
      // (a) 13 edge pages, then the last view Worker-typed: the platform did not answer for the wait — armed.
      const a = stubFetch(...Array.from({ length: 13 }, () => edge), typed);
      let first: { note?: string } | undefined;
      const p1 = makeExecutor(residentOpts(), repoCtx()).then((s) => (first = s));
      await vi.advanceTimersByTimeAsync(60_000);
      await p1;
      expect(first?.note).toBe(
        "resident unreachable (probe HTTP 500: internal error) after waiting 60s — using fresh sandbox",
      );
      const afterA = await makeExecutor(residentOpts(), repoCtx());
      expect(afterA.note).toMatch(/probe skipped during outage window/);
      expect(a.fn).toHaveBeenCalledTimes(14);
      // (b) 13 Worker-typed blips, then one edge page at the end: the Durable Object's blip, not an outage — nothing armed.
      resetResidentProbeCache();
      const b = stubFetch(
        ...Array.from({ length: 13 }, () => typed),
        edge,
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      let second: { note?: string } | undefined;
      const p2 = makeExecutor(residentOpts(), repoCtx()).then((s) => (second = s));
      await vi.advanceTimersByTimeAsync(60_000);
      await p2;
      expect(second?.note).toBe(
        "resident unreachable (probe HTTP 502: no Worker document in the answer) after waiting 60s — using fresh sandbox",
      );
      const afterB = await makeExecutor(residentOpts(), repoCtx());
      expect(afterB.executor).toBeInstanceOf(ResidentExecutor);
      expect(b.fn).toHaveBeenCalledTimes(16);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an edge 5xx on the selection's /attach is the same blip: `attach()` waits it through and the next serving view binds, instead of a plain error that falls cold a minute after the probe waited", async () => {
    // Fake timers: the wait's clock is the system clock, and the at-once
    // re-attach is 0 ms only on a clock that does not move by itself.
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        { status: 502, raw: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>" },
        { body: { state: "warm", reason: "", inFlight: 0 } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      const { executor, note, binding } = await makeExecutor(residentOpts(), repoCtx());
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(binding).toMatchObject({ ref: "master", sha: "abc", wokeAfterMs: 0 });
      expect(note).toBe("resident · jshttp/vary · master@abc");
      expect(calls).toEqual(["/status", "/attach", "/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the executor a dispatch builds carries the run's clock (`ExecutorContext.remainingMs` → `ResidentExecutorOptions.remainingMs`): a container op it runs later with 90s of run left meets a rollout and its re-attach is struck at 30s, never held for the five-minute default", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const { calls } = stubFetchLate(
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
        { body: { error: "not-serviceable: The container just exited", status: 503, state: "warm", reason: "" } },
        { body: { state: "warm", reason: "" } },
        { body: { state: "warm", reason: "" } },
        {
          body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" },
          afterMs: 30 * 60_000,
        },
      );
      let left: number | undefined; // undefined until the harness starts the lease
      const { executor } = await makeExecutor(residentOpts(), { ...repoCtx(), remainingMs: () => left });
      expect(executor).toBeInstanceOf(ResidentExecutor);
      left = 90_000;
      let settled: unknown;
      const p = executor.exec("alive-probe", { timeoutMs: 60_000 }).catch((e: unknown) => (settled = e));
      await vi.advanceTimersByTimeAsync(34_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBeInstanceOf(ExecInfraError);
      expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
      expect((settled as Error).message).toContain("the re-attach after 35s did not answer");
      expect((settled as Error).message).toContain("the 30s call deadline passed");
      expect(calls).toEqual(["/status", "/attach", "/exec", "/status", "/status", "/attach"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a configured `probeTimeoutMs` bounds every probe of the selection's wait, not only the first: a re-probe that hangs is the deadline passing at the configured second (8 s by default), never at the wake's 5 s, so the operator's cold-fallback pace holds through the blip", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
      for (const { probeTimeoutMs, deadline } of [
        { probeTimeoutMs: 1_000, deadline: "1s" },
        { probeTimeoutMs: undefined, deadline: "8s" },
      ]) {
        resetResidentProbeCache();
        const { calls } = stubFetchLate(transient, { ...transient, afterMs: 60_000 });
        const opts: ExecutorFactoryOptions = {
          ...residentOpts(),
          execution: {
            type: "cloudflare",
            url: "https://sandbox.example",
            resident: { baseUrl: "https://resident.example", ...(probeTimeoutMs ? { probeTimeoutMs } : {}) },
          },
        };
        let settled: { note?: string } | undefined;
        void makeExecutor(opts, repoCtx()).then((s) => (settled = s));
        await vi.advanceTimersByTimeAsync((probeTimeoutMs ?? 8_000) - 1);
        expect(settled, deadline).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled?.note).toBe(
          `resident unreachable (the ${deadline} call deadline passed) after waiting ${deadline} — using fresh sandbox`,
        );
        expect(calls).toEqual(["/status", "/status"]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("an attach that fails after the probe waited through a blip names that wait too, so a run that started late and then fell cold says why", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
      // The probe, its at-once re-probe, then one every 5 s: transient until the view at t=45 s serves.
      const { calls } = stubFetch(
        ...Array.from({ length: 10 }, () => transient),
        { body: { state: "warm", reason: "" } },
        { body: { error: "attach-failed at clone: exit 128", status: 500 } },
      );
      const p = makeExecutor(residentOpts(), repoCtx());
      await vi.advanceTimersByTimeAsync(45_000);
      const { executor, note } = await p;
      expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(note).toMatch(/^resident attach failed \(.*exit 128.*\) after waiting 45s — using fresh sandbox$/);
      expect(calls.filter((c) => c === "/status")).toHaveLength(11);
      expect(calls.at(-1)).toBe("/attach");
    } finally {
      vi.useRealTimers();
    }
  });

  // The selection probe meets the blip the attach's wait exists for, a moment
  // earlier (execution.md item 9): the Worker's catch-all 500 on /status carries
  // `transient: true`, so the probe is waited through — re-probed under the
  // first attach's budget — instead of sending the run cold and, worse, opening
  // the outage breaker for a blip that is not an outage.
  it("a /status probe the Worker typed transient is waited through, not a cold fallback: the DO reset under the probe is re-probed under the first attach's budget, the next warm view attaches, the card names the wait, and the breaker stays closed", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      // The first re-probe is at once (a blip the DO has already recovered from
      // costs no pause); the second follows the poll.
      const { calls, fn } = stubFetch(
        { status: 500, body: { error: "internal error", status: 500, transient: true } },
        { status: 500, body: { error: "internal error", status: 500, transient: true } },
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      const p = makeExecutor(residentOpts(), repoCtx());
      await vi.advanceTimersByTimeAsync(5_000);
      const { executor, note } = await p;
      expect(executor).toBeInstanceOf(ResidentExecutor);
      expect(note).toBe("resident · jshttp/vary · master@abc · after waiting 5s for the resident");
      expect(calls).toEqual(["/status", "/status", "/status", "/attach"]);
      // The typed blip is not the breaker's outage: the next dispatch probes again.
      const second = await makeExecutor(residentOpts(), repoCtx());
      expect(second.executor).toBeInstanceOf(ResidentExecutor);
      expect(fn).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a probe still transient past the first attach's budget falls cold with the wait named, and the breaker stays closed for the next dispatch", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
      // The probe, its at-once re-probe, then one every 5 s to the budget's edge: 14 in all.
      const { fn } = stubFetch(
        ...Array.from({ length: 14 }, () => transient),
        { body: { state: "warm", reason: "" } },
        { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: "abc", user: "worker2" } },
      );
      let settled: { note?: string } | undefined;
      const p = makeExecutor(residentOpts(), repoCtx()).then((s) => (settled = s));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled?.note).toBe(
        "resident unreachable (probe HTTP 500: internal error) after waiting 60s — using fresh sandbox",
      );
      expect(fn).toHaveBeenCalledTimes(14);
      const second = await makeExecutor(residentOpts(), repoCtx());
      expect(second.executor).toBeInstanceOf(ResidentExecutor);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hard stop during the probe's wait ends it at once with the stop's typed error — a stopped run is never provisioned cold", async () => {
    vi.useFakeTimers();
    try {
      stubEnvs();
      // The probe and its at-once re-probe both transient; the stop lands in the pause that follows.
      stubFetch(
        { status: 500, body: { error: "internal error", status: 500, transient: true } },
        { status: 500, body: { error: "internal error", status: 500, transient: true } },
      );
      const control = new AbortController();
      let settled: unknown;
      void makeExecutor(residentOpts(), { ...repoCtx(), stopSignal: control.signal }).catch(
        (e: unknown) => (settled = e),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBeUndefined();
      control.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect((settled as { reason?: string }).reason).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
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

  it("404 not-onboarded with the registry answering names the resident the typed repo is near (record 0054)", async () => {
    stubEnvs();
    vi.stubEnv("RESIDENT_ADMIN_TOKEN", "atok");
    resetResidentProbeCache();
    const { fn } = stubFetch(
      { status: 404, body: { error: "unknown resource" } },
      { body: { residents: [{ resource: "repo:jshttp/vary" }, { resource: "repo:acme/api" }] } },
    );
    const { note } = await makeExecutor(residentOpts(), { ...ctxOf(AGENTS.coding), repo: "jshttp/var", ref: "master" });
    expect(note).toContain("did you mean `jshttp/vary`?");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  });

  it("resident configured but its token env unset → legible error", async () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "");
    stubFetch();
    await expect(makeExecutor(residentOpts(), repoCtx())).rejects.toThrow(/RESIDENT_OPERATOR_TOKEN is not set/);
  });

  // Feature: docs/reference/specs/run-history.md item 54, resident-repos.md item 66:
  // a resumed run re-attaches where its row says it ran, and never provisions
  // again: the resident is asked to keep the tree as it stands, a refusal or an
  // unreachable resident is a typed error the dispatcher restarts the run on,
  // and the backend the row recorded is the only one consulted.
  describe("on a resume (ctx.reattach): re-attach, never re-provision", () => {
    const recorded: WorkspaceBinding = {
      backend: "resident",
      workspace: "/workspace/threads/t/master",
      user: "worker2",
      container: "vm-1",
    };
    const attachOk = (over: Record<string, unknown> = {}) => ({
      body: {
        workspace: "/workspace/threads/t/master",
        ref: "master",
        sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05",
        user: "worker2",
        container: "vm-1",
        recreated: false,
        ...over,
      },
    });

    it("a recorded resident binding attaches with reuse:true and answers the resident executor, its binding carrying the container", async () => {
      stubEnvs();
      const { calls, bodies } = stubFetch({ body: { state: "warm", reason: "" } }, attachOk());
      const sel = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded });
      expect(sel.executor).toBeInstanceOf(ResidentExecutor);
      expect(sel.resident).toBe(true);
      expect(calls).toEqual(["/status", "/attach"]);
      expect(bodies[1]).toMatchObject({ reuse: true, refHint: "master" });
      expect(sel.binding?.container).toBe("vm-1");
      expect(workspaceBindingFor(sel)).toEqual({
        ...recorded,
        ref: "master",
        publicationBaseSha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05",
      });
    });

    it("a fresh run (no reattach) never sends reuse: the body is the one every fresh attach always sent", async () => {
      stubEnvs();
      const { bodies } = stubFetch({ body: { state: "warm", reason: "" } }, attachOk());
      await makeExecutor(residentOpts(), repoCtx());
      expect(bodies[1]).not.toHaveProperty("reuse");
    });

    it("a resume never asks the resident to move the tree: the thread's own PR is not sent, whatever the context resolved (docs/reference/specs/resident-repos.md item 16)", async () => {
      stubEnvs();
      const { bodies } = stubFetch({ body: { state: "warm", reason: "" } }, attachOk());
      await makeExecutor(residentOpts(), { ...repoCtx(), ownPr: { number: 7, ref: "fix/x" }, reattach: recorded });
      expect(bodies[1]).toMatchObject({ reuse: true });
      expect(bodies[1]).not.toHaveProperty("ownPr");
    });

    // A resumed run's re-attach is that dispatch's first attach: it waits
    // through a transient refusal under the same budget the first attach has
    // and the same stop ends it — never the wake ceiling, unstoppable.
    it("a resumed run's re-attach waits through a transient refusal under the first attach's budget: past it the wait's strike is the re-attach refusal, naming the wait", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        const restoring = { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } };
        const { calls } = stubFetch(
          { body: { state: "warm", reason: "" } },
          { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
          ...Array.from({ length: 14 }, () => restoring),
        );
        let settled: unknown;
        const p = makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch(
          (e: unknown) => (settled = e),
        );
        await vi.advanceTimersByTimeAsync(59_999);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(settled).toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((settled as WorkspaceReattachRefusedError).why).toContain("waited 60s for the resident to come back");
        // The selection probe and the attach, then a wake probe every 5 s from t=0 to the budget's edge.
        expect(calls.slice(0, 2)).toEqual(["/status", "/attach"]);
        expect(calls).toHaveLength(15);
      } finally {
        vi.useRealTimers();
      }
    });

    // The resumed run's selection probe meets the blip a moment before its attach
    // would (execution.md item 9): waited through as a fresh run's is, the wait
    // drawn from the same minute and named on the note — never the refusal that
    // would close the run and dispatch its request again for a blip.
    it("a resumed run's /status probe the Worker typed transient is waited through, not a re-attach refusal: the next warm view re-attaches the run's worktree, and the note names the wait", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
        const { calls } = stubFetch(transient, transient, { body: { state: "warm", reason: "" } }, attachOk());
        const p = makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded });
        await vi.advanceTimersByTimeAsync(5_000);
        const sel = await p;
        expect(sel.executor).toBeInstanceOf(ResidentExecutor);
        expect(sel.note).toBe(
          "resident · jshttp/vary · master@1220b9c · re-attached to the run's worktree · after waiting 5s for the resident",
        );
        expect(calls).toEqual(["/status", "/status", "/status", "/attach"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a resumed run's probe still transient past the first attach's budget is the re-attach refusal, naming the wait; the attach after a probe's wait gets what that wait left of the minute", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
        const { calls } = stubFetch(...Array.from({ length: 14 }, () => transient));
        let settled: unknown;
        const p = makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch(
          (e: unknown) => (settled = e),
        );
        await vi.advanceTimersByTimeAsync(59_999);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await p;
        expect(settled).toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((settled as WorkspaceReattachRefusedError).why).toBe(
          "resident unreachable (probe HTTP 500: internal error) after waiting 60s",
        );
        expect(calls).toHaveLength(14);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a resumed run's waits are clipped to its lease, and a lease spent under them is the lease's end, never a refusal: with two minutes left a blip waited a minute is `WorkspaceReattachLeaseSpentError` at the reserve's edge, not `workspace_lost`; with 100 s left a blip that clears at 15 s leaves too little for the attach to open, and the executor's own lease-spent refusal is read as the same end", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
        // (a) 2 min left: the probe's budget is clipped to 60 s (the lease less the reserve); the blip never clears.
        const a = stubFetch(...Array.from({ length: 14 }, () => transient));
        const startA = Date.now();
        let settledA: unknown;
        const pA = makeExecutor(residentOpts(), {
          ...repoCtx(),
          reattach: recorded,
          remainingMs: () => 120_000 - (Date.now() - startA),
        }).catch((e: unknown) => (settledA = e));
        await vi.advanceTimersByTimeAsync(60_000);
        await pA;
        expect(settledA).toBeInstanceOf(WorkspaceReattachLeaseSpentError);
        expect((settledA as WorkspaceReattachLeaseSpentError).leftMs).toBe(60_000);
        expect((settledA as WorkspaceReattachLeaseSpentError).note).toBe(
          "the run has 60s of wall clock left, inside the 60s write-up reserve, so no attach was opened",
        );
        expect(a.calls).toHaveLength(14);
        expect(a.calls.every((c) => c === "/status")).toBe(true);
        // (b) 100 s left: the blip clears at t = 15 s with 85 s left — 25 s past the
        // reserve, under what an attach needs — so the attach is not opened, and the
        // executor's `ResidentLeaseSpentError` is the lease's end here too.
        const b = stubFetch(transient, transient, transient, transient, { body: { state: "warm", reason: "" } });
        const startB = Date.now();
        let settledB: unknown;
        const pB = makeExecutor(residentOpts(), {
          ...repoCtx(),
          reattach: recorded,
          remainingMs: () => 100_000 - (Date.now() - startB),
        }).catch((e: unknown) => (settledB = e));
        await vi.advanceTimersByTimeAsync(15_000);
        await pB;
        expect(settledB).toBeInstanceOf(WorkspaceReattachLeaseSpentError);
        expect((settledB as WorkspaceReattachLeaseSpentError).leftMs).toBe(85_000);
        // The bound's own sentence, worded by the bound that refused: the floor, not the reserve.
        expect((settledB as WorkspaceReattachLeaseSpentError).note).toBe(
          "the run has 85s of wall clock left, only 25s past the 60s write-up reserve — under the 30s an attach needs — so no attach was opened",
        );
        expect(b.calls).toEqual(["/status", "/status", "/status", "/status", "/status"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a wake-budget strike under the re-attach with the lease spent meanwhile is the lease's end too, never `workspace_lost`: 100 s left, the probe serves at once, /attach answers a transient 500 and the resident stays restoring for the whole 40 s the lease leaves the wait — the strike is read after the lease, and the run ends on its budget", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        // The probe serves; the attach meets a blip the Worker typed transient; the
        // engine view never serves again within the wait the lease leaves (40 s).
        const { calls } = stubFetch(
          { body: { state: "warm", reason: "" } },
          { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
          ...Array.from({ length: 12 }, () => ({ body: { state: "restoring", reason: "rehydrating", inFlight: 0 } })),
        );
        const start = Date.now();
        let settled: unknown;
        const p = makeExecutor(residentOpts(), {
          ...repoCtx(),
          reattach: recorded,
          remainingMs: () => 100_000 - (Date.now() - start),
        }).catch((e: unknown) => (settled = e));
        await vi.advanceTimersByTimeAsync(40_000);
        await p;
        expect(settled).toBeInstanceOf(WorkspaceReattachLeaseSpentError);
        expect((settled as WorkspaceReattachLeaseSpentError).leftMs).toBe(60_000);
        expect((settled as WorkspaceReattachLeaseSpentError).note).toBe(
          "the run has 60s of wall clock left, inside the 60s write-up reserve, so no attach was opened",
        );
        // The probe, the attach, then the wake's probes every 5 s to the clipped budget's edge: 9 of them.
        expect(calls.slice(0, 2)).toEqual(["/status", "/attach"]);
        expect(calls.slice(2)).toEqual(Array.from({ length: 9 }, () => "/status"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hard stop during a resumed run's probe wait ends it with the stop's typed error, never a re-attach refusal", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        const transient = { status: 500, body: { error: "internal error", status: 500, transient: true } };
        stubFetch(transient, transient);
        const control = new AbortController();
        let settled: unknown;
        void makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded, stopSignal: control.signal }).catch(
          (e: unknown) => (settled = e),
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBeUndefined();
        control.abort();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).not.toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((settled as { reason?: string }).reason).toBe("aborted");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a re-attach refusal beside a pending stop is the refusal: a 409 needs-recreate with the run's stop already requested is a WorkspaceReattachRefusedError, never read as the stop", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "warm", reason: "" } },
        { status: 409, body: { error: "reuse-refused: the tree is gone", needs: "recreate" } },
      );
      const control = new AbortController();
      control.abort();
      const err = await makeExecutor(residentOpts(), {
        ...repoCtx(),
        reattach: recorded,
        stopSignal: control.signal,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
      expect((err as WorkspaceReattachRefusedError).why).toContain("reuse-refused");
    });

    it("a hard stop during a resumed run's re-attach wait ends it with the stop's typed error — never the re-attach refusal that would dispatch the stopped request again", async () => {
      vi.useFakeTimers();
      try {
        stubEnvs();
        const { calls } = stubFetch(
          { body: { state: "warm", reason: "" } },
          { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
          { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } },
        );
        const control = new AbortController();
        let settled: unknown;
        void makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded, stopSignal: control.signal }).catch(
          (e: unknown) => (settled = e),
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBeUndefined();
        control.abort();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).not.toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((settled as { reason?: string }).reason).toBe("aborted");
        expect(calls).toEqual(["/status", "/attach", "/status"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the resident refusing to reuse the tree (409 needs recreate) is a WorkspaceReattachRefusedError naming why; no sandbox is provisioned", async () => {
      stubEnvs();
      const { calls } = stubFetch(
        { body: { state: "warm", reason: "" } },
        {
          status: 409,
          body: { error: "reuse-refused: no worktree at /workspace/threads/t/master", needs: "recreate" },
        },
      );
      const err = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
      expect((err as Error).message).toContain("reuse-refused: no worktree at /workspace/threads/t/master");
      expect(calls).toEqual(["/status", "/attach"]); // no third call: nothing else was provisioned
    });

    it("an unreachable resident, or one in a state that cannot serve, refuses the re-attach the same way instead of falling back cold", async () => {
      stubEnvs();
      stubFetch({ reject: "fetch failed" });
      const unreachable = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch(
        (e: unknown) => e,
      );
      expect(unreachable).toBeInstanceOf(WorkspaceReattachRefusedError);
      expect((unreachable as Error).message).toMatch(/resident unreachable \(.*fetch failed/);
      resetResidentProbeCache();
      stubFetch({ body: { state: "down", reason: "r2-restore-failed: boom" } });
      const down = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
      expect(down).toBeInstanceOf(WorkspaceReattachRefusedError);
      expect((down as Error).message).toContain("resident down (r2-restore-failed: boom)");
    });

    // docs/reference/specs/execution.md item 27 on the re-attach (issue 1364
    // part 1): a resumed run's worktree lives on this resident or nowhere, so
    // a restoring probe holds the one /await-restore request instead of
    // refusing at once — a refusal would close the run and restart it from its
    // request, losing the tree, the transcript and a coordinator child's round.
    describe("a restoring resident on a re-attach — the restore is waited through, never refused at once (item 27)", () => {
      it("restoring probe → /await-restore held; a serviceable landing re-attaches the run's own worktree, the note naming the wait — never a refusal, never a sandbox", async () => {
        stubEnvs();
        const { calls, bodies } = stubFetch(
          { body: { state: "restoring", reason: "rehydrating" } },
          { body: { state: "warm", reason: "" } },
          attachOk(),
        );
        const sel = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded });
        expect(sel.executor).toBeInstanceOf(ResidentExecutor);
        expect(sel.resident).toBe(true);
        expect(calls).toEqual(["/status", "/await-restore", "/attach"]);
        expect(bodies[1]).toEqual({ resource: "repo:jshttp/vary" });
        expect(bodies[2]).toMatchObject({ reuse: true });
        expect(sel.note).toBe(
          "resident · jshttp/vary · master@1220b9c · re-attached to the run's worktree · after waiting for the resident's restore",
        );
      });

      it("a restore landing on a state that cannot serve refuses by name, the state and the wait both named — nothing else provisioned", async () => {
        stubEnvs();
        const { calls } = stubFetch(
          { body: { state: "restoring", reason: "rehydrating" } },
          { body: { state: "down", reason: "r2-restore-failed: boom" } },
        );
        const err = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((err as Error).message).toContain("resident down (r2-restore-failed: boom)");
        expect((err as Error).message).toContain("after waiting for the resident's restore");
        expect(calls).toEqual(["/status", "/await-restore"]);
      });

      it("an older Worker's 404 refuses naming the missing route — a re-attach never falls back cold", async () => {
        stubEnvs();
        const { calls } = stubFetch(
          { body: { state: "restoring", reason: "rehydrating" } },
          { status: 404, body: { error: "unknown route" } },
        );
        const err = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((err as Error).message).toContain("no /await-restore route");
        expect(calls).toEqual(["/status", "/await-restore"]);
      });

      it("a hold that fails in transport refuses naming the failed wait, never a throw of the transport's own", async () => {
        stubEnvs();
        stubFetch({ body: { state: "restoring", reason: "rehydrating" } }, { reject: "fetch failed" });
        const err = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
        expect((err as Error).message).toMatch(/waiting for the resident's restore failed \(.*fetch failed/);
      });

      it("the run's own stop ends the hold with the stop's typed shape, never a refusal that would restart the stopped run", async () => {
        vi.useFakeTimers();
        try {
          stubEnvs();
          stubFetchLate(
            { body: { state: "restoring", reason: "rehydrating" } },
            { body: { state: "warm", reason: "" }, afterMs: 9 * 60_000 },
          );
          const control = new AbortController();
          let settled: unknown;
          void makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded, stopSignal: control.signal }).catch(
            (e: unknown) => (settled = e),
          );
          await vi.advanceTimersByTimeAsync(2_000);
          expect(settled).toBeUndefined();
          control.abort();
          await vi.advanceTimersByTimeAsync(1);
          expect(settled).not.toBeInstanceOf(WorkspaceReattachRefusedError);
          expect((settled as { reason?: string }).reason).toBe("aborted");
        } finally {
          vi.useRealTimers();
        }
      });

      it("a lease that ran into its write-up reserve under the hold is the run's end on its budget, never a refusal", async () => {
        vi.useFakeTimers();
        try {
          stubEnvs();
          // 130 s of lease: the hold's budget is clipped to 70 s (the lease less
          // the 60 s reserve); the restore ends at 45 s with 85 s left — 25 s
          // past the reserve, under the 30 s an attach needs.
          stubFetchLate(
            { body: { state: "restoring", reason: "rehydrating" } },
            { body: { state: "warm", reason: "" }, afterMs: 45_000 },
          );
          const start = Date.now();
          let settled: unknown;
          const p = makeExecutor(residentOpts(), {
            ...repoCtx(),
            reattach: recorded,
            remainingMs: () => 130_000 - (Date.now() - start),
          }).catch((e: unknown) => (settled = e));
          await vi.advanceTimersByTimeAsync(45_001);
          await p;
          expect(settled).toBeInstanceOf(WorkspaceReattachLeaseSpentError);
          expect((settled as WorkspaceReattachLeaseSpentError).leftMs).toBe(85_000);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("any other attach failure on a re-attach (a mirror-busy 503) is the same typed refusal, never the per-thread fallback", async () => {
      stubEnvs();
      stubFetch(
        { body: { state: "warm", reason: "" } },
        { status: 503, body: { error: "mirror busy", state: "refreshing", reason: "mirror-busy" } },
      );
      const err = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
      expect((err as Error).message).toContain("mirror busy");
    });

    it("a resident whose answer names another worktree or another pool user than the row recorded is refused: that tree is not the run's", async () => {
      stubEnvs();
      stubFetch({ body: { state: "warm", reason: "" } }, attachOk({ user: "worker5" }));
      const err = await makeExecutor(residentOpts(), { ...repoCtx(), reattach: recorded }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkspaceReattachRefusedError);
      expect((err as Error).message).toContain("as worker5");
      expect((err as Error).message).toContain("as worker2");
    });

    it("a recorded sandbox binding re-makes the per-thread executor with ZERO resident calls: a run that started cold is never moved onto the resident", async () => {
      stubEnvs();
      const { fn } = stubFetch();
      const sel = await makeExecutor(residentOpts(), {
        ...repoCtx(),
        reattach: { backend: "sandbox" },
      });
      expect(sel.executor).toBeInstanceOf(CloudflareSandboxExecutor);
      expect(sel.note).toBeUndefined();
      expect(fn).not.toHaveBeenCalled();
    });

    it("a seeded sandbox re-attach moves a legacy origin to the exact door URL before restoring publication facts", async () => {
      stubEnvs();
      const { fn } = stubFetch();
      const seed = { slug: "jshttp/vary", ref: "fix/existing", workspace: "/workspace/checkout" };
      const head = "b".repeat(40);
      let origin = `https://github.com/${seed.slug}.git\n`;
      const observe = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
        if (command.includes("rev-parse --abbrev-ref HEAD")) return `${seed.ref}\n`;
        if (command.includes("rev-parse HEAD")) return `${head}\n`;
        if (command.includes("config --get remote.origin.url")) return origin;
        if (command.includes("remote set-url origin")) {
          origin = "https://door.example/git/jshttp/vary.git\n";
          return "";
        }
        return "";
      });
      const sel = await makeExecutor(residentOpts(), {
        ...repoCtx(),
        reattach: { backend: "sandbox", seeded: seed },
      });
      expect(sel.seeded).toEqual({ ...seed, sha: head, cached: true, ms: 0 });
      expect(origin).toBe("https://door.example/git/jshttp/vary.git\n");
      expect(fn).not.toHaveBeenCalled();
      observe.mockRestore();
    });

    it("a seeded sandbox re-attach refuses a foreign or unreadable checkout", async () => {
      stubEnvs();
      stubFetch();
      const seed = { slug: "jshttp/vary", ref: "fix/existing", workspace: "/workspace/checkout" };
      let ref = "other-branch";
      let head = `${"b".repeat(40)}\n`;
      let origin = `https://door.example/git/${seed.slug}.git\n`;
      const observe = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
        if (command.includes("rev-parse --abbrev-ref HEAD")) return ref;
        if (command.includes("rev-parse HEAD")) return head;
        if (command.includes("config --get remote.origin.url")) return origin;
        return "";
      });
      const reattach = () =>
        makeExecutor(residentOpts(), { ...repoCtx(), reattach: { backend: "sandbox", seeded: seed } });
      await expect(reattach()).rejects.toThrow(WorkspaceReattachRefusedError);
      ref = seed.ref;
      origin = "https://github.com/other/repo.git\n";
      await expect(reattach()).rejects.toThrow(WorkspaceReattachRefusedError);
      origin = `https://door.example/git/${seed.slug}.git\n`;
      head = "exit 128: not a git repository";
      await expect(reattach()).rejects.toThrow(WorkspaceReattachRefusedError);
      observe.mockRestore();
    });

    it("a resident binding without a configured resident, or without a resolved repo, cannot be re-attached and says so", async () => {
      stubEnvs();
      stubFetch();
      const noRepo = await makeExecutor(residentOpts(), { ...ctxOf(AGENTS.coding), reattach: recorded }).catch(
        (e: unknown) => e,
      );
      expect(noRepo).toBeInstanceOf(WorkspaceReattachRefusedError);
      const noResident = await makeExecutor(
        { execution: { type: "cloudflare", url: "https://sandbox.example" }, ...dirs() },
        { ...repoCtx(), reattach: recorded },
      ).catch((e: unknown) => e);
      expect(noResident).toBeInstanceOf(WorkspaceReattachRefusedError);
    });
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
    // `blank` carries no credential by definition, so its truthful profile is
    // identity `none`; the factory refuses any stronger combination.
    identity: machine === "blank" ? "none" : base.identity,
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
    expect(await optsOf(executor).resolveEnvs()).toMatchObject({ GH_ENTERPRISE_TOKEN: "sbr_test.secret" });
    const readonly = await makeExecutor(bothBackends(), {
      ...ctxOf(agentOn("repo-cold", AGENTS.review)),
      repo: "jshttp/vary",
    });
    expect(await optsOf(readonly.executor).resolveEnvs()).toMatchObject({ GH_ENTERPRISE_TOKEN: "sbr_test.secret" });
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
      githubDoor: { baseUrl: "https://door.example", bearer: "sbr_test.secret" },
    });
    expect(await optsOf(reading.executor).resolveEnvs()).toMatchObject({ GH_ENTERPRISE_TOKEN: "sbr_test.secret" });
    expect(resolveGithubToken).not.toHaveBeenCalled();
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

  it("a listing that misses its deadline answers undefined but opens NO outage window (the next call fetches again), like the selection's probe", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      );
      vi.stubGlobal("fetch", fn);
      const list = residentSlugsLister(cfg, env);
      const first = list?.();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(first).resolves.toBeUndefined();
      const second = list?.();
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(second).resolves.toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Feature: docs/reference/specs/run-history.md item 54: the binding the row
// records at the claim (`state.binding`) and how the next generation reads it.
describe("the workspace binding on the row", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([true, false])(
    "reattaches an unseeded cold clone without inventing a missing initial lease (recorded: %s)",
    async (withHead) => {
      vi.stubEnv("SANDBOX_TOKEN", "test-token");
      const old = "a".repeat(40);
      const current = "b".repeat(40);
      const commands: string[] = [];
      vi.spyOn(CloudflareSandboxExecutor.prototype, "execResult").mockImplementation(async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          truncated: false,
          stderr: "",
          stdout: `/workspace/checkout\nplan/p/u1\n${current}\n${current}\trefs/heads/plan/p/u1\nhttps://door.example/git/o/r.git\n`,
        };
      });
      const recorded: WorkspaceBinding = {
        backend: "sandbox",
        ref: "plan/p/u1",
        workspace: "/workspace/checkout",
        ...(withHead ? { publicationBaseSha: old } : {}),
      };
      const selection = await makeExecutor(
        { ...dirs(), execution: { type: "cloudflare", url: "https://sandbox.example" } },
        {
          ...ctx("coding"),
          repo: "o/r",
          ref: "plan/p/u1",
          reattach: recorded,
        },
      );
      expect(selection.cold).toEqual({ ref: "plan/p/u1", sha: current, workspace: "/workspace/checkout" });
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toContain("clone");
      expect(workspaceBindingFor(selection, "repo-resident", recorded)?.publicationBaseSha).toBe(
        withHead ? old : undefined,
      );
    },
  );
  it("clones a fresh precreated branch, verifies the remote tip and records its actual checkout", async () => {
    const sha = "a".repeat(40);
    const commands: string[] = [];
    const selected = {
      backend: "sandbox" as const,
      executor: Object.assign(new LocalExecutor("/tmp/x"), {
        execResult: vi.fn(async (command: string) => {
          commands.push(command);
          return {
            exitCode: 0,
            truncated: false,
            stderr: "",
            stdout: `/workspace/checkout\nplan/p/u1\n${sha}\n${sha}\trefs/heads/plan/p/u1\nhttps://door.example/git/o/r.git\n`,
          };
        }),
      }),
    };
    const cold = await prepareColdPublicationCheckout(selected, {
      repo: "o/r",
      ref: "plan/p/u1",
      doorUrl: "https://door.example",
      expectedHeadSha: sha,
    });
    expect(cold).toEqual({ ref: "plan/p/u1", sha, workspace: "/workspace/checkout" });
    expect(commands[0]).toContain("clone --quiet --single-branch --branch 'plan/p/u1'");
    expect(commands[0]).toContain("ls-remote --exit-code origin 'refs/heads/plan/p/u1'");
    expect(workspaceBindingFor({ ...selected, cold })).toMatchObject({
      workspace: "/workspace/checkout",
      ref: "plan/p/u1",
      publicationBaseSha: sha,
    });
  });

  it("rejects an unverified or moved cold branch without creating an initial lease", async () => {
    const sha = "a".repeat(40);
    const selected = {
      backend: "sandbox" as const,
      executor: Object.assign(new LocalExecutor("/tmp/x"), {
        execResult: vi.fn(async () => ({
          exitCode: 0,
          truncated: false,
          stderr: "",
          stdout: `/workspace/checkout\nplan/p/u1\n${sha}\n${"b".repeat(40)}\trefs/heads/plan/p/u1\nhttps://door.example/git/o/r.git\n`,
        })),
      }),
    };
    await expect(
      prepareColdPublicationCheckout(selected, { repo: "o/r", ref: "plan/p/u1", doorUrl: "https://door.example" }),
    ).rejects.toThrow(/cold publication checkout/i);
    expect(workspaceBindingFor(selected)?.publicationBaseSha).toBeUndefined();
  });

  it.each(["/workspace/../checkout", "/workspace/other", "/workspace/checkout/extra"])(
    "refuses an untrusted cold checkout path before persisting the lease: %s",
    async (path) => {
      const sha = "a".repeat(40);
      const selected = {
        backend: "sandbox" as const,
        executor: Object.assign(new LocalExecutor("/tmp/x"), {
          execResult: vi.fn(async () => ({
            exitCode: 0,
            truncated: false,
            stderr: "",
            stdout: `${path}\nplan/p/u1\n${sha}\n${sha}\trefs/heads/plan/p/u1\nhttps://door.example/git/o/r.git\n`,
          })),
        }),
      };
      await expect(
        prepareColdPublicationCheckout(selected, {
          repo: "o/r",
          ref: "plan/p/u1",
          doorUrl: "https://door.example",
        }),
      ).rejects.toThrow(/cold publication checkout/i);
    },
  );

  it("rechecks a recorded cold checkout without cloning or leasing its later local tip", async () => {
    const old = "a".repeat(40);
    const next = "b".repeat(40);
    const commands: string[] = [];
    const selected = {
      backend: "sandbox" as const,
      executor: Object.assign(new LocalExecutor("/tmp/x"), {
        execResult: vi.fn(async (command: string) => {
          commands.push(command);
          return {
            exitCode: 0,
            truncated: false,
            stderr: "",
            stdout: `/workspace/checkout\nplan/p/u1\n${next}\n${next}\trefs/heads/plan/p/u1\nhttps://door.example/git/o/r.git\n`,
          };
        }),
      }),
    };
    const recorded = {
      backend: "sandbox" as const,
      ref: "plan/p/u1",
      workspace: "/workspace/checkout",
      publicationBaseSha: old,
    };
    const cold = await prepareColdPublicationCheckout(selected, {
      repo: "o/r",
      ref: "plan/p/u1",
      doorUrl: "https://door.example",
      recorded,
    });
    expect(commands[0]).not.toContain("clone");
    expect(workspaceBindingFor({ ...selected, cold }, "repo-cold", recorded)?.publicationBaseSha).toBe(old);
    expect(
      workspaceBindingFor({ ...selected, cold }, "repo-cold", {
        backend: "sandbox",
        ref: "plan/p/u1",
        workspace: "/workspace/checkout",
      })?.publicationBaseSha,
    ).toBeUndefined();
  });

  it("keeps a recorded cold head on reattach and never derives one from a later local tip", () => {
    const rebound = {
      backend: "sandbox" as const,
      executor: new LocalExecutor("/tmp/x"),
      cold: { ref: "plan/p/u1", sha: "b".repeat(40), workspace: "/workspace/checkout" },
    };
    expect(
      workspaceBindingFor(rebound, "repo-cold", {
        backend: "sandbox",
        ref: "plan/p/u1",
        workspace: "/workspace/checkout",
        publicationBaseSha: "a".repeat(40),
      })?.publicationBaseSha,
    ).toBe("a".repeat(40));
    expect(
      workspaceBindingFor(rebound, "repo-cold", {
        backend: "sandbox",
        ref: "plan/p/u1",
        workspace: "/workspace/checkout",
      })?.publicationBaseSha,
    ).toBeUndefined();
  });
  it("keeps the fetched branch head apart from the resident snapshot source", () => {
    const selected = workspaceBindingFor({
      executor: new LocalExecutor("/tmp/x"),
      backend: "sandbox",
      seeded: {
        slug: "o/r",
        ref: "plan/p/u1",
        sha: "a".repeat(40),
        sourceSha: "b".repeat(40),
        workspace: "/workspace/checkout",
        cached: false,
        ms: 100,
      },
    });
    expect(selected?.publicationBaseSha).toBe("a".repeat(40));
    expect(workspaceBindingOf(selected)?.publicationBaseSha).toBe("a".repeat(40));
  });

  it("retains the first fetched head when a resumed resident now reports a later local head", () => {
    const rebound = workspaceBindingFor(
      {
        executor: new LocalExecutor("/tmp/x"),
        backend: "resident",
        binding: { ref: "plan/p/u1", sha: "b".repeat(40), workspace: "/workspace/threads/t/wt" },
      },
      "repo-resident",
      { backend: "resident", ref: "plan/p/u1", publicationBaseSha: "a".repeat(40) },
    );
    expect(rebound?.publicationBaseSha).toBe("a".repeat(40));
    expect(
      workspaceBindingFor(
        {
          executor: new LocalExecutor("/tmp/x"),
          backend: "resident",
          binding: { ref: "plan/p/u1", sha: "b".repeat(40), workspace: "/workspace/threads/t/wt" },
        },
        "repo-resident",
        { backend: "resident", ref: "plan/p/u1" },
      )?.publicationBaseSha,
    ).toBeUndefined();
  });

  it("workspaceBindingFor names the backend and, from a resident attach, the worktree, the pool user and the container; nothing for a run without a backend", () => {
    expect(
      workspaceBindingFor({
        executor: new LocalExecutor("/tmp/x"),
        backend: "resident",
        resident: true,
        binding: {
          ref: "main",
          sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05",
          workspace: "/workspace/threads/t/main",
          user: "worker3",
          container: "vm-9",
        },
      }),
    ).toEqual({
      backend: "resident",
      ref: "main",
      workspace: "/workspace/threads/t/main",
      user: "worker3",
      container: "vm-9",
      publicationBaseSha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05",
    });
    expect(workspaceBindingFor({ executor: new LocalExecutor("/tmp/x"), backend: "sandbox" })).toEqual({
      backend: "sandbox",
    });
    expect(
      workspaceBindingFor({
        executor: new LocalExecutor("/tmp/x"),
        backend: "sandbox",
        seeded: {
          slug: "jshttp/vary",
          ref: "fix/existing",
          sha: "a".repeat(40),
          sourceSha: "b".repeat(40),
          workspace: "/workspace/checkout",
          cached: false,
          ms: 100,
        },
      }),
    ).toEqual({
      backend: "sandbox",
      workspace: "/workspace/checkout",
      publicationBaseSha: "a".repeat(40),
      seeded: { slug: "jshttp/vary", ref: "fix/existing", workspace: "/workspace/checkout", sourceSha: "b".repeat(40) },
    });
    expect(workspaceBindingFor({ executor: new LocalExecutor("/tmp/x") })).toBeUndefined();
  });

  it("workspaceBindingOf reads a binding this build wrote and answers none for another shape", () => {
    expect(
      workspaceBindingOf({ backend: "resident", ref: "main", workspace: "/w", user: "worker2", container: "vm-1" }),
    ).toEqual({
      backend: "resident",
      ref: "main",
      workspace: "/w",
      user: "worker2",
      container: "vm-1",
    });
    expect(workspaceBindingOf({ backend: "sandbox" })).toEqual({ backend: "sandbox" });
    expect(
      workspaceBindingOf({
        backend: "sandbox",
        seeded: {
          slug: "jshttp/vary",
          ref: "fix/existing",
          workspace: "/workspace/checkout",
          sourceSha: "b".repeat(40),
        },
      }),
    ).toEqual({
      backend: "sandbox",
      seeded: { slug: "jshttp/vary", ref: "fix/existing", workspace: "/workspace/checkout", sourceSha: "b".repeat(40) },
    });
    expect(
      workspaceBindingOf({
        backend: "sandbox",
        seeded: { slug: "jshttp/vary", ref: 7, workspace: "/workspace/checkout" },
      }),
    ).toEqual({ backend: "sandbox" });
    expect(workspaceBindingOf({ backend: "sandbox", user: 7 })).toEqual({ backend: "sandbox" });
    expect(workspaceBindingOf({ backend: "mainframe" })).toBeUndefined();
    expect(workspaceBindingOf({ workspace: "/w" })).toBeUndefined();
    expect(workspaceBindingOf(undefined)).toBeUndefined();
    expect(workspaceBindingOf("resident")).toBeUndefined();
  });
});

// Feature: docs/reference/specs/execution.md item 26 — a repository whose
// resident cannot take the run, but whose probe carried the snapshot handle,
// gets a sandbox seeded from that snapshot before the run's first command:
// one POST /seed with the thread's ref and head riding along, the seeded
// facts on the selection, the reason and the seed on the note. A handle whose
// objects are gone is retried once with a fresh probe; any other refusal, or
// a resident with nothing to seed from, is the cold path as before.
describe("makeExecutor seeded sandbox", () => {
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
  const repoCtx = () => ({ ...ctxOf(AGENTS.coding), repo: "jshttp/vary", ref: "master" });
  const stubEnvs = () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
  };
  function stubFetch(...responses: Array<{ status?: number; body?: unknown; reject?: string }>) {
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const scrubs: Array<Record<string, unknown>> = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (new URL(String(url)).pathname === "/exec") {
        scrubs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ exitCode: 0 }), { status: 200 });
      }
      calls.push(new URL(String(url)).pathname);
      bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
      if (next.reject) throw new TypeError(next.reject);
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls, bodies, scrubs };
  }
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const HEAD = "89abcdef0123456789abcdef0123456789abcdef";
  const snapshot = (checkoutBackupId: string) => ({
    ref: "master",
    sha: SHA,
    lockfileHash: "l",
    createdAt: "t",
    mirrorBackupId: "11111111-1111-1111-1111-111111111111",
    checkoutBackupId,
    depsBackupId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  });
  const C1 = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
  const C2 = "9999aaaa-bbbb-cccc-dddd-eeeeffff0000";
  const degraded = (id: string) => ({
    body: { state: "degraded", reason: "disk-pressure: need 2.1 GiB", snapshot: snapshot(id) },
  });
  const seededAnswer = (id: string) => ({
    body: {
      seeded: true,
      cached: false,
      slug: "jshttp/vary",
      ref: "master",
      sha: HEAD,
      from: { ref: "master", sha: SHA, checkoutBackupId: id },
      steps: { restore: 18_000, deps: 9_000, fixup: 3_000 },
      ms: 30_500,
    },
  });

  it("a generation reclaimed during a seed wait cannot start from that sandbox", async () => {
    stubEnvs();
    let ownsRun = true;
    const { calls } = stubFetch(degraded(C1), seededAnswer(C1));
    const fetchBeforeReclaim = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const answer = await fetchBeforeReclaim(url, init);
        if (new URL(String(url)).pathname === "/seed") ownsRun = false;
        return answer;
      }),
    );
    const claim = vi.fn(async () => {
      if (!ownsRun) throw new Error("resident claim refused: fenced");
      return 7;
    });
    await expect(makeExecutor(residentOpts(), { ...repoCtx(), residentClaim: claim })).rejects.toThrow(
      "resident claim refused: fenced",
    );
    expect(calls).toEqual(["/status", "/seed"]);
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("a refused resident with a snapshot → one POST /seed with the thread's ref, the seeded facts on the selection, the reason and the seed on the note", async () => {
    stubEnvs();
    const { calls, bodies, scrubs } = stubFetch(degraded(C1), seededAnswer(C1));
    const sel = await makeExecutor(residentOpts(), repoCtx());
    expect(sel.executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(calls).toEqual(["/status", "/seed"]);
    expect(scrubs).toHaveLength(1);
    expect(String(scrubs[0]?.command)).toContain("/workspace/.git-credentials");
    expect(bodies[1]?.seed).toEqual({
      slug: "jshttp/vary",
      checkoutBackupId: C1,
      depsBackupId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      ref: "master",
      sha: SHA,
      fetchRef: "master",
    });
    expect(sel.backend).toBe("sandbox");
    expect(sel.resident).toBeFalsy();
    expect(sel.seeded).toEqual({
      slug: "jshttp/vary",
      ref: "master",
      seedBackupId: C1,
      sha: HEAD,
      sourceSha: SHA,
      workspace: "/workspace/checkout",
      cached: false,
      ms: 30_500,
    });
    expect(sel.note).toBe(
      `resident degraded (disk-pressure: need 2.1 GiB) — seeded sandbox · from resident snapshot · jshttp/vary · master@${HEAD.slice(0, 7)}`,
    );
  });

  it("a read-profile review seeds its own sandbox with an owner claim matching the physical key", async () => {
    stubEnvs();
    const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const container = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";
    const answer = seededAnswer(C1);
    const { calls, bodies } = stubFetch(degraded(C1), {
      body: {
        ...answer.body,
        preservationContainer: container,
        from: { ...answer.body.from, depsBackupId: snapshot(C1).depsBackupId },
      },
    });
    const selected = await makeExecutor(residentOpts(), {
      ...repoCtx(),
      ...ctxOf(AGENTS.review),
      repo: "jshttp/vary",
      ref: "master",
      headSha: HEAD,
      runId,
      requester: "slack:U123",
    });
    expect(calls).toEqual(["/status", "/seed"]);
    expect(bodies[1]?.preservation).toMatchObject({ run: runId, thread: `review:${runId}`, head: HEAD });
    expect(selected.sandboxKey).toBe(`review:${runId}`);
    expect(workspaceBindingFor(selected)?.sandboxKey).toBe(`review:${runId}`);
  });

  it("the thread's resolved head rides along as fetchSha", async () => {
    stubEnvs();
    const { bodies } = stubFetch(degraded(C1), seededAnswer(C1));
    await makeExecutor(residentOpts(), { ...repoCtx(), headSha: HEAD });
    expect(bodies[1]?.seed).toMatchObject({ fetchRef: "master", fetchSha: HEAD });
  });

  it("a handle whose objects are gone → one fresh probe; a newer handle is seeded from, the same handle sends the run cold", async () => {
    stubEnvs();
    const missing = {
      body: { seeded: false, reason: "seed-missing", detail: "restore: Backup not found", step: "restore" },
    };
    const { calls, bodies } = stubFetch(degraded(C1), missing, degraded(C2), seededAnswer(C2));
    const sel = await makeExecutor(residentOpts(), repoCtx());
    expect(calls).toEqual(["/status", "/seed", "/status", "/seed"]);
    expect(bodies[3]?.seed).toMatchObject({ checkoutBackupId: C2, fetchRef: "master" });
    expect(sel.seeded).toMatchObject({ slug: "jshttp/vary" });

    resetResidentProbeCache();
    const again = stubFetch(degraded(C1), missing, degraded(C1));
    const cold = await makeExecutor(residentOpts(), repoCtx());
    expect(again.calls).toEqual(["/status", "/seed", "/status"]);
    expect(cold.seeded).toBeUndefined();
    expect(cold.note).toBe(
      "resident degraded (disk-pressure: need 2.1 GiB) — using fresh sandbox (seed missing (restore: Backup not found) and the resident published no newer handle)",
    );
  });

  it("an incompatible cached seed refuses without retry or cold fallback even without a pilot policy", async () => {
    stubEnvs();
    const { calls } = stubFetch(degraded(C1), {
      body: { seeded: false, reason: "seed-incompatible", detail: "cached dependency layout is invalid", step: "deps" },
    });
    await expect(makeExecutor(residentOpts(), repoCtx())).rejects.toMatchObject({
      name: "ReadyEnvironmentError",
      reason: "dependencies_invalid",
      beforeModel: true,
    });
    expect(calls).toEqual(["/status", "/seed"]);
  });

  it("a failed or unconfigured seed is never retried: the cold path, the refusal on the note", async () => {
    stubEnvs();
    const { calls } = stubFetch(degraded(C1), {
      body: { seeded: false, reason: "seed-failed", detail: "fixup: fix-up exited 128", step: "fixup" },
    });
    const sel = await makeExecutor(residentOpts(), repoCtx());
    expect(calls).toEqual(["/status", "/seed"]);
    expect(sel.executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(sel.seeded).toBeUndefined();
    expect(sel.note).toBe(
      "resident degraded (disk-pressure: need 2.1 GiB) — using fresh sandbox (seed failed (fixup: fix-up exited 128))",
    );
  });

  it("a typed fleet refusal during seed ends setup without starting a fresh checkout", async () => {
    stubEnvs();
    const { calls } = stubFetch(degraded(C1), {
      status: 503,
      body: { error: "fleet-busy: max_instances reached", reason: "fleet-busy" },
    });
    await expect(makeExecutor(residentOpts(), { ...repoCtx(), setupRemainingMs: () => 0 })).rejects.toMatchObject({
      name: "ExecCapacityError",
    });
    expect(calls).toEqual(["/status", "/seed"]);
  });

  it("a Worker without /seed (an older release answers 404) sends the run cold with the reason — never a dead run", async () => {
    stubEnvs();
    stubFetch(
      degraded(C1),
      { status: 404, body: { error: "unknown route" } },
      { status: 404, body: { error: "unknown route" } },
      { status: 404, body: { error: "unknown route" } },
      { status: 404, body: { error: "unknown route" } },
    );
    const sel = await makeExecutor(residentOpts(), repoCtx());
    expect(sel.executor).toBeInstanceOf(CloudflareSandboxExecutor);
    expect(sel.seeded).toBeUndefined();
    expect(sel.note).toMatch(
      /^resident degraded \(disk-pressure: need 2.1 GiB\) — using fresh sandbox \(seed failed \(/,
    );
  });

  it("nothing to seed from: a probe without a snapshot, an unreachable resident, a repository not onboarded — the cold path, no /seed", async () => {
    stubEnvs();
    // `onboarding`, not `restoring`: a restoring probe opens the held /await-restore (item 27).
    const noSnapshot = stubFetch({ body: { state: "onboarding", reason: "", snapshot: null } });
    const a = await makeExecutor(residentOpts(), repoCtx());
    expect(noSnapshot.calls).toEqual(["/status"]);
    expect(a.note).toBe("resident onboarding — using fresh sandbox");
    expect(a.seeded).toBeUndefined();

    resetResidentProbeCache();
    const gone = stubFetch({ status: 404, body: { error: "unknown resource" } });
    const b = await makeExecutor(residentOpts(), repoCtx());
    expect(gone.calls).toEqual(["/status"]);
    expect(b.note).toMatch(/^repo not onboarded as a resident/);
  });

  it("a local execution type seeds nothing: the resident's handle needs a sandbox Worker", async () => {
    stubEnvs();
    const { calls } = stubFetch(degraded(C1));
    const sel = await makeExecutor(
      { execution: { type: "local", resident: { baseUrl: "https://resident.example" } }, ...dirs() },
      repoCtx(),
    );
    expect(calls).toEqual(["/status"]);
    expect(sel.executor).toBeInstanceOf(LocalExecutor);
    expect(sel.seeded).toBeUndefined();
  });
});

// Feature: docs/reference/specs/execution.md item 31 — an opted-in write unit
// starts only after a dependency-ready resident or seeded sandbox passes a
// model-free check of the declared test tool.
describe("makeExecutor pilot ready environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetResidentProbeCache();
  });

  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const DEPS = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const CHECKOUT = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
  const ready = { testCommand: "npm test", requiredTools: ["npm"], dependencyDir: "node_modules" };
  const opts = (): ExecutorFactoryOptions => ({
    execution: {
      type: "cloudflare",
      url: "https://sandbox.example",
      resident: { baseUrl: "https://resident.example" },
    },
    ...dirs(),
  });
  const context = () => ({
    ...ctxOf(AGENTS.coding),
    repo: "jshttp/vary",
    ref: "master",
    headSha: SHA,
    readyEnvironment: ready,
  });
  const envs = () => {
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
  };
  function fetches(...answers: Array<{ status?: number; body: unknown }>) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        if (path === "/exec") return new Response(JSON.stringify({ exitCode: 0, stdout: "" }), { status: 200 });
        if (path === "/install-repair/inspect") return new Response(JSON.stringify({ kind: "none" }), { status: 200 });
        calls.push(path);
        const answer = answers.shift();
        if (!answer) throw new Error(`unexpected fetch ${String(url)}`);
        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
      }),
    );
    return calls;
  }
  const snapshot = (depsBackupId: string | null = DEPS) => ({
    ref: "master",
    sha: SHA,
    checkoutBackupId: CHECKOUT,
    ...(depsBackupId ? { depsBackupId } : {}),
  });

  it("refuses an opt-in write without a resolved repository or resident before provisioning", async () => {
    envs();
    const calls = fetches();
    await expect(makeExecutor(opts(), { ...context(), repo: undefined })).rejects.toMatchObject({
      name: "ReadyEnvironmentError",
      reason: "repository_unresolved",
    });
    await expect(
      makeExecutor({ ...opts(), execution: { type: "cloudflare", url: "https://sandbox.example" } }, context()),
    ).rejects.toBeInstanceOf(ReadyEnvironmentError);
    await expect(
      makeExecutor({ ...opts(), execution: { type: "cloudflare", resident: opts().execution?.resident } }, context()),
    ).rejects.toMatchObject({ reason: "backend_unavailable", beforeModel: true });
    vi.stubEnv("SANDBOX_TOKEN", "");
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({
      reason: "backend_unavailable",
      beforeModel: true,
    });
    vi.stubEnv("SANDBOX_TOKEN", "tok");
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "");
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({
      reason: "backend_unavailable",
      beforeModel: true,
    });
    vi.stubEnv("RESIDENT_OPERATOR_TOKEN", "rtok");
    await expect(
      makeExecutor(
        { ...opts(), execution: { ...opts().execution, resident: { baseUrl: "" }, type: "cloudflare" } },
        context(),
      ),
    ).rejects.toMatchObject({ reason: "backend_unavailable", beforeModel: true });
    await expect(makeExecutor(opts(), { ...context(), headSha: undefined })).rejects.toMatchObject({
      reason: "repository_unresolved",
    });
    expect(calls).toEqual([]);
  });

  it("reattaches a pilot writer to its recorded resident worktree and rechecks readiness", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      {
        body: {
          workspace: "/workspace/threads/x/master",
          user: "writer",
          ref: "master",
          sha: SHA,
          deps: "hardlink",
          depsKey: "lock",
        },
      },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    const selection = await makeExecutor(opts(), {
      ...context(),
      headSha: undefined,
      reattach: { backend: "resident", workspace: "/workspace/threads/x/master", user: "writer" },
    });
    expect(selection.backend).toBe("resident");
    expect(check).toHaveBeenCalledOnce();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("refuses a pilot resident resume without a recorded worktree and user before attach", async () => {
    envs();
    const calls = fetches();
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        reattach: { backend: "resident", workspace: "/workspace/threads/x/master" },
      }),
    ).rejects.toMatchObject({ reason: "binding_mismatch", beforeModel: true });
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        reattach: { backend: "resident", user: "writer" },
      }),
    ).rejects.toMatchObject({ reason: "binding_mismatch", beforeModel: true });
    expect(calls).toEqual([]);
  });

  it("refuses a pilot resident resume when attach omits the recorded user", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: SHA, deps: "hardlink" } },
      { body: { ok: true } },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        reattach: { backend: "resident", workspace: "/workspace/threads/x/master", user: "writer" },
      }),
    ).rejects.toMatchObject({ reason: "binding_mismatch", beforeModel: true });
    expect(check).not.toHaveBeenCalled();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("holds a resumed pilot writer when its recorded worktree has no dependency view", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      { body: { workspace: "/workspace/threads/x/master", user: "writer", ref: "master", sha: SHA, deps: "none" } },
      { body: { ok: true } },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        reattach: { backend: "resident", workspace: "/workspace/threads/x/master", user: "writer" },
      }),
    ).rejects.toMatchObject({ name: "ReadyEnvironmentError", reason: "dependencies_missing", beforeModel: true });
    expect(check).not.toHaveBeenCalled();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("accepts a reused resident dependency view with a matching stored key on resume", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      {
        body: {
          workspace: "/workspace/threads/x/master",
          user: "writer",
          ref: "master",
          sha: SHA,
          deps: "none",
          depsKey: "lock",
        },
      },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    const selection = await makeExecutor(opts(), {
      ...context(),
      headSha: undefined,
      reattach: { backend: "resident", ref: "master", workspace: "/workspace/threads/x/master", user: "writer" },
    });
    expect(selection.backend).toBe("resident");
    expect(check).toHaveBeenCalledOnce();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("accepts a repaired pilot worktree after its resident container changed", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      {
        body: {
          workspace: "/workspace/threads/x/master",
          user: "writer",
          container: "vm-new",
          ref: "master",
          sha: SHA,
          deps: "hardlink",
        },
      },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    const selection = await makeExecutor(opts(), {
      ...context(),
      headSha: undefined,
      reattach: {
        backend: "resident",
        workspace: "/workspace/threads/x/master",
        user: "writer",
        container: "vm-old",
      },
    });
    expect(selection.binding).toMatchObject({ workspace: "/workspace/threads/x/master", container: "vm-new" });
    expect(check).toHaveBeenCalledOnce();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("reattaches a pilot writer to its seeded sandbox checkout and rechecks readiness", async () => {
    envs();
    const calls = fetches();
    const check = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "master\n";
      if (command.includes("rev-parse HEAD")) return `${SHA}\n`;
      if (command.includes("config --get remote.origin.url")) return "https://door.example/git/jshttp/vary.git\n";
      return "READY";
    });
    const selection = await makeExecutor(opts(), {
      ...context(),
      headSha: undefined,
      reattach: {
        backend: "sandbox",
        seeded: {
          slug: "jshttp/vary",
          ref: "master",
          workspace: "/workspace/checkout",
          sourceSha: "b".repeat(40),
          depsBackupId: DEPS,
        },
      },
    });
    expect(selection.backend).toBe("sandbox");
    expect(selection.seeded).toMatchObject({ slug: "jshttp/vary", ref: "master", sha: SHA, depsBackupId: DEPS });
    expect(workspaceBindingFor(selection)?.seeded).toMatchObject({ depsBackupId: DEPS });
    expect(check.mock.calls.at(-1)?.[0]).toContain("node_modules");
    expect(check.mock.calls.at(-1)?.[0]).toContain("git diff --quiet 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' HEAD");
    expect(calls).toEqual([]);
  });

  it("repairs only an opted-in resumed owner before rechecking readiness", async () => {
    envs();
    fetches();
    let probe = 0;
    const check = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "master\n";
      if (command.includes("rev-parse HEAD")) return `${SHA}\n`;
      if (command.includes("config --get remote.origin.url")) return "https://door.example/git/jshttp/vary.git\n";
      return probe++ === 0 ? "LOCKFILE_MISMATCH" : "READY";
    });
    const repair = vi
      .spyOn(CloudflareSandboxExecutor.prototype, "repairDependencies")
      .mockImplementation(async (owner, head) => ({
        version: "install-repair-receipt-v1",
        owner,
        targetHead: head,
        policyVersion: "npm-ci-v1",
        lockfileKey: "c".repeat(64),
      }));
    const binding = {
      backend: "sandbox" as const,
      container: "33333333-3333-3333-3333-333333333333",
      publicationBaseSha: SHA,
      seeded: {
        slug: "jshttp/vary",
        ref: "master",
        workspace: "/workspace/checkout",
        sourceSha: "b".repeat(40),
        seedBackupId: CHECKOUT,
      },
    };
    const base = {
      ...context(),
      headSha: undefined,
      runId: "11111111-1111-1111-1111-111111111111",
      requester: "slack:U123",
      reattach: binding,
    };
    await expect(makeExecutor(opts(), base)).rejects.toMatchObject({ reason: "dependencies_stale" });
    expect(repair).not.toHaveBeenCalled();
    probe = 0;
    const selected = await makeExecutor(opts(), { ...base, installRepairPolicy: { policyVersion: "npm-ci-v1" } });
    expect(selected.seeded?.sha).toBe(SHA);
    expect(workspaceBindingFor(selected)?.seeded?.repairReceipt).toMatchObject({
      targetHead: SHA,
      lockfileKey: "c".repeat(64),
    });
    expect(repair).toHaveBeenCalledOnce();
    expect(repair.mock.calls[0]?.[0]).toMatchObject({
      run: base.runId,
      seed: CHECKOUT,
      container: binding.container,
      head: SHA,
    });
    expect(repair.mock.calls[0]?.[1]).toBe(SHA);
    expect(probe).toBe(2);
    const readiness = check.mock.calls.filter(([command]) => command.includes("node_modules"));
    expect(readiness).toHaveLength(3);
    expect(readiness.at(-1)?.[0]).toContain(`git diff --quiet '${SHA}' HEAD`);
  });

  it("holds a ready reattach when an earlier native repair has no durable receipt", async () => {
    envs();
    fetches();
    vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "master\n";
      if (command.includes("rev-parse HEAD")) return `${SHA}\n`;
      if (command.includes("config --get remote.origin.url")) return "https://door.example/git/jshttp/vary.git\n";
      return "READY";
    });
    const inspect = vi.spyOn(CloudflareSandboxExecutor.prototype, "inspectRepairDependencies").mockResolvedValue({
      kind: "unknown",
    });
    const repair = vi.spyOn(CloudflareSandboxExecutor.prototype, "repairDependencies");
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        runId: "11111111-1111-1111-1111-111111111111",
        requester: "slack:U123",
        installRepairPolicy: { policyVersion: "npm-ci-v1" },
        reattach: {
          backend: "sandbox",
          container: "33333333-3333-3333-3333-333333333333",
          publicationBaseSha: SHA,
          seeded: {
            slug: "jshttp/vary",
            ref: "master",
            workspace: "/workspace/checkout",
            sourceSha: "b".repeat(40),
            seedBackupId: CHECKOUT,
          },
        },
      }),
    ).rejects.toMatchObject({ reason: "dependencies_invalid" });
    expect(inspect).toHaveBeenCalledOnce();
    expect(repair).not.toHaveBeenCalled();
  });

  it("inspects the repaired source head after coding advances the checkout", async () => {
    envs();
    fetches();
    const sourceHead = "b".repeat(40);
    const runId = "11111111-1111-1111-1111-111111111111";
    const container = "33333333-3333-3333-3333-333333333333";
    const owner = {
      run: runId,
      requester: "slack:U123",
      thread: "slack:CX:1.0",
      repository: "jshttp/vary",
      ref: "master",
      head: SHA,
      seed: CHECKOUT,
      container,
    };
    const receipt = {
      version: "install-repair-receipt-v1" as const,
      owner,
      targetHead: sourceHead,
      policyVersion: "npm-ci-v1" as const,
      lockfileKey: "c".repeat(64),
    };
    vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "master\n";
      if (command.includes("rev-parse HEAD")) return `${SHA}\n`;
      if (command.includes("config --get remote.origin.url")) return "https://door.example/git/jshttp/vary.git\n";
      return "READY";
    });
    const inspect = vi.spyOn(CloudflareSandboxExecutor.prototype, "inspectRepairDependencies").mockResolvedValue({
      kind: "completed",
      receipt,
    });
    const selected = await makeExecutor(opts(), {
      ...context(),
      headSha: undefined,
      runId,
      requester: "slack:U123",
      reattach: {
        backend: "sandbox",
        container,
        publicationBaseSha: SHA,
        seeded: {
          slug: "jshttp/vary",
          ref: "master",
          workspace: "/workspace/checkout",
          sourceSha: sourceHead,
          seedBackupId: CHECKOUT,
          repairReceipt: receipt,
        },
      },
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0]?.[1]).toBe(sourceHead);
    expect(selected.seeded?.repairReceipt).toEqual(receipt);
  });

  it("refuses repair when a saved preservation owner field is missing", async () => {
    envs();
    fetches();
    vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "master\n";
      if (command.includes("rev-parse HEAD")) return `${SHA}\n`;
      if (command.includes("config --get remote.origin.url")) return "https://door.example/git/jshttp/vary.git\n";
      return "LOCKFILE_MISMATCH";
    });
    const repair = vi.spyOn(CloudflareSandboxExecutor.prototype, "repairDependencies");
    const binding = {
      backend: "sandbox" as const,
      publicationBaseSha: SHA,
      seeded: {
        slug: "jshttp/vary",
        ref: "master",
        workspace: "/workspace/checkout",
        sourceSha: "b".repeat(40),
        seedBackupId: CHECKOUT,
      },
    };
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        runId: "11111111-1111-1111-1111-111111111111",
        requester: "slack:U123",
        reattach: binding,
        installRepairPolicy: { policyVersion: "npm-ci-v1" },
      }),
    ).rejects.toMatchObject({ reason: "dependencies_stale" });
    expect(repair).not.toHaveBeenCalled();
  });

  it("holds a seeded pilot resume when the recorded dependency snapshot head is absent", async () => {
    envs();
    const check = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockImplementation(async (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "master\n";
      if (command.includes("rev-parse HEAD")) return `${SHA}\n`;
      if (command.includes("config --get remote.origin.url")) return "https://door.example/git/jshttp/vary.git\n";
      return "READY";
    });
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        reattach: {
          backend: "sandbox",
          seeded: { slug: "jshttp/vary", ref: "master", workspace: "/workspace/checkout" },
        },
      }),
    ).rejects.toMatchObject({ reason: "binding_mismatch", beforeModel: true });
    expect(check.mock.calls.some(([command]) => command.includes("node_modules"))).toBe(false);
  });

  it("refuses a resumed pilot writer with no recorded seed before any model command", async () => {
    envs();
    const calls = fetches();
    const check = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockResolvedValue("READY");
    await expect(
      makeExecutor(opts(), {
        ...context(),
        headSha: undefined,
        reattach: { backend: "sandbox" },
      }),
    ).rejects.toMatchObject({ reason: "binding_mismatch", beforeModel: true });
    expect(check).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses a repository without a warm snapshot instead of provisioning cold", async () => {
    envs();
    const calls = fetches({ body: { state: "not-onboarded", reason: "", snapshot: null } });
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({
      reason: "repository_not_onboarded",
      beforeModel: true,
    });
    expect(calls).toEqual(["/status"]);
  });

  it("admits a warm bound resident only after installed deps and the declared tool pass a model-free check", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      {
        body: { workspace: "/workspace/threads/x/master", ref: "master", sha: SHA, deps: "hardlink", depsKey: "lock" },
      },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    const selection = await makeExecutor(opts(), context());
    expect(selection.backend).toBe("resident");
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]?.[0]).toContain("command -v 'npm'");
    expect(check.mock.calls[0]?.[0]).toContain("node_modules");
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("admits a reused resident dependency view only when the resident verifies its key", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: SHA, deps: "none", depsKey: "lock" } },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    const selection = await makeExecutor(opts(), context());
    expect(selection.backend).toBe("resident");
    expect(check).toHaveBeenCalledOnce();
    expect(calls).toEqual(["/status", "/attach"]);
  });

  it("holds the unit before the model when the resident has no dependency view or the tool is missing", async () => {
    envs();
    const calls = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      { body: { workspace: "/workspace/threads/x/master", ref: "master", sha: SHA, deps: "none" } },
      { body: { ok: true } },
    );
    const check = vi.spyOn(ResidentExecutor.prototype, "exec").mockResolvedValue("READY");
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({ reason: "dependencies_missing" });
    expect(check).not.toHaveBeenCalled();
    expect(calls).toEqual(["/status", "/attach", "/detach"]);

    const other = fetches(
      { body: { state: "warm", reason: "", snapshot: snapshot() } },
      {
        body: { workspace: "/workspace/threads/x/master", ref: "master", sha: SHA, deps: "hardlink", depsKey: "lock" },
      },
      { body: { ok: true } },
    );
    check.mockResolvedValue("exit 2:\nMISSING_TOOL:npm");
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({ reason: "tool_missing" });
    expect(other).toEqual(["/status", "/attach", "/detach"]);
  });

  it("admits a seeded sandbox only with a dependency archive, matching source, and a passed tool check", async () => {
    envs();
    const calls = fetches(
      { body: { state: "degraded", reason: "install-failed", snapshot: snapshot() } },
      {
        body: {
          seeded: true,
          cached: false,
          slug: "jshttp/vary",
          ref: "master",
          sha: SHA,
          from: { ref: "master", sha: SHA, checkoutBackupId: CHECKOUT, depsBackupId: DEPS },
          steps: { restore: 1, deps: 1, fixup: 1 },
          ms: 3,
        },
      },
    );
    const check = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockResolvedValue("READY");
    const selection = await makeExecutor(opts(), context());
    expect(selection.backend).toBe("sandbox");
    expect(selection.seeded).toMatchObject({ slug: "jshttp/vary", ref: "master", sha: SHA, depsBackupId: DEPS });
    expect(workspaceBindingFor(selection)?.seeded).toMatchObject({ depsBackupId: DEPS });
    expect(check.mock.calls[0]?.[0]).toContain("/workspace/checkout");
    expect(calls).toEqual(["/status", "/seed"]);
  });

  it("refuses a seeded target whose lockfile changed after the dependency snapshot", async () => {
    envs();
    const target = "89abcdef0123456789abcdef0123456789abcdef";
    const calls = fetches(
      { body: { state: "degraded", reason: "install-failed", snapshot: snapshot() } },
      {
        body: {
          seeded: true,
          cached: false,
          slug: "jshttp/vary",
          ref: "feature/new-deps",
          sha: target,
          from: { ref: "master", sha: SHA, checkoutBackupId: CHECKOUT, depsBackupId: DEPS },
          steps: { restore: 1, deps: 1, fixup: 1 },
          ms: 3,
        },
      },
    );
    const check = vi.spyOn(CloudflareSandboxExecutor.prototype, "exec").mockResolvedValue("LOCKFILE_MISMATCH");
    await expect(
      makeExecutor(opts(), { ...context(), ref: "feature/new-deps", headSha: target }),
    ).rejects.toMatchObject({ reason: "dependencies_stale", beforeModel: true });
    expect(check.mock.calls[0]?.[0]).toContain(`git diff --quiet '${SHA}' HEAD --`);
    expect(calls).toEqual(["/status", "/seed"]);
  });

  it("never falls through to fresh cold when the snapshot lacks deps or the seed fails", async () => {
    envs();
    const calls = fetches({ body: { state: "degraded", reason: "install-failed", snapshot: snapshot(null) } });
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({ reason: "dependencies_missing" });
    expect(calls).toEqual(["/status"]);

    const retry = fetches(
      { body: { state: "degraded", reason: "install-failed", snapshot: snapshot() } },
      { body: { seeded: false, reason: "seed-failed", detail: "restore failed" } },
    );
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({ reason: "seed_failed" });
    expect(retry).toEqual(["/status", "/seed"]);

    const wrongSource = fetches(
      { body: { state: "degraded", reason: "install-failed", snapshot: snapshot() } },
      {
        body: {
          seeded: true,
          cached: false,
          slug: "jshttp/vary",
          ref: "master",
          sha: SHA,
          from: {
            ref: "master",
            sha: SHA,
            checkoutBackupId: CHECKOUT,
            depsBackupId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
          },
          steps: { restore: 1, deps: 1, fixup: 1 },
          ms: 3,
        },
      },
    );
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({ reason: "binding_mismatch" });
    expect(wrongSource).toEqual(["/status", "/seed"]);
  });

  it("refuses a rotated seed without a dependency archive before restoring its checkout", async () => {
    envs();
    const calls = fetches(
      { body: { state: "degraded", reason: "install-failed", snapshot: snapshot() } },
      { body: { seeded: false, reason: "seed-missing", detail: "checkout rotated" } },
      {
        body: {
          state: "degraded",
          reason: "install-failed",
          snapshot: { ...snapshot(null), checkoutBackupId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" },
        },
      },
    );
    await expect(makeExecutor(opts(), context())).rejects.toMatchObject({
      reason: "dependencies_missing",
      beforeModel: true,
    });
    expect(calls).toEqual(["/status", "/seed", "/status"]);
  });
});
