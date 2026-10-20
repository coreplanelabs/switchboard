import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { destroyWithPersistentFence } from "../../src/execution/residentDestroyGate.js";
import { ResidentRecreateAdmission } from "../../src/execution/residentRecreateAdmission.js";
import { methodOf, readSource } from "./testing/sourceScan";

const residentSource = readSource("worker.ts");
const residentClass = residentSource.slice(residentSource.indexOf("export class ResidentDO"));
const methods = ["debugRecreateContainer", "debugRecreateContainerChecked", "recreateContainer", "destroyConfirmed"];
const compiled = ts.transpileModule(
  `class Resident { ${methods.map((name) => methodOf(residentClass, name)).join("\n")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture(failDestroy = false) {
  const logs: string[] = [];
  const Resident = runInNewContext(`${compiled}\nResident`, {
    DESTROY_UNCONFIRMED_KEY: "destroy-unconfirmed",
    CLEANUP_PENDING_KEY: "cleanup-pending",
    destroyWithPersistentFence,
    resetUidGeneration: async () => {},
    systemClock: () => Date.parse("2026-10-20T08:00:00Z"),
    console: { log: () => {}, warn: (message: string) => logs.push(message) },
  });
  const rows = new Map<string, unknown>([
    ["destroy-unconfirmed", true],
    ["recreate-admission", true],
  ]);
  const resident = new Resident();
  resident.ctx = {
    storage: {
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => {
        rows.set(key, value);
      },
      delete: async (key: string) => {
        rows.delete(key);
      },
      transaction: async (work: (rows: unknown) => Promise<unknown>) => work({}),
    },
    waitUntil: (work: Promise<unknown>) => {
      void work;
    },
  };
  resident.recreateAdmission = new ResidentRecreateAdmission({
    mark: async () => {
      rows.set("recreate-admission", true);
    },
    clear: async () => {
      rows.delete("recreate-admission");
    },
    held: async () => rows.has("recreate-admission"),
  });
  resident.getStatus = async () => ({
    state: rows.has("destroy-unconfirmed") ? "down" : "degraded",
    reason: rows.has("destroy-unconfirmed") ? "resident-destroy-unconfirmed: container reuse refused" : "",
  });
  resident.inFlightCount = () => 0;
  resident.refreshAdmissionsInFlight = 0;
  resident.adminWorkInFlight = 0;
  resident.hydration = null;
  resident.registeredRunsBeyondOps = async () => 0;
  resident.swapIncarnation = () => {};
  resident.forgetRuntimeIdentity = async () => {};
  let destroyed = 0;
  resident.destroy = async () => {
    destroyed++;
    if (failDestroy) throw new Error("platform destroy unconfirmed");
  };
  resident.setResidentState = async (state: string) => {
    rows.set("state", state);
  };
  let hydrated = false;
  resident.ensureHydrated = async () => {
    hydrated = true;
  };
  resident.classifyCycleError = async (error: Error) => ({ reason: error.message });
  resident.recordRefreshError = async () => {};
  return {
    resident,
    rows,
    logs,
    get destroyed() {
      return destroyed;
    },
    get hydrated() {
      return hydrated;
    },
  };
}

describe("interrupted resident destroy recovery", () => {
  it("retries the checked destroy and starts restore only after destruction is confirmed", async () => {
    const state = fixture();
    expect(await state.resident.debugRecreateContainer()).toEqual({
      recreated: true,
      restoreStartedAt: "2026-10-20T08:00:00.000Z",
    });
    expect(state.destroyed).toBe(1);
    expect(state.rows.has("destroy-unconfirmed")).toBe(false);
    expect(state.rows.get("state")).toBe("degraded");
    expect(state.hydrated).toBe(true);
  });

  it("keeps the destroy fence and refuses restore when the retry is unconfirmed", async () => {
    const state = fixture(true);
    await expect(state.resident.debugRecreateContainer()).rejects.toThrow("platform destroy unconfirmed");
    expect(state.destroyed).toBe(1);
    expect(state.rows.has("destroy-unconfirmed")).toBe(true);
    expect(state.hydrated).toBe(false);
  });

  it("does not retry a down resident without a saved destroy fence", async () => {
    const state = fixture();
    state.rows.delete("destroy-unconfirmed");
    state.resident.getStatus = async () => ({ state: "down", reason: "provision failed" });
    expect(await state.resident.debugRecreateContainer()).toEqual({
      recreated: false,
      status: 409,
      error: "recreate-refused: the resident is down (provision failed) — POST /rebuild is its exit",
    });
    expect(state.destroyed).toBe(0);
  });

  it("leaves an unfinished full reset with its existing cleanup owner", async () => {
    const state = fixture();
    state.rows.set("cleanup-pending", "repo:acme/api");
    state.resident.getStatus = async () => ({ state: "down", reason: "full-rebuild-cleanup-incomplete" });
    expect(await state.resident.debugRecreateContainer()).toEqual({
      recreated: false,
      status: 409,
      error: "recreate-refused: the resident is down (full-rebuild-cleanup-incomplete) — POST /rebuild is its exit",
    });
    expect(state.destroyed).toBe(0);
    expect(state.rows.has("destroy-unconfirmed")).toBe(true);
    expect(state.logs).toEqual([
      '[resident-recreate-refused] {"schema":1,"destroyFenceStored":true,"cleanupPending":true}',
    ]);
  });

  it("does not retry destruction while another request is active", async () => {
    const state = fixture();
    state.resident.inFlightCount = () => 1;
    expect(await state.resident.debugRecreateContainer()).toEqual({
      recreated: false,
      status: 409,
      error: "recreate-refused: 1 run(s) still in flight",
    });
    expect(state.destroyed).toBe(0);
    expect(state.rows.has("destroy-unconfirmed")).toBe(true);
  });
});
