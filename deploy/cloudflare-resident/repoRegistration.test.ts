import {
  residentMembers,
  residentPoolOf,
  reservedResidentCount,
  planResidentPool,
} from "../../src/execution/residentMembers";
import { residentRouteOf, sameResidentRoute } from "../../src/execution/residentRoute";
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { registerRepository, residentRecords } from "../../src/execution/repoRegistration";
import { readResidentPlacement, recordResidentPlacement } from "../../src/execution/residentPlacement";
import { effectiveLimits } from "./gc";
import { methodOf, readSource } from "./testing/sourceScan";
import { readStagingEpisode } from "./stagingEpisodes.js";
import { TEST_MAINTENANCE } from "../../src/deploy/testing/profile.js";

const source = readSource("worker.ts");
const handler = (name: string) => {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("metadata-only repo routes", () => {
  it("admits five residents, refuses a sixth, accepts cold metadata, and preserves existing residents above the cap", async () => {
    const cap = source.match(/^const RESIDENT_CAP = [^;]+;/m)?.[0];
    if (!cap) throw new Error("resident cap declaration missing");
    const compiled = ts.transpileModule(
      `${cap}\nclass Registry { ${["onboard", "limits", "list", "listRepositories", "getRecord", "getRepository", "getStagingMaintenance"].map((name) => methodOf(source, name)).join("\n")} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const Registry = runInNewContext(`${compiled}\nRegistry`, {
      registerRepository,
      residentRecords,
      residentMembers,
      registryKey: (value: string) => `resident:${value}`,
      REGISTRY_KEY_PREFIX: "resident:",
      effectiveLimits,
      TEST_OVERRIDES_KEY: "overrides",
      BUILD_ID: "test-build",
      LRU_FLOOR_S: 3600,
      readStagingEpisode,
    });
    const rows = new Map<string, any>();
    const instance = new Registry();
    instance.ctx = {
      storage: {
        transaction: (body: (store: unknown) => Promise<unknown>) => body(instance.ctx.storage),
        get: async (key: string) => rows.get(key),
        put: async (key: string, record: unknown) => rows.set(key, record),
        list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      },
    };
    for (let i = 1; i <= 5; i++) {
      const record = { resource: `repo:acme/repo-${i}` };
      expect(await instance.onboard(record)).toEqual({ ok: true, record });
    }
    expect(await instance.onboard({ resource: "repo:acme/overflow" })).toEqual({
      ok: false,
      status: 429,
      error: "resident cap reached (5/5); offboard a resident first, or onboard with evictColdest:true to make room",
    });
    expect(await instance.onboard({ resource: "repo:acme/cold", noResident: true })).toEqual({
      ok: true,
      record: { resource: "repo:acme/cold", noResident: true },
    });

    expect(await instance.getRecord("repo:acme/cold")).toBeNull();
    expect(await instance.getRecord("repo:acme/repo-1")).toEqual({ resource: "repo:acme/repo-1" });

    // A previous build may have admitted more residents than the current cap.
    rows.set("resident:repo:acme/repo-6", { resource: "repo:acme/repo-6" });
    expect(await instance.onboard({ resource: "repo:acme/overflow-after-upgrade" })).toEqual({
      ok: false,
      status: 429,
      error: "resident cap reached (6/5); offboard a resident first, or onboard with evictColdest:true to make room",
    });
    expect(await instance.list()).toEqual([
      { resource: "repo:acme/repo-1" },
      { resource: "repo:acme/repo-2" },
      { resource: "repo:acme/repo-3" },
      { resource: "repo:acme/repo-4" },
      { resource: "repo:acme/repo-5" },
      { resource: "repo:acme/repo-6" },
    ]);
    instance.env = {
      CLOUDFLARE_ACCOUNT_ID: TEST_MAINTENANCE.stagingAccount,
      RESIDENT_SCRIPT_NAME: TEST_MAINTENANCE.residentScript,
    };
    rows.set("deploy:staging-maintenance", { schema: 1, state: "held", installedAt: 0, policy: TEST_MAINTENANCE });
    expect(await instance.onboard({ resource: "repo:acme/new-cold", noResident: true })).toEqual({
      ok: false,
      status: 409,
      error: "staging maintenance blocks registration",
    });
    expect(rows.has("resident:repo:acme/new-cold")).toBe(false);
  });

  it("checks registration before status touches a resident and skips provisioning for cold onboarding", () => {
    const status = handler("handleStatus");
    expect(status.indexOf('state: "cold"')).toBeLessThan(status.indexOf("residentStub(env"));
    const onboard = handler("handleOnboard");
    expect(onboard.indexOf("mintRepoScopedToken")).toBeLessThan(onboard.indexOf("registry.onboard"));
    expect(onboard.indexOf('state: "cold"')).toBeLessThan(onboard.indexOf(".initResident("));
    expect(onboard).toContain('typeof body.noResident !== "boolean"');
  });

  it("fleet enumerations and resident-only routes exclude cold entries", () => {
    expect(handler("runWatchdog")).toContain("await registry.list()");
    expect(handler("handleDeployFence")).toContain("await registry.list()");
    const listing = handler("handleResidents");
    expect(listing).toContain("residents.map((record) => residentStub");
    expect(listing).toContain("repositories: registered");
  });

  it("offboards cold metadata before the resident teardown path", () => {
    const offboard = handler("handleOffboard");
    const cold = offboard.slice(offboard.indexOf("if (record?.noResident === true)"), offboard.indexOf("// --dry-run"));
    expect(cold).toContain("registry.remove(record.resource)");
    expect(cold).toContain("body.dryRun === true");
    expect(cold).not.toContain("residentStub");
    expect(cold).not.toContain("BACKUP_BUCKET");
  });
});

describe("primary resident placement", () => {
  const resource = "repo:acme/api";
  const threadKey = "mcp:default:review-a";
  const record = { resource, defaultRef: "main" };
  const placementId = "cf5c0a88-820b-45f2-b689-4432d93fbdce";

  function registry(rows = new Map<string, unknown>([[`resident:${resource}`, record]])) {
    const compiled = ts.transpileModule(
      `class Registry { ${methodOf(source, "resolveThreadPlacement")} ${methodOf(source, "readThreadPlacement")} ${methodOf(source, "requestWarmReplicas")} }`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
    let uuid = 0;
    const Registry = runInNewContext(`${compiled}\nRegistry`, {
      residentPoolOf,
      reservedResidentCount,
      planResidentPool,
      effectiveLimits,
      RESIDENT_CAP: 5,
      LRU_FLOOR_S: 3600,
      TEST_OVERRIDES_KEY: "overrides",
      BUILD_ID: "test",
      REGISTRY_KEY_PREFIX: "resident:",
      systemClock: () => 0,
      registryKey: (value: string) => `resident:${value}`,
      recordResidentPlacement,
      readResidentPlacement,
      crypto: {
        randomUUID: () => (uuid++ === 0 ? placementId : `aaaaaaaa-aaaa-4aaa-aaaa-${String(uuid).padStart(12, "0")}`),
      },
    });
    const instance = new Registry();
    let tail = Promise.resolve();
    const port = {
      list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => {
        rows.set(key, structuredClone(value));
      },
    };
    instance.ctx = {
      storage: {
        ...port,
        transaction: (body: (txn: typeof port) => Promise<unknown>) => {
          const result = tail.then(() => body(port));
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

  function threadRoute(instance: any) {
    const routeSource = ts.transpileModule(`${handler("residentRouteFor")}\n${handler("resolveThreadRoute")}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    // Exercise the existing route with both the old lookup and new placement
    // RPC available: the baseline can route but fails the durable-row check.
    return runInNewContext(`${routeSource}\nresolveThreadRoute`, {
      Response,
      residentRouteOf,
      sameResidentRoute,
      parseResource: (value: string) => ({ resource: value }),
      parseThreadKey: (value: string) => ({ threadKey: value }),
      registryStub: () => ({
        ...instance,
        getRecord: async () => record,
        resolveThreadPlacement: instance.resolveThreadPlacement.bind(instance),
        readThreadPlacement: instance.readThreadPlacement.bind(instance),
      }),
      residentStub: (_env: unknown, id: string) => ({ destination: id }),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
  }

  it("concurrent requests and a new registry instance recover one primary placement", async () => {
    const { instance, rows } = registry();
    const expected = {
      ok: true,
      record,
      placement: { schema: 1, resource, threadKey, residentId: resource, placementId },
    };
    expect(
      await Promise.all([
        instance.resolveThreadPlacement(resource, threadKey),
        instance.resolveThreadPlacement(resource, threadKey),
      ]),
    ).toEqual([expected, expected]);
    expect(await registry(rows).instance.resolveThreadPlacement(resource, threadKey)).toEqual(expected);
    expect([...rows.values()]).toEqual([record, expected.placement]);
  });

  it("refuses missing and cold repositories while a warm repository can still attach", async () => {
    const { instance, rows } = registry();
    for (const noResident of [undefined, true]) {
      if (noResident) rows.set(`resident:${resource}`, { ...record, noResident });
      else rows.delete(`resident:${resource}`);
      expect(await instance.resolveThreadPlacement(resource, threadKey)).toEqual({
        ok: false,
        status: 404,
        error: "repo:acme/api is not onboarded",
      });
    }
    rows.set(`resident:${resource}`, record);
    expect(await registry(rows).instance.resolveThreadPlacement(resource, threadKey)).toEqual({
      ok: true,
      record,
      placement: { schema: 1, resource, threadKey, residentId: resource, placementId },
    });
  });

  it("refuses an unsupported saved replica instead of routing to the primary", async () => {
    const { instance, rows } = registry();
    await instance.resolveThreadPlacement(resource, threadKey);
    const key = [...rows.keys()].find((value) => value.startsWith("placement:"))!;
    const placement = { schema: 1, resource, threadKey, residentId: "replica-b", placementId };
    rows.set(key, placement);
    expect(await instance.resolveThreadPlacement(resource, threadKey)).toEqual({
      ok: false,
      status: 503,
      error: "resident placement could not be verified",
    });
    expect(rows.get(key)).toEqual(placement);
  });

  it("routes attach only after primary placement commits and stops on a lost storage reply", async () => {
    const { instance, rows } = registry();
    const route = threadRoute(instance);
    expect(await route({}, { resource, threadKey }, true)).toEqual({
      stub: { destination: resource },
      resource,
      threadKey,
      record,
      placement: { schema: 1, resource, threadKey, residentId: resource, placementId },
    });
    expect([...rows.values()]).toEqual([record, { schema: 1, resource, threadKey, residentId: resource, placementId }]);
    instance.ctx.storage.transaction = async () => {
      throw new Error("storage reply lost");
    };
    await expect(route({}, { resource, threadKey }, true)).rejects.toThrow("storage reply lost");
  });

  it("a data route honors only the exact saved replica and leaves legacy traffic on the primary", async () => {
    const { instance, rows } = registry();
    await instance.resolveThreadPlacement(resource, threadKey);
    const key = [...rows.keys()].find((value) => value.startsWith("placement:"))!;
    const saved = { schema: 1, resource, threadKey, residentId: "replica-b", placementId };
    rows.set(key, saved);
    const route = threadRoute(instance);
    expect(await route({}, { resource, threadKey, residentId: "replica-b", placementId })).toEqual({
      stub: { destination: "replica-b" },
      resource,
      threadKey,
    });
    const unaddressed = await route({}, { resource, threadKey });
    expect(unaddressed.status).toBe(409);
    expect(await unaddressed.json()).toEqual({ error: "the saved workspace requires its resident address" });
    expect(await route({}, { resource, threadKey: "mcp:default:legacy" })).toEqual({
      stub: { destination: resource },
      resource,
      threadKey: "mcp:default:legacy",
    });
    const denied = await route({}, { resource, threadKey, residentId: "replica-c", placementId });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "resident address does not match the saved placement" });
    expect(await instance.readThreadPlacement(resource, threadKey)).toEqual(saved);
  });

  it("reserves pool capacity atomically and reuses addresses after a lost configuration reply", async () => {
    const { instance, rows } = registry();
    rows.set("resident:repo:acme/other", { resource: "repo:acme/other" });
    const result = await instance.requestWarmReplicas(resource, 4);
    expect(result).toMatchObject({
      ok: true,
      record: {
        pool: {
          desired: 4,
          active: 1,
          members: [
            resource,
            "resident-aaaaaaaa-aaaa-4aaa-aaaa-000000000002",
            "resident-aaaaaaaa-aaaa-4aaa-aaaa-000000000003",
            "resident-aaaaaaaa-aaaa-4aaa-aaaa-000000000004",
          ],
        },
      },
    });
    expect(await registry(rows).instance.requestWarmReplicas(resource, 4)).toEqual(result);
    expect(await instance.requestWarmReplicas(resource, 5)).toEqual({
      ok: false,
      status: 429,
      error: "resident capacity is already reserved",
    });
    expect(reservedResidentCount([...rows.values()] as any)).toBe(5);
  });
});
