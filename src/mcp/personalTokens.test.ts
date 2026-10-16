import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestBearer,
  FilePersonalTokenStore,
  InMemoryPersonalTokenStore,
  WorkerPersonalTokenStore,
} from "./personalTokens.js";

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
    expect(await second.get(token.digest)).toEqual({ ...token, userId: "access:one" });
    expect(await second.list("personal:two")).toEqual([]);
    expect(await second.delete(token.digest, "personal:two")).toBe(false);
    expect(await second.delete(token.digest, "personal:one")).toBe(true);
    expect(await first.get(token.digest)).toBeNull();
    expect(readFileSync(path, "utf8")).not.toContain(bearer);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps exact Access approval across restart and refuses email links and raw digest collisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-token-"));
    dirs.push(dir);
    const path = join(dir, "tokens.json");
    for (const store of [new InMemoryPersonalTokenStore(), new FilePersonalTokenStore(path)]) {
      const token = {
        digest: "c".repeat(64),
        subject: "personal:one",
        userId: "access:one",
        email: "one@example.com",
        createdAt: 42,
      };
      await store.put(token);
      await store.put({ ...token, createdAt: 999, email: "changed@example.com" });
      expect(await store.get(token.digest)).toEqual(token);
      await expect(store.put({ ...token, subject: "personal:two", userId: "access:two" })).rejects.toThrow(
        "new device approval",
      );
      const legacy = { ...token, digest: "d".repeat(64), userId: "slack:UALICE" };
      await store.put(legacy);
      expect(await store.get(legacy.digest)).toBeNull();
      expect(await store.list(token.subject)).toEqual([token, legacy]);
      await expect(store.put({ ...legacy, userId: "access:one" })).rejects.toThrow("new device approval");
      expect(await store.delete(legacy.digest, "personal:two")).toBe(false);
      expect(await store.delete(legacy.digest, "personal:one")).toBe(true);
    }
    const reloaded = new FilePersonalTokenStore(path);
    expect(await reloaded.get("c".repeat(64))).toEqual({
      digest: "c".repeat(64),
      subject: "personal:one",
      userId: "access:one",
      email: "one@example.com",
      createdAt: 42,
    });
  });

  it("preserves pinned approval across file restart and rejects malformed or changed proof instead of replacing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-token-"));
    dirs.push(dir);
    const path = join(dir, "tokens.json");
    const token = {
      digest: "e".repeat(64),
      subject: "personal:one",
      userId: "access:one",
      email: "one@example.com",
      createdAt: 42,
      approval: {
        version: 1 as const,
        issuer: "https://team.example",
        audience: "app-one",
        organization: "org-one",
        subject: "one",
      },
    };
    const store = new FilePersonalTokenStore(path);
    await store.put(token);
    expect(await new FilePersonalTokenStore(path).get(token.digest)).toEqual(token);
    for (const approval of [
      undefined,
      { ...token.approval, audience: "app-two" },
      { ...token.approval, subject: "two" },
      { ...token.approval, version: 2 },
      { ...token.approval, issuer: "http://team.example" },
      { ...token.approval, jwt: "not-a-proof" },
    ]) {
      await expect(store.put({ ...token, approval } as never)).rejects.toThrow();
      expect(await store.get(token.digest)).toEqual(token);
    }
    const legacy = { ...token, digest: "f".repeat(64), approval: undefined };
    await store.put(legacy);
    await expect(store.put({ ...legacy, approval: token.approval })).rejects.toThrow("new device approval");
    expect(await store.list(token.subject)).toHaveLength(2);
    expect(await store.delete(legacy.digest, token.subject)).toBe(true);
    expect(await store.get(token.digest)).toEqual(token);
  });

  it("keeps pinned memory approval immutable and does not replace a raw malformed occupied digest", async () => {
    const token = {
      digest: "7".repeat(64),
      subject: "personal:one",
      userId: "access:one",
      email: "one@example.com",
      createdAt: 42,
      approval: {
        version: 1 as const,
        issuer: "https://team.example",
        audience: "app-one",
        organization: "org-one",
        subject: "one",
      },
    };
    const store = new InMemoryPersonalTokenStore();
    await store.put(token);
    token.approval.organization = "mutated-input";
    const read = (await store.get(token.digest))!;
    expect(read.approval?.organization).toBe("org-one");
    read.approval!.organization = "mutated-read";
    const listed = await store.list(token.subject);
    listed[0].approval!.organization = "mutated-list";
    expect((await store.get(token.digest))?.approval?.organization).toBe("org-one");
    const dir = mkdtempSync(join(tmpdir(), "switchboard-token-"));
    dirs.push(dir);
    const path = join(dir, "tokens.json");
    const raw = JSON.stringify({ [token.digest]: { ...read, approval: { ...read.approval, jwt: "not-a-proof" } } });
    writeFileSync(path, raw);
    const file = new FilePersonalTokenStore(path);
    expect(await file.get(token.digest)).toBeNull();
    await expect(file.put(token)).rejects.toThrow("new device approval");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("worker authentication rejects legacy Slack metadata while owner listing keeps it revocable", async () => {
    const legacy = {
      digest: "d".repeat(64),
      subject: "personal:one",
      userId: "slack:UALICE",
      email: "one@example.com",
      createdAt: 42,
    };
    const store = new WorkerPersonalTokenStore({
      baseUrl: "https://state.example",
      token: "fixture",
      fetch: async (_url, _init) =>
        new Response(JSON.stringify(String(_url).endsWith("/list") ? { tokens: [legacy] } : { token: legacy }), {
          status: 200,
        }),
    });
    expect(await store.get(legacy.digest)).toBeNull();
    expect(await store.list(legacy.subject)).toEqual([legacy]);
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
