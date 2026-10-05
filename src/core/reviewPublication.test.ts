import { describe, expect, it } from "vitest";
import { terminalPublicationRetentionRequired } from "./branchPublication.js";

describe("review publication terminal retention", () => {
  const receipt = {
    version: 1,
    runId: "review-original",
    target: { repo: "acme/api", number: 7, commitId: "a".repeat(40) },
    bodyHash: "b".repeat(64),
  };
  it("retains pending uncertain and malformed original receipts without depending on a branch map", () => {
    for (const reviewPublication of [{ ...receipt, state: "pending" }, { ...receipt, state: "uncertain" }, {}, null])
      expect(terminalPublicationRetentionRequired({ reviewPublication })).toBe(true);
    for (const state of ["accepted", "refused"])
      expect(terminalPublicationRetentionRequired({ reviewPublication: { ...receipt, state } })).toBe(false);
    expect(terminalPublicationRetentionRequired({})).toBe(false);
  });
});
