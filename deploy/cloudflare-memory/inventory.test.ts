import { nextUnitProgress, currentUnitProgress } from "../../src/core/coordinator/unitProgress.ts";
import type { CoordinatorUnit } from "../../src/core/coordinator/contract.ts";
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import worker, { type Env } from "./worker.ts";
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
  it("reads several canonical unit groups in one store request and rejects an oversized or duplicate query", async () => {
    const storeKey = `runs:groups-${crypto.randomUUID()}`;
    for (const id of ["one", "two"]) await post("/runs/coordinator/put", { storeKey, instance: instance(id) });
    const unit: CoordinatorUnit = {
      instanceId: "one",
      unit: "U10",
      slug: "u1",
      branch: "work",
      rounds: [],
      dependsOn: [],
    };
    await post("/runs/coordinator/units/put", { storeKey, units: [unit] });
    expect(await post("/runs/coordinator/units/list-many", { storeKey, instanceIds: ["two", "one"] })).toEqual({
      status: 200,
      body: {
        groups: [
          { instanceId: "two", units: [] },
          { instanceId: "one", units: [unit] },
        ],
      },
    });
    for (const instanceIds of [[], ["one", "one"], Array.from({ length: 101 }, (_, i) => `id-${i}`)])
      expect((await post("/runs/coordinator/units/list-many", { storeKey, instanceIds })).status).toBe(400);
  });
  it("reads a full 100-pipeline unit batch through SQLite", async () => {
    const storeKey = `runs:full-groups-${crypto.randomUUID()}`;
    const instanceIds = Array.from({ length: 100 }, (_, index) => `pipeline-${index}`);
    for (const id of instanceIds)
      expect((await post("/runs/coordinator/put", { storeKey, instance: instance(id) })).status).toBe(200);
    const units: CoordinatorUnit[] = instanceIds.map((instanceId) => ({
      instanceId,
      unit: "work",
      slug: "work",
      branch: "work",
      rounds: [],
      dependsOn: [],
    }));
    expect((await post("/runs/coordinator/units/put", { storeKey, units })).status).toBe(200);
    expect(await post("/runs/coordinator/units/list-many", { storeKey, instanceIds })).toEqual({
      status: 200,
      body: { groups: instanceIds.map((instanceId, index) => ({ instanceId, units: [units[index]] })) },
    });
  });
  it.each([
    [new TypeError("PRIVATE_INVENTORY_DETAIL"), "type_error"],
    [new SyntaxError("PRIVATE_INVENTORY_DETAIL"), "syntax_error"],
    [Object.assign(new Error("PRIVATE_INVENTORY_DETAIL"), { name: "PRIVATE_ERROR_NAME" }), "error"],
    ["PRIVATE_INVENTORY_DETAIL", "non_error"],
  ])("keeps inventory failure responses and logs only a closed error kind %s", async (failure, errorKind) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = JSON.stringify({ storeKey: "runs:inventory-diagnostic", limit: 2 });
      const response = await worker.fetch(
        new Request("https://memory.test/runs/coordinator/list", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
            "content-length": String(body.length),
          },
          body,
        }),
        {
          ...env,
          RUNS: {
            idFromName: env.RUNS.idFromName.bind(env.RUNS),
            get: () => ({
              listInstances: async () => {
                throw failure;
              },
            }),
          } as unknown as Env["RUNS"],
        },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "pipeline inventory unavailable" });
      expect(warning.mock.calls).toEqual([
        [
          JSON.stringify({
            event: "home.read.failed",
            phase: "pipeline_inventory_list",
            errorKind,
          }),
        ],
      ]);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE_");
    } finally {
      warning.mockRestore();
    }
  });
  it("persists only the winning original progress CAS and refuses malformed progress rows", async () => {
    const storeKey = `runs:census-${crypto.randomUUID()}`;
    const parent = instance("progress");
    const unit: CoordinatorUnit = {
      instanceId: parent.id,
      unit: "original",
      slug: "original",
      branch: "work",
      dependsOn: [],
      rounds: [],
    };
    expect((await post("/runs/coordinator/put", { storeKey, instance: parent })).status).toBe(200);
    expect((await post("/runs/coordinator/units/put", { storeKey, units: [unit] })).status).toBe(200);
    const next = nextUnitProgress(
      parent,
      unit,
      parent.id,
      { expectedRevision: 0, step: "original/checks/wait", waiting: { kind: "checks", headSha: "a".repeat(40) } },
      7,
    );
    if (!next.ok) throw new Error("fixture progress must be valid");
    const updated = { ...unit, recordedProgress: next.progress };
    const writes = await Promise.all(
      [updated, { ...updated, recordedProgress: { ...next.progress, step: "other/checks/wait" } }].map((recovered) =>
        post("/runs/coordinator/units/claim-legacy-continuation", { storeKey, expected: unit, recovered }),
      ),
    );
    expect(writes.map((result) => result.status).sort()).toEqual([200, 409]);
    const rows = await post("/runs/coordinator/units/list", { storeKey, instanceId: parent.id });
    const stored = (rows.body.units as CoordinatorUnit[])[0]!;
    expect(currentUnitProgress(stored)?.revision).toBe(1);
    expect(currentUnitProgress(stored)?.waiting).toEqual({ kind: "checks", headSha: "a".repeat(40) });
    expect(
      (
        await post("/runs/coordinator/units/put", {
          storeKey,
          units: [{ ...stored, recordedProgress: { ...stored.recordedProgress, revision: -1 } }],
        })
      ).status,
    ).toBe(400);
    const changed = { ...stored, rounds: [{ index: 1, agent: "review", outcome: "approve", at: 9 }] };
    expect(
      (
        await post("/runs/coordinator/units/claim-legacy-continuation", {
          storeKey,
          expected: stored,
          recovered: changed,
        })
      ).status,
    ).toBe(200);
    expect(currentUnitProgress(changed)).toBeUndefined();
  });
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
