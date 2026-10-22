import { describe, expect, it } from "vitest";
import {
  AUDIENCE_REFUSAL_CODES,
  audienceRefusalOf,
  audienceRefusalText,
  noteAudienceRefusal,
  type AudienceTrace,
} from "./audienceDecision.js";

describe("audience refusal diagnostics", () => {
  it("retains the first GitHub read failure across serialization and rejects private extras", () => {
    const githubAccess = {
      tool: "github_file",
      stage: "tool-read",
      operation: "readFile",
      reason: "http",
      httpStatus: 403,
      requestId: "A1:B2",
      route: "contents",
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1792700000,
      rateLimitResource: "core",
      retryAfterSeconds: 120,
      responseReason: "primary-rate-limit-indicated",
      responseMessage: "API rate limit exceeded",
      sourceCallHash: "a".repeat(64),
    };
    const trace: AudienceTrace = {};
    noteAudienceRefusal(
      trace,
      "saved-context-unproved",
      "answer-event",
      "answer-event",
      "execution_github_access_unproved",
      githubAccess as never,
    );
    const expected = {
      version: 1,
      causeAt: "answer-event",
      withheldAt: "answer-event",
      code: "saved-context-unproved",
      check: "execution_github_access_unproved",
      githubAccess: { ...githubAccess },
    };
    githubAccess.httpStatus = 404;
    noteAudienceRefusal(trace, "saved-context-unproved", "reply", "reply", "execution_github_access_unproved", {
      ...githubAccess,
      reason: "unknown",
    } as never);
    expect(audienceRefusalOf(JSON.parse(JSON.stringify(trace.refusal)))).toEqual(expected);
    for (const diagnostic of [
      { ...expected.githubAccess, body: "private code" },
      { ...expected.githubAccess, tool: "private repo" },
      { ...expected.githubAccess, stage: "private path" },
      { ...expected.githubAccess, reason: "secret" },
      { ...expected.githubAccess, operation: "createIssue" },
      { ...expected.githubAccess, httpStatus: 999 },
      { ...expected.githubAccess, requestId: "secret query" },
      { ...expected.githubAccess, route: "private/path" },
      { ...expected.githubAccess, rateLimitRemaining: -1 },
      { ...expected.githubAccess, rateLimitResetEpochSeconds: 9999999999 },
      { ...expected.githubAccess, rateLimitResource: "private/path" },
      { ...expected.githubAccess, retryAfterSeconds: 9999999999 },
      { ...expected.githubAccess, responseReason: "secret" },
      { ...expected.githubAccess, reason: "unknown" },
      { ...expected.githubAccess, httpStatus: 404 },
      { ...expected.githubAccess, responseMessage: "https://private.test/secret" },
      { ...expected.githubAccess, sourceCallHash: "raw call id" },
    ])
      expect(audienceRefusalOf({ ...expected, githubAccess: diagnostic })).toBeUndefined();
  });
  it("retains a closed context check without accepting source content", () => {
    const trace: AudienceTrace = {};
    const check = "execution_receipt_missing";
    noteAudienceRefusal(trace, "saved-context-unproved", "answer-event", "answer-event", check);
    expect(audienceRefusalOf(trace.refusal)).toEqual({
      version: 1,
      causeAt: "answer-event",
      withheldAt: "answer-event",
      code: "saved-context-unproved",
      check,
    });
    noteAudienceRefusal(trace, "saved-context-unproved", "reply", "reply", "execution_owner_missing");
    expect(trace.refusal?.check).toBe("execution_receipt_missing");
    expect(audienceRefusalOf({ ...trace.refusal, check: "private source content" })).toBeUndefined();
  });
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
