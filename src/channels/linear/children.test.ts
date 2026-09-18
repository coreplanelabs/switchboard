import { describe, expect, it } from "vitest";
import { InMemoryLinearChildStore, StoredLinearChildStore, type LinearChildStore } from "./children.js";
import type { LinearStorage } from "./store.js";

const intent = {
  organizationId: "org",
  appUserId: "bot",
  parentSessionId: "parent",
  requesterId: "linear:org:alice",
  issueId: "issue",
  commentId: "comment",
  lead: "Review this change",
};

function durable() {
  const rows = new Map<string, unknown>();
  let tail: Promise<unknown> = Promise.resolve();
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
  const storage: LinearStorage = {
    ...values,
    transaction(fn) {
      const result = tail.then(() => fn(values));
      tail = result.catch(() => {});
      return result;
    },
  };
  return { store: new StoredLinearChildStore(storage), reopen: () => new StoredLinearChildStore(storage) };
}

for (const [name, create] of [
  ["memory", () => new InMemoryLinearChildStore()],
  ["durable", () => durable().store],
] as const)
  describe(`Linear child creation store (${name})`, () => {
    it("binds one creation to its requester and admits only one session mutation", async () => {
      const store: LinearChildStore = create();
      await store.ensure(intent);
      await store.ensure(intent);
      await expect(store.ensure({ ...intent, requesterId: "linear:org:bob" })).rejects.toThrow("linear_child_conflict");
      const claims = await Promise.all([store.beginSession("org", "comment"), store.beginSession("org", "comment")]);
      expect(claims.sort()).toEqual([false, true]);
      await store.finish("org", "comment", { id: "child", url: "https://linear.app/session/child" });
      expect(await store.get("org", "comment")).toMatchObject({
        ...intent,
        sessionStarted: true,
        session: { id: "child" },
      });
      expect(await store.get("other", "comment")).toBeUndefined();
      await expect(store.finish("org", "comment", { id: "different" })).rejects.toThrow("linear_child_conflict");
    });
  });

describe("Linear child creation recovery", () => {
  it("retains an uncertain session mutation across store reconstruction", async () => {
    const { store, reopen } = durable();
    await store.ensure(intent);
    expect(await store.beginSession("org", "comment")).toBe(true);
    const restored = reopen();
    expect(await restored.beginSession("org", "comment")).toBe(false);
    await restored.finish("org", "comment", { id: "child" });
    expect((await reopen().get("org", "comment"))?.session?.id).toBe("child");
  });
});
