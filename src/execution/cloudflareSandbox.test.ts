import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";

// Feature: features/execution.md item 11 — per-call bash timeout on the
// per-thread sandbox path. Like the resident client: the budget rides in the
// /exec body only when the caller asked for one (an older sandbox Worker sees
// the body it always did), clamped client-side to [1s, 20 min]; the Worker
// clamps again server-side. All fetches are mocked.

const OPTS = {
  url: "https://sandbox.example",
  token: "t",
  threadKey: "slack:CX:1.0",
  resolveEnvs: async () => ({}),
};

function stubFetch(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const sentBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

// Feature: features/execution.md item 5 — the sandbox credential is resolved
// per command, not per run. 2026-09-07 (review of #521): the token captured at
// executor construction expired while the run's first command ran for 20
// minutes, and every later command carried the same dead token.
describe("CloudflareSandboxExecutor credential freshness", () => {
  const envHeader = (c: { init: RequestInit }) => (c.init.headers as Record<string, string>)["x-env-GH_TOKEN"];

  it("resolves the sandbox env on EVERY call, so each command carries the credential current at its start", async () => {
    const { calls } = stubFetch({ stdout: "ok", stderr: "", exitCode: 0 });
    let token = "ghs_first";
    const resolveEnvs = vi.fn(async () => ({ GH_TOKEN: token }));
    const ex = new CloudflareSandboxExecutor({ ...OPTS, resolveEnvs });

    await ex.exec("gh pr view 1");
    token = "ghs_second";
    await ex.exec("gh pr diff 1");

    expect(resolveEnvs).toHaveBeenCalledTimes(2);
    expect(envHeader(calls[0])).toBe("ghs_first");
    expect(envHeader(calls[1])).toBe("ghs_second");
  });

  it("resolves nothing at construction — building the executor mints no credential", () => {
    const resolveEnvs = vi.fn(async () => ({ GH_TOKEN: "ghs_x" }));
    new CloudflareSandboxExecutor({ ...OPTS, resolveEnvs });
    expect(resolveEnvs).not.toHaveBeenCalled();
  });
});

describe("CloudflareSandboxExecutor per-call timeout", () => {
  it("sends the requested timeoutMs in the /exec body, clamped to the 20-min ceiling", async () => {
    const { calls } = stubFetch({ stdout: "ok", stderr: "", exitCode: 0 });
    const ex = new CloudflareSandboxExecutor(OPTS);
    await expect(ex.exec("npm test", { timeoutMs: 25 * 60_000 })).resolves.toBe("ok");
    expect(sentBody(calls[0]).timeoutMs).toBe(20 * 60_000);
    expect(sentBody(calls[0]).command).toBe("npm test");
  });

  it("no timeoutMs → the body an older sandbox Worker expects (no timeoutMs key at all)", async () => {
    const { calls } = stubFetch({ stdout: "ok", stderr: "", exitCode: 0 });
    const ex = new CloudflareSandboxExecutor(OPTS);
    await ex.exec("ls");
    expect("timeoutMs" in sentBody(calls[0])).toBe(false);
  });
});
