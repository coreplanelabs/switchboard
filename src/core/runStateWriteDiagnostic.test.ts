import { describe, expect, it } from "vitest";
import {
  stateWriteDiagnosticFromHeader,
  stateWriteException,
  stateWriteReplyShape,
  stateWriteDiagnosticHeader,
} from "./runStateWriteDiagnostic.js";

describe("closed state-write failure evidence", () => {
  const digest = "a".repeat(64);
  const original = { version: 1, requestDigest: digest, failure: { stage: "state-rpc", errorKind: "type" } };
  const read = (value: unknown) => stateWriteDiagnosticFromHeader(JSON.stringify(value), digest);

  it("excludes direct and nested decoder prose from captures and remote headers while retaining error identity", () => {
    const decoder = Object.assign(new SyntaxError("PRIVATE_STORED_PAYLOAD"), { remote: true, code: "E_JSON" });
    decoder.stack = "SyntaxError: PRIVATE_STORED_PAYLOAD";
    const outer = new Error("wrapper PRIVATE_STORED_PAYLOAD", { cause: decoder });
    outer.stack = "Error: wrapper PRIVATE_STORED_PAYLOAD";
    for (const error of [decoder, outer]) {
      const failure = stateWriteException("request", error);
      expect(failure).toMatchObject({
        stage: "request",
        exception: { name: error.name, message: "Stored JSON is unreadable" },
      });
      expect(JSON.stringify(failure)).not.toContain("PRIVATE");
    }
    const remote = read({
      ...original,
      failure: {
        stage: "request",
        errorKind: "error",
        exception: {
          name: "Error",
          message: "wrapper PRIVATE_STORED_PAYLOAD",
          stack: "PRIVATE_STORED_PAYLOAD",
          cause: {
            name: "SyntaxError",
            message: "PRIVATE_STORED_PAYLOAD",
            stack: "PRIVATE_STORED_PAYLOAD",
            remote: true,
            code: "E_JSON",
          },
        },
      },
    });
    expect(remote).toMatchObject({
      exception: {
        name: "Error",
        message: "Stored JSON is unreadable",
        cause: { name: "SyntaxError", message: "Stored JSON is unreadable", remote: true, code: "E_JSON" },
      },
    });
    expect(JSON.stringify(remote)).not.toContain("PRIVATE");
  });

  it("keeps Unicode exception evidence readable within the HTTP header budget", () => {
    const error = Object.assign(new Error("storage reset — λ"), { retryable: true });
    error.stack = "界".repeat(1500);
    const cause = new Error("storage unavailable");
    cause.stack = error.stack;
    error.cause = new Error("restart", { cause });
    (error.cause as Error).stack = error.stack;
    const header = stateWriteDiagnosticHeader({
      version: 1,
      requestDigest: digest,
      failure: stateWriteException("state-rpc", error, 3),
    });
    expect(header.length).toBeLessThanOrEqual(16384);
    expect(
      stateWriteDiagnosticFromHeader(
        new Headers({ ["x-switchboard-state-failure"]: header }).get("x-switchboard-state-failure"),
        digest,
      ),
    ).toMatchObject({
      stage: "state-rpc",
      attempts: 3,
      exception: {
        message: "storage reset — λ",
        retryable: true,
        cause: { message: "restart", cause: { message: "storage unavailable" } },
      },
    });
  });

  it("retains redacted exception details and Cloudflare flags for operator diagnosis", () => {
    const cause = Object.assign(new Error("storage reset"), { code: "DO_RESET", remote: true });
    cause.stack = "Error: storage reset\n at setState (worker.ts:10:2)";
    const error = Object.assign(new Error("connection reset token=private-credential", { cause }), {
      retryable: true,
      overloaded: false,
    });
    error.stack = "Error: connection reset token=private-credential\n at rpc (worker.ts:20:4)";
    const failure = stateWriteException("state-rpc", error);
    expect(failure).toMatchObject({
      stage: "state-rpc",
      errorKind: "error",
      exception: {
        name: "Error",
        message: "connection reset token=«redacted»",
        stack: "Error: connection reset token=«redacted»\n at rpc (worker.ts:20:4)",
        retryable: true,
        overloaded: false,
        cause: { name: "Error", message: "storage reset", code: "DO_RESET", remote: true },
      },
    });
    expect(read({ ...original, failure })).toEqual(failure);
    expect(JSON.stringify(failure)).not.toContain("private-credential");
  });

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

  it("reports bounded exception categories and keeps reply bytes out of the diagnostic", () => {
    expect(stateWriteException("promotion-preflight", new SyntaxError("invalid input"))).toMatchObject({
      stage: "promotion-preflight",
      errorKind: "syntax",
      exception: { name: "SyntaxError", message: "Stored JSON is unreadable" },
    });
    expect(stateWriteException("state-rpc", "private thrown bytes")).toEqual({
      stage: "state-rpc",
      errorKind: "non-error",
      exception: { name: "ThrownValue", message: "private thrown bytes" },
    });
    expect(stateWriteReplyShape({ ok: true, secret: "private bytes" })).toBe("ok");
    expect(stateWriteReplyShape({ kind: "held", reason: "private bytes" })).toBe("held");
    expect(stateWriteReplyShape(null)).toBe("null");
    expect(stateWriteReplyShape(undefined)).toBe("undefined");
    expect(stateWriteReplyShape(["private bytes"])).toBe("array");
  });
});
