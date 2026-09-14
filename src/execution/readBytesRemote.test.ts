import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { ExecInfraError } from "./executor.js";
import { ResidentExecutor } from "./resident.js";

// Feature: docs/reference/specs/execution.md item 19 — the two remote clients'
// `readBytes`: the same `/read` route with `encoding: "base64"` in the body,
// the answer decoded; a Worker that predates binary reads, and a file over the
// cap, are plain errors (the rollout's or the model's), never infrastructure.
// All fetches are mocked.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stubFetch(...responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${String(url)}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

const route = (c: { url: string }) => new URL(c.url).pathname;
const sentBody = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflareSandboxExecutor.readBytes (item 19)", () => {
  const OPTS = { url: "https://sandbox.example", token: "t", threadKey: "slack:CX:1.0", resolveEnvs: async () => ({}) };

  it("asks /read for base64 and hands back the decoded bytes", async () => {
    const { calls } = stubFetch({ body: { encoding: "base64", content: PNG.toString("base64") } });
    const bytes = await new CloudflareSandboxExecutor(OPTS).readBytes("shots/a.png");
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    expect(route(calls[0]!)).toBe("/read");
    expect(sentBody(calls[0]!)).toMatchObject({ path: "shots/a.png", encoding: "base64" });
  });

  it("a Worker that predates binary reads answers text: named as a rollout gap, not decoded, not infra", async () => {
    stubFetch({ body: { content: "PNG" } });
    const err = await new CloudflareSandboxExecutor(OPTS).readBytes("a.png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/sandbox worker \/read: .*predates binary reads; redeploy it/);
  });

  it("a tooLarge answer is the cap's message naming the file, and not infra", async () => {
    stubFetch({ body: { encoding: "base64", tooLarge: true } });
    const err = await new CloudflareSandboxExecutor(OPTS).readBytes("video.mp4").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ExecInfraError);
    expect((err as Error).message).toMatch(/video\.mp4 is over the \d+-byte cap of a binary read/);
  });
});

describe("ResidentExecutor.readBytes (item 19)", () => {
  const OPTS = {
    baseUrl: "https://resident.example",
    token: "op-token",
    resource: "repo:o/r",
    threadKey: "slack:CX:1.0",
  };

  it("asks /read for base64 with the resource and thread, and hands back the decoded bytes", async () => {
    const { calls } = stubFetch({ body: { encoding: "base64", content: PNG.toString("base64") } });
    const bytes = await new ResidentExecutor(OPTS).readBytes("shots/a.png");
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    expect(route(calls[0]!)).toBe("/read");
    expect(sentBody(calls[0]!)).toMatchObject({
      resource: "repo:o/r",
      threadKey: "slack:CX:1.0",
      path: "shots/a.png",
      encoding: "base64",
    });
  });

  it("a missing file is the route's 404, classified like readFile's", async () => {
    stubFetch({ status: 404, body: { error: "read-failed: cat: No such file or directory" } });
    await expect(new ResidentExecutor(OPTS).readBytes("gone.png")).rejects.toThrow(
      /resident \/read: read-failed: cat: No such file/,
    );
  });

  it("a text answer (a resident that predates binary reads) and a tooLarge answer are plain errors, never infra", async () => {
    stubFetch({ body: { content: "PNG", truncated: false } });
    const stale = await new ResidentExecutor(OPTS).readBytes("a.png").catch((e: unknown) => e);
    expect(stale).not.toBeInstanceOf(ExecInfraError);
    expect((stale as Error).message).toMatch(/resident \/read: .*predates binary reads; redeploy it/);
    stubFetch({ body: { encoding: "base64", tooLarge: true } });
    const big = await new ResidentExecutor(OPTS).readBytes("big.bin").catch((e: unknown) => e);
    expect(big).not.toBeInstanceOf(ExecInfraError);
    expect((big as Error).message).toMatch(/big\.bin is over the \d+-byte cap/);
  });
});
