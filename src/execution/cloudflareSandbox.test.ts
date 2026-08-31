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
  envs: {},
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
