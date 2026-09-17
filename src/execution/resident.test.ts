import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASH_TIMEOUT_MAX_MS,
  ExecControlResetError,
  ExecInfraError,
  ExecSandboxRestartedError,
  infraMayClear,
} from "./executor.js";
import {
  ResidentExecutor,
  ResidentLeaseSpentError,
  ResidentNeedsRefError,
  ResidentOperations,
  ResidentReuseRefusedError,
} from "./resident.js";
import { classificationOf } from "../core/trace/classify.js";
import { BASH_TIMEOUT_MS } from "./bashTimeout.js";
import { residentTraceOf } from "./residentTrace.js";
import { createTracer } from "../core/trace/tracer.js";
import { recordingSink } from "../core/testing/recordingSink.js";
import { configureInternalHosts, internalHostsOf, NO_INTERNAL_HOSTS } from "../core/trace/internalHosts.js";
import { parseTraceparent } from "../core/trace/traceparent.js";

// Feature: docs/reference/specs/resident-repos.md — bot-side resident client: every
// route POSTs {resource, threadKey, ...}; /exec streams heartbeat whitespace
// then one JSON document with in-body errors; needs:"attach" (evicted or
// disk-recycled worktree) is recovered by exactly one re-attach + retry.
// All fetches are mocked — vitest never touches the live service.

const OPTS = {
  baseUrl: "https://resident.example",
  token: "op-token",
  resource: "repo:jshttp/vary",
  threadKey: "slack:CX:1.0",
};

const ATTACH_OK = {
  workspace: "/workspace/threads/slack-CX-1.0-abcd1234/master",
  ref: "master",
  sha: "1220b9c4",
  user: "worker2",
  reconciled: false,
  recreated: true,
  deps: "hardlink",
  credentials: "ok",
  mutexWaitMs: 0,
  attachMs: 2500,
};

/** FIFO fetch stub: each call consumes the next canned response. */
function stubFetch(...responses: Array<{ status?: number; body?: unknown; raw?: string; reject?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
    if (next.reject) throw new TypeError(next.reject);
    const text = next.raw ?? JSON.stringify(next.body ?? {});
    return new Response(text, { status: next.status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const route = (c: { url: string }) => new URL(c.url).pathname;
const sentBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResidentExecutor.attach over a heartbeat stream (item 59: an attach that waits on an install must not lose the connection)", () => {
  it("parses heartbeat whitespace then the binding, exactly like /exec", async () => {
    stubFetch({ raw: "\n\n\n" + JSON.stringify(ATTACH_OK) });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.attach()).resolves.toEqual({
      ref: "master",
      sha: "1220b9c4",
      workspace: ATTACH_OK.workspace,
      user: "worker2",
      attachMs: 2500,
    });
  });

  // Feature: docs/reference/specs/tracing.md item 19 — the resident's step trace rides the
  // binding, rebuilt from the allowlist; a Worker without one binds as before.
  it("carries the resident's step trace on the binding, sanitized: hostile names and malformed steps never survive, and a trace-less answer has no trace", async () => {
    stubFetch({
      raw: JSON.stringify({
        ...ATTACH_OK,
        trace: [
          { name: "mutex_wait", startMs: 0, durationMs: 300, status: "ok", waitedMs: 300 },
          { name: "Clone (mirror)", startMs: 300, durationMs: 1_800, status: "ok", exitCode: 0, error: "ghp_leak" },
          { name: "install", startMs: "2100", durationMs: 400 },
        ],
      }),
    });
    const traced = await new ResidentExecutor(OPTS).attach();
    expect(traced.trace).toEqual([
      { name: "mutex_wait", startMs: 0, durationMs: 300, status: "ok", waitedMs: 300 },
      { name: "clone-mirror", startMs: 300, durationMs: 1_800, status: "ok", exitCode: 0 },
    ]);
    expect(JSON.stringify(traced)).not.toContain("leak");
    stubFetch({ raw: JSON.stringify({ ...ATTACH_OK, attachMs: undefined }) });
    const plain = await new ResidentExecutor(OPTS).attach();
    expect(plain.trace).toBeUndefined();
    expect(plain.attachMs).toBeUndefined();
  });

  // Feature: docs/reference/specs/tracing.md item 19 — a refused attach's steps ride the
  // error it becomes, sanitized, so the dispatcher can still graft them.
  it("pins a refused attach's step trace on the thrown error, sanitized; a trace-less refusal pins nothing", async () => {
    stubFetch({
      status: 503,
      body: {
        error: "install timed out",
        state: "warm",
        reason: "install-timeout",
        trace: [
          { name: "mutex_wait", startMs: 0, durationMs: 100, status: "ok", waitedMs: 100 },
          {
            name: "install",
            startMs: 100,
            durationMs: 600_000,
            status: "error",
            exitCode: 124,
            timedOut: true,
            error: "ghp_leak",
          },
        ],
      },
    });
    const err = await new ResidentExecutor(OPTS).attach().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(residentTraceOf(err)).toEqual({
      steps: [
        { name: "mutex_wait", startMs: 0, durationMs: 100, status: "ok", waitedMs: 100 },
        { name: "install", startMs: 100, durationMs: 600_000, status: "error", exitCode: 124, timedOut: true },
      ],
    });
    expect(JSON.stringify(residentTraceOf(err))).not.toContain("leak");
    stubFetch({ status: 503, body: { error: "mirror busy", state: "refreshing", reason: "mirror-busy" } });
    const plain = await new ResidentExecutor(OPTS).attach().catch((e: unknown) => e);
    expect(residentTraceOf(plain)).toBeUndefined();
  });

  it("a refusal streamed over HTTP 200 carries its status IN THE BODY and is handled like the same real status", async () => {
    stubFetch({
      status: 200,
      raw:
        "\n" +
        JSON.stringify({ error: "mirror-busy: mutex not acquired within 60000ms", status: 503, reason: "mirror-busy" }),
    });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.attach()).rejects.toThrow(/resident attach failed for repo:jshttp\/vary: mirror-busy/);
  });

  it('needs:"ref" streamed with status 409 is still ResidentNeedsRefError with the default branch', async () => {
    stubFetch({ status: 200, body: { error: "needs ref", status: 409, needs: "ref", defaultRef: "master" } });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.attach().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResidentNeedsRefError);
    expect((err as ResidentNeedsRefError).defaultRef).toBe("master");
  });

  it("pre-validation refusals keep using the real HTTP status (a 404 body without `status` is still not-onboarded)", async () => {
    stubFetch({ status: 404, body: { error: "repo:jshttp/vary is not onboarded" } });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.attach()).rejects.toThrow(/is not onboarded/);
  });
});

describe("ResidentExecutor.exec", () => {
  it("parses the streamed body: leading heartbeat whitespace then one JSON document", async () => {
    const { calls } = stubFetch({
      raw: " \n \n " + JSON.stringify({ stdout: "hi\n", stderr: "", exitCode: 0, truncated: false }),
    });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("node -e \"console.log('hi')\"")).resolves.toBe("hi\n");
    // every route carries resource + threadKey in the JSON body
    expect(route(calls[0])).toBe("/exec");
    expect(sentBody(calls[0])).toMatchObject({
      resource: "repo:jshttp/vary",
      threadKey: "slack:CX:1.0",
      command: "node -e \"console.log('hi')\"",
    });
    // operator bearer, no x-env headers (the resident ignores them by design)
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer op-token");
    expect(Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-env-"))).toBe(false);
  });

  it("a non-zero exit is a result, not an error", async () => {
    stubFetch({ body: { stdout: "", stderr: "boom", exitCode: 2, truncated: false } });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("false")).resolves.toMatch(/^exit 2:\nboom/);
  });

  // docs/reference/specs/harness-pi.md item 4: a caller's extra environment
  // rides in the /exec body as `env` — the channel the pi harness hands the
  // run bearer through — and only when the caller gave one, so an older
  // resident sees the body it always did.
  it("sends a caller's env in the /exec body, and no env key at all without one", async () => {
    const { calls } = stubFetch(
      { body: { stdout: "ok", stderr: "", exitCode: 0, truncated: false } },
      { body: { stdout: "ok", stderr: "", exitCode: 0, truncated: false } },
    );
    const ex = new ResidentExecutor(OPTS);
    await ex.exec("pi --version", { env: { SWITCHBOARD_RUN_BEARER: "sbr_x.y", PI_CODING_AGENT_DIR: "/tmp/pi" } });
    expect(sentBody(calls[0]).env).toEqual({ SWITCHBOARD_RUN_BEARER: "sbr_x.y", PI_CODING_AGENT_DIR: "/tmp/pi" });
    await ex.exec("pi --version");
    expect("env" in sentBody(calls[1])).toBe(false);
  });

  it('needs:"attach" for an evicted worktree re-attaches once and retries the command', async () => {
    const { fn, calls } = stubFetch(
      {
        body: {
          error: "evicted: this thread's worktree was evicted after inactivity — POST /attach to recreate",
          needs: "attach",
          stdout: "",
          stderr: "evicted",
          exitCode: 127,
        },
      },
      { body: ATTACH_OK },
      { raw: "  " + JSON.stringify({ stdout: "recovered", stderr: "", exitCode: 0, truncated: false }) },
    );
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("echo recovered")).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(calls.map(route)).toEqual(["/exec", "/attach", "/exec"]);
    // the retried command is the same one, not a mutation
    expect(sentBody(calls[2]).command).toBe("echo recovered");
  });

  // Feature: docs/reference/specs/resident-repos.md item 27 / harness-pi.md
  // item 16 — the preflight's `worktree-missing` says the container disk was
  // recycled since the last attach: the container under the thread is gone,
  // and with it every process the run had in it. On /exec that is the typed
  // restart at once: no recovery is attempted first (a refused or slow
  // re-attach used to stand in for the verdict), and the command is never
  // re-issued in the replacement.
  it('needs:"attach" saying the container disk was recycled (`worktree-missing`) on /exec is the typed ExecSandboxRestartedError at once — no re-attach, the command is never re-issued', async () => {
    const { calls } = stubFetch({
      body: {
        error: "worktree-missing: the container disk was recycled since the last attach — POST /attach to recreate",
        needs: "attach",
        stdout: "",
        stderr: "worktree-missing",
        exitCode: 127,
      },
    });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("kill -0 4242").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as ExecSandboxRestartedError).waitedMs).toBe(0);
    expect((err as Error).message).toBe(
      "worktree-missing: the container disk was recycled since the last attach — POST /attach to recreate; the command was not run again",
    );
    expect(calls.map(route)).toEqual(["/exec"]);
  });

  it('a second needs:"attach" after re-attach is a legible ExecInfraError, not a loop', async () => {
    stubFetch(
      {
        body: { error: "evicted: worktree was evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 },
      },
      { body: ATTACH_OK },
      {
        body: {
          error: "evicted: still gone",
          needs: "attach",
          stdout: "",
          stderr: "evicted",
          exitCode: 127,
        },
      },
    );
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("echo x").catch((e: unknown) => e);
    // worktree still gone after a re-attach → the resident is unhealthy: genuine
    // infra, so it counts toward fail-fast.
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/re-attach/);
  });

  it("runtime-replaced (a deploy mid-command) on /exec is the typed ExecSandboxRestartedError at once — no re-attach, the command is NEVER re-run", async () => {
    // The resident names a mid-command runtime replacement (a `wrangler deploy`
    // swapped the isolate under a running command): the process may have
    // started and produced side effects, so the client must not blind-retry.
    // The container under the thread is gone with everything the run had in
    // it, so the answer is the typed word the pi harness keys on, before any
    // recovery — the re-attach it used to make first blocks through the
    // restore and can be refused, and either hid the verdict (the 1.230.0 miss).
    const { fn, calls } = stubFetch({
      body: {
        error: "runtime-replaced: the resident runtime was replaced (a deploy) while this command ran",
        reason: "runtime-replaced",
        stdout: "",
        stderr: "runtime-replaced",
        exitCode: 127,
      },
    });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("pnpm install").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as ExecSandboxRestartedError).waitedMs).toBe(0);
    expect((err as Error).message).toBe(
      "runtime-replaced: the resident runtime was replaced (a deploy) while this command ran; the command was not run again",
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.map(route)).toEqual(["/exec"]);
  });

  it("control-reset (a DO reset mid-command) on /exec is the typed ExecControlResetError at once — no re-attach, NOT a restart, NOT infra: the container is unchanged and the outcome is unknown", async () => {
    // A `wrangler deploy` of the Worker code (no image change) reset this DO's
    // isolate under the command: the container and its processes are as they
    // were. The client must not read this as a replaced container (that would
    // orphan a live pi), nor as a dead sandbox (fail-fast). It is its own word,
    // resolved by the harness seam (re-send an idempotent op; a write by echo).
    const { fn, calls } = stubFetch({
      body: {
        error:
          "control-reset: the resident's Durable Object was reset (a deploy) while this command was running; the container and its processes are as they were; the command's outcome is unknown",
        reason: "control-reset",
        stdout: "",
        stderr: "control-reset",
        exitCode: 127,
      },
    });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("git status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecControlResetError);
    expect(err).not.toBeInstanceOf(ExecSandboxRestartedError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/^control-reset: the resident's Durable Object was reset/);
    expect((err as Error).message).toMatch(/the command's outcome is unknown/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls.map(route)).toEqual(["/exec"]); // nothing recovered first: the word is the answer
  });

  it("two runtime-replaced /exec answers in a row are two typed restarts — the streak's infra error is for the idempotent routes, never for the word the harness keys on", async () => {
    const replaced = {
      error: "runtime-replaced: the resident runtime was replaced (a deploy) while this command ran",
      reason: "runtime-replaced",
      stdout: "",
      stderr: "runtime-replaced",
      exitCode: 127,
    };
    stubFetch({ body: replaced }, { body: replaced });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("echo a")).rejects.toBeInstanceOf(ExecSandboxRestartedError);
    const second = await ex.exec("echo b").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ExecSandboxRestartedError);
    expect(second).not.toBeInstanceOf(ExecInfraError);
  });

  it("a successful op between two runtime-replaced reads resets the streak (each is a one-off deploy)", async () => {
    const replaced = { error: "runtime-replaced: deploy", reason: "runtime-replaced" };
    stubFetch(
      { status: 409, body: replaced },
      { body: ATTACH_OK },
      { body: { content: "first" } },
      { body: { content: "fine" } },
      { status: 409, body: replaced },
      { body: ATTACH_OK },
      { body: { content: "third" } },
    );
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.readFile("a")).resolves.toBe("first");
    await expect(ex.readFile("b")).resolves.toBe("fine");
    await expect(ex.readFile("c")).resolves.toBe("third");
  });

  it("a command-too-long rejection (plain HTTP 400, no needs) is a normal client Error, not infra", async () => {
    // The resident rejects an over-length command PRE-validation: a plain HTTP
    // 400 with an {error} and NO `needs`, nothing streamed (worker.ts handleExec).
    // It's agent-fixable, so it must be a normal Error — NOT an ExecInfraError
    // that would falsely count toward the fail-fast abort on a HEALTHY resident.
    const { fn } = stubFetch({
      status: 400,
      body: { error: "command must be a non-empty string of at most 64000 chars" },
    });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/at most 64000 chars/);
    expect(fn).toHaveBeenCalledTimes(1); // never retried
  });

  it("an in-body error over the HTTP 200 stream (post-validation exec failure) stays infra", async () => {
    // A post-validation failure arrives IN-BODY over the HTTP 200 stream (no
    // `needs`): the exec transport itself failed, so it remains ExecInfraError.
    const { fn } = stubFetch({
      body: { error: "exec transport crashed", stdout: "", stderr: "exec transport crashed", exitCode: 127 },
    });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/exec transport crashed/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("every route is bounded by an AbortSignal.timeout so a hung resident can't stall the dispatch", async () => {
    const { calls } = stubFetch({ body: { stdout: "ok", stderr: "", exitCode: 0, truncated: false } });
    await new ResidentExecutor(OPTS).exec("echo ok");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

// An infra failure (`ExecInfraError`) names a genuinely dead resident and
// NEVER a healthy one that merely rejected agent-fixable input. A
// client/validation rejection (command-too-long) is the exact false-positive
// the classification closes.
describe("ResidentExecutor infra classification", () => {
  it("two consecutive command-too-long rejections are plain errors, never infra (healthy resident)", async () => {
    stubFetch(
      { status: 400, body: { error: "command must be a non-empty string of at most 64000 chars" } },
      { status: 400, body: { error: "command must be a non-empty string of at most 64000 chars" } },
    );
    const executor = new ResidentExecutor(OPTS);
    const first = await executor.exec("x".repeat(65000)).catch((e: unknown) => e);
    const second = await executor.exec("y".repeat(65000)).catch((e: unknown) => e);
    for (const err of [first, second]) {
      expect((err as Error).message).toMatch(/64000 chars/);
      expect(err).not.toBeInstanceOf(ExecInfraError); // a healthy resident, not a dead one
    }
  });

  it("a genuine infra failure (worktree still gone after re-attach) is an ExecInfraError", async () => {
    stubFetch(
      { body: { error: "evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 } },
      { body: ATTACH_OK },
      {
        body: {
          error: "evicted: still gone",
          needs: "attach",
          stdout: "",
          stderr: "evicted",
          exitCode: 127,
        },
      },
    );
    const executor = new ResidentExecutor(OPTS);
    const err = await executor.exec("echo x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
  });

  it("a runtime-replaced on /exec (one deploy) is the typed restart, never infra", async () => {
    stubFetch({
      body: {
        error: "runtime-replaced: deploy",
        reason: "runtime-replaced",
        stdout: "",
        stderr: "runtime-replaced",
        exitCode: 127,
      },
    });
    const executor = new ResidentExecutor(OPTS);
    const err = await executor.exec("echo x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
  });

  it("a non-2xx HTTP status is infra", async () => {
    stubFetch({ status: 503, raw: "mirror busy" });
    const executor = new ResidentExecutor(OPTS);
    const err = await executor.exec("echo x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
  });

  // A deploy that ROLLS the container (not just swaps the isolate) makes
  // the resident answer the SAME `reason:"runtime-replaced"` it does for an
  // isolate swap — because worker.ts classifies the raw workerd refusal
  // "The container is not running, consider calling start()" as a replacement.
  // Answered as a bare infra error instead, the roll would read as a dead
  // sandbox. These two assert the contract at the boundary the bug tripped:
  // on /exec the typed restart the pi harness keys on, on the idempotent
  // routes the streak that keeps a flapping resident from riding forever.
  const containerRolled = {
    error:
      "resident /exec: runtime-replaced: the resident runtime was replaced (a deploy) while this command was " +
      "starting; its output is lost (The container is not running, consider calling start())",
    reason: "runtime-replaced",
    stdout: "",
    stderr: "runtime-replaced",
    exitCode: 127,
  };

  it("a container roll under /exec is the typed restart carrying the resident's words — no infra error, no re-attach", async () => {
    const { calls } = stubFetch({ body: containerRolled });
    const executor = new ResidentExecutor(OPTS);
    const err = await executor.exec("git status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/consider calling start/); // the resident's own words ride the verdict
    expect(calls.map(route)).toEqual(["/exec"]); // nothing is recovered first: the verdict is the answer
  });

  it("bound: a container that cannot come back is infra on the idempotent routes — a second roll with no success between", async () => {
    const rolledRead = { status: 409, body: { error: containerRolled.error, reason: "runtime-replaced" } };
    stubFetch(rolledRead, { body: ATTACH_OK }, rolledRead);
    const executor = new ResidentExecutor(OPTS);
    const err = await executor.readFile("README.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/2 times in a row/);
  });
});

describe("ResidentExecutor.readFile / writeFile", () => {
  it("round-trips content through /read and /write", async () => {
    const { calls } = stubFetch({ body: { ok: true, bytes: 5 } }, { body: { content: "hello", truncated: false } });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.writeFile("docs/x.txt", "hello")).resolves.toBe("Wrote docs/x.txt");
    await expect(ex.readFile("docs/x.txt")).resolves.toBe("hello");
    expect(calls.map(route)).toEqual(["/write", "/read"]);
    expect(sentBody(calls[0])).toMatchObject({ path: "docs/x.txt", content: "hello", resource: OPTS.resource });
  });

  it('a 409 needs:"attach" on read re-attaches once and retries', async () => {
    const { calls } = stubFetch(
      { status: 409, body: { error: "not-attached: no live worktree", needs: "attach" } },
      { body: ATTACH_OK },
      { body: { content: "back", truncated: false } },
    );
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.readFile("f.txt")).resolves.toBe("back");
    expect(calls.map(route)).toEqual(["/read", "/attach", "/read"]);
  });

  it("a 409 runtime-replaced on read (idempotent) re-attaches once and retries; a second one is infra", async () => {
    const replaced = { status: 409, body: { error: "runtime-replaced: deploy", reason: "runtime-replaced" } };
    const { calls } = stubFetch(replaced, { body: ATTACH_OK }, { body: { content: "back", truncated: false } });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.readFile("f.txt")).resolves.toBe("back");
    expect(calls.map(route)).toEqual(["/read", "/attach", "/read"]);

    stubFetch(replaced, { body: ATTACH_OK }, replaced);
    const err = await new ResidentExecutor(OPTS).readFile("f.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/2 times in a row/);
  });

  it("a 409 control-reset on read (idempotent) re-attaches once and re-issues; a second one is the unknown outcome, ExecControlResetError — never infra", async () => {
    const reset = {
      status: 409,
      body: {
        error: "control-reset: the resident's Durable Object was reset (a deploy); the command's outcome is unknown",
        reason: "control-reset",
      },
    };
    const { calls } = stubFetch(reset, { body: ATTACH_OK }, { body: { content: "back", truncated: false } });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.readFile("f.txt")).resolves.toBe("back");
    expect(calls.map(route)).toEqual(["/read", "/attach", "/read"]);

    stubFetch(reset, { body: ATTACH_OK }, reset);
    const err = await new ResidentExecutor(OPTS).readFile("f.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecControlResetError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/^control-reset:/);
  });

  it("a 409 control-reset on /write re-attaches once and re-issues the same full-content put — safe because the whole file's bytes land again, never a delta; a second reset is the unknown outcome", async () => {
    const reset = {
      status: 409,
      body: { error: "control-reset: the resident's Durable Object was reset (a deploy)", reason: "control-reset" },
    };
    const { calls } = stubFetch(reset, { body: ATTACH_OK }, { body: { ok: true } });
    await new ResidentExecutor(OPTS).writeFile("f.txt", "hello");
    expect(calls.map(route)).toEqual(["/write", "/attach", "/write"]);
    // The re-issued put carries the whole content again, byte for byte (beside the thread's routing fields).
    expect(JSON.parse(String(calls[2].init.body))).toMatchObject({ path: "f.txt", content: "hello" });

    stubFetch(reset, { body: ATTACH_OK }, reset);
    const err = await new ResidentExecutor(OPTS).writeFile("f.txt", "hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecControlResetError);
  });

  it("the control-reset re-issue names its routes: /read (idempotent by shape) and /write (a full-content put, so the same bytes twice are the file once) and nothing else — the invariant a future delta write must break loudly", () => {
    const src = readFileSync(new URL("./resident.ts", import.meta.url), "utf8");
    // The set is explicit, and ONE rule reads it: a control reset on a route
    // outside the set is the typed unknown outcome at once (`controlResetUnderThread`);
    // the re-issue block below it never states the fact again.
    expect(src).toMatch(/const CONTROL_RESET_REISSUE_ROUTES = new Set\(\["\/read", "\/write"\]\);/);
    expect(src).toMatch(
      /if \(!CONTROL_RESET_REISSUE_ROUTES\.has\(route\) && saysControlReset\(data\)\)\s*throw new ExecControlResetError/,
    );
    expect(src).not.toMatch(/if \(!CONTROL_RESET_REISSUE_ROUTES\.has\(route\)\) throw/);
    expect(src).not.toMatch(/route === "\/exec" && saysControlReset\(data\)/);
    // The invariant is stated where the set is: /write is a full-content put.
    expect(src).toMatch(/full-content put/);
    // And the put IS full-content: the body is the path and the whole content, no offset, mode or append.
    expect(src).toMatch(/opWithReattach\("\/write", \{ path, content \}/);
  });

  it('control-reset then needs:"attach" on the re-issued read (a reset that also left the worktree evicted) is the precise worktree-unavailable infra error — the op\'s one re-attach is spent, never a generic status error', async () => {
    const { calls } = stubFetch(
      {
        status: 409,
        body: { error: "control-reset: the resident's Durable Object was reset", reason: "control-reset" },
      },
      { body: ATTACH_OK },
      { status: 409, body: { error: "worktree-missing: still gone", needs: "attach" } },
    );
    const err = await new ResidentExecutor(OPTS).readFile("f.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/worktree still unavailable after a re-attach/);
    expect(calls.map(route)).toEqual(["/read", "/attach", "/read"]); // exactly one re-attach, no second
  });

  it('runtime-replaced then needs:"attach" on the retried read (deploy + evicted worktree) is the precise worktree-unavailable infra error', async () => {
    stubFetch(
      { status: 409, body: { error: "runtime-replaced: deploy", reason: "runtime-replaced" } },
      { body: ATTACH_OK },
      { status: 409, body: { error: "worktree-missing: still gone", needs: "attach" } },
    );
    const err = await new ResidentExecutor(OPTS).readFile("f.txt").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/worktree still unavailable after a re-attach/);
  });

  it("a path escape is a legible 400 error", async () => {
    stubFetch({ status: 400, body: { error: "path-escape: ../../mirror/config leaves the worktree" } });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.readFile("../../mirror/config")).rejects.toThrow(/path-escape/);
  });
});

describe("ResidentExecutor.open (attach-on-open)", () => {
  it("attaches with the refHint and returns a ready executor", async () => {
    const { calls } = stubFetch({ body: ATTACH_OK });
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(ex).toBeInstanceOf(ResidentExecutor);
    expect(route(calls[0])).toBe("/attach");
    expect(sentBody(calls[0])).toMatchObject({ resource: OPTS.resource, threadKey: OPTS.threadKey, refHint: "master" });
  });

  // docs/reference/specs/resident-repos.md item 50: a read-only run asks for a read-only
  // worktree (no credential file, unfetchable origin). Sent only when true so
  // an older resident sees the same body it always did.
  it("sends readonly:true in the attach body when the run is read-only, and omits the field otherwise", async () => {
    const { calls } = stubFetch({ body: ATTACH_OK }, { body: ATTACH_OK });
    await ResidentExecutor.open({ ...OPTS, refHint: "master", readonly: true });
    expect(sentBody(calls[0])).toMatchObject({ readonly: true });
    await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(sentBody(calls[1])).not.toHaveProperty("readonly");
  });

  // docs/reference/specs/resident-repos.md item 51: the expected head rides along so the
  // resident fetches a mirror whose ref tip lags it (a re-review after a push
  // would otherwise attach to a stale tip). Sent only when set — older body
  // otherwise.
  it("sends sha in the attach body when an expected head is known, and omits the field otherwise", async () => {
    const { calls } = stubFetch({ body: ATTACH_OK }, { body: ATTACH_OK });
    await ResidentExecutor.open({ ...OPTS, refHint: "master", sha: "47c4230692cbc5961682532afb822e9c2f1f40b7" });
    expect(sentBody(calls[0])).toMatchObject({ refHint: "master", sha: "47c4230692cbc5961682532afb822e9c2f1f40b7" });
    await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(sentBody(calls[1])).not.toHaveProperty("sha");
  });

  // Item 51: the sha names the commit the run asked for and belongs to the
  // attach that binds the run. A recovery re-attach names none: the run's own
  // pushes may have moved the tip past the sha it started on, and the resident
  // now refuses a tip that is not the named commit (`stale-tip`).
  it("a recovery re-attach after an eviction omits the sha the run started with — the run re-attaches the branch as it left it", async () => {
    const { calls } = stubFetch(
      { body: ATTACH_OK },
      {
        body: { error: "evicted: worktree was evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 },
      },
      { body: { ...ATTACH_OK, sha: "d75b5a51aba97d43c64a42c96e580dd9abbfd78e" } },
      { raw: "  " + JSON.stringify({ stdout: "recovered", stderr: "", exitCode: 0, truncated: false }) },
    );
    const ex = await ResidentExecutor.open({
      ...OPTS,
      refHint: "master",
      sha: "47c4230692cbc5961682532afb822e9c2f1f40b7",
    });
    expect(sentBody(calls[0])).toMatchObject({ sha: "47c4230692cbc5961682532afb822e9c2f1f40b7" });
    await expect(ex.exec("echo recovered")).resolves.toBe("recovered");
    expect(calls.map(route)).toEqual(["/attach", "/exec", "/attach", "/exec"]);
    expect(sentBody(calls[2])).not.toHaveProperty("sha");
    expect(ex.binding?.sha).toBe("d75b5a51aba97d43c64a42c96e580dd9abbfd78e");
  });

  // docs/reference/specs/resident-repos.md item 66: a resumed run re-attaches in
  // reuse-only mode: the resident keeps the tree as it stands. Sent only when
  // true so an older resident, and every fresh attach, sees the body it always did.
  it("sends reuse:true in the attach body when the run re-attaches its recorded worktree, and omits the field otherwise", async () => {
    const { calls } = stubFetch({ body: ATTACH_OK }, { body: ATTACH_OK });
    await ResidentExecutor.open({ ...OPTS, refHint: "master", reuse: true });
    expect(sentBody(calls[0])).toMatchObject({ reuse: true });
    await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(sentBody(calls[1])).not.toHaveProperty("reuse");
  });

  // docs/reference/specs/resident-repos.md item 16: the reason for the hint rides
  // the body only when there is one — the thread's own pull request and its head
  // branch, and the bound-by-default flag — so an older resident, and every
  // attach without a reason, see the body they always did.
  it("sends ownPr and refByDefault in the attach body only when set", async () => {
    const { calls } = stubFetch({ body: ATTACH_OK }, { body: ATTACH_OK }, { body: ATTACH_OK });
    await ResidentExecutor.open({ ...OPTS, refHint: "fix/x", ownPr: { number: 7, ref: "fix/x" } });
    expect(sentBody(calls[0])).toMatchObject({ refHint: "fix/x", ownPr: { number: 7, ref: "fix/x" } });
    expect(sentBody(calls[0])).not.toHaveProperty("refByDefault");
    await ResidentExecutor.open({ ...OPTS, refHint: "master", refByDefault: true });
    expect(sentBody(calls[1])).toMatchObject({ refHint: "master", refByDefault: true });
    expect(sentBody(calls[1])).not.toHaveProperty("ownPr");
    await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(sentBody(calls[2])).not.toHaveProperty("ownPr");
    expect(sentBody(calls[2])).not.toHaveProperty("refByDefault");
  });

  it("records the answer's rebound or rebindRefused on the binding, only when well-formed; an answer without them binds without them", async () => {
    stubFetch(
      {
        body: {
          ...ATTACH_OK,
          ref: "fix/x",
          rebound: { from: "master", to: "fix/x", pr: 7, at: "2026-01-01T00:00:00.000Z" },
        },
      },
      {
        body: {
          ...ATTACH_OK,
          rebindRefused: { to: "fix/x", pr: 7, reason: "branch-absent", why: "the mirror does not hold it" },
        },
      },
      { body: { ...ATTACH_OK, rebound: { from: "master" }, rebindRefused: "no", returned: { to: "master" } } },
      { body: ATTACH_OK },
      { body: { ...ATTACH_OK, returned: { from: "fix/x", to: "master", pr: 7, at: "t" } } },
      { body: { ...ATTACH_OK, returned: { from: "plan/slug/u1", to: "master", at: "t" } } },
      { body: { ...ATTACH_OK, returned: { from: "plan/slug/u1", to: "master", pr: 0, at: "t" } } },
    );
    const moved = await ResidentExecutor.open({ ...OPTS, refHint: "fix/x", ownPr: { number: 7, ref: "fix/x" } });
    expect(moved.binding).toMatchObject({ ref: "fix/x", rebound: { from: "master", to: "fix/x", pr: 7 } });
    expect(moved.binding).not.toHaveProperty("rebindRefused");
    const kept = await ResidentExecutor.open({ ...OPTS, refHint: "fix/x", ownPr: { number: 7, ref: "fix/x" } });
    expect(kept.binding).toMatchObject({
      ref: "master",
      rebindRefused: { to: "fix/x", pr: 7, reason: "branch-absent", why: "the mirror does not hold it" },
    });
    expect(kept.binding).not.toHaveProperty("rebound");
    const malformed = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(malformed.binding).not.toHaveProperty("rebound");
    expect(malformed.binding).not.toHaveProperty("rebindRefused");
    expect(malformed.binding).not.toHaveProperty("returned");
    const bare = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(bare.binding).not.toHaveProperty("rebound");
    expect(bare.binding).not.toHaveProperty("rebindRefused");
    expect(bare.binding).not.toHaveProperty("returned");
    // The second movement (item 16): the binding went back to the default because its branch is gone.
    const back = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(back.binding).toMatchObject({ ref: "master", returned: { from: "fix/x", to: "master", pr: 7 } });
    expect(back.binding).not.toHaveProperty("rebound");
    // A return that names no pull request is still the move back — the two
    // branches are the fact; a malformed pull request number is not read as none.
    const noPr = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(noPr.binding?.returned).toEqual({ from: "plan/slug/u1", to: "master" });
    const badPr = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(badPr.binding).not.toHaveProperty("returned");
  });

  it('a 409 needs:"recreate" (the tree cannot be reused) is a typed ResidentReuseRefusedError carrying the resident\'s own words, never a retry', async () => {
    const { calls } = stubFetch({
      status: 409,
      body: { error: "reuse-refused: no worktree at /workspace/threads/t/master", needs: "recreate" },
    });
    const err = await ResidentExecutor.open({ ...OPTS, refHint: "master", reuse: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResidentReuseRefusedError);
    expect((err as Error).message).toBe(
      "resident attach: repo:jshttp/vary cannot reuse this thread's worktree (reuse-refused: no worktree at /workspace/threads/t/master)",
    );
    expect(calls).toHaveLength(1);
  });

  it("records the container identity the attach answered beside the workspace and user; an answer without one binds without it", async () => {
    stubFetch(
      { body: { ...ATTACH_OK, container: "3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43" } },
      { body: { ...ATTACH_OK, container: "" } },
    );
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(ex.binding?.container).toBe("3f1c2a6e-9b0d-4d2e-8a1f-0c9e7b6a5d43");
    const bare = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(bare.binding).not.toHaveProperty("container");
  });

  it("records the attach result's ref@sha as the thread binding, with its workspace and pool user: the user is the OS user every /exec runs as, reported for the record; nothing files by it", async () => {
    stubFetch({
      body: {
        workspace: "/workspace/threads/t/master",
        ref: "master",
        sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05",
        user: "worker2",
        deps: "hardlink",
      },
    });
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(ex.binding).toEqual({
      ref: "master",
      sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05",
      workspace: "/workspace/threads/t/master",
      user: "worker2",
    });
  });

  it("a 200 attach answer without a string `workspace` still binds — the path is just unknown (the path is advisory for the prompt)", async () => {
    stubFetch({ body: { ref: "master", sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05", user: "worker2" } });
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(ex.binding).toEqual({ ref: "master", sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05", user: "worker2" });
    expect(ex.binding?.workspace).toBeUndefined();
  });

  it("a 200 attach answer without a string `user` binds without one: nothing depends on it", async () => {
    stubFetch({ body: { ref: "master", sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05", user: "" } });
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    expect(ex.binding).toEqual({ ref: "master", sha: "1220b9c487f9538a6dd509ef11b6a5042d85bd05" });
    expect(ex.binding).not.toHaveProperty("user");
  });

  it("a 200 attach answer missing ref/sha is a legible error, never a half-bound executor", async () => {
    stubFetch({ body: { workspace: "/workspace/threads/t/master", user: "worker2" } });
    await expect(ResidentExecutor.open({ ...OPTS, refHint: "master" })).rejects.toThrow(
      /malformed answer.*missing ref\/sha/,
    );
  });

  it('409 needs:"ref" carries the resident\'s defaultRef when the Worker names one (bind-by-default), undefined otherwise', async () => {
    stubFetch({
      status: 409,
      body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref", defaultRef: "master" },
    });
    const err = (await ResidentExecutor.open(OPTS).catch((e: unknown) => e)) as ResidentNeedsRefError;
    expect(err).toBeInstanceOf(ResidentNeedsRefError);
    expect(err.defaultRef).toBe("master");
    stubFetch({ status: 409, body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref" } });
    const older = (await ResidentExecutor.open(OPTS).catch((e: unknown) => e)) as ResidentNeedsRefError;
    expect(older.defaultRef).toBeUndefined();
  });

  it('409 needs:"ref" on open tells the user to name a branch', async () => {
    stubFetch({ status: 409, body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref" } });
    await expect(ResidentExecutor.open(OPTS)).rejects.toThrow(/branch/i);
  });

  it('409 needs:"ref" is a TYPED error the dispatcher can catch for the ask-once flow', async () => {
    stubFetch({ status: 409, body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref" } });
    const err = await ResidentExecutor.open(OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResidentNeedsRefError);
    expect((err as ResidentNeedsRefError).resource).toBe(OPTS.resource);
  });

  it("404 (not onboarded) on open is a named error", async () => {
    stubFetch({ status: 404, body: { error: "not onboarded" } });
    await expect(ResidentExecutor.open(OPTS)).rejects.toThrow(/not onboarded/);
  });
});

// Feature: docs/reference/specs/resident-repos.md — ResidentOperations: the
// deterministic-ops client for POST /op. Responses stream like /exec
// (heartbeat whitespace + one JSON document, parsed from the BODY); a failing
// op is a RESULT (ok:false), a mutating-entry refusal and not-onboarded are
// distinct named kinds, and transport failures never masquerade as results.
// Feature: docs/reference/specs/tracing.md item 21 — every resident route is one
// `http.client` span under the caller's span, and the trace context rides to
// the resident because it is one of our hosts — and only then.
describe("ResidentExecutor trace context", () => {
  it("attach, exec and the status probe are http.client children of the caller's span with host/route/method/status and no secret; traceparent is set for the configured resident host and absent when the host set is empty", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 5_000 }).start("request", { sinks: [log] });
    const attachSpan = root.start("dispatch.workspace.attach");
    const execSpan = root.start("exec.exec");
    configureInternalHosts(internalHostsOf([OPTS.baseUrl]));
    try {
      const { calls } = stubFetch(
        { raw: JSON.stringify(ATTACH_OK) },
        { raw: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }) },
        { body: { state: "warm", reason: "" } },
      );
      const ex = new ResidentExecutor(OPTS);
      await ex.attach(attachSpan);
      await ex.exec("echo hi", { span: execSpan });
      await ResidentExecutor.probeStatus(OPTS.baseUrl, OPTS.token, OPTS.resource, 1000, root);
      const clients = log.ends.filter((e) => e.name === "http.client");
      expect(clients.map((c) => [c.parentSpanId, c.attrs])).toEqual([
        [attachSpan.id, { host: new URL(OPTS.baseUrl).host, route: "/attach", method: "POST", httpStatus: 200 }],
        [execSpan.id, { host: new URL(OPTS.baseUrl).host, route: "/exec", method: "POST", httpStatus: 200 }],
        [root.id, { host: new URL(OPTS.baseUrl).host, route: "/status", method: "GET", httpStatus: 200 }],
      ]);
      expect(JSON.stringify(clients)).not.toContain(OPTS.token);
      for (const [i, c] of calls.entries()) {
        const tp = parseTraceparent(new Headers(c.init.headers).get("traceparent"));
        expect(tp?.traceId).toBe(root.traceId);
        expect(tp?.parentId).toBe(clients[i]!.spanId);
        expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${OPTS.token}`);
      }
    } finally {
      configureInternalHosts(NO_INTERNAL_HOSTS);
    }
    // The same calls with no configured hosts: spans still, header never.
    const { calls } = stubFetch({ raw: JSON.stringify(ATTACH_OK) });
    await new ResidentExecutor(OPTS).attach(attachSpan);
    expect(new Headers(calls[0]!.init.headers).has("traceparent")).toBe(false);
    // And with no span at all: a plain fetch, no span record either.
    const before = log.ends.length;
    stubFetch({ raw: JSON.stringify(ATTACH_OK) });
    await new ResidentExecutor(OPTS).attach();
    expect(log.ends.length).toBe(before);
  });
});

describe("ResidentExecutor trace context — the recovery re-attach", () => {
  it("a needs:attach recovery rides the same span as the op it rescues: /exec, /attach and the retried /exec are three http.client children of it", async () => {
    const log = recordingSink();
    const root = createTracer({ clock: () => 5_000 }).start("request", { sinks: [log] });
    const execSpan = root.start("exec.exec");
    stubFetch(
      {
        body: { error: "evicted: worktree was evicted", needs: "attach", stdout: "", stderr: "", exitCode: 127 },
      },
      { body: ATTACH_OK },
      { raw: JSON.stringify({ stdout: "recovered", stderr: "", exitCode: 0 }) },
    );
    await expect(new ResidentExecutor(OPTS).exec("echo recovered", { span: execSpan })).resolves.toBe("recovered");
    const clients = log.ends.filter((e) => e.name === "http.client");
    expect(clients.map((c) => [c.parentSpanId, c.attrs.route])).toEqual([
      [execSpan.id, "/exec"],
      [execSpan.id, "/attach"],
      [execSpan.id, "/exec"],
    ]);
  });
});

describe("ResidentOperations.run", () => {
  const OPS = { baseUrl: "https://resident.example", token: "op-token" };

  it("a rejected op the Worker typed as the platform's transient carries `transient: true` on the error outcome — the one signal, the message the resident's words — while a failure the Worker did not type stays the plain error it was", async () => {
    // The streamed document `/op`'s rejection mapper writes: `catchAllErr(err,
    // "op-failed")` with its `status` IN the body over HTTP 200, as /exec's
    // failure document is (deploy/cloudflare-resident/worker.ts `streamOp`); the
    // words are the platform's (`Network connection lost.`, the pinned SDK's own sentence).
    stubFetch({ body: { error: "op-failed: Network connection lost.", status: 500, transient: true } });
    const transient = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    // One signal: the field, judged by the one rule (`isTransientRefusal`: a 5xx
    // carrying it, the status read off the document by `answeredStatus`). The
    // message stays the resident's words; the reader words the blip.
    expect(transient).toEqual({
      kind: "error",
      transient: true,
      message: "resident /op: op-failed: Network connection lost.",
    });
    stubFetch({ body: { error: "op-failed at test: exit 1", status: 500, transient: false } });
    const deterministic = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(deterministic).toEqual({ kind: "error", message: "resident /op: op-failed at test: exit 1" });
    stubFetch({ body: { error: "op-failed: boom", status: 500 } });
    const untyped = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(untyped).toEqual({ kind: "error", message: "resident /op: op-failed: boom" });
    // The flag on a document whose status is not a 5xx is never the signal: a
    // named refusal's 409, or any status the Worker wrote below 500.
    stubFetch({ body: { error: "op-failed: the ref is gone", status: 409, transient: true } });
    const named = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(named).toEqual({ kind: "error", message: "resident /op: op-failed: the ref is gone" });
    stubFetch({ body: { error: "op-failed: bad ref", status: 400, transient: true } });
    const below = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(below).toEqual({ kind: "error", message: "resident /op: op-failed: bad ref" });
    // The deploy-skew window: a Worker from before `streamOp` carried the status
    // shed it from its typed 500, so a document with NO status at all is read by
    // the field alone — the blip keeps its word until both sides have rolled.
    stubFetch({ body: { error: "op-failed: Network connection lost.", transient: true } });
    const shed = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(shed).toEqual({
      kind: "error",
      transient: true,
      message: "resident /op: op-failed: Network connection lost.",
    });
    // The provenance rule reaches /op's edge case too: a real HTTP 5xx with no
    // Worker document (the edge's HTML page) is the platform's blip, so the
    // reader words it as the resident unavailable for a moment; a 4xx with no
    // document is the plain failure it is.
    stubFetch({ status: 502, raw: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>" });
    const edge = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(edge).toEqual({ kind: "error", transient: true, message: "resident /op HTTP 502" });
    stubFetch({ status: 403, raw: "<html>forbidden</html>" });
    const forbidden = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(forbidden).toEqual({ kind: "error", message: "resident /op HTTP 403" });
  });

  // Feature: docs/reference/specs/tracing.md item 19 — an op's step trace and total ride the result.
  it("carries the resident's step trace and total on the result, sanitized", async () => {
    stubFetch({
      raw: JSON.stringify({
        ok: true,
        op: "test",
        summary: "test passed",
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 8_200,
        trace: [
          { name: "op-clone", startMs: 0, durationMs: 2_000, status: "ok", exitCode: 0 },
          { name: "test", startMs: 2_100, durationMs: 6_000, status: "ok", exitCode: 0 },
          { bogus: true },
        ],
      }),
    });
    const res = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(res).toEqual({
      kind: "result",
      ok: true,
      summary: "test passed",
      residentMs: 8_200,
      trace: [
        { name: "op-clone", startMs: 0, durationMs: 2_000, status: "ok", exitCode: 0 },
        { name: "test", startMs: 2_100, durationMs: 6_000, status: "ok", exitCode: 0 },
      ],
    });
  });

  it("POSTs {resource, op, ref} with the operator bearer and parses the streamed result", async () => {
    const { calls } = stubFetch({
      raw:
        "\n \n" +
        JSON.stringify({
          ok: true,
          op: "test",
          ref: "master",
          sha: "1220b9c4a123",
          summary: "test passed on repo:jshttp/vary @ master (1220b9c4) in 8s",
          stdout: "1 passing\n",
          stderr: "",
          exitCode: 0,
        }),
    });
    const ops = new ResidentOperations(OPS);
    const res = await ops.run("test", { repo: "jshttp/vary", ref: "master" });
    expect(res).toMatchObject({ kind: "result", ok: true });
    if (res.kind === "result") {
      expect(res.summary).toContain("test passed");
      expect(res.output).toContain("1 passing");
      expect(res.trace).toBeUndefined(); // a Worker without a step trace
    }
    expect(route(calls[0])).toBe("/op");
    expect(sentBody(calls[0])).toEqual({ resource: "repo:jshttp/vary", op: "test", ref: "master" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer op-token");
  });

  it("a failing op is a RESULT (ok:false with the named summary), not an error", async () => {
    stubFetch({
      body: {
        ok: false,
        op: "test",
        summary: "test failed (exit 1) on repo:jshttp/vary @ master (1220b9c4)",
        stdout: "",
        stderr: "1 failing",
        exitCode: 1,
      },
    });
    const res = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(res).toMatchObject({ kind: "result", ok: false });
    if (res.kind === "result") expect(res.summary).toMatch(/failed \(exit 1\)/);
  });

  it("404 → not-onboarded (the natural-language path falls through to the agent)", async () => {
    stubFetch({ status: 404, body: { error: "repo:acme/api is not onboarded" } });
    const res = await new ResidentOperations(OPS).run("test", { repo: "acme/api" });
    expect(res).toEqual({ kind: "not-onboarded" });
  });

  it("an op-refused error (mutating command-table entry) is a named refusal", async () => {
    stubFetch({
      status: 409,
      body: {
        error:
          'op-refused: the "test" command-table entry is marked effects: mutating — the modelless op path executes readonly entries only',
      },
    });
    const res = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(res).toMatchObject({ kind: "refused" });
    if (res.kind === "refused") expect(res.reason).toMatch(/mutating/);
  });

  it("an in-body error (e.g. unknown-ref over the 200 stream) is kind error, never a fake result", async () => {
    stubFetch({
      raw:
        " \n" +
        JSON.stringify({ error: 'unknown-ref: ref "nope" does not resolve in the mirror (even after a fetch)' }),
    });
    const res = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary", ref: "nope" });
    expect(res).toMatchObject({ kind: "error" });
    if (res.kind === "error") expect(res.message).toContain("unknown-ref");
  });

  it("a transport failure is kind error with the request named", async () => {
    stubFetch({ reject: "fetch failed" });
    const res = await new ResidentOperations(OPS).run("build", { repo: "jshttp/vary" });
    expect(res).toMatchObject({ kind: "error" });
    if (res.kind === "error") expect(res.message).toMatch(/\/op request failed/);
  });

  it("bounds the /op request with an AbortSignal.timeout at the exec ceiling (a long suite outlives the per-command default; a hung resident is still bounded)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { calls } = stubFetch({ body: { ok: true, summary: "s", exitCode: 0 } });
    await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(BASH_TIMEOUT_MAX_MS);
    timeoutSpy.mockRestore();
  });
});

describe("ResidentExecutor.probeStatus", () => {
  it("carries the Worker's `transient` typing on a 5xx it did not answer with a state — the catch-all 500 for the Durable Object reset or lost under the probe — and never on a 4xx or an untyped 5xx", async () => {
    stubFetch({ status: 500, body: { error: "internal error", status: 500, transient: true } });
    const typed = await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000);
    expect(typed).toEqual({
      kind: "unreachable",
      error: "probe HTTP 500: internal error",
      transport: false,
      status: 500,
      transient: true,
    });
    stubFetch({ status: 502, body: { error: "bad gateway" } });
    expect(await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000)).not.toHaveProperty(
      "transient",
    );
    stubFetch({ status: 401, body: { error: "unauthorized", transient: true } });
    expect(await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000)).not.toHaveProperty(
      "transient",
    );
  });

  it("returns {state, reason} from GET /status", async () => {
    const { calls } = stubFetch({ body: { state: "restoring", reason: "rehydrating" } });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "op-token", "repo:jshttp/vary", 2000);
    expect(probe).toEqual({ kind: "status", state: "restoring", reason: "rehydrating" });
    expect(calls[0].url).toBe("https://resident.example/status?resource=repo%3Ajshttp%2Fvary");
  });

  it("maps 404 to a not-onboarded status (a definite answer, not a failure)", async () => {
    stubFetch({ status: 404, body: { error: "unknown resource" } });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000);
    expect(probe).toEqual({ kind: "status", state: "not-onboarded", reason: "" });
  });

  it("a network failure is an unreachable marker flagged as transport-level", async () => {
    stubFetch({ reject: "fetch failed" });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000);
    expect(probe).toMatchObject({ kind: "unreachable", transport: true });
  });

  it("an HTTP-level probe failure is unreachable but NOT transport (never negative-cached)", async () => {
    stubFetch({ status: 500, body: { error: "internal" } });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000);
    expect(probe).toMatchObject({ kind: "unreachable", transport: false });
    expect((probe as { error: string }).error).toContain("500");
  });
});

describe("ResidentExecutor.release — return the thread's pool user when a run ends", () => {
  it('"always" POSTs /detach with force:true and reports the resident\'s answer', async () => {
    const { calls } = stubFetch({ body: ATTACH_OK }, { body: { released: true, user: "worker2" } });
    const ex = await ResidentExecutor.open(OPTS);
    const r = await ex.release("always");
    expect(r).toEqual({ released: true, reason: undefined });
    expect(route(calls[1])).toBe("/detach");
    expect(sentBody(calls[1])).toMatchObject({ resource: OPTS.resource, threadKey: OPTS.threadKey, force: true });
  });

  it('"if-idle" POSTs force:false; a worktree kept for an op in flight comes back released:false with the reason', async () => {
    const { calls } = stubFetch(
      { body: ATTACH_OK },
      { body: { released: false, reason: "busy: 1 operation(s) in flight on this thread — kept" } },
    );
    const ex = await ResidentExecutor.open(OPTS);
    const r = await ex.release("if-idle");
    expect(r).toEqual({ released: false, reason: "busy: 1 operation(s) in flight on this thread — kept" });
    expect(sentBody(calls[1])).toMatchObject({ force: false });
  });

  // docs/reference/specs/resident-repos.md item 16a: a run starts from a clean
  // tree, so the release discards whatever the tree held — and says so.
  it("a release that discarded uncommitted or unpushed work reports it as `leftBehind` when well-formed; a malformed or absent one reports nothing", async () => {
    stubFetch(
      { body: ATTACH_OK },
      { body: { released: true, user: "worker2", leftBehind: { uncommittedChanges: 2, unpushedCommits: 1 } } },
      { body: { released: true, user: "worker2", leftBehind: { dirty: true } } },
      { body: { released: true, user: "worker2" } },
    );
    const ex = await ResidentExecutor.open(OPTS);
    expect(await ex.release("if-idle")).toEqual({
      released: true,
      reason: undefined,
      leftBehind: { uncommittedChanges: 2, unpushedCommits: 1 },
    });
    expect(await ex.release("if-idle")).toEqual({ released: true, reason: undefined });
    expect(await ex.release("if-idle")).toEqual({ released: true, reason: undefined });
  });

  // docs/reference/specs/resident-repos.md item 16: the release hands the
  // resident what the run pushed — the exact fact the thread remembers past
  // the tree's removal — and only when there is something to hand.
  it("sends the run's pushed branches in the detach body only when given and non-empty", async () => {
    const { calls } = stubFetch(
      { body: ATTACH_OK },
      { body: { released: true } },
      { body: { released: true } },
      { body: { released: true } },
    );
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    await ex.release("if-idle", { pushed: [{ ref: "fix/x", pr: 7 }] });
    expect(sentBody(calls[1])).toEqual({
      resource: "repo:jshttp/vary",
      threadKey: "slack:CX:1.0",
      force: false,
      pushed: [{ ref: "fix/x", pr: 7 }],
    });
    await ex.release("if-idle", { pushed: [] });
    expect(sentBody(calls[2])).not.toHaveProperty("pushed");
    await ex.release("always");
    expect(sentBody(calls[3])).not.toHaveProperty("pushed");
  });

  it("bounds /detach with its own short AbortSignal (control-plane POST, not the exec ceiling)", async () => {
    const { calls } = stubFetch({ body: ATTACH_OK }, { body: { released: true } });
    const ex = await ResidentExecutor.open(OPTS);
    await ex.release("always");
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
    // A timeout that has already fired would abort immediately; ours is live and short — fires within 10s.
    expect(calls[1].init.signal?.aborted).toBe(false);
  });

  it("never throws: a non-2xx or a transport failure is released:false with a legible reason (release is best-effort)", async () => {
    stubFetch({ body: ATTACH_OK }, { status: 503, body: { error: "mirror-busy" } });
    const ex = await ResidentExecutor.open(OPTS);
    expect(await ex.release("always")).toEqual({ released: false, reason: "HTTP 503: mirror-busy" });
    stubFetch({ body: ATTACH_OK }, { reject: "fetch failed" });
    const ex2 = await ResidentExecutor.open(OPTS);
    const r = await ex2.release("always");
    expect(r.released).toBe(false);
    expect(r.reason).toContain("fetch failed");
  });
});

// agent-review.md item 12: a mid-run move of the worktree to the PR's new head
// is one more /attach carrying that sha — the resident's own fetch-on-attach
// (item 51) does the rest. The new sha sticks for every later attach.
describe("ResidentExecutor.moveTo", () => {
  it("re-attaches with the new sha and answers the sha the worktree is now at", async () => {
    const NEW = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";
    const OLD = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
    const { calls } = stubFetch(
      { body: { ...ATTACH_OK, sha: OLD } },
      { body: { ...ATTACH_OK, sha: NEW, recreated: true } },
    );
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master", readonly: true, sha: OLD });
    await expect(ex.moveTo(NEW)).resolves.toEqual({ sha: NEW });
    expect(calls.map(route)).toEqual(["/attach", "/attach"]);
    expect(sentBody(calls[1])).toMatchObject({ sha: NEW, refHint: "master", readonly: true });
    expect(ex.binding?.sha).toBe(NEW);
  });

  it("a refused re-attach throws like attach() — the caller falls back to telling the model", async () => {
    stubFetch({ body: ATTACH_OK }, { status: 503, body: { error: "not-serviceable: refreshing" } });
    const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
    await expect(ex.moveTo("d75b5a51aba97d43c64a42c96e580dd9abbfd78e")).rejects.toThrow(/not-serviceable/);
  });

  it("carries the run's stop into the move's re-attach: a hard stop during the wake wait a transient refusal began ends the move at once with the stop's typed error — never a wait to the wake ceiling the round cannot end", async () => {
    vi.useFakeTimers();
    try {
      const { calls } = stubFetch(
        { body: ATTACH_OK },
        { body: { error: "attach-failed: Network connection lost.", status: 500, transient: true } },
        { body: { state: "restoring", reason: "rehydrating", inFlight: 0 } },
      );
      const ex = await ResidentExecutor.open({ ...OPTS, refHint: "master" });
      const control = new AbortController();
      let settled: unknown;
      void ex
        .moveTo("d75b5a51aba97d43c64a42c96e580dd9abbfd78e", { signal: control.signal })
        .catch((e: unknown) => (settled = e));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBeUndefined();
      control.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeInstanceOf(ExecInfraError);
      expect((settled as ExecInfraError).reason).toBe("aborted");
      expect(calls.map(route)).toEqual(["/attach", "/attach", "/status"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Feature: docs/reference/specs/execution.md item 11 — per-call bash timeout on the
// resident path. The budget rides in the /exec body only when the caller asked
// for one (an older resident keeps seeing the body it always did), clamped
// client-side to [1s, 20 min]; the resident clamps again server-side and never
// trusts this number.
describe("ResidentExecutor per-call timeout", () => {
  const OK = { stdout: "ok", stderr: "", exitCode: 0, truncated: false };

  it("sends the requested timeoutMs in the /exec body, clamped to the 20-min ceiling", async () => {
    const { calls } = stubFetch({ body: OK });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("npm test", { timeoutMs: 25 * 60_000 })).resolves.toBe("ok");
    expect(sentBody(calls[0]).timeoutMs).toBe(20 * 60_000);
  });

  it("sends an in-range timeoutMs unchanged", async () => {
    const { calls } = stubFetch({ body: OK });
    const ex = new ResidentExecutor(OPTS);
    await ex.exec("npm test", { timeoutMs: 600_000 });
    expect(sentBody(calls[0]).timeoutMs).toBe(600_000);
  });

  it("no timeoutMs → the body an older resident expects (no timeoutMs key at all)", async () => {
    const { calls } = stubFetch({ body: OK });
    const ex = new ResidentExecutor(OPTS);
    await ex.exec("ls");
    expect("timeoutMs" in sentBody(calls[0])).toBe(false);
  });

  it("the retried command after a re-attach carries the same timeoutMs", async () => {
    const { calls } = stubFetch(
      {
        body: { error: "evicted: worktree was evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 },
      },
      { body: ATTACH_OK },
      { body: OK },
    );
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("npm test", { timeoutMs: 600_000 })).resolves.toBe("ok");
    expect(calls.map(route)).toEqual(["/exec", "/attach", "/exec"]);
    expect(sentBody(calls[2]).timeoutMs).toBe(600_000);
  });
});

// The resident bounds every send with a bot-side deadline (execDeadline),
// and — like the sandbox — the deadline must cover the BODY read, not just the
// headers. /exec streams heartbeat whitespace, so a resident whose exec
// promise never settles hangs past the headers; that abort must surface as
// the legible `ExecInfraError` the runner counts toward fail-fast, never a raw
// TimeoutError that escapes classification.
describe("ResidentExecutor per-send deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rejectOnAbort = (signal: AbortSignal | null | undefined, reject: (reason: unknown) => void) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  };

  /** HTTP 200 headers at once, then a heartbeat every 15 s and no JSON ever —
   *  the incident's shape; the body stream errors when the send's signal aborts. */
  function heartbeatingFetch() {
    const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const beat = setInterval(() => controller.enqueue(new TextEncoder().encode("\n")), 15_000);
          rejectOnAbort(init?.signal, (reason) => {
            clearInterval(beat);
            controller.error(reason);
          });
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("a heartbeating body that never completes is an ExecInfraError at the command budget + margin, not a raw TimeoutError or a hang", async () => {
    heartbeatingFetch();
    const ex = new ResidentExecutor(OPTS);
    const p = ex.exec("sleep 9999", { timeoutMs: 120_000 }).catch((e: unknown) => e);
    // Nothing before the deadline: budget 120s + EXEC_CALL_MARGIN_MS (30s).
    await vi.advanceTimersByTimeAsync(149_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toContain("resident worker /exec request failed");
  });
});

// Feature: docs/reference/specs/resident-repos.md item 62 — the bot re-sanitizes every
// resident string at the parse, permanently: a reason stored by an older
// resident survives that resident's deploy and its rollbacks.
describe("resident text is made safe at the parse (item 62)", () => {
  const POISON =
    "provision-failed at install: \x1b[31mnpm ERR!\x1b[0m GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nkept slack:C0OTHER:1234.5678 (busy)";

  it("probeStatus: a poisoned /status reason is stripped, redacted and capped; an off-table state reads as unknown", async () => {
    stubFetch({ body: { state: "down\nGITHUB_TOKEN=ghp_x", reason: POISON } });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "tok", "repo:jshttp/vary", 1000);
    expect(probe.kind).toBe("status");
    if (probe.kind !== "status") return;
    expect(probe.state).toBe("unknown");
    expect(probe.reason).not.toContain("ghp_");
    expect(probe.reason).not.toContain("\x1b");
    expect(probe.reason).toContain("«redacted");
  });

  it("probeStatus: a non-2xx body's error is sanitized before it names the outage", async () => {
    stubFetch({ status: 500, body: { error: POISON } });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "tok", "repo:jshttp/vary", 1000);
    expect(probe.kind).toBe("unreachable");
    if (probe.kind === "unreachable") expect(probe.error).not.toContain("ghp_");
  });

  it("ResidentOperations.run: a poisoned refusal, error and summary never reach the caller raw; stdout/stderr are redacted before the clip", async () => {
    const OPS = { baseUrl: "https://resident.example", token: "op-token" };
    stubFetch({ body: { error: `op-refused: ${POISON}` } });
    const refused = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.reason.startsWith("op-refused")).toBe(true);
      expect(refused.reason).not.toContain("ghp_");
    }
    stubFetch({
      body: {
        ok: false,
        summary: POISON,
        stdout: "AWS_SECRET_ACCESS_KEY=abcdefghijklmnop1234\n",
        stderr: "\x1b[31mfail\x1b[0m",
      },
    });
    const result = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(result.kind).toBe("result");
    if (result.kind === "result") {
      expect(result.summary).not.toContain("ghp_");
      expect(result.output).not.toContain("abcdefghijklmnop1234");
      expect(result.output).not.toContain("\x1b");
      expect(result.output).toContain("fail");
    }
  });

  it("exec: a poisoned /exec error never reaches the thrown message raw", async () => {
    stubFetch({ status: 400, body: { error: POISON } });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("true").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("ghp_");
    expect((err as Error).message).not.toContain("\x1b");
  });
});

// Feature: docs/reference/specs/resident-repos.md item 65: a resident container
// that exited under a live run (the container rollout after a resident Worker
// deploy) is gone for about a minute, not for good. Before counting a strike
// the client asks the resident for its engine view (`GET /status`); while the
// engine says the container is coming back it waits for the wake, bounded by
// the command's budget under a three-minute ceiling, re-attaches, and hands
// /exec back as an `ExecSandboxRestartedError` the runner settles. A definite
// non-recovering answer keeps the two-strikes rule exactly as it was.
describe("ResidentExecutor waits for the wake (item 65: a container rollout is a minute, not a dead sandbox)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const JUST_EXITED = {
    error: "not-serviceable: The container just exited",
    status: 503,
    state: "warm",
    reason: "",
    stdout: "",
    stderr: "not-serviceable: The container just exited",
    exitCode: 127,
  };
  const status = (state: string, reason = "") => ({ body: { state, reason, inFlight: 0 } });
  const restoring = () => status("restoring", "rehydrating");

  it("a container exit during a live restore waits for warm, re-attaches, and hands /exec back as a restart (ExecSandboxRestartedError); never infra", async () => {
    const { calls } = stubFetch({ body: JUST_EXITED }, restoring(), restoring(), status("warm"), { body: ATTACH_OK });
    const executor = new ResidentExecutor(OPTS);
    const p = executor.exec("git status").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect((err as ExecSandboxRestartedError).waitedMs).toBe(10_000);
    expect((err as Error).message).toContain("after 10s");
    expect((err as Error).message).toContain("master@1220b9c");
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/status", "/attach"]);
    expect(calls[1].url).toContain("resource=repo%3Ajshttp%2Fvary");
  });

  it("a container exit with a definite non-recovering engine view is infra at once, on every call", async () => {
    const down = status("down", "no-snapshot: resident has no recorded snapshot to rehydrate from");
    const { calls } = stubFetch({ body: JUST_EXITED }, down, { body: JUST_EXITED }, down);
    const executor = new ResidentExecutor(OPTS);
    const first = await executor.exec("git status").catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ExecInfraError);
    expect((first as Error).message).toContain("The container just exited");
    expect((first as Error).message).toContain("down");
    // A definite engine view: no wait clears it, so the strike is refused — the
    // one more command judges at once although the words are the container's.
    expect((first as ExecInfraError).reason).toBe("refused");
    const second = await executor.exec("git status").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ExecInfraError);
    expect(calls.map(route)).toEqual(["/exec", "/status", "/exec", "/status"]);
  });

  it("an unreachable /status is a strike too: nothing says the container is coming back", async () => {
    stubFetch({ body: JUST_EXITED }, { reject: "fetch failed" });
    const err = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toContain("fetch failed");
    expect((err as ExecInfraError).reason).toBe("refused");
  });

  it("a re-attach that fails as infra inside the wait is a strike typed by the last engine view, not by the re-attach's own verdict: its transport failure says nothing about a resident the engine still says is serving — unavailable, for the harness's longer wait", async () => {
    // The engine says restoring, then warm: the re-attach goes out and fails on its transport.
    const { calls } = stubFetch({ body: JUST_EXITED }, restoring(), status("warm"), { reject: "fetch failed" });
    const executor = new ResidentExecutor(OPTS);
    const p = executor.exec("git status").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toContain("the re-attach after 5s did not answer");
    expect((err as Error).message).toContain("fetch failed");
    expect((err as ExecInfraError).reason).toBe("worker-unavailable");
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach"]);
  });

  it("a hard stop while the re-attach inside the wait is in flight aborts that request too — the run's signal rides into the re-attach as it rides into every other send — and the failure is the call's own `aborted` error, classified as the stop it is, never a wake strike counted as a container exit; nothing waits on a run that was stopped", async () => {
    const canned = [{ body: JUST_EXITED }, restoring(), status("warm")];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = canned.shift();
        if (next) return Promise.resolve(new Response(JSON.stringify(next.body), { status: 200 }));
        // The re-attach: no answer until the send's signal aborts, as a real fetch behaves.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );
    const control = new AbortController();
    const executor = new ResidentExecutor(OPTS);
    const p = executor.exec("git status", { signal: control.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach"]);
    control.abort();
    // A re-attach the stop did not reach would sit out its clipped deadline instead.
    await vi.advanceTimersByTimeAsync(180_000);
    const err = await p;
    // The call's own error, unchanged: `aborted`, classified `transport` as its
    // request site does for every aborted send, the request-failed sentence —
    // not the wake strike's `infra`/`container-exited` for an exit that did not happen.
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as ExecInfraError).reason).toBe("aborted");
    expect(infraMayClear(err as ExecInfraError)).toBe(false);
    expect(classificationOf(err)).toEqual({ kind: "transport" });
    expect((err as Error).message).toMatch(/^resident worker \/attach request failed \(/);
    expect((err as Error).message).not.toContain("the re-attach after");
    expect(calls[3].init.signal?.aborted).toBe(true);
  });

  it("a re-attach inside the wait whose 500 the Worker typed transient (the Durable Object reset or lost under the attach) keeps the wait going — the next probe and re-attach follow — instead of ending it in the attach's own error", async () => {
    // The streamed document `catchAllErr(err, "attach-failed")` writes over
    // HTTP 200; the words are the platform's (`TRANSIENT_PLATFORM_WORDING`,
    // deploy/cloudflare-resident/worker.ts), never read: the field decides.
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const { calls } = stubFetch({ body: JUST_EXITED }, restoring(), status("warm"), transientAttach, status("warm"), {
      body: ATTACH_OK,
    });
    const p = new ResidentExecutor(OPTS).exec("git status").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach", "/status", "/attach"]);
  });

  it("attach: a 500 the Worker typed transient enters the wake wait — a /status probe, then a re-attach as soon as the engine says it serves: at once when the first probe already says so, with no pause and no second probe — bounded by the wake budget, and binds when the resident answers, so the run's first attach and every re-attach alike never fall back cold on a hiccup a re-probe clears; a deterministic 500 stays the attach's own legible error, judged at once with no probe", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const { calls } = stubFetch(transientAttach, status("warm"), { body: ATTACH_OK });
    const binding = await new ResidentExecutor(OPTS).attach();
    expect(binding).toMatchObject({ ref: "master", sha: "1220b9c4", wokeAfterMs: 0 });
    expect(calls.map(route)).toEqual(["/attach", "/status", "/attach"]);
    const deterministic = stubFetch({ body: { error: "attach-failed at clone: exit 128", status: 500 } });
    const err = await new ResidentExecutor(OPTS).attach().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toBe(
      "resident attach failed for repo:jshttp/vary: attach-failed at clone: exit 128",
    );
    expect(deterministic.calls.map(route)).toEqual(["/attach"]);
  });

  it("attach: the wait is bounded by the wake budget — a resident still transient past it is the wake's own strike, the resident unavailable (`worker-unavailable`, infra a longer clock may still wait on), which the first attach's caller folds into its cold-fallback reason; and a `transient` flag on a non-5xx refusal is never a reason to wait (`isTransientRefusal`, one rule)", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const { calls } = stubFetch(
      transientAttach,
      status("warm"),
      transientAttach,
      status("warm"),
      transientAttach,
      status("warm"),
      transientAttach,
    );
    let settled: unknown;
    const p = new ResidentExecutor(OPTS).attach(undefined, { budgetMs: 10_000 }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
    expect(infraMayClear(settled as ExecInfraError)).toBe(true);
    // The wait's origin is the refusal the Worker typed transient, not a container's exit: the
    // strike says so in its sentence and its classification, never `container-exited`.
    expect((settled as Error).message).toContain("waited 10s for the resident to come back");
    expect((settled as Error).message).not.toContain("to wake");
    expect(classificationOf(settled)).toEqual({ kind: "infra", code: "transient-refusal" });
    // A probe and a re-attach at t=0, 5 s and at the budget's edge; then the strike.
    expect(calls.map(route)).toEqual(["/attach", "/status", "/attach", "/status", "/attach", "/status", "/attach"]);
    const notTransient = stubFetch({
      status: 409,
      body: { error: "reuse-refused: the tree is gone", needs: "recreate", transient: true },
    });
    const refused = await new ResidentExecutor(OPTS).attach().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ResidentReuseRefusedError);
    expect(notTransient.calls.map(route)).toEqual(["/attach"]);
  });

  it("an unreachable /status right after a transient refusal is the same platform blip, waited through — the Durable Object that lost the attach loses the probe too — so the wait goes on and the next probe's warm view lets the re-attach land; never the `refused` strike an unreachable Worker is on a wait a container's exit began", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const { calls } = stubFetch(transientAttach, { reject: "fetch failed" }, status("warm"), { body: ATTACH_OK });
    const p = new ResidentExecutor(OPTS).attach();
    await vi.advanceTimersByTimeAsync(5_000);
    const binding = await p;
    expect(binding).toMatchObject({ ref: "master", wokeAfterMs: 5_000 });
    expect(calls.map(route)).toEqual(["/attach", "/status", "/status", "/attach"]);
  });

  it("probes that stay unreachable past the budget after a transient refusal end in the resident unavailable (`worker-unavailable`, infra a longer clock may wait on), never `refused`: nothing definite was ever seen", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const { calls } = stubFetch(
      transientAttach,
      { reject: "fetch failed" },
      { reject: "fetch failed" },
      { reject: "fetch failed" },
    );
    let settled: unknown;
    const p = new ResidentExecutor(OPTS).attach(undefined, { budgetMs: 10_000 }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
    expect(infraMayClear(settled as ExecInfraError)).toBe(true);
    expect((settled as Error).message).toContain("waited 10s for the resident to come back (last seen unreachable (");
    expect(classificationOf(settled)).toEqual({ kind: "infra", code: "transient-refusal" });
    expect(calls.map(route)).toEqual(["/attach", "/status", "/status", "/status"]);
  });

  it("the run's stop rides into the first attach request itself, not only the wake wait's re-attach: a stop while it is in flight is the call's own aborted error at once", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );
    const control = new AbortController();
    const p = new ResidentExecutor(OPTS).attach(undefined, { signal: control.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    control.abort();
    const err = await p;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as ExecInfraError).reason).toBe("aborted");
    expect(calls.map(route)).toEqual(["/attach"]);
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it("one wake budget per operation: the wait for a rolling container and a recovery attach's wait for a transient refusal draw on the same clock, so a /read that spent 10s waking and then meets a transient re-attach has 170s of its budget left, not a fresh 180s", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const canned: Array<{ status?: number; body: unknown }> = [
      { body: JUST_EXITED },
      restoring(),
      status("warm"),
      transientAttach,
      status("warm"),
      { body: ATTACH_OK },
      { status: 409, body: { error: "not-attached: no live worktree", needs: "attach" } },
      transientAttach,
    ];
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        const next = canned.shift();
        if (next) return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
        // From here the resident stays warm and every re-attach stays transient, until the budget ends the wait.
        const body = path === "/status" ? { state: "warm", reason: "", inFlight: 0 } : transientAttach.body;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    let settled: unknown;
    const p = new ResidentExecutor(OPTS).readFile("f.txt").catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(180_000);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
    // The rolling wake took 10s (restoring, then a transient re-attach, then the binding);
    // the recovery attach's wait had the remaining 170s, and says so.
    expect((settled as Error).message).toContain("waited 170s for the resident to come back");
    expect(paths.slice(0, 8)).toEqual([
      "/read",
      "/status",
      "/status",
      "/attach",
      "/status",
      "/attach",
      "/read",
      "/attach",
    ]);
  });

  it("a hard stop while a /status probe inside the wait is in flight aborts that probe too — the run's signal rides into the probe as into every send — and the wait ends with the stop's one typed shape (`aborted`, classified as the transport), as the pause's and the re-attach's do, never a strike on the unreachable view the stop itself produced", async () => {
    const canned = [{ body: JUST_EXITED }, restoring()];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = canned.shift();
        if (next) return Promise.resolve(new Response(JSON.stringify(next.body), { status: 200 }));
        // The second probe: no answer until the send's signal aborts, as a real fetch behaves.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );
    const control = new AbortController();
    const p = new ResidentExecutor(OPTS).exec("git status", { signal: control.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status"]);
    control.abort();
    await vi.advanceTimersByTimeAsync(0);
    const err = await p;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as ExecInfraError).reason).toBe("aborted");
    expect(infraMayClear(err as ExecInfraError)).toBe(false);
    expect(classificationOf(err)).toEqual({ kind: "transport" });
    expect((err as Error).message).toBe(
      "resident /exec: stopped waiting for the resident to wake: the run was stopped",
    );
    expect(calls[2].init.signal?.aborted).toBe(true);
  });

  it("a /read whose Durable Object stub rejected with the SDK's stopped-container sentence is answered with the replaced word, as the method answers it inside (unconditional on /read and /write on purpose), so the client re-attaches once and re-issues — never a bare 409 it would read as a deterministic answer", async () => {
    // The document `threadRejectionErr(err, "/read")` writes: `runtimeReplacedErr`
    // over a RuntimeReplacedError in its `call` phase (deploy/cloudflare-resident/
    // worker.ts), its cause the SDK's stopped-container sentence
    // (`STOPPED_CONTAINER_WORDING`, src/execution/residentRefresh.ts).
    const replaced = {
      status: 409,
      body: {
        error:
          "runtime-replaced: the resident runtime was replaced (a deploy) while this request was pending at the Worker; its outcome is unknown (The container is not running, consider calling start())",
        reason: "runtime-replaced",
      },
    };
    const { calls } = stubFetch(replaced, { body: ATTACH_OK }, { body: { content: "back", truncated: false } });
    await expect(new ResidentExecutor(OPTS).readFile("f.txt")).resolves.toBe("back");
    expect(calls.map(route)).toEqual(["/read", "/attach", "/read"]);
  });

  it("a pending /exec whose Durable Object stub rejected with the SDK's own moved-runtime sentence streams the replaced word (the SDK vouched, by the DO's own rule applied to the text that survives the stub boundary), so the client hands the run the typed restart; the stopped-container sentence, which only the DO's restore knowledge could vouch for, streams the SDK's words on a bare 409 and is the resident's answer for the harness seam's one more command to judge", async () => {
    // The two documents `threadRejectionErr(err, "/exec")` writes: the word over
    // a RuntimeReplacedError in its `call` phase (deploy/cloudflare-resident/
    // worker.ts) with a `RUNTIME_MOVED_WORDING` sentence as its cause, and the
    // bare 409 carrying a `STOPPED_CONTAINER_WORDING` sentence (both from
    // src/execution/residentRefresh.ts).
    const moved =
      "runtime-replaced: the resident runtime was replaced (a deploy) while this request was pending at the Worker; its outcome is unknown (Process handle refers to a previous runtime incarnation)";
    stubFetch({
      body: { error: moved, reason: "runtime-replaced", status: 409, stdout: "", stderr: moved, exitCode: 127 },
    });
    const restart = await new ResidentExecutor(OPTS).exec("git status").catch((e: unknown) => e);
    expect(restart).toBeInstanceOf(ExecSandboxRestartedError);
    const stopped = "The container is not running, consider calling start()";
    stubFetch({ body: { error: stopped, status: 409, stdout: "", stderr: stopped, exitCode: 127 } });
    const withheld = await new ResidentExecutor(OPTS).exec("git status").catch((e: unknown) => e);
    expect(withheld).toBeInstanceOf(ExecInfraError);
    expect((withheld as ExecInfraError).reason).toBe("answered");
    // This exact sentence is what the harness seam reads as the transport lost
    // and probes on (`saysTransportLost`, src/core/harness/container.test.ts).
    expect((withheld as Error).message).toBe(`resident /exec: ${stopped}`);
  });

  it("a pending /exec whose Durable Object stub rejected with the DO's own code-update reset streams the DO's own word — `control-reset` on its 409, as `execThreadImpl` answers the same fact inside — so the client's control-reset rule fires (the typed ExecControlResetError the harness seam resolves) and a write's unknown outcome is never a wait on the resident", async () => {
    // The document `execFailureDocument(threadRejectionErr(err))` writes: the
    // ControlResetError's message in its `call` phase (class ControlResetError,
    // deploy/cloudflare-resident/worker.ts), its cause the fragment the SDK's
    // reset predicate matches (`SUPERSEDED_ISOLATE_PATTERN`, the pinned
    // @cloudflare/sandbox's `isDurableObjectCodeUpdateReset`).
    const words =
      "control-reset: the resident's Durable Object was reset (a deploy) while this request was pending at the Worker; the container and its processes are as they were; the request's outcome is unknown (reset because its code was updated)";
    stubFetch({
      body: { error: words, reason: "control-reset", status: 409, stdout: "", stderr: words, exitCode: 127 },
    });
    const err = await new ResidentExecutor(OPTS).exec("printf x > f").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecControlResetError);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect(err).not.toBeInstanceOf(ExecSandboxRestartedError);
    expect((err as Error).message).toBe(words);
  });

  it("a pending /exec whose Durable Object stub REJECTED — the stub reset by a code update, a storage operation that did not complete, the runtime unreachable — streams the catch-all's 500 in the same document over HTTP 200, so the client types it by its `transient`: the platform's transient is the resident unavailable (a re-probe clears it), a deterministic throw is the resident's answer; a Worker predating the fields streams the words alone, read as the answer it always was", async () => {
    // The words are the platform's — one of the terms the Worker's
    // `TRANSIENT_PLATFORM_WORDING` (deploy/cloudflare-resident/worker.ts)
    // names — and the client never reads them: the field decides.
    const rejected = (error: string, transient: boolean) => ({
      body: { error, status: 500, transient, stdout: "", stderr: error, exitCode: 127 },
    });
    stubFetch(rejected("Network connection lost.", true));
    const lost = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ExecInfraError);
    expect((lost as Error).message).toBe("resident /exec: Network connection lost.");
    expect((lost as ExecInfraError).reason).toBe("worker-unavailable");
    stubFetch(rejected("TypeError: Cannot read properties of undefined", false));
    const bug = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect((bug as ExecInfraError).reason).toBe("answered");
    stubFetch({
      body: { error: "Network connection lost.", stdout: "", stderr: "Network connection lost.", exitCode: 127 },
    });
    const old = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect((old as ExecInfraError).reason).toBe("answered");
  });

  it("a refusal streamed by /exec over HTTP 200 is typed by the status and the lifecycle pair IN the document, as the Worker's stream writes them: a busy mirror on a degraded-but-serviceable resident is the resident unavailable, never a deterministic answer; a definite state refuses", async () => {
    const streamed = (state: string, stateReason: string) => ({
      body: {
        error: "mirror-busy: mutex not acquired within 30000ms",
        state,
        stateReason,
        reason: "mirror-busy",
        status: 503,
        stdout: "",
        stderr: "mirror-busy: mutex not acquired within 30000ms",
        exitCode: 127,
      },
    });
    stubFetch(streamed("degraded", "github-unreachable: fetch failed"));
    const busy = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ExecInfraError);
    expect((busy as Error).message).toBe("resident /exec: mirror-busy: mutex not acquired within 30000ms");
    expect((busy as ExecInfraError).reason).toBe("worker-unavailable");
    stubFetch(streamed("down", "no-snapshot: nothing to rehydrate from"));
    const down = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect((down as ExecInfraError).reason).toBe("refused");
    // A Worker predating the fields streams neither status nor stateReason: the document is read as it always was, an answer.
    stubFetch({
      body: {
        error: "not-serviceable: degraded",
        state: "degraded",
        reason: "x",
        stdout: "",
        stderr: "",
        exitCode: 127,
      },
    });
    const old = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect((old as ExecInfraError).reason).toBe("answered");
  });

  it("a refusal that does not name a rolling container keeps the old rule: one strike, no probe", async () => {
    const { calls } = stubFetch({
      body: { ...JUST_EXITED, error: "not-serviceable: registry record or repo facts missing" },
    });
    const err = await new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect(calls.map(route)).toEqual(["/exec"]);
  });

  it("the wait respects the command's budget: a wake that never comes is a strike when the budget is spent, not at the ceiling", async () => {
    const { calls } = stubFetch({ body: JUST_EXITED }, ...Array.from({ length: 8 }, restoring));
    const executor = new ResidentExecutor(OPTS);
    let settled: unknown;
    const p = executor.exec("sleep 5", { timeoutMs: 20_000 }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as Error).message).toContain("waited 20s for the resident to wake");
    expect((settled as Error).message).toContain("restoring");
    // A container's exit began this wait: the strike is classified as that, and worded as the wake it waited for.
    expect(classificationOf(settled)).toEqual({ kind: "infra", code: "container-exited" });
    // The resident was still coming back when this client's budget ran out: the
    // harness's one more command keeps waiting on it (its own five-minute
    // bound), so the strike is the resident unavailable, never a refusal.
    expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/status", "/status", "/status"]);
  });

  it("the wait is capped at the three-minute ceiling whatever the command's budget", async () => {
    stubFetch({ body: JUST_EXITED }, ...Array.from({ length: 40 }, restoring));
    let settled: unknown;
    const p = new ResidentExecutor(OPTS)
      .exec("sleep 5", { timeoutMs: 10 * 60_000 })
      .catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(179_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as Error).message).toContain("waited 180s");
  });

  it("the resident going down mid-wait ends the wait with the strike naming it", async () => {
    const { calls } = stubFetch({ body: JUST_EXITED }, restoring(), status("down", "snapshot-stamp-mismatch: stale"));
    const p = new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toContain("snapshot-stamp-mismatch");
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status"]);
  });

  it("a hard stop during the pause ends the wait at once with the stop's one typed shape — `ExecInfraError` `aborted`, classified as the transport, what a stop during a probe or the re-attach's own call gives too — so a caller that counts infra failures sees one thing from every stop point, and nothing waits on a run that was stopped", async () => {
    stubFetch({ body: JUST_EXITED }, ...Array.from({ length: 5 }, restoring));
    const control = new AbortController();
    const executor = new ResidentExecutor(OPTS);
    const p = executor.exec("true", { signal: control.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    control.abort();
    const err = await p;
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as ExecInfraError).reason).toBe("aborted");
    expect(infraMayClear(err as ExecInfraError)).toBe(false);
    expect(classificationOf(err)).toEqual({ kind: "transport" });
    expect((err as Error).message).toBe(
      "resident /exec: stopped waiting for the resident to wake: the run was stopped",
    );
  });

  it("a re-attach refused while the container is still rolling (image-stale) keeps waiting; the next one binds", async () => {
    const imageStale = {
      status: 503,
      body: {
        error: "image-stale: the container predates the current pool and is restarting; retry shortly",
        status: 503,
        state: "restoring",
        reason: "image-stale",
      },
    };
    // After a container's exit the engine view lags: the first serving view is
    // not re-attached into (a full /attach into a container still starting on
    // every deploy); the first re-attach follows the first pause.
    const { calls } = stubFetch({ body: JUST_EXITED }, status("warm"), status("warm"), imageStale, status("warm"), {
      body: ATTACH_OK,
    });
    const p = new ResidentExecutor(OPTS).exec("true").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach", "/status", "/attach"]);
  });

  it("any other attach refusal mid-wait is the attach's own legible error (here: not onboarded), not a strike", async () => {
    stubFetch({ body: JUST_EXITED }, status("warm"), status("warm"), {
      status: 404,
      body: { error: "repo:jshttp/vary is not onboarded" },
    });
    const executor = new ResidentExecutor(OPTS);
    const p = executor.exec("true").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/not onboarded/);
  });

  it("the idempotent routes re-issue after the wake: /read waits, re-attaches and answers the content", async () => {
    const { calls } = stubFetch(
      {
        status: 503,
        body: { error: "not-serviceable: The container just exited", status: 503, state: "warm", reason: "" },
      },
      status("warm"),
      status("warm"),
      { body: ATTACH_OK },
      { body: { content: "hello", truncated: false } },
    );
    const p = new ResidentExecutor(OPTS).readFile("README.md").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBe("hello");
    expect(calls.map(route)).toEqual(["/read", "/status", "/status", "/attach", "/read"]);
  });

  /** A fetch whose canned answers may arrive late: `afterMs` delays the answer
   *  on the fake clock, and the request's own signal (the call's deadline or
   *  the run's stop) ends it first, as the platform would. */
  function stubFetchLate(...responses: Array<{ status?: number; body: unknown; afterMs?: number }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses.shift();
        return new Promise<Response>((resolve, reject) => {
          if (!next) return reject(new TypeError(`unexpected fetch: ${String(url)}`));
          const answer = () => resolve(new Response(JSON.stringify(next.body), { status: next.status ?? 200 }));
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
      }),
    );
    return { calls };
  }

  it("the re-attach inside a first attach's wait runs under the attach's own timeout, which the wake ceiling never caps — the ceiling bounds the probing: a cold clone and deps install of 3.5 minutes after a blip still binds, so a resident still attaching is never struck 'did not answer' while the run is provisioned cold beside it", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const { calls } = stubFetchLate(transientAttach, status("warm"), { body: ATTACH_OK, afterMs: 210_000 });
    const p = new ResidentExecutor(OPTS).attach(undefined, { budgetMs: 60_000 });
    await vi.advanceTimersByTimeAsync(210_000);
    const binding = await p;
    expect(binding).toMatchObject({ ref: "master", sha: "1220b9c4", wokeAfterMs: 210_000 });
    expect(calls.map(route)).toEqual(["/attach", "/status", "/attach"]);
  });

  it("the wake wait's clock starts before its first probe, so a strike's `waited Ns` is the whole wait: a first /status that takes 3s to answer is counted, and a 20s budget strikes at 20s, not 23s", async () => {
    const { calls } = stubFetchLate(
      { body: JUST_EXITED },
      { ...restoring(), afterMs: 3_000 },
      ...Array.from({ length: 6 }, restoring),
    );
    let settled: unknown;
    const p = new ResidentExecutor(OPTS).exec("sleep 5", { timeoutMs: 20_000 }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as Error).message).toContain("waited 20s for the resident to wake");
    // The slow first probe (t=3 s), then one every 5 s and a last at the budget's edge: t=8, 13, 18, 20; the strike at t=20.
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/status", "/status", "/status"]);
  });

  it("the wake clock starts at the first wait, never at the first call: an /exec whose call took 25s before the container's exit was answered still waits the command's whole budget for the wake", async () => {
    const { calls } = stubFetchLate({ body: JUST_EXITED, afterMs: 25_000 }, ...Array.from({ length: 8 }, restoring));
    let settled: unknown;
    const p = new ResidentExecutor(OPTS).exec("sleep 5", { timeoutMs: 30_000 }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(54_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as Error).message).toContain("waited 30s");
    expect(calls.map(route)).toEqual(["/exec", ...Array.from({ length: 7 }, () => "/status")]);
  });

  it("the rolling wake's re-attach — the one recovery that always recreates the worktree from the mirror — runs under the attach's own timeout like every attach request an operation opens: a 30s /exec whose re-attach clones and installs for two minutes after the exit is handed the restart, never struck 'did not answer' at its own call bound and counted as a rollout strike", async () => {
    const { calls } = stubFetchLate({ body: JUST_EXITED }, status("warm"), status("warm"), {
      body: ATTACH_OK,
      afterMs: 120_000,
    });
    const p = new ResidentExecutor(OPTS).exec("sleep 5", { timeoutMs: 30_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(125_000);
    const err = await p;
    expect(err).toBeInstanceOf(ExecSandboxRestartedError);
    expect((err as ExecSandboxRestartedError).waitedMs).toBe(125_000);
    expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach"]);
  });

  it("one bound for every attach request an operation opens, whatever the command's budget: a re-attach that hangs is struck at the attach's own default (the exec default, `BASH_TIMEOUT_MS`) — after the first pause — for a 30s /exec and a 20-minute /exec alike; the wake budget bounds the probing, never the request", async () => {
    for (const timeoutMs of [30_000, 20 * 60_000]) {
      const { calls } = stubFetchLate({ body: JUST_EXITED }, status("warm"), status("warm"), {
        body: ATTACH_OK,
        afterMs: 30 * 60_000,
      });
      let settled: unknown;
      const p = new ResidentExecutor(OPTS).exec("sleep 5", { timeoutMs }).catch((e: unknown) => (settled = e));
      await vi.advanceTimersByTimeAsync(5_000 + BASH_TIMEOUT_MS - 1);
      expect(settled, `${timeoutMs}`).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toBeInstanceOf(ExecInfraError);
      expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
      expect((settled as Error).message).toContain("the re-attach after 305s did not answer");
      expect(classificationOf(settled)).toEqual({ kind: "infra", code: "container-exited" });
      expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach"]);
    }
  });

  it("the run's clock clips every attach request the executor opens, where it was built with the run's clock (`ResidentExecutorOptions.remainingMs`): a harness container op with 90s of run left meets a rollout and its re-attach is struck at 30s (the remainder less the write-up reserve), with three minutes left at two, with ten minutes left at the default — the command's own budget never enters; an executor built with no run keeps the default", async () => {
    for (const { left, bound, timeoutMs } of [
      { left: 90_000, bound: 30_000, timeoutMs: 60_000 },
      { left: 3 * 60_000, bound: 120_000, timeoutMs: 30_000 },
      { left: 10 * 60_000, bound: BASH_TIMEOUT_MS, timeoutMs: 30_000 },
    ]) {
      const { calls } = stubFetchLate({ body: JUST_EXITED }, status("warm"), status("warm"), {
        body: ATTACH_OK,
        afterMs: 30 * 60_000,
      });
      let settled: unknown;
      const p = new ResidentExecutor({ ...OPTS, remainingMs: () => left })
        .exec("sleep 5", { timeoutMs })
        .catch((e: unknown) => (settled = e));
      await vi.advanceTimersByTimeAsync(5_000 + bound - 1);
      expect(settled, `${left}`).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled, `${left}`).toBeInstanceOf(ExecInfraError);
      expect((settled as ExecInfraError).reason).toBe("worker-unavailable");
      expect((settled as Error).message).toContain(
        `the re-attach after ${5 + bound / 1000}s did not answer (resident worker /attach request failed (the ${bound / 1000}s call deadline passed)`,
      );
      expect(calls.map(route)).toEqual(["/exec", "/status", "/status", "/attach"]);
    }
  });

  it("a recovery attach's own request is clipped to the run's clock too: with three minutes left, the re-attach after a worktree eviction that would install for four minutes is deadline-passed at two, never held for a default the run no longer has", async () => {
    const { calls } = stubFetchLate(
      { status: 409, body: { error: "not-attached: no live worktree", needs: "attach" } },
      { body: ATTACH_OK, afterMs: 4 * 60_000 },
    );
    let settled: unknown;
    const p = new ResidentExecutor({ ...OPTS, remainingMs: () => 3 * 60_000 })
      .exec("true", { timeoutMs: 30_000 })
      .catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBeInstanceOf(ExecInfraError);
    expect((settled as ExecInfraError).reason).toBe("deadline-passed");
    expect((settled as Error).message).toContain("the 120s call deadline passed");
    expect(calls.map(route)).toEqual(["/exec", "/attach"]);
  });

  it("inside the write-up reserve no attach is opened: with 30s of run left the wake's re-attach and a recovery attach are refused before any request, the typed `refused` naming the run's clock — never a request the resident runs to its end, never a deadline a wait could clear", async () => {
    // The wake: the pause, the serving view, then the refusal where the re-attach would open.
    const woke = stubFetchLate({ body: JUST_EXITED }, status("warm"), status("warm"), { body: ATTACH_OK });
    let settled: unknown;
    const p = new ResidentExecutor({ ...OPTS, remainingMs: () => 30_000 })
      .exec("sleep 5", { timeoutMs: 60_000 })
      .catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    // Its own class, so the run's end is read apart from a refusal where it is
    // decided (a relaunch's re-attach ends the run on its budget).
    expect(settled).toBeInstanceOf(ResidentLeaseSpentError);
    expect((settled as ExecInfraError).reason).toBe("refused");
    expect((settled as ResidentLeaseSpentError).leftMs).toBe(30_000);
    expect((settled as Error).message).toBe(
      "resident /exec: the run has 30s of wall clock left, inside the 60s write-up reserve, so no attach was opened",
    );
    expect(classificationOf(settled)).toEqual({ kind: "infra", code: "attach" });
    expect(woke.calls.map(route)).toEqual(["/exec", "/status", "/status"]);
    // The recovery attach: refused at once, the eviction's answer in hand.
    const evicted = stubFetchLate({ status: 409, body: { error: "not-attached: no live worktree", needs: "attach" } });
    const recovery = await new ResidentExecutor({ ...OPTS, remainingMs: () => 30_000 })
      .exec("true", { timeoutMs: 30_000 })
      .catch((e: unknown) => e);
    expect(recovery).toBeInstanceOf(ExecInfraError);
    expect((recovery as ExecInfraError).reason).toBe("refused");
    expect((recovery as Error).message).toContain("resident /attach: the run has 30s of wall clock left");
    expect(evicted.calls.map(route)).toEqual(["/exec"]);
  });

  it("an edge 5xx on /attach — no Worker document, an HTML body — is the platform's blip by the same provenance rule /status uses: `attach()` enters the wake wait instead of failing with a plain error, a re-attach that meets it again waits on, and the next serving view binds", async () => {
    const edge = {
      status: 502,
      raw: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>",
    };
    const atOnce = stubFetch(edge, status("warm"), { body: ATTACH_OK });
    expect(await new ResidentExecutor(OPTS).attach()).toMatchObject({ ref: "master", wokeAfterMs: 0 });
    expect(atOnce.calls.map(route)).toEqual(["/attach", "/status", "/attach"]);
    const again = stubFetch(edge, status("warm"), edge, status("warm"), { body: ATTACH_OK });
    const p = new ResidentExecutor(OPTS).attach();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ ref: "master", wokeAfterMs: 5_000 });
    expect(again.calls.map(route)).toEqual(["/attach", "/status", "/attach", "/status", "/attach"]);
    // A wait spent on the edge page throughout is the wake's strike, typed and waitable — never a plain Error.
    const spent = stubFetch(edge, ...Array.from({ length: 8 }, () => edge));
    let struck: unknown;
    const q = new ResidentExecutor(OPTS).attach(undefined, { budgetMs: 20_000 }).catch((e: unknown) => (struck = e));
    await vi.advanceTimersByTimeAsync(20_000);
    await q;
    expect(struck).toBeInstanceOf(ExecInfraError);
    expect((struck as ExecInfraError).reason).toBe("worker-unavailable");
    expect((struck as Error).message).toContain("HTTP 502 with no Worker document in the answer");
    expect(spent.calls.map(route).filter((r) => r === "/status")).toHaveLength(5);
  });

  it("a recovery attach after a worktree eviction has the attach default as its floor: a 30s /exec whose re-attach installs deps for two minutes on a healthy resident still re-issues and answers, never deadline-passed at the op's own call bound", async () => {
    const { calls } = stubFetchLate(
      { status: 409, body: { error: "not-attached: no live worktree", needs: "attach" } },
      { body: ATTACH_OK, afterMs: 120_000 },
      { body: { stdout: "ok", stderr: "", exitCode: 0, truncated: false } },
    );
    const p = new ResidentExecutor(OPTS).exec("true", { timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(p).resolves.toBe("ok");
    expect(calls.map(route)).toEqual(["/exec", "/attach", "/exec"]);
  });

  it("after a transient refusal only an unanswered probe is the same blip — the transport failing, or the Worker answering /status with a 5xx; a 4xx there (an operator token no longer accepted) is the definite answer it always was, the strike at once", async () => {
    const transientAttach = {
      body: { error: "attach-failed: Network connection lost.", status: 500, transient: true },
    };
    const denied = stubFetch(transientAttach, { status: 401, body: { error: "unauthorized" } });
    const err = await new ResidentExecutor(OPTS).attach().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as ExecInfraError).reason).toBe("refused");
    expect((err as Error).message).toContain("probe HTTP 401");
    expect(classificationOf(err)).toEqual({ kind: "infra", code: "transient-refusal" });
    expect(denied.calls.map(route)).toEqual(["/attach", "/status"]);
    const overloaded = stubFetch(
      transientAttach,
      // The Worker's catch-all types the overloaded Durable Object transient (threadErr.ts).
      { status: 503, body: { error: "Durable Object is overloaded", status: 503, transient: true } },
      status("warm"),
      { body: ATTACH_OK },
    );
    const p = new ResidentExecutor(OPTS).attach();
    await vi.advanceTimersByTimeAsync(5_000);
    const binding = await p;
    expect(binding).toMatchObject({ ref: "master", wokeAfterMs: 5_000 });
    expect(overloaded.calls.map(route)).toEqual(["/attach", "/status", "/status", "/attach"]);
    // A 5xx the Worker did NOT type transient — a throw in the status route, an
    // untyped answer — is definite, judged by the field and never by its status
    // class: the strike at once, not a minute of probing.
    const untyped = stubFetch(transientAttach, { status: 500, body: { error: "status route threw" } });
    const deterministic = await new ResidentExecutor(OPTS).attach().catch((e: unknown) => e);
    expect(deterministic).toBeInstanceOf(ExecInfraError);
    expect((deterministic as ExecInfraError).reason).toBe("refused");
    expect((deterministic as Error).message).toContain("probe HTTP 500: status route threw");
    expect(untyped.calls.map(route)).toEqual(["/attach", "/status"]);
    // A 5xx with NO Worker document — the edge's own error page, an HTML body,
    // where the Worker never ran to type anything — is the platform's blip by
    // its provenance: waited through, and the next warm view binds.
    const edge = stubFetch(
      transientAttach,
      { status: 502, raw: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>" },
      status("warm"),
      { body: ATTACH_OK },
    );
    const throughTheEdge = new ResidentExecutor(OPTS).attach();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await throughTheEdge).toMatchObject({ ref: "master", wokeAfterMs: 5_000 });
    expect(edge.calls.map(route)).toEqual(["/attach", "/status", "/status", "/attach"]);
    // The view itself says so: no document, typed transient, the status kept.
    stubFetch({ status: 520, raw: "<html>error code: 520</html>" });
    expect(await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000)).toEqual({
      kind: "unreachable",
      error: "probe HTTP 520: no Worker document in the answer",
      transport: false,
      status: 520,
      transient: true,
      edge: true,
    });
  });
});

// docs/reference/specs/execution.md item 25: the probe carries the seed handle
// the resident publishes — the checkout archive, the deps entry when one has
// been taken, the stamp — and nothing when the body has no snapshot of that shape.
describe("ResidentExecutor.probeStatus — the seed handle", () => {
  it("carries snapshot.{checkoutBackupId, depsBackupId, ref, sha} as `seed`, the deps id only when present", async () => {
    stubFetch({
      body: {
        state: "warm",
        reason: "",
        snapshot: {
          ref: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          lockfileHash: "l1",
          createdAt: "t",
          mirrorBackupId: "m-1",
          checkoutBackupId: "c-1",
          depsBackupId: "d-1",
        },
      },
    });
    const probe = await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000);
    expect(probe).toEqual({
      kind: "status",
      state: "warm",
      reason: "",
      seed: {
        checkoutBackupId: "c-1",
        depsBackupId: "d-1",
        ref: "main",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    stubFetch({
      body: {
        state: "warm",
        reason: "",
        snapshot: { ref: "main", sha: "s", checkoutBackupId: "c-1", depsBackupId: null },
      },
    });
    const noDeps = await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000);
    expect(noDeps).toMatchObject({ seed: { checkoutBackupId: "c-1", ref: "main", sha: "s" } });
    expect((noDeps as { seed: object }).seed).not.toHaveProperty("depsBackupId");
  });

  it("a body without a snapshot, or with one missing its ids, carries no seed", async () => {
    stubFetch({ body: { state: "onboarding", reason: "", snapshot: null } });
    expect(await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000)).not.toHaveProperty(
      "seed",
    );
    stubFetch({ body: { state: "warm", reason: "", snapshot: { ref: "main", sha: "s" } } });
    expect(await ResidentExecutor.probeStatus("https://resident.example", "t", "repo:x/y", 2000)).not.toHaveProperty(
      "seed",
    );
  });
});
