import { describe, expect, it } from "vitest";
import {
  stateWriteDiagnosticFromHeader,
  stateWriteException,
  stateWriteReplyShape,
} from "./runStateWriteDiagnostic.js";

describe("closed state-write failure evidence", () => {
  const digest = "a".repeat(64);
  const original = { version: 1, requestDigest: digest, failure: { stage: "state-rpc", errorKind: "type" } };
  const read = (value: unknown) => stateWriteDiagnosticFromHeader(JSON.stringify(value), digest);

  it("accepts only the exact immutable request and closed stage vocabulary", () => {
    expect(read(original)).toEqual(original.failure);
    expect(read({ ...original, failure: { stage: "acknowledgment", replyShape: "undefined" } })).toEqual({
      stage: "acknowledgment",
      replyShape: "undefined",
    });
    for (const value of [
      { ...original, requestDigest: "b".repeat(64) },
      { ...original, version: 2 },
      { ...original, privateCause: "private bytes" },
      { ...original, failure: { ...original.failure, message: "private bytes" } },
      { ...original, failure: { stage: "native-ended", errorKind: "type" } },
      { ...original, failure: { stage: "state-rpc", errorKind: ["type"] } },
      { ...original, failure: { stage: "acknowledgment", replyShape: ["ok"] } },
      [original],
      null,
    ])
      expect(read(value)).toBeUndefined();
    expect(stateWriteDiagnosticFromHeader("{", digest)).toBeUndefined();
    expect(stateWriteDiagnosticFromHeader("x".repeat(513), digest)).toBeUndefined();
  });

  it("reports bounded exception and reply categories without exception or reply bytes", () => {
    expect(stateWriteException("promotion-preflight", new SyntaxError("private payload"))).toEqual({
      stage: "promotion-preflight",
      errorKind: "syntax",
    });
    expect(stateWriteException("state-rpc", "private thrown bytes")).toEqual({
      stage: "state-rpc",
      errorKind: "non-error",
    });
    expect(stateWriteReplyShape({ ok: true, secret: "private bytes" })).toBe("ok");
    expect(stateWriteReplyShape({ kind: "held", reason: "private bytes" })).toBe("held");
    expect(stateWriteReplyShape(null)).toBe("null");
    expect(stateWriteReplyShape(undefined)).toBe("undefined");
    expect(stateWriteReplyShape(["private bytes"])).toBe("array");
  });
});
