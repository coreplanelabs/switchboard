import { describe, expect, it } from "vitest";
import { causeOf, REFUSAL_CODES, refusalOf, RefusalError, residentErrorCause, type RefusalCode } from "./refusal.js";

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

  it("the Worker's `error` prefix names the cause — a ref the person can fix is `request`, a version skew is the machinery's (record 0054)", () => {
    // The Worker's two ref refusals are the person's: a missing binding and a
    // ref that does not resolve.
    expect(residentErrorCause("needs-ref: this thread has no ref binding yet")).toBe("request");
    expect(residentErrorCause('unknown-ref: ref "nope" does not resolve in the mirror')).toBe("request");
    // `op-unavailable` is the Worker's command table lacking the op the bot
    // sent — a bot/Worker version skew, never a sentence the person could
    // reword, so it is the machinery's like every other prefix.
    expect(residentErrorCause('op-unavailable: the command table has no "attach" entry')).toBe("system");
    expect(residentErrorCause("not-onboarded: no registry record")).toBe("system");
    expect(residentErrorCause("attach-failed: reconcile timed out")).toBe("system");
    // No prefix at all is the machinery's too, never a guess at the person.
    expect(residentErrorCause("boom")).toBe("system");
  });
});
