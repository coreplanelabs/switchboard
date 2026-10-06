import { describe, expect, it } from "vitest";
import { resourceLifetimeSchema, resourceLifetimeOrRetained, sameResourceLifetime } from "./resourceLifetime.js";

const scratch = {
  version: 1,
  purpose: "pull-request-review",
  resident: "retained",
  cold: {
    kind: "exclusive-scratch",
    scope: "original-cold-allocation",
    custody: "session-report-and-review-publication",
  },
};
const retained = { version: 1, purpose: "retained-work", resident: "retained", cold: "retained" };

describe("registered resource lifetime schema", () => {
  it("reads the closed declaration without inferring policy from labels capabilities or flags", () => {
    expect(resourceLifetimeSchema.parse(scratch)).toEqual(scratch);
    expect(resourceLifetimeSchema.parse(retained)).toEqual(retained);
    for (const unknown of [
      undefined,
      null,
      { name: "review", readonly: true, ephemeral: true },
      { ...scratch, version: 2 },
      { ...scratch, purpose: "arbitrary" },
      { ...scratch, resident: "exclusive-scratch" },
      { ...scratch, cold: { kind: "exclusive-scratch" } },
      { ...scratch, cold: { ...scratch.cold, callerFlag: true } },
      { ...scratch, ephemeral: true },
      { ...retained, cold: scratch.cold },
      { ...scratch, cold: "retained" },
    ]) {
      expect(resourceLifetimeSchema.safeParse(unknown).success).toBe(false);
      expect(resourceLifetimeOrRetained(unknown)).toEqual(retained);
    }
  });
  it("compares validated declarations independent of decoded key order and clones nested values", () => {
    const reordered = {
      cold: { custody: scratch.cold.custody, scope: scratch.cold.scope, kind: scratch.cold.kind },
      resident: scratch.resident,
      purpose: scratch.purpose,
      version: scratch.version,
    };
    expect(sameResourceLifetime(scratch, reordered)).toBe(true);
    expect(sameResourceLifetime(scratch, retained)).toBe(false);
    const one = resourceLifetimeOrRetained(scratch),
      two = resourceLifetimeOrRetained(scratch);
    if (one.purpose !== "pull-request-review" || two.purpose !== "pull-request-review")
      throw new Error("missing fixture policy");
    expect(one.cold).not.toBe(two.cold);
    (one.cold as { scope: string }).scope = "mutated";
    expect(two).toEqual(scratch);
    expect(scratch.cold.scope).toBe("original-cold-allocation");
  });
});
