import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentExecutor, ResidentNeedsRefError } from "./resident.js";

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

  it("a second needs:\"attach\" after re-attach is a legible error, not a loop", async () => {
    stubFetch(
      { body: { error: "evicted: worktree was evicted", needs: "attach", stdout: "", stderr: "evicted", exitCode: 127 } },
      { body: ATTACH_OK },
      { body: { error: "worktree-missing: still gone", needs: "attach", stdout: "", stderr: "worktree-missing", exitCode: 127 } },
    );
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("echo x")).rejects.toThrow(/re-attach/);
  });

  it("an in-body error without needs is surfaced verbatim, never retried", async () => {
    const { fn } = stubFetch({
      body: { error: "command too long", stdout: "", stderr: "command too long", exitCode: 127 },
    });
    const ex = new ResidentExecutor(OPTS);
    await expect(ex.exec("x")).rejects.toThrow(/command too long/);
    expect(fn).toHaveBeenCalledTimes(1);
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
