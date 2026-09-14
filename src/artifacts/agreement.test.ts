import { describe, expect, it } from "vitest";
import { bucketMismatch } from "./agreement.js";

// Feature: docs/reference/specs/execution.md item 20 — the config's bucket and
// the Worker's bound bucket must be one name; the operator's check reads this.
describe("bucketMismatch (item 20)", () => {
  it("agrees when the Worker binds the config's bucket, names both when it binds another, and says so when it binds none", () => {
    expect(bucketMismatch("switchboard-artifacts", "switchboard-artifacts")).toBeUndefined();
    expect(bucketMismatch("switchboard-artifacts", "other-bucket")).toMatch(
      /config names bucket switchboard-artifacts but its Worker binds other-bucket/,
    );
    expect(bucketMismatch("switchboard-artifacts", undefined)).toMatch(
      /Worker binds no artifacts bucket .* the config names switchboard-artifacts/,
    );
  });
});
