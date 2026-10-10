import { describe, expect, it } from "vitest";
import { InMemoryCoordinatorInstanceStore, WorkerCoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorInstance } from "./contract.js";

const instance = (id: string): CoordinatorInstance => ({
  id,
  kind: "ship",
  userId: "slack:UTEST",
  channelId: "slack:C1",
  threadKey: "slack:C1:1",
  repo: "acme/api",
  branch: "work/test",
  merge: "person",
  createdAt: 1,
});

describe("durable pipeline inventory", () => {
  it("keeps old pipelines discoverable without a run and excludes later insertions from its census", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    for (const id of ["old", "middle", "last"]) await store.put(instance(id));
    const first = await store.listInstances({ limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual(["old", "middle"]);
    expect(first.cursor).toEqual(expect.any(String));
    await store.put(instance("new"));
    const next = await store.listInstances({ limit: 2, cursor: first.cursor });
    expect(next.items.map((row) => row.id)).toEqual(["last"]);
    expect(next.cursor).toBeUndefined();
    expect((await store.listInstances({ limit: 100 })).items.map((row) => row.id)).toEqual([
      "old",
      "middle",
      "last",
      "new",
    ]);
  });

  it("refuses malformed paging instead of reporting an empty complete inventory", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    await expect(store.listInstances({ limit: 0 })).rejects.toThrow("inventory");
    await expect(store.listInstances({ limit: 2, cursor: "foreign" })).rejects.toThrow("inventory");
  });

  it("reads the same bounded census through the durable HTTP boundary", async () => {
    const memory = new InMemoryCoordinatorInstanceStore();
    await memory.put(instance("old"));
    const store = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://state.test",
      token: "test-only",
      storeKey: "runs:default",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return Response.json(await memory.listInstances(body));
      },
    });
    expect(await store.listInstances({ limit: 2 })).toMatchObject({ items: [instance("old")] });
  });

  it("can resume a terminal page without admitting later insertions", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    await store.put(instance("old"));
    const first = await store.listInstances({ limit: 100 });
    expect(first.cursor).toBeUndefined();
    expect(first.resumeCursor).toEqual(expect.any(String));
    await store.put(instance("later"));
    const resumed = await store.listInstances({ limit: 100, cursor: first.resumeCursor });
    expect(resumed.items.map((row) => row.id)).toEqual(["old"]);
    expect(resumed.cursor).toBeUndefined();
  });
  it("pages keys in order under the same census and fences cursor ordering", async () => {
    const store = new InMemoryCoordinatorInstanceStore();
    for (const id of ["zed", "alpha"]) await store.put(instance(id));
    const first = await store.listInstances({ limit: 1, order: "key" });
    expect(first.items.map((row) => row.id)).toEqual(["alpha"]);
    await store.put(instance("aardvark"));
    const next = await store.listInstances({ limit: 1, order: "key", cursor: first.cursor });
    expect(next.items.map((row) => row.id)).toEqual(["zed"]);
    expect(next.cursor).toBeUndefined();
    await expect(store.listInstances({ limit: 1, cursor: first.cursor })).rejects.toThrow("cursor");
    const inserted = await store.listInstances({ limit: 1 });
    await expect(store.listInstances({ limit: 1, order: "key", cursor: inserted.cursor })).rejects.toThrow("cursor");
    const prefixes = new InMemoryCoordinatorInstanceStore();
    for (const id of ["work", "work-2"]) await prefixes.put(instance(id));
    expect((await prefixes.listInstances({ limit: 100, order: "key" })).items.map((row) => row.id)).toEqual([
      "work-2",
      "work",
    ]);
  });

  it("refuses a corrupt durable response instead of accepting unknown records", async () => {
    const store = new WorkerCoordinatorInstanceStore({
      baseUrl: "https://state.test",
      token: "test-only",
      storeKey: "runs:default",
      fetch: async () => Response.json({ items: [{ id: "hidden" }] }),
    });
    await expect(store.listInstances({ limit: 2 })).rejects.toThrow("inventory");
  });
});
