import { describe, expect, it } from "vitest";
import { fetchMemoryTest } from "./testFetch.ts";
import type { CoordinatorInstance } from "../../src/core/coordinator/contract.ts";

const instance = (id: string, label = id): CoordinatorInstance => ({
  id,
  kind: "ship",
  userId: "slack:UTEST",
  channelId: "slack:C1",
  threadKey: "slack:C1:1",
  repo: "acme/api",
  branch: "work/test",
  merge: "person",
  createdAt: 1,
  label,
});
async function post(path: string, body: unknown, token = "test-token") {
  return fetchMemoryTest(
    `https://memory.test${path}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    async (response) => ({ status: response.status, body: (await response.json()) as Record<string, any> }),
  );
}

describe("durable pipeline census", () => {
  it("pages old runless pipelines through SQLite without admitting later insertions", async () => {
    const storeKey = `runs:census-${crypto.randomUUID()}`;
    for (const id of ["first", "middle", "last"])
      expect((await post("/runs/coordinator/put", { storeKey, instance: instance(id) })).status).toBe(200);
    const first = await post("/runs/coordinator/list", { storeKey, limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.items.map((row: CoordinatorInstance) => row.id)).toEqual(["first", "middle"]);
    expect(first.body.cursor).toEqual(expect.any(String));
    expect((await post("/runs/coordinator/replace", { storeKey, instance: instance("last", "updated") })).status).toBe(
      200,
    );
    expect((await post("/runs/coordinator/put", { storeKey, instance: instance("later") })).status).toBe(200);
    const next = await post("/runs/coordinator/list", { storeKey, limit: 2, cursor: first.body.cursor });
    expect(next.status).toBe(200);
    expect(next.body.items).toEqual([instance("last", "updated")]);
    expect(next.body.cursor).toBeUndefined();
    const fresh = await post("/runs/coordinator/list", { storeKey, limit: 100 });
    expect(fresh.body.items.map((row: CoordinatorInstance) => row.id)).toEqual(["first", "middle", "last", "later"]);
  });
  it("resumes a terminal SQLite page under the same insertion watermark", async () => {
    const storeKey = `runs:census-${crypto.randomUUID()}`;
    expect((await post("/runs/coordinator/put", { storeKey, instance: instance("old") })).status).toBe(200);
    const first = await post("/runs/coordinator/list", { storeKey, limit: 100 });
    expect(first.body.cursor).toBeUndefined();
    expect(first.body.resumeCursor).toEqual(expect.any(String));
    expect((await post("/runs/coordinator/put", { storeKey, instance: instance("later") })).status).toBe(200);
    const resumed = await post("/runs/coordinator/list", { storeKey, limit: 100, cursor: first.body.resumeCursor });
    expect(resumed.status).toBe(200);
    expect(resumed.body.items).toEqual([instance("old")]);
    expect(resumed.body.cursor).toBeUndefined();
  });
  it("orders complete unit key prefixes and excludes later SQLite insertions", async () => {
    const storeKey = `runs:census-${crypto.randomUUID()}`;
    for (const id of ["work", "work-2", "alpha"])
      expect((await post("/runs/coordinator/put", { storeKey, instance: instance(id) })).status).toBe(200);
    const first = await post("/runs/coordinator/list", { storeKey, limit: 1, order: "key" });
    expect(first.body.items).toEqual([instance("alpha")]);
    expect((await post("/runs/coordinator/put", { storeKey, instance: instance("aardvark") })).status).toBe(200);
    const next = await post("/runs/coordinator/list", {
      storeKey,
      limit: 100,
      order: "key",
      cursor: first.body.cursor,
    });
    expect(next.body.items).toEqual([instance("work-2"), instance("work")]);
    expect(next.body.cursor).toBeUndefined();
    expect((await post("/runs/coordinator/list", { storeKey, limit: 1, cursor: first.body.cursor })).status).toBe(503);
    expect((await post("/runs/coordinator/list", { storeKey, limit: 1, order: "unknown" })).status).toBe(400);
  });
  it("refuses unauthenticated and malformed census requests", async () => {
    const storeKey = `runs:census-${crypto.randomUUID()}`;
    expect((await post("/runs/coordinator/list", { storeKey, limit: 2 }, "wrong")).status).toBe(401);
    expect((await post("/runs/coordinator/list", { storeKey, limit: 0 })).status).toBe(400);
    expect((await post("/runs/coordinator/list", { storeKey, limit: 2, cursor: "foreign" })).status).toBe(503);
  });
});
