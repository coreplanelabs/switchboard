import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestBearer, FilePersonalTokenStore, WorkerPersonalTokenStore } from "./personalTokens.js";

describe("personal MCP token stores", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("file store persists only digests across instances and enforces owner revocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-token-"));
    dirs.push(dir);
    const path = join(dir, "tokens.json");
    const bearer = "a".repeat(64);
    const token = { digest: digestBearer(bearer), subject: "personal:one", email: "one@example.com", createdAt: 1 };
    const first = new FilePersonalTokenStore(path);
    await first.put(token);
    const second = new FilePersonalTokenStore(path);
    expect(await second.get(token.digest)).toEqual(token);
    expect(await second.list("personal:two")).toEqual([]);
    expect(await second.delete(token.digest, "personal:two")).toBe(false);
    expect(await second.delete(token.digest, "personal:one")).toBe(true);
    expect(await first.get(token.digest)).toBeNull();
    expect(readFileSync(path, "utf8")).not.toContain(bearer);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("worker store sends only digest metadata and uses the configured state Worker", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ token: null, tokens: [], removed: true }), { status: 200 });
    };
    const store = new WorkerPersonalTokenStore({
      baseUrl: "https://state.example/",
      token: "state-secret",
      fetch: fetchStub as typeof fetch,
    });
    const token = { digest: "a".repeat(64), subject: "personal:one", email: "one@example.com", createdAt: 1 };
    await store.put(token);
    await store.get(token.digest);
    await store.list(token.subject);
    expect(await store.delete(token.digest, token.subject)).toBe(true);
    expect(requests.map((r) => r.url)).toEqual(
      ["put", "get", "list", "delete"].map((name) => `https://state.example/config/personal-tokens/${name}`),
    );
    expect(JSON.stringify(requests)).not.toContain("state-secret");
  });
});
