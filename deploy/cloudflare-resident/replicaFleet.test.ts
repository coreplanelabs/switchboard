import { assertRepositorySettingsWritable } from "../../src/execution/registrySettings.js";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { makeResidentAdminClient } from "../../src/core/residentAdmin";
import {
  residentAddress,
  selectedResidentMember,
  residentMembers,
  residentPoolOf,
  reservedResidentCount,
  planResidentPool,
  nextResidentMember,
} from "../../src/execution/residentMembers";
import { readResidentPlacement, recordResidentPlacement } from "../../src/execution/residentPlacement";
import { residentRouteOf, sameResidentRoute } from "../../src/execution/residentRoute";
import { isServiceable } from "../../src/execution/residentState";
import { residentText } from "../../src/execution/residentText";
import { placementHistoryThreads, replicaMaintenanceFence } from "./replicaMigration";
import { ResidentRecreateAdmission } from "../../src/execution/residentRecreateAdmission";
import { effectiveLimits } from "./gc";
import { methodOf, readSource } from "./testing/sourceScan";
import { residentImageTargetSchema } from "../../src/deploy/residentMaintenance";

const source = readSource("worker.ts");
const resource = "repo:acme/api";
const imageTarget = {
  application: "test-resident-residentdo",
  version: 1,
  image: "registry.example.test/resident:one",
};
const fence = {
  since: "2026-01-01T00:00:00.000Z",
  until: "2026-01-01T01:00:00.000Z",
  swapVersion: "old",
  swapAt: "2026-01-01T00:05:00.000Z",
};
const drain = { ...fence, swapFence: true, reason: "deploy", by: "operator" };
const permit = "deploy:admission:reconcile";

/** Execute the production RPCs against serialized, rollback-capable storage.
 * A fresh object uses the same durable rows, as an isolate replacement would. */
function registry(rows = new Map<string, unknown>([[`resident:${resource}`, { resource }]])) {
  const methods = [
    "requestWarmReplicas",
    "resolveThreadPlacement",
    "readThreadPlacement",
    "replicaMaintenance",
    "importPrimaryPlacements",
    "list",
    "listRepositories",
    "getRepository",
    "beginPoolOffboard",
    "recordPoolRemoval",
    "finishPoolOffboard",
  ];
  const compiled = ts.transpileModule(`class Registry { ${methods.map((m) => methodOf(source, m)).join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Registry = runInNewContext(`${compiled}\nRegistry`, {
    console,
    residentMembers,
    assertRepositorySettingsWritable,
    residentPoolOf,
    reservedResidentCount,
    planResidentPool,
    nextResidentMember,
    readResidentPlacement,
    recordResidentPlacement,
    replicaMaintenanceFence,
    effectiveLimits,
    crypto: { randomUUID },
    systemClock: () => Date.parse("2026-01-01T00:15:00.000Z"),
    RESIDENT_CAP: 5,
    LRU_FLOOR_S: 3600,
    BUILD_ID: "test",
    TEST_OVERRIDES_KEY: "overrides",
    REGISTRY_KEY_PREFIX: "resident:",
    registryKey: (value: string) => `resident:${value}`,
    DRAIN_KEY: "drain",
    DEPLOY_ADMISSION_KEY_PREFIX: "deploy:admission:",
    THREAD_KEY_RE: /^[a-z]{1,32}:[A-Za-z0-9._:-]{1,128}$/,
  });
  const port = (data: Map<string, unknown>) => ({
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    delete: async (keys: string | string[]) => {
      for (const key of typeof keys === "string" ? [keys] : keys) data.delete(key);
    },
    list: async ({ prefix, limit = Infinity }: { prefix: string; limit?: number }) =>
      new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      ),
  });
  let tail = Promise.resolve();
  const instance = new Registry();
  instance.ctx = {
    storage: {
      ...port(rows),
      transaction: (body: (txn: ReturnType<typeof port>) => Promise<unknown>) => {
        const result = tail.then(async () => {
          const draft = structuredClone(rows);
          const answer = await body(port(draft));
          rows.clear();
          for (const [key, value] of draft) rows.set(key, value);
          return answer;
        });
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  };
  return { instance, rows };
}

function maintenance(rows: Map<string, unknown>) {
  rows.set("drain", drain);
  rows.set(permit, { kind: "reconcile" });
}

describe("resident fleet registry", () => {
  it("allows a lower warm count and retained members above a later reduced cap", async () => {
    const members = [resource, "resident-b", "resident-c", "resident-d", "resident-e", "resident-f"];
    const { instance, rows } = registry(
      new Map([
        [
          `resident:${resource}`,
          {
            resource,
            pool: { version: 1, revision: randomUUID(), desired: 6, active: 6, members },
          },
        ],
      ]),
    );
    expect(await instance.requestWarmReplicas(resource, 2)).toMatchObject({
      ok: true,
      record: { pool: { desired: 2, active: 6, members } },
    });
    expect(await instance.requestWarmReplicas(resource, 6)).toMatchObject({
      ok: true,
      record: { pool: { desired: 6, active: 6, members } },
    });
    expect(await instance.requestWarmReplicas(resource, 7)).toMatchObject({ ok: false, status: 400 });
    expect(reservedResidentCount([rows.get(`resident:${resource}`) as any])).toBe(6);
  });

  it("reserves pending members against the cap and activates only after a complete fenced import", async () => {
    const { instance, rows } = registry();
    rows.set("resident:repo:acme/web", { resource: "repo:acme/web" });
    const requested = await instance.requestWarmReplicas(resource, 4);
    expect(requested.ok).toBe(true);
    const { revision, members } = requested.record.pool;
    expect((await instance.list()).map((r: any) => r.residentId ?? r.resource)).toEqual([resource, "repo:acme/web"]);
    expect(await instance.requestWarmReplicas("repo:acme/web", 2)).toMatchObject({ ok: false, status: 429 });
    expect(await instance.resolveThreadPlacement(resource, "mcp:new", [members[1]])).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(
      await instance.importPrimaryPlacements(resource, revision, "reconcile", fence, { done: true, threads: [] }),
    ).toEqual({ ok: false });
    maintenance(rows);
    expect(await instance.replicaMaintenance("reconcile")).toEqual(fence);
    expect(
      await instance.importPrimaryPlacements(resource, revision, "reconcile", fence, {
        after: "thread:mcp:old",
        done: false,
        threads: ["mcp:old"],
      }),
    ).toMatchObject({ ok: true, after: "thread:mcp:old", done: false });
    expect((await instance.list()).length).toBe(2);
    // The caller lost the page reply. A new isolate reads the committed cursor.
    const resumed = registry(rows).instance;
    expect(await resumed.importPrimaryPlacements(resource, revision, "reconcile", fence)).toMatchObject({
      ok: true,
      after: "thread:mcp:old",
      done: false,
    });
    expect(
      await resumed.importPrimaryPlacements(resource, revision, "reconcile", fence, { done: true, threads: [] }),
    ).toEqual({ ok: false });
    expect(
      await resumed.importPrimaryPlacements(resource, revision, "reconcile", fence, {
        startAfter: "thread:mcp:old",
        after: "thread:mcp:old",
        done: true,
        threads: [],
      }),
    ).toMatchObject({ ok: true, done: true });
    expect((await resumed.list()).map((r: any) => r.residentId ?? r.resource)).toEqual([...members, "repo:acme/web"]);
    expect((await resumed.resolveThreadPlacement(resource, "mcp:old", [members[1]])).placement.residentId).toBe(
      resource,
    );
    expect((await resumed.resolveThreadPlacement(resource, "mcp:new", [members[1]])).placement.residentId).toBe(
      members[1],
    );
    await resumed.requestWarmReplicas(resource, 1);
    expect((await resumed.resolveThreadPlacement(resource, "mcp:new", [resource])).placement.residentId).toBe(
      members[1],
    );
    expect((await resumed.resolveThreadPlacement(resource, "mcp:later", members)).placement.residentId).toBe(resource);
  });

  it("restarts enumeration after a fence change and rolls back a conflicting page", async () => {
    const { instance, rows } = registry();
    const {
      record: { pool },
    } = await instance.requestWarmReplicas(resource, 2);
    maintenance(rows);
    await instance.importPrimaryPlacements(resource, pool.revision, "reconcile", fence, {
      after: "thread:mcp:a",
      done: false,
      threads: ["mcp:a"],
    });
    const changed = { ...fence, swapAt: "2026-01-01T00:06:00.000Z" };
    rows.set("drain", { ...drain, ...changed });
    expect(await instance.importPrimaryPlacements(resource, pool.revision, "reconcile", fence)).toEqual({ ok: false });
    expect(await instance.importPrimaryPlacements(resource, pool.revision, "reconcile", changed)).toMatchObject({
      ok: true,
      done: false,
    });
    rows.set(`placement:${JSON.stringify([resource, "mcp:z"])}`, {
      schema: 1,
      resource,
      threadKey: "mcp:z",
      residentId: pool.members[1],
      placementId: randomUUID(),
    });
    await expect(
      instance.importPrimaryPlacements(resource, pool.revision, "reconcile", changed, {
        done: true,
        threads: ["mcp:b", "mcp:z"],
      }),
    ).rejects.toThrow("conflicts with saved placement");
    expect(await instance.readThreadPlacement(resource, "mcp:b")).toBeUndefined();
    expect((await instance.readThreadPlacement(resource, "mcp:a")).residentId).toBe(resource);
    expect((await instance.list()).length).toBe(1);
    rows.set("deploy:admission:other", { kind: "refresh-step" });
    expect(
      await instance.importPrimaryPlacements(resource, pool.revision, "reconcile", changed, {
        done: true,
        threads: [],
      }),
    ).toEqual({ ok: false });
  });

  it("retains offboard catalog and placements until every member has a removal receipt", async () => {
    const { instance, rows } = registry();
    const {
      record: { pool },
    } = await instance.requestWarmReplicas(resource, 2);
    maintenance(rows);
    await instance.importPrimaryPlacements(resource, pool.revision, "reconcile", fence, {
      done: true,
      threads: ["mcp:original"],
    });
    await instance.beginPoolOffboard(resource, pool.revision);
    expect(await instance.resolveThreadPlacement(resource, "mcp:new")).toMatchObject({ ok: false, status: 404 });
    expect(
      await instance.recordPoolRemoval(resource, pool.revision, resource, {
        backupObjectsDeleted: 2,
        r2ObjectsDeleted: 1,
      }),
    ).toBe(true);
    expect(await instance.finishPoolOffboard(resource, pool.revision)).toBe(false);
    const resumed = registry(rows).instance;
    expect((await resumed.readThreadPlacement(resource, "mcp:original")).residentId).toBe(resource);
    expect((await resumed.beginPoolOffboard(resource, pool.revision)).pool.removed).toEqual({
      [resource]: { backupObjectsDeleted: 2, r2ObjectsDeleted: 1 },
    });
    expect(
      await resumed.recordPoolRemoval(resource, pool.revision, pool.members[1], {
        backupObjectsDeleted: 0,
        r2ObjectsDeleted: 3,
      }),
    ).toBe(true);
    expect(await resumed.finishPoolOffboard(resource, pool.revision)).toBe(true);
    expect(await resumed.list()).toEqual([]);
    expect(await resumed.readThreadPlacement(resource, "mcp:original")).toBeUndefined();
  });
});

function handler(name: string) {
  const parsed = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.ES2022, true);
  const node = parsed.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
  return ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

describe("resident fleet lifecycle", () => {
  it("reports active rows separately from pending and retained slot reservations", async () => {
    const pool = {
      version: 1 as const,
      revision: randomUUID(),
      desired: 5,
      active: 1,
      members: [resource, "resident-b", "resident-c", "resident-d", "resident-e"],
    };
    const registered = [
      { resource, pool },
      { resource: "repo:acme/cold", noResident: true },
    ];
    const run = runInNewContext(`${handler("handleResidents")}\nhandleResidents`, {
      residentMembers,
      residentPoolOf,
      residentAddress,
      reservedResidentCount,
      RESIDENT_CAP: 5,
      LRU_FLOOR_S: 3600,
      systemClock: () => 0,
      liveDrain: () => null,
      errMsg: String,
      registryStub: () => ({
        listRepositories: async () => registered,
        limits: async () => ({ cap: 5 }),
        getDrain: async () => null,
        getStagingMaintenanceReadback: async () => null,
      }),
      residentStub: () => ({ getResidentInfo: async () => ({ state: "warm", inFlight: 0 }) }),
      json: (body: unknown) => Response.json(body),
    });
    const pending = await (await run({})).json();
    expect({
      count: pending.count,
      reserved: pending.reservedCount,
      pending: pending.pendingReplicas,
      rows: pending.residents.length,
    }).toEqual({ count: 1, reserved: 5, pending: 4, rows: 1 });
    expect(pending.repositories).toEqual([
      { resource: "repo:acme/cold", noResident: true, live: { state: "cold", reason: "", inFlight: 0 } },
    ]);
    pool.active = 5;
    pool.desired = 1;
    const retained = await (await run({})).json();
    expect({
      count: retained.count,
      reserved: retained.reservedCount,
      pending: retained.pendingReplicas,
      rows: retained.residents.length,
    }).toEqual({ count: 5, reserved: 5, pending: 0, rows: 5 });
  });

  it("discovers saved thread placement and probes unassigned capacity without allocating or moving it", async () => {
    const pool = { version: 1, revision: randomUUID(), desired: 2, active: 2, members: [resource, "resident-b"] };
    const { instance, rows } = registry(new Map([[`resident:${resource}`, { resource, pool }]]));
    let primaryState = "down",
      secondaryState = "warm";
    const logs: string[] = [];
    const run = runInNewContext(
      `${["residentRouteFor", "servingResidentIds", "handleStatus"].map(handler).join("\n")}\nhandleStatus`,
      {
        Response,
        console: { log: (line: string) => logs.push(line) },
        errMsg: (error: Error) => error.message,
        residentText,
        residentRouteOf,
        sameResidentRoute,
        residentMembers,
        residentAddress,
        selectedResidentMember,
        isServiceable,
        parseResource: (value: string) => ({ resource: value }),
        registryStub: () => instance,
        residentStub: (_env: unknown, id: string) => ({
          getStatus: async () => {
            const state = id === resource ? primaryState : secondaryState;
            if (state === "probe-failure") throw new Error("probe failed");
            return { state, reason: id };
          },
          getInFlightCount: async () => 0,
          getRefreshView: async () => ({ lifecycle: "test" }),
          snapshotHandle: async () => null,
          memoryGauge: async () => null,
          residentLevels: async () => ({ seat: { side: "below" }, memory: { side: "below" } }),
        }),
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      },
    );
    const status = async (threadKey: string) =>
      (
        await run({}, new URL(`https://resident.invalid/status?${new URLSearchParams({ resource, threadKey })}`))
      ).json();
    expect(await status("mcp:new")).toMatchObject({ state: "warm", reason: "resident-b" });
    primaryState = "probe-failure";
    expect(await status("mcp:probe-failure")).toMatchObject({ state: "warm", reason: "resident-b" });
    expect(logs).toEqual(["resident-capacity: repo:acme/api member repo:acme/api probe failed: probe failed"]);
    primaryState = "warm";
    secondaryState = "probe-failure";
    expect(await status("mcp:secondary-probe-failure")).toMatchObject({ state: "warm", reason: resource });
    expect(logs).toEqual([
      "resident-capacity: repo:acme/api member repo:acme/api probe failed: probe failed",
      "resident-capacity: repo:acme/api member resident-b probe failed: probe failed",
    ]);
    expect([...rows.keys()]).toEqual([`resident:${resource}`]);
    expect(await instance.resolveThreadPlacement(resource, "mcp:new", ["resident-b"])).toMatchObject({
      ok: true,
      placement: { residentId: "resident-b" },
    });
    const saved = await instance.readThreadPlacement(resource, "mcp:new");
    primaryState = "warm";
    secondaryState = "restoring";
    expect(await status("mcp:new")).toMatchObject({ state: "restoring", reason: "resident-b" });
    expect(await instance.readThreadPlacement(resource, "mcp:new")).toEqual(saved);
    rows.set(`resident:${resource}`, { resource });
    expect(await status("mcp:legacy")).toMatchObject({ state: "warm", reason: resource });
    expect([...rows.keys()].filter((key) => key.startsWith("placement:")).length).toBe(1);
  });

  it("refuses a delayed offboard after its initial pool was removed and replaced", async () => {
    const { instance, rows } = registry();
    const original = (await instance.requestWarmReplicas(resource, 2)).record;
    let readDone!: () => void;
    const read = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    let resumeRead!: () => void;
    const paused = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    const removed: string[] = [];
    const rpc = Object.create(instance);
    rpc.getRepository = async (id: string) => {
      const saved = await instance.getRepository(id);
      readDone();
      await paused;
      return saved;
    };
    const run = runInNewContext(`${handler("handleOffboard")}\nhandleOffboard`, {
      residentMembers,
      residentAddress,
      parseResource: (value: string) => ({ resource: value }),
      registryStub: () => rpc,
      residentStub: (_env: unknown, id: string) => ({
        removePoolMember: async () => {
          removed.push(id);
          return {
            schedulesCancelled: true,
            containerStopped: true,
            storageCleared: true,
            backupObjectsDeleted: 0,
            r2ObjectsDeleted: 0,
            errors: [],
          };
        },
      }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
    const delayed = run({}, { resource });
    await read;
    await instance.beginPoolOffboard(resource, original.pool.revision);
    await instance.recordPoolRemoval(resource, original.pool.revision, resource, {
      backupObjectsDeleted: 0,
      r2ObjectsDeleted: 0,
    });
    expect(await instance.finishPoolOffboard(resource, original.pool.revision)).toBe(true);
    rows.set(`resident:${resource}`, { resource });
    const replacement = (await instance.requestWarmReplicas(resource, 2)).record;
    resumeRead();
    const response = await delayed;
    expect([response.status, await response.json()]).toEqual([409, { error: "resident pool changed before offboard" }]);
    expect(await instance.getRepository(resource)).toEqual(replacement);
    expect(removed).toEqual([]);
  });

  it("imports a large legacy owner page in bounded chunks and replays a lost chunk reply before advancing", async () => {
    const { instance, rows } = registry();
    const {
      record: { pool },
    } = await instance.requestWarmReplicas(resource, 2);
    maintenance(rows);
    let activeRegistry = instance;
    const history = new Map<string, unknown>([
      [
        "resident:spentPoolUsers",
        Array.from({ length: 300 }, (_, i) => ({
          user: `worker${i + 2}`,
          owner: `thread:mcp:legacy${String(i).padStart(3, "0")}`,
        })),
      ],
      ["thread:mcp:evicted", { evicted: true }],
      ["runFence:mcp:fenced", { ownerFence: 3 }],
      ["uid:gen:user:worker700", "thread:mcp:pending"],
    ]);
    const Primary = runInNewContext(
      `${
        ts.transpileModule(`class Primary { ${methodOf(source, "placementHistoryPage")} }`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText
      }\nPrimary`,
      { placementHistoryThreads },
    );
    const primary = new Primary();
    primary.ctx = {
      storage: {
        list: async ({ startAfter, limit }: { startAfter?: string; limit: number }) =>
          new Map(
            [...history]
              .sort(([a], [b]) => a.localeCompare(b))
              .filter(([key]) => !startAfter || key > startAfter)
              .slice(0, limit),
          ),
      },
    };
    const batches: number[] = [];
    let loseReply = true;
    const rpc = {
      listRepositories: () => activeRegistry.listRepositories(),
      list: () => activeRegistry.list(),
      replicaMaintenance: (...args: unknown[]) => activeRegistry.replicaMaintenance(...args),
      importPrimaryPlacements: async (...args: any[]) => {
        if (args[4]) batches.push(args[4].threads.length);
        const answer = await activeRegistry.importPrimaryPlacements(...args);
        if (answer.ok && args[4] && loseReply) {
          loseReply = false;
          throw new Error("chunk reply lost");
        }
        return answer;
      },
    };
    const run = runInNewContext(`${handler("handleReconcile")}\nhandleReconcile`, {
      console,
      residentImageTargetSchema,
      residentPoolOf,
      residentAddress,
      BUILD_ID: "test",
      workerVersionId: () => "new",
      workerVersionTimestamp: () => "stamp",
      beginTrackedDeployAdmission: async () => ({ id: "reconcile" }),
      endTrackedDeployAdmission: async () => {},
      registryStub: () => rpc,
      residentStub: () => ({
        getResidentDeployInfo: async () => ({ executingRuns: 0, unknownRuns: 0 }),
        placementHistoryPage: (after?: string) => primary.placementHistoryPage(after),
        ensureResidentMember: async () => {},
        reconcileForDeploy: async () => ({ result: "current", verified: true }),
      }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
      errMsg: String,
    });
    await expect(run({ RESIDENT_SCRIPT_NAME: "test-resident" }, undefined, imageTarget)).rejects.toThrow(
      "chunk reply lost",
    );
    expect([...rows.keys()].filter((key) => key.startsWith("placement:")).length).toBe(256);
    activeRegistry = registry(rows).instance;
    const progress = await activeRegistry.importPrimaryPlacements(resource, pool.revision, "reconcile", fence);
    expect({
      after: progress.after,
      done: progress.done,
      active: (rows.get(`resident:${resource}`) as any).pool.active,
    }).toEqual({ after: undefined, done: false, active: 1 });
    const saved = await activeRegistry.readThreadPlacement(resource, "mcp:evicted");
    expect(await (await run({ RESIDENT_SCRIPT_NAME: "test-resident" }, undefined, imageTarget)).json()).toEqual({
      imageTarget,
      reconciled: pool.members.map((residentId: string) => ({
        resource,
        residentId,
        result: "current",
        verified: true,
      })),
    });
    expect(batches).toEqual([256, 256, 47]);
    expect(await activeRegistry.readThreadPlacement(resource, "mcp:evicted")).toEqual(saved);
    const placements = [...rows.entries()]
      .filter(([key]) => key.startsWith("placement:"))
      .map(([, value]) => value as any);
    expect(placements.map((row) => row.threadKey).sort()).toEqual([
      "mcp:evicted",
      "mcp:fenced",
      ...Array.from({ length: 300 }, (_, i) => `mcp:legacy${String(i).padStart(3, "0")}`),
      "mcp:pending",
    ]);
    expect([...new Set(placements.map((row) => row.residentId))]).toEqual([resource]);
    expect(await activeRegistry.importPrimaryPlacements(resource, pool.revision, "reconcile", fence)).toMatchObject({
      ok: true,
      after: "uid:gen:user:worker700",
      done: true,
    });
  });

  it("keeps desired members on the warm cadence while excess idle members can park", async () => {
    const pool = {
      version: 1 as const,
      revision: randomUUID(),
      desired: 1,
      active: 2,
      members: [resource, "resident-b"],
    };
    const record = { resource, pool };
    const facts = { idleSince: "previous-idle" };
    const compiled = ts.transpileModule(`class Resident { ${methodOf(source, "refreshGate")} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Resident = runInNewContext(`${compiled}\nResident`, {
      residentPoolOf,
      FACTS_KEY: "facts",
      DEGRADED_STREAK_KEY: "streak",
      systemClock: () => 0,
    });
    const run = async (id: string) => {
      const instance = new Resident();
      let saved: unknown = facts;
      instance.ctx = {
        storage: {
          get: async () => saved,
          delete: async () => {},
          put: async (_key: string, value: unknown) => {
            saved = value;
          },
        },
      };
      instance.ensureHydrated = async () => {};
      instance.registry = () => ({ getRecord: async () => record });
      instance.reconcileImage = async () => "current";
      instance.getStatus = async () => ({ state: "warm", reason: "" });
      instance.residentIdentity = async () => id;
      instance.isIdle = async () => true;
      return { result: await instance.refreshGate(resource), saved };
    };
    expect(await run(resource)).toEqual({ result: { go: true, record, facts }, saved: {} });
    expect(await run("resident-b")).toEqual({ result: { go: false, why: "idle" }, saved: facts });
  });
  it("serializes offboard retries and rejects an old removal after the primary is onboarded again", async () => {
    const revision = randomUUID();
    let catalog: any = {
      resource,
      offboarding: true,
      pool: { version: 1, revision, desired: 1, active: 1, members: [resource] },
    };
    let destroyed = 0;
    let releaseRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const compiled = ts.transpileModule(`class Resident { ${methodOf(source, "removePoolMember")} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Resident = runInNewContext(`${compiled}\nResident`, {
      residentPoolOf,
      errMsg: String,
      teardownResident: async () => {
        destroyed++;
        return {
          schedulesCancelled: true,
          containerStopped: true,
          storageCleared: true,
          backupObjectsDeleted: 0,
          r2ObjectsDeleted: 0,
          errors: [],
        };
      },
    });
    const instance = new Resident();
    instance.env = {};
    instance.recreateAdmission = new ResidentRecreateAdmission({
      mark: async () => {},
      clear: async () => {},
      held: async () => false,
    });
    instance.registry = () => ({
      getRepository: async () => {
        await pendingRead;
        return catalog;
      },
      recordPoolRemoval: async () => true,
    });
    instance.prepareMemberRemoval = async () => {};
    instance.confirmCleanup = async () => {};
    const original = instance.removePoolMember(resource, resource, revision);
    expect(await instance.removePoolMember(resource, resource, revision)).toMatchObject({
      containerStopped: false,
      errors: ["resident removal is already in progress"],
    });
    releaseRead();
    expect(await original).toMatchObject({ containerStopped: true, errors: [] });
    catalog = { resource };
    expect(await instance.removePoolMember(resource, resource, revision)).toMatchObject({
      containerStopped: false,
      errors: ["resident removal catalog changed"],
    });
    expect(destroyed).toBe(1);
  });
  it("reconciles siblings separately and holds the exact unverified member", async () => {
    const pool = {
      version: 1 as const,
      revision: randomUUID(),
      desired: 3,
      active: 3,
      members: [resource, "resident-b", "resident-c"],
    };
    let held: string[] = [];
    const admitted: unknown[] = [];
    const registry = {
      listRepositories: async () => [{ resource, pool }],
      list: async () => residentMembers([{ resource, pool }]),
      holdDrainFor: async (ids: string[]) => {
        held = ids;
      },
    };
    const run = runInNewContext(`${handler("handleReconcile")}\nhandleReconcile`, {
      console,
      residentImageTargetSchema,
      residentPoolOf,
      residentAddress,
      BUILD_ID: "test",
      workerVersionId: () => "new",
      workerVersionTimestamp: () => "stamp",
      beginTrackedDeployAdmission: async (_registry: unknown, origin: unknown, version: unknown) => {
        admitted.push({ origin, version });
        return { id: "reconcile" };
      },
      endTrackedDeployAdmission: async () => {},
      registryStub: () => registry,
      residentStub: (_env: unknown, id: string) => ({
        ensureResidentMember: async () => {},
        reconcileForDeploy: async () => {
          if (id === "resident-c") throw new Error("reconcile failed");
          return { result: id === resource ? "current" : "deferred", verified: id === resource };
        },
      }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
      errMsg: String,
    });
    expect(await (await run({ RESIDENT_SCRIPT_NAME: "test-resident" }, undefined, imageTarget)).json()).toEqual({
      imageTarget,
      reconciled: [
        { resource, residentId: resource, result: "current", verified: true },
        { resource, residentId: "resident-b", result: "deferred", verified: false },
        { resource, residentId: "resident-c", result: "error", verified: false, error: "Error: reconcile failed" },
      ],
    });
    expect(held).toEqual(["resident-b", "resident-c"]);
    expect(admitted).toEqual([
      {
        origin: { kind: "reconcile", component: "http", build: "test", workerVersion: "new" },
        version: { versionId: "new", versionTimestamp: "stamp" },
      },
    ]);
  });

  it("requires a member for native recovery and retains its original journal selector", async () => {
    const pool = {
      version: 1 as const,
      revision: randomUUID(),
      desired: 2,
      active: 2,
      members: [resource, "resident-b"],
    };
    const run = runInNewContext(`${handler("handleRecoverNativeOperation")}\nhandleRecoverNativeOperation`, {
      selectedResidentMember,
      parseResource: () => ({ resource }),
      validNativeOperationKey: (key: string) => key === "original-key",
      registryStub: () => ({ getRepository: async () => ({ resource, pool }) }),
      residentStub: (_env: unknown, id: string) => ({
        recoverNativeOperation: async (key: string, hash: string, terminate: boolean) => ({ id, key, hash, terminate }),
      }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
    const body = { resource, key: "original-key", recordHash: "a".repeat(64), terminate: true };
    expect((await run({}, body)).status).toBe(409);
    expect(await (await run({}, { ...body, resident: 2 })).json()).toEqual({
      id: "resident-b",
      key: "original-key",
      hash: "a".repeat(64),
      terminate: true,
    });
  });

  it("routes workload inspection to the selected member and rejects raw placement fields", async () => {
    let catalog: any = {
      resource,
      pool: { version: 1, revision: randomUUID(), desired: 2, active: 2, members: [resource, "resident-b"] },
    };
    const run = runInNewContext(`${handler("handleDebug")}\nhandleDebug`, {
      selectedResidentMember,
      parseResource: () => ({ resource }),
      registryStub: () => ({ getRepository: async () => catalog }),
      residentStub: (_env: unknown, id: string) => ({
        getWorkloadAudit: async (logical: string, expected: string) => ({
          resource: logical,
          residentId: id,
          expected,
          used: id === resource ? 1 : 2,
        }),
      }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
    const body = { resource, op: "workload-audit" };
    expect(await (await run({}, { ...body, resident: 2 })).json()).toEqual({
      resource,
      residentId: "resident-b",
      expected: "resident-b",
      used: 2,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => run({}, JSON.parse(String(init?.body))));
    try {
      expect(await makeResidentAdminClient("https://resident.invalid", "fixture").workload(resource)).toEqual({
        status: 200,
        data: { resource, residentId: resource, expected: resource, used: 1 },
      });
    } finally {
      fetch.mockRestore();
    }
    expect((await run({}, { ...body, op: "info" })).status).toBe(409);
    for (const invalid of [{ residentId: "forged" }, { placementId: randomUUID() }]) {
      const refused = await run({}, { ...body, resident: 2, ...invalid });
      expect([refused.status, await refused.json()]).toEqual([
        400,
        { error: "Workload inspection uses resident numbers, not thread placement IDs." },
      ]);
    }
    catalog = { resource };
    expect(await (await run({}, body)).json()).toEqual({ resource, residentId: resource, expected: resource, used: 1 });
  });

  it("keeps a retired address closed to a stale watchdog after cleanup", async () => {
    const compiled = ts.transpileModule(
      `class Resident { ${["initResident", "ensureResidentMember", "prepareMemberRemoval", "confirmCleanup"].map((m) => methodOf(source, m)).join("\n")} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const objects = new Map([
      [resource, 4],
      ["resident-b", 1],
    ]);
    const Resident = runInNewContext(`${compiled}\nResident`, {
      RESOURCE_KEY: "resource",
      RESIDENT_ID_KEY: "id",
      RESIDENT_RETIRED_KEY: "retired",
      CLEANUP_PENDING_KEY: "cleanup",
      DESTROY_UNCONFIRMED_KEY: "destroy",
      SNAPSHOT_KEY: "snapshot",
      FACTS_KEY: "facts",
      RETIRED_SNAPSHOT_KEY: "retired-snapshot",
      STATE_KEY: "state",
      REASON_KEY: "reason",
      UPDATED_KEY: "updated",
      DEADLINE_AT_KEY: "deadline",
      PROVISIONING_CALLBACK: "deadline-callback",
      PROVISION_RUN_CALLBACK: "provision-callback",
      systemClock: () => 0,
      countR2Prefix: async (_bucket: unknown, id: string) => objects.get(id) ?? 0,
      r2Prefix: (id: string) => id,
    });
    const rows = new Map<string, unknown>([
      ["facts", { old: true }],
      ["snapshot", { checkout: { id: "current-old" } }],
      ["retired-snapshot", { checkout: { id: "retired-old" } }],
    ]);
    const storage = {
      get: async (key: string) => rows.get(key),
      put: async (values: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(values)) rows.set(k, v);
      },
      delete: async (keys: string | string[]) => {
        for (const key of typeof keys === "string" ? [keys] : keys) rows.delete(key);
      },
    };
    const create = () => {
      const instance = new Resident();
      instance.ctx = { storage: { ...storage, transaction: async (fn: any) => fn(storage) } };
      instance.env = { BACKUP_BUCKET: {} };
      instance.recordedBackupIds = async () => [];
      instance.allDepsBackups = async () => [];
      instance.rebuildPoolBindingIndex = async () => {};
      instance.deleteSchedules = () => {};
      instance.schedule = async () => {};
      return instance;
    };
    await create().ensureResidentMember(resource, "resident-b", 300000);
    expect([...rows]).toEqual([
      ["resource", resource],
      ["id", "resident-b"],
      ["state", "onboarding"],
      ["reason", ""],
      ["updated", "1970-01-01T00:00:00.000Z"],
      ["deadline", 300000],
    ]);
    await create().prepareMemberRemoval(resource, "resident-b");
    // Confirmed teardown keeps only address, retirement and cleanup evidence.
    for (const key of rows.keys()) if (!["id", "retired", "cleanup"].includes(key)) rows.delete(key);
    await expect(create().confirmCleanup(resource)).rejects.toThrow("cleanup-unconfirmed");
    objects.delete("resident-b");
    await create().confirmCleanup(resource);
    expect([...rows]).toEqual([
      ["id", "resident-b"],
      ["retired", true],
    ]);
    await expect(create().ensureResidentMember(resource, "resident-b", 300000)).rejects.toThrow("member is retired");
    expect(rows.has("resource")).toBe(false);
  });
});
