import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { ExecCapacityError, ExecInfraError } from "./executor.js";
import { FLEET_BUSY_WAIT_MAX_MS } from "./sandboxErrors.js";

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
  const sentEnv = (c: { init: RequestInit }) => sentBody(c).env as Record<string, string>;

  it("resolves the sandbox env on EVERY call, so each command carries the credential current at its start", async () => {
    const { calls } = stubFetch({ stdout: "ok", stderr: "", exitCode: 0 });
    let token = "ghs_first";
    const resolveEnvs = vi.fn(async () => ({ GH_TOKEN: token }));
    const ex = new CloudflareSandboxExecutor({ ...OPTS, resolveEnvs });

    await ex.exec("gh pr view 1");
    token = "ghs_second";
    await ex.exec("gh pr diff 1");

    expect(resolveEnvs).toHaveBeenCalledTimes(2);
    expect(sentEnv(calls[0]).GH_TOKEN).toBe("ghs_first");
    expect(sentEnv(calls[1]).GH_TOKEN).toBe("ghs_second");
  });

  it("resolves nothing at construction — building the executor mints no credential", () => {
    const resolveEnvs = vi.fn(async () => ({ GH_TOKEN: "ghs_x" }));
    new CloudflareSandboxExecutor({ ...OPTS, resolveEnvs });
    expect(resolveEnvs).not.toHaveBeenCalled();
  });
});

// Feature: features/execution.md item 5 — the env map rides in the JSON body
// (authoritative), plus `x-env-*` headers for ONE release as the compatibility
// path for a sandbox Worker not yet on the body reader (`deploy all` deploys
// the bot before the sandbox Worker). 2026-09-07 (#447 receipt): Workers Logs
// record an invocation's request headers and redact by a NAME heuristic — the
// probe's `x-env-PROBE_VAR: hello-from-env-option` was logged in clear while
// `x-env-gh_token` happened to be REDACTED. Bodies are not recorded; next
// release the headers go and the body stands alone.
describe("CloudflareSandboxExecutor env transport", () => {
  const sentHeaders = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

  it("sends the same map in the body and in x-env-* headers on every route", async () => {
    const { calls } = stubFetch({ stdout: "ok", stderr: "", exitCode: 0, content: "c" });
    const ex = new CloudflareSandboxExecutor({ ...OPTS, resolveEnvs: async () => ({ GH_TOKEN: "ghs_x", OTHER: "v" }) });
    await ex.exec("gh pr view 1");
    await ex.readFile("README.md");
    await ex.writeFile("a.txt", "body");
    expect(calls.map((c) => c.url)).toEqual([
      "https://sandbox.example/exec",
      "https://sandbox.example/read",
      "https://sandbox.example/write",
    ]);
    for (const c of calls) {
      expect(sentBody(c).env).toEqual({ GH_TOKEN: "ghs_x", OTHER: "v" });
      expect(sentHeaders(c)).toEqual({
        authorization: "Bearer t",
        "content-type": "application/json",
        "x-thread-key": "slack:CX:1.0",
        "x-env-GH_TOKEN": "ghs_x",
        "x-env-OTHER": "v",
      });
    }
  });

  it("an empty env is still the one body shape: `env: {}`, so the Worker reads one field on every route", async () => {
    const { calls } = stubFetch({ stdout: "ok", stderr: "", exitCode: 0 });
    await new CloudflareSandboxExecutor(OPTS).exec("ls");
    expect(sentBody(calls[0])).toEqual({ command: "ls", env: {} });
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

// Feature: features/execution.md item 14 — a full fleet is capacity, not a
// dead sandbox. The Worker names it (`reason: "fleet-busy"`, in-body on /exec
// or HTTP 503 on /read + /write); the executor waits a bounded time and
// re-sends the identical request, and only when that wait is exhausted throws
// ExecCapacityError — never ExecInfraError, so the runner's fail-fast breaker
// (#92) is not tripped by a fleet that is merely full. Fake timers drive the
// waits; every fetch is mocked.
describe("CloudflareSandboxExecutor fleet-busy wait", () => {
  const BUSY_EXEC = {
    error: "fleet-busy: no free per-thread sandbox",
    reason: "fleet-busy",
    stdout: "",
    stderr: "fleet-busy: no free per-thread sandbox",
    exitCode: 127,
  };
  const OK = { stdout: "ok", stderr: "", exitCode: 0 };

  /** Fetch that answers the scripted responses in order, then repeats the last. */
  function scriptedFetch(responses: Array<{ status?: number; body: unknown }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    });
    vi.stubGlobal("fetch", fn);
    return { fn, calls };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends the SAME route, body and headers after 10 s then 20 s and returns the eventual result", async () => {
    const { calls } = scriptedFetch([{ body: BUSY_EXEC }, { body: BUSY_EXEC }, { body: OK }]);
    const ex = new CloudflareSandboxExecutor({ ...OPTS, resolveEnvs: async () => ({ GH_TOKEN: "ghs_x" }) });
    const p = ex.exec("npm test", { timeoutMs: 120_000 });
    const settled = vi.fn();
    void p.then(settled, settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(1); // still inside the first 10 s wait
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toHaveLength(2); // inside the 20 s wait
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    await expect(p).resolves.toBe("ok");
    for (const c of calls) {
      expect(c.url).toBe(calls[0].url);
      expect(c.init.method).toBe("POST");
      expect(String(c.init.body)).toBe(String(calls[0].init.body));
      expect(c.init.headers).toEqual(calls[0].init.headers);
    }
    expect(sentBody(calls[2])).toEqual({ command: "npm test", timeoutMs: 120_000, env: { GH_TOKEN: "ghs_x" } });
  });

  it("gives up once the total wait reaches the command's own budget and throws ExecCapacityError, not ExecInfraError", async () => {
    const { calls } = scriptedFetch([{ body: BUSY_EXEC }]);
    const ex = new CloudflareSandboxExecutor(OPTS);
    const p = ex.exec("npm test", { timeoutMs: 60_000 });
    const outcome = p.then(
      () => "resolved",
      (e: unknown) => e,
    );
    // 10 + 20 + 30 = 60 s of waiting, four sends in total, then no fifth.
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(ExecCapacityError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toBe(
      "sandbox fleet busy — no free per-thread sandbox after waiting 60s (the fleet's max_instances is reached); try again in a few minutes",
    );
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(4);
  });

  it("never waits longer than FLEET_BUSY_WAIT_MAX_MS (5 min) even for a 20-minute command", async () => {
    const { calls } = scriptedFetch([{ body: BUSY_EXEC }]);
    const ex = new CloudflareSandboxExecutor(OPTS);
    const outcome = ex.exec("npm test", { timeoutMs: 20 * 60_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FLEET_BUSY_WAIT_MAX_MS);
    const err = await outcome;
    expect(err).toBeInstanceOf(ExecCapacityError);
    expect((err as Error).message).toContain("after waiting 300s");
    // 10 + 20 + 30×9 = 300 s → 11 waits, 12 sends.
    expect(calls).toHaveLength(12);
  });

  it("a /read answered HTTP 503 with reason fleet-busy is the same wait (the default 5-min budget applies)", async () => {
    const { calls } = scriptedFetch([
      { status: 503, body: { error: "fleet-busy: no free per-thread sandbox", reason: "fleet-busy" } },
      { body: { content: "file body" } },
    ]);
    const ex = new CloudflareSandboxExecutor(OPTS);
    const p = ex.readFile("README.md");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("file body");
    expect(calls).toHaveLength(2);
    expect(sentBody(calls[1])).toEqual(sentBody(calls[0]));
  });

  it("a hard stop during the wait ends it at once with no further send", async () => {
    const { calls } = scriptedFetch([{ body: BUSY_EXEC }]);
    const ex = new CloudflareSandboxExecutor(OPTS);
    const ac = new AbortController();
    const outcome = ex.exec("sleep 300", { timeoutMs: 300_000, signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    ac.abort();
    const err = await outcome;
    expect(err).toBeInstanceOf(ExecCapacityError);
    expect((err as Error).message).toMatch(/stopped/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  it("every OTHER in-body error is still ExecInfraError after exactly one send — nothing else is replayed", async () => {
    const { calls } = scriptedFetch([
      { body: { error: "Command execution failed", stdout: "", stderr: "Command execution failed", exitCode: 127 } },
    ]);
    const ex = new CloudflareSandboxExecutor(OPTS);
    const outcome = ex.exec("echo hi").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FLEET_BUSY_WAIT_MAX_MS);
    const err = await outcome;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toBe("sandbox worker /exec: Command execution failed");
    expect(calls).toHaveLength(1);
  });

  it("an OLD Worker's bare Failed-to-create-session 503 (no reason) still reads as infra — one send", async () => {
    const { calls } = scriptedFetch([
      {
        body: {
          error: "Failed to create session: 503",
          stdout: "",
          stderr: "Failed to create session: 503",
          exitCode: 127,
        },
      },
    ]);
    const ex = new CloudflareSandboxExecutor(OPTS);
    const outcome = ex.exec("echo hi").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FLEET_BUSY_WAIT_MAX_MS);
    expect(await outcome).toBeInstanceOf(ExecInfraError);
    expect(calls).toHaveLength(1);
  });
});

// Feature: features/execution.md items 3 and 9 — a present-but-empty `error`
// is the Worker's failure shape with its text missing, never a command exit.
// 2026-09-07 (#569): a thread placed on a previous-image container during a
// rollout got `{error: "", stdout: "", stderr: "", exitCode: 127}` for every
// command; the truthy-only check let it through as a plain `exit 127`, the
// health tracker counted a success, and the model reported its shell "down".
// A success body has no `error` key at all, so the key's PRESENCE is the
// signal — a bare exit 127 with no output stays a legitimate command result.
describe("CloudflareSandboxExecutor in-body empty error", () => {
  it("an empty-string error is ExecInfraError after exactly one fetch — the Worker's failure shape with its text missing", async () => {
    const { calls } = stubFetch({ error: "", stdout: "", stderr: "", exitCode: 127 });
    const ex = new CloudflareSandboxExecutor(OPTS);
    const err = await ex.exec("echo hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toBe(
      "sandbox worker /exec: failure with an empty message (the Worker's failure shape with its text missing)",
    );
    expect(calls).toHaveLength(1);
  });

  it("a body WITHOUT an error key and exit 127 with empty output is the normal `exit 127:` result — `foo 2>/dev/null` is legitimate", async () => {
    stubFetch({ stdout: "", stderr: "", exitCode: 127 });
    const ex = new CloudflareSandboxExecutor(OPTS);
    await expect(ex.exec("foo 2>/dev/null")).resolves.toBe("exit 127:\n");
  });

  it("exit 0 with no error key and no output renders (no output)", async () => {
    stubFetch({ stdout: "", stderr: "", exitCode: 0 });
    const ex = new CloudflareSandboxExecutor(OPTS);
    await expect(ex.exec("true")).resolves.toBe("(no output)");
  });
});
