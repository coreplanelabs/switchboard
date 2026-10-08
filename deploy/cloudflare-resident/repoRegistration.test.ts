import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { registerRepository } from "../../src/execution/repoRegistration";
import { effectiveLimits } from "./gc";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const handler = (name: string) => {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
};

describe("metadata-only repo routes", () => {
  it("admits twelve residents, refuses a thirteenth, and still admits cold metadata", async () => {
    const cap = source.match(/^const RESIDENT_CAP = [^;]+;/m)?.[0];
    if (!cap) throw new Error("resident cap declaration missing");
    const compiled = ts.transpileModule(
      `${cap}\nclass Registry { ${methodOf(source, "onboard")} ${methodOf(source, "limits")} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const Registry = runInNewContext(`${compiled}\nRegistry`, {
      registerRepository,
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
    for (let i = 1; i <= 12; i++) {
      const record = { resource: `repo:acme/repo-${i}` };
      expect(await instance.onboard(record)).toEqual({ ok: true, record });
    }
    expect(await instance.onboard({ resource: "repo:acme/overflow" })).toEqual({
      ok: false,
      status: 429,
      error: "resident cap reached (12/12); offboard a resident first, or onboard with evictColdest:true to make room",
    });
    expect(await instance.onboard({ resource: "repo:acme/cold", noResident: true })).toEqual({
      ok: true,
      record: { resource: "repo:acme/cold", noResident: true },
    });
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
