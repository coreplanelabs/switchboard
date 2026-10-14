import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { registerRepository, residentRecords } from "../../src/execution/repoRegistration";
import { recordResidentPlacement } from "../../src/execution/residentPlacement";
import { effectiveLimits } from "./gc";
import { methodOf, readSource } from "./testing/sourceScan";

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
      `${cap}\nclass Registry { ${["onboard", "limits", "list", "listRepositories"].map((name) => methodOf(source, name)).join("\n")} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const Registry = runInNewContext(`${compiled}\nRegistry`, {
      registerRepository,
      residentRecords,
      REGISTRY_KEY_PREFIX: "resident:",
      effectiveLimits,
      TEST_OVERRIDES_KEY: "overrides",
      BUILD_ID: "test-build",
      LRU_FLOOR_S: 3600,
    });
    const rows = new Map<string, any>();
    const instance = new Registry();
    instance.ctx = {
      storage: {
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
    expect(methodOf(source, "list")).toContain("residentRecords(await this.listRepositories())");
    expect(methodOf(source, "getRecord")).toContain("record?.noResident === true ? null : record");
    expect(handler("runWatchdog")).toContain("await registry.list()");
    expect(handler("handleDeployFence")).toContain("await registry.list()");
    const listing = handler("handleResidents");
    expect(listing).toContain("const residents = residentRecords(registered)");
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
    const compiled = ts.transpileModule(`class Registry { ${methodOf(source, "resolveThreadPlacement")} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Registry = runInNewContext(`${compiled}\nRegistry`, {
      registryKey: (value: string) => `resident:${value}`,
      recordResidentPlacement,
      crypto: { randomUUID: () => placementId },
    });
    const instance = new Registry();
    let tail = Promise.resolve();
    const port = {
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => {
        rows.set(key, structuredClone(value));
      },
    };
    instance.ctx = {
      storage: {
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
    expect(await instance.resolveThreadPlacement(resource, threadKey)).toEqual({
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
    const routeSource = ts.transpileModule(handler("resolveThreadRoute"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    // Exercise the existing route with both the old lookup and new placement
    // RPC available: the baseline can route but fails the durable-row check.
    const route = runInNewContext(`${routeSource}\nresolveThreadRoute`, {
      parseResource: (value: string) => ({ resource: value }),
      parseThreadKey: (value: string) => ({ threadKey: value }),
      registryStub: () => ({
        ...instance,
        getRecord: async () => record,
        resolveThreadPlacement: instance.resolveThreadPlacement.bind(instance),
      }),
      residentStub: (_env: unknown, id: string) => ({ destination: id }),
      json: (body: unknown, status: number) => ({ body, status }),
    });
    expect(await route({}, { resource, threadKey }, true)).toEqual({
      stub: { destination: resource },
      resource,
      threadKey,
      record,
    });
    expect([...rows.values()]).toEqual([record, { schema: 1, resource, threadKey, residentId: resource, placementId }]);
    instance.ctx.storage.transaction = async () => {
      throw new Error("storage reply lost");
    };
    await expect(route({}, { resource, threadKey }, true)).rejects.toThrow("storage reply lost");
  });
});
