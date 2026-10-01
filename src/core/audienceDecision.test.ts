import { describe, expect, it } from "vitest";
import {
  AUDIENCE_REFUSAL_CODES,
  audienceRefusalOf,
  audienceRefusalText,
  noteAudienceRefusal,
  type AudienceTrace,
} from "./audienceDecision.js";

describe("audience refusal diagnostics", () => {
  it("accepts only the closed structural receipt and never private extra fields", () => {
    const receipt = { version: 1, causeAt: "reply", withheldAt: "reply", code: "github-access-lost" };
    expect(audienceRefusalOf(receipt)).toEqual(receipt);
    for (const value of [
      undefined,
      null,
      {},
      { ...receipt, version: 2 },
      { ...receipt, code: "private secret" },
      { ...receipt, causeAt: "model" },
      { ...receipt, withheldAt: "followup" },
      { ...receipt, source: "secret/repo" },
    ])
      expect(audienceRefusalOf(value)).toBeUndefined();
    expect(audienceRefusalOf(receipt)).not.toBe(receipt);
  });
  it("retains the first revocation when publication later observes it", () => {
    const trace: AudienceTrace = {};
    noteAudienceRefusal(trace, "followup-indirect", "followup");
    noteAudienceRefusal(trace, "direct-audience-unavailable", "reply", "reply");
    expect(trace.refusal).toEqual({ version: 1, causeAt: "followup", withheldAt: "reply", code: "followup-indirect" });
    noteAudienceRefusal(trace, "github-access-lost", "reply", "reply");
    expect(trace.refusal?.code).toBe("followup-indirect");
  });
  it("renders every closed cause without accepting source text", () => {
    for (const code of AUDIENCE_REFUSAL_CODES) expect(audienceRefusalText(code)).toEqual(expect.any(String));
  });
});
