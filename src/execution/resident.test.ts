import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecHealthTracker, ExecInfraError } from "./executor.js";
import { ResidentExecutor, ResidentNeedsRefError, ResidentOperations } from "./resident.js";

// Feature: features/resident-repos.md — bot-side resident client (U5): every
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

describe("ResidentExecutor.exec", () => {
  it("parses the streamed body: leading heartbeat whitespace then one JSON document", async () => {
    const { calls } = stubFetch({
      raw: " \n \n " + JSON.stringify({ stdout: "hi\n", stderr: "", exitCode: 0, truncated: false }),
    });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("node -e \"console.log('hi')\"")).resolves.toBe("hi\n");
    // every route carries resource + threadKey in the JSON body (U4 contract)
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

  it("needs:\"attach\" (evicted/recycled worktree) re-attaches once and retries the command", async () => {
    const { fn, calls } = stubFetch(
      { body: { error: "worktree-missing: disk was recycled", needs: "attach", stdout: "", stderr: "worktree-missing", exitCode: 127 } },
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

  it("a second needs:\"attach\" after re-attach is a legible ExecInfraError, not a loop", async () => {
    stubFetch(
      { body: { error: "evicted: worktree was evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 } },
      { body: ATTACH_OK },
      { body: { error: "worktree-missing: still gone", needs: "attach", stdout: "", stderr: "worktree-missing", exitCode: 127 } },
    );
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("echo x").catch((e: unknown) => e);
    // worktree still gone after a re-attach → the resident is unhealthy: genuine
    // infra, so it counts toward fail-fast (#92).
    expect(err).toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/re-attach/);
  });

  it("a command-too-long rejection (plain HTTP 400, no needs) is a normal client Error, not infra", async () => {
    // The resident rejects an over-length command PRE-validation: a plain HTTP
    // 400 with an {error} and NO `needs`, nothing streamed (worker.ts handleExec).
    // It's agent-fixable, so it must be a normal Error — NOT an ExecInfraError
    // that would falsely count toward the fail-fast abort on a HEALTHY resident.
    const { fn } = stubFetch({
      status: 400,
      body: { error: "command must be a non-empty string of at most 8000 chars" },
    });
    const ex = new ResidentExecutor(OPTS);
    const err = await ex.exec("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/at most 8000 chars/);
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

// The #92 fail-fast counter (ExecHealthTracker) must fire on a genuinely dead
// resident but NEVER on a healthy one that merely rejected agent-fixable input.
// A client/validation rejection (command-too-long) is the exact false-positive
// the classification fix closes.
describe("ResidentExecutor infra classification through ExecHealthTracker (#92)", () => {
  it("two consecutive command-too-long rejections don't increment the infra counter (healthy resident)", async () => {
    stubFetch(
      { status: 400, body: { error: "command must be a non-empty string of at most 8000 chars" } },
      { status: 400, body: { error: "command must be a non-empty string of at most 8000 chars" } },
    );
    const tracker = new ExecHealthTracker(new ResidentExecutor(OPTS));
    await expect(tracker.exec("x".repeat(9000))).rejects.toThrow(/8000 chars/);
    await expect(tracker.exec("y".repeat(9000))).rejects.toThrow(/8000 chars/);
    // Two client rejections crossed the old MAX_CONSECUTIVE_INFRA_FAILURES (2)
    // and falsely aborted; a healthy resident must stay at zero.
    expect(tracker.consecutiveInfraFailures).toBe(0);
  });

  it("a genuine infra failure (worktree still gone after re-attach) counts toward fail-fast", async () => {
    stubFetch(
      { body: { error: "evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 } },
      { body: ATTACH_OK },
      { body: { error: "worktree-missing: still gone", needs: "attach", stdout: "", stderr: "worktree-missing", exitCode: 127 } },
    );
    const tracker = new ExecHealthTracker(new ResidentExecutor(OPTS));
    const err = await tracker.exec("echo x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect(tracker.consecutiveInfraFailures).toBe(1);
  });

  it("a non-2xx HTTP status is infra and counts toward fail-fast", async () => {
    stubFetch({ status: 503, raw: "mirror busy" });
    const tracker = new ExecHealthTracker(new ResidentExecutor(OPTS));
    const err = await tracker.exec("echo x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecInfraError);
    expect(tracker.consecutiveInfraFailures).toBe(1);
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

  it("a 409 needs:\"attach\" on read re-attaches once and retries", async () => {
    const { calls } = stubFetch(
      { status: 409, body: { error: "not-attached: no live worktree", needs: "attach" } },
      { body: ATTACH_OK },
      { body: { content: "back", truncated: false } },
    );
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.readFile("f.txt")).resolves.toBe("back");
    expect(calls.map(route)).toEqual(["/read", "/attach", "/read"]);
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

  it("409 needs:\"ref\" on open tells the user to name a branch", async () => {
    stubFetch({ status: 409, body: { error: "needs-ref: this thread has no ref binding yet", needs: "ref" } });
    await expect(ResidentExecutor.open(OPTS)).rejects.toThrow(/branch/i);
  });

  it("409 needs:\"ref\" is a TYPED error the dispatcher can catch for the ask-once flow (U7)", async () => {
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

// Feature: features/resident-repos.md — U6 ResidentOperations (KTD8): the
// deterministic-ops client for POST /op. Responses stream like /exec
// (heartbeat whitespace + one JSON document, parsed from the BODY); a failing
// op is a RESULT (ok:false), a mutating-entry refusal and not-onboarded are
// distinct named kinds, and transport failures never masquerade as results.
describe("ResidentOperations.run", () => {
  const OPS = { baseUrl: "https://resident.example", token: "op-token" };

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
    }
    expect(route(calls[0])).toBe("/op");
    expect(sentBody(calls[0])).toEqual({ resource: "repo:jshttp/vary", op: "test", ref: "master" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer op-token");
  });

  it("a failing op is a RESULT (ok:false with the named summary), not an error", async () => {
    stubFetch({
      body: { ok: false, op: "test", summary: "test failed (exit 1) on repo:jshttp/vary @ master (1220b9c4)", stdout: "", stderr: "1 failing", exitCode: 1 },
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
      body: { error: 'op-refused: the "test" command-table entry is marked effects: mutating — the modelless op path executes readonly entries only' },
    });
    const res = await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(res).toMatchObject({ kind: "refused" });
    if (res.kind === "refused") expect(res.reason).toMatch(/mutating/);
  });

  it("an in-body error (e.g. unknown-ref over the 200 stream) is kind error, never a fake result", async () => {
    stubFetch({ raw: " \n" + JSON.stringify({ error: 'unknown-ref: ref "nope" does not resolve in the mirror (even after a fetch)' }) });
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

  it("bounds the /op request with an AbortSignal.timeout (a hung resident can't stall the dispatch)", async () => {
    const { calls } = stubFetch({ body: { ok: true, summary: "s", exitCode: 0 } });
    await new ResidentOperations(OPS).run("test", { repo: "jshttp/vary" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ResidentExecutor.probeStatus", () => {
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
