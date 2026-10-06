import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const handler = (name: string) => {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("metadata-only repo routes", () => {
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
