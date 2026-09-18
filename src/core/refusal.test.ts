import { describe, expect, it } from "vitest";
import { causeOf, REFUSAL_CODES, refusalOf, RefusalError, type RefusalCode } from "./refusal.js";

// Feature: record 0054:
// every refusal is one `Refusal` with exactly one cause per code, read from one
// closed table — the trace, the run record and the door report count by the
// same names.

describe("the refusal seam — one cause per code, in one table", () => {
  it("every code has exactly one cause, and causeOf answers it", () => {
    for (const code of REFUSAL_CODES) expect(["request", "policy", "system"]).toContain(causeOf(code));
  });

  it("the dispatch gates' codes carry the inventory's causes", () => {
    const expected: Partial<Record<RefusalCode, string>> = {
      agent_allowlist: "policy",
      profile_bounded: "policy",
      repo_not_onboarded: "request",
      repo_unverified: "system",
      repo_access: "policy",
      which_branch: "request",
      workspace_lost: "system",
      setup_failed: "system",
      uncaught: "system",
      confirmation_used: "request",
      confirmation_expired: "request",
      confirmation_foreign: "policy",
      confirmation_unreadable: "system",
      elsewhere_agent_allowlist: "policy",
      elsewhere_follow_up_refused: "request",
    };
    for (const [code, cause] of Object.entries(expected)) expect(causeOf(code as RefusalCode)).toBe(cause);
  });

  it("the references constant's eight reasons are eight codes, split request 2 / policy 3 / system 3 (the appendix's correction of the record)", () => {
    const referenceCodes = REFUSAL_CODES.filter((c) => c.startsWith("reference_"));
    expect(referenceCodes).toHaveLength(8);
    const byCause = { request: 0, policy: 0, system: 0 };
    for (const code of referenceCodes) byCause[causeOf(code)]++;
    expect(byCause).toEqual({ request: 2, policy: 3, system: 3 });
  });

  it("refusalOf builds the Refusal with the table's cause, and RefusalError carries it as a throwable", () => {
    const refusal = refusalOf("repo_not_onboarded", "📦 `o/r` is not onboarded as a resident…");
    expect(refusal).toEqual({
      cause: "request",
      code: "repo_not_onboarded",
      text: "📦 `o/r` is not onboarded as a resident…",
    });
    const err = new RefusalError(refusal);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(refusal.text);
    expect(err.refusal).toBe(refusal);
  });
});
