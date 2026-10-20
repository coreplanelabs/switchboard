import type { AudienceCheck } from "../audienceDecision.js";
import { classificationOf, classifyError } from "../trace/classify.js";
import type { SpanAttrs } from "../trace/attrs.js";
import { originalStorageFailure } from "../storageFailureDiagnostic.js";
import { PermanentStoreError, TransientStoreError, UncertainStoreError, storeReadFailureOf } from "../storeFailure.js";

export type SourceCheckStage =
  | "owner"
  | "audience"
  | "media"
  | "destination"
  | "history"
  | "context"
  | "publication-context"
  | "admitted-context"
  | "dependencies"
  | "native-media"
  | "github-execution"
  | "unit-status"
  | "memory"
  | "github-repositories"
  | "origins"
  | "slack-sources"
  | "mcp-sources"
  | "origin-access"
  | "checkpoint-normalization"
  | "run-dependencies"
  | "memory-provenance"
  | "operator-decision"
  | "child-owner"
  | "slack-revalidation"
  | "saved-slack-sources"
  | "private-audience"
  | "organization-source"
  | "private-destination"
  | "slack-binding"
  | "slack-persistence"
  | "child-context";

/** Keep only a relative application location, never the stack header or caller paths. */
function sourceLocation(error: unknown): SpanAttrs {
  try {
    if (!(error instanceof Error) || typeof error.stack !== "string") return {};
    // V8 includes the complete message before its frames, even when it has newlines.
    // An unrecognized/custom header supplies no trustworthy frame boundary.
    const header = `${error.name}${error.message ? `: ${error.message}` : ""}\n`;
    if (!error.stack.startsWith(header)) return {};
    for (const frame of error.stack
      .slice(header.length, header.length + 4096)
      .split("\n")
      .slice(0, 8)) {
      if (!/^\s+at\s/.test(frame)) continue;
      const match =
        /\/(?:src|dist)\/((?:core|channels|execution|mcp|tools)\/[A-Za-z0-9_./-]+\.[cm]?[jt]s):([1-9][0-9]{0,6}):([1-9][0-9]{0,5})\)?$/.exec(
          frame,
        );
      if (!match || match[1].length > 64 || match[1].includes("..") || match[1].includes(".test.")) continue;
      return { sourceErrorFile: match[1], sourceErrorLine: Number(match[2]), sourceErrorColumn: Number(match[3]) };
    }
  } catch {
    // A hostile stack getter supplies no location; the cause still propagates.
  }
  return {};
}

/** The original cause stays in-process; only closed facts enter telemetry. */
export class SourceCheckError extends Error {
  override readonly name = "SourceCheckError";
  readonly diagnostic: SpanAttrs;
  readonly refusal: Extract<AudienceCheck, { ok: false }>;

  constructor(
    readonly stage: SourceCheckStage,
    cause: unknown,
  ) {
    super("Source verification failed", { cause });
    this.refusal = Object.freeze(
      stage === "private-audience" || stage === "private-destination"
        ? { ok: false, code: "direct-audience-unavailable" }
        : stage === "slack-revalidation" || stage === "saved-slack-sources"
          ? { ok: false, code: "slack-source-unverified" }
          : { ok: false, code: "saved-context-unproved", check: "context_validation_exception" },
    );
    const storage = originalStorageFailure(cause);
    const read = storeReadFailureOf(cause);
    const errorClass =
      cause instanceof UncertainStoreError
        ? "UncertainStoreError"
        : cause instanceof TransientStoreError
          ? "TransientStoreError"
          : cause instanceof PermanentStoreError
            ? "PermanentStoreError"
            : cause instanceof TypeError
              ? "TypeError"
              : cause instanceof RangeError
                ? "RangeError"
                : cause instanceof SyntaxError
                  ? "SyntaxError"
                  : cause instanceof Error
                    ? "Error"
                    : typeof cause;
    this.diagnostic = Object.freeze({
      sourceCheckStage: stage,
      sourceErrorClass: errorClass,
      ...sourceLocation(cause),
      ...(storage
        ? {
            storageOperation: storage.operation,
            storagePhase: storage.phase,
            requestDigest: storage.requestDigest,
            ...(storage.requestId ? { storageRequestId: storage.requestId } : {}),
            ...(storage.httpStatus !== undefined ? { httpStatus: storage.httpStatus } : {}),
          }
        : {}),
      ...(read ? { sourceReadAttempts: read.attempts, sourceReadStop: read.stop } : {}),
    });
    classifyError(this, classificationOf(cause) ?? { kind: "infra", code: "source_check_failed" });
  }
}

/** Translate once, including callers that deliberately retain a degraded result. */
export function sourceCheckError(stage: SourceCheckStage, cause: unknown): SourceCheckError {
  if (cause instanceof SourceCheckError) return cause;
  const error = new SourceCheckError(stage, cause);
  try {
    console.error(JSON.stringify({ event: "source_check.failed", ...error.diagnostic, ...classificationOf(error) }));
  } catch {
    try {
      console.warn(JSON.stringify({ event: "source_check.telemetry_failed", sourceCheckStage: stage }));
    } catch {
      // A failed reporter cannot replace the source error or restore source access.
    }
  }
  return error;
}
