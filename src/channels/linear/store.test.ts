import { describe, expect, it } from "vitest";
import { InMemoryLinearStore, StoredLinearStore, type LinearStorage, type LinearInstallation } from "./store.js";

const installation: LinearInstallation = {
  organizationId: "org",
  appUserId: "app",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 100,
  version: "v1",
};

function storage(): LinearStorage {
  const rows = new Map<string, unknown>();
  const values = {
    async get<T>(key: string) {
      return structuredClone(rows.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      rows.set(key, structuredClone(value));
    },
    async delete(key: string) {
      rows.delete(key);
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ...values,
    transaction<T>(fn: (tx: typeof values) => Promise<T>) {
      const next = tail.then(() => fn(values));
      tail = next.catch(() => {});
      return next;
    },
  };
}

for (const kind of ["memory", "durable"] as const) {
  describe(`Linear installation store — ${kind}`, () => {
    const make = () => (kind === "memory" ? new InMemoryLinearStore() : new StoredLinearStore(storage()));
    it("consumes browser state exactly once, including concurrent callbacks", async () => {
      const store = make();
      const state = { verifier: "pkce", expiresAt: 1000, redirectUri: "http://localhost:8080/oauth/linear/callback" };
      await store.putState("nonce", state);
      const taken = await Promise.all([store.takeState("nonce"), store.takeState("nonce")]);
      expect(taken).toEqual([state, undefined]);
    });
    it("isolates installations and refuses stale refresh after revocation or reinstall", async () => {
      const store = make();
      await store.putInstallation(installation);
      await store.putInstallation({ ...installation, organizationId: "other" });
      expect(await store.replaceInstallation("org", "stale", { ...installation, version: "v2" })).toBe(false);
      expect(await store.replaceInstallation("org", "v1", undefined)).toBe(true);
      expect(await store.replaceInstallation("org", "v1", { ...installation, version: "v2" })).toBe(false);
      await store.putInstallation({ ...installation, version: "reinstalled" });
      expect(await store.replaceInstallation("org", "v1", { ...installation, version: "v2" })).toBe(false);
      expect((await store.getInstallation("other"))?.version).toBe("v1");
    });
  });
}

describe("durable Linear store", () => {
  it("restores credentials and pending state in a new store instance", async () => {
    const backing = storage();
    const first = new StoredLinearStore(backing);
    await first.putInstallation(installation);
    await first.putState("nonce", {
      verifier: "pkce",
      expiresAt: 1000,
      redirectUri: "https://bot.example/oauth/linear/callback",
    });
    const restored = new StoredLinearStore(backing);
    expect(await restored.getInstallation("org")).toEqual(installation);
    expect((await restored.takeState("nonce"))?.verifier).toBe("pkce");
    expect(await first.takeState("nonce")).toBeUndefined();
  });
});
