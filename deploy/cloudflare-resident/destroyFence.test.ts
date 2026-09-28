import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const resident = source.slice(source.indexOf("export class ResidentDO"));
const method = (name: string) => methodOf(resident, name) ?? "";
const functionOf = (name: string) => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  return start === -1 ? "" : source.slice(start, source.indexOf("\n}\n", start) + 3);
};

describe("resident VM destroy uncertainty", () => {
  it("persists refusal before invalidating SDK identity or calling destroy", () => {
    const body = method("destroyConfirmed");
    expect(body).toContain("destroyWithPersistentFence(");
    expect(body.indexOf("mark:")).toBeLessThan(body.indexOf("await this.forgetRuntimeIdentity()"));
    expect(body.indexOf("await this.forgetRuntimeIdentity()")).toBeLessThan(body.indexOf("await this.destroy()"));
    expect(body).toContain("this.ctx.storage.put(DESTROY_UNCONFIRMED_KEY, true)");
    expect(body).toContain("this.ctx.storage.delete(DESTROY_UNCONFIRMED_KEY)");
    expect(method("run")).toContain("this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)");
    expect(method("run").match(/this\.ctx\.storage\.get\(DESTROY_UNCONFIRMED_KEY\)/g)).toHaveLength(2);
    expect(method("initResident")).toContain("this.ctx.storage.get(DESTROY_UNCONFIRMED_KEY)");
    expect(method("getStatus")).toContain("resident-destroy-unconfirmed");
    expect(method("getResidentInfo")).toContain("DESTROY_UNCONFIRMED_KEY");
  });

  it("routes every lifecycle destroy through the fence without swallowing failure", () => {
    for (const name of ["refreshFailed", "escalateRuntimeUnreachable", "recreateContainer", "rebuild", "teardown"]) {
      expect(method(name), `${name} must use the durable fence`).toContain("await this.destroyConfirmed()");
    }
    expect(resident.match(/await this\.destroy\(\)/g)).toHaveLength(1);
    expect(method("rebuild").indexOf("await this.destroyConfirmed()")).toBeLessThan(
      method("rebuild").indexOf("await this.deleteBackupObjects(recorded)"),
    );
    expect(method("teardown").indexOf("await this.destroyConfirmed()")).toBeLessThan(
      method("teardown").indexOf("this.deleteSchedules(PROVISIONING_CALLBACK)"),
    );
  });

  it("keeps offboard retryable and avoids R2 deletion after uncertain destroy", () => {
    const offboard = functionOf("handleOffboard");
    const teardown = functionOf("teardownResident");
    const onboard = functionOf("handleOnboard");
    expect(offboard).toContain("old.resource !== resource.resource");
    expect(offboard).toContain("result.containerStopped ? 200 : 503");
    expect(teardown).toContain("teardown.containerStopped");
    expect(onboard).toContain("!teardown.containerStopped");
    expect(onboard).toContain("registry.replace(record.resource, victim)");
  });

  it("holds operator recreate admission across hydration, the idle check and VM destroy", () => {
    expect(method("debugRecreateContainer")).toContain("this.recreateAdmission.run(");
    const checked = method("debugRecreateContainerChecked");
    expect(checked.indexOf("this.registeredRunsBeyondOps()")).toBeLessThan(
      checked.indexOf("await this.recreateContainer("),
    );
    expect(method("attachThread")).toContain("this.attachAdmissionsInFlight++");
    expect(method("attachThreadTraced")).toContain("this.recreateAdmission.blocked()");
    expect(method("runOp")).toContain("this.opAdmissionsInFlight++");
    expect(method("runOpTraced")).toContain("this.recreateAdmission.blocked()");
    expect(method("threadPreflight")).toContain("this.recreateAdmission.blocked()");
    expect(method("runInstanceStep")).toContain("this.recreateAdmission.blocked()");
    const count = method("runsInFlightCount");
    expect(count).toContain("this.attachAdmissionsInFlight");
    expect(count).toContain("this.opAdmissionsInFlight");
    expect(checked).toContain("this.refreshAdmissionsInFlight");
    expect(checked).toContain("this.hydration");
    expect(checked).toContain("this.adminWorkInFlight");
    for (const name of ["debugSweepNow", "debugReclaimNow", "debugMeasureDisk"]) {
      expect(method(name)).toContain("this.withRecreateSafeAdmin(");
    }
    expect(method("getResidentInfo")).toContain("recreateAdmissionHeld:");
  });
});
