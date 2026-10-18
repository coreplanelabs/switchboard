import { captureException, type ExceptionDiagnostic } from "./exceptionDiagnostic.js";
import type { Span } from "./trace/types.js";

const REQUEST_FAILURE_TYPE = "urn:switchboard:request-failure";

/** A diagnostic reference never grants source access or recovery authority. */
export interface FailureContext {
  traceId: string;
  source: "unverified";
}

export function isFailureContext(value: unknown): value is FailureContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return (
    Object.keys(context).length === 2 &&
    Object.hasOwn(context, "traceId") &&
    Object.hasOwn(context, "source") &&
    context.source === "unverified" &&
    typeof context.traceId === "string" &&
    /^[0-9a-f]{32}$/.test(context.traceId) &&
    context.traceId !== "0".repeat(32)
  );
}

/** Read the existing adapter's normalized HTTP problem without classifying its cause. */
export function failureContextOf(
  error: { type?: string; status?: number; requestId?: string } | undefined,
): FailureContext | undefined {
  const context = { traceId: error?.requestId, source: "unverified" };
  return error?.type === REQUEST_FAILURE_TYPE && error.status === 500 && isFailureContext(context)
    ? context
    : undefined;
}

interface RequestFailureRecord {
  event: "request_failure";
  traceId: string;
  spanId: string;
  exception: ExceptionDiagnostic;
}

/** The request boundary reports once and returns a reference to its existing trace. */
export function requestFailureResponse(
  root: Span,
  error: unknown,
  report: (failure: RequestFailureRecord) => void = (failure) => console.error(JSON.stringify(failure)),
): Response {
  let exception: ExceptionDiagnostic | undefined;
  try {
    exception = captureException(error);
    report({ event: "request_failure", traceId: root.traceId, spanId: root.id, exception });
  } catch {
    // A failed reporter must not replace the failure or expose raw decoder prose.
    const diagnostic = `Request failure reporter unavailable: ${exception ? JSON.stringify(exception) : "capture unavailable"}`;
    root.fail(new Error(diagnostic));
    try {
      console.error(
        JSON.stringify({
          event: "request_failure_report_failed",
          traceId: root.traceId,
          spanId: root.id,
          captured: exception !== undefined,
        }),
      );
    } catch {
      root.fail(new Error(`Fallback unavailable. ${diagnostic}`));
    }
  }
  root.end("error", { httpStatus: 500 });
  return new Response(
    JSON.stringify({ type: REQUEST_FAILURE_TYPE, title: "Request failed", status: 500, request_id: root.traceId }),
    { status: 500, headers: { "content-type": "application/problem+json", "x-request-id": root.traceId } },
  );
}
