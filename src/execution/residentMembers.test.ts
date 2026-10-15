import { describe, expect, it } from "vitest";
import { nextResidentMember, planResidentPool, reservedResidentCount, residentMembers } from "./residentMembers.js";

const primary = { resource: "repo:acme/api" };
const revision = "cf5c0a88-820b-45f2-b689-4432d93fbdce";

describe("resident replica membership", () => {
  it("reserves new addresses without routing work there before activation", () => {
    const pool = planResidentPool(primary, 3, ["replica-2", "replica-3"], revision);
    const record = { ...primary, pool };
    expect(reservedResidentCount([record, { resource: "repo:acme/cold", noResident: true }])).toBe(3);
    expect(residentMembers([record]).map((r) => r.residentId)).toEqual(["repo:acme/api"]);
    expect(nextResidentMember(record, ["repo:acme/api", "replica-2", "replica-3"], 1)).toBe("repo:acme/api");
    const active = { ...record, pool: { ...pool, active: 3 } };
    expect([0, 1, 2, 3].map((cursor) => nextResidentMember(active, pool.members, cursor))).toEqual([
      "repo:acme/api",
      "replica-2",
      "replica-3",
      "repo:acme/api",
    ]);
  });

  it("reducing the warm count keeps old addresses but stops placing new work on them", () => {
    const pool = { ...planResidentPool(primary, 3, ["replica-2", "replica-3"], revision), active: 3 };
    const reduced = planResidentPool({ ...primary, pool }, 1, [], revision);
    expect(
      residentMembers([{ ...primary, pool: reduced }]).map(({ residentId, keepWarm }) => ({ residentId, keepWarm })),
    ).toEqual([
      { residentId: "repo:acme/api", keepWarm: true },
      { residentId: "replica-2", keepWarm: false },
      { residentId: "replica-3", keepWarm: false },
    ]);
    expect(reservedResidentCount([{ ...primary, pool: reduced }])).toBe(3);
    expect(nextResidentMember({ ...primary, pool: reduced }, pool.members, 1)).toBe("repo:acme/api");
    expect(planResidentPool({ ...primary, pool: reduced }, 3, [], revision).members).toEqual(pool.members);
  });

  it("preserves legacy listings and excludes unhealthy or retired candidates", () => {
    expect(residentMembers([primary, { resource: "repo:acme/cold", noResident: true }])).toEqual([primary]);
    const pool = { ...planResidentPool(primary, 2, ["replica-2"], revision), active: 2 };
    expect(nextResidentMember({ ...primary, pool }, ["replica-2", "foreign"], 0)).toBe("replica-2");
    expect(nextResidentMember({ ...primary, pool }, ["foreign"], 0)).toBeUndefined();
  });

  it("refuses corrupt membership and duplicate addresses", () => {
    expect(planResidentPool(primary, 2, ["replica-2"], revision)).toEqual({
      version: 1,
      revision,
      desired: 2,
      active: 1,
      members: ["repo:acme/api", "replica-2"],
    });
    expect(() => planResidentPool(primary, 2, [primary.resource], revision)).toThrow("metadata could not be verified");
    expect(() =>
      residentMembers([
        { ...primary, pool: { version: 1, revision, desired: 2, active: 3, members: [primary.resource, "replica-2"] } },
      ]),
    ).toThrow("metadata could not be verified");
  });
});
