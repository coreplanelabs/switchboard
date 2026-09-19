import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentExecutor } from "./resident.js";

const ROOT = resolve(import.meta.dirname, "../..");

// Feature: docs/reference/specs/harness-pi.md item 4 — the resident Worker
// carries a caller's extra environment for one `/exec` the way the sandbox
// Worker does: read from the body alone through the one validated reader,
// handed to the SDK's per-exec env option, never onto the command text. The
// Worker cannot run under vitest (a Durable Object over a container), so this
// mirrors the sandbox Worker's static guard: read the source and require the
// seam to be wired, so dropping it goes red here, not in a run.
describe("resident Worker /exec env (static)", () => {
  const worker = readFileSync(resolve(ROOT, "deploy/cloudflare-resident/worker.ts"), "utf8");

  it("reads the env map from the body through envFromRequest and hands it to execThread", () => {
    expect(worker).toMatch(/import \{ envFromRequest \} from "\.\.\/\.\.\/src\/execution\/sandboxEnv\.js";/);
    expect(worker).toMatch(/const execEnv = envFromRequest\(\{ body \}\);/);
    expect(worker).toMatch(/execThread\(ctx\.threadKey, body\.command, timeoutMs, traceparent, execEnv\)/);
  });

  it("threads the env through to the thread run, merged under the Worker's own injected variables and validated by name", () => {
    expect(worker).toMatch(/const injected = \{ \.\.\.\(env \?\? \{\}\), GIT_TERMINAL_PROMPT: "0" \};/);
    expect(worker).toMatch(/validateEnvNames\(injected\)/);
  });

  it("reads the env from no request header — the header channel appears only in the note that says it is ignored", () => {
    expect(worker).not.toMatch(/headers\.get\(\s*["'`]x-env/i);
    expect(worker).not.toMatch(/request\.headers[^\n]*x-env/i);
  });
});

// Feature: docs/reference/specs/execution.md item 5; resident-repos.md — the
// run's commit identity (record 0062) reaches the resident in each `/exec`
// body's `env`, resolved fresh per command through the executor's
// `resolveEnvs`, in the body alone (no x-env-* header — the static guard
// above pins the Worker's side).
describe("ResidentExecutor — the commit identity rides each /exec body's env", () => {
  const OPTS = {
    baseUrl: "https://resident.example",
    token: "op-token",
    resource: "repo:jshttp/vary",
    threadKey: "slack:CX:1.0",
  };
  const FOUR = {
    GIT_AUTHOR_NAME: "ivy-dev",
    GIT_AUTHOR_EMAIL: "4242+ivy-dev@users.noreply.github.com",
    GIT_COMMITTER_NAME: "switchboard-app[bot]",
    GIT_COMMITTER_EMAIL: "111+switchboard-app[bot]@users.noreply.github.com",
  };
  const stubFetch = () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0, truncated: false }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fn);
    return calls;
  };
  const sentBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the four variables in the /exec body's env, resolved on every exec, and no x-env-* header", async () => {
    const calls = stubFetch();
    const resolveEnvs = vi.fn(async () => ({ ...FOUR }));
    const ex = new ResidentExecutor({ ...OPTS, resolveEnvs });
    expect(resolveEnvs).not.toHaveBeenCalled(); // nothing captured at construction
    await ex.exec("git commit -m x");
    await ex.exec("git commit -m y");
    expect(resolveEnvs).toHaveBeenCalledTimes(2);
    expect(sentBody(calls[0]).env).toEqual(FOUR);
    expect(sentBody(calls[1]).env).toEqual(FOUR);
    for (const c of calls) {
      const headers = Object.keys((c.init.headers ?? {}) as Record<string, string>);
      expect(headers.some((h) => h.toLowerCase().startsWith("x-env"))).toBe(false);
    }
  });

  it("a caller's own variables join the same map under the identity's — the resolved pairs win a clash", async () => {
    const calls = stubFetch();
    const ex = new ResidentExecutor({ ...OPTS, resolveEnvs: async () => ({ ...FOUR }) });
    await ex.exec("pi --version", { env: { SWITCHBOARD_RUN_BEARER: "sbr_x.y", GIT_AUTHOR_NAME: "forged" } });
    expect(sentBody(calls[0]).env).toEqual({ ...FOUR, SWITCHBOARD_RUN_BEARER: "sbr_x.y" });
  });

  it("a resolver with nothing to say leaves the body without an env key, as an executor without one does", async () => {
    const calls = stubFetch();
    const ex = new ResidentExecutor({ ...OPTS, resolveEnvs: async () => ({}) });
    await ex.exec("git status");
    expect("env" in sentBody(calls[0])).toBe(false);
  });
});
