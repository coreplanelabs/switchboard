import { selectedResidentMember } from "../../src/execution/residentMembers";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ResidentRecreateAdmission } from "../../src/execution/residentRecreateAdmission.js";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const resource = "repo:acme/api";

describe("durable full cleanup hold", () => {
  it("survives ordinary lifecycle state changes and refuses hydration, execution and provisioning after restart", async () => {
    const parsed = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.ES2022, true);
    const cls = parsed.statements.find(
      (node) => ts.isClassDeclaration(node) && node.name?.text === "ResidentDO",
    ) as ts.ClassDeclaration;
    const methods = ["getStatus", "ensureHydrated", "run", "initResident", "confirmCleanup"].map((name) =>
      cls.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name)!.getText(parsed),
    );
    const compiled = ts.transpileModule(`class Resident { ${methods.join("\n")} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let prefixObjects = 1;
    const Resident = runInNewContext(`${compiled}\nResident`, {
      STATE_KEY: "state",
      REASON_KEY: "reason",
      DESTROY_UNCONFIRMED_KEY: "destroy",
      CLEANUP_PENDING_KEY: "cleanup",
      RESIDENT_ID_KEY: "resident:instanceId",
      RESIDENT_RETIRED_KEY: "member-retired",
      ResidentDownError: Error,
      SNAPSHOT_KEY: "snapshot",
      countR2Prefix: async () => prefixObjects,
      r2Prefix: (target: string) => `resident/${target}/`,
    });
    const rows = new Map<string, unknown>([
      ["cleanup", resource],
      ["state", "warm"],
      ["reason", "no-snapshot"],
    ]);
    for (const state of ["warm", "restoring", "degraded", "down"]) {
      rows.set("state", state);
      const instance = new Resident();
      instance.ctx = {
        storage: {
          get: async (key: string | string[]) =>
            Array.isArray(key) ? new Map(key.filter((k) => rows.has(k)).map((k) => [k, rows.get(k)])) : rows.get(key),
        },
      };
      expect(await instance.getStatus()).toEqual({
        state: "down",
        reason: "full-rebuild-cleanup-incomplete: cleanup is still pending",
      });
      await expect(instance.ensureHydrated()).rejects.toThrow(
        "full-rebuild-cleanup-incomplete: hydration is paused until cleanup completes",
      );
      await expect(instance.run(["node", "--version"])).rejects.toThrow(
        "full-rebuild-cleanup-incomplete: runtime work is paused until cleanup completes",
      );
      await expect(instance.initResident(resource, 300000, true)).rejects.toThrow(
        "full-rebuild-cleanup-incomplete: provisioning is paused until cleanup completes",
      );
      expect(rows.get("cleanup")).toBe("repo:acme/api");
    }
    const confirmation = new Resident();
    confirmation.ctx = {
      storage: { get: async (key: string) => rows.get(key), delete: async (key: string) => rows.delete(key) },
    };
    confirmation.env = { BACKUP_BUCKET: {} };
    confirmation.recordedBackupIds = async () => [];
    confirmation.allDepsBackups = async () => [];
    await expect(confirmation.confirmCleanup(resource)).rejects.toThrow("resident-cleanup-unconfirmed");
    expect(rows.get("cleanup")).toBe("repo:acme/api");
    prefixObjects = 0;
    await confirmation.confirmCleanup(resource);
    expect(rows.has("cleanup")).toBe(false);
  });
});

describe("offboard pending cleanup recovery", () => {
  it("retries prefix cleanup after registry and resource removal, including restart", async () => {
    const parsed = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.ES2022, true);
    const functions = ["handleOffboard", "offboardResident", "teardownResident"].map((name) =>
      parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(parsed),
    );
    let registered = true;
    let info = { resource: resource as string | null, cleanupPending: null as string | null };
    let objects = 1;
    let failSweep = true;
    const registry = {
      getRepository: async () => (registered ? { resource } : null),
      remove: async () => {
        const removed = registered;
        registered = false;
        return removed;
      },
    };
    // Fresh RPC stubs share durable state; no isolate memo can enable retry.
    const stub = () => ({
      getResidentInfo: async () => ({ ...info }),
      teardownPlan: async () => ({
        state: "down",
        schedules: 0,
        snapshotBackupIds: [],
        backupObjects: 0,
        threadBindings: 0,
      }),
      teardown: async () => {
        info = { resource: null, cleanupPending: resource };
        return {
          schedulesCancelled: true,
          containerStopped: true,
          storageCleared: true,
          backupObjectsDeleted: 0,
          errors: [],
        };
      },
      confirmCleanup: async () => {
        if (objects) throw new Error("resident-cleanup-unconfirmed");
        info.cleanupPending = null;
      },
    });
    const compiled = ts.transpileModule(functions.join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const handle = runInNewContext(`${compiled}\nhandleOffboard`, {
      registryStub: () => registry,
      residentStub: stub,
      parseResource: (value: string) => ({ resource: value }),
      r2Prefix: (target: string) => `resident/${target}/`,
      countR2Prefix: async () => objects,
      deleteR2Prefix: async () => {
        if (failSweep) throw new Error("R2 unavailable");
        const removed = objects;
        objects = 0;
        return removed;
      },
      errMsg: (err: Error) => err.message,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    });
    const env = { BACKUP_BUCKET: {} };
    expect(await (await handle(env, { resource })).json()).toMatchObject({
      registryRemoved: true,
      errors: ["r2 prefix sweep failed for resident/repo:acme/api/: R2 unavailable"],
    });
    expect(info).toEqual({ resource: null, cleanupPending: "repo:acme/api" });
    expect(await (await handle(env, { resource, dryRun: true })).json()).toMatchObject({
      dryRun: true,
      wouldRemove: { r2Objects: 1 },
    });
    failSweep = false;
    const retry = await handle(env, { resource });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ registryRemoved: false, r2ObjectsDeleted: 1, errors: [] });
    expect(info).toEqual({ resource: null, cleanupPending: null });
    for (const pending of [null, "repo:acme/other"]) {
      info.cleanupPending = pending;
      const refused = await handle(env, { resource });
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: "repo:acme/api is not onboarded" });
    }
  });
});

describe("full rebuild backup cleanup", () => {
  it("keeps a replacement dependency handle written while the old backup is being deleted", async () => {
    const compiled = ts.transpileModule(`class Resident { ${methodOf(source, "dropDepsBackups")} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Resident = runInNewContext(`${compiled}\nResident`, { depsBackupStorageKey: (key: string) => `deps:${key}` });
    const resident = new Resident();
    const original = { key: "entry", backup: { id: "old-backup" } };
    const replacement = { key: "entry", backup: { id: "new-backup" } };
    let row: unknown = original;
    const storage = {
      get: async () => row,
      delete: async () => {
        row = undefined;
      },
    };
    resident.ctx = {
      storage: {
        get: async () => new Map([["deps:entry", original]]),
        transaction: async (action: any) => action(storage),
      },
    };
    resident.deleteBackupObjects = async () => {
      row = replacement;
      return 1;
    };
    expect(await resident.dropDepsBackups(["entry"])).toBe(1);
    expect(row).toEqual({ key: "entry", backup: { id: "new-backup" } });
  });

  it.each([
    ["s1", 4],
    ["r1", 2],
    ["d1", 1],
  ] as const)(
    "retains failed %s cleanup across restart until the original backups are deleted",
    async (failedId, remaining) => {
      const rows = new Map<string, any>([
        ["snapshot", { mirror: { id: "s1" }, checkout: { id: "s2" } }],
        ["retired", { mirror: { id: "r1" }, checkout: { id: "r2" } }],
        ["deps:entry", { key: "entry", backup: { id: "d1" } }],
        ["state", "warm"],
        ["resource", resource],
        ["native-operation:old", "original-outcome-unknown"],
      ]);
      const objects = new Set(["s1", "s2", "r1", "r2", "d1"]);
      let failing: string | undefined = failedId;
      const parsed = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.ES2022, true);
      const cls = parsed.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === "ResidentDO",
      ) as ts.ClassDeclaration;
      const methods = [
        "teardown",
        "teardownPlan",
        "dropDepsBackups",
        "confirmCleanup",
        "rebuild",
        "withRecreateSafeAdmin",
        "recreateRefusal",
      ].map((name) =>
        cls.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name)!.getText(parsed),
      );
      const compiled = ts.transpileModule(`class Resident { ${methods.join("\n")} }`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const Resident = runInNewContext(`${compiled}\nResident`, {
        SNAPSHOT_KEY: "snapshot",
        RESOURCE_KEY: "resource",
        CLEANUP_PENDING_KEY: "cleanup",
        RESIDENT_ID_KEY: "resident:instanceId",
        RESIDENT_RETIRED_KEY: "member-retired",
        DESTROY_UNCONFIRMED_KEY: "destroy",
        countR2Prefix: async () => 0,
        r2Prefix: (target: string) => `resident/${target}/`,
        THREAD_KEY_PREFIX: "thread:",
        PROVISIONING_CALLBACK: "deadline",
        PROVISION_RUN_CALLBACK: "provision",
        depsBackupStorageKey: (key: string) => `deps:${key}`,
        errMsg: (error: Error) => error.message,
      });
      const create = () => {
        const resident = new Resident();
        resident.env = { BACKUP_BUCKET: {} };
        resident.ctx = {
          storage: {
            get: async (key: string | string[]) =>
              Array.isArray(key) ? new Map(key.filter((k) => rows.has(k)).map((k) => [k, rows.get(k)])) : rows.get(key),
            delete: async (key: string | string[]) => {
              for (const k of Array.isArray(key) ? key : [key]) rows.delete(k);
            },
            list: async (options?: { prefix: string }) =>
              new Map([...rows].filter(([key]) => !options || key.startsWith(options.prefix))),
            deleteAlarm: async () => {},
            put: async (key: string, value: unknown) => rows.set(key, value),
            transaction: async (action: any) => action(resident.ctx.storage),
          },
        };
        resident.getStatus = async () => ({ state: rows.get("state") ?? "down", reason: rows.get("reason") ?? "" });
        resident.setResidentState = async (state: string, reason: string) => {
          rows.set("state", state);
          rows.set("reason", reason);
        };
        resident.listSchedules = async () => [];
        resident.deleteSchedules = () => {};
        resident.destroyConfirmed = async () => {};
        resident.adminWorkInFlight = 0;
        resident.recreateAdmission = new ResidentRecreateAdmission({
          mark: async () => {},
          clear: async () => {},
          held: async () => false,
        });
        resident.swapIncarnation = () => {};
        resident.allDepsBackups = async () =>
          [...rows].filter(([key]) => key.startsWith("deps:")).map(([, value]) => value);
        resident.recordedBackupIds = async () =>
          [rows.get("snapshot"), rows.get("retired")]
            .filter(Boolean)
            .flatMap((snapshot) => [snapshot.mirror.id, snapshot.checkout.id]);
        resident.countBackupObjects = async (ids: string[]) => ids.filter((id) => objects.has(id)).length;
        resident.deleteBackupObjects = async (ids: string[]) => {
          let removed = 0;
          for (const id of ids) {
            if (id === failing) throw new Error("R2 deletion failed");
            if (objects.delete(id)) removed++;
          }
          return removed;
        };
        return resident;
      };
      expect(await create().teardown()).toMatchObject({ containerStopped: true, storageCleared: false });
      expect(rows.get("native-operation:old")).toBe("original-outcome-unknown");
      expect(await create().rebuild(resource, "release", 300000, false)).toEqual({
        error: "rebuild-refused: full rebuild cleanup is still incomplete",
        status: 409,
      });
      expect((await create().teardownPlan()).backupObjects).toBe(remaining);
      expect(objects.has(failedId)).toBe(true);
      failing = undefined;
      expect(await create().teardown()).toMatchObject({ containerStopped: true, storageCleared: true, errors: [] });
      expect([...objects]).toEqual([]);
      expect(rows.get("cleanup")).toBe(resource);
      await create().confirmCleanup(resource);
      expect([...rows]).toEqual([]);
    },
  );
});

function fixture(
  options: {
    active?: number;
    engine?: string;
    destroyFails?: boolean;
    cleanupFails?: boolean;
    prefixFails?: boolean;
    residentId?: string;
  } = {},
) {
  const compiled = ts.transpileModule(
    `class Resident { ${["reset", "rebuild", "residentIdentity", "withRecreateSafeAdmin", "recreateRefusal", "confirmCleanup"].map((name) => methodOf(source, name) ?? "").join("\n")} }`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const Resident = runInNewContext(`${compiled}\nResident`, {
    RESOURCE_KEY: "resource",
    RESIDENT_ID_KEY: "residentId",
    CLEANUP_PENDING_KEY: "cleanup",
    DESTROY_UNCONFIRMED_KEY: "destroy",
    SNAPSHOT_KEY: "snapshot",
    countR2Prefix: async () => 0,
    deleteR2Prefix: async () => {
      if (options.prefixFails) throw new Error("prefix unavailable");
      return 0;
    },
    r2Prefix: (target: string) => `resident/${target}/`,
    errMsg: (err: Error) => err.message,
  });
  const resident = new Resident();
  const state = { container: "running", binding: "private-work", native: "unknown", provisioned: false, held: false };
  resident.recreateAdmission = new ResidentRecreateAdmission({
    mark: async () => {
      state.held = true;
    },
    clear: async () => {
      state.held = false;
    },
    held: async () => state.held,
  });
  resident.getStatus = async () => ({ state: options.engine ?? "warm", reason: "" });
  resident.inFlightCount = () => options.active ?? 0;
  resident.refreshAdmissionsInFlight = 0;
  resident.adminWorkInFlight = 0;
  resident.hydration = null;
  resident.setResidentState = async () => {};
  resident.env = { BACKUP_BUCKET: {} };
  resident.ctx = {
    storage: {
      get: async (key: string) =>
        key === "resource" ? resource : key === "residentId" ? options.residentId : undefined,
      delete: async () => {},
    },
  };
  resident.recordedBackupIds = async () => [];
  resident.allDepsBackups = async () => [];
  resident.teardownPlan = async () => ({
    state: "warm",
    reason: "",
    schedules: 0,
    snapshotBackupIds: ["s1", "s2"],
    backupObjects: 6,
    threadBindings: 1,
  });
  resident.teardown = async () => {
    if (options.destroyFails) throw new Error("resident-destroy-unconfirmed");
    state.container = "destroyed";
    if (!options.cleanupFails) {
      state.binding = "";
      state.native = "";
    }
    return {
      containerStopped: true,
      storageCleared: !options.cleanupFails,
      schedulesCancelled: true,
      backupObjectsDeleted: 6,
      errors: options.cleanupFails ? ["backup deletion failed"] : [],
    };
  };
  const initializations: unknown[] = [];
  resident.initResident = async (target: string, timeout: number, rebuilding?: boolean, residentId?: string) => {
    initializations.push({ target, timeout, rebuilding, residentId });
    if (target !== resource || timeout !== 300000 || state.container !== "destroyed")
      throw new Error("incorrect restoration");
    state.provisioned = true;
  };
  return { resident, state, initializations };
}

describe("full resident reset", () => {
  it("keeps the selected replica address after full teardown clears its stored state", async () => {
    const { resident, state, initializations } = fixture({ residentId: "resident-secondary" });
    expect(await resident.reset(resource, "release", 300000, false)).toMatchObject({ state: "onboarding" });
    expect(state.provisioned).toBe(true);
    expect(initializations).toEqual([
      { target: resource, timeout: 300000, rebuilding: false, residentId: "resident-secondary" },
    ]);
  });
  it("plans complete removal and recreation without changing the resident", async () => {
    const { resident, state } = fixture();
    expect(await resident.reset(resource, "release", 300000, true)).toEqual({
      resource,
      dryRun: true,
      wouldRemove: {
        state: "warm",
        reason: "",
        schedules: 0,
        snapshotBackupIds: ["s1", "s2"],
        backupObjects: 6,
        threadBindings: 1,
        r2Objects: 0,
      },
      keeps: { registryRecord: true },
      reprovision: { defaultRef: "release", provisioningTimeoutMs: 300000 },
      originalOperationOutcome: "unknown",
    });
    expect(state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });

  it("recreates only after confirmed destruction and reports the original outcome as unknown", async () => {
    const { resident, state } = fixture();
    expect(await resident.reset(resource, "release", 300000, false)).toMatchObject({
      resource,
      dryRun: false,
      state: "onboarding",
      containerStopped: true,
      storageCleared: true,
      keeps: { registryRecord: true },
      reprovision: { defaultRef: "release", provisioningTimeoutMs: 300000 },
      originalOperationOutcome: "unknown",
    });
    expect(state).toEqual({ container: "destroyed", binding: "", native: "", provisioned: true, held: false });
  });

  it("preserves the old resident and refuses recreation when destruction is unconfirmed", async () => {
    const { resident, state } = fixture({ destroyFails: true });
    await expect(resident.reset(resource, "release", 300000, false)).rejects.toThrow("resident-destroy-unconfirmed");
    expect(state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });

  it("does not start provisioning after incomplete backup cleanup", async () => {
    const { resident, state } = fixture({ cleanupFails: true });
    expect(await resident.reset(resource, "release", 300000, false)).toMatchObject({
      status: 503,
      error: "reset-incomplete: backup deletion failed",
      containerStopped: true,
      storageCleared: false,
    });
    expect(state).toEqual({
      container: "destroyed",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });

  it("refuses an active request without deleting its workspace", async () => {
    const { resident, state } = fixture({ active: 1 });
    expect(await resident.reset(resource, "release", 300000, false)).toEqual({
      status: 409,
      error: "reset-refused: 1 request(s) still in flight",
    });
    expect(state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });

  it("refuses an active engine cycle and a concurrent reset", async () => {
    const { resident, state } = fixture({ engine: "refreshing" });
    expect(await resident.reset(resource, "release", 300000, false)).toEqual({
      status: 409,
      error: "reset-refused: the engine is mid-flight (state refreshing)",
    });
    expect(state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
    const normal = fixture();
    expect(
      await normal.resident.recreateAdmission.run(async () =>
        normal.resident.reset(resource, "release", 300000, false),
      ),
    ).toEqual({ busy: false, value: { status: 409, error: "reset-refused: another VM recycle is in progress" } });
    expect(normal.state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });

  it("reports partial teardown and skips provisioning after a prefix deletion failure", async () => {
    const { resident, state } = fixture({ prefixFails: true });
    expect(await resident.reset(resource, "release", 300000, false)).toMatchObject({
      status: 503,
      error: "reset-incomplete: prefix unavailable",
      containerStopped: true,
      storageCleared: true,
    });
    expect(state).toEqual({ container: "destroyed", binding: "", native: "", provisioned: false, held: false });
  });

  it("includes dependency backups in the offboard and reset deletion plan", async () => {
    const compiled = ts.transpileModule(`class Resident { ${methodOf(source, "teardownPlan")} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Resident = runInNewContext(`${compiled}\nResident`, {
      PROVISIONING_CALLBACK: "deadline",
      PROVISION_RUN_CALLBACK: "provision",
      SNAPSHOT_KEY: "snapshot",
      RESOURCE_KEY: "resource",
      CLEANUP_PENDING_KEY: "cleanup",
      RESIDENT_ID_KEY: "resident:instanceId",
      RESIDENT_RETIRED_KEY: "member-retired",
      DESTROY_UNCONFIRMED_KEY: "destroy",
      countR2Prefix: async () => 0,
      r2Prefix: (target: string) => `resident/${target}/`,
      THREAD_KEY_PREFIX: "thread:",
    });
    const resident = new Resident();
    resident.getStatus = async () => ({ state: "warm", reason: "" });
    resident.listSchedules = async () => [];
    resident.recordedBackupIds = async () => ["s1", "s2"];
    resident.allDepsBackups = async () => [{ backup: { id: "d1" } }];
    resident.countBackupObjects = async (ids: string[]) => ids.length * 2;
    resident.ctx = { storage: { get: async () => undefined, list: async () => new Map([["thread:one", {}]]) } };
    expect(await resident.teardownPlan()).toEqual({
      state: "warm",
      reason: "",
      schedules: 0,
      snapshotBackupIds: ["s1", "s2"],
      backupObjects: 6,
      threadBindings: 1,
    });
  });

  it("holds ordinary rebuilds behind the same reset admission", async () => {
    const { resident, state } = fixture();
    expect(
      await resident.recreateAdmission.run(() => resident.rebuild(resource, "release", 300000, false)),
    ).toMatchObject({
      busy: false,
      value: {
        error: "recreate-in-progress: new resident work is paused during the operator's checked VM recycle",
        status: 503,
        reason: "recreate-in-progress",
      },
    });
    expect(state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });

  it("the reset endpoint uses the stored ref and budget and retains registration after a failed destroy", async () => {
    const start = source.indexOf("async function handleReset(");
    const end = source.indexOf("\nasync function ", start + 1);
    const compiled = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const record = {
      resource,
      defaultRef: "release",
      provisioningTimeoutMs: 300000,
      commands: { install: "node --version", test: "npm test", build: "npm run build" },
    };
    const { resident, state } = fixture({ destroyFails: true });
    const endpoint = runInNewContext(`${compiled}\nhandleReset`, {
      selectedResidentMember,
      parseResource: (value: string) => ({ resource: value }),
      registryStub: () => ({ getRepository: async () => record }),
      residentStub: () => resident,
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
      Response,
    });
    const plan = await endpoint({}, { resource, defaultRef: "wrong", provisioningTimeoutMs: 1, dryRun: true });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({
      keeps: { registryRecord: true },
      reprovision: { defaultRef: "release", provisioningTimeoutMs: 300000 },
      originalOperationOutcome: "unknown",
    });
    await expect(endpoint({}, { resource })).rejects.toThrow("resident-destroy-unconfirmed");
    expect(record).toEqual({
      resource: "repo:acme/api",
      defaultRef: "release",
      provisioningTimeoutMs: 300000,
      commands: { install: "node --version", test: "npm test", build: "npm run build" },
    });
    expect(state).toEqual({
      container: "running",
      binding: "private-work",
      native: "unknown",
      provisioned: false,
      held: false,
    });
  });
});
