import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceCheckError } from "./sourceCheckError.js";
import { classificationOf, classifyError } from "../trace/classify.js";
import { rememberStorageFailure } from "../storageFailureDiagnostic.js";
import { noteStoreReadFailure, TransientStoreError } from "../storeFailure.js";

afterEach(() => vi.restoreAllMocks());

describe("source check failure reporting", () => {
  it("keeps the original cause and reports closed storage evidence once across translations", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new TransientStoreError("PRIVATE_RESPONSE_BYTES");
    rememberStorageFailure(cause, {
      version: 1,
      operation: "/runs/session/read",
      phase: "http",
      kind: "read",
      requestDigest: "a".repeat(64),
      requestId: "00000000-0000-4000-8000-000000000001",
      httpStatus: 503,
    });
    noteStoreReadFailure(cause, 3, "attempts-exhausted");
    const error = sourceCheckError("github-execution", cause);
    expect(error.cause).toBe(cause);
    expect(error.refusal).toEqual({ ok: false, code: "saved-context-unproved", check: "context_validation_exception" });
    expect(sourceCheckError("admitted-context", error)).toBe(error);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "source_check.failed",
        sourceCheckStage: "github-execution",
        sourceErrorClass: "TransientStoreError",
        storageOperation: "/runs/session/read",
        storagePhase: "http",
        requestDigest: "a".repeat(64),
        storageRequestId: "00000000-0000-4000-8000-000000000001",
        httpStatus: 503,
        sourceReadAttempts: 3,
        sourceReadStop: "attempts-exhausted",
        kind: "infra",
        code: "source_check_failed",
      },
    ]);
  });

  it("preserves an existing classification without copying arbitrary error properties", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = classifyError(
      Object.assign(new TypeError("PRIVATE_SOURCE_BYTES"), {
        name: "PRIVATE_ERROR_NAME",
        code: "PRIVATE_CODE",
        stack: "PRIVATE_STACK",
      }),
      { kind: "timeout", code: "source_read_deadline" },
    );
    const error = sourceCheckError("origins", cause);
    expect(error.cause).toBe(cause);
    expect(classificationOf(error)).toEqual({ kind: "timeout", code: "source_read_deadline" });
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "source_check.failed",
        sourceCheckStage: "origins",
        sourceErrorClass: "TypeError",
        kind: "timeout",
        code: "source_read_deadline",
      },
    ]);
    expect(JSON.stringify([error.diagnostic, log.mock.calls])).not.toContain("PRIVATE_");
  });

  it("keeps audience and Slack refusal categories separate from unexpected context failures", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(sourceCheckError("private-audience", new Error()).refusal).toEqual({
      ok: false,
      code: "direct-audience-unavailable",
    });
    expect(sourceCheckError("slack-revalidation", new Error()).refusal).toEqual({
      ok: false,
      code: "slack-source-unverified",
    });
  });

  it("records an application location without retaining the stack or exception header", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new TypeError("PRIVATE_RESPONSE_BYTES");
    cause.stack =
      "TypeError: PRIVATE_RESPONSE_BYTES\n    at decode (/app/src/core/runLedgerWorker.ts:425:17)\n    at external (/private/customer/repo.js:1:2)";
    const error = sourceCheckError("github-execution", cause);
    expect(error.cause).toBe(cause);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "source_check.failed",
        sourceCheckStage: "github-execution",
        sourceErrorClass: "TypeError",
        sourceErrorFile: "core/runLedgerWorker.ts",
        sourceErrorLine: 425,
        sourceErrorColumn: 17,
        kind: "infra",
        code: "source_check_failed",
      },
    ]);
  });

  it.each(["/app/src/core/private-name.ts:1:2", "    at privateName (/app/src/core/private-name.ts:1:2)"])(
    "excludes the full multiline error header containing %s",
    (fragment) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const cause = new TypeError(`PRIVATE_RESPONSE_BYTES\n${fragment}`);
      cause.stack = `TypeError: ${cause.message}\n    at decode (/app/src/core/runLedgerWorker.ts:425:17)`;
      const error = sourceCheckError("origins", cause);
      expect(error.diagnostic).toEqual({
        sourceCheckStage: "origins",
        sourceErrorClass: "TypeError",
        sourceErrorFile: "core/runLedgerWorker.ts",
        sourceErrorLine: 425,
        sourceErrorColumn: 17,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-name");
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_RESPONSE_BYTES");
    },
  );

  it("retains the source failure when both telemetry sinks fail", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("log unavailable");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("fallback unavailable");
    });
    const cause = new SyntaxError("PRIVATE_JSON");
    const error = sourceCheckError("mcp-sources", cause);
    expect(error).toMatchObject({
      name: "SourceCheckError",
      message: "Source verification failed",
      cause,
      diagnostic: { sourceCheckStage: "mcp-sources", sourceErrorClass: "SyntaxError" },
    });
  });
});
