import { describe, expect, it } from "vitest";
import { ResidentRecreateAdmission, idleForPoolRecycle } from "./residentRecreateAdmission.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("resident recreate admission", () => {
  it("recycles for the sole waiting request only when the VM has no other owner", () => {
    const idle = {
      state: "warm",
      draining: false,
      imagePending: false,
      inFlight: 1,
      refreshAdmissions: 0,
      adminWork: 0,
      hydrating: false,
      registeredRuns: 0,
      liveBindings: 0,
      inspecting: 0,
    };
    expect(idleForPoolRecycle(idle)).toBe(true);
    for (const busy of [
      { state: "restoring" },
      { draining: true },
      { imagePending: true },
      { inFlight: 2 },
      { refreshAdmissions: 1 },
      { adminWork: 1 },
      { hydrating: true },
      { registeredRuns: 1 },
      { liveBindings: 1 },
      { inspecting: 1 },
    ])
      expect(idleForPoolRecycle({ ...idle, ...busy })).toBe(false);
  });

  it("closes admission before checking idleness and holds it through destruction", async () => {
    const checked = deferred<number>();
    const destroyed = deferred<void>();
    let persisted = false;
    let enteredDestroy = false;
    const admission = new ResidentRecreateAdmission({
      mark: async () => {
        persisted = true;
      },
      clear: async () => {
        persisted = false;
      },
      held: async () => persisted,
    });

    const attempt = admission.run(async () => {
      const active = await checked.promise;
      if (active > 0) return "busy";
      enteredDestroy = true;
      await destroyed.promise;
      return "destroyed";
    });
    expect(await admission.blocked()).toBe(true);
    expect((await admission.run(async () => "second destroy")).busy).toBe(true);
    checked.resolve(0);
    await Promise.resolve();
    expect(enteredDestroy).toBe(true);
    expect(await admission.blocked()).toBe(true);
    destroyed.resolve();
    expect(await attempt).toEqual({ busy: false, value: "destroyed" });
    expect(await admission.blocked()).toBe(false);
  });

  it("releases a refused idle check and leaves an uncertain mark fail closed after reset", async () => {
    let persisted = false;
    const store = {
      mark: async () => {
        persisted = true;
      },
      clear: async () => {
        persisted = false;
      },
      held: async () => persisted,
    };
    const first = new ResidentRecreateAdmission(store);
    expect(await first.run(async () => "active run refused")).toEqual({ busy: false, value: "active run refused" });
    expect(await first.blocked()).toBe(false);

    persisted = true; // the previous isolate died before its finally cleared the durable mark
    const resumed = new ResidentRecreateAdmission(store);
    expect(await resumed.blocked()).toBe(true);
    expect(await resumed.run(async () => "rechecked and recovered")).toEqual({
      busy: false,
      value: "rechecked and recovered",
    });
    expect(await resumed.blocked()).toBe(false);
  });
});
